// Focused tests for tools/cloudbite-rag-eval.mjs. The corpus, queries and runs built here are test-synthetic: tiny
// fabricated texts with real hashes, never a licensed source, a model output or a retrieval quality result. Every
// expected metric below is computed by hand in the comment next to it.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as Q from '../tools/evaluate-cloudbite-quality.mjs';
import * as B from '../tools/cloudbite-quality-batch.mjs';
import * as R from '../tools/cloudbite-rag-eval.mjs';

const ROOT = Q.ROOT;
const RUN_DIR = join(ROOT, '.artifacts', 'rag-eval-test', `${Date.now()}-${randomBytes(4).toString('hex')}`);
mkdirSync(RUN_DIR, { recursive: true });
const sha = (s) => createHash('sha256').update(s).digest('hex');
const NOW = new Date('2026-10-19T00:00:00Z');
const quiet = () => {};
let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log('ok', name); };

// ---------- synthetic corpus ----------
const SRC = [
  ['src-a', ['r-eda'], '# Hold\n\nHold checks after ECO.\n\n## Corners\n\nCorner selection text.'],
  ['src-b', ['r-eda'], '# Constraints\n\nGenerated clock constraint text.'],
  ['src-c', ['r-fal'], '# Bias\n\nPublication bias text.'],
];
const CH = [['a1', 'src-a', ['Hold'], 'Hold checks after ECO.'], ['a2', 'src-a', ['Hold', 'Corners'], 'Corner selection text.'],
  ['b1', 'src-b', ['Constraints'], 'Generated clock constraint text.'], ['c1', 'src-c', ['Bias'], 'Publication bias text.']];
const vec = (seed) => Array.from({ length: 256 }, (_, i) => ((i * 7 + seed * 13) % 17 - 8) / 8);
function makeIndex(mutate = (x) => x) {
  const sources = SRC.map(([id, roles, text]) => ({ id, title: `Synthetic ${id}`, url: `https://example.org/${id}`, license: 'CC-BY-4.0', licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
    attribution: 'test-synthetic', version: '1', retrievedAt: '2026-10-19', sha256: sha(text), roles, text }));
  const chunks = CH.map(([id, sourceId, headingPath, text], i) => ({ id, sourceId, parentId: `${sourceId}-p`, headingPath, text, sha256: sha(text), vector: vec(i + 1) }));
  const ix = mutate({ schema: 'cloudbite.corpus/v1', model: 'text-embedding-3-small', dimensions: 256, sha256: '', sources, chunks });
  ix.sha256 = sha(Q.canonical({ chunks: ix.chunks.map(({ headingPath, id, parentId, sha256: h, sourceId, text, vector }) => ({ headingPath, id, parentId, sha256: h, sourceId, text, vector })),
    dimensions: ix.dimensions, model: ix.model, schema: ix.schema, sources: ix.sources.map(({ id, title, url, license, licenseUrl, attribution, version, retrievedAt, sha256: h, roles, text }) => ({ id, title, url, license, licenseUrl, attribution, version, retrievedAt, sha256: h, roles, text })) }));
  return ix;
}
const INDEX_RAW = makeIndex(), INDEX = R.verifyIndex(INDEX_RAW);
const meta = (id) => { const { roles: _r, text: _t, ...m } = INDEX_RAW.sources.find((s) => s.id === id); return m; };
const hit = (chunkId, score = 0.5) => { const c = INDEX_RAW.chunks.find((x) => x.id === chunkId); return { chunkId, sourceId: c.sourceId, parentId: c.parentId, headingPath: c.headingPath, text: c.text, sha256: c.sha256, score }; };
const result = (chunkIds, { strategy = 'hybrid-rrf/v1', degraded = null, indexSha256 = INDEX.sha256 } = {}) => {
  const hits = chunkIds.map((id) => hit(id));
  return { schema: 'cloudbite.corpus-search/v1', indexSha256, strategy, model: strategy === 'hybrid-rrf/v1' ? 'text-embedding-3-small' : null, matched: hits.length > 0, degraded,
    sources: [...new Set(hits.map((h) => h.sourceId))].map(meta), hits };
};

// ---------- synthetic queries ----------
const annotated = (ids) => ({ status: 'annotated', annotatedBy: 'test-annotator', annotatedAt: '2026-10-19T00:00:00Z', basis: 'test-synthetic label' });
const QROWS = [
  { caseId: 'q1', expertId: 'r-eda', query: 'hold after eco across corners', relevantSourceIds: ['src-a', 'src-b'], relevance: annotated() },
  { caseId: 'q2', expertId: 'r-eda', query: 'generated clock constraints', relevantSourceIds: ['src-b'], relevance: annotated() },
  { caseId: 'q3', expertId: 'r-fal', query: 'abstract only claim support', relevantSourceIds: [], relevance: { status: 'pending' } },
  { caseId: 'q4', expertId: 'r-fal', query: 'publication bias pooled estimate', relevantSourceIds: ['src-c'], relevance: annotated() },
];
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
const QUERIES = R.parseQueries(jsonl(QROWS));
const QSET = R.querySetHash([...QUERIES.values()]);
const entry = (caseId, res) => { const q = QUERIES.get(caseId); return { caseId, expertId: q.expertId, queryHash: R.queryHash(q), result: res }; };
const runOf = (runId, results, extra = {}) => ({ version: R.RUN_VERSION, runId, provenance: 'test-synthetic', querySetSha256: QSET, ...extra, results });
const roundtrip = (run) => R.parseRun(Buffer.from(JSON.stringify(run)));

// Candidate: q1 a1(src-a) c1(src-c, foreign to r-eda) b1(src-b); q2 a1 a2 b1; q3 c1 (pending); q4 no hit, degraded.
const CANDIDATE = runOf('cand', [entry('q1', result(['a1', 'c1', 'b1'])), entry('q2', result(['a1', 'a2', 'b1'])), entry('q3', result(['c1'])),
  entry('q4', result([], { strategy: 'corpus-lexical/v1', degraded: 'missing-key' }))], { retrievalConfig: { rrfK: 60, maxHits: 3 }, identities: { promptSetHash: 'a'.repeat(64), instructionSetHash: 'b'.repeat(64) } });
// Baseline: q1 b1 only; q2 missing; q3 c1; q4 c1.
const BASELINE = runOf('base', [entry('q1', result(['b1'], { strategy: 'corpus-lexical/v1', degraded: 'missing-key' })), entry('q3', result(['c1'])), entry('q4', result(['c1']))]);

await test('mirrors the corpus contract (schema, model, dimensions, search schema, strategies)', () => {
  const src = readFileSync(join(ROOT, 'src/cloudbite-corpus-contract.ts'), 'utf8');
  assert.match(src, new RegExp(`CORPUS_SCHEMA = '${R.CORPUS.schema}'`));
  assert.match(src, new RegExp(`CORPUS_MODEL = '${R.CORPUS.model}'`));
  assert.match(src, new RegExp(`CORPUS_DIMENSIONS = ${R.CORPUS.dimensions};`));
  assert.ok(src.includes(`schema: '${R.CORPUS.searchSchema}'`));
  assert.ok(src.includes(R.CORPUS.strategies.map((s) => `'${s}'`).join(' | ')));
});

await test('index verification re-derives source, chunk and canonical index hashes and refuses tampering', () => {
  assert.equal(INDEX.identity.indexSha256, INDEX_RAW.sha256);
  assert.equal(INDEX.identity.sources, 3); assert.equal(INDEX.identity.chunks, 4);
  const tamper = (f) => { const x = structuredClone(INDEX_RAW); f(x); return () => R.verifyIndex(x); };
  assert.throws(tamper((x) => { x.chunks[0].sha256 = '0'.repeat(64); }), /chunks\[0\]\.sha256 does not match/);
  assert.throws(tamper((x) => { x.chunks[0].text = 'Hold checks after ECO'; }), /chunks\[0\]\.sha256 does not match/);
  assert.throws(tamper((x) => { x.sources[2].roles = ['r-eda']; }), /canonical index/);
  assert.throws(tamper((x) => { x.chunks[1].vector[3] = 0.123; }), /canonical index/);
  assert.throws(tamper((x) => { x.chunks[0].vector[0] = Number.NaN; }), /finite numbers/);
  assert.throws(tamper((x) => { x.model = 'other'; }), /schema\/model\/dimensions/);
  assert.throws(() => R.verifyIndex(makeIndex((x) => { x.chunks[0].text = 'Not in the source.'; x.chunks[0].sha256 = sha('Not in the source.'); return x; })), /not an excerpt/);
});

await test('hand-computed recall@3, MRR, leakage, no-hit and degraded counts', () => {
  const r = R.evaluateRun(roundtrip(CANDIDATE), QUERIES, INDEX, { runSha256: 'c'.repeat(64) });
  assert.equal(r.status, 'EVALUATED');
  const by = Object.fromEntries(r.queries.map((x) => [x.caseId, x]));
  // q1: credited ranks 1 (src-a) and 3 (src-b); c1 at rank 2 is foreign → recall 2/2 = 1, RR 1/1.
  assert.equal(by.q1.recallAt3, 1); assert.equal(by.q1.reciprocalRank, 1); assert.equal(by.q1.roleLeakHits, 1);
  assert.deepEqual(by.q1.hits.map((h) => h.roleLeak ?? false), [false, true, false]);
  // q2: src-b first at rank 3 → recall 1/1, RR 1/3.
  assert.equal(by.q2.recallAt3, 1); assert.equal(by.q2.reciprocalRank, 0.333333);
  // q3: pending relevance → null, never 0.
  assert.equal(by.q3.recallAt3, null); assert.equal(by.q3.reciprocalRank, null); assert.equal(by.q3.relevance, 'pending');
  // q4: no hit → recall 0, RR 0 (annotated, so a real miss).
  assert.equal(by.q4.recallAt3, 0); assert.equal(by.q4.reciprocalRank, 0); assert.equal(by.q4.noHit, true);
  // means over annotated q1, q2, q4: recall (1+1+0)/3, MRR (1+1/3+0)/3.
  assert.equal(r.metrics.meanRecallAt3, 0.666667); assert.equal(r.metrics.mrr, 0.444444);
  assert.deepEqual([r.metrics.annotated, r.metrics.pendingRelevance, r.metrics.noHit, r.metrics.degraded], [3, 1, 1, 1]);
  assert.deepEqual(r.metrics.degradedReasons, { 'missing-key': 1 });
  assert.equal(r.metrics.roleLeakHits, 1); assert.equal(r.metrics.queriesWithRoleLeak, 1); assert.equal(r.metrics.invalidCitationHits, 0);
  assert.equal(r.identity.retrievalConfigSha256, sha(Q.canonical({ rrfK: 60, maxHits: 3 })));
  assert.equal(r.identity.prior.promptSetHash, 'a'.repeat(64)); assert.equal(r.identity.prior.knowledgeRevisionHash, null);
});

await test('a foreign-role source alone earns nothing even when it is the only hit', () => {
  const run = runOf('leak', [entry('q2', result(['c1']))]);
  const r = R.evaluateRun(roundtrip(run), QUERIES, INDEX);
  const q2 = r.queries.find((x) => x.caseId === 'q2');
  assert.equal(q2.recallAt3, 0); assert.equal(q2.reciprocalRank, 0); assert.equal(q2.roleLeakHits, 1);
  assert.deepEqual(r.metrics.missingResults, ['q1', 'q3', 'q4']);
});

await test('tampered chunk hash/text, unknown chunks and false source metadata are invalid and never credited', () => {
  const res = result(['b1', 'a1', 'a2']);
  res.hits[0].sha256 = '1'.repeat(64);                       // hash claimed for b1 does not match the index
  const r1 = R.scoreResult(QUERIES.get('q2'), entry('q2', res), INDEX);
  assert.deepEqual(r1.hits[0].problems, ['chunk-hash-mismatch', 'chunk-text-mismatch']);
  assert.equal(r1.recallAt3, 0); assert.equal(r1.reciprocalRank, 0); assert.equal(r1.invalidCitationHits, 1);
  const res2 = result(['b1']); res2.hits[0].text = 'Generated clock constraint text!'; res2.hits[0].sha256 = sha(res2.hits[0].text);
  assert.deepEqual(R.scoreResult(QUERIES.get('q2'), entry('q2', res2), INDEX).hits[0].problems, ['chunk-hash-mismatch', 'chunk-text-mismatch']);
  const res3 = result(['b1']); res3.hits[0].chunkId = 'zz9';
  assert.deepEqual(R.scoreResult(QUERIES.get('q2'), entry('q2', res3), INDEX).hits[0].problems, ['unknown-chunk']);
  const res4 = result(['b1']); res4.sources[0].license = 'MIT';  // listed source metadata differs from the index
  const r4 = R.scoreResult(QUERIES.get('q2'), entry('q2', res4), INDEX);
  assert.deepEqual(r4.invalidSourceRecords, [{ sourceId: 'src-b', problem: 'source-metadata-mismatch' }]);
  assert.deepEqual(r4.hits[0].problems, ['source-not-listed']); assert.equal(r4.recallAt3, 0);
  const res5 = result(['b1']); res5.hits[0].sourceId = 'src-a'; res5.sources = [meta('src-a')];
  assert.deepEqual(R.scoreResult(QUERIES.get('q1'), entry('q1', res5), INDEX).hits[0].problems, ['source-mismatch']);
});

await test('empty relevance annotations give null metrics, not zero and not success', () => {
  const pending = R.parseQueries(jsonl(QROWS.map((q) => ({ ...q, relevantSourceIds: [], relevance: { status: 'pending' } }))));
  const run = runOf('pending', [...pending.values()].map((q) => ({ caseId: q.caseId, expertId: q.expertId, queryHash: R.queryHash(q), result: result(q.expertId === 'r-eda' ? ['a1'] : ['c1']) })), { querySetSha256: R.querySetHash([...pending.values()]) });
  const r = R.evaluateRun(roundtrip(run), pending, INDEX);
  assert.equal(r.metrics.meanRecallAt3, null); assert.equal(r.metrics.mrr, null); assert.equal(r.metrics.annotated, 0);
  assert.match(r.metrics.metricNote, /null is not zero and not success/);
  assert.ok(r.queries.every((x) => x.recallAt3 === null && x.reciprocalRank === null));
  const rep = R.buildReport({ queries: pending, queriesOrigin: {}, index: INDEX, indexOrigin: { kind: 'json', path: 'x' }, candidate: r, baseline: null, pair: R.comparePair(null, r), now: NOW });
  assert.equal(rep.adviceQuality.status, 'PENDING_HUMAN_REVIEW'); assert.equal(rep.winner, null); assert.equal(rep.relevance.truth, false);
});

await test('false provenance: wrong query set, query text, role or corpus refuses the whole run', () => {
  const refused = (run, re) => { const r = R.evaluateRun(roundtrip(run), QUERIES, INDEX); assert.equal(r.status, 'REFUSED'); assert.equal(r.metrics, null); assert.ok(r.problems.some((p) => re.test(p)), r.problems.join('; ')); };
  refused({ ...CANDIDATE, querySetSha256: 'f'.repeat(64) }, /different query set/);
  refused(runOf('x', [{ ...entry('q1', result(['a1'])), queryHash: R.queryHash({ caseId: 'q1', expertId: 'r-eda', query: 'edited query' }) }]), /queryHash does not match/);
  refused(runOf('x', [{ ...entry('q1', result(['a1'])), expertId: 'r-fal' }]), /role r-fal differs/);
  refused(runOf('x', [entry('q1', result(['a1'], { indexSha256: 'e'.repeat(64) }))]), /indexSha256 differs/);
  refused(runOf('x', [{ caseId: 'q9', expertId: 'r-eda', queryHash: 'd'.repeat(64), result: result([]) }]), /unknown case q9/);
});

await test('paired comparison: same set/roles/corpus only, missing baselines disclosed, no winner', () => {
  const cand = R.evaluateRun(roundtrip(CANDIDATE), QUERIES, INDEX, { runSha256: '1'.repeat(64) });
  const base = R.evaluateRun(roundtrip(BASELINE), QUERIES, INDEX, { runSha256: '2'.repeat(64) });
  const p = R.comparePair(base, cand);
  assert.equal(p.status, 'COMPARED'); assert.equal(p.winner, undefined);
  assert.deepEqual(p.missingBaselines, ['q2']);
  // paired annotated: q1 (base recall 1/2, RR 1; cand 1, 1) and q4 (base 1, 1; cand 0, 0).
  assert.equal(p.pairedAnnotated, 2);
  assert.deepEqual(p.retrieval.meanRecallAt3, { baseline: 0.75, candidate: 0.5 });
  assert.deepEqual(p.retrieval.mrr, { baseline: 1, candidate: 0.5 });
  assert.equal(p.perQuery.find((x) => x.caseId === 'q1').recallAt3.delta, 0.5);
  assert.equal(p.perQuery.find((x) => x.caseId === 'q3').status, 'NOT_SCORED');
  assert.equal(p.variables.promptSetHash.same, null);
  assert.equal(R.comparePair(null, cand).status, 'BASELINE_MISSING');
  // Different corpus identity.
  const other = R.verifyIndex(makeIndex((x) => { x.sources[0].version = '2'; return x; }));
  const reb = (run, ix) => R.evaluateRun(roundtrip(JSON.parse(JSON.stringify(run).replaceAll(INDEX.sha256, ix.sha256).replaceAll('"version":"1"', '"version":"2"'))), QUERIES, ix);
  const baseOther = reb(BASELINE, other);
  assert.equal(baseOther.status, 'EVALUATED');
  assert.deepEqual(R.comparePair(baseOther, cand).problems, ['different corpus index identity']);
  // Different query set (one query reworded) and a different role for one case.
  const qrows2 = QROWS.map((q) => q.caseId === 'q2' ? { ...q, query: 'clock constraint gaps' } : q), q2set = R.parseQueries(jsonl(qrows2));
  const base2 = R.evaluateRun(roundtrip(runOf('b2', [{ caseId: 'q1', expertId: 'r-eda', queryHash: R.queryHash(q2set.get('q1')), result: result(['a1']) }], { querySetSha256: R.querySetHash([...q2set.values()]) })), q2set, INDEX);
  assert.ok(R.comparePair(base2, cand).problems.includes('different query sets'));
  const qrows3 = QROWS.map((q) => q.caseId === 'q2' ? { ...q, expertId: 'r-fal', relevantSourceIds: [], relevance: { status: 'pending' } } : q), q3set = R.parseQueries(jsonl(qrows3));
  const base3 = R.evaluateRun(roundtrip(runOf('b3', [], { querySetSha256: R.querySetHash([...q3set.values()]) })), q3set, INDEX);
  assert.equal(R.comparePair(base3, cand).status, 'REFUSED');
  assert.ok(R.comparePair({ ...cand }, cand).problems.includes('baseline and candidate are the same file'));
  assert.ok(R.comparePair(R.evaluateRun(roundtrip({ ...BASELINE, querySetSha256: '0'.repeat(64) }), QUERIES, INDEX), cand).problems.includes('baseline run was refused'));
});

await test('malformed and overlarge inputs are refused', () => {
  const bad = (rows, re) => assert.throws(() => R.parseQueries(typeof rows === 'string' ? rows : jsonl(rows)), re);
  bad('{not json\n', /not JSON/);
  bad([{ ...QROWS[0], relevance: { status: 'pending' } }], /pending relevance must not list/);
  bad([{ ...QROWS[0], relevantSourceIds: [] }], /annotated relevance needs at least one/);
  bad([{ ...QROWS[0], relevance: { status: 'annotated', annotatedBy: 'x', basis: 'y' } }], /annotatedAt/);
  bad([QROWS[2]].map((q) => { const { relevance: _r, ...rest } = q; return rest; }), /relevance must state/);
  bad([{ ...QROWS[2], query: 'x'.repeat(1001) }], /1-1000 characters/);
  bad([QROWS[2], QROWS[2]], /duplicate caseId/);
  bad([{ ...QROWS[2], answer: 'leaked expected answer' }], /unknown key answer/);
  bad([{ ...QROWS[2], caseId: '../x' }], /safe id/);
  bad(Array.from({ length: 201 }, (_, i) => ({ ...QROWS[2], caseId: `c${i}` })), /1-200 lines/);
  const run = (mut, re) => { const r = structuredClone(CANDIDATE); mut(r); assert.throws(() => R.parseRun(Buffer.from(JSON.stringify(r))), re); };
  assert.throws(() => R.parseRun(Buffer.from('nope')), /not JSON/);
  assert.throws(() => R.parseRun(Buffer.alloc(R.RAG_LIMITS.runBytes + 1, 0x20)), /exceeds/);
  run((r) => { r.extra = 1; }, /unknown key extra/);
  run((r) => { delete r.provenance; }, /provenance must be declared/);
  run((r) => { r.results[0].result.hits = Array.from({ length: 11 }, () => hit('a1')); }, /up to 10 hits/);
  run((r) => { r.results[0].result.hits[0].score = 'high'; }, /wrongly typed/);
  run((r) => { r.results[0].result.strategy = 'lexical-exact-bm25/v1'; }, /strategy must be one of/);
  run((r) => { r.results[0].result.vectors = []; }, /must have exactly/);
  run((r) => { r.results.push(r.results[0]); }, /repeats case q1/);
  run((r) => { r.identities = { promptSetHash: 'short' }; }, /identities\.promptSetHash/);
  run((r) => { r.collection = { note: 'sk-' + 'A'.repeat(30) }; }, /credential-like/);
});

await test('stable output: identical inputs give identical bytes; generatedAt is outside the content hash', () => {
  const build = (now) => R.buildReport({ queries: QUERIES, queriesOrigin: { path: 'q.jsonl' }, index: INDEX, indexOrigin: { kind: 'json', path: 'i.json' },
    candidate: R.evaluateRun(roundtrip(CANDIDATE), QUERIES, INDEX), baseline: R.evaluateRun(roundtrip(BASELINE), QUERIES, INDEX),
    pair: R.comparePair(R.evaluateRun(roundtrip(BASELINE), QUERIES, INDEX), R.evaluateRun(roundtrip(CANDIDATE), QUERIES, INDEX)), now });
  const a = build(NOW), b = build(NOW), c = build(new Date('2027-01-01T00:00:00Z'));
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.equal(R.toMarkdown(a), R.toMarkdown(b));
  assert.equal(a.contentSha256, c.contentSha256);
  assert.equal(a.identity.corpus.indexSha256, INDEX.sha256);
  // No chunk or query text leaks into the report by default.
  const text = JSON.stringify(a) + R.toMarkdown(a);
  for (const t of [...CH.map((x) => x[3]), ...QROWS.map((q) => q.query)]) assert.ok(!text.includes(t), `report contains text: ${t}`);
});

await test('annotations must name corpus sources eligible for the query role', () => {
  const qs = R.parseQueries(jsonl([{ ...QROWS[0], relevantSourceIds: ['src-a', 'src-c', 'src-x'] }]));
  assert.deepEqual(R.checkAnnotations(qs, INDEX), ['q1: relevant source src-c is not eligible for role r-eda', 'q1: relevant source src-x is not in the corpus']);
});

await test('CLI evaluate writes only to an ignored folder, never overwrites, and refuses remote or credential arguments', async () => {
  const w = (name, data) => { const p = join(RUN_DIR, name); writeFileSync(p, data); return p; };
  const qp = w('q.jsonl', jsonl(QROWS)), ip = w('index.json', JSON.stringify(INDEX_RAW)), cp = w('cand.json', JSON.stringify(CANDIDATE)), bp = w('base.json', JSON.stringify(BASELINE));
  const out = join(RUN_DIR, 'out'), args = ['evaluate', '--queries', qp, '--index', ip, '--run', cp, '--baseline', bp, '--out', out];
  const r = await R.runCli(args, { log: quiet, now: NOW });
  assert.equal(r.exitCode, 0); assert.equal(r.report.comparison.status, 'COMPARED');
  assert.deepEqual(readdirSync(out).sort(), ['cand__vs__base.json', 'cand__vs__base.md']);
  assert.equal(r.report.identity.corpus.origin.kind, 'json');
  await assert.rejects(R.runCli(args, { log: quiet, now: NOW }), /refusing to overwrite/);
  assert.equal((await R.runCli([...args, '--force'], { log: quiet, now: NOW })).exitCode, 0);
  const refusedRun = w('refused.json', JSON.stringify({ ...CANDIDATE, runId: 'refused', querySetSha256: '0'.repeat(64) }));
  assert.equal((await R.runCli(['evaluate', '--queries', qp, '--index', ip, '--run', refusedRun, '--out', out], { log: quiet, now: NOW })).exitCode, 3);
  await assert.rejects(R.runCli(['evaluate', '--queries', qp, '--index', 'https://example.org/i.json', '--run', cp, '--out', out]), /no URL/);
  await assert.rejects(R.runCli(['evaluate', '--queries', qp, '--index', ip, '--run', cp, '--out', join(ROOT, 'docs')]), /tracked or unignored/);
  await assert.rejects(R.runCli(['evaluate', '--token=abc', '--run', cp]), /credentials are never accepted/);
  await assert.rejects(R.runCli(['evaluate', '--queries', qp, '--index', ip, '--run', 'sk-' + 'B'.repeat(30)]), /looks like a credential/);
  await assert.rejects(R.runCli(['evaluate', '--queries', qp, '--index-module', join(RUN_DIR, 'x.ts'), '--run', cp]), /unexpected file type|not found|under src/);
  writeFileSync(join(RUN_DIR, 'x.ts'), 'export const CORPUS = {};\n');
  await assert.rejects(R.runCli(['evaluate', '--queries', qp, '--index-module', join(RUN_DIR, 'x.ts'), '--run', cp]), /under src\//);
  const badIx = w('bad-index.json', JSON.stringify({ ...INDEX_RAW, sha256: '0'.repeat(64) }));
  await assert.rejects(R.runCli(['evaluate', '--queries', qp, '--index', badIx, '--run', cp, '--out', out]), /canonical index/);
});

await test('generated corpus module loads through esbuild when present', async () => {
  // The bundling path itself, on a repository module that exists in every checkout.
  const contract = await R.loadIndexModule(join(ROOT, 'src/cloudbite-corpus-contract.ts'), 'CORPUS_DIMENSIONS');
  assert.equal(contract.index, 256); assert.equal(contract.origin.path, 'src/cloudbite-corpus-contract.ts');
  await assert.rejects(R.loadIndexModule(join(ROOT, 'src/cloudbite-corpus-contract.ts')), /no export CORPUS/);
  assert.throws(() => R.verifyIndex(contract.index), /invalid corpus index/);
  const gen = join(ROOT, 'src/cloudbite-corpus.generated.ts');
  if (!existsSync(gen)) { console.log('  skip: src/cloudbite-corpus.generated.ts not generated in this checkout'); return; }
  const { index, origin } = await R.loadIndexModule(gen);
  const v = R.verifyIndex(index);
  assert.equal(origin.kind, 'ts-module'); assert.match(v.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(R.checkAnnotations(R.parseQueries(readFileSync(R.DEFAULT_QUERIES, 'utf8')), v), []);
});

await test('authored held-out query fixtures: 8-12 cases across both domains, relevance explicitly pending', () => {
  const qs = [...R.parseQueries(readFileSync(R.DEFAULT_QUERIES, 'utf8')).values()];
  assert.ok(qs.length >= 8 && qs.length <= 12);
  assert.ok(qs.every((q) => q.heldOut === true && q.provenance === 'authored-held-out' && q.authoring?.humanReviewed === false));
  const suites = new Set(qs.map((q) => q.suite));
  for (const s of ['eda-timing-closure', 'eda-mmmc', 'eda-timing-constraints', 'falsify-abstract-fulltext', 'falsify-claim-support', 'falsify-statistical-bias']) assert.ok(suites.has(s), s);
  const roles = new Set(['probably-primetime-sta', 'cb-role-072', 'cb-role-075', 'cb-role-076', 'cb-role-101', 'cb-role-105', 'cb-role-106', 'cb-role-118']);
  assert.ok(qs.every((q) => roles.has(q.expertId)));
  // No annotation exists yet: every case is pending with an empty list (to be filled by a human after source review).
  assert.ok(qs.every((q) => q.relevance.status === 'pending' && q.relevantSourceIds.length === 0));
  // The advice cases stay separate and unchanged.
  assert.deepEqual([...Q.loadCases(R.ADVICE_CASES).keys()], ['v7-eda-closure', 'v7-falsify-evidence']);
});

await test('templates: the advice manifest is a valid quality-batch manifest; the run skeleton binds the query set', () => {
  const qs = R.parseQueries(readFileSync(R.DEFAULT_QUERIES, 'utf8'));
  const t = R.templates(qs);
  const m = B.parseManifest(Buffer.from(JSON.stringify(t.manifest)), Q.loadCases(R.ADVICE_CASES));
  assert.equal(m.entries.length, 2);
  assert.ok(m.entries.every((e) => e.baseline && e.provenance === 'observed-live' && /pending human review/.test(e.collection.note)));
  assert.equal(t.run.querySetSha256, R.querySetHash([...qs.values()]));
  assert.ok(t.run.results.every((x) => x.result === null && x.queryHash === R.queryHash(qs.get(x.caseId))));
  assert.throws(() => R.parseRun(Buffer.from(JSON.stringify(t.run))), /result must have exactly/); // an unfilled skeleton is not a run
});

await test('CLI template writes the manifest and run skeleton into an ignored folder', async () => {
  const out = join(RUN_DIR, 'template');
  const r = await R.runCli(['template', '--out', out], { log: quiet, now: NOW });
  assert.equal(r.exitCode, 0);
  assert.deepEqual(readdirSync(out).sort(), ['quality-batch-manifest.json', 'retrieval-run.template.json']);
  assert.equal(JSON.parse(readFileSync(join(out, 'quality-batch-manifest.json'), 'utf8')).version, B.BATCH_VERSION);
});

console.log(`cloudbite-v8-rag-eval: ${n} tests passed`);
