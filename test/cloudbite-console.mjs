// Cloudbite 콘솔 (src/cloudbite-page.ts 의 CLOUDBITE_JS) 을 브라우저 없이 고정한다: 값 정리·종합·데모 계획은 코어 함수로,
// 화면 동작(데모 시작·취소, 실제 실행 요청 헤더, 취소 뒤 늦은 응답, 몰래 데모로 바꾸지 않음, 글자로만 그리기)은 작은 가짜 DOM 으로.
// 실제 브라우저 확인은 조정자가 한다 — 이 파일은 브라우저 증거가 아니다.
//   node test/cloudbite-console.mjs
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { build } from 'esbuild';
import { CLOUDBITE_JS, CLOUDBITE_CSS, CLOUDBITE_HTML, CLOUDBITE_JS_PATH, CLOUDBITE_CSS_PATH } from '../src/cloudbite-page.ts';

let pass = 0;
const test = async (name, fn) => { await fn(); pass++; console.log(`  ok   ${name}`); };
const EVIL = '<img src=x onerror="globalThis.__pwn=1"><script>globalThis.__pwn=2</script>';

// ───────── 페이지 껍데기
await test('HTML 은 같은 출처 외부 스크립트·스타일만 부르고 인라인·외부 자원이 없다', () => {
  assert.ok(CLOUDBITE_HTML.includes(`<script src="${CLOUDBITE_JS_PATH}" defer></script>`));
  assert.ok(CLOUDBITE_HTML.includes(`<link rel="stylesheet" href="${CLOUDBITE_CSS_PATH}">`));
  assert.equal((CLOUDBITE_HTML.match(/<script/g) || []).length, 1);
  assert.ok(!/\s(?:style|on\w+)=|https?:\/\//.test(CLOUDBITE_HTML));
  assert.ok(!/https?:\/\/|@import/.test(CLOUDBITE_CSS));
  assert.ok(!/innerHTML|localStorage|sessionStorage|indexedDB|document\.cookie|eval\(/.test(CLOUDBITE_JS));
  assert.ok(CLOUDBITE_HTML.includes('lang="en"'));
  assert.match(CLOUDBITE_HTML, /<title>Cloudbite — Expert sandbox workspace<\/title>/);
});

// ───────── 코어 함수
function loadCore() {
  let core = null;
  const ctx = vm.createContext({ __cloudbiteTestHook: (c) => { core = c; }, crypto: globalThis.crypto });
  vm.runInContext(CLOUDBITE_JS, ctx);
  assert.ok(core, 'test hook received core');
  // vm 영역의 배열·객체를 이 영역 값으로 바꿔 deepEqual 이 영역 차이로 실패하지 않게 한다
  const out = {};
  for (const [k, v] of Object.entries(core)) out[k] = typeof v === 'function' ? (...a) => { const r = v(...a); return r === undefined || r === null ? r : plain(r); } : k === 'DICT' ? v : plain(v); // 사전은 문구 함수째로 쓴다
  return out;
}
const plain = (v) => JSON.parse(JSON.stringify(v));
const core = loadCore();
const brief = (over = {}) => ({ title: 'Launch a 100-expert AI advisory room', objective: 'Decide whether to launch for startup teams on a partially paid model within 4 weeks', context: 'We plan to show evidence and sources', expertIds: [], mode: 'demo', requestId: 'r-1', ...over });
const opinion = (direction, confidence, nextActions = []) => ({ direction, confidence, summary: `${direction} summary`, evidence: ['e'], assumptions: [], nextActions });
const run = (i, status, op, extra = {}) => ({ id: `run-${i}`, expertId: `x${i}`, name: `Expert${i}`, status, activity: [], artifacts: [], updatedAt: 1, ...(op ? { opinion: op } : {}), ...extra });
const project = (experts, over = {}) => ({ id: 'p1', brief: brief(), status: 'running', experts, createdAt: 1, updatedAt: 1, ...over });

await test('bootstrap 정리: 깨진 역할·중복 제거, 설정 값 경계, 형식 오류는 던진다', () => {
  const b = core.normalizeBootstrap({
    experts: [{ id: 'a', name: 'A', domain: 'd' }, { id: 'a', name: 'dup' }, { name: 'no id' }, 7, null, { id: 'b', name: EVIL, tools: ['x', 3] }],
    configuration: { liveReady: 'yes', missing: ['DAYTONA_API_KEY', 5], maxExperts: 9999 },
  });
  assert.deepEqual(b.experts.map(e => e.id), ['a', 'b']);
  assert.deepEqual(plain(b.experts[1].tools), ['x']);
  assert.equal(b.configuration.liveReady, false, 'only literal true counts as ready');
  assert.deepEqual(plain(b.configuration.missing), ['DAYTONA_API_KEY']);
  assert.equal(b.configuration.maxExperts, 100);
  assert.throws(() => core.normalizeBootstrap({ experts: 'x' }));
  assert.throws(() => core.normalizeBootstrap(null));
});

await test('project 정리: 알 수 없는 상태는 실패, 잘못된 의견은 형식 오류로 표시, 깨진 항목은 버린다', () => {
  const p = core.normalizeProject({
    id: 'p', status: 'weird', brief: { title: 't', objective: 'o', context: 'c', expertIds: ['x'], mode: 'live', requestId: 'r' },
    experts: [
      run(1, 'completed', opinion('support', 80)),
      run(2, 'completed', { direction: 'support', confidence: 140, summary: 's' }),
      run(3, 'exploded'),
      { id: 'no-expert-id' }, 'junk',
      run(4, 'running', null, { activity: [{ kind: 'nope', message: EVIL, at: 'x' }, { kind: 'tool' }], artifacts: [{ path: 'out/a.md', content: 5 }, { label: 'no path' }] }),
    ],
  });
  assert.equal(p.experts.length, 4);
  assert.equal(p.experts[1].opinion, undefined);
  assert.equal(p.experts[1].invalidOpinion, true);
  assert.equal(p.experts[2].status, 'failed');
  assert.equal(p.status, 'running', 'unknown project status derived from experts');
  assert.equal(p.experts[3].activity.length, 1);
  assert.equal(p.experts[3].activity[0].kind, 'status');
  assert.equal(p.experts[3].activity[0].message, EVIL, 'kept as data; rendering is textContent-only');
  assert.equal(p.experts[3].artifacts.length, 1);
  assert.equal(p.experts[3].artifacts[0].content, undefined);
  assert.equal(core.normalizeProject({ id: 'p', experts: [] }), null);
  assert.equal(core.normalizeProject('x'), null);
});

await test('종합은 완료된 유효 의견만 센다 (실패·대기·취소·형식 오류 제외, 개수는 따로)', () => {
  const p = project([
    run(1, 'completed', opinion('support', 90, ['Limit scope to 20 core roles', 'Set a price ceiling'])),
    run(2, 'completed', opinion('concern', 70, ['Limit  scope to 20 core roles'])),
    run(3, 'completed', opinion('support', 50)),
    run(4, 'failed', opinion('concern', 99, ['Failed action'])),
    run(5, 'running', opinion('abstain', 10)),
    run(6, 'cancelled'),
    { ...run(7, 'completed'), invalidOpinion: true },
  ]);
  const a = core.aggregate(p);
  assert.equal(a.selected, 7); assert.equal(a.valid, 3); assert.equal(a.completed, 4); assert.equal(a.invalid, 1);
  assert.equal(a.failed, 1); assert.equal(a.pending, 1); assert.equal(a.cancelled, 1);
  assert.deepEqual(plain(a.counts), { support: 2, conditional: 0, concern: 1, abstain: 0 });
  assert.equal(a.meanConfidence, 70);
  assert.deepEqual(plain(a.buckets), [0, 0, 1, 1, 1]);
  assert.equal(a.leading, 'support');
  assert.equal(a.disagreement, true);
  assert.equal(a.actions[0].count, 2, 'whitespace-normalised duplicate actions merge');
  assert.ok(!a.actions.some(x => x.text === 'Failed action'));
  assert.equal(a.supportVoices[0].confidence, 90);
  assert.match(a.headline, /based on 3 of 7 selected experts/);
});

await test('종합: 의견이 없으면 평균·주도 의견이 없고, 동률이면 주도 의견을 고르지 않는다', () => {
  const empty = core.aggregate(project([run(1, 'failed'), run(2, 'queued')]));
  assert.equal(empty.valid, 0); assert.equal(empty.meanConfidence, null); assert.equal(empty.leading, null);
  const tie = core.aggregate(project([run(1, 'completed', opinion('support', 60)), run(2, 'completed', opinion('concern', 60))]));
  assert.equal(tie.leading, null); assert.match(tie.headline, /evenly split/);
  const bound = core.aggregate(project([run(1, 'completed', opinion('conditional', 100)), run(2, 'completed', opinion('conditional', 0))]));
  assert.deepEqual(plain(bound.buckets), [1, 0, 0, 0, 1]);
});

await test('폼 검증: 필수값·길이·전문가 수', () => {
  const lim = { min: 1, max: 5 };
  assert.equal(core.validateForm({ title: 't', objective: 'o', context: '', expertIds: ['a'] }, lim).length, 0);
  const errs = core.validateForm({ title: ' ', objective: '', context: 'x'.repeat(3001), expertIds: ['1', '2', '3', '4', '5', '6'] }, lim);
  assert.equal(errs.length, 4);
});

await test('데모 계획: 결정적이고, 브리프를 고치면 해당 역할의 결과가 바뀐다, 역할마다 활동이 다르다', () => {
  const ex = core.DEMO_EXPERTS.slice(0, 5);
  const finish = (b) => { const pl = core.demoPlan(b, ex, -1, 0); let p = pl.project; for (const s of pl.steps) p = core.applyStep(p, s, s.at); return p; };
  const a1 = finish(brief()), a2 = finish(brief());
  assert.deepEqual(plain(a1.experts.map(e => e.opinion)), plain(a2.experts.map(e => e.opinion)));
  assert.equal(a1.status, 'completed');
  const msgs = a1.experts.map(e => e.activity.map(x => x.message).join('|'));
  assert.equal(new Set(msgs).size, 5, 'each expert has distinct activity');
  for (const e of a1.experts) {
    assert.deepEqual(e.artifacts.map(x => x.path).sort(), ['PERSONA.md', 'PROJECT.md', 'WORKORDER.md', 'out/notes.md', 'out/report.md', 'out/result.json']);
    assert.deepEqual(JSON.parse(e.artifacts.find(x => x.path === 'out/result.json').content), plain(e.opinion));
    assert.ok(e.artifacts.find(x => x.path === 'PROJECT.md').content.includes('within 4 weeks'));
  }
  const biz = (p) => p.experts.find(e => e.expertId === 'demo-business-model').opinion.direction;
  assert.equal(biz(a1), 'support');
  assert.equal(biz(finish(brief({ objective: 'Launch on a free model', context: '' }))), 'concern');
  const trust = (p) => p.experts.find(e => e.expertId === 'demo-ai-trust').opinion.direction;
  assert.equal(trust(finish(brief({ context: 'Includes medical consultations' }))), 'concern');
  assert.ok(a1.experts.every(e => e.sandboxId.startsWith('demo-ws-')));
});

await test('데모 실패 시뮬레이션: 그 전문가는 실패로 끝나고 의견이 없으며 프로젝트는 일부 완료', () => {
  const ex = core.DEMO_EXPERTS.slice(0, 3);
  const pl = core.demoPlan(brief(), ex, 2, 0);
  let p = pl.project; for (const s of pl.steps) p = core.applyStep(p, s, s.at);
  assert.equal(p.experts[2].status, 'failed'); assert.equal(p.experts[2].opinion, undefined);
  assert.equal(p.status, 'partial');
  const a = core.aggregate(p); assert.equal(a.valid, 2); assert.equal(a.failed, 1);
});

await test('취소: 끝나지 않은 전문가만 취소, 그 뒤 단계는 적용되지 않는다', () => {
  const ex = core.DEMO_EXPERTS.slice(0, 3);
  const pl = core.demoPlan(brief(), ex, -1, 0);
  let p = pl.project;
  for (const s of pl.steps.slice(0, 4)) p = core.applyStep(p, s, s.at);
  p = core.cancelProject(p, 10);
  assert.equal(p.status, 'cancelled');
  assert.ok(p.experts.every(e => e.status === 'cancelled'));
  for (const s of pl.steps.slice(4)) p = core.applyStep(p, s, s.at);
  assert.ok(p.experts.every(e => e.status === 'cancelled' && !e.opinion));
});

await test('Markdown 보고서는 데모 표시와 제외 개수를 담는다', () => {
  const md = core.markdownReport(project([run(1, 'completed', opinion('support', 80)), run(2, 'failed', null, { error: 'boom' })], { status: 'partial' }), true);
  assert.match(md, /Browser demo simulation/); assert.match(md, /failed 1/); assert.match(md, /Error: boom/);
});

// ───────── 가짜 DOM 으로 화면 동작
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
/** 소유자 세션 기본값: 로그인하지 않음 (서버의 200 {authenticated:false}) */
const OWNER_OUT = () => json(200, { authenticated: false, hasCredentials: false });
/** 소유자 세션·로그아웃 요청은 env.ownerCalls 에 따로 모은다 (requests 에는 Cloudbite 프로젝트·bootstrap 요청만) */
/** 계획 미리보기 기본 응답: 보낸 팀을 그대로 돌려주는 올바른 ProjectPreview (배정 없음). 미리보기 요청은 env.previews 에 따로 모은다 */
const PREVIEW_OK = (url, init) => {
  const b = JSON.parse(init.body), n = b.expertIds.length;
  return json(200, { expertIds: b.expertIds, assignments: [], budget: { maxExperts: n, maxModelCalls: n * 8 + 4, maxReviewCalls: 3, maxMemoCalls: 1 },
    envelope: { sandboxMaximum: n, nosanaMaximum: n * 8 + 4, expertMaximum: n * 8, reviewMaximum: 3, memoMaximum: 1, jevCalls: b.routing ? 1 : 0 }, warnings: [] });
};
function fakeEnv({ fetchImpl, owner = OWNER_OUT, globals = {}, preview = PREVIEW_OK }) {
  const timers = new Map(); let seq = 0, now = 0;
  const doc = { readyState: 'complete', activeElement: null, createElement: (t) => new Node_(doc, t), getElementById: (id) => id === 'cloudbite' ? root : null,
    listeners: {}, addEventListener(t, f) { (this.listeners[t] ||= []).push(f); },
    key(k) { const e = { key: k, preventDefault() {} }; for (const f of this.listeners.keydown || []) f(e); } };
  doc.documentElement = new Node_(doc, 'html');
  const root = new Node_(doc, 'div'); root.id = 'cloudbite'; doc.body = new Node_(doc, 'body'); doc.body.append(root);
  const requests = [], ownerCalls = [], previews = [];
  const ctx = vm.createContext({
    document: doc, crypto: globalThis.crypto, CSS: { escape: (s) => s }, URL, URLSearchParams, Blob,
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { at: now + (ms || 0), fn }); return id; },
    clearTimeout: (id) => { timers.delete(id); }, setInterval: () => 0,
    fetch: (url, init = {}) => {
      if (String(url).startsWith('/api/cloudbite/owner/')) { ownerCalls.push({ url, init }); return owner(url, init, ownerCalls.length); }
      if (url === '/api/cloudbite/preview') { previews.push({ url, init }); return preview(url, init, previews.length); }
      requests.push({ url, init }); return fetchImpl(url, init, requests.length);
    },
    ...globals,
  });
  vm.runInContext(CLOUDBITE_JS, ctx);
  const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); };
  const advance = async (ms) => {
    const end = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]); now = due[1].at; due[1].fn(); await flush();
    }
    now = end; await flush();
  };
  const all = () => [...root.walk()];
  const byText = (tag, text) => all().find(n => n.tagName === tag && n.textContent.trim() === text);
  const fk = (k) => all().find(n => n.getAttribute('data-fk') === k);
  return { root, doc, requests, ownerCalls, previews, flush, advance, all, byText, fk, ctx, pendingTimers: () => timers.size };
}
const json = (status, body) => Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) });
const CATALOGUE = {
  experts: [
    { id: 'strategy', name: '제품 전략가', domain: '제품 전략', summary: 's', prompt: 'p', tools: [], outputs: [], source: {} },
    { id: 'biz', name: '비즈니스 모델 전문가', domain: '사업·재무', summary: 's', prompt: 'p', tools: [], outputs: [], source: {} },
    { id: 'trust', name: EVIL, domain: 'AI 신뢰성', summary: EVIL, prompt: EVIL, tools: [], outputs: [], source: {} },
    { id: 'ux', name: 'UX 리서처', domain: '사용자 경험', summary: 's', prompt: 'p', tools: [], outputs: [], source: {} },
  ],
  configuration: { liveReady: true, missing: [], maxExperts: 5 },
};
/** 시작 버튼은 하나다: 편집 영역 끝의 data-fk="start" (Run experts / Run again, 데모면 "in demo mode") */
const startBtnOf = (env) => env.fk('start');
/** 시작 버튼을 누른다. 실제 실행은 두 걸음(계획 준비 → 이 계획으로 실행)이라, 계획이 준비되면 한 번 더 누른다 */
const go = async (env, btn = startBtnOf(env)) => {
  btn.click(); await env.flush();
  const again = startBtnOf(env);
  if (again && ['Run this plan', '이 계획으로 실행'].includes(again.textContent.trim())) { again.click(); await env.flush(); }
};
const setupOf = (env) => env.all().find(n => n.id === 'cb-setup');
const cards = (env) => env.all().filter(n => n.className.startsWith('cb-card ')).length;
const view = (env, v) => env.all().find(n => n.id === `cb-view-${v}`);
/** 편집 영역 안(시작 버튼 옆)의 오류 */
const formMsgOf = (env) => [...setupOf(env).walk()].find(n => n.className === 'cb-formmsg').textContent;
/** 첫 화면에는 자동 데모가 없다. 사용자가 시작 버튼을 눌러야 데모가 돈다 */
async function startDemo(env) {
  await env.flush();
  const start = startBtnOf(env);
  assert.equal(start.textContent, 'Run experts in demo mode', 'demo start is explicitly labelled');
  await go(env, start);
}

await test('첫 화면: 프로젝트 설정만 보이고 자동 데모가 없다, 데모는 직접 시작, 적대적 문자열은 글자로만 그린다', async () => {
  const env = fakeEnv({ fetchImpl: (url) => url === '/api/cloudbite/bootstrap' ? json(200, CATALOGUE) : json(404, { error: 'x' }) });
  await env.flush();
  const text = env.root.textContent;
  assert.match(text, /Browser demo/); assert.match(text, /simulated activity and files; no Daytona or Nosana calls/);
  assert.equal(setupOf(env).hidden, false, 'setup visible on landing');
  assert.equal(env.all().find(n => n.tagName === 'H2' && n.id === 'cb-project-h').textContent, 'Project brief');
  assert.equal(env.all().find(n => n.className.startsWith('cb-panel cb-workspace')).hidden, true, 'no empty workspace');
  assert.equal(env.all().find(n => n.className === 'cb-aside').hidden, true, 'no empty progress/synthesis rail');
  assert.equal(view(env, 'home').className, 'cb-view cb-home', 'single setup column');
  assert.equal(env.fk('setup').hidden, true, 'no Edit project before a run');
  assert.equal(env.fk('stop').hidden, true, 'no Stop before a run');
  assert.equal(env.all().filter(n => n.getAttribute('data-fk') === 'start').length, 1, 'exactly one start action');
  assert.equal(cards(env), 0);
  await env.advance(30000);
  assert.equal(cards(env), 0, 'nothing starts by itself');
  assert.equal(env.requests.length, 1);
  await startDemo(env);
  assert.ok(cards(env) > 0, 'expert cards once the demo starts');
  assert.equal(setupOf(env).hidden, true, 'setup collapses on start');
  assert.equal(env.fk('setup').textContent, 'Edit project');
  assert.equal(view(env, 'home').className, 'cb-view cb-home has-rail', 'right rail only during a run');
  await env.advance(30000);
  assert.ok(env.root.textContent.includes(EVIL), 'hostile name rendered as literal text');
  assert.ok(!env.all().some(n => ['IMG', 'SCRIPT', 'SVG'].includes(n.tagName)), 'no element created from content');
  assert.equal(env.ctx.__pwn, undefined);
  assert.match(env.root.textContent, /4 \/ 4 valid opinions/);
  assert.match(env.root.textContent, /Completed/);
  assert.equal(env.requests.length, 1, 'demo makes no project API calls');
});

await test('데모 취소: 타이머를 멈추고 나중에 완료되지 않는다, 다시 실행하면 새 결과', async () => {
  const env = fakeEnv({ fetchImpl: () => json(200, CATALOGUE) });
  await startDemo(env);
  await env.advance(2500);
  const cancel = env.byText('BUTTON', 'Stop');
  assert.equal(cancel.disabled, false); assert.equal(env.fk('stop').hidden, false, 'Stop shown while active');
  cancel.click(); await env.flush();
  assert.equal(env.pendingTimers(), 0, 'all demo timers cleared');
  await env.advance(60000);
  assert.match(env.root.textContent, /Cancelled/);
  assert.match(env.root.textContent, /0 \/ 4 valid opinions/);
  assert.ok(!env.root.textContent.includes('Submitted out/result.json'));
  assert.equal(env.fk('stop').hidden, true, 'Stop hidden once inactive');
  const again = startBtnOf(env);
  assert.equal(again.textContent, 'Run again in demo mode');
  assert.equal(again.disabled, false);
  await go(env, again);
  await env.advance(30000);
  assert.match(env.root.textContent, /4 \/ 4 valid opinions/);
});

await test('작업공간 탭: 파일 탭은 실제 파일 내용을, 페르소나 탭은 역할 정의를 보여 준다', async () => {
  const env = fakeEnv({ fetchImpl: () => json(200, CATALOGUE) });
  await startDemo(env); await env.advance(30000);
  env.all().find(n => n.getAttribute('data-fk') === 'tab:artifacts').click();
  const pre = env.all().find(n => n.tagName === 'PRE');
  assert.match(pre.textContent, /## Recommendation: /, 'default file is out/report.md content');
  env.all().find(n => n.getAttribute('data-fk') === 'file:out/result.json').click();
  assert.ok(env.all().find(n => n.tagName === 'PRE').textContent.includes('"direction"'));
  env.all().find(n => n.getAttribute('data-fk') === 'file:WORKORDER.md').click();
  assert.match(env.all().find(n => n.tagName === 'PRE').textContent, /# Work order — /);
  env.all().find(n => n.getAttribute('data-fk') === 'tab:persona').click();
  assert.match(env.all().find(n => n.tagName === 'PRE').textContent, /This is an AI role, not the opinion/);
});

function liveEnv(handlers) {
  const env = fakeEnv({ fetchImpl: (url, init, n) => {
    if (url === '/api/cloudbite/bootstrap') return json(200, CATALOGUE);
    return handlers(url, init, n);
  } });
  return env;
}
async function goLive(env, token = 'adm-secret-123') {
  await env.flush();
  env.byText('BUTTON', 'Live run').click(); await env.flush();
  const tok = env.all().find(n => n.id === 'cb-token');
  tok.value = token; tok.dispatch('input'); await env.flush();
}
const liveProject = (status, expStatus, extra = {}) => ({ id: 'proj-1', brief: { ...brief({ mode: 'live' }) }, status, createdAt: 1, updatedAt: extra.updatedAt ?? 1,
  experts: [{ id: 'r1', expertId: 'strategy', name: 'Product Strategist', status: expStatus, activity: [{ id: 'a', at: 1, kind: 'tool', message: 'python run.py' }], artifacts: [{ path: 'out/report.md', label: '보고서' }], updatedAt: 1,
    ...(expStatus === 'completed' ? { opinion: opinion('support', 77) } : {}) }] });

await test('실제 실행: 관리자 토큰 헤더로 만들고 범위 토큰으로 조회, 토큰은 저장소에 쓰지 않는다', async () => {
  const env = liveEnv((url, init) => {
    if (url === '/api/cloudbite/projects' && init.method === 'POST') return json(201, { project: liveProject('running', 'running'), accessToken: 'proj-scope-tok' });
    if (url === '/api/cloudbite/projects/proj-1') return json(200, liveProject('completed', 'completed', { updatedAt: 5 }));
    // 서버 계약: {path, label, bytes, content} JSON 봉투 (src/cloudbite-project.ts artifact())
    if (url.startsWith('/api/cloudbite/projects/proj-1/artifact')) return json(200, { path: 'out/report.md', label: 'Report', bytes: 40, content: '# Live report ' + EVIL });
    return json(404, { error: 'nope' });
  });
  await goLive(env);
  const start = startBtnOf(env);
  assert.equal(start.disabled, false);
  await go(env, start);
  const post = env.requests.find(r => r.init.method === 'POST' && r.url === '/api/cloudbite/projects');
  assert.equal(post.init.headers['x-admin-token'], 'adm-secret-123');
  const sent = JSON.parse(post.init.body);
  assert.equal(sent.mode, 'live'); assert.ok(sent.requestId); assert.ok(sent.expertIds.length >= 1);
  assert.ok(!/Daytona.*key|apiKey/i.test(post.init.body));
  assert.match(env.root.textContent, /Live run — server-reported activity/);
  await env.advance(1500);
  const get = env.requests.find(r => r.url === '/api/cloudbite/projects/proj-1');
  assert.equal(get.init.headers.authorization, 'Bearer proj-scope-tok');
  assert.equal(get.init.headers['x-admin-token'], undefined, 'admin token not sent on poll');
  assert.match(env.root.textContent, /1 \/ 1 valid opinions/);
  env.all().find(n => n.getAttribute('data-fk') === 'tab:artifacts').click(); await env.flush();
  const art = env.requests.find(r => r.url.includes('/artifact?'));
  assert.equal(art.url, '/api/cloudbite/projects/proj-1/artifact?expert=strategy&path=out%2Freport.md');
  assert.equal(art.init.headers.authorization, 'Bearer proj-scope-tok');
  const pre = env.all().find(n => n.tagName === 'PRE');
  assert.equal(pre.textContent, '# Live report ' + EVIL, 'envelope content shown, not the JSON envelope');
  assert.ok(!env.root.textContent.includes('"bytes"'));
  assert.ok(!env.all().some(n => n.tagName === 'IMG'));
  assert.equal(setupOf(env).hidden, true, 'successful start collapses setup');
  assert.ok(env.fk('export-md') && env.fk('export-json'), 'exports once a project exists');
  for (const k of ['localStorage', 'sessionStorage', 'indexedDB']) assert.equal(env.ctx[k], undefined);
});

await test('실제 실행 실패는 오류로 보여 주고 데모로 몰래 바꾸지 않는다', async () => {
  const env = liveEnv(() => json(503, { error: 'DAYTONA_API_KEY missing' }));
  await goLive(env);
  await go(env);
  assert.match(env.root.textContent, /The server run configuration is not ready\. — DAYTONA_API_KEY missing/);
  assert.equal(env.all().filter(n => n.className.startsWith('cb-card ')).length, 0, 'no demo cards substituted');
  assert.equal(setupOf(env).hidden, false, 'failed create keeps the setup open to fix and retry');
  assert.match(formMsgOf(env), /DAYTONA_API_KEY missing/, 'error shown next to the start action');
  assert.match(env.root.textContent, /Live run — server-reported activity/);
  await env.advance(60000);
  assert.equal(env.requests.filter(r => r.url === '/api/cloudbite/projects').length, 1, 'no automatic retry/fallback');
});

await test('취소 뒤 늦게 도착한 조회 응답은 버린다, 제출 중에는 시작 버튼이 잠긴다', async () => {
  let releasePoll;
  const env = liveEnv((url, init) => {
    if (url === '/api/cloudbite/projects' && init.method === 'POST') return json(201, { project: liveProject('running', 'running'), accessToken: 'tok2' });
    if (url === '/api/cloudbite/projects/proj-1') return new Promise(r => { releasePoll = () => r({ ok: true, status: 200, json: async () => liveProject('completed', 'completed', { updatedAt: 99 }) }); });
    if (url === '/api/cloudbite/projects/proj-1/cancel') return json(200, { project: liveProject('cancelled', 'cancelled', { updatedAt: 3 }) });
    return json(404, {});
  });
  await goLive(env);
  const start = startBtnOf(env);
  start.click();
  assert.equal(start.disabled, true, 'disabled while the plan is prepared');
  await env.flush();
  assert.equal(start.textContent, 'Run this plan');
  start.click();
  assert.equal(start.disabled, true, 'disabled while in flight');
  await env.flush();
  await env.advance(1300); // 조회 요청이 나가고 응답은 붙잡혀 있다
  assert.ok(releasePoll, 'poll in flight');
  env.byText('BUTTON', 'Stop').click(); await env.flush();
  const cancelReq = env.requests.find(r => r.url.endsWith('/cancel'));
  assert.equal(cancelReq.init.headers.authorization, 'Bearer tok2');
  releasePoll(); await env.flush(); await env.advance(10000);
  assert.match(env.root.textContent, /Cancelled/);
  assert.match(env.root.textContent, /0 \/ 1 valid opinions/, 'stale completed poll ignored');
});

await test('형식이 깨진 생성 응답은 오류가 된다, 준비 안 된 서버는 실제 실행을 막고 설정 이름만 보여 준다', async () => {
  const env = liveEnv(() => json(201, { project: { id: 'x' }, accessToken: '' }));
  await goLive(env);
  await go(env);
  assert.match(env.root.textContent, /The server response has an invalid format/);

  const env2 = fakeEnv({ fetchImpl: () => json(200, { ...CATALOGUE, configuration: { liveReady: false, missing: ['NOSANA_BASE_URL', 'DAYTONA_API_KEY'], maxExperts: 5 } }) });
  await goLive(env2, 'tok');
  assert.match(env2.root.textContent, /Live run is not ready/);
  assert.ok(env2.all().some(n => n.tagName === 'CODE' && n.textContent === 'NOSANA_BASE_URL'));
  assert.equal(startBtnOf(env2).disabled, true);
});

await test('bootstrap 실패 시 데모는 내장 역할로 돌고 그 사실을 밝힌다', async () => {
  const env = fakeEnv({ fetchImpl: () => Promise.reject(new Error('offline')) });
  await env.flush(); await env.advance(2000);
  assert.match(env.root.textContent, /6 built-in demo roles/);
  await startDemo(env);
  await env.advance(30000);
  assert.match(env.root.textContent, /4 \/ 4 valid opinions/);
});

// ───────── 파란·흰 콘솔 화면 구성 (탐색·실행 기록·전체 화면·진행 수)
const streamRowsShown = (env) => env.all().filter(n => n.tagName === 'LI' && n.className.startsWith('cb-row ')).length;

await test('왼쪽 탐색: Home 이 기본, Guide·Help·Settings 는 실제 내용을 보여 주고 Settings 에 실행 방식이 있다', async () => {
  const env = fakeEnv({ fetchImpl: () => json(200, CATALOGUE) });
  await env.flush();
  assert.equal(env.fk('nav:home').getAttribute('aria-current'), 'page');
  assert.equal(view(env, 'home').hidden, false);
  for (const v of ['guide', 'help', 'settings']) assert.equal(view(env, v).hidden, true);
  env.fk('nav:guide').click();
  assert.equal(view(env, 'guide').hidden, false); assert.equal(view(env, 'home').hidden, true);
  assert.equal(env.fk('nav:guide').getAttribute('aria-current'), 'page');
  assert.equal(env.fk('nav:home').getAttribute('aria-current'), 'false');
  assert.match(view(env, 'guide').textContent, /Let Jev choose your experts/);
  env.fk('nav:help').click();
  assert.match(view(env, 'help').textContent, /self-assessment, not calibrated accuracy/);
  env.fk('nav:settings').click();
  const settings = view(env, 'settings');
  assert.equal(settings.hidden, false);
  assert.ok([...settings.walk()].some(n => n.tagName === 'BUTTON' && n.textContent === 'Live run'), 'mode control lives in Settings');
  assert.ok([...settings.walk()].some(n => n.id === 'cb-token'), 'admin token input lives in Settings');
  env.fk('nav:home').click();
  assert.equal(view(env, 'home').hidden, false);
  // 실행 전에는 편집 영역이 열려 있고, 실행을 시작하면 접히며 Edit project 로 다시 연다 (기존 입력란·전문가 선택 유지)
  const setup = setupOf(env);
  assert.equal(setup.hidden, false);
  assert.ok(!env.all().some(n => n.tagName === 'A' && n.attrs.href === '/lab' && n.parent?.className === 'cb-nav-foot'), 'no legacy lab link in the nav footer');
  assert.ok([...view(env, 'settings').walk()].some(n => n.tagName === 'A' && n.textContent === 'Open the legacy lab'), 'legacy lab stays in Settings');
  await startDemo(env);
  assert.equal(setup.hidden, true);
  assert.equal(env.fk('setup').getAttribute('aria-expanded'), 'false');
  env.fk('setup').click();
  assert.equal(setup.hidden, false);
  assert.equal(env.fk('setup').getAttribute('aria-expanded'), 'true');
  assert.ok([...setup.walk()].some(n => n.id === 'cb-title') && [...setup.walk()].some(n => n.getAttribute('data-fk') === 'x:strategy'));
});

await test('진행 수는 선택한 전문가 수와 맞는다 (4명 선택 → 4명 기준, 완료 후 4 / 4)', async () => {
  const env = fakeEnv({ fetchImpl: () => json(200, CATALOGUE) });
  await env.flush();
  assert.match(env.root.textContent, /4 selected · up to 5/);
  await startDemo(env);
  assert.match(env.root.textContent, /0 of 4 experts finished/);
  assert.ok(!/1 \/ 5|of 5 experts finished/.test(env.root.textContent));
  await env.advance(30000);
  assert.match(env.root.textContent, /4 of 4 experts finished/);
  assert.equal(env.all().filter(n => n.className.startsWith('cb-step is-done')).length, 5, 'all observed steps done');
});

await test('전체 화면: 버튼으로 켜고 Escape·Exit full screen·다른 화면 이동으로 끈다', async () => {
  const env = fakeEnv({ fetchImpl: () => json(200, CATALOGUE) });
  await startDemo(env);
  const panel = env.all().find(n => n.className.startsWith('cb-panel cb-workspace'));
  const log = env.all().find(n => n.id === 'cb-log');
  const full = env.fk('full');
  assert.equal(full.textContent, 'Full screen');
  assert.ok(!log.open, 'execution activity starts collapsed');
  full.click();
  assert.match(panel.className, /is-full/); assert.equal(full.textContent, 'Exit full screen'); assert.equal(full.getAttribute('aria-pressed'), 'true');
  assert.equal(log.open, true, 'full screen opens the execution activity');
  env.doc.key('Escape');
  assert.doesNotMatch(panel.className, /is-full/); assert.equal(full.textContent, 'Full screen');
  assert.equal(log.open, false, 'Escape returns the log to its previous state');
  log.open = true; full.click(); env.doc.key('Escape');
  assert.equal(log.open, true, 'a log the user opened stays open');
  full.click(); full.click();
  assert.doesNotMatch(panel.className, /is-full/);
  full.click(); env.fk('nav:help').click();
  assert.doesNotMatch(panel.className, /is-full/, 'leaving Home exits full screen');
});

await test('Clear view 는 보이는 창만 비우고, 새 줄은 계속 들어오며, 기록·파일은 그대로, Restore history 로 되돌린다', async () => {
  const env = fakeEnv({ fetchImpl: () => json(200, CATALOGUE) });
  await startDemo(env); await env.advance(4000);
  const before = streamRowsShown(env);
  assert.ok(before > 0, 'stream shows reported activity');
  assert.equal(env.fk('restore').disabled, true);
  env.fk('clear').click();
  assert.equal(streamRowsShown(env), 0);
  assert.match(env.root.textContent, /View cleared/);
  assert.equal(env.fk('restore').disabled, false);
  await env.advance(30000);
  const after = streamRowsShown(env);
  assert.ok(after > 0, 'new rows keep arriving after clear');
  assert.match(env.root.textContent, new RegExp(`${before} earlier rows? hidden`));
  assert.match(env.root.textContent, /4 \/ 4 valid opinions/, 'run itself unaffected');
  env.fk('tab:activity').click();
  const actItems = env.all().filter(n => n.tagName === 'LI' && /^k-/.test(n.className)).length;
  assert.ok(actItems >= 5, 'persisted expert activity intact');
  env.fk('restore').click();
  assert.equal(streamRowsShown(env), before + after);
  assert.equal(env.fk('restore').disabled, true);
});

await test('실행 기록은 읽기 전용 표시다: 입력란·명령 프롬프트·CLI 선택이 없다', async () => {
  const env = fakeEnv({ fetchImpl: () => json(200, CATALOGUE) });
  await startDemo(env); await env.advance(3000);
  const stream = env.all().find(n => n.id === 'cb-log');
  assert.equal(stream.tagName, 'DETAILS', 'execution activity sits behind a native disclosure');
  assert.ok(stream.textContent.includes('Execution activity') && stream.textContent.includes('read-only'));
  stream.open = true;
  await env.advance(3000);
  assert.equal(env.all().find(n => n.id === 'cb-log'), stream, 'disclosure is not recreated on updates');
  assert.equal(stream.open, true, 'open state survives updates');
  assert.ok(![...stream.walk()].some(n => ['INPUT', 'TEXTAREA', 'SELECT'].includes(n.tagName)));
  assert.ok(!/\w+@\w+[:$]|\$ $/m.test(stream.textContent));
  assert.match(stream.textContent, /simulated · running · \d+ active · \d+ events?/);
});

// ───────── 임시 Cloudbite 운영자 링크 (#operator=<token>)
const OP_TOKEN = 'cbo_' + Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 37 + 11) & 0xff)).toString('base64url');
/** location·history 가짜. log 에 replaceState·fetch 순서를 남기고, 주소는 replaceState 로만 바뀐다 */
function addressBar(hash, { history = true } = {}) {
  const log = [];
  const location = { pathname: '/cloudbite', search: '?x=1', hash, replace(u) { log.push(['replace', u]); location.hash = ''; } };
  const g = { location };
  if (history) g.history = { state: null, replaceState(s, t, u) { log.push(['replaceState', u]); location.hash = ''; } };
  return { g, log, location };
}
function operatorEnv(hash, handlers = () => json(404, {}), opts) {
  const bar = addressBar(hash, opts);
  const env = fakeEnv({ globals: bar.g, fetchImpl: (url, init, n) => {
    bar.log.push(['fetch', url]);
    if (url === '/api/cloudbite/bootstrap') return json(200, CATALOGUE);
    return handlers(url, init, n);
  } });
  return { env, bar };
}

await test('운영자 조각 읽기: 정확한 형식만 토큰, 틀린 형식도 present 로 지운다', () => {
  assert.deepEqual(core.operatorFragment(`#operator=${OP_TOKEN}`), { present: true, token: OP_TOKEN });
  assert.deepEqual(core.operatorFragment(`#x=1&operator=${OP_TOKEN}`), { present: true, token: OP_TOKEN });
  for (const h of ['#operator=', '#operator', '#operator=cbo_short', `#operator=${OP_TOKEN}A`, `#operator=${OP_TOKEN.slice(0, -1)}B`, `#${OP_TOKEN}`, `#operator=${encodeURIComponent(OP_TOKEN + '+')}`])
    assert.deepEqual(core.operatorFragment(h), { present: true, token: '' }, h.slice(0, 20));
  assert.deepEqual(core.operatorFragment(''), { present: false, token: '' });
  assert.deepEqual(core.operatorFragment('#home'), { present: false, token: '' });
});

await test('운영자 링크: 요청 전에 조각을 지우고, 실제 실행 모드·메모리·입력란에만 두며, 자동 데모·자동 실행이 없다', async () => {
  const { env, bar } = operatorEnv(`#operator=${OP_TOKEN}`, (url, init) => {
    if (url === '/api/cloudbite/projects' && init.method === 'POST') return json(201, { project: liveProject('running', 'running'), accessToken: 'proj-scope-tok' });
    if (url === '/api/cloudbite/projects/proj-1') return json(200, liveProject('completed', 'completed', { updatedAt: 5 }));
    return json(404, {});
  });
  assert.deepEqual(bar.log[0], ['replaceState', '/cloudbite?x=1'], 'fragment erased first, query kept');
  assert.equal(bar.log[1][0], 'fetch');
  assert.equal(bar.location.hash, '');
  await env.flush(); await env.advance(30000);
  assert.deepEqual(env.requests.map(r => r.url), ['/api/cloudbite/bootstrap'], 'no automatic demo or paid run');
  assert.ok(!env.all().some(n => n.className.startsWith('cb-card ')), 'no demo cards');
  assert.match(env.root.textContent, /Live run — server-reported activity/);
  assert.equal(env.byText('BUTTON', 'Live run').getAttribute('aria-pressed'), 'true');
  const tok = env.all().find(n => n.id === 'cb-token');
  assert.equal(tok.value, OP_TOKEN); assert.equal(tok.getAttribute('type'), 'password');
  assert.match(env.root.textContent, /Temporary Cloudbite operator token in memory/);
  assert.match(env.root.textContent, /Temporary Cloudbite operator token \(Cloudbite runs only\)/);
  assert.ok(!/verified|security key/i.test(env.all().find(n => n.className === 'cb-profile-state').textContent));
  assert.ok(!env.root.textContent.includes(OP_TOKEN), 'token never rendered as text');
  for (const k of ['localStorage', 'sessionStorage', 'indexedDB']) assert.equal(env.ctx[k], undefined);
  assert.equal(env.doc.cookie, undefined);
  // 사용자가 직접 계획을 준비하고 그 계획을 실행해야 시작한다
  const start = startBtnOf(env);
  assert.equal(start.textContent, 'Prepare plan');
  assert.equal(start.disabled, false);
  await go(env, start);
  assert.equal(env.previews[0].init.headers['x-admin-token'], OP_TOKEN, 'the plan preview uses the same credential header');
  assert.equal(env.previews[0].init.body, env.requests.find(r => r.init.method === 'POST').init.body, 'the run sends the previewed body unchanged');
  const post = env.requests.find(r => r.init.method === 'POST');
  assert.equal(post.init.headers['x-admin-token'], OP_TOKEN);
  assert.ok(!post.url.includes(OP_TOKEN) && !post.init.body.includes(OP_TOKEN), 'only in the header');
  await env.advance(1500);
  const get = env.requests.find(r => r.url === '/api/cloudbite/projects/proj-1');
  assert.equal(get.init.headers.authorization, 'Bearer proj-scope-tok'); assert.equal(get.init.headers['x-admin-token'], undefined);
  assert.ok(!bar.log.some(([k, u]) => k !== 'fetch' && String(u).includes('cbo_')));
});

await test('운영자 링크: 형식이 틀려도 지우고 토큰을 받지 않으며, 거부·만료는 값 없이 알리고, Clear token 은 메모리·입력란을 비운다', async () => {
  const bad = operatorEnv('#operator=cbo_not-a-real-token', undefined, { history: false });
  assert.deepEqual(bad.bar.log[0], ['replace', '/cloudbite?x=1#'], 'falls back to location.replace without history');
  await bad.env.flush(); await bad.env.advance(30000);
  assert.equal(bad.env.all().find(n => n.id === 'cb-token').value, '');
  assert.match(bad.env.root.textContent, /temporary Cloudbite operator link is malformed/);
  assert.ok(!bad.env.root.textContent.includes('cbo_not-a-real-token'));
  assert.deepEqual(bad.env.requests.map(r => r.url), ['/api/cloudbite/bootstrap'], 'no automatic demo after a malformed link');

  const { env } = operatorEnv(`#operator=${OP_TOKEN}`, () => json(401, { error: 'admin session required' }));
  await env.flush();
  await go(env);
  assert.match(env.root.textContent, /temporary Cloudbite operator token was rejected or has expired/);
  assert.ok(!env.root.textContent.includes(OP_TOKEN));
  env.byText('BUTTON', 'Clear token').click(); await env.flush();
  assert.equal(env.all().find(n => n.id === 'cb-token').value, '');
  assert.match(env.root.textContent, /No admin token/);
  assert.equal(startBtnOf(env).disabled, true, 'live blocked without a token');
});

await test('location·history 가 없는 환경과 조각 없는 공개 데모는 그대로 동작한다', async () => {
  const { env, bar } = operatorEnv('');
  await env.flush(); await env.advance(30000);
  assert.ok(!bar.log.some(([k]) => k !== 'fetch'), 'nothing to erase');
  assert.equal(cards(env), 0, 'public demo waits for the user');
  await startDemo(env); await env.advance(30000);
  assert.match(env.root.textContent, /4 \/ 4 valid opinions/, 'public browser demo runs once started');
  const env2 = fakeEnv({ globals: { location: { hash: `#operator=${OP_TOKEN}` } }, fetchImpl: () => json(200, CATALOGUE) });
  await env2.flush();
  assert.equal(env2.all().find(n => n.id === 'cb-token').value, OP_TOKEN, 'no history/replace: still consumed, nothing thrown');
});

// ───────── 승인된 방문자 세션 (bootstrap.access, 자격 증명은 서버 HttpOnly 쿠키 — JS 는 상태만 본다)
const HOUR = 3600_000;
const accessOf = (over = {}, canCreate = true) => ({ request: { id: 'req-1', name: 'Mina', purpose: 'Try a launch review', status: 'approved', createdAt: Date.now() - 1000,
  expiresAt: Date.now() + HOUR, maxExperts: 3, maxProjects: 1, usedProjects: 0, ...over }, canCreate });
function visitorEnv(access, handlers = () => json(404, {}), { bootstrap } = {}) {
  let boots = 0;
  const env = fakeEnv({ fetchImpl: (url, init, n) => {
    if (url === '/api/cloudbite/bootstrap') { boots++; return bootstrap ? bootstrap(boots) : json(200, { ...CATALOGUE, access }); }
    return handlers(url, init, n);
  } });
  env.boots = () => boots;
  return env;
}
const pick = (env, id) => { const x = env.fk(`x:${id}`); x.checked = true; x.dispatch('change'); };

await test('승인된 방문자: 실제 실행·설정이 열리고 자동 데모·자동 실행 없이 직접 고른 역할로 쿠키만으로 만든다', async () => {
  const env = visitorEnv(null, (url, init) => {
    if (url === '/api/cloudbite/projects' && init.method === 'POST') return json(201, { project: liveProject('running', 'running'), accessToken: 'proj-scope-tok' });
    if (url === '/api/cloudbite/projects/proj-1') return json(200, liveProject('completed', 'completed', { updatedAt: 5 }));
    return json(404, {});
  }, { bootstrap: (n) => json(200, { ...CATALOGUE, access: n === 1 ? accessOf() : accessOf({ usedProjects: 1 }, false) }) });
  await env.flush(); await env.advance(30000);
  assert.deepEqual(env.requests.map(r => r.url), ['/api/cloudbite/bootstrap'], 'no automatic demo or paid run');
  assert.equal(cards(env), 0);
  assert.equal(env.byText('BUTTON', 'Live run').getAttribute('aria-pressed'), 'true');
  assert.equal(env.all().find(n => n.id === 'cb-setup').hidden, false, 'project setup open');
  assert.match(env.root.textContent, /0 selected · up to 3/, 'min(5, server, session) experts');
  assert.equal(env.all().find(n => n.className === 'cb-profile-name').textContent, 'Mina');
  assert.match(env.root.textContent, /Visitor session: 1 of 1 project left/);
  assert.match(env.root.textContent, /Visitor session · ends \d\d:\d\d/);
  assert.equal(env.doc.cookie, undefined);
  assert.equal(startBtnOf(env).disabled, true, 'zero experts: start disabled');
  assert.match(env.root.textContent, /Choose at least one expert/);
  await go(env);
  assert.equal(env.requests.length, 1);
  pick(env, 'strategy'); pick(env, 'biz');
  const start = startBtnOf(env);
  assert.equal(start.disabled, false, 'visitor can run without an admin token');
  await go(env, start);
  const post = env.requests.find(r => r.init.method === 'POST');
  assert.equal(post.init.headers['x-admin-token'], undefined, 'no admin header for a visitor');
  assert.equal(post.init.credentials, 'same-origin');
  assert.deepEqual(JSON.parse(post.init.body).expertIds, ['strategy', 'biz']);
  await env.advance(1500);
  const get = env.requests.find(r => r.url === '/api/cloudbite/projects/proj-1');
  assert.equal(get.init.headers.authorization, 'Bearer proj-scope-tok');
  assert.match(env.root.textContent, /1 \/ 1 valid opinions/);
  assert.equal(env.boots(), 2, 'finished visitor run re-reads the server access state');
  assert.match(env.root.textContent, /0 of 1 project left/);
  assert.equal(startBtnOf(env).disabled, true, 'quota used: no second run');
});

await test('10개 프로젝트 방문자: 첫 실행 뒤 서버가 9개 남음을 알리면 Run again 이 열리고, 10개 모두 쓰면 막힌다', async () => {
  const env = visitorEnv(null, (url, init) => {
    if (url === '/api/cloudbite/projects' && init.method === 'POST') return json(201, { project: liveProject('running', 'running'), accessToken: 'proj-scope-tok' });
    if (url === '/api/cloudbite/projects/proj-1') return json(200, liveProject('completed', 'completed', { updatedAt: 5 }));
    return json(404, {});
  }, { bootstrap: (n) => json(200, { ...CATALOGUE, access: accessOf({ maxProjects: 10, usedProjects: n === 1 ? 0 : 1 }) }) });
  await env.flush();
  assert.match(env.root.textContent, /Visitor session: 10 of 10 projects left/);
  pick(env, 'strategy');
  await go(env);
  await env.advance(1500);
  assert.equal(env.boots(), 2, 'finished visitor run re-reads the server access state');
  assert.match(env.root.textContent, /9 of 10 projects left/);
  assert.match(env.root.textContent, /Your visitor session can run again/);
  const again = startBtnOf(env);
  assert.equal(again.textContent, 'Prepare plan', 'a new plan can be prepared');
  assert.equal(again.disabled, false, 'nine projects left: the visitor may run again');
  assert.equal(env.requests.filter(r => r.init.method === 'POST').length, 1, 'no automatic second run');

  const spent = visitorEnv(accessOf({ maxProjects: 10, usedProjects: 10 }, false));
  await spent.flush(); await spent.advance(30000);
  assert.deepEqual(spent.requests.map(r => r.url), ['/api/cloudbite/bootstrap'], 'exhausted: no automatic demo or run');
  assert.match(spent.root.textContent, /0 of 10 projects left/);
  assert.match(spent.root.textContent, /no projects left/);
  assert.equal(startBtnOf(spent).disabled, true);
});

await test('만료·취소·거절·대기·소진된 방문자 접근은 쓰지 않고 요청 링크를 보인다, 소진된 승인은 자동 데모 없이 막힌 실제 실행', async () => {
  for (const [over, re] of [[{ expiresAt: Date.now() - 1000 }, /has expired/], [{ status: 'revoked' }, /ended your visitor session/], [{ status: 'denied' }, /declined/], [{ status: 'pending' }, /still waiting/]]) {
    const env = visitorEnv(accessOf(over, false));
    await env.flush();
    assert.equal(env.byText('BUTTON', 'Browser demo').getAttribute('aria-pressed'), 'true', 'not treated as a visitor: public demo mode stays');
    assert.equal(cards(env), 0, 'and nothing starts by itself');
    env.byText('BUTTON', 'Live run').click(); await env.flush();
    assert.match(env.root.textContent, re);
    assert.ok(env.all().some(n => n.tagName === 'A' && n.attrs.href === '/cloudbite/request?lang=en' && n.textContent === 'Request visitor access' && n.parent.className === 'cb-warn'));
    assert.equal(startBtnOf(env).disabled, true);
    assert.equal(env.all().find(n => n.className === 'cb-profile-name').textContent, 'Operator');
  }
  const env = visitorEnv(accessOf({ usedProjects: 1 }, false));
  await env.flush(); await env.advance(30000);
  assert.deepEqual(env.requests.map(r => r.url), ['/api/cloudbite/bootstrap'], 'zero quota: no automatic demo');
  assert.equal(env.byText('BUTTON', 'Live run').getAttribute('aria-pressed'), 'true');
  assert.match(env.root.textContent, /no projects left/);
  assert.equal(startBtnOf(env).disabled, true);
});

await test('방문자 생성이 401 이면 오류와 요청 안내, 데모·재시도 없음, 서버 상태를 다시 읽는다', async () => {
  const env = visitorEnv(null, () => json(401, { error: 'visitor session required' }), {
    bootstrap: (n) => json(200, { ...CATALOGUE, access: n === 1 ? accessOf() : accessOf({ status: 'revoked' }, false) }),
  });
  await env.flush();
  pick(env, 'strategy');
  await go(env);
  assert.match(env.root.textContent, /Your visitor session was not accepted/);
  assert.match(env.root.textContent, /\/cloudbite\/request/);
  assert.equal(env.boots(), 2, 'bootstrap re-read after rejection');
  assert.match(env.root.textContent, /ended your visitor session/);
  await env.advance(60000);
  assert.equal(env.requests.filter(r => r.url === '/api/cloudbite/projects').length, 1, 'no retry');
  assert.equal(cards(env), 0, 'no demo substituted');
  assert.match(env.root.textContent, /Live run — server-reported activity/);
});

await test('bootstrap 이 늦어도 아무것도 자동 시작하지 않고 방문자 설정을 연다, 직접 시작한 데모는 그대로 둔다', async () => {
  let release;
  const env = visitorEnv(null, undefined, { bootstrap: () => new Promise(r => { release = () => r({ ok: true, status: 200, json: async () => ({ ...CATALOGUE, access: accessOf() }) }); }) });
  await env.flush(); await env.advance(2500);
  assert.equal(cards(env), 0, 'no automatic demo while bootstrap is slow');
  release(); await env.flush();
  assert.equal(cards(env), 0);
  assert.equal(env.pendingTimers(), 0, 'no demo timers');
  assert.equal(env.byText('BUTTON', 'Live run').getAttribute('aria-pressed'), 'true');
  assert.match(env.root.textContent, /0 selected · up to 3/);
  await env.advance(30000);
  assert.deepEqual(env.requests.map(r => r.url), ['/api/cloudbite/bootstrap']);

  let release2;
  const env2 = visitorEnv(null, undefined, { bootstrap: () => new Promise(r => { release2 = () => r({ ok: true, status: 200, json: async () => ({ ...CATALOGUE, access: accessOf() }) }); }) });
  await env2.flush(); await env2.advance(500);
  await startDemo(env2); // 사용자가 직접 시작
  await env2.advance(2000);
  release2(); await env2.flush();
  assert.ok(cards(env2) > 0, 'manual demo kept');
  assert.equal(env2.byText('BUTTON', 'Browser demo').getAttribute('aria-pressed'), 'true');
  await env2.advance(30000);
  assert.match(env2.root.textContent, /4 \/ 4 valid opinions/);
});

await test('관리자 토큰이 있으면 방문자 쿠키보다 우선해 헤더로 보낸다, 접근 없는 bootstrap 은 공개 데모 그대로', async () => {
  const env = visitorEnv(accessOf(), (url, init) => init.method === 'POST' ? json(201, { project: liveProject('running', 'running'), accessToken: 't' }) : json(200, liveProject('completed', 'completed', { updatedAt: 5 })));
  await env.flush();
  const tok = env.all().find(n => n.id === 'cb-token');
  tok.value = 'adm-secret-123'; tok.dispatch('input'); await env.flush();
  assert.match(env.root.textContent, /selected · up to 5/, 'admin path uses the server limit');
  assert.equal(env.all().find(n => n.className === 'cb-profile-name').textContent, 'Operator');
  for (const id of ['strategy', 'biz', 'trust', 'ux']) pick(env, id);
  await go(env);
  assert.equal(env.requests.find(r => r.init.method === 'POST').init.headers['x-admin-token'], 'adm-secret-123');

  const pub = visitorEnv({ request: null, canCreate: false });
  await pub.flush(); await pub.advance(30000);
  assert.equal(cards(pub), 0, 'public demo waits for the user');
  await startDemo(pub); await pub.advance(30000);
  assert.match(pub.root.textContent, /4 \/ 4 valid opinions/, 'public browser demo runs once started');
  assert.ok(!/Request visitor access.*has expired|no projects left/.test(pub.root.textContent));
});

// ───────── 실패한 방문자 실행 뒤 다시 실행 (서버가 canCreate 를 돌려줄 때만, 자동 실행 없음)
const failedProject = (updatedAt = 5) => ({ ...liveProject('failed', 'failed', { updatedAt }), experts: [{ ...liveProject('failed', 'failed').experts[0], error: 'runner finished without a valid final opinion' }] });
function failedVisitorEnv(accessAfter) {
  return visitorEnv(null, (url, init) => {
    if (url === '/api/cloudbite/projects' && init.method === 'POST') return json(201, { project: liveProject('running', 'running'), accessToken: 'proj-scope-tok' });
    if (url === '/api/cloudbite/projects/proj-1') return json(200, failedProject());
    return json(404, {});
  }, { bootstrap: (n) => json(200, { ...CATALOGUE, access: n === 1 ? accessOf() : accessAfter(n) }) });
}
async function runOnce(env) {
  await env.flush();
  pick(env, 'strategy');
  await go(env);
  await env.advance(1500);
}
const posts = (env) => env.requests.filter(r => r.url === '/api/cloudbite/projects' && r.init.method === 'POST').length;

await test('방문자 실행이 실패하면 서버 상태를 다시 읽고, canCreate 일 때만 Run again 을 연다 — 실패 기록은 남고 자동 실행은 없다', async () => {
  const env = failedVisitorEnv(() => accessOf({ usedProjects: 0 }, true));
  await runOnce(env);
  assert.equal(env.boots(), 2, 'bootstrap re-read after the terminal failure');
  assert.match(env.root.textContent, /0 \/ 1 valid opinions/, 'failure evidence stays on screen');
  assert.match(env.root.textContent, /Failed: 0 valid opinions, 1 failed/);
  assert.match(env.root.textContent, /Your visitor session can run again\. Nothing starts until you open Edit project, prepare a plan and run it\./);
  const again = startBtnOf(env);
  assert.equal(again.textContent, 'Prepare plan');
  assert.equal(again.disabled, false);
  assert.equal(cards(env), 1, 'no demo substituted');
  await env.advance(120000);
  assert.equal(posts(env), 1, 'no automatic paid run');
  assert.equal(env.boots(), 2, 'no further re-reads once the slot is back');
  await go(env, again);
  assert.equal(posts(env), 2, 'explicit Run again creates a new project');
  const [first, second] = env.requests.filter(r => r.init.method === 'POST').map(r => JSON.parse(r.init.body));
  assert.notEqual(first.requestId, second.requestId, 'a new run, not a retry of the failed one');
  assert.equal(env.requests.filter(r => r.init.method === 'POST')[1].init.headers['x-admin-token'], undefined);
});

await test('정리 확인 대기 중이면 이유를 보이고 잠깐씩 다시 읽어 확인되면 연다, 한도 소진·확인 불가도 설명한다', async () => {
  const env = failedVisitorEnv((n) => n < 4 ? { ...accessOf({ usedProjects: 1 }, false), recovery: 'pending' } : accessOf({ usedProjects: 0 }, true));
  await runOnce(env);
  assert.match(env.root.textContent, /Your last run failed\. Run again unlocks once the server confirms its sandboxes were cleaned up/);
  assert.equal(startBtnOf(env).disabled, true, 'not before the server says canCreate');
  assert.ok(env.byText('BUTTON', 'Check again'), 'explicit re-check offered');
  await env.advance(5000);
  assert.equal(env.boots(), 3); assert.equal(startBtnOf(env).disabled, true);
  await env.advance(5000);
  assert.equal(env.boots(), 4);
  assert.equal(startBtnOf(env).disabled, false, 'opens once cleanup is confirmed');
  await env.advance(60000);
  assert.equal(env.boots(), 4, 'stops re-reading'); assert.equal(posts(env), 1, 'no automatic paid run');

  const limit = failedVisitorEnv(() => ({ ...accessOf({ usedProjects: 1 }, false), recovery: 'limit' }));
  await runOnce(limit);
  assert.match(limit.root.textContent, /used all its retries after failed runs/);
  assert.equal(startBtnOf(limit).disabled, true);
  await limit.advance(60000);
  assert.equal(limit.boots(), 2, 'limit is final: no polling');

  const down = failedVisitorEnv(() => ({ ...accessOf({ usedProjects: 1 }, false), recovery: 'unavailable' }));
  await runOnce(down);
  assert.match(down.root.textContent, /could not confirm its cleanup yet/);
  await down.advance(10 * 60_000);
  assert.equal(down.boots(), 1 + 24, 'automatic re-reads after the run are bounded (24)');
  down.byText('BUTTON', 'Check again').click(); await down.flush();
  assert.equal(down.boots(), 26, 'Check again re-reads on demand');
  assert.equal(posts(down), 1);
  assert.equal(cards(down), 1, 'never falls back to the demo');
});

await test('정리 대기 중에 페이지를 다시 열어도 데모 없이 이유를 보이고 다시 읽어 확인되면 연다', async () => {
  const env = visitorEnv(null, () => json(404, {}), { bootstrap: (n) => json(200, { ...CATALOGUE, access: n < 3 ? { ...accessOf({ usedProjects: 1 }, false), recovery: 'pending' } : accessOf() }) });
  await env.flush(); await env.advance(2000);
  assert.equal(cards(env), 0, 'approved visitor: no automatic demo');
  assert.match(env.root.textContent, /Your last run failed/);
  assert.equal(startBtnOf(env).disabled, true);
  await env.advance(10000);
  assert.equal(env.boots(), 3);
  pick(env, 'strategy');
  assert.equal(startBtnOf(env).disabled, false);
  await env.advance(60000);
  assert.equal(env.boots(), 3); assert.equal(posts(env), 0, 'nothing started automatically');
});

await test('관리자 실행이 실패해도 Run again 은 그대로 열리고 방문자 상태를 다시 읽지 않는다', async () => {
  const env = liveEnv((url, init) => {
    if (url === '/api/cloudbite/projects' && init.method === 'POST') return json(201, { project: liveProject('running', 'running'), accessToken: 'tok' });
    if (url === '/api/cloudbite/projects/proj-1') return json(200, failedProject());
    return json(404, {});
  });
  await goLive(env);
  await go(env); await env.advance(1500);
  assert.match(env.root.textContent, /0 \/ 1 valid opinions/);
  assert.equal(env.requests.filter(r => r.url === '/api/cloudbite/bootstrap').length, 1);
  assert.equal(startBtnOf(env).disabled, false, 'owner run-again stays possible');
  assert.equal(startBtnOf(env).textContent, 'Prepare plan');
});

await test('파일 봉투: content 만 꺼내고, 형식이 틀리면 null', () => {
  assert.equal(core.artifactContent({ path: 'out/report.md', label: 'R', bytes: 3, content: 'abc' }, 'out/report.md'), 'abc');
  assert.equal(core.artifactContent({ content: '' }, 'out/report.md'), '');
  for (const bad of [null, 'abc', [], { path: 'out/report.md' }, { content: 5 }, { path: 'other.md', content: 'x' }])
    assert.equal(core.artifactContent(bad, 'out/report.md'), null, JSON.stringify(bad));
  assert.equal(core.domainLabel('design.ui-ux'), 'Ui ux');
  assert.equal(core.domainLabel('product.management'), 'Management');
  assert.equal(core.domainLabel('제품 전략'), '제품 전략', 'human text unchanged');
});

await test('실제 실행 파일: 깨진 봉투는 봉투 글자 대신 오류와 Load again 을 보이고, 다시 불러오면 내용을 보인다', async () => {
  let artCalls = 0;
  const env = liveEnv((url, init) => {
    if (url === '/api/cloudbite/projects' && init.method === 'POST') return json(201, { project: liveProject('running', 'running'), accessToken: 'tok' });
    if (url === '/api/cloudbite/projects/proj-1') return json(200, liveProject('completed', 'completed', { updatedAt: 5 }));
    if (url.includes('/artifact?')) {
      artCalls++;
      if (artCalls === 1) return json(200, { path: 'out/report.md', label: 'Report', bytes: 9 }); // content 없음
      if (artCalls === 2) return Promise.resolve({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad json'); }, text: async () => '<html>' });
      return json(200, { path: 'out/report.md', label: 'Report', bytes: 9, content: 'Real body' });
    }
    return json(404, {});
  });
  await goLive(env);
  await go(env); await env.advance(1500);
  env.fk('tab:artifacts').click(); await env.flush();
  const warn = () => env.all().find(n => n.className === 'cb-warn' && /unexpected format/.test(n.textContent));
  assert.ok(warn(), 'missing content is an explicit error');
  assert.ok(!env.all().some(n => n.tagName === 'PRE'), 'envelope is never shown as file text');
  assert.ok(!env.root.textContent.includes('"bytes"'));
  env.fk('file-reload').click(); await env.flush();
  assert.ok(warn(), 'invalid JSON is an explicit error');
  env.fk('file-reload').click(); await env.flush();
  assert.equal(env.all().find(n => n.tagName === 'PRE').textContent, 'Real body');
  assert.equal(artCalls, 3);
});

const BIG = { ...CATALOGUE, experts: [
  ...['Product Strategist', 'Business Model Analyst', 'UX Researcher', 'Growth Marketer', 'Security Reviewer', 'Data Scientist', 'Legal Counsel', 'Pricing Specialist']
    .map((name, i) => ({ id: `r${i}`, name, domain: i === 7 ? 'strategy.pricing' : `team.role-${i}`, summary: i === 6 ? 'Checks contracts and regulatory exposure.' : '', prompt: 'p', tools: [], outputs: [], source: {} })),
] };
await test('역할 고르기: 기본 6개만 보이고 나머지는 All experts 접기 안에서 검색으로 찾으며, 숨은 선택은 요약된다', async () => {
  const env = fakeEnv({ fetchImpl: () => json(200, BIG) });
  await env.flush();
  const coreIds = env.all().filter(n => /^x:/.test(n.getAttribute('data-fk') || '')).map(n => n.getAttribute('data-fk'));
  assert.deepEqual(coreIds, ['x:r0', 'x:r1', 'x:r2', 'x:r3', 'x:r4', 'x:r5'], 'six core roles');
  const more = env.all().find(n => n.tagName === 'DETAILS' && /cb-more/.test(n.className));
  assert.ok(!more.open, 'the rest is folded');
  assert.match(more.textContent, /All experts \(8\)/);
  assert.ok(env.fk('xa:r6') && env.fk('xa:r7'), 'every other role is selectable inside');
  assert.match(env.root.textContent, /Checks contracts and regulatory exposure\./, 'plain description');
  assert.match(env.root.textContent, /Pricing/, 'machine domain becomes a readable label');
  assert.ok(!/strategy\.pricing|team\.role-/.test(env.root.textContent), 'no machine domain strings');
  const search = env.all().find(n => n.id === 'cb-filter');
  search.value = 'pricing'; search.dispatch('input');
  assert.ok(env.fk('xa:r7') && !env.fk('xa:r6'), 'search narrows the list');
  search.value = 'strategist'; search.dispatch('input');
  assert.ok(env.fk('xa:r0'), 'search also finds core roles');
  search.value = ''; search.dispatch('input');
  const hidden = env.fk('xa:r6'); hidden.checked = true; hidden.dispatch('change');
  const also = env.all().find(n => n.className === 'cb-alsosel');
  assert.equal(also.hidden, false);
  assert.equal(also.textContent, 'Also selected from All experts: Legal Counsel');
  assert.ok(!env.all().some(n => n.className.includes('cb-catalogue') && n.style.maxHeight), 'no nested scroll box');
  assert.match(env.root.textContent, /5 selected · up to 5/);
});

await test('Project details: 이름·맥락은 접기 안에 있고, 그 칸이 틀리면 펼쳐서 오류를 보인다', async () => {
  const env = fakeEnv({ fetchImpl: () => json(200, CATALOGUE) });
  await env.flush();
  const details = env.all().find(n => n.tagName === 'DETAILS' && n.textContent.startsWith('Project details'));
  const inside = [...details.walk()].map(n => n.id);
  assert.ok(inside.includes('cb-title') && inside.includes('cb-context') && !inside.includes('cb-objective'), 'objective first, name/context folded');
  assert.ok(!details.open);
  const title = env.all().find(n => n.id === 'cb-title');
  title.value = ' '; title.dispatch('input');
  await go(env);
  assert.equal(details.open, true, 'opened to show the field with the error');
  assert.equal(cards(env), 0, 'nothing started');
  assert.match(formMsgOf(env), /project name/i);
  assert.equal(setupOf(env).hidden, false);
});

// ───────── 언어 (KO / EN) — 사전은 코어에서 꺼내 쓴다 (문구를 시험에 베끼지 않는다)
const EN = core.DICT.en, KO = core.DICT.ko;
const langBtn = (env, l) => env.fk(`lang:${l}`);
const hrefs = (env) => env.all().filter(n => n.tagName === 'A' && n.attrs.href && n.attrs.href.startsWith('/cloudbite/')).map(n => n.attrs.href);

await test('언어 고르기: 올바른 ?lang= → 브라우저 언어 → en, 다른 질의는 그대로 두고 lang 만 바꾼다', () => {
  assert.equal(core.pickLang('?lang=ko', ['en-US']), 'ko');
  assert.equal(core.pickLang('?lang=en', ['ko-KR']), 'en');
  assert.equal(core.pickLang('?lang=xx', ['ko-KR', 'en']), 'ko', 'invalid ?lang ignored');
  assert.equal(core.pickLang('?lang=KO', []), 'en', 'only exact ko|en accepted');
  assert.equal(core.pickLang('', ['fr-FR', 'ko', 'en']), 'ko', 'first supported navigator language');
  assert.equal(core.pickLang('', ['fr-FR', 'de']), 'en');
  assert.equal(core.pickLang('', [undefined, 42, null]), 'en', 'garbage navigator values → en');
  assert.equal(core.withLang('?x=1&lang=en', 'ko'), '?x=1&lang=ko');
  assert.equal(core.withLang('', 'en'), '?lang=en');
  for (const l of ['en', 'ko']) for (const k of Object.keys(EN)) assert.ok(k in core.DICT[l], `${l}.${k}`);
});

await test('첫 화면 언어: ?lang=ko 나 브라우저 ko 면 한국어로 열고, 주소는 열 때 바꾸지 않는다', async () => {
  for (const [search, languages, want] of [['?lang=ko', ['en-US'], 'ko'], ['', ['ko-KR'], 'ko'], ['?lang=xx', ['fr'], 'en'], ['?lang=en', ['ko'], 'en']]) {
    const log = [];
    const env = fakeEnv({ fetchImpl: () => json(200, CATALOGUE), globals: {
      location: { pathname: '/cloudbite', search, hash: '' }, navigator: { languages, language: languages[0] },
      history: { state: null, replaceState: (s, t, u) => log.push(u) } } });
    await env.flush();
    assert.equal(langBtn(env, want).getAttribute('aria-pressed'), 'true', `${search} ${languages}`);
    assert.equal(langBtn(env, want === 'ko' ? 'en' : 'ko').getAttribute('aria-pressed'), 'false');
    assert.equal(env.doc.documentElement.getAttribute('lang'), want);
    assert.equal(env.all().find(n => n.id === 'cb-title').value, core.DICT[want].sampleTitle);
    assert.ok(hrefs(env).length >= 3 && hrefs(env).every(u => u.endsWith(`?lang=${want}`)));
    assert.deepEqual(log, [], 'no address rewrite on boot');
  }
});

await test('KO / EN 전환은 그 자리에서: 입력·선택·실행·타이머·탭·접기·포커스를 지키고, 고치지 않은 예시만 바꾸며 주소는 replaceState 로만', async () => {
  const log = [];
  const location = { pathname: '/cloudbite', search: '?x=1', hash: '#top' };
  const env = fakeEnv({ fetchImpl: () => json(200, CATALOGUE), globals: { location,
    history: { state: { keep: 1 }, replaceState: (s, t, u) => { log.push([s, u]); location.search = u.slice(u.indexOf('?'), u.indexOf('#')); } } } });
  await env.flush();
  const objective = env.all().find(n => n.id === 'cb-objective');
  objective.value = 'My own objective, typed by me'; objective.dispatch('input');
  const selected = () => env.all().filter(n => (n.getAttribute('data-fk') || '').startsWith('x:') && n.checked).map(n => n.getAttribute('data-fk'));
  const before = selected();
  assert.ok(before.length > 0);
  await startDemo(env);
  await env.advance(1500);
  env.fk('tab:activity').click(); await env.flush();
  const details = env.all().find(n => n.id === 'cb-log'); details.open = true;
  const timersBefore = env.pendingTimers();
  const cardsBefore = cards(env);
  const fetches = env.requests.length;
  langBtn(env, 'ko').focus();
  langBtn(env, 'ko').click(); await env.flush();
  assert.equal(env.requests.length, fetches, 'no refetch, no rerun');
  assert.equal(env.pendingTimers(), timersBefore, 'demo timers untouched');
  assert.equal(cards(env), cardsBefore);
  assert.equal(objective.value, 'My own objective, typed by me', 'user text not rewritten');
  assert.equal(env.all().find(n => n.id === 'cb-title').value, KO.sampleTitle, 'untouched sample follows the language');
  assert.deepEqual(selected(), before);
  assert.equal(env.fk('tab:activity').getAttribute('aria-selected'), 'true', 'tab kept');
  assert.equal(details.open, true, 'expanded section kept');
  assert.equal(env.doc.activeElement, langBtn(env, 'ko'), 'focus kept on the switch');
  assert.equal(langBtn(env, 'ko').getAttribute('aria-pressed'), 'true');
  assert.equal(langBtn(env, 'en').getAttribute('aria-pressed'), 'false');
  assert.equal(env.doc.documentElement.getAttribute('lang'), 'ko');
  assert.equal(env.doc.title, KO.docTitle);
  assert.ok(env.all().some(n => n.className.startsWith('cb-card ') && n.textContent.includes(KO.status.running)));
  assert.equal(env.fk('stop').textContent, KO.stop);
  assert.deepEqual(log, [[{ keep: 1 }, '/cloudbite?x=1&lang=ko#top']], 'history state kept, only the query changes');
  assert.ok(hrefs(env).length >= 3 && hrefs(env).every(u => u.endsWith('?lang=ko')), 'request, QR and owner inbox links carry the language');
  assert.equal(env.all().find(n => n.getAttribute('aria-live') === 'polite').textContent, KO.langChanged);
  await env.advance(30000);
  assert.ok(env.root.textContent.includes(KO.projectStatus.completed), 'the same run finishes in place');
  assert.equal(env.requests.length, fetches);
  langBtn(env, 'ko').click(); await env.flush();
  assert.equal(log.length, 1, 'same language is a no-op');
  langBtn(env, 'en').click(); await env.flush();
  assert.equal(env.all().find(n => n.id === 'cb-title').value, EN.sampleTitle);
  assert.equal(objective.value, 'My own objective, typed by me');
  assert.equal(log.at(-1)[1], '/cloudbite?x=1&lang=en#top');
  for (const k of ['localStorage', 'sessionStorage', 'indexedDB']) assert.equal(env.ctx[k], undefined);
  assert.equal(env.doc.cookie, undefined);
});

await test('언어를 바꾸면 저장된 오류도 그 언어로 다시 그리고, 서버 오류 원문은 그대로 둔다', async () => {
  const env = liveEnv((url, init) => url === '/api/cloudbite/projects' && init.method === 'POST' ? json(500, { error: 'raw server error text' }) : json(404, {}));
  await goLive(env);
  await go(env);
  const before = formMsgOf(env);
  assert.ok(before.includes(EN.httpOther(500)) && before.includes('raw server error text'));
  langBtn(env, 'ko').click(); await env.flush();
  const after = formMsgOf(env);
  assert.ok(after.includes(KO.httpOther(500)) && after.includes('raw server error text'));
  assert.equal(env.all().find(n => n.id === 'cb-token').value, 'adm-secret-123', 'token memory kept');
  assert.equal(env.requests.filter(r => r.init.method === 'POST').length, 1, 'no retry on switch');
});

// ───────── 소유자 로그인 (HttpOnly 쿠키 — JS 는 서버 /owner/session 응답만 믿는다)
const OWNER_IN = () => json(200, { authenticated: true, hasCredentials: true });
function ownerEnv(owner, handlers = () => json(404, {}), globals = {}) {
  return fakeEnv({ owner, globals, fetchImpl: (url, init, n) => url === '/api/cloudbite/bootstrap' ? json(200, CATALOGUE) : handlers(url, init, n) });
}
const okRun = (url, init) => {
  if (url === '/api/cloudbite/projects' && init.method === 'POST') return json(201, { project: liveProject('running', 'running'), accessToken: 'proj-scope-tok' });
  if (url === '/api/cloudbite/projects/proj-1') return json(200, liveProject('completed', 'completed', { updatedAt: 5 }));
  return json(404, {});
};
const profileName = (env) => env.all().find(n => n.className === 'cb-profile-name').textContent;

await test('소유자 로그인: 세션이 true 면 토큰·방문자 한도 없이 실제 실행을 열고, 헤더 없이 쿠키로만 만든다 (자동 실행 없음)', async () => {
  const env = ownerEnv(OWNER_IN, okRun);
  await env.flush(); await env.advance(30000);
  assert.deepEqual(env.ownerCalls.map(c => [c.url, c.init.credentials, c.init.cache]), [['/api/cloudbite/owner/session', 'same-origin', 'no-store']]);
  assert.deepEqual(env.requests.map(r => r.url), ['/api/cloudbite/bootstrap'], 'no automatic run');
  assert.equal(env.byText('BUTTON', 'Live run').getAttribute('aria-pressed'), 'true');
  assert.equal(profileName(env), EN.profileOwner);
  assert.ok(env.root.textContent.includes(EN.ownerSignedIn));
  const start = startBtnOf(env);
  assert.equal(start.disabled, false, 'owner can run with no token');
  await go(env, start);
  const post = env.requests.find(r => r.init.method === 'POST');
  assert.ok(!('x-admin-token' in post.init.headers), 'header omitted entirely (an empty header counts as explicit)');
  assert.equal(post.init.credentials, 'same-origin');
  await env.advance(1500);
  assert.match(env.root.textContent, /1 \/ 1 valid opinions/);
});

await test('소유자 아님 (200 false): 실제 실행은 잠기고 소유자 요청함 링크를 보이며 아무것도 보내지 않는다', async () => {
  const env = ownerEnv(() => json(200, { authenticated: false, hasCredentials: true }), okRun);
  await env.flush();
  assert.equal(env.byText('BUTTON', EN.modeDemo).getAttribute('aria-pressed'), 'true', 'public demo stays default');
  env.byText('BUTTON', 'Live run').click(); await env.flush();
  assert.equal(startBtnOf(env).disabled, true);
  assert.ok(env.all().some(n => n.tagName === 'A' && n.attrs.href === '/cloudbite/requests?lang=en' && n.parent.textContent.includes(EN.ownerSignedOut)));
  await go(env);
  assert.equal(env.requests.filter(r => r.init.method === 'POST').length, 0);
});

await test('세션을 못 읽으면 (500·네트워크·형식 오류) 로그인으로 보지 않는다', async () => {
  for (const owner of [() => json(500, {}), () => Promise.reject(new Error('offline')), () => json(200, { authenticated: 'true', hasCredentials: true }), () => json(200, null)]) {
    const env = ownerEnv(owner, okRun);
    await env.flush();
    env.byText('BUTTON', 'Live run').click(); await env.flush();
    assert.equal(startBtnOf(env).disabled, true);
    assert.notEqual(profileName(env), EN.profileOwner);
    assert.ok(env.fk('owner-recheck'), 'retry offered');
    await go(env);
    assert.equal(env.requests.filter(r => r.init.method === 'POST').length, 0);
  }
  assert.equal(core.normalizeOwnerSession({ authenticated: true }).hasCredentials, false);
  assert.equal(core.normalizeOwnerSession('yes'), null);
});

await test('소유자 실행이 401 이면 로그인 필요를 알리고 데모·재시도 없이 세션을 다시 읽어 잠근다', async () => {
  let n = 0;
  const env = ownerEnv(() => ++n === 1 ? OWNER_IN() : json(200, { authenticated: false, hasCredentials: true }),
    (url, init) => url === '/api/cloudbite/projects' && init.method === 'POST' ? json(401, { error: 'owner session required' }) : json(404, {}));
  await env.flush();
  await go(env);
  await env.advance(30000);
  assert.equal(formMsgOf(env), EN.ownerRejected);
  assert.equal(env.requests.filter(r => r.init.method === 'POST').length, 1, 'no retry');
  assert.equal(cards(env), 0, 'no demo fallback');
  assert.equal(env.byText('BUTTON', 'Live run').getAttribute('aria-pressed'), 'true');
  assert.equal(env.ownerCalls.length, 2, 'session re-read once');
  assert.equal(startBtnOf(env).disabled, true, 'locked until signed in again');
});

await test('직접 넣은 토큰이 있으면 소유자 쿠키보다 앞서 그 헤더만 쓰고, 거부돼도 쿠키로 넘어가지 않는다', async () => {
  const env = ownerEnv(OWNER_IN, (url, init) => url === '/api/cloudbite/projects' && init.method === 'POST' ? json(401, {}) : json(404, {}));
  await env.flush();
  const tok = env.all().find(n => n.id === 'cb-token');
  tok.value = 'wrong-admin'; tok.dispatch('input'); await env.flush();
  assert.equal(profileName(env), EN.profileOperator);
  await go(env); await env.advance(30000);
  const posts = env.requests.filter(r => r.init.method === 'POST');
  assert.equal(posts.length, 1, 'no cookie fallback');
  assert.equal(posts[0].init.headers['x-admin-token'], 'wrong-admin');
  assert.equal(env.ownerCalls.length, 1, 'owner state not touched by a token rejection');
});

await test('로그아웃은 서버에 POST {} 를 보내고 다시 읽은 세션으로만 화면을 바꾼다, 실패하면 알린다', async () => {
  let signedIn = true, fail = false;
  const env = ownerEnv((url) => {
    if (url === '/api/cloudbite/owner/logout') { if (fail) return json(500, {}); signedIn = false; return json(200, { ok: true }); }
    return json(200, { authenticated: signedIn, hasCredentials: true });
  }, okRun);
  await env.flush();
  fail = true;
  env.fk('owner-signout').click(); await env.flush();
  assert.equal(profileName(env), EN.profileOwner, 'still signed in per server');
  assert.ok(env.root.textContent.includes(EN.signOutFailed(EN.httpOther(500))));
  fail = false;
  env.fk('owner-signout').click(); await env.flush();
  const out = env.ownerCalls.filter(c => c.url === '/api/cloudbite/owner/logout');
  assert.equal(out.length, 2);
  assert.equal(out[1].init.method, 'POST'); assert.equal(out[1].init.body, '{}'); assert.equal(out[1].init.credentials, 'same-origin');
  assert.equal(env.ownerCalls.at(-1).url, '/api/cloudbite/owner/session', 'session re-read after logout');
  assert.notEqual(profileName(env), EN.profileOwner);
  assert.equal(startBtnOf(env).disabled, true);
});

await test('포커스·탭 복귀·Settings 로 세션을 다시 읽되 30초에 한 번으로 묶는다', async () => {
  let clock = 1_000_000;
  const RealDate = Date;
  class FakeDate extends RealDate { static now() { return clock; } }
  const winListeners = {};
  const env = ownerEnv(OWNER_IN, okRun, { Date: FakeDate, addEventListener: (t, f) => { (winListeners[t] ||= []).push(f); } });
  await env.flush();
  assert.equal(env.ownerCalls.length, 1);
  const focus = async () => { for (const f of winListeners.focus || []) f(); for (const f of env.doc.listeners.visibilitychange || []) f(); await env.flush(); };
  for (let i = 0; i < 5; i++) await focus();
  env.byText('BUTTON', 'Settings').click(); await env.flush();
  assert.equal(env.ownerCalls.length, 1, 'bounded within the window');
  clock += 31_000;
  await focus();
  assert.equal(env.ownerCalls.length, 2, 'refreshed once after the window');
  await focus();
  assert.equal(env.ownerCalls.length, 2);
});

await test('지식 기반 STA: 페르소나 끝을 보존하고 예제 선택은 한 역할만 고르며 자동 실행하지 않는다', async () => {
  const native = { ...core.DEMO_EXPERTS[0], id: 'probably-primetime-sta', name: 'PrimeTime STA Expert', domain: 'semiconductor-eda.static-timing-analysis', prompt: 'a'.repeat(12500) + 'END OF TRUSTED PERSONA', source: { repository: 'Shinick-Han/pro-bably', path: 'data/experts/primetime-sta.json', revision: 'a'.repeat(40), license: 'Project-authored synthesis', basis: 'curated-knowledge' } };
  const bootstrap = { experts: [...core.DEMO_EXPERTS, native], configuration: { liveReady: true, missing: [], maxExperts: 5 } };
  const normalized = core.normalizeBootstrap(bootstrap);
  assert.ok(normalized.experts.at(-1).prompt.endsWith('END OF TRUSTED PERSONA'));
  assert.equal(normalized.experts.at(-1).source.basis, 'curated-knowledge');
  const env = fakeEnv({ fetchImpl: () => json(200, bootstrap) }); await env.flush();
  env.all().find(n => n.tagName === 'BUTTON' && n.textContent === EN.staExample).click(); await env.flush();
  assert.equal(env.all().find(n => n.id === 'cb-objective').value, EN.staObjective);
  const selected = env.all().filter(n => n.tagName === 'INPUT' && n.checked).map(n => n.id);
  assert.ok(selected.length > 0 && selected.every(id => id.includes('probably-primetime-sta')));
  assert.equal(env.requests.filter(r => r.init.method === 'POST').length, 0);
  assert.equal(cards(env), 0, 'example selection does not start a demo');
});

await test('사용 기록: 서버 원문은 텍스트로, 평가 초안·포커스는 KO/EN 전환 후 유지, 명시 저장만 POST', async () => {
  const id = 'cb' + 'a'.repeat(32), now = Date.now();
  const p = project([run(1, 'completed', { ...opinion('conditional', 55), summary: EVIL })], { id, status: 'completed', createdAt: now, brief: brief({ mode: 'live' }) });
  const row = { id, title: EVIL, mode: 'live', status: 'completed', createdAt: now, updatedAt: now, expiresAt: now + 86400_000, expertCount: 1, feedbackCount: 0, model: 'test' };
  const env = fakeEnv({ globals: { location: { pathname: '/cloudbite/history', search: '?lang=en', hash: '' } }, fetchImpl: (url, init) => {
    if (url === '/api/cloudbite/bootstrap') return json(200, CATALOGUE);
    if (url.startsWith('/api/cloudbite/history?')) return json(200, { rows: [row], next: null, owner: false, retentionDays: 30 });
    if (url.endsWith('/feedback')) return json(200, { ok: true });
    return json(200, { project: p, model: 'test', roles: [], feedback: [], expiresAt: row.expiresAt, canFeedback: true });
  } });
  await env.flush(); assert.equal(view(env, 'history').hidden, false);
  env.fk('hist-record:' + id).click(); await env.flush();
  assert.ok(view(env, 'history').textContent.includes(EVIL)); assert.ok(!env.all().some(n => ['IMG', 'SCRIPT'].includes(n.tagName)));
  const field = () => env.fk(id + ':x1-comment'); field().value = 'My unsent feedback'; field().dispatch('input'); field().focus();
  langBtn(env, 'ko').click(); await env.flush();
  assert.equal(field().value, 'My unsent feedback'); assert.equal(env.doc.activeElement.getAttribute('data-fk'), id + ':x1-comment');
  assert.equal(env.requests.filter(r => r.init.method === 'POST').length, 0);
  env.fk(id + ':x1-save').click(); await env.flush();
  const posts = env.requests.filter(r => r.init.method === 'POST'); assert.equal(posts.length, 1);
  assert.deepEqual(JSON.parse(posts[0].init.body), { expertId: 'x1', rating: 'helpful', comment: 'My unsent feedback' });
  assert.ok(view(env, 'history').textContent.includes('피드백을 저장했습니다.'));
});

await test('사용 기록: 두 단계 삭제와 API 확인 뒤 목록 갱신, 거절된 사용자에게 운영자 리포트 없음', async () => {
  const id = 'cb' + 'b'.repeat(32), p = project([], { id, status: 'completed', createdAt: Date.now() }); let removed = false;
  const env = fakeEnv({ fetchImpl: (url, init) => {
    if (url === '/api/cloudbite/bootstrap') return json(200, CATALOGUE);
    if (url.startsWith('/api/cloudbite/history?')) return json(200, { rows: removed ? [] : [{ id, title: 'Delete QA', mode: 'live', status: 'completed', createdAt: p.createdAt, expertCount: 0 }], owner: false, next: null });
    if (init.method === 'DELETE') { removed = true; return json(200, { ok: true }); }
    return json(200, { project: p, roles: [], feedback: [], model: 'm', expiresAt: Date.now() + 1000, canFeedback: true });
  } });
  env.fk('nav:history').click(); await env.flush(); env.fk('hist-record:' + id).click(); await env.flush();
  env.byText('BUTTON', 'Delete record').click(); await env.flush(); assert.equal(removed, false);
  env.byText('BUTTON', 'Delete permanently').click(); await env.flush(); assert.equal(removed, true);
  assert.ok(!env.fk('hist-record:' + id)); assert.ok(!env.byText('BUTTON', 'Improvement report'));
});

await test('개선 리포트: 운영자만 탭 표시, 실측 집계와 데모 제외·확신도 한계를 KO/EN으로 표시', async () => {
  const report = { analyzed: 3, live: 2, demoExcluded: 1, pending: 1, experts: 3, completed: 3, failed: 0, referenced: 1, confidenceBins: [0,0,3,0,0],
    feedback: { helpful: 0, unhelpful: 1, issues: { 'too-generic': 1 } }, errors: {}, roles: [], models: [], insights: [{ kind: 'confidence', count: 1, total: 1 }] };
  const env = fakeEnv({ owner: () => json(200, { authenticated: true, hasCredentials: true }), fetchImpl: url => {
    if (url === '/api/cloudbite/bootstrap') return json(200, CATALOGUE);
    return url.endsWith('/report') ? json(200, report) : json(200, { rows: [], next: null, owner: true });
  } });
  env.fk('nav:history').click(); await env.flush(); env.byText('BUTTON', 'Improvement report').click(); await env.flush();
  assert.ok(view(env, 'history').textContent.includes('1 server demos excluded'));
  assert.ok(view(env, 'history').textContent.includes('this alone does not prove a defect'));
  langBtn(env, 'ko').click(); await env.flush(); assert.ok(view(env, 'history').textContent.includes('자체 평가이며 정확도가 아닙니다'));
  assert.ok(env.requests.every(r => r.init.method !== 'POST'));
});

// ───────── 역할 카탈로그 (bootstrap.pool, 선택 필드) · 규칙 기반 팀 제안 — 런타임 계약이 들어오기 전까지 명시적 고정값으로
const POOL_EXPERTS = ['Product Manager', 'Business Strategist', 'Pricing Analyst', 'FP&A Analyst', 'UX Architect', 'Software Architect', 'AI Engineer', 'Security Architect', 'Privacy Engineer']
  .map((name, i) => ({ id: `e${i}`, name, domain: 'd', summary: `${name} summary`, prompt: 'p', tools: [], outputs: [], source: i === 6 ? { basis: 'curated-knowledge' } : {} }));
const POOL_MAP = { 1: 'e0', 4: 'e1', 61: 'e2', 62: 'e3', 14: 'e4', 21: 'e5', 31: 'e6', 51: 'e7', 57: 'e8' };
const POOL_NAME = { 1: 'Product Manager', 4: 'Business Strategist', 61: 'Pricing Analyst', 62: 'FP&A Analyst', 14: 'Interaction Designer', 21: 'Software Architect', 31: 'AI Engineer', 51: 'Security Architect', 57: 'Privacy Engineer', 2: 'Customer Discovery Researcher' };
const POOL_KW = { 1: ['mvp', 'roadmap', '출시'], 4: ['strategy', '전략'], 61: ['pricing', '가격'], 62: ['budget', '예산'], 14: ['onboarding', 'ux flow'], 21: ['architecture', '아키텍처'],
  31: ['llm', 'retrieval'], 51: ['security', 'threat', '보안'], 57: ['privacy', 'personal data', '개인정보'], 2: ['interview', 'pricing'] };
const poolEntry = (n, over = {}) => ({
  id: `pool-${String(n).padStart(3, '0')}`, catalogNumber: n, name: POOL_NAME[n] ?? `Role ${n}`, domain: 'd',
  category: n <= 10 ? 'strategy' : n <= 20 ? 'ux' : 'other', categoryLabel: n <= 10 ? { en: 'Strategy', ko: '전략' } : n <= 20 ? { en: 'UX', ko: 'UX 분야' } : { en: 'Other', ko: '기타' },
  mission: `Mission ${n}`, evaluation: 'unvalidated', priority: !!POOL_MAP[n], keywords: POOL_KW[n] ?? [`kw${n}`],
  ...(POOL_MAP[n] ? { expertId: POOL_MAP[n], availability: 'available', knowledge: 'metadata-derived' } : { availability: 'planned', knowledge: 'none' }), ...over,
});
const POOL = { version: 'test-1', entries: Array.from({ length: 100 }, (_, i) => poolEntry(i + 1)), priorityNumbers: [1, 4, 999] };
const POOL_BOOT = { experts: POOL_EXPERTS, configuration: { liveReady: true, missing: [], maxExperts: 5 }, pool: POOL };
const POOL_BRIEF = 'Set pricing and a first-year budget, review security threats and privacy of personal data, and plan the MVP roadmap and architecture';
/** 지금 선택: 기본 6개(x:)와 All experts 의 나머지(xa:, 검색어 없을 때) 상자를 합친다 */
const selectedIds = (env) => env.all().filter(n => /^xa?:/.test(n.getAttribute('data-fk') || '') && n.checked).map(n => n.getAttribute('data-fk').replace(/^xa?:/, '')).sort();
const poolDetailsOf = (env) => env.all().find(n => n.tagName === 'DETAILS' && /cb-pool/.test(n.className));
const suggestOf = (env) => env.all().find(n => n.className === 'cb-suggest');
const poolBoxes = (env) => env.all().filter(n => /^xp:/.test(n.getAttribute('data-fk') || ''));
const setObjective = (env, v) => { const o = env.all().find(n => n.id === 'cb-objective'); o.value = v; o.dispatch('input'); };

await test('pool 정리: 깨진 pool 은 무시하고 bootstrap 은 산다, 중복 id·번호·형식 오류는 버리고 카탈로그 200개 상한, 화면은 권한을 만들지 않는다', () => {
  for (const bad of [null, 'x', 7, { entries: 'no' }, { entries: [] }, { entries: [1, null, { id: 'pool-001' }] }]) {
    const b = core.normalizeBootstrap({ ...POOL_BOOT, pool: bad });
    assert.equal(b.pool, undefined, JSON.stringify(bad)); assert.equal(b.experts.length, 9);
  }
  assert.equal(core.normalizeBootstrap({ experts: POOL_EXPERTS, configuration: {} }).pool, undefined, 'legacy bootstrap has no pool');
  const raw = { version: 'v', priorityNumbers: [1, 1, 3, 'x', 500], entries: [
    poolEntry(1),
    poolEntry(1, { id: 'pool-101' }), // 번호 중복
    poolEntry(3, { id: 'pool-001' }), // id 중복
    poolEntry(4, { id: 'POOL-4' }), poolEntry(5, { catalogNumber: 0 }), poolEntry(6, { catalogNumber: 2.5 }), poolEntry(7, { name: '' }),
    poolEntry(8, { expertId: 'ghost', availability: 'available' }), // 실제 카탈로그에 없는 역할
    poolEntry(9, { expertId: 'e0', availability: 'available' }), // 같은 실행 역할을 두 번째로 가져감
    poolEntry(10, { expertId: 'e1', availability: 'planned' }), // 계획 중인데 expertId 가 있음
    poolEntry(31, { knowledge: 'curated-knowledge', evaluation: 'validated', name: EVIL, keywords: Array.from({ length: 40 }, (_, i) => `k${i}`), category: 'Bad Cat!' }),
    poolEntry(51, { knowledge: 'curated-knowledge', availability: 'yes', mappingNote: 'related scope' }),
    poolEntry(57, { knowledge: 'curated-knowledge' }),
    ...Array.from({ length: 150 }, (_, i) => poolEntry(i + 100, { id: `pool-${100 + i}` })),
  ] };
  const p = core.normalizePool(raw, POOL_EXPERTS);
  const by = (n) => p.entries.find(e => e.catalogNumber === n);
  assert.deepEqual(p.entries.map(e => e.catalogNumber), [1, 8, 9, 10, 31, 51, 57, ...Array.from({ length: 101 }, (_, i) => 100 + i)], 'only valid, unique, numbered 1–200, sorted');
  assert.equal(new Set(p.entries.map(e => e.id)).size, p.entries.length);
  assert.equal(by(8).availability, 'planned'); assert.equal(by(8).expertId, undefined, 'unknown expertId is not runnable');
  assert.equal(by(9).availability, 'planned', 'second mapping of the same expert is not runnable');
  assert.equal(by(10).availability, 'planned'); assert.equal(by(10).expertId, undefined, 'planned never carries a submittable id');
  assert.equal(by(31).evaluation, 'unvalidated', 'client never marks validated');
  assert.equal(by(31).name, EVIL, 'kept as data; rendering is textContent-only');
  assert.equal(by(31).knowledge, 'curated-knowledge', 'kept when the actual expert is curated');
  assert.equal(by(57).knowledge, 'metadata-derived', 'not raised above the actual expert definition');
  assert.equal(by(51).availability, 'planned', 'only the literal available counts');
  assert.equal(by(51).mappingNote, 'related scope');
  assert.equal(by(31).keywords.length, 24); assert.equal(by(31).category, 'other');
  assert.deepEqual(p.priorityNumbers, [1], 'priority numbers must be accepted catalogue numbers');
  const many = core.normalizePool({ entries: Array.from({ length: 260 }, (_, i) => poolEntry(i + 1)) }, POOL_EXPERTS);
  assert.equal(many.entries.length, 200, 'catalogue bound 200, not the 100 selection bound');
  assert.equal(many.entries.at(-1).catalogNumber, 200);
  const pool120 = core.normalizePool({ ...POOL, entries: Array.from({ length: 120 }, (_, i) => poolEntry(i + 1)) }, POOL_EXPERTS);
  assert.equal(pool120.entries.length, 120);
  assert.deepEqual(pool120.entries.slice(100).map(e => e.id), Array.from({ length: 20 }, (_, i) => `pool-${101 + i}`), '101–120 kept');
  const full = core.normalizeBootstrap(POOL_BOOT).pool;
  assert.equal(full.entries.length, 100);
  assert.equal(full.entries.filter(e => e.availability === 'available').length, 9);
  assert.ok(full.entries.every(e => e.evaluation === 'unvalidated'));
});

await test('팀 제안 규칙: 브리프 키워드만, 실행 가능한 실제 역할만, 최대 5명, 결정적이며 근거 키워드를 돌려준다', () => {
  const pool = core.normalizeBootstrap(POOL_BOOT).pool;
  const ids = POOL_EXPERTS.map(e => e.id);
  const picks = core.suggestTeam(POOL_BRIEF, pool.entries, ids, 5);
  assert.deepEqual(picks.map(p => p.entryId), ['pool-001', 'pool-051', 'pool-057', 'pool-021', 'pool-061'], 'more matched keywords first, then priority and number');
  assert.deepEqual(picks.find(p => p.entryId === 'pool-051').matched, ['security', 'threat'], 'threats matches threat by word prefix');
  assert.deepEqual(picks.find(p => p.entryId === 'pool-057').matched, ['privacy', 'personal data']);
  assert.ok(!picks.some(p => p.entryId === 'pool-002'), 'planned roles never suggested even when keywords match');
  assert.deepEqual(core.suggestTeam(POOL_BRIEF, pool.entries, ids, 5), picks, 'deterministic');
  assert.ok(core.suggestTeam(POOL_BRIEF, pool.entries, ids, 9).length > 5, 'larger configured teams are not truncated at five');
  assert.equal(core.suggestTeam(POOL_BRIEF, pool.entries, ids, 2).length, 2, 'respects a lower session limit');
  assert.deepEqual(core.suggestTeam(POOL_BRIEF, pool.entries, ['e0'], 5).map(p => p.expertId), ['e0'], 'only roles in the current catalogue');
  assert.deepEqual(core.suggestTeam('가격과 첫해 예산을 검토', pool.entries, ids, 5).map(p => p.entryId), ['pool-061', 'pool-062'], 'Korean keywords match with particles');
  assert.deepEqual(core.suggestTeam('Weather on the moon', pool.entries, ids, 5), [], 'no match → no suggestion');
  assert.deepEqual(core.suggestTeam('a ux flow', pool.entries, ids, 5).map(p => p.entryId), ['pool-014']);
  assert.deepEqual(core.suggestTeam('luxury llms', pool.entries, ids, 5), [], 'short keywords match whole words only');
  for (const p of picks) assert.deepEqual(Object.keys(p).sort(), ['entryId', 'expertId', 'matched'], 'no score or confidence');
});

await test('옛 bootstrap (pool 없음): 카탈로그·제안은 숨고 기존 6개·All experts 고르기가 그대로다', async () => {
  const env = fakeEnv({ fetchImpl: () => json(200, BIG) });
  await env.flush();
  assert.equal(poolDetailsOf(env).hidden, true); assert.equal(suggestOf(env).hidden, true);
  assert.equal(poolBoxes(env).length, 0);
  assert.equal(env.all().filter(n => /^x:/.test(n.getAttribute('data-fk') || '')).length, 6);
  assert.ok(env.fk('xa:r6'));
});

await test('카탈로그 120 화면: 101–120 항목이 보이고, 탐색 줄은 카탈로그 규모와 프로젝트당 100명 한도를 구분한다 (KO/EN)', async () => {
  const boot = { ...POOL_BOOT, pool: { ...POOL, entries: Array.from({ length: 120 }, (_, i) => poolEntry(i + 1)) } };
  const env = fakeEnv({ fetchImpl: () => json(200, boot) });
  await env.flush();
  assert.match(poolDetailsOf(env).textContent, /Browse the role catalogue \(120 entries · 9 runnable now\)/);
  const foot = () => env.all().find(n => n.className === 'cb-nav-foot').children[0].textContent;
  assert.equal(foot(), 'Independent workspaces · 120 catalogue roles · up to 100 per project');
  langBtn(env, 'ko').click(); await env.flush();
  assert.equal(foot(), '독립 작업공간 · 카탈로그 역할 120종 · 프로젝트당 최대 100명');
  assert.equal(core.DICT.en.navFoot(0, 100), 'Independent workspaces · Up to 100 experts per project', 'before the catalogue loads');
});

await test('역할 카탈로그: 접힌 채로 시작, 기본 6개는 그대로, 계획 역할은 잠겨 고를 수 없고 실행 가능 역할만 선택, 최대 5명', async () => {
  const env = fakeEnv({ fetchImpl: () => json(200, POOL_BOOT) });
  await env.flush();
  const det = poolDetailsOf(env);
  assert.equal(det.hidden, false); assert.equal(det.open, false, 'catalogue folded on the first screen');
  assert.match(det.textContent, /Browse the role catalogue \(100 entries · 9 runnable now\)/);
  assert.deepEqual(env.all().filter(n => /^x:/.test(n.getAttribute('data-fk') || '')).map(n => n.getAttribute('data-fk')), ['x:e0', 'x:e1', 'x:e2', 'x:e3', 'x:e4', 'x:e5']);
  assert.equal(poolBoxes(env).length, 24 + selectedIds(env).length, 'selected roles plus one page, not 100 boxes');
  assert.ok(det.textContent.includes(EN.poolNote));
  const planned = env.fk('xp:pool-002');
  assert.equal(planned.disabled, true);
  assert.ok(planned.parent.textContent.includes(EN.poolPlanned) && planned.parent.textContent.includes(EN.poolUnvalidated));
  const before = selectedIds(env);
  assert.equal(before.length, 4, 'default demo selection unchanged');
  planned.checked = true; planned.dispatch('change'); await env.flush();
  assert.deepEqual(selectedIds(env), before, 'planned role cannot be selected');
  assert.ok(env.fk('xp:pool-014').parent.textContent.includes('runs as UX Architect'), 'plan name kept, runtime name shown');
  const more = env.fk('pool-more');
  for (let i = 0; i < 4 && !more.hidden; i++) { more.click(); await env.flush(); }
  assert.equal(more.hidden, true);
  assert.equal(poolBoxes(env).length, 100);
  const free = ['pool-031', 'pool-051', 'pool-057'];
  const first = env.fk(`xp:${free[0]}`); first.checked = true; first.dispatch('change'); await env.flush();
  assert.equal(selectedIds(env).length, 5);
  assert.match(env.root.textContent, /5 selected · up to 5/);
  const locked = env.fk(`xp:${free[1]}`);
  assert.equal(locked.disabled, true, 'others lock at the limit');
  locked.checked = true; locked.dispatch('change'); await env.flush();
  assert.equal(selectedIds(env).length, 5, 'a sixth is refused even if the event fires');
  // 검색으로 좁혀도 고른 역할은 맨 위에 남는다
  assert.ok(env.all().some(n => n.tagName === 'LABEL' && n.attrs.for === 'cb-pool-q'), 'search has a label');
  const q = env.all().find(n => n.id === 'cb-pool-q');
  q.value = 'customer discovery'; q.dispatch('input');
  const visible = poolBoxes(env).map(n => n.getAttribute('data-fk'));
  assert.ok(visible.includes('xp:pool-002'));
  assert.equal(visible.filter(k => k !== 'xp:pool-002').length, 5, 'all five selected roles stay visible');
  assert.ok(poolBoxes(env).slice(0, 5).every(n => n.checked), 'selected first');
  q.value = '#61'; q.dispatch('input');
  assert.ok(env.fk('xp:pool-061'), 'search by number');
  q.value = 'zzz-nothing'; q.dispatch('input');
  assert.ok(det.textContent.includes(EN.poolNoMatch));
  q.value = ''; q.dispatch('input');
  const show = env.all().find(n => n.id === 'cb-pool-show'); show.value = 'planned'; show.dispatch('change');
  assert.ok(poolBoxes(env).every(n => n.disabled || n.checked), 'planned view: only locked rows besides the selection');
  const cat = env.all().find(n => n.id === 'cb-pool-cat');
  assert.deepEqual(cat.children.map(o => o.textContent), ['All categories', 'Strategy', 'UX', 'Other']);
  // 데모 실행은 고른 실행 역할 5명으로만 돈다
  await go(env);
  assert.equal(cards(env), 5);
  assert.ok(poolBoxes(env).length && poolBoxes(env).every(n => n.disabled), 'catalogue locked while running');
});

await test('팀 제안: 적용 전에는 보여 주기만, 직접 고친 선택은 그대로, Apply 는 선택만 바꾸고 실행·요청·타이머가 없다', async () => {
  const env = fakeEnv({ fetchImpl: () => json(200, POOL_BOOT) });
  await env.flush();
  setObjective(env, POOL_BRIEF);
  const before = selectedIds(env);
  const fetches = env.requests.length, timers = env.pendingTimers();
  env.fk('pool-suggest').click(); await env.flush();
  const box = suggestOf(env);
  assert.ok(box.textContent.includes('Matched keywords: security, threat'));
  assert.ok(box.textContent.includes(EN.suggestHelp(5)), 'explained as rules, not model judgement');
  assert.ok(!/%|confidence|score \d/i.test(box.textContent.replace(EN.suggestHelp(5), '')), 'no invented confidence');
  assert.deepEqual(selectedIds(env), before, 'suggestion alone changes nothing');
  // 사용자가 직접 바꾼 선택은 제안으로 덮이지 않는다
  const manual = env.fk('x:e3'); manual.checked = !manual.checked; manual.dispatch('change'); await env.flush();
  const edited = selectedIds(env);
  assert.notDeepEqual(edited, before);
  assert.ok(suggestOf(env).textContent.includes('Matched keywords'), 'suggestion still shown');
  assert.deepEqual(selectedIds(env), edited);
  env.fk('pool-apply').click(); await env.flush();
  assert.deepEqual(selectedIds(env), ['e0', 'e2', 'e5', 'e7', 'e8']);
  assert.equal(env.requests.length, fetches, 'apply sends nothing');
  assert.equal(env.pendingTimers(), timers, 'apply schedules nothing');
  assert.equal(cards(env), 0, 'nothing runs');
  assert.equal(setupOf(env).hidden, false);
  assert.equal(env.fk('pool-apply').disabled, true, 'already the selection');
  assert.ok(suggestOf(env).textContent.includes(EN.suggestCurrent));
  assert.equal(env.all().find(n => n.getAttribute('aria-live') === 'polite' && n.className === 'cb-sr').textContent, EN.suggestApplied(5));
  // 브리프를 고치면 오래된 제안이라고 알린다
  setObjective(env, 'Something else entirely');
  assert.ok(suggestOf(env).textContent.includes(EN.suggestStale));
  env.fk('pool-suggest').click(); await env.flush();
  assert.ok(suggestOf(env).textContent.includes(EN.suggestEmpty), 'clear fallback when nothing matches');
  assert.equal(env.fk('pool-apply'), undefined);
  setObjective(env, ''); env.all().find(n => n.id === 'cb-title').value = ''; env.all().find(n => n.id === 'cb-context').value = '';
  env.fk('pool-suggest').click(); await env.flush();
  assert.ok(suggestOf(env).textContent.includes(EN.suggestBriefEmpty));
  assert.deepEqual(selectedIds(env), ['e0', 'e2', 'e5', 'e7', 'e8'], 'selection untouched by later suggestions');
});

await test('팀 제안·카탈로그 KO/EN: 입력한 브리프·검색어·분야·보기·제안·선택이 언어 전환 뒤에도 남는다', async () => {
  const env = fakeEnv({ fetchImpl: () => json(200, POOL_BOOT) });
  await env.flush();
  setObjective(env, POOL_BRIEF);
  env.fk('pool-suggest').click(); await env.flush();
  const q = env.all().find(n => n.id === 'cb-pool-q'); q.value = 'architect'; q.dispatch('input');
  const cat = env.all().find(n => n.id === 'cb-pool-cat'); cat.value = 'other'; cat.dispatch('change');
  const show = env.all().find(n => n.id === 'cb-pool-show'); show.value = 'available'; show.dispatch('change');
  const det = poolDetailsOf(env); det.open = true;
  const sel = selectedIds(env);
  langBtn(env, 'ko').click(); await env.flush();
  assert.equal(env.all().find(n => n.id === 'cb-objective').value, POOL_BRIEF);
  assert.equal(q.value, 'architect'); assert.equal(cat.value, 'other'); assert.equal(show.value, 'available'); assert.equal(det.open, true);
  assert.deepEqual(cat.children.map(o => o.textContent), [KO.poolCategoryAll, '전략', 'UX 분야', '기타']);
  assert.deepEqual(poolBoxes(env).map(n => n.getAttribute('data-fk')).filter(k => !sel.includes(POOL_MAP[Number(k.slice(8))])), ['xp:pool-021', 'xp:pool-051'].filter(k => !sel.includes(POOL_MAP[Number(k.slice(8))])), 'same filtered rows');
  assert.deepEqual(selectedIds(env), sel);
  const box = suggestOf(env);
  assert.ok(box.textContent.includes('찾은 키워드: security, threat'), 'suggestion kept and redrawn in Korean');
  assert.ok(!box.textContent.includes(KO.suggestStale), 'switching language is not a brief edit');
  assert.ok(det.textContent.includes(KO.poolNote) && det.textContent.includes(KO.poolUnvalidated));
  assert.ok(env.fk('pool-apply').textContent.includes('적용'));
  // 고치지 않은 예시 브리프로 받은 제안도 번역 때문에 오래됐다고 하지 않는다
  const env2 = fakeEnv({ fetchImpl: () => json(200, POOL_BOOT) });
  await env2.flush();
  env2.fk('pool-suggest').click(); await env2.flush();
  langBtn(env2, 'ko').click(); await env2.flush();
  assert.ok(!suggestOf(env2).textContent.includes(KO.suggestStale));
});

await test('실제 실행 + 카탈로그: 제안 적용은 요청을 보내지 않고, 시작하면 실행 가능한 역할 id 만 보낸다', async () => {
  let created = null;
  const env = fakeEnv({ fetchImpl: (url, init) => {
    if (url === '/api/cloudbite/bootstrap') return json(200, POOL_BOOT);
    if (url === '/api/cloudbite/projects' && init.method === 'POST') { created = JSON.parse(init.body); return json(500, { error: 'stop here' }); }
    return json(404, {});
  } });
  await goLive(env);
  setObjective(env, POOL_BRIEF);
  env.fk('pool-suggest').click(); await env.flush();
  const n = env.requests.length;
  env.fk('pool-apply').click(); await env.flush();
  assert.equal(env.requests.length, n, 'no request on apply');
  assert.equal(created, null);
  await go(env);
  assert.deepEqual([...created.expertIds].sort(), ['e0', 'e2', 'e5', 'e7', 'e8']);
  assert.ok(created.expertIds.every(id => POOL_EXPERTS.some(e => e.id === id)), 'no pool ids or planned roles submitted');
});

await test('방문자 + 카탈로그: 제안은 세션 한도(3명)까지만, 적용해도 요청·한도 변화 없이 직접 시작해야 실행된다', async () => {
  const access = accessOf({ maxProjects: 10, usedProjects: 2 });
  const env = visitorEnv(access, () => json(404, {}), { bootstrap: () => json(200, { ...POOL_BOOT, access }) });
  await env.flush();
  setObjective(env, POOL_BRIEF);
  assert.deepEqual(selectedIds(env), [], 'visitor starts with no hidden selection');
  const left = EN.visitorLeft(8, 10);
  assert.ok(env.root.textContent.includes(left));
  const n = env.requests.length, boots = env.boots();
  env.fk('pool-suggest').click(); await env.flush();
  assert.ok(suggestOf(env).textContent.includes(EN.suggestHelp(3)));
  env.fk('pool-apply').click(); await env.flush();
  assert.deepEqual(selectedIds(env), ['e0', 'e7', 'e8'], 'capped at the visitor limit');
  assert.equal(env.requests.length, n); assert.equal(env.boots(), boots);
  assert.ok(env.root.textContent.includes(left), 'visitor allowance unchanged');
  assert.equal(cards(env), 0);
});

await test('실제 bootstrap (카탈로그 120): 원래 100 역할 유지, 101–120 은 보이고 등록된 만큼만 실행 가능, 5명 한도와 평가 전 상태 유지', async () => {
  const bundled = await build({ stdin: { contents: "export { CLOUDBITE_POOL } from './src/cloudbite-pool.ts'; export { CLOUDBITE_EXPERTS } from './src/cloudbite-personas.ts';", resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, format: 'esm', platform: 'neutral' });
  const actual = await import('data:text/javascript;base64,' + Buffer.from(bundled.outputFiles[0].text).toString('base64'));
  const normalized = core.normalizeBootstrap({ experts: actual.CLOUDBITE_EXPERTS, pool: actual.CLOUDBITE_POOL, configuration: { liveReady: true, missing: [], maxExperts: 5 } });
  // 이 작업 폴더의 런타임은 100 역할일 수 있다 (101–120 지식 묶음은 통합 때 붙는다): 개수는 실제 카탈로그에서 읽는다
  assert.equal(normalized.experts.length, actual.CLOUDBITE_EXPERTS.length);
  assert.ok(normalized.experts.length >= 100);
  assert.equal(normalized.pool.entries.length, 120);
  assert.deepEqual(normalized.pool.entries.map(e => e.catalogNumber), Array.from({ length: 120 }, (_, i) => i + 1), 'no catalogue entry silently dropped');
  assert.ok(normalized.pool.entries.every(e => e.evaluation === 'unvalidated'));
  assert.ok(normalized.pool.entries.slice(0, 100).every(e => e.availability === 'available'));
  for (const e of normalized.pool.entries.slice(100)) {
    const runnable = normalized.experts.some(x => x.id === `cb-role-${e.catalogNumber}`);
    assert.equal(e.availability, runnable ? 'available' : 'planned', e.id);
    assert.equal(e.expertId, runnable ? `cb-role-${e.catalogNumber}` : undefined);
  }
  assert.equal(normalized.pool.entries.filter(e => e.availability === 'available').length, normalized.experts.length);
  assert.equal(normalized.pool.entries.slice(0, 100).filter(e => e.knowledge === 'metadata-derived').length, 4);
  assert.deepEqual([...new Set(normalized.pool.entries.slice(100).map(e => e.category))].sort(), ['biomedical-research', 'chemistry', 'clinical-medicine', 'pharmaceutical-science']);
  assert.ok(normalized.pool.entries.slice(100).every(e => e.categoryLabel.ko && e.categoryLabel.en && e.categoryLabel.ko !== e.categoryLabel.en));
  const allowed = normalized.experts.map(e => e.id);
  for (const [objective, wanted] of [['frontend browser rendering', 'cb-role-022'], ['semiconductor synthesis RTL chiplet', 'cb-role-075'], ['healthcare interoperability clinical', 'cb-role-085'], ['pre-mortem failure', 'cb-role-095']]) {
    const selected = core.suggestTeam(objective, normalized.pool.entries, allowed, 5);
    assert.ok(selected.length <= 5 && selected.some(e => e.expertId === wanted), objective + ' can select its new actual role');
    assert.ok(selected.every(e => allowed.includes(e.expertId)));
  }
});

// ───────── Jev 경로 (configuration.routing, 선택 필드) — 공유 계약이 들어오기 전까지 조정자 계약 모양의 명시적 고정값으로
const ROUTING = { provider: 'typesafe', model: 'jev-1.13.0', ready: true, maxExperts: 5 };
const jevBoot = (routing = ROUTING, extra = {}) => ({ ...CATALOGUE, configuration: { ...CATALOGUE.configuration, routing }, ...extra });
const routeOk = (ids, over = {}) => ({ provider: 'typesafe', model: 'jev-1.13.0', policyVersion: 'jev-routing/v1', evaluatedCount: 4, threshold: 0.5, expertIds: ids,
  matches: ids.map((id, i) => ({ expertId: id, relevance: 0.9 - i * 0.1 })), queryHash: 'qh-1', expiresAt: Date.now() + 600_000, ...over });
const routeReqs = (env) => env.requests.filter(r => r.url === '/api/cloudbite/route');
const projectPosts = (env) => env.requests.filter(r => r.url === '/api/cloudbite/projects' && r.init.method === 'POST');
const jevBoxOf = (env) => env.all().find(n => n.className === 'cb-suggest cb-jev');
const manualOf = (env) => env.all().find(n => n.className === 'cb-manual');
/** 경로 응답을 붙잡아 두었다가 release(응답) 로 보낸다 */
function heldRoute() { const h = { release: null }; h.promise = new Promise(r => { h.release = (status, body) => r({ ok: status >= 200 && status < 300, status, json: async () => body }); }); return h; }
function jevEnv(handlers, { boot = jevBoot(), owner = OWNER_OUT, access } = {}) {
  return fakeEnv({ owner, fetchImpl: (url, init, n) => url === '/api/cloudbite/bootstrap' ? json(200, access ? { ...boot, access } : boot) : handlers(url, init, n) });
}
/** 경로 → 프로젝트 만들기 → 조회까지 성공하는 서버 */
const jevServer = (ids, { route } = {}) => (url, init) => {
  if (url === '/api/cloudbite/route') return route ? route(init) : json(200, routeOk(ids));
  if (url === '/api/cloudbite/projects' && init.method === 'POST') return json(201, { project: liveProject('running', 'running'), accessToken: 'proj-scope-tok' });
  if (url === '/api/cloudbite/projects/proj-1') return json(200, liveProject('completed', 'completed', { updatedAt: 5 }));
  return json(404, {});
};
const setToken = async (env, token) => { const tok = env.all().find(n => n.id === 'cb-token'); tok.value = token; tok.dispatch('input'); await env.flush(); };

await test('Jev accepts teams above five up to the server and visitor limit', () => {
  const ids = Array.from({ length: 100 }, (_, i) => `role-${i}`);
  const result = routeOk(ids);
  result.matches = ids.map(expertId => ({ expertId, relevance: 0.9 }));
  assert.equal(core.normalizeRoute(result, ids, 100).expertIds.length, 100);
  assert.equal(core.normalizeRoute(result, ids, 99), null);
  assert.equal(core.normalizeRoute(routeOk(ids.slice(0, 12)), ids, 12).expertIds.length, 12);
  assert.equal(core.normalizeRoute(routeOk(ids.slice(0, 12)), ids, 5), null);
});

await test('Jev 정리: routing 은 TypeSafe·ready 참거짓일 때만, 경로 응답은 실제 역할 1..max·중복 없음·정책 버전이 맞을 때만', () => {
  const boot = core.normalizeBootstrap(jevBoot({ ...ROUTING, maxExperts: 9, model: 42 }));
  assert.deepEqual(boot.configuration.routing, { provider: 'typesafe', model: 'jev', ready: true, maxExperts: 9 });
  assert.equal(core.normalizeBootstrap(CATALOGUE).configuration.routing, undefined, 'old bootstrap: no capability');
  assert.equal(core.normalizeBootstrap(jevBoot({ provider: 'other', ready: true })).configuration.routing, undefined);
  assert.equal(core.normalizeBootstrap(jevBoot({ provider: 'typesafe', ready: 'yes' })).configuration.routing, undefined);
  const allowed = ['strategy', 'biz', 'trust', 'ux'];
  const ok = core.normalizeRoute({ ...routeOk(['biz', 'ux']), matches: [{ expertId: 'biz', relevance: 0.9 }, { expertId: 'trust', relevance: 0.2 }, { expertId: 'ghost', relevance: 0.1 }] }, allowed, 5);
  assert.deepEqual(ok.expertIds, ['biz', 'ux']);
  assert.deepEqual(ok.matches, [{ expertId: 'biz', relevance: 0.9 }], 'only chosen roles keep their suitability');
  for (const bad of [routeOk([]), routeOk(['biz', 'biz']), routeOk(['biz', 'nope']), routeOk(['biz', 7]), routeOk(['biz'], { provider: 'openai' }), routeOk(['biz'], { policyVersion: 'v2' }),
    routeOk(['biz'], { queryHash: '' }), routeOk(['biz'], { expiresAt: 'soon' }), routeOk(['biz'], { matches: [{ expertId: 'biz', relevance: 'high' }] }), { ...routeOk(['biz']), expertIds: 'biz' }, null])
    assert.equal(core.normalizeRoute(bad, allowed, 5), null, JSON.stringify(bad));
  assert.equal(core.normalizeRoute(routeOk(['strategy', 'biz', 'trust', 'ux']), allowed, 3), null, 'more than the visitor/server limit');
  assert.ok(core.normalizeRoute(routeOk(['strategy', 'biz', 'trust']), allowed, 3));
});

await test('Jev 자동 (소유자·실제 실행): 첫 화면에 경로 요청 없음, 한 번 누르면 경로 → 같은 브리프·requestId 로 만들기, 고른 팀만 보내고 적합도로 표시', async () => {
  const env = jevEnv(jevServer(['biz', 'ux']), { owner: OWNER_IN });
  await env.flush(); await env.advance(30000);
  assert.deepEqual(env.requests.map(r => r.url), ['/api/cloudbite/bootstrap'], 'no Jev call on initial render');
  assert.equal(jevBoxOf(env).hidden, false, 'Jev panel shown');
  assert.equal(manualOf(env).hidden, true, 'manual picking is not the initial UI');
  assert.ok(jevBoxOf(env).textContent.includes(EN.jevTitle) && jevBoxOf(env).textContent.includes(EN.jevManualBtn));
  assert.ok(!jevBoxOf(env).textContent.includes(EN.jevDemoNote), 'live mode: no demo note');
  const start = startBtnOf(env);
  assert.equal(start.disabled, false, 'no selection required');
  await go(env, start);
  const urls = env.requests.map(r => r.url);
  assert.ok(urls.indexOf('/api/cloudbite/route') < urls.indexOf('/api/cloudbite/projects'), 'route before create');
  const [rq] = routeReqs(env), [pp] = projectPosts(env);
  assert.equal(routeReqs(env).length, 1); assert.equal(projectPosts(env).length, 1);
  const rb = JSON.parse(rq.init.body), pb = JSON.parse(pp.init.body);
  assert.deepEqual(Object.keys(rb), ['title', 'objective', 'context', 'requestId'], 'exact route JSON');
  assert.deepEqual(Object.keys(pb), ['title', 'objective', 'context', 'requestId', 'mode', 'expertIds', 'routing'], 'no extra route metadata');
  assert.deepEqual({ title: pb.title, objective: pb.objective, context: pb.context, requestId: pb.requestId }, rb, 'same brief and requestId');
  assert.equal(pb.mode, 'live'); assert.equal(pb.routing, 'jev');
  assert.deepEqual(pb.expertIds, ['biz', 'ux'], 'Jev team, not the default manual selection');
  assert.equal(rq.init.method, 'POST'); assert.equal(rq.init.credentials, 'same-origin'); assert.equal(rq.init.cache, 'no-store');
  assert.ok(!('x-admin-token' in rq.init.headers) && !('x-admin-token' in pp.init.headers), 'owner cookie only');
  await env.advance(1500);
  assert.match(env.root.textContent, /1 \/ 1 valid opinions/);
  const box = jevBoxOf(env).textContent;
  assert.ok(box.includes(EN.jevChosen(2)) && box.includes(EN.jevSuitability('90%')) && box.includes(EN.jevSuitability('80%')));
  assert.ok(!/confidence|accuracy/i.test(box), 'suitability is never labelled confidence or accuracy');
  assert.ok(env.root.textContent.includes(EN.stepRouted), 'progress starts with the Jev step');
});

await test('Jev 자동 (승인된 방문자): 빈 선택에서 시작, 쿠키만, 세션 한도(3)보다 큰 팀은 만들지 않는다', async () => {
  const access = accessOf({ maxProjects: 10 });
  const env = jevEnv(jevServer(['strategy', 'ux']), { access });
  await env.flush();
  assert.deepEqual(selectedIds(env), [], 'visitor starts with no selection');
  assert.equal(startBtnOf(env).disabled, false, 'auto path does not need a manual selection');
  assert.ok(jevBoxOf(env).textContent.includes(EN.jevHelp(3, 'jev-1.13.0')), 'Jev limited to the visitor cap');
  assert.ok(!env.root.textContent.includes(EN.needExpert));
  await go(env);
  const [rq] = routeReqs(env), [pp] = projectPosts(env);
  assert.ok(!('x-admin-token' in rq.init.headers));
  assert.deepEqual(JSON.parse(pp.init.body).expertIds, ['strategy', 'ux']);

  const env2 = jevEnv(jevServer(['strategy', 'biz', 'trust', 'ux']), { access });
  await env2.flush();
  startBtnOf(env2).click(); await env2.flush();
  assert.equal(projectPosts(env2).length, 0, 'over-cap team is not created');
  assert.ok(formMsgOf(env2).includes(EN.routeInvalid));
  assert.equal(setupOf(env2).hidden, false);
});

await test('Jev 자동 (관리자 토큰): 경로·만들기 모두 같은 x-admin-token, 실패·깨진 팀·422·503 이면 만들지 않고 재시도·대체도 없다', async () => {
  const env = jevEnv(jevServer(['trust']));
  await goLive(env);
  await go(env);
  assert.equal(routeReqs(env)[0].init.headers['x-admin-token'], 'adm-secret-123');
  assert.equal(projectPosts(env)[0].init.headers['x-admin-token'], 'adm-secret-123');

  for (const [route, text] of [[() => json(422, { error: 'no relevant experts' }), EN.routeNone], [() => json(503, { error: 'TYPESAFE_API_KEY missing' }), EN.routeUnavailable],
    [() => json(429, {}), EN.http429], [() => json(409, {}), EN.routeConflict], [() => json(200, routeOk(['nope'])), EN.routeInvalid],
    [() => json(200, { ...routeOk(['biz']), policyVersion: 'x' }), EN.routeInvalid], [() => Promise.reject(new Error('down')), EN.routeNetwork]]) {
    const e = jevEnv(jevServer([], { route }));
    await goLive(e);
    startBtnOf(e).click(); await e.flush();
    await e.advance(60000);
    assert.equal(projectPosts(e).length, 0, `no creation: ${text}`);
    assert.equal(routeReqs(e).length, 1, 'no automatic retry');
    assert.ok(formMsgOf(e).includes(text), text);
    assert.equal(cards(e), 0, 'no demo or rule team substituted');
    assert.equal(manualOf(e).hidden, true, 'not silently switched to manual');
    assert.ok(!jevBoxOf(e).textContent.includes(EN.jevChosen(1)), 'no team shown after a failed route');
  }
  const e503 = jevEnv(jevServer([], { route: () => json(503, { error: 'TYPESAFE_API_KEY missing' }) }));
  await goLive(e503); startBtnOf(e503).click(); await e503.flush();
  assert.ok(formMsgOf(e503).includes('TYPESAFE_API_KEY missing'), 'sanitized server error kept verbatim');
});

await test('Jev 고르는 중: 진행 표시·Stop, 취소 뒤 늦은 팀으로 만들지 않는다, 늦은 응답도 버린다', async () => {
  const held = heldRoute();
  const env = jevEnv(jevServer([], { route: () => held.promise }), { owner: OWNER_IN });
  await env.flush();
  await go(env);
  assert.equal(startBtnOf(env).textContent, EN.preparingLabel, 'routing is the first step of preparing a plan');
  assert.equal(startBtnOf(env).disabled, true);
  assert.ok(!env.all().some(n => n.className.startsWith('cb-pill') && !n.hidden && n.textContent === EN.routingPill), 'no project run exists while a plan is prepared');
  assert.ok(jevBoxOf(env).textContent.includes(EN.jevRouting));
  assert.equal(env.all().find(n => n.id === 'cb-objective').disabled, true, 'brief locked while routing');
  assert.equal(env.byText('BUTTON', 'Browser demo').disabled, true, 'mode locked while routing');
  assert.equal(env.fk('jev-toggle').disabled, true, 'auto/manual locked while routing');
  const stop = env.fk('stop');
  assert.equal(stop.hidden, false); assert.equal(stop.disabled, false);
  stop.click(); await env.flush();
  held.release(200, routeOk(['biz'])); await env.flush(); await env.advance(30000);
  assert.equal(projectPosts(env).length, 0, 'cancelled route never creates');
  assert.ok(formMsgOf(env).includes(EN.routeCancelled));
  assert.equal(startBtnOf(env).disabled, false, 'can run again');
});

await test('Jev KO/EN: 고르는 중 언어를 바꿔도 같은 질문·같은 requestId·같은 실행 방식으로 만들고, 자동/직접 선택이 남는다', async () => {
  const held = heldRoute();
  const env = jevEnv(jevServer([], { route: () => held.promise }), { owner: OWNER_IN });
  await env.flush();
  await go(env);
  langBtn(env, 'ko').click(); await env.flush();
  assert.equal(env.all().find(n => n.id === 'cb-title').value, EN.sampleTitle, 'brief not rewritten while routing');
  assert.ok(jevBoxOf(env).textContent.includes(KO.jevRouting));
  assert.equal(startBtnOf(env).textContent, KO.preparingLabel);
  held.release(200, routeOk(['biz'])); await env.flush();
  assert.equal(startBtnOf(env).textContent, KO.runPlanLabel);
  startBtnOf(env).click(); await env.flush();
  const rb = JSON.parse(routeReqs(env)[0].init.body), pb = JSON.parse(projectPosts(env)[0].init.body);
  assert.equal(pb.title, EN.sampleTitle); assert.equal(pb.objective, rb.objective); assert.equal(pb.requestId, rb.requestId);
  assert.equal(pb.mode, 'live');
  assert.ok(jevBoxOf(env).textContent.includes(KO.jevChosen(1)) && jevBoxOf(env).textContent.includes(KO.jevSuitability('90%')));
  assert.equal(routeReqs(env).length, 1, 'language switch never re-routes');

  const env2 = jevEnv(jevServer(['biz']), { owner: OWNER_IN });
  await env2.flush();
  env2.fk('jev-toggle').click(); await env2.flush();
  assert.equal(manualOf(env2).hidden, false);
  langBtn(env2, 'ko').click(); await env2.flush();
  assert.equal(manualOf(env2).hidden, false, 'manual preference survives KO/EN');
  assert.equal(env2.fk('jev-toggle').textContent, KO.jevAutoBtn);
  langBtn(env2, 'en').click(); await env2.flush();
  env2.fk('jev-toggle').click(); await env2.flush();
  assert.equal(manualOf(env2).hidden, true, 'back to Jev');
});

await test('Jev + 브라우저 데모: 경로는 실제 서버 호출, 실행은 이 탭의 시뮬레이션 (프로젝트 API 없음, 데모 표시 유지)', async () => {
  const env = jevEnv(jevServer(['strategy', 'biz']));
  await env.flush();
  await setToken(env, 'adm-secret-123');
  assert.equal(env.byText('BUTTON', 'Browser demo').getAttribute('aria-pressed'), 'true');
  assert.ok(jevBoxOf(env).textContent.includes(EN.jevDemoNote));
  await go(env);
  assert.equal(routeReqs(env).length, 1);
  assert.equal(routeReqs(env)[0].init.headers['x-admin-token'], 'adm-secret-123');
  assert.equal(projectPosts(env).length, 0, 'demo mode stays a browser simulation');
  assert.match(env.root.textContent, /Browser demo — simulated activity and files; no Daytona or Nosana calls/);
  await env.advance(30000);
  assert.match(env.root.textContent, /2 \/ 2 valid opinions/);
  assert.equal(env.byText('BUTTON', 'Browser demo').getAttribute('aria-pressed'), 'true', 'mode preserved');
});

await test('Jev 공개 사용자·준비 안 됨: 유료 경로를 부르지 않고 이유를 보이며, 직접 고르기는 명시적으로만', async () => {
  const env = jevEnv(jevServer(['biz']));
  await env.flush();
  assert.equal(startBtnOf(env).disabled, true, 'no anonymous Jev call');
  assert.ok(jevBoxOf(env).textContent.includes(EN.jevNeedAccess));
  await go(env);
  assert.equal(routeReqs(env).length, 0);
  env.fk('jev-toggle').click(); await env.flush();
  assert.equal(manualOf(env).hidden, false, 'explicit manual browser demo');
  assert.ok(jevBoxOf(env).textContent.includes(EN.jevManualNote));
  assert.equal(startBtnOf(env).disabled, false);
  await go(env); await env.advance(30000);
  assert.equal(routeReqs(env).length, 0, 'manual run never calls Jev');
  assert.match(env.root.textContent, /4 \/ 4 valid opinions/);

  const off = jevEnv(jevServer(['biz']), { owner: OWNER_IN, boot: jevBoot({ ...ROUTING, ready: false }) });
  await off.flush();
  assert.ok(jevBoxOf(off).textContent.includes(EN.jevUnavailable));
  assert.equal(startBtnOf(off).disabled, true, 'not ready: no silent manual/rule fallback');
  assert.equal(manualOf(off).hidden, true);
  startBtnOf(off).click(); await off.flush();
  assert.equal(routeReqs(off).length + projectPosts(off).length, 0);
  off.fk('jev-toggle').click(); await off.flush();
  await go(off);
  assert.equal(JSON.parse(off.previews[0].init.body).routing, undefined, 'manual plan skips Jev');
  assert.equal(routeReqs(off).length, 0); assert.equal(projectPosts(off).length, 1, 'explicit manual live run uses the legacy payload');
  assert.ok(!('routing' in JSON.parse(projectPosts(off)[0].init.body)));
});

await test('Jev 다시 실행: 브리프를 고치면 오래됐다고 알리고, 새 requestId 로 다시 고르며, 실패하면 옛 팀을 쓰지 않는다', async () => {
  let n = 0;
  const env = jevEnv(jevServer([], { route: () => ++n === 1 ? json(200, routeOk(['biz'])) : json(422, { error: 'no relevant experts' }) }), { owner: OWNER_IN });
  await env.flush();
  await go(env); await env.advance(1500);
  assert.match(env.root.textContent, /1 \/ 1 valid opinions/);
  env.fk('setup').click(); await env.flush();
  setObjective(env, 'A different question about hiring');
  assert.ok(jevBoxOf(env).textContent.includes(EN.jevStale));
  await go(env);
  const [r1, r2] = routeReqs(env).map(r => JSON.parse(r.init.body));
  assert.notEqual(r1.requestId, r2.requestId);
  assert.equal(r2.objective, 'A different question about hiring');
  assert.equal(projectPosts(env).length, 1, 'failed re-route creates nothing');
  assert.ok(formMsgOf(env).includes(EN.routeNone));
  assert.ok(!jevBoxOf(env).textContent.includes(EN.jevChosen(1)), 'old team not shown for the edited brief');
});

await test('옛 bootstrap (routing 없음): Jev 상자는 숨고 경로를 부르지 않으며 예전 직접 고르기·만들기 그대로', async () => {
  const env = liveEnv((url, init) => okRun(url, init));
  await goLive(env);
  assert.equal(jevBoxOf(env).hidden, true);
  assert.equal(manualOf(env).hidden, false);
  await go(env);
  assert.equal(routeReqs(env).length, 0);
  const body = JSON.parse(projectPosts(env)[0].init.body);
  assert.ok(!('routing' in body)); assert.ok(body.expertIds.length >= 1);
});

// ───────── Jev 팀 설명 (jev-routing/v2 + project-team/v1, 공유 계약 CloudbiteRoutingHarness)
const TEAM_IDS = ['t0', 't1', 't2', 't3', 't4', 't5', 't6'];
const TEAM_BOOT = { experts: [...TEAM_IDS, 't7', 't8'].map((id, i) => ({ id, name: i === 2 ? EVIL : `Role ${i}`, domain: `d${i}`, summary: 's', prompt: 'p', tools: [], outputs: [], source: {} })),
  configuration: { liveReady: true, missing: [], maxExperts: 9, routing: { ...ROUTING, maxExperts: 9 } } };
const harnessOf = (ids = TEAM_IDS, over = {}) => ({
  version: 'project-team/v1', stages: ['assessment', 'team-review'], eligibleCount: 9,
  perspectives: [
    { id: 'architecture', name: 'Architecture', need: 0.9, status: 'covered', expertIds: [ids[0], ids[1]] },
    { id: 'security', name: 'Security', need: 0.8, status: 'covered', expertIds: [ids[2]] },
    { id: 'finance', name: 'Finance', need: 0.7, status: 'limited', expertIds: [] },
    { id: 'regulatory', name: EVIL, need: 0.75, status: 'uncovered', expertIds: [] },
    { id: 'custom-scope', name: 'Chip timing closure', need: 0.66, status: 'covered', expertIds: [ids[4]] },
  ],
  selections: ids.map((expertId, i) => i === 0 || i === 1 ? { expertId, perspectiveIds: ['architecture'], kind: 'coverage' } : i === 2 ? { expertId, perspectiveIds: ['security'], kind: 'coverage' }
     : i === 4 ? { expertId, perspectiveIds: ['custom-scope'], kind: 'coverage' } : { expertId, perspectiveIds: [], kind: 'additional-domain' }),
  excluded: [{ expertId: 't7', reason: 'overlap', coveredBy: ids[0] }, { expertId: 't8', reason: 'limit' }],
  warnings: ['uncovered-perspectives', 'actor-limit'], peerReview: 'not-performed', ...over });
const routeV2 = (ids = TEAM_IDS, over = {}, harness = harnessOf(ids)) => routeOk(ids, { policyVersion: 'jev-routing/v2', evaluatedCount: 9, harness, ...over });
const ALL_TEAM = [...TEAM_IDS, 't7', 't8'];

await test('Jev v1·v2 정리: 옛 v1 은 설명 없이 그대로, v2 는 7명 팀과 고정 코드 설명을 함께 받는다', () => {
  const v1 = core.normalizeRoute(routeOk(['t0', 't1']), ALL_TEAM, 9);
  assert.equal(v1.policyVersion, 'jev-routing/v1'); assert.equal(v1.harness, undefined);
  const v1extra = core.normalizeRoute(routeOk(['t0'], { harness: { anything: true } }), ALL_TEAM, 9);
  assert.ok(v1extra && v1extra.harness === undefined, 'v1 never carries a team explanation');
  const v2 = core.normalizeRoute(routeV2(), ALL_TEAM, 9);
  assert.equal(v2.policyVersion, 'jev-routing/v2');
  assert.deepEqual(v2.expertIds, TEAM_IDS, 'selected expert ids and order preserved');
  assert.deepEqual(v2.harness, harnessOf(), 'valid explanation kept exactly');
  assert.ok(core.normalizeRoute(routeV2(TEAM_IDS, {}, harnessOf(TEAM_IDS, {warnings:['no-project-perspectives']})), ALL_TEAM, 9), 'thin project warning accepted');
  const extra = core.normalizeRoute(routeV2(TEAM_IDS, {}, { ...harnessOf(), debug: 'raw model text' }), ALL_TEAM, 9);
  assert.ok(!('debug' in extra.harness), 'unknown fields dropped');
  // 100명 한도 유지
  const ids = Array.from({ length: 100 }, (_, i) => `role-${i}`);
  const big = routeV2(ids, { evaluatedCount: 100 }, { ...harnessOf(ids), eligibleCount: 100, perspectives: [], selections: ids.map(expertId => ({ expertId, perspectiveIds: [], kind: 'additional-domain' })), excluded: [], warnings: [] });
  assert.equal(core.normalizeRoute(big, ids, 100).expertIds.length, 100);
  assert.equal(core.normalizeRoute(big, ids, 99), null);
});

await test('Jev v2 카탈로그 120: 평가·자격 후보·제외 목록은 카탈로그 한도(200)까지 받고, 선택은 여전히 100명까지', () => {
  const all = Array.from({ length: 120 }, (_, i) => `cb-role-${String(i + 1).padStart(3, '0')}`);
  const route = (team, over = {}, hover = {}) => routeV2(team, { evaluatedCount: 120, ...over }, { ...harnessOf(team), eligibleCount: team.length, perspectives: [],
    selections: team.map(expertId => ({ expertId, perspectiveIds: [], kind: 'additional-domain' })), warnings: [],
    excluded: all.filter(id => !team.includes(id)).map(expertId => ({ expertId, reason: 'below-threshold' })), ...hover });
  // 120번째 역할 하나만 고르고 나머지 119개를 제외로 설명해도 (100 초과) 버리지 않는다
  const late = core.normalizeRoute(route(['cb-role-120']), all, 5);
  assert.deepEqual(late.expertIds, ['cb-role-120']);
  assert.equal(late.harness.excluded.length, 119);
  // 120명 모두 자격 있고 100명 선택, 20명은 한도로 제외
  const hundred = all.slice(0, 100);
  const full = core.normalizeRoute(route(hundred, {}, { eligibleCount: 120, excluded: all.slice(100).map(expertId => ({ expertId, reason: 'limit' })), warnings: ['actor-limit'] }), all, 100);
  assert.equal(full.expertIds.length, 100); assert.equal(full.harness.eligibleCount, 120); assert.equal(full.harness.excluded.length, 20);
  // 선택 101명은 카탈로그가 커도 거절, 자격 후보가 평가 수·카탈로그 한도를 넘으면 거절, 제외 목록 201개 거절
  assert.equal(core.normalizeRoute(route(all.slice(0, 101)), all, 100), null);
  assert.equal(core.normalizeRoute(route(['cb-role-120'], {}, { eligibleCount: 121 }), all, 5), null);
  const huge = Array.from({ length: 201 }, (_, i) => `x-${i}`);
  assert.equal(core.normalizeRoute(routeV2(['x-0'], { evaluatedCount: 300 }, { ...harnessOf(['x-0']), eligibleCount: 201, perspectives: [], selections: [{ expertId: 'x-0', perspectiveIds: [], kind: 'additional-domain' }], excluded: [], warnings: [] }), huge, 5), null, 'eligibleCount above 200');
  assert.equal(core.normalizeRoute(routeV2(['x-0'], { evaluatedCount: 300 }, { ...harnessOf(['x-0']), eligibleCount: 1, perspectives: [], selections: [{ expertId: 'x-0', perspectiveIds: [], kind: 'additional-domain' }],
    excluded: huge.slice(1).concat('x-extra').map(expertId => ({ expertId, reason: 'below-threshold' })), warnings: [] }), [...huge, 'x-extra'], 5), null, '201 exclusions');
});

await test('Jev v2 깨진 설명: 설명 없음·모르는 코드·카탈로그 밖 id·서로 어긋난 담당이면 팀 전체를 쓰지 않는다', () => {
  const H = harnessOf();
  const p = (i, o) => H.perspectives.map((x, j) => j === i ? { ...x, ...o } : x);
  const sel = (i, o) => H.selections.map((x, j) => j === i ? { ...x, ...o } : x);
  const bad = {
    'no harness': routeOk(TEAM_IDS, { policyVersion: 'jev-routing/v2', evaluatedCount: 9 }),
    'unknown policy': routeV2(TEAM_IDS, { policyVersion: 'jev-routing/v3' }),
    'harness version': routeV2(TEAM_IDS, {}, { ...H, version: 'project-team/v2' }),
    'stages': routeV2(TEAM_IDS, {}, { ...H, stages: ['assessment'] }),
    'peer review claimed': routeV2(TEAM_IDS, {}, { ...H, peerReview: 'performed' }),
    'unknown warning': routeV2(TEAM_IDS, {}, { ...H, warnings: ['team-is-perfect'] }),
    'duplicate warning': routeV2(TEAM_IDS, {}, { ...H, warnings: ['actor-limit', 'actor-limit'] }),
    'unknown status': routeV2(TEAM_IDS, {}, { ...H, perspectives: p(0, { status: 'verified' }) }),
    'unknown reason': routeV2(TEAM_IDS, {}, { ...H, excluded: [{ expertId: 't7', reason: 'worse-answer' }] }),
    'unknown kind': routeV2(TEAM_IDS, {}, { ...H, selections: sel(5, { kind: 'lead' }) }),
    'foreign excluded id': routeV2(TEAM_IDS, {}, { ...H, excluded: [{ expertId: 'ghost', reason: 'limit' }] }),
    'excluded but selected': routeV2(TEAM_IDS, {}, { ...H, excluded: [{ expertId: 't0', reason: 'limit' }] }),
    'foreign coveredBy': routeV2(TEAM_IDS, {}, { ...H, excluded: [{ expertId: 't7', reason: 'overlap', coveredBy: 't8' }] }),
    'overlap without coveredBy': routeV2(TEAM_IDS, {}, { ...H, excluded: [{ expertId: 't7', reason: 'overlap' }] }),
    'perspective cites unselected role': routeV2(TEAM_IDS, {}, { ...H, perspectives: p(1, { expertIds: ['t8'] }) }),
    'covered without experts': routeV2(TEAM_IDS, {}, { ...H, perspectives: p(1, { expertIds: [] }), selections: sel(2, { perspectiveIds: [], kind: 'additional-domain' }) }),
    'uncovered with experts': routeV2(TEAM_IDS, {}, { ...H, perspectives: p(3, { expertIds: ['t5'] }) }),
    'selection claims unlisted perspective': routeV2(TEAM_IDS, {}, { ...H, selections: sel(5, { perspectiveIds: ['security'], kind: 'coverage' }) }),
    'perspective owner missing it': routeV2(TEAM_IDS, {}, { ...H, selections: sel(2, { perspectiveIds: [], kind: 'additional-domain' }) }),
    'coverage without perspectives': routeV2(TEAM_IDS, {}, { ...H, selections: sel(5, { kind: 'coverage' }) }),
    'missing selection': routeV2(TEAM_IDS, {}, { ...H, selections: H.selections.slice(0, 6) }),
    'selection for foreign id': routeV2(TEAM_IDS, {}, { ...H, selections: [...H.selections, { expertId: 'ghost', perspectiveIds: [], kind: 'additional-domain' }] }),
    'need out of range': routeV2(TEAM_IDS, {}, { ...H, perspectives: p(0, { need: 1.5 }) }),
    'malformed perspective id': routeV2(TEAM_IDS, {}, { ...H, perspectives: p(4, { id: '<x>' }), selections: sel(4, { perspectiveIds: ['<x>'] }) }),
    'eligible below team': routeV2(TEAM_IDS, {}, { ...H, eligibleCount: 3 }),
    'eligible above evaluated': routeV2(TEAM_IDS, {}, { ...H, eligibleCount: 10 }),
  };
  for (const [why, body] of Object.entries(bad)) assert.equal(core.normalizeRoute(body, ALL_TEAM, 9), null, why);
});

await test('Jev v2 화면 (소유자·실제 실행): 7명 팀을 그대로 만들고, 관점 요약·빈 관점·한도 경고는 보이며 근거는 접힌 상자에, 글자로만 그린다', async () => {
  const env = jevEnv(jevServer([], { route: () => json(200, routeV2()) }), { owner: OWNER_IN, boot: TEAM_BOOT });
  await env.flush();
  await go(env);
  assert.equal(projectPosts(env).length, 1);
  const pb = JSON.parse(projectPosts(env)[0].init.body);
  assert.deepEqual(pb.expertIds, TEAM_IDS, '7-role team created as chosen');
  assert.deepEqual(Object.keys(pb), ['title', 'objective', 'context', 'requestId', 'mode', 'expertIds', 'routing'], 'no team explanation sent back');
  await env.advance(1500);
  const box = jevBoxOf(env), text = box.textContent;
  assert.ok(text.includes(EN.jevChosen(7)));
  assert.ok(text.includes(EN.teamCoverage(3, 1, 1)), 'concise coverage');
  assert.ok(text.includes(EN.teamWarning['uncovered-perspectives']) && text.includes(EN.teamWarning['actor-limit']), 'fixed warnings translated');
  assert.ok(text.includes(EN.teamGaps('Regulatory')), 'gap uses the localized fixed label, not server text');
  assert.ok(text.includes(EN.teamLimitedList('Finance')));
  assert.ok(text.includes(EN.teamCovers('Architecture')) && text.includes(EN.teamAdditional));
  assert.ok(text.includes(EN.teamCovers('Chip timing closure')), 'unknown perspective id falls back to its name as text');
  const why = [...box.walk()].find(n => n.tagName === 'DETAILS' && /cb-team-why/.test(n.className));
  assert.ok(why, 'detail lives in a disclosure');
  const whyText = why.textContent;
  assert.ok(whyText.includes(EN.teamRationale) && whyText.includes(EN.teamNoPeer), 'suitability vs answer confidence, no peer verification');
  assert.ok(whyText.includes(EN.teamEligible(9, 9)));
  assert.ok(whyText.includes(`Role 7 — ${EN.teamReason.overlap} Role 0`) && whyText.includes(`Role 8 — ${EN.teamReason.limit}`));
  assert.ok(!text.slice(0, text.indexOf(EN.teamWhy)).includes(EN.teamRationale), 'rationale is not shown outside the disclosure');
  assert.ok([...box.walk()].every(n => n.tagName !== 'IMG' && n.tagName !== 'SCRIPT'), 'catalogue names rendered as text');
  assert.equal(env.ctx.__pwn, undefined);
});

await test('Jev v2 KO/EN: 고르는 중 언어를 바꿔도 팀·requestId 가 그대로이고 설명은 그 언어의 고정 문구로 다시 그린다', async () => {
  const held = heldRoute();
  const env = jevEnv(jevServer([], { route: () => held.promise }), { owner: OWNER_IN, boot: TEAM_BOOT });
  await env.flush();
  await go(env);
  langBtn(env, 'ko').click(); await env.flush();
  held.release(200, routeV2()); await env.flush();
  startBtnOf(env).click(); await env.flush();
  const rb = JSON.parse(routeReqs(env)[0].init.body), pb = JSON.parse(projectPosts(env)[0].init.body);
  assert.equal(pb.requestId, rb.requestId); assert.deepEqual(pb.expertIds, TEAM_IDS);
  let text = jevBoxOf(env).textContent;
  assert.ok(text.includes(KO.teamCoverage(3, 1, 1)) && text.includes(KO.teamGaps('규제')) && text.includes(KO.teamWarning['actor-limit']));
  assert.ok(text.includes(KO.teamNoPeer) && text.includes(KO.teamCovers('아키텍처')));
  langBtn(env, 'en').click(); await env.flush();
  text = jevBoxOf(env).textContent;
  assert.ok(text.includes(EN.teamCoverage(3, 1, 1)) && !text.includes(KO.teamNoPeer));
  assert.equal(routeReqs(env).length, 1, 'language switch never re-routes');
  assert.deepEqual(JSON.parse(projectPosts(env)[0].init.body).expertIds, TEAM_IDS);
});

await test('Jev v2 깨진 설명 화면: 만들지 않고 이유를 보이며 팀·설명을 그리지 않는다, 취소 뒤 늦은 v2 팀도 버린다', async () => {
  const env = jevEnv(jevServer([], { route: () => json(200, routeV2(TEAM_IDS, {}, { ...harnessOf(), warnings: ['unknown-code'] })) }), { owner: OWNER_IN, boot: TEAM_BOOT });
  await env.flush();
  await go(env); await env.advance(30000);
  assert.equal(projectPosts(env).length, 0, 'malformed v2 team never launched');
  assert.ok(formMsgOf(env).includes(EN.routeInvalid));
  assert.ok(!jevBoxOf(env).textContent.includes(EN.jevChosen(7)) && !jevBoxOf(env).textContent.includes(EN.teamWhy));
  assert.equal(cards(env), 0);

  const held = heldRoute();
  const env2 = jevEnv(jevServer([], { route: () => held.promise }), { owner: OWNER_IN, boot: TEAM_BOOT });
  await env2.flush();
  startBtnOf(env2).click(); await env2.flush();
  env2.fk('stop').click(); await env2.flush();
  held.release(200, routeV2()); await env2.flush(); await env2.advance(30000);
  assert.equal(projectPosts(env2).length, 0, 'cancelled v2 route never creates');
  assert.ok(formMsgOf(env2).includes(EN.routeCancelled));
  assert.ok(!jevBoxOf(env2).textContent.includes(EN.teamWhy), 'late explanation not shown');
});

console.log(`cloudbite-console: ${pass} passed`);
