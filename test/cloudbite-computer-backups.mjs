// CloudBite computer automatic backups (src/cloudbite-computer-backups.ts) against a small in-memory fake provider and
// store. These are test doubles: nothing here is live persistence, a live Daytona snapshot or a quota/cost measurement.
// Pins: stopped-only, storage-only begin/status, intent before mutation, unknown create applied / unconfirmed after 404s
// (owned, blocking, late appearance recovered only by explicit reconcile, never resubmitted), restart without resubmit,
// generated names inside the restore UI's 3-48 rule for every owner tag, ownership proof (missing/mismatch/duplicate id), latest + protected guards, delete 404 confirmation
// and bounded re-sends, retention to 3 verified + 1 replacement, min interval / daily cap, unchanged vs unknown revision.
//   node test/cloudbite-computer-backups.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';

const tmp = mkdtempSync(join(tmpdir(), 'cloudbite-backups-'));
const built = await build({ entryPoints: ['src/cloudbite-computer-backups.ts'], bundle: true, write: false, platform: 'node', format: 'esm' });
writeFileSync(join(tmp, 'm.mjs'), built.outputFiles[0].text);
const M = await import(pathToFileURL(join(tmp, 'm.mjs')));
globalThis.fetch = async (u) => { throw new Error('network forbidden in this test: ' + u); };

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log('ok', name); };

const OWNER = 'owner0001tag';
const H = 3600_000;
const L = M.BACKUP_LIMITS;
/** The restore UI's rule (src/cloudbite-computer-page.ts SNAPSHOT_NAME) and the shared COMPUTER_SNAPSHOT_NAME. */
const UI_SNAPSHOT_NAME = /^[a-z0-9](?:[a-z0-9-]{1,46})[a-z0-9]$/;
const COMPUTER_SNAPSHOT_NAME = /^[a-z0-9][a-z0-9-]{2,62}$/;
const err = (status) => Object.assign(new Error(`HTTP ${status}`), { status });

class MemStore {
  constructor() { this.m = new Map(); this.puts = 0; }
  async get(k) { return this.m.has(k) ? structuredClone(this.m.get(k)) : undefined; }
  async put(k, v) { this.puts++; this.m.set(k, structuredClone(v)); }
  clone() { const s = new MemStore(); for (const [k, v] of this.m) s.m.set(k, structuredClone(v)); return s; }
}

/** Fake provider. Snapshots per account keyed by id; a capture turns active after `buildReads` GETs. */
class FakeProvider {
  constructor() {
    this.acct = new Map(); this.n = 0; this.calls = []; this.buildReads = 1;
    this.createFault = null;   // { status, applied }
    this.removeFault = null;   // { status, applied }
    this.removeTakes = true;   // a 200 DELETE eventually removes
    this.removingReads = 1;    // GETs answering 'removing' before 404
    this.onCreate = null;
    this.mutate = null;        // (snap) => void, applied to a created snapshot
  }
  snaps(a) { if (!this.acct.has(a)) this.acct.set(a, new Map()); return this.acct.get(a); }
  find(a, key) { const s = this.snaps(a); return s.get(key) ?? [...s.values()].find((x) => x.name === key) ?? null; }
  add(a, snap) { this.snaps(a).set(snap.id, snap); return snap; }
  async getSnapshot(a, key) {
    this.calls.push(['get', a, key]);
    if (this.getFault) { const f = this.getFault; this.getFault = null; throw err(f); }
    const s = this.find(a, key); if (!s) return null;
    if (s.state === 'pending' && ++s.reads >= this.buildReads) s.state = s.finalState ?? 'active';
    else if (s.state === 'removing' && ++s.rreads > this.removingReads) { this.snaps(a).delete(s.id); return null; }
    const { reads, rreads, finalState, ...dto } = s; return structuredClone(dto);
  }
  async createSnapshot(a, machineId, name, opts) {
    this.calls.push(['create', a, machineId, name, opts]);
    this.onCreate?.();
    const f = this.createFault; this.createFault = null;
    if (f && !f.applied) throw err(f.status);
    const snap = this.add(a, { id: `snap-${++this.n}`, name, state: 'pending', sourceSandboxId: machineId, general: false, reads: 0, rreads: 0 });
    this.mutate?.(snap);
    if (f) throw err(f.status);
  }
  async removeSnapshot(a, id) {
    this.calls.push(['remove', a, id]);
    const f = this.removeFault; this.removeFault = null;
    const s = this.snaps(a).get(id);
    if (f && !f.applied) throw err(f.status);
    if (!s) return 'absent';
    if (this.removeTakes) { s.state = 'removing'; s.rreads = 0; }
    if (f) throw err(f.status);
    return 'accepted';
  }
  count(op) { return this.calls.filter((c) => c[0] === op).length; }
}

function rig({ protect = [] } = {}) {
  const store = new MemStore(), provider = new FakeProvider();
  const clock = { t: Date.UTC(2026, 9, 19) };
  let seed = 7;
  const deps = { store, provider, now: () => clock.t, random: () => ((seed = (seed * 48271) % 2147483647) / 2147483647),
    protectedNames: () => rig.protectFn ? rig.protectFn() : protect };
  return { store, provider, clock, deps, b: new M.ComputerBackups(deps) };
}
const stopped = (id = 'sb-1', account = 'primary') => ({ id, account, status: 'stopped' });
const begin = (b, machine = stopped(), environmentRevision = null, requestId = randomUUID()) => b.begin(OWNER, { requestId, machine, environmentRevision });
async function untilSettled(b, n = 10) { let s; for (let k = 0; k < n; k++) { s = await b.tick(OWNER); if (!['pending', 'unknown'].includes(s.state) && !s.work) break; } return s; }

await test('non-stopped machine is blocked; begin/status never call the provider', async () => {
  const { b, provider } = rig();
  for (const st of ['running', 'stopping', 'starting']) {
    const s = await begin(b, { id: 'sb-1', account: 'primary', status: st });
    assert.equal(s.state, 'blocked'); assert.equal(s.reason, 'not_stopped');
  }
  assert.equal(await b.status('badtag'), null);
  assert.equal((await begin(b, stopped(), null, 'not-a-uuid')).reason, 'bad_request');
  assert.equal((await b.begin('X', { requestId: randomUUID(), machine: stopped() })).reason, 'bad_request');
  assert.equal(provider.calls.length, 0);
});

await test('stopped end -> intent persisted, tick preflights + one create (includeMemory:false), active only when proven ours', async () => {
  const { b, provider, store } = rig();
  let ledgerAtCreate;
  provider.onCreate = () => { ledgerAtCreate = [...store.m.values()][0]; };
  const s = await begin(b);
  assert.equal(s.state, 'pending'); assert.match(s.name, /^cbak-owner0001tag-[a-z0-9]+-[a-z0-9]{6}$/);
  assert.match(s.name, UI_SNAPSHOT_NAME);
  assert.equal(provider.calls.length, 0, 'begin is storage only');
  assert.deepEqual(await b.status(OWNER), s);
  assert.equal(provider.calls.length, 0, 'status is storage only');
  const t1 = await b.tick(OWNER);
  assert.equal(t1.state, 'pending');
  assert.deepEqual(provider.calls.map((c) => c[0]), ['get', 'create']);
  assert.deepEqual(provider.calls[1], ['create', 'primary', 'sb-1', s.name, { includeMemory: false }]);
  assert.equal(ledgerAtCreate.items[0].state, 'requested', 'intent persisted before the mutation');
  const t2 = await b.tick(OWNER);
  assert.equal(t2.state, 'active'); assert.equal(t2.name, s.name);
  assert.equal(provider.count('create'), 1);
  const sum = await b.summary(OWNER);
  assert.equal(sum.usage, 'unknown'); assert.equal(sum.owned, 1); assert.equal(sum.blocked, null);
});

await test('requestId replay returns the same answer; other args are request_conflict', async () => {
  const { b } = rig();
  const id = randomUUID();
  const a = await begin(b, stopped(), null, id);
  assert.deepEqual(await begin(b, stopped(), null, id), a);
  assert.equal((await begin(b, stopped('sb-2'), null, id)).reason, 'request_conflict');
  assert.equal((await begin(b, stopped(), 'rev1', id)).reason, 'request_conflict');
  assert.equal((await b.summary(OWNER)).items.length, 1);
});

await test('unknown create that was applied reconciles by exact name to active, never resubmits', async () => {
  const { b, provider } = rig();
  provider.createFault = { status: 0, applied: true };
  await begin(b);
  assert.equal((await b.tick(OWNER)).state, 'unknown');
  assert.equal((await b.tick(OWNER)).state, 'active');
  assert.equal(provider.count('create'), 1);
});

await test('unknown create + repeated 404s is unconfirmed, never not_applied: owned, blocking, automatic reads stop', async () => {
  const { b, provider } = rig();
  provider.createFault = { status: 503, applied: false };
  const first = await begin(b);
  await b.tick(OWNER);
  let s; for (let k = 0; k < L.reconcileAbsent + 1; k++) s = await b.tick(OWNER);
  assert.equal(s.state, 'unknown'); assert.equal(s.reason, 'create_unconfirmed'); assert.equal(s.work, false);
  assert.equal(s.name, first.name);
  assert.equal(provider.count('create'), 1);
  assert.equal(provider.count('get'), 1 + L.reconcileAbsent, 'preflight + the bounded 404 reads only');
  const sum = await b.summary(OWNER);
  assert.equal(sum.owned, 1, 'the possibly-landing create keeps its slot'); assert.equal(sum.blocked, 'create_unconfirmed');
});

await test('regression: 5x404 after unknown create, 24h+ and restarts, then late appearance -> no second create, no unaccounted slot', async () => {
  const { b, provider, deps, clock } = rig();
  provider.createFault = { status: 0, applied: false };
  const rid = randomUUID();
  const first = await begin(b, stopped(), null, rid);
  for (let k = 0; k < L.reconcileAbsent + 2; k++) await b.tick(OWNER);
  assert.equal((await b.status(OWNER)).reason, 'create_unconfirmed');
  // daily intents for days: every one is blocked while the old outcome is ambiguous; restarts never resubmit or read
  let store = deps.store;
  for (let day = 0; day < 3; day++) {
    clock.t += 25 * H;
    store = store.clone();
    const bx = new M.ComputerBackups({ ...deps, store });
    const n = await bx.begin(OWNER, { requestId: randomUUID(), machine: stopped(), environmentRevision: null });
    assert.equal(n.state, 'blocked'); assert.equal(n.reason, 'create_unconfirmed');
    const gets = provider.count('get');
    for (let k = 0; k < 4; k++) await bx.tick(OWNER);
    assert.equal(provider.count('get'), gets, 'no automatic reads after the budget');
    assert.equal((await bx.summary(OWNER)).owned, 1);
  }
  const bLate = new M.ComputerBackups({ ...deps, store });
  // the old create lands late
  provider.add('primary', { id: 'late-1', name: first.name, state: 'active', sourceSandboxId: 'sb-1', general: false, reads: 0, rreads: 0 });
  await bLate.tick(OWNER);
  assert.equal((await bLate.summary(OWNER)).blocked, 'create_unconfirmed', 'the alarm alone never adopts it');
  assert.equal((await bLate.summary(OWNER)).owned, 1, 'the landed resource is the accounted slot');
  // the original request replays honestly (still unknown, never failed/not_applied)
  const replay = await bLate.begin(OWNER, { requestId: rid, machine: stopped(), environmentRevision: null });
  assert.equal(replay.state, 'unknown'); assert.equal(replay.name, first.name);
  const rec = await bLate.reconcile(OWNER);
  assert.equal(rec.state, 'blocked', 'last begin (a blocked daily intent) is unchanged');
  const sum = await bLate.summary(OWNER);
  assert.equal(sum.blocked, null); assert.equal(sum.owned, 1);
  assert.equal(sum.items[0].state, 'active'); assert.equal(sum.items[0].name, first.name);
  const again = await bLate.begin(OWNER, { requestId: rid, machine: stopped(), environmentRevision: null });
  assert.equal(again.state, 'active', 'the original request now answers active');
  assert.equal(provider.count('create'), 1, 'never resent');
  assert.equal(provider.count('remove'), 0, 'old request/disk untouched');
  assert.equal(provider.snaps('primary').size, 1);
});

await test('explicit reconcile: 404 or error keeps unconfirmed; foreign/unproven late appearance is preserved, never adopted', async () => {
  for (const [late, want] of [[null, 'create_unconfirmed'], ['error', 'create_unconfirmed'],
    [{ sourceSandboxId: 'sb-other', general: false }, 'foreign'], [{ sourceSandboxId: null, general: false }, 'ownership_unproven']]) {
    const { b, provider } = rig();
    provider.createFault = { status: 502, applied: false };
    const first = await begin(b);
    for (let k = 0; k < L.reconcileAbsent + 1; k++) await b.tick(OWNER);
    if (late === 'error') provider.getFault = 500;
    else if (late) provider.add('primary', { id: 'late-x', name: first.name, state: 'active', ...late, reads: 0, rreads: 0 });
    await b.reconcile(OWNER);
    const sum = await b.summary(OWNER);
    assert.equal(sum.blocked, want); assert.equal(sum.owned, want === 'foreign' ? 0 : 1);
    assert.equal(sum.items.length, 1, 'never dropped');
    assert.equal(provider.count('create'), 1); assert.equal(provider.count('remove'), 0);
  }
});

await test('explicit reconcile of a late but still-building owned capture resumes normal reads to active', async () => {
  const { b, provider } = rig();
  provider.createFault = { status: 429, applied: false };
  const first = await begin(b);
  for (let k = 0; k < L.reconcileAbsent + 1; k++) await b.tick(OWNER);
  provider.buildReads = 3;
  provider.add('primary', { id: 'late-2', name: first.name, state: 'pending', sourceSandboxId: 'sb-1', general: false, reads: 0, rreads: 0 });
  await b.reconcile(OWNER);
  assert.equal((await b.status(OWNER)).state, 'pending');
  const s = await untilSettled(b);
  assert.equal(s.state, 'active'); assert.equal(provider.count('create'), 1);
});

await test('definite 4xx create refusal releases the intent (known refused), not unconfirmed', async () => {
  const { b, provider, clock } = rig();
  provider.createFault = { status: 422, applied: false };
  await begin(b);
  const s = await b.tick(OWNER);
  assert.equal(s.state, 'failed'); assert.equal(s.reason, 'provider_refused');
  const sum = await b.summary(OWNER);
  assert.equal(sum.owned, 0); assert.equal(sum.blocked, null);
  clock.t += 1 * H;
  assert.equal((await begin(b)).state, 'pending');
});

await test('generated names fit the restore UI rule (<=48) for 32-char owner tags and extreme timestamps; ledger keeps the full owner', async () => {
  const owners = ['a'.repeat(32), 'z9'.repeat(16), '0'.repeat(32), 'abcdefgh'];
  for (const t of [0, 1, Date.UTC(2026, 9, 19), 8.64e15, -1e12]) {
    for (const owner of owners) {
      const r = rig();
      r.clock.t = t;
      const s = await r.b.begin(owner, { requestId: randomUUID(), machine: stopped(), environmentRevision: null });
      assert.equal(s.state, 'pending', `${owner} @ ${t}`);
      assert.ok(s.name.length <= 48, `${s.name} (${s.name.length})`);
      assert.match(s.name, UI_SNAPSHOT_NAME); assert.match(s.name, COMPUTER_SNAPSHOT_NAME);
      assert.ok(s.name.startsWith(`cbak-${owner.slice(0, 16)}-`));
      const raw = r.store.m.get(`computer-backups:v1:${owner}`);
      assert.equal(raw.owner, owner, 'provenance keeps the full owner tag');
      assert.equal((await r.b.tick(owner)).state, 'pending');
      assert.equal(r.provider.calls.find((c) => c[0] === 'create')[3], s.name);
    }
  }
});

await test('restart after intent persisted but before the create answered: reconcile, no second create', async () => {
  const { b, provider, deps } = rig();
  let crashed;
  provider.onCreate = () => { crashed = deps.store.clone(); };
  await begin(b);
  await b.tick(OWNER); // the original instance applied the create
  const b2 = new M.ComputerBackups({ ...deps, store: crashed });
  provider.onCreate = null;
  assert.equal((await b2.status(OWNER)).state, 'pending');
  const s = await b2.tick(OWNER); // persisted 'requested' -> unknown -> read by name finds it
  assert.equal(s.state, 'active');
  assert.equal(provider.count('create'), 1);
});

await test('definite 409 is a name collision: never adopted or deleted; preflight hit is the same', async () => {
  const { b, provider } = rig();
  provider.createFault = { status: 409, applied: false };
  const s0 = await begin(b);
  const s = await b.tick(OWNER);
  assert.equal(s.state, 'failed'); assert.equal(s.reason, 'name_collision');
  const r2 = rig();
  const p = await begin(r2.b);
  r2.provider.add('primary', { id: 'other', name: p.name, state: 'active', sourceSandboxId: 'sb-1', general: false });
  const t = await r2.b.tick(OWNER);
  assert.equal(t.reason, 'name_collision'); assert.equal(r2.provider.count('create'), 0); assert.equal(r2.provider.count('remove'), 0);
  assert.ok(s0.name);
});

await test('ownership missing (no sourceSandboxId / general unknown) preserves and blocks new captures', async () => {
  for (const mutate of [(s) => { s.sourceSandboxId = null; }, (s) => { delete s.general; }, (s) => { delete s.id; }]) {
    const { b, provider, clock } = rig();
    provider.mutate = mutate;
    await begin(b); await b.tick(OWNER);
    const s = await b.tick(OWNER);
    assert.equal(s.state, 'blocked'); assert.equal(s.reason, 'ownership_unproven');
    clock.t += 7 * H;
    const n = await begin(b);
    assert.equal(n.state, 'blocked'); assert.equal(n.reason, 'ownership_unproven');
    for (let k = 0; k < 5; k++) await b.tick(OWNER);
    assert.equal(provider.count('remove'), 0); assert.equal(provider.count('create'), 1);
  }
});

await test('ownership mismatch (other source sandbox / general) is foreign: kept, never deleted, blocks', async () => {
  for (const mutate of [(s) => { s.sourceSandboxId = 'sb-other'; }, (s) => { s.general = true; }]) {
    const { b, provider, clock } = rig();
    provider.mutate = mutate;
    await begin(b); await b.tick(OWNER);
    const s = await b.tick(OWNER);
    assert.equal(s.state, 'blocked'); assert.equal(s.reason, 'foreign');
    clock.t += 7 * H;
    assert.equal((await begin(b)).reason, 'foreign');
    assert.equal(provider.count('remove'), 0);
  }
});

await test('duplicate provider id across two ledger items is never proof', async () => {
  const { b, provider, clock } = rig();
  await begin(b); await untilSettled(b);
  clock.t += 7 * H;
  const first = [...provider.snaps('primary').values()][0];
  provider.mutate = (s) => { provider.snaps('primary').delete(s.id); s.id = first.id; provider.snaps('primary').set('dup-key', s); };
  provider.find = function (a, key) { const m = this.snaps(a); return key === first.id ? first : [...m.values()].find((x) => x.name === key) ?? null; };
  await begin(b); await b.tick(OWNER);
  // reading the second by name returns a dto whose id equals the first item's id
  provider.find = function (a, key) { const m = this.snaps(a); return [...m.values()].find((x) => x.name === key) ?? m.get(key) ?? null; };
  const s = await b.tick(OWNER);
  assert.equal(s.state, 'blocked'); assert.equal(s.reason, 'ownership_unproven');
});

async function fillActive(r, n, rev = (k) => null) {
  const names = [];
  for (let k = 0; k < n; k++) {
    r.clock.t += 7 * H;
    const s = await begin(r.b, stopped(), rev(k));
    assert.equal(s.state, 'pending', `begin ${k}: ${JSON.stringify(s)}`);
    names.push(s.name);
    const e = await untilSettled(r.b);
    assert.equal(e.state, 'active');
  }
  return names;
}

await test('retention: 3 verified kept; oldest deleted only after the replacement is verified, 404 confirms; owned <= 4', async () => {
  const r = rig();
  const names = await fillActive(r, 3);
  assert.equal(r.provider.count('remove'), 0);
  r.clock.t += 7 * H;
  const s = await begin(r.b);
  await r.b.tick(OWNER); // create sent; old ones untouched while the replacement is pending
  assert.equal(r.provider.count('remove'), 0);
  assert.equal((await r.b.summary(OWNER)).owned, 4);
  const done = await untilSettled(r.b);
  assert.equal(done.state, 'active'); assert.equal(done.name, s.name); assert.equal(done.work, false);
  const removes = r.provider.calls.filter((c) => c[0] === 'remove');
  assert.equal(removes.length, 1);
  assert.equal(removes[0][2], 'snap-1', 'only the oldest, by id');
  const sum = await r.b.summary(OWNER);
  assert.deepEqual(sum.items.map((i) => i.name), [...names.slice(1), s.name]);
  assert.equal(sum.owned, 3);
  assert.equal(r.provider.snaps('primary').size, 3, 'provider resources match the ledger');
});

await test('protected template is never deleted; retention waits and the next capture is held at 4 owned', async () => {
  const r = rig();
  const names = await fillActive(r, 3);
  rig.protectFn = () => [names[0]];
  try {
    r.clock.t += 7 * H;
    await begin(r.b); await untilSettled(r.b);
    assert.equal(r.provider.count('remove'), 0);
    assert.equal((await r.b.summary(OWNER)).owned, 4);
    r.clock.t += 7 * H;
    const held = await begin(r.b);
    assert.equal(held.state, 'pending');
    let s; for (let k = 0; k <= L.intentPolls + 1; k++) s = await r.b.tick(OWNER);
    assert.equal(s.state, 'blocked'); assert.equal(s.reason, 'retention_blocked');
    assert.equal(r.provider.count('create'), 4, 'no fifth resource');
    rig.protectFn = () => { throw new Error('protected list unavailable'); };
    for (let k = 0; k < 3; k++) await r.b.tick(OWNER);
    assert.equal(r.provider.count('remove'), 0, 'unknown protection list means no delete');
  } finally { rig.protectFn = null; }
});

await test('latest guard: the newest verified backup is never a delete candidate', async () => {
  const r = rig();
  const names = await fillActive(r, 4);
  const removed = r.provider.calls.filter((c) => c[0] === 'remove').map((c) => c[2]);
  const sum = await r.b.summary(OWNER);
  assert.ok(sum.items.some((i) => i.name === names[3] && i.state === 'active'));
  assert.ok(!removed.includes([...r.provider.snaps('primary').values()].find((x) => x.name === names[3])?.id));
});

await test('delete unknown: bounded re-sends after fresh checks, then delete_blocked blocks new captures; 404 later clears', async () => {
  const r = rig();
  await fillActive(r, 3);
  r.provider.removeTakes = false; // DELETE answers but never takes effect
  r.provider.removeFault = { status: 0, applied: false };
  r.clock.t += 7 * H;
  await begin(r.b); await r.b.tick(OWNER); await r.b.tick(OWNER);
  for (let k = 0; k < 6; k++) await r.b.tick(OWNER);
  assert.equal(r.provider.count('remove'), L.deleteSends);
  const sum = await r.b.summary(OWNER);
  assert.equal(sum.blocked, 'cleanup_blocked'); assert.equal(sum.owned, 4, 'delete-unknown resource still counted');
  r.clock.t += 7 * H;
  assert.equal((await begin(r.b)).reason, 'cleanup_blocked');
  // the resource disappears out of band: a GET 404 by id is the only way out
  r.provider.snaps('primary').delete('snap-1');
  await r.b.tick(OWNER);
  assert.equal((await r.b.summary(OWNER)).blocked, null);
  assert.equal(r.provider.count('create'), 4);
});

await test('delete 200 is not completion: removing is polled until GET 404', async () => {
  const r = rig();
  r.provider.removingReads = 3;
  await fillActive(r, 3);
  r.clock.t += 7 * H;
  await begin(r.b); await r.b.tick(OWNER);
  await r.b.tick(OWNER); // active + delete sent
  assert.equal(r.provider.count('remove'), 1);
  assert.equal((await r.b.summary(OWNER)).items.find((i) => i.state === 'deleting')?.state, 'deleting');
  for (let k = 0; k < 4; k++) await r.b.tick(OWNER);
  assert.equal(r.provider.count('remove'), 1);
  assert.equal((await r.b.summary(OWNER)).owned, 3);
});

await test('definite delete refusal blocks; foreign at delete time is preserved', async () => {
  const r = rig();
  await fillActive(r, 3);
  r.provider.removeFault = { status: 403, applied: false };
  r.clock.t += 7 * H;
  await begin(r.b); await untilSettled(r.b);
  assert.equal((await r.b.summary(OWNER)).blocked, 'cleanup_blocked');
  const r2 = rig();
  await fillActive(r2, 3);
  r2.provider.snaps('primary').get('snap-1').sourceSandboxId = 'sb-someone-else';
  r2.clock.t += 7 * H;
  await begin(r2.b); await untilSettled(r2.b);
  assert.equal(r2.provider.count('remove'), 0);
  assert.equal((await r2.b.summary(OWNER)).blocked, 'foreign');
});

await test('min interval 6h coalesces; unknown revision never claims unchanged; known same revision dedupes', async () => {
  const r = rig();
  const first = await begin(r.b); await untilSettled(r.b);
  r.clock.t += 1 * H;
  const c = await begin(r.b);
  assert.equal(c.state, 'coalesced'); assert.equal(c.reason, 'recent'); assert.equal(c.name, first.name);
  r.clock.t += 6 * H;
  const n = await begin(r.b); // unknown revision, past the interval: a new capture
  assert.equal(n.state, 'pending');
  await untilSettled(r.b);
  const r2 = rig();
  await fillActive(r2, 1, () => 'rev-a');
  r2.clock.t += 30 * H;
  const same = await begin(r2.b, stopped(), 'rev-a');
  assert.equal(same.state, 'coalesced'); assert.equal(same.reason, 'unchanged');
  const other = await begin(r2.b, stopped(), 'rev-b');
  assert.equal(other.state, 'pending');
  const r3 = rig();
  await fillActive(r3, 1);
  r3.clock.t += 30 * H;
  const unk = await begin(r3.b, stopped(), null);
  assert.equal(unk.state, 'pending', 'null revision is never treated as unchanged');
});

await test('daily cap: at most 4 new captures per 24h; failed ones count', async () => {
  const r = rig();
  for (let k = 0; k < 4; k++) {
    r.provider.createFault = { status: 400, applied: false };
    r.clock.t += 1 * H;
    assert.equal((await begin(r.b)).state, 'pending');
    assert.equal((await r.b.tick(OWNER)).reason, 'provider_refused');
  }
  r.clock.t += 1 * H;
  const s = await begin(r.b);
  assert.equal(s.state, 'blocked'); assert.equal(s.reason, 'daily_limit');
  assert.equal(r.provider.count('create'), 4);
  r.clock.t += 24 * H;
  assert.equal((await begin(r.b)).state, 'pending');
});

await test('in-flight capture: same machine joins it, another machine is busy; accounts never substituted', async () => {
  const r = rig();
  const a = await begin(r.b, stopped('sb-9', 'secondary'));
  const j = await begin(r.b, stopped('sb-9', 'secondary'));
  assert.equal(j.state, 'pending'); assert.equal(j.name, a.name);
  const busy = await begin(r.b, stopped('sb-1', 'primary'));
  assert.equal(busy.state, 'blocked'); assert.equal(busy.reason, 'busy');
  await untilSettled(r.b);
  assert.ok(r.provider.calls.every((c) => c[1] === 'secondary'));
  assert.equal(r.provider.snaps('primary').size, 0);
});

await test('stale capture stays owned, re-read, and blocks new captures (expiry never blind-creates)', async () => {
  const r = rig();
  r.provider.buildReads = 10_000;
  await begin(r.b);
  let s; for (let k = 0; k < L.createPolls + 1; k++) s = await r.b.tick(OWNER);
  assert.equal(s.state, 'failed'); assert.equal(s.reason, 'timeout');
  r.clock.t += 7 * H;
  assert.equal((await begin(r.b)).reason, 'cleanup_blocked');
  r.provider.snaps('primary').get('snap-1').state = 'active';
  await r.b.tick(OWNER);
  assert.equal((await r.b.summary(OWNER)).blocked, null);
  assert.equal(r.provider.count('create'), 1);
});

await test('ledger is owner bound and bounded', async () => {
  const r = rig();
  for (let k = 0; k < 40; k++) await begin(r.b, { id: 'sb-1', account: 'primary', status: 'running' });
  const raw = [...r.store.m.values()][0];
  assert.ok(raw.begins.length <= L.receipts);
  r.store.m.set('computer-backups:v1:owner0002tag', { ...raw, owner: OWNER });
  await assert.rejects(() => r.b.status('owner0002tag'), /owner mismatch/);
});

console.log(`${passed} passed`);
