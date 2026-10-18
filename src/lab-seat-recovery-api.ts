import type { ApiContext } from './api-context';

const paths = ['/api/lab/recovery/context', '/api/lab/recovery/create', '/api/lab/recovery/status', '/api/lab/recovery/unlock'];
export function labSeatRecoveryApi(c: ApiContext): Promise<Response> | null { return paths.includes(c.path) ? route(c) : null; }
async function route(c: ApiContext): Promise<Response> {
  if (c.req.method !== 'POST') return c.json({error: 'method not allowed'}, 405);
  if (!c.admin) return c.json({error: '관리 세션이 만료됐습니다.'}, 401);
  if (c.req.headers.get('origin') !== c.env.ORIGIN) return c.json({error: 'bad origin'}, 403);
  if (Number(c.req.headers.get('content-length') ?? 0) > 8192) return c.json({error: '요청이 너무 큽니다.'}, 413);
  const reader = c.req.body?.getReader(); let body: Record<string, unknown>;
  try {
    const parts: Uint8Array[] = [];let size = 0;
    if (reader) for (;;) {const {done, value} = await reader.read();if (done) break;size += value.byteLength;
      if (size > 8192) {void reader.cancel().catch(() => {});return c.json({error: '요청이 너무 큽니다.'}, 413)}parts.push(value)}
    const bytes = new Uint8Array(size);let offset = 0;for (const part of parts) {bytes.set(part, offset);offset += part.byteLength}
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', {fatal: true, ignoreBOM: false}).decode(bytes));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return c.json({error: '요청 형식이 올바르지 않습니다.'}, 400);
    body = parsed as Record<string, unknown>;
    if (typeof body.id !== 'string' || !body.id || body.id.length > 100) return c.json({error: '실습실 ID가 올바르지 않습니다.'}, 400);
  } catch {return c.json({error: '요청 형식이 올바르지 않습니다.'}, 400)} finally {reader?.releaseLock()}
  try {
    const id = body.id as string;
    if (c.path.endsWith('/context')) return c.out(await c.state.labRecoveryContext(c.admin, id, body.n));
    if (c.path.endsWith('/create')) return c.out(await c.state.labRecoveryCreate(c.admin, id, body.requestId, body.n, body.kind, body.expectedGeneration, body.expectedRevision, body.ackDataLoss));
    if (c.path.endsWith('/unlock')) return c.out(await c.state.labRecoveryUnlock(c.admin, id, body.requestId, body.expectedGeneration, body.ackInspected));
    return c.out(await c.state.labRecoveryStatus(c.admin, id, body.requestId));
  } catch {return c.json({error: '복구 결과 확인이 필요합니다. 같은 요청 결과를 다시 확인하세요.'}, 503)}
}
