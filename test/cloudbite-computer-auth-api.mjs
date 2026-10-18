import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import{join}from'node:path';import{pathToFileURL}from'node:url';
const dir=await mkdtemp(join(tmpdir(),'cb-phone-http-'));
try{
 const b=await build({entryPoints:['src/cloudbite-computer-auth-api.ts'],bundle:true,write:false,platform:'node',format:'esm',plugins:[{name:'phone-boundary',setup(x){
  x.onResolve({filter:/^\.\/cloudbite-owner$/},()=>({path:'owner',namespace:'test'}));
  x.onResolve({filter:/^\.\/cloudbite-computer-access$/},()=>({path:'access',namespace:'test'}));
  x.onLoad({filter:/.*/,namespace:'test'},({path})=>({contents:path==='owner'?"export const ownerCookieName=()=>'__Host-cb-owner';export const ownerCookieValid=async r=>r.headers.get('x-test-legacy')==='yes';export const ownerRoute=async(...a)=>globalThis.__ownerRoute(...a);":"export const computerCookieToken=r=>(r.headers.get('cookie')??'').split(';').some(p=>p.trim()==='phone=yes')?'cbpc_test':null;export const computerSetCookie=(t,a)=>'__Host-cb-pc-owner='+t+'; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age='+a;export const computerClearCookie=()=> '__Host-cb-pc-owner=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict';"}));
 }}]});
 let ownerCalls=[],ownerReply=()=>new Response('{}',{status:401});globalThis.__ownerRoute=async(req,_env,path)=>{ownerCalls.push(path);return ownerReply(req);};
 const file=join(dir,'auth.mjs');await writeFile(file,b.outputFiles[0].text);const{computerAuthRoute}=await import(pathToFileURL(file));
 const origin='https://cloudbite.shinick.dev';let calls=[],reply={ok:true,authenticated:true,hasCredentials:true,sessionToken:'server_only_token',cookieMaxAge:900};
 const rpc={authJson:async(op,input)=>{calls.push({op,input:JSON.parse(input)});return JSON.stringify(reply);}};
 const env={ORIGIN:origin,CLOUDBITE_PUBLIC_ORIGIN:origin,CLOUDBITE_COMPUTER_ACCESS:{idFromName:()=> 'owner',get:()=>rpc}};
 const state={cloudbiteOwnerStatus:async()=>{throw Error('phone must survive legacy outage')}};
 async function request(op,input,extra={}){const req=new Request(origin+'/api/cloudbite/computer/auth/'+op,input===undefined?{headers:extra}:{method:'POST',headers:{origin,'content-type':'application/json',...extra},body:JSON.stringify(input)});return computerAuthRoute(req,env,new URL(req.url),state);}
 let r=await request('pair',{token:'pair-value'});assert.equal(r.status,200);let data=await r.json();assert.equal(data.sessionToken,undefined);assert.match(r.headers.get('set-cookie'),/server_only_token/);
 calls=[];r=await request('register/verify',{legacyOwner:true,response:{id:'not-an-authority'}});assert.equal(calls.at(-1).input.legacyOwner,false);assert.equal(calls.at(-1).op,'registerVerify');
 calls=[];r=await request('register/options',{}, {'x-test-legacy':'yes'});assert.equal(calls.at(-1).input.legacyOwner,true);
 calls=[];r=await request('pair',{token:'x'},{origin:'https://cloudbite-desktop.ai-gongbu.workers.dev'});assert.equal(r.status,403);assert.equal(calls.length,0);
 r=await request('pair',{token:'x'.repeat(33000)});assert.equal(r.status,400);assert.equal(calls.length,0);
 const q=new Request('https://cloudbite-desktop.ai-gongbu.workers.dev/api/cloudbite/computer/auth/session');r=await computerAuthRoute(q,env,new URL(q.url),state);assert.equal(r.status,404);
 reply={ok:true,authenticated:true,hasCredentials:true,renew:true,cookieMaxAge:900};r=await request('session',undefined,{cookie:'phone=yes'});assert.equal((await r.json()).authenticated,true);assert.match(r.headers.get('set-cookie'),/cbpc_test/);
 reply={ok:true,options:{challenge:'public-challenge'}};r=await request('register/options',{});assert.deepEqual(await r.json(),{challenge:'public-challenge'});
 reply={ok:false,error:'invalid pairing link',status:410};r=await request('pair',{token:'expired'});assert.equal(r.status,410);assert.equal(r.headers.get('set-cookie'),null);
 // Logout: a well-formed legacy cookie is always logged out (not gated on its State check), legacy first, honest 503 on failure.
 const legacyCookie='__Host-cb-owner=cbown_'+'A'.repeat(43), legacyClear='__Host-cb-owner=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict; Secure';
 const okLegacy=()=>{const x=new Response('{"authenticated":false}',{status:200});x.headers.append('set-cookie',legacyClear);return x;};
 const both={cookie:'phone=yes; '+legacyCookie};
 const phoneLogouts=()=>calls.filter(c=>c.op==='logout').length;
 reply={ok:true,authenticated:false};
 // (a) State outage: ownerCookieValid false (no x-test-legacy), legacy server 503 without Set-Cookie -> 503, phone untouched.
 calls=[];ownerCalls=[];ownerReply=()=>new Response('{"error":"owner session is temporarily unavailable"}',{status:503});
 r=await request('logout',{},both);assert.equal(r.status,503);assert.deepEqual(ownerCalls,['/api/cloudbite/owner/logout']);assert.equal(r.headers.get('set-cookie'),null);assert.equal(phoneLogouts(),0);
 data=await r.json();assert.equal(data.error.code,'logout_unavailable');assert.equal(data.authenticated,undefined);
 // ownerRoute throwing is the same safe 503 with a fixed code and no raw error.
 calls=[];ownerCalls=[];ownerReply=()=>{throw Error('secret-internal-detail')};
 r=await request('logout',{},both);assert.equal(r.status,503);assert.doesNotMatch(await r.text(),/secret-internal-detail/);assert.equal(phoneLogouts(),0);
 // (b) legacy ok -> phone DO logout called, both cookies cleared.
 calls=[];ownerCalls=[];ownerReply=okLegacy;
 r=await request('logout',{},both);assert.equal(r.status,200);assert.equal(ownerCalls.length,1);assert.equal(phoneLogouts(),1);assert.equal(calls.at(-1).input.token,'cbpc_test');
 let cookies=r.headers.getSetCookie();assert.equal(cookies.length,2);assert.ok(cookies.some(c=>c.startsWith('__Host-cb-pc-owner=;')));assert.ok(cookies.includes(legacyClear));
 // (c) legacy ok but phone DO logout fails -> 503, legacy clear still sent, phone cookie kept for retry.
 calls=[];ownerCalls=[];reply={ok:false,error:'computer sign-in unavailable',status:503};
 r=await request('logout',{},both);assert.equal(r.status,503);cookies=r.headers.getSetCookie();assert.deepEqual(cookies,[legacyClear]);
 rpc.authJson=async()=>{throw Error('rpc down')};r=await request('logout',{},both);assert.equal(r.status,503);assert.deepEqual(r.headers.getSetCookie(),[legacyClear]);assert.doesNotMatch(await r.text(),/rpc down/);
 rpc.authJson=async(op,input)=>{calls.push({op,input:JSON.parse(input)});return JSON.stringify(reply);};
 // (d) phone only, no legacy cookie (or a malformed one) -> ownerRoute never called.
 reply={ok:true,authenticated:false};
 for(const cookie of ['phone=yes','phone=yes; __Host-cb-owner=notacredential','phone=yes; cb-owner-dev=cbown_'+'A'.repeat(43)]){
  calls=[];ownerCalls=[];r=await request('logout',{},{cookie});assert.equal(r.status,200);assert.equal(ownerCalls.length,0);assert.equal(phoneLogouts(),1);assert.equal(r.headers.getSetCookie().length,1);
 }
 // P3: authJson exceptions on other routes are fixed-code 503s, not Worker 500s.
 rpc.authJson=async()=>{throw Error('rpc down')};r=await request('session',undefined,{cookie:'phone=yes'});assert.equal(r.status,503);assert.doesNotMatch(await r.text(),/rpc down/);
 r=await request('pair',{token:'x'});assert.equal(r.status,503);assert.equal(r.headers.get('set-cookie'),null);
 rpc.authJson=async(op,input)=>{calls.push({op,input:JSON.parse(input)});return JSON.stringify(reply);};
 // Legacy first-setup fallback: ownerRoute throwing is a 503.
 reply={ok:true,authenticated:false,hasCredentials:false};ownerReply=()=>{throw Error('state down')};r=await request('options',{});assert.equal(r.status,503);assert.doesNotMatch(await r.text(),/state down/);
 console.log('cloudbite-computer-auth-api: server-side authority, cookie-only secrets, exact origin, size cap, outage isolation and honest logout passed');
}finally{delete globalThis.__ownerRoute;await rm(dir,{recursive:true,force:true});}
