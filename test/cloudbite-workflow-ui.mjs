// Cloudbite 콘솔의 워크플로 1단계 화면 (src/cloudbite-page.ts 의 CLOUDBITE_JS) 을 브라우저 없이 고정한다:
// 선택 단계·응답 언어(화면 언어와 별개)·접힌 호출 상한, 실제 실행의 "계획 준비 → 이 계획으로 실행" 두 걸음, 고정 본문 그대로 실행,
// 의미 있는 편집마다 계획 버리기, 실패·재시도·멈춤, PMC 가져오기(신원·이용 허락·절·빠진 부분·발췌 미리 보기·고른 것만 합치기·한도).
// test/cloudbite-decision-ui.mjs 와 같은 모양의 작은 가짜 DOM 이다. 실제 브라우저·공급자 증거가 아니다.
//   node tools/build-cloudbite-console.mjs && node test/cloudbite-workflow-ui.mjs
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { CLOUDBITE_JS } from '../src/cloudbite-page.ts';

let pass = 0;
const test = async (name, fn) => { await fn(); pass++; console.log(`  ok   ${name}`); };
const EVIL = '<img src=x onerror="globalThis.__pwn=1"><script>globalThis.__pwn=2</script>';
const plain = (v) => JSON.parse(JSON.stringify(v));

// ───────── 코어 함수
let core = null;
vm.runInContext(CLOUDBITE_JS, vm.createContext({ __cloudbiteTestHook: (c) => { core = c; }, crypto: globalThis.crypto }));
assert.ok(core);
const { EN, KO } = { EN: core.DICT.en, KO: core.DICT.ko };

await test('사전: 새 문구는 EN·KO 가 같은 열쇠를 갖고, 비용을 추정하지 않는다고 밝힌다', () => {
  for (const k of ['wfStage', 'wfLang', 'budgetTitle', 'prepareLabel', 'runPlanLabel', 'planNoCost', 'planJev', 'pmcTitle', 'pmcError', 'pmcAdd', 'docBytes'])
    assert.ok(k in EN && k in KO, k);
  for (const k of ['wfStageName', 'wfLangName', 'budgetField', 'planSource', 'pmcError']) assert.deepEqual(Object.keys(KO[k]).sort(), Object.keys(EN[k]).sort(), k);
  assert.match(EN.planNoCost, /No price is estimated/); assert.match(KO.planNoCost, /비용을 추정하지 않습니다/);
  assert.match(EN.planJev(1), /separate from the Nosana budget/); assert.match(EN.planJev(0), /none/);
  assert.ok(!/\$|USD|₩|원\)/.test(JSON.stringify([EN.planNosana(10, 8, 1, 1), KO.planNosana(10, 8, 1, 1)])), 'no currency in the envelope');
});

const NO_BUDGET = { maxExperts: '', maxModelCalls: '', maxReviewCalls: '', maxMemoCalls: '' };
await test('parseWorkflow: 빈 칸은 보내지 않고, 예산은 넷 다 또는 넷 다 비움, 범위·정수만', () => {
  assert.deepEqual(plain(core.parseWorkflow('', '', NO_BUDGET)), { extras: {}, issues: [] });
  assert.deepEqual(plain(core.parseWorkflow('design', 'ko', NO_BUDGET).extras), { stage: 'design', responseLanguage: 'ko' });
  assert.deepEqual(plain(core.parseWorkflow('later', 'fr', NO_BUDGET).extras), {}, 'unknown values are not sent');
  const partial = core.parseWorkflow('', '', { ...NO_BUDGET, maxExperts: '3' });
  assert.equal(partial.extras.budget, undefined); assert.equal(partial.issues[0].text(EN), EN.vBudgetPartial);
  const full = core.parseWorkflow('', '', { maxExperts: '3', maxModelCalls: '28', maxReviewCalls: '0', maxMemoCalls: '1' });
  assert.deepEqual(plain(full.extras.budget), { maxExperts: 3, maxModelCalls: 28, maxReviewCalls: 0, maxMemoCalls: 1 });
  const bad = core.parseWorkflow('', '', { maxExperts: '0', maxModelCalls: '805', maxReviewCalls: '1.5', maxMemoCalls: '2' });
  assert.equal(bad.issues.length, 4); assert.equal(bad.extras.budget, undefined);
  assert.equal(bad.issues[0].text(EN), 'Max roles: enter a whole number from 1 to 100.');
  assert.equal(bad.issues[1].text(KO), '전체 모델 호출 상한: 1–804 사이의 정수를 넣어 주세요.');
});

const previewOf = (ids, over = {}) => ({ expertIds: ids, assignments: [], budget: { maxExperts: ids.length, maxModelCalls: ids.length * 8 + 4, maxReviewCalls: 3, maxMemoCalls: 1 },
  envelope: { sandboxMaximum: ids.length, nosanaMaximum: ids.length * 8 + 4, expertMaximum: ids.length * 8, reviewMaximum: 3, memoMaximum: 1, jevCalls: 0 }, warnings: [], ...over });
const ASSIGN = (expertId, over = {}) => ({ expertId, stage: 'design', question: `What should ${expertId} decide?`, optionIds: ['option-2'], deliverables: ['A risk list'],
  requiredEvidence: ['Cite doc-1'], boundaries: ['No legal advice'], perspectiveIds: ['p1'], source: 'manual-scope', ...over });

await test('normalizePreview: 계약 모양 그대로만 받고, 보낸 팀과 다르거나 모양이 하나라도 틀리면 null', () => {
  const ok = previewOf(['x1', 'x2'], { assignments: [ASSIGN('x1')], warnings: ['w'] });
  assert.deepEqual(plain(core.normalizePreview(ok, ['x1', 'x2'])), ok);
  assert.equal(core.normalizePreview(ok, ['x2', 'x1']), null, 'team order must match');
  for (const bad of [{ ...ok, envelope: { ...ok.envelope, jevCalls: -1 } }, { ...ok, budget: { ...ok.budget, maxReviewCalls: 4 } },
    { ...ok, assignments: [ASSIGN('x9')] }, { ...ok, assignments: [ASSIGN('x1', { optionIds: ['option-9'] })] }, { ...ok, assignments: [ASSIGN('x1', { source: 'guess' })] },
    { ...ok, warnings: 'w' }, { ...ok, envelope: { ...ok.envelope, cost: 1, nosanaMaximum: '9' } }, null, []])
    assert.equal(core.normalizePreview(bad, ['x1', 'x2']), null);
});

const PMC = {
  article: { pmcid: 'PMC7654321', doi: '10.1000/xyz', title: `Trial results ${EVIL}`, license: 'CC BY 4.0', sourceUrl: 'https://pmc.example/articles/PMC7654321', retrievedAt: '2026-10-19T00:00:00Z' },
  documents: [
    { id: 'doc-1', name: 'PMC7654321-abstract.md', content: 'Abstract excerpt: response rate 41%.', origin: 'PMC OAI-PMH GetRecord · PMC7654321 · part=abstract · CC BY 4.0' },
    { id: 'doc-2', name: 'PMC7654321-results.md', content: `Results excerpt ${EVIL}`, origin: 'PMC OAI-PMH GetRecord · PMC7654321 · part=results · CC BY 4.0' },
    { id: 'doc-3', name: 'PMC7654321-methods.md', content: 'Methods excerpt.', origin: 'PMC OAI-PMH GetRecord · PMC7654321 · part=methods · CC BY 4.0' },
  ],
  sections: [{ id: 's1', title: 'Results', locator: 'sec[2]', characters: 12000 }, { id: 's2', title: 'Methods', locator: 'sec[1]', characters: 9000 }],
  warnings: ['Results truncated to 8,000 characters', 'Table 2 omitted (image only)'],
};
await test('normalizePmc: 발췌 원문·출처를 그대로 두고, 한도·모양이 틀리면 null (꾸며 채우지 않음)', () => {
  assert.deepEqual(plain(core.normalizePmc(PMC)), PMC);
  for (const bad of [{ ...PMC, documents: [] }, { ...PMC, documents: [{ ...PMC.documents[0], content: 'x'.repeat(8001) }] },
    { ...PMC, documents: Array(7).fill(PMC.documents[0]) }, { ...PMC, article: { ...PMC.article, sourceUrl: 'javascript:alert(1)' } },
    { ...PMC, article: { ...PMC.article, pmcid: '7654321' } }, { ...PMC, sections: [{ id: 's', title: 't', locator: 'l', characters: -1 }] }, { ...PMC, warnings: null }])
    assert.equal(core.normalizePmc(bad), null);
});

await test('근거 한도: 48 KiB 바이트 한도는 한글 원문에도 걸리고, 출처(origin)는 보낼 때 남는다', () => {
  const ko = (n) => ({ name: `k${n}.md`, content: '가'.repeat(7000) });
  const two = [ko(1), ko(2)];
  assert.ok(core.docAccept('k3.md', '가'.repeat(7000), two).error, 'three 7,000-char Korean files exceed 48 KiB');
  assert.match(core.docAccept('k3.md', '가'.repeat(7000), two).error(EN), /larger than 48 KiB/);
  assert.ok(core.docAccept('a3.md', 'a'.repeat(7000), [{ name: 'a1', content: 'a'.repeat(7000) }, { name: 'a2', content: 'a'.repeat(7000) }]).doc, 'ASCII fits');
  assert.deepEqual(plain(core.docsPayload([{ key: 1, name: 'n', content: 'c', origin: 'o' }, { key: 2, name: 'u', content: 'd' }])),
    [{ id: 'doc-1', name: 'n', content: 'c', origin: 'o' }, { id: 'doc-2', name: 'u', content: 'd' }]);
});

// ───────── 가짜 DOM
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
const CATALOGUE = {
  experts: ['x1', 'x2', 'x3'].map((id, i) => ({ id, name: `Expert ${i + 1}`, domain: 'd', summary: 's', prompt: 'p', tools: [], outputs: [], source: {} })),
  configuration: { liveReady: true, missing: [], maxExperts: 5 },
};
const ROUTING_BOOT = { ...CATALOGUE, configuration: { ...CATALOGUE.configuration, routing: { provider: 'typesafe', model: 'jev-1.13.0', ready: true, maxExperts: 5 } } };
const routeOk = (ids) => json(200, { provider: 'typesafe', model: 'jev', policyVersion: 'jev-routing/v1', evaluatedCount: 3, threshold: 0.5, expertIds: ids,
  matches: ids.map(id => ({ expertId: id, relevance: 0.9 })), queryHash: 'q', expiresAt: Date.now() + 600000 });
const runningProject = (b) => ({ id: 'proj-1', status: 'running', createdAt: 1, updatedAt: 1, brief: { ...b, expertIds: b.expertIds },
  experts: b.expertIds.map((id, i) => ({ id: `run-${i}`, expertId: id, name: id, status: 'running', activity: [], artifacts: [], updatedAt: 1 })) });
/** 기본 서버: 경로 → x1,x2 / 미리보기는 보낸 팀을 그대로 / 만들기는 받은 브리프로 / 조회는 그대로 / PMC 는 PMC */
function server(over = {}) {
  return (url, init) => {
    if (over[url]) return over[url](init);
    if (url === '/api/cloudbite/route') return routeOk(['x1', 'x2']);
    if (url === '/api/cloudbite/preview') { const b = JSON.parse(init.body); return json(200, previewOf(b.expertIds, { envelope: { ...previewOf(b.expertIds).envelope, jevCalls: b.routing ? 1 : 0 } })); }
    if (url === '/api/cloudbite/projects' && init.method === 'POST') return json(201, { project: runningProject(JSON.parse(init.body)), accessToken: 'proj-tok' });
    if (url === '/api/cloudbite/pmc/import') return json(200, PMC);
    return json(404, {});
  };
}
function fakeEnv(fetchImpl, { boot = CATALOGUE } = {}) {
  const timers = new Map(); let seq = 0, now = 0;
  const doc = { readyState: 'complete', activeElement: null, createElement: (t) => new Node_(doc, t), getElementById: (id) => id === 'cloudbite' ? root : null,
    listeners: {}, addEventListener(t, f) { (this.listeners[t] ||= []).push(f); } };
  doc.documentElement = new Node_(doc, 'html');
  const root = new Node_(doc, 'div'); root.id = 'cloudbite'; doc.body = new Node_(doc, 'body'); doc.body.append(root);
  const requests = [];
  const ctx = vm.createContext({
    document: doc, crypto: globalThis.crypto, CSS: { escape: (s) => s }, URL, URLSearchParams, Blob,
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { at: now + (ms || 0), fn }); return id; },
    clearTimeout: (id) => { timers.delete(id); }, setInterval: () => 0,
    fetch: (url, init = {}) => {
      if (String(url).startsWith('/api/cloudbite/owner/')) return json(200, { authenticated: false, hasCredentials: false });
      if (url === '/api/cloudbite/bootstrap') return json(200, boot);
      requests.push({ url, init }); return fetchImpl(url, init, requests.length);
    },
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
  const byId = (id) => all().find(n => n.id === id);
  return { root, doc, ctx, requests, flush, advance, all, byText, fk, byId };
}
const setValue = async (env, id, value) => { const n = env.byId(id); n.value = value; n.dispatch('input'); n.dispatch('change'); await env.flush(); };
/** 예시 브리프는 화면 언어를 바꾸면 번역되어 바뀐다 (그것도 의미 있는 편집). 언어 전환을 볼 때는 직접 쓴 브리프로 둔다 */
const ownBrief = async (env) => { await setValue(env, 'cb-title', 'Mine'); await setValue(env, 'cb-objective', 'My objective'); await setValue(env, 'cb-context', 'My context'); };
const goLive = async (env) => { await env.flush(); env.byText('BUTTON', 'Live run').click(); await env.flush(); await setValue(env, 'cb-token', 'adm-secret-123'); };
const selectTwo = async (env) => {
  for (const id of ['x1', 'x2', 'x3']) {
    const box = env.fk(`x:${id}`), want = id !== 'x3';
    if (box.checked !== want) { box.checked = want; box.dispatch('change'); await env.flush(); }
  }
};
const start = (env) => env.fk('start');
const click = async (env, k) => { env.fk(k).click(); await env.flush(); };
const bodies = (env, url) => env.requests.filter(r => r.url === url && r.init.method === 'POST').map(r => r.init.body);
const planOf = (env) => env.all().find(n => n.className === 'cb-plan');
const formMsg = (env) => env.all().filter(n => n.className === 'cb-formmsg' && n.getAttribute('role') === 'alert').map(n => n.textContent).join(' | ');
const langBtn = (env, l) => env.fk(`lang:${l}`);
const pickFiles = async (env, files) => { const inp = env.byId('cb-docs-file'); inp.files = files; inp.dispatch('change'); await env.flush(); };
const file = (name, content) => ({ name, type: 'text/plain', size: content.length, text: async () => content });

await test('직접 고른 실제 실행: 먼저 계획(Jev 없음)을 보이고, 확인해야 같은 본문으로 만든다', async () => {
  const env = fakeEnv(server({ '/api/cloudbite/preview': (init) => json(200, previewOf(JSON.parse(init.body).expertIds, { assignments: [ASSIGN('x1'), ASSIGN('x2', { source: 'manual-scope', optionIds: [] })], warnings: ['Two roles share a perspective'] })) }));
  await goLive(env); await selectTwo(env);
  await setValue(env, 'cb-dec-options', 'Ship now\nWait a quarter');
  assert.equal(start(env).textContent, EN.prepareLabel);
  await click(env, 'start');
  assert.equal(bodies(env, '/api/cloudbite/route').length, 0, 'manual selection never calls Jev');
  assert.equal(bodies(env, '/api/cloudbite/preview').length, 1);
  assert.equal(bodies(env, '/api/cloudbite/projects').length, 0, 'preparing never executes');
  const plan = planOf(env).textContent;
  for (const t of [EN.planTitle, EN.planRoles(2), EN.planSandboxes(2), EN.planNosana(20, 16, 3, 1), EN.planJev(0), EN.planNoCost, 'Expert 1', 'Expert 2',
    'What should x1 decide?', 'option-2: Wait a quarter', 'A risk list', 'Cite doc-1', 'No legal advice', 'Two roles share a perspective', EN.planStage(EN.wfStageNone)])
    assert.ok(plan.includes(t), t);
  assert.ok(!/\$|USD|cost estimate/i.test(plan), 'no fake cost');
  const [pv] = bodies(env, '/api/cloudbite/preview');
  assert.deepEqual(Object.keys(JSON.parse(pv)), ['title', 'objective', 'context', 'expertIds', 'mode', 'requestId', 'decision'], 'create-like body, no workflow defaults');
  assert.equal(start(env).textContent, EN.runPlanLabel);
  await click(env, 'start');
  assert.deepEqual(bodies(env, '/api/cloudbite/projects'), [pv], 'executes exactly the previewed body');
  assert.equal(env.requests.find(r => r.url === '/api/cloudbite/projects').init.headers['x-admin-token'], 'adm-secret-123');
  assert.equal(planOf(env).hidden, true, 'the plan is consumed by the run');
});

await test('Jev 실제 실행: 경로 → 미리보기 → 실행 본문이 같고, 비운 선택 필드는 경로 뒤에도 기본값으로 채우지 않는다', async () => {
  const env = fakeEnv(server({ '/api/cloudbite/preview': (init) => json(200, previewOf(JSON.parse(init.body).expertIds, { envelope: { ...previewOf(['x1', 'x2']).envelope, jevCalls: 1 } })) }), { boot: ROUTING_BOOT });
  await goLive(env);
  await click(env, 'start');
  const [route] = bodies(env, '/api/cloudbite/route').map(b => JSON.parse(b)), [pv] = bodies(env, '/api/cloudbite/preview');
  const p = JSON.parse(pv);
  assert.deepEqual(Object.keys(route), ['title', 'objective', 'context', 'requestId']);
  assert.deepEqual(Object.keys(p), ['title', 'objective', 'context', 'requestId', 'mode', 'expertIds', 'routing']);
  assert.deepEqual(p.expertIds, ['x1', 'x2']); assert.equal(p.requestId, route.requestId); assert.equal(p.routing, 'jev');
  for (const k of ['stage', 'responseLanguage', 'budget']) assert.ok(!(k in p), `${k} absent`);
  assert.ok(planOf(env).textContent.includes(EN.planJev(1)), 'Jev call shown separately');
  await click(env, 'start');
  assert.deepEqual(bodies(env, '/api/cloudbite/projects'), [pv], 'frozen payload: preview budget/defaults are not injected');
});

await test('단계·응답 언어·상한: 명시한 값만 보내고 응답 언어는 화면 언어와 따로다, 상한 오류는 접힌 상자를 편다', async () => {
  const env = fakeEnv(server(), { boot: ROUTING_BOOT });
  await goLive(env); await ownBrief(env);
  const details = env.all().find(n => n.className === 'cb-disclosure cb-budget');
  assert.equal(details.open, false, 'caps live in a collapsed advanced section');
  assert.ok(env.all().some(n => n.tagName === 'LABEL' && n.getAttribute('for') === 'cb-stage'));
  assert.ok(env.all().some(n => n.tagName === 'LABEL' && n.getAttribute('for') === 'cb-resp-lang'));
  await setValue(env, 'cb-stage', 'validation'); await setValue(env, 'cb-resp-lang', 'ko');
  await setValue(env, 'cb-budget-maxExperts', '2');
  await click(env, 'start');
  assert.equal(details.open, true); assert.ok(formMsg(env).includes(EN.vBudgetPartial));
  assert.equal(bodies(env, '/api/cloudbite/route').length + bodies(env, '/api/cloudbite/preview').length, 0, 'nothing sent with invalid caps');
  await click(env, 'budget-fill');
  assert.deepEqual(['maxExperts', 'maxModelCalls', 'maxReviewCalls', 'maxMemoCalls'].map(f => env.byId(`cb-budget-${f}`).value), ['5', '44', '3', '1']);
  await setValue(env, 'cb-budget-maxModelCalls', '30');
  await click(env, 'start');
  const [route] = bodies(env, '/api/cloudbite/route').map(b => JSON.parse(b)), p = JSON.parse(bodies(env, '/api/cloudbite/preview')[0]);
  const want = { stage: 'validation', responseLanguage: 'ko', budget: { maxExperts: 5, maxModelCalls: 30, maxReviewCalls: 3, maxMemoCalls: 1 } };
  for (const [k, v] of Object.entries(want)) { assert.deepEqual(route[k], v, `route ${k}`); assert.deepEqual(p[k], v, `preview ${k}`); }
  assert.equal(env.doc.documentElement.getAttribute('lang'), 'en', 'response language does not change the console language');
  langBtn(env, 'ko').click(); await env.flush();
  assert.equal(env.byId('cb-resp-lang').value, 'ko'); assert.equal(env.byId('cb-stage').value, 'validation');
  assert.equal(start(env).textContent, KO.runPlanLabel, 'switching the console language keeps the plan');
  assert.ok(planOf(env).textContent.includes(KO.planLang(KO.wfLangName.ko)) && planOf(env).textContent.includes(KO.planStage(KO.wfStageName.validation)));
  assert.ok(env.all().some(n => n.tagName === 'OPTION' && n.textContent === '검증'), 'stage options are translated');
  env.fk('start').click(); await env.flush();
  assert.equal(JSON.parse(bodies(env, '/api/cloudbite/projects')[0]).responseLanguage, 'ko');
});

await test('의미 있는 편집은 모두 계획을 버린다 (제목·목표·맥락·결정·단계·응답 언어·상한·자료 추가/빼기·선택·고르는 방식)', async () => {
  const edits = [
    ['title', (env) => setValue(env, 'cb-title', 'Another title')],
    ['objective', (env) => setValue(env, 'cb-objective', 'Another objective')],
    ['context', (env) => setValue(env, 'cb-context', 'More context')],
    ['decision', (env) => setValue(env, 'cb-dec-unknowns', 'Churn?')],
    ['stage', (env) => setValue(env, 'cb-stage', 'launch')],
    ['response language', (env) => setValue(env, 'cb-resp-lang', 'en')],
    ['budget', async (env) => { await click(env, 'budget-fill'); }],
    ['doc add', (env) => pickFiles(env, [file('n.txt', 'New note')])],
    ['selection', async (env) => { const b = env.fk('x:x3'); b.checked = true; b.dispatch('change'); await env.flush(); }],
  ];
  for (const [name, edit] of edits) {
    const env = fakeEnv(server());
    await goLive(env); await selectTwo(env);
    await click(env, 'start');
    assert.equal(start(env).textContent, EN.runPlanLabel, name);
    await edit(env);
    assert.equal(start(env).textContent, EN.prepareLabel, `${name}: plan dropped`);
    assert.ok(planOf(env).textContent.includes(EN.planStale), `${name}: says why`);
    await click(env, 'start');
    assert.equal(bodies(env, '/api/cloudbite/projects').length, 0, `${name}: a stale plan is never executed`);
    assert.equal(bodies(env, '/api/cloudbite/preview').length, 2, `${name}: a new plan is prepared instead`);
  }
  // 자료 빼기와 고르는 방식 바꾸기
  const env = fakeEnv(server(), { boot: ROUTING_BOOT });
  await goLive(env);
  await pickFiles(env, [file('a.txt', 'Alpha')]);
  await click(env, 'start');
  const rm = env.all().find(n => (n.getAttribute('data-fk') || '').startsWith('doc-rm:'));
  rm.click(); await env.flush();
  assert.equal(start(env).textContent, EN.prepareLabel, 'doc removal drops the plan');
  await click(env, 'start');
  await click(env, 'jev-toggle');
  assert.equal(start(env).textContent, EN.prepareLabel, 'route mode drops the plan');
});

await test('언어 전환·조회 다시 그리기는 계획과 입력을 지킨다 (KO/EN 문구로 다시 그림)', async () => {
  const env = fakeEnv(server());
  await goLive(env); await selectTwo(env);
  await ownBrief(env); await setValue(env, 'cb-dec-options', 'A\nB');
  await click(env, 'start');
  langBtn(env, 'ko').click(); await env.flush();
  assert.equal(start(env).textContent, KO.runPlanLabel);
  assert.ok(planOf(env).textContent.includes(KO.planTitle) && planOf(env).textContent.includes(KO.planNoCost));
  assert.equal(env.byId('cb-title').value, 'Mine'); assert.equal(env.byId('cb-dec-options').value, 'A\nB');
  langBtn(env, 'en').click(); await env.flush();
  await click(env, 'start');
  assert.equal(bodies(env, '/api/cloudbite/projects').length, 1);
});

await test('실패: 미리보기 오류·형식 오류·경로 오류는 만들지 않고 잠금을 풀며, 같은 입력으로 다시 준비하면 같은 requestId', async () => {
  let previewAnswer = () => json(500, { error: 'preview storage unavailable' });
  const env = fakeEnv(server({ '/api/cloudbite/preview': (init) => previewAnswer(init) }));
  await goLive(env); await selectTwo(env);
  await click(env, 'start');
  assert.ok(formMsg(env).includes('preview storage unavailable'));
  assert.equal(start(env).disabled, false, 'locks released'); assert.equal(env.byId('cb-objective').disabled, false);
  assert.equal(start(env).textContent, EN.prepareLabel);
  previewAnswer = () => json(200, { expertIds: ['x1', 'x2'], assignments: [], budget: {}, envelope: {}, warnings: [] });
  await click(env, 'start');
  assert.ok(formMsg(env).includes(EN.planInvalid));
  previewAnswer = (init) => json(200, previewOf(['x2']));
  await click(env, 'start');
  assert.ok(formMsg(env).includes(EN.planMismatch));
  previewAnswer = () => Promise.reject(new Error('offline'));
  await click(env, 'start');
  assert.ok(formMsg(env).includes(EN.planNetwork));
  previewAnswer = (init) => json(200, previewOf(JSON.parse(init.body).expertIds));
  await click(env, 'start');
  const ids = bodies(env, '/api/cloudbite/preview').map(b => JSON.parse(b).requestId);
  assert.equal(new Set(ids).size, 1, 'repeat requests for the same brief reuse one requestId');
  assert.equal(bodies(env, '/api/cloudbite/projects').length, 0);
  assert.equal(start(env).textContent, EN.runPlanLabel);

  const jev = fakeEnv(server({ '/api/cloudbite/route': () => json(422, { error: 'no matching roles' }) }), { boot: ROUTING_BOOT });
  await goLive(jev);
  await click(jev, 'start');
  assert.ok(formMsg(jev).includes(EN.routeNone));
  assert.equal(bodies(jev, '/api/cloudbite/preview').length, 0, 'no preview after a failed route');
  assert.equal(start(jev).disabled, false);
});

await test('실행 실패 뒤 다시 누르면 같은 고정 본문(같은 requestId)을 보낸다, 다른 계획을 만들지 않는다', async () => {
  let n = 0;
  const env = fakeEnv(server({ '/api/cloudbite/projects': (init) => ++n === 1 ? Promise.reject(new Error('reset')) : json(201, { project: runningProject(JSON.parse(init.body)), accessToken: 't' }) }));
  await goLive(env); await selectTwo(env);
  await click(env, 'start'); await click(env, 'start');
  assert.ok(formMsg(env).includes(EN.networkCreate));
  assert.equal(start(env).textContent, EN.runPlanLabel, 'the same plan can be retried');
  await click(env, 'start');
  const sent = bodies(env, '/api/cloudbite/projects');
  assert.equal(sent.length, 2); assert.equal(sent[0], sent[1], 'identical retry');
  assert.equal(bodies(env, '/api/cloudbite/preview').length, 1);
});

await test('준비 중 Stop: 늦은 경로·미리보기로 만들지 않는다, 계획 버리기는 다시 준비하게 한다', async () => {
  let release;
  const env = fakeEnv(server({ '/api/cloudbite/preview': () => new Promise(r => { release = r; }) }));
  await goLive(env); await selectTwo(env);
  await click(env, 'start');
  assert.equal(start(env).textContent, EN.preparingLabel); assert.equal(start(env).disabled, true);
  assert.equal(env.byId('cb-title').disabled, true, 'inputs locked while preparing');
  assert.equal(env.fk('stop').hidden, false);
  await click(env, 'stop');
  release({ ok: true, status: 200, json: async () => previewOf(['x1', 'x2']) }); await env.flush();
  assert.ok(formMsg(env).includes(EN.planCancelled));
  assert.equal(start(env).textContent, EN.prepareLabel);
  assert.equal(bodies(env, '/api/cloudbite/projects').length, 0);

  const env2 = fakeEnv(server());
  await goLive(env2); await selectTwo(env2);
  await click(env2, 'start');
  await click(env2, 'plan-discard');
  assert.equal(start(env2).textContent, EN.prepareLabel); assert.equal(planOf(env2).hidden, true);
});

await test('브라우저 데모는 그대로 바로 시작한다 (미리보기·프로젝트 API 없음)', async () => {
  const env = fakeEnv(server());
  await env.flush();
  assert.equal(start(env).textContent, EN.runExpertsDemo);
  await click(env, 'start'); await env.advance(20000);
  assert.equal(env.requests.filter(r => r.url !== '/api/cloudbite/bootstrap').length, 0);
  assert.match(env.root.textContent, /valid opinions/);
});

const pmcBox = (env) => env.all().find(n => n.className === 'cb-pmc');
const pmcErr = (env) => env.all().find(n => n.className === 'cb-formmsg cb-pmc-err').textContent;
const docNames = (env) => env.all().filter(n => n.className === 'cb-doc-name' && n.parent?.parent?.parent?.className === 'cb-doc-list').map(n => n.textContent);

await test('PMC: 틀린 식별자는 묻지 않고, 오류 코드는 KO/EN 으로 솔직히 알리며 바쁜 동안 잠근다', async () => {
  let answer = () => json(429, { error: 'rate_limited', message: 'PMC asked us to slow down', retryAfterSeconds: 30 });
  let release;
  const env = fakeEnv(server({ '/api/cloudbite/pmc/import': (init) => answer(init) }));
  await goLive(env);
  await setValue(env, 'cb-pmc-id', 'not an id <script>');
  await click(env, 'pmc-lookup');
  assert.equal(env.requests.filter(r => r.url === '/api/cloudbite/pmc/import').length, 0);
  assert.ok(pmcErr(env).includes(EN.pmcBad));
  await setValue(env, 'cb-pmc-id', 'PMC7654321');
  await click(env, 'pmc-lookup');
  assert.equal(JSON.parse(env.requests.at(-1).init.body).identifier, 'PMC7654321');
  assert.equal(env.requests.at(-1).init.headers['x-admin-token'], 'adm-secret-123');
  assert.ok(pmcErr(env).includes(EN.pmcError.rate_limited) && pmcErr(env).includes('PMC asked us to slow down') && pmcErr(env).includes(EN.pmcRetry(30)));
  langBtn(env, 'ko').click(); await env.flush();
  assert.ok(pmcErr(env).includes(KO.pmcError.rate_limited) && pmcErr(env).includes(KO.pmcRetry(30)));
  langBtn(env, 'en').click(); await env.flush();
  answer = () => new Promise(r => { release = r; });
  await click(env, 'pmc-lookup');
  assert.equal(env.fk('pmc-lookup').textContent, EN.pmcBusy); assert.equal(env.fk('pmc-lookup').disabled, true);
  assert.equal(pmcBox(env).getAttribute('aria-busy'), 'true');
  release({ ok: false, status: 401, json: async () => ({ error: 'admin session required' }) }); await env.flush();
  assert.equal(env.fk('pmc-lookup').disabled, false, 'busy state released');
  assert.ok(pmcErr(env).includes('admin session required'), 'non-PMC refusal is reported, not dressed up as success');
  answer = () => json(200, { ...PMC, documents: 'nope' });
  await click(env, 'pmc-lookup');
  assert.ok(pmcErr(env).includes(EN.pmcInvalid));
  assert.equal(docNames(env).length, 0, 'nothing added on failure');
});

await test('PMC 성공: 신원·이용 허락·절·빠진 부분·실제 발췌를 보이고, 고른 발췌만 출처와 함께 합친다', async () => {
  const env = fakeEnv(server());
  await goLive(env); await selectTwo(env);
  await pickFiles(env, [file('mine.md', 'My own note')]);
  await click(env, 'start');
  assert.equal(start(env).textContent, EN.runPlanLabel);
  await setValue(env, 'cb-pmc-id', 'doi:10.1000/xyz');
  await click(env, 'pmc-lookup');
  assert.equal(start(env).textContent, EN.runPlanLabel, 'looking up alone is not an edit');
  const box = pmcBox(env).textContent;
  for (const t of ['PMC7654321', 'doi:10.1000/xyz', 'CC BY 4.0', EN.pmcSections(2), 'Results — sec[2]', 'Results truncated to 8,000 characters', 'Table 2 omitted (image only)',
    'Abstract excerpt: response rate 41%.', 'part=results', EVIL]) assert.ok(box.includes(t), t);
  assert.equal(env.ctx.__pwn, undefined, 'excerpts rendered as text');
  const link = env.all().find(n => n.tagName === 'A' && n.getAttribute('href') === PMC.article.sourceUrl);
  assert.equal(link.getAttribute('rel'), 'noopener noreferrer');
  assert.deepEqual(docNames(env), ['mine.md'], 'nothing added before the explicit add');
  assert.equal(env.fk('pmc-add').disabled, true);
  for (const id of ['doc-1', 'doc-2']) { const b = env.fk(`pmc-pick:${id}`); b.checked = true; b.dispatch('change'); await env.flush(); }
  assert.equal(env.fk('pmc-add').textContent, EN.pmcAdd(2));
  await click(env, 'pmc-add');
  assert.deepEqual(docNames(env), ['mine.md', 'PMC7654321-abstract.md', 'PMC7654321-results.md']);
  assert.ok(env.root.textContent.includes(EN.pmcAdded(2)));
  assert.equal(start(env).textContent, EN.prepareLabel, 'adding documents invalidates the plan');
  await click(env, 'start'); await click(env, 'start');
  const docs = JSON.parse(bodies(env, '/api/cloudbite/projects')[0]).documents;
  assert.deepEqual(docs.map(d => [d.id, d.name, d.origin]), [['doc-1', 'mine.md', undefined], ['doc-2', 'PMC7654321-abstract.md', PMC.documents[0].origin], ['doc-3', 'PMC7654321-results.md', PMC.documents[1].origin]]);
  assert.equal(docs[2].content, PMC.documents[1].content, 'excerpt text unchanged');
});

await test('PMC 합치기 한도: 6개·합계·중복은 거절하고 이유를 보인다 (지금 파일을 잃지 않는다)', async () => {
  const env = fakeEnv(server());
  await goLive(env);
  await pickFiles(env, [1, 2, 3, 4, 5].map(i => file(`f${i}.txt`, `file ${i}`)));
  await setValue(env, 'cb-pmc-id', 'PMC7654321');
  await click(env, 'pmc-lookup');
  for (const id of ['doc-1', 'doc-2']) { const b = env.fk(`pmc-pick:${id}`); b.checked = true; b.dispatch('change'); await env.flush(); }
  await click(env, 'pmc-add');
  assert.equal(docNames(env).length, 6);
  assert.match(env.all().find(n => n.className === 'cb-formmsg cb-docs-err').textContent, /PMC7654321-results\.md: .*at most 6 files/);
  const rm = env.all().find(n => (n.getAttribute('data-fk') || '').startsWith('doc-rm:'));
  rm.click(); await env.flush();
  const b = env.fk('pmc-pick:doc-1'); b.checked = true; b.dispatch('change'); await env.flush();
  await click(env, 'pmc-add');
  assert.match(env.all().find(n => n.className === 'cb-formmsg cb-docs-err').textContent, /already in the project evidence/);
  assert.deepEqual(docNames(env), ['f2.txt', 'f3.txt', 'f4.txt', 'f5.txt', 'PMC7654321-abstract.md', 'PMC7654321-results.md'], 'a rejected pick stays picked for the retry; existing files are kept');
});

console.log(`cloudbite-workflow-ui: ${pass} passed`);
