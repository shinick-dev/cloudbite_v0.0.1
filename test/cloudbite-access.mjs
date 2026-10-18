// Cloudbite audience access (docs/cloudbite/access-service.txt) through the REAL Worker router, the REAL CloudbiteAccess
// and CloudbiteProject DOs (memory storage that yields on every call, actual catalogue). STATE is a recorder that only
// knows one legacy admin session. No network: global fetch counts and throws; alarms are never run.
//   node test/cloudbite-access.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { build } from 'esbuild';

const stubs = { name: 'stubs', setup(b) {
  b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'cf', namespace: 'stub' }));
  b.onLoad({ filter: /^cf$/, namespace: 'stub' }, () => ({ contents: 'export class DurableObject { constructor(ctx,env){this.ctx=ctx;this.env=env;} }' }));
} };
const entry = `export { default, CloudbiteProject, CloudbiteAccess } from './src/index.ts'; export { CLOUDBITE_EXPERTS } from './src/cloudbite-personas.ts';`;
const tmp = mkdtempSync(join(tmpdir(), 'cloudbite-access-'));
const bundle = await build({ stdin: { contents: entry, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, format: 'esm', platform: 'node', plugins: [stubs], loader: { '.ps1': 'text' } });
writeFileSync(join(tmp, 'm.mjs'), bundle.outputFiles[0].text);
const M = await import(pathToFileURL(join(tmp, 'm.mjs')));
let fetches = 0;
globalThis.fetch = async (u) => { fetches++; throw new Error('network forbidden in this test: ' + u); };

let count = 0;
const check = async (name, f) => { await f(); count++; console.log('ok', name); };
const sha = (s) => createHash('sha256').update(s).digest('hex');
const OPERATOR = 'cbo_' + randomBytes(32).toString('base64url');
const ADMIN = 'legacy-admin-session-value';
const MIN = 60_000, HOUR = 60 * MIN;

function memStorage() {
  const m = new Map(); const clone = (v) => (v === undefined ? undefined : structuredClone(v));
  return {
    m,
    async get(k) { await null; return Array.isArray(k) ? new Map(k.filter((x) => m.has(x)).map((x) => [x, clone(m.get(x))])) : clone(m.get(k)); },
    async put(k, v) { await null; for (const [a, b] of typeof k === 'object' ? Object.entries(k) : [[k, v]]) m.set(a, clone(b)); },
    async delete(k) { await null; const ks = Array.isArray(k) ? k : [k]; assert.ok(ks.length <= 128, 'delete batch over the per-call key limit'); for (const x of ks) m.delete(x); },
    async list({ prefix = '' } = {}) { await null; return new Map([...m].filter(([k]) => k.startsWith(prefix)).sort().map(([k, v]) => [k, clone(v)])); },
    async getAlarm() { return null; }, async setAlarm() {}, async deleteAlarm() {}, async deleteAll() { m.clear(); },
  };
}
function world({ access = true, ...envOver } = {}) {
  const w = { stateCalls: [], now: 1_900_000_000_000 };
  const ns = (Cls) => { const objects = new Map(); return { objects, getByName(name) { if (!objects.has(name)) { const storage = memStorage(); objects.set(name, new Cls({ storage, id: { name } }, w.env)); objects.get(name).storage = storage; } return objects.get(name); } }; };
  class TestAccess extends M.CloudbiteAccess { clock() { return w.now; } }
  const state = new Proxy({}, { get: (_, method) => async (...args) => {
    w.stateCalls.push([String(method), ...args]);
    return method === 'adminList' && args[0] === ADMIN ? { sessions: [] } : { error: 'admin session expired', status: 401 };
  } });
  w.projects = ns(M.CloudbiteProject);
  w.access = access ? ns(TestAccess) : undefined;
  w.env = {
    ORIGIN: 'https://cb.test', LAB_ORIGIN: 'https://lab.cloudbite.invalid', RP_ID: 'cb.test', MASTER_KEY: 'k',
    STATE: { idFromName: () => 'main', get: () => state }, CLOUDBITE: w.projects, ...(access ? { CLOUDBITE_ACCESS: w.access } : {}),
    CLOUDBITE_DAYTONA_API_URL: 'https://dt.fake', CLOUDBITE_DAYTONA_API_KEY: 'DT-SECRET', CLOUDBITE_NOSANA_BASE_URL: 'https://nosana.fake/v1',
    CLOUDBITE_NOSANA_API_KEY: 'NOSANA-SECRET', CLOUDBITE_NOSANA_MODEL: 'm', CLOUDBITE_GATEWAY_URL: 'https://gw.fake',
    CLOUDBITE_OPERATOR_TOKEN_HASH: sha(OPERATOR), CLOUDBITE_OPERATOR_EXPIRES_AT: String(Date.now() + 8 * HOUR),
    ...envOver,
  };
  return w;
}
async function call(w, method, path, { body, headers = {}, raw, base = 'https://cb.test' } = {}) {
  const init = { method, headers: { ...headers } };
  if (body !== undefined) { init.body = raw ?? JSON.stringify(body); init.headers['content-type'] ??= 'application/json'; }
  const r = await M.default.fetch(new Request(base + path, init), w.env, { waitUntil() {} });
  const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch {}
  return { status: r.status, j, text, cookie: r.headers.get('set-cookie') };
}
const ORIGIN = { origin: 'https://cb.test' };
const owner = (t = OPERATOR) => ({ ...ORIGIN, 'x-admin-token': t });
const jar = (setCookie) => setCookie.split(';')[0];
const credOf = (c) => c.split('=')[1];
/** Visitor: submit a request from its own network, return its cookie header. */
async function visitor(w, ip = '203.0.113.' + Math.floor(Math.random() * 250), name = 'Visitor') {
  const r = await call(w, 'POST', '/api/cloudbite/access/requests', { body: { name, purpose: 'try Cloudbite' }, headers: { ...ORIGIN, 'cf-connecting-ip': ip } });
  assert.equal(r.status, 201, r.text);
  return { cookie: jar(r.cookie), id: r.j.request.id, res: r };
}
const act = (w, id, action, headers = owner()) => call(w, 'POST', `/api/cloudbite/access/requests/${id}/${action}`, { body: {}, headers });
const ids = M.CLOUDBITE_EXPERTS.map((e) => e.id);
const brief = (over = {}) => ({ title: 'Visitor run', objective: 'Should we launch?', context: '', expertIds: ids.slice(0, 2), mode: 'demo', requestId: 'req-' + randomBytes(6).toString('hex'), ...over });
const create = (w, b, headers) => call(w, 'POST', '/api/cloudbite/projects', { body: b, headers: { ...ORIGIN, ...headers } });
const read = (w, pid, token) => call(w, 'GET', `/api/cloudbite/projects/${pid}`, { headers: { authorization: `Bearer ${token}` } });
const records = (w) => [...w.access.getByName('hacksprint-2026-10-18').storage.m];
const noCredentialIn = (r, cookie) => {
  const cred = credOf(cookie);
  for (const s of [cred, sha(cred), OPERATOR, sha(OPERATOR), 'DT-SECRET', 'NOSANA-SECRET']) assert.ok(!r.text.includes(s), 'response leaks a credential');
};

await check('submit: exact Origin, JSON, 8 KiB, plain-text bounds; fresh __Host- cookie; credential never in JSON or storage', async () => {
  const w = world();
  const post = (body, headers = ORIGIN, raw) => call(w, 'POST', '/api/cloudbite/access/requests', { body, headers, raw });
  assert.equal((await post({ name: 'a', purpose: 'b' }, { origin: 'https://evil.test' })).status, 403);
  assert.equal((await post({ name: 'a', purpose: 'b' }, {})).status, 403);
  assert.equal((await post({ name: 'a', purpose: 'b' }, { ...ORIGIN, 'content-type': 'text/plain' })).status, 415);
  assert.equal((await post({ name: 'a', purpose: 'x'.repeat(9000) })).status, 413);
  assert.equal((await post(null, ORIGIN, '{oops')).status, 400);
  for (const bad of [{ name: '', purpose: 'p' }, { name: '  ', purpose: 'p' }, { name: 'x'.repeat(81), purpose: 'p' }, { name: 'a\nb', purpose: 'p' },
    { name: 'a', purpose: '' }, { name: 'a', purpose: 'x'.repeat(1001) }, { name: 'a', purpose: 'p\u0000' }, { name: 'a', purpose: 'p', admin: true }, { name: 1, purpose: 'p' }, ['a']]) {
    assert.equal((await post(bad)).status, 400, JSON.stringify(bad).slice(0, 40));
  }
  assert.equal(records(w).length, 0, 'rejected input stores nothing');
  const r = await post({ name: '  Ada <b>  ', purpose: 'line one\nline two' });
  assert.equal(r.status, 201);
  assert.match(r.cookie, /^__Host-cb-access=cbv_[A-Za-z0-9_-]{43}; Path=\/; Max-Age=5400; HttpOnly; SameSite=Strict; Secure$/);
  assert.deepEqual(Object.keys(r.j).sort(), ['canCreate', 'request']);
  assert.equal(r.j.canCreate, false);
  const q = r.j.request;
  assert.deepEqual(Object.keys(q).sort(), ['createdAt', 'expiresAt', 'id', 'maxExperts', 'maxProjects', 'name', 'purpose', 'status', 'usedProjects']);
  assert.equal(q.name, 'Ada <b>', 'stored as trimmed plain text'); assert.equal(q.status, 'pending');
  assert.equal(q.expiresAt - q.createdAt, 30 * MIN); assert.equal(q.maxExperts, 5); assert.equal(q.maxProjects, 1); assert.equal(q.usedProjects, 0);
  noCredentialIn(r, jar(r.cookie));
  const stored = JSON.stringify(records(w));
  assert.ok(!stored.includes(credOf(jar(r.cookie))), 'plaintext credential is not stored');
  assert.ok(!/203\.0\.113|loopback/.test(stored), 'no raw source address stored');
});

await check('status and refresh: the cookie (only) finds its request; retries reuse it without a new cookie', async () => {
  const w = world();
  const v = await visitor(w);
  const st = await call(w, 'GET', '/api/cloudbite/access/status', { headers: { cookie: v.cookie } });
  assert.equal(st.status, 200); assert.equal(st.j.request.id, v.id); noCredentialIn(st, v.cookie);
  const again = await call(w, 'POST', '/api/cloudbite/access/requests', { body: { name: 'Visitor', purpose: 'again' }, headers: { ...ORIGIN, cookie: v.cookie } });
  assert.equal(again.status, 200); assert.equal(again.j.request.id, v.id); assert.equal(again.cookie, null, 'reuse keeps the existing cookie');
  assert.equal((await call(w, 'GET', '/api/cloudbite/access/requests', { headers: owner() })).j.requests.length, 1, 'no duplicate request');
  for (const headers of [{}, { cookie: `__Host-cb-access=${v.id}` }, { cookie: 'cb-access-dev=' + credOf(v.cookie) }, { cookie: v.cookie + 'x' }]) {
    const r = await call(w, 'GET', `/api/cloudbite/access/status?id=${v.id}`, { headers });
    assert.deepEqual(r.j, { request: null, canCreate: false }, 'ids, other cookie names and malformed values never authenticate');
  }
  const boot = await call(w, 'GET', '/api/cloudbite/bootstrap', { headers: { cookie: v.cookie } });
  assert.equal(boot.j.access.request.id, v.id); assert.ok(boot.j.experts.length);
  const plain = await call(w, 'GET', '/api/cloudbite/bootstrap');
  assert.equal('access' in plain.j, false, 'no cookie → bootstrap unchanged');
  const dev = world({ ORIGIN: 'http://localhost:8808', CLOUDBITE_ALLOW_HTTP: '1' });
  const d = await call(dev, 'POST', '/api/cloudbite/access/requests', { body: { name: 'a', purpose: 'b' }, headers: { origin: 'http://localhost:8808' }, base: 'http://localhost:8808' });
  assert.match(d.cookie, /^cb-access-dev=cbv_[^;]+; Path=\/; Max-Age=5400; HttpOnly; SameSite=Strict$/, 'local http only: no Secure, no __Host- prefix');
  const noflag = world({ ORIGIN: 'http://localhost:8808' });
  const n = await call(noflag, 'POST', '/api/cloudbite/access/requests', { body: { name: 'a', purpose: 'b' }, headers: { origin: 'http://localhost:8808' }, base: 'http://localhost:8808' });
  assert.match(n.cookie, /^__Host-cb-access=.*; Secure$/, 'without CLOUDBITE_ALLOW_HTTP=1 the cookie stays Secure');
});

await check('owner only: list and decisions need the operator or a State admin session; a visitor cookie never does', async () => {
  const w = world();
  const v = await visitor(w);
  const list = (headers) => call(w, 'GET', '/api/cloudbite/access/requests', { headers });
  assert.equal((await list({})).status, 401);
  assert.equal((await list({ cookie: v.cookie })).status, 401);
  assert.equal((await list(owner('cbo_' + randomBytes(32).toString('base64url')))).status, 401);
  assert.equal((await list(owner('legacy-wrong'))).status, 401);
  const ok = await list(owner());
  assert.equal(ok.status, 200); assert.equal(ok.j.requests[0].id, v.id); noCredentialIn(ok, v.cookie);
  assert.equal((await list(owner(ADMIN))).status, 200, 'legacy State admin session');
  assert.deepEqual(w.stateCalls.map((c) => c[0]), ['adminList', 'adminList'], 'cbo_ never reaches State; State is only asked adminList');
  assert.equal((await act(w, v.id, 'approve', { ...ORIGIN, cookie: v.cookie })).status, 401);
  assert.equal((await act(w, v.id, 'approve', { 'x-admin-token': OPERATOR })).status, 403, 'exact Origin');
  assert.equal((await call(w, 'POST', `/api/cloudbite/access/requests/${v.id}/approve`, { body: { status: 'approved' }, headers: owner() })).status, 400);
  assert.equal((await call(w, 'POST', `/api/cloudbite/access/requests/${v.id}/approve`, { body: {}, headers: { ...owner(), 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await act(w, 'cba_' + '0'.repeat(32), 'approve')).status, 404);
  assert.equal((await act(w, '../x', 'approve')).status, 404);
  assert.equal((await call(w, 'GET', `/api/cloudbite/access/requests/${v.id}`, { headers: owner() })).status, 404, 'no per-id read route');
  assert.equal((await call(w, 'GET', '/api/cloudbite/access/status', { headers: { 'x-admin-token': OPERATOR } })).j.request, null, 'owner token is not a visitor');
  assert.equal((await records(w)).filter(([k]) => k.startsWith('req:'))[0][1].status, 'pending', 'nothing changed');
});

await check('pending blocks creation; approval lets the cookie create exactly one project, with zero provider calls', async () => {
  const w = world();
  const v = await visitor(w);
  const before = fetches;
  assert.equal((await create(w, brief(), { cookie: v.cookie })).status, 401, 'pending');
  const ap = await act(w, v.id, 'approve');
  assert.equal(ap.status, 200); assert.equal(ap.j.status, 'approved'); assert.equal(ap.j.expiresAt, w.now + HOUR);
  assert.equal((await act(w, v.id, 'approve')).j.expiresAt, w.now + HOUR, 'idempotent approve');
  assert.equal((await act(w, v.id, 'deny')).status, 409, 'approved cannot be denied');
  assert.equal((await call(w, 'GET', '/api/cloudbite/access/status', { headers: { cookie: v.cookie } })).j.canCreate, true);
  assert.equal(fetches, before, 'request, approval and status never call a provider');
  assert.equal(w.projects.objects.size, 0, 'approval creates nothing');
  const b = brief();
  assert.equal((await create(w, { ...b, expertIds: ['no-such-expert'] }, { cookie: v.cookie })).status, 400, 'actual catalogue');
  assert.equal((await create(w, b, { cookie: v.cookie, origin: 'https://evil.test' })).status, 403);
  const c = await create(w, b, { cookie: v.cookie });
  assert.equal(c.status, 201, c.text); assert.match(c.j.accessToken, /^cbt_/);
  assert.notEqual(c.j.project.brief.requestId, b.requestId, 'visitor requestId is namespaced');
  assert.match(c.j.project.brief.requestId, /^[0-9a-f]{64}$/);
  const retry = await create(w, b, { cookie: v.cookie });
  assert.equal(retry.status, 201); assert.equal(retry.j.project.id, c.j.project.id, 'same-id retry returns the same project');
  assert.notEqual(retry.j.accessToken, c.j.accessToken);
  assert.equal((await create(w, brief(), { cookie: v.cookie })).status, 409, 'second project refused');
  const st = await call(w, 'GET', '/api/cloudbite/access/status', { headers: { cookie: v.cookie } });
  assert.equal(st.j.request.usedProjects, 1); assert.equal(st.j.canCreate, false);
  assert.equal((await read(w, c.j.project.id, c.j.accessToken)).status, 200);
  assert.equal(w.stateCalls.length, 0, 'visitor path never asks State');
  assert.equal(fetches, before, 'demo creation calls no provider');
});

await check('deny, revoke and expiry: nothing revives a grant; a fresh request after expiry gets a new cookie', async () => {
  const w = world();
  const a = await visitor(w), b = await visitor(w), c = await visitor(w), d = await visitor(w);
  assert.equal((await act(w, a.id, 'deny')).j.status, 'denied');
  assert.equal((await act(w, a.id, 'deny')).status, 200, 'idempotent deny');
  assert.equal((await act(w, a.id, 'approve')).status, 409);
  assert.equal((await create(w, brief(), { cookie: a.cookie })).status, 401);
  await act(w, b.id, 'approve');
  const kept = brief();
  const made = await create(w, kept, { cookie: b.cookie });
  assert.equal(made.status, 201);
  assert.equal((await act(w, b.id, 'revoke')).j.status, 'revoked');
  assert.equal((await act(w, b.id, 'revoke')).status, 200, 'idempotent revoke');
  assert.equal((await act(w, b.id, 'approve')).status, 409);
  assert.equal((await create(w, kept, { cookie: b.cookie })).status, 401, 'revoked grant cannot even retry');
  assert.equal((await read(w, made.j.project.id, made.j.accessToken)).status, 200, 'issued project token keeps its own 24 h policy');
  assert.equal((await act(w, c.id, 'revoke')).status, 409, 'pending cannot be revoked');
  w.now += 30 * MIN;
  assert.equal((await call(w, 'GET', '/api/cloudbite/access/status', { headers: { cookie: c.cookie } })).j.request.status, 'expired');
  assert.equal((await act(w, c.id, 'approve')).status, 409, 'expired pending cannot be approved');
  await act(w, d.id, 'deny');
  const e = await visitor(w); await act(w, e.id, 'approve');
  w.now += HOUR;
  assert.equal((await call(w, 'GET', '/api/cloudbite/access/status', { headers: { cookie: e.cookie } })).j.request.status, 'expired');
  assert.equal((await create(w, brief(), { cookie: e.cookie })).status, 401, 'approved grant expires 1 h after approval');
  assert.equal((await act(w, e.id, 'revoke')).status, 409);
  const again = await call(w, 'POST', '/api/cloudbite/access/requests', { body: { name: 'E', purpose: 'again' }, headers: { ...ORIGIN, cookie: e.cookie, 'cf-connecting-ip': '198.51.100.9' } });
  assert.equal(again.status, 201); assert.notEqual(again.j.request.id, e.id); assert.ok(again.cookie, 'new request, new credential');
  // Retention: ended records are pruned 8 h after they ended (on the next submit).
  w.now += 8 * HOUR + MIN;
  await visitor(w);
  const left = (await call(w, 'GET', '/api/cloudbite/access/requests', { headers: owner() })).j.requests.map((r) => r.id);
  for (const gone of [a.id, b.id, c.id, d.id, e.id]) assert.ok(!left.includes(gone), 'ended record pruned');
  assert.ok(!records(w).some(([k, v]) => k.startsWith('cred:') && [a.id, b.id, c.id, d.id, e.id].includes(v)), 'credential index pruned too');
  assert.equal((await call(w, 'GET', '/api/cloudbite/access/status', { headers: { cookie: a.cookie } })).j.request, null);
});

await check('tenant isolation: same raw brief and requestId → different projects; owner projects unreachable by idempotence', async () => {
  const w = world();
  const owned = brief({ title: 'Owner run' });
  const o = await create(w, owned, owner());
  assert.equal(o.status, 201);
  const a = await visitor(w), b = await visitor(w);
  await act(w, a.id, 'approve'); await act(w, b.id, 'approve');
  const same = { ...owned };
  const ra = await create(w, same, { cookie: a.cookie }), rb = await create(w, same, { cookie: b.cookie });
  assert.equal(ra.status, 201); assert.equal(rb.status, 201);
  const pids = new Set([o.j.project.id, ra.j.project.id, rb.j.project.id]);
  assert.equal(pids.size, 3, 'three distinct projects');
  assert.equal((await read(w, o.j.project.id, ra.j.accessToken)).status, 401, 'visitor token does not open the owner project');
  assert.equal((await read(w, rb.j.project.id, ra.j.accessToken)).status, 401, 'visitor A cannot open visitor B');
  // A visitor sending another visitor's scoped requestId gets it namespaced again.
  const c = await visitor(w); await act(w, c.id, 'approve');
  const rc = await create(w, { ...same, requestId: ra.j.project.brief.requestId }, { cookie: c.cookie });
  assert.equal(rc.status, 201); assert.notEqual(rc.j.project.id, ra.j.project.id);
  // The owner path is unchanged: raw requestId, idempotent.
  const o2 = await create(w, owned, owner());
  assert.equal(o2.j.project.id, o.j.project.id); assert.equal(o2.j.project.brief.requestId, owned.requestId);
});

await check('atomic quota: concurrent creates cannot use one grant twice; a refused attempt frees only its own slot', async () => {
  const w = world();
  const v = await visitor(w); await act(w, v.id, 'approve');
  const rs = await Promise.all([create(w, brief(), { cookie: v.cookie }), create(w, brief(), { cookie: v.cookie }), create(w, brief(), { cookie: v.cookie })]);
  assert.deepEqual(rs.map((r) => r.status).sort(), [201, 409, 409]);
  assert.equal(w.projects.objects.size, 1, 'one project object');
  // Same race directly on the DO, lockstep (storage yields on every call): exactly one binding wins.
  const z = await visitor(w); await act(w, z.id, 'approve');
  const inbox = w.access.getByName('hacksprint-2026-10-18');
  const raced = await Promise.all([1, 2, 3].map((i) => inbox.reserve(sha(credOf(z.cookie)), sha('race' + i), 2)));
  assert.equal(raced.filter((r) => !r.error).length, 1, 'one reservation per grant');
  const u = await visitor(w); await act(w, u.id, 'approve');
  const b = brief();
  const same = await Promise.all([create(w, b, { cookie: u.cookie }), create(w, b, { cookie: u.cookie })]);
  assert.deepEqual(same.map((r) => r.status), [201, 201]); assert.equal(same[0].j.project.id, same[1].j.project.id);
  // Live slot refused (registry full) → nothing created → the reservation is released for a different requestId.
  const x = await visitor(w); await act(w, x.id, 'approve');
  const reg = w.projects.getByName('registry');
  await reg.registryAcquire('cb' + 'a'.repeat(32)); await reg.registryAcquire('cb' + 'b'.repeat(32));
  const live = await create(w, brief({ mode: 'live' }), { cookie: x.cookie });
  assert.equal(live.status, 429, live.text);
  assert.equal((await call(w, 'GET', '/api/cloudbite/access/status', { headers: { cookie: x.cookie } })).j.request.usedProjects, 0);
  const demo = await create(w, brief(), { cookie: x.cookie });
  assert.equal(demo.status, 201);
  assert.equal((await create(w, brief(), { cookie: x.cookie })).status, 409);
  // Live config missing is refused before any reservation.
  const y = await visitor(w); await act(w, y.id, 'approve');
  w.env.CLOUDBITE_NOSANA_API_KEY = '';
  assert.equal((await create(w, brief({ mode: 'live' }), { cookie: y.cookie })).status, 503);
  assert.equal((await call(w, 'GET', '/api/cloudbite/access/status', { headers: { cookie: y.cookie } })).j.request.usedProjects, 0);
  // Expert limit stays 5 (validateBrief) for visitors too.
  assert.equal((await create(w, brief({ expertIds: ids.slice(0, 6) }), { cookie: y.cookie })).status, 400);
});

await check('rate and caps: 5 new requests per hashed source per hour, at most 100 pending', async () => {
  const w = world();
  for (let i = 0; i < 5; i++) await visitor(w, '192.0.2.1');
  const r = await call(w, 'POST', '/api/cloudbite/access/requests', { body: { name: 'n', purpose: 'p' }, headers: { ...ORIGIN, 'cf-connecting-ip': '192.0.2.1' } });
  assert.equal(r.status, 429); assert.equal(r.cookie, null);
  await visitor(w, '192.0.2.2');
  w.now += HOUR;
  await visitor(w, '192.0.2.1');
  const cap = world();
  for (let i = 0; i < 100; i++) await visitor(cap, `10.0.${i >> 8}.${i & 255}`);
  assert.equal((await call(cap, 'POST', '/api/cloudbite/access/requests', { body: { name: 'n', purpose: 'p' }, headers: { ...ORIGIN, 'cf-connecting-ip': '10.9.9.9' } })).status, 429);
  const listed = await call(cap, 'GET', '/api/cloudbite/access/requests', { headers: owner() });
  assert.equal(listed.j.requests.length, 100);
  assert.ok(listed.j.requests.every((q, i, all) => i === 0 || all[i - 1].createdAt >= q.createdAt), 'newest first');
});

await check('without the CLOUDBITE_ACCESS binding: public demo, bootstrap, operator and legacy admin are unchanged', async () => {
  const w = world({ access: false });
  const boot = await call(w, 'GET', '/api/cloudbite/bootstrap', { headers: { cookie: '__Host-cb-access=cbv_' + 'A'.repeat(43) } });
  assert.equal(boot.status, 200); assert.equal('access' in boot.j, false);
  assert.deepEqual((await call(w, 'GET', '/api/cloudbite/access/status')).j, { request: null, canCreate: false });
  assert.equal((await call(w, 'POST', '/api/cloudbite/access/requests', { body: { name: 'a', purpose: 'b' }, headers: ORIGIN })).status, 503);
  assert.equal((await create(w, brief(), { cookie: '__Host-cb-access=cbv_' + 'A'.repeat(43) })).status, 401);
  assert.equal((await create(w, brief(), owner())).status, 201);
  assert.equal((await create(w, brief(), owner(ADMIN))).status, 201);
  assert.equal((await create(w, brief(), owner('legacy-wrong'))).status, 401);
  // A wrong admin header is not rescued by an approved visitor cookie.
  const x = world();
  const v = await visitor(x); await act(x, v.id, 'approve');
  assert.equal((await create(x, brief(), { cookie: v.cookie, 'x-admin-token': 'legacy-wrong' })).status, 401);
  assert.equal((await call(x, 'GET', '/', {})).status, 200, 'public console page');
});

rmSync(tmp, { recursive: true, force: true });
console.log(`cloudbite-access: ${count} checks passed`);
