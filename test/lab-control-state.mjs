// Coordinator acceptance tests: real State and API, fixture network only.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const bundle = async (entry) => {
  const out = await build({ entryPoints: [entry], bundle: true, write: false, platform: 'node', format: 'esm', external: ['cloudflare:workers'], logLevel: 'silent' });
  const code = out.outputFiles[0].text.replace(/import\s*\{\s*DurableObject\s*\}\s*from\s*["']cloudflare:workers["'];?/, 'class DurableObject { constructor(ctx,env){this.ctx=ctx;this.env=env;} }');
  return import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
};
const S = await bundle('src/state.ts');
const A = await bundle('src/lab-control-api.ts');
const T = await bundle('src/lab-terminal-api.ts');
const id = (n) => `10000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const hold = () => { let release; const promise = new Promise(r => release = r); return { promise, release }; };
const tick = () => new Promise(r => setImmediate(r));
async function until(f) { const end=Date.now()+2000;while(!f()&&Date.now()<end)await new Promise(r=>setTimeout(r,2));assert.ok(f(),'fixture reached awaited external call'); }
async function within(p) { let timer; try { return await Promise.race([p, new Promise((_, reject) => timer = setTimeout(() => reject(Error('pause blocked behind broadcast')), 1500))]); } finally { clearTimeout(timer); } }
function memory() {
  const data = new Map(), copy = x => x === undefined ? x : structuredClone(x); let lock = Promise.resolve();
  const storage = { data,
    async get(k) { if(storage.onGet)await storage.onGet(k); return Array.isArray(k) ? new Map(k.filter(x => data.has(x)).map(x => [x, copy(data.get(x))])) : copy(data.get(k)); },
    async put(k, v) { if (typeof k === 'object') for (const [a,b] of Object.entries(k)) data.set(a,copy(b)); else data.set(k,copy(v)); },
    async delete(k) { for (const x of Array.isArray(k) ? k : [k]) data.delete(x); },
    async list({prefix='',limit=Infinity}={}) { return new Map([...data].filter(([k])=>k.startsWith(prefix)).slice(0,limit).map(([k,v])=>[k,copy(v)])); },
    async getAlarm() { return null; }, async setAlarm() {},
    transaction(fn) { const p=lock.then(()=>fn(storage)); lock=p.catch(()=>{}); return p; },
  }; return storage;
}
async function world() {
  const storage=memory(), effects=[]; let wait=null, waiting=false, phase='lookup';
  class Fixture extends S.State {
    async daytona() { return {api:'https://daytona.invalid',key:'fixture'}; }
    async labTerminalStart(...args) { if(args.length<5)args.push((await this.labControlStatus(args[0],args[1])).revision??0);return super.labTerminalStart(...args); }
    async labTerminalSend(...args) {
      if(args[5]===undefined)args[5]=(await this.labControlStatus(args[0],args[1])).revision??0;
      if(args[6]===undefined&&!await storage.get(`labterm:${args[1]}:op:${args[2]}:${args[3]}`)) {
        const p=await this.labPreviewPrepare(args[0],args[1],crypto.randomUUID(),args[4],{ackWithoutTrial:true});
        if(p.error)return p;args[6]=p.previewId;
      }
      return super.labTerminalSend(...args);
    }
  }
  const context={storage,waitUntil(){},blockConcurrencyWhile:f=>f()}, env={ORIGIN:'https://admin.invalid',LAB_ORIGIN:'https://lab.invalid',LAB_SEAT_DOMAIN:'seat.invalid'};
  const state=new Fixture(context,env), fresh=()=>new Fixture(context,env);
  const lab={id:'lab',name:'acceptance',expiresAt:Date.now()+3600000,budget:1,seats:[1,2,3].map(n=>({n,code:`code${n}xxxxxxxxxxx`,sandboxId:'sb-'+n,label:'s'+n,setup:{state:'ok',at:Date.now(),note:''}}))};
  await storage.put('lab:lab',lab); for(const seat of lab.seats) await storage.put('seat:'+seat.code,{lab:'lab',n:seat.n});
  for(const token of ['admin','other-admin']) await storage.put('admin:'+await S.sha(token),{expiresAt:Date.now()+600000});
  globalThis.fetch=async(input,init={})=>{
    const url=new URL(input), method=init.method||'GET';
    if(url.host==='daytona.invalid'&&url.pathname.startsWith('/sandbox/')) {
      if(method==='DELETE')return Response.json({});
      if(wait&&phase==='lookup'&&!waiting){waiting=true;await wait.promise;}
      return Response.json({id:url.pathname.split('/')[2],state:'started',toolboxProxyUrl:'https://toolbox.invalid'});
    }
    if(url.host==='toolbox.invalid'&&method==='POST') {
      effects.push(url.pathname); const command=JSON.parse(init.body).command;
      const source=Buffer.from(command.match(/Buffer.from\("([^"]+)"/)[1],'base64').toString();
      if(wait&&phase==='execute'&&!waiting){waiting=true;await wait.promise;}
      return Response.json({exitCode:0,result:source.includes('has-session')?'READY':'SENT'});
    }
    throw Error('unapproved fixture network '+url.href);
  };
  return {state,fresh,storage,lab,effects,env,block(at){wait=hold();phase=at;waiting=false;return wait;},get waiting(){return waiting;}};
}
let passed=0,failed=0; async function test(name,fn){try{await fn();passed++;console.log('ok',name)}catch(e){failed++;console.error('FAIL',name,e.message)}}
const denied = value => assert.ok(value&&typeof value.error==='string'&&value.status>=400, JSON.stringify(value));
await test('pause survives State reconstruction; fresh start and send are denied',async()=>{
  const w=await world(), sid=id(1); await w.state.labTerminalStart('admin','lab',sid,[1]);
  const p=await w.state.labControlPause('admin','lab',id(10)); assert.equal(p.mode,'paused');
  const fresh=w.fresh(); assert.equal((await fresh.labControlStatus('admin','lab')).mode,'paused'); const before=w.effects.length;
  denied(await fresh.labTerminalSend('admin','lab',sid,id(2),'pwd'));
  denied(await fresh.labTerminalStart('admin','lab',id(3),[2])); assert.equal(w.effects.length,before);
});
await test('pause while preparation is awaiting lookup fences it even after resume',async()=>{
  const w=await world(), blocker=w.block('lookup'); const running=w.state.labTerminalStart('admin','lab',id(1),[1,2,3]);
  await until(()=>w.waiting); const p=await within(w.state.labControlPause('other-admin','lab',id(10)));
  const r=await w.state.labControlResume('other-admin','lab',id(11),p.revision); assert.equal(r.mode,'running');
  blocker.release(); await running; assert.equal(w.effects.length,0);
});
await test('pause and resume never revive a send already accepted for the first seat',async()=>{
  const w=await world(),sid=id(1); await w.state.labTerminalStart('admin','lab',sid,[1,2,3]); w.effects.length=0;
  const blocker=w.block('execute'), running=w.state.labTerminalSend('admin','lab',sid,id(2),'pwd'); await until(()=>w.waiting);
  const p=await within(w.state.labControlPause('other-admin','lab',id(10)));
  await w.state.labControlResume('other-admin','lab',id(11),p.revision); blocker.release(); await running;
  assert.deepEqual(w.effects,['/sb-1/process/execute']);
  await w.state.labTerminalSend('admin','lab',sid,id(3),'pwd'); assert.equal(w.effects.length,4,'new operation explicitly sent after resume can reach all seats');
});
await test('recorded request can be checked while paused without re-execution',async()=>{
  const w=await world(),sid=id(1); await w.state.labTerminalStart('admin','lab',sid,[1]);
  const sent=await w.state.labTerminalSend('admin','lab',sid,id(2),'pwd'); await w.state.labControlPause('admin','lab',id(10)); const before=w.effects.length;
  const replay=await w.state.labTerminalSend('admin','lab',sid,id(2),'pwd'); assert.ok(!replay.error); assert.deepEqual(replay.results,sent.results); assert.equal(w.effects.length,before);
});
await test('stale second tab cannot resume against a newer revision',async()=>{
  const w=await world(),p=await w.state.labControlPause('admin','lab',id(10));
  const r=await w.state.labControlResume('admin','lab',id(11),p.revision); assert.equal(r.mode,'running');
  const stale=await w.state.labControlResume('other-admin','lab',id(12),p.revision); assert.equal(stale.status,409);
  const current=await w.state.labControlStatus('admin','lab'); assert.equal(current.revision,r.revision);
});
for(const kind of ['start','send'])await test('client revision fences '+kind+' delayed before server admission',async()=>{
  const w=await world(),sid=id(1);if(kind==='send')await w.state.labTerminalStart('admin','lab',sid,[1,2,3]);
  const preview=kind==='send'?await w.state.labPreviewPrepare('admin','lab',crypto.randomUUID(),'pwd',{ackWithoutTrial:true}):null;
  const before=w.effects.length,blocker=hold(),adminKey='admin:'+await S.sha('admin');let waiting=false;
  w.storage.onGet=async k=>{if(k===adminKey&&!waiting){waiting=true;await blocker.promise}};
  const p=kind==='send'?S.State.prototype.labTerminalSend.call(w.state,'admin','lab',sid,id(2),'pwd',0,preview.previewId):w.state.labTerminalStart('admin','lab',sid,[1,2,3],0);
  await until(()=>waiting);const paused=await w.state.labControlPause('other-admin','lab',id(10));
  await w.state.labControlResume('other-admin','lab',id(11),paused.revision);blocker.release();const result=await p;
  assert.equal(w.effects.length,before);assert.equal(result.code,'control_revision_changed');
});
await test('missing client revision denies fresh effects but permits stored result reads',async()=>{
  const w=await world(),sid=id(1);
  assert.equal((await S.State.prototype.labTerminalStart.call(w.state,'admin','lab',sid,[1])).status,400);
  await w.state.labTerminalStart('admin','lab',sid,[1]);
  assert.equal((await S.State.prototype.labTerminalSend.call(w.state,'admin','lab',sid,id(2),'pwd')).status,400);
  const sent=await w.state.labTerminalSend('admin','lab',sid,id(2),'pwd');await w.state.labControlPause('admin','lab',id(10));const before=w.effects.length;
  const replay=await S.State.prototype.labTerminalSend.call(w.state,'admin','lab',sid,id(2),'pwd');assert.deepEqual(replay.results,sent.results);assert.equal(w.effects.length,before);
});
await test('revoked admin during final lab lookup cannot commit a pause',async()=>{
  const w=await world(),blocker=hold();let reads=0,waiting=false;
  w.storage.onGet=async k=>{if(k==='lab:lab'&&++reads===2){waiting=true;await blocker.promise}};
  const request=w.state.labControlPause('admin','lab',id(10));await until(()=>waiting);
  await w.storage.delete('admin:'+await S.sha('admin'));blocker.release();
  const r=await request;assert.equal(r.status,401);assert.equal((await w.state.labControlStatus('other-admin','lab')).mode,'running');
});
await test('a fresh pause while already paused fences an older pending resume',async()=>{
  const w=await world(),first=await w.state.labControlPause('admin','lab',id(10));
  const second=await w.state.labControlPause('other-admin','lab',id(11)); assert.ok(second.revision>first.revision);
  const oldResume=await w.state.labControlResume('admin','lab',id(12),first.revision); assert.equal(oldResume.status,409);
  assert.equal((await w.state.labControlStatus('admin','lab')).mode,'paused');
});
await test('expiry and classroom end dominate pause/resume',async()=>{
  const w=await world(),p=await w.state.labControlPause('admin','lab',id(10)); w.lab.expiresAt=Date.now()-1; await w.storage.put('lab:lab',w.lab);
  denied(await w.state.labControlResume('admin','lab',id(11),p.revision));
  const z=await world(),q=await z.state.labControlPause('admin','lab',id(10)); await z.state.endLab(z.lab,'end');
  denied(await z.fresh().labControlResume('admin','lab',id(11),q.revision));
});
await test('API requires explicit admin, same origin and bounded object body',async()=>{
  const w=await world(),base={env:w.env,state:w.state,src:'',json:(j,status=200)=>Response.json(j,{status}),out:r=>r&&'error'in r?Response.json({error:r.error},{status:r.status}):Response.json(r)};
  const call=(name,body,headers={},admin='admin')=>{const path='/api/lab/control/'+name;return A.labControlApi({...base,path,admin,req:new Request('https://admin.invalid'+path,{method:'POST',headers:{origin:w.env.ORIGIN,...headers},body})});};
  for(const name of ['status','pause','resume']) {
    assert.equal((await call(name,'{}',{cookie:'teacher=fixture; student=fixture'},'')).status,401);
    assert.equal((await call(name,'{}',{origin:'https://other.invalid'})).status,403);
    assert.equal((await call(name,' '.repeat(32769))).status,413);
    assert.equal((await call(name,'[]')).status,400);
  }
  const response=await call('pause',JSON.stringify({id:'lab',requestId:id(10)})); assert.equal(response.status,200); assert.equal((await response.json()).mode,'paused');
});
await test('terminal HTTP response preserves the stale-control rejection code',async()=>{
  const w=await world(),sid=id(1);await w.state.labTerminalStart('admin','lab',sid,[1]);
  const p=await w.state.labControlPause('admin','lab',id(10));await w.state.labControlResume('admin','lab',id(11),p.revision);const before=w.effects.length;
  const path='/api/lab/terminal/send';const response=await T.labTerminalApi({path,env:w.env,state:w.state,admin:'admin',src:'',json:(j,status=200)=>Response.json(j,{status}),out:r=>r&&'error'in r?Response.json({error:r.error},{status:r.status}):Response.json(r),req:new Request('https://admin.invalid'+path,{method:'POST',headers:{origin:w.env.ORIGIN},body:JSON.stringify({id:'lab',sessionId:sid,requestId:id(2),command:'pwd',expectedControlRevision:0})})});
  assert.equal(response.status,409);assert.equal((await response.json()).code,'control_revision_changed');assert.equal(w.effects.length,before);
});
console.log(`${passed} classroom control State/API acceptance scenarios passed; ${failed} failed`);
if(failed)process.exitCode=1;
