// Run only with tools/realdev.ps1. One isolated Daytona seat; always cleaned up.
// Uses the actual code-server document, production capture scripts and real SFU.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { adminSetup, call, GW, SoftKey } from '../test/lib.mjs';

assert.equal(new URL(GW).hostname, 'localhost', 'isolated localhost gateway required');
const artifact=path.resolve(process.env.GW_CAPTURE_ARTIFACTS??'../.artifacts/live-capture-repair');
await mkdir(artifact,{recursive:true});
const key=new SoftKey();
let admin=await adminSetup(key,process.env.SETUP_TOKEN),labId,browser;
const name='capture-repro-'+randomBytes(4).toString('hex');
const a=(p,b)=>call(p,b,admin);
const report={errors:[],checks:[]};
const ok=(name,value)=>{report.checks.push({name,ok:!!value});assert.ok(value,name);console.log('PASS '+name)};
try {
 for(const preset of ['daytona','openrouter']) {
  const value=process.env[preset==='daytona'?'DAYTONA_API_KEY':'OPENROUTER_MANAGEMENT_KEY'];
  assert.ok(value,'provider required');
  assert.equal((await a('/api/admin/provider',{preset,value})).status,200);
 }
 const requestId='lc_'+Date.now()+'_'+randomBytes(16).toString('hex');
 const body={requestId,name,seats:1,hours:1,budget:1,cpu:1,memory:2,disk:5,gw:GW,materials:''};
 let made=await a('/api/lab/create',body);
 const deadline=Date.now()+360000;
 while(made.status===202&&Date.now()<deadline){
  await new Promise(r=>setTimeout(r,5000));
  made=await a(made.j.snapshotPreparing?'/api/lab/create':'/api/lab/create-status',made.j.snapshotPreparing?body:{requestId});
 }
 assert.equal(made.status,200,'one test seat created: '+JSON.stringify({status:made.status,error:made.j?.error}));
 labId=made.j.lab.id;
 const invite=await a('/api/lab/invite',{id:labId,n:1});
 assert.equal(invite.status,200,'invite');
 // A fresh web login is required for the viewer cookie. This is a test-only key.
 const opt=await call('/api/admin/options',{});
 const login=await call('/api/admin/login',{assertion:key.get(opt.j)});
 admin={'x-admin-token':login.j.token};
 assert.ok(admin['x-admin-token'],'web admin issued');
 browser=await chromium.launch({channel:'msedge',headless:true});
 const context=await browser.newContext({viewport:{width:1280,height:800}});
 const host=await context.newPage(),student=await context.newPage();
 student.on('pageerror',e=>report.errors.push({stage:'page',message:e.message.slice(0,350)}));
 student.on('console',m=>{if(m.type()==='error')report.errors.push({stage:'console',message:m.text().replace(/https?:\/\/[^\s"')]+/g,'[url]').slice(0,350)})});
 await host.goto(GW+'/lab');
 const session=await host.evaluate(async token=>{
  const r=await fetch('/api/lab/live/session',{method:'POST',headers:{'content-type':'application/json','x-admin-token':token},body:'{}'});
  if(r.ok){LLIVE.start();view()}
  return r.status;
 },admin['x-admin-token']);
 assert.equal(session,200,'viewer session');
 await student.goto(invite.j.link);
 await student.locator('#go').click();
 await student.waitForSelector('.monaco-workbench',{timeout:240000});
 await student.waitForFunction(()=>window.__labDomCapture&&window.__labBarUI,{timeout:30000});
 console.log('PASS actual code-server loaded');
 report.resources=await student.evaluate(()=>({images:[...document.images].map(i=>({src:i.getAttribute('src')?.slice(0,200),complete:i.complete,width:i.naturalWidth})),video:[...document.querySelectorAll('video')].map(v=>({src:!!v.currentSrc,poster:!!v.poster,width:v.clientWidth,height:v.clientHeight}))}));
 // Capture directly too, so a media failure cannot hide the original render error.
 report.capture=await student.evaluate(async()=>{
  let detail;
  try{const c=await window.__labDomCapture.open({onError:e=>{detail={type:e?.type,name:e?.name,message:e?.message,src:e?.target?.src?.slice(0,180)}}});const f=c.snapshot();const v={ok:true,width:f.width,height:f.height,current:c.isCurrent()};c.stop();return v}
  catch(e){return {ok:false,name:e.name,message:e.message||String(e),detail,stack:e.stack?.split('\n').slice(0,6)}}
 });
 console.log('CAPTURE '+JSON.stringify(report.capture));
 ok('actual code-server DOM produces a frame',report.capture.ok);
 await host.waitForFunction(()=>[...document.querySelectorAll('video')].some(v=>v.videoWidth>0&&v.getVideoPlaybackQuality().totalVideoFrames>0),null,{timeout:60000});
 const video=host.locator('[data-live-seat] video').first();
 const before=await video.evaluate(v=>v.getVideoPlaybackQuality().totalVideoFrames);
 await student.waitForTimeout(10000);
 const after=await video.evaluate(v=>({frames:v.getVideoPlaybackQuality().totalVideoFrames,width:v.videoWidth,height:v.videoHeight}));
 report.media={before,...after};
 ok('teacher receives advancing real SFU frames',after.frames>before);
 await student.screenshot({path:path.join(artifact,'real-participant.png')});
 await video.screenshot({path:path.join(artifact,'real-received.png')});
} finally {
 if(browser)await browser.close();
 // Also find a completed create whose response was lost. Never touch other labs.
 if(!labId){const list=await a('/api/lab/list',{});labId=list.j?.labs?.find(l=>l.name===name)?.id}
 if(labId){const ended=await a('/api/lab/end',{id:labId});report.cleanup={status:ended.status};console.log('CLEANUP '+ended.status)}
 await writeFile(path.join(artifact,'report.json'),JSON.stringify(report,null,2));
}
