// 실습실 개설 요청 푸시 서비스. 네트워크·브라우저 없이 가짜 저장소·시계·send 로만 본다.
//   node test/lab-open-push-service.mjs
import assert from 'node:assert/strict';
import { createHash, randomBytes, createECDH } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const bundle = await build({
  entryPoints: [join(ROOT, 'src/lab-open-push-service.ts')],
  bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent',
});
const M = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const { LabOpenPushService, LAB_OPEN_PUSH_PAYLOAD, LAB_OPEN_PUSH_SUB_PREFIX, LAB_OPEN_PUSH_JOB_PREFIX } = M;

globalThis.fetch = () => { throw new Error('network forbidden'); };
const tick = () => new Promise((r) => setImmediate(r));
const als = new AsyncLocalStorage();
const inTxn = () => als.getStore()?.txn === true;
const b64u = (b) => Buffer.from(b).toString('base64url');
const sha = (s) => createHash('sha256').update(s).digest('base64url');
const PAYLOAD = { title: '공부방 실습실', body: '실습실 개설 요청이 있습니다. 요청함에서 확인하세요.', url: '/lab', tag: 'lab-open-request' };
const H8 = 8 * 3600e3;
const LEASE = 60_000;
const REMIND = 15 * 60_000;
const HOUR = 60 * 60_000;
const DAY = 24 * 60 * 60_000;

function newSub(tag = randomBytes(8).toString('hex'), host = 'https://fcm.googleapis.com/fcm/send') {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    endpoint: `${host}/${tag}`,
    expirationTime: null,
    keys: { p256dh: b64u(ecdh.getPublicKey()), auth: b64u(randomBytes(16)) },
  };
}
function rekey(sub) {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { endpoint: sub.endpoint, keys: { p256dh: b64u(ecdh.getPublicKey()), auth: b64u(randomBytes(16)) } };
}
const secretsOf = (sub) => [sub.endpoint, sub.keys.p256dh, sub.keys.auth];

function memory() {
  const data = new Map();
  let chain = Promise.resolve();
  const clone = (v) => v === undefined ? undefined : structuredClone(v);
  const kv = {
    async get(k) {
      await tick();
      if (typeof k !== 'string') throw new Error('array get is not used');
      return clone(data.get(k));
    },
    async put(k, v) { await tick(); data.set(k, clone(v)); },
    async delete(k) {
      await tick();
      for (const x of Array.isArray(k) ? k : [k]) data.delete(x);
    },
    async list({ prefix = '' } = {}) {
      await tick();
      return new Map([...data.keys()].filter((k) => k.startsWith(prefix)).sort().map((k) => [k, clone(data.get(k))]));
    },
  };
  return {
    data, kv,
    async transaction(fn) {
      const run = chain.then(() => als.run({ txn: true }, () => fn(kv)));
      chain = run.then(() => {}, () => {});
      return run;
    },
  };
}

function harness(extra = {}) {
  const store = memory();
  const creds = new Set(extra.creds ?? ['cred-a']);
  const state = {
    t: 1_800_000_000_000,
    ids: ['req-secret-42'],
    vapid: { publicKey: 'app-server-key', privateKey: { type: 'secret' } },
    schedules: [],
    calls: [],
    fetches: 0,
    aads: [],
    io: [],
  };
  const touch = (name) => {
    if (inTxn()) throw new Error(`io in txn: ${name}`);
    state.io.push(name);
  };
  const master = crypto.subtle.importKey('raw', randomBytes(32), 'AES-GCM', false, ['encrypt', 'decrypt']);
  const seal = async (aad, text) => {
    touch('seal');
    state.aads.push(aad);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(aad) },
      await master, new TextEncoder().encode(text),
    ));
    return { iv: b64u(iv), ct: b64u(ct) };
  };
  const open = async (aad, iv, ct) => {
    touch('open');
    try {
      const pt = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: Buffer.from(iv, 'base64url'), additionalData: new TextEncoder().encode(aad) },
        await master, Buffer.from(ct, 'base64url'),
      );
      return new TextDecoder().decode(pt);
    } catch { return null; }
  };
  let sendImpl = async (sub, key, payload, opts) => {
    state.calls.push({ sub, key, payload, beforeSend: typeof opts?.beforeSend });
    const ok = opts?.beforeSend ? await opts.beforeSend() : false;
    if (!ok) return { outcome: 'failed' };
    state.fetches++;
    return { outcome: 'accepted', status: 201 };
  };
  const deps = {
    storage: {
      get: (...a) => store.kv.get(...a),
      put: (...a) => store.kv.put(...a),
      delete: (...a) => store.kv.delete(...a),
      list: (...a) => store.kv.list(...a),
      transaction: (fn) => store.transaction(fn),
    },
    now: () => { touch('now'); return state.t; },
    credentialExists: async (id) => { touch('credentialExists'); return creds.has(id); },
    vapid: async () => { touch('vapid'); return state.vapid; },
    seal, open,
    schedule: async (t) => { touch('schedule'); state.schedules.push(t); },
    pending: async () => { touch('pending'); return state.ids.slice(); },
    send: (...a) => { touch('send'); return sendImpl(...a); },
  };
  const make = () => new LabOpenPushService(deps);
  return {
    state, creds, store, deps, make, svc: make(), open, seal,
    set send(fn) { sendImpl = fn; },
  };
}

const dump = (store) => JSON.stringify([...store.data.entries()]);
const leaks = (value, secrets) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return secrets.filter((s) => s && text.includes(s));
};
const keysOf = (value, out = []) => {
  if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) { out.push(k); keysOf(v, out); }
  return out;
};
const FORBIDDEN_KEYS = /deliver|receiv|endpoint|p256dh|auth|secret|cookie|expiresAt|privateKey/i;
async function until(fn) { const end=Date.now()+5000; while(!fn()&&Date.now()<end)await tick(); assert.ok(fn(),'async fixture reached the expected send stage'); }

const subKeys = new Set(['deviceId', 'generation', 'credentialId', 'label', 'iv', 'ct', 'at', 'lastAttemptAt', 'lastOutcome', 'testAcknowledgedAt', 'needsReregistration']);
const jobKeys = new Set(['deviceId', 'generation', 'credentialId', 'version', 'openedAt', 'due', 'attempts', 'leaseUntil', 'leaseToken', 'accepts', 'exhausted']);

function assertStoredShape(store) {
  for (const [key, value] of store.data) {
    assert.equal(typeof value, 'object');
    const allowed = key.startsWith(LAB_OPEN_PUSH_SUB_PREFIX) ? subKeys : jobKeys;
    assert.ok(key.startsWith(LAB_OPEN_PUSH_SUB_PREFIX) || key.startsWith(LAB_OPEN_PUSH_JOB_PREFIX), key);
    for (const k of Object.keys(value)) assert.ok(allowed.has(k), k);
    assert.equal('expiresAt' in value, false);
    assert.equal('endpoint' in value, false);
    assert.equal('keys' in value, false);
  }
}

let step = 0;
const test = async (name, fn) => {
  step++;
  await fn();
  console.log(`ok ${step} ${name}`);
};

await test('고정 페이로드와 해시 deviceId, 봉인 저장에 평문 endpoint·키가 없다', async () => {
  assert.deepEqual(LAB_OPEN_PUSH_PAYLOAD, PAYLOAD);
  const h = harness();
  const sub = newSub('phone-a');
  const label = '교실 폰';
  const reg = await h.svc.register('cred-a', { ...sub, expirationTime: 1, extra: true }, label);
  assert.deepEqual(Object.keys(reg).sort(), ['deviceId', 'ok']);
  assert.equal(reg.ok, true);
  assert.equal(reg.deviceId, sha(sub.endpoint));
  assert.deepEqual(h.state.schedules, [h.state.t]);
  const rec = h.store.data.get(LAB_OPEN_PUSH_SUB_PREFIX + reg.deviceId);
  assert.equal(rec.credentialId, 'cred-a');
  assert.equal(rec.label, label);
  assert.equal('expiresAt' in rec, false);
  assert.notEqual(rec.iv, sub.endpoint);
  const found = leaks(dump(h.store), secretsOf(sub).concat(['req-secret-42']));
  assert.deepEqual(found, []);
  const aad = h.state.aads[0];
  assert.equal(aad, `labopen:pushsub:${reg.deviceId}:${rec.generation}:cred-a`);
  assert.equal(await h.open(aad, rec.iv, rec.ct) !== null, true);
  assert.equal(await h.open(aad + ':nope', rec.iv, rec.ct), null);
  assert.equal(await h.open(`teacher-push:${reg.deviceId}`, rec.iv, rec.ct), null);
  const cfg = await h.svc.config();
  const listed = await h.svc.devices();
  const st = await h.svc.status(sub.endpoint);
  const safe = [reg, cfg, listed, st];
  assert.deepEqual(leaks(safe, secretsOf(sub).concat(['cred-a', 'req-secret-42'])), []);
  assert.deepEqual(keysOf(safe).filter((k) => FORBIDDEN_KEYS.test(k)), []);
  assert.equal(st.enabled, true);
  assert.equal(st.deviceId, reg.deviceId);
  assert.equal(st.label, label);
  assert.equal(st.testAcknowledgedAt, undefined);
  assert.equal(listed.available, true);
  assert.equal(listed.devices.length, 1);
  assert.deepEqual(Object.keys(listed.devices[0]).sort(), ['deviceId', 'label']);
  assertStoredShape(h.store);
});

await test('같은 기기·같은 키는 세대를 유지하고, 주인이나 키가 바뀌면 세대를 갈아탄다', async () => {
  const h = harness();
  h.creds.add('cred-b');
  const sub = newSub('same');
  const a = await h.svc.register('cred-a', sub, '폰');
  const gen = h.store.data.get(LAB_OPEN_PUSH_SUB_PREFIX + a.deviceId).generation;
  const seals = h.state.aads.length;
  const again = await h.svc.register('cred-a', sub, '폰');
  assert.equal(again.deviceId, a.deviceId);
  assert.equal(h.store.data.get(LAB_OPEN_PUSH_SUB_PREFIX + a.deviceId).generation, gen);
  assert.equal(h.state.aads.length, seals);
  const renamed = await h.svc.register('cred-a', sub, '앞자리');
  assert.equal(renamed.deviceId, a.deviceId);
  assert.equal(h.store.data.get(LAB_OPEN_PUSH_SUB_PREFIX + a.deviceId).generation, gen);
  assert.equal(h.store.data.get(LAB_OPEN_PUSH_SUB_PREFIX + a.deviceId).label, '앞자리');
  const nextSub = rekey(sub);
  const changed = await h.svc.register('cred-a', nextSub, '앞자리');
  const gen2 = h.store.data.get(LAB_OPEN_PUSH_SUB_PREFIX + a.deviceId).generation;
  assert.equal(changed.deviceId, a.deviceId);
  assert.notEqual(gen2, gen);
  const owned = await h.svc.register('cred-b', nextSub, '다른 주인');
  assert.equal(owned.deviceId, a.deviceId);
  assert.notEqual(h.store.data.get(LAB_OPEN_PUSH_SUB_PREFIX + a.deviceId).generation, gen2);
  assert.equal(h.store.data.get(LAB_OPEN_PUSH_SUB_PREFIX + a.deviceId).credentialId, 'cred-b');
  assert.equal(new Set(h.state.aads).size, h.state.aads.length);
});

await test('라벨·호스트·상한·자격 증명 재확인', async () => {
  const h = harness();
  const sub = newSub('cap');
  assert.equal((await h.svc.register('cred-a', sub, '가'.repeat(41))).status, 400);
  assert.equal((await h.svc.register('cred-a', sub, '줄\n바꿈')).status, 400);
  assert.equal((await h.svc.register('cred-a', sub, '탭\t문자')).status, 400);
  assert.equal((await h.svc.register('cred-a', sub, '널\u0000문자')).status, 400);
  assert.equal(h.store.data.size, 0);
  const okLabel = await h.svc.register('cred-a', sub, '가'.repeat(40));
  assert.equal(okLabel.ok, true);
  const evil = 'https://evil.fcm.googleapis.com/fcm/send/' + 'z'.repeat(40);
  const bad = await h.svc.register('cred-a', { endpoint: evil, keys: sub.keys }, '폰');
  assert.equal(bad.status, 400);
  assert.deepEqual(leaks(bad, [evil, sub.keys.auth, sub.keys.p256dh]), []);
  assert.equal((await h.svc.status(evil)).status, 400);
  assert.deepEqual(await h.svc.status('https://fcm.googleapis.com/fcm/send/missing-device'), { enabled: false });
  for (const host of ['https://updates.push.services.mozilla.com/wpush/v2', 'https://web.push.apple.com/Q']) {
    h.creds.add('cred-a');
    const s = newSub(host.slice(-6), host);
    assert.equal((await h.svc.register('cred-a', s, '다른 브라우저')).ok, true);
  }
  const made = [];
  for (let i = 0; i < 5; i++) {
    const s = newSub('more-' + i);
    made.push(s);
    assert.equal((await h.svc.register('cred-a', s, '기기' + i)).ok, true);
  }
  const ninth = newSub('ninth');
  const full = await h.svc.register('cred-a', ninth, '거절');
  assert.equal(full.status, 429);
  assert.equal(h.store.data.has(LAB_OPEN_PUSH_SUB_PREFIX + sha(ninth.endpoint)), false);
  assert.equal([...h.store.data.keys()].filter((k) => k.startsWith(LAB_OPEN_PUSH_SUB_PREFIX)).length, 8);
  h.creds.delete('cred-a');
  h.creds.add('cred-b');
  const freed = await h.svc.register('cred-b', ninth, '빈 자리');
  assert.equal(freed.ok, true);
  assert.equal([...h.store.data.keys()].filter((k) => k.startsWith(LAB_OPEN_PUSH_SUB_PREFIX)).length, 1);
  const gone = await h.svc.register('cred-a', sub, '없음');
  assert.equal(gone.status, 403);
  assert.deepEqual(leaks(gone, secretsOf(sub)), []);
});

await test('봉인 직후 자격 증명이 사라지면 기기를 남기지 않는다', async () => {
  const h = harness();
  const sub = newSub('race');
  const real = h.seal;
  h.deps.seal = async (aad, text) => {
    h.creds.delete('cred-a');
    return real(aad, text);
  };
  const reg = await h.svc.register('cred-a', sub, '폰');
  assert.equal(reg.status, 403);
  assert.equal(h.store.data.size, 0);
  assert.equal(h.state.schedules.length, 0);
});

await test('기기가 없으면 요청을 잃지 않고, 등록 뒤 알람이 채운다', async () => {
  const h = harness();
  const ids = ['req-secret-42'];
  h.state.ids = ids;
  const next = await h.svc.alarm(h.state.t);
  assert.equal(next, Infinity);
  assert.equal(h.state.fetches, 0);
  assert.deepEqual(ids, ['req-secret-42']);
  assert.equal([...h.store.data.keys()].some((k) => k.startsWith(LAB_OPEN_PUSH_JOB_PREFIX)), false);
  const sub = newSub('later');
  h.state.schedules = [];
  const reg = await h.svc.register('cred-a', sub, '폰');
  assert.deepEqual(h.state.schedules, [h.state.t]);
  const fired = await h.svc.alarm(h.state.t);
  assert.equal(h.state.fetches, 1);
  assert.deepEqual(h.state.calls[0].payload, PAYLOAD);
  assert.equal(h.state.calls[0].beforeSend, 'function');
  assert.equal(fired, h.state.t + REMIND);
  assert.deepEqual(ids, ['req-secret-42']);
  assert.deepEqual(leaks(dump(h.store), secretsOf(sub).concat(ids)), []);
  const st = await h.svc.status(sub.endpoint);
  assert.equal(st.lastOutcome, 'accepted');
  assert.equal(st.testAcknowledgedAt, undefined);
  assert.equal(reg.deviceId, st.deviceId);
  assertStoredShape(h.store);
});

await test('429·503 재시도와 수락, 15분 뒤 1시간 간격, 24시간에 멈춘다', async () => {
  const h = harness();
  const sub = newSub('retry');
  await h.svc.register('cred-a', sub, '폰');
  const delays = [10_000, 30_000, 120_000, 300_000, 600_000, 1_200_000, 2_400_000, 3_600_000, 3_600_000];
  const statuses = [];
  h.send = async (sub0, key, payload, opts) => {
    assert.deepEqual(payload, PAYLOAD);
    const ok = await opts.beforeSend();
    if (!ok) return { outcome: 'failed' };
    h.state.fetches++;
    const status = h.state.fetches % 2 === 1 ? 429 : 503;
    statuses.push(status);
    return { outcome: 'retryable', status };
  };
  let previous = h.state.t;
  for (const delay of delays) {
    const next = await h.svc.alarm(h.state.t);
    assert.equal(next, previous + delay);
    const st = await h.svc.status(sub.endpoint);
    assert.equal(st.lastOutcome, 'retryable');
    assert.equal(st.testAcknowledgedAt, undefined);
    h.state.t = next;
    previous = next;
  }
  assert.deepEqual(statuses, [429, 503, 429, 503, 429, 503, 429, 503, 429]);
  const due = h.state.t;
  h.state.t = due - 1;
  const quiet = await h.svc.alarm(h.state.t);
  assert.equal(h.state.fetches, delays.length);
  assert.equal(quiet, due);
  h.state.t = due;
  h.send = async (sub0, key, payload, opts) => {
    assert.deepEqual(payload, PAYLOAD);
    const ok = await opts.beforeSend();
    if (!ok) return { outcome: 'failed' };
    h.state.fetches++;
    return { outcome: 'accepted', status: 201 };
  };
  const opened = 1_800_000_000_000;
  const acceptedAt = h.state.t;
  const after = await h.svc.alarm(h.state.t);
  assert.equal(after, acceptedAt + REMIND);
  assert.equal((await h.svc.status(sub.endpoint)).lastOutcome, 'accepted');
  assert.equal((await h.svc.status(sub.endpoint)).testAcknowledgedAt, undefined);
  assert.deepEqual(h.state.ids, ['req-secret-42']);
  h.state.t = after - 1;
  assert.equal(await h.svc.alarm(h.state.t), after);
  assert.equal(h.state.fetches, delays.length + 1);
  h.state.t = after;
  const hourly = await h.svc.alarm(h.state.t);
  assert.equal(h.state.fetches, delays.length + 2);
  assert.equal(hourly, h.state.t + HOUR);
  h.state.t = opened + DAY + 1;
  const stopped = await h.svc.alarm(h.state.t);
  assert.equal(stopped, Infinity);
  assert.equal(h.state.fetches, delays.length + 2);
  assert.deepEqual(h.state.ids, ['req-secret-42']);
  assert.equal((await h.svc.status(sub.endpoint)).enabled, true);
});

await test('네트워크 예외는 재시도하고 400 은 재등록이 필요하며 410 은 기기를 지운다', async () => {
  const h = harness();
  const sub = newSub('gone');
  await h.svc.register('cred-a', sub, '폰');
  h.send = async (sub0, key, payload, opts) => {
    const ok = await opts.beforeSend();
    if (!ok) return { outcome: 'failed' };
    h.state.fetches++;
    throw new Error('socket down');
  };
  const retry = await h.svc.alarm(h.state.t);
  assert.equal(retry, h.state.t + 10_000);
  assert.equal(h.state.fetches, 1);
  h.state.t = retry;
  h.send = async (sub0, key, payload, opts) => {
    const ok = await opts.beforeSend();
    if (!ok) return { outcome: 'failed' };
    h.state.fetches++;
    return { outcome: 'failed', status: 400 };
  };
  const failed = await h.svc.alarm(h.state.t);
  assert.equal(failed, Infinity);
  const st = await h.svc.status(sub.endpoint);
  assert.equal(st.enabled, false);
  assert.equal(st.lastOutcome, 'failed');
  assert.equal(st.deviceId, sha(sub.endpoint));
  const before = h.state.fetches;
  assert.equal(await h.svc.alarm(h.state.t + 10_000), Infinity);
  assert.equal(h.state.fetches, before);
  await h.svc.register('cred-a', sub, '폰');
  assert.equal((await h.svc.status(sub.endpoint)).enabled, true);
  h.send = async (sub0, key, payload, opts) => {
    const ok = await opts.beforeSend();
    if (!ok) return { outcome: 'failed' };
    h.state.fetches++;
    return { outcome: 'gone', status: 410 };
  };
  await h.svc.alarm(h.state.t);
  assert.deepEqual(await h.svc.status(sub.endpoint), { enabled: false });
  assert.equal(h.store.data.has(LAB_OPEN_PUSH_SUB_PREFIX + sha(sub.endpoint)), false);
  const fetches = h.state.fetches;
  assert.equal(await h.svc.alarm(h.state.t), Infinity);
  assert.equal(h.state.fetches, fetches);
  assert.deepEqual(h.state.ids, ['req-secret-42']);
});

await test('자격 증명이 없으면 보내지 않고 요청은 남는다', async () => {
  const h = harness();
  const sub = newSub('cred-gone');
  await h.svc.register('cred-a', sub, '폰');
  h.creds.delete('cred-a');
  const next = await h.svc.alarm(h.state.t);
  assert.equal(next, Infinity);
  assert.equal(h.state.fetches, 0);
  assert.equal(h.store.data.has(LAB_OPEN_PUSH_SUB_PREFIX + sha(sub.endpoint)), false);
  assert.deepEqual(h.state.ids, ['req-secret-42']);
  h.creds.add('cred-a');
  await h.svc.register('cred-a', sub, '폰');
  h.send = async (sub0, key, payload, opts) => {
    h.creds.delete('cred-a');
    const ok = await opts.beforeSend();
    if (!ok) return { outcome: 'failed' };
    h.state.fetches++;
    return { outcome: 'accepted', status: 201 };
  };
  await h.svc.alarm(h.state.t);
  assert.equal(h.state.fetches, 0);
  assert.equal(h.store.data.has(LAB_OPEN_PUSH_SUB_PREFIX + sha(sub.endpoint)), false);
  assert.deepEqual(h.state.ids, ['req-secret-42']);
});

await test('세대가 바뀌면 진행 중 보내기를 멈추고 새 세대만 보낸다', async () => {
  const h = harness();
  const sub = newSub('gen');
  await h.svc.register('cred-a', sub, '폰');
  const firstGen = h.store.data.get(LAB_OPEN_PUSH_SUB_PREFIX + sha(sub.endpoint)).generation;
  h.send = async (sub0, key, payload, opts) => {
    assert.deepEqual(payload, PAYLOAD);
    await h.svc.register('cred-a', rekey(sub), '폰');
    const ok = await opts.beforeSend();
    if (!ok) return { outcome: 'failed' };
    h.state.fetches++;
    return { outcome: 'accepted', status: 201 };
  };
  await h.svc.alarm(h.state.t);
  assert.equal(h.state.fetches, 0);
  const gen = h.store.data.get(LAB_OPEN_PUSH_SUB_PREFIX + sha(sub.endpoint)).generation;
  assert.notEqual(gen, firstGen);
  h.send = async (sub0, key, payload, opts) => {
    const ok = await opts.beforeSend();
    if (!ok) return { outcome: 'failed' };
    h.state.fetches++;
    return { outcome: 'accepted', status: 201 };
  };
  await h.svc.alarm(h.state.t);
  assert.equal(h.state.fetches, 1);
  assert.equal((await h.svc.status(sub.endpoint)).enabled, true);
});

await test('테스트 알림도 세대를 확인하고 대기 요청 없이는 보낸다', async () => {
  const h = harness();
  h.creds.add('cred-b');
  h.state.ids = [];
  const sub = newSub('probe');
  await h.svc.register('cred-a', sub, '폰');
  const denied = await h.svc.test('cred-b', sub.endpoint);
  assert.equal(denied.status, 404);
  assert.equal(h.state.fetches, 0);
  h.send = async (sub0, key, payload, opts) => {
    assert.deepEqual(payload, PAYLOAD);
    assert.deepEqual(Object.keys(payload).sort(), ['body', 'tag', 'title', 'url']);
    await h.svc.register('cred-a', rekey(sub), '폰');
    const ok = await opts.beforeSend();
    if (!ok) return { outcome: 'failed' };
    h.state.fetches++;
    return { outcome: 'accepted', status: 201 };
  };
  const failed = await h.svc.test('cred-a', sub.endpoint);
  assert.deepEqual(failed, { outcome: 'failed' });
  assert.equal(h.state.fetches, 0);
  assert.equal((await h.svc.status(sub.endpoint)).testAcknowledgedAt, undefined);
  h.send = async (sub0, key, payload, opts) => {
    const ok = await opts.beforeSend();
    if (!ok) return { outcome: 'failed' };
    h.state.fetches++;
    return { outcome: 'accepted', status: 202 };
  };
  const sent = await h.svc.testRegistered(sub.endpoint);
  assert.deepEqual(sent, { outcome: 'accepted', status: 202 });
  const st = await h.svc.status(sub.endpoint);
  assert.equal(st.lastOutcome, 'accepted');
  assert.equal(st.testAcknowledgedAt, undefined);
  assert.deepEqual(h.state.ids, []);
  h.creds.delete('cred-a');
  assert.equal((await h.svc.testRegistered(sub.endpoint)).status, 403);
});

await test('폰에서 눌렀을 때만 수신 시각이 생기고 수락으로는 생기지 않는다', async () => {
  const h = harness();
  const sub = newSub('ack');
  await h.svc.register('cred-a', sub, '폰');
  await h.svc.alarm(h.state.t);
  const accepted = await h.svc.status(sub.endpoint);
  assert.equal(accepted.lastOutcome, 'accepted');
  assert.equal(accepted.testAcknowledgedAt, undefined);
  assert.equal(Object.hasOwn(accepted, 'testAcknowledgedAt'), false);
  const at = h.state.t + 5000;
  h.state.t = at;
  assert.deepEqual(await h.svc.acknowledgeTest(sub.endpoint), { ok: true });
  const human = await h.svc.status(sub.endpoint);
  assert.equal(human.testAcknowledgedAt, at);
  h.state.t = at + REMIND;
  await h.svc.alarm(h.state.t);
  const later = await h.svc.status(sub.endpoint);
  assert.equal(later.testAcknowledgedAt, at);
  assert.equal(later.lastAttemptAt, h.state.t);
  assert.notEqual(later.lastAttemptAt, later.testAcknowledgedAt);
  assert.deepEqual(keysOf(later).filter((k) => FORBIDDEN_KEYS.test(k)), []);
});

await test('요청이 여러 개여도 기기당 알림 하나이고 알람마다 최대 4번이다', async () => {
  const h = harness();
  h.state.ids = ['req-c', 'req-a', 'req-a', 'req-b'];
  const subs = [];
  for (let i = 0; i < 6; i++) {
    const sub = newSub('batch-' + i);
    subs.push(sub);
    assert.equal((await h.svc.register('cred-a', sub, '기기' + i)).ok, true);
  }
  const first = await h.svc.alarm(h.state.t);
  assert.equal(h.state.fetches, 4);
  assert.equal(first, h.state.t);
  assert.equal(h.state.calls.length, 4);
  for (const call of h.state.calls) assert.deepEqual(call.payload, PAYLOAD);
  const second = await h.svc.alarm(h.state.t);
  assert.equal(h.state.fetches, 6);
  assert.equal(second, h.state.t + REMIND);
  assert.equal([...h.store.data.keys()].filter((k) => k.startsWith(LAB_OPEN_PUSH_JOB_PREFIX)).length, 6);
  const fetches = h.state.fetches;
  h.state.ids = ['req-b', 'req-c', 'req-a'];
  assert.equal(await h.svc.alarm(h.state.t), h.state.t + REMIND);
  assert.equal(h.state.fetches, fetches);
  h.state.ids = ['req-a', 'req-new'];
  await h.svc.alarm(h.state.t);
  assert.equal(h.state.fetches, fetches + 4);
  await h.svc.alarm(h.state.t);
  assert.equal(h.state.fetches, fetches + 6);
  assert.deepEqual(leaks(dump(h.store), subs.flatMap(secretsOf).concat(['req-a', 'req-new', 'req-secret'])), []);
  assertStoredShape(h.store);
});

await test('같은 알람을 겹쳐 불러도 한 번만 보내고 재시작은 임차를 지킨다', async () => {
  const h = harness();
  const sub = newSub('lease');
  await h.svc.register('cred-a', sub, '폰');
  let release;
  const gate = new Promise((r) => { release = r; });
  let entered = 0;
  h.send = async (sub0, key, payload, opts) => {
    const ok = await opts.beforeSend();
    if (!ok) return { outcome: 'failed' };
    h.state.fetches++;
    entered++;
    if (entered === 1) await gate;
    return { outcome: 'accepted', status: 201 };
  };
  const first = h.svc.alarm(h.state.t);
  await until(() => entered === 1);
  const overlap = await h.svc.alarm(h.state.t);
  assert.equal(h.state.fetches, 1);
  assert.equal(overlap, h.state.t + LEASE);
  const restarted = h.make();
  const during = await restarted.alarm(h.state.t);
  assert.equal(h.state.fetches, 1);
  assert.equal(during, h.state.t + LEASE);
  release();
  await first;
  assert.equal(h.state.fetches, 1);
  assert.equal(await restarted.alarm(h.state.t), h.state.t + REMIND);
  assert.equal(h.state.fetches, 1);
  let releaseCrash;
  const crashGate = new Promise((r) => { releaseCrash = r; });
  entered = 0;
  h.send = async (sub0, key, payload, opts) => {
    const ok = await opts.beforeSend();
    if (!ok) return { outcome: 'failed' };
    h.state.fetches++;
    entered++;
    if (entered === 1) await crashGate;
    return { outcome: 'retryable', status: 503 };
  };
  h.state.t += REMIND;
  const crashed = h.make().alarm(h.state.t);
  await until(() => entered === 1);
  const held = h.state.t;
  h.state.t = held + LEASE;
  assert.equal(h.state.fetches, 2);
  const retry = h.make();
  await retry.alarm(h.state.t);
  assert.equal(h.state.fetches, 3);
  releaseCrash();
  await crashed;
  assert.equal(h.state.fetches, 3);
  const job = [...h.store.data.entries()].find(([k]) => k.startsWith(LAB_OPEN_PUSH_JOB_PREFIX))[1];
  assert.equal(job.leaseToken, '');
  assert.equal(job.attempts >= 1, true);
  assert.deepEqual(h.state.ids, ['req-secret-42']);
});

await test('삭제 전에 시작한 보내기는 끝날 수 있고 그 기기의 다음 보내기는 없다', async () => {
  const h = harness();
  const keep = newSub('keep');
  const drop = newSub('drop');
  await h.svc.register('cred-a', keep, '남김');
  await h.svc.register('cred-a', drop, '삭제');
  let release;
  const gate = new Promise((r) => { release = r; });
  const seen = [];
  h.send = async (sub0, key, payload, opts) => {
    const ok = await opts.beforeSend();
    if (!ok) return { outcome: 'failed' };
    seen.push(sub0.endpoint);
    h.state.fetches++;
    if (sub0.endpoint === drop.endpoint) await gate;
    return { outcome: 'accepted', status: 201 };
  };
  const pending = h.svc.alarm(h.state.t);
  await until(() => seen.includes(drop.endpoint));
  assert.deepEqual(await h.svc.remove(drop.endpoint), { ok: true });
  assert.equal(h.store.data.has(LAB_OPEN_PUSH_SUB_PREFIX + sha(drop.endpoint)), false);
  release();
  await pending;
  assert.equal(seen.includes(drop.endpoint), true);
  const fetches = h.state.fetches;
  h.state.ids = ['req-secret-42', 'req-next'];
  await h.svc.alarm(h.state.t);
  await h.svc.alarm(h.state.t);
  assert.equal(seen.filter((e) => e === drop.endpoint).length, 1);
  assert.equal(h.state.fetches > fetches, true);
  assert.equal((await h.svc.status(keep.endpoint)).enabled, true);
  assert.deepEqual(await h.svc.status(drop.endpoint), { enabled: false });
  const listed = await h.svc.devices();
  assert.deepEqual(listed.devices.map((d) => d.deviceId), [sha(keep.endpoint)]);
  assert.deepEqual(leaks(listed, secretsOf(drop).concat(secretsOf(keep))), []);
});

await test('8시간이 지나도 등록은 남고 승인권은 생기지 않는다', async () => {
  const h = harness();
  const sub = newSub('persist');
  await h.svc.register('cred-a', sub, '폰');
  await h.svc.alarm(h.state.t);
  h.state.t += H8 + 60_000;
  const st = await h.svc.status(sub.endpoint);
  assert.equal(st.enabled, true);
  assert.equal(h.store.data.get(LAB_OPEN_PUSH_SUB_PREFIX + st.deviceId).expiresAt, undefined);
  const before = h.state.ids.slice();
  await h.svc.alarm(h.state.t);
  assert.equal(h.state.fetches, 2);
  assert.deepEqual(h.state.ids, before);
  const blob = dump(h.store);
  assert.equal(blob.includes('approve'), false);
  assert.equal(blob.includes('admin'), false);
  assert.equal(blob.includes('cookie'), false);
  h.state.vapid = null;
  h.state.ids = ['req-still-here'];
  const paused = await h.make().alarm(h.state.t);
  assert.equal(paused, h.state.t + 5 * 60_000);
  assert.equal(h.state.fetches, 2);
  assert.deepEqual(h.state.ids, ['req-still-here']);
  const cfg = await h.svc.config();
  assert.deepEqual(cfg, { available: false });
  assert.equal((await h.svc.devices()).available, false);
});

await test('직렬화한 응답과 저장소에 평문 구독·요청 id 가 없다', async () => {
  const h = harness();
  const many = Array.from({ length: 130 }, (_, i) => `req-${String(i).padStart(3, '0')}`);
  many.push('이름-홍길동');
  h.state.ids = many;
  const sub = newSub('safe');
  const reg = await h.svc.register('cred-a', sub, '폰');
  const cfg = await h.svc.config();
  const testResult = await h.svc.test('cred-a', sub.endpoint);
  const ack = await h.svc.acknowledgeTest(sub.endpoint);
  const removed = await h.svc.remove(sub.endpoint);
  await h.svc.register('cred-a', sub, '폰');
  const alarm = await h.svc.alarm(h.state.t);
  const outputs = [reg, cfg, testResult, ack, removed, alarm, await h.svc.status(sub.endpoint), await h.svc.devices()];
  const secret = secretsOf(sub).concat(['cred-a', '이름-홍길동', 'req-000', 'req-129']);
  assert.deepEqual(leaks(outputs, secret), []);
  // 등록된 보안 키의 공개 식별자는 폐기 확인을 위해 저장한다. 구독 endpoint·키·요청 원문은 저장하지 않는다.
  assert.deepEqual(leaks(dump(h.store), secret.filter(x=>x!=='cred-a')), []);
  assert.deepEqual(keysOf(outputs).filter((k) => FORBIDDEN_KEYS.test(k)), []);
  assert.equal(h.state.fetches <= 2, true);
  assert.equal([...h.store.data.keys()].filter((k) => k.startsWith(LAB_OPEN_PUSH_JOB_PREFIX)).length <= 1, true);
  assertStoredShape(h.store);
});

console.log(`\n${step} tests passed`);
