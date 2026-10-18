// /lab 강사 화면(수업 카드 그리기)을 실제 브라우저(Edge, headless)에서 돌려 동작을 고정한다 — 그리는 코드를 옮겨도 같아야 한다.
// Worker·Daytona·SFU·네트워크 없이: 페이지는 labPage() 를 그대로 쓰고, /api 는 전부 route 로 흉내 낸다. 외부·모르는 요청은 막고 실패로 센다.
// 로그인은 Chrome DevTools 가상 인증기 + 이 파일에서 만든 합성 자격 증명 (관리 토큰은 이 파일의 TOKEN, 메모리에만 있어야 한다).
//   node test/lab-renderer-parity.mjs
//   LAB_PAGES=<다른 pages.ts 경로> node test/lab-renderer-parity.mjs   (변형 확인용: 다른 사본의 labPage 로 같은 검사를 돈다)
// 확인하는 것: 적대적 문자열은 글자로만, 관리 토큰은 저장하지 않음, 목록엔 초대 없음·그리기만으로 초대 RPC 없음, 실패 자리·전부 실패 카드,
//              자리 초대 크게(서버 QR)와 조용한 새로고침, 들어가 보기(확인·미리 연 탭·opener 끊기·실패 정리), 클립보드·키 나눔 되돌리기,
//              손·상태·서버 시계, 코드 보내기 초안·포커스·끝내는 중, 실패한 수업의 내 화면 공유 줄, 새로고침·끝내기 요청 헤더.

import { chromium } from 'playwright-core';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const PAGES = process.env.LAB_PAGES ? pathToFileURL(resolve(process.env.LAB_PAGES)).href : new URL('../src/pages.ts', import.meta.url).href;
const { labPage, WEBAUTHN_JS } = await import(PAGES);

const ORIGIN = 'http://localhost:8799'; // route 로만 응답한다 (서버 없음)
const TOKEN = 'adm-parity-' + randomBytes(6).toString('hex');
const HOST = '<img src=x onerror="window.__pwn=1"><script>window.__pwn=2</script><svg onload="window.__pwn=3"></svg><img src="https://evil.test/p.png">';
const HTML_ERR = 'Daytona 502: <html><body><img src=x onerror="window.__pwn=9"><script>window.__pwn=8</script><h1>Bad Gateway</h1></body></html>';
const QR = '<svg data-qr="1" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';
// 강사 앱 머리의 manifest·아이콘 (브라우저가 스스로 받을 수 있다). 이 둘만 GET 404 로 받고 나머지 모르는 경로는 그대로 실패로 센다
const TEACHER_HEAD = new Set(['/__teacher/manifest.webmanifest', '/__teacher/icon-192.png']);
const LINK = (id, n) => `https://lab.example.test/j/inv-${id}-${n}`;

let pass = 0, failN = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { failN++; console.log(`  FAIL ${name} ${extra}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await f()) return true; await sleep(50); } return false; };
const b64u = (b) => Buffer.from(b).toString('base64url');
const eq = isDeepStrictEqual;
const J = JSON.stringify;

const okSeat = (n, x = {}) => ({ n, sandboxId: 'sb' + n, state: 'started', presence: { state: 'none' }, ...x });
const mkLab = (id, name, seats, x = {}) => ({
  id, name, createdAt: Date.now(), expiresAt: Date.now() + 3 * 3600e3, budget: 2, cpu: 1, memory: 2, disk: 5, snapshot: 'gw-lab-v4', model: 'test/model',
  clip: { in: true, out: true }, share: [], ending: false, seats, ...x,
});

// 게이트웨이 흉내. /api/lab/* 는 전부 기록(reqs)하고 관리 토큰 헤더를 본다. fail[key]: 그 API 를 500 으로, gate[key]: 응답을 잡아 둔다
function gateway(labs) {
  const s = { labs, reqs: [], external: [], unknown: [], noAuth: 0, offset: 0, fail: {}, gate: {}, snips: {}, screens: {}, listHook: null, sn: 0, teacher: [], live: [] };
  s.hits = (k) => s.reqs.filter((r) => r.k === k);
  s.handler = async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    if (u.origin !== ORIGIN) { s.external.push(req.url()); return route.abort('blockedbyclient'); }
    const p = u.pathname, h = req.headers();
    let body; try { body = req.postDataJSON(); } catch { body = req.postData(); }
    const json = (o, status = 200) => route.fulfill({ status, contentType: 'application/json', body: J(o) });
    if (p === '/lab') return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: labPage() });
    if (p === '/webauthn.js') return route.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: WEBAUTHN_JS });
    if (p === '/api/admin/options') return json({ challenge: b64u(randomBytes(32)), rpId: 'localhost', allowCredentials: [{ type: 'public-key', id: s.credId }], userVerification: 'preferred', timeout: 60000 });
    // 관리 토큰은 진짜처럼 서버 시계(offset 포함) 기준 10분
    if (p === '/api/admin/login') return body?.assertion?.id === s.credId && body.assertion.response?.signature ? json({ token: TOKEN, expiresAt: Date.now() + s.offset + 600000 }) : json({ error: 'bad' }, 401);
    if (req.method() === 'GET' && TEACHER_HEAD.has(p)) return route.fulfill({ status: 404, body: '' });
    // 모니터 계약: 이 기기에 모니터 쿠키 없음(status 401), 모니터 세션은 만들지 못함(503) → 관리 토큰 화면만으로 돈다. /api/lab 관리 요청(reqs)과 따로 센다
    if (p === '/api/lab/teacher/status' || p === '/api/lab/teacher/session') {
      s.teacher.push({ p, method: req.method(), token: h['x-admin-token'] ?? null, body });
      return p.endsWith('/status') ? json({ error: '모니터 세션이 없습니다' }, 401) : json({ error: '모니터 세션을 만들 수 없습니다 (테스트)' }, 503);
    }
    // 레거시 픽스처가 빠뜨린 모임 화면. session 은 로그인 때 관리 토큰으로 한 번, status 는 boot 이 토큰 없이 친다. 둘 다 401 이라 화면 세션은 열리지 않는다.
    if (p === '/api/lab/live/session' || p === '/api/lab/live/status') {
      s.live.push({ p, method: req.method(), token: h['x-admin-token'] ?? null });
      return json({ error: 'no live fixture' }, 401);
    }
    if (!p.startsWith('/api/lab/')) { s.unknown.push(p); return json({ error: 'not mocked' }, 404); }
    const k = p.slice('/api/lab/'.length);
    s.reqs.push({ k, method: req.method(), h, body, url: req.url() });
    if (h['x-admin-token'] !== TOKEN) { s.noAuth++; return json({ error: '관리 세션이 만료됐습니다.' }, 401); }
    if (s.gate[k]) await s.gate[k];
    if (s.fail[k]) return json({ error: s.fail[k] }, 500);
    const lab = s.labs.find((l) => l.id === body?.id);
    switch (k) {
      case 'control/status': return json({ mode: 'running', revision: 0, updatedAt: Date.now() });
      case 'config': return json({ labOrigin: 'https://lab.example.test', quota: null, hours: [1, 2, 3], budgets: [1, 2, 5], daytona: true, openrouter: true, shareable: [], cfg: { gw: 'https://gw.example.test', snapshot: 'gw-lab-v4', model: 'test/model', clip: { in: true, out: true }, share: {} } });
      case 'list': { const now = Date.now() + s.offset; const out = JSON.parse(J(s.labs)); s.listHook?.(out, now); return json({ labs: out, quota: null, now }); }
      case 'invite': {
        const seats = (lab?.seats ?? []).filter((x) => !x.error).map((x) => ({ n: x.n, who: x.who || '', link: LINK(body.id, x.n) }));
        if (body.n === undefined) return json({ name: lab?.name, seats });
        const one = seats.find((x) => x.n === body.n);
        return one ? json({ ...one, name: lab.name, qr: QR }) : json({ error: '없는 자리' }, 404);
      }
      case 'snips': return json(s.snips[body.id] || { v: 1, items: [] });
      case 'snip': { const c = s.snips[body.id] || { v: 1, items: [] }; s.snips[body.id] = { v: c.v + 1, items: [{ id: 'sn' + (++s.sn), at: Date.now(), title: body.title, text: body.text }, ...c.items] }; return json(s.snips[body.id]); }
      case 'snip-delete': { const c = s.snips[body.id] || { v: 1, items: [] }; s.snips[body.id] = { v: c.v + 1, items: body.snip === 'all' ? [] : c.items.filter((x) => x.id !== body.snip) }; return json(s.snips[body.id]); }
      case 'clip': lab.clip = { in: body.in, out: body.out }; return json({ clip: lab.clip });
      case 'share': { const x = lab.share.find((y) => y.id === body.provider); if ('on' in body) x.on = body.on; if ('cap' in body) x.cap = body.cap; return json({ share: { on: x.on, cap: x.cap } }); }
      case 'hand': { const seat = lab.seats.find((x) => x.n === body.n); delete seat.hand; return json({ ok: true }); }
      case 'end': return json({ ok: true });
      case 'screen/status': return json({ screens: s.screens });
      case 'screen/start': return json({ sdp: 'v=0 fake-answer', startedAt: Date.now() + s.offset });
      case 'screen/stop': return json({ ok: true });
    }
    s.unknown.push(p);
    return json({ error: 'not mocked' }, 404);
  };
  return s;
}

const browser = await chromium.launch({ channel: 'msedge', headless: true });

async function open(labs, { init, setup } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const gw = gateway(labs);
  setup?.(gw);
  await ctx.route('**/*', gw.handler);
  if (init) await ctx.addInitScript(init);
  const page = await ctx.newPage();
  const dialogs = [], answers = [];
  page.on('dialog', (d) => { dialogs.push(d.message()); (answers.shift() ?? 'accept') === 'accept' ? d.accept() : d.dismiss(); });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
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
  await page.waitForFunction((n) => {
    const sel = document.querySelector('#roomSelect');
    return !!sel && sel.options.length === n + 1 && document.querySelectorAll('#labs > [data-lab]').length === 1;
  }, labs.length, { timeout: 15000 });
  return { ctx, page, gw, errors, dialogs, answers };
}

// 그린 카드는 선택한 모임 하나. 이름은 카드 <b>가 아니라 #roomSelect 글자고, 카드는 data-lab 이다.
// 도구는 닫힌 details 다. 숨은 버튼을 onclick 으로 누르지 않고, 섹션을 연 뒤에만 누른다.
async function selectRoom(page, name) {
  const id = await page.locator('#roomSelect').evaluate((sel, n) => {
    const o = [...sel.options].find((x) => x.textContent === n);
    return o ? o.value : '';
  }, name);
  if (!id) throw new Error('모임 옵션 없음: ' + name);
  if ((await page.inputValue('#roomSelect')) !== id) await page.selectOption('#roomSelect', id);
  await page.waitForFunction((i) => document.querySelector('#labs > [data-lab]')?.dataset.lab === i, id);
  return id;
}
async function openSection(page, label) {
  const det = page.locator('#labs details[data-lab-section="' + label + '"]');
  await det.waitFor({ state: 'attached' });
  if (!(await det.evaluate((e) => e.open))) await det.locator('summary').click();
}
const card = async (page, name) => page.locator('#labs > [data-lab="' + (await selectRoom(page, name)) + '"]');
const seatRow = async (page, name, n) => (await card(page, name)).locator('tr').filter({ has: page.locator('td:first-child', { hasText: new RegExp(`^${n}번$`) }) });
const btnTexts = (loc) => loc.locator('button').allTextContents();
const msg = (page) => page.locator('#msg').textContent();
const waitHits = async (gw, k, n, ms) => until(() => gw.hits(k).length >= n, ms);
const last = (gw, k) => gw.hits(k).at(-1);

// 모든 장면 공통: 페이지 오류·외부 요청·흉내 안 된 API 없음, /api/lab 요청은 모두 POST + JSON + 관리 토큰 헤더, 토큰이 주소에 없음
function hygiene(tag, { gw, errors }) {
  check(`${tag}: 페이지 오류 없음`, !errors.length, J(errors));
  check(`${tag}: 외부·흉내 안 된 요청 없음`, !gw.external.length && !gw.unknown.length, J([gw.external, gw.unknown]));
  const bad = gw.reqs.filter((r) => r.method !== 'POST' || !String(r.h['content-type']).includes('application/json') || r.h['x-admin-token'] !== TOKEN || r.url.includes(TOKEN));
  const st = gw.teacher.filter((x) => x.p.endsWith('/status')), ses = gw.teacher.filter((x) => x.p.endsWith('/session'));
  check(`${tag}: 모니터 계약 — 처음 상태 1번 (POST·빈 본문·관리 토큰 없음), 로그인 세션 1번 (POST·관리 토큰)`, st.length === 1 && st[0].method === 'POST' && eq(st[0].body, {}) && st[0].token === null && ses.length === 1 && ses[0].method === 'POST' && ses[0].token === TOKEN, J(gw.teacher));
  const liveSes = gw.live.filter((x) => x.p === '/api/lab/live/session'), liveSt = gw.live.filter((x) => x.p === '/api/lab/live/status');
  check(`${tag}: 화면 세션은 명시적 401 — session 1번 (POST·관리 토큰), status 는 토큰 없이 401`, liveSes.length === 1 && liveSes[0].method === 'POST' && liveSes[0].token === TOKEN && liveSt.length === 1 && liveSt[0].method === 'POST' && liveSt[0].token === null, J(gw.live));
  check(`${tag}: /api/lab 요청 ${gw.reqs.length}개 모두 POST·JSON·토큰 헤더 (토큰 없는 요청 ${gw.noAuth})`, !bad.length && !gw.noAuth, J(bad.map((r) => [r.k, r.method, r.h['content-type'], !!r.h['x-admin-token']])));
}

// 1) 적대적 문자열은 글자로만 + 관리 토큰을 저장하지 않음
{
  console.log('\n# 적대적 문자열 · 토큰 저장');
  const lab = mkLab('X', HOST, [
    okSeat(1, { who: HOST, state: HOST, presence: { state: 'active' }, setup: { state: 'error', note: HOST }, err: { at: Date.now(), status: 500, n: 2, msg: HOST }, counts: { or: 1 }, usage: 0.5, limit: 2 }),
    { n: 2, error: HTML_ERR },
  ], { model: HOST, outage: HOST, stateError: HOST, materials: 'x', share: [{ id: 'or', label: HOST, envKey: 'K', cap: 5, on: true }] });
  const env = await open([lab]);
  const { page, gw, ctx } = env;
  gw.snips.X = { v: 2, items: [{ id: 's1', at: Date.now(), title: HOST, text: HOST }] };
  const hostile = await card(page, HOST);
  await openSection(page, '마무리');
  await hostile.locator('button', { hasText: '새로고침' }).click();
  await page.waitForFunction(() => document.querySelectorAll('#labs [data-snip] table tr').length === 1, null, { timeout: 8000 }).catch(() => {});
  await sleep(500);
  const scan = () => page.evaluate(() => ({
    pwn: window.__pwn,
    injected: document.querySelectorAll('#labs img, #labs script, #labs iframe, #labs object, #labs embed, #labs svg, #msg *, #bigName *, #bigUrl *, #bigCount *').length,
    onAttr: [...document.querySelectorAll('*')].filter((e) => [...e.attributes].some((a) => /^on/i.test(a.name))).map((e) => e.tagName),
    text: document.getElementById('labs').textContent,
  }));
  let r = await scan();
  check('적대: 이름·모델·상태 오류·전체 문제·이름표·자리 상태·자료 오류·키 이름·보낸 코드가 글자 그대로', r.text.split(HOST).length - 1 >= 10, `count=${r.text.split(HOST).length - 1}`);
  check('적대: 선택한 모임 이름·data-lab 이 글자 그대로', (await page.locator('#roomSelect option:checked').textContent()) === HOST && (await hostile.getAttribute('data-lab')) === 'X');
  check('적대: 요소·핸들러 주입 없음, 스크립트 안 돎', r.pwn === undefined && r.injected === 0 && !r.onAttr.length, J(r));
  const row2 = await (await seatRow(page, HOST, 2)).locator('td').nth(2).textContent(); // 실습실 칸: 실패면 태그 벗긴 오류 (키 나눔 칸엔 적대적 키 이름이 글자로 있다)
  check('적대: 실패 자리 오류는 태그 벗긴 글자 (Daytona 502 · Bad Gateway, <script 없음)', row2.includes('Daytona 502') && row2.includes('Bad Gateway') && !row2.includes('<') && !row2.includes('__pwn'), row2);
  check('적대: 그리기만으로 초대 RPC 없음, 목록 글자에 초대 링크 없음', !gw.hits('invite').length && !r.text.includes('lab.example.test'));
  gw.fail.list = HOST;
  await openSection(page, '마무리');
  await hostile.locator('button', { hasText: '새로고침' }).click();
  await until(async () => (await msg(page)).includes(HOST));
  check('적대: 실패한 API 오류 문구도 #msg 에 글자로', (await msg(page)).includes(HOST) && (await page.locator('#msg *').count()) === 0);
  delete gw.fail.list;
  await openSection(page, '참여자');
  await (await seatRow(page, HOST, 1)).locator('button', { hasText: /^초대$/ }).click();
  await page.waitForFunction(() => !document.getElementById('big').hidden);
  await sleep(300);
  r = await scan();
  check('적대: 크게 보기 이름은 글자, 서버 QR 은 그대로 SVG', (await page.locator('#bigName').textContent()).includes(HOST) && (await page.locator('#bigQr svg[data-qr]').count()) === 1 && r.pwn === undefined && r.injected === 0 && !r.onAttr.length, J(r));
  await page.click('#bigClose');
  // 토큰은 메모리에만: 저장소·쿠키·주소·IndexedDB·window.name 에 없다
  const store = await page.evaluate(async () => {
    const dump = (s) => { const o = {}; for (let i = 0; i < s.length; i++) o[s.key(i)] = s.getItem(s.key(i)); return JSON.stringify(o); };
    return { ls: dump(localStorage), ss: dump(sessionStorage), href: location.href, wn: window.name, ck: document.cookie, idb: indexedDB.databases ? (await indexedDB.databases()).map((d) => d.name) : [] };
  });
  const cookies = J(await ctx.cookies());
  check('토큰: localStorage·sessionStorage·쿠키·주소·window.name·IndexedDB 어디에도 없음', ![store.ls, store.ss, store.href, store.wn, store.ck, cookies].some((x) => x.includes(TOKEN)) && !store.idb.length, J(store));
  hygiene('적대', env);
  await ctx.close();
}

// 2) 실패 자리·전부 실패 카드, 자리 초대 크게(서버 QR), 크게 띄운 동안의 조용한 새로고침
{
  console.log('\n# 초대 · 실패 카드 · 크게 보기');
  const A = mkLab('A', 'A수업', [okSeat(1), okSeat(2), { n: 3, error: 'Daytona 400: Snapshot gw-lab-v4 not found' }]);
  const B = mkLab('B', 'B수업', [{ n: 1, error: 'Daytona 400: quota' }, { n: 2, error: 'Daytona 500: boom' }]);
  const env = await open([A, B]);
  const { page, gw, ctx } = env;
  const bCard = await card(page, 'B수업');
  await openSection(page, '마무리');
  await bCard.locator('button', { hasText: '새로고침' }).click();
  await waitHits(gw, 'list', 2);
  await sleep(300);
  check('목록 두 번 그려도 초대 RPC 없음', !gw.hits('invite').length, J(gw.hits('invite').map((r) => r.body)));
  for (const n of [1, 2]) check(`일부 실패: ${n}번 자리엔 초대·링크 복사·작업 공간 열기·도와주기`, eq(await btnTexts(await seatRow(page, 'A수업', n)), ['초대', '링크 복사', '작업 공간 열기', '도와주기']));
  check('일부 실패: 실패한 3번 자리엔 버튼 없음', (await (await seatRow(page, 'A수업', 3)).locator('button').count()) === 0);
  const aCard = await card(page, 'A수업');
  const a = await btnTexts(aCard);
  check('일부 실패: 모두 복사·코드 보내기 있음', a.includes('초대 링크 모두 복사') && (await aCard.locator('[data-snip] textarea').count()) === 1, J(a));
  const bNow = await card(page, 'B수업');
  const b = await btnTexts(bNow);
  const bt = await bNow.textContent();
  check('전부 실패: 초대·모두 복사·링크 복사·작업 공간 열기·코드 보내기·화면 공유 없음', !b.some((x) => /초대|링크 복사|들어가 보기|작업 공간 열기|도와주기|보내기|화면 공유/.test(x)) && (await bNow.locator('[data-snip] textarea').count()) === 0, J(b));
  check('전부 실패: 새로고침·지금 끝내기는 남음 + 첫 오류', b.includes('새로고침') && b.includes('지금 끝내기') && bt.includes('Daytona 400: quota'), J(b));
  // 크게 보기 전에 코드 보내기 초안을 쓰고 카드에 표시를 단다 — 조용한 새로고침이면 카드를 다시 그리지 않는다
  const aDraft = await card(page, 'A수업');
  await openSection(page, '코드 보내기');
  await aDraft.locator('[data-snip] textarea').fill('draft-A\n  line2');
  await page.locator('[data-lab="A"]').evaluate((c) => { c.__keep = 1; });
  await openSection(page, '참여자');
  await (await seatRow(page, 'A수업', 2)).locator('button', { hasText: /^초대$/ }).click();
  await page.waitForFunction(() => !document.getElementById('big').hidden);
  check('초대: 그 자리 하나만 요청 (id·n)', eq(gw.hits('invite').map((r) => r.body), [{ id: 'A', n: 2 }]), J(gw.hits('invite').map((r) => r.body)));
  check('초대: 서버 QR·주소(스킴 없음)·이름·번호 크게', (await page.locator('#bigQr svg[data-qr]').count()) === 1 && (await page.locator('#bigUrl').textContent()) === 'lab.example.test/j/inv-A-2' && (await page.locator('#bigName').textContent()).startsWith('A수업 · 2번') && (await page.locator('#big').isVisible()));
  check('초대: 입장 수 0 / 2', (await page.locator('#bigCount').textContent()) === '0 / 2 명 입장', await page.locator('#bigCount').textContent());
  A.seats[0].who = 'kim';
  const named = gw.hits('list').length;
  await waitHits(gw, 'list', named + 1, 9000);
  check('이름만 입력한 자리는 입장 수에 포함하지 않음', (await page.locator('#bigCount').textContent()) === '0 / 2 명 입장');
  A.seats[0].opened = Date.now();
  const lh = gw.hits('list').length;
  await waitHits(gw, 'list', lh + 1, 9000);
  await until(async () => (await page.locator('#bigCount').textContent()) === '1 / 2 명 입장', 3000);
  check('크게 보기 중 조용한 새로고침: 입장 수만 바뀜', (await page.locator('#bigCount').textContent()) === '1 / 2 명 입장' && gw.hits('list').length > lh);
  const kept = await page.locator('[data-lab="A"]').evaluate((c) => ({ keep: c.__keep, ta: c.querySelector('[data-snip] textarea')?.value ?? null, who: c.textContent.includes('kim') }));
  check('크게 보기 중: 카드를 다시 그리지 않음 (초안·표시 그대로, 새 이름표 아직 없음)', kept.keep === 1 && kept.ta === 'draft-A\n  line2' && !kept.who, J(kept));
  check('크게 보기 중: 초대 RPC 더 없음', gw.hits('invite').length === 1);
  await page.click('#bigClose');
  check('닫기: 크게 보기 숨김', !(await page.locator('#big').isVisible()));
  const aAfter = await card(page, 'A수업');
  await openSection(page, '마무리');
  await aAfter.locator('button', { hasText: '새로고침' }).click();
  await page.waitForFunction(() => document.getElementById('labs').textContent.includes('kim'));
  check('닫은 뒤 새로고침: 카드는 새로 그리고 코드 초안은 남음', (await aAfter.locator('[data-snip] textarea').inputValue()) === 'draft-A\n  line2');
  hygiene('초대', env);
  await ctx.close();
}

// 3) 들어가 보기: 확인 → 탭을 먼저 열고(팝업 차단 피함) → 초대 받은 뒤 opener 끊고 ?watch=1 로. 실패하면 연 탭을 닫는다
{
  console.log('\n# 들어가 보기');
  const env = await open([mkLab('A', 'A수업', [okSeat(1), okSeat(2)])]);
  const { page, gw, ctx, answers, dialogs } = env;
  await page.evaluate(() => {
    window.__opens = [];
    window.open = (u, t, f) => { const w = { u, t, f, opener: window, closed: false, location: { href: '' }, close() { this.closed = true; } }; window.__opens.push(w); return w; };
  });
  const opens = () => page.evaluate(() => window.__opens.map((w) => ({ u: w.u, t: w.t, f: w.f, openerNull: w.opener === null, href: w.location.href, closed: w.closed })));
  const watch = async (n) => { await openSection(page, '참여자'); await (await seatRow(page, 'A수업', n)).locator('button', { hasText: '작업 공간 열기' }).click(); };
  answers.push('dismiss');
  await watch(1);
  await sleep(400);
  check('보기: 확인 취소 → 탭·초대 없음', !(await opens()).length && !gw.hits('invite').length && dialogs.length === 1 && dialogs[0].includes('1번'), J(dialogs));
  let release; gw.gate.invite = new Promise((r) => (release = r));
  answers.push('accept');
  await watch(1);
  await waitHits(gw, 'invite', 1);
  let o = await opens();
  check('보기: 초대 응답 전에 빈 탭을 먼저 연다', o.length === 1 && o[0].u === 'about:blank' && o[0].href === '' && !o[0].closed, J(o));
  delete gw.gate.invite; release();
  await until(async () => (await opens())[0]?.href !== '');
  o = await opens();
  check('보기: opener 끊고 그 자리 초대 링크 ?watch=1 로', o[0].openerNull && o[0].href === LINK('A', 1) + '?watch=1' && !o[0].closed, J(o));
  check('보기: 초대 요청 본문 {id,n}', eq(last(gw, 'invite').body, { id: 'A', n: 1 }));
  gw.fail.invite = '초대 실패 테스트';
  answers.push('accept');
  await watch(2);
  await until(async () => (await opens())[1]?.closed);
  o = await opens();
  check('보기 실패: 미리 연 탭을 닫고 이동 안 함 + 오류 표시', o.length === 2 && o[1].closed && o[1].href === '' && (await msg(page)).includes('초대 실패 테스트') && (await page.locator('#msg').getAttribute('class')) === 'bad', J(o));
  check('보기: 크게 보기는 안 뜸', !(await page.locator('#big').isVisible()));
  hygiene('보기', env);
  await ctx.close();
}

// 4) 클립보드·키 나눔: 정확한 본문, 실패하면 되돌리고 옆 칸은 그대로
{
  console.log('\n# 클립보드 · 키 나눔');
  const env = await open([mkLab('A', 'A수업', [okSeat(1, { counts: { or: 3 } })], { share: [{ id: 'or', label: 'OpenAI', envKey: 'OPENAI_API_KEY', cap: 3, on: true }] })]);
  const { page, gw, ctx } = env;
  const aCard = await card(page, 'A수업');
  await openSection(page, '모델 · 자원 · 클립보드');
  const ck = (t) => aCard.locator('label', { hasText: t }).locator('input[type=checkbox]');
  const IN = () => ck('내 PC → 실습실 붙여넣기'), OUT = () => ck('실습실 → 내 PC 복사');
  const state = async () => [await IN().isChecked(), await OUT().isChecked()];
  const clipStep = async (tag, el, val, body, want) => {
    const n = gw.hits('clip').length;
    await el().setChecked(val);
    await waitHits(gw, 'clip', n + 1);
    await sleep(250);
    const s = await state();
    check(`클립 ${tag}: 본문 ${J(body)} · 칸 ${J(want)}`, eq(last(gw, 'clip').body, body) && eq(s, want), J([last(gw, 'clip').body, s]));
  };
  gw.fail.clip = '클립 실패 X';
  await clipStep('실패 → 되돌림', OUT, false, { id: 'A', in: true, out: false }, [true, true]);
  check('클립 실패: 오류 표시', (await msg(page)).includes('클립 실패 X'));
  delete gw.fail.clip;
  await clipStep('밖으로 막음', OUT, false, { id: 'A', in: true, out: false }, [true, false]);
  check('클립 성공 문구', (await msg(page)).includes('밖으로 복사 막음'));
  await clipStep('옆 칸(서버 확인값) 유지', IN, false, { id: 'A', in: false, out: false }, [false, false]);
  gw.fail.clip = '클립 실패 Y';
  await clipStep('다시 실패 → 되돌림, 옆 칸 유지', IN, true, { id: 'A', in: true, out: false }, [false, false]);
  delete gw.fail.clip;
  await clipStep('실패 뒤에도 확인값 기준', OUT, true, { id: 'A', in: false, out: true }, [false, true]);

  const row = aCard.locator('.row').filter({ has: page.locator('button', { hasText: '상한 저장' }) });
  const on = row.locator('input[type=checkbox]'), cap = row.locator('input[type=text]');
  check('키 나눔: 자리 표에 호출 수/상한, 상한 닿으면 bad', (await (await seatRow(page, 'A수업', 1)).locator('td.bad', { hasText: 'OpenAI 3/3' }).count()) === 1);
  const shareStep = async (tag, act, body, want) => {
    const n = gw.hits('share').length;
    await act();
    await waitHits(gw, 'share', n + 1);
    await sleep(250);
    const s = [await on.isChecked(), await cap.inputValue()];
    check(`키 나눔 ${tag}: 본문 ${J(body)} · ${J(want)}`, eq(last(gw, 'share').body, body) && eq(s, want), J([last(gw, 'share').body, s]));
  };
  await shareStep('끄기', () => on.setChecked(false), { id: 'A', provider: 'or', on: false }, [false, '3']);
  await shareStep('상한 저장', async () => { await cap.fill('250'); await row.locator('button', { hasText: '상한 저장' }).click(); }, { id: 'A', provider: 'or', cap: 250 }, [false, '250']);
  gw.fail.share = '나눔 실패';
  await shareStep('상한 실패 → 되돌림', async () => { await cap.fill('999'); await row.locator('button', { hasText: '상한 저장' }).click(); }, { id: 'A', provider: 'or', cap: 999 }, [false, '250']);
  await shareStep('켜기 실패 → 되돌림', () => on.setChecked(true), { id: 'A', provider: 'or', on: true }, [false, '250']);
  check('키 나눔 실패: 오류 표시', (await msg(page)).includes('나눔 실패'));
  hygiene('클립·나눔', env);
  await ctx.close();
}

// 5) 손·참가자 상태는 서버 시계(now) 기준, 새로고침·끝내기 요청
{
  console.log('\n# 손 · 상태 · 서버 시계 · 새로고침/끝내기');
  const A = mkLab('A', 'A수업', [
    okSeat(1, { who: '가', hand: true, presence: { state: 'active' }, lastAi: true }),
    okSeat(2, { who: '나', presence: { state: 'away', idleSec: 600 } }),
    okSeat(3, { who: '다', hand: true, presence: { state: 'offline' } }),
    okSeat(4, { opened: true }),
  ]);
  // 서버 시계가 이 PC 보다 2시간 빠르다. 시각은 서버 now 기준으로 보낸다 — PC 시계로 계산하면 '방금' 이 된다
  const clock = (gw) => { gw.offset = 2 * 3600e3; gw.listHook = (labs, now) => { for (const s of labs[0].seats) {
    if (s.hand) s.hand = now - 120e3;
    if (s.lastAi) s.lastAi = now - 180e3;
    if (s.opened) s.opened = now - 3600e3;
    if (s.presence.state === 'offline') s.presence.lastSeen = now - 600e3;
    s.files = s.n === 1 ? {at: now-120e3, verifiedAt: now-60e3} : s.n === 2 ? {at: now-30e3, verifiedAt: null} : s.n === 3 ? {at: now+60e3, verifiedAt: now+120e3} : null;
  } }; };
  const env = await open([A], { setup: clock });
  const { page, gw, ctx, answers, dialogs } = env;
  const rt = async (n) => (await (await seatRow(page, 'A수업', n)).textContent()) || '';
  const aCard = await card(page, 'A수업');
  const ct = await aCard.textContent();
  check('상태: 활동 중 + AI 3분 전 (서버 시계)', (await rt(1)).includes('🟢 활동 중 · AI 3분 전'), await rt(1));
  check('상태: 자리 비움 10분째', (await rt(2)).includes('🟡 자리 비움 · 10분째'), await rt(2));
  check('상태: 오프라인 10분 전 (서버 시계)', (await rt(3)).includes('⚫ 오프라인 · 10분 전'), await rt(3));
  check('상태: 입장했지만 신호 없음', (await rt(4)).includes('○ 신호 없음'), await rt(4));
  check('파일: 직접 확인 표시와 전송만 끝난 기록을 구분', (await rt(1)).includes('참여자 직접 확인 표시') && (await rt(2)).includes('ZIP 전송 기록') && (await rt(2)).includes('직접 확인 전'));
  check('파일: 미래 시각의 확인 표시는 신뢰하지 않음', (await rt(3)).includes('ZIP 전송 기록 확인 안 됨'));
  check('상태 요약 🟢1 🟡1 ⚫1 ○1', ct.includes('🟢 1 · 🟡 1 · ⚫ 1 · ○ 1'), ct);
  check('손: 탭 제목 ✋2 + 카드 손 든 사람 2명', (await page.title()) === '✋2 공부방 실습실' && ct.includes('손 든 사람 2명'), await page.title());
  const hb = (await seatRow(page, 'A수업', 1)).locator('button', { hasText: '✋' });
  check('손: 손 든 자리에만 내리기 버튼', (await hb.count()) === 1 && (await (await seatRow(page, 'A수업', 2)).locator('button', { hasText: '✋' }).count()) === 0);
  const lh = gw.hits('list').length;
  await openSection(page, '참여자');
  await hb.click();
  await page.waitForFunction(() => document.title.startsWith('✋1'));
  check('손 내리기: 본문 {id,n} 후 목록 다시', eq(last(gw, 'hand').body, { id: 'A', n: 1 }) && gw.hits('list').length > lh);
  const rf = gw.hits('list').length;
  await openSection(page, '마무리');
  await aCard.locator('button', { hasText: '새로고침' }).click();
  await waitHits(gw, 'list', rf + 1);
  check('새로고침: list 요청 (토큰 헤더)', last(gw, 'list').h['x-admin-token'] === TOKEN);
  answers.push('dismiss');
  await openSection(page, '마무리');
  await aCard.locator('button', { hasText: '지금 끝내기' }).click();
  await sleep(400);
  check('끝내기 취소: end 요청 없음', !gw.hits('end').length);
  check('끝내기: 미확인 3자리와 내부 보관본 삭제·나중 수정 안내', dialogs.at(-1).includes('3자리에 ZIP 직접 확인 표시') && dialogs.at(-1).includes('내부 체크포인트') && dialogs.at(-1).includes('확인 표시 이후 수정한 파일'));
  const le = gw.hits('list').length;
  answers.push('accept');
  await openSection(page, '마무리');
  await aCard.locator('button', { hasText: '지금 끝내기' }).click();
  await waitHits(gw, 'end', 1);
  await waitHits(gw, 'list', le + 1);
  const e = last(gw, 'end');
  check('끝내기: POST {id} + 토큰·JSON 헤더, 뒤에 목록 다시', eq(e.body, { id: 'A' }) && e.method === 'POST' && e.h['x-admin-token'] === TOKEN && e.h['content-type'].includes('application/json') && gw.hits('list').length > le);
  await until(async () => (await msg(page)).includes('끝냈습니다'));
  check('끝내기: 완료 문구', (await msg(page)).includes('끝냈습니다'));
  hygiene('손·상태', env);
  await ctx.close();
}

// 6) 코드 보내기: 15초 새로고침에도 초안·포커스 유지, Ctrl+Enter 보내기, 지우기, 끝내는 중이면 숨김
{
  console.log('\n# 코드 보내기 (15초 새로고침 기다림)');
  const env = await open([mkLab('A', 'A수업', [okSeat(1)])]);
  const { page, gw, ctx } = env;
  gw.snips.A = { v: 3, items: [{ id: 'o1', at: Date.now(), title: '', text: 'echo 1' }, { id: 'o2', at: Date.now(), title: 't2', text: 'echo 2' }] };
  const aCard = await card(page, 'A수업');
  await openSection(page, '코드 보내기');
  const ta = () => aCard.locator('[data-snip] textarea');
  const ti = () => aCard.locator('[data-snip] input[type=text]');
  await ti().fill('T1');
  await ta().click();
  await page.keyboard.type('npm i\n  x');
  const lh = gw.hits('list').length;
  await waitHits(gw, 'list', lh + 1, 20000);
  await sleep(500);
  const f = await page.evaluate(() => ({ tag: document.activeElement?.tagName, v: document.activeElement?.value }));
  check('15초 새로고침 뒤: 초안·제목 그대로', (await ta().inputValue()) === 'npm i\n  x' && (await ti().inputValue()) === 'T1');
  check('15초 새로고침 뒤: 쓰던 칸에 포커스', f.tag === 'TEXTAREA' && f.v === 'npm i\n  x', J(f));
  check('보낸 코드 목록 2개 + 모두 지우기', (await aCard.locator('[data-snip] tr').count()) === 2 && (await aCard.locator('button', { hasText: '모두 지우기' }).count()) === 1);
  await page.keyboard.press('Control+Enter');
  await waitHits(gw, 'snip', 1);
  await until(async () => (await ta().inputValue()) === '');
  check('Ctrl+Enter: 본문 {id,text,title} 원문 그대로, 칸 비움', eq(last(gw, 'snip').body, { id: 'A', text: 'npm i\n  x', title: 'T1' }) && (await ta().inputValue()) === '' && (await ti().inputValue()) === '', J(last(gw, 'snip').body));
  await until(async () => (await aCard.locator('[data-snip] tr').count()) === 3);
  await aCard.locator('[data-snip] tr').first().locator('button', { hasText: '삭제' }).click();
  await waitHits(gw, 'snip-delete', 1);
  check('삭제: 본문 {id,snip}', eq(last(gw, 'snip-delete').body, { id: 'A', snip: 'sn1' }), J(last(gw, 'snip-delete').body));
  gw.labs[0].ending = true;
  await openSection(page, '마무리');
  await aCard.locator('button', { hasText: '새로고침' }).click();
  await page.waitForFunction(() => document.getElementById('labs').textContent.includes('정리 재시도 중'));
  check('끝내는 중: 코드 보내기 숨김, 끝내기는 남음', (await aCard.locator('[data-snip] textarea').count()) === 0 && (await aCard.locator('button', { hasText: '지금 끝내기' }).count()) === 1);
  hygiene('코드 보내기', env);
  await ctx.close();
}

// 7) 화면 공유 (브라우저 API 흉내): 내가 공유 중인 수업은 전부 실패가 돼도 멈추기 줄이 남는다. 다른 탭의 공유도 보인다
{
  console.log('\n# 화면 공유 (흉내)');
  const init = () => {
    window.__scr = { gdm: 0, stopped: 0, closed: 0 };
    const md = navigator.mediaDevices || {};
    md.getDisplayMedia = async () => { window.__scr.gdm++; const t = { kind: 'video', contentHint: '', onended: null, stop() { window.__scr.stopped++; } }; return { getVideoTracks: () => [t], getTracks: () => [t] }; };
    if (!navigator.mediaDevices) Object.defineProperty(navigator, 'mediaDevices', { value: md });
    window.RTCPeerConnection = class {
      constructor() { this.connectionState = 'new'; this.localDescription = null; }
      addTransceiver() { return { mid: '0', sender: { getParameters: () => ({}), setParameters: async () => {} } }; }
      async createOffer() { return { type: 'offer', sdp: 'v=0 fake-offer' }; }
      async setLocalDescription(d) { this.localDescription = d; }
      async setRemoteDescription(d) { this.remote = d; }
      close() { window.__scr.closed++; }
    };
  };
  const A = mkLab('A', 'A수업', [okSeat(1)]), B = mkLab('B', 'B수업', [{ n: 1, error: 'boom' }]), C = mkLab('C', 'C수업', [okSeat(1)]);
  const env = await open([A, B, C], { init, setup: (gw) => { gw.screens = { C: { on: true, startedAt: Date.now() - 60e3 } }; } });
  const { page, gw, ctx } = env;
  const lab = (id) => page.locator('#labs > [data-lab="' + id + '"]');
  await card(page, 'C수업');
  await until(async () => (await lab('C').textContent()).includes('다른 탭'), 6000);
  await card(page, 'B수업');
  check('공유: 전부 실패한 B 에는 화면 공유 줄 없음', (await lab('B').locator('button', { hasText: '화면 공유' }).count()) === 0);
  await card(page, 'C수업');
  check('공유: 다른 탭의 공유가 남은 C 는 멈추기 + 안내', (await lab('C').locator('button', { hasText: '화면 공유 멈추기' }).count()) === 1 && (await lab('C').textContent()).includes('다른 탭'));
  await card(page, 'A수업');
  await openSection(page, '화면 공유');
  await lab('A').locator('button', { hasText: '화면 공유 시작' }).click();
  await waitHits(gw, 'screen/start', 1);
  await until(async () => (await lab('A').textContent()).includes('공유 중'));
  check('공유 시작: 본문 {id,sdp,tracks}', eq(last(gw, 'screen/start').body, { id: 'A', sdp: 'v=0 fake-offer', tracks: [{ mid: '0', trackName: 'screen' }] }), J(last(gw, 'screen/start').body));
  check('공유 중: 멈추기 버튼 + 공유 중', (await lab('A').locator('button', { hasText: '화면 공유 멈추기' }).count()) === 1);
  A.seats = [{ n: 1, error: 'sandbox died' }];
  const lh = gw.hits('list').length;
  await openSection(page, '마무리');
  await lab('A').locator('button', { hasText: '새로고침' }).click();
  await waitHits(gw, 'list', lh + 1);
  await page.waitForFunction(() => document.getElementById('labs').textContent.includes('sandbox died'));
  const ab = await btnTexts(lab('A'));
  check('공유 중 수업이 전부 실패: 멈추기 줄은 남고 초대는 숨김', ab.includes('🖥 화면 공유 멈추기') && !ab.some((x) => /초대|들어가 보기|작업 공간 열기/.test(x)) && (await lab('A').textContent()).includes('공유 중'), J(ab));
  await openSection(page, '화면 공유');
  await lab('A').locator('button', { hasText: '화면 공유 멈추기' }).click();
  await waitHits(gw, 'screen/stop', 1);
  await until(async () => (await lab('A').locator('button', { hasText: '화면 공유' }).count()) === 0);
  const sc = await page.evaluate(() => window.__scr);
  check('멈추기: 본문 {id}, 트랙 멈춤·연결 닫음, 실패 수업의 공유 줄 사라짐', eq(last(gw, 'screen/stop').body, { id: 'A' }) && sc.stopped >= 1 && sc.closed >= 1 && (await lab('A').locator('button', { hasText: '화면 공유' }).count()) === 0, J(sc));
  await card(page, 'C수업');
  await openSection(page, '화면 공유');
  await lab('C').locator('button', { hasText: '화면 공유 멈추기' }).click();
  await waitHits(gw, 'screen/stop', 2);
  check('다른 탭 공유 멈추기: 본문 {id:C}', eq(last(gw, 'screen/stop').body, { id: 'C' }));
  hygiene('화면 공유', env);
  await ctx.close();
}

await browser.close();
console.log(`\n${pass} passed, ${failN} failed, 0 skipped\n`);
process.exit(failN ? 1 : 0);
