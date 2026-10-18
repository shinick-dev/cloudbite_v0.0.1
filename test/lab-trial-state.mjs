// Independent coordinator acceptance: real State/API and recorded external effects.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
async function bundle(entry) {
  const out=await build({entryPoints:[entry],bundle:true,write:false,platform:'node',format:'esm',external:['cloudflare:workers'],logLevel:'silent'});
  const code=out.outputFiles[0].text.replace(/import\s*\{\s*DurableObject\s*\}\s*from\s*["']cloudflare:workers["'];?/, 'class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env;}}');
  return import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
}
const S=await bundle('src/state.ts'), A=await bundle('src/lab-trial-api.ts');
const uuid=n=>`20000000-0000-4000-8000-${n.toString(16).padStart(12,'0')}`;
function memory(){const data=new Map(),copy=x=>x===undefined?x:structuredClone(x);let lock=Promise.resolve();const s={data,
  async get(k){if(s.beforeGet)await s.beforeGet(k);return Array.isArray(k)?new Map(k.filter(x=>data.has(x)).map(x=>[x,copy(data.get(x))])):copy(data.get(k));},
  async put(k,v){if(typeof k==='object')for(const[a,b]of Object.entries(k))data.set(a,copy(b));else data.set(k,copy(v));},
  async delete(k){for(const x of Array.isArray(k)?k:[k])data.delete(x);},async list({prefix='',limit=Infinity}={}){return new Map([...data].filter(([k])=>k.startsWith(prefix)).slice(0,limit).map(([k,v])=>[k,copy(v)]));},
  async getAlarm(){return null;},async setAlarm(){},transaction(fn){const p=lock.then(()=>fn(s));lock=p.catch(()=>{});return p;}};return s;}
async function world(){const storage=memory(),effects=[],deletes=[];let waiting=false,release,blockSandbox,providerBlock,effectHook;
  class Fixture extends S.State{async daytona(){if(providerBlock){const p=providerBlock;providerBlock=null;waiting=true;await p;}return{api:'https://daytona.invalid',key:'fixture'};}}
  const env={ORIGIN:'https://admin.invalid',LAB_ORIGIN:'https://lab.invalid',LAB_SEAT_DOMAIN:'seat.invalid'};
  const fresh=()=>new Fixture({storage,waitUntil(){},blockConcurrencyWhile:f=>f()},env),state=fresh();
  const config={snapshot:'v5',model:'fixture',cpu:1,memory:2,disk:3,budget:1,gw:'https://gw.invalid',materials:'https://materials.invalid/m.zip',expiresAt:Date.now()+3600000};
  for(const[id,count]of[['parent',2],['trial',1],['other-trial',1]]){
    const lab={...config,id,name:id,createdAt:Date.now(),seats:Array.from({length:count},(_,i)=>({n:i+1,code:(id+'-'+i).padEnd(16,'x'),sandboxId:id+'-sb-'+i,label:'label-'+id+'-'+i,setup:{state:'ok',at:Date.now(),note:''}}))};
    await storage.put('lab:'+id,lab);for(const seat of lab.seats){await storage.put('seat:'+seat.code,{lab:id,n:seat.n});
      const at=Date.now();await storage.put('labprep:'+seat.code,{ref:{labId:id,n:seat.n,code:seat.code,sandboxId:seat.sandboxId},op:crypto.randomUUID(),phase:'ready',created:at,started:at,endedAt:at,deadline:at+300000,due:at,tries:0,editors:0});}
  }
  for(const token of['admin','other'])await storage.put('admin:'+await S.sha(token),{expiresAt:Date.now()+600000});
  globalThis.fetch=async(input,init={})=>{const u=new URL(input),method=init.method??'GET';
    if(u.host==='daytona.invalid'&&u.pathname.startsWith('/sandbox/')){
      if(method==='DELETE'){deletes.push(u.pathname);return Response.json({});}
      if(blockSandbox===u.pathname.split('/')[2]){waiting=true;await new Promise(r=>release=r);blockSandbox=null;}
      return Response.json({id:u.pathname.split('/')[2],state:'started',toolboxProxyUrl:'https://toolbox.invalid'});
    }
    if(u.host==='daytona.invalid'&&u.pathname==='/sandbox')return Response.json({items:[]});
    if(u.host==='toolbox.invalid'&&method==='POST'){
      const command=JSON.parse(init.body).command,encoded=command.match(/Buffer.from\("([^"]+)"/),script=encoded?Buffer.from(encoded[1],'base64').toString():command;
      effects.push({sandbox:u.pathname.split('/')[1],script});
      if(effectHook)await effectHook(script);
      return Response.json({exitCode:0,result:script.includes('has-session')?'READY':script.includes('capture-pane')?'trial output kvt_secret sk-or-v1-key':script.includes('healthz')?'200':'SENT'});
    }
    throw Error('fixture rejected network '+u.href);
  };
  return{storage,state,fresh,env,effects,deletes,async lab(id='parent'){return storage.get('lab:'+id);},
    set onEffect(fn){effectHook=fn;},block(sb){blockSandbox=sb;waiting=false;},blockProvider(){waiting=false;providerBlock=new Promise(r=>release=r);},async untilHeld(){const end=Date.now()+2000;while(!waiting&&Date.now()<end)await new Promise(r=>setTimeout(r,2));assert.ok(waiting,'reached held external lookup');},release(){release();},
    async start(){const r=await state.labTerminalStart('admin','parent',uuid(1),[1,2],0);assert.equal(r.active,true);return uuid(1);},
    async preview(command='pwd',options={ackWithoutTrial:true}){const r=await state.labPreviewPrepare('admin','parent',crypto.randomUUID(),command,options);assert.ok(!r.error,JSON.stringify(r));return r;},
    async bind(){const r=await state.labTrialBind('admin','parent','trial',uuid(10));assert.equal(r.trialId,'trial',JSON.stringify(r));return r;}};
}
let passed=0;async function test(name,fn){await fn();passed++;console.log('ok',name);}
await test('public broadcasts require a preview and explicit trial waiver',async()=>{
  const w=await world(),sid=await w.start(),before=w.effects.length;
  assert.equal((await w.state.labTerminalSend('admin','parent',sid,uuid(2),'pwd',0)).status,400);
  assert.equal((await w.state.labPreviewPrepare('admin','parent',uuid(3),'pwd',{})).status,400);
  assert.equal(w.effects.length,before);
  const p=await w.preview();assert.deepEqual(p.targets,[1,2]);assert.equal(p.tested,false);
  const sent=await w.state.labTerminalSend('admin','parent',sid,uuid(2),'pwd',0,p.previewId);assert.ok(sent.results.every(x=>x.status==='sent'));
});
await test('exact command and operation identity are bound to one preview',async()=>{
  const w=await world(),sid=await w.start(),p=await w.preview(),before=w.effects.length;
  assert.equal((await w.state.labTerminalSend('admin','parent',sid,uuid(2),'pwd ',0,p.previewId)).status,409);assert.equal(w.effects.length,before);
  await w.state.labTerminalSend('admin','parent',sid,uuid(2),'pwd',0,p.previewId);
  assert.equal((await w.state.labTerminalSend('admin','parent',sid,uuid(3),'pwd',0,p.previewId)).status,409);
  const count=w.effects.length;await w.state.labControlPause('admin','parent',uuid(20));
  const r=await w.fresh().labTerminalSend('admin','parent',sid,uuid(2),'pwd');assert.ok(!r.error);assert.equal(w.effects.length,count);
});
for(const reason of['other selected sandbox','materials','seat preparation failed','owner','expired preview'])await test('final send fence rejects changed '+reason,async()=>{
  const w=await world(),sid=await w.start(),p=await w.preview(),before=w.effects.length;w.block('parent-sb-0');
  const sending=w.state.labTerminalSend('admin','parent',sid,uuid(2),'pwd',0,p.previewId);await w.untilHeld();
  if(reason==='owner')await w.state.labTerminalTakeover('other','parent',sid);
  else if(reason==='expired preview'){
    // The approved copy lives in the in-flight request; advance the clock, not a mutable receipt.
    const original=Date.now;Date.now=()=>original()+301000;
    try{w.release();await sending;}finally{Date.now=original;}
    assert.equal(w.effects.length,before);return;
  }else{const lab=await w.lab();if(reason==='materials')lab.materials+='changed';else if(reason==='seat preparation failed')lab.seats[1].setup={state:'error',note:'failed',at:Date.now()};else lab.seats[1].sandboxId='replacement';await w.storage.put('lab:parent',lab);}
  w.release();await sending;assert.equal(w.effects.length,before);
});
await test('binding isolates the trial from invitations, entry and ordinary terminal starts',async()=>{
  const w=await world(),b=await w.bind(),lab=await w.lab('trial');
  assert.equal((await w.state.labInvite('admin','trial')).status,409);
  assert.equal((await w.state.labSeatInfo(lab.seats[0].code)).status,403);
  assert.equal((await w.state.labJoin(lab.seats[0].code,'participant')).status,403);
  assert.equal((await w.state.labTerminalStart('admin','trial',b.sessionId,[1],0)).status,409);
  assert.equal(w.effects.length,0);
});
await test('read-only participant monitoring excludes reserved trial rooms',async()=>{
  const w=await world();await w.bind();const token='t'.repeat(32);
  await w.storage.put('teacher:'+await S.sha(token),{createdAt:Date.now(),expiresAt:Date.now()+3600000});
  const view=await w.state.teacherStatus(token);assert.ok(view.labs.some(l=>l.id==='parent'));assert.ok(!view.labs.some(l=>l.id==='trial'));
  assert.equal(w.effects.length,0);
});
await test('a participant join that started before reservation cannot finish entering afterward',async()=>{
  const w=await world(),lab=await w.lab('trial');w.blockProvider();
  const joining=w.state.labJoin(lab.seats[0].code);await w.untilHeld();await w.bind();w.release();
  const joined=await joining;assert.ok(joined.error,JSON.stringify(joined));assert.ok(!(await w.lab('trial')).seats[0].opened);
});
await test('a normal terminal start waiting before session storage cannot take a newly reserved trial',async()=>{
  const w=await world(),key='admin:'+await S.sha('admin');let reads=0,waiting=false,release;
  w.storage.beforeGet=async k=>{if(k===key&&++reads===3){waiting=true;await new Promise(r=>release=r);}};
  const starting=w.state.labTerminalStart('admin','trial',uuid(50),[1],0);
  const end=Date.now()+1500;while(!waiting&&Date.now()<end)await new Promise(r=>setTimeout(r,2));assert.ok(waiting);
  await w.bind();release();const result=await starting;assert.equal(result.status,409);assert.equal(w.effects.length,0);
  assert.ok(!await w.storage.get('labterm:trial:session:'+uuid(50)));
});
for(const used of['opened','named','terminal history'])await test('a room already used by a participant is not eligible: '+used,async()=>{
  const w=await world(),lab=await w.lab('trial');
  if(used==='opened')lab.seats[0].opened=Date.now();if(used==='named')lab.seats[0].who='participant';
  await w.storage.put('lab:trial',lab);if(used==='terminal history')await w.storage.put('labterm:trial:session:'+uuid(99),{});
  assert.equal((await w.state.labTrialBind('admin','parent','trial',uuid(10))).status,409);assert.equal(w.effects.length,0);
});
await test('actual server readiness permits rooms without materials and rejects setup-only readiness',async()=>{
  const w=await world();for(const id of['parent','trial']){const lab=await w.lab(id);delete lab.materials;delete lab.seats[0].setup;await w.storage.put('lab:'+id,lab);}
  await w.bind();
  const z=await world(),lab=await z.lab('trial');await z.storage.delete('labprep:'+lab.seats[0].code);
  assert.equal((await z.state.labTrialBind('admin','parent','trial',uuid(10))).status,409);
});
await test('trial delivery is isolated, remains possible during parent pause, and provides a matching proof',async()=>{
  const w=await world();await w.bind();await w.start();await w.state.labControlPause('admin','parent',uuid(20));w.effects.length=0;
  const run=await w.state.labTrialRun('admin','parent',uuid(11),'echo trial');assert.equal(run.delivery,'sent',JSON.stringify(run));
  assert.deepEqual(w.effects.map(x=>x.sandbox),['trial-sb-0','trial-sb-0']);
  const p=await w.preview('echo trial',{trialRunId:run.runId});assert.equal(p.tested,true);
  assert.equal((await w.state.labPreviewPrepare('admin','parent',uuid(13),'different',{trialRunId:run.runId})).status,409);
  const count=w.effects.length;const replay=await w.fresh().labTrialRun('admin','parent',uuid(11),'echo trial');assert.equal(replay.delivery,'sent');assert.equal(w.effects.length,count);
  const output=await w.state.labTrialOutput('other','parent');assert.match(output.output,/trial output/);assert.ok(!output.output.includes('kvt_secret'));assert.ok(!output.output.includes('sk-or-v1-key'));
});
await test('trial pending after State reconstruction cannot trigger a duplicate effect',async()=>{
  const w=await world();await w.bind();w.block('trial-sb-0');const running=w.state.labTrialRun('admin','parent',uuid(11),'pwd');await w.untilHeld();
  const before=w.effects.length,r=await w.fresh().labTrialRun('admin','parent',uuid(11),'pwd');assert.equal(r.delivery,'unknown');assert.equal(w.effects.length,before);
  w.release();await running;
});
await test('lost final authority after accepted trial input is unknown rather than a claim of non-execution',async()=>{
  const w=await world();await w.bind();w.onEffect=async script=>{if(script.includes('send-keys'))await w.storage.delete('admin:'+await S.sha('admin'));};
  const run=await w.state.labTrialRun('admin','parent',uuid(11),'pwd');assert.equal(run.delivery,'unknown');const count=w.effects.length;
  await w.storage.put('admin:'+await S.sha('admin'),{expiresAt:Date.now()+600000});
  assert.equal((await w.fresh().labTrialRun('admin','parent',uuid(11),'pwd')).delivery,'unknown');assert.equal(w.effects.length,count);
});
await test('ending a parent fences a held trial operation and cleans up its reserved room',async()=>{
  const w=await world();await w.bind();w.block('trial-sb-0');const running=w.state.labTrialRun('admin','parent',uuid(11),'pwd');await w.untilHeld();
  const ending=w.state.labEnd('admin','parent');w.release();await Promise.all([running,ending]);assert.equal(w.effects.length,0);
  assert.ok(w.deletes.some(x=>x.includes('trial-sb-0')));assert.ok(!await w.lab('trial'));
});
await test('changing both trial and parent configuration after claim still blocks late effects',async()=>{
  const w=await world();await w.bind();w.block('trial-sb-0');const running=w.state.labTrialRun('admin','parent',uuid(11),'pwd');await w.untilHeld();
  for(const id of['parent','trial']){const lab=await w.lab(id);lab.model='changed';await w.storage.put('lab:'+id,lab);}
  w.release();await running;assert.equal(w.effects.length,0);
});
await test('fresh preview is rechecked after pause and resume; no implicit broadcast follows a trial',async()=>{
  const w=await world();await w.bind();const sid=await w.start();await w.state.labTrialRun('admin','parent',uuid(11),'pwd');const p=await w.preview('pwd',{trialRunId:uuid(11)}),before=w.effects.length;
  const paused=await w.state.labControlPause('admin','parent',uuid(20));const resumed=await w.state.labControlResume('admin','parent',uuid(21),paused.revision);assert.equal(w.effects.length,before);
  const stale=await w.state.labTerminalSend('admin','parent',sid,uuid(2),'pwd',0,p.previewId);assert.equal(stale.code,'control_revision_changed');assert.equal(w.effects.length,before);
  const sent=await w.state.labTerminalSend('admin','parent',sid,uuid(2),'pwd',resumed.revision,p.previewId);assert.ok(sent.results.every(x=>x.status==='sent'));
});
await test('new API requires same-origin admin POST, bounded JSON, and never passes arbitrary fields',async()=>{
  const w=await world(),calls=[],state=new Proxy({},{get:(_,name)=>async(...args)=>{calls.push({name,args});return{ok:true};}});
  const call=(path,body='{}',origin=w.env.ORIGIN,admin='admin',method='POST')=>A.labTrialApi({path,env:w.env,state,admin,json:(x,status=200)=>Response.json(x,{status}),out:r=>Response.json(r),req:new Request(w.env.ORIGIN+path,{method,headers:{origin},...(method==='POST'?{body}:{})})});
  for(const path of['/api/lab/trial/status','/api/lab/trial/bind','/api/lab/trial/run','/api/lab/trial/output','/api/lab/preview']){
    assert.equal((await call(path,'{}',w.env.ORIGIN,'')).status,401);assert.equal((await call(path,'{}','https://other.invalid')).status,403);assert.equal((await call(path,'x'.repeat(32769))).status,413);assert.equal((await call(path,'[]')).status,400);assert.equal((await call(path,'{}',w.env.ORIGIN,'admin','GET')).status,405);
  }
  assert.equal(calls.length,0);await call('/api/lab/preview',JSON.stringify({id:'parent',requestId:uuid(7),command:'pwd',ackWithoutTrial:true,evil:'ignored'}));assert.equal(calls.length,1);assert.equal(calls[0].args.length,5);assert.ok(!JSON.stringify(calls).includes('evil'));
});
console.log(`${passed} trial/preview State/API acceptance scenarios passed`);
