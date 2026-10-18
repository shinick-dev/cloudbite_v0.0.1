// Aside has no request/viewport mocking; fixture-only Edge tests cover UI races.
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { LAB_CONTROL_JS } from '../src/labcontrol.ts';
import { LAB_TERMINAL_JS } from '../src/labterminal.ts';
const browser=await chromium.launch({channel:'msedge',headless:true});
let passed=0;
const fixture = `<!doctype html><html lang="ko"><meta charset="utf-8"><body><main></main><script>
${LAB_CONTROL_JS}
${LAB_TERMINAL_JS}
const paused=new URL(location.href).searchParams.has('paused');
window.server={mode:paused?'paused':'running',revision:paused?1:0,updatedAt:Date.now()};
window.calls=[];window.holds={};window.waiters={};window.receipts={};
if(new URL(location.href).searchParams.has('holdStatus'))holds['/api/lab/control/status']=true;
const sid='20000000-0000-4000-8000-000000000001';
const D={btn:(text,cls,f)=>{const b=document.createElement('button');b.textContent=text;b.onclick=f;return b},copy:async()=>{},cleanErr:x=>String(x),
 call:async(path,body)=>{calls.push({path,body:structuredClone(body)});
  if(holds[path])return new Promise((resolve,reject)=>{(waiters[path]??=[]).push({resolve,reject})});
  if(path==='/api/lab/control/status')return structuredClone(server);
  if(path==='/api/lab/control/pause'||path==='/api/lab/control/resume'){
   if(receipts[body.requestId])return structuredClone(receipts[body.requestId]);
   if(window.conflict&&path.endsWith('/resume')){server={mode:'paused',revision:3,updatedAt:Date.now()};throw Object.assign(Error('revision conflict'),{status:409})}
   server={mode:path.endsWith('/pause')?'paused':'running',revision:(window.pauseRevision&&path.endsWith('/pause'))?window.pauseRevision:server.revision+1,updatedAt:Date.now()};receipts[body.requestId]=structuredClone(server);
   if(window.losePause&&path.endsWith('/pause')){window.losePause=false;throw Error('response lost')}
   return structuredClone(server);
  }
  if(path==='/api/lab/terminal/status')return{active:true,sessionId:sid,seats:[{n:1,status:'ready'},{n:2,status:'ready'}]};
  if(path==='/api/lab/terminal/send'){if(window.rejectEpoch){server={mode:'running',revision:2,updatedAt:Date.now()};throw Object.assign(Error('control changed'),{status:409,code:'control_revision_changed'})}return{requestId:body.requestId,results:[{n:1,status:'sent'},{n:2,status:'sent'}]}};
  if(path==='/api/lab/terminal/stop')return{ok:true};
  throw Error('unexpected fixture call '+path);
 }};
window.ctrl=createLabControl(D);window.term=createLabTerminal({...D,control:ctrl});
const lab={id:'lab',seats:[{n:1,who:'참여자1'},{n:2,who:'참여자2'}]};document.querySelector('main').append(ctrl.box(lab),term.box(lab));
</script></body></html>`;
async function pageFor(query=''){
 const context=await browser.newContext(),page=await context.newPage(),errors=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
 await context.route('**/*',r=>{assert.equal(new URL(r.request().url()).origin,'http://localhost:8976');return r.fulfill({contentType:'text/html',body:fixture})});
 await page.goto('http://localhost:8976/'+query);return{page,context,errors};
}
async function active(page){await page.locator('summary').click();await page.waitForFunction(()=>document.querySelector('[data-lab-terminal]').textContent.includes('상태를 확인했습니다.'));}
async function settled(page,mode){await page.waitForFunction(mode=>document.querySelector('[data-lab-control] strong').textContent===mode,mode)}
async function test(name,fn,query=''){const w=await pageFor(query);try{await fn(w.page);assert.deepEqual(w.errors,[]);passed++;console.log('ok',name)}finally{await w.context.close()}}
try{
 await test('pause control stays visible with terminal details collapsed',async p=>{
  await settled(p,'명령 전달 가능');assert.equal(await p.locator('details').evaluate(n=>n.open),false);
  assert.equal(await p.getByRole('button',{name:'명령 전달 일시정지',exact:true}).isVisible(),true);
  await p.getByRole('button',{name:'명령 전달 일시정지',exact:true}).click();await settled(p,'명령 전달 일시정지');
  await active(p);await p.locator('textarea').fill('pwd');assert.equal(await p.getByRole('button',{name:'명령 보내기',exact:true}).isDisabled(),true);
 });
 await test('pause works during send; its late response preserves the original retry ID',async p=>{
  await settled(p,'명령 전달 가능');await active(p);await p.evaluate(()=>holds['/api/lab/terminal/send']=true);
  await p.locator('textarea').fill('pwd');await p.getByRole('button',{name:'명령 보내기',exact:true}).click();
  await p.getByRole('button',{name:'명령 전달 일시정지',exact:true}).click();await settled(p,'명령 전달 일시정지');
  await p.evaluate(()=>{holds['/api/lab/terminal/send']=false;waiters['/api/lab/terminal/send'][0].resolve({results:[{n:1,status:'sent'}]})});
  await p.getByRole('button',{name:'같은 명령 다시 확인',exact:true}).click();
  const ids=await p.evaluate(()=>calls.filter(c=>c.path==='/api/lab/terminal/send').map(c=>c.body.requestId));assert.equal(ids.length,2);assert.equal(ids[0],ids[1]);
  assert.equal(await p.getByRole('button',{name:'명령 보내기',exact:true}).isDisabled(),true);
 });
 await test('old running status response cannot undo a newer pause',async p=>{
  await p.waitForFunction(()=>waiters['/api/lab/control/status']?.length===1);
  await p.getByRole('button',{name:'명령 전달 일시정지',exact:true}).click();await settled(p,'명령 전달 일시정지');
  await p.evaluate(()=>{holds['/api/lab/control/status']=false;waiters['/api/lab/control/status'][0].resolve({mode:'running',revision:0,updatedAt:Date.now()})});
  await p.waitForFunction(()=>!document.querySelector('[data-lab-control] button:last-child').disabled);
  assert.equal(await p.locator('[data-lab-control] strong').textContent(),'명령 전달 일시정지');assert.equal(await p.evaluate(()=>ctrl.allowsNew('lab')),false);
 },'?holdStatus');
 await test('lost pause reply retains action ID; status alone does not drop it',async p=>{
  await settled(p,'명령 전달 가능');await p.evaluate(()=>window.losePause=true);
  await p.getByRole('button',{name:'명령 전달 일시정지',exact:true}).click();
  await p.waitForFunction(()=>document.querySelector('[data-lab-control]').textContent.includes('결과 확인 필요'));
  assert.equal(await p.evaluate(()=>ctrl.allowsNew('lab')),false);assert.equal(await p.locator('[data-lab-control] strong').textContent(),'명령 전달 상태 확인 필요');await p.getByRole('button',{name:'전달 상태 확인',exact:true}).click();await settled(p,'명령 전달 일시정지');
  await p.getByRole('button',{name:'같은 일시정지 요청 다시 확인',exact:true}).click();
  const ids=await p.evaluate(()=>calls.filter(c=>c.path.endsWith('/pause')).map(c=>c.body.requestId));assert.equal(ids.length,2);assert.equal(ids[0],ids[1]);
  assert.equal(await p.getByRole('button',{name:'명령 전달 재개',exact:true}).isEnabled(),true);
 });
 await test('pause remains available during resume and ignores its late response',async p=>{
  await settled(p,'명령 전달 일시정지');await p.evaluate(()=>{holds['/api/lab/control/resume']=true;window.pauseRevision=3});
  await p.getByRole('button',{name:'명령 전달 재개',exact:true}).click();
  await p.getByRole('button',{name:'명령 전달 일시정지',exact:true}).click();await settled(p,'명령 전달 일시정지');
  await p.evaluate(()=>waiters['/api/lab/control/resume'][0].resolve({mode:'running',revision:2,updatedAt:Date.now()}));
  await p.waitForFunction(()=>!document.querySelector('[data-lab-control] button:nth-child(2)').disabled);
  assert.equal(await p.evaluate(()=>ctrl.allowsNew('lab')),false);assert.equal(await p.locator('[data-lab-control] strong').textContent(),'명령 전달 일시정지');
 },'?paused');
 await test('revision conflict requires current state before another explicit resume',async p=>{
  await settled(p,'명령 전달 일시정지');await p.evaluate(()=>window.conflict=true);
  await p.getByRole('button',{name:'명령 전달 재개',exact:true}).click();await p.waitForFunction(()=>document.querySelector('[data-lab-control]').textContent.includes('결과 확인 필요'));
  assert.equal(await p.evaluate(()=>ctrl.allowsNew('lab')),false);await p.getByRole('button',{name:'전달 상태 확인',exact:true}).click();
  await p.waitForFunction(()=>document.querySelector('[data-lab-control] button:nth-child(2)').disabled===false);
  await p.evaluate(()=>window.conflict=false);await p.getByRole('button',{name:'명령 전달 재개',exact:true}).click();await settled(p,'명령 전달 가능');
  const expected=await p.evaluate(()=>calls.filter(c=>c.path.endsWith('/resume')).map(c=>c.body.expectedRevision));assert.deepEqual(expected,[1,3]);
 },'?paused');
 await test('a control timeout permits same-ID retry and ignores the original late reply',async p=>{
  await settled(p,'명령 전달 가능');await p.evaluate(()=>{D.timeoutMs=25;holds['/api/lab/control/pause']=true});
  await p.getByRole('button',{name:'명령 전달 일시정지',exact:true}).click();await p.waitForFunction(()=>document.querySelector('[data-lab-control]').textContent.includes('결과 확인 필요'));
  assert.equal(await p.evaluate(()=>ctrl.allowsNew('lab')),false);assert.equal(await p.getByRole('button',{name:'같은 일시정지 요청 다시 확인',exact:true}).isEnabled(),true);
  await p.evaluate(()=>{holds['/api/lab/control/pause']=false;waiters['/api/lab/control/pause'][0].resolve({mode:'paused',revision:1,updatedAt:Date.now()})});
  assert.equal(await p.evaluate(()=>ctrl.allowsNew('lab')),false);await p.getByRole('button',{name:'같은 일시정지 요청 다시 확인',exact:true}).click();await settled(p,'명령 전달 일시정지');
  const ids=await p.evaluate(()=>calls.filter(c=>c.path.endsWith('/pause')).map(c=>c.body.requestId));assert.equal(ids[0],ids[1]);
 });
 await test('rejected stale command refreshes control and requires a new explicit send',async p=>{
  await settled(p,'명령 전달 가능');await active(p);await p.evaluate(()=>window.rejectEpoch=true);await p.locator('textarea').fill('pwd');
  await p.getByRole('button',{name:'명령 보내기',exact:true}).click();await p.waitForFunction(()=>ctrl.revision('lab')===2);
  assert.equal(await p.evaluate(()=>calls.filter(c=>c.path.endsWith('/send')).length),1,'no automatic retransmission');
  await p.evaluate(()=>window.rejectEpoch=false);await p.getByRole('button',{name:'명령 보내기',exact:true}).click();
  const sent=await p.evaluate(()=>calls.filter(c=>c.path.endsWith('/send')).map(c=>c.body));assert.deepEqual(sent.map(x=>x.expectedControlRevision),[0,2]);assert.notEqual(sent[0].requestId,sent[1].requestId);
 });
 console.log(passed+' classroom control UI scenarios passed');
}finally{await browser.close()}
