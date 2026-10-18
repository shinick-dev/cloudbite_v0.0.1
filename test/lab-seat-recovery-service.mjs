// 네트워크 없이 자리 복구 서비스 번들과 주입된 가짜 의존성만 검사한다.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const bundle = await build({ entryPoints: ['src/lab-seat-recovery-service.ts'], bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent' });
const M = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
globalThis.fetch = () => { throw new Error('network forbidden'); };
const uuid = (n) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const TOKEN = 'admin-secret-token';
const CODE = 'seat-code-secret';
const SB = 'sandbox-secret-id';
const SID = 'session-secret-sid';
const OWNER = 'owner-secret-hash';
const FP = 'fingerprint-secret';
const FILE = 'file-ack-secret';
const STDOUT = 'secret-stdout-blob';
const NOTE_UNKNOWN = '결과를 확인하지 못했습니다. 같은 요청은 다시 실행하지 않습니다.';
const NOTE_SKIPPED = '수업 상태가 바뀌어 실행하지 않았습니다.';
const NOTE_KNOWN = '이미 확인된 복구입니다.';
const NOTES = new Set([NOTE_UNKNOWN, NOTE_SKIPPED, NOTE_KNOWN]);
const SECRETS = [TOKEN, CODE, SB, SID, OWNER, FP, FILE, STDOUT, 'labseatrec', 'labseatact'];
const tick = () => new Promise((r) => setImmediate(r));
const held = () => { let release; const promise = new Promise((r) => { release = r; }); return { promise, release }; };
async function until(f) { for (let i = 0; i < 200 && !f(); i++) await tick(); assert.ok(f()); }
function clean(value) {
  const text = JSON.stringify(value);
  for (const secret of SECRETS) assert.equal(text.includes(secret), false, secret);
  if (value && typeof value === 'object' && typeof value.note === 'string') assert.equal(NOTES.has(value.note), true);
  return value;
}
const baseContext = () => ({
  owner: OWNER, revision: 4, fingerprint: FP, verifiedFileId: null,
  ref: { labId: 'lab', n: 2, code: CODE, sandboxId: SB, sid: SID, generation: 'gen-a' },
});
function world() {
  const data = new Map(), audit = [], runCalls = [], observeCalls = [], listLimits = [], listPrefixes = [], deletes = [];
  const copy = (x) => x === undefined ? x : structuredClone(x);
  let lock = Promise.resolve();
  let T = 1800000000000;
  let revoked = false, authCalls = 0, revokeAfterAuth = 0, authThrow = false;
  let contextFail = null, contextThrow = false, contextCalls = 0, mutateOn = 0, mutate = () => {};
  let runHold = null, runImpl = null, observeImpl = null, recordLeak = false, recordHasSeat = false;
  const ctx = baseContext();
  const storage = {
    async get(k) {
      if (storage.failGet) throw new Error('secret disk ' + TOKEN + ' ' + STDOUT);
      return copy(data.get(k));
    },
    async put(k, v) {
      if (storage.failPut) throw new Error('secret disk ' + TOKEN + ' ' + FILE);
      data.set(k, copy(v));
    },
    async delete(k) {
      deletes.push(k);
      data.delete(k);
      return true;
    },
    async list(opts = {}) {
      if (opts.limit !== 64 || typeof opts.prefix !== 'string' || !opts.prefix.startsWith('labseatrec:')) throw new Error('unbounded list');
      listLimits.push(opts.limit);
      listPrefixes.push(opts.prefix);
      const out = new Map();
      for (const [k, v] of data) {
        if (typeof k === 'string' && k.startsWith(opts.prefix)) {
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
          throw new Error('uncertain commit ' + TOKEN + ' ' + CODE + ' ' + STDOUT);
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
    authorize: async (token, id) => {
      authCalls++;
      if (revokeAfterAuth && authCalls >= revokeAfterAuth) revoked = true;
      if (authThrow) throw new Error('auth ' + TOKEN);
      if (token !== TOKEN || revoked) return { status: 401, error: '관리 세션이 만료됐습니다.' };
      return id === 'lab' ? null : { status: 404, error: '없는 실습실입니다.' };
    },
    context: async (_token, id, n) => {
      contextCalls++;
      if (mutateOn && contextCalls === mutateOn) mutate();
      if (contextThrow) throw new Error('context ' + TOKEN + ' ' + CODE + ' ' + SID + ' ' + STDOUT);
      if (contextFail) return contextFail;
      const next = structuredClone(ctx);
      next.ref.n = n;
      next.ref.labId = id;
      return next;
    },
    run: async (_token, record, gate) => {
      const row = { requestId: record.requestId, kind: record.kind, n: record.ref.n, before: gate() };
      runCalls.push(row);
      const text = JSON.stringify(record);
      if (text.includes(TOKEN) || text.includes(STDOUT)) recordLeak = true;
      recordHasSeat = record.ref.code === CODE && record.ref.sid === SID && record.ref.sandboxId === SB;
      if (runHold) {
        const waiting = runHold;
        runHold = null;
        await waiting;
      }
      row.after = gate();
      if (runImpl) return runImpl(record, gate);
      return { status: record.kind === 'replace' ? 'replaced' : 'ready', at: T, generation: 'gen-next' };
    },
    observe: async (_token, record) => {
      observeCalls.push(record.requestId);
      if (JSON.stringify(record).includes(TOKEN) || JSON.stringify(record).includes(STDOUT)) recordLeak = true;
      if (observeImpl) return observeImpl(record);
      return null;
    },
    audit: async (event, detail) => { audit.push([event, detail]); },
  };
  return {
    data, audit, storage, deps, ctx, runCalls, observeCalls, listLimits, listPrefixes, deletes,
    make: () => new M.LabSeatRecoveryService(deps),
    setTime(v) { T = v; }, time: () => T,
    contexts: () => contextCalls, runs: () => runCalls.length, observes: () => observeCalls.length,
    leaked: () => recordLeak, sawSeat: () => recordHasSeat,
    revoke(v = true) { revoked = v; },
    armAuth(skip) { revokeAfterAuth = authCalls + skip; },
    failContext(v) { contextFail = v; },
    throwContext(v = true) { contextThrow = v; },
    throwAuth(v = true) { authThrow = v; },
    holdRun() { const gate = held(); runHold = gate.promise; return gate; },
    flip(call, fn) { mutateOn = call; mutate = fn; },
    set runImpl(v) { runImpl = v; },
    set observeImpl(v) { observeImpl = v; },
  };
}
const opKey = (id) => M.recoveryOperationKey('lab', id);
const actKey = (n = 2) => M.recoveryActiveKey('lab', n);
const snap = (w) => JSON.stringify([...w.data]);
let pass = 0;
async function test(name, f) { await f(); pass++; console.log('ok', name); }
const repair = (s, id, n = 2, ack = false) => s.create(TOKEN, 'lab', id, n, 'repair', 'gen-a', 4, ack);

await test('paused exact generation and revision', async () => {
  const w = world(), s = w.make();
  assert.equal(M.LAB_SEAT_RECOVERY_LIMIT, 64);
  assert.equal(M.recoveryOperationKey('a/b', uuid(1)), `labseatrec:a%2Fb:${uuid(1)}`);
  assert.equal(M.recoveryActiveKey('a/b', 2), 'labseatact:a%2Fb:2');
  assert.equal(clean(await s.create('', 'lab', uuid(1), 2, 'repair', 'gen-a', 4, false)).status, 401);
  assert.equal(clean(await s.create(TOKEN, 'lab', 'not-a-uuid', 2, 'repair', 'gen-a', 4, false)).status, 400);
  assert.equal((await s.create(TOKEN, 'lab', uuid(10).toUpperCase(), 2, 'repair', 'gen-a', 4, false)).status, 400);
  assert.equal((await s.create(TOKEN, '', uuid(1), 2, 'repair', 'gen-a', 4, false)).status, 400);
  assert.equal((await s.create(TOKEN, 'x'.repeat(101), uuid(1), 2, 'repair', 'gen-a', 4, false)).status, 400);
  for (const n of [0, 51, 1.5, '2']) assert.equal((await s.create(TOKEN, 'lab', uuid(1), n, 'repair', 'gen-a', 4, false)).status, 400);
  for (const kind of ['restore', 'Repair', '']) assert.equal((await s.create(TOKEN, 'lab', uuid(1), 2, kind, 'gen-a', 4, false)).status, 400);
  for (const gen of ['', 'g'.repeat(129), 'gen\n', 1]) assert.equal((await s.create(TOKEN, 'lab', uuid(1), 2, 'repair', gen, 4, false)).status, 400);
  for (const rev of [-1, 1.5, Number.NaN, '4']) assert.equal((await s.create(TOKEN, 'lab', uuid(1), 2, 'repair', 'gen-a', rev, false)).status, 400);
  for (const ack of [null, undefined, 'false', 0]) assert.equal((await s.create(TOKEN, 'lab', uuid(1), 2, 'repair', 'gen-a', 4, ack)).status, 400);
  assert.equal(clean(await s.status(TOKEN, 'lab', uuid(99))).status, 404);
  w.failContext({ status: 409, error: '명령 전달이 일시정지 상태가 아닙니다.' });
  assert.equal(clean(await repair(s, uuid(1))).status, 409);
  assert.equal(clean(await repair(s, uuid(1))).error, '명령 전달이 일시정지 상태가 아닙니다.');
  w.failContext(null);
  w.throwContext(true);
  const thrown = clean(await repair(s, uuid(1)));
  assert.equal(thrown.status, 503);
  assert.equal(thrown.error, '수업 상태를 확인하지 못했습니다.');
  w.throwContext(false);
  const wrongRev = clean(await s.create(TOKEN, 'lab', uuid(1), 2, 'repair', 'gen-a', 3, false));
  assert.equal(wrongRev.status, 409);
  assert.equal(wrongRev.error, '수업 상태가 바뀌었습니다. 다시 확인하세요.');
  const wrongGen = clean(await s.create(TOKEN, 'lab', uuid(1), 2, 'repair', 'gen-other', 4, false));
  assert.equal(wrongGen.status, 409);
  assert.equal(w.runs(), 0);
  assert.equal(w.data.size, 0);
  const contexts = w.contexts();
  const view = clean(await repair(s, uuid(1)));
  assert.deepEqual(Object.keys(view).sort(), ['at', 'generation', 'kind', 'n', 'requestId', 'status']);
  assert.equal(view.requestId, uuid(1));
  assert.equal(view.kind, 'repair');
  assert.equal(view.n, 2);
  assert.equal(view.status, 'ready');
  assert.equal(view.at, w.time());
  assert.equal(view.generation, 'gen-next');
  assert.equal(w.runs(), 1);
  assert.equal(w.observes(), 0);
  assert.equal(w.contexts() - contexts, 3);
  assert.equal(w.sawSeat(), true);
  assert.equal(w.leaked(), false);
  const stored = w.data.get(opKey(uuid(1)));
  assert.equal(stored.ref.generation, 'gen-a');
  assert.equal(stored.ref.code, CODE);
  assert.equal(stored.resultGeneration, 'gen-next');
  assert.equal(stored.owner, OWNER);
  assert.equal(view.code, undefined);
  assert.equal(view.sid, undefined);
  assert.equal(view.sandboxId, undefined);
  assert.equal(w.data.get(actKey()), undefined);
  assert.equal(w.listLimits.every((n) => n === 64), true);
  assert.equal(w.listPrefixes.every((p) => p === 'labseatrec:lab:'), true);
  assert.equal(clean(w.audit).length, 1);
  assert.equal((await s.end('')).status, 400);
});

await test('replace requires a file acknowledgement or an explicit waiver', async () => {
  const w = world(), s = w.make();
  const missing = clean(await s.create(TOKEN, 'lab', uuid(1), 2, 'replace', 'gen-a', 4, false));
  assert.equal(missing.status, 409);
  assert.equal(missing.error, '자리를 바꾸려면 완료된 파일 확인 또는 데이터 손실 동의가 필요합니다.');
  assert.equal(w.runs(), 0);
  assert.equal(w.data.size, 0);
  assert.equal(w.contexts(), 1);
  w.ctx.verifiedFileId = FILE;
  const acked = clean(await s.create(TOKEN, 'lab', uuid(2), 2, 'replace', 'gen-a', 4, false));
  assert.equal(acked.status, 'replaced');
  assert.equal(acked.kind, 'replace');
  assert.equal(acked.generation, 'gen-next');
  assert.equal(w.data.get(opKey(uuid(2))).verifiedFileId, FILE);
  assert.equal(w.runs(), 1);
  const waived = world(), sw = waived.make();
  const view = clean(await sw.create(TOKEN, 'lab', uuid(3), 2, 'replace', 'gen-a', 4, true));
  assert.equal(view.status, 'replaced');
  assert.equal(view.generation, 'gen-next');
  assert.equal(waived.data.get(opKey(uuid(3))).ackDataLoss, true);
  assert.equal(waived.data.get(opKey(uuid(3))).verifiedFileId, null);
  assert.equal(waived.runs(), 1);
  const drift = world(), sd = drift.make();
  drift.ctx.verifiedFileId = FILE;
  drift.flip(2, () => { drift.ctx.verifiedFileId = null; });
  const moved = clean(await sd.create(TOKEN, 'lab', uuid(4), 2, 'replace', 'gen-a', 4, false));
  assert.equal(moved.status, 409);
  assert.equal(drift.runs(), 0);
  assert.equal(drift.data.size, 0);
});

await test('pending and the seat lock are durable before run', async () => {
  const w = world(), s = w.make();
  const gate = w.holdRun();
  const first = repair(s, uuid(1));
  await until(() => w.runs() === 1);
  assert.equal(w.data.get(opKey(uuid(1))).status, 'pending');
  assert.equal(w.data.get(actKey()), uuid(1));
  assert.equal(w.data.get(opKey(uuid(1))).at, null);
  const read = clean(await s.status(TOKEN, 'lab', uuid(1)));
  assert.equal(read.status, 'pending');
  assert.equal(read.at, null);
  assert.equal(read.note, undefined);
  assert.equal(w.observes(), 0);
  const blocked = clean(await repair(s, uuid(2)));
  assert.equal(blocked.status, 409);
  assert.equal(blocked.error, '이 자리의 다른 복구가 진행 중입니다.');
  assert.equal(w.runs(), 1);
  const other = repair(s, uuid(3), 3);
  await until(() => w.runs() === 2);
  const otherView = clean(await other);
  assert.equal(otherView.status, 'ready');
  assert.equal(otherView.n, 3);
  assert.equal(w.data.get(actKey(2)), uuid(1));
  gate.release();
  const done = clean(await first);
  assert.equal(done.status, 'ready');
  assert.equal(done.generation, 'gen-next');
  assert.equal(w.runs(), 2);
  assert.equal(w.data.get(actKey(2)), undefined);
  clean(w.audit);
});

await test('the same id and concurrent callers run once', async () => {
  const w = world(), s = w.make();
  const gate = w.holdRun();
  const a = repair(s, uuid(1));
  const b = repair(s, uuid(1));
  await until(() => w.runs() === 1);
  const early = clean(await Promise.race([a, b]));
  assert.equal(early.status, 'pending');
  assert.equal(w.runs(), 1);
  assert.equal(w.observes(), 0);
  gate.release();
  const both = [clean(await a), clean(await b)];
  assert.equal(both.filter((x) => x.status === 'ready').length >= 1, true);
  assert.equal(both.every((x) => x.status === 'ready' || x.status === 'pending'), true);
  assert.equal(w.runs(), 1);
  const final = clean(await s.status(TOKEN, 'lab', uuid(1)));
  assert.equal(final.status, 'ready');
  assert.equal(final.at, w.time());
});

await test('a conflicting payload is rejected', async () => {
  const w = world(), s = w.make();
  assert.equal(clean(await repair(s, uuid(1))).status, 'ready');
  const before = snap(w);
  const contexts = w.contexts();
  const cases = [
    [2, 'replace', 'gen-a', 4, false],
    [3, 'repair', 'gen-a', 4, false],
    [2, 'repair', 'gen-b', 4, false],
    [2, 'repair', 'gen-a', 5, false],
    [2, 'repair', 'gen-a', 4, true],
  ];
  for (const [n, kind, gen, rev, ack] of cases) {
    const body = clean(await s.create(TOKEN, 'lab', uuid(1), n, kind, gen, rev, ack));
    assert.equal(body.status, 409);
    assert.equal(body.error, '같은 요청 ID에 다른 내용을 쓸 수 없습니다.');
  }
  assert.equal(snap(w), before);
  assert.equal(w.runs(), 1);
  assert.equal(w.contexts(), contexts);
});

await test('an old receipt survives resume and generation change without context or run', async () => {
  const w = world(), s = w.make();
  const first = clean(await repair(s, uuid(1)));
  const contexts = w.contexts();
  const runs = w.runs();
  const observes = w.observes();
  w.setTime(w.time() + 80);
  w.ctx.revision = 11;
  w.ctx.ref.generation = 'gen-b';
  w.ctx.owner = 'resumed-owner';
  const again = clean(await s.create(TOKEN, 'lab', uuid(1), 2, 'repair', 'gen-a', 4, false));
  assert.equal(again.status, 'ready');
  assert.equal(again.at, first.at);
  assert.equal(again.generation, 'gen-next');
  assert.equal(w.contexts(), contexts);
  assert.equal(w.runs(), runs);
  assert.equal(w.observes(), observes);
  const read = clean(await s.status(TOKEN, 'lab', uuid(1)));
  assert.equal(read.at, first.at);
  assert.equal(read.generation, 'gen-next');
  assert.equal(w.contexts(), contexts);
  assert.equal(w.observes(), observes);
  assert.equal(w.data.get(opKey(uuid(1))).ref.generation, 'gen-a');
  assert.equal(w.data.get(opKey(uuid(1))).revision, 4);
  clean(w.audit);
});

await test('a reconstructed pending becomes unknown and keeps the lock', async () => {
  const w = world(), s = w.make();
  w.storage.uncertain = true;
  const failed = clean(await repair(s, uuid(1)));
  assert.equal(failed.status, 503);
  assert.equal(failed.error, '복구를 저장하지 못했습니다.');
  assert.equal(w.runs(), 0);
  assert.equal(w.data.get(opKey(uuid(1))).status, 'pending');
  assert.equal(w.data.get(actKey()), uuid(1));
  const s2 = w.make();
  w.observeImpl = () => { throw new Error('disk ' + TOKEN + CODE + SID + STDOUT); };
  const body = clean(await s2.status(TOKEN, 'lab', uuid(1)));
  assert.equal(body.status, 'unknown');
  assert.equal(body.note, NOTE_UNKNOWN);
  assert.equal(body.at, null);
  assert.equal(body.generation, undefined);
  assert.equal(w.runs(), 0);
  assert.equal(w.data.get(actKey()), uuid(1));
  assert.equal(w.data.get(opKey(uuid(1))).status, 'unknown');
  const replay = clean(await s2.create(TOKEN, 'lab', uuid(1), 2, 'repair', 'gen-a', 4, false));
  assert.equal(replay.status, 'unknown');
  assert.equal(w.runs(), 0);
  const other = clean(await repair(s2, uuid(2)));
  assert.equal(other.status, 409);
  assert.equal(w.data.get(actKey()), uuid(1));
  assert.notEqual(body.status, 'pending');
});

await test('a stored observe proof refines unknown without run', async () => {
  const w = world(), s = w.make();
  w.runImpl = () => { throw new Error('provider ' + TOKEN + STDOUT); };
  const first = clean(await repair(s, uuid(1)));
  assert.equal(first.status, 'unknown');
  assert.equal(w.data.get(actKey()), uuid(1));
  const runs = w.runs();
  const contexts = w.contexts();
  w.observeImpl = () => ({ status: 'ready', at: 4242, generation: 'gen-proof' });
  w.setTime(99999);
  const body = clean(await s.status(TOKEN, 'lab', uuid(1)));
  assert.equal(body.status, 'ready');
  assert.equal(body.at, 4242);
  assert.equal(body.generation, 'gen-proof');
  assert.equal(w.runs(), runs);
  assert.equal(w.contexts(), contexts);
  assert.equal(w.observes(), 1);
  assert.equal(w.data.get(actKey()), undefined);
  assert.equal(w.data.get(opKey(uuid(1))).ref.generation, 'gen-a');
  assert.equal(w.data.get(opKey(uuid(1))).resultGeneration, 'gen-proof');
  const again = clean(await s.status(TOKEN, 'lab', uuid(1)));
  assert.equal(again.at, 4242);
  assert.equal(w.observes(), 1);
  assert.equal(w.runs(), runs);
});

await test('expired auth during a receipt read does not return a view or write', async () => {
  const w = world(), s = w.make();
  const first = clean(await repair(s, uuid(1)));
  assert.equal(first.status, 'ready');
  const before = snap(w);
  const contexts = w.contexts();
  const observes = w.observes();
  const runs = w.runs();
  w.armAuth(2);
  const body = clean(await s.status(TOKEN, 'lab', uuid(1)));
  assert.equal(body.status, 401);
  assert.equal(body.error, '관리 세션이 만료됐습니다.');
  assert.deepEqual(Object.keys(body).sort(), ['error', 'status']);
  assert.equal(snap(w), before);
  assert.equal(w.contexts(), contexts);
  assert.equal(w.observes(), observes);
  assert.equal(w.runs(), runs);
});

await test('owner, ref, or fingerprint changes skip before claim or before run', async () => {
  const early = world(), es = early.make();
  early.flip(2, () => { early.ctx.owner = 'other-owner'; });
  const denied = clean(await repair(es, uuid(1)));
  assert.equal(denied.status, 409);
  assert.equal(early.data.size, 0);
  assert.equal(early.runs(), 0);
  assert.equal(early.contexts(), 2);
  const late = world(), ls = late.make();
  late.flip(3, () => { late.ctx.fingerprint = 'other-fp'; late.ctx.ref.sid = 'other-sid'; late.ctx.ref.sandboxId = 'other-sb'; });
  const skipped = clean(await repair(ls, uuid(2)));
  assert.equal(skipped.status, 'skipped');
  assert.equal(skipped.note, NOTE_SKIPPED);
  assert.equal(skipped.at, null);
  assert.equal(late.runs(), 0);
  assert.equal(late.contexts(), 3);
  assert.equal(late.data.get(actKey()), undefined);
  assert.equal(late.data.get(opKey(uuid(2))).status, 'skipped');
  late.observeImpl = () => ({ status: 'ready', at: 1, generation: 'gen-proof' });
  const stayed = clean(await ls.status(TOKEN, 'lab', uuid(2)));
  assert.equal(stayed.status, 'skipped');
  assert.equal(late.observes(), 0);
  assert.equal(late.runs(), 0);
  const replace = world(), rs = replace.make();
  replace.ctx.verifiedFileId = FILE;
  replace.flip(3, () => { replace.ctx.verifiedFileId = 'other-file'; });
  const dropped = clean(await rs.create(TOKEN, 'lab', uuid(3), 2, 'replace', 'gen-a', 4, false));
  assert.equal(dropped.status, 'skipped');
  assert.equal(replace.runs(), 0);
  assert.equal(replace.data.get(actKey()), undefined);
  const waived = world(), ws = waived.make();
  waived.flip(3, () => { waived.ctx.verifiedFileId = FILE; });
  const ran = clean(await ws.create(TOKEN, 'lab', uuid(4), 2, 'replace', 'gen-a', 4, true));
  assert.equal(ran.status, 'replaced');
  assert.equal(waived.runs(), 1);
});

await test('end before run skips and a held run may settle without starting another', async () => {
  const before = world(), bs = before.make();
  before.flip(3, () => { bs.end('lab'); });
  const skipped = clean(await repair(bs, uuid(1)));
  assert.equal(skipped.status, 'skipped');
  assert.equal(skipped.note, NOTE_SKIPPED);
  assert.equal(before.runs(), 0);
  assert.equal(before.data.get(actKey()), undefined);
  assert.equal(before.data.get(opKey(uuid(1))).status, 'skipped');
  assert.deepEqual(bs.end('lab'), { ended: true });
  const held = world(), hs = held.make();
  held.runImpl = () => ({ status: 'ready', at: 77, generation: 'gen-settled' });
  const gate = held.holdRun();
  const pending = repair(hs, uuid(2));
  await until(() => held.runs() === 1);
  assert.equal(held.runCalls[0].before, true);
  assert.deepEqual(hs.end('lab'), { ended: true });
  gate.release();
  const done = clean(await pending);
  assert.equal(done.status, 'ready');
  assert.equal(done.at, 77);
  assert.equal(done.generation, 'gen-settled');
  assert.equal(held.runCalls[0].after, false);
  assert.equal(held.runs(), 1);
  assert.equal(held.data.get(actKey()), undefined);
  const next = clean(await repair(hs, uuid(3)));
  assert.equal(next.status, 410);
  assert.equal(next.error, '모임이 끝났습니다.');
  assert.equal(held.runs(), 1);
  clean(held.audit);
});

await test('a class stores at most 64 operations', async () => {
  const w = world(), s = w.make();
  for (let i = 1; i <= 64; i++) {
    const body = clean(await repair(s, uuid(i)));
    assert.equal(body.status, 'ready');
  }
  assert.equal(w.runs(), 64);
  assert.equal(w.data.size, 64);
  const extra = clean(await repair(s, uuid(65)));
  assert.equal(extra.status, 429);
  assert.equal(extra.error, '이 실습실의 복구 한도(64)에 도달했습니다.');
  assert.equal(w.runs(), 64);
  assert.equal(w.data.size, 64);
  assert.equal(w.listLimits.every((n) => n === 64), true);
});

await test('an invalid or thrown outcome stays unknown and keeps the lock', async () => {
  const cases = [
    () => { throw new Error('provider ' + TOKEN + ' ' + STDOUT + ' ' + CODE); },
    () => ({ status: 'replaced', at: 1, generation: 'gen-x' }),
    () => ({ status: 'ready', at: Number.NaN, generation: 'gen-x' }),
    () => ({ status: 'ready', at: 1, generation: '' }),
    () => null,
  ];
  for (const runImpl of cases) {
    const w = world(), s = w.make();
    w.runImpl = runImpl;
    const body = clean(await repair(s, uuid(1)));
    assert.equal(body.status, 'unknown');
    assert.equal(body.note, NOTE_UNKNOWN);
    assert.equal(body.at, null);
    assert.equal(w.runs(), 1);
    assert.equal(w.data.get(actKey()), uuid(1));
    const again = clean(await repair(s, uuid(1)));
    assert.equal(again.status, 'unknown');
    assert.equal(w.runs(), 1);
    const other = clean(await repair(s, uuid(2)));
    assert.equal(other.status, 409);
    assert.equal(w.data.get(actKey()), uuid(1));
  }
  const replace = world(), rs = replace.make();
  replace.ctx.verifiedFileId = FILE;
  replace.runImpl = () => ({ status: 'ready', at: 5, generation: 'gen-x' });
  const wrong = clean(await rs.create(TOKEN, 'lab', uuid(3), 2, 'replace', 'gen-a', 4, false));
  assert.equal(wrong.status, 'unknown');
  assert.equal(replace.runs(), 1);
  assert.equal(replace.data.get(actKey()), uuid(3));
});

await test('an uncertain commit does not execute and does not stay live pending', async () => {
  const w = world(), s = w.make();
  w.storage.uncertain = true;
  const first = clean(await repair(s, uuid(1)));
  assert.equal(first.status, 503);
  assert.equal(w.runs(), 0);
  assert.equal(w.data.get(opKey(uuid(1))).status, 'pending');
  const again = clean(await repair(s, uuid(1)));
  assert.equal(again.status, 'unknown');
  assert.notEqual(again.status, 'pending');
  assert.equal(again.note, NOTE_UNKNOWN);
  assert.equal(w.runs(), 0);
  assert.equal(w.data.get(actKey()), uuid(1));
  const read = clean(await s.status(TOKEN, 'lab', uuid(1)));
  assert.equal(read.status, 'unknown');
  assert.equal(w.runs(), 0);
});

await test('unlock requires inspection, the current paused generation, and refuses a live lock', async () => {
  const ready = world(), rs = ready.make();
  const done = clean(await repair(rs, uuid(1)));
  const before = snap(ready);
  assert.equal(clean(await rs.unlock(TOKEN, 'lab', uuid(1), 'gen-a', false)).status, 400);
  assert.equal(clean(await rs.unlock(TOKEN, 'lab', uuid(1), 'gen-a', 'true')).status, 400);
  assert.equal(snap(ready), before);
  assert.equal(ready.contexts(), 3);
  const known = clean(await rs.unlock(TOKEN, 'lab', uuid(1), 'gen-a', true));
  assert.equal(known.released, true);
  assert.equal(known.at, done.at);
  assert.equal(known.note, NOTE_KNOWN);
  assert.equal(snap(ready), before);
  assert.equal(ready.runs(), 1);
  const live = world(), ls = live.make();
  const gate = live.holdRun();
  const pending = repair(ls, uuid(2));
  await until(() => live.runs() === 1);
  const denied = clean(await ls.unlock(TOKEN, 'lab', uuid(2), 'gen-a', true));
  assert.equal(denied.status, 409);
  assert.equal(denied.error, '진행 중인 복구 잠금은 해제할 수 없습니다.');
  assert.equal(live.data.get(actKey()), uuid(2));
  gate.release();
  assert.equal(clean(await pending).status, 'ready');
  const stuck = world(), ss = stuck.make();
  stuck.runImpl = () => { throw new Error('down'); };
  assert.equal(clean(await repair(ss, uuid(3))).status, 'unknown');
  stuck.failContext({ status: 409, error: '명령 전달이 일시정지 상태가 아닙니다.' });
  const paused = clean(await ss.unlock(TOKEN, 'lab', uuid(3), 'gen-a', true));
  assert.equal(paused.status, 409);
  assert.equal(stuck.data.get(actKey()), uuid(3));
  assert.equal(stuck.data.get(opKey(uuid(3))).releasedAt, undefined);
  stuck.failContext(null);
  const wrong = clean(await ss.unlock(TOKEN, 'lab', uuid(3), 'gen-old', true));
  assert.equal(wrong.status, 409);
  assert.equal(stuck.data.get(actKey()), uuid(3));
  stuck.ctx.ref.generation = 'gen-b';
  stuck.setTime(5000);
  const released = clean(await ss.unlock(TOKEN, 'lab', uuid(3), 'gen-b', true));
  assert.equal(released.released, true);
  assert.equal(released.at, 5000);
  assert.equal(released.note, undefined);
  assert.equal(stuck.data.get(actKey()), undefined);
  assert.equal(stuck.data.get(opKey(uuid(3))).status, 'unknown');
  assert.equal(stuck.data.get(opKey(uuid(3))).ref.generation, 'gen-a');
  assert.equal(stuck.data.get(opKey(uuid(3))).releasedAt, 5000);
  assert.equal(stuck.runs(), 1);
  const cold = world(), cs = cold.make();
  cold.storage.uncertain = true;
  assert.equal(clean(await repair(cs, uuid(4))).status, 503);
  const cs2 = cold.make();
  cold.setTime(42);
  const opened = clean(await cs2.unlock(TOKEN, 'lab', uuid(4), 'gen-a', true));
  assert.equal(opened.released, true);
  assert.equal(opened.at, 42);
  assert.equal(cold.data.get(opKey(uuid(4))).status, 'unknown');
  assert.equal(cold.data.get(actKey()), undefined);
  assert.equal(cold.runs(), 0);
});

await test('replaying an old unlock does not release a newer lock', async () => {
  const w = world(), s = w.make();
  w.runImpl = () => { throw new Error('first'); };
  assert.equal(clean(await repair(s, uuid(1))).status, 'unknown');
  w.runImpl = null;
  w.ctx.ref.generation = 'gen-b';
  w.setTime(5000);
  const first = clean(await s.unlock(TOKEN, 'lab', uuid(1), 'gen-b', true));
  assert.equal(first.at, 5000);
  assert.equal(w.data.get(actKey()), undefined);
  const gate = w.holdRun();
  const pending = s.create(TOKEN, 'lab', uuid(2), 2, 'repair', 'gen-b', 4, false);
  await until(() => w.runs() === 2);
  assert.equal(w.data.get(actKey()), uuid(2));
  const deletes = w.deletes.length;
  w.setTime(9000);
  const replay = clean(await s.unlock(TOKEN, 'lab', uuid(1), 'gen-b', true));
  assert.equal(replay.released, true);
  assert.equal(replay.at, 5000);
  assert.equal(w.data.get(actKey()), uuid(2));
  assert.equal(w.deletes.length, deletes);
  assert.equal(w.data.get(opKey(uuid(1))).releasedAt, 5000);
  gate.release();
  const done = clean(await pending);
  assert.equal(done.status, 'ready');
  assert.equal(done.generation, 'gen-next');
  assert.equal(w.data.get(actKey()), undefined);
  const knownWorld = world(), ks = knownWorld.make();
  const older = clean(await repair(ks, uuid(3)));
  const held = knownWorld.holdRun();
  const newer = repair(ks, uuid(4));
  await until(() => knownWorld.runs() === 2);
  const olderRow = JSON.stringify(knownWorld.data.get(opKey(uuid(3))));
  const known = clean(await ks.unlock(TOKEN, 'lab', uuid(3), 'gen-a', true));
  assert.equal(known.note, NOTE_KNOWN);
  assert.equal(known.at, older.at);
  assert.equal(knownWorld.data.get(actKey()), uuid(4));
  assert.equal(JSON.stringify(knownWorld.data.get(opKey(uuid(3)))), olderRow);
  held.release();
  assert.equal(clean(await newer).status, 'ready');
  clean(w.audit);
  clean(knownWorld.audit);
});

await test('transaction validation can deny a stale claim before pending or active storage', async () => {
  const w = world(), s = w.make();let checked = 0;
  w.deps.validateContext = async (context, tx, file) => {checked++;assert.equal(tx,w.storage);assert.equal(context.revision,4);assert.equal(file,false);return {status:401,error:'관리 세션이 만료됐습니다.'}};
  assert.equal((await repair(s,uuid(90))).status,401);assert.equal(checked,1);assert.equal(w.data.has(opKey(uuid(90))),false);assert.equal(w.data.has(actKey()),false);assert.equal(w.runs(),0);
});
await test('transaction validation denies stale inspected unlock without releasing the seat', async () => {
  const w = world(), s = w.make();w.runImpl=()=>{throw Error('unknown')};assert.equal((await repair(s,uuid(90))).status,'unknown');
  const before=snap(w);w.deps.validateContext=async()=>({status:409,error:'수업 상태가 바뀌었습니다.'});
  assert.equal((await s.unlock(TOKEN,'lab',uuid(90),'gen-a',true)).status,409);assert.equal(snap(w),before);assert.equal(w.data.get(actKey()),uuid(90));
});
console.log(pass, 'passed');
