// Cloudbite 콘솔 v6 코칭 화면 (src/cloudbite-page.ts 의 CLOUDBITE_JS) 을 브라우저 없이 고정한다:
// (1) 브리프 도우미 — 브라우저 안 규칙 기반 질문 세 개, 미리 보기 → Apply 로만 맥락 끝에 이름표 묶음을 더하고, KO/EN 전환에도 답·미리 보기가 남으며,
//     미리 본 뒤 브리프가 바뀌면 적용할 수 없다. 모델·서버 요청이 없다.
// (2) memo.coaching — 정확한 열쇠·고정 값·상한만 받고, 틀리면 메모는 그대로 두고 그 칸만 읽을 수 없다고 밝힌다. 옛 메모·선택지 없는 메모·옛 needs-options.
// (3) 수정 제안을 다음 라운드 초안으로 — 실행·채택 없이 목표·범위·이정표만 옮기고, 알려진 사실·역할·부모는 그대로.
// (4) 종합 한 줄은 방향 분포만 설명한다 (개수 = 결정의 질·합의가 아님).
// 작은 가짜 DOM 이다. 실제 브라우저·서버·공급자 증거가 아니다.
//   node tools/build-cloudbite-console.mjs && node test/cloudbite-v6-coaching-ui.mjs
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { CLOUDBITE_JS } from '../src/cloudbite-page.ts';

let pass = 0;
const test = async (name, fn) => { await fn(); pass++; console.log(`  ok   ${name}`); };
const plain = (v) => JSON.parse(JSON.stringify(v));
let core = null;
vm.runInContext(CLOUDBITE_JS, vm.createContext({ __cloudbiteTestHook: (c) => { core = c; }, crypto: globalThis.crypto }));
assert.ok(core);
const EN = core.DICT.en, KO = core.DICT.ko;

// ───────── 고정 자료
const PARENT = 'cb' + 'b'.repeat(32);
const claim = (text, expertIds = ['x1'], refs = []) => ({ text, expertIds, refs });
const COACHING = {
  version: 'cloudbite-coaching/v1', stance: 'clarify-first',
  viablePath: claim('Start with one paid pilot team before building the full room.', ['x1', 'x2']),
  repairs: [
    { issue: claim('Willingness to pay is unknown.', ['x2']), kind: 'unknown', priority: 'now', change: claim('Charge the pilot team a token fee.'),
      check: claim('Ask five teams to pre-pay.', ['x2'], [{ kind: 'brief', field: 'context' }]), decisionTrigger: claim('Fewer than two pre-pay → pause.') },
    { issue: claim('Support load grows with each role.', ['x2']), kind: 'adverse-evidence', priority: 'next', change: claim('Cap the pilot at 10 roles.'),
      check: claim('Count support tickets in week one.'), decisionTrigger: claim('More than 20 tickets a week → narrow scope.') },
  ],
  revisedProject: { objective: claim('Decide within 2 weeks whether one paid pilot team will use a 10-role advisory room.'),
    scope: claim('One pilot team, 10 roles, no data upload.'), nextMilestone: claim('Five pre-pay conversations completed.') },
  questions: [claim('Who signs off the pilot fee?'), claim('Which 10 roles matter most to the pilot team?')],
};
const DMEMO = (over = {}) => ({ summary: 'The brief is thin; narrow it before scaling.',
  recommendation: { status: 'no-recommendation', optionIds: [], options: [], rationale: 'No options to compare.', expertIds: [], refs: [] },
  comparison: [], dissent: [claim('Expert 2 doubts demand.', ['x2'])], criticalUnknowns: [claim('Price sensitivity.', [])], changeTriggers: [], nextActions: [claim('Run five calls.', ['x1'])],
  basis: 'derived-interpretation', confidence: 'not-calibrated', ...over });
const MEMO = (memo) => ({ version: 'cloudbite-memo/v1', status: 'completed', attempts: 1, execution: 'server-nosana', startedAt: 5, completedAt: 6, language: 'en', memo });
const opinion = (direction, confidence) => ({ direction, confidence, summary: `Summary ${direction}`, evidence: ['E'], assumptions: ['A1'], nextActions: ['Pilot'] });
const experts = () => [
  { id: 'run-0', expertId: 'x1', name: 'Expert 1', status: 'completed', activity: [], artifacts: [], updatedAt: 2, opinion: opinion('support', 70) },
  { id: 'run-1', expertId: 'x2', name: 'Expert 2', status: 'completed', activity: [], artifacts: [], updatedAt: 2, opinion: opinion('concern', 55) },
];
const BRIEF = { title: 'AI advisory room', objective: 'Launch an AI advisory room?', context: 'Startup teams.', expertIds: ['x1', 'x2'], mode: 'live', requestId: 'parent-req',
  decision: { options: [], constraints: ['4 weeks'], successCriteria: [], knownFacts: ['We have 3 design partners'], assumptions: [], unknowns: [] } };
const parentRaw = (memo, brief = BRIEF) => ({ id: PARENT, status: 'completed', createdAt: 1, updatedAt: 3, brief, experts: experts(), ...(memo ? { memo } : {}) });

await test('사전: p6 의 EN·KO 열쇠가 같고, 제안·로컬 도우미라고 밝히며 점수·합의를 말하지 않는다', () => {
  assert.deepEqual(Object.keys(KO.p6).sort(), Object.keys(EN.p6).sort());
  for (const k of ['q', 'qHint', 'qLabel', 'stance', 'kind', 'priority']) assert.deepEqual(Object.keys(KO.p6[k]).sort(), Object.keys(EN.p6[k]).sort(), k);
  assert.match(EN.p6.helperNote, /No model call/); assert.match(KO.p6.helperNote, /모델 호출이 없/);
  assert.match(EN.p6.badge, /not adopted or validated/); assert.match(KO.p6.badge, /채택·검증되지 않음/);
  // 메모 단추는 새 이점(개선안)을 드러내고, 설명은 한 번 호출·해석·원문 보존 사실을 그대로 둔 채 범위 제안·보완책을 말한다
  assert.equal(EN.p2.memoBtn, 'Build project improvement plan (1 model call)'); assert.equal(KO.p2.memoBtn, '프로젝트 개선안 만들기 (모델 호출 1회)');
  assert.match(EN.p2.memoExplain, /one server-side Nosana call.*revised scope and concrete repairs.*derived interpretation.*original opinions stay unchanged/i);
  assert.match(KO.p2.memoExplain, /호출 한 번.*수정된 범위 제안과 구체적인 보완책.*해석.*원래 의견은 바뀌지 않습니다/);
  assert.ok(!/\d+\s*(%|\/\s*10|points?)/.test(JSON.stringify(EN.p6)), 'no numeric score wording');
  for (const D of [EN, KO]) for (const k of ['hTie', 'hSupport', 'hConditional', 'hConcern', 'hAbstain']) {
    assert.ok(/not decision quality or consensus|결정의 질이나 합의가 아닙니다/.test(D[k]), `${k} is neutral`);
    assert.ok(!/move straight|do not expand|바로 넘어가|확장하지 마세요/.test(D[k]), `${k} gives no fixed judgment`);
  }
});

await test('aggregate: 방향 분포만 설명하고 통계(개수·평균·부분 기준)는 그대로', () => {
  const p = core.normalizeProject(parentRaw(null));
  const a = core.aggregate(p, EN);
  assert.equal(a.valid, 2); assert.equal(a.meanConfidence, 63); assert.deepEqual(plain(a.counts), { support: 1, conditional: 0, concern: 1, abstain: 0 });
  assert.equal(a.headline, EN.hTie); assert.match(a.headline, /evenly split/);
  const one = core.normalizeProject({ ...parentRaw(null), experts: [experts()[0], { ...experts()[1], status: 'failed', opinion: undefined, error: 'x' }] });
  assert.equal(core.aggregate(one, KO).headline, KO.hPartial(KO.hSupport, 1, 2));
  assert.ok(core.markdownReport(p, false, EN).includes(EN.hTie), 'export keeps the same neutral line');
});

await test('normalizeMemo: 올바른 coaching 은 값 그대로, 옛 메모는 그대로, 틀린 coaching 은 메모를 남기고 invalidCoaching 으로 밝힌다', () => {
  const ok = MEMO(DMEMO({ coaching: COACHING }));
  assert.deepEqual(plain(core.normalizeMemo(ok)), ok);
  const legacy = MEMO(DMEMO());
  assert.deepEqual(plain(core.normalizeMemo(legacy)), legacy, 'legacy memo unchanged, no coaching keys invented');
  const bad = (mut) => { const c = structuredClone(COACHING); mut(c); return core.normalizeMemo(MEMO(DMEMO({ coaching: c }))); };
  const cases = {
    'foreign stance': c => { c.stance = 'go'; }, 'foreign kind': c => { c.repairs[0].kind = 'risk'; }, 'foreign priority': c => { c.repairs[1].priority = 'urgent'; },
    'four repairs': c => { c.repairs.push(c.repairs[0], c.repairs[1]); }, 'four questions': c => { c.questions.push(c.questions[0], c.questions[1]); },
    'extra key': c => { c.score = 0.9; }, 'missing key': c => { delete c.questions; }, 'extra repair key': c => { c.repairs[0].confidence = 80; },
    'missing revised field': c => { delete c.revisedProject.scope; }, 'claim over 200': c => { c.viablePath.text = 'x'.repeat(201); },
    'claim extra key': c => { c.viablePath.confidence = 80; }, 'nine expertIds': c => { c.questions[0].expertIds = Array.from({ length: 9 }, (_, i) => `x${i}`); },
    'seven refs': c => { c.repairs[0].check.refs = Array.from({ length: 7 }, () => ({ kind: 'brief', field: 'context' })); }, 'empty claim': c => { c.questions[0].text = '  '; },
    'bad ref': c => { c.repairs[0].check.refs = [{ kind: 'web', id: 'u' }]; }, 'version': c => { c.version = 'cloudbite-coaching/v2'; },
    'repairs not a list': c => { c.repairs = {}; }, 'claim not an object': c => { c.revisedProject.objective = 'Do it'; },
  };
  for (const [why, mut] of Object.entries(cases)) {
    const n = bad(mut);
    assert.ok(n && n.memo, `${why}: the memo itself stays readable`);
    assert.equal(n.memo.invalidCoaching, true, why); assert.equal(n.memo.coaching, undefined, why);
    assert.equal(n.memo.summary, DMEMO().summary);
  }
  const none = core.normalizeMemo(MEMO(DMEMO({ coaching: null })));
  assert.equal(none.memo.invalidCoaching, true, 'null is not silently ignored');
  assert.equal(core.normalizeMemo(MEMO(DMEMO({ coaching: { ...COACHING, repairs: [], questions: [] } }))).memo.coaching.repairs.length, 0, 'empty lists are allowed');
  // 경계: 코칭 주장 200자·전문가 8명·근거 6개는 받는다. 옛 메모 주장은 280자 상한 그대로(서버 CB_MEMO_LIMITS.claim)이고 코칭 상한이 옮겨 가지 않는다
  const edge = structuredClone(COACHING);
  edge.viablePath = claim('y'.repeat(200), Array.from({ length: 8 }, (_, i) => `x${i}`), Array.from({ length: 6 }, () => ({ kind: 'brief', field: 'context' })));
  const e = core.normalizeMemo(MEMO(DMEMO({ coaching: edge })));
  assert.equal(e.memo.invalidCoaching, undefined, 'coaching claim at the caps is accepted'); assert.equal(e.memo.coaching.viablePath.text.length, 200);
  const legacyLong = core.normalizeMemo(MEMO(DMEMO({ nextActions: [claim('z'.repeat(280), ['x1'])] })));
  assert.equal(legacyLong.memo.nextActions[0].text.length, 280, 'legacy memo claims keep their own path');
});

await test('보고서(EN/KO): 수정 제안을 세부 비판보다 앞에, 제안이라고 밝히고, 원문은 번역하지 않는다. 틀린 칸·선택지 없음·옛 needs-options 도 적는다', () => {
  for (const [M, lang] of [[EN, 'en'], [KO, 'ko']]) {
    const md = core.markdownReport(core.normalizeProject(parentRaw(MEMO(DMEMO({ coaching: COACHING })))), false, M);
    assert.doesNotMatch(md, /undefined|NaN|\[object/, lang);
    const at = (s) => { const i = md.indexOf(s); assert.ok(i >= 0, `${lang}: ${s}`); return i; };
    assert.ok(at(`### ${M.p6.title}`) < at(`### ${M.p2.memoRecommendation}`) && at(`### ${M.p2.memoSummary}`) < at(`### ${M.p6.title}`), `${lang}: order`);
    for (const s of [M.p6.badge, `${M.p6.stanceLabel}: ${M.p6.stance['clarify-first']}`, 'Start with one paid pilot team', `[${M.p6.kind.unknown} · ${M.p6.priority.now}] Willingness to pay is unknown.`,
      `${M.p6.check}: Ask five teams to pre-pay.`, `${M.p6.trigger}: Fewer than two pre-pay → pause.`, `${M.p6.scope}: One pilot team, 10 roles, no data upload.`,
      `${M.p6.milestone}: Five pre-pay conversations completed.`, '1. Who signs off the pilot fee?', M.p6.noOptions, 'Expert 2 doubts demand.'])
      at(s);
  }
  const broken = core.normalizeProject(parentRaw(MEMO(DMEMO({ coaching: { ...COACHING, stance: 'go' } }))));
  const mdb = core.markdownReport(broken, false, KO);
  assert.ok(mdb.includes(KO.p6.invalid) && !mdb.includes(`### ${KO.p6.title}`) && mdb.includes('Expert 2 doubts demand.'));
  const legacy = core.markdownReport(core.normalizeProject(parentRaw(MEMO(DMEMO()))), false, EN);
  assert.ok(!legacy.includes(EN.p6.title) && !legacy.includes(EN.p6.invalid), 'legacy memo export unchanged in shape');
  const old = core.markdownReport(core.normalizeProject(parentRaw({ version: 'cloudbite-memo/v1', status: 'needs-options', attempts: 1, execution: 'none', reason: 'no decision options' })), false, EN);
  assert.ok(old.includes(EN.p2.memoNeedsOptions('no decision options')), 'legacy needs-options still shown');
});

// ───────── 가짜 DOM (cloudbite-workflow-ui.mjs 와 같은 모양)
class Node_ {
  constructor(doc, tag) { this.doc = doc; this.tagName = tag.toUpperCase(); this.children = []; this.attrs = {}; this.listeners = {}; this.parent = null;
    this.className = ''; this._text = ''; this.value = ''; this.checked = false; this.disabled = false; this.hidden = false; this.open = false; this.style = {}; }
  get textContent() { return this._text + this.children.map(c => typeof c === 'string' ? c : c.textContent).join(''); }
  set textContent(v) { this.children = []; this._text = String(v); }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id') this.id = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }
  dispatch(t, ev = {}) { const e = { type: t, target: this, preventDefault() { this.defaultPrevented = true; }, ...ev }; for (const f of this.listeners[t] || []) f(e); return e; }
  append(...ns) { for (const n of ns) { if (typeof n === 'string') { this.children.push(n); continue; } if (n.parent) n.remove(); n.parent = this; this.children.push(n); } }
  replaceChildren(...ns) { for (const c of this.children) if (typeof c !== 'string') c.parent = null; this.children = []; this._text = ''; this.append(...ns); }
  remove() { if (this.parent) { this.parent.children = this.parent.children.filter(c => c !== this); this.parent = null; } }
  focus() { this.doc.activeElement = this; }
  click() { if (this.disabled) return; this.dispatch('click'); if (this.tagName === 'BUTTON' && (this.attrs.type || 'submit') === 'submit') { let f = this.parent; while (f && f.tagName !== 'FORM') f = f.parent; if (f) f.dispatch('submit'); } }
  *walk() { for (const c of this.children) if (typeof c !== 'string') { yield c; yield* c.walk(); } }
  querySelector(sel) {
    const m = /^\[data-fk="(.*)"\]$/.exec(sel), id = /^#(.*)$/.exec(sel);
    for (const n of this.walk()) { if (m && n.getAttribute('data-fk') === m[1]) return n; if (id && n.id === id[1]) return n; }
    return null;
  }
}
const json = (status, body) => Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body });
const CATALOGUE = { experts: ['x1', 'x2', 'x3'].map((id, i) => ({ id, name: `Expert ${i + 1}`, domain: 'd', summary: 's', prompt: 'p', tools: [], outputs: [], source: {} })),
  configuration: { liveReady: true, missing: [], maxExperts: 5 } };
function fakeEnv(project, { path = '/cloudbite', lang = 'en' } = {}) {
  const doc = { readyState: 'complete', activeElement: null, createElement: (t) => new Node_(doc, t), getElementById: (id) => id === 'cloudbite' ? root : null,
    listeners: {}, addEventListener(t, f) { (this.listeners[t] ||= []).push(f); } };
  doc.documentElement = new Node_(doc, 'html');
  const root = new Node_(doc, 'div'); root.id = 'cloudbite'; doc.body = new Node_(doc, 'body'); doc.body.append(root);
  const requests = [];
  const row = { id: PARENT, title: 'AI advisory room', status: 'completed', mode: 'live', createdAt: 1, expertCount: 2 };
  vm.runInContext(CLOUDBITE_JS, vm.createContext({
    document: doc, crypto: globalThis.crypto, CSS: { escape: (s) => s }, URL, URLSearchParams, Blob,
    location: { pathname: path, search: `?lang=${lang}`, hash: '' },
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0,
    fetch: (url, init = {}) => {
      if (String(url).startsWith('/api/cloudbite/owner/')) return json(200, { authenticated: false, hasCredentials: false });
      if (url === '/api/cloudbite/bootstrap') return json(200, CATALOGUE);
      requests.push({ url, init });
      if (String(url).startsWith('/api/cloudbite/history?')) return json(200, { owner: false, rows: [row] });
      if (url === `/api/cloudbite/history/${PARENT}`) return json(200, { project, model: 'm', roles: [], feedback: [], expiresAt: Date.now() + 1e6, canFeedback: false });
      return json(404, {});
    },
  }));
  const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); };
  const all = () => [...root.walk()];
  const fk = (k) => all().find(n => n.getAttribute('data-fk') === k);
  const byId = (id) => all().find(n => n.id === id);
  return { doc, requests, flush, all, fk, byId, root };
}
const setValue = async (env, id, value) => { const n = env.byId(id); n.value = value; n.dispatch('input'); n.dispatch('change'); await env.flush(); };
const click = async (env, k) => { env.fk(k).click(); await env.flush(); };
const coachOut = (env) => env.all().find(n => n.className === 'cb-coach-out');
const posts = (env) => env.requests.filter(r => r.init.method === 'POST');

await test('브리프 도우미: 미리 보기 → Apply 로만 맥락 끝에 더하고, 이미 쓴 글·목표·결정 칸은 그대로, KO/EN 전환에도 답과 미리 보기가 남는다', async () => {
  const env = fakeEnv(null);
  await env.flush();
  const details = env.all().find(n => n.className === 'cb-disclosure cb-coach-helper');
  assert.ok(details && !details.open, 'optional and folded by default');
  assert.ok(details.textContent.includes(EN.p6.helperNote) && details.textContent.includes(EN.p6.q.decision));
  assert.ok(!env.fk('start').disabled, 'direct input/run stays available without the helper');
  await setValue(env, 'cb-objective', 'Rough idea: AI room');
  await setValue(env, 'cb-context', 'My own context.');
  await click(env, 'coach-preview');
  assert.ok(coachOut(env).textContent.includes(EN.p6.needAnswer), 'empty answers ask for one answer');
  await setValue(env, 'cb-coach-who', 'Startup founders decide');
  await setValue(env, 'cb-coach-constraint', '4 weeks, one engineer');
  await click(env, 'coach-preview');
  assert.equal(env.byId('cb-context').value, 'My own context.', 'preview does not change the brief');
  assert.ok(coachOut(env).textContent.includes(EN.p6.previewTitle) && coachOut(env).textContent.includes(`${EN.p6.qLabel.who}: Startup founders decide`));
  assert.ok(!coachOut(env).textContent.includes(EN.p6.qLabel.decision), 'unanswered question is not invented');
  env.fk('lang:ko').click(); await env.flush();
  assert.equal(env.byId('cb-coach-who').value, 'Startup founders decide', 'answer survives language switch');
  assert.ok(coachOut(env).textContent.includes(KO.p6.previewTitle) && coachOut(env).textContent.includes(`${KO.p6.qLabel.who}: Startup founders decide`), 'labels follow UI, answer text untranslated');
  await click(env, 'coach-apply');
  const ctx = env.byId('cb-context').value;
  assert.equal(ctx, `My own context.\n\n${KO.p6.blockHead}\n- ${KO.p6.qLabel.who}: Startup founders decide\n- ${KO.p6.qLabel.constraint}: 4 weeks, one engineer`);
  assert.equal(env.byId('cb-objective').value, 'Rough idea: AI room', 'objective untouched');
  assert.equal(env.byId('cb-dec-knownFacts').value, '', 'nothing becomes a known fact');
  assert.ok(coachOut(env).textContent.includes(KO.p6.applied));
  assert.equal(env.doc.activeElement, env.byId('cb-context'), 'focus goes to the edited context');
  assert.equal(env.fk('coach-apply'), undefined, 'the applied draft is consumed');
  assert.equal(posts(env).length, 0, 'no model or server request');
  env.fk('lang:en').click(); await env.flush();
  assert.equal(env.byId('cb-context').value, ctx, 'applied text is the user\'s now; language switch leaves it');
});

await test('브리프 도우미: 미리 본 뒤 목표·맥락·답이 바뀌면 낡은 초안은 적용할 수 없고, 너무 길면 적용하지 않는다', async () => {
  const env = fakeEnv(null);
  await env.flush();
  await setValue(env, 'cb-context', 'Base.');
  await setValue(env, 'cb-coach-decision', 'Launch or pilot');
  await click(env, 'coach-preview');
  await setValue(env, 'cb-objective', 'A different brief');
  assert.ok(coachOut(env).textContent.includes(EN.p6.stale));
  assert.equal(env.fk('coach-apply').disabled, true);
  env.fk('coach-apply').disabled = false; await click(env, 'coach-apply');
  assert.equal(env.byId('cb-context').value, 'Base.', 'a stale draft never writes, even if forced');
  await click(env, 'coach-preview');
  await setValue(env, 'cb-coach-decision', 'Something else');
  assert.ok(coachOut(env).textContent.includes(EN.p6.stale), 'editing an answer also invalidates the draft');
  await setValue(env, 'cb-context', 'y'.repeat(2950));
  await click(env, 'coach-preview');
  assert.ok(coachOut(env).textContent.includes(EN.p6.tooLong(3000)) && env.fk('coach-apply').disabled);
  await click(env, 'coach-discard');
  assert.equal(env.fk('coach-apply'), undefined);
  assert.equal(env.byId('cb-context').value, 'y'.repeat(2950));
});

const openParent = async (env) => { env.fk('nav:history').click(); await env.flush(); env.fk('hist-record:' + PARENT).click(); await env.flush(); };
const detailText = (env) => env.all().find(n => n.className === 'cb-panel cb-history-detail').textContent;

await test('메모 화면 (EN/KO): 수정 제안을 세부 비판보다 앞에 제안으로 보이고, 선택지 없는 메모·틀린 칸·옛 메모를 각각 밝힌다', async () => {
  for (const [M, lang] of [[EN, 'en'], [KO, 'ko']]) {
    const env = fakeEnv(parentRaw(MEMO(DMEMO({ coaching: COACHING }))), { lang });
    await env.flush(); await openParent(env);
    const text = detailText(env);
    assert.doesNotMatch(text, /undefined|NaN|\[object/, lang);
    for (const s of [M.p6.title, M.p6.badge, M.p6.note, M.p6.stance['clarify-first'], 'Start with one paid pilot team', M.p6.kind['adverse-evidence'], M.p6.priority.next,
      'Cap the pilot at 10 roles.', 'Count support tickets in week one.', 'More than 20 tickets a week → narrow scope.', M.p6.revised, 'Five pre-pay conversations completed.',
      'Which 10 roles matter most to the pilot team?', M.p6.noOptions, M.p2.memoBy('Expert 2')])
      assert.ok(text.includes(s), `${lang}: ${s}`);
    assert.ok(text.indexOf(M.p6.title) < text.indexOf(M.p2.memoRecommendation) && text.indexOf(M.p6.title) < text.indexOf(M.p2.memoDissent), `${lang}: ahead of critique`);
    assert.ok(env.fk(`coach-draft:${PARENT}`), `${lang}: draft action offered`);
  }
  const broken = fakeEnv(parentRaw(MEMO(DMEMO({ coaching: { ...COACHING, repairs: [...COACHING.repairs, ...COACHING.repairs] } }))));
  await broken.flush(); await openParent(broken);
  assert.ok(detailText(broken).includes(EN.p6.invalid) && detailText(broken).includes('Expert 2 doubts demand.'), 'invalid coaching is visible, memo still shown');
  assert.equal(broken.fk(`coach-draft:${PARENT}`), undefined);
  const legacy = fakeEnv(parentRaw(MEMO(DMEMO())));
  await legacy.flush(); await openParent(legacy);
  assert.ok(detailText(legacy).includes(EN.p6.absent) && !detailText(legacy).includes(EN.p6.invalid));
  const old = fakeEnv(parentRaw({ version: 'cloudbite-memo/v1', status: 'needs-options', attempts: 1, execution: 'none', reason: 'no decision options' }));
  await old.flush(); await openParent(old);
  assert.ok(detailText(old).includes(EN.p2.memoNeedsOptions('no decision options')), 'legacy needs-options display kept');
});

await test('수정 제안 → 다음 라운드 초안: 목표·범위·이정표만 옮기고, 실행·채택하지 않으며 부모·역할·알려진 사실은 그대로', async () => {
  const env = fakeEnv(parentRaw(MEMO(DMEMO({ coaching: COACHING }))));
  await env.flush(); await openParent(env);
  await click(env, `coach-draft:${PARENT}`);
  const box = env.all().find(n => n.className === 'cb-followup');
  assert.equal(box.hidden, false, 'existing follow-up draft opened');
  assert.ok(box.textContent.includes(EN.p2.fuParent('AI advisory room', PARENT)) && box.textContent.includes(EN.p6.draftNote), 'parent provenance kept and labelled');
  assert.equal(env.byId('cb-objective').value, COACHING.revisedProject.objective.text);
  // v7: 범위·이정표 다음에 우선 보완책·열린 질문도 "제안" 이름표 아래 옮긴다 (test/cloudbite-v7-continuity.mjs 가 상한·생략을 고정한다)
  assert.ok(env.byId('cb-context').value.startsWith(`Startup teams.\n\n${EN.p6.draftBlockHead}\n- ${EN.p6.scope}: One pilot team, 10 roles, no data upload.\n- ${EN.p6.milestone}: Five pre-pay conversations completed.\n${EN.p7.draftRepairsHead}`));
  assert.equal(env.byId('cb-fu-summary').value, EN.p6.draftSummary);
  assert.equal(env.byId('cb-dec-knownFacts').value, 'We have 3 design partners', 'known facts stay the parent\'s; no suggestion becomes a fact');
  assert.equal(env.byId('cb-dec-constraints').value, '4 weeks');
  assert.equal(env.fk('x:x1').checked && env.fk('x:x2').checked && !env.fk('x:x3').checked, true, 'previous role selection kept');
  assert.equal(posts(env).length, 0, 'nothing launched: no preview, project or memo request');
  assert.equal(env.doc.activeElement, env.byId('cb-objective'));
  env.fk('lang:ko').click(); await env.flush();
  assert.equal(env.byId('cb-objective').value, COACHING.revisedProject.objective.text, 'draft text is not translated on language switch');
  assert.ok(box.textContent.includes(KO.p6.draftNote));
  // 맥락이 한도에 가까우면 범위·이정표를 더하지 않고 그렇다고 밝힌다
  const full = fakeEnv(parentRaw(MEMO(DMEMO({ coaching: COACHING })), { ...BRIEF, context: 'z'.repeat(2900) }));
  await full.flush(); await openParent(full); await click(full, `coach-draft:${PARENT}`);
  assert.equal(full.byId('cb-context').value, 'z'.repeat(2900));
  assert.equal(full.byId('cb-fu-summary').value, `${EN.p6.draftSummary} ${EN.p6.draftNoRoom}`);
});

await test('브리프 도우미 + 언어 전환: 고치지 않은 예시 맥락의 번역은 최신 미리 보기를 낡게 하지 않고, 이미 낡은 미리 보기는 되살리지 않는다', async () => {
  const answer = async (env) => { await setValue(env, 'cb-coach-who', '창업자'); await setValue(env, 'cb-coach-decision', 'Pilot or not'); await setValue(env, 'cb-coach-constraint', '4주'); };
  const env = fakeEnv(null, { lang: 'ko' });
  await env.flush();
  assert.equal(env.byId('cb-context').value, KO.sampleContext, 'default sample context untouched');
  await setValue(env, 'cb-objective', '내가 쓴 목표');
  await answer(env);
  await click(env, 'coach-preview');
  env.fk('lang:en').click(); await env.flush();
  assert.equal(env.byId('cb-context').value, EN.sampleContext, 'untouched sample context translated');
  assert.equal(env.byId('cb-objective').value, '내가 쓴 목표', 'user objective never translated');
  assert.equal(env.byId('cb-coach-who').value, '창업자', 'answers kept');
  assert.ok(!coachOut(env).textContent.includes(EN.p6.stale), 'fresh preview stays fresh');
  assert.equal(env.fk('coach-apply').disabled, false);
  await click(env, 'coach-apply');
  assert.equal(env.byId('cb-context').value, `${EN.sampleContext}\n\n${EN.p6.blockHead}\n- ${EN.p6.qLabel.who}: 창업자\n- ${EN.p6.qLabel.decision}: Pilot or not\n- ${EN.p6.qLabel.constraint}: 4주`);
  // 사용자가 고쳐 이미 낡은 미리 보기는 언어 전환으로 되살아나지 않는다
  const st = fakeEnv(null, { lang: 'ko' });
  await st.flush();
  await setValue(st, 'cb-objective', '첫 목표');
  await answer(st);
  await click(st, 'coach-preview');
  await setValue(st, 'cb-objective', '고친 목표');
  assert.ok(coachOut(st).textContent.includes(KO.p6.stale));
  st.fk('lang:en').click(); await st.flush();
  assert.ok(coachOut(st).textContent.includes(EN.p6.stale), 'already-stale preview remains stale');
  assert.equal(st.fk('coach-apply').disabled, true);
  st.fk('coach-apply').disabled = false; await click(st, 'coach-apply');
  assert.equal(st.byId('cb-context').value, EN.sampleContext, 'stale draft never writes');
});

await test('브리프 도우미: 적용 안내는 직접 고치면 사라지고, 다른 프로젝트 후속 초안은 이전 답·안내를 넘겨받지 않는다', async () => {
  const env = fakeEnv(parentRaw(MEMO(DMEMO({ coaching: COACHING }))));
  await env.flush();
  await setValue(env, 'cb-context', 'Mine.');
  await setValue(env, 'cb-coach-who', 'Old answer');
  await click(env, 'coach-preview');
  await click(env, 'coach-apply');
  assert.ok(coachOut(env).textContent.includes(EN.p6.applied), 'apply\'s own assignment shows success');
  await setValue(env, 'cb-context', 'Mine.');
  assert.ok(!coachOut(env).textContent.includes(EN.p6.applied), 'manual edit removing the block clears the success message');
  assert.equal(env.byId('cb-coach-who').value, 'Old answer', 'answers are kept on manual edits');
  await click(env, 'coach-preview'); await click(env, 'coach-apply');
  assert.ok(coachOut(env).textContent.includes(EN.p6.applied));
  await openParent(env);
  await click(env, `coach-draft:${PARENT}`);
  for (const q of ['who', 'decision', 'constraint']) assert.equal(env.byId(`cb-coach-${q}`).value, '', `${q}: old helper answer cleared`);
  assert.ok(!coachOut(env).textContent.includes(EN.p6.applied), 'no inherited applied message');
  assert.equal(env.fk('coach-apply'), undefined, 'no inherited preview');
  assert.ok(!env.byId('cb-context').value.includes('Old answer'), 'context is the parent\'s');
  assert.equal(env.byId('cb-dec-knownFacts').value, 'We have 3 design partners', 'parent fields unchanged');
  assert.equal(env.fk('x:x1').checked && env.fk('x:x2').checked, true, 'roles unchanged');
});

console.log(`cloudbite-v6-coaching-ui: ${pass} groups passed (fake DOM; no live provider, server or browser).`);
