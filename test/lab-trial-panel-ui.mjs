// Real trial/preview factories in Edge, with every network operation replaced by a fixture.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { LAB_TRIAL_JS } from '../src/labtrial.ts';
import { LAB_TERMINAL_JS } from '../src/labterminal.ts';
import { LAB_CONTROL_JS } from '../src/labcontrol.ts';
const browser=await chromium.launch({channel:'msedge',headless:true});
const fixture=`<!doctype html><html lang="ko"><meta charset="utf-8"><style>
*{box-sizing:border-box}body{font:15px/1.6 system-ui;margin:0;padding:20px;color:#162124;background:#f7f8f5;--line:#ccd4ce;--bg:#fff;--fg:#162124;--code:#edf0eb}main{max-width:900px;margin:auto}button,input,select,textarea{font:inherit;max-width:100%}button{padding:8px 12px;cursor:pointer}p,summary,label{overflow-wrap:anywhere}.row{display:flex;flex-wrap:wrap;gap:8px}.bad{color:#a11}.mut{color:#53615a}pre{white-space:pre-wrap;overflow-wrap:anywhere}
</style><body><main></main><script>
${LAB_CONTROL_JS}
${LAB_TRIAL_JS}
${LAB_TERMINAL_JS}
window.calls=[];window.server={mode:'running',revision:0,updatedAt:Date.now()};window.binding=null;window.runs={};window.receipts={};window.holds={};window.waiters={};
const sid='50000000-0000-4000-8000-000000000001';
const btn=(text,cls,fn)=>{const b=document.createElement('button');b.textContent=text;b.className=cls;b.onclick=fn;return b;};
const call=async(path,body)=>{calls.push({path,body:structuredClone(body)});
 if(holds[path])return new Promise((resolve,reject)=>(waiters[path]??=[]).push({resolve,reject,body}));
 if(path==='/api/lab/control/status')return structuredClone(server);
 if(path==='/api/lab/control/pause'||path==='/api/lab/control/resume'){server={mode:path.endsWith('/pause')?'paused':'running',revision:server.revision+1,updatedAt:Date.now()};return structuredClone(server);}
 if(path==='/api/lab/terminal/status')return{active:true,sessionId:sid,seats:[{n:1,status:'ready'},{n:3,status:'ready'}]};
 if(path==='/api/lab/terminal/send')return{results:[{n:1,status:'sent'},{n:3,status:'sent'}]};
 if(path==='/api/lab/trial/status')return{binding:structuredClone(binding),candidates:[{id:'trial',name:'시험 <img src=x onerror=alert(1)>'}]};
 if(path==='/api/lab/trial/bind'){binding={trialId:body.trialId,sessionId:sid,closed:false};if(window.loseBind){window.loseBind=false;throw Error('reply lost');}return structuredClone(binding);}
 if(path==='/api/lab/trial/run'){runs[body.requestId]={command:body.command,delivery:'sent'};if(window.loseRun){window.loseRun=false;throw Error('reply lost');}return{runId:body.requestId,delivery:window.runUnknown?'unknown':'sent'};}
 if(path==='/api/lab/trial/output')return{output:'OUTPUT <img src=x onerror=alert(1)>',at:Date.now()};
 if(path==='/api/lab/preview'){
  if(!body.trialRunId&&body.ackWithoutTrial!==true)throw Object.assign(Error('explicit waiver required'),{status:400});
  if(body.trialRunId&&runs[body.trialRunId]?.command!==body.command)throw Object.assign(Error('trial mismatch'),{status:409});
  receipts[body.requestId]??={previewId:body.requestId,targets:[1,3],expiresAt:Date.now()+300000,tested:!!body.trialRunId};
  if(window.losePreview){window.losePreview=false;throw Error('reply lost');}return structuredClone(receipts[body.requestId]);
 }
 throw Error('unexpected fixture call '+path);
};
const D={btn,call,cleanErr:String,copy:async()=>{}};window.ctrl=createLabControl(D);window.trial=createLabTrial(D);window.term=createLabTerminal({...D,control:ctrl,trial});
window.lab={id:'lab',name:'야간반',seats:[{n:1,who:'참여자1'},{n:3,who:'참여자3'}]};
document.querySelector('main').append(ctrl.box(lab),trial.box(lab),term.box(lab));
</script></body></html>`;
let passed=0;
async function test(name,fn,width=1280){const context=await browser.newContext({viewport:{width,height:1000}}),page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
 try{await context.route('**/*',r=>{assert.equal(new URL(r.request().url()).origin,'http://localhost:8979');return r.fulfill({contentType:'text/html',body:fixture});});await page.goto('http://localhost:8979/');await page.waitForFunction(()=>ctrl.allowsNew('lab'));await fn(page);assert.deepEqual(errors,[]);passed++;console.log('ok',name);}finally{await context.close();}}
const terminal=p=>p.locator('[data-lab-terminal]');
const openTerminal=async p=>{await terminal(p).locator('summary').click();await p.waitForFunction(()=>document.querySelector('[data-lab-terminal]').textContent.includes('상태를 확인했습니다.'));};
const calls=(p,path)=>p.evaluate(path=>calls.filter(c=>c.path===path),path);
const trialPanel=p=>p.locator('[data-lab-trial]');
async function bind(p){await trialPanel(p).locator('summary').click();await p.getByRole('button',{name:'이 방으로 시험 연결',exact:true}).click();await p.getByRole('button',{name:'시험 실습실로 연결',exact:true}).click();await p.waitForFunction(()=>!!window.binding);await p.getByRole('button',{name:'시험 명령 보내기',exact:true}).waitFor();}
async function newPreview(p,command='pwd'){await openTerminal(p);await terminal(p).locator('textarea').fill(command);await terminal(p).getByRole('button',{name:'명령 보내기',exact:true}).click();await p.locator('[data-lab-preview]').waitFor();}
const prepare=p=>p.getByRole('button',{name:'미리보기 준비',exact:true}).click();
const final=p=>p.getByRole('button',{name:'이 내용과 대상에 명령 보내기',exact:true});
try{
 await test('collapsed trial panel makes no provider calls and exposes no active HTML',async p=>{
  assert.equal((await calls(p,'/api/lab/trial/status')).length,0);assert.equal(await p.locator('img').count(),0);
 });
 await test('explicit waiver and exact approved targets precede the separate final send',async p=>{
  const command="echo '<img src=x onerror=alert(1)>'";await newPreview(p,command);assert.equal(await p.getByRole('button',{name:'미리보기 준비',exact:true}).isDisabled(),true);assert.equal((await calls(p,'/api/lab/terminal/send')).length,0);
  await p.getByLabel('시험 실행 없이 내용과 대상을 확인했습니다',{exact:true}).check();await prepare(p);await final(p).waitFor();
  assert.equal(await p.locator('[data-lab-preview] pre').textContent(),command);assert.match(await p.locator('[data-lab-preview]').textContent(),/승인된 대상: 1번, 3번/);assert.equal(await p.locator('img').count(),0);assert.equal((await calls(p,'/api/lab/terminal/send')).length,0);
  await final(p).click();await p.waitForFunction(()=>calls.some(c=>c.path==='/api/lab/terminal/send'));const[preview]=await calls(p,'/api/lab/preview'),[send]=await calls(p,'/api/lab/terminal/send');assert.equal(preview.body.ackWithoutTrial,true);assert.equal(send.body.previewId,preview.body.requestId);assert.equal(send.body.command,command);
 });
 await test('preview cancel and pause remain available while prepare is awaiting a response',async p=>{
  await p.evaluate(()=>holds['/api/lab/preview']=true);await newPreview(p);await p.getByLabel('시험 실행 없이 내용과 대상을 확인했습니다',{exact:true}).check();await prepare(p);
  await p.waitForFunction(()=>waiters['/api/lab/preview']?.length===1);await p.getByRole('button',{name:'명령 전달 일시정지',exact:true}).click();await p.getByRole('button',{name:'취소',exact:true}).click();
  await p.evaluate(()=>{holds['/api/lab/preview']=false;const w=waiters['/api/lab/preview'][0];w.resolve({previewId:w.body.requestId,targets:[1,3],expiresAt:Date.now()+300000,tested:false});});
  assert.equal((await calls(p,'/api/lab/terminal/send')).length,0);assert.equal(await p.locator('[data-lab-preview]').count(),0);assert.equal(await p.evaluate(()=>ctrl.allowsNew('lab')),false);
 });
 await test('lost preview response keeps the same ID and locks its chosen trial mode',async p=>{
  await p.evaluate(()=>window.losePreview=true);await newPreview(p);const ack=p.getByLabel('시험 실행 없이 내용과 대상을 확인했습니다',{exact:true});await ack.check();await prepare(p);await p.getByRole('button',{name:'같은 미리보기 요청 다시 확인',exact:true}).click();await final(p).waitFor();
  const r=await calls(p,'/api/lab/preview');assert.equal(r.length,2);assert.deepEqual(r[0].body,r[1].body);assert.equal(await ack.isDisabled(),true);assert.equal((await calls(p,'/api/lab/terminal/send')).length,0);await p.getByRole('button',{name:'취소',exact:true}).click();
 });
 await test('matching trial delivery offers proof, displays output safely and never auto broadcasts',async p=>{
  await bind(p);assert.equal(await trialPanel(p).locator('img').count(),0);await p.getByRole('textbox',{name:'시험 명령',exact:true}).fill('pwd');await p.getByRole('button',{name:'시험 명령 보내기',exact:true}).click();await p.waitForFunction(()=>document.querySelector('[data-lab-trial]').textContent.includes('시험 입력을 전달했습니다.'));
  await p.getByRole('button',{name:'시험 출력 보기',exact:true}).click();await p.waitForFunction(()=>document.querySelector('[data-lab-trial]').textContent.includes('OUTPUT'));assert.equal(await p.locator('img').count(),0);assert.equal((await calls(p,'/api/lab/terminal/send')).length,0);
  await newPreview(p);await p.getByLabel('시험 결과를 직접 확인했습니다',{exact:true}).check();await prepare(p);await final(p).waitFor();const[run]=await calls(p,'/api/lab/trial/run'),[preview]=await calls(p,'/api/lab/preview');assert.equal(preview.body.trialRunId,run.body.requestId);assert.equal(preview.body.ackWithoutTrial,undefined);await p.getByRole('button',{name:'취소',exact:true}).click();
 });
 await test('an operator may explicitly waive a matching trial record and changed commands require waiver',async p=>{
  await bind(p);await p.getByRole('textbox',{name:'시험 명령',exact:true}).fill('pwd');await p.getByRole('button',{name:'시험 명령 보내기',exact:true}).click();await p.waitForFunction(()=>document.querySelector('[data-lab-trial]').textContent.includes('시험 입력을 전달했습니다.'));
  await newPreview(p);await p.getByLabel('이번에는 시험 실행 없이 내용과 대상을 확인했습니다',{exact:true}).check();await prepare(p);await final(p).waitFor();assert.equal((await calls(p,'/api/lab/preview'))[0].body.ackWithoutTrial,true);await p.getByRole('button',{name:'취소',exact:true}).click();
  await terminal(p).locator('textarea').fill('pwd ');await terminal(p).getByRole('button',{name:'명령 보내기',exact:true}).click();assert.equal(await p.getByLabel('시험 결과를 직접 확인했습니다',{exact:true}).count(),0);assert.equal(await p.getByLabel('시험 실행 없이 내용과 대상을 확인했습니다',{exact:true}).count(),1);await p.getByRole('button',{name:'취소',exact:true}).click();
 });
 await test('lost trial and bind replies preserve request IDs and the original command',async p=>{
  await p.evaluate(()=>window.loseBind=true);await trialPanel(p).locator('summary').click();await p.getByRole('button',{name:'이 방으로 시험 연결',exact:true}).click();await p.getByRole('button',{name:'시험 실습실로 연결',exact:true}).click();await p.getByRole('button',{name:'같은 연결 요청 다시 확인',exact:true}).click();
  const binding=await calls(p,'/api/lab/trial/bind');assert.equal(binding.length,2);assert.deepEqual(binding[0].body,binding[1].body);
  await p.evaluate(()=>window.loseRun=true);const input=p.getByRole('textbox',{name:'시험 명령',exact:true});await input.fill('pwd');await p.getByRole('button',{name:'시험 명령 보내기',exact:true}).click();await input.fill('different');await p.getByRole('button',{name:'같은 시험 요청 다시 확인',exact:true}).click();const run=await calls(p,'/api/lab/trial/run');assert.equal(run.length,2);assert.deepEqual(run[0].body,run[1].body);assert.equal(run[1].body.command,'pwd');
 });
 await test('expired preview never reaches normal send',async p=>{
  await newPreview(p);await p.getByLabel('시험 실행 없이 내용과 대상을 확인했습니다',{exact:true}).check();await prepare(p);await final(p).waitFor();
  await p.evaluate(()=>{const original=Date.now;Date.now=()=>original()+301000;});await final(p).click();assert.equal((await calls(p,'/api/lab/terminal/send')).length,0);assert.equal(await final(p).isDisabled(),true);await p.getByRole('button',{name:'취소',exact:true}).click();
 });
 await test('explicit cleanup of an unknown trial request does not interrupt or run anything',async p=>{
  await bind(p);await p.evaluate(()=>window.runUnknown=true);await p.getByRole('textbox',{name:'시험 명령',exact:true}).fill('pwd');await p.getByRole('button',{name:'시험 명령 보내기',exact:true}).click();
  await p.getByRole('button',{name:'출력 확인 후 미확인 시험 요청 정리',exact:true}).click();await p.getByRole('button',{name:'요청 기록만 정리',exact:true}).click();assert.equal((await calls(p,'/api/lab/trial/run')).length,1);assert.equal((await calls(p,'/api/lab/terminal/send')).length,0);assert.equal(await p.getByRole('button',{name:'시험 명령 보내기',exact:true}).isEnabled(),true);
 });
 await test('preview timeout ignores a late response and retries the original payload',async p=>{
  await p.evaluate(()=>{const set=window.setTimeout;window.setTimeout=(fn,ms,...args)=>set(fn,ms===8000?25:ms,...args);holds['/api/lab/preview']=true;});await newPreview(p);await p.getByLabel('시험 실행 없이 내용과 대상을 확인했습니다',{exact:true}).check();await prepare(p);
  const retry=p.getByRole('button',{name:'같은 미리보기 요청 다시 확인',exact:true});await retry.waitFor();await p.evaluate(()=>{holds['/api/lab/preview']=false;const w=waiters['/api/lab/preview'][0];w.resolve({previewId:w.body.requestId,targets:[99],expiresAt:Date.now()+300000,tested:false});});await retry.click();await final(p).waitFor();
  const r=await calls(p,'/api/lab/preview');assert.equal(r.length,2);assert.deepEqual(r[0].body,r[1].body);assert.ok(!(await p.locator('[data-lab-preview]').textContent()).includes('99번'));assert.equal((await calls(p,'/api/lab/terminal/send')).length,0);await p.getByRole('button',{name:'취소',exact:true}).click();
 });
 for(const width of[390,1280])await test('trial and preview remain readable at '+width+'px',async p=>{
  await bind(p);const input=p.getByRole('textbox',{name:'시험 명령',exact:true});await input.fill('draft');await input.focus();await p.evaluate(()=>document.querySelector('main').append(trial.box(lab)));await p.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='시험 명령');
  assert.equal(await input.inputValue(),'draft');await newPreview(p,'echo '+'x'.repeat(180));await p.getByLabel('시험 실행 없이 내용과 대상을 확인했습니다',{exact:true}).check();await prepare(p);await final(p).waitFor();
  assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'page has no horizontal overflow');mkdirSync('.wrangler/terminal-review',{recursive:true});await p.screenshot({path:'.wrangler/terminal-review/trial-preview-'+width+'.png',fullPage:true});await p.getByRole('button',{name:'취소',exact:true}).click();
 },width);
 console.log(`${passed} real trial panel UI scenarios passed`);
}finally{await browser.close();}
