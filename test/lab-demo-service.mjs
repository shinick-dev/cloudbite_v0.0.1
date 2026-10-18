import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
const built = await build({ entryPoints: ['src/lab-demo-service.ts'], bundle: true, write: false, platform: 'node', format: 'esm' });
const { LabDemoService, demoKey } = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'));
const uuid = n => 'ab000000-0000-4000-8000-' + n.toString().padStart(12, '0');
const gate = () => { let release; const p = new Promise(r => release = r); return { p, release }; };
function world() {
  const data = new Map(); let queue = Promise.resolve();
  const copy = v => v === undefined ? undefined : structuredClone(v);
  const storage = {
    async get(k) { return copy(data.get(k)); },
    async put(k, v) { for (const [key, value] of typeof k === 'object' ? Object.entries(k) : [[k, v]]) data.set(key, copy(value)); },
    async delete(k) { data.delete(k); },
    transaction(fn) { const p = queue.then(() => fn(storage)); queue = p.catch(() => {}); return p; }
  };
  const w = { data, storage, clock: Date.now(), admin: true, alive: true, creates: 0, sends: 0, saves: 0, files: new Map(), lostSave: false, warmReady: true, demos: new Map(), createGate: null, commandGate: null, lostCreate: false, lostCommand: false, preparing: false };
  const d = {
    storage, now: () => w.clock, checkAdmin: async t => w.admin && t === 'admin', parent: async id => w.alive && id === 'parent',
    demo: async id => copy(w.demos.get(id)), origin: label => 'https://s-' + label + '.lab.invalid',
    async create(token, parentId, arm) {
      w.creates++;
      if (w.preparing) return { preparing: true };
      await arm('demo');
      if (w.createGate) await w.createGate.p;
      const ref = { id: 'demo', parentId, code: 'fixture-private-seat', label: 'fixture-label', sandboxId: 'sb-demo', expiresAt: w.clock + 600000, ready: true };
      w.demos.set('demo', ref);
      if (w.lostCreate) throw Error('provider response lost');
      return { id: 'demo' };
    },
    async warm() { return { ready: w.warmReady }; },
    async command(token, ref, cmd) { w.sends++; if (w.commandGate) await w.commandGate.p; if (w.lostCommand) throw Error('lost'); return 'actual fixture output: ' + cmd; },
    async file(token, ref, name, save) { const previous = w.files.get(name) ?? { filename: name, content: '', hash: 'missing', exists: false }; if (!save) return previous; w.saves++; if (save.expectedHash !== previous.hash) throw Error('stale'); const next = { filename: name, content: save.content, hash: createHash('sha256').update(save.content).digest('hex'), exists: true }; w.files.set(name, next); if (w.lostSave) throw Error('lost'); return next; }
  };
  w.restart = () => w.service = new LabDemoService(d); w.restart(); return w;
}
let count = 0;
async function test(name, fn) { await fn(); console.log('ok', name); count++; }
await test('admin and parent lifetime gate every public operation', async () => {
  const w = world(); w.admin = false;
  assert.equal((await w.service.prepare('admin', 'parent', uuid(1))).status, 401);
  assert.equal((await w.service.send('admin', 'parent', uuid(2), 'pwd')).status, 401);
  assert.equal((await w.service.open('admin', 'parent')).status, 401);
  w.admin = true; w.alive = false; assert.equal((await w.service.status('admin', 'parent')).status, 410); assert.equal(w.creates, 0);
});
await test('concurrent create requests and restart never create a second sandbox', async () => {
  const w = world(); w.createGate = gate();
  const p = w.service.prepare('admin', 'parent', uuid(1));
  while (!w.creates) await new Promise(r => setImmediate(r));
  await w.service.prepare('admin', 'parent', uuid(2)); assert.equal(w.creates, 1);
  w.createGate.release(); assert.equal((await p).state, 'ready'); w.restart();
  assert.equal((await w.service.prepare('admin', 'parent', uuid(3))).state, 'ready'); assert.equal(w.creates, 1);
});
await test('snapshot preparation continuation requires original request ID', async () => {
  const w = world(); w.preparing = true;
  assert.equal((await w.service.prepare('admin', 'parent', uuid(1))).state, 'creating');
  assert.equal((await w.service.prepare('admin', 'parent', uuid(2))).status, 409);
  w.preparing = false; assert.equal((await w.service.prepare('admin', 'parent', uuid(1))).state, 'ready');
});
await test('lost create result is recoverable by inspection without provider replay', async () => {
  const w = world(); w.lostCreate = true;
  assert.equal((await w.service.prepare('admin', 'parent', uuid(1))).status, 503); w.restart();
  assert.equal((await w.service.status('admin', 'parent')).state, 'ready');
  await w.service.prepare('admin', 'parent', uuid(1)); assert.equal(w.creates, 1);
});
await test('command claim precedes effects; duplicate replays output and rejects changed payload', async () => {
  const w = world(); await w.service.prepare('admin', 'parent', uuid(1));
  const r = await w.service.send('admin', 'parent', uuid(2), 'pwd');
  assert.equal(r.output, 'actual fixture output: pwd');
  assert.deepEqual(await w.service.send('admin', 'parent', uuid(2), 'pwd'), r);
  assert.equal((await w.service.send('admin', 'parent', uuid(2), 'rm')).status, 409); assert.equal(w.sends, 1);
});
await test('unknown command is never run again after restart', async () => {
  const w = world(); await w.service.prepare('admin', 'parent', uuid(1)); w.lostCommand = true;
  assert.equal((await w.service.send('admin', 'parent', uuid(2), 'pwd')).status, 503); w.restart();
  const r = await w.service.send('admin', 'parent', uuid(2), 'pwd'); assert.match(r.output, /미확정/); assert.equal(w.sends, 1);
});
await test('revoked admin, expired parent or changed sandbox hides command output', async () => {
  for (const reason of ['admin', 'parent', 'sandbox']) {
    const w = world(); await w.service.prepare('admin', 'parent', uuid(1)); w.commandGate = gate();
    const p = w.service.send('admin', 'parent', uuid(2), 'pwd');
    while (!w.sends) await new Promise(r => setImmediate(r));
    if (reason === 'admin') w.admin = false; else if (reason === 'parent') w.alive = false; else w.demos.get('demo').sandboxId = 'changed';
    w.commandGate.release(); const r = await p; assert.equal(r.status, 503); assert.ok(!r.output);
  }
});
await test('only single-use, label-bound, short-lived grants open private demo seats', async () => {
  const w = world(); await w.service.prepare('admin', 'parent', uuid(1));
  const url = (await w.service.open('admin', 'parent')).url; const value = new URL(url).hash.slice(1);
  assert.ok(!JSON.stringify([...w.data]).includes(value));
  assert.equal((await w.service.claim(value, 'other')).status, 410);
  w.warmReady = false; assert.equal((await w.service.claim(value, 'fixture-label')).starting, true);
  w.warmReady = true; assert.equal((await w.service.claim(value, 'fixture-label')).code, 'fixture-private-seat');
  assert.equal((await w.service.claim(value, 'fixture-label')).status, 410);
  const expired = new URL((await w.service.open('admin', 'parent')).url).hash.slice(1); w.clock += 120001;
  assert.equal((await w.service.claim(expired, 'fixture-label')).status, 410);
});
await test('new grant invalidates previous and parent end blocks even a valid grant', async () => {
  const w = world(); await w.service.prepare('admin', 'parent', uuid(1));
  const first = new URL((await w.service.open('admin', 'parent')).url).hash.slice(1);
  const last = new URL((await w.service.open('admin', 'parent')).url).hash.slice(1);
  assert.equal((await w.service.claim(first, 'fixture-label')).status, 410);
  w.alive = false; assert.equal((await w.service.claim(last, 'fixture-label')).status, 410);
});
await test('command count and payload bounds prevent unbounded records', async () => {
  const w = world(); await w.service.prepare('admin', 'parent', uuid(1));
  assert.equal((await w.service.send('admin', 'parent', uuid(2), 'a\nb')).status, 400);
  assert.equal((await w.service.send('admin', 'parent', uuid(2), 'a'.repeat(4097))).status, 400);
  w.data.get(demoKey('parent')).commands = 100;
  assert.equal((await w.service.send('admin', 'parent', uuid(2), 'pwd')).status, 429); assert.equal(w.sends, 0);
});
await test('file saves are fenced, idempotent and never overwrite following unknown outcomes', async () => {
  const w = world(); await w.service.prepare('admin', 'parent', uuid(1));
  const first = await w.service.file('admin', 'parent', '결과.txt', uuid(2), 'actual saved text', 'missing');
  assert.equal(first.file.content, 'actual saved text');
  const again = await w.service.file('admin', 'parent', '결과.txt', uuid(2), 'actual saved text', 'missing'); assert.deepEqual(again, first); assert.equal(w.saves, 1);
  assert.equal((await w.service.file('admin', 'parent', '결과.txt', uuid(2), 'different text', 'missing')).status, 409);
  w.lostSave = true;
  assert.equal((await w.service.file('admin', 'parent', '결과.txt', uuid(3), 'next saved text', first.file.hash)).status, 503);
  assert.equal((await w.service.file('admin', 'parent', '결과.txt', uuid(3), 'next saved text', first.file.hash)).status, 409); assert.equal(w.saves, 2);
  assert.equal((await w.service.file('admin', 'parent', '결과.txt', uuid(2), 'actual saved text', 'missing')).status, 409);
  assert.equal((await w.service.file('admin', 'parent', '../peer', uuid(4))).status, 400);
  await w.service.clear('parent'); assert.equal(w.data.size, 0);
});
console.log(count + ' demo service checks passed');
