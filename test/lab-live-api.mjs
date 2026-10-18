import assert from 'node:assert/strict';
import {build} from 'esbuild';
const bundled=await build({entryPoints:['src/lab-live-api.ts'],bundle:true,write:false,format:'esm',platform:'node',loader:{'.ps1':'text'},plugins:[{name:'workers-test',setup(b){b.onResolve({filter:/^cloudflare:workers$/},()=>({path:'workers',namespace:'test'}));b.onLoad({filter:/.*/,namespace:'test'},()=>({contents:'export class DurableObject {}',loader:'js'}))}}],logLevel:'silent'});
const {labLiveApi}=await import('data:text/javascript;base64,'+Buffer.from(bundled.outputFiles[0].text).toString('base64'));
const origin='https://admin.invalid',token='A'.repeat(32),cookie='__Host-lab_live='+token;
let hits=[];
async function call(action,{headers={},body={},raw,method='POST',auth=true}={}){
 hits=[];const req=new Request(origin+'/api/lab/live/'+action,{method,headers:{origin,'content-type':'application/json',cookie,...headers},...(method==='POST'?{body:raw??JSON.stringify(body)}:{})});
 const state={labLiveOwner:async t=>auth&&t===token?{owner:'hash',expiresAt:Date.now()+10000}:null};
 for(const name of ['Status','Logout','Pull','Request','Release','Input','Close','Quality'])state['labLive'+name]=async(...args)=>{hits.push([name,...args]);return{ok:true}};
 state.labLiveMint=async(...args)=>{hits.push(['Mint',...args]);return{token,expiresAt:Date.now()+8*3600000}};
 for(const name of ['Start','Stop','List'])state['labScreen'+name]=async(...args)=>{hits.push(['Screen'+name,...args]);return{ok:true}};
 return labLiveApi({path:new URL(req.url).pathname,req,env:{ORIGIN:origin},state,admin:headers['x-admin-token']??'',json:(b,status=200)=>Response.json(b,{status}),out:b=>Response.json(b,{status:b.status??200})});
}
for(const action of ['status','screen/start','screen/stop','screen/status','pull','answer','request','release','input','close','quality']){
 assert.equal((await call(action,{headers:{cookie:'__Host-lab_teacher='+token}})).status,401);
 assert.equal((await call(action,{headers:{cookie:'__Host-lab_assistant='+token}})).status,401);
 assert.equal((await call(action,{headers:{cookie:'','x-admin-token':token}})).status,401);
 assert.equal((await call(action,{auth:false})).status,401);
 assert.equal((await call(action,{headers:{origin:'null'}})).status,403);
 assert.equal((await call(action,{method:'GET'})).status,405);
}
assert.equal((await call('status',{headers:{cookie:cookie+'; '+cookie}})).status,400);
for(const raw of ['null','[]','{bad'])assert.equal((await call('status',{raw})).status,400);
assert.equal((await call('input',{raw:JSON.stringify({text:'가'.repeat(4000)})})).status,413);
assert.equal((await call('status',{body:{id:'unexpected'}})).status,400);
let r=await call('session',{headers:{'x-admin-token':'fresh-admin'}});assert.equal(r.status,200);assert.ok(r.headers.get('set-cookie').includes('HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=28800'));assert.ok(!JSON.stringify(await r.json()).includes(token));
assert.deepEqual(hits,[['Mint','fresh-admin',token]]);
r=await call('screen/stop',{body:{id:'room'}});assert.equal(r.status,200);assert.deepEqual(hits,[['ScreenStop',token,'room']]);
r=await call('request',{body:{id:'room',n:2,requestId:'request'}});assert.equal(r.status,200);assert.deepEqual(hits,[['Request',token,'room',2,'request']]);
r=await call('quality',{body:{viewerTab:'viewer-1234567890123',revision:3,at:1800000000000,focus:{id:'room',n:2,v:4}}});assert.equal(r.status,200);assert.deepEqual(hits,[['Quality',token,'viewer-1234567890123',3,1800000000000,{id:'room',n:2,v:4}]]);
r=await call('logout');assert.equal(r.status,200);assert.ok(r.headers.get('set-cookie').includes('Max-Age=0'));
console.log('PASS live HTTP: monitor/assistant/admin isolation, expiry, origin, methods, duplicate cookies, UTF-8 body caps, cookie-only credential, dispatch and logout');
