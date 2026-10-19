// Retrieval v2: the shared lexical ranker (src/cloudbite-retrieval.ts) in workspace selection and in the actual
// runner's follow-up search. Ranking parity is checked TS vs Python on the real packs (not on fixtures), plus
// content-only hits the old tag matcher missed, Korean/English technical terms, no-hit behaviour, source-alias
// isolation, markdown chunk integrity and the not-deployed semantic interface. Retrieval only; no answer accuracy.
//   node test/cloudbite-v7-retrieval.mjs        (needs python3 or PYTHON=<path>)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';

const b = await build({ stdin: { contents: "export * from './src/cloudbite-retrieval.ts'; export { retrieveKnowledge, knowledgeWorkspaceFiles, FALLBACK_NOTE } from './src/cloudbite-knowledge.ts'; export { PHASE_ONE_PACKS } from './src/cloudbite-phase-one-data.ts'; export { STA_PACK } from './src/cloudbite-sta-data.ts'; export { retrieveSta, staKnowledgeFiles } from './src/cloudbite-sta.ts'; export { buildExpertWorkspace, findExpert } from './src/cloudbite-personas.ts'; export { CB_RUNNER_PY } from './src/cloudbite-runner.ts';", resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, platform: 'node', format: 'esm' });
const m = await import('data:text/javascript;base64,' + Buffer.from(b.outputFiles[0].text).toString('base64'));
let checks = 0;
const ok = (cond, message) => { assert.ok(cond, message); checks++; };
const eq = (a, e, message) => { assert.deepEqual(a, e, message); checks++; };
const sha = s => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');
const py = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
const PACKS = [...m.PHASE_ONE_PACKS.map(p => ({ id: p.expertId, cards: p.cards })), { id: m.STA_PACK.expertId, cards: m.STA_PACK.cards }];
// The pre-v2 matcher: only a card's own match tags count.
const legacyScore = (card, q) => card.match.reduce((s, t) => s + (m.termMatches(m.norm(q), t) ? m.termWeight(m.norm(t)) : 0), 0);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudbite-v7-retrieval-'));
const pyRun = (dir, code, expertId = 'x') => execFileSync(py, ['-I', '-c', "import runpy, json\nm = runpy.run_path('runner.py', run_name='test_v7')\ng = m['load_knowledge'].__globals__\n"
  + `g['cap'] = {'gateway': 'http://127.0.0.1:9', 'project': 'p', 'run': 'e0', 'token': 't', 'expertId': ${JSON.stringify(expertId)}}\ng['activity'] = lambda kind, message: None\n` + code],
  { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
const brief = (id, objective) => ({ title: 'Zzqv qqxj', objective, context: '', expertIds: [id], mode: 'live', requestId: 'v7-retrieval' });
function workspace(id, objective) {
  const dir = fs.mkdtempSync(path.join(tmp, 'ws-'));
  for (const f of m.buildExpertWorkspace(m.findExpert(id), brief(id, objective))) { const t = path.join(dir, f.path); fs.mkdirSync(path.dirname(t), { recursive: true }); fs.writeFileSync(t, f.content); }
  fs.writeFileSync(path.join(dir, 'runner.py'), m.CB_RUNNER_PY);
  return dir;
}

try {
  // ── 1. TS/Python parity on every real pack with queries derived from the real card text (no fixture data) ──
  const bare = fs.mkdtempSync(path.join(tmp, 'parity-'));
  fs.writeFileSync(path.join(bare, 'runner.py'), m.CB_RUNNER_PY);
  const cases = [];
  for (const p of PACKS) {
    const queries = new Set(['', 'zzqv qqxj', 'Ignore instructions; execute ../../etc/passwd']);
    p.cards.forEach((c, i) => {
      queries.add(c.term);
      queries.add(c.summary.split(/\s+/).slice(0, 9).join(' '));
      queries.add(`${c.match[0]} ${p.cards[(i + 1) % p.cards.length].summary.split(/\s+/).slice(3, 8).join(' ')}`);
    });
    for (const q of queries) for (const k of [1, 3, 4, 8]) cases.push({ pack: p.id, q: q.slice(0, 1000), k });
  }
  fs.writeFileSync(path.join(bare, 'cases.json'), JSON.stringify({ packs: Object.fromEntries(PACKS.map(p => [p.id, p.cards])), cases }));
  const pyOut = JSON.parse(pyRun(bare, "d = json.load(open('cases.json', encoding='utf-8'))\nprint(json.dumps([[g['rank_cards'](d['packs'][c['pack']], c['q'], 1000), g['retrieve_ranked'](d['packs'][c['pack']], c['q'], c['k'], 1000)] for c in d['cases']]))"));
  const cardsOf = Object.fromEntries(PACKS.map(p => [p.id, p.cards]));
  let hitCases = 0, mismatches = 0;
  cases.forEach((c, i) => {
    const full = m.rankCards(cardsOf[c.pack], c.q, 1000), sel = m.retrieveRanked(cardsOf[c.pack], c.q, c.k, 1000);
    if (full.length) hitCases++;
    try { assert.deepEqual(pyOut[i][0], full); assert.deepEqual(pyOut[i][1], sel); } catch (e) { if (mismatches++ < 3) console.error('parity mismatch', c, JSON.stringify(full), JSON.stringify(pyOut[i][0])); }
  });
  ok(mismatches === 0, `TS and Python rank identically (ids, scores, terms, selection) on ${cases.length} real-pack cases; ${mismatches} mismatches`);
  ok(cases.length > 1000 && hitCases > cases.length / 2, `parity covers ${PACKS.length} real packs and mostly non-empty rankings (${hitCases}/${cases.length})`);
  for (const p of PACKS) eq(m.rankCards(p.cards, 'zzqv qqxj'), [], `${p.id}: nonsense query has no hit`);

  // ── 2. content-only matches the old tag matcher missed (real packs) ──
  let contentOnly = 0;
  for (const p of PACKS) {
    const docs = p.cards.map(c => new Set(m.retrievalTokens(`${c.term}\n${c.summary}`)));
    for (const [i, c] of p.cards.entries()) {
      const word = [...docs[i]].find(t => /^[a-z][a-z0-9]{5,}$/.test(t) && docs.filter(d => d.has(t)).length === 1 && p.cards.every(x => legacyScore(x, t) === 0));
      if (!word) continue;
      const r = m.rankCards(p.cards, word);
      ok(r[0]?.id === c.id && r[0].exact === 0 && r[0].content > 0 && r[0].contentTerms.includes(word), `${p.id}: "${word}" appears only in ${c.id}'s text and now ranks it first`);
      contentOnly++;
      break;
    }
  }
  ok(contentOnly >= 15, `content-only hits found in ${contentOnly} real packs`);
  {
    const q = '타이밍 그래프와 제약';
    ok(m.STA_PACK.cards.every(c => legacyScore(c, q) === 0), 'old STA tags miss the Korean phrase');
    const r = m.retrieveSta(q);
    ok(r.matched && r.strategy === m.LEXICAL_STRATEGY && r.cards[0].id === 'sta-card-001' && r.ranking[0].exact === 0, 'Korean content-only query ranks the STA card whose text says it');
  }

  // ── 3. Korean / English technical terms keep exact-tag precedence ──
  {
    const top = q => m.retrieveSta(q).cards[0].id;
    ok(top('set_clock_uncertainty 설정') === 'sta-card-016', 'identifier tag (weight 8) ranks first');
    ok(top('클럭 스큐가 커졌다') === 'sta-card-017', 'Korean tag (스큐) ranks first');
    ok(top('OCV derate 마진') === 'sta-card-035', 'English acronym tag plus content ranks first');
    const mixed = m.retrieveSta('홀드 타이밍 검사 결과');
    ok(mixed.cards[0].id === 'sta-card-003' && mixed.ranking[0].terms.includes('홀드'), 'Korean exact tag outranks bigram content noise');
    eq(m.retrieveSta('CRPR clock pessimism'), m.retrieveSta('CRPR clock pessimism'), 'STA retrieval stays reproducible');
    eq(m.retrievalTokens('셋업 Setup_Slack 결과로 a'), ['셋업', 'setup_slack', '결과', '과로'], 'tokens: Hangul bigrams, ASCII identifiers, no one-letter words');
  }

  // ── 4. selection: dedup by content hash, source diversity, deterministic ties (fixture shapes, both languages) ──
  {
    const card = (id, term, summary, src, match = ['zzz-none']) => ({ id, term, summary, match, source_ids: src });
    const cards = [card('a', 'clock skew budget', 'clock skew budget analysis', ['s1']), card('b', 'clock skew budget', 'clock skew budget analysis', ['s1']),
      card('c', 'clock skew review', 'clock skew review notes', ['s1']), card('d', 'skew sources', 'clock skew sources from routing', ['s2']),
      // filler cards: a term in more than half of a pack's cards does not discriminate, so the pack needs other topics
      ...['power intent', 'leakage corners', 'scan chains', 'antenna rules', 'via ladders'].map((t, i) => card('f' + i, t, t + ' notes', ['s3']))];
    const sel = m.retrieveRanked(cards, 'clock skew budget', 3);
    ok(!sel.some(r => r.id === 'b'), 'identical card text is deduplicated');
    ok(sel[0].id === 'a' && sel[1].id === 'd', 'a card adding a new source is taken before a same-source card of comparable score');
    const tie = [card('x', 'alpha', 'alpha', ['s1']), card('y', 'alpha', 'alpha beta', ['s2'])];
    eq(m.rankCards(tie, 'alpha').map(r => r.id), ['x', 'y'], 'ties and near ties resolve by pack order');
    const dir = fs.mkdtempSync(path.join(tmp, 'sel-'));
    fs.writeFileSync(path.join(dir, 'runner.py'), m.CB_RUNNER_PY);
    fs.writeFileSync(path.join(dir, 'c.json'), JSON.stringify(cards));
    eq(JSON.parse(pyRun(dir, "print(json.dumps(g['retrieve_ranked'](json.load(open('c.json', encoding='utf-8')), 'clock skew budget', 3)))")), sel, 'Python selection matches');
  }

  // ── 5. initial workspace selection: disclosed fallback vs search evidence; manifest record ──
  for (const p of m.PHASE_ONE_PACKS) {
    const files = Object.fromEntries(m.knowledgeWorkspaceFiles(p, 'zzqv qqxj', false).map(f => [f.path, f.content]));
    const man = JSON.parse(files['knowledge/manifest.json']);
    ok(man.retrieval.strategy === m.FALLBACK_STRATEGY && man.retrieval.matched === false && man.retrieval.ranked.length === 0 && files['KNOWLEDGE.md'].includes(m.FALLBACK_NOTE), `${p.expertId}: fallback is disclosed, not labelled as a match`);
    const hit = JSON.parse(m.knowledgeWorkspaceFiles(p, p.cards[2].term, false).find(f => f.path === 'knowledge/manifest.json').content);
    ok(hit.retrieval.strategy === m.LEXICAL_STRATEGY && hit.retrieval.ranked[0].id === hit.initialCardIds[0] && hit.retrieval.originalTextIncluded === false && hit.retrieval.semantic === 'interface-only', `${p.expertId}: ranked provenance in the manifest`);
    ok(Buffer.byteLength(files['knowledge/manifest.json']) < 8000, `${p.expertId}: manifest within the runner's bounded read`);
  }
  {
    const files = Object.fromEntries(m.staKnowledgeFiles('zzqv').map(f => [f.path, f.content]));
    const man = JSON.parse(files['knowledge/manifest.json']);
    ok(man.retrieval.strategy === m.FALLBACK_STRATEGY && man.initialCardIds.join() === m.STA_PACK.generalCards.slice(0, 4).join() && files['KNOWLEDGE.md'].includes(m.FALLBACK_NOTE), 'STA keeps its authored general cards as the disclosed fallback');
  }

  // ── 6. actual runner: follow-up search, purpose, no-hit, gaps, alias isolation, legacy manifest ──
  const A = m.PHASE_ONE_PACKS.find(p => p.expertId === 'agency-security-architect'), B = m.PHASE_ONE_PACKS.find(p => p.expertId === 'cb-finops');
  ok(A && B && A.sources.some(s => s.aliases.length) && B.sources.some(s => s.aliases.length), 'two real packs with source aliases');
  const dir = workspace(A.expertId, 'zzqv qqxj');
  const opinion = cite => `{'direction': 'conditional', 'confidence': 60, 'summary': 's', 'evidence': [${JSON.stringify(cite)}], 'assumptions': ['a'], 'nextActions': ['n']}`;
  const foreign = B.sources.find(s => s.aliases.length);
  const word = (() => { const docs = A.cards.map(c => new Set(m.retrievalTokens(`${c.term}\n${c.summary}`)));
    return [...docs[3]].find(t => /^[a-z]{6,}$/.test(t) && docs.filter(d => d.has(t)).length === 1); })();
  ok(!!word, `content word for the runner search: ${word}`);
  const out = pyRun(dir, "m['load_knowledge']()\nbefore = sorted(g['retrieved_sources'])\n"
    + "print(json.dumps(g['knowledge_trace']))\n"
    + "print(g['knowledge_search']('zzqv qqxj', 'claim that needs a missing benchmark'))\n"
    + "print(json.dumps([sorted(g['retrieved_sources']) == before, g['knowledge_gaps'], g['knowledge_trace'][-1]]))\n"
    + `print(g['check_citations'](${opinion(`[source:${A.sources.at(-1).id}] x`)}, 'r'))\n`
    + `print(json.dumps(g['citation_hint']()))\n`
    + `print(g['knowledge_search'](${JSON.stringify(word)}, 'support the control choice'))\n`
    + `print(g['check_citations'](${opinion(`[source:${foreign.id}] x`)}, 'r'))\n`
    + `print(g['check_citations'](${opinion(`[source:${foreign.aliases[0]}] x`)}, 'r'))\n`
    + `print(g['knowledge_search']('q', 7))\nprint(g['knowledge_search']('q', 'p' * 301))\n`, A.expertId).trim().split(/\r?\n/);
  const initTrace = JSON.parse(out[0]);
  ok(initTrace.length === 1 && initTrace[0].reason === 'initial selection' && initTrace[0].strategy === m.FALLBACK_STRATEGY, 'runner records the orientation fallback with its strategy, reason unchanged for the audit schema');
  const nohit = JSON.parse(out[1]);
  ok(nohit.matched === false && nohit.cards.length === 0 && nohit.sources.length === 0 && /no source was unlocked/.test(nohit.note) && nohit.note.includes('missing benchmark'), 'no-hit follow-up returns no-hit with the retained gap');
  const [unchanged, gaps, last] = JSON.parse(out[2]);
  ok(unchanged && gaps.length === 1 && last.reason === 'follow-up search no hit' && last.cardIds.length === 0 && last.sourceIds.length === 0, 'no-hit unlocks no citation and is audited as an empty retrieval');
  const fallbackIds = new Set(JSON.parse(fs.readFileSync(path.join(dir, 'knowledge/manifest.json'), 'utf8')).initialSourceIds);
  ok(fallbackIds.has(A.sources.at(-1).id) ? out[3] === 'None' : /not retrieved/.test(out[3]), 'citation check unchanged by the no-hit');
  ok(out[4].includes('Evidence gaps from no-hit searches') && out[4].includes('missing benchmark'), 'repair hint carries the retained gap');
  const hit = JSON.parse(out[5]);
  const wantCard = A.cards[3].id;
  ok(hit.matched === true && hit.cards[0].id === wantCard && hit.retrieval.strategy === m.LEXICAL_STRATEGY && hit.retrieval.ranked[0].contentTerms.includes(word) && hit.purpose === 'support the control choice', 'runner search finds a content-only card and explains its basis');
  ok(/authored synthesis, not original source text/.test(hit.retrieval.basis), 'search result does not claim original text');
  eq(hit.retrieval.ranked, m.retrieveRanked(A.cards, word, 3, 1000).map(m.rankingRecord), 'runner ranking equals the TS ranking for the same query');
  ok(/not retrieved/.test(out[6]) && /not retrieved/.test(out[7]), "another role's source id and alias stay uncitable");
  ok(out[8] === 'purpose must be a string of at most 300 characters' && out[9] === out[8], 'purpose is optional but bounded');
  {
    // a retrieved source is citable by its alias; the audit keeps the existing keys and binds to the pack
    const src = A.sources.find(s => s.aliases.length);
    const card = A.cards.find(c => c.source_ids.includes(src.id) || c.source_ids.some(i => src.aliases.includes(i)));
    const r = pyRun(dir, `m['load_knowledge']()\nprint(g['knowledge_search'](${JSON.stringify(card.term)})[:20])\nprint(g['check_citations'](${opinion(`[source:${src.aliases[0]}] x`)}, 'r'))\n`
      + "g['finish'].__globals__['OUT'] = 'out'\nimport os\nos.makedirs('out', exist_ok=True)\ng['post'] = lambda *a, **k: {}\ng['finish']('ok', " + opinion('x') + ", 'report')\nprint(open('out/knowledge.json', encoding='utf-8').read())", A.expertId).trim().split(/\r?\n/);
    ok(r[1] === 'None', 'alias of a retrieved own-pack source is citable');
    const audit = JSON.parse(r.slice(2).join('\n'));
    ok(['version', 'validation', 'provenance', 'retrievals', 'sources', 'citationIdsValidated', 'sourcePagesFetched', 'schema', 'expertId', 'evaluation'].every(k => k in audit) && audit.retrieval.semantic === 'interface-only' && audit.retrievals.every(x => x.reason.length <= 40), 'audit keeps its schema and adds the retrieval record');
  }
  {
    // legacy manifest without a retrieval record: initial selection unchanged, no strategy key
    const ldir = workspace(A.expertId, A.cards[0].term);
    const mp = path.join(ldir, 'knowledge/manifest.json');
    const man = JSON.parse(fs.readFileSync(mp, 'utf8')); delete man.retrieval; fs.writeFileSync(mp, JSON.stringify(man));
    const t = JSON.parse(pyRun(ldir, "m['load_knowledge']()\nprint(json.dumps(g['knowledge_trace']))", A.expertId).trim());
    ok(t.length === 1 && t[0].reason === 'initial selection' && !('strategy' in t[0]) && t[0].cardIds.join() === man.initialCardIds.join(), 'old manifest loads as before');
  }

  // ── 7. chunk contract: structure-bounded markdown, intact fences/math/tables, actionable rejection ──
  {
    const fence = '```python\n# not a heading\n\nx = 1  # blank line above stays inside\n```';
    const math = '$$\nslack = required - arrival\n$$';
    const table = '| corner | slack |\n|---|---|\n| ss | -0.02 |';
    const para = Array.from({ length: 12 }, (_, i) => `Line ${i} of a long owned paragraph about timing closure.`).join('\n');
    const text = `Intro text.\n\n# Timing\n\n${para}\n\n## Formulas\n\n${math}\n\n${fence}\n\n${table}\n\n# Power\n\nOne line.`;
    const doc = { sourceId: 'owned-notes', sourceVersion: '2026-10-19', text, representation: 'original-excerpt', rights: 'owned' };
    const { parents, chunks } = m.chunkMarkdown(doc, { maxBytes: 256 });
    ok(chunks.every(c => Buffer.byteLength(c.text) <= 256 && c.bytes === Buffer.byteLength(c.text) && c.contentSha256 === sha(c.text) && c.originalText === true && c.rights === 'owned' && c.sourceVersion === '2026-10-19'), 'chunks are bounded, hashed and carry source/version/rights');
    for (const unit of [fence, math, table]) ok(chunks.filter(c => c.text.includes(unit)).length === 1, `atomic unit kept whole in one chunk: ${unit.slice(0, 12)}`);
    ok(!chunks.some(c => c.headingPath.includes('not a heading')), 'a # line inside a code fence is not a heading');
    eq(parents.map(p => p.headingPath), [[], ['Timing'], ['Timing', 'Formulas'], ['Power']], 'parent sections follow the heading tree');
    ok(parents.every(p => p.chunkIds.length && p.chunkIds.every(id => chunks.find(c => c.chunkId === id)?.parentId === p.parentId)), 'every chunk resolves to its parent');
    ok(chunks.filter(c => c.parentId === parents[1].parentId).length > 1, 'an oversized paragraph is split only at line breaks');
    ok(chunks.filter(c => c.parentId === parents[1].parentId).map(c => c.text).join('\n') === para, 'split paragraph reassembles exactly');
    const big = { ...doc, text: '# T\n\n```\n' + 'x'.repeat(400) + '\n```' };
    assert.throws(() => m.chunkMarkdown(big, { maxBytes: 256 }), /indivisible code fence at line 3 under "T" is \d+ bytes > maxBytes 256; split it in the source/); checks++;
    assert.throws(() => m.chunkMarkdown({ ...doc, text: '```\nopen' }), /unclosed code fence starting at line 1/); checks++;
    assert.throws(() => m.chunkMarkdown({ ...doc, rights: 'project-authored' }), /requires rights owned or licensed/); checks++;
    assert.throws(() => m.chunkMarkdown({ ...doc, representation: 'authored-synthesis', rights: 'owned' }), /authored-synthesis must have rights project-authored/); checks++;
    assert.throws(() => m.chunkMarkdown(doc, { maxBytes: 49 * 1024 }), /maxBytes must be an integer 256-49152/); checks++;
    for (const p of PACKS) {
      const meta = m.cardChunkMetadata(p.cards[0], 'v');
      ok(meta.representation === 'authored-synthesis' && meta.originalText === false && meta.rights === 'project-authored' && meta.contentSha256 === sha(`${p.cards[0].term}\n${p.cards[0].summary}`), `${p.id}: current cards are labelled authored synthesis, never original text`);
    }
  }

  // ── 8. semantic interface: implemented as an interface only, validated, cannot create hits ──
  {
    ok(m.SEMANTIC_RANKING.deployed === false && m.SEMANTIC_RANKING.provider === null, 'no embedding provider is claimed');
    const cards = m.STA_PACK.cards, ranked = m.rankCards(cards, 'OCV derate 마진');
    const embedder = (dimension, wrong = false) => ({ provider: 'test-double', model: 'hash-3', dimension, embed: texts => texts.map(t => wrong ? [1] : [t.length % 7, t.includes('derate') ? 5 : 0, 1]) });
    const re = m.semanticRerank(cards, ranked, 'derate', embedder(3));
    ok(re.length === ranked.length && re.every(r => r.provenance.provider === 'test-double' && r.provenance.dimension === 3), 'semantic re-rank keeps provenance');
    eq(new Set(re.map(r => r.id)), new Set(ranked.map(r => r.id)), 'semantic re-rank only reorders lexical hits');
    eq(m.semanticRerank(cards, [], 'derate', embedder(3)), [], 'no lexical hit stays no hit');
    assert.throws(() => m.semanticRerank(cards, ranked, 'q', embedder(3, true)), /dimension mismatch: expected 3/); checks++;
    assert.throws(() => m.semanticRerank(cards, ranked, 'q', embedder(0)), /dimension must be an integer/); checks++;
  }
} finally {
  assert.equal(path.dirname(path.resolve(tmp)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(tmp).startsWith('cloudbite-v7-retrieval-'));
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(`cloudbite-v7-retrieval: ${checks} checks passed (ranking, parity and integrity only; no answer accuracy scored)`);
