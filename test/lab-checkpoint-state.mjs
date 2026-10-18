// Real State + export/receipt integration; provider I/O is a strict local fixture.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const b=await build({entryPoints:['src/state.ts'],bundle:true,write:false,platform:'node',format:'esm',external:['cloudflare:workers'],logLevel:'silent'});
const code=b.outputFiles[0].text.replace(/import\s*\{\s*DurableObject\s*\}\s*from\s*["']cloudflare:workers["'];?/,'class DurableObject{constructor(ctx,env){this.ctx=ctx;this.env=env}}'),S=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
const uuid=n=>'a0000000-0000-4000-8000-'+n.toString(16).padStart(12,'0');
function memory(){const data=new Map(),copy=x=>x===undefined?x:structuredClone(x);let lock=Promise.resolve();const s={data,async get(k){return Array.isArray(k)?new Map(k.filter(x=>data.has(x)).map(x=>[x,copy(data.get(x))])):copy(data.get(k))},async put(k,v){if(typeof k==='object')for(const[a,b]of Object.entries(k))data.set(a,copy(b));else data.set(k,copy(v))},async delete(k){for(const x of Array.isArray(k)?k:[k])data.delete(x)},async list({prefix='',limit=Infinity}={}){return new Map([...data].filter(([k])=>k.startsWith(prefix)).slice(0,limit).map(([k,v])=>[k,copy(v)]))},async getAlarm(){return null},async setAlarm(){},transaction(fn){const p=lock.then(()=>fn(s));lock=p.catch(()=>{});return p}};return s}
async function world(){const storage=memory(),effects=[],tasks=[];let block=null,waiting=false,release;
 class Fixture extends S.State{async daytona(){return{api:'https://provider.invalid',key:'fixture'}}exportTtl(){return{ticket:60000,stream:60000,pack:60000,cooldown:0}}}
 const env={ORIGIN:'https://admin.invalid',LAB_ORIGIN:'https://lab.invalid',LAB_SEAT_DOMAIN:'seat.invalid'},fresh=()=>new Fixture({storage,waitUntil:p=>tasks.push(p),blockConcurrencyWhile:f=>f()},env),state=fresh();
 const lab={id:'lab',name:'night',snapshot:'v5',model:'fixture',cpu:1,memory:2,disk:3,budget:1,gw:'https://gw.invalid',expiresAt:Date.now()+3600000,seats:[1,2].map(n=>({n,code:('code-'+n).padEnd(16,'x'),sandboxId:'sb-'+n,label:'label-'+n}))};
 await storage.put('lab:lab',lab);for(const seat of lab.seats)await storage.put('seat:'+seat.code,{lab:'lab',n:seat.n});await storage.put('admin:'+await S.sha('admin'),{expiresAt:Date.now()+600000});
 async function hold(kind){if(block===kind&&!waiting){waiting=true;await new Promise(r=>release=r);block=null}}
 globalThis.fetch=async(input,init={})=>{const u=new URL(input),method=init.method??'GET';
  if(u.host==='provider.invalid'&&u.pathname.startsWith('/sandbox/')){if(method==='DELETE'){effects.push({kind:'delete'});return Response.json({})}await hold('lookup');return Response.json({id:u.pathname.split('/')[2],state:'started',toolboxProxyUrl:'https://toolbox.invalid'})}
  if(u.host==='provider.invalid'&&u.pathname==='/sandbox')return Response.json({items:[]});
  if(u.host==='toolbox.invalid'&&u.pathname.endsWith('/files/upload')){effects.push({kind:'upload',sb:u.pathname.split('/')[1]});await hold('upload');return new Response('')}
  if(u.host==='toolbox.invalid'&&u.pathname.endsWith('/process/execute')){const command=JSON.parse(init.body).command,kind=command.includes('mkdir -m 700')?'mkdir':command.includes('timeout -k')?'pack':'cleanup';effects.push({kind,sb:u.pathname.split('/')[1],command});await hold(kind);return Response.json({exitCode:0,result:kind==='pack'?'OK 2 4 0 20':'OK'})}
  if(u.host==='toolbox.invalid'&&u.pathname.endsWith('/files/download')){effects.push({kind:'download',sb:u.pathname.split('/')[1],path:u.searchParams.get('path')});return new Response(new Uint8Array(20))}
  throw Error('fixture rejected network '+u.href);
 };
 return{state,fresh,storage,lab,effects,async pause(){const r=await state.labControlPause('admin','lab',uuid(1));assert.equal(r.revision,1)},async create(rid=uuid(2),seats=[1,2]){const r=await state.labCheckpointCreate('admin','lab',rid,seats,1);assert.ok(!r.error,JSON.stringify(r));return r},block(kind){block=kind;waiting=false},release(){release()},async held(){const end=Date.now()+2000;while(!waiting&&Date.now()<end)await new Promise(r=>setTimeout(r,2));assert.ok(waiting)},async settle(){await Promise.all(tasks)}};
}
let passed=0;async function test(name,fn){await fn();passed++;console.log('ok',name)}
await test('paused explicit checkpoint targets need no active teaching terminal',async()=>{const w=await world();assert.equal((await w.state.labCheckpointCreate('admin','lab',uuid(2),[1],0)).status,409);await w.pause();const r=await w.create(uuid(2),[2]);assert.equal(r.results[0].status,'ready');assert.deepEqual(w.effects.map(x=>[x.kind,x.sb]),[['mkdir','sb-2'],['upload','sb-2'],['pack','sb-2']]);const p=w.effects.find(x=>x.kind==='pack');assert.ok(p.command.includes('67108864 4000 30'));assert.ok(!p.command.includes('rm -rf'))});
for(const phase of['lookup','mkdir','upload'])for(const reason of['resume','revoke','other seat replacement','end'])await test('final checkpoint effect fence after '+phase+' / '+reason,async()=>{
 const w=await world();await w.pause();w.block(phase);const creating=w.state.labCheckpointCreate('admin','lab',uuid(2),[1,2],1);await w.held();const before=w.effects.filter(x=>['mkdir','upload','pack'].includes(x.kind)).length;
 if(reason==='resume')await w.state.labControlResume('admin','lab',uuid(3),1);
 else if(reason==='revoke')await w.storage.delete('admin:'+await S.sha('admin'));
 else if(reason==='end')await w.state.labEnd('admin','lab');
 else{const lab=await w.storage.get('lab:lab');lab.seats[1].sandboxId='replacement';await w.storage.put('lab:lab',lab)}
 w.release();await creating;assert.equal(w.effects.filter(x=>['mkdir','upload','pack'].includes(x.kind)).length,before);
});
await test('same receipt survives resume and State reconstruction without new archive effects',async()=>{const w=await world();await w.pause();const r=await w.create();await w.state.labControlResume('admin','lab',uuid(3),1);const count=w.effects.length;assert.deepEqual(await w.fresh().labCheckpointCreate('admin','lab',uuid(2),[1,2],1),r);assert.equal(w.effects.length,count)});
await test('a participant can list and export only its own current ready checkpoint',async()=>{
 const w=await world();await w.pause();await w.create(uuid(2),[1]);await w.create(uuid(4),[2]);const first=w.lab.seats[0].code,second=w.lab.seats[1].code;
 assert.deepEqual((await w.state.labCheckpointFor(first)).checkpoints.map(x=>x.requestId),[uuid(2)]);assert.deepEqual((await w.state.labCheckpointFor(second)).checkpoints.map(x=>x.requestId),[uuid(4)]);assert.equal((await w.state.labExportStart(first,uuid(4))).status,409);
 const r=await w.state.labExportStart(first,uuid(2));assert.ok(!r.error,JSON.stringify(r));assert.equal((await w.state.labFileAcknowledge(first,r.receiptId)).status,409);const before=w.effects.length,response=await w.state.labExportDownload(first,r.ticket);await response.arrayBuffer();await w.settle();
 const extra=w.effects.slice(before);assert.deepEqual(extra.map(x=>x.kind),['download']);assert.equal(extra[0].path,'/home/daytona/.gw-export/'+uuid(2)+'/work.zip');assert.equal((await w.state.labFileReceipt(first)).transfer.verifiedAt,null);
 const ack=await w.state.labFileAcknowledge(first,r.receiptId);assert.ok(ack.transfer.verifiedAt);assert.deepEqual(await w.state.labFileAcknowledge(first,r.receiptId),ack);assert.equal((await w.state.labCheckpointFor(first)).checkpoints.length,1);
 const adminView=await w.state.labList('admin'),fileView=adminView.labs[0].seats[0].files;assert.deepEqual(Object.keys(fileView).sort(),['at','verifiedAt']);assert.equal(fileView.verifiedAt,ack.transfer.verifiedAt);assert.equal(adminView.labs[0].seats[1].files,null);
 const lab=await w.storage.get('lab:lab');lab.seats[0].sandboxId='replacement';await w.storage.put('lab:lab',lab);assert.equal((await w.state.labCheckpointFor(first)).checkpoints.length,0);assert.equal((await w.state.labFileReceipt(first)).transfer,null);assert.equal((await w.state.labExportStart(first,uuid(2))).status,409);
});
await test('invalid archive metadata or pending intent is never offered as a saved file',async()=>{const w=await world();await w.pause();await w.create(uuid(2),[1]);const key='labckpt:lab:'+uuid(2),row=await w.storage.get(key);row.results[0].size=Number.MAX_SAFE_INTEGER;await w.storage.put(key,row);assert.equal((await w.state.labCheckpointFor(w.lab.seats[0].code)).checkpoints.length,0);assert.equal((await w.state.labExportStart(w.lab.seats[0].code,uuid(2))).status,409)});
console.log('PASS checkpoint real State/export preservation',passed);
