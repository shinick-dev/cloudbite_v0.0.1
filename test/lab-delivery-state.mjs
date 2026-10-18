// Coordinator acceptance of public/admin and read-only delivery projections.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const b=await build({entryPoints:['src/state.ts'],bundle:true,write:false,platform:'node',format:'esm',external:['cloudflare:workers'],logLevel:'silent'});
const code=b.outputFiles[0].text.replace(/import\s*\{\s*DurableObject\s*\}\s*from\s*["']cloudflare:workers["'];?/, 'class DurableObject{constructor(ctx,env){this.ctx=ctx;this.env=env;}}');
const S=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
const uuid=n=>`60000000-0000-4000-8000-${n.toString(16).padStart(12,'0')}`;
globalThis.fetch=()=>{throw Error('delivery monitoring must not call providers');};
async function world(){const data=new Map(),copy=x=>x===undefined?x:structuredClone(x);let writes=0;
 const storage={data,async get(k){return Array.isArray(k)?new Map(k.filter(x=>data.has(x)).map(x=>[x,copy(data.get(x))])):copy(data.get(k));},
  async put(k,v){writes++;if(typeof k==='object')for(const[a,b]of Object.entries(k))data.set(a,copy(b));else data.set(k,copy(v));},async delete(k){writes++;for(const x of Array.isArray(k)?k:[k])data.delete(x);},
  async list({prefix='',limit=Infinity}={}){return new Map([...data].filter(([k])=>k.startsWith(prefix)).slice(0,limit).map(([k,v])=>[k,copy(v)]));},async getAlarm(){return null;},async setAlarm(){},async transaction(fn){return fn(storage);}};
 class Fixture extends S.State{async daytona(){return{status:409,error:'fixture has no provider'};}}
 const state=new Fixture({storage,waitUntil(){},blockConcurrencyWhile:f=>f()},{ORIGIN:'https://admin.invalid',LAB_ORIGIN:'https://lab.invalid',LAB_SEAT_DOMAIN:'seat.invalid'});
 const token='m'.repeat(32),at=Date.now()-1000,lab={id:'lab',name:'모임',createdAt:at,expiresAt:Date.now()+3600000,budget:1,seats:[1,2].map(n=>({n,code:('private-seat-'+n).padEnd(16,'x'),sandboxId:'private-sandbox-'+n,who:'참여자'+n}))};
 await storage.put('lab:lab',lab);await storage.put('teacher:'+await S.sha(token),{createdAt:at,expiresAt:Date.now()+3600000});await storage.put('admin:'+await S.sha('admin'),{expiresAt:Date.now()+600000});
 const session={sessionId:uuid(1),owner:'private-owner',active:true,refs:lab.seats.map(s=>({labId:lab.id,n:s.n,code:s.code,sandboxId:s.sandboxId})),seats:lab.seats.map(s=>({n:s.n,status:'ready'})),count:0,startedAt:at};
 await storage.put('labterm:lab:current',session.sessionId);await storage.put('labterm:lab:session:'+session.sessionId,session);
 return{storage,state,token,at,session,writes:()=>writes,async save(){await storage.put('labterm:lab:session:'+session.sessionId,session);},async operation(patch={}){session.count=1;session.lastRequestId=uuid(2);await this.save();await storage.put('labterm:lab:op:'+session.sessionId+':'+uuid(2),{requestId:uuid(2),hash:'private-command-hash',createdAt:at-1000,updatedAt:at,results:[{n:1,status:'sent',note:'PRIVATE_OUTPUT'},{n:2,status:'pending'}],...patch});}};
}
let passed=0;async function test(name,fn){await fn();passed++;console.log('ok',name);}
await test('no-send sessions project none and monitoring has no mutation or provider calls',async()=>{
 const w=await world(),before=w.writes(),view=await w.state.teacherStatus(w.token);assert.ok(view.labs[0].seats.every(s=>s.delivery.status==='none'&&s.delivery.at===null));assert.equal(w.writes(),before);
});
await test('admin and read-only views agree and reconstructed pending is unknown',async()=>{
 const w=await world();await w.operation();const before=w.writes(),admin=await w.state.labList('admin'),monitor=await w.state.teacherStatus(w.token);
 const expected=[{status:'sent',at:w.at},{status:'unknown',at:w.at}];assert.deepEqual(admin.labs[0].seats.map(s=>s.delivery),expected);assert.deepEqual(monitor.labs[0].seats.map(s=>s.delivery),expected);
 assert.equal(w.writes(),before);for(const seat of monitor.labs[0].seats)assert.deepEqual(Object.keys(seat.delivery).sort(),['at','status']);
 const text=JSON.stringify(monitor);for(const secret of['private-seat','private-sandbox','private-owner','private-command-hash','PRIVATE_OUTPUT',uuid(1),uuid(2)])assert.ok(!text.includes(secret),secret);
});
await test('legacy receipts and invalid or future status timestamps remain unknown',async()=>{
 const w=await world();w.session.count=1;await w.save();let view=await w.state.teacherStatus(w.token);assert.ok(view.labs[0].seats.every(s=>s.delivery.status==='unknown'&&s.delivery.at===null));
 for(const updatedAt of[undefined,-1,NaN,Date.now()+3600000]){await w.operation({updatedAt});view=await w.state.teacherStatus(w.token);assert.ok(view.labs[0].seats.every(s=>s.delivery.status==='unknown'&&s.delivery.at===null));}
});
console.log(`${passed} delivery State/monitor acceptance scenarios passed`);
