// CloudBite computer snapshots: the DO capture history and future-machine template (src/cloudbite-computer-service.ts) against a
// fake Daytona, and the standalone page (src/cloudbite-computer-snapshots-page.ts) in a small fake DOM with a mock API.
// Pins: bounded own history across captures and DO restarts, conservative legacy migration, foreign collisions never listed,
// selection without any provider mutation, template use only for a truly absent machine of the same account (re-checked
// active first), an existing machine never changed, requestId replays, and the page's stop acknowledgement and exact retries.
// No provider network, real sign-in or browser.
//   node test/cloudbite-computer-snapshots.mjs
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomBytes, randomUUID, webcrypto } from 'node:crypto';
import { build } from 'esbuild';
import {
  CLOUDBITE_COMPUTER_SNAPSHOTS_JS, CLOUDBITE_COMPUTER_SNAPSHOTS_HTML, CLOUDBITE_COMPUTER_SNAPSHOTS_CSS,
  CLOUDBITE_COMPUTER_SNAPSHOTS_PATH, CLOUDBITE_COMPUTER_SNAPSHOTS_JS_PATH, CLOUDBITE_COMPUTER_SNAPSHOTS_CSS_PATH,
} from '../src/cloudbite-computer-snapshots-page.ts';

const tmp = mkdtempSync(join(tmpdir(), 'cloudbite-snapshots-'));
const built = await build({ stdin: { contents: `export * from './src/cloudbite-computer-service.ts'; export * from './src/cloudbite-computer-contract.ts'; export { ComputerDaytonaError } from './src/cloudbite-computer-daytona.ts';`, resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, write: false, platform: 'node', format: 'esm', plugins: [{ name: 'cf', setup(b) {
    b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'cf', namespace: 'stub' }));
    b.onLoad({ filter: /^cf$/, namespace: 'stub' }, () => ({ contents: 'export class DurableObject { constructor(ctx,env){this.ctx=ctx;this.env=env;} }' }));
  } }] });
writeFileSync(join(tmp, 'm.mjs'), built.outputFiles[0].text);
const M = await import(pathToFileURL(join(tmp, 'm.mjs')));
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('provider network forbidden'); };

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log('ok', name); };

// ───────────────────────── service ─────────────────────────

const OWNER = 'owner0001tag';
const ENV = { CLOUDBITE_DAYTONA_API_KEY: 'k1', CLOUDBITE_COMPUTER_SNAPSHOT: 'cloudbite-computer-v1', CLOUDBITE_DAYTONA_SECONDARY_API_KEY: 'k2',
  CLOUDBITE_COMPUTER_SECONDARY_SNAPSHOT: 'cloudbite-computer-v1', CLOUDBITE_COMPUTER_GATEWAY_ORIGIN: 'https://gw.example.workers.dev' };
const MUTATIONS = ['create', 'start', 'stop', 'createSnapshot', 'resize', 'spawn', 'computerUseStart'];

function fakeDaytona() {
  const f = { calls: [], sandboxes: new Map(), snapshots: new Map([['cloudbite-computer-v1', { name: 'cloudbite-computer-v1', state: 'active' }]]), fail: {} };
  const err = (op) => { const q = f.fail[op]; return q && q.length ? q.shift() : null; };
  const byId = (id) => [...f.sandboxes.values()].find((s) => s.id === id || s.name === id) ?? null;
  f.api = {
    async create(c, body) { f.calls.push(['create', body]); const sb = { id: 'sb-' + randomBytes(6).toString('hex'), name: body.name, labels: body.labels, state: 'started', target: 'us', cpu: 4, memory: 8, disk: 10 };
      f.sandboxes.set(body.name, sb); return sb; },
    async get(c, idOrName) { f.calls.push(['get', idOrName]); return byId(idOrName); },
    async start(c, id) { f.calls.push(['start', id]); byId(id).state = 'started'; },
    async stop(c, id) { f.calls.push(['stop', id]); byId(id).state = 'stopped'; },
    async createSnapshot(c, id, name) { f.calls.push(['createSnapshot', id, name]); assert.equal(byId(id).state, 'stopped', 'cold snapshot requires stopped');
      f.snapshots.set(name, { name, state: 'snapshotting', sourceSandboxId: id }); },
    async getSnapshot(c, name) { f.calls.push(['getSnapshot', name]); const e = err('getSnapshot'); if (e) throw new M.ComputerDaytonaError(e.status, 'snapshot-get'); return f.snapshots.get(name) ?? null; },
    async preview(c, id, port) { return { url: `https://${port}-${id}.proxy.daytona.works`, token: 't' }; },
    async exec() { return { exitCode: 1, result: '' }; },
    async computerUseStart() { f.calls.push(['computerUseStart']); },
    async spawn() { f.calls.push(['spawn']); },
  };
  return f;
}
function world(shared) {
  const kv = shared?.kv ?? new Map(), clock = shared?.clock ?? { now: 1_800_000_000_000 }, fake = shared?.fake ?? fakeDaytona();
  const store = { async get(k) { return structuredClone(kv.get(k)); }, async put(k, v) { kv.set(k, structuredClone(v)); }, async setAlarm() {}, async deleteAlarm() {} };
  const svc = new M.ComputerService({ store, env: shared?.env ?? ENV, daytona: fake.api, now: () => clock.now, random: (n) => new Uint8Array(randomBytes(n)),
    sha256: async (s) => createHash('sha256').update(s).digest('hex') });
  return { svc, fake, kv, clock, tick(ms) { clock.now += ms; } };
}
const restart = (w) => world({ kv: w.kv, clock: w.clock, fake: w.fake });
const calls = (f, op) => f.calls.filter((c) => c[0] === op);
const mutations = (f) => f.calls.filter((c) => MUTATIONS.includes(c[0]));
const machineId = (w) => w.kv.get('computer').machine.id;
/** One full cold capture to `active`: stop if running, request on the alarm, provider finishes, alarm observes it. */
async function capture(w, name, body = {}) {
  const r = await w.svc.snapshot(OWNER, { requestId: randomUUID(), name, ...body });
  assert.equal(r.ok, true, JSON.stringify(r));
  w.tick(1000); await w.svc.alarm();
  w.fake.snapshots.get(name).state = 'active';
  w.tick(1000); await w.svc.alarm();
  assert.equal((await w.svc.state(OWNER)).snapshot.state, 'active');
}
async function withMachine(w = world()) { await w.svc.start(OWNER, { requestId: randomUUID(), account: 'primary' }); return w; }
/** The owned machine disappears at Daytona; the next read records the computer as absent. */
async function lose(w) { w.fake.sandboxes.clear(); assert.equal((await w.svc.state(OWNER)).status, 'absent'); }

await test('history keeps every own capture across captures and DO restarts, newest first', async () => {
  const w = await withMachine();
  await capture(w, 'first-env', { acknowledgeStop: true }); // the page's extra key is accepted
  w.tick(60_000);
  await capture(w, 'second-env');
  const b = restart(w);
  const doc = await b.svc.snapshots(OWNER);
  assert.equal(doc.ok, true);
  assert.deepEqual(doc.items.map((i) => [i.name, i.account, i.state, i.selected, i.selectable]),
    [['second-env', 'primary', 'active', false, true], ['first-env', 'primary', 'active', false, true]]);
  assert.ok(Date.parse(doc.items[0].requestedAt) > Date.parse(doc.items[1].requestedAt));
  assert.deepEqual(doc.latest, { name: 'second-env', state: 'active', error: null });
  assert.equal(doc.machine.account, 'primary'); assert.equal(doc.machine.template, null); assert.equal(doc.historyMax, 20);
  assert.equal(doc.selected, null);
  const stored = b.kv.get('computer').snapshots;
  assert.ok(stored.every((h) => h.sourceId === machineId(b) && typeof h.requestedAt === 'number'));
});

await test('GET snapshots never mutates cloud resources and re-checks at most 3 active captures, each at most once a minute', async () => {
  const w = await withMachine();
  for (const n of ['snap-aa', 'snap-bb', 'snap-cc', 'snap-dd', 'snap-ee']) await capture(w, n);
  w.tick(120_000);
  w.fake.calls.length = 0;
  await w.svc.snapshots(OWNER);
  assert.deepEqual(mutations(w.fake), []);
  assert.equal(calls(w.fake, 'getSnapshot').length, 3);
  w.fake.calls.length = 0;
  await w.svc.snapshots(OWNER);
  assert.equal(calls(w.fake, 'getSnapshot').length, 2, 'the two not yet re-checked');
  w.fake.calls.length = 0;
  await w.svc.snapshots(OWNER);
  assert.equal(calls(w.fake, 'getSnapshot').length, 0, 'nothing is due within the minute');
  w.fake.snapshots.delete('snap-aa');
  w.tick(61_000);
  const doc = await w.svc.snapshots(OWNER);
  const aa = doc.items.find((i) => i.name === 'snap-aa');
  assert.ok(!aa || aa.state === 'active', 'only due entries were read');
  for (let i = 0; i < 3; i++) { w.tick(61_000); await w.svc.snapshots(OWNER); }
  const gone = (await w.svc.snapshots(OWNER)).items.find((i) => i.name === 'snap-aa');
  assert.deepEqual([gone.state, gone.error, gone.selectable], ['missing', 'snapshot_missing', false]);
  assert.deepEqual(mutations(w.fake).filter((c) => c[0] !== 'stop' && c[0] !== 'createSnapshot'), []);
});

await test('legacy records migrate conservatively: only a requested capture of the current machine; collisions and stray names never', async () => {
  const base = async (snapshot, machinePatch = {}) => {
    const w = await withMachine();
    const rec = w.kv.get('computer');
    delete rec.snapshots; delete rec.template;
    rec.machine = { ...rec.machine, ...machinePatch };
    rec.snapshot = snapshot(rec);
    w.kv.set('computer', rec);
    w.fake.snapshots.set('legacy-env', { name: 'legacy-env', state: 'active', sourceSandboxId: rec.machine.id });
    return (await restart(w).svc.snapshots(OWNER)).items;
  };
  const at = 1_799_000_000_000;
  const own = await base((r) => ({ name: 'legacy-env', state: 'active', error: null, polls: 3, requestedAt: at, sourceId: r.machine.id, preflightAbsent: true }));
  assert.deepEqual(own.map((i) => [i.name, i.account, i.state, i.requestedAt]), [['legacy-env', 'primary', 'active', new Date(at).toISOString()]]);
  assert.deepEqual(await base((r) => ({ name: 'legacy-env', state: 'error', error: 'snapshot_exists', polls: 0, requestedAt: at, sourceId: r.machine.id })), [], 'collision');
  assert.deepEqual(await base(() => ({ name: 'legacy-env', state: 'active', error: null, polls: 0, requestedAt: at, sourceId: 'sb-another-machine' })), [], 'other source');
  assert.deepEqual(await base(() => ({ name: 'legacy-env', state: 'waiting_stop', error: null, polls: 0 })), [], 'never requested');
  assert.deepEqual(await base(() => ({ name: 'legacy-env', state: 'active', error: null, polls: 0 })), [], 'no proof inputs');
});

await test('foreign collisions are never listed or selectable: preflight, 409, proven foreign source, and a later GET proof', async () => {
  const w = await withMachine();
  w.fake.snapshots.set('taken-name', { name: 'taken-name', state: 'active', sourceSandboxId: 'sb-other' });
  assert.equal((await w.svc.snapshot(OWNER, { requestId: randomUUID(), name: 'taken-name' })).error.code, 'snapshot_exists');
  // Captured by us, then Daytona reports the name as another sandbox's: dropped from history, selection cleared.
  await capture(w, 'mine-then-not');
  const sel = await w.svc.selectSnapshot(OWNER, { requestId: randomUUID(), account: 'primary', name: 'mine-then-not' });
  assert.deepEqual(sel.selected, { account: 'primary', name: 'mine-then-not' });
  w.fake.snapshots.set('mine-then-not', { name: 'mine-then-not', state: 'active', sourceSandboxId: 'sb-other' });
  w.tick(61_000);
  const doc = await w.svc.snapshots(OWNER);
  assert.deepEqual(doc.items.map((i) => i.name), []);
  assert.equal(doc.selected, null);
  assert.deepEqual(doc.latest, { name: 'mine-then-not', state: 'error', error: 'snapshot_exists' });
  assert.deepEqual((await restart(w).svc.snapshots(OWNER)).items, [], 'not re-inserted from the latest capture');
  assert.equal((await w.svc.state(OWNER)).template, null);
});

await test('selecting a template makes no provider mutation and only accepts an own capture that a fresh read shows active', async () => {
  const w = await withMachine();
  await capture(w, 'good-env');
  w.fake.calls.length = 0;
  const id = randomUUID();
  const r = await w.svc.selectSnapshot(OWNER, { requestId: id, account: 'primary', name: 'good-env' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.selected, { account: 'primary', name: 'good-env' });
  assert.deepEqual(r.items.map((i) => [i.name, i.selected, i.selectable]), [['good-env', true, false]]);
  assert.deepEqual(w.fake.calls.map((c) => c[0]), ['getSnapshot']);
  assert.deepEqual((await w.svc.state(OWNER)).template, { account: 'primary', name: 'good-env' });
  // replay: same id + same arguments reads the current doc; other arguments conflict
  w.fake.calls.length = 0;
  assert.deepEqual((await w.svc.selectSnapshot(OWNER, { requestId: id, account: 'primary', name: 'good-env' })).selected, { account: 'primary', name: 'good-env' });
  assert.deepEqual(w.fake.calls, []);
  assert.equal((await w.svc.selectSnapshot(OWNER, { requestId: id, account: 'primary', name: null })).error.code, 'request_conflict');
  // refusals
  const no = (body) => w.svc.selectSnapshot(OWNER, { requestId: randomUUID(), ...body });
  assert.equal((await no({ account: 'primary', name: 'cloudbite-computer-v1' })).error.code, 'snapshot_not_selectable', 'the prepared image is not a capture');
  assert.equal((await no({ account: 'secondary', name: 'good-env' })).error.code, 'snapshot_not_selectable', 'other account');
  assert.equal((await no({ account: 'primary', name: 'good-env', restore: true })).error.code, 'bad_request');
  assert.equal((await no({ account: 'nowhere', name: 'good-env' })).error.code, 'bad_request');
  assert.equal((await no({ account: 'primary', name: 'Bad Name' })).error.code, 'bad_request');
  assert.equal((await w.svc.selectSnapshot(OWNER, { requestId: 'nope', account: 'primary', name: 'good-env' })).error.code, 'bad_request');
  assert.deepEqual(mutations(w.fake), []);
  // clearing
  const cleared = await no({ account: 'primary', name: null });
  assert.equal(cleared.selected, null); assert.equal(cleared.items[0].selectable, true);
  // no answer: nothing concluded, the id stays usable
  w.fake.fail.getSnapshot = [{ status: 0 }];
  const uid = randomUUID();
  assert.equal((await w.svc.selectSnapshot(OWNER, { requestId: uid, account: 'primary', name: 'good-env' })).error.code, 'unknown_outcome');
  assert.deepEqual((await w.svc.selectSnapshot(OWNER, { requestId: uid, account: 'primary', name: 'good-env' })).selected, { account: 'primary', name: 'good-env' });
  // a capture that no longer exists cannot be chosen
  await no({ account: 'primary', name: null });
  w.fake.snapshots.delete('good-env');
  assert.equal((await no({ account: 'primary', name: 'good-env' })).error.code, 'snapshot_not_selectable');
  assert.equal((await w.svc.snapshots(OWNER)).items[0].state, 'missing');
  assert.deepEqual(mutations(w.fake), []);
});

await test('an existing machine is never changed by a selection: start resumes its own disk, accounts never switch', async () => {
  const w = await withMachine();
  await capture(w, 'tmpl-env');
  await w.svc.selectSnapshot(OWNER, { requestId: randomUUID(), account: 'primary', name: 'tmpl-env' });
  const id = machineId(w);
  w.fake.calls.length = 0;
  const s = await w.svc.start(OWNER, { requestId: randomUUID(), account: 'primary' });
  assert.equal(s.status, 'starting');
  assert.deepEqual(mutations(w.fake).map((c) => c[0]), ['start']);
  assert.equal(calls(w.fake, 'start')[0][1], id);
  assert.equal(machineId(w), id);
  assert.equal((await w.svc.snapshots(OWNER)).machine.template, null, 'still the machine made from the prepared image');
  assert.equal((await w.svc.start(OWNER, { requestId: randomUUID(), account: 'secondary' })).error.code, 'account_mismatch');
  assert.equal(calls(w.fake, 'create').length, 0);
});

await test('a truly absent machine of the same account is created from the selected template after a fresh active check', async () => {
  const w = await withMachine();
  await capture(w, 'tmpl-env');
  await w.svc.selectSnapshot(OWNER, { requestId: randomUUID(), account: 'primary', name: 'tmpl-env' });
  await lose(w);
  w.fake.calls.length = 0;
  const id = randomUUID();
  const s = await w.svc.start(OWNER, { requestId: id, account: 'primary' });
  assert.equal(s.ok, true); assert.equal(s.status, 'running');
  const order = w.fake.calls.map((c) => c[0] === 'getSnapshot' ? `get:${c[1]}` : c[0]);
  assert.deepEqual(order, ['get:tmpl-env', 'create']);
  const body = calls(w.fake, 'create')[0][1];
  assert.equal(body.snapshot, 'tmpl-env');
  assert.equal(body.name, `cloudbite-computer-primary-${OWNER}`);
  assert.deepEqual(body.labels, { 'cloudbite-computer': OWNER, 'cloudbite-computer-account': 'primary' });
  assert.equal((await w.svc.snapshots(OWNER)).machine.template, 'tmpl-env');
  await w.svc.start(OWNER, { requestId: id, account: 'primary' });
  assert.equal(calls(w.fake, 'create').length, 1, 'replay does not create again');
});

await test('another account, or no selection, uses the prepared image; an unavailable template is refused, never silently replaced', async () => {
  const w = await withMachine();
  await capture(w, 'tmpl-env');
  await w.svc.selectSnapshot(OWNER, { requestId: randomUUID(), account: 'primary', name: 'tmpl-env' });
  await lose(w);
  // secondary: the primary template does not apply
  w.fake.calls.length = 0;
  await w.svc.start(OWNER, { requestId: randomUUID(), account: 'secondary' });
  assert.equal(calls(w.fake, 'create')[0][1].snapshot, 'cloudbite-computer-v1');
  assert.equal((await w.svc.snapshots(OWNER)).machine.template, null);

  const v = await withMachine();
  await capture(v, 'tmpl-env');
  await v.svc.selectSnapshot(OWNER, { requestId: randomUUID(), account: 'primary', name: 'tmpl-env' });
  await lose(v);
  v.fake.calls.length = 0;
  v.fake.fail.getSnapshot = [{ status: 0 }];
  const uid = randomUUID();
  assert.equal((await v.svc.start(OWNER, { requestId: uid, account: 'primary' })).error.code, 'unknown_outcome');
  assert.equal(calls(v.fake, 'create').length, 0);
  v.fake.snapshots.get('tmpl-env').state = 'removing';
  assert.equal((await v.svc.start(OWNER, { requestId: randomUUID(), account: 'primary' })).error.code, 'template_unavailable');
  v.fake.snapshots.delete('tmpl-env');
  const did = randomUUID();
  assert.equal((await v.svc.start(OWNER, { requestId: did, account: 'primary' })).error.code, 'template_unavailable');
  assert.equal((await v.svc.start(OWNER, { requestId: did, account: 'primary' })).error.code, 'template_unavailable', 'definite refusal replayed');
  assert.equal(calls(v.fake, 'create').length, 0);
  assert.equal((await v.svc.snapshots(OWNER)).items[0].state, 'missing');
  // the owner clears the choice: the prepared image is used
  await v.svc.selectSnapshot(OWNER, { requestId: randomUUID(), account: 'primary', name: null });
  await v.svc.start(OWNER, { requestId: randomUUID(), account: 'primary' });
  assert.equal(calls(v.fake, 'create')[0][1].snapshot, 'cloudbite-computer-v1');
});

await test('the history is bounded to 20 and the bound never drops the selected template', async () => {
  const w = await withMachine();
  await capture(w, 'oldest-env');
  await w.svc.selectSnapshot(OWNER, { requestId: randomUUID(), account: 'primary', name: 'oldest-env' });
  for (let i = 0; i < 21; i++) { w.tick(1000); await capture(w, `env-${String(i).padStart(2, '0')}`); }
  const doc = await w.svc.snapshots(OWNER);
  assert.equal(doc.items.length, 20);
  assert.equal(doc.items[0].name, 'env-20');
  assert.ok(doc.items.some((i) => i.name === 'oldest-env' && i.selected));
  assert.ok(!doc.items.some((i) => i.name === 'env-00' || i.name === 'env-01'), 'oldest unselected entries dropped');
  assert.deepEqual(doc.selected, { account: 'primary', name: 'oldest-env' });
});

// ───────────────────────── page ─────────────────────────

globalThis.fetch = realFetch;
const API = '/api/cloudbite/computer';
const LIST = `${API}/snapshots`, SELECT = `${API}/snapshots/select`, CAPTURE = `${API}/snapshot`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

class El {
  constructor(doc, tag) { this.doc = doc; this.tagName = tag.toUpperCase(); this.children = []; this.attrs = {}; this.listeners = {}; this.parent = null;
    this.className = ''; this._text = ''; this.value = ''; this.disabled = false; this.hidden = false; this.checked = false; this.id = ''; }
  get textContent() { return this._text + this.children.map((c) => typeof c === 'string' ? c : c.textContent).join(''); }
  set textContent(v) { for (const c of this.children) if (typeof c !== 'string') c.parent = null; this.children = []; this._text = String(v); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }
  dispatch(t) { for (const f of this.listeners[t] || []) f({ type: t, target: this, preventDefault() {} }); }
  append(...ns) { for (const n of ns) { if (typeof n === 'string') { this.children.push(n); continue; } if (n.parent) n.remove(); n.parent = this; this.children.push(n); } }
  replaceChildren(...ns) { for (const c of this.children) if (typeof c !== 'string') c.parent = null; this.children = []; this._text = ''; this.append(...ns); }
  remove() { if (this.parent) { this.parent.children = this.parent.children.filter((c) => c !== this); this.parent = null; } }
  click() { if (!this.disabled) this.dispatch('click'); }
  *walk() { for (const c of this.children) if (typeof c !== 'string') { yield c; yield* c.walk(); } }
  shown() { let n = this; while (n) { if (n.hidden) return false; n = n.parent; } return true; }
}
const json = (status, body) => Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body });
const item = (o = {}) => ({ name: 'good-env', account: 'primary', requestedAt: '2026-10-19T01:00:00.000Z', state: 'active', error: null, checkedAt: null, selected: false, selectable: true, ...o });
const docBody = (o = {}) => ({ ok: true, items: [item()], selected: null, latest: { name: 'good-env', state: 'active', error: null },
  machine: { status: 'running', account: 'primary', id: 'sb-1', template: null }, historyMax: 20, ...o });

function api(o = {}) {
  const s = { doc: docBody(o.doc || {}), unauth: !!o.unauth, capture: o.capture || null, select: o.select || null };
  const route = (r) => {
    if (s.unauth) return json(401, { error: { code: 'unauthorized', message: 'x' } });
    if (r.url === LIST && r.method === 'GET') return json(200, s.doc);
    if (r.url === CAPTURE && r.method === 'POST') return s.capture ? s.capture(r, s) : json(200, { ok: true, status: 'stopping', snapshot: { name: r.body.name, state: 'waiting_stop', error: null } });
    if (r.url === SELECT && r.method === 'POST') return s.select ? s.select(r, s) : json(200, docBody({ selected: r.body.name ? { account: r.body.account, name: r.body.name } : null,
      items: [item({ selected: !!r.body.name, selectable: !r.body.name })] }));
    return json(404, { error: { code: 'not_found', message: 'x' } });
  };
  return { s, route };
}
function env({ route, language = 'en-US', search = '' } = {}) {
  const timers = new Map(); let seq = 0, now = 0;
  const doc = { title: '', documentElement: { lang: 'en' }, visibilityState: 'visible', listeners: {},
    createElement: (t) => new El(doc, t), getElementById: (id) => (id === 'cb-computer-snapshots' ? root : null),
    addEventListener(t, f) { (this.listeners[t] ||= []).push(f); } };
  const root = new El(doc, 'div');
  const requests = [];
  const ctx = vm.createContext({
    document: doc, location: { pathname: CLOUDBITE_COMPUTER_SNAPSHOTS_PATH, search, hash: '' }, URLSearchParams, URL, Date, Uint8Array,
    TextEncoder, AbortController, crypto: webcrypto, navigator: { language },
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { at: now + (ms || 0), ms, fn }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    fetch: (url, init = {}) => {
      const r = { url, method: init.method || 'GET', raw: init.body, body: init.body === undefined ? undefined : JSON.parse(init.body), init };
      requests.push(r);
      if (init.signal?.aborted) return Promise.reject(new Error('aborted'));
      return route(r);
    },
  });
  const flush = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); };
  const advance = async (ms) => {
    const end = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]); now = due[1].at; due[1].fn(); await flush();
    }
    now = end;
  };
  vm.runInContext(CLOUDBITE_COMPUTER_SNAPSHOTS_JS, ctx);
  const all = () => [...root.walk()];
  const visible = () => all().filter((e) => e.shown());
  const btn = (text) => visible().find((e) => e.tagName === 'BUTTON' && e.textContent === text);
  const byId = (id) => all().find((e) => e.id === id);
  const text = () => visible().map((e) => e._text + e.children.filter((c) => typeof c === 'string').join('')).filter(Boolean).join(' | ');
  const posts = (p) => requests.filter((r) => r.method === 'POST' && r.url === p);
  const setName = (v) => { const c = byId('cs-name'); c.value = v; c.dispatch('input'); };
  const ack = () => { const c = visible().find((e) => e.tagName === 'INPUT' && e.getAttribute('type') === 'checkbox'); c.checked = true; c.dispatch('change'); };
  const setVisibility = (v) => { doc.visibilityState = v; for (const f of doc.listeners.visibilitychange || []) f(); };
  return { doc, requests, timers, flush, advance, visible, btn, byId, text, posts, setName, ack, setVisibility };
}

await test('page: same-origin script and style only, no inline code, storage, WebAuthn or absolute URL; 48px targets and 16px inputs', async () => {
  assert.equal(CLOUDBITE_COMPUTER_SNAPSHOTS_PATH, '/cloudbite/computer/snapshots');
  assert.equal(CLOUDBITE_COMPUTER_SNAPSHOTS_JS_PATH, '/cloudbite/computer/snapshots.js');
  assert.equal(CLOUDBITE_COMPUTER_SNAPSHOTS_CSS_PATH, '/cloudbite/computer/snapshots.css');
  assert.ok(CLOUDBITE_COMPUTER_SNAPSHOTS_HTML.includes(`<script src="${CLOUDBITE_COMPUTER_SNAPSHOTS_JS_PATH}" defer></script>`));
  assert.ok(CLOUDBITE_COMPUTER_SNAPSHOTS_HTML.includes(`<link rel="stylesheet" href="${CLOUDBITE_COMPUTER_SNAPSHOTS_CSS_PATH}">`));
  assert.ok(!/<script>|style=|<iframe|https?:\/\//.test(CLOUDBITE_COMPUTER_SNAPSHOTS_HTML.replace(/<script src[^>]+><\/script>/, '')));
  assert.ok(!/localStorage|sessionStorage|indexedDB|document\.cookie|innerHTML|insertAdjacentHTML|eval\(|new Function|<iframe|postMessage/.test(CLOUDBITE_COMPUTER_SNAPSHOTS_JS));
  assert.ok(!/navigator\.credentials|PublicKeyCredential|Authorization|Bearer/i.test(CLOUDBITE_COMPUTER_SNAPSHOTS_JS));
  assert.ok(!/https?:\/\//.test(CLOUDBITE_COMPUTER_SNAPSHOTS_JS));
  assert.ok(!/@import|url\(/i.test(CLOUDBITE_COMPUTER_SNAPSHOTS_CSS));
  const base = CLOUDBITE_COMPUTER_SNAPSHOTS_CSS.split('@media')[0];
  for (const m of base.matchAll(/(?:^|[;{])\s*(?:width|min-width)\s*:\s*(\d+)px/g)) assert.ok(Number(m[1]) <= 360, `fixed width ${m[0]}`);
  assert.match(CLOUDBITE_COMPUTER_SNAPSHOTS_CSS, /\.cs-btn\{min-height:48px/);
  assert.match(CLOUDBITE_COMPUTER_SNAPSHOTS_CSS, /\.cs-lang-btn\{min-width:48px;min-height:48px/);
  assert.match(CLOUDBITE_COMPUTER_SNAPSHOTS_CSS, /\.cs-check\{[^}]*min-height:48px/);
  assert.match(CLOUDBITE_COMPUTER_SNAPSHOTS_CSS, /\.cs-input\{[^}]*font-size:16px/);
});

await test('page: 401 shows the main-page sign-in link and sends nothing else', async () => {
  const e = env({ route: api({ unauth: true }).route, search: '?lang=en' });
  await e.flush();
  const a = e.visible().find((x) => x.tagName === 'A' && x.textContent === 'Sign in on the cloud computer page');
  assert.equal(a.getAttribute('href'), '/cloudbite/computer?lang=en');
  assert.deepEqual(e.requests.map((r) => `${r.method} ${r.url}`), [`GET ${LIST}`]);
});

await test('page: explains cold disk-only captures and future-only templates; loading and polling never POST; no restore-now control', async () => {
  const { s, route } = api({ doc: { latest: { name: 'busy-env', state: 'snapshotting', error: null }, items: [item({ name: 'busy-env', state: 'snapshotting', selectable: false })] } });
  const e = env({ route, search: '?lang=en' });
  await e.flush();
  const t = e.text();
  assert.match(t, /cold copy of the disk only/); assert.match(t, /Memory .* is never saved/);
  assert.match(t, /only when a brand-new computer is created in the same account/); assert.match(t, /current computer always resumes its own disk/);
  assert.ok(!/restore now|Restore$/i.test(t));
  assert.equal(e.btn('Capture').disabled, true, 'busy: no capture');
  await e.advance(4999); assert.equal(e.requests.length, 1, 'no poll before 5 s');
  await e.advance(1); assert.equal(e.requests.length, 2);
  await e.advance(7500); assert.equal(e.requests.length, 3, 'backoff');
  e.setVisibility('hidden'); await e.advance(120_000); assert.equal(e.requests.length, 3, 'hidden tab does not poll');
  s.doc = docBody();
  e.setVisibility('visible'); await e.flush();
  await e.advance(120_000);
  assert.ok(e.requests.every((r) => r.method === 'GET' && r.url === LIST));
  assert.equal(e.requests.length, 4, 'settled: polling stops');
  const manual = e.btn('Refresh'); manual.click(); await e.flush();
  assert.equal(e.requests.length, 5);
});

await test('page: capture needs a valid name and the explicit stop acknowledgement; uncertain retries resend the exact body', async () => {
  let n = 0;
  const { route } = api({ capture: () => (++n === 1 ? json(503, { error: { code: 'unknown_outcome', message: 'x' } }) : json(200, { ok: true, status: 'stopping', snapshot: null })) });
  const e = env({ route, search: '?lang=en' });
  await e.flush();
  const cap = () => e.btn('Capture');
  assert.equal(cap().disabled, true);
  e.setName('Bad Name'); e.ack(); assert.equal(cap().disabled, true, 'invalid name');
  e.setName('my-setup-1'); assert.equal(cap().disabled, false);
  cap().click(); await e.flush();
  const [first] = e.posts(CAPTURE);
  assert.match(first.body.requestId, UUID);
  assert.deepEqual(first.body, { requestId: first.body.requestId, name: 'my-setup-1', acknowledgeStop: true });
  assert.match(e.text(), /Retry sends the same request with the same ID/);
  assert.equal(e.btn('Capture'), undefined, 'no fresh capture while uncertain');
  e.btn('Retry same request').click(); await e.flush();
  const [, second] = e.posts(CAPTURE);
  assert.equal(second.raw, first.raw, 'byte-identical retry');
  assert.match(e.text(), /Capture accepted/);
  assert.equal(e.byId('cs-name').value, '');
  assert.equal(e.btn('Capture').disabled, true, 'the acknowledgement is asked again');
});

await test('page: a definite capture refusal shows the code, keeps the name and sends nothing more', async () => {
  const { route } = api({ capture: () => json(409, { error: { code: 'snapshot_exists', message: 'x' } }) });
  const e = env({ route, search: '?lang=en' });
  await e.flush();
  e.setName('taken-name'); e.ack(); e.btn('Capture').click(); await e.flush();
  assert.match(e.text(), /Rejected: snapshot_exists/);
  assert.equal(e.byId('cs-name').value, 'taken-name');
  assert.equal(e.posts(CAPTURE).length, 1);
});

await test('page: choose and clear a template with exact bodies; uncertain choice retries the same request', async () => {
  let n = 0;
  const { s, route } = api();
  const ok = api().route;
  s.select = (r) => (++n === 1 ? json(502, { error: { code: 'x', message: 'x' } }) : ok(r));
  const e = env({ route, search: '?lang=en' });
  await e.flush();
  e.btn('Use for new computers').click(); await e.flush();
  const [first] = e.posts(SELECT);
  assert.deepEqual(first.body, { requestId: first.body.requestId, account: 'primary', name: 'good-env' });
  e.btn('Retry same request').click(); await e.flush();
  assert.equal(e.posts(SELECT)[1].raw, first.raw);
  assert.match(e.text(), /Only a brand-new computer in this account starts from this snapshot/);
  assert.match(e.text(), /Chosen: good-env \(Primary account\)/);
  e.btn('Clear choice').click(); await e.flush();
  const clear = e.posts(SELECT)[2];
  assert.deepEqual(clear.body, { requestId: clear.body.requestId, account: 'primary', name: null });
  assert.notEqual(clear.body.requestId, first.body.requestId);
  assert.ok(e.posts(CAPTURE).length === 0);
});

await test('page: KO/EN switch keeps the typed name and acknowledgement', async () => {
  const e = env({ route: api().route, language: 'ko-KR' });
  await e.flush();
  assert.equal(e.doc.documentElement.lang, 'ko');
  assert.match(e.text(), /디스크만 차갑게 복사/);
  e.setName('keep-me'); e.ack();
  e.btn('EN').click();
  assert.equal(e.doc.documentElement.lang, 'en');
  assert.equal(e.byId('cs-name').value, 'keep-me');
  assert.equal(e.btn('Capture').disabled, false);
});

console.log(`${passed} cloudbite-computer-snapshots tests passed`);
