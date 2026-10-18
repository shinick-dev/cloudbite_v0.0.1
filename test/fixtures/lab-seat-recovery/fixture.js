// Local workerd/SQLite only. This fixture is never imported by production entrypoints.
export function makeFixture(Base, sha) {
  const effects=[];let release=null,held=false,loseCreate=false;
  globalThis.fetch=async(input,init={})=>{
    const u=new URL(typeof input==='string'?input:input.url),method=init.method??'GET';
    if(u.host==='provider.invalid'&&u.pathname==='/sandbox'&&method==='POST'){
      effects.push({kind:'create'});held=true;
      await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('fixture hold timeout')),30000);release=()=>{clearTimeout(timer);resolve()}});
      if(loseCreate)throw Error('synthetic create response loss');
      return Response.json({id:'new-sandbox',state:'started'});
    }
    if(u.host==='provider.invalid'&&u.pathname.startsWith('/sandbox/')&&method==='GET')return Response.json({id:u.pathname.split('/')[2],state:'started',toolboxProxyUrl:'https://toolbox.invalid'});
    if(u.host==='toolbox.invalid'&&u.pathname.endsWith('/process/execute')){const body=JSON.parse(init.body);if(!body.command.includes('/healthz'))throw Error('unexpected fixture command');effects.push({kind:'health'});return Response.json({exitCode:0,result:'200'})}
    throw Error('fixture rejected network '+method+' '+u.href);
  };
  class State extends Base {
    async daytona(){return{api:'https://provider.invalid',key:'synthetic-provider-key'}}
    async fxSeed(){
      const t=Date.now(),seat={n:1,code:'oldcodexxxxxxxxx',sid:'sid',sandboxId:'old-sandbox',label:'oldlabel',who:'참여자'},lab={id:'lab',name:'night',createdAt:t,expiresAt:t+3600000,budget:1,gw:'https://gw.invalid',snapshot:'v5',model:'fixture',cpu:1,memory:2,disk:3,seats:[seat]};
      const session={id:'sid',lab:'lab',tokenHash:'old-hash',providers:['or'],createdAt:t-1000,expiresAt:lab.expiresAt,budget:1,orProvider:'or',orKey:'synthetic-original-real-key',orKeyHash:'original-real-hash',gens:{or:'gen'},uses:7,counts:{shared:4},calls:[t-1000],leases:{accepted:{exp:t+60000,p:'or',counted:false,at:t-1000}},limits:{total:50,rpm:10,concurrent:5},ip:'fixture',country:'',city:'',ua:'fixture'};
      await this.ctx.storage.put({'lab:lab':lab,'seat:oldcodexxxxxxxxx':{lab:'lab',n:1},'sess:sid':session,'tok:old-hash':'sid',
        ['admin:'+await sha('admin')]:{expiresAt:t+600000},'prov:or':{id:'or',kind:'openrouter-mint',gen:'gen',upstream:'https://openrouter.ai',iv:'synthetic',ct:'synthetic'},
        'prov:daytona':{id:'daytona',gen:'dt-gen',upstream:'https://app.daytona.io/api',iv:'synthetic',ct:'synthetic'}});
      return{lab,session};
    }
    async fxInfo(){return{effects:effects.slice(),held}}
    async fxRelease(){release?.();release=null;held=false;return{ok:true}}
    async fxUnknown(){loseCreate=true;return{ok:true}}
    async fxSpend(){return this.ctx.blockConcurrencyWhile(async()=>{const s=await this.ctx.storage.get('sess:sid');s.uses+=5;s.counts.shared+=2;s.calls.push(Date.now());s.leases.second={exp:Date.now()+60000,p:'or',counted:false,at:Date.now()};await this.ctx.storage.put('sess:sid',s);return s})}
    async fxGet(keys){return Object.fromEntries(await this.ctx.storage.get(keys))}
    async fxReserve(hash){return this.ctx.blockConcurrencyWhile(async()=>{const r=await this.reserveUse(hash,'or','api/v1/key','');return{status:r.error?r.status:200,sid:r.sess?.id}})}
  }
  const allowed=new Set(['fxSeed','fxInfo','fxRelease','fxUnknown','fxSpend','fxGet','fxReserve','labControlPause','labControlResume','labRecoveryContext','labRecoveryCreate','labRecoveryStatus','labRecoveryUnlock']);
  return{State,worker:{async fetch(req,env){const op=new URL(req.url).pathname.slice(1);if(req.method!=='POST'||!allowed.has(op))return new Response('fixture',{status:404});const args=await req.json(),fixtureCase=req.headers.get('x-fixture-case')==='unknown'?'unknown':'main',stub=env.STATE.get(env.STATE.idFromName(fixtureCase));return Response.json(await stub[op](...args))}}};
}
