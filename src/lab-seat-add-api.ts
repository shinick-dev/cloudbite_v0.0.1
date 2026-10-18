import type { ApiContext } from './api-context';
export function labSeatAddApi(c: ApiContext): Promise<Response> | null {
  return c.path==='/api/lab/seat-add'||c.path==='/api/lab/seat-add/status'?handle(c):null;
}
async function handle(c: ApiContext) {
  if(c.req.method!=='POST')return c.json({error:'method not allowed'},405);
  if(c.req.headers.get('origin')!==c.env.ORIGIN)return c.json({error:'bad origin'},403);
  if(!c.admin)return c.json({error:'관리 세션이 만료됐습니다.'},401);
  if(Number(c.req.headers.get('content-length')??0)>512)return c.json({error:'본문이 너무 큽니다.'},413);
  const reader=c.req.body?.getReader();const parts:Uint8Array[]=[];let size=0,input:unknown;
  try{
    if(reader)for(;;){const p=await reader.read();if(p.done)break;size+=p.value.byteLength;if(size>512){void reader.cancel().catch(()=>{});return c.json({error:'본문이 너무 큽니다.'},413)}parts.push(p.value)}
    const all=new Uint8Array(size);let at=0;for(const p of parts){all.set(p,at);at+=p.byteLength}
    input=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(all));
  }catch{return c.json({error:'좌석 추가 입력을 확인하세요.'},400)}finally{reader?.releaseLock()}
  try{
    const value=c.path.endsWith('/status')?await c.state.labSeatAddStatus(c.admin,input):await c.state.labSeatAdd(c.admin,input);
    return value&&'creationState' in value&&['preparing','running','unknown'].includes(String(value.creationState))?c.json(value,202):c.out(value);
  }catch{return c.json({error:'좌석 추가 결과를 확인하지 못했습니다. 같은 요청의 결과를 확인하세요.'},503)}
}
