// Opt-in real Cloudflare SFU: synthetic workspace/auth, actual sender/receiver UI,
// DOM capture, bridge, media service, WebRTC and decoded participant pixels.
// No Daytona or production classroom mutations. Only this run's SFU tracks close.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,writeFile} from 'node:fs/promises';
import {build} from 'esbuild';
import {chromium} from 'playwright-core';
import {operatorFixture} from '../test/fixtures/lab-operator-ui.mjs';
import {labDemoEmbedBridgeJS} from '../src/lab-demo-embed-bridge.ts';
import {LAB_DOM_CAPTURE_JS} from '../src/lab-dom-capture.generated.ts';
import {LAB_RTC_JS} from '../src/labrtc.ts';
import {LAB_SCREEN_JS} from '../src/labscreen.ts';
if(process.env.RUN_REAL_SFU!=='1'||!process.env.REALTIME_APP_TOKEN)throw Error('Opt in with RUN_REAL_SFU=1 and REALTIME_APP_TOKEN; never print the token.');
const bundle=await build({entryPoints:['src/lab-screen-service.ts'],bundle:true,write:false,platform:'node',format:'esm'});
const {LabScreenService}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const store=new Map(),tasks=new Set(),now=Date.now();store.set('lab:ux-a',{id:'ux-a',name:'Isolated SFU smoke',expiresAt:now+600000});
const service=new LabScreenService({storage:{get:async k=>structuredClone(store.get(k)),put:async(k,v)=>store.set(k,structuredClone(v)),delete:async k=>store.delete(k),list:async({prefix})=>new Map([...store].filter(([k])=>k.startsWith(prefix)))},env:{REALTIME_APP_ID:'c29dbceb14ae7159c05ee756c190ddc2',REALTIME_APP_TOKEN:process.env.REALTIME_APP_TOKEN},checkAdmin:async t=>t==='synthetic-admin',seatOf:async()=>({lab:store.get('lab:ux-a')}),schedule:async()=>{},audit:async()=>{},answerTtl:()=>30000,waitUntil:p=>{tasks.add(p);p.finally(()=>tasks.delete(p)).catch(()=>{})}});
let fixture,child,browser;
const json=(res,value)=>{const status=value?.status||200;res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'}).end(JSON.stringify(value));return true};
try{
 fixture=await operatorFixture(0,{nativeRTC:true,route:async(req,res)=>{
  const path=new URL(req.url,'http://x').pathname;
  if(path==='/__smoke/student'){res.writeHead(200,{'content-type':'text/html;charset=utf-8'}).end('<!doctype html><title>합성 참여자 · 실제 SFU 수신</title><h1>합성 참여자 · 실제 SFU 수신</h1><script>'+LAB_SCREEN_JS+'</script><script>'+LAB_RTC_JS+'</script>');return true}
  if(path==='/__lab/screen')return json(res,await service.state('synthetic-seat'));
  if(!path.startsWith('/api/lab/screen/')&&!path.startsWith('/__lab/screen/'))return false;
  let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw||'{}');
  const action=path.split('/').at(-1);
  if(path.startsWith('/api/')){
   const token=req.headers['x-admin-token'];
   if(action==='start')return json(res,await service.start(token,body.id,body.sdp,body.tracks));
   if(action==='stop')return json(res,await service.stop(token,body.id));
   if(action==='status')return json(res,await service.list(token));
  }else{
   if(action==='pull')return json(res,await service.pull('synthetic-seat'));
   if(action==='answer')return json(res,await service.answer('synthetic-seat',body.sid,body.sdp));
  }
  return json(res,{status:404,error:'fixture route missing'});
 }});
 fixture.state.live=false;fixture.state.requests=[];fixture.state.rooms[0].seats.forEach(s=>s.hand=null);
 child=createServer((req,res)=>{if(req.url==='/capture.js')return res.writeHead(200,{'content-type':'text/javascript'}).end(LAB_DOM_CAPTURE_JS);res.writeHead(200,{'content-type':'text/html;charset=utf-8','cache-control':'no-store'}).end('<!doctype html><html><head><style>body{margin:0;min-height:100vh;background:#152132;color:white;font:32px sans-serif}textarea{width:80%;height:250px;font:28px monospace}</style></head><body><h1>합성 시연실 · 실제 SFU 송출 검증</h1><textarea aria-label="draft">demo pixels</textarea><button id="color">색상 바꾸기</button><script>document.getElementById("color").onclick=()=>document.body.style.backgroundColor="#b41840";</script><script src="/capture.js"></script><script>'+labDemoEmbedBridgeJS(fixture.origin)+'</script></body></html>')});
 await new Promise(r=>child.listen(0,'127.0.0.1',r));fixture.state.demoReady=true;fixture.state.demoUrl='http://127.0.0.1:'+child.address().port+'/__lab/demo-open#'+'a'.repeat(64);
 browser=await chromium.launch({channel:'msedge',headless:true});const context=await browser.newContext({viewport:{width:1920,height:1080}}),teacher=await context.newPage(),student=await context.newPage();
 teacher.on('dialog',d=>d.accept());await teacher.goto(fixture.origin+'/lab?preview=1');await teacher.evaluate(()=>window.__uxReady);await teacher.waitForFunction(()=>!LLIVE.enabled());
 await teacher.frameLocator('#demoWorkspace iframe').getByRole('textbox').waitFor();
 assert.equal(await teacher.getByRole('button',{name:'시연 송출 시작',exact:true}).count(),1);assert.ok(await teacher.getByRole('button',{name:'시연 송출 시작',exact:true}).isVisible());console.log('ok admin retains a visible publish button without a live-preview session');
 await student.goto(fixture.origin+'/__smoke/student');await teacher.getByRole('button',{name:'시연 송출 시작',exact:true}).click();await teacher.waitForFunction(()=>SH[RID]?.startedAt,null,{timeout:30000});
 await student.waitForFunction(()=>{const v=document.querySelector('[data-lab="screen"] video');return v?.videoWidth>0&&v.getVideoPlaybackQuality().totalVideoFrames>0},null,{timeout:45000});
 const before=await student.evaluate(()=>{const v=document.querySelector('[data-lab="screen"] video');return{width:v.videoWidth,height:v.videoHeight,frames:v.getVideoPlaybackQuality().totalVideoFrames}});console.log('ok participant decodes real SFU video',before);
 await teacher.frameLocator('#demoWorkspace iframe').locator('#color').click();
 await student.waitForFunction(()=>{const v=document.querySelector('[data-lab="screen"] video');if(!v?.videoWidth)return false;const c=document.createElement('canvas');c.width=1;c.height=1;const g=c.getContext('2d');g.drawImage(v,v.videoWidth/2,v.videoHeight*.8,1,1,0,0,1,1);const p=g.getImageData(0,0,1,1).data;return p[0]>100&&p[1]<65&&p[2]<110},null,{timeout:20000});console.log('ok edited demo pixels reach the participant through actual Cloudflare SFU');
 await teacher.locator('#workspaceGallery').click();await teacher.locator('#workspaceGallery').click();assert.ok(await teacher.evaluate(()=>SH[RID]?.startedAt));
 await teacher.bringToFront();await teacher.locator('#workspaceFull').click();await teacher.waitForFunction(()=>!!document.fullscreenElement);assert.ok(await teacher.getByRole('button',{name:'시연 송출 멈추기',exact:true}).isVisible());console.log('ok full screen retains the publish controls');await teacher.evaluate(()=>document.exitFullscreen());
 await teacher.getByRole('button',{name:'시연 송출 멈추기',exact:true}).click();await student.bringToFront();await student.waitForFunction(()=>window.__labScreen?.mode==='off',null,{timeout:35000});console.log('ok stop reaches the participant');
 await mkdir('../.artifacts/classroom-broadcast-controls-20261016',{recursive:true});await writeFile('../.artifacts/classroom-broadcast-controls-20261016/real-sfu.json',JSON.stringify({at:new Date().toISOString(),before,decodedEditedPixels:true,previewSession:false,productionClassroom:false},null,2));
}finally{
 await service.clear('ux-a');await Promise.allSettled([...tasks]);await browser?.close();if(child){child.closeAllConnections();await new Promise(r=>child.close(r))}if(fixture){fixture.server.closeAllConnections();await fixture.close()}
}
