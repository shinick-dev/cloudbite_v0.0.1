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
const status = (w, cookie, q = '') => call(w, 'GET', '/api/cloudbite/access/status' + q, { headers: { cookie } });
const rec = (w, id) => w.access.getByName('hacksprint-2026-10-18').storage.m.get(`req:${id}`);
const inboxOf = (w) => w.access.getByName('hacksprint-2026-10-18');
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
  assert.equal(q.expiresAt - q.createdAt, 30 * MIN); assert.equal(q.maxExperts, 5); assert.equal(q.maxProjects, 10); assert.equal(q.usedProjects, 0);
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

await check('pending blocks creation; approval lets the cookie create at most ten projects, with zero provider calls', async () => {
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
  const one = await call(w, 'GET', '/api/cloudbite/access/status', { headers: { cookie: v.cookie } });
  assert.equal(one.j.request.usedProjects, 1, 'a retry takes no second slot'); assert.equal(one.j.canCreate, true);
  for (let i = 2; i <= 10; i++) {
    const n = await create(w, brief(), { cookie: v.cookie });
    assert.equal(n.status, 201, `project ${i}`);
    assert.equal((await call(w, 'GET', '/api/cloudbite/access/status', { headers: { cookie: v.cookie } })).j.request.usedProjects, i);
  }
  const eleventh = await create(w, brief(), { cookie: v.cookie });
  assert.equal(eleventh.status, 409, 'eleventh project refused'); assert.match(eleventh.j.error, /10 projects/);
  const st = await call(w, 'GET', '/api/cloudbite/access/status', { headers: { cookie: v.cookie } });
  assert.equal(st.j.request.usedProjects, 10); assert.equal(st.j.canCreate, false); assert.equal('recovery' in st.j, false);
  assert.equal((await create(w, b, { cookie: v.cookie })).status, 201, 'a retry of a held id still works at full quota');
  assert.equal(w.projects.objects.size, 10);
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

await check('atomic quota: eleven concurrent creates yield ten projects; same-id retries take one slot; a refused attempt frees only its own slot', async () => {
  const w = world();
  const v = await visitor(w); await act(w, v.id, 'approve');
  const bs = Array.from({ length: 11 }, () => brief());
  const rs = await Promise.all(bs.map((x) => create(w, x, { cookie: v.cookie })));
  assert.deepEqual(rs.map((r) => r.status).sort(), [...Array(10).fill(201), 409]);
  assert.equal(w.projects.objects.size, 10, 'ten project objects');
  assert.equal(rec(w, v.id).projects.length, 10); assert.ok(rec(w, v.id).projects.every((b) => b.confirmed && b.holds === 0));
  // Retries of held ids at full quota, concurrently with a new id: the retries succeed and add no usage, the new id is refused.
  const held = bs.filter((_, i) => rs[i].status === 201).slice(0, 3);
  const rr = await Promise.all([...held.map((x) => create(w, x, { cookie: v.cookie })), create(w, brief(), { cookie: v.cookie })]);
  assert.deepEqual(rr.map((r) => r.status), [201, 201, 201, 409]);
  assert.deepEqual(rr.slice(0, 3).map((r) => r.j.project.id), held.map((x) => rs[bs.indexOf(x)].j.project.id));
  assert.equal((await status(w, v.cookie)).j.request.usedProjects, 10); assert.equal(w.projects.objects.size, 10);
  // Same race directly on the DO, lockstep (storage yields on every call): exactly ten slots are bound.
  const z = await visitor(w); await act(w, z.id, 'approve');
  const inbox = w.access.getByName('hacksprint-2026-10-18');
  const raced = await Promise.all(Array.from({ length: 13 }, (_, i) => inbox.reserve(sha(credOf(z.cookie)), sha('race' + i), 2)));
  assert.equal(raced.filter((r) => !r.error).length, 10, 'ten reservations per grant');
  assert.ok(raced.filter((r) => r.error).every((r) => r.status === 409));
  assert.equal((await inbox.reserve(sha(credOf(z.cookie)), sha('race0'), 2)).fresh, false, 'retry at full quota is not fresh');
  assert.equal(rec(w, z.id).projects.find((b) => b.id === sha('race0')).holds, 2);
  const u = await visitor(w); await act(w, u.id, 'approve');
  const b = brief();
  const same = await Promise.all([create(w, b, { cookie: u.cookie }), create(w, b, { cookie: u.cookie })]);
  assert.deepEqual(same.map((r) => r.status), [201, 201]); assert.equal(same[0].j.project.id, same[1].j.project.id);
  assert.equal((await status(w, u.cookie)).j.request.usedProjects, 1, 'concurrent same-id creates use one slot');
  // Live slot refused (registry full) → nothing created → the reservation is released for a different requestId.
  const x = await visitor(w); await act(w, x.id, 'approve');
  const reg = w.projects.getByName('registry');
  await reg.registryAcquire('cb' + 'a'.repeat(32)); await reg.registryAcquire('cb' + 'b'.repeat(32));
  const live = await create(w, brief({ mode: 'live' }), { cookie: x.cookie });
  assert.equal(live.status, 429, live.text);
  assert.equal((await call(w, 'GET', '/api/cloudbite/access/status', { headers: { cookie: x.cookie } })).j.request.usedProjects, 0);
  assert.equal(rec(w, x.id).projects.length, 0, 'the refused slot is gone, not merely unheld');
  const demo = await create(w, brief(), { cookie: x.cookie });
  assert.equal(demo.status, 201);
  assert.equal((await call(w, 'GET', '/api/cloudbite/access/status', { headers: { cookie: x.cookie } })).j.request.usedProjects, 1);
  // Live config missing is refused before any reservation.
  const y = await visitor(w); await act(w, y.id, 'approve');
  w.env.CLOUDBITE_NOSANA_API_KEY = '';
  assert.equal((await create(w, brief({ mode: 'live' }), { cookie: y.cookie })).status, 503);
  assert.equal((await call(w, 'GET', '/api/cloudbite/access/status', { headers: { cookie: y.cookie } })).j.request.usedProjects, 0);
  // Expert limit stays 5 (validateBrief) for visitors too.
  assert.equal((await create(w, brief({ expertIds: ids.slice(0, 6) }), { cookie: y.cookie })).status, 400);
});

await check('rate: 120 new requests per hashed source per hour, so many attendees behind one venue NAT address get in', async () => {
  const w = world();
  // Distinct applicants (fresh browsers, no cookie) from the SAME source; each is decided at once so the separate
  // 100-pending cap never fills and only the rate limit can refuse.
  const seen = new Set();
  for (let i = 0; i < 120; i++) {
    const v = await visitor(w, '192.0.2.1', 'Judge ' + i);
    seen.add(v.id);
    assert.equal((await act(w, v.id, i % 2 ? 'approve' : 'deny')).status, 200);
  }
  assert.equal(seen.size, 120, 'every applicant behind the shared address got its own request (well past the old 5)');
  const r = await call(w, 'POST', '/api/cloudbite/access/requests', { body: { name: 'n', purpose: 'p' }, headers: { ...ORIGIN, 'cf-connecting-ip': '192.0.2.1' } });
  assert.equal(r.status, 429, 'the 121st new request from that source within the hour is refused'); assert.equal(r.cookie, null);
  await visitor(w, '192.0.2.2');
  w.now += HOUR;
  await visitor(w, '192.0.2.1', 'next hour');
  await visitor(w, '192.0.2.1', 'next hour 2');
});

await check('caps: at most 100 pending', async () => {
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

// ── failed-run refund (docs/cloudbite/access-service.txt) ──
/** Test-only: put a project into a given final shape directly in its storage (alarms never run in this file). */
function shape(w, pid, { status = 'failed', completed = 0, phase = 'final', cleanup = 'done', released = true } = {}) {
  const st = w.projects.getByName(pid).storage.m;
  const p = st.get('project');
  p.status = status; p.released = released;
  p.runs.forEach((r, i) => {
    const e = st.get(`expert:${r}`);
    e.int.phase = phase; e.run.status = i < completed ? 'completed' : status === 'cancelled' ? 'cancelled' : 'failed';
    if (cleanup !== 'none') st.set(`cleanup:${r}:label:L${i}`, { run: r, label: `L${i}`, tries: 0, nextAt: 0, done: cleanup === 'done', stuck: cleanup === 'stuck' });
  });
}
async function approvedWithProject(w, b = brief()) {
  const v = await visitor(w); await act(w, v.id, 'approve');
  const c = await create(w, b, { cookie: v.cookie });
  assert.equal(c.status, 201, c.text);
  return { ...v, pid: c.j.project.id, token: c.j.accessToken, brief: b };
}

/** Create demo projects for this grant until all ten slots are used; returns their project ids. */
async function fill(w, v) {
  const out = [];
  while ((await status(w, v.cookie)).j.request.usedProjects < 10) {
    const c = await create(w, brief(), { cookie: v.cookie });
    assert.equal(c.status, 201, c.text); out.push(c.j.project.id);
  }
  return out;
}
const slots = (w, id) => rec(w, id).projects.map((b) => b.id);

await check('failed run with zero completed experts and confirmed cleanup returns the slot; evidence and token stay; same run cannot rebind', async () => {
  const w = world();
  const v = await approvedWithProject(w);
  const run = await status(w, v.cookie);
  assert.equal(run.j.request.usedProjects, 1, 'running: no refund'); assert.equal(run.j.canCreate, true, 'nine slots remain');
  shape(w, v.pid);
  const before = fetches;
  const st = await status(w, v.cookie);
  assert.equal(st.j.canCreate, true); assert.equal(st.j.request.usedProjects, 0); assert.equal('recovery' in st.j, false);
  noCredentialIn(st, v.cookie);
  assert.equal(fetches, before, 'the refund check calls no provider');
  assert.equal((await read(w, v.pid, v.token)).j.status, 'failed', 'failure evidence is untouched');
  for (let i = 0; i < 3; i++) assert.equal((await status(w, v.cookie)).j.canCreate, true);
  const boot = await call(w, 'GET', '/api/cloudbite/bootstrap', { headers: { cookie: v.cookie } });
  assert.equal(boot.j.access.canCreate, true);
  assert.equal(rec(w, v.id).refunds, 1, 'repeated refresh refunds once');
  const again = await create(w, v.brief, { cookie: v.cookie });
  assert.equal(again.status, 409, 'the refunded run is never bound again'); assert.match(again.j.error, /already failed/);
  assert.equal((await status(w, v.cookie)).j.request.usedProjects, 0, 'refused retry takes no slot');
  const next = await create(w, brief(), { cookie: v.cookie });
  assert.equal(next.status, 201); assert.notEqual(next.j.project.id, v.pid);
  await fill(w, v);
  assert.equal((await status(w, v.cookie)).j.canCreate, false);
  assert.equal((await create(w, brief(), { cookie: v.cookie })).status, 409, 'still at most ten slots');
});

await check('no refund for running, completed, partial, cancelled, stuck cleanup or a missing project; settling cleanup reports pending only when full', async () => {
  const w = world();
  for (const [over, why] of [[{ status: 'running', phase: 'running', cleanup: 'none' }, 'running'], [{ status: 'completed', completed: 2 }, 'completed'],
    [{ status: 'partial', completed: 1 }, 'partial'], [{ status: 'cancelled' }, 'cancelled'], [{ cleanup: 'stuck' }, 'stuck cleanup']]) {
    const v = await approvedWithProject(w);
    shape(w, v.pid, over);
    const st = await status(w, v.cookie);
    assert.equal(st.j.canCreate, true, why); assert.equal(st.j.request.usedProjects, 1, why); assert.equal('recovery' in st.j, false, why);
    assert.equal(rec(w, v.id).refunds, undefined, why);
  }
  const gone = await approvedWithProject(w);
  w.projects.getByName(gone.pid).storage.m.clear();
  assert.equal((await status(w, gone.cookie)).j.request.usedProjects, 1, 'missing project');
  // Live project: failed, but cleanup, the live slot or an expert is not settled yet → pending (hinted only while no
  // slot is free); once confirmed → refunded.
  const live = await approvedWithProject(w, brief({ mode: 'live' }));
  shape(w, live.pid, { cleanup: 'pending' });
  const p0 = await status(w, live.cookie);
  assert.equal(p0.j.canCreate, true); assert.equal('recovery' in p0.j, false, 'free slots remain: no blocked hint');
  await fill(w, live);
  const p1 = await status(w, live.cookie);
  assert.equal(p1.j.canCreate, false); assert.equal(p1.j.recovery, 'pending');
  shape(w, live.pid, { released: false });
  assert.equal((await status(w, live.cookie)).j.recovery, 'pending', 'live slot not released yet');
  shape(w, live.pid, { phase: 'collecting' });
  assert.equal((await status(w, live.cookie)).j.recovery, 'pending', 'an expert not final yet');
  shape(w, live.pid);
  const done = await status(w, live.cookie);
  assert.equal(done.j.canCreate, true); assert.equal(done.j.request.usedProjects, 9); assert.equal('recovery' in done.j, false);
});

await check('fail closed: project check failure, unconfirmed or in-flight create, revoked or expired grant keep the slot used', async () => {
  const w = world();
  const v = await approvedWithProject(w);
  const others = await fill(w, v);
  shape(w, v.pid);
  const real = w.env.CLOUDBITE;
  w.env.CLOUDBITE = { getByName: (n) => n === v.pid ? { refundState: async () => { throw new Error('rpc down'); } } : real.getByName(n) };
  const down = await status(w, v.cookie);
  assert.equal(down.j.canCreate, false); assert.equal(down.j.recovery, 'unavailable');
  assert.equal((await create(w, brief(), { cookie: v.cookie })).status, 409, 'create path fails closed too');
  // One project's check failing does not hold back another slot's refund, and the hint goes once a slot is free.
  shape(w, others[3]);
  const mixed = await status(w, v.cookie);
  assert.equal(mixed.j.canCreate, true); assert.equal(mixed.j.request.usedProjects, 9); assert.equal('recovery' in mixed.j, false);
  assert.deepEqual(rec(w, v.id).refunded, [rec(w, v.id).refunded[0]]); assert.ok(slots(w, v.id).length === 9);
  assert.equal((await create(w, brief(), { cookie: v.cookie })).status, 201, 'the returned slot is usable while the other check is down');
  w.env.CLOUDBITE = real;
  assert.equal((await status(w, v.cookie)).j.request.usedProjects, 9, 'recovers once the check works');
  assert.equal(rec(w, v.id).refunds, 2);
  w.env.CLOUDBITE = undefined;
  assert.equal((await status(w, v.cookie)).j.request.usedProjects, 9, 'no project binding: nothing refunded');
  w.env.CLOUDBITE = real;
  // A create whose outcome was never confirmed (reserve without confirm/release, e.g. it threw) never refunds.
  const u = await visitor(w); await act(w, u.id, 'approve');
  const b = brief(); const scoped = sha(`cloudbite-visitor-v1|${u.id}|${b.requestId}`);
  assert.ok(!(await inboxOf(w).reserve(sha(credOf(u.cookie)), scoped, 2)).error);
  assert.equal((await create(w, b, { cookie: u.cookie })).status, 201);
  const pid = [...w.projects.objects.keys()].find((k) => w.projects.getByName(k).storage.m.get('project')?.brief.requestId === scoped);
  shape(w, pid);
  assert.equal(rec(w, u.id).projects[0].holds, 1);
  assert.equal((await status(w, u.cookie)).j.request.usedProjects, 1, 'a create still in flight (or lost) blocks the refund');
  assert.equal(rec(w, u.id).refunds, undefined);
  // Revoked and expired grants never get a refund.
  const r = await approvedWithProject(w); shape(w, r.pid); await act(w, r.id, 'revoke');
  assert.equal((await status(w, r.cookie)).j.canCreate, false); assert.equal(rec(w, r.id).refunds, undefined);
  const e = await approvedWithProject(w); shape(w, e.pid); w.now += HOUR;
  assert.equal((await status(w, e.cookie)).j.canCreate, false); assert.equal(rec(w, e.id).refunds, undefined);
  assert.equal((await inboxOf(w).refund(sha(credOf(e.cookie)), slots(w, e.id))).canCreate, false);
  assert.equal(rec(w, e.id).refunds, undefined, 'a direct refund after expiry is a no-op');
});

await check('tenant isolation: the check uses the server-stored binding; other visitors and browser-supplied ids change nothing', async () => {
  const w = world();
  const a = await approvedWithProject(w), b = await approvedWithProject(w);
  shape(w, a.pid);
  assert.equal((await status(w, b.cookie, `?project=${a.pid}&requestId=${a.brief.requestId}`)).j.request.usedProjects, 1, 'B is not refunded by A');
  assert.equal(rec(w, a.id).refunds, undefined, 'A is not touched by B');
  assert.equal(rec(w, b.id).refunds, undefined);
  assert.equal((await status(w, a.cookie)).j.request.usedProjects, 0);
  // A refund call with someone else's scoped id is a no-op, and so is a release or confirm aimed at another grant.
  shape(w, b.pid);
  const bs = slots(w, b.id);
  await inboxOf(w).refund(sha(credOf(a.cookie)), bs);
  assert.equal(rec(w, b.id).refunds, undefined); assert.equal(rec(w, a.id).refunds, 1); assert.deepEqual(slots(w, b.id), bs);
  await inboxOf(w).release(a.id, bs[0]); await inboxOf(w).confirm(a.id, bs[0]);
  assert.deepEqual(slots(w, b.id), bs); assert.deepEqual(rec(w, a.id).projects, []);
  await inboxOf(w).refund(sha(credOf(b.cookie)), ['not-a-slot', 42, bs[0], bs[0]]);
  assert.equal(rec(w, b.id).refunds, 1, 'junk and duplicate ids refund once');
});

await check('concurrency: parallel refreshes and creates refund once and bind new projects; a stale refund is a no-op', async () => {
  const w = world();
  const v = await approvedWithProject(w);
  shape(w, v.pid);
  const rs = await Promise.all([status(w, v.cookie), create(w, brief(), { cookie: v.cookie }), status(w, v.cookie), create(w, brief(), { cookie: v.cookie }),
    call(w, 'GET', '/api/cloudbite/bootstrap', { headers: { cookie: v.cookie } })]);
  assert.deepEqual([rs[1].status, rs[3].status], [201, 201]);
  assert.equal(rec(w, v.id).refunds, 1, 'refunded exactly once');
  const bound = slots(w, v.id);
  assert.equal(bound.length, 2); assert.ok(!bound.includes(rec(w, v.id).refunded[0]));
  // Stale step 2 for the old run after new bindings exist: nothing changes.
  await inboxOf(w).refund(sha(credOf(v.cookie)), [rec(w, v.id).refunded[0]]);
  assert.deepEqual(slots(w, v.id), bound); assert.equal(rec(w, v.id).refunds, 1);
  // Lockstep on the DO: step 1 sees the failed binding, a retry of the same run reserves first, step 2 must not clear it.
  const x = await approvedWithProject(w); shape(w, x.pid);
  const cred = sha(credOf(x.cookie)), xs = slots(w, x.id)[0];
  assert.deepEqual((await inboxOf(w).refundCandidate(cred)).scoped, [xs]);
  assert.ok(!(await inboxOf(w).reserve(cred, xs, 2)).error, 'retry of the same run holds the binding');
  await inboxOf(w).refund(cred, [xs]);
  assert.deepEqual(slots(w, x.id), [xs], 'held binding is not refunded'); assert.equal(rec(w, x.id).refunds, undefined);
  // Full quota, two failed runs: concurrent creates each settle first, so both refunds land and two of three new ids bind.
  const f = await approvedWithProject(w);
  const fp = await fill(w, f);
  shape(w, f.pid); shape(w, fp[4]);
  const cr = await Promise.all([status(w, f.cookie), create(w, brief(), { cookie: f.cookie }), create(w, brief(), { cookie: f.cookie }), create(w, brief(), { cookie: f.cookie })]);
  assert.deepEqual(cr.slice(1).map((r) => r.status).sort(), [201, 201, 409]);
  assert.equal(rec(w, f.id).refunds, 2); assert.equal(slots(w, f.id).length, 10);
  assert.ok(rec(w, f.id).refunded.every((id) => !slots(w, f.id).includes(id)));
});

await check('refund cap: at most 3 failed-run refunds per grant, then recovery=limit once full; records written before refunds existed recover', async () => {
  const w = world();
  const v = await approvedWithProject(w);
  const r0 = rec(w, v.id); delete r0.refunds; delete r0.refunded; // pre-deployment record shape
  assert.equal('refunds' in r0 || 'refunded' in r0, false);
  let pid = v.pid;
  for (let i = 1; i <= 3; i++) {
    shape(w, pid);
    assert.equal((await status(w, v.cookie)).j.request.usedProjects, 0, `refund ${i}`);
    assert.equal(rec(w, v.id).refunds, i);
    const c = await create(w, brief(), { cookie: v.cookie }); assert.equal(c.status, 201); pid = c.j.project.id;
  }
  shape(w, pid);
  const free = await status(w, v.cookie);
  assert.equal(free.j.request.usedProjects, 1, 'cap used: the fourth failed run keeps its slot'); assert.equal('recovery' in free.j, false);
  await fill(w, v);
  const st = await status(w, v.cookie);
  assert.equal(st.j.canCreate, false); assert.equal(st.j.recovery, 'limit'); assert.equal(st.j.request.usedProjects, 10);
  assert.equal((await create(w, brief(), { cookie: v.cookie })).status, 409);
  assert.equal(rec(w, v.id).refunds, 3); assert.equal(rec(w, v.id).refunded.length, 3);
  assert.equal(w.projects.objects.size, 13, 'ten slots plus three refunded runs per grant, never more');
  // Several refundable runs in one settle are cut at the cap, in order, without dropping the others.
  const m = await approvedWithProject(w);
  const mp = await fill(w, m);
  for (const p of [m.pid, ...mp.slice(0, 4)]) shape(w, p);
  const ms = await status(w, m.cookie);
  assert.equal(ms.j.request.usedProjects, 7); assert.equal(ms.j.canCreate, true); assert.equal(rec(w, m.id).refunds, 3);
  assert.equal(slots(w, m.id).length, 7);
});

await check('legacy single-project records: usage, holds, confirmation, refunds and tombstones carry over to ten slots', async () => {
  const w = world();
  const legacy = (r, fields) => {
    delete r.projects;
    Object.assign(r, fields);
    w.access.getByName('hacksprint-2026-10-18').storage.m.set(`req:${r.id}`, r);
  };
  // Used one project (confirmed) before the quota changed.
  const a = await approvedWithProject(w);
  const as = slots(w, a.id)[0];
  legacy(rec(w, a.id), { projectRequestId: as, holds: 0, confirmed: true });
  const st = await status(w, a.cookie);
  assert.equal(st.j.request.maxProjects, 10); assert.equal(st.j.request.usedProjects, 1); assert.equal(st.j.canCreate, true);
  const listed = (await call(w, 'GET', '/api/cloudbite/access/requests', { headers: owner() })).j.requests.find((q) => q.id === a.id);
  assert.equal(listed.usedProjects, 1); assert.equal(listed.maxProjects, 10);
  assert.equal(rec(w, a.id).projectRequestId, as, 'reads do not rewrite the record');
  const retry = await create(w, a.brief, { cookie: a.cookie });
  assert.equal(retry.status, 201); assert.equal(retry.j.project.id, a.pid, 'the legacy binding is the same slot');
  const after = rec(w, a.id);
  assert.deepEqual(after.projects, [{ id: as, holds: 0, confirmed: true }]);
  assert.equal('projectRequestId' in after || 'holds' in after || 'confirmed' in after, false, 'migrated on write');
  assert.equal((await create(w, brief(), { cookie: a.cookie })).status, 201);
  assert.equal((await status(w, a.cookie)).j.request.usedProjects, 2);
  // A legacy create still in flight: its confirm and release act on that slot only.
  const b = await visitor(w); await act(w, b.id, 'approve');
  const bs = sha('legacy-inflight');
  legacy(rec(w, b.id), { projectRequestId: bs, holds: 2 });
  assert.equal((await status(w, b.cookie)).j.request.usedProjects, 1);
  await inboxOf(w).release(b.id, bs);
  assert.deepEqual(rec(w, b.id).projects, [{ id: bs, holds: 1 }], 'another attempt is still in flight');
  await inboxOf(w).release(b.id, bs);
  assert.deepEqual(rec(w, b.id).projects, [], 'last unconfirmed attempt released → slot free');
  const c = await visitor(w); await act(w, c.id, 'approve');
  legacy(rec(w, c.id), { projectRequestId: bs, holds: 1 });
  await inboxOf(w).confirm(c.id, bs);
  assert.deepEqual(rec(w, c.id).projects, [{ id: bs, holds: 0, confirmed: true }]);
  // Legacy reserve of a new id keeps the old slot.
  const d = await visitor(w); await act(w, d.id, 'approve');
  legacy(rec(w, d.id), { projectRequestId: bs, holds: 0, confirmed: true });
  assert.equal((await inboxOf(w).reserve(sha(credOf(d.cookie)), sha('d2'), 1)).fresh, true);
  assert.deepEqual(slots(w, d.id), [bs, sha('d2')]);
  // Legacy refunded record (binding cleared, tombstones kept) and a legacy failed binding that is refunded now.
  const e = await approvedWithProject(w);
  const es = slots(w, e.id)[0];
  legacy(rec(w, e.id), { projectRequestId: es, holds: 0, confirmed: true, refunds: 2, refunded: [sha('old1'), sha('old2')] });
  shape(w, e.pid);
  const es1 = await status(w, e.cookie);
  assert.equal(es1.j.request.usedProjects, 0); assert.equal(rec(w, e.id).refunds, 3);
  assert.deepEqual(rec(w, e.id).refunded, [sha('old1'), sha('old2'), es]);
  assert.equal((await create(w, e.brief, { cookie: e.cookie })).status, 409, 'tombstone kept: the refunded run never rebinds');
  assert.equal((await inboxOf(w).reserve(sha(credOf(e.cookie)), sha('old1'), 1)).status, 409, 'legacy tombstone still refuses');
  const g = await approvedWithProject(w);
  legacy(rec(w, g.id), { projectRequestId: undefined, holds: 0, confirmed: false, refunds: 1, refunded: [slots(w, g.id)[0]] });
  delete rec(w, g.id).projectRequestId;
  const gs = await status(w, g.cookie);
  assert.equal(gs.j.request.usedProjects, 0); assert.equal(gs.j.canCreate, true);
  assert.equal((await create(w, g.brief, { cookie: g.cookie })).status, 409);
  // Legacy record that expired or was revoked stays dead.
  const h = await approvedWithProject(w);
  legacy(rec(w, h.id), { projectRequestId: slots(w, h.id)[0], holds: 0, confirmed: true });
  await act(w, h.id, 'revoke');
  assert.equal((await create(w, brief(), { cookie: h.cookie })).status, 401);
  assert.equal((await status(w, h.cookie)).j.canCreate, false);
  assert.ok(!JSON.stringify(records(w)).includes(credOf(a.cookie)), 'no plaintext credential stored');
});

await check('per-slot confirm/release interleavings: each acts only on its own id', async () => {
  const w = world();
  const v = await visitor(w); await act(w, v.id, 'approve');
  const cred = sha(credOf(v.cookie)), box = inboxOf(w);
  const [A, B, C] = ['A', 'B', 'C'].map((x) => sha('slot' + x));
  await Promise.all([box.reserve(cred, A, 1), box.reserve(cred, B, 1), box.reserve(cred, A, 1), box.reserve(cred, C, 1)]);
  const hold = () => Object.fromEntries(rec(w, v.id).projects.map((b) => [b.id, [b.holds, !!b.confirmed]]));
  assert.deepEqual(hold(), { [A]: [2, false], [B]: [1, false], [C]: [1, false] });
  await Promise.all([box.release(v.id, A), box.confirm(v.id, B), box.release(v.id, C)]);
  assert.deepEqual(hold(), { [A]: [1, false], [B]: [0, true] });
  await Promise.all([box.release(v.id, B), box.confirm(v.id, A), box.confirm(v.id, sha('never'))]);
  assert.deepEqual(hold(), { [A]: [0, true], [B]: [0, true] }, 'release never frees a confirmed slot; unknown ids are ignored');
  await box.release(v.id, A);
  assert.deepEqual(hold(), { [A]: [0, true], [B]: [0, true] });
  assert.equal((await status(w, v.cookie)).j.request.usedProjects, 2);
  // Release of a slot freed concurrently with a reserve of the same id: the reserve wins its own slot back.
  await Promise.all([box.release(v.id, C), box.reserve(cred, C, 1)]);
  assert.equal(rec(w, v.id).projects.find((b) => b.id === C)?.holds, 1);
});

rmSync(tmp, { recursive: true, force: true });
console.log(`cloudbite-access: ${count} checks passed`);
