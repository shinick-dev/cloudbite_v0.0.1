import type { ApiContext } from './api-context';
import { readBody } from './lab-teacher-api';

export function labDemoApi(c: ApiContext): Promise<Response> | null {
  const prefix = '/api/lab/classroom/demo/';
  if (!c.path.startsWith(prefix)) return null;
  return route(c, c.path.slice(prefix.length));
}
async function route(c: ApiContext, operation: string) {
  if (!['status', 'prepare', 'send', 'open', 'file'].includes(operation)) return c.json({ error: 'not found' }, 404);
  if (c.req.headers.get('origin') !== c.env.ORIGIN) return c.json({ error: 'bad origin' }, 403);
  if (!c.admin) return c.json({ error: '보안 키로 다시 확인하세요.' }, 401);
  const text = await readBody(c.req, operation === 'file' ? 512 * 1024 : 20000);
  if (text === null) return c.json({ error: '본문이 너무 큽니다.' }, 413);
  let b: Record<string, unknown>;
  try { b = JSON.parse(text); if (!b || typeof b !== 'object' || Array.isArray(b)) throw Error(); }
  catch { return c.json({ error: '본문이 올바르지 않습니다.' }, 400); }
  const allowed = operation === 'prepare' ? ['id', 'requestId'] : operation === 'send' ? ['id', 'requestId', 'command'] : operation === 'file' ? ['id', 'filename', 'requestId', 'content', 'expectedHash'] : ['id'];
  if (Object.keys(b).some(k => !allowed.includes(k)) || typeof b.id !== 'string') return c.json({ error: '요청 항목이 올바르지 않습니다.' }, 400);
  try {
    if (operation === 'status') return c.out(await c.state.labClassroomDemoStatus(c.admin, b.id));
    if (operation === 'prepare') return c.out(await c.state.labClassroomDemoPrepare(c.admin, b.id, b.requestId));
    if (operation === 'send') return c.out(await c.state.labClassroomDemoSend(c.admin, b.id, b.requestId, b.command));
    if (operation === 'file') return c.out(await c.state.labClassroomDemoFile(c.admin, b.id, b.filename, b.requestId, b.content, b.expectedHash));
    return c.out(await c.state.labClassroomDemoOpen(c.admin, b.id));
  } catch { return c.json({ error: '시연실 요청 결과를 확인하지 못했습니다. 상태 확인을 이용하세요.' }, 503); }
}
