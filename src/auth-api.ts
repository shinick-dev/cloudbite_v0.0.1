// 인증 POST API (/api/borrow·/api/cli/login·/api/recv·/api/borrow/<id>/poll·/api/end·/api/approve/*·/api/register/*).
// 경로가 맞지 않으면 null — 본문을 읽지 않고 DO 도 부르지 않는다

import { renderSVG } from 'uqr';
import type { ApiContext } from './api-context';
import { envVars } from './providers';
import { isFail, sha } from './state';

const POLL = /^\/api\/borrow\/([\w-]{16})\/poll$/;
const APPROVE_OPTIONS = /^\/api\/approve\/([\w-]{16})\/options$/;
const APPROVE_DENY = /^\/api\/approve\/([\w-]{16})\/deny$/;
const APPROVE = /^\/api\/approve\/([\w-]{16})$/;

/** bearer: index.ts 의 게이트웨이 토큰 읽기 (Authorization·x-api-key·xi-api-key) */
export function authApi(c: ApiContext, bearer: (req: Request) => string | null): Promise<Response> | null {
  const { path } = c;
  let g: RegExpMatchArray | null;
  if (path === '/api/borrow' || path === '/api/cli/login' || path === '/api/recv') return createRequest(c);
  if ((g = path.match(POLL))) return poll(c, g[1]);
  if (path === '/api/end') return end(c, bearer);
  if ((g = path.match(APPROVE_OPTIONS))) return send(c, c.state.approveOptions(g[1], c.src));
  if ((g = path.match(APPROVE_DENY))) return send(c, c.state.deny(g[1]));
  if ((g = path.match(APPROVE))) return approve(c, g[1]);
  if (path === '/api/register/options' || path === '/api/register/verify') return register(c);
  return null;
}

async function send(c: ApiContext, r: PromiseLike<unknown>) {
  return c.out(await r);
}

/** 승인 요청 메타 (길이는 잘라서) */
function requestMeta(req: Request) {
  const cf = (req as Request & { cf?: IncomingRequestCfProperties }).cf;
  return {
    ip: (req.headers.get('cf-connecting-ip') ?? '').slice(0, 64),
    country: String(cf?.country ?? '').slice(0, 8),
    city: String(cf?.city ?? '').slice(0, 80),
    ua: (req.headers.get('user-agent') ?? '').slice(0, 300),
  };
}

async function createRequest(c: ApiContext) {
  const { req, path, env, state, src, body, json, out } = c;
  const kind = path === '/api/cli/login' ? 'admin' : path === '/api/recv' ? 'send' : 'borrow';
  const pub = kind === 'send' ? String((await body<{ pub?: string }>(req)).pub ?? '') : undefined;
  const r = await state.createRequest(requestMeta(req), kind, pub, src);
  if (isFail(r)) return out(r);
  const approveUrl = `${env.ORIGIN}/a/${r.id}`;
  return json({ ...r, approveUrl, qr: renderSVG(approveUrl) });
}

async function poll(c: ApiContext, id: string) {
  const { secret } = await c.body<{ secret?: string }>(c.req);
  const r = await c.state.pollRequest(id, String(secret ?? ''));
  if (isFail(r) || !('defs' in r)) return c.out(r);
  const { defs, ...rest } = r;
  return c.json({ ...rest, env: envVars(c.env.ORIGIN, r.token, defs) });
}

async function end(c: ApiContext, bearer: (req: Request) => string | null) {
  const token = bearer(c.req);
  if (!token?.startsWith('kvt_')) return c.json({ error: 'missing gateway token' }, 401);
  return c.out(await c.state.endByToken(token));
}

async function approve(c: ApiContext, id: string) {
  const b = await c.body<{ assertion?: any; choice?: any }>(c.req);
  const ch = b.choice ?? {};
  return c.out(await c.state.approve(id, b.assertion, {
    providers: Array.isArray(ch.providers) ? ch.providers.map(String) : [],
    ttlHours: Number(ch.ttlHours), budget: Number(ch.budget),
    manage: ch.manage, limits: ch.limits, // 형식 확인은 DO 가 탭 확인 전에 (빠지면 관리 API 없음·기본 상한)
  }));
}

async function register(c: ApiContext) {
  const { req, path, env, state, src, body, json, out } = c;
  const b = await body<{ setup?: string; response?: any; label?: string }>(req);
  const want = env.SETUP_TOKEN;
  const adm = req.headers.get('x-admin-token') ?? '';
  if (!want && !adm) return json({ error: '등록이 닫혀 있습니다. /admin 에 키로 로그인해서 추가하거나 deploy.ps1 -SetupOnly 로 여세요.' }, 403);
  const setupHash = await setupGrantHash(want, b);
  if (path === '/api/register/options') return out(await state.registerOptions(setupHash, adm, src));
  return out(await state.registerVerify(setupHash, b.response, String(b.label ?? ''), adm));
}

/**
 * DO 에는 맞을 때만 토큰 해시를 넘긴다 (창·횟수 기록의 열쇠). 토큰 원문은 DO·감사 기록에 안 간다.
 * SETUP_TOKEN 이 없으면 b.setup 을 보지 않는다 (본문이 JSON null 이어도 관리 토큰 등록은 그대로)
 */
async function setupGrantHash(want: string | undefined, b: { setup?: string }) {
  const setupOk = !!want && typeof b.setup === 'string' && b.setup.length <= 256 && (await sha(b.setup.trim())) === (await sha(want));
  return setupOk ? await sha(`gw-setup-v1|${want}`) : '';
}
