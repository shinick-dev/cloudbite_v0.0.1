import type { ApiContext } from './api-context';
const paths = ['/api/lab/trial/status','/api/lab/trial/bind','/api/lab/trial/run','/api/lab/trial/output','/api/lab/preview'];
export function labTrialApi(c: ApiContext): Promise<Response> | null { return paths.includes(c.path) ? route(c) : null; }
async function route(c: ApiContext): Promise<Response> {
  if (c.req.method !== 'POST') return c.json({error:'method not allowed'},405);
  if (!c.admin) return c.json({error:'관리 세션이 만료됐습니다.'},401);
  if (c.req.headers.get('origin') !== c.env.ORIGIN) return c.json({error:'bad origin'},403);
  if (Number(c.req.headers.get('content-length')??0)>32768) return c.json({error:'요청이 너무 큽니다.'},413);
  const reader=c.req.body?.getReader();let x:Record<string,unknown>;
  try {
    const chunks:Uint8Array[]=[];let size=0;
    if(reader)for(;;){const{done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>32768){void reader.cancel().catch(()=>{});return c.json({error:'요청이 너무 큽니다.'},413)}chunks.push(value)}
    const all=new Uint8Array(size);let offset=0;for(const part of chunks){all.set(part,offset);offset+=part.byteLength}
    const body:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(all));
    if(!body||typeof body!=='object'||Array.isArray(body))return c.json({error:'요청 형식이 올바르지 않습니다.'},400);
    x=body as Record<string,unknown>;if(typeof x.id!=='string'||!x.id||x.id.length>100)return c.json({error:'실습실 ID가 올바르지 않습니다.'},400);
  }catch{return c.json({error:'요청 형식이 올바르지 않습니다.'},400)}finally{reader?.releaseLock()}
  try {
    const id=x.id as string;
    switch(c.path){
      case '/api/lab/trial/status': return c.out(await c.state.labTrialStatus(c.admin,id));
      case '/api/lab/trial/bind': return c.out(await c.state.labTrialBind(c.admin,id,x.trialId,x.requestId));
      case '/api/lab/trial/run': return c.out(await c.state.labTrialRun(c.admin,id,x.requestId,x.command));
      case '/api/lab/trial/output': return c.out(await c.state.labTrialOutput(c.admin,id));
      default:return c.out(await c.state.labPreviewPrepare(c.admin,id,x.requestId,x.command,{trialRunId:x.trialRunId,ackWithoutTrial:x.ackWithoutTrial}));
    }
  }catch{return c.json({error:'시험·전달 확인 결과를 확인하지 못했습니다. 같은 요청으로 다시 확인하세요.'},503)}
}
