// 네트워크 없이 체험 연결 서비스 번들과 직렬 메모리 저장소만 검사한다.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const bundle = await build({ entryPoints: ['src/lab-trial-service.ts'], bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent' });
const M = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
globalThis.fetch = () => { throw new Error('network forbidden'); };
const uuid = (n) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const TOKEN = 'admin-secret-token';
const COMMAND = `reveal ${TOKEN} /tmp/student-output`;
const tick = () => new Promise((r) => setImmediate(r));
const held = () => { let release; const promise = new Promise((r) => { release = r; }); return { promise, release }; };
async function until(f) { for (let i = 0; i < 100 && !f(); i++) await tick(); assert.ok(f()); }
async function sha(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function world() {
  const data = new Map(), audit = [];
  const copy = (x) => x === undefined ? x : structuredClone(x);
  let lock = Promise.resolve();
  let T = 1800000000000;
  const labs = new Map();
  const add = (id, patch = {}) => {
    const row = { id, name: id, expiresAt: T + 3600000, fingerprint: 'fp-same', eligible: true, seats: [{ n: 1, sandboxId: `box-${id}` }], ...patch };
    labs.set(id, row);
    return row;
  };
  add('parent');
  add('trial');
  let hold = null, hits = 0, allow = true;
  const storage = {
    async get(k) { if (storage.failGet) throw new Error('secret disk path ' + TOKEN); return copy(data.get(k)); },
    async put(k, v) { if (storage.failPut) throw new Error('secret disk path ' + TOKEN); data.set(k, copy(v)); },
    async list(options = {}) {
      if (storage.failGet) throw new Error('secret disk path ' + TOKEN);
      const prefix = options.prefix ?? '';
      const limit = options.limit ?? Number.POSITIVE_INFINITY;
      const out = new Map();
      for (const [k, v] of data) {
        if (!k.startsWith(prefix)) continue;
        out.set(k, copy(v));
        if (out.size >= limit) break;
      }
      return out;
    },
    transaction(fn) { const p = lock.then(() => fn(storage)); lock = p.catch(() => {}); return p; },
    failGet: false, failPut: false,
  };
  const deps = {
    storage, now: () => T, checkAdmin: async (t) => t === TOKEN && allow,
    lab: async (id) => { hits++; if (hold && hits === hold.at) await hold.gate.promise; const row = labs.get(id); return row ? copy(row) : undefined; },
    audit: async (event, detail) => { audit.push([event, detail]); },
  };
  return {
    data, audit, labs, storage, deps, add, hits: () => hits, make: () => new M.LabTrialService(deps),
    set time(v) { T = v; }, get time() { return T; }, set allow(v) { allow = v; },
    arm(at) { hits = 0; hold = { at, gate: held() }; return hold.gate; },
  };
}
const dump = (w) => JSON.stringify({ data: [...w.data.entries()], audit: w.audit });
const bindRow = (w) => w.data.get(M.trialBindingKey('parent'));
let pass = 0;
async function test(name, f) { await f(); pass++; console.log('ok', name); }

await test('new bind requires one eligible seat and the same configuration', async () => {
  const w = world(), s = w.make();
  assert.deepEqual(await s.status(TOKEN, 'parent'), { binding: null });
  assert.equal((await s.bind(TOKEN, 'parent', 'parent', uuid(1))).status, 400);
  assert.equal((await s.bind('other-token', 'parent', 'trial', uuid(1))).status, 401);
  w.labs.get('trial').eligible = false;
  assert.equal((await s.bind(TOKEN, 'parent', 'trial', uuid(2))).status, 409);
  w.labs.get('trial').eligible = true;
  w.labs.get('trial').seats = [{ n: 1, sandboxId: 'box-trial' }, { n: 2, sandboxId: 'box-extra' }];
  assert.equal((await s.bind(TOKEN, 'parent', 'trial', uuid(3))).status, 409);
  w.labs.get('trial').seats = [{ n: 1 }];
  assert.equal((await s.bind(TOKEN, 'parent', 'trial', uuid(4))).status, 409);
  w.labs.get('trial').seats = [{ n: 1, sandboxId: 'box-trial' }];
  w.labs.get('trial').fingerprint = 'fp-other';
  assert.equal((await s.bind(TOKEN, 'parent', 'trial', uuid(5))).status, 409);
  w.labs.get('trial').fingerprint = 'fp-same';
  assert.equal(w.data.size, 0);
  const bound = await s.bind(TOKEN, 'parent', 'trial', uuid(6));
  assert.equal(bound.bindingId, uuid(6));
  assert.equal(bound.parentId, 'parent');
  assert.equal(bound.trialId, 'trial');
  assert.equal(bound.sandboxId, 'box-trial');
  assert.equal(bound.configFingerprint, 'fp-same');
  assert.equal(bound.closed, false);
  assert.equal(bound.sessionId === uuid(6), false);
  assert.match(bound.sessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.deepEqual(await s.status(TOKEN, 'parent'), { binding: bound });
  assert.deepEqual(w.audit, [['lab-trial-bind', 'parent trial']]);
});

await test('reservation is exclusive and a trial cannot nest', async () => {
  const w = world(), s = w.make();
  w.add('other');
  w.add('child');
  const bound = await s.bind(TOKEN, 'parent', 'trial', uuid(1));
  assert.equal((await s.bind(TOKEN, 'other', 'trial', uuid(2))).status, 409);
  assert.equal(w.data.get(M.trialBindingKey('other')), undefined);
  assert.equal((await s.bind(TOKEN, 'trial', 'child', uuid(3))).status, 409);
  assert.equal((await s.bind(TOKEN, 'child', 'parent', uuid(4))).status, 409);
  assert.equal(bindRow(w).bindingId, bound.bindingId);
  assert.deepEqual(await s.reserved('trial'), { parentId: 'parent', trialId: 'trial', bindingId: bound.bindingId });
  assert.equal(await s.reserved('child'), null);
});

await test('same request replays and a different trial conflicts', async () => {
  const w = world(), s = w.make();
  w.add('other');
  const bound = await s.bind(TOKEN, 'parent', 'trial', uuid(1));
  assert.deepEqual(await s.bind(TOKEN, 'parent', 'trial', uuid(1)), bound);
  assert.equal(bindRow(w).requests.length, 1);
  const conflict = await s.bind(TOKEN, 'parent', 'other', uuid(1));
  assert.equal(conflict.status, 409);
  assert.equal(bindRow(w).trialId, 'trial');
  assert.equal(bindRow(w).sessionId, bound.sessionId);
  assert.equal(w.data.has(M.trialReserveKey('other')), false);
});

await test('selecting the same active trial keeps the session', async () => {
  const w = world(), s = w.make();
  const bound = await s.bind(TOKEN, 'parent', 'trial', uuid(1));
  w.labs.get('trial').eligible = false;
  const again = await s.bind(TOKEN, 'parent', 'trial', uuid(2));
  assert.deepEqual(again, bound);
  assert.equal(bindRow(w).sessionId, bound.sessionId);
  assert.equal(bindRow(w).requests.length, 2);
  assert.equal(w.audit.length, 1);
});

await test('an expired prior child can be replaced without releasing its reservation', async () => {
  const w = world(), s = w.make();
  w.add('next');
  const first = await s.bind(TOKEN, 'parent', 'trial', uuid(1));
  w.time = w.labs.get('trial').expiresAt;
  assert.equal((await s.bind(TOKEN, 'parent', 'next', uuid(2))).status, 410);
  w.time = w.labs.get('parent').expiresAt - 3600000;
  w.labs.get('trial').expiresAt = w.time;
  const replaced = await s.bind(TOKEN, 'parent', 'next', uuid(2));
  assert.equal(replaced.trialId, 'next');
  assert.equal(replaced.sandboxId, 'box-next');
  assert.notEqual(replaced.sessionId, first.sessionId);
  assert.equal(bindRow(w).trialId, 'next');
  assert.deepEqual(await s.reserved('trial'), { parentId: 'parent', trialId: 'trial', bindingId: first.bindingId });
  w.labs.get('trial').expiresAt = w.time + 3600000;
  assert.equal((await s.bind(TOKEN, 'parent', 'trial', uuid(3))).status, 409);
  assert.equal(bindRow(w).trialId, 'next');
  w.labs.get('next').endRetry = 1;
  w.add('later');
  const third = await s.bind(TOKEN, 'parent', 'later', uuid(4));
  assert.equal(third.trialId, 'later');
  assert.deepEqual((await s.reserved('next')).bindingId, replaced.bindingId);
});

await test('begin claims once and a pending record stays unknown across restart', async () => {
  const w = world(), s = w.make();
  const bound = await s.bind(TOKEN, 'parent', 'trial', uuid(1));
  assert.equal((await s.begin(TOKEN, 'parent', 'not-a-uuid', COMMAND)).status, 400);
  assert.equal((await s.begin(TOKEN, 'parent', uuid(2), '')).status, 400);
  assert.equal((await s.begin(TOKEN, 'parent', uuid(2), 'a\nb')).status, 400);
  assert.equal((await s.begin(TOKEN, 'parent', uuid(2), 'a\tb')).status, 400);
  assert.equal((await s.begin(TOKEN, 'parent', uuid(2), 'a'.repeat(4097))).status, 400);
  const claimed = await s.begin(TOKEN, 'parent', uuid(2), COMMAND);
  assert.equal(claimed.claimed, true);
  assert.equal(claimed.runId, uuid(2));
  assert.deepEqual(claimed.binding, bound);
  const stored = w.data.get(M.trialRunKey('parent', uuid(2)));
  assert.equal(stored.delivery, 'pending');
  assert.equal(stored.commandHash, await sha(COMMAND));
  assert.equal(Object.hasOwn(stored, 'command'), false);
  const replay = await s.begin(TOKEN, 'parent', uuid(2), COMMAND);
  assert.deepEqual(replay, { claimed: false, runId: uuid(2), delivery: 'unknown' });
  assert.equal(w.data.get(M.trialRunKey('parent', uuid(2))).delivery, 'pending');
  const revived = await w.make().begin(TOKEN, 'parent', uuid(2), COMMAND);
  assert.deepEqual(revived, { claimed: false, runId: uuid(2), delivery: 'unknown' });
  assert.equal([...w.data.keys()].filter((k) => k.startsWith('labtrial:run:')).length, 1);
});

await test('a changed command conflicts and the hundredth run is the last', async () => {
  const w = world(), s = w.make();
  await s.bind(TOKEN, 'parent', 'trial', uuid(1));
  const first = await s.begin(TOKEN, 'parent', uuid(2), COMMAND);
  assert.equal((await s.begin(TOKEN, 'parent', uuid(2), COMMAND + ' x')).status, 409);
  assert.equal(w.data.get(M.trialRunKey('parent', uuid(2))).commandHash, await sha(COMMAND));
  assert.equal(first.claimed, true);
  for (let n = 3; n <= 101; n++) assert.equal((await s.begin(TOKEN, 'parent', uuid(n), `step ${n}`)).claimed, true);
  assert.equal((await s.begin(TOKEN, 'parent', uuid(102), 'overflow')).status, 429);
  assert.equal([...w.data.keys()].filter((k) => k.startsWith('labtrial:run:')).length, 100);
  assert.deepEqual(await s.begin(TOKEN, 'parent', uuid(2), COMMAND), { claimed: false, runId: uuid(2), delivery: 'unknown' });
});

await test('sent proof matches the current binding and expires or breaks with the child', async () => {
  const w = world(), s = w.make();
  const bound = await s.bind(TOKEN, 'parent', 'trial', uuid(1));
  await s.begin(TOKEN, 'parent', uuid(2), COMMAND);
  assert.equal((await s.proof(TOKEN, 'parent', uuid(2))).status, 409);
  assert.equal((await s.finish('parent', uuid(9), 'sent')).status, 404);
  assert.equal((await s.finish('parent', uuid(2), 'pending')).status, 400);
  const recorded = await s.finish('parent', uuid(2), 'sent');
  assert.deepEqual(recorded, { runId: uuid(2), delivery: 'sent' });
  assert.equal((await s.finish('parent', uuid(2), 'error')).status, 409);
  assert.equal(w.data.get(M.trialRunKey('parent', uuid(2))).delivery, 'sent');
  assert.deepEqual(await s.begin(TOKEN, 'parent', uuid(2), COMMAND), { claimed: false, runId: uuid(2), delivery: 'sent' });
  const proof = await s.proof(TOKEN, 'parent', uuid(2));
  assert.deepEqual(proof, { commandHash: await sha(COMMAND), configFingerprint: bound.configFingerprint, expiresAt: w.time + 5 * 60 * 1000 });
  w.time += 5 * 60 * 1000 - 1;
  assert.equal((await s.proof(TOKEN, 'parent', uuid(2))).commandHash, proof.commandHash);
  w.time += 1;
  assert.equal((await s.proof(TOKEN, 'parent', uuid(2))).status, 410);
  w.time -= 1;
  w.labs.get('trial').fingerprint = 'fp-changed';
  assert.equal((await s.status(TOKEN, 'parent')).status, 409);
  assert.equal((await s.proof(TOKEN, 'parent', uuid(2))).status, 409);
  w.labs.get('trial').fingerprint = 'fp-same';
  w.labs.get('trial').seats = [{ n: 1, sandboxId: 'box-replaced' }];
  assert.equal((await s.proof(TOKEN, 'parent', uuid(2))).status, 409);
  assert.equal((await s.begin(TOKEN, 'parent', uuid(3), COMMAND)).status, 409);
  w.labs.get('trial').seats = [{ n: 1, sandboxId: 'box-trial' }];
  w.labs.get('trial').expiresAt = w.time;
  assert.equal((await s.status(TOKEN, 'parent')).status, 410);
  assert.equal((await s.proof(TOKEN, 'parent', uuid(2))).status, 410);
});

await test('close beats an in-flight begin and survives reconstruction', async () => {
  const w = world(), s = w.make();
  const bound = await s.bind(TOKEN, 'parent', 'trial', uuid(1));
  await s.begin(TOKEN, 'parent', uuid(2), COMMAND);
  const gate = w.arm(1);
  const pending = s.begin(TOKEN, 'parent', uuid(3), COMMAND);
  await until(() => w.hits() >= 1);
  const closed = await s.close('parent');
  assert.deepEqual(closed, { trialId: 'trial' });
  gate.release();
  const late = await pending;
  assert.equal(late.status, 410);
  assert.equal(w.data.has(M.trialRunKey('parent', uuid(3))), false);
  assert.equal(bindRow(w).closed, true);
  assert.equal((await s.finish('parent', uuid(2), 'sent')).status, 410);
  assert.equal(w.data.get(M.trialRunKey('parent', uuid(2))).delivery, 'pending');
  const revived = w.make();
  assert.equal((await revived.bind(TOKEN, 'parent', 'trial', uuid(4))).status, 410);
  assert.equal((await revived.begin(TOKEN, 'parent', uuid(5), COMMAND)).status, 410);
  assert.equal((await revived.proof(TOKEN, 'parent', uuid(2))).status, 410);
  assert.deepEqual(await revived.reserved('trial'), { parentId: 'parent', trialId: 'trial', bindingId: bound.bindingId });
  assert.deepEqual(await revived.close('parent'), { trialId: 'trial' });
  assert.equal(dump(w).includes(TOKEN), false);
  assert.equal(dump(w).includes('student-output'), false);
  assert.equal(dump(w).includes('/tmp'), false);
});

await test('admin revoked during metadata lookup does not write', async () => {
  const w = world(), s = w.make();
  const gate = w.arm(3);
  const pending = s.bind(TOKEN, 'parent', 'trial', uuid(1));
  await until(() => w.hits() >= 3);
  w.allow = false;
  gate.release();
  const denied = await pending;
  assert.equal(denied.status, 401);
  assert.equal(w.data.size, 0);
  assert.equal(w.audit.length, 0);
});

await test('storage failures do not echo exception text', async () => {
  const w = world(), s = w.make();
  w.storage.failGet = true;
  const status = await s.status(TOKEN, 'parent');
  assert.equal(status.status, 503);
  assert.equal(JSON.stringify(status).includes('secret'), false);
  assert.equal(JSON.stringify(status).includes(TOKEN), false);
  w.storage.failGet = false;
  w.storage.failPut = true;
  const bound = await s.bind(TOKEN, 'parent', 'trial', uuid(1));
  assert.equal(bound.status, 503);
  assert.equal(JSON.stringify(bound).includes('secret'), false);
  assert.equal(JSON.stringify(bound).includes(TOKEN), false);
  assert.equal(w.data.size, 0);
});

console.log(`${pass} lab trial service scenarios passed`);
