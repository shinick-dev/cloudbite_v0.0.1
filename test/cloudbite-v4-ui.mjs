// Cloudbite 콘솔의 제품 v4 화면 (src/cloudbite-page.ts 의 CLOUDBITE_JS) 을 브라우저 없이 고정한다:
// 주장 출처의 엄격한 정리·지위·숫자 제안 강조·펼칠 때만 그리기, 정확한 글로만 채택하고 실패·미확인이면 다시 보내기 전에 읽기,
// 검토자가 읽은 산출물 범위, 작성자 응답(계획·응답·거부·없음)과 "작성자에게 응답 요청" 후속 초안의 고정 본문.
// test/cloudbite-decision-ui.mjs 와 같은 모양의 작은 가짜 DOM 이다. 실제 브라우저·서버·공급자 증거가 아니다.
//   node tools/build-cloudbite-console.mjs && node test/cloudbite-v3-ui.mjs
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { CLOUDBITE_JS } from '../src/cloudbite-page.ts';

let pass = 0;
const test = async (name, fn) => { await fn(); pass++; console.log(`  ok   ${name}`); };
const plain = (v) => JSON.parse(JSON.stringify(v));

let core = null;
vm.runInContext(CLOUDBITE_JS, vm.createContext({ __cloudbiteTestHook: (c) => { core = c; }, crypto: globalThis.crypto }));
assert.ok(core);
const { EN, KO } = { EN: core.DICT.en, KO: core.DICT.ko };

// ───────── 고정 자료
const ID = 'cb' + 'a'.repeat(32), PARENT = 'cb' + 'b'.repeat(32), HASH = 'f'.repeat(64), SHA = (c) => c.repeat(64);
const cid = (i) => 'cl-' + i.toString(16).padStart(16, '0');
const opinion = (s, evidence = ['ev-0', 'ev-1']) => ({ direction: 'concern', confidence: 60, summary: s, evidence, assumptions: [], nextActions: [] });
const run = (i, extra = {}) => ({ id: `run-${i}`, expertId: `x${i}`, name: `Expert ${i}`, status: 'completed', activity: [], artifacts: [], updatedAt: 1, opinion: opinion(`summary ${i}`), ...extra });
const claim = (i, over = {}) => ({ id: cid(i), origin: 'generated-opinion', kind: 'opinion-evidence', field: 'evidence', index: i, expertId: 'x1', text: `claim ${i}`,
  textTruncated: false, refs: [], numericThresholdHint: false, ...over });
const COVER = { experts: 3, expertsOmitted: 0, itemsOmitted: 0, textTruncated: 1, refsOmitted: 0, carriedAdoptions: 0, carriedInvalid: 0, factsVerified: false, sourcesRetrieved: false };
const LEDGER = (claims, snapshot = 'ps-' + '1'.repeat(16)) => ({ version: 'cloudbite-provenance/v1', projectId: ID, snapshot, claims, coverage: COVER });
const STATE = (adoptions = []) => ({ version: 'cloudbite-provenance/v1', projectId: ID, adoptions });
const adoption = (c, snapshot = 'ps-' + '1'.repeat(16)) => ({ claimId: c.id, text: c.text, snapshot, projectId: ID, actor: 'owner', at: 5, meaning: 'user-adoption-not-verification' });
const BASE_CLAIMS = [
  claim(1, { origin: 'user-statement', kind: 'success-criterion', field: 'successCriteria', expertId: undefined, text: 'Ten paying teams' }),
  claim(2, { text: 'Task completion should be at least 80%', numericThresholdHint: true, refs: [{ kind: 'document', id: 'doc-1', availability: 'supplied-document' }] }),
  claim(3, { text: 'Interview more users' }),
  claim(4, { text: 'Cut text…', textTruncated: true }),
];
const REVIEW = {
  status: 'completed', snapshotHash: HASH, startedAt: 10, completedAt: 20, execution: 'server-nosana',
  reports: [
    { reviewerExpertId: 'x2', summary: 's2', findings: [{ targetExpertId: 'x1', evidenceIndex: 0, verdict: 'challenged', rationale: 'Too strong' }] },
    { reviewerExpertId: 'x1', summary: 's1', findings: [{ targetExpertId: 'x2', evidenceIndex: 1, verdict: 'supported', rationale: 'ok' },
      { targetExpertId: 'x3', evidenceIndex: 0, verdict: 'insufficient', rationale: 'thin' }] },
    { reviewerExpertId: 'x3', summary: 's3', findings: [{ targetExpertId: 'x3', evidenceIndex: 0, verdict: 'challenged', rationale: 'self' },
      { targetExpertId: 'x2', evidenceIndex: 7, verdict: 'challenged', rationale: 'stale index' }] },
  ],
  artifactCoverage: [{ expertId: 'x1', packetSha256: SHA('a'),
    files: [{ path: 'out/report.md', sha256: SHA('b'), startLine: 1, endLine: 40, totalLines: 120, excerptTruncated: true, storedTruncated: false }],
    omitted: [{ path: 'out/result.json', reason: 'opinion-duplicate' }, { path: 'out/blob.bin', reason: 'binary' }] }],
};
const brief = (over = {}) => ({ title: 'T', objective: 'O', context: '', expertIds: ['x1', 'x2', 'x3'], mode: 'live', requestId: 'r', ...over });
const projectRaw = (over = {}) => ({ id: ID, status: 'completed', createdAt: Date.now(), updatedAt: 5, brief: brief(), experts: [run(1), run(2), run(3)], crossReview: REVIEW,
  provenance: { ledger: LEDGER(BASE_CLAIMS), state: STATE() }, ...over });

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
const PREVIEW_OK = (url, init) => {
  const b = JSON.parse(init.body), n = b.expertIds.length;
  return json(200, { expertIds: b.expertIds, assignments: [], budget: { maxExperts: n, maxModelCalls: n * 8 + 4, maxReviewCalls: 3, maxMemoCalls: 1 },
    envelope: { sandboxMaximum: n, nosanaMaximum: n * 8 + 4, expertMaximum: n * 8, reviewMaximum: 3, memoMaximum: 1, jevCalls: 0 }, warnings: [] });
};
const CATALOGUE = {
  experts: ['x1', 'x2', 'x3'].map((id, i) => ({ id, name: `Expert ${i + 1}`, domain: 'd', summary: 's', prompt: 'p', tools: [], outputs: [], source: {} })),
  configuration: { liveReady: true, missing: [], maxExperts: 5 },
};
function fakeEnv(fetchImpl) {
  const timers = new Map(); let seq = 0;
  const doc = { readyState: 'complete', activeElement: null, createElement: (t) => new Node_(doc, t), getElementById: (id) => id === 'cloudbite' ? root : null,
    listeners: {}, addEventListener(t, f) { (this.listeners[t] ||= []).push(f); } };
  doc.documentElement = new Node_(doc, 'html');
  const root = new Node_(doc, 'div'); root.id = 'cloudbite'; doc.body = new Node_(doc, 'body'); doc.body.append(root);
  const requests = [], previews = [];
  const ctx = vm.createContext({
    document: doc, crypto: globalThis.crypto, CSS: { escape: (s) => s }, URL, URLSearchParams, Blob,
    location: { pathname: '/cloudbite/history', search: '?lang=en', hash: '' },
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { fn, ms }); return id; }, clearTimeout: (id) => { timers.delete(id); }, setInterval: () => 0,
    fetch: (url, init = {}) => {
      if (String(url).startsWith('/api/cloudbite/owner/')) return json(200, { authenticated: false, hasCredentials: false });
      if (url === '/api/cloudbite/bootstrap') return json(200, CATALOGUE);
      if (url === '/api/cloudbite/preview') { previews.push({ url, init }); return PREVIEW_OK(url, init); }
      requests.push({ url, init: { method: 'GET', ...init } }); return fetchImpl(url, { method: 'GET', ...init }, requests.length);
    },
  });
  vm.runInContext(CLOUDBITE_JS, ctx);
  const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); };
  const all = () => [...root.walk()];
  const fk = (k) => all().find(n => n.getAttribute('data-fk') === k);
  const byId = (id) => all().find(n => n.id === id);
  const detail = () => all().find(n => n.className === 'cb-panel cb-history-detail');
  return { root, requests, previews, flush, all, fk, byId, detail };
}
const ROW = { id: ID, title: 'T', mode: 'live', status: 'completed', createdAt: 1, updatedAt: 1, expiresAt: Date.now() + 86400_000, expertCount: 3, feedbackCount: 0, model: 'test' };
// canFeedback 은 서버의 "자기 기록 && 끝남" (src/cloudbite-project.ts). 채택 권한의 유일한 근거다
const detailOf = (project, canFeedback = true) => ({ project, model: 'test', roles: [], feedback: [], expiresAt: ROW.expiresAt, canFeedback });
/** 사용 기록 서버: 목록, 상세 GET (detailImpl 이 있으면 그것), 채택 POST (adoptImpl), 실제 실행 만들기 (끝난 project() 를 바로 돌려준다) */
function historyServer(project, adoptImpl, { detailImpl = null, canFeedback = true, owner = false } = {}) {
  return (url, init, n) => {
    if (url.startsWith('/api/cloudbite/history?')) return json(200, { rows: [ROW], next: null, owner, retentionDays: 30 });
    if (url === `/api/cloudbite/history/${ID}/adopt`) return adoptImpl(init);
    if (url === `/api/cloudbite/history/${ID}`) return detailImpl ? detailImpl(init, n) : json(200, detailOf(project(), canFeedback));
    if (url === '/api/cloudbite/projects' && init.method === 'POST') return json(201, { project: project(), accessToken: 'proj-bearer' });
    return json(404, { error: 'not found' });
  };
}
const openDetail = async (env) => { await env.flush(); env.fk('hist-record:' + ID).click(); await env.flush(); };
const openGroup = async (env, k) => { const box = env.all().find(n => n.tagName === 'DETAILS' && n.className.includes(`cb-prov-group is-${k}`)); box.open = true; box.dispatch('toggle'); await env.flush(); };
const posts = (env) => env.requests.filter(r => r.init.method === 'POST' && r.url.endsWith('/adopt'));
const historyGets = (env) => env.requests.filter(r => r.url === `/api/cloudbite/history/${ID}` && r.init.method === 'GET');
/** 지금 실행: 실제 실행으로 바꾸고 계획 준비 → 이 계획으로 실행. 만들기 응답이 이미 끝난 프로젝트라 바로 증거 화면이 그려진다 (사용 기록 상세는 열지 않는다) */
const startLive = async (env, token = 'adm-secret-123') => {
  await env.flush();
  env.all().find(n => n.tagName === 'BUTTON' && n.textContent.trim() === 'Live run').click(); await env.flush();
  const tok = env.byId('cb-token'); tok.value = token; tok.dispatch('input'); await env.flush();
  env.fk('start').click(); await env.flush();
  if (env.fk('start')?.textContent.trim() === 'Run this plan') { env.fk('start').click(); await env.flush(); }
  assert.ok(env.requests.some(r => r.url === '/api/cloudbite/projects' && r.init.method === 'POST'), 'the run was created');
};

const calcRecord = (over = {}) => ({ id: 'qc_' + '1'.repeat(32), projectId: ID, createdAt: 1, execution: 'app-deterministic',
  request: { kind: 'arithmetic', expression: 'a+1', variables: { a: { value: 2, unit: '' } } },
  result: { schema: 'cloudbite.quantitative.v1', engine: 'cloudbite-quantitative', status: 'completed', kind: 'arithmetic', inputSha256: HASH, result: { value: 3, unit: '1' } }, ...over });
const support = () => ({ status: 'partial', quotes: [{ passageId: 'p-1', ref: 'doc:doc-1', textOrigin: 'user-document', quote: 'A supplied exact excerpt.', sourceSha256: HASH,
  startOffset: 0, endOffset: 25, startLine: 1, endLine: 1 }], rationale: 'The statement is conditional.', basis: 'model-assessment', quoteCheck: 'exact-substring', citedText: 'available', packetSha256: HASH });

await test('new copy exists in KO/EN, calculations are not a factual check and support is model assessment', () => {
  assert.deepEqual(Object.keys(EN.p4), Object.keys(KO.p4));
  assert.match(EN.p4.note, /not whether the inputs or the decision are correct/);
  assert.match(KO.p4.note, /사실성/); assert.match(EN.p4.supportNote, /not factual verification/);
});

await test('saved calculations survive normalization/export; foreign, duplicate, malformed or nonfinite records fail closed', () => {
  const raw = projectRaw({ quantitativeChecks: [calcRecord()] }), p = core.normalizeProject(raw);
  assert.equal(p.quantitativeChecks.length, 1);
  assert.match(core.phaseTwoMarkdown(p, EN).join('\n'), /Saved calculation records/);
  for (const changed of [calcRecord({ projectId: PARENT }), calcRecord({ execution: 'model' }), calcRecord({ createdAt: 1e100 }), calcRecord({ result: { status: 'completed' } })]) {
    const x = core.normalizeProject(projectRaw({ quantitativeChecks: [changed] })); assert.equal(x.invalidQuantitative, true); assert.equal(x.quantitativeChecks, undefined);
  }
  assert.equal(core.normalizeProject(projectRaw({ quantitativeChecks: [calcRecord(), calcRecord()] })).invalidQuantitative, true);
});

await test('claim support is preserved only with checked quote metadata; legacy is unassessed and malformed metadata disclosed', () => {
  const s = support(); s.quotes[0].endOffset = s.quotes[0].quote.length;
  const r = plain(REVIEW); r.reports[0].findings[0].claimSupport = s;
  const p = core.normalizeProject(projectRaw({ crossReview: r }));
  assert.equal(p.crossReview.reports[0].findings[0].claimSupport.basis, 'model-assessment');
  assert.match(core.phaseTwoMarkdown(p, EN).join('\n'), /doc:doc-1/);
  assert.equal(core.normalizeProject(projectRaw()).crossReview.reports[0].findings[0].claimSupport, undefined);
  r.reports[0].findings[0].claimSupport.quoteCheck = 'unchecked';
  const bad = core.normalizeProject(projectRaw({ crossReview: r })); assert.equal(bad.crossReview.invalidClaimSupport, true);
  assert.equal(bad.crossReview.reports[0].findings[0].claimSupport, undefined);
});

const quantBox = env => env.all().find(n => n.tagName === 'DETAILS' && n.className.includes('cb-quant'));
const toggleQuant = async env => { const box = quantBox(env); assert.ok(box); box.open = true; box.dispatch('toggle'); await env.flush(); };
const input = (env, label, value) => { const l = env.all().find(n => n.tagName === 'LABEL' && n.textContent.startsWith(label)); assert.ok(l, label);
  const n = [...l.walk()].find(n => ['INPUT', 'TEXTAREA'].includes(n.tagName)); assert.ok(n); n.value = value; n.dispatch('input'); return n; };

await test('current project calculation sends explicit inputs with its own bearer, keeps draft across KO/EN and stores response; history stays read-only', async () => {
  let current = projectRaw(), calls = [];
  const base = historyServer(() => current, () => json(404, {}));
  const env = fakeEnv((url, init) => {
    if (url.endsWith('/quantitative')) { calls.push(init); const b = JSON.parse(init.body); current = projectRaw({ quantitativeChecks: [calcRecord({ request: b.request })] }); return json(200, current); }
    return base(url, init);
  });
  await startLive(env); await toggleQuant(env);
  input(env, EN.p4.expression, 'a+1'); input(env, EN.p4.variables, 'a,2,');
  env.fk('lang:ko').click(); await env.flush();
  assert.equal(input(env, KO.p4.expression, 'a+1').value, 'a+1');
  env.fk('quant-run').click(); await env.flush();
  assert.equal(calls.length, 1); assert.equal(calls[0].headers.authorization, 'Bearer proj-bearer');
  assert.deepEqual(JSON.parse(calls[0].body), { request: { kind: 'arithmetic', expression: 'a+1', variables: { a: { value: 2, unit: '' } } } });
  assert.match(env.root.textContent, /qc_11111111111111111111111111111111/);
  const saved = fakeEnv(historyServer(() => current, () => json(404, {}))); await openDetail(saved); await toggleQuant(saved);
  assert.equal(saved.fk('quant-run'), undefined); assert.match(saved.root.textContent, /Saved records are read-only/);
});

await test('invalid input is local; interrupted request shows error without inventing a record', async () => {
  const base = historyServer(() => projectRaw(), () => json(404, {}));
  let calls = 0;
  const env = fakeEnv((url, init) => { if (url.endsWith('/quantitative')) { calls++; return Promise.reject(new Error('response lost')); } return base(url, init); });
  await startLive(env); await toggleQuant(env); env.fk('quant-run').click(); await env.flush();
  assert.equal(calls, 0); assert.match(env.root.textContent, /at most 20 unique variables/);
  input(env, EN.p4.expression, 'a+1'); input(env, EN.p4.variables, 'a,2,'); env.fk('quant-run').click(); await env.flush();
  assert.equal(calls, 1); assert.match(env.root.textContent, /Calculation request failed/); assert.match(env.root.textContent, /No calculations recorded/);
});

console.log(`cloudbite-v4-ui: ${pass} groups passed (fake DOM; no live provider).`);

