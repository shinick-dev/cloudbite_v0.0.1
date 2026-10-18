// Restore/logout alone read this cookie. Other APIs still require x-admin-token.
import type { ApiContext } from './api-context';

export const LAB_ADMIN_COOKIE = '__Host-lab_admin';
export const LAB_ADMIN_CLEAR = LAB_ADMIN_COOKIE+'=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict';
const TOKEN = /^[A-Za-z0-9_-]{32}$/;
const HOURS_8 = 8 * 3600;
export function labAdminCookie(req: Request): string | null | 'bad' {
  const values = (req.headers.get('cookie') ?? '').split(';').map(s => s.trim()).filter(s => s.split('=')[0] === LAB_ADMIN_COOKIE).map(s => s.slice(s.indexOf('=') + 1));
  return !values.length ? null : values.length === 1 && TOKEN.test(values[0]) ? values[0] : 'bad';
}
export function rememberLabAdmin(res: Response, value: unknown) {
  if (!value || typeof value !== 'object' || !('token' in value) || typeof value.token !== 'string' || !TOKEN.test(value.token) || !('expiresAt' in value) || typeof value.expiresAt !== 'number' || !Number.isFinite(value.expiresAt)) return res;
  const left = Math.min(HOURS_8, Math.floor((value.expiresAt - Date.now()) / 1000));
  if (left > 0) res.headers.append('set-cookie', LAB_ADMIN_COOKIE+'='+value.token+'; Path=/; Max-Age='+left+'; HttpOnly; Secure; SameSite=Strict');
  res.headers.set('cache-control', 'no-store');
  return res;
}
export function labAdminSessionApi(c: ApiContext): Promise<Response> | null {
  return c.path === '/api/lab/admin/session' || c.path === '/api/lab/admin/session/remember' ? restore(c) : null;
}
async function restore(c: ApiContext) {
  if (c.req.method !== 'POST') return c.json({error:'method not allowed'},405);
  const site = c.req.headers.get('sec-fetch-site');
  if (c.req.headers.get('origin') !== c.env.ORIGIN || site && site !== 'same-origin' && site !== 'none') return c.json({error:'bad origin'},403);
  if (Number(c.req.headers.get('content-length') ?? 0) > 64) return c.json({error:'본문이 너무 큽니다.'},413);
  const reader = c.req.body?.getReader();let size=0,body='';
  try {
    const decoder = new TextDecoder('utf-8',{fatal:true,ignoreBOM:false});
    if(reader)for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>64){void reader.cancel().catch(()=>{});return c.json({error:'본문이 너무 큽니다.'},413)}body+=decoder.decode(part.value,{stream:true})}
    body+=decoder.decode();
    if(body.trim()!==''&&!/^\{\s*\}$/.test(body.trim()))return c.json({error:'본문은 비어 있어야 합니다.'},400);
  } catch { return c.json({error:'본문 형식이 올바르지 않습니다.'},400); }
  finally {reader?.releaseLock()}
  if(c.path.endsWith('/remember')){
    if(!c.admin)return c.json({error:'보안 키로 먼저 로그인하세요.'},401);
    try {const value=await c.state.labAdminRemember(c.admin);return rememberLabAdmin(c.out(value),value)}
    catch {return c.json({error:'새로고침 유지 설정을 저장하지 못했습니다.'},503)}
  }
  const token=labAdminCookie(c.req);
  if(!token||token==='bad'){const r=c.json({error:'복원할 관리 세션이 없습니다.'},401);r.headers.append('set-cookie',LAB_ADMIN_CLEAR);return r}
  try {
    const value=await c.state.labAdminResume(token);
    const res=c.out(value);res.headers.set('cache-control','no-store');
    if(res.status===401)res.headers.append('set-cookie',LAB_ADMIN_CLEAR);
    return res;
  } catch {return c.json({error:'관리 세션을 확인하지 못했습니다. 잠시 후 다시 시도하세요.'},503)}
}
