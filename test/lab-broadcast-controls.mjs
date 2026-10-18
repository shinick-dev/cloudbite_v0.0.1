// Real page and DOM capture, synthetic authorization/RTC only. No real services.
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {operatorFixture} from './fixtures/lab-operator-ui.mjs';
const fixture=await operatorFixture();fixture.state.live=false;fixture.state.requests=[];
const browser=await chromium.launch({channel:'msedge',headless:true});
try{
 const page=await browser.newPage({viewport:{width:1920,height:1080}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(fixture.origin+'/lab?preview=1');await page.evaluate(()=>window.__uxReady);await page.waitForFunction(()=>!LLIVE.enabled());
 const start=page.getByRole('button',{name:'시연 송출 시작',exact:true});assert.equal(await start.count(),1);assert.ok(await start.isVisible());assert.ok(await start.isEnabled());
 console.log('ok valid administrator retains exactly one publish control when preview authentication fails');
 assert.ok((await page.locator('#broadcastDock').innerText()).includes('나만 보는 중'));
 assert.equal(fixture.state.calls.filter(c=>c.path.endsWith('/screen/start')).length,0,'rendering never publishes automatically');
 await start.click();await page.waitForFunction(()=>SH[RID]?.startedAt);
 assert.ok(fixture.state.calls.some(c=>c.path==='/api/lab/screen/start'));assert.equal(fixture.state.calls.some(c=>c.path==='/api/lab/live/screen/start'),false);
 console.log('ok publishing uses the independently authorized administrator route');
 await page.evaluate(()=>load(true));assert.equal(await page.getByRole('button',{name:'시연 송출 멈추기',exact:true}).count(),1);
 await page.getByRole('button',{name:'시연 송출 멈추기',exact:true}).click();await page.waitForFunction(()=>!SH[RID]);assert.ok(await start.isVisible());
 console.log('ok publish state and stop remain visible after polling');
 await page.waitForFunction(()=>!!MON);await page.evaluate(()=>admExpired());
 assert.ok(await start.isVisible());assert.ok(await start.isDisabled());assert.ok((await page.locator('#broadcastDock').innerText()).includes('보안 키'));
 console.log('ok expired authority disables the control and explains recovery');
 assert.deepEqual(errors,[]);
}finally{await browser.close();fixture.server.closeAllConnections();await fixture.close()}
