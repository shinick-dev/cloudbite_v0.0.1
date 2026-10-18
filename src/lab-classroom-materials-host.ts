import type { State } from './state';
import { LAB_CLASSROOM_MATERIALS_JS } from './lab-classroom-materials-ui';

export { LAB_CLASSROOM_MATERIALS_JS };
export async function classroomMaterialsHost(req: Request, state: DurableObjectStub<State>, url: URL, label: string): Promise<Response | null> {
  if (url.pathname !== '/__lab/classroom/materials') return null;
  const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' } });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  const site = req.headers.get('sec-fetch-site');
  if (req.headers.get('origin') !== url.origin || (site && site !== 'same-origin' && site !== 'none')) return json({ error: 'bad origin' }, 403);
  if ((req.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase() !== 'application/json') return json({ error: 'content-type' }, 415);
  const codes = (req.headers.get('cookie') ?? '').split(';').map(p => p.trim()).filter(p => p.split('=')[0] === '__Host-lab_seat').map(p => p.slice(p.indexOf('=') + 1));
  if (codes.length !== 1 || !/^[\w-]{16}$/.test(codes[0])) return json({ error: '내 실습실에서 다시 열어 주세요.' }, 401);
  if (Number(req.headers.get('content-length') ?? 0) > 64) return json({ error: '본문이 너무 큽니다.' }, 413);
  const reader = req.body?.getReader(); let size = 0, body = '';
  try {
    if (reader) for (;;) { const part = await reader.read(); if (part.done) break; size += part.value.byteLength; if (size > 64) { await reader.cancel(); return json({ error: '본문이 너무 큽니다.' }, 413); } body += new TextDecoder().decode(part.value); }
    if (body.trim() && !/^\{\s*\}$/.test(body.trim())) return json({ error: '파일 내용과 대상은 모임의 저장된 자료로만 결정합니다.' }, 400);
    const r = await state.labClassroomMaterials(codes[0], label);
    return 'status' in r ? json({ error: r.error }, r.status) : json(r);
  } catch { return json({ error: '자료 넣기 결과가 미확정입니다. 파일 목록을 확인하세요. 다시 눌러도 이미 있는 파일은 덮어쓰지 않습니다.' }, 503); }
  finally { reader?.releaseLock(); }
}
