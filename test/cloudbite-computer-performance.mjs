// CloudBite computer performance: fixed sample command, cgroup parsing, estimated pricing and plans. No provider network.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const tmp = mkdtempSync(join(tmpdir(), 'cloudbite-computer-perf-'));
const built = await build({ stdin: { contents: `export * from './src/cloudbite-computer-performance.ts';`, resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, write: false, platform: 'node', format: 'esm' });
writeFileSync(join(tmp, 'm.mjs'), built.outputFiles[0].text);
const M = await import(pathToFileURL(join(tmp, 'm.mjs')));

const GIB = 1024 ** 3;
const ALLOC = { cpu: 4, memoryGiB: 8 };
const out = (o = {}) => JSON.stringify({ v: 1, u0: 0, u1: 2_000_000, dt: 1, cpuMax: '400000 100000', cfsQuota: null, cfsPeriod: null,
  memCurrent: String(5 * GIB), memMax: String(8 * GIB), inactiveFile: GIB, hostTotal: 512 * GIB, hostAvailable: 100 * GIB, load: '1.25 1 1 2/300 7', ncpu: 96, ...o });
let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log('ok', name); };

await test('the sample command is fixed, isolated and read-only', async () => {
  const cmd = M.COMPUTER_METRICS_COMMAND;
  assert.match(cmd, /^\/usr\/bin\/python3 -I -S -B -c '[^']*'$/s, 'one single-quoted script, no shell expansion inside');
  assert.ok(!/[$`]/.test(cmd), 'no shell substitutions');
  for (const forbidden of ['environ', 'getenv', '/home', '~', 'open(p,"w', "'w'", 'subprocess', 'os.system', 'write(', 'unlink', 'remove', 'urllib', 'socket', 'import requests']) {
    assert.ok(!cmd.includes(forbidden), forbidden);
  }
  const paths = [...cmd.matchAll(/"(\/[^"]+)"/g)].map((m) => m[1]);
  assert.ok(paths.length > 0 && paths.every((p) => p.startsWith('/sys/fs/cgroup/') || p === '/proc/meminfo' || p === '/proc/loadavg'), paths.join(','));
});

await test('the script runs under python -B and prints one versioned JSON line even without cgroups', async () => {
  const script = M.COMPUTER_METRICS_COMMAND.match(/-c '([^']*)'$/s)[1];
  const py = process.platform === 'win32' ? 'python' : 'python3';
  const text = execFileSync(py, ['-I', '-S', '-B', '-c', script], { encoding: 'utf8', timeout: 20_000 });
  const j = JSON.parse(text.trim().split('\n').at(-1));
  assert.equal(j.v, 1); assert.ok(j.dt >= 0.9, 'samples the counter over about one second');
  assert.deepEqual(Object.keys(j).sort(), ['cfsPeriod', 'cfsQuota', 'cpuMax', 'dt', 'hostAvailable', 'hostTotal', 'inactiveFile', 'load', 'memCurrent', 'memMax', 'ncpu', 'u0', 'u1', 'v'].sort());
});

await test('cgroup v2: CPU delta over the quota, memory current minus inactive file over the cgroup limit', async () => {
  assert.deepEqual(M.parseComputerMetrics(`warning\n${out()}\n`, ALLOC), { cpuPercent: 50, memoryUsedGiB: 4, memoryLimitGiB: 8, memoryPercent: 50, load1: 1.25 });
  // A live increase shows in the cgroup before the Daytona record catches up: the cgroup limit wins.
  assert.equal(M.parseComputerMetrics(out({ memMax: String(16 * GIB) }), ALLOC).memoryLimitGiB, 16);
  assert.equal(M.parseComputerMetrics(out({ u1: 99_000_000 }), ALLOC).cpuPercent, 100, 'clamped');
});

await test('an unbounded cgroup uses the Daytona allocation, never the host total; host meminfo only backs the used figure', async () => {
  for (const memMax of ['max', String(2 ** 63 - 4096), String(600 * GIB)]) {
    const m = M.parseComputerMetrics(out({ memMax }), ALLOC);
    assert.equal(m.memoryLimitGiB, 8, memMax); assert.notEqual(m.memoryLimitGiB, 512);
  }
  const fallback = M.parseComputerMetrics(out({ memCurrent: null, memMax: 'max', inactiveFile: null }), ALLOC);
  assert.equal(fallback.memoryUsedGiB, 8, 'host used (412 GiB) is bounded by the sandbox limit'); assert.equal(fallback.memoryPercent, 100);
  assert.equal(M.parseComputerMetrics(out({ memMax: 'max' }), { cpu: 4, memoryGiB: null }), null, 'no knowable limit: unknown, not host total');
});

await test('CPU limit falls back from cpu.max to cgroup v1 quota, then the allocation; missing counters are null, not zero', async () => {
  assert.equal(M.parseComputerMetrics(out({ cpuMax: 'max 100000', cfsQuota: '200000', cfsPeriod: '100000' }), ALLOC).cpuPercent, 100);
  assert.equal(M.parseComputerMetrics(out({ cpuMax: 'max 100000' }), ALLOC).cpuPercent, 50);
  assert.equal(M.parseComputerMetrics(out({ cpuMax: null, u1: 1_000_000 }), { cpu: null, memoryGiB: 8 }).cpuPercent, round1(100 / 96));
  assert.equal(M.parseComputerMetrics(out({ u0: null }), ALLOC).cpuPercent, null);
  assert.equal(M.parseComputerMetrics(out({ dt: 0.01 }), ALLOC).cpuPercent, null);
  assert.equal(M.parseComputerMetrics(out({ u1: 0, u0: 5 }), ALLOC).cpuPercent, null, 'counter went backwards');
});
function round1(x) { return Math.round(x * 10) / 10; }

await test('garbage or partial samples are unknown', async () => {
  for (const raw of ['', 'Traceback', '{not json', JSON.stringify({ v: 2 }), out({ load: null }), out({ load: 'x' }), out({ memCurrent: null, hostTotal: null })]) {
    assert.equal(M.parseComputerMetrics(raw, ALLOC), null, raw.slice(0, 40));
  }
});

await test('estimated pricing and increase-only plans', async () => {
  assert.deepEqual(M.COMPUTER_PRICING, { asOf: '2026-10-19', url: 'https://www.daytona.io/pricing', estimated: true,
    cpuPerHour: 0.0504, memoryGiBPerHour: 0.0162, diskGiBPerHour: 0.000108, freeDiskGiB: 5 });
  assert.equal(M.computerHourlyCost({ cpu: 2, memoryGiB: 4, diskGiB: 5 }), 0.1656, 'first 5 GiB disk free');
  assert.equal(M.computerHourlyCost({ cpu: 4, memoryGiB: 8, diskGiB: 30 }), 0.3339);
  assert.deepEqual(M.computerPlans({ cpu: 2, memoryGiB: 4, diskGiB: 5 }).map((p) => [p.cpu, p.memoryGiB, p.usdPerHour, p.deltaUsdPerHour]),
    [[4, 8, 0.3312, 0.1656], [8, 16, 0.6624, 0.4968], [16, 32, 1.3248, 1.1592]]);
  assert.deepEqual(M.computerPlans({ cpu: 4, memoryGiB: 8, diskGiB: 5 }).map((p) => p.cpu), [8, 16]);
  assert.deepEqual(M.computerPlans({ cpu: 4, memoryGiB: 32, diskGiB: 5 }).map((p) => p.cpu), [16], 'never lowers RAM');
  assert.deepEqual(M.computerPlans({ cpu: 16, memoryGiB: 32, diskGiB: 5 }), []);
  assert.ok(M.isComputerPlan(8, 16)); assert.ok(!M.isComputerPlan(8, 8)); assert.ok(!M.isComputerPlan('8', 16));
  assert.equal(M.COMPUTER_METRICS_CACHE_MS >= 10_000, true);
});

console.log(`${passed} cloudbite-computer-performance tests passed`);
