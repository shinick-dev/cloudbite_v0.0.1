// 진짜 State + 메모리 저장소 + 고정 공급자 fixture. 운영 네트워크/자격 증명 없음.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const stub={name:'cf-stub',setup(b){b.onResolve({filter:/^cloudflare:workers$/},()=>({path:'cf',namespace:'stub'}));b.onLoad({filter:/.*/,namespace:'stub'},()=>({contents:'export class DurableObject { constructor(ctx,env){this.ctx=ctx;this.env=env;} }'}));}};
const out=await build({entryPoints:[process.env.LAB_CREATE_STATE_SOURCE??'src/state.ts'],bundle:true,write:false,format:'esm',platform:'node',plugins:[stub],loader:{'.ps1':'text'}});
const {State}=await import('data:text/javascript;base64,'+Buffer.from(out.outputFiles[0].text).toString('base64'));
const gate=()=>{let resolve;const p=new Promise(r=>resolve=r);return{p,resolve}};
const tick=()=>new Promise(r=>setImmediate(r));
async function until(f){for(let n=0;n<1000&&!f();n++)await tick();assert.ok(f());}
let count=0;const check=(n,f)=>{f();count++;console.log('ok',n)};
const input=()=>({requestId:`lc_${Date.now()}_${'a'.repeat(32)}`,name:'fixture',seats:1,hours:1,budget:1,cpu:1,memory:2,disk:5,gw:'https://gw.fake',snapshot:'gw-lab-v4',model:'m'});
const jr=(v,status=200)=>new Response(JSON.stringify(v),{status,headers:{'content-type':'application/json'}});
let current;
globalThis.fetch=async(u,init={})=>{
  const url=new URL(typeof u==='string'?u:u.url),method=init.method??'GET',w=current;
  if(url.host==='openrouter.ai'&&url.pathname==='/api/v1/keys'&&method==='POST'&&w.realMint){w.orPosts++;return jr({key:'fixture-only',data:{hash:'fixture-hash'}});}
  assert.equal(url.host,'dt.fake','unknown network forbidden');w.calls.push([method,url.pathname]);
  if(url.pathname==='/sandbox'&&method==='POST'){w.posts++;w.sbHit=true;if(w.sbHold)await w.sbHold.p;if(w.lostResponse)throw Error('fixture response lost after provider effect');w.knownResponse=true;return jr({id:'SB-known',state:'creating'});}
  if(url.pathname==='/sandbox'&&method==='GET')return jr([]);
  if(/^\/sandbox\/SB-[\w-]+$/.test(url.pathname)&&method==='DELETE'){w.deletes++;w.deletedIds.push(url.pathname.slice(9));if(!w.lifecycleDelete)assert.ok(init.signal,'cleanup DELETE has timeout signal');return w.deleteFail?jr({},500):jr({});}
  if(url.pathname==='/sandbox/SB-known')return jr({id:'SB-known',state:'creating'});
  throw Error('unexpected fixture path '+url.pathname);
};
function world(){
  const m=new Map(),w={m,deletedIds:[],lists:[],labReads:0,alarmAt:null,calls:[],posts:0,deletes:0,mints:0,revoked:[],auth:true,mintHold:null,realMint:false,orPosts:0,decryptHold:null,decryptHit:false,mintHit:false,mintHits:0,mintHolds:[],sbHold:null,sbHit:false,deleteFail:false};current=w;
  let q=Promise.resolve();
  const clone=v=>v===undefined?undefined:structuredClone(v);
  const storage={
    async get(k){await null;if(typeof k==='string'&&k.startsWith('lab:'))w.labReads++;return Array.isArray(k)?new Map(k.map(x=>[x,clone(m.get(x))])):clone(m.get(k));},
    async put(k,v){await null;for(const [a,b]of typeof k==='object'?Object.entries(k):[[k,v]]){w.storageFault?.('put',a,b);m.set(a,clone(b));}},
    async delete(k){for(const x of Array.isArray(k)?k:[k]){w.storageFault?.('delete',x);m.delete(x);}},
    async list({prefix='',limit=Infinity,startAfter,start,end,reverse=false}={}){const entries=[...m].filter(([k])=>k.startsWith(prefix)&&(startAfter===undefined||k>startAfter)&&(start===undefined||k>=start)&&(end===undefined||k<end)).sort(([a],[b])=>a<b?-1:a>b?1:0);if(reverse)entries.reverse();const result=new Map(entries.slice(0,limit).map(([k,v])=>[k,clone(v)]));w.lists.push({prefix,limit,startAfter,reverse,size:result.size});return result;},
    async getAlarm(){return w.alarmAt;},async setAlarm(t){w.storageFault?.('setAlarm',null,t);w.alarmAt=t;},
    async transaction(f){let release;const prev=q;q=new Promise(r=>release=r);await prev;try{return await f(storage)}finally{release()}},
  };
  const provider={gen:'g1',iv:'fixture-iv',ct:'fixture-ciphertext',upstream:'https://dt.fake'};m.set('prov:daytona',provider);
  class T extends State{
    async checkAdmin(t){return w.auth&&t==='admin'}
    async daytona(){return{api:'https://dt.fake',key:'fixture-only'}}
    async labShareInput(){return{share:{},defs:[]}}
    async listProviders(){return[{id:'or',kind:'openrouter-mint',upstream:'https://openrouter.ai'}]}
    async modelExists(){return true}
    async decrypt(){w.decryptHit=true;if(w.decryptHold)await w.decryptHold.p;return "fixture-only"}
    async newSession(...args){if(w.realMint)return super.newSession(...args);w.mintHit=true;w.mintHits++;const hold=w.mintHolds.shift()??w.mintHold;if(hold)await hold.p;const sid='S'+(++w.mints);await storage.put('sess:'+sid,{id:sid,expiresAt:Date.now()+3600000,tokenHash:'fixture',lab:'fixture'});return{sid,token:'fixture-only'}}
    async endSession(s){w.revoked.push(s.id);await storage.delete('sess:'+s.id);return true}
  }
  w.storage=storage;
  // 동일 저장소와 알람 시각을 유지하고 State의 메모리만 새로 만든다. workerd eviction은 아니다.
  w.restart=()=>w.st=new T({storage,waitUntil(p){void p.catch(()=>{})},blockConcurrencyWhile:f=>f()},{LAB_SEAT_DOMAIN:'seat.fake',LAB_ORIGIN:'https://lab.fake'});
  w.restart();return w;
}
const request=()=>`lc_${Date.now()}_${crypto.randomUUID().replace(/-/g,'')}`;
function seed(w,n=1){const parent={id:'parent',name:'진행 중 모임',createdAt:Date.now()-600000,expiresAt:Date.now()+3600000,budget:1,cpu:1,memory:2,disk:5,gw:'https://gw.fake',snapshot:'gw-lab-v4',model:'m',clip:{in:true,out:false},seats:Array.from({length:n},(_,i)=>({n:i+1,code:'old-code-'+i,label:'old-label-'+i,who:'기존 참여자 '+i,opened:Date.now()-1000,setup:{state:'ok',at:Date.now(),note:''}}))};w.m.set('lab:parent',structuredClone(parent));return parent}
async function plan(w){const r=await w.st.labSeatAddStatus('admin',{id:'parent'});assert.ok(r.seatAdd,JSON.stringify(r));return r.seatAdd}
async function payload(w,id=request()){return{id:'parent',requestId:id,version:(await plan(w)).version}}
{
 const w=world(),parent=seed(w),p=await payload(w),a=w.st.labSeatAdd('admin',p),b=w.st.labSeatAdd('admin',p),results=await Promise.all([a,b]);
 check('repeated concurrent request allocates one seat and one sandbox',()=>{assert.equal(w.posts,1);assert.equal(w.mints,1);assert.equal(w.m.get('lab:parent').seats.length,2);assert.ok(results.every(r=>r.creationState==='completed'&&r.seatAdd.seat.n===2))});
 check('existing participant, resources and deadline stay intact',()=>{const got=w.m.get('lab:parent');assert.deepEqual(got.seats[0],parent.seats[0]);for(const k of ['expiresAt','cpu','memory','disk','budget','snapshot','model','clip'])assert.deepEqual(got[k],parent[k])});
 const again=await w.restart().labSeatAdd('admin',p),status=await w.st.labSeatAddStatus('admin',{id:'parent',requestId:p.requestId});
 check('restart replay and read-only recovery do not mint again',()=>{assert.equal(again.seatAdd.seat.n,2);assert.equal(status.creationState,'completed');assert.equal(w.posts,1);assert.equal(w.mints,1)});
 check('responses contain no invite code, session or provider credential',()=>{const text=JSON.stringify(status);assert.ok(!text.includes('old-code'));assert.ok(!text.includes('fixture-only'));assert.ok(!text.includes('sandboxId'));assert.ok(!text.includes('sid'));assert.ok(!text.includes('seatCode'))});
}
{
 const w=world();seed(w);const a=await payload(w),b=await payload(w);await Promise.all([w.st.labSeatAdd('admin',a),w.st.labSeatAdd('admin',b)]);
 check('different simultaneous additions get distinct seat numbers and codes',()=>{const seats=w.m.get('lab:parent').seats;assert.equal(seats.length,3);assert.equal(new Set(seats.map(s=>s.n)).size,3);assert.equal(new Set(seats.map(s=>s.code)).size,3);assert.equal(w.posts,2)});
}
{
 const w=world();seed(w,19);const a=await payload(w),b=await payload(w);await Promise.all([w.st.labSeatAdd('admin',a),w.st.labSeatAdd('admin',b)]);
 check('concurrent last seat cannot exceed cap',()=>{assert.equal(w.m.get('lab:parent').seats.length,20);assert.equal(w.posts,1)});
 const last=w.m.get('lab:parent').seats.at(-1);assert.ok(last.sandboxId);
 const full=await plan(w);check('full meeting still exposes status but disables another addition',()=>assert.equal(full.canAdd,false));
}
{
 const w=world();seed(w);const p=await payload(w);w.m.get('lab:parent').budget=2;const r=await w.st.labSeatAdd('admin',p);
 check('changed confirmed settings reject before spend',()=>{assert.equal(r.status,409);assert.equal(w.posts,0);assert.equal(w.mints,0)});
}
{
 const w=world();seed(w);const p=await payload(w);w.auth=false;
assert.equal((await w.st.labSeatAdd('admin',p)).status,401);assert.equal((await w.st.labSeatAddStatus('admin',{id:'parent'})).status,401);assert.equal(w.posts,0);
 w.auth=true;for(const mutation of [{...p,cpu:4},{...p,seats:10},{...p,version:'invalid'},{...p,requestId:'bad'},{...p,id:'../parent'}])assert.equal((await w.st.labSeatAdd('admin',mutation)).status,400);
 check('caller cannot override resources, quantity, room ID or request format',()=>assert.equal(w.posts,0));
 w.m.get('lab:parent').teacherDemoFor='another';assert.equal((await w.st.labSeatAdd('admin',p)).status,409);delete w.m.get('lab:parent').teacherDemoFor;
 w.m.get('lab:parent').expiresAt=Date.now()-1;assert.equal((await w.st.labSeatAdd('admin',p)).status,410);
 check('demo and ended meetings refuse additional seats',()=>assert.equal(w.posts,0));
}
{
 const w=world();const parent=seed(w);w.lostResponse=true;const p=await payload(w),r=await w.st.labSeatAdd('admin',p);assert.equal(r.creationState,'completed');assert.equal(r.seatAdd.seat.ready,false);await w.st.labSeatAdd('admin',p);
 check('lost provider response is reported as unready and never auto-retried',()=>{assert.equal(w.posts,1);assert.equal(w.mints,1);assert.equal(w.revoked.length,1);assert.deepEqual(w.m.get('lab:parent').seats[0],parent.seats[0])});
}
{
 const w=world();const parent=seed(w),p=await payload(w),h=gate();w.mintHold=h;const run=w.st.labSeatAdd('admin',p);await until(()=>w.mintHit);w.auth=false;h.resolve();const r=await run;
 check('auth expiry during creation stops sandbox spend and revokes new session',()=>{assert.equal(r.status,401);assert.equal(w.posts,0);assert.equal(w.revoked.length,1);assert.deepEqual(w.m.get('lab:parent').seats[0],parent.seats[0])});
}
console.log(`${count} seat-add State scenarios passed`);
