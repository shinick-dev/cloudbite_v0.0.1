// No provider/network: verify transfer receipts, human acknowledgments and retained ZIPs.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
async function bundle(entry){const b=await build({entryPoints:[entry],bundle:true,write:false,platform:'node',format:'esm',logLevel:'silent'});return import('data:text/javascript;base64,'+Buffer.from(b.outputFiles[0].text).toString('base64'))}
const {LabFileReceiptService}=await bundle('src/lab-file-receipt-service.ts'),{LabExportService}=await bundle('src/lab-export-service.ts');
const uuid=n=>'80000000-0000-4000-8000-'+n.toString(16).padStart(12,'0'),ref={labId:'lab',n:1,code:'code000000000001',sandboxId:'sb-1'};
function memory(){const data=new Map(),copy=x=>x===undefined?x:structuredClone(x);let lock=Promise.resolve();const s={data,async get(k){return copy(data.get(k))},async put(k,v){if(typeof k==='object')for(const[a,b]of Object.entries(k))data.set(a,copy(b));else data.set(k,copy(v))},async delete(k){for(const x of Array.isArray(k)?k:[k])data.delete(x)},async list({prefix=''}={}){return new Map([...data].filter(([k])=>k.startsWith(prefix)).map(([k,v])=>[k,copy(v)]))},transaction(fn){const p=lock.then(()=>fn(s));lock=p.catch(()=>{});return p}};return s}
function receipts(){let time=Date.now(),current={...ref};const storage=memory(),service=new LabFileReceiptService({storage,now:()=>time,ref:async()=>current?{...current}:{status:410,error:'ended'}});return{storage,service,advance(n=10){time+=n},set ref(v){current=v},get now(){return time},item(n=1){return{...ref,id:uuid(n),startedAt:time}}}}
let passed=0;async function test(name,fn){await fn();passed++;console.log('ok',name)}
await test('transfer and human ZIP verification are separate, idempotent records',async()=>{
 const w=receipts();assert.equal((await w.service.acknowledge(ref.code,uuid(1))).status,409);await w.service.transferred(w.item());
 const before=await w.service.read(ref.code);assert.equal(before.transfer.verifiedAt,null);w.advance();const ack=await w.service.acknowledge(ref.code,uuid(1));assert.equal(ack.transfer.verifiedAt,w.now);w.advance();assert.deepEqual(await w.service.acknowledge(ref.code,uuid(1)),ack);
 assert.deepEqual(Object.keys(ack.transfer).sort(),['at','checkpoint','id','verifiedAt']);
});
await test('newer download clears old verification; older completion cannot replace it',async()=>{
 const w=receipts(),old=w.item(1);await w.service.transferred(old);await w.service.acknowledge(ref.code,uuid(1));w.advance();await w.service.transferred(w.item(2));assert.equal((await w.service.read(ref.code)).transfer.verifiedAt,null);await w.service.transferred(old);assert.equal((await w.service.read(ref.code)).transfer.id,uuid(2));assert.equal((await w.service.acknowledge(ref.code,uuid(1))).status,409);
});
await test('seat replacement/end invalidates old transfer and acknowledgment',async()=>{
 const w=receipts();await w.service.transferred(w.item());w.ref={...ref,sandboxId:'new-sb'};assert.equal((await w.service.read(ref.code)).transfer,null);assert.equal((await w.service.acknowledge(ref.code,uuid(1))).status,409);w.ref=null;assert.equal((await w.service.acknowledge(ref.code,uuid(1))).status,410);
});
await test('invalid/future transfer metadata and raw storage errors do not create confirmations',async()=>{
 const w=receipts();await w.service.transferred({...w.item(),startedAt:w.now+100});assert.equal((await w.service.read(ref.code)).transfer,null);assert.equal((await w.service.acknowledge(ref.code,'bad')).status,400);w.storage.get=async()=>{throw Error('secret token and path')};const r=await w.service.read(ref.code);assert.equal(r.status,503);assert.ok(!r.error.includes('secret'));
});
async function exportsWorld(mode='normal'){
 const storage=memory(),tasks=[],commands=[],transfers=[],files=receipts();let size=20,declared=null,allow=true;
 const deps={storage,waitUntil:p=>tasks.push(p),seatOf:async()=>({lab:{id:'lab',name:'night'},seat:{n:1,sandboxId:'sb-1'}}),daytona:async()=>({api:'https://provider.invalid',key:'fixture'}),schedule:async()=>{},audit:async()=>{},ttl:()=>({ticket:60000,stream:60000,pack:60000,cooldown:0}),limits:()=>({bytes:1000,entries:100,seconds:1}),zipMax:()=>10000,
  checkpoint:async(code,id)=>({...ref,id,entries:2,bytes:4,skipped:0,size:20}),perform:async(code,sb,effect)=>{if(!allow)throw Error('changed');return effect()},transferred:async item=>{transfers.push(item);files.advance(Math.max(0,Date.now()-files.now)+1);await files.service.transferred(item)}};
 const make=()=>new LabExportService(deps),service=make();
 globalThis.fetch=async(input,init={})=>{const u=new URL(input);
  if(u.host==='provider.invalid'&&u.pathname==='/sandbox/sb-1')return Response.json({id:'sb-1',state:'started',toolboxProxyUrl:'https://toolbox.invalid'});
  if(u.host==='toolbox.invalid'&&u.pathname.endsWith('/process/execute')){const command=JSON.parse(init.body).command;commands.push(command);return Response.json({exitCode:0,result:command.includes('timeout -k')?'OK 2 4 0 20':'OK'})}
  if(u.host==='toolbox.invalid'&&u.pathname.endsWith('/files/upload')){commands.push('UPLOAD');return new Response('')}
  if(u.host==='toolbox.invalid'&&u.pathname.endsWith('/files/download')){commands.push('DOWNLOAD '+u.searchParams.get('path'));return new Response(new Uint8Array(size),{headers:declared===null?{}:{'content-length':String(declared)}})}
  throw Error('forbidden fixture network '+u.href);
 };
 return{service,make,commands,transfers,files,storage,set size(n){size=n},set declared(n){declared=n},set allow(v){allow=v},async start(){const r=await service.start(ref.code,mode==='checkpoint'?uuid(9):undefined);assert.ok(!r.error,JSON.stringify(r));return r},async settle(){await Promise.all(tasks)}};
}
await test('normal exact-byte transfer records completion; ticket is one-use and ZIP confirmation stays manual',async()=>{
 const w=await exportsWorld(),r=await w.start();assert.equal((await w.files.service.read(ref.code)).transfer,null);const response=await w.service.download(ref.code,r.ticket);assert.equal((await response.arrayBuffer()).byteLength,20);await w.settle();assert.equal(w.transfers.length,1);assert.equal((await w.files.service.read(ref.code)).transfer.verifiedAt,null);assert.equal((await w.service.download(ref.code,r.ticket)).status,410);
});
await test('downloading a checkpoint never repacks or deletes the retained original',async()=>{
 const w=await exportsWorld('checkpoint'),r=await w.start();assert.equal(w.commands.length,0);const response=await w.service.download(ref.code,r.ticket);await response.arrayBuffer();await w.settle();assert.equal(w.transfers[0].checkpointId,uuid(9));assert.deepEqual(w.commands,['DOWNLOAD /home/daytona/.gw-export/'+uuid(9)+'/work.zip']);assert.equal([...w.storage.data.keys()].filter(k=>k.startsWith('expq:')).length,0);
});
for(const mode of['short','oversize','cancel','declared oversize'])await test(mode+' stream never becomes a completed transfer',async()=>{
 const w=await exportsWorld('checkpoint'),r=await w.start();if(mode==='short')w.size=19;if(mode==='oversize')w.size=21;if(mode==='declared oversize')w.declared=21;
 const response=await w.service.download(ref.code,r.ticket);if(mode==='cancel')await response.body.cancel();else if(mode==='declared oversize')assert.equal(response.status,502);else await assert.rejects(()=>response.arrayBuffer());await w.settle();assert.equal(w.transfers.length,0);assert.equal((await w.files.service.read(ref.code)).transfer,null);assert.ok(w.commands.every(c=>!c.includes('rm -rf')));
});
await test('final seat guard can deny archive effects without touching files',async()=>{const w=await exportsWorld();w.allow=false;const r=await w.service.start(ref.code);assert.ok(r.error);assert.ok(!w.commands.includes('UPLOAD'));assert.ok(!w.commands.some(c=>c.includes('timeout -k')))});
console.log('PASS file-preservation receipts/streaming',passed);
