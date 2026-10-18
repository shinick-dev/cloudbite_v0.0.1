// Local test-only. No external network or real classroom resources.
export function makeAssistantFixture(Base,production,sha){
 globalThis.fetch=async()=>{throw Error('fixture prohibits provider network')};
 class State extends Base{
  async fxSeed(){
   const t=Date.now(),seats=[{n:1,code:'seat000000000001',sid:'sid1',sandboxId:'sb1',label:'a'.repeat(26),who:'가',pv:{origin:'https://editor.invalid',token:'synthetic-preview'}},{n:2,code:'seat000000000002',sid:'sid2',sandboxId:'sb2',label:'b'.repeat(26),who:'나',pv:{origin:'https://editor.invalid',token:'synthetic-preview'}}];
   const lab={id:'lab',name:'조교 시험',createdAt:t,expiresAt:t+3600000,budget:1,gw:'https://gw.invalid',snapshot:'fixture',model:'fixture',cpu:1,memory:2,disk:3,seats};
   await this.ctx.storage.put({'lab:lab':lab,'lab:other':{...lab,id:'other',seats:[]},'seat:seat000000000001':{lab:'lab',n:1},'seat:seat000000000002':{lab:'lab',n:2},
    ['admin:'+await sha('fixture-admin')]:{expiresAt:t+600000,src:'web',createdAt:t}});
   return{ok:true};
  }
  async fxInfo(){return Object.fromEntries(await this.ctx.storage.list())}
  async fxExpire(grantId){const k='labassist:'+grantId,g=await this.ctx.storage.get(k);g.expiresAt=Date.now()-1;await this.ctx.storage.put(k,g);return{ok:true}}
  async fxResume(revision,id){return this.labControlResume('fixture-admin','lab',id,revision)}
  async fxStop(){await this.ctx.storage.put('labassist-stop:lab',Date.now());return{ok:true}}
  async fxClose(){return this.labEnd('fixture-admin','lab')}
  async fxAudit(value){await this.ctx.storage.put('labassist-audit:lab',value);return{ok:true}}
  async fxRotate(){return this.ctx.storage.transaction(async tx=>{const l=await tx.get('lab:lab'),old=l.seats[0].code;l.seats[0].code='newc000000000001';await tx.put({'lab:lab':l,'seat:newc000000000001':{lab:'lab',n:1}});await tx.delete('seat:'+old);return{ok:true}})}
 }
 const allowed=new Set(['fxSeed','fxInfo','fxExpire','fxResume','fxStop','fxClose','fxRotate','fxAudit']);
 return{State,worker:{async fetch(req,env,ctx){
  const u=new URL(req.url),op=u.pathname.slice(1);
  if(allowed.has(op)){const stub=env.STATE.get(env.STATE.idFromName('main'));return Response.json(await stub[op](...await req.json()))}
  u.protocol='https:';u.host=req.headers.get('x-fixture-host')||'admin.invalid';u.port='';const h=new Headers(req.headers);h.delete('x-fixture-host');
  return production.fetch(new Request(u,{method:req.method,headers:h,...(req.method==='GET'||req.method==='HEAD'?{}:{body:req.body})}),env,ctx);
 }}};
}
