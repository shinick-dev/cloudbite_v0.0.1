// CloudBite computer safe end (src/cloudbite-computer-service.ts end/endStatus/endSettings) against a fake Daytona, a fake files
// drain and a fake backups manager. Pins: the phase is stored before every outbound step, the stop only follows a proven drain
// (files_verified) or a flush (disk_backup), a deadline stops with the disk kept and files pending, provider auto-stop is recorded
// unverified without a restart, requestId replays, DO restarts, bounded drain/stop/backup polling, and that nothing is deleted.
// All fakes: n=small, no provider network — not live persistence, latency or backup evidence.
//   node test/cloudbite-computer-end-session.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { createHash, randomBytes, randomUUID, webcrypto } from 'node:crypto';
import { build } from 'esbuild';

const tmp = mkdtempSync(join(tmpdir(), 'cloudbite-end-'));
const built = await build({ stdin: { contents: `export * from './src/cloudbite-computer-service.ts'; export * from './src/cloudbite-computer-contract.ts'; export { ComputerBackups } from './src/cloudbite-computer-backups.ts'; export { ComputerDaytonaError } from './src/cloudbite-computer-daytona.ts';`, resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, write: false, platform: 'node', format: 'esm', plugins: [{ name: 'cf', setup(b) {
    b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'cf', namespace: 'stub' }));
    b.onLoad({ filter: /^cf$/, namespace: 'stub' }, () => ({ contents: 'export class DurableObject { constructor(ctx,env){this.ctx=ctx;this.env=env;} }' }));
  } }] });
writeFileSync(join(tmp, 'm.mjs'), built.outputFiles[0].text);
const M = await import(pathToFileURL(join(tmp, 'm.mjs')));
globalThis.fetch = async () => { throw new Error('provider network forbidden'); };

const OWNER = 'owner0001tag';
const ENV = { CLOUDBITE_DAYTONA_API_KEY: 'k1', CLOUDBITE_COMPUTER_SNAPSHOT: 'cloudbite-computer-v1', CLOUDBITE_COMPUTER_GATEWAY_ORIGIN: 'https://gw.example.workers.dev' };
const MUTATIONS = ['create', 'start', 'stop', 'createSnapshot', 'removeSnapshot', 'resize'];
const CLEAN = { agentReady: true, managedScanComplete: true, scanLimited: false, dirty: 0, uploading: 0, conflict: 0, unconfirmedOps: 0, open: 0, pendingDeletions: 0, errors: 0 };

function fakeDaytona() {
  const f = { calls: [], sandboxes: new Map(), snapshots: new Map([['cloudbite-computer-v1', { name: 'cloudbite-computer-v1', state: 'active' }]]), fail: {}, health: true, syncExit: 0 };
  const err = (op) => { const q = f.fail[op]; return q && q.length ? q.shift() : null; };
  const byId = (id) => [...f.sandboxes.values()].find((s) => s.id === id || s.name === id) ?? null;
  f.api = {
    async create(c, body) { f.calls.push(['create']); const sb = { id: 'sb-' + randomBytes(6).toString('hex'), name: body.name, labels: body.labels, state: 'started', target: 'us', cpu: 4, memory: 8, disk: 10 };
      f.sandboxes.set(body.name, sb); return sb; },
    async get(c, idOrName) { f.calls.push(['get']); const e = err('get'); if (e) throw new M.ComputerDaytonaError(e.status, 'get'); return byId(idOrName); },
    async start(c, id) { f.calls.push(['start', id]); f.onStart?.(); byId(id).state = 'started'; },
    async stop(c, id) { f.calls.push(['stop', id]); f.onStop?.(); const e = err('stop'); if (e?.landed) byId(id).state = 'stopped'; if (e) throw new M.ComputerDaytonaError(e.status, 'stop'); byId(id).state = 'stopped'; },
    async createSnapshot(c, id, name) { f.calls.push(['createSnapshot', id, name]); f.snapshots.set(name, { name, state: 'snapshotting', sourceSandboxId: id }); },
    async getSnapshot(c, name) { f.calls.push(['getSnapshot', name]); return f.snapshots.get(name) ?? null; },
    async removeSnapshot(c, id) { f.calls.push(['removeSnapshot', id]); return 'accepted'; },
    async preview(c, id, port) { return { url: `https://${port}-${id}.proxy.daytona.works`, token: 'preview-secret' }; },
    async exec(c, sb, command) { f.calls.push(['exec', command]);
      if (command === 'sync') return { exitCode: f.syncExit, result: '' };
      if (command.startsWith('curl')) return { exitCode: f.health ? 0 : 7, result: '' };
      return { exitCode: 1, result: '' }; },
    async computerUseStart() { f.calls.push(['computerUseStart']); },
    async spawn() { f.calls.push(['spawn']); },
  };
  return f;
}

/** Fake files drain: answers from a queue (last answer repeats); records the stored record seen at call time. */
function fakeDrain(kv, answers) {
  const d = { calls: [], seen: [], resumes: 0, answers: [...answers] };
  d.drain = async (machine, requestId) => {
    d.calls.push({ machine, requestId }); d.seen.push(structuredClone(kv.get('computer').end));
    const a = d.answers.length > 1 ? d.answers.shift() : d.answers[0];
    if (a instanceof Error) throw a;
    return 'ok' in a ? a : { ok: true, report: a };
  };
  d.resume = async () => { d.resumes++; };
  return d;
}
/** Fake backups manager: begin/tick answers from queues; status is storage only. */
function fakeBackup(states = ['pending', 'active']) {
  const b = { begins: [], ticks: 0, statusCalls: 0, q: [...states], last: null, beginFail: 0 };
  const next = () => { const s = b.q.length > 1 ? b.q.shift() : b.q[0]; b.last = typeof s === 'string' ? { state: s, name: 'cb-auto-1' } : { name: 'cb-auto-1', ...s }; return b.last; };
  b.hook = {
    async begin(owner, req) { b.begins.push(structuredClone(req)); if (b.beginFail-- > 0) throw new Error('timeout'); return next(); },
    async tick() { b.ticks++; return next(); },
    async status() { b.statusCalls++; return b.last; },
  };
  return b;
}

function world({ drain, backup, shared } = {}) {
  const kv = shared?.kv ?? new Map(); const clock = shared?.clock ?? { now: 1_800_000_000_000, alarm: null };
  const store = { async get(k) { return structuredClone(kv.get(k)); }, async put(k, v) { kv.set(k, structuredClone(v)); },
    async setAlarm(at) { clock.alarm = at; }, async deleteAlarm() { clock.alarm = null; } };
  const fake = shared?.fake ?? fakeDaytona();
  const d = drain ? fakeDrain(kv, drain) : null, b = backup ? fakeBackup(backup) : null;
  const end = d || b ? { ...(d ? { drain: d.drain, resume: d.resume } : {}), ...(b ? { backup: b.hook } : {}) } : undefined;
  const svc = new M.ComputerService({ store, env: ENV, daytona: fake.api, now: () => clock.now, random: (n) => new Uint8Array(randomBytes(n)),
    sha256: async (s) => createHash('sha256').update(s).digest('hex'), end });
  return { svc, fake, kv, clock, d, b, tick(ms) { clock.now += ms; }, get now() { return clock.now; } };
}
async function running(w) {
  await w.svc.start(OWNER, { requestId: randomUUID(), account: 'primary' });
  await w.svc.alarm();
  assert.equal((await w.svc.state(OWNER)).status, 'running');
}
const ops = (f, op) => f.calls.filter((c) => c[0] === op);
const muts = (f) => f.calls.filter((c) => MUTATIONS.includes(c[0]));
const rec = (w) => w.kv.get('computer');
const alarms = async (w, n, ms = 10_000) => { for (let i = 0; i < n; i++) { w.tick(ms); await w.svc.alarm(); } };
let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log('ok', name); };

await test('disk_backup without any hook: stored first, flush then stop, disk kept, files not_configured, no backup claimed', async () => {
  const w = world(); await running(w);
  const before = w.fake.calls.length, id = randomUUID();
  const r = await w.svc.end(OWNER, { requestId: id, mode: 'disk_backup' });
  assert.equal(r.ok, true); assert.equal(r.end.phase, 'draining'); assert.equal(r.end.requestId, id);
  assert.equal(r.end.files, 'not_configured'); assert.equal(r.end.environmentBackup, 'not_configured');
  assert.deepEqual(r.modes, { disk_backup: true, files_verified: false }); assert.equal(r.backupConfigured, false);
  assert.deepEqual(muts({ calls: w.fake.calls.slice(before) }), [], 'POST end only stores the phase');
  assert.ok(w.clock.alarm <= w.now + 10_000, 'the alarm advances it');
  w.fake.onStop = () => assert.equal(rec(w).end.phase, 'stopping', 'phase persisted before the stop');
  await alarms(w, 1);
  assert.deepEqual(ops(w.fake, 'exec').at(-1), ['exec', 'sync']);
  assert.equal(ops(w.fake, 'stop').length, 1);
  await alarms(w, 1);
  const s = await w.svc.state(OWNER);
  assert.equal(s.status, 'stopped'); assert.equal(s.end.phase, 'done'); assert.equal(s.end.machineStopped, true); assert.equal(s.end.diskFlushed, true);
  assert.equal(s.end.files, 'not_configured'); assert.equal(s.end.environmentBackup, 'not_configured');
  assert.equal(w.fake.sandboxes.size, 1, 'the machine and its disk still exist');
  assert.equal(ops(w.fake, 'removeSnapshot').length + ops(w.fake, 'createSnapshot').length, 0);
});

await test('requestId: replay, conflict, join of the same mode, busy for the other mode', async () => {
  const w = world({ drain: [CLEAN] }); await running(w);
  const id = randomUUID();
  const a = await w.svc.end(OWNER, { requestId: id, mode: 'disk_backup' });
  const b = await w.svc.end(OWNER, { requestId: id, mode: 'disk_backup' });
  assert.equal(b.end.requestId, a.end.requestId); assert.equal(b.end.startedAt, a.end.startedAt);
  assert.equal((await w.svc.end(OWNER, { requestId: id, mode: 'files_verified' })).error.code, 'request_conflict');
  const j = await w.svc.end(OWNER, { requestId: randomUUID(), mode: 'disk_backup' });
  assert.equal(j.end.requestId, id, 'a second click joins the active end');
  assert.equal((await w.svc.end(OWNER, { requestId: randomUUID(), mode: 'files_verified' })).error.code, 'busy');
  assert.equal((await w.svc.end(OWNER, { requestId: randomUUID(), mode: 'everything' })).error.code, 'bad_request');
  assert.equal((await w.svc.end(OWNER, { requestId: randomUUID(), mode: 'disk_backup', force: true })).error.code, 'bad_request');
  assert.equal(ops(w.fake, 'stop').length, 0);
});

await test('files_verified without a wired drain is refused and changes nothing; disk_backup stays possible', async () => {
  const w = world(); await running(w);
  const r = await w.svc.end(OWNER, { requestId: randomUUID(), mode: 'files_verified' });
  assert.equal(r.error.code, 'files_not_configured');
  assert.equal(rec(w).end ?? null, null); assert.equal(ops(w.fake, 'stop').length, 0);
  assert.equal((await w.svc.endSettings(OWNER, { requestId: randomUUID(), autoEnd: 'files_verified' })).error.code, 'files_not_configured');
  assert.equal((await w.svc.end(OWNER, { requestId: randomUUID(), mode: 'disk_backup' })).ok, true);
});

await test('files_verified: drain recorded first, stop only after proof, then the backup manager; files and backup stay separate', async () => {
  const w = world({ drain: [CLEAN], backup: ['pending', 'active'] }); await running(w);
  const id = randomUUID();
  const r = await w.svc.end(OWNER, { requestId: id, mode: 'files_verified' });
  assert.equal(r.end.files, 'verifying'); assert.equal(r.uploadsFrozen, true);
  await alarms(w, 1);
  assert.equal(w.d.calls.length, 1); assert.equal(w.d.calls[0].requestId, id); assert.equal(w.d.calls[0].machine.status, 'running');
  assert.equal(w.d.seen[0].phase, 'draining'); assert.equal(w.d.seen[0].drains, 1, 'attempt persisted before the call');
  assert.equal(ops(w.fake, 'stop').length, 1); assert.equal(rec(w).end.files, 'verified');
  await alarms(w, 1); // observed stopped -> backing_up -> begin
  assert.equal(w.b.begins.length, 1);
  assert.deepEqual(w.b.begins[0], { requestId: id, machine: { id: rec(w).machine.id, account: 'primary', status: 'stopped' }, environmentRevision: null });
  assert.equal(rec(w).end.phase, 'backing_up'); assert.equal(rec(w).end.backup, 'pending');
  await alarms(w, 1);
  const s = await w.svc.endStatus(OWNER);
  assert.equal(s.end.phase, 'done'); assert.equal(s.end.files, 'verified'); assert.equal(s.end.environmentBackup, 'active'); assert.equal(s.end.backupName, 'cb-auto-1');
  assert.equal(s.uploadsFrozen, false); assert.deepEqual(s.backup, { state: 'active', name: 'cb-auto-1' });
  assert.equal(ops(w.fake, 'exec').filter((c) => c[1] === 'sync').length, 0, 'files_verified relies on the drain flush');
  assert.equal(ops(w.fake, 'removeSnapshot').length, 0);
});

await test('bare agent ready without a complete watcher scan is never proof: bounded drains, then blocked and running', async () => {
  const bare = { ...CLEAN, managedScanComplete: false };
  const w = world({ drain: [bare] }); await running(w);
  await w.svc.end(OWNER, { requestId: randomUUID(), mode: 'files_verified' });
  await alarms(w, 20);
  const e = rec(w).end;
  assert.equal(w.d.calls.length, 12, 'at most 12 drains'); assert.equal(e.phase, 'blocked'); assert.equal(e.files, 'blocked');
  assert.equal(ops(w.fake, 'stop').length, 0); assert.equal((await w.svc.state(OWNER)).status, 'running');
  assert.equal(w.d.resumes, 1, 'the agent is asked to leave draining');
  assert.equal((await w.svc.endStatus(OWNER)).uploadsFrozen, false);
  for (const junk of [{ ...CLEAN, dirty: '0' }, { ...CLEAN, scanLimited: undefined }, { ...CLEAN, pendingDeletions: 1 }, { ...CLEAN, errors: -1 }, {}])
    assert.equal(M.computerDrainVerified(junk), false, JSON.stringify(junk));
  assert.equal(M.computerDrainVerified(CLEAN), true);
});

await test('dirty then clean drains stop after the clean one; a definite drain refusal blocks at once', async () => {
  const w = world({ drain: [{ ...CLEAN, dirty: 2, uploading: 1 }, { ...CLEAN, uploading: 1 }, CLEAN] }); await running(w);
  await w.svc.end(OWNER, { requestId: randomUUID(), mode: 'files_verified' });
  await alarms(w, 2); assert.equal(ops(w.fake, 'stop').length, 0); assert.equal(rec(w).end.report.uploading, 1);
  await alarms(w, 1); assert.equal(ops(w.fake, 'stop').length, 1); assert.equal(rec(w).end.files, 'verified');
  const w2 = world({ drain: [{ ok: false, code: 'agent_missing', retryable: false }] }); await running(w2);
  await w2.svc.end(OWNER, { requestId: randomUUID(), mode: 'files_verified' });
  await alarms(w2, 1);
  assert.equal(rec(w2).end.phase, 'blocked'); assert.equal(ops(w2.fake, 'stop').length, 0);
});

await test('deadline during a user drain stops anyway with the disk kept and files pending; the backup never claims files', async () => {
  const w = world({ drain: [{ ...CLEAN, dirty: 1 }], backup: ['active'] }); await running(w);
  await w.svc.end(OWNER, { requestId: randomUUID(), mode: 'files_verified' });
  await alarms(w, 3);
  w.clock.now = rec(w).sessionEndsAt; await w.svc.alarm();
  const e = rec(w).end;
  assert.equal(e.files, 'pending'); assert.equal(ops(w.fake, 'stop').length, 1);
  await alarms(w, 1);
  const s = (await w.svc.state(OWNER)).end;
  assert.equal(s.phase, 'done'); assert.equal(s.files, 'pending'); assert.equal(s.environmentBackup, 'active');
  assert.equal(w.fake.sandboxes.size, 1);
});

await test('auto end is opt-in: drains before the deadline, stops only at it; owners who did not opt in keep the plain stop', async () => {
  const w = world({ drain: [{ ...CLEAN, dirty: 1 }, CLEAN], backup: ['coalesced'] }); await running(w);
  const set = await w.svc.endSettings(OWNER, { requestId: randomUUID(), autoEnd: 'files_verified' });
  assert.equal(set.autoEnd, 'files_verified');
  const deadline = rec(w).sessionEndsAt;
  assert.ok(w.clock.alarm <= deadline - 5 * 60_000, 'woken by 5 min before the deadline');
  w.clock.now = deadline - 5 * 60_000; await w.svc.alarm();
  assert.equal(rec(w).end.trigger, 'deadline'); assert.equal(w.d.calls.length, 1);
  await alarms(w, 3);
  assert.equal(ops(w.fake, 'stop').length, 0, 'verified early is not a reason to cut the paid session');
  w.clock.now = deadline; await w.svc.alarm();
  assert.equal(rec(w).end.files, 'verified', 'final drain at the deadline'); assert.equal(ops(w.fake, 'stop').length, 1);
  await alarms(w, 1);
  assert.equal(rec(w).end.phase, 'done'); assert.equal(rec(w).end.backup, 'coalesced');

  const plain = world({ drain: [CLEAN], backup: ['active'] }); await running(plain);
  plain.clock.now = rec(plain).sessionEndsAt; await plain.svc.alarm();
  assert.equal(ops(plain.fake, 'stop').length, 1); assert.equal(plain.d.calls.length, 0); assert.equal(rec(plain).end ?? null, null);
  await alarms(plain, 3);
  assert.equal(plain.b.begins.length, 0, 'no automatic capture without opt-in');
});

await test('extend calls off a deadline end that has not stopped; a user end makes extend busy', async () => {
  const w = world({ drain: [{ ...CLEAN, dirty: 1 }] }); await running(w);
  await w.svc.endSettings(OWNER, { requestId: randomUUID(), autoEnd: 'files_verified' });
  w.clock.now = rec(w).sessionEndsAt - 60_000; await w.svc.alarm();
  assert.equal(rec(w).end.phase, 'draining');
  const x = await w.svc.extend(OWNER, { requestId: randomUUID() });
  assert.equal(x.ok, true); assert.equal(x.end.phase, 'cancelled'); assert.equal(w.d.resumes, 1); assert.equal(ops(w.fake, 'stop').length, 0);
  const w2 = world(); await running(w2);
  await w2.svc.end(OWNER, { requestId: randomUUID(), mode: 'disk_backup' });
  assert.equal((await w2.svc.extend(OWNER, { requestId: randomUUID() })).error.code, 'busy');
});

await test('provider auto-stop: opted-in owners get an unverified end and a backup, never a restart; others get nothing new', async () => {
  const w = world({ drain: [CLEAN], backup: ['active'] }); await running(w);
  await w.svc.endSettings(OWNER, { requestId: randomUUID(), autoEnd: 'disk_backup' });
  [...w.fake.sandboxes.values()][0].state = 'stopped';
  const s = await w.svc.state(OWNER);
  assert.equal(s.end.trigger, 'provider_stop'); assert.equal(s.end.files, 'unverified');
  await alarms(w, 2);
  assert.equal(rec(w).end.phase, 'done'); assert.equal(rec(w).end.backup, 'active'); assert.equal(w.b.begins.length, 1);
  assert.equal(ops(w.fake, 'start').length, 0); assert.equal(ops(w.fake, 'stop').length, 0);
  const plain = world({ backup: ['active'] }); await running(plain);
  [...plain.fake.sandboxes.values()][0].state = 'stopped';
  assert.equal((await plain.svc.state(OWNER)).end, null);
});

await test('lost stop answer is reconciled by GET, never re-sent; a landed stop continues to the backup', async () => {
  const w = world({ backup: ['active'] }); await running(w);
  w.fake.fail.stop = [{ status: 0, landed: true }];
  await w.svc.end(OWNER, { requestId: randomUUID(), mode: 'disk_backup' });
  await alarms(w, 1);
  assert.equal(rec(w).status, 'unknown');
  await alarms(w, 2);
  assert.equal(ops(w.fake, 'stop').length, 1); assert.equal(rec(w).end.phase, 'done'); assert.equal(rec(w).end.backup, 'active');
});

await test('DO restart mid-end continues the same stored end; backup begin without answer is re-asked with the same id', async () => {
  const shared = { kv: new Map(), clock: { now: 1_800_000_000_000, alarm: null }, fake: fakeDaytona() };
  const w = world({ shared, drain: [CLEAN], backup: ['active'] }); await running(w);
  const id = randomUUID();
  await w.svc.end(OWNER, { requestId: id, mode: 'files_verified' });
  const w2 = world({ shared, drain: [CLEAN], backup: ['active'] }); // evicted DO, fresh instance on the same storage
  w2.b.beginFail = 1;
  await alarms(w2, 1); assert.equal(ops(shared.fake, 'stop').length, 1);
  await alarms(w2, 1); assert.equal(rec(w2).end.backup, 'not_requested', 'unanswered begin concludes nothing');
  await alarms(w2, 1);
  assert.deepEqual(w2.b.begins.map((b) => b.requestId), [id, id]);
  assert.equal(rec(w2).end.phase, 'done'); assert.equal(rec(w2).end.backup, 'active');
  const replay = await w2.svc.end(OWNER, { requestId: id, mode: 'files_verified' });
  assert.equal(replay.end.phase, 'done'); assert.equal(ops(shared.fake, 'stop').length, 1);
});

await test('failed backup ends the flow with the disk kept and no deletion; pending backup polling is bounded', async () => {
  const w = world({ backup: ['failed'] }); await running(w);
  await w.svc.end(OWNER, { requestId: randomUUID(), mode: 'disk_backup' });
  await alarms(w, 3);
  assert.equal(rec(w).end.phase, 'done'); assert.equal(rec(w).end.backup, 'failed');
  assert.equal(rec(w).status, 'stopped'); assert.equal(w.fake.sandboxes.size, 1); assert.equal(ops(w.fake, 'removeSnapshot').length, 0);
  const p = world({ backup: ['pending'] }); await running(p);
  await p.svc.end(OWNER, { requestId: randomUUID(), mode: 'disk_backup' });
  await alarms(p, 400);
  assert.equal(rec(p).end.phase, 'done'); assert.equal(rec(p).end.backup, 'unknown');
  assert.ok(p.b.ticks <= 360);
});

await test('an end excludes start, snapshot and resize; the plain stop during a drain takes over with files unverified', async () => {
  const w = world({ drain: [{ ...CLEAN, dirty: 1 }], backup: ['pending'] }); await running(w);
  await w.svc.end(OWNER, { requestId: randomUUID(), mode: 'files_verified' });
  assert.equal((await w.svc.snapshot(OWNER, { requestId: randomUUID(), name: 'my-capture' })).error.code, 'busy');
  const st = await w.svc.stop(OWNER, { requestId: randomUUID() });
  assert.equal(st.ok, true); assert.equal(st.end.phase, 'stopping'); assert.equal(st.end.files, 'unverified');
  await alarms(w, 1);
  assert.equal(rec(w).end.phase, 'backing_up');
  assert.equal((await w.svc.start(OWNER, { requestId: randomUUID(), account: 'primary' })).error.code, 'busy', 'no start while the capture runs');
  assert.equal(ops(w.fake, 'stop').length, 1);
});

await test('end on a stopped machine goes straight to the backup; endStatus makes no provider call', async () => {
  const w = world({ backup: ['active'] }); await running(w);
  await w.svc.stop(OWNER, { requestId: randomUUID() });
  await w.svc.state(OWNER);
  assert.equal((await w.svc.end(OWNER, { requestId: randomUUID(), mode: 'files_verified' })).error.code, 'files_not_configured');
  await w.svc.end(OWNER, { requestId: randomUUID(), mode: 'disk_backup' });
  await alarms(w, 2);
  assert.equal(rec(w).end.phase, 'done'); assert.equal(rec(w).end.flushed, null, 'nothing to flush on a stopped machine');
  const n = w.fake.calls.length;
  const s = await w.svc.endStatus(OWNER);
  assert.equal(s.ok, true); assert.equal(w.fake.calls.length, n);
  assert.equal((await w.svc.endStatus('other0001tag')).error.code, 'bad_request');
});

await test('backup work after done: bounded alarm ticks while work is true, stop when it clears, nothing deleted by the service', async () => {
  const w = world({ backup: ['pending', { state: 'active', work: true }, { state: 'active', work: true }, { state: 'active', work: false }] }); await running(w);
  await w.svc.end(OWNER, { requestId: randomUUID(), mode: 'disk_backup' });
  await alarms(w, 3);
  assert.equal(rec(w).end.phase, 'done'); assert.equal(rec(w).end.backupWork, true);
  assert.ok(w.clock.alarm !== null, 'work keeps the alarm scheduled after done');
  const t0 = w.b.ticks; await alarms(w, 4);
  assert.ok(w.b.ticks > t0, 'ticked after done'); assert.equal(rec(w).end.backupWork, false); assert.equal(rec(w).end.backup, 'active');
  const t1 = w.b.ticks; await alarms(w, 3);
  assert.equal(w.b.ticks, t1, 'no ticks once work is false');
  assert.equal(ops(w.fake, 'removeSnapshot').length, 0); assert.equal(ops(w.fake, 'start').length, 0, 'no restart');
  const c = world({ backup: [{ state: 'coalesced', work: true }] }); await running(c);
  await c.svc.end(OWNER, { requestId: randomUUID(), mode: 'disk_backup' });
  await alarms(c, 400);
  assert.equal(rec(c).end.phase, 'done'); assert.equal(rec(c).end.backup, 'coalesced'); assert.equal(rec(c).end.backupWork, false, 'bounded');
  assert.ok(c.b.ticks <= 362); assert.equal(ops(c.fake, 'stop').length, 1);
});

await test('computerBackupProtectedNames: storage only, prepared images + template + machine template + manual captures, fails closed', async () => {
  const w = world(); await running(w);
  const kv = { async get(k) { return structuredClone(w.kv.get(k)); } };
  const env = { ...ENV, CLOUDBITE_DAYTONA_SECONDARY_API_KEY: 'k2', CLOUDBITE_COMPUTER_SECONDARY_SNAPSHOT: 'cloudbite-computer-v1-b' };
  const n = w.fake.calls.length;
  assert.deepEqual([...await M.computerBackupProtectedNames(env, kv, OWNER)].sort(), ['cloudbite-computer-v1', 'cloudbite-computer-v1-b']);
  const r = w.kv.get('computer');
  r.template = { account: 'primary', name: 'my-template', requestedAt: 1 }; r.machine.template = 'old-template';
  r.snapshot = { name: 'manual-now', state: 'snapshotting', polls: 0 }; r.snapshots = [{ name: 'manual-old', account: 'primary', sourceId: 'x', requestedAt: 1, state: 'active', error: null, checkedAt: null }];
  w.kv.set('computer', r);
  const got = await M.computerBackupProtectedNames(env, kv, OWNER);
  assert.ok(Object.isFrozen(got));
  for (const x of ['cloudbite-computer-v1', 'cloudbite-computer-v1-b', 'my-template', 'old-template', 'manual-now', 'manual-old']) assert.ok(got.includes(x), x);
  await assert.rejects(M.computerBackupProtectedNames(env, kv, 'other0001tag'));
  await assert.rejects(M.computerBackupProtectedNames(env, kv, 'BAD'));
  assert.deepEqual(await M.computerBackupProtectedNames(ENV, { async get() { return undefined; } }, OWNER), ['cloudbite-computer-v1']);
  assert.equal(w.fake.calls.length, n, 'no provider call');
});

await test('unanswered capture with the real manager: unconfirmed ends the flow as unknown within a few alarms; start works, no second create', async () => {
  const w = world(), bkv = new Map();
  const prov = { gets: 0, creates: 0, async getSnapshot() { this.gets++; return null; },
    async createSnapshot() { this.creates++; throw Object.assign(new Error('timeout'), { status: 0 }); }, async removeSnapshot() { return 'absent'; } };
  const backups = new M.ComputerBackups({ store: { get: async (k) => structuredClone(bkv.get(k)), put: async (k, v) => { bkv.set(k, structuredClone(v)); } },
    provider: prov, now: () => w.clock.now, random: Math.random, protectedNames: () => [] });
  const store = { async get(k) { return structuredClone(w.kv.get(k)); }, async put(k, v) { w.kv.set(k, structuredClone(v)); },
    async setAlarm(at) { w.clock.alarm = at; }, async deleteAlarm() { w.clock.alarm = null; } };
  w.svc = new M.ComputerService({ store, env: ENV, daytona: w.fake.api, now: () => w.clock.now, random: (n) => new Uint8Array(randomBytes(n)),
    sha256: async (s) => createHash('sha256').update(s).digest('hex'), end: { backup: backups } });
  await running(w);
  await w.svc.end(OWNER, { requestId: randomUUID(), mode: 'disk_backup' });
  let n = 0; while (rec(w).end.phase !== 'done' && n < 20) { await alarms(w, 1); n++; }
  const e = rec(w).end;
  assert.ok(n <= 10, `done after ${n} alarms`); assert.equal(e.phase, 'done'); assert.equal(e.backup, 'unknown', 'never claimed saved');
  assert.equal(e.backupWork, false); assert.equal((await backups.summary(OWNER)).items[0].state, 'unconfirmed', 'still owned and blocking');
  const st = await w.svc.start(OWNER, { requestId: randomUUID(), account: 'primary' });
  assert.equal(st.ok, true); assert.equal(ops(w.fake, 'start').length, 1);
  const gets = prov.gets; await alarms(w, 30);
  assert.equal(prov.creates, 1, 'no second create'); assert.equal(prov.gets, gets, 'no further automatic reads');
  // unknown with work still true (create unanswered, not yet unconfirmed) keeps backing_up as before
  const p = world({ backup: [{ state: 'unknown', work: true }, { state: 'unknown', work: true }, 'active'] }); await running(p);
  await p.svc.end(OWNER, { requestId: randomUUID(), mode: 'disk_backup' });
  await alarms(p, 3); assert.equal(rec(p).end.phase, 'backing_up');
  await alarms(p, 1); assert.equal(rec(p).end.phase, 'done'); assert.equal(rec(p).end.backup, 'active');
});

await test('drain leaves resume owed: after a successful end, the next start of the same machine resumes once (alarm, not GET)', async () => {
  const w = world({ drain: [CLEAN], backup: ['active'] }); await running(w);
  const id = randomUUID();
  await w.svc.end(OWNER, { requestId: id, mode: 'files_verified' });
  await alarms(w, 3);
  assert.equal(rec(w).end.phase, 'done'); assert.equal(w.d.resumes, 0, 'never resumed while stopped');
  assert.equal(rec(w).resume.machineId, rec(w).machine.id); assert.equal(rec(w).resume.requestId, id);
  await alarms(w, 3); assert.equal(w.d.resumes, 0);
  const st = await w.svc.start(OWNER, { requestId: randomUUID(), account: 'primary' });
  assert.equal(st.ok, true); assert.equal(w.d.resumes, 0, 'start itself does not call the hook');
  for (let k = 0; k < 3; k++) await w.svc.state(OWNER);
  assert.equal(w.d.resumes, 0, 'GET state never dispatches it');
  assert.ok(w.clock.alarm !== null);
  await alarms(w, 1);
  assert.equal(w.d.resumes, 1); assert.equal(rec(w).resume, null);
  await alarms(w, 5); assert.equal(w.d.resumes, 1, 'once');
  assert.equal(ops(w.fake, 'start').length, 1, 'no new provider start');
});

await test('owed resume survives a DO restart and a failing hook (bounded per run, retried on the next run of the same machine)', async () => {
  const shared = { kv: new Map(), clock: { now: 1_800_000_000_000, alarm: null }, fake: fakeDaytona() };
  const w = world({ shared, drain: [CLEAN], backup: ['active'] }); await running(w);
  await w.svc.end(OWNER, { requestId: randomUUID(), mode: 'files_verified' });
  await alarms(w, 3); assert.equal(rec(w).end.phase, 'done');
  const w2 = world({ shared, drain: [CLEAN], backup: ['active'] }); // evicted DO, fresh instance
  let calls = 0; w2.svc.d.end.resume = async () => { calls++; throw new Error('agent not reachable'); };
  await w2.svc.start(OWNER, { requestId: randomUUID(), account: 'primary' });
  await alarms(w2, 20);
  assert.equal(calls, 6, 'bounded tries in this run'); assert.ok(rec(w2).resume, 'still owed');
  await w2.svc.stop(OWNER, { requestId: randomUUID() }); await alarms(w2, 1);
  const w3 = world({ shared, drain: [CLEAN], backup: ['active'] });
  await w3.svc.start(OWNER, { requestId: randomUUID(), account: 'primary' });
  await alarms(w3, 2);
  assert.equal(w3.d.resumes, 1, 'the next run resumes'); assert.equal(rec(w3).resume, null);
  assert.equal(ops(shared.fake, 'start').length, 2);
  // a blocked end still resumes at once; a failure there is retried by the alarm
  const b = world({ drain: [{ ok: false, code: 'agent_missing', retryable: false }] }); await running(b);
  let fails = 1; const ok = b.d.resume; b.svc.d.end.resume = async (...a) => { if (fails-- > 0) throw new Error('x'); return ok(...a); };
  await b.svc.end(OWNER, { requestId: randomUUID(), mode: 'files_verified' });
  await alarms(b, 1); assert.equal(rec(b).end.phase, 'blocked'); assert.equal(b.d.resumes, 0);
  await alarms(b, 1); assert.equal(b.d.resumes, 1); assert.equal(rec(b).resume, null);
});

await test('ordinary stop (no drain, no end) then start of the same machine owes and makes exactly one resume of that run', async () => {
  const w = world({ drain: [CLEAN] }); await running(w);
  assert.equal(rec(w).resume ?? null, null, 'creating a new machine owes nothing'); await alarms(w, 3); assert.equal(w.d.resumes, 0);
  await w.svc.stop(OWNER, { requestId: randomUUID() }); await alarms(w, 2);
  assert.equal(rec(w).status, 'stopped'); assert.equal(w.d.calls.length, 0, 'a plain stop never drains'); assert.equal(rec(w).end ?? null, null);
  const seen = []; const ok = w.d.resume; w.svc.d.end.resume = async (m, id) => { seen.push({ m, id, saved: structuredClone(rec(w).resume) }); return ok(m, id); };
  const sid = randomUUID();
  w.fake.onStart = () => assert.equal(rec(w).resume.machineId, rec(w).machine.id, 'owed before the provider start');
  assert.equal((await w.svc.start(OWNER, { requestId: sid, account: 'primary' })).ok, true);
  assert.equal(w.d.resumes, 0, 'start itself does not call the hook');
  for (let k = 0; k < 3; k++) await w.svc.state(OWNER);
  assert.equal(w.d.resumes, 0, 'GET state never dispatches it');
  await alarms(w, 1);
  assert.equal(w.d.resumes, 1); assert.equal(seen[0].id, sid); assert.equal(seen[0].m.id, rec(w).machine.id); assert.equal(seen[0].m.status, 'running');
  assert.equal(seen[0].saved.tries, 1, 'attempt persisted before the call'); assert.equal(rec(w).resume, null);
  await alarms(w, 5); assert.equal(w.d.resumes, 1, 'once per run');
  assert.equal(ops(w.fake, 'start').length, 1, 'no hidden provider start'); assert.equal(ops(w.fake, 'create').length, 1);
  // an already-running start only extends the session: no new owed resume, no provider start or stop
  const s2 = await w.svc.start(OWNER, { requestId: randomUUID(), account: 'primary' });
  assert.equal(s2.status, 'running'); assert.equal(rec(w).resume, null);
  await alarms(w, 3); assert.equal(w.d.resumes, 1);
  assert.equal(ops(w.fake, 'start').length, 1); assert.equal(ops(w.fake, 'stop').length, 1);
  // replay of the original start id changes nothing
  await w.svc.start(OWNER, { requestId: sid, account: 'primary' }); assert.equal(rec(w).resume, null);
  // the deadline stop is a stop too: the next start resumes once more
  w.clock.now = rec(w).sessionEndsAt; await w.svc.alarm(); await alarms(w, 1); assert.equal(rec(w).status, 'stopped');
  await w.svc.start(OWNER, { requestId: randomUUID(), account: 'primary' }); await alarms(w, 3);
  assert.equal(w.d.resumes, 2); assert.equal(ops(w.fake, 'start').length, 2);
});

await test('start answer lost and DO restart: the owed resume persists and runs once the same machine is observed running; bounded, GET-free', async () => {
  const shared = { kv: new Map(), clock: { now: 1_800_000_000_000, alarm: null }, fake: fakeDaytona() };
  const w = world({ shared, drain: [CLEAN] }); await running(w);
  await w.svc.stop(OWNER, { requestId: randomUUID() }); await alarms(w, 1);
  const real = shared.fake.api.start; let landed = 0;
  shared.fake.api.start = async (c, id) => { await real(c, id); landed++; shared.fake.sandboxes.forEach((s) => { s.state = 'starting'; }); throw new M.ComputerDaytonaError(0, 'start'); };
  const sid = randomUUID();
  await w.svc.start(OWNER, { requestId: sid, account: 'primary' });
  assert.equal(landed, 1); assert.equal(rec(w).status, 'unknown'); assert.equal(rec(w).resume.requestId, sid);
  shared.fake.api.start = real;
  const w2 = world({ shared, drain: [CLEAN] }); // evicted DO, fresh instance
  let calls = 0; w2.svc.d.end.resume = async () => { calls++; throw new Error('watcher not reachable yet'); };
  await alarms(w2, 3); assert.equal(rec(w2).status, 'starting'); assert.equal(calls, 0, 'never while the machine is not running');
  shared.fake.sandboxes.forEach((s) => { s.state = 'started'; });
  for (let k = 0; k < 3; k++) await w2.svc.state(OWNER);
  assert.equal(rec(w2).status, 'running'); assert.equal(calls, 0, 'GET observes running but never dispatches');
  await alarms(w2, 20);
  assert.equal(calls, 6, 'bounded tries in this run'); assert.ok(rec(w2).resume, 'still owed');
  w2.svc.d.end.resume = w2.d.resume; await alarms(w2, 5); assert.equal(w2.d.resumes, 0, 'no more tries in the same run');
  assert.equal(ops(shared.fake, 'start').length, 1, 'the lost start was never re-sent');
  await w2.svc.stop(OWNER, { requestId: randomUUID() }); await alarms(w2, 1);
  await w2.svc.start(OWNER, { requestId: randomUUID(), account: 'primary' }); await alarms(w2, 2);
  assert.equal(w2.d.resumes, 1, 'the next run resumes'); assert.equal(rec(w2).resume, null);
});

await test('no resume hook: start/stop/start keeps the old behavior and records nothing owed', async () => {
  const w = world({ backup: ['active'] }); await running(w);
  await w.svc.stop(OWNER, { requestId: randomUUID() }); await alarms(w, 1);
  await w.svc.start(OWNER, { requestId: randomUUID(), account: 'primary' });
  assert.equal(rec(w).resume ?? null, null); await alarms(w, 3);
  assert.equal(rec(w).status, 'running'); assert.equal(ops(w.fake, 'start').length, 1);
  const p = world(); await running(p);
  await p.svc.stop(OWNER, { requestId: randomUUID() }); await alarms(p, 1);
  await p.svc.start(OWNER, { requestId: randomUUID(), account: 'primary' });
  assert.equal(rec(p).resume ?? null, null);
});

await test('lost answer of the 12th drain after a restart: a user end turns blocked and resumes; a deadline end still stops at the deadline', async () => {
  const w = world({ drain: [{ ...CLEAN, dirty: 1 }] }); await running(w);
  await w.svc.end(OWNER, { requestId: randomUUID(), mode: 'files_verified' });
  await alarms(w, 1);
  const r = rec(w); r.end.drains = 12; w.kv.set('computer', r); // the 12th attempt was persisted, its answer lost
  await alarms(w, 1);
  assert.equal(rec(w).end.phase, 'blocked'); assert.equal(rec(w).end.files, 'blocked'); assert.equal(w.d.resumes, 1);
  assert.equal(w.d.calls.length, 1, 'no drain beyond the budget'); assert.equal(ops(w.fake, 'stop').length, 0);
  assert.equal((await w.svc.start(OWNER, { requestId: randomUUID(), account: 'primary' })).ok, true, 'not busy any more');

  const d = world({ drain: [{ ...CLEAN, dirty: 1 }] }); await running(d);
  await d.svc.endSettings(OWNER, { requestId: randomUUID(), autoEnd: 'files_verified' });
  const deadline = rec(d).sessionEndsAt;
  d.clock.now = deadline - 5 * 60_000; await d.svc.alarm();
  const x = rec(d); x.end.drains = 12; d.kv.set('computer', x);
  await alarms(d, 3);
  assert.equal(rec(d).end.phase, 'draining', 'no early stop of the paid session'); assert.equal(ops(d.fake, 'stop').length, 0);
  d.clock.now = deadline; await d.svc.alarm();
  assert.equal(ops(d.fake, 'stop').length, 1); assert.equal(rec(d).end.files, 'pending');
});

await test('definite stop refusal keeps the hard deadline and retries a bounded number of times; an unanswered stop is never re-sent', async () => {
  const w = world(); await running(w);
  const deadline = rec(w).sessionEndsAt;
  w.fake.fail.stop = [{ status: 409 }, { status: 409 }];
  w.clock.now = deadline; await w.svc.alarm();
  assert.equal(ops(w.fake, 'stop').length, 1); assert.ok(rec(w).sessionEndsAt >= deadline, 'deadline kept');
  await alarms(w, 3);
  assert.equal(ops(w.fake, 'stop').length, 3); assert.equal(rec(w).status, 'stopped'); assert.equal(rec(w).sessionEndsAt, null);
  const z = world(); await running(z);
  z.fake.fail.stop = [{ status: 409 }, { status: 409 }, { status: 409 }, { status: 409 }, { status: 409 }];
  z.clock.now = rec(z).sessionEndsAt; await z.svc.alarm();
  await alarms(z, 10);
  assert.equal(ops(z.fake, 'stop').length, 4, '1 + 3 bounded retries'); assert.equal(rec(z).sessionEndsAt, null);
  const u = world(); await running(u);
  u.fake.fail.stop = [{ status: 0 }];
  u.clock.now = rec(u).sessionEndsAt; await u.svc.alarm();
  await alarms(u, 5);
  assert.equal(ops(u.fake, 'stop').length, 1, 'uncertain stop reconciled by GET only'); assert.equal(rec(u).sessionEndsAt, null);
  // a user end whose stop is refused fails, but the machine keeps its deadline
  const e = world(); await running(e);
  const dl = rec(e).sessionEndsAt; e.fake.fail.stop = [{ status: 409 }];
  await e.svc.end(OWNER, { requestId: randomUUID(), mode: 'disk_backup' });
  await alarms(e, 1);
  assert.equal(rec(e).end.phase, 'failed'); assert.equal(rec(e).sessionEndsAt, dl);
});

// ───────────────────────── main page (generated CLOUDBITE_COMPUTER_JS in a tiny fake DOM; not browser evidence) ─────────────────────────

class El {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.attrs = {}; this.listeners = {}; this.parent = null;
    this.className = ''; this._text = ''; this.value = ''; this.disabled = false; this.hidden = false; this.title = ''; this.id = ''; }
  get parentElement() { return this.parent; }
  get textContent() { return this._text + this.children.map((c) => typeof c === 'string' ? c : c.textContent).join(''); }
  set textContent(v) { for (const c of this.children) if (typeof c !== 'string') c.parent = null; this.children = []; this._text = String(v); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }
  append(...ns) { for (const n of ns) { if (typeof n === 'string') { this.children.push(n); continue; } if (n.parent) n.remove(); n.parent = this; this.children.push(n); } }
  replaceChildren(...ns) { for (const c of this.children) if (typeof c !== 'string') c.parent = null; this.children = []; this._text = ''; this.append(...ns); }
  remove() { if (this.parent) { this.parent.children = this.parent.children.filter((c) => c !== this); this.parent = null; } }
  click() { if (!this.disabled) for (const f of this.listeners.click || []) f({ type: 'click', target: this, preventDefault() {} }); }
  *walk() { for (const c of this.children) if (typeof c !== 'string') { yield c; yield* c.walk(); } }
  shown() { let n = this; while (n) { if (n.hidden) return false; n = n.parent; } return true; }
}
const { CLOUDBITE_COMPUTER_JS } = await import(pathToFileURL(join(process.cwd(), 'src/cloudbite-computer-page.ts')));
const API = '/api/cloudbite/computer';
const MACHINE_VIEW = { id: 'sb-1', name: 'cloudbite-computer-owner', account: 'primary', region: 'us', cpu: 4, memoryGiB: 8, diskGiB: 10 };
const pageState = (o = {}) => ({ ok: true, status: 'running', error: null, machine: MACHINE_VIEW, sessionEndsAt: null, snapshot: null, ready: true,
  configuredAccounts: [{ id: 'primary', label: 'Primary', available: true }], ...o });
const reply = (status, body) => Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body });
function page({ search = '?lang=ko', endGet, onEnd }) {
  const s = { cur: pageState() }, requests = [];
  const doc = { title: '', documentElement: { lang: 'en' }, visibilityState: 'visible', listeners: {}, createElement: (t) => new El(t),
    getElementById: (id) => (id === 'cb-computer' ? root : null), addEventListener(t, f) { (this.listeners[t] ||= []).push(f); } };
  const root = new El('div');
  const route = (r) => {
    if (r.url === `${API}/auth/session`) return reply(200, { authenticated: true, hasCredentials: true });
    if (r.url === `${API}/state`) return reply(200, s.cur);
    if (r.url === `${API}/end` && r.method === 'GET') return endGet ? reply(200, endGet) : reply(404, { error: { code: 'not_found', message: 'x' } });
    if (r.url === `${API}/end` && r.method === 'POST') return onEnd(r, s);
    return reply(404, { error: { code: 'not_found', message: 'x' } });
  };
  const ctx = vm.createContext({ document: doc, location: { pathname: '/cloudbite/computer', search, hash: '' }, history: { replaceState() {} },
    URLSearchParams, URL, atob, btoa, Date, Uint8Array, ArrayBuffer, AbortController, crypto: webcrypto, addEventListener() {},
    navigator: { language: 'ko-KR', credentials: { get: async () => null, create: async () => null } }, PublicKeyCredential: function PublicKeyCredential() {},
    setTimeout: () => 0, clearTimeout() {},
    fetch: (url, init = {}) => { const r = { url, method: init.method || 'GET', body: init.body === undefined ? undefined : JSON.parse(init.body) }; requests.push(r); return route(r); } });
  vm.runInContext(CLOUDBITE_COMPUTER_JS, ctx);
  const visible = () => [...root.walk()].filter((e) => e.shown());
  return { s, requests, flush: async () => { for (let i = 0; i < 40; i++) await new Promise((r) => setImmediate(r)); },
    btn: (t) => visible().find((e) => e.tagName === 'BUTTON' && e.textContent === t), links: () => visible().filter((e) => e.tagName === 'A'),
    text: () => visible().map((e) => e._text).filter(Boolean).join(' | ') };
}
const END_VIEW = (o) => ({ requestId: randomUUID(), mode: 'disk_backup', trigger: 'user', phase: 'draining', files: 'not_configured', filesVerifiedAt: null,
  filesDetail: null, diskFlushed: null, machineStopped: false, environmentBackup: 'not_requested', backupName: null, error: null,
  startedAt: '2026-10-19T03:00:00Z', updatedAt: '2026-10-19T03:00:00Z', ...o });

await test('page: no end route -> only the plain Stop; Cloud Files link keeps ?lang', async () => {
  const p = page({ endGet: null, onEnd: () => assert.fail('no end') });
  await p.flush();
  assert.ok(p.btn('중지')); assert.equal(p.btn('종료하고 환경 보관'), undefined); assert.equal(p.btn('파일 저장 확인 후 종료'), undefined);
  assert.ok(p.links().some((a) => a.getAttribute('href') === '/cloudbite/computer/files?lang=ko' && a.textContent === '클라우드 파일'));
  assert.equal(p.requests.filter((r) => r.url === `${API}/end`).length, 1, 'modes read once');
});

await test('page: backup-only config offers "종료하고 환경 보관" -> disk_backup; files and backup states stay separate', async () => {
  const p = page({ endGet: { ok: true, end: null, autoEnd: null, modes: { disk_backup: true, files_verified: false }, backupConfigured: true, uploadsFrozen: false },
    onEnd: (r, s) => { s.cur = pageState({ end: END_VIEW({ requestId: r.body.requestId }) }); return reply(200, { ok: true, end: s.cur.end }); } });
  await p.flush();
  p.btn('종료하고 환경 보관').click(); await p.flush();
  const post = p.requests.find((r) => r.method === 'POST' && r.url === `${API}/end`);
  assert.deepEqual(Object.keys(post.body).sort(), ['mode', 'requestId']); assert.equal(post.body.mode, 'disk_backup');
  assert.match(p.text(), /정지 준비 중/); assert.match(p.text(), /클라우드 파일: 설정 안 됨/); assert.match(p.text(), /환경 백업: 정지가 확인되면/);
  assert.equal(p.btn('종료하고 환경 보관'), undefined, 'no second end while one runs');
});

await test('page: files_verified config offers "파일 저장 확인 후 종료"; blocked says the computer keeps running', async () => {
  const p = page({ endGet: { ok: true, end: null, autoEnd: null, modes: { disk_backup: true, files_verified: true }, backupConfigured: false, uploadsFrozen: false },
    onEnd: (r, s) => { s.cur = pageState({ end: END_VIEW({ mode: 'files_verified', phase: 'blocked', files: 'blocked', environmentBackup: 'not_configured' }) }); return reply(200, { ok: true }); } });
  await p.flush();
  p.btn('파일 저장 확인 후 종료').click(); await p.flush();
  assert.equal(p.requests.find((r) => r.method === 'POST' && r.url === `${API}/end`).body.mode, 'files_verified');
  assert.match(p.text(), /계속 실행 중/); assert.match(p.text(), /아직 저장되지 않은 파일/);
  assert.ok(p.btn('파일 저장 확인 후 종료'), 'a blocked end can be tried again');
});

console.log(`${passed} cloudbite-computer-end-session tests passed`);
