// Synthetic screen/WebRTC; real layout and media track. Isolated synthetic capture and fixed viewports; integrated UI also checked in Aside.
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright-core';
import {operatorFixture} from './fixtures/lab-operator-ui.mjs';
const fixture=await operatorFixture(),browser=await chromium.launch({channel:'msedge',headless:true});fixture.state.requests=[];
const art=path.resolve('../.artifacts/classroom-broadcast-preview-20261016');await mkdir(art,{recursive:true});
const page=await browser.newPage({viewport:{width:3840,height:2000}}),errors=[],checks=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(10000);
const check=(name,ok)=>{assert.ok(ok,name);checks.push(name);console.log('ok '+name)};
try{
 await page.goto(fixture.origin+'/lab?preview=1');await page.evaluate(()=>window.__uxReady);await page.locator('[data-live-seat="1"]').first().waitFor();
 check('only settings remains at top; creation is inside settings',await page.locator('#labNav button').count()===1&&await page.locator('#navRun').count()===0&&await page.locator('#settingsDialog #navPrep').count()===1);
 const draft=page.locator('#classMain .demo-file-editor textarea');await draft.evaluate(e=>e.disabled=false);await draft.fill('시연 초안 유지');
 await page.locator('#broadcastDock .broadcast-other summary').click();await page.locator('#broadcastDock').getByRole('button',{name:'다른 탭·창 공유',exact:true}).click();await page.waitForFunction(()=>Object.values(SH).some(s=>s.startedAt));
 const preview=page.locator('#broadcastPreviewStage');await page.waitForFunction(()=>document.querySelector('#broadcastPreviewStage').dataset.sent==='1920x1080');
 check('capture requests Full HD and retains bandwidth/frame cap',await page.evaluate(()=>{const c=window.__fixtureDisplayConstraints,p=window.__fixturePeers.find(p=>p.sentTrack);return c.video.width.ideal===1920&&c.video.height.ideal===1080&&c.video.width.max===1920&&c.video.height.max===1080&&c.selfBrowserSurface==='exclude'&&p.sendOptions.sendEncodings[0].maxBitrate===2500000&&p.sendOptions.sendEncodings[0].maxFramerate===15}));
 check('shows measured capture and outbound dimensions',await preview.getAttribute('data-capture')==='1920x1080'&&(await page.locator('#broadcastPreviewStatus').innerText()).includes('송출 1920 × 1080'));
 check('large preview uses the central 4K workspace',await preview.isVisible()&&await preview.locator('video').evaluate(e=>e.getBoundingClientRect().height>=1000)&&await page.locator('#classMain').isHidden());
 check('4K preview leaves guide and participants reachable without page scrolling',await page.evaluate(()=>document.documentElement.scrollHeight<=innerHeight+1&&scrollY===0)&&await page.locator('#runGuide').isVisible()&&await page.locator('#liveTools').isVisible());
 await page.screenshot({path:path.join(art,'4k-large.png')});const peers=await page.evaluate(()=>window.__fixturePeers.length);
 await page.locator('#broadcastPreviewSize').click();
 check('small preview returns the draft without a new connection',await preview.evaluate(e=>e.getBoundingClientRect().width<=340)&&await draft.isVisible()&&await draft.inputValue()==='시연 초안 유지'&&await page.evaluate(()=>window.__fixturePeers.length)===peers);
 check('preview reuses the exact captured stream',await page.evaluate(()=>document.querySelector('#broadcastPreviewVideo').srcObject===SH[RID].s&&SH[RID].s.getVideoTracks()[0].readyState==='live'));
 await page.setViewportSize({width:1920,height:980});await page.locator('#broadcastPreviewSize').click();check('Full HD desktop large preview fits the lesson',await page.evaluate(()=>document.documentElement.scrollHeight<=innerHeight+1)&&await preview.locator('video').evaluate(e=>e.getBoundingClientRect().height>=300));await page.screenshot({path:path.join(art,'1080-large.png')});
 await page.locator('#broadcastPreviewFull').click();await page.waitForFunction(()=>document.fullscreenElement?.id==='broadcastPreviewStage');check('native full screen opens the same preview stream',await page.evaluate(()=>document.fullscreenElement===document.querySelector('#broadcastPreviewStage')&&document.querySelector('#broadcastPreviewVideo').srcObject===SH[RID].s));await page.locator('#broadcastPreviewFull').click();await page.waitForFunction(()=>!document.fullscreenElement);
 await page.locator('#handList').getByRole('button',{name:/도와주기/}).first().click();check('support takes priority while broadcast continues',await preview.isHidden()&&await page.locator('#supportStage').isVisible()&&await page.evaluate(()=>Object.values(SH).some(s=>s.s.getVideoTracks()[0].readyState==='live')));
 await page.locator('#broadcastPreviewShow').click();check('own broadcast button returns to large preview',await preview.isVisible()&&await preview.getAttribute('data-size')==='large');
 await page.locator('#navSet').click();await page.locator('#navPrep').click();await page.locator('#l_name').fill('설정에서 연 새 모임');await page.locator('#prepClose').click();check('new meeting creation remains available without a top tab',await preview.isVisible()&&await page.locator('#l_name').inputValue()==='설정에서 연 새 모임');
 await page.getByRole('button',{name:/시연 송출 멈추기/}).first().click();check('stopping clears local preview and captured track',await preview.isHidden()&&await page.locator('#broadcastPreviewVideo').evaluate(e=>e.srcObject===null)&&await page.evaluate(()=>window.__fixtureScreens[0].getVideoTracks()[0].readyState==='ended'));
 await page.setViewportSize({width:390,height:844});await page.locator('#broadcastDock .broadcast-other summary').click();await page.locator('#broadcastDock').getByRole('button',{name:'다른 탭·창 공유',exact:true}).click();await preview.waitFor({state:'visible'});check('mobile preview has no horizontal overflow',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:path.join(art,'mobile.png'),fullPage:true});
 await page.locator('#navSet').click();await page.locator('#logout').click();check('logout clears preview without stopping only its display',await preview.isHidden()&&await page.locator('#broadcastPreviewVideo').evaluate(e=>e.srcObject===null)&&await page.evaluate(()=>window.__fixtureScreens.every(s=>s.getVideoTracks()[0].readyState==='ended')));
 check('no script errors',errors.length===0);await writeFile(path.join(art,'checks.json'),JSON.stringify({checks,errors},null,2));console.log(checks.length+' broadcast preview checks passed');
}finally{await browser.close();fixture.server.closeAllConnections();await fixture.close()}
