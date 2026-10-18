// core 보안 회귀 테스트 (#2 저장 키 목적지 바꾸기, #6 지우고 다시 만든 공급자, #7 자리당 상한 경쟁, #12 WebAuthn challenge).
//
// 진짜 로컬 workerd(wrangler dev)에 test/fixtures/core-security/fixture.js 를 main 으로 한 임시 설정을 띄운다.
// 진짜 State(DO)·SQLite 저장소를 쓰고, 설정·비밀은 전부 이번 실행에서 만든 합성 값이다 (User 환경변수·.dev.vars·배포 없음).
// 바깥 호출은 fixture 가 막고 기록한다. upstream 은 이 스크립트의 loopback 가짜 서버뿐.
//
//   node test/core-security.mjs                   이 저장소 src 로
//   node test/core-security.mjs --src=<dir> --baseline   다른 src(예: 고치기 전)로 — 실패한 항목 = 재현된 취약점, 종료 코드 0
//   --only=2,6,7,12   일부만
//
// 2차 수리: #6 옮기기는 updatedAt 으로만 증명 (감사 기록 100개 잘림), #6 수정↔지우기 경쟁 (fixture hold), #7 upstream 전 실패는 예약을 돌려줌
// #4 Daytona 조직·계정 관리 API 는 승인 때 따로 허용한 토큰만 · #13 세션 호출 상한 (총·분당·동시, 경쟁·돌려주기·재시작)
//   --only=4,13 로 이 둘만
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes, webcrypto } from 'node:crypto';
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
const ONLY = new Set((arg('only') ?? '2,4,6,7,12,13').split(','));
const fwd = (p) => p.replace(/\\/g, '/');

const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const PORT = await freePort(), INSP = await freePort();
const GW = `http://127.0.0.1:${PORT}`;
process.env.GW = GW;
const { SoftKey, call, check: rawCheck, finish } = await import('./lib.mjs');
let section = '';
const check = (name, cond, extra = '') => rawCheck(`[${section}] ${name}`, cond, extra);

// ── 가짜 upstream (loopback). 받은 요청을 적어 둔다 ──
const hits = [];
const holds = []; // #13: '/hold' 경로는 첫 조각만 보내고 테스트가 끝낼 때까지 응답을 열어 둔다 (스트리밍 응답 흉내)
const holdBy = {}; // 경로 → 그 응답. gone = upstream 연결이 닫혔을 때 풀리는 promise
const mock = http.createServer((req, res) => {
  hits.push({ path: req.url, auth: req.headers.authorization ?? '', xapi: req.headers['x-api-key'] ?? '', tenant: req.headers['x-tenant-id'] ?? '', h: req.headers });
  if (req.url.includes('/hold')) {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: start\n\n');
    holds.push(res);
    holdBy[req.url] = res;
    res.gone = new Promise((ok) => res.on('close', () => ok(true)));
    return;
  }
  // #2 프록시 경계: 빈 본문(204) · upstream Set-Cookie · JSON 오류 메시지(429)
  if (req.url.includes('/empty204')) { res.writeHead(204); res.end(); return; }
  if (req.url.includes('/setck')) res.setHeader('set-cookie', ['up_sess=leak; Path=/', 'up2=x']);
  if (req.url.includes('/err429')) { res.writeHead(429, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'mock quota note' } })); return; }
  res.writeHead(req.url.includes('/fail500') ? 500 : 200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, path: req.url }));
});
await new Promise((r) => mock.listen(0, '127.0.0.1', r));
const MOCK = `http://127.0.0.1:${mock.address().port}`;
const hitsUnder = (p) => hits.filter((h) => h.path.startsWith(p));

// ── 임시 설정 + fixture entry ──
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-core-sec-'));
const MASTER_KEY = randomBytes(32).toString('base64url');
const SETUP = randomBytes(18).toString('base64url');
fs.writeFileSync(path.join(TMP, 'entry.js'),
  `import worker, { State as Base } from '${fwd(path.join(SRC, 'index.ts'))}';\n` +
  `import { makeFixture } from '${fwd(path.join(ROOT, 'test/fixtures/core-security/fixture.js'))}';\n` +
  `const f = makeFixture(worker, Base);\nexport const State = f.State;\nexport default f.worker;\n`);
fs.writeFileSync(path.join(TMP, 'wrangler.json'), JSON.stringify({
  name: 'gw-core-security-fixture', main: 'entry.js', compatibility_date: '2026-09-01', compatibility_flags: ['nodejs_compat'],
  rules: [{ type: 'Text', globs: ['**/*.ps1'], fallthrough: true }],
  vars: {
    RP_ID: '127.0.0.1', ORIGIN: GW, LAB_ORIGIN: `http://localhost:${PORT}`, LAB_GW: '', ALLOW_SHORT_TTL: '1',
    LAB_DAYTONA_API: `${MOCK}/daytona`, REALTIME_API: `${MOCK}/rtc`, MASTER_KEY, SETUP_TOKEN: SETUP,
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
  const tee = (d) => { log += d; if (process.env.CS_LOG) fs.appendFileSync(process.env.CS_LOG, d); }; // CS_LOG=<파일>: wrangler 출력 남기기 (진단용)
  child.stdout.on('data', tee);
  child.stderr.on('data', tee);
  const until = Date.now() + 120e3;
  while (Date.now() < until) {
    try { if ((await fetch(`${GW}/borrow`)).status === 200) return; } catch {}
    if (child.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log(log.slice(-4000));
  throw new Error('wrangler dev did not start');
}
const outboundBefore = []; // 재시작 전 fixture 가 막은 바깥 호출 (메모리라 재시작하면 사라진다)
async function stop() {
  if (!child) return;
  try { outboundBefore.push(...(await fx('fxOutbound'))); } catch {}
  const pid = child.pid;
  // 이 스크립트가 띄운 프로세스 트리만 끈다
  try { if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); else child.kill('SIGTERM'); } catch {}
  await new Promise((r) => (child.exitCode !== null ? r() : child.once('exit', r)));
  child = null;
  await new Promise((r) => setTimeout(r, 800));
}
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
// 다시 보내도 결과가 같은 fixture 호출만 (읽기·같은 값 쓰기). 돌려주기·풀기·늘리기·알람처럼 시험 대상인 호출은 다시 보내지 않는다
const FX_IDEMPOTENT = new Set(['fxGet', 'fxList', 'fxOutbound', 'fxBarrierInfo', 'fxHoldInfo', 'fxRenewLog', 'fxFlag', 'fxPut', 'fxDelete', 'fxLeaseTtl', 'fxFlagSet']);
const fx = async (m, ...args) => {
  for (let i = 0; ; i++) {
    const r = await fetch(`${GW}/__fx/${m}`, { method: 'POST', body: JSON.stringify(args) });
    const t = await r.text();
    // wrangler dev 의 앞단 프록시: 중간에 끊긴 스트리밍 응답(#13 upstream 끊김) 뒤 재사용한 연결이 'Network connection lost' 로 실패할 수 있다.
    // 그 프록시가 낸 500 평문이고 다시 보내도 같은 fixture 호출일 때만 두 번까지 다시 (로그에 남김) — 게이트웨이 응답·시험 대상 호출은 다시 하지 않는다
    if (i < 2 && r.status === 500 && FX_IDEMPOTENT.has(m) && t.startsWith('Error: Network connection lost') && !/json/i.test(r.headers.get('content-type') ?? '')) {
      console.log(`  (fixture ${m}: wrangler 앞단 연결 끊김 → 다시 ${i + 1})`);
      await sleep(200);
      continue;
    }
    if (!r.ok) throw new Error(`fixture ${m} → ${r.status} ${t.slice(0, 200)}`);
    return JSON.parse(t);
  }
};
const proxy = async (token, provider, rest = 'x') => {
  const r = await fetch(`${GW}/p/${provider}/${rest}`, { headers: { authorization: `Bearer ${token}` } });
  return { status: r.status, text: await r.text() };
};
/** 경로를 그대로 보낸다 (fetch 는 ./ ../ %2e 를 먼저 풀어 버린다 — 게이트웨이가 받는 원문을 시험하려고) */
const rawProxy = (token, provider, rest) => new Promise((res, rej) => {
  const rq = http.request({ host: '127.0.0.1', port: PORT, path: `/p/${provider}/${rest}`, headers: { authorization: `Bearer ${token}` } }, (r) => {
    let text = '';
    r.on('data', (d) => { text += d; });
    r.on('end', () => res({ status: r.statusCode, text }));
  });
  rq.on('error', rej);
  rq.end();
});
const b64u = (b) => Buffer.from(b).toString('base64url');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 테스트 쪽에서 합성 MASTER_KEY 로 공급자 키를 봉인 (예전 기록 흉내용). AAD 는 production 과 같은 prov:<id> */
async function seal(id, value) {
  const k = await webcrypto.subtle.importKey('raw', Buffer.from(MASTER_KEY, 'base64url'), 'AES-GCM', false, ['encrypt']);
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const ct = await webcrypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(`prov:${id}`) }, k, new TextEncoder().encode(value));
  return { iv: b64u(iv), ct: b64u(new Uint8Array(ct)), last4: value.slice(-4) };
}
const sha = async (s) => b64u(new Uint8Array(await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(s))));
/** 합성 세션 + 토큰 (저장소에 직접). 반환: 토큰 */
async function seedSession(sid, extra) {
  const token = `kvt_${randomBytes(24).toString('base64url')}`;
  const tokenHash = await sha(token);
  await fx('fxPut', {
    [`sess:${sid}`]: { id: sid, tokenHash, createdAt: Date.now(), expiresAt: Date.now() + 3600e3, budget: null, uses: 0, ip: 'test', country: '', city: '', ua: 'core-security', ...extra },
    [`tok:${tokenHash}`]: sid,
  });
  return token;
}
const flip = (s) => { const b = Buffer.from(s, 'base64url'); b[b.length - 1] ^= 1; return b.toString('base64url'); };
/** 등록된 키로 서명했지만 서명을 망가뜨린 응답 */
const badSig = (a) => ({ ...a, response: { ...a.response, signature: flip(a.response.signature) } });
/** 공격자: 다른(등록 안 된) 키로 같은 challenge 에 서명하고 id 만 피해자 키로 */
const forged = (victim, atk, opts) => ({ ...atk.get(opts), id: b64u(victim.id), rawId: b64u(victim.id) });

async function login(key) {
  const o = (await call('/api/admin/options', {})).j;
  const r = await call('/api/admin/login', { assertion: key.get(o) });
  return r.j?.token ? { 'x-admin-token': r.j.token } : null;
}
async function borrow(key, providers) {
  const r = (await call('/api/borrow', {})).j;
  const o = (await call(`/api/approve/${r.id}/options`, {})).j;
  const a = await call(`/api/approve/${r.id}`, { assertion: key.get(o), choice: { providers, ttlHours: 1, budget: 1 } });
  if (a.status !== 200) return { error: a.j?.error, status: a.status };
  const p = (await call(`/api/borrow/${r.id}/poll`, { secret: r.secret })).j;
  return p.token;
}
const upsert = (ADM, body) => call('/api/admin/provider', body, ADM);
const prov = async (id) => (await fx('fxGet', [`prov:${id}`]))[`prov:${id}`];
const sessOf = async (sid) => (await fx('fxGet', [`sess:${sid}`]))[`sess:${sid}`];

// ═══════════════════════════════════════════════════════════
await start();
console.log(`core-security: src=${SRC} gw=${GW} mock=${MOCK}${BASELINE ? ' (baseline)' : ''}`);
const KEY = new SoftKey();
section = 'setup';
{
  const o = await call('/api/register/options', { setup: SETUP });
  const v = await call('/api/register/verify', { setup: SETUP, response: KEY.create(o.j), label: 'soft' });
  check('등록 (SETUP_TOKEN)', v.j?.ok === true, JSON.stringify(v.j));
}
const ADM = await login(KEY);
check('관리 로그인', !!ADM);

// ── #12 WebAuthn challenge ────────────────────────────────
if (ONLY.has('12')) {
  section = '#12';
  const ATK = new SoftKey();
  {
    // 피해자 options 뒤에 공격자 options — 예전에는 덮어써서 피해자 의식이 깨졌다
    const vo = (await call('/api/admin/options', {})).j;
    const ao = (await call('/api/admin/options', {})).j;
    check('options 두 개는 서로 다른 challenge', vo.challenge && ao.challenge && vo.challenge !== ao.challenge);
    check('공격자: 등록 안 된 키로 피해자 challenge 에 서명 → 거부', (await call('/api/admin/login', { assertion: forged(KEY, ATK, vo) })).status === 401);
    check('공격자: 서명 망가뜨린 응답 → 거부', (await call('/api/admin/login', { assertion: badSig(KEY.get(vo)) })).status === 401);
    check('공격자: 쓰레기 clientDataJSON → 거부', (await call('/api/admin/login', { assertion: { id: b64u(KEY.id), response: { clientDataJSON: 'x' } } })).status === 401);
    const ok = await call('/api/admin/login', { assertion: KEY.get(vo) });
    check('피해자 의식은 공격자 options·틀린 응답 뒤에도 통과', ok.status === 200 && !!ok.j?.token, JSON.stringify(ok.j));
  }
  {
    // 동시에 두 의식
    const [o1, o2] = await Promise.all([call('/api/admin/options', {}), call('/api/admin/options', {})]);
    const a1 = KEY.get(o1.j), a2 = KEY.get(o2.j);
    const [r1, r2] = await Promise.all([call('/api/admin/login', { assertion: a1 }), call('/api/admin/login', { assertion: a2 })]);
    check('동시에 연 두 정상 의식 모두 통과', r1.status === 200 && r2.status === 200, `${r1.status} ${r2.status}`);
    check('재사용(replay) 거부', (await call('/api/admin/login', { assertion: a1 })).status === 401);
    const o3 = (await call('/api/admin/options', {})).j;
    const a3 = KEY.get(o3);
    const both = await Promise.all([call('/api/admin/login', { assertion: a3 }), call('/api/admin/login', { assertion: a3 })]);
    check('같은 응답 동시 두 번 → 하나만 통과', both.filter((x) => x.status === 200).length === 1, both.map((x) => x.status).join(','));
  }
  {
    // purpose 섞기
    const o = (await call('/api/admin/options', {})).j;
    const a = KEY.get(o);
    check('admin challenge 로 금고 열기 → 거부', (await call('/api/vault/open', { assertion: a })).status === 401);
    check('거부된 purpose 섞기는 원래 의식을 없애지 않음', (await call('/api/admin/login', { assertion: a })).status === 200);
    const r1 = (await call('/api/borrow', {})).j, r2 = (await call('/api/borrow', {})).j;
    const o1 = (await call(`/api/approve/${r1.id}/options`, {})).j;
    const a1 = KEY.get(o1);
    const ch = { providers: [], ttlHours: 1, budget: 1 };
    const cli = (await call('/api/cli/login', {})).j;
    check('요청 A 의 challenge 로 요청 B(CLI 로그인) 승인 → 거부', (await call(`/api/approve/${cli.id}`, { assertion: a1, choice: ch })).status === 401);
    const ro = (await call('/api/register/options', { setup: SETUP })).j;
    check('등록 challenge 로 관리 로그인 → 거부', (await call('/api/admin/login', { assertion: KEY.get({ ...ro, rpId: ro.rp.id }) })).status === 401);
    const lo = (await call(`/api/approve/${cli.id}/options`, {})).j;
    check('CLI 로그인 승인은 자기 challenge 로 통과', (await call(`/api/approve/${cli.id}`, { assertion: KEY.get(lo), choice: {} })).status === 200);
    void r2;
  }
  {
    // 만료
    const o = (await call('/api/admin/options', {})).j;
    const k = `wch:admin|${o.challenge}`;
    const rec = (await fx('fxGet', [k]))[k];
    check('challenge 는 purpose·challenge 로 따로 저장', rec?.purpose === 'admin' && rec?.challenge === o.challenge, JSON.stringify(rec));
    if (rec) await fx('fxPut', { [k]: { ...rec, expiresAt: Date.now() - 1 } });
    check('만료된 challenge → 거부', (await call('/api/admin/login', { assertion: KEY.get(o) })).status === 401);
    check('만료된 기록은 지워짐', !(await fx('fxGet', [k]))[k]);
  }
  {
    // 예전 한 칸짜리 chal:<purpose> 는 받지 않는다
    const X = randomBytes(32).toString('base64url');
    await fx('fxPut', { 'chal:admin': { challenge: X, expiresAt: Date.now() + 60e3 } });
    check('예전 chal:admin 기록 challenge 로 로그인 → 거부', (await call('/api/admin/login', { assertion: KEY.get({ challenge: X, rpId: '127.0.0.1' }) })).status === 401);
    await call('/api/admin/options', {});
    check('새 options 가 예전 chal:admin 을 지움', !(await fx('fxGet', ['chal:admin']))['chal:admin']);
    await fx('fxPut', { 'chal:vault': { challenge: X, expiresAt: Date.now() + 60e3 } });
    await fx('fxAlarm');
    check('알람이 남은 예전 chal: 기록을 지움', Object.keys(await fx('fxList', 'chal:')).length === 0);
  }
  {
    // 등록 두 개 동시 + 공격자 틀린 등록 + PRF. SETUP_TOKEN 하나로 등록 성공은 2회 (위 'soft' 가 1회) —
    // 동시에 연 두 의식 중 하나(PRF)가 둘째 성공, 다른 하나는 셋째라 거부된다
    const K2 = new SoftKey(), K3 = new SoftKey();
    const [ro2, ro3] = await Promise.all([call('/api/register/options', { setup: SETUP }), call('/api/register/options', { setup: SETUP })]);
    check('동시 등록 의식 두 개 열림', ro2.status === 200 && ro3.status === 200 && ro2.j.challenge !== ro3.j.challenge, `${ro2.status} ${ro3.status}`);
    const bad = K3.create(ro2.j);
    const badCdj = JSON.parse(Buffer.from(bad.response.clientDataJSON, 'base64url'));
    bad.response.clientDataJSON = b64u(JSON.stringify({ ...badCdj, origin: 'https://evil.example' }));
    check('공격자: 피해자 등록 challenge 로 틀린 등록 → 거부', (await call('/api/register/verify', { setup: SETUP, response: bad, label: 'atk' })).status === 400);
    check('틀린 등록은 횟수를 안 씀 (used 1)', Object.values(await fx('fxList', 'setup:'))[0]?.used === 1, JSON.stringify(await fx('fxList', 'setup:')));
    const r3 = K3.create(ro3.j);
    const r2 = { ...K2.create(ro2.j), clientExtensionResults: { prf: { enabled: true } } };
    const v2 = await call('/api/register/verify', { setup: SETUP, response: r2, label: 'k2-prf' });
    check('다른 의식이 열려 있어도 (틀린 시도 뒤에도) PRF 등록 통과 = 둘째 성공', v2.j?.ok === true && v2.j?.prf === true, JSON.stringify(v2.j));
    const v3 = await call('/api/register/verify', { setup: SETUP, response: r3, label: 'k3' });
    check('셋째 SETUP_TOKEN 등록 → 403, 키 2개, used 2', v3.status === 403 && Object.keys(await fx('fxList', 'cred:')).length === 2
      && Object.values(await fx('fxList', 'setup:'))[0]?.used === 2, `${v3.status} ${JSON.stringify(v3.j)}`);
    check('다 쓴 토큰 → options 403', (await call('/api/register/options', { setup: SETUP })).status === 403);
    const re = await call('/api/register/verify', { setup: SETUP, response: r2, label: 'again' });
    check('등록 응답 재사용 거부 (키 그대로 2개)', [400, 403].includes(re.status) && Object.keys(await fx('fxList', 'cred:')).length === 2, String(re.status));
    const vo = await call('/api/vault/options', { credId: b64u(K2.id) });
    check('금고 options: PRF 키만, transports 유지', vo.status === 200 && vo.j.allowCredentials?.length === 1 && vo.j.allowCredentials[0].id === b64u(K2.id) && vo.j.allowCredentials[0].transports?.includes('nfc'), JSON.stringify(vo.j));
    const open = vo.status === 200 ? await call('/api/vault/open', { assertion: K2.get(vo.j) }) : vo;
    check('PRF 키로 금고 열기 통과', open.status === 200 && !!open.j?.token, JSON.stringify(open.j));
  }
}

// ── #2 저장 키 목적지 ─────────────────────────────────────
if (ONLY.has('2')) {
  section = '#2';
  const K = 'k2-secret-' + randomBytes(6).toString('hex');
  const base = { id: 'c2', label: 'C2', upstream: `${MOCK}/c2`, auth: 'bearer', envKey: 'C2_API_KEY' };
  check('사용자 정의 공급자 + 새 키', (await upsert(ADM, { ...base, value: K })).status === 200);
  const before = await prov('c2');
  const mut = [
    ['upstream → 다른 호스트', { upstream: 'https://evil.example.com' }],
    ['upstream → 같은 출처 다른 경로', { upstream: `${MOCK}/other` }],
    ['upstream → 다른 포트', { upstream: `http://127.0.0.1:${PORT}/c2` }],
    ['upstream → localhost 별칭', { upstream: MOCK.replace('127.0.0.1', 'localhost') + '/c2' }],
    ['auth → x-api-key', { auth: 'x-api-key' }],
    ['kind → openrouter-mint', { kind: 'openrouter-mint' }],
    ['preset 별칭(openrouter 틀)', { preset: 'openrouter', upstream: '', kind: '' }],
  ];
  for (const [name, m] of mut) check(`키 없이 ${name} → 거부`, (await upsert(ADM, { id: 'c2', ...m })).status === 400);
  const after = await prov('c2');
  check('저장된 목적지·인증·종류·암호문 그대로', after.upstream === before.upstream && after.auth === before.auth && after.kind === before.kind && after.ct === before.ct, JSON.stringify({ before: before.upstream, after: after.upstream }));
  const meta = await upsert(ADM, { id: 'c2', label: '이름 바꿈', note: '메모', headers: 'X-Tenant-Id: t-1', envBase: 'C2_BASE_URL', basePath: 'v1' });
  check('키 없이 이름·메모·고정 헤더·env 수정 → 허용', meta.status === 200 && meta.j?.provider?.label === '이름 바꿈', JSON.stringify(meta.j));
  const T = await borrow(KEY, ['c2']);
  const n0 = hits.length;
  const px = await proxy(T, 'c2', 'v1/ping');
  const h = hits.slice(n0);
  check('프록시: 저장된 키가 원래 upstream 으로, 고정 헤더 포함', px.status === 200 && h.length === 1 && h[0].path === '/c2/v1/ping' && h[0].auth === `Bearer ${K}` && h[0].tenant === 't-1', JSON.stringify(h));
  {
    // 들어온 자격 증명·쿠키·네트워크 신원은 upstream 에 안 간다. 고정 헤더가 들어온 같은 이름을 이긴다
    const n = hits.length;
    const r = await fetch(`${GW}/p/c2/v1/hdr`, { headers: {
      authorization: `Bearer ${T}`, 'x-api-key': 'in-xapi', 'xi-api-key': 'in-xi', cookie: 'sid=in-cookie', 'x-forwarded-for': '203.0.113.9',
      'x-forwarded-proto': 'https', 'x-real-ip': '203.0.113.9', 'true-client-ip': '203.0.113.9', 'cf-connecting-ip': '203.0.113.9', 'x-tenant-id': 'evil', 'x-keep': 'k1' } });
    await r.text();
    const u = hits.slice(n)[0]?.h ?? {};
    const gone = ['x-api-key', 'xi-api-key', 'cookie', 'x-forwarded-for', 'x-forwarded-proto', 'x-real-ip', 'true-client-ip', 'cf-connecting-ip'].filter((k) => k in u);
    check('프록시: 들어온 x-api-key·xi-api-key·쿠키·IP 헤더 제거, 그 밖 헤더는 전달', r.status === 200 && !gone.length && u['x-keep'] === 'k1' && !JSON.stringify(u).includes('203.0.113.9'), JSON.stringify({ gone, u }));
    check('프록시: 고정 헤더(x-tenant-id)가 들어온 값을 이기고 인증은 저장된 키', u['x-tenant-id'] === 't-1' && u.authorization === `Bearer ${K}`, JSON.stringify(u));
    // ElevenLabs SDK: authorization 없이 xi-api-key 로 가짜 토큰
    const n2 = hits.length;
    const xi = await fetch(`${GW}/p/c2/v1/xi`, { headers: { 'xi-api-key': T } });
    await xi.text();
    const u2 = hits.slice(n2)[0]?.h ?? {};
    check('프록시: xi-api-key 가짜 토큰도 받고 upstream 에는 저장된 키만', xi.status === 200 && u2.authorization === `Bearer ${K}` && !('xi-api-key' in u2), JSON.stringify(u2));
    const sc = await fetch(`${GW}/p/c2/v1/setck`, { headers: { authorization: `Bearer ${T}` } });
    await sc.text();
    check('프록시: upstream Set-Cookie 는 응답에서 제거', sc.status === 200 && sc.headers.getSetCookie().length === 0 && !sc.headers.has('set-cookie'), JSON.stringify([...sc.headers]));
    const sid = (await fx('fxGet', [`tok:${await sha(T)}`]))[`tok:${await sha(T)}`];
    const em = await fetch(`${GW}/p/c2/v1/empty204`, { headers: { authorization: `Bearer ${T}` } });
    const et = await em.text();
    let s2;
    for (let i = 0; i < 40 && Object.keys((s2 = await sessOf(sid))?.leases ?? {}).length; i++) await sleep(50);
    check('프록시: 빈 본문(204) 그대로 전달, 동시 자리 풀림', em.status === 204 && et === '' && !!s2 && Object.keys(s2.leases ?? {}).length === 0, JSON.stringify({ status: em.status, leases: s2?.leases }));
    const er = await proxy(T, 'c2', 'v1/err429');
    let le;
    for (let i = 0; i < 40 && !(le = (await fx('fxGet', [`lerr:${sid}`]))[`lerr:${sid}`]); i++) await sleep(50);
    check('프록시: upstream 429 전달, JSON error.message 를 세션 최근 오류로 적음', er.status === 429 && le?.status === 429 && le?.msg === 'mock quota note', JSON.stringify(le));
  }
  const K2 = 'k2-new-' + randomBytes(6).toString('hex');
  check('새 키와 함께면 upstream 바꾸기 허용', (await upsert(ADM, { id: 'c2', upstream: `${MOCK}/c2b`, value: K2 })).status === 200);
  const T2 = await borrow(KEY, ['c2']);
  const n1 = hits.length;
  await proxy(T2, 'c2', 'q');
  check('새 키는 새 upstream 으로', hits.slice(n1).some((x) => x.path === '/c2b/q' && x.auth === `Bearer ${K2}`));
  const n2 = hits.length;
  check('목적지가 바뀐 뒤 예전 토큰 → 거부, upstream 안 부름', (await proxy(T, 'c2', 'q')).status === 403 && hits.length === n2);

  const bad = [
    ['openrouter-mint lookalike 호스트', { kind: 'openrouter-mint', upstream: 'https://openrouter.ai.evil.com' }],
    ['openrouter-mint 앞붙임 호스트', { kind: 'openrouter-mint', upstream: 'https://evilopenrouter.ai' }],
    ['openrouter-mint 다른 포트', { kind: 'openrouter-mint', upstream: 'https://openrouter.ai:8443' }],
    ['openrouter-mint 경로', { kind: 'openrouter-mint', upstream: 'https://openrouter.ai/api' }],
    ['openrouter-mint userinfo', { kind: 'openrouter-mint', upstream: 'https://x@openrouter.ai' }],
    ['openrouter-mint 쿼리', { kind: 'openrouter-mint', upstream: 'https://openrouter.ai/?a=1' }],
    ['openrouter-mint 조각', { kind: 'openrouter-mint', upstream: 'https://openrouter.ai#f' }],
    ['userinfo 로 다른 호스트', { upstream: 'https://openrouter.ai@evil.example' }],
    ['user:pw', { upstream: 'https://u:p@api.example.com' }],
    ['잘못된 % 인코딩', { upstream: 'https://api.example.com/%zz' }],
    ['인코딩한 / 경로', { upstream: 'https://api.example.com/a%2f..' }],
    ['상대 주소', { upstream: 'api.example.com' }],
    ['쿼리', { upstream: 'https://api.example.com/v1?x=1' }],
    ['역슬래시', { upstream: 'https://api.example.com\\@evil.example' }],
    ['dev 라도 loopback 아닌 http', { upstream: 'http://evil.example' }],
    ['localhost 흉내 호스트', { upstream: 'http://localhost.evil.example' }],
    ['127.0.0.1@ 호스트', { upstream: 'http://127.0.0.1@evil.example' }],
  ];
  for (const [name, m] of bad) {
    const r = await upsert(ADM, { id: 'bad2', label: 'x', auth: 'bearer', envKey: 'BAD2_KEY', kind: 'proxy', upstream: `${MOCK}/b`, ...m, value: 'v-bad' });
    check(`새 키라도 ${name} → 거부`, r.status === 400, `${r.status} ${JSON.stringify(r.j)}`);
  }
  check('사용자 정의 https + 포트 + 경로 + 새 키 → 허용 (preset 에 묶지 않음)', (await upsert(ADM, { id: 'cust', label: 'Cust', upstream: 'https://api.example.com:8443/v1/', auth: 'x-api-key', envKey: 'CUST_KEY', value: 'v-cust' })).status === 200);
  check('upstream 은 정규형으로 저장', (await prov('cust'))?.upstream === 'https://api.example.com:8443/v1');
  const or = await upsert(ADM, { preset: 'openrouter', value: 'or-mgmt-dummy' });
  check('openrouter 틀 + 합성 관리 키 (네트워크 없음)', or.status === 200 && or.j.provider.upstream === 'https://openrouter.ai');
  check('openrouter: 키 없이 kind → proxy 거부 (관리 키가 프록시로 새는 것)', (await upsert(ADM, { id: 'openrouter', kind: 'proxy' })).status === 400);
  check('openrouter: 키 없이 lookalike upstream 거부', (await upsert(ADM, { id: 'openrouter', upstream: 'https://openrouter.ai.evil.com' })).status === 400);
  check('openrouter: 키 없이 이름 수정 허용', (await upsert(ADM, { id: 'openrouter', label: 'OR' })).status === 200);
  const ls = await upsert(ADM, { preset: 'langsmith', value: 'ls-dummy', headers: 'X-Tenant-Id: ws-a' });
  check('LangSmith: tenant 를 주면 workspace 조회 없이 저장', ls.status === 200);
  const ls2 = await upsert(ADM, { id: 'langsmith', headers: 'X-Tenant-Id: ws-b' });
  check('LangSmith: 키 없이 X-Tenant-Id 수정 허용', ls2.status === 200 && ls2.j.provider.headers?.['x-tenant-id'] === 'ws-b', JSON.stringify(ls2.j));

  // 저장소에 남은 예전(검증 전) 기록도 sink 에서 막는다
  const legacyOr = { id: 'legacyor', label: 'L', kind: 'openrouter-mint', upstream: 'https://openrouter.ai.evil.com', auth: 'bearer', envKey: 'LOR_KEY', updatedAt: Date.now(), gen: 'g-legacyor', ...(await seal('legacyor', 'mgmt-legacy-SECRET')) };
  await fx('fxPut', { 'prov:legacyor': legacyOr });
  const bl = await borrow(KEY, ['legacyor']);
  const ob = await fx('fxOutbound');
  check('예전 lookalike 서브키 발급형 기록: 발급 거부, 관리 키가 밖으로 안 나감', typeof bl === 'object' && !ob.some((x) => x.url.includes('evil') || x.auth.includes('mgmt-legacy-SECRET')), JSON.stringify({ bl, ob }));
  const legacyPx = { id: 'legacypx', label: 'P', kind: 'proxy', upstream: 'https://u:p@evil.example', auth: 'bearer', envKey: 'LPX_KEY', updatedAt: Date.now(), gen: 'g-legacypx', ...(await seal('legacypx', 'px-legacy-SECRET')) };
  await fx('fxPut', { 'prov:legacypx': legacyPx });
  const TL = await seedSession('s2legacy', { providers: ['legacypx'], gens: { legacypx: 'g-legacypx' } });
  const lp = await proxy(TL, 'legacypx');
  const ob2 = await fx('fxOutbound');
  check('예전 userinfo upstream 기록: 프록시 거부, 키 안 나감', lp.status === 503 && !ob2.some((x) => x.auth.includes('px-legacy-SECRET')), JSON.stringify({ lp, ob2 }));
  await fx('fxDelete', ['prov:legacyor', 'prov:legacypx']);
}

// ── #6 지우고 다시 만든 공급자 ───────────────────────────────
let T6 = null;
if (ONLY.has('6')) {
  section = '#6';
  const KA1 = 'k6a1-' + randomBytes(4).toString('hex'), KA2 = 'k6a2-' + randomBytes(4).toString('hex'), KB = 'k6b-' + randomBytes(4).toString('hex');
  const def = (id) => ({ id, label: id, upstream: `${MOCK}/${id}`, auth: 'bearer', envKey: `${id.toUpperCase()}_KEY` });
  await upsert(ADM, { ...def('g6a'), value: KA1 });
  await upsert(ADM, { ...def('g6b'), value: KB });
  const T1 = await borrow(KEY, ['g6a', 'g6b']);
  check('승인: 두 공급자', typeof T1 === 'string', JSON.stringify(T1));
  await proxy(T1, 'g6a', 'x');
  check('처음 키로 동작', hitsUnder('/g6a/').at(-1)?.auth === `Bearer ${KA1}`);
  check('공급자 지우기', (await call('/api/admin/provider-delete', { id: 'g6a' }, ADM)).status === 200);
  check('지운 뒤 예전 토큰 → 404', (await proxy(T1, 'g6a')).status === 404);
  await upsert(ADM, { ...def('g6a'), value: KA2 });
  const n = hitsUnder('/g6a/').length;
  const old = await proxy(T1, 'g6a');
  check('같은 id 로 다시 만들어도 예전 토큰 → 거부, upstream 안 부름', old.status === 403 && hitsUnder('/g6a/').length === n && !old.text.includes(KA2), `${old.status} ${old.text}`);
  const st = await proxy(T1, 'g6b', 'y');
  check('같은 세션의 다른 공급자는 계속 동작', st.status === 200 && hitsUnder('/g6b/').at(-1)?.auth === `Bearer ${KB}`);
  const T2 = await borrow(KEY, ['g6a']);
  await proxy(T2, 'g6a', 'z');
  check('새로 승인한 토큰은 새 키로 동작', hitsUnder('/g6a/').at(-1)?.auth === `Bearer ${KA2}`);
  const KB2 = 'k6b2-' + randomBytes(4).toString('hex');
  await upsert(ADM, { id: 'g6b', value: KB2 });
  await proxy(T1, 'g6b', 'w');
  check('같은 목적지 키 교체(kv.ps1 push)는 기존 승인 유지', hitsUnder('/g6b/').at(-1)?.auth === `Bearer ${KB2}`);
  T6 = { T1, T2, gen: (await prov('g6a'))?.gen };

  // 서브키 정리 권한: 지운(세대가 바뀐) OpenRouter 관리 키로 그 세대 서브키를 지운다 — 바깥 호출은 fixture 가 막고 기록만
  await upsert(ADM, { preset: 'openrouter', value: 'or-mgmt-OLD' });
  const orGen = (await prov('openrouter'))?.gen;
  const TO = await seedSession('s6or', { providers: ['openrouter'], orProvider: 'openrouter', orKey: 'sk-or-sub-dummy', orKeyHash: 'hash6or', budget: 1, gens: { openrouter: orGen } });
  check('openrouter 지우기', (await call('/api/admin/provider-delete', { id: 'openrouter' }, ADM)).status === 200);
  check('살아 있는 서브키가 있으면 관리 키 암호문을 남김', !!(await fx('fxGet', [`provgone:openrouter:${orGen}`]))[`provgone:openrouter:${orGen}`]);
  await upsert(ADM, { preset: 'openrouter', value: 'or-mgmt-NEW' });
  check('다시 만든 openrouter 로 예전 서브키 세션 → 거부', (await proxy(TO, 'openrouter', 'api/v1/key')).status === 403);
  await fetch(`${GW}/api/end`, { method: 'POST', headers: { authorization: `Bearer ${TO}` } });
  const del = (await fx('fxOutbound')).filter((x) => x.method === 'DELETE' && x.url.includes('hash6or'));
  check('세션 끝: 예전 관리 키로 그 서브키 삭제 시도 (openrouter.ai 로만)', del.length >= 1 && del.every((x) => x.url === 'https://openrouter.ai/api/v1/keys/hash6or' && x.auth === 'Bearer or-mgmt-OLD'), JSON.stringify(del));
  await call('/api/admin/provider-delete', { id: 'openrouter' }, ADM);

  // gen 이전 기록 옮기기: 정상 예전 세션은 유지, 세션 뒤에 다시 만들어진 공급자 승인은 옮기지 않음
  const KM = 'k6m-' + randomBytes(4).toString('hex');
  const t0 = Date.now();
  await fx('fxPut', { 'prov:m6': { id: 'm6', label: 'm6', kind: 'proxy', upstream: `${MOCK}/m6`, auth: 'bearer', envKey: 'M6_KEY', updatedAt: t0 - 200e3, ...(await seal('m6', KM)) } });
  const TLok = await seedSession('s6old', { providers: ['m6'], createdAt: t0 - 1000 });
  const TLbad = await seedSession('s6stale', { providers: ['m6'], createdAt: t0 - 100e3 });
  // 감사 기록이 꽉 차(100개) 세션 무렵의 provider-add 가 빠진 경우: 세션 뒤에 다시 만든 m6t (updatedAt 이 세션 뒤) — 옛 코드는 gen 을 줬다
  const KT = 'k6t-' + randomBytes(4).toString('hex'), KV = 'k6v-' + randomBytes(4).toString('hex'), KR = 'k6r-' + randomBytes(4).toString('hex');
  const legacy = async (id, updatedAt, k) => ({ [`prov:${id}`]: { id, label: id, kind: 'proxy', upstream: `${MOCK}/${id}`, auth: 'bearer', envKey: `${id.toUpperCase()}_KEY`, updatedAt, ...(await seal(id, k)) } });
  await fx('fxPut', { ...(await legacy('m6t', t0 - 10e3, KT)), ...(await legacy('m6v', t0 - 300e3, KV)), ...(await legacy('m6r', t0 - 20e3, KR)) });
  const TLtrunc = await seedSession('s6trunc', { providers: ['m6t'], createdAt: t0 - 100e3 });
  const TLvalid = await seedSession('s6valid', { providers: ['m6v'], createdAt: t0 - 100e3 });
  const TLrot = await seedSession('s6rot', { providers: ['m6r'], createdAt: t0 - 100e3 });
  const audit = [
    { t: t0 - 20e3, event: 'provider-update', sid: null, ip: null, detail: 'm6r' },
    { t: t0 - 50e3, event: 'provider-add', sid: null, ip: null, detail: 'm6' },
    ...Array.from({ length: 98 }, (_, i) => ({ t: t0 - 60e3 - i, event: 'approve', sid: 'x', ip: 'x', detail: 'filler' })),
  ];
  check('감사 기록 100개 (가장 오래된 것도 세션보다 뒤 — m6t 의 add 는 빠짐)', audit.length === 100 && Math.min(...audit.map((e) => e.t)) > t0 - 100e3 && !audit.some((e) => e.detail === 'm6t'));
  await fx('fxPut', { audit });
  await fx('fxDelete', ['mig:grants']);
  Object.assign(T6, { TLok, TLbad, KM, TLtrunc, TLvalid, TLrot, KV });

  // 수정 ↔ 지우기 경쟁: 수정이 LangSmith workspace 조회(fixture 가 막고 hold 로 붙잡음)를 기다리는 동안 지우고 다시 만든다
  const LS = { id: 'ls6', label: 'LS6', upstream: 'https://api.smith.langchain.com', auth: 'x-api-key', envKey: 'LS6_KEY' };
  const LK = (n) => `ls6-k${n}-` + randomBytes(3).toString('hex');
  const K1 = LK(1), K2 = LK(2), K3 = LK(3), K4 = LK(4), K5 = LK(5);
  check('ls6 만들기 (workspace 조회는 fixture 가 막음)', (await upsert(ADM, { ...LS, value: K1 })).status === 200);
  const g1 = (await prov('ls6'))?.gen;
  const TS1 = await borrow(KEY, ['ls6']);
  const held = async (body, interleave) => {
    await fx('fxHoldSet', 'api.smith.langchain.com/api/v1/workspaces', 1, 15000);
    const pending = upsert(ADM, body);
    for (let i = 0; i < 200 && (await fx('fxHoldInfo')).arrived < 1; i++) await sleep(25);
    const arrived = (await fx('fxHoldInfo')).arrived;
    await interleave();
    await fx('fxHoldRelease');
    return { r: await pending, arrived };
  };
  const outTo = (k) => (o) => o.url === 'https://api.smith.langchain.com/x' && o.auth === k;
  {
    const { r, arrived } = await held({ id: 'ls6', value: K2 }, async () => {
      check('끼어든 지우기', (await call('/api/admin/provider-delete', { id: 'ls6' }, ADM)).status === 200);
      check('끼어든 다시 만들기', (await upsert(ADM, { ...LS, value: K3 })).status === 200);
    });
    const p = await prov('ls6');
    check('수정이 workspace 조회에서 멈춰 있었음 (barrier)', arrived === 1);
    check('지우고 다시 만든 뒤 늦은 수정 → 409', r.status === 409, `${r.status} ${JSON.stringify(r.j)}`);
    check('저장된 것은 다시 만든 공급자 (새 gen, 새 키)', !!p && p.gen !== g1 && p.last4 === K3.slice(-4), JSON.stringify(p && { gen: p.gen, g1, last4: p.last4 }));
    const n = (await fx('fxOutbound')).length;
    check('예전 세대 토큰 → 403, 바깥 호출 없음', (await proxy(TS1, 'ls6')).status === 403 && (await fx('fxOutbound')).length === n);
    const TS3 = await borrow(KEY, ['ls6']);
    check('다시 만든 공급자 새 승인', typeof TS3 === 'string', JSON.stringify(TS3));
    await proxy(TS3, 'ls6', 'x');
    check('새 승인은 새 키로 (fixture 가 막은 바깥 호출 기록)', (await fx('fxOutbound')).some(outTo(K3)));
    const g3 = (await prov('ls6'))?.gen;
    check('경쟁 없는 같은 목적지 키 교체 → 허용, gen 유지', (await upsert(ADM, { id: 'ls6', value: K5 })).status === 200 && (await prov('ls6'))?.gen === g3);
    check('경쟁 없는 이름 수정 → 허용', (await upsert(ADM, { id: 'ls6', label: 'LS6b' })).status === 200 && (await prov('ls6'))?.label === 'LS6b');
    await proxy(TS3, 'ls6', 'x');
    check('키 교체 뒤 기존 승인이 새 키로', (await fx('fxOutbound')).some(outTo(K5)));
    T6.TS3 = TS3;
  }
  {
    const { r, arrived } = await held({ id: 'ls6', value: K4 }, async () => {
      check('끼어든 지우기 (다시 만들지 않음)', (await call('/api/admin/provider-delete', { id: 'ls6' }, ADM)).status === 200);
    });
    check('지운 뒤 늦은 수정 → 409, 공급자가 되살아나지 않음', arrived === 1 && r.status === 409 && !(await prov('ls6')), `${arrived} ${r.status}`);
    check('지운 공급자 토큰 → 404', (await proxy(T6.TS3, 'ls6')).status === 404);
  }
}

// 승인: 같은 탭 응답(assertion)으로 choice 를 바꿔 여러 번 보낼 수 있게 나눈다
async function approveReq(key) {
  const r = (await call('/api/borrow', {})).j;
  const o = (await call(`/api/approve/${r.id}/options`, {})).j;
  return { r, assertion: key.get(o) };
}
async function approveWith({ r, assertion }, choice) {
  const a = await call(`/api/approve/${r.id}`, { assertion, choice: { ttlHours: 1, budget: 1, ...choice } });
  if (a.status !== 200) return a;
  const p = (await call(`/api/borrow/${r.id}/poll`, { secret: r.secret })).j;
  return { status: 200, j: a.j, token: p.token, poll: p };
}
const T4 = {};

// ── #4 Daytona 조직·계정 관리 API ───────────────────────
if (ONLY.has('4')) {
  section = '#4';
  const KD = 'k4d-' + randomBytes(6).toString('hex'), KC = 'k4c-' + randomBytes(6).toString('hex');
  check('daytona (preset id, 가짜 upstream)', (await upsert(ADM, { preset: 'daytona', upstream: `${MOCK}/dt`, value: KD })).status === 200);
  check('직접 입력한 Daytona 정의 (호스트로 알아봄, 바깥 호출은 fixture 가 막음)', (await upsert(ADM, { id: 'dtc', label: 'DTC', upstream: 'https://app.daytona.io/api', auth: 'bearer', envKey: 'DTC_KEY', value: KC })).status === 200);
  check('Daytona 아닌 공급자', (await upsert(ADM, { id: 'g4', label: 'G4', upstream: `${MOCK}/g4`, auth: 'bearer', envKey: 'G4_KEY', value: 'k4g' })).status === 200);
  const info = (await call(`/api/approve/${(await call('/api/borrow', {})).j.id}`)).j;
  check('요청 정보: Daytona 표시·상한 최대값', info.providers.find((p) => p.id === 'daytona')?.daytona === true && info.providers.find((p) => p.id === 'dtc')?.daytona === true
    && info.providers.find((p) => p.id === 'g4')?.daytona === false && JSON.stringify(info.limitMax) === '{"total":10000,"perMinute":300,"concurrent":10}', JSON.stringify(info));

  // 틀린 manage 는 탭 의식을 쓰지 않고 400 — 같은 응답으로 바로 다시 승인된다
  const A = await approveReq(KEY);
  for (const [name, m] of [['문자열', 'true'], ['숫자', 1], ['null', null], ['배열', [true]], ['객체', {}]]) {
    const x = await approveWith(A, { providers: ['daytona', 'dtc', 'g4'], manage: m });
    check(`manage ${name} → 400`, x.status === 400, `${x.status} ${JSON.stringify(x.j)}`);
  }
  check('Daytona 없이 manage:true → 400', (await approveWith(A, { providers: ['g4'], manage: true })).status === 400);
  const plain = await approveWith(A, { providers: ['daytona', 'dtc', 'g4'] });
  check('그 뒤 같은 탭 응답으로 승인 통과 (의식 안 씀), 새 항목 없음 = 관리 없음·기본 상한', plain.status === 200 && plain.j.manage.length === 0 && plain.j.limits.total === 10000
    && plain.poll.manage.length === 0 && plain.poll.limits.concurrent === 10, JSON.stringify(plain.j));
  const T = plain.token;
  const sid = plain.poll.sessionId;

  const prot = [
    'organizations', 'api-keys', 'users', 'users/me', 'organizations/o1/users/u1', 'api-keys/current', 'organizations?x=1',
    'ORGANIZATIONS', 'Api-Keys', 'uSeRs', 'organizations;x=1', 'api-keys;jsessionid=1/current', 'organizations/', 'organizations.json',
    '%6Frganizations', '%256Frganizations', '%25256Frganizations', 'api%2Dkeys', 'api%252Dkeys', '%55SERS',
    './organizations', 'sandbox/../organizations', 'sandbox/./../api-keys', '/organizations', '//users', 'api/organizations', 'v1/users',
    'organizations%3Bx', 'organizations%253Bx', 'organizations%00',
    // 다른 루트 아래 조직 단위 관리 (공식 OpenAPI: /audit/organizations/{id}, /webhooks/organizations/{id}/…)
    'audit/organizations/o1', 'audit/organizations/o1?page=2', 'AUDIT/Organizations/o1', 'Audit;x=1/organizations;y/o1', 'audit/%256Frganizations/o1',
    '%2561udit/organizations/o1', 'audit/./organizations/o1', 'sandbox/../audit/organizations/o1', 'api/v1/audit/organizations/o1', 'audit//organizations/o1',
    'audit.json/organizations/o1', 'audit/organizations.json',
    'webhooks/organizations/o1/app-portal-access', 'webhooks/organizations/o1/initialization-status', 'webhooks/organizations/o1/initialize',
    'webhooks/organizations/o1/refresh-endpoints', 'WEBHOOKS/ORGANIZATIONS/o1/initialize', 'Webhooks;v=2/Organizations/o1/refresh-endpoints',
    '%2577ebhooks/organizations/o1/initialize', 'webhooks/%25256Frganizations/o1/initialize', 'snapshots/../webhooks/organizations/o1/app-portal-access',
  ];
  const encDot = ['%2e/organizations', '%2E%2E/organizations', 'sandbox/%2e%2e/organizations', '%252e%252e/api-keys', 'sandbox%2f..%2forganizations'];
  await fx('fxBarrierSet', 'daytona', 1000, 1); // decrypt 도달 수만 센다
  const n0 = hitsUnder('/dt/').length, u0 = (await sessOf(sid)).uses;
  for (const p of prot) {
    const r = await rawProxy(T, 'daytona', p);
    check(`보통 토큰: ${p} → 403`, r.status === 403, `${r.status} ${r.text}`);
  }
  for (const p of encDot) {
    const r = await rawProxy(T, 'daytona', p);
    check(`보통 토큰: ${p} → 거부 (인코딩한 점·슬래시: 런타임이 풀면 404, 아니면 bad path 400)`, [400, 403, 404].includes(r.status), `${r.status} ${r.text}`);
  }
  const bi = await fx('fxBarrierInfo');
  await fx('fxBarrierSet', null);
  const s4 = await sessOf(sid);
  check('막힌 관리 호출: upstream 없음, decrypt 없음, 예약 없음', hitsUnder('/dt/').length === n0 && bi.arrived === 0 && s4.uses === u0 && Object.keys(s4.leases ?? {}).length === 0,
    `${hitsUnder('/dt/').length - n0} ${bi.arrived} ${s4.uses - u0}`);
  const ok = ['sandbox', 'sandbox?labels=%7B%22a%22%3A1%7D', 'sandbox/sb1', 'sandbox/sb1/ports/8080/preview-url', 'snapshots', 'snapshots?page=2',
    'toolbox/sb1/toolbox/files?path=/home/daytona/users', 'sandbox/organizations-x', 'sandbox/sb1/users', 'volumes', 'regions', 'preview/sb1/8080',
    'sandbox/audit/organizations', 'snapshots/webhooks/organizations'];
  for (const p of ok) {
    const n = hitsUnder('/dt/').length;
    const r = await proxy(T, 'daytona', p);
    check(`보통 토큰: 데이터 경로 ${p} → 200`, r.status === 200 && hitsUnder('/dt/').length === n + 1 && hitsUnder('/dt/').at(-1).auth === `Bearer ${KD}`, `${r.status} ${r.text}`);
  }
  const ob0 = (await fx('fxOutbound')).length;
  for (const p of ['organizations', 'API-KEYS', '%2575sers', 'sandbox/../organizations', 'audit/organizations/o1', 'Webhooks/ORGANIZATIONS/o1/initialize', 'audit/%256Frganizations/o1'])
    check(`직접 정의 Daytona: ${p} → 403`, (await rawProxy(T, 'dtc', p)).status === 403);
  check('직접 정의 Daytona: 바깥 호출 없음', (await fx('fxOutbound')).length === ob0);
  await proxy(T, 'dtc', 'sandbox?x=1');
  check('직접 정의 Daytona: 데이터 경로는 그 upstream 으로 (fixture 가 막음)', (await fx('fxOutbound')).slice(ob0).some((o) => o.url === 'https://app.daytona.io/api/sandbox?x=1' && o.auth === `Bearer ${KC}`));
  for (const p of ['organizations', 'users', 'api-keys']) {
    const n = hitsUnder('/g4/').length;
    check(`Daytona 아닌 공급자: ${p} → 200`, (await proxy(T, 'g4', p)).status === 200 && hitsUnder('/g4/').length === n + 1);
  }

  const B = await approveReq(KEY);
  const mg = await approveWith(B, { providers: ['daytona', 'dtc'], manage: true });
  check('관리 API 허용 승인: 응답·전달에 허용 표시', mg.status === 200 && mg.j.manage.join() === 'daytona,dtc' && mg.poll.manage.join() === 'daytona,dtc', JSON.stringify(mg.j));
  for (const p of ['organizations', 'api-keys/current', 'USERS/me', '%256Frganizations']) {
    const n = hitsUnder('/dt/').length;
    const r = await proxy(mg.token, 'daytona', p);
    check(`관리 허용 토큰: ${p} → 200`, r.status === 200 && hitsUnder('/dt/').length === n + 1, `${r.status} ${r.text}`);
  }
  const ob1 = (await fx('fxOutbound')).length;
  await proxy(mg.token, 'dtc', 'organizations');
  check('관리 허용 토큰: 직접 정의 Daytona 관리 경로도 나감', (await fx('fxOutbound')).slice(ob1).some((o) => o.url === 'https://app.daytona.io/api/organizations'));
  const adl = (await call('/api/admin/list', {}, ADM)).j;
  const row = adl.sessions.find((x) => x.id === mg.poll.sessionId), row0 = adl.sessions.find((x) => x.id === sid);
  check('관리 목록: 관리 허용·상한·진행 중 표시, lease·호출 시각·토큰 없음', row?.manage.join() === 'daytona,dtc' && row0?.manage.length === 0 && row?.limits.total === 10000
    && typeof row?.inflight === 'number' && typeof row?.lastMinute === 'number' && !('leases' in row) && !('calls' in row) && !('tokenHash' in row) && !JSON.stringify(adl).includes(mg.token), JSON.stringify(row));

  // 예전 세션 (새 항목 없음): 관리 API 거부, 데이터 경로 동작, 첫 호출 때 기본 상한
  const gd = (await prov('daytona')).gen;
  const TL = await seedSession('s4old', { providers: ['daytona'], gens: { daytona: gd }, uses: 7 });
  check('예전 세션: 관리 경로 → 403', (await proxy(TL, 'daytona', 'organizations')).status === 403);
  check('예전 세션: 데이터 경로 → 200', (await proxy(TL, 'daytona', 'sandbox')).status === 200);
  const so = await sessOf('s4old');
  check('예전 세션: 기본 상한을 받고 예전 호출 수에 이어 셈', JSON.stringify(so.limits) === '{"total":10000,"perMinute":300,"concurrent":10}' && so.uses === 8, JSON.stringify(so));

  // 지우고 다시 만든 Daytona 에는 관리 허용이 되살아나지 않는다
  await call('/api/admin/provider-delete', { id: 'dtc' }, ADM);
  await upsert(ADM, { id: 'dtc', label: 'DTC', upstream: 'https://app.daytona.io/api', auth: 'bearer', envKey: 'DTC_KEY', value: KC });
  check('다시 만든 Daytona: 예전 관리 허용 토큰 → 403 (세대)', (await proxy(mg.token, 'dtc', 'organizations')).status === 403);

  // R3: upstream(base) 을 관리 루트 아래로 잡은 직접 정의 — 떼어 낸 나머지만 보면 그 아래 모든 경로가 관리 API 가 아닌 것처럼 보였다
  const KS = 'k4c-s-' + randomBytes(4).toString('hex');
  for (const up of ['https://app.daytona.io/api/organizations', 'https://app.daytona.io/api/Organizations', 'https://app.daytona.io/api/users', 'https://app.daytona.io/api/api-keys',
    'https://app.daytona.io/api/audit/organizations', 'https://app.daytona.io/api/webhooks/organizations', 'https://app.daytona.io/api/v1/organizations/o1',
    'https://app.daytona.io/organizations', 'https://app.daytona.io/api/webhooks/organizations/o1']) {
    const r = await upsert(ADM, { id: 'dtroot', label: 'R', upstream: up, auth: 'bearer', envKey: 'DTR_KEY', value: KS });
    check(`Daytona upstream 을 관리 루트로: ${up.slice('https://app.daytona.io'.length)} → 400`, r.status === 400 && !(await prov('dtroot')), `${r.status} ${JSON.stringify(r.j)}`);
  }
  check('env 이름으로 알아본 Daytona (다른 호스트) 도 관리 루트 base 거부', (await upsert(ADM, { id: 'dtroot', label: 'R', upstream: `${MOCK}/api/organizations`, auth: 'bearer', envKey: 'DAYTONA_API_KEY', value: KS })).status === 400);
  check('Daytona 아닌 공급자는 …/organizations base 허용', (await upsert(ADM, { id: 'g4o', label: 'G4O', upstream: `${MOCK}/api/organizations`, auth: 'bearer', envKey: 'G4O_KEY', value: 'k4go' })).status === 200);
  check('Daytona 보통 base …/api/sandbox 는 허용', (await upsert(ADM, { id: 'dts', label: 'DTS', upstream: 'https://app.daytona.io/api/sandbox', auth: 'bearer', envKey: 'DTS_KEY', value: KS })).status === 200);
  const TS = (await approveWith(await approveReq(KEY), { providers: ['dts', 'g4o'] })).token;
  const obS = (await fx('fxOutbound')).length;
  await proxy(TS, 'dts', 'sb1?verbose=1');
  await proxy(TS, 'dts', '');
  const outS = (await fx('fxOutbound')).slice(obS).map((o) => o.url);
  check('…/api/sandbox base: 자식 경로·base 자체는 그 upstream 으로 (fixture 가 막음)', outS.includes('https://app.daytona.io/api/sandbox/sb1?verbose=1') && outS.includes('https://app.daytona.io/api/sandbox/'), JSON.stringify(outS));
  for (const p of ['%252e%252e/organizations', 'sb1/%252e%252e/%252e%252e/users/me', '%252E%252E/audit/organizations/o1'])
    { const r = await rawProxy(TS, 'dts', p); check(`…/api/sandbox base: 이중 인코딩 .. 로 위로 → ${p} → 거부 (bad path 400 또는 403)`, [400, 403].includes(r.status), `${r.status} ${r.text}`); }
  check('…/api/sandbox base: 바깥 호출 더 없음', (await fx('fxOutbound')).length === obS + 2);
  check('Daytona 아닌 …/organizations base: 자식 경로 200', (await proxy(TS, 'g4o', 'o1/users')).status === 200 && hitsUnder('/api/organizations/o1/users').length === 1);

  // 저장소에 남은 예전 기록 (검사 전에 저장된 관리 루트 base): 최종 경로 전체로 보므로 그 아래 모든 경로가 관리 API
  const KR = 'k4r-' + randomBytes(4).toString('hex');
  await fx('fxPut', { 'prov:dto': { id: 'dto', label: 'DTO', kind: 'proxy', upstream: `${MOCK}/api/organizations`, auth: 'bearer', envKey: 'DAYTONA_API_KEY', updatedAt: Date.now(), gen: 'g-dto1', ...(await seal('dto', KR)) } });
  const TOn = await seedSession('s4dto', { providers: ['dto'], gens: { dto: 'g-dto1' } });
  const TOm = await seedSession('s4dtom', { providers: ['dto'], gens: { dto: 'g-dto1' }, manage: { dto: 'g-dto1' } });
  await fx('fxBarrierSet', 'dto', 1000, 1);
  const hO = hitsUnder('/api/organizations').length;
  for (const p of ['', 'o1', 'o1/users/u1', 'o1/roles', 'x?y=1']) {
    const r = await rawProxy(TOn, 'dto', p);
    check(`예전 관리 루트 base 기록, 보통 토큰: '${p}' → 403`, r.status === 403, `${r.status} ${r.text}`);
  }
  const bO = await fx('fxBarrierInfo');
  await fx('fxBarrierSet', null);
  const sO = await sessOf('s4dto');
  check('예전 관리 루트 base: upstream·decrypt·예약 없음', hitsUnder('/api/organizations').length === hO && bO.arrived === 0 && sO.uses === 0 && !Object.keys(sO.leases ?? {}).length, `${bO.arrived} ${sO.uses}`);
  const rm = await proxy(TOm, 'dto', 'o1/users');
  check('예전 관리 루트 base: 그 세대 관리 허용 토큰 → 200, 원래 키', rm.status === 200 && hitsUnder('/api/organizations/o1/users').at(-1)?.auth === `Bearer ${KR}`, `${rm.status} ${rm.text}`);
  check('지우기', (await call('/api/admin/provider-delete', { id: 'dto' }, ADM)).status === 200);
  check('같은 관리 루트 base 로 다시 만들기 → 400', (await upsert(ADM, { id: 'dto', label: 'DTO', upstream: `${MOCK}/api/organizations`, auth: 'bearer', envKey: 'DAYTONA_API_KEY', value: KR })).status === 400 && !(await prov('dto')));
  check('보통 base 로 다시 만들기 → 200, 새 세대', (await upsert(ADM, { id: 'dto', label: 'DTO', upstream: `${MOCK}/api`, auth: 'bearer', envKey: 'DAYTONA_API_KEY', value: KR })).status === 200 && (await prov('dto'))?.gen !== 'g-dto1');
  const hO2 = hitsUnder('/api/').length;
  check('다시 만든 뒤: 예전 관리 허용 토큰 → 403 (세대), upstream 없음', (await proxy(TOm, 'dto', 'organizations/o1/users')).status === 403 && hitsUnder('/api/').length === hO2);
  const TOf = (await approveWith(await approveReq(KEY), { providers: ['dto'] })).token;
  check('다시 만든 뒤 새 보통 토큰: organizations → 403, sandbox → 200', (await proxy(TOf, 'dto', 'organizations/o1')).status === 403 && (await proxy(TOf, 'dto', 'sandbox')).status === 200 && hitsUnder('/api/').length === hO2 + 1);
  Object.assign(T4, { mgToken: mg.token, T });
}

// ── #13 세션 호출 상한 (총·분당·동시) ─────────────────────
if (ONLY.has('13')) {
  section = '#13';
  check('공급자 b13', (await upsert(ADM, { id: 'b13', label: 'B13', upstream: `${MOCK}/b13`, auth: 'bearer', envKey: 'B13_KEY', value: 'k13' })).status === 200);
  const g13 = (await prov('b13')).gen;
  const seat = (sid, extra = {}) => seedSession(sid, { providers: ['b13'], gens: { b13: g13 }, ...extra });

  // 틀린 limits 는 탭 의식을 쓰지 않고 400
  const A = await approveReq(KEY);
  const badL = [
    ['문자열', { total: '5' }], ['불리언', { perMinute: true }], ['배열', [1]], ['null', null], ['배열 값', { concurrent: [2] }], ['null 값', { total: null }],
    ['0', { total: 0 }], ['음수', { perMinute: -1 }], ['소수', { concurrent: 1.5 }], ['총 10001', { total: 10001 }], ['분당 301', { perMinute: 301 }],
    ['동시 11', { concurrent: 11 }], ['모르는 항목', { burst: 5 }], ['문자열 전체', '10'], ['NaN 문자열', { total: 'NaN' }],
  ];
  for (const [name, l] of badL) {
    const x = await approveWith(A, { providers: ['b13'], limits: l });
    check(`limits ${name} → 400`, x.status === 400, `${x.status} ${JSON.stringify(x.j)}`);
  }
  const low = await approveWith(A, { providers: ['b13'], limits: { total: 3, perMinute: 2, concurrent: 1 } });
  check('그 뒤 같은 탭 응답으로 낮춘 상한 승인 통과', low.status === 200 && JSON.stringify(low.j.limits) === '{"total":3,"perMinute":2,"concurrent":1}', JSON.stringify(low.j));
  const B = await approveReq(KEY);
  const part = await approveWith(B, { providers: ['b13'], limits: { perMinute: 7 } });
  check('일부만 주면 나머지는 기본값', part.status === 200 && JSON.stringify(part.j.limits) === '{"total":10000,"perMinute":7,"concurrent":10}', JSON.stringify(part.j));
  check('낮춘 상한이 세션에 저장', JSON.stringify((await sessOf(low.poll.sessionId)).limits) === '{"total":3,"perMinute":2,"concurrent":1}');
  check('분당 2: 두 번 200, 셋째 429', (await proxy(low.token, 'b13', 'a')).status === 200 && (await proxy(low.token, 'b13', 'b')).status === 200 && (await proxy(low.token, 'b13', 'c')).status === 429);

  // 총 상한 경쟁: 남은 1회에 동시 5개 → upstream 한 번
  const TT = await seat('s13tot', { uses: 9999 });
  let n = hitsUnder('/b13/tot').length;
  const rt = await Promise.all(Array.from({ length: 5 }, () => proxy(TT, 'b13', 'tot')));
  check('총 상한 남은 1회 + 동시 5 → 200 하나, 429 넷', rt.filter((r) => r.status === 200).length === 1 && rt.filter((r) => r.status === 429).length === 4, rt.map((r) => r.status).join());
  check('총 상한: upstream 한 번, uses 10000', hitsUnder('/b13/tot').length - n === 1 && (await sessOf('s13tot')).uses === 10000);

  // 분당 상한 경쟁: 최근 1분 299회 + 동시 5 → 하나
  const t = Date.now();
  const TR = await seat('s13rate', { calls: Array.from({ length: 299 }, () => t - 1000) });
  n = hitsUnder('/b13/rate').length;
  const rr = await Promise.all(Array.from({ length: 5 }, () => proxy(TR, 'b13', 'rate')));
  check('분당 299 + 동시 5 → 200 하나', rr.filter((r) => r.status === 200).length === 1 && hitsUnder('/b13/rate').length - n === 1, rr.map((r) => r.status).join());
  await fx('fxPut', { 'sess:s13rate': { ...(await sessOf('s13rate')), calls: Array.from({ length: 300 }, () => Date.now() - 61e3) } });
  check('61초 지난 호출은 분당에서 빠짐 → 200', (await proxy(TR, 'b13', 'rate')).status === 200);
  check('분당 기록은 1분 안의 것만 남음', (await sessOf('s13rate')).calls.length === 1);

  // 동시 상한: 열린 응답 10개가 자리를 잡는다. lease 수명을 짧게(fixture) 해서 수명 여러 번이 지나도 늘리기로 자리가 유지되는지 본다
  const TTL = 2000; // 배포는 15분. 프록시는 1/3 마다 늘린다
  await fx('fxLeaseTtl', TTL);
  const TC = await seat('s13conc');
  holds.length = 0;
  // 받는 쪽: 응답 머리를 받으면 돌려주고, 본문은 계속 읽는다 (end = 본문 끝). 끊기 = 소켓을 닫는다
  const holdOpen = (p, tok = TC) => new Promise((resolve, reject) => {
    const rq = http.request({ host: '127.0.0.1', port: PORT, path: `/p/b13/${p}`, agent: false, headers: { authorization: `Bearer ${tok}` } }, (r) => {
      const end = new Promise((ok) => { r.on('end', ok); r.on('close', ok); r.on('error', ok); });
      r.on('data', () => {});
      resolve({ status: r.statusCode, end, abort: () => rq.destroy() });
    });
    rq.on('error', () => {});
    rq.end();
    setTimeout(() => reject(new Error('hold timeout')), 10000);
  });
  const waitHold = async (p) => { for (let i = 0; i < 100 && !holdBy[`/b13/${p}`]; i++) await sleep(50); return holdBy[`/b13/${p}`]; };
  const open = [];
  for (let i = 0; i < 9; i++) open.push(await holdOpen(`hold${i}`));
  // 10번째는 fixture 가 이 Worker 안에서 진짜 프록시 응답을 읽다가 flag 가 켜지면 본문을 cancel 한다 (배포의 받는 쪽 끊김 길)
  await fx('fxFlagSet', 'cancel13', false);
  const fxCancel = fetch(`${GW}/__fxw/cancel`, { method: 'POST', body: JSON.stringify({ path: 'b13/hold9', token: TC, flag: 'cancel13', timeout: 60000 }) }).then((r) => r.json());
  await waitHold('hold9');
  for (let i = 0; i < 50 && holds.length < 10; i++) await sleep(50);
  check('열린 스트리밍 응답 10개 → 모두 200', open.every((r) => r.status === 200) && holds.length === 10, open.map((r) => r.status).join());
  const sessC = async () => (await sessOf('s13conc')).leases ?? {};
  const inflight = async () => Object.keys(await sessC()).length;
  const liveNow = async () => Object.values(await sessC()).filter((l) => l.exp > Date.now()).length;
  check('진행 중 10', (await inflight()) === 10);
  const n11 = hitsUnder('/b13/').length;
  const r11 = await proxy(TC, 'b13', 'x11');
  check('11번째 → 429, upstream 없음', r11.status === 429 && hitsUnder('/b13/').length === n11, `${r11.status}`);
  const lst = (await call('/api/admin/list', {}, ADM)).j.sessions.find((x) => x.id === 's13conc');
  const leaseIds = Object.keys(await sessC());
  check('관리 목록: 진행 중 10/10, lease id 없음', lst?.inflight === 10 && lst?.limits.concurrent === 10 && !('leases' in lst) && !leaseIds.some((k) => JSON.stringify(lst).includes(k)), JSON.stringify(lst));
  // 수명 3번 넘게 기다린다 — 늘리기가 없으면(고치기 전) 자리가 비어 11번째가 들어간다
  await sleep(TTL * 3 + 500);
  const live10 = await liveNow();
  const n11b = hitsUnder('/b13/').length;
  const r11b = await proxy(TC, 'b13', 'x11b');
  const rl = await fx('fxRenewLog', 's13conc');
  check(`수명(${TTL}ms) 3번 지난 뒤에도 살아 있는 자리 10, 11번째 여전히 429`, live10 === 10 && r11b.status === 429 && hitsUnder('/b13/').length === n11b, `live ${live10} · ${r11b.status}`);
  check('늘리기가 돌았고 모두 성공', rl.length >= 10 * 3 && rl.every((x) => x.ok), `${rl.length} ${rl.filter((x) => !x.ok).length}`);
  check('스트림은 그대로 열려 있음 (upstream 연결 안 닫힘)', holds.every((h) => !h.writableEnded && !h.destroyed));
  // 하나는 upstream 이 끝내고(정상 완료), 하나는 upstream 이 중간에 끊고(본문 오류), 하나는 받는 쪽이 끊는다(fixture cancel), 하나는 클라이언트 소켓을 닫는다
  const waitLeft = async (want) => { let left = 0; for (let i = 0; i < 60; i++) { left = await inflight(); if (left <= want) break; await sleep(100); } return left; };
  holdBy['/b13/hold0'].end('data: end\n\n');
  await open[0].end;
  check('upstream 완료 → 자리 하나 풀림 (9)', (await waitLeft(9)) === 9);
  check('완료 뒤 빈 자리로 새 호출 → 200 (곧 끝남)', (await proxy(TC, 'b13', 'after-done')).status === 200);
  check('끝난 새 호출도 자리를 돌려줌 (9)', (await waitLeft(9)) === 9);
  holdBy['/b13/hold2'].destroy();
  await open[2].end;
  check('upstream 끊김 → 자리 하나 더 풀림 (8)', (await waitLeft(8)) === 8);
  await fx('fxFlagSet', 'cancel13', true);
  const fc = await fxCancel;
  const upCancelled = await Promise.race([holdBy['/b13/hold9'].gone, sleep(3000).then(() => false)]);
  check('받는 쪽 cancel (진짜 프록시 응답 본문): 첫 조각 받은 뒤 cancel', fc.status === 200 && fc.cancelled === true && !!fc.first?.startsWith('data: start'), JSON.stringify(fc));
  check('받는 쪽 cancel → 자리 풀림 (7)', (await waitLeft(7)) === 7);
  check('받는 쪽 cancel → upstream 연결도 끊음', upCancelled === true);
  const upClosed = holdBy['/b13/hold1'].gone;
  open[1].abort();
  const propagated = await Promise.race([upClosed, sleep(3000).then(() => false)]);
  const left = await waitLeft(6);
  if (propagated) check('클라이언트 소켓 끊김 → 자리 풀림', left === 6, String(left));
  else console.log(`  SKIP [#13] 클라이언트 소켓 끊김: 로컬 wrangler dev 가 클라이언트 끊김을 Worker 응답 스트림 취소로 넘기지 않음 (같은 cancel 길은 위 fixture 로 확인) — 진행 중 ${left}`);
  const u1 = (await sessOf('s13conc')).uses;
  check('풀린 자리로 다시 호출 → 200 (끊긴 호출도 센 채)', (await proxy(TC, 'b13', 'again')).status === 200 && u1 === 11, String(u1));
  for (const h of holds) { try { h.end(); } catch {} }
  for (const r of open.slice(3)) await r.end;
  check('모든 응답이 끝나면 진행 중 0', (await waitLeft(0)) === 0);
  // 정산 뒤 늘리기는 멈춘다
  const rc0 = (await fx('fxRenewLog', 's13conc')).length;
  await sleep(TTL * 1.5);
  const rc1 = (await fx('fxRenewLog', 's13conc')).length;
  check('정산 뒤 늘리기 멈춤 (수명 1.5배 동안 늘리기 0)', rc1 === rc0, `${rc0} → ${rc1}`);

  // 늘리기가 '없어졌다' 하면 프록시가 upstream 호출을 끊는다: lease 를 지운 경우, 세션을 끊은 경우
  for (const [name, sid, kill] of [
    ['lease 가 없어짐', 's13gone', async (s) => fx('fxPut', { [`sess:${s}`]: { ...(await sessOf(s)), leases: {} } })],
    ['관리자가 세션을 끊음', 's13rev', async (s) => call('/api/admin/revoke', { target: s }, ADM)],
  ]) {
    const tok = await seat(sid);
    const h = await holdOpen(`hold-gone-${sid}`, tok);
    const up = await waitHold(`hold-gone-${sid}`);
    await kill(sid);
    const cut = await Promise.race([up.gone, sleep(TTL * 2).then(() => false)]);
    const ended = await Promise.race([h.end.then(() => true), sleep(2000).then(() => false)]);
    const log = await fx('fxRenewLog', sid);
    const s = await sessOf(sid);
    check(`${name} → 늘리기 false → upstream 연결 끊고 응답 끝냄`, h.status === 200 && cut === true && ended === true && log.some((x) => !x.ok), `${cut} ${ended} ${JSON.stringify(log)}`);
    check(`${name} → 남은 자리 없음`, !s || Object.keys(s.leases ?? {}).length === 0, JSON.stringify(s?.leases));
  }

  // 죽은 Worker 가 남긴 lease (늘리기가 멈춤): 수명이 지나면 자리가 아니다
  const TK = await seat('s13crash', { limits: { total: 10000, perMinute: 300, concurrent: 1 }, leases: { crashed: { exp: Date.now() + TTL, p: 'b13', counted: false, at: Date.now() } }, uses: 1 });
  check('죽은 Worker 의 살아 있는 lease 가 자리를 잡음 (동시 1) → 429', (await proxy(TK, 'b13', 'crash')).status === 429);
  await sleep(TTL + 300);
  check('수명이 지나면 그 자리 회수 → 200', (await proxy(TK, 'b13', 'crash')).status === 200);
  const sk = await sessOf('s13crash');
  check('죽은 lease 정리, uses 2', !sk.leases?.crashed && sk.uses === 2, JSON.stringify(sk));
  check('지난 lease 늘리기 → false, 되살리지 않음', (await fx('fxRenew', 's13crash', 'crashed')).ok === false && !(await sessOf('s13crash')).leases?.crashed);
  await fx('fxLeaseTtl', null);

  // 죽은 프로세스가 남긴 lease 는 만료되면 자리가 아니다
  const old = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`dead${i}`, { exp: Date.now() - 1, p: 'b13', counted: false, at: Date.now() - 5000 }]));
  const TE = await seat('s13exp', { leases: old, uses: 10 });
  check('만료된 lease 10개 → 새 호출 200', (await proxy(TE, 'b13', 'exp')).status === 200);
  const se = await sessOf('s13exp');
  check('만료 lease 정리, uses 11', !Object.keys(se.leases ?? {}).some((k) => k.startsWith('dead')) && se.uses === 11, JSON.stringify(se.leases));

  // upstream 전 실패는 돌려주고, 키가 간 뒤(500·502)는 센 채로 자리만 푼다
  const good = await prov('b13');
  await fx('fxPut', { 'prov:b13': { ...good, ct: flip(good.ct) } });
  const TF = await seat('s13fail');
  check('복호화 실패 → 503', (await proxy(TF, 'b13', 'f')).status === 503);
  let sf = await sessOf('s13fail');
  check('복호화 실패: 총·분당·자리 다 돌려줌', sf.uses === 0 && (sf.calls ?? []).length === 0 && Object.keys(sf.leases ?? {}).length === 0, JSON.stringify(sf));
  await fx('fxPut', { 'prov:b13': good });
  check('header 로 못 싣는 키 공급자 (요청 만들기 실패)', (await upsert(ADM, { id: 'h13', label: 'H13', upstream: `${MOCK}/h13`, auth: 'bearer', envKey: 'H13_KEY', value: 'bad\nkey' })).status === 200);
  const TH = await seedSession('s13hdr', { providers: ['h13'], gens: { h13: (await prov('h13')).gen } });
  n = hitsUnder('/h13/').length;
  const rh = await proxy(TH, 'h13', 'x');
  sf = await sessOf('s13hdr');
  check('요청 만들기 실패 → 503, upstream 없음, 돌려줌', rh.status === 503 && hitsUnder('/h13/').length === n && sf.uses === 0 && (sf.calls ?? []).length === 0 && Object.keys(sf.leases ?? {}).length === 0, `${rh.status} ${JSON.stringify(sf)}`);
  check('500 → 전달, 센 채, 자리 풀림', (await proxy(TF, 'b13', 'fail500')).status === 500 && (sf = await sessOf('s13fail')).uses === 1 && sf.calls.length === 1 && Object.keys(sf.leases ?? {}).length === 0, JSON.stringify(sf));
  const dead = await freePort();
  await upsert(ADM, { id: 'd13', label: 'D13', upstream: `http://127.0.0.1:${dead}/d13`, auth: 'bearer', envKey: 'D13_KEY', value: 'k13d' });
  const TD = await seedSession('s13dead', { providers: ['d13'], gens: { d13: (await prov('d13')).gen } });
  const r502 = await proxy(TD, 'd13', 'x');
  let sd;
  for (let i = 0; i < 20; i++) { sd = await sessOf('s13dead'); if (!Object.keys(sd.leases ?? {}).length) break; await sleep(100); }
  check('연결 실패 502 → 센 채, 자리 풀림', r502.status === 502 && sd.uses === 1 && Object.keys(sd.leases ?? {}).length === 0, `${r502.status} ${JSON.stringify(sd)}`);

  // 돌려주기·풀기는 한 번만
  const lease = { exp: Date.now() + 60e3, p: 'b13', counted: false, at: 111 };
  await fx('fxPut', { 'sess:s13dbl': { id: 's13dbl', tokenHash: 'x', providers: ['b13'], createdAt: Date.now(), expiresAt: Date.now() + 3600e3, uses: 5, calls: [111, 222], leases: { L1: lease, L2: { ...lease, at: 222 } } } });
  await fx('fxRefund', 's13dbl', 'L1');
  await fx('fxRefund', 's13dbl', 'L1');
  await fx('fxRelease', 's13dbl', 'L1');
  let sb = await sessOf('s13dbl');
  check('같은 lease 두 번 돌려주기 → 한 번만', sb.uses === 4 && sb.calls.join() === '222' && !sb.leases.L1, JSON.stringify(sb));
  await fx('fxRelease', 's13dbl', 'L2');
  await fx('fxRefund', 's13dbl', 'L2');
  await fx('fxRelease', 's13dbl', 'L2');
  sb = await sessOf('s13dbl');
  check('풀린 lease 는 돌려주지 않음', sb.uses === 4 && sb.calls.join() === '222' && Object.keys(sb.leases).length === 0, JSON.stringify(sb));
  const rn = [await fx('fxRenew', 's13dbl', 'L1'), await fx('fxRenew', 's13dbl', 'L2')];
  sb = await sessOf('s13dbl');
  check('정산(돌려주기·풀기)한 lease 늘리기 → false, 되살리지 않음', rn.every((x) => x.ok === false) && Object.keys(sb.leases).length === 0 && sb.uses === 4, JSON.stringify({ rn, sb }));
  Object.assign(T4, { low: low.token, lowSid: low.poll.sessionId, TT });
}

section = 'restart';
await stop();
await start();
check('재시작 (같은 저장소)', true);

if (ONLY.has('4') && T4.T) {
  section = '#4';
  check('재시작 뒤: 보통 토큰 관리 경로 403, 데이터 경로 200', (await proxy(T4.T, 'daytona', 'organizations')).status === 403 && (await proxy(T4.T, 'daytona', 'sandbox')).status === 200);
  check('재시작 뒤: 관리 허용 토큰 관리 경로 200', (await proxy(T4.mgToken, 'daytona', 'organizations')).status === 200);
}
if (ONLY.has('13') && T4.low) {
  section = '#13';
  const sl = await sessOf(T4.lowSid);
  check('재시작 뒤: 낮춘 상한·센 호출 유지', JSON.stringify(sl.limits) === '{"total":3,"perMinute":2,"concurrent":1}' && sl.uses === 2 && sl.calls.length === 2, JSON.stringify(sl));
  const n = hitsUnder('/b13/').length;
  check('재시작 뒤: 분당 상한 그대로 429', (await proxy(T4.low, 'b13', 'r1')).status === 429);
  check('재시작 뒤: 총 상한 다 쓴 세션 429, upstream 없음', (await proxy(T4.TT, 'b13', 'tot')).status === 429 && hitsUnder('/b13/').length === n);
}

if (ONLY.has('6') && T6) {
  section = '#6';
  check('재시작 뒤 gen 유지', (await prov('g6a'))?.gen === T6.gen);
  check('재시작 뒤에도 예전 토큰 → 거부', (await proxy(T6.T1, 'g6a')).status === 403);
  check('재시작 뒤 새 토큰 동작', (await proxy(T6.T2, 'g6a')).status === 200);
  check('재시작 뒤 다른 공급자 동작', (await proxy(T6.T1, 'g6b')).status === 200);
  check('옮기기: 예전 공급자에 gen 부여', !!(await prov('m6'))?.gen);
  const sOld = await fx('fxList', 'sess:s6');
  check('옮기기: 세션에 gens 기록', !!sOld['sess:s6old']?.gens?.m6 && sOld['sess:s6stale']?.gens?.m6 === undefined, JSON.stringify(Object.values(sOld).map((s) => s.gens)));
  const m = await proxy(T6.TLok, 'm6', 'mig');
  check('옮기기: 정상 예전 승인 유지 (예전 키·AAD 그대로 풀림)', m.status === 200 && hitsUnder('/m6/').at(-1)?.auth === `Bearer ${T6.KM}`, `${m.status} ${m.text}`);
  check('옮기기: 세션 뒤에 다시 만들어진 공급자 승인은 거부', (await proxy(T6.TLbad, 'm6')).status === 403);
  const sm = await fx('fxList', 'sess:s6');
  check('옮기기: 감사 기록이 잘려 add 가 안 보여도 updatedAt 이 세션 뒤면 gen 안 줌', !!sm['sess:s6trunc']?.gens && sm['sess:s6trunc'].gens.m6t === undefined, JSON.stringify(sm['sess:s6trunc']?.gens));
  const nT = hitsUnder('/m6t/').length;
  check('옮기기: 잘린 기록 + 세션 뒤 공급자 → 403, upstream 안 부름', (await proxy(T6.TLtrunc, 'm6t')).status === 403 && hitsUnder('/m6t/').length === nT);
  const mv = await proxy(T6.TLvalid, 'm6v', 'mig');
  check('옮기기: 잘린 기록이라도 세션 전에 쓰인 공급자 승인은 유지', !!sm['sess:s6valid']?.gens?.m6v && mv.status === 200 && hitsUnder('/m6v/').at(-1)?.auth === `Bearer ${T6.KV}`, `${mv.status} ${mv.text}`);
  check('옮기기: 세션 뒤 키 교체(목적지 증명 불가) → 거부 (다시 승인)', (await proxy(T6.TLrot, 'm6r')).status === 403);
}

// ── #7 자리당 상한 경쟁 ─────────────────────────────────
if (ONLY.has('7')) {
  section = '#7';
  const K7 = 'k7-' + randomBytes(6).toString('hex');
  check('공유 공급자', (await upsert(ADM, { id: 'q7', label: 'Q7', upstream: `${MOCK}/q7`, auth: 'bearer', envKey: 'Q7_KEY', value: K7, labShare: true })).status === 200);
  const gen = (await prov('q7'))?.gen;
  const lab = { id: 'lab7', name: 'L7', createdAt: Date.now(), expiresAt: Date.now() + 3600e3, budget: 1, cpu: 1, memory: 2, disk: 5, snapshot: 's', model: 'm', gw: '', seats: [], share: { q7: { label: 'Q7', on: true, cap: 1 } } };
  await fx('fxPut', { 'lab:lab7': lab });
  const seat = (sid) => seedSession(sid, { providers: ['q7'], lab: 'lab7', gens: { q7: gen }, counts: {} });
  const S1 = await seat('s7a'), S2 = await seat('s7b');

  // 옛 코드: 두 요청이 모두 상한 확인을 지나 decrypt 에서 만난다(barrier). 새 코드: 두 번째는 확인 단계에서 막혀 decrypt 에 오지 않는다
  await fx('fxBarrierSet', 'q7', 2, 2500);
  const n = hitsUnder('/q7/').length;
  const rs = await Promise.all([proxy(S1, 'q7', 'a'), proxy(S1, 'q7', 'b')]);
  const bi = await fx('fxBarrierInfo');
  await fx('fxBarrierSet', null);
  const st = rs.map((r) => r.status).sort().join(',');
  const cnt = (await fx('fxGet', ['sess:s7a']))['sess:s7a']?.counts?.q7;
  check('cap=1 동시 두 호출 → 200 하나, 429 하나', st === '200,429', `${st} (decrypt 도달 ${bi.arrived})`);
  check('upstream 호출은 한 번', hitsUnder('/q7/').length - n === 1, String(hitsUnder('/q7/').length - n));
  check('저장된 count = 1', cnt === 1, String(cnt));
  check('막힌 호출은 decrypt 에 오지 않음', bi.arrived === 1, String(bi.arrived));
  check('상한 응답에 키 없음', rs.every((r) => !r.text.includes(K7)));

  const n2 = hitsUnder('/q7/').length;
  check('다른 자리는 따로 센다', (await proxy(S2, 'q7')).status === 200 && hitsUnder('/q7/').length === n2 + 1);
  const s1 = await fetch(`${GW}/p/_lab/share`, { headers: { authorization: `Bearer ${S2}` } }).then((r) => r.json());
  const s2 = await fetch(`${GW}/p/_lab/share`, { headers: { authorization: `Bearer ${S2}` } }).then((r) => r.json());
  check('_lab/share 는 세지 않음', s1.providers?.[0]?.used === 1 && s2.providers?.[0]?.used === 1 && s2.providers[0].on === true, JSON.stringify(s2));
  check('상한 뒤 순차 호출도 429, upstream 없음', (await proxy(S2, 'q7')).status === 429 && hitsUnder('/q7/').length === n2 + 1);
  const S3 = await seat('s7c');
  await fx('fxPut', { 'lab:lab7': { ...lab, share: { q7: { label: 'Q7', on: false, cap: 5 } } } });
  const n3 = hitsUnder('/q7/').length;
  check('강사가 끄면 403, upstream 없음', (await proxy(S3, 'q7')).status === 403 && hitsUnder('/q7/').length === n3);
  await fx('fxPut', { 'lab:lab7': { ...lab, share: { q7: { label: 'Q7', on: true, cap: 5 } } } });
  check('다시 켜면 동작', (await proxy(S3, 'q7')).status === 200);
  await fx('fxPut', { 'lab:lab7': { ...lab, expiresAt: Date.now() - 1 } });
  const n4 = hitsUnder('/q7/').length;
  check('수업이 끝나면 401, upstream 없음', (await proxy(S3, 'q7')).status === 401 && hitsUnder('/q7/').length === n4);
  await fx('fxDelete', ['lab:lab7']);

  // upstream 에 넘기기 전 실패(복호화)는 예약을 돌려준다 · 넘긴 뒤(upstream 오류·연결 실패)는 센다
  const KC = 'k7c-' + randomBytes(6).toString('hex');
  const dead = await freePort(); // 닫힌 loopback 포트 → 연결 실패
  const share7 = (id, up, k) => upsert(ADM, { id, label: id, upstream: up, auth: 'bearer', envKey: `${id.toUpperCase()}_KEY`, value: k, labShare: true });
  check('공유 공급자 q7c·q7e·q7f', (await share7('q7c', `${MOCK}/q7c`, KC)).status === 200 && (await share7('q7e', `${MOCK}/q7e`, 'k7e')).status === 200 && (await share7('q7f', `http://127.0.0.1:${dead}/q7f`, 'k7f')).status === 200);
  const gs = Object.fromEntries(await Promise.all(['q7c', 'q7e', 'q7f'].map(async (id) => [id, (await prov(id))?.gen])));
  await fx('fxPut', { 'lab:lab7r': { ...lab, id: 'lab7r', share: { q7c: { label: 'Q7C', on: true, cap: 1 }, q7e: { label: 'Q7E', on: true, cap: 5 }, q7f: { label: 'Q7F', on: true, cap: 5 } } } });
  const good = await prov('q7c');
  await fx('fxPut', { 'prov:q7c': { ...good, ct: flip(good.ct) } });
  const SR = await seedSession('s7r', { providers: ['q7c', 'q7e', 'q7f'], lab: 'lab7r', gens: gs, counts: {} });
  const sr = async () => (await fx('fxGet', ['sess:s7r']))['sess:s7r'];
  const nc = hitsUnder('/q7c/').length;
  const c1 = await proxy(SR, 'q7c');
  let s = await sr();
  check('망가진 암호문 → 503, upstream 없음, 키 없음', c1.status === 503 && hitsUnder('/q7c/').length === nc && !c1.text.includes(KC), `${c1.status} ${c1.text}`);
  check('복호화 실패는 예약을 돌려줌 (count 0, uses 0)', (s?.counts?.q7c ?? 0) === 0 && s?.uses === 0, JSON.stringify(s && { counts: s.counts, uses: s.uses }));
  // 예약이 잡혀 있는 동안(복호화가 barrier 에서 멈춤) 같은 자리 두 번째 호출은 상한에 막힌다 — 돌려주기가 상한을 다시 열지 않는다
  await fx('fxBarrierSet', 'q7c', 2, 2000);
  const rc = await Promise.all([proxy(SR, 'q7c', 'a'), proxy(SR, 'q7c', 'b')]);
  const bc = await fx('fxBarrierInfo');
  await fx('fxBarrierSet', null);
  s = await sr();
  check('cap=1 동시 두 호출 (복호화 실패): 503 하나 + 429 하나, decrypt 도달 1', rc.map((r) => r.status).sort().join(',') === '429,503' && bc.arrived === 1, `${rc.map((r) => r.status)} ${bc.arrived}`);
  check('동시 실패 뒤에도 한 번만 돌려줌 (count 0)', (s?.counts?.q7c ?? 0) === 0 && s?.uses === 0, JSON.stringify(s?.counts));
  await fx('fxPut', { 'prov:q7c': good });
  const c2 = await proxy(SR, 'q7c', 'ok');
  check('암호문 고친 뒤 돌려받은 자리로 호출 → 200, 원래 키', c2.status === 200 && hitsUnder('/q7c/').at(-1)?.auth === `Bearer ${KC}` && (await sr())?.counts?.q7c === 1);
  check('그 뒤 상한 → 429', (await proxy(SR, 'q7c')).status === 429);
  const e1 = await proxy(SR, 'q7e', 'fail500');
  check('upstream 이 500 → 그대로 전달, 호출은 셈 (돌려주지 않음)', e1.status === 500 && hitsUnder('/q7e/fail500').length === 1 && (await sr())?.counts?.q7e === 1, `${e1.status}`);
  const f1 = await proxy(SR, 'q7f');
  check('upstream 연결 실패 → 502, 호출은 셈 (키를 넘긴 뒤)', f1.status === 502 && (await sr())?.counts?.q7f === 1, `${f1.status} ${f1.text}`);
  await fx('fxDelete', ['lab:lab7r']);

  // 자리당 count 를 올린 뒤 세션 상한(총·분당·동시)에 막히면 count 도 저장하지 않는다 · 세션·공급자 거부는 키를 풀기 전에
  const KG = 'k7g-' + randomBytes(6).toString('hex');
  check('공유 공급자 q7g', (await share7('q7g', `${MOCK}/q7g`, KG)).status === 200);
  const gg = (await prov('q7g'))?.gen;
  await fx('fxPut', { 'lab:lab7g': { ...lab, id: 'lab7g', share: { q7g: { label: 'Q7G', on: true, cap: 5 } } } });
  const lim1 = { total: 10000, perMinute: 300, concurrent: 1 };
  const deny = [
    ['총 상한', 's7gt', 429, { uses: 3, limits: { ...lim1, total: 3 } }],
    ['분당 상한', 's7gr', 429, { calls: [Date.now() - 1000], limits: { ...lim1, perMinute: 1 } }],
    ['동시 상한', 's7gc', 429, { limits: lim1, leases: { busy: { exp: Date.now() + 60e3, p: 'q7g', counted: true, at: Date.now() } } }],
    ['만료된 세션', 's7ge', 401, { expiresAt: Date.now() - 1 }],
    ['끊긴 세션', 's7gv', 401, { revoked: true }],
    ['범위 밖 공급자', 's7gs', 403, { providers: ['q7'] }],
    ['바뀐 공급자 세대', 's7gg', 403, { gens: { q7g: 'stale-gen' } }],
  ];
  await fx('fxBarrierSet', 'q7g', 1000, 1); // decrypt 도달 수만 센다
  const ng = hitsUnder('/q7g/').length;
  for (const [name, sid, want, extra] of deny) {
    const tok = await seedSession(sid, { providers: ['q7g'], lab: 'lab7g', gens: { q7g: gg }, counts: { q7g: 2 }, ...extra });
    const before = await sessOf(sid);
    const r = await proxy(tok, 'q7g', 'deny');
    const after = await sessOf(sid);
    check(`${name} → ${want}, 키 없음, count·uses·호출 시각·자리 그대로`, r.status === want && !r.text.includes(KG) && after.counts?.q7g === 2 && (after.uses ?? 0) === (before.uses ?? 0)
      && (after.calls ?? []).length === (before.calls ?? []).length && Object.keys(after.leases ?? {}).join() === Object.keys(before.leases ?? {}).join(), `${r.status} ${JSON.stringify(after)}`);
  }
  const bg = await fx('fxBarrierInfo');
  check('막힌 호출 모두 upstream·decrypt 없음', hitsUnder('/q7g/').length === ng && bg.arrived === 0, `${hitsUnder('/q7g/').length - ng} ${bg.arrived}`);
  const TOK = await seedSession('s7gok', { providers: ['q7g'], lab: 'lab7g', gens: { q7g: gg }, counts: { q7g: 2 } });
  check('같은 자리 설정, 상한 안 → 200, count 3, decrypt 1', (await proxy(TOK, 'q7g', 'ok')).status === 200 && (await sessOf('s7gok')).counts?.q7g === 3 && (await fx('fxBarrierInfo')).arrived === 1);
  await fx('fxBarrierSet', null);
  await fx('fxDelete', ['lab:lab7g']);
}

section = 'guard';
const ob = [...outboundBefore, ...(await fx('fxOutbound'))];
// ls6(#6 경쟁)은 LangSmith 주소지만 합성 키(ls6-…)뿐이고 fixture 가 막는다
check('바깥으로 나가려던 호출은 (막힌) openrouter.ai 서브키 삭제와 합성 ls6·dtc 키뿐', ob.every((x) => (x.method === 'DELETE' && x.url.startsWith('https://openrouter.ai/api/v1/keys/')) || (x.url.startsWith('https://api.smith.langchain.com/') && x.auth.startsWith('ls6-k'))
  || (x.url.startsWith('https://app.daytona.io/api/') && x.auth.startsWith('Bearer k4c-'))), JSON.stringify(ob));
await done();
