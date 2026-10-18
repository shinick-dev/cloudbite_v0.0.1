// Actual State with isolated in-memory storage and synthetic provider. No production resources.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const stub = { name: 'cf', setup(b) { b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'cf', namespace: 'stub' })); b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env}}' })); } };
const out = await build({ entryPoints: ['src/state.ts'], bundle: true, write: false, format: 'esm', platform: 'node', plugins: [stub], loader: { '.ps1': 'text' } });
const { State } = await import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'));
const uuid = n => 'ab000000-0000-4000-8000-' + n.toString().padStart(12, '0');
let current, count = 0;
function memory() {
  const data = new Map(); let queue = Promise.resolve(), alarm = null;
  const copy = v => v === undefined ? undefined : structuredClone(v);
  const s = {
    data, async get(k) { return Array.isArray(k) ? new Map(k.map(a => [a, copy(data.get(a))])) : copy(data.get(k)); },
    async put(k, v) { for (const [a, b] of typeof k === 'object' ? Object.entries(k) : [[k, v]]) data.set(a, copy(b)); },
    async delete(k) { for (const a of Array.isArray(k) ? k : [k]) data.delete(a); },
    async list({ prefix = '', limit = Infinity } = {}) { return new Map([...data].filter(([k]) => k.startsWith(prefix)).slice(0, limit).map(([k, v]) => [k, copy(v)])); },
    transaction(f) { const p = queue.then(() => f(s)); queue = p.catch(() => {}); return p; }, async getAlarm() { return alarm; }, async setAlarm(t) { alarm = t; }
  }; return s;
}
globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url), w = current; w.calls.push([init.method ?? 'GET', u.pathname]);
  assert.ok(['dt.invalid', 'toolbox.invalid'].includes(u.host), 'unexpected external network ' + u.host);
  if (u.pathname === '/sandbox' && init.method === 'POST') { w.created++; const body = JSON.parse(init.body); const lab = w.s.data.get('lab:' + body.labels['gw-lab']); assert.equal(lab.teacherDemoFor, 'parent', 'private marker must precede sandbox effects'); return Response.json({ id: 'sb-demo', state: 'started', toolboxProxyUrl: 'https://toolbox.invalid' }); }
  if (u.pathname === '/sandbox' && (init.method ?? 'GET') === 'GET') return Response.json([]);
  if (u.pathname.startsWith('/sandbox/') && init.method === 'DELETE') { w.deleted.push(u.pathname); return Response.json({}); }
  if (u.pathname.startsWith('/sandbox/')) return Response.json({ id: u.pathname.split('/')[2], state: 'started', toolboxProxyUrl: 'https://toolbox.invalid' });
  if (u.pathname.endsWith('/process/execute')) {
    const body = JSON.parse(init.body); w.commands.push({ path: u.pathname, command: body.command });
    if (body.command.includes('const materials=JSON.parse')) {
      const encoded = body.command.replaceAll("'\\''", "'").match(/Buffer.from\('([^']+)'/)[1];
      const materials = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
      return Response.json({ exitCode: 0, result: JSON.stringify({ files: materials.map(m => ({ name: m.name, state: 'added' })) }) });
    }
    return Response.json({ exitCode: 0, result: body.command.includes('/healthz') ? '200' : 'demo output' });
  }
  throw Error('unexpected fixture path ' + u.pathname);
};
async function world() {
  const w = { s: memory(), calls: [], commands: [], created: 0, deleted: [], auth: true, minted: 0, tasks: [] }; current = w;
  const parent = { id: 'parent', name: '공부방', createdAt: Date.now(), expiresAt: Date.now() + 3600000, budget: 1, cpu: 1, memory: 2, disk: 5, snapshot: 'gw-lab-v5', model: 'm', gw: 'https://gw.invalid', seats: [{ n: 1, code: 'participant00001', label: 'b'.repeat(26), sandboxId: 'sb-peer', sid: 'peer-sid' }] };
  await w.s.put({ 'lab:parent': parent, 'seat:participant00001': { lab: 'parent', n: 1 }, 'prov:daytona': { gen: 'g', iv: 'fixture', ct: 'fixture', upstream: 'https://dt.invalid' } });
  class Fixture extends State {
    async checkAdmin(t) { return w.auth && t === 'admin'; }
    async daytona() { return { api: 'https://dt.invalid', key: 'fixture-only' }; }
    async labShareInput() { return { share: {}, defs: [] }; }
    async listProviders() { return [{ id: 'or', kind: 'openrouter-mint', upstream: 'https://openrouter.ai' }]; }
    async modelExists() { return true; }
    async newSession(...args) { const sid = 'demo-sid-' + ++w.minted; await w.s.put('sess:' + sid, { id: sid, lab: args[5], expiresAt: Date.now() + 3600000, tokenHash: 'fixture' }); return { sid, token: 'fixture-only' }; }
    async endSession(s) { await w.s.delete('sess:' + s.id); return true; }
    async audit() {}
  }
  w.restart = () => w.state = new Fixture({ storage: w.s, blockConcurrencyWhile: f => f(), waitUntil: p => { w.tasks.push(p); void p.catch(() => {}); } }, { LAB_ORIGIN: 'https://lab.invalid', LAB_SEAT_DOMAIN: 'lab.invalid' });
  w.restart(); w.parent = parent; return w;
}
async function test(n, f) { await f(); count++; console.log('ok', n); }
await test('real create is private before provider effects, separate and parent-bounded', async () => {
  const w = await world(); const r = await w.state.labClassroomDemoPrepare('admin', 'parent', uuid(1));
  assert.equal(r.state, 'ready', JSON.stringify({ r, calls: w.calls, labs: [...w.s.data].filter(([k]) => k.startsWith('lab:')) })); assert.equal(w.created, 1); const demo = w.s.data.get('lab:' + r.demoId);
  assert.equal(demo.teacherDemoFor, 'parent'); assert.equal(demo.seats.length, 1); assert.equal(demo.seats[0].sandboxId, 'sb-demo'); assert.ok(demo.expiresAt <= w.parent.expiresAt);
  assert.equal(w.s.data.get('lab:parent').seats[0].sandboxId, 'sb-peer');
  assert.equal((await w.state.labInvite('admin', demo.id)).status, 409);
  assert.equal((await w.state.labSeatInfo(demo.seats[0].code)).status, 403);
  assert.equal((await w.state.labJoin(demo.seats[0].code)).status, 403);
  const list = await w.state.labList('admin'); assert.ok(!list.labs.some(l => l.id === demo.id));
  w.restart(); await w.state.labClassroomDemoPrepare('admin', 'parent', uuid(2)); assert.equal(w.created, 1);
});
await test('actual command targets only dedicated sandbox; repeat request has one provider effect', async () => {
  const w = await world(); await w.state.labClassroomDemoPrepare('admin', 'parent', uuid(1)); await Promise.allSettled(w.tasks);
  const before = w.commands.length; const r = await w.state.labClassroomDemoSend('admin', 'parent', uuid(2), 'pwd');
  assert.match(r.output, /demo output/); assert.equal(w.commands.length, before + 1); assert.equal(w.commands.at(-1).path, '/sb-demo/process/execute');
  await w.state.labClassroomDemoSend('admin', 'parent', uuid(2), 'pwd'); assert.equal(w.commands.length, before + 1);
  assert.ok(!w.commands.some(c => c.path.includes('sb-peer')));
});
await test('grant yields only demo seat after actual preparation, then cannot be used again', async () => {
  const w = await world(); const ready = await w.state.labClassroomDemoPrepare('admin', 'parent', uuid(1)); await Promise.allSettled(w.tasks);
  const demo = w.s.data.get('lab:' + ready.demoId); const url = (await w.state.labClassroomDemoOpen('admin', 'parent')).url;
  const grant = new URL(url).hash.slice(1); const r = await w.state.labClassroomDemoClaim(grant, demo.seats[0].label);
  assert.equal(r.code, demo.seats[0].code); assert.equal((await w.state.labClassroomDemoClaim(grant, demo.seats[0].label)).status, 410);
});
await test('parent end cleans dedicated demo and blocks subsequent commands', async () => {
  const w = await world(); const r = await w.state.labClassroomDemoPrepare('admin', 'parent', uuid(1)); await Promise.allSettled(w.tasks);
  const ended = await w.state.labEnd('admin', 'parent'); assert.equal(ended.ok, true);
  assert.ok(w.deleted.includes('/sandbox/sb-demo')); assert.ok(!w.s.data.has('lab:' + r.demoId)); assert.ok(!w.s.data.has('labdemo:parent'));
  assert.equal((await w.state.labClassroomDemoSend('admin', 'parent', uuid(2), 'pwd')).status, 410);
});
await test('materials RPC uses saved classroom sources and only the authenticated seat label', async () => {
  const w = await world();
  assert.equal((await w.state.labClassroomMaterials('participant00001', 'c'.repeat(26))).status, 403);
  assert.equal(w.commands.length, 0);
  const r = await w.state.labClassroomMaterials('participant00001', 'b'.repeat(26));
  assert.ok(r.files, JSON.stringify(r)); assert.deepEqual(r.files.map(f => f.name), ['01_요청메모.txt', '02_진행메모.txt']);
  assert.equal(w.commands.length, 1); assert.equal(w.commands[0].path, '/sb-peer/process/execute');
  await w.s.put('labprepstop:parent', { at: Date.now() });
  const before = w.commands.length; assert.ok((await w.state.labClassroomMaterials('participant00001', 'b'.repeat(26))).status >= 400); assert.equal(w.commands.length, before);
});
await test('route embedding metadata belongs only to live private demo parents', async () => {
  const w=await world();const ready=await w.state.labClassroomDemoPrepare('admin','parent',uuid(1));await Promise.allSettled(w.tasks);
  const demo=w.s.data.get('lab:'+ready.demoId),peer=w.s.data.get('lab:parent');
  for(const lab of [demo,peer]){lab.seats[0].pv={origin:'https://preview.invalid',token:'synthetic-preview'};await w.s.put('lab:'+lab.id,lab)}
  assert.equal((await w.state.labRoute(demo.seats[0].code)).demoParent,'parent');
  assert.equal((await w.state.labRoute(peer.seats[0].code)).demoParent,undefined);
  await w.s.put('labprepstop:parent',{at:Date.now()});
  assert.equal((await w.state.labRoute(demo.seats[0].code)).status,410);
});
console.log(count + ' actual State demo checks passed');
