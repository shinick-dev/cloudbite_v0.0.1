// Aside는 RTC·권한·가짜 시계를 주입하지 못하므로 격리한 Edge fixture에서 브라우저 동작을 점검한다.
// 실제 Monaco/xterm 입력까지 확인. SFU만 합성 응답이며 실제 네트워크 영상 품질은 별도 리허설 대상.
// npm install --prefix <dir> --no-audit --no-fund monaco-editor@0.57.0 @xterm/xterm@6.0.0
// $env:GW_LIVE_FIXTURE_MODULES='<dir>/node_modules'; node test/lab-live-ui.mjs
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { LAB_LIVE_SEAT_JS, LAB_LIVE_TEACHER_JS } from '../src/lablive.ts';
import { LAB_DOM_CAPTURE_JS, LAB_DOM_CAPTURE_PRELUDE_JS } from '../src/lab-dom-capture.generated.ts';
const artifact=path.resolve(process.env.GW_LIVE_ARTIFACTS??'../.artifacts/gw-live-ui');
const modules=path.resolve(process.env.GW_LIVE_FIXTURE_MODULES??path.join(artifact,'node_modules'));
await mkdir(artifact,{recursive:true});
const bundle=await build({entryPoints:['src/lab-live-service.ts'],bundle:true,write:false,format:'esm',platform:'node',logLevel:'silent'});
const {LabLiveService}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const copy=x=>x===undefined?x:structuredClone(x),data=new Map(),work=[],owner='owner-hash';
const storage={async get(k){return copy(data.get(k))},async put(k,v){data.set(k,copy(v))},async delete(k){return data.delete(k)},async list({prefix}){return new Map([...data].filter(([k])=>k.startsWith(prefix)).map(([k,v])=>[k,copy(v)]))}};
const lab={id:'room',name:'화면 지원 리허설',expiresAt:Date.now()+3600000,seats:[{n:1,code:'student-one',sandboxId:'sb1',who:'참여자'}]};
data.set('lab:room',lab);data.set('live-auth:'+owner,{expiresAt:Date.now()+8*3600000});
const realRTC=process.env.GW_LIVE_REAL_RTC==='1';
const realDOM=process.env.GW_LIVE_DOM_REAL==='1';
if(realRTC&&!process.env.REALTIME_APP_TOKEN)throw Error('REALTIME_APP_TOKEN is required for real SFU test');
if(!realRTC)globalThis.fetch=async(url,opt)=>{const body=JSON.parse(opt.body||'null');return Response.json(url.endsWith('/sessions/new')?{sessionId:crypto.randomUUID()}:url.endsWith('/tracks/new')?{sessionDescription:{type:body.sessionDescription?'answer':'offer',sdp:'v=0\r\nfixture'},tracks:[{mid:'0'}]}:{})};
const service=new LabLiveService({storage,env:{REALTIME_APP_ID:realRTC?'c29dbceb14ae7159c05ee756c190ddc2':'test',REALTIME_APP_TOKEN:realRTC?process.env.REALTIME_APP_TOKEN:'test'},authorize:async t=>t==='live'?{owner,expiresAt:Date.now()+8*3600000}:null,seatOf:async code=>code==='student-one'?{lab,seat:lab.seats[0]}:{status:403,error:'wrong seat'},schedule:async()=>{},waitUntil:p=>work.push(p),audit:async()=>{}});
let statusGate=null,releaseGate=null,startGate=null,statusHeld=0,startHeld=0,slowFirstStart=!realRTC,openStatus=()=>{},openRelease=()=>{},openStart=()=>{};
let rtc=`
window.__displayPrompts=0;Object.defineProperty(navigator.mediaDevices,'getDisplayMedia',{configurable:true,value:async()=>{window.__displayPrompts++;throw Error('display capture must not be requested')}});
window.__labDomCapture={open:async()=>{const c=document.createElement('canvas');c.width=1200;c.height=800;let frame=0;const draw=()=>{const x=c.getContext('2d');x.fillStyle=frame++%2?'#d5e0dc':'#2456bc';x.fillRect(0,0,c.width,c.height);x.fillStyle='#fff';x.font='40px sans-serif';x.fillText('Live screen rehearsal '+frame,80,100)};draw();const s=c.captureStream(8);const tm=setInterval(draw,500);window.__liveTrack=s.getVideoTracks()[0];return{stream:s,stop(){clearInterval(tm);s.getTracks().forEach(t=>t.stop())}}}};
window.RTCPeerConnection=class{constructor(){this.localDescription={sdp:'v=0\\r\\nfixture'};this.connectionState='new';(window.__pcs||=[]).push(this)}addTransceiver(){return{mid:'0'}}async createOffer(){return{type:'offer',sdp:'v=0\\r\\nfixture'}}async createAnswer(){return{type:'answer',sdp:'v=0\\r\\nfixture'}}async setLocalDescription(d){this.localDescription=d}async setRemoteDescription(){if(this.ontrack){const c=document.createElement('canvas');c.width=1200;c.height=800;let frame=0;const draw=()=>{c.getContext('2d').fillStyle=frame++%2?'#2456bc':'#d5e0dc';c.getContext('2d').fillRect(0,0,1200,800)};draw();this.media=c.captureStream(8);this.frameTimer=setInterval(draw,500);this.ontrack({streams:[this.media]})}}close(){this.connectionState='closed';clearInterval(this.frameTimer);this.media?.getTracks().forEach(t=>t.stop())}};
`;
if(realRTC)rtc=rtc.slice(0,rtc.indexOf('window.RTCPeerConnection=class'))+`window.__peers=[];const NativePeer=window.RTCPeerConnection;window.RTCPeerConnection=class extends NativePeer{constructor(...a){super(...a);window.__peers.push(this)}};`;
if(realDOM){const begin=rtc.indexOf('window.__labDomCapture=');const end=rtc.indexOf('window.RTCPeerConnection=class');const native=rtc.indexOf('window.__peers=');rtc=rtc.slice(0,begin)+rtc.slice(realRTC?native:end);}
const domScripts=realDOM?`<script>${LAB_DOM_CAPTURE_PRELUDE_JS.replace(/<\/script/gi,'<\\/script')}</script><script>${LAB_DOM_CAPTURE_JS.replace(/<\/script/gi,'<\\/script')};const actualOpen=window.__labDomCapture.open;window.__labDomCapture.open=async(...args)=>{const c=await actualOpen(...args);window.__activeCapture=c;window.__liveTrack=c.stream.getVideoTracks()[0];return c};</script>`:'';
const student=`<!doctype html><html lang="ko"><meta charset="utf-8"><link rel="stylesheet" href="/modules/@xterm/xterm/css/xterm.css"><body style="margin:0;font:16px system-ui"><div id="bar" style="position:fixed;bottom:8px;right:8px;z-index:1000;background:#234;color:white;padding:8px"><span></span></div>
<div style="height:160px"></div><button id="target" onclick="window.clicks=(window.clicks||0)+1">클릭 확인</button><label>일반 입력<textarea id="plain" style="display:block;width:400px;height:50px"></textarea></label>
<div id="editor" style="width:900px;height:220px"></div><div id="terminal" style="height:180px"></div>
<script>${rtc}window.__labBarUI={box:document.getElementById('bar'),BTN:'color:white;background:#234',note:t=>{window.notice=t},el:()=>{}};</script>
${domScripts}<script src="/modules/@xterm/xterm/lib/xterm.js"></script>${realDOM?'<script src="/modules/@xterm/addon-webgl/lib/addon-webgl.js"></script>':''}<script src="/modules/monaco-editor/min/vs/loader.js"></script>
<script>window.terminalData='';window.term=new Terminal({cols:90,rows:8});term.open(document.getElementById('terminal'));${realDOM?'window.glAddon=new WebglAddon.WebglAddon();term.loadAddon(glAddon);':''}term.onData(t=>{window.terminalData+=t;term.write(t==='\\r'?'\\r\\n':t)});term.write('ready> ');require.config({paths:{vs:'/modules/monaco-editor/min/vs'}});require(['vs/editor/editor.main'],()=>{window.editor=monaco.editor.create(document.getElementById('editor'),{value:'',language:'plaintext',minimap:{enabled:false},automaticLayout:true});window.editorReady=true});</script>
<script>${LAB_LIVE_SEAT_JS}</script></body></html>`;
const teacher=`<!doctype html><html lang="ko"><meta charset="utf-8"><style>:root{--line:#ccc;--bg:#fff;--fg:#111;--acc:#2456bc}.lab-live-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,340px),1fr));gap:20px}body{font:16px system-ui;margin:16px}button{font:inherit;margin:4px;padding:8px}section{min-width:0}.row{display:flex;flex-wrap:wrap}video{max-width:100%}</style><body><main id="live"></main><script>${rtc}${LAB_LIVE_TEACHER_JS}
const btn=(t,c,f)=>{const b=document.createElement('button');b.textContent=t;b.onclick=f;return b};window.live=createLabLiveTeacher({root:document.getElementById('live'),btn,screenRow:()=>document.createElement('div'),call:async(path,b)=>{const r=await fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)});const j=await r.json();if(!r.ok)throw Object.assign(Error(j.error),{status:r.status});return j}});live.start();</script></body></html>`;
const server=createServer(async(req,res)=>{try{const url=new URL(req.url,'http://localhost');
 if(url.pathname.startsWith('/modules/')){const file=path.resolve(modules,'.'+url.pathname.slice('/modules'.length));if(!file.startsWith(modules+path.sep)){res.writeHead(403).end();return}const body=await readFile(file);res.setHeader('content-type',file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':'application/octet-stream');res.end(body);return}
 if(req.method==='GET'){res.setHeader('content-type','text/html;charset=utf-8');res.end(url.pathname==='/student'?student:teacher);return}
 let raw='';for await(const part of req)raw+=part;const b=JSON.parse(raw||'{}');let result;
 if(url.pathname.startsWith('/__lab/live/')){switch(url.pathname.split('/').at(-1)){
  case'start':if(slowFirstStart){slowFirstStart=false;await new Promise(r=>setTimeout(r,2300))}result=await service.start('student-one',b.tab,b.sdp,b.tracks);if(startGate){const held=startGate;startGate=null;startHeld++;try{await held}finally{startHeld--}}break;case'stop':result=await service.stop('student-one',b.tab);break;
  case'state':result=await service.seatState('student-one',b.tab,b.ack,b.viewport,b.ackRequest);break;case'consent':result=await service.consent('student-one',b.tab,b.requestId,b.allow);break;
 }}else{switch(url.pathname.split('/').at(-1)){
  case'quality':result=await service.quality('live',b.viewerTab,b.revision,b.at,b.focus);break;case'status':if(statusGate){statusHeld++;try{await statusGate}finally{statusHeld--}}result=await service.status('live');break;case'pull':result=await service.pull('live',b.id,b.n);break;case'answer':result=await service.pull('live',b.id,b.n,b.sid,b.sdp);break;
  case'request':result=await service.requestControl('live',b.id,b.n,b.requestId);break;case'release':if(releaseGate)await releaseGate;result=await service.release('live',b.id,b.n,b.requestId);break;case'input':result=await service.input('live',b.id,b.n,b.requestId,b.eventId,b.event);break;case'close':result=await service.close('live',b.id,b.n);break;
 }}res.writeHead(result?.status??200,{'content-type':'application/json'}).end(JSON.stringify(result??{}));
 }catch(e){res.writeHead(500).end(JSON.stringify({error:e.message}))}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
const browser=await chromium.launch({channel:'msedge',headless:true}),context=await browser.newContext({viewport:{width:1200,height:800}});
const errors=[];context.on('page',p=>p.on('pageerror',e=>errors.push(e.message)));
const participant=await context.newPage(),host=await context.newPage();
try{
 await participant.goto(origin+'/student');await participant.waitForFunction(()=>window.editorReady);
 await host.goto(origin+'/teacher');await host.getByRole('button',{name:'크게 보기',exact:true}).waitFor();
 if(realDOM){
  await participant.waitForFunction(()=>window.__activeCapture?.stats().quality==='preview');
  const initialV=(await service.status('live')).labs[0].seats[0].v;
  if(realRTC)await participant.waitForFunction(()=>window.__peers?.some(p=>p.getSenders().some(s=>s.track?.kind==='video'&&s.getParameters().encodings[0]?.maxBitrate===400000)));
  assert.ok(await participant.evaluate(()=>window.__activeCapture.snapshot().width<=640&&window.__activeCapture.snapshot().height<=400));
  await host.getByRole('button',{name:'크게 보기',exact:true}).click();
  await participant.waitForFunction(()=>window.__activeCapture?.stats().quality==='detail');
  if(realRTC)await participant.waitForFunction(()=>window.__peers?.some(p=>p.getSenders().some(s=>s.track?.kind==='video'&&s.getParameters().encodings[0]?.maxBitrate===4000000)));
  await host.getByRole('button',{name:'작게 보기',exact:true}).click();
  await participant.waitForFunction(()=>window.__activeCapture?.stats().quality==='preview');
  assert.equal((await service.status('live')).labs[0].seats[0].v,initialV,'quality changes must not republish the source');
  assert.equal((await service.status('live')).labs[0].seats[0].control,null,'quality selection never grants input permission');
  console.log('PASS preview/detail switch changes capture pixels without republish or input permission');
 }
 await host.getByRole('button',{name:'도와주기',exact:true}).click();
 await host.getByRole('button',{name:'제어 요청',exact:true}).click();await participant.getByRole('button',{name:'5분 동안 제어 허용',exact:true}).waitFor({state:'visible'});await participant.getByRole('button',{name:'5분 동안 제어 허용',exact:true}).click();
 await host.waitForFunction(()=>document.querySelector('[data-live-seat]')?.dataset.control==='active');
 console.log('PASS initial publish survives heartbeat while connecting');
 assert.equal(await participant.getByRole('button',{name:'내 화면 공유',exact:true}).count(),0);
 assert.equal(await participant.evaluate(()=>window.__displayPrompts),0);
 assert.ok((await participant.locator('[data-live-auto]').innerText()).includes('자동 공유 중'));
 console.log('PASS automatic lab view requires no share button or display picker');
 const send=async text=>{await host.locator('textarea').fill(text);await host.getByRole('button',{name:'입력 보내기',exact:true}).click()};
 const remoteClick=async(selector,offset)=>{const viewport=await participant.evaluate(()=>({width:innerWidth,height:innerHeight}));const p=await participant.locator(selector).boundingBox();const info=await host.locator('video').evaluate(v=>({rect:{x:v.getBoundingClientRect().x,y:v.getBoundingClientRect().y,width:v.getBoundingClientRect().width,height:v.getBoundingClientRect().height},width:v.videoWidth,height:v.videoHeight}));
  const scale=Math.min(info.rect.width/info.width,info.rect.height/info.height),w=info.width*scale,h=info.height*scale;
  await host.locator('video').click({position:{x:(info.rect.width-w)/2+(p.x+(offset?.x??p.width/2))/viewport.width*w,y:(info.rect.height-h)/2+(p.y+(offset?.y??p.height/2))/viewport.height*h}});
 };
 await host.waitForFunction(()=>document.querySelector('video').videoWidth>0);
 await remoteClick('#target');await participant.waitForFunction(()=>window.clicks===1);console.log('PASS remote click on participant DOM');
 await remoteClick('#plain');await send('안녕하세요');await participant.waitForFunction(()=>document.getElementById('plain').value==='안녕하세요');console.log('PASS Korean text into normal textarea');
 await remoteClick('#editor',{x:100,y:25});await send('메모 두 개로 보고서');await participant.waitForFunction(()=>window.editor.getValue()==='메모 두 개로 보고서');console.log('PASS Korean text into actual Monaco editor');
 await remoteClick('#terminal',{x:100,y:15});await send('echo rehearsal');await participant.waitForFunction(()=>window.terminalData.includes('echo rehearsal')); await host.locator('video').press('Enter');await participant.waitForFunction(()=>window.terminalData.endsWith('\r'));console.log('PASS text and Enter into actual xterm');
 if(realDOM&&realRTC){
  // A new viewport is a separate observation experiment, outside prior consent.
  await host.getByRole('button',{name:'제어 끝내기',exact:true}).click();
  await participant.waitForFunction(()=>!(document.querySelector('[data-live-support] p')?.textContent||'').includes('제어 중'));
  await participant.setViewportSize({width:1920,height:1080});
  await host.waitForFunction(()=>{const v=document.querySelector('video');return v?.videoWidth===1920&&v.videoHeight===1080},null,{timeout:30000});
  const samples=[],sourceSamples=[];
  const mediaStats=page=>page.evaluate(async()=>{const out=[];for(const pc of window.__peers||[]){for(const r of (await pc.getStats()).values()){if(!['outbound-rtp','inbound-rtp','remote-inbound-rtp'].includes(r.type)||r.kind==='audio')continue;const keys=['type','kind','framesEncoded','framesDecoded','framesPerSecond','frameWidth','frameHeight','jitterBufferDelay','jitterBufferEmittedCount','jitterBufferTargetDelay','totalEncodeTime','totalPacketSendDelay','qualityLimitationReason','roundTripTime','jitter','bytesSent','bytesReceived'];out.push(Object.fromEntries(keys.filter(k=>r[k]!==undefined).map(k=>[k,r[k]])))}}return out});
  try{
   for(let i=0;i<5;i++){
    const color=i%2?[32,208,80]:[224,48,96],started=Date.now();
    await participant.evaluate(color=>{let marker=document.querySelector('[data-capture-probe]');if(!marker){marker=document.createElement('div');marker.dataset.captureProbe='';marker.style.cssText='position:fixed;left:40px;top:40px;width:80px;height:80px;z-index:19';document.body.append(marker)}marker.style.backgroundColor='rgb('+color.join(',')+')'},color);
    await participant.waitForFunction(color=>{const frame=window.__activeCapture?.snapshot();if(!frame)return false;const px=frame.getContext('2d').getImageData(Math.round(70*frame.width/1920),Math.round(70*frame.height/1080),1,1).data;return color.every((v,k)=>Math.abs(px[k]-v)<3)},color,{timeout:15000});
    sourceSamples.push(Date.now()-started);
    await host.waitForFunction(color=>{const v=document.querySelector('video');if(!v?.videoWidth)return false;const c=document.createElement('canvas');c.width=c.height=1;const ctx=c.getContext('2d');ctx.drawImage(v,Math.round(70*v.videoWidth/1920),Math.round(70*v.videoHeight/1080),1,1,0,0,1,1);const px=ctx.getImageData(0,0,1,1).data;return color.every((value,k)=>Math.abs(px[k]-value)<40)},color,{timeout:15000});
    samples.push(Date.now()-started);
   }
  }finally{await participant.evaluate(()=>document.querySelector('[data-capture-probe]')?.remove())}
  const perf={sourceMs:sourceSamples,sourceStats:await participant.evaluate(()=>({capture:window.__activeCapture?.stats(),hidden:document.hidden})),sender:await mediaStats(participant),receiver:await mediaStats(host),samplesMs:samples,medianMs:[...samples].sort((a,b)=>a-b)[2],maxMs:Math.max(...samples),received:await host.locator('video').evaluate(v=>({width:v.videoWidth,height:v.videoHeight}))};
  await writeFile(path.join(artifact,'real-dom-performance.json'),JSON.stringify(perf,null,2));
  console.log('REAL_SFU_LATENCY '+JSON.stringify(perf));
  assert.ok(perf.maxMs<3000,'changed pixels must travel through the real SFU in under 3s in this fixture');
  console.log('PASS full HD changed pixels received through real SFU');
  await host.getByRole('button',{name:'제어 요청',exact:true}).click();
  await participant.getByRole('button',{name:'5분 동안 제어 허용',exact:true}).click();
  await host.waitForFunction(()=>document.querySelector('[data-live-seat]')?.dataset.control==='active');
  await remoteClick('#target'); await participant.waitForFunction(()=>window.clicks===2);
  console.log('PASS full HD frame preserves participant click coordinates after renewed consent');
  await host.waitForFunction(()=>/참여자 영상 수신 \d+\.\d+ MB/.test(document.querySelector('[data-live-usage]').textContent));
  await participant.waitForFunction(()=>/송신 \d+\.\d+ MB/.test(document.querySelector('[data-live-usage]').textContent));
  console.log('PASS real video payload counters displayed in teacher and participant tabs');
 }
 if(realDOM){await host.waitForTimeout(7000);await participant.screenshot({path:path.join(artifact,'actual-lab-original.png')});await host.locator('video').screenshot({path:path.join(artifact,'actual-lab-received.png')});console.log('PASS actual DOM capture transported into teacher video; inspect original and received PNGs for fidelity');}
 const clicksBeforePause=await participant.evaluate(()=>window.clicks||0);
 await host.locator('video').evaluate(v=>v.pause());
 await host.waitForFunction(()=>{const box=document.querySelector('[data-live-seat]');return box?.dataset.control!=='active'&&!(box.innerText||'').includes('모임지기가 제어 중')});
 assert.equal(await host.getByRole('button',{name:'입력 보내기',exact:true,includeHidden:true}).isDisabled(),true);
 assert.equal(await host.getByRole('button',{name:'제어 끝내기',exact:true}).isEnabled(),true,'paused video still permits ending consent');
 await host.locator('video').click({position:{x:40,y:40},force:true});
 await host.waitForTimeout(700);
 assert.equal(await participant.evaluate(()=>window.clicks||0),clicksBeforePause);
 console.log('PASS paused video drops active control and ignores input');
 await host.locator('video').evaluate(v=>v.play());
 await host.waitForFunction(()=>document.querySelector('[data-live-seat]')?.dataset.control==='active',null,{timeout:15000});
 if(!realRTC){
 await host.evaluate(()=>{const pc=window.__pcs.at(-1);pc.connectionState='failed';pc.onconnectionstatechange()});
 await host.waitForFunction(()=>{const box=document.querySelector('[data-live-seat]');return box?.dataset.control!=='active'&&!(box.innerText||'').includes('모임지기가 제어 중')});
 await host.waitForFunction(()=>document.querySelector('[data-live-seat]')?.dataset.control==='active',null,{timeout:15000});
 console.log('PASS dropped video clears active control until frames return');
 }
 await participant.getByRole('button',{name:'제어 즉시 끝내기',exact:true}).click();await host.waitForFunction(()=>document.querySelector('[data-live-seat]')?.dataset.control!=='active');
 assert.equal(await host.getByRole('button',{name:'입력 보내기',exact:true,includeHidden:true}).isDisabled(),true);console.log('PASS participant revocation disables teacher input');
 await host.screenshot({path:path.join(artifact,'teacher-desktop.png'),fullPage:true});await participant.screenshot({path:path.join(artifact,'participant-desktop.png'),fullPage:true});
 await host.setViewportSize({width:390,height:844});await host.screenshot({path:path.join(artifact,'teacher-mobile.png'),fullPage:true});assert.ok(await host.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await participant.setViewportSize({width:390,height:844});await participant.screenshot({path:path.join(artifact,'participant-mobile.png'),fullPage:true});
 const grant=async()=>{await host.bringToFront();await host.locator('video').evaluate(v=>v.paused?v.play():undefined);await host.waitForFunction(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.textContent==='제어 요청');return b&&!b.disabled});await host.getByRole('button',{name:'제어 요청',exact:true}).click();await participant.getByRole('button',{name:'5분 동안 제어 허용',exact:true}).click();await host.bringToFront();await host.locator('video').evaluate(v=>v.paused?v.play():undefined);await host.waitForFunction(()=>document.querySelector('[data-live-seat]')?.dataset.control==='active',null,{timeout:15000})};
 await grant();
 statusGate=new Promise(r=>{openStatus=r});releaseGate=new Promise(r=>{openRelease=r});
 await host.evaluate(()=>document.dispatchEvent(new Event('visibilitychange')));
 for(let n=0;statusHeld===0&&n<80;n++)await new Promise(r=>setTimeout(r,100));
 if(statusHeld===0)throw Error('status poll did not block');
 await host.getByRole('button',{name:'제어 끝내기',exact:true}).click();
 await host.waitForFunction(()=>{const box=document.querySelector('[data-live-seat]');return box?.dataset.control!=='active'&&!(box.innerText||'').includes('모임지기가 제어 중')});
 openStatus();statusGate=null;await host.waitForTimeout(600);
 assert.notEqual(await host.locator('[data-live-seat]').getAttribute('data-control'),'active');
 assert.equal((await host.locator('[data-live-seat]').innerText()).includes('모임지기가 제어 중'),false);
 openRelease();releaseGate=null;
 await host.waitForFunction(()=>{const box=document.querySelector('[data-live-seat]');return box?.dataset.control!=='active'&&!(box.innerText||'').includes('모임지기가 제어 중')});
 console.log('PASS stale status cannot restore released control');
 await host.getByRole('button',{name:'제어 요청',exact:true}).click();
 await participant.getByRole('button',{name:'거절',exact:true}).waitFor({state:'visible'});
 await participant.getByRole('button',{name:'거절',exact:true}).click();
 await host.waitForFunction(()=>{const box=document.querySelector('[data-live-seat]');return box?.dataset.control!=='active'&&!(box.innerText||'').includes('모임지기가 제어 중')});
 await participant.waitForFunction(()=>!(document.querySelector('[data-live-support] p')?.textContent||'').includes('제어 중'));
 assert.equal(await host.getByRole('button',{name:'입력 보내기',exact:true,includeHidden:true}).isDisabled(),true);
 assert.equal(await participant.getByRole('button',{name:'5분 동안 제어 허용',exact:true}).isVisible(),false);
 console.log('PASS denied consent is not active control');
 await grant();
 const key=[...data.keys()].find(k=>String(k).startsWith('live-control:'));
 data.set(key,{...data.get(key),expiresAt:Date.now()-1000});
 await host.waitForFunction(()=>{const box=document.querySelector('[data-live-seat]');return box?.dataset.control!=='active'&&!(box.innerText||'').includes('모임지기가 제어 중')});
 await participant.waitForFunction(()=>!(document.querySelector('[data-live-support] p')?.textContent||'').includes('제어 중'));
 assert.equal(await host.getByRole('button',{name:'입력 보내기',exact:true,includeHidden:true}).isDisabled(),true);
 console.log('PASS expired lease is not shown as active');
 await participant.evaluate(()=>window.__liveTrack.dispatchEvent(new Event('ended')));
 await host.waitForFunction(()=>document.querySelector('video').srcObject===null);
 await participant.waitForTimeout(200);
 startGate=new Promise(r=>{openStart=r});
 await participant.evaluate(()=>window.dispatchEvent(new Event('focus')));
 for(let i=0;!startHeld&&i<(realRTC?600:80);i++)await new Promise(r=>setTimeout(r,50));
 assert.equal(startHeld,1,'old publication response is held');
 await participant.evaluate(()=>window.__liveTrack.dispatchEvent(new Event('ended')));
 for(let i=0;(await service.status('live')).labs[0].seats[0].sharing&&i<80;i++)await new Promise(r=>setTimeout(r,50));
 await participant.waitForTimeout(200);
 await participant.evaluate(()=>window.dispatchEvent(new Event('focus')));
 await participant.waitForFunction(()=>document.querySelector('[data-live-auto]')?.textContent==='실습실 화면 자동 공유 중');
 const currentV=(await service.status('live')).labs[0].seats[0].v;
 openStart();await participant.waitForTimeout(700);
 const current=(await service.status('live')).labs[0].seats[0];
 assert.equal(current.sharing,true);assert.equal(current.v,currentV,'late old start must not stop newer same-tab capture');
 assert.equal(await participant.evaluate(()=>window.__displayPrompts),0);
 await participant.goto('about:blank');
 for(let i=0;(await service.status('live')).labs[0].seats[0].sharing&&i<80;i++)await new Promise(r=>setTimeout(r,50));
 assert.equal((await service.status('live')).labs[0].seats[0].sharing,false,'leaving lab stops automatic observation');
 console.log('PASS late start response preserves newer same-tab publication');
 assert.deepEqual(errors,[]);console.log('PASS stop, cleanup, responsive wall, no browser exceptions');
}catch(e){console.log(await participant.evaluate(()=>({value:window.editor?.getValue(),active:document.activeElement?.outerHTML?.slice(0,300),terminalData:window.terminalData,notice:window.notice,peers:window.__peers?.map(p=>({state:p.connectionState,ice:p.iceConnectionState}))})).catch(err=>({evaluate:err.message})));console.log(await host.evaluate(()=>({text:document.body.innerText,control:document.querySelector('[data-live-seat]')?.dataset.control,peers:window.__peers?.map(p=>({state:p.connectionState,ice:p.iceConnectionState}))})).catch(err=>({evaluate:err.message})));await participant.screenshot({path:path.join(artifact,'failure-student.png'),fullPage:true}).catch(()=>{});throw e}
finally{openStatus();openRelease();openStart();await browser.close();await service.clear('room');await Promise.allSettled(work);await new Promise(r=>server.close(r))}
