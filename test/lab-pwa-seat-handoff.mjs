// 공부방 PWA: 실습실 앱은 입장 호스트(LAB_ORIGIN)에만 — 사라질 자리 주소에 새 설치가 묶이지 않게.
// src/labhost.ts·src/labbar.ts 를 설치된 esbuild 로 번들해 그대로 부른다 (State 는 호출을 세는 가짜, fetch·HTMLRewriter 도 가짜):
//   - GET/HEAD /__lab/home (입장·자리 호스트): 늘 LAB_ORIGIN/ 로 302, 쿼리·코드 무시, no-store·no-referrer, Set-Cookie·DO·upstream 없음
//   - 자리 호스트 출처 검사는 /__lab/home 보다 먼저 그대로 (다른 사이트·iframe·fetch·WebSocket·다른 Origin)
//   - 예전 manifest(두 호스트)는 같은 id·start_url·scope
//   - 자리 호스트 화면(VS Code 최상위 문서·입장·확인·끝남)은 manifest 를 알리지 않는다. 입장 호스트 화면은 알린다
//   - 끝난 자리(403·404·410)는 그 초대를 다시 열게 하지 않고 실습실 앱으로, 잠깐의 오류(502·503)는 그 초대로
//   - 막대: "다른 실습실" 은 같은 창에서 /__lab/home 으로만 (토큰·코드 없음), 설치 제안 코드 없음
// 네트워크·비밀 값 없음.  node test/lab-pwa-seat-handoff.mjs

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { build } from 'esbuild';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const cfStub = { name: 'cf-stub', setup(b) {
  b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'cf', namespace: 'cf-stub' }));
  b.onLoad({ filter: /.*/, namespace: 'cf-stub' }, () => ({ contents: 'export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }', loader: 'js' }));
} };
async function load(entry, name) {
  const out = await build({ entryPoints: [join(ROOT, entry)], bundle: true, write: false, format: 'esm', platform: 'node', loader: { '.ps1': 'text' }, plugins: [cfStub], logLevel: 'silent' });
  const dir = mkdtempSync(join(tmpdir(), 'lab-pwa-seat-handoff-'));
  writeFileSync(join(dir, name), out.outputFiles[0].text);
  try { return await import(pathToFileURL(join(dir, name)).href); } finally { rmSync(dir, { recursive: true, force: true }); }
}
const H = await load('src/labhost.ts', 'labhost.mjs');
const B = await load('src/labbar.ts', 'labbar.mjs');

let pass = 0, failN = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { failN++; console.log(`  FAIL ${name} ${String(extra).slice(0, 300)}`); }
};

const LAB_ORIGIN = 'https://lab.example.test', SEAT_DOMAIN = 'example.test';
const ENV = { ORIGIN: 'https://k.example.test', LAB_ORIGIN, LAB_SEAT_DOMAIN: SEAT_DOMAIN };
const CODE = 'abcdEFGH1234_-xy';
const LABEL = 'abcdefghijklmnopqrstuvwxyz';
const ME = `https://s-${LABEL}.${SEAT_DOMAIN}`;
const UP = 'https://upstream.example.test';
const MF = '<link rel="manifest" href="/__lab/manifest.webmanifest">';

const calls = [];
let replies = {};
const state = new Proxy({}, { get: (_, k) => (typeof k !== 'string' || k === 'then') ? undefined : async (...args) => {
  calls.push([k, ...args]);
  const r = replies[k];
  return typeof r === 'function' ? r(...args) : r;
} });
const fetched = [];
let upstream = { make: () => new Response('x') };
globalThis.fetch = async (u, init) => { fetched.push(String(u)); if (upstream.throw) throw new Error('down'); return upstream.make(init); };
const okRoute = () => ({ origin: UP, token: 'preview-tok', expiresAt: Date.now() + 3600e3, seat: 1, clip: { in: true, out: true }, label: LABEL });

const reset = () => { calls.length = 0; fetched.length = 0; };
async function entryReq(path, { method = 'GET', headers = {} } = {}) {
  reset();
  const req = new Request(LAB_ORIGIN + path, { method, headers });
  return H.labHost(req, ENV, state, new URL(req.url));
}
async function seatReq(path, { method = 'GET', headers = {}, cookie = `__Host-lab_seat=${CODE}`, body } = {}) {
  reset();
  const h = { 'sec-fetch-site': 'same-origin', ...headers };
  if (cookie) h.cookie = cookie;
  const req = new Request(ME + path, { method, headers: h, body });
  return H.labSeatHost(req, ENV, state, new URL(req.url), LABEL);
}
const isHome = (res) => res.status === 302 && res.headers.get('location') === `${LAB_ORIGIN}/` && res.headers.get('cache-control') === 'no-store'
  && res.headers.get('referrer-policy') === 'no-referrer' && res.headers.get('set-cookie') === null;
const DOC = { 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate', accept: 'text/html' };

// ── 1. 입장 호스트 /__lab/home ──
console.log('입장 호스트 /__lab/home');
replies = {};
for (const method of ['GET', 'HEAD']) {
  for (const q of ['', `?to=https://evil.example/&code=${CODE}`, '?next=//evil.example', `?j=${CODE}#x`]) {
    const res = await entryReq('/__lab/home' + q, { method, headers: DOC });
    check(`${method} /__lab/home${q}: LAB_ORIGIN/ 로 고정·쿠키 없음·DO·upstream 없음`, isHome(res) && calls.length === 0 && fetched.length === 0 && !(await res.text()),
      `${res.status} ${res.headers.get('location')} ${JSON.stringify(calls)}`);
  }
}
{
  const res = await entryReq('/__lab/home', { headers: { cookie: 'lab_seat=old' } });
  check('예전 lab_seat 쿠키는 지금처럼 지우기만 (새 쿠키 없음)', res.status === 302 && res.headers.get('location') === `${LAB_ORIGIN}/` && /^lab_seat=; .*Max-Age=0/.test(res.headers.get('set-cookie') ?? '') && calls.length === 0);
  const post = await entryReq('/__lab/home', { method: 'POST', headers: { origin: LAB_ORIGIN, 'content-type': 'application/json' } });
  check('POST /__lab/home: 404, DO 없음', post.status === 404 && calls.length === 0);
  const other = await entryReq('/__lab/home/x');
  check('다른 경로는 home 아님', other.status === 404 && other.headers.get('location') === null && calls.length === 0);
  const land = await entryReq('/');
  check('입장 호스트(실습실 앱) 화면은 manifest 를 알린다', land.status === 200 && (await land.text()).includes(MF));
}

// ── 2. 자리 호스트 /__lab/home ──
console.log('자리 호스트 /__lab/home');
replies = { labRoute: () => { throw new Error('labRoute should not be called'); } };
for (const method of ['GET', 'HEAD']) {
  for (const [name, cookie] of [['자리 쿠키', `__Host-lab_seat=${CODE}`], ['쿠키 없음', ''], ['형식 틀린 쿠키', '__Host-lab_seat=bad']]) {
    const res = await seatReq(`/__lab/home?to=https://evil.example/&code=${CODE}`, { method, cookie, headers: DOC });
    check(`${method} ${name}: LAB_ORIGIN/ 로 고정·Set-Cookie 없음(자리 쿠키 유지)·DO·upstream 없음`, isHome(res) && calls.length === 0 && fetched.length === 0,
      `${res.status} ${res.headers.get('location')} ${res.headers.get('set-cookie')} ${JSON.stringify(calls)}`);
  }
}
{
  const leave = await seatReq('/__lab/leave');
  check('leave 는 지금처럼 자리 쿠키를 지운다 (home 과 다름)', leave.status === 302 && /^__Host-lab_seat=; .*Max-Age=0/.test(leave.headers.get('set-cookie') ?? ''));
  const post = await seatReq('/__lab/home', { method: 'POST', headers: { origin: ME, 'content-type': 'application/json' }, body: '{}' });
  check('POST /__lab/home: 404, DO 없음', post.status === 404 && calls.length === 0 && fetched.length === 0);
}

// ── 3. 출처 검사가 먼저 (그대로) ──
console.log('자리 호스트 출처 검사');
{
  const x = await seatReq('/__lab/home', { headers: { ...DOC, 'sec-fetch-site': 'cross-site' } });
  const xt = await x.text();
  check('다른 사이트 최상위 이동: 403 안내 (home 아님)', x.status === 403 && x.headers.get('location') === null && calls.length === 0 && !xt.includes(MF));
  const f = await seatReq('/__lab/home', { headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' } });
  check('다른 사이트 fetch: 403 JSON', f.status === 403 && (f.headers.get('content-type') ?? '').includes('application/json') && calls.length === 0);
  const fr = await seatReq('/__lab/home', { headers: { 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe' } });
  check('같은 사이트 iframe: 403', fr.status === 403 && calls.length === 0);
  const ss = await seatReq('/__lab/home', { headers: { ...DOC, 'sec-fetch-site': 'same-site' } });
  const st = await ss.text();
  check('같은 사이트 최상위 이동: 확인 화면 (manifest 없음, 아이콘 그대로)', ss.status === 200 && ss.headers.get('location') === null && st.includes('계속') && !st.includes(MF)
    && st.includes('<link rel="icon" href="/__lab/icon-192.png">') && calls.length === 0);
  const o = await seatReq('/__lab/home', { headers: { origin: 'https://evil.example' } });
  check('다른 Origin: 403', o.status === 403 && calls.length === 0);
  const ws = await seatReq('/__lab/home', { headers: { upgrade: 'websocket' } });
  check('Origin 없는 WebSocket: 403', ws.status === 403 && calls.length === 0);
  const api = await seatReq('/__lab/me', { headers: { 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' } });
  check('같은 사이트 API: 403 (DO 없음)', api.status === 403 && calls.length === 0);
}

// ── 4. 예전 manifest 그대로 ──
console.log('manifest');
for (const [name, get] of [['입장 호스트', () => entryReq('/__lab/manifest.webmanifest')], ['자리 호스트', () => seatReq('/__lab/manifest.webmanifest', { cookie: '' })]]) {
  const res = await get();
  const m = await res.json();
  check(`${name}: 같은 id·start_url·scope·display`, m.id === '/' && m.start_url === '/' && m.scope === '/' && m.display === 'standalone' && m.name === 'AI 실습실'
    && res.headers.get('content-type') === 'application/manifest+json' && calls.length === 0, JSON.stringify(m));
  check(`${name}: 아이콘·색 그대로`, m.theme_color === '#0f172a' && m.background_color === '#0f172a' && JSON.stringify(m.icons.map((i) => i.src + ' ' + i.sizes + ' ' + i.purpose))
    === JSON.stringify(['/__lab/icon-192.png 192x192 any', '/__lab/icon-192.png 192x192 maskable', '/__lab/icon-512.png 512x512 any', '/__lab/icon-512.png 512x512 maskable']));
}
{
  const i = await seatReq('/__lab/icon-192.png', { cookie: '' });
  check('아이콘 그대로 (자리 없이)', i.status === 200 && i.headers.get('content-type') === 'image/png' && calls.length === 0);
}

// ── 5. VS Code 최상위 문서: manifest 를 알리지 않는다 ──
console.log('VS Code 문서');
const rw = { prepend: [], append: [], before: [], sel: [], removed: [] };
globalThis.HTMLRewriter = class {
  constructor() { this.h = []; }
  on(sel, handler) { this.h.push([sel, handler]); rw.sel.push(sel); return this; }
  transform(res) {
    const el = (sel) => ({ prepend: (x) => rw.prepend.push(x), append: (x) => rw.append.push(x), remove: () => rw.removed.push(sel), getAttribute: () => null,
      onEndTag: (fn) => fn({ before: (x) => rw.before.push(x) }) });
    for (const [sel, h] of this.h) h.element(el(sel));
    return res;
  }
};
const resetRw = () => { for (const k of Object.keys(rw)) rw[k] = []; };
replies = { labRoute: okRoute };
upstream = { make: () => new Response('<html><head><link rel="manifest" href="./manifest.json"></head><body>hi</body></html>', { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }) };
{
  resetRw();
  const res = await seatReq('/', { headers: DOC });
  const added = [...rw.prepend, ...rw.append, ...rw.before].join('');
  check('최상위 문서: 200, upstream 으로', res.status === 200 && fetched.length === 1 && fetched[0] === UP + '/');
  check('최상위 문서: 우리 manifest 를 끼우지 않음', !/manifest/i.test(added), added);
  check('최상위 문서: code-server manifest 는 계속 뗀다', rw.sel.includes('link[rel="manifest"]') && rw.removed.includes('link[rel="manifest"]'));
  check('최상위 문서: 테마색·아이콘·guard·막대 그대로', added.includes('<meta name="theme-color" content="#0f172a">') && added.includes('<link rel="icon" href="/__lab/icon-192.png">')
    && rw.prepend[0] === '<script src="/__lab/guard.js"></script>' && rw.before.join('').includes('/__lab/bar.js'));
  check('최상위 문서: 토큰은 응답 헤더에 없음', ![...res.headers].join(' ').includes('preview-tok'));
  resetRw();
  await seatReq('/x', { headers: { 'sec-fetch-dest': 'iframe', accept: 'text/html' } });
  check('iframe: guard 만 (manifest·막대 없음)', rw.prepend.length === 1 && rw.append.length === 0 && rw.before.length === 0 && !rw.sel.includes('link[rel="manifest"]'));
}

// ── 6. 자리 호스트 화면: manifest 없음, 끝난 초대는 다시 열지 않음 ──
console.log('자리 호스트 화면');
const seatPage = async (res) => { const t = await res.text(); return { t, noMf: !t.includes(MF) && !/rel="manifest"/.test(t), icon: t.includes('<link rel="icon" href="/__lab/icon-192.png">') && t.includes('<meta name="theme-color" content="#0f172a">') }; };
// 다시 열기 주소: 화면 마크업과 무관하게, 인라인 스크립트에 JSON 문자열로 들어간 주소만 본다
const again = (t) => t.includes(JSON.stringify(`${LAB_ORIGIN}/j/`).slice(0, -1)) ? (t.match(/"https:\/\/lab\.example\.test\/j\/[^"]*"/) ?? [])[0] : t.includes(JSON.stringify(`${LAB_ORIGIN}/`)) ? JSON.stringify(`${LAB_ORIGIN}/`) : undefined;
{
  replies = { labRoute: okRoute };
  const res = await seatReq('/__lab/enter', { method: 'POST', cookie: '', headers: { origin: LAB_ORIGIN, 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'navigate', 'content-type': 'application/x-www-form-urlencoded' }, body: `code=${CODE}` });
  const p = await seatPage(res);
  check('입장 화면: 쿠키 굽기 그대로 (Strict·Host-only)', res.status === 200 && /^__Host-lab_seat=abcdEFGH1234_-xy; Path=\/; Max-Age=\d+; HttpOnly; Secure; SameSite=Strict$/.test(res.headers.get('set-cookie') ?? ''));
  check('입장 화면: manifest 없음, 아이콘·테마색 그대로, / 로 이동', p.noMf && p.icon && p.t.includes("location.replace('/')"));
  const g = await seatReq('/__lab/enter', { cookie: '' });
  const gp = await seatPage(g);
  check('GET /__lab/enter: 405, 쿠키 없음, manifest 없음', g.status === 405 && g.headers.get('set-cookie') === null && gp.noMf && calls.length === 0);
}
{
  replies = { labRoute: () => { throw new Error('no'); } };
  const res = await seatReq('/', { cookie: '', headers: DOC });
  const p = await seatPage(res);
  check('쿠키 없음: 401 안내, manifest 없음, 실습실 앱으로', res.status === 401 && p.noMf
    && again(p.t) === JSON.stringify(`${LAB_ORIGIN}/`) && calls.length === 0 && fetched.length === 0);
}
// 성공한 자리는 isolate 캐시(30초)에 남으므로 경우마다 다른 자리 코드
for (const status of [403, 404, 410]) {
  replies = { labRoute: () => ({ error: '수업이 끝났습니다.', status }) };
  const code = `gone-${status}-abcdefg`;
  const res = await seatReq('/', { headers: DOC, cookie: `__Host-lab_seat=${code}` });
  const p = await seatPage(res);
  check(`labRoute ${status}: 같은 상태, 쿠키 지움, 끝난 초대 대신 실습실 앱으로`, res.status === status && /^__Host-lab_seat=; .*Max-Age=0/.test(res.headers.get('set-cookie') ?? '')
    && again(p.t) === JSON.stringify(`${LAB_ORIGIN}/`) && !p.t.includes('/j/') && p.noMf && fetched.length === 0, `${res.status} ${again(p.t)}`);
}
for (const status of [502, 503]) {
  replies = { labRoute: () => ({ error: '잠깐 오류', status }) };
  const code = `busy-${status}-abcdefg`;
  const res = await seatReq('/', { headers: DOC, cookie: `__Host-lab_seat=${code}` });
  const p = await seatPage(res);
  check(`labRoute ${status}: 쿠키 그대로, 그 초대로 다시 열기`, res.status === status && res.headers.get('set-cookie') === null && again(p.t) === JSON.stringify(`${LAB_ORIGIN}/j/${code}`) && p.noMf);
}
{
  replies = { labRoute: () => ({ error: '끝', status: 410 }) };
  const ws = await seatReq('/x', { headers: { upgrade: 'websocket', origin: ME }, cookie: '__Host-lab_seat=gone-ws0-abcdefg' });
  check('WebSocket 끝난 자리: 410 그대로', ws.status === 410 && fetched.length === 0);
  replies = { labRoute: okRoute };
  upstream = { throw: true };
  const down = await seatReq('/', { headers: DOC });
  const dp = await seatPage(down);
  check('upstream 연결 실패: 502, 그 초대로 다시 열기, manifest 없음', down.status === 502 && again(dp.t) === JSON.stringify(`${LAB_ORIGIN}/j/${CODE}`) && dp.noMf && down.headers.get('set-cookie') === null);
  upstream = { make: () => new Response('down', { status: 500, headers: { 'content-type': 'text/html' } }) };
  const off = await seatReq('/', { headers: DOC });
  const op = await seatPage(off);
  check('꺼진 실습실: 503, 그 초대로 다시 열기, manifest 없음', off.status === 503 && again(op.t) === JSON.stringify(`${LAB_ORIGIN}/j/${CODE}`) && op.noMf);
  const x = await seatReq('/', { headers: { ...DOC, 'sec-fetch-site': 'cross-site' } });
  const xp = await seatPage(x);
  check('다른 사이트 안내: manifest 없음', x.status === 403 && xp.noMf);
}

// ── 7. 막대·경계 스크립트 ──
console.log('막대');
check('막대: 설치 제안 코드 없음', !/beforeinstallprompt|__labInstall|labinstall|appinstalled|\.prompt\(|앱으로 설치/.test(B.LAB_BAR_JS));
check('경계: 설치 제안 코드 없음', !/beforeinstallprompt|__labInstall|labinstall/.test(B.LAB_GUARD_JS));
check('경계: 클립보드·입력 추적 그대로', ['C.writeText', 'C.readText', 'C.write ', 'C.read ', "addEventListener('paste'", "addEventListener('copy'", "addEventListener('cut'", "addEventListener('drop'", 'S.touch(t)', 'MutationObserver']
  .every((s) => B.LAB_GUARD_JS.includes(s)));
check('막대: 다른 창·외부 주소·토큰 없음', !/window\.open|target\s*=|_blank|https?:\/\/|token|code=/.test(B.LAB_BAR_JS));
{
  // 가짜 DOM 위에서 막대를 돌리고 "다른 실습실" 을 누른다
  const made = [], fetches = [], winEv = [];
  const node = (tag) => {
    const n = { tag, style: {}, children: [], title: '', disabled: false, onclick: null, _t: '',
      get textContent() { return this._t; }, set textContent(v) { this._t = String(v); },
      append(...x) { this.children.push(...x); }, insertBefore(x) { this.children.push(x); }, click() {}, remove() {},
      setAttribute(k,v) { (this.attrs ??= {})[k]=String(v); }, getAttribute(k) { return this.attrs?.[k] ?? null; },
      addEventListener() {}, focus() {} };
    made.push(n); return n;
  };
  const location = { href: `${ME}/?folder=/home/x` };
  const store = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)) }; };
  const win = {
    addEventListener: (ty) => winEv.push(ty), open: () => { throw new Error('window.open'); },
  };
  const ctx = {
    window: win, location, localStorage: store(), sessionStorage: store(), Date, Math, JSON, String, Promise, Error,
    document: { createElement: node, body: { append() {} }, addEventListener() {}, visibilityState: 'visible', hasFocus: () => true },
    fetch: async (u, init) => { fetches.push([u, init?.body]); return { ok: false, json: async () => ({}) }; },
    setTimeout: () => 0, setInterval: () => 0, matchMedia: () => { throw new Error('matchMedia'); },
  };
  vm.createContext(ctx);
  vm.runInContext(B.LAB_BAR_JS, ctx);
  const btn = made.find((n) => n.tag === 'button' && n.textContent.includes('다른 실습실'));
  check('막대: "다른 실습실" 버튼이 보인다', !!btn && btn.style.display !== 'none' && /실습실 앱/.test(btn.title));
  const before = fetches.length;
  btn?.onclick?.({});
  check('누르면 같은 창에서 같은 출처 /__lab/home 으로만', location.href === '/__lab/home' && fetches.length === before);
  check('막대가 보낸 요청에 코드·토큰 없음', fetches.every(([u, b]) => u === '/__lab/me' && !String(b).includes(CODE)), JSON.stringify(fetches));
  check('막대: 설치 이벤트를 듣지 않음', !winEv.includes('beforeinstallprompt') && !winEv.includes('appinstalled') && !winEv.includes('labinstall'), JSON.stringify(winEv));
}

console.log(`\n${pass} passed, ${failN} failed`);
process.exit(failN ? 1 : 0);
