// Real State. Daytona is a local fixture: probe, download, and lab deletion only.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const built = await build({ entryPoints: ['src/state.ts'], bundle: true, write: false, platform: 'node', format: 'esm', external: ['cloudflare:workers'], logLevel: 'silent' });
const code = built.outputFiles[0].text.replace(/import\s*\{\s*DurableObject\s*\}\s*from\s*["']cloudflare:workers["'];?/, 'class DurableObject{constructor(ctx,env){this.ctx=ctx;this.env=env}}');
const S = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
const uuid = (n) => `b0000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const CODE1 = 'seatcode00000001';
const CODE2 = 'seatcode00000002';
const TEACHER = 'abcdefghijklmnopqrstuvwxyz012345';
const TEXT = '확정: 신청자 10명\n검토: 정원 12명\n';

function memory() {
  const data = new Map();
  const copy = (x) => x === undefined ? x : structuredClone(x);
  let lock = Promise.resolve();
  let alarmAt = null;
  const storage = {
    data,
    async get(k) { return Array.isArray(k) ? new Map(k.filter((x) => data.has(x)).map((x) => [x, copy(data.get(x))])) : copy(data.get(k)); },
    async put(k, v) { if (typeof k === 'object' && k) { for (const [a, b] of Object.entries(k)) data.set(a, copy(b)); } else data.set(k, copy(v)); },
    async delete(k) { for (const x of Array.isArray(k) ? k : [k]) data.delete(x); },
    async list({ prefix = '', limit = Infinity } = {}) { return new Map([...data].filter(([key]) => String(key).startsWith(prefix)).slice(0, limit).map(([k, v]) => [k, copy(v)])); },
    async getAlarm() { return alarmAt; },
    async setAlarm(t) { alarmAt = t; },
    transaction(fn) { const p = lock.then(() => fn(storage)); lock = p.catch(() => {}); return p; },
  };
  return storage;
}

async function sha256(bytes) {
  const copy = new Uint8Array(bytes);
  return Buffer.from(await crypto.subtle.digest('SHA-256', copy)).toString('hex');
}

async function world() {
  const storage = memory();
  const effects = [];
  let block = null, waiting = false, release = () => {};
  let mode = { kind: 'text', bytes: new TextEncoder().encode(TEXT) };
  class Fixture extends S.State { async daytona() { return { api: 'https://provider.invalid', key: 'fixture-key' }; } }
  const env = { ORIGIN: 'https://admin.invalid', LAB_ORIGIN: 'https://lab.invalid', LAB_SEAT_DOMAIN: 'seat.invalid' };
  const state = new Fixture({ storage, waitUntil() {}, blockConcurrencyWhile: (fn) => fn() }, env);
  for (let i = 0; i < 20 && !(await storage.get('mig:grants')); i++) await new Promise((r) => setImmediate(r));
  const lab = {
    id: 'lab', name: 'night', createdAt: Date.now(), expiresAt: Date.now() + 3600000, budget: 1,
    cpu: 1, memory: 2, disk: 3, snapshot: 'v5', model: 'fixture', gw: 'https://gw.invalid',
    seats: [{ n: 1, code: CODE1, sandboxId: 'sb-1', label: 'label-1', who: '가람' }, { n: 2, code: CODE2, sandboxId: 'sb-2', label: 'label-2', who: '나래' }],
  };
  await storage.put('lab:lab', lab);
  for (const seat of lab.seats) await storage.put('seat:' + seat.code, { lab: 'lab', n: seat.n });
  await storage.put('admin:' + await S.sha('admin'), { expiresAt: Date.now() + 600000 });
  await storage.put('teacher:' + await S.sha(TEACHER), { createdAt: Date.now(), expiresAt: Date.now() + 8 * 3600e3 });
  async function hold(kind) { if (block === kind && !waiting) { waiting = true; await new Promise((r) => { release = r; }); block = null; } }
  globalThis.fetch = async (input, init = {}) => {
    const u = new URL(input), method = init.method ?? 'GET';
    if (u.host === 'provider.invalid' && method === 'DELETE' && u.pathname.startsWith('/sandbox/')) { effects.push({ kind: 'delete' }); return Response.json({}); }
    if (u.host === 'provider.invalid' && u.pathname === '/sandbox') return Response.json({ items: [] });
    if (u.host === 'provider.invalid' && u.pathname.startsWith('/sandbox/')) {
      effects.push({ kind: 'lookup', sb: u.pathname.split('/')[2] });
      return Response.json({ id: u.pathname.split('/')[2], state: 'started', toolboxProxyUrl: 'https://toolbox.invalid' });
    }
    if (u.host === 'toolbox.invalid' && u.pathname.endsWith('/process/execute')) {
      const command = JSON.parse(init.body).command;
      effects.push({ kind: 'probe', sb: u.pathname.split('/')[1], command });
      await hold('probe');
      if (mode.kind === 'err') return Response.json({ exitCode: 3, result: mode.line + '\n' });
      const bytes = mode.probe ?? mode.bytes;
      const hash = mode.hash ?? await sha256(bytes);
      const len = mode.len ?? bytes.byteLength;
      return Response.json({ exitCode: 0, result: `OK ${hash} ${len}\n` });
    }
    if (u.host === 'toolbox.invalid' && u.pathname.endsWith('/files/download')) {
      effects.push({ kind: 'download', sb: u.pathname.split('/')[1], path: u.searchParams.get('path') });
      await hold('download');
      if (mode.kind === 'missing-download') return new Response('gone', { status: 404 });
      return new Response(mode.bytes);
    }
    throw new Error('fixture rejected network ' + method + ' ' + u.href);
  };
  return {
    state, storage, effects, lab, set mode(v) { mode = v; },
    block(kind) { block = kind; waiting = false; }, release() { release(); },
    async held() { const end = Date.now() + 2000; while (!waiting && Date.now() < end) await new Promise((r) => setTimeout(r, 2)); assert.ok(waiting); },
    async editLab(fn) { const row = await storage.get('lab:lab'); fn(row); await storage.put('lab:lab', row); },
  };
}

const dumped = (w) => JSON.stringify([...w.storage.data.values()]);
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log('ok', name); }

await test('submit reads only WORK/결과.txt and stores that text', async () => {
  const w = await world();
  assert.equal((await w.state.labClassroomSubmit(CODE1, uuid(1), '다른.txt')).status, 400);
  assert.equal(w.effects.length, 0);
  const view = await w.state.labClassroomSubmit(CODE1, uuid(1), '결과.txt');
  assert.equal(view.submissions[0].content, TEXT);
  assert.equal(view.submissions[0].filename, '결과.txt');
  assert.deepEqual(w.effects.map((item) => item.kind), ['lookup', 'probe', 'download']);
  assert.equal(w.effects[2].path, '/home/daytona/work/결과.txt');
  const script = Buffer.from(w.effects[1].command.match(/Buffer\.from\('([^']+)'/)[1], 'base64').toString('utf8');
  assert.match(script, /realpathSync/);
  assert.match(script, /O_NOFOLLOW/);
  assert.ok(script.includes("/home/daytona/work"));
  assert.ok(script.includes('결과.txt'));
  assert.equal(script.includes('process.argv'), false);
  assert.equal(w.effects[1].command.includes(uuid(1)), false);
  assert.equal(w.effects[1].command.includes('sb-1'), false);
  const peer = await w.state.labClassroomSeatStatus(CODE2);
  assert.equal(peer.submissions.length, 0);
  assert.equal(JSON.stringify(peer).includes(TEXT), false);
  const teacher = await w.state.labClassroomTeacherStatus(TEACHER, 'lab');
  assert.equal(teacher.participants.find((seat) => seat.n === 1).submissions[0].content, TEXT);
  const body = JSON.stringify(teacher);
  assert.equal(body.includes(CODE1), false);
  assert.equal(body.includes('sb-1'), false);
  assert.equal(body.includes(TEACHER), false);
  assert.equal(body.includes('fixture-key'), false);
  assert.equal(body.includes('grant'), false);
});

for (const [name, spec, status] of [
  ['missing file', { kind: 'err', line: 'ERR missing' }, 404],
  ['symlink', { kind: 'err', line: 'ERR symlink' }, 400],
  ['probe oversize', { kind: 'err', line: 'ERR oversize' }, 413],
]) await test(name + ' does not download or store', async () => {
  const w = await world();
  w.mode = spec;
  const result = await w.state.labClassroomSubmit(CODE1, uuid(2), '결과.txt');
  assert.equal(result.status, status);
  assert.deepEqual(w.effects.map((item) => item.kind), ['lookup', 'probe']);
  assert.equal(dumped(w).includes('SECRET'), false);
  assert.equal((await w.state.labClassroomSeatStatus(CODE1)).submissions.length, 0);
});

await test('hash mismatch, NUL, and invalid UTF-8 are not stored', async () => {
  const w = await world();
  const bytes = new TextEncoder().encode('SECRET-MISMATCH');
  w.mode = { kind: 'text', bytes, hash: await sha256(new TextEncoder().encode('other')) };
  assert.equal((await w.state.labClassroomSubmit(CODE1, uuid(3), '결과.txt')).status, 400);
  w.mode = { kind: 'text', bytes: Uint8Array.from([0x41, 0x00, 0x42]) };
  assert.equal((await w.state.labClassroomSubmit(CODE1, uuid(4), '결과.txt')).status, 400);
  w.mode = { kind: 'text', bytes: Uint8Array.from([0xff, 0xfe]) };
  assert.equal((await w.state.labClassroomSubmit(CODE1, uuid(5), '결과.txt')).status, 400);
  assert.equal(dumped(w).includes('SECRET-MISMATCH'), false);
  assert.equal((await w.state.labClassroomSeatStatus(CODE1)).submissions.length, 0);
});

await test('download oversize is rejected after the probe', async () => {
  const w = await world();
  const huge = new Uint8Array(70 * 1024);
  huge.fill(0x61);
  w.mode = { kind: 'text', bytes: huge, probe: new TextEncoder().encode('short'), len: 5, hash: await sha256(new TextEncoder().encode('short')) };
  assert.equal((await w.state.labClassroomSubmit(CODE1, uuid(6), '결과.txt')).status, 413);
  assert.equal(w.effects.some((item) => item.kind === 'download'), true);
  assert.equal(dumped(w).includes('a'.repeat(100)), false);
});

await test('a sandbox swap during the probe or download stores nothing', async () => {
  for (const phase of ['probe', 'download']) {
    const w = await world();
    w.mode = { kind: 'text', bytes: new TextEncoder().encode('SECRET-SWAP') };
    w.block(phase);
    const pending = w.state.labClassroomSubmit(CODE1, uuid(7), '결과.txt');
    await w.held();
    const before = w.effects.filter((item) => item.kind === 'download').length;
    await w.editLab((lab) => { lab.seats[0].sandboxId = 'sb-next'; });
    w.release();
    assert.equal((await pending).status, 409);
    if (phase === 'probe') assert.equal(w.effects.filter((item) => item.kind === 'download').length, before);
    assert.equal(dumped(w).includes('SECRET-SWAP'), false);
    assert.equal((await w.state.labClassroomSeatStatus(CODE1)).submissions.length, 0);
    const downloads = w.effects.filter((item) => item.kind === 'download').length;
    assert.equal((await w.state.labClassroomSubmit(CODE1, uuid(7), '결과.txt')).status, 409);
    assert.equal(w.effects.filter((item) => item.kind === 'download').length, downloads);
  }
});

await test('lab end keeps the review record and the alarm drops only classroom keys', async () => {
  const w = await world();
  const submitted = await w.state.labClassroomSubmit(CODE1, uuid(8), '결과.txt');
  assert.equal(submitted.submissions[0].content, TEXT);
  const moved = await w.state.labClassroomProgress(CODE1, 3, false);
  assert.equal(moved.progress.step, 3);
  assert.equal(moved.classroom.currentStep, 0);
  const ended = await w.state.labEnd('admin', 'lab');
  assert.equal(ended.ok, true);
  assert.equal(await w.storage.get('lab:lab'), undefined);
  assert.equal(await w.storage.get('seat:' + CODE1), undefined);
  assert.ok(await w.storage.get('labclassroom:lab'));
  assert.equal((await w.state.labClassroomSeatStatus(CODE1)).status, 404);
  const admin = await w.state.labClassroomStatus('admin', 'lab');
  assert.equal(admin.participants.find((seat) => seat.n === 1).submissions[0].content, TEXT);
  assert.equal(admin.participants.find((seat) => seat.n === 1).progress.step, 3);
  const doc = await w.storage.get('labclassroom:lab');
  doc.retainUntil = 1;
  await w.storage.put('labclassroom:lab', doc);
  await w.storage.put('keep:other', { ok: true });
  await w.state.alarm();
  assert.equal(await w.storage.get('labclassroom:lab'), undefined);
  assert.equal(await w.storage.get('labclassroom-seat:lab:1'), undefined);
  assert.deepEqual(await w.storage.get('keep:other'), { ok: true });
  assert.equal((await w.state.labClassroomStatus('admin', 'lab')).status, 404);
});

console.log('PASS classroom State read fence and retention', passed);
