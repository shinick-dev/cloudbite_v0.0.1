import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const dir=await mkdtemp(join(tmpdir(),'cloudbite-api-'));
try {
 const b=await build({entryPoints:['src/cloudbite-computer-api.ts'],bundle:true,write:false,format:'esm',platform:'neutral',plugins:[{name:'auth-boundary',setup(x){
  x.onResolve({filter:/^\.\/state$/},()=>({path:'state',namespace:'test'}));
  x.onResolve({filter:/^\.\/cloudbite-owner$/},()=>({path:'owner',namespace:'test'}));
  x.onResolve({filter:/^\.\/lab$/},()=>({path:'lab',namespace:'test'}));
  x.onLoad({filter:/.*/,namespace:'test'},({path})=>({contents:path==='state'?"export const sha=async()=> '0123456789abcdef0123456789abcdef'; export const isFail=x=>!!x?.error;":path==='owner'?"export const ownerCookieValid=async r=>r.headers.get('cookie')==='owner=yes';":"export const download=async()=>{throw Error('unexpected download')};export class DtError extends Error{};export const dt=async()=>{throw Error('unexpected provider call')};"}));
 }}]});
 const file=join(dir,'api.mjs');await writeFile(file,b.outputFiles[0].text);const{computerRoute}=await import(pathToFileURL(file));
 const base='https://cloudbite.shinick.dev',gw='https://cloudbite-desktop.ai-gongbu.workers.dev';let calls=[];
 const rpc={computerState:async tag=>{calls.push('state');return{ok:true,status:'absent'}},computerStart:async()=>{calls.push('start');return{ok:true,status:'starting'}},computerRedeemTicket:async()=>({error:{code:'ticket_invalid'},status:403}),computerDesktopUpstream:async()=>({error:{code:'ticket_invalid'},status:403})};
 const env={ORIGIN:base,CLOUDBITE_PUBLIC_ORIGIN:base,CLOUDBITE_GATEWAY_URL:gw,CLOUDBITE_COMPUTER_GATEWAY_ORIGIN:gw,CLOUDBITE_COMPUTER:{idFromName:()=> 'owner',get:()=>rpc}};
 const state={adminList:async()=>{throw Error('unexpected admin validation')}};
 const request=(p,init={})=>{const r=new Request(base+p,init);return computerRoute(r,env,new URL(r.url),state)};
 let r=await request('/api/cloudbite/computer/state');assert.equal(r.status,401);assert.equal(calls.length,0);
 r=await request('/api/cloudbite/computer/state',{headers:{cookie:'owner=yes','x-admin-token':'cbo_test'}});assert.equal(r.status,401);assert.equal(calls.length,0);
 r=await request('/api/cloudbite/computer/state',{headers:{cookie:'owner=yes'}});assert.equal(r.status,200);assert.deepEqual(calls,['state']);
 r=await request('/api/cloudbite/computer/start',{method:'POST',headers:{cookie:'owner=yes',origin:'https://attacker.invalid','content-type':'application/json'},body:'{}'});assert.equal(r.status,403);assert.deepEqual(calls,['state']);
 r=await request('/api/cloudbite/computer/start',{method:'POST',headers:{cookie:'owner=yes',origin:base,'content-type':'application/json'},body:' '.repeat(8193)});assert.equal(r.status,400);assert.deepEqual(calls,['state']);
 r=await request('/p/_cloudbite/computer/desktop/',{headers:{cookie:'owner=yes'}});assert.equal(r.status,404);
 for(const suffix of ['','?cbt=invalid']){const q=new Request(gw+'/p/_cloudbite/computer/desktop/'+suffix);r=await computerRoute(q,env,new URL(q.url),state);assert.equal(r.status,401);assert.equal(r.headers.get('set-cookie'),null);}
 r=await request('/cloudbite/computer');assert.equal(r.status,200);assert.match(r.headers.get('content-security-policy'),/script-src 'self'/);assert.equal(r.headers.get('cache-control'),'no-store');
 console.log('cloudbite-computer-api: auth, capability-origin isolation, CSRF and body limits passed');
}finally{await rm(dir,{recursive:true,force:true});}
