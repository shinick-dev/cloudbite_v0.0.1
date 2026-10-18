// Real participant-file UI factory, fixed in-memory endpoints; no live provider.
import assert from 'node:assert/strict';
import {mkdirSync} from 'node:fs';
import {chromium} from 'playwright-core';
import {LAB_FILES_JS} from '../src/labfiles.ts';
const browser=await chromium.launch({channel:'msedge',headless:true});
const id=n=>'90000000-0000-4000-8000-'+String(n).padStart(12,'0');
const fixture=`<!doctype html><html lang="ko"><meta charset="utf-8"><style>*{box-sizing:border-box}body{font:16px/1.6 system-ui;margin:20px}button{font:inherit}dialog::backdrop{background:#0008}p,label{overflow-wrap:anywhere}button:focus-visible,input:focus-visible{outline:2px solid #fbbf24;outline-offset:3px}</style><body><main><h1>실습실</h1></main><div id="bar"><button>접기</button></div><script>
${LAB_FILES_JS}
window.calls=[];window.server={transfer:null,checkpoints:[]};window.clock=Date.now();
const el=(tag,css,text)=>{const e=document.createElement(tag);if(css)e.style.cssText=css;if(text!==undefined)e.textContent=text;return e};
const request=async(path,options)=>{calls.push({path,body:options?.body?JSON.parse(options.body):null});
 if(path==='/__lab/files')return structuredClone(server);
 if(path==='/__lab/checkpoints')return{checkpoints:structuredClone(server.checkpoints)};
 if(path==='/__lab/export'){if(window.loseDownload)throw Error('reply lost');return{ticket:'-'.repeat(24),receiptId:'90000000-0000-4000-8000-000000000003',name:'checkpoint.zip'}}
 if(path==='/__lab/files/ack'){const id=JSON.parse(options.body).receiptId;if(!server.transfer||server.transfer.id!==id)throw Error('record changed');server.transfer.verifiedAt??=++clock;if(window.loseAck){window.loseAck=false;throw Error('reply lost')}return structuredClone(server)}throw Error('unexpected '+path)};
window.ui=createLabFileUI({box:document.getElementById('bar'),el,BTN:'cursor:pointer;padding:8px 12px;border:0;border-radius:6px;background:#374151;color:#fff;font:15px/1.5 system-ui',request});
</script></html>`;
let passed=0;
async function test(name,fn){const c=await browser.newContext(),p=await c.newPage();try{await p.route('https://files.invalid/**',r=>new URL(r.request().url()).pathname.startsWith('/__lab/export/')?r.fulfill({contentType:'application/zip',body:'PK fixture'}):r.fulfill({contentType:'text/html',body:fixture}));await p.goto('https://files.invalid');await fn(p);passed++;console.log('ok',name)}finally{await c.close()}}
const open=p=>p.getByRole('button',{name:'파일 보존 확인',exact:true}).click();
const checkbox=p=>p.getByRole('checkbox',{name:'내려받은 ZIP을 직접 열어 필요한 파일을 확인했습니다.'});
const ack=p=>p.getByRole('button',{name:'직접 확인 표시 저장',exact:true});
try{
 await test('idle UI never requests or marks a transfer complete',async p=>{assert.equal(await p.evaluate(()=>calls.length),0);await open(p);assert.equal(await checkbox(p).isDisabled(),true);assert.equal(await p.evaluate(()=>calls.filter(c=>c.path.endsWith('/ack')).length),0);await p.getByRole('button',{name:'닫기',exact:true}).click();assert.equal(await p.getByRole('dialog').isVisible(),false)});
 await test('an anchor attempt is insufficient; exact recorded transfer plus human checkbox is required',async p=>{
  await p.evaluate(id=>ui.download(id),id(1));await open(p);assert.equal(await ack(p).isDisabled(),true);
  await p.evaluate(id=>{server.transfer={id,at:Date.now(),verifiedAt:null,checkpoint:false}},id(1));await p.getByRole('button',{name:'전송 상태 다시 확인',exact:true}).click();assert.equal(await ack(p).isDisabled(),true);
  await checkbox(p).check();await ack(p).click();await p.getByText(/직접 확인 표시를 저장했습니다/).waitFor();const calls=await p.evaluate(()=>window.calls.filter(c=>c.path.endsWith('/ack')));assert.deepEqual(calls,[{path:'/__lab/files/ack',body:{receiptId:id(1)}}]);assert.equal(await ack(p).isDisabled(),true);
 });
 await test('lost acknowledgment keeps exact ID and explicit retry is idempotent',async p=>{
  await p.evaluate(id=>{server.transfer={id,at:Date.now(),verifiedAt:null,checkpoint:false};loseAck=true},id(1));await open(p);await checkbox(p).check();await ack(p).click();await p.getByText(/표시를 저장하지 못했습니다/).waitFor();await ack(p).click();await p.getByText(/직접 확인 표시를 저장했습니다/).waitFor();const r=await p.evaluate(()=>calls.filter(c=>c.path.endsWith('/ack')));assert.equal(r.length,2);assert.deepEqual(r[0],r[1]);
 });
 await test('another transfer cannot inherit a checked human confirmation',async p=>{
  await p.evaluate(id=>server.transfer={id,at:Date.now(),verifiedAt:null,checkpoint:false},id(1));await open(p);await checkbox(p).check();await p.evaluate(id=>ui.take({transfer:{id,at:Date.now(),verifiedAt:null,checkpoint:true}}),id(2));assert.equal(await checkbox(p).isChecked(),false);assert.equal(await ack(p).isDisabled(),true);assert.equal(await p.evaluate(()=>calls.filter(c=>c.path.endsWith('/ack')).length),0);
 });
 await test('a pending new download cannot use the previous success record',async p=>{
  await p.evaluate(ids=>{server.transfer={id:ids[0],at:Date.now(),verifiedAt:null,checkpoint:false};ui.download(ids[1])},[id(1),id(2)]);await open(p);assert.equal(await checkbox(p).isDisabled(),true);await p.getByText(/새 다운로드의 전송 완료 기록/).waitFor();await p.evaluate(()=>ui.fold(true));assert.equal(await p.getByRole('button',{name:'파일 보존 확인',exact:true}).isVisible(),false);
 });
 await test('explicit own checkpoint selection starts only its fixed download and never confirms a ZIP',async p=>{
  await p.evaluate(id=>server.checkpoints=[{requestId:id,at:Date.now(),size:1024,entries:2,omitted:0}],id(9));await open(p);await p.getByText('이전 체크포인트 내려받기',{exact:true}).click();assert.equal(await p.evaluate(()=>calls.filter(c=>c.path==='/__lab/checkpoints').length),0);
  await p.getByRole('button',{name:'내 자리 체크포인트 목록 확인',exact:true}).click();await p.getByRole('combobox',{name:'내려받을 체크포인트'}).selectOption(id(9));const promise=p.waitForEvent('download');await p.getByRole('button',{name:'선택한 보관본 내려받기',exact:true}).click();const dl=await promise;assert.equal(dl.suggestedFilename(),'checkpoint.zip');assert.equal(new URL(dl.url()).pathname,'/__lab/export/'+'-'.repeat(24));
  assert.deepEqual(await p.evaluate(()=>calls.filter(c=>c.path==='/__lab/export').map(c=>c.body)),[{checkpointId:id(9)}]);assert.equal(await p.evaluate(()=>calls.filter(c=>c.path.endsWith('/ack')).length),0);assert.equal(await checkbox(p).isDisabled(),true);
 });
 await test('lost checkpoint ticket is uncertain and never auto retries',async p=>{
  await p.evaluate(id=>{server.checkpoints=[{requestId:id,at:Date.now(),size:1024}];loseDownload=true},id(9));await open(p);await p.getByText('이전 체크포인트 내려받기',{exact:true}).click();await p.getByRole('button',{name:'내 자리 체크포인트 목록 확인',exact:true}).click();await p.getByRole('combobox',{name:'내려받을 체크포인트'}).selectOption(id(9));await p.getByRole('button',{name:'선택한 보관본 내려받기',exact:true}).click();await p.getByText(/내려받기 결과 확인 필요/).waitFor();assert.equal(await p.evaluate(()=>calls.filter(c=>c.path==='/__lab/export').length),1);assert.equal(await p.evaluate(()=>calls.filter(c=>c.path.endsWith('/ack')).length),0);
 });
 for(const width of[390,1280])await test('file verification dialog fits '+width+'px',async p=>{await p.setViewportSize({width,height:950});await p.evaluate(id=>server.transfer={id,at:Date.now(),verifiedAt:null,checkpoint:false},id(1));await open(p);await p.getByText('이전 체크포인트 내려받기',{exact:true}).click();const box=await p.getByRole('dialog').boundingBox();assert.ok(box.x>=0&&box.x+box.width<=width);assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);mkdirSync('.wrangler/terminal-review',{recursive:true});await p.screenshot({path:'.wrangler/terminal-review/files-'+width+'.png',fullPage:true})});
 console.log('PASS participant files UI',passed);
}finally{await browser.close()}
