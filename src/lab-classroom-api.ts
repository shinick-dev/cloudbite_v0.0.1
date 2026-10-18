// 수업 안내 POST API. 경로가 아니면 null — 본문을 읽지 않고 DO 도 부르지 않는다.
// 상태는 관리 토큰 또는 강사 보기 쿠키만. 쿠키는 수정·피드백 권한이 아니다.
// Origin 은 없거나 다르면 거부한다. 본문은 96KiB 를 넘기 전에 끊는다.
import type { ApiContext } from './api-context';
import { TEACHER_COOKIE, teacherCookie } from './lab-teacher-api';
import { isFail } from './state';

const paths = ['/api/lab/classroom/status', '/api/lab/classroom/update', '/api/lab/classroom/feedback', '/api/lab/classroom/history'];
const MAX_BODY = 96 * 1024;
const LAB_ID = /^[\w-]{1,100}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const cookieClear = `${TEACHER_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;

export function labClassroomApi(c: ApiContext): Promise<Response> | null {
  return paths.includes(c.path) ? route(c) : null;
}

function withCookie(res: Response) {
  res.headers.append('set-cookie', cookieClear);
  return res;
}

async function route(c: ApiContext): Promise<Response> {
  if (c.req.method !== 'POST') return c.json({ error: 'method not allowed' }, 405);
  if (c.req.headers.get('origin') !== c.env.ORIGIN) return c.json({ error: 'bad origin' }, 403);
  const status = c.path === '/api/lab/classroom/status';
  if (!status && !c.admin) return c.json({ error: '관리 세션이 만료됐습니다.' }, 401);
  if (status && !c.admin) {
    const token = teacherCookie(c.req);
    if (token === 'bad') return withCookie(c.json({ error: '강사 보기 쿠키가 올바르지 않습니다.' }, 400));
    if (!token) return c.json({ error: '관리 세션이 만료됐습니다.' }, 401);
  }
  if (Number(c.req.headers.get('content-length') ?? 0) > MAX_BODY) return c.json({ error: '요청이 너무 큽니다.' }, 413);
  const reader = c.req.body?.getReader();
  let body: Record<string, unknown>;
  try {
    const parts: Uint8Array[] = [];
    let size = 0;
    if (reader) for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) { void reader.cancel().catch(() => {}); return c.json({ error: '요청이 너무 큽니다.' }, 413); }
      parts.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return c.json({ error: '요청 형식이 올바르지 않습니다.' }, 400);
    body = parsed as Record<string, unknown>;
  } catch { return c.json({ error: '요청 형식이 올바르지 않습니다.' }, 400); }
  finally { reader?.releaseLock(); }
  if (c.path === '/api/lab/classroom/history') {
    if (!sameKeys(body, [])) return c.json({ error: '본문은 비어 있어야 합니다.' }, 400);
    try { return c.out(await c.state.labClassroomHistory(c.admin)); }
    catch { return c.json({ error: '지난 모임 목록을 확인하지 못했습니다. 다시 확인하세요.' }, 503); }
  }
  if (typeof body.id !== 'string' || !LAB_ID.test(body.id)) return c.json({ error: '실습실 ID가 올바르지 않습니다.' }, 400);
  try {
    if (status) {
      if (!sameKeys(body, ['id'])) return c.json({ error: '요청 형식이 올바르지 않습니다.' }, 400);
      return await statusRoute(c, body.id);
    }
    if (c.path === '/api/lab/classroom/update') {
      if (!sameKeys(body, ['id', 'revision', 'patch']) || !Number.isSafeInteger(body.revision) || (body.revision as number) < 0 || !body.patch || typeof body.patch !== 'object' || Array.isArray(body.patch)) return c.json({ error: '수업 안내 형식이 올바르지 않습니다.' }, 400);
      return c.out(await c.state.labClassroomUpdate(c.admin, body.id, body.revision, body.patch));
    }
    if (!sameKeys(body, ['id', 'n', 'submissionId', 'feedback']) || !Number.isInteger(body.n) || typeof body.submissionId !== 'string' || !UUID.test(body.submissionId) || typeof body.feedback !== 'string') return c.json({ error: '피드백 형식이 올바르지 않습니다.' }, 400);
    return c.out(await c.state.labClassroomFeedback(c.admin, body.id, body.n, body.submissionId, body.feedback));
  } catch { return c.json({ error: '수업 안내를 확인하지 못했습니다. 같은 요청으로 다시 확인하세요.' }, 503); }
}

async function statusRoute(c: ApiContext, id: string) {
  if (c.admin) return c.out(await c.state.labClassroomStatus(c.admin, id));
  const token = teacherCookie(c.req);
  if (token === 'bad' || !token) return c.json({ error: '관리 세션이 만료됐습니다.' }, 401);
  const result = await c.state.labClassroomTeacherStatus(token, id);
  if (isFail(result) && result.status === 401) return withCookie(c.out(result));
  return c.out(result);
}

function sameKeys(body: Record<string, unknown>, allowed: string[]) {
  const keys = Object.keys(body);
  return keys.length === allowed.length && allowed.every((key) => Object.prototype.hasOwnProperty.call(body, key));
}
