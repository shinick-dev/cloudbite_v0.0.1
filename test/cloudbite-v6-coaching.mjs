// Cloudbite v6 project coaching: opt-in coaching mode on the existing single memo call. Rough briefs without options get
// a memo plus a strictly parsed, attributed coaching object (generated advice, never adopted); legacy memos keep their
// byte-identical prompt, snapshot and parser. Pure module test, no provider calls.
// Run: node test/cloudbite-v6-coaching.mjs
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** Base revision (coaching contract types only): the byte-identity reference for legacy prompts and snapshots. */
const BASE = 'fd8c4abf30ce69df52e386015dd8b2ba7b35835a';
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
const deepFreeze = (o) => { if (o && typeof o === 'object') { Object.values(o).forEach(deepFreeze); Object.freeze(o); } return o; };
const clone = (o) => JSON.parse(JSON.stringify(o));

// ── fixtures: a thin English brief with no decision frame at all, and an ordinary brief with options ──
const ids = ['role-a', 'role-b', 'role-c'];
const opinion = (id, direction) => ({ direction, confidence: 60, summary: `Original view of ${id}: the clinic intake app could work if scoped to one clinic first.`,
  evidence: ['[doc:doc-1] Intake takes 20 minutes today per the notes', 'Staff interviews mention paper forms'], assumptions: ['Clinic staff will try a tablet'], nextActions: ['Interview two receptionists'] });
const thinBrief = { title: 'Clinic intake idea', objective: 'Build something that makes clinic intake faster.', context: '', expertIds: ids, mode: 'live', requestId: 'v6-thin',
  documents: [{ id: 'doc-1', name: 'notes', content: 'Intake takes 20 minutes today.' }] };
const completed = [opinion('role-a', 'support'), opinion('role-b', 'concern'), opinion('role-c', 'conditional')].map((o, i) => ({ expertId: ids[i], name: 'Role ' + ids[i], opinion: o }));
const optionBrief = { ...thinBrief, requestId: 'v6-options',
  decision: { options: ['Tablet check-in', 'SMS pre-visit form'], constraints: ['One clinic'], successCriteria: [], knownFacts: [], assumptions: [], unknowns: ['Staff tablet comfort'] } };
const C = { coaching: true };

// ── legacy behavior unchanged ──
{
  ok(m.memoPlan(thinBrief, completed).kind === 'needs-options' && m.memoPlan(thinBrief, completed, { coaching: false }).kind === 'needs-options', 'legacy: thin brief without options still needs options');
  const n = m.memoMessages(thinBrief, completed);
  ok(n.kind === 'needs-options' && n.snapshot === base.memoMessages(thinBrief, completed).snapshot, 'legacy needs-options result and snapshot identical to base');
  for (const [name, b, o] of [['options', optionBrief, {}], ['options+reviews', optionBrief, { reviews: [{ reviewerExpertId: 'role-a', summary: 's', findings: [{ targetExpertId: 'role-b', evidenceIndex: 0, verdict: 'challenged', rationale: 'r' }] }] }]]) {
    const now = m.memoMessages(b, completed, o), then = base.memoMessages(b, completed, o);
    ok(JSON.stringify(now) === JSON.stringify(then) && !('mode' in now), `legacy ${name}: whole prompt object byte-identical to base, no mode key`);
    ok(JSON.stringify(m.memoMessages(b, completed, { ...o, coaching: false })) === JSON.stringify(then), `legacy ${name}: coaching:false equals omitted`);
  }
  ok(m.memoSnapshot(optionBrief, completed) === base.memoSnapshot(optionBrief, completed), 'legacy snapshot identical to base (old saved snapshots stay current)');
}

// ── coaching plan, prompt and snapshot separation ──
const thinPrompt = m.memoMessages(thinBrief, completed, C);
{
  const plan = m.memoPlan(thinBrief, completed, C);
  ok(plan.kind === 'ready' && plan.optionIds.length === 0, 'coaching: thin brief without a decision frame is ready with no option ids');
  ok(m.memoPlan(thinBrief, [], C).kind === 'no-opinions', 'coaching: still needs finished opinions');
  ok(thinPrompt.kind === 'prompt' && thinPrompt.mode === 'coaching' && thinPrompt.allowed.optionIds.length === 0 && thinPrompt.allowed.optionTexts.length === 0, 'coaching prompt: mode set, no fabricated option ids');
  ok(thinPrompt.maxTokens === m.CB_MEMO_MAX_TOKENS && m.CB_MEMO_MAX_ATTEMPTS === 1, 'same single memo call budget');
  const sys = thinPrompt.messages[0].content, data = dataOf(thinPrompt);
  ok(sys.includes('"coaching": {"version": "cloudbite-coaching/v1"') && sys.includes('GENERATED ADVICE THE USER HAS NOT ADOPTED') && sys.includes('options must be []'), 'coaching system: schema, unadopted standing, no-option rule');
  ok(sys.includes('missing evidence is NOT evidence against') && sys.includes('not to encourage') && sys.includes('hard numeric thresholds'), 'coaching system: no-cheerleading, missing-evidence and numeric-gate rules');
  ok(!sys.includes('Option ids are option-1..N'), 'coaching system without options drops the option-id line');
  ok(data.mode === 'project-coaching' && data.brief.options.length === 0 && ['constraints', 'successCriteria', 'knownFacts', 'assumptions', 'unknowns'].every((f) => Array.isArray(data.brief[f]) && !data.brief[f].length), 'missing decision lists default to empty');
  const withOptions = m.memoMessages(optionBrief, completed, C);
  ok(withOptions.messages[0].content.includes('Option ids are option-1..N') && withOptions.allowed.optionIds.join() === 'option-1,option-2', 'coaching with options keeps the option comparison');
  const legacySnap = m.memoSnapshot(optionBrief, completed), coachSnap = m.memoSnapshot(optionBrief, completed, C);
  ok(legacySnap !== coachSnap && JSON.parse(coachSnap).mode === 'coaching' && !('mode' in JSON.parse(legacySnap)), 'snapshot carries the mode only in coaching mode');
  ok(!m.isMemoSnapshotCurrent(legacySnap, optionBrief, completed, C) && !m.isMemoSnapshotCurrent(coachSnap, optionBrief, completed) && m.isMemoSnapshotCurrent(coachSnap, optionBrief, completed, C), 'legacy and coaching memos never share a snapshot');
  // a partial decision frame (missing lists) no longer throws
  const partial = { ...thinBrief, decision: { options: [] } };
  ok(m.memoMessages(partial, completed, C).kind === 'prompt', 'partial decision frame defaults safely');
}

// ── good parse fixture (also documented in docs/cloudbite/project-coaching.md) ──
const claim = (text, expertIds = [], refs = []) => ({ text, expertIds, refs });
const goodCoaching = () => ({
  version: 'cloudbite-coaching/v1', stance: 'clarify-first',
  viablePath: claim('Narrow the idea to a paper-form replacement for one clinic and test it with front-desk staff first.', ['role-a', 'role-c'], ['doc:doc-1']),
  repairs: [
    { issue: claim('No supplied material says which clinic or which intake step is slowest.', [], ['brief:objective']), kind: 'unknown', priority: 'now',
      change: claim('Pick one clinic and map its current intake steps.'), check: claim('A written step list with the slowest step marked.'), decisionTrigger: claim('If the slowest step is not the form, rework the objective.') },
    { issue: claim('role-b raised a concern that staff may resist new devices.', ['role-b']), kind: 'adverse-evidence', priority: 'next',
      change: claim('Offer a paper fallback during the trial.'), check: claim('Ask staff after the first week whether they kept using it.'), decisionTrigger: claim('If staff stop using it, pause and revisit the device choice.') },
  ],
  revisedProject: { objective: claim('Shorten intake at one clinic by replacing its paper form.', [], ['brief:objective']),
    scope: claim('One clinic, one form, front-desk use only; patient-facing features are out of scope for now (tradeoff: less reach, faster learning).'),
    nextMilestone: claim('A clickable form prototype reviewed by two receptionists.') },
  questions: [claim('Which clinic can host a first trial?'), claim('Is the slow part the form itself or waiting for staff?')],
});
const goodReply = () => ({
  summary: 'Three of three selected experts finished. Directions differ: one support, one concern, one conditional. No decision options were listed, so no option is recommended.',
  recommendation: { status: 'no-recommendation', optionIds: [], rationale: 'The brief lists no options to compare; a scoped trial question must be answered first.', expertIds: ['role-b'], refs: ['brief:objective'] },
  options: [], dissent: [claim('role-b is concerned that staff may resist new devices.', ['role-b'])],
  criticalUnknowns: [claim('Which intake step is slowest is not stated.', [], ['doc:doc-1'])],
  changeTriggers: [claim('A clinic agreeing to host a trial would make a concrete plan possible.')],
  nextActions: [claim('Pick one clinic and map its intake steps.'), claim('Interview two receptionists about the paper form.', ['role-a'])],
  coaching: goodCoaching(),
});
const parse = (reply, p = thinPrompt, hooks) => m.parseMemoReply(typeof reply === 'string' ? reply : JSON.stringify(reply), p, hooks);
{
  const r = parse(goodReply());
  ok(!('invalid' in r), 'good coaching fixture parses: ' + r.invalid);
  const c = r.memo.coaching;
  ok(c.version === m.CB_COACHING_VERSION && c.stance === 'clarify-first' && c.repairs.length === 2 && c.questions.length === 2, 'coaching shape preserved');
  ok(c.viablePath.refs[0].kind === 'document' && c.viablePath.refs[0].id === 'doc-1' && c.repairs[0].issue.refs[0].kind === 'brief' && c.repairs[0].issue.refs[0].field === 'objective', 'raw ref strings become typed references');
  ok(r.memo.recommendation.status === 'no-recommendation' && r.memo.recommendation.optionIds.length === 0 && r.memo.comparison.length === 0, 'no-option memo: no recommendation, no comparison');
  ok(r.memo.basis === 'derived-interpretation' && r.memo.confidence === 'not-calibrated' && m.CB_COACHING_STANDING === 'generated-proposal-not-adopted', 'fixed basis/confidence labels and unadopted standing');
  ok(m.memoNarrative(r.memo).includes(c.revisedProject.scope.text) && m.memoNarrative(r.memo).includes(c.repairs[1].decisionTrigger.text), 'memoNarrative includes coaching narratives');
  const doc = (await import('node:fs')).readFileSync(path.join(repo, 'docs/cloudbite/project-coaching.md'), 'utf8');
  const docFixture = JSON.parse(doc.split('```json\n')[1].split('\n```')[0]);
  ok(JSON.stringify(docFixture) === JSON.stringify(goodReply()) && !('invalid' in parse(docFixture)), 'documented UI fixture equals the tested good reply and parses');
  const zero = goodReply(); zero.coaching = { ...goodCoaching(), stance: 'proceed-with-scope', repairs: [], questions: [] };
  ok(!('invalid' in parse(zero)), 'zero repairs and zero questions allowed');
  // stored transitions carry the coaching object; a legacy stored memo needs none
  const running = m.runningMemo(thinPrompt, 'h'.repeat(64), 1), done = m.completedMemo(running, r, 2);
  ok(done.status === 'completed' && done.memo.coaching.stance === 'clarify-first', 'completed stored memo keeps coaching');
  // with options: recommending an option still works in coaching mode
  const op = m.memoMessages(optionBrief, completed, C);
  const rec = { ...goodReply(), recommendation: { status: 'recommend', optionIds: ['option-2'], rationale: 'The SMS form needs no new device, which answers role-b\'s concern.', expertIds: ['role-b'], refs: [] },
    options: [{ optionId: 'option-1', benefits: [], risks: [claim('Needs staff to adopt tablets.', ['role-b'])], conditions: [] }, { optionId: 'option-2', benefits: [claim('Uses phones patients already have.')], risks: [], conditions: [] }] };
  const rr = parse(rec, op);
  ok(!('invalid' in rr) && rr.memo.recommendation.options[0].text === 'SMS pre-visit form' && rr.memo.coaching, 'coaching with options: recommendation and coaching both parsed');
}

// ── strict rejection: no silent omission, malformed or out-of-scope coaching rejects the whole memo ──
const bad = (name, mutate, p = thinPrompt, re) => {
  const reply = goodReply(); mutate(reply);
  const r = parse(reply, p);
  ok('invalid' in r && (!re || re.test(r.invalid)), `${name} rejected (${r.invalid})`);
};
bad('missing coaching in coaching mode', (r) => { delete r.coaching; }, thinPrompt, /missing its coaching/);
bad('null coaching', (r) => { r.coaching = null; });
bad('coaching array', (r) => { r.coaching = [goodCoaching()]; });
bad('coaching on a legacy prompt', () => {}, m.memoMessages(optionBrief, completed), /memo schema/);
bad('wrong version', (r) => { r.coaching.version = 'cloudbite-coaching/v2'; });
bad('unknown stance', (r) => { r.coaching.stance = 'go'; });
bad('extra coaching key', (r) => { r.coaching.confidence = 0.8; });
bad('missing questions key', (r) => { delete r.coaching.questions; });
bad('repair kind invalid', (r) => { r.coaching.repairs[0].kind = 'risk'; });
bad('repair priority invalid', (r) => { r.coaching.repairs[0].priority = 'urgent'; });
bad('repair extra key', (r) => { r.coaching.repairs[0].owner = 'role-a'; });
bad('repairs out of priority order', (r) => { r.coaching.repairs[0].priority = 'later'; }, thinPrompt, /ordered/);
bad('four repairs', (r) => { r.coaching.repairs = [0, 1, 2, 3].map((i) => ({ ...goodCoaching().repairs[0], issue: claim('Unknown ' + i, [], ['brief:objective']) })); });
bad('four questions', (r) => { r.coaching.questions = [0, 1, 2, 3].map((i) => claim('Question ' + i + '?')); });
bad('duplicate questions', (r) => { r.coaching.questions = [claim('Same?'), claim('same?')]; });
bad('duplicate repair', (r) => { r.coaching.repairs[1] = { ...r.coaching.repairs[0], priority: 'next' }; }, thinPrompt, /repeats/);
bad('revisedProject extra key', (r) => { r.coaching.revisedProject.budget = claim('10k'); });
bad('revisedProject missing milestone', (r) => { delete r.coaching.revisedProject.nextMilestone; });
bad('null viablePath', (r) => { r.coaching.viablePath = null; });
bad('viablePath cites nothing', (r) => { r.coaching.viablePath = claim('Just build it.'); }, thinPrompt, /cites no expert/);
bad('repair issue cites nothing', (r) => { r.coaching.repairs[0].issue = claim('Something is unclear.'); }, thinPrompt, /cites no expert/);
{
  const p = m.memoMessages({ ...optionBrief, decision: { ...optionBrief.decision, options: [] } }, completed, C), reply = goodReply();
  reply.coaching.repairs[1].issue = claim('Staff tablet comfort is unknown.', [], ['brief:unknowns']);
  const r = parse(reply, p);
  ok('invalid' in r && /adverse-evidence/.test(r.invalid), 'adverse-evidence citing only brief:unknowns rejected (missing evidence is not evidence against)');
}
bad('foreign expertId', (r) => { r.coaching.viablePath.expertIds = ['role-z']; }, thinPrompt, /not supplied/);
bad('out-of-scope ref', (r) => { r.coaching.repairs[0].check.refs = ['ev:role-a:9']; }, thinPrompt, /not supplied/);
bad('malformed ref', (r) => { r.coaching.revisedProject.scope.refs = ['source:PROJECT.md']; });
bad('null refs', (r) => { r.coaching.questions[0].refs = null; });
bad('refs overlist', (r) => { r.coaching.viablePath.refs = Array(7).fill('doc:doc-1'); });
bad('expertIds overlist', (r) => { r.coaching.viablePath.expertIds = Array(9).fill('role-a'); });
bad('claim text too long', (r) => { r.coaching.revisedProject.objective.text = 'x'.repeat(m.CB_MEMO_COACHING_LIMITS.claim + 1); });
bad('empty claim text', (r) => { r.coaching.repairs[0].change.text = '  '; });
bad('pause without a repair', (r) => { r.coaching.stance = 'pause'; r.coaching.repairs = []; }, thinPrompt, /no repair/);
bad('clarify-first without a question', (r) => { r.coaching.questions = []; }, thinPrompt, /no question/);
bad('fabricated option id with no options', (r) => { r.recommendation = { ...r.recommendation, status: 'recommend', optionIds: ['option-1'] }; });
bad('fabricated option comparison with no options', (r) => { r.options = [{ optionId: 'option-1', benefits: [claim('b')], risks: [], conditions: [] }]; });
bad('coaching-mode summary over the tighter cap', (r) => { r.summary = 'x'.repeat(m.CB_MEMO_COACHING_LIMITS.summary + 1); });
bad('coaching-mode list over the tighter cap', (r) => { r.nextActions = [0, 1, 2, 3, 4].map((i) => claim('Action ' + i)); });
ok('invalid' in parse('x'.repeat(m.CB_MEMO_LIMITS.reply + 1)), 'reply over 8000 characters rejected');

// ── fake consensus and language checks cover coaching narratives ──
bad('consensus in viablePath', (r) => { r.coaching.viablePath.text = 'All experts agreed the clinic trial is the right path.'; }, thinPrompt, /vote or consensus/);
bad('consensus in a question', (r) => { r.coaching.questions[0].text = 'Since consensus was reached, which clinic goes first?'; }, thinPrompt, /vote or consensus/);
bad('past vote in a repair change', (r) => { r.coaching.repairs[0].change.text = 'Follow what the experts voted for last week.'; }, thinPrompt, /vote or consensus/);
{
  const r = goodReply(); r.coaching.repairs[0].decisionTrigger.text = 'Hold a staff vote after the first week to decide whether to continue.';
  ok(!('invalid' in parse(r)), 'a proposed future vote in a decisionTrigger stays allowed');
  const n = goodReply(); n.coaching.viablePath.text = 'No consensus exists; the path rests on role-a and role-c readings of the notes.';
  ok(!('invalid' in parse(n)), 'an honest absence-of-consensus statement stays allowed');
}
{
  const ko = { ...thinBrief, objective: '병원 접수를 빠르게 만드는 무언가를 만든다.', responseLanguage: 'ko' };
  const kp = m.memoMessages(ko, completed, C);
  ok(kp.language === 'ko' && kp.messages[0].content.includes('한국어'), 'Korean coaching prompt');
  const r = goodReply();
  // Korean memo fields stay short Korean; the coaching narratives are English and alone tip the script check to mismatch.
  r.summary = '옵션 없음.'; r.recommendation.rationale = '범위 먼저.';
  r.dissent = [claim('반발 우려.', ['role-b'])]; r.criticalUnknowns = [claim('단계 미상.', [], ['doc:doc-1'])];
  r.changeTriggers = [claim('병원 결정.')]; r.nextActions = [claim('병원 선택.')];
  const lang = parse(r, kp);
  ok('invalid' in lang && lang.category === 'language', 'English coaching narratives in a Korean memo are caught by the language check');
  const kc = goodCoaching(), ko2 = (c) => ({ ...c, text: '한국어로 쓴 코칭 문장이며 근거는 제공된 자료에 있다.' + c.text.length });
  kc.viablePath = ko2(kc.viablePath); kc.repairs = kc.repairs.map((x) => ({ ...x, issue: ko2(x.issue), change: ko2(x.change), check: ko2(x.check), decisionTrigger: ko2(x.decisionTrigger) }));
  kc.revisedProject = { objective: ko2(kc.revisedProject.objective), scope: ko2(kc.revisedProject.scope), nextMilestone: ko2(kc.revisedProject.nextMilestone) }; kc.questions = kc.questions.map(ko2);
  const kr = parse({ ...r, coaching: kc }, kp);
  ok(!('invalid' in kr) && kr.language === 'ko', 'Korean coaching narratives pass: ' + kr.invalid);
  ok(m.defaultMemoLanguageCheck({ ...parse(goodReply()).memo }, 'en') === null, 'English fixture passes the English language check');
}

// ── immutable full inputs ──
{
  const b = deepFreeze(clone(optionBrief)), c = deepFreeze(clone(completed));
  const o = deepFreeze({ coaching: true, reviews: [{ reviewerExpertId: 'role-a', summary: 's', findings: [{ targetExpertId: 'role-b', evidenceIndex: 0, verdict: 'challenged', rationale: 'r' }] }],
    packets: [{ id: 'pkt-1', kind: 'source-excerpt', label: 'l', text: 't' }], team: ids.map((expertId) => ({ expertId, name: expertId, status: 'completed' })), provenance: { snapshot: 'a'.repeat(64), text: 'p' } });
  const before = JSON.stringify([b, c, o]);
  const p = m.memoMessages(b, c, o);
  ok(p.kind === 'prompt' && JSON.stringify([b, c, o]) === before, 'frozen inputs read, never mutated');
  const reply = deepFreeze(goodReply());
  const rr = m.parseMemoReply(JSON.stringify(reply), thinPrompt);
  ok(!('invalid' in rr) && rr.memo.coaching !== reply.coaching, 'parsed coaching is a new object');
}

// ── maximum-shaped 100-role Korean project with large reviews, coaching on: prompt stays within the bound ──
{
  const fill = (n) => '가'.repeat(n), many = Array.from({ length: 100 }, (_, i) => 'role-' + i);
  const heavyOpinion = () => ({ direction: 'conditional', confidence: 55, summary: fill(2000), evidence: Array(12).fill(fill(580) + ' [source:PROJECT.md]'),
    assumptions: Array(12).fill(fill(600)), nextActions: Array(12).fill(fill(600)) });
  const heavyBrief = { title: fill(100), objective: fill(2000), context: fill(8000), mode: 'live', expertIds: many, requestId: 'v6-heavy', stage: 'design', responseLanguage: 'ko',
    documents: Array.from({ length: 6 }, (_, i) => ({ id: 'doc-' + (i + 1), name: '문서' + i, content: fill(4000) })),
    decision: Object.fromEntries(['options', 'constraints', 'successCriteria', 'knownFacts', 'assumptions', 'unknowns'].map((k) => [k, Array.from({ length: 8 }, (_, i) => i + fill(299))])) };
  const heavyCompleted = many.map((id) => ({ expertId: id, name: id, opinion: heavyOpinion() }));
  const quote = fill(300);
  const assessment = { status: 'partial', quotes: Array.from({ length: 3 }, (_, i) => ({ passageId: 'p' + (i + 1), ref: 'source:PROJECT.md', textOrigin: 'workspace-field', quote,
    sourceSha256: 'a'.repeat(64), startOffset: i * 300, endOffset: (i + 1) * 300, startLine: 1, endLine: 1 })),
    rationale: fill(400), basis: 'model-assessment', quoteCheck: 'exact-substring', citedText: 'available', packetSha256: 'b'.repeat(64) };
  const reviews = many.slice(0, 3).map((reviewerExpertId) => ({ reviewerExpertId, summary: fill(600),
    findings: [0, 1, 2].map((i) => ({ targetExpertId: many[3 + i], evidenceIndex: i, verdict: 'supported', rationale: fill(500), claimSupport: assessment })),
    claimFindings: [0, 1, 2].map((i) => ({ targetExpertId: many[3 + i], target: { kind: 'summary', index: 0, quote }, verdict: 'challenged', issue: 'unsupported-premise', rationale: fill(500) })) }));
  const packets = Array.from({ length: 8 }, (_, i) => ({ id: 'pkt-' + i, kind: 'source-excerpt', label: fill(120), text: fill(3000) }));
  const opts = { reviews, packets, provenance: { snapshot: 'c'.repeat(64), text: fill(2700) } };
  for (const [name, b] of [['with options', heavyBrief], ['without a decision frame', { ...heavyBrief, decision: undefined }]]) {
    const p = m.memoMessages(b, heavyCompleted, { ...opts, coaching: true });
    ok(p.kind === 'prompt' && p.coverage.promptBytes <= m.CB_MEMO_PROMPT_MAX_BYTES && p.coverage.promptBytes === p.messages.reduce((n, x) => n + bytes(x.content), 0), `heavy coaching ${name}: within 160 KiB (${p.coverage.promptBytes})`);
    ok(p.coverage.teamSize === 100 && dataOf(p).experts.length === 100 && p.coverage.sourceAssessments.assessed === 9 && p.coverage.coreClaims.total === 9, `heavy coaching ${name}: all experts and review annotations present`);
  }
  const legacy = m.memoMessages(heavyBrief, heavyCompleted, opts), coach = m.memoMessages(heavyBrief, heavyCompleted, { ...opts, coaching: true });
  ok(bytes(JSON.stringify(dataOf(coach).experts)) < bytes(JSON.stringify(dataOf(legacy).experts)), 'coaching reserve comes out of the expert section');
}

ok(fetched === 0, 'no network or provider calls');
console.log(`cloudbite-v6-coaching: ${checks} checks passed`);
