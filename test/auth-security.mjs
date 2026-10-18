// 인증·복구 보안 회귀 테스트 (#1 익명 요청 상한·거절 반복, #5 복구 동시 시도, #8 익명 임시 상태·challenge 출처 상한,
// #10 복구 오답 전역 잠금·금고 키 잇기·항목·보내기, #17 SETUP_TOKEN 소비·만료, #7 잔여: 틀린 프록시 경로(인코딩된 / \ 포함)는 예약 전에 400,
// A: 익명 거절 홍수가 감사 기록을 밀어내지 않음).
//
// 진짜 로컬 workerd(wrangler dev)에 test/fixtures/auth-security/fixture.js 를 main 으로 한 임시 설정을 띄운다.
// 진짜 State(DO)·SQLite 저장소를 쓰고, 설정·비밀은 전부 이번 실행에서 만든 합성 값이다 (User 환경변수·.dev.vars·배포 없음).
// 바깥 호출은 fixture 가 막고 기록한다. upstream 은 이 스크립트의 loopback 가짜 서버뿐.
// 출처는 fixture 가 x-fx-src → cf-connecting-ip 로 바꿔 흉내 낸다 (없으면 헤더 없는 loopback). 시계는 fxClock 으로 민다.
//
//   node test/auth-security.mjs                         이 저장소 src 로
//   node test/auth-security.mjs --src=<dir> --baseline  다른 src(예: 고치기 전)로 — 실패한 항목 = 재현된 취약점, 종료 코드 0
//   --only=17,1,8,10,5,7,A   일부만 (17 은 다른 절이 쓰는 키를 등록하므로 항상 돈다)
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=');
const SRC = path.resolve(arg('src') ?? path.join(ROOT, 'src'));
const BASELINE = process.argv.includes('--baseline');
const ONLY = new Set((arg('only') ?? '17,1,8,10,5,7,A').split(','));
const fwd = (p) => p.replace(/\\/g, '/');

const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const PORT = await freePort(), INSP = await freePort();
const GW = `http://127.0.0.1:${PORT}`;
process.env.GW = GW;
const { SoftKey, adminLogin, call, check: rawCheck, finish } = await import('./lib.mjs');
let section = '';
const check = (name, cond, extra = '') => rawCheck(`[${section}] ${name}`, cond, extra);

// ── 가짜 upstream (loopback) ──
const hits = [];
const mock = http.createServer((req, res) => {
  hits.push({ path: req.url, auth: req.headers.authorization ?? '' });
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, path: req.url }));
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const MOCK = `http://127.0.0.1:${mock.address().port}`;
const hitsUnder = (p) => hits.filter((h) => h.path.startsWith(p));

// ── 임시 설정 + fixture entry ──
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-auth-sec-'));
const MASTER_KEY = randomBytes(32).toString('base64url');
const SETUP = randomBytes(18).toString('base64url');
const SETUP2 = randomBytes(18).toString('base64url');
fs.writeFileSync(path.join(TMP, 'entry.js'),
  `import worker, { State as Base } from '${fwd(path.join(SRC, 'index.ts'))}';\n` +
  `import { makeFixture } from '${fwd(path.join(ROOT, 'test/fixtures/auth-security/fixture.js'))}';\n` +
  `const f = makeFixture(worker, Base);\nexport const State = f.State;\nexport default f.worker;\n`);
const writeConfig = (setup) => fs.writeFileSync(path.join(TMP, 'wrangler.json'), JSON.stringify({
  name: 'gw-auth-security-fixture', main: 'entry.js', compatibility_date: '2026-09-01', compatibility_flags: ['nodejs_compat'],
  rules: [{ type: 'Text', globs: ['**/*.ps1'], fallthrough: true }],
  vars: {
    RP_ID: '127.0.0.1', ORIGIN: GW, LAB_ORIGIN: `http://localhost:${PORT}`, LAB_GW: '', ALLOW_SHORT_TTL: '1',
    LAB_DAYTONA_API: `${MOCK}/daytona`, REALTIME_API: `${MOCK}/rtc`, MASTER_KEY, SETUP_TOKEN: setup,
  },
  durable_objects: { bindings: [{ name: 'STATE', class_name: 'State' }] },
  migrations: [{ tag: 'v1', new_sqlite_classes: ['State'] }],
}, null, 2));

let child = null;
async function start() {
  child = spawn(process.execPath, [path.join(ROOT, 'node_modules/wrangler/bin/wrangler.js'), 'dev', '--config', path.join(TMP, 'wrangler.json'),
    '--port', String(PORT), '--ip', '127.0.0.1', '--inspector-port', String(INSP), '--persist-to', path.join(TMP, 'state'), '--show-interactive-dev-session=false', '--log-level', 'warn'],
  { cwd: TMP, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => { log += d; if (process.env.AUTH_SEC_LOG) process.stdout.write(`[wrangler] ${d}`); });
  child.stderr.on('data', (d) => { log += d; if (process.env.AUTH_SEC_LOG) process.stdout.write(`[wrangler] ${d}`); });
  const until = Date.now() + 120e3;
  while (Date.now() < until) {
    try { if ((await fetch(`${GW}/borrow`)).status === 200) return; } catch {}
    if (child.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log(log.slice(-4000));
  throw new Error('wrangler dev did not start');
}
const outboundBefore = [];
async function stop() {
  if (!child) return;
  try { outboundBefore.push(...(await fx('fxOutbound'))); } catch {}
  const pid = child.pid;
  try { if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); else child.kill('SIGTERM'); } catch {}
  await new Promise((r) => (child.exitCode !== null ? r() : child.once('exit', r)));
  child = null;
  await new Promise((r) => setTimeout(r, 800));
}
async function restart(setup) { await stop(); writeConfig(setup); await start(); }
async function done() {
  await stop();
  mock.close();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  if (BASELINE) {
    console.log('\n(baseline 모드: FAIL = 고치기 전 코드에서 재현된 취약점. 종료 코드는 0)');
    const exit = process.exit;
    process.exit = () => exit(0);
  }
  finish();
}

// ── 도우미 ──
const fx = async (m, ...args) => (await fetch(`${GW}/__fx/${m}`, { method: 'POST', body: JSON.stringify(args) })).json();
const clock = (ms) => fx('fxClock', ms);
const b64u = (b) => Buffer.from(b).toString('base64url');
const from = (ip, h = {}) => ({ 'x-fx-src': ip, ...h });
const callFrom = (ip, p, body, h = {}) => call(p, body, from(ip, h));
/** origin 헤더 없는 클라이언트 (kv.ps1·go.ps1 같은 CLI) */
async function bare(p, body, headers = {}) {
  const r = await fetch(GW + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body ?? {}) });
  let j = null;
  try { j = await r.json(); } catch {}
  return { status: r.status, j };
}
const statuses = (rs) => rs.map((r) => r.status);
const count = (rs, s) => rs.filter((r) => r.status === s).length;
const listReq = async () => Object.values(await fx('fxList', 'req:'));
const anon = (r) => ['pending', 'approving', 'denied'].includes(r.status);
const listWch = async () => Object.values(await fx('fxList', 'wch:'));
const byKey = (xs, k) => xs.reduce((m, x) => m.set(x[k], (m.get(x[k]) ?? 0) + 1), new Map());
const CODE_RE = /^[A-HJ-NP-Z2-9]{4}(-[A-HJ-NP-Z2-9]{4}){5}$/;
const fakeCode = () => Array.from(randomBytes(24), (b) => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('').match(/.{4}/g).join('-');
const prfCreate = (k, o) => ({ ...k.create(o), clientExtensionResults: { prf: { enabled: true } } });

async function login(key, ip = '192.0.2.200', extra = {}) {
  const o = (await callFrom(ip, '/api/admin/options', {})).j;
  const r = await callFrom(ip, '/api/admin/login', { assertion: key.get(o), ...extra });
  return r;
}

// ═══════════════════════════════════════════════════════════
writeConfig(SETUP);
await start();
console.log(`auth-security: src=${SRC} gw=${GW} mock=${MOCK}${BASELINE ? ' (baseline)' : ''}`);

// ── #17 SETUP_TOKEN ───────────────────────────────────────
section = '#17';
const KS = [new SoftKey(), new SoftKey(), new SoftKey()];
let KEY = null, KEY2 = null; // KEY2: 같은 SETUP 으로 함께 등록된 다른 PRF 키 (KEY 와 서명 카운터가 따로)
{
  check('틀린 setup → 403', (await call('/api/register/options', { setup: 'wrong-wrong-wrong-wrong' })).status === 403);
  const os3 = await Promise.all(KS.map(() => call('/api/register/options', { setup: SETUP })));
  check('처음 맞게 쓴 options 세 개 → 200 (창 열림)', os3.every((r) => r.status === 200), statuses(os3).join(','));
  const recs = await fx('fxList', 'setup:');
  const rec = Object.values(recs)[0];
  check('창 기록 하나, used 0, 토큰 원문 없음', Object.keys(recs).length === 1 && rec?.used === 0 && !JSON.stringify(recs).includes(SETUP), JSON.stringify(recs));
  const g = await call('/api/register/verify', { setup: SETUP, response: { id: 'x', response: { clientDataJSON: 'x', attestationObject: 'y' } }, label: 'junk' });
  check('쓰레기 등록 응답 → 400, 횟수 안 씀', g.status === 400 && Object.values(await fx('fxList', 'setup:'))[0]?.used === 0, `${g.status}`);
  const vs = await Promise.all(KS.map((k, i) => call('/api/register/verify', { setup: SETUP, response: prfCreate(k, os3[i].j), label: `k${i}` })));
  check('동시 등록 세 개 → 성공 정확히 2, 셋째 403', count(vs, 200) === 2 && count(vs, 403) === 1, statuses(vs).join(','));
  KEY = KS[vs.findIndex((r) => r.status === 200)];
  KEY2 = KS.find((k, i) => vs[i].status === 200 && k !== KEY);
  check('저장된 키 2개, used 2', Object.keys(await fx('fxList', 'cred:')).length === 2 && Object.values(await fx('fxList', 'setup:'))[0]?.used === 2);
  check('다 쓴 토큰 → options 403', (await call('/api/register/options', { setup: SETUP })).status === 403);
  const audit = JSON.stringify((await fx('fxGet', ['audit'])).audit ?? []);
  check('감사 기록에 토큰 없음', !audit.includes(SETUP));
  await restart(SETUP);
  check('재시작 뒤에도 다 쓴 토큰은 닫힘', (await call('/api/register/options', { setup: SETUP })).status === 403);

  // 새 토큰: 30분 창 + 재시작
  await restart(SETUP2);
  check('예전 토큰은 새 시크릿과 안 맞음 → 403', (await call('/api/register/options', { setup: SETUP })).status === 403);
  const K4 = new SoftKey(), K5 = new SoftKey();
  const o4 = (await call('/api/register/options', { setup: SETUP2 })).j;
  check('새 토큰 등록 하나 → 200', (await call('/api/register/verify', { setup: SETUP2, response: prfCreate(K4, o4), label: 'k4' })).status === 200);
  await restart(SETUP2);
  await clock(29 * 60e3);
  const o5 = await call('/api/register/options', { setup: SETUP2 });
  check('재시작 + 29분 → 아직 열림', o5.status === 200, JSON.stringify(o5.j));
  await clock(31 * 60e3);
  check('31분 → 미리 받은 options 로도 등록 거부 (403)', (await call('/api/register/verify', { setup: SETUP2, response: prfCreate(K5, o5.j), label: 'k5' })).status === 403);
  check('31분 → options 403', (await call('/api/register/options', { setup: SETUP2 })).status === 403);
  check('만료로 키가 더 생기지 않음 (3개)', Object.keys(await fx('fxList', 'cred:')).length === 3);
  await clock(0);
}
const ADM = { 'x-admin-token': (await login(KEY)).j?.token };
check('관리 로그인', !!ADM['x-admin-token']);

// ── #1 익명 요청 상한 · 거절 반복 ─────────────────────────
if (ONLY.has('1')) {
  section = '#1';
  const A = '198.51.100.1';
  const rs = await Promise.all(Array.from({ length: 20 }, () => callFrom(A, '/api/borrow', {})));
  check('한 출처 동시 20개 → 8개만 (REQ_PER_SOURCE), 나머지 429', count(rs, 200) === 8 && count(rs, 429) === 12, statuses(rs).join(','));
  let reqs = await listReq();
  check('저장된 기록도 8개 (출처당)', Math.max(...byKey(reqs, 'src').values()) === 8 && reqs.length === 8, String(reqs.length));
  check('출처는 해시 — IP 원문이 src 에 없음', reqs.every((r) => r.src && !r.src.includes(A)));

  // IPv6 는 /64 로 묶는다
  const v6 = await Promise.all(Array.from({ length: 8 }, () => callFrom('2001:db8:1:2::1', '/api/cli/login', {})));
  check('IPv6 /64 하나 8개', count(v6, 200) === 8);
  check('같은 /64 다른 주소 → 429', (await callFrom('2001:db8:1:2:ffff::9', '/api/borrow', {})).status === 429);
  check('다른 /64 → 200', (await callFrom('2001:db8:1:3::1', '/api/borrow', {})).status === 200);

  // 만들고 거절하기 반복
  const B = '198.51.100.2';
  let made = 0, denied = 0, blocked = 0, last = null;
  for (let i = 0; i < 30; i++) {
    const r = await callFrom(B, '/api/borrow', {});
    if (r.status === 429) { blocked++; continue; }
    made++; last = r.j;
    if ((await callFrom(B, `/api/approve/${r.j.id}/deny`, {})).j?.ok) denied++;
  }
  check('만들기·거절 30번 → 8번만 만들어짐, 나머지 429', made === 8 && denied === 8 && blocked === 22, `${made} ${denied} ${blocked}`);
  reqs = await listReq();
  const tomb = reqs.filter((r) => r.status === 'denied');
  check('거절 흔적은 작게 (code·ip·ua 없음), 1분 안에 만료', tomb.length === 8 && tomb.every((r) => !r.code && !r.ip && !r.ua && r.expiresAt - Date.now() <= 61e3), JSON.stringify(tomb[0]));
  check('빌린 PC 는 거절됨을 본다', (await callFrom(B, `/api/borrow/${last.id}/poll`, { secret: last.secret })).j?.status === 'denied');
  check('거절한 요청 다시 거절 → 409', (await callFrom(B, `/api/approve/${last.id}/deny`, {})).status === 409);

  // 전체 상한 + origin 없는 CLI
  const cli = await bare('/api/cli/login', {}, from('198.51.100.3'));
  check('origin 없는 CLI 요청 → 200', cli.status === 200 && !!cli.j?.secret, JSON.stringify(cli.j));
  let k = 10, got = 0;
  for (;;) {
    const r = await callFrom(`198.51.100.${k}`, '/api/borrow', {});
    if (r.status !== 200) { check('전체 상한 메시지', r.status === 429, JSON.stringify(r.j)); break; }
    if (++got % 8 === 0) k++;
    if (got > 100) break;
  }
  reqs = await listReq();
  check('익명 기록 전체 32개를 넘지 않음', reqs.filter(anon).length === 32, String(reqs.filter(anon).length));
  check('새 출처도 전체 상한에서 429', (await callFrom('198.51.100.250', '/api/borrow', {})).status === 429);
  check('origin 없는 CLI 도 전체 상한에서 429', (await bare('/api/cli/login', {}, from('198.51.100.251'))).status === 429);

  // 거절 흔적이 만료되면 다시 받는다
  await clock(61e3);
  check('1분 뒤 거절 흔적 만료 → 그 출처 다시 200', (await callFrom(B, '/api/borrow', {})).status === 200);
  await clock(13 * 60e3);
  await fx('fxAlarm');
  check('10분 뒤 알람이 익명 기록을 다 지움', (await listReq()).length === 0, JSON.stringify(await listReq()));
  await clock(0);

  // 거절 뒤 승인 시도
  const r = (await callFrom(B, '/api/borrow', {})).j;
  const o = (await callFrom('192.0.2.200', `/api/approve/${r.id}/options`, {})).j;
  await callFrom(B, `/api/approve/${r.id}/deny`, {});
  check('거절된 요청 승인 → 409', (await call(`/api/approve/${r.id}`, { assertion: KEY.get(o), choice: {} })).status === 409);
  await clock(11 * 60e3); await fx('fxAlarm'); await clock(0);
}

// ── #8 challenge 출처 상한 ───────────────────────────────
if (ONLY.has('8')) {
  section = '#8';
  await clock(40 * 60e3); await fx('fxAlarm'); await clock(0); // #17 이 시계를 민 채 만든 challenge 까지 비운다
  const Y = '192.0.2.100';
  const oy = (await callFrom(Y, '/api/admin/options', {})).j;
  const x1 = await Promise.all(Array.from({ length: 20 }, () => callFrom('192.0.2.1', '/api/admin/options', {})));
  check('한 출처 admin options 20개 → 16개만 (CHAL_PER_SOURCE)', count(x1, 200) === 16 && count(x1, 429) === 4, statuses(x1).join(','));
  for (const ip of ['192.0.2.2', '192.0.2.3', '192.0.2.4']) await Promise.all(Array.from({ length: 16 }, () => callFrom(ip, '/api/admin/options', {})));
  const live = (await listWch()).filter((c) => c.purpose === 'admin');
  check('admin purpose 는 64개에서 멈춤', live.length === 64, String(live.length));
  check('출처마다 16개를 넘지 않음', Math.max(...byKey(live, 'src').values()) <= 16);
  check('다섯째 출처 → 429', (await callFrom('192.0.2.5', '/api/admin/options', {})).status === 429);
  const ly = await callFrom(Y, '/api/admin/login', { assertion: KEY.get(oy) });
  check('압박 전에 연 소유자 의식은 밀려나지 않고 통과', ly.status === 200 && !!ly.j?.token, JSON.stringify(ly.j));
  const vo = await callFrom(Y, '/api/vault/options', {});
  check('다른 purpose(금고) 의식은 따로 열림', vo.status === 200, JSON.stringify(vo.j));
  const req = (await callFrom('198.51.100.77', '/api/borrow', {})).j;
  const ao = await callFrom(Y, `/api/approve/${req.id}/options`, {});
  check('승인 의식도 열림', ao.status === 200);
  const ob = await bare('/api/vault/options', {}, from('192.0.2.101'));
  check('origin 없는 클라이언트 options 도 출처 상한 안에서 동작', ob.status === 200);
  await clock(181e3);
  await fx('fxAlarm');
  check('3분 뒤 알람이 challenge 를 다 지움', (await listWch()).length === 0, JSON.stringify(await listWch()));
  await clock(0);
  const again = await login(KEY, Y);
  check('비운 뒤 정상 로그인', again.status === 200);
  await clock(11 * 60e3); await fx('fxAlarm'); await clock(0);
}

// ── 크기·형식 ────────────────────────────────────────────
if (ONLY.has('8')) {
  section = '#8 input';
  // 큰 본문은 새 연결로 보내고 닫는다 — 서버가 본문을 다 안 읽고 413 을 주면 같은 keep-alive 연결의 다음 요청이 깨질 수 있다 (wrangler dev 프록시)
  const raw = (p, chunks, chunked) => new Promise((res, rej) => {
    const len = chunks.reduce((n, c) => n + c.length, 0);
    const rq = http.request(`${GW}${p}`, { method: 'POST', agent: false, headers: { 'content-type': 'application/json', origin: GW, connection: 'close', ...(chunked ? { 'transfer-encoding': 'chunked' } : { 'content-length': len }) } }, (r) => { r.resume(); r.on('end', () => res(r.statusCode)); });
    rq.on('error', (e) => (e.code === 'ECONNRESET' || e.code === 'EPIPE' ? res(-1) : rej(e)));
    for (const c of chunks) rq.write(c);
    rq.end();
  });
  // wrangler dev 의 ProxyWorker 는 본문을 다 안 읽고 끝난 요청 다음 요청 하나를 'Network connection lost'(500)로 깨기도 한다 (배포 환경과 무관).
  // 그래서 큰 본문 뒤에는 버리는 GET 하나로 내부 연결을 갈아 끼운다
  const settle = async () => { for (let i = 0; i < 3; i++) { try { if ((await fetch(`${GW}/api/presets`)).status === 200) return; } catch {} } };
  const big = JSON.stringify({ assertion: { id: 'x', pad: 'a'.repeat(40 * 1024) } });
  const r1 = await raw('/api/admin/login', [big], false);
  check('익명 API 40KB 본문 → 413', r1 === 413, String(r1));
  await settle();
  const r2 = await raw('/api/vault/recover', Array.from({ length: 40 }, () => 'a'.repeat(1024)), true);
  check('길이 없는(chunked) 40KB 본문 → 413', r2 === 413, String(r2));
  await settle();
  const ok31 = await raw('/api/admin/login', [JSON.stringify({ assertion: { id: 'x', pad: 'a'.repeat(31 * 1024) } })], true);
  check('상한 안(31KB) 본문은 읽고 검증 → 401', ok31 === 401, String(ok31));
  const r3 = await fetch(`${GW}/api/admin/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: GW }, body: '{not json' });
  check('JSON 아님 → 401 (빈 요청으로)', r3.status === 401, String(r3.status));
  check('공개키 형식 틀림 → 400', (await call('/api/recv', { pub: 'x'.repeat(86) })).status === 400);
  check('공개키 87자 → 200', (await call('/api/recv', { pub: b64u(randomBytes(65)) })).status === 200);
  check('setup 이 너무 김 → 403', (await call('/api/register/options', { setup: 'a'.repeat(5000) })).status === 403);
  await clock(11 * 60e3); await fx('fxAlarm'); await clock(0);
}

// ── #10 · #5 복구 ─────────────────────────────────────────
const VERIFIER = randomBytes(32).toString('base64url');
const codes = [];
const vopen = async (k, ip = '192.0.2.150') => {
  const o = (await callFrom(ip, '/api/vault/options', { credId: b64u(k.id) })).j;
  return callFrom(ip, '/api/vault/open', { assertion: k.get(o) });
};
const recover = (code, verifier = VERIFIER, ip = '203.0.113.9') => callFrom(ip, '/api/vault/recover', code === undefined ? { verifier } : { code, verifier });
const rcode = async () => (await fx('fxGet', ['vault:rcode']))['vault:rcode'];
const info = async () => (await call('/api/vault/recover-info', {})).j;
if (ONLY.has('10') || ONLY.has('5')) {
  section = '#10';
  const v1 = await vopen(KEY);
  check('금고 없이 열기 → 복구 코드 없음', v1.status === 200 && v1.j.initialized === false && !('recoveryCode' in v1.j), JSON.stringify(v1.j).slice(0, 200));
  const rec = { salt: 's'.repeat(22), iter: 600000, questions: ['q1', 'q2'], iv: 'i'.repeat(16), ct: 'c'.repeat(64), verifier: VERIFIER };
  const init = await call('/api/vault/init', { credId: b64u(KEY.id), wrap: { iv: 'w'.repeat(16), ct: 'x'.repeat(48) }, rec }, { 'x-admin-token': v1.j.token });
  check('새 금고 → 복구 코드 한 번 (형식)', init.j?.ok === true && CODE_RE.test(init.j.recoveryCode ?? ''), JSON.stringify(init.j));
  let C = init.j.recoveryCode;
  codes.push(C);
  check('저장된 건 해시뿐 (fails 0)', (await rcode())?.hash && (await rcode()).fails.length === 0);
  const i0 = await info();
  check('recover-info: 코드 필요·있음·남은 5', i0.codeRequired === true && i0.hasCode === true && i0.left === 5, JSON.stringify(i0));
  const v2 = await vopen(KEY);
  check('코드 있는 금고를 다시 열면 코드 안 나옴', v2.status === 200 && !('recoveryCode' in v2.j));

  // 틀린 코드 홍수 — 소유자 예산 안 깎임
  const flood = await Promise.all(Array.from({ length: 40 }, (_, i) => recover(fakeCode(), VERIFIER, `203.0.113.${i + 10}`)));
  check('틀린 코드 40개(맞는 답과 함께) → 전부 403', count(flood, 403) === 40, statuses(flood).join(','));
  const junk = await Promise.all([recover(undefined), recover(''), recover({ a: 1 }), recover('A'.repeat(20000)), recover(C.toLowerCase().replace(/-/g, ' ').slice(0, -1))]);
  check('코드 없음·빈 값·객체·20KB·한 자 모자람 → 403', junk.every((r) => r.status === 403), statuses(junk).join(','));
  check('코드 홍수 뒤 소유자 예산 그대로 (fails 0, 남은 5)', (await rcode()).fails.length === 0 && (await info()).left === 5);
  check('예전 전역 잠금 기록(meta.fails)도 안 늚', ((await fx('fxGet', ['vault:meta']))['vault:meta']?.fails ?? []).length === 0);
}
if (ONLY.has('5')) {
  section = '#5';
  let C = codes.at(-1);
  // 맞는 코드 + 틀린 답 동시 10개 → 예산 5
  const wrong = await Promise.all(Array.from({ length: 10 }, () => recover(C, randomBytes(32).toString('base64url'))));
  check('맞는 코드 + 틀린 답 동시 10개 → 403 다섯, 429 다섯', count(wrong, 403) === 5 && count(wrong, 429) === 5, statuses(wrong).join(','));
  check('저장된 오답 5', (await rcode()).fails.length === 5);
  check('예산 다 쓴 코드는 맞는 답도 429', (await recover(C)).status === 429);

  // 소유자가 보안 키로 새 코드
  const v = await vopen(KEY);
  check('없는 토큰으로 새 코드 → 401', (await call('/api/vault/recovery-code', {}, { 'x-admin-token': 'nope' })).status === 401);
  check('CLI 관리 토큰으로 새 코드 → 401', (await call('/api/vault/recovery-code', {}, await adminLogin(KEY))).status === 401);
  await clock(4 * 60e3);
  check('연 지 3분 지난 토큰으로 새 코드 → 401', (await call('/api/vault/recovery-code', {}, { 'x-admin-token': v.j.token })).status === 401);
  await clock(0);
  const rot = await call('/api/vault/recovery-code', {}, { 'x-admin-token': v.j.token });
  check('보안 키로 연 3분 안 → 새 코드', rot.status === 200 && CODE_RE.test(rot.j?.recoveryCode ?? '') && rot.j.recoveryCode !== C, JSON.stringify(rot.j));
  check('예전 코드 → 403 (코드 틀림)', (await recover(C)).status === 403);
  C = rot.j.recoveryCode; codes.push(C);
  check('새 코드는 예산 새로 (남은 5)', (await info()).left === 5);

  // 맞는 코드 + 맞는 답 동시 6개 → 성공 하나, 코드가 바뀜
  const ok = await Promise.all(Array.from({ length: 6 }, (_, i) => recover(C, VERIFIER, `203.0.113.${100 + i}`)));
  const win = ok.filter((r) => r.status === 200);
  check('동시 6개 → 성공 정확히 하나, 나머지 403', win.length === 1 && count(ok, 403) === 5, statuses(ok).join(','));
  check('성공 응답: 감싼 금고 키 + 새 코드', win[0]?.j?.wrap?.ct === 'c'.repeat(64) && CODE_RE.test(win[0]?.j?.recoveryCode ?? '') && win[0].j.recoveryCode !== C);
  check('늦게 온 다섯은 오답으로 안 셈 (새 코드 fails 0)', (await rcode()).fails.length === 0);
  check('쓴 코드 다시 → 403', (await recover(C)).status === 403);
  C = win[0].j.recoveryCode; codes.push(C);
  const again = await recover(C);
  check('새 코드로 한 번 더 복구 → 200, 또 새 코드', again.status === 200 && CODE_RE.test(again.j?.recoveryCode ?? '') && again.j.recoveryCode !== C);
  codes.push(again.j?.recoveryCode);
}
if (ONLY.has('10')) {
  section = '#10 legacy';
  // 코드 없는 예전 금고
  await fx('fxDelete', ['vault:rcode']);
  check('예전 금고: hasCode false', (await info()).hasCode === false);
  check('예전 금고: 아무 코드로 복구 → 403, 아무것도 안 씀', (await recover(codes.at(-1) ?? fakeCode())).status === 403 && !(await rcode()));
  const lab = await login(KEY);
  check('플래그 없는 관리 로그인(/lab 등) → 코드 안 줌', lab.status === 200 && !('recoveryCode' in lab.j) && !(await rcode()));
  const cl = (await bare('/api/cli/login', {})).j;
  const co = (await call(`/api/approve/${cl.id}/options`, {})).j;
  await call(`/api/approve/${cl.id}`, { assertion: KEY.get(co), choice: {} });
  const cp = (await bare(`/api/borrow/${cl.id}/poll`, { secret: cl.secret })).j;
  check('CLI 관리 로그인 → 코드 안 줌', !!cp?.adminToken && !JSON.stringify(cp).includes('recoveryCode') && !(await rcode()));
  const a1 = await login(KEY, '192.0.2.200', { recoveryCode: true });
  check('/admin 로그인 → 코드 한 번', a1.status === 200 && CODE_RE.test(a1.j?.recoveryCode ?? ''), JSON.stringify(a1.j));
  const a2 = await login(KEY, '192.0.2.200', { recoveryCode: true });
  check('다음 /admin 로그인 → 안 줌', a2.status === 200 && !('recoveryCode' in a2.j));
  codes.push(a1.j?.recoveryCode);
  check('받은 코드로 복구 → 200', (await recover(a1.j?.recoveryCode)).status === 200);
  const pub = JSON.stringify(await info());
  check('익명 recover-info 에는 코드 없음', !codes.some((c) => c && pub.includes(c)), pub);

  await fx('fxDelete', ['vault:rcode']);
  // 서로 다른 등록 키 둘로 동시에 연다 — 같은 키 둘이면 높은 카운터가 먼저 도착할 때 낮은 쪽이 정당하게 401 (아래 카운터 검사)
  const both = await Promise.all([vopen(KEY, '192.0.2.151'), vopen(KEY2, '192.0.2.152')]);
  const given = both.filter((r) => r.j && 'recoveryCode' in r.j);
  check('동시에 보안 키로 두 번 열기 → 코드는 한 응답에만', both.every((r) => r.status === 200) && given.length === 1, statuses(both).join(','));
  codes.push(given[0]?.j?.recoveryCode);
  check('그 코드로 복구 → 200', (await recover(given[0]?.j?.recoveryCode)).status === 200);

  // 같은 키로 서명한 두 응답이 순서를 바꿔 오면 낮은(이미 지난) 카운터는 거부하고 저장된 카운터는 그대로
  const ctrOf = async () => (await fx('fxGet', [`cred:${b64u(KEY.id)}`]))[`cred:${b64u(KEY.id)}`]?.counter;
  const opts = async () => (await callFrom('192.0.2.153', '/api/vault/options', { credId: b64u(KEY.id) })).j;
  const [oLo, oHi] = [await opts(), await opts()];
  const lo = KEY.get(oLo), hi = KEY.get(oHi);
  const hiR = await callFrom('192.0.2.153', '/api/vault/open', { assertion: hi });
  const after = await ctrOf();
  const loR = await callFrom('192.0.2.153', '/api/vault/open', { assertion: lo });
  check('같은 키: 높은 카운터 먼저 → 200, 늦게 온 낮은 카운터 → 401, 카운터 그대로',
    hiR.status === 200 && loR.status === 401 && after === KEY.counter && (await ctrOf()) === after, `${hiR.status},${loR.status},${after},${KEY.counter}`);

  const all = JSON.stringify(await fx('fxList', ''));
  const leaked = codes.filter(Boolean).filter((c) => all.includes(c) || all.includes(c.replace(/-/g, '')));
  check('저장소 어디에도 복구 코드 원문 없음', leaked.length === 0, leaked.join(','));
}

if (ONLY.has('10')) {
  section = '#10 vault';
  // 키 잇기·항목·보내기 (금고 화면이 관리 토큰으로 부르는 것). 암호문은 합성 문자열 — 서버는 형식·권한·정책만 본다
  const T = { 'x-admin-token': (await vopen(KEY2, '192.0.2.154')).j?.token };
  const NOPE = { 'x-admin-token': 'nope' };
  const id2 = b64u(KEY2.id);
  const W = { iv: 'v'.repeat(16), ct: 'y'.repeat(48) };
  const one = async (k) => (await fx('fxGet', [k]))[k];
  const keyOf = async (id) => (await call('/api/vault/status', {})).j?.keys?.find((k) => k.id === id);
  check('KEY2 는 아직 안 이어짐', !!T['x-admin-token'] && (await keyOf(id2))?.linked === false);
  check('토큰 없이 잇기 → 401, 안 씀', (await call('/api/vault/link', { credId: id2, wrap: W }, NOPE)).status === 401 && !(await one(`vwrap:${id2}`)));
  await fx('fxPut', { 'cred:noprf-key1': { id: 'noprf-key1', publicKey: 'x', counter: 0, label: 'np', createdAt: Date.now() } });
  const lb = [];
  for (const [credId, wrap] of [['noprf-key1', W], ['missing-cred', W], [id2, { iv: 1, ct: 'y' }], [id2, { iv: W.iv, ct: 'y'.repeat(513) }], [id2, undefined]]) lb.push(await call('/api/vault/link', { credId, wrap }, T));
  check('PRF 아닌 키·없는 키·iv 숫자·513자·wrap 없음 → 400, 안 씀', lb.every((r) => r.status === 400) && Object.keys(await fx('fxList', 'vwrap:')).length === 1, statuses(lb).join(','));
  await fx('fxDelete', ['cred:noprf-key1']);
  const lk = await call('/api/vault/link', { credId: id2, wrap: W }, T);
  const st = JSON.stringify((await call('/api/vault/status', {})).j);
  check('맞는 잇기 → 200, 상태에 linked, 상태·응답에 감싼 키 없음', lk.status === 200 && (await keyOf(id2))?.linked === true && !st.includes(W.ct) && !JSON.stringify(lk.j).includes(W.ct), st.slice(0, 200));
  check('KEY2 로 열면 그 감싼 키가 그대로', (await one(`vwrap:${id2}`))?.ct === W.ct && (await vopen(KEY2, '192.0.2.154')).j?.wrap?.ct === W.ct);

  const put = (item, h = T) => call('/api/vault/item', { item }, h);
  const nItems = async () => Object.keys(await fx('fxList', 'vitem:')).length;
  const n0 = await nItems();
  const ib = [];
  for (const [item, h] of [[{ id: 'item-0001', iv: 'i', ct: 'c' }, NOPE], [{ id: 'short', iv: 'i', ct: 'c' }], [{ id: 'bad id!!x', iv: 'i', ct: 'c' }], [{ id: 'item-0001', iv: 1, ct: 'c' }], [{ id: 'item-0001', iv: 'i' }]]) ib.push(await put(item, h));
  check('항목: 토큰 없음 401, 짧은·이상한 id·iv 숫자·ct 없음 400, 안 씀', statuses(ib).join(',') === '401,400,400,400,400' && (await nItems()) === n0, statuses(ib).join(','));
  check('64KB 넘는 암호문 → 413, 안 씀', (await put({ id: 'item-big1', iv: 'i', ct: 'c'.repeat(64 * 1024 + 1) })).status === 413 && (await nItems()) === n0);
  const ph = await put({ id: 'item-phone', iv: 'i', ct: 'c'.repeat(64 * 1024) });
  const sd = await put({ id: 'item-send1', iv: 'i', ct: 'CIPHER-ITEM', policy: 'send' });
  const odd = await put({ id: 'item-odd01', iv: 'i', ct: 'c', policy: 'SEND' });
  check('정책 없음·모르는 값 → phone, send 만 send (딱 64KB 는 통과)', ph.j?.item?.policy === 'phone' && odd.j?.item?.policy === 'phone' && sd.j?.item?.policy === 'send', JSON.stringify([ph.status, sd.j, odd.j]).slice(0, 200));
  const up = await put({ id: 'item-odd01', iv: 'i2', ct: 'c2', policy: 'send' });
  check('같은 id 다시 쓰면 고침 (개수 그대로)', up.status === 200 && (await nItems()) === n0 + 3 && (await one('vitem:item-odd01'))?.ct === 'c2');
  const del = (id, h = T) => call('/api/vault/item-delete', { id }, h);
  check('토큰 없이 지우기 → 401, 그대로', (await del('item-odd01', NOPE)).status === 401 && !!(await one('vitem:item-odd01')));
  check('없는 항목 지우기 → 404', (await del('item-none1')).status === 404);
  check('지우기 → 200, 사라짐', (await del('item-odd01')).status === 200 && !(await one('vitem:item-odd01')) && (await nItems()) === n0 + 2);
  // 500개 상한: 합성 채움 항목으로 딱 500 → 새 id 409(안 씀), 있는 id 고치기는 200. 채움만 128개씩 지워 되돌린다
  const fill = Array.from({ length: 500 - (n0 + 2) }, (_, i) => `vitem:fill-${String(i).padStart(4, '0')}`);
  for (let i = 0; i < fill.length; i += 128) await fx('fxPut', Object.fromEntries(fill.slice(i, i + 128).map((k) => [k, { id: k.slice(6), iv: 'i', ct: 'c', policy: 'phone', updatedAt: 0 }])));
  check('채움 뒤 딱 500개', (await nItems()) === 500);
  check('500개에서 새 id → 409, 안 씀', (await put({ id: 'item-501st', iv: 'i', ct: 'c' })).status === 409 && !(await one('vitem:item-501st')) && (await nItems()) === 500);
  check('500개에서 있는 id 고치기 → 200, 그대로 500', (await put({ id: 'item-send1', iv: 'i', ct: 'CIPHER-ITEM2', policy: 'send' })).status === 200 && (await nItems()) === 500 && (await one('vitem:item-send1'))?.ct === 'CIPHER-ITEM2');
  for (let i = 0; i < fill.length; i += 128) await fx('fxDelete', fill.slice(i, i + 128));
  check('채움만 지워 되돌림', (await nItems()) === n0 + 2 && !!(await one('vitem:item-phone')) && !!(await one('vitem:item-send1')));

  const recv = async (ip) => (await callFrom(ip, '/api/recv', { pub: b64u(randomBytes(65)) })).j;
  const BOX = { epk: 'E'.repeat(87), iv: 'BOX-IV', ct: 'BOX-CIPHERTEXT' };
  const sendIt = (id, itemId = 'item-send1', box = BOX, h = T) => call('/api/vault/send', { id, itemId, box }, h);
  const reqOf = (id) => one(`req:${id}`);
  const q = await recv('198.51.100.90');
  check('받기 요청은 kind send, pending', (await reqOf(q.id))?.kind === 'send' && (await reqOf(q.id)).status === 'pending');
  const sb = [];
  for (const [itemId, box, h] of [['item-send1', BOX, NOPE], ['item-phone'], ['item-none1'], ['item-send1', { ...BOX, epk: 1 }], ['item-send1', { ...BOX, ct: 'c'.repeat(64 * 1024 + 1) }]]) sb.push(await sendIt(q.id, itemId, box, h));
  check('보내기 거부: 토큰 없음 401·phone 항목 403·없는 항목 404·box 숫자 400·64KB 넘음 400', statuses(sb).join(',') === '401,403,404,400,400', statuses(sb).join(','));
  check('거부 뒤 요청은 pending 그대로, 전달물 없음', (await reqOf(q.id)).status === 'pending' && !(await reqOf(q.id)).delivery);
  const bw = (await callFrom('198.51.100.91', '/api/borrow', {})).j;
  const qd = await recv('198.51.100.93');
  await callFrom('198.51.100.93', `/api/approve/${qd.id}/deny`, {});
  const qx = await recv('198.51.100.92');
  await fx('fxPut', { [`req:${qx.id}`]: { ...(await reqOf(qx.id)), expiresAt: Date.now() - 1 } });
  const gs = [await sendIt(bw.id), await sendIt(qx.id), await sendIt(qd.id), await sendIt('nonexistent-id01')];
  check('빌리기 요청·만료·거절됨·없는 요청 → 409', gs.every((r) => r.status === 409), statuses(gs).join(','));
  check('가드에 걸린 요청은 안 바뀜', (await reqOf(bw.id))?.status === 'pending' && !(await reqOf(qx.id))?.delivery && (await reqOf(qd.id))?.status === 'denied');
  const ok = await sendIt(q.id);
  const sr = await reqOf(q.id);
  check('맞는 보내기 → 200, approved + 암호 상자만', ok.status === 200 && sr.status === 'approved' && sr.delivery?.kind === 'send' && sr.delivery.ct === BOX.ct && sr.expiresAt > Date.now(), JSON.stringify(sr).slice(0, 200));
  check('보낸 요청 다시 보내기 → 409', (await sendIt(q.id)).status === 409);
  const poll = (secret) => callFrom('198.51.100.90', `/api/borrow/${q.id}/poll`, { secret });
  check('틀린 secret 폴 → 403, 전달물 그대로', (await poll('x'.repeat(32))).status === 403 && !!(await reqOf(q.id)).delivery);
  const p1 = await poll(q.secret);
  check('폴 → 암호 상자 그대로 한 번', p1.j?.status === 'approved' && p1.j.epk === BOX.epk && p1.j.iv === BOX.iv && p1.j.ct === BOX.ct, JSON.stringify(p1.j));
  const p2 = await poll(q.secret);
  check('다시 폴 → delivered, 응답·저장소에 암호문 없음', p2.j?.status === 'delivered' && !JSON.stringify(p2.j).includes(BOX.ct) && !JSON.stringify(await reqOf(q.id)).includes(BOX.ct), JSON.stringify(p2.j));
  await clock(11 * 60e3); await fx('fxAlarm'); await clock(0);
}

// ── #7 잔여: 틀린 경로는 예약 전에 400 ─────────────────────
if (ONLY.has('7')) {
  section = '#7';
  const K9 = 'k9-' + randomBytes(6).toString('hex');
  const ADM9 = { 'x-admin-token': (await login(KEY)).j?.token }; // 앞 절이 시계를 밀어 처음 토큰은 만료됐다
  const up = await call('/api/admin/provider', { id: 'q9', label: 'Q9', upstream: `${MOCK}/q9`, auth: 'bearer', envKey: 'Q9_KEY', value: K9, labShare: true }, ADM9);
  check('공유 공급자', up.status === 200, JSON.stringify(up.j));
  const gen = (await fx('fxGet', ['prov:q9']))['prov:q9']?.gen;
  await fx('fxPut', { 'lab:lab9': { id: 'lab9', name: 'L9', createdAt: Date.now(), expiresAt: Date.now() + 3600e3, budget: 1, cpu: 1, memory: 2, disk: 5, snapshot: 's', model: 'm', gw: '', seats: [], share: { q9: { label: 'Q9', on: true, cap: 2 } } } });
  const sha = async (s) => b64u(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))));
  const T = `kvt_${randomBytes(24).toString('base64url')}`;
  const th = await sha(T);
  await fx('fxPut', { 'sess:s9': { id: 's9', tokenHash: th, providers: ['q9'], createdAt: Date.now(), expiresAt: Date.now() + 3600e3, budget: null, uses: 0, ip: 'test', country: '', city: '', ua: 'auth-security', lab: 'lab9', counts: {}, gens: { q9: gen } }, [`tok:${th}`]: 's9' });
  const sess = async () => (await fx('fxGet', ['sess:s9']))['sess:s9'];
  const proxy = async (rest) => { const r = await fetch(`${GW}/p/q9/${rest}`, { headers: { authorization: `Bearer ${T}` } }); return { status: r.status, text: await r.text() }; };

  const n0 = hitsUnder('/q9/').length;
  const ok = await proxy('v1/ok?x=1');
  check('보통 호출 → 200, upstream 한 번, 원래 키', ok.status === 200 && hitsUnder('/q9/').length === n0 + 1 && hitsUnder('/q9/v1/ok?x=1').at(-1)?.auth === `Bearer ${K9}`, `${ok.status} ${ok.text}`);
  let s = await sess();
  check('보통 호출은 셈 (count 1, uses 1)', s.counts.q9 === 1 && s.uses === 1, JSON.stringify(s.counts));
  const bad = await proxy('a'.repeat(9000));
  s = await sess();
  check('너무 긴 경로 → 400 bad path, upstream 없음', bad.status === 400 && bad.text.includes('bad path') && hitsUnder('/q9/').length === n0 + 1, `${bad.status} ${bad.text.slice(0, 80)}`);
  check('틀린 경로는 예약하지 않음 (count 1, uses 1 그대로)', s.counts.q9 === 1 && s.uses === 1, JSON.stringify({ c: s.counts, u: s.uses }));
  const fr = await fx('fxResolve', T, 'q9', 'x', 'no-question-mark');
  s = await sess();
  check('쿼리 형식 틀림(DO 직접) → 400, 예약 없음', fr.status === 400 && fr.error === 'bad path' && s.counts.q9 === 1 && s.uses === 1, JSON.stringify(fr));
  check('상한 2: 남은 한 번은 그대로 쓸 수 있음', (await proxy('v1/two')).status === 200 && (await sess()).counts.q9 === 2);
  check('그 뒤 429', (await proxy('v1/three')).status === 429);

  // 인코딩된 경로 구분자: upstream 이 풀면 base 경로(/q9) 밖으로 나간다 → 예약 전에 400
  const T2 = `kvt_${randomBytes(24).toString('base64url')}`;
  const th2 = await sha(T2);
  await fx('fxPut', { 'sess:s9b': { id: 's9b', tokenHash: th2, providers: ['q9'], createdAt: Date.now(), expiresAt: Date.now() + 3600e3, budget: null, uses: 0, ip: 'test', country: '', city: '', ua: 'auth-security', gens: { q9: gen } }, [`tok:${th2}`]: 's9b' });
  const uses2 = async () => (await fx('fxGet', ['sess:s9b']))['sess:s9b'].uses;
  const proxy2 = async (rest) => { const r = await fetch(`${GW}/p/q9/${rest}`, { headers: { authorization: `Bearer ${T2}` } }); return { status: r.status, text: await r.text() }; };
  const evil = ['v1/..%2F..%2Fadmin', 'v1/a%2fb', 'v1/a%2Fb', 'v1/a%5Cb', 'v1/a%5cb', 'v1/%252F..%252Fadmin', 'v1/%25%32%46x', 'v1/%25%35%63x', 'v1/%25252Fx', 'v1/%252e%252e/x', 'v1/%2e%2e%2fadmin'];
  const n1 = hitsUnder('/').length;
  const viaProxy = [];
  for (const e of evil) viaProxy.push([e, await proxy2(e)]);
  const viaDo = [];
  for (const e of evil) viaDo.push([e, await fx('fxResolve', T2, 'q9', e, '')]);
  check('인코딩된 / \\ (대소문자·이중 인코딩) → 프록시 400 bad path', viaProxy.every(([, r]) => r.status === 400 && r.text.includes('bad path')), viaProxy.filter(([, r]) => r.status !== 400).map(([e, r]) => `${e}:${r.status}`).join(' '));
  check('같은 경로 DO 직접 → 400 bad path', viaDo.every(([, r]) => r.status === 400 && r.error === 'bad path'), viaDo.filter(([, r]) => r.status !== 400).map(([e, r]) => `${e}:${JSON.stringify(r)}`).join(' '));
  check('거부된 경로는 upstream 없음, 예약 없음 (uses 0)', hitsUnder('/').length === n1 && (await uses2()) === 0, `${hitsUnder('/').length - n1} ${await uses2()}`);
  const good = ['v1/files/a%20b', 'v1/%E2%9C%93', 'v1/a%3Ab', 'v1/q?filter=a%2Fb%5Cc&x=%252F'];
  const gr = [];
  for (const e of good) gr.push([e, await proxy2(e)]);
  check('보통 인코딩 경로·쿼리 값(%2F 든 쿼리 포함) → 200', gr.every(([, r]) => r.status === 200), gr.map(([e, r]) => `${e}:${r.status}`).join(' '));
  check('upstream 이 받은 경로·쿼리는 그대로', good.every((e) => hits.some((h) => h.path === `/q9/${e}` && h.auth === `Bearer ${K9}`)), JSON.stringify(hits.slice(-4).map((h) => h.path)));
  check('정상 호출만 셈 (uses 4)', (await uses2()) === 4, String(await uses2()));
}

// ── 익명 거절 홍수가 감사 기록을 밀어내지 않음 ─────────────────
if (ONLY.has('A')) {
  section = 'audit';
  let off = 0;
  await clock(off);
  await fx('fxDelete', ['audit:deny']); // #1 의 거절 요약은 비우고 센다
  const A0 = { 'x-admin-token': (await login(KEY)).j?.token };
  const rv = await call('/api/admin/revoke', { target: 'all' }, A0);
  check('소유자 보안 이벤트(전부 끊기)', rv.status === 200, JSON.stringify(rv.j));
  const audit0 = (await fx('fxGet', ['audit'])).audit ?? [];
  const mark = audit0.find((x) => x.event === 'revoke');
  check('감사 기록에 revoke 가 있음', !!mark);
  let denied = 0, advanced = 0;
  for (let i = 0; denied < 100 && i < 400; i++) {
    const ip = `198.18.${denied % 50}.1`;
    const r = await callFrom(ip, '/api/borrow', {});
    if (r.status === 429) { off += 61e3; advanced++; await clock(off); continue; }
    if ((await callFrom(ip, `/api/approve/${r.j.id}/deny`, {})).j?.ok) denied++;
  }
  check('거절 100번', denied === 100, `${denied} (시계 ${advanced}번 밈)`);
  const audit1 = (await fx('fxGet', ['audit'])).audit ?? [];
  check('거절은 감사 기록에 한 줄씩 안 들어감', audit1.length === audit0.length && !audit1.some((x) => x.event === 'deny'), `${audit0.length} → ${audit1.length}`);
  check('앞선 소유자 이벤트(revoke)가 그대로 남음', audit1.some((x) => x.event === 'revoke' && x.t === mark?.t));
  const agg = (await fx('fxGet', ['audit:deny']))['audit:deny'] ?? [];
  check('거절 요약 줄 수 상한 (≤48), 합계 100', agg.length <= 48 && agg.reduce((n, d) => n + d.n, 0) === 100, `${agg.length} ${agg.reduce((n, d) => n + d.n, 0)}`);
  check('넘친 출처는 * 한 줄로 합침', agg.some((d) => d.src === '*'), JSON.stringify(agg.map((d) => d.src.slice(0, 6))));
  check('거절 요약에 IP 원문 없음', !JSON.stringify(agg).includes('198.18.'));
  const A1 = { 'x-admin-token': (await login(KEY)).j?.token };
  const lst = (await call('/api/admin/list', {}, A1)).j;
  const shown = lst?.audit?.slice(0, 30) ?? [];
  check('관리 화면 30줄에 revoke 보임, 거절 요약은 5줄 이하', shown.some((x) => x.event === 'revoke') && shown.filter((x) => x.event === 'deny').length <= 5 && shown.some((x) => x.event === 'deny'), JSON.stringify(shown.map((x) => x.event)));
  off += 25 * 3600e3; await clock(off);
  const last = (await callFrom('198.18.200.1', '/api/borrow', {})).j;
  await callFrom('198.18.200.1', `/api/approve/${last.id}/deny`, {});
  const agg2 = (await fx('fxGet', ['audit:deny']))['audit:deny'] ?? [];
  check('24시간 지난 거절 요약은 지워짐 (새 한 줄만)', agg2.length === 1 && agg2[0].n === 1, JSON.stringify(agg2));
  await clock(off + 13 * 60e3); await fx('fxAlarm'); await clock(0);
}

section = 'guard';
const ob = [...outboundBefore, ...(await fx('fxOutbound'))];
check('바깥(loopback 아닌) 호출 없음', ob.length === 0, JSON.stringify(ob.slice(0, 3)));
await done();
