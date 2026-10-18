import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
const b = await build({ entryPoints: ['src/lab-demo-native.ts'], bundle: true, write: false, platform: 'node', format: 'esm' });
const { demoCommand, demoSandbox, demoFile } = await import('data:text/javascript;base64,' + Buffer.from(b.outputFiles[0].text).toString('base64'));
const c = { api: 'https://fixture.invalid', key: 'fixture-only' }, sb = { id: 'demo-fixture', state: 'started', toolboxProxyUrl: 'https://toolbox.invalid' };
let calls = [], mode = 'ok', count = 0;
globalThis.fetch = async (url, init = {}) => {
  calls.push({ url, init });
  if (mode === 'oversize') return new Response('x'.repeat(140000));
  if (mode === 'wrong') return Response.json({ ...sb, id: 'peer' });
  if (mode === 'unready') return Response.json({ ...sb, state: 'starting' });
  return url.includes('/process/execute') ? Response.json({ exitCode: 0, result: 'actual-output' }) : Response.json(sb);
};
async function test(n, f) { calls = []; mode = 'ok'; await f(); count++; console.log('ok', n); }
await test('provider identity and started status are checked before execution', async () => {
  assert.deepEqual(await demoSandbox(c, sb.id), sb);
  mode = 'wrong'; await assert.rejects(demoSandbox(c, sb.id));
  mode = 'unready'; await assert.rejects(demoSandbox(c, sb.id));
});
await test('final gate prevents provider mutation after authorization changes', async () => {
  await assert.rejects(demoCommand(c, sb, 'pwd', async () => false)); assert.equal(calls.length, 0);
});
await test('command is executed only in dedicated sandbox with bounded timeout and actual output', async () => {
  const result = await demoCommand(c, sb, "printf '%s' hello", async () => true);
  assert.match(result, /actual-output/); assert.match(result, /종료 코드: 0/);
  assert.equal(calls.length, 1); assert.equal(calls[0].url, 'https://toolbox.invalid/demo-fixture/process/execute');
  const payload = JSON.parse(calls[0].init.body); assert.equal(payload.timeout, 20); assert.match(payload.command, /^bash -lc 'cd \/home\/daytona\/work && /);
  assert.ok(calls[0].init.signal); assert.equal(calls[0].init.headers.authorization, 'Bearer fixture-only');
});
await test('unbounded provider output is rejected without retrying command', async () => {
  mode = 'oversize'; await assert.rejects(demoCommand(c, sb, 'pwd', async () => true)); assert.equal(calls.length, 1);
});
await test('post-execution authority changes hide output', async () => {
  let n = 0; await assert.rejects(demoCommand(c, sb, 'pwd', async () => ++n === 1)); assert.equal(calls.length, 1);
});
await test('actual Node file helper reads, creates UTF8 atomically and rejects stale saves or arbitrary names', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'classroom-demo-file-'));
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const payload = JSON.parse(init.body); assert.ok(payload.command.startsWith("node -e '"));
    let source = payload.command.slice(9, -1).replaceAll("'\\''", "'");
    source = source.replace("'/home/daytona/work'", JSON.stringify(dir));
    try { return Response.json({ exitCode: 0, result: execFileSync(process.execPath, ['-e', source], { encoding: 'utf8', maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }) }); }
    catch { return Response.json({ exitCode: 1, result: 'operation failed' }); }
  };
  try {
    const missing = await demoFile(c, sb, '결과.txt', null, async () => true); assert.equal(missing.hash, 'missing'); assert.equal(missing.exists, false);
    const content = '보고서\n10명 신청, 12명 검토 중\n40분 제안\n참가비 확인 필요\n끝';
    const saved = await demoFile(c, sb, '결과.txt', { content, expectedHash: 'missing' }, async () => true);
    assert.equal(saved.content, content); assert.equal(readFileSync(join(dir, '결과.txt'), 'utf8'), content);
    assert.deepEqual(await demoFile(c, sb, '결과.txt', null, async () => true), saved);
    await assert.rejects(demoFile(c, sb, '결과.txt', { content: 'stale', expectedHash: 'missing' }, async () => true));
    assert.equal(readFileSync(join(dir, '결과.txt'), 'utf8'), content);
    await assert.rejects(demoFile(c, sb, '../outside.txt', null, async () => true));
    writeFileSync(join(dir, '01_요청메모.txt'), Buffer.from([0, 1, 2]));
    await assert.rejects(demoFile(c, sb, '01_요청메모.txt', null, async () => true));
    assert.ok(!readdirSync(dir).some(n => n.startsWith('.gw-demo-')));
  } finally { globalThis.fetch = oldFetch; rmSync(dir, { recursive: true, force: true }); }
});
console.log(count + ' native demo checks passed');
