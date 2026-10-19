// Cloud Files runtime routes + DO wiring. Real computerRoute, real files runtime and real core service; the DO storage
// and R2 bucket below are in-memory test doubles (MOCK: not live persistence, not R2 durability evidence).
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

globalThis.fetch = async (u) => { throw new Error('network forbidden in this test: ' + u); };
// Workers-only stream primitives used by the core adapters.
globalThis.FixedLengthStream = class extends TransformStream {
  constructor(n) { let seen = 0; super({ transform(c, k) { seen += c.byteLength; if (seen > n) throw new Error('fixed length exceeded'); k.enqueue(c); }, flush() { if (seen !== n) throw new Error('fixed length short'); } }); }
};
Object.defineProperty(globalThis.crypto, 'DigestStream', { configurable: true, value: class extends WritableStream {
  constructor() { const h = createHash('sha256'); let done; const p = new Promise(r => { done = r; });
    super({ write(c) { h.update(c); }, close() { const d = h.digest(); done(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength)); } }); this.digest = p; }
} });

const dir = await mkdtemp(join(tmpdir(), 'cloudbite-files-runtime-'));
try {
  const root = resolve('.').replace(/\\/g, '/');
  const b = await build({ stdin: { contents: `export {computerRoute} from '${root}/src/cloudbite-computer-api.ts';export * from '${root}/src/cloudbite-computer-files-runtime.ts';`, resolveDir: root, loader: 'ts' },
    bundle: true, write: false, format: 'esm', platform: 'neutral', plugins: [{ name: 'boundary', setup(x) {
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
        auth: 'export const computerAuthRoute=async()=>null;export const personalComputerCookieValid=async()=>false;',
        state: "export const isFail=x=>!!x?.error;",
        owner: "export const ownerCookieValid=async r=>r.headers.get('cookie')==='owner=yes';",
        lab: "export const download=async()=>{throw Error('unexpected download')};export class DtError extends Error{};export const dt=async()=>{throw Error('unexpected provider call')};",
      }[path] }));
    } }] });
  const file = join(dir, 'm.mjs'); await writeFile(file, b.outputFiles[0].text);
  const M = await import(pathToFileURL(file));
  const Files = M.filesObjectClass(class { constructor(ctx, env) { this.ctx = ctx; this.env = env; } });

  // ---- test doubles ----
  const clone = v => structuredClone(v);
  class MemStorage {
    constructor() { this.m = new Map(); }
    async get(k) { if (Array.isArray(k)) { const o = new Map(); for (const x of k) if (this.m.has(x)) o.set(x, clone(this.m.get(x))); return o; } return this.m.has(k) ? clone(this.m.get(k)) : undefined; }
    async put(k, v) { if (typeof k === 'object') for (const [a, c] of Object.entries(k)) this.m.set(a, clone(c)); else this.m.set(k, clone(v)); }
    async delete(k) { for (const x of Array.isArray(k) ? k : [k]) this.m.delete(x); }
    async list({ prefix = '', startAfter, limit = Infinity } = {}) {
      return new Map([...this.m.keys()].filter(k => k.startsWith(prefix) && (startAfter === undefined || k > startAfter)).sort().slice(0, limit).map(k => [k, clone(this.m.get(k))]));
    }
    // Serialized like DO storage transactions; `beforeTxn` lets a test interleave work right before a transaction runs.
    async transaction(fn) {
      if (this.beforeTxn) await this.beforeTxn();
      const run = async () => {
        const t = new MemStorage(); t.m = new Map([...this.m].map(([k, v]) => [k, clone(v)])); const r = await fn(t); this.m = t.m; return r;
      };
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

  const base = 'https://cloudbite.shinick.dev', gw = 'https://cloudbite-v001.ai-gongbu.workers.dev';
  const MID = 'sb-0f4c0d0e-1111-2222-3333-444455556666';
  const machine = { id: MID, account: 'primary', name: 'cloudbite-computer-primary-x', labels: {}, status: 'running' };
  const computerRpc = { computerState: async () => ({ ok: true, status: 'absent' }), computerMachine: async () => ({ ok: true, machine: { ...machine } }) };
  const objects = new Map();
  const mkEnv = (bucket) => {
    const env = { ORIGIN: base, CLOUDBITE_GATEWAY_URL: gw, CLOUDBITE_FILES_BUCKET: bucket,
      CLOUDBITE_COMPUTER: { idFromName: () => 'owner', get: () => computerRpc } };
    env.CLOUDBITE_COMPUTER_FILES = { idFromName: n => n, get: id => {
      if (!objects.has(id + (bucket ? ':r2' : ''))) objects.set(id + (bucket ? ':r2' : ''), new Files({ storage: new MemStorage() }, env));
      return objects.get(id + (bucket ? ':r2' : ''));
    } };
    return env;
  };
  const state = { adminList: async () => { throw Error('unexpected admin validation'); } };
  const seen = [];
  const go = async (env, origin, p, init = {}) => {
    const r = new Request(origin + p, init); const res = await M.computerRoute(r, env, new URL(r.url), state);
    const text = res.headers.get('content-type')?.includes('json') ? await res.clone().text() : '';
    seen.push(text); return res;
  };
  const owner = (extra = {}) => ({ cookie: 'owner=yes', ...extra });
  const post = (env, p, body, headers = {}) => go(env, base, '/api/cloudbite/computer/' + p, { method: 'POST', headers: owner({ origin: base, 'content-type': 'application/json', ...headers }), body: JSON.stringify(body) });
  const get = (env, p, headers = {}) => go(env, base, '/api/cloudbite/computer/' + p, { headers: owner(headers) });
  const put = (env, p, bytes, headers = {}) => go(env, base, '/api/cloudbite/computer/' + p, { method: 'PUT', headers: owner({ origin: base, 'content-length': String(bytes.length), ...headers }), body: bytes });
  const j = r => r.json();
  let passed = 0; const ok = (name) => { passed++; console.log('  ok', name); };

  // ---- no DO bound at all: honest not_configured ----
  const bare = { ORIGIN: base, CLOUDBITE_GATEWAY_URL: gw, CLOUDBITE_COMPUTER: { idFromName: () => 'owner', get: () => computerRpc } };
  let r = await get(bare, 'files/status'); assert.equal(r.status, 200);
  let s = (await j(r)).status; assert.equal(s.catalog, 'not_configured'); assert.equal(s.blobs, 'not_configured');
  r = await get(bare, 'files?parentId=root'); assert.equal(r.status, 503); assert.equal((await j(r)).error.code, 'store_not_configured');
  ok('unbound files DO reports not_configured, never success');

  // ---- auth / origin ----
  const env = mkEnv(undefined);
  r = await go(env, base, '/api/cloudbite/computer/files/status'); assert.equal(r.status, 401);
  r = await go(env, base, '/api/cloudbite/computer/files/create', { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: '{}' }); assert.equal(r.status, 401);
  r = await post(env, 'files/create', { requestId: 'c1', parentId: 'root', name: 'x', kind: 'dir' }, { origin: 'https://attacker.invalid' }); assert.equal(r.status, 403);
  r = await go(env, base, '/api/cloudbite/computer/files/create', { method: 'POST', headers: owner({ 'content-type': 'application/json' }), body: '{"requestId":"c1","parentId":"root","name":"x","kind":"dir"}' }); assert.equal(r.status, 403, 'POST without Origin is refused');
  r = await get(env, 'files', { 'sec-fetch-site': 'cross-site' }); assert.equal(r.status, 403);
  r = await put(env, 'files/uploads/u_' + 'a'.repeat(26) + '/body', new Uint8Array(1), { origin: 'https://attacker.invalid' }); assert.equal(r.status, 403);
  assert.equal(objects.size, 0, 'no DO touched by refused requests');
  ok('owner auth + same-origin + cross-site fetch metadata enforced before any DO call');

  // ---- metadata without R2 ----
  r = await get(env, 'files/status'); s = (await j(r)).status;
  assert.equal(s.catalog, 'configured'); assert.equal(s.blobs, 'not_configured'); assert.equal(s.blobKind, null);
  assert.equal(s.maxFileBytes, 32 * 1024 ** 2); assert.equal(s.quotaBytes, 2 * 1024 ** 3);
  r = await post(env, 'files/create', { requestId: 'd1', parentId: 'root', name: 'Docs', kind: 'dir' }); assert.equal(r.status, 200);
  const docs = (await j(r)).entry;
  r = await post(env, 'files/create', { requestId: 'f1', parentId: docs.fileId, name: '보고서 "final".txt', kind: 'file' }); assert.equal(r.status, 200);
  const f1 = (await j(r)).entry;
  r = await post(env, 'files/create', { requestId: 'f1', parentId: docs.fileId, name: '보고서 "final".txt', kind: 'file' }); assert.equal((await j(r)).entry.fileId, f1.fileId, 'same requestId replays');
  r = await get(env, `files?parentId=${docs.fileId}&limit=10`); assert.equal(r.status, 200); assert.deepEqual((await j(r)).entries.map(e => e.name), ['보고서 "final".txt']);
  r = await get(env, 'files?parentId=root&limit=abc'); assert.equal(r.status, 400);
  r = await post(env, 'files/rename', { requestId: 'r1', fileId: f1.fileId, expectedRev: 99, name: 'z.txt' }); assert.equal((await j(r)).error.code, 'stale_revision');
  r = await post(env, 'files/pin', { requestId: 'p1', fileId: f1.fileId, pinned: true }); assert.equal((await j(r)).entry.pinned, true);
  r = await post(env, 'files/uploads/begin', { requestId: 'b0', fileId: f1.fileId, baseVersion: null, writerEpoch: 1, size: 3, sha256: hexOf(Buffer.from('abc')) });
  assert.equal(r.status, 503); assert.equal((await j(r)).error.code, 'store_not_configured');
  r = await post(env, 'files/open', { fileId: f1.fileId }); assert.equal(r.status, 404);
  ok('DO catalog works without R2; body ops answer store_not_configured');

  // ---- with R2 double ----
  const r2 = new MemR2(), envR = mkEnv(r2);
  r = await post(envR, 'files/create', { requestId: 'f2', parentId: 'root', name: '..evil‮.txt', kind: 'file' }); const f2 = (await j(r)).entry;
  const bytes = new TextEncoder().encode('hello cloud files');
  const begin = (requestId, extra = {}) => post(envR, 'files/uploads/begin', { requestId, fileId: f2.fileId, baseVersion: null, writerEpoch: 1, size: bytes.length, sha256: hexOf(bytes), ...extra });
  r = await begin('b1', { writerEpoch: 7 }); assert.equal(r.status, 409); assert.equal((await j(r)).error.code, 'stale_writer');
  r = await begin('b2', { size: 33 * 1024 ** 2 }); assert.equal(r.status, 413);
  r = await begin('b3'); assert.equal(r.status, 200); const u1 = (await j(r)).upload;
  r = await begin('b3'); assert.equal((await j(r)).upload.uploadId, u1.uploadId, 'retry of begin returns the same immutable uploadId');
  r = await go(envR, base, `/api/cloudbite/computer/files/uploads/${u1.uploadId}/body`, { method: 'PUT', headers: owner({ origin: base, 'content-length': String(40 * 1024 ** 2) }), body: new Uint8Array(4) });
  assert.equal(r.status, 413, 'declared oversize refused before streaming');
  r = await put(envR, `files/uploads/${u1.uploadId}/body`, bytes.slice(0, 5)); assert.equal(r.status, 422); assert.equal((await j(r)).error.code, 'size_mismatch');
  r = await put(envR, `files/uploads/${u1.uploadId}/body`, new Uint8Array(bytes.length)); assert.equal((await j(r)).error.code, 'hash_mismatch');
  r = await post(envR, `files/uploads/${u1.uploadId}/commit`, { uploadId: u1.uploadId }); assert.equal(r.status, 422); assert.equal((await j(r)).error.code, 'body_missing');
  r = await put(envR, `files/uploads/${u1.uploadId}/body`, bytes); assert.equal(r.status, 200); assert.equal((await j(r)).upload.phase, 'body_written');
  r = await post(envR, `files/uploads/${u1.uploadId}/commit`, { uploadId: 'u_' + 'b'.repeat(26) }); assert.equal(r.status, 400);
  r = await post(envR, `files/uploads/u_${'c'.repeat(26)}/commit`, {}); assert.equal(r.status, 404, 'unknown upload commit is not_found');
  r = await post(envR, `files/uploads/${u1.uploadId}/commit`, { uploadId: u1.uploadId }); assert.equal(r.status, 200);
  const c1 = (await j(r)).result; assert.equal(c1.status, 'committed'); assert.equal(c1.durable, true);
  r = await post(envR, `files/uploads/${u1.uploadId}/commit`, { uploadId: u1.uploadId }); assert.deepEqual((await j(r)).result, c1, 'commit retry returns the persisted result');
  r = await get(envR, `files/uploads/${u1.uploadId}`); assert.deepEqual((await j(r)).upload.result, c1, 'lost-response reconcile');
  ok('upload begin/body/commit: caps, epoch fence, provider checksum, idempotent reconcile');

  const before = { ...r2.calls };
  r = await get(envR, 'files?parentId=root'); assert.equal((await j(r)).entries[0].currentVersion, c1.versionId);
  r = await get(envR, 'files/status');
  assert.deepEqual(r2.calls, before, 'list/status never touch blob store');
  r = await post(envR, 'files/open', { fileId: f2.fileId }); const d = (await j(r)).descriptor; assert.equal(d.versionId, c1.versionId);
  assert.deepEqual(r2.calls, before, 'open is descriptor only');
  r = await get(envR, `files/content/${f2.fileId}?versionId=${c1.versionId}`); assert.equal(r.status, 200);
  assert.deepEqual(new Uint8Array(await r.arrayBuffer()), bytes);
  assert.equal(r.headers.get('content-type'), 'application/octet-stream'); assert.match(r.headers.get('content-security-policy'), /sandbox/);
  assert.equal(r.headers.get('x-cloudbite-sha256'), hexOf(bytes));
  const cd = r.headers.get('content-disposition'); assert.match(cd, /^attachment; filename="[A-Za-z0-9._ -]+"; filename\*=UTF-8''/); assert.ok(!/[‮"]/.test(cd.split('filename*=')[1]));
  r = await get(envR, `files/content/${f2.fileId}`); assert.equal(r.status, 400);
  r = await get(envR, `files/content/${f2.fileId}?versionId=v_0000000000000_${'a'.repeat(26)}`); assert.equal(r.status, 404);
  ok('metadata list/open read no bodies; explicit content download streams verified bytes with safe headers');

  // stale base -> conflict sibling, no overwrite
  const b2 = new TextEncoder().encode('second');
  r = await post(envR, 'files/uploads/begin', { requestId: 'b4', fileId: f2.fileId, baseVersion: null, writerEpoch: 1, size: b2.length, sha256: hexOf(b2) }); const u2 = (await j(r)).upload;
  await put(envR, `files/uploads/${u2.uploadId}/body`, b2);
  r = await post(envR, `files/uploads/${u2.uploadId}/commit`, {}); const c2 = (await j(r)).result;
  assert.equal(c2.status, 'conflict'); assert.ok(c2.conflictFileId);
  r = await post(envR, 'files/open', { fileId: f2.fileId }); assert.equal((await j(r)).descriptor.versionId, c1.versionId, 'canonical not overwritten');
  ok('stale base keeps a conflict sibling instead of last-writer-wins');

  // ---- owner namespace ----
  const doR = envR.CLOUDBITE_COMPUTER_FILES.get(await (async () => { for (const k of objects.keys()) if (k.endsWith(':r2')) return k.slice(0, -3); })());
  const other = await doR.filesCall('someoneelse', 'list', { parentId: 'root' }); assert.equal(other.status, 404);
  ok('a files object bound to one owner refuses any other owner id');

  // ---- agent capability ----
  const tag = [...objects.keys()].find(k => k.endsWith(':r2')).slice(0, -3);
  r = await go(envR, gw, M.FILES_AGENT_PATH.replace(/^/, '') + '/status', { headers: { cookie: 'owner=yes' } }); assert.equal(r.status, 401, 'owner cookie alone never authenticates the agent surface');
  let g = await M.filesAgentGrant(envR, tag, { ...machine, status: 'stopped' }, 'g0'); assert.equal(g.status, 409);
  g = await M.filesAgentGrant(envR, tag, machine, 'g1'); assert.ok(g.ok);
  const grant = g.body; assert.match(grant.token, /^cbfa_[A-Za-z0-9_-]{43}$/); assert.equal(grant.endpoint, gw + M.FILES_AGENT_PATH); assert.equal(grant.writerEpoch, 2);
  const stored = JSON.stringify([...doR.ctx.storage.m]); assert.ok(!stored.includes(grant.token), 'token not stored in plaintext');
  const A = (p, init = {}) => go(envR, gw, M.FILES_AGENT_PATH + '/' + p, { ...init, headers: { authorization: 'Bearer ' + grant.token, ...(init.headers ?? {}) } });
  r = await go(envR, base, M.FILES_AGENT_PATH + '/status', { headers: { authorization: 'Bearer ' + grant.token } });
  if (base !== gw) assert.equal(r.status, 404, 'agent surface only on gateway origin');
  r = await A('status', { headers: { origin: gw } }); assert.equal(r.status, 403, 'browser Origin refused on agent surface');
  r = await A('status'); assert.equal(r.status, 200); let as = await j(r); assert.equal(as.agent.machineId, MID); assert.equal(as.status.writerEpoch, 2);
  r = await go(envR, gw, M.FILES_AGENT_PATH + '/status', { headers: { authorization: 'Bearer cbfa_' + 'x'.repeat(43) } }); assert.equal((await j(r)).error.code, 'capability_invalid');
  // browser uploads now must follow the advanced epoch
  r = await post(envR, 'files/uploads/begin', { requestId: 'b5', fileId: f2.fileId, baseVersion: c1.versionId, writerEpoch: 1, size: 1, sha256: hexOf(Buffer.from('x')) }); assert.equal((await j(r)).error.code, 'stale_writer');
  // agent upload flow
  const b3 = new TextEncoder().encode('agent edit');
  r = await A('uploads/begin', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId: 'a1', fileId: f2.fileId, baseVersion: c1.versionId, writerEpoch: 1, size: b3.length, sha256: hexOf(b3) }) });
  assert.equal((await j(r)).error.code, 'stale_writer', 'agent cannot use an epoch other than its capability');
  r = await A('uploads/begin', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId: 'a1', fileId: f2.fileId, baseVersion: c1.versionId, writerEpoch: 2, size: b3.length, sha256: hexOf(b3) }) });
  const au = (await j(r)).upload; assert.equal(au.writerEpoch, 2);
  r = await A(`uploads/${au.uploadId}/body`, { method: 'PUT', headers: { 'content-length': String(b3.length) }, body: b3 }); assert.equal(r.status, 200);
  r = await A(`uploads/${au.uploadId}/commit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); const ac = (await j(r)).result; assert.equal(ac.status, 'committed');
  r = await A(`content/${f2.fileId}?versionId=${ac.versionId}&offset=6&length=4`); assert.equal(await r.text(), 'edit');
  r = await A('local-state', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ machineId: 'other-machine', writerEpoch: 2, seq: 1, fileId: f2.fileId, versionId: ac.versionId, dirty: false }) });
  assert.equal((await j(r)).error.code, 'stale_writer');
  r = await A('local-state', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ machineId: MID, writerEpoch: 2, seq: 1, fileId: f2.fileId, versionId: ac.versionId, dirty: false }) });
  assert.equal((await j(r)).applied, true);
  r = await A('uploads'); assert.equal(r.status, 200);
  r = await A('rename', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); assert.equal(r.status, 404, 'rename is not an agent operation');
  ok('agent capability: gateway-only, bearer-only, epoch/machine fenced, scoped upload + local-state');

  // machine fences
  computerRpc.computerMachine = async () => ({ ok: true, machine: { ...machine, status: 'stopped' } });
  r = await A('status'); assert.equal((await j(r)).error.code, 'not_running');
  computerRpc.computerMachine = async () => ({ ok: true, machine: { ...machine, id: 'replacement-machine' } });
  r = await A('status'); assert.equal((await j(r)).error.code, 'not_running');
  computerRpc.computerMachine = async () => ({ ok: true, machine: { ...machine } });
  g = await M.filesAgentGrant(envR, tag, { ...machine, id: 'replacement-machine' }, 'g2'); assert.equal(g.error.code, 'writer_conflict', 'a different writer is never silently promoted');
  const g3 = await M.filesAgentGrant(envR, tag, machine, 'g3'); assert.equal(g3.body.writerEpoch, 2);
  r = await A('status'); assert.equal((await j(r)).error.code, 'capability_invalid', 'regrant revokes the previous capability');
  const realNow = Date.now; Date.now = () => realNow() + 7 * 3600_000;
  try { r = await go(envR, gw, M.FILES_AGENT_PATH + '/status', { headers: { authorization: 'Bearer ' + g3.body.token } }); assert.equal((await j(r)).error.code, 'capability_expired'); }
  finally { Date.now = realNow; }
  // epoch advanced elsewhere -> stale capability
  await doR.svc.advanceWriter(tag, { requestId: 'w-x', expectedEpoch: 2, machineId: MID });
  r = await go(envR, gw, M.FILES_AGENT_PATH + '/status', { headers: { authorization: 'Bearer ' + g3.body.token } }); assert.equal((await j(r)).error.code, 'stale_writer');
  ok('capability expiry, revocation, machine replacement and stale epoch fences');

  // ---- capability grant concurrency, revoke fencing, unknown persistence ----
  const st = doR.ctx.storage, agentStatus = tok => go(envR, gw, M.FILES_AGENT_PATH + '/status', { headers: { authorization: 'Bearer ' + tok } }).then(j);
  const caps = () => [...st.m.keys()].filter(k => k.startsWith('cap/') && k !== 'cap/fence');
  let g4 = await M.filesAgentGrant(envR, tag, machine, 'g4'); assert.equal(g4.body.writerEpoch, 3);
  { // two grants that both read the same fence: exactly one lands, the loser's token is dropped
    let arrived = 0, open; const gate = new Promise(r => { open = r; });
    st.beforeTxn = async () => { if (++arrived === 2) open(); await gate; };
    const [x, y] = await Promise.all([M.filesAgentGrant(envR, tag, machine, 'c-a'), M.filesAgentGrant(envR, tag, machine, 'c-b')]);
    st.beforeTxn = undefined;
    const won = [x, y].filter(v => v.ok), lost = [x, y].filter(v => !v.ok);
    assert.equal(won.length, 1, 'exactly one concurrent grant wins'); assert.equal(lost[0].error.code, 'grant_superseded'); assert.equal(lost[0].body, undefined);
    assert.deepEqual(caps(), ['cap/active'], 'a single active capability record');
    assert.equal((await agentStatus(won[0].body.token)).agent.writerEpoch, 3);
    assert.equal((await agentStatus(g4.body.token)).error.code, 'capability_invalid');
    g4 = won[0];
  }
  { // revoke landing between a grant's fence read and its write: the grant is superseded, nothing is resurrected
    st.beforeTxn = async () => { st.beforeTxn = undefined; assert.deepEqual((await doR.filesRevokeAgents(tag)).body, { revoked: 1 }); };
    const late = await M.filesAgentGrant(envR, tag, machine, 'late');
    assert.equal(late.error.code, 'grant_superseded'); assert.equal(late.body, undefined);
    assert.deepEqual(caps(), [], 'revoked and not re-granted');
    assert.equal((await agentStatus(g4.body.token)).error.code, 'capability_invalid');
  }
  { // persistence outcome unknown: no token is returned, so none can be installed; the previous capability is untouched
    const g5 = await M.filesAgentGrant(envR, tag, machine, 'g5'); assert.ok(g5.ok);
    st.beforeTxn = async () => { st.beforeTxn = undefined; throw new Error('storage reset'); };
    const u = await M.filesAgentGrant(envR, tag, machine, 'g6');
    assert.equal(u.error.code, 'commit_unknown'); assert.equal(u.error.retryable, true); assert.ok(!JSON.stringify(u).includes('cbfa_'));
    assert.equal((await agentStatus(g5.body.token)).agent.writerEpoch, 3);
    g4 = g5;
  }
  ok('grants are a transactional singleton: concurrent grant, revoke race and unknown persistence never leave two live or unconfirmed secrets');

  { // agent body/commit/abort are fenced on the upload's own epoch, not only on begin
    const T = g4.body.token, AT = (p, init = {}) => go(envR, gw, M.FILES_AGENT_PATH + '/' + p, { ...init, headers: { authorization: 'Bearer ' + T, ...(init.headers ?? {}) } });
    const cur = (await j(await post(envR, 'files/open', { fileId: f2.fileId }))).descriptor.versionId;
    const nb = new TextEncoder().encode('epoch three');
    const mk = async rid => (await j(await AT('uploads/begin', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId: rid, fileId: f2.fileId, baseVersion: cur, writerEpoch: 3, size: nb.length, sha256: hexOf(nb) }) }))).upload;
    const e3a = await mk('e3a'), e3b = await mk('e3b');
    r = await AT(`uploads/${e3b.uploadId}/body`, { method: 'PUT', headers: { 'content-length': String(nb.length) }, body: nb }); assert.equal(r.status, 200);
    await doR.svc.advanceWriter(tag, { requestId: 'w-4', expectedEpoch: 3, machineId: MID });
    const g7 = await M.filesAgentGrant(envR, tag, machine, 'g7'); assert.equal(g7.body.writerEpoch, 4);
    const B4 = (p, init = {}) => go(envR, gw, M.FILES_AGENT_PATH + '/' + p, { ...init, headers: { authorization: 'Bearer ' + g7.body.token, ...(init.headers ?? {}) } });
    const puts = r2.calls.put;
    r = await B4(`uploads/${e3a.uploadId}/body`, { method: 'PUT', headers: { 'content-length': String(nb.length) }, body: nb }); assert.equal((await j(r)).error.code, 'stale_writer');
    assert.equal(r2.calls.put, puts, 'no blob written for a stale-epoch upload');
    r = await B4(`uploads/${e3b.uploadId}/commit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); assert.equal((await j(r)).error.code, 'stale_writer');
    r = await B4(`uploads/${e3a.uploadId}/abort`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); assert.equal((await j(r)).error.code, 'stale_writer');
    r = await B4(`uploads/${e3b.uploadId}`); assert.equal((await j(r)).upload.phase, 'body_written', 'reconcile read still allowed, nothing committed');
    assert.equal((await j(await post(envR, 'files/open', { fileId: f2.fileId }))).descriptor.versionId, cur, 'canonical unchanged');
  }
  ok('agent body/commit/abort require upload.writerEpoch == capability epoch');

  // standalone files page is served same-origin with the strict page CSP
  for (const [p, type] of [['', 'text/html'], ['.js', 'text/javascript'], ['.css', 'text/css']]) {
    r = await go(envR, base, '/cloudbite/computer/files' + p); assert.equal(r.status, 200); assert.ok(r.headers.get('content-type').startsWith(type));
    assert.match(r.headers.get('content-security-policy'), /script-src 'self'/); assert.ok((await r.text()).length > 100);
  }
  ok('/cloudbite/computer/files page, js and css routes wired');

  // existing computer routes still served
  r = await get(envR, 'state'); assert.equal(r.status, 200);
  assert.ok(seen.every(t => !t.includes('cbfa_')), 'no capability secret in any HTTP response');
  ok('existing computer routes preserved; no capability secret in HTTP output');

  console.log(`cloudbite-computer-files-runtime: ${passed} passed, 0 skipped (in-memory DO storage + R2 doubles; not live evidence)`);
} finally { await rm(dir, { recursive: true, force: true }); }
