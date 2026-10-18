// k.shinick.dev
//
//   빌린 PC   GET /borrow                → QR + 코드, 승인되면 가짜 토큰 표시
//   폰        GET /a/<id>                → 보안 키(NFC) 탭으로 승인
//   API 호출  ANY /p/<provider>/<path>   → kvt_ 토큰을 진짜 키로 바꿔 upstream 으로
//   관리      GET /admin, /register · CLI(kv.ps1) 는 POST /api/cli/login 으로 키 탭 승인 후 관리 API
//   공부방    GET /lab (강사, 키 탭) · 참가자는 LAB_ORIGIN(lab.shinick.dev) — src/labhost.ts
//
// workers.dev 주소로는 프록시(/p/)만 연다. Daytona 샌드박스(Tier 1·2)는 허용 목록 밖의 도메인에 못 나가서
// k.shinick.dev 대신 workers.dev 로 게이트웨이를 부른다. 관리·금고 화면은 k.shinick.dev 에서만.

import { verifyOpenOwnerJwt } from './lab-open-owner';
import { labHost, labSeatHost, seatHostLabel } from './labhost';
import { labDemoHost } from './lab-demo-host';
import { labDemoApi } from './lab-demo-api';
import { classroomMaterialsHost } from './lab-classroom-materials-host';
import { adminApi } from './admin-api';
import type { ApiContext } from './api-context';
import { authApi } from './auth-api';
import { labApi } from './lab-api';
import { vaultApi } from './vault-api';
import { providerProxy } from './provider-proxy';
import { publicGet } from './public-get';
import { cloudbiteRoute } from './cloudbite-api';
import { cloudbiteAliasPath, cloudbiteIdentity, retiredCloudbiteOrigin } from './cloudbite-origin';
import { isFail, sha, type Env, type State } from './state';

export { State } from './state';
export { CloudbiteProject } from './cloudbite-project';
export { CloudbiteAccess } from './cloudbite-access-service';
export { CloudbiteHistory } from './cloudbite-history';

const SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
};
const CSP = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const html = (body: string) =>
  new Response(body, { headers: { ...SECURITY_HEADERS, 'content-type': 'text/html; charset=utf-8', 'content-security-policy': CSP } });
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...SECURITY_HEADERS, 'content-type': 'application/json' } });
const out = (r: unknown) => (isFail(r) ? json({ error: r.error }, r.status) : json(r));

function bearer(req: Request) {
  const a = req.headers.get('authorization');
  if (a?.toLowerCase().startsWith('bearer ')) return a.slice(7).trim();
  // Anthropic SDK 는 x-api-key, ElevenLabs SDK 는 xi-api-key 로 보낸다
  return (req.headers.get('x-api-key') ?? req.headers.get('xi-api-key'))?.trim() ?? null;
}

// 익명으로 부를 수 있는 인증 API 는 본문을 이만큼까지만 읽는다 (WebAuthn 응답·공개키·복구 값은 몇 KB)
const ANON_BODY_MAX = 32 * 1024;
const ANON_POST = /^\/api\/(borrow|cli\/login|recv|borrow\/[\w-]{16}\/poll|approve\/[\w-]{16}(\/options|\/deny)?|register\/(options|verify)|vault\/(status|options|open|recover-info|recover)|admin\/(options|login))$/;
const capped = new WeakMap<Request, string>();

/** 본문을 max 바이트까지만 읽는다. 넘으면 null (더 읽지 않고 끊는다) */
async function readCapped(req: Request, max: number): Promise<string | null> {
  if (Number(req.headers.get('content-length') ?? 0) > max) return null;
  if (!req.body) return '';
  const reader = req.body.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) { reader.releaseLock(); return null; } // 나머지는 읽지 않는다 (런타임이 버린다)
    parts.push(value);
  }
  const all = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { all.set(p, o); o += p.byteLength; }
  return new TextDecoder().decode(all);
}

async function body<T>(req: Request): Promise<T> {
  const pre = capped.get(req);
  try { return (pre !== undefined ? JSON.parse(pre || '{}') : await req.json()) as T; } catch { return {} as T; }
}

/**
 * 요청 출처: Cloudflare 가 넣는 cf-connecting-ip (클라이언트가 보낸 같은 이름 헤더는 Cloudflare 가 덮어쓴다). 본문 값은 안 믿는다.
 * IPv6 는 /64 로 묶는다 (한 가입자가 보통 /64 를 통째로 받는다). 헤더가 없으면(로컬 wrangler dev·loopback 테스트) 'loopback' 하나로.
 * DO 에는 MASTER_KEY 를 섞은 해시만 간다 — IP 원문을 출처 상한 기록에 남기지 않는다
 */
function sourceKey(raw: string | null) {
  const ip = (raw ?? '').trim().toLowerCase();
  if (!ip) return 'loopback';
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) return `4:${ip}`;
  const v4 = ip.match(/^::ffff:(\d{1,3}(\.\d{1,3}){3})$/);
  if (v4) return `4:${v4[1]}`;
  if (!/^[0-9a-f:]{2,39}$/.test(ip) || (ip.match(/::/g)?.length ?? 0) > 1) return 'other';
  const [head, tail] = ip.includes('::') ? ip.split('::') : [ip, undefined];
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const full = tail === undefined ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  if (full.length !== 8 || full.some((x) => !/^[0-9a-f]{1,4}$/.test(x))) return 'other';
  return `6:${full.slice(0, 4).map((x) => x.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}
async function sourceOf(req: Request, env: Env) {
  return (await sha(`gw-src-v1|${env.MASTER_KEY ?? ''}|${sourceKey(req.headers.get('cf-connecting-ip'))}`)).slice(0, 22);
}

/** POST API: 메서드 → Origin → 익명 본문 상한·출처 해시 → 인증·금고·관리·강사 라우터 순서. 맞는 경로가 없으면 404 */
async function postApi(req: Request, path: string, env: Env, state: DurableObjectStub<State>): Promise<Response> {
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  // 교차 사이트 POST 차단 (브라우저 페이지용 API). 프록시·/api/end 는 CLI 도 부르므로 제외.
  const origin = req.headers.get('origin');
  if (origin && origin !== env.ORIGIN && path !== '/api/end') return json({ error: 'bad origin' }, 403);

  // 익명 인증 API: 본문 크기 제한 + 출처 해시 (출처마다 상한은 DO 가 센다)
  let src = '';
  if (ANON_POST.test(path)) {
    const text = await readCapped(req, ANON_BODY_MAX);
    if (text === null) return json({ error: '요청 본문이 너무 큽니다.' }, 413);
    capped.set(req, text);
    src = await sourceOf(req, env);
  }
  // 개설 요청 라우터가 자체 스트림 상한을 적용한다. 본문을 미리 소비하지 않고 출처만 해시한다.
  if (path.startsWith('/api/lab/open/')) src = await sourceOf(req, env);

  // 인증·금고·관리·강사 API: 위 검사를 다 지난 뒤에만, 이 순서로. 경로가 맞지 않으면 null
  const api: ApiContext = { req, path, env, state, src, admin: req.headers.get('x-admin-token') ?? '', body, json, out };
  const routed = (await authApi(api, bearer)) ?? (await vaultApi(api)) ?? (await adminApi(api)) ?? (await labDemoApi(api)) ?? (await labApi(api));
  if (routed) return routed;

  return json({ error: 'not found' }, 404);
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const retired = retiredCloudbiteOrigin(req, env);
    if (retired) return retired;
    // Preserve the existing workers.dev origin, data and gateway. Only this configured alias receives a
    // request-local origin; Durable Objects retain their original environment and namespaces.
    if (url.origin !== env.ORIGIN && !path.startsWith('/p/')) {
      const identity = cloudbiteIdentity(env, url.origin);
      if (identity && cloudbiteAliasPath(path)) env = { ...env, ORIGIN: identity.origin, RP_ID: identity.rpId };
    }
    const state = env.STATE.get(env.STATE.idFromName('main'));

    // 자리 호스트 s-<label>.<LAB_SEAT_DOMAIN>: 경로와 상관없이 전부 그 자리 (형식이 틀린 이름은 /p/ 까지 404)
    const seatLabel = seatHostLabel(env, url);
    if (seatLabel !== null) return seatLabel ? (await labDemoHost(req, env, state, url, seatLabel)) ?? (await classroomMaterialsHost(req, state, url, seatLabel)) ?? labSeatHost(req, env, state, url, seatLabel) : json({ error: 'not found' }, 404);
    if (url.host === new URL(env.LAB_ORIGIN).host && !path.startsWith('/p/')) return labHost(req, env, state, url);
    if (url.host !== new URL(env.ORIGIN).host && !path.startsWith('/p/')) return json({ error: 'not found' }, 404);

    // A browser validates the custom origin against the original RP before using an existing security key.
    // No wildcard, request-derived hostname, credentials or cookies are included in this public document.
    if (path === '/.well-known/webauthn' && req.method === 'GET') {
      const alias = env.CLOUDBITE_PUBLIC_ORIGIN && cloudbiteIdentity(env, env.CLOUDBITE_PUBLIC_ORIGIN);
      return alias ? json({ origins: [env.ORIGIN, alias.origin] }) : json({ error: 'not found' }, 404);
    }

    // 샌드박스 lab-status·lab-doctor: 이 자리 가짜 토큰으로 쓸 수 있는 공유 키·남은 호출 수 (upstream 안 부름)
    if (path === '/p/_lab/share' && req.method === 'GET') {
      const token = bearer(req);
      if (!token?.startsWith('kvt_')) return json({ error: 'missing gateway token' }, 401);
      return out(await state.labShareStatus(token));
    }

    // Cloudbite: /api/cloudbite/* (주 호스트) · /p/_cloudbite/worker/* (게이트웨이, 전문가별 짧은 권한) — src/cloudbite-api.ts
    const cloudbite = await cloudbiteRoute(req, env, url, state, json);
    if (cloudbite) return cloudbite;

    // ── 프록시 ── (예약·키·upstream 호출은 src/provider-proxy.ts)
    const g = path.match(/^\/p\/([a-z0-9-]+)\/(.*)$/);
    if (g) {
      const provider = g[1];
      const token = bearer(req);
      if (!token?.startsWith('kvt_')) return json({ error: 'missing gateway token' }, 401);
      return providerProxy(req, state, ctx, provider, g[2], url.search, token, json);
    }

    if (path === '/lab/requests' && !await verifyOpenOwnerJwt(req.headers.get('cf-access-jwt-assertion'),env))
      return json({error:'본인 계정으로 요청함에 로그인해야 합니다.'},403);

    if (req.method === 'GET') return publicGet({ path, url, env, state, sec: SECURITY_HEADERS, html, json, out });

    return postApi(req, path, env, state);
  },
} satisfies ExportedHandler<Env>;
