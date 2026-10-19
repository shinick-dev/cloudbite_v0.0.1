import assert from 'node:assert/strict';
import {build} from 'esbuild';
const b=await build({entryPoints:['src/cloudbite-computer-jobs-api.ts'],bundle:true,write:false,format:'esm',platform:'neutral',plugins:[{name:'fake',setup(x){
 x.onResolve({filter:/^\.\/cloudbite-computer-capacity-api$/},()=>({path:'capacity',namespace:'fake'}));
 x.onResolve({filter:/^\.\/cloudbite-computer-gpu$/},()=>({path:'gpu',namespace:'fake'}));
 x.onLoad({filter:/.*/,namespace:'fake'},({path})=>({contents:path==='capacity'?`export async function capacitySandbox(env,id,account){return id==='owned-other'&&account==='secondary'?{id,account,name:'Other',region:'eu'}:null}`:`export async function cbGpuAvailability(){return{usdPerHourMin:.3,usdPerHourMax:.4}}`}));
}}]});
const m=await import('data:text/javascript;base64,'+Buffer.from(b.outputFiles[0].text).toString('base64'));
const computer={computerMachine:async tag=>{assert.equal(tag,'owner-tag');return{ok:true,machine:{id:'desktop-id',account:'primary',name:'PC',region:'us'}}}};
let lastRun,lastStop;
const nested={ownerGpuSelectionJson:async id=>JSON.stringify({status:200,body:{ok:true,selection:{candidateId:'gpu-test',gpu:'RTX 4090',country:'US',market:null}}}),
 ownerRunJson:async v=>{lastRun=v;return JSON.stringify({status:202,body:{ok:true,job:{id:'nj'+'a'.repeat(24)}}})},
 ownerStopJson:async v=>{lastStop=v;return JSON.stringify({status:200,body:{ok:true}})},
 ownerJobsJson:async()=>JSON.stringify({status:200,body:{ok:true,jobs:[{id:'nj'+'a'.repeat(24),result:{output:'<script>alert(1)</script>\nGPU done'}},{id:'nj'+'b'.repeat(24),result:null}]}})};
let r=await m.webJobsContext({},computer,nested,'owner-tag',new URLSearchParams());assert.equal(r.body.sandbox.id,'desktop-id');assert.equal(r.body.pricing.gpuReservationMinutes,50);assert.equal(r.body.pricing.gpuBaseUsdPerHour,.4);
r=await m.webJobsContext({},computer,nested,'owner-tag',new URLSearchParams({sandboxId:'forged-id',account:'secondary'}));assert.equal(r.status,400);
const input={requestId:crypto.randomUUID(),provider:'nosana',command:['nvidia-smi'],timeout:60,acknowledgeCost:true,acknowledgePublic:true,files:[{name:'input.txt',contentBase64:'eA=='}]};
assert.equal((await m.webJobsRun({},computer,nested,'owner-tag',{...input,acknowledgeCost:false})).status,400);
assert.equal((await m.webJobsRun({},computer,nested,'owner-tag',{...input,acknowledgePublic:false})).status,400);assert.equal(lastRun,undefined);
assert.equal((await m.webJobsRun({},computer,nested,'owner-tag',{...input,ownerMachineId:'forged'})).status,400);
r=await m.webJobsRun({},computer,nested,'owner-tag',input);assert.equal(r.status,202);assert.equal(lastRun.ownerMachineId,'desktop-id');assert.deepEqual(lastRun.files,input.files);assert.ok(!('acknowledgeCost' in lastRun));
await m.webJobsRun({},computer,nested,'owner-tag',{...input,sandboxId:'owned-other',account:'secondary'});assert.equal(lastRun.ownerMachineId,'owned-other');
assert.equal((await m.webJobsStop(nested,{requestId:'id',jobId:'job',ownerMachineId:'forged'})).status,400);
await m.webJobsStop(nested,{requestId:'id',jobId:'job'});assert.deepEqual(lastStop,{requestId:'id',jobId:'job'});
assert.equal((await m.webJobOutput(nested,'../../bad')).status,404);assert.equal((await m.webJobOutput(nested,'nj'+'b'.repeat(24))).status,409);
assert.equal((await m.webJobOutput(nested,'nj'+'a'.repeat(24))).text,'<script>alert(1)</script>\nGPU done','HTTP route must serve this as text/plain attachment');
console.log('web jobs API: ownership, explicit cost/public ack, trusted identity, file forwarding and output status checks passed');
