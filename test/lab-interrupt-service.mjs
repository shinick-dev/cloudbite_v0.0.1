// 네트워크 없이 중단 서비스 번들과 주입된 가짜 의존성만 검사한다.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const bundle = await build({ entryPoints: ['src/lab-interrupt-service.ts'], bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent' });
const M = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
globalThis.fetch = () => { throw new Error('network forbidden'); };
const uuid = (n) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const TOKEN = 'admin-secret-token';
const COMMAND = 'sudo rm -rf / --interrupt';
const STDOUT = 'secret-stdout-blob';
const FP = 'ab'.repeat(32);
const tick = () => new Promise((r) => setImmediate(r));
const held = () => { let release; const promise = new Promise((r) => { release = r; }); return { promise, release }; };
async function until(f) { for (let i = 0; i < 100 && !f(); i++) await tick(); assert.ok(f()); }
const leaked = (value) => {
  const text = JSON.stringify(value);
  return text.includes(TOKEN) || text.includes(COMMAND) || text.includes(STDOUT);
};
const baseContext = () => ({
  owner: 'ownerhash', sessionId: 'session-1', revision: 3, fingerprint: 'config-fingerprint',
  refs: [1, 2, 3].map((n) => ({ labId: 'lab', n, code: `code-${n}`, sandboxId: `sb-${n}` })),
});
function world() {
  const data = new Map(), audit = [], probeCalls = [], remoteCalls = [], listLimits = [];
  const copy = (x) => x === undefined ? x : structuredClone(x);
  let lock = Promise.resolve();
  let T = 1800000000000;
  let revoked = false, revokeAfterGets = 0, contextFail = null, probeHold = null, remoteHold = null, probeResult = null, probeThrow = false, remoteImpl = null;
  let contextCalls = 0;
  const ctx = baseContext();
  const storage = {
    async get(k) {
      if (storage.failGet) throw new Error('secret disk path ' + TOKEN + ' ' + STDOUT);
      const value = copy(data.get(k));
      if (revokeAfterGets > 0 && --revokeAfterGets === 0) revoked = true;
      return value;
    },
    async put(k, v) { if (storage.failPut) throw new Error('secret disk path ' + TOKEN + ' ' + COMMAND); data.set(k, copy(v)); },
    async list(opts = {}) {
      if (typeof opts.limit !== 'number' || opts.limit > M.LAB_INTERRUPT_PREVIEW_LIMIT) throw new Error('unbounded list');
      listLimits.push(opts.limit);
      const out = new Map();
      for (const [k, v] of data) {
        if (typeof k === 'string' && k.startsWith(opts.prefix ?? '')) {
          out.set(k, copy(v));
          if (out.size >= opts.limit) break;
        }
      }
      return out;
    },
    transaction(fn) { const p = lock.then(() => fn(storage)); lock = p.catch(() => {}); return p; },
    failGet: false, failPut: false,
  };
  const deps = {
    storage, now: () => T,
    authorize: async (token, id) => token !== TOKEN || revoked ? { status: 401, error: '관리 세션이 만료됐습니다.' } : id === 'lab' ? null : { status: 404, error: '없는 실습실입니다.' },
    context: async () => { contextCalls++; if (contextFail) return contextFail; return structuredClone(ctx); },
    probe: async (token, ref, sessionId) => {
      probeCalls.push({ n: ref.n, sessionId });
      if (probeHold?.n === ref.n) await probeHold.gate.promise;
      if (probeThrow) throw new Error(STDOUT + ' ' + TOKEN + ' ' + COMMAND);
      if (probeResult) return typeof probeResult === 'function' ? probeResult(ref) : probeResult;
      return { fingerprint: FP, paneId: `%${ref.n}`, program: ref.n === 3 ? 'node' : 'python' };
    },
    remote: async (token, ref, record, requestId, gate) => {
      remoteCalls.push({ n: ref.n, requestId, open: gate() });
      if (remoteHold?.n === ref.n) await remoteHold.gate.promise;
      if (remoteImpl) return remoteImpl(token, ref, record, requestId, gate);
      return gate() ? 'sent' : 'changed';
    },
    audit: async (event, detail) => { audit.push([event, detail]); },
  };
  return {
    data, audit, storage, deps, ctx, probeCalls, remoteCalls, listLimits, make: () => new M.LabInterruptService(deps),
    set time(v) { T = v; }, get time() { return T; },
    revoke(v = true) { revoked = v; }, armRevokeAfterGets(n) { revokeAfterGets = n; },
    failContext(v) { contextFail = v; },
    holdProbe(n) { const gate = held(); probeHold = { n, gate }; return gate; },
    holdRemote(n) { const gate = held(); remoteHold = { n, gate }; return gate; },
    clearHolds() { probeHold = null; remoteHold = null; },
    set probeResult(v) { probeResult = v; }, set probeThrow(v) { probeThrow = v; }, set remoteImpl(v) { remoteImpl = v; },
    contexts: () => contextCalls,
  };
}
const previewRow = (w, id) => w.data.get(M.interruptPreviewKey('lab', id));
const opRow = (w, id) => w.data.get(M.interruptOperationKey('lab', id));
let pass = 0;
async function test(name, f) { await f(); pass++; console.log('ok', name); }

await test('paused revision, exact subset, and proof-only preview', async () => {
  const w = world(), s = w.make();
  assert.equal(M.LAB_INTERRUPT_TTL_MS, 60000);
  assert.equal(M.interruptPreviewKey('lab', uuid(1)), `labint:p:lab:${uuid(1)}`);
  assert.equal(M.interruptOperationKey('a/b', uuid(1)), `labint:o:${encodeURIComponent('a/b')}:${uuid(1)}`);
  assert.equal((await s.prepare('', 'lab', uuid(1), [1], 3)).status, 401);
  assert.equal((await s.prepare(TOKEN, 'lab', 'not-a-uuid', [1], 3)).status, 400);
  for (const seats of [[], [1, 1], [0], [51], [1.5], ['1']]) assert.equal((await s.prepare(TOKEN, 'lab', uuid(1), seats, 3)).status, 400);
  assert.equal((await s.prepare(TOKEN, 'lab', uuid(1), [1], '3')).status, 400);
  assert.equal((await s.prepare(TOKEN, 'lab', uuid(1), [1], -1)).status, 400);
  w.failContext({ status: 409, error: '명령 전달이 일시정지 상태가 아닙니다.' });
  assert.equal((await s.prepare(TOKEN, 'lab', uuid(1), [1], 3)).status, 409);
  w.failContext(null);
  assert.equal((await s.prepare(TOKEN, 'lab', uuid(1), [1], 2)).status, 409);
  assert.equal((await s.prepare(TOKEN, 'lab', uuid(1), [4], 3)).status, 409);
  assert.equal(w.probeCalls.length, 0);
  assert.equal(w.remoteCalls.length, 0);
  const view = await s.prepare(TOKEN, 'lab', uuid(1), [3, 1], 3);
  assert.deepEqual(Object.keys(view).sort(), ['expiresAt', 'previewId', 'revision', 'targets']);
  assert.equal(view.previewId, uuid(1));
  assert.equal(view.revision, 3);
  assert.equal(view.expiresAt, w.time + 60000);
  assert.deepEqual(view.targets, [{ n: 1, program: 'python' }, { n: 3, program: 'node' }]);
  assert.deepEqual(w.probeCalls.map((c) => c.n), [1, 3]);
  assert.equal(w.probeCalls.every((c) => c.sessionId === 'session-1'), true);
  assert.equal(w.remoteCalls.length, 0);
  const body = JSON.stringify(view);
  for (const secret of [TOKEN, COMMAND, STDOUT, 'code-1', 'sb-1', '%1', FP, 'ownerhash', 'config-fingerprint']) assert.equal(body.includes(secret), false);
  const stored = previewRow(w, uuid(1));
  assert.equal(stored.targets[0].ref.code, 'code-1');
  assert.equal(stored.targets[0].ref.sandboxId, 'sb-1');
  assert.equal(stored.targets[0].proof.paneId, '%1');
  assert.equal(stored.targets[0].proof.program, 'python');
  assert.equal(stored.consumedBy, null);
  assert.equal(leaked(w.data), false);
  assert.equal(leaked(w.audit), false);
  assert.equal(JSON.stringify(w.audit).includes('python'), false);
  assert.equal(w.listLimits.every((n) => n === 128 || n === 100), true);
});

await test('same preview replays and conflicts do not probe again', async () => {
  const w = world(), s = w.make();
  const first = await s.prepare(TOKEN, 'lab', uuid(1), [1, 3], 3);
  const probes = w.probeCalls.length;
  const again = await s.prepare(TOKEN, 'lab', uuid(1), [3, 1], 3);
  assert.deepEqual(again, first);
  assert.equal(w.probeCalls.length, probes);
  const conflict = await s.prepare(TOKEN, 'lab', uuid(1), [2], 3);
  assert.equal(conflict.status, 409);
  assert.equal(w.probeCalls.length, probes);
  assert.equal(previewRow(w, uuid(1)).expiresAt, first.expiresAt);
  assert.deepEqual(previewRow(w, uuid(1)).targets.map((t) => t.ref.n), [1, 3]);
});

await test('expired preview is not renewed or consumed', async () => {
  const w = world(), s = w.make();
  const first = await s.prepare(TOKEN, 'lab', uuid(1), [1], 3);
  const probes = w.probeCalls.length;
  w.time = first.expiresAt;
  const expired = await s.prepare(TOKEN, 'lab', uuid(1), [1], 3);
  assert.equal(expired.status, 410);
  assert.equal(w.probeCalls.length, probes);
  const request = await s.request(TOKEN, 'lab', uuid(1), uuid(2));
  assert.equal(request.status, 410);
  assert.equal(previewRow(w, uuid(1)).consumedBy, null);
  assert.equal(w.remoteCalls.length, 0);
  assert.equal(opRow(w, uuid(2)), undefined);
});

await test('owner, session, revision, fingerprint, and ref changes block a new action', async () => {
  const w = world(), s = w.make();
  await s.prepare(TOKEN, 'lab', uuid(1), [1], 3);
  const changes = [
    () => { w.ctx.owner = 'other-owner'; },
    () => { w.ctx.sessionId = 'session-2'; },
    () => { w.ctx.revision = 4; },
    () => { w.ctx.fingerprint = 'other-fingerprint'; },
    () => { w.ctx.refs[0].code = 'other-code'; },
    () => { w.ctx.refs[0].sandboxId = 'other-sandbox'; },
  ];
  for (const [i, change] of changes.entries()) {
    const before = structuredClone(w.ctx);
    change();
    const denied = await s.request(TOKEN, 'lab', uuid(1), uuid(10 + i));
    assert.equal(denied.status, 409);
    assert.equal(previewRow(w, uuid(1)).consumedBy, null);
    assert.equal(w.remoteCalls.length, 0);
    Object.assign(w.ctx, before);
    w.ctx.refs = before.refs;
  }
  const ok = await s.request(TOKEN, 'lab', uuid(1), uuid(30));
  assert.equal(ok.results[0].status, 'sent');
  assert.equal(ok.results[0].note.includes('종료 여부는 확인하지 않습니다'), true);
  assert.equal(/완료|멈췄|stopped|complete/i.test(JSON.stringify(ok)), false);
});

await test('new action stores pending before remote and replays without another effect', async () => {
  const w = world(), s = w.make();
  const preview = await s.prepare(TOKEN, 'lab', uuid(1), [1], 3);
  const gate = w.holdRemote(1);
  const pending = s.request(TOKEN, 'lab', preview.previewId, uuid(2));
  await until(() => w.remoteCalls.length === 1);
  assert.equal(opRow(w, uuid(2)).results[0].status, 'pending');
  assert.equal(previewRow(w, uuid(1)).consumedBy, uuid(2));
  assert.equal(w.remoteCalls[0].open, true);
  const contexts = w.contexts();
  const mid = await s.request(TOKEN, 'lab', preview.previewId, uuid(2));
  assert.equal(mid.results[0].status, 'pending');
  assert.equal(w.remoteCalls.length, 1);
  assert.equal(w.contexts(), contexts);
  gate.release();
  const done = await pending;
  assert.equal(done.results[0].status, 'sent');
  assert.deepEqual(Object.keys(done).sort(), ['requestId', 'results']);
  assert.deepEqual(Object.keys(done.results[0]).sort(), ['n', 'note', 'status']);
  assert.equal(w.remoteCalls.length, 1);
  const replayContexts = w.contexts();
  assert.deepEqual(await s.request(TOKEN, 'lab', preview.previewId, uuid(2)), done);
  assert.equal(w.contexts(), replayContexts);
  assert.equal(w.remoteCalls.length, 1);
});

await test('concurrent duplicate claims one action', async () => {
  const w = world(), s = w.make();
  await s.prepare(TOKEN, 'lab', uuid(1), [1, 2], 3);
  const gate = w.holdRemote(1);
  const first = s.request(TOKEN, 'lab', uuid(1), uuid(2));
  const second = s.request(TOKEN, 'lab', uuid(1), uuid(2));
  await until(() => w.remoteCalls.length === 1);
  gate.release();
  const [a, b] = await Promise.all([first, second]);
  const statuses = [a, b].map((x) => x.results.map((r) => r.status).join(','));
  assert.equal(statuses.includes('pending,pending') || statuses.includes('sent,sent'), true);
  assert.equal(statuses.filter((x) => x === 'sent,sent').length >= 1, true);
  assert.equal(w.remoteCalls.length, 2);
  assert.equal(w.remoteCalls.filter((c) => c.n === 1).length, 1);
  assert.equal(w.remoteCalls.filter((c) => c.n === 2).length, 1);
});

await test('in-flight pending stays pending and a reconstructed pending becomes unknown once', async () => {
  const w = world(), s = w.make();
  await s.prepare(TOKEN, 'lab', uuid(1), [1], 3);
  const gate = w.holdRemote(1);
  const live = s.request(TOKEN, 'lab', uuid(1), uuid(2));
  await until(() => w.remoteCalls.length === 1);
  const early = await w.make().request(TOKEN, 'lab', uuid(1), uuid(2));
  assert.equal(early.results[0].status, 'unknown');
  assert.equal(early.results[0].note, '중단 입력 결과를 확인하지 못했습니다. 다시 보내지 않습니다.');
  assert.equal(w.remoteCalls.length, 1);
  gate.release();
  const done = await live;
  assert.equal(done.results[0].status, 'unknown');
  assert.equal(w.remoteCalls.length, 1);
  assert.equal((await w.make().request(TOKEN, 'lab', uuid(1), uuid(2))).results[0].status, 'unknown');
  assert.equal(w.remoteCalls.length, 1);

  const seeded = world();
  seeded.data.set(M.interruptOperationKey('lab', uuid(7)), { requestId: uuid(7), previewId: uuid(8), results: [{ n: 1, status: 'pending', note: 'x' }] });
  assert.equal((await seeded.make().request(TOKEN, 'lab', uuid(9), uuid(7))).status, 409);
  assert.equal(seeded.data.get(M.interruptOperationKey('lab', uuid(7))).results[0].status, 'pending');
  const sealed = await seeded.make().request(TOKEN, 'lab', uuid(8), uuid(7));
  assert.equal(sealed.results[0].status, 'unknown');
  assert.equal(seeded.remoteCalls.length, 0);
  assert.equal(seeded.contexts(), 0);
  assert.equal(seeded.probeCalls.length, 0);
});

await test('old result remains readable after control resumes', async () => {
  const w = world(), s = w.make();
  await s.prepare(TOKEN, 'lab', uuid(1), [1], 3);
  const done = await s.request(TOKEN, 'lab', uuid(1), uuid(2));
  assert.equal(done.results[0].status, 'sent');
  const contexts = w.contexts();
  const remotes = w.remoteCalls.length;
  w.failContext({ status: 409, error: '명령 전달이 일시정지 상태가 아닙니다.' });
  assert.deepEqual(await s.request(TOKEN, 'lab', uuid(1), uuid(2)), done);
  assert.equal(w.contexts(), contexts);
  assert.equal(w.remoteCalls.length, remotes);
  assert.equal((await s.request(TOKEN, 'lab', uuid(9), uuid(2))).status, 409);
});

await test('changed pane, delivered input, and unknown are distinct', async () => {
  const w = world(), s = w.make();
  await s.prepare(TOKEN, 'lab', uuid(1), [1, 2, 3], 3);
  w.remoteImpl = (token, ref, record, requestId, gate) => {
    assert.equal(typeof gate(), 'boolean');
    assert.equal(record.targets.some((t) => t.proof.paneId === `%${ref.n}`), true);
    if (ref.n === 2) return 'changed';
    if (ref.n === 3) throw new Error(STDOUT + ' ' + TOKEN + ' ' + COMMAND);
    return 'duplicate';
  };
  const view = await s.request(TOKEN, 'lab', uuid(1), uuid(2));
  assert.deepEqual(view.results.map((r) => r.status), ['unknown', 'changed', 'unknown']);
  assert.equal(leaked(view), false);
  assert.equal(leaked(w.audit), false);
  assert.equal(leaked([...w.data.values()]), false);
  assert.equal(/완료|멈췄|stopped|complete/i.test(JSON.stringify(view)), false);
  await s.prepare(TOKEN, 'lab', uuid(3), [2], 3);
  w.remoteImpl = () => 'sent';
  const sent = await s.request(TOKEN, 'lab', uuid(3), uuid(4));
  assert.equal(sent.results[0].status, 'sent');
  assert.equal(JSON.stringify(sent).includes('python'), false);
  const reused = await s.request(TOKEN, 'lab', uuid(3), uuid(5));
  assert.equal(reused.status, 409);
  assert.equal(w.remoteCalls.filter((c) => c.requestId === uuid(5)).length, 0);
});

await test('end while probe or remote is held skips later targets', async () => {
  const w = world(), s = w.make();
  const probe = w.holdProbe(1);
  const preparing = s.prepare(TOKEN, 'lab', uuid(1), [1, 2], 3);
  await until(() => w.probeCalls.some((c) => c.n === 1));
  const ended = s.end('lab');
  assert.equal(ended.ended, true);
  assert.equal(w.data.size, 0);
  probe.release();
  assert.equal((await preparing).status, 410);
  assert.equal(w.probeCalls.some((c) => c.n === 2), false);
  assert.equal(w.data.size, 0);

  const w2 = world(), s2 = w2.make();
  await s2.prepare(TOKEN, 'lab', uuid(1), [1, 2], 3);
  const remote = w2.holdRemote(1);
  const requesting = s2.request(TOKEN, 'lab', uuid(1), uuid(2));
  await until(() => w2.remoteCalls.length === 1);
  assert.equal(s2.end('lab').ended, true);
  remote.release();
  const view = await requesting;
  assert.deepEqual(view.results.map((r) => r.status), ['changed', 'skipped']);
  assert.equal(w2.remoteCalls.length, 1);
  assert.equal((await s2.prepare(TOKEN, 'lab', uuid(3), [1], 3)).status, 410);
  assert.equal((await s2.request(TOKEN, 'lab', uuid(1), uuid(2))).results[0].status, 'changed');
});

await test('request is not blocked behind an in-flight preview probe', async () => {
  const w = world(), s = w.make();
  const first = await s.prepare(TOKEN, 'lab', uuid(1), [1], 3);
  const probe = w.holdProbe(2);
  const preparing = s.prepare(TOKEN, 'lab', uuid(2), [1, 2], 3);
  await until(() => w.probeCalls.some((c) => c.n === 2));
  const sent = await s.request(TOKEN, 'lab', first.previewId, uuid(9));
  assert.equal(sent.results[0].status, 'sent');
  probe.release();
  const second = await preparing;
  assert.equal(second.previewId, uuid(2));
  assert.deepEqual(second.targets.map((t) => t.n), [1, 2]);
});

await test('revoked authority during a storage read does not claim', async () => {
  const w = world(), s = w.make();
  await s.prepare(TOKEN, 'lab', uuid(1), [1], 3);
  w.armRevokeAfterGets(1);
  const denied = await s.request(TOKEN, 'lab', uuid(1), uuid(2));
  assert.equal(denied.status, 401);
  assert.equal(JSON.stringify(denied).includes(TOKEN), false);
  assert.equal(previewRow(w, uuid(1)).consumedBy, null);
  assert.equal(opRow(w, uuid(2)), undefined);
  assert.equal(w.remoteCalls.length, 0);
  w.revoke(false);
  const ok = await s.request(TOKEN, 'lab', uuid(1), uuid(2));
  assert.equal(ok.results[0].status, 'sent');
});

await test('preview and action caps stay bounded and replay survives them', async () => {
  const previews = world(), ps = previews.make();
  for (let i = 1; i <= 128; i++) assert.equal((await ps.prepare(TOKEN, 'lab', uuid(i), [1], 3)).previewId, uuid(i));
  const probes = previews.probeCalls.length;
  const extra = await ps.prepare(TOKEN, 'lab', uuid(129), [1], 3);
  assert.equal(extra.status, 429);
  assert.equal(previews.probeCalls.length, probes);
  assert.equal((await ps.prepare(TOKEN, 'lab', uuid(1), [1], 3)).previewId, uuid(1));
  assert.equal(previews.probeCalls.length, probes);
  assert.equal(previews.listLimits.every((n) => n === 128), true);

  const actions = world(), as = actions.make();
  for (let i = 1; i <= 100; i++) {
    assert.equal((await as.prepare(TOKEN, 'lab', uuid(1000 + i), [1], 3)).previewId, uuid(1000 + i));
    assert.equal((await as.request(TOKEN, 'lab', uuid(1000 + i), uuid(i))).results[0].status, 'sent');
  }
  const remotes = actions.remoteCalls.length;
  const extraPreview = await as.prepare(TOKEN, 'lab', uuid(2000), [1], 3);
  const denied = await as.request(TOKEN, 'lab', extraPreview.previewId, uuid(101));
  assert.equal(denied.status, 429);
  assert.equal(previewRow(actions, uuid(2000)).consumedBy, null);
  assert.equal(actions.remoteCalls.length, remotes);
  assert.equal((await as.request(TOKEN, 'lab', uuid(1001), uuid(1))).results[0].status, 'sent');
  assert.equal(actions.remoteCalls.length, remotes);
  assert.equal(actions.listLimits.every((n) => n === 128 || n === 100), true);
});

await test('storage and probe failures do not echo secrets', async () => {
  const w = world(), s = w.make();
  w.storage.failGet = true;
  const read = await s.prepare(TOKEN, 'lab', uuid(1), [1], 3);
  assert.equal(read.status, 503);
  assert.equal(leaked(read), false);
  w.storage.failGet = false;
  w.probeThrow = true;
  const thrown = await s.prepare(TOKEN, 'lab', uuid(1), [1], 3);
  assert.equal(thrown.status, 503);
  assert.equal(leaked(thrown), false);
  assert.equal(w.data.size, 0);
  w.probeThrow = false;
  w.probeResult = { status: 502, error: STDOUT + TOKEN + COMMAND };
  const failed = await s.prepare(TOKEN, 'lab', uuid(1), [1], 3);
  assert.equal(failed.status, 502);
  assert.equal(leaked(failed), false);
  w.probeResult = { fingerprint: 'AB', paneId: 'pane', program: 'python\nrm' };
  const invalid = await s.prepare(TOKEN, 'lab', uuid(1), [1], 3);
  assert.equal(invalid.status, 502);
  assert.equal(w.data.size, 0);
  w.probeResult = null;
  w.storage.failPut = true;
  const unstored = await s.prepare(TOKEN, 'lab', uuid(1), [1], 3);
  assert.equal(unstored.status, 503);
  assert.equal(leaked(unstored), false);
  assert.equal(w.data.size, 0);
  assert.equal((await s.end('')).status, 400);
});

console.log(`${pass} lab interrupt service scenarios passed`);
