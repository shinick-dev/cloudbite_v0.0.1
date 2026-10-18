// Aside cannot mock requests/set viewport; isolated Edge fixture, no provider traffic.
import assert from 'node:assert/strict';
import {mkdirSync} from 'node:fs';
import {chromium} from 'playwright-core';
import {LAB_INTERRUPT_JS} from '../src/labinterrupt.ts';
import {LAB_CONTROL_JS} from '../src/labcontrol.ts';
const browser=await chromium.launch({channel:'msedge',headless:true});
const fixture=`<!doctype html><html lang="ko"><meta charset="utf-8"><style>
*{box-sizing:border-box}body{font:16px/1.6 system-ui;margin:0;padding:20px;background:#f7f8f5;color:#162124;--line:#ccd4ce}main{max-width:900px;margin:auto}button,input{font:inherit;max-width:100%}button{padding:8px 12px;cursor:pointer}p,summary,label,li{overflow-wrap:anywhere}.row{display:flex;flex-wrap:wrap;gap:8px}.mut{color:#53615a}.bad{color:#a11}
</style><body><main></main><script>${LAB_CONTROL_JS}\n${LAB_INTERRUPT_JS}
window.calls=[];window.server={mode:'paused',revision:1,updatedAt:Date.now()};window.holds={};window.waiters={};window.receipts={};window.clock=0;
const btn=(text,cls,fn)=>{const b=document.createElement('button');b.textContent=text;b.className=cls;b.onclick=fn;return b};
const call=async(path,body)=>{calls.push({path,body:structuredClone(body)});
 if(holds[path])return new Promise((resolve,reject)=>(waiters[path]??=[]).push({resolve,reject,body}));
 if(path==='/api/lab/control/status')return structuredClone(server);
 if(path==='/api/lab/control/pause'||path==='/api/lab/control/resume'){server={mode:path.endsWith('/pause')?'paused':'running',revision:server.revision+1,updatedAt:Date.now()};return structuredClone(server)}
 if(path==='/api/lab/terminal/status')return{sessionId:'50000000-0000-4000-8000-000000000001',active:false,seats:[{n:1,status:'ready'},{n:3,status:'ready'}]};
 if(path==='/api/lab/interrupt/preview'){
  const r={previewId:body.previewId,revision:body.expectedRevision,expiresAt:Date.now()+60000,targets:body.seats.map(n=>({n,program:'opencode <img src=x onerror=alert(1)>'}))};
  if(window.losePreview){window.losePreview=false;throw Error('reply lost')}return r;
 }
 if(path==='/api/lab/interrupt/request'){
  const r=receipts[body.requestId]??={requestId:body.requestId,results:[{n:3,status:window.unknown?'unknown':'sent'}]};
  if(window.loseRequest){window.loseRequest=false;throw Error('reply lost')}return r;
 }throw Error('unexpected '+path);
};
const D={btn,call,cleanErr:String};window.ctrl=createLabControl(D);window.interrupt=createLabInterrupt({...D,control:ctrl,now:()=>Date.now()+clock,timeoutMs:250});
window.lab={id:'lab',seats:[{n:1,who:'참여자1'},{n:3,who:'참여자 <b>3</b>'}]};
document.querySelector('main').append(ctrl.box(lab),interrupt.box(lab));
</script></html>`;
let passed=0;
const calls=(p,path)=>p.evaluate(path=>calls.filter(x=>x.path===path),path);
async function load(p){await p.getByText('수업 터미널 프로그램 중단 요청',{exact:true}).click();await p.getByRole('button',{name:'대상 다시 확인',exact:true}).click();await p.getByRole('checkbox',{name:'3번 자리 중단 대상'}).waitFor()}
async function prepare(p){await load(p);await p.getByRole('checkbox',{name:'3번 자리 중단 대상'}).check();await p.getByRole('button',{name:'선택한 자리의 실행 프로그램 확인',exact:true}).click();await p.getByRole('button',{name:'선택한 프로그램에 중단 요청 보내기',exact:true}).waitFor()}
async function test(name,fn,width=1000){const c=await browser.newContext({viewport:{width,height:950}}),p=await c.newPage();try{await p.route('https://interrupt.invalid/**',r=>r.fulfill({contentType:'text/html',body:fixture}));await p.goto('https://interrupt.invalid');await p.getByText('명령 전달 일시정지',{exact:true}).first().waitFor();await fn(p);passed++;console.log('ok',name)}finally{await c.close()}}
try{
 await test('explicit subset, read-only preview, separate confirmation and safe text',async p=>{
  await load(p);assert.equal(await p.getByRole('checkbox').isChecked().catch(()=>false),false);
  assert.equal((await calls(p,'/api/lab/interrupt/preview')).length,0);await p.getByRole('checkbox',{name:'3번 자리 중단 대상'}).check();
  await p.getByRole('button',{name:'선택한 자리의 실행 프로그램 확인',exact:true}).click();await p.getByRole('region',{name:'프로그램 중단 요청 확인'}).waitFor();
  assert.deepEqual((await calls(p,'/api/lab/interrupt/preview'))[0].body.seats,[3]);assert.equal((await calls(p,'/api/lab/interrupt/request')).length,0);assert.equal(await p.locator('img,b').count(),0);
  await p.getByRole('button',{name:'선택한 프로그램에 중단 요청 보내기',exact:true}).click();await p.getByLabel('중단 요청 결과').getByText(/Ctrl\+C 전달됨/).waitFor();
  assert.equal((await calls(p,'/api/lab/interrupt/request')).length,1);assert.equal((await calls(p,'/api/lab/control/pause')).length,0);assert.equal((await calls(p,'/api/lab/control/resume')).length,0);
 });
 await test('cancel leaves transmission control reachable and sends nothing',async p=>{await prepare(p);await p.getByRole('button',{name:'취소',exact:true}).click();assert.equal((await calls(p,'/api/lab/interrupt/request')).length,0);assert.equal(await p.getByRole('button',{name:'명령 전달 일시정지',exact:true}).isEnabled(),true)});
 await test('control revision change invalidates a held preview',async p=>{
  await load(p);await p.getByRole('checkbox',{name:'3번 자리 중단 대상'}).check();await p.evaluate(()=>holds['/api/lab/interrupt/preview']=true);await p.getByRole('button',{name:'선택한 자리의 실행 프로그램 확인',exact:true}).click();
  await p.waitForFunction(()=>waiters['/api/lab/interrupt/preview']?.length);await p.getByRole('button',{name:'명령 전달 일시정지',exact:true}).click();
  await p.evaluate(()=>{const w=waiters['/api/lab/interrupt/preview'][0];w.resolve({previewId:w.body.previewId,revision:w.body.expectedRevision,expiresAt:Date.now()+60000,targets:[{n:3,program:'old'}]})});
  await p.waitForTimeout(30);assert.equal(await p.getByRole('region',{name:'프로그램 중단 요청 확인'}).isVisible(),false);assert.equal((await calls(p,'/api/lab/interrupt/request')).length,0);
 });
 await test('lost request retains exact ID and only rereads it after resume',async p=>{
  await prepare(p);await p.evaluate(()=>loseRequest=true);await p.getByRole('button',{name:'선택한 프로그램에 중단 요청 보내기',exact:true}).click();await p.getByRole('button',{name:'같은 중단 요청 결과 다시 확인',exact:true}).waitFor();
  p.once('dialog',d=>d.accept());await p.getByRole('button',{name:'명령 전달 재개',exact:true}).click();await p.getByRole('button',{name:'같은 중단 요청 결과 다시 확인',exact:true}).click();
  await p.getByLabel('중단 요청 결과').getByText(/Ctrl\+C 전달됨/).waitFor();const r=await calls(p,'/api/lab/interrupt/request');assert.equal(r.length,2);assert.deepEqual(r[0].body,r[1].body);
 });
 await test('lost read-only preview reuses exact request and selected seats',async p=>{
  await load(p);await p.getByRole('checkbox',{name:'3번 자리 중단 대상'}).check();await p.evaluate(()=>losePreview=true);await p.getByRole('button',{name:'선택한 자리의 실행 프로그램 확인',exact:true}).click();
  await p.getByRole('button',{name:'같은 프로그램 확인 요청 다시 확인',exact:true}).click();await p.getByRole('region',{name:'프로그램 중단 요청 확인'}).waitFor();const r=await calls(p,'/api/lab/interrupt/preview');assert.deepEqual(r[0].body,r[1].body);assert.equal((await calls(p,'/api/lab/interrupt/request')).length,0);
 });
 await test('expired preview cannot send and timeout ignores late response',async p=>{
  await prepare(p);await p.evaluate(()=>clock=61000);await p.getByRole('button',{name:'선택한 프로그램에 중단 요청 보내기',exact:true}).click();assert.equal((await calls(p,'/api/lab/interrupt/request')).length,0);
  await p.evaluate(()=>{clock=0;holds['/api/lab/interrupt/preview']=true});await p.getByRole('button',{name:'선택한 자리의 실행 프로그램 확인',exact:true}).click();
  await p.getByText(/응답 확인 시간이 지났습니다/).waitFor();await p.evaluate(()=>{const w=waiters['/api/lab/interrupt/preview'][0];w.resolve({previewId:w.body.previewId,revision:w.body.expectedRevision,expiresAt:Date.now()+60000,targets:[{n:3,program:'late'}]})});await p.waitForTimeout(30);assert.equal(await p.getByRole('region',{name:'프로그램 중단 요청 확인'}).isVisible(),false);
 });
 for(const width of[390,1280])await test('readable confirmation and reachable control at '+width+'px',async p=>{
  await prepare(p);assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.equal(await p.getByRole('button',{name:'명령 전달 일시정지',exact:true}).isEnabled(),true);
  mkdirSync('.wrangler/terminal-review',{recursive:true});await p.screenshot({path:'.wrangler/terminal-review/interrupt-'+width+'.png',fullPage:true});
 },width);
 console.log('PASS interrupt UI',passed);
}finally{await browser.close()}
