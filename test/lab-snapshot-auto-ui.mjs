// /lab 화면: 처음 쓰는 직접 입력 사양의 스냅샷 자동 준비 진행 UI 회귀 테스트 (네트워크·진짜 Daytona/OpenRouter·비밀 값 없음).
//   설치된 Edge headless, 요청은 전부 route 로 흉내(바깥 호출 없음), 시계는 page.clock 으로 돌린다. Edge 가 없으면 skip.
//   확인: 202 snapshotPreparing → /api/lab/snapshot 만 5초마다(관리 토큰) → snapshotReady → 고정한 입력으로 /api/lab/create 딱 한 번.
//   처음부터 준비됨(조회 없음)·공급자 오류·연결 끊김·로그인 만료·8분 넘김·반복 클릭·대기 중 입력 수정·이상한 응답(XSS)·마지막 만들기 실패.
//   마감(처음 202 + 8분)은 절대 시각: 응답 없는 조회(abort 무시)·마감을 넘겨 온 준비됨·잠든 사이 넘어간 시계 → 조회 신호 끊고 마지막 만들기 없음.
//   node test/lab-snapshot-auto-ui.mjs
import { generateKeyPairSync, randomBytes } from 'node:crypto';

let pass = 0, failN = 0, skipN = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { failN++; console.log(`  FAIL ${name} ${String(extra).slice(0, 400)}`); }
};
const J = JSON.stringify;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('/lab 스냅샷 자동 준비 화면 (Edge headless, route 흉내, 가짜 시계)');
let chromium, browser;
try { ({ chromium } = await import('playwright-core')); browser = await chromium.launch({ channel: 'msedge', headless: true }); }
catch (e) { skipN++; console.log(`  skip Edge 없음 (${String(e.message).split('\n')[0]})`); }
if (browser) { try { await ui(browser); } finally { await browser.close(); } }

async function ui(browser) {
  const { labPage, WEBAUTHN_JS } = await import(new URL('../src/pages.ts', import.meta.url).href);
  const ORIGIN = 'http://localhost:8799', TOKEN = 'adm-snap-' + randomBytes(6).toString('hex');
  const b64u = (b) => Buffer.from(b).toString('base64url');
  const creates = [], snaps = [], external = [], teacher = [], unknown = [];
  // 다음 응답 줄: { status, body } 또는 'abort' (연결 끊김). 비면 404 — 시험이 기대하지 않은 호출이 드러난다
  const createQ = [], snapQ = [];
  let tokenOk = true;
  // 흉내 서버 시계 = 페이지 가짜 시계. 관리 토큰은 진짜처럼 로그인 때부터 10분 (admExp)
  let page, admExp = 0, logins = 0;
  const pnow = () => page.evaluate(() => Date.now());
  // 강사 앱 머리의 manifest·아이콘 (브라우저가 스스로 받을 수 있다). 이 둘만 GET 404 로 받고 나머지 모르는 경로는 그대로 실패로 센다
  const TEACHER_HEAD = new Set(['/__teacher/manifest.webmanifest', '/__teacher/icon-192.png']);
  const okLab = (name) => ({ ok: true, creationState:'completed', requestId:creates[creates.length-1].requestId, lab: { id: 'L' + creates.length, name, createdAt:1700000000000,expiresAt:1700003600000,seatCount:2,failedSeats:0 } });
  const pend = (extra = {}) => ({ status: 202, body: { snapshotPreparing: true, snapshot: 'gw-lab-v4-2c8g10d', state: 'building', retryAfterMs: 5000, ...extra } });
  const ready = (extra = {}) => ({ status: 200, body: { snapshotReady: true, snapshot: 'gw-lab-v4-2c8g10d', ...extra } });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  let credId;
  await ctx.route('**/*', async (route) => {
    const req = route.request(), u = new URL(req.url());
    if (u.origin !== ORIGIN) { external.push(req.url()); return route.abort('blockedbyclient'); }
    const p = u.pathname, json = (o, status = 200) => route.fulfill({ status, contentType: 'application/json', body: J(o) });
    let body; try { body = req.postDataJSON(); } catch { body = null; }
    if (p === '/lab') return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: labPage() });
    if (p === '/webauthn.js') return route.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: WEBAUTHN_JS });
    if (p.startsWith('/api/lab/live/')) return json({ error: 'outside snapshot fixture' }, 401);
    if (p === '/api/admin/options') return json({ challenge: b64u(randomBytes(32)), rpId: 'localhost', allowCredentials: [{ type: 'public-key', id: credId }], userVerification: 'preferred', timeout: 60000 });
    if (p === '/api/admin/login') { logins++; admExp = (await pnow()) + 600000; return json({ token: TOKEN, expiresAt: admExp }); }
    if (req.method() === 'GET' && TEACHER_HEAD.has(p)) return route.fulfill({ status: 404, body: '' });
    // 모니터 계약: 이 기기에 모니터 쿠키 없음(status 401), 모니터 세션은 만들지 못함(503) → 관리 토큰 화면만으로 돈다
    if (p === '/api/lab/teacher/status' || p === '/api/lab/teacher/session') {
      teacher.push({ p, method: req.method(), token: req.headers()['x-admin-token'] ?? null, body: req.postData() });
      return p.endsWith('/status') ? json({ error: '모니터 세션이 없습니다' }, 401) : json({ error: '모니터 세션을 만들 수 없습니다 (테스트)' }, 503);
    }
    if (p === '/api/lab/snapshot') snaps.push({ body, token: req.headers()['x-admin-token'] ?? null });
    if (p === '/api/lab/create') creates.push(body);
    if (req.headers()['x-admin-token'] !== TOKEN || !tokenOk) return json({ error: '로그인이 만료됐습니다' }, 401);
    if (p === '/api/lab/config') return json({ labOrigin: 'https://lab.example.test', quota: { cpu: [0, 100], memory: [0, 400], disk: [0, 1000] }, hours: [1, 2, 3], budgets: [1, 2, 5], daytona: true, openrouter: true, shareable: [{ id: 'p1', label: 'Prov', envKey: 'PROV_KEY' }], cfg: { gw: 'https://gw.example.test', snapshot: 'gw-lab-v4', model: 'test/model', clip: { in: true, out: true }, share: {} } });
    if (p === '/api/lab/list') return json({ labs: [], quota: null, now: await pnow() });
    if(p==='/api/lab/create-status')return json({error:'ended fixture operation'},410);
    if (p === '/api/lab/create' || p === '/api/lab/snapshot') {
      const q = (p === '/api/lab/create' ? createQ : snapQ).shift();
      if (q === 'abort') return route.abort('failed');
      if (!q) return json({ error: 'not queued' }, 404);
      const reply=typeof q.body === 'function' ? q.body() : q.body;return json(p==='/api/lab/create'?{...reply,requestId:body.requestId,creationState:reply.creationState||(reply.snapshotPreparing?'preparing':undefined)}:reply,q.status);
    }
    unknown.push(req.method() + ' ' + p);
    return json({ error: 'not mocked' }, 404);
  });
  check('내보낸 스크립트의 스냅샷 이름 정규식에 \\w 가 살아 있음', labPage().includes('SNAP_RE=/^[\\w./:-]{1,160}$/'));
  page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => { window.__pwn = 0; });
  await page.clock.install({ time: new Date('2026-10-02T09:00:00Z') });
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'usb', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  const id = randomBytes(16);
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  await cdp.send('WebAuthn.addCredential', { authenticatorId, credential: { credentialId: id.toString('base64'), isResidentCredential: false, rpId: 'localhost', privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'), signCount: 0 } });
  credId = b64u(id);

  // 가짜 시계에서는 페이지 쪽 대기 함수를 믿지 않고 node 시계로 묻는다
  const until = async (fn, what, ms = 8000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timeout: ' + what); await sleep(25); } };
  const msg = () => page.$eval('#l_msg', (e) => e.textContent);
  const msgHas = (s) => until(async () => (await msg()).includes(s), s);
  const disabled = () => page.$eval('#l_make', (e) => e.disabled);
  const settle = () => sleep(150);
  const advance = async (ms) => { await page.clock.runFor(ms); await settle(); };
  const shown = (sel) => page.$eval(sel, (e) => !e.hidden && !e.closest('[hidden]'));
  // 관리 토큰은 서버가 준 10분뿐. 다음 장면에 need ms 가 모자라면 사람이 하듯 만료를 지켜본 뒤 보안 키로 다시 연다 (적어 둔 입력은 남는다)
  const ensureAdmin = async (need) => {
    let left = admExp - (await pnow());
    if (left >= need && await shown('#l_make')) return;
    if(!(await shown('#l_make'))){const n=logins;await page.click((await page.$eval('#panel',e=>e.hidden))?'#go':'#reauth');await until(async()=>logins>n&&await shown('#l_make')&&!(await page.$eval('#go',e=>e.disabled)),'reauth');return}
    if (left > 1000) { await advance(left - 1000); check('관리 10분 끝나기 1초 전: 새 수업 칸 그대로', await shown('#l_make')); left = 1000; }
    const before = creates.length + snaps.length;
    await advance(Math.max(0, left) + 1000);
    check('관리 10분 지나면 새 수업 칸을 닫고 다시 확인을 물음 (요청 없음)', !(await shown('#l_make')) && creates.length + snaps.length === before);
    const n = logins;
    await page.click((await page.$eval('#panel', (e) => e.hidden)) ? '#go' : '#reauth');
    await until(async () => logins > n && await shown('#l_make') && !(await page.$eval('#go', (e) => e.disabled)) && (await page.$eval('#admLine', (e) => e.textContent)).includes('남음'), 'reauth');
    await settle();
  };

  await page.goto(`${ORIGIN}/lab`);
  await page.click('#go');
  await until(() => page.$eval('#panel', (e) => !e.hidden), 'panel');
  await until(async () => (await page.$$('#l_share input[data-share]')).length === 1, 'share form');
  await until(()=>page.$eval('#go',e=>!e.disabled),'login complete');
  await page.$eval('#newLab',e=>{e.open=true});
  await page.fill('#l_seats', '3');
  await page.selectOption('#l_spec', 'custom');
  await page.fill('#l_cpu', '2'); await page.fill('#l_memory', '8'); await page.fill('#l_disk', '10');
  await page.fill('#l_name', '10/6 수업');
  await page.check('#l_share input[data-share]');
  await page.fill('#l_cap_p1', '42');
  // 여기부터 시계는 runFor 로만 움직인다 (실제 시간이 흘러도 타이머가 저절로 돌지 않게)
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  // 5초보다 긴 setTimeout(조회 마감 타이머)이 끝나거나 지워지지 않고 남았는지 센다 (화면의 다른 타이머는 1.5초뿐)
  await page.evaluate(() => {
    const live = new Set(), st = window.setTimeout, ct = window.clearTimeout;
    window.setTimeout = (f, ms, ...a) => { const id = st((...x) => { live.delete(id); if (typeof f === 'function') f(...x); }, ms, ...a); if (ms > 5000) live.add(id); return id; };
    window.clearTimeout = (id) => { live.delete(id); ct(id); };
    window.__liveLong = () => live.size;
  });
  const liveLong = () => page.evaluate(() => window.__liveLong());
  await advance(60000);
  check('로그인·입력 변경·시간 흐름만으로는 스냅샷/만들기 호출 없음', snaps.length === 0 && creates.length === 0, J({ snaps, creates }));
  check('직접 입력 안내: 처음 한 번 자동 준비', (await page.$eval('#l_spec option[value=custom]', (e) => e.textContent)).includes('자동으로 준비'));

  // ── 1. 처음 202 → 조회 202 → 준비됨 → 마지막 만들기 딱 한 번 ──
  console.log('전체 흐름');
  createQ.push(pend(), { status: 200, body: () => okLab('10/6 수업') });
  snapQ.push(pend({ state: 'pulling', retryAfterMs: 1 }), ready());
  await page.click('#l_make');
  await msgHas('준비 중');
  const first = creates[0];
  check('처음 만들기 1번, 사양·공유 그대로', creates.length === 1 && first.cpu === 2 && first.memory === 8 && first.disk === 10 && first.seats === 3 && J(first.share) === J({ p1: 42 }) && first.name === '10/6 수업', J(creates));
  check('대기 중 문구: 스냅샷 이름·처음 몇 분·같은 사양 재사용·아직 안 만듦', /스냅샷 gw-lab-v4-2c8g10d 준비 중/.test(await msg()) && (await msg()).includes('몇 분') && (await msg()).includes('같은 사양은 다음부터') && (await msg()).includes('아직 수업은 만들지 않았습니다') && !(await msg()).includes('만들었습니다'), await msg());
  check('대기 중 만들기 버튼 꺼짐', await disabled());
  // 대기 중에 칸을 고치고 다시 누른다 — 마지막 만들기에는 처음 값이 가야 하고, 두 번째 흐름은 생기지 않는다
  await page.fill('#l_name', '바뀐 이름'); await page.fill('#l_seats', '9'); await page.fill('#l_disk', '20');
  await page.$eval('#l_snap', (e) => { e.closest('details').open = true; }); await page.fill('#l_snap', 'other-snap');
  await page.fill('#l_cap_p1', '7'); await page.fill('#l_model', 'other/model');
  await page.click('#l_make', { force: true }).catch(() => {});
  await page.evaluate(() => { document.getElementById('l_make').onclick(); document.getElementById('l_make').onclick(); });
  await settle();
  check('반복 클릭: 새 요청 없음', creates.length === 1 && snaps.length === 0, J({ creates: creates.length, snaps: snaps.length }));
  await advance(4900);
  check('5초 전에는 조회 안 함', snaps.length === 0, snaps.length);
  await advance(200);
  await until(() => snaps.length === 1, 'poll 1');
  check('조회 본문: 고정한 snapshot·cpu·memory·disk 만, 관리 토큰', J(snaps[0].body) === J({ snapshot: 'gw-lab-v4', cpu: 2, memory: 8, disk: 10 }) && snaps[0].token === TOKEN, J(snaps[0]));
  await settle();
  check('조회 202 뒤에도 만들기는 다시 안 보냄 (retryAfterMs 1 무시)', creates.length === 1, creates.length);
  check('상태 표시', (await msg()).includes('상태 pulling'), await msg());
  await advance(4000);
  check('retryAfterMs 1 이어도 5초 간격', snaps.length === 1, snaps.length);
  await advance(1100);
  await until(() => creates.length === 2, 'final create');
  await msgHas('만들었습니다');
  check('준비됨 → 마지막 만들기 딱 한 번, 처음 고정한 입력 그대로', creates.length === 2 && J(creates[1]) === J(first) && snaps.length === 2, J(creates[1]));
  check('끝나면 생성 잠금', (await disabled()));
  await advance(30000);
  check('끝난 뒤 조회·만들기 더 없음', creates.length === 2 && snaps.length === 2, J({ c: creates.length, s: snaps.length }));

  // need: 이 장면이 관리 토큰을 쓰는 시간 (기본 2분, 8분 마감 장면은 8분 30초)
  const LONG = 8.5 * 60000;
  const fresh = async (need = 2 * 60000) => { tokenOk=true;await ensureAdmin(need);if(await shown('#l_recheck')){await page.click('#l_recheck');await until(()=>page.$eval('#l_msg',e=>e.dataset.state==='ended'),'fixture ended')}if(await shown('#l_new'))await page.click('#l_new'); creates.length = 0; snaps.length = 0; createQ.length = 0; snapQ.length = 0; tokenOk = true;
    await page.fill('#l_name', 'x'); await page.fill('#l_seats', '2'); await page.fill('#l_disk', '10'); await page.fill('#l_snap', 'gw-lab-v4'); };
  const startPending = async (initial = pend()) => { createQ.push(initial); await page.click('#l_make'); await msgHas('준비 중'); };

  // ── 2. 처음부터 준비됨: 예전 그대로 (조회 없음) ──
  console.log('처음부터 준비됨');
  await fresh();
  createQ.push({ status: 200, body: () => okLab('x') });
  await page.click('#l_make');
  await msgHas('만들었습니다');
  await advance(20000);
  check('만들기 1번, 조회 없음, 생성 잠금', creates.length === 1 && snaps.length === 0 && (await disabled()), J({ c: creates.length, s: snaps.length }));

  // ── 3. 실패들: 멈추고 버튼 켜고 만들기 다시 안 보냄 ──
  const stops = [
    ['공급자 오류 (문구 정리)', { status: 409, body: { error: '<script>window.__pwn=3</script>Daytona 거부 bearer abc.def' } }, '스냅샷 준비 상태를 확인하지 못했습니다'],
    ['연결 끊김', 'abort', '스냅샷 준비 상태를 확인하지 못했습니다'],
    ['이상한 응답: snapshotReady 문자열', { status: 200, body: { snapshotReady: 'yes', snapshot: 'gw-lab-v4-2c8g10d' } }, '알아볼 수 없어'],
    ['이상한 응답: 준비된 이름이 다름', ready({ snapshot: 'evil-snap' }), '알아볼 수 없어'],
    ['이상한 응답: 대기 이름에 태그', pend({ snapshot: '<img src=x onerror=window.__pwn=4>' }), '알아볼 수 없어'],
    ['이상한 응답: 빈 객체', { status: 200, body: {} }, '알아볼 수 없어'],
  ];
  for (const [label, resp, want] of stops) {
    console.log(label);
    await fresh();
    await startPending();
    snapQ.push(resp);
    await advance(5100);
    await msgHas(want);
    const m = await msg();
    check(`${label}: 멈춤 문구·아직 안 만듦·나중에 다시`, m.includes('수업은 아직 만들지 않았습니다') && m.includes('결과 복구'), m);
    check(`${label}: 생성 잠금`, (await disabled()));
    await advance(60000);
    check(`${label}: 조회 1번, 만들기 1번 (자동 재시도 없음)`, snaps.length === 1 && creates.length === 1, J({ s: snaps.length, c: creates.length }));
    if (label.startsWith('공급자')) check('공급자 오류 문구에서 태그·토큰 지움', !m.includes('<') && !m.includes('abc.def') && m.includes('Daytona 거부'), m);
  }

  console.log('로그인 만료');
  await fresh();
  await startPending();
  tokenOk = false;
  await advance(5100);
  await msgHas('보안 키로 다시 확인');
  await advance(60000);
  check('401: 멈춤, 조회 1번, 만들기 1번, 생성 잠금', snaps.length === 1 && creates.length === 1 && (await disabled()), J({ s: snaps.length, c: creates.length }));

  console.log('8분 넘김');
  await fresh(LONG);
  await startPending();
  for (let i = 0; i < 200; i++) snapQ.push(pend());
  for (let i = 0; i < 100 && !(await msg()).includes('기다리기를 멈췄습니다'); i++) { await page.clock.runFor(5000); await sleep(40); }
  await msgHas('기다리기를 멈췄습니다');
  const n8 = snaps.length;
  check('8분 뒤 멈춤: 계속 준비될 수 있다는 안내·나중에 다시', (await msg()).includes('계속될 수 있습니다') && (await msg()).includes('결과 복구'), await msg());
  check(`조회 횟수 상한 (${n8}회 ≤ 96)`, n8 >= 90 && n8 <= 96, n8);
  await advance(60000);
  check('8분 뒤: 조회 더 없음, 만들기 1번, 생성 잠금', snaps.length === n8 && creates.length === 1 && (await disabled()));
  check('8분 뒤: 남은 조회 타이머 없음', (await liveLong()) === 0, await liveLong());

  // ── 마감은 처음 202 부터의 절대 시각. 조회만 페이지 안 가짜 fetch 로 바꿔 abort 를 무시하는 서버를 흉내 낸다 ──
  // (만들기 등 나머지는 원래 fetch → route). 신호는 window.__fs.sigs 에 모은다
  const fakeSnap = (mode) => page.evaluate((mode) => {
    const real = window.__realFetch || (window.__realFetch = window.fetch);
    const fs = window.__fs = { calls: [], sigs: [], resolve: null };
    const res = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } });
    const name = 'gw-lab-v4-2c8g10d';
    window.fetch = (u, o = {}) => {
      if (String(u) !== '/api/lab/snapshot') return real(u, o);
      fs.calls.push({ u: String(u), method: o.method, token: (o.headers || {})['x-admin-token'] ?? null, body: o.body, signal: o.signal instanceof AbortSignal });
      fs.sigs.push(o.signal);
      if (mode.kind === 'hang') return new Promise(() => {});
      if (mode.kind === 'manual') return new Promise((f) => { fs.resolve = (b) => f(res(b)); });
      // lateReady: 마감 전까지는 바로 준비 중, 그 뒤 조회는 abort 를 무시하고 readyAt 에 준비됨으로 답한다
      if (Date.now() < mode.slowFrom) return Promise.resolve(res({ snapshotPreparing: true, snapshot: name, state: 'building' }, 202));
      return new Promise((f) => setTimeout(() => f(res({ snapshotReady: true, snapshot: name })), mode.readyAt - Date.now()));
    };
  }, mode);
  const restoreFetch = () => page.evaluate(() => { if (window.__realFetch) window.fetch = window.__realFetch; });
  const fsCalls = () => page.evaluate(() => window.__fs.calls);
  const aborted = () => page.evaluate(() => window.__fs.sigs.map((s) => !!(s && s.aborted)));
  const pageNow = () => page.evaluate(() => Date.now());

  console.log('조회가 응답하지 않음 (abort 무시)');
  await fresh(LONG);
  await startPending();
  let t0 = await pageNow();
  await fakeSnap({ kind: 'hang' });
  await advance(5100);
  let fc = await fsCalls();
  check('응답 없는 조회: 같은 출처 POST·관리 토큰·고정한 네 칸·신호', fc.length === 1 && fc[0].u === '/api/lab/snapshot' && fc[0].method === 'POST' && fc[0].token === TOKEN && fc[0].body === J({ snapshot: 'gw-lab-v4', cpu: 2, memory: 8, disk: 10 }) && fc[0].signal, J(fc));
  check('응답 없는 조회: 기다리는 동안 버튼 꺼짐·아직 안 끊음', (await disabled()) && J(await aborted()) === J([false]));
  await advance(t0 + 8 * 60000 - 1 - (await pageNow()));
  check('마감 1ms 전: 아직 기다림', (await disabled()) && J(await aborted()) === J([false]) && !(await msg()).includes('멈췄습니다'), await msg());
  await advance(1);
  await msgHas('기다리기를 멈췄습니다');
  check('마감: 조회 신호 끊음·생성 잠금·만들기 1번·조회 1번', J(await aborted()) === J([true]) && (await disabled()) && creates.length === 1 && (await fsCalls()).length === 1, J({ a: await aborted(), c: creates.length }));
  check('마감 문구: 아직 안 만듦·나중에 다시', (await msg()).includes('수업은 아직 만들지 않았습니다') && (await msg()).includes('결과 복구'), await msg());
  await advance(5 * 60000);
  check('마감 뒤: 조회·만들기 더 없음, 남은 조회 타이머 없음', (await fsCalls()).length === 1 && creates.length === 1 && (await liveLong()) === 0, J({ f: (await fsCalls()).length, c: creates.length, live: await liveLong() }));
  await restoreFetch();

  console.log('준비됨이 마감을 넘겨 도착 (abort 무시, 9분에 준비됨)');
  await fresh(LONG);
  await startPending();
  t0 = await pageNow();
  await fakeSnap({ kind: 'lateReady', slowFrom: t0 + 470000, readyAt: t0 + 540000 });
  for (let i = 0; i < 120 && !(await msg()).includes('기다리기를 멈췄습니다'); i++) { await page.clock.runFor(5000); await sleep(30); }
  await msgHas('기다리기를 멈췄습니다');
  check('마감에 멈춤 (8분 0초), 늦은 조회 신호 끊음', (await pageNow()) - t0 <= 8 * 60000 + 5000 && (await aborted()).at(-1) === true && (await disabled()), J({ dt: (await pageNow()) - t0 }));
  await advance(t0 + 10 * 60000 - (await pageNow()));
  check('9분에 온 준비됨으로 만들지 않음 (만들기 1번)', creates.length === 1 && !(await msg()).includes('만들었습니다') && (await msg()).includes('기다리기를 멈췄습니다'), J({ c: creates.length, m: await msg() }));
  check('늦은 준비됨 뒤: 조회 더 없음, 남은 조회 타이머 없음', (await fsCalls()).length === (await aborted()).length && (await liveLong()) === 0);
  await restoreFetch();

  console.log('잠든 사이 시계가 마감을 넘김');
  await fresh();
  await startPending();
  t0 = await pageNow();
  await fakeSnap({ kind: 'manual' });
  await page.clock.setSystemTime(t0 + 9 * 60000);   // 타이머는 안 돌고 시각만 넘어감 (노트북 잠자기)
  await advance(5100);
  await msgHas('기다리기를 멈췄습니다');
  check('깨어난 뒤 조회 없이 멈춤, 만들기 1번, 생성 잠금', (await fsCalls()).length === 0 && creates.length === 1 && (await disabled()), J({ f: (await fsCalls()).length, c: creates.length }));
  await restoreFetch();

  console.log('조회 응답을 기다리는 사이 시계가 마감을 넘김');
  await fresh();
  await startPending();
  t0 = await pageNow();
  await fakeSnap({ kind: 'manual' });
  await advance(5100);
  check('조회 1번 진행 중', (await fsCalls()).length === 1 && (await disabled()));
  await page.clock.setSystemTime(t0 + 9 * 60000);
  await page.evaluate(() => window.__fs.resolve({ snapshotReady: true, snapshot: 'gw-lab-v4-2c8g10d' }));
  await msgHas('기다리기를 멈췄습니다');
  await advance(60000);
  check('마감 뒤 온 준비됨으로 만들지 않음, 생성 잠금, 타이머 정리', creates.length === 1 && (await disabled()) && (await liveLong()) === 0, J({ c: creates.length, live: await liveLong() }));
  await restoreFetch();

  console.log('마감 전 준비됨은 그대로 (abort 무시 서버)');
  await fresh();
  await startPending();
  await fakeSnap({ kind: 'manual' });
  createQ.push({ status: 200, body: () => okLab('x') });
  await advance(5100);
  await page.evaluate(() => window.__fs.resolve({ snapshotReady: true, snapshot: 'gw-lab-v4-2c8g10d' }));
  await msgHas('만들었습니다');
  check('마감 전 준비됨: 마지막 만들기 1번, 신호 안 끊음, 타이머 정리', creates.length === 2 && J(creates[0]) === J(creates[1]) && J(await aborted()) === J([false]) && (await liveLong()) === 0, J({ c: creates.length, a: await aborted(), live: await liveLong() }));
  await advance(10 * 60000);
  check('끝난 뒤 마감 시각이 지나도 아무 일 없음', creates.length === 2 && (await fsCalls()).length === 1 && (await msg()).includes('만들었습니다'));
  await restoreFetch();

  console.log('처음 202 모양이 이상함');
  await fresh();
  createQ.push({ status: 202, body: { snapshotPreparing: true, snapshot: '<b onmouseover=x>', state: '<img src=x onerror=window.__pwn=5>' } });
  await page.click('#l_make');
  await msgHas('알아볼 수 없어');
  await advance(30000);
  check('조회 없음, 만들기 1번, 생성 잠금', snaps.length === 0 && creates.length === 1 && (await disabled()));
  await fresh();
  createQ.push({ status: 202, body: { snapshotPreparing: 'true', snapshot: 'gw-lab-v4-2c8g10d' } });
  await page.click('#l_make');
  await msgHas('알아볼 수 없어');
  check('snapshotPreparing 문자열: 멈춤', snaps.length === 0 && creates.length === 1 && (await disabled()));

  // 처음 202 이름은 눌렀을 때 고정한 기본 이름·사양에서 나온 이름이어야 한다 (모양만 맞는 다른 이름은 멈춤)
  for (const wrong of ['gw-lab-v4-2c8g', 'other-2c8g10d', 'gw-lab-v4-2c8g10d-x', 'gw-lab-v4-2c8g20d']) {
    await fresh();
    createQ.push(pend({ snapshot: wrong }));
    await page.click('#l_make');
    await msgHas('알아볼 수 없어');
    await advance(30000);
    check(`처음 202 이름 ${wrong}: 기대(gw-lab-v4-2c8g10d)와 달라 멈춤, 조회 없음`, snaps.length === 0 && creates.length === 1 && (await disabled()));
  }
  console.log('기본 이름을 비우면 서버 기본값: 뒷부분만 맞춤');
  await fresh();
  await page.fill('#l_snap', '');
  await startPending(pend({ snapshot: 'srv-default-2c8g10d' }));
  snapQ.push(ready({ snapshot: 'srv-default-2c8g10d' }));
  createQ.push({ status: 200, body: () => okLab('x') });
  await advance(5100);
  await msgHas('만들었습니다');
  check('빈 기본 이름: 조회 본문 snapshot "" 그대로, 마지막 만들기 1번', snaps.length === 1 && snaps[0].body.snapshot === '' && creates.length === 2 && J(creates[0]) === J(creates[1]), J({ s: snaps, c: creates.length }));
  await fresh();
  await page.fill('#l_snap', '');
  createQ.push(pend({ snapshot: '-2c8g10d' }));
  await page.click('#l_make');
  await msgHas('알아볼 수 없어');
  check('빈 기본 이름 + 뒷부분만 있는 이름: 멈춤', snaps.length === 0 && creates.length === 1);

  console.log('상태 문자열의 태그는 보이지 않음');
  await fresh();
  await startPending(pend({ state: '<img src=x onerror=window.__pwn=6>' }));
  check('상태가 이상하면 표시 안 함 (텍스트로만)', !(await msg()).includes('상태 ') && !(await msg()).includes('<'), await msg());
  snapQ.push({ status: 409, body: { error: 'stop' } });
  await advance(5100); await msgHas('스냅샷 준비 상태를 확인하지 못했습니다');

  console.log('처음 연결 끊김');
  await fresh();
  createQ.push('abort');
  await page.click('#l_make');
  await msgHas('결과를 모릅니다');
  await advance(30000);
  check('처음 끊김: 결과 미확정, 자동 조회·재전송 없음, 생성 잠금', snaps.length === 0 && creates.length === 1 && (await disabled()));

  console.log('마지막 만들기 연결 끊김');
  await fresh();
  await startPending();
  snapQ.push(ready());
  createQ.push('abort');
  await advance(5100);
  await msgHas('결과를 모릅니다');
  await advance(60000);
  check('마지막 끊김: 만들기 2번에서 멈춤 (자동 재시도 없음)', creates.length === 2 && snaps.length === 1 && (await disabled()), J({ c: creates.length, s: snaps.length }));
  check('마지막 끊김: 만들었다고 하지 않음', !(await msg()).includes('만들었습니다') && (await msg()).includes('만들기를 다시 보내지 않고'), await msg());

  console.log('마지막 만들기 오류·다시 202');
  await fresh();
  await startPending();
  snapQ.push(ready());
  createQ.push({ status: 409, body: { error: '한도 부족' } });
  await advance(5100);
  await msgHas('만들지 못했습니다: 한도 부족');
  check('마지막 409: 생성 잠금, 만들기 2번', (await disabled()) && creates.length === 2);
  await fresh();
  await startPending();
  snapQ.push(ready());
  createQ.push(pend());
  await advance(5100);
  await msgHas('아직 준비 중이라고');
  await advance(60000);
  check('마지막이 다시 202: 반복 없이 멈춤', creates.length === 2 && snaps.length === 1 && (await disabled()), J({ c: creates.length, s: snaps.length }));

  check('결과 문구는 텍스트로만 (요소·실행 없음)', await page.$eval('#l_msg', (e) => e.children.length) === 0 && await page.evaluate(() => window.__pwn) === 0);
  const st = teacher.filter((x) => x.p.endsWith('/status')), ses = teacher.filter((x) => x.p.endsWith('/session'));
  check(`모니터 계약: 처음 상태 확인 1번 (POST·빈 본문·관리 토큰 없음), 401 뒤 더 묻지 않음`, st.length === 1 && st[0].method === 'POST' && st[0].body === '{}' && st[0].token === null, J(st));
  check(`보안 키로 열 때마다 모니터 세션 요청 (POST·관리 토큰) — 로그인 ${logins}번`, logins >= 2 && ses.length === logins && ses.every((x) => x.method === 'POST' && x.token === TOKEN), J({ logins, ses }));
  check('흉내 안 된 요청 없음', unknown.length === 0, unknown.join(' '));
  check('페이지 오류 없음', errors.length === 0, errors.join(' | '));
  check('바깥 요청 없음', external.length === 0, external.join(' '));
  await ctx.close();
}

console.log(`\n${pass} ok, ${failN} fail, ${skipN} skip`);
process.exit(failN ? 1 : 0);
