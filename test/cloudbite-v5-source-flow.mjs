// Cloudbite v5 source flow: stored claimSupport readings and core-claim findings flow into the author-response plan
// (hash-bound, per-role workspace, rules, reply parsing) and into the final memo coverage/prompt, beside (never
// replacing) the ordinary verdict. Pure module test, no network or provider calls.
// Run: node test/cloudbite-v5-source-flow.mjs
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = await build({
  stdin: { contents: "export * from './cloudbite-author-response'; export { memoMessages, parseMemoReply, completedMemo, runningMemo, memoSnapshot, CB_MEMO_PROMPT_MAX_BYTES, CB_MEMO_BUDGET } from './cloudbite-memo';",
    resolveDir: path.join(repo, 'src'), loader: 'ts' },
  bundle: true, write: false, format: 'esm', platform: 'neutral',
});
const m = await import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'));
let checks = 0;
const ok = (cond, message) => { assert.ok(cond, message); checks++; };
let fetched = 0;
globalThis.fetch = () => { fetched++; throw new Error('network is not allowed'); };

const sha = (s) => createHash('sha256').update(s).digest('hex');
const PARENT = 'cb' + 'a'.repeat(32), NOW = 1_800_000_000_000, ME = 'v_' + '1'.repeat(64), STRANGER = 'v_' + '2'.repeat(64), SNAP = 'c'.repeat(64);
const PKT = 'e'.repeat(64), SRC = 'f'.repeat(64);
/** planSha256 of the legacy fixture below as built by the base module (18d73db), computed once against that revision. */
const LEGACY_PLAN_SHA = '6a8013fd6c7ca3ebdcc9fd86d29c132fdafcd7d8a485ea22f309a0e47db2497a';
const opinion = (id) => ({ direction: 'support', confidence: 70, summary: `Original view of ${id}: the pilot halves onboarding time.\n두 번째 줄 요약 ${id}`,
  evidence: ['[doc:doc-1] ev0 ' + id, 'ev1 ' + id, 'ev2 ' + id], assumptions: ['Vendor keeps the price for 12 months', '가정: 지원 인력은 충분하다'], nextActions: ['Ask for the SLA draft'] });
const run = (expertId, status = 'completed', op = opinion(expertId)) => ({ id: 'r-' + expertId, expertId, name: 'Role ' + expertId, status, sandboxId: 'sbx-secret', updatedAt: 1, activity: [], artifacts: [],
  ...(status === 'completed' ? { opinion: op } : { error: 'failed' }) });
const Q = (quote, over = {}) => ({ passageId: 'p1', ref: 'doc:doc-1', textOrigin: 'user-document', quote, sourceSha256: SRC, startOffset: 10, endOffset: 10 + quote.length, startLine: 2, endLine: 2, ...over });
const CS = (status, quotes = status === 'insufficient' ? [] : [Q('Total: 42k for year one')], over = {}) => ({ status, quotes, rationale: `Source reading ${status}.`,
  basis: 'model-assessment', quoteCheck: 'exact-substring', citedText: 'available', packetSha256: PKT, ...over });
const F = (targetExpertId, evidenceIndex, verdict, claimSupport, rationale = `Rationale on ${targetExpertId}#${evidenceIndex}`) => ({ targetExpertId, evidenceIndex, verdict, rationale, ...(claimSupport ? { claimSupport } : {}) });
const C = (targetExpertId, kind, index, quote, verdict = 'challenged', issue = 'causal-overreach', rationale = `Core reading of ${targetExpertId} ${kind}#${index}`) =>
  ({ targetExpertId, target: { kind, index, quote }, verdict, issue, rationale });
const legacyReports = () => [
  { reviewerExpertId: 'role-a', summary: 's', findings: [F('role-b', 0, 'challenged'), F('role-c', 1, 'supported')] },
  { reviewerExpertId: 'role-b', summary: 's', findings: [F('role-a', 0, 'insufficient')] },
];
const project = (reports, experts = [run('role-a'), run('role-b'), run('role-c')]) => ({ id: PARENT, status: 'completed', createdAt: 10, updatedAt: 20,
  brief: { title: 'Pick a pilot', objective: 'Choose a pilot plan.', context: 'ctx', expertIds: experts.map((e) => e.expertId), mode: 'live', requestId: 'req-1',
    decision: { options: ['Plan A', 'Plan B'], constraints: [], successCriteria: [], knownFacts: [], assumptions: [], unknowns: [] } },
  experts, crossReview: { status: 'completed', snapshotHash: SNAP, startedAt: 30, completedAt: 40, reports, execution: 'server-nosana' } });
const read = (p, actor = ME, owner = false, storedActor = ME) => (!owner && actor !== storedActor ? { error: 'history record not found', status: 404 }
  : { project: structuredClone(p), model: 'm', roles: [], feedback: [], reports: {}, expiresAt: NOW + 1000, canFeedback: true });
const authorize = (p, actor = ME, owner = false) => m.authorizeAuthorResponseParent({ parentId: PARENT, actor, owner, read: read(p, actor, owner), now: NOW });
const brief = (expertIds, over = {}) => ({ title: 'Answer the review', objective: 'Respond to cross-review findings.', context: '', expertIds, mode: 'live', requestId: 'req-2',
  revision: { parentId: PARENT, changeSummary: 'Answer findings.', reviewSnapshotHash: SNAP }, ...over });
const keysDeep = (v, acc = new Set()) => { if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { acc.add(k); keysDeep(x, acc); } return acc; };
const persisted = (plan) => JSON.parse(JSON.stringify(plan));

// ── Legacy: no claimSupport, no claimFindings → v1 plan shape, ids and hash ──
{
  const auth = await authorize(project(legacyReports()));
  const plan = await m.buildAuthorResponsePlan(auth, brief(['role-a', 'role-b']));
  const keys = keysDeep(plan);
  ok(!['sourceAssessment', 'sourceAssessments', 'eligibleBy', 'sourceConflict', 'coreClaims', 'target', 'targetText', 'kind'].some((k) => k !== 'kind' ? keys.has(k) : plan.findings.some((f) => 'kind' in f)), 'legacy plan carries no v5 keys');
  const legacyId = 'arf_' + sha(JSON.stringify(['cloudbite-author-response/v1', PARENT, SNAP, 'role-a', 'role-b', 0, 'challenged', 'Rationale on role-b#0'])).slice(0, 32);
  ok(plan.findings.some((f) => f.findingId === legacyId), 'legacy finding id is the unchanged v1 hash');
  // Hash of this exact plan as built by base 18d73db (computed once against that revision).
  ok(plan.planSha256 === LEGACY_PLAN_SHA, `legacy plan hash unchanged from base: ${plan.planSha256}`);
  ok(auth.supported === 1 && plan.crossReview.supported === 1 && !('sourceAssessments' in plan.crossReview), 'legacy counts unchanged');
  const rules = m.authorResponseWorkOrderRules(plan, 'role-b').join('\n');
  ok(!rules.includes('sourceAssessment') && !rules.includes('core-claim'), 'legacy rules unchanged');
}

// ── Falsify fixture: ordinary verdict supported + claimSupport insufficient must not be dropped ──
const falsifyReports = () => [
  { reviewerExpertId: 'role-a', summary: 's', findings: [
    F('role-b', 1, 'supported', CS('insufficient', [], { citedText: 'uncited', rationale: 'The evidence item cites no source text.' })),
    F('role-c', 0, 'supported', CS('supported')),
    F('role-b', 2, 'challenged', CS('supported')),
    F('role-c', 2, 'challenged', CS('partial')),
  ] },
  { reviewerExpertId: 'role-b', summary: 's', findings: [F('role-a', 0, 'insufficient')] },
];
const fAuth = await authorize(project(falsifyReports()));
{
  ok(!('error' in fAuth), 'falsify parent authorizes for its own actor');
  ok((await authorize(project(falsifyReports()), STRANGER)).status === 404, 'foreign actor gains nothing from stored source data (404)');
  ok(fAuth.findings === 5 && fAuth.supported === 2, 'ordinary findings/supported counts are unchanged by source readings');
  ok(fAuth.sourceAssessments.assessed === 4 && fAuth.sourceAssessments.supportedWithSourceGap === 1 && fAuth.sourceAssessments.conflicts === 2 && fAuth.sourceAssessments.malformed === 0, 'source counts: assessed, gap, conflicts');
  const gap = fAuth.candidates.find((c) => c.targetExpertId === 'role-b' && c.evidenceIndex === 1);
  ok(gap && gap.verdict === 'supported' && gap.sourceAssessment.status === 'insufficient' && gap.eligibleBy === 'source-assessment' && gap.sourceConflict === true, 'supported + insufficient is eligible with BOTH verdict and assessment kept');
  ok(!fAuth.candidates.some((c) => c.targetExpertId === 'role-c' && c.evidenceIndex === 0), 'supported + supported reading stays ineligible');
  const conflict = fAuth.candidates.find((c) => c.targetExpertId === 'role-b' && c.evidenceIndex === 2);
  ok(conflict.verdict === 'challenged' && conflict.eligibleBy === 'verdict' && conflict.sourceConflict === true, 'challenged + supported reading stays eligible by verdict, conflict disclosed');
  ok(fAuth.candidates.find((c) => c.targetExpertId === 'role-c' && c.evidenceIndex === 2).eligibleBy === 'verdict-and-source-assessment', 'challenged + partial is eligible by both');
  const legacyGapId = await m.authorResponseFindingId({ parentId: PARENT, snapshotHash: SNAP, reviewerExpertId: 'role-a', targetExpertId: 'role-b', evidenceIndex: 1, verdict: 'supported', rationale: 'Rationale on role-b#1' });
  ok(gap.findingId !== legacyGapId && gap.findingId === await m.authorResponseFindingId({ parentId: PARENT, snapshotHash: SNAP, reviewerExpertId: 'role-a', targetExpertId: 'role-b',
    evidenceIndex: 1, verdict: 'supported', rationale: 'Rationale on role-b#1', sourceAssessmentSha256: await m.authorResponseSourceAssessmentSha256(gap.sourceAssessment) }), 'id binds the source assessment');
  const edited = falsifyReports(); edited[0].findings[0].claimSupport.rationale = 'Edited reading.';
  ok((await authorize(project(edited))).candidates.find((c) => c.evidenceIndex === 1 && c.targetExpertId === 'role-b').findingId !== gap.findingId, 'edited assessment changes the id');
  const otherSnap = project(falsifyReports()); otherSnap.crossReview.snapshotHash = 'd'.repeat(64);
  ok((await authorize(otherSnap)).candidates.find((c) => c.evidenceIndex === 1 && c.targetExpertId === 'role-b').findingId !== gap.findingId, 'id binds the snapshot');
  ok(JSON.stringify(m.authorResponseAffectedAuthors(fAuth)) === JSON.stringify(['role-a', 'role-b', 'role-c']), 'gap target becomes an affected author');

  const plan = await m.buildAuthorResponsePlan(fAuth, brief(['role-b']));
  ok(!('error' in plan) && plan.findings.length === 2, 'role-b plan has its challenged and its supported-with-gap finding');
  ok(JSON.stringify(plan.findings.map((f) => f.verdict)) === JSON.stringify(['challenged', 'supported']), 'challenged first, supported-with-gap last');
  const pf = plan.findings[1];
  ok(pf.sourceAssessment.status === 'insufficient' && pf.sourceAssessment.citedText === 'uncited' && pf.sourceAssessment.basis === 'model-assessment' && pf.verdict === 'supported', 'plan carries verdict and assessment distinctly');
  ok(plan.crossReview.supported === 2 && plan.crossReview.sourceAssessments.supportedWithSourceGap === 1, 'plan counts disclose the gap without changing supported');
  ok(plan.disclosure.includes('keep a supported verdict beside') && plan.disclosure.includes('not verification'), 'plan disclosure states both readings and no verification');
  const back = persisted(plan);
  ok(await m.verifyAuthorResponsePlan(back), 'new fields survive serialization and the plan hash');
  const t = structuredClone(back); t.findings[1].sourceAssessment.status = 'supported';
  ok(!(await m.verifyAuthorResponsePlan(t)), 'tampered assessment fails the plan hash');
  const ws = JSON.parse(m.authorResponseWorkspaceFiles(back, 'role-b')[0].content);
  const wf = ws.findings.find((f) => f.findingId === pf.findingId);
  ok(wf.verdict === 'supported' && wf.sourceAssessment.status === 'insufficient' && wf.sourceConflict === true && wf.eligibleBy === 'source-assessment', 'per-role workspace carries verdict + assessment');
  ok(m.authorResponseWorkspaceFiles(back, 'role-a').length === 0, 'unselected author gets no workspace');
  const rules = m.authorResponseWorkOrderRules(back, 'role-b').join('\n');
  ok(rules.includes('sourceAssessment') && rules.includes('not verification') && rules.includes('2 expected'), 'rules explain the source reading');
  const parsed = m.parseAuthorResponse(JSON.stringify({ responses: [{ findingId: pf.findingId, disposition: 'revise', rationale: 'I will cite the quote text for this claim.' }] }), back, 'role-b');
  ok(!('invalid' in parsed) && parsed.coverage.answered === 1, 'reply parsing accepts the source-gap finding id');
  const art = m.authorResponseArtifact(back, parsed);
  ok(!('invalid' in await m.validateCollectedAuthorResponse(back, 'role-b', art.content)), 'collected artifact validates');
}

// ── Malformed / foreign / stale source data never gains eligibility ──
{
  const bads = [
    CS('contradicted', []), CS('supported', [Q('short')]), CS('partial', [Q('Total: 42k for year one', { endOffset: 99 })]), CS('partial', undefined, { packetSha256: 'nothex' }),
    CS('contradicted', undefined, { citedText: 'uncited' }), CS('partial', undefined, { basis: 'verified' }), { ...CS('partial'), extra: 1 },
    CS('partial', [Q('Total: 42k for year one'), Q('Total: 42k for year one')]), CS('partial', [Q('a', { textOrigin: 'original-source' })]), 'supported', CS('weird'),
  ];
  for (const [i, cs] of bads.entries()) {
    const a = await authorize(project([{ reviewerExpertId: 'role-a', summary: 's', findings: [F('role-b', 1, 'supported', cs)] }]));
    ok(!a.candidates.length && a.excluded.some((x) => x.reason === 'malformed-source-assessment') && a.supported === 1 && a.sourceAssessments.malformed === 1, `malformed claimSupport #${i} is not eligible`);
  }
  const ch = await authorize(project([{ reviewerExpertId: 'role-a', summary: 's', findings: [F('role-b', 1, 'challenged', CS('partial', []))] }]));
  ok(ch.candidates.length === 1 && ch.candidates[0].sourceAssessmentDropped === 'malformed' && !ch.candidates[0].sourceAssessment
    && ch.candidates[0].findingId === await m.authorResponseFindingId({ parentId: PARENT, snapshotHash: SNAP, reviewerExpertId: 'role-a', targetExpertId: 'role-b', evidenceIndex: 1, verdict: 'challenged', rationale: 'Rationale on role-b#1' }),
  'challenged + malformed reading stays eligible by verdict only, legacy id');
  const mixed = await authorize(project([{ reviewerExpertId: 'role-a', summary: 's', findings: [F('role-b', 1, 'supported', CS('insufficient')), F('role-c', 1, 'supported', CS('partial', undefined, { packetSha256: '9'.repeat(64) }))] }]));
  ok(!mixed.candidates.length && mixed.sourceAssessments.malformed === 2, 'two packets in one report: both readings are treated as foreign');
  const stale = await authorize(project([{ reviewerExpertId: 'role-a', summary: 's', findings: [F('role-b', 7, 'supported', CS('insufficient')), F('role-z', 0, 'supported', CS('insufficient')), F('role-a', 0, 'supported', CS('insufficient'))] }]));
  ok(!stale.candidates.length && ['stale-evidence-index', 'foreign-target', 'self-target'].every((r) => stale.excluded.some((x) => x.reason === r)) && stale.supported === 3, 'stale/foreign/self source-gap findings are excluded, still counted supported');
  const foreignReviewer = await authorize(project([{ reviewerExpertId: 'role-zz', summary: 's', findings: [F('role-b', 1, 'supported', CS('insufficient'))] }]));
  ok(!foreignReviewer.candidates.length && foreignReviewer.excluded.some((x) => x.reason === 'foreign-reviewer'), 'reading by a non-author reviewer is not eligible');
}

// ── Core-claim findings ──
const coreReports = () => [
  { reviewerExpertId: 'role-a', summary: 's', findings: [F('role-b', 0, 'challenged')], claimFindings: [
    C('role-b', 'summary', 0, 'the pilot halves onboarding time.\n두 번째'),
    C('role-b', 'assumption', 1, '지원 인력은 충분하다', 'insufficient', 'missing-assumption'),
    C('role-c', 'nextAction', 0, 'Ask for the SLA', 'supported', 'other'),
  ] },
  { reviewerExpertId: 'role-b', summary: 's', findings: [], claimFindings: [
    C('role-a', 'summary', 0, 'not in the summary'), C('role-a', 'assumption', 5, 'Vendor'), C('role-a', 'summary', 1, 'Original'), C('role-b', 'summary', 0, 'Original'),
  ] },
  { reviewerExpertId: 'role-c', summary: 's', findings: Array.from({ length: 5 }, (_, i) => F('role-a', i % 3, 'supported', undefined, 'ok ' + i)), claimFindings: [C('role-a', 'nextAction', 0, 'SLA draft'), C('role-z', 'summary', 0, 'x')] },
];
const cAuth = await authorize(project(coreReports()));
{
  ok(cAuth.coreClaims.findings === 9 && cAuth.coreClaims.supported === 1 && cAuth.coreClaims.eligible === 3 && cAuth.findings === 6, 'core counts kept apart from evidence findings');
  const reasons = cAuth.excluded.filter((x) => x.coreIndex !== undefined).map((x) => x.reason).sort();
  ok(JSON.stringify(reasons) === JSON.stringify(['malformed', 'over-core-bound', 'over-finding-bound', 'stale-core-target', 'stale-core-target']), 'core exclusions: ' + reasons);
  const s = cAuth.candidates.find((c) => c.kind === 'core-claim' && c.target.kind === 'summary');
  ok(s && !('evidenceIndex' in s) && s.target.quote === 'the pilot halves onboarding time.\n두 번째' && s.target.textSha256 === sha(opinion('role-b').summary), 'core finding carries exact quote and full-text hash, no evidenceIndex');
  const plan = await m.buildAuthorResponsePlan(cAuth, brief(['role-b', 'role-a']));
  ok(!('error' in plan), 'plan with core findings builds');
  const bf = plan.findings.filter((f) => f.targetExpertId === 'role-b');
  ok(JSON.stringify(bf.map((f) => f.kind ?? 'evidence')) === JSON.stringify(['evidence', 'core-claim', 'core-claim']) && bf[2].verdict === 'insufficient', 'per author: challenged evidence, challenged core, then insufficient core');
  ok(bf[1].targetText === opinion('role-b').summary && bf[2].target.index === 1 && bf[2].issue === 'missing-assumption', 'core plan finding has the field text to revise');
  const back = persisted(plan);
  ok(await m.verifyAuthorResponsePlan(back) && plan.crossReview.coreClaims.eligible === 3 && plan.disclosure.includes('core claim'), 'core fields survive persistence and are disclosed');
  const ws = JSON.parse(m.authorResponseWorkspaceFiles(back, 'role-b')[0].content);
  const wcore = ws.findings.filter((f) => f.kind === 'core-claim');
  ok(wcore.length === 2 && wcore[0].target.quote.includes('\n') && wcore[1].yourText === '가정: 지원 인력은 충분하다' && !('evidenceIndex' in wcore[0]), 'workspace: core target, exact quote with newline/UTF-8, field text');
  ok(!m.authorResponseWorkspaceFiles(back, 'role-b')[0].content.includes('Core reading of role-a'), 'workspace holds only own findings');
  ok(m.authorResponseWorkOrderRules(back, 'role-b').join('\n').includes('core-claim'), 'rules explain core targets');
  const ids = plan.authors.find((a) => a.expertId === 'role-b').findingIds;
  const parsed = m.parseAuthorResponse({ responses: ids.map((findingId) => ({ findingId, disposition: 'revise', rationale: 'I narrow the quoted claim to the measured cohort.' })) }, back, 'role-b');
  ok(!('invalid' in parsed) && parsed.coverage.status === 'complete', 'core finding ids parse in replies');
  const q2 = coreReports(); q2[0].claimFindings[0].target.quote = 'the pilot halves';
  ok((await authorize(project(q2))).candidates.find((c) => c.kind === 'core-claim' && c.target.kind === 'summary').findingId !== s.findingId, 'core id binds the quote');
  const edited = project(coreReports()); edited.experts[1].opinion.summary += ' (edited)';
  ok((await authorize(edited)).candidates.find((c) => c.kind === 'core-claim' && c.target.kind === 'summary').findingId !== s.findingId, 'core id binds the full target text hash');
  const supportedOnly = await authorize(project([{ reviewerExpertId: 'role-a', summary: 's', findings: [], claimFindings: [C('role-c', 'summary', 0, 'Original', 'supported')] }]));
  ok((await m.buildAuthorResponsePlan(supportedOnly, brief(['role-c']))).status === 409, 'supported core claim alone is not eligible');
  const notArray = await authorize(project([{ reviewerExpertId: 'role-a', summary: 's', findings: [F('role-b', 0, 'challenged')], claimFindings: 'x' }]));
  ok(notArray.candidates.length === 1 && notArray.excluded.some((x) => x.reason === 'malformed' && x.findingIndex === undefined), 'non-array claimFindings is malformed, evidence still read');
  // KO plan: rules in Korean; long Korean field text cut on code points while the quote stays whole.
  const longOp = { ...opinion('role-b'), assumptions: ['가'.repeat(400) + '끝맺음 문장'] };
  const lAuth = await authorize(project([{ reviewerExpertId: 'role-a', summary: 's', findings: [], claimFindings: [C('role-b', 'assumption', 0, '끝맺음 문장', 'insufficient', 'other')] }], [run('role-a'), run('role-b', 'completed', longOp)]));
  const lPlan = await m.buildAuthorResponsePlan(lAuth, brief(['role-b'], { responseLanguage: 'ko' }));
  ok(new TextEncoder().encode(lPlan.findings[0].targetText).length <= 800 && !lPlan.findings[0].targetText.includes('�') && lPlan.findings[0].target.quote === '끝맺음 문장'
    && lPlan.omissions.some((o) => o.path === 'findings[0].targetText'), 'oversize field text is cut and disclosed; quote kept whole');
  ok(lPlan.findings[0].target.textSha256 === sha(longOp.assumptions[0]) && m.authorResponseWorkOrderRules(lPlan, 'role-b').join('\n').includes('한국어'), 'hash binds the uncut text; KO rules');
}

// ── Caps: big assessments stay inside the per-finding and workspace byte bounds ──
{
  const big = (i) => CS('contradicted', [0, 1, 2].map((k) => Q(`${'인용'.repeat(140)}${i}${k}`, { passageId: 'p' + (k + 1) })), { rationale: '근'.repeat(400) });
  const experts = [run('rv-a'), run('rv-b'), run('rv-c'), run('t-1')];
  const reports = ['rv-a', 'rv-b', 'rv-c'].map((rv, r) => ({ reviewerExpertId: rv, summary: 's', findings: [0, 1, 2].map((k) => F('t-1', k, 'supported', big(r * 3 + k), 'r'.repeat(500))) }));
  const a = await authorize(project(reports, experts));
  const plan = await m.buildAuthorResponsePlan(a, brief(['t-1']));
  ok(plan.findings.length === 9 && plan.findings.every((f) => new TextEncoder().encode(JSON.stringify(f.sourceAssessment)).length <= m.AUTHOR_RESPONSE_LIMITS.sourceAssessmentBytes), 'each copied assessment is within its byte bound');
  ok(plan.findings.every((f) => f.sourceAssessment.quotes.length >= 1 && f.sourceAssessment.quotes.every((q) => q.quote.startsWith('인용'))) && plan.omissions.some((o) => o.path.endsWith('.sourceAssessment.quotes')), 'whole trailing quotes dropped (never cut) and disclosed');
  const ws = m.authorResponseWorkspaceFiles(plan, 't-1')[0].content;
  ok(new TextEncoder().encode(ws).length <= m.AUTHOR_RESPONSE_LIMITS.workspaceBytes, 'workspace within its byte bound');
}

// ── Memo: source readings propagate to coverage and prompt beside the ordinary verdict ──
{
  const mBrief = { title: 'Choose a pilot', objective: 'Pick one of two pilot plans.', context: 'ctx', expertIds: ['role-a', 'role-b'], mode: 'live', requestId: 'memo-v5-01',
    decision: { options: ['Plan A', 'Plan B'], constraints: [], successCriteria: [], knownFacts: [], assumptions: [], unknowns: [] } };
  const completed = ['role-a', 'role-b', 'role-c'].map((id) => ({ expertId: id, name: 'Role ' + id, opinion: opinion(id) }));
  const legacy = m.memoMessages(mBrief, completed, { reviews: legacyReports() });
  ok(!('sourceAssessments' in legacy.coverage) && !('coreClaims' in legacy.coverage) && !legacy.messages[0].content.includes('sourceAssessments') && !legacy.messages[1].content.includes('sourceAssessments'), 'legacy memo prompt/coverage unchanged');
  const reviews = [...falsifyReports(), { reviewerExpertId: 'role-c', summary: 's', findings: [F('role-a', 1, 'challenged', CS('partial', [], {}))], claimFindings: coreReports()[0].claimFindings }];
  const p = m.memoMessages(mBrief, completed, { reviews });
  const sa = p.coverage.sourceAssessments;
  ok(sa.basis === 'model-assessment' && sa.quoteCheck === 'exact-substring' && sa.assessed === 4 && sa.malformed === 1 && sa.notAssessed === 1, 'memo coverage counts assessed/malformed/not assessed');
  ok(sa.conflicts === 2 && sa.gaps === 1 && sa.statusCounts.insufficient === 1 && sa.statusCounts.supported === 2 && sa.statusCounts.partial === 1, 'memo coverage counts conflicts, gaps, statuses');
  const it = sa.items.find((x) => x.targetExpertId === 'role-b' && x.evidenceIndex === 1);
  ok(it.ordinaryVerdict === 'supported' && it.sourceStatus === 'insufficient' && it.conflict && it.gap && it.citedText === 'uncited', 'ordinary verdict and source reading kept distinct, conflict disclosed');
  const q = sa.items.find((x) => x.sourceStatus === 'partial').quotes[0];
  ok(q.quote === 'Total: 42k for year one' && q.sourceSha256 === SRC && q.textOrigin === 'user-document' && q.startLine === 2, 'exact quote, origin and hash propagate');
  const data = JSON.parse(p.messages[1].content.slice('Untrusted memo data (JSON):\n'.length));
  ok(data.sourceAssessments.length === 4 && data.sourceAssessments[0].ordinaryVerdict === 'supported' && p.messages[0].content.includes('not verification'), 'prompt carries the readings with the no-verification rule');
  ok(data.crossReview[0].findings[0].verdict === 'supported', 'prompt keeps the ordinary verdict on the finding');
  ok(p.coverage.coreClaims.included === 2 && p.coverage.coreClaims.total === 3 && p.coverage.coreClaims.invalid === 1 && data.coreClaimFindings.length === 2, 'core claims: valid ones in prompt, invalid counted (role-c cannot target itself)');
  const reply = JSON.stringify({ summary: 'One reviewer marked role-b evidence 1 supported while its source reading was insufficient; both stand.',
    recommendation: { status: 'no-recommendation', optionIds: [], rationale: 'Source readings conflict with verdicts.', expertIds: ['role-b'], refs: [] },
    options: [{ optionId: 'option-1', benefits: [{ text: 'Cheaper', expertIds: [], refs: [] }], risks: [], conditions: [] }, { optionId: 'option-2', benefits: [], risks: [{ text: 'Unclear SLA', expertIds: [], refs: [] }], conditions: [] }],
    dissent: [], criticalUnknowns: [], changeTriggers: [{ text: 'A cited source for the claim', expertIds: [], refs: [] }], nextActions: [{ text: 'Cite the quote text', expertIds: [], refs: [] }] });
  const r = m.parseMemoReply(reply, p);
  ok(!('invalid' in r), 'memo reply parses: ' + JSON.stringify(r).slice(0, 200));
  const stored = m.completedMemo(m.runningMemo(p, 'h'.repeat(64), NOW), r, NOW + 1);
  ok(stored.coverage.sourceAssessments.items.length === 4 && persisted(stored).coverage.sourceAssessments.items[0].quotes.length === 0, 'final stored memo carries the bounded source assessments');
  // Budget: 18 large readings → items capped as whole items, counts kept, prompt within bound.
  const big = ['role-a', 'role-b', 'role-c'].map((rv) => ({ reviewerExpertId: rv, summary: 's', findings: Array.from({ length: 6 }, (_, k) => F(rv === 'role-a' ? 'role-b' : 'role-a', k % 3, 'supported',
    CS('contradicted', [0, 1, 2].map((j) => Q('따옴표'.repeat(99) + k + j, { passageId: 'p' + (j + 1) })), { rationale: '이'.repeat(400) }))) }));
  const bp = m.memoMessages(mBrief, completed, { reviews: big });
  const bs = bp.coverage.sourceAssessments;
  ok(bs.assessed === 18 && bs.omitted > 0 && bs.items.length + bs.omitted === 18 && bp.coverage.promptBytes <= m.CB_MEMO_PROMPT_MAX_BYTES, 'source table byte-capped by whole items; counts stay complete');
  ok(new TextEncoder().encode(JSON.stringify(bs.items)).length <= m.CB_MEMO_BUDGET.sourceAssessments, 'stored item table within its budget');
  ok(m.memoSnapshot(mBrief, completed, { reviews }) !== m.memoSnapshot(mBrief, completed, { reviews: falsifyReports() }), 'snapshot changes with the review data');
}

ok(fetched === 0, 'no network');
console.log(`cloudbite-v5-source-flow: ${checks} checks passed`);
