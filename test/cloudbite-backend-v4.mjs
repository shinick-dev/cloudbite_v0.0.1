// Cloudbite product-v4 backend integration: real Worker router + real CloudbiteProject/Access/History DOs over memory
// storage (the backend-v2 harness shape). Covers history claim adoption, adoption carry into an authorized follow-up,
// stored-artifact text in cross-review input/coverage, and the author-response child round (route/preview/create
// binding, per-author workspace, runner-reply collection, history deletion). No sandbox is started (alarms are not
// run); the only network is a fake Nosana endpoint and any other host fails the test.
//   node test/cloudbite-backend-v3.mjs
import assert from 'node:assert/strict';
import { coachingFixture } from './fixtures/cloudbite-coaching.mjs';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { build } from 'esbuild';

const tmp = mkdtempSync(join(tmpdir(), 'cloudbite-backend-v4-'));
const built = await build({ stdin: { contents: `export { default, CloudbiteProject, CloudbiteAccess, CloudbiteHistory } from './src/index.ts'; export { CLOUDBITE_EXPERTS, phaseOnePack } from './src/cloudbite-personas.ts';
export { REVIEW_ROLE_IDS } from './src/cloudbite-knowledge.ts'; export { CB_MEMO_MAX_TOKENS, CB_MEMO_STALE } from './src/cloudbite-memo.ts'; export { CB_ARTIFACT_FILES } from './src/cloudbite-config.ts';
export { CB_WORKSPACE_LEDGER } from './src/cloudbite-project.ts'; export { buildProvenanceLedger } from './src/cloudbite-provenance.ts'; export { CB_CROSS_REVIEW_STALE } from './src/cloudbite-cross-review.ts';
export { validateCollectedAuthorResponse, verifyAuthorResponsePlan } from './src/cloudbite-author-response.ts';`, resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, write: false, platform: 'node', format: 'esm', loader: { '.ps1': 'text' }, plugins: [{ name: 'cf', setup(b) {
    b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'cf', namespace: 'stub' }));
    b.onLoad({ filter: /^cf$/, namespace: 'stub' }, () => ({ contents: 'export class DurableObject { constructor(ctx,env){this.ctx=ctx;this.env=env;} }' }));
  } }] });
writeFileSync(join(tmp, 'm.mjs'), built.outputFiles[0].text);
const M = await import(pathToFileURL(join(tmp, 'm.mjs')));

const BASE = 'https://cb.test', TOKEN = 'cbo_' + randomBytes(32).toString('base64url'), OWNER = { 'x-admin-token': TOKEN };
const NOSANA_KEY = 'NOSANA-SECRET-VALUE';
const hash = (s) => createHash('sha256').update(s).digest('hex');
const realNow = Date.now; let offset = 0; Date.now = () => realNow() + offset;
const claim = (text, expertIds = [], refs = []) => ({ text, expertIds, refs });

// ── fake Nosana: memo and review replies; reviews challenge evidence 0 and find evidence 1 insufficient ──
let N;
const reset = () => { N = { calls: [], reply: null, memoIds: [] }; };
reset();
const memoReply = (ids) => JSON.stringify({
  coaching: coachingFixture(ids[0]),
  summary: 'The finished opinions were read against both options; the first option is favoured with conditions.',
  recommendation: { status: 'recommend', optionIds: ['option-1'], rationale: 'The first option fits the stated objective.', expertIds: [ids[0]], refs: ['brief:objective'] },
  options: [{ optionId: 'option-1', benefits: [claim('Fits the objective', [ids[0]])], risks: [], conditions: [] },
    { optionId: 'option-2', benefits: [], risks: [claim('Slower to start', [ids[1] ?? ids[0]])], conditions: [] }],
  dissent: [], criticalUnknowns: [], changeTriggers: [claim('Costs double')], nextActions: [claim('Confirm the cost', [ids[0]])] });
const reviewData = (req) => JSON.parse(req.messages[1].content.replace(/^[^\n]*\n/, ''));
const challengeReply = (data) => JSON.stringify({ summary: `Review by ${data.reviewerExpertId}`, findings: data.peers.flatMap((p) => [
  { targetExpertId: p.expertId, evidenceIndex: 0, verdict: 'challenged', rationale: 'The cited plan does not show the claimed effect.', claimSupport: { status: 'insufficient', quotes: [], rationale: 'The cited plan does not show the claimed effect.' } },
  { targetExpertId: p.expertId, evidenceIndex: 1, verdict: 'insufficient', rationale: 'No source supports this threshold.', claimSupport: { status: 'insufficient', quotes: [], rationale: 'No source supports this threshold.' } }]) });
globalThis.fetch = async (u, init = {}) => {
  const url = new URL(typeof u === 'string' ? u : u.url);
  if (url.host !== 'nosana.fake') throw new Error('network forbidden: ' + url.host);
  assert.equal(new Headers(init.headers).get('authorization'), 'Bearer ' + NOSANA_KEY);
  const req = JSON.parse(init.body);
  const kind = req.max_tokens === M.CB_MEMO_MAX_TOKENS ? 'memo' : /cross-review|reviewerExpertId/.test(req.messages[1]?.content ?? '') ? 'review' : 'expert';
  N.calls.push({ kind, req });
  const content = N.reply ? N.reply(kind, req) : kind === 'memo' ? memoReply(N.memoIds) : kind === 'review' ? challengeReply(reviewData(req)) : 'turn reply';
  return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }), { headers: { 'content-type': 'application/json' } });
};

function storage() {
  const m = new Map(), db = new DatabaseSync(':memory:'); let alarm = null, queue = Promise.resolve();
  const clone = (v) => v === undefined ? undefined : structuredClone(v);
  const s = { m,
    sql: { exec(sql, ...args) { const rows = db.prepare(sql).all(...args); return { toArray: () => rows, [Symbol.iterator]: function* () { yield* rows; } }; } },
    async get(k) { await null; if (Array.isArray(k)) assert.ok(k.length <= 128, 'get batch over the per-call key limit'); return Array.isArray(k) ? new Map(k.filter((x) => m.has(x)).map((x) => [x, clone(m.get(x))])) : clone(m.get(k)); },
    async put(k, v) { await null; for (const [key, value] of typeof k === 'object' ? Object.entries(k) : [[k, v]]) m.set(key, clone(value)); },
    async list({ prefix = '' } = {}) { return new Map([...m].filter(([k]) => k.startsWith(prefix)).sort().map(([k, v]) => [k, clone(v)])); },
    async delete(k) { const keys = Array.isArray(k) ? k : [k]; assert.ok(keys.length <= 128); let n = 0; for (const key of keys) if (m.delete(key)) n++; return Array.isArray(k) ? n : n > 0; },
    transaction(f) { const result = queue.then(() => f(s)); queue = result.catch(() => {}); return result; },
    async getAlarm() { return alarm; }, async setAlarm(at) { alarm = at; }, async deleteAlarm() { alarm = null; },
    async deleteAll() { m.clear(); db.exec('DROP TABLE IF EXISTS history'); alarm = null; },
  }; return s;
}
function world() {
  const w = {};
  const ns = (Class) => {
    const records = new Map();
    const getByName = (name) => {
      if (!records.has(name)) {
        const s = storage(), ctx = { storage: s, id: { name }, blockConcurrencyWhile: (f) => f(), waitUntil() {} };
        records.set(name, { storage: s, ctx, object: new Class(ctx, w.env) });
      }
      return records.get(name).object;
    };
    return { records, getByName };
  };
  w.env = { ORIGIN: BASE, RP_ID: 'cb.test', LAB_ORIGIN: 'https://lab.invalid', MASTER_KEY: 'test-key', CLOUDBITE_OPERATOR_TOKEN_HASH: hash(TOKEN), CLOUDBITE_OPERATOR_EXPIRES_AT: String(realNow() + 400 * 86400_000),
    CLOUDBITE_ALLOW_HTTP: '1', CLOUDBITE_DAYTONA_API_URL: 'https://dt.fake', CLOUDBITE_DAYTONA_API_KEY: 'DAYTONA-SECRET-VALUE',
    CLOUDBITE_NOSANA_BASE_URL: 'https://nosana.fake/v1', CLOUDBITE_NOSANA_API_KEY: NOSANA_KEY, CLOUDBITE_NOSANA_MODEL: 'fake-model', CLOUDBITE_GATEWAY_URL: 'http://127.0.0.1:9' };
  w.env.CLOUDBITE = ns(M.CloudbiteProject); w.env.CLOUDBITE_ACCESS = ns(M.CloudbiteAccess); w.env.CLOUDBITE_HISTORY = ns(M.CloudbiteHistory);
  w.env.STATE = { idFromName: (x) => x, get: () => ({ cloudbiteOwnerCheck: async () => false, adminList: async () => ({ error: 'no', status: 401 }) }) };
  w.store = (id) => w.env.CLOUDBITE.records.get(id)?.storage;
  w.obj = (id) => w.env.CLOUDBITE.getByName(id);
  w.stored = () => [...w.env.CLOUDBITE.records.entries()].filter(([, r]) => r.storage.m.has('project')).map(([k]) => k);
  return w;
}
async function call(w, method, path, { headers = {}, body, raw } = {}) {
  const r = await M.default.fetch(new Request(BASE + path, { method, headers: { ...(method !== 'GET' ? { origin: BASE, 'content-type': 'application/json' } : {}), ...headers }, ...(body !== undefined || raw !== undefined ? { body: raw ?? JSON.stringify(body) } : {}) }), w.env, { waitUntil() {} });
  const text = await r.text(); let data; try { data = JSON.parse(text); } catch {}
  return { status: r.status, data, text, headers: r.headers };
}

const ROLES = M.CLOUDBITE_EXPERTS.filter((e) => M.phaseOnePack(e.id) && !M.REVIEW_ROLE_IDS.has(e.id)).slice(0, 3);
assert.equal(ROLES.length, 3, 'three packed roles for the fixtures');
const def = (id) => M.CLOUDBITE_EXPERTS.find((x) => x.id === id);
const THRESHOLD = 'Require at least 80% task completion before launch';
const frame = () => ({ options: ['Plan A: in-house', 'Plan B: vendor'], constraints: ['Budget under 50k'], successCriteria: ['Users finish onboarding without help'],
  knownFacts: ['Vendor quote is 42k'], assumptions: ['Team can absorb support'], unknowns: ['Vendor SLA terms'] });
const brief = (over = {}) => ({ title: 'Backend v3 QA', objective: 'Should we pilot the plan?', context: 'Context for the pilot.', mode: 'live',
  expertIds: ROLES.slice(0, 2).map((r) => r.id), requestId: 'v3-' + randomBytes(8).toString('hex'), decision: frame(), ...over });
const opinion = (id) => ({ direction: 'conditional', confidence: 61, summary: `Opinion of ${id}`, evidence: [`${id} evidence 0 [source:PROJECT.md]`, `${id}: ${THRESHOLD}`], assumptions: ['a'], nextActions: ['n'] });
const create = (w, b, headers = OWNER) => call(w, 'POST', '/api/cloudbite/projects', { headers, body: b });
const preview = (w, b, headers = OWNER) => call(w, 'POST', '/api/cloudbite/preview', { headers, body: b });
const route = (w, b, headers = OWNER) => call(w, 'POST', '/api/cloudbite/route', { headers, body: b });
const history = (w, id, headers = OWNER) => call(w, 'GET', '/api/cloudbite/history/' + id, { headers });
const adopt = (w, id, body, headers = OWNER) => call(w, 'POST', `/api/cloudbite/history/${id}/adopt`, { headers, body });
const review = (w, x) => call(w, 'POST', `/api/cloudbite/projects/${x.id}/review`, { headers: x.auth, body: {} });
const memo = (w, x) => call(w, 'POST', `/api/cloudbite/projects/${x.id}/memo`, { headers: x.auth, body: {} });
const read = (w, x) => call(w, 'GET', '/api/cloudbite/projects/' + x.id, { headers: x.auth });
const visitorHistory = () => { const token = 'cbh_' + randomBytes(32).toString('hex'); return { headers: { cookie: `__Host-cb-history=${token}` }, actor: 'v_' + hash(token) }; };
const snap = (w, id) => JSON.stringify([...w.store(id).m.entries()]);
/** An approved visitor access session (the backend-v2 shape). */
async function visitor(w) {
  const r = await call(w, 'POST', '/api/cloudbite/access/requests', { body: { name: 'Visitor', purpose: 'try Cloudbite' }, headers: { 'cf-connecting-ip': '203.0.113.' + Math.floor(Math.random() * 250) } });
  assert.equal(r.status, 201, r.text);
  const v = { cookie: r.headers.get('set-cookie').split(';')[0], id: r.data.request.id };
  assert.equal((await call(w, 'POST', `/api/cloudbite/access/requests/${v.id}/approve`, { body: {}, headers: OWNER })).status, 200);
  return v;
}
const memoCalls = () => N.calls.filter((c) => c.kind === 'memo');

/** Live project via the real API, then seeded as finished with stored report/extra artifacts (no sandbox, no alarm). */
async function finished(w, { b = brief(), artifacts = (id) => ({ 'out/report.md': `# Report of ${id}\nARTIFACT-TEXT-${id}\n` }) } = {}) {
  const r = await create(w, b);
  assert.equal(r.status, 201, r.text);
  const id = r.data.project.id, s = w.store(id), p = s.m.get('project');
  for (const run of p.runs) {
    const e = s.m.get('expert:' + run), files = { 'out/result.json': JSON.stringify(opinion(e.run.expertId)), ...artifacts(e.run.expertId) };
    e.int.phase = 'final'; e.run.status = 'completed'; e.run.opinion = opinion(e.run.expertId);
    e.run.artifacts = Object.entries(files).map(([path, t]) => ({ path, label: path.slice(4), bytes: Buffer.byteLength(t ?? '') }));
    for (const [path, t] of Object.entries(files)) if (t !== null) s.m.set(`artifact:${run}:${path}`, t);
    s.m.set('expert:' + run, e);
  }
  p.status = 'completed'; p.finishedAt = Date.now(); p.released = true;
  await w.env.CLOUDBITE.getByName('registry').registryRelease(id);
  s.m.set('project', p);
  return { id, auth: { authorization: 'Bearer ' + r.data.accessToken }, created: r.data.project };
}
/** A finished parent with a completed cross-review whose findings challenge both authors. */
async function reviewed(w, b) {
  const x = await finished(w, b ? { b } : {});
  const r = await review(w, x);
  assert.equal(r.status, 200, r.text); assert.equal(r.data.crossReview.status, 'completed', JSON.stringify(r.data.crossReview));
  return { ...x, snapshotHash: r.data.crossReview.snapshotHash };
}
const responseBrief = (parent, over = {}) => brief({ revision: { parentId: parent.id, changeSummary: 'Answer the cross-review.', reviewSnapshotHash: parent.snapshotHash }, ...over });

let passed = 0;
const test = async (name, fn) => { offset = 0; reset(); await fn(); passed++; console.log('ok', name); };

const calc = (w, x, request, source) => call(w, 'POST', `/api/cloudbite/projects/${x.id}/quantitative`, { headers: x.auth, body: { request, ...(source ? { source } : {}) } });
const arithmetic = (n = 1) => ({ kind: 'arithmetic', expression: 'a + b', variables: { a: { value: n, unit: 'ns' }, b: { value: 20, unit: 'ps' } } });

await test('calculation route: token, origin, method, content type, strict body and live finished status', async () => {
  const w = world(), x = await finished(w), path = `/api/cloudbite/projects/${x.id}/quantitative`;
  assert.equal((await call(w, 'POST', path, { body: { request: arithmetic() } })).status, 401);
  assert.equal((await call(w, 'POST', path, { headers: { ...x.auth, origin: 'https://evil.test' }, body: { request: arithmetic() } })).status, 403);
  assert.equal((await call(w, 'GET', path, { headers: x.auth })).status, 405);
  assert.equal((await call(w, 'POST', path, { headers: { ...x.auth, 'content-type': 'text/plain' }, body: { request: arithmetic() } })).status, 415);
  assert.equal((await call(w, 'POST', path, { headers: x.auth, body: { request: arithmetic(), projectId: 'foreign' } })).status, 400);
  assert.equal((await calc(w, x, arithmetic(), { kind: 'document', id: 'doc-1' })).status, 400);
  assert.equal((await calc(w, x, { ...arithmetic(), expression: 'process.exit()' })).data.quantitativeChecks[0].result.status, 'error');
  const y = await create(w, brief());
  assert.equal((await calc(w, { id: y.data.project.id, auth: { authorization: 'Bearer ' + y.data.accessToken } }, arithmetic())).status, 409);
  assert.equal(N.calls.length, 0);
});

await test('deterministic calculation: units, expected and sensitivity saved exactly; duplicates concurrent and restart-safe; no provider budget', async () => {
  const w = world(), x = await finished(w), s = w.store(x.id), before = JSON.stringify(s.m.get('budget'));
  const req = { ...arithmetic(), expected: { value: 1020, unit: 'ps' }, sensitivity: { variable: 'a', delta: 0.1 } };
  const both = await Promise.all([calc(w, x, req), calc(w, x, req)]);
  assert.deepEqual(both.map(r => r.status), [200, 200]);
  const checks = both[1].data.quantitativeChecks;
  assert.equal(checks.length, 1); assert.equal(checks[0].projectId, x.id);
  assert.equal(checks[0].execution, 'app-deterministic');
  assert.ok(Math.abs(checks[0].result.result.value - 1.02e-9) < 1e-20);
  assert.equal(checks[0].result.expected.status, 'within-tolerance');
  assert.equal(checks[0].result.sensitivity.plus.status, 'completed');
  assert.equal((await read(w, x)).data.quantitativeChecks[0].id, checks[0].id);
  assert.deepEqual((await history(w, x.id)).data.project.quantitativeChecks, checks);
  assert.equal(JSON.stringify(s.m.get('budget')), before); assert.equal(N.calls.length, 0);
});

await test('stored CSV: exact project artifact/document binding, exclusions, missing/foreign/path refusal and source hashes', async () => {
  const csv = 'name,value\nalpha,2\nbeta,4\ngamma,\ndelta,=2+2\n';
  const w = world(), b = brief({ documents: [{ id: 'doc-1', name: 'input.csv', content: csv }] });
  const x = await finished(w, { b, artifacts: () => ({ 'out/report.md': 'report', 'out/data.csv': csv }) });
  const req = { kind: 'csv-summary', column: 'value' }, source = { kind: 'artifact', expertId: b.expertIds[0], path: 'out/data.csv' };
  const r = await calc(w, x, req, source);
  assert.equal(r.status, 200, r.text);
  const q = r.data.quantitativeChecks[0];
  assert.equal(q.source.sha256, hash(csv)); assert.equal(q.result.csvSha256, hash(csv));
  assert.equal(q.result.rows.included, 2); assert.equal(q.result.rows.excluded, 2); assert.equal(q.result.summary.sum, 6); assert.equal(q.result.unit, 'unknown');
  assert.equal((await calc(w, x, req, { kind: 'document', id: 'doc-1' })).data.quantitativeChecks.length, 2);
  assert.equal((await calc(w, x, req, { ...source, expertId: 'foreign' })).status, 404);
  assert.equal((await calc(w, x, req, { ...source, path: '../../secret.csv' })).status, 400);
  assert.equal((await calc(w, x, req, { ...source, sha256: 'forged' })).status, 400);
  assert.equal((await calc(w, x, req)).status, 400);
  const other = await finished(w);
  assert.equal((await call(w, 'POST', `/api/cloudbite/projects/${other.id}/quantitative`, { headers: x.auth, body: { request: req, source } })).status, 401);
});

await test('retention: cap20, identical checks remain idempotent at cap, delete erases and late writes cannot resurrect', async () => {
  const w = world(), x = await finished(w);
  for (let i = 1; i <= 20; i++) assert.equal((await calc(w, x, arithmetic(i))).status, 200);
  assert.equal((await calc(w, x, arithmetic(21))).status, 429);
  assert.equal((await calc(w, x, arithmetic(1))).data.quantitativeChecks.length, 20);
  assert.equal((await call(w, 'DELETE', `/api/cloudbite/history/${x.id}`, { headers: OWNER })).status, 200);
  assert.equal(w.store(x.id).m.has('quantitative'), false);
  assert.equal((await calc(w, x, arithmetic(1))).status, 401);
  const y = await finished(w), sy = w.store(y.id), orig = sy.transaction.bind(sy);
  let once = true;
  sy.transaction = fn => { if (once) { once = false; const p = sy.m.get('project'); p.history.deleted = true; sy.m.set('project', p); } return orig(fn); };
  assert.equal((await calc(w, y, arithmetic())).status, 401);
  assert.equal(sy.m.has('quantitative'), false);
});

await test('citation support: real DO supplies same text context, accepts bound quotes, stores location; forged quote fails without overwriting opinions', async () => {
  const w = world(), x = await finished(w), before = JSON.stringify((await read(w, x)).data.experts);
  N.reply = (kind, req) => {
    if (kind !== 'review') return 'turn reply';
    const d = reviewData(req), p = d.peers[0], slot = d.claimSupport.slots.find(s => s.targetExpertId === p.expertId && s.evidenceIndex === 0);
    const passage = d.claimSupport.passages.find(p => p.slotIds.includes(slot.slotId));
    assert.ok(passage.text.length >= 8);
    return JSON.stringify({ summary: 'Text compared with the evidence.', findings: [{ targetExpertId: p.expertId, evidenceIndex: 0, verdict: 'insufficient', rationale: 'The plan is a statement, not an observed outcome.',
      claimSupport: { status: 'partial', quotes: [{ passageId: passage.passageId, quote: passage.text.slice(0, 50) }], rationale: 'This passage mentions the plan without observing its outcome.' } }] });
  };
  const r = await review(w, x);
  assert.equal(r.status, 200); assert.equal(r.data.crossReview.status, 'completed', r.text);
  const cs = r.data.crossReview.reports[0].findings[0].claimSupport;
  assert.equal(cs.basis, 'model-assessment'); assert.equal(cs.quoteCheck, 'exact-substring');
  assert.equal(cs.quotes[0].textOrigin, 'workspace-field'); assert.match(cs.quotes[0].sourceSha256, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(r.data.experts), before);
  const y = await finished(w);
  N.reply = (kind, req) => { const d = reviewData(req), p = d.peers[0]; return JSON.stringify({ summary: 'Invalid citation excerpt.', findings: [{ targetExpertId: p.expertId, evidenceIndex: 0, verdict: 'supported', rationale: 'Untrusted model claim.', claimSupport: { status: 'supported', quotes: [{ passageId: d.claimSupport.passages[0].passageId, quote: 'A fabricated excerpt that was never in this source.' }], rationale: 'Unsupported claim.' } }] }); };
  const rejected = await review(w, y);
  assert.equal(rejected.data.crossReview.status, 'failed', rejected.text);
  assert.ok(rejected.data.experts.every(e => e.status === 'completed'));
});

Date.now = realNow;
console.log(`cloudbite-backend-v4: ${passed} integration groups passed (mock provider; no real sandbox or model).`);

