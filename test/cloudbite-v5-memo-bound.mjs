// Cloudbite v5 memo bound: source-assessment and core-claim annotations are reserved inside the existing 160 KiB
// memo prompt budget (taken from the expert section), so a valid maximum-shaped 100-role Korean project still builds,
// while prompts without annotations stay byte-identical to the base revision. Pure module test, no provider calls.
// Run: node test/cloudbite-v5-memo-bound.mjs
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** Base revision the repair is applied on: its memo module is the byte-identity reference for annotation-free prompts. */
const BASE = '8481329';
const load = async (contents) => {
  const out = await build({ stdin: { contents, resolveDir: path.join(repo, 'src'), loader: 'ts' }, bundle: true, write: false, format: 'esm', platform: 'neutral' });
  return import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'));
};
const m = await load("export * from './cloudbite-memo';");
const base = await load(execFileSync('git', ['show', `${BASE}:src/cloudbite-memo.ts`], { cwd: repo, encoding: 'utf8' }));
let checks = 0;
const ok = (cond, message) => { assert.ok(cond, message); checks++; };
let fetched = 0;
globalThis.fetch = () => { fetched++; throw new Error('network is not allowed'); };
const bytes = (s) => new TextEncoder().encode(s).length;
const dataOf = (p) => JSON.parse(p.messages[1].content.slice('Untrusted memo data (JSON):\n'.length));

// ── maximum-shaped fixture at the original field bounds (Korean, 100 roles, 6 documents, 3 reports, packets, provenance) ──
const fill = (n) => '가'.repeat(n), ids = Array.from({ length: 100 }, (_, i) => 'role-' + i);
const heavyOpinion = () => ({ direction: 'conditional', confidence: 55, summary: fill(2000), evidence: Array(12).fill(fill(580) + ' [source:PROJECT.md]'),
  assumptions: Array(12).fill(fill(600)), nextActions: Array(12).fill(fill(600)) });
const heavyBrief = { title: fill(100), objective: fill(2000), context: fill(8000), mode: 'live', expertIds: ids, requestId: 'memo-bound-heavy', stage: 'design', responseLanguage: 'ko',
  documents: Array.from({ length: 6 }, (_, i) => ({ id: 'doc-' + (i + 1), name: '문서' + i, content: fill(4000) })),
  decision: Object.fromEntries(['options', 'constraints', 'successCriteria', 'knownFacts', 'assumptions', 'unknowns'].map((k) => [k, Array.from({ length: 8 }, (_, i) => i + fill(299))])) };
const heavyCompleted = ids.map((id) => ({ expertId: id, name: id, opinion: heavyOpinion() }));
const quote = fill(300);
const assessment = { status: 'partial', quotes: Array.from({ length: 3 }, (_, i) => ({ passageId: 'p' + (i + 1), ref: 'source:PROJECT.md', textOrigin: 'workspace-field', quote,
  sourceSha256: 'a'.repeat(64), startOffset: i * 300, endOffset: (i + 1) * 300, startLine: 1, endLine: 1 })),
  rationale: fill(400), basis: 'model-assessment', quoteCheck: 'exact-substring', citedText: 'available', packetSha256: 'b'.repeat(64) };
// Three reports at the total-per-report bound (3 evidence findings + 3 core claims each); core quotes are exact opinion text.
const heavyReviews = ids.slice(0, 3).map((reviewerExpertId) => ({ reviewerExpertId, summary: fill(600),
  findings: [0, 1, 2].map((i) => ({ targetExpertId: ids[3 + i], evidenceIndex: i, verdict: 'supported', rationale: fill(500), claimSupport: assessment })),
  claimFindings: [0, 1, 2].map((i) => ({ targetExpertId: ids[3 + i], target: { kind: 'summary', index: 0, quote }, verdict: 'challenged', issue: 'unsupported-premise', rationale: fill(500) })) }));
const legacyOf = (reviews) => reviews.map((r) => ({ reviewerExpertId: r.reviewerExpertId, summary: r.summary,
  findings: r.findings.map(({ claimSupport, ...f }) => f) }));
const packets = Array.from({ length: 8 }, (_, i) => ({ id: 'pkt-' + i, kind: 'source-excerpt', label: fill(120), text: fill(3000) }));
const provenance = { snapshot: 'c'.repeat(64), text: fill(2700) };

// ── ordinary small project (5 roles, short English) ──
const smallIds = ['role-a', 'role-b', 'role-c', 'role-d', 'role-e'];
const smallOpinion = (id) => ({ direction: 'support', confidence: 70, summary: `Original view of ${id}: the pilot halves onboarding time.`,
  evidence: ['[doc:doc-1] ev0 ' + id, 'ev1 ' + id, 'ev2 ' + id], assumptions: ['Vendor keeps the price for 12 months'], nextActions: ['Ask for the SLA draft'] });
const smallBrief = { title: 'Choose a pilot', objective: 'Pick one of two pilot plans.', context: 'ctx', expertIds: smallIds, mode: 'live', requestId: 'memo-bound-small',
  documents: [{ id: 'doc-1', name: 'notes', content: 'Total: 42k for year one' }],
  decision: { options: ['Plan A', 'Plan B'], constraints: ['Budget 50k'], successCriteria: [], knownFacts: [], assumptions: [], unknowns: [] } };
const smallCompleted = smallIds.map((id) => ({ expertId: id, name: 'Role ' + id, opinion: smallOpinion(id) }));
const smallAssessment = { ...assessment, quotes: [{ ...assessment.quotes[0], ref: 'doc:doc-1', textOrigin: 'user-document', quote: 'Total: 42k', endOffset: 10 }], rationale: 'Partly shown.' };
const smallReviews = [
  { reviewerExpertId: 'role-a', summary: 's', findings: [{ targetExpertId: 'role-b', evidenceIndex: 0, verdict: 'supported', rationale: 'r', claimSupport: { ...smallAssessment, status: 'insufficient', quotes: [], citedText: 'uncited' } }],
    claimFindings: [{ targetExpertId: 'role-c', target: { kind: 'summary', index: 0, quote: 'the pilot halves onboarding time' }, verdict: 'challenged', issue: 'causal-overreach', rationale: 'No baseline.' }] },
  { reviewerExpertId: 'role-b', summary: 's', findings: [{ targetExpertId: 'role-a', evidenceIndex: 1, verdict: 'challenged', rationale: 'r2', claimSupport: smallAssessment }] },
];

// ── Legacy byte identity: annotation-free prompts equal the base revision exactly ──
const legacyCases = [
  ['small, no reviews', smallBrief, smallCompleted, {}],
  ['small, legacy reviews', smallBrief, smallCompleted, { reviews: legacyOf(smallReviews) }],
  ['heavy, no reviews', heavyBrief, heavyCompleted, {}],
  ['heavy, legacy reviews+packets+provenance', heavyBrief, heavyCompleted, { reviews: legacyOf(heavyReviews), packets, provenance }],
];
for (const [name, b, c, o] of legacyCases) {
  const now = m.memoMessages(b, c, o), then = base.memoMessages(b, c, o);
  ok(JSON.stringify(now.messages) === JSON.stringify(then.messages), `${name}: prompt byte-identical to ${BASE}`);
  ok(JSON.stringify(now.coverage) === JSON.stringify(then.coverage) && JSON.stringify(now.allowed) === JSON.stringify(then.allowed) && now.snapshot === then.snapshot, `${name}: coverage/allowed/snapshot identical`);
}

// ── Heavy 100-role Korean project with every annotation section: builds within the unchanged global bound ──
{
  const opts = { reviews: heavyReviews, packets, provenance };
  const before = JSON.stringify([heavyBrief, heavyCompleted, opts]);
  let threw = null;
  try { base.memoMessages(heavyBrief, heavyCompleted, opts); } catch (e) { threw = e.message; }
  ok(/exceeded its byte budget/.test(threw ?? ''), 'base revision rejects this valid input (the repaired defect): ' + threw);
  const p = m.memoMessages(heavyBrief, heavyCompleted, opts);
  ok(m.CB_MEMO_PROMPT_MAX_BYTES === 160 * 1024 && m.CB_MEMO_MAX_TOKENS === 8192 && m.CB_MEMO_MAX_ATTEMPTS === 1, 'global bound, output tokens and paid attempts unchanged');
  ok(p.kind === 'prompt' && p.coverage.promptBytes <= m.CB_MEMO_PROMPT_MAX_BYTES && p.coverage.promptBytes === p.messages.reduce((n, x) => n + bytes(x.content), 0), `heavy prompt within the bound (${p.coverage.promptBytes})`);
  ok(JSON.stringify([heavyBrief, heavyCompleted, opts]) === before, 'original inputs unchanged');
  const data = dataOf(p);
  ok(p.coverage.teamSize === 100 && p.coverage.completed === 100 && p.coverage.experts.length === 100 && data.experts.length === 100, 'honest denominator: all 100 experts present');
  ok(p.coverage.experts.every((e) => e.summaryTruncated && e.evidenceTotal === 12 && e.assumptionsTotal === 12), 'expert trims disclosed per expert with original totals');
  const sa = p.coverage.sourceAssessments;
  ok(sa && sa.assessed === 9 && sa.items.length + sa.omitted === 9 && data.sourceAssessments.length === sa.items.length && sa.items.length > 0, `source assessments survive (${sa.items.length} of 9 items, ${sa.omitted} omitted)`);
  ok(sa.statusCounts.partial === 9 && sa.items.every((x) => x.sourceStatus === 'partial' && x.ordinaryVerdict === 'supported' && x.quotes.length === 3 && x.quotes.every((q) => q.quote === quote)), 'statuses, verdicts and whole exact quotes survive');
  ok(data.sourceAssessments.every((v) => v.quotes.every((q) => q.quote === quote)), 'prompt quotes are verbatim');
  const cc = p.coverage.coreClaims;
  ok(cc && cc.total === 9 && cc.invalid === 0 && cc.included === data.coreClaimFindings.length && cc.included + cc.omitted === 9 && cc.included > 0, `core claims survive (${cc.included} of 9)`);
  ok(data.coreClaimFindings.every((c) => c.target.quote === quote && c.verdict === 'challenged'), 'core-claim quotes and verdicts survive');
  ok(p.messages[0].content.includes('sourceAssessments (when present)') && p.messages[0].content.includes('coreClaimFindings (when present)'), 'annotation rules present');
  ok(JSON.stringify(data.allowedRefs) === JSON.stringify(p.allowed.refs) && data.sourceAssessments.every((v) => p.allowed.refs.includes(v.finding)), 'allowedRefs consistent with the prompt and the rev refs it cites');
  ok(p.allowed.refs.filter((r) => r.startsWith('ev:')).length === p.coverage.experts.reduce((n, e) => n + e.evidenceIncluded.length, 0), 'ev refs match included evidence exactly');
  ok(p.snapshot === m.memoSnapshot(heavyBrief, heavyCompleted, opts) && p.snapshot !== m.memoSnapshot(heavyBrief, heavyCompleted, { reviews: legacyOf(heavyReviews), packets, provenance }), 'snapshot binds the full unclipped annotations');
  ok(p.coverage.provenance && p.coverage.packets.included === 8 && p.coverage.reviews.reports === 3, 'packets, provenance and reviews still present');
  // Without annotations, the same team gets the larger legacy share; with them, the share shrinks only by the reserve.
  const legacyHeavy = m.memoMessages(heavyBrief, heavyCompleted, { reviews: legacyOf(heavyReviews), packets, provenance });
  const expertBytes = (q) => bytes(JSON.stringify(dataOf(q).experts));
  ok(expertBytes(p) < expertBytes(legacyHeavy) && expertBytes(legacyHeavy) - expertBytes(p) < 32 * 1024, 'reserve comes out of the expert section, bounded');
}

// ── Ordinary small project with annotations: expert section untouched, annotations fully present ──
{
  const opts = { reviews: smallReviews };
  const before = JSON.stringify([smallBrief, smallCompleted, opts]);
  const p = m.memoMessages(smallBrief, smallCompleted, opts), b = base.memoMessages(smallBrief, smallCompleted, opts);
  ok(JSON.stringify(p.messages) === JSON.stringify(b.messages) && JSON.stringify(p.coverage) === JSON.stringify(b.coverage), 'small annotated prompt identical to base (reserve leaves the 3 KiB per-expert cap)');
  ok(JSON.stringify([smallBrief, smallCompleted, opts]) === before, 'small inputs unchanged');
  const sa = p.coverage.sourceAssessments, data = dataOf(p);
  ok(sa.assessed === 2 && sa.omitted === 0 && sa.conflicts === 1 && sa.gaps === 1 && sa.items[0].sourceStatus === 'insufficient' && sa.items[1].quotes[0].quote === 'Total: 42k', 'small: statuses, conflicts, gaps, quotes all present');
  ok(p.coverage.coreClaims.included === 1 && data.coreClaimFindings[0].target.quote === 'the pilot halves onboarding time', 'small: core claim present with its quote');
  // 10 roles with 3 KiB-sized opinions: still the full per-expert cap.
  const tenIds = Array.from({ length: 10 }, (_, i) => 'role-' + i);
  const ten = tenIds.map((id) => ({ expertId: id, name: id, opinion: heavyOpinion() }));
  const tenBrief = { ...heavyBrief, expertIds: tenIds };
  const tp = m.memoMessages(tenBrief, ten, { reviews: heavyReviews }), tb = base.memoMessages(tenBrief, ten, { reviews: heavyReviews });
  ok(JSON.stringify(dataOf(tp).experts) === JSON.stringify(dataOf(tb).experts) && tp.coverage.sourceAssessments.items.length > 0 && tp.coverage.coreClaims.included > 0, '10 roles: expert section identical to base, annotations present');
}

ok(fetched === 0, 'no network or provider calls');
console.log(`cloudbite-v5-memo-bound: ${checks} checks passed`);
