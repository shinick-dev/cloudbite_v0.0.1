import assert from 'node:assert/strict';
import {build} from 'esbuild';
const b=await build({entryPoints:['src/lab-interrupt-api.ts'],bundle:true,write:false,platform:'node',format:'esm',logLevel:'silent'});
const {labInterruptApi}=await import('data:text/javascript;base64,'+Buffer.from(b.outputFiles[0].text).toString('base64'));
const pid='70000000-0000-4000-8000-000000000001',rid='70000000-0000-4000-8000-000000000002',paths=['/api/lab/interrupt/preview','/api/lab/interrupt/request'];
let pass=0;
async function invoke(path,{admin='admin',origin='https://admin.invalid',method='POST',raw=JSON.stringify({id:'lab',previewId:pid,requestId:rid,seats:[2],expectedRevision:4}),length}={}){
 const calls=[],headers={origin,'content-type':'application/json'};if(length)headers['content-length']=length;
 const req=new Request('https://admin.invalid'+path,{method,headers,...(method==='POST'?{body:raw}:{})});
 const state={async labInterruptPreview(...args){calls.push(['preview',...args]);return{ok:true}},async labInterruptRequest(...args){calls.push(['request',...args]);return{ok:true}}};
 const c={path,req,admin,state,env:{ORIGIN:'https://admin.invalid'},json:(x,status=200)=>Response.json(x,{status}),out:x=>Response.json(x,{status:x.status??200})};
 return{response:await labInterruptApi(c),calls};
}
for(const path of paths){
 for(const [name,options,status]of[
  ['no admin',{admin:''},401],['foreign origin',{origin:'https://evil.invalid'},403],['GET',{method:'GET'},405],
  ['array body',{raw:'[]'},400],['invalid JSON',{raw:'{broken'},400],['null ID',{raw:'{"id":null}'},400],
  ['oversize actual UTF8 body',{raw:JSON.stringify({id:'lab',extra:'한'.repeat(12000)})},413],
  ['oversize declared body',{length:'32769'},413],
 ]){const r=await invoke(path,options);assert.equal(r.response.status,status,path+' '+name);assert.equal(r.calls.length,0);pass++}
 const r=await invoke(path);assert.equal(r.response.status,200);assert.deepEqual(r.calls,[path.endsWith('/preview')?['preview','admin','lab',pid,[2],4]:['request','admin','lab',pid,rid]]);pass++;
}
const unrelated=await invoke('/api/lab/interrupt/unrecognized');assert.equal(unrelated.response,null);assert.equal(unrelated.calls.length,0);pass++;
console.log('PASS interrupt API authority, bounded-body and exact dispatch',pass);
