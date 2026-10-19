// Licensed-corpus hybrid search (src/cloudbite-corpus-search.ts) with deterministic fake embeddings: semantic paraphrase
// hits, role-eligible sources only, no-hit, truthful lexical fallback on a missing key or any upstream failure, strict
// upstream response checks, index tamper and non-finite data, no key/query/upstream-body leakage, per-source caps.
//   node test/cloudbite-v8-search.mjs
//   CLOUDBITE_CORPUS_LIVE=1 node test/cloudbite-v8-search.mjs   (one real embedding call with OPENAI_API_KEY)
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const b = await build({ stdin: { contents: "export * from './src/cloudbite-corpus-search.ts'; export * from './src/cloudbite-corpus-contract.ts'; export { sha256Hex } from './src/cloudbite-knowledge.ts';", resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, platform: 'node', format: 'esm' });
const m = await import('data:text/javascript;base64,' + Buffer.from(b.outputFiles[0].text).toString('base64'));
let checks = 0;
const ok = (cond, message) => { assert.ok(cond, message); checks++; };
const eq = (a, e, message) => { assert.deepEqual(a, e, message); checks++; };
const rejects = async (p, cls, message) => { await assert.rejects(p, cls, message); checks++; };

// ── deterministic fake embedder: words map onto shared concept axes, so paraphrases share direction without sharing words ──
const CONCEPTS = [
  ['car', 'cars', 'automobile', 'automobiles', 'vehicle', 'vehicles'],
  ['engine', 'motor', 'powertrain'],
  ['maintenance', 'servicing', 'upkeep', 'repair'],
  ['timing', 'clock', 'latency'],
  ['setup', 'hold', 'violation', 'violations', 'slack'],
  ['protein', 'enzyme', 'peptide'],
  ['tax', 'levy', 'duty'],
  ['bread', 'baking', 'dough', 'loaf'],
];
const DIM = 256;
function fakeEmbed(text) {
  const v = new Array(DIM).fill(0);
  for (const w of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    const c = CONCEPTS.findIndex(ws => ws.includes(w));
    if (c >= 0) v[c * 8] += 1;
    else { let h = 0; for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) >>> 0; v[64 + (h % 192)] += 0.15; }
  }
  const n = Math.hypot(...v) || 1;
  return v.map(x => x / n);
}
const sourceText = {
  autos: 'Owner guide.\nRegular car servicing keeps the motor reliable. Change the oil every season.\nTyre pressure matters for vehicles too.\nInspect brakes at every visit.\nCars need annual inspection.',
  sta: 'Static timing analysis.\nA setup violation means data arrives after the capturing clock edge.\nHold slack must stay non-negative after routing.',
  bio: 'Enzyme kinetics.\nA protein catalyst lowers activation energy; peptide chains fold into active sites.',
  bakery: 'Baking basics.\nDough must rest before shaping a loaf.',
};
const CHUNK_TEXT = {
  autos: ['Regular car servicing keeps the motor reliable.', 'Change the oil every season.', 'Tyre pressure matters for vehicles too.', 'Inspect brakes at every visit.', 'Cars need annual inspection.'],
  sta: ['A setup violation means data arrives after the capturing clock edge.', 'Hold slack must stay non-negative after routing.'],
  bio: ['A protein catalyst lowers activation energy; peptide chains fold into active sites.'],
  bakery: ['Dough must rest before shaping a loaf.'],
};
const ROLES = { autos: ['cb-mechanic'], sta: ['cb-sta', 'cb-mechanic-x'], bio: ['cb-biologist'], bakery: ['cb-mechanic', 'cb-baker'] };
async function makeIndex(edit = () => {}) {
  const sources = Object.keys(sourceText).map(id => ({
    id, title: `Title ${id}`, url: `https://example.org/${id}`, license: 'CC-BY-4.0', licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
    attribution: `Example authors (${id})`, version: '2026-01', retrievedAt: '2026-10-01', sha256: m.sha256Hex(sourceText[id]), roles: [...ROLES[id]], text: sourceText[id],
  }));
  const chunks = [];
  for (const id of Object.keys(CHUNK_TEXT)) CHUNK_TEXT[id].forEach((text, i) => chunks.push({ id: `${id}-${i}`, sourceId: id, parentId: `${id}-p`, headingPath: [`Title ${id}`], text, sha256: m.sha256Hex(text), vector: fakeEmbed(text) }));
  const ix = { schema: m.CORPUS_SCHEMA, model: m.CORPUS_MODEL, dimensions: m.CORPUS_DIMENSIONS, sha256: '', sources, chunks };
  edit(ix);
  ix.sha256 = await m.corpusIndexSha256(ix);
  return ix;
}
const KEY = 'sk-test-SECRETKEY-0123456789';
const okBody = (text, extra = {}) => ({ object: 'list', data: [{ object: 'embedding', index: 0, embedding: fakeEmbed(text) }], model: 'text-embedding-3-small', usage: { prompt_tokens: 3, total_tokens: 3 }, ...extra });
function fakeFetch(respond) {
  const calls = [];
  const f = async (url, init) => { calls.push({ url, init, body: JSON.parse(init.body) }); return respond(JSON.parse(init.body), init); };
  f.calls = calls;
  return f;
}
const embedder = () => fakeFetch(body => new Response(JSON.stringify(okBody(body.input)), { status: 200, headers: { 'content-type': 'application/json' } }));
const noFetch = () => fakeFetch(() => { throw new Error('must not be called'); });

const index = m.freezeCorpusIndex(await makeIndex());

// ── validation and caching ──
{
  const v = await m.validateCorpusIndex(index);
  eq([v.sources, v.chunks, v.sha256], [4, 9, index.sha256], 'frozen index validates with its canonical hash');
  ok((await m.validateCorpusIndex(index)).cached, 'a deeply frozen index is cached by identity');
  const mutable = await makeIndex();
  ok(!(await m.validateCorpusIndex(mutable)).cached && !(await m.validateCorpusIndex(mutable)).cached, 'a mutable index is re-validated every time');
  mutable.chunks[0].text = 'Regular car servicing keeps the motor reliable!';
  await rejects(m.searchCorpus(mutable, 'cb-mechanic', 'car servicing', undefined, noFetch()), m.CorpusIndexError, 'mutation after validation is caught on the next search');
  const partly = await makeIndex();
  Object.freeze(partly); Object.freeze(partly.chunks);
  ok(!(await m.validateCorpusIndex(partly)).cached && !(await m.validateCorpusIndex(partly)).cached, 'a shallowly frozen index is not cached');
  ok(m.CORPUS_SEARCH_PARAMS.timeoutMs <= 10000 && m.CORPUS_SEARCH_PARAMS.rrfK === 60 && m.CORPUS_SEARCH_PARAMS.maxHits === 3 && m.CORPUS_SEARCH_PARAMS.perSource === 2, 'fixed search parameters');
}

// ── semantic paraphrase: no shared words, found only by the embedding ──
{
  const q = 'automobile upkeep';
  const lex = await m.searchCorpus(index, 'cb-mechanic', q, undefined, noFetch());
  eq([lex.strategy, lex.model, lex.matched, lex.degraded, lex.hits, lex.sources], ['corpus-lexical/v1', null, false, 'missing-key', [], []], 'lexical alone misses the paraphrase and says why');
  const f = embedder();
  const r = await m.searchCorpus(index, 'cb-mechanic', q, KEY, f);
  eq([r.strategy, r.model, r.matched, r.degraded], ['hybrid-rrf/v1', 'text-embedding-3-small', true, null], 'hybrid finds the paraphrase');
  ok(r.hits[0].chunkId === 'autos-0', 'best semantic chunk first');
  eq(f.calls.length, 1, 'exactly one embedding request (no retry)');
  const c = f.calls[0];
  eq([c.url, c.init.method, c.init.headers.authorization, c.init.headers['content-type']], ['https://api.openai.com/v1/embeddings', 'POST', `Bearer ${KEY}`, 'application/json'], 'fixed endpoint and headers');
  eq(c.body, { model: 'text-embedding-3-small', input: q, dimensions: 256, encoding_format: 'float' }, 'request carries only the bounded query');
  ok(c.init.signal instanceof AbortSignal, 'request has a timeout signal');
  for (const h of r.hits) {
    ok(CHUNK_TEXT[h.sourceId].includes(h.text) && h.sha256 === m.sha256Hex(h.text) && !('vector' in h), 'hit is the exact chunk text, no vector');
    ok(Number.isFinite(h.score) && h.score > 0 && h.score < 1, 'score is a fusion rank score');
  }
  for (const s of r.sources) ok(!('text' in s) && !('roles' in s) && s.license && s.url.startsWith('https://'), 'source metadata only');
  eq(r.indexSha256, index.sha256, 'index hash reported');
  const again = await m.searchCorpus(index, 'cb-mechanic', q, KEY, embedder());
  eq(again, r, 'deterministic');
}

// ── eligibility before ranking, no all-role fallback ──
{
  const f = embedder();
  const r = await m.searchCorpus(index, 'cb-mechanic', 'setup violation clock timing', KEY, f);
  ok(r.hits.every(h => h.sourceId === 'autos' || h.sourceId === 'bakery'), 'an ineligible source never appears even when it is the best match');
  ok(!r.matched || r.hits.every(h => h.sourceId !== 'sta'), 'no hit from another role');
  for (const expert of ['cb-nobody', 'cb-mechanic-', '', 42, null]) {
    const nf = noFetch();
    const n = await m.searchCorpus(index, expert, 'car servicing', KEY, nf);
    eq([n.matched, n.degraded, n.hits, n.sources, nf.calls.length], [false, 'no-eligible-sources', [], [], 0], `no eligible sources → nothing, no request (${String(expert)})`);
  }
  const sta = await m.searchCorpus(index, 'cb-sta', 'setup violation', undefined, noFetch());
  ok(sta.matched && sta.hits.every(h => h.sourceId === 'sta'), 'role sees its own source');
  const baker = await m.searchCorpus(index, 'cb-baker', 'car servicing', KEY, embedder());
  eq([baker.matched, baker.hits], [false, []], 'semantic below the floor unlocks nothing (baker vs cars)');
}

// ── no-hit, no-term and invalid queries ──
{
  const f = embedder();
  const r = await m.searchCorpus(index, 'cb-biologist', 'quarterly tax levy filing', KEY, f);
  eq([r.strategy, r.matched, r.hits, r.sources, r.degraded], ['hybrid-rrf/v1', false, [], [], null], 'off-topic query: hybrid no-hit');
  const nf = noFetch();
  const s = await m.searchCorpus(index, 'cb-mechanic', 'the and of ? !', KEY, nf);
  eq([s.degraded, s.matched, nf.calls.length], ['no-query-terms', false, 0], 'query without content terms: no request');
  for (const q of ['', '   ', 'x'.repeat(1001), null, 7]) await rejects(m.searchCorpus(index, 'cb-mechanic', q, KEY, noFetch()), RangeError, 'query must be 1-1000 characters');
  const long = await m.searchCorpus(index, 'cb-mechanic', ('car ' + 'x'.repeat(995)).slice(0, 1000), KEY, embedder());
  ok(long.strategy === 'hybrid-rrf/v1', '1000 characters accepted');
}

// ── truthful lexical fallback on missing key and upstream trouble ──
{
  const q = 'servicing for car';
  const cases = [
    ['missing-key', undefined, noFetch()],
    ['missing-key', '', noFetch()],
    ['invalid-key', 'sk bad\nkey', noFetch()],
    ['upstream-unavailable', KEY, fakeFetch(() => { throw new TypeError(`connect failed ${KEY}`); })],
    ['upstream-unavailable', KEY, fakeFetch(() => { throw new DOMException('The operation timed out.', 'TimeoutError'); })],
    ['upstream-rejected', KEY, fakeFetch(() => new Response(JSON.stringify({ error: { message: `Incorrect API key provided: ${KEY} for ${q}` } }), { status: 401 }))],
    ['upstream-rejected', KEY, fakeFetch(() => new Response('overloaded', { status: 529 }))],
  ];
  for (const [why, key, f] of cases) {
    const r = await m.searchCorpus(index, 'cb-mechanic', q, key, f);
    eq([r.strategy, r.model, r.degraded], ['corpus-lexical/v1', null, why], `fallback is labelled ${why}`);
    ok(r.matched && r.hits[0].chunkId === 'autos-0' && r.hits.every(h => h.sourceId === 'autos' || h.sourceId === 'bakery'), `lexical fallback still searches eligible chunks (${why})`);
    const out = JSON.stringify(r);
    ok(!out.includes('SECRETKEY') && !out.includes('Incorrect') && !out.includes('overloaded') && !out.includes('connect failed') && !out.includes(q), 'no key, query or upstream body in the result');
  }
}

// ── strict upstream response checks ──
{
  const bad = {
    'wrong model': body => okBody(body.input, { model: 'text-embedding-3-large' }),
    'versioned model': body => okBody(body.input, { model: 'text-embedding-3-small-2026' }),
    'two items': body => ({ ...okBody(body.input), data: [okBody(body.input).data[0], { ...okBody(body.input).data[0], index: 1 }] }),
    'no items': () => ({ object: 'list', data: [], model: 'text-embedding-3-small' }),
    'wrong index': body => ({ ...okBody(body.input), data: [{ ...okBody(body.input).data[0], index: 1 }] }),
    'not a list': body => ({ ...okBody(body.input), object: 'embedding' }),
    'short vector': body => ({ ...okBody(body.input), data: [{ object: 'embedding', index: 0, embedding: fakeEmbed(body.input).slice(0, 255) }] }),
    'long vector': body => ({ ...okBody(body.input), data: [{ object: 'embedding', index: 0, embedding: [...fakeEmbed(body.input), 0] }] }),
    'null component': body => ({ ...okBody(body.input), data: [{ object: 'embedding', index: 0, embedding: fakeEmbed(body.input).map((x, i) => i === 3 ? null : x) }] }),
    'string component': body => ({ ...okBody(body.input), data: [{ object: 'embedding', index: 0, embedding: fakeEmbed(body.input).map((x, i) => i === 3 ? '0.1' : x) }] }),
    'zero vector': () => ({ object: 'list', model: 'text-embedding-3-small', data: [{ object: 'embedding', index: 0, embedding: new Array(256).fill(0) }] }),
    'base64 string': () => ({ object: 'list', model: 'text-embedding-3-small', data: [{ object: 'embedding', index: 0, embedding: 'AAAA' }] }),
  };
  for (const [name, make] of Object.entries(bad)) {
    const r = await m.searchCorpus(index, 'cb-mechanic', 'car servicing', KEY, fakeFetch(body => new Response(JSON.stringify(make(body)), { status: 200 })));
    eq([r.strategy, r.degraded], ['corpus-lexical/v1', 'upstream-invalid'], `rejects ${name}`);
  }
  const overflow = fakeFetch(body => new Response(JSON.stringify(okBody(body.input, { pad: 'x'.repeat(70 * 1024) })), { status: 200 }));
  eq((await m.searchCorpus(index, 'cb-mechanic', 'car servicing', KEY, overflow)).degraded, 'upstream-invalid', 'response over 64 KiB rejected');
  const declared = fakeFetch(() => new Response('{}', { status: 200, headers: { 'content-length': String(1 << 20) } }));
  eq((await m.searchCorpus(index, 'cb-mechanic', 'car servicing', KEY, declared)).degraded, 'upstream-invalid', 'declared oversize rejected');
  eq((await m.searchCorpus(index, 'cb-mechanic', 'car servicing', KEY, fakeFetch(() => new Response('{"object":"li', { status: 200 })))).degraded, 'upstream-invalid', 'invalid JSON rejected');
  eq((await m.searchCorpus(index, 'cb-mechanic', 'car servicing', KEY, fakeFetch(() => ({ ok: true, json: async () => ({}) })))).degraded, 'upstream-invalid', 'non-Response rejected');
  const nan = fakeFetch(body => new Response(JSON.stringify(okBody(body.input)).replace(/(\[)(-?[0-9.e-]+)/, '$1NaN'), { status: 200 }));
  eq((await m.searchCorpus(index, 'cb-mechanic', 'car servicing', KEY, nan)).degraded, 'upstream-invalid', 'NaN literal rejected');
  const huge = fakeFetch(body => new Response(JSON.stringify(okBody(body.input)).replace(/(\[)(-?[0-9.e-]+)/, '$11e400'), { status: 200 }));
  eq((await m.searchCorpus(index, 'cb-mechanic', 'car servicing', KEY, huge)).degraded, 'upstream-invalid', 'non-finite component rejected');
}

// ── index tamper and non-finite data ──
{
  const tampers = {
    'chunk text changed': ix => { ix.chunks[0].text = 'Regular car servicing keeps the motor reliable!'; },
    'chunk hash changed': ix => { ix.chunks[0].sha256 = '0'.repeat(64); },
    'source text changed': ix => { ix.sources[0].text += ' more'; },
    'chunk not an excerpt': ix => { ix.chunks[0].text = 'Invented text.'; ix.chunks[0].sha256 = m.sha256Hex('Invented text.'); },
    'Infinity in vector': ix => { ix.chunks[1].vector[5] = Infinity; },
    'NaN in vector': ix => { ix.chunks[1].vector[5] = NaN; },
    'string in vector': ix => { ix.chunks[1].vector[5] = '0.1'; },
    'zero vector': ix => { ix.chunks[1].vector = new Array(256).fill(0); },
    'short vector': ix => { ix.chunks[1].vector = ix.chunks[1].vector.slice(1); },
    'typed vector': ix => { ix.chunks[1].vector = Float32Array.from(ix.chunks[1].vector); },
    'duplicate chunk id': ix => { ix.chunks[1].id = ix.chunks[0].id; },
    'duplicate source id': ix => { ix.sources[1].id = ix.sources[0].id; },
    'unsafe chunk id': ix => { ix.chunks[0].id = '../x'; },
    'unknown source': ix => { ix.chunks[0].sourceId = 'nope'; },
    'unsafe role': ix => { ix.sources[0].roles = ['cb mechanic']; },
    'duplicate role': ix => { ix.sources[0].roles = ['cb-mechanic', 'cb-mechanic']; },
    'no roles': ix => { ix.sources[0].roles = []; },
    'http url': ix => { ix.sources[0].url = 'http://example.org/a'; },
    'credential url': ix => { ix.sources[0].licenseUrl = 'https://u:p@example.org/'; },
    'extra field': ix => { ix.chunks[0].note = 'project document'; },
    'missing field': ix => { delete ix.sources[0].attribution; },
    'wrong model': ix => { ix.model = 'text-embedding-3-large'; },
    'wrong dimensions': ix => { ix.dimensions = 512; },
    'wrong schema': ix => { ix.schema = 'cloudbite.corpus/v0'; },
    'bad date': ix => { ix.sources[0].retrievedAt = 'yesterday'; },
    'oversize chunk': ix => { const t = 'a'.repeat(4097); ix.sources[0].text += t; ix.sources[0].sha256 = m.sha256Hex(ix.sources[0].text); ix.chunks[0].text = t; ix.chunks[0].sha256 = m.sha256Hex(t); },
  };
  for (const [name, edit] of Object.entries(tampers)) {
    // rehashed: the edit is checked on its own merits, not only by the index hash
    let err;
    try { await m.searchCorpus(await makeIndex(edit), 'cb-mechanic', 'car servicing', KEY, noFetch()); } catch (e) { err = e; }
    ok(err instanceof m.CorpusIndexError, `rejects ${name}`);
    ok(!err.message.includes('servicing') && !err.message.includes('SECRETKEY'), 'index error names field and rule only');
  }
  const stale = await makeIndex();
  stale.sources[2].title = 'Retitled';
  await rejects(m.validateCorpusIndex(stale), m.CorpusIndexError, 'any edit without rehash breaks the index hash');
  const noHash = await makeIndex();
  noHash.sha256 = 'abc';
  await rejects(m.validateCorpusIndex(noHash), m.CorpusIndexError, 'malformed index hash');
  const hashA = await m.corpusIndexSha256({ ...(await makeIndex()), sha256: 'f'.repeat(64) });
  eq(hashA, index.sha256, 'index hash excludes its own sha256 field');
}

// ── no source dominates ──
{
  const r = await m.searchCorpus(index, 'cb-mechanic', 'car vehicles cars inspection servicing brakes oil tyre', KEY, embedder());
  ok(r.hits.length <= 3, 'at most three hits');
  const per = {};
  for (const h of r.hits) per[h.sourceId] = (per[h.sourceId] ?? 0) + 1;
  ok(Object.values(per).every(n => n <= 2), 'at most two chunks per source');
  ok(r.hits.length === 2 || per.bakery, 'a third hit comes from another source or not at all');
  const dup = m.freezeCorpusIndex(await makeIndex(ix => {
    const t = 'Cars need annual inspection.';
    ix.sources[3].text += '\n' + t; ix.sources[3].sha256 = m.sha256Hex(ix.sources[3].text);
    ix.chunks.push({ id: 'bakery-dup', sourceId: 'bakery', parentId: 'bakery-p', headingPath: ['Title bakery'], text: t, sha256: m.sha256Hex(t), vector: fakeEmbed(t) });
  }));
  const d = await m.searchCorpus(dup, 'cb-mechanic', 'annual inspection cars', KEY, embedder());
  ok(new Set(d.hits.map(h => h.sha256)).size === d.hits.length, 'identical chunk text is returned once');
}

// ── optional live probe: one real query; the fake embedder cannot produce this provider response ──
const live = { requested: process.env.CLOUDBITE_CORPUS_LIVE === '1', performed: false };
if (live.requested && process.env.OPENAI_API_KEY) {
  let status = null, host = null;
  const real = async (url, init) => { const r = await fetch(url, init); status = r.status; host = new URL(r.url || url).host; return r; };
  const r = await m.searchCorpus(index, 'cb-mechanic', 'automobile upkeep', process.env.OPENAI_API_KEY, real);
  Object.assign(live, { performed: true, host, status, strategy: r.strategy, model: r.model, degraded: r.degraded });
  ok(host === 'api.openai.com', 'live call reached the real provider');
  ok(r.strategy === 'hybrid-rrf/v1' && r.model === 'text-embedding-3-small' && r.degraded === null, 'live response passed strict validation');
}
console.log(JSON.stringify({ ok: true, checks, live }));
