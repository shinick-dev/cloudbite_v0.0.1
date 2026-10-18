// 관리·공부방 POST 라우터 회귀 테스트. 실제 src/index.ts 를 설치된 esbuild 로 번들해 Worker.fetch 를 그대로 돌린다:
//   - cloudflare:workers 는 빈 DurableObject 로 바꾸고, env.STATE 는 호출을 기록하는 가짜 stub
//   - 경로마다 DO 메서드·인자·응답(상태·보안 헤더), 그리고 출처·호스트·메서드·본문 상한 같은 가드가 dispatch 보다 먼저인지
// 네트워크·비밀 값은 쓰지 않는다 (fetch 는 막아 둔다, 값은 전부 더미).  node test/router-parity.mjs

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { build } from 'esbuild';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const cfStub = { name: 'cf-stub', setup(b) {
  b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'cf', namespace: 'cf-stub' }));
  b.onLoad({ filter: /.*/, namespace: 'cf-stub' }, () => ({ contents: 'export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }', loader: 'js' }));
} };
const bundled = await build({
  entryPoints: [join(ROOT, 'src/index.ts')], bundle: true, write: false, format: 'esm', platform: 'node',
  loader: { '.ps1': 'text' }, plugins: [cfStub], logLevel: 'silent',
});
const dir = mkdtempSync(join(tmpdir(), 'router-parity-'));
writeFileSync(join(dir, 'worker.mjs'), bundled.outputFiles[0].text);
let worker;
try { worker = (await import(pathToFileURL(join(dir, 'worker.mjs')).href)).default; } finally { rmSync(dir, { recursive: true, force: true }); }

globalThis.fetch = async (u) => { throw new Error(`network blocked in test: ${u}`); };

let pass = 0, failN = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { failN++; console.log(`  FAIL ${name} ${String(extra).slice(0, 300)}`); }
};

const ORIGIN = 'https://k.example.test', LAB_ORIGIN = 'https://lab.example.test', SEAT_DOMAIN = 'example.test';
const MASTER = 'dummy-master-key';
const calls = [];
let replies = {};
const stub = (ns) => new Proxy({}, { get: (_, k) => (typeof k !== 'string' || k === 'then') ? undefined : async (...args) => {
  calls.push({ ns, m: k, args });
  const r = replies[k];
  return typeof r === 'function' ? r(...args) : (r ?? { ok: true, m: k });
} });
const ENV = {
  ORIGIN, LAB_ORIGIN, LAB_SEAT_DOMAIN: SEAT_DOMAIN, RP_ID: 'example.test', MASTER_KEY: MASTER,
  STATE: { idFromName: (n) => ({ name: n }), get: (id) => stub(id.name) },
};
const ctx = { waitUntil() {}, passThroughOnException() {} };

/** 읽힌 만큼 세는 본문 (highWaterMark 0: 누가 읽기 전에는 당기지 않는다) */
function tracked(chunks) {
  const st = { pulls: 0 };
  const q = chunks.map((c) => (typeof c === 'string' ? new TextEncoder().encode(c) : c));
  const body = new ReadableStream({ pull(c) { st.pulls++; if (q.length) c.enqueue(q.shift()); else c.close(); } }, { highWaterMark: 0 });
  return { body, st };
}
async function call(path, { method = 'POST', host = ORIGIN, headers = {}, body, env = ENV } = {}) {
  calls.length = 0;
  const text = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
  const t = text === undefined || method === 'GET' || method === 'HEAD' ? null : tracked([text]);
  const req = new Request(host + path, { method, headers, ...(t ? { body: t.body, duplex: 'half' } : {}) });
  // 라우터가 던지면 실패로 센다 (다음 검사도 계속)
  const res = await worker.fetch(req, env, ctx).catch((e) => new Response(`thrown: ${e?.message}`, { status: 599 }));
  const raw = await res.text();
  let j; try { j = JSON.parse(raw); } catch { j = undefined; }
  return { res, status: res.status, raw, j, rpc: calls.map((c) => [c.ns, c.m, ...c.args]), pulls: t ? t.st.pulls : 0, used: req.bodyUsed };
}
const secure = (res) => res.headers.get('cache-control') === 'no-store' && res.headers.get('x-content-type-options') === 'nosniff'
  && res.headers.get('referrer-policy') === 'no-referrer' && res.headers.get('x-frame-options') === 'DENY'
  && res.headers.get('content-type') === 'application/json';
const srcOf = (ip, key = MASTER) => createHash('sha256').update(`gw-src-v1|${key}|${ip}`).digest('base64url').slice(0, 22);

const TOK = 'adm_dummy_token';
const H = { 'x-admin-token': TOK, 'content-type': 'application/json' };
// [경로, 본문, 기대 DO 호출(메서드, ...인자)]
const ROUTES = [
  ['/api/admin/list', {}, ['adminList', TOK]],
  ['/api/admin/revoke', { target: 'sess1' }, ['adminRevoke', TOK, 'sess1']],
  ['/api/admin/provider', { id: 'p1', upstream: 'https://up.example.test' }, ['adminUpsertProvider', TOK, { id: 'p1', upstream: 'https://up.example.test' }]],
  ['/api/admin/provider-delete', { id: 'p1' }, ['adminDeleteProvider', TOK, 'p1']],
  ['/api/admin/cred-delete', { id: 'c1' }, ['adminDeleteCred', TOK, 'c1']],
  ['/api/lab/config', {}, ['labConfig', TOK]],
  ['/api/lab/create', { name: 'L', seats: 2 }, ['labCreate', TOK, { name: 'L', seats: 2 }]],
  ['/api/lab/list', {}, ['labList', TOK]],
  ['/api/lab/clip', { id: 'L1', in: false }, ['labSetClip', TOK, 'L1', { in: false, out: true }]],
  ['/api/lab/share', { id: 'L1', provider: 'p1', on: true, cap: 5 }, ['labSetShare', TOK, 'L1', 'p1', true, 5]],
  ['/api/lab/hand', { id: 'L1', n: 3 }, ['labHandClear', TOK, 'L1', 3]],
  ['/api/lab/snips', { id: 'L1' }, ['labSnips', TOK, 'L1']],
  ['/api/lab/snip', { id: 'L1', text: 'print(1)', title: 't' }, ['labSnipAdd', TOK, 'L1', 'print(1)', 't']],
  ['/api/lab/snip-delete', { id: 'L1', snip: 's1' }, ['labSnipDelete', TOK, 'L1', 's1']],
  ['/api/lab/screen/start', { id: 'L1', sdp: 'v=0', tracks: [{ mid: '0' }] }, ['labScreenStart', TOK, 'L1', 'v=0', [{ mid: '0' }]]],
  ['/api/lab/screen/stop', { id: 'L1' }, ['labScreenStop', TOK, 'L1']],
  ['/api/lab/screen/status', {}, ['labScreenList', TOK]],
  ['/api/lab/end', { id: 'L1' }, ['labEnd', TOK, 'L1']],
];
const ROUTER_METHODS = new Set([...ROUTES.map((r) => r[2][0]), 'labInvite', 'adminOptions', 'adminLogin']);
const noRouterRpc = (r) => !r.rpc.some((c) => ROUTER_METHODS.has(c[1]));

console.log('\n# 경로별 DO 호출·응답');
for (const [path, b, want] of ROUTES) {
  replies = { [want[0]]: { ok: true, path } };
  const r = await call(path, { headers: H, body: b });
  check(`${path} → ${want[0]}`, isDeepStrictEqual(r.rpc, [['main', ...want]]), JSON.stringify(r.rpc));
  check(`${path} 200 json·보안 헤더`, r.status === 200 && secure(r.res) && isDeepStrictEqual(r.j, { ok: true, path }), `${r.status} ${r.raw}`);
  replies = { [want[0]]: { error: 'nope', status: 409 } };
  const f = await call(path, { headers: H, body: b });
  check(`${path} 실패 → 409 {error} (status 안 샘)`, f.status === 409 && secure(f.res) && isDeepStrictEqual(f.j, { error: 'nope' }), `${f.status} ${f.raw}`);
}
replies = {};

console.log('\n# 토큰·형식이 틀린 본문');
{
  let r = await call('/api/admin/list', { headers: { authorization: 'Bearer kvt_dummy' } });
  check('x-admin-token 없으면 빈 토큰 (Bearer 는 관리 토큰 아님)', isDeepStrictEqual(r.rpc, [['main', 'adminList', '']]), JSON.stringify(r.rpc));
  r = await call('/api/admin/revoke', { headers: H, body: 'not json{' });
  check('깨진 JSON → revoke target ""', isDeepStrictEqual(r.rpc, [['main', 'adminRevoke', TOK, '']]), JSON.stringify(r.rpc));
  r = await call('/api/lab/create', { headers: H, body: 'not json{' });
  check('깨진 JSON → labCreate {}', isDeepStrictEqual(r.rpc, [['main', 'labCreate', TOK, {}]]), JSON.stringify(r.rpc));
  r = await call('/api/lab/hand', { headers: H });
  check('본문 없음 → labHandClear id "" n NaN', isDeepStrictEqual(r.rpc, [['main', 'labHandClear', TOK, '', NaN]]), JSON.stringify(r.rpc));
  r = await call('/api/lab/clip', { headers: H, body: { id: 7, in: 0, out: false } });
  check('clip: false 만 끔·id 문자열', isDeepStrictEqual(r.rpc, [['main', 'labSetClip', TOK, '7', { in: true, out: false }]]), JSON.stringify(r.rpc));
  replies = { labInvite: { name: 'Lab', seats: [] } };
  r = await call('/api/lab/invite?x=1', { headers: H, body: { id: 'L1' } });
  check('쿼리는 경로에 안 섞임', r.status === 200 && isDeepStrictEqual(r.rpc, [['main', 'labInvite', TOK, 'L1', undefined]]), JSON.stringify(r.rpc));
  replies = {};
}

console.log('\n# /api/lab/invite');
{
  const SEATS = { name: 'Lab', seats: [{ n: 1, who: 'a', code: 'AAAAAAAAAAAAAAAA' }, { n: 2, who: '', code: 'BBBBBBBBBBBBBBBB' }] };
  replies = { labInvite: SEATS };
  let r = await call('/api/lab/invite', { headers: H, body: { id: 'L1' } });
  check('n 없음 → labInvite(id, undefined)', isDeepStrictEqual(r.rpc, [['main', 'labInvite', TOK, 'L1', undefined]]), JSON.stringify(r.rpc));
  check('전부: 링크만·code 필드·QR 없음', r.status === 200 && secure(r.res) && isDeepStrictEqual(r.j, { name: 'Lab', seats: [
    { n: 1, who: 'a', link: `${LAB_ORIGIN}/j/AAAAAAAAAAAAAAAA` }, { n: 2, who: '', link: `${LAB_ORIGIN}/j/BBBBBBBBBBBBBBBB` }] }), r.raw);
  r = await call('/api/lab/invite', { headers: H, body: { id: 'L1', n: null } });
  check('n null → 전부', isDeepStrictEqual(r.rpc, [['main', 'labInvite', TOK, 'L1', undefined]]), JSON.stringify(r.rpc));
  replies = { labInvite: { name: 'Lab', seats: [SEATS.seats[1]] } };
  r = await call('/api/lab/invite', { headers: H, body: { id: 'L1', n: 2 } });
  check('n 2 → labInvite(id, 2)', isDeepStrictEqual(r.rpc, [['main', 'labInvite', TOK, 'L1', 2]]), JSON.stringify(r.rpc));
  const { qr, ...rest } = r.j ?? {};
  check('하나: 링크·이름·QR, code 필드 없음', r.status === 200 && isDeepStrictEqual(rest, { n: 2, who: '', link: `${LAB_ORIGIN}/j/BBBBBBBBBBBBBBBB`, name: 'Lab' })
    && typeof qr === 'string' && qr.startsWith('<svg'), r.raw.slice(0, 200));
  for (const n of ['2', 1.5, true, {}]) {
    r = await call('/api/lab/invite', { headers: H, body: { id: 'L1', n } });
    check(`n ${JSON.stringify(n)} → 400, DO 안 부름`, r.status === 400 && secure(r.res) && r.rpc.length === 0, `${r.status} ${JSON.stringify(r.rpc)}`);
  }
  replies = { labInvite: { error: 'gone', status: 410 } };
  r = await call('/api/lab/invite', { headers: H, body: { id: 'L1', n: 1 } });
  check('labInvite 실패 그대로', r.status === 410 && isDeepStrictEqual(r.j, { error: 'gone' }), r.raw);
  replies = {};
}

console.log('\n# 익명 관리 로그인: 본문 상한·출처 해시·캐시된 본문');
{
  let r = await call('/api/admin/options', { headers: { 'cf-connecting-ip': '203.0.113.7' } });
  check('options → adminOptions(src)', isDeepStrictEqual(r.rpc, [['main', 'adminOptions', srcOf('4:203.0.113.7')]]), JSON.stringify(r.rpc));
  r = await call('/api/admin/options', {});
  check('cf-connecting-ip 없음 → loopback', isDeepStrictEqual(r.rpc, [['main', 'adminOptions', srcOf('loopback')]]), JSON.stringify(r.rpc));
  r = await call('/api/admin/options', { headers: { 'cf-connecting-ip': '2001:db8:1:2::9' } });
  check('IPv6 → /64', isDeepStrictEqual(r.rpc, [['main', 'adminOptions', srcOf('6:2001:db8:1:2::/64')]]), JSON.stringify(r.rpc));
  r = await call('/api/admin/options', { env: { ...ENV, MASTER_KEY: 'other' } });
  check('MASTER_KEY 를 섞음', isDeepStrictEqual(r.rpc, [['main', 'adminOptions', srcOf('loopback', 'other')]]), JSON.stringify(r.rpc));
  r = await call('/api/admin/login', { body: { assertion: { id: 'x' }, recoveryCode: true } });
  check('login: 상한으로 읽은 본문을 다시 씀', isDeepStrictEqual(r.rpc, [['main', 'adminLogin', { id: 'x' }, true]]) && r.used, JSON.stringify(r.rpc));
  r = await call('/api/admin/login', { body: { assertion: 1, recoveryCode: 'true' } });
  check('recoveryCode 는 true 만', isDeepStrictEqual(r.rpc, [['main', 'adminLogin', 1, false]]), JSON.stringify(r.rpc));
  r = await call('/api/admin/login', { body: 'not json{' });
  check('login 깨진 JSON → (undefined, false)', isDeepStrictEqual(r.rpc, [['main', 'adminLogin', undefined, false]]), JSON.stringify(r.rpc));
  const pad = (n) => JSON.stringify({ assertion: 'x'.repeat(n - 16) });
  check('(pad 길이 확인)', pad(32 * 1024).length === 32 * 1024);
  r = await call('/api/admin/login', { body: pad(32 * 1024) });
  check('정확히 32KiB 는 통과', r.status === 200 && r.rpc[0]?.[1] === 'adminLogin', `${r.status}`);
  for (const p of ['/api/admin/login', '/api/admin/options']) {
    r = await call(p, { body: pad(32 * 1024 + 1) });
    check(`${p} 32KiB+1 → 413, DO 안 부름`, r.status === 413 && secure(r.res) && r.rpc.length === 0, `${r.status} ${JSON.stringify(r.rpc)}`);
  }
  // 덩어리로 오는 큰 본문: 상한을 넘는 순간 끊고 나머지는 안 읽는다
  calls.length = 0;
  const t = tracked(Array.from({ length: 8 }, () => new Uint8Array(16 * 1024)));
  const req = new Request(ORIGIN + '/api/admin/login', { method: 'POST', body: t.body, duplex: 'half' });
  const res = await worker.fetch(req, ENV, ctx);
  check('chunked 초과 → 413, 나머지 안 읽음', res.status === 413 && calls.length === 0 && t.st.pulls <= 4, `${res.status} pulls ${t.st.pulls}`);
}

console.log('\n# 출처 가드 (dispatch·본문 읽기보다 먼저)');
{
  const all = [...ROUTES.map((r) => r[0]), '/api/lab/invite', '/api/admin/options', '/api/admin/login'];
  let ok = true, bad = '';
  for (const p of all) for (const o of ['https://evil.example.test', LAB_ORIGIN, 'null', `${ORIGIN}.evil.test`]) {
    const r = await call(p, { headers: { ...H, origin: o }, body: { id: 'L1', n: 1 } });
    if (!(r.status === 403 && isDeepStrictEqual(r.j, { error: 'bad origin' }) && secure(r.res) && r.rpc.length === 0 && r.pulls === 0 && !r.used)) { ok = false; bad += ` ${p}@${o}:${r.status}/${r.rpc.length}/${r.pulls}`; }
  }
  check('다른 Origin → 403, DO·본문 안 건드림 (모든 경로)', ok, bad);
  let r = await call('/api/admin/list', { headers: { ...H, origin: ORIGIN } });
  check('같은 Origin 통과', r.status === 200 && r.rpc[0]?.[1] === 'adminList');
  r = await call('/api/admin/list', { headers: H });
  check('Origin 없음(CLI) 통과', r.status === 200 && r.rpc[0]?.[1] === 'adminList');
  r = await call('/api/admin/options', { headers: { origin: 'https://evil.example.test' }, body: 'x'.repeat(40000) });
  check('다른 Origin 이 413 보다 먼저', r.status === 403 && r.pulls === 0, `${r.status}`);
}

console.log('\n# 호스트: 관리 권한 없음');
{
  const label = 'a'.repeat(26);
  const hosts = [['다른 호스트', 'https://gw.workers.example'], ['공부방 호스트', LAB_ORIGIN], ['자리 호스트', `https://s-${label}.${SEAT_DOMAIN}`], ['형식 틀린 자리 호스트', `https://s-bad.${SEAT_DOMAIN}`]];
  for (const [name, host] of hosts) for (const p of ['/api/admin/list', '/api/lab/invite', '/api/admin/options']) {
    replies = { adminList: { secret: 1 }, labInvite: { name: 'x', seats: [] }, adminOptions: { secret: 1 } };
    const r = await call(p, { host, headers: { ...H, origin: host }, body: { id: 'L1' } });
    check(`${name} ${p} → 관리 DO 안 부름`, r.status >= 400 && noRouterRpc(r) && !r.raw.includes('secret'), `${r.status} ${JSON.stringify(r.rpc)}`);
  }
  replies = {};
}

console.log('\n# 메서드·없는 경로');
{
  for (const p of [...ROUTES.map((r) => r[0]), '/api/lab/invite', '/api/admin/options', '/api/admin/login']) {
    const g = await call(p, { method: 'GET', headers: H });
    const h = await call(p, { method: 'HEAD', headers: H });
    const u = await call(p, { method: 'PUT', headers: H, body: { id: 'L1' } });
    check(`${p} GET 404·HEAD 405·PUT 405, DO 안 부름`, g.status === 404 && h.status === 405 && u.status === 405 && secure(u.res)
      && noRouterRpc(g) && noRouterRpc(h) && noRouterRpc(u) && u.pulls === 0, `${g.status} ${h.status} ${u.status}`);
  }
  for (const p of ['/api/admin/list/', '/api/lab/screen/start/', '/api/lab', '/api/lab/', '/api/admin', '/api/admin/LIST', '/api/lab/invite/x', '/api/lab/screen', '/api/admin/list%2F', '//api/admin/list', '/api/lab/nope']) {
    const r = await call(p, { headers: H, body: { id: 'L1' } });
    check(`${p} → 404, 본문 안 읽음`, r.status === 404 && isDeepStrictEqual(r.j, { error: 'not found' }) && secure(r.res) && r.rpc.length === 0 && r.pulls === 0 && !r.used, `${r.status} ${JSON.stringify(r.rpc)} pulls ${r.pulls}`);
  }
}

console.log(`\n${pass} ok, ${failN} fail`);
process.exit(failN ? 1 : 0);
