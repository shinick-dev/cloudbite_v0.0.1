// 네트워크 없이 체크포인트 서비스 번들과 주입된 가짜 의존성만 검사한다.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const bundle = await build({ entryPoints: ['src/lab-checkpoint-service.ts'], bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent' });
const M = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
globalThis.fetch = () => { throw new Error('network forbidden'); };
const uuid = (n) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const TOKEN = 'admin-secret-token';
const STDOUT = 'secret-stdout-blob';
const SECRET_PATH = '/tmp/class/seat-archive.tar';
const tick = () => new Promise((r) => setImmediate(r));
const held = () => { let release; const promise = new Promise((r) => { release = r; }); return { promise, release }; };
async function until(f) { for (let i = 0; i < 100 && !f(); i++) await tick(); assert.ok(f()); }
const leaked = (value) => {
  const text = JSON.stringify(value);
  return text.includes(TOKEN) || text.includes(STDOUT) || text.includes(SECRET_PATH);
};
const baseContext = () => ({
  owner: 'ownerhash', revision: 3, fingerprint: 'config-fingerprint',
  refs: [1, 2, 3].map((n) => ({ labId: 'lab', n, code: `code-${n}`, sandboxId: `sb-${n}` })),
});
function world() {
  const data = new Map(), audit = [], remoteCalls = [], listLimits = [], gates = [];
  const copy = (x) => x === undefined ? x : structuredClone(x);
  let lock = Promise.resolve();
  let T = 1800000000000;
  let revoked = false, revokeAfterGets = 0, contextFail = null, remoteHold = null, remoteImpl = null;
  let contextCalls = 0, mutateOn = 0, mutate = () => {}, recordLeak = false;
  const ctx = baseContext();
  const storage = {
    async get(k) {
      if (storage.failGet) throw new Error('secret disk path ' + TOKEN + ' ' + STDOUT + ' ' + SECRET_PATH);
      const value = copy(data.get(k));
      if (revokeAfterGets > 0 && --revokeAfterGets === 0) revoked = true;
      return value;
    },
    async put(k, v) {
      if (storage.failPut) throw new Error('secret disk path ' + TOKEN + ' ' + SECRET_PATH);
      data.set(k, copy(v));
    },
    async list(opts = {}) {
      if (opts.limit !== 64) throw new Error('unbounded list');
      listLimits.push(opts.limit);
      const out = new Map();
      for (const [k, v] of data) {
        if (typeof k === 'string' && k.startsWith(opts.prefix ?? '')) {
          out.set(k, copy(v));
          if (out.size >= opts.limit) break;
        }
      }
      return out;
    },
    transaction(fn) {
      const run = async () => {
        const result = await fn(storage);
        if (storage.uncertain) {
          storage.uncertain = false;
          throw new Error('uncertain commit ' + TOKEN + ' ' + SECRET_PATH + ' ' + STDOUT);
        }
        return result;
      };
      const p = lock.then(run);
      lock = p.catch(() => {});
      return p;
    },
    failGet: false, failPut: false, uncertain: false,
  };
  const deps = {
    storage, now: () => T,
    authorize: async (token, id) => token !== TOKEN || revoked ? { status: 401, error: '관리 세션이 만료됐습니다.' } : id === 'lab' ? null : { status: 404, error: '없는 실습실입니다.' },
    context: async () => {
      contextCalls++;
      if (mutateOn && contextCalls >= mutateOn) mutate();
      if (contextFail) return contextFail;
      return structuredClone(ctx);
    },
    remote: async (token, ref, record, gate) => {
      remoteCalls.push({ n: ref.n, requestId: record.requestId, open: gate() });
      gates.push(gate);
      const text = JSON.stringify(record);
      if (text.includes(TOKEN) || text.includes(STDOUT) || text.includes(SECRET_PATH)) recordLeak = true;
      if (remoteHold?.n === ref.n) await remoteHold.gate.promise;
      if (remoteImpl) return remoteImpl(token, ref, record, gate);
      return { entries: 2, bytes: 100, size: 120, omitted: 1 };
    },
    audit: async (event, detail) => { audit.push([event, detail]); },
  };
  return {
    data, audit, storage, deps, ctx, remoteCalls, listLimits, gates, make: () => new M.LabCheckpointService(deps),
    set time(v) { T = v; }, get time() { return T; },
    revoke(v = true) { revoked = v; }, armRevokeAfterGets(n) { revokeAfterGets = n; },
    failContext(v) { contextFail = v; },
    holdRemote(n) { const gate = held(); remoteHold = { n, gate }; return gate; },
    flip(call, fn) { mutateOn = call; mutate = fn; },
    set remoteImpl(v) { remoteImpl = v; },
    contexts: () => contextCalls, leakedRecord: () => recordLeak,
  };
}
const opRow = (w, id) => w.data.get(M.checkpointOperationKey('lab', id));
const secrets = [TOKEN, STDOUT, SECRET_PATH, 'code-1', 'sb-1', 'ownerhash', 'config-fingerprint'];
let pass = 0;
async function test(name, f) { await f(); pass++; console.log('ok', name); }

await test('paused revision and explicit targets', async () => {
  const w = world(), s = w.make();
  assert.equal(M.LAB_CHECKPOINT_LIMIT, 64);
  assert.equal(M.LAB_CHECKPOINT_SEAT_LIMIT, 5);
  assert.equal(M.LAB_CHECKPOINT_MAX_ENTRIES, 4000);
  assert.equal(M.LAB_CHECKPOINT_MAX_BYTES, 64 * 1024 * 1024);
  assert.equal(M.checkpointOperationKey('a/b', uuid(1)), `labckpt:a%2Fb:${uuid(1)}`);
  assert.equal((await s.create('', 'lab', uuid(1), [1], 3)).status, 401);
  assert.equal((await s.create(TOKEN, 'lab', 'not-a-uuid', [1], 3)).status, 400);
  assert.equal((await s.create(TOKEN, 'lab', uuid(10).toUpperCase(), [1], 3)).status, 400);
  assert.equal((await s.create(TOKEN, '', uuid(1), [1], 3)).status, 400);
  assert.equal((await s.create(TOKEN, 'x'.repeat(101), uuid(1), [1], 3)).status, 400);
  for (const seats of [[], [1, 1], [0], [51], [1.5], ['1']]) assert.equal((await s.create(TOKEN, 'lab', uuid(1), seats, 3)).status, 400);
  for (const revision of [-1, 1.5, Number.NaN, '3']) assert.equal((await s.create(TOKEN, 'lab', uuid(1), [1], revision)).status, 400);
  w.failContext({ status: 409, error: '명령 전달이 일시정지 상태가 아닙니다.' });
  assert.equal((await s.create(TOKEN, 'lab', uuid(1), [1], 3)).status, 409);
  w.failContext(null);
  assert.equal((await s.create(TOKEN, 'lab', uuid(1), [1], 2)).status, 409);
  assert.equal((await s.create(TOKEN, 'lab', uuid(1), [4], 3)).status, 409);
  assert.equal(w.remoteCalls.length, 0);
  assert.equal(w.data.size, 0);
  const view = await s.create(TOKEN, 'lab', uuid(1), [3, 1], 3);
  assert.deepEqual(Object.keys(view).sort(), ['requestId', 'results']);
  assert.equal(view.requestId, uuid(1));
  assert.deepEqual(view.results.map((r) => r.n), [1, 3]);
  assert.deepEqual(view.results.map((r) => r.status), ['ready', 'ready']);
  assert.deepEqual(Object.keys(view.results[0]).sort(), ['at', 'bytes', 'entries', 'n', 'omitted', 'size', 'status']);
  assert.equal(view.results[0].at, w.time);
  assert.deepEqual(w.remoteCalls.map((c) => c.n), [1, 3]);
  assert.equal(w.remoteCalls.every((c) => c.open && c.requestId === uuid(1)), true);
  const stored = opRow(w, uuid(1));
  assert.deepEqual(Object.keys(stored).sort(), ['createdAt', 'requestId', 'results', 'revision', 'seats']);
  assert.equal(stored.seats[0].code, 'code-1');
  assert.equal(stored.owner, undefined);
  assert.equal(stored.fingerprint, undefined);
  assert.equal(stored.refs, undefined);
  const body = JSON.stringify({ view, audit: w.audit, status: await s.status(TOKEN, 'lab') });
  for (const secret of secrets) assert.equal(body.includes(secret), false);
  assert.equal(w.leakedRecord(), false);
  assert.equal(leaked(w.audit), false);
  assert.equal(w.listLimits.every((n) => n === 64), true);
  assert.equal((await s.end('')).status, 400);
});

await test('pending is stored before remote and the same id does not run again', async () => {
  const w = world(), s = w.make();
  const gate = w.holdRemote(1);
  const pending = s.create(TOKEN, 'lab', uuid(1), [1], 3);
  await until(() => w.remoteCalls.length === 1);
  assert.equal(opRow(w, uuid(1)).results[0].status, 'pending');
  assert.equal(w.remoteCalls[0].open, true);
  const contexts = w.contexts();
  const mid = await s.create(TOKEN, 'lab', uuid(1), [1], 3);
  assert.equal(mid.results[0].status, 'pending');
  assert.equal((await s.create(TOKEN, 'lab', uuid(1), [2], 3)).status, 409);
  assert.equal((await s.create(TOKEN, 'lab', uuid(1), [1], 4)).status, 409);
  assert.equal(opRow(w, uuid(1)).results[0].status, 'pending');
  assert.equal(w.remoteCalls.length, 1);
  assert.equal(w.contexts(), contexts);
  const live = await s.status(TOKEN, 'lab');
  assert.equal(live.checkpoints[0].results[0].status, 'pending');
  gate.release();
  const done = await pending;
  assert.equal(done.results[0].status, 'ready');
  const replayContexts = w.contexts();
  const remotes = w.remoteCalls.length;
  assert.deepEqual(await s.create(TOKEN, 'lab', uuid(1), [1], 3), done);
  assert.equal(w.contexts(), replayContexts);
  assert.equal(w.remoteCalls.length, remotes);
  assert.equal((await s.create(TOKEN, 'lab', uuid(1), [1, 2], 3)).status, 409);
  assert.equal(opRow(w, uuid(1)).results[0].status, 'ready');
  assert.equal(w.remoteCalls.length, remotes);
});

await test('concurrent same id checkpoints each seat once', async () => {
  const w = world(), s = w.make();
  const gate = w.holdRemote(1);
  const first = s.create(TOKEN, 'lab', uuid(1), [1, 2], 3);
  const second = s.create(TOKEN, 'lab', uuid(1), [2, 1], 3);
  await until(() => w.remoteCalls.length === 1);
  gate.release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(w.remoteCalls.filter((c) => c.n === 1).length, 1);
  assert.equal(w.remoteCalls.filter((c) => c.n === 2).length, 1);
  assert.equal([a, b].some((x) => x.results?.map((r) => r.status).join() === 'ready,ready'), true);
  assert.equal([a, b].every((x) => !x.status || x.results), true);
});

await test('restarted pending becomes unknown and is never checkpointed', async () => {
  const w = world(), s = w.make();
  const gate = w.holdRemote(1);
  const live = s.create(TOKEN, 'lab', uuid(1), [1], 3);
  await until(() => w.remoteCalls.length === 1);
  assert.equal((await s.create(TOKEN, 'lab', uuid(1), [1], 3)).results[0].status, 'pending');
  const contexts = w.contexts();
  const cold = await w.make().create(TOKEN, 'lab', uuid(1), [1], 3);
  assert.equal(cold.results[0].status, 'unknown');
  assert.equal(w.remoteCalls.length, 1);
  assert.equal(w.contexts(), contexts);
  gate.release();
  assert.equal((await live).results[0].status, 'unknown');
  assert.equal(w.remoteCalls.length, 1);
  assert.equal((await w.make().create(TOKEN, 'lab', uuid(1), [1], 3)).results[0].status, 'unknown');
  assert.equal(w.remoteCalls.length, 1);

  const seeded = world();
  const key = M.checkpointOperationKey('lab', uuid(7));
  seeded.data.set(key, { requestId: uuid(7), revision: 3, createdAt: 5, seats: [{ n: 1, code: 'code-1', sandboxId: 'sb-1' }], results: [{ n: 1, status: 'pending', at: null }] });
  assert.equal((await seeded.make().create(TOKEN, 'lab', uuid(7), [2], 3)).status, 409);
  assert.equal(seeded.data.get(key).results[0].status, 'pending');
  assert.equal((await seeded.make().create(TOKEN, 'lab', uuid(7), [1], 9)).status, 409);
  assert.equal(seeded.data.get(key).results[0].status, 'pending');
  const projected = await seeded.make().status(TOKEN, 'lab');
  assert.equal(projected.checkpoints[0].results[0].status, 'unknown');
  assert.equal(seeded.data.get(key).results[0].status, 'pending');
  const sealed = await seeded.make().create(TOKEN, 'lab', uuid(7), [1], 3);
  assert.equal(sealed.results[0].status, 'unknown');
  assert.equal(sealed.results[0].at, null);
  assert.equal(seeded.data.get(key).results[0].status, 'unknown');
  assert.equal(seeded.remoteCalls.length, 0);
  assert.equal(seeded.contexts(), 0);
});

await test('old result remains readable after the class resumes', async () => {
  const w = world(), s = w.make();
  const done = await s.create(TOKEN, 'lab', uuid(1), [1], 3);
  const contexts = w.contexts();
  const remotes = w.remoteCalls.length;
  w.failContext({ status: 409, error: '명령 전달이 일시정지 상태가 아닙니다.' });
  assert.deepEqual(await s.create(TOKEN, 'lab', uuid(1), [1], 3), done);
  assert.equal(w.contexts(), contexts);
  assert.equal(w.remoteCalls.length, remotes);
  assert.equal((await s.create(TOKEN, 'lab', uuid(1), [2], 3)).status, 409);
  assert.equal((await s.create(TOKEN, 'lab', uuid(9), [1], 3)).status, 409);
  assert.equal(w.remoteCalls.length, remotes);
  assert.equal(w.data.size, 1);
});

await test('revoked authority during a receipt read does not seal or start', async () => {
  const w = world(), s = w.make();
  await s.create(TOKEN, 'lab', uuid(1), [1], 3);
  const remotes = w.remoteCalls.length;
  w.armRevokeAfterGets(1);
  const denied = await s.create(TOKEN, 'lab', uuid(1), [1], 3);
  assert.equal(denied.status, 401);
  assert.equal(JSON.stringify(denied).includes(TOKEN), false);
  assert.equal(opRow(w, uuid(1)).results[0].status, 'ready');
  assert.equal(w.remoteCalls.length, remotes);

  const fresh = world(), fs = fresh.make();
  fresh.armRevokeAfterGets(1);
  assert.equal((await fs.create(TOKEN, 'lab', uuid(1), [1], 3)).status, 401);
  assert.equal(fresh.data.size, 0);
  assert.equal(fresh.remoteCalls.length, 0);

  const seeded = world();
  const key = M.checkpointOperationKey('lab', uuid(3));
  seeded.data.set(key, { requestId: uuid(3), revision: 3, createdAt: 1, seats: [{ n: 1, code: 'code-1', sandboxId: 'sb-1' }], results: [{ n: 1, status: 'pending', at: null }] });
  const cold = seeded.make();
  seeded.armRevokeAfterGets(2);
  assert.equal((await cold.create(TOKEN, 'lab', uuid(3), [1], 3)).status, 401);
  assert.equal(seeded.data.get(key).results[0].status, 'pending');
  assert.equal(seeded.remoteCalls.length, 0);
  seeded.revoke(false);
  assert.equal((await cold.create(TOKEN, 'lab', uuid(3), [1], 3)).results[0].status, 'unknown');
  assert.equal(seeded.remoteCalls.length, 0);
  assert.equal(seeded.contexts(), 0);
});

await test('owner, fingerprint, revision, and another selected ref invalidate', async () => {
  const changes = [
    (ctx) => { ctx.owner = 'other-owner'; },
    (ctx) => { ctx.fingerprint = 'other-fingerprint'; },
    (ctx) => { ctx.revision = 9; },
    (ctx) => { ctx.refs[1].sandboxId = 'other-sandbox'; },
  ];
  for (const change of changes) {
    const w = world(), s = w.make();
    w.flip(2, () => change(w.ctx));
    const denied = await s.create(TOKEN, 'lab', uuid(1), [1, 2], 3);
    assert.equal(denied.status, 409);
    assert.equal(w.remoteCalls.length, 0);
    assert.equal(w.data.size, 0);
  }
  for (const change of changes) {
    const w = world(), s = w.make();
    const gate = w.holdRemote(1);
    const pending = s.create(TOKEN, 'lab', uuid(1), [1, 2], 3);
    await until(() => w.remoteCalls.length === 1);
    change(w.ctx);
    gate.release();
    const done = await pending;
    assert.deepEqual(done.results.map((r) => r.status), ['ready', 'skipped']);
    assert.equal(w.remoteCalls.length, 1);
    assert.equal(leaked(done), false);
    assert.equal(JSON.stringify(w.audit).includes('other-sandbox'), false);
    assert.equal(JSON.stringify(w.audit).includes('code-1'), false);
  }
});

await test('end while the first remote is held blocks later targets', async () => {
  const idle = world(), idleService = idle.make();
  assert.equal(idleService.end('lab').ended, true);
  assert.equal(typeof idleService.end('lab').then, 'undefined');
  assert.equal((await idleService.create(TOKEN, 'lab', uuid(1), [1], 3)).status, 410);
  assert.equal(idle.remoteCalls.length, 0);
  assert.equal(idle.data.size, 0);
  assert.equal(idle.contexts(), 0);

  const w = world(), s = w.make();
  const gate = w.holdRemote(1);
  const pending = s.create(TOKEN, 'lab', uuid(1), [1, 2], 3);
  await until(() => w.remoteCalls.length === 1);
  assert.equal(s.end('lab').ended, true);
  assert.equal(w.gates[0](), false);
  assert.equal(opRow(w, uuid(1)) != null, true);
  gate.release();
  const done = await pending;
  assert.deepEqual(done.results.map((r) => r.status), ['ready', 'skipped']);
  assert.equal(w.remoteCalls.length, 1);
  assert.equal(w.data.size, 1);
  assert.equal((await s.create(TOKEN, 'lab', uuid(2), [1], 3)).status, 410);
  assert.equal(w.remoteCalls.length, 1);
  const contexts = w.contexts();
  assert.deepEqual(await s.create(TOKEN, 'lab', uuid(1), [1, 2], 3), done);
  assert.equal(w.contexts(), contexts);
});

await test('class cap 64 and exact seat cap 5', async () => {
  const seats = world(), ss = seats.make();
  for (let i = 1; i <= 4; i++) assert.equal((await ss.create(TOKEN, 'lab', uuid(i), [1], 3)).results[0].status, 'ready');
  seats.remoteImpl = () => 'duplicate';
  assert.equal((await ss.create(TOKEN, 'lab', uuid(5), [1], 3)).results[0].status, 'unknown');
  const remotes = seats.remoteCalls.length;
  const sixth = await ss.create(TOKEN, 'lab', uuid(6), [1], 3);
  assert.equal(sixth.status, 429);
  assert.equal(sixth.error.includes('5'), true);
  assert.equal(seats.remoteCalls.length, remotes);
  assert.equal(seats.data.size, 5);
  seats.ctx.refs[0].sandboxId = 'sb-other';
  seats.remoteImpl = null;
  assert.equal((await ss.create(TOKEN, 'lab', uuid(7), [1], 3)).results[0].status, 'ready');
  seats.ctx.refs[0].sandboxId = 'sb-1';
  assert.equal((await ss.create(TOKEN, 'lab', uuid(8), [1], 3)).status, 429);
  assert.equal((await ss.create(TOKEN, 'lab', uuid(9), [2], 3)).results[0].status, 'ready');
  const replayRemotes = seats.remoteCalls.length;
  seats.failContext({ status: 409, error: '명령 전달이 일시정지 상태가 아닙니다.' });
  assert.equal((await ss.create(TOKEN, 'lab', uuid(1), [1], 3)).results[0].status, 'ready');
  assert.equal(seats.remoteCalls.length, replayRemotes);

  const full = world(), fs = full.make();
  full.ctx.refs = Array.from({ length: 16 }, (_, i) => ({ labId: 'lab', n: i + 1, code: `code-${i + 1}`, sandboxId: `sb-${i + 1}` }));
  for (let i = 1; i <= 64; i++) {
    const n = ((i - 1) % 16) + 1;
    assert.equal((await fs.create(TOKEN, 'lab', uuid(i), [n], 3)).results[0].status, 'ready');
  }
  const capped = full.remoteCalls.length;
  const extra = await fs.create(TOKEN, 'lab', uuid(65), [1], 3);
  assert.equal(extra.status, 429);
  assert.equal(extra.error.includes('64'), true);
  assert.equal(full.remoteCalls.length, capped);
  assert.equal(full.data.size, 64);
  full.failContext({ status: 409, error: '명령 전달이 일시정지 상태가 아닙니다.' });
  assert.equal((await fs.create(TOKEN, 'lab', uuid(1), [1], 3)).results[0].status, 'ready');
  assert.equal(full.remoteCalls.length, capped);
  assert.equal(full.listLimits.every((n) => n === 64), true);
  assert.equal(seats.listLimits.every((n) => n === 64), true);
});

await test('storage failure and uncertain commit do not execute or stick', async () => {
  const w = world(), s = w.make();
  w.storage.failGet = true;
  const read = await s.create(TOKEN, 'lab', uuid(1), [1], 3);
  assert.equal(read.status, 503);
  assert.equal(leaked(read), false);
  assert.equal(w.remoteCalls.length, 0);
  w.storage.failGet = false;
  w.storage.failPut = true;
  const unstored = await s.create(TOKEN, 'lab', uuid(1), [1], 3);
  assert.equal(unstored.status, 503);
  assert.equal(leaked(unstored), false);
  assert.equal(w.data.size, 0);
  assert.equal(w.remoteCalls.length, 0);
  w.storage.failPut = false;
  w.storage.uncertain = true;
  const unsure = await s.create(TOKEN, 'lab', uuid(2), [1], 3);
  assert.equal(unsure.status, 503);
  assert.equal(leaked(unsure), false);
  assert.equal(w.remoteCalls.length, 0);
  assert.equal(opRow(w, uuid(2)).results[0].status, 'pending');
  const sealed = await s.create(TOKEN, 'lab', uuid(2), [1], 3);
  assert.equal(sealed.results[0].status, 'unknown');
  assert.equal(w.remoteCalls.length, 0);
  assert.equal(opRow(w, uuid(2)).results[0].status, 'unknown');
});

await test('ZIP overhead has its own bound above the saved-file input limit', async () => {
  const w = world(), s = w.make();
  w.remoteImpl = () => ({ entries: 4000, bytes: M.LAB_CHECKPOINT_MAX_BYTES, size: M.LAB_CHECKPOINT_MAX_ARCHIVE, omitted: 0 });
  const r = await s.create(TOKEN, 'lab', uuid(1), [1], 3);
  assert.equal(r.results[0].status, 'ready');
  assert.equal(r.results[0].size, M.LAB_CHECKPOINT_MAX_ARCHIVE);
});
await test('invalid or over-limit metadata becomes unknown once', async () => {
  const w = world(), s = w.make();
  const max = M.LAB_CHECKPOINT_MAX_BYTES;
  const cases = [
    () => ({ entries: 4001, bytes: 1, size: 1, omitted: 0 }),
    () => ({ entries: 1, bytes: max + 1, size: 1, omitted: 0 }),
    () => ({ entries: 1, bytes: 1, size: M.LAB_CHECKPOINT_MAX_ARCHIVE + 1, omitted: 0 }),
    () => ({ entries: 1, bytes: 1, size: 1, omitted: 4001 }),
    () => ({ entries: 1.5, bytes: 1, size: 1, omitted: 0 }),
    () => ({ entries: -1, bytes: 1, size: 1, omitted: 0 }),
    () => 'duplicate',
    () => null,
    () => ({ status: 500, error: STDOUT + TOKEN + SECRET_PATH }),
    () => { throw new Error(STDOUT + ' ' + TOKEN + ' ' + SECRET_PATH); },
    () => ({ entries: 1, bytes: 1, omitted: 0 }),
  ];
  for (let i = 0; i < cases.length; i++) {
    w.remoteImpl = cases[i];
    const body = await s.create(TOKEN, 'lab', uuid(i + 1), [(i % 3) + 1], 3);
    assert.equal(body.results[0].status, 'unknown');
    assert.equal(body.results[0].at, null);
    assert.equal(body.results[0].entries, undefined);
    assert.equal(leaked(body), false);
    assert.equal(leaked(w.audit), false);
  }
  assert.equal(w.remoteCalls.length, cases.length);
  const calls = w.remoteCalls.length;
  assert.equal((await s.create(TOKEN, 'lab', uuid(1), [1], 3)).results[0].status, 'unknown');
  assert.equal(w.remoteCalls.length, calls);

  const ok = world(), os = ok.make();
  ok.remoteImpl = () => ({ entries: 4000, bytes: max, size: max, omitted: 4000, path: SECRET_PATH, output: STDOUT });
  const ready = await os.create(TOKEN, 'lab', uuid(1), [1], 3);
  assert.equal(ready.results[0].status, 'ready');
  assert.equal(ready.results[0].at, ok.time);
  assert.equal(ready.results[0].entries, 4000);
  assert.equal(ready.results[0].bytes, max);
  assert.equal(ready.results[0].size, max);
  assert.equal(ready.results[0].omitted, 4000);
  assert.equal(leaked(ready), false);
  assert.equal(leaked(ok.audit), false);
  assert.equal(JSON.stringify(opRow(ok, uuid(1))).includes(SECRET_PATH), false);
  assert.equal(JSON.stringify(opRow(ok, uuid(1))).includes(STDOUT), false);
  assert.equal(JSON.stringify(await os.status(TOKEN, 'lab')).includes('code-1'), false);
});

await test('status lists newest first without seat identity', async () => {
  const w = world(), s = w.make();
  assert.equal((await s.status('nope', 'lab')).status, 401);
  w.time = 10;
  await s.create(TOKEN, 'lab', uuid(1), [1], 3);
  w.time = 20;
  await s.create(TOKEN, 'lab', uuid(2), [2], 3);
  const body = await s.status(TOKEN, 'lab');
  assert.deepEqual(body.checkpoints.map((c) => c.requestId), [uuid(2), uuid(1)]);
  assert.deepEqual(body.checkpoints.map((c) => c.createdAt), [20, 10]);
  assert.deepEqual(Object.keys(body.checkpoints[0]).sort(), ['createdAt', 'requestId', 'results']);
  const text = JSON.stringify(body);
  for (const secret of secrets) assert.equal(text.includes(secret), false);
});

console.log(`${pass} lab checkpoint service scenarios passed`);
