// Cloudbite product-v3 backend integration: real Worker router + real CloudbiteProject/Access/History DOs over memory
// storage (the backend-v2 harness shape). Covers history claim adoption, adoption carry into an authorized follow-up,
// stored-artifact text in cross-review input/coverage, and the author-response child round (route/preview/create
// binding, per-author workspace, runner-reply collection, history deletion). No sandbox is started (alarms are not
// run); the only network is a fake Nosana endpoint and any other host fails the test.
//   node test/cloudbite-backend-v3.mjs
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { build } from 'esbuild';

const tmp = mkdtempSync(join(tmpdir(), 'cloudbite-backend-v3-'));
const built = await build({ stdin: { contents: `export { default, CloudbiteProject, CloudbiteAccess, CloudbiteHistory } from './src/index.ts'; export { CLOUDBITE_EXPERTS, phaseOnePack } from './src/cloudbite-personas.ts';
export { REVIEW_ROLE_IDS } from './src/cloudbite-knowledge.ts'; export { CB_MEMO_MAX_TOKENS } from './src/cloudbite-memo.ts'; export { CB_ARTIFACT_FILES } from './src/cloudbite-config.ts';
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
  summary: 'The finished opinions were read against both options; the first option is favoured with conditions.',
  recommendation: { status: 'recommend', optionIds: ['option-1'], rationale: 'The first option fits the stated objective.', expertIds: [ids[0]], refs: ['brief:objective'] },
  options: [{ optionId: 'option-1', benefits: [claim('Fits the objective', [ids[0]])], risks: [], conditions: [] },
    { optionId: 'option-2', benefits: [], risks: [claim('Slower to start', [ids[1] ?? ids[0]])], conditions: [] }],
  dissent: [], criticalUnknowns: [], changeTriggers: [claim('Costs double')], nextActions: [claim('Confirm the cost', [ids[0]])] });
const reviewData = (req) => JSON.parse(req.messages[1].content.replace(/^[^\n]*\n/, ''));
const challengeReply = (data) => JSON.stringify({ summary: `Review by ${data.reviewerExpertId}`, findings: data.peers.flatMap((p) => [
  { targetExpertId: p.expertId, evidenceIndex: 0, verdict: 'challenged', rationale: 'The cited plan does not show the claimed effect.' },
  { targetExpertId: p.expertId, evidenceIndex: 1, verdict: 'insufficient', rationale: 'No source supports this threshold.' }]) });
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
  return { status: r.status, data, text };
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

// ── provenance adoption over the history route ──
await test('adoption: exact {claimId,text,snapshot} only; server actor/time recorded; opinions, memo and budget untouched; no provider call', async () => {
  const w = world(), x = await finished(w);
  N.memoIds = x.created.brief.expertIds;
  assert.equal((await memo(w, x)).data.memo.status, 'completed');
  const s = w.store(x.id), memoBefore = JSON.stringify(s.m.get('memo')), budgetBefore = JSON.stringify(s.m.get('budget')), calls = N.calls.length;
  const opinionsBefore = JSON.stringify(s.m.get('project').runs.map((run) => s.m.get('expert:' + run).run.opinion));
  const h = await history(w, x.id);
  assert.equal(h.status, 200, h.text);
  const { ledger, state } = h.data.project.provenance;
  assert.deepEqual(state.adoptions, []);
  const c = ledger.claims.find((k) => k.origin === 'generated-opinion' && k.text.endsWith(THRESHOLD));
  assert.ok(c && c.numericThresholdHint, 'generated threshold is a lexical hint only');
  assert.ok(ledger.claims.some((k) => k.origin === 'user-statement' && k.text === 'Users finish onboarding without help'), 'user criterion kept exactly');
  const req = { claimId: c.id, text: c.text, snapshot: ledger.snapshot };
  for (const extra of [{ actor: 'someone-else' }, { at: 1 }]) {
    const r = await adopt(w, x.id, { ...req, ...extra });
    assert.equal(r.status, 409, r.text); assert.match(r.data.error, /server/);
  }
  assert.equal((await adopt(w, x.id, { ...req, text: c.text + ' ' })).status, 409, 'text must match exactly');
  assert.equal((await adopt(w, x.id, { ...req, snapshot: 'ps-0000000000000000' })).status, 409, 'stale snapshot');
  const user = ledger.claims.find((k) => k.origin === 'user-statement');
  assert.equal((await adopt(w, x.id, { claimId: user.id, text: user.text, snapshot: ledger.snapshot })).status, 409, 'user statements are not adoptable');
  assert.equal((await call(w, 'POST', `/api/cloudbite/history/${x.id}/adopt`, { headers: { ...OWNER, origin: 'https://evil.test' }, body: req })).status, 403);
  assert.equal((await call(w, 'POST', `/api/cloudbite/history/${x.id}/adopt`, { headers: x.auth, body: req })).status, 401, 'a project bearer token cannot adopt');
  assert.equal((await adopt(w, x.id, req, visitorHistory().headers)).status, 404, 'foreign history actor');
  offset = 5000;
  const at = Date.now();
  // Concurrent identical adoptions serialize: exactly one wins.
  const both = await Promise.all([adopt(w, x.id, req), adopt(w, x.id, req)]);
  assert.deepEqual(both.map((r) => r.status).sort(), [200, 409], both.map((r) => r.text).join(' | '));
  const won = both.find((r) => r.status === 200).data.project.provenance.state.adoptions;
  assert.equal(won.length, 1);
  assert.equal(won[0].actor, 'owner'); assert.ok(won[0].at >= at && won[0].at <= Date.now(), 'server time'); assert.equal(won[0].meaning, 'user-adoption-not-verification');
  assert.equal(s.m.get('memo') && JSON.stringify(s.m.get('memo')), memoBefore, 'original memo unchanged');
  assert.equal(JSON.stringify(s.m.get('budget')), budgetBefore, 'no budget reset or reservation');
  assert.equal(JSON.stringify(s.m.get('project').runs.map((run) => s.m.get('expert:' + run).run.opinion)), opinionsBefore, 'six-key opinions unchanged');
  assert.equal(N.calls.length, calls, 'adoption calls no model');
  assert.equal((await read(w, x)).data.memo.status, 'completed');
});

await test('adoption: running review/memo, unfinished, demo, foreign-owner, corrupt state and deleted projects fail closed', async () => {
  const w = world(), x = await finished(w), s = w.store(x.id);
  const { ledger } = (await history(w, x.id)).data.project.provenance;
  const c = ledger.claims.find((k) => k.origin === 'generated-opinion');
  const req = { claimId: c.id, text: c.text, snapshot: ledger.snapshot };
  s.m.set('memo', { memo: { status: 'running', startedAt: Date.now() }, claim: 'c' });
  assert.equal((await adopt(w, x.id, req)).status, 409, 'running memo blocks adoption');
  s.m.delete('memo');
  s.m.set('crossreview', { review: { status: 'running', startedAt: Date.now(), reports: [] }, claim: 'c' });
  assert.equal((await adopt(w, x.id, req)).status, 409, 'running review blocks adoption');
  s.m.delete('crossreview');
  const p = s.m.get('project');
  s.m.set('project', { ...p, status: 'running' });
  assert.equal((await adopt(w, x.id, req)).status, 409, 'unfinished project');
  s.m.set('project', p);
  s.m.set('provenance', { version: 'cloudbite-provenance/v1', projectId: 'cb' + '0'.repeat(32), adoptions: [] });
  const corrupt = await adopt(w, x.id, req);
  assert.equal(corrupt.status, 409, corrupt.text); assert.match(corrupt.data.error, /invalid/);
  assert.equal(s.m.get('provenance').projectId, 'cb' + '0'.repeat(32), 'corrupt state is not overwritten');
  s.m.delete('provenance');
  // A visitor's own project: the visitor adopts; an owner session that can read it cannot adopt for that user.
  const v = visitorHistory();
  s.m.set('project', { ...s.m.get('project'), history: { ...s.m.get('project').history, actor: v.actor } });
  const asOwner = await adopt(w, x.id, req);
  assert.equal(asOwner.status, 403, asOwner.text);
  const asVisitor = await adopt(w, x.id, req, v.headers);
  assert.equal(asVisitor.status, 200, asVisitor.text); assert.equal(s.m.get('provenance').adoptions[0].actor, v.actor);
  assert.equal((await call(w, 'DELETE', '/api/cloudbite/history/' + x.id, { headers: OWNER })).status, 200);
  assert.equal(s.m.has('provenance'), false, 'delete erases adoptions');
  assert.equal((await adopt(w, x.id, req, v.headers)).status, 404, 'deleted project');
  const demo = await create(w, brief({ mode: 'demo' }));
  const ds = w.store(demo.data.project.id), dp = ds.m.get('project'); dp.status = 'completed'; ds.m.set('project', dp);
  assert.equal((await adopt(w, demo.data.project.id, req)).status, 409, 'demo project');
});

await test('carry: only exact active adoptions reach an authorized follow-up; other generated thresholds stay proposals; corrupt parent state carries nothing', async () => {
  const w = world(), parent = await finished(w);
  const { ledger } = (await history(w, parent.id)).data.project.provenance;
  const thresholds = ledger.claims.filter((k) => k.origin === 'generated-opinion' && k.text.endsWith(THRESHOLD));
  assert.equal(thresholds.length, 2);
  const [chosen, other] = thresholds;
  assert.equal((await adopt(w, parent.id, { claimId: chosen.id, text: chosen.text, snapshot: ledger.snapshot })).status, 200);
  const c = await create(w, brief({ revision: { parentId: parent.id, changeSummary: 'Second round.' } }));
  assert.equal(c.status, 201, c.text);
  const round = w.store(c.data.project.id).m.get('round');
  assert.deepEqual(round.adoptedClaims.map((a) => [a.projectId, a.claimId, a.text, a.actor]), [[parent.id, chosen.id, chosen.text, 'owner']]);
  const child = c.data.project.provenance;
  const carried = child.ledger.claims.filter((k) => k.origin === 'parent-adoption');
  assert.deepEqual(carried.map((k) => k.text), [chosen.text]);
  assert.ok(!child.ledger.claims.some((k) => k.text === other.text), 'unadopted parent proposals are not carried');
  assert.ok(child.ledger.claims.some((k) => k.origin === 'user-statement' && k.text === 'Users finish onboarding without help'));
  const p = w.store(c.data.project.id).m.get('project'), e = w.store(c.data.project.id).m.get('expert:' + p.runs[0]);
  const files = w.obj(c.data.project.id).workspace(def(e.run.expertId), p.brief, e.run.assignment, round);
  const prov = files.find((f) => f.path === 'evidence/provenance.txt').content;
  assert.ok(prov.includes(chosen.text), 'workspace shows the adopted text'); assert.ok(!prov.includes(other.text), 'workspace omits the unadopted proposal');
  // Corrupt parent state: nothing is carried (fail closed), the follow-up itself still works.
  const parent2 = await finished(w);
  w.store(parent2.id).m.set('provenance', { garbage: true });
  const c2 = await create(w, brief({ revision: { parentId: parent2.id, changeSummary: 'Again.' } }));
  assert.equal(c2.status, 201, c2.text); assert.deepEqual(w.store(c2.data.project.id).m.get('round').adoptedClaims, []);
});

// ── cross-review reads stored artifact text ──
await test('artifact review: stored text is in the reviewer input and snapshot; coverage binds sha256 and discloses missing and truncated files honestly', async () => {
  const w = world();
  const big = Array.from({ length: 2000 }, (_, i) => `line ${i} of a long report`).join('\n');
  const x = await finished(w, { artifacts: (id) => (id === ROLES[0].id ? { 'out/report.md': big, 'out/notes.md': null } : { 'out/report.md': `# Report\nARTIFACT-TEXT-${id}\n` }) });
  const r = await review(w, x);
  assert.equal(r.status, 200, r.text);
  const inputs = N.calls.filter((c) => c.kind === 'review').map((c) => c.req.messages[1].content).join('\n');
  assert.ok(inputs.includes(`ARTIFACT-TEXT-${ROLES[1].id}`), 'peer artifact text reaches its reviewer');
  const cov = r.data.crossReview.artifactCoverage;
  const a0 = cov.find((c) => c.expertId === ROLES[0].id), a1 = cov.find((c) => c.expertId === ROLES[1].id);
  const f1 = a1.files.find((f) => f.path === 'out/report.md');
  assert.equal(f1.sha256, hash(`# Report\nARTIFACT-TEXT-${ROLES[1].id}\n`)); assert.equal(f1.excerptTruncated, false);
  const f0 = a0.files.find((f) => f.path === 'out/report.md');
  assert.ok(f0 && f0.excerptTruncated && f0.endLine < f0.totalLines, 'a long artifact is an excerpt, said so');
  assert.ok(a0.omitted.some((o) => o.path === 'out/notes.md' && o.reason === 'missing-text'), 'metadata without stored text is disclosed as missing');
  assert.ok(Buffer.byteLength(inputs) < 200 * 1024, 'reviewer input stays bounded');
  // The snapshot binds the artifact text: the same opinions with different stored text give a different hash.
  const y = await finished(w, { artifacts: (id) => ({ 'out/report.md': `# Report\nOTHER-TEXT-${id}\n` }) });
  assert.notEqual((await review(w, y)).data.crossReview.snapshotHash, r.data.crossReview.snapshotHash);
});

// ── author response: a NEW explicitly requested child round ──
await test('author response: route, preview and create share the binding; stale/foreign/demo/unaffected/no-review requests fail before any write', async () => {
  const w = world(), parent = await reviewed(w);
  const parentBefore = snap(w, parent.id), calls = N.calls.length;
  const b = responseBrief(parent);
  const ro = await route(w, { title: b.title, objective: b.objective, context: b.context, requestId: b.requestId, revision: b.revision });
  assert.notEqual(ro.status, 400, 'route accepts revision.reviewSnapshotHash: ' + ro.text);
  assert.equal((await route(w, { title: b.title, objective: b.objective, context: b.context, requestId: b.requestId, revision: { ...b.revision, reviewSnapshotHash: 'x' } })).status, 400);
  const pv = await preview(w, b);
  assert.equal(pv.status, 200, pv.text);
  assert.ok(pv.data.warnings.some((x) => x.includes(parent.id)));
  assert.deepEqual(w.stored().sort(), [parent.id], 'preview writes nothing');
  const fails = [
    [responseBrief({ ...parent, snapshotHash: 'a'.repeat(64) }), 409, 'stale review snapshot'],
    [responseBrief(parent, { mode: 'demo' }), 400, 'demo child'],
    [responseBrief(parent, { expertIds: [ROLES[2].id] }), 400, 'author not affected by the review'],
    [{ ...b, requestId: 'v3-x' + randomBytes(4).toString('hex'), revision: { ...b.revision, authorResponse: { roles: [] } } }, 400, 'body cannot supply a plan'],
    [{ ...b, requestId: 'v3-y' + randomBytes(4).toString('hex'), round: {} }, 400, 'body cannot supply a round'],
  ];
  for (const [fb, status, why] of fails) {
    const p = await preview(w, fb), c = await create(w, fb);
    assert.equal(p.status, status, `${why} (preview): ${p.text}`); assert.equal(c.status, status, `${why} (create): ${c.text}`);
    assert.equal(p.data.error, c.data.error, `${why}: preview and create refuse identically`);
  }
  const v = visitorHistory();
  assert.equal((await call(w, 'POST', '/api/cloudbite/preview', { headers: v.headers, body: b })).status, 401, 'a history cookie alone grants no create');
  // Parent without a completed cross-review.
  const plain = await finished(w);
  const nr = await create(w, brief({ revision: { parentId: plain.id, changeSummary: 'x', reviewSnapshotHash: 'b'.repeat(64) } }));
  assert.equal(nr.status, 409, nr.text);
  assert.deepEqual(w.stored().sort(), [parent.id, plain.id].sort(), 'no child was written');
  assert.equal(snap(w, parent.id), parentBefore, 'parent untouched'); assert.equal(N.calls.length, calls, 'no provider call');
  // The DO refuses a round whose plan was tampered with, in preview and create alike.
  const good = await create(w, b);
  assert.equal(good.status, 201, good.text);
  const round = structuredClone(w.store(good.data.project.id).m.get('round'));
  round.authorResponse.findings[0].reviewerRationale = 'forged';
  const nb = { ...b, requestId: 'v3-z' + randomBytes(4).toString('hex') };
  const id = 'cb' + hash('cloudbite-project|' + nb.requestId).slice(0, 32);
  const tp = await w.obj(id).preview(nb, undefined, { round }), tc = await w.obj(id).create(id, nb, 'owner', undefined, { round });
  assert.equal(tp.status, 400); assert.equal(tc.status, 400); assert.equal(tp.error, tc.error);
  const { authorResponse: _ar, ...bare } = w.store(good.data.project.id).m.get('round');
  assert.equal((await w.obj(id).preview(nb, undefined, { round: bare })).status, 400, 'a review snapshot needs a plan');
  assert.equal((await w.obj(id).preview(brief({ revision: { parentId: parent.id, changeSummary: 'x' } }), undefined, { round: w.store(good.data.project.id).m.get('round') })).status, 400, 'a plan needs a review snapshot');
});

await test('author response: child is new with its own budget; plan per author; parent opinions, review and memo unchanged; no automatic call', async () => {
  const w = world(), parent = await reviewed(w);
  N.memoIds = parent.created.brief.expertIds;
  assert.equal((await memo(w, parent)).data.memo.status, 'completed');
  const parentBefore = snap(w, parent.id), calls = N.calls.length;
  const b = responseBrief(parent, { expertIds: [ROLES[1].id] });
  const c = await create(w, b);
  assert.equal(c.status, 201, c.text);
  assert.equal(snap(w, parent.id), parentBefore, 'parent opinions, cross-review and memo unchanged');
  assert.equal(N.calls.length, calls, 'creating the child calls no model');
  const s = w.store(c.data.project.id), round = s.m.get('round'), plan = round.authorResponse;
  assert.ok(await M.verifyAuthorResponsePlan(plan));
  assert.deepEqual(plan.roles, [ROLES[1].id]); assert.deepEqual(plan.unselectedAuthors, [ROLES[0].id]);
  assert.equal(plan.crossReview.snapshotHash, parent.snapshotHash);
  assert.ok(plan.findings.length > 0 && plan.findings.every((f) => f.targetExpertId === ROLES[1].id));
  assert.equal(c.data.project.usage.caps.maxMemoCalls >= 0, true); assert.equal(c.data.project.memo, undefined, 'child memo is its own, not started');
  assert.ok(Buffer.byteLength(JSON.stringify(round)) <= 192 * 1024);
  const p = s.m.get('project'), e = s.m.get('expert:' + p.runs[0]);
  const files = w.obj(c.data.project.id).workspace(def(e.run.expertId), p.brief, e.run.assignment, round);
  const ws = JSON.parse(files.find((f) => f.path === 'evidence/author-response-findings.json').content);
  assert.equal(ws.planSha256, plan.planSha256); assert.deepEqual(ws.findings.map((f) => f.findingId), plan.authors[0].findingIds);
  assert.match(files.find((f) => f.path === 'WORKORDER.md').content, /authorResponse/);
  assert.ok(files.reduce((n, f) => n + Buffer.byteLength(f.content), 0) <= 256 * 1024, 'workspace within its bound');
  // Replay: the same create returns the same child without re-planning.
  const again = await create(w, b);
  assert.equal(again.status, 201); assert.equal(again.data.project.id, c.data.project.id); assert.deepEqual(w.store(c.data.project.id).m.get('round'), round);
});

await test('author response: runner reply collected against the trusted plan; canonical artifact app-made; partial/none/invalid stay separate from the opinion', async () => {
  const w = world(), parent = await reviewed(w);
  const c = await create(w, responseBrief(parent));
  const obj = w.obj(c.data.project.id), plan = w.store(c.data.project.id).m.get('round').authorResponse;
  const [a0] = plan.authors, ids = a0.findingIds;
  assert.ok(ids.length >= 2, 'fixture gives each author at least two findings');
  const entry = (findingId, disposition = 'maintain') => ({ findingId, disposition, rationale: 'The plan text still supports this claim.' });
  const collect = async (raw, p = plan) => { const contents = []; const r = await obj.collectAuthorResponse(p, a0.expertId, raw, contents); return { r, contents }; };
  const full = await collect(JSON.stringify({ responses: ids.map((id, i) => entry(id, i ? 'withdraw' : 'revise')) }));
  assert.equal(full.r.coverage.status, 'complete');
  assert.equal(full.contents.length, 1); assert.equal(full.contents[0][0], 'out/author-response.json');
  const art = JSON.parse(full.contents[0][1]);
  assert.equal(art.generatedBy, 'application'); assert.equal(art.planSha256, plan.planSha256); assert.equal(art.opinionSha256, a0.opinionSha256);
  assert.ok(!('invalid' in await M.validateCollectedAuthorResponse(plan, a0.expertId, full.contents[0][1])));
  const partial = await collect(JSON.stringify({ responses: [entry(ids[0])] }));
  assert.equal(partial.r.coverage.status, 'partial'); assert.deepEqual(partial.r.coverage.missing, ids.slice(1));
  const none = await collect(JSON.stringify({ responses: [] }));
  assert.equal(none.r.coverage.status, 'none'); assert.equal(none.r.coverage.answered, 0);
  const other = plan.authors[1].findingIds[0];
  for (const [raw, why] of [[null, 'missing'], ['not json', 'not JSON'], [JSON.stringify({ responses: [entry(other)] }), 'foreign finding'],
    [JSON.stringify({ responses: [entry(ids[0]), entry(ids[0])] }), 'duplicate'], [JSON.stringify({ responses: [{ ...entry(ids[0]), disposition: 'accept' }] }), 'bad disposition'],
    [JSON.stringify({ responses: [entry(ids[0])], opinion: {} }), 'extra key'], [JSON.stringify({ responses: [{ ...entry(ids[0]), rationale: '이 주장은 변경 없이 그대로 유지합니다. 계획서의 일정과 비용 항목이 여전히 이 판단을 뒷받침하며, 검토자의 지적은 다른 문단을 읽은 결과로 보입니다.' }] }), 'wrong language']]) {
    const x = await collect(raw);
    assert.ok('invalid' in x.r, why); assert.equal(x.contents.length, 0, `${why}: no artifact`);
  }
  const forged = structuredClone(plan); forged.findings[0].verdict = 'supported';
  const f = await collect(JSON.stringify({ responses: [entry(ids[0])] }), forged);
  assert.match(f.r.invalid, /hash/, 'a stored plan that no longer matches its hash is refused');
  assert.equal(M.CB_ARTIFACT_FILES >= 3, true, 'room for result, report and the response artifact');
});

await test('author response: history delete erases round, plan, responses and artifacts; nothing is recreated; a deleted parent stops new responses', async () => {
  const w = world(), parent = await reviewed(w);
  const c = await create(w, responseBrief(parent));
  const id = c.data.project.id, s = w.store(id), plan = s.m.get('round').authorResponse, p = s.m.get('project');
  for (const [i, run] of p.runs.entries()) {
    const e = s.m.get('expert:' + run), contents = [];
    e.run.authorResponse = await w.obj(id).collectAuthorResponse(plan, e.run.expertId, JSON.stringify({ responses: [{ findingId: plan.authors[i].findingIds[0], disposition: 'maintain', rationale: 'Still supported by the plan.' }] }), contents);
    e.int.phase = 'final'; e.run.status = 'completed'; e.run.opinion = opinion(e.run.expertId);
    e.run.artifacts = contents.map(([path, t]) => ({ path, label: path.slice(4), bytes: Buffer.byteLength(t) }));
    for (const [path, t] of contents) s.m.set(`artifact:${run}:${path}`, t);
    s.m.set('expert:' + run, e);
  }
  s.m.set('project', { ...p, status: 'completed', finishedAt: Date.now(), released: true });
  await w.env.CLOUDBITE.getByName('registry').registryRelease(id);
  const h = await history(w, id);
  assert.ok(h.data.project.experts.every((e) => e.authorResponse?.coverage), 'responses are shown beside the opinions');
  assert.equal((await call(w, 'DELETE', '/api/cloudbite/history/' + id, { headers: OWNER })).status, 200);
  for (const k of ['round', 'provenance', 'crossreview', 'memo']) assert.equal(s.m.has(k), false, k);
  assert.ok(![...s.m.keys()].some((k) => k.startsWith('artifact:')), 'artifacts erased');
  assert.ok(p.runs.every((run) => s.m.get('expert:' + run).run.authorResponse === undefined), 'responses erased');
  await w.obj(id).alarm();
  assert.ok(![...s.m.keys()].some((k) => k.startsWith('artifact:') || k === 'round'), 'no late recreation');
  assert.equal((await call(w, 'DELETE', '/api/cloudbite/history/' + parent.id, { headers: OWNER })).status, 200);
  const r = await create(w, responseBrief(parent));
  assert.equal(r.status, 404, r.text);
});

console.log(`cloudbite backend v3: ${passed} integration checks passed (no provider network)`);
