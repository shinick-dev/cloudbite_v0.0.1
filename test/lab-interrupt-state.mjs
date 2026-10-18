// Coordinator acceptance: real State/API, all provider effects recorded in fixtures.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
async function bundle(entry){const b=await build({entryPoints:[entry],bundle:true,write:false,platform:'node',format:'esm',external:['cloudflare:workers'],logLevel:'silent'});const code=b.outputFiles[0].text.replace(/import\s*\{\s*DurableObject\s*\}\s*from\s*["']cloudflare:workers["'];?/,'class DurableObject{constructor(ctx,env){this.ctx=ctx;this.env=env}}');return import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'))}
const S=await bundle('src/state.ts'),A=await bundle('src/lab-interrupt-api.ts');
const uuid=n=>'60000000-0000-4000-8000-'+n.toString(16).padStart(12,'0');
function memory(){const data=new Map(),copy=x=>x===undefined?x:structuredClone(x);let lock=Promise.resolve();const s={data,
 async get(k){if(s.onGet)await s.onGet(k);return Array.isArray(k)?new Map(k.filter(x=>data.has(x)).map(x=>[x,copy(data.get(x))])):copy(data.get(k))},
 async put(k,v){if(typeof k==='object')for(const[a,b]of Object.entries(k))data.set(a,copy(b));else data.set(k,copy(v))},
 async delete(k){for(const x of Array.isArray(k)?k:[k])data.delete(x)},async list({prefix='',limit=Infinity}={}){return new Map([...data].filter(([k])=>k.startsWith(prefix)).slice(0,limit).map(([k,v])=>[k,copy(v)]))},
 async getAlarm(){return null},async setAlarm(){},transaction(fn){const p=lock.then(()=>fn(s));lock=p.catch(()=>{});return p}};return s}
async function world(){
 const storage=memory(),effects=[],deletes=[];let block=null,waiting=false,release;
 class Fixture extends S.State{async daytona(){return{api:'https://provider.invalid',key:'fixture'}}}
 const env={ORIGIN:'https://admin.invalid',LAB_ORIGIN:'https://lab.invalid',LAB_SEAT_DOMAIN:'seat.invalid'},fresh=()=>new Fixture({storage,waitUntil(){},blockConcurrencyWhile:f=>f()},env),state=fresh();
 const lab={id:'lab',name:'야간반',snapshot:'v5',model:'fixture',cpu:1,memory:2,disk:3,budget:1,gw:'https://gw.invalid',expiresAt:Date.now()+3600000,seats:[1,2].map(n=>({n,code:('code-'+n).padEnd(16,'x'),sandboxId:'sb-'+n,label:'label-'+n,setup:{state:'ok',at:Date.now(),note:''}}))};
 await storage.put('lab:lab',lab);for(const seat of lab.seats)await storage.put('seat:'+seat.code,{lab:'lab',n:seat.n});
 for(const token of['admin','other'])await storage.put('admin:'+await S.sha(token),{expiresAt:Date.now()+600000});
 globalThis.fetch=async(input,init={})=>{const u=new URL(input),method=init.method??'GET';
  if(u.host==='provider.invalid'&&u.pathname.startsWith('/sandbox/')){
   if(method==='DELETE'){deletes.push(u.pathname);return Response.json({})}
   if(block==='lookup'&&!waiting){waiting=true;await new Promise(r=>release=r);block=null}
   return Response.json({id:u.pathname.split('/')[2],state:'started',toolboxProxyUrl:'https://toolbox.invalid'});
  }
  if(u.host==='provider.invalid'&&u.pathname==='/sandbox')return Response.json({items:[]});
  if(u.host==='toolbox.invalid'&&method==='POST'){
   const cmd=JSON.parse(init.body).command,encoded=cmd.match(/Buffer.from\("([^"]+)"/),script=encoded?Buffer.from(encoded[1],'base64').toString():cmd;
   const interrupt=script.includes("'C-c'"),inspect=script.includes('function inspect()');effects.push({sandbox:u.pathname.split('/')[1],script,interrupt,inspect});
   if(interrupt&&block==='execute'&&!waiting){waiting=true;await new Promise(r=>release=r);block=null}
   return Response.json({exitCode:0,result:interrupt?(w.changed?'CHANGED':'SENT'):inspect?JSON.stringify({fingerprint:'a'.repeat(64),paneId:'%1',program:'opencode'}):script.includes('has-session')?'READY':'SENT'});
  }throw Error('fixture rejected network '+u.href);
 };
 const w={state,fresh,storage,effects,deletes,env,changed:false,block(phase){block=phase;waiting=false},release(){release()},async held(){const end=Date.now()+2000;while(!waiting&&Date.now()<end)await new Promise(r=>setTimeout(r,2));assert.ok(waiting,'reached held external lookup/effect')},
  async start(){const r=await state.labTerminalStart('admin','lab',uuid(1),[1,2],0);assert.equal(r.active,true,JSON.stringify(r));return uuid(1)},
  async pause(){const r=await state.labControlPause('admin','lab',uuid(2));assert.equal(r.mode,'paused');return r},
  async preview(seats=[1,2]){const r=await state.labInterruptPreview('admin','lab',crypto.randomUUID(),seats,1);assert.ok(!r.error,JSON.stringify(r));return r},
  inputs(){return effects.filter(x=>x.interrupt)}};return w;
}
let passed=0;async function test(name,fn){await fn();passed++;console.log('ok',name)}
await test('requires paused state, exact revision and explicit selected teaching seats',async()=>{
 const w=await world();await w.start();assert.equal((await w.state.labInterruptPreview('admin','lab',uuid(3),[1],0)).status,409);await w.pause();
 assert.equal((await w.state.labInterruptPreview('admin','lab',uuid(3),[1],0)).status,409);const p=await w.preview([2]);assert.deepEqual(p.targets,[{n:2,program:'opencode'}]);assert.equal(w.inputs().length,0);
 const r=await w.state.labInterruptRequest('admin','lab',p.previewId,uuid(4));assert.deepEqual(r.results.map(x=>x.n),[2]);assert.equal(r.results[0].status,'sent');assert.equal(w.inputs()[0].sandbox,'sb-2');assert.equal(w.deletes.length,0);
 assert.equal((await w.state.labControlStatus('admin','lab')).mode,'paused');
});
await test('inactive transmission session still has a scoped teaching program',async()=>{const w=await world(),sid=await w.start();await w.state.labTerminalStop('admin','lab',sid);await w.pause();const p=await w.preview([1]);const r=await w.state.labInterruptRequest('admin','lab',p.previewId,uuid(4));assert.equal(r.results[0].status,'sent');assert.equal(w.inputs().length,1)});
for(const reason of['resume','owner','other selected sandbox','materials','expired admin','end'])await test('final effect fence rejects '+reason+' while provider lookup is held',async()=>{
 const w=await world(),sid=await w.start();await w.pause();const p=await w.preview();w.block('lookup');const sending=w.state.labInterruptRequest('admin','lab',p.previewId,uuid(4));await w.held();
 if(reason==='resume')await w.state.labControlResume('admin','lab',uuid(6),1);
 else if(reason==='owner')await w.state.labTerminalTakeover('other','lab',sid);
 else if(reason==='expired admin')await w.storage.delete('admin:'+await S.sha('admin'));
 else if(reason==='end')await w.state.labEnd('admin','lab');
 else{const lab=await w.storage.get('lab:lab');if(reason==='materials')lab.materials='https://materials.invalid/new.zip';else lab.seats[1].sandboxId='replacement';await w.storage.put('lab:lab',lab)}
 w.release();await sending;assert.equal(w.inputs().length,0);
});
await test('same ID after resume/expiry/reconstruction only reads old result',async()=>{
 const w=await world();await w.start();await w.pause();const p=await w.preview([1]);const first=await w.state.labInterruptRequest('admin','lab',p.previewId,uuid(4));assert.equal(first.results[0].status,'sent');
 await w.state.labControlResume('admin','lab',uuid(6),1);const before=w.effects.length,original=Date.now;Date.now=()=>original()+61000;
 try{const r=await w.fresh().labInterruptRequest('admin','lab',p.previewId,uuid(4));assert.deepEqual(r,first);assert.equal(w.effects.length,before)}finally{Date.now=original}
});
await test('revoked admin during receipt read cannot receive an old result',async()=>{
 const w=await world();await w.start();await w.pause();const p=await w.preview([1]);await w.state.labInterruptRequest('admin','lab',p.previewId,uuid(4));
 const before=w.effects.length,key='labint:o:lab:'+uuid(4);w.storage.onGet=async k=>{if(k===key)await w.storage.delete('admin:'+await S.sha('admin'))};
 assert.equal((await w.state.labInterruptRequest('admin','lab',p.previewId,uuid(4))).status,401);assert.equal(w.effects.length,before);
});
await test('preview expiry during claim validation stores no action and sends nothing',async()=>{
 const w=await world();await w.start();await w.pause();const p=await w.preview([1]),original=Date.now;let advanced=false;
 w.storage.onGet=async k=>{if(Array.isArray(k)&&k.includes('labctrl:lab')&&!advanced){advanced=true;Date.now=()=>original()+61000}};
 try{const r=await w.state.labInterruptRequest('admin','lab',p.previewId,uuid(4));assert.equal(r.status,410);assert.equal(w.inputs().length,0);assert.ok(!await w.storage.get('labint:o:lab:'+uuid(4)))}finally{Date.now=original}
});
await test('uncertain transaction commit is unknown on same-instance retry, never permanently live',async()=>{
 const w=await world();await w.start();await w.pause();const p=await w.preview([1]),transaction=w.storage.transaction.bind(w.storage);let fail=true;
 w.storage.transaction=fn=>transaction(async tx=>{const r=await fn(tx);if(fail&&r?.replay===false){fail=false;throw Error('commit acknowledgement lost')}return r});
 assert.equal((await w.state.labInterruptRequest('admin','lab',p.previewId,uuid(4))).status,503);
 const r=await w.state.labInterruptRequest('admin','lab',p.previewId,uuid(4));assert.equal(r.results[0].status,'unknown');assert.equal(w.inputs().length,0);
});
await test('reconstructed pending never causes another Ctrl+C',async()=>{
 const w=await world();await w.start();await w.pause();const p=await w.preview();w.block('execute');const sending=w.state.labInterruptRequest('admin','lab',p.previewId,uuid(4));await w.held();const before=w.effects.length;
 const r=await w.fresh().labInterruptRequest('admin','lab',p.previewId,uuid(4));assert.ok(r.results.some(x=>x.status==='unknown'));assert.equal(w.effects.length,before);w.release();await sending;
});
await test('changed pane proof is a non-delivery result and not a program kill',async()=>{const w=await world();await w.start();await w.pause();const p=await w.preview([1]);w.changed=true;const r=await w.state.labInterruptRequest('admin','lab',p.previewId,uuid(4));assert.equal(r.results[0].status,'changed');assert.equal(w.deletes.length,0);assert.ok(w.inputs()[0].script.includes("'C-c'"));assert.ok(!w.inputs()[0].script.includes('kill-server'))});
await test('end during accepted first effect blocks later selected targets',async()=>{
 const w=await world();await w.start();await w.pause();const p=await w.preview();w.block('execute');const sending=w.state.labInterruptRequest('admin','lab',p.previewId,uuid(4));await w.held();await w.state.labEnd('admin','lab');w.release();await sending;assert.equal(w.inputs().length,1);
});
await test('read-only monitor token and foreign origin cannot invoke interruption',async()=>{
 const w=await world();await w.start();await w.pause();await w.storage.put('teacher:'+await S.sha('viewer'),{createdAt:Date.now(),expiresAt:Date.now()+3600000});assert.equal((await w.state.labInterruptPreview('viewer','lab',uuid(3),[1],1)).status,401);
 for(const path of['/api/lab/interrupt/preview','/api/lab/interrupt/request'])for(const[admin,origin,expected]of[['','https://admin.invalid',401],['admin','https://evil.invalid',403]]){
  const c={path,admin,env:w.env,state:w.state,req:new Request('https://admin.invalid'+path,{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({id:'lab',previewId:uuid(3),requestId:uuid(4),seats:[1],expectedRevision:1})}),json:(v,status=200)=>Response.json(v,{status}),out:v=>Response.json(v,{status:v.status??200})};assert.equal((await A.labInterruptApi(c)).status,expected);
 }assert.equal(w.inputs().length,0);
});
console.log('PASS interrupt real State/API',passed);
