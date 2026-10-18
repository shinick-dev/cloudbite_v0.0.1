import type { ApiContext } from './api-context';

const paths = ['/api/lab/interrupt/preview', '/api/lab/interrupt/request'];
const MAX_BODY = 32768;

/** 실행 권한은 관리자 토큰으로만 부여한다. 보기 쿠키는 제어 권한이 아니다. */
export function labInterruptApi(c: ApiContext): Promise<Response> | null {
  return paths.includes(c.path) ? route(c) : null;
}

async function route(c: ApiContext): Promise<Response> {
  if (c.req.method !== 'POST') return c.json({ error: 'method not allowed' }, 405);
  if (!c.admin) return c.json({ error: '관리 세션이 만료됐습니다.' }, 401);
  if (c.req.headers.get('origin') !== c.env.ORIGIN) return c.json({ error: 'bad origin' }, 403);
  if (Number(c.req.headers.get('content-length') ?? 0) > MAX_BODY) return c.json({ error: '요청이 너무 큽니다.' }, 413);
  const reader = c.req.body?.getReader();
  let body: Record<string, unknown>;
  try {
    const parts: Uint8Array[] = []; let size = 0;
    if (reader) for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) { void reader.cancel().catch(() => {}); return c.json({ error: '요청이 너무 큽니다.' }, 413); }
      parts.push(value);
    }
    const bytes = new Uint8Array(size); let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return c.json({ error: '요청 형식이 올바르지 않습니다.' }, 400);
    body = parsed as Record<string, unknown>;
    if (typeof body.id !== 'string' || !body.id || body.id.length > 100) return c.json({ error: '실습실 ID가 올바르지 않습니다.' }, 400);
  } catch { return c.json({ error: '요청 형식이 올바르지 않습니다.' }, 400); }
  finally { reader?.releaseLock(); }
  try {
    if (c.path === '/api/lab/interrupt/preview') return c.out(await c.state.labInterruptPreview(c.admin, body.id as string, body.previewId, body.seats, body.expectedRevision));
    return c.out(await c.state.labInterruptRequest(c.admin, body.id as string, body.previewId, body.requestId));
  } catch { return c.json({ error: '중단 요청의 결과를 확인하지 못했습니다. 같은 요청으로 다시 확인하세요.' }, 503); }
}
