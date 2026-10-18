import assert from 'node:assert/strict';
import {generateKeyPair,exportJWK,SignJWT} from 'jose';
import {build} from 'esbuild';
const apiBundle=await build({entryPoints:['src/lab-open-api.ts'],bundle:true,write:false,format:'esm',platform:'node',logLevel:'silent'});
const {labOpenApi}=await import('data:text/javascript;base64,'+Buffer.from(apiBundle.outputFiles[0].text).toString('base64'));
const ownerEnv={LAB_OPEN_ACCESS_TEAM:'https://fixture.cloudflareaccess.com',LAB_OPEN_AUDIENCE:'request-inbox',LAB_OPEN_OWNER_EMAIL:'owner@example.test'};
const pair=await generateKeyPair('RS256'),jwk=await exportJWK(pair.publicKey);jwk.kid='fixture';
const ownerJWT=await new SignJWT({email:ownerEnv.LAB_OPEN_OWNER_EMAIL}).setProtectedHeader({alg:'RS256',kid:'fixture'}).setIssuer(ownerEnv.LAB_OPEN_ACCESS_TEAM).setAudience(ownerEnv.LAB_OPEN_AUDIENCE).setSubject('owner').setIssuedAt().setExpirationTime('24h').sign(pair.privateKey);
globalThis.fetch=async(input)=>{assert.equal(String(input),ownerEnv.LAB_OPEN_ACCESS_TEAM+'/cdn-cgi/access/certs');return Response.json({keys:[jwk]})};
let count=0,calls=[];
const check=(name,value)=>{assert.ok(value,name);count++;console.log('ok '+name)};
const json=(v,status=200)=>Response.json(v,{status});
function context(action,opts={}) {
 const path='/api/lab/open/'+action;
 const state=new Proxy({}, {get:(_,key)=>(...args)=>{calls.push({key,args});return Promise.resolve({ok:true})}});
 const req=new Request('https://manager.invalid'+path,{method:opts.method||'POST',headers:{'content-type':opts.type??'application/json',...(opts.owner?{'cf-access-jwt-assertion':ownerJWT}:{}),...(opts.headers||{}),...(opts.origin===null?{}:{origin:opts.origin||'https://manager.invalid'})},body:opts.method==='GET'?undefined:opts.body??'{}'});
 return {req,path,env:{ORIGIN:'https://manager.invalid',...ownerEnv},state,src:'source-hash',admin:'test-admin',json,out:v=>v.status&&v.error?json({error:v.error},v.status):json(v)};
}
for(const origin of [null,'https://other.invalid']){calls=[];const r=await labOpenApi(context('submit',{origin}));check('foreign or absent origin rejected before RPC',r.status===403&&calls.length===0)}
calls=[];check('wrong content type rejected',(await labOpenApi(context('submit',{type:'text/plain'}))).status===415&&calls.length===0);
calls=[];check('stream body capped before RPC',(await labOpenApi(context('submit',{body:JSON.stringify({x:'x'.repeat(13000)})}))).status===413&&calls.length===0);
for(const body of ['null','[]','{"id":']){calls=[];check('malformed body rejected',(await labOpenApi(context('submit',{body}))).status===400&&calls.length===0)}
calls=[];await labOpenApi(context('submit',{body:JSON.stringify({id:'id',secret:'secret'})}));check('submit receives worker source hash, not caller source',calls[0].key==='labOpenSubmit'&&calls[0].args[1]==='source-hash');
calls=[];await labOpenApi(context('manager/approve',{owner:true,body:JSON.stringify({id:'id',choice:{hours:1,budget:1},assertion:{proof:'fixture'}})}));check('approval uses scoped assertion and explicit limits',calls[0].key==='labOpenApprove'&&calls[0].args[0]==='owner:'+ownerJWT&&calls[0].args[3].proof==='fixture');
calls=[];await labOpenApi(context('manager/resume',{owner:true,body:JSON.stringify({id:'id'})}));check('resume is separate from a new approval',calls[0].key==='labOpenResume'&&calls[0].args.length===2);
calls=[];await labOpenApi(context('manager/push/options',{owner:true,body:JSON.stringify({subscription:{endpoint:'fixture'},label:'my phone'})}));check('push key ceremony receives exact proposed device',calls[0].key==='labOpenPushOptions'&&calls[0].args[2].endpoint==='fixture'&&calls[0].args[3]==='my phone');
for(const action of ['list','manager/list','manager/options','manager/approve','manager/resume','manager/deny','manager/push/devices','manager/push/test']){calls=[];check(action+' rejects unauthenticated/forged email before RPC',(await labOpenApi(context(action,{headers:{'cf-access-authenticated-user-email':ownerEnv.LAB_OPEN_OWNER_EMAIL}}))).status===403&&calls.length===0)}
calls=[];const session=await labOpenApi(context('manager/session',{owner:true}));const identity=await session.json();check('owner session has no admin token and needs no key',session.status===200&&identity.email===ownerEnv.LAB_OPEN_OWNER_EMAIL&&!identity.token&&calls.length===0);
check('unknown route not captured',labOpenApi(context('unknown'))===null);
console.log('PASS lab-open API '+count);
