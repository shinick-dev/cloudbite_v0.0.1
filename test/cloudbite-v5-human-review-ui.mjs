// Cloudbite 콘솔의 사람 평가 칸과 핵심 주장 판정 화면 (src/cloudbite-page.ts 의 CLOUDBITE_JS) 을 브라우저 없이 고정한다:
// 접힌 사람 평가 칸·평가 대상 해시·"사람 점수이지 모델 정답이 아님" 표시, 저장(같은 내용 재전송은 같은 requestId)·충돌·모름·거부에서 초안 유지,
// KO/EN 전환에도 초안 유지, 다시 읽을 때 저장본, 남의 기록은 읽기 전용, 회귀 JSON 내려받기, report.claimFindings 정리와 작성자 응답 조건.
// test/cloudbite-v4-ui.mjs 와 같은 모양의 작은 가짜 DOM 이다. 실제 브라우저·서버·공급자 증거가 아니다.
//   node tools/build-cloudbite-console.mjs && node test/cloudbite-v5-human-review-ui.mjs
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { CLOUDBITE_JS } from '../src/cloudbite-page.ts';
import { HUMAN_DIMENSIONS, HUMAN_REVIEW_ISSUES } from '../src/cloudbite-human-review.ts';

let pass = 0;
const test = async (name, fn) => { await fn(); pass++; console.log(`  ok   ${name}`); };
const plain = (v) => JSON.parse(JSON.stringify(v));

let core = null;
vm.runInContext(CLOUDBITE_JS, vm.createContext({ __cloudbiteTestHook: (c) => { core = c; }, crypto: globalThis.crypto }));
assert.ok(core);
const HR = { en: core.HR_TEXT.en, ko: core.HR_TEXT.ko };

const ID = 'cb' + 'a'.repeat(32), OUT = 'e'.repeat(64), HASH = 'f'.repeat(64);
const opinion = (s) => ({ direction: 'concern', confidence: 60, summary: s, evidence: ['ev-0', 'ev-1'], assumptions: ['as-0'], nextActions: ['na-0', 'na-1'] });
const run = (i) => ({ id: `run-${i}`, expertId: `x${i}`, name: `Expert ${i}`, status: 'completed', activity: [], artifacts: [], updatedAt: 1, opinion: opinion(`summary ${i}`) });
const brief = { title: 'T', objective: 'O', context: '', expertIds: ['x1', 'x2', 'x3'], mode: 'live', requestId: 'r' };
const projectRaw = (over = {}) => ({ id: ID, status: 'completed', createdAt: Date.now(), updatedAt: 5, brief, experts: [run(1), run(2), run(3)], ...over });
const scores = (over = {}) => ({ ...Object.fromEntries(HUMAN_DIMENSIONS.map(d => [d, null])), ...over });
const review = (over = {}) => ({ version: 'cloudbite-human-review/v1', expertId: 'x1', outputSha256: OUT, revision: 1, scores: scores({ relevance: 3 }), issues: [],
  comment: '', regressionCandidate: false, recordedBy: 'project-user', createdAt: 1700000000000, updatedAt: 1700000000000, ...over });
const humanReview = ({ reviews = {}, canReview = true } = {}) => ({ version: 'cloudbite-human-review/v1', rubric: 'cloudbite-quality/v1', dimensions: HUMAN_DIMENSIONS, issues: HUMAN_REVIEW_ISSUES,
  outputs: { x1: { outputSha256: OUT, answerSha256: HASH, questionHash: HASH, materialHash: HASH, stage: 'initial' } }, reviews, canReview });

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
const ROW = { id: ID, title: 'T', mode: 'live', status: 'completed', createdAt: 1, updatedAt: 1, expiresAt: Date.now() + 86400_000, expertCount: 3, feedbackCount: 0, model: 'test' };
const detailOf = (hr, project = projectRaw()) => ({ project, model: 'test', roles: [], feedback: [], expiresAt: ROW.expiresAt, canFeedback: hr ? hr.canReview : true, ...(hr ? { humanReview: hr } : {}) });

/** 사용 기록 서버. state.hr 이 상세의 humanReview, post(body, n) 가 POST /human-review 응답 */
function fakeEnv(state, post, exportImpl = null) {
  const doc = { readyState: 'complete', activeElement: null, createElement: (t) => new Node_(doc, t), getElementById: (id) => id === 'cloudbite' ? root : null,
    listeners: {}, addEventListener(t, f) { (this.listeners[t] ||= []).push(f); } };
  doc.documentElement = new Node_(doc, 'html');
  const root = new Node_(doc, 'div'); root.id = 'cloudbite'; doc.body = new Node_(doc, 'body'); doc.body.append(root);
  const requests = [], blobs = [], clicks = [];
  doc.body.append = ((orig) => function (...ns) { for (const n of ns) if (n && n.tagName === 'A') n.addEventListener('click', () => clicks.push(n.getAttribute('download'))); return orig.apply(this, ns); })(doc.body.append);
  const FakeURL = class extends URL {};
  FakeURL.createObjectURL = (b) => { blobs.push(b); return 'blob:x'; }; FakeURL.revokeObjectURL = () => {};
  const ctx = vm.createContext({
    document: doc, crypto: globalThis.crypto, CSS: { escape: (s) => s }, URL: FakeURL, URLSearchParams, Blob,
    location: { pathname: '/cloudbite/history', search: '?lang=en', hash: '' },
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0,
    fetch: (url, init = {}) => {
      url = String(url); init = { method: 'GET', ...init };
      if (url.startsWith('/api/cloudbite/owner/')) return json(200, { authenticated: false, hasCredentials: false });
      if (url === '/api/cloudbite/bootstrap') return json(200, CATALOGUE);
      requests.push({ url, init });
      if (url.startsWith('/api/cloudbite/history?')) return json(200, { rows: [ROW], next: null, owner: false, retentionDays: 30 });
      if (url === `/api/cloudbite/history/${ID}`) return json(200, detailOf(state.hr, state.project));
      if (url === `/api/cloudbite/history/${ID}/human-review` && init.method === 'POST') return post(JSON.parse(init.body), requests.filter(r => r.init.method === 'POST').length);
      if (url.startsWith(`/api/cloudbite/history/${ID}/human-review?`)) return exportImpl ? exportImpl(url) : json(404, { error: 'no saved human review for this answer' });
      return json(404, { error: 'not found' });
    },
  });
  vm.runInContext(CLOUDBITE_JS, ctx);
  const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); };
  const all = () => [...root.walk()];
  const fk = (k) => all().find(n => n.getAttribute('data-fk') === k);
  const posts = () => requests.filter(r => r.init.method === 'POST').map(r => JSON.parse(r.init.body));
  return { root, requests, blobs, clicks, flush, all, fk, posts };
}
const K = `${ID}:x1:hr:`;
const openDetail = async (env) => { await env.flush(); env.fk('hist-record:' + ID).click(); await env.flush(); };
const box = (env) => env.all().find(n => n.tagName === 'DETAILS' && n.children.some(c => typeof c !== 'string' && c.tagName === 'SUMMARY' && /Human review|사람 평가/.test(c.textContent)));
const setScore = (env, dim, v) => { const s = env.fk(K + dim); assert.ok(s, dim); s.value = v; s.dispatch('change'); };
const setComment = (env, v) => { const c = env.fk(K + 'comment'); c.value = v; c.dispatch('input'); };
const stateText = (env) => env.fk(K + 'state')?.textContent ?? '';

await test('copy, dimensions and issues mirror the server; KO/EN keys match; the box says person score, not model truth, and not blind', () => {
  assert.deepEqual(plain(core.HR_DIMENSIONS), HUMAN_DIMENSIONS); assert.deepEqual(plain(core.HR_ISSUES), HUMAN_REVIEW_ISSUES);
  assert.deepEqual(Object.keys(HR.en), Object.keys(HR.ko));
  for (const l of ['en', 'ko']) { assert.deepEqual(Object.keys(HR[l].dims), HUMAN_DIMENSIONS); assert.deepEqual(Object.keys(HR[l].issues), HUMAN_REVIEW_ISSUES); }
  assert.match(HR.en.note, /not model truth/); assert.match(HR.en.note, /Not blind/); assert.match(HR.ko.note, /모델의 정답/); assert.match(HR.ko.note, /블라인드가 아닙니다/);
});

await test('normalization fails closed on unknown versions, rubric drift, bad scores or hashes, and never invents a review', () => {
  assert.ok(core.normalizeHumanReview(humanReview()));
  assert.equal(core.normalizeHumanReview({ ...humanReview(), version: 'v2' }), null);
  assert.equal(core.normalizeHumanReview({ ...humanReview(), dimensions: HUMAN_DIMENSIONS.slice(1) }), null);
  assert.equal(core.normalizeHumanReview(humanReview({ reviews: { x1: review({ scores: scores({ relevance: 5 }) }) } })), null);
  assert.equal(core.normalizeHumanReview(humanReview({ reviews: { x1: review({ outputSha256: 'nope' }) } })), null);
  assert.equal(core.normalizeHumanReview(humanReview({ reviews: { x1: review({ issues: [{ category: 'made-up', comment: '' }] }) } })), null);
  assert.equal(core.normalizeHumanReview(humanReview({ reviews: { x2: review() } })), null, 'review keyed by another expert');
  assert.deepEqual(plain(core.normalizeHumanReview(humanReview()).reviews), {});
});

await test('collapsed box shows the rated material hash; save sends the full rubric with a server-bound hash; status and reload show the saved person score', async () => {
  const state = { hr: humanReview() };
  const env = fakeEnv(state, (b) => { const r = review({ scores: b.scores, issues: b.issues, comment: b.comment, regressionCandidate: b.regressionCandidate, revision: b.baseRevision + 1 });
    state.hr = humanReview({ reviews: { x1: r } }); return json(200, { review: r }); });
  await openDetail(env);
  const b = box(env); assert.ok(b); assert.equal(b.open, false, 'collapsed by default');
  assert.match(b.textContent, /not model truth/); assert.match(b.textContent, new RegExp(OUT.slice(0, 16))); assert.match(b.textContent, /No human review saved/);
  setScore(env, 'relevance', '3'); setScore(env, 'evidence_traceability', '1');
  env.fk(K + 'i:missing-source').checked = true; env.fk(K + 'i:missing-source').dispatch('change'); await env.flush();
  const note = env.fk(K + 'n:missing-source'); note.value = 'no link for the 80% figure'; note.dispatch('input');
  setComment(env, 'Useful but thin'); env.fk(K + 'flag').checked = true; env.fk(K + 'flag').dispatch('change');
  env.fk(K + 'save').click(); await env.flush();
  const [sent] = env.posts();
  assert.equal(sent.outputSha256, OUT); assert.equal(sent.expertId, 'x1'); assert.equal(sent.baseRevision, 0); assert.match(sent.requestId, /^hr_[0-9a-f]{24}$/);
  assert.deepEqual(sent.scores, scores({ relevance: 3, evidence_traceability: 1 }));
  assert.deepEqual(sent.issues, [{ category: 'missing-source', comment: 'no link for the 80% figure' }]);
  assert.equal(sent.regressionCandidate, true); assert.equal(sent.comment, 'Useful but thin');
  assert.ok(!('actor' in sent) && !('createdAt' in sent) && !('recordedBy' in sent), 'actor and time are the server\'s');
  assert.match(stateText(env), /Saved · revision 1/);
  assert.match(box(env).textContent, /Saved by the project's user · revision 1/);
  assert.match(box(env).textContent, /3 · good/); assert.match(box(env).textContent, /— Not scored/);
  const fresh = fakeEnv(state, () => json(500, {})); await openDetail(fresh);
  assert.equal(fresh.fk(K + 'relevance').value, '3', 'reload preselects the saved score'); assert.equal(fresh.fk(K + 'conditional_next_step').value, '');
  assert.equal(fresh.fk(K + 'comment').value, 'Useful but thin'); assert.equal(fresh.fk(K + 'flag').checked, true);
});

await test('unknown outcome keeps the draft and retries with the same requestId; a changed draft gets a new one; KO/EN switch keeps the draft', async () => {
  let n = 0; const state = { hr: humanReview() };
  const env = fakeEnv(state, () => (++n === 1 ? Promise.reject(new Error('lost')) : n === 2 ? json(503, {}) : json(200, { review: review({ revision: 1, scores: scores({ relevance: 2 }) }) })));
  await openDetail(env);
  setScore(env, 'relevance', '2'); setComment(env, 'draft words');
  env.fk(K + 'save').click(); await env.flush();
  assert.match(stateText(env), /not confirmed/); assert.equal(env.fk(K + 'save').textContent, HR.en.retry);
  env.fk('lang:ko').click(); await env.flush();
  assert.equal(env.fk(K + 'comment').value, 'draft words', 'draft survives the language switch'); assert.match(stateText(env), /확인되지 않았습니다/);
  assert.match(box(env).textContent, /사람 평가 \(내 점수\)/);
  env.fk(K + 'save').click(); await env.flush();
  const [a, b] = env.posts(); assert.equal(a.requestId, b.requestId, 'same content → same requestId');
  setComment(env, 'draft words, edited'); env.fk(K + 'save').click(); await env.flush();
  const c = env.posts()[2]; assert.notEqual(c.requestId, a.requestId, 'changed content → new requestId'); assert.match(stateText(env), /저장됨 · 1번째 수정/);
});

await test('conflict, stale, signed-out, not-own, gone and invalid keep the draft and say why; empty review is refused locally', async () => {
  const other = review({ revision: 2, comment: 'from the other tab' });
  const replies = [
    [json(409, { error: 'the review changed since you loaded it; reload before saving', review: other }), /review changed/, true],
    [json(409, { error: 'the answer you rated is not the saved answer (stale output hash); reload the record', review: null }), /stale output hash/, false],
    [json(401, { error: 'sign in' }), /sign-in for saved records was not accepted/, false],
    [json(403, { error: 'forbidden' }), /Only the project's own user/, false],
    [json(404, { error: 'history record not found' }), /no longer exists/, false],
    [json(400, { error: 'scores.relevance must be 0-4 or null' }), /Not saved: scores.relevance/, false],
  ];
  for (const [reply, msg, showsOther] of replies) {
    const env = fakeEnv({ hr: humanReview() }, () => reply);
    await openDetail(env);
    env.fk(K + 'save').click(); await env.flush();
    assert.equal(env.posts().length, 0); assert.match(stateText(env), /Score at least one dimension/);
    setComment(env, 'mine'); env.fk(K + 'save').click(); await env.flush();
    assert.match(stateText(env), msg); assert.equal(env.fk(K + 'comment').value, 'mine', 'draft kept');
    if (showsOther) { assert.match(box(env).textContent, /from the other tab/); env.fk(K + 'save').click(); await env.flush(); assert.equal(env.posts()[1].baseRevision, 2, 'resave targets the shown revision'); }
  }
});

await test('foreign or finished-by-others records are read-only; regression JSON downloads only after a save; malformed data is not drawn', async () => {
  const saved = review({ issues: [{ category: 'too-generic', comment: 'boilerplate' }], regressionCandidate: true });
  const exp = { version: 'cloudbite-regression-candidate/v1', human: { reviewer: 'reviewer-0123456789abcdef' } };
  const env = fakeEnv({ hr: humanReview({ reviews: { x1: saved }, canReview: false }) }, () => json(500, {}), () => json(200, exp));
  await openDetail(env);
  assert.equal(env.fk(K + 'save'), undefined); assert.equal(env.fk(K + 'relevance'), undefined);
  assert.match(box(env).textContent, /Only the user who ran this project/); assert.match(box(env).textContent, /Too generic — boilerplate/);
  env.fk(K + 'download').click(); await env.flush();
  assert.equal(env.blobs.length, 1); assert.deepEqual(env.clicks, [`cloudbite-regression-${ID}-x1.json`]);
  assert.deepEqual(JSON.parse(await env.blobs[0].text()), exp);
  assert.ok(env.requests.some(r => r.url === `/api/cloudbite/history/${ID}/human-review?expertId=x1`));
  const none = fakeEnv({ hr: humanReview() }, () => json(500, {})); await openDetail(none);
  assert.equal(none.fk(K + 'download'), undefined, 'nothing to export before a saved review');
  const failed = fakeEnv({ hr: humanReview({ reviews: { x1: saved } }) }, () => json(500, {}), () => json(404, { error: 'gone' })); await openDetail(failed);
  failed.fk(K + 'download').click(); await failed.flush(); assert.match(stateText(failed), /Could not download the regression JSON \(404\)/); assert.equal(failed.blobs.length, 0);
  const bad = fakeEnv({ hr: { ...humanReview(), dimensions: ['relevance'] } }, () => json(500, {})); await openDetail(bad);
  assert.match(bad.root.textContent, /cannot read, so it is not shown/); assert.equal(bad.fk(K + 'save'), undefined);
  const legacy = fakeEnv({ hr: undefined }, () => json(500, {})); await openDetail(legacy);
  assert.doesNotMatch(legacy.root.textContent, /Human review/, 'older servers without the sidecar show nothing');
});

// ───────── 핵심 주장 판정과 작성자 응답 조건 (공유 UI)
const REVIEW = (reports) => ({ status: 'completed', snapshotHash: HASH, startedAt: 10, completedAt: 20, execution: 'server-nosana', reports });
const cf = (over = {}) => ({ targetExpertId: 'x1', target: { kind: 'assumption', index: 0, quote: 'as-0' }, verdict: 'challenged', issue: 'missing-assumption', rationale: 'Assumes demand', ...over });
const SUPPORT = (status) => ({ status, quotes: [{ passageId: 'p-1', ref: 'doc:doc-1', textOrigin: 'user-document', quote: 'An exact excerpt.', sourceSha256: HASH,
  startOffset: 0, endOffset: 17, startLine: 1, endLine: 1 }], rationale: 'Only partly.', basis: 'model-assessment', quoteCheck: 'exact-substring', citedText: 'available', packetSha256: HASH });

await test('claimFindings are normalized structurally; malformed ones are disclosed and dropped without dropping evidence verdicts', () => {
  const ok = core.normalizeProject(projectRaw({ crossReview: REVIEW([{ reviewerExpertId: 'x2', summary: '', findings: [], claimFindings: [cf()] }]) }));
  assert.deepEqual(plain(ok.crossReview.reports[0].claimFindings), [cf()]);
  const md = core.phaseTwoMarkdown(ok, core.DICT.en).join('\n');
  assert.match(md, /Core-claim checks · Challenged/i); assert.match(md, /assumption 1 · Missing assumption/); assert.match(md, /not factual verification/);
  assert.match(core.phaseTwoMarkdown(ok, core.DICT.ko).join('\n'), /핵심 주장 점검/);
  for (const broken of [[cf({ verdict: 'true' })], [cf({ target: { kind: 'evidence', index: 0, quote: '' } })], [cf({ issue: 'vibes' })], Array.from({ length: 7 }, () => cf()), 'x']) {
    const p = core.normalizeProject(projectRaw({ crossReview: REVIEW([{ reviewerExpertId: 'x2', summary: '', findings: [{ targetExpertId: 'x1', evidenceIndex: 0, verdict: 'supported', rationale: 'ok' }], claimFindings: broken }]) }));
    assert.equal(p.crossReview.invalidClaimFindings, true); assert.equal(p.crossReview.reports[0].claimFindings, undefined); assert.equal(p.crossReview.reports[0].findings.length, 1);
  }
  const legacy = core.normalizeProject(projectRaw({ crossReview: REVIEW([{ reviewerExpertId: 'x2', summary: '', findings: [] }]) }));
  assert.equal(legacy.crossReview.invalidClaimFindings, undefined); assert.equal(legacy.crossReview.reports[0].claimFindings, undefined);
  assert.deepEqual(Object.keys(core.DICT.en.p4), Object.keys(core.DICT.ko.p4));
});

await test('author response opens for supported verdicts whose claim support is partial/contradicted/insufficient, and for challenged/insufficient core findings', () => {
  const affected = (reports) => plain(core.authorResponseAffected(core.normalizeProject(projectRaw({ crossReview: REVIEW(reports) }))));
  const sup = (status) => ({ reviewerExpertId: 'x2', summary: '', findings: [{ targetExpertId: 'x1', evidenceIndex: 0, verdict: 'supported', rationale: 'ok', claimSupport: SUPPORT(status) }] });
  assert.deepEqual(affected([sup('supported')]), []);
  for (const s of ['partial', 'contradicted', 'insufficient']) assert.deepEqual(affected([sup(s)]), ['x1'], s);
  assert.deepEqual(affected([{ reviewerExpertId: 'x2', summary: '', findings: [{ targetExpertId: 'x1', evidenceIndex: 0, verdict: 'supported', rationale: 'ok' }] }]), [], 'legacy supported stays closed');
  const core1 = (f) => affected([{ reviewerExpertId: 'x2', summary: '', findings: [], claimFindings: [cf(f)] }]);
  assert.deepEqual(core1({}), ['x1']); assert.deepEqual(core1({ verdict: 'insufficient' }), ['x1']); assert.deepEqual(core1({ verdict: 'supported' }), []);
  assert.deepEqual(core1({ target: { kind: 'nextAction', index: 1, quote: 'na-1' } }), ['x1']);
  assert.deepEqual(core1({ target: { kind: 'nextAction', index: 2, quote: '' } }), [], 'no such next action');
  assert.deepEqual(core1({ target: { kind: 'summary', index: 1, quote: '' } }), [], 'summary has one slot');
  assert.deepEqual(core1({ targetExpertId: 'x2' }), [], 'self-review does not count');
});

console.log(`cloudbite-v5-human-review-ui: ${pass} groups passed (fake DOM; no live provider or browser).`);
