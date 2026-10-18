// Scoped assistant API. Admin tokens never act as assistant credentials.
import type { ApiContext } from './api-context';

const PREFIX = '/api/lab/assistant/';
const OWNER = '/api/lab/assistants/';
const COOKIE = '__Host-lab_assistant';
const TOKEN = /^la_[A-Za-z0-9_-]{43}$/;
const names = ['session','logout','status','questions','reply','template','pause'];
const owners = ['issue','list','revoke','audit'];

function credential(req: Request): string | null {
  const h = req.headers.get('x-lab-assistant');
  if (h !== null) return TOKEN.test(h) ? h : null;
  const values = (req.headers.get('cookie') ?? '').split(';').map(x => x.trim()).filter(x => x.startsWith(COOKIE+'='));
  if (values.length !== 1) return null;
  const value = values[0].slice(COOKIE.length+1);
  return TOKEN.test(value) ? value : null;
}
const cookie = (token: string, age: number) => COOKIE+'='+token+'; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age='+age;
async function read(req: Request, max: number): Promise<Record<string, unknown> | number> {
  const declared = Number(req.headers.get('content-length') ?? 0);
  if (declared > max) return 413;
  const reader = req.body?.getReader(); const chunks: Uint8Array[] = []; let size=0;
  if (reader) {
    try {
      for (;;) {
        const {done,value}=await reader.read(); if(done) break;
        size+=value.byteLength;
        if(size>max){await reader.cancel().catch(()=>{});return 413;}
        chunks.push(value);
      }
    } finally {reader.releaseLock();}
  }
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  try {
    const data:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(bytes)||'{}');
    return data && typeof data==='object' && !Array.isArray(data) ? data as Record<string,unknown> : 400;
  } catch {return 400;}
}
const only=(b:Record<string,unknown>,keys:string[])=>Object.keys(b).every(k=>keys.includes(k));
const badId=(b:Record<string,unknown>)=>typeof b.id!=='string'||!b.id||b.id.length>100;
function attach(res:Response,value:string){res.headers.append('set-cookie',value);return res;}
export function labAssistantApi(c:ApiContext):Promise<Response>|null {
  const owner=c.path.startsWith(OWNER), action=c.path.slice((owner?OWNER:PREFIX).length);
  if (!(owner?owners:names).includes(action) || !(c.path.startsWith(owner?OWNER:PREFIX))) return null;
  return route(c,owner,action);
}
async function route(c:ApiContext,owner:boolean,action:string):Promise<Response>{
  if(c.req.method!=='POST')return c.json({error:'method not allowed'},405);
  const origin=c.req.headers.get('origin');
  // Cookie/browser requests require exact origin; a direct header credential may use CLI without Origin.
  const direct=c.req.headers.has('x-lab-assistant');
  if(owner||action==='session'||!direct){if(origin!==c.env.ORIGIN)return c.json({error:'bad origin'},403);}
  else if(origin!==null&&origin!==c.env.ORIGIN)return c.json({error:'bad origin'},403);
  if(owner&&!c.admin)return c.json({error:'관리 세션이 만료됐습니다.'},401);
  const token=owner||action==='session'?null:credential(c.req);
  if(!owner&&action!=='session'&&action!=='logout'&&!token)return c.json({error:'조교 연결이 필요합니다.'},401);
  const b=await read(c.req,owner&&action==='issue'?80000:10000);
  if(typeof b==='number')return c.json({error:b===413?'요청 본문이 너무 큽니다.':'요청 형식이 올바르지 않습니다.'},b);
  if(owner){
    if(badId(b))return c.json({error:'모임 ID가 올바르지 않습니다.'},400);
    if(action==='issue'){
      if(!only(b,['id','label','seats','scopes','minutes','templates']))return c.json({error:'알 수 없는 권한 설정입니다.'},400);
      return c.out(await c.state.labAssistantIssue(c.admin,b));
    }
    if(!only(b,action==='revoke'?['id','grantId']:['id']))return c.json({error:'알 수 없는 항목입니다.'},400);
    if(action==='revoke')return c.out(await c.state.labAssistantRevoke(c.admin,b.id as string,b.grantId));
    if(action==='audit')return c.out(await c.state.labAssistantAudit(c.admin,b.id as string));
    return c.out(await c.state.labAssistantList(c.admin,b.id as string));
  }
  if(action==='logout'){
    if(!only(b,[]))return c.json({error:'빈 본문을 사용하세요.'},400);
    return attach(c.json({ok:true}),cookie('',0));
  }
  if(action==='session'){
    if(!only(b,['token'])||typeof b.token!=='string'||!TOKEN.test(b.token))return c.json({error:'조교 연결 코드가 올바르지 않습니다.'},400);
    const r=await c.state.labAssistantSession(b.token);
    if('error' in r)return c.out(r);
    return attach(c.json(r),cookie(b.token,Math.max(0,Math.floor((r.grant.expiresAt-Date.now())/1000))));
  }
  const t=token!;
  let result:unknown;
  if(action==='status'){
    if(!only(b,[]))return c.json({error:'빈 본문을 사용하세요.'},400);
    result=await c.state.labAssistantStatus(t);
  }else{
    if(badId(b))return c.json({error:'모임 ID가 올바르지 않습니다.'},400);
    const id=b.id as string;
    const payload={...b};delete payload.id;
    if(action==='questions'){
      if(!only(b,['id']))return c.json({error:'알 수 없는 항목입니다.'},400);
      result=await c.state.labAssistantQuestions(t,id);
    }else if(action==='reply'){
      if(!only(b,['id','requestId','questionId','text']))return c.json({error:'알 수 없는 항목입니다.'},400);
      result=await c.state.labAssistantReply(t,id,payload);
    }else if(action==='template'){
      if(!only(b,['id','requestId','templateId','n']))return c.json({error:'승인된 요청문 ID와 자리만 전달하세요.'},400);
      result=await c.state.labAssistantTemplate(t,id,payload);
    }else{
      if(!only(b,['id','requestId','reason']))return c.json({error:'알 수 없는 항목입니다.'},400);
      result=await c.state.labAssistantPause(t,id,payload);
    }
  }
  const res=c.out(result);
  if(res.status===401||res.status===403||res.status===410)attach(res,cookie('',0));
  return res;
}
