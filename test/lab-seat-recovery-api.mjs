import assert from 'node:assert/strict';
import {build} from 'esbuild';
const b=await build({entryPoints:['src/lab-seat-recovery-api.ts'],bundle:true,write:false,platform:'node',format:'esm',logLevel:'silent'});
const {labSeatRecoveryApi}=await import('data:text/javascript;base64,'+Buffer.from(b.outputFiles[0].text).toString('base64'));
const rid='70000000-0000-4000-8000-000000000002',paths=['context','create','status','unlock'].map(x=>'/api/lab/recovery/'+x);let pass=0;
async function invoke(path,{admin='admin',origin='https://admin.invalid',method='POST',raw=JSON.stringify({id:'lab',requestId:rid,n:2,kind:'replace',expectedGeneration:'opaque-generation',expectedRevision:4,ackDataLoss:true,ackInspected:true}),length}={}){
 const calls=[],headers={origin,'content-type':'application/json'};if(length)headers['content-length']=length;
 const req=new Request('https://admin.invalid'+path,{method,headers,...(method==='POST'?{body:raw}:{})}),state={};
 for(const name of['Context','Create','Status','Unlock'])state['labRecovery'+name]=async(...args)=>{calls.push([name,...args]);return{ok:true}};
 const c={path,req,admin,state,env:{ORIGIN:'https://admin.invalid'},json:(x,status=200)=>Response.json(x,{status}),out:x=>Response.json(x,{status:x.status??200})};return{response:await labSeatRecoveryApi(c),calls};
}
for(const path of paths){for(const[name,options,status]of[['no admin',{admin:''},401],['foreign origin',{origin:'https://evil.invalid'},403],['GET',{method:'GET'},405],['array body',{raw:'[]'},400],['invalid JSON',{raw:'{broken'},400],['null ID',{raw:'{"id":null}'},400],['oversize actual UTF8 body',{raw:JSON.stringify({id:'lab',extra:'한'.repeat(3000)})},413],['oversize declared body',{length:'8193'},413]]){const r=await invoke(path,options);assert.equal(r.response.status,status,path+' '+name);assert.equal(r.calls.length,0);pass++}
 const r=await invoke(path);assert.equal(r.response.status,200);const expected=path.endsWith('/context')?['Context','admin','lab',2]:path.endsWith('/create')?['Create','admin','lab',rid,2,'replace','opaque-generation',4,true]:path.endsWith('/unlock')?['Unlock','admin','lab',rid,'opaque-generation',true]:['Status','admin','lab',rid];assert.deepEqual(r.calls,[expected]);pass++}
const unrelated=await invoke('/api/lab/recovery/unrecognized');assert.equal(unrelated.response,null);assert.equal(unrelated.calls.length,0);pass++;
console.log('PASS recovery API authority, bounded-body and exact dispatch',pass);
