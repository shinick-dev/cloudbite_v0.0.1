// Real operator shell + child bridge, synthetic workspace and SFU (no paid resources).
// Exercises browser framing and pixel transport; this is not a live Daytona acceptance.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright-core';
import {operatorFixture} from './fixtures/lab-operator-ui.mjs';
import {labDemoEmbedBridgeJS} from '../src/lab-demo-embed-bridge.ts';
import {LAB_DOM_CAPTURE_JS,LAB_DOM_CAPTURE_PRELUDE_JS} from '../src/lab-dom-capture.generated.ts';
const art=path.resolve('../.artifacts/classroom-embedded-demo-20261016');await mkdir(art,{recursive:true});
const fixture=await operatorFixture();fixture.state.requests=[];fixture.state.demoReady=false;fixture.state.rooms[0].seats.forEach(s=>s.hand=null);
const child=createServer((req,res)=>{if(req.url==='/__lab/dom-capture.js')return res.writeHead(200,{'content-type':'text/javascript'}).end(LAB_DOM_CAPTURE_JS);return res.writeHead(200,{'content-type':'text/html;charset=utf-8','cache-control':'no-store'}).end(`<!doctype html><html><head><script>${LAB_DOM_CAPTURE_PRELUDE_JS}</script><style>body{margin:0;background:#152132;color:white;font:24px sans-serif}textarea{width:80%;height:360px;background:#152132;color:white;font:28px monospace}</style></head><body><h1>합성 시연실 · 실제 VS Code 아님</h1><textarea aria-label="합성 파일 편집기">원래 파일</textarea><button id="terminal">터미널 연습</button><output></output><script>
window.__mountId=crypto.randomUUID();document.getElementById('terminal').onclick=()=>document.querySelector('output').textContent='hello demo';
</script><script src="/__lab/dom-capture.js"></script><script>${labDemoEmbedBridgeJS(fixture.origin)}</script></body></html>`)});
await new Promise(r=>child.listen(0,'127.0.0.1',r));const childOrigin='http://127.0.0.1:'+child.address().port;
fixture.state.demoUrl=childOrigin+'/__lab/demo-open#'+'a'.repeat(64);
if(process.env.GW_EMBEDDED_DEMO_PREVIEW==='1'){
 if(process.env.GW_EMBEDDED_DEMO_NO_LIVE==='1')fixture.state.live=false;
 fixture.state.demoReady=true;console.log('Synthetic embedded demo: '+fixture.origin+'/lab?preview=1');
 await new Promise(()=>{});
}
const browser=await chromium.launch({channel:'msedge',headless:true}),page=await browser.newPage({viewport:{width:1920,height:1080}}),errors=[],checks=[];
page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(15000);
page.on('dialog',dialog=>dialog.accept());
const check=(name,value)=>{assert.ok(value,name);checks.push(name);console.log('ok '+name)};
const hash=()=>page.evaluate(async()=>{const v=document.createElement('video');v.muted=true;v.srcObject=SH[RID].s;await v.play();if(v.readyState<2)await new Promise(r=>v.addEventListener('loadeddata',r,{once:true}));const c=document.createElement('canvas');c.width=480;c.height=270;const g=c.getContext('2d');g.drawImage(v,0,0,480,270);let h=0;for(const byte of g.getImageData(0,0,480,270).data)h=(h*31+byte)>>>0;v.srcObject=null;return h});
try{
 await page.goto(fixture.origin+'/lab?preview=1');await page.evaluate(()=>window.__uxReady);
 await page.getByRole('button',{name:'시연실 만들기',exact:true}).click();
 await page.locator('#demoWorkspace iframe').waitFor({state:'visible'});
 await page.frameLocator('#demoWorkspace iframe').getByRole('textbox',{name:'합성 파일 편집기'}).waitFor();
 let frame=page.frames().find(f=>f.url().startsWith(childOrigin));assert.ok(frame);
 await frame.getByRole('textbox',{name:'합성 파일 편집기'}).fill('중앙에서 바로 편집');
 await frame.locator('#terminal').click();
 check('creation opens an interactive workspace in the center',await page.locator('#demoWorkspace').isVisible()&&await frame.locator('output').innerText()==='hello demo');
 check('one-use grant navigation asks for the embed flow',new URL(frame.url()).searchParams.get('embed')==='1');
 const mountId=await frame.evaluate(()=>window.__mountId);
 await page.getByRole('button',{name:'시연 송출 시작',exact:true}).click();await page.waitForFunction(()=>SH[RID]?.startedAt);
 check('actual child frames feed fixed 1080p without a desktop picker',await page.evaluate(()=>!window.__fixtureDisplayConstraints&&SH[RID].s.getVideoTracks()[0].getSettings().width===1920&&SH[RID].s.getVideoTracks()[0].getSettings().height===1080));
 const before=await hash(),framesBefore=await page.evaluate(()=>SH[RID].source.stats().frames);await frame.getByRole('textbox',{name:'합성 파일 편집기'}).fill('CHANGED CHILD PIXELS');await page.waitForFunction(n=>SH[RID].source.stats().frames>n,framesBefore);
 check('editing the embedded child changes the published pixels',before!==await hash());
 await page.locator('#workspaceGallery').click();await page.waitForTimeout(250);
 check('participant gallery keeps the broadcast stop control visible',await page.locator('#broadcastDock').getByRole('button',{name:'시연 송출 멈추기',exact:true}).isVisible());
 await page.locator('#workspaceGallery').click();
 check('switching to participants preserves the same frame and edits',await frame.evaluate(()=>window.__mountId)===mountId&&await frame.getByRole('textbox').inputValue()==='CHANGED CHILD PIXELS');
 for(const [width,height,name] of [[1920,1080,'1080'],[1920,980,'980'],[3840,2160,'4k']]){
  await page.setViewportSize({width,height});await page.waitForTimeout(150);
  check(name+' fits without document scrolling',await page.evaluate(()=>document.documentElement.scrollHeight<=innerHeight+1&&document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:path.join(art,'embedded-'+name+'.png')});
 }
 await page.setViewportSize({width:1920,height:1080});await page.locator('#workspaceSize').click();
 check('large view retains the same interactive frame',await frame.evaluate(()=>window.__mountId)===mountId);await page.locator('#workspaceSize').click();
 await page.locator('#workspaceFull').click();await page.waitForFunction(()=>document.fullscreenElement?.id==='demoWorkspace');
 check('full screen includes the broadcast stop control',await page.locator('#demoWorkspace #broadcastDock').getByRole('button',{name:'시연 송출 멈추기',exact:true}).isVisible());
 await page.evaluate(()=>document.exitFullscreen());
 check('full screen targets the embedded workspace',true);
 await page.locator('#demoWorkspaceModes').getByRole('button',{name:'함께 실행',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('#classMain').dataset.classMode==='together');
 check('together mode exposes its controls without replacing the demo',await page.locator('#classMain').isVisible()&&await frame.evaluate(()=>window.__mountId)===mountId);
 await page.locator('#classMain').getByRole('button',{name:'시연 보기',exact:true}).click();
 await page.waitForFunction(()=>document.querySelector('#demoWorkspace').dataset.parked==='false');
 check('demo mode returns to the same live workspace',await frame.evaluate(()=>window.__mountId)===mountId&&await page.evaluate(()=>!!SH[RID]?.startedAt));
 await page.setViewportSize({width:390,height:844});await page.waitForTimeout(150);
 check('mobile has no horizontal overflow',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:path.join(art,'embedded-mobile.png'),fullPage:true});
 check('mobile iframe retains a visible viewport',await page.locator('#demoWorkspace iframe').evaluate(e=>{const r=e.getBoundingClientRect();return r.width>100&&r.height>50&&r.left>=0&&r.right<=innerWidth+1}));
 await page.setViewportSize({width:1920,height:1080});await page.locator('#demoWorkspaceRetry').click();
 await page.frameLocator('#demoWorkspace iframe').getByRole('textbox').waitFor();
 frame=page.frames().find(f=>f.url().startsWith(childOrigin));
 check('explicit reconnect replaces the frame and stops the previous broadcast',await frame.evaluate(()=>window.__mountId)!==mountId&&await page.evaluate(()=>!SH[RID]));
 const prepares=fixture.state.calls.filter(c=>c.path==='/api/lab/classroom/demo/prepare').length;
 await page.reload();await page.evaluate(()=>window.__uxReady);await page.frameLocator('#demoWorkspace iframe').getByRole('textbox').waitFor();
 check('refresh reopens the existing demo without creating another sandbox',fixture.state.calls.filter(c=>c.path==='/api/lab/classroom/demo/prepare').length===prepares);
 frame=page.frames().find(f=>f.url().startsWith(childOrigin));
 await page.setViewportSize({width:1920,height:1080});await page.locator('#roomSelect').selectOption('ux-b');await page.waitForFunction(()=>!SH['ux-a']);
 check('room change disposes the previous iframe',!page.frames().includes(frame));
 check('no script errors',errors.length===0);
 await writeFile(path.join(art,'embedded-ui-checks.json'),JSON.stringify({checks,errors},null,2));
}finally{await browser.close();child.closeAllConnections();await new Promise(r=>child.close(r));fixture.server.closeAllConnections();await fixture.close()}
