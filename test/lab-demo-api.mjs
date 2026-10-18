import assert from 'node:assert/strict';
import { build } from 'esbuild';
const cf = { name: 'local-runtime-stub', setup(b) { b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'cf', namespace: 'stub' })); b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export class DurableObject {}' })); } };
async function load(entry) { const b = await build({ entryPoints: [entry], bundle: true, write: false, format: 'esm', platform: 'node', plugins: [cf], loader: { '.ps1': 'text' } }); return import('data:text/javascript;base64,' + Buffer.from(b.outputFiles[0].text).toString('base64')); }
const { labDemoApi } = await load('src/lab-demo-api.ts');
const { labDemoHost } = await load('src/lab-demo-host.ts');
let calls = [], count = 0;
const state = Object.fromEntries(['Status', 'Prepare', 'Send', 'Open'].map(name => ['labClassroomDemo' + name, async (...args) => { calls.push([name, ...args]); return { state: 'ready' }; }]));
const json = (value, status = 200) => Response.json(value, { status });
const context = (operation, body, origin = 'https://admin.invalid', admin = 'fixture-admin') => ({
  path: '/api/lab/classroom/demo/' + operation,
  req: new Request('https://admin.invalid/api/lab/classroom/demo/' + operation, { method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: typeof body === 'string' ? body : JSON.stringify(body) }),
  env: { ORIGIN: 'https://admin.invalid' }, admin, state, json, out: value => value?.status ? json({ error: value.error }, value.status) : json(value)
});
async function test(name, f) { calls = []; await f(); count++; console.log('ok', name); }
await test('demo routing is exact; unknown operation is not forwarded', async () => {
  assert.equal(labDemoApi({ path: '/unrelated' }), null);
  assert.equal((await labDemoApi(context('delete', { id: 'parent' }))).status, 404); assert.equal(calls.length, 0);
});
await test('absent/wrong origin and cookie-only requests cannot create or execute', async () => {
  for (const origin of [null, 'https://other.invalid']) assert.equal((await labDemoApi(context('prepare', { id: 'parent' }, origin))).status, 403);
  assert.equal((await labDemoApi(context('send', { id: 'parent' }, 'https://admin.invalid', ''))).status, 401);
  assert.equal(calls.length, 0);
});
await test('unknown fields, invalid JSON and oversized streams are rejected before RPC', async () => {
  assert.equal((await labDemoApi(context('prepare', { id: 'parent', sandboxId: 'other' }))).status, 400);
  assert.equal((await labDemoApi(context('status', '{'))).status, 400);
  assert.equal((await labDemoApi(context('send', { id: 'parent', command: 'x'.repeat(21000) }))).status, 413);
  assert.equal(calls.length, 0);
});
await test('exact arguments go to independently admin-gated methods', async () => {
  await labDemoApi(context('prepare', { id: 'parent', requestId: 'request' }));
  await labDemoApi(context('send', { id: 'parent', requestId: 'command', command: 'pwd' }));
  await labDemoApi(context('open', { id: 'parent' }));
  assert.deepEqual(calls, [['Prepare', 'fixture-admin', 'parent', 'request'], ['Send', 'fixture-admin', 'parent', 'command', 'pwd'], ['Open', 'fixture-admin', 'parent']]);
});
const origin = 'https://s-fixture.lab.invalid';
const host = (path, init = {}, st = {}) => labDemoHost(new Request(origin + path, init), {}, st, new URL(origin + path), 'fixture');
const post = (body = { grant: 'a'.repeat(64) }, headers = {}) => ({ method: 'POST', headers: { origin, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
await test('grant page contains no credential and removes fragment before requests', async () => {
  const r = await host('/__lab/demo-open'); const text = await r.text();
  assert.equal(r.status, 200); assert.match(text, /history.replaceState/); assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.ok(!text.includes('fixture-admin')); assert.equal(await host('/unrelated'), null);
});
await test('entry method, site, origin and body bounds reject before claim', async () => {
  const st = { labClassroomDemoClaim() { throw Error('must not be called'); } };
  assert.equal((await host('/__lab/demo-enter', {}, st)).status, 405);
  assert.equal((await host('/__lab/demo-enter', post(undefined, { origin: 'https://other.invalid' }), st)).status, 403);
  assert.equal((await host('/__lab/demo-enter', post(undefined, { 'sec-fetch-site': 'same-site' }), st)).status, 403);
  assert.equal((await host('/__lab/demo-enter', post({ grant: 'x'.repeat(300) }), st)).status, 413);
  assert.equal((await host('/__lab/demo-enter', post({ grant: 'a'.repeat(64), code: 'other' }), st)).status, 400);
});
await test('starting claim sets no cookie; success uses host-only HttpOnly Strict cookie without JSON seat code', async () => {
  const starting = await host('/__lab/demo-enter', post(), { labClassroomDemoClaim: async () => ({ starting: true, message: 'warming' }) });
  assert.equal(starting.status, 202); assert.equal(starting.headers.get('set-cookie'), null);
  const r = await host('/__lab/demo-enter', post(), { labClassroomDemoClaim: async (...args) => { assert.deepEqual(args, ['a'.repeat(64), 'fixture']); return { code: 'private-fixture', expiresAt: Date.now() + 60000 }; } });
  assert.equal(r.status, 200); assert.match(r.headers.get('set-cookie'), /^__Host-lab_seat=private-fixture; Path=\/; Max-Age=\d+; HttpOnly; Secure; SameSite=Strict$/);
  assert.deepEqual(await r.json(), { ok: true });
});
console.log(count + ' demo API/host checks passed');
