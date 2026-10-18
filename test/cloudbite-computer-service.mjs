// CloudbiteComputer service against a fake Daytona (fixture exported as fakeDaytona). No provider network.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { build } from 'esbuild';

const tmp = mkdtempSync(join(tmpdir(), 'cloudbite-computer-'));
const built = await build({ stdin: { contents: `export * from './src/cloudbite-computer-service.ts'; export * from './src/cloudbite-computer-contract.ts'; export { ComputerDaytonaError } from './src/cloudbite-computer-daytona.ts';`, resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, write: false, platform: 'node', format: 'esm', plugins: [{ name: 'cf', setup(b) {
    b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'cf', namespace: 'stub' }));
    b.onLoad({ filter: /^cf$/, namespace: 'stub' }, () => ({ contents: 'export class DurableObject { constructor(ctx,env){this.ctx=ctx;this.env=env;} }' }));
  } }] });
writeFileSync(join(tmp, 'm.mjs'), built.outputFiles[0].text);
const M = await import(pathToFileURL(join(tmp, 'm.mjs')));
globalThis.fetch = async () => { throw new Error('provider network forbidden'); };

const OWNER = 'owner0001tag';
const ENV = { CLOUDBITE_DAYTONA_API_KEY: 'k1', CLOUDBITE_COMPUTER_SNAPSHOT: 'cloudbite-computer-v1', CLOUDBITE_DAYTONA_SECONDARY_API_KEY: 'k2',
  CLOUDBITE_COMPUTER_GATEWAY_ORIGIN: 'https://gw.example.workers.dev' };

/** Fake Daytona: records every call; `fail` maps an op to a queue of errors; sandboxes by name. */
export function fakeDaytona() {
  const f = { calls: [], sandboxes: new Map(), snapshots: new Map([['cloudbite-computer-v1', { name: 'cloudbite-computer-v1', state: 'active' }]]),
    fail: {}, health: false, script: true, onCreate: null, hang: {}, probe: null };
  const hang = (op) => f.hang[op] ? new Promise(() => {}) : null;
  const err = (op) => { const q = f.fail[op]; return q && q.length ? q.shift() : null; };
  const byId = (id) => [...f.sandboxes.values()].find((s) => s.id === id || s.name === id) ?? null;
  f.api = {
    async create(c, body) { f.calls.push(['create', body]); f.onCreate?.(); const e = err('create'); const sb = { id: 'sb-' + randomBytes(6).toString('hex'), name: body.name, labels: body.labels, state: 'started', target: 'us', cpu: 4, memory: 8, disk: 10 };
      if (e?.landed) f.sandboxes.set(body.name, sb); if (e) throw new M.ComputerDaytonaError(e.status, 'create'); f.sandboxes.set(body.name, sb); return sb; },
    async get(c, idOrName) { f.calls.push(['get', idOrName]); if (f.hang.get) return hang('get'); const e = err('get'); if (e) throw new M.ComputerDaytonaError(e.status, 'get'); return byId(idOrName); },
    async start(c, id) { f.calls.push(['start', id]); byId(id).state = 'started'; },
    async stop(c, id) { f.calls.push(['stop', id]); const e = err('stop'); if (e) throw new M.ComputerDaytonaError(e.status, 'stop'); byId(id).state = 'stopped'; },
    async createSnapshot(c, id, name) { f.calls.push(['createSnapshot', id, name]); assert.equal(byId(id).state, 'stopped', 'cold snapshot requires stopped');
      if (f.hang.createSnapshot) return hang('createSnapshot');
      const landed = { name, state: 'snapshotting', ...(f.snapshotInfo ? f.snapshotInfo(id) : { sourceSandboxId: id }) };
      const e = err('createSnapshot'); if (e?.landed) f.snapshots.set(name, landed); if (e) throw new M.ComputerDaytonaError(e.status, 'snapshot'); f.snapshots.set(name, landed); },
    async getSnapshot(c, name) { f.calls.push(['getSnapshot', name]); const e = err('getSnapshot'); if (e) throw new M.ComputerDaytonaError(e.status, 'snapshot-get'); return f.snapshots.get(name) ?? null; },
    async preview(c, id, port) { f.calls.push(['preview', id, port]); if (f.previewGate) await f.previewGate; return { url: f.previewUrl ?? `https://${port}-${id}.proxy.daytona.works`, token: 'preview-secret' }; },
    async exec(c, sb, command) { f.calls.push(['exec', command]); if (command.startsWith('curl')) return { exitCode: f.health ? 0 : 7, result: '' }; if (command.startsWith('test -x')) return { exitCode: f.script ? 0 : 1, result: '' };
      if (command.includes('probe')) return f.probe ? { exitCode: 0, result: f.probe } : { exitCode: 1, result: '' }; return { exitCode: 1, result: '' }; },
    async computerUseStart() { f.calls.push(['computerUseStart']); },
    async spawn(c, sb, sid, command) { f.calls.push(['spawn', command]); assert.equal(f.calls.at(-2)[0], 'computerUseStart'); f.health = true; },
  };
  return f;
}

function world(env = ENV, shared) {
  const kv = shared?.kv ?? new Map(); const clock = shared?.clock ?? { now: 1_800_000_000_000, alarm: null };
  const store = { async get(k) { return structuredClone(kv.get(k)); }, async put(k, v) { kv.set(k, structuredClone(v)); },
    async setAlarm(at) { clock.alarm = at; }, async deleteAlarm() { clock.alarm = null; } };
  const fake = shared?.fake ?? fakeDaytona();
  const svc = new M.ComputerService({ store, env, daytona: fake.api, now: () => clock.now, random: (n) => new Uint8Array(randomBytes(n)),
    sha256: async (s) => createHash('sha256').update(s).digest('hex') });
  return { svc, fake, kv, clock, get alarm() { return clock.alarm; }, tick(ms) { clock.now += ms; }, get now() { return clock.now; } };
}
/** Running machine with a ready desktop (start, launcher, health). */
async function ready(w) {
  await w.svc.start(OWNER, { requestId: randomUUID(), account: 'primary' });
  await w.svc.alarm(); await w.svc.alarm();
  assert.equal((await w.svc.state(OWNER)).ready, true);
}
const desktopCookie = async (w) => (await w.svc.redeemTicket(new URL((await w.svc.launch(OWNER)).url).searchParams.get('cbt'))).cookie;
const settle = () => new Promise((r) => setTimeout(r, 5));
const ops = (f, op) => f.calls.filter((c) => c[0] === op);
let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log('ok', name); };

await test('state on an absent computer makes no provider calls and lists accounts', async () => {
  const w = world();
  const s = await w.svc.state(OWNER);
  assert.equal(s.ok, true); assert.equal(s.status, 'absent'); assert.equal(s.ready, false);
  assert.deepEqual(s.configuredAccounts.map((a) => [a.id, a.available]), [['primary', true], ['secondary', true], ['tertiary', false]]);
  assert.equal(w.fake.calls.length, 0);
});

await test('missing prepared snapshot fails clearly and creates nothing', async () => {
  const w = world({ ...ENV, CLOUDBITE_COMPUTER_SNAPSHOT: undefined });
  const r = await w.svc.start(OWNER, { requestId: randomUUID(), account: 'primary' });
  assert.equal(r.error.code, 'missing_image'); assert.equal(ops(w.fake, 'create').length, 0);
  const w2 = world(); w2.fake.snapshots.clear();
  assert.equal((await w2.svc.start(OWNER, { requestId: randomUUID(), account: 'primary' })).error.code, 'missing_image');
  assert.equal(ops(w2.fake, 'create').length, 0);
  assert.equal((await w.svc.start(OWNER, { requestId: randomUUID(), account: 'tertiary' })).error.code, 'not_configured');
});

await test('start writes the ledger first, creates a persistent labelled machine once, and never switches accounts', async () => {
  const w = world(); const id = randomUUID();
  w.fake.onCreate = () => { const rec = w.kv.get('computer'); assert.equal(rec.machine.created, 'pending'); assert.equal(rec.machine.name, `cloudbite-computer-primary-${OWNER}`); };
  const r = await w.svc.start(OWNER, { requestId: id, account: 'primary' });
  assert.equal(r.status, 'running'); assert.equal(r.machine.account, 'primary'); assert.equal(r.desktop, 'starting');
  const body = ops(w.fake, 'create')[0][1];
  assert.deepEqual(body, { name: `cloudbite-computer-primary-${OWNER}`, snapshot: 'cloudbite-computer-v1', labels: { 'cloudbite-computer': OWNER, 'cloudbite-computer-account': 'primary' },
    public: false, autoStopInterval: 130, autoDeleteInterval: -1 });
  assert.ok(!('cpu' in body) && !('image' in body) && !('ephemeral' in body));
  assert.equal(Date.parse(r.sessionEndsAt) - w.now, 2 * 3600_000);
  await w.svc.start(OWNER, { requestId: id, account: 'primary' });
  assert.equal(ops(w.fake, 'create').length, 1, 'replay does not mutate');
  assert.equal((await w.svc.start(OWNER, { requestId: randomUUID(), account: 'secondary' })).error.code, 'account_mismatch');
  assert.equal((await w.svc.stop(OWNER, { requestId: id })).error.code, 'request_conflict');
  assert.equal((await w.svc.start(OWNER, { requestId: 'nope', account: 'primary' })).error.code, 'bad_request');
  assert.equal((await w.svc.state('other0001tag')).error.code, 'bad_request');
});

await test('an unknown create outcome is reconciled by exact name and labels, never retried', async () => {
  const w = world();
  w.fake.fail.create = [{ status: 0, landed: true }];
  const r = await w.svc.start(OWNER, { requestId: randomUUID(), account: 'primary' });
  assert.equal(r.status, 'unknown'); assert.equal(r.error, 'unknown_outcome');
  assert.ok(w.alarm, 'alarm reconciles');
  await w.svc.alarm();
  const s = await w.svc.state(OWNER);
  assert.equal(s.status, 'running'); assert.ok(s.machine.id); assert.equal(ops(w.fake, 'create').length, 1);
  assert.equal(ops(w.fake, 'get')[0][1], `cloudbite-computer-primary-${OWNER}`);
});

await test('an unknown create that never appears ends absent without a second create; a foreign same-name sandbox is not adopted', async () => {
  const w = world();
  w.fake.fail.create = [{ status: 503 }];
  await w.svc.start(OWNER, { requestId: randomUUID(), account: 'primary' });
  for (let i = 0; i < 31; i++) await w.svc.alarm();
  const s = await w.svc.state(OWNER);
  assert.equal(s.status, 'absent'); assert.equal(s.error, 'unknown_outcome'); assert.equal(ops(w.fake, 'create').length, 1);
  const w2 = world();
  w2.fake.fail.create = [{ status: 409 }];
  w2.fake.sandboxes.set(`cloudbite-computer-primary-${OWNER}`, { id: 'sb-foreign', name: `cloudbite-computer-primary-${OWNER}`, labels: { other: 'x' }, state: 'started' });
  await w2.svc.start(OWNER, { requestId: randomUUID(), account: 'primary' });
  const s2 = await w2.svc.state(OWNER);
  assert.equal(s2.status, 'error'); assert.equal(s2.machine.id, null);
  assert.equal(ops(w2.fake, 'stop').length + ops(w2.fake, 'start').length, 0);
});

await test('desktop becomes ready only after the fixed launcher answers health; missing launcher is missing_image', async () => {
  const w = world(); w.fake.script = false;
  await w.svc.start(OWNER, { requestId: randomUUID(), account: 'primary' });
  assert.equal((await w.svc.launch(OWNER)).error.code, 'desktop_unavailable');
  await w.svc.alarm();
  let s = await w.svc.state(OWNER); assert.equal(s.desktop, 'missing_image'); assert.equal(s.ready, false);
  assert.equal((await w.svc.launch(OWNER)).error.code, 'missing_image');
  const w2 = world();
  await w2.svc.start(OWNER, { requestId: randomUUID(), account: 'primary' });
  await w2.svc.alarm(); // health fails -> spawn launcher
  assert.deepEqual(ops(w2.fake, 'spawn')[0], ['spawn', '/opt/cloudbite/computer/bin/cloudbite-start-desktop']);
  await w2.svc.alarm(); // health ok
  s = await w2.svc.state(OWNER); assert.equal(s.desktop, 'ready'); assert.equal(s.ready, true);
  assert.ok(ops(w2.fake, 'exec').some((c) => c[1].includes('http://127.0.0.1:8082/p/_cloudbite/computer/desktop/api/health')));
});

await test('launch ticket is single use, cookie maps to a validated upstream and the token never appears in client results', async () => {
  const w = world();
  await w.svc.start(OWNER, { requestId: randomUUID(), account: 'primary' });
  await w.svc.alarm(); await w.svc.alarm();
  const l = await w.svc.launch(OWNER);
  const u = new URL(l.url);
  assert.equal(u.origin, 'https://gw.example.workers.dev'); assert.equal(u.pathname, '/p/_cloudbite/computer/desktop/');
  const ticket = u.searchParams.get('cbt'); assert.match(ticket, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(!JSON.stringify(l).includes('preview-secret') && !JSON.stringify(await w.svc.state(OWNER)).includes('preview-secret'));
  assert.ok(!JSON.stringify(w.kv.get('computer').tickets).includes(ticket), 'only the hash is stored');
  const red = await w.svc.redeemTicket(ticket);
  assert.equal(red.ok, true); assert.ok(red.maxAge > 0 && red.maxAge <= 7200);
  assert.equal((await w.svc.redeemTicket(ticket)).error.code, 'ticket_invalid');
  const up = await w.svc.desktopUpstream(red.cookie);
  assert.match(up.origin, /^https:\/\/8082-sb-[0-9a-f]+\.proxy\.daytona\.works$/); assert.equal(up.token, 'preview-secret');
  assert.equal((await w.svc.desktopUpstream('x'.repeat(43))).error.code, 'ticket_invalid');
  const l2 = new URL((await w.svc.launch(OWNER)).url).searchParams.get('cbt');
  w.tick(61_000);
  assert.equal((await w.svc.redeemTicket(l2)).error.code, 'ticket_invalid', 'tickets expire');
  const w3 = world(); w3.fake.previewUrl = 'https://evil.example.com';
  await w3.svc.start(OWNER, { requestId: randomUUID(), account: 'primary' }); await w3.svc.alarm(); await w3.svc.alarm();
  const c3 = (await w3.svc.redeemTicket(new URL((await w3.svc.launch(OWNER)).url).searchParams.get('cbt'))).cookie;
  assert.equal((await w3.svc.desktopUpstream(c3)).error.code, 'desktop_unavailable');
});

await test('the 2h session alarm stops (never deletes) the machine and revokes desktop cookies; extend is bounded', async () => {
  const w = world();
  await w.svc.start(OWNER, { requestId: randomUUID(), account: 'primary' });
  await w.svc.alarm(); await w.svc.alarm();
  const cookie = (await w.svc.redeemTicket(new URL((await w.svc.launch(OWNER)).url).searchParams.get('cbt'))).cookie;
  w.tick(3600_000);
  const e = await w.svc.extend(OWNER, { requestId: randomUUID() });
  assert.equal(Date.parse(e.sessionEndsAt) - w.now, 2 * 3600_000);
  w.tick(2 * 3600_000 + 1);
  await w.svc.alarm();
  const s = await w.svc.state(OWNER);
  assert.equal(s.status, 'stopped'); assert.equal(s.sessionEndsAt, null); assert.ok(s.machine.id);
  assert.equal(ops(w.fake, 'stop').length, 1);
  assert.equal((await w.svc.desktopUpstream(cookie)).error.code, 'ticket_invalid');
  assert.equal((await w.svc.extend(OWNER, { requestId: randomUUID() })).error.code, 'not_running');
  await w.svc.start(OWNER, { requestId: randomUUID(), account: 'primary' });
  assert.equal(ops(w.fake, 'start').length, 1); assert.equal(ops(w.fake, 'create').length, 1, 'resume reuses the machine');
});

await test('snapshot stops first, captures cold filesystem by name and polls to active via alarm', async () => {
  const w = world();
  await w.svc.start(OWNER, { requestId: randomUUID(), account: 'primary' });
  assert.equal((await w.svc.snapshot(OWNER, { requestId: randomUUID(), name: 'Bad Name' })).error.code, 'snapshot_name');
  const r = await w.svc.snapshot(OWNER, { requestId: randomUUID(), name: 'my-env-1' });
  assert.equal(r.snapshot.state, 'waiting_stop'); assert.equal(ops(w.fake, 'stop').length, 1); assert.equal(ops(w.fake, 'createSnapshot').length, 0);
  assert.equal((await w.svc.start(OWNER, { requestId: randomUUID(), account: 'primary' })).error.code, 'busy');
  await w.svc.alarm();
  assert.deepEqual(ops(w.fake, 'createSnapshot')[0].slice(2), ['my-env-1']);
  w.fake.snapshots.get('my-env-1').state = 'active';
  await w.svc.alarm();
  const s = await w.svc.state(OWNER);
  assert.deepEqual(s.snapshot, { name: 'my-env-1', state: 'active', error: null }); assert.equal(s.status, 'stopped');
  // Unknown snapshot request is reconciled by name, not resubmitted.
  w.fake.fail.createSnapshot = [{ status: 0, landed: true }];
  const r2 = await w.svc.snapshot(OWNER, { requestId: randomUUID(), name: 'my-env-2' });
  assert.equal(r2.snapshot.state, 'unknown');
  await w.svc.alarm();
  assert.equal((await w.svc.state(OWNER)).snapshot.state, 'snapshotting');
  assert.equal(ops(w.fake, 'createSnapshot').length, 2);
});

await test('an unconfirmed stop stays unknown and is resolved by reading state', async () => {
  const w = world();
  await w.svc.start(OWNER, { requestId: randomUUID(), account: 'primary' });
  w.fake.fail.stop = [{ status: 0 }];
  const r = await w.svc.stop(OWNER, { requestId: randomUUID() });
  assert.equal(r.status, 'unknown'); assert.equal(r.error, 'unknown_outcome');
  const s = await w.svc.state(OWNER);
  assert.equal(s.status, 'running'); assert.equal(ops(w.fake, 'stop').length, 1);
});

await test('R1 a taken snapshot name is a definite error, never adopted as this capture', async () => {
  const w = world(); await ready(w);
  const base = await w.svc.snapshot(OWNER, { requestId: randomUUID(), name: 'cloudbite-computer-v1' });
  assert.equal(base.error.code, 'snapshot_exists', 'prepared base image name');
  w.fake.snapshots.set('old-capture', { name: 'old-capture', state: 'active', sourceSandboxId: 'sb-other' });
  assert.equal((await w.svc.snapshot(OWNER, { requestId: randomUUID(), name: 'old-capture' })).error.code, 'snapshot_exists');
  assert.equal(ops(w.fake, 'stop').length + ops(w.fake, 'createSnapshot').length, 0, 'nothing stopped or captured');
  assert.equal((await w.svc.state(OWNER)).status, 'running');
  // The name is taken between the request and the alarm's capture: the second preflight refuses it.
  await w.svc.snapshot(OWNER, { requestId: randomUUID(), name: 'race-name' });
  w.fake.snapshots.set('race-name', { name: 'race-name', state: 'active' });
  await w.svc.alarm();
  assert.deepEqual((await w.svc.state(OWNER)).snapshot, { name: 'race-name', state: 'error', error: 'snapshot_exists' });
  assert.equal(ops(w.fake, 'createSnapshot').length, 0);
  // A 409 on the single create is a collision, not "maybe ours".
  w.fake.fail.createSnapshot = [{ status: 409 }];
  const r = await w.svc.snapshot(OWNER, { requestId: randomUUID(), name: 'collide-1' });
  assert.deepEqual(r.snapshot, { name: 'collide-1', state: 'error', error: 'snapshot_exists' });
  for (let i = 0; i < 3; i++) await w.svc.alarm();
  assert.equal((await w.svc.state(OWNER)).snapshot.state, 'error');
});

await test('R1 an unanswered capture becomes active only with source or after-request proof', async () => {
  const run = async (info) => {
    const w = world(); await ready(w);
    await w.svc.stop(OWNER, { requestId: randomUUID() });
    w.fake.snapshotInfo = info(w);
    w.fake.fail.createSnapshot = [{ status: 0, landed: true }];
    const r = await w.svc.snapshot(OWNER, { requestId: randomUUID(), name: 'my-env-9' });
    assert.equal(r.snapshot.state, 'unknown');
    w.fake.snapshots.get('my-env-9').state = 'active';
    await w.svc.alarm();
    assert.equal(ops(w.fake, 'createSnapshot').length, 1, 'never resubmitted');
    return { w, s: (await w.svc.state(OWNER)).snapshot };
  };
  assert.equal((await run(() => (id) => ({ sourceSandboxId: id }))).s.state, 'active');
  assert.deepEqual((await run(() => () => ({ sourceSandboxId: 'sb-someone-else' }))).s, { name: 'my-env-9', state: 'error', error: 'snapshot_exists' });
  assert.equal((await run((w) => () => ({ sourceSandboxId: null, createdAt: new Date(w.now).toISOString() }))).s.state, 'active');
  const old = await run((w) => () => ({ sourceSandboxId: null, createdAt: new Date(w.now - 3600_000).toISOString() }));
  assert.deepEqual(old.s, { name: 'my-env-9', state: 'unconfirmed', error: 'unknown_outcome' });
  const noProof = await run(() => () => ({}));
  assert.equal(noProof.s.state, 'unconfirmed');
  assert.equal(noProof.w.alarm, null, 'unconfirmed is terminal: no polling loop');
  assert.equal((await noProof.w.svc.start(OWNER, { requestId: randomUUID(), account: 'primary' })).status, 'starting', 'not busy');
});

await test('R2 a persisted "requesting" after eviction is reconciled by name within a finite budget, never resubmitted', async () => {
  const a = world(); await ready(a);
  a.fake.hang.createSnapshot = true;
  await a.svc.snapshot(OWNER, { requestId: randomUUID(), name: 'my-env-1' });
  a.svc.alarm(); // hangs inside createSnapshot after the ledger write
  await settle();
  assert.equal(a.kv.get('computer').snapshot.state, 'requesting');
  const b = world(ENV, { kv: a.kv, clock: a.clock, fake: a.fake }); a.fake.hang.createSnapshot = false;
  a.fake.fail.getSnapshot = [{ status: 0 }, { status: 503 }]; // transport errors spend the same budget
  let alarms = 0;
  while (b.alarm !== null && alarms < 100) { b.tick(10_000); await b.svc.alarm(); alarms++; }
  assert.ok(alarms <= 31, `alarm loop ends (${alarms})`);
  assert.deepEqual((await b.svc.state(OWNER)).snapshot, { name: 'my-env-1', state: 'error', error: 'unknown_outcome' });
  assert.equal(ops(a.fake, 'createSnapshot').length, 1);
  assert.equal((await b.svc.start(OWNER, { requestId: randomUUID(), account: 'primary' })).status, 'starting', 'owner can resume');
  // Same eviction, but the capture did land with our source: adopted.
  const c = world(); await ready(c);
  c.fake.hang.createSnapshot = true;
  await c.svc.snapshot(OWNER, { requestId: randomUUID(), name: 'my-env-2' });
  c.svc.alarm(); await settle();
  const d = world(ENV, { kv: c.kv, clock: c.clock, fake: c.fake });
  c.fake.snapshots.set('my-env-2', { name: 'my-env-2', state: 'active', sourceSandboxId: c.kv.get('computer').machine.id });
  await d.svc.alarm();
  assert.equal((await d.svc.state(OWNER)).snapshot.state, 'active');
});

await test('R3 extend carries currently valid desktop cookies to the new deadline; maxAge follows it', async () => {
  const w = world(); await ready(w);
  const cookie = await desktopCookie(w);
  w.tick(110 * 60_000);
  assert.equal((await w.svc.extend(OWNER, { requestId: randomUUID() })).ok, true);
  w.tick(15 * 60_000);
  const up = await w.svc.desktopUpstream(cookie);
  assert.equal(up.ok, true); assert.equal(up.maxAge, 105 * 60);
  w.tick(106 * 60_000);
  assert.equal((await w.svc.desktopUpstream(cookie)).error.code, 'ticket_invalid');
  // An already expired cookie is not revived by extend.
  const w2 = world(); await ready(w2);
  const c2 = await desktopCookie(w2);
  w2.tick(2 * 3600_000 + 1);
  await w2.svc.extend(OWNER, { requestId: randomUUID() }).catch(() => {});
  assert.equal((await w2.svc.desktopUpstream(c2)).error.code, 'ticket_invalid');
});

await test('R4 a refused requestId replays its original error; other arguments conflict; unaccepted unknowns stay retryable', async () => {
  const w = world(); await ready(w);
  await w.svc.stop(OWNER, { requestId: randomUUID() }); await w.svc.alarm();
  const id = randomUUID();
  assert.equal((await w.svc.extend(OWNER, { requestId: id })).error.code, 'not_running');
  await w.svc.start(OWNER, { requestId: randomUUID(), account: 'primary' });
  const replay = await w.svc.extend(OWNER, { requestId: id });
  assert.equal(replay.error.code, 'not_running', 'original definite error, not ok:true');
  const sid = randomUUID();
  await w.svc.start(OWNER, { requestId: sid, account: 'primary' });
  assert.equal((await w.svc.start(OWNER, { requestId: sid, account: 'secondary' })).error.code, 'request_conflict');
  const nid = randomUUID();
  assert.equal((await w.svc.snapshot(OWNER, { requestId: nid, name: 'cloudbite-computer-v1' })).error.code, 'snapshot_exists');
  assert.equal((await w.svc.snapshot(OWNER, { requestId: nid, name: 'another-name' })).error.code, 'request_conflict');
  assert.equal((await w.svc.snapshot(OWNER, { requestId: nid, name: 'cloudbite-computer-v1' })).error.code, 'snapshot_exists');
  // Preflight lookup unanswered: nothing accepted, the same id may run once Daytona answers.
  const w2 = world(); await ready(w2);
  const uid = randomUUID();
  w2.fake.fail.getSnapshot = [{ status: 0 }];
  assert.equal((await w2.svc.snapshot(OWNER, { requestId: uid, name: 'my-env-3' })).error.code, 'unknown_outcome');
  assert.equal((await w2.svc.snapshot(OWNER, { requestId: uid, name: 'my-env-3' })).snapshot.state, 'waiting_stop');
  assert.equal((await w2.svc.snapshot(OWNER, { requestId: uid, name: 'my-env-3' })).snapshot.state, 'waiting_stop', 'accepted replay reads state');
  assert.equal(ops(w2.fake, 'stop').length, 1);
});

await test('N1 desktopUpstream is a storage-only fast path: prewarmed, not queued, deduplicated, revoked by stop', async () => {
  const w = world(); await ready(w);
  assert.equal(ops(w.fake, 'preview').length, 1, 'prewarmed when the desktop became ready');
  const cookie = await desktopCookie(w);
  w.fake.hang.get = true;
  const blocked = w.svc.state(OWNER); // a slow provider call holds the mutation queue
  await settle();
  const up = await w.svc.desktopUpstream(cookie);
  assert.equal(up.ok, true); assert.equal(ops(w.fake, 'preview').length, 1, 'no fetch while cached');
  const writes = JSON.stringify([...w.kv.entries()]);
  for (let i = 0; i < 5; i++) await w.svc.desktopUpstream(cookie);
  assert.equal(JSON.stringify([...w.kv.entries()]), writes, 'no storage writes per asset');
  // Expired cache: a burst makes one provider lookup.
  w.tick(11 * 60_000);
  let open; w.fake.previewGate = new Promise((r) => { open = r; });
  const burst = Promise.all([1, 2, 3, 4].map(() => w.svc.desktopUpstream(cookie)));
  await settle(); open(); w.fake.previewGate = null;
  assert.ok((await burst).every((x) => x.ok)); assert.equal(ops(w.fake, 'preview').length, 2);
  assert.ok(!JSON.stringify(await w.svc.desktopPreviewRejected(cookie)).includes('preview-secret'));
  assert.equal(w.kv.get('computer-preview'), null, 'upstream auth failure drops the cache');
  w.fake.hang.get = false; void blocked;
  // Stop revokes future fast reads even with a fresh preview cached.
  const w2 = world(); await ready(w2);
  const c2 = await desktopCookie(w2);
  assert.equal((await w2.svc.desktopUpstream(c2)).ok, true);
  await w2.svc.stop(OWNER, { requestId: randomUUID() });
  assert.equal((await w2.svc.desktopUpstream(c2)).error.code, 'ticket_invalid');
  assert.equal(w2.kv.get('computer-preview'), null);
  // A lookup that answers after the machine run ended is discarded, never cached for the next run.
  const w3 = world(); await ready(w3);
  const c3 = await desktopCookie(w3);
  w3.kv.set('computer-preview', null);
  let open3; w3.fake.previewGate = new Promise((r) => { open3 = r; });
  const late = w3.svc.desktopUpstream(c3);
  await settle();
  await w3.svc.stop(OWNER, { requestId: randomUUID() });
  open3(); w3.fake.previewGate = null;
  assert.equal((await late).error.code, 'desktop_unavailable');
  assert.equal(w3.kv.get('computer-preview'), null);
});

await test('tool probe runs after ready on a later alarm, bounded per machine run', async () => {
  const w = world();
  await w.svc.start(OWNER, { requestId: randomUUID(), account: 'primary' });
  await w.svc.alarm(); await w.svc.alarm();
  assert.equal((await w.svc.state(OWNER)).ready, true);
  assert.equal(w.fake.calls.filter((c) => c[0] === 'exec' && c[1].includes('probe')).length, 0, 'ready does not wait for the probe');
  for (let i = 0; i < 5; i++) await w.svc.alarm();
  assert.equal(w.fake.calls.filter((c) => c[0] === 'exec' && c[1].includes('probe')).length, 3, 'failed probe retried at most 3 times');
  assert.ok((await w.svc.state(OWNER)).tools.filter((t) => t.kind === 'native_cli').every((t) => t.status === 'unprobed'));
  const w2 = world(); w2.fake.probe = JSON.stringify({ ok: true, tools: [{ id: 'codex', installed: true, version: '0.163.0' }] });
  await w2.svc.start(OWNER, { requestId: randomUUID(), account: 'primary' });
  await w2.svc.alarm(); await w2.svc.alarm(); await w2.svc.alarm(); await w2.svc.alarm();
  assert.equal(w2.fake.calls.filter((c) => c[0] === 'exec' && c[1].includes('probe')).length, 1);
  assert.equal((await w2.svc.state(OWNER)).tools.find((t) => t.id === 'codex').status, 'installed');
});

await test('machine() gives root the owner-checked identity only, no provider secrets', async () => {
  const w = world();
  assert.equal((await w.svc.machine(OWNER)).error.code, 'absent');
  await ready(w);
  const m = await w.svc.machine(OWNER);
  assert.equal(m.ok, true);
  assert.deepEqual(Object.keys(m.machine).sort(), ['account', 'id', 'labels', 'name', 'status']);
  assert.deepEqual(m.machine.labels, { 'cloudbite-computer': OWNER, 'cloudbite-computer-account': 'primary' });
  assert.equal(m.machine.name, `cloudbite-computer-primary-${OWNER}`);
  assert.ok(!JSON.stringify(m).includes('preview-secret') && !JSON.stringify(m).includes('k1'));
  assert.equal((await w.svc.machine('other0001tag')).error.code, 'bad_request');
  assert.equal((await w.svc.machine('BAD')).error.code, 'bad_request');
});

console.log(`${passed} cloudbite-computer-service tests passed`);
