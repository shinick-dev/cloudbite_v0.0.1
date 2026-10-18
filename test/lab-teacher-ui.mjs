// /lab 강사 모니터 화면 회귀 테스트 (네트워크·진짜 키·Daytona·Push 없음). 설치된 Edge headless, 요청은 전부 route 로 흉내, 시계는 page.clock.
//   계약: POST /api/lab/teacher/session (x-admin-token) → 모니터 쿠키(서버, HttpOnly — 여기서는 흉내 상태 st.monitor),
//         POST /api/lab/teacher/status (빈 본문, 쿠키) → {now,expiresAt,labs}, POST /api/lab/teacher/logout.
//   확인: 8시간 복원(관리 토큰 없이 읽기 전용) · 401 이면 로그인 · 관리 만료 → 관리 요청 0, 읽기 전용, 다시 확인은 누를 때만·입력 보존 ·
//         3초 조회 겹침 없음·응답 없는 fetch/JSON 10초 상한·신선도(실시간/늦어짐/끊김)·숨은 탭 멈춤·돌아오면 바로 ·
//         새 손 알림 중복 없음·소리는 켠 뒤에만·QR 크게 보기에 손 요약(조용한 목록 갱신 포함) · 로그아웃 · 저장소에 토큰 없음.
//   node test/lab-teacher-ui.mjs
import { generateKeyPairSync, randomBytes } from 'node:crypto';

let pass = 0, failN = 0, skipN = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { failN++; console.log(`  FAIL ${name} ${String(extra).slice(0, 400)}`); }
};
const J = JSON.stringify;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64u = (b) => Buffer.from(b).toString('base64url');

console.log('/lab 강사 모니터 (Edge headless, route 흉내, 가짜 시계)');
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
  const QR = '<svg data-qr="1" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';
  const seat = (n, x = {}) => ({ n, who: '', opened: 0, presence: { state: 'active', idleSec: 0, lastSeen: 0 }, setup: { state: 'ok', note: '' }, error: false, ...x });

  // 한 장면 = 새 컨텍스트. st: 흉내 서버 상태. 시계는 페이지 것만 쓰고 st.now 를 따라 맞춘다
  async function scene(opts = {}) {
    const st = { now: T0, monitor: !!opts.monitor, monExp: T0 + 8 * 3600e3, liveExp: T0 + 8 * 3600e3, token: null, tokens: [], adminExp: 0, reqs: [], external: [], unknown: [],
      labs: opts.labs ?? [{ id: 'A', name: 'A수업', expiresAt: T0 + 3 * 3600e3, ending: false, seats: [seat(1, { who: 'kim', hand: T0 - 120000 }), seat(2, { who: 'lee' })] }],
      statusMode: 'ok', statusGate: null, sessionMode: opts.sessionMode ?? 'ok', inflight: 0, maxInflight: 0, revoked: new Set(), logoutGate: null, sessionGate: null };
    const ctx = await browser.newContext({ viewport: opts.viewport ?? { width: 1280, height: 900 } });
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
      // 별도 화면 세션은 lab-live-ui에서 검사. 이 모니터 fixture에는 화면 권한을 주지 않는다.
      if (p.startsWith('/api/lab/live/')) {
        if(!opts.live)return json({ error: 'no live fixture' }, 401);
        if(p.endsWith('/session')){st.live=true;return json({ok:true,expiresAt:st.liveExp})}
        if(p.endsWith('/logout')){st.live=false;return json({ok:true})}
        if(!st.live)return json({error:'no live session'},401);
        if(p.endsWith('/screen/start')){st.screen=true;return json({sdp:'v=0',startedAt:st.now})}
        if(p.endsWith('/screen/stop')){st.screen=false;return json({ok:true})}
        if(p.endsWith('/screen/status'))return json({screens:{}});
        if(p.endsWith('/status'))return json({now:st.now,expiresAt:st.liveExp,labs:st.labs.map(l=>({...l,seats:[]}))});
        return json({ok:true});
      }
      if (p === '/api/admin/options') return json({ challenge: b64u(randomBytes(32)), rpId: 'localhost', allowCredentials: [{ type: 'public-key', id: st.credId }], userVerification: 'preferred', timeout: 60000 });
      if (p === '/api/admin/login') { st.token = 'adm-' + randomBytes(6).toString('hex'); st.tokens.push(st.token); st.adminExp = st.now + (opts.adminTtl ?? 8 * 3600e3); if (st.loginGate) await st.loginGate; const L = { token: st.token, expiresAt: st.adminExp }; if (st.loginExp) L.expiresAt = st.loginExp(st.now); if (L.expiresAt === undefined) delete L.expiresAt; return json(L); }
      if (p === '/api/lab/teacher/status') {
        if (h['x-admin-token']) return json({ error: 'status 는 관리 토큰을 받지 않는다' }, 400);
        st.inflight++; st.maxInflight = Math.max(st.maxInflight, st.inflight);
        try {
          if (st.statusGate) await st.statusGate;
          if (st.statusMode === 'abort') return route.abort('internetdisconnected').catch(() => {});
          if (st.statusMode === '500') return json({ error: '상태 조회 실패' }, 500);
          if (!st.monitor || st.statusMode === '401') return json({ error: 'no monitor' }, 401);
          return json({ now: st.now, expiresAt: st.monExp, labs: st.labs });
        } finally { st.inflight--; }
      }
      // 서버 흉내: 로그아웃에 함께 온 관리 토큰은 폐기 (그 토큰으로 늦게 끝난 session 은 본문만 ok, 모니터는 안 생김 — 실제 쿠키 동작은 lab-teacher-logout-race.mjs)
      if (p === '/api/lab/teacher/logout') { if (st.logoutGate) await st.logoutGate; st.monitor = false; if (h['x-admin-token']) st.revoked.add(h['x-admin-token']); return json({ ok: true }); }
      if (p === '/api/lab/teacher/session' && st.sessionGate) { await st.sessionGate; if (st.revoked.has(h['x-admin-token'])) return json({ ok: true, expiresAt: st.now + 8 * 3600e3 }); }
      // W2 백그라운드 알림: 이 파일은 Push 를 쓰지 않는 서버(available:false) — 알림 동작은 test/lab-teacher-push-ui.mjs
      if (p === '/api/lab/teacher/push/config') return st.monitor ? json({ available: false, expiresAt: st.monExp }) : json({ error: 'no monitor' }, 401);
      if(p === '/api/lab/open/manager/list')return json({error:'owner login required'},403);
      const okAdmin = h['x-admin-token'] && h['x-admin-token'] === st.token && st.now < st.adminExp && !st.revoked.has(h['x-admin-token']);
      if(p === '/api/lab/admin/session/remember')return okAdmin?json({ok:true}):json({error:'no admin'},401);
      // The classroom shell reads its selected course separately from the monitor.
      if (p === '/api/lab/classroom/status') {
        if (h['x-admin-token'] ? !okAdmin : (!st.monitor || st.monExp <= st.now)) return json({error:'no classroom session'},401);
        return json({classroom:null,participants:[]});
      }
      if (p === '/api/lab/teacher/session') {
        if (!okAdmin) return json({ error: 'no auth' }, 401);
        if (st.sessionMode !== 'ok') return json({ error: '세션 저장 실패' }, 503);
        st.monitor = true; st.monExp = st.now + 8 * 3600e3; return json({ ok: true, expiresAt: st.monExp });
      }
      if (!okAdmin) return json({ error: '관리 세션이 만료됐습니다.' }, 401);
      if (p === '/api/lab/config') return json({ labOrigin: 'https://lab.example.test', quota: null, hours: [1, 2, 3], budgets: [1, 2, 5], daytona: true, openrouter: true, shareable: [], cfg: { gw: 'https://gw.example.test', snapshot: 'gw-lab-v4', model: 'test/model', clip: { in: true, out: true }, share: {} } });
      if (p === '/api/lab/list') { if (st.listGate) await st.listGate; } if (p === '/api/lab/list') return json({ labs: st.labs.map((l) => ({ cpu: 1, memory: 2, disk: 5, budget: 2, model: 'test/model', clip: { in: true, out: true }, share: [], ...l, seats: l.seats.map((s) => ({ ...s, error: s.error ? 'boom' : undefined, state: 'started' })) })), quota: null, now: st.now });
      if (p === '/api/lab/invite') return json({ n: body.n, who: '', link: `https://lab.example.test/j/inv-${body.id}-${body.n}`, name: 'A수업', qr: QR });
      if (p === '/api/lab/hand') { for (const l of st.labs) if (l.id === body.id) for (const s of l.seats) if (s.n === body.n) delete s.hand; return json({ ok: true }); }
      if (p === '/api/lab/snips') return json({ v: 1, items: [] });
      if (p === '/api/lab/screen/status') return json({ screens: {} });
      if (p === '/api/lab/control/status') return json({mode:'running',revision:0,updatedAt:null});
      st.unknown.push(p); return json({ error: 'not mocked' }, 404);
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    // 소리: AudioContext 를 세기만 한다. 숨은 탭: document.hidden 을 window.__hid 로
    await page.addInitScript(() => {
      window.__audio = { made: 0, beeps: 0 };
      class FakeAC { constructor() { window.__audio.made++; this.currentTime = 0; this.destination = {}; }
        resume() {} close() {}
        createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect: (d) => d }; }
        createOscillator() { return { frequency: {}, connect: (g) => g, start: () => { window.__audio.beeps++; }, stop() {} }; } }
      window.AudioContext = FakeAC;
      window.__hid = false;
      Object.defineProperty(Document.prototype, 'hidden', { configurable: true, get: () => window.__hid });
      Object.defineProperty(Document.prototype, 'visibilityState', { configurable: true, get: () => (window.__hid ? 'hidden' : 'visible') });
    });
    if(opts.live)await page.addInitScript(()=>{
      window.__stopped=0;const canvas=document.createElement('canvas');canvas.width=1280;canvas.height=720;canvas.getContext('2d').fillRect(0,0,1280,720);const stream=canvas.captureStream(1),track=stream.getVideoTracks()[0],stop=track.stop.bind(track);track.stop=()=>{window.__stopped++;stop()};
      Object.defineProperty(navigator.mediaDevices,'getDisplayMedia',{value:async()=>stream});
      window.RTCPeerConnection=class{addTransceiver(){return{mid:'0',sender:{getParameters:()=>({}),setParameters:async()=>{}}}}async createOffer(){return{type:'offer',sdp:'v=0'}}async setLocalDescription(d){this.localDescription=d}async setRemoteDescription(){}close(){}};
    });
    await page.clock.install({ time: new Date(T0) });
    await page.clock.pauseAt(T0 + 1000);
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
    const adminReqs = () => st.reqs.filter((r) => r.h['x-admin-token']);
    const txt = (sel) => page.$eval(sel, (e) => e.textContent);
    const vis = (sel) => page.$eval(sel, (e) => !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length));
    await page.goto(`${ORIGIN}/lab`);
    await sync();
    const login = async () => { await page.click('#go'); await until(async () => hits('/api/lab/list').length > 0 && !(await page.$eval('#go', (e) => e.disabled)), 'login'); await sleep(150); };
    // 크게 보기(초대 QR) 칸: 닫혀 있으면 링크 글자·QR·이름·인원·손 요약이 숨은 DOM 에도 없어야 한다
    const bigDom = () => page.evaluate(() => ({ hidden: document.getElementById('big').hidden, url: document.getElementById('bigUrl').textContent, name: document.getElementById('bigName').textContent,
      count: document.getElementById('bigCount').textContent, hands: document.getElementById('bigHands').textContent, qr: document.getElementById('bigQr').children.length, inv: document.body.innerHTML.includes('/j/inv-') }));
    const bigCleared = (b) => b.hidden && b.url === '' && b.name === '' && b.count === '' && b.hands === '' && b.qr === 0 && !b.inv;
    return { ctx, page, st, errors, until, sync, advance, hits, adminReqs, txt, vis, login, bigDom, bigCleared };
  }

  // ── 1. 8시간 복원: 관리 토큰 없이 읽기 전용 ──
  console.log('복원 (모니터 쿠키만)');
  {
    const S = await scene({ monitor: true });
    const { page, st, until, txt, vis } = S;
    await until(() => page.$eval('#panel', (e) => !e.hidden), 'panel');
    await until(async () => (await page.$$('#labs [data-readonly]')).length === 1, 'readonly card');
    check('처음 상태 1번 (본문 {}, 관리 토큰 없음), 관리 API 0', S.hits('/api/lab/teacher/status').length === 1 && J(S.hits('/api/lab/teacher/status')[0].body) === '{}' && S.adminReqs().length === 0 && !S.hits('/api/lab/config').length && !S.hits('/api/lab/list').length);
    check('로그인 카드 숨김, 모니터 만료 표시', await page.$eval('#login', (e) => e.hidden) && (await txt('#monLine')).includes('까지 이 기기에서 계속'));
    check('관리 만료 안내: "관리 작업은 보안 키로 다시 확인" + 다시 확인 버튼', (await txt('#admLine')).includes('관리 작업은 보안 키로 다시 확인') && await vis('#reauth'));
    check('새 수업 폼 숨김(읽기 전용)', !(await vis('#newForm')));
    const hl = await page.$$eval('#handList li', (l) => l.map((x) => ({ t: x.textContent, b: [...x.querySelectorAll('button')].map((b) => b.textContent) })));
    check('손 요약: 자리·이름·수업·기다린 시간·도와주기, 내리기 없음', hl.length === 1 && hl[0].t.includes('1번 kim') && hl[0].t.includes('A수업') && hl[0].t.includes('2분째') && J(hl[0].b) === J(['도와주기']), J(hl));
    check('카드에 버튼 없음 (초대·끝내기·손 내리기)', (await page.$$('#labs button')).length === 0);
    check('탭 제목 ✋1', (await page.title()).startsWith('✋1'));
    check('새로 연 첫 목록은 알림 안 함', (await txt('#handAlert')) === '');
    await page.click('#handList button.go');
    check('자리 보기: 그 자리 줄로 포커스', await page.evaluate(() => document.activeElement?.dataset?.seat === '1'));
    const store = await page.evaluate(() => ({ ls: localStorage.length, ss: sessionStorage.length, ck: document.cookie }));
    check('브라우저 저장소·JS 쿠키 비어 있음', store.ls === 0 && store.ss === 0 && store.ck === '', J(store));
    check('외부·흉내 안 된 요청·페이지 오류 없음', !st.external.length && !st.unknown.length && !S.errors.length, J([st.external, st.unknown, S.errors]));

    // ── 2. 3초 조회: 보이는 탭에서만, 겹침 없음, fetch 상한 10초 ──
    console.log('조회 간격·겹침·상한');
    const n0 = S.hits('/api/lab/teacher/status').length;
    await S.advance(9000);
    const n1 = S.hits('/api/lab/teacher/status').length;
    check(`9초에 3번 (${n1 - n0})`, n1 - n0 === 3, n1 - n0);
    check('신선도: 실시간', await page.$eval('#fresh', (e) => e.dataset.state) === 'live', await txt('#fresh'));
    let release; st.statusGate = new Promise((r) => (release = r));
    await S.advance(3000);
    const n2 = S.hits('/api/lab/teacher/status').length;
    await S.advance(8000);
    check('응답 없는 동안 새 요청 없음 (겹침 0)', S.hits('/api/lab/teacher/status').length === n2 && st.maxInflight === 1, J([n2, S.hits('/api/lab/teacher/status').length, st.maxInflight]));
    check('11초째: 늦어짐 표시, 이전 손 그대로', await page.$eval('#fresh', (e) => e.dataset.state) === 'stale' && (await txt('#handList')).includes('kim'), await txt('#fresh'));
    await S.advance(2500);
    check('10초 상한에서 끊고 "연결 끊김" (이전 내용이라고 명시)', await page.$eval('#fresh', (e) => e.dataset.state) === 'down' && (await txt('#fresh')).includes('지금과 다를 수 있습니다'), await txt('#fresh'));
    st.statusGate = null; release();
    await S.advance(3500);
    check('끊긴 뒤 3초 뒤 다시 조회 → 실시간', S.hits('/api/lab/teacher/status').length === n2 + 1 && await page.$eval('#fresh', (e) => e.dataset.state) === 'live', J([S.hits('/api/lab/teacher/status').length, n2]));
    // 응답 머리는 왔는데 JSON 이 끝나지 않는 경우 (fetch 를 흉내): 상한에서 끊긴다
    await page.evaluate(() => { const real = window.fetch; window.__hang = 0; window.fetch = (u, o) => { if (String(u).includes('/teacher/status') && window.__hangOn) { window.__hang++; return Promise.resolve({ ok: true, status: 200, json: () => new Promise(() => {}) }); } return real(u, o); }; window.__hangOn = true; });
    await S.advance(3000);
    const hg = await page.evaluate(() => window.__hang);
    await S.advance(9000);
    check('JSON 이 안 끝나도 다음 요청 없음', await page.evaluate(() => window.__hang) === hg && hg >= 1);
    await S.advance(1500);
    check('JSON 상한 10초 → 끊김 표시', await page.$eval('#fresh', (e) => e.dataset.state) === 'down', await txt('#fresh'));
    await page.evaluate(() => { window.__hangOn = false; });
    await S.advance(3500);
    check('다시 실시간', await page.$eval('#fresh', (e) => e.dataset.state) === 'live');
    st.statusMode = '500';
    await S.advance(3500);
    check('500 → 끊김 + 오류 문구, 카드는 남김', await page.$eval('#fresh', (e) => e.dataset.state) === 'down' && (await txt('#fresh')).includes('상태 조회 실패') && (await page.$$('#labs [data-readonly]')).length === 1, await txt('#fresh'));
    st.statusMode = 'ok';
    await S.advance(3500);

    console.log('숨은 탭');
    await page.evaluate(() => { window.__hid = true; document.dispatchEvent(new Event('visibilitychange')); });
    const h0 = S.hits('/api/lab/teacher/status').length;
    await S.advance(30000);
    check('숨은 동안 조회 0', S.hits('/api/lab/teacher/status').length === h0);
    await page.evaluate(() => { window.__hid = false; document.dispatchEvent(new Event('visibilitychange')); });
    await until(() => S.hits('/api/lab/teacher/status').length === h0 + 1, 'visible refresh');
    check('돌아오면 시계 안 움직여도 바로 1번', S.hits('/api/lab/teacher/status').length === h0 + 1);
    await S.advance(500);

    // ── 3. 새 손 알림: 한 번만, 소리는 켠 뒤에만 ──
    console.log('새 손 알림');
    st.labs[0].seats[1].hand = st.now;
    await S.advance(3100);
    check('새 손 알림: lee 만', (await txt('#handAlert')).includes('2번 lee') && !(await txt('#handAlert')).includes('kim'), await txt('#handAlert'));
    check('소리 켜기 전: 오디오 없음', J(await page.evaluate(() => window.__audio)) === J({ made: 0, beeps: 0 }));
    check('탭 제목 ✋2', (await page.title()).startsWith('✋2'));
    await page.evaluate(()=>{const d=document.getElementById('opsDialog');if(d.open)d.close()});
    await page.click('#handAck');
    await S.advance(9000);
    check('같은 손은 다시 알리지 않음', (await txt('#handAlert')) === '');
    await page.click('#sound');
    const a1 = await page.evaluate(() => window.__audio);
    check('소리 알림 켜기 누름 → 오디오 1개·확인음 1번, aria-pressed', a1.made === 1 && a1.beeps === 1 && await page.$eval('#sound', (e) => e.getAttribute('aria-pressed')) === 'true', J(a1));
    await S.advance(9000);
    check('새 손 없으면 소리 없음', (await page.evaluate(() => window.__audio.beeps)) === 1);
    delete st.labs[0].seats[1].hand; await S.advance(3100);
    st.labs[0].seats[1].hand = st.now; await S.advance(3100);
    check('내렸다 다시 든 손(새 시각) → 알림·소리 1번', (await txt('#handAlert')).includes('2번 lee') && (await page.evaluate(() => window.__audio.beeps)) === 2);
    await S.advance(9000);
    check('그 뒤 반복 조회에도 소리 그대로', (await page.evaluate(() => window.__audio.beeps)) === 2);
    check('모니터만으로는 관리·쓰기 요청 0', S.adminReqs().length === 0 && !st.reqs.some((r) => /\/api\/lab\/(hand|end|create|invite|clip|share|snip)/.test(r.p)));

    // ── 4. 모니터 401 → 멈추고 로그인 ──
    console.log('모니터 401');
    st.statusMode = '401';
    await S.advance(3100);
    await until(() => page.$eval('#login', (e) => !e.hidden), 'login after 401');
    const k = S.hits('/api/lab/teacher/status').length;
    await S.advance(15000);
    check('401: 로그인 화면·안내, 조회 멈춤, 목록·손 지움', (await txt('#loginNote')).includes('모니터 세션이 끝났습니다') && S.hits('/api/lab/teacher/status').length === k && (await page.$$('#labs .card')).length === 0 && !(await page.title()).startsWith('✋'));
    await S.ctx.close();
  }

  console.log('처음 401');
  {
    const S = await scene({ monitor: false });
    await S.until(async () => (await S.txt('#loginNote')).includes('보안 키로'), 'login note');
    await S.advance(20000);
    check('401: 로그인 카드, 조회 1번에서 멈춤, 패널 숨김', !(await S.page.$eval('#login', (e) => e.hidden)) && await S.page.$eval('#panel', (e) => e.hidden) && S.hits('/api/lab/teacher/status').length === 1);
    await S.ctx.close();
  }

  console.log('관리 권한은 8시간까지 유지');
  {
    const S=await scene();await S.until(async()=>(await S.txt('#loginNote')).includes('보안 키로'),'boot');await S.login();
    const jump=async(ms)=>{S.st.now+=ms;await S.page.clock.fastForward(ms);await S.sync();await S.advance(1000)};
    await jump(11*60e3);
    check('10분 뒤에도 새 수업 관리 버튼 유지',await S.page.$eval('#newForm',e=>!e.hidden)&&!(await S.vis('#reauth')));
    await jump(7*3600e3);
    check('7시간 뒤에도 관리 화면·목록 요청 유지',await S.page.$eval('#newForm',e=>!e.hidden)&&S.hits('/api/lab/list').length>1);
    await jump(S.st.adminExp-S.st.now+1000);
    check('8시간 만료 뒤 관리 버튼 닫힘',!(await S.vis('#newForm')));
    const count=S.adminReqs().length;await S.advance(3000);
    check('8시간 만료 뒤 관리 요청 중지',S.adminReqs().length===count);
    check('관리 토큰을 브라우저 저장소에 보관하지 않음',await S.page.evaluate(()=>localStorage.length===0&&sessionStorage.length===0));
    await S.ctx.close();
  }

  // ── 5. 서버가 짧은 수명을 준 경우에도 실제 만료 → 읽기 전용 → 다시 확인 ──
  console.log('관리 만료·다시 확인');
  {
    const S = await scene({ monitor: false, adminTtl: 600000 });
    const { page, st, until, txt, vis } = S;
    await until(async () => (await txt('#loginNote')).includes('보안 키로'), 'boot');
    await S.login();
    const ses = S.hits('/api/lab/teacher/session');
    check('로그인: session 을 관리 토큰으로 1번, 그 뒤 config·list', ses.length === 1 && ses[0].h['x-admin-token'] === st.tokens[0] && S.hits('/api/lab/config').length === 1);
    const order = st.reqs.map((r) => r.p).filter((p) => /session|config|list/.test(p) && !p.startsWith('/api/lab/teacher/push/'));
    check('순서: 기존 세션 복원 시도 → 로그인 유지 → 모니터 → 화면 → config → list', J(order.filter(p=>p!=='/api/lab/open/manager/list').slice(0, 6)) === J(['/api/lab/admin/session', '/api/lab/admin/session/remember', '/api/lab/teacher/session', '/api/lab/live/session', '/api/lab/config', '/api/lab/list']), J(order));
    check('관리 화면: 카드에 버튼, 손 요약에 내리기', (await page.$$('#labs [data-readonly]')).length === 0 && (await page.$$eval('#handList button', (b) => b.map((x) => x.textContent))).includes('내리기'));
    check('진행 중 수업이 있으면 새 수업은 접힘', !(await page.$eval('#newLab', (e) => e.open)));
    await page.click('#navSet'); await page.click('#navPrep'); await page.$eval('#newLab', (e) => { e.open = true; }); await page.$eval('#l_model', (e) => { e.closest('details').open = true; });
    await page.fill('#l_name', '초안 수업'); await page.fill('#l_model', 'my/model');
    await page.click('#prepClose'); await page.click('#runMaterials'); await page.locator('#labs [data-snip] textarea').fill('echo 초안');
    check('관리 남은 시간 표시', /관리 작업: \d+분 \d+초 남음/.test(await txt('#admLine')), await txt('#admLine'));
    const l0 = S.hits('/api/lab/list').length;
    await S.advance(60000, 3000);
    const l1 = S.hits('/api/lab/list').length;
    check(`관리 중 전체 목록은 15초마다 (${l1 - l0}번/60초)`, l1 - l0 >= 3 && l1 - l0 <= 5, l1 - l0);
    // QR 크게 보기 + 손 요약
    await page.evaluate(()=>{const d=document.getElementById('opsDialog');if(d.open)d.close()});
    await page.click('#runTools'); await page.locator('#labs details[data-lab-section="참여자"]').evaluate(e=>e.open=true); await page.locator('#labs tr[data-seat="2"] button', { hasText: /^초대$/ }).click();
    await until(() => page.$eval('#big', (e) => !e.hidden), 'big');
    check('크게 보기: 지금 손 든 사람 요약', (await txt('#bigHands')).includes('1번 kim'), await txt('#bigHands'));
    st.labs[0].seats[1].hand = st.now;
    await S.advance(3100);
    check('크게 보기 중 새 손도 요약에', (await txt('#bigHands')).includes('2번 lee') && (await txt('#bigHands')).includes('2명'), await txt('#bigHands'));
    const open1 = await S.bigDom();
    check('크게 보기: 그 자리 링크·이름·인원·QR 표시', open1.url === 'lab.example.test/j/inv-A-2' && open1.name.includes('A수업') && open1.count.includes('명 입장') && open1.qr === 1, J(open1));
    await page.click('#bigClose');
    check('닫기: 링크 글자·QR·이름·인원·손 요약이 숨은 DOM 에도 없음', S.bigCleared(await S.bigDom()), J(await S.bigDom()));
    await S.advance(3100);
    check('닫힌 뒤 조회가 와도 손 요약을 숨은 칸에 다시 쓰지 않음', S.bigCleared(await S.bigDom()), J(await S.bigDom()));
    const a0 = S.adminReqs().length;
    await S.advance(550000, 5000);
    check('서버가 준 짧은 만료 뒤: 관리 요청 멈춤 + 안내 + 읽기 전용', (await txt('#admLine')).includes('관리 작업은 보안 키로 다시 확인') && await vis('#reauth') && (await page.$$('#labs [data-readonly]')).length === 1, await txt('#admLine'));
    const a1 = S.adminReqs().length;
    const lateAdmin = st.reqs.filter((r) => r.h['x-admin-token'] && r.at >= st.adminExp);
    check('만료 시각 뒤 관리 토큰 요청 0', lateAdmin.length === 0, J(lateAdmin.map((r) => r.p)));
    await S.advance(60000, 3000);
    check('만료 뒤 1분: 관리 요청 0, 모니터는 계속', S.adminReqs().length === a1 && (await page.$eval('#fresh', (e) => e.dataset.state)) === 'live' && a1 > a0);
    check('손 요약: 내리기 없음 + 안내', !(await page.$$eval('#handList button', (b) => b.map((x) => x.textContent))).includes('내리기') && await vis('#handRo'));
    check('새 수업 폼 숨김, 입력은 남아 있음', await page.$eval('#newForm',e=>e.hidden) && await page.$eval('#newLocked',e=>!e.hidden) && await page.$eval('#l_name', (e) => e.value) === '초안 수업');
    // 만료 뒤 남은 함수로 쓰기를 부르면: 보내지 않고 다시 확인 안내
    const before = st.reqs.length;
    await page.evaluate(() => document.getElementById('l_make').onclick());
    await S.advance(1000);
    check('만료 뒤 만들기: 요청 없이 안내', st.reqs.slice(before).every((r) => r.p === '/api/lab/teacher/status') && (await txt('#l_msg')).includes('관리 작업은 보안 키로 다시 확인'), await txt('#l_msg'));
    check('자동 다시 로그인 없음', S.hits('/api/admin/login').length === 1 && S.hits('/api/admin/options').length === 1);
    // 다시 확인 (누를 때만)
    await page.click('#reauth');
    await until(async () => S.hits('/api/admin/login').length === 2 && (await page.$$('#labs [data-readonly]')).length === 0 && (await page.$$('#labs [data-snip]')).length === 1, 'reauth');
    check('다시 확인: 새 토큰으로 session 다시, 관리 화면 복귀', S.hits('/api/lab/teacher/session').length === 2 && S.hits('/api/lab/teacher/session')[1].h['x-admin-token'] === st.tokens[1]);
    check('다시 확인: 적어 둔 이름·모델·코드 초안 그대로 (설정 기본값으로 덮지 않음)', await page.$eval('#l_name', (e) => e.value) === '초안 수업' && await page.$eval('#l_model', (e) => e.value) === 'my/model' && await page.locator('#labs [data-snip] textarea').inputValue() === 'echo 초안');
    // 손 내리기는 누를 때만, 관리 토큰으로
    await page.locator('#handList li', { hasText: '1번 kim' }).locator('button', { hasText: '내리기' }).click();
    await until(() => S.hits('/api/lab/hand').length === 1, 'hand');
    check('내리기: {id,n} + 지금 관리 토큰', J(S.hits('/api/lab/hand')[0].body) === J({ id: 'A', n: 1 }) && S.hits('/api/lab/hand')[0].h['x-admin-token'] === st.tokens[1]);
    // ── 6. 로그아웃 ──
    console.log('로그아웃');
    // 다시 확인 뒤 다시 열면 지금 링크로 새로 그린다 — 그 상태(크게 보기가 화면을 덮음)에서 로그아웃
    await page.evaluate(()=>{const d=document.getElementById('opsDialog');if(d.open)d.close()});
    await page.click('#runTools'); await page.locator('#labs details[data-lab-section="참여자"]').evaluate(e=>e.open=true); await page.locator('#labs tr[data-seat="1"] button', { hasText: /^초대$/ }).click();
    await until(async () => (await S.bigDom()).url === 'lab.example.test/j/inv-A-1', 'reopen big');
    const open2 = await S.bigDom();
    check('다시 열기: 지금 자리(1번) 링크·이름·인원·QR 새로 표시', !open2.hidden && open2.name.includes('A수업') && open2.name.includes('1번') && open2.count.includes('명 입장') && open2.qr === 1, J(open2));
    await page.evaluate(() => document.getElementById('logout').onclick());
    check('로그아웃 즉시: 초대 링크 글자·QR·이름·인원·손 요약 없음', S.bigCleared(await S.bigDom()), J(await S.bigDom()));
    await until(() => page.$eval('#login', (e) => !e.hidden), 'logged out');
    const s0 = S.hits('/api/lab/teacher/status').length, all0 = st.reqs.length;
    await S.advance(60000, 3000);
    check('로그아웃: logout 1번, 로그인 화면, 목록·손·제목 지움', S.hits('/api/lab/teacher/logout').length === 1 && (await page.$$('#labs .card')).length === 0 && (await page.$$('#handList li[data-hand]')).length === 0 && !(await page.title()).startsWith('✋') && (await txt('#loginNote')).includes('로그아웃했습니다'));
    check('로그아웃 뒤 조회·관리 요청 0', st.reqs.length === all0 && S.hits('/api/lab/teacher/status').length === s0, J(st.reqs.slice(all0).map((r) => r.p)));
    check('로그아웃에 들고 있던 관리 토큰을 함께 냄 (본문 {})', S.hits('/api/lab/teacher/logout')[0].h['x-admin-token'] === st.tokens[1] && J(S.hits('/api/lab/teacher/logout')[0].body) === '{}');
    const store = await page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage), document.cookie, location.href, window.name]));
    check('토큰이 저장소·쿠키·주소에 없음', !st.tokens.some((t) => store.includes(t)), store);
    check('외부·흉내 안 된 요청·페이지 오류 없음', !st.external.length && !st.unknown.length && !S.errors.length, J([st.external, st.unknown, S.errors]));
    await S.ctx.close();
  }

  // ── 7. 모니터를 못 구워도 관리 화면은 열림. 조용한 목록 갱신(크게 보기 중)도 손 요약을 채운다 ──
  console.log('모니터 없음 + 조용한 갱신');
  {
    const S = await scene({ monitor: false, sessionMode: 'fail', adminTtl: 600000 });
    const { page, st, until, txt } = S;
    await until(async () => (await txt('#loginNote')).includes('보안 키로'), 'boot');
    await S.login();
    check('session 실패: 안내, 관리 화면은 열림, 상태 조회 안 함', (await txt('#monLine')).includes('모니터 유지 세션을 만들지 못했습니다') && !(await page.$eval('#panel', (e) => e.hidden)) && S.hits('/api/lab/teacher/status').length === 1);
    await page.evaluate(()=>{const d=document.getElementById('opsDialog');if(d.open)d.close()});
    await page.click('#runTools'); await page.locator('#labs details[data-lab-section="참여자"]').evaluate(e=>e.open=true); await page.locator('#labs tr[data-seat="1"] button', { hasText: /^초대$/ }).click();
    await until(() => page.$eval('#big', (e) => !e.hidden), 'big');
    st.labs[0].seats[1].hand = st.now;
    const l0 = S.hits('/api/lab/list').length;
    await S.advance(5100);
    check('크게 보기 5초 조용한 갱신 → 새 손이 요약·알림에', S.hits('/api/lab/list').length > l0 && (await txt('#bigHands')).includes('2번 lee') && (await txt('#handAlert')).includes('2번 lee'), await txt('#bigHands'));
    check('신선도는 목록 기준 15초', (await txt('#fresh')).includes('15초마다'), await txt('#fresh'));
    await page.click('#bigClose');
    await S.advance(600000, 10000);
    check('모니터 없이 관리 만료 → 로그인 화면·안내, 목록 지움', !(await page.$eval('#login', (e) => e.hidden)) && (await txt('#loginNote')).includes('관리 작업 시간이 끝났습니다') && (await page.$$('#labs .card')).length === 0, J([await page.$eval('#login', (e) => e.hidden), await txt('#loginNote'), (await page.$$('#labs .card')).length, await txt('#admLine')]));
    const n = st.reqs.length;
    await S.advance(60000, 5000);
    check('그 뒤 요청 0', st.reqs.length === n, J(st.reqs.slice(n).map((r) => r.p)));
    await S.ctx.close();
  }

  // ── 9. 만료 시각이 없거나 이상한 로그인 응답: 열지 않는다 (fail closed) ──
  console.log('잘못된 만료 시각');
  for (const [label, fn] of [['없음', () => undefined], ['문자열', (n) => String(n + 600000)], ['이미 지남', (n) => n - 1000], ['NaN 대신 null', () => null]]) {
    const S = await scene({ monitor: false });
    S.st.loginExp = fn;
    await S.until(async () => (await S.txt('#loginNote')).includes('보안 키로'), 'boot');
    await S.page.click('#go');
    await S.until(async () => (await S.txt('#msg')).includes('만료 시각을 알 수 없어'), 'invalid exp ' + label);
    await S.advance(30000, 3000);
    check(`만료 ${label}: 로그인 화면 그대로, 관리 토큰 요청·session·config·list 0`, !(await S.page.$eval('#login', (e) => e.hidden)) && S.adminReqs().length === 0 && !S.hits('/api/lab/teacher/session').length && !S.hits('/api/lab/list').length, J(S.st.reqs.map((r) => r.p)));
    await S.ctx.close();
  }

  // ── 10. 로그아웃 뒤 늦게 온 관리 응답·로그인 응답은 버린다 ──
  console.log('늦은 응답');
  {
    const S = await scene({ monitor: false });
    const { page, st, until, txt } = S;
    await until(async () => (await txt('#loginNote')).includes('보안 키로'), 'boot');
    await S.login();
    let rel; st.listGate = new Promise((r) => (rel = r));
    st.labs[0].seats[1].hand = st.now;
    const l0 = S.hits('/api/lab/list').length;
    await S.advance(15500);
    await until(() => S.hits('/api/lab/list').length > l0, 'list in flight');
    await page.click('#navSet'); await page.click('#logout');
    await until(() => page.$eval('#login', (e) => !e.hidden), 'logout');
    st.listGate = null; rel();
    await S.advance(2000);
    check('로그아웃 뒤 도착한 목록: 카드·손·제목·알림 되살아나지 않음', (await page.$$('#labs .card')).length === 0 && (await page.$$('#handList li[data-hand]')).length === 0 && !(await page.title()).startsWith('✋') && (await txt('#handAlert')) === '' && !(await page.$eval('#login', (e) => e.hidden)), J([(await page.$$('#labs .card')).length, await page.title(), await txt('#handAlert'), await txt('#handList')]));
    // 로그인 도중 로그아웃(모니터로 복원된 화면에서 다시 확인 → 키 응답 대기 중 로그아웃)
    st.monitor = true;
    await page.click('#mRetry').catch(() => {});
    await page.evaluate(() => document.getElementById('mRetry').onclick());
    await until(() => page.$eval('#panel', (e) => !e.hidden), 'restored');
    let rl; st.loginGate = new Promise((r) => (rl = r));
    const n0 = S.hits('/api/admin/login').length;
    await page.click('#reauth');
    await until(() => S.hits('/api/admin/login').length > n0, 'login in flight');
    await page.click('#navSet'); await page.click('#logout');
    await until(() => page.$eval('#login', (e) => !e.hidden), 'logout 2');
    const after = st.reqs.length;
    st.loginGate = null; rl();
    await S.advance(30000, 3000);
    const late = st.reqs.slice(after).map((r) => r.p);
    check('로그아웃 뒤 도착한 로그인 응답: 토큰 안 씀 (session·config·list 0), 로그인 화면 그대로', !late.some((p) => /session|config|list/.test(p)) && !(await page.$eval('#login', (e) => e.hidden)) && st.reqs.slice(after).every((r) => !r.h['x-admin-token']), J(late));
    check('늦은 응답 장면: 페이지 오류 없음', !S.errors.length, J(S.errors));
    await S.ctx.close();
  }

  console.log('화면 공유는 서버가 짧게 준 관리 만료 뒤에도 유지');
  {
    const S=await scene({live:true,adminTtl:600000});await S.until(async()=>(await S.txt('#loginNote')).includes('보안 키로'),'boot');await S.login();
    await S.page.locator('#broadcastDock').getByRole('button',{name:'🖥 화면 공유 시작',exact:true}).click();
    await S.until(()=>S.st.screen,'screen start');
    await S.advance(610000,10000);
    check('관리 만료 뒤에도 영상 트랙을 중지하지 않음',await S.page.evaluate(()=>window.__stopped)===0&&S.st.screen);
    check('관리 만료 뒤 공유 중지 버튼이 남음',await S.vis('#liveTools')&&await S.page.locator('#broadcastDock').getByRole('button',{name:'🖥 화면 공유 멈추기',exact:true}).isVisible());
    const before=S.adminReqs().length;
    await S.page.locator('#broadcastDock').getByRole('button',{name:'🖥 화면 공유 멈추기',exact:true}).click();await S.until(()=>!S.st.screen,'screen stop');
    check('짧은 관리 만료 뒤 공유 중지는 화면 쿠키만, 관리 토큰 요청 없음',S.adminReqs().length===before&&S.hits('/api/lab/live/screen/stop').at(-1).h['x-admin-token']===undefined);
    check('공유 중지 시 실제 트랙 정리',await S.page.evaluate(()=>window.__stopped)===1);
    S.st.monExp=S.st.now+1000;await S.advance(5000);
    check('모니터 쿠키가 먼저 끝나도 유효한 모임 화면은 계속 보임',await S.vis('#liveTools')&&await S.vis('#panel')&&await S.page.$eval('#logout',e=>!e.hidden));
    await S.ctx.close();
  }

  // ── 11. 모니터는 있는데 아직 받은 모니터 데이터가 없을 때 관리 만료: 관리 카드·초대 QR 을 바로 걷어 낸다 ──
  console.log('만료 + 모니터 데이터 없음');
  {
    const S = await scene({ monitor: false, adminTtl: 600000 });
    const { page, st, until, txt, vis } = S;
    await until(async () => (await txt('#loginNote')).includes('보안 키로'), 'boot');
    st.statusMode = '500';
    await S.login();
    check('모니터 조회 실패 중에도 관리 화면', (await page.$$('#labs [data-snip]')).length === 1 && (await page.$eval('#fresh', (e) => e.dataset.state)) === 'down', await txt('#fresh'));
    await page.click('#navSet'); await page.click('#navPrep'); await page.$eval('#newLab', (e) => { e.open = true; }); await page.fill('#l_name', '남길 이름');
    await page.evaluate(()=>{const d=document.getElementById('opsDialog');if(d.open)d.close()});
    await page.click('#prepClose'); await page.click('#runTools'); await page.locator('#labs details[data-lab-section="참여자"]').evaluate(e=>e.open=true); await page.locator('#labs tr[data-seat="1"] button', { hasText: /^초대$/ }).click();
    await until(() => page.$eval('#big', (e) => !e.hidden), 'big');
    check('만료 전: 크게 보기에 초대 링크 표시', (await S.bigDom()).url === 'lab.example.test/j/inv-A-1', J(await S.bigDom()));
    await S.advance(610000, 10000);
    check('관리 만료: 초대 링크 글자·QR·이름·인원·손 요약이 숨은 DOM 에도 없음', S.bigCleared(await S.bigDom()), J(await S.bigDom()));
    const r = await page.evaluate(() => ({ big: document.getElementById('big').hidden, qr: document.getElementById('bigQr').children.length, btns: document.querySelectorAll('#labs button').length, links: document.querySelectorAll('#labs [data-invites], #labs [data-snip]').length, panel: !document.getElementById('panel').hidden }));
    check('만료: 크게 보기 닫고 QR 지움, 관리 카드·버튼·초대 없음, 모니터 화면은 유지', r.big && r.qr === 0 && r.btns === 0 && r.links === 0 && r.panel, J(r));
    check('만료: 입력 보존 + 다시 확인 안내', await page.$eval('#l_name', (e) => e.value) === '남길 이름' && (await txt('#admLine')).includes('관리 작업은 보안 키로 다시 확인') && await vis('#reauth'));
    await S.ctx.close();
  }

  // ── 12. 로그아웃은 누르는 즉시 이 화면을 무효화하고, 응답을 기다리는 동안 다시 확인·로그인·복원을 막는다 ──
  console.log('로그아웃 대기 중');
  {
    const S = await scene({ monitor: false });
    const { page, st, until, txt } = S;
    await until(async () => (await txt('#loginNote')).includes('보안 키로'), 'boot');
    await S.login();
    let rel; st.logoutGate = new Promise((r) => (rel = r));
    const n0 = st.reqs.length;
    await page.click('#navSet'); await page.click('#logout');
    await until(() => S.hits('/api/lab/teacher/logout').length === 1, 'logout sent');
    const r = await page.evaluate(() => ({ login: !document.getElementById('login').hidden, panel: !document.getElementById('panel').hidden, go: document.getElementById('go').disabled, reauth: document.getElementById('reauth').disabled, cards: document.querySelectorAll('#labs .card').length, hands: document.querySelectorAll('#handList li[data-hand]').length }));
    check('응답 전: 바로 로그인 화면, 목록·손 지움, 열기·다시 확인 막힘', r.login && !r.panel && r.go && r.reauth && r.cards === 0 && r.hands === 0, J(r));
    check('응답 전: 관리 토큰을 함께 냄', S.hits('/api/lab/teacher/logout')[0].h['x-admin-token'] === st.tokens[0]);
    await page.evaluate(() => { document.getElementById('go').onclick(); document.getElementById('reauth').onclick(); document.getElementById('mRetry').onclick(); });
    await S.advance(5000);
    check('응답 전: 두 세션의 logout만, 로그인·조회·관리 요청 0', J(st.reqs.slice(n0).map((x) => x.p)) === J(['/api/lab/live/logout','/api/lab/teacher/logout']), J(st.reqs.slice(n0).map((x) => x.p)));
    st.logoutGate = null; rel();
    await until(async () => (await txt('#loginNote')).includes('로그아웃했습니다'), 'logout done');
    check('응답 뒤: 다시 열 수 있음', !(await page.$eval('#go', (e) => e.disabled)) && !S.errors.length, J(S.errors));
    await S.ctx.close();
  }

  // ── 13. 다시 확인의 session 응답이 오기 전에 로그아웃: 그 관리 토큰을 함께 내고, 늦게 온 session 본문으로 되살아나지 않는다 ──
  console.log('session 대기 중 로그아웃');
  {
    const S = await scene({ monitor: true });
    const { page, st, until, txt } = S;
    await until(() => page.$eval('#panel', (e) => !e.hidden), 'restored');
    let rel; st.sessionGate = new Promise((r) => (rel = r));
    await page.click('#reauth');
    await until(() => S.hits('/api/lab/teacher/session').length === 1, 'session in flight');
    await page.click('#navSet'); await page.click('#logout');
    await until(() => page.$eval('#login', (e) => !e.hidden), 'logout');
    await until(async () => (await txt('#loginNote')).includes('로그아웃했습니다'), 'logout done');
    check('로그아웃에 session 중인 관리 토큰을 냄', S.hits('/api/lab/teacher/logout')[0]?.h['x-admin-token'] === st.tokens[0] && S.hits('/api/lab/teacher/session')[0].h['x-admin-token'] === st.tokens[0]);
    const after = st.reqs.length;
    st.sessionGate = null; rel();
    await S.advance(30000, 3000);
    check('늦게 온 session 본문: 모니터·관리 화면 되살아나지 않음, 그 뒤 요청 0', !(await page.$eval('#login', (e) => e.hidden)) && (await page.$eval('#panel', (e) => e.hidden)) && st.reqs.length === after && !(await page.$eval('#go', (e) => e.disabled)), J(st.reqs.slice(after).map((x) => x.p)));
    check('페이지 오류 없음', !S.errors.length, J(S.errors));
    await S.ctx.close();
  }

  // ── 8. 폰 폭: 가로 스크롤 없음, 손 요약이 먼저 ──
  console.log('폰 폭');
  {
    const labs = [{ id: 'A', name: '아주 긴 수업 이름이 들어가도 줄바꿈 되는지 보는 수업', expiresAt: T0 + 3600e3, seats: [1, 2, 3, 4].map((n) => seat(n, { who: '참가자' + n, hand: T0 - n * 60000 })) }];
    const S = await scene({ monitor: true, labs, viewport: { width: 360, height: 740 } });
    await S.until(() => S.page.$eval('#panel', (e) => !e.hidden), 'panel');
    await S.until(async () => (await S.page.$$('#handList li[data-hand]')).length === 4, 'hands');
    const g = await S.page.evaluate(() => ({ sw: document.documentElement.scrollWidth, vw: innerWidth, hands: document.getElementById('handsBar').getBoundingClientRect().top, content: document.getElementById('classMain').getBoundingClientRect().top, toolsClosed: !document.getElementById('opsDialog').open, sticky: getComputedStyle(document.getElementById('handsBar')).position }));
    check('360px: 가로 스크롤 없음, 손 요약이 진행 내용 위·도구는 패널', g.sw <= g.vw && g.hands < g.content && g.toolsClosed && g.sticky === 'static', J(g));
    check('손 요약: 오래 기다린 순서', J(await S.page.$$eval('#handList .hwho', (l) => l.map((x) => x.textContent))) === J(['4번 참가자4', '3번 참가자3', '2번 참가자2', '1번 참가자1']));
    await S.ctx.close();
  }
}
