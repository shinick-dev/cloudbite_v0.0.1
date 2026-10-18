// CloudBite computer Daytona transport and desktop proxy, with a recording fetch. No provider network.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const tmp = mkdtempSync(join(tmpdir(), 'cloudbite-computer-dt-'));
const built = await build({ stdin: { contents: `export * from './src/cloudbite-computer-daytona.ts'; export * from './src/cloudbite-computer-contract.ts';`, resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, write: false, platform: 'node', format: 'esm' });
writeFileSync(join(tmp, 'm.mjs'), built.outputFiles[0].text);
const M = await import(pathToFileURL(join(tmp, 'm.mjs')));

let calls = [], reply = () => new Response('{}');
globalThis.fetch = async (url, init = {}) => { calls.push({ url: String(url), method: init.method, body: init.body, headers: new Headers(init.headers) }); return reply(url, init); };
const C = { api: 'https://dt.test/api', key: 'secret-key' };
let passed = 0;
const test = async (name, fn) => { calls = []; reply = () => new Response('{}'); await fn(); passed++; console.log('ok', name); };

await test('REST methods use the verified paths and bodies', async () => {
  reply = () => Response.json({ id: 'sb1', name: 'n' });
  await M.restDaytona.create(C, { name: 'n', snapshot: 's', autoDeleteInterval: -1 });
  await M.restDaytona.start(C, 'sb1');
  await M.restDaytona.stop(C, 'sb1');
  await M.restDaytona.createSnapshot(C, 'sb1', 'my-env');
  await M.restDaytona.get(C, 'cloudbite-computer-primary-abc12345');
  await M.restDaytona.getSnapshot(C, 'my-env');
  await M.restDaytona.computerUseStart(C, { id: 'sb1', toolboxProxyUrl: 'https://tb.test/toolbox' });
  assert.deepEqual(calls.pop().url, 'https://tb.test/toolbox/sb1/computeruse/start');
  assert.deepEqual(calls.map((c) => [c.method, c.url.replace(C.api, '')]), [
    ['POST', '/sandbox'], ['POST', '/sandbox/sb1/start'], ['POST', '/sandbox/sb1/stop'], ['POST', '/sandbox/sb1/snapshot'],
    ['GET', '/sandbox/cloudbite-computer-primary-abc12345'], ['GET', '/snapshots/my-env']]);
  assert.deepEqual(JSON.parse(calls[3].body), { name: 'my-env', includeMemory: false });
  assert.equal(calls[0].headers.get('authorization'), 'Bearer secret-key');
  reply = () => Response.json({ sandboxId: 'sb1', url: 'https://8082-sb1.proxy.daytona.works', token: 't' });
  assert.deepEqual(await M.restDaytona.preview(C, 'sb1', 8082), { sandboxId: 'sb1', url: 'https://8082-sb1.proxy.daytona.works', token: 't' });
  assert.equal(calls.at(-1).url, `${C.api}/sandbox/sb1/ports/8082/preview-url`);
});

await test('404 reads are absent; no answer is an uncertain status 0; definitive 4xx is certain', async () => {
  reply = () => new Response('{"message":"nf"}', { status: 404 });
  assert.equal(await M.restDaytona.get(C, 'x'), null);
  assert.equal(await M.restDaytona.getSnapshot(C, 'x'), null);
  reply = () => { throw new TypeError('network'); };
  await assert.rejects(M.restDaytona.create(C, {}), (e) => e instanceof M.ComputerDaytonaError && e.status === 0 && e.uncertain && !/secret/.test(e.message));
  reply = () => new Response('{"message":"bad"}', { status: 400 });
  await assert.rejects(M.restDaytona.stop(C, 'x'), (e) => e.status === 400 && !e.uncertain);
});

await test('upstream origin must be the exact desktop port host for this sandbox', async () => {
  const S = ['.proxy.daytona.works'], id = 'sb-0123abcd';
  assert.equal(M.computerUpstreamOrigin(`https://8082-${id}.proxy.daytona.works`, id, S), `https://8082-${id}.proxy.daytona.works`);
  for (const bad of [`http://8082-${id}.proxy.daytona.works`, `https://8080-${id}.proxy.daytona.works`, `https://8082-other123.proxy.daytona.works`,
    `https://8082-${id}.proxy.daytona.works.evil.com`, `https://u:p@8082-${id}.proxy.daytona.works`, `https://8082-${id}.proxy.daytona.works:444`,
    `https://8082-${id}.proxy.daytona.works/x`, 'not a url']) assert.equal(M.computerUpstreamOrigin(bad, id, S), null, bad);
  assert.deepEqual(M.computerProxySuffixes({}), S);
  assert.deepEqual(M.computerProxySuffixes({ CLOUDBITE_COMPUTER_PROXY_SUFFIXES: '.a.example.com, bad, ' }), ['.a.example.com']);
});

await test('proxy strips credentials/control headers, drops Set-Cookie and CORS, confines paths and streams', async () => {
  const UP = { origin: 'https://8082-sb1.proxy.daytona.works', token: 'ptok' };
  let seen;
  const fetcher = async (url, init) => { seen = { url, init, headers: new Headers(init.headers) };
    return new Response('body', { status: 200, headers: { 'set-cookie': 'a=b', 'access-control-allow-origin': '*', 'content-type': 'text/html', 'location': 'https://evil.example/x' } }); };
  const req = new Request('https://gw.test/p/_cloudbite/computer/desktop/index.html?x=1', { headers: {
    cookie: '__Host-cb_computer=abc', authorization: 'Bearer z', origin: 'https://gw.test', referer: 'https://gw.test/', 'cf-connecting-ip': '1.2.3.4',
    'x-forwarded-for': '1.2.3.4', 'x-daytona-preview-token': 'spoof', accept: 'text/html' } });
  const r = await M.proxyComputerDesktop(req, UP, fetcher);
  assert.equal(seen.url, 'https://8082-sb1.proxy.daytona.works/p/_cloudbite/computer/desktop/index.html?x=1');
  for (const h of ['cookie', 'authorization', 'origin', 'referer', 'cf-connecting-ip', 'x-forwarded-for']) assert.equal(seen.headers.get(h), null, h);
  assert.equal(seen.headers.get('x-daytona-preview-token'), 'ptok'); assert.equal(seen.headers.get('accept'), 'text/html');
  assert.equal(seen.init.redirect, 'manual');
  assert.equal(r.headers.get('set-cookie'), null); assert.equal(r.headers.get('access-control-allow-origin'), null); assert.equal(r.headers.get('location'), null);
  assert.equal(await r.text(), 'body');
  for (const p of ['/p/_cloudbite/computer/desktopx', '/p/_cloudbite/computer/desktop/../../api/x', '/p/_cloudbite/computer/desktop/%2e%2e/x',
    '/p/_cloudbite/computer/desktop/a%2fb', '/api/cloudbite/computer/state']) {
    seen = null;
    const res = await M.proxyComputerDesktop(new Request('https://gw.test' + p), UP, fetcher);
    assert.equal(res.status, 404, p); assert.equal(seen, null);
  }
  const ws = await M.proxyComputerDesktop(new Request('https://gw.test/p/_cloudbite/computer/desktop/websocket', { headers: { upgrade: 'websocket', origin: 'https://gw.test' } }),
    UP, async (url, init) => { seen = new Headers(init.headers); return { status: 101, webSocket: {} }; });
  assert.equal(ws.status, 101); assert.equal(seen.get('origin'), null);
  const rel = await M.proxyComputerDesktop(new Request('https://gw.test/p/_cloudbite/computer/desktop'), UP,
    async () => new Response(null, { status: 302, headers: { location: `${UP.origin}/p/_cloudbite/computer/desktop/` } }));
  assert.equal(rel.headers.get('location'), '/p/_cloudbite/computer/desktop/');
  const post = await M.proxyComputerDesktop(new Request('https://gw.test/p/_cloudbite/computer/desktop/upload', { method: 'POST', body: 'x'.repeat(1 << 20), duplex: 'half' }), UP,
    async (url, init) => { assert.ok(init.body instanceof ReadableStream, 'request body streams'); return new Response(init.body); });
  assert.equal((await post.text()).length, 1 << 20);
});

await test('accounts are explicit and snapshots are never inherited across accounts', async () => {
  const a = M.computerAccounts({ CLOUDBITE_DAYTONA_API_KEY: 'k', CLOUDBITE_COMPUTER_SNAPSHOT: 's1', CLOUDBITE_DAYTONA_TERTIARY_API_KEY: 'k3' });
  assert.deepEqual(a.map((x) => [x.id, x.prepared, x.snapshot]), [['primary', true, 's1'], ['tertiary', false, '']]);
  assert.equal(M.computerName('abc12345', 'secondary'), 'cloudbite-computer-secondary-abc12345');
  assert.throws(() => M.computerName('../x', 'primary'));
});

console.log(`${passed} cloudbite-computer-daytona tests passed`);
