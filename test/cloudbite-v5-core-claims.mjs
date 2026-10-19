// Cloudbite v5 core-claim cross-review: targeting, schema, bounds and prompt rules for claimFindings on peer
// summaries, assumptions and nextActions. No network and no model: replies are hand-written JSON fed to the real parser.
// These fixtures check targeting and prompt wiring only; an exact-quote check cannot catch a semantically false verdict,
// and nothing here measures model accuracy.
//   node test/cloudbite-v5-core-claims.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const tmp = mkdtempSync(join(tmpdir(), 'cloudbite-core-claims-'));
const entry = `export * from './src/cloudbite-core-claims.ts'; export * from './src/cloudbite-cross-review.ts'; export * from './src/cloudbite-claim-support.ts'; export * from './src/cloudbite-evidence-packet.ts';`;
const bundle = await build({ stdin: { contents: entry, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, format: 'esm', platform: 'node' });
writeFileSync(join(tmp, 'm.mjs'), bundle.outputFiles[0].text);
const M = await import(pathToFileURL(join(tmp, 'm.mjs')));
globalThis.fetch = async () => { throw new Error('network forbidden'); };

let count = 0;
const check = async (name, f) => { await f(); count++; console.log('ok', name); };
const utf8 = (s) => Buffer.byteLength(s, 'utf8');
const dataOf = (m) => JSON.parse(m[1].content.replace(/^Untrusted review data \(JSON\):\n/, ''));

// Actual fixture shapes: the Falsify abstract-only recommendation and the EDA late-hold-after-ECO reading.
const FALSIFY_SUMMARY = 'Start with full-text ingestion, because an abstract cannot be split into sentence-level claim units for checking.';
const EDA_SUMMARY = 'The late hold violation appeared right after the ECO, which proves the problem is process-related, not corner-related.';
const falsify = { expertId: 'falsify-architect', name: 'Falsify architect', opinion: { direction: 'conditional', confidence: 62, summary: FALSIFY_SUMMARY,
  evidence: ['Six-week build window [source:PROJECT.md]', 'No accuracy measured yet [source:PROJECT.md]'],
  assumptions: ['Abstracts are always under 300 words.', 'The team can parse PDFs reliably.'],
  nextActions: ['Prototype the full-text PDF parser first.', 'Measure claim recall on 50 preprints.'] } };
const eda = { expertId: 'sta-signoff', name: 'STA signoff', opinion: { direction: 'concern', confidence: 70, summary: EDA_SUMMARY,
  evidence: ['Hold slack went negative after ECO 3 [doc:doc-1]'],
  assumptions: ['Corner set did not change between runs.'],
  nextActions: ['Re-run the ECO flow on the previous corner set.'] } };
const reviewer = { expertId: 'evidence-reviewer', name: 'Evidence reviewer', opinion: { direction: 'conditional', confidence: 50, summary: 'Own summary that must never be a target.', evidence: ['x'], assumptions: ['own assumption'], nextActions: ['own action'] } };
const peers = [falsify, eda];
const brief = (patch = {}) => ({ title: 'Falsify v1 ingestion scope', objective: 'Choose abstract-only or full-text ingestion for v1.', context: 'No accuracy has been measured.',
  expertIds: [falsify.expertId, eda.expertId, reviewer.expertId], mode: 'live', requestId: 'core-claims-0001',
  documents: [{ id: 'doc-1', name: 'sta-notes.md', content: 'Hold slack went negative on the ss corner after ECO 3. The corner list was regenerated the same day.' }], ...patch });
const B0 = brief();

const claim = (patch = {}, target = {}) => ({ targetExpertId: falsify.expertId, target: { kind: 'summary', index: 0, quote: 'an abstract cannot be split into sentence-level claim units', ...target },
  verdict: 'challenged', issue: 'unsupported-premise', rationale: 'The brief does not state that abstracts cannot be segmented; this premise is unchecked.', ...patch });
const ev = (patch = {}) => ({ targetExpertId: eda.expertId, evidenceIndex: 0, verdict: 'insufficient', rationale: 'The note is a summary; raw timing reports are not attached.', ...patch });
const reply = (findings, claimFindings, summary = 'Reviewed peer claims against the supplied brief.') =>
  JSON.stringify(claimFindings === undefined ? { summary, findings } : { summary, findings, claimFindings });
const parse = (r, extra = {}) => M.parseReviewReply(r, reviewer, peers, extra);

await check('context: summaries first, then assumptions/nextActions by depth; never the reviewer; exact prefixes', () => {
  const ctx = M.buildCoreClaimContext(reviewer, [reviewer, ...peers]);
  assert.equal(ctx.schema, M.CORE_CLAIM_SCHEMA);
  assert.ok(ctx.targets.every((t) => t.targetExpertId !== reviewer.expertId), 'self excluded even if passed as a peer');
  assert.deepEqual(ctx.targets.map((t) => [t.targetExpertId, t.kind, t.index]), [
    [falsify.expertId, 'summary', 0], [eda.expertId, 'summary', 0],
    [falsify.expertId, 'assumption', 0], [falsify.expertId, 'nextAction', 0], [eda.expertId, 'assumption', 0], [eda.expertId, 'nextAction', 0],
    [falsify.expertId, 'assumption', 1], [falsify.expertId, 'nextAction', 1]]);
  assert.equal(ctx.targets[0].text, FALSIFY_SUMMARY); assert.equal(ctx.targets[0].truncated, false);
  assert.deepEqual(ctx.omitted, []);
  assert.deepEqual(M.buildCoreClaimContext(reviewer, peers), M.buildCoreClaimContext(reviewer, peers), 'deterministic');
});

await check('context bounds: per-peer target limit, prefix truncation and total byte bound are disclosed', () => {
  const many = { expertId: 'many', name: 'Many', opinion: { ...falsify.opinion, summary: 'S'.repeat(2000),
    assumptions: Array.from({ length: 7 }, (_, i) => `가정 ${i} ` + '가'.repeat(400)), nextActions: Array.from({ length: 6 }, (_, i) => `action ${i}`) } };
  const ctx = M.buildCoreClaimContext(reviewer, [many]);
  const s = ctx.targets.find((t) => t.kind === 'summary');
  assert.equal(s.text.length, M.CORE_CLAIM_LIMITS.summaryChars); assert.ok(s.truncated); assert.equal(s.totalChars, 2000);
  assert.ok(ctx.targets.filter((t) => t.kind === 'assumption').every((t) => t.text.length <= M.CORE_CLAIM_LIMITS.itemChars && t.truncated));
  assert.equal(ctx.targets.filter((t) => t.kind === 'nextAction').length, M.CORE_CLAIM_LIMITS.nextActionsPerPeer);
  assert.deepEqual(ctx.omitted.filter((o) => o.reason === 'target-limit').map((o) => `${o.kind}:${o.index}`).sort(), ['assumption:4', 'assumption:5', 'assumption:6', 'nextAction:4', 'nextAction:5']);
  assert.match(ctx.disclosure, /5 not shown/); assert.match(ctx.disclosure, /prefix/);
  // byte bound with three heavy peers
  const heavy = (id) => ({ expertId: id, name: id, opinion: { ...falsify.opinion, summary: '요'.repeat(600), assumptions: Array(4).fill('가'.repeat(300)), nextActions: Array(4).fill('나'.repeat(300)) } });
  const big = M.buildCoreClaimContext(reviewer, [heavy('h1'), heavy('h2'), heavy('h3')]);
  assert.ok(utf8(JSON.stringify(big.targets)) <= M.CORE_CLAIM_LIMITS.contextBytes);
  assert.ok(big.omitted.some((o) => o.reason === 'byte-budget'));
  assert.equal(big.targets.filter((t) => t.kind === 'summary').length, 3, 'summaries come first and survive the byte bound');
  // a surrogate pair is never split by a prefix
  const emoji = M.buildCoreClaimContext(reviewer, [{ expertId: 'e', name: 'e', opinion: { ...falsify.opinion, summary: 'x'.repeat(599) + '😀tail' } }]);
  assert.equal(emoji.targets[0].text, 'x'.repeat(599));
});

await check('prompt (DO call shape): coreClaims data, schema with claimFindings, and the causal/premise/insufficient rules', () => {
  const support = M.buildClaimSupportContext(B0, peers, []);
  const m = M.reviewMessages(reviewer, peers, B0, undefined, [], undefined, support);
  const d = dataOf(m), sys = m[0].content;
  assert.deepEqual(d.coreClaims.targets, M.buildCoreClaimContext(reviewer, peers).targets, 'prompt targets equal the parser-side default context');
  assert.ok(d.claimSupport, 'evidence claim support still supplied');
  assert.match(sys, /"claimFindings": \[claimFinding\]/);
  assert.match(sys, /Use 0-6 findings and 0-3 claimFindings, at least 1 and at most 6 in total/);
  assert.match(sys, /temporal sequence alone/i); assert.match(sys, /causal-overreach/);
  assert.match(sys, /late hold violation that appears after an ECO does not by itself prove the cause is process-related rather than corner-related/);
  assert.match(sys, /abstracts cannot be split into sentence-level claim units is a premise to check/);
  assert.match(sys, /facts the user observed or stated/); assert.match(sys, /interpretation/); assert.match(sys, /causal hypotheses/);
  assert.match(sys, /Missing or unavailable evidence is insufficient, not a contradiction/);
  assert.match(sys, /no browsing and cannot independently prove anything/);
  assert.match(sys, /coreClaims\.omitted lists targets you were not shown/);
  assert.match(sys, /For EVERY finding add claimSupport/, 'evidence claim-support rules kept');
  assert.ok(!sys.includes(FALSIFY_SUMMARY) && !sys.includes(EDA_SUMMARY), 'peer text only in user data');
  // explicit null keeps the evidence-only prompt
  const off = M.reviewMessages(reviewer, peers, B0, undefined, undefined, undefined, undefined, null);
  assert.ok(!('coreClaims' in dataOf(off)) && !/claimFindings/.test(off[0].content) && /Use 1-6 findings\./.test(off[0].content));
  // Korean brief: response-language rule unchanged; quotes stay verbatim
  assert.match(M.reviewMessages(reviewer, peers, brief({ objective: '초록만으로 시작할지 정한다.', responseLanguage: 'ko' }))[0].content, /Response language: ko/);
});

await check('parse: exact summary quote accepted; zero evidence findings allowed beside a claimFinding; old shape unchanged', () => {
  const r = parse(reply([], [claim()]));
  assert.ok(!('invalid' in r), r.invalid);
  assert.deepEqual(r.findings, []);
  assert.deepEqual(r.claimFindings, [claim()]);
  assert.deepEqual(Object.keys(r.claimFindings[0]).sort(), ['issue', 'rationale', 'target', 'targetExpertId', 'verdict']);
  const edaClaim = claim({ targetExpertId: eda.expertId, issue: 'causal-overreach', rationale: 'A sequence after the ECO alone does not separate process from corner causes; the corner list was also regenerated.' },
    { quote: 'which proves the problem is process-related, not corner-related' });
  const both = parse(reply([ev()], [edaClaim, claim({ verdict: 'insufficient', issue: 'missing-assumption' }, { kind: 'nextAction', index: 0, quote: 'full-text PDF parser' })]));
  assert.ok(!('invalid' in both), both.invalid); assert.equal(both.findings.length, 1); assert.equal(both.claimFindings.length, 2);
  // Historical/evidence-only replies keep the exact old report shape (no claimFindings key).
  const legacy = parse(reply([ev()]));
  assert.deepEqual(Object.keys(legacy).sort(), ['findings', 'reviewerExpertId', 'summary']);
  assert.deepEqual(Object.keys(parse(reply([ev()], []))).sort(), ['findings', 'reviewerExpertId', 'summary']);
  // A stored historical report without claimFindings stays a valid CrossReviewReport for consumers.
  assert.equal(legacy.claimFindings, undefined);
});

await check('parse rejects fabricated, paraphrased, stale, out-of-range, omitted, self and foreign targets', () => {
  const bad = (cf, re) => { const r = parse(reply([], [cf])); assert.ok('invalid' in r, JSON.stringify(cf)); assert.match(r.invalid, re); };
  bad(claim({}, { quote: 'abstracts can never be used' }), /not exact text/);
  bad(claim({}, { quote: 'an abstract can not be split' }), /not exact text/, 'paraphrase');
  bad(claim({}, { quote: 'AN ABSTRACT CANNOT' }), /not exact text/, 'case changed');
  bad(claim({}, { quote: 'Measure claim recall' }), /not exact text/, 'quote from a different field of the same expert');
  bad(claim({}, { quote: '   ' }), /quote is missing/);
  bad(claim({}, { quote: 'x'.repeat(301) }), /quote is missing or too long/);
  bad(claim({}, { index: 1 }), /index 0/);
  bad(claim({}, { kind: 'assumption', index: 2, quote: 'Abstracts' }), /does not exist/);
  bad(claim({}, { kind: 'assumption', index: -1, quote: 'Abstracts' }), /does not exist/);
  bad(claim({}, { kind: 'assumption', index: 0.5, quote: 'Abstracts' }), /does not exist/);
  bad(claim({}, { kind: 'evidence', quote: 'Six-week' }), /kind/);
  bad(claim({ targetExpertId: reviewer.expertId }, { quote: 'Own summary' }), /reviewer itself/);
  bad(claim({ targetExpertId: 'not-a-peer' }), /not supplied/);
  bad(claim({ verdict: 'contradicted' }), /verdict/);
  bad(claim({ issue: 'wrong' }), /issue/);
  bad(claim({ rationale: 'r'.repeat(501) }), /rationale/);
  bad({ ...claim(), extra: 1 }, /schema/);
  bad({ ...claim(), target: { ...claim().target, passageId: 'p1' } }, /schema/);
  // stale: the context was built before the peer's opinion changed
  const ctx = M.buildCoreClaimContext(reviewer, peers);
  const changed = [{ ...falsify, opinion: { ...falsify.opinion, summary: 'Start with full-text ingestion.' } }, eda];
  const stale = M.parseReviewReply(reply([], [claim({}, { quote: 'Start with full-text' })]), reviewer, changed, { coreClaimContext: ctx });
  assert.match(stale.invalid, /changed since the review prompt/);
  // omitted target: not shown, so not reviewable
  const many = { expertId: 'many', name: 'Many', opinion: { ...falsify.opinion, assumptions: ['a0', 'a1', 'a2', 'a3', 'hidden fifth assumption'] } };
  const om = M.parseReviewReply(reply([], [claim({ targetExpertId: 'many' }, { kind: 'assumption', index: 4, quote: 'hidden fifth' })]), reviewer, [many]);
  assert.match(om.invalid, /not shown to the reviewer/);
  // a quote beyond the shown prefix of a truncated target is rejected even though it is in the stored field
  const longP = { expertId: 'long', name: 'Long', opinion: { ...falsify.opinion, summary: 'a'.repeat(600) + 'TAIL beyond the prefix' } };
  assert.match(M.parseReviewReply(reply([], [claim({ targetExpertId: 'long' }, { quote: 'TAIL beyond' })]), reviewer, [longP]).invalid, /not exact text/);
});

await check('parse bounds: max 3 claimFindings, total 1..6, duplicates, total output bytes, unknown top-level keys', () => {
  const cf = (i) => claim({}, { kind: 'assumption', index: i % 2, quote: i % 2 ? 'parse PDFs' : 'Abstracts are' });
  assert.match(parse(reply([], [claim(), cf(0), cf(1), claim({ targetExpertId: eda.expertId }, { quote: 'late hold' })])).invalid, /at most 3 claimFindings/);
  assert.match(parse(reply([], [])).invalid, /1-6 findings in total/);
  assert.match(parse(reply([], undefined)).invalid, /1-6 findings in total/);
  assert.match(parse(reply([ev(), ev(), ev(), ev()], [claim(), cf(0), cf(1)])).invalid, /1-6 findings in total/, '4 + 3 > 6');
  assert.ok(!('invalid' in parse(reply([ev(), ev(), ev()], [claim(), cf(0), cf(1)]))), '3 + 3 = 6');
  assert.match(parse(reply(Array(7).fill(ev()))).invalid, /1-6 findings/);
  assert.match(parse(reply([], [claim(), claim()])).invalid, /repeat/);
  assert.match(parse(reply([], 'not-an-array')).invalid, /at most 3/);
  assert.match(parse(JSON.stringify({ summary: 's', findings: [ev()], claimFindings: [], extra: 1 })).invalid, /schema/);
  // explicit null: evidence-only schema, claimFindings is an unknown key
  assert.match(parse(reply([ev()], [claim()]), { coreClaimContext: null }).invalid, /schema/);
  assert.match(parse(reply([]), { coreClaimContext: null }).invalid, /reviewer must give 1-6 findings/);
  // output bytes: three maximal Korean rationales and quotes stay within the bound; the bound itself is enforced
  const k = { expertId: 'k', name: 'K', opinion: { ...falsify.opinion, summary: '가'.repeat(600), assumptions: ['나'.repeat(300)], nextActions: ['다'.repeat(300)] } };
  const big = (kind, ch) => claim({ targetExpertId: 'k', rationale: '라'.repeat(500) }, { kind, index: 0, quote: ch.repeat(300) });
  const r = M.parseReviewReply(reply([], [big('summary', '가'), big('assumption', '나'), big('nextAction', '다')]), reviewer, [k]);
  assert.ok(!('invalid' in r), r.invalid); assert.ok(utf8(JSON.stringify(r.claimFindings)) <= M.CORE_CLAIM_LIMITS.outputBytes);
  const tight = M.parseCoreClaimFindings([big('summary', '가')], reviewer.expertId, [k], M.buildCoreClaimContext(reviewer, [k]));
  assert.ok('ok' in tight);
  // control characters in a rationale are cleaned, the quote stays verbatim
  const ctl = parse(reply([], [claim({ rationale: 'line\u0007break' })]));
  assert.equal(ctl.claimFindings[0].rationale, 'line break');
});

await check('language: claimFinding rationales join the language check; verbatim English quotes in a Korean reply are allowed', () => {
  const ko = brief({ responseLanguage: 'ko' });
  const okKo = M.parseReviewReply(reply([], [claim({ rationale: '제공된 자료는 초록을 문장 단위로 나눌 수 없다는 전제를 뒷받침하지 않는다. 이 전제는 확인되지 않았다.' })], '동료 의견의 핵심 주장을 제공된 자료와 비교했다.'), reviewer, peers, { language: 'ko' });
  assert.ok(!('invalid' in okKo), okKo.invalid);
  // A short summary alone is ambiguous; the English claim rationale is what makes the reply a clear mismatch.
  assert.equal(M.parseReviewReply(reply([], [claim({ rationale: '전제가 확인되지 않음.' })], '검토함.'), reviewer, peers, { language: 'ko' }).category, undefined);
  const mixed = M.parseReviewReply(reply([], [claim({ rationale: 'The supplied brief does not establish that abstracts cannot be segmented into sentence-level units at all.' })], '검토함.'), reviewer, peers, { language: 'ko' });
  assert.equal(mixed.category, 'language');
  void ko;
});

await check('DO parity: the exact DO call shapes (7-arg reviewMessages, {language, claimSupportContext} parse) agree on targets', () => {
  const support = M.buildClaimSupportContext(B0, peers, []);
  const m = M.reviewMessages(reviewer, peers, B0, undefined, [], undefined, support);
  const t = dataOf(m).coreClaims.targets.find((x) => x.targetExpertId === eda.expertId && x.kind === 'nextAction');
  const evS = { ...ev(), claimSupport: { status: 'insufficient', quotes: [], rationale: 'Raw reports are not attached.' } };
  const r = M.parseReviewReply(reply([evS], [claim({ targetExpertId: eda.expertId, verdict: 'supported', issue: 'other', rationale: 'Re-running on the old corner set is a test that can separate the causes.' }, { kind: 'nextAction', index: t.index, quote: t.text })]),
    reviewer, peers, { language: 'en', claimSupportContext: support });
  assert.ok(!('invalid' in r), r.invalid);
  assert.equal(r.findings[0].claimSupport.status, 'insufficient', 'evidence claim support kept');
  assert.equal(r.claimFindings[0].target.quote, eda.opinion.nextActions[0]);
  // findingTextAvailability still describes evidence findings only
  assert.equal(M.findingTextAvailability(r, [reviewer, ...peers], B0).length, 1);
});

await check('stored-finding validator (for author response): current text required, stale or self/foreign rejected', () => {
  const stored = claim();
  assert.ok('ok' in M.validateCoreClaimFinding(stored, reviewer.expertId, peers));
  assert.match(M.validateCoreClaimFinding(stored, reviewer.expertId, [{ ...falsify, opinion: { ...falsify.opinion, summary: 'Revised summary.' } }]).invalid, /not exact text/);
  assert.match(M.validateCoreClaimFinding(stored, falsify.expertId, peers).invalid, /reviewer itself/);
  assert.match(M.validateCoreClaimFinding(stored, reviewer.expertId, [eda]).invalid, /not supplied/);
  assert.match(M.validateCoreClaimFinding({ ...stored, target: { kind: 'nextAction', index: 9, quote: 'x' } }, reviewer.expertId, peers).invalid, /does not exist/);
  assert.match(M.validateCoreClaimFinding(null, reviewer.expertId, peers).invalid, /schema/);
});

await check('honesty: a semantically wrong verdict with an exact quote is NOT caught by the mechanical check', () => {
  // The reviewer wrongly "supports" the false premise; the quote is exact, so the parser accepts it. Only a human (or a
  // different check) could catch this — the validator proves targeting, not truth.
  const wrong = parse(reply([], [claim({ verdict: 'supported', issue: 'other', rationale: 'Agreed: abstracts cannot be split into sentence units.' })]));
  assert.ok(!('invalid' in wrong));
  assert.equal(wrong.claimFindings[0].verdict, 'supported');
});

console.log(`cloudbite v5 core claims: ${count} checks passed (no network, no model)`);
