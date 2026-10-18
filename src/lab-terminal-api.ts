import type { ApiContext } from './api-context';
import type { Fail } from './state';
const isFail = (value: unknown): value is Fail => !!value && typeof value === 'object' && 'error' in value && 'status' in value;
const terminalOut = (c: ApiContext, value: unknown) => isFail(value) && 'code' in value
  ? c.json({ error: value.error, code: value.code }, value.status) : c.out(value);
// 권한은 관리자 토큰으로만. 읽기 전용 모임지기 쿠키·참가자 쿠키로는 명령을 보낼 수 없다.
export function labTerminalApi(c: ApiContext): Promise<Response> | null {
  if (!['/api/lab/terminal/start', '/api/lab/terminal/send', '/api/lab/terminal/stop', '/api/lab/terminal/status', '/api/lab/terminal/takeover'].includes(c.path)) return null;
  return route(c);
}
async function route(c: ApiContext) {
  if (!c.admin) return c.json({ error: '관리 세션이 만료됐습니다.' }, 401);
  if (c.req.headers.get('origin') !== c.env.ORIGIN) return c.json({ error: 'bad origin' }, 403);
  const reader = c.req.body?.getReader();
  try {
    if (Number(c.req.headers.get('content-length') ?? 0) > 32768) return c.json({ error: '요청이 너무 큽니다.' }, 413);
    const parts: Uint8Array[] = []; let bytes = 0;
    if (reader) for (;;) { const { done, value } = await reader.read(); if (done) break; bytes += value.byteLength; if (bytes > 32768) { void reader.cancel().catch(() => {}); return c.json({ error: '요청이 너무 큽니다.' }, 413); } parts.push(value); }
    const all = new Uint8Array(bytes); let offset = 0; for (const part of parts) { all.set(part, offset); offset += part.byteLength; }
    const b: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(all));
    if (!b || typeof b !== 'object' || Array.isArray(b)) return c.json({ error: '요청 형식이 올바르지 않습니다.' }, 400);
    const x = b as Record<string, unknown>;
    if (typeof x.id !== 'string' || !x.id || x.id.length > 100) return c.json({ error: '실습실 ID가 올바르지 않습니다.' }, 400);
    switch (c.path) {
      case '/api/lab/terminal/start': return terminalOut(c, await c.state.labTerminalStart(c.admin, x.id, x.requestId, x.seats, x.expectedControlRevision));
      case '/api/lab/terminal/send': return terminalOut(c, await c.state.labTerminalSend(c.admin, x.id, x.sessionId, x.requestId, x.command, x.expectedControlRevision, x.previewId));
      case '/api/lab/terminal/stop': return c.out(await c.state.labTerminalStop(c.admin, x.id, x.sessionId));
      case '/api/lab/terminal/takeover': return c.out(await c.state.labTerminalTakeover(c.admin, x.id, x.sessionId));
      default: return c.out(await c.state.labTerminalStatus(c.admin, x.id));
    }
  } catch { return c.json({ error: '수업 터미널 요청을 처리하지 못했습니다. 상태를 확인하거나 같은 요청 ID로 다시 확인하세요.' }, 400); }
  finally { reader?.releaseLock(); }
}
