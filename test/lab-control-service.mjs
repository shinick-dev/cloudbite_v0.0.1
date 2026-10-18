// 네트워크 없이 제어 서비스 번들과 직렬 메모리 저장소만 검사한다.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const bundle = await build({ entryPoints: ['src/lab-control-service.ts'], bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent' });
const M = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
globalThis.fetch = () => { throw new Error('network forbidden'); };
const uuid = (n) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const TOKEN = 'admin-secret-token';
const tick = () => new Promise((r) => setImmediate(r));
const held = () => { let release; const promise = new Promise((r) => { release = r; }); return { promise, release }; };
async function until(f) { for (let i = 0; i < 100 && !f(); i++) await tick(); assert.ok(f()); }
function world() {
  const data = new Map(), audit = [];
  const copy = (x) => x === undefined ? x : structuredClone(x);
  let lock = Promise.resolve();
  let T = 1800000000000;
  const lab = { id: 'lab', expiresAt: T + 3600000 };
  let hold = null, hits = 0;
  const storage = {
    async get(k) { if (storage.failGet) throw new Error('secret disk path ' + TOKEN); return copy(data.get(k)); },
    async put(k, v) { if (storage.failPut) throw new Error('secret disk path ' + TOKEN); data.set(k, copy(v)); },
    transaction(fn) { const p = lock.then(() => fn(storage)); lock = p.catch(() => {}); return p; },
    failGet: false, failPut: false,
  };
  const deps = {
    storage, now: () => T, checkAdmin: async (t) => t === TOKEN,
    lab: async (id) => { hits++; if (hold && hits === hold.at) await hold.gate.promise; return id === lab.id ? { id: lab.id, expiresAt: lab.expiresAt, ...(lab.endRetry ? { endRetry: lab.endRetry } : {}) } : undefined; },
    audit: async (event, detail) => { audit.push([event, detail]); assert.equal(data.get(M.controlKey('lab'))?.mode, event === 'lab-control-end' ? 'ended' : event === 'lab-control-pause' ? 'paused' : 'running'); },
  };
  return { data, audit, lab, storage, deps, hits: () => hits, make: () => new M.LabControlService(deps), set time(v) { T = v; }, arm(at) { hits = 0; hold = { at, gate: held() }; return hold.gate; } };
}
const row = (w) => w.data.get(M.controlKey('lab'));
let pass = 0;
async function test(name, f) { await f(); pass++; console.log('ok', name); }
await test('legacy live lab is running revision 0 without a row', async () => {
  const w = world(), s = w.make();
  assert.deepEqual(await s.status(TOKEN, 'lab'), { mode: 'running', revision: 0, updatedAt: null });
  assert.equal(w.data.has(M.controlKey('lab')), false);
  const epoch = await s.acquire('lab');
  assert.deepEqual(epoch, { labId: 'lab', revision: 0 });
  assert.equal(M.controlEpochMatches(epoch, undefined), true);
  assert.equal((await s.pause(TOKEN, 'missing', uuid(1))).status, 404);
  assert.equal((await s.pause(TOKEN, 'lab', 'not-a-uuid')).status, 400);
  assert.equal((await s.resume(TOKEN, 'lab', uuid(1), '1')).status, 400);
  assert.equal(w.data.size, 0);
});
await test('pause persists before reply and survives service reconstruction', async () => {
  const w = world(), s = w.make();
  const paused = await s.pause(TOKEN, 'lab', uuid(1));
  assert.equal(paused.mode, 'paused');
  assert.equal(paused.revision, 1);
  assert.equal(typeof paused.updatedAt, 'number');
  assert.equal(row(w).mode, 'paused');
  assert.deepEqual(w.audit, [['lab-control-pause', 'lab 1']]);
  assert.equal(JSON.stringify(w.audit).includes(TOKEN), false);
  const revived = await w.make().status(TOKEN, 'lab');
  assert.deepEqual(revived, paused);
  assert.equal((await w.make().acquire('lab')).status, 409);
});
await test('resume is explicit and a stale revision does not unpause', async () => {
  const w = world(), s = w.make();
  const paused = await s.pause(TOKEN, 'lab', uuid(1));
  const stale = await s.resume(TOKEN, 'lab', uuid(2), 0);
  assert.equal(stale.status, 409);
  assert.equal(row(w).mode, 'paused');
  assert.equal(row(w).revision, 1);
  assert.deepEqual(await s.resume(TOKEN, 'lab', uuid(2), 0), stale);
  const resumed = await s.resume(TOKEN, 'lab', uuid(3), paused.revision);
  assert.deepEqual(resumed, { mode: 'running', revision: 2, updatedAt: resumed.updatedAt });
  assert.equal(row(w).mode, 'running');
  assert.deepEqual(w.audit.map((x) => x[0]), ['lab-control-pause', 'lab-control-resume']);
});
await test('same action id replays and a different payload conflicts', async () => {
  const w = world(), s = w.make();
  const paused = await s.pause(TOKEN, 'lab', uuid(1));
  assert.deepEqual(await s.pause(TOKEN, 'lab', uuid(1)), paused);
  assert.equal(row(w).revision, 1);
  assert.equal(row(w).actions.length, 1);
  const conflict = await s.resume(TOKEN, 'lab', uuid(1), paused.revision);
  assert.equal(conflict.status, 409);
  assert.equal(row(w).mode, 'paused');
  assert.equal(row(w).actions.length, 1);
  assert.deepEqual(w.audit, [['lab-control-pause', 'lab 1']]);
});
await test('pause then resume invalidates the captured running epoch', async () => {
  const w = world(), s = w.make();
  const epoch = await s.acquire('lab');
  const paused = await s.pause(TOKEN, 'lab', uuid(1));
  assert.equal(M.controlEpochMatches(epoch, row(w)), false);
  const resumed = await s.resume(TOKEN, 'lab', uuid(2), paused.revision);
  assert.equal(resumed.mode, 'running');
  assert.notEqual(resumed.revision, epoch.revision);
  assert.equal(M.controlEpochMatches(epoch, row(w)), false);
  const next = await s.acquire('lab');
  assert.equal(next.revision, resumed.revision);
  assert.equal(M.controlEpochMatches(next, row(w)), true);
  assert.equal(M.controlKey('lab'), 'labctrl:lab');
});
await test('unauthorized caller cannot pause or resume', async () => {
  const w = world(), s = w.make();
  assert.equal((await s.status('other-token', 'lab')).status, 401);
  assert.equal((await s.pause('other-token', 'lab', uuid(1))).status, 401);
  assert.equal((await s.resume('other-token', 'lab', uuid(2), 0)).status, 401);
  assert.equal(w.data.size, 0);
  assert.equal(w.audit.length, 0);
});
await test('expired or ending lab is not runnable', async () => {
  const w = world(), s = w.make();
  w.time = w.lab.expiresAt;
  for (const op of [s.status(TOKEN, 'lab'), s.pause(TOKEN, 'lab', uuid(1)), s.resume(TOKEN, 'lab', uuid(2), 0), s.acquire('lab')]) assert.equal((await op).status, 410);
  w.time = w.lab.expiresAt - 3600000;
  w.lab.endRetry = 1;
  assert.equal((await s.pause(TOKEN, 'lab', uuid(3))).status, 410);
  assert.equal(w.data.size, 0);
});
await test('end tombstone rejects a resume that was already waiting', async () => {
  const w = world(), s = w.make();
  const paused = await s.pause(TOKEN, 'lab', uuid(1));
  const gate = w.arm(1);
  const pending = s.resume(TOKEN, 'lab', uuid(2), paused.revision);
  await until(() => w.hits() >= 1);
  const ended = await s.end('lab');
  assert.equal(ended.mode, 'ended');
  gate.release();
  const late = await pending;
  assert.equal(late.status, 410);
  assert.equal(row(w).mode, 'ended');
  assert.equal(row(w).revision, ended.revision);
  assert.notEqual(row(w).mode, 'running');
  assert.equal((await s.pause(TOKEN, 'lab', uuid(1))).status, 410, 'end dominates old action receipts too');
  assert.equal(row(w).mode, 'ended');
});
await test('action history stops at 128 without dropping replay protection', async () => {
  const w = world(), s = w.make();
  const first = await s.pause(TOKEN, 'lab', uuid(1));
  let revision = first.revision;
  for (let n = 1; n <= 64; n++) {
    if (n > 1) revision = (await s.pause(TOKEN, 'lab', uuid(n * 2))).revision;
    revision = (await s.resume(TOKEN, 'lab', uuid(n * 2 + 1), revision)).revision;
  }
  assert.equal(row(w).actions.length, 128);
  assert.equal(row(w).mode, 'running');
  const extra = await s.pause(TOKEN, 'lab', uuid(400));
  assert.equal(extra.status, 429);
  assert.equal(row(w).actions.length, 128);
  assert.equal(row(w).revision, revision);
  assert.deepEqual(await s.pause(TOKEN, 'lab', uuid(1)), first);
  assert.equal(row(w).mode, 'running');
  assert.equal(row(w).revision, revision);
});
await test('storage failures do not echo exception text', async () => {
  const w = world(), s = w.make();
  w.storage.failGet = true;
  const status = await s.status(TOKEN, 'lab');
  assert.equal(status.status, 503);
  assert.equal(JSON.stringify(status).includes('secret'), false);
  assert.equal(JSON.stringify(status).includes(TOKEN), false);
  w.storage.failGet = false;
  w.storage.failPut = true;
  const paused = await s.pause(TOKEN, 'lab', uuid(1));
  assert.equal(paused.status, 503);
  assert.equal(JSON.stringify(paused).includes('secret'), false);
  assert.equal(w.data.size, 0);
});
console.log(`${pass} lab control service scenarios passed`);
