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
  assert.ok(CLOUDBITE_HTML.includes('lang="ko"'));
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
const brief = (over = {}) => ({ title: '100인 AI 자문실 출시', objective: '스타트업 팀 대상 부분 유료 모델로 4주 안에 출시할지 판단', context: '근거와 출처를 보여 줄 예정', expertIds: [], mode: 'demo', requestId: 'r-1', ...over });
const opinion = (direction, confidence, nextActions = []) => ({ direction, confidence, summary: `${direction} 요약`, evidence: ['e'], assumptions: [], nextActions });
const run = (i, status, op, extra = {}) => ({ id: `run-${i}`, expertId: `x${i}`, name: `전문가${i}`, status, activity: [], artifacts: [], updatedAt: 1, ...(op ? { opinion: op } : {}), ...extra });
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
    run(1, 'completed', opinion('support', 90, ['핵심 역할 20개로 범위 제한', '가격 상한 설정'])),
    run(2, 'completed', opinion('concern', 70, ['핵심 역할 20개로  범위 제한'])),
    run(3, 'completed', opinion('support', 50)),
    run(4, 'failed', opinion('concern', 99, ['실패한 행동'])),
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
  assert.ok(!a.actions.some(x => x.text === '실패한 행동'));
  assert.equal(a.supportVoices[0].confidence, 90);
  assert.match(a.headline, /7명 중 3명/);
});

await test('종합: 의견이 없으면 평균·주도 의견이 없고, 동률이면 주도 의견을 고르지 않는다', () => {
  const empty = core.aggregate(project([run(1, 'failed'), run(2, 'queued')]));
  assert.equal(empty.valid, 0); assert.equal(empty.meanConfidence, null); assert.equal(empty.leading, null);
  const tie = core.aggregate(project([run(1, 'completed', opinion('support', 60)), run(2, 'completed', opinion('concern', 60))]));
  assert.equal(tie.leading, null); assert.match(tie.headline, /팽팽/);
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
    assert.ok(e.artifacts.find(x => x.path === 'PROJECT.md').content.includes('4주 안에'));
  }
  const biz = (p) => p.experts.find(e => e.expertId === 'demo-business-model').opinion.direction;
  assert.equal(biz(a1), 'support');
  assert.equal(biz(finish(brief({ objective: '무료 모델로 출시', context: '' }))), 'concern');
  const trust = (p) => p.experts.find(e => e.expertId === 'demo-ai-trust').opinion.direction;
  assert.equal(trust(finish(brief({ context: '의료 상담 포함' }))), 'concern');
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
  assert.match(md, /브라우저 데모 시뮬레이션/); assert.match(md, /실패 1/); assert.match(md, /오류: boom/);
});

// ───────── 가짜 DOM 으로 화면 동작
class Node_ {
  constructor(doc, tag) { this.doc = doc; this.tagName = tag.toUpperCase(); this.children = []; this.attrs = {}; this.listeners = {}; this.parent = null;
    this.className = ''; this._text = ''; this.value = ''; this.checked = false; this.disabled = false; this.hidden = false; this.style = {}; }
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
function fakeEnv({ fetchImpl }) {
  const timers = new Map(); let seq = 0, now = 0;
  const doc = { readyState: 'complete', activeElement: null, createElement: (t) => new Node_(doc, t), getElementById: (id) => id === 'cloudbite' ? root : null, addEventListener() {} };
  const root = new Node_(doc, 'div'); root.id = 'cloudbite'; doc.body = new Node_(doc, 'body'); doc.body.append(root);
  const requests = [];
  const ctx = vm.createContext({
    document: doc, crypto: globalThis.crypto, CSS: { escape: (s) => s }, URL, Blob,
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { at: now + (ms || 0), fn }); return id; },
    clearTimeout: (id) => { timers.delete(id); }, setInterval: () => 0,
    fetch: (url, init = {}) => { requests.push({ url, init }); return fetchImpl(url, init, requests.length); },
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
  return { root, doc, requests, flush, advance, all, byText, ctx, pendingTimers: () => timers.size };
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

await test('첫 화면: 카탈로그를 읽고 명시적 데모를 바로 시작, 적대적 문자열은 글자로만 그린다', async () => {
  const env = fakeEnv({ fetchImpl: (url) => url === '/api/cloudbite/bootstrap' ? json(200, CATALOGUE) : json(404, { error: 'x' }) });
  await env.flush();
  const text = env.root.textContent;
  assert.match(text, /브라우저 데모/); assert.match(text, /실제 Daytona 샌드박스나 Nosana 추론을 만들지 않습니다/);
  assert.ok(env.all().some(n => n.className.startsWith('cb-card ')), 'expert workspace cards visible immediately');
  await env.advance(30000);
  assert.ok(env.root.textContent.includes(EVIL), 'hostile name rendered as literal text');
  assert.ok(!env.all().some(n => ['IMG', 'SCRIPT', 'SVG'].includes(n.tagName)), 'no element created from content');
  assert.equal(env.ctx.__pwn, undefined);
  assert.match(env.root.textContent, /4 \/ 4 유효 의견/);
  assert.match(env.root.textContent, /완료/);
  assert.equal(env.requests.length, 1, 'demo makes no project API calls');
});

await test('데모 취소: 타이머를 멈추고 나중에 완료되지 않는다, 다시 실행하면 새 결과', async () => {
  const env = fakeEnv({ fetchImpl: () => json(200, CATALOGUE) });
  await env.flush();
  await env.advance(2500);
  const cancel = env.byText('BUTTON', '취소');
  assert.equal(cancel.disabled, false);
  cancel.click(); await env.flush();
  assert.equal(env.pendingTimers(), 0, 'all demo timers cleared');
  await env.advance(60000);
  assert.match(env.root.textContent, /취소됨/);
  assert.match(env.root.textContent, /0 \/ 4 유효 의견/);
  assert.ok(!env.root.textContent.includes('out/result.json 제출'));
  const again = env.byText('BUTTON', '다시 실행');
  assert.equal(again.disabled, false);
  again.click(); await env.flush();
  await env.advance(30000);
  assert.match(env.root.textContent, /4 \/ 4 유효 의견/);
});

await test('작업공간 탭: 파일 탭은 실제 파일 내용을, 페르소나 탭은 역할 정의를 보여 준다', async () => {
  const env = fakeEnv({ fetchImpl: () => json(200, CATALOGUE) });
  await env.flush(); await env.advance(30000);
  env.all().find(n => n.getAttribute('data-fk') === 'tab:artifacts').click();
  const pre = env.all().find(n => n.tagName === 'PRE');
  assert.match(pre.textContent, /## 권고: /, 'default file is out/report.md content');
  env.all().find(n => n.getAttribute('data-fk') === 'file:out/result.json').click();
  assert.ok(env.all().find(n => n.tagName === 'PRE').textContent.includes('"direction"'));
  env.all().find(n => n.getAttribute('data-fk') === 'file:WORKORDER.md').click();
  assert.match(env.all().find(n => n.tagName === 'PRE').textContent, /작업 지시서/);
  env.all().find(n => n.getAttribute('data-fk') === 'tab:persona').click();
  assert.match(env.all().find(n => n.tagName === 'PRE').textContent, /AI 역할이며 실제 인물/);
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
  env.byText('BUTTON', '취소').click(); await env.flush(); // 첫 화면 데모를 멈춘다
  env.byText('BUTTON', '실제 실행').click(); await env.flush();
  const tok = env.all().find(n => n.id === 'cb-token');
  tok.value = token; tok.dispatch('input'); await env.flush();
}
const liveProject = (status, expStatus, extra = {}) => ({ id: 'proj-1', brief: { ...brief({ mode: 'live' }) }, status, createdAt: 1, updatedAt: extra.updatedAt ?? 1,
  experts: [{ id: 'r1', expertId: 'strategy', name: '제품 전략가', status: expStatus, activity: [{ id: 'a', at: 1, kind: 'tool', message: 'python run.py' }], artifacts: [{ path: 'out/report.md', label: '보고서' }], updatedAt: 1,
    ...(expStatus === 'completed' ? { opinion: opinion('support', 77) } : {}) }] });

await test('실제 실행: 관리자 토큰 헤더로 만들고 범위 토큰으로 조회, 토큰은 저장소에 쓰지 않는다', async () => {
  const env = liveEnv((url, init) => {
    if (url === '/api/cloudbite/projects' && init.method === 'POST') return json(201, { project: liveProject('running', 'running'), accessToken: 'proj-scope-tok' });
    if (url === '/api/cloudbite/projects/proj-1') return json(200, liveProject('completed', 'completed', { updatedAt: 5 }));
    if (url.startsWith('/api/cloudbite/projects/proj-1/artifact')) return Promise.resolve({ ok: true, status: 200, text: async () => '# 실제 보고서 ' + EVIL });
    return json(404, { error: 'nope' });
  });
  await goLive(env);
  const start = env.byText('BUTTON', '전문가 작업 시작') || env.byText('BUTTON', '다시 실행');
  assert.equal(start.disabled, false);
  start.click(); await env.flush();
  const post = env.requests.find(r => r.init.method === 'POST' && r.url === '/api/cloudbite/projects');
  assert.equal(post.init.headers['x-admin-token'], 'adm-secret-123');
  const sent = JSON.parse(post.init.body);
  assert.equal(sent.mode, 'live'); assert.ok(sent.requestId); assert.ok(sent.expertIds.length >= 1);
  assert.ok(!/Daytona.*key|apiKey/i.test(post.init.body));
  assert.match(env.root.textContent, /실제 실행 — 서버가/);
  await env.advance(1500);
  const get = env.requests.find(r => r.url === '/api/cloudbite/projects/proj-1');
  assert.equal(get.init.headers.authorization, 'Bearer proj-scope-tok');
  assert.equal(get.init.headers['x-admin-token'], undefined, 'admin token not sent on poll');
  assert.match(env.root.textContent, /1 \/ 1 유효 의견/);
  env.all().find(n => n.getAttribute('data-fk') === 'tab:artifacts').click(); await env.flush();
  const art = env.requests.find(r => r.url.includes('/artifact?'));
  assert.equal(art.url, '/api/cloudbite/projects/proj-1/artifact?expert=strategy&path=out%2Freport.md');
  assert.equal(art.init.headers.authorization, 'Bearer proj-scope-tok');
  assert.ok(env.root.textContent.includes('# 실제 보고서 ' + EVIL));
  assert.ok(!env.all().some(n => n.tagName === 'IMG'));
  for (const k of ['localStorage', 'sessionStorage', 'indexedDB']) assert.equal(env.ctx[k], undefined);
});

await test('실제 실행 실패는 오류로 보여 주고 데모로 몰래 바꾸지 않는다', async () => {
  const env = liveEnv(() => json(503, { error: 'DAYTONA_API_KEY 설정 없음' }));
  await goLive(env);
  const cardsBefore = env.all().filter(n => n.className.startsWith('cb-card ')).length;
  (env.byText('BUTTON', '다시 실행') || env.byText('BUTTON', '전문가 작업 시작')).click(); await env.flush();
  assert.match(env.root.textContent, /서버 실행 설정이 준비되지 않았습니다. — DAYTONA_API_KEY 설정 없음/);
  assert.equal(env.all().filter(n => n.className.startsWith('cb-card ')).length, 0, 'no demo cards substituted');
  assert.ok(cardsBefore > 0);
  assert.match(env.root.textContent, /실제 실행 — 서버가/);
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
  const start = env.byText('BUTTON', '다시 실행') || env.byText('BUTTON', '전문가 작업 시작');
  start.click();
  assert.equal(start.disabled, true, 'disabled while in flight');
  await env.flush();
  await env.advance(1300); // 조회 요청이 나가고 응답은 붙잡혀 있다
  assert.ok(releasePoll, 'poll in flight');
  env.byText('BUTTON', '취소').click(); await env.flush();
  const cancelReq = env.requests.find(r => r.url.endsWith('/cancel'));
  assert.equal(cancelReq.init.headers.authorization, 'Bearer tok2');
  releasePoll(); await env.flush(); await env.advance(10000);
  assert.match(env.root.textContent, /취소됨/);
  assert.match(env.root.textContent, /0 \/ 1 유효 의견/, 'stale completed poll ignored');
});

await test('형식이 깨진 생성 응답은 오류가 된다, 준비 안 된 서버는 실제 실행을 막고 설정 이름만 보여 준다', async () => {
  const env = liveEnv(() => json(201, { project: { id: 'x' }, accessToken: '' }));
  await goLive(env);
  (env.byText('BUTTON', '다시 실행') || env.byText('BUTTON', '전문가 작업 시작')).click(); await env.flush();
  assert.match(env.root.textContent, /서버 응답 형식이 올바르지 않습니다/);

  const env2 = fakeEnv({ fetchImpl: () => json(200, { ...CATALOGUE, configuration: { liveReady: false, missing: ['NOSANA_BASE_URL', 'DAYTONA_API_KEY'], maxExperts: 5 } }) });
  await goLive(env2, 'tok');
  assert.match(env2.root.textContent, /실제 실행 준비 안 됨/);
  assert.ok(env2.all().some(n => n.tagName === 'CODE' && n.textContent === 'NOSANA_BASE_URL'));
  assert.equal((env2.byText('BUTTON', '다시 실행') || env2.byText('BUTTON', '전문가 작업 시작')).disabled, true);
});

await test('bootstrap 실패 시 데모는 내장 역할로 돌고 그 사실을 밝힌다', async () => {
  const env = fakeEnv({ fetchImpl: () => Promise.reject(new Error('offline')) });
  await env.flush(); await env.advance(2000);
  assert.match(env.root.textContent, /데모 전용 내장 역할 6개/);
  await env.advance(30000);
  assert.match(env.root.textContent, /4 \/ 4 유효 의견/);
});

console.log(`cloudbite-console: ${pass} passed`);
