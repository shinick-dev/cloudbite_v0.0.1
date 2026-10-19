// Cloudbite product-v2 backend integration: real Worker router + real CloudbiteProject/Access/History DOs over memory
// storage. Covers preview, per-role assignments, the shared call ledger, the decision memo, follow-up rounds, PMC
// import admission and history deletion of the new data. No sandbox is ever started (alarms are not run); the only
// network is a fake Nosana endpoint and a fake PMC host, and any other host fails the test.
//   node test/cloudbite-backend-v2.mjs
import assert from 'node:assert/strict';
import { coachingFixture } from './fixtures/cloudbite-coaching.mjs';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { build } from 'esbuild';

const tmp = mkdtempSync(join(tmpdir(), 'cloudbite-backend-v2-'));
const built = await build({ stdin: { contents: `export { default, CloudbiteProject, CloudbiteAccess, CloudbiteHistory } from './src/index.ts'; export { CLOUDBITE_EXPERTS, phaseOnePack } from './src/cloudbite-personas.ts';
export { knowledgeWorkspaceFiles, REVIEW_ROLE_IDS } from './src/cloudbite-knowledge.ts'; export { CB_MEMO_MAX_TOKENS } from './src/cloudbite-memo.ts'; export { CB_INFERENCE_MAX_CALLS } from './src/cloudbite-config.ts';`, resolveDir: process.cwd(), loader: 'ts' },
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
const gate = () => { let resolve; const p = new Promise((r) => (resolve = r)); return { p, resolve }; };
const claim = (text, expertIds = [], refs = []) => ({ text, expertIds, refs });

// ── fake network: Nosana (memo / review / expert turns) and the fixed PMC host ──
let N, P;
const reset = () => { N = { calls: [], hold: null, reply: null, fail: false }; P = { calls: [], reply: null }; };
reset();
const memoReply = (ids) => JSON.stringify({
  coaching: coachingFixture(ids[0]),
  summary: 'The finished opinions were read against both options; the first option is favoured with conditions.',
  recommendation: { status: 'recommend', optionIds: ['option-1'], rationale: 'The first option fits the stated objective.', expertIds: [ids[0]], refs: ['brief:objective'] },
  options: [{ optionId: 'option-1', benefits: [claim('Fits the objective', [ids[0]])], risks: [], conditions: [] },
    { optionId: 'option-2', benefits: [], risks: [claim('Slower to start', [ids[1] ?? ids[0]])], conditions: [] }],
  dissent: [], criticalUnknowns: [], changeTriggers: [claim('Costs double')], nextActions: [claim('Confirm the cost', [ids[0]])] });
const reviewReply = (data) => JSON.stringify({ summary: `Review by ${data.reviewerExpertId}`, findings: data.peers.map((p) => ({ targetExpertId: p.expertId, evidenceIndex: 0, verdict: 'supported', rationale: 'Evidence item read against the summary.', claimSupport: { status: 'insufficient', quotes: [], rationale: 'Evidence item read against the summary.' } })) });
globalThis.fetch = async (u, init = {}) => {
  const url = new URL(typeof u === 'string' ? u : u.url);
  if (url.host === 'pmc.ncbi.nlm.nih.gov') {
    P.calls.push({ url: url.href, headers: new Headers(init.headers), at: Date.now() });
    return P.reply ? P.reply(url) : new Response(`<?xml version="1.0"?><OAI-PMH xmlns="http://www.openarchives.org/OAI/2.0/"><responseDate>x</responseDate><request>x</request><error code="idDoesNotExist">no</error></OAI-PMH>`, { status: 200, headers: { 'content-type': 'application/xml' } });
  }
  if (url.host !== 'nosana.fake') throw new Error('network forbidden: ' + url.host);
  assert.equal(new Headers(init.headers).get('authorization'), 'Bearer ' + NOSANA_KEY);
  const req = JSON.parse(init.body);
  const kind = req.max_tokens === M.CB_MEMO_MAX_TOKENS ? 'memo' : /cross-review|reviewerExpertId/.test(req.messages[1]?.content ?? '') ? 'review' : 'expert';
  N.calls.push({ kind, req });
  if (N.hold) await N.hold.p;
  if (N.fail) return new Response('upstream failure', { status: 500 });
  let content = 'turn reply';
  if (N.reply) content = N.reply(kind, req);
  else if (kind === 'memo') content = memoReply(N.memoIds ?? []);
  else if (kind === 'review') content = reviewReply(JSON.parse(req.messages[1].content.replace(/^[^\n]*\n/, '')));
  return new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }), { headers: { 'content-type': 'application/json' } });
};

function storage() {
  const m = new Map(), db = new DatabaseSync(':memory:'); let alarm = null, queue = Promise.resolve();
  const clone = (v) => v === undefined ? undefined : structuredClone(v);
  const s = { m, db,
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
const sleeps = [];
class TestProject extends M.CloudbiteProject { pmcSleep(ms) { sleeps.push(ms); offset += ms; return Promise.resolve(); } }
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
  w.env.CLOUDBITE = ns(TestProject); w.env.CLOUDBITE_ACCESS = ns(M.CloudbiteAccess); w.env.CLOUDBITE_HISTORY = ns(M.CloudbiteHistory);
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

const EXPERTS = M.CLOUDBITE_EXPERTS;
const ROLES = EXPERTS.filter((e) => M.phaseOnePack(e.id) && !M.REVIEW_ROLE_IDS.has(e.id)).slice(0, 4);
assert.equal(ROLES.length, 4, 'four packed roles for the fixtures');
const frame = () => ({ options: ['Plan A: in-house', 'Plan B: vendor'], constraints: ['Budget under 50k'], successCriteria: ['Live in 8 weeks'],
  knownFacts: ['Vendor quote is 42k'], assumptions: ['Team can absorb support'], unknowns: ['Vendor SLA terms'] });
const brief = (over = {}) => ({ title: 'Backend v2 QA', objective: 'Should we pilot the plan?', context: 'Context for the pilot.', mode: 'live',
  expertIds: ROLES.slice(0, 2).map((r) => r.id), requestId: 'v2-' + randomBytes(8).toString('hex'), decision: frame(), ...over });
const opinion = (id) => ({ direction: 'conditional', confidence: 61, summary: `Opinion of ${id}`, evidence: [`${id} evidence 0 [source:PROJECT.md]`, `${id} evidence 1`], assumptions: ['a'], nextActions: ['n'] });
/** Runner-shaped retrieval audit of the role's first card (as runner finish() writes out/knowledge.json). */
function auditFor(expertId) {
  const pack = M.phaseOnePack(expertId);
  const manifest = JSON.parse(M.knowledgeWorkspaceFiles(pack, '', false).find((f) => f.path === 'knowledge/manifest.json').content);
  const card = pack.cards[0], sources = pack.sources.filter((s) => card.source_ids.includes(s.id) || s.aliases.some((a) => card.source_ids.includes(a)));
  return JSON.stringify({ version: manifest.version, validation: 'curated-unvalidated', provenance: manifest.provenance, retrievals: [{ reason: 'initial selection', cardIds: [card.id], sourceIds: sources.map((s) => s.id) }],
    sources, citationIdsValidated: true, sourcePagesFetched: false, schema: manifest.schema, expertId, evaluation: 'unvalidated', peerResultsVerified: false, peerInputsProvided: false });
}

const create = (w, b, headers = OWNER) => call(w, 'POST', '/api/cloudbite/projects', { headers, body: b });
const preview = (w, b, headers = OWNER) => call(w, 'POST', '/api/cloudbite/preview', { headers, body: b });
/** Live project via the real API, experts then seeded as finished (no sandbox, no alarm), optionally with audits. */
async function finished(w, { b = brief(), audits = false, completed } = {}) {
  const r = await create(w, b);
  assert.equal(r.status, 201, r.text);
  const id = r.data.project.id, s = w.store(id), p = s.m.get('project');
  p.runs.forEach((run, i) => {
    const e = s.m.get('expert:' + run);
    e.int.phase = 'final';
    if (i < (completed ?? p.runs.length)) { e.run.status = 'completed'; e.run.opinion = opinion(e.run.expertId); if (audits) s.m.set('audit:' + run, { content: auditFor(e.run.expertId) }); }
    else { e.run.status = 'failed'; e.run.error = 'malformed result'; }
    s.m.set('expert:' + run, e);
  });
  p.status = 'completed'; p.finishedAt = Date.now();
  if (b.mode === 'live') { p.released = true; await w.env.CLOUDBITE.getByName('registry').registryRelease(id); }
  s.m.set('project', p);
  return { id, token: r.data.accessToken, auth: { authorization: 'Bearer ' + r.data.accessToken }, created: r.data.project };
}
const read = (w, x) => call(w, 'GET', '/api/cloudbite/projects/' + x.id, { headers: x.auth });
const memo = (w, x, opts = {}) => call(w, 'POST', `/api/cloudbite/projects/${x.id}/memo`, { headers: { ...x.auth, ...(opts.headers ?? {}) }, ...(opts.raw !== undefined ? { raw: opts.raw } : { body: opts.body ?? {} }) });
const review = (w, x) => call(w, 'POST', `/api/cloudbite/projects/${x.id}/review`, { headers: x.auth, body: {} });
/** Running live expert with a worker capability, as admission would leave it (no sandbox is contacted). */
async function running(w, b) {
  const r = await create(w, b);
  assert.equal(r.status, 201, r.text);
  const id = r.data.project.id, s = w.store(id), p = s.m.get('project'), caps = {};
  for (const run of p.runs) {
    const e = s.m.get('expert:' + run), tok = 'cbw_' + randomBytes(32).toString('base64url');
    e.int.phase = 'running'; e.run.status = 'running'; e.int.capHash = hash(tok); e.int.capExp = Date.now() + 3600_000;
    s.m.set('expert:' + run, e); caps[run] = tok;
  }
  s.m.set('project', { ...p, status: 'running' });
  const turn = (run) => w.obj(id).worker(run, caps[run], 'inference', { messages: [{ role: 'user', content: 'next turn' }] });
  return { id, runs: p.runs, caps, turn, s, token: r.data.accessToken };
}
async function visitor(w) {
  const r = await call(w, 'POST', '/api/cloudbite/access/requests', { body: { name: 'Visitor', purpose: 'try Cloudbite' }, headers: { 'cf-connecting-ip': '203.0.113.' + Math.floor(Math.random() * 250) } });
  assert.equal(r.status, 201, r.text);
  const v = { cookie: r.headers.get('set-cookie').split(';')[0], id: r.data.request.id };
  const ap = await call(w, 'POST', `/api/cloudbite/access/requests/${v.id}/approve`, { body: {}, headers: OWNER });
  assert.equal(ap.status, 200, ap.text);
  return v;
}

let passed = 0;
const test = async (name, fn) => { offset = 0; reset(); sleeps.length = 0; await fn(); passed++; console.log('ok', name); };

// ── preview and effective max ──
await test('preview: the create plan without reservation, sandbox, provider call or project write; same effective max as create', async () => {
  const w = world(), b = brief({ budget: { maxExperts: 2, maxModelCalls: 20, maxReviewCalls: 1, maxMemoCalls: 1 } });
  const r = await preview(w, b);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.data.expertIds, b.expertIds);
  assert.equal(r.data.assignments.length, 2); assert.ok(r.data.assignments.every((a, i) => a.expertId === b.expertIds[i] && a.source === 'manual-scope'));
  assert.deepEqual(r.data.budget, b.budget);
  assert.equal(r.data.envelope.sandboxMaximum, 2); assert.equal(r.data.envelope.jevCalls, 0, 'manual selection makes no Jev call');
  assert.ok(r.data.envelope.nosanaMaximum <= 20);
  assert.equal(N.calls.length, 0); assert.equal(P.calls.length, 0);
  assert.deepEqual(w.stored(), [], 'preview writes no project');
  assert.deepEqual((await w.env.CLOUDBITE.getByName('registry').ctx?.storage?.get?.('reg')) ?? {}, {}, 'no live slot');
  const reg = w.env.CLOUDBITE.records.get('registry');
  assert.ok(!reg || !reg.storage.m.size, 'registry untouched');
  // budget.maxExperts below the selection: preview and create refuse identically, before anything is written.
  const small = { ...b, expertIds: ROLES.slice(0, 3).map((x) => x.id) };
  const pv = await preview(w, small), cr = await create(w, small);
  assert.equal(pv.status, 400); assert.equal(cr.status, 400); assert.equal(pv.data.error, cr.data.error);
  assert.deepEqual(w.stored(), []);
  assert.equal((await call(w, 'POST', '/api/cloudbite/preview', { body: b })).status, 401, 'preview needs the same authority');
  assert.equal((await call(w, 'POST', '/api/cloudbite/preview', { body: b, headers: { ...OWNER, origin: 'https://evil.test' } })).status, 403);
  assert.equal((await call(w, 'GET', '/api/cloudbite/preview', { headers: OWNER })).status, 405);
  // Create with the same brief: the plan the preview showed is the plan stored.
  const c = await create(w, b);
  assert.equal(c.status, 201, c.text);
  assert.deepEqual(c.data.project.assignments, r.data.assignments);
  assert.equal(c.data.project.usage.jevCalls, 0); assert.equal(c.data.project.usage.sandboxMaximum, 2);
  assert.equal(c.data.project.usage.caps.maxModelCalls, 20);
});

await test('assignments: computed once at create, stored per run, public, and the workspace WORKORDER carries the actual assignment', async () => {
  const w = world(), b = brief({ stage: 'validation', responseLanguage: 'en' });
  const c = await create(w, b);
  assert.equal(c.status, 201, c.text);
  const s = w.store(c.data.project.id), p = s.m.get('project');
  assert.equal(p.ledger, 'v1'); assert.ok(s.m.get('budget'), 'separate ledger key');
  assert.deepEqual(p.assignments, c.data.project.assignments);
  for (const [i, run] of p.runs.entries()) {
    const e = s.m.get('expert:' + run), a = p.assignments[i];
    assert.deepEqual(e.run.assignment, a); assert.equal(a.stage, 'validation');
    const def = EXPERTS.find((x) => x.id === e.run.expertId);
    const files = w.obj(c.data.project.id).workspace(def, p.brief, e.run.assignment);
    const wo = files.find((f) => f.path === 'WORKORDER.md');
    assert.ok(wo && wo.content.includes(a.question), 'WORKORDER.md states the stored question');
    assert.ok(!files.some((f) => f.path === 'evidence/previous-round.json'), 'no previous round outside a follow-up');
  }
  const again = await create(w, b);
  assert.equal(again.status, 201); assert.deepEqual(again.data.project.assignments, c.data.project.assignments, 'a replay does not recompute');
  const pub = JSON.stringify(c.data);
  assert.ok(!/"account"|daytonaAccounts|capHash|DAYTONA-SECRET/.test(pub), 'no internal account or capability data');
});

// ── shared call ledger ──
await test('ledger: two roles racing for the last pooled call get exactly one; a failed call stays consumed; exhaustion is explicit', async () => {
  const w = world();
  const x = await running(w, brief({ budget: { maxExperts: 2, maxModelCalls: 3, maxReviewCalls: 0, maxMemoCalls: 0 } }));
  const [a, b] = x.runs;
  N.fail = true;
  const f = await x.turn(a);
  assert.equal(f.status, 502, JSON.stringify(f)); assert.equal(N.calls.length, 1);
  N.fail = false;
  assert.equal(x.s.m.get('budget').experts[a], 1, 'the failed call is not refunded'); assert.equal(x.s.m.get('budget').total, 1);
  assert.deepEqual(await x.turn(a), { content: 'turn reply' });
  N.hold = gate();
  const race = [x.turn(a), x.turn(b)];
  await new Promise((r) => setTimeout(r, 20));
  N.hold.resolve();
  const out = await Promise.all(race);
  const won = out.filter((o) => o.content === 'turn reply'), lost = out.filter((o) => o.status === 429);
  assert.equal(won.length, 1, JSON.stringify(out)); assert.equal(lost.length, 1); assert.match(lost[0].error, /pool|budget|exhausted|call/i);
  assert.equal(N.calls.length, 3, 'only the winning reservation reached the provider');
  const u = x.s.m.get('budget');
  assert.equal(u.total, 3); assert.equal(u.experts[a] + u.experts[b], 3);
  const next = await x.turn(b);
  assert.equal(next.status, 429); assert.equal(N.calls.length, 3, 'exhausted pool: no outbound call');
});

await test('ledger: an interleaved stale expert save cannot erase a reservation; the ledger count stays authoritative', async () => {
  const w = world();
  const x = await running(w, brief({ budget: { maxExperts: 2, maxModelCalls: 20, maxReviewCalls: 0, maxMemoCalls: 0 } }));
  const [a] = x.runs;
  const stale = structuredClone(x.s.m.get('expert:' + a));
  N.hold = gate();
  const pending = x.turn(a);
  await new Promise((r) => setTimeout(r, 20));
  // A concurrent activity callback (re-reads before writing) and an older copy written over the record.
  assert.deepEqual(await w.obj(x.id).worker(a, x.caps[a], 'activity', { kind: 'status', message: 'working' }), { ok: true });
  x.s.m.set('expert:' + a, { ...stale, int: { ...stale.int, calls: 0 } });
  N.hold.resolve();
  assert.deepEqual(await pending, { content: 'turn reply' });
  assert.equal(x.s.m.get('budget').experts[a], 1, 'reservation survives the stale save');
  assert.deepEqual(await x.turn(a), { content: 'turn reply' });
  assert.equal(x.s.m.get('budget').experts[a], 2); assert.equal(x.s.m.get('expert:' + a).int.calls, 2, 'next turn numbered from the ledger');
  // Per-role cap of CB_INFERENCE_MAX_CALLS still holds via the ledger even when int.calls was rolled back.
  const u = x.s.m.get('budget'); u.experts[a] = M.CB_INFERENCE_MAX_CALLS; u.total += M.CB_INFERENCE_MAX_CALLS - 2; x.s.m.set('budget', u);
  const e = x.s.m.get('expert:' + a); e.int.calls = 0; x.s.m.set('expert:' + a, e);
  const before = N.calls.length;
  assert.equal((await x.turn(a)).status, 429); assert.equal(N.calls.length, before);
});

await test('ledger: pre-budget projects migrate conservatively; a corrupt ledger of a v1 project fails closed', async () => {
  const w = world();
  const x = await running(w, brief());
  const [a, b] = x.runs;
  const p = x.s.m.get('project'); delete p.ledger; x.s.m.set('project', p); x.s.m.delete('budget');
  const ea = x.s.m.get('expert:' + a); ea.int.calls = M.CB_INFERENCE_MAX_CALLS; x.s.m.set('expert:' + a, ea);
  const eb = x.s.m.get('expert:' + b); eb.int.calls = 'garbage'; x.s.m.set('expert:' + b, eb);
  const view = await read(w, { id: x.id, auth: { authorization: 'Bearer ' + x.token } });
  assert.equal(view.status, 200, view.text);
  assert.equal(view.data.usage.migrated, true);
  assert.equal(view.data.usage.perExpert[a], M.CB_INFERENCE_MAX_CALLS); assert.equal(view.data.usage.perExpert[b], M.CB_INFERENCE_MAX_CALLS, 'unreadable count = full cap');
  assert.equal((await x.turn(a)).status, 429); assert.equal(N.calls.length, 0);
  const y = await running(w, brief());
  y.s.m.set('budget', { version: 'cloudbite-budget/v1', caps: 'corrupt' });
  const r = await y.turn(y.runs[0]);
  assert.equal(r.status, 429); assert.match(r.error, /budget|ledger|usage/i); assert.equal(N.calls.length, 0, 'fails closed without a call');
});

await test('ledger: review and memo calls share the project total; a zero earmark refuses with no claim and no call', async () => {
  const w = world();
  const x = await finished(w, { b: brief({ budget: { maxExperts: 2, maxModelCalls: 4, maxReviewCalls: 0, maxMemoCalls: 0 } }) });
  const r = await review(w, x);
  assert.equal(r.status, 429, r.text); assert.equal(N.calls.length, 0); assert.equal(w.store(x.id).m.has('cross-review'), false, 'no claim');
  const m = await memo(w, x);
  assert.equal(m.status, 429, m.text); assert.match(m.data.error, /budget/i); assert.equal(N.calls.length, 0); assert.equal(w.store(x.id).m.has('memo'), false);
  const y = await finished(w, { b: brief({ budget: { maxExperts: 2, maxModelCalls: 6, maxReviewCalls: 1, maxMemoCalls: 1 } }) });
  N.memoIds = y.created.brief.expertIds;
  assert.equal((await review(w, y)).status, 200);
  assert.equal((await memo(w, y)).status, 200);
  const u = w.store(y.id).m.get('budget');
  assert.equal(u.reviewers.length, 1); assert.equal(u.memo, 1); assert.equal(u.total, 2, 'one ledger counts every server-side call');
  const pub = (await read(w, y)).data.usage;
  assert.equal(pub.review.exhausted, true); assert.equal(pub.memo.exhausted, true); assert.equal(pub.jevCalls, 0); assert.equal(pub.sandboxMaximum, 2);
});

// ── evidence packets ──
await test('evidence: collected audits become real peer packets for cross-review; legacy records show unobserved retrieval', async () => {
  const w = world();
  const x = await finished(w, { b: brief({ expertIds: ROLES.slice(0, 3).map((r) => r.id) }), audits: true });
  const r = await review(w, x);
  assert.equal(r.status, 200, r.text);
  assert.ok(N.calls.length >= 1);
  for (const c of N.calls) {
    const body = c.req.messages[1].content, data = JSON.parse(body.replace(/^[^\n]*\n/, ''));
    const peers = data.peers.map((p) => p.expertId);
    assert.deepEqual(data.peerEvidence.map((x) => x.expertId), peers, 'one application-built packet per peer');
    for (const x of data.peerEvidence) {
      assert.equal(x.binding, 'bound'); assert.match(x.packetSha256, /^[0-9a-f]{64}$/);
      assert.deepEqual(x.cards.map((k) => k.id), [M.phaseOnePack(x.expertId).cards[0].id], 'the card the audit observed');
    }
    assert.ok(!data.peerEvidence.some((x) => x.expertId === data.reviewerExpertId), 'never its own packet');
  }
  const legacy = await finished(w, { b: brief({ expertIds: ROLES.slice(0, 2).map((r) => r.id) }) });
  const v = (await read(w, legacy)).data;
  assert.equal(v.evidencePackets, undefined);
  assert.equal(v.evidenceSignals.packetCoverage.supplied, false);
  assert.ok(v.evidenceSignals.experts.every((e) => e.observedRetrieval === null), 'no audit: retrieval unobserved, not invented');
});

// ── decision memo ──
await test('memo: one paid claim persisted before the call, fixed max_tokens, strict parse, cached result, no retry', async () => {
  const w = world(), x = await finished(w);
  N.memoIds = x.created.brief.expertIds;
  N.hold = gate();
  const first = memo(w, x);
  await new Promise((r) => setTimeout(r, 20));
  const st = w.store(x.id).m.get('memo');
  assert.equal(st.memo.status, 'running'); assert.match(st.claim, /^[0-9a-f-]{36}$/); assert.equal(st.memo.attempts, 1);
  assert.equal(w.store(x.id).m.get('budget').memo, 1, 'reserved inside the claim');
  const second = await memo(w, x);
  assert.equal(second.status, 409, 'a running memo is not started twice');
  N.hold.resolve();
  const r = await first;
  assert.equal(r.status, 200, r.text);
  assert.equal(N.calls.length, 1); assert.equal(N.calls[0].req.max_tokens, 8192);
  assert.equal(r.data.memo.status, 'completed'); assert.equal(r.data.memo.memo.recommendation.optionIds[0], 'option-1');
  assert.equal((await memo(w, x)).data.memo.status, 'completed'); assert.equal(N.calls.length, 1, 'cached');
  const bad = await finished(w);
  N.reply = () => 'not json';
  const b = await memo(w, bad);
  assert.equal(b.status, 200); assert.equal(b.data.memo.status, 'failed'); assert.match(b.data.memo.error, /JSON/);
  assert.equal((await memo(w, bad)).data.memo.status, 'failed'); assert.equal(N.calls.length, 2, 'a failed attempt is never retried');
  assert.equal((await memo(w, bad, { body: { force: true } })).status, 400, 'no options in the body');
  assert.equal((await memo(w, bad, { headers: { origin: 'https://evil.test' } })).status, 403);
  assert.equal((await call(w, 'GET', `/api/cloudbite/projects/${bad.id}/memo`, { headers: bad.auth })).status, 405);
});

await test('memo: every sealed source reaches the leaf cap with exact counts; repeats are one source, alike-slugging IDs never merge', async () => {
  const w = world(), x = await finished(w);
  const ids = x.created.brief.expertIds; N.memoIds = ids;
  const src = (id) => ({ id, title: `Title ${id}`, url: `https://example.org/${encodeURIComponent(id)}`, license: 'CC-BY', checkStatus: 'unchecked', checkedAt: '', originalText: 'not-fetched' });
  const sealed = (expertId, list, omittedSources = 0) => ({ expertId, binding: 'bound', bindingNote: '', pack: null, observed: { retrievals: 1, cardIds: [], sourceIds: list },
    cards: [], references: [], originalSourceTextFetched: false, auditNotes: [], bytes: 0, sources: list.map(src), sha256: hash(expertId + list.join()),
    omitted: { cards: 0, sources: omittedSources, references: 0, observedIds: 0, unidentifiedIds: 0, truncatedSummaries: 0 } });
  const range = (p) => Array.from({ length: 12 }, (_, i) => `${p}-${i}`);
  const long = 'L'.repeat(79);
  // 3 x 12 distinct + 3 IDs slugging to src-coll-x + 2 IDs equal for the first 64 characters + 1 repeat of a-0
  const packets = [sealed(ids[0], ['Coll_X', 'coll-x', 'COLL.X', long + 'a', long + 'b', ...range('pmc-a')]),
    sealed(ids[1 % ids.length], [...range('pmc-b'), 'pmc-a-0']), sealed(ids[0], range('pmc-c'), 5)];
  w.store(x.id).m.set('packets', packets);
  const r = await memo(w, x);
  assert.equal(r.status, 200, r.text); assert.equal(r.data.memo.status, 'completed', r.text);
  const data = JSON.parse(N.calls[0].req.messages[1].content.replace(/^[^\n]*\n/, ''));
  // 41 distinct sources + 1 disclosure of the sealed packet's own omissions; the leaf keeps 24 and counts the rest
  assert.deepEqual(data.coverage.packets, { included: 24, total: 42, truncated: 0, omitted: 18, invalid: 0, metadataOnly: 24 });
  assert.deepEqual(r.data.memo.coverage.packets, data.coverage.packets, 'stored coverage equals what the model was told');
  assert.equal(data.coverage.sourcePagesReviewed, false);
  const pk = data.packets, pid = pk.map((p) => p.id);
  assert.equal(new Set(pid).size, pid.length, 'unique packet IDs');
  assert.match(pk[0].id, /^omit-/); assert.match(pk[0].label, /^5 observed source/);
  assert.match(pk[0].originMetadata, new RegExp(`sha256 ${hash(ids[0] + range('pmc-c').join())}; omitted\\.sources=5`));
  const coll = pk.filter((p) => /^Title (Coll_X|coll-x|COLL\.X)$/.test(p.label));
  assert.equal(coll.length, 3, 'three source identities, three packets'); assert.ok(coll.some((p) => p.id === 'src-coll-x'));
  assert.equal(pk.filter((p) => p.label.startsWith('Title ' + long)).length, 2, 'IDs equal up to the slug length stay apart');
  assert.ok(pid.every((id) => /^[a-z0-9][a-z0-9-]{0,63}$/.test(id)));
  assert.ok(pk.every((p) => p.originalText === 'absent' && /original text not fetched/.test(p.originMetadata) && p.excerpt === undefined));
});

await test('memo: a rough brief gets an unadopted coaching proposal in one memo call; demo projects refuse', async () => {
  const w = world(), x = await finished(w, { b: brief({ decision: undefined }) });
  N.memoIds = x.created.brief.expertIds;
  N.reply = (kind) => {
    assert.equal(kind, 'memo');
    const reply = JSON.parse(memoReply(N.memoIds));
    reply.recommendation = { status: 'no-recommendation', optionIds: [], rationale: 'No user-supplied options to compare; the coaching plan proposes a next step.', expertIds: [N.memoIds[0]], refs: ['brief:objective'] };
    reply.options = [];
    return JSON.stringify(reply);
  };
  const originalBrief = structuredClone(w.store(x.id).m.get('project').brief);
  const r = await memo(w, x);
  assert.equal(r.status, 200, r.text); assert.equal(r.data.memo.status, 'completed'); assert.equal(N.calls.length, 1);
  assert.equal(r.data.memo.memo.coaching.version, 'cloudbite-coaching/v1');
  assert.equal(r.data.memo.memo.coaching.repairs[0].kind, 'unknown');
  assert.deepEqual(r.data.memo.memo.recommendation.optionIds, []);
  assert.deepEqual(r.data.memo.memo.comparison, []);
  assert.deepEqual(w.store(x.id).m.get('project').brief, originalBrief, 'proposal never rewrites the brief');
  assert.equal(w.store(x.id).m.get('budget').memo, 1, 'one existing memo reservation');
  assert.equal((await memo(w, x)).data.memo.status, 'completed');
  assert.equal(N.calls.length, 1, 'completed coaching is cached, never rerun');
  const d = await finished(w, { b: brief({ mode: 'demo' }) });
  assert.equal((await memo(w, d)).status, 409); assert.equal(N.calls.length, 1);
});

await test('memo: missing or malformed required coaching fails the single attempt without automatic retry', async () => {
  for (const bad of [undefined, { version: 'cloudbite-coaching/v1', stance: 'cheerlead' }]) {
    const w = world(), x = await finished(w);
    N.memoIds = x.created.brief.expertIds;
    N.reply = () => { const raw = JSON.parse(memoReply(N.memoIds)); if (bad === undefined) delete raw.coaching; else raw.coaching = bad; return JSON.stringify(raw); };
    const start = N.calls.length;
    const r = await memo(w, x);
    assert.equal(r.status, 200); assert.equal(r.data.memo.status, 'failed');
    assert.equal((await memo(w, x)).data.memo.status, 'failed');
    assert.equal(N.calls.length - start, 1, 'malformed advice does not trigger hidden retries');
    assert.equal(w.store(x.id).m.get('budget').memo, 1);
  }
});

await test('memo: a delete during the call or a superseded claim discards the late result', async () => {
  const w = world(), x = await finished(w);
  N.memoIds = x.created.brief.expertIds; N.hold = gate();
  const pending = memo(w, x);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal((await call(w, 'DELETE', '/api/cloudbite/history/' + x.id, { headers: OWNER })).status, 200);
  N.hold.resolve();
  const r = await pending;
  assert.equal(r.status, 410, r.text);
  assert.equal(w.store(x.id).m.has('memo'), false, 'no late write after delete');
  assert.ok(!JSON.stringify([...w.store(x.id).m.values()]).includes('first option is favoured'));
  const y = await finished(w);
  N.memoIds = y.created.brief.expertIds; N.hold = gate();
  const p2 = memo(w, y);
  await new Promise((r) => setTimeout(r, 20));
  const st = w.store(y.id).m.get('memo'); st.claim = 'someone-else'; w.store(y.id).m.set('memo', st);
  N.hold.resolve();
  const r2 = await p2;
  assert.equal(r2.status, 409, r2.text); assert.equal(w.store(y.id).m.get('memo').memo.status, 'running', 'the other claim is untouched');
  // A stale running claim is settled as failed on read, never rerun.
  offset += 10 * 60_000;
  const v = await read(w, y);
  assert.equal(v.data.memo.status, 'failed'); assert.equal(N.calls.length, 2);
});

await test('v7 memo: collected generated artifacts reach the real DO prompt, and an altered tail discards the paid result', async () => {
  const w = world(), x = await finished(w);
  N.memoIds = x.created.brief.expertIds;
  const store = w.store(x.id), run = store.m.get('project').runs[0], record = store.m.get('expert:' + run);
  const content = 'Generated proposed ECO check, not execution proof. '.repeat(150);
  record.run.artifacts = [{ path: 'out/report.md', label: 'Expert report', bytes: Buffer.byteLength(content) },
    { path: 'out/analysis.csv', label: 'Missing file', bytes: 30 }];
  store.m.set('expert:' + run, record); store.m.set(`artifact:${run}:out/report.md`, content);
  N.hold = gate(); const pending = memo(w, x);
  await new Promise(r => setTimeout(r, 20));
  assert.equal(N.calls.length, 1);
  const data = JSON.parse(N.calls[0].req.messages[1].content.replace(/^[^\n]*\n/, ''));
  const artifact = data.packets.find(p => p.kind === 'expert-artifact-excerpt');
  assert.ok(artifact); assert.equal(artifact.expertId, record.run.expertId);
  assert.match(artifact.excerpt, /proposed ECO/); assert.match(artifact.originMetadata, /sha256=/);
  assert.equal(data.coverage.fullReportsReviewed, false);
  assert.ok(data.packets.some(p => /selected but unavailable: 1/.test(p.label)));
  assert.match(N.calls[0].req.messages[0].content, /not independent sources or proof that a tool ran/);
  store.m.set(`artifact:${run}:out/report.md`, content + ' changed outside the excerpt');
  N.hold.resolve(); const result = await pending;
  assert.equal(result.status, 200, result.text); assert.equal(result.data.memo.status, 'failed');
  assert.match(result.data.memo.error, /inputs changed/);
  assert.equal(N.calls.length, 1); assert.equal(store.m.get('budget').memo, 1);
  assert.equal((await memo(w, x)).data.memo.status, 'failed'); assert.equal(N.calls.length, 1);
  const y = await finished(w); N.memoIds = y.created.brief.expertIds; N.hold = null;
  const sy = w.store(y.id), ry = sy.m.get('project').runs[0], ey = sy.m.get('expert:' + ry);
  ey.run.artifacts = [{ path: 'out/report.md', label: 'Expert report', bytes: 40 }]; sy.m.set('expert:' + ry, ey);
  sy.m.set(`artifact:${ry}:out/report.md`, 'Generated proposed runtime measurement.');
  const accepted = await memo(w, y);
  assert.equal(accepted.status, 200, accepted.text); assert.equal(accepted.data.memo.status, 'completed');
});

// ── follow-up rounds ──
await test('revision: a new project bound to the reading actor\'s parent; replay keeps the original snapshot; deleted or foreign parents fail before create', async () => {
  const w = world(), parent = await finished(w);
  const b = brief({ revision: { parentId: parent.id, changeSummary: 'Narrowed to the vendor plan.' } });
  const parentBefore = JSON.stringify([...w.store(parent.id).m.entries()]);
  const c = await create(w, b);
  assert.equal(c.status, 201, c.text);
  assert.notEqual(c.data.project.id, parent.id, 'a revision is a new project');
  assert.equal(JSON.stringify([...w.store(parent.id).m.entries()]), parentBefore, 'parent unchanged');
  const round = w.store(c.data.project.id).m.get('round');
  assert.ok(JSON.stringify(round).includes(parent.id));
  assert.ok(c.data.project.previousRound, 'public previous-round reference');
  const p = w.store(c.data.project.id).m.get('project'), e = w.store(c.data.project.id).m.get('expert:' + p.runs[0]);
  const files = w.obj(c.data.project.id).workspace(EXPERTS.find((x) => x.id === e.run.expertId), p.brief, e.run.assignment, round);
  assert.ok(files.some((f) => f.path === 'evidence/previous-round.json'), 'workspace gets the previous round');
  assert.match(files.find((f) => f.path === 'WORKORDER.md').content, /Previous round/);
  // Delete the parent: the existing follow-up replays with its own copy; a new follow-up of it fails before anything.
  assert.equal((await call(w, 'DELETE', '/api/cloudbite/history/' + parent.id, { headers: OWNER })).status, 200);
  const replay = await create(w, b);
  assert.equal(replay.status, 201, replay.text); assert.equal(replay.data.project.id, c.data.project.id);
  assert.deepEqual(w.store(c.data.project.id).m.get('round'), round, 'replay binds the same original snapshot');
  const before = w.stored().length, regBefore = JSON.stringify([...(w.store('registry')?.m ?? new Map())]);
  const gone = await create(w, brief({ revision: { parentId: parent.id, changeSummary: 'again' } }));
  assert.equal(gone.status, 404, gone.text); assert.equal(w.stored().length, before, 'no project'); assert.equal(JSON.stringify([...(w.store('registry')?.m ?? new Map())]), regBefore, 'no live slot');
  assert.equal((await preview(w, brief({ revision: { parentId: parent.id, changeSummary: 'again' } }))).status, 404);
  assert.equal((await create(w, brief({ revision: { parentId: 'cb' + '0'.repeat(32), changeSummary: 'x' } }))).status, 404);
  // Visitor: another tenant's parent is not found, and no visitor slot is taken.
  const v1 = await visitor(w), v2 = await visitor(w);
  const own = await create(w, brief({ mode: 'demo' }), { cookie: v1.cookie });
  assert.equal(own.status, 201, own.text);
  const ps = w.store(own.data.project.id), pp = ps.m.get('project'); pp.status = 'completed'; pp.finishedAt = Date.now(); ps.m.set('project', pp);
  const status = async (v) => (await call(w, 'GET', '/api/cloudbite/access/status', { headers: { cookie: v.cookie } })).data.request.usedProjects;
  const used2 = await status(v2);
  const foreign = await create(w, brief({ mode: 'demo', revision: { parentId: own.data.project.id, changeSummary: 'mine now' } }), { cookie: v2.cookie });
  assert.equal(foreign.status, 404, foreign.text); assert.equal(await status(v2), used2, 'no slot taken');
  const mine = await create(w, brief({ mode: 'demo', revision: { parentId: own.data.project.id, changeSummary: 'next round' } }), { cookie: v1.cookie });
  assert.equal(mine.status, 201, mine.text);
});

// ── PMC import ──
await test('PMC import: owner or approved visitor only, POST with {identifier}, fixed host, no credentials, global pacing, hourly limit', async () => {
  const w = world();
  const pmc = (body, headers = OWNER, method = 'POST') => call(w, method, '/api/cloudbite/pmc/import', { headers, ...(method === 'POST' ? { body } : {}) });
  assert.equal((await pmc({ identifier: 'PMC123456' }, {})).status, 401); assert.equal(P.calls.length, 0, 'unauthenticated: no fetch');
  assert.equal((await pmc(undefined, OWNER, 'GET')).status, 405);
  assert.equal((await pmc({ identifier: 'PMC123456' }, { ...OWNER, origin: 'https://evil.test' })).status, 403);
  assert.equal((await pmc({ identifier: 'PMC123456', url: 'https://x' })).status, 400);
  const url = await pmc({ identifier: 'https://evil.test/PMC1' });
  assert.equal(url.status, 400); assert.equal(url.data.error, 'invalid_identifier'); assert.equal(typeof url.data.message, 'string'); assert.equal(P.calls.length, 0);
  const r = await pmc({ identifier: 'PMC123456' }, { ...OWNER, cookie: 'cb_session=SECRET-COOKIE', authorization: 'Bearer SECRET' });
  assert.ok(r.status >= 400 && r.data.error === 'not_found', r.text);
  assert.equal(P.calls.length, 1);
  assert.equal(P.calls[0].headers.get('cookie'), null); assert.equal(P.calls[0].headers.get('authorization'), null);
  assert.ok(!P.calls[0].url.includes(TOKEN));
  await pmc({ identifier: 'PMC123457' });
  assert.equal(P.calls.length, 2); assert.ok(sleeps.length >= 1 && sleeps.every((ms) => ms > 0), 'second import waited for the global spacing');
  assert.ok(P.calls[1].at - P.calls[0].at >= 300, 'spaced NCBI requests');
  const st = w.store('pmc-import').m.get('pmc'); assert.equal(st.busy, undefined, 'lease released');
  for (let i = 2; i < 10; i++) await pmc({ identifier: 'PMC12345' + i });
  const limited = await pmc({ identifier: 'PMC999999' });
  assert.equal(limited.status, 429); assert.equal(limited.data.error, 'rate_limited'); assert.equal(limited.data.reason, 'hourly_limit'); assert.ok(Number(limited.headers.get('retry-after')) > 0);
  assert.equal(P.calls.length, 10);
  // One import at a time: an unexpired lease answers busy without a fetch.
  const s = w.store('pmc-import').m, held = s.get('pmc'); held.busy = { claim: 'other', until: Date.now() + 60_000 }; held.calls = {}; s.set('pmc', held);
  const busy = await pmc({ identifier: 'PMC111111' });
  assert.equal(busy.status, 429); assert.equal(busy.data.error, 'rate_limited'); assert.equal(busy.data.reason, 'busy'); assert.equal(P.calls.length, 10);
  // Approved visitor: own hourly bucket.
  delete held.busy; s.set('pmc', held);
  const v = await visitor(w);
  const vr = await pmc({ identifier: 'PMC222222' }, { cookie: v.cookie });
  assert.ok(vr.data?.error === 'not_found', vr.text); assert.notEqual(vr.status, 401); assert.equal(P.calls.length, 11);
  assert.ok(Object.keys(s.get('pmc').calls).some((k) => k.startsWith('v_')), 'visitor counted under its own actor');
});

await test('PMC import: typed failures use the console contract {error: code, message, retryAfterSeconds?} with Retry-After; refusals stay generic', async () => {
  const w = world();
  const pmc = (body, headers = OWNER) => call(w, 'POST', '/api/cloudbite/pmc/import', { headers, body });
  const PMC_ERRORS = ['invalid_identifier', 'not_found', 'identity_mismatch', 'source_unavailable', 'rate_limited', 'timeout', 'too_large', 'redirect_blocked', 'invalid_xml', 'upstream_error'];
  // Refusals before any external call keep the generic {error} shape and fetch nothing.
  for (const [r, status] of [[await pmc({ identifier: 'PMC123456' }, {}), 401], [await pmc({ identifier: 'PMC123456' }, { ...OWNER, origin: 'https://evil.test' }), 403],
    [await call(w, 'GET', '/api/cloudbite/pmc/import', { headers: OWNER }), 405]]) {
    assert.equal(r.status, status, r.text); assert.deepEqual(Object.keys(r.data), ['error']); assert.ok(!PMC_ERRORS.includes(r.data.error));
  }
  assert.equal(P.calls.length, 0, 'unauthorized: no PMC fetch'); assert.equal(N.calls.length, 0, 'unauthorized: no provider call');
  const bad = await pmc({ identifier: '10.1000/<script>' });
  assert.equal(bad.status, 400); assert.equal(bad.data.error, 'invalid_identifier'); assert.equal(P.calls.length, 0, 'bad identifier: no external fetch');
  // 422: the actual leaf failure code and its bounded message; no Retry-After.
  P.reply = () => new Response(`<?xml version="1.0"?><OAI-PMH xmlns="http://www.openarchives.org/OAI/2.0/"><responseDate>x</responseDate><request>x</request><error code="cannotDisseminateFormat">UPSTREAM-BODY-TEXT</error></OAI-PMH>`, { status: 200, headers: { 'content-type': 'application/xml' } });
  const una = await pmc({ identifier: 'PMC123456' });
  assert.equal(una.status, 422, una.text); assert.equal(una.data.error, 'source_unavailable'); assert.match(una.data.message, /reusable full text/);
  assert.equal(una.data.retryAfterSeconds, undefined); assert.equal(una.headers.get('retry-after'), null); assert.ok(!una.text.includes('UPSTREAM-BODY-TEXT'), 'upstream body not reflected');
  assert.equal(una.data.code, undefined, 'no second machine-code field');
  // 429 service guard: rate_limited with the actual cause in reason, retryAfterSeconds in the body and the header.
  const s = w.store('pmc-import').m, held = s.get('pmc');
  held.busy = { claim: 'other', until: Date.now() + 30_000 }; s.set('pmc', held);
  const before = P.calls.length, busy = await pmc({ identifier: 'PMC111111' });
  assert.equal(busy.status, 429); assert.equal(busy.data.error, 'rate_limited'); assert.equal(busy.data.reason, 'busy'); assert.equal(typeof busy.data.message, 'string');
  assert.ok(Number.isInteger(busy.data.retryAfterSeconds) && busy.data.retryAfterSeconds >= 1 && busy.data.retryAfterSeconds <= 30);
  assert.equal(busy.headers.get('retry-after'), String(busy.data.retryAfterSeconds)); assert.equal(P.calls.length, before, 'busy: no fetch');
  delete held.busy; held.calls = { owner: Array.from({ length: 10 }, () => Date.now() - 60_000) }; s.set('pmc', held);
  const hourly = await pmc({ identifier: 'PMC111112' });
  assert.equal(hourly.status, 429); assert.equal(hourly.data.error, 'rate_limited'); assert.equal(hourly.data.reason, 'hourly_limit');
  assert.ok(hourly.data.retryAfterSeconds > 3000 && hourly.data.retryAfterSeconds <= 3600); assert.equal(hourly.headers.get('retry-after'), String(hourly.data.retryAfterSeconds));
  assert.equal(P.calls.length, before, 'hourly limit: no fetch');
  for (const r of [bad, una, busy, hourly]) assert.ok(PMC_ERRORS.includes(r.data.error), r.text);
});

// ── cross-review language ──
const longEn = 'The reviewer read the cited evidence item against the stated summary and found the reasoning consistent with the plan, the constraints and the success criteria.';
const longKo = '검토자는 인용된 근거 항목을 요약과 대조해 읽었고, 계획과 제약 조건 및 성공 기준에 비추어 추론이 일관된다고 판단했습니다.';
const reviewIn = (rationale, summary) => (kind, req) => {
  if (kind !== 'review') return 'turn reply';
  const data = JSON.parse(req.messages[1].content.replace(/^[^\n]*\n/, ''));
  return JSON.stringify({ summary, findings: data.peers.map((p) => ({ targetExpertId: p.expertId, evidenceIndex: 0, verdict: 'supported', rationale, claimSupport: { status: 'insufficient', quotes: [], rationale } })) });
};
await test('cross-review: replies are checked against the brief\'s response language; one paid attempt, opinions preserved', async () => {
  const w = world(), ko = '파일럿 계획을 진행해야 할까요?';
  const x = await finished(w, { b: brief({ objective: ko }) });
  const opinionsBefore = JSON.stringify((await read(w, x)).data.experts.map((r) => r.opinion));
  N.reply = reviewIn(longEn, 'An English review summary of the opinions that were assigned to this reviewer.');
  const r = await review(w, x);
  assert.equal(r.status, 200, r.text); assert.equal(r.data.crossReview.status, 'failed');
  assert.match(r.data.crossReview.error, /not written in the selected language \(ko\)/); assert.ok(!r.data.crossReview.error.includes('reasoning consistent'), 'reply text not echoed');
  const calls = N.calls.length;
  assert.ok(calls >= 1);
  assert.equal((await review(w, x)).data.crossReview.status, 'failed'); assert.equal(N.calls.length, calls, 'no second paid attempt');
  assert.equal(JSON.stringify((await read(w, x)).data.experts.map((r) => r.opinion)), opinionsBefore, 'expert opinions preserved');
  // Selected English on a Korean objective: English replies pass.
  const en = await finished(w, { b: brief({ objective: ko, responseLanguage: 'en' }) });
  const e = await review(w, en);
  assert.equal(e.status, 200, e.text); assert.equal(e.data.crossReview.status, 'completed', e.text);
  // Korean narrative with a quoted English source original is accepted.
  const k = await finished(w, { b: brief({ objective: ko }) });
  N.reply = reviewIn(longKo + ' 출처 원문 "The vendor quote covers support for twelve months with a fixed price and agreed service level terms" 을 그대로 인용했습니다.', '배정된 의견들을 근거와 대조해 검토한 요약입니다.');
  const q = await review(w, k);
  assert.equal(q.status, 200, q.text); assert.equal(q.data.crossReview.status, 'completed', q.text);
});

// ── memo / cross-review mutual exclusion ──
const tick = () => new Promise((r) => setTimeout(r, 20));
await test('race: a running memo blocks starting a cross-review (409 before reservation or call); afterwards the review runs', async () => {
  const w = world(), x = await finished(w);
  N.memoIds = x.created.brief.expertIds; N.hold = gate();
  const m = memo(w, x);
  await tick();
  const budget = JSON.stringify(w.store(x.id).m.get('budget'));
  const r = await review(w, x);
  assert.equal(r.status, 409, r.text); assert.match(r.data.error, /decision memo is running/);
  assert.equal(w.store(x.id).m.has('cross-review'), false, 'no review claim'); assert.equal(JSON.stringify(w.store(x.id).m.get('budget')), budget, 'nothing reserved');
  assert.equal(N.calls.length, 1, 'only the memo call');
  N.hold.resolve(); N.hold = null;
  const done = await m;
  assert.equal(done.status, 200, done.text); assert.equal(done.data.memo.status, 'completed', 'the single paid memo is kept');
  const after = await review(w, x);
  assert.equal(after.status, 200, after.text); assert.equal(after.data.crossReview.status, 'completed');
  assert.equal(after.data.memo.status, 'completed', 'a finished memo stays readable');
});

await test('race: a running cross-review blocks starting a memo (409 before reservation or call); afterwards the memo runs', async () => {
  const w = world(), x = await finished(w);
  N.memoIds = x.created.brief.expertIds; N.hold = gate();
  const r = review(w, x);
  await tick();
  const calls = N.calls.length, budget = JSON.stringify(w.store(x.id).m.get('budget'));
  assert.ok(calls >= 1);
  const m = await memo(w, x);
  assert.equal(m.status, 409, m.text); assert.match(m.data.error, /cross-review is running/);
  assert.equal(w.store(x.id).m.has('memo'), false, 'no memo claim'); assert.equal(JSON.stringify(w.store(x.id).m.get('budget')), budget, 'nothing reserved');
  assert.equal(N.calls.length, calls, 'no memo call');
  N.hold.resolve(); N.hold = null;
  assert.equal((await r).data.crossReview.status, 'completed');
  const after = await memo(w, x);
  assert.equal(after.status, 200, after.text); assert.equal(after.data.memo.status, 'completed', 'memo inputs now include the finished review');
  assert.equal(N.calls.filter((c) => c.kind === 'memo').length, 1);
  // A stale running claim of the other operation does not block forever once it is past its window.
  const y = await finished(w);
  N.memoIds = y.created.brief.expertIds; N.hold = gate();
  const stuck = review(w, y);
  await tick();
  offset += 60 * 60_000;
  const late = memo(w, y);
  await tick();
  assert.equal(w.store(y.id).m.get('memo')?.memo.status, 'running', 'a stale review no longer blocks the memo claim');
  N.hold.resolve(); N.hold = null;
  assert.notEqual((await late).status, 409);
  await stuck;
});

// ── history ──
await test('history: detail carries the new fields; delete clears memo, packets, round, assignments, revision and audits but keeps the budget', async () => {
  const w = world(), parent = await finished(w);
  const x = await finished(w, { b: brief({ revision: { parentId: parent.id, changeSummary: 'Second round.' } }), audits: true });
  N.memoIds = x.created.brief.expertIds;
  const s = w.store(x.id);
  // finalize() seals the packets with the terminal transition (no sandbox is left to clean up here).
  const p = s.m.get('project'); p.status = 'running'; s.m.set('project', p);
  await w.obj(x.id).alarm();
  assert.equal(s.m.get('project').status, 'completed');
  const sealed = s.m.get('packets');
  assert.deepEqual(sealed.map((k) => k.expertId), x.created.brief.expertIds, 'finalize seals the packets with the terminal status');
  assert.equal((await read(w, x)).data.evidencePackets.length, 2);
  assert.equal((await review(w, x)).status, 200);
  assert.equal((await memo(w, x)).status, 200);
  const h = await call(w, 'GET', '/api/cloudbite/history/' + x.id, { headers: OWNER });
  assert.equal(h.status, 200, h.text);
  assert.ok(h.data.project.assignments?.length === 2); assert.equal(h.data.project.memo.status, 'completed');
  assert.ok(h.data.project.previousRound); assert.ok(h.data.project.usage);
  const del = await call(w, 'DELETE', '/api/cloudbite/history/' + x.id, { headers: OWNER });
  assert.equal(del.status, 200, del.text);
  for (const k of ['memo', 'round', 'packets', 'cross-review']) assert.equal(s.m.has(k), false, k);
  assert.ok(![...s.m.keys()].some((k) => k.startsWith('audit:') || k.startsWith('artifact:')));
  const q = s.m.get('project');
  assert.equal(q.assignments, undefined); assert.equal(q.brief.revision, undefined);
  assert.ok(q.runs.every((run) => s.m.get('expert:' + run).run.assignment === undefined));
  assert.ok(s.m.get('budget'), 'budget ledger is kept');
  const after = await read(w, x);
  assert.equal(after.status, 200);
  assert.equal(after.data.memo, undefined); assert.equal(after.data.previousRound, undefined); assert.equal(after.data.evidencePackets, undefined);
  assert.equal((await memo(w, x)).status, 409, 'no memo on deleted content'); assert.equal((await review(w, x)).status, 409);
});

console.log(`cloudbite backend v2: ${passed} integration checks passed (no provider network)`);
