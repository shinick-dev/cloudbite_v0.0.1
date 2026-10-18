// 공부방 참가자 호스트 — 입장 호스트(LAB_ORIGIN, lab.shinick.dev)와 자리 호스트(s-<label>.<LAB_SEAT_DOMAIN>) 두 가지.
//
// 입장 호스트 (화면만, 권한 쿠키 없음):
//   GET  /                     안내 (초대 링크로 들어오라고)
//   GET  /c/<CODE>             예전 수업 링크 — 아무 권한도 주지 않는 안내 (#14)
//   GET  /j/<seat>             자리 초대: 수업·자리 번호를 보여 주고 "입장" 을 눌러야 깨우기 → 자리 호스트로 POST (#19)
//   GET  /__lab/enter/<seat>   예전 입장 주소 → /j/<seat> 로 (쿠키 안 굽는다)
//   GET  /__lab/leave          예전 쿠키(lab_seat) 지우기
//   GET  /__lab/home           실습실 앱(입장 호스트 /)으로 — 고정 주소, 쿼리·코드 안 받음
//   POST /__lab/wake           깨우기 (JSON, 1KiB, Origin = 입장 호스트) · POST /__lab/claim → 410
//   예전 lab_seat 쿠키가 오면 권한으로 쓰지 않고 지운다
//
// 자리 호스트 (자리마다 다른 출처 — 다른 자리의 쿠키·화면에 닿지 않게, #18):
//   POST /__lab/enter          입장 호스트의 폼 POST (Origin = 입장 호스트, same-site, 1KiB). 자리 코드의 label 이 이 호스트와 같을 때만
//                              __Host-lab_seat 쿠키를 굽는다 (Strict, Domain 없음)
//   GET  /__lab/bar.js·snips.js·screen.js·rtc.js·guard.js·classroom.js·app.js, /__lab/me, /__lab/classroom/status, /__lab/snips?v=, /__lab/screen, /__lab/export/<표>, /__lab/leave
//   POST /__lab/me, /__lab/hand, /__lab/export, /__lab/screen/pull, /__lab/screen/answer   (JSON, Origin = 이 자리 호스트, 1KiB · answer 128KiB)
//   POST /__lab/classroom/progress {step,completed} · /__lab/classroom/submit {requestId,filename:'결과.txt'}
//        (JSON, Origin = 이 자리 호스트, 1KiB). 본문의 code·n 은 받지 않는다. 자리는 쿠키로만.
//   GET  /__lab/manifest.webmanifest, /__lab/icon-<192|512>.png   예전에 자리 주소로 설치한 앱용 (새 설치는 입장 호스트에서 — 화면은 manifest 를 안 알린다)
//   GET  /__lab/home           실습실 앱(입장 호스트 /)으로 — 출처 검사 뒤, 자리 확인·쿠키 없이 (자리 쿠키는 그대로 둔다)
//   그 밖 전부                 쿠키의 자리(이 호스트의 label 과 같아야) → 그 샌드박스 code-server 로 대신 연결 (WebSocket 포함)
//   권한은 쿠키의 자리 코드 + label 일치. 호스트 이름(label)만으로는 아무것도 못 한다.
//   Sec-Fetch-Site 가 same-origin·none 이 아니면 upstream 에 안 간다: same-site 최상위 문서 이동(GET/HEAD)은 확인 화면, 그 밖(다른 사이트 포함)은 403.
//   Origin 이 있으면 이 호스트와 정확히 같아야 (WebSocket 은 필수)
//   시연실 예외만: GET/HEAD · navigate · dest iframe · 경로 '/' · Site same-site|same-origin · Origin 없음 또는 env.ORIGIN.
//   권한은 __Host-lab_seat 와 캐시를 우회한 labRoute 의 demoParent. ?__demo_embed=1 만으로는 열리지 않는다. 자산·API·WebSocket·POST 는 예외가 아니다.
//
// Daytona 서명 주소를 직접 주면 처음에 경고 화면이 뜨고 주소도 길다. 게이트웨이가 미리보기 토큰과
// X-Daytona-Skip-Preview-Warning 을 붙여 대신 열면 둘 다 없어진다 (Daytona 문서의 custom preview proxy).
// 이 호스트들은 k.shinick.dev 와 출처가 달라서, 샌드박스 안 코드가 금고·관리 화면에 닿지 않는다.

import { LAB_BAR_JS, LAB_GUARD_JS } from './labbar';
import { LAB_CLASSROOM_SEAT_JS } from './lab-classroom-seat';
import { LAB_CLASSROOM_MATERIALS_JS } from './lab-classroom-materials-ui';
import { LAB_PERF_JS } from './labperf';
import { LAB_RTC_JS } from './labrtc';
import { LAB_SCREEN_JS } from './labscreen';
import { LAB_SNIPS_JS } from './labsnips';
import { LAB_HELP_JS } from './labhelp';
import { LAB_LIVE_SEAT_JS } from './lablive';
import { LAB_DOM_CAPTURE_JS, LAB_DOM_CAPTURE_PRELUDE_JS } from './lab-dom-capture.generated';
import { labDemoEmbedBridgeJS } from './lab-demo-embed-bridge';
import { ICON_192, ICON_512 } from './labicons';
import { labConfirmPage, labEndedPage, labEnterPage, labJoinPage, labLandingPage, WEBAUTHN_JS } from './pages';
import { isFail, SEAT_LABEL, type Env } from './state';
import { takeLabTiming, upstreamTiming } from './lab-timing';

type Stub = DurableObjectStub<import('./state').State>;
const CLASSROOM_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CLASSROOM_FILE = '결과.txt';
function sameKeys(b: Record<string, unknown>, keys: readonly string[]) {
  const got = Object.keys(b);
  return got.length === keys.length && keys.every((k) => got.includes(k));
}

const COOKIE = '__Host-lab_seat';
const OLD_COOKIE = 'lab_seat'; // 예전 lab.shinick.dev 쿠키 — 권한 아님, 보이면 지운다
const CODE = /^[\w-]{16}$/;
const BODY_MAX = 1024;
const SDP_BODY_MAX = 128 * 1024;
const CSP = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const PAGE_HEADERS = {
  'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY',
  'content-security-policy': CSP,
};
// upstream 으로 넘기지 않는 헤더 (Cloudflare 가 붙이는 것, 방문자 IP)
const STRIP = ['host', 'cf-connecting-ip', 'cf-ipcountry', 'cf-ray', 'cf-visitor', 'cdn-loop', 'x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host', 'x-real-ip', 'true-client-ip'];

type Route = { origin: string; token: string; expiresAt: number; seat: number; clip: { in: boolean; out: boolean }; label: string; demoParent?: string };

// PWA. 새 설치는 입장 호스트(LAB_ORIGIN)에서만 — 자리 주소는 수업이 끝나면 사라진다.
// 자리 호스트의 manifest 는 예전에 그 주소로 설치한 앱을 위해 같은 id·start_url·scope 로 남겨 둔다 (다른 출처로 옮기기는 안 한다)
const MANIFEST = JSON.stringify({
  id: '/', name: 'AI 실습실', short_name: 'AI 실습실', lang: 'ko', start_url: '/', scope: '/', display: 'standalone',
  background_color: '#0f172a', theme_color: '#0f172a', description: '공부방 AI 실습실 — 브라우저 VS Code + Claude Code·OpenCode',
  icons: [192, 512].flatMap((n) => ['any', 'maskable'].map((purpose) => ({ src: `/__lab/icon-${n}.png`, sizes: `${n}x${n}`, type: 'image/png', purpose }))),
});
const png = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const ICONS: Record<string, Uint8Array> = { '/__lab/icon-192.png': png(ICON_192), '/__lab/icon-512.png': png(ICON_512) };
const routes = new Map<string, Route & { until: number }>(); // isolate 메모리 캐시 (label|code) — 자산 요청마다 DO 를 부르지 않게

const html = (body: string, status = 200, extra: Record<string, string> = {}) =>
  new Response(body, { status, headers: { ...PAGE_HEADERS, 'content-type': 'text/html; charset=utf-8', ...extra } });
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...PAGE_HEADERS, 'content-type': 'application/json' } });
const script = (body: string, cache = 'max-age=300') =>
  new Response(body, { headers: { ...PAGE_HEADERS, 'content-type': 'text/javascript; charset=utf-8', 'cache-control': cache } });

// 자리 호스트 화면: manifest 를 알리지 않는다 (새 설치가 사라질 자리 주소에 묶이지 않게). 아이콘·테마색은 그대로.
// 화면 쪽에서도 빼지만, 혹시 남아 있으면 여기서 한 번 더 뗀다
const MANIFEST_LINK = '<link rel="manifest" href="/__lab/manifest.webmanifest">';
const seatHtml = (body: string, status = 200, extra: Record<string, string> = {}) => html(body.replace(MANIFEST_LINK, ''), status, extra);
/** 실습실 앱으로: 늘 같은 입장 호스트 / (쿼리·경로·코드를 넘기지 않는다). 쿠키·DO 없음 */
const home = (env: Env) => new Response(null, { status: 302, headers: { location: `${env.LAB_ORIGIN}/`, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' } });

const outJ = (r: unknown) => (isFail(r) ? json({ error: r.error }, r.status) : json(r));

function cookies(req: Request) {
  const out = new Map<string, string>();
  for (const part of (req.headers.get('cookie') ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  return out;
}
const seatCookie = (code: string, maxAge: number) => `${COOKIE}=${code}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;
const oldCookieClear = `${OLD_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;

/** 자리 호스트의 출처 (입장 호스트와 같은 scheme) */
export function seatOrigin(env: Env, label: string) {
  return `${new URL(env.LAB_ORIGIN).protocol}//s-${label}.${env.LAB_SEAT_DOMAIN}`;
}

/** 자리 도메인 아래 호스트면 label (형식이 틀리면 ''), 아니면 null. 입장·금고 호스트는 null */
export function seatHostLabel(env: Env, url: URL): string | null {
  const d = env.LAB_SEAT_DOMAIN;
  if (!d) return null;
  const host = url.host;
  if (host === new URL(env.LAB_ORIGIN).host || host === new URL(env.ORIGIN).host) return null;
  if (!host.endsWith(`.${d}`)) return null;
  const m = /^s-([a-z2-7]{26})$/.exec(host.slice(0, -d.length - 1));
  return m && SEAT_LABEL.test(m[1]) ? m[1] : '';
}

/** 본문을 max 바이트까지만 읽는다 (Content-Length 먼저, 그다음 실제로 센다 — chunked 도). 넘으면 null */
async function readCapped(req: Request, max: number): Promise<string | null> {
  const cl = req.headers.get('content-length');
  if (cl !== null && !(Number(cl) <= max)) return null;
  if (!req.body) return '';
  const reader = req.body.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) { reader.cancel().catch(() => {}); return null; }
    parts.push(value);
  }
  const all = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { all.set(p, o); o += p.byteLength; }
  return new TextDecoder().decode(all);
}
const mediaType = (req: Request) => (req.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();

/** /__lab POST 본문: 정한 형식·출처만, 크기는 버퍼에 담기 전에 자른다 */
async function postBody(req: Request, origin: string, max: number, type = 'application/json'): Promise<Response | string> {
  if (req.headers.get('origin') !== origin) return json({ error: 'bad origin' }, 403);
  if (mediaType(req) !== type) return json({ error: `content-type 은 ${type} 이어야 합니다.` }, 415);
  const t = await readCapped(req, max);
  return t === null ? json({ error: '요청 본문이 너무 큽니다.' }, 413) : t;
}
function parseJson(t: string): Record<string, unknown> | null {
  if (!t) return {};
  try { const v = JSON.parse(t); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch { return null; }
}

// ── 입장 호스트 ──

export async function labHost(req: Request, env: Env, state: Stub, url: URL): Promise<Response> {
  const r = await entry(req, env, state, url);
  if (!cookies(req).has(OLD_COOKIE)) return r;
  // 예전 쿠키는 권한이 아니다 — 보이면 지운다 (자리 바꿔치기·조용한 재배정 없음)
  const out = new Response(r.body, r);
  out.headers.append('set-cookie', oldCookieClear);
  return out;
}

function entry(req: Request, env: Env, state: Stub, url: URL): Promise<Response> {
  if (req.method === 'GET' || req.method === 'HEAD') return entryGet(env, state, url.pathname);
  return entryPost(req, env, state, url.pathname);
}

/** 입장 호스트 GET/HEAD 중 DO 를 부르지 않는 것. 해당 없으면 null */
function entryStatic(path: string, origin: string): Response | null {
  let g: RegExpMatchArray | null;
  if (path === '/') return html(labLandingPage(origin+'/lab/request'));
  if (path === '/__lab/app.js') return script(WEBAUTHN_JS, 'no-store');
  if (path === '/__lab/manifest.webmanifest') return manifest();
  if (ICONS[path]) return icon(path);
  if (/^\/c\/([A-Za-z2-9]{6})\/?$/.test(path)) return html(labEndedPage('수업 코드로는 더 이상 자리를 받을 수 없습니다. 강사에게 내 자리 초대 링크(QR)를 받으세요.'), 410);
  if ((g = path.match(/^\/__lab\/enter\/([\w-]{16})$/))) return new Response(null, { status: 302, headers: { location: `/j/${g[1]}`, 'cache-control': 'no-store' } });
  if (path === '/__lab/leave') return new Response(null, { status: 302, headers: { location: '/', 'cache-control': 'no-store' } });
  return null;
}

async function entryGet(env: Env, state: Stub, path: string): Promise<Response> {
  if (path === '/__lab/home') return home(env);
  const fixed = entryStatic(path,env.ORIGIN);
  if (fixed) return fixed;
  const g = path.match(/^\/j\/([\w-]{16})\/?$/);
  if (!g) return html(labLandingPage(env.ORIGIN+'/lab/request'), 404);
  if (!env.LAB_SEAT_DOMAIN) return html(labEndedPage('실습실 입장이 아직 열리지 않았습니다 (자리 호스트 설정 전). 강사에게 알려 주세요.'), 503);
  const info = await state.labSeatInfo(g[1]);
  if (isFail(info)) return html(labEndedPage(info.error), info.status);
  const to = seatOrigin(env, info.label);
  // 이 화면은 쿠키를 굽지 않는다. 입장을 누르면 그 자리 호스트로만 폼을 보낼 수 있다.
  // Referrer-Policy 는 이 화면만 strict-origin: no-referrer 면 브라우저가 다른 출처 폼 POST 에 Origin: null 을 보내 /__lab/enter 가 거절한다 (주소 경로·자리 코드는 안 보냄)
  return html(labJoinPage({ code: g[1], seatOrigin: to, name: info.name, seat: info.seat, who: info.who, expiresAt: info.expiresAt, model: info.model }), 200,
    { 'content-security-policy': CSP.replace("form-action 'none'", `form-action ${to}`), 'referrer-policy': 'strict-origin' });
}

/** 입장 호스트 POST: 정한 경로만, 출처·형식·크기 검사 뒤에 DO */
async function entryPost(req: Request, env: Env, state: Stub, path: string): Promise<Response> {
  if (req.method !== 'POST' || !path.startsWith('/__lab/')) return json({ error: 'not found' }, 404);
  if (path !== '/__lab/wake' && path !== '/__lab/claim') return json({ error: 'not found' }, 404);
  const t = await postBody(req, env.LAB_ORIGIN, BODY_MAX);
  if (t instanceof Response) return t;
  const b = parseJson(t);
  if (!b) return json({ error: '형식이 올바르지 않습니다.' }, 400);
  if (path === '/__lab/claim') return outJ(await state.labClaim()); // 수업 코드로 자리 받기는 끝났다 (410)
  if (!env.LAB_SEAT_DOMAIN) return json({ error: '실습실 입장이 아직 열리지 않았습니다.' }, 503);
  const code = typeof b.code === 'string' ? b.code : '';
  if (!CODE.test(code)) return json({ error: '자리 코드 형식이 올바르지 않습니다.' }, 400);
  const r = await state.labJoin(code, typeof b.name === 'string' ? b.name : '');
  if (isFail(r)) return outJ(r);
  // 걸린 시간은 공개 JSON 이 아니라 Server-Timing 헤더로만 (정한 이름·숫자만)
  const { body, header } = takeLabTiming(r);
  const res = json(body);
  if (header) res.headers.set('server-timing', header);
  return res;
}

const manifest = () => new Response(MANIFEST, { headers: { 'content-type': 'application/manifest+json', 'cache-control': 'max-age=3600', 'x-content-type-options': 'nosniff' } });
const icon = (path: string) => new Response(ICONS[path], { headers: { 'content-type': 'image/png', 'cache-control': 'max-age=86400', 'x-content-type-options': 'nosniff' } });

// ── 자리 호스트 ──

export async function labSeatHost(req: Request, env: Env, state: Stub, url: URL, label: string): Promise<Response> {
  const me = seatOrigin(env, label);
  const path = url.pathname;
  const method = req.method;

  if (path === '/__lab/enter') return enter(req, env, state, label, me);

  const code = cookies(req).get(COOKIE) ?? '';
  // 루트 iframe 만 캐시 없이 다시 확인한다. 실패하면 upstream 으로 넘어가지 않는다 (오래 된 routes 항목으로 열지 않음).
  if (demoEmbedShape(req, env, url)) {
    const embed = await freshDemoRoute(state, code, label);
    if (!embed) return json({ error: 'cross-site request blocked' }, 403);
    return proxy(req, url, embed, code, env, true);
  }

  const blocked = seatGuard(req, env, url, me);
  if (blocked) return blocked;

  const seat: SeatLookup = async () => (CODE.test(code) ? await route(state, code, label) : null);

  if (method === 'GET' || method === 'HEAD') {
    const got = await seatGet(env, state, url, code, label, seat);
    if (got) return got;
  }

  if (path.startsWith('/__lab/')) return await seatPost(req, state, path, me, code, seat);

  return await seatFallback(req, env, url, code, seat);
}

type SeatLookup = () => Promise<Awaited<ReturnType<typeof route>> | null>;
const noSeat = () => json({ error: 'no seat' }, 401);
const isWebSocket = (req: Request) => (req.headers.get('upgrade') ?? '').toLowerCase() === 'websocket';

/** 인증된 시연실 루트만 자리 가드의 same-site iframe 거부를 넘긴다. 쿼리 플래그는 권한이 아니다. */
function demoEmbedShape(req: Request, env: Env, url: URL): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  if (url.pathname !== '/') return false;
  if ((req.headers.get('upgrade') ?? '').toLowerCase() === 'websocket') return false;
  if (req.headers.get('sec-fetch-mode') !== 'navigate' || req.headers.get('sec-fetch-dest') !== 'iframe') return false;
  const site = req.headers.get('sec-fetch-site');
  if (site !== 'same-site' && site !== 'same-origin') return false;
  const origin = req.headers.get('origin');
  return origin === null || origin === env.ORIGIN;
}

async function freshDemoRoute(state: Stub, code: string, label: string): Promise<Route | null> {
  if (!CODE.test(code)) return null;
  const got = await state.labRoute(code);
  if (isFail(got) || got.label !== label || !got.demoParent) return null;
  return got;
}

/** 자리 호스트 출처 검사 (쿠키·DO·upstream 보다 먼저). 통과면 null */
function seatGuard(req: Request, env: Env, url: URL, me: string): Response | null {
  const method = req.method;
  const origin = req.headers.get('origin');
  const site = req.headers.get('sec-fetch-site');
  // 이 출처(same-origin)·직접 연 것(none)만 upstream·자리 API 로. 다른 자리·입장 호스트(same-site)에서 온 최상위 문서 이동(GET/HEAD)은
  // upstream 에 닿기 전에 확인 화면 → "계속" 을 누르면 이 출처의 이동으로 다시 온다. 다른 사이트·iframe·자산·API·WebSocket·POST 는 막는다
  if (site !== null && site !== 'same-origin' && site !== 'none') {
    const nav = (method === 'GET' || method === 'HEAD') && req.headers.get('sec-fetch-mode') === 'navigate' && req.headers.get('sec-fetch-dest') === 'document';
    if (nav && site === 'same-site') return seatHtml(labConfirmPage(me + url.pathname + url.search));
    if (nav) return seatHtml(labEndedPage('다른 사이트의 링크로는 실습실에 들어갈 수 없습니다. 내 초대 링크로 들어오세요.', `${env.LAB_ORIGIN}/`), 403);
    return json({ error: 'cross-site request blocked' }, 403);
  }
  const ws = isWebSocket(req);
  if (origin !== null ? origin !== me : ws) return ws ? new Response(null, { status: 403 }) : json({ error: 'bad origin' }, 403);
  return null;
}

/** 자리 호스트 GET/HEAD: 자산·자리 API. /__lab/ 밖이면 null (code-server 로) */
async function seatGet(env: Env, state: Stub, url: URL, code: string, label: string, seat: SeatLookup): Promise<Response | null> {
  const path = url.pathname;
  if (path === '/__lab/demo-bridge.js') return demoBridge(env, state, code, label);
  const fixed = seatStatic(env, path); // 자리 확인 없이 (정적 자산·쿠키 지우기)
  if (fixed) return fixed;
  if (path === '/__lab/guard.js') {
    // 캐시 없이 매번 지금 규칙으로 (강사가 바꾸면 새로고침·새 창부터 바로, 열린 화면은 막대가 30초마다 가져간다)
    const r = await seat();
    const clip = r && !isFail(r) ? r.clip : { in: true, out: true };
    return script(`window.__labClipPolicy=${JSON.stringify(clip)};\n${LAB_GUARD_JS}`, 'no-store');
  }
  if (path.startsWith('/__lab/')) return seatApi(state, url, code, seat);
  return null;
}

function seatStatic(env: Env, path: string): Response | null {
  if (path === '/__lab/app.js') return script(WEBAUTHN_JS, 'no-store');
  if (path === '/__lab/bar.js') return script(LAB_BAR_JS);
  if (path === '/__lab/snips.js') return script(LAB_SNIPS_JS);
  if (path === '/__lab/help.js') return script(LAB_HELP_JS, 'no-store');
  if (path === '/__lab/live.js') return script(LAB_LIVE_SEAT_JS, 'no-store');
  if (path === '/__lab/dom-capture.js') return script(LAB_DOM_CAPTURE_JS, 'no-store');
  if (path === '/__lab/dom-capture-prelude.js') return script(LAB_DOM_CAPTURE_PRELUDE_JS, 'no-store');
  if (path === '/__lab/screen.js') return script(LAB_SCREEN_JS);
  if (path === '/__lab/rtc.js') return script(LAB_RTC_JS);
  if (path === '/__lab/perf.js') return script(LAB_PERF_JS);
  if (path === '/__lab/classroom.js') return script(LAB_CLASSROOM_SEAT_JS + '\n' + LAB_CLASSROOM_MATERIALS_JS, 'no-store');
  if (path === '/__lab/manifest.webmanifest') return manifest();
  if (ICONS[path]) return icon(path);
  if (path === '/__lab/home') return home(env); // leave 와 달리 자리 쿠키를 지우지 않는다
  if (path === '/__lab/leave') return new Response(null, { status: 302, headers: { location: `${env.LAB_ORIGIN}/`, 'set-cookie': seatCookie('', 0), 'cache-control': 'no-store' } });
  return null;
}

/** 시연 다리: 매 요청마다 labRoute. 30초 캐시·참가자·틀린 쿠키로는 스크립트를 주지 않는다. */
async function demoBridge(env: Env, state: Stub, code: string, label: string): Promise<Response> {
  if (!CODE.test(code)) return noSeat();
  const got = await state.labRoute(code);
  if (isFail(got)) return outJ(got);
  if (got.label !== label || !got.demoParent) return json({ error: 'no seat' }, 403);
  return script(labDemoEmbedBridgeJS(env.ORIGIN), 'no-store');
}

/** 자리 API GET: 자리 확인이 먼저 — 모르는 /__lab/ 경로도 자리 확인 뒤에 404 */
async function seatApi(state: Stub, url: URL, code: string, seat: SeatLookup): Promise<Response> {
  const path = url.pathname;
  const r = await seat();
  if (!r) return noSeat();
  if (isFail(r)) return outJ(r);
  if (path === '/__lab/screen') return outJ(await state.labScreenState(code)); // 강사 화면 공유 중인지 (가벼움, 저장 안 함)
  if (path === '/__lab/me') return outJ(await state.labMe(code));
  if (path === '/__lab/files') return outJ(await state.labFileReceipt(code));
  if (path === '/__lab/checkpoints') return outJ(await state.labCheckpointFor(code));
  if (path === '/__lab/help') return outJ(await state.labHelpFor(code));
  if (path === '/__lab/classroom/status') return outJ(await state.labClassroomSeatStatus(code));
  if (path === '/__lab/snips') {
    // 받은 코드: 막대가 10초마다. 버전이 같으면 204 (본문 없음)
    const s = await state.labSnipsFor(code, url.searchParams.get('v') ?? '');
    if (isFail(s)) return outJ(s);
    return 'same' in s ? new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } }) : json(s);
  }
  const g = path.match(/^\/__lab\/export\/([\w-]{24})$/);
  if (g) return exportResponse(await state.labExportDownload(code, g[1]));
  return json({ error: 'not found' }, 404);
}

/** 자리 호스트 /__lab/ 의 GET/HEAD 밖 요청: 정한 POST 만, 본문 검사 뒤에 자리 확인 */
async function seatPost(req: Request, state: Stub, path: string, me: string, code: string, seat: SeatLookup): Promise<Response> {
  if (req.method !== 'POST') return json({ error: 'not found' }, 404);
  const known = ['/__lab/me', '/__lab/hand', '/__lab/export', '/__lab/files/ack', '/__lab/help', '/__lab/help/resolve', '/__lab/screen/pull', '/__lab/screen/answer', '/__lab/live/start', '/__lab/live/stop', '/__lab/live/state', '/__lab/live/consent', '/__lab/classroom/progress', '/__lab/classroom/submit'];
  if (!known.includes(path)) return json({ error: 'not found' }, 404);
  const t = await postBody(req, me, path === '/__lab/screen/answer' || path === '/__lab/live/start' ? SDP_BODY_MAX : path.startsWith('/__lab/help') ? 9000 : BODY_MAX);
  if (t instanceof Response) return t;
  const b = parseJson(t);
  if (!b) return json({ error: '형식이 올바르지 않습니다.' }, 400);
  const r = await seat();
  if (!r) return noSeat();
  if (isFail(r)) return outJ(r);
  if (path === '/__lab/live/start') return outJ(await state.labLiveStart(code, b.tab, b.sdp, b.tracks));
  if (path === '/__lab/live/stop') return outJ(await state.labLiveStop(code, b.tab));
  if (path === '/__lab/live/state') return outJ(await state.labLiveSeat(code, b.tab, b.ack, b.viewport, b.ackRequest));
  if (path === '/__lab/live/consent') return outJ(await state.labLiveConsent(code, b.tab, b.requestId, b.allow));
  if (path === '/__lab/hand') return outJ(await state.labHand(code, b.up === true));
  if (path === '/__lab/help') {
    if(Object.keys(b).some(k=>!['requestId','question'].includes(k)))return json({error:'알 수 없는 질문 항목입니다.'},400);
    return outJ(await state.labHelpAsk(code,b));
  }
  if (path === '/__lab/help/resolve') {
    if(Object.keys(b).some(k=>!['requestId','questionId'].includes(k)))return json({error:'알 수 없는 확인 항목입니다.'},400);
    return outJ(await state.labHelpResolve(code,b));
  }
  if (path === '/__lab/classroom/progress') {
    if (!sameKeys(b, ['step', 'completed'])) return json({ error: '알 수 없는 진행 항목입니다.' }, 400);
    if (typeof b.step !== 'number' || !Number.isInteger(b.step) || b.step < 0 || b.step > 11) return json({ error: '진행 단계가 올바르지 않습니다.' }, 400);
    if (typeof b.completed !== 'boolean') return json({ error: '완료 표시가 올바르지 않습니다.' }, 400);
    return outJ(await state.labClassroomProgress(code, b.step, b.completed));
  }
  if (path === '/__lab/classroom/submit') {
    if (!sameKeys(b, ['requestId', 'filename'])) return json({ error: '알 수 없는 제출 항목입니다.' }, 400);
    if (typeof b.requestId !== 'string' || !CLASSROOM_UUID.test(b.requestId)) return json({ error: '제출 요청이 올바르지 않습니다.' }, 400);
    if (b.filename !== CLASSROOM_FILE) return json({ error: '제출 파일은 결과.txt 만 가능합니다.' }, 400);
    return outJ(await state.labClassroomSubmit(code, b.requestId, b.filename));
  }
  // 막대의 30초 신호 + 참가자 상태 (마지막 입력 후 경과 초·탭 보임·탭 id·강사 보기 탭). 자리는 쿠키로만 — 본문의 자리 값은 안 본다
  if (path === '/__lab/me') return outJ(await state.labMe(code, b));
  if (path === '/__lab/export') return outJ(await state.labExportStart(code, b.checkpointId));
  if (path === '/__lab/files/ack') return outJ(await state.labFileAcknowledge(code, b.receiptId));
  // 강사 화면 받기: 받기 세션 만들기(→ SFU offer) · answer. sid 는 서버가 이 자리 쿠키와 대조한다
  if (path === '/__lab/screen/pull') return outJ(await state.labScreenPull(code));
  return outJ(await state.labScreenAnswer(code, b.sid, b.sdp));
}

/** 자리 호스트 나머지: 쿠키의 자리가 맞으면 code-server 로 */
async function seatFallback(req: Request, env: Env, url: URL, code: string, seat: SeatLookup): Promise<Response> {
  const method = req.method;
  const ws = isWebSocket(req);
  const r = await seat();
  const doc = req.headers.get('sec-fetch-dest') === 'document' || (method === 'GET' && (req.headers.get('accept') ?? '').includes('text/html'));
  if (!r) {
    if (ws) return new Response(null, { status: 401 });
    return doc ? seatHtml(labEndedPage('이 자리에 들어가려면 강사에게 받은 초대 링크로 다시 들어오세요.', `${env.LAB_ORIGIN}/`), 401) : noSeat();
  }
  if (isFail(r)) {
    if (ws) return new Response(null, { status: 410 });
    // 끝났거나 다른 자리 쿠키면 지우고 실습실 앱(입장 호스트 /)으로 — 끝난 초대를 다시 열게 하지 않는다 (잠깐의 Daytona 오류면 그대로 두고 그 초대로 다시 열기)
    const gone = r.status === 403 || r.status === 404 || r.status === 410;
    return seatHtml(labEndedPage(r.error, gone ? `${env.LAB_ORIGIN}/` : `${env.LAB_ORIGIN}/j/${code}`), r.status, gone ? { 'set-cookie': seatCookie('', 0) } : {});
  }
  return proxy(req, url, r, code, env);
}

/** 내 작업 받기: DO 가 알린 묶은 크기로 길이를 고정한다 (Content-Length). DO 가 상한·불일치로 스트림을 끊으면
 *  그 길이를 못 채워 연결이 끊긴 채 끝난다 — 잘린 zip 이 완료된 받기로 보이지 않게 */
function exportResponse(r: Response) {
  const size = Number(r.headers.get('x-export-size'));
  if (r.status !== 200 || !r.body || !r.headers.has('x-export-size') || !Number.isSafeInteger(size) || size < 0) return r;
  const h = new Headers(r.headers);
  h.delete('x-export-size');
  const fl = new FixedLengthStream(size);
  r.body.pipeTo(fl.writable).catch(() => {});
  return new Response(fl.readable, { status: 200, headers: h });
}

/** 쿠키의 자리 → code-server 주소. 자리의 label 이 이 호스트와 같아야 한다 (다른 자리 쿠키를 들고 와도 못 쓴다) */
async function route(state: Stub, code: string, label: string): Promise<Route | { error: string; status: number }> {
  const key = `${label}|${code}`;
  const hit = routes.get(key);
  if (hit && hit.until > Date.now() && hit.expiresAt > Date.now()) return hit;
  routes.delete(key);
  const got = await state.labRoute(code);
  if (isFail(got)) return got;
  if (got.label !== label) return { error: '이 주소는 다른 자리의 실습실입니다. 내 초대 링크로 들어오세요.', status: 403 };
  routes.set(key, { ...got, until: Date.now() + 30e3 });
  return got;
}

/** 입장 호스트의 "입장" 폼 → 이 자리 호스트 쿠키. GET 으로는 절대 굽지 않는다 */
async function enter(req: Request, env: Env, state: Stub, label: string, me: string) {
  if (req.method !== 'POST') return seatHtml(labEndedPage('초대 링크에서 "입장" 을 눌러 들어오세요.', `${env.LAB_ORIGIN}/`), 405, { allow: 'POST' });
  const site = req.headers.get('sec-fetch-site'), mode = req.headers.get('sec-fetch-mode');
  if ((site !== null && site !== 'same-site') || (mode !== null && mode !== 'navigate')) return json({ error: 'cross-site request blocked' }, 403);
  const t = await postBody(req, env.LAB_ORIGIN, BODY_MAX, 'application/x-www-form-urlencoded');
  if (t instanceof Response) return t;
  const f = new URLSearchParams(t);
  const code = f.get('code') ?? '';
  if (!CODE.test(code)) return json({ error: '자리 코드 형식이 올바르지 않습니다.' }, 400);
  const r = await state.labRoute(code);
  if (isFail(r)) return seatHtml(labEndedPage(r.error, `${env.LAB_ORIGIN}/`), r.status);
  if (r.label !== label) return seatHtml(labEndedPage('이 초대는 다른 자리 주소용입니다. 초대 링크를 다시 여세요.', `${env.LAB_ORIGIN}/j/${code}`), 403);
  const maxAge = Math.max(60, Math.floor((r.expiresAt - Date.now()) / 1000));
  return seatHtml(labEnterPage(f.get('watch') === '1'), 200, { 'set-cookie': seatCookie(code, maxAge) });
}

async function proxy(req: Request, url: URL, r: Route, code: string, env: Env, embed = false) {
  const headers = upstreamHeaders(req, r);
  // A cached top-level response can carry SAMEORIGIN / frame-ancestors 'self'.
  // A 304 also skips HTML injection, so the private embed must fetch a full document.
  if (embed) {
    for (const name of ['if-none-match', 'if-modified-since', 'if-range']) headers.delete(name);
    headers.set('cache-control', 'no-cache');
  }
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  let up: Response;
  const at = Date.now();
  try {
    up = await fetch(r.origin + url.pathname + url.search, { method: req.method, headers, body: hasBody ? req.body : undefined, redirect: 'manual' });
  } catch (e) {
    return seatHtml(labEndedPage('실습실에 연결하지 못했습니다. 잠시 뒤 새로고침하세요.', `${env.LAB_ORIGIN}/j/${code}`), 502);
  }
  if (up.status === 101) return up; // WebSocket 은 그대로 이어 준다

  // 꺼진 실습실: 페이지를 열 때만 안내 화면 (자산·API 요청은 그대로 돌려준다)
  const nav = req.headers.get('sec-fetch-mode') === 'navigate' || (req.method === 'GET' && (req.headers.get('accept') ?? '').includes('text/html'));
  if (nav && up.status >= 500) {
    routes.delete(`${r.label}|${code}`);
    return seatHtml(labEndedPage('실습실이 꺼져 있거나 켜지는 중입니다.', `${env.LAB_ORIGIN}/j/${code}`), 503);
  }

  const rh = downstreamHeaders(up, r);
  if (embed) {
    rh.set('cache-control', 'no-store');
    rh.delete('etag');
    rh.delete('last-modified');
  }
  // HTML 문서·iframe: <head> 맨 앞에 클립보드 경계(앱 코드보다 먼저). 최상위 문서에는 막대와 아이콘·테마색도 (manifest 는 안 알린다).
  const dest = req.headers.get('sec-fetch-dest');
  if (up.status === 200 && (dest === 'document' || dest === 'iframe') && (rh.get('content-type') ?? '').includes('text/html')) {
    // 최상위 문서: upstream 응답(헤더)까지 걸린 시간만 (본문은 그대로 흘린다)
    const st = dest === 'document' ? upstreamTiming(Date.now() - at) : '';
    if (st) rh.append('server-timing', st);
    if (embed) {
      rh.delete('x-frame-options');
      rh.set('content-security-policy', rewriteFrameAncestors(rh.get('content-security-policy') ?? '', env.ORIGIN));
    }
    return injectLab(up, rh, dest === 'document' || embed, embed);
  }
  return new Response(up.body, { status: up.status, statusText: up.statusText, headers: rh });
}

/** upstream 으로 보낼 요청 헤더: Cloudflare·방문자 헤더와 우리 쿠키를 떼고 Daytona 미리보기 토큰을 붙인다 */
function upstreamHeaders(req: Request, r: Route) {
  const headers = new Headers(req.headers);
  for (const h of STRIP) headers.delete(h);
  // 우리 쿠키는 upstream 에 안 보낸다 (code-server 쿠키만)
  const rest = (req.headers.get('cookie') ?? '').split(';').map((x) => x.trim()).filter((x) => {
    const n = x.split('=')[0].trim().toLowerCase();
    return x && n !== COOKIE.toLowerCase() && n !== OLD_COOKIE;
  });
  if (rest.length) headers.set('cookie', rest.join('; ')); else headers.delete('cookie');
  // code-server 는 WebSocket 의 Origin 이 자기 호스트와 다르면 거부한다 → 위에서 이 자리 출처인 것을 확인한 뒤에만 upstream 출처로 맞춘다
  if (headers.has('origin')) headers.set('origin', r.origin);
  headers.set('x-daytona-preview-token', r.token);
  headers.set('x-daytona-skip-preview-warning', 'true');
  return headers;
}

/** upstream 응답 헤더: 같은 upstream 으로 가는 Location 은 상대 경로로, 우리 쿠키·저장소를 건드리는 헤더는 뗀다 */
function downstreamHeaders(up: Response, r: Route) {
  const rh = new Headers(up.headers);
  const loc = rh.get('location');
  if (loc?.startsWith(r.origin)) rh.set('location', loc.slice(r.origin.length) || '/');
  // upstream 이 이 출처 저장소를 지우거나(Clear-Site-Data) 우리 자리 쿠키를 덮지 못하게. Domain 은 전부 떼서 이 호스트에만
  rh.delete('clear-site-data');
  const set = up.headers.getSetCookie();
  rh.delete('set-cookie');
  for (const c of set) {
    const n = c.split('=')[0].trim().toLowerCase();
    if (n === COOKIE.toLowerCase() || n === OLD_COOKIE) continue;
    rh.append('set-cookie', c.replace(/;\s*domain\s*=[^;]*/gi, ''));
  }
  return rh;
}

/** 검증된 시연 루트만 frame-ancestors 를 env.ORIGIN 으로 바꾼다. 다른 지시문과 여러 정책의 쉼표는 유지한다. */
function rewriteFrameAncestors(csp: string, origin: string): string {
  const frame = `frame-ancestors ${origin}`;
  const policies = csp.split(',').map((part) => part.trim()).filter(Boolean);
  if (!policies.length) return frame;
  return policies.map((policy) => {
    let seen = false;
    const directives = policy.split(';').map((part) => part.trim()).filter(Boolean).map((directive) => {
      if (!/^frame-ancestors(?:\s|$)/i.test(directive)) return directive;
      seen = true;
      return frame;
    });
    if (!seen) directives.push(frame);
    return directives.join('; ');
  }).join(', ');
}

/** code-server CSP 는 script-src 'self' 를 허용한다. 막대는 nonce 가 있으면 같은 값을 쓴다.
 *  embed 루트는 참가자 수신 스크립트를 넣지 않는다 (같은 시연이 SFU 를 두 번 열지 않게). */
function injectLab(up: Response, rh: Headers, top: boolean, embed = false) {
  rh.delete('content-length');
  let nonce = '';
  let hw = new HTMLRewriter()
    .on('head', { element(e) {
      e.prepend('<script src="/__lab/guard.js"></script>', { html: true });
      if (top) e.prepend('<script src="/__lab/dom-capture-prelude.js"></script>', { html: true });
      if (top) e.append('<meta name="theme-color" content="#0f172a"><link rel="icon" href="/__lab/icon-192.png">', { html: true });
    } });
  if (top) {
    const files = embed
      ? ['bar', 'snips', 'dom-capture', 'demo-bridge', 'perf']
      : ['bar', 'snips', 'help', 'screen', 'rtc', 'dom-capture', 'live', 'classroom', 'perf'];
    hw = hw
      .on('link[rel="manifest"]', { element(e) { e.remove(); } }) // code-server 자체 manifest 도 뗀다 (자리 주소에 앱이 설치되지 않게)
      .on('script[nonce]', { element(e) { nonce ||= e.getAttribute('nonce') ?? ''; } })
      .on('body', { element(e) { e.onEndTag((t) => {
        const n = nonce ? ` nonce="${nonce.replace(/[^\w+/=-]/g, '')}"` : '';
        t.before(files.map((x) => `<script src="/__lab/${x}.js" defer${n}></script>`).join(''), { html: true }); // 막대 먼저 (__labBarUI), 수업 안내 한 번, 시간 재기는 맨 뒤
      }); } });
  }
  return hw.transform(new Response(up.body, { status: up.status, statusText: up.statusText, headers: rh }));
}
