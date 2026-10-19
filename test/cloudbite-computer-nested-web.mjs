// Cloudbite nested compute, browser run surface (src/cloudbite-computer-nested.ts): ownerRun/ownerStop trusted RPC,
// small input files (validation, idempotency, no echo) and the runner's private temporary working directory.
// Fake fetch only; no provider is called. The runner is executed locally against temporary directories.
//   node test/cloudbite-computer-nested-web.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { build } from 'esbuild';

const stubs = { name: 'stubs', setup(b) {
  b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'cf', namespace: 'stub' }));
  b.onLoad({ filter: /^cf$/, namespace: 'stub' }, () => ({ contents: 'export class DurableObject { constructor(ctx,env){this.ctx=ctx;this.env=env;} }' }));
} };
const tmp = mkdtempSync(join(tmpdir(), 'cloudbite-nested-web-'));
const bundle = await build({ entryPoints: ['src/cloudbite-computer-nested.ts'], bundle: true, write: false, format: 'esm', platform: 'node', plugins: [stubs] });
writeFileSync(join(tmp, 'm.mjs'), bundle.outputFiles[0].text);
const M = await import(pathToFileURL(join(tmp, 'm.mjs')));

let count = 0;
const check = async (name, f) => { await f(); count++; console.log('ok', name); };
const DAYTONA_KEY = 'dtn_MASTER_SECRET_daytona_0123456789';
const NOSANA_KEY = 'nos_MASTER_SECRET_nosana_0123456789';
const GATEWAY = 'https://gw.example.test';
const MACHINE = 'cbc-owner-machine-1';
const GPU = 'NVIDIA GeForce RTX 4090';
const uuid = () => crypto.randomUUID();
const b64 = (s) => Buffer.from(s).toString('base64');
const SECRET_FILE = 'TOP-SECRET-INPUT-CONTENT-42';

function memStorage() {
  const m = new Map(); let alarm = null;
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const clone = (v) => (v === undefined ? undefined : structuredClone(v));
  return {
    m, get alarm() { return alarm; },
    async get(k) { await tick(); return clone(m.get(k)); },
    async put(e) { await tick(); for (const [k, v] of Object.entries(e)) m.set(k, clone(v)); },
    async delete(keys) { await tick(); for (const k of keys) m.delete(k); },
    async list({ prefix }) { await tick(); return new Map([...m].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k, clone(v)])); },
    async setAlarm(t) { alarm = t; },
  };
}
function fakeNet() {
  const calls = []; const handlers = [];
  globalThis.fetch = async (url, init = {}) => {
    const req = new Request(url, init);
    const raw = init.body instanceof FormData ? init.body : init.body ? String(init.body) : null;
    const text = raw instanceof FormData ? await raw.get('file').text() : raw;
    const call = { method: req.method, url: req.url, auth: req.headers.get('authorization'), body: text };
    calls.push(call);
    for (const [m, re, h] of handlers) { const g = re.exec(req.url); if (m === req.method && g) return h(call, g); }
    throw new Error('unexpected fetch ' + req.method + ' ' + req.url);
  };
  return { calls, on: (m, re, h) => handlers.unshift([m, re, h]), reset: () => { calls.length = 0; } };
}
const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
function setup() {
  const clock = { t: Date.parse('2026-10-19T10:00:00Z') };
  const st = memStorage();
  const deps = {
    now: () => clock.t, random: (n) => crypto.getRandomValues(new Uint8Array(n)),
    daytona: () => ({ account: 'primary', c: { api: 'https://dt.example.test/api', key: DAYTONA_KEY } }),
    nosanaKey: () => NOSANA_KEY, gateway: () => GATEWAY,
  };
  // The Durable Object's JSON RPC surface over the same service.
  class T extends M.CloudbiteComputerNested { deps() { return deps; } }
  const dobj = new T({ storage: st }, {});
  const rpc = {
    run: async (i) => JSON.parse(await dobj.ownerRunJson(i)),
    stop: async (i) => JSON.parse(await dobj.ownerStopJson(i)),
    jobs: async () => JSON.parse(await dobj.ownerJobsJson()),
  };
  return { dobj, rpc, st, clock, net: fakeNet() };
}
const noLeak = (v) => {
  const s = JSON.stringify(v);
  for (const k of [DAYTONA_KEY, NOSANA_KEY, 'cbr_', 'cbn_', 'callbackHash', 'idempotencyKey', 'filesHash', 'contentBase64', SECRET_FILE, b64(SECRET_FILE)]) assert.ok(!s.includes(k), 'leaked ' + k);
};
const select = (dobj, country = 'US') => dobj.ownerSelectGpuJson({ ownerMachineId: MACHINE, requestId: uuid(), candidateId: `gpu-${country}`, gpu: GPU, country, market: M.CBN_NOSANA_MARKET });
const availability = (net) => net.on('POST', /^https:\/\/api\.nosana\.com\/reservations\/available$/, () => json({ total: 1, price: null, nodes: [] }));
const nosanaCreateOk = (net, id = 'dep-W') => net.on('POST', /\/deployments\/create$/, (c) => json({ id, name: JSON.parse(c.body).name, status: 'STARTING' }));
const daytonaOk = (net, state = 'started') => {
  net.on('POST', /dt\.example\.test\/api\/sandbox$/, (c) => json({ id: 'sb-W', state, toolboxProxyUrl: 'https://tb.example.test/toolbox', labels: JSON.parse(c.body).labels }));
  net.on('POST', /tb\.example\.test\/toolbox\/.+\/files\/upload/, () => new Response('', { status: 200 }));
  net.on('POST', /tb\.example\.test\/toolbox\/.+\/process\/execute$/, () => json({ exitCode: 0, result: '' }));
  net.on('POST', /tb\.example\.test\/toolbox\/.+\/process\/session$/, () => json({}));
  net.on('POST', /tb\.example\.test\/toolbox\/.+\/process\/session\/[\w-]+\/exec$/, () => json({ cmdId: 'c1' }));
};

await check('file validation: malformed shapes, path traversal, separators, duplicates, base64 and size limits', async () => {
  const ok = (name, content = 'x') => ({ name, contentBase64: b64(content) });
  for (const [bad, why] of [
    ['x', 'not an array'], [[ok('a'), ok('b'), ok('c'), ok('d')], 'more than 3'], [[null], 'null entry'], [['a'], 'string entry'],
    [[{ name: 'a' }], 'missing content'], [[{ ...ok('a'), mode: 0o777 }], 'extra key'], [[{ name: 'a', contentBase64: 5 }], 'content type'],
    [[ok('')], 'empty name'], [[ok('.')], 'dot'], [[ok('..')], 'dot dot'], [[ok('../evil')], 'traversal'], [[ok('a/b')], 'slash'],
    [[ok('a\\b')], 'backslash'], [[ok('.bashrc')], 'hidden'], [[ok('/etc/passwd')], 'absolute'], [[ok('C:x')], 'drive'],
    [[ok('a b')], 'space'], [[ok('x'.repeat(65))], 'long name'], [[ok('naïve')], 'non-ascii'], [[ok('a\u0000')], 'nul'],
    [[ok('in.txt'), ok('in.txt')], 'duplicate'], [[ok('In.txt'), ok('in.txt')], 'case duplicate'],
    [[{ name: 'a', contentBase64: 'abc' }], 'bad length'], [[{ name: 'a', contentBase64: 'YQ==\n' }], 'whitespace'],
    [[{ name: 'a', contentBase64: 'a-_b' }], 'url alphabet'], [[{ name: 'a', contentBase64: 'YR==' }], 'non-canonical bits'],
    [[{ name: 'a', contentBase64: 'Y===' }], 'over-padded'], [[{ name: 'a', contentBase64: 'A'.repeat(21852) }], 'encoded too long'],
    [[ok('a', 'x'.repeat(8192)), ok('b', 'y'.repeat(8193))], 'decoded total over 16 KiB'],
  ]) assert.equal(typeof M.cbNestedParseFiles(bad), 'string', why);
  assert.deepEqual(M.cbNestedParseFiles([ok('a', 'x'.repeat(8192)), ok('b.py', 'y'.repeat(8192)), { name: 'empty', contentBase64: '' }]).map((f) => f.name), ['a', 'b.py', 'empty'], 'exactly 16 KiB across 3 files');
  assert.deepEqual(M.cbNestedParseFiles([]), []);
  const msg = M.cbNestedParseFiles([ok('../' + SECRET_FILE)]);
  assert.ok(!msg.includes(SECRET_FILE), 'errors never echo input');
});

await check('ownerRun validation: bound machine, web fields only, files never accepted from the terminal gateway', async () => {
  const { rpc, dobj, net, st } = setup();
  await select(dobj);
  const base = { ownerMachineId: MACHINE, requestId: uuid(), provider: 'daytona', timeout: 60, command: ['python3', 'main.py'] };
  for (const bad of [
    null, [], { ...base, ownerMachineId: undefined }, { ...base, ownerMachineId: 'bad id' }, { ...base, gpu: GPU, country: 'US' },
    { ...base, acknowledgeCost: true }, { ...base, sandboxId: 'x' }, { ...base, files: [{ name: '../x', contentBase64: '' }] },
    { ...base, timeout: 9 }, { ...base, requestId: 'nope' }, { ...base, command: 'python3 main.py' },
  ]) assert.equal((await rpc.run(bad)).status, 400, JSON.stringify(bad)?.slice(0, 100));
  assert.equal(net.calls.length, 0); assert.ok(![...st.m.keys()].some((k) => k.startsWith('job:')));
  // The CLI gateway body is unchanged: files are an unknown field there.
  assert.equal(typeof M.cbNestedParseRun({ requestId: uuid(), provider: 'daytona', command: ['x'], files: [] }), 'string');
  assert.equal(typeof M.cbNestedParseRun({ requestId: uuid(), provider: 'nosana', command: ['x'], gpu: GPU, country: 'US' }), 'object');
});

await check('web nosana requires the machine\'s stored selection; never the pinned market', async () => {
  const { rpc, dobj, net, st } = setup();
  const body = { ownerMachineId: MACHINE, requestId: uuid(), provider: 'nosana', timeout: 60, command: ['nvidia-smi'] };
  const r = await rpc.run(body);
  assert.deepEqual([r.status, r.body.error.code], [409, 'selection_required']);
  assert.equal(net.calls.length, 0); assert.ok(![...st.m.keys()].some((k) => k.startsWith('job:') || k.startsWith('req:')));
  await dobj.ownerSelectGpuJson({ ownerMachineId: 'another-machine', requestId: uuid(), candidateId: 'c', gpu: GPU, country: 'US', market: null });
  assert.equal((await rpc.run({ ...body, requestId: uuid() })).body.error.code, 'selection_required', 'another machine\'s selection never applies');
  assert.equal(net.calls.length, 0);
});

await check('web nosana with files: stored selection, public definition carries the files, view and ledger echo none', async () => {
  const { rpc, dobj, net, st } = setup();
  await select(dobj, 'US');
  availability(net); nosanaCreateOk(net);
  const files = [{ name: 'main.py', contentBase64: b64(`print(${JSON.stringify(SECRET_FILE)})`) }];
  const body = { ownerMachineId: MACHINE, requestId: uuid(), provider: 'nosana', timeout: 120, command: ['python3', 'main.py'], files };
  const r = await rpc.run(body);
  assert.equal(r.status, 202, JSON.stringify(r.body));
  assert.deepEqual([r.body.job.status, r.body.job.gpu, r.body.job.country, r.body.job.public], ['queued', GPU, 'US', true]);
  noLeak(r.body); noLeak(await rpc.jobs());
  const create = JSON.parse(net.calls.find((c) => c.url.endsWith('/deployments/create')).body);
  assert.deepEqual(create.requirements, { name: GPU, country: 'US' }); assert.ok(!('market' in create));
  const arg = JSON.parse(Buffer.from(create.job_definition.ops[0].args.cmd.at(-1), 'base64url'));
  assert.deepEqual(Object.keys(arg).sort(), ['command', 'files', 'jobId', 'timeout']); assert.deepEqual(arg.files, files);
  for (const k of [NOSANA_KEY, DAYTONA_KEY, 'cbr_', GATEWAY]) assert.ok(!JSON.stringify(create).includes(k));
  const stored = st.m.get('job:' + r.body.job.id);
  assert.equal(stored.capId, 'web'); assert.equal(stored.ownerMachineId, MACHINE); assert.match(stored.filesHash, /^[0-9a-f]{64}$/);
});

await check('idempotency across args: same request replays; files, machine, provider or command changes conflict; selection fixed', async () => {
  const { rpc, dobj, net } = setup();
  await select(dobj, 'US');
  availability(net); nosanaCreateOk(net);
  const files = [{ name: 'in.txt', contentBase64: b64('one') }];
  const body = { ownerMachineId: MACHINE, requestId: uuid(), provider: 'nosana', timeout: 60, command: ['cat', 'in.txt'], files };
  const [a, b] = await Promise.all([rpc.run(body), rpc.run(body)]);
  assert.equal(a.body.job.id, b.body.job.id);
  assert.equal(net.calls.filter((c) => c.url.endsWith('/deployments/create')).length, 1, 'concurrent duplicates create once');
  await select(dobj, 'CA');
  net.reset();
  const again = await rpc.run(body);
  assert.deepEqual([again.status, again.body.replay, again.body.job.country], [200, true, 'US'], 'replay keeps the admitted selection');
  for (const change of [
    { files: [{ name: 'in.txt', contentBase64: b64('two') }] }, { files: [{ name: 'other.txt', contentBase64: b64('one') }] }, { files: undefined },
    { ownerMachineId: 'cbc-other-machine' }, { command: ['cat', 'x'] }, { timeout: 61 }, { provider: 'daytona' },
  ]) assert.equal((await rpc.run({ ...body, ...change })).status, 409, JSON.stringify(change));
  assert.equal(net.calls.length, 0, 'replays and conflicts never read availability or create');
});

await check('web daytona with files: private job file carries them; held only until launch; never in the job record', async () => {
  const { rpc, net, st, clock, dobj } = setup();
  daytonaOk(net, 'starting');
  const files = [{ name: 'data.csv', contentBase64: b64(SECRET_FILE) }];
  const r = await rpc.run({ ownerMachineId: MACHINE, requestId: uuid(), provider: 'daytona', timeout: 60, command: ['wc', '-c', 'data.csv'], files });
  assert.equal(r.status, 202); assert.equal(r.body.job.public, false);
  noLeak(r.body);
  const id = r.body.job.id;
  assert.ok(!JSON.stringify(st.m.get('job:' + id)).includes(b64(SECRET_FILE)), 'job record holds no file content');
  assert.deepEqual(st.m.get('launch:' + id).files, files);
  const create = JSON.parse(net.calls[0].body);
  assert.deepEqual([create.cpu, create.memory, create.disk, create.public], [2, 4, 8, false]);
  net.reset();
  net.on('GET', /\/api\/sandbox\/sb-W$/, () => json({ id: 'sb-W', state: 'started', toolboxProxyUrl: 'https://tb.example.test/toolbox', labels: { 'cloudbite-nested': id } }));
  clock.t += 15_000; await dobj.alarm();
  const job = JSON.parse(net.calls.filter((c) => c.url.includes('/files/upload'))[1].body);
  assert.deepEqual(job.files, files); assert.match(job.token, /^cbr_/);
  assert.equal(st.m.get('launch:' + id), undefined, 'files dropped with the launch secret');
  assert.ok(!net.calls.some((c) => (c.body ?? '').includes(DAYTONA_KEY)));
  noLeak(await rpc.jobs());
});

await check('ownerStop: bound to the machine when given, requestId required, then owned cleanup path', async () => {
  const { rpc, dobj, net } = setup();
  await select(dobj);
  availability(net); nosanaCreateOk(net, 'dep-S');
  const r = await rpc.run({ ownerMachineId: MACHINE, requestId: uuid(), provider: 'nosana', timeout: 60, command: ['nvidia-smi'] });
  const jobId = r.body.job.id;
  assert.equal((await rpc.stop({ ownerMachineId: MACHINE, jobId })).status, 400, 'requestId required');
  assert.equal((await rpc.stop({ ownerMachineId: 'bad id', requestId: uuid(), jobId })).status, 400);
  assert.equal((await rpc.stop({ ownerMachineId: 'cbc-other-machine', requestId: uuid(), jobId })).status, 404, 'another machine cannot stop it');
  assert.equal((await rpc.stop({ ownerMachineId: MACHINE, requestId: uuid(), jobId: 'nj' + '0'.repeat(24) })).status, 404);
  const s = await rpc.stop({ ownerMachineId: MACHINE, requestId: uuid(), jobId });
  assert.deepEqual([s.status, s.body.job.status, s.body.job.cleanup], [200, 'stopped', 'pending']);
  net.reset();
  net.on('GET', /\/deployments\/dep-S$/, () => json({ id: 'dep-S', name: 'cbn-' + jobId, status: 'STOPPED' }));
  net.on('DELETE', /\/deployments\/dep-S$/, () => json({}));
  await dobj.alarm();
  assert.equal((await rpc.jobs()).body.jobs[0].cleanup, 'done');
  assert.deepEqual(net.calls.map((c) => c.method + ' ' + new URL(c.url).pathname), ['GET /deployments/dep-S', 'DELETE /deployments/dep-S']);
});

// ---- the generated runner, executed locally; no callback, so the result is the stdout marker line ----
// The file form (as on Daytona) avoids the Windows command-line limit for the 16 KiB case; one case uses --b64 (Nosana).
const py = spawnSync('python3', ['--version']).status === 0 ? 'python3' : 'python';
const runner = (job, cwd, form = 'file') => new Promise((resolve) => {
  let args;
  if (form === 'b64') args = ['-I', '-c', M.CBN_RUNNER_PY, '--b64', Buffer.from(JSON.stringify(job)).toString('base64url')];
  else {
    const d = mkdtempSync(join(tmpdir(), 'cbn-runner-'));
    writeFileSync(join(d, 'runner.py'), M.CBN_RUNNER_PY); writeFileSync(join(d, 'job.json'), JSON.stringify(job));
    args = ['-I', join(d, 'runner.py'), join(d, 'job.json')];
  }
  const p = spawn(py, args, { cwd });
  let out = ''; p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', () => {});
  p.on('close', () => {
    const line = out.split(/\r?\n/).find((l) => l.startsWith(M.RESULT_MARKER ?? 'CLOUDBITE_RESULT_JSON:'));
    resolve(JSON.parse(line.slice('CLOUDBITE_RESULT_JSON:'.length)));
  });
});
const script = (s) => [py, '-I', '-c', s];

await check('runner: files land in a fresh private temp cwd, the command reads them, the dir is removed after success and failure', async () => {
  const outside = mkdtempSync(join(tmpdir(), 'cbn-outside-'));
  const files = [{ name: 'main.py', contentBase64: b64('print("from-file")') }, { name: 'data.txt', contentBase64: b64('abc') }];
  const probe = 'import os; print("cwd=" + os.getcwd()); print(sorted(os.listdir("."))); print(open("data.txt").read()); exec(open("main.py").read())';
  const ok = await runner({ jobId: 'nj' + '0'.repeat(24), timeout: 30, command: script(probe), files }, outside, 'b64');
  assert.equal(ok.exitCode, 0, ok.output);
  const cwd = /cwd=(.+)/.exec(ok.output)[1].trim();
  assert.notEqual(cwd, outside); assert.match(cwd, /cloudbite-job-/);
  assert.ok(ok.output.includes("['data.txt', 'main.py']") && ok.output.includes('abc') && ok.output.includes('from-file'));
  assert.ok(!existsSync(cwd), 'input dir removed after success');
  assert.deepEqual(readdirSync(outside), [], 'nothing written into the inherited directory');
  const fail = await runner({ jobId: 'nj' + '1'.repeat(24), timeout: 30, command: script('import os,sys; print("cwd=" + os.getcwd()); sys.exit(7)'), files }, outside);
  assert.equal(fail.exitCode, 7);
  assert.ok(!existsSync(/cwd=(.+)/.exec(fail.output)[1].trim()), 'input dir removed after failure');
  const slow = await runner({ jobId: 'nj' + '2'.repeat(24), timeout: 2, command: script('import os,time; print("cwd=" + os.getcwd(), flush=True); time.sleep(30)'), files }, outside);
  assert.equal(slow.timedOut, true);
  assert.ok(!existsSync(/cwd=(.+)/.exec(slow.output)[1].trim()), 'input dir removed after timeout');
});

await check('runner: malformed or escaping files never run the command and write nothing outside', async () => {
  const outside = mkdtempSync(join(tmpdir(), 'cbn-outside-'));
  const marker = join(outside, 'ran');
  const cmd = script(`open(${JSON.stringify(marker)}, "w").write("x")`);
  const before = new Set(readdirSync(tmpdir()).filter((n) => n.startsWith('cloudbite-job-')));
  for (const files of [
    [{ name: '../evil', contentBase64: b64('x') }], [{ name: 'a/b', contentBase64: b64('x') }], [{ name: '.', contentBase64: '' }],
    [{ name: 'a', contentBase64: 'not base64!' }], [{ name: 'a', contentBase64: b64('1') }, { name: 'A', contentBase64: b64('2') }],
    [{ name: 'big', contentBase64: b64('x'.repeat(16385)) }], 'notalist', [{ name: 'a' }],
  ]) {
    const r = await runner({ jobId: 'nj' + '3'.repeat(24), timeout: 30, command: cmd, files }, outside);
    assert.equal(r.exitCode, -1, JSON.stringify(files).slice(0, 60)); assert.equal(r.output, 'runner: invalid input files');
    assert.ok(!existsSync(marker), 'command never ran');
  }
  assert.deepEqual(readdirSync(outside), []);
  assert.ok(!existsSync(join(dirname(outside), 'evil')));
  const leftover = readdirSync(tmpdir()).filter((n) => n.startsWith('cloudbite-job-') && !before.has(n));
  assert.deepEqual(leftover, [], 'partial input dirs removed');
});

await check('runner: a job without files keeps the existing behaviour (inherited cwd, no temp dir)', async () => {
  const here = mkdtempSync(join(tmpdir(), 'cbn-plain-'));
  const r = await runner({ jobId: 'nj' + '4'.repeat(24), timeout: 30, command: script('import os; print(os.getcwd())') }, here);
  assert.equal(r.exitCode, 0);
  assert.equal(r.output.trim().toLowerCase(), here.toLowerCase());
});

console.log(`cloudbite-computer-nested-web: ${count} checks passed`);
