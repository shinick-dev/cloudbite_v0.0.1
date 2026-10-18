// State의 실제 인증·자리·종료 경계와 API를 mock 외부망으로 검증. 진짜 키/샌드박스 사용 안 함.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const stub={name:'cloudflare-stub',setup(b){b.onResolve({filter:/^cloudflare:workers$/},()=>({path:'cf',namespace:'cf-stub'}));b.onLoad({filter:/.*/,namespace:'cf-stub'},()=>({contents:'export class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env}}',loader:'js'}));}};
const b=await build({entryPoints:['src/state.ts'],bundle:true,write:false,platform:'node',format:'esm',loader:{'.ps1':'text'},plugins:[stub],logLevel:'silent'});
const S=await import('data:text/javascript;base64,'+Buffer.from(b.outputFiles[0].text).toString('base64'));
const ab=await build({entryPoints:['src/lab-terminal-api.ts'],bundle:true,write:false,platform:'node',format:'esm',logLevel:'silent'});
const A=await import('data:text/javascript;base64,'+Buffer.from(ab.outputFiles[0].text).toString('base64'));
const uuid=(n)=>`00000000-0000-4000-8000-${n.toString(16).padStart(12,'0')}`;
const hold=()=>{let release;const p=new Promise(r=>release=r);return{p,release}};
const tick=()=>new Promise(r=>setImmediate(r));
async function until(f){const end=Date.now()+1500;while(!f()&&Date.now()<end)await new Promise(r=>setTimeout(r,2));assert.ok(f(),'request reached held external call');}
function memory(){const data=new Map(),copy=x=>x===undefined?x:structuredClone(x);let lock=Promise.resolve();const s={data,
async get(k){if(Array.isArray(k))return new Map(k.filter(x=>data.has(x)).map(x=>[x,copy(data.get(x))]));return copy(data.get(k));},
async put(k,v){if(typeof k==='object')for(const [a,b]of Object.entries(k))data.set(a,copy(b));else data.set(k,copy(v));},async delete(k){for(const x of Array.isArray(k)?k:[k])data.delete(x);},
async list({prefix='',limit=Infinity}={}){return new Map([...data].filter(([k])=>k.startsWith(prefix)).slice(0,limit).map(([k,v])=>[k,copy(v)]));},async getAlarm(){return null},async setAlarm(){},
transaction(fn){const p=lock.then(()=>fn(s));lock=p.catch(()=>{});return p;}};return s;}
async function world(){const storage=memory();let remoteHold=null,held=false,providerHold=null,providerHeld=false;const calls=[],all=[];
class Fixture extends S.State{async daytona(){if(providerHold){providerHeld=true;await providerHold.p;}return {api:'https://dt.invalid',key:'fixture'};}
async labTerminalStart(...args){if(args.length<5)args.push(0);return super.labTerminalStart(...args)}
async labTerminalSend(...args){if(args[5]===undefined)args[5]=0;
if(args[6]===undefined&&!await storage.get(`labterm:${args[1]}:op:${args[2]}:${args[3]}`)){
const p=await this.labPreviewPrepare(args[0],args[1],crypto.randomUUID(),args[4],{ackWithoutTrial:true});if(p.error)return p;args[6]=p.previewId;}
return super.labTerminalSend(...args)}}
const state=new Fixture({storage,waitUntil(){},blockConcurrencyWhile:f=>f()},{ORIGIN:'https://admin.invalid',LAB_ORIGIN:'https://lab.invalid',LAB_SEAT_DOMAIN:'seat.invalid'});
const lab={id:'lab',name:'모임',expiresAt:Date.now()+3600000,budget:1,seats:[1,2,3].map(n=>({n,code:`code${n}xxxxxxxxxxx`,sandboxId:'sb-'+n,label:'s'+n,setup:{state:'ok',at:Date.now(),note:''}}))};
await storage.put('lab:lab',lab);for(const x of lab.seats)await storage.put('seat:'+x.code,{lab:'lab',n:x.n});
for(const token of ['admin','new-admin'])await storage.put('admin:'+await S.sha(token),{expiresAt:Date.now()+600000});
globalThis.fetch=async(input,init={})=>{const u=new URL(input),method=init.method||'GET';all.push(method+' '+u.href);
 if(u.host==='dt.invalid'&&u.pathname.startsWith('/sandbox/')){if(method==='DELETE')return Response.json({});if(remoteHold){held=true;await remoteHold.p;}return Response.json({id:u.pathname.split('/')[2],state:'started',toolboxProxyUrl:'https://toolbox.invalid'});}
 if(u.host==='toolbox.invalid'&&method==='POST'){const cmd=JSON.parse(init.body).command;calls.push(u.pathname);const source=Buffer.from(cmd.match(/Buffer.from\("([^"]+)"/)[1],'base64').toString();return Response.json({exitCode:0,result:source.includes('has-session')?'READY':'SENT'});}
 throw Error('unexpected network '+u.href);};
return{storage,state,lab,calls,all,get held(){return held},set remoteHold(v){remoteHold=v},get providerHeld(){return providerHeld},set providerHold(v){providerHold=v}};}
let passed=0;async function test(name,fn){await fn();passed++;console.log('ok',name)}
await test('real State fans out to selected sandboxes only and student status omits credentials',async()=>{const w=await world(),sid=uuid(1);const start=await w.state.labTerminalStart('admin','lab',sid,[1,3]);assert.equal(start.active,true);assert.deepEqual(w.calls,['/sb-1/process/execute','/sb-3/process/execute']);const me=await w.state.labMe(w.lab.seats[0].code);assert.deepEqual(me.lesson,{active:true,selected:true,ready:true});assert.ok(!JSON.stringify(me).includes('sandboxId'));const before=w.calls.length;await w.state.labTerminalSend('admin','lab',sid,uuid(2),'pwd');assert.equal(w.calls.length,before+2);await w.state.labTerminalSend('admin','lab',sid,uuid(2),'pwd');assert.equal(w.calls.length,before+2);});
for(const reason of ['admin revoked','seat sandbox changed','seat mapping changed','lab expired','lab ending','stop during provider read','takeover during provider read'])await test('final mutation gate: '+reason,async()=>{const w=await world(),sid=uuid(1);await w.state.labTerminalStart('admin','lab',sid,[1]);const before=w.calls.length,h=hold();w.remoteHold=h;const p=w.state.labTerminalSend('admin','lab',sid,uuid(2),'pwd');await until(()=>w.held);
if(reason==='admin revoked')await w.storage.delete('admin:'+await S.sha('admin'));
if(reason==='seat sandbox changed'){w.lab.seats[0].sandboxId='changed';await w.storage.put('lab:lab',w.lab)}
if(reason==='seat mapping changed')await w.storage.put('seat:'+w.lab.seats[0].code,{lab:'elsewhere',n:1});
if(reason==='lab expired'){w.lab.expiresAt=Date.now()-1;await w.storage.put('lab:lab',w.lab)}
if(reason==='lab ending')await w.storage.put('labprepstop:lab',{at:Date.now()});
if(reason==='stop during provider read')await w.state.labTerminalStop('admin','lab',sid);
if(reason==='takeover during provider read')await w.state.labTerminalTakeover('new-admin','lab',sid);
h.release();await p;assert.equal(w.calls.length,before);});
await test('endLab stops held credential resolution before any toolbox mutation and clears records',async()=>{const w=await world(),sid=uuid(1);await w.state.labTerminalStart('admin','lab',sid,[1]);const before=w.calls.length,h=hold();w.providerHold=h;const p=w.state.labTerminalSend('admin','lab',sid,uuid(2),'pwd');await until(()=>w.providerHeld);
// Real endLab enters #prepStopped before its first await; unblock provider so cleanup may finish.
const ending=w.state.endLab(w.lab,'end');h.release();await Promise.all([p,ending]);assert.equal(w.calls.length,before);assert.ok(![...w.storage.data.keys()].some(x=>x.startsWith('labterm:')));});
await test('API origin/admin/body limits protect every new route',async()=>{const calls=[];const state=new Proxy({},{get:(_,name)=>async(...args)=>{calls.push([name,args]);return{ok:true}}});const base={path:'/api/lab/terminal/send',env:{ORIGIN:'https://admin.invalid'},state,admin:'admin',json:(j,status=200)=>Response.json(j,{status}),out:r=>Response.json(r)};const call=(body,headers={},admin='admin',path=base.path)=>A.labTerminalApi({...base,path,admin,req:new Request('https://admin.invalid'+path,{method:'POST',headers:{origin:'https://admin.invalid',...headers},body})});
assert.equal((await call('{}',{},'')).status,401);assert.equal((await call('{}',{origin:'https://evil.invalid'})).status,403);assert.equal((await call(' '.repeat(32769))).status,413);assert.equal((await call('[]')).status,400);assert.equal(calls.length,0);
for(const name of ['start','send','stop','status','takeover']){const r=await call(JSON.stringify({id:'lab',sessionId:uuid(1),requestId:uuid(2),command:'pwd',seats:[1]}),{},'admin','/api/lab/terminal/'+name);assert.equal(r.status,200)}assert.equal(calls.length,5);assert.equal(A.labTerminalApi({...base,path:'/different'}),null);});
console.log(`${passed} terminal State/API scenarios passed`);
