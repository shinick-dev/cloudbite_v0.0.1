// Coordinator's independent late-expiry, atomic-audit and storage-budget regressions.
import assert from 'node:assert/strict';import {build} from 'esbuild';
const source=process.env.LAB_ASSISTANT_SOURCE||'src/lab-assistant-service.ts';
const b=await build({entryPoints:[source],bundle:true,write:false,platform:'node',format:'esm',logLevel:'silent'});
const {LabAssistantService}=await import('data:text/javascript;base64,'+Buffer.from(b.outputFiles[0].text).toString('base64'));
const uuid=n=>'e0000000-0000-4000-8000-'+n.toString(16).padStart(12,'0');
async function world(scopes=['status:read','control:pause']){
 let at=1800000000000;const data=new Map(),copy=x=>x===undefined?x:structuredClone(x);
 const storage={data,hook:null,async get(k){const v=copy(data.get(k));if(storage.hook)await storage.hook(k);return v},async put(k,v){if(typeof k==='object')for(const [a,b]of Object.entries(k))data.set(a,copy(b));else data.set(k,copy(v))},async delete(keys){for(const k of Array.isArray(keys)?keys:[keys])data.delete(k)},async list({prefix=''}){return new Map([...data].filter(([k])=>k.startsWith(prefix)).map(([k,v])=>[k,copy(v)]))},async transaction(fn){const snapshot=copy([...data]);try{return await fn(storage)}catch(e){data.clear();for(const [k,v]of snapshot)data.set(k,v);throw e}}};
 data.set('lab:lab',{id:'lab',name:'fixture',expiresAt:at+3600000,seats:[{n:1,code:'seat000000000001'}]});
 const svc=new LabAssistantService({storage,now:()=>at,checkAdmin:async t=>t==='admin'});
 const issued=await svc.issue('admin',{id:'lab',label:'fixture',seats:[1],scopes,minutes:5,templates:scopes.includes('template:send')?[{title:'long',text:'가'.repeat(8000)}]:[]});
 assert.ok(!issued.error);return{svc,storage,data,issued,expire(){at=issued.grant.expiresAt+1}};
}
const tests=[
 ['late expiry cannot return authorized read data',async()=>{const w=await world();let n=0;w.storage.hook=k=>{if(k==='lab:lab'&&++n===2)w.expire()};const r=await w.svc.authorize(w.issued.token,'lab','status:read');assert.ok(r.error,'authority must expire after final async lab read')}],
 ['late expiry cannot write pause',async()=>{const w=await world();let n=0;w.storage.hook=k=>{if(k==='labctrl:lab'&&++n===2)w.expire()};const r=await w.svc.pause(w.issued.token,'lab',{requestId:uuid(1),reason:'test'});assert.ok(r.error);assert.equal(w.data.get('labctrl:lab'),undefined,'expired credential must make no control change')}],
 ['corrupt audit cannot commit a failed mutation',async()=>{const w=await world();w.data.set('labassist-audit:lab',{invalid:true});const before=structuredClone([...w.data]);const r=await w.svc.pause(w.issued.token,'lab',{requestId:uuid(1),reason:'test'});assert.ok(r.error);assert.deepEqual([...w.data],before,'mutation and audit must be atomic')}],
 ['long text accumulation must stay below storage record budget',async()=>{const w=await world(['status:read','template:send']);const rows=Array.from({length:75},(_,i)=>({id:'old-'+i,n:1,at:1800000000000,title:'long',text:'가'.repeat(8000),seatHash:'fixture'}));w.data.set('labassist-msg:lab',rows);const before=structuredClone([...w.data]);const r=await w.svc.sendTemplate(w.issued.token,'lab',{requestId:uuid(1),templateId:w.issued.grant.templates[0].id,n:1});assert.equal(r.status,429,'safe cap must reject before oversized storage write');assert.deepEqual([...w.data],before)}]
];
let failed=0;for(const [name,fn]of tests){try{await fn();console.log('ok',name)}catch(e){failed++;console.error('FAIL',name,':',e.message.split('\n')[0])}}
if(failed)process.exitCode=1;else console.log('PASS assistant independent boundaries',tests.length);
