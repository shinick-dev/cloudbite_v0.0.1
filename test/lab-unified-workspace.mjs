// Real page + real scoped canvas capture with synthetic RTC and local APIs.
// Isolated viewport/MediaStream regression; Aside also checks the integrated UI.
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright-core';
import {operatorFixture} from './fixtures/lab-operator-ui.mjs';
const art=path.resolve('../.artifacts/classroom-unified-workspace-20261016');await mkdir(art,{recursive:true});
const fixture=await operatorFixture();fixture.state.requests=[];fixture.state.rooms[0].seats.forEach(s=>s.hand=null);
const browser=await chromium.launch({channel:'msedge',headless:true});
const page=await browser.newPage({viewport:{width:1920,height:1080}}),errors=[],checks=[];
page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(12000);
const check=(name,value)=>{assert.ok(value,name);checks.push(name);console.log('ok '+name)};
const frame=()=>page.evaluate(async()=>{const stream=SH[RID]?.s;if(!stream)return null;const v=document.createElement('video');v.muted=true;v.srcObject=stream;await v.play();await new Promise(r=>v.requestVideoFrameCallback(r));const c=document.createElement('canvas');c.width=480;c.height=270;const g=c.getContext('2d');g.drawImage(v,0,0,480,270);const bytes=g.getImageData(0,0,480,270).data;let hash=0,magenta=0,dark=0;for(let i=0;i<bytes.length;i+=4){hash=(hash*31+bytes[i]+bytes[i+1]*3+bytes[i+2]*7)>>>0;if(bytes[i]>245&&bytes[i+1]<10&&bytes[i+2]>245)magenta++;if(bytes[i]<60&&bytes[i+1]<60&&bytes[i+2]<75)dark++}v.srcObject=null;return{hash,magenta,dark}});
try{
 await page.goto(fixture.origin+'/lab?preview=1');await page.evaluate(()=>window.__uxReady);await page.locator('#classMain .class-demo[data-demo-room="ux-a"]').waitFor();
 await page.waitForFunction(()=>document.querySelector('#liveTools [data-live-seat="1"]'));
 check('one toggle selects the central gallery',await page.locator('#workspaceGallery').innerText()==='참여자 모아보기'&&await page.locator('#workspaceHome').isHidden());
 await page.getByRole('button',{name:'파일 읽기',exact:true}).click();
 const editor=page.getByRole('textbox',{name:'모임지기 시연실 파일 내용'});await editor.fill('시연 화면 그대로 송출\nMy choice의 개인 화면은 포함하지 않습니다.');
 await page.evaluate(()=>{const e=document.createElement('div');e.id='outside-canary';e.textContent='ADMIN-PRIVATE-CANARY';e.style='position:fixed;inset:0;background:#ff00ff;pointer-events:none;z-index:-1';document.body.append(e)});
 await page.getByRole('button',{name:'시연 송출 시작',exact:true}).click();await page.waitForFunction(()=>SH[RID]?.kind==='demo'&&SH[RID].startedAt);
 check('default broadcast uses the actual demo without desktop picker',await page.evaluate(()=>!window.__fixtureDisplayConstraints&&SH[RID].s.getVideoTracks()[0].getSettings().width===1920&&SH[RID].s.getVideoTracks()[0].getSettings().height===1080));
 check('workspace remains editable instead of replaying its video',await editor.isVisible()&&await page.locator('#broadcastPreviewStage').isHidden());
 check('sender retains frame and bandwidth caps',await page.evaluate(()=>{const p=window.__fixturePeers.find(p=>p.sentTrack);return p.sendOptions.sendEncodings[0].maxFramerate===15&&p.sendOptions.sendEncodings[0].maxBitrate===2500000}));
 const first=await frame();check('raster has actual dark editor pixels and excludes outside administration',first.dark>1000&&first.magenta===0);
 await page.evaluate(()=>document.getElementById('outside-canary').remove());
 await page.evaluate(()=>load(true));check('poll keeps the unified broadcast label',await page.locator('#broadcastDock [data-screen-lab="ux-a"] > button').innerText()==='시연 송출 멈추기');
 await page.evaluate(()=>window.__unifiedStream=SH[RID].s);
 for(const [width,height,name] of [[1920,1080,'1080'],[3840,2000,'4k']]){
  await page.setViewportSize({width,height});
  check(name+' has no document scroll',await page.evaluate(()=>document.documentElement.scrollHeight<=innerHeight+1&&document.documentElement.scrollWidth<=innerWidth));
  await page.screenshot({path:path.join(art,'demo-'+name+'.png')});
 }
 await page.setViewportSize({width:1920,height:1080});
 await page.locator('#workspaceSize').click();check('large view keeps the actual editable workspace',await editor.isVisible()&&await page.locator('#workspaceSize').getAttribute('aria-pressed')==='true');await page.locator('#workspaceSize').click();
 await page.locator('#workspaceFull').click();await page.waitForFunction(()=>document.fullscreenElement?.id==='classMain');check('full screen uses actual work instead of a second stream',await page.evaluate(()=>SH[RID].s===window.__unifiedStream));await page.evaluate(()=>document.exitFullscreen());
 await page.locator('#workspaceGallery').click();
 check('gallery toggle parks only the actual demo while broadcast continues',await page.locator('#supportStage > #liveTools').isVisible()&&await page.evaluate(()=>document.querySelector('#classMain').inert&&document.querySelector('#classMain').getBoundingClientRect().right<0&&SH[RID].s===window.__unifiedStream));
 const galleryFrame=await frame();check('gallery cannot enter the published source',galleryFrame.magenta===0&&galleryFrame.dark>1000);
 await page.locator('#workspaceGallery').click();check('same toggle returns to unchanged draft',await editor.isVisible()&&(await editor.inputValue()).startsWith('시연 화면 그대로'));
 const at=Date.now();fixture.state.rooms[0].seats[0].hand=at;await page.evaluate(()=>load(true));
 await page.waitForFunction(()=>document.querySelector('#viewRun').dataset.workspace==='support');
 check('new hand automatically opens the correct ID and seat',await page.locator('#workspaceStatus').innerText()==='연습 참여자 가 · 1번 좌석 · 도움 요청');
 check('automatic view neither requests control nor focuses remote input',!fixture.state.calls.some(c=>c.path==='/api/lab/live/request')&&await page.evaluate(()=>!document.querySelector('#supportStage')?.contains(document.activeElement)));
 check('support keeps the exact demo stream running',await page.evaluate(()=>SH[RID].s===window.__unifiedStream&&SH[RID].s.getVideoTracks()[0].readyState==='live'));
 await page.screenshot({path:path.join(art,'auto-help.png')});
 fixture.state.rooms[0].seats[1].hand=at+1;await page.evaluate(()=>load(true));await page.waitForFunction(()=>!document.querySelector('#workspaceQueue').hidden);
 check('second request queues without replacing the current person',(await page.locator('#workspaceStatus').innerText()).includes('1번 좌석')&&(await page.locator('#workspaceQueue').innerText()).includes('1'));
 await page.locator('#workspaceFinish').click();await page.waitForFunction(()=>document.querySelector('#workspaceStatus').textContent.includes('2번 좌석'));
 check('finish advances to the queued person without changing learning progress',!fixture.state.calls.some(c=>c.path.includes('/progress')||c.path.includes('/verify')));
 await page.locator('#workspaceFinish').click();await page.waitForFunction(()=>document.querySelector('#viewRun').dataset.workspace==='home');await page.evaluate(()=>load(true));
 check('same outstanding hands do not reopen on repeated polling',await page.evaluate(()=>document.querySelector('#viewRun').dataset.workspace==='home'));
 check('return preserves editor draft',(await editor.inputValue()).startsWith('시연 화면 그대로'));
 await page.locator('#workspaceGallery').click();await page.locator('#supportStage [data-live-seat="2"]').getByRole('button',{name:'도와주기',exact:true}).click();await page.locator('#workspaceFinish').click();
 await page.waitForFunction(()=>document.querySelector('#viewRun').dataset.workspace==='gallery');check('finishing manual support returns to the previous gallery',await page.locator('#supportStage > #liveTools').isVisible());await page.locator('#workspaceGallery').click();
 const beforeEdit=await frame();await editor.fill('새로운 실제 편집 내용\n두 번째 프레임입니다.');
 await page.waitForTimeout(1500);const changed=await frame();check('actual editor changes reach the captured stream',changed.hash!==beforeEdit.hash&&changed.magenta===0);
 await page.locator('#roomSelect').selectOption('ux-b');await page.waitForFunction(()=>!SH['ux-a']);
 check('room change stops old source and its tracks',await page.evaluate(()=>window.__unifiedStream.getVideoTracks().every(t=>t.readyState==='ended')));
 await page.setViewportSize({width:390,height:844});check('mobile has no horizontal overflow',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:path.join(art,'mobile.png'),fullPage:true});
 check('no script errors',errors.length===0);
 await writeFile(path.join(art,'integration-checks.json'),JSON.stringify({checks,errors,first,galleryFrame,changed},null,2));
 console.log(checks.length+' unified workspace checks passed');
}finally{await browser.close();fixture.server.closeAllConnections();await fixture.close()}
