// 관리·읽기 전용 모니터와 분리된 8시간 모임 화면 쿠키. 화면 송출·동의한 탭 지원만 허용.
import type { ApiContext } from './api-context';
import { isFail } from './state';
import { TEACHER_TOKEN, TEACHER_TTL } from './lab-teacher-service';
import { readBody } from './lab-teacher-api';

export const LIVE_COOKIE = '__Host-lab_live';
export function liveCookie(req: Request) {
  const values = (req.headers.get('cookie') ?? '').split(';').map(p => p.trim()).filter(p => p.startsWith(LIVE_COOKIE + '=')).map(p => p.slice(LIVE_COOKIE.length + 1));
  return values.length === 0 ? null : values.length === 1 && TEACHER_TOKEN.test(values[0]) ? values[0] : 'bad';
}
export function labLiveApi(c: ApiContext): Promise<Response> | null {
  if (!c.path.startsWith('/api/lab/live/')) return null;
  return handle(c);
}
async function handle(c: ApiContext): Promise<Response> {
  if (c.req.method !== 'POST') return c.json({ error: 'method not allowed' }, 405);
  const routes = ['session', 'logout', 'status', 'screen/start', 'screen/stop', 'screen/status', 'pull', 'answer', 'quality', 'request', 'release', 'input', 'close'];
  const action = c.path.slice('/api/lab/live/'.length);
  if (!routes.includes(action)) return c.json({ error: 'not found' }, 404);
  if (c.req.headers.get('origin') !== c.env.ORIGIN) return c.json({ error: 'bad origin' }, 403);
  const raw = await readBody(c.req, ['screen/start', 'answer'].includes(action) ? 128 * 1024 : 8192);
  if (raw === null) return c.json({ error: '요청 본문이 너무 큽니다.' }, 413);
  let b: Record<string, unknown>;
  try { b = raw.trim() ? JSON.parse(raw) : {}; } catch { return c.json({ error: 'JSON 형식이 올바르지 않습니다.' }, 400); }
  if (!b || typeof b !== 'object' || Array.isArray(b)) return c.json({ error: '요청 형식이 올바르지 않습니다.' }, 400);
  const token = liveCookie(c.req);
  if (token === 'bad') return c.json({ error: '모임 화면 쿠키가 올바르지 않습니다.' }, 400);
  if (['session','logout','status','screen/status'].includes(action) && Object.keys(b).length) return c.json({ error: '본문은 비어 있어야 합니다.' }, 400);
  if (action === 'session') {
    const r = await c.state.labLiveMint(c.admin, token ?? undefined);
    if (isFail(r)) {
      const res = c.out(r);
      if (r.status === 401) res.headers.append('set-cookie', `${LIVE_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`);
      return res;
    }
    const res = c.json({ ok: true, expiresAt: r.expiresAt });
    const seconds = Math.max(0, Math.min(TEACHER_TTL / 1000, Math.floor((r.expiresAt - Date.now()) / 1000)));
    res.headers.append('set-cookie', `${LIVE_COOKIE}=${r.token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${seconds}`);
    return res;
  }
  if (action === 'logout') {
    await c.state.labLiveLogout(token, c.admin || undefined);
    const res = c.json({ ok: true });
    res.headers.append('set-cookie', `${LIVE_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`); return res;
  }
  if (!token) return c.json({ error: '모임 화면 세션이 없습니다. 보안 키로 다시 확인하세요.' }, 401);
  const auth = await c.state.labLiveOwner(token);
  if (!auth) return c.json({ error: '모임 화면 세션이 만료됐습니다. 보안 키로 다시 확인하세요.' }, 401);
  const id = typeof b.id === 'string' ? b.id : '', n = Number(b.n);
  switch (action) {
    case 'status': return c.out(await c.state.labLiveStatus(token));
    case 'quality': return c.out(await c.state.labLiveQuality(token, b.viewerTab, b.revision, b.at, b.focus));
    case 'screen/start': return c.out(await c.state.labScreenStart(token, id, b.sdp, b.tracks));
    case 'screen/stop': return c.out(await c.state.labScreenStop(token, id));
    case 'screen/status': return c.out(await c.state.labScreenList(token));
    case 'pull': return c.out(await c.state.labLivePull(token, id, n));
    case 'answer': return c.out(await c.state.labLivePull(token, id, n, b.sid, b.sdp));
    case 'request': return c.out(await c.state.labLiveRequest(token, id, n, b.requestId));
    case 'release': return c.out(await c.state.labLiveRelease(token, id, n, b.requestId));
    case 'close': return c.out(await c.state.labLiveClose(token, id, n));
    case 'input': return c.out(await c.state.labLiveInput(token, id, n, b.requestId, b.eventId, b.event));
  }
  return c.json({ error: 'not found' }, 404);
}
