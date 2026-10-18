// 네트워크 없이 진짜 서비스 번들을 가짜 저장소/외부 실행기로 검사한다.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const bundle = await build({ entryPoints: ['src/lab-terminal-service.ts'], bundle: true, write: false, format: 'esm', platform: 'node' });
const M = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
globalThis.fetch = () => { throw Error('network forbidden'); };
const uuid = (n) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const tick = () => new Promise((r) => setImmediate(r));
const held = () => { let release; const promise = new Promise((r) => release = r); return { promise, release }; };
async function until(f) { for (let i = 0; i < 100 && !f(); i++) await tick(); assert.ok(f()); }
function world() {
  const data = new Map(), calls = [], audit = [], tokens = new Set(['admin', 'new-admin']);
  let T = 1800000000000, wait = null, effectError = false, effectExit = false, authWait = null, beforeRemote = null;
  const lab = { id: 'lab', expiresAt: T + 3600000, seats: [1,2,3].map((n) => ({ n, code: 'code-' + n, sandboxId: 'sb-' + n, setup: { state: 'ok' } })) };
  const copy = (x) => x === undefined ? x : structuredClone(x);
  let lock = Promise.resolve();
  const storage = {
    async get(k) { return copy(data.get(k)); },
    async put(k,v) { if (typeof k === 'object') for (const [key,value] of Object.entries(k)) data.set(key,copy(value)); else data.set(k,copy(v)); },
    async delete(k) { if (Array.isArray(k)) k.forEach((x) => data.delete(x)); else data.delete(k); },
    async list({prefix,limit=Infinity}) { return new Map([...data].filter(([k]) => k.startsWith(prefix)).slice(0,limit).map(([k,v]) => [k,copy(v)])); },
    transaction(fn) { const p=lock.then(()=>fn(storage)); lock=p.catch(()=>{}); return p; },
  };
  const deps = { storage, now:()=>T, checkAdmin:async(t)=>{if(authWait)await authWait.promise;return tokens.has(t);},lab:async()=>lab,acquire:async(id)=>({labId:id,revision:0}),
    remote:async(token,ref,sid,command,gate)=>{
      if(beforeRemote)await beforeRemote(token,ref,sid);
      const current=data.get(M.terminalSessionKey('lab',sid));
      if(!tokens.has(token)||lab.endRetry||lab.expiresAt<=T||!current?.active||current.owner!==await digest(token))throw Error('denied');
      gate();calls.push({n:ref.n,sid,command});
      assert.ok(data.has(M.terminalSessionKey('lab',sid)),'durable session before effects');
      if(wait)await wait.promise;
      if(effectError)throw Error('private API key secret');
      if(effectExit)return {exitCode:1,result:'private error secret'};
      return {exitCode:0,result:Buffer.from(command.match(/Buffer.from\("([^"]+)"/)[1],'base64').toString().includes('has-session')?'READY':'SENT'};
    },audit:async(...args)=>audit.push(args),
  };
  return { data,calls,tokens,lab,storage,audit,make:()=>new M.LabTerminalService(deps), get time(){return T;},set time(v){T=v;},set wait(v){wait=v;},set effectError(v){effectError=v;},set effectExit(v){effectExit=v;},set beforeRemote(v){beforeRemote=v;} };
}
async function digest(s) {return Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s))).toString('base64url');}
let pass=0;
async function test(name,f){await f();pass++;console.log('ok',name);}
await test('auth, valid selection and unselected seats stay untouched',async()=>{
 const w=world(),s=w.make();assert.equal((await s.start('bad','lab',uuid(1),[1])).status,401);assert.equal(w.calls.length,0);
 for(const seats of [[],[1,1],[4],['1']])assert.equal((await s.start('admin','lab',uuid(1),seats)).status,400);
 const r=await s.start('admin','lab',uuid(1),[3,1]);assert.equal(r.active,true);assert.deepEqual(w.calls.map(x=>x.n),[1,3]);assert.deepEqual(r.seats.map(x=>x.status),['ready','ready']);
 assert.equal((await s.seatState('lab',2)).selected,false);assert.equal((await s.seatState('lab',1)).ready,true);
 assert.ok(!JSON.stringify(r).includes('code-')&&!JSON.stringify(r).includes('sb-'));
});
await test('same start and send IDs replay without effects, conflicting payload refused',async()=>{
 const w=world(),s=w.make(),sid=uuid(1),req=uuid(2);await s.start('admin','lab',sid,[1,2]);await s.start('admin','lab',sid,[2,1]);assert.equal(w.calls.length,2);
 assert.equal((await s.start('admin','lab',sid,[1])).status,409);
 const r=await s.send('admin','lab',sid,req,"printf '%s' '한글 $HOME `echo x`'");assert.equal(r.results[0].status,'sent');assert.equal(w.calls.length,4);
 assert.deepEqual(await s.send('admin','lab',sid,req,"printf '%s' '한글 $HOME `echo x`'"),r);assert.equal(w.calls.length,4);
 assert.equal((await s.send('admin','lab',sid,req,'pwd')).status,409);
 assert.equal(w.data.get(`${M.TERM_PREFIX}lab:op:${sid}:${req}`).hash.length,64);assert.ok(!JSON.stringify([...w.data.values()]).includes('printf'));
});
await test('stop blocks queued targets and never terminates running participant commands',async()=>{
 const w=world(),s=w.make(),sid=uuid(1);await s.start('admin','lab',sid,[1,2,3]);const h=held();w.wait=h;
 const p=s.send('admin','lab',sid,uuid(2),'sleep 3');await until(()=>w.calls.length===4);
 await s.stop('admin','lab',sid);h.release();const r=await p;assert.equal(w.calls.length,4);assert.equal(r.results[0].status,'sent');assert.equal(r.results[1].status,'unknown');
 assert.equal((await s.status('admin','lab')).active,false);assert.equal((await s.send('admin','lab',sid,uuid(3),'pwd')).status,409);
 assert.deepEqual(await s.send('admin','lab',sid,uuid(2),'sleep 3'),r);assert.ok(w.calls.every(x=>!x.command.includes('kill-session')));
});
await test('partial error and uncertain delivery are sanitized and are not retried',async()=>{
 const w=world(),s=w.make(),sid=uuid(1);await s.start('admin','lab',sid,[1,2]);w.beforeRemote=async(_,r)=>{if(r.n===2)w.effectError=true;};
 const r=await s.send('admin','lab',sid,uuid(2),'pwd');assert.deepEqual(r.results.map(x=>x.status),['sent','unknown']);assert.ok(!JSON.stringify(r).includes('secret'));
 const count=w.calls.length;await w.make().send('admin','lab',sid,uuid(2),'pwd');assert.equal(w.calls.length,count);
});
await test('restart with pending operation reports unknown without resending',async()=>{
 const w=world(),s=w.make(),sid=uuid(1);await s.start('admin','lab',sid,[1]);const h=held();w.wait=h;
 const p=s.send('admin','lab',sid,uuid(2),'pwd');await until(()=>w.calls.length===2);
 const r=await w.make().send('admin','lab',sid,uuid(2),'pwd');assert.equal(r.results[0].status,'unknown');assert.equal(w.calls.length,2);h.release();await p;
});
await test('concurrent new sends cannot reorder inputs',async()=>{
 const w=world(),s=w.make(),sid=uuid(1);await s.start('admin','lab',sid,[1]);const h=held();w.wait=h;
 const p=s.send('admin','lab',sid,uuid(2),'first');await until(()=>w.calls.length===2);
 assert.equal((await s.send('admin','lab',sid,uuid(3),'second')).status,409);h.release();await p;
});
await test('new authenticated admin explicitly takes over preserving dedup history',async()=>{
 const w=world(),s=w.make(),sid=uuid(1),req=uuid(2);await s.start('admin','lab',sid,[1]);const first=await s.send('admin','lab',sid,req,'pwd');
 assert.equal((await s.status('new-admin','lab')).needsTakeover,true);assert.equal((await s.send('new-admin','lab',sid,uuid(3),'pwd')).status,403);
 assert.equal((await s.takeover('new-admin','lab',sid)).needsTakeover,false);assert.equal((await s.status('new-admin','lab')).needsTakeover,false);
 assert.equal((await s.send('admin','lab',sid,uuid(3),'pwd')).status,403);assert.deepEqual(await s.send('new-admin','lab',sid,req,'pwd'),first);assert.equal(w.calls.length,2);
 assert.equal((await s.stop('new-admin','lab',sid)).ok,true);
});
await test('expired admin and ended lab prevent later remote sends and do not resurrect records',async()=>{
 const w=world(),s=w.make(),sid=uuid(1);await s.start('admin','lab',sid,[1,2]);w.tokens.delete('admin');assert.equal((await s.send('admin','lab',sid,uuid(2),'pwd')).status,401);
 w.tokens.add('admin');const h=held();w.wait=h;const p=s.send('admin','lab',sid,uuid(2),'pwd');await until(()=>w.calls.length===3);
 await s.clear('lab');h.release();await p;assert.equal(w.calls.length,3);assert.equal(w.data.size,0);assert.equal((await s.status('admin','lab')).status,410);
});
await test('one-line constraints, malformed IDs and budgets fail before delivery',async()=>{
 const w=world(),s=w.make(),sid=uuid(1);await s.start('admin','lab',sid,[1]);
 for(const c of ['a\nb','a\rb','a\tb','\u001b',' ','x'.repeat(4097)])assert.equal((await s.send('admin','lab',sid,uuid(2),c)).status,400);
 assert.equal((await s.send('admin','lab','bad',uuid(2),'pwd')).status,400);assert.equal(w.calls.length,1);
 const key=M.terminalSessionKey('lab',sid),cur=w.data.get(key);cur.count=100;w.data.set(key,cur);assert.equal((await s.send('admin','lab',sid,uuid(2),'pwd')).status,429);
});
await test('start partially failed seats are skipped on send; no automatic restart',async()=>{
 const w=world(),s=w.make(),sid=uuid(1);w.beforeRemote=async(_,r)=>{w.effectExit=r.n===2;};const r=await s.start('admin','lab',sid,[1,2]);assert.deepEqual(r.seats.map(x=>x.status),['ready','error']);
 w.effectExit=false;const result=await s.send('admin','lab',sid,uuid(2),'pwd');assert.deepEqual(result.results.map(x=>x.status),['sent','skipped']);assert.equal(w.calls.filter(x=>x.n===2).length,1);
});
await test('no-send delivery is none and a successful send keeps selected-seat status time',async()=>{
 const w=world(),s=w.make(),sid=uuid(1),req=uuid(2);assert.deepEqual(await s.delivery('lab'),[]);
 await s.start('admin','lab',sid,[3,1]);assert.equal(w.data.get(M.terminalSessionKey('lab',sid)).lastRequestId,undefined);
 assert.deepEqual(await s.delivery('lab'),[{n:1,status:'none',at:null},{n:3,status:'none',at:null}]);
 w.time+=4000;const sent=await s.send('admin','lab',sid,req,"printf '%s' '한글 $HOME'");assert.deepEqual(sent.results.map(x=>x.status),['sent','sent']);
 const op=w.data.get(M.terminalOperationKey('lab',sid,req));assert.equal(op.createdAt,w.time);assert.equal(op.updatedAt,w.time);
 assert.equal(w.data.get(M.terminalSessionKey('lab',sid)).lastRequestId,req);
 assert.deepEqual(await s.delivery('lab'),[{n:1,status:'sent',at:w.time},{n:3,status:'sent',at:w.time}]);
 const req2=uuid(3);w.time+=50;await s.send('admin','lab',sid,req2,'ls');const calls=w.calls.length;
 assert.deepEqual(await s.send('admin','lab',sid,req,"printf '%s' '한글 $HOME'"),sent);assert.equal(w.calls.length,calls);
 assert.equal(w.data.get(M.terminalSessionKey('lab',sid)).lastRequestId,req2);
 assert.deepEqual(await s.delivery('lab'),[{n:1,status:'sent',at:w.time},{n:3,status:'sent',at:w.time}]);
});
await test('replaced seat does not inherit old delivery; unaffected seat keeps its receipt',async()=>{
 const w=world(),s=w.make(),sid=uuid(1);await s.start('admin','lab',sid,[1,3]);await s.send('admin','lab',sid,uuid(2),'pwd');const before=JSON.stringify([...w.data]),calls=w.calls.length;
 w.lab.seats[0].code='new-code';w.lab.seats[0].sandboxId='new-sandbox';
 assert.deepEqual(await s.delivery('lab'),[{n:1,status:'unknown',at:null},{n:3,status:'sent',at:w.time}]);assert.equal(w.calls.length,calls);assert.equal(JSON.stringify([...w.data]),before);
});
await test('held send is pending only while this instance tracks it; reconstruction stays unknown',async()=>{
 const w=world(),s=w.make(),sid=uuid(1),req=uuid(2);await s.start('admin','lab',sid,[1,2]);w.time+=1000;const h=held();w.wait=h;
 const p=s.send('admin','lab',sid,req,'pwd');await until(()=>w.calls.length===3);
 assert.deepEqual(await s.delivery('lab'),[{n:1,status:'pending',at:w.time},{n:2,status:'pending',at:w.time}]);
 const calls=w.calls.length,audits=w.audit.length,before=JSON.stringify(w.data.get(M.terminalOperationKey('lab',sid,req)));
 assert.deepEqual(await w.make().delivery('lab'),[{n:1,status:'unknown',at:w.time},{n:2,status:'unknown',at:w.time}]);
 assert.equal(w.calls.length,calls);assert.equal(w.audit.length,audits);assert.equal(JSON.stringify(w.data.get(M.terminalOperationKey('lab',sid,req))),before);
 h.release();await p;assert.equal(w.calls.length,4);
});
await test('legacy and malformed delivery timestamps fall back without inventing times',async()=>{
 const w=world(),s=w.make(),sid=uuid(1);await s.start('admin','lab',sid,[1,2]);const sk=M.terminalSessionKey('lab',sid),cur=w.data.get(sk);
 cur.count=3;delete cur.lastRequestId;w.data.set(sk,cur);const before=JSON.stringify(w.data.get(sk));
 assert.deepEqual(await s.delivery('lab'),[{n:1,status:'unknown',at:null},{n:2,status:'unknown',at:null}]);assert.equal(JSON.stringify(w.data.get(sk)),before);
 cur.lastRequestId='not-a-uuid';w.data.set(sk,cur);assert.deepEqual((await s.delivery('lab')).map(x=>x.at),[null,null]);
 const req=uuid(9),opKey=M.terminalOperationKey('lab',sid,req);cur.lastRequestId=req;w.data.set(sk,cur);
 assert.deepEqual((await s.delivery('lab')).map(x=>x.status),['unknown','unknown']);
 const old=w.time-60000;
 for(const op of [{requestId:req,hash:'ab',results:[{n:1,status:'sent'}],updatedAt:w.time+1},{requestId:req,hash:'ab',results:[{n:1,status:'sent'}],updatedAt:-1},{requestId:uuid(100),hash:'ab',results:[{n:1,status:'sent'}],updatedAt:old},{requestId:req,hash:'ab',results:[{n:1,status:'sent'},{n:2,status:'error'}]},{requestId:req,hash:'ab',results:[{n:1,status:'sent'}],updatedAt:Number.NaN},{requestId:req,hash:'ab',results:'sent',updatedAt:old}]){
  w.data.set(opKey,op);assert.deepEqual(await s.delivery('lab'),[{n:1,status:'unknown',at:null},{n:2,status:'unknown',at:null}]);
 }
 w.data.set(opKey,{requestId:req,hash:'c'.repeat(64),createdAt:old-1000,updatedAt:old,results:[{n:1,status:'sent',note:'admin code-1 sb-1 printf'},{n:2,status:'pending',note:'secret'}]});
 assert.deepEqual(await s.delivery('lab'),[{n:1,status:'sent',at:old},{n:2,status:'unknown',at:old}]);
 w.data.set(opKey,{requestId:req,hash:'ab',updatedAt:old,results:[{n:1,status:'ready',note:'skip me'},{n:2,status:'unknown'}]});
 assert.deepEqual(await s.delivery('lab'),[{n:1,status:'unknown',at:null},{n:2,status:'unknown',at:old}]);
 w.data.set(opKey,{requestId:req,hash:'ab',updatedAt:old,results:[{n:1,status:'error'},{n:2,status:'skipped'}]});
 assert.deepEqual(await s.delivery('lab'),[{n:1,status:'error',at:old},{n:2,status:'skipped',at:old}]);
});
await test('delivery view excludes identities and commands and makes no external call',async()=>{
 const w=world(),s=w.make(),sid=uuid(1),req=uuid(2);await s.start('admin','lab',sid,[1]);w.time+=10;
 await s.send('admin','lab',sid,req,"printf '%s' 'token-admin sandbox-secret'");
 let scans=0;const list=w.storage.list.bind(w.storage);w.storage.list=async(q)=>{scans++;return list(q);};
 const calls=w.calls.length,audits=w.audit.length,puts=w.data.size;const view=await s.delivery('lab');
 assert.deepEqual(view,[{n:1,status:'sent',at:w.time}]);assert.deepEqual(Object.keys(view[0]).sort(),['at','n','status']);
 const text=JSON.stringify(view),op=w.data.get(M.terminalOperationKey('lab',sid,req));
 for(const secret of [sid,req,op.hash,'printf','token-admin','sandbox-secret','code-1','sb-1','admin','gw-lesson'])assert.equal(text.includes(secret),false);
 assert.equal(scans,0);assert.equal(w.calls.length,calls);assert.equal(w.audit.length,audits);assert.equal(w.data.size,puts);
 w.storage.get=async()=>{throw Error('storage down');};assert.deepEqual(await s.delivery('lab'),[]);
});
console.log(`${pass} terminal service scenarios passed`);
