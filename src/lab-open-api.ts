import type { ApiContext } from './api-context';
import { verifyOpenOwnerJwt } from './lab-open-owner';

const ACTIONS = new Set(['session','submit','status','list','options','approve','resume','deny','push/config','push/options','push/subscribe','push/status','push/unsubscribe','push/devices','push/test','push/ack']);
export function labOpenApi(c: ApiContext): Promise<Response> | null {
  const action = c.path.startsWith('/api/lab/open/') ? c.path.slice('/api/lab/open/'.length).replace(/^manager\//,'') : '';
  return ACTIONS.has(action) ? route(c, action) : null;
}
async function route(c: ApiContext, action: string): Promise<Response> {
  if (c.req.method !== 'POST') return c.json({error:'method not allowed'},405);
  if (c.req.headers.get('origin') !== c.env.ORIGIN) return c.json({error:'bad origin'},403);
  if ((c.req.headers.get('content-type') ?? '').split(';')[0].trim() !== 'application/json') return c.json({error:'JSON 요청만 받습니다.'},415);
  let manager = '';
  if (!['submit','status','push/config'].includes(action)) {
    if (!c.path.startsWith('/api/lab/open/manager/')) return c.json({error:'모임지기 전용 요청함에서 확인하세요.'},403);
    const jwt = c.req.headers.get('cf-access-jwt-assertion');
    const owner = await verifyOpenOwnerJwt(jwt,c.env);
    if (!owner) return c.json({error:'본인 계정으로 요청함에 다시 로그인하세요.'},403);
    if (action === 'session') return c.json(owner);
    manager = 'owner:'+jwt;
  }
  const reader = c.req.body?.getReader(); let total = 0; const chunks: Uint8Array[] = [];
  let b: Record<string, unknown>;
  try {
    if (reader) for (;;) {
      const {done,value} = await reader.read(); if (done) break;
      total += value.byteLength;
      if (total > 12288) { void reader.cancel().catch(()=>{}); return c.json({error:'요청이 너무 큽니다.'},413); }
      chunks.push(value);
    }
    const all = new Uint8Array(total); let at = 0;
    for (const part of chunks) { all.set(part,at); at += part.byteLength; }
    const value: unknown = JSON.parse(total ? new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(all) : '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return c.json({error:'요청 형식이 올바르지 않습니다.'},400);
    b = value as Record<string,unknown>;
  } catch { return c.json({error:'요청 형식이 올바르지 않습니다.'},400); }
  finally { reader?.releaseLock(); }
  try {
    let result: unknown;
    switch(action) {
      case 'submit': result = await c.state.labOpenSubmit(b,c.src); break;
      case 'status': result = await c.state.labOpenStatus(b.id,b.secret); break;
      case 'list': result = await c.state.labOpenList(manager); break;
      case 'options': result = await c.state.labOpenOptions(manager,b.id,b.choice,c.src); break;
      case 'approve': result = await c.state.labOpenApprove(manager,b.id,b.choice,b.assertion); break;
      case 'resume': result = await c.state.labOpenResume(manager,b.id); break;
      case 'deny': result = await c.state.labOpenDeny(manager,b.id); break;
      case 'push/config': result = await c.state.labOpenPushConfig(); break;
      case 'push/options': result = await c.state.labOpenPushOptions(manager,c.src,b.subscription,b.label); break;
      case 'push/subscribe': result = await c.state.labOpenPushSubscribe(manager,b.subscription,b.label,b.assertion); break;
      case 'push/status': result = await c.state.labOpenPushStatus(manager,b.endpoint); break;
      case 'push/devices': result = await c.state.labOpenPushDevices(manager); break;
      case 'push/unsubscribe': result = await c.state.labOpenPushRemove(manager,b.endpoint); break;
      case 'push/test': result = await c.state.labOpenPushTest(manager,b.endpoint); break;
      default: result = await c.state.labOpenPushAck(manager,b.endpoint);
    }
    return c.out(result);
  } catch { return c.json({error:'결과를 확인하지 못했습니다. 같은 요청의 상태를 확인하세요.'},503); }
}
