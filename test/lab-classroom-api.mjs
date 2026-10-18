import assert from 'node:assert/strict';
import { build } from 'esbuild';
const built = await build({ entryPoints: ['src/lab-classroom-api.ts'], bundle: true, write: false, platform: 'node', format: 'esm', external: ['cloudflare:workers'], logLevel: 'silent' });
const builtCode = built.outputFiles[0].text.replace(/import\s*\{\s*DurableObject\s*\}\s*from\s*["']cloudflare:workers["'];?/, 'class DurableObject{constructor(ctx,env){this.ctx=ctx;this.env=env}}');
const { labClassroomApi } = await import('data:text/javascript;base64,' + Buffer.from(builtCode).toString('base64'));
const uuid = '70000000-0000-4000-8000-000000000001';
const teacher = 'abcdefghijklmnopqrstuvwxyz012345';
const paths = ['/api/lab/classroom/status', '/api/lab/classroom/update', '/api/lab/classroom/feedback', '/api/lab/classroom/history'];
let pass = 0;

function bodyFor(path) {
  if (path.endsWith('/history')) return {};
  if (path.endsWith('/update')) return { id: 'lab', revision: 4, patch: { title: '메모 수업' } };
  if (path.endsWith('/feedback')) return { id: 'lab', n: 1, submissionId: uuid, feedback: '좋아요' };
  return { id: 'lab' };
}

async function invoke(path, { admin = 'admin', origin = 'https://admin.invalid', method = 'POST', raw, headers = {}, cookie, state } = {}) {
  const calls = [];
  const head = { 'content-type': 'application/json', ...headers };
  if (origin) head.origin = origin;
  if (cookie) head.cookie = cookie;
  const payload = raw === undefined ? JSON.stringify(bodyFor(path)) : raw;
  const req = new Request('https://admin.invalid' + path, { method, headers: head, ...(method === 'POST' ? { body: payload } : {}) });
  const rpc = state ?? {
    async labClassroomHistory(...args) { calls.push(['history', ...args]); return { courses: [] }; },
    async labClassroomStatus(...args) { calls.push(['status', ...args]); return { classroom: { revision: 0 }, participants: [] }; },
    async labClassroomTeacherStatus(...args) { calls.push(['teacher', ...args]); return { classroom: { revision: 0 }, participants: [] }; },
    async labClassroomUpdate(...args) { calls.push(['update', ...args]); return { classroom: { revision: 5 }, participants: [] }; },
    async labClassroomFeedback(...args) { calls.push(['feedback', ...args]); return { classroom: { revision: 5 }, participants: [] }; },
  };
  const c = {
    path, req, admin, state: rpc, env: { ORIGIN: 'https://admin.invalid' },
    json: (x, status = 200) => Response.json(x, { status }),
    out: (x) => Response.json(x, { status: x.status ?? 200 }),
  };
  return { response: await labClassroomApi(c), calls };
}

for (const path of paths) {
  for (const [name, options, status] of [
    ['missing origin', { origin: null }, 403],
    ['foreign origin', { origin: 'https://evil.invalid' }, 403],
    ['GET', { method: 'GET' }, 405],
    ['invalid JSON', { raw: '{broken' }, 400],
    ['array body', { raw: '[]' }, 400],
    ['declared oversize', { headers: { 'content-length': String(96 * 1024 + 1) } }, 413],
  ]) {
    const result = await invoke(path, options);
    assert.equal(result.response.status, status, path + ' ' + name);
    assert.equal(result.calls.length, 0, path + ' ' + name);
    pass++;
  }
}

const noAdmin = await invoke('/api/lab/classroom/status', { admin: '' });
assert.equal(noAdmin.response.status, 401);
assert.equal(noAdmin.calls.length, 0);
pass++;

const badCookie = await invoke('/api/lab/classroom/status', { admin: '', cookie: '__Host-lab_teacher=short' });
assert.equal(badCookie.response.status, 400);
assert.match(badCookie.response.headers.get('set-cookie') ?? '', /Max-Age=0/);
assert.equal(badCookie.calls.length, 0);
pass++;

const cookieStatus = await invoke('/api/lab/classroom/status', { admin: '', cookie: `__Host-lab_teacher=${teacher}` });
assert.equal(cookieStatus.response.status, 200);
assert.deepEqual(cookieStatus.calls, [['teacher', teacher, 'lab']]);
assert.equal(cookieStatus.response.headers.get('set-cookie'), null);
pass++;

const expired = await invoke('/api/lab/classroom/status', {
  admin: '', cookie: `__Host-lab_teacher=${teacher}`,
  state: { async labClassroomTeacherStatus() { return { error: '강사 보기 세션이 만료됐습니다.', status: 401 }; } },
});
assert.equal(expired.response.status, 401);
assert.match(expired.response.headers.get('set-cookie') ?? '', /Max-Age=0/);
pass++;

for (const path of ['/api/lab/classroom/update', '/api/lab/classroom/feedback']) {
  const blocked = await invoke(path, { admin: '', cookie: `__Host-lab_teacher=${teacher}` });
  assert.equal(blocked.response.status, 401, path);
  assert.equal(blocked.calls.length, 0, path);
  pass++;
}

const status = await invoke('/api/lab/classroom/status');
assert.deepEqual(status.calls, [['status', 'admin', 'lab']]);
pass++;
const extra = await invoke('/api/lab/classroom/status', { raw: JSON.stringify({ id: 'lab', revision: 1 }) });
assert.equal(extra.response.status, 400);
assert.equal(extra.calls.length, 0);
pass++;
const update = await invoke('/api/lab/classroom/update');
assert.deepEqual(update.calls, [['update', 'admin', 'lab', 4, { title: '메모 수업' }]]);
pass++;
const feedback = await invoke('/api/lab/classroom/feedback');
assert.deepEqual(feedback.calls, [['feedback', 'admin', 'lab', 1, uuid, '좋아요']]);
pass++;

const stream = new ReadableStream({
  start(controller) {
    controller.enqueue(new TextEncoder().encode('{"id":"lab","pad":"'));
    controller.enqueue(new Uint8Array(100000));
    controller.close();
  },
});
const fat = new Request('https://admin.invalid/api/lab/classroom/status', { method: 'POST', headers: { origin: 'https://admin.invalid' }, body: stream, duplex: 'half' });
const fatResult = await labClassroomApi({
  path: '/api/lab/classroom/status', req: fat, admin: 'admin', env: { ORIGIN: 'https://admin.invalid' },
  state: { async labClassroomStatus() { throw new Error('should not dispatch'); } },
  json: (x, status = 200) => Response.json(x, { status }), out: (x) => Response.json(x),
});
assert.equal(fatResult.status, 413);
pass++;

const history = await invoke('/api/lab/classroom/history');
assert.equal(history.response.status, 200);
assert.deepEqual(history.calls, [['history', 'admin']]);
const blockedHistory = await invoke('/api/lab/classroom/history', { admin: '', cookie: `__Host-lab_teacher=${teacher}` });
assert.equal(blockedHistory.response.status, 401);
assert.equal(blockedHistory.calls.length, 0);
const badHistory = await invoke('/api/lab/classroom/history', { raw: '{"id":"lab"}' });
assert.equal(badHistory.response.status, 400);
assert.equal(badHistory.calls.length, 0);
for (const path of ['/api/lab/classroom/history', '/api/lab/classroom/status']) {
  const broken = await invoke(path, {state: {labClassroomHistory: async()=>{throw Error('RPC unavailable')}, labClassroomStatus:async()=>{throw Error('RPC unavailable')}}});
  assert.equal(broken.response.status, 503);
}
pass += 5;

const unrelated = await invoke('/api/lab/classroom/demo/status');
assert.equal(unrelated.response, null);
assert.equal(unrelated.calls.length, 0);
pass++;

const chained = await build({ entryPoints: ['src/lab-api.ts'], bundle: true, write: false, platform: 'node', format: 'esm', external: ['cloudflare:workers'], logLevel: 'silent' });
const chainedCode = chained.outputFiles[0].text.replace(/import\s*\{\s*DurableObject\s*\}\s*from\s*["']cloudflare:workers["'];?/, 'class DurableObject{constructor(ctx,env){this.ctx=ctx;this.env=env}}');
const { labApi } = await import('data:text/javascript;base64,' + Buffer.from(chainedCode).toString('base64'));
const missed = new Request('https://admin.invalid/api/lab/classroom/status', { method: 'POST', body: '{"id":"lab"}' });
const missedResult = await labApi({
  path: '/api/lab/classroom/status', req: missed, admin: 'admin', env: { ORIGIN: 'https://admin.invalid' },
  state: {}, json: (x, status = 200) => Response.json(x, { status }), out: (x) => Response.json(x),
});
assert.equal(missedResult.status, 403);
pass++;

console.log('PASS classroom API origin, cookie and dispatch', pass);
