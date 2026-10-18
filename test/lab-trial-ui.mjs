// Coordinator tests of the terminal's preview boundary. No live participant requests.
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { LAB_CONTROL_JS } from '../src/labcontrol.ts';
import { LAB_TERMINAL_JS } from '../src/labterminal.ts';
const browser=await chromium.launch({channel:'msedge',headless:true});
const fixture=`<!doctype html><html lang="ko"><meta charset="utf-8"><body><main></main><script>
${LAB_CONTROL_JS}
${LAB_TERMINAL_JS}
window.calls=[];window.previews=[];window.server={mode:'running',revision:0,updatedAt:Date.now()};
window.sid='40000000-0000-4000-8000-000000000001';window.previewId='40000000-0000-4000-8000-000000000002';
const btn=(text,cls,fn)=>{const b=document.createElement('button');b.textContent=text;b.onclick=fn;return b;};
const call=async(path,body)=>{calls.push({path,body:structuredClone(body)});
 if(path==='/api/lab/control/status')return structuredClone(server);
 if(path==='/api/lab/control/pause'||path==='/api/lab/control/resume'){server={mode:path.endsWith('/pause')?'paused':'running',revision:server.revision+1,updatedAt:Date.now()};return structuredClone(server);}
 if(path==='/api/lab/terminal/status')return{active:true,sessionId:sid,seats:[{n:1,status:'ready'},{n:3,status:'ready'}]};
 if(path==='/api/lab/terminal/send'){
  if(window.lostSend){window.lostSend=false;throw Error('response lost');}
  if(window.rejectPreview){window.rejectPreview=false;throw Object.assign(Error('preview changed'),{status:409,code:'preview_rejected'});}
  if(window.holdSend)return new Promise(resolve=>window.releaseSend=resolve);
  return{results:[{n:1,status:'sent'},{n:3,status:'sent'}]};
 }
 throw Error('unexpected request '+path);
};
const trial={preparePreview:(id,session,command,container)=>new Promise(resolve=>{
 previews.push({id,session,command});const panel=document.createElement('section');panel.dataset.previewFixture='1';
 const pre=document.createElement('pre');pre.textContent=command;
 panel.append(pre,btn('확인하고 보내기','',()=>{panel.remove();resolve(previewId)}),btn('취소','',()=>{panel.remove();resolve(null)}));container.append(panel);
})};
window.ctrl=createLabControl({btn,call,cleanErr:String});window.term=createLabTerminal({btn,call,cleanErr:String,copy:async()=>{},control:ctrl,trial});
window.lab={id:'lab',seats:[{n:1,who:'참여자1'},{n:3,who:'참여자3'}]};
document.querySelector('main').append(ctrl.box(lab),term.box(lab));
</script></body></html>`;
let passed=0;
async function test(name,fn){const context=await browser.newContext(),page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
 try{await context.route('**/*',r=>{assert.equal(new URL(r.request().url()).origin,'http://localhost:8978');return r.fulfill({contentType:'text/html',body:fixture});});
  await page.goto('http://localhost:8978/');await page.waitForFunction(()=>ctrl.allowsNew('lab'));
  await page.locator('[data-lab-terminal] summary').click();await page.waitForFunction(()=>document.querySelector('[data-lab-terminal]').textContent.includes('상태를 확인했습니다.'));
  await fn(page);assert.deepEqual(errors,[]);passed++;console.log('ok',name);
 }finally{await context.close();}}
const enter=async(p,command='pwd')=>{await p.locator('textarea').fill(command);await p.getByRole('button',{name:'명령 보내기',exact:true}).click();await p.locator('[data-preview-fixture]').waitFor();};
const sends=p=>p.evaluate(()=>calls.filter(c=>c.path==='/api/lab/terminal/send'));
try{
 await test('cancelled inline preview creates no broadcast request and leaves command editable',async p=>{
  await enter(p);assert.equal((await sends(p)).length,0);assert.equal(await p.locator('textarea').isDisabled(),true);
  await p.getByRole('button',{name:'취소',exact:true}).click();assert.equal((await sends(p)).length,0);assert.equal(await p.locator('textarea').isEnabled(),true);assert.equal(await p.locator('textarea').inputValue(),'pwd');
 });
 await test('pause and resume during preview never deliver automatically or on stale confirmation',async p=>{
  await enter(p);const pause=p.getByRole('button',{name:'명령 전달 일시정지',exact:true});assert.equal(await pause.isEnabled(),true);
  await pause.click();await p.getByRole('button',{name:'명령 전달 재개',exact:true}).click();await p.waitForFunction(()=>ctrl.allowsNew('lab'));
  assert.equal((await sends(p)).length,0);await p.getByRole('button',{name:'확인하고 보내기',exact:true}).click();
  await p.waitForFunction(()=>document.querySelector('[data-lab-terminal]').textContent.includes('확인 중 전달 상태가 바뀌었습니다.'));assert.equal((await sends(p)).length,0);
 });
 await test('confirmed preview freezes the exact command, preview ID and control revision',async p=>{
  const command="echo '<img src=x onerror=alert(1)>'";await enter(p,command);assert.equal(await p.locator('[data-preview-fixture] pre').textContent(),command);assert.equal(await p.locator('[data-preview-fixture] img').count(),0);
  await p.getByRole('button',{name:'확인하고 보내기',exact:true}).click();await p.waitForFunction(()=>calls.some(c=>c.path==='/api/lab/terminal/send'));
  const [request]=await sends(p);assert.equal(request.body.command,command);assert.equal(request.body.previewId,await p.evaluate(()=>previewId));assert.equal(request.body.expectedControlRevision,0);
 });
 await test('unknown send response preserves the original preview and operation IDs',async p=>{
  await p.evaluate(()=>window.lostSend=true);await enter(p);await p.getByRole('button',{name:'확인하고 보내기',exact:true}).click();
  await p.getByRole('button',{name:'같은 명령 다시 확인',exact:true}).click();const r=await sends(p);assert.equal(r.length,2);assert.deepEqual(r[0].body,r[1].body);assert.equal(await p.evaluate(()=>previews.length),1);
 });
 await test('definite preview rejection requires a new explicit preview with command retained',async p=>{
  await p.evaluate(()=>window.rejectPreview=true);await enter(p);await p.getByRole('button',{name:'확인하고 보내기',exact:true}).click();
  await p.waitForFunction(()=>document.querySelector('[data-lab-terminal]').textContent.includes('새 명령이 거부됐습니다.'));
  assert.equal(await p.locator('textarea').inputValue(),'pwd');assert.equal(await p.getByRole('button',{name:'명령 보내기',exact:true}).isEnabled(),true);
  await p.getByRole('button',{name:'명령 보내기',exact:true}).click();await p.locator('[data-preview-fixture]').waitFor();assert.equal((await sends(p)).length,1);assert.equal(await p.evaluate(()=>previews.length),2);
 });
 await test('terminal redraw preserves the inline preview, typed command and focus',async p=>{
  await enter(p);await p.getByRole('button',{name:'취소',exact:true}).focus();await p.evaluate(()=>document.querySelector('main').append(term.box(lab)));
  assert.equal(await p.locator('[data-preview-fixture]').count(),1);assert.equal(await p.locator('textarea').inputValue(),'pwd');
  await p.waitForFunction(()=>document.activeElement?.textContent==='취소');await p.getByRole('button',{name:'취소',exact:true}).click();assert.equal((await sends(p)).length,0);
 });
 await test('a send timeout preserves pending IDs and ignores late success',async p=>{
  await p.evaluate(()=>{const set=window.setTimeout;window.setTimeout=(fn,ms,...args)=>set(fn,ms===8000?25:ms,...args);window.holdSend=true;});
  await enter(p);await p.getByRole('button',{name:'확인하고 보내기',exact:true}).click();await p.waitForFunction(()=>document.querySelector('[data-lab-terminal]').textContent.includes('응답을 확인하는 데 시간이 걸리고 있습니다.'));
  await p.evaluate(()=>{window.holdSend=false;releaseSend({results:[{n:1,status:'sent'}]});});
  await p.getByRole('button',{name:'같은 명령 다시 확인',exact:true}).click();const r=await sends(p);assert.equal(r.length,2);assert.deepEqual(r[0].body,r[1].body);assert.equal(await p.evaluate(()=>previews.length),1);
 });
 console.log(`${passed} terminal preview boundary UI scenarios passed`);
}finally{await browser.close();}
