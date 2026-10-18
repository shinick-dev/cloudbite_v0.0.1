import assert from 'node:assert/strict';
import {build} from 'esbuild';
async function load(entry, name){
 const b=await build({entryPoints:[entry],bundle:true,write:false,platform:'node',format:'esm',external:['cloudflare:workers'],logLevel:'silent'});
 const code=b.outputFiles[0].text.replace(/import\s*\{\s*DurableObject\s*\}\s*from\s*["']cloudflare:workers["'];?/, 'class DurableObject{constructor(ctx,env){this.ctx=ctx;this.env=env}}');
 return (await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64')))[name];
}
const api=await load('src/lab-seat-add-api.ts','labSeatAddApi');
const paths=['/api/lab/seat-add','/api/lab/seat-add/status'];let passed=0;
async function invoke(path,{admin='admin',origin='https://admin.invalid',method='POST',raw='{"id":"lab"}',headers={},result={ok:true},throws=false}={}){
 const calls=[],head={'content-type':'application/json',...headers};if(origin)head.origin=origin;
 const req=new Request('https://admin.invalid'+path,{method,headers:head,...(method==='POST'?{body:raw,...(raw instanceof ReadableStream?{duplex:'half'}:{})}:{})});
 const c={path,req,admin,env:{ORIGIN:'https://admin.invalid'},state:{
  async labSeatAdd(...args){calls.push(['add',...args]);if(throws)throw Error();return result},
  async labSeatAddStatus(...args){calls.push(['status',...args]);if(throws)throw Error();return result}
 },json:(x,status=200)=>Response.json(x,{status}),out:x=>Response.json(x,{status:x.status??200})};
 return{response:await api(c),calls,c};
}
for(const path of paths){
 for(const [name,opts,status] of [
  ['missing origin',{origin:null},403],['foreign origin',{origin:'https://evil.invalid'},403],['GET',{method:'GET'},405],
  ['missing admin',{admin:''},401],['cookie only',{admin:'',headers:{cookie:'__Host-lab_admin=synthetic'}},401],
  ['malformed JSON',{raw:'{broken'},400],['invalid UTF8',{raw:new Uint8Array([255])},400],
  ['declared oversize',{headers:{'content-length':'513'}},413],['actual oversize',{raw:' '.repeat(513)},413],
  ['streamed oversize',{raw:new ReadableStream({start(c){c.enqueue(new Uint8Array(300));c.enqueue(new Uint8Array(300));c.close()}})},413]
 ]){const r=await invoke(path,opts);assert.equal(r.response.status,status,name);assert.equal(r.calls.length,0,name);passed++}
 const good=await invoke(path);assert.equal(good.response.status,200);assert.deepEqual(good.calls,[[path.endsWith('/status')?'status':'add','admin',{id:'lab'}]]);passed++;
 for(const creationState of ['preparing','running','unknown']){const r=await invoke(path,{result:{creationState}});assert.equal(r.response.status,202);passed++}
 const failure=await invoke(path,{result:{error:'changed',status:409}});assert.equal(failure.response.status,409);passed++;
 const error=await invoke(path,{throws:true});assert.equal(error.response.status,503);assert.match((await error.response.json()).error,/같은 요청/);passed++;
}
assert.equal((await invoke('/api/lab/seat-add/other')).response,null);passed++;
const chain=await load('src/lab-api.ts','labApi');
for(const path of paths){const {c}=await invoke(path,{origin:null});assert.equal((await chain(c)).status,403);passed++}
console.log('PASS seat addition API boundaries and dispatch',passed);
