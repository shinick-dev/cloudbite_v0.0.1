// 인증·금고 POST 라우터 회귀 테스트. 실제 src/index.ts 를 설치된 esbuild 로 번들해 Worker.fetch 를 그대로 돌린다:
//   - cloudflare:workers 는 빈 DurableObject 로 바꾸고, env.STATE 는 호출을 기록하는 가짜 stub
//   - borrow·cli·recv·poll·end·approve·register·vault 경로마다 DO 메서드·인자·응답(상태·보안 헤더)·본문 읽기,
//     그리고 메서드·Origin·호스트·익명 본문 상한 가드가 dispatch 보다 먼저인지
// 네트워크·비밀 값은 쓰지 않는다 (fetch 는 막아 둔다, 값은 전부 더미).  node test/auth-router-parity.mjs

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
const dir = mkdtempSync(join(tmpdir(), 'auth-router-parity-'));
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
async function call(path, { method = 'POST', host = ORIGIN, headers = {}, body, env = ENV, cf } = {}) {
  calls.length = 0;
  const text = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
  const t = text === undefined || method === 'GET' || method === 'HEAD' ? null : tracked([text]);
  const req = new Request(host + path, { method, headers, ...(t ? { body: t.body, duplex: 'half' } : {}) });
  if (cf) Object.defineProperty(req, 'cf', { value: cf });
  // 라우터가 던지면 599 로 센다 (다음 검사도 계속)
  let threw = false;
  const res = await worker.fetch(req, env, ctx).catch((e) => { threw = true; return new Response(`thrown: ${e?.message}`, { status: 599 }); });
  const raw = await res.text();
  let j; try { j = JSON.parse(raw); } catch { j = undefined; }
  return { res, status: res.status, raw, j, threw, rpc: calls.map((c) => [c.ns, c.m, ...c.args]), pulls: t ? t.st.pulls : 0, used: req.bodyUsed };
}
const secure = (res) => res.headers.get('cache-control') === 'no-store' && res.headers.get('x-content-type-options') === 'nosniff'
  && res.headers.get('referrer-policy') === 'no-referrer' && res.headers.get('x-frame-options') === 'DENY'
  && res.headers.get('content-type') === 'application/json';
const b64sha = (s) => createHash('sha256').update(s).digest('base64url');
const srcOf = (ip, key = MASTER) => b64sha(`gw-src-v1|${key}|${ip}`).slice(0, 22);
const SRC_LOOP = srcOf('loopback');
const rpcIs = (r, want) => isDeepStrictEqual(r.rpc, want);
const show = (r) => `${r.status} ${JSON.stringify(r.rpc)} ${r.raw.slice(0, 120)}`;

const ID = 'AAAAAAAAAAAAAAAA', TOK = 'adm_dummy_token', IP = '203.0.113.7';
const AUTH_METHODS = new Set(['createRequest', 'pollRequest', 'endByToken', 'approveOptions', 'deny', 'approve', 'registerOptions', 'registerVerify',
  'vaultStatus', 'vaultOptions', 'vaultOpen', 'vaultInit', 'vaultLink', 'vaultSetRecovery', 'vaultPutItem', 'vaultDeleteItem', 'vaultRecoverInfo',
  'sendDeliver', 'vaultRotateRecoveryCode', 'vaultRecover']);
const noAuthRpc = (r) => !r.rpc.some((c) => AUTH_METHODS.has(c[1]));

console.log('\n# borrow·cli/login·recv: 요청 메타·출처 해시');
{
  replies = { createRequest: { id: ID, code: 'ABC123', secret: 'sec' } };
  const long = 'x'.repeat(400);
  const r = await call('/api/borrow', { headers: { 'cf-connecting-ip': IP + long, 'user-agent': long }, cf: { country: long, city: long }, body: { pub: 'ignored' } });
  check('borrow → createRequest(메타 자름, borrow, pub 없음, 출처 해시)', rpcIs(r, [['main', 'createRequest',
    { ip: (IP + long).slice(0, 64), country: long.slice(0, 8), city: long.slice(0, 80), ua: long.slice(0, 300) }, 'borrow', undefined, srcOf('other')]]), show(r));
  const { qr, ...rest } = r.j ?? {};
  check('borrow 200: 응답 + approveUrl + QR·보안 헤더', r.status === 200 && secure(r.res) && isDeepStrictEqual(rest, { id: ID, code: 'ABC123', secret: 'sec', approveUrl: `${ORIGIN}/a/${ID}` })
    && typeof qr === 'string' && qr.startsWith('<svg'), r.raw.slice(0, 200));
  let x = await call('/api/cli/login', { headers: { 'cf-connecting-ip': IP } });
  check('cli/login → admin, 메타 기본값, cf-connecting-ip 로 출처', rpcIs(x, [['main', 'createRequest', { ip: IP, country: '', city: '', ua: '' }, 'admin', undefined, srcOf(`4:${IP}`)]]), show(x));
  x = await call('/api/recv', { body: { pub: 5 } });
  check('recv → send, pub 문자열로·출처 loopback', rpcIs(x, [['main', 'createRequest', { ip: '', country: '', city: '', ua: '' }, 'send', '5', SRC_LOOP]]), show(x));
  x = await call('/api/recv', { body: 'not json{' });
  check('recv 깨진 JSON → pub ""', rpcIs(x, [['main', 'createRequest', { ip: '', country: '', city: '', ua: '' }, 'send', '', SRC_LOOP]]), show(x));
  x = await call('/api/borrow', { body: 'null' });
  check('borrow 본문 null 은 안 봄 → 그대로 호출', x.status === 200 && x.rpc[0]?.[1] === 'createRequest', show(x));
  x = await call('/api/recv', { body: 'null' });
  check('recv 본문 null → 지금은 던짐(599), DO 안 부름 [현행 유지]', x.threw && x.rpc.length === 0, show(x));
  replies = { createRequest: { error: 'slow down', status: 429 } };
  x = await call('/api/borrow', {});
  check('createRequest 실패 → 429 {error} 그대로', x.status === 429 && secure(x.res) && isDeepStrictEqual(x.j, { error: 'slow down' }), show(x));
  replies = {};
}

console.log('\n# borrow/<id>/poll');
{
  const defs = [{ id: 'oa', envKey: 'OPENAI_API_KEY', envBase: 'OPENAI_BASE_URL', basePath: '/v1' }, { id: 'or', envKey: 'OR_KEY', claude: true }];
  replies = { pollRequest: { status: 'approved', token: 'kvt_t', defs } };
  let r = await call(`/api/borrow/${ID}/poll`, { body: { secret: 42 } });
  check('poll → pollRequest(id, secret 문자열)', rpcIs(r, [['main', 'pollRequest', ID, '42']]), show(r));
  const P = `${ORIGIN}/p`;
  check('poll defs → defs 빼고 env 줄', r.status === 200 && secure(r.res) && isDeepStrictEqual(r.j, { status: 'approved', token: 'kvt_t', env: {
    powershell: `$env:OPENAI_API_KEY='kvt_t'; $env:OPENAI_BASE_URL='${P}/oa/v1'; $env:OR_KEY='kvt_t'`,
    bash: `export OPENAI_API_KEY='kvt_t'\nexport OPENAI_BASE_URL='${P}/oa/v1'\nexport OR_KEY='kvt_t'`,
    claudePowershell: `$env:ANTHROPIC_BASE_URL='${P}/or/api'; $env:ANTHROPIC_AUTH_TOKEN='kvt_t'; $env:ANTHROPIC_API_KEY=''`,
    claudeBash: `export ANTHROPIC_BASE_URL='${P}/or/api'\nexport ANTHROPIC_AUTH_TOKEN='kvt_t'\nexport ANTHROPIC_API_KEY=''` } }), r.raw);
  replies = { pollRequest: { status: 'pending' } };
  r = await call(`/api/borrow/${ID}/poll`, {});
  check('poll defs 없음 → 그대로, secret ""', rpcIs(r, [['main', 'pollRequest', ID, '']]) && r.status === 200 && isDeepStrictEqual(r.j, { status: 'pending' }), show(r));
  replies = { pollRequest: { error: 'expired', status: 410 } };
  r = await call(`/api/borrow/${ID}/poll`, { body: { secret: 's' } });
  check('poll 실패 → 410 {error}', r.status === 410 && secure(r.res) && isDeepStrictEqual(r.j, { error: 'expired' }), show(r));
  replies = {};
}

console.log('\n# /api/end: Bearer·키 헤더, Origin 예외');
{
  const cases = [
    [{ authorization: 'Bearer  kvt_a ' }, 'kvt_a'],
    [{ authorization: 'bEaReR kvt_b' }, 'kvt_b'],
    [{ 'x-api-key': ' kvt_c ' }, 'kvt_c'],
    [{ 'xi-api-key': 'kvt_d' }, 'kvt_d'],
    [{ authorization: 'Basic zzz', 'x-api-key': 'kvt_e' }, 'kvt_e'],
    [{ 'x-api-key': 'kvt_f', 'xi-api-key': 'kvt_g' }, 'kvt_f'],
  ];
  let ok = true, bad = '';
  for (const [h, tok] of cases) {
    const r = await call('/api/end', { headers: h, body: 'x'.repeat(40000) });
    if (!(rpcIs(r, [['main', 'endByToken', tok]]) && r.status === 200 && r.pulls === 0)) { ok = false; bad += ` ${JSON.stringify(h)}:${show(r)}`; }
  }
  check('end → endByToken(토큰), 본문 안 읽음·상한 없음', ok, bad);
  ok = true; bad = '';
  for (const h of [{}, { authorization: 'Bearer ' }, { authorization: 'Bearer adm_x' }, { 'x-api-key': '' }, { authorization: 'kvt_raw' }]) {
    const r = await call('/api/end', { headers: h });
    if (!(r.status === 401 && secure(r.res) && isDeepStrictEqual(r.j, { error: 'missing gateway token' }) && r.rpc.length === 0)) { ok = false; bad += ` ${JSON.stringify(h)}:${show(r)}`; }
  }
  check('end 토큰 없음·빈·kvt_ 아님 → 401, DO 안 부름', ok, bad);
  const r = await call('/api/end', { headers: { authorization: 'Bearer kvt_o', origin: 'https://evil.example.test' } });
  check('end 는 다른 Origin 도 통과', rpcIs(r, [['main', 'endByToken', 'kvt_o']]) && r.status === 200, show(r));
  replies = { endByToken: { error: 'unknown', status: 404 } };
  const f = await call('/api/end', { headers: { authorization: 'Bearer kvt_o' } });
  check('endByToken 실패 → 404 {error}', f.status === 404 && secure(f.res) && isDeepStrictEqual(f.j, { error: 'unknown' }), show(f));
  replies = {};
}

console.log('\n# approve: options·deny·assertion·choice');
{
  let r = await call(`/api/approve/${ID}/options`, { headers: { 'cf-connecting-ip': IP } });
  check('approve/options → approveOptions(id, 출처)', rpcIs(r, [['main', 'approveOptions', ID, srcOf(`4:${IP}`)]]), show(r));
  r = await call(`/api/approve/${ID}/deny`, { body: { reason: 'x' } });
  check('approve/deny → deny(id) 만', rpcIs(r, [['main', 'deny', ID]]), show(r));
  r = await call(`/api/approve/${ID}`, { body: { assertion: { id: 'a' }, choice: { providers: ['p1', 2], ttlHours: '4', budget: '1.5', manage: true, limits: { rpm: 3 } } } });
  check('approve → approve(id, assertion, choice 정리)', rpcIs(r, [['main', 'approve', ID, { id: 'a' },
    { providers: ['p1', '2'], ttlHours: 4, budget: 1.5, manage: true, limits: { rpm: 3 } }]]), show(r));
  r = await call(`/api/approve/${ID}`, { body: { choice: { providers: 'p1' } } });
  check('approve choice 기본값 (providers 배열 아님 → [], 숫자 NaN)', rpcIs(r, [['main', 'approve', ID, undefined,
    { providers: [], ttlHours: NaN, budget: NaN, manage: undefined, limits: undefined }]]), show(r));
  r = await call(`/api/approve/${ID}`, { body: 'null' });
  check('approve 본문 null → 지금은 던짐, DO 안 부름 [현행 유지]', r.threw && r.rpc.length === 0, show(r));
  replies = { approve: { error: 'bad tap', status: 401 } };
  r = await call(`/api/approve/${ID}`, { body: {} });
  check('approve 실패 → 401 {error}', r.status === 401 && secure(r.res) && isDeepStrictEqual(r.j, { error: 'bad tap' }), show(r));
  replies = {};
}

console.log('\n# register: 열림·관리 토큰·설치 토큰 해시');
{
  const SETUP = 'dummy-setup-token';
  const HASH = b64sha(`gw-setup-v1|${SETUP}`);
  const ENVS = { ...ENV, SETUP_TOKEN: SETUP };
  let r = await call('/api/register/options', { body: { setup: SETUP } });
  check('SETUP_TOKEN·관리 토큰 둘 다 없음 → 403, DO 안 부름', r.status === 403 && secure(r.res) && r.rpc.length === 0, show(r));
  r = await call('/api/register/options', { headers: { 'x-admin-token': TOK } });
  check('SETUP_TOKEN 없음 + 관리 토큰 → registerOptions("", adm, 출처)', rpcIs(r, [['main', 'registerOptions', '', TOK, SRC_LOOP]]), show(r));
  r = await call('/api/register/verify', { headers: { 'x-admin-token': TOK }, body: { response: { r: 1 }, label: 7 } });
  check('verify → registerVerify("", response, label 문자열, adm)', rpcIs(r, [['main', 'registerVerify', '', { r: 1 }, '7', TOK]]), show(r));
  const setups = [
    ['맞음', SETUP, HASH],
    ['앞뒤 공백은 trim', `  ${SETUP}\n`, HASH],
    ['틀림', 'wrong', ''],
    ['문자열 아님', 123, ''],
    ['256자 넘으면(공백이라도) 거절', SETUP + ' '.repeat(257 - SETUP.length), ''],
    ['정확히 256자(공백) 는 trim 후 맞음', SETUP + ' '.repeat(256 - SETUP.length), HASH],
  ];
  let ok = true, bad = '';
  for (const [name, setup, want] of setups) {
    const o = await call('/api/register/options', { env: ENVS, body: { setup } });
    const v = await call('/api/register/verify', { env: ENVS, body: { setup, response: 'R' } });
    if (!(rpcIs(o, [['main', 'registerOptions', want, '', SRC_LOOP]]) && rpcIs(v, [['main', 'registerVerify', want, 'R', '', '']]))) { ok = false; bad += ` ${name}:${show(o)}|${show(v)}`; }
  }
  check('setup → 해시는 gw-setup-v1|원문 (맞을 때만), 아니면 ""', ok, bad);
  check('(setupHash 에 원문 없음)', !HASH.includes(SETUP));
  r = await call('/api/register/options', { env: { ...ENV, SETUP_TOKEN: ` ${SETUP}` }, body: { setup: ` ${SETUP}` } });
  check('SETUP_TOKEN 자체는 trim 안 함 → 공백 붙은 토큰은 안 맞음', rpcIs(r, [['main', 'registerOptions', '', '', SRC_LOOP]]), show(r));
  // 본문 JSON null: setup 은 SETUP_TOKEN 이 있을 때만 본다 (없으면 b.setup 을 건드리지 않고 통과)
  r = await call('/api/register/options', { headers: { 'x-admin-token': TOK }, body: 'null' });
  check('null 본문 + SETUP_TOKEN 없음 + 관리 토큰 → registerOptions("", adm, 출처)', rpcIs(r, [['main', 'registerOptions', '', TOK, SRC_LOOP]]), show(r));
  r = await call('/api/register/options', { body: 'null' });
  check('null 본문 + 닫힘 → 403, DO 안 부름', r.status === 403 && secure(r.res) && r.rpc.length === 0, show(r));
  r = await call('/api/register/options', { env: ENVS, headers: { 'x-admin-token': TOK }, body: 'null' });
  check('null 본문 + SETUP_TOKEN → 지금은 던짐(599), DO 안 부름 [현행 유지]', r.threw && r.rpc.length === 0, show(r));
  r = await call('/api/register/verify', { headers: { 'x-admin-token': TOK }, body: 'null' });
  check('verify null 본문 → 지금은 던짐(599), DO 안 부름 [현행 유지]', r.threw && r.rpc.length === 0, show(r));
  replies = { registerVerify: { error: 'closed', status: 403 } };
  r = await call('/api/register/verify', { env: ENVS, body: { setup: SETUP } });
  check('registerVerify 실패 → 403 {error}', r.status === 403 && secure(r.res) && isDeepStrictEqual(r.j, { error: 'closed' }), show(r));
  replies = {};
}

console.log('\n# 금고 12 경로');
{
  const A = { 'x-admin-token': TOK, 'cf-connecting-ip': IP };
  const S = srcOf(`4:${IP}`);
  const VAULT = [
    ['status', { x: 1 }, ['vaultStatus']],
    ['options', { credId: 'c1' }, ['vaultOptions', 'c1', S]],
    ['open', { assertion: { id: 'a' } }, ['vaultOpen', { id: 'a' }]],
    ['init', { credId: 9, wrap: { w: 1 }, rec: { q: 1 } }, ['vaultInit', TOK, '9', { w: 1 }, { q: 1 }]],
    ['link', { credId: 'c2', wrap: { w: 2 } }, ['vaultLink', TOK, 'c2', { w: 2 }]],
    ['recovery', { rec: { q: 2 } }, ['vaultSetRecovery', TOK, { q: 2 }]],
    ['item', { item: { id: 'i' } }, ['vaultPutItem', TOK, { id: 'i' }]],
    ['item-delete', { id: 3 }, ['vaultDeleteItem', TOK, '3']],
    ['recover-info', {}, ['vaultRecoverInfo']],
    ['send', { id: 'r1', itemId: 4, box: { b: 1 } }, ['sendDeliver', TOK, 'r1', '4', { b: 1 }]],
    ['recovery-code', {}, ['vaultRotateRecoveryCode', TOK]],
    ['recover', { code: 'C', verifier: 'V' }, ['vaultRecover', 'C', 'V', IP]],
  ];
  let ok = true, bad = '';
  for (const [p, b, want] of VAULT) {
    replies = { [want[0]]: { ok: true, p } };
    const r = await call(`/api/vault/${p}`, { headers: A, body: b });
    if (!(rpcIs(r, [['main', ...want]]) && r.status === 200 && secure(r.res) && isDeepStrictEqual(r.j, { ok: true, p }))) { ok = false; bad += ` ${p}:${show(r)}`; }
    replies = { [want[0]]: { error: 'nope', status: 409 } };
    const f = await call(`/api/vault/${p}`, { headers: A, body: b });
    if (!(f.status === 409 && secure(f.res) && isDeepStrictEqual(f.j, { error: 'nope' }))) { ok = false; bad += ` ${p}-fail:${show(f)}`; }
  }
  check('12 경로 → DO 메서드·인자·200 json / 실패 409 {error}', ok, bad);
  replies = {};
  const EMPTY = [
    ['options', ['vaultOptions', undefined, SRC_LOOP]],
    ['init', ['vaultInit', '', '', undefined, undefined]],
    ['link', ['vaultLink', '', '', undefined]],
    ['item', ['vaultPutItem', '', {}]],
    ['item-delete', ['vaultDeleteItem', '', '']],
    ['send', ['sendDeliver', '', '', '', {}]],
    ['recover', ['vaultRecover', undefined, undefined, '']],
  ];
  ok = true; bad = '';
  for (const [p, want] of EMPTY) for (const body of [undefined, 'not json{']) {
    const r = await call(`/api/vault/${p}`, { body });
    if (!rpcIs(r, [['main', ...want]])) { ok = false; bad += ` ${p}/${body}:${show(r)}`; }
  }
  check('본문 없음·깨진 JSON → 기본값 (토큰 "", credId "", item·box {})', ok, bad);
  let r = await call('/api/vault/options', { body: { credId: 5 } });
  check('options credId 문자열 아니면 undefined', rpcIs(r, [['main', 'vaultOptions', undefined, SRC_LOOP]]), show(r));
  r = await call('/api/vault/recover', { headers: { 'cf-connecting-ip': '2001:db8::1' }, body: { code: 'C' } });
  check('recover: cf-connecting-ip 원문(해시·/64 아님)', rpcIs(r, [['main', 'vaultRecover', 'C', undefined, '2001:db8::1']]), show(r));
  r = await call('/api/vault/status', { body: 'null' });
  check('status 본문 null → 그대로 호출 [현행 유지]', rpcIs(r, [['main', 'vaultStatus']]) && r.status === 200, show(r));
  r = await call('/api/vault/options', { body: 'null' });
  check('options 본문 null → 지금은 던짐, DO 안 부름 [현행 유지]', r.threw && r.rpc.length === 0, show(r));
  r = await call('/api/vault/item', { headers: A, body: JSON.stringify({ item: { pad: 'x'.repeat(40000) } }) });
  check('item(관리 토큰 경로)은 익명 상한 없음 → 40KB 통과', r.status === 200 && r.rpc[0]?.[1] === 'vaultPutItem', show(r));
  for (const p of ['/api/vault/nope', '/api/vault/', '/api/vault/STATUS']) {
    r = await call(p, { headers: A, body: { x: 1 } });
    check(`${p} → 404, DO 안 부름, 본문은 읽음 [현행 유지]`, r.status === 404 && secure(r.res) && isDeepStrictEqual(r.j, { error: 'not found' }) && r.rpc.length === 0 && r.used, `${show(r)} used ${r.used}`);
  }
}

console.log('\n# 익명 본문 상한 32KiB (DO 보다 먼저)');
{
  const ANON = ['/api/borrow', '/api/cli/login', '/api/recv', `/api/borrow/${ID}/poll`, `/api/approve/${ID}`, `/api/approve/${ID}/options`, `/api/approve/${ID}/deny`,
    '/api/register/options', '/api/register/verify', '/api/vault/status', '/api/vault/options', '/api/vault/open', '/api/vault/recover-info', '/api/vault/recover'];
  const pad = (n) => JSON.stringify({ pad: 'x'.repeat(n - 10) });
  check('(pad 길이 확인)', pad(32 * 1024).length === 32 * 1024);
  const env = { ...ENV, SETUP_TOKEN: 'dummy-setup-token' };
  let ok = true, bad = '';
  for (const p of ANON) {
    const a = await call(p, { env, body: pad(32 * 1024) });
    const o = await call(p, { env, body: pad(32 * 1024 + 1) });
    if (!(a.status !== 413 && !noAuthRpc(a) && o.status === 413 && secure(o.res) && isDeepStrictEqual(o.j, { error: '요청 본문이 너무 큽니다.' }) && o.rpc.length === 0)) { ok = false; bad += ` ${p}:${a.status}/${o.status}/${o.rpc.length}`; }
  }
  check('익명 14 경로: 정확히 32KiB 통과 · +1 → 413, DO 안 부름', ok, bad);
  calls.length = 0;
  const t = tracked(Array.from({ length: 8 }, () => new Uint8Array(16 * 1024)));
  const res = await worker.fetch(new Request(ORIGIN + '/api/vault/open', { method: 'POST', body: t.body, duplex: 'half' }), ENV, ctx);
  check('chunked 초과 → 413, 나머지 안 읽음', res.status === 413 && calls.length === 0 && t.st.pulls <= 4, `${res.status} pulls ${t.st.pulls}`);
  const r = await call('/api/borrow', { headers: { 'content-length': '40000' }, body: '{}' });
  check('content-length 가 상한 넘으면 본문 안 읽고 413', r.status === 413 && r.rpc.length === 0 && r.pulls === 0, `${show(r)} pulls ${r.pulls}`);
}

console.log('\n# 메서드·Origin·호스트 가드');
{
  const ALL = ['/api/borrow', '/api/cli/login', '/api/recv', `/api/borrow/${ID}/poll`, '/api/end', `/api/approve/${ID}`, `/api/approve/${ID}/options`, `/api/approve/${ID}/deny`,
    '/api/register/options', '/api/register/verify', '/api/vault/status', '/api/vault/init', '/api/vault/item', '/api/vault/recover'];
  const H = { 'x-admin-token': TOK, authorization: 'Bearer kvt_z' };
  let ok = true, bad = '';
  for (const p of ALL) for (const method of ['PUT', 'DELETE', 'PATCH', 'HEAD']) {
    const r = await call(p, { method, headers: H, body: { x: 1 } });
    if (!(r.status === 405 && secure(r.res) && r.rpc.length === 0 && r.pulls === 0)) { ok = false; bad += ` ${method} ${p}:${r.status}`; }
  }
  check('POST 아닌 메서드 → 405, DO·본문 안 건드림', ok, bad);
  ok = true; bad = '';
  for (const p of ALL.filter((x) => x !== '/api/end')) for (const o of ['https://evil.example.test', LAB_ORIGIN, 'null', `${ORIGIN}.evil.test`]) {
    const r = await call(p, { headers: { ...H, origin: o }, body: 'x'.repeat(40000) });
    if (!(r.status === 403 && isDeepStrictEqual(r.j, { error: 'bad origin' }) && secure(r.res) && r.rpc.length === 0 && r.pulls === 0 && !r.used)) { ok = false; bad += ` ${p}@${o}:${r.status}`; }
  }
  check('다른 Origin → 403 (413 보다 먼저), DO·본문 안 건드림', ok, bad);
  ok = true; bad = '';
  for (const p of ALL) {
    const r = await call(p, { headers: { ...H, origin: ORIGIN }, env: { ...ENV, SETUP_TOKEN: 's' }, body: {} });
    if (!(r.status === 200 && !noAuthRpc(r))) { ok = false; bad += ` ${p}:${show(r)}`; }
  }
  check('같은 Origin 은 통과', ok, bad);
  ok = true; bad = '';
  for (const host of ['https://gw.workers.example', `https://s-bad.${SEAT_DOMAIN}`]) for (const p of ALL) {
    const r = await call(p, { host, headers: { ...H, origin: host }, body: { x: 1 } });
    if (!(r.status === 404 && noAuthRpc(r) && r.pulls === 0)) { ok = false; bad += ` ${host}${p}:${show(r)}`; }
  }
  check('다른 호스트·틀린 자리 호스트 → 404, 인증 DO·본문 안 건드림', ok, bad);
  ok = true; bad = '';
  for (const p of ALL) {
    const r = await call(p, { host: LAB_ORIGIN, headers: { ...H, origin: LAB_ORIGIN }, body: { x: 1 } });
    if (!(r.status >= 400 && noAuthRpc(r))) { ok = false; bad += ` ${p}:${show(r)}`; }
  }
  check('공부방 호스트 → 인증 DO 안 부름', ok, bad);
}

console.log('\n# 맞지 않는 경로: 본문 안 읽고 404');
{
  for (const p of ['/api/borrow/', '/api/borrowx', `/api/borrow/${ID}`, `/api/borrow/${ID}/poll/`, '/api/approve/short', `/api/approve/${ID}/nope`, '/api/register', '/api/register/x', '/api/vault', '/api/vaultx', '/api/end/', '/api/nope']) {
    const r = await call(p, { headers: { 'x-admin-token': TOK, authorization: 'Bearer kvt_z' }, body: { x: 1 } });
    check(`${p} → 404, 본문 안 읽음`, r.status === 404 && isDeepStrictEqual(r.j, { error: 'not found' }) && secure(r.res) && r.rpc.length === 0 && r.pulls === 0 && !r.used, `${show(r)} pulls ${r.pulls}`);
  }
}

console.log(`\n${pass} ok, ${failN} fail`);
process.exit(failN ? 1 : 0);
