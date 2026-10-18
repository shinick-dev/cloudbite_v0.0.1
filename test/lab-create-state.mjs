// 진짜 State + 메모리 저장소 + 고정 공급자 fixture. 운영 네트워크/자격 증명 없음.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
const stub={name:'cf-stub',setup(b){b.onResolve({filter:/^cloudflare:workers$/},()=>({path:'cf',namespace:'stub'}));b.onLoad({filter:/.*/,namespace:'stub'},()=>({contents:'export class DurableObject { constructor(ctx,env){this.ctx=ctx;this.env=env;} }'}));}};
const out=await build({entryPoints:[process.env.LAB_CREATE_STATE_SOURCE??'src/state.ts'],bundle:true,write:false,format:'esm',platform:'node',plugins:[stub],loader:{'.ps1':'text'}});
const dir=mkdtempSync(join(tmpdir(),'lab-create-state-'));writeFileSync(join(dir,'state.mjs'),out.outputFiles[0].text);const {State}=await import(pathToFileURL(join(dir,'state.mjs')));rmSync(dir,{recursive:true,force:true});
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
{
  const w=world(),h=gate();w.mintHold=h;const v=input(),p=w.st.labCreate('admin',v);await until(()=>w.mintHit);
  const id=[...w.m.keys()].find(k=>k.startsWith('lab:')).slice(4);assert.equal((await w.st.labEnd('admin',id)).ok,true);h.resolve();
  const r=await p;assert.equal(r.status,410);
  check('end during mint never posts sandbox or resurrects lab',()=>{assert.equal(w.posts,0);assert.ok(!w.m.has('lab:'+id));assert.deepEqual(w.revoked,['S1']);assert.ok(!w.m.has('sess:S1'));});
  check('ended unknown claim lookup410 and same ID no new mint',()=>{});assert.equal((await w.st.labCreateStatus('admin',v.requestId)).status,410);assert.equal((await w.st.labCreate('admin',v)).status,410);assert.equal(w.mints,1);
}
{
  const w=world(),h=gate();w.sbHold=h;const v=input(),p=w.st.labCreate('admin',v);await until(()=>w.sbHit);
  const id=[...w.m.keys()].find(k=>k.startsWith('lab:')).slice(4);assert.equal((await w.st.labEnd('admin',id)).ok,true);w.deleteFail=true;h.resolve();assert.equal((await p).status,410);
  const key=[...w.m.keys()].find(k=>k.startsWith('labcreatecleanup:'));assert.ok(key);assert.equal(w.m.get(key).sandboxId,'SB-known');
  check('late known sandbox delete failure durable retry, no lab resurrection',()=>{assert.equal(w.deletes,1);assert.ok(!w.m.has('lab:'+id));assert.ok(!JSON.stringify(w.m.get(key)).includes('fixture-only'));});
  w.m.get(key).due=Date.now()-1;const original=w.m.get('prov:daytona');w.m.set('prov:daytona',{...original,gen:'g2'});w.deleteFail=false;await w.st.alarm();
  check('cleanup never crosses provider generation',()=>{assert.equal(w.deletes,1);assert.ok(w.m.has(key));});
  w.m.set('prov:daytona',original);w.m.get(key).due=Date.now()-1;await w.st.alarm();
  check('cleanup alarm known ID retry completes',()=>{assert.equal(w.deletes,2);assert.ok(!w.m.has(key));});
}
{
  const w=world(),h=gate();w.mintHold=h;const v=input(),p=w.st.labCreate('admin',v);await until(()=>w.mintHit);w.auth=false;h.resolve();assert.equal((await p).status,401);
  check('auth expires after mint: revoke known session and stop sandbox spend',()=>{assert.equal(w.posts,0);assert.deepEqual(w.revoked,['S1']);});
  w.auth=true;assert.equal((await w.st.labCreateStatus('admin',v.requestId)).creationState,'unknown');assert.equal((await w.st.labCreate('admin',v)).creationState,'unknown');assert.equal(w.mints,1);
}
{
  const w=world(),h=gate();w.sbHold=h;const v=input(),p=w.st.labCreate('admin',v);await until(()=>w.sbHit);
  const id=[...w.m.keys()].find(k=>k.startsWith('lab:')).slice(4);w.m.get('lab:'+id).expiresAt=Date.now()-1;h.resolve();assert.equal((await p).status,410);
  check('expiry while provider awaited: known resource cleanup, no completed replay',()=>{assert.equal(w.deletes,1);assert.ok(!w.m.has('sess:S1'));});
  assert.equal((await w.st.labCreateStatus('admin',v.requestId)).status,410);
}
{
  const w=world(),h=gate();w.mintHold=h;const v={...input(),requestId:undefined},p=w.st.labCreate('admin',v);await until(()=>w.mintHit);w.auth=false;h.resolve();
  check('legacy callers receive Fail instead of thrown guard',()=>{});assert.equal((await p).status,401);
}
{
  const w=world(),a=gate(),b=gate();w.mintHolds=[a,b];const v={...input(),seats:2};let finished=false;
  const p=w.st.labCreate('admin',v).then(r=>{finished=true;return r;});await until(()=>w.mintHits===2);w.auth=false;a.resolve();await until(()=>w.revoked.length===1);
  check('one worker guard failure waits for other in-flight seat',()=>assert.equal(finished,false));
  b.resolve();assert.equal((await p).status,401);
  check('all settled before final result, each known session revoked',()=>{assert.equal(w.revoked.length,2);assert.equal(w.posts,0);});
}
for(const why of ['auth','end']) {
  const w=world(),h=gate();w.realMint=true;w.decryptHold=h;const v=input(),p=w.st.labCreate('admin',v);await until(()=>w.decryptHit);
  if(why==='auth')w.auth=false;
  else {const id=[...w.m.keys()].find(k=>k.startsWith('lab:')).slice(4);assert.equal((await w.st.labEnd('admin',id)).ok,true)}
  h.resolve();assert.equal((await p).status,why==='auth'?401:410);
  check(`${why} during real mint credential decrypt: no OpenRouter POST`,()=>{assert.equal(w.orPosts,0);assert.ok(![...w.m.keys()].some(k=>k.startsWith('sess:')));});
}
{
  const w=world();w.auth=false;assert.equal((await w.st.labCreate('admin',null)).status,401);w.auth=true;assert.equal((await w.st.labCreate('admin',null)).status,400);
  check('null body authenticates before shape inspection',()=>{assert.equal(w.mints,0);assert.equal(w.posts,0);});
}
// 순서가 보장되는 가짜 저장소와 실제 알람: 커서가 provider-stale 접두 구간을 넘어간다.
const CURSOR='labcreatecleanup-cursor',PREFIX='labcreatecleanup:';
const realNow=Date.now;
let clock=realNow();
Date.now=()=>clock;
async function stamp(w){return (await import('node:crypto')).createHash('sha256').update(JSON.stringify({...w.m.get('prov:daytona'),api:''})).digest('base64url');}
const row=(provider,n,due=clock-1)=>({labId:'gone',sandboxId:'SB-'+n,provider,due});
const key=(s,n)=>PREFIX+s+String(n).padStart(4,'0')+':1';
async function runAlarm(w){w.alarmAt=null;const reads=w.labReads,deletes=w.deletes,lists=w.lists.length;await w.st.alarm();const pages=w.lists.slice(lists).filter(x=>x.prefix===PREFIX);assert.ok(pages.length<=2);assert.ok(pages.every(x=>x.limit<=257));assert.ok(w.labReads-reads<=256);assert.ok(w.deletes-deletes<=4);return w.alarmAt;}
// 알려진 POST 응답 뒤 각 영속 경계가 한 번 실패한다. catch가 끝난 뒤 같은 저장소로 재구성한다.
// 프로세스 강제 종료/실제 workerd 재시작/transaction rollback은 이 메모리 fixture로 증명하지 않는다.
for(const boundary of ['cleanup-put','alarm-set','seat-put','cleanup-delete']) {
  const w=world(),v=input(),original=w.m.get('prov:daytona'),provider=await stamp(w);let faults=0;
  w.deleteFail=true;
  w.storageFault=(op,k,value)=>{
    if(!w.knownResponse||faults)return;
    const hit=boundary==='cleanup-put'?op==='put'&&k.startsWith(PREFIX)
      :boundary==='alarm-set'?op==='setAlarm'
      :boundary==='seat-put'?op==='put'&&k.startsWith('lab:')&&value.seats.some(s=>s.sandboxId==='SB-known')
      :op==='delete'&&k.startsWith(PREFIX);
    if(hit){faults++;throw Error('fixture '+boundary);}
  };
  const r=await w.st.labCreate('admin',v),claimKey='labcreate:'+v.requestId,claim=w.m.get(claimKey),id=claim.labId;
  const cleanupKey=PREFIX+id+':1',cleanup=w.m.get(cleanupKey),seatCode=w.m.get('lab:'+id).seats[0].code;
  check(`${boundary}: known response failure retains original cleanup record`,()=>{
    assert.equal(faults,1);assert.equal(r.creationState,'unknown');assert.equal(w.posts,1);assert.equal(w.deletes,1);
    assert.deepEqual(cleanup,{labId:id,sandboxId:'SB-known',provider,due:clock+300000});
    assert.equal(w.alarmAt,cleanup.due);assert.ok(!w.m.has('sess:S1'));assert.equal(claim.phase,'unknown');
    assert.equal(w.m.get('lab:'+id).seats[0].sandboxId,boundary==='cleanup-delete'?'SB-known':undefined);
  });
  const previous=w.st,storage=w.storage,persisted=w.m;w.restart();
  assert.equal((await w.st.labCreateStatus('admin',v.requestId)).creationState,'unknown');
  assert.equal((await w.st.labCreate('admin',v)).creationState,'unknown');
  check(`${boundary}: reconstructed State never repeats provider POST`,()=>{
    assert.notEqual(w.st,previous);assert.equal(w.storage,storage);assert.equal(w.m,persisted);
    assert.equal(w.posts,1);assert.equal(w.mints,1);assert.deepEqual(w.m.get(cleanupKey),cleanup);
  });
  // 실제 끝내기: 이미 연결된 sandbox는 lifecycle이 지우고, 연결 전 알려진 ID는 cleanup에 남는다.
  w.deleteFail=false;w.lifecycleDelete=true;assert.equal((await w.st.labEnd('admin',id)).ok,true);w.lifecycleDelete=false;
  w.m.set('prov:daytona',{...original,gen:'replacement'});clock=w.m.get(cleanupKey).due;w.restart();
  const deleted=w.deletes;await runAlarm(w);
  check(`${boundary}: ended reconstruction preserves cleanup under provider rotation`,()=>{
    assert.equal(w.deletes,deleted);assert.equal(w.m.get(cleanupKey).provider,provider);
    assert.equal(w.m.get(cleanupKey).due,clock+300000);assert.equal(w.alarmAt,clock+300000);
    assert.ok(!w.m.has('lab:'+id));assert.ok(!w.m.has('seat:'+seatCode));assert.ok(!w.m.has('sess:S1'));
  });
  assert.equal((await w.st.labCreateStatus('admin',v.requestId)).status,410);
  assert.equal((await w.st.labCreate('admin',v)).status,410);
  w.m.set('prov:daytona',original);clock=w.m.get(cleanupKey).due;w.restart();await runAlarm(w);
  check(`${boundary}: original provider retry finishes without ended claim resurrection`,()=>{
    assert.equal(w.deletes,deleted+1);assert.ok(!w.m.has(cleanupKey));assert.equal(w.posts,1);assert.equal(w.mints,1);
    assert.ok(!w.m.has('lab:'+id));assert.ok(!w.m.has('seat:'+seatCode));assert.ok(!w.m.has('sess:S1'));
    assert.deepEqual(w.m.get(claimKey),claim);
  });
}
{
  const w=world(),h=gate(),v=input();w.sbHold=h;w.deleteFail=true;
  const p=w.st.labCreate('admin',v);await until(()=>w.sbHit);
  const id=w.m.get('labcreate:'+v.requestId).labId,lab=w.m.get('lab:'+id),staleCode=lab.seats[0].code;
  lab.seats[0].code='replacement-seat';h.resolve();assert.equal((await p).status,410);
  const cleanupKey=PREFIX+id+':1';assert.equal(w.m.get(cleanupKey).sandboxId,'SB-known');w.restart();
  assert.equal((await w.st.labCreate('admin',v)).creationState,'unknown');
  clock=w.m.get(cleanupKey).due;w.deleteFail=false;await runAlarm(w);
  check('stale seat identity rejects late known result and reconstructed alarm cleans only known ID',()=>{
    assert.equal(w.posts,1);assert.equal(w.mints,1);assert.deepEqual(w.deletedIds,['SB-known','SB-known']);
    assert.equal(w.m.get('lab:'+id).seats[0].code,'replacement-seat');assert.equal(w.m.get('lab:'+id).seats[0].sandboxId,undefined);
    assert.equal(w.m.get('seat:'+staleCode).n,1);assert.ok(!w.m.has('sess:S1'));assert.ok(!w.m.has(cleanupKey));
  });
}
{
  const w=world(),v=input();w.lostResponse=true;
  const r=await w.st.labCreate('admin',v),claimKey='labcreate:'+v.requestId,id=w.m.get(claimKey).labId;
  check('lost provider response stores failed seat without inventing known sandbox ID',()=>{
    assert.equal(r.creationState,'completed');assert.equal(r.lab.failedSeats,1);assert.equal(w.posts,1);
    const seat=w.m.get('lab:'+id).seats[0];assert.ok(seat.error);assert.equal(seat.sid,undefined);assert.equal(seat.sandboxId,undefined);
    assert.ok(!w.m.has('sess:S1'));assert.ok(![...w.m.keys()].some(k=>k.startsWith(PREFIX)));
  });
  w.restart();assert.equal((await w.st.labCreateStatus('admin',v.requestId)).creationState,'completed');
  assert.equal((await w.st.labCreate('admin',v)).creationState,'completed');
  check('lost response reconstructed replay never blindly retries provider or mint',()=>{assert.equal(w.posts,1);assert.equal(w.mints,1);});
  // GET fixture는 빈 목록이다. 실제 공급자에 생겼지만 응답에서 잃은 자원까지 정리됐다는 주장은 하지 않는다.
  assert.equal((await w.st.labEnd('admin',id)).ok,true);w.restart();await runAlarm(w);
  assert.equal((await w.st.labCreateStatus('admin',v.requestId)).status,410);assert.equal((await w.st.labCreate('admin',v)).status,410);
  check('lost response ended claim cannot recreate lab after reconstruction',()=>{
    assert.equal(w.posts,1);assert.equal(w.mints,1);assert.equal(w.deletes,0);assert.ok(!w.m.has('lab:'+id));
    assert.ok(![...w.m.keys()].some(k=>k.startsWith('seat:')||k.startsWith('sess:')));
  });
}
{
  const w=world(),valid=await stamp(w);for(let n=254;n>=0;n--)w.m.set(key('a',n),row('old',n));w.m.set(key('z',0),row(valid,'target'));
  await runAlarm(w);
  check('255 stale rows + matching negative control cleans within one page',()=>{assert.ok(w.deletedIds.includes('SB-target'));assert.equal(w.m.has(key('a',0)),true);});
}
{
  const w=world(),valid=await stamp(w);for(let n=299;n>=0;n--)w.m.set(key('a',n),row('old',n));w.m.set(key('z',0),row(valid,'target'));
  const next=await runAlarm(w);assert.equal(w.deletes,0);const firstAlarmTime=clock;
  // 갱신과 지워진 커서 행도 뒷페이지 진행을 막지 않는다. 커서 메타데이터는 유지한다.
  const after=w.m.get(CURSOR)?.after;if(after)w.m.delete(after);w.m.set(key('a',0),row('old',0,clock+3600000));w.restart();clock+=60000;await runAlarm(w);
  check('over256 retained stale prefix cannot starve matching later row',()=>{assert.ok(w.deletedIds.includes('SB-target'),'matching sandbox behind retained prefix must eventually DELETE');assert.equal(next,firstAlarmTime+60000);assert.equal(w.m.has(CURSOR),false);assert.ok(w.m.has(key('a',0)));assert.ok(w.lists.some(x=>x.prefix===PREFIX&&x.startAfter===after));});
}
{
  const w=world(),valid=await stamp(w);for(let n=0;n<300;n++)w.m.set(key('a',n),row('old',n,clock+3600000));for(let n=0;n<7;n++)w.m.set(key('z',n),row(valid,'live'+n));
  assert.equal(await runAlarm(w),clock+60000);assert.equal(w.deletes,0);clock+=60000;await runAlarm(w);
  check('future-only full page advances and four DELETE budget remains',()=>{assert.equal(w.deletes,4);assert.ok(w.m.has(key('z',4)));});
  for(let n=0;n<4&&w.m.has(key('z',6));n++){clock=w.alarmAt??clock+60000;w.m.get(key('a',0)).due=clock+3600000;await runAlarm(w);}
  check('busy early-row updates and delayed retries do not starve remaining deletes',()=>{assert.equal(w.deletes,7);assert.equal(w.m.has(key('z',6)),false);assert.ok(w.m.has(key('a',0)));});
}
{
  const w=world(),valid=await stamp(w);for(let n=0;n<300;n++)w.m.set(key('a',n),row('old',n,clock+3600000));w.m.set(key('z',0),row(valid,'reset'));
  await runAlarm(w);w.m.delete(CURSOR);clock+=60000;await runAlarm(w);assert.equal(w.deletes,0);clock+=60000;await runAlarm(w);
  check('lost cursor metadata restarts once and progresses next alarm',()=>assert.ok(w.deletedIds.includes('SB-reset')));
  w.m.set(CURSOR,{after:key('zz',9999)});w.m.set(key('b',0),row(valid,'empty-tail'));clock+=60000;assert.equal(await runAlarm(w),clock+60000);assert.equal(w.m.has(CURSOR),false);
  clock+=60000;await runAlarm(w);clock+=60000;await runAlarm(w);
  check('empty resume tail wraps safely to surviving earlier rows',()=>assert.ok(w.deletedIds.includes('SB-empty-tail')));
}
{
  const w=world(),valid=await stamp(w);for(let n=0;n<8;n++)w.m.set(key('a',n),row(valid,'fail'+n));w.deleteFail=true;
  const first=clock;await runAlarm(w);assert.equal(w.deletes,4);for(let n=0;n<4;n++)assert.equal(w.m.get(key('a',n)).due,first+300000);
  w.restart();clock+=60000;await runAlarm(w);
  check('failed deletes across reconstructed State retain five-minute retry and per-alarm bounded attempts',()=>{assert.equal(w.deletes,8);assert.equal(w.m.get(key('a',4)).due,clock+300000);assert.equal([...w.m.keys()].filter(k=>k.startsWith(PREFIX)).length,8);assert.ok(w.alarmAt>clock);});
  const retained=[...w.m].filter(([k])=>k.startsWith(PREFIX)).map(([k,v])=>[k,structuredClone(v)]);
  w.restart();await runAlarm(w);
  check('reconstruction before persisted retry due makes no provider attempt',()=>{assert.equal(w.deletes,8);assert.deepEqual([...w.m].filter(([k])=>k.startsWith(PREFIX)),retained);assert.equal(w.alarmAt,first+300000);});
  w.deleteFail=false;clock=first+300000;w.restart();await runAlarm(w);assert.equal(w.deletes,12);
  assert.equal([...w.m.keys()].filter(k=>k.startsWith(PREFIX)).length,4);
  clock+=60000;w.restart();await runAlarm(w);
  check('reconstructed retries remove all known records in due batches of four',()=>{assert.equal(w.deletes,16);assert.equal([...w.m.keys()].filter(k=>k.startsWith(PREFIX)).length,0);});
}
{
  const w=world();w.m.set(PREFIX+'c:1',row('old',1,clock+1000000));w.m.set(PREFIX+'a:1',row('old',2,clock+2000000));w.m.set(PREFIX+'b:1',row('old',3,clock+3000000));
  const ordered=await w.storage.list({prefix:PREFIX,startAfter:PREFIX+'a:1',reverse:true,limit:1});assert.deepEqual([...ordered.keys()],[PREFIX+'c:1']);
  assert.equal(await runAlarm(w),clock+1000000);assert.equal(w.m.has(CURSOR),false);
  check('exhausted page schedules earliest future due without scan loop',()=>assert.equal(w.deletes,0));
}
Date.now=realNow;
console.log(`${count} State checks passed`);
