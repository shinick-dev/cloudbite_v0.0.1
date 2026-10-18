// Actual page; isolated Edge supplies viewports and synthetic WebAuthn unavailable in Aside.
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright-core';
import {operatorFixture} from './fixtures/lab-operator-ui.mjs';
const fixture=await operatorFixture(),browser=await chromium.launch({channel:'msedge',headless:true});
const art=path.resolve('../.artifacts/classroom-request-previews-20261016');await mkdir(art,{recursive:true});
const page=await browser.newPage({viewport:{width:1920,height:980}}),checks=[],errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(8000);
const check=(name,ok)=>{assert.ok(ok,name);checks.push(name);console.log('ok '+name)},join='00000000-0000-4000-8000-000000000002',practice='00000000-0000-4000-8000-000000000001';
const row=id=>page.locator('#requestPreviews [data-request="'+id+'"]');
try{
 await page.goto(fixture.origin+'/lab?preview=1');await page.evaluate(()=>window.__uxReady);await row(join).waitFor();
 check('no separate request navigation; pending requests sit within participant previews',await page.locator('#navReq').count()===0&&await page.locator('#liveTools #requestPreviews').count()===1);
 check('gray preview and direct approval are visible',await row(join).locator('.request-preview-screen').isVisible()&&await row(join).getByRole('button',{name:'승인하고 열기',exact:true}).isVisible());
 check('slow animation only on pending preview background',await row(join).locator('.request-preview-screen').evaluate(e=>getComputedStyle(e).animationName==='request-waiting'&&getComputedStyle(e).animationDuration==='2.8s'));
 check('requests preserve page viewport and current guide',await page.evaluate(()=>document.documentElement.scrollHeight<=innerHeight+1&&scrollY===0)&&await page.locator('#runGuide').isVisible());
 await page.screenshot({path:path.join(art,'desktop.png')});
 await page.emulateMedia({reducedMotion:'reduce'});check('reduced motion disables pulse',await row(join).locator('.request-preview-screen').evaluate(e=>getComputedStyle(e).animationName==='none'));await page.emulateMedia({reducedMotion:'no-preference'});
 await page.locator('#roomSelect').selectOption('ux-b');check('join defaults follow selected room and expose exact conditions',(await row(join).locator('.request-preview-brief').innerText()).includes('두 번째 모임'));
 const pr=row(practice);await pr.locator('summary').click();await pr.getByRole('combobox',{name:'복습할 참여자 실습실 사양',exact:true}).selectOption('custom');await pr.getByRole('spinbutton',{name:'복습할 참여자 CPU',exact:true}).fill('3');
 await page.evaluate(()=>document.querySelector('#requestPreviews .request-preview-head button').click());await page.waitForFunction(()=>!document.querySelector('#requestPreviews .request-preview-head button').disabled);
 check('poll keeps open resource controls and custom draft',await pr.locator('details').evaluate(e=>e.open)&&await pr.getByRole('spinbutton',{name:'복습할 참여자 CPU',exact:true}).inputValue()==='3');
 fixture.state.openApproveLost=true;await row(join).getByRole('button',{name:'승인하고 열기',exact:true}).click();await row(join).getByRole('button',{name:'같은 요청 결과 확인',exact:true}).waitFor();
 const approved=fixture.state.calls.filter(c=>c.path.endsWith('/manager/approve'));
 check('approval uses existing signed request and selected room',approved.length===1&&approved[0].body.id===join&&approved[0].body.choice.labId==='ux-b'&&!!approved[0].body.assertion);
 check('unknown approval offers only same-request recovery',await row(join).getByRole('button',{name:'승인하고 열기',exact:true}).isHidden());
 await page.reload();await page.evaluate(()=>window.__uxReady);await row(join).getByRole('button',{name:'같은 요청 결과 확인',exact:true}).waitFor();check('refresh does not repeat approval',fixture.state.calls.filter(c=>c.path.endsWith('/manager/approve')).length===1);
 fixture.state.openResumeReady=true;await row(join).getByRole('button',{name:'같은 요청 결과 확인',exact:true}).click();await row(join).waitFor({state:'detached'});check('ready recovery removes waiting tile without new approval',fixture.state.calls.filter(c=>c.path.endsWith('/manager/approve')).length===1&&fixture.state.calls.findLast(c=>c.path.endsWith('/manager/resume')).body.id===join);
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(art,'mobile.png'),fullPage:true});check('mobile has no horizontal overflow',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 fixture.state.openListStatus=403;await page.locator('#requestPreviews .request-preview-head button').click();await page.locator('#requestPreviews h3').first().filter({hasText:'본인 로그인 필요'}).waitFor();check('owner login loss clears private requester details',await page.locator('#requestPreviews [data-request]').count()===0&&await page.locator('#requestPreviews a').getAttribute('target')==='_blank');
 fixture.state.openListStatus=null;await page.locator('#requestPreviews .request-preview-head button').click();await row(practice).waitFor();let release;fixture.state.openApproveHold=new Promise(r=>release=r);await row(practice).getByRole('button',{name:'승인하고 열기',exact:true}).click();await page.waitForFunction(()=>JSON.parse(sessionStorage.getItem('labRequestFollowup')||'[]').length===1);
 await page.locator('#navSet').click();await page.locator('#logout').click();release();fixture.state.openApproveHold=null;await page.waitForTimeout(120);
 check('logout hides request names and delayed result cannot restore them',await page.locator('#requestPreviews [data-request]').count()===0&&await page.locator('#panel').isHidden());
 check('followup storage contains only request IDs',await page.evaluate(()=>JSON.parse(sessionStorage.getItem('labRequestFollowup')||'[]').every(x=>/^[a-f0-9-]{36}$/.test(x))));
 check('no page exceptions',errors.length===0);await writeFile(path.join(art,'checks.json'),JSON.stringify({checks,errors},null,2));console.log(checks.length+' request preview checks passed');
}finally{await browser.close();fixture.server.closeAllConnections();await fixture.close()}
