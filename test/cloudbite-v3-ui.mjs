// Cloudbite 콘솔의 제품 v3 화면 (src/cloudbite-page.ts 의 CLOUDBITE_JS) 을 브라우저 없이 고정한다:
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

await test('사전: p3 문구는 EN·KO 가 같은 열쇠를 갖고, 채택·산출물·작성자 응답이 검증이 아니라고 밝힌다', () => {
  assert.deepEqual(Object.keys(KO.p3).sort(), Object.keys(EN.p3).sort());
  for (const k of ['provGroup', 'provStanding', 'provOriginName', 'provRef', 'artReason', 'arDisposition', 'arStatus']) assert.deepEqual(Object.keys(KO.p3[k]).sort(), Object.keys(EN.p3[k]).sort(), k);
  assert.match(EN.p3.provAdoptAsk, /not verification/); assert.match(EN.p3.provAdoptAsk, /memo stays unchanged/);
  assert.match(EN.p3.artNote, /No code was run/); assert.match(KO.p3.artNote, /실행하거나/);
  assert.match(EN.p3.arNote, /not a verification/); assert.match(EN.p3.arAskHelp, /nothing runs or is paid for automatically/);
});

await test('주장 출처 정리: 엄격히 받고 글은 자르지 않으며, 지위는 서버 규칙과 같고 틀린 모양은 통째로 읽지 않는다', () => {
  const long = 'x'.repeat(1000);
  const p = core.normalizeProject(projectRaw({ provenance: { ledger: LEDGER([...BASE_CLAIMS, claim(9, { text: long })]), state: STATE([adoption(BASE_CLAIMS[2]), { ...adoption(BASE_CLAIMS[3]), claimId: cid(77), text: 'gone' }]) } }));
  assert.equal(p.provenance.ledger.claims.length, 5); assert.equal(p.provenance.ledger.claims[4].text, long);
  const v = core.provenanceView(p.provenance);
  assert.equal(v.standing.get(cid(1)), 'user-stated'); assert.equal(v.standing.get(cid(2)), 'generated-proposal'); assert.equal(v.standing.get(cid(3)), 'user-adopted');
  assert.equal(v.active.length, 1); assert.equal(v.stale.length, 1, 'adoption of a claim no longer in the ledger is stale');
  const g = core.provenanceGroups(p.provenance);
  assert.deepEqual(plain(g.hinted.map(c => c.id)), [cid(2)]); assert.deepEqual(plain(g.adopted.map(c => c.id)), [cid(3)]); assert.deepEqual(plain(g.stated.map(c => c.id)), [cid(1)]);
  assert.match(core.provenanceLines(p.provenance, EN).join('\n'), /1 user statements · 3 generated proposals \(1 with numbers or thresholds\) · 1 adopted by a user/);
  const bad = (prov) => core.normalizeProject(projectRaw({ provenance: prov }));
  for (const prov of [
    { ledger: { ...LEDGER(BASE_CLAIMS), projectId: PARENT }, state: STATE() },
    { ledger: { ...LEDGER(BASE_CLAIMS), coverage: { ...COVER, factsVerified: true } }, state: STATE() },
    { ledger: LEDGER([...BASE_CLAIMS, claim(1)]), state: STATE() },
    { ledger: LEDGER([claim(5, { id: 'claim-5' })]), state: STATE() },
    { ledger: LEDGER([claim(5, { text: 'y'.repeat(1001) })]), state: STATE() },
    { ledger: LEDGER([claim(5, { origin: 'parent-adoption' })]), state: STATE() },
    { ledger: LEDGER(BASE_CLAIMS), state: STATE([{ ...adoption(BASE_CLAIMS[2]), meaning: 'verified' }]) },
    { ledger: LEDGER(BASE_CLAIMS), state: { ...STATE(), projectId: PARENT } },
  ]) { const q = bad(prov); assert.equal(q.provenance, undefined); assert.equal(q.invalidProvenance, true); }
  assert.equal(core.normalizeProject(projectRaw({ provenance: undefined })).invalidProvenance, undefined, 'absent is not invalid');
});

await test('산출물 범위: 파일·해시·줄 범위·잘림·빠진 이유를 지키고 보고서에 실행·검증 없음과 함께 적는다. 틀리면 그 필드만 읽을 수 없다고 밝힌다', () => {
  const p = core.normalizeProject(projectRaw());
  assert.deepEqual(plain(p.crossReview.artifactCoverage), REVIEW.artifactCoverage);
  const md = core.markdownReport(p, false, EN);
  assert.match(md, /Artifact text the reviewers read \(1 role, 1 file\)/); assert.match(md, /No code was run, no data was parsed and nothing was independently verified/);
  assert.match(md, /out\/report\.md · lines 1–40 of 120 · sha256 bbbbbbbbbbbb… · excerpt cut at the reading limit/);
  assert.match(md, /out\/result\.json: not read \(duplicate of the opinion\)/);
  const broken = core.normalizeProject(projectRaw({ crossReview: { ...REVIEW, artifactCoverage: [{ ...REVIEW.artifactCoverage[0], files: [{ path: 'a', sha256: 'zz', startLine: 1, endLine: 1, totalLines: 1, excerptTruncated: false, storedTruncated: false }] }] } }));
  assert.equal(broken.crossReview.status, 'completed', 'verdicts stay'); assert.equal(broken.crossReview.artifactCoverage, undefined); assert.equal(broken.crossReview.invalidArtifactCoverage, true);
  assert.match(core.markdownReport(broken, false, KO), /산출물 범위를 이 화면이 읽을 수 없어/);
});

// 작성자 응답 계획 (서버 buildAuthorResponsePlan 의 모양)
const F1 = 'arf_' + '1'.repeat(32), F2 = 'arf_' + '2'.repeat(32), F3 = 'arf_' + '3'.repeat(32);
const PLAN = {
  version: 'cloudbite-author-response/v1', kind: 'author-response-follow-up', trust: 'untrusted-data', parentId: PARENT, parentStatus: 'completed',
  crossReview: { snapshotHash: HASH, completedAt: 20, reviewers: ['x2', 'x1'], findings: 4, supported: 1, eligible: 3 }, responseLanguage: 'en',
  execution: { kind: 'new-child-project', automaticCalls: 0, budget: 'child-normal', parentMutation: 'none', parentMemo: 'unchanged', childMemo: 'own-optional' },
  roles: ['x1', 'x3'],
  authors: [{ expertId: 'x1', name: 'Expert 1', opinionSha256: SHA('c'), original: { direction: 'support', confidence: 70, summary: 'original x1', evidenceCount: 2 }, findingIds: [F1, F2] },
    { expertId: 'x3', name: 'Expert 3', opinionSha256: SHA('d'), original: { direction: 'concern', confidence: 40, summary: 'original x3', evidenceCount: 1 }, findingIds: [F3] }],
  findings: [{ findingId: F1, reviewerExpertId: 'x2', targetExpertId: 'x1', evidenceIndex: 0, verdict: 'challenged', reviewerRationale: 'Too strong', evidenceText: 'ev-0' },
    { findingId: F2, reviewerExpertId: 'x2', targetExpertId: 'x1', evidenceIndex: 1, verdict: 'insufficient', reviewerRationale: 'Thin', evidenceText: 'ev-1' },
    { findingId: F3, reviewerExpertId: 'x1', targetExpertId: 'x3', evidenceIndex: 0, verdict: 'insufficient', reviewerRationale: 'Thin too', evidenceText: 'ev-0' }],
  capped: { limit: 9, eligibleSelected: 3, included: 3, omittedFindingIds: [] }, unselectedAuthors: [], excluded: [{ reportIndex: 2, findingIndex: 0, reviewerExpertId: 'x3', targetExpertId: 'x3', reason: 'self-target' }],
  omissions: [], disclosure: 'Plan disclosure.', planSha256: SHA('e'),
};
const ROUND = {
  version: 'project-round/v1', parentId: PARENT, changeSummary: 'Answer the review', newRoles: ['x1', 'x3'],
  comparison: { stage: { previous: 'unspecified', current: 'unspecified', changed: false }, responseLanguage: { previous: 'en', current: 'en', changed: false },
    options: { previous: [], current: [], exactTextMatches: [] }, constraints: { added: [], removed: [], unchanged: 0 }, successCriteria: { added: [], removed: [], unchanged: 0 },
    unknowns: { added: [], removed: [], unchanged: 0 }, documents: { added: [], removed: [], changed: [], unchanged: [], current: [] }, roles: { added: [], removed: ['x2'], kept: ['x1', 'x3'] }, semanticImpact: 'not-analyzed' },
  reference: { label: 'previous-round-reference', trust: 'untrusted-data', parentId: PARENT, parentStatus: 'completed', opinions: [], excluded: [], omissions: [], bytes: 10 },
  authorResponse: PLAN,
};
const parsedResponse = (expertId, responses, expected) => ({ expertId, responses, coverage: { expected, answered: responses.length,
  missing: [], status: responses.length === expected ? 'complete' : responses.length ? 'partial' : 'none' }, language: { language: 'en', status: 'consistent' } });
const childRaw = (x1Response, x3Response) => projectRaw({ id: ID, provenance: undefined, crossReview: undefined, brief: brief({ expertIds: ['x1', 'x3'], revision: { parentId: PARENT, changeSummary: 'Answer the review', reviewSnapshotHash: HASH } }),
  experts: [run(1, x1Response === undefined ? {} : { authorResponse: x1Response }), run(3, x3Response === undefined ? {} : { authorResponse: x3Response })], previousRound: ROUND });

await test('작성자 응답: 계획·응답을 엄격히 받고, 지적마다 수정·철회·유지와 없음·거부를 의견 상태와 따로 보고서에 적는다', () => {
  const p = core.normalizeProject(childRaw(parsedResponse('x1', [{ findingId: F1, disposition: 'withdraw', rationale: 'Agreed, too strong' }], 2), { invalid: 'author response has an unknown key' }));
  assert.equal(p.brief.revision.reviewSnapshotHash, HASH, 'revision hash survives normalization');
  assert.deepEqual(plain(p.previousRound.authorResponse), PLAN);
  assert.equal(p.experts[0].authorResponse.coverage.status, 'partial'); assert.deepEqual(plain(p.experts[1].authorResponse), { invalid: 'author response has an unknown key' });
  assert.equal(p.experts[0].opinion.summary, 'summary 1', 'the child opinion is separate and unchanged');
  const md = core.markdownReport(p, false, EN);
  assert.match(md, /## Author response/); assert.match(md, /Original opinion \(earlier project, unchanged\): Support · self-assessed confidence 70%/);
  assert.match(md, /Some findings answered · 1 of 2 answered \(This is separate/);
  assert.match(md, /x2 · Challenged · Expert 1, evidence 1 → Withdraw — Agreed, too strong/);
  assert.match(md, /x2 · Insufficient · Expert 1, evidence 2 → No response to this finding/);
  assert.match(md, /Response rejected by the server: author response has an unknown key/);
  // 아직 응답이 없는 역할, 읽을 수 없는 응답, 읽을 수 없는 계획
  const pending = core.normalizeProject(childRaw(undefined, { responses: 'nope' }));
  assert.equal(pending.experts[1].invalidAuthorResponse, true); assert.equal(pending.experts[1].authorResponse, undefined);
  const mdp = core.markdownReport(pending, false, EN);
  assert.match(mdp, /No response yet \(the role has not completed\)/); assert.match(mdp, /The server sent a response this console cannot read/);
  for (const bad of [{ ...PLAN, execution: { ...PLAN.execution, automaticCalls: 1 } }, { ...PLAN, parentId: ID }, { ...PLAN, findings: [{ ...PLAN.findings[0], findingId: 'arf_x' }] },
    { ...PLAN, authors: [PLAN.authors[1]] }]) {
    const q = core.normalizeProject({ ...childRaw(), previousRound: { ...ROUND, authorResponse: bad } });
    assert.ok(q.previousRound, 'the round itself stays'); assert.equal(q.previousRound.authorResponse, undefined); assert.equal(q.invalidAuthorPlan, true);
  }
  for (const bad of [{ ...parsedResponse('x1', [], 2), expertId: 'x3' }, parsedResponse('x1', [{ findingId: F1, disposition: 'agree', rationale: 'r' }], 2),
    { ...parsedResponse('x1', [{ findingId: F1, disposition: 'revise', rationale: 'r' }], 2), coverage: { expected: 2, answered: 2, missing: [], status: 'complete' } }])
    assert.equal(core.normalizeAuthorResponse(bad, 'x1'), null);
});

await test('해당 작성자: 반박·부족이고 검토자·대상이 서로 다른 완료 작성자이며 근거 칸이 있는 것만 (자기 지적·없는 칸·지지는 아님)', () => {
  const p = core.normalizeProject(projectRaw());
  assert.deepEqual(plain(core.authorResponseAffected(p)), ['x1', 'x3']);
  assert.equal(core.authorResponseEligible(p), true);
  assert.equal(core.authorResponseEligible(core.normalizeProject(projectRaw({ crossReview: { ...REVIEW, status: 'running' } }))), false);
  assert.equal(core.authorResponseEligible(core.normalizeProject(projectRaw({ brief: brief({ mode: 'demo' }) }))), false);
  assert.equal(core.authorResponseEligible(core.normalizeProject(projectRaw({ experts: [run(1), run(2), run(3, { status: 'failed', opinion: undefined })] }))), true, 'x1 still affected');
});

// ───────── 가짜 DOM (test/cloudbite-decision-ui.mjs 와 같은 모양)
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
const detailOf = (project) => ({ project, model: 'test', roles: [], feedback: [], expiresAt: ROW.expiresAt, canFeedback: false });
/** 사용 기록 서버: 목록, 상세 GET, 채택 POST (adoptImpl). 상세는 그때의 project() 를 돌려준다 */
function historyServer(project, adoptImpl) {
  return (url, init) => {
    if (url.startsWith('/api/cloudbite/history?')) return json(200, { rows: [ROW], next: null, owner: false, retentionDays: 30 });
    if (url === `/api/cloudbite/history/${ID}/adopt`) return adoptImpl(init);
    if (url === `/api/cloudbite/history/${ID}`) return json(200, detailOf(project()));
    return json(404, { error: 'not found' });
  };
}
const openDetail = async (env) => { await env.flush(); env.fk('hist-record:' + ID).click(); await env.flush(); };
const openGroup = async (env, k) => { const box = env.all().find(n => n.tagName === 'DETAILS' && n.className.includes(`cb-prov-group is-${k}`)); box.open = true; box.dispatch('toggle'); await env.flush(); };
const posts = (env) => env.requests.filter(r => r.init.method === 'POST');

await test('사용 기록 상세: 주장 출처는 묶음이 접혀 있고 펼칠 때만 50개씩 그리며, 숫자 제안을 제안으로 강조한다', async () => {
  const many = Array.from({ length: 120 }, (_, i) => claim(100 + i, { text: `Reach ${i}% retention`, numericThresholdHint: true }));
  const project = projectRaw({ provenance: { ledger: LEDGER([...BASE_CLAIMS, ...many]), state: STATE() } });
  const env = fakeEnv(historyServer(() => project, () => json(500, {})));
  await openDetail(env);
  const text = env.detail().textContent;
  assert.match(text, /Claim provenance/); assert.match(text, /Generated proposals with numbers or thresholds \(121\)/); assert.match(text, /Your own statements \(1\)/);
  assert.equal(env.all().filter(n => n.className.startsWith('cb-prov-claim')).length, 0, 'nothing rendered while collapsed');
  await openGroup(env, 'hinted');
  const items = () => env.all().filter(n => n.className.startsWith('cb-prov-claim '));
  assert.equal(items().length, 50);
  assert.ok(items().every(n => n.className.includes('is-hint')));
  assert.match(items()[0].textContent, /Generated proposal.*Contains a number or threshold — a proposal, not a requirement.*Task completion should be at least 80%/);
  env.fk('prov-more:hinted').click(); await env.flush();
  assert.equal(items().length, 100);
  env.fk('prov-more:hinted').click(); await env.flush();
  assert.equal(items().length, 121); assert.equal(env.fk('prov-more:hinted'), undefined);
  assert.equal(posts(env).length, 0);
});

await test('채택: 정확한 글을 먼저 보이고 확인을 눌러야 {claimId,text,snapshot} 만 보내며, 돌려받은 상세로 지위가 바뀐다 (메모는 그대로)', async () => {
  let current = projectRaw({ memo: { version: 'cloudbite-memo/v1', status: 'idle', attempts: 0, execution: 'none' } });
  const env = fakeEnv(historyServer(() => current, (init) => {
    const b = JSON.parse(init.body);
    current = projectRaw({ memo: current.memo, provenance: { ledger: LEDGER(BASE_CLAIMS), state: STATE([adoption(BASE_CLAIMS.find(c => c.id === b.claimId))]) } });
    return json(200, detailOf(current));
  }));
  await openDetail(env); await openGroup(env, 'hinted');
  assert.ok(!env.fk(`adopt:${cid(1)}`), 'user statements cannot be adopted');
  env.fk(`adopt:${cid(2)}`).click(); await env.flush();
  assert.equal(posts(env).length, 0, 'the first click only shows the exact text');
  const confirm = env.all().find(n => n.className === 'cb-prov-confirm');
  assert.equal(confirm.children[0].textContent, 'Task completion should be at least 80%'); assert.match(confirm.textContent, /not verification/);
  env.fk(`adopt-yes:${cid(2)}`).click(); await env.flush();
  const [post] = posts(env);
  assert.equal(post.url, `/api/cloudbite/history/${ID}/adopt`);
  assert.deepEqual(JSON.parse(post.init.body), { claimId: cid(2), text: 'Task completion should be at least 80%', snapshot: 'ps-' + '1'.repeat(16) });
  assert.equal(post.init.headers['content-type'], 'application/json'); assert.equal(post.init.credentials, 'same-origin');
  const text = env.detail().textContent;
  assert.match(text, /Adopted\. The saved project was read again\./); assert.match(text, /Adopted by a user \(1\)/); assert.doesNotMatch(text, /Generated proposals with numbers or thresholds/);
  assert.equal(posts(env).length, 1);
  // 잘린 주장은 채택 버튼이 없다
  await openGroup(env, 'proposals');
  assert.ok(env.fk(`adopt:${cid(3)}`)); assert.ok(!env.fk(`adopt:${cid(4)}`)); assert.match(env.detail().textContent, /cannot be adopted/);
});

await test('채택 실패·미확인: 다시 보내기 전에 저장된 상태를 GET 으로 읽고, 다른 사람 것·오래된 장부는 서버 이유를 그대로 보인다', async () => {
  // 409 오래된 장부 → GET 으로 새 장부를 받는다. 다시 누를 때만 다시 보낸다
  let current = projectRaw();
  const env = fakeEnv(historyServer(() => current, () => {
    current = projectRaw({ provenance: { ledger: LEDGER(BASE_CLAIMS, 'ps-' + '2'.repeat(16)), state: STATE() } });
    return json(409, { error: 'adoption is stale: the claim ledger changed' });
  }));
  await openDetail(env); await openGroup(env, 'hinted');
  env.fk(`adopt:${cid(2)}`).click(); await env.flush(); env.fk(`adopt-yes:${cid(2)}`).click(); await env.flush();
  const after = env.requests.slice(env.requests.findIndex(r => r.init.method === 'POST'));
  assert.deepEqual(after.map(r => `${r.init.method} ${r.url}`), [`POST /api/cloudbite/history/${ID}/adopt`, `GET /api/cloudbite/history/${ID}`]);
  assert.match(env.detail().textContent, /Not adopted: adoption is stale: the claim ledger changed/);
  env.fk(`adopt:${cid(2)}`).click(); await env.flush(); env.fk(`adopt-yes:${cid(2)}`).click(); await env.flush();
  assert.equal(JSON.parse(posts(env)[1].init.body).snapshot, 'ps-' + '2'.repeat(16), 'the retry uses the re-read snapshot');

  // 응답을 모름 (네트워크) → GET 결과 이미 채택되어 있으면 그렇다고 보이고 다시 보내지 않는다
  let saved = projectRaw();
  const env2 = fakeEnv(historyServer(() => saved, () => { saved = projectRaw({ provenance: { ledger: LEDGER(BASE_CLAIMS), state: STATE([adoption(BASE_CLAIMS[1])]) } }); return Promise.reject(new Error('net')); }));
  await openDetail(env2); await openGroup(env2, 'hinted');
  env2.fk(`adopt:${cid(2)}`).click(); await env2.flush(); env2.fk(`adopt-yes:${cid(2)}`).click(); await env2.flush();
  assert.match(env2.detail().textContent, /The saved project already shows this adoption\./); assert.equal(posts(env2).length, 1);

  // 404 (다른 사람 것·지워짐)
  const env3 = fakeEnv(historyServer(() => projectRaw(), () => json(404, { error: 'project not found' })));
  await openDetail(env3); await openGroup(env3, 'hinted');
  env3.fk(`adopt:${cid(2)}`).click(); await env3.flush(); env3.fk(`adopt-yes:${cid(2)}`).click(); await env3.flush();
  assert.match(env3.detail().textContent, /Not adopted: This project was not found or is not yours\./);
});

await test('채택 버튼은 진행 중인 검토·메모가 있으면 없고, 읽을 수 없는 출처는 채택 없이 그렇다고만 밝힌다 (KO 전환)', async () => {
  const env = fakeEnv(historyServer(() => projectRaw({ memo: { version: 'cloudbite-memo/v1', status: 'running', attempts: 1, execution: 'server-nosana' } }), () => json(500, {})));
  await openDetail(env); await openGroup(env, 'hinted');
  assert.ok(!env.fk(`adopt:${cid(2)}`)); assert.match(env.detail().textContent, /no review or memo is running/);
  const env2 = fakeEnv(historyServer(() => projectRaw({ provenance: { ledger: { ...LEDGER(BASE_CLAIMS), version: 'v0' }, state: STATE() } }), () => json(500, {})));
  await openDetail(env2);
  assert.match(env2.detail().textContent, /claim provenance this console cannot read/);
  env2.fk('lang:ko').click(); await env2.flush();
  assert.match(env2.detail().textContent, /주장 출처를 이 화면이 읽을 수 없어/);
});

await test('작성자에게 응답 요청: 해당 작성자만 미리 고르고, 해당하지 않는 역할은 막으며, reviewSnapshotHash 가 고정 본문으로 미리보기·만들기에 그대로 간다', async () => {
  const env = fakeEnv((url, init) => {
    if (url.startsWith('/api/cloudbite/history?')) return json(200, { rows: [ROW], next: null, owner: false, retentionDays: 30 });
    if (url === `/api/cloudbite/history/${ID}`) return json(200, detailOf(projectRaw()));
    if (url === '/api/cloudbite/projects' && init.method === 'POST') return json(201, { project: { ...childRaw(), status: 'running' }, accessToken: 'tok' });
    return json(404, {});
  });
  await openDetail(env);
  assert.match(env.detail().textContent, /Artifact text the reviewers read \(1 role, 1 file\)/);
  env.fk('ar-ask').click(); await env.flush();
  const box = env.all().find(n => n.className === 'cb-followup');
  assert.equal(box.hidden, false);
  assert.match(box.textContent, /Author response round\. Only these affected authors can be selected: Expert 1, Expert 3\./);
  assert.deepEqual(['x1', 'x2', 'x3'].map(id => env.fk(`x:${id}`).checked), [true, false, true], 'only affected authors are preselected');
  assert.equal(env.fk('x:x2').disabled, true, 'unaffected roles cannot be selected in the author-response draft');
  const tok = env.byId('cb-token'); tok.value = 'adm-secret-123'; tok.dispatch('input'); await env.flush();
  const sum = env.fk('fu-summary'); sum.value = 'Please answer the findings'; sum.dispatch('input'); await env.flush();
  // 해당하지 않는 역할을 더하면 계획을 준비하지 않는다
  const x2 = env.fk('x:x2'); x2.checked = true; x2.dispatch('change'); await env.flush();
  env.fk('start').click(); await env.flush();
  assert.equal(env.previews.length, 0); assert.match(env.root.textContent, /select only affected authors/);
  x2.checked = false; x2.dispatch('change'); await env.flush();
  const x3 = env.fk('x:x3'); x3.checked = false; x3.dispatch('change'); await env.flush(); // 직접 고른 일부
  env.fk('start').click(); await env.flush();
  assert.equal(env.previews.length, 1);
  const body = JSON.parse(env.previews[0].init.body);
  assert.deepEqual(plain(body.expertIds), ['x1']);
  assert.deepEqual(body.revision, { parentId: ID, changeSummary: 'Please answer the findings', reviewSnapshotHash: HASH });
  assert.equal(body.routing, undefined); assert.equal(env.requests.filter(r => r.url === '/api/cloudbite/projects').length, 0, 'nothing runs before confirmation');
  env.fk('start').click(); await env.flush();
  const create = env.requests.find(r => r.url === '/api/cloudbite/projects' && r.init.method === 'POST');
  assert.equal(create.init.body, env.previews[0].init.body, 'the frozen preview body is sent unchanged');
});

await test('보통 후속 라운드는 그대로: reviewSnapshotHash 를 보내지 않고 이전 팀을 미리 고른다', async () => {
  const env = fakeEnv((url) => {
    if (url.startsWith('/api/cloudbite/history?')) return json(200, { rows: [ROW], next: null, owner: false, retentionDays: 30 });
    if (url === `/api/cloudbite/history/${ID}`) return json(200, detailOf(projectRaw()));
    return json(404, {});
  });
  await openDetail(env);
  env.fk('hist-followup').click(); await env.flush();
  assert.deepEqual(['x1', 'x2', 'x3'].map(id => env.fk(`x:${id}`).checked), [true, true, true]);
  assert.equal(env.all().find(n => n.className === 'cb-help cb-fu-author').hidden, true);
  const tok = env.byId('cb-token'); tok.value = 'adm-secret-123'; tok.dispatch('input'); await env.flush();
  const sum = env.fk('fu-summary'); sum.value = 'Changed scope'; sum.dispatch('input'); await env.flush();
  env.fk('start').click(); await env.flush();
  assert.deepEqual(JSON.parse(env.previews[0].init.body).revision, { parentId: ID, changeSummary: 'Changed scope' });
});

await test('후속 프로젝트 화면: 작성자 응답 계획과 응답을 그리고 (수정·철회·유지·없음·거부), 원래 의견과 새 의견은 따로 남는다', async () => {
  const child = { ...childRaw(parsedResponse('x1', [{ findingId: F1, disposition: 'maintain', rationale: 'Still holds' }, { findingId: F2, disposition: 'revise', rationale: 'Will add data' }], 2),
    { invalid: 'author response language mismatch' }), id: 'cb' + 'c'.repeat(32) };
  const row = { ...ROW, id: child.id };
  const env = fakeEnv((url) => {
    if (url.startsWith('/api/cloudbite/history?')) return json(200, { rows: [row], next: null, owner: false, retentionDays: 30 });
    if (url === `/api/cloudbite/history/${child.id}`) return json(200, detailOf(child));
    return json(404, {});
  });
  await env.flush(); env.fk('hist-record:' + child.id).click(); await env.flush();
  const text = env.detail().textContent;
  assert.match(text, /Author response/); assert.match(text, /Original opinion \(earlier project, unchanged\)/); assert.match(text, /original x1/);
  assert.match(text, /All findings answered/); assert.match(text, /MaintainStill holds|Maintain Still holds/); assert.match(text, /Revise Will add data/);
  assert.match(text, /Response rejected by the server: author response language mismatch/);
  assert.match(text, /summary 1/, 'the child opinion is shown on its own');
});

console.log(`cloudbite-v3-ui: ${pass} passed`);
