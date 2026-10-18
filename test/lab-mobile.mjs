// /lab 수업 만들기 화면을 폰 크기(iPhone 15·Pixel 7 비슷하게)와 데스크톱에서 실제 브라우저(Edge, headless)로 돈다.
// Worker·SETUP_TOKEN·Daytona·네트워크 없이: 페이지는 src/pages.ts 를 그대로 그리고, /api 는 전부 route 로 흉내 낸다.
// 로그인 키 탭은 Chrome DevTools 가상 인증기 + 이 파일에서 만든 합성 자격 증명.
//   node test/lab-mobile.mjs
// 확인하는 것: 만드는 중·결과 문구가 만들기 버튼 바로 밑에 보이는지, 모든 자리가 실패한 수업은 QR·크게·초대를 숨기고
//              첫 오류를 보이는지, 일부만 실패하면 QR 은 남기고 실패를 요약하는지, 연결이 끊기면 작업 ID로 결과만 복구하고
//              명시적 새 입력 전까지 만들기를 잠그는지, 페이지 가로 스크롤이 없는지.

import { chromium, devices } from 'playwright-core';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { labPage, WEBAUTHN_JS } from '../src/pages.ts';

const ORIGIN = 'http://localhost:8799'; // route 로만 응답한다 (서버 없음). localhost 라 WebAuthn 이 된다
const SNAP_ERR = 'Daytona 400: Snapshot gw-lab-v4-1c2g not found';
const HTML_ERR = 'Daytona 502: <html><head><title>502</title></head><body><h1>Bad Gateway</h1><script>x()</script></body></html>';

let pass = 0, failN = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { failN++; console.log(`  FAIL ${name} ${extra}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64u = (b) => Buffer.from(b).toString('base64url');

// 강사 앱 머리의 manifest·아이콘 (브라우저가 스스로 받을 수 있다). 이 둘만 GET 404 로 받고 나머지 모르는 경로는 그대로 실패로 센다
const TEACHER_HEAD = new Set(['/__teacher/manifest.webmanifest', '/__teacher/icon-192.png']);
const QR = '<svg data-qr="1" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';
let seq = 0;
function mkLab(name, errors) {
  const id = 'lab' + (++seq);
  return {
    id, name, createdAt: Date.now(), expiresAt: Date.now() + 3 * 3600e3, budget: 2, cpu: 1, memory: 2, disk: 5, snapshot: 'gw-lab-v4', model: 'test/model',
    clip: { in: true, out: true }, share: [], ending: false,
    seats: errors.map((error, i) => error
      ? { n: i + 1, error }
      : { n: i + 1, sandboxId: `sb${i}`, state: 'started', presence: { state: 'none' } }),
  };
}

const summary=l=>({id:l.id,name:l.name,createdAt:l.createdAt,expiresAt:l.expiresAt,seatCount:l.seats.length,failedSeats:l.seats.filter(x=>x.error).length});

// 게이트웨이 흉내. create/list 응답을 잡아 둘 수 있다 (gate) — 진행 중 화면과 순서를 본다
function gateway() {
  const s = { invites: [], labs: [], create: null, createHits: 0, resultHits: 0, resultMode: 'ok', lastId: '', listHits: 0, listMode: 'ok', listGate: null, createGate: null, log: [], external: [], unknown: [], noAuth: 0, teacher: [], live: [] };
  s.handler = async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    if (u.origin !== ORIGIN) { s.external.push(req.url()); return route.abort(); }
    const p = u.pathname;
    const json = (o, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(o) });
    if (p === '/lab') return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: labPage() });
    if (p === '/webauthn.js') return route.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: WEBAUTHN_JS });
    if (p === '/api/admin/options') return json({ challenge: b64u(randomBytes(32)), rpId: 'localhost', allowCredentials: [{ type: 'public-key', id: s.credId }], userVerification: 'preferred', timeout: 60000 });
    if (p === '/api/admin/login') {
      const a = req.postDataJSON()?.assertion;
      // 관리 토큰은 진짜처럼 10분 (서버 시계 = 이 PC 시계)
      return a && a.id === s.credId && a.response?.signature ? json({ token: 'adm-test', expiresAt: Date.now() + 600000 }) : json({ error: 'bad' }, 401);
    }
    if (req.method() === 'GET' && TEACHER_HEAD.has(p)) return route.fulfill({ status: 404, body: '' });
    // 모니터 계약: 이 기기에 모니터 쿠키 없음(status 401), 모니터 세션은 만들지 못함(503) → 관리 토큰 화면만으로 돈다
    if (p === '/api/lab/teacher/status' || p === '/api/lab/teacher/session') {
      s.teacher.push({ p, method: req.method(), token: req.headers()['x-admin-token'] ?? null, body: req.postData() });
      return p.endsWith('/status') ? json({ error: '모니터 세션이 없습니다' }, 401) : json({ error: '모니터 세션을 만들 수 없습니다 (테스트)' }, 503);
    }
    // 레거시 픽스처가 빠뜨린 모임 화면. session 은 로그인 때 관리 토큰으로, status 는 boot 이 토큰 없이 친다. 401 이라 화면 세션은 열리지 않고 noAuth 로 세지 않는다.
    if (p === '/api/lab/live/session' || p === '/api/lab/live/status') {
      s.live.push({ p, method: req.method(), token: req.headers()['x-admin-token'] ?? null });
      return json({ error: 'no live fixture' }, 401);
    }
    if (p.startsWith('/api/lab/') && req.headers()['x-admin-token'] !== 'adm-test') { s.noAuth++; return json({ error: '관리 세션이 만료됐습니다.' }, 401); }
    if (p === '/api/lab/config') return json({ labOrigin: 'https://lab.example.test', quota: null, hours: [1, 2, 3], budgets: [1, 2, 5], daytona: true, openrouter: true, shareable: [], cfg: { gw: 'https://gw.example.test', snapshot: 'gw-lab-v4', model: 'test/model', clip: { in: true, out: true }, share: {} } });
    if (p === '/api/lab/control/status') return json({ mode: 'running', revision: 0, updatedAt: Date.now() });
    if (p === '/api/lab/list') {
      s.listHits++; s.log.push('list');
      if (s.listGate) await s.listGate;
      if (s.listMode === 'abort') return route.abort('internetdisconnected');
      return json({ labs: [...s.labs].reverse(), quota: null, now: Date.now() });
    }
    if (p === '/api/lab/create') {
      s.createHits++; s.log.push('create'); s.lastId=req.postDataJSON().requestId;
      if (s.createGate) await s.createGate;
      return s.create(route, req.postDataJSON(), (o, status=200) => o.lab ? json({ok:true,requestId:s.lastId,creationState:'completed',lab:summary(o.lab)},status) : json(o,status));
    }
    if (p === '/api/lab/create-status') {
      s.resultHits++; s.log.push('result');
      if(s.resultMode==='abort')return route.abort('failed');
      const lab=s.labs[s.labs.length-1];
      return lab?json({ok:true,requestId:s.lastId,creationState:'completed',lab:summary(lab)}):json({error:'not found'},404);
    }
    if (p === '/api/lab/invite') {
      // 자리 초대는 목록에 안 실리고 누를 때 받는다 (자리마다 다른 링크)
      const b = req.postDataJSON(); s.invites.push(b);
      const lab = s.labs.find((l) => l.id === b.id);
      const seats = (lab?.seats ?? []).filter((x) => !x.error).map((x) => ({ n: x.n, who: '', link: `https://lab.example.test/j/inv-${b.id}-${x.n}` }));
      if (b.n === undefined) return json({ name: lab?.name, seats });
      const one = seats.find((x) => x.n === b.n);
      return one ? json({ ...one, name: lab.name, qr: QR }) : json({ error: '없는 자리' }, 404);
    }
    if (p === '/api/lab/snips') return json({ v: 1, items: [] });
    if (p === '/api/lab/screen/status') return json({ screens: {} });
    if (p === '/api/lab/clip') { const b = req.postDataJSON(); return json({ clip: { in: b.in, out: b.out } }); }
    s.unknown.push(p);
    return json({ error: 'not mocked' }, 404);
  };
  return s;
}

const browser = await chromium.launch({ channel: 'msedge', headless: true });

async function open(device) {
  const { defaultBrowserType: _d, ...opts } = device;
  const ctx = await browser.newContext(opts);
  const gw = gateway();
  await ctx.route('**/*', gw.handler);
  const page = await ctx.newPage();
  page.on('dialog', (d) => d.accept());
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // 합성 WebAuthn: 가상 인증기에 이 테스트가 만든 P-256 자격 증명을 넣는다
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'usb', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  });
  const credId = randomBytes(16);
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  await cdp.send('WebAuthn.addCredential', {
    authenticatorId,
    credential: { credentialId: credId.toString('base64'), isResidentCredential: false, rpId: 'localhost', privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'), signCount: 0 },
  });
  gw.credId = b64u(credId);
  await page.goto(`${ORIGIN}/lab`);
  await page.click('#go');
  await page.waitForSelector('#panel:not([hidden])', { timeout: 15000 });
  await page.waitForFunction(() => document.querySelector('#labs').textContent.length > 0);
  await page.click('#navPrep');
  if (!(await page.$eval('#newLab', (e) => e.open))) await page.click('#newLab > summary');
  await page.fill('#l_name', 'mobile test');
  const st = gw.teacher.filter((x) => x.p.endsWith('/status')), ses = gw.teacher.filter((x) => x.p.endsWith('/session'));
  check(`${device.viewport.width}px 열기: 모니터 계약 — 처음 상태 1번 (POST·빈 본문·관리 토큰 없음), 로그인 세션 1번 (POST·관리 토큰)`, st.length === 1 && st[0].method === 'POST' && st[0].body === '{}' && st[0].token === null && ses.length === 1 && ses[0].method === 'POST' && ses[0].token === 'adm-test', JSON.stringify(gw.teacher));
  const liveSes = gw.live.filter((x) => x.p === '/api/lab/live/session'), liveSt = gw.live.filter((x) => x.p === '/api/lab/live/status');
  check(`${device.viewport.width}px 열기: 화면 세션은 명시적 401 — session 1번 (POST·관리 토큰), status 는 토큰 없이 401`, liveSes.length === 1 && liveSes[0].method === 'POST' && liveSes[0].token === 'adm-test' && liveSt.length === 1 && liveSt[0].method === 'POST' && liveSt[0].token === null, JSON.stringify(gw.live));
  return { ctx, page, gw, errors };
}

const statusText = (page) => page.locator('#l_msg').textContent();
const waitStatus = (page, frag) => page.waitForFunction((f) => document.getElementById('l_msg').textContent.includes(f), frag, { timeout: 15000 });
// 상태 문구가 화면 안 + 만들기 버튼 바로 밑인지, 페이지 가로 스크롤이 없는지
const geo = (page) => page.evaluate(() => {
  const b = document.getElementById('l_make').getBoundingClientRect(), m = document.getElementById('l_msg').getBoundingClientRect(), g = document.getElementById('msg').getBoundingClientRect();
  const el = document.getElementById('l_msg');
  return { gap: m.top - b.bottom, inView: m.top >= 0 && m.bottom <= innerHeight && m.height > 0, sw: document.documentElement.scrollWidth, vw: innerWidth, globalTop: g.top + scrollY, role: el.getAttribute('role'), live: el.getAttribute('aria-live') };
});
function checkNear(tag, g) {
  check(`${tag}: 상태가 화면 안`, g.inView, JSON.stringify(g));
  check(`${tag}: 상태가 만들기 버튼 바로 밑 (0~24px)`, g.gap >= 0 && g.gap <= 24, `gap=${g.gap}`);
}
const noOverflow = (tag, g) => check(`${tag}: 페이지 가로 스크롤 없음`, g.sw <= g.vw, `scrollWidth=${g.sw} innerWidth=${g.vw}`);
// 카드 안의 공유 수단 (자리별 초대(QR 크게)·초대 링크 모두 복사·자리 링크 복사·코드 보내기). 수업 하나짜리 QR 은 없다 (#14)
const cardInfo = (page, name) => page.evaluate((n) => {
  const sel = document.querySelector('#roomSelect');
  const opt = sel && [...sel.options].find((o) => o.textContent === n);
  const c = opt && document.querySelector('#labs > [data-lab="' + CSS.escape(opt.value) + '"]');
  if (!c) return null;
  const btns = [...c.querySelectorAll('button')].map((b) => b.textContent);
  return {
    failAll: c.dataset.labFail === 'all', note: c.querySelector('[data-fail-note]')?.textContent ?? '', qr: !!c.querySelector('[data-invites]'), classQr: !!c.querySelector('.qr svg'),
    big: btns.includes('초대'), copy: btns.includes('초대 링크 모두 복사'), seatLink: btns.includes('링크 복사'), snip: !!c.querySelector('[data-snip]'),
    rawHtml: c.innerHTML.includes('&lt;html') || c.textContent.includes('<html'),
  };
}, name);
// 만든 뒤 모임 도구는 #navRun 이다. 닫힌 details 를 연 뒤에만 누른다.
async function openRunSection(page, label) {
  await page.click('#navRun');
  const det = page.locator('#labs details[data-lab-section="' + label + '"]');
  await det.waitFor({ state: 'attached' });
  if (!(await det.evaluate((e) => e.open))) await det.locator('summary').click();
}

async function scenarios(label, device) {
  console.log(`\n# ${label} (${device.viewport.width}×${device.viewport.height})`);

  // 1) 모든 자리 실패
  {
    const { ctx, page, gw, errors } = await open(device);
    const g0 = await geo(page);
    check(`${label}: 상태 요소 role=status aria-live=polite`, g0.role === 'status' && g0.live === 'polite');
    let release; gw.createGate = new Promise((r) => (release = r));
    gw.create = (route, body, json) => { const lab = mkLab(body.name, [SNAP_ERR, HTML_ERR]); gw.labs.push(lab); return json({ ok: true, lab }); };
    await page.click('#l_make');
    await waitStatus(page, '만드는 중');
    const gp = await geo(page);
    checkNear(`${label} 만드는 중`, gp);
    check(`${label}: 만드는 중엔 버튼 꺼짐`, await page.locator('#l_make').isDisabled());
    release();
    await waitStatus(page, '하나도');
    await page.waitForFunction(() => document.querySelector('#labs .card[data-lab-fail=all]'));
    const g = await geo(page);
    checkNear(`${label} 전부 실패`, g);
    const st = await statusText(page);
    check(`${label}: 전부 실패 → 정리 안내 (원문 오류는 카드에서)`, st.includes('정리하세요') && !st.includes(SNAP_ERR), st);
    check(`${label}: 상태 문구 클래스 bad`, (await page.locator('#l_msg').getAttribute('class')) === 'bad');
    const ci = await cardInfo(page, 'mobile test');
    check(`${label}: 실패 카드는 남김 (확인·끝내기용)`, !!ci && ci.failAll && (await page.locator('#labs .card[data-lab-fail=all] button', { hasText: '지금 끝내기' }).count()) === 1);
    check(`${label}: 실패 카드에 첫 오류`, ci?.note.includes(SNAP_ERR), ci?.note);
    check(`${label}: 실패 카드에 초대(QR)·모두 복사·자리 링크·코드 보내기 없음`, ci && !ci.qr && !ci.big && !ci.copy && !ci.seatLink && !ci.snip, JSON.stringify(ci));
    check(`${label}: 자리 표에도 HTML 원문 없음`, ci && !ci.rawHtml);
    const topMsg = await page.locator('#msg').textContent();
    check(`${label}: 만들기 결과는 #l_msg 만, #msg 는 화면 세션 거절 (목록 아래 ${Math.round(g.globalTop)}px)`, !topMsg.includes('정리하세요') && !topMsg.includes(SNAP_ERR) && !topMsg.includes('만들었습니다') && topMsg.includes('모임 화면 세션을 열지 못했습니다'), topMsg);
    noOverflow(`${label} 전부 실패`, g);
    // 목록 다시 불러오기에서도 같은 판단. 자리 표는 닫힌 참여자 안에 있어, 연 뒤 가로 스크롤을 본다.
    await openRunSection(page, '참여자');
    noOverflow(`${label} 전부 실패 펼친 자리표`, await geo(page));
    await openRunSection(page, '마무리');
    const before = gw.listHits;
    await page.locator('#labs .card[data-lab-fail=all] button', { hasText: '새로고침' }).click();
    for (let i = 0; i < 50 && gw.listHits === before; i++) await sleep(50);
    await sleep(300);
    const ci2 = await cardInfo(page, 'mobile test');
    check(`${label}: 새로고침 뒤에도 QR·초대 숨김 + 첫 오류`, gw.listHits > before && ci2 && ci2.failAll && !ci2.qr && !ci2.big && ci2.note.includes(SNAP_ERR), JSON.stringify(ci2));
    check(`${label}: create 1회`, gw.createHits === 1);
    check(`${label}: 페이지 오류·외부 요청·흉내 안 된 API 없음`, !errors.length && !gw.external.length && !gw.unknown.length && !gw.noAuth, JSON.stringify([errors, gw.external, gw.unknown]));
    await ctx.close();
  }

  // 2) 일부 실패 — 공유 수단은 그대로, 실패는 요약
  {
    const { ctx, page, gw, errors } = await open(device);
    gw.create = (route, body, json) => { const lab = mkLab(body.name, [HTML_ERR, null, null]); gw.labs.push(lab); return json({ ok: true, lab }); };
    await page.click('#l_make');
    await waitStatus(page, '만들었습니다');
    await page.waitForFunction(() => document.querySelector('#labs .card [data-invites]'));
    const g = await geo(page);
    checkNear(`${label} 일부 실패`, g);
    const st = await statusText(page);
    check(`${label}: 일부 실패 요약 (1/3, 카드 확인)`, st.includes('1/3자리 실패') && st.includes('수업 카드'), st);
    check(`${label}: 복구 요약에는 공급자 원문 없음`, !st.includes('Daytona 502') && !st.includes('<') && !st.includes('x()'), st);
    const ci = await cardInfo(page, 'mobile test');
    check(`${label}: 일부 실패 카드는 초대(QR)·모두 복사·자리 링크 그대로, 수업 QR 없음`, ci && !ci.failAll && !ci.classQr && ci.qr && ci.big && ci.copy && ci.seatLink && ci.snip, JSON.stringify(ci));
    check(`${label}: 일부 실패 카드에 실패 요약`, ci?.note.includes('1/3자리 실패') && ci.note.includes('Daytona 502'), ci?.note);
    check(`${label}: 카드에 HTML 원문 없음`, ci && !ci.rawHtml);
    noOverflow(`${label} 일부 실패 (QR·자리 표)`, g);
    await openRunSection(page, '참여자');
    await openRunSection(page, '초대');
    noOverflow(`${label} 일부 실패 펼친 자리표`, await geo(page));
    check(`${label}: 페이지 오류·외부 요청 없음`, !errors.length && !gw.external.length && !gw.unknown.length, JSON.stringify([errors, gw.external, gw.unknown]));
    await ctx.close();
  }

  // 미확정 생성은 결과 조회만. 조회가 실패해도 생성은 재전송하지 않는다.
  for(const failedLookup of [false,true]) {
    const {ctx,page,gw,errors}=await open(device);
    gw.create=(route,body)=>{gw.labs.push(mkLab(body.name,[null,null]));return route.abort('internetdisconnected')};
    const before=gw.listHits;
    await page.click('#l_make'); await waitStatus(page,'이미 만들어졌을 수');
    check(`${label}: 끊김 뒤 생성 잠금·목록 대신 명시적 결과 복구`,await page.locator('#l_make').isDisabled()&&gw.listHits===before&&await page.locator('#l_recheck').isVisible());
    checkNear(`${label} 끊김`,await geo(page));
    if(failedLookup){gw.resultMode='abort';await page.click('#l_recheck');await waitStatus(page,'복구하지 못했습니다');
      check(`${label}: 결과 조회 실패도 생성 잠금`,await page.locator('#l_make').isDisabled());gw.resultMode='ok';}
    await page.click('#l_recheck'); await waitStatus(page,'만들었습니다');
    await page.waitForFunction(()=>document.querySelector('#labs .card [data-invites]'));
    check(`${label}: 복구 완료는 목록 표시·새 입력 버튼, 자동 생성 없음`,gw.createHits===1&&gw.resultHits===(failedLookup?2:1)&&await page.locator('#l_make').isDisabled()&&await page.locator('#l_new').isVisible());
    checkNear(`${label} 복구 완료`,await geo(page)); noOverflow(`${label} 복구`,await geo(page));
    await page.click('#l_new');check(`${label}: 명시적 새 입력 뒤 만들기 가능`,!(await page.locator('#l_make').isDisabled()));
    await openRunSection(page, '참여자');
    noOverflow(`${label} 복구 펼친 자리표`, await geo(page));
    check(`${label}: 페이지 오류·흉내 안 된 API 없음`,!errors.length&&!gw.unknown.length);await ctx.close();
  }

  // 5) 서버 거절 — 오류를 알리고 기록 404를 확인한 뒤 명시적 새 입력
  {
    const { ctx, page, gw, errors } = await open(device);
    gw.create = (route, body, json) => json({ error: '스냅샷 이름이 이상합니다' }, 400);
    const before = gw.listHits;
    await page.click('#l_make');
    await waitStatus(page, '만들지 못했습니다');
    check(`${label}: 서버 거절 문구 그대로·생성 기록 확인 전 잠금`, (await statusText(page)).includes('스냅샷 이름이 이상합니다') && gw.listHits === before && await page.locator('#l_make').isDisabled());
    await page.click('#l_recheck');await waitStatus(page,'생성 기록이 없습니다');await page.click('#l_new');check(`${label}: 404 확인·명시적 새 입력 뒤 가능`,!(await page.locator('#l_make').isDisabled()));
    checkNear(`${label} 거절`, await geo(page));
    check(`${label}: 페이지 오류 없음`, !errors.length && !gw.unknown.length);
    await ctx.close();
  }
}

await scenarios('iPhone 15', devices['iPhone 15']);
await scenarios('Pixel 7', devices['Pixel 7']);

// 데스크톱: 하던 대로 — 성공하면 QR·크게, 다른 조작(클립보드)은 예전 #msg
{
  const desk = { viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1, isMobile: false, hasTouch: false };
  console.log('\n# 데스크톱 (1280×900)');
  const { ctx, page, gw, errors } = await open(desk);
  gw.create = (route, body, json) => { const lab = mkLab(body.name, [null, null]); gw.labs.push(lab); return json({ ok: true, lab }); };
  await page.click('#l_make');
  await waitStatus(page, '만들었습니다');
  await page.waitForFunction(() => document.querySelector('#labs .card [data-invites]'));
  const g = await geo(page);
  checkNear('데스크톱 성공', g);
  check('데스크톱: 상태 클래스 ok', (await page.locator('#l_msg').getAttribute('class')) === 'ok');
  const ci = await cardInfo(page, 'mobile test');
  check('데스크톱: 초대(QR)·모두 복사·자리 링크·코드 보내기·화면 공유, 수업 QR 없음', ci && !ci.classQr && ci.qr && ci.big && ci.copy && ci.seatLink && ci.snip && !ci.note && (await page.locator('#labs .card button', { hasText: '화면 공유 시작' }).count()) === 1, JSON.stringify(ci));
  check('데스크톱: 수정하지 않은 이름·자료는 비움', (await page.inputValue('#l_name')) === '' && (await page.inputValue('#l_mat')) === '');
  await openRunSection(page, '참여자');
  await page.locator('#labs .card button[data-invite="1"]').click();
  await page.waitForFunction(() => !document.getElementById('big').hidden);
  check('데스크톱: 1번 자리 초대 → 그 자리 QR·링크 크게', await page.locator('#big').isVisible() && (await page.locator('#bigQr svg').count()) === 1 && (await page.locator('#bigUrl').textContent()).endsWith('/j/inv-lab' + seq + '-1') && gw.invites.some((x) => x.n === 1), await page.locator('#bigUrl').textContent());
  await page.click('#bigClose');
  await openRunSection(page, '모델 · 자원 · 클립보드');
  await page.locator('#labs .card label', { hasText: '실습실 → 내 PC 복사' }).locator('input').uncheck();
  await page.waitForFunction(() => document.getElementById('msg').textContent.includes('클립보드'));
  check('데스크톱: 클립보드 같은 다른 조작은 예전 #msg 그대로', (await page.locator('#msg').textContent()).includes('밖으로 복사 막음'));
  noOverflow('데스크톱', await geo(page));
  check('데스크톱: 페이지 오류·외부 요청 없음', !errors.length && !gw.external.length && !gw.unknown.length, JSON.stringify([errors, gw.external, gw.unknown]));
  await ctx.close();
}

await browser.close();
console.log(`\n${pass} passed, ${failN} failed, 0 skipped\n`);
process.exit(failN ? 1 : 0);
