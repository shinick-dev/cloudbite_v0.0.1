// Cloud Files integration (docs/cloudbite/files-integration.md). Cross-layer: the real computerRoute → integration routes →
// VM bridge → real capability grant → the generated Python agent (FILES_AGENT_SOURCE, run with the local python) → HTTP over
// 127.0.0.1 → real agent routes → real files runtime + core service. Also the R2-absent, Origin, stopped-machine, lease close,
// safe-end begin barrier, end API and end-wiring (backup provider/settle/reconcile) contracts.
// MOCK boundaries, never live evidence: DO storage and R2 are in-memory doubles; the "VM" is a local directory where a fake
// Daytona exec/upload maps /home/daytona and runs the uploaded agent; the https gateway is reached through a loopback HTTP
// proxy (the capability endpoint is rewritten to it inside the fake VM, so TLS is not exercised). No provider network.
//   node test/cloudbite-computer-files-integration.mjs
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, readFile, rm, mkdir, rename, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

globalThis.fetch = async (u) => { throw new Error('network forbidden in this test: ' + u); };
globalThis.FixedLengthStream = class extends TransformStream {
  constructor(n) { let seen = 0; super({ transform(c, k) { seen += c.byteLength; if (seen > n) throw new Error('fixed length exceeded'); k.enqueue(c); }, flush() { if (seen !== n) throw new Error('fixed length short'); } }); }
};
Object.defineProperty(globalThis.crypto, 'DigestStream', { configurable: true, value: class extends WritableStream {
  constructor() { const h = createHash('sha256'); let done; const p = new Promise(r => { done = r; });
    super({ write(c) { h.update(c); }, close() { const d = h.digest(); done(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength)); } }); this.digest = p; }
} });

const PY = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const dir = await mkdtemp(join(tmpdir(), 'cloudbite-files-integration-'));
const servers = [];
const workers = [];
let passed = 0; const ok = (name) => { passed++; console.log('  ok', name); };
try {
  const root = resolve('.').replace(/\\/g, '/');
  const boundary = { name: 'boundary', setup(x) {
    x.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'cf', namespace: 'test' }));
    x.onResolve({ filter: /^\.\/state$/ }, () => ({ path: 'state', namespace: 'test' }));
    x.onResolve({ filter: /^\.\/cloudbite-owner$/ }, () => ({ path: 'owner', namespace: 'test' }));
    x.onResolve({ filter: /^\.\/cloudbite-computer-auth-api$/ }, () => ({ path: 'auth', namespace: 'test' }));
    x.onResolve({ filter: /^\.\/lab$/ }, () => ({ path: 'lab', namespace: 'test' }));
    x.onResolve({ filter: /^\.\/cloudbite-computer-(capacity-api|jobs-api|jobs-page|snapshots-page|latency-page|costs-page|latency|costs)$/ }, ({ path }) => ({ path: path.slice(2), namespace: 'helpers' }));
    x.onLoad({ filter: /.*/, namespace: 'helpers' }, ({ path }) => ({ contents: {
      'cloudbite-computer-capacity-api': 'export const capacitySandboxes=async()=>({});export const capacityGpuCandidates=async()=>null;export const capacityGpuSelect=async()=>null;',
      'cloudbite-computer-jobs-api': 'export const webJobsContext=async()=>({});export const webJobsRun=async()=>({});export const webJobsStop=webJobsRun;export const webJobOutput=async()=>({});',
      'cloudbite-computer-latency': 'export const latencyPing=()=>({status:200,body:{}});export const latencyBackend=async()=>({status:200,body:{}});',
      'cloudbite-computer-costs': 'export const computerCosts=async()=>({status:200,body:{}});',
    }[path] ?? ['JOBS', 'SNAPSHOTS', 'LATENCY', 'COSTS'].map(n => `export const CLOUDBITE_COMPUTER_${n}_HTML='';export const CLOUDBITE_COMPUTER_${n}_JS='';export const CLOUDBITE_COMPUTER_${n}_CSS='';`).join('') }));
    x.onLoad({ filter: /.*/, namespace: 'test' }, ({ path }) => ({ contents: {
      cf: 'export class DurableObject { constructor(ctx,env){this.ctx=ctx;this.env=env;} }',
      auth: 'export const computerAuthRoute=async()=>null;export const personalComputerCookieValid=async()=>false;',
      state: 'export const isFail=x=>!!x?.error;',
      owner: "export const ownerCookieValid=async r=>r.headers.get('cookie')==='owner=yes';",
      lab: "export const download=async()=>{throw Error('unexpected download')};export class DtError extends Error{};export const dt=async()=>{throw Error('unexpected provider call')};",
    }[path] }));
  } };
  const bundle = async (name, contents, platform) => {
    const b = await build({ stdin: { contents, resolveDir: root, loader: 'ts' }, bundle: true, write: false, format: 'esm', platform, plugins: [boundary] });
    const file = join(dir, name); await writeFile(file, b.outputFiles[0].text); return import(pathToFileURL(file));
  };
  const M = await bundle('m.mjs', `export {computerRoute} from '${root}/src/cloudbite-computer-api.ts';export * from '${root}/src/cloudbite-computer-files-runtime.ts';`
    + `export * from '${root}/src/cloudbite-computer-files-integration.ts';export {computerOwnerTag,computerLabels} from '${root}/src/cloudbite-computer-contract.ts';`
    + `export {FILES_BRIDGE_PATHS} from '${root}/src/cloudbite-computer-files-bridge.ts';`, 'neutral');
  const W = await bundle('w.mjs', `export * from '${root}/src/cloudbite-computer-end-wiring.ts';`, 'node');
  const Files = M.filesObjectClass(class { constructor(ctx, env) { this.ctx = ctx; this.env = env; } });

  // ---- doubles ----
  const clone = v => structuredClone(v);
  class MemStorage {
    constructor() { this.m = new Map(); }
    async get(k) { if (Array.isArray(k)) { const o = new Map(); for (const x of k) if (this.m.has(x)) o.set(x, clone(this.m.get(x))); return o; } return this.m.has(k) ? clone(this.m.get(k)) : undefined; }
    async put(k, v) { if (typeof k === 'object') for (const [a, c] of Object.entries(k)) this.m.set(a, clone(c)); else this.m.set(k, clone(v)); }
    async delete(k) { for (const x of Array.isArray(k) ? k : [k]) this.m.delete(x); }
    async list({ prefix = '', startAfter, limit = Infinity } = {}) {
      return new Map([...this.m.keys()].filter(k => k.startsWith(prefix) && (startAfter === undefined || k > startAfter)).sort().slice(0, limit).map(k => [k, clone(this.m.get(k))]));
    }
    async transaction(fn) {
      const run = async () => { const t = new MemStorage(); t.m = new Map([...this.m].map(([k, v]) => [k, clone(v)])); const r = await fn(t); this.m = t.m; return r; };
      const p = (this.txq ?? Promise.resolve()).then(run, run); this.txq = p.catch(() => {}); return p;
    }
  }
  const hexOf = u8 => createHash('sha256').update(u8).digest('hex');
  class MemR2 {
    constructor() { this.o = new Map(); this.calls = { put: 0, head: 0, get: 0 }; }
    async put(key, body, { sha256 }) {
      this.calls.put++; const parts = []; for await (const c of body) parts.push(...c);
      const u8 = Uint8Array.from(parts); if (hexOf(u8) !== sha256) throw new Error('checksum mismatch (provider rejected)');
      this.o.set(key, u8);
    }
    async head(key) { this.calls.head++; const u8 = this.o.get(key); if (!u8) return null;
      const d = createHash('sha256').update(u8).digest(); return { size: u8.length, checksums: { sha256: d.buffer.slice(d.byteOffset, d.byteOffset + 32) } }; }
    async get(key, opt) { this.calls.get++; const u8 = this.o.get(key); if (!u8) return null;
      const s = opt?.range ? u8.slice(opt.range.offset, opt.range.offset + opt.range.length) : u8;
      return { body: new Response(s).body }; }
  }

  const base = 'https://cloudbite.test', gw = 'https://gw.cloudbite.test';
  const tag = await M.computerOwnerTag();
  const MID = 'sb-0f4c0d0e-1111-2222-3333-444455556666';
  const machine = { id: MID, account: 'primary', name: 'cloudbite-computer-primary-x', labels: M.computerLabels(tag, 'primary'), status: 'running' };
  const endCalls = [];
  const computerRpc = {
    computerState: async () => ({ ok: true, status: 'running' }),
    computerMachine: async () => ({ ok: true, machine: { ...machine } }),
    computerEndStatus: async (t) => { endCalls.push(['status', t]); return { ok: true, phase: 'idle', uploadsFrozen: false }; },
    computerEnd: async (t, input) => { endCalls.push(['end', t, input]); return { ok: true, phase: 'draining' }; },
    computerEndSettings: async (t, input) => { endCalls.push(['settings', t, input]); return { ok: true }; },
  };
  const mkEnv = (bucket) => {
    const objects = new Map();
    const env = { ORIGIN: base, CLOUDBITE_GATEWAY_URL: gw, CLOUDBITE_FILES_BUCKET: bucket, CLOUDBITE_DAYTONA_API_KEY: 'dtn-test-key-not-real',
      CLOUDBITE_COMPUTER: { idFromName: () => 'owner', get: () => computerRpc } };
    env.CLOUDBITE_COMPUTER_FILES = { idFromName: n => n, get: id => {
      if (!objects.has(id)) objects.set(id, new Files({ storage: new MemStorage() }, env));
      return objects.get(id);
    } };
    env.objects = objects;
    return env;
  };
  const wire = [];   // every response text and agent stdout/stderr, for the secret check
  const state = { adminList: async () => ({ error: 'no admin' }) };
  const go = async (env, origin, p, init = {}) => {
    const r = new Request(origin + p, init); const res = await M.computerRoute(r, env, new URL(r.url), state);
    wire.push(await res.clone().text()); return res;
  };
  const owner = (extra = {}) => ({ cookie: 'owner=yes', ...extra });
  const post = (env, p, body, headers = {}) => go(env, base, '/api/cloudbite/computer/' + p, { method: 'POST', headers: owner({ origin: base, 'content-type': 'application/json', ...headers }), body: JSON.stringify(body) });
  const get = (env, p, headers = {}) => go(env, base, '/api/cloudbite/computer/' + p, { headers: owner(headers) });
  const put = (env, p, bytes) => go(env, base, '/api/cloudbite/computer/' + p, { method: 'PUT', headers: owner({ origin: base, 'content-length': String(bytes.length) }), body: bytes });
  const j = r => r.json();
  const uuid = () => crypto.randomUUID();

  /** Browser upload of one file version (create → begin → body → commit), as the files page does it. */
  async function browserUpload(env, parentId, name, bytes, fileId = null, baseVersion = null) {
    if (!fileId) { const c = await (await post(env, 'files/create', { requestId: uuid(), parentId, name, kind: 'file' })).json(); fileId = c.entry.fileId; }
    const st = (await (await get(env, 'files/status')).json()).status;
    const b = await (await post(env, 'files/uploads/begin', { requestId: uuid(), fileId, baseVersion, writerEpoch: st.writerEpoch, size: bytes.length, sha256: hexOf(bytes) })).json();
    assert.ok(b.upload, JSON.stringify(b));
    assert.equal((await put(env, `files/uploads/${b.upload.uploadId}/body`, bytes)).status, 200);
    const c = await (await post(env, `files/uploads/${b.upload.uploadId}/commit`, { uploadId: b.upload.uploadId })).json();
    assert.equal(c.result.status, 'committed'); return { fileId, versionId: c.result.versionId };
  }

  // ---- loopback proxy for the gateway: python agent → http://127.0.0.1:PORT → computerRoute at the https gateway origin ----
  async function loopback(env) {
    const server = createServer(async (req, res) => {
      const chunks = []; for await (const c of req) chunks.push(c);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string' && !['host', 'connection', 'transfer-encoding', 'keep-alive'].includes(k)) headers.set(k, v);
      const init = { method: req.method, headers };
      if (!['GET', 'HEAD'].includes(req.method)) init.body = Buffer.concat(chunks);
      try {
        const out = await go(env, gw, req.url, init);
        const buf = Buffer.from(await out.arrayBuffer());
        res.writeHead(out.status, { 'content-type': out.headers.get('content-type') ?? 'application/octet-stream', 'content-length': String(buf.length) });
        res.end(buf);
      } catch (e) { res.writeHead(500); res.end(String(e)); }
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r)); servers.push(server);
    return `http://127.0.0.1:${server.address().port}`;
  }

  // ---- the fake VM: Daytona exec/upload over a local directory that stands in for /home/daytona ----
  const P = M.FILES_BRIDGE_PATHS;
  function fakeVm(home, proxy) {
    const vm = { calls: [], uploads: new Map(), state: 'started', runs: [] };
    const local = (p) => p.startsWith('/home/daytona') ? join(home, p.slice('/home/daytona'.length)) : p;
    const exists = (p) => access(local(p)).then(() => true, () => false);
    const agent = (args) => new Promise((done) => {
      const argv = ['-B', local(P.agent), ...args.map(a => a.startsWith('/home/daytona') ? local(a) : a.replace(/=(\/home\/daytona\S*)/, (_, x) => '=' + local(x)))];
      execFile(PY, argv, { timeout: 60_000, windowsHide: true }, (err, stdout, stderr) => {
        wire.push(stdout, stderr); vm.runs.push(args.join(' '));
        done({ exitCode: err ? (typeof err.code === 'number' ? err.code : 1) : 0, result: stdout });
      });
    });
    const AGENT = /python3 (\S+) --state (\S+)(?: --capability (\S+))? (.*?)(?=$|'|;| && )/g;
    vm.io = {
      getSandbox: async (c, id) => { vm.calls.push(['getSandbox', id]); return { id: MID, name: machine.name, labels: { ...machine.labels }, state: vm.state }; },
      upload: async (c, sb, path, content) => {
        vm.calls.push(['upload', path]); vm.uploads.set(path, String(content));
        let text = String(content);
        // the https gateway is reached through the loopback proxy (TLS not exercised): rewrite only the endpoint origin
        if (path.endsWith('capability.json.next')) text = text.replace(JSON.stringify(gw + '/'), JSON.stringify(proxy + '/')).replace(gw + '/p/', proxy + '/p/');
        await mkdir(dirname(local(path)), { recursive: true }); await writeFile(local(path), text);
      },
      exec: async (c, sb, cmd) => {
        vm.calls.push(['exec', cmd]);
        if (cmd.includes('case "$(head -c 512')) {   // read-only install probe
          const mine = await exists(P.base + '/owner') && (await readFile(local(P.base + '/owner'), 'utf8')).startsWith(`cloudbite-files-bridge v1 machine=${MID} `);
          return { exitCode: mine && await exists(P.agent) && await exists(P.watcher) && await exists(P.capability) && await exists(P.state + '/journal.sqlite3') ? 0 : 43, result: '' };
        }
        if (cmd.includes('cloudbite-files-bridge v1') && cmd.includes('mkdir -p "$S"')) {   // prepare: owned private dirs + empty placeholders
          for (const d of [P.base + '/agent', P.state, P.manifests, P.watchState, P.root]) await mkdir(local(d), { recursive: true });
          await writeFile(local(P.base + '/owner'), cmd.match(/M="([^"]+)"/)[1]);
          return { exitCode: 0, result: '' };
        }
        if (cmd.includes('cloudbite-files-bridge v1')) return { exitCode: 0, result: '' };   // capability refresh placeholder
        if (cmd.includes('"$B/capability.json.next"') && cmd.includes('mv -f')) {   // ACTIVATE / capability-only activate
          for (const f of [P.agent, P.watcher, P.capability]) if (cmd.includes(f.slice(P.base.length + 1) + '.next')) await rename(local(f + '.next'), local(f));
          return { exitCode: 0, result: '' };
        }
        const w = /python3 -I -B (\S+) --state (\S+) --agent (\S+) --agent-state (\S+) --capability (\S+) --root (\S+) (resume)'$/.exec(cmd);
        if (w) return watcher(w.slice(1, 7), ['resume']);
        if (cmd.includes('exit 43') && !(await exists(P.agent) && await exists(P.capability))) return { exitCode: 43, result: '' };
        if (cmd.includes('install -m 600 /dev/null') && cmd.includes(P.manifests)) return { exitCode: 0, result: '' };
        const mv = /mv -f (\S+)\.next (\S+) &&/.exec(cmd);
        if (mv) await rename(local(mv[1] + '.next'), local(mv[2]));
        let last = { exitCode: 1, result: '' };
        for (const m of cmd.matchAll(AGENT)) {
          const args = ['--state', m[2], ...(m[3] ? ['--capability', m[3]] : []), ...m[4].trim().split(/\s+/)];
          last = await agent(args);
          if (last.exitCode !== 0) break;
        }
        const rmf = /rm -f (\S+); exit \$rc/.exec(cmd);
        if (rmf) await rm(local(rmf[1]), { force: true });
        return last;
      },
    };
    // the watcher CLI as the bridge passes it (fixed paths mapped into the local home)
    const watchArgv = (paths, args) => ['-B', local(paths[0]), '--state', local(paths[1]), '--agent', local(paths[2]), '--agent-state', local(paths[3]),
      '--capability', local(paths[4]), '--root', local(paths[5]), ...args];
    const watcher = (paths, args) => new Promise((done) => {
      execFile(PY, watchArgv(paths, args), { timeout: 60_000, windowsHide: true }, (err, stdout, stderr) => {
        wire.push(stdout, stderr); vm.runs.push('watch ' + args.join(' '));
        done({ exitCode: err ? (typeof err.code === 'number' ? err.code : 1) : 0, result: stdout });
      });
    });
    const RUN = /python3 -I -B (\S+) --state (\S+) --agent (\S+) --agent-state (\S+) --capability (\S+) --root (\S+) run --max-runtime (\d+) >>/;
    vm.spawns = []; vm.workers = [];
    // spawn: the toolbox session's async exec. With vm.launch set, the submitted run really starts (local python, short
    // interval) and keeps running in the background like the session would; it is stopped at the end of the test.
    vm.io.spawn = async (c, sb, session, cmd) => {
      vm.calls.push(['spawn', session, cmd]); vm.spawns.push(cmd);
      const m = RUN.exec(cmd); assert.ok(m, cmd);
      if (!vm.launch) return;
      const child = execFile(PY, watchArgv(m.slice(1, 7), ['run', '--max-runtime', String(Math.min(Number(m[7]), 120)), '--interval', '2', '--debounce', '0.5']),
        { timeout: 150_000, windowsHide: true }, (err, stdout, stderr) => { wire.push(stdout, stderr); child.out = stdout; child.code = err ? err.code : 0; child.done = true; });
      vm.workers.push(child); workers.push(child);
    };
    vm.cli = (...args) => agent(['--state', P.state, '--capability', P.capability, ...args]);
    vm.local = local;
    return vm;
  }

  // ===== 1. R2 absent: catalog still lists; bridge refuses before any VM write or grant =====
  {
    const env = mkEnv(undefined);
    const vm = fakeVm(join(dir, 'home-noR2'), 'http://127.0.0.1:9');
    const route = (req, op) => M.filesIntegrationRoute(req, env, op, tag, computerRpc, vm.io);
    const req = (p, body, h = {}) => new Request(`${base}/api/cloudbite/computer/${p}`, body === undefined ? { headers: h }
      : { method: 'POST', headers: { origin: base, 'content-type': 'application/json', ...h }, body: JSON.stringify(body) });
    let r = await route(req('files/agent/configure', { requestId: uuid() }), 'files/agent/configure');
    assert.equal(r.status, 503); assert.equal((await j(r)).error.code, 'store_not_configured');
    r = await route(req('files/materialize', { requestId: uuid(), fileId: 'f_' + 'a'.repeat(26) }), 'files/materialize');
    assert.equal(r.status, 503); assert.equal((await j(r)).error.code, 'store_not_configured');
    r = await route(req('files/agent/status'), 'files/agent/status');
    assert.deepEqual(await j(r), { ok: true, available: false, reason: 'store_not_configured' });
    assert.equal(vm.calls.length, 0, 'no provider call, no upload, no grant');
    assert.ok(![...env.objects.values()].some(o => [...o.ctx.storage.m.keys()].some(k => k.startsWith('cap/'))), 'no capability minted');
    // the metadata catalog works without R2 (through the real router)
    r = await post(env, 'files/create', { requestId: uuid(), parentId: 'root', name: 'Notes', kind: 'dir' }); assert.equal(r.status, 200);
    r = await get(env, 'files?parentId=root&limit=10'); assert.deepEqual((await j(r)).entries.map(e => e.name), ['Notes']);
    r = await post(env, 'files/agent/configure', { requestId: uuid() }); assert.equal((await j(r)).error.code, 'store_not_configured', 'routed before the catalog');
    ok('R2 absent: configure/materialize 503 store_not_configured before any VM call or grant; agent status unavailable; catalog lists');
  }

  // ===== 2. request gates: Origin, method, strict bodies, stopped machine, ownership =====
  const bucket = new MemR2();
  const env = mkEnv(bucket);
  const proxy = await loopback(env);
  const home = join(dir, 'home');
  const vm = fakeVm(home, proxy);
  const route = (req, op, io = vm.io, rpc = computerRpc) => M.filesIntegrationRoute(req, env, op, tag, rpc, io);
  const preq = (op, body, h = {}) => new Request(`${base}/api/cloudbite/computer/${op}`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json', ...h }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  // The VM-touching routes run the real filesIntegrationRoute with the fake-VM io (computerRoute itself would use the real
  // Daytona REST helpers); owner auth in front of it is the router's, pinned in section 1 and the runtime suite.
  const bridge = async (op, body) => {
    const res = await route(body === undefined ? new Request(`${base}/api/cloudbite/computer/${op}`) : preq(op, body), op);
    wire.push(await res.clone().text()); return res;
  };
  {
    let r = await route(preq('files/agent/configure', { requestId: uuid() }, { origin: 'https://attacker.invalid' }), 'files/agent/configure'); assert.equal(r.status, 403);
    r = await route(new Request(`${base}/x`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-token': 'adm' }, body: '{}' }), 'files/materialize');
    assert.equal(r.status, 403, 'no Origin (admin token alone) is refused');
    r = await route(preq('files/close', { leaseId: 'a'.repeat(32) }, { 'sec-fetch-site': 'cross-site' }), 'files/close'); assert.equal(r.status, 403);
    r = await route(new Request(`${base}/x`), 'files/materialize'); assert.equal(r.status, 405);
    r = await route(preq('files/agent/configure', { requestId: uuid(), extra: 1 }), 'files/agent/configure'); assert.equal(r.status, 400, 'unknown key refused');
    r = await route(preq('files/agent/configure', { requestId: 'not-a-uuid' }), 'files/agent/configure'); assert.equal(r.status, 400);
    r = await route(preq('files/agent/configure', 'x'.repeat(5000)), 'files/agent/configure'); assert.equal(r.status, 400, 'body cap');
    r = await route(preq('files/close', { leaseId: 'XYZ' }), 'files/close'); assert.equal((await j(r)).error.code, 'bad_request');
    assert.equal(await route(new Request(`${base}/x`), 'files/status'), null, 'catalog routes are not taken');
    const stopped = { ...computerRpc, computerMachine: async () => ({ ok: true, machine: { ...machine, status: 'stopped' } }) };
    r = await route(preq('files/agent/configure', { requestId: uuid() }), 'files/agent/configure', vm.io, stopped);
    assert.equal(r.status, 409); assert.equal((await j(r)).error.code, 'not_running');
    assert.equal(vm.calls.length, 0, 'a stopped machine is never touched (no start, no provider call)');
    const foreign = { ...vm.io, getSandbox: async () => ({ id: MID, name: machine.name, labels: {}, state: 'started' }) };
    r = await route(preq('files/agent/configure', { requestId: uuid() }), 'files/agent/configure', foreign);
    assert.equal((await j(r)).error.code, 'ownership_mismatch');
    assert.ok(![...env.objects.values()].some(o => [...o.ctx.storage.m.keys()].some(k => k.startsWith('cap/active'))), 'no grant before ownership is proven');
    ok('Origin exact, cross-site/method/strict-key/body-cap refusals; stopped or unowned machine refused before any grant or write');
  }
  // ===== 2b. JSON bodies are read through a byte-bounded stream: no buffering past the cap, whatever the headers say =====
  {
    const before = vm.calls.length;
    const endless = () => {
      const s = { pulls: 0, cancelled: false };
      s.body = new ReadableStream({ pull(c) { if (++s.pulls > 100) return c.close(); c.enqueue(new TextEncoder().encode('{"requestId":"' + 'a'.repeat(1000))); }, cancel() { s.cancelled = true; } });
      return s;
    };
    const streamed = (body, h = {}) => new Request(`${base}/api/cloudbite/computer/files/agent/configure`,
      { method: 'POST', headers: { origin: base, 'content-type': 'application/json', ...h }, body, duplex: 'half' });
    let s = endless();
    let r = await route(streamed(s.body), 'files/agent/configure');
    assert.equal(r.status, 400); assert.ok(s.cancelled, 'chunked oversize body is cancelled'); assert.ok(s.pulls <= 8, `stopped after ~4 KiB (${s.pulls} chunks)`);
    s = endless();
    r = await route(streamed(s.body, { 'content-length': '20' }), 'files/agent/configure');
    assert.equal(r.status, 400); assert.ok(s.cancelled && s.pulls <= 8, 'a forged small Content-Length does not lift the cap');
    for (const cl of ['5000', 'abc', '-1', '1e3']) {
      s = endless(); r = await route(streamed(s.body, { 'content-length': cl }), 'files/agent/configure');
      assert.equal(r.status, 400, cl); assert.ok(s.pulls <= 1, `refused on the header alone (${cl})`);
    }
    // multi-byte: under 4096 characters but over 4096 bytes
    r = await route(preq('files/agent/configure', { requestId: '가'.repeat(2000) }), 'files/agent/configure'); assert.equal(r.status, 400);
    // malformed UTF-8 fails closed (no replacement-character decoding)
    const bad = new Uint8Array([...new TextEncoder().encode('{"requestId":"'), 0xff, 0xfe, ...new TextEncoder().encode('"}')]);
    r = await route(new Request(`${base}/x`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: bad }), 'files/agent/configure');
    assert.equal(r.status, 400);
    for (const raw of ['', 'null', '[]', '{"requestId":', '{"requestId":"x"} trailing']) {
      r = await route(preq('files/agent/configure', raw), 'files/agent/configure'); assert.equal(r.status, 400, raw);
    }
    const lease = new TextEncoder().encode(JSON.stringify({ leaseId: 'a'.repeat(32) }));
    let sent = 0;
    const slow = new ReadableStream({ pull(c) { if (sent >= lease.length) return c.close(); c.enqueue(lease.slice(sent, sent + 5)); sent += 5; } });
    r = await route(streamed(slow).constructor === Request ? new Request(`${base}/x`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: slow, duplex: 'half' }) : null, 'files/close');
    assert.notEqual(r.status, 400, 'a valid body split into small chunks is reassembled');
    assert.equal(vm.calls.slice(before).filter(c => c[0] !== 'getSandbox' && !(c[0] === 'exec' && c[1].includes(' close --lease='))).length, 0, 'refused bodies reach no provider step');
    ok('bounded JSON: chunked/forged-length oversize cancelled at ~4 KiB, bad lengths/UTF-8/JSON refused, small chunks reassembled');
  }

  // ===== 3. cross-layer: browser upload → configure → materialize (real agent over loopback) → edit + sync → download =====
  const v1 = new TextEncoder().encode('first version — 첫 번째\n'.repeat(50));
  let r = await post(env, 'files/create', { requestId: uuid(), parentId: 'root', name: 'Docs', kind: 'dir' });
  const docs = (await j(r)).entry;
  const a = await browserUpload(env, docs.fileId, 'a.txt', v1);
  const doR = env.objects.get(tag); assert.ok(doR, 'files DO is keyed by the owner tag');

  const cfgId = uuid();
  r = await bridge('files/agent/configure', { requestId: cfgId });
  const cfg = await j(r); assert.equal(r.status, 200, JSON.stringify(cfg));
  assert.equal(cfg.installed, true); assert.equal(cfg.machineId, MID); assert.equal(cfg.writerEpoch, 2);
  const capText = await readFile(vm.local(P.capability), 'utf8');
  const token = JSON.parse(capText).token; assert.match(token, /^cbfa_/);
  assert.ok(!JSON.stringify(cfg).includes(token), 'token never in the response');
  for (const [k, cmd] of vm.calls) if (k === 'exec') assert.ok(!cmd.includes(token), 'token never in a command line');
  assert.equal(vm.uploads.get(P.agent + '.next').length > 1000, true, 'the generated agent source was uploaded and is what runs');
  ok('configure: real grant minted for the proven running machine, capability only in the private upload, agent installed + initialised');

  r = await bridge('files/agent/status');
  let as = await j(r); assert.equal(as.available, true); assert.equal(as.agent.transportConfigured, true); assert.equal(as.agent.eviction, 'gated');
  assert.ok(Object.keys(as.agent).every(k => ['states', 'unconfirmedOps', 'openLeases', 'pinned', 'transportConfigured', 'draining', 'freeBytes', 'reserveBytes', 'autoEvict', 'eviction'].includes(k)));
  ok('agent status: counts only (whitelisted), HTTP eviction reported gated');

  const getsBefore = bucket.calls.get;
  const matId = uuid();
  r = await bridge('files/materialize', { requestId: matId, fileId: a.fileId });
  const mat = await j(r); assert.equal(r.status, 200, JSON.stringify(mat));
  assert.equal(mat.launched, false); assert.equal(mat.workspace, '~/CloudFiles');
  assert.equal(mat.open.leaseId, matId.replace(/-/g, '')); assert.equal(mat.open.versionId, a.versionId);
  const localA = join(vm.local(P.root), 'Docs', 'a.txt');
  assert.equal(hexOf(await readFile(localA)), hexOf(v1), 'the prepared copy is byte-identical to the saved version');
  assert.ok(bucket.calls.get > getsBefore, 'bytes came from the body store through the agent content route');
  const manifest = JSON.parse(vm.uploads.get(`${P.manifests}/${matId}.json.next`));
  const plan = await doR.filesManifest(tag, { fileId: a.fileId, versionId: null });
  assert.deepEqual(manifest, M.filesBridgeManifestOf(plan.body.manifest), 'the VM got the server-resolved manifest');
  assert.ok(vm.runs.some(x => x.includes(`--lease=${matId.replace(/-/g, '')}`)));
  r = await bridge('files/materialize', { requestId: matId, fileId: a.fileId });
  const again = await j(r); assert.equal(again.open.leaseId, mat.open.leaseId); assert.equal(again.open.fetchedBytes, 0, 'retry replays the same lease');
  as = await j(await bridge('files/agent/status')); assert.equal(as.agent.openLeases, 1, 'one lease, not two');
  r = await bridge('files/materialize', { requestId: uuid(), fileId: 'f_' + 'z'.repeat(26) });
  assert.equal(r.status, 404, 'an unknown file is refused by the catalog before any VM step');
  r = await bridge('files/close', { leaseId: mat.open.leaseId }); assert.equal(r.status, 200);
  as = await j(await bridge('files/agent/status')); assert.equal(as.agent.openLeases, 0);
  ok('materialize: server manifest → real agent fetch over loopback, hash-verified copy, no app launched; retry keeps one lease; close releases');

  // edit on the "VM" and let the agent upload it
  const v2 = new TextEncoder().encode('second version from the cloud computer\n');
  await writeFile(localA, v2);
  let o = await vm.cli('mark-dirty', '--path', 'Docs/a.txt'); assert.equal(o.exitCode, 0, o.result);
  o = await vm.cli('sync'); assert.equal(o.exitCode, 0, o.result);
  const synced = JSON.parse(o.result.trim().split('\n').at(-1));
  assert.equal(synced.results.length, 1); assert.ok(['committed', 'clean'].includes(synced.results[0].status ?? synced.results[0].state), o.result);
  o = await vm.cli('reconcile'); assert.equal(o.exitCode, 0, o.result);
  const listGets = bucket.calls.get;
  r = await get(env, `files?parentId=${docs.fileId}&limit=10`);
  const entry = (await j(r)).entries[0];
  await get(env, 'files/status');
  assert.equal(bucket.calls.get, listGets, 'listing and status are catalog-only (no body read)');
  assert.notEqual(entry.currentVersion, a.versionId); assert.equal(entry.size, v2.length);
  r = await get(env, `files/content/${a.fileId}?versionId=${entry.currentVersion}`);
  assert.equal(r.status, 200); assert.equal(hexOf(new Uint8Array(await r.arrayBuffer())), hexOf(v2), 'browser download hash = the edited bytes');
  ok('agent sync + reconcile over loopback commit the edit; browser list is catalog-only; download hash matches');

  // stale epoch: another writer took over; the agent's next upload is refused and nothing is saved
  const cur = (await j(await get(env, 'files/status'))).status.writerEpoch;
  await doR.svc.advanceWriter(tag, { requestId: 'w-takeover', expectedEpoch: cur, machineId: MID });
  await writeFile(localA, new TextEncoder().encode('third, after the takeover\n'));
  await vm.cli('mark-dirty', '--path', 'Docs/a.txt');
  o = await vm.cli('sync');
  assert.match(o.result, /stale_writer/, o.result);
  r = await get(env, `files?parentId=${docs.fileId}&limit=10`);
  assert.equal((await j(r)).entries[0].currentVersion, entry.currentVersion, 'stale writer saved nothing');
  ok('stale epoch: the agent upload is refused (stale_writer) and the saved version is unchanged');

  // ===== 4. safe-end barrier: browser begin is frozen during an end; agent drain traffic is not =====
  {
    const real = computerRpc.computerEndStatus;
    computerRpc.computerEndStatus = async () => ({ ok: true, phase: 'draining', uploadsFrozen: true });
    const st = (await j(await get(env, 'files/status'))).status;
    const bytes = new TextEncoder().encode('blocked');
    r = await post(env, 'files/uploads/begin', { requestId: uuid(), fileId: a.fileId, baseVersion: entry.currentVersion, writerEpoch: st.writerEpoch, size: bytes.length, sha256: hexOf(bytes) });
    let e = await j(r); assert.equal(r.status, 409); assert.equal(e.error.code, 'end_in_progress'); assert.equal(e.error.retryable, true);
    computerRpc.computerEndStatus = async () => { throw new Error('computer object unavailable'); };
    r = await post(env, 'files/uploads/begin', { requestId: uuid(), fileId: a.fileId, baseVersion: entry.currentVersion, writerEpoch: st.writerEpoch, size: bytes.length, sha256: hexOf(bytes) });
    e = await j(r); assert.equal(r.status, 503); assert.equal(e.error.code, 'catalog_unavailable', 'unknown end state fails closed');
    computerRpc.computerEndStatus = async () => ({ ok: true, phase: 'draining', uploadsFrozen: true });
    const g = await M.filesAgentGrant(env, tag, machine, 'g-drain'); assert.ok(g.ok);
    const A = (p, init = {}) => go(env, gw, M.FILES_AGENT_PATH + '/' + p, { ...init, headers: { authorization: 'Bearer ' + g.body.token, ...(init.headers ?? {}) } });
    r = await A('uploads/begin', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId: 'drain-1', fileId: a.fileId, baseVersion: entry.currentVersion, writerEpoch: g.body.writerEpoch, size: bytes.length, sha256: hexOf(bytes) }) });
    assert.equal(r.status, 200, 'the agent drain can still finish its uploads (no deadlock)');
    r = await get(env, 'files?parentId=root&limit=10'); assert.equal(r.status, 200, 'browsing stays available');
    computerRpc.computerEndStatus = real;
    ok('safe end: browser begin frozen (end_in_progress, retryable), unknown end state fails closed, agent uploads and listing stay open');
  }

  // ===== 5. end API routes =====
  {
    endCalls.length = 0;
    r = await get(env, 'end'); assert.equal(r.status, 200); assert.equal((await j(r)).phase, 'idle');
    const req = { requestId: uuid(), mode: 'disk_backup' };
    r = await post(env, 'end', req); assert.equal((await j(r)).phase, 'draining');
    r = await post(env, 'end/settings', { autoBackup: true }); assert.equal(r.status, 200);
    r = await go(env, base, '/api/cloudbite/computer/end', { method: 'POST', headers: owner({ origin: 'https://attacker.invalid', 'content-type': 'application/json' }), body: '{}' });
    assert.equal(r.status, 403);
    r = await go(env, base, '/api/cloudbite/computer/end', { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: '{}' });
    assert.equal(r.status, 401);
    assert.deepEqual(endCalls, [['status', tag], ['end', tag, req], ['settings', tag, { autoBackup: true }]]);
    ok('end API: GET end, POST end, POST end/settings forwarded to the computer object with owner auth and exact Origin');
  }

  // ===== 6. end wiring: backup provider, settle and read-only reconcile =====
  {
    const calls = [];
    const daytona = {
      getSnapshot: async (c, n) => { calls.push(['get', c.key, n]); return { id: 'snap1', name: n, state: 'active' }; },
      createSnapshot: async (c, id, n) => { calls.push(['create', c.key, id, n]); },
      removeSnapshot: async (c, id) => { calls.push(['remove', c.key, id]); return 'accepted'; },
    };
    const wenv = { CLOUDBITE_DAYTONA_API_KEY: 'k-primary', CLOUDBITE_DAYTONA_SECONDARY_API_KEY: 'k-secondary' };
    const p = W.computerBackupProvider(wenv, daytona);
    await p.createSnapshot('secondary', MID, 'cb-backup-x');
    assert.deepEqual(calls.at(-1), ['create', 'k-secondary', MID, 'cb-backup-x'], 'the item\'s own account, never substituted');
    assert.equal((await p.getSnapshot('primary', 'cb-backup-x')).state, 'active');
    await p.removeSnapshot('primary', 'snap1'); assert.deepEqual(calls.at(-1), ['remove', 'k-primary', 'snap1']);
    await assert.rejects(p.createSnapshot('tertiary', MID, 'n'), (e) => e.status === 400, 'missing account: definite refusal, nothing sent');
    const n = calls.length;
    await assert.rejects(W.computerBackupProvider(wenv, { ...daytona, removeSnapshot: undefined }).removeSnapshot('primary', 'snap1'), (e) => e.status === 400);
    assert.equal(calls.length, n);

    const log = [];
    const unconfirmed = { state: 'unknown', reason: 'create_unconfirmed', work: false, line: 'x' };
    const mgr = {
      summary: async () => { log.push('summary'); return { items: [{ state: 'unconfirmed' }] }; },
      reconcile: async () => { log.push('reconcile'); return { items: [] }; },
      begin: async () => { log.push('begin'); return { ...unconfirmed }; },
      tick: async () => ({ ...unconfirmed }),
      status: async () => null,
    };
    const hook = W.computerEndBackupHook(mgr);
    const b = await hook.begin(tag, { requestId: uuid() });
    assert.deepEqual(log, ['summary', 'reconcile', 'begin'], 'read-only reconcile of unconfirmed creates before begin');
    assert.equal(b.state, 'blocked'); assert.equal(b.reason, 'create_unconfirmed', 'ends honestly as blocked, reason kept');
    assert.equal((await hook.tick(tag)).state, 'blocked');
    assert.equal(await hook.status(tag), null);
    mgr.tick = async () => ({ state: 'unknown', reason: 'create_unconfirmed', work: true });
    assert.equal((await hook.tick(tag)).state, 'unknown', 'work still possible: not forced to blocked');
    mgr.summary = async () => { throw new Error('storage'); };
    log.length = 0; assert.equal((await hook.begin(tag, {})).state, 'blocked'); assert.deepEqual(log, ['begin'], 'recheck failure never blocks begin itself');

    const hooks = W.computerEndHooks(wenv, new MemStorage(), daytona);
    assert.deepEqual(Object.keys(hooks), ['backup'], 'no files drain wired: files_verified stays unavailable');
    ok('end wiring: per-item account backup provider (no R2 needed), unconfirmed create → read-only reconcile then honest blocked; no drain hook');
  }

  // ===== 7. continuous autosave: configure launches the real watcher; it survives a stop/start through the resume hook =====
  {
    const bucket2 = new MemR2(), env2 = mkEnv(bucket2), proxy2 = await loopback(env2);
    const vm2 = fakeVm(join(dir, 'home-watch'), proxy2); vm2.launch = true;
    const route2 = (op, body) => M.filesIntegrationRoute(preq(op, body), env2, op, tag, computerRpc, vm2.io);
    const folder = (await j(await post(env2, 'files/create', { requestId: uuid(), parentId: 'root', name: 'Work', kind: 'dir' }))).entry;
    const b = await browserUpload(env2, folder.fileId, 'b.txt', new TextEncoder().encode('draft 1\n'));
    r = await route2('files/agent/configure', { requestId: uuid() });
    let c = await j(r); assert.equal(r.status, 200, JSON.stringify(c));
    assert.deepEqual(c.watcher, { resumed: true, agentResumed: true, launch: 'submitted', running: 'not_observed' }, 'submission is not reported as running');
    assert.equal(vm2.spawns.length, 1); assert.equal(vm2.calls.find(x => x[0] === 'spawn')[1], 'cloudbite-files-watch');
    const m = await j(await route2('files/materialize', { requestId: uuid(), fileId: b.fileId }));
    assert.equal(m.open.state, 'clean', JSON.stringify(m));
    await route2('files/close', { leaseId: m.open.leaseId });
    const localB = join(vm2.local(P.root), 'Work', 'b.txt');
    const saved = async (bytes, label) => {   // the watcher (not a manual sync) uploads the edit; bounded wait
      for (let i = 0; i < 120; i++) {
        const e = (await j(await get(env2, `files?parentId=${folder.fileId}&limit=10`))).entries[0];
        if (e.size === bytes.length && e.currentVersion !== b.versionId) {
          const body = new Uint8Array(await (await get(env2, `files/content/${b.fileId}?versionId=${e.currentVersion}`)).arrayBuffer());
          if (hexOf(body) === hexOf(bytes)) return e.currentVersion;
        }
        await new Promise(res => setTimeout(res, 500));
      }
      assert.fail(`${label}: the running watcher did not save the edit within 60 s; worker out: ${vm2.workers.map(w => w.out).join(' | ')}`);
    };
    const v2b = new TextEncoder().encode('edited on the cloud computer, saved by the watcher\n');
    await writeFile(localB, v2b);
    const firstSaved = await saved(v2b, 'configure');
    assert.ok(!vm2.runs.some(x => x.includes('mark-dirty') || / sync$/.test(x)), 'no manual mark-dirty/sync was issued by the test');
    // idempotent reconfigure: a second run is submitted, but the watcher lock keeps exactly one worker
    r = await route2('files/agent/configure', { requestId: uuid() }); assert.equal(r.status, 200);
    c = await j(r); assert.equal(c.watcher.resumed, 'deferred', 'the running worker took the resume request');
    for (let i = 0; i < 60 && !vm2.workers[1].done; i++) await new Promise(res => setTimeout(res, 250));
    assert.ok(vm2.workers[1].done && /"code": "watcher_busy"/.test(vm2.workers[1].out), 'the duplicate exited on the lock: ' + vm2.workers[1].out);
    assert.ok(!vm2.workers[0].done, 'the first worker keeps running');
    // ordinary stop: the VM processes are gone
    for (const w of vm2.workers) if (!w.done) w.kill();
    for (let i = 0; i < 40 && vm2.workers.some(w => !w.done); i++) await new Promise(res => setTimeout(res, 250));
    const capBefore = JSON.parse(await readFile(vm2.local(P.capability), 'utf8')).token;

    // end wiring with R2: the resume hook exists (still no drain); without R2 it does not
    assert.deepEqual(Object.keys(W.computerEndHooks(mkEnv(undefined), new MemStorage(), {}, vm2.io)), ['backup'], 'R2 absent: no resume hook, no VM operation');
    const hooks = W.computerEndHooks(env2, new MemStorage(), {}, vm2.io);
    assert.deepEqual(Object.keys(hooks).sort(), ['backup', 'resume'], 'resume wired, drain not wired: files_verified stays unavailable');
    await assert.rejects(hooks.resume(machine, 'not-a-uuid'), (e) => e.code === 'bad_request');
    await assert.rejects(hooks.resume({ ...machine, labels: {} }, uuid()), (e) => e.code === 'bad_request');
    await assert.rejects(hooks.resume({ ...machine, status: 'stopped' }, uuid()), (e) => e.code === 'not_running', 'never starts a machine');
    // a machine that was never set up here is skipped untouched, and no capability is minted
    const vm3 = fakeVm(join(dir, 'home-fresh'), proxy2); vm3.launch = true;
    const fence = async () => env2.objects.get(tag).ctx.storage.get('cap/fence');
    const f0 = await fence();
    await W.computerEndHooks(env2, new MemStorage(), {}, vm3.io).resume(machine, uuid());
    assert.deepEqual(vm3.calls.map(x => x[0]), ['getSandbox', 'exec'], 'only the read-only probe'); assert.equal(await fence(), f0);
    // start of the same machine: fresh capability, watcher resumed and relaunched, autosave continues
    const callsBefore = vm2.calls.length;
    await hooks.resume(machine, uuid());
    const after = vm2.calls.slice(callsBefore);
    assert.deepEqual(after.filter(x => x[0] === 'upload').map(x => x[1]), [P.capability + '.next'], 'only the capability is refreshed');
    assert.equal(after.filter(x => x[0] === 'spawn').length, 1);
    assert.notEqual(JSON.parse(await readFile(vm2.local(P.capability), 'utf8')).token, capBefore, 'the expired-or-old capability was replaced');
    const v3b = new TextEncoder().encode('after the restart, still autosaved\n');
    await writeFile(localB, v3b);
    assert.notEqual(await saved(v3b, 'resume'), firstSaved);
    // another machine is the writer now: nothing to resume, no VM call, no grant, never promoted back
    for (const w of vm2.workers) if (!w.done) w.kill();
    const st = (await j(await get(env2, 'files/status'))).status;
    await env2.objects.get(tag).svc.advanceWriter(tag, { requestId: 'w-elsewhere', expectedEpoch: st.writerEpoch, machineId: 'sb-elsewhere' });
    const n = vm2.calls.length, f1 = await fence();
    await hooks.resume(machine, uuid());
    assert.equal(vm2.calls.length, n); assert.equal(await fence(), f1);
    assert.equal((await j(await get(env2, 'files/status'))).status.writerMachine, 'sb-elsewhere');
    for (let i = 0; i < 40 && vm2.workers.some(w => !w.done); i++) await new Promise(res => setTimeout(res, 250));
    ok('autosave: configure launches the real watcher (one worker by lock, submission not claimed as running); after a stop the R2-only resume hook refreshes the capability and relaunches it on the same set-up writer only; drain stays unwired');
  }
  // ===== secrets =====
  const all = wire.join('\n');
  assert.ok(!all.includes(token) && !/cbfa_[A-Za-z0-9_-]{20,}/.test(all), 'no capability token in any response, log or agent/watcher output');
  assert.ok(!all.includes('dtn-test-key-not-real'), 'no provider key in any output');
  ok('no capability token or provider key in any response, agent stdout/stderr or route output');

  console.log(`${passed} cloudbite-computer-files-integration checks passed (MOCK storage/R2/VM; loopback HTTP; not live evidence)`);
} finally {
  for (const s of servers) s.close();
  for (const w of workers) if (!w.done) w.kill();
  await rm(dir, { recursive: true, force: true });
}
