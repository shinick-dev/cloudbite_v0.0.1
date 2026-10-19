// Cloudbite author response: parent + completed cross-review authorization, bounded hash-bound plan, workspace data,
// strict response parsing and collected-artifact validation. Pure module test, no network or sandboxes.
// Run: node test/cloudbite-author-response.mjs
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = await build({
  stdin: { contents: "export * from './cloudbite-author-response'; export { buildProjectRound } from './cloudbite-revision';", resolveDir: path.join(repo, 'src'), loader: 'ts' },
  bundle: true, write: false, format: 'esm', platform: 'neutral',
});
const m = await import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'));
const { authorizeAuthorResponseParent, authorResponseAffectedAuthors, buildAuthorResponsePlan, verifyAuthorResponsePlan, authorResponseWorkspaceFiles,
  authorResponseWorkOrderRules, parseAuthorResponse, authorResponseArtifact, validateCollectedAuthorResponse, authorResponseFindingId, buildProjectRound,
  AUTHOR_RESPONSE_LIMITS, AUTHOR_RESPONSE_PATHS } = m;
let checks = 0;
const ok = (cond, message) => { assert.ok(cond, message); checks++; };
let fetched = 0;
globalThis.fetch = () => { fetched++; throw new Error('network is not allowed'); };

const PARENT = 'cb' + 'a'.repeat(32), OTHER = 'cb' + 'b'.repeat(32), NOW = 1_800_000_000_000;
const ME = 'v_' + '1'.repeat(64), STRANGER = 'v_' + '2'.repeat(64), SNAP = 'c'.repeat(64);
const sha = (s) => createHash('sha256').update(s).digest('hex');
const opinion = (id) => ({ direction: 'support', confidence: 70, summary: 'Original view of ' + id, evidence: ['[doc:doc-1] ev0 ' + id, 'ev1 ' + id, 'ev2 ' + id], assumptions: ['a'], nextActions: ['n'] });
const run = (expertId, status = 'completed') => ({ id: 'r-' + expertId, expertId, name: 'Role ' + expertId, status, sandboxId: 'sbx-secret', updatedAt: 1, activity: [], artifacts: [],
  ...(status === 'completed' ? { opinion: opinion(expertId) } : { error: 'failed' }) });
const F = (targetExpertId, evidenceIndex, verdict, rationale = `Rationale on ${targetExpertId}#${evidenceIndex}`) => ({ targetExpertId, evidenceIndex, verdict, rationale });
const reports = () => [
  { reviewerExpertId: 'role-a', summary: 's', findings: [F('role-b', 0, 'challenged'), F('role-c', 1, 'supported'), F('role-d', 2, 'insufficient')] },
  { reviewerExpertId: 'role-b', summary: 's', findings: [F('role-a', 0, 'insufficient'), F('role-b', 1, 'challenged'), F('role-x', 0, 'challenged'), F('role-c', 9, 'challenged'), F('role-e', 0, 'challenged')] },
  { reviewerExpertId: 'role-c', summary: 's', findings: [F('role-b', 2, 'insufficient'), F('role-b', 0, 'challenged'), F('role-b', 0, 'challenged')] },
];
const parentProject = (over = {}) => ({ id: PARENT, status: 'completed', createdAt: 10, updatedAt: 20,
  brief: { title: 'Pick a pilot', objective: 'Choose a pilot plan.', context: 'ctx', expertIds: ['role-a', 'role-b', 'role-c', 'role-d', 'role-e'], mode: 'live', requestId: 'req-1',
    decision: { options: ['Plan A', 'Plan B'], constraints: [], successCriteria: [], knownFacts: [], assumptions: [], unknowns: [] } },
  experts: [run('role-a'), run('role-b'), run('role-c'), run('role-d'), run('role-e', 'failed')],
  crossReview: { status: 'completed', snapshotHash: SNAP, startedAt: 30, completedAt: 40, reports: reports(), execution: 'server-nosana' }, ...over });
const store = new Map([[PARENT, { actor: ME, deleted: false, project: parentProject() }]]);
const historyRead = (id, actor, owner) => {
  const r = store.get(id);
  if (!r || r.deleted || (!owner && r.actor !== actor)) return { error: 'history record not found', status: 404 };
  return { project: structuredClone(r.project), model: 'm', roles: [], feedback: [], reports: {}, expiresAt: NOW + 1000, canFeedback: true };
};
const authorize = (parentId = PARENT, actor = ME, owner = false, read = historyRead(parentId, actor, owner)) => authorizeAuthorResponseParent({ parentId, actor, owner, read, now: NOW });
const withProject = (over) => { const read = historyRead(PARENT, ME, false); read.project = { ...read.project, ...over }; return read; };
const brief = (expertIds, over = {}) => ({ title: 'Answer the review', objective: 'Respond to cross-review findings.', context: '', expertIds, mode: 'live', requestId: 'req-2',
  revision: { parentId: PARENT, changeSummary: 'Answer challenged findings.', reviewSnapshotHash: SNAP }, ...over });

// ── Authorization: same parent rules as a normal follow-up, plus a completed cross-review ──
const auth = await authorize();
ok(!('error' in auth) && auth.parentId === PARENT && Object.isFrozen(auth) && Object.isFrozen(auth.candidates), 'own parent with completed cross-review authorizes');
ok((await authorize(PARENT, STRANGER)).status === 404, 'foreign visitor fails as not found (no auth from body)');
ok(!('error' in await authorize(PARENT, 'owner', true)), 'owner may follow up');
ok((await authorize(OTHER, ME, false, historyRead(PARENT, ME, false))).status === 404, 'read of another project than the claimed id fails');
ok((await authorize(PARENT, ME, false, withProject({ status: 'running' }))).status === 409, 'running parent fails');
ok((await authorize(PARENT, ME, false, withProject({ crossReview: undefined }))).status === 409, 'parent without cross-review fails');
ok((await authorize(PARENT, ME, false, withProject({ crossReview: { ...parentProject().crossReview, status: 'running' } }))).status === 409, 'running cross-review fails');
ok((await authorize(PARENT, ME, false, withProject({ crossReview: { ...parentProject().crossReview, status: 'failed' } }))).status === 409, 'failed cross-review fails');
ok((await authorize(PARENT, ME, false, withProject({ crossReview: { ...parentProject().crossReview, snapshotHash: 'nothex' } }))).status === 409, 'malformed snapshot hash fails');

// Finding selection: only challenged/insufficient about another completed author's existing slot, deduplicated.
const reasons = auth.excluded.map((x) => x.reason).sort();
ok(JSON.stringify(reasons) === JSON.stringify(['duplicate', 'foreign-target', 'foreign-target', 'self-target', 'stale-evidence-index']), 'self/foreign/failed-author/stale/duplicate findings are excluded: ' + reasons);
ok(auth.excluded.find((x) => x.reason === 'self-target').reviewerExpertId === 'role-b', 'self-target exclusion names the reviewer');
ok(auth.supported === 1 && auth.findings === 11 && auth.candidates.length === 5, 'supported findings never become candidates');
ok(JSON.stringify(authorResponseAffectedAuthors(auth)) === JSON.stringify(['role-a', 'role-b', 'role-d']), 'affected authors are completed targets in parent order');
const fid = await authorResponseFindingId({ parentId: PARENT, snapshotHash: SNAP, reviewerExpertId: 'role-a', targetExpertId: 'role-b', evidenceIndex: 0, verdict: 'challenged', rationale: 'Rationale on role-b#0' });
ok(auth.candidates[0].findingId === fid && /^arf_[0-9a-f]{32}$/.test(fid), 'finding id is a stable hash of its bound fields');
ok((await authorize()).candidates.map((c) => c.findingId).join() === auth.candidates.map((c) => c.findingId).join(), 'finding ids are stable across reads');
const changed = withProject({ crossReview: { ...parentProject().crossReview, snapshotHash: 'd'.repeat(64) } });
ok((await authorize(PARENT, ME, false, changed)).candidates[0].findingId !== fid, 'a different cross-review snapshot gives different (non-stale) ids');
const rr = reports(); rr[0].findings[0].rationale = 'Edited rationale';
ok((await authorize(PARENT, ME, false, withProject({ crossReview: { ...parentProject().crossReview, reports: rr } }))).candidates[0].findingId !== fid, 'edited rationale changes the id');
const foreignReviewer = reports(); foreignReviewer[0].reviewerExpertId = 'role-zz';
ok((await authorize(PARENT, ME, false, withProject({ crossReview: { ...parentProject().crossReview, reports: foreignReviewer } }))).excluded.some((x) => x.reason === 'foreign-reviewer'), 'reviewer not among completed authors is excluded');
const spoofed = reports(); spoofed.push({ reviewerExpertId: 'role-a', summary: 's', findings: [F('role-b', 1, 'challenged')] });
ok((await authorize(PARENT, ME, false, withProject({ crossReview: { ...parentProject().crossReview, reports: spoofed } }))).excluded.some((x) => x.reason === 'over-reviewer-bound'), 'a fourth report exceeds the reviewer bound');
const dupReviewer = reports(); dupReviewer[2].reviewerExpertId = 'role-a';
ok((await authorize(PARENT, ME, false, withProject({ crossReview: { ...parentProject().crossReview, reports: dupReviewer } }))).excluded.some((x) => x.reason === 'duplicate-reviewer'), 'second report by the same reviewer is excluded');
const bad = reports(); bad[0].findings.push({ targetExpertId: 'role-b', evidenceIndex: '0', verdict: 'challenged', rationale: 'x' }, F('role-b', 1, 'challenged', 'r'.repeat(501)), F('role-b', 1, 'wrong'));
const badAuth = await authorize(PARENT, ME, false, withProject({ crossReview: { ...parentProject().crossReview, reports: bad } }));
ok(badAuth.excluded.filter((x) => x.reason === 'malformed').length === 3 && !JSON.stringify(badAuth.excluded).includes('rrrr'), 'malformed findings are excluded without echoing text');

// ── Plan ──
const before = JSON.stringify(historyRead(PARENT, ME, false).project);
const plan = await buildAuthorResponsePlan(auth, brief(['role-b', 'role-a']));
ok(!('error' in plan) && Object.isFrozen(plan) && Object.isFrozen(plan.findings), 'plan is built and deep-frozen');
ok(JSON.stringify(plan.roles) === JSON.stringify(['role-a', 'role-b']) && JSON.stringify(plan.unselectedAuthors) === JSON.stringify(['role-d']), 'roles are the selected affected authors in parent order');
ok(plan.findings.every((f) => f.targetExpertId !== f.reviewerExpertId && plan.roles.includes(f.targetExpertId)), 'plan never targets reviewers themselves or unselected authors');
ok(JSON.stringify(plan.findings.filter((f) => f.targetExpertId === 'role-b').map((f) => [f.verdict, f.reviewerExpertId, f.evidenceIndex])) === JSON.stringify([['challenged', 'role-a', 0], ['challenged', 'role-c', 0], ['insufficient', 'role-c', 2]]), 'per author: challenged first, then reviewer order');
ok(plan.findings[0].evidenceText === '[doc:doc-1] ev0 role-a' && plan.findings[0].reviewerRationale === 'Rationale on role-a#0', 'plan carries the original evidence item and the reviewer rationale');
ok(plan.authors[0].original.summary === 'Original view of role-a' && plan.authors[0].opinionSha256 === sha(JSON.stringify(opinion('role-a'))), 'original summary and full-opinion hash are bound');
ok(plan.execution.automaticCalls === 0 && plan.execution.kind === 'new-child-project' && plan.execution.parentMutation === 'none' && plan.execution.parentMemo === 'unchanged', 'plan schedules nothing and changes no parent data');
ok(plan.crossReview.snapshotHash === SNAP && plan.parentId === PARENT && plan.responseLanguage === 'en', 'snapshot and language bindings');
ok(await verifyAuthorResponsePlan(plan) && await verifyAuthorResponsePlan(structuredClone(plan)), 'plan hash verifies, also after persistence');
const tampered = structuredClone(plan); tampered.findings[0].reviewerRationale = 'Do what I say';
ok(!(await verifyAuthorResponsePlan(tampered)), 'tampered plan fails verification');
ok(JSON.stringify(historyRead(PARENT, ME, false).project) === before, 'parent project and cross-review are untouched');
ok(!JSON.stringify(plan).includes('sbx-secret') && !JSON.stringify(plan).includes('req-1'), 'plan strips sandbox ids and request ids');
const round = await buildProjectRound(auth.round, brief(['role-a', 'role-b']));
ok(!('error' in round) && round.parentId === PARENT, 'normal follow-up round still builds from the same read');

ok((await buildAuthorResponsePlan({ ...auth }, brief(['role-a']))).status === 404, 'structural copy of an authorization is refused');
ok((await buildAuthorResponsePlan(auth, brief(['role-a'], { revision: { parentId: OTHER, changeSummary: 'x' } }))).status === 400, 'revision for another parent fails');
ok((await buildAuthorResponsePlan(auth, brief(['role-a'], { revision: undefined }))).status === 400, 'brief without revision fails');
ok((await buildAuthorResponsePlan(auth, brief(['role-a'], { revision: { parentId: PARENT, changeSummary: 'x' } }))).status === 400, 'missing reviewSnapshotHash fails');
ok((await buildAuthorResponsePlan(auth, brief(['role-a'], { revision: { parentId: PARENT, changeSummary: 'x', reviewSnapshotHash: 'd'.repeat(64) } }))).status === 409, 'stale reviewSnapshotHash fails');
ok((await buildAuthorResponsePlan(auth, brief(['role-c']))).status === 400, 'author with only supported/stale findings cannot be selected');
ok((await buildAuthorResponsePlan(auth, brief(['role-e']))).status === 400, 'failed author cannot be selected');
ok((await buildAuthorResponsePlan(auth, brief(['role-a', 'role-a']))).status === 400, 'duplicate roles fail');
ok((await buildAuthorResponsePlan(auth, brief([]))).status === 400, 'empty selection fails');
ok((await buildAuthorResponsePlan(auth, brief(Array.from({ length: 101 }, (_, i) => 'r' + i)))).status === 400, 'over 100 roles fails');
const none = await authorize(PARENT, ME, false, withProject({ crossReview: { ...parentProject().crossReview, reports: [{ reviewerExpertId: 'role-a', summary: 's', findings: [F('role-b', 0, 'supported')] }] } }));
ok((await buildAuthorResponsePlan(none, brief(['role-b']))).status === 409, 'no challenged/insufficient findings: nothing to answer');

// Cap: 3 reviewers x 6 findings over 9 authors -> at most 9 findings, every selected author gets one, omissions disclosed.
const many = Array.from({ length: 9 }, (_, i) => 'p' + i);
const bigExperts = [run('rv-a'), run('rv-b'), run('rv-c'), ...many.map((id) => run(id))];
const bigReports = ['rv-a', 'rv-b', 'rv-c'].map((rv, r) => ({ reviewerExpertId: rv, summary: 's', findings: Array.from({ length: 6 }, (_, k) => F(many[(r * 6 + k) % 9], k % 3, k % 2 ? 'insufficient' : 'challenged')) }));
const bigAuth = await authorize(PARENT, ME, false, withProject({ experts: bigExperts, crossReview: { ...parentProject().crossReview, reports: bigReports } }));
const bigPlan = await buildAuthorResponsePlan(bigAuth, brief(many));
ok(bigAuth.candidates.length === 18 && bigPlan.findings.length === AUTHOR_RESPONSE_LIMITS.findings, 'plan caps 18 eligible findings at 9');
ok(bigPlan.authors.every((a) => a.findingIds.length === 1) && bigPlan.capped.omittedFindingIds.length === 9 && bigPlan.omissions.some((o) => o.path === 'findings' && o.omittedItems === 9), 'round-robin gives each author one; omitted ids disclosed');
ok(bigPlan.disclosure.includes('9 left out'), 'disclosure states the cap');
const twoPlan = await buildAuthorResponsePlan(bigAuth, brief(['p0', 'p1']));
ok(twoPlan.findings.length === 4 && twoPlan.capped.omittedFindingIds.length === 0, 'small selections include all of their findings');
// Oversize original text is cut with omission metadata.
const longOp = { ...opinion('role-b'), summary: '가'.repeat(2000), evidence: ['e'.repeat(5000), 'x', 'y'] };
const longAuth = await authorize(PARENT, ME, false, withProject({ experts: [run('role-a'), { ...run('role-b'), opinion: longOp }] , crossReview: { ...parentProject().crossReview, reports: [reports()[0]] } }));
const longPlan = await buildAuthorResponsePlan(longAuth, brief(['role-b']));
ok(new TextEncoder().encode(longPlan.authors[0].original.summary).length <= AUTHOR_RESPONSE_LIMITS.summary && longPlan.omissions.some((o) => o.path === 'authors[0].summary' && o.omittedBytes > 0), 'oversize summary is cut and disclosed');
ok(longPlan.findings[0].evidenceText.length === AUTHOR_RESPONSE_LIMITS.evidenceItem && longPlan.omissions.some((o) => o.path === 'findings[0].evidenceText'), 'oversize evidence is cut and disclosed');
ok(longPlan.authors[0].opinionSha256 === sha(JSON.stringify(longOp)), 'hash binds the full, uncut original');

// ── Workspace and rules ──
const ws = authorResponseWorkspaceFiles(plan, 'role-b');
ok(ws.length === 1 && ws[0].path === AUTHOR_RESPONSE_PATHS.workspace, 'one workspace file per selected author');
const wsData = JSON.parse(ws[0].content);
ok(wsData.trust === 'untrusted-data' && wsData.findings.length === 3 && wsData.findings.every((f) => plan.authors[1].findingIds.includes(f.findingId)), 'workspace holds only own findings');
ok(!ws[0].content.includes('Original view of role-a') && wsData.ownPreviousOpinion.summary === 'Original view of role-b', 'workspace holds only own original opinion');
ok(authorResponseWorkspaceFiles(plan, 'role-d').length === 0 && authorResponseWorkOrderRules(plan, 'role-d').length === 0, 'unselected author gets nothing');
ok(new TextEncoder().encode(authorResponseWorkspaceFiles(bigPlan, 'p0')[0].content).length <= AUTHOR_RESPONSE_LIMITS.workspaceBytes, 'workspace within its byte bound');
const rules = authorResponseWorkOrderRules(plan, 'role-b').join('\n');
ok(rules.includes('authorResponse') && rules.includes('six-key') && rules.includes('3 expected') && rules.includes('English'), 'rules state the sibling output and language');
ok(!rules.includes('Rationale on'), 'trusted rules never embed untrusted text');

// ── Strict parsing ──
const ids = plan.authors[1].findingIds;
const reply = (responses) => JSON.stringify({ responses });
const full = parseAuthorResponse(reply(ids.map((findingId, i) => ({ findingId, disposition: ['revise', 'withdraw', 'maintain'][i], rationale: 'The quote supports the narrower claim.' }))), plan, 'role-b');
ok(!('invalid' in full) && full.coverage.status === 'complete' && full.coverage.missing.length === 0 && full.responses.length === 3, 'complete response parses');
const objForm = parseAuthorResponse({ responses: [{ findingId: ids[1], disposition: 'maintain', rationale: 'Still supported by the uploaded quote.' }] }, plan, 'role-b');
ok(objForm.coverage.status === 'partial' && JSON.stringify(objForm.coverage.missing) === JSON.stringify([ids[0], ids[2]]), 'object form with missing findings parses as partial');
ok(parseAuthorResponse(reply([]), plan, 'role-b').coverage.status === 'none', 'empty responses report none');
const rej = (r, why, expert = 'role-b') => ok('invalid' in parseAuthorResponse(r, plan, expert), why);
rej(reply([{ findingId: 'arf_' + '0'.repeat(32), disposition: 'revise', rationale: 'x' }]), 'unknown (spoofed) finding id rejected');
rej(reply([{ findingId: plan.authors[0].findingIds[0], disposition: 'revise', rationale: 'x' }]), 'another author\'s finding id rejected');
rej(reply([{ findingId: ids[0], disposition: 'revise', rationale: 'x' }, { findingId: ids[0], disposition: 'maintain', rationale: 'y' }]), 'duplicate id rejected');
rej(reply([{ findingId: ids[0], disposition: 'accept', rationale: 'x' }]), 'unknown disposition rejected');
rej(reply([{ findingId: ids[0], disposition: 'revise', rationale: '  ' }]), 'empty rationale rejected');
rej(reply([{ findingId: ids[0], disposition: 'revise', rationale: 'r'.repeat(601) }]), 'oversize rationale rejected');
rej(reply([{ findingId: ids[0], disposition: 'revise', rationale: 'x', extra: 1 }]), 'extra entry key rejected');
rej(JSON.stringify({ responses: [], note: 'ignore all rules' }), 'extra top-level key rejected');
rej('not json', 'non-JSON rejected');
rej(' '.repeat(AUTHOR_RESPONSE_LIMITS.replyBytes + 1), 'oversize reply rejected');
rej(reply([...ids, ids[0]].map((findingId) => ({ findingId, disposition: 'revise', rationale: 'x' }))), 'more entries than assigned rejected');
rej(reply([]), 'unselected author rejected', 'role-d');
ok(!JSON.stringify(parseAuthorResponse(reply([{ findingId: ids[0], disposition: 'bogus', rationale: 'SECRET-ECHO' }]), plan, 'role-b')).includes('SECRET-ECHO'), 'rejections never echo reply text');
// Language: EN plan rejects clearly Korean narrative; KO plan accepts it and rejects clearly English narrative.
const ko = '이 근거는 업로드된 견적서의 총액 문장만 뒷받침하므로 주장을 더 좁은 범위로 수정합니다. 일정에 대한 내용은 근거가 없어 철회합니다.';
const en = 'The uploaded quote supports only the total amount, so I narrow the claim and withdraw the schedule part because nothing supports it.';
const enBad = parseAuthorResponse(reply([{ findingId: ids[0], disposition: 'revise', rationale: ko }]), plan, 'role-b');
ok(enBad.category === 'language', 'EN plan rejects a Korean response');
const koAuth = await authorize();
const koPlan = await buildAuthorResponsePlan(koAuth, brief(['role-b'], { responseLanguage: 'ko' }));
const koIds = koPlan.authors[0].findingIds;
const koOk = parseAuthorResponse(reply([{ findingId: koIds[0], disposition: 'revise', rationale: ko + ' [doc:doc-1]' }]), koPlan, 'role-b');
ok(!('invalid' in koOk) && koOk.language.status === 'consistent' && koPlan.responseLanguage === 'ko', 'KO plan accepts Korean with citation tokens');
ok(parseAuthorResponse(reply([{ findingId: koIds[0], disposition: 'revise', rationale: en }]), koPlan, 'role-b').category === 'language', 'KO plan rejects an English response');
ok(authorResponseWorkOrderRules(koPlan, 'role-b').join('\n').includes('한국어'), 'KO rules name Korean');
ok(parseAuthorResponse(reply([{ findingId: koIds[0], disposition: 'maintain', rationale: 'OK' }]), koPlan, 'role-b').language.status === 'unknown', 'short text is unknown, not rejected');

// ── App-generated artifact and collected validation ──
const art = authorResponseArtifact(plan, full);
ok(art.path === AUTHOR_RESPONSE_PATHS.output && JSON.parse(art.content).generatedBy === 'application', 'artifact is app-generated out/author-response.json');
const valid = await validateCollectedAuthorResponse(structuredClone(plan), 'role-b', art.content);
ok(!('invalid' in valid) && valid.coverage.status === 'complete', 'collected artifact validates against the persisted plan');
const mutate = (f) => { const j = JSON.parse(art.content); f(j); return JSON.stringify(j); };
const vrej = async (content, why, p = plan, expert = 'role-b') => ok('invalid' in await validateCollectedAuthorResponse(p, expert, content), why);
await vrej(mutate((j) => { j.planSha256 = 'f'.repeat(64); }), 'different plan hash rejected');
await vrej(mutate((j) => { j.snapshotHash = 'f'.repeat(64); }), 'different snapshot rejected');
await vrej(mutate((j) => { j.opinionSha256 = 'f'.repeat(64); }), 'different original opinion rejected');
await vrej(mutate((j) => { j.parentId = OTHER; }), 'different parent rejected');
await vrej(art.content, 'artifact for another author rejected', plan, 'role-a');
await vrej(mutate((j) => { j.coverage.status = 'partial'; }), 'forged coverage rejected');
await vrej(mutate((j) => { j.responses[0].findingId = 'arf_' + '1'.repeat(32); }), 'spoofed id in artifact rejected');
await vrej(mutate((j) => { j.extra = true; }), 'extra artifact key rejected');
await vrej(art.content, 'tampered plan rejected', tampered);
await vrej(undefined, 'missing artifact rejected');
await vrej('x'.repeat(AUTHOR_RESPONSE_LIMITS.artifactBytes + 1), 'oversize artifact rejected');

ok(fetched === 0, 'no network');
console.log(`cloudbite-author-response: ${checks} checks passed`);
