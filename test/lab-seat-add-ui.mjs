// Synthetic resources/RTC; actual page modules. Aside cannot set target viewports.
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright-core';
import {operatorFixture} from './fixtures/lab-operator-ui.mjs';
const artifact=path.resolve('../.artifacts/classroom-seat-add-20261016');await mkdir(artifact,{recursive:true});
const fixture=await operatorFixture(),browser=await chromium.launch({channel:'msedge',headless:true});
const page=await browser.newPage({viewport:{width:1920,height:980}}),errors=[],checks=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(8000);
const check=(name,ok)=>{assert.ok(ok,name);checks.push(name);console.log('ok '+name)};
try{
 await page.goto(fixture.origin+'/lab?preview=1');await page.evaluate(()=>window.__uxReady);await page.locator('#runGuide h2').waitFor();
 check('only settings remains in the top utility navigation',await page.locator('#labNav button').count()===1&&await page.locator('#navSet').getAttribute('aria-haspopup')==='dialog');
 const guide=await page.locator('#runGuide').boundingBox();
 await page.locator('#navSet').click();await page.locator('#navPrep').click();await page.locator('#l_name').fill('다음 모임 초안');check('new meeting opens over the ongoing lesson',await page.locator('#prepDialog').isVisible()&&await page.locator('#viewRun').evaluate(e=>!e.hidden));await page.locator('#prepClose').click();
 await page.locator('#navSet').click();const settings=await page.locator('#settingsDialog').boundingBox();check('settings uses a small panel',settings.width<=520&&settings.height<=880);await page.screenshot({path:path.join(artifact,'settings.png')});await page.keyboard.press('Escape');
 await page.locator('#navSet').click();await page.locator('#navPrep').click();check('creation draft survives opening settings',await page.locator('#l_name').inputValue()==='다음 모임 초안');await page.locator('#prepClose').click();
 check('utility panels do not move the lesson or add page scrolling',await page.evaluate(()=>scrollY===0&&document.documentElement.scrollHeight<=innerHeight+1)&&Math.abs((await page.locator('#runGuide').boundingBox()).y-guide.y)<2);
 await page.locator('#runAddSeat').click();await page.locator('#seatAddInfo').filter({hasText:'5 / 20'}).waitFor();check('addition displays inherited specs and deadline',/2 vCPU.*4 GiB.*5 GiB.*\$3.*종료/.test(await page.locator('#seatAddInfo').innerText()));
 await page.screenshot({path:path.join(artifact,'add-seat.png')});
 fixture.state.addLost=true;page.once('dialog',d=>d.accept());await page.locator('#seatAddConfirm').click();await page.locator('#seatAddNote').filter({hasText:'합성 응답 유실'}).waitFor();
 check('lost response retains exactly one creation',fixture.state.addPosts===1&&fixture.state.rooms[0].seats.length===6);
 const before=fixture.state.calls.filter(c=>c.path==='/api/lab/seat-add').length;
 await page.reload();await page.evaluate(()=>window.__uxReady);await page.locator('#runAddSeat').click();await page.locator('#seatAddNote').filter({hasText:'6번 좌석을 추가했습니다'}).waitFor();
 check('refresh restores operation and queries instead of creating again',fixture.state.addPosts===1&&fixture.state.calls.filter(c=>c.path==='/api/lab/seat-add').length===before);
 check('operation storage contains no admin, seat invite or provider token',await page.evaluate(()=>{const s=sessionStorage.getItem('labSeatAddOperations');return !!s&&!s.includes(T)&&!s.includes('synthetic-new-seat')&&!s.includes('code')&&JSON.parse(s)[0].requestId.startsWith('lc_')}));
 await page.locator('#seatAddInvite').click();await page.locator('#big').waitFor({state:'visible'});check('invite opens only the new seat and is not covered by dialog',fixture.state.calls.findLast(c=>c.path==='/api/lab/invite').body.n===6&&await page.locator('#seatAddDialog').isHidden());await page.locator('#bigClose').click();
 await page.locator('#runAddSeat').click();await page.locator('#seatAddNext').waitFor({state:'visible'});await page.locator('#seatAddNext').click();await page.locator('#seatAddConfirm').waitFor({state:'visible'});fixture.state.addLost=false;
 let release;fixture.state.addHold=new Promise(r=>release=r);page.once('dialog',d=>d.accept());await page.locator('#seatAddConfirm').click();await page.locator('#seatAddClose').click();release();fixture.state.addHold=null;
 await page.waitForFunction(()=>document.querySelector('#seatAddDialog').open===false);check('late creation response does not reopen a closed panel',await page.locator('#seatAddDialog').isHidden());
 await page.locator('#runAddSeat').click();await page.locator('#seatAddNote').filter({hasText:'7번 좌석을 추가했습니다'}).waitFor();check('closed operation can be recovered by its original ID',fixture.state.addPosts===2);
 await page.locator('#seatAddClose').click();await page.setViewportSize({width:390,height:844});await page.locator('#navSet').click();check('mobile settings fits width',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:path.join(artifact,'mobile-settings.png'),fullPage:true});await page.locator('#settingsClose').click();
 fixture.state.rooms=[];await page.reload();await page.evaluate(()=>window.__uxReady);check('empty meeting list does not auto-open a utility panel',await page.locator('#prepDialog').isHidden()&&await page.locator('#navSet').isVisible());
 check('no script errors',errors.length===0);await writeFile(path.join(artifact,'ui-checks.json'),JSON.stringify({checks,errors},null,2));console.log(checks.length+' UI checks passed');
}finally{await browser.close();fixture.server.closeAllConnections();await fixture.close()}
