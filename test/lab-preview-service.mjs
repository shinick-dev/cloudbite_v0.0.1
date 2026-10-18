// 네트워크 없이 미리보기 서비스 번들과 직렬 메모리 저장소만 검사한다.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
const bundle = await build({ entryPoints: ['src/lab-preview-service.ts'], bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent' });
const M = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
globalThis.fetch = () => { throw new Error('network forbidden'); };
const uuid = (n) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const TOKEN = 'admin-secret-token';
const COMMAND = 'echo STAGE1A-SECRET-COMMAND 한글';
const tick = () => new Promise((r) => setImmediate(r));
const held = () => { let release; const promise = new Promise((r) => { release = r; }); return { promise, release }; };
async function until(f) { for (let i = 0; i < 100 && !f(); i++) await tick(); assert.ok(f()); }
const contextOf = (over = {}) => ({ owner: 'owner-hash', sessionId: uuid(9), targets: [1, 2], targetFingerprint: 'targets-v1', configFingerprint: 'config-v1', ...over });
function world() {
  const data = new Map(), audit = [];
  const copy = (x) => x === undefined ? x : structuredClone(x);
  let lock = Promise.resolve();
  let T = 1800000000000;
  let ctx = contextOf();
  let revoked = false;
  let trials = 0;
  let gets = 0;
  let hold = null;
  const limits = [];
  const storage = {
    async get(k) {
      gets++;
      if (storage.failGet) throw new Error('secret disk path ' + TOKEN + ' ' + COMMAND);
      if (hold && gets === hold.at) await hold.gate.promise;
      return copy(data.get(k));
    },
    async put(k, v) {
      if (storage.failPut) throw new Error('secret disk path ' + TOKEN + ' ' + COMMAND);
      data.set(k, copy(v));
    },
    async list(opts = {}) {
      if (!(opts.limit <= M.LAB_PREVIEW_LIMIT)) throw new Error('unbounded list');
      limits.push(opts.limit);
      const prefix = opts.prefix ?? '';
      const out = new Map();
      for (const [k, v] of data) {
        if (!k.startsWith(prefix)) continue;
        out.set(k, copy(v));
        if (out.size >= opts.limit) break;
      }
      return out;
    },
    transaction(fn) { const p = lock.then(() => fn(storage)); lock = p.catch(() => {}); return p; },
    failGet: false, failPut: false,
  };
  const deps = {
    storage, now: () => T, audit: async (event, detail) => { audit.push([event, detail]); },
    context: async () => revoked ? { status: 401, error: '관리 세션이 만료됐습니다.' } : copy(ctx),
    trial: async (_token, _id, runId) => {
      trials++;
      if (deps.trialResult) return typeof deps.trialResult === 'function' ? deps.trialResult(runId) : deps.trialResult;
      return { commandHash: await M.shaCommand(COMMAND), configFingerprint: ctx.configFingerprint, expiresAt: T + 60000 };
    },
    trialResult: null,
  };
  return {
    data, audit, storage, deps, limits, ctx: () => ctx, trials: () => trials, gets: () => gets,
    make: () => new M.LabPreviewService(deps),
    set time(v) { T = v; }, get time() { return T; },
    set context(v) { ctx = v; },
    revoke() { revoked = true; },
    arm() { hold = { at: gets + 1, gate: held() }; return hold.gate; },
  };
}
const row = (w, id = uuid(1)) => w.data.get(M.previewKey('lab', id));
const secretless = (w) => {
  const blob = JSON.stringify({ data: [...w.data.entries()], audit: w.audit });
  assert.equal(blob.includes(TOKEN), false);
  assert.equal(blob.includes(COMMAND), false);
  assert.equal(blob.includes('secret disk'), false);
};
let pass = 0;
async function test(name, f) { await f(); pass++; console.log('ok', name); }
await test('shaCommand is UTF-8 SHA-256 hex', async () => {
  assert.equal(await M.shaCommand(COMMAND), createHash('sha256').update(COMMAND, 'utf8').digest('hex'));
  assert.notEqual(await M.shaCommand(COMMAND), createHash('sha256').update(Buffer.from(COMMAND, 'utf16le')).digest('hex'));
});
await test('matching trial proof is tested and explicit waiver is not', async () => {
  const w = world(), s = w.make();
  const proven = await s.prepare(TOKEN, 'lab', uuid(1), COMMAND, { trialRunId: 'run-1' });
  assert.equal(proven.tested, true);
  assert.deepEqual(Object.keys(proven).sort(), ['expiresAt', 'previewId', 'targets', 'tested']);
  assert.deepEqual(proven.targets, [1, 2]);
  assert.equal(proven.expiresAt, w.time + M.LAB_PREVIEW_TTL_MS);
  assert.equal(w.trials(), 1);
  assert.equal(row(w).tested, true);
  assert.equal(row(w).trialRunId, 'run-1');
  assert.equal(row(w).consumedBy, null);
  assert.equal('command' in row(w), false);
  const waived = await s.prepare(TOKEN, 'lab', uuid(2), COMMAND, { ackWithoutTrial: true });
  assert.equal(waived.tested, false);
  assert.equal(w.trials(), 1);
  assert.equal(row(w, uuid(2)).trialRunId, null);
  const short = await s.prepare(TOKEN, 'lab', uuid(3), 'a', { ackWithoutTrial: true });
  assert.equal(short.tested, false);
  assert.equal(row(w, uuid(3)).commandHash, await M.shaCommand('a'));
  assert.equal('command' in row(w, uuid(3)), false);
  secretless(w);
  assert.deepEqual(w.audit.map((x) => x[0]), ['lab-preview-prepare', 'lab-preview-prepare', 'lab-preview-prepare']);
});
await test('missing waiver is rejected and does not call trial or storage', async () => {
  const w = world(), s = w.make();
  for (const options of [undefined, null, [], {}, { ackWithoutTrial: false }, { ackWithoutTrial: 'true' }, { ackWithoutTrial: 1 }, { trialRunId: 'run-1', ackWithoutTrial: true }, { extra: true, ackWithoutTrial: true }]) {
    const reply = await s.prepare(TOKEN, 'lab', uuid(1), COMMAND, options);
    assert.equal(reply.status, 400);
  }
  assert.equal(w.trials(), 0);
  assert.equal(w.data.size, 0);
  assert.equal(w.audit.length, 0);
  assert.equal((await s.prepare(TOKEN, 'lab', uuid(1), 'echo\nnext', { ackWithoutTrial: true })).status, 400);
  assert.equal((await s.prepare(TOKEN, 'lab', uuid(1), 'echo\tok', { ackWithoutTrial: true })).status, 400);
  assert.equal((await s.prepare(TOKEN, 'lab', uuid(1), '', { ackWithoutTrial: true })).status, 400);
  assert.equal((await s.prepare(TOKEN, 'lab', uuid(1), 'a'.repeat(4097), { ackWithoutTrial: true })).status, 400);
  assert.equal((await s.prepare(TOKEN, 'lab', 'not-a-uuid', COMMAND, { ackWithoutTrial: true })).status, 400);
  assert.equal(w.data.size, 0);
});
await test('trial proof must match this command and config and still be current', async () => {
  const w = world(), s = w.make();
  w.deps.trialResult = { commandHash: 'ab'.repeat(32), configFingerprint: 'config-v1', expiresAt: w.time + 1000 };
  assert.equal((await s.prepare(TOKEN, 'lab', uuid(1), COMMAND, { trialRunId: 'run-1' })).status, 409);
  w.deps.trialResult = { commandHash: await M.shaCommand(COMMAND), configFingerprint: 'other-config', expiresAt: w.time + 1000 };
  assert.equal((await s.prepare(TOKEN, 'lab', uuid(1), COMMAND, { trialRunId: 'run-1' })).status, 409);
  w.deps.trialResult = { commandHash: await M.shaCommand(COMMAND), configFingerprint: 'config-v1', expiresAt: w.time };
  assert.equal((await s.prepare(TOKEN, 'lab', uuid(1), COMMAND, { trialRunId: 'run-1' })).status, 410);
  w.deps.trialResult = { status: 404, error: '없는 시험 실행입니다.' };
  assert.equal((await s.prepare(TOKEN, 'lab', uuid(1), COMMAND, { trialRunId: 'run-1' })).status, 404);
  assert.equal(w.data.size, 0);
  assert.equal(w.audit.length, 0);
});
await test('same preview id replays and a different payload conflicts without moving expiry', async () => {
  const w = world(), s = w.make();
  const first = await s.prepare(TOKEN, 'lab', uuid(1), COMMAND, { ackWithoutTrial: true });
  w.time += 1000;
  w.deps.trialResult = { status: 410, error: '시험 실행 증명이 만료됐습니다.' };
  const again = await s.prepare(TOKEN, 'lab', uuid(1), COMMAND, { ackWithoutTrial: true });
  assert.deepEqual(again, first);
  assert.equal(row(w).expiresAt, first.expiresAt);
  assert.equal(w.trials(), 0);
  assert.equal(w.audit.length, 1);
  const edited = await s.prepare(TOKEN, 'lab', uuid(1), COMMAND + ' x', { ackWithoutTrial: true });
  assert.equal(edited.status, 409);
  assert.equal(row(w).commandHash, await M.shaCommand(COMMAND));
  assert.equal((await s.prepare(TOKEN, 'lab', uuid(1), COMMAND, { trialRunId: 'run-1' })).status, 409);
  assert.equal(row(w).tested, false);
  assert.equal(w.data.size, 1);
  assert.equal(w.audit.length, 1);
});
await test('owner session targets and config changes invalidate prepare and consume', async () => {
  const w = world(), s = w.make();
  const made = await s.prepare(TOKEN, 'lab', uuid(1), COMMAND, { ackWithoutTrial: true });
  assert.equal(made.previewId, uuid(1));
  for (const patch of [{ owner: 'other-owner' }, { sessionId: uuid(8) }, { targets: [1, 3] }, { targets: [2, 1] }, { targetFingerprint: 'targets-v2' }, { configFingerprint: 'config-v2' }]) {
    w.context = contextOf(patch);
    assert.equal((await s.prepare(TOKEN, 'lab', uuid(1), COMMAND, { ackWithoutTrial: true })).status, 409);
    assert.equal((await s.consume(TOKEN, 'lab', uuid(1), uuid(2), COMMAND)).status, 409);
    assert.equal(row(w).consumedBy, null);
    w.context = contextOf();
  }
  assert.equal(row(w).commandHash, await M.shaCommand(COMMAND));
  const ok = await s.consume(TOKEN, 'lab', uuid(1), uuid(2), COMMAND);
  assert.equal(ok.operationId, uuid(2));
  assert.deepEqual(ok.targets, [1, 2]);
});
await test('context that changes while prepare is waiting is not stored', async () => {
  const w = world(), s = w.make();
  let calls = 0;
  w.deps.context = async () => {
    calls++;
    return calls < 3 ? contextOf() : contextOf({ targets: [9], targetFingerprint: 'targets-v9' });
  };
  const reply = await s.prepare(TOKEN, 'lab', uuid(1), COMMAND, { trialRunId: 'run-1' });
  assert.equal(reply.status, 409);
  assert.equal(calls >= 3, true);
  assert.equal(w.trials(), 1);
  assert.equal(w.data.size, 0);
  assert.equal(w.audit.length, 0);
});
await test('expiry blocks consume and does not extend the original preview', async () => {
  const w = world(), s = w.make();
  const made = await s.prepare(TOKEN, 'lab', uuid(1), COMMAND, { ackWithoutTrial: true });
  w.time = made.expiresAt;
  assert.deepEqual(await s.prepare(TOKEN, 'lab', uuid(1), COMMAND, { ackWithoutTrial: true }), made);
  const late = await s.consume(TOKEN, 'lab', uuid(1), uuid(2), COMMAND);
  assert.equal(late.status, 410);
  assert.equal(row(w).consumedBy, null);
  assert.equal(row(w).expiresAt, made.expiresAt);
  w.time = made.expiresAt - 1;
  const revived = w.make();
  const used = await revived.consume(TOKEN, 'lab', uuid(1), uuid(2), COMMAND);
  assert.equal(used.operationId, uuid(2));
});
await test('same operation can retry and a different operation conflicts', async () => {
  const w = world(), s = w.make();
  await s.prepare(TOKEN, 'lab', uuid(1), COMMAND, { ackWithoutTrial: true });
  const first = await s.consume(TOKEN, 'lab', uuid(1), uuid(3), COMMAND);
  const retry = await s.consume(TOKEN, 'lab', uuid(1), uuid(3), COMMAND);
  assert.deepEqual(retry, first);
  assert.equal(row(w).consumedBy, uuid(3));
  assert.equal(w.audit.filter((x) => x[0] === 'lab-preview-consume').length, 1);
  const other = await s.consume(TOKEN, 'lab', uuid(1), uuid(4), COMMAND);
  assert.equal(other.status, 409);
  assert.equal(row(w).consumedBy, uuid(3));
  assert.equal((await s.consume(TOKEN, 'lab', uuid(1), uuid(3), COMMAND + ' x')).status, 409);
  assert.equal(row(w).consumedBy, uuid(3));
  assert.equal((await s.consume(TOKEN, 'lab', uuid(8), uuid(5), COMMAND)).status, 404);
});
await test('authority revoked during the held storage read does not consume', async () => {
  const w = world(), s = w.make();
  await s.prepare(TOKEN, 'lab', uuid(1), COMMAND, { ackWithoutTrial: true });
  const before = w.gets();
  const gate = w.arm();
  const pending = s.consume(TOKEN, 'lab', uuid(1), uuid(2), COMMAND);
  await until(() => w.gets() > before);
  w.revoke();
  gate.release();
  const reply = await pending;
  assert.equal(reply.status, 401);
  assert.equal(JSON.stringify(reply).includes(TOKEN), false);
  assert.equal(row(w).consumedBy, null);
  assert.equal(w.audit.some((x) => x[0] === 'lab-preview-consume'), false);
});
await test('storage failures do not echo exception text', async () => {
  const w = world(), s = w.make();
  w.storage.failPut = true;
  const saved = await s.prepare(TOKEN, 'lab', uuid(1), COMMAND, { ackWithoutTrial: true });
  assert.equal(saved.status, 503);
  assert.equal(JSON.stringify(saved).includes(TOKEN), false);
  assert.equal(JSON.stringify(saved).includes(COMMAND), false);
  assert.equal(JSON.stringify(saved).includes('secret'), false);
  assert.equal(w.data.size, 0);
  w.storage.failPut = false;
  await s.prepare(TOKEN, 'lab', uuid(1), COMMAND, { ackWithoutTrial: true });
  w.storage.failGet = true;
  const used = await s.consume(TOKEN, 'lab', uuid(1), uuid(2), COMMAND);
  assert.equal(used.status, 503);
  assert.equal(JSON.stringify(used).includes('secret'), false);
  assert.equal(JSON.stringify(used).includes(TOKEN), false);
  assert.equal(row(w).consumedBy, null);
});
await test('preview records stop at 256 per lab without an unbounded list', async () => {
  const w = world(), s = w.make();
  const long = 'a'.repeat(4096);
  for (let n = 1; n <= M.LAB_PREVIEW_LIMIT; n++) {
    const made = await s.prepare(TOKEN, 'lab', uuid(n), long, { ackWithoutTrial: true });
    assert.equal(made.previewId, uuid(n));
  }
  assert.equal(w.data.size, M.LAB_PREVIEW_LIMIT);
  assert.ok(w.limits.every((n) => n === M.LAB_PREVIEW_LIMIT));
  const extra = await s.prepare(TOKEN, 'lab', uuid(300), long, { ackWithoutTrial: true });
  assert.equal(extra.status, 429);
  assert.equal(w.data.size, M.LAB_PREVIEW_LIMIT);
  const replay = await s.prepare(TOKEN, 'lab', uuid(1), long, { ackWithoutTrial: true });
  assert.equal(replay.previewId, uuid(1));
  assert.equal(w.data.size, M.LAB_PREVIEW_LIMIT);
  const other = await s.prepare(TOKEN, 'other-lab', uuid(301), long, { ackWithoutTrial: true });
  assert.equal(other.previewId, uuid(301));
  secretless(w);
  assert.equal(M.previewPrefix('lab'), 'labpv:lab:');
});
console.log(`${pass} lab preview service scenarios passed`);
