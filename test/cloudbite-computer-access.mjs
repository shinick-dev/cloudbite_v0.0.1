// Cloudbite personal-computer phone passkeys (src/cloudbite-computer-access.ts) with the REAL @simplewebauthn/server
// verification over memory storage that yields on every call. The phone is a software P-256 platform authenticator
// producing real attestations ('none') and real signed assertions — this is not a biometric or browser GUI proof.
// The Worker router (Origin/CSRF, body limits, Set-Cookie) is root-owned and not exercised here. No network.
//   node test/cloudbite-computer-access.mjs
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
const entry = `export * from './src/cloudbite-computer-access.ts'; export { ownerCookieValid } from './src/cloudbite-owner.ts';`;
const tmp = mkdtempSync(join(tmpdir(), 'cloudbite-computer-'));
const bundle = await build({ stdin: { contents: entry, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, format: 'esm', platform: 'node', plugins: [stubs], loader: { '.ps1': 'text' } });
writeFileSync(join(tmp, 'm.mjs'), bundle.outputFiles[0].text);
const M = await import(pathToFileURL(join(tmp, 'm.mjs')));
globalThis.fetch = async (u) => { throw new Error('network forbidden in this test: ' + u); };

let count = 0;
const check = async (name, f) => { await f(); count++; console.log('ok', name); };
const sha256 = (b) => createHash('sha256').update(b).digest();
const ORIGIN = 'https://cloudbite.shinick.dev', RP = 'cloudbite.shinick.dev';
const WORKERS_DEV = 'https://cloudbite-v001.ai-gongbu.workers.dev', GATEWAY = 'https://cloudbite-desktop.ai-gongbu.workers.dev';
const DAY = 24 * 3600_000;

function memStorage() {
  const m = new Map(); const clone = (v) => (v === undefined ? undefined : structuredClone(v));
  return {
    m,
    async get(k) { await null; return clone(m.get(k)); },
    async put(k, v) { await null; m.set(k, clone(v)); },
    async delete(k) { await null; const ks = Array.isArray(k) ? k : [k]; assert.ok(ks.length <= 128); let n = 0; for (const x of ks) if (m.delete(x)) n++; return Array.isArray(k) ? n : n > 0; },
    async list({ prefix = '' } = {}) { await null; return new Map([...m].filter(([k]) => k.startsWith(prefix)).sort().map(([k, v]) => [k, clone(v)])); },
  };
}
function world({ identity = { origin: ORIGIN, rpId: RP }, webauthn } = {}) {
  const w = { now: 1_900_000_000_000, storage: memStorage() };
  w.svc = new M.ComputerAccessService({ storage: w.storage, identity: () => identity, now: () => w.now, webauthn });
  return w;
}

/** Software phone: a resident P-256 platform passkey with user verification. */
class SoftPhone {
  constructor({ origin = ORIGIN, rpId = RP, counter = true } = {}) {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.priv = privateKey;
    const jwk = publicKey.export({ format: 'jwk' });
    this.cose = Buffer.from(isoCBOR.encode(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]])));
    this.rawId = randomBytes(16); this.id = this.rawId.toString('base64url');
    this.counter = 0; this.useCounter = counter; this.origin = origin; this.rpId = rpId; this.userHandle = null;
  }
  cdj(type, challenge, origin) { return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false })); }
  ctr() { const b = Buffer.alloc(4); if (this.useCounter) b.writeUInt32BE(++this.counter); return b; }
  create(opts, { flags = 0x45, origin = this.origin, rpId = this.rpId, type = 'webauthn.create' } = {}) {
    this.userHandle = opts.user.id;
    const len = Buffer.alloc(2); len.writeUInt16BE(this.rawId.length);
    const authData = Buffer.concat([sha256(rpId), Buffer.from([flags]), this.ctr(), Buffer.alloc(16), len, this.rawId, this.cose]);
    const att = Buffer.from(isoCBOR.encode(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]])));
    return JSON.stringify({ id: this.id, rawId: this.id, type: 'public-key', clientExtensionResults: {}, authenticatorAttachment: 'platform',
      response: { clientDataJSON: this.cdj(type, opts.challenge, origin).toString('base64url'), attestationObject: att.toString('base64url'), transports: ['internal', 'hybrid', 'future-transport'] } });
  }
  get(opts, { flags = 0x05, origin = this.origin, rpId = this.rpId, type = 'webauthn.get', userHandle = this.userHandle } = {}) {
    const cdj = this.cdj(type, opts.challenge, origin);
    const authData = Buffer.concat([sha256(rpId), Buffer.from([flags]), this.ctr()]);
    const sig = sign('sha256', Buffer.concat([authData, sha256(cdj)]), this.priv);
    return JSON.stringify({ id: this.id, rawId: this.id, type: 'public-key', clientExtensionResults: {}, authenticatorAttachment: 'platform',
      response: { clientDataJSON: cdj.toString('base64url'), authenticatorData: authData.toString('base64url'), signature: sig.toString('base64url'), ...(userHandle ? { userHandle } : {}) } });
  }
}

/** Pair once, then register this phone's passkey from the pair session. Returns the passkey session token. */
async function enrolled(w, phone = new SoftPhone()) {
  const p = await w.svc.issuePairing({ ttlSeconds: 1800 });
  const s = await w.svc.pair(ORIGIN, p.token);
  assert.equal(s.ok, true);
  const o = await w.svc.registerOptions(ORIGIN, s.sessionToken, false);
  assert.equal(o.ok, true, JSON.stringify(o));
  const r = await w.svc.registerVerify(ORIGIN, s.sessionToken, false, phone.create(o.options));
  assert.equal(r.ok, true, JSON.stringify(r));
  return { phone, token: r.sessionToken, pairToken: s.sessionToken };
}
async function login(w, phone, extra = {}) {
  const o = await w.svc.loginOptions(ORIGIN);
  assert.equal(o.ok, true, JSON.stringify(o));
  return { o, r: await w.svc.login(ORIGIN, phone.get(o.options, extra), null) };
}

await check('RP is only the exact public Cloudbite origin from CLOUDBITE_PUBLIC_ORIGIN', async () => {
  assert.deepEqual(M.computerIdentity({ CLOUDBITE_PUBLIC_ORIGIN: ORIGIN }), { origin: ORIGIN, rpId: RP });
  for (const v of [undefined, '', WORKERS_DEV, GATEWAY, 'http://cloudbite.shinick.dev', ORIGIN + '/', ORIGIN + ':443', 'https://evil.cloudbite.shinick.dev', 'https://CLOUDBITE.shinick.dev'])
    assert.equal(M.computerIdentity({ CLOUDBITE_PUBLIC_ORIGIN: v }), null, String(v));
  const w = world({ identity: null });
  assert.deepEqual(await w.svc.loginOptions(ORIGIN), { ok: false, status: 503, error: 'computer sign-in is not configured' });
  assert.equal((await w.svc.issuePairing({ ttlSeconds: 600 })).status, 503);
});

await check('cookie is __Host- host-only HttpOnly Secure SameSite=Strict; only well-formed tokens are read', async () => {
  const t = 'cbpc_' + randomBytes(32).toString('base64url');
  const c = M.computerSetCookie(t, 400 * 86400);
  assert.equal(c, `__Host-cb-pc-owner=${t}; Path=/; Max-Age=34560000; HttpOnly; Secure; SameSite=Strict`);
  assert.ok(!/domain=/i.test(c));
  assert.equal(M.computerClearCookie(), '__Host-cb-pc-owner=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict');
  const req = (cookie) => new Request(ORIGIN, { headers: { cookie } });
  assert.equal(M.computerCookieToken(req(`a=1; __Host-cb-pc-owner=${t}`)), t);
  assert.equal(M.computerCookieToken(req(`__Host-cb-pc-owner=${t}x`)), null);
  assert.equal(M.computerCookieToken(req(`__Host-cb-owner=${t}`)), null);
  // The phone cookie never satisfies the existing owner check: State is not even asked.
  let asked = 0;
  const ownerState = { cloudbiteOwnerCheck: async () => { asked++; return true; } };
  assert.equal(await M.ownerCookieValid(req(`__Host-cb-pc-owner=${t}`), { ORIGIN }, ownerState), false);
  assert.equal(asked, 0);
});

await check('anonymous callers can never start or finish a passkey registration', async () => {
  const w = world(); const phone = new SoftPhone();
  assert.deepEqual(await w.svc.registerOptions(ORIGIN, null, false), { ok: false, status: 401, error: 'sign in to this computer first' });
  assert.equal((await w.svc.registerOptions(ORIGIN, 'cbpc_' + randomBytes(32).toString('base64url'), false)).status, 401);
  const legacy = await w.svc.registerOptions(ORIGIN, null, true);
  assert.equal(legacy.ok, true);
  assert.equal((await w.svc.registerVerify(ORIGIN, null, false, phone.create(legacy.options))).status, 401);
  assert.equal([...w.storage.m.keys()].some((k) => k.startsWith('cred:')), false);
  // The authority boolean is checked strictly (a truthy non-boolean from a careless caller is not authority).
  assert.equal((await w.svc.registerOptions(ORIGIN, null, 'true')).status, 401);
});

await check('registration options: platform, resident key + user verification required, stable random user id, no email', async () => {
  const w = world();
  const a = await w.svc.registerOptions(ORIGIN, null, true), b = await w.svc.registerOptions(ORIGIN, null, true);
  const o = a.options;
  assert.equal(o.rp.id, RP); assert.equal(o.user.name, 'CloudBite owner');
  assert.deepEqual(o.authenticatorSelection, { authenticatorAttachment: 'platform', residentKey: 'required', requireResidentKey: true, userVerification: 'required' });
  assert.equal(Buffer.from(o.user.id, 'base64url').length, 32);
  assert.equal(o.user.id, b.options.user.id);
  assert.notEqual(o.challenge, b.options.challenge);
  assert.equal(o.attestation, 'none');
});

await check('pairing: 256-bit one-use link, hash-only storage, fragment URL, max 2, ttl <= 30 min', async () => {
  const w = world();
  for (const ttlSeconds of [0, 59, 1801, 1.5, '600', undefined]) assert.equal((await w.svc.issuePairing({ ttlSeconds })).status, 400);
  const p = await w.svc.issuePairing({ ttlSeconds: 1800 });
  assert.equal(Buffer.from(p.token, 'base64url').length, 32);
  assert.equal(p.url, `${ORIGIN}/cloudbite/computer#pair=${p.token}`);
  assert.equal(p.expiresAt, w.now + 1800_000);
  assert.ok(!JSON.stringify([...w.storage.m]).includes(p.token), 'plaintext pairing token stored');
  await w.svc.issuePairing({ ttlSeconds: 60 });
  assert.equal((await w.svc.issuePairing({ ttlSeconds: 60 })).status, 409);
  assert.deepEqual(await w.svc.pair(GATEWAY, p.token), { ok: false, status: 403, error: 'bad origin' });
  const s = await w.svc.pair(ORIGIN, p.token);
  assert.equal(s.ok, true); assert.equal(s.authenticated, true); assert.equal(s.hasCredentials, false);
  assert.match(s.sessionToken, /^cbpc_[A-Za-z0-9_-]{43}$/);
  assert.equal(s.cookieMaxAge, 24 * 3600);
  assert.ok(!JSON.stringify([...w.storage.m]).includes(s.sessionToken), 'plaintext session token stored');
  assert.deepEqual(await w.svc.pair(ORIGIN, p.token), { ok: false, status: 401, error: 'pairing link is invalid or already used' });
  assert.equal(await w.svc.check(s.sessionToken), true);
  // Expired link: refused (410) and gone.
  const w2 = world(); const q = await w2.svc.issuePairing({ ttlSeconds: 60 });
  w2.now += 60_000;
  assert.deepEqual(await w2.svc.pair(ORIGIN, q.token), { ok: false, status: 410, error: 'pairing link expired' });
  assert.equal((await w2.svc.pair(ORIGIN, q.token)).status, 401);
  assert.equal((await w2.svc.revokePairings()).ok, true);
});

await check('pair session is no permanent shortcut: 24 h fixed, not renewed, rotated away by registration', async () => {
  const w = world();
  const p = await w.svc.issuePairing({ ttlSeconds: 600 });
  const s = await w.svc.pair(ORIGIN, p.token);
  w.now += 23 * 3600_000;
  const v = await w.svc.session(s.sessionToken);
  assert.equal(v.authenticated, true); assert.equal(v.renew, false); assert.equal(v.cookieMaxAge, 3600);
  w.now += 3600_000;
  assert.equal(await w.svc.check(s.sessionToken), false);
  assert.equal((await w.svc.session(s.sessionToken)).authenticated, false);
  // Registration from a pair session ends it and issues a passkey session.
  const w2 = world(); const e = await enrolled(w2);
  assert.equal(await w2.svc.check(e.pairToken), false);
  assert.equal(await w2.svc.check(e.token), true);
  const sv = await w2.svc.session(e.token);
  assert.deepEqual(sv, { ok: true, authenticated: true, hasCredentials: true, renew: true, cookieMaxAge: 400 * 86400 });
  const stored = [...w2.storage.m].filter(([k]) => k.startsWith('cred:')).map(([, v]) => v);
  assert.equal(stored.length, 1);
  assert.deepEqual(Object.keys(stored[0]).sort(), ['backedUp', 'counter', 'createdAt', 'deviceType', 'id', 'publicKey', 'transports']);
  assert.deepEqual(stored[0].transports, ['internal', 'hybrid']);
});

await check('phone passkey sign-in with the real SDK: discoverable, UV required, one-use challenge', async () => {
  const w = world(); const { phone } = await enrolled(w);
  const { o, r } = await login(w, phone);
  assert.equal(o.options.rpId, RP); assert.equal(o.options.userVerification, 'required');
  assert.equal(o.options.allowCredentials, undefined);
  assert.equal(r.ok, true, JSON.stringify(r)); assert.equal(r.authenticated, true);
  assert.equal(await w.svc.check(r.sessionToken), true);
  // Replay of the same assertion: the challenge was consumed.
  assert.deepEqual(await w.svc.login(ORIGIN, phone.get(o.options), null), { ok: false, status: 400, error: 'sign-in challenge is missing, used or expired' });
});

await check('parallel replays of one assertion: exactly one session', async () => {
  const w = world(); const { phone } = await enrolled(w);
  const o = await w.svc.loginOptions(ORIGIN);
  const a = phone.get(o.options);
  const rs = await Promise.all([1, 2, 3, 4].map(() => w.svc.login(ORIGIN, a, null)));
  assert.equal(rs.filter((x) => x.ok).length, 1);
});

await check('counter: a cloned/replayed counter is refused; zero-counter synced passkeys are allowed', async () => {
  const w = world(); const { phone } = await enrolled(w);
  assert.equal((await login(w, phone)).r.ok, true);
  phone.counter -= 1; // same counter value as the last accepted assertion
  assert.equal((await login(w, phone)).r.status, 401);
  const w2 = world(); const { phone: synced } = await enrolled(w2, new SoftPhone({ counter: false }));
  for (let i = 0; i < 3; i++) assert.equal((await login(w2, synced)).r.ok, true);
});

await check('wrong origin, wrong RP id, missing UV, wrong type, unknown key, wrong user handle: denied', async () => {
  const w = world(); const { phone } = await enrolled(w);
  for (const extra of [{ origin: WORKERS_DEV }, { origin: GATEWAY }, { rpId: 'ai-gongbu.workers.dev' }, { flags: 0x01 }, { type: 'webauthn.create' }, { userHandle: randomBytes(32).toString('base64url') }])
    assert.equal((await login(w, phone, extra)).r.status, 401, JSON.stringify(extra));
  const stranger = new SoftPhone(); stranger.userHandle = phone.userHandle;
  assert.equal((await login(w, stranger)).r.status, 401);
  // Ceremonies requested from the desktop gateway or workers.dev never start.
  for (const origin of [GATEWAY, WORKERS_DEV, 'null', '']) {
    assert.equal((await w.svc.loginOptions(origin)).status, 403);
    assert.equal((await w.svc.registerOptions(origin, null, true)).status, 403);
  }
  // Registration with missing UV or a foreign origin is refused too.
  const o = await w.svc.registerOptions(ORIGIN, null, true);
  assert.equal((await w.svc.registerVerify(ORIGIN, null, true, new SoftPhone().create(o.options, { flags: 0x41 }))).status, 400);
  const o2 = await w.svc.registerOptions(ORIGIN, null, true);
  assert.equal((await w.svc.registerVerify(ORIGIN, null, true, new SoftPhone().create(o2.options, { origin: WORKERS_DEV }))).status, 400);
  // Strict JSON shape.
  const o3 = await w.svc.loginOptions(ORIGIN);
  const extraField = JSON.parse(phone.get(o3.options)); extraField.evil = 1;
  assert.equal((await w.svc.login(ORIGIN, JSON.stringify(extraField), null)).status, 400);
  for (const bad of ['', 'null', '[]', '{', 'x'.repeat(40000), 42, null]) assert.equal((await w.svc.login(ORIGIN, bad, null)).status, 400);
});

await check('challenge purpose and expiry: a registration challenge cannot sign in; 3-minute one-use', async () => {
  const w = world(); const { phone, token } = await enrolled(w);
  const reg = await w.svc.registerOptions(ORIGIN, token, false);
  assert.equal((await w.svc.login(ORIGIN, phone.get(reg.options), null)).status, 400);
  const o = await w.svc.loginOptions(ORIGIN);
  w.now += 3 * 60_000;
  assert.equal((await w.svc.login(ORIGIN, phone.get(o.options), null)).status, 400);
  // Bounded: at most 16 outstanding per purpose (oldest dropped), login floods do not evict registration challenges.
  const r = await w.svc.registerOptions(ORIGIN, token, false);
  for (let i = 0; i < 40; i++) await w.svc.loginOptions(ORIGIN);
  const ch = [...w.storage.m].filter(([k]) => k.startsWith('chal:')).map(([, v]) => v);
  assert.equal(ch.filter((c) => c.purpose === 'login').length, 16);
  const second = await w.svc.registerVerify(ORIGIN, token, false, new SoftPhone().create(r.options));
  assert.equal(second.ok, true, JSON.stringify(second));
});

await check('registration challenge is bound to the session that asked for it, and legacy owner is re-checked now', async () => {
  const w = world(); const { token } = await enrolled(w);
  const p = await w.svc.issuePairing({ ttlSeconds: 600 });
  const other = (await w.svc.pair(ORIGIN, p.token)).sessionToken;
  const o = await w.svc.registerOptions(ORIGIN, token, false);
  assert.equal((await w.svc.registerVerify(ORIGIN, other, false, new SoftPhone().create(o.options))).status, 401);
  const l = await w.svc.registerOptions(ORIGIN, null, true);
  assert.equal((await w.svc.registerVerify(ORIGIN, null, false, new SoftPhone().create(l.options))).status, 401);
  const l2 = await w.svc.registerOptions(ORIGIN, null, true);
  const ok = await w.svc.registerVerify(ORIGIN, null, true, new SoftPhone().create(l2.options));
  assert.equal(ok.ok, true); assert.equal(await w.svc.check(ok.sessionToken), true);
  // The same passkey cannot be registered twice.
  const dup = new SoftPhone();
  const d1 = await w.svc.registerOptions(ORIGIN, null, true);
  assert.equal((await w.svc.registerVerify(ORIGIN, null, true, dup.create(d1.options))).ok, true);
  assert.ok((await w.svc.registerOptions(ORIGIN, null, true)).options.excludeCredentials.some((c) => c.id === dup.id));
  const d2 = await w.svc.registerOptions(ORIGIN, null, true);
  assert.equal((await w.svc.registerVerify(ORIGIN, null, true, dup.create(d2.options))).status, 409);
});

await check('logout revokes the session hash immediately; repeating is harmless', async () => {
  const w = world(); const { phone } = await enrolled(w);
  const { r } = await login(w, phone);
  assert.deepEqual(await w.svc.logout(r.sessionToken), { ok: true, authenticated: false });
  assert.equal(await w.svc.check(r.sessionToken), false);
  assert.deepEqual(await w.svc.logout(r.sessionToken), { ok: true, authenticated: false });
  assert.deepEqual(await w.svc.logout(null), { ok: true, authenticated: false });
  // Signing in again from a browser that presents its prior token replaces it.
  const a = (await login(w, phone)).r.sessionToken;
  const o = await w.svc.loginOptions(ORIGIN);
  const b = await w.svc.login(ORIGIN, phone.get(o.options), a);
  assert.equal(await w.svc.check(a), false); assert.equal(await w.svc.check(b.sessionToken), true);
});

await check('rolling 400-day idle session until explicit logout; at most 8 sessions (least recently used goes)', async () => {
  const w = world(); const { phone, token } = await enrolled(w);
  for (let i = 0; i < 5; i++) { w.now += 300 * DAY; assert.equal(await w.svc.check(token), true); }
  w.now += 401 * DAY;
  assert.equal(await w.svc.check(token), false);
  const tokens = [];
  for (let i = 0; i < 9; i++) { w.now += 2 * 3600_000; tokens.push((await login(w, phone)).r.sessionToken); }
  assert.equal([...w.storage.m.keys()].filter((k) => k.startsWith('sess:')).length, 8);
  assert.equal(await w.svc.check(tokens[0]), false);
  assert.equal(await w.svc.check(tokens[8]), true);
});

await check('at most 8 passkeys; revoking one ends the sessions it created', async () => {
  const w = world(); const first = await enrolled(w);
  let token = first.token;
  for (let i = 1; i < 8; i++) {
    const o = await w.svc.registerOptions(ORIGIN, token, false);
    const r = await w.svc.registerVerify(ORIGIN, token, false, new SoftPhone().create(o.options));
    assert.equal(r.ok, true); token = r.sessionToken;
  }
  assert.equal((await w.svc.registerOptions(ORIGIN, token, false)).status, 409);
  const fromFirst = (await login(w, first.phone)).r.sessionToken;
  const creds = await w.svc.credentialsList(token);
  assert.equal(creds.credentials.length, 8);
  assert.ok(!JSON.stringify(creds).includes('publicKey'));
  assert.equal((await w.svc.credentialsList(null)).status, 401);
  assert.deepEqual(await w.svc.revokeCredential(token, first.phone.id), { ok: true, revoked: true });
  assert.equal(await w.svc.check(fromFirst), false);
  assert.equal(await w.svc.check(token), true);
  assert.equal((await login(w, first.phone)).r.status, 401);
  assert.equal((await w.svc.revokeCredential(null, first.phone.id)).status, 401);
});

await check('no raw errors leak; injected WebAuthn failures fail closed', async () => {
  const boom = { generateRegistrationOptions: async () => { throw new Error('secret internals'); }, verifyRegistrationResponse: async () => { throw new Error('x'); },
    generateAuthenticationOptions: async () => { throw new Error('secret internals'); }, verifyAuthenticationResponse: async () => { throw new Error('x'); } };
  const w = world({ webauthn: boom });
  await w.storage.put('cred:abc', { id: 'abc', publicKey: 'AA', counter: 0, transports: [], createdAt: 1, backedUp: false, deviceType: 'singleDevice' });
  const r = await w.svc.loginOptions(ORIGIN);
  assert.deepEqual(r, { ok: false, status: 503, error: 'computer sign-in is temporarily unavailable' });
  assert.equal(await w.svc.check('cbpc_' + 'A'.repeat(43)), false);
  // A verifier that says verified but without UV is still refused.
  const lax = { ...M, generateAuthenticationOptions: async (o) => ({ challenge: Buffer.from(o.challenge).toString('base64url'), rpId: o.rpID, userVerification: 'required' }),
    verifyAuthenticationResponse: async () => ({ verified: true, authenticationInfo: { userVerified: false, credentialID: 'abc', newCounter: 1, credentialBackedUp: false } }) };
  const w2 = world({ webauthn: lax });
  await w2.storage.put('cred:abc', { id: 'abc', publicKey: 'AA', counter: 0, transports: [], createdAt: 1, backedUp: false, deviceType: 'singleDevice' });
  const o = await w2.svc.loginOptions(ORIGIN);
  const cdj = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: o.options.challenge, origin: ORIGIN })).toString('base64url');
  const resp = JSON.stringify({ id: 'abc', rawId: 'abc', type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: cdj, authenticatorData: 'AA', signature: 'AA' } });
  assert.equal((await w2.svc.login(ORIGIN, resp, null)).status, 401);
});

await check('Durable Object RPC shell: real SDK, env-derived RP, serializable results', async () => {
  const storage = memStorage();
  const obj = new M.CloudbiteComputerAccess({ storage, id: { name: 'owner' } }, { CLOUDBITE_PUBLIC_ORIGIN: ORIGIN });
  assert.equal(M.CB_COMPUTER_ACCESS_OWNER, 'owner');
  const p = await obj.issuePairing({ ttlSeconds: 1800 });
  const s = await obj.pair(ORIGIN, p.token);
  const phone = new SoftPhone();
  const o = await obj.registerOptions(ORIGIN, s.sessionToken, false);
  const r = await obj.registerVerify(ORIGIN, s.sessionToken, false, phone.create(o.options));
  assert.equal(r.ok, true);
  const lo = await obj.loginOptions(ORIGIN);
  const l = await obj.login(ORIGIN, phone.get(lo.options), r.sessionToken);
  assert.equal(l.ok, true);
  for (const x of [p, s, o, r, lo, l, await obj.session(l.sessionToken)]) assert.deepEqual(structuredClone(x), JSON.parse(JSON.stringify(x)));
  assert.equal(await obj.check(l.sessionToken), true);
  const wrongEnv = new M.CloudbiteComputerAccess({ storage: memStorage(), id: { name: 'owner' } }, { CLOUDBITE_PUBLIC_ORIGIN: WORKERS_DEV });
  assert.equal((await wrongEnv.loginOptions(WORKERS_DEV)).status, 503);
});

console.log(`${count} checks passed`);
