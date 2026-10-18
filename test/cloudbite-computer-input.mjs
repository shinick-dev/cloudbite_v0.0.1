import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import{join}from'node:path';import{pathToFileURL}from'node:url';
const dir=await mkdtemp(join(tmpdir(),'cb-input-'));
try{
 const b=await build({entryPoints:['src/cloudbite-computer-input.ts'],bundle:true,write:false,platform:'node',format:'esm',plugins:[{name:'workers',setup(x){
  x.onResolve({filter:/^cloudflare:workers$/},()=>({path:'workers',namespace:'test'}));
  x.onLoad({filter:/.*/,namespace:'test'},()=>({contents:'export class DurableObject{constructor(ctx,env){this.ctx=ctx;this.env=env;}}'}));
 }}]});
 const file=join(dir,'input.mjs');await writeFile(file,b.outputFiles[0].text);
 const {ComputerInputService,CloudbiteComputerInput,parseInput,toolboxBase,INPUT_ERRORS}=await import(pathToFileURL(file));
 const KEY='dtn_secret_key_value',API='https://app.daytona.io/api',BOX='https://proxy.app.daytona.io/toolbox';
 const env={CLOUDBITE_DAYTONA_API_KEY:KEY,CLOUDBITE_DAYTONA_SECONDARY_API_KEY:'dtn_second'};
 const labels={'cloudbite-computer':'abcdef0123456789','cloudbite-computer-account':'primary'};
 const target={id:'sb-1',account:'primary',name:'cloudbite-computer-primary-abcdef0123456789',labels,status:'running'};
 const mem=()=>{const m=new Map();return{m,get:async k=>m.get(k),put:async(k,v)=>{m.set(k,structuredClone(v));},delete:async k=>m.delete(k),list:async({prefix})=>new Map([...m].filter(([k])=>k.startsWith(prefix)))};};
 let calls,sandbox,reply;
 const transport=async(url,init)=>{calls.push({url,method:init.method,auth:init.headers.authorization,body:init.body?JSON.parse(init.body):undefined,signal:!!init.signal});
  if(url===`${API}/sandbox/sb-1`)return Response.json(sandbox);
  const r=reply(url);if(r instanceof Error)throw r;return r;};
 const reset=()=>{calls=[];sandbox={id:'sb-1',name:target.name,labels:{...labels,extra:'x'},state:'started',toolboxProxyUrl:BOX};reply=()=>new Response('{}');};
 const keyCalls=()=>calls.filter(c=>c.url.includes('/computeruse/'));
 const uuid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
 const SECRET='비밀번호 hunter2\twith\nnewline';

 // Exact verified REST path + body, Unicode, Bearer only to provider, bounded timeout.
 reset();let st=mem(),svc=new ComputerInputService(st,env,transport);
 let r=await svc.send(target,{requestId:uuid(1),text:SECRET,enter:true});
 assert.deepEqual(r,{ok:true,outcome:'sent',replay:false});
 assert.deepEqual(calls.map(c=>[c.method,c.url]),[['GET',`${API}/sandbox/sb-1`],['POST',`${BOX}/sb-1/computeruse/keyboard/type`],['POST',`${BOX}/sb-1/computeruse/keyboard/key`]]);
 assert.deepEqual(calls[1].body,{text:SECRET});assert.deepEqual(calls[2].body,{key:'enter',modifiers:[]});
 assert.ok(calls.every(c=>c.auth===`Bearer ${KEY}`&&c.signal&&!c.url.includes(KEY)));
 // Ledger holds no plaintext text or key; result carries neither.
 const dump=JSON.stringify([...st.m]);for(const s of ['hunter2','비밀번호','🔑',KEY])assert.ok(!dump.includes(s),s);
 assert.equal([...st.m.values()][0].phase,'sent');assert.ok(!JSON.stringify(r).includes('hunter2'));

 reset();const unsupported=await svc.send(target,{requestId:uuid(999),text:'🎉'});assert.equal(unsupported.error.code,'unsupported_text');assert.equal(calls.length,0);
 // Same id + same payload replays without typing; other payload conflicts.
 calls=[];r=await svc.send(target,{requestId:uuid(1),text:SECRET,enter:true});assert.deepEqual(r,{ok:true,outcome:'sent',replay:true});assert.equal(calls.length,0);
 r=await svc.send(target,{requestId:uuid(1),text:SECRET,enter:false});assert.equal(r.error.code,'request_conflict');assert.equal(r.status,409);assert.equal(calls.length,0);
 r=await svc.send({...target,id:'sb-2'},{requestId:uuid(1),text:SECRET,enter:true});assert.equal(r.error.code,'request_conflict');

 // Empty text + Enter only presses Enter.
 calls=[];r=await svc.send(target,{requestId:uuid(2),text:'',enter:true});assert.equal(r.ok,true);assert.deepEqual(keyCalls().map(c=>c.url),[`${BOX}/sb-1/computeruse/keyboard/key`]);

 // Validation: bad types, NUL, lone surrogate, size limits, nothing to send.
 calls=[];
 for(const bad of [{requestId:'x',text:'a'},{requestId:uuid(3),text:1},{requestId:uuid(3),text:'a',enter:'yes'},{requestId:uuid(3),text:'a\0b'},{requestId:uuid(3),text:'\uD800'},{requestId:uuid(3),text:'a'.repeat(4001)},{requestId:uuid(3),text:'가'.repeat(3999)+'🔑🔑'.repeat(1)},{requestId:uuid(3),text:''},{requestId:uuid(3)}]){
  const x=await svc.send(target,bad);assert.equal(x.error?.code,'bad_request',JSON.stringify(bad).slice(0,40));assert.equal(x.status,400);}
 assert.equal(calls.length,0);
 assert.ok(parseInput({requestId:uuid(3),text:'한글 😀\t\n  x'}));assert.equal(parseInput({requestId:uuid(3),text:'가'.repeat(4000)})?.text.length,4000);
 assert.equal(parseInput({requestId:uuid(3),text:'😀'.repeat(2001)}),null); // 4002 UTF-16 units
 // 16 KiB UTF-8 bound: 4000 chars of 4-byte-in-pairs is caught by char cap; 3-byte Hangul 4000 = 12000 bytes passes.

 // Wrong labels / name / id / account / not running / bad toolbox URL: no keyboard call, no ledger entry.
 const noInput=async(mut,code,t=target)=>{reset();mut();const s=mem(),v=new ComputerInputService(s,env,transport);const x=await v.send(t,{requestId:uuid(9),text:'pw'});assert.equal(x.error?.code,code);assert.equal(keyCalls().length,0);assert.equal(s.m.size,0);};
 await noInput(()=>{sandbox.labels={...labels,'cloudbite-computer-account':'secondary'};},'target_mismatch');
 await noInput(()=>{delete sandbox.labels['cloudbite-computer'];},'target_mismatch');
 await noInput(()=>{sandbox.name='other';},'target_mismatch');
 await noInput(()=>{sandbox.id='sb-9';},'target_mismatch');
 await noInput(()=>{sandbox.state='stopped';},'not_running');
 await noInput(()=>{},'not_running',{...target,status:'stopped'});
 await noInput(()=>{},'not_configured',{...target,account:'tertiary'});
 for(const u of ['http://proxy.app.daytona.io/toolbox','https://u:p@proxy.app.daytona.io/t','https://proxy.app.daytona.io/t?x=1','https://evil.example/toolbox','https://daytona.io.evil.com/t','https://proxy.app.daytona.io:8443/t'])
  await noInput(()=>{sandbox.toolboxProxyUrl=u;},'target_mismatch');
 await noInput(()=>{sandbox=null;},'provider_error');
 assert.equal(toolboxBase('https://x.daytonaproxy01.net/toolbox/'),'https://x.daytonaproxy01.net/toolbox');
 // Missing toolboxProxyUrl: SDK reads GET /sandbox/{id}/toolbox-proxy-url.
 reset();delete sandbox.toolboxProxyUrl;reply=u=>u===`${API}/sandbox/sb-1/toolbox-proxy-url`?Response.json({url:'https://p2.daytona.io/toolbox'}):new Response('{}');
 r=await new ComputerInputService(mem(),env,transport).send(target,{requestId:uuid(4),text:'a'});assert.equal(r.ok,true);assert.equal(keyCalls()[0].url,'https://p2.daytona.io/toolbox/sb-1/computeruse/keyboard/type');
 // Secondary account uses its own key.
 reset();r=await new ComputerInputService(mem(),env,transport).send({...target,account:'secondary'},{requestId:uuid(5),text:'a'});assert.ok(calls.every(c=>c.auth==='Bearer dtn_second'));

 // Uncertain outcomes become delivery_unknown and never type again.
 for(const fail of [()=>new Response('',{status:502}),()=>new Error('timeout'),()=>new Response('',{status:408})]){
  reset();st=mem();svc=new ComputerInputService(st,env,transport);reply=fail;
  r=await svc.send(target,{requestId:uuid(6),text:'pw'});assert.deepEqual(r,{error:{code:'delivery_unknown',message:INPUT_ERRORS.delivery_unknown},status:409});
  reply=()=>new Response('{}');calls=[];r=await svc.send(target,{requestId:uuid(6),text:'pw'});assert.equal(r.error.code,'delivery_unknown');assert.equal(calls.length,0);
  assert.equal([...st.m.values()][0].phase,'unknown');}
 // Partial: text typed, Enter refused (even definitive 4xx) -> unknown, not rejected, no retype.
 reset();st=mem();svc=new ComputerInputService(st,env,transport);reply=u=>u.endsWith('/key')?new Response('',{status:400}):new Response('{}');
 r=await svc.send(target,{requestId:uuid(7),text:'pw',enter:true});assert.equal(r.error.code,'delivery_unknown');
 calls=[];assert.equal((await svc.send(target,{requestId:uuid(7),text:'pw',enter:true})).error.code,'delivery_unknown');assert.equal(calls.length,0);
 // Definitive 4xx on the first mutation -> stable rejected, replayed without a call.
 reset();st=mem();svc=new ComputerInputService(st,env,transport);reply=()=>new Response('',{status:400});
 r=await svc.send(target,{requestId:uuid(8),text:'pw'});assert.deepEqual(r,{error:{code:'input_rejected',message:INPUT_ERRORS.input_rejected},status:422});
 calls=[];assert.equal((await svc.send(target,{requestId:uuid(8),text:'pw'})).error.code,'input_rejected');assert.equal(calls.length,0);

 // Reconstruction: a 'sending' entry persisted by an evicted instance stays unknown.
 reset();st=mem();let hang;reply=()=>new Promise(()=>{});
 const first=new ComputerInputService(st,env,(u,i)=>{if(u.includes('/computeruse/')){hang=true;return new Promise(()=>{});}return transport(u,i);});
 first.send(target,{requestId:uuid(10),text:'pw'});for(let i=0;i<20&&!hang;i++)await new Promise(s=>setTimeout(s,5));
 assert.equal([...st.m.values()][0].phase,'sending');
 reply=()=>new Response('{}');calls=[];const second=new ComputerInputService(st,env,transport);
 r=await second.send(target,{requestId:uuid(10),text:'pw'});assert.equal(r.error.code,'delivery_unknown');assert.equal(calls.length,0);assert.equal([...st.m.values()][0].phase,'unknown');

 // Serialized: concurrent sends never overlap keyboard calls.
 reset();let active=0,peak=0;const slow=async(u,i)=>{if(u.includes('/computeruse/')){active++;peak=Math.max(peak,active);await new Promise(s=>setTimeout(s,5));active--;return new Response('{}');}return transport(u,i);};
 svc=new ComputerInputService(mem(),env,slow);const all=await Promise.all([11,12,13].map(n=>svc.send(target,{requestId:uuid(n),text:'a',enter:true})));
 assert.ok(all.every(x=>x.ok));assert.equal(peak,1);

 // Budget: 4096 operations per 24h. 80 real inputs pass the old 64 cap; the rest of the ledger is prefilled in storage.
 reset();let now=1_000_000_000;st=mem();svc=new ComputerInputService(st,env,transport,()=>now);
 for(let i=0;i<80;i++)assert.equal((await svc.send(target,{requestId:uuid(1000+i),text:'a',enter:i%2===0})).ok,true);
 assert.equal(keyCalls().length,120);
 const old=now-23*3600*1000;for(let i=80;i<4096;i++)st.m.set('input:'+uuid(10000+i),{h:'0'.repeat(64),phase:'sent',at:old,error:null});
 calls=[];r=await svc.send(target,{requestId:uuid(200),text:'a'});assert.equal(r.error.code,'rate_limited');assert.equal(r.status,429);assert.equal(calls.length,0);
 assert.equal(st.m.size,4096);assert.ok(!st.m.has('input:'+uuid(200)));
 // Full ledger still replays recent confirmed input exactly (nothing evicted) and never retypes.
 r=await svc.send(target,{requestId:uuid(1000),text:'a',enter:true});assert.deepEqual(r,{ok:true,outcome:'sent',replay:true});assert.equal(calls.length,0);
 // Expiry prunes only entries older than 24h; the 80 recent ones stay.
 now+=3600*1000+1;assert.equal((await svc.send(target,{requestId:uuid(201),text:'a'})).ok,true);assert.equal(st.m.size,81);
 now+=24*3600*1000+1;assert.equal((await svc.send(target,{requestId:uuid(202),text:'a'})).ok,true);assert.equal(st.m.size,1);

 // DO wrapper delegates (no key configured, so no network) and its results are plain serializable objects.
 const dob=new CloudbiteComputerInput({storage:mem()},{});r=await dob.send(target,{requestId:uuid(300),text:'x'});
 assert.equal(r.error.code,'not_configured');assert.deepEqual(structuredClone(r),r);
 console.log('cloudbite-computer-input: ok');
}finally{await rm(dir,{recursive:true,force:true});}
