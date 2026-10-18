// Cloudbite 콘솔 (src/cloudbite-page.ts 의 CLOUDBITE_JS) 을 브라우저 없이 고정한다: 값 정리·종합·데모 계획은 코어 함수로,
// 화면 동작(데모 시작·취소, 실제 실행 요청 헤더, 취소 뒤 늦은 응답, 몰래 데모로 바꾸지 않음, 글자로만 그리기)은 작은 가짜 DOM 으로.
// 실제 브라우저 확인은 조정자가 한다 — 이 파일은 브라우저 증거가 아니다.
//   node test/cloudbite-console.mjs
import assert from 'node:assert/strict';
import vm from 'node:vm';
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
  for (const [k, v] of Object.entries(core)) out[k] = typeof v === 'function' ? (...a) => { const r = v(...a); return r === undefined || r === null ? r : plain(r); } : plain(v);
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
function fakeEnv({ fetchImpl, globals = {} }) {
  const timers = new Map(); let seq = 0, now = 0;
  const doc = { readyState: 'complete', activeElement: null, createElement: (t) => new Node_(doc, t), getElementById: (id) => id === 'cloudbite' ? root : null,
    listeners: {}, addEventListener(t, f) { (this.listeners[t] ||= []).push(f); },
    key(k) { const e = { key: k, preventDefault() {} }; for (const f of this.listeners.keydown || []) f(e); } };
  const root = new Node_(doc, 'div'); root.id = 'cloudbite'; doc.body = new Node_(doc, 'body'); doc.body.append(root);
  const requests = [];
  const ctx = vm.createContext({
    document: doc, crypto: globalThis.crypto, CSS: { escape: (s) => s }, URL, Blob,
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { at: now + (ms || 0), fn }); return id; },
    clearTimeout: (id) => { timers.delete(id); }, setInterval: () => 0,
    fetch: (url, init = {}) => { requests.push({ url, init }); return fetchImpl(url, init, requests.length); },
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
  return { root, doc, requests, flush, advance, all, byText, fk, ctx, pendingTimers: () => timers.size };
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
  start.click(); await env.flush();
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
  again.click(); await env.flush();
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
  start.click(); await env.flush();
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
  startBtnOf(env).click(); await env.flush();
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
  startBtnOf(env).click(); await env.flush();
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
  assert.match(view(env, 'guide').textContent, /Choose up to five experts/);
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
  // 사용자가 직접 Run experts 를 눌러야 시작한다
  const start = startBtnOf(env);
  assert.equal(start.textContent, 'Run experts');
  assert.equal(start.disabled, false);
  start.click(); await env.flush();
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
  startBtnOf(env).click(); await env.flush();
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
  startBtnOf(env).click(); await env.flush();
  assert.equal(env.requests.length, 1);
  pick(env, 'strategy'); pick(env, 'biz');
  const start = startBtnOf(env);
  assert.equal(start.disabled, false, 'visitor can run without an admin token');
  start.click(); await env.flush();
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
  startBtnOf(env).click(); await env.flush();
  await env.advance(1500);
  assert.equal(env.boots(), 2, 'finished visitor run re-reads the server access state');
  assert.match(env.root.textContent, /9 of 10 projects left/);
  assert.match(env.root.textContent, /Your visitor session can run again/);
  const again = startBtnOf(env);
  assert.equal(again.textContent, 'Run again', 'Run again offered');
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
    assert.ok(env.all().some(n => n.tagName === 'A' && n.attrs.href === '/cloudbite/request' && n.textContent === 'Request visitor access' && n.parent.className === 'cb-warn'));
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
  startBtnOf(env).click(); await env.flush();
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
  startBtnOf(env).click(); await env.flush();
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
  startBtnOf(env).click(); await env.flush();
  await env.advance(1500);
}
const posts = (env) => env.requests.filter(r => r.url === '/api/cloudbite/projects' && r.init.method === 'POST').length;

await test('방문자 실행이 실패하면 서버 상태를 다시 읽고, canCreate 일 때만 Run again 을 연다 — 실패 기록은 남고 자동 실행은 없다', async () => {
  const env = failedVisitorEnv(() => accessOf({ usedProjects: 0 }, true));
  await runOnce(env);
  assert.equal(env.boots(), 2, 'bootstrap re-read after the terminal failure');
  assert.match(env.root.textContent, /0 \/ 1 valid opinions/, 'failure evidence stays on screen');
  assert.match(env.root.textContent, /Failed: 0 valid opinions, 1 failed/);
  assert.match(env.root.textContent, /Your visitor session can run again\. Nothing starts until you open Edit project and select Run again\./);
  const again = startBtnOf(env);
  assert.equal(again.textContent, 'Run again');
  assert.equal(again.disabled, false);
  assert.equal(cards(env), 1, 'no demo substituted');
  await env.advance(120000);
  assert.equal(posts(env), 1, 'no automatic paid run');
  assert.equal(env.boots(), 2, 'no further re-reads once the slot is back');
  again.click(); await env.flush();
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
  startBtnOf(env).click(); await env.flush(); await env.advance(1500);
  assert.match(env.root.textContent, /0 \/ 1 valid opinions/);
  assert.equal(env.requests.filter(r => r.url === '/api/cloudbite/bootstrap').length, 1);
  assert.equal(startBtnOf(env).disabled, false, 'owner run-again stays possible');
  assert.equal(startBtnOf(env).textContent, 'Run again');
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
  startBtnOf(env).click(); await env.flush(); await env.advance(1500);
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
  startBtnOf(env).click(); await env.flush();
  assert.equal(details.open, true, 'opened to show the field with the error');
  assert.equal(cards(env), 0, 'nothing started');
  assert.match(formMsgOf(env), /project name/i);
  assert.equal(setupOf(env).hidden, false);
});

console.log(`cloudbite-console: ${pass} passed`);
