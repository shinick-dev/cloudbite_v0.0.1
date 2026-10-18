// Real local Worker/SQLite + real browser, synthetic code-server only.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn,execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright-core';
const root=process.cwd(),temp=mkdtempSync(path.join(tmpdir(),'gw-demo-frame-'));
const free=async()=>{const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p};
const port=await free(),inspect=await free(),gw='http://127.0.0.1:'+port;
const parent='http://k.gw.localhost:'+port,seat='http://s-'+'a'.repeat(26)+'.gw.localhost:'+port,code='demo000000000001';
let mode='normal';const hits=[],consoleErrors=[];
const mock=createServer((req,res)=>{
 hits.push({url:req.url,site:req.headers['sec-fetch-site'],dest:req.headers['sec-fetch-dest'],mode:req.headers['sec-fetch-mode'],etag:req.headers['if-none-match']});
 if(mode.startsWith('redirect')&&!new URL(req.url,'http://x').searchParams.has('folder'))return res.writeHead(302,{location:'/?folder=/home/daytona/work','x-frame-options':'SAMEORIGIN'}).end();
 if(['cached','redirect-cached'].includes(mode)&&req.headers['if-none-match'])return res.writeHead(304,{'x-frame-options':'SAMEORIGIN','content-security-policy':"frame-ancestors 'self'",etag:'"code-demo"'}).end();
 res.writeHead(200,{'content-type':'text/html;charset=utf-8','x-frame-options':'SAMEORIGIN','content-security-policy':"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'self'",'cache-control':'max-age=0',etag:'"code-demo"'}).end('<!doctype html><html><head></head><body><h1 id="workspace">Real local Worker frame</h1><textarea>native editor</textarea></body></html>');
});await new Promise(r=>mock.listen(0,'127.0.0.1',r));const upstream='http://127.0.0.1:'+mock.address().port;
const fwd=x=>x.replaceAll('\\','/');
writeFileSync(path.join(temp,'entry.js'),`import worker,{State as Base} from '${fwd(path.join(root,'src/index.ts'))}';import{makeFixture}from'${fwd(path.join(root,'test/fixtures/lab-security/fixture.js'))}';const f=makeFixture(worker,Base);export const State=f.State;export default f.worker;`);
writeFileSync(path.join(temp,'wrangler.json'),JSON.stringify({name:'demo-frame-fixture',main:'entry.js',compatibility_date:'2026-09-01',compatibility_flags:['nodejs_compat'],rules:[{type:'Text',globs:['**/*.ps1'],fallthrough:true}],vars:{RP_ID:'localhost',ORIGIN:parent,LAB_ORIGIN:'http://lab.gw.localhost:'+port,LAB_SEAT_DOMAIN:'gw.localhost:'+port,MASTER_KEY:'s'.repeat(43),LAB_DAYTONA_API:upstream},durable_objects:{bindings:[{name:'STATE',class_name:'State'}]},migrations:[{tag:'v1',new_sqlite_classes:['State']}]}));
const proc=spawn(process.execPath,[path.join(root,'node_modules/wrangler/bin/wrangler.js'),'dev','--config',path.join(temp,'wrangler.json'),'--port',String(port),'--ip','127.0.0.1','--inspector-port',String(inspect),'--persist-to',path.join(temp,'state'),'--show-interactive-dev-session=false','--log-level','warn'],{cwd:root,stdio:['ignore','pipe','pipe'],env:{...process.env,WRANGLER_SEND_METRICS:'false'}});let logs='';proc.stdout.on('data',x=>logs+=x);proc.stderr.on('data',x=>logs+=x);
const fx=async(m,...args)=>{const r=await fetch(gw+'/__fx/'+m,{method:'POST',body:JSON.stringify(args)});assert.equal(r.status,200,await r.clone().text());return r.json()};
let browser;
try{
 let ready=false;for(let i=0;i<100;i++){try{if((await fetch(gw+'/__fx-enters')).ok){ready=true;break}}catch{}await new Promise(r=>setTimeout(r,100))}assert.ok(ready,logs);
 const at=Date.now(),lab={id:'parent',name:'fixture',createdAt:at,expiresAt:at+3600000,budget:1,cpu:1,memory:2,disk:5,snapshot:'s',model:'m',gw:'',seats:[]};
 const demo={...lab,id:'demo',teacherDemoFor:'parent',seats:[{n:1,code,label:'a'.repeat(26),sandboxId:'sb',pv:{origin:upstream,token:'synthetic'}}]};
 await fx('fxPut',{'lab:parent':lab,'lab:demo':demo,['seat:'+code]:{lab:'demo',n:1}});
 browser=await chromium.launch({channel:'msedge',headless:true});const context=await browser.newContext();await context.addCookies([{name:'__Host-lab_seat',value:code,domain:new URL(seat).hostname,path:'/',secure:true,httpOnly:true,sameSite:'Strict'}]);
 const page=await context.newPage();page.on('console',x=>{if(x.type()==='error')consoleErrors.push(x.text())});
 await page.goto(parent+'/lab');
 for(const value of ['normal','cached','redirect','redirect-cached']){
  mode=value;const top=await context.newPage();await top.goto(seat+'/');await top.close();
  const responsePromise=page.waitForResponse(r=>r.url().startsWith(seat)&&r.request().isNavigationRequest());
  await page.evaluate(url=>{document.getElementById('probe')?.remove();const e=document.createElement('iframe');e.id='probe';e.src=url;document.body.append(e)},seat+'/?__demo_embed=1');
  const response=await responsePromise;
  try{await page.frameLocator('#probe').locator('#workspace').waitFor({state:'attached',timeout:5000});console.log('ok actual Worker embedded '+value)}catch(e){console.log(JSON.stringify({mode:value,hits,consoleErrors,logs:logs.slice(-1500)},null,2));throw e}
  if(!value.startsWith('redirect')){
   assert.equal(response.status(),200);const headers=await response.allHeaders();assert.equal(headers['cache-control'],'no-store');assert.equal(headers.etag,undefined);assert.equal(headers['x-frame-options'],undefined);
   assert.match(await response.text(),/src="\/__lab\/demo-bridge.js"/);
  }
 }
 assert.equal(consoleErrors.filter(e=>/frame-ancestors|X-Frame-Options|Refused to frame/.test(e)).length,0);
 assert.ok(hits.some(h=>h.dest==='document'&&h.etag),'top-level view still revalidates normally');
 assert.equal(hits.some(h=>h.dest==='iframe'&&h.etag),false,'private embed never reuses a cached document');
 delete demo.teacherDemoFor;await fx('fxPut',{'lab:demo':demo});
 const deniedResponse=page.waitForResponse(r=>r.url().startsWith(seat)&&r.request().isNavigationRequest());
 await page.evaluate(url=>{document.getElementById('probe').src=url},seat+'/?__demo_embed=1&denied=1');
 assert.equal((await deniedResponse).status(),403);console.log('ok participant iframe remains forbidden after role changes');
}finally{await browser?.close();mock.closeAllConnections();await new Promise(r=>mock.close(r));try{if(process.platform==='win32')execFileSync('taskkill',['/PID',String(proc.pid),'/T','/F'],{stdio:'ignore'});else proc.kill('SIGTERM')}catch{}}
