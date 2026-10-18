// Aside가 mock route/viewport 제어를 지원하지 않아 기존 Edge fixture 방식으로 시각 확인.
// 실제 API 요청/서버/샌드박스 없이 현재 배포 HTML과 학생 막대 JS를 그대로 그린다.
import {chromium} from 'playwright-core';
import {mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
import {labPage,WEBAUTHN_JS} from '../src/pages.ts';
import {LAB_BAR_JS} from '../src/labbar.ts';
const artifact=resolve('.wrangler/terminal-review');mkdirSync(artifact,{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:true});
try{
for(const width of [1280,390]){
 let control={mode:'running',revision:0,updatedAt:Date.now()};
 const context=await browser.newContext({viewport:{width,height:width===390?2600:1000}}),page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await context.route('**/*',async r=>{const u=new URL(r.request().url()),p=u.pathname;assert.equal(u.origin,'http://localhost:8799','mock-only network');const j=(x,status=200)=>r.fulfill({status,contentType:'application/json',body:JSON.stringify(x)});
 if(p==='/lab')return r.fulfill({contentType:'text/html',body:labPage()});if(p==='/webauthn.js')return r.fulfill({contentType:'text/javascript',body:WEBAUTHN_JS});
 if(p==='/api/lab/teacher/status')return j({error:'fixture'},401);if(p==='/api/lab/teacher/session')return j({error:'fixture'},503);
 if(p==='/api/lab/control/status')return j(control);if(p==='/api/lab/control/pause'){control={mode:'paused',revision:control.revision+1,updatedAt:Date.now()};return j(control)}
 if(p==='/api/lab/terminal/status')return j({active:false});if(p==='/api/lab/snips')return j({v:1,items:[]});if(p==='/api/lab/screen/status')return j({screens:{}});
 if(p==='/api/lab/list')return j({now:Date.now(),labs:[{id:'preview',name:'야간반 2주차 · 수업 터미널',createdAt:Date.now(),expiresAt:Date.now()+3600000,budget:1,cpu:1,memory:2,disk:5,model:'실습 모델',share:[],clip:{in:true,out:true},seats:[{n:1,who:'나무',state:'started'},{n:2,who:'하늘',state:'started'},{n:3,who:'바다',state:'started'}]}]});return j({},404);});
 await page.goto('http://localhost:8799/lab');await page.evaluate(async()=>{T='fixture-local-only';TE=Date.now()+600000;$('login').hidden=true;$('panel').hidden=false;await load();});
 const panel=page.locator('[data-lab-terminal]');await panel.locator('summary').click();await page.waitForFunction(()=>document.querySelector('[data-lab-terminal]').textContent.includes('상태를 확인했습니다'));
 await panel.locator('input[type=checkbox]').first().check();await panel.locator('textarea').fill('pwd');
 await panel.screenshot({path:resolve(artifact,`terminal-panel-${width}.png`)});
 const controls=page.locator('[data-lab-control]');await page.waitForFunction(()=>document.querySelector('[data-lab-control] strong').textContent==='명령 전달 가능');
 await controls.screenshot({path:resolve(artifact,`control-running-${width}.png`)});
 await controls.getByRole('button',{name:'명령 전달 일시정지',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[data-lab-control] strong').textContent==='명령 전달 일시정지');
 await controls.screenshot({path:resolve(artifact,`control-paused-${width}.png`)});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'no horizontal overflow');assert.deepEqual(errors,[]);await context.close();
}
const context=await browser.newContext({viewport:{width:1280,height:850}}),page=await context.newPage();
await context.route('**/*',async r=>{const p=new URL(r.request().url()).pathname;if(p==='/student')return r.fulfill({contentType:'text/html',body:'<!doctype html><html lang="ko"><title>학생 터미널 안내 검증</title><body style="background:#1e1e1e;color:#ddd;font:16px system-ui;padding:30px"><h2>참가자 실습실</h2><p>이 배경은 시각 확인용이며 실제 code-server는 실행하지 않습니다.</p></body></html>'});if(p==='/__lab/me')return r.fulfill({contentType:'application/json',body:JSON.stringify({name:'야간반 2주차',seat:1,who:'나무',expiresAt:Date.now()+3600000,usage:0,clip:{in:true,out:true},lesson:{active:true,selected:true,ready:true}})});return r.fulfill({status:404,body:''});});
await page.goto('http://localhost:8799/student');await page.addScriptTag({content:LAB_BAR_JS});await page.getByRole('button',{name:'수업 터미널',exact:true}).click();await page.getByRole('dialog').screenshot({path:resolve(artifact,'student-terminal-dialog.png')});await context.close();
console.log('terminal visual artifacts:',artifact);
}finally{await browser.close();}
