// 실습실 열기 요청 인박스. 번들된 서비스 + 메모리 트랜잭션/시계만 사용하고 네트워크는 없다.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const out = await build({ entryPoints: ['src/lab-open-request-service.ts'], bundle: true, write: false, format: 'esm', platform: 'node' });
const dir = mkdtempSync(join(tmpdir(), 'lab-open-'));
writeFileSync(join(dir, 'service.mjs'), out.outputFiles[0].text);
const M = await import(pathToFileURL(join(dir, 'service.mjs')));
rmSync(dir, { recursive: true, force: true });

let fetches = 0;
globalThis.fetch = () => { fetches += 1; throw new Error('network forbidden'); };
let count = 0;
const check = (name) => { count += 1; console.log('ok', name); };
const CHOICE_A = '{"seat":1}';
const CHOICE_B = '{"seat":2}';
const IP = '198.51.100.24';

function assertFail(value, status) {
  assert.equal(value.status, status);
  assert.equal(typeof value.error, 'string');
  assert.deepEqual(Object.keys(value).sort(), ['error', 'status']);
}
function deepKeys(value, found = []) {
  if (Array.isArray(value)) for (const item of value) deepKeys(item, found);
  else if (value && typeof value === 'object') for (const [key, inner] of Object.entries(value)) { found.push(key); deepKeys(inner, found); }
  return found;
}
function secret() {
  const encoded = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
  assert.equal(encoded.length, 43);
  return encoded;
}
function reqCount(w) {
  return [...w.data.keys()].filter((key) => key.startsWith(M.OPEN_REQ_PREFIX)).length;
}
function stored(w) { return JSON.stringify([...w.data.entries()]); }
async function sha256(text) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
function world() {
  let T = 1800000000000;
  let admin = true;
  let trap = false;
  let armed = false;
  let blow = false;
  let scheduleError = null;
  const data = new Map();
  const schedules = [];
  let chain = Promise.resolve();
  const enqueue = (fn) => {
    const run = chain.then(fn, fn);
    chain = run.then(() => {}, () => {});
    return run;
  };
  const clone = (value) => value === undefined ? undefined : structuredClone(value);
  const noteRead = (key) => {
    if (trap && typeof key === 'string' && key.startsWith(M.OPEN_REQ_PREFIX)) armed = true;
  };
  const listFrom = (map, opts = {}) => {
    const prefix = opts.prefix ?? '';
    const limit = opts.limit ?? 128;
    const startAfter = opts.startAfter;
    noteRead(prefix);
    const keys = [...map.keys()].filter((key) => key.startsWith(prefix) && (startAfter == null || key > startAfter)).sort();
    const out = new Map();
    for (const key of keys.slice(0, limit)) out.set(key, clone(map.get(key)));
    return out;
  };
  const makeTx = (map) => ({
    async get(key) { noteRead(key); return clone(map.get(key)); },
    async put(key, value) { if (blow) throw new Error('storage secret'); map.set(key, clone(value)); },
    async delete(key) { map.delete(key); return true; },
    async list(opts) { return listFrom(map, opts); },
  });
  const storage = {
    get: (key) => enqueue(() => makeTx(data).get(key)),
    put: (key, value) => enqueue(() => makeTx(data).put(key, value)),
    delete: (key) => enqueue(() => makeTx(data).delete(key)),
    list: (opts) => enqueue(() => makeTx(data).list(opts)),
    transaction(fn) {
      return enqueue(async () => {
        const draft = new Map(data);
        const result = await fn(makeTx(draft));
        data.clear();
        for (const [key, value] of draft) data.set(key, value);
        return result;
      });
    },
  };
  const deps = {
    storage,
    now: () => T,
    checkAdmin: async (token) => admin && token === 'admin' && !armed,
    schedule: async (t) => {
      if (![...data.keys()].some((key) => key.startsWith(M.OPEN_REQ_PREFIX))) throw new Error('schedule before record');
      schedules.push(t);
      if (scheduleError) throw new Error(scheduleError);
    },
  };
  const body = (over = {}) => ({ id: crypto.randomUUID(), secret: secret(), mode: 'practice', name: '김실습', purpose: '조건문 연습', issuedAt: T, ...over });
  return {
    body, data, schedules, make: () => new M.LabOpenRequestService(deps),
    get T() { return T; }, set T(value) { T = value; },
    set admin(value) { admin = value; },
    set trap(value) { trap = value; armed = false; },
    set blow(value) { blow = value; },
    set scheduleError(value) { scheduleError = value; },
  };
}
function observed(w, over = {}) {
  return { labId: 'lab-1', n: 2, seatCode: 'seat-LEAK-9f3a', expiresAt: w.T + 3600000, ...over };
}

{
  const w = world(), s = w.make();
  const rejects = [
    null, [], 'x', 1,
    { ...w.body(), extra: true },
    w.body({ mode: 'watch' }),
    w.body({ name: '김\n실습' }),
    w.body({ purpose: '줄\u0001바꿈' }),
    w.body({ targetLabId: 'lab\u007f' }),
    w.body({ name: '가'.repeat(41) }),
    w.body({ purpose: '가'.repeat(201) }),
    w.body({ targetLabId: 'x'.repeat(101) }),
    w.body({ id: crypto.randomUUID().toUpperCase() }),
    w.body({ id: 'not-uuid' }),
    w.body({ secret: 'A'.repeat(42) + 'B' }),
    w.body({ secret: 'A'.repeat(42) + '=' }),
    w.body({ issuedAt: w.T + 0.5 }),
    w.body({ issuedAt: -1 }),
    w.body({ issuedAt: w.T + M.OPEN_FIRST_USE + 1 }),
    w.body({ issuedAt: w.T - M.OPEN_FIRST_USE }),
    w.body({ issuedAt: w.T - M.OPEN_RETAIN }),
  ];
  const dropped = w.body();
  delete dropped.issuedAt;
  rejects.push(dropped);
  for (const input of rejects) assertFail(await s.submit(input, IP), input && input.issuedAt === w.T - M.OPEN_FIRST_USE || input && input.issuedAt === w.T - M.OPEN_RETAIN ? 410 : 400);
  assertFail(await s.submit(w.body(), ''), 400);
  assertFail(await s.submit(w.body(), 'bad\nsource'), 400);
  assertFail(await s.submit(w.body(), 12), 400);
  assert.equal(w.data.size, 0);
  assert.equal(w.schedules.length, 0);
  check('reject unknown fields, control chars, clock, secret, empty store');
  const edge = w.body({ name: '가'.repeat(40), purpose: '가'.repeat(200), issuedAt: w.T - M.OPEN_FIRST_USE + 1 });
  assert.equal((await s.submit(edge, IP)).state, 'pending');
  const future = w.body({ issuedAt: w.T + M.OPEN_FIRST_USE });
  assert.equal((await s.submit(future, '203.0.113.8')).state, 'pending');
  const known = 'A'.repeat(43);
  assert.equal((await s.submit(w.body({ secret: known }), IP)).state, 'pending');
  assert.equal(stored(w).includes(known), false);
  check('bounds and canonical secret accepted without storing it');
}

{
  const w = world(), s = w.make();
  const inp = w.body({ mode: 'join', targetLabId: 'lab-77' });
  const first = await s.submit(inp, IP);
  assert.deepEqual(Object.keys(first).sort(), ['expiresAt', 'id', 'state']);
  assert.equal(first.state, 'pending');
  assert.equal(first.expiresAt, w.T + M.OPEN_MAX_AGE);
  assert.deepEqual(await s.submit({ issuedAt: inp.issuedAt, purpose: inp.purpose, targetLabId: inp.targetLabId, name: inp.name, mode: inp.mode, secret: inp.secret, id: inp.id }, IP), first);
  assert.equal(reqCount(w), 1);
  const rate = [...w.data.entries()].find(([key]) => key.startsWith(M.OPEN_RATE_PREFIX))[1];
  assert.equal(rate.hits.length, 1);
  assert.equal(w.schedules.length, 2);
  assert.deepEqual(w.schedules, [w.T, w.T]);
  const rec = await s.get(inp.id);
  assert.equal(rec.createdAt, w.T);
  assert.equal(rec.source, await sha256(IP));
  assert.equal(stored(w).includes(IP), false);
  assert.equal(stored(w).includes(inp.secret), false);
  assert.deepEqual(Object.keys(rec).sort(), ['createdAt', 'expiresAt', 'id', 'mode', 'name', 'payloadHash', 'purpose', 'secretHash', 'source', 'state', 'targetLabId']);
  check('submit retry after response loss keeps one record and reschedules');
}

{
  const w = world(), s = w.make();
  const inp = w.body();
  w.scheduleError = 'raw-secret-value';
  const failed = await s.submit(inp, IP);
  assertFail(failed, 503);
  assert.equal(JSON.stringify(failed).includes('raw-secret-value'), false);
  assert.equal((await s.status(inp.id, inp.secret)).state, 'pending');
  assert.deepEqual(await s.pendingIds(), [inp.id]);
  w.scheduleError = null;
  assert.equal((await s.submit(inp, IP)).state, 'pending');
  assert.equal(reqCount(w), 1);
  assert.equal(w.schedules.length, 2);
  check('schedule failure stays readable and replay retries schedule');
}

{
  const w = world(), s = w.make();
  const inp = w.body();
  await s.submit(inp, IP);
  const hash = (await s.get(inp.id)).secretHash;
  assertFail(await s.submit({ ...inp, purpose: '다른 목적' }, IP), 409);
  assertFail(await s.submit({ ...inp, secret: secret() }, IP), 409);
  assertFail(await s.submit({ ...inp, issuedAt: inp.issuedAt + 1 }, IP), 409);
  assert.equal((await s.get(inp.id)).purpose, inp.purpose);
  assert.equal((await s.get(inp.id)).secretHash, hash);
  assert.equal([...w.data.values()].find((row) => row.hits).hits.length, 1);
  assertFail(await s.status(inp.id, secret()), 401);
  assert.equal(JSON.stringify(await s.status(inp.id, secret())).includes(inp.name), false);
  const view = await s.status(inp.id, inp.secret);
  assert.equal(view.name, inp.name);
  assert.equal(deepKeys(view).includes('secretHash') || deepKeys(view).includes('choice') || deepKeys(view).includes('source'), false);
  assertFail(await s.status('nope', inp.secret), 400);
  assertFail(await s.status(crypto.randomUUID(), inp.secret), 404);
  check('same-id payload or secret mismatch is 409 and status requires the secret');
}

{
  const w = world(), s = w.make();
  w.blow = true;
  assertFail(await s.submit(w.body(), IP), 503);
  assert.equal(JSON.stringify(await s.submit(w.body(), IP)).includes('storage secret'), false);
  assert.equal(w.data.size, 0);
  assert.equal(w.schedules.length, 0);
  check('quota and record roll back together when storage write fails');
}

{
  const w = world(), s = w.make();
  const made = [];
  for (let i = 0; i < M.OPEN_RATE_LIMIT; i++) {
    const inp = w.body();
    assert.equal((await s.submit(inp, IP)).state, 'pending');
    made.push(inp);
  }
  assertFail(await s.submit({ ...made[0], purpose: '다른' }, IP), 409);
  const blocked = await s.submit(w.body(), IP);
  assertFail(blocked, 429);
  assert.equal(blocked.error, '같은 출처의 새 요청 한도(5/10분)에 도달했습니다.');
  assert.equal((await s.submit(made[0], IP)).state, 'pending');
  assert.equal((await s.submit(w.body(), '203.0.113.9')).state, 'pending');
  w.T += M.OPEN_RATE_WINDOW - 1;
  assertFail(await s.submit(w.body({ issuedAt: w.T }), IP), 429);
  w.T += 1;
  assert.equal((await s.submit(w.body({ issuedAt: w.T }), IP)).state, 'pending');
  const parallel = await Promise.all([0, 1, 2, 3, 4, 5].map(() => s.submit(w.body(), '203.0.113.10')));
  assert.equal(parallel.filter((row) => row.state === 'pending').length, M.OPEN_RATE_LIMIT);
  assert.equal(parallel.filter((row) => row.status === 429).length, 1);
  check('distinct source rate, replay exemption, and concurrent new requests');
}

{
  const w = world(), s = w.make();
  const base = w.T;
  for (let i = 0; i < M.OPEN_PENDING_MAX - 1; i++) assert.equal((await s.submit(w.body(), `src-${i}`)).state, 'pending');
  const pair = await Promise.all([s.submit(w.body(), 'src-left'), s.submit(w.body(), 'src-right')]);
  assert.equal(pair.filter((row) => row.state === 'pending').length, 1);
  assert.equal(pair.filter((row) => row.status === 429 && row.error === '대기 중인 요청이 가득 찼습니다.').length, 1);
  assert.equal(reqCount(w), M.OPEN_PENDING_MAX);
  w.T = base + M.OPEN_MAX_AGE;
  assert.equal((await s.submit(w.body(), 'src-after')).state, 'pending');
  const live = await s.pendingIds();
  assert.equal(live.length, 1);
  check('global pending cap is atomic and ignores expired pending');
}

{
  const w = world(), s = w.make();
  const inp = w.body();
  await s.submit(inp, IP);
  const [left, right] = await Promise.all([s.claim('admin', inp.id, CHOICE_A), s.claim('admin', inp.id, CHOICE_A)]);
  assert.equal(left.record.operationId, right.record.operationId);
  assert.match(left.record.operationId, /^lc_\d{13}_[a-f0-9]{32}$/);
  assert.equal(left.record.operationId.slice(3, 16), String(w.T));
  assert.equal(Number(left.fresh) + Number(right.fresh), 1);
  const other = w.body();
  await s.submit(other, '203.0.113.11');
  const raced = await Promise.all([s.claim('admin', other.id, CHOICE_A), s.claim('admin', other.id, CHOICE_B)]);
  const won = raced.find((row) => row.record);
  const lost = raced.find((row) => row.status);
  assert.equal(won.fresh, true);
  assertFail(lost, 409);
  assert.equal((await s.get(other.id)).choice, won.record.choice);
  assert.equal((await s.get(other.id)).operationId, won.record.operationId);
  const restarted = await w.make().claim('admin', other.id, won.record.choice);
  assert.equal(restarted.fresh, false);
  assert.equal(restarted.record.operationId, won.record.operationId);
  w.blow = true;
  assert.equal((await w.make().claim('admin', other.id, won.record.choice)).fresh, false);
  w.blow = false;
  assertFail(await s.claim('admin', other.id, won.record.choice === CHOICE_A ? CHOICE_B : CHOICE_A), 409);
  assert.equal((await s.get(other.id)).operationId, won.record.operationId);
  const wide = `{"k":"${'가'.repeat(3000)}"}`;
  assert.ok(wide.length <= M.OPEN_CHOICE_MAX && Buffer.byteLength(wide) > M.OPEN_CHOICE_MAX);
  assertFail(await s.claim('admin', inp.id, wide), 400);
  const big = `{"k":"${'a'.repeat(M.OPEN_CHOICE_MAX - 8)}"}`;
  assert.equal(big.length, M.OPEN_CHOICE_MAX);
  assert.equal((await s.claim('admin', crypto.randomUUID(), big)).status, 404);
  check('concurrent claims, restart-stable operation id, choice mismatch');
}

{
  const w = world(), s = w.make();
  const inp = w.body();
  await s.submit(inp, IP);
  assertFail(await s.claim('admin', inp.id, '{ "seat": 1 }'), 400);
  assertFail(await s.claim('admin', inp.id, '{"k":"' + 'a'.repeat(M.OPEN_CHOICE_MAX) + '"}'), 400);
  assert.equal((await s.get(inp.id)).state, 'pending');
  const claimed = await s.claim('admin', inp.id, CHOICE_A);
  assert.equal(claimed.fresh, true);
  const schedules = w.schedules.length;
  assert.equal((await s.submit(inp, IP)).state, 'approving');
  assert.equal(w.schedules.length, schedules);
  const op = claimed.record.operationId;
  const flipped = op.slice(0, -1) + (op.endsWith('a') ? 'b' : 'a');
  assertFail(await s.finish(inp.id, flipped, observed(w)), 409);
  assert.equal((await s.get(inp.id)).result, undefined);
  assertFail(await s.finish(inp.id, op, { labId: 'lab-1', n: 2, seatCode: 'seat-LEAK-9f3a' }), 400);
  assert.equal((await s.finish(inp.id, op, observed(w))).ok, true);
  w.blow = true;
  assert.deepEqual(await s.finish(inp.id, op, observed(w)), { ok: true });
  assert.deepEqual(await w.make().finish(inp.id, op, observed(w)), { ok: true });
  w.blow = false;
  assertFail(await s.finish(inp.id, op, observed(w, { seatCode: 'other-seat' })), 409);
  assert.equal((await s.get(inp.id)).result.seatCode, 'seat-LEAK-9f3a');
  assert.equal((await s.claim('admin', inp.id, CHOICE_A)).fresh, false);
  assert.equal((await s.claim('admin', inp.id, CHOICE_A)).record.operationId, op);
  assertFail(await s.claim('admin', inp.id, CHOICE_B), 409);
  assert.equal(w.schedules.length, schedules);
  check('ready replay is idempotent and finish never invents a result');
}

{
  const w = world(), s = w.make();
  const inp = w.body({ mode: 'join', targetLabId: 'lab-77' });
  await s.submit(inp, IP);
  await s.claim('admin', inp.id, CHOICE_A);
  const op = (await s.get(inp.id)).operationId;
  await s.finish(inp.id, op, observed(w));
  const view = await s.status(inp.id, inp.secret);
  assert.equal(view.result.seatCode, 'seat-LEAK-9f3a');
  assert.equal(deepKeys(view).some((key) => ['secretHash', 'payloadHash', 'source', 'choice', 'operationId'].includes(key)), false);
  const listed = await s.list('admin');
  assert.equal(listed.now, w.T);
  assert.equal(listed.requests[0].targetLabId, 'lab-77');
  assert.equal(listed.requests[0].choice, CHOICE_A);
  assert.deepEqual(Object.keys(listed.requests[0].result).sort(), ['expiresAt', 'labId', 'n']);
  const listedKeys = deepKeys(listed);
  for (const key of ['secretHash', 'payloadHash', 'source', 'seatCode', 'operationId', 'approvedAt']) assert.equal(listedKeys.includes(key), false);
  assert.equal(JSON.stringify(listed).includes(inp.secret), false);
  assert.equal(JSON.stringify(listed).includes(IP), false);
  assert.equal(JSON.stringify(listed).includes('seat-LEAK-9f3a'), false);
  w.T = observed(w).expiresAt;
  const hidden = await s.status(inp.id, inp.secret);
  assert.equal(hidden.state, 'expired');
  assert.equal(hidden.result, undefined);
  assert.equal(JSON.stringify(hidden).includes('seat-LEAK-9f3a'), false);
  assert.equal(JSON.stringify(await s.list('admin')).includes('seat-LEAK-9f3a'), false);
  assert.equal((await s.get(inp.id)).state, 'ready');
  assert.equal((await s.get(inp.id)).result.seatCode, 'seat-LEAK-9f3a');
  check('list and status hide secret, source, and expired seat code');
}

{
  const w = world(), s = w.make();
  const start = w.T;
  const older = w.body();
  await s.submit(older, IP);
  w.T = start + 10;
  const newer = w.body();
  await s.submit(newer, IP);
  w.T = start + 20;
  const newest = w.body();
  await s.submit(newest, IP);
  await s.claim('admin', newer.id, CHOICE_A);
  assert.deepEqual((await s.list('admin')).requests.map((row) => row.id), [newest.id, older.id, newer.id]);
  assert.deepEqual(await s.pendingIds(), [older.id, newest.id]);
  for (let i = 0; i < 130; i++) {
    const id = crypto.randomUUID();
    const createdAt = start + 1000 + i;
    w.data.set(M.OPEN_REQ_PREFIX + id, {
      id, secretHash: 'ab'.repeat(32), payloadHash: 'cd'.repeat(32), mode: 'practice', name: `n${i}`, purpose: '목록',
      source: 'ef'.repeat(32), createdAt, expiresAt: createdAt + M.OPEN_MAX_AGE, state: 'pending',
    });
  }
  const bounded = await s.list('admin');
  assert.equal(bounded.requests.length, M.OPEN_LIST_MAX);
  assert.equal(bounded.requests[0].name, 'n129');
  assert.equal(bounded.requests.some((row) => row.name === 'n0' || row.name === 'n1'), false);
  for (const row of w.data.values()) if (typeof row.name === 'string' && /^n\d+$/.test(row.name)) row.state='denied';
  const pendingFirst=await s.list('admin');
  assert.deepEqual(pendingFirst.requests.slice(0,3).map(r=>r.id),[newest.id,older.id,newer.id]);
  assert.equal(pendingFirst.truncated,true);
  check('pending requests cannot be buried by resolved history; each group newest first and bounded');
}

{
  const w = world(), s = w.make();
  const start = w.T;
  const inp = w.body({ issuedAt: start + M.OPEN_FIRST_USE });
  await s.submit(inp, IP);
  w.T = start + M.OPEN_MAX_AGE - 1;
  assert.equal((await s.status(inp.id, inp.secret)).state, 'pending');
  w.T = start + M.OPEN_MAX_AGE;
  assert.equal((await s.status(inp.id, inp.secret)).state, 'expired');
  assert.deepEqual(await s.pendingIds(), []);
  assert.equal((await s.get(inp.id)).state, 'expired');
  assert.equal(await s.alarm(w.T), start + M.OPEN_RETAIN);
  w.T = start + M.OPEN_RETAIN;
  assert.equal(await s.alarm(w.T), Infinity);
  assert.equal(await s.get(inp.id), undefined);
  assertFail(await s.submit(inp, IP), 410);
  assert.equal(await s.get(inp.id), undefined);
  const skewed = world();
  const opened = skewed.body({ issuedAt: skewed.T + M.OPEN_FIRST_USE });
  await skewed.make().submit(opened, IP);
  const born = skewed.T;
  assert.equal(await skewed.make().alarm(born + M.OPEN_RETAIN), Infinity);
  skewed.T = born + M.OPEN_RETAIN;
  assertFail(await skewed.make().submit(opened, IP), 410);
  assert.equal(skewed.data.size, 0);
  check('pending expires at 24h, retention removes the id, old issuedAt cannot reopen');
}

{
  const w = world(), s = w.make();
  const inp = w.body();
  await s.submit(inp, IP);
  const before = w.schedules.length;
  assert.equal(await s.alarm(w.T), w.T + M.OPEN_RATE_WINDOW);
  await s.claim('admin', inp.id, CHOICE_A);
  assert.equal((await s.get(inp.id)).state, 'approving');
  assert.equal(await s.alarm(w.T + M.OPEN_RATE_WINDOW), w.T + M.OPEN_RETAIN);
  assert.equal((await s.get(inp.id)).state, 'approving');
  assert.equal((await s.get(inp.id)).result, undefined);
  assert.equal(w.schedules.length, before);
  assert.equal(fetches, 0);
  const ready = w.body();
  await s.submit(ready, '203.0.113.12');
  const claimed = await s.claim('admin', ready.id, CHOICE_B);
  const mark = w.schedules.length;
  await s.finish(ready.id, claimed.record.operationId, observed(w));
  await s.alarm(w.T);
  await s.deny('admin', ready.id);
  assert.equal(w.schedules.length, mark);
  assert.equal((await s.get(ready.id)).state, 'ready');
  assert.equal(fetches, 0);
  check('alarm and finish do not provision or retry creation');
}

{
  const w = world(), s = w.make();
  const inp = w.body();
  await s.submit(inp, IP);
  w.admin = false;
  assertFail(await s.list('admin'), 401);
  assertFail(await s.claim('admin', inp.id, CHOICE_A), 401);
  assertFail(await s.deny('admin', inp.id), 401);
  assert.equal(JSON.stringify(await s.list('admin')).includes(inp.name), false);
  w.admin = true;
  w.trap = true;
  assertFail(await s.claim('admin', inp.id, CHOICE_A), 401);
  assertFail(await s.deny('admin', inp.id), 401);
  assertFail(await s.list('admin'), 401);
  w.trap = false;
  assert.equal((await s.get(inp.id)).state, 'pending');
  assert.equal((await s.get(inp.id)).operationId, undefined);
  const denied = await s.deny('admin', inp.id);
  assert.deepEqual(denied, { ok: true });
  const view = await s.status(inp.id, inp.secret);
  assert.equal(view.state, 'denied');
  assert.equal(view.message, M.OPEN_DENIED_MESSAGE);
  assert.equal(deepKeys(view).includes('choice'), false);
  assert.deepEqual(await s.deny('admin', inp.id), { ok: true });
  assert.deepEqual(await w.make().deny('admin', inp.id), { ok: true });
  assertFail(await s.claim('admin', inp.id, CHOICE_A), 409);
  const live = w.body();
  await s.submit(live, '203.0.113.13');
  await s.claim('admin', live.id, CHOICE_A);
  assertFail(await s.deny('admin', live.id), 409);
  assert.equal((await s.get(live.id)).state, 'approving');
  await s.finish(live.id, (await s.get(live.id)).operationId, observed(w));
  assertFail(await s.deny('admin', live.id), 409);
  assert.equal((await s.get(live.id)).state, 'ready');
  const aging = w.body();
  await s.submit(aging, '203.0.113.14');
  w.T += M.OPEN_MAX_AGE;
  assertFail(await s.deny('admin', aging.id), 410);
  assert.equal((await s.get(aging.id)).state, 'expired');
  assertFail(await s.deny('admin', live.id), 409);
  check('unauthorized mutations do not write, denial is pending-only and idempotent');
}

assert.equal(fetches, 0);
check('service never calls fetch');
console.log(`${count} checks passed`);
