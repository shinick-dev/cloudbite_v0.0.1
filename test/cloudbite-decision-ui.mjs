// Cloudbite 콘솔의 결정 세부 정보 · 근거 자료 · 주장 장부 · 교차 검토 화면 (src/cloudbite-page.ts 의 CLOUDBITE_JS) 을 브라우저 없이 고정한다.
// 값 정리는 코어 함수로, 화면 동작(접힌 기본값, 파일 거르기·빼기·다시 매기기, 비동기 읽기와 언어 전환, 보내는 본문, 교차 검토 버튼·상태,
// 사용 기록 읽기 전용)은 test/cloudbite-console.mjs 와 같은 모양의 작은 가짜 DOM 으로 본다. 실제 브라우저 증거가 아니다.
//   node tools/build-cloudbite-console.mjs && node test/cloudbite-decision-ui.mjs
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { CLOUDBITE_JS, CLOUDBITE_CSS } from '../src/cloudbite-page.ts';

let pass = 0;
const test = async (name, fn) => { await fn(); pass++; console.log(`  ok   ${name}`); };
const EVIL = '<img src=x onerror="globalThis.__pwn=1"><script>globalThis.__pwn=2</script>';
const plain = (v) => JSON.parse(JSON.stringify(v));

// ───────── 코어 함수 (문구 함수까지 그대로 쓰도록 감싸지 않는다)
let core = null;
vm.runInContext(CLOUDBITE_JS, vm.createContext({ __cloudbiteTestHook: (c) => { core = c; }, crypto: globalThis.crypto }));
assert.ok(core);
const { EN, KO } = { EN: core.DICT.en, KO: core.DICT.ko };

await test('사전: 새 문구는 EN·KO 가 같은 열쇠를 갖는다', () => {
  for (const k of ['decisionDetails', 'docsTitle', 'docsCopy', 'ledgerNote', 'reviewExplain', 'reviewBtn', 'verdict', 'claimStatus', 'decisionField', 'demoNoLedger'])
    assert.ok(k in EN && k in KO, k);
  assert.deepEqual(Object.keys(KO.decisionField), Object.keys(EN.decisionField));
  assert.match(EN.ledgerNote, /does not mean the claim is true/); assert.match(KO.ledgerNote, /사실이라는 뜻이 아니며/);
  assert.match(EN.reviewExplain, /Nosana/); assert.match(EN.reviewExplain, /up to 3 extra model calls/); assert.match(EN.reviewExplain, /original opinions unchanged/);
  assert.match(KO.reviewExplain, /최대 3번/); assert.match(EN.docsCopy, /copied into every selected expert's sandbox/); assert.match(EN.docsCopy, /PDFs, repositories and web links are not imported/);
});

await test('결정 세부 정보: 한 줄 한 항목, 빈 줄 버림, 모두 비면 보내지 않음, 8줄·300자 한도', () => {
  assert.equal(core.parseDecision({}).frame, undefined);
  assert.equal(core.parseDecision({ options: ' \n\n  ' }).frame, undefined);
  const r = core.parseDecision({ options: ' A \r\n\nB', unknowns: 'why?' });
  assert.deepEqual(plain(r.frame), { options: ['A', 'B'], constraints: [], successCriteria: [], knownFacts: [], assumptions: [], unknowns: ['why?'] });
  assert.equal(r.issues.length, 0);
  const many = core.parseDecision({ constraints: Array.from({ length: 9 }, (_, i) => `c${i}`).join('\n'), knownFacts: 'x'.repeat(301) });
  assert.deepEqual(plain(many.issues.map(i => i.field)), ['decision', 'decision']);
  assert.equal(many.issues[0].text(EN), 'Constraints: use at most 8 lines.');
  assert.equal(many.issues[1].text(KO), '알려진 사실: 줄마다 300자 이하여야 합니다.');
  assert.equal(core.parseDecision({ knownFacts: 'x'.repeat(300) }).issues.length, 0);
});

await test('근거 파일 거르기: TXT·MD·CSV·JSON 만, PDF·이미지·형식 위장·빈 파일·너무 큰 파일은 읽기 전에 거부', () => {
  const ok = (name, type = '', size = 10) => core.docProblem({ name, type, size });
  for (const [n, t] of [['a.txt', 'text/plain'], ['b.md', ''], ['c.CSV', 'text/csv'], ['d.json', 'application/json'], ['f.csv', 'application/vnd.ms-excel']]) assert.equal(ok(n, t), null, n);
  assert.ok(ok('unsupported.markdown', 'text/markdown'), 'same extension allowlist as the backend');
  const pdf = ok('paper.pdf', 'application/pdf');
  assert.equal(pdf(EN), 'paper.pdf: only TXT, MD, CSV and JSON files can be added. PDF and other binary files are not imported.');
  assert.match(pdf(KO), /^paper\.pdf: TXT·MD·CSV·JSON 파일만 추가할 수 있습니다/);
  assert.ok(ok('x.png', 'image/png')); assert.ok(ok('fake.txt', 'application/pdf'), 'extension alone is not enough'); assert.ok(ok('noext', 'text/plain'));
  assert.match(ok('e.txt', 'text/plain', 0)(EN), /empty/);
  assert.match(ok('big.txt', 'text/plain', 32001)(EN), /longer than 8,000 characters/);
});

await test('근거 파일 내용: BOM·CRLF 정리, 제어 문자·깨진 UTF-8 은 바이너리, 파일 8000자·합계 24000자·6개 한도', () => {
  const acc = (name, text, docs = []) => core.docAccept(name, text, docs);
  assert.deepEqual(plain(acc('a.txt', '﻿line1\r\nline2\rline3')), { doc: { name: 'a.txt', content: 'line1\nline2\nline3' } });
  assert.match(acc('b.txt', 'abc\u0000def').error(EN), /does not look like plain text/);
  assert.match(acc('c.txt', 'caf�').error(KO), /일반 글자 파일이 아닌 것 같아/);
  assert.equal(acc('t.txt', 'tab\tok\fx').doc.content, 'tab\tok\fx');
  assert.match(acc('d.txt', '  \n ').error(EN), /empty/);
  assert.match(acc('e.txt', 'x'.repeat(8001)).error(EN), /longer than 8,000/);
  assert.ok(acc('f.txt', 'x'.repeat(8000)).doc);
  const three = [1, 2, 3].map(() => ({ content: 'x'.repeat(8000) }));
  assert.match(acc('g.txt', 'y', three).error(EN), /exceed 24,000 characters in total/);
  const six = Array.from({ length: 6 }, () => ({ content: 'x' }));
  assert.match(acc('h.txt', 'y', six).error(EN), /at most 6 files/);
  assert.deepEqual(plain(core.docsPayload([{ key: 4, name: 'b', content: 'B' }, { key: 9, name: 'c', content: 'C' }])),
    [{ id: 'doc-1', name: 'b', content: 'B' }, { id: 'doc-2', name: 'c', content: 'C' }], 'ids follow the remaining order; key is not sent and an absent origin stays absent');
});

const opinion = (direction, evidence = ['ev-0', 'ev-1']) => ({ direction, confidence: 70, summary: `${direction} summary`, evidence, assumptions: [], nextActions: [] });
const run = (i, status, extra = {}) => ({ id: `run-${i}`, expertId: `x${i}`, name: `Expert ${i}`, status, activity: [], artifacts: [], updatedAt: 1,
  ...(status === 'completed' ? { opinion: opinion('support') } : {}), ...extra });
const DOCS = [{ id: 'doc-1', name: 'notes.md', content: `Revenue grew 12%\n${EVIL}`, origin: 'upload' }, { id: 'doc-2', name: 'plan.csv', content: 'a,b\n1,2' }];
const DECISION = { options: ['Launch', 'Wait'], constraints: [], successCriteria: ['10 paying teams'], knownFacts: [], assumptions: [], unknowns: ['Churn'] };
const CLAIMS = [
  { id: 'c1', expertId: 'x1', text: 'Revenue grew 12%', references: [{ kind: 'document', id: 'doc-1', available: true }, { kind: 'knowledge', id: 'k-77', available: true }], status: 'linked' },
  { id: 'c2', expertId: 'x2', text: EVIL, references: [{ kind: 'document', id: 'doc-9', available: false }], status: 'unlinked' },
];
const REVIEW = { status: 'completed', snapshotHash: 'h1', startedAt: 10, completedAt: 20, execution: 'server-nosana', reports: [
  { reviewerExpertId: 'x2', summary: 'Mostly holds', findings: [{ targetExpertId: 'x1', evidenceIndex: 1, verdict: 'challenged', rationale: 'Sample too small' }, { targetExpertId: 'x1', evidenceIndex: 0, verdict: 'supported', rationale: 'Matches doc-1' }] },
  { reviewerExpertId: 'x1', summary: 'n/a', findings: [] }] };
const liveBrief = (over = {}) => ({ title: 'T', objective: 'O', context: '', expertIds: ['x1', 'x2'], mode: 'live', requestId: 'r', ...over });
const projectRaw = (over = {}) => ({ id: 'proj-1', status: 'completed', createdAt: 1, updatedAt: 5, brief: liveBrief({ decision: DECISION, documents: DOCS }),
  experts: [run(1, 'completed'), run(2, 'completed')], ...over });

await test('ProjectRun 정리: 결정·자료·주장 장부·교차 검토를 지키고, 모르는 교차 검토 값이면 그리지 않는다', () => {
  const p = core.normalizeProject(projectRaw({ evidenceClaims: CLAIMS, crossReview: REVIEW }));
  assert.deepEqual(plain(p.brief.decision), DECISION);
  assert.deepEqual(plain(p.brief.documents), DOCS, 'origin kept when present');
  assert.deepEqual(plain(p.evidenceClaims), CLAIMS);
  assert.deepEqual(plain(p.crossReview), REVIEW);
  const none = core.normalizeProject(projectRaw({ brief: liveBrief() }));
  for (const k of ['decision', 'documents']) assert.equal(k in none.brief, false);
  assert.equal('evidenceClaims' in none, false); assert.equal('crossReview' in none, false);
  assert.deepEqual(plain(core.normalizeProject(projectRaw({ evidenceClaims: [] })).evidenceClaims), [], 'empty ledger stays distinct from absent');
  const fixed = core.normalizeProject(projectRaw({ evidenceClaims: [{ id: 'z', expertId: 'x1', text: 't', status: 'proven', references: [{ kind: 'url', id: 'u' }, { kind: 'knowledge', id: 'k', available: 'yes' }] }] }));
  assert.deepEqual(plain(fixed.evidenceClaims[0]), { id: 'z', expertId: 'x1', text: 't', references: [{ kind: 'knowledge', id: 'k', available: false }], status: 'unlinked' });
  for (const bad of [{ ...REVIEW, execution: 'sandbox' }, { ...REVIEW, status: 'done' },
    { ...REVIEW, reports: [{ reviewerExpertId: 'x2', summary: '', findings: [{ targetExpertId: 'x1', evidenceIndex: 0, verdict: 'true', rationale: '' }] }] },
    { ...REVIEW, reports: [{ reviewerExpertId: 'x2', summary: '', findings: [{ targetExpertId: 'x1', evidenceIndex: -1, verdict: 'supported', rationale: '' }] }] }]) {
    const q = core.normalizeProject(projectRaw({ crossReview: bad }));
    assert.equal(q.crossReview, undefined); assert.equal(q.invalidCrossReview, true);
  }
});

await test('교차 검토 조건: 끝났고 취소되지 않았으며 의견 있는 완료 전문가 2명 이상 (서버와 같다)', () => {
  const p = (over) => core.normalizeProject(projectRaw(over));
  assert.equal(core.reviewEligible(p({})), true);
  assert.equal(core.reviewEligible(p({ status: 'partial', experts: [run(1, 'completed'), run(2, 'completed'), run(3, 'failed')] })), true);
  assert.equal(core.reviewEligible(p({ status: 'running' })), false);
  assert.equal(core.reviewEligible(p({ status: 'cancelled' })), false);
  assert.equal(core.reviewEligible(p({ status: 'partial', experts: [run(1, 'completed'), run(2, 'failed')] })), false);
});

await test('데모 PROJECT.md 는 결정 세부 정보와 자료 원문을 그대로 담고, 자료가 지시가 아니라고 밝힌다', () => {
  const md = core.projectMarkdown(liveBrief({ mode: 'demo', decision: DECISION, documents: DOCS }));
  assert.match(md, /## Options being considered\n- Launch\n- Wait/); assert.ok(!md.includes('## Constraints'), 'empty fields are skipped');
  assert.ok(md.includes('## doc-1: notes.md')); assert.ok(md.includes(DOCS[0].content)); assert.match(md, /not instructions, not verified fact/);
  assert.equal(core.projectMarkdown(liveBrief({ mode: 'demo' })), '# T\n\n## Objective\nO\n\n## Context\n(none)', 'without the optional fields the file is unchanged');
});

await test('생성 JS·CSS: 저장소·innerHTML·외부 주소 없음, 모바일에서 근거 패널은 작업공간 다음 줄', () => {
  assert.ok(!/innerHTML|outerHTML|localStorage|sessionStorage|indexedDB|document\.cookie|https?:\/\//.test(CLOUDBITE_JS));
  assert.match(CLOUDBITE_CSS, /\.cb-home\.has-rail > \.cb-center > \.cb-evidence \{ grid-row: 4; \}/);
});

// ───────── 가짜 DOM (test/cloudbite-console.mjs 와 같은 모양, 이 파일에 필요한 만큼)
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
/** 계획 미리보기 기본 응답: 보낸 팀을 그대로 돌려주는 올바른 ProjectPreview. 미리보기 요청은 env.previews 에 따로 모은다 */
const PREVIEW_OK = (url, init) => {
  const b = JSON.parse(init.body), n = b.expertIds.length;
  return json(200, { expertIds: b.expertIds, assignments: [], budget: { maxExperts: n, maxModelCalls: n * 8 + 4, maxReviewCalls: 3, maxMemoCalls: 1 },
    envelope: { sandboxMaximum: n, nosanaMaximum: n * 8 + 4, expertMaximum: n * 8, reviewMaximum: 3, memoMaximum: 1, jevCalls: b.routing ? 1 : 0 }, warnings: [] });
};
function fakeEnv(fetchImpl, { boot = CATALOGUE, globals = {}, preview = PREVIEW_OK } = {}) {
  const timers = new Map(); let seq = 0, now = 0;
  const doc = { readyState: 'complete', activeElement: null, createElement: (t) => new Node_(doc, t), getElementById: (id) => id === 'cloudbite' ? root : null,
    listeners: {}, addEventListener(t, f) { (this.listeners[t] ||= []).push(f); } };
  doc.documentElement = new Node_(doc, 'html');
  const root = new Node_(doc, 'div'); root.id = 'cloudbite'; doc.body = new Node_(doc, 'body'); doc.body.append(root);
  const requests = [], previews = [];
  const ctx = vm.createContext({
    document: doc, crypto: globalThis.crypto, CSS: { escape: (s) => s }, URL, URLSearchParams, Blob,
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { at: now + (ms || 0), fn }); return id; },
    clearTimeout: (id) => { timers.delete(id); }, setInterval: () => 0,
    fetch: (url, init = {}) => {
      if (String(url).startsWith('/api/cloudbite/owner/')) return json(200, { authenticated: false, hasCredentials: false });
      if (url === '/api/cloudbite/bootstrap') return json(200, boot);
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
  const byId = (id) => all().find(n => n.id === id);
  return { root, doc, requests, previews, flush, advance, all, byText, fk, byId };
}
const CATALOGUE = {
  experts: ['x1', 'x2', 'x3'].map((id, i) => ({ id, name: `Expert ${i + 1}`, domain: 'd', summary: 's', prompt: 'p', tools: [], outputs: [], source: {} })),
  configuration: { liveReady: true, missing: [], maxExperts: 5 },
};
const ROUTING_BOOT = { ...CATALOGUE, configuration: { ...CATALOGUE.configuration, routing: { provider: 'typesafe', model: 'jev-1.13.0', ready: true, maxExperts: 5 } } };
/** 가짜 File: text() 는 바로 끝나거나, hold 면 release(글) 를 부를 때까지 기다린다 */
function file(name, content, { type = 'text/plain', hold = false } = {}) {
  const f = { name, type, size: new TextEncoder().encode(content).length };
  if (hold) { f.promise = new Promise(r => { f.release = () => r(content); }); f.text = () => f.promise; } else f.text = async () => content;
  return f;
}
const pickFiles = async (env, files) => { const inp = env.byId('cb-docs-file'); inp.files = files; inp.dispatch('change'); await env.flush(); };
const docsErrOf = (env) => env.all().find(n => n.className === 'cb-formmsg cb-docs-err').textContent;
const docNames = (env) => env.all().filter(n => n.className === 'cb-doc-name').map(n => n.textContent);
const langBtn = (env, l) => env.fk(`lang:${l}`);
const setValue = async (env, id, value) => { const n = env.byId(id); n.value = value; n.dispatch('input'); await env.flush(); };
const goLive = async (env) => {
  await env.flush();
  env.byText('BUTTON', 'Live run').click(); await env.flush();
  await setValue(env, 'cb-token', 'adm-secret-123');
};
const selectTwo = async (env) => {
  for (const id of ['x1', 'x2', 'x3']) {
    const box = env.fk(`x:${id}`), want = id !== 'x3';
    if (box.checked !== want) { box.checked = want; box.dispatch('change'); await env.flush(); }
  }
  await env.flush();
};

await test('첫 화면: 결정 세부 정보와 근거 자료는 목표 아래 접힌 선택 상자이고, 실행 기본 흐름은 그대로', async () => {
  const env = fakeEnv(() => json(404, {}));
  await env.flush();
  const dec = env.all().find(n => n.className === 'cb-disclosure cb-decision'), docs = env.all().find(n => n.className === 'cb-disclosure cb-docs');
  assert.ok(dec && docs); assert.equal(dec.open, false); assert.equal(dec.getAttribute('open'), null); assert.equal(docs.open, false);
  const form = env.all().find(n => n.tagName === 'FORM');
  const order = [...form.walk()].filter(n => n.id === 'cb-objective' || n === dec || n === docs || n.getAttribute('data-fk') === 'start');
  assert.deepEqual(order.map(n => n.id || n.className || n.getAttribute('data-fk')), ['cb-objective', 'cb-disclosure cb-decision', 'cb-disclosure cb-docs', 'cb-primary cb-start']);
  for (const f of ['options', 'constraints', 'successCriteria', 'knownFacts', 'assumptions', 'unknowns']) {
    const ta = env.byId(`cb-dec-${f}`); assert.equal(ta.tagName, 'TEXTAREA');
    assert.ok(env.all().some(n => n.tagName === 'LABEL' && n.getAttribute('for') === `cb-dec-${f}`), `${f} has a label`);
  }
  assert.match(dec.textContent, /Decision details \(optional\)not used/);
  assert.match(docs.textContent, /Project evidence \(optional\)none/);
  assert.ok(!env.all().some(n => n.className === 'cb-panel cb-evidence' && !n.hidden), 'no evidence panel before a project exists');
});

await test('근거 파일: 거부는 KO/EN 로 다시 그려지고, 빼면 doc-1.. 로 다시 매겨지며, 데모 PROJECT.md 에 실제 원문이 들어간다 (리뷰는 없다)', async () => {
  const env = fakeEnv(() => json(404, {}));
  await env.flush();
  await pickFiles(env, [file('a.md', 'Alpha text'), file('scan.pdf', '%PDF', { type: 'application/pdf' }), file('b.txt', 'Bravo text'), file('c.csv', 'x,y')]);
  assert.deepEqual(docNames(env), ['a.md', 'b.txt', 'c.csv']);
  assert.match(docsErrOf(env), /scan\.pdf: only TXT, MD, CSV and JSON files can be added/);
  langBtn(env, 'ko').click(); await env.flush();
  assert.match(docsErrOf(env), /scan\.pdf: TXT·MD·CSV·JSON 파일만 추가할 수 있습니다/);
  assert.match(env.root.textContent, /파일 6개 중 3개/);
  langBtn(env, 'en').click(); await env.flush();
  env.fk(docKeyOf(env, 'a.md')).click(); await env.flush();
  assert.deepEqual(docNames(env), ['b.txt', 'c.csv']);
  assert.equal(env.doc.activeElement.getAttribute('data-fk'), docKeyOf(env, 'b.txt'), 'focus moves to the next remove button');
  assert.deepEqual(env.all().filter(n => n.className === 'cb-tag' && /^doc-/.test(n.textContent)).map(n => n.textContent), ['doc-1', 'doc-2']);
  const remove = env.fk(docKeyOf(env, 'c.csv')); assert.equal(remove.getAttribute('aria-label'), 'Remove doc-2 c.csv');
  await setValue(env, 'cb-dec-options', 'Ship now\nWait a quarter');
  env.fk('start').click(); await env.flush(); await env.advance(20000);
  env.fk('file:PROJECT.md').click(); await env.flush();
  const md = env.all().find(n => n.tagName === 'PRE' && n.textContent.includes('## doc-1: b.txt'))?.textContent;
  assert.ok(md && md.includes('Bravo text') && md.includes('## doc-2: c.csv') && md.includes('- Ship now') && !md.includes('Alpha text'));
  const panel = env.all().find(n => n.className === 'cb-panel cb-evidence');
  assert.equal(panel.hidden, false);
  assert.match(panel.textContent, /Browser demo: no claim ledger or cross-review is produced/);
  assert.ok(!env.fk('review-run'));
  assert.equal(env.requests.filter(r => String(r.url).includes('/review')).length, 0, 'demo never starts a backend cross-review');
  assert.deepEqual(docNames(env), ['b.txt', 'c.csv'], 'documents stay in memory after the run');
});
function docKeyOf(env, name) {
  const li = env.all().find(n => n.className === 'cb-doc' && n.textContent.includes(name) && n.parent && n.parent.className === 'cb-doc-list');
  return [...li.walk()].find(n => (n.getAttribute('data-fk') || '').startsWith('doc-rm:')).getAttribute('data-fk');
}

await test('비동기 읽기: 읽는 중에는 시작을 막고, 언어를 바꾸거나 다른 파일을 빼도 입력이 남으며 한도는 끝난 순간의 목록으로 잰다', async () => {
  const env = fakeEnv(() => json(404, {}));
  await env.flush();
  await pickFiles(env, [file('one.txt', 'x'.repeat(8000))]);
  const slow = file('slow.txt', 'y'.repeat(8000), { hold: true }), slow2 = file('slow2.txt', 'z'.repeat(8000), { hold: true });
  await pickFiles(env, [slow, slow2]);
  await setValue(env, 'cb-dec-unknowns', 'Will churn stay low?');
  assert.equal(env.fk('start').disabled, true, 'start waits for file reads');
  assert.match(env.root.textContent, /Reading files…/);
  langBtn(env, 'ko').click(); await env.flush();
  assert.match(env.root.textContent, /파일을 읽는 중…/);
  env.fk(docKeyOf(env, 'one.txt')).click(); await env.flush();
  slow.release(); await env.flush(); slow2.release(); await env.flush();
  assert.deepEqual(docNames(env), ['slow.txt', 'slow2.txt'], 'reads finish in order after the removal');
  assert.equal(env.byId('cb-dec-unknowns').value, 'Will churn stay low?', 'typed decision text survives language switch and rerender');
  assert.equal(env.fk('start').disabled, false);
  const third = file('third.txt', 'w'.repeat(8000));
  await pickFiles(env, [third]);
  assert.deepEqual(docNames(env), ['slow.txt', 'slow2.txt', 'third.txt']);
  await pickFiles(env, [file('fourth.txt', 'v')]);
  assert.match(docsErrOf(env), /fourth\.txt: 추가하면 합계 24,000자를 넘어/);
});

await test('결정 칸 한도 위반은 접힌 상자를 펼치고 시작하지 않는다', async () => {
  const env = fakeEnv(() => json(404, {}));
  await env.flush();
  await setValue(env, 'cb-dec-constraints', Array.from({ length: 9 }, (_, i) => `c${i}`).join('\n'));
  env.fk('start').click(); await env.flush();
  assert.equal(env.all().find(n => n.className === 'cb-disclosure cb-decision').open, true);
  assert.match(env.root.textContent, /Constraints: use at most 8 lines\./);
  assert.ok(!env.all().some(n => n.className.startsWith('cb-card ')), 'no run started');
});

/** 실제 실행 서버: 프로젝트 만들기 → 조회(끝남) → 교차 검토 */
function liveServer({ review, final = projectRaw({ evidenceClaims: CLAIMS }) } = {}) {
  return (url, init) => {
    if (url === '/api/cloudbite/route') return json(200, { provider: 'typesafe', model: 'jev', policyVersion: 'jev-routing/v1', evaluatedCount: 3, threshold: 0.5, expertIds: ['x1', 'x2'],
      matches: [{ expertId: 'x1', relevance: 0.9 }, { expertId: 'x2', relevance: 0.8 }], queryHash: 'q', expiresAt: Date.now() + 600000 });
    if (url === '/api/cloudbite/projects' && init.method === 'POST') return json(201, { project: { ...final, status: 'running', updatedAt: 1, experts: final.experts.map(e => ({ ...e, status: 'running', opinion: undefined })) }, accessToken: 'proj-scope-tok' });
    if (url === '/api/cloudbite/projects/proj-1/review') return review(init);
    if (url === '/api/cloudbite/projects/proj-1') return json(200, final);
    return json(404, {});
  };
}
/** 시작 버튼: 실제 실행은 계획 준비 → 이 계획으로 실행 두 걸음이라, 계획이 준비되면 한 번 더 누른다 */
const go = async (env) => {
  env.fk('start').click(); await env.flush();
  if (['Run this plan', '이 계획으로 실행'].includes(env.fk('start').textContent.trim())) { env.fk('start').click(); await env.flush(); }
};
const posted = (env, url) => env.requests.filter(r => r.url === url && r.init.method === 'POST').map(r => JSON.parse(r.init.body));

await test('Jev 경로 묻기와 프로젝트 만들기는 같은 decision·documents 를 보낸다 (doc id 는 빼고 남은 순서)', async () => {
  const env = fakeEnv(liveServer({ review: () => json(500, {}) }), { boot: ROUTING_BOOT });
  await goLive(env);
  await pickFiles(env, [file('drop.txt', 'Drop me'), file('keep.md', 'Keep me')]);
  env.fk(docKeyOf(env, 'drop.txt')).click(); await env.flush();
  await setValue(env, 'cb-dec-options', 'A\nB'); await setValue(env, 'cb-dec-successCriteria', '  Profit  ');
  await go(env);
  const [route] = posted(env, '/api/cloudbite/route'), [create] = posted(env, '/api/cloudbite/projects');
  const decision = { options: ['A', 'B'], constraints: [], successCriteria: ['Profit'], knownFacts: [], assumptions: [], unknowns: [] };
  const documents = [{ id: 'doc-1', name: 'keep.md', content: 'Keep me' }];
  assert.deepEqual(route.decision, decision); assert.deepEqual(route.documents, documents);
  assert.deepEqual(create.decision, decision); assert.deepEqual(create.documents, documents);
  assert.equal(create.routing, 'jev'); assert.equal(create.requestId, route.requestId);
});

await test('직접 고른 실제 실행: 선택 필드를 쓰지 않으면 보내지 않는다 (예전 본문 그대로)', async () => {
  const env = fakeEnv(liveServer({ review: () => json(500, {}) }));
  await goLive(env); await selectTwo(env);
  await go(env);
  const [create] = posted(env, '/api/cloudbite/projects');
  assert.ok(create, 'project created');
  assert.equal('decision' in create, false); assert.equal('documents' in create, false);
});

async function finishedLive(review, final) {
  const env = fakeEnv(liveServer({ review, final }));
  await goLive(env);
  await pickFiles(env, [file('notes.md', DOCS[0].content)]);
  await selectTwo(env);
  await go(env); await env.advance(1500);
  return env;
}
const panelOf = (env) => env.all().find(n => n.className === 'cb-panel cb-evidence');

await test('결과: 주장 장부는 접혀 있고, 연결됨의 뜻을 밝히며, 자료 원문은 펼칠 때 현재 브리프의 글로 보인다', async () => {
  const env = await finishedLive(() => json(500, {}));
  const panel = panelOf(env);
  assert.equal(panel.hidden, false);
  assert.match(panel.textContent, /Claim ledger — 2 claims, 1 linked/);
  assert.match(panel.textContent, /It does not mean the claim is true, and it is not a calibrated quality score\./);
  assert.match(panel.textContent, /Source ID found/); assert.match(panel.textContent, /No source ID found/);
  assert.match(panel.textContent, /doc-1 · notes\.md — show source text/);
  assert.match(panel.textContent, /doc-9 — not among this project's documents/);
  assert.match(panel.textContent, /Knowledge source k-77 — listed in the knowledge pack \(metadata only; not checked against the claim\)/);
  const pre = [...panel.walk()].filter(n => n.tagName === 'PRE');
  assert.ok(pre.some(n => n.textContent === DOCS[0].content), 'document text comes from project.brief.documents');
  assert.ok(panel.textContent.includes(EVIL) && ![...panel.walk()].some(n => ['IMG', 'SCRIPT', 'A'].includes(n.tagName)), 'server text drawn as text; no links');
  const ledger = [...panel.walk()].find(n => n.className === 'cb-disclosure cb-quiet cb-ledger');
  assert.equal(ledger.getAttribute('open'), null, 'collapsed by default');
  ledger.open = true; ledger.dispatch('toggle'); await env.advance(1);
  langBtn(env, 'ko').click(); await env.flush();
  const again = [...panelOf(env).walk()].find(n => n.className === 'cb-disclosure cb-quiet cb-ledger');
  assert.equal(again.getAttribute('open'), '', 'open state survives rerender and language switch');
  assert.match(panelOf(env).textContent, /주장 장부 — 주장 2개, 연결 1개/);
});

await test('교차 검토: 버튼은 끝난 실제 실행에서만, bearer·빈 JSON 으로 한 번 POST, 진행 → 완료와 실제 보고서를 보인다', async () => {
  let release;
  const env = await finishedLive(() => new Promise(r => { release = r; }));
  assert.match(panelOf(env).textContent, /server-side second pass on Nosana/);
  const btn = env.fk('review-run');
  assert.equal(btn.textContent, 'Run cross-review');
  btn.click(); await env.flush();
  const reqs = env.requests.filter(r => r.url === '/api/cloudbite/projects/proj-1/review');
  assert.equal(reqs.length, 1);
  assert.equal(reqs[0].init.method, 'POST'); assert.equal(reqs[0].init.body, '{}'); assert.equal(reqs[0].init.credentials, 'same-origin');
  assert.equal(reqs[0].init.headers.authorization, 'Bearer proj-scope-tok'); assert.equal(reqs[0].init.headers['content-type'], 'application/json');
  assert.match(panelOf(env).textContent, /Cross-review running…/); assert.ok(!env.fk('review-run'), 'no second click while running');
  release({ ok: true, status: 200, json: async () => projectRaw({ evidenceClaims: CLAIMS, crossReview: REVIEW }) }); await env.flush();
  const text = panelOf(env).textContent;
  assert.match(text, /Cross-review completed at .*\. The original opinions are unchanged\./);
  assert.match(text, /Reviewer: Expert 2/); assert.match(text, /Mostly holds/);
  assert.match(text, /Challenged/); assert.match(text, /Expert 1 · evidence 2/); assert.match(text, /ev-1/); assert.match(text, /Sample too small/);
  assert.match(text, /Supported/); assert.match(text, /Expert 1 · evidence 1/);
  assert.match(text, /No findings in this report\./);
  const chips = [...panelOf(env).walk()].filter(n => n.className.startsWith('cb-chip ')).map(n => n.className);
  assert.deepEqual(chips, ['cb-chip d-concern', 'cb-chip d-support']);
  assert.ok(!env.fk('review-run'), 'completed review has no run button');
  await env.advance(60000);
  assert.equal(env.requests.filter(r => r.url.endsWith('/review')).length, 1, 'no automatic paid retry');
});

await test('교차 검토 실패: 응답 미확인은 실행되지 않았다고 단정하지 않으며 저장된 상태를 확인할 수 있다', async () => {
  let n = 0;
  const env = await finishedLive(() => ++n === 1 ? json(503, { error: 'cross-review inference is not configured' })
    : json(200, projectRaw({ evidenceClaims: CLAIMS, crossReview: { status: 'failed', snapshotHash: 'h', startedAt: 1, completedAt: 2, reports: [], error: 'x2: inference upstream unavailable', execution: 'server-nosana' } })));
  env.fk('review-run').click(); await env.flush();
  assert.match(panelOf(env).textContent, /Could not confirm the cross-review: .*cross-review inference is not configured.* Check its saved status/);
  assert.equal(env.fk('review-run').textContent, 'Check or request cross-review');
  langBtn(env, 'ko').click(); await env.flush();
  assert.match(panelOf(env).textContent, /교차 검토 응답을 확인하지 못했습니다/);
  env.fk('review-run').click(); await env.flush();
  const text = panelOf(env).textContent;
  assert.match(text, /교차 검토가 실패했습니다: x2: inference upstream unavailable 원래 의견은 그대로입니다/);
  assert.ok(!/교차 검토를 마쳤습니다/.test(text), 'failed is not shown as completed');
  assert.ok(!env.fk('review-run'), 'the server keeps one attempt per project; no decorative retry');
});

await test('교차 검토 409·진행 중: 서버의 지금 상태를 다시 읽어 조회를 이어 가고 완료를 그대로 보인다', async () => {
  const running = { status: 'running', snapshotHash: 'h', startedAt: 1, reports: [], execution: 'server-nosana' };
  let reads = 0;
  const final = projectRaw({ evidenceClaims: CLAIMS });
  const env = fakeEnv((url, init) => {
    if (url === '/api/cloudbite/projects/proj-1/review') return json(409, { error: 'cross-review already running' });
    if (url === '/api/cloudbite/projects/proj-1' && reads++ >= 1) return json(200, { ...final, crossReview: reads > 3 ? REVIEW : running });
    return liveServer({ final })(url, init);
  });
  await goLive(env); await selectTwo(env);
  await go(env); await env.advance(1500);
  env.fk('review-run').click(); await env.flush();
  assert.match(panelOf(env).textContent, /Cross-review running…/);
  await env.advance(3000);
  assert.match(panelOf(env).textContent, /Cross-review running…/);
  await env.advance(6000);
  assert.match(panelOf(env).textContent, /Cross-review completed at/);
  assert.equal(env.requests.filter(r => r.url.endsWith('/review')).length, 1);
});

await test('교차 검토 응답 전에 새 실행을 시작하면 늦은 응답은 새 프로젝트를 덮지 않는다', async () => {
  let release;
  const env = await finishedLive(() => new Promise(r => { release = r; }));
  env.fk('review-run').click(); await env.flush();
  env.fk('setup').click(); await env.flush();
  await go(env);
  release({ ok: true, status: 200, json: async () => projectRaw({ crossReview: REVIEW }) }); await env.flush();
  assert.ok(!/Reviewer: Expert 2/.test(panelOf(env).textContent), 'late review response ignored');
  assert.equal(env.requests.filter(r => r.url === '/api/cloudbite/projects' && r.init.method === 'POST').length, 2);
});

await test('끝났지만 완료 전문가가 2명 미만이면 버튼 대신 이유만, 실행 중에는 교차 검토 상자가 없다', async () => {
  const one = projectRaw({ status: 'partial', experts: [run(1, 'completed'), run(2, 'failed')] });
  const env = fakeEnv(liveServer({ final: one, review: () => json(500, {}) }));
  await goLive(env); await selectTwo(env);
  await go(env);
  assert.ok(!env.fk('review-run'));
  await env.advance(1500);
  assert.ok(!env.fk('review-run'));
  assert.match(panelOf(env).textContent, /Cross-review needs a finished live run with at least 2 completed experts\./);
});

await test('사용 기록 상세: 저장된 결정·장부·교차 검토를 읽기 전용으로 그리고 실행 버튼·POST 가 없다', async () => {
  const id = 'cb' + 'a'.repeat(32), now = Date.now();
  const p = projectRaw({ id, evidenceClaims: CLAIMS, crossReview: REVIEW, createdAt: now });
  const row = { id, title: 'T', mode: 'live', status: 'completed', createdAt: now, updatedAt: now, expiresAt: now + 86400_000, expertCount: 2, feedbackCount: 0, model: 'test' };
  const env = fakeEnv((url) => {
    if (url.startsWith('/api/cloudbite/history?')) return json(200, { rows: [row], next: null, owner: false, retentionDays: 30 });
    return json(200, { project: p, model: 'test', roles: [], feedback: [], expiresAt: row.expiresAt, canFeedback: false });
  }, { globals: { location: { pathname: '/cloudbite/history', search: '?lang=en', hash: '' } } });
  await env.flush();
  env.fk('hist-record:' + id).click(); await env.flush();
  const detail = env.all().find(n => n.className === 'cb-panel cb-history-detail');
  const text = detail.textContent;
  assert.match(text, /Saved cross-review \(read-only\)/);
  assert.match(text, /Claim ledger — 2 claims, 1 linked/); assert.match(text, /Reviewer: Expert 2/); assert.match(text, /Sample too small/);
  assert.match(text, /Options being considered/); assert.match(text, /Project documents \(2\)/);
  assert.ok(!env.fk('review-run'));
  assert.equal(env.requests.filter(r => r.init.method === 'POST').length, 0);
  langBtn(env, 'ko').click(); await env.flush();
  assert.match(env.all().find(n => n.className === 'cb-panel cb-history-detail').textContent, /저장된 교차 검토 \(읽기 전용\)/);
});

await test('100인 x 근거 8개 장부를 200개에서 조용히 자르지 않고 전부 유지한다', () => {
  const evidenceClaims=Array.from({length:800},(_,i)=>({id:'claim-'+i,expertId:'x1',text:'claim '+i,references:[],status:'unlinked'}));
  const p=core.normalizeProject(projectRaw({evidenceClaims}));
  assert.equal(p.evidenceClaims.length,800);assert.equal(p.evidenceClaims[799].text,'claim 799');
});
console.log(`cloudbite-decision-ui: ${pass} passed`);
