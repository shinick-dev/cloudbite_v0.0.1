// 강사 보기 전용 세션 POST API (/api/lab/teacher/session·status·logout). 경로가 맞지 않으면 null — 본문을 읽지 않고 DO 도 부르지 않는다.
//   session: 방금(3분 안) 웹에서 키를 탭한 x-admin-token 만 → __Host-lab_teacher 쿠키 (응답 본문에는 토큰 없음).
//            이 기기에 쿠키가 이미 있으면 같은 세션을 남은 시간만큼 다시 굽고, 끝난 쿠키면 새로 만들지 않고 지운다
//   status: 쿠키만 (x-admin-token 은 보지 않는다). 쿠키가 둘이거나 형식이 틀리면 거부
//   logout: 쿠키 + (있으면) 같은 화면의 x-admin-token — 그 관리 토큰과 그것으로 만든 보기 세션도 지운다
// 세 경로 모두 Origin 이 ORIGIN 과 정확히 같아야 하고(없어도 거부 — SameSite 에 더해), 본문은 비었거나 {} 만.
// 이 쿠키는 다른 관리·강사·금고 API 에서 쓰이지 않는다 (그쪽은 x-admin-token 만 본다).
// 알림 (/api/lab/teacher/push/config·subscribe·status·unsubscribe): 같은 Origin·쿠키 규칙 (관리 토큰 대신 받지 않음).
//   쿠키를 먼저 보고, 본문은 바이트 상한까지만 읽어 문자열 그대로 DO 에 넘긴다 — DO 가 세션을 확인한 뒤에만 해석·암호·저장
import type { ApiContext } from './api-context';
import { isFail } from './state';
import { TEACHER_TOKEN, TEACHER_TTL } from './lab-teacher-service';
import { labAdminCookie, LAB_ADMIN_CLEAR } from './lab-admin-session';

export const TEACHER_COOKIE = '__Host-lab_teacher';
const BODY_MAX = 64;
const PUSH_SUBSCRIBE_MAX = 4096;
const PUSH_ENDPOINT_BODY_MAX = 2304; // {"endpoint":"…"} — endpoint 2048자 + 여유
const MAX_AGE = TEACHER_TTL / 1000;
const cookieSet = (token: string, maxAge: number) => `${TEACHER_COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
const cookieClear = `${TEACHER_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;

export function labTeacherApi(c: ApiContext): Promise<Response> | null {
  switch (c.path) {
    case '/api/lab/teacher/session': return guarded(c, mint);
    case '/api/lab/teacher/status': return guarded(c, status);
    case '/api/lab/teacher/logout': return guarded(c, logout);
    case '/api/lab/teacher/push/config': return pushRoute(c, BODY_MAX, (t, b) => (isEmpty(b) ? c.state.teacherPushConfig(t) : null));
    case '/api/lab/teacher/push/subscribe': return pushRoute(c, PUSH_SUBSCRIBE_MAX, (t, b) => c.state.teacherPushSubscribe(t, b));
    case '/api/lab/teacher/push/status': return pushRoute(c, PUSH_ENDPOINT_BODY_MAX, (t, b) => c.state.teacherPushStatus(t, b));
    case '/api/lab/teacher/push/unsubscribe': return pushRoute(c, PUSH_ENDPOINT_BODY_MAX, (t, b) => c.state.teacherPushUnsubscribe(t, b));
  }
  return null;
}

/** 쿠키 값: 정확히 하나이고 형식이 맞을 때만. 없으면 null, 둘 이상·형식 틀림은 'bad' */
export function teacherCookie(req: Request): string | null | 'bad' {
  const found: string[] = [];
  for (const part of (req.headers.get('cookie') ?? '').split(';')) {
    const i = part.indexOf('=');
    const name = (i < 0 ? part : part.slice(0, i)).trim();
    if (name === TEACHER_COOKIE) found.push(i < 0 ? '' : part.slice(i + 1).trim());
  }
  if (!found.length) return null;
  return found.length === 1 && TEACHER_TOKEN.test(found[0]) ? found[0] : 'bad';
}

/** 본문을 max 바이트까지만 읽는다 (디코드 전 바이트로 센다 — 여러 바이트 글자·큰 조각 하나도). 넘으면 더 읽지 않고 null */
export async function readBody(req: Request, max: number): Promise<string | null> {
  if (Number(req.headers.get('content-length') ?? 0) > max) return null;
  if (!req.body) return '';
  const reader = req.body.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) { reader.releaseLock(); return null; }
    parts.push(value);
  }
  const all = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { all.set(p, o); o += p.byteLength; }
  return new TextDecoder().decode(all);
}

/** 비었거나 {} (공백만 허용) */
const isEmpty = (t: string) => { const x = t.trim(); return x === '' || /^\{\s*\}$/.test(x); };

/** 본문: 비었거나 {}. 64바이트 넘으면 더 읽지 않고 거부 */
async function emptyBody(req: Request) {
  const t = await readBody(req, BODY_MAX);
  return t !== null && isEmpty(t);
}

async function guarded(c: ApiContext, run: (c: ApiContext) => Promise<Response>) {
  if (c.req.headers.get('origin') !== c.env.ORIGIN) return c.json({ error: 'bad origin' }, 403);
  if (!(await emptyBody(c.req))) return c.json({ error: '본문은 비어 있어야 합니다.' }, 400);
  return run(c);
}

function withCookie(res: Response, cookie: string) {
  res.headers.append('set-cookie', cookie);
  return res;
}

// 쿠키가 있으면 그 세션을 그대로 다시 굽는다 (같은 토큰, 남은 시간만 — 늘리지 않는다). 지워졌거나·만료·형식이 틀린 쿠키면 새로 만들지 않고 지운다
async function mint(c: ApiContext) {
  const prior = teacherCookie(c.req);
  if (prior === 'bad') return withCookie(c.json({ error: '강사 보기 쿠키가 올바르지 않습니다. 보안 키로 다시 확인하세요.' }, 400), cookieClear);
  const r = await c.state.teacherSessionMint(c.admin, prior ?? undefined);
  if (isFail(r)) return prior && r.status === 401 ? withCookie(c.out(r), cookieClear) : c.out(r);
  const left = Math.min(MAX_AGE, Math.floor((r.expiresAt - Date.now()) / 1000));
  if (!(left > 0)) return withCookie(c.json({ error: '강사 보기 세션이 만료됐습니다. 보안 키로 다시 확인하세요.' }, 401), cookieClear);
  return withCookie(c.json({ ok: true, expiresAt: r.expiresAt }), cookieSet(r.token, left));
}

async function status(c: ApiContext) {
  const token = teacherCookie(c.req);
  if (token === null) return c.json({ error: '강사 보기 세션이 없습니다.' }, 401);
  if (token === 'bad') return withCookie(c.json({ error: '강사 보기 쿠키가 올바르지 않습니다.' }, 400), cookieClear);
  const r = await c.state.teacherStatus(token);
  return isFail(r) ? withCookie(c.out(r), cookieClear) : c.json(r);
}

// 쿠키만으로도 된다 (이 기기 세션). x-admin-token 이 있으면 그 관리 토큰과 그것으로 만든 보기 세션도 (늦게 구워질 쿠키까지) 지운다
async function logout(c: ApiContext) {
  const token = teacherCookie(c.req);
  const restored = labAdminCookie(c.req);
  try {
  await c.state.teacherLogout(token && token !== 'bad' ? token : null, c.admin || undefined);
  if (restored && restored !== 'bad' && restored !== c.admin) await c.state.teacherLogout(null, restored);
  return withCookie(withCookie(c.json({ ok: true }), cookieClear), LAB_ADMIN_CLEAR);
  } catch {
    return withCookie(withCookie(c.json({error:'서버 로그아웃을 확인하지 못했습니다.'},503),cookieClear),LAB_ADMIN_CLEAR);
  }
}

/** 알림 경로: Origin → 쿠키(하나·형식) → 바이트 상한 본문 → DO (세션 확인이 먼저). 401 이면 쿠키도 지운다 */
async function pushRoute(c: ApiContext, max: number, run: (token: string, body: string) => Promise<unknown> | null) {
  if (c.req.headers.get('origin') !== c.env.ORIGIN) return c.json({ error: 'bad origin' }, 403);
  const token = teacherCookie(c.req);
  if (token === null) return c.json({ error: '강사 보기 세션이 없습니다.' }, 401);
  if (token === 'bad') return withCookie(c.json({ error: '강사 보기 쿠키가 올바르지 않습니다.' }, 400), cookieClear);
  const body = await readBody(c.req, max);
  if (body === null) return c.json({ error: '요청 본문이 너무 큽니다.' }, 413);
  const p = run(token, body);
  if (!p) return c.json({ error: '본문은 비어 있어야 합니다.' }, 400);
  const r = await p;
  if (isFail(r)) return r.status === 401 ? withCookie(c.out(r), cookieClear) : c.out(r);
  return c.json(r);
}
