// Cloudbite persistent owner session (docs/cloudbite/owner-session.txt) through the REAL Worker router, the REAL State DO
// (WebAuthn ceremony, credential store) and the REAL CloudbiteAccess / CloudbiteProject DOs over memory storage that yields on
// every call. The security key is a software P-256 authenticator producing real signed assertions — this is not a hardware
// or browser GUI proof. No network: global fetch counts and throws; alarms are never run.
//   node test/cloudbite-owner.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { build } from 'esbuild';
import { isoCBOR } from '@simplewebauthn/server/helpers';

const stubs = { name: 'stubs', setup(b) {
  b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'cf', namespace: 'stub' }));
  b.onLoad({ filter: /^cf$/, namespace: 'stub' }, () => ({ contents: 'export class DurableObject { constructor(ctx,env){this.ctx=ctx;this.env=env;} }' }));
} };
const entry = `export { default, State, CloudbiteProject, CloudbiteAccess } from './src/index.ts'; export { CLOUDBITE_EXPERTS } from './src/cloudbite-personas.ts';`;
const tmp = mkdtempSync(join(tmpdir(), 'cloudbite-owner-'));
const bundle = await build({ stdin: { contents: entry, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, format: 'esm', platform: 'node', plugins: [stubs], loader: { '.ps1': 'text' } });
writeFileSync(join(tmp, 'm.mjs'), bundle.outputFiles[0].text);
const M = await import(pathToFileURL(join(tmp, 'm.mjs')));
let fetches = 0;
globalThis.fetch = async (u) => { fetches++; throw new Error('network forbidden in this test: ' + u); };

let count = 0;
const check = async (name, f) => { await f(); count++; console.log('ok', name); };
const sha = (s) => createHash('sha256').update(s).digest('hex');
const sha256 = (b) => createHash('sha256').update(b).digest();
const OPERATOR = 'cbo_' + randomBytes(32).toString('base64url');
const HOUR = 3600_000;
const ORIGIN_URL = 'https://cb.test', RP = 'cb.test';
const realNow = Date.now;
let clockOffset = 0;
Date.now = () => realNow() + clockOffset;

function memStorage() {
  const m = new Map(); const clone = (v) => (v === undefined ? undefined : structuredClone(v));
  const s = {
    m,
    async get(k) { await null; return Array.isArray(k) ? new Map(k.filter((x) => m.has(x)).map((x) => [x, clone(m.get(x))])) : clone(m.get(k)); },
    async put(k, v) { await null; for (const [a, b] of typeof k === 'object' ? Object.entries(k) : [[k, v]]) m.set(a, clone(b)); },
    async delete(k) { await null; const ks = Array.isArray(k) ? k : [k]; assert.ok(ks.length <= 128, 'delete batch over the per-call key limit'); let n = 0; for (const x of ks) if (m.delete(x)) n++; return Array.isArray(k) ? n : n > 0; },
    async list({ prefix = '' } = {}) { await null; return new Map([...m].filter(([k]) => k.startsWith(prefix)).sort().map(([k, v]) => [k, clone(v)])); },
    async transaction(f) { return f(s); },
    async getAlarm() { return null; }, async setAlarm() {}, async deleteAlarm() {}, async deleteAll() { m.clear(); },
  };
  return s;
}
const ctxOf = (storage, name) => ({ storage, id: { name }, blockConcurrencyWhile: async (f) => f(), waitUntil() {} });

class SoftKey {
  constructor({ origin = ORIGIN_URL, rpId } = {}) {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.priv = privateKey;
    const jwk = publicKey.export({ format: 'jwk' });
    this.cose = isoCBOR.encode(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]));
    this.id = randomBytes(16).toString('base64url');
    this.counter = 0; this.origin = origin; this.rpId = rpId;
  }
  stored(createdAt = Date.now()) { return { id: this.id, publicKey: Buffer.from(this.cose).toString('base64url'), counter: 0, label: 'soft', createdAt }; }
  get(opts, { flags = 0x05, origin = this.origin, rpId = this.rpId ?? opts.rpId, type = 'webauthn.get' } = {}) {
    const cdj = Buffer.from(JSON.stringify({ type, challenge: opts.challenge, origin, crossOrigin: false }));
    const ctr = Buffer.alloc(4); ctr.writeUInt32BE(++this.counter);
    const authData = Buffer.concat([sha256(rpId), Buffer.from([flags]), ctr]);
    const sig = sign('sha256', Buffer.concat([authData, sha256(cdj)]), this.priv);
    return { id: this.id, rawId: this.id, type: 'public-key', clientExtensionResults: {},
      response: { clientDataJSON: Buffer.from(cdj).toString('base64url'), authenticatorData: authData.toString('base64url'), signature: sig.toString('base64url') } };
  }
}

function world(envOver = {}) {
  const w = { now: 1_900_000_000_000 };
  const ns = (Cls) => { const objects = new Map(); return { objects, getByName(name) { if (!objects.has(name)) { const storage = memStorage(); objects.set(name, new Cls(ctxOf(storage, name), w.env)); objects.get(name).storage = storage; } return objects.get(name); } }; };
  class TestAccess extends M.CloudbiteAccess { clock() { return w.now; } }
  w.stateStorage = memStorage();
  // A new State instance over the same storage = the DO was evicted and reconstructed.
  w.rebuild = () => { w.state = new M.State(ctxOf(w.stateStorage, 'main'), w.env); };
  w.projects = ns(M.CloudbiteProject);
  w.access = ns(TestAccess);
  w.env = {
    ORIGIN: ORIGIN_URL, LAB_ORIGIN: 'https://lab.cloudbite.invalid', RP_ID: RP, MASTER_KEY: 'k',
    STATE: { idFromName: () => 'main', get: () => w.state }, CLOUDBITE: w.projects, CLOUDBITE_ACCESS: w.access,
    CLOUDBITE_DAYTONA_API_URL: 'https://dt.fake', CLOUDBITE_DAYTONA_API_KEY: 'DT-SECRET', CLOUDBITE_NOSANA_BASE_URL: 'https://nosana.fake/v1',
    CLOUDBITE_NOSANA_API_KEY: 'NOSANA-SECRET', CLOUDBITE_NOSANA_MODEL: 'm', CLOUDBITE_GATEWAY_URL: 'https://gw.fake',
    CLOUDBITE_OPERATOR_TOKEN_HASH: sha(OPERATOR), CLOUDBITE_OPERATOR_EXPIRES_AT: String(realNow() + 1000 * HOUR),
    ...envOver,
  };
  w.rebuild();
  w.key = new SoftKey({ origin: w.env.ORIGIN, rpId: w.env.RP_ID });
  w.enroll = async (key = w.key, createdAt) => { await w.stateStorage.put(`cred:${key.id}`, key.stored(createdAt)); };
  return w;
}
async function call(w, method, path, { body, headers = {}, raw, base = w.env.ORIGIN } = {}) {
  const init = { method, headers: { ...headers } };
  if (body !== undefined) { init.body = raw ?? JSON.stringify(body); init.headers['content-type'] ??= 'application/json'; }
  const r = await M.default.fetch(new Request(base + path, init), w.env, { waitUntil() {} });
  const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch {}
  return { status: r.status, j, text, cookie: r.headers.get('set-cookie') };
}
const ORIGIN = { origin: ORIGIN_URL };
const jar = (setCookie) => setCookie.split(';')[0];
const valueOf = (c) => c.split('=')[1];
const options = (w, headers = ORIGIN, body = {}) => call(w, 'POST', '/api/cloudbite/owner/options', { body, headers });
const login = (w, response, headers = ORIGIN) => call(w, 'POST', '/api/cloudbite/owner/login', { body: { response }, headers });
const logout = (w, cookie, headers = ORIGIN) => call(w, 'POST', '/api/cloudbite/owner/logout', { body: {}, headers: { ...headers, ...(cookie ? { cookie } : {}) } });
const session = (w, cookie) => call(w, 'GET', '/api/cloudbite/owner/session', { headers: cookie ? { cookie } : {} });
/** One full ceremony: options → software-key assertion → login. Returns the cookie header to send back. */
async function signIn(w, key = w.key) {
  const o = await options(w); assert.equal(o.status, 200, o.text);
  const r = await login(w, key.get(o.j)); assert.equal(r.status, 200, r.text);
  return { cookie: jar(r.cookie), res: r };
}
const ownerSessions = (w) => [...w.stateStorage.m.keys()].filter((k) => k.startsWith('cbown:'));
async function visitor(w, ip = '203.0.113.' + Math.floor(Math.random() * 250)) {
  const r = await call(w, 'POST', '/api/cloudbite/access/requests', { body: { name: 'Visitor', purpose: 'try Cloudbite' }, headers: { ...ORIGIN, 'cf-connecting-ip': ip } });
  assert.equal(r.status, 201, r.text);
  return { cookie: jar(r.cookie), id: r.j.request.id };
}
const act = (w, id, action, headers) => call(w, 'POST', `/api/cloudbite/access/requests/${id}/${action}`, { body: {}, headers: { ...ORIGIN, ...headers } });
const list = (w, headers) => call(w, 'GET', '/api/cloudbite/access/requests', { headers });
const ids = M.CLOUDBITE_EXPERTS.map((e) => e.id);
const brief = (over = {}) => ({ title: 'Owner run', objective: 'Should we launch?', context: '', expertIds: ids.slice(0, 2), mode: 'demo', requestId: 'req-' + randomBytes(6).toString('hex'), ...over });
const create = (w, b, headers) => call(w, 'POST', '/api/cloudbite/projects', { body: b, headers: { ...ORIGIN, ...headers } });

await check('session: unauthenticated is 200 false; hasCredentials is only a boolean', async () => {
  const w = world();
  let s = await session(w);
  assert.equal(s.status, 200); assert.deepEqual(s.j, { authenticated: false, hasCredentials: false }); assert.equal(s.cookie, null);
  await w.enroll();
  s = await session(w);
  assert.deepEqual(s.j, { authenticated: false, hasCredentials: true });
  assert.ok(!s.text.includes(w.key.id), 'no credential id');
  for (const cookie of ['__Host-cb-owner=nope', '__Host-cb-owner=cbown_' + 'A'.repeat(43), 'cb-owner-dev=cbown_' + 'A'.repeat(43), '__Host-cb-access=cbv_' + 'A'.repeat(43)])
    assert.deepEqual((await session(w, cookie)).j, { authenticated: false, hasCredentials: true }, cookie);
  assert.equal((await call(w, 'POST', '/api/cloudbite/owner/session', { body: {}, headers: ORIGIN })).status, 405);
  assert.equal((await call(w, 'GET', '/api/cloudbite/owner/other')).status, 404);
});

await check('options: exact Origin, JSON {}, bounded body; raw request options bound to the owner purpose with UV + security-key hint', async () => {
  const w = world();
  assert.equal((await options(w)).status, 409, 'no registered key → nothing to sign');
  await w.enroll();
  assert.equal((await options(w, { origin: 'https://evil.test' })).status, 403);
  assert.equal((await options(w, {})).status, 403);
  assert.equal((await call(w, 'POST', '/api/cloudbite/owner/options', { body: {}, headers: { ...ORIGIN, 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await options(w, ORIGIN, { x: 1 })).status, 400);
  assert.equal((await options(w, ORIGIN, { pad: 'x'.repeat(400) })).status, 413);
  assert.equal((await call(w, 'POST', '/api/cloudbite/owner/options', { body: {}, raw: '{oops', headers: ORIGIN })).status, 400);
  assert.equal((await call(w, 'GET', '/api/cloudbite/owner/options')).status, 405);
  const o = await options(w);
  assert.equal(o.status, 200);
  assert.equal(o.j.rpId, RP); assert.equal(o.j.userVerification, 'required'); assert.deepEqual(o.j.hints, ['security-key']);
  assert.deepEqual(o.j.allowCredentials.map((c) => c.id), [w.key.id]);
  assert.ok(w.stateStorage.m.has(`wch:cloudbite-owner|${o.j.challenge}`), 'challenge stored under its own purpose');
  // Rate guard: State's per-source challenge cap (16) applies to this route as well.
  const src = { ...ORIGIN, 'cf-connecting-ip': '198.51.100.7' };
  for (let i = 0; i < 16; i++) assert.equal((await options(w, src)).status, 200);
  assert.equal((await options(w, src)).status, 429);
  assert.equal((await options(w, { ...ORIGIN, 'cf-connecting-ip': '198.51.100.8' })).status, 200, 'another source is unaffected');
  assert.ok(![...w.stateStorage.m.values()].some((v) => JSON.stringify(v).includes('198.51.100')), 'no raw address stored');
});

await check('login: only a valid signed assertion on an owner challenge mints a session (origin, RP, UV, purpose, replay, unknown key)', async () => {
  const w = world();
  await w.enroll();
  const refused = async (resp, why, status = 401) => {
    const r = await login(w, resp);
    assert.equal(r.status, status, why + ' ' + r.text); assert.equal(r.cookie, null, why + ': no cookie'); assert.equal(ownerSessions(w).length, 0, why + ': no session');
    return r;
  };
  let o = await options(w);
  await refused(w.key.get(o.j, { origin: 'https://evil.test' }), 'wrong origin');
  await refused(w.key.get(o.j, { rpId: 'evil.test' }), 'wrong RP id');
  await refused(w.key.get(o.j, { flags: 0x01 }), 'no user verification');
  await refused(w.key.get(o.j, { type: 'webauthn.create' }), 'wrong ceremony type');
  const bad = w.key.get(o.j); bad.response.signature = w.key.get(o.j).response.signature.replace(/^./, (c) => (c === 'A' ? 'B' : 'A'));
  await refused(bad, 'bad signature');
  await refused(new SoftKey().get(o.j), 'unregistered key');
  await refused({}, 'empty assertion');
  await refused({ id: w.key.id, response: { clientDataJSON: 'x' } }, 'malformed assertion');
  await refused('nope', 'non-object', 400);
  await refused(null, 'null', 400);
  // The generic admin challenge cannot be redeemed here (and an owner challenge cannot log into /admin).
  const adminOpts = await w.state.adminOptions('src-test-1');
  await refused(w.key.get(adminOpts), 'admin-purpose challenge');
  assert.ok(w.stateStorage.m.has(`wch:admin|${adminOpts.challenge}`), 'a refused owner login does not consume the admin ceremony');
  const o2 = await options(w);
  assert.ok('error' in await w.state.adminLogin(w.key.get(o2.j)), 'owner challenge is not an admin login');
  // Fresh assertion on the still-live owner challenge (failed tries above did not consume it) succeeds once.
  const good = w.key.get(o.j);
  const r = await login(w, good);
  assert.equal(r.status, 200, r.text); assert.deepEqual(r.j, { authenticated: true, hasCredentials: true });
  assert.match(r.cookie, /^__Host-cb-owner=cbown_[A-Za-z0-9_-]{43}; Path=\/; Max-Age=34560000; HttpOnly; SameSite=Strict; Secure$/);
  assert.equal(ownerSessions(w).length, 1);
  // Replay of the same signed assertion (and of the same challenge with a new signature) is refused.
  const again = await login(w, good);
  assert.equal(again.status, 401); assert.equal(again.cookie, null);
  assert.equal((await login(w, w.key.get(o.j))).status, 401);
  assert.equal(ownerSessions(w).length, 1);
  // Body guards.
  o = await options(w);
  assert.equal((await login(w, w.key.get(o.j), { origin: 'https://evil.test' })).status, 403);
  assert.equal((await login(w, w.key.get(o.j), {})).status, 403);
  assert.equal((await call(w, 'POST', '/api/cloudbite/owner/login', { body: { response: w.key.get(o.j), admin: true }, headers: ORIGIN })).status, 400);
  assert.equal((await call(w, 'POST', '/api/cloudbite/owner/login', { body: { response: w.key.get(o.j), pad: 'x'.repeat(33 * 1024) }, headers: ORIGIN })).status, 413);
  assert.equal(ownerSessions(w).length, 1, 'guards mint nothing');
  // Only the hash is stored; the plaintext never appears in JSON or storage.
  const plain = valueOf(jar(r.cookie));
  assert.ok(!r.text.includes(plain));
  assert.ok(!JSON.stringify([...w.stateStorage.m]).includes(plain), 'plaintext credential is not stored');
  assert.equal(ownerSessions(w)[0], 'cbown:' + sha(`cloudbite-owner-session-v1|${plain}`));
});

await check('anonymous, cbo_ operator, visitor or legacy admin token alone never mint an owner session', async () => {
  const w = world();
  await w.enroll();
  const admin = (await w.state.newAdminToken('web')).token;
  const v = await visitor(w);
  for (const headers of [{}, { 'x-admin-token': OPERATOR }, { 'x-admin-token': admin }, { cookie: v.cookie }, { authorization: `Bearer ${OPERATOR}` }]) {
    const r = await call(w, 'POST', '/api/cloudbite/owner/login', { body: { response: {} }, headers: { ...ORIGIN, ...headers } });
    assert.equal(r.status, 401); assert.equal(r.cookie, null);
    assert.deepEqual((await session(w, headers.cookie)).j, { authenticated: false, hasCredentials: true });
  }
  assert.equal(ownerSessions(w).length, 0);
});

await check('reload / new tab / restart: the cookie stays valid past 8 hours and across DO reconstruction; session renews retention only', async () => {
  const w = world();
  await w.enroll();
  const { cookie } = await signIn(w);
  const s = await session(w, cookie);
  assert.deepEqual(s.j, { authenticated: true, hasCredentials: true });
  assert.equal(jar(s.cookie), cookie, 'same credential, never a new one');
  assert.match(s.cookie, /Max-Age=34560000; HttpOnly; SameSite=Strict; Secure$/);
  assert.ok(!s.text.includes(valueOf(cookie)));
  try {
    clockOffset = 9 * HOUR; w.rebuild();
    assert.deepEqual((await session(w, cookie)).j, { authenticated: true, hasCredentials: true }, 'past 8h after DO rebuild');
    clockOffset = 30 * 24 * HOUR; w.rebuild();
    const v = await visitor(w);
    assert.equal((await act(w, v.id, 'approve', { cookie })).status, 200, 'owner approves a month later');
    // Legacy admin sessions keep their 8-hour expiry.
    clockOffset = 0;
    const admin = (await w.state.newAdminToken('web')).token;
    clockOffset = 9 * HOUR;
    assert.ok('error' in await w.state.adminList(admin), 'legacy admin session still expires at 8h');
  } finally { clockOffset = 0; }
});

await check('owner cookie: inbox list/approve/deny/revoke and project creation; no cookie → 401; bad Origin still 403', async () => {
  const w = world();
  await w.enroll();
  const { cookie } = await signIn(w);
  assert.equal((await list(w, {})).status, 401);
  const l = await list(w, { cookie });
  assert.equal(l.status, 200); assert.deepEqual(l.j.requests, []);
  const policy = (body, headers = { ...ORIGIN, cookie }) => call(w, 'POST', '/api/cloudbite/access/policy', { body, headers });
  assert.deepEqual((await policy({ autoApprove: true })).j, { autoApprove: true }, 'real WebAuthn owner cookie can enable auto-approval');
  const auto = await visitor(w);
  assert.equal((await call(w, 'GET', '/api/cloudbite/access/status', { headers: { cookie: auto.cookie } })).j.canCreate, true);
  assert.equal((await policy({ autoApprove: false }, { ...ORIGIN, cookie, 'x-admin-token': '' })).status, 401, 'explicit empty token does not fall back');
  assert.equal((await policy({ autoApprove: false }, { ...ORIGIN, cookie: auto.cookie })).status, 401, 'visitor cannot change policy');
  assert.deepEqual((await policy({ autoApprove: false })).j, { autoApprove: false });
  await act(w, auto.id, 'revoke', { cookie });
  const a = await visitor(w), b = await visitor(w), c = await visitor(w);
  assert.equal((await act(w, a.id, 'approve', {})).status, 401, 'no cookie, no header');
  assert.equal((await call(w, 'POST', `/api/cloudbite/access/requests/${a.id}/approve`, { body: {}, headers: { origin: 'https://evil.test', cookie } })).status, 403);
  assert.equal((await act(w, a.id, 'approve', { cookie })).status, 200);
  assert.equal((await act(w, b.id, 'deny', { cookie })).status, 200);
  assert.equal((await act(w, c.id, 'approve', { cookie })).status, 200);
  assert.equal((await act(w, c.id, 'revoke', { cookie })).status, 200);
  assert.equal((await list(w, { cookie })).j.requests.length, 4);
  // Owner creation with no visitor cookie at all, and beside a visitor cookie it consumes no visitor slot.
  const r = await create(w, brief({ expertIds: ids.slice(0, 5) }), { cookie });
  assert.equal(r.status, 201, r.text);
  assert.equal((await create(w, brief(), { cookie: `${cookie}; ${a.cookie}` })).status, 201);
  const st = await call(w, 'GET', '/api/cloudbite/access/status', { headers: { cookie: a.cookie } });
  assert.equal(st.j.request.usedProjects, 0, 'owner creation is not a visitor slot');
  assert.equal((await create(w, brief(), {})).status, 401, 'no authority at all');
  assert.equal(fetches, 0, 'no paid provider call');
});

await check('x-admin-token precedence: an invalid or empty header never falls back to a valid owner (or visitor) cookie', async () => {
  const w = world();
  await w.enroll();
  const { cookie } = await signIn(w);
  const v = await visitor(w);
  assert.equal((await act(w, v.id, 'approve', { cookie: `${cookie}; ${v.cookie}` })).status, 200);
  for (const t of ['', 'wrong', 'cbo_' + 'A'.repeat(43)]) {
    assert.equal((await list(w, { cookie, 'x-admin-token': t })).status, 401, JSON.stringify(t));
    assert.equal((await act(w, v.id, 'revoke', { cookie, 'x-admin-token': t })).status, 401, JSON.stringify(t));
    assert.equal((await create(w, brief(), { cookie, 'x-admin-token': t })).status, 401, JSON.stringify(t));
    assert.equal((await create(w, brief(), { cookie: `${cookie}; ${v.cookie}`, 'x-admin-token': t })).status, 401, JSON.stringify(t));
    assert.equal((await create(w, brief(), { cookie: v.cookie, 'x-admin-token': t })).status, 401, 'approved visitor: ' + JSON.stringify(t));
  }
  const st = await call(w, 'GET', '/api/cloudbite/access/status', { headers: { cookie: v.cookie } });
  assert.equal(st.j.request.status, 'approved', 'refused header calls revoked nothing');
  assert.equal(st.j.request.usedProjects, 0, 'refused header calls used no visitor slot');
  assert.equal((await list(w, { cookie })).status, 200, 'missing header: owner cookie still decides');
  assert.equal((await create(w, brief(), { cookie: v.cookie })).status, 201, 'missing header: visitor cookie still decides');
  assert.equal((await list(w, { 'x-admin-token': OPERATOR })).status, 200, 'valid header unchanged');
  const admin = (await w.state.newAdminToken('web')).token;
  assert.equal((await list(w, { 'x-admin-token': admin })).status, 200, 'legacy admin header unchanged');
});

await check('the owner cookie opens nothing outside Cloudbite (legacy admin / vault / lab)', async () => {
  const w = world();
  await w.enroll();
  const { cookie } = await signIn(w);
  for (const path of ['/api/admin/list', '/api/admin/revoke', '/api/admin/cred-delete', '/api/lab/config', '/api/vault/put']) {
    const r = await call(w, 'POST', path, { body: {}, headers: { ...ORIGIN, cookie } });
    assert.ok(r.status === 401 || r.status === 403 || r.status === 404, `${path} ${r.status} ${r.text}`);
    assert.ok(!r.j || !('sessions' in r.j), path);
  }
  assert.ok(w.stateStorage.m.has(`cred:${w.key.id}`), 'credential untouched');
});

await check('logout: revokes server-side first, clears the cookie, idempotent; a copied cookie is dead afterwards', async () => {
  const w = world();
  await w.enroll();
  const { cookie } = await signIn(w);
  const stolen = cookie;
  assert.equal((await logout(w, cookie, { origin: 'https://evil.test' })).status, 403);
  assert.equal((await logout(w, cookie, {})).status, 403);
  assert.equal((await call(w, 'POST', '/api/cloudbite/owner/logout', { body: { x: 1 }, headers: { ...ORIGIN, cookie } })).status, 400);
  assert.deepEqual((await session(w, cookie)).j.authenticated, true, 'refused logouts revoke nothing');
  const r = await logout(w, cookie);
  assert.equal(r.status, 200); assert.deepEqual(r.j, { authenticated: false });
  assert.match(r.cookie, /^__Host-cb-owner=; Path=\/; Max-Age=0; HttpOnly; SameSite=Strict; Secure$/);
  assert.equal(ownerSessions(w).length, 0);
  assert.deepEqual((await session(w, stolen)).j, { authenticated: false, hasCredentials: true });
  assert.equal((await session(w, stolen)).cookie, null, 'a dead cookie is not renewed');
  const v = await visitor(w);
  assert.equal((await act(w, v.id, 'approve', { cookie: stolen })).status, 401);
  assert.equal((await create(w, brief(), { cookie: stolen })).status, 401);
  assert.equal((await logout(w, stolen)).status, 200, 'repeat logout');
  assert.equal((await logout(w, null)).status, 200, 'logout without cookie');
  // A State failure during logout keeps the cookie (nothing claims a revocation that did not happen).
  const again = await signIn(w);
  const real = w.state.cloudbiteOwnerLogout;
  w.state.cloudbiteOwnerLogout = async () => { throw new Error('boom'); };
  const failed = await logout(w, again.cookie);
  w.state.cloudbiteOwnerLogout = real;
  assert.equal(failed.status, 503); assert.equal(failed.cookie, null); assert.ok(!failed.text.includes('boom'));
  assert.equal((await session(w, again.cookie)).j.authenticated, true);
});

await check('credential deletion (and re-registering the same id) invalidates its sessions; other keys\' sessions survive', async () => {
  const w = world();
  await w.enroll();
  const other = new SoftKey({ origin: w.env.ORIGIN, rpId: w.env.RP_ID });
  await w.enroll(other);
  const mine = (await signIn(w)).cookie;
  const theirs = (await signIn(w, other)).cookie;
  const admin = (await w.state.newAdminToken('web')).token;
  assert.equal((await call(w, 'POST', '/api/admin/cred-delete', { body: { id: w.key.id }, headers: { ...ORIGIN, 'x-admin-token': admin } })).status, 200);
  assert.deepEqual((await session(w, mine)).j, { authenticated: false, hasCredentials: true });
  const v = await visitor(w);
  assert.equal((await act(w, v.id, 'approve', { cookie: mine })).status, 401);
  assert.equal((await act(w, v.id, 'approve', { cookie: theirs })).status, 200, 'other key session unaffected');
  // Re-registered under the same credential id later: the old session stays dead.
  const signed = (await signIn(w, other)).cookie;
  await w.enroll(w.key, Date.now() + 1);
  assert.deepEqual((await session(w, mine)).j.authenticated, false);
  assert.ok(ownerSessions(w).length >= 2 && (await session(w, signed)).j.authenticated);
  // All keys gone → nothing authenticates.
  await w.stateStorage.delete([`cred:${w.key.id}`, `cred:${other.id}`]);
  assert.deepEqual((await session(w, theirs)).j, { authenticated: false, hasCredentials: false });
});

await check('a dead owner cookie never promotes a visitor; visitor quota rules stay intact beside it', async () => {
  const w = world();
  await w.enroll();
  const { cookie } = await signIn(w);
  await logout(w, cookie);
  const v = await visitor(w);
  const op = { 'x-admin-token': OPERATOR };
  assert.equal((await act(w, v.id, 'approve', op)).status, 200);
  const both = `${cookie}; ${v.cookie}`;
  const r = await create(w, brief(), { cookie: both });
  assert.equal(r.status, 201, r.text);
  const st = await call(w, 'GET', '/api/cloudbite/access/status', { headers: { cookie: v.cookie } });
  assert.equal(st.j.request.usedProjects, 1, 'counted as a visitor slot');
  assert.equal((await list(w, { cookie: both })).status, 401, 'visitor cookie is no owner');
  assert.equal((await create(w, brief(), { cookie })).status, 401, 'dead owner cookie alone');
});

await check('re-login rotates this browser\'s session; at 16 sessions a new login is 409 and no existing session ends', async () => {
  const w = world();
  await w.enroll();
  const first = (await signIn(w)).cookie;
  const o = await options(w);
  const r = await call(w, 'POST', '/api/cloudbite/owner/login', { body: { response: w.key.get(o.j) }, headers: { ...ORIGIN, cookie: first } });
  assert.equal(r.status, 200);
  assert.notEqual(jar(r.cookie), first);
  assert.equal((await session(w, first)).j.authenticated, false, 'previous credential of this browser ended');
  assert.equal(ownerSessions(w).length, 1);
  const relogin = async (cookie) => { const o = await options(w); return call(w, 'POST', '/api/cloudbite/owner/login', { body: { response: w.key.get(o.j) }, headers: { ...ORIGIN, ...(cookie ? { cookie } : {}) } }); };
  const cookies = [jar(r.cookie)];
  for (let i = 0; i < 15; i++) { cookies.push((await signIn(w)).cookie); clockOffset += 1; }
  clockOffset = 0;
  assert.equal(ownerSessions(w).length, 16);
  const before = ownerSessions(w);
  // 17th new browser: refused with no cookie, and nothing is revoked (the oldest stays valid).
  const full = await relogin(null);
  assert.equal(full.status, 409, full.text); assert.equal(full.cookie, null); assert.deepEqual(Object.keys(full.j), ['error']);
  assert.deepEqual(ownerSessions(w), before);
  assert.equal((await session(w, cookies[0])).j.authenticated, true, 'oldest kept');
  // A missing / unknown / malformed / already-dead prior session cannot free a slot.
  for (const fake of ['__Host-cb-owner=cbown_' + 'A'.repeat(43), '__Host-cb-owner=nope', first]) {
    const x = await relogin(fake);
    assert.equal(x.status, 409, fake); assert.equal(x.cookie, null, fake);
  }
  assert.deepEqual(ownerSessions(w), before);
  for (const c of cookies) assert.equal((await session(w, c)).j.authenticated, true);
  // A real prior session of this browser rotates at capacity: the old cookie dies, the count stays 16.
  const rot = await relogin(cookies[0]);
  assert.equal(rot.status, 200, rot.text);
  assert.equal((await session(w, cookies[0])).j.authenticated, false, 'rotated cookie is dead');
  assert.equal((await session(w, jar(rot.cookie))).j.authenticated, true);
  assert.equal(ownerSessions(w).length, 16);
  assert.equal((await relogin(cookies[0])).status, 409, 'the rotated-away cookie cannot rotate again');
  // Recovery: an explicit logout frees one slot.
  assert.equal((await logout(w, cookies[1])).status, 200);
  assert.equal((await relogin(null)).status, 200, 'slot freed by logout');
  assert.equal((await relogin(null)).status, 409);
  assert.equal(ownerSessions(w).length, 16);
  // Recovery: re-registering the key ends its sessions, which then no longer hold slots.
  await w.enroll(w.key, Date.now() + 1);
  assert.equal((await relogin(null)).status, 200, 'dead-key sessions do not count');
  assert.equal(ownerSessions(w).length, 1);
});

await check('local http dev only: cb-owner-dev without Secure', async () => {
  const w = world({ ORIGIN: 'http://localhost:8808', RP_ID: 'localhost', CLOUDBITE_ALLOW_HTTP: '1' });
  await w.enroll();
  const o = await call(w, 'POST', '/api/cloudbite/owner/options', { body: {}, headers: { origin: 'http://localhost:8808' } });
  const r = await call(w, 'POST', '/api/cloudbite/owner/login', { body: { response: w.key.get(o.j) }, headers: { origin: 'http://localhost:8808' } });
  assert.equal(r.status, 200, r.text);
  assert.match(r.cookie, /^cb-owner-dev=cbown_[^;]+; Path=\/; Max-Age=34560000; HttpOnly; SameSite=Strict$/);
  const prod = world({ CLOUDBITE_ALLOW_HTTP: '1' });
  await prod.enroll();
  const p = await signIn(prod);
  assert.match(p.res.cookie, /^__Host-cb-owner=.*; Secure$/, 'the dev flag alone does not drop Secure on https');
});

await check('custom hostname: exact Cloudbite alias, public RP document, no classroom/vault expansion', async () => {
  const alias = 'https://cloudbite.example';
  const w = world({ CLOUDBITE_PUBLIC_ORIGIN: alias });
  const wellKnown = await call(w, 'GET', '/.well-known/webauthn');
  assert.equal(wellKnown.status, 200);
  assert.deepEqual(wellKnown.j, { origins: [ORIGIN_URL, alias] });
  for (const path of ['/', '/cloudbite', '/cloudbite/requests', '/cloudbite/request', '/cloudbite/console.js', '/cloudbite/console.css', '/cloudbite/access.js', '/register', '/webauthn.js'])
    assert.equal((await call(w, 'GET', path, { base: alias })).status, 200, path);
  for (const path of ['/admin', '/vault', '/lab', '/borrow', '/api/admin/options'])
    assert.equal((await call(w, 'GET', path, { base: alias })).status, 404, path);
  assert.equal((await call(w, 'GET', '/', { base: 'https://cloudbite.example.evil.test' })).status, 404);
  for (const bad of ['http://cloudbite.example', 'https://cloudbite.example/path', 'https://name:password@cloudbite.example']) {
    const x = world({ CLOUDBITE_PUBLIC_ORIGIN: bad });
    assert.equal((await call(x, 'GET', '/.well-known/webauthn')).status, 404);
  }
});

await check('custom hostname: existing key + original RP signs the related origin; same DO, approval and logout work', async () => {
  const alias = 'https://cloudbite.example';
  const w = world({ CLOUDBITE_PUBLIC_ORIGIN: alias }); await w.enroll();
  const old = await signIn(w);
  const at = (method, path, body, cookie, origin = alias) => call(w, method, path, {
    base: alias, body, headers: { origin, ...(cookie ? { cookie } : {}) },
  });
  assert.equal((await at('GET', '/api/cloudbite/owner/session')).j.hasCredentials, true);
  const o = await at('POST', '/api/cloudbite/owner/options', {});
  assert.equal(o.status, 200); assert.equal(o.j.rpId, RP);
  const response = w.key.get(o.j, { origin: alias });
  const l = await at('POST', '/api/cloudbite/owner/login', { response });
  assert.equal(l.status, 200, l.text);
  assert.match(l.cookie, /^__Host-cb-owner=.*; Secure$/);
  const cookie = jar(l.cookie);
  assert.equal((await at('GET', '/api/cloudbite/owner/session', undefined, cookie)).j.authenticated, true);
  assert.equal((await session(w, old.cookie)).j.authenticated, true, 'old host session survives');
  const v = await at('POST', '/api/cloudbite/access/requests', { name: 'Domain QA', purpose: 'Test' });
  assert.equal(v.status, 201, v.text);
  assert.equal((await at('POST', `/api/cloudbite/access/requests/${v.j.request.id}/approve`, {}, cookie)).status, 200);
  assert.equal((await at('GET', '/api/cloudbite/access/status', undefined, jar(v.cookie))).j.canCreate, true);
  assert.equal((await at('POST', '/api/cloudbite/projects', brief(), cookie)).status, 201);
  assert.equal((await at('POST', '/api/cloudbite/owner/logout', {}, cookie)).status, 200);
  assert.equal((await at('GET', '/api/cloudbite/owner/session', undefined, cookie)).j.authenticated, false);
  assert.equal((await session(w, old.cookie)).j.authenticated, true);
});

await check('custom hostname: reject mismatched HTTP Origin, forged RP/origin and replay; registration retains original RP', async () => {
  const alias = 'https://cloudbite.example';
  const w = world({ CLOUDBITE_PUBLIC_ORIGIN: alias, SETUP_TOKEN: 'test-only-setup' }); await w.enroll();
  const at = (path, body, origin = alias) => call(w, 'POST', path, { base: alias, body, headers: { origin } });
  assert.equal((await at('/api/cloudbite/owner/options', {}, ORIGIN_URL)).status, 403);
  assert.equal((await at('/api/cloudbite/access/requests', { name: 'x', purpose: 'x' }, 'https://evil.test')).status, 403);
  for (const over of [{ origin: 'https://evil.test' }, { origin: alias, rpId: 'cloudbite.example' }]) {
    const o = await at('/api/cloudbite/owner/options', {});
    assert.equal((await at('/api/cloudbite/owner/login', { response: w.key.get(o.j, over) })).status, 401);
  }
  const o = await at('/api/cloudbite/owner/options', {}), response = w.key.get(o.j, { origin: alias });
  assert.equal((await at('/api/cloudbite/owner/login', { response })).status, 200);
  assert.equal((await at('/api/cloudbite/owner/login', { response })).status, 401);
  const reg = await at('/api/register/options', { setup: 'test-only-setup' });
  assert.equal(reg.status, 200, reg.text); assert.equal(reg.j.rp.id, RP);
  assert.equal((await at('/api/register/options', { setup: 'test-only-setup' }, ORIGIN_URL)).status, 403);
});

console.log(`\n${count} checks passed`);
