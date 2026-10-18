import assert from 'node:assert/strict';
import {build} from 'esbuild';
const b=await build({entryPoints:['src/lab-assistant-api.ts'],bundle:true,write:false,platform:'node',format:'esm',logLevel:'silent'});
const {labAssistantApi}=await import('data:text/javascript;base64,'+Buffer.from(b.outputFiles[0].text).toString('base64'));
const origin='https://admin.invalid',token='la_'+'A'.repeat(43);let passed=0;
const grant={id:'ag-fixture',labId:'lab',expiresAt:Date.now()+60000,seats:[1],scopes:['status:read']};
async function invoke(action,{owner=false,headers={},method='POST',raw='{}',admin='',response={ok:true}}={}){
 const path='/api/lab/'+(owner?'assistants/':'assistant/')+action,calls=[];
 const req=new Request(origin+path,{method,headers:{'content-type':'application/json',origin,...headers},...(method==='POST'?{body:raw}:{})});
 const state={};
 for(const name of ['Issue','List','Revoke','Audit','Session','Status','Questions','Reply','Template','Pause'])state['labAssistant'+name]=async(...args)=>{calls.push([name,...args]);return name==='Session'?{grant}:response};
 const c={path,req,admin,state,env:{ORIGIN:origin},json:(x,status=200)=>Response.json(x,{status}),out:x=>Response.json('error'in x?{error:x.error}:x,{status:'error'in x?x.status:200})};
 const r=await labAssistantApi(c);return{r,calls};
}
async function t(name,fn){await fn();passed++;console.log('ok',name)}
for(const action of ['issue','list','revoke','audit'])await t('owner credential required '+action,async()=>{const {r,calls}=await invoke(action,{owner:true,raw:'{"id":"lab"}',headers:{cookie:'__Host-lab_assistant='+token}});assert.equal(r.status,401);assert.equal(calls.length,0)});
for(const action of ['status','questions','reply','template','pause'])await t('admin cannot impersonate assistant '+action,async()=>{const {r,calls}=await invoke(action,{admin:'admin',raw:'{"id":"lab"}'});assert.equal(r.status,401);assert.equal(calls.length,0)});
await t('cookie status and empty body',async()=>{const {r,calls}=await invoke('status',{headers:{cookie:'__Host-lab_assistant='+token}});assert.equal(r.status,200);assert.deepEqual(calls,[['Status',token]])});
await t('duplicate cookies rejected',async()=>{const {r,calls}=await invoke('status',{headers:{cookie:'__Host-lab_assistant='+token+'; __Host-lab_assistant='+token}});assert.equal(r.status,401);assert.equal(calls.length,0)});
await t('invalid explicit header cannot fall back to valid cookie',async()=>{const {r}=await invoke('status',{headers:{'x-lab-assistant':'bad',cookie:'__Host-lab_assistant='+token}});assert.equal(r.status,401)});
await t('cookie origin required',async()=>{const {r,calls}=await invoke('status',{headers:{origin:'null',cookie:'__Host-lab_assistant='+token}});assert.equal(r.status,403);assert.equal(calls.length,0)});
await t('CLI credential without origin works',async()=>{
 const req=new Request(origin+'/api/lab/assistant/status',{method:'POST',headers:{'x-lab-assistant':token},body:'{}'});
 const r=await labAssistantApi({path:'/api/lab/assistant/status',req,env:{ORIGIN:origin},admin:'',state:{labAssistantStatus:async t=>({grant,tokenSeen:t===token})},json:(x,s=200)=>Response.json(x,{status:s}),out:x=>Response.json(x)});
 assert.equal(r.status,200);assert.equal((await r.json()).tokenSeen,true);
});
await t('CLI credential rejects foreign origin',async()=>{const {r}=await invoke('status',{headers:{origin:'https://evil.invalid','x-lab-assistant':token}});assert.equal(r.status,403)});
await t('session sets secure cookie without token in JSON',async()=>{const {r,calls}=await invoke('session',{raw:JSON.stringify({token})});assert.equal(r.status,200);const header=r.headers.get('set-cookie');for(const part of ['HttpOnly','Secure','SameSite=Strict','Path=/'])assert.ok(header.includes(part));assert.ok(header.includes(token));assert.ok(!JSON.stringify(await r.json()).includes(token));assert.deepEqual(calls,[['Session',token]])});
await t('failed session does not set cookie',async()=>{
 const req=new Request(origin+'/api/lab/assistant/session',{method:'POST',headers:{origin},body:JSON.stringify({token})});
 const r=await labAssistantApi({path:'/api/lab/assistant/session',req,env:{ORIGIN:origin},admin:'',state:{labAssistantSession:async()=>({status:401,error:'invalid'})},json:(x,s=200)=>Response.json(x,{status:s}),out:x=>Response.json(x,{status:x.status})});
 assert.equal(r.status,401);assert.equal(r.headers.get('set-cookie'),null);
});
await t('scope denial clears cookie',async()=>{const {r}=await invoke('questions',{headers:{cookie:'__Host-lab_assistant='+token},raw:'{"id":"lab"}',response:{status:403,error:'scope'}});assert.equal(r.status,403);assert.ok(r.headers.get('set-cookie').includes('Max-Age=0'))});
for(const raw of ['[]','null','{broken'])await t('invalid JSON '+raw,async()=>{const {r,calls}=await invoke('status',{headers:{'x-lab-assistant':token},raw});assert.equal(r.status,400);assert.equal(calls.length,0)});
await t('actual UTF8 body cap',async()=>{const {r,calls}=await invoke('reply',{headers:{'x-lab-assistant':token},raw:JSON.stringify({id:'lab',text:'한'.repeat(4000)})});assert.equal(r.status,413);assert.equal(calls.length,0)});
await t('declared body cap',async()=>{const {r}=await invoke('status',{headers:{'x-lab-assistant':token,'content-length':'10001'}});assert.equal(r.status,413)});
await t('arbitrary template text blocked before RPC',async()=>{const {r,calls}=await invoke('template',{headers:{'x-lab-assistant':token},raw:JSON.stringify({id:'lab',requestId:'fixture',templateId:'tp-fixture',n:1,text:'execute anything'})});assert.equal(r.status,400);assert.equal(calls.length,0)});
await t('exact reply dispatch',async()=>{const p={requestId:'fixture',questionId:'q1',text:'answer'}, {r,calls}=await invoke('reply',{headers:{'x-lab-assistant':token},raw:JSON.stringify({id:'lab',...p})});assert.equal(r.status,200);assert.deepEqual(calls,[['Reply',token,'lab',p]])});
await t('owner issue exact dispatch',async()=>{const p={id:'lab',label:'bot',seats:[1],scopes:['status:read'],minutes:60,templates:[]},{r,calls}=await invoke('issue',{owner:true,admin:'admin',raw:JSON.stringify(p)});assert.equal(r.status,200);assert.deepEqual(calls,[['Issue','admin',p]])});
await t('logout clears cookie without grant revocation',async()=>{const {r,calls}=await invoke('logout');assert.equal(r.status,200);assert.ok(r.headers.get('set-cookie').includes('Max-Age=0'));assert.equal(calls.length,0)});
await t('unknown assistant action not routed',async()=>{const {r,calls}=await invoke('end');assert.equal(r,null);assert.equal(calls.length,0)});
await t('GET rejected before RPC',async()=>{const {r,calls}=await invoke('status',{method:'GET',headers:{'x-lab-assistant':token}});assert.equal(r.status,405);assert.equal(calls.length,0)});
console.log('PASS scoped assistant HTTP boundaries',passed);
