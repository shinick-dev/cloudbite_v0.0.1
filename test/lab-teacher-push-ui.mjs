// /lab "화면을 꺼도 손들기 알림" (W2 Web Push) 화면 회귀. 설치된 Edge headless, 요청은 전부 route 로 흉내, 시계는 page.clock.
// 브라우저의 Notification·PushManager·serviceWorker 는 addInitScript 로 흉내 — 진짜 권한 창·구독·푸시 서비스·기기 전송 없음.
//   계약 (전부 POST, 같은 출처 쿠키, x-admin-token 없음):
//     /api/lab/teacher/push/config {} → {available,expiresAt,applicationServerKey?}
//     /api/lab/teacher/push/subscribe {subscription} → {ok:true,expiresAt}
//     /api/lab/teacher/push/status {endpoint} → {enabled,expiresAt}
//     /api/lab/teacher/push/unsubscribe {endpoint} → {ok:true}        401 = 모니터 끝, 409 = 서버에서 못 씀
//   확인: 열 때 권한·구독 0 (설정은 세대마다 한 번) · 켜기를 누른 그 자리에서 권한 요청 → 구독(userVisibleOnly, 서버 키 바이트) → 서버 등록(정확한 본문) ·
//         거부·지원 안 함·설정 없음·지원 안 하는 푸시 서버 · 기존 구독 복원(서버 상태로만, 자동 등록 없음)·새 세션이면 다시 켜기 ·
//         등록 실패·끄기 실패를 사실대로 · 끄기는 서버 먼저 · 로그아웃·8시간·다시 확인 사이 늦은 결과 버림 · 브라우저 대기 상한 · 저장소에 아무것도 없음 · W1 3초 조회 그대로 ·
//         로그아웃을 누르는 즉시 알림 세대 무효(응답 대기 중 카드 숨김·늦은 등록이 되살리지 못함·로그인·복원 막힘, 관리 토큰은 logout 에만) ·
//         다시 확인은 같은 모니터 쿠키·같은 만료(서버 흉내)라 켜짐 유지(권한·구독·등록 0), 로그아웃 뒤 새 로그인(새 세션)은 꺼짐·자동 재등록 없음.
//   node test/lab-teacher-push-ui.mjs
import { generateKeyPairSync, randomBytes } from 'node:crypto';

let pass = 0, failN = 0, skipN = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { failN++; console.log(`  FAIL ${name} ${String(extra).slice(0, 400)}`); }
};
const J = JSON.stringify;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64u = (b) => Buffer.from(b).toString('base64url');

console.log('/lab 백그라운드 손들기 알림 (Edge headless, 흉내 Push)');
let chromium, browser;
try { ({ chromium } = await import('playwright-core')); browser = await chromium.launch({ channel: 'msedge', headless: true }); }
catch (e) { skipN++; console.log(`  skip Edge 없음 (${String(e.message).split('\n')[0]})`); }
if (browser) { try { await run(browser); } finally { await browser.close(); } }
console.log(`\n${pass} ok, ${failN} fail, ${skipN} skip`);
process.exit(failN ? 1 : 0);

async function run(browser) {
  const { labPage, WEBAUTHN_JS } = await import(new URL('../src/pages.ts', import.meta.url).href);
  const ORIGIN = 'http://localhost:8799';
  const T0 = new Date('2026-10-02T09:00:00Z').getTime();
  const jwk = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ format: 'jwk' });
  const KEYB = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
  const KEY = b64u(KEYB), KEYA = [...KEYB];
  const FCM = 'https://fcm.googleapis.com/fcm/send/abc123', WNS = 'https://wns2-par02p.notify.windows.com/w/?token=zzz';
  const seat = (n, x = {}) => ({ n, who: '', opened: 0, presence: { state: 'active', idleSec: 0, lastSeen: 0 }, setup: { state: 'ok', note: '' }, error: false, ...x });

  async function scene(opts = {}) {
    const st = { now: T0, monitor: !!opts.monitor, monExp: opts.monExp ?? T0 + 8 * 3600e3, token: null, tokens: [], adminExp: 0, reqs: [], external: [], unknown: [],
      labs: [{ id: 'A', name: 'A수업', expiresAt: T0 + 3 * 3600e3, ending: false, seats: [seat(1, { who: 'kim', hand: T0 - 120000 }), seat(2, { who: 'lee' })] }],
      cfgMode: opts.cfgMode ?? 'ok', subMode: 'ok', unsubMode: 'ok', bound: new Set(opts.bound ?? []), gates: {}, sessions: 0 };
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await ctx.route('**/*', async (route) => {
      const req = route.request(), u = new URL(req.url());
      if (u.origin !== ORIGIN) { st.external.push(req.url()); return route.abort('blockedbyclient'); }
      const p = u.pathname, h = req.headers();
      const json = (o, status = 200) => route.fulfill({ status, contentType: 'application/json', body: J(o) }).catch(() => {});
      let body; try { body = req.postDataJSON(); } catch { body = null; }
      if (p === '/lab') return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: labPage() });
      if (p === '/webauthn.js') return route.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: WEBAUTHN_JS });
      if (p.startsWith('/__teacher/') || p === '/lab/teacher-sw.js') return route.fulfill({ status: 404, body: '' });
      st.reqs.push({ p, h, body, at: st.now });
      if (st.gates[p]) await st.gates[p];
      if (p === '/api/admin/options') return json({ challenge: b64u(randomBytes(32)), rpId: 'localhost', allowCredentials: [{ type: 'public-key', id: st.credId }], userVerification: 'preferred', timeout: 60000 });
      if (p === '/api/admin/login') { st.token = 'adm-' + randomBytes(6).toString('hex'); st.tokens.push(st.token); st.adminExp = st.now + 600000; return json({ token: st.token, expiresAt: st.adminExp }); }
      if (p === '/api/lab/teacher/status') return st.monitor ? json({ now: st.now, expiresAt: st.monExp, labs: st.labs }) : json({ error: 'no monitor' }, 401);
      if (p === '/api/lab/teacher/logout') { st.monitor = false; st.bound.clear(); return json({ ok: true }); }
      if (p.startsWith('/api/lab/teacher/push/')) {
        if (h['x-admin-token']) return json({ error: 'push 는 관리 토큰을 받지 않는다' }, 400);
        if (!st.monitor) return json({ error: 'no monitor' }, 401);
        const op = p.slice('/api/lab/teacher/push/'.length);
        if (op === 'config') {
          if (st.cfgMode === '409') return json({ error: 'push 를 쓸 수 없습니다' }, 409);
          if (st.cfgMode === 'off') return json({ available: false, expiresAt: st.monExp });
          return json({ available: true, expiresAt: st.monExp, applicationServerKey: st.cfgMode === 'badkey' ? 'AAAA' : KEY });
        }
        if (op === 'subscribe') { if (st.subMode !== 'ok') return json({ error: '등록 실패' }, 500); st.bound.add(body.subscription.endpoint); return json({ ok: true, expiresAt: st.monExp }); }
        if (op === 'status') return json({ enabled: st.bound.has(body.endpoint), expiresAt: st.monExp });
        if (op === 'unsubscribe') { if (st.unsubMode !== 'ok') return json({ error: '해제 실패' }, 500); st.bound.delete(body.endpoint); return json({ ok: true }); }
      }
      const okAdmin = h['x-admin-token'] && h['x-admin-token'] === st.token && st.now < st.adminExp;
      // 서버 흉내 (W1 수리 계약): 살아 있는 모니터 쿠키로 다시 확인하면 같은 세션 그대로 — 같은 만료, 이 세션에 묶인 알림도 그대로. 쿠키가 없을 때만 새 세션(묶인 것 없음)
      if (p === '/api/lab/teacher/session') { if (!okAdmin) return json({ error: 'no auth' }, 401); if (!st.monitor) { st.monitor = true; st.sessions++; st.bound.clear(); st.monExp = st.now + 8 * 3600e3; } return json({ ok: true, expiresAt: st.monExp }); }
      if (!okAdmin) return json({ error: '관리 세션이 만료됐습니다.' }, 401);
      if (p === '/api/lab/config') return json({ labOrigin: 'https://lab.example.test', quota: null, hours: [1, 2, 3], budgets: [1, 2, 5], daytona: true, openrouter: true, shareable: [], cfg: { gw: 'https://gw.example.test', snapshot: 'gw-lab-v4', model: 'test/model', clip: { in: true, out: true }, share: {} } });
      if (p === '/api/lab/list') return json({ labs: st.labs.map((l) => ({ cpu: 1, memory: 2, disk: 5, budget: 2, model: 'test/model', clip: { in: true, out: true }, share: [], ...l, seats: l.seats.map((s) => ({ ...s, error: undefined, state: 'started' })) })), quota: null, now: st.now });
      if (p === '/api/lab/snips') return json({ v: 1, items: [] });
      if (p === '/api/lab/screen/status') return json({ screens: {} });
      st.unknown.push(p); return json({ error: 'not mocked' }, 404);
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    // 흉내 브라우저 Push: 권한 창·구독·서비스 워커는 전부 가짜. 부른 횟수·사용자 동작 여부·넘긴 키 바이트를 기록한다
    await page.addInitScript((cfg) => {
      const W = window.__push = { perm: cfg.perm, answer: cfg.answer ?? 'granted', reqs: [], subs: [], unsubs: 0, gets: 0, sub: null, getHang: !!cfg.getHang, subGate: null, endpoint: cfg.endpoint };
      const mkSub = (key) => ({ endpoint: W.endpoint, options: { applicationServerKey: key ? new Uint8Array(key).buffer : null },
        toJSON() { return { endpoint: this.endpoint, expirationTime: null, keys: { p256dh: 'BPubKeyOfBrowser', auth: 'authSecretValue' } }; },
        unsubscribe() { W.unsubs++; if (W.sub === this) W.sub = null; return Promise.resolve(true); } });
      if (cfg.existing) W.sub = mkSub(cfg.existing);
      const pushManager = {
        getSubscription: () => { W.gets++; return W.getHang ? new Promise(() => {}) : Promise.resolve(W.sub); },
        subscribe: (o) => { W.subs.push({ uvo: o.userVisibleOnly, key: Array.from(o.applicationServerKey), active: !!navigator.userActivation?.isActive });
          const mk = () => (W.sub = mkSub(o.applicationServerKey)); return W.subGate ? W.subGate.then(mk) : Promise.resolve(mk()); } };
      const reg = { scope: location.origin + '/lab', pushManager };
      const SW = { register: () => Promise.resolve(reg), ready: cfg.readyHang ? new Promise(() => {}) : Promise.resolve(reg), controller: null, addEventListener() {} };
      Object.defineProperty(Navigator.prototype, 'serviceWorker', { configurable: true, get: () => SW });
      if (cfg.noPush) delete window.PushManager; else window.PushManager = function PushManager() {};
      window.Notification = class { static get permission() { return W.perm; }
        static requestPermission() { W.reqs.push({ active: !!navigator.userActivation?.isActive }); const a = W.answer; if (a !== 'default') W.perm = a; return Promise.resolve(a); } };
    }, { perm: opts.perm ?? 'default', answer: opts.answer, existing: opts.existing ? KEYA : null, endpoint: opts.endpoint ?? FCM, noPush: !!opts.noPush, getHang: !!opts.getHang, readyHang: !!opts.readyHang });
    await page.clock.install({ time: new Date(T0) });
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'usb', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
    const id = randomBytes(16);
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    await cdp.send('WebAuthn.addCredential', { authenticatorId, credential: { credentialId: id.toString('base64'), isResidentCredential: false, rpId: 'localhost', privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'), signCount: 0 } });
    st.credId = b64u(id);
    const until = async (fn, what, ms = 8000) => { const t = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timeout: ' + what); await sleep(25); } };
    const sync = async () => { st.now = await page.evaluate(() => Date.now()); };
    const advance = async (ms, step = 1000) => { for (let left = ms; left > 0; left -= step) { await page.clock.runFor(Math.min(step, left)); await sync(); await sleep(15); } await sleep(120); };
    const hits = (p) => st.reqs.filter((r) => r.p === p);
    const push = (op) => hits('/api/lab/teacher/push/' + op);
    const W = () => page.evaluate(() => { const w = window.__push; return { perm: w.perm, reqs: w.reqs, subs: w.subs, unsubs: w.unsubs, gets: w.gets, hasSub: !!w.sub }; });
    const state = () => page.$eval('#pushCard', (e) => (e.hidden ? 'hidden' : e.dataset.state));
    const msg = () => page.$eval('#pushMsg', (e) => e.textContent);
    const btns = () => page.evaluate(() => ['pushOn', 'pushOff'].filter((k) => !document.getElementById(k).hidden && !document.getElementById('pushCard').hidden));
    const waitState = (s, what) => until(async () => (await state()) === s, what + ' → ' + s);
    await page.goto(`${ORIGIN}/lab`);
    await page.clock.pauseAt(T0 + 1000); await sync();
    const login = async () => { await page.click('#go'); await until(async () => hits('/api/lab/list').length > 0 && !(await page.$eval('#go', (e) => e.disabled)), 'login'); await sleep(150); };
    const gate = (p) => { let rel; st.gates[p] = new Promise((r) => (rel = r)); return () => { delete st.gates[p]; rel(); }; };
    const noLeak = async () => { const s = await page.evaluate(async () => ({ ls: localStorage.length, ss: sessionStorage.length, ck: document.cookie, idb: indexedDB.databases ? (await indexedDB.databases()).length : 0, html: document.documentElement.outerHTML }));
      return s.ls === 0 && s.ss === 0 && s.ck === '' && s.idb === 0 && !s.html.includes('abc123') && /* 허용 호스트 이름은 스크립트 상수라 endpoint 경로로 본다 */ !s.html.includes('authSecretValue') && !s.html.includes(KEY); };
    const pushNoAdmin = () => st.reqs.filter((r) => r.p.startsWith('/api/lab/teacher/push/')).every((r) => !r.h['x-admin-token']);
    return { ctx, page, st, errors, until, sync, advance, hits, push, W, state, msg, btns, waitState, login, gate, noLeak, pushNoAdmin };
  }
  const clean = (S) => !S.st.external.length && !S.st.unknown.length && !S.errors.length;

  // ── 1. 복원: 열 때 권한·구독 0, 켜기·끄기, 실패를 사실대로, 로그아웃 ──
  console.log('복원 → 켜기 → 끄기 → 실패들 → 로그아웃');
  {
    const S = await scene({ monitor: true });
    const { page, st } = S;
    await S.waitState('off', 'restore');
    const w0 = await S.W();
    check('열 때: 권한 요청 0, 구독 0, 설정 1번(본문 {}), 서버 상태 묻기 0 (구독 없음)', w0.reqs.length === 0 && w0.subs.length === 0 && S.push('config').length === 1 && J(S.push('config')[0].body) === '{}' && S.push('status').length === 0, J([w0, st.reqs.map((r) => r.p)]));
    check('카드: 모니터 패널 안, 켜기만 보임, 설명(기기마다·8시간·로그아웃·이름 없이)', J(await S.btns()) === J(['pushOn']) && await page.$eval('#pushCard', (e) => !!e.closest('#panel')) && await page.$eval('#pushCard', (e) => ['기기마다', '8시간', '로그아웃', '이름 없이', '16.4', '홈 화면'].every((t) => e.textContent.includes(t)) && !e.textContent.includes('즉시')));
    const s0 = S.hits('/api/lab/teacher/status').length;
    await S.advance(9000);
    check('W1 3초 조회 그대로 (9초 3번), 설정은 세대마다 한 번뿐', S.hits('/api/lab/teacher/status').length - s0 === 3 && S.push('config').length === 1, S.hits('/api/lab/teacher/status').length - s0);
    await page.click('#pushOn');
    await S.waitState('on', 'enable');
    const w1 = await S.W();
    check('켜기: 누른 그 자리에서 권한 요청 1번 (사용자 동작 안)', w1.reqs.length === 1 && w1.reqs[0].active === true, J(w1.reqs));
    check('구독: userVisibleOnly + 서버 키를 P-256 65바이트로 풀어서', w1.subs.length === 1 && w1.subs[0].uvo === true && J(w1.subs[0].key) === J(KEYA), J(w1.subs));
    const sb = S.push('subscribe');
    check('서버 등록 1번: 본문이 정확히 {subscription: toJSON()}', sb.length === 1 && J(sb[0].body) === J({ subscription: { endpoint: FCM, expirationTime: null, keys: { p256dh: 'BPubKeyOfBrowser', auth: 'authSecretValue' } } }), J(sb.map((r) => r.body)));
    check('켜짐 표시 + 만료 시각, 끄기만 보임', (await S.msg()).includes('까지') && (await S.msg()).includes('켜짐') && J(await S.btns()) === J(['pushOff']), await S.msg());
    check('구독·키·endpoint 가 저장소·화면에 없음', await S.noLeak());
    // 끄기: 서버가 먼저. 서버 응답 전에는 브라우저 구독을 지우지 않고 꺼졌다고 하지 않는다
    const rel = S.gate('/api/lab/teacher/push/unsubscribe');
    await page.click('#pushOff');
    await S.until(() => S.push('unsubscribe').length === 1, 'unsub sent');
    await S.advance(200, 100);
    check('끄기: 서버 해제 {endpoint} 먼저, 그동안 브라우저 구독 그대로·"처리 중"', J(S.push('unsubscribe')[0].body) === J({ endpoint: FCM }) && (await S.W()).unsubs === 0 && (await S.state()) === 'pending');
    rel();
    await S.waitState('off', 'disable');
    check('서버가 해제한 뒤에 브라우저 구독 해제 → 꺼짐', (await S.W()).unsubs === 1 && !(await S.W()).hasSub && !st.bound.size && (await S.msg()).includes('껐습니다'));
    // 끄기 실패: 꺼졌다고 하지 않는다
    await page.click('#pushOn'); await S.waitState('on', 're-enable');
    st.unsubMode = '500';
    await page.click('#pushOff');
    await S.waitState('failed', 'disable fail');
    const fm = await S.msg();
    check('끄기 실패: "켜져 있을 수 있습니다", 꺼짐 아님, 브라우저 구독 그대로, 끄기 다시 누를 수 있음', fm.includes('켜져 있을 수 있습니다') && !fm.includes('껐습니다') && (await S.W()).unsubs === 1 && (await S.W()).hasSub && st.bound.size === 1 && (await S.btns()).includes('pushOff'), J([fm, await S.btns()]));
    st.unsubMode = 'ok';
    await page.click('#pushOff'); await S.waitState('off', 'disable retry');
    check('다시 끄기: 꺼짐', !st.bound.size && (await S.W()).unsubs === 2);
    // 등록 실패: 새로 만든 구독은 지우고 "켜지지 않았습니다"
    st.subMode = '500';
    await page.click('#pushOn');
    await S.waitState('failed', 'register fail');
    await S.advance(200, 100);
    const rw = await S.W();
    check('등록 실패: 켜지지 않았다고 알림, 새로 만든 브라우저 구독 지움, 켜기만 다시', (await S.msg()).includes('켜지지 않았습니다') && rw.unsubs === 3 && !rw.hasSub && J(await S.btns()) === J(['pushOn']), J([await S.msg(), rw, await S.btns()]));
    st.subMode = 'ok';
    await page.click('#pushOn'); await S.waitState('on', 'enable again');
    check('권한 요청은 누를 때마다만 (자동 0)', (await S.W()).reqs.length === (await S.W()).subs.length && (await S.W()).reqs.every((r) => r.active), J((await S.W()).reqs));
    check('push 요청에 관리 토큰 없음', S.pushNoAdmin());
    await page.click('#logout');
    await S.until(() => page.$eval('#login', (e) => !e.hidden), 'logout');
    const n = st.reqs.length;
    await S.advance(30000, 3000);
    check('로그아웃: 카드 숨김, 서버 알림 해제(로그아웃이 멈춤), 그 뒤 요청 0', (await S.state()) === 'hidden' && !st.bound.size && st.reqs.length === n, J(st.reqs.slice(n).map((r) => r.p)));
    check('복원(관리 토큰 없음)의 로그아웃: 관리 토큰 헤더 없음, 본문 {}', S.hits('/api/lab/teacher/logout').length === 1 && !S.hits('/api/lab/teacher/logout')[0].h['x-admin-token'] && J(S.hits('/api/lab/teacher/logout')[0].body) === '{}');
    check('외부·흉내 안 된 요청·페이지 오류 없음', clean(S), J([st.external, st.unknown, S.errors]));
    await S.ctx.close();
  }

  console.log('권한 거부·닫기');
  {
    const S = await scene({ monitor: true, answer: 'default' });
    await S.waitState('off', 'restore');
    await S.page.click('#pushOn');
    await S.until(async () => (await S.msg()).includes('허용하지 않아'), 'dismissed');
    check('권한 창 닫음: 꺼짐 그대로, 구독·등록 0', (await S.state()) === 'off' && (await S.W()).subs.length === 0 && !S.push('subscribe').length);
    await S.page.evaluate(() => { window.__push.answer = 'denied'; });
    await S.page.click('#pushOn');
    await S.waitState('denied', 'denied');
    check('거부: 막힘 안내(설정에서 허용), 버튼 없음, 구독·등록 0', (await S.msg()).includes('설정') && !(await S.btns()).length && (await S.W()).subs.length === 0 && !S.push('subscribe').length);
    await S.ctx.close();
  }
  {
    const S = await scene({ monitor: true, perm: 'denied' });
    await S.waitState('denied', 'pre-denied');
    check('이미 막힌 권한: 열 때 denied, 권한 요청·구독 조회 0, 버튼 없음', (await S.W()).reqs.length === 0 && (await S.W()).gets === 0 && !(await S.btns()).length);
    await S.ctx.close();
  }

  console.log('지원 안 함·설정 없음');
  {
    const S = await scene({ monitor: true, noPush: true });
    await S.waitState('unsupported', 'no PushManager');
    await S.advance(3100);
    check('PushManager 없음: 지원 안 함, 버튼 없음, W1 모니터는 그대로(실시간·손 요약)', !(await S.btns()).length && (await S.W()).gets === 0 && (await S.page.$eval('#fresh', (e) => e.dataset.state)) === 'live' && (await S.page.$eval('#handList', (e) => e.textContent)).includes('kim'));
    await S.ctx.close();
  }
  {
    const S = await scene({ monitor: true, endpoint: WNS });
    await S.waitState('off', 'restore');
    await S.page.click('#pushOn');
    await S.waitState('unsupported', 'wns');
    await S.advance(200, 100);
    check('지원 안 하는 푸시 서버(WNS): 서버 등록 0, 만든 구독 지움, 다른 브라우저 안내', !S.push('subscribe').length && (await S.W()).unsubs === 1 && (await S.msg()).includes('지원하지 않습니다'), await S.msg());
    await S.ctx.close();
  }
  for (const [mode, label] of [['off', '서버 설정 없음(available:false)'], ['409', '서버 409'], ['badkey', '키 모양 이상']]) {
    const S = await scene({ monitor: true, cfgMode: mode });
    await S.waitState('unavailable', mode);
    check(`${label}: 쓸 수 없음, 버튼 없음, 권한·구독 조회 0, 모니터 카드는 그대로`, !(await S.btns()).length && (await S.W()).reqs.length === 0 && (await S.W()).subs.length === 0 && (await S.page.$$('#labs [data-readonly]')).length === 1);
    await S.ctx.close();
  }

  console.log('기존 구독 복원');
  {
    const S = await scene({ monitor: true, existing: true, perm: 'granted', bound: [FCM] });
    await S.waitState('on', 'restore bound');
    const w = await S.W();
    check('이 세션에 묶인 구독: 서버 상태 {endpoint} 로만 켜짐 표시, 권한 요청·구독·등록 0', J(S.push('status').map((r) => r.body)) === J([{ endpoint: FCM }]) && w.reqs.length === 0 && w.subs.length === 0 && !S.push('subscribe').length);
    await S.ctx.close();
  }
  {
    const S = await scene({ monitor: true, existing: true, perm: 'granted' });
    await S.waitState('off', 'restore unbound');
    await S.advance(10000);
    const w = await S.W();
    check('권한·구독은 있지만 새 세션(서버에 없음): 켜기 다시 보임, 자동 구독·등록 0', J(await S.btns()) === J(['pushOn']) && w.reqs.length === 0 && w.subs.length === 0 && !S.push('subscribe').length && w.hasSub);
    await S.page.click('#pushOn');
    await S.waitState('on', 'rebind by click');
    check('누르면 기존 구독(같은 키)으로 등록 — 새로 만들지 않음', (await S.W()).subs.length === 0 && S.push('subscribe').length === 1 && (await S.W()).reqs.length === 1);
    await S.ctx.close();
  }
  {
    const S = await scene({ monitor: true, getHang: true });
    await S.waitState('pending', 'hang');
    const s0 = S.hits('/api/lab/teacher/status').length;
    await S.advance(10500);
    check('구독 조회가 끝나지 않아도 10초 상한 → 쓸 수 없음 안내, 모니터 조회는 계속', (await S.state()) === 'unavailable' && S.hits('/api/lab/teacher/status').length - s0 >= 3 && (await S.page.$eval('#fresh', (e) => e.dataset.state)) === 'live', J([await S.state(), await S.msg()]));
    await S.ctx.close();
  }

  console.log('늦은 결과 (로그아웃·8시간·다시 확인)');
  {
    const S = await scene({ monitor: true });
    const { page, st } = S;
    await S.waitState('off', 'restore');
    const rel = S.gate('/api/lab/teacher/push/subscribe');
    await page.click('#pushOn');
    await S.until(() => S.push('subscribe').length === 1, 'subscribe in flight');
    await page.click('#logout');
    await S.until(() => page.$eval('#login', (e) => !e.hidden), 'logout');
    rel();
    await S.advance(3000, 500);
    check('등록 중 로그아웃: 켜짐으로 되살아나지 않음, 새로 만든 구독 지움', (await S.state()) === 'hidden' && (await page.$eval('#pushCard', (e) => e.dataset.state)) !== 'on' && (await S.W()).unsubs === 1 && !(await S.W()).hasSub, J(await S.W()));
    check('늦은 장면: 페이지 오류 없음', !S.errors.length, J(S.errors));
    await S.ctx.close();
  }
  {
    const S = await scene({ monitor: true, monExp: T0 + 20000 });
    const { page } = S;
    await S.waitState('off', 'restore');
    await page.evaluate(() => { window.__push.subGate = new Promise((r) => { window.__push.subRelease = r; }); });
    await page.click('#pushOn');
    await S.until(async () => (await S.W()).subs.length === 1, 'subscribe pending');
    await S.advance(21000);
    check('8시간 끝: 카드 숨김', (await S.state()) === 'hidden' && (await page.$eval('#loginNote', (e) => e.textContent)).includes('8시간'));
    await page.evaluate(() => window.__push.subRelease());
    await S.advance(1000, 250);
    check('끝난 뒤 늦게 온 구독: 서버 등록 0, 바로 지움', !S.push('subscribe').length && (await S.W()).unsubs === 1 && !(await S.W()).hasSub, J(await S.W()));
    await S.ctx.close();
  }
  {
    // 로그아웃 응답을 붙잡아 둔다: 누르는 즉시 알림 세대가 끝나야 한다 (응답을 기다리는 동안 늦은 등록이 켜짐을 되살리지 못함)
    const S = await scene({ monitor: false });
    const { page, st } = S;
    await S.until(async () => (await page.$eval('#loginNote', (e) => e.textContent)).includes('보안 키로'), 'boot');
    await S.login();
    await S.waitState('off', 'after login');
    const relSub = S.gate('/api/lab/teacher/push/subscribe');
    await page.click('#pushOn');
    await S.until(() => S.push('subscribe').length === 1, 'subscribe in flight');
    const relLo = S.gate('/api/lab/teacher/logout');
    const n0 = st.reqs.length;
    await page.click('#logout');
    await S.until(() => S.hits('/api/lab/teacher/logout').length === 1, 'logout held');
    const r = await page.evaluate(() => ({ card: document.getElementById('pushCard').hidden, st: document.getElementById('pushCard').dataset.state, go: document.getElementById('go').disabled, reauth: document.getElementById('reauth').disabled }));
    check('로그아웃 대기 중: 카드 바로 숨김·알림 세대 끝(꺼짐), 열기·다시 확인 막힘', r.card && r.st === 'off' && r.go && r.reauth, J(r));
    relSub();
    await S.advance(3000, 500);
    const w = await S.W();
    check('로그아웃 대기 중 늦게 온 등록 응답: 켜짐으로 되살아나지 않음, 새로 만든 구독 지움', (await S.state()) === 'hidden' && (await page.$eval('#pushCard', (e) => e.dataset.state)) === 'off' && w.unsubs === 1 && !w.hasSub, J([await page.$eval('#pushCard', (e) => e.dataset.state), w]));
    await page.evaluate(() => { for (const k of ['go', 'reauth', 'mRetry', 'pushOn', 'pushOff']) document.getElementById(k).onclick(); });
    await S.advance(5000);
    check('로그아웃 대기 중: 로그인·복원·알림 설정·상태·등록 요청 0, 권한 요청 더 없음 (logout 1번뿐)', J(st.reqs.slice(n0).map((x) => x.p)) === J(['/api/lab/teacher/logout']) && (await S.W()).reqs.length === 1, J(st.reqs.slice(n0).map((x) => x.p)));
    check('logout 에만 관리 토큰(본문 {}), push 요청에는 없음', S.hits('/api/lab/teacher/logout')[0].h['x-admin-token'] === st.tokens[0] && J(S.hits('/api/lab/teacher/logout')[0].body) === '{}' && S.pushNoAdmin());
    relLo();
    await S.until(async () => (await page.$eval('#loginNote', (e) => e.textContent)).includes('로그아웃했습니다'), 'logout done');
    await S.advance(5000);
    check('로그아웃 끝: 서버 알림 해제, 카드 숨김, 다시 열 수 있음, 그 뒤 요청 0, 오류 없음', !st.bound.size && (await S.state()) === 'hidden' && !(await page.$eval('#go', (e) => e.disabled)) && J(st.reqs.slice(n0).map((x) => x.p)) === J(['/api/lab/teacher/logout']) && clean(S), J([st.reqs.slice(n0).map((x) => x.p), S.errors]));
    await S.ctx.close();
  }
  {
    const S = await scene({ monitor: false });
    const { page, st } = S;
    await S.until(async () => (await page.$eval('#loginNote', (e) => e.textContent)).includes('보안 키로'), 'boot');
    check('모니터 없을 때: 카드 숨김, 설정 요청 0', (await S.state()) === 'hidden' && !S.push('config').length);
    await S.login();
    await S.waitState('off', 'after login');
    check('로그인(새 모니터 세대): 설정 1번, 관리 토큰 없이', S.push('config').length === 1 && S.pushNoAdmin());
    await page.click('#pushOn'); await S.waitState('on', 'enable');
    const exp0 = st.monExp, w0 = await S.W(), sb0 = S.push('subscribe').length;
    await S.advance(60000, 5000);
    await page.evaluate(() => document.getElementById('reauth').onclick());
    await S.until(() => S.hits('/api/admin/login').length === 2 && S.push('config').length === 2, 'reauth');
    await S.waitState('on', 'after reauth');
    await S.advance(10000);
    const w = await S.W();
    check('다시 확인 = 같은 모니터 쿠키·같은 만료: 세션 1개 그대로, 설정 다시 1번·상태 {endpoint} 로 켜짐 유지', st.sessions === 1 && st.monExp === exp0 && st.bound.size === 1 && (await S.state()) === 'on' && J(S.push('status').map((r) => r.body)) === J([{ endpoint: FCM }]), J([st.sessions, st.monExp - exp0, S.push('status').map((r) => r.body)]));
    check('다시 확인: 권한 요청·구독·서버 등록 0 (켜짐은 서버 상태로만)', S.push('subscribe').length === sb0 && w.subs.length === w0.subs.length && w.reqs.length === w0.reqs.length && J(await S.btns()) === J(['pushOff']), J([w0, w]));
    // 로그아웃(관리 토큰 함께) → 새 로그인 = 다른 세션: 서버에 묶인 것 없음 → 꺼짐, 자동 재등록 없음
    await page.click('#logout');
    await S.until(async () => (await page.$eval('#loginNote', (e) => e.textContent)).includes('로그아웃했습니다'), 'logout');
    const lo = S.hits('/api/lab/teacher/logout');
    check('로그아웃: 들고 있던 관리 토큰을 logout 에만 냄, push 요청에는 관리 토큰 없음', lo.length === 1 && lo[0].h['x-admin-token'] === st.tokens[1] && S.pushNoAdmin() && !st.bound.size);
    await S.advance(5000);
    const st0 = S.push('status').length;
    await S.login();
    await S.waitState('off', 'new session after logout');
    await S.advance(10000);
    const w2 = await S.W();
    check('로그아웃 뒤 새 로그인(다른 세션): 상태 false → 꺼짐·켜기 보임, 권한·구독·등록 자동 0', st.sessions === 2 && S.push('status').length === st0 + 1 && J(await S.btns()) === J(['pushOn']) && S.push('subscribe').length === sb0 && w2.subs.length === w0.subs.length && w2.reqs.length === w0.reqs.length && w2.hasSub, J([st.sessions, w2, await S.btns()]));
    check('외부·흉내 안 된 요청·페이지 오류 없음', clean(S), J([st.external, st.unknown, S.errors]));
    await S.ctx.close();
  }
}
