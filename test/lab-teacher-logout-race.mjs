// 강사 모니터 로그아웃 경쟁 회귀 (실제 쿠키). 실제 src/index.ts Worker + State(메모리 저장소, blockConcurrencyWhile 은 직렬 큐)를 로컬 http 서버
// (http://localhost:<임시 포트> — 보안 컨텍스트라 Secure·__Host- 쿠키가 실제로 구워진다)로 띄우고, 설치된 Edge headless 의 진짜 쿠키 저장소로 확인한다.
//   - 지금 쿠키로 다시 확인 → session 응답(Set-Cookie)을 로그아웃 뒤까지 붙잡았다가 보냄: 늦게 구워진 쿠키는 권한 없음, 새로고침해도 복원 안 됨, 만료 늘지 않음
//   - 쿠키 없이 처음 만들기가 로그아웃(관리 토큰 함께)보다 먼저 끝남 / 로그아웃이 먼저: 어느 쪽도 살아 있는 모니터 없음, 그 관리 토큰 폐기
//   - 다른 기기 둘(각자 관리 토큰·쿠키)은 그대로
// 보안 키는 CDP 가상 인증기, /api/admin/options·login 만 이 서버가 흉내(웹 관리 토큰은 State 가 직접 만듦). 바깥 네트워크·배포 없음.
// Edge 가 없으면 skip.  node test/lab-teacher-logout-race.mjs
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { build } from 'esbuild';

let pass = 0, failN = 0, skipN = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { failN++; console.log(`  FAIL ${name} ${String(extra).slice(0, 400)}`); }
};
const J = JSON.stringify;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64u = (b) => Buffer.from(b).toString('base64url');
const b64sha = (s) => createHash('sha256').update(s).digest('base64url');
const done = () => { console.log(`\n${pass} ok, ${failN} fail, ${skipN} skip`); process.exit(failN ? 1 : 0); };
setTimeout(() => { console.log('  FAIL 전체 시간 상한 180초'); failN++; done(); }, 180000).unref();

let chromium, browser;
try { ({ chromium } = await import('playwright-core')); browser = await chromium.launch({ channel: 'msedge', headless: true }); }
catch (e) { skipN++; console.log(`  skip Edge 없음 (${String(e.message).split('\n')[0]})`); done(); }

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const cfStub = { name: 'cf-stub', setup(b) {
  b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'cf', namespace: 'cf-stub' }));
  b.onLoad({ filter: /.*/, namespace: 'cf-stub' }, () => ({ contents: 'export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }', loader: 'js' }));
} };
const bundled = await build({ entryPoints: [join(ROOT, 'src/index.ts')], bundle: true, write: false, format: 'esm', platform: 'node', loader: { '.ps1': 'text' }, plugins: [cfStub], logLevel: 'silent' });
const dir = mkdtempSync(join(tmpdir(), 'lab-teacher-race-'));
writeFileSync(join(dir, 'worker.mjs'), bundled.outputFiles[0].text);
let mod;
try { mod = await import(pathToFileURL(join(dir, 'worker.mjs')).href); } finally { rmSync(dir, { recursive: true, force: true }); }
const worker = mod.default;
const outbound = [];
globalThis.fetch = async (u) => { outbound.push(String(u?.url ?? u)); throw new Error(`network blocked in test: ${u}`); };

// 저장소: 메모리. blockConcurrencyWhile: 한 번에 하나 (DO 의 직렬 구역 흉내)
const m = new Map();
let alarm = null;
const cl = (v) => (v === undefined ? v : structuredClone(v));
const storage = {
  async get(k) { if (Array.isArray(k)) { const r = new Map(); for (const x of k) if (m.has(x)) r.set(x, cl(m.get(x))); return r; } return cl(m.get(k)); },
  async put(k, v) { if (typeof k === 'object') { for (const [a, b] of Object.entries(k)) m.set(a, cl(b)); } else m.set(k, cl(v)); },
  async delete(k) { const ks = Array.isArray(k) ? k : [k]; let n = 0; for (const x of ks) if (m.delete(x)) n++; return Array.isArray(k) ? n : n > 0; },
  async list({ prefix = '' } = {}) { return new Map([...m.keys()].filter((x) => x.startsWith(prefix)).sort().map((x) => [x, cl(m.get(x))])); },
  async getAlarm() { return alarm; }, async setAlarm(t) { alarm = t; },
};
let q = Promise.resolve();
const bcw = (f) => { const r = q.then(f); q = r.catch(() => {}); return r; };
class T extends mod.State { async daytona() { return { status: 409, error: 'no daytona in test' }; } }

const srv = createServer();
await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
const O = `http://localhost:${srv.address().port}`;
const envOf = () => ({ ORIGIN: O, LAB_ORIGIN: 'https://lab.example.test', LAB_SEAT_DOMAIN: 'example.test', RP_ID: 'localhost', MASTER_KEY: 'dummy-master-key' });
const st = new T({ storage, waitUntil() {}, blockConcurrencyWhile: bcw }, envOf());
const env = { ...envOf(), STATE: { idFromName: (n) => ({ name: n }), get: () => st } };
const credId = randomBytes(16);
const teachers = () => [...m.keys()].filter((k) => k.startsWith('teacher:')).sort();

// session 붙잡기: 'before' = 서버가 처리하기 전에, 'after' = 처리한 뒤 응답(Set-Cookie)만 붙잡기
let hold = null;
const holdSession = (mode) => { const h = { mode }; h.release = null; h.gate = new Promise((r) => (h.release = r)); h.arrived = new Promise((r) => (h.arrive = r)); h.sent = new Promise((r) => (h.send = r)); hold = h; return h; };
const reqs = [];
srv.on('request', async (nreq, nres) => {
  const u = new URL(nreq.url, O), p = u.pathname;
  const chunks = []; for await (const c of nreq) chunks.push(c);
  const raw = Buffer.concat(chunks);
  const h = new Headers(); for (const [k, v] of Object.entries(nreq.headers)) if (k !== 'host' && v !== undefined) h.set(k, Array.isArray(v) ? v.join(', ') : v);
  reqs.push({ p, cookie: h.get('cookie') ?? '', admin: h.get('x-admin-token') ?? '' });
  const send = async (res) => { const hs = {}; res.headers.forEach((v, k) => { if (k !== 'set-cookie') hs[k] = v; }); const sc = res.headers.getSetCookie(); if (sc.length) hs['set-cookie'] = sc;
    nres.writeHead(res.status, hs); nres.end(Buffer.from(await res.arrayBuffer())); };
  const json = (d, status = 200) => new Response(J(d), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  try {
    if (p === '/api/admin/options') return await send(json({ challenge: b64u(randomBytes(32)), rpId: 'localhost', allowCredentials: [{ type: 'public-key', id: b64u(credId) }], userVerification: 'preferred', timeout: 60000 }));
    if (p === '/api/admin/login') return await send(json(await st.newAdminToken('web')));
    if (p === '/api/lab/config' || p === '/api/lab/list') {
      if (!(await st.checkAdmin(h.get('x-admin-token') ?? ''))) return await send(json({ error: '관리 세션이 만료됐습니다.' }, 401));
      return await send(json(p === '/api/lab/list' ? { labs: [], quota: null, now: Date.now() }
        : { labOrigin: 'https://lab.example.test', quota: null, hours: [1, 2, 3], budgets: [1, 2, 5], daytona: true, openrouter: true, shareable: [], cfg: { gw: 'g', snapshot: 's', model: 'm', clip: { in: true, out: true }, share: {} } }));
    }
    const req = new Request(O + nreq.url, { method: nreq.method, headers: h, ...(raw.length ? { body: raw } : {}) });
    const g = p === '/api/lab/teacher/session' ? hold : null;
    if (g) { hold = null; g.arrive(); if (g.mode === 'before') await g.gate; }
    const res = await worker.fetch(req, env, { waitUntil() {}, passThroughOnException() {} });
    if (g) { g.res = res.headers.getSetCookie(); g.status = res.status; if (g.mode === 'after') { g.processed = true; await g.gate; } }
    await send(res);
    if (g) g.send();
  } catch (e) { nres.writeHead(500); nres.end(String(e)); }
});

async function device(name) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.setDefaultTimeout(10000);
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'usb', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  await cdp.send('WebAuthn.addCredential', { authenticatorId, credential: { credentialId: credId.toString('base64'), isResidentCredential: false, rpId: 'localhost', privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'), signCount: 0 } });
  const txt = (sel) => page.$eval(sel, (e) => e.textContent);
  const until = async (fn, what, ms = 10000) => { const t = Date.now(); for (;;) { const v = await fn().catch(() => false); if (v) return v; if (Date.now() - t > ms) throw new Error(`${name} timeout: ${what}`); await sleep(25); } };
  const cookie = async () => (await ctx.cookies(O)).find((c) => c.name === '__Host-lab_teacher');
  const status = () => page.evaluate(async () => (await fetch('/api/lab/teacher/status', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status);
  const open = async () => { await page.goto(O + '/lab'); await until(async () => /보안 키로|까지 이 기기에서/.test((await txt('#loginNote')) + (await txt('#monLine'))), 'boot'); };
  const restored = async () => !(await page.$eval('#panel', (e) => e.hidden)) && (await txt('#monLine')).includes('까지 이 기기에서');
  const login = async () => { const n = reqs.length; await page.click('#go'); await until(async () => reqs.slice(n).some((r) => r.p === '/api/lab/list') && await restored() && !(await page.$eval('#go', (e) => e.disabled)), 'login'); };
  return { ctx, page, errors, txt, until, cookie, status, open, restored, login };
}

try {
  console.log('실제 쿠키: 보안 컨텍스트·속성');
  const A = await device('A');
  await A.open();
  await A.login();
  const c0 = await A.cookie();
  check('localhost 에서 __Host- 쿠키가 실제로 구워짐 (HttpOnly·Secure·Strict·Path=/)', !!c0 && c0.httpOnly && c0.secure && c0.sameSite === 'Strict' && c0.path === '/' && /^[\w-]{32}$/.test(c0.value), J(c0));
  check('JS 로는 안 보임', (await A.page.evaluate(() => document.cookie)) === '');
  const rec0 = J(m.get(`teacher:${b64sha(c0.value)}`));

  // 다른 기기 둘 (각자 보안 키 로그인 → 각자 쿠키)
  const B = await device('B'), C = await device('C');
  const otherAdm = [];
  for (const d of [B, C]) { await d.open(); await d.login(); otherAdm.push(reqs.filter((r) => r.p === '/api/lab/teacher/session').at(-1).admin); }
  const otherCk = [(await B.cookie()).value, (await C.cookie()).value];
  const othersOk = async () => (await B.status()) === 200 && (await C.status()) === 200 && (await st.checkAdmin(otherAdm[0])) && (await st.checkAdmin(otherAdm[1]));
  check('다른 기기 둘: 각자 다른 쿠키로 200', otherCk[0] !== otherCk[1] && !otherCk.includes(c0.value) && await othersOk());

  // ── 1. 지금 쿠키로 다시 확인 → 서버가 처리(같은 쿠키 재사용)한 뒤 Set-Cookie 를 붙잡고, 로그아웃이 먼저 끝남 ──
  console.log('지금 쿠키로 다시 확인 → 늦은 Set-Cookie 가 로그아웃 뒤에 도착');
  await sleep(1100); // Max-Age 가 초 단위로 줄어든 것을 보이게
  // Legacy/view-only browser: the admin restore cookie is deliberately absent in this scenario.
  await A.ctx.clearCookies({name:'__Host-lab_admin'});
  await A.page.reload();
  await A.until(() => A.restored(), 'restored from cookie');
  const n1 = teachers().length;
  const h1 = holdSession('after');
  await A.page.click('#reauth');
  await h1.arrived;
  await A.until(async () => h1.processed, 'session processed');
  const sess = reqs.filter((r) => r.p === '/api/lab/teacher/session').at(-1);
  const a2 = sess.admin;
  check('다시 확인 session 에 지금 쿠키가 실림', sess.cookie.includes(`__Host-lab_teacher=${c0.value}`));
  check('서버: 같은 토큰 재사용, 남은 시간만 Max-Age (<28800), 새 기록 없음, 기록 그대로', h1.status === 200 && h1.res.length === 1 && h1.res[0].startsWith(`__Host-lab_teacher=${c0.value};`) && Number(/Max-Age=(\d+)/.exec(h1.res[0])?.[1]) < 28800 && teachers().length === n1 && J(m.get(`teacher:${b64sha(c0.value)}`)) === rec0, J(h1.res));
  const nl = reqs.length;
  await A.page.click('#navSet');
  await A.page.click('#logout');
  const imm = await A.page.evaluate(() => ({ login: !document.getElementById('login').hidden, go: document.getElementById('go').disabled, done:document.getElementById('loginNote').textContent.includes('로그아웃했습니다') }));
  check('로그아웃 즉시 로그인 화면, 응답 대기 중에만 열기 막힘', imm.login && (imm.go || imm.done), J(imm));
  await A.until(async () => (await A.txt('#loginNote')).includes('로그아웃했습니다'), 'logout done');
  const lo1 = reqs.slice(nl).find((r) => r.p === '/api/lab/teacher/logout');
  check('로그아웃에 지금 쿠키 + session 중인 관리 토큰', !!lo1 && lo1.cookie.includes(c0.value) && lo1.admin === a2 && !!a2, J(lo1));
  check('서버: 쿠키 세션·그 관리 토큰 지움', !m.has(`teacher:${b64sha(c0.value)}`) && !(await st.checkAdmin(a2)));
  check('로그아웃 응답이 쿠키를 지움', !(await A.cookie()));
  h1.release(); await h1.sent; await sleep(200);
  const late1 = await A.cookie();
  check('늦은 Set-Cookie 가 실제로 다시 구워짐 (위협 재현) — 만료는 처음 그대로', !!late1 && late1.value === c0.value && Math.abs(late1.expires - c0.expires) <= 2, J([late1, c0.expires]));
  check('화면: 늦은 session 본문으로 되살아나지 않음', !(await A.page.$eval('#login', (e) => e.hidden)) && (await A.page.$eval('#panel', (e) => e.hidden)));
  await A.page.reload();
  await A.until(async () => (await A.txt('#loginNote')).includes('보안 키로 열어 주세요'), 'not restored');
  check('새로고침: 늦게 구워진 쿠키로 복원 안 됨 (401 → 쿠키 지움)', !(await A.restored()) && !(await A.cookie()));
  check('다른 기기 둘은 그대로', await othersOk());

  // ── 2. 쿠키 없이 처음 만들기 — 서버가 먼저 만들고 응답만 늦게, 로그아웃(관리 토큰 함께)은 그 사이 ──
  console.log('쿠키 없는 만들기가 먼저 → 로그아웃');
  const n2 = teachers().length;
  const h2 = holdSession('after');
  const r0 = reqs.length;
  await A.page.click('#go');
  await h2.arrived;
  await A.until(async () => h2.processed, 'session processed');
  const s2 = reqs.slice(r0).find((r) => r.p === '/api/lab/teacher/session');
  const d2 = /__Host-lab_teacher=([\w-]{32});/.exec(h2.res[0] ?? '')?.[1];
  check('쿠키 없는 session → 새 세션이 저장됨 (issuedBy = 그 관리 토큰 해시)', !s2.cookie.includes('__Host-lab_teacher') && !!d2 && teachers().length === n2 + 1 && m.get(`teacher:${b64sha(d2)}`)?.issuedBy === b64sha(s2.admin), J([s2, h2.res]));
  // 같은 화면에서 로그아웃 (패널은 session 응답 뒤에야 보이므로 버튼 처리기를 직접 부른다)
  await A.page.evaluate(() => document.getElementById('logout').onclick());
  await A.until(async () => (await A.txt('#loginNote')).includes('로그아웃했습니다'), 'logout 2');
  const lo2 = reqs.slice(r0).find((r) => r.p === '/api/lab/teacher/logout');
  check('로그아웃: 쿠키 없이 관리 토큰만', !!lo2 && lo2.admin === s2.admin && !lo2.cookie.includes('__Host-lab_teacher'), J(lo2));
  check('서버: 그 관리 토큰으로 만든 세션 지움 + 관리 토큰 폐기', !m.has(`teacher:${b64sha(d2)}`) && teachers().length === n2 && !(await st.checkAdmin(s2.admin)));
  h2.release(); await h2.sent; await sleep(200);
  const late2 = await A.cookie();
  check('늦은 Set-Cookie 는 구워지지만 권한 없음 (401)', late2?.value === d2 && (await A.status()) === 401, J(late2));
  await A.page.reload();
  await A.until(async () => (await A.txt('#loginNote')).includes('보안 키로 열어 주세요'), 'not restored 2');
  check('새로고침: 복원 안 됨', !(await A.restored()));
  check('다른 기기 둘은 그대로', await othersOk());

  // ── 3. 쿠키 없는 만들기가 줄 서 있는 동안 로그아웃이 먼저 처리됨 ──
  console.log('로그아웃 먼저 → 쿠키 없는 만들기');
  const n3 = teachers().length;
  const h3 = holdSession('before');
  const r3 = reqs.length;
  await A.page.click('#go');
  await h3.arrived;
  const s3 = reqs.slice(r3).find((r) => r.p === '/api/lab/teacher/session');
  await A.page.evaluate(() => document.getElementById('logout').onclick());
  await A.until(async () => (await A.txt('#loginNote')).includes('로그아웃했습니다'), 'logout 3');
  check('로그아웃이 먼저: 그 관리 토큰 폐기', !(await st.checkAdmin(s3.admin)));
  h3.release(); await h3.sent; await sleep(200);
  check('줄 섰던 만들기 → 403, Set-Cookie 없음, 새 세션 없음', h3.status === 403 && !h3.res.length && teachers().length === n3 && !(await A.cookie()), J([h3.status, h3.res]));
  await A.page.reload();
  await A.until(async () => (await A.txt('#loginNote')).includes('보안 키로 열어 주세요'), 'not restored 3');
  check('새로고침: 복원 안 됨', !(await A.restored()));

  console.log('마무리');
  check('다른 기기 둘: 쿠키·관리 토큰 그대로', await othersOk() && teachers().length === 2 && otherCk.every((t) => m.has(`teacher:${b64sha(t)}`)));
  check('저장소에 토큰 원문 없음', ![...otherCk, c0.value, d2].some((t) => J([...m]).includes(t)));
  check('페이지 오류·바깥 fetch 없음', !A.errors.length && !B.errors.length && !C.errors.length && !outbound.length, J([A.errors, B.errors, C.errors, outbound]));
  for (const d of [A, B, C]) await d.ctx.close();
} catch (e) { failN++; console.log(`  FAIL 예외 ${e.stack}`); }
finally { await browser.close(); srv.close(); }
done();
