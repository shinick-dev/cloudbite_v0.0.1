// Temporary Cloudbite operator token (docs/cloudbite/temporary-operator.txt) through the REAL Worker router and the REAL
// CloudbiteProject DO (memory storage, actual catalogue). STATE is a recorder: the operator token must never reach it.
// No network: alarms are never run and global fetch throws.
//   node test/cloudbite-operator.mjs
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
const entry = `export { default, CloudbiteProject } from './src/index.ts'; export * from './src/cloudbite-operator.ts'; export { CLOUDBITE_EXPERTS } from './src/cloudbite-personas.ts';`;
const tmp = mkdtempSync(join(tmpdir(), 'cloudbite-operator-'));
const bundle = await build({ stdin: { contents: entry, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, format: 'esm', platform: 'node', plugins: [stubs], loader: { '.ps1': 'text' } });
writeFileSync(join(tmp, 'm.mjs'), bundle.outputFiles[0].text);
const M = await import(pathToFileURL(join(tmp, 'm.mjs')));
globalThis.fetch = async (u) => { throw new Error('network forbidden in this test: ' + u); };

let count = 0;
const check = async (name, f) => { await f(); count++; console.log('ok', name); };
const mint = () => 'cbo_' + randomBytes(32).toString('base64url');
const sha = (s) => createHash('sha256').update(s).digest('hex');
const TOKEN = mint();
const ADMIN = 'legacy-admin-session-value';
const HOUR = 3_600_000;

function memStorage() {
  const m = new Map(); const clone = (v) => (v === undefined ? undefined : structuredClone(v));
  return {
    async get(k) { return Array.isArray(k) ? new Map(k.filter((x) => m.has(x)).map((x) => [x, clone(m.get(x))])) : clone(m.get(k)); },
    async put(k, v) { for (const [a, b] of typeof k === 'object' ? Object.entries(k) : [[k, v]]) m.set(a, clone(b)); },
    async delete(k) { for (const x of Array.isArray(k) ? k : [k]) m.delete(x); },
    async list({ prefix = '' } = {}) { return new Map([...m].filter(([k]) => k.startsWith(prefix)).sort().map(([k, v]) => [k, clone(v)])); },
    async getAlarm() { return null; }, async setAlarm() {}, async deleteAlarm() {}, async deleteAll() { m.clear(); },
  };
}
function world(envOver = {}) {
  const w = { stateCalls: [] };
  const objects = new Map();
  const ns = { getByName(name) { if (!objects.has(name)) objects.set(name, new M.CloudbiteProject({ storage: memStorage(), id: { name } }, w.env)); return objects.get(name); } };
  // Every State method is recorded; only the legacy admin session is valid, and only for adminList.
  const state = new Proxy({}, { get: (_, method) => async (...args) => {
    w.stateCalls.push([String(method), ...args]);
    return method === 'adminList' && args[0] === ADMIN ? { sessions: [] } : { error: 'admin session expired', status: 401 };
  } });
  w.env = {
    ORIGIN: 'https://cb.test', LAB_ORIGIN: 'https://lab.cloudbite.invalid', RP_ID: 'cb.test', MASTER_KEY: 'k',
    STATE: { idFromName: () => 'main', get: () => state }, CLOUDBITE: ns,
    CLOUDBITE_DAYTONA_API_URL: 'https://dt.fake', CLOUDBITE_DAYTONA_API_KEY: 'DT-SECRET', CLOUDBITE_NOSANA_BASE_URL: 'https://nosana.fake/v1',
    CLOUDBITE_NOSANA_API_KEY: 'NOSANA-SECRET', CLOUDBITE_NOSANA_MODEL: 'm', CLOUDBITE_GATEWAY_URL: 'https://gw.fake',
    CLOUDBITE_OPERATOR_TOKEN_HASH: sha(TOKEN), CLOUDBITE_OPERATOR_EXPIRES_AT: String(Date.now() + 8 * HOUR),
    ...envOver,
  };
  return w;
}
async function call(w, method, path, { body, headers = {}, raw } = {}) {
  const init = { method, headers: { ...headers } };
  if (body !== undefined) { init.body = raw ?? JSON.stringify(body); init.headers['content-type'] ??= 'application/json'; }
  const r = await M.default.fetch(new Request('https://cb.test' + path, init), w.env, { waitUntil() {} });
  const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch {}
  return { status: r.status, j, text };
}
const ids = M.CLOUDBITE_EXPERTS.map((e) => e.id);
const brief = (over = {}) => ({ title: 'Operator run', objective: 'Should we launch?', context: '', expertIds: ids.slice(0, 2), mode: 'demo', requestId: 'req-' + randomBytes(6).toString('hex'), ...over });
const op = (token = TOKEN) => ({ origin: 'https://cb.test', 'x-admin-token': token });
const create = (w, b, headers) => call(w, 'POST', '/api/cloudbite/projects', { body: b, headers });
const noSecretsIn = (r) => { for (const s of [TOKEN, sha(TOKEN), 'DT-SECRET', 'NOSANA-SECRET']) assert.ok(!r.text.includes(s), 'response leaks a secret'); };

await check('verifier: exact cbo_ + 256-bit base64url only; missing/malformed hash or expiry and expiry itself fail closed', async () => {
  const env = { CLOUDBITE_OPERATOR_TOKEN_HASH: sha(TOKEN), CLOUDBITE_OPERATOR_EXPIRES_AT: '2000000000000' };
  const now = 1_999_999_999_999;
  assert.equal(await M.verifyCloudbiteOperator(env, TOKEN, now), true);
  assert.equal(await M.verifyCloudbiteOperator(env, TOKEN, now + 1), false, 'expires exactly at CLOUDBITE_OPERATOR_EXPIRES_AT');
  assert.equal(await M.verifyCloudbiteOperator(env, mint(), now), false, 'well-formed but different token');
  const body = TOKEN.slice(4);
  for (const bad of ['', body, 'CBO_' + body, 'cbo_' + body.slice(1), TOKEN + 'A', TOKEN + '=', ` ${TOKEN}`, `${TOKEN}\n`,
    'cbo_' + body.slice(0, 42) + 'B', 'cbo_' + body.slice(0, 41) + '+A', 'cbo_' + body.slice(0, 41) + '/A']) {
    assert.equal(await M.verifyCloudbiteOperator({ ...env, CLOUDBITE_OPERATOR_TOKEN_HASH: sha(bad) }, bad, now), false, `format accepted: ${JSON.stringify(bad.slice(0, 8))}`);
  }
  for (const over of [{ CLOUDBITE_OPERATOR_TOKEN_HASH: undefined }, { CLOUDBITE_OPERATOR_EXPIRES_AT: undefined }, { CLOUDBITE_OPERATOR_TOKEN_HASH: sha(TOKEN).toUpperCase() },
    { CLOUDBITE_OPERATOR_TOKEN_HASH: sha(TOKEN).slice(1) }, { CLOUDBITE_OPERATOR_TOKEN_HASH: '' }, { CLOUDBITE_OPERATOR_EXPIRES_AT: '' },
    { CLOUDBITE_OPERATOR_EXPIRES_AT: '0' }, { CLOUDBITE_OPERATOR_EXPIRES_AT: '-1' }, { CLOUDBITE_OPERATOR_EXPIRES_AT: '2e12' },
    { CLOUDBITE_OPERATOR_EXPIRES_AT: ' 2000000000000' }, { CLOUDBITE_OPERATOR_EXPIRES_AT: '99999999999999999' }]) {
    assert.equal(await M.verifyCloudbiteOperator({ ...env, ...over }, TOKEN, now), false, `env accepted: ${JSON.stringify(Object.keys(over))}`);
  }
  assert.equal(M.cloudbiteOperatorExpiry({ CLOUDBITE_OPERATOR_EXPIRES_AT: '5' }), null, 'expiry alone is not a configuration');
});

await check('create: operator token works without touching State; wrong, expired or missing token is 401; legacy session still works', async () => {
  const w = world();
  const ok = await create(w, brief(), op());
  assert.equal(ok.status, 201); assert.match(ok.j.accessToken, /^cbt_/); noSecretsIn(ok);
  assert.equal(w.stateCalls.length, 0, 'operator path never queries State');
  for (const t of [mint(), 'cbo_short', 'cbo_' + TOKEN.slice(4).slice(0, 42) + 'B']) {
    const r = await create(w, brief(), op(t));
    assert.equal(r.status, 401); assert.equal(r.j.error, 'admin session required'); assert.ok(!r.text.includes(t));
  }
  assert.equal(w.stateCalls.length, 0, 'cbo_-prefixed tokens are never forwarded to State, even when wrong');
  assert.equal((await create(w, brief(), { origin: 'https://cb.test' })).status, 401);
  for (const env of [{ CLOUDBITE_OPERATOR_EXPIRES_AT: String(Date.now() - 1) }, { CLOUDBITE_OPERATOR_TOKEN_HASH: undefined }, { CLOUDBITE_OPERATOR_EXPIRES_AT: undefined }]) {
    const r = await create(world(env), brief(), op());
    assert.equal(r.status, 401); noSecretsIn(r);
  }
  const legacy = await create(w, brief(), op(ADMIN));
  assert.equal(legacy.status, 201);
  assert.deepEqual(w.stateCalls, [['adminList', ADMIN]]);
  assert.equal((await create(w, brief(), op('legacy-but-wrong'))).status, 401);
});

await check('create guards stay intact for the operator: Origin, content type, body limit, expert bounds, live slots', async () => {
  const w = world();
  assert.equal((await create(w, brief(), { ...op(), origin: 'https://evil.test' })).status, 403);
  assert.equal((await create(w, brief(), { 'x-admin-token': TOKEN })).status, 403);
  assert.equal((await call(w, 'POST', '/api/cloudbite/projects', { body: brief(), raw: JSON.stringify(brief()), headers: { ...op(), 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await create(w, { ...brief(), context: 'x'.repeat(64 * 1024) }, op())).status, 413);
  assert.equal((await create(w, brief({ expertIds: ids.slice(0, 6) }), op())).status, 400, 'more than five experts');
  assert.equal((await create(w, brief({ expertIds: ['no-such-expert'] }), op())).status, 400, 'catalogue only');
  assert.equal((await create(w, brief({ expertIds: [] }), op())).status, 400);
  assert.equal((await call(w, 'GET', '/api/cloudbite/projects', { headers: op() })).status, 405);
  assert.equal((await create(w, brief({ mode: 'live' }), op())).status, 201);
  assert.equal((await create(w, brief({ mode: 'live' }), op())).status, 201);
  const third = await create(w, brief({ mode: 'live' }), op());
  assert.equal(third.status, 429, 'at most two active live projects');
  assert.equal(w.stateCalls.length, 0);
});

await check('operator token is not a project token and opens no admin, vault or other API', async () => {
  const w = world();
  const made = await create(w, brief(), op());
  const id = made.j.project.id;
  assert.equal((await call(w, 'GET', `/api/cloudbite/projects/${id}`, { headers: { authorization: `Bearer ${made.j.accessToken}` } })).status, 200);
  for (const headers of [{ authorization: `Bearer ${TOKEN}` }, op()]) {
    const r = await call(w, 'GET', `/api/cloudbite/projects/${id}`, { headers });
    assert.ok(r.status === 401 || r.status === 403, `project read with operator token: ${r.status}`);
  }
  const cancel = await call(w, 'POST', `/api/cloudbite/projects/${id}/cancel`, { body: {}, headers: { ...op(), authorization: `Bearer ${TOKEN}` } });
  assert.ok(cancel.status === 401 || cancel.status === 403);
  // Legacy routes treat it as an unknown admin token: State (the only judge there) rejects it; nothing succeeds.
  for (const path of ['/api/admin/list', '/api/admin/revoke', '/api/admin/provider', '/api/vault/list', '/api/cloudbite/admin']) {
    const r = await call(w, 'POST', path, { body: {}, headers: op() });
    assert.ok([401, 403, 404].includes(r.status), `${path} → ${r.status}`); noSecretsIn(r);
  }
  assert.ok(w.stateCalls.some(([m, t]) => m === 'adminList' && t === TOKEN), '/api/admin/list asked State, which rejected the token');
});

rmSync(tmp, { recursive: true, force: true });
console.log(`cloudbite-operator: ${count} checks passed`);
