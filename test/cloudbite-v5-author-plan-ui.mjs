// Cloudbite 콘솔이 v5 작성자 응답 계획(src/cloudbite-author-response.ts 가 실제로 만든 것)을 읽고 그린다:
// '지지' 판정 + 지지가 아닌 인용문 대조 지적, 핵심 주장(요약·가정·다음 행동) 지적, v1 계획을 그대로 정리·화면·보고서(EN/KO)에 남기고,
// 지어낸·남의·낡은 지적은 계획 전체를 읽지 않는다. 핵심 주장 판정 상한(보고서마다 3, 근거와 합쳐 6)과 작성자 응답 대상 조건(정확한 인용)도 고정한다.
// 가짜 DOM 이다. 실제 브라우저·서버·공급자 증거가 아니다.
//   node tools/build-cloudbite-console.mjs && node test/cloudbite-v5-author-plan-ui.mjs
import assert from 'node:assert/strict';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { CLOUDBITE_JS } from '../src/cloudbite-page.ts';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = await build({ stdin: { contents: "export * from './cloudbite-author-response';", resolveDir: path.join(repo, 'src'), loader: 'ts' },
  bundle: true, write: false, format: 'esm', platform: 'neutral' });
const S = await import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'));

let pass = 0;
const test = async (name, fn) => { await fn(); pass++; console.log(`  ok   ${name}`); };
const plain = (v) => JSON.parse(JSON.stringify(v));
let core = null;
vm.runInContext(CLOUDBITE_JS, vm.createContext({ __cloudbiteTestHook: (c) => { core = c; }, crypto: globalThis.crypto }));
assert.ok(core);
const EN = core.DICT.en, KO = core.DICT.ko;

// ───────── 서버 모듈로 만든 실제 계획
const PARENT = 'cb' + 'a'.repeat(32), CHILD = 'cb' + 'c'.repeat(32), ME = 'v_' + '1'.repeat(64), SNAP = 'c'.repeat(64), PKT = 'e'.repeat(64), SRC = 'f'.repeat(64), NOW = 1_800_000_000_000;
const opinion = (id) => ({ direction: 'support', confidence: 70, summary: `Original view of ${id}: the pilot halves onboarding time.`,
  evidence: ['ev0 ' + id, 'ev1 ' + id, 'ev2 ' + id], assumptions: ['Vendor keeps the price for 12 months'], nextActions: ['Ask for the SLA draft'] });
const run = (expertId, extra = {}) => ({ id: 'r-' + expertId, expertId, name: 'Role ' + expertId, status: 'completed', updatedAt: 1, activity: [], artifacts: [], opinion: opinion(expertId), ...extra });
const Q = (quote) => ({ passageId: 'p1', ref: 'doc:doc-1', textOrigin: 'user-document', quote, sourceSha256: SRC, startOffset: 10, endOffset: 10 + quote.length, startLine: 2, endLine: 2 });
const CS = (status, quotes = status === 'insufficient' ? [] : [Q('Total: 42k for year one')], over = {}) => ({ status, quotes, rationale: `Source reading ${status}.`,
  basis: 'model-assessment', quoteCheck: 'exact-substring', citedText: 'available', packetSha256: PKT, ...over });
const F = (targetExpertId, evidenceIndex, verdict, claimSupport) => ({ targetExpertId, evidenceIndex, verdict, rationale: `Rationale on ${targetExpertId}#${evidenceIndex}`, ...(claimSupport ? { claimSupport } : {}) });
const C = (targetExpertId, kind, index, quote, verdict = 'challenged', issue = 'causal-overreach') => ({ targetExpertId, target: { kind, index, quote }, verdict, issue, rationale: `Core reading of ${targetExpertId} ${kind}#${index}` });
const V5_REPORTS = () => [
  { reviewerExpertId: 'role-a', summary: 's', findings: [F('role-b', 1, 'supported', CS('insufficient', [], { citedText: 'uncited' })), F('role-b', 2, 'challenged', CS('supported'))],
    claimFindings: [C('role-b', 'assumption', 0, 'Vendor keeps the price')] },
  { reviewerExpertId: 'role-b', summary: 's', findings: [F('role-a', 0, 'insufficient')], claimFindings: [C('role-a', 'summary', 0, 'the pilot halves onboarding time', 'insufficient', 'unsupported-premise')] },
];
const LEGACY_REPORTS = () => [{ reviewerExpertId: 'role-a', summary: 's', findings: [F('role-b', 0, 'challenged'), F('role-c', 1, 'supported')] },
  { reviewerExpertId: 'role-b', summary: 's', findings: [F('role-a', 0, 'insufficient')] }];
const parent = (reports) => ({ id: PARENT, status: 'completed', createdAt: 10, updatedAt: 20,
  brief: { title: 'Pick a pilot', objective: 'Choose a pilot plan.', context: 'ctx', expertIds: ['role-a', 'role-b', 'role-c'], mode: 'live', requestId: 'req-1' },
  experts: [run('role-a'), run('role-b'), run('role-c')], crossReview: { status: 'completed', snapshotHash: SNAP, startedAt: 30, completedAt: 40, reports, execution: 'server-nosana' } });
const serverPlan = async (reports, roles) => {
  const auth = await S.authorizeAuthorResponseParent({ parentId: PARENT, actor: ME, owner: false, now: NOW,
    read: { project: parent(reports), model: 'm', roles: [], feedback: [], reports: {}, expiresAt: NOW + 1000, canFeedback: true } });
  assert.ok(!('error' in auth), 'server authorizes the fixture parent');
  const plan = await S.buildAuthorResponsePlan(auth, { title: 'Answer', objective: 'Respond to cross-review findings.', context: '', expertIds: roles, mode: 'live', requestId: 'req-2',
    revision: { parentId: PARENT, changeSummary: 'Answer findings.', reviewSnapshotHash: SNAP } });
  assert.ok(!('error' in plan), JSON.stringify(plan.error));
  return plain(plan);
};
const V5 = await serverPlan(V5_REPORTS(), ['role-a', 'role-b']);
const LEGACY = await serverPlan(LEGACY_REPORTS(), ['role-a', 'role-b']);
const gapOf = (p) => p.findings.find(f => f.verdict === 'supported');
const coreOf = (p, kind) => p.findings.find(f => f.kind === 'core-claim' && f.target.kind === kind);

const ROUND = (plan) => ({
  version: 'project-round/v1', parentId: PARENT, changeSummary: 'Answer findings.', newRoles: ['role-a', 'role-b'],
  comparison: { stage: { previous: 'unspecified', current: 'unspecified', changed: false }, responseLanguage: { previous: 'en', current: 'en', changed: false },
    options: { previous: [], current: [], exactTextMatches: [] }, constraints: { added: [], removed: [], unchanged: 0 }, successCriteria: { added: [], removed: [], unchanged: 0 },
    unknowns: { added: [], removed: [], unchanged: 0 }, documents: { added: [], removed: [], changed: [], unchanged: [], current: [] }, roles: { added: [], removed: ['role-c'], kept: ['role-a', 'role-b'] }, semanticImpact: 'not-analyzed' },
  reference: { label: 'previous-round-reference', trust: 'untrusted-data', parentId: PARENT, parentStatus: 'completed', opinions: [], excluded: [], omissions: [], bytes: 10 },
  authorResponse: plan,
});
const childRaw = (plan, responses = {}) => ({ id: CHILD, status: 'completed', createdAt: Date.now(), updatedAt: 5,
  brief: { title: 'Answer', objective: 'O', context: '', expertIds: ['role-a', 'role-b'], mode: 'live', requestId: 'r', revision: { parentId: PARENT, changeSummary: 'Answer findings.', reviewSnapshotHash: SNAP } },
  experts: ['role-a', 'role-b'].map(id => run(id, responses[id] ? { authorResponse: responses[id] } : {})), previousRound: ROUND(plan) });
const answered = (plan, expertId, disposition) => {
  const ids = plan.authors.find(a => a.expertId === expertId).findingIds;
  return { expertId, responses: ids.map(findingId => ({ findingId, disposition, rationale: `Answer ${findingId.slice(4, 10)}` })),
    coverage: { expected: ids.length, answered: ids.length, missing: [], status: 'complete' }, language: { language: 'en', status: 'consistent' } };
};

await test('서버 계획 그대로: 지지+인용문 공백·핵심 주장·v1 계획을 정리해도 값이 하나도 빠지거나 바뀌지 않는다', () => {
  assert.ok(gapOf(V5) && coreOf(V5, 'summary') && coreOf(V5, 'assumption') && V5.crossReview.sourceAssessments && V5.crossReview.coreClaims, 'fixture really is v5');
  assert.deepEqual(plain(core.normalizeAuthorPlan(V5, PARENT)), V5);
  assert.deepEqual(plain(core.normalizeAuthorPlan(LEGACY, PARENT)), LEGACY);
  const g = core.normalizeAuthorPlan(V5, PARENT).findings.find(f => f.verdict === 'supported');
  assert.equal(g.sourceAssessment.status, 'insufficient', 'the ordinary supported verdict is kept beside the source reading');
  assert.equal(g.eligibleBy, 'source-assessment'); assert.equal(g.sourceConflict, true);
  assert.equal(core.normalizeAuthorPlan(V5, 'cb' + 'd'.repeat(32)), null, 'another parent is not this plan');
});

await test('지어낸·남의·낡은 지적은 계획 전체를 읽을 수 없다 (글·번호를 지어내지 않는다)', () => {
  const bad = (mut) => { const p = structuredClone(V5); mut(p); return core.normalizeAuthorPlan(p, PARENT); };
  const gi = V5.findings.indexOf(gapOf(V5)), si = V5.findings.indexOf(coreOf(V5, 'summary')), ai = V5.findings.indexOf(coreOf(V5, 'assumption'));
  const cases = {
    'supported without a source reading': p => { delete p.findings[gi].sourceAssessment; delete p.findings[gi].eligibleBy; delete p.findings[gi].sourceConflict; },
    'supported beside a supported reading': p => { p.findings[gi].sourceAssessment = CS('supported'); p.findings[gi].sourceConflict = false; },
    'fabricated eligibleBy': p => { p.findings[gi].eligibleBy = 'verdict'; },
    'fabricated conflict flag': p => { p.findings[gi].sourceConflict = false; },
    'malformed source reading': p => { p.findings[gi].sourceAssessment.status = 'verified'; },
    'summary index other than 0': p => { p.findings[si].target.index = 1; },
    'core without textSha256': p => { delete p.findings[ai].target.textSha256; },
    'core with unknown slot': p => { p.findings[ai].target.kind = 'evidence'; },
    'core with supported verdict': p => { p.findings[ai].verdict = 'supported'; },
    'core with empty quote': p => { p.findings[ai].target.quote = '  '; },
    'unknown finding kind': p => { p.findings[ai].kind = 'opinion'; },
    'foreign target': p => { p.findings[gi].targetExpertId = 'role-z'; },
    'stale evidence index': p => { p.findings[gi].evidenceIndex = 3; },
    'self target': p => { p.findings[ai].reviewerExpertId = p.findings[ai].targetExpertId; },
    'malformed v5 counts': p => { p.crossReview.coreClaims.eligible = 'two'; },
  };
  for (const [why, mut] of Object.entries(cases)) assert.equal(bad(mut), null, why);
  const p = core.normalizeProject(childRaw(Object.assign(structuredClone(V5), { findings: V5.findings.map((f, i) => i === si ? { ...f, target: { ...f.target, index: 2 } } : f) })));
  assert.equal(p.invalidAuthorPlan, true); assert.ok(p.previousRound, 'the round itself stays readable');
  const md = core.markdownReport(p, false, EN);
  assert.match(md, /author-response plan this console cannot read/); assert.doesNotMatch(md, /undefined|NaN/);
});

await test('보고서(EN/KO): 원래 판정·인용문 대조 상태·충돌·인용, 핵심 주장 칸·인용·문제 종류·원래 글, 응답을 모두 적는다', () => {
  const p = core.normalizeProject(childRaw(V5, { 'role-b': answered(V5, 'role-b', 'maintain') }));
  assert.equal(p.invalidAuthorPlan, undefined); assert.deepEqual(plain(p.previousRound.authorResponse), V5);
  for (const [M, lang] of [[EN, 'en'], [KO, 'ko']]) {
    const md = core.markdownReport(p, false, M);
    assert.doesNotMatch(md, /undefined|NaN|\[object/, lang);
    assert.ok(md.includes(M.p3.arTitle) && md.includes(M.p3.arSourceNote) && md.includes(M.p3.arConflict), `${lang}: source notes`);
    assert.ok(md.includes(M.p3.arSource(M.p4.supportStatus.insufficient, 'uncited')) && md.includes(M.p3.arEligibleBy['source-assessment']), `${lang}: gap reading`);
    assert.ok(md.includes(M.p3.arFinding('role-a', M.verdict.supported, 'Role role-b', 2)), `${lang}: ordinary supported verdict kept: ${md}`);
    assert.ok(md.includes(M.p3.arCoreFinding('role-a', M.verdict.challenged, 'Role role-b', `${M.p4.coreTarget.assumption} 1 · ${M.p4.coreIssue['causal-overreach']}`)), `${lang}: core head`);
    assert.ok(md.includes(M.p3.arCoreFinding('role-b', M.verdict.insufficient, 'Role role-a', `${M.p4.coreTarget.summary} · ${M.p4.coreIssue['unsupported-premise']}`)), `${lang}: summary head`);
    assert.ok(md.includes('“Vendor keeps the price”') && md.includes('Vendor keeps the price for 12 months') && md.includes('Total: 42k for year one'), `${lang}: quotes and texts`);
    assert.ok(md.includes(`${M.p3.arDisposition.maintain} — Answer`) && md.includes(M.p3.arPending), `${lang}: responses and pending`);
    assert.ok(md.includes('Rationale on role-b#1') && md.includes('Core reading of role-b assumption#0') && md.includes('Source reading insufficient.'), `${lang}: rationales`);
  }
  // v1 계획은 예전 줄 그대로 (새 줄 없음)
  const legacy = core.markdownReport(core.normalizeProject(childRaw(LEGACY)), false, EN);
  assert.ok(legacy.includes(EN.p3.arFinding('role-a', EN.verdict.challenged, 'Role role-b', 1)));
  assert.ok(!legacy.includes(EN.p3.arSourceNote) && !legacy.includes(EN.p4.coreTitle));
  for (const M of [EN, KO]) for (const a of core.authorResponseLines(core.normalizeAuthorPlan(V5, PARENT), [], M, (id) => id)) assert.ok(a.lines.length > 0 && a.lines.every(l => typeof l === 'string' && !l.includes('undefined')));
});

await test('대상 조건과 핵심 주장 상한: 인용이 그 칸에 정확히 있어야 하고, 보고서마다 3개·근거와 합쳐 6개를 넘으면 핵심 주장만 읽을 수 없다', () => {
  const proj = (reports) => core.normalizeProject(parent(reports));
  const only = (claimFindings, findings = []) => [{ reviewerExpertId: 'role-a', summary: 's', findings, claimFindings }];
  assert.deepEqual(plain(core.authorResponseAffected(proj(only([C('role-b', 'nextAction', 0, 'SLA draft')])))), ['role-b']);
  assert.deepEqual(plain(core.authorResponseAffected(proj(only([C('role-b', 'nextAction', 0, 'SLA final')])))), [], 'quote not in that slot');
  assert.deepEqual(plain(core.authorResponseAffected(proj(only([C('role-b', 'assumption', 0, 'Ask for the SLA draft')])))), [], 'quote from another slot');
  assert.deepEqual(plain(core.authorResponseAffected(proj(only([C('role-b', 'summary', 0, 'the pilot halves')])))), ['role-b']);
  assert.deepEqual(plain(core.authorResponseAffected(proj(only([], [F('role-c', 0, 'supported', CS('partial'))])))), ['role-c'], 'supported + partial reading');
  const four = proj(only([1, 2, 3, 4].map(() => C('role-b', 'summary', 0, 'the pilot')), [F('role-c', 0, 'challenged')]));
  assert.equal(four.crossReview.invalidClaimFindings, true); assert.equal(four.crossReview.reports[0].claimFindings, undefined);
  assert.equal(four.crossReview.reports[0].findings.length, 1, 'evidence findings are kept');
  const over = proj(only([C('role-b', 'summary', 0, 'the pilot'), C('role-b', 'summary', 0, 'halves')], [0, 1, 2, 0, 1].map(i => F('role-c', i, 'challenged'))));
  assert.equal(over.crossReview.invalidClaimFindings, true); assert.equal(over.crossReview.reports[0].findings.length, 5);
  const fits = proj(only([C('role-b', 'summary', 0, 'the pilot')], [0, 1, 2, 0, 1].map(i => F('role-c', i, 'challenged'))));
  assert.equal(fits.crossReview.invalidClaimFindings, undefined); assert.equal(fits.crossReview.reports[0].claimFindings.length, 1);
  assert.equal(core.markdownReport(four, false, KO).includes(KO.p4.coreInvalid), true);
});

// ───────── 후속 프로젝트 화면 (가짜 DOM)
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
  click() { if (this.disabled) return; this.dispatch('click'); }
  *walk() { for (const c of this.children) if (typeof c !== 'string') { yield c; yield* c.walk(); } }
  querySelector(sel) {
    const m = /^\[data-fk="(.*)"\]$/.exec(sel), id = /^#(.*)$/.exec(sel);
    for (const n of this.walk()) { if (m && n.getAttribute('data-fk') === m[1]) return n; if (id && n.id === id[1]) return n; }
    return null;
  }
}
const json = (status, body) => Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body });
const CATALOGUE = { experts: ['role-a', 'role-b', 'role-c'].map(id => ({ id, name: `Role ${id}`, domain: 'd', summary: 's', prompt: 'p', tools: [], outputs: [], source: {} })),
  configuration: { liveReady: true, missing: [], maxExperts: 5 } };
function childView(project, lang) {
  const doc = { readyState: 'complete', activeElement: null, createElement: (t) => new Node_(doc, t), getElementById: (id) => id === 'cloudbite' ? root : null,
    listeners: {}, addEventListener(t, f) { (this.listeners[t] ||= []).push(f); } };
  doc.documentElement = new Node_(doc, 'html');
  const root = new Node_(doc, 'div'); root.id = 'cloudbite'; doc.body = new Node_(doc, 'body'); doc.body.append(root);
  const row = { id: CHILD, title: 'Answer', mode: 'live', status: 'completed', createdAt: 1, updatedAt: 1, expiresAt: Date.now() + 86400_000, expertCount: 2, feedbackCount: 0, model: 'test' };
  vm.runInContext(CLOUDBITE_JS, vm.createContext({
    document: doc, crypto: globalThis.crypto, CSS: { escape: (s) => s }, URL, URLSearchParams, Blob,
    location: { pathname: '/cloudbite/history', search: `?lang=${lang}`, hash: '' },
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0,
    fetch: (url) => {
      if (String(url).startsWith('/api/cloudbite/owner/')) return json(200, { authenticated: false, hasCredentials: false });
      if (url === '/api/cloudbite/bootstrap') return json(200, CATALOGUE);
      if (url.startsWith('/api/cloudbite/history?')) return json(200, { rows: [row], next: null, owner: false, retentionDays: 30 });
      if (url === `/api/cloudbite/history/${CHILD}`) return json(200, { project, model: 'test', roles: [], feedback: [], expiresAt: row.expiresAt, canFeedback: true });
      return json(404, {});
    },
  }));
  const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); };
  const all = () => [...root.walk()];
  return { flush, all, fk: (k) => all().find(n => n.getAttribute('data-fk') === k) };
}

await test('후속 프로젝트 화면 (EN/KO): 핵심 주장 칸·정확한 인용과 지지 판정 옆 인용문 대조를 그리고 속성 오류가 없다', async () => {
  for (const [M, lang] of [[EN, 'en'], [KO, 'ko']]) {
    const env = childView(childRaw(V5, { 'role-a': answered(V5, 'role-a', 'revise') }), lang);
    await env.flush(); env.fk('hist-record:' + CHILD).click(); await env.flush();
    const text = env.all().find(n => n.className === 'cb-panel cb-history-detail').textContent;
    assert.ok(text.includes(M.p3.arTitle) && !text.includes(M.p3.arPlanInvalid), `${lang}: plan readable`);
    assert.doesNotMatch(text, /undefined|NaN|\[object/, lang);
    assert.ok(text.includes('the pilot halves onboarding time') && text.includes('Vendor keeps the price'), `${lang}: exact quotes`);
    assert.ok(text.includes(M.p4.coreIssue['causal-overreach']) && text.includes(`Role role-b · ${M.p4.coreTarget.assumption} 1`) && text.includes(`Role role-a · ${M.p4.coreTarget.summary}`), `${lang}: core slot`);
    assert.ok(text.includes(`${M.p4.supportTitle} · ${M.p4.supportStatus.insufficient}`) && text.includes(M.verdict.supported), `${lang}: verdict and source reading`);
    assert.ok(text.includes(M.p3.arDisposition.revise), `${lang}: response`);
    assert.equal(env.all().filter(n => n.getAttribute('data-core')).length >= 2, true, `${lang}: core findings marked`);
  }
  const env = childView(childRaw(LEGACY), 'en');
  await env.flush(); env.fk('hist-record:' + CHILD).click(); await env.flush();
  const text = env.all().find(n => n.className === 'cb-panel cb-history-detail').textContent;
  assert.ok(text.includes(EN.p3.arTitle) && !text.includes(EN.p3.arPlanInvalid) && text.includes(EN.p3.arPending), 'legacy plan renders');
  assert.ok(!text.includes(EN.p3.arSourceNote) && !text.includes(EN.p3.arCoreText), 'legacy plan has no v5 lines');
});

console.log(`cloudbite-v5-author-plan-ui: ${pass} groups passed (server-built plans, fake DOM; no live provider or browser).`);
