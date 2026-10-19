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
        if (cmd.includes('cloudbite-files-bridge v1')) {   // prepare script: owned private dirs + empty placeholders
          for (const d of [P.base + '/agent', P.state, P.manifests, P.root]) await mkdir(local(d), { recursive: true });
          return { exitCode: 0, result: '' };
        }
        if (cmd.includes('"$B/capability.json.next"') && cmd.includes('mv -f')) {   // ACTIVATE
          await rename(local(P.agent + '.next'), local(P.agent)); await rename(local(P.capability + '.next'), local(P.capability));
          return { exitCode: 0, result: '' };
        }
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

  // ===== secrets =====
  const all = wire.join('\n');
  assert.ok(!all.includes(token) && !/cbfa_[A-Za-z0-9_-]{20,}/.test(all), 'no capability token in any response, log or agent output');
  assert.ok(!all.includes('dtn-test-key-not-real'), 'no provider key in any output');
  ok('no capability token or provider key in any response, agent stdout/stderr or route output');

  console.log(`${passed} cloudbite-computer-files-integration checks passed (MOCK storage/R2/VM; loopback HTTP; not live evidence)`);
} finally {
  for (const s of servers) s.close();
  await rm(dir, { recursive: true, force: true });
}
