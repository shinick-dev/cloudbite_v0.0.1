// 강사 설치 앱(/lab) 회귀: manifest·아이콘·서비스 워커 경로와 헤더, /lab 에만 넓힌 CSP, 워커가 아무것도 저장·가로채지 않는지,
// 실제 Edge 에서 scope 가 /lab 으로만 잡히고 /admin·/vault·/borrow 를 제어하지 않는지. 네트워크·배포 없음.
//   public-get.ts 를 esbuild 로 묶어(go.ps1 은 text) 로컬 http 서버(127.0.0.1 임시 포트)로 띄운다. Edge 가 없으면 브라우저 절만 skip.
//   node test/lab-teacher-pwa.mjs
import { build } from 'esbuild';
import { createServer } from 'node:http';
import vm from 'node:vm';

let pass = 0, failN = 0, skipN = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { failN++; console.log(`  FAIL ${name} ${String(extra).slice(0, 400)}`); }
};
const J = JSON.stringify;
const done = () => { console.log(`\n${pass} ok, ${failN} fail, ${skipN} skip`); process.exit(failN ? 1 : 0); };
setTimeout(() => { console.log('  FAIL 전체 시간 상한 120초'); failN++; done(); }, 120000).unref();

const out = await build({
  stdin: { contents: "export { publicGet } from './src/public-get.ts'; export { TEACHER_SW_JS } from './src/lab-teacher-app.ts';", resolveDir: new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), loader: 'ts' },
  bundle: true, format: 'esm', platform: 'neutral', write: false, loader: { '.ps1': 'text' }, logLevel: 'silent',
});
const { publicGet, TEACHER_SW_JS } = await import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'));

const SEC = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY' };
const BASE_CSP = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const html = (b) => new Response(b, { headers: { ...SEC, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': BASE_CSP } });
const json = (d, status = 200) => new Response(JSON.stringify(d), { status, headers: { ...SEC, 'content-type': 'application/json' } });
const get = (path) => publicGet({ path, url: new URL('https://k.example.test' + path), env: { ORIGIN: 'https://k.example.test', LAB_ORIGIN: 'https://lab.example.test', RP_ID: 'k.example.test' }, state: { requestInfo: async () => ({}) }, sec: SEC, html, json, out: json });

console.log('경로·헤더');
const lab = await get('/lab');
const csp = lab.headers.get('content-security-policy') ?? '';
check('/lab CSP: 공통 CSP 그대로 + manifest-src·worker-src self', csp.startsWith(BASE_CSP) && csp.includes("manifest-src 'self'") && csp.includes("worker-src 'self'") && lab.headers.get('cache-control') === 'no-store', csp);
const labHtml = await lab.text();
check('/lab 머리: 강사 manifest·아이콘 (참가자 /__lab manifest 아님)', labHtml.includes('<link rel="manifest" href="/__teacher/manifest.webmanifest">') && !labHtml.includes('/__lab/manifest'));
for (const p of ['/admin', '/vault', '/borrow']) {
  const r = await get(p), t = await r.text();
  check(`${p}: 공통 CSP 그대로, manifest·워커 없음`, r.headers.get('content-security-policy') === BASE_CSP && !t.includes('manifest') && !t.includes('teacher-sw'));
}
const man = await get('/__teacher/manifest.webmanifest');
const M = await man.json();
check('manifest: id·start_url·scope /lab, 모임지기 이름, standalone', M.id === '/lab' && M.start_url === '/lab' && M.scope === '/lab' && M.name === '공부방 실습실 모임지기' && M.display === 'standalone' && man.headers.get('content-type') === 'application/manifest+json', J(M));
check('manifest: 참가자 앱(id /, "AI 실습실")과 다름', M.id !== '/' && M.name !== 'AI 실습실' && M.short_name !== 'AI 실습실');
for (const ic of M.icons) {
  const r = await get(ic.src), b = new Uint8Array(await r.arrayBuffer());
  const w = (b[16] << 24) | (b[17] << 16) | (b[18] << 8) | b[19];
  check(`아이콘 ${ic.src} ${ic.purpose}: PNG ${ic.sizes}`, r.headers.get('content-type') === 'image/png' && b[1] === 0x50 && `${w}x${w}` === ic.sizes);
}
const sw = await get('/lab/teacher-sw.js');
const swSrc = await sw.text();
check('워커: JS, Service-Worker-Allowed /lab, no-store', sw.headers.get('service-worker-allowed') === '/lab' && sw.headers.get('content-type').startsWith('text/javascript') && sw.headers.get('cache-control') === 'no-store');
const swCode = swSrc.replace(/^\/\/.*$/gm, '');
check('워커 소스: 저장소 API 없음', !/caches|indexedDB|localStorage|sessionStorage|cookie/i.test(swCode));
// W2: 워커는 알림을 띄우기만 한다 — 권한·구독·payload 읽기·스크립트 가져오기·postMessage 없음
check('워커 소스: 권한 요청·구독·외부 코드·메시지 송신 없음', !/requestPermission|pushManager|subscribe|importScripts|postMessage|\.text\(/i.test(swCode));
for (const p of ['/lab/', '/lab/teacher-sw', '/__teacher/x.png', '/teacher-sw.js']) check(`없는 경로 ${p} → 404`, (await get(p)).status === 404);

console.log('워커 동작 (가짜 self)');
{
  const L = {}; let net = 'ok'; const fetched = [], shown = [], opened = [], focused = []; let wins = [];
  const self = { addEventListener: (k, f) => { L[k] = f; }, skipWaiting() {},
    registration: { showNotification: async (title, opt) => { shown.push([title, opt]); } },
    clients: { claim: async () => {}, matchAll: async (o) => { self.__match = o; return wins; }, openWindow: async (u) => { opened.push(u); return null; } } };
  vm.runInNewContext(TEACHER_SW_JS, { self, location: { origin: 'https://k.example.test' }, URL, Response,
    fetch: async (r) => { fetched.push(r.url); if (net === 'down') throw new TypeError('offline'); return new Response('net'); } });
  const ev = (url, mode, method = 'GET') => { let res = null; L.fetch({ request: { url, mode, method }, respondWith: (p) => { res = p; } }); return res; };
  const passThru = [['https://k.example.test/api/lab/teacher/status', 'cors', 'POST'], ['https://k.example.test/api/lab/list', 'cors', 'POST'], ['https://k.example.test/admin', 'navigate'],
    ['https://k.example.test/vault', 'navigate'], ['https://k.example.test/borrow', 'navigate'], ['https://k.example.test/webauthn.js', 'no-cors'], ['https://lab.example.test/lab', 'navigate'], ['https://k.example.test/lab?x', 'cors']];
  check('API·다른 화면·다른 출처·스크립트: 가로채지 않음 (브라우저 기본 네트워크)', passThru.every(([u, m, me]) => ev(u, m, me) === null));
  const ok = await ev('https://k.example.test/lab', 'navigate');
  check('/lab 이동: 네트워크 응답 그대로', (await ok.text()) === 'net' && fetched.length === 1);
  net = 'down';
  const off = await ev('https://k.example.test/lab', 'navigate');
  const ot = await off.text();
  check('/lab 오프라인: 503 고정 안내(no-store, 스크립트·사용자 값 없음)', off.status === 503 && off.headers.get('cache-control') === 'no-store' && ot.includes('연결이 없어') && !/<script|token|labs/i.test(ot));

  console.log('워커 알림 (가짜 push·notificationclick)');
  const GEN = J(['공부방 실습실', { body: '참여자가 손을 들었습니다. 모임지기 화면에서 확인하세요.', icon: '/__teacher/icon-192.png', tag: 'gw-teacher-hand', renotify: true }]);
  const fire = async (k, ev) => { const w = []; L[k]({ ...ev, waitUntil: (p) => w.push(p) }); await Promise.all(w); return w.length; };
  let read = 0;
  const hostile = { json: () => { read++; return { title: '<img src=x onerror=alert(1)>', body: '3번 kim 손 듦', icon: 'https://evil.test/i.png', url: 'https://evil.test/' }; }, text: () => { read++; return 'kim'; }, arrayBuffer: () => { read++; return new ArrayBuffer(0); } };
  const payloads = [['이름·주소가 든 payload', { data: hostile }], ['payload 없음', { data: null }], ['JSON 아닌 payload', { data: { json: () => { read++; throw new SyntaxError('x'); }, text: () => { read++; return '\u0000'; } } }], ['data 필드 없음', {}]];
  for (const [label, ev] of payloads) {
    shown.length = 0;
    const n = await fire('push', ev);
    check(`push ${label}: waitUntil 1번, 고정 일반 알림 1개 (이름·주소·data 없음)`, n === 1 && shown.length === 1 && J(shown[0]) === GEN, J(shown));
  }
  check('push: 고정 tag 분류를 위한 JSON만 읽음 (문구·주소·text·arrayBuffer 사용 안 함)', read === 2, read);
  shown.length = 0;
  await fire('push', {data:{json:()=>({tag:'lab-open-request',body:'비밀 이름',url:'https://evil.test/'})}});
  check('개설 요청: 고정 문구·고정 종류만 표시, 사용자 문구·주소 제외', shown.length===1 && shown[0][1].body==='실습실 개설 요청이 있습니다. 요청함에서 확인하세요.' && shown[0][1].data.kind==='open-request' && !J(shown).includes('비밀 이름') && !J(shown).includes('evil'));
  const clickEv = (data) => { const nt = { closed: 0, data, close() { this.closed++; } }; return nt; };
  const win = (url) => ({ url, n: 0, focus() { this.n++; focused.push(url); return Promise.resolve(this); } });
  // 같은 출처라도 /admin·/vault·/lab/x·/lab?(경로 다름 아님) — 정확히 /lab 경로인 창만
  wins = [win('https://evil.test/lab'), win('https://k.example.test/admin'), win('https://k.example.test/vault'), win('https://k.example.test/lab/x'), win('https://k.example.test/lab?from=x#h'), win('https://k.example.test/lab')];
  let nt = clickEv({ url: 'https://evil.test/phish' });
  let n = await fire('notificationclick', { notification: nt });
  check('click: 알림 닫음, waitUntil, 같은 출처 /lab 창 하나만 앞으로, 새 창 없음', nt.closed === 1 && n === 1 && J(focused) === J(['https://k.example.test/lab?from=x#h']) && !opened.length && self.__match?.type === 'window', J([focused, opened]));
  focused.length = 0; wins = [win('https://evil.test/lab'), win('https://k.example.test/admin'), win('https://k.example.test/borrow'), win('https://lab.example.test/lab')];
  nt = clickEv({ url: 'https://evil.test/phish', open: '/admin' });
  await fire('notificationclick', { notification: nt, action: 'https://evil.test/' });
  check('click: /lab 창이 없으면 고정 주소 /lab 만 새로 (알림 data·action 의 주소 무시, 다른 창 안 건드림)', nt.closed === 1 && !focused.length && J(opened) === J(['https://k.example.test/lab']), J([focused, opened]));
  opened.length = 0; wins = [{ url: 'https://k.example.test/lab', focus: () => Promise.reject(new Error('no focus')) }];
  await fire('notificationclick', { notification: clickEv() });
  check('click: 앞으로 가져오기가 실패하면 /lab 새로', J(opened) === J(['https://k.example.test/lab']), J(opened));
  opened.length = 0; focused.length = 0; wins = [win('https://k.example.test/lab')];
  await fire('notificationclick', {notification:clickEv({kind:'open-request',url:'https://evil.test/'})});
  check('개설 알림 클릭: 고정 요청함만 열고 임의 URL과 관리 화면은 사용 안 함',J(opened)===J(['https://k.example.test/lab/requests'])&&!focused.length);
  check('알림 이벤트 뒤에도 네트워크·저장 없음', fetched.length === 2, J(fetched));
}

console.log('Edge: 실제 등록 scope');
let chromium, browser;
try { ({ chromium } = await import('playwright-core')); browser = await chromium.launch({ channel: 'msedge', headless: true }); }
catch (e) { skipN++; console.log(`  skip Edge 없음 (${String(e.message).split('\n')[0]})`); }
if (browser) {
  const srv = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    let r = req.method === 'GET' ? await get(path) : json({ error: 'no monitor' }, 401);
    res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
  });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  const O = `http://localhost:${srv.address().port}`;
  try {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    page.setDefaultTimeout(10000);
    const errs = []; page.on('pageerror', (e) => errs.push(e.message));
    await page.goto(O + '/lab');
    const wide = await page.evaluate(() => navigator.serviceWorker.register('/lab/teacher-sw.js', { scope: '/' }).then(() => 'ok', (e) => e.name));
    check('scope / 로 넓히기: 거부', wide !== 'ok', wide);
    const reg = await page.evaluate(async () => { const r = await navigator.serviceWorker.register('/lab/teacher-sw.js', { scope: '/lab' }); await navigator.serviceWorker.ready; return r.scope; });
    check('scope /lab 등록 (Service-Worker-Allowed 덕분)', reg === O + '/lab', reg);
    await page.reload();
    check('/lab 은 이 워커가 제어', await page.evaluate(() => !!navigator.serviceWorker.controller));
    for (const p of ['/admin', '/vault', '/borrow']) {
      await page.goto(O + p);
      check(`${p}: 워커 제어 없음`, await page.evaluate(() => !navigator.serviceWorker.controller));
    }
    const regs = await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).map((r) => r.scope));
    check('등록은 /lab 하나', J(regs) === J([O + '/lab']), J(regs));
    await page.goto(O + '/lab');
    const st = await page.evaluate(async () => ({ caches: (await caches.keys()).length }));
    check('Cache Storage 비어 있음', st.caches === 0, J(st));
    check('페이지 오류 없음', !errs.length, J(errs));
    await ctx.close();
  } finally { await browser.close(); srv.close(); }
}
done();
