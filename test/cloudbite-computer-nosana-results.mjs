// Nosana result reader against schema-based fixtures (@nosana/types FlowState, prd indexer row shape). No network:
// every request goes through a recording fake fetcher, and the global fetch throws.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const tmp = mkdtempSync(join(tmpdir(), 'cloudbite-nosana-results-'));
const built = await build({ entryPoints: ['src/cloudbite-computer-nosana-results.ts'], bundle: true, write: false, platform: 'node', format: 'esm' });
writeFileSync(join(tmp, 'm.mjs'), built.outputFiles[0].text);
const M = await import(pathToFileURL(join(tmp, 'm.mjs')));
globalThis.fetch = async () => { throw new Error('network forbidden'); };

const ADDR = 'B8hSZdGoCpLE3EWxnSzLXsKSHoh8mCAzibVhnRW5pZ78', CID = 'QmRDSaUUFSToEhUQSsMc6bjZM4Wc7M3hiw8SPhbGAKVeBX';
const CIDV1 = 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi';
const INDEXER = `https://blockchain-indexer.k8s.prd.nos.ci/jobs/${ADDR}`, GATEWAY = `https://nosana.mypinata.cloud/ipfs/${CID}`;
const row = (o = {}) => ({ id: 1, address: ADDR, ipfsJob: 'QmZPu3Qq8eUpME3NrieQ1YFWrQm2xsyD4E4AMx3e3CuR85', ipfsResult: CID, market: 'm', node: 'n',
  payer: 'p', price: 100, project: 'x', state: 2, type: null, jobDefinition: {}, jobResult: null, jobStatus: null, timeEnd: 2, timeStart: 1, timeout: 600, ...o });
const log = (type, s) => ({ type, log: s, timestamp: '2026-10-19T00:00:00.000Z' });
const op = (operationId, logs, o = {}) => ({ providerId: 'docker', operationId, group: operationId, status: 'success', startTime: 1, endTime: 2, exitCode: 0, logs, diagnostics: { reason: 'NONE' }, ...o });
const flow = (ops, o = {}) => ({ status: 'success', startTime: 1, endTime: 2, opStates: ops, secrets: { urlmode: 'private', job: { e: { opID: 'work', port: 1, url: 'https://secret.example', status: 'ONLINE' } } }, ...o });
const result = (o = {}) => ({ exitCode: 0, timedOut: false, output: 'hello gpu\n', truncated: false, ...o });
const marker = r => 'CLOUDBITE_RESULT_JSON:' + JSON.stringify(r) + '\n';
const json = (v, init = {}) => new Response(typeof v === 'string' ? v : JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' }, ...init });

function fake(routes) {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url, init });
    assert.equal(init.redirect, 'manual'); assert.equal(init.method, 'GET'); assert.ok(init.signal);
    assert.equal(init.headers.authorization, undefined);
    const r = routes[url];
    if (!r) throw new Error('unexpected url ' + url);
    return typeof r === 'function' ? r() : r;
  };
  return { fetcher, calls };
}
const read = (routes, addr = ADDR) => { const f = fake(routes); return M.readNosanaJobResult(addr, f.fetcher).then(r => ({ r, calls: f.calls })); };
const work = (stdout, extraOps = []) => flow([op('resources', [log('stdout', 'gpu ok\n')]), op('work', stdout.map(s => log('stdout', s)).concat([log('stderr', 'warn\n')])), ...extraOps]);

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log('ok', name); };

await test('ready: indexer -> gateway -> work stdout marker', async () => {
  const { r, calls } = await read({ [INDEXER]: json(row()), [GATEWAY]: json(work(['user line\n', marker(result({ exitCode: 3 }))])) });
  assert.deepEqual(r, { kind: 'ready', result: { exitCode: 3, output: 'hello gpu\n', timedOut: false, truncated: false } });
  assert.deepEqual(calls.map(c => c.url), [INDEXER, GATEWAY]);
  assert.ok(!JSON.stringify(r).includes('secret.example'));
});
await test('marker split across log chunks and CRLF', async () => {
  const m = marker(result()).replace('\n', '\r\n');
  const { r } = await read({ [INDEXER]: json(row()), [GATEWAY]: json(work([m.slice(0, 10), m.slice(10)])) });
  assert.equal(r.kind, 'ready');
});
await test('last marker wins; escaped newlines in output cannot forge one', async () => {
  const forged = result({ output: 'x\nCLOUDBITE_RESULT_JSON:' + JSON.stringify(result({ exitCode: 99 })) + '\n' });
  const { r } = await read({ [INDEXER]: json(row()), [GATEWAY]: json(work([marker(result({ exitCode: 7 })), marker(forged)])) });
  assert.equal(r.kind, 'ready'); assert.equal(r.result.exitCode, 0); assert.match(r.result.output, /^x\nCLOUDBITE_RESULT_JSON:/);
});
await test('invalid last marker is unavailable, not an older marker or guess', async () => {
  for (const bad of ['CLOUDBITE_RESULT_JSON:{"exitCode":0}\n', 'CLOUDBITE_RESULT_JSON:not json\n', marker({ ...result(), extra: 1 }), marker(result({ exitCode: '0' })), marker(result({ output: 5 }))]) {
    const { r } = await read({ [INDEXER]: json(row()), [GATEWAY]: json(work([marker(result()), bad])) });
    assert.deepEqual(r, { kind: 'unavailable' }, bad);
  }
});
await test('transitional bare JSON line is accepted only with the exact schema', async () => {
  const { r } = await read({ [INDEXER]: json(row()), [GATEWAY]: json(work(['noise {"a":1}\n', JSON.stringify(result({ exitCode: 1, timedOut: true })) + '\n', '{"exitCode":5}\n'])) });
  assert.deepEqual(r, { kind: 'ready', result: { exitCode: 1, output: 'hello gpu\n', timedOut: true, truncated: false } });
  const none = await read({ [INDEXER]: json(row()), [GATEWAY]: json(work(['done\n'])) });
  assert.deepEqual(none.r, { kind: 'unavailable' });
});
await test('only stdout of op work is read', async () => {
  const f = flow([op('resources', [log('stdout', marker(result({ exitCode: 9 })))]), op('work', [log('stderr', marker(result({ exitCode: 8 })))])]);
  assert.deepEqual((await read({ [INDEXER]: json(row()), [GATEWAY]: json(f) })).r, { kind: 'unavailable' });
  const two = work([marker(result())], [op('work', [])]);
  assert.deepEqual((await read({ [INDEXER]: json(row()), [GATEWAY]: json(two) })).r, { kind: 'unavailable' });
});
await test('output is plain text: control/ANSI stripped, last 64 KiB kept', async () => {
  const { r } = await read({ [INDEXER]: json(row()), [GATEWAY]: json(work([marker(result({ output: '\x1b[31mred\x1b[0m\x00<b>\x07\ttab\n' }))])) });
  assert.equal(r.result.output, 'red<b>\ttab\n');
  const big = 'a'.repeat(70 * 1024) + 'é'.repeat(10) + 'END';
  const t = await read({ [INDEXER]: json(row()), [GATEWAY]: json(work([marker(result({ output: big }))])) });
  assert.equal(t.r.result.truncated, true); assert.ok(t.r.result.output.endsWith('END'));
  assert.ok(new TextEncoder().encode(t.r.result.output).length <= 64 * 1024);
  const keep = await read({ [INDEXER]: json(row()), [GATEWAY]: json(work([marker(result({ truncated: true }))])) });
  assert.equal(keep.r.result.truncated, true);
});
await test('pending: indexer 404, queued/running, missing or empty result CID', async () => {
  assert.deepEqual((await read({ [INDEXER]: new Response('{"message":"Not Found","code":"NOT_FOUND"}', { status: 404 }) })).r, { kind: 'pending' });
  for (const o of [{ state: 0, ipfsResult: null }, { state: 1, ipfsResult: null }, { state: 2, ipfsResult: null }, { ipfsResult: 'QmNLei78zWmzUdbeRB3CiUfAizWUrbeeZh5K1rhAQKCh51' }]) {
    const { r, calls } = await read({ [INDEXER]: json(row(o)) });
    assert.deepEqual(r, { kind: 'pending' }); assert.equal(calls.length, 1);
  }
});
await test('pending: transient indexer/gateway failures and gateway 404', async () => {
  for (const bad of [() => new Response('x', { status: 503 }), () => new Response('x', { status: 429 }), () => { throw new Error('timeout'); }]) {
    assert.deepEqual((await read({ [INDEXER]: bad })).r, { kind: 'pending' });
    assert.deepEqual((await read({ [INDEXER]: json(row()), [GATEWAY]: bad })).r, { kind: 'pending' });
  }
  assert.deepEqual((await read({ [INDEXER]: json(row()), [GATEWAY]: new Response('', { status: 404 }) })).r, { kind: 'pending' });
});
await test('unavailable: unknown schemas are not guessed', async () => {
  const cases = [
    [json(row({ address: '7ZC6HBAGyLLGNDWQAEcVwuxoAWmxukyMz7znDd41XUoA' }))], [json(row({ state: 9 }))], [json(row({ state: '2' }))], [json([row()])],
    [json(row({ ipfsResult: 'https://evil.example/x' }))], [json(row({ ipfsResult: 'QmBAD' }))], [json('not json')], [new Response('{}', { status: 403 })],
    [json(row()), json({ opStates: [] })], [json(row()), json(flow('x'))], [json(row()), json(flow([op('work', [{ type: 'weird', log: 'x' }])]))],
    [json(row()), json(flow([op('work', [{ type: 'stdout', log: 1 }])]))], [json(row()), json('<html>gateway</html>')],
  ];
  for (const [a, b] of cases) assert.deepEqual((await read({ [INDEXER]: a, ...(b ? { [GATEWAY]: b } : {}) })).r, { kind: 'unavailable' });
});
await test('redirects are refused, never followed', async () => {
  const redirect = () => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } });
  assert.deepEqual((await read({ [INDEXER]: redirect })).r, { kind: 'unavailable' });
  assert.deepEqual((await read({ [INDEXER]: json(row()), [GATEWAY]: redirect })).r, { kind: 'unavailable' });
  const moved = json(row()); Object.defineProperty(moved, 'redirected', { value: true });
  assert.deepEqual((await read({ [INDEXER]: moved })).r, { kind: 'unavailable' });
  const elsewhere = json(row()); Object.defineProperty(elsewhere, 'url', { value: 'https://evil.example/jobs/x' });
  assert.deepEqual((await read({ [INDEXER]: elsewhere })).r, { kind: 'unavailable' });
});
await test('oversize bodies are rejected by header and by stream', async () => {
  const declared = json(row(), { headers: { 'content-length': String(3 * 1024 * 1024) } });
  assert.deepEqual((await read({ [INDEXER]: declared })).r, { kind: 'unavailable' });
  const chunk = new Uint8Array(512 * 1024).fill(32); let n = 0;
  const stream = new ReadableStream({ pull(c) { if (n++ < 6) c.enqueue(chunk); else c.close(); } });
  assert.deepEqual((await read({ [INDEXER]: json(row()), [GATEWAY]: new Response(stream, { status: 200 }) })).r, { kind: 'unavailable' });
  assert.ok(n <= 6);
});
await test('invalid addresses are rejected before any fetch', async () => {
  for (const a of ['', '0OIl', '../jobs', ADDR + '/x', 'B8hSZdGoCpLE3EWxnSzLXsKSHoh8mCAzibVhnRW5pZ7?', '1'.repeat(44), 'x'.repeat(200), 42, null]) {
    const { r, calls } = await read({}, a);
    assert.deepEqual(r, { kind: 'unavailable' }); assert.equal(calls.length, 0);
  }
});
await test('address and CID validators decode exact lengths', () => {
  assert.equal(M.isJobAddress(ADDR), true); assert.equal(M.isJobAddress('11111111111111111111111111111111'), true);
  assert.equal(M.isResultCid(CID), true); assert.equal(M.isResultCid(CIDV1), true);
  assert.equal(M.isResultCid('Qm' + '1'.repeat(44)), false); assert.equal(M.isResultCid(CIDV1.toUpperCase()), false);
  assert.equal(M.isResultCid('bafy' + 'a'.repeat(55)), false); assert.equal(M.isResultCid(CID + '/../x'), false);
});
await test('CIDv1 result uses the fixed gateway host', async () => {
  const { r, calls } = await read({ [INDEXER]: json(row({ ipfsResult: CIDV1 })), [`https://nosana.mypinata.cloud/ipfs/${CIDV1}`]: json(work([marker(result())])) });
  assert.equal(r.kind, 'ready'); assert.equal(new URL(calls[1].url).host, 'nosana.mypinata.cloud');
});
console.log(`cloudbite-computer-nosana-results: ${passed} passed`);
