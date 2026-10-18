// Isolated inbox fixture. No real Access login, WebAuthn key, push service, or sandbox is contacted.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {chromium} from 'playwright-core';
const bundle=await build({stdin:{contents:"export {labOpenParticipantPage,labOpenManagerPage} from './src/lab-open-pages.ts';export {WEBAUTHN_JS} from './src/pages.ts'",resolveDir:process.cwd()},bundle:true,format:'esm',platform:'neutral',write:false,logLevel:'silent'});
const {labOpenParticipantPage,labOpenManagerPage,WEBAUTHN_JS}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const participantHtml=labOpenParticipantPage('https://lab.example.test');
const managerHtml=labOpenManagerPage();
for(const html of [participantHtml,managerHtml]) for(const s of html.matchAll(/<script(?: [^>]*)?>([\s\S]*?)<\/script>/g)) new Function(s[1]);
assert.equal(participantHtml.includes('class="manager"'),false);
assert.equal(participantHtml.includes('모임지기 메뉴'),false);
assert.equal(participantHtml.includes('모임지기에게 요청하기'),true);
assert.equal(managerHtml.includes('href="/lab#prepare"'),true);
assert.equal(managerHtml.includes('href="/lab#settings"'),true);
const practiceId='00000000-0000-4000-8000-000000000001';
const unknownId='00000000-0000-4000-8000-000000000002';
const joinId='00000000-0000-4000-8000-000000000003';
const joinName='기존 모임 참여자 '+'가나다라마바사아자차카타파하'.repeat(4);
const joinPurpose=('진행 중인 모임에 합류해서 어제 작성한 회의록을 이어서 정리합니다. ').repeat(6);
const successText='승인됐습니다. 생성 결과 확인을 눌러 같은 요청으로 이어가세요.';
const unknownText='이 요청은 다시 승인하지 않습니다. 같은 요청으로 생성 결과를 확인하세요.';
const releasedText='이 요청은 아직 승인되지 않았습니다. 조건을 확인한 뒤 보안 키로 승인할 수 있습니다.';
const browser=await chromium.launch({channel:'msedge',headless:true});
let checks=0;
const check=(name,value)=>{if(!value)throw new Error('FAIL '+name);checks++;console.log('ok '+name)};
const choiceOf=id=>calls=>calls.filter(c=>c.path.endsWith('/approve')&&c.body&&c.body.id===id);
try {
 for(const width of [390,1280]) {
  const context=await browser.newContext({viewport:{width,height:720}}),page=await context.newPage(),calls=[],errors=[];
  let keyFailLeft=1,listMode='full',expiredLogin=false;
  await page.addInitScript(()=>{window.keyTaps=0;Object.defineProperty(navigator.credentials,'get',{configurable:true,value:async()=>{window.keyTaps++;await new Promise(r=>{window.releaseKey=r});return {id:'fixture',rawId:new Uint8Array([1]),type:'public-key',response:{clientDataJSON:new Uint8Array([1]),authenticatorData:new Uint8Array([2]),signature:new Uint8Array([3]),userHandle:null},getClientExtensionResults:()=>({})}}})});
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('https://k.example.test/**',async route=>{
   const url=new URL(route.request().url());
   if(url.pathname==='/lab/requests')return route.fulfill({contentType:'text/html',body:managerHtml});
   if(url.pathname==='/webauthn.js')return route.fulfill({contentType:'application/javascript',body:WEBAUTHN_JS});
   if(url.pathname.endsWith('teacher-sw.js'))return route.fulfill({status:404,body:'fixture has no push'});
   const body=route.request().postDataJSON?.()??null;
   calls.push({path:url.pathname,body});
   if(url.pathname.endsWith('/session'))return route.fulfill({json:{email:'owner@example.test',expiresAt:Date.now()+86400000}});
   if(url.pathname.endsWith('/list')){
    if(expiredLogin)return route.fulfill({status:403,json:{error:'로그인 만료'}});
    if(listMode==='fail')return route.fulfill({status:503,json:{error:'목록 확인에 실패했습니다.'}});
    if(listMode==='empty')return route.fulfill({json:{requests:[],hours:[1,2],budgets:[1,2],labs:[]}});
    return route.fulfill({json:{requests:[
     {id:practiceId,name:'연습 참여자',purpose:'메모로 보고서 만들기',mode:'practice',state:'pending',createdAt:Date.now()},
     {id:unknownId,name:'확인 참여자',purpose:'같은 요청 결과만 확인',mode:'practice',state:'pending',createdAt:Date.now()-1000},
     {id:joinId,name:joinName,purpose:joinPurpose,mode:'join',state:'pending',createdAt:Date.now()-2000}
    ],labs:[{id:'lab-tuesday',name:'화요 실습',seats:3,expiresAt:Date.now()+3600000,budget:2,cpu:2,memory:4,disk:5}],hours:[1,2],budgets:[1,2]}});
   }
   if(url.pathname.endsWith('/options'))return route.fulfill({json:{challenge:'Zml4dHVyZQ'}});
   if(url.pathname.endsWith('/approve')){
    if(body&&body.id===unknownId)return route.abort('failed');
    if(body&&body.id===practiceId&&keyFailLeft){keyFailLeft--;return route.fulfill({status:401,json:{error:'이 요청의 보안 키 승인에 실패했습니다.'}})}
    return route.fulfill({json:{state:'approving'}});
   }
   if(url.pathname.endsWith('/resume'))return route.fulfill({status:409,json:{error:'보안 키로 승인한 요청만 이어갈 수 있습니다.'}});
   return route.fulfill({json:{available:false}});
  });
  await page.clock.install();
  await page.goto('https://k.example.test/lab/requests');
  const practice=page.locator('article[data-request="'+practiceId+'"]');
  const unknown=page.locator('article[data-request="'+unknownId+'"]');
  const join=page.locator('article[data-request="'+joinId+'"]');
  const approveIn=card=>card.locator('button').filter({hasText:'보안 키로 승인하고 열기'});
  try {
   await page.getByRole('heading',{level:1,name:'개설 요청',exact:true}).waitFor();
   await page.getByRole('heading',{level:2,name:'owner@example.test',exact:true}).waitFor();
   await page.locator('#queue').getByText(/미처리 3건/).waitFor();
   const nav=await page.getByRole('navigation',{name:'모임지기 메뉴'}).locator('a').evaluateAll(as=>as.map(a=>[a.textContent,a.getAttribute('href'),a.getAttribute('aria-current')]));
   assert.deepEqual(nav,[['모임 진행','/lab',null],['개설 요청','/lab/requests','page'],['모임 준비','/lab#prepare',null],['설정','/lab#settings',null]]);
   check(width+'px four-entry nav marks only 개설 요청 current',true);
   check(width+'px inbox shows owner email without a key ceremony',await page.evaluate(()=>window.keyTaps===0)&&!calls.some(c=>c.path==='/api/admin/login'));
   check(width+'px requests sit in the first viewport',await page.locator('#requests').evaluate(e=>{const t=e.getBoundingClientRect().top;return t>0&&t<innerHeight}));
   check(width+'px approve stays hidden until 조건 확인',await page.getByRole('button',{name:'보안 키로 승인하고 열기'}).count()===0&&await approveIn(practice).count()===1);
   const pushText=await page.locator('#pushState').innerText();
   check(width+'px push failure stays visible without claiming delivery',pushText.includes('서버의 개설 요청 알림 설정이 준비되지 않았습니다. 요청은 이 목록에서 확인합니다.')&&!pushText.includes('보장')&&await page.locator('.tools details').filter({hasText:'이 기기 알림 설정'}).evaluate(d=>d.open===false));
   check(width+'px request URL stays in a secondary disclosure',await page.locator('#requestLink').getAttribute('href')==='/lab/request'&&await page.locator('.tools details').filter({hasText:'참여자에게 줄 요청 주소'}).evaluate(d=>d.open===false));
   check(width+'px unavailable push leaves test acknowledgement disabled',await page.locator('#testAck').evaluate(e=>e.disabled&&e.dataset.hold==='disabled')&&await page.locator('#test').evaluate(e=>e.disabled&&e.dataset.hold==='disabled'));
   check(width+'px load does not subscribe, test, or acknowledge push',calls.every(c=>!/\/push\/(subscribe|ack|test|options|unsubscribe|devices)$/.test(c.path)));
   const minHeight=async locator=>{const heights=await locator.evaluateAll(els=>els.map(e=>e.getBoundingClientRect()).filter(r=>r.width>0&&r.height>0).map(r=>r.height));assert.ok(heights.length>0,width+'px no visible targets');return Math.min(...heights)};
   check(width+'px visible targets are at least 44px',await minHeight(page.locator('nav.lab-nav a, #reload, a[href="/cdn-cgi/access/logout"], summary'))>=44);
   check(width+'px no horizontal overflow before opening',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
   await practice.locator('summary').focus();
   check(width+'px request disclosure is keyboard focusable',await page.evaluate(()=>document.activeElement&&document.activeElement.tagName==='SUMMARY'));
   await page.keyboard.press('Enter');
   await practice.getByRole('button',{name:'보안 키로 승인하고 열기'}).waitFor();
   const opened=await practice.getByRole('button',{name:'보안 키로 승인하고 열기'}).boundingBox();
   const vh=await page.evaluate(()=>innerHeight);
   if(!(opened&&opened.y>=0&&opened.y+opened.height<=vh+2))throw new Error('FAIL approve box '+JSON.stringify(opened)+' vh '+vh);
   check(width+'px approve is reachable inside the opened detail',true);
   check(width+'px opened approve target is at least 44px',await minHeight(approveIn(practice))>=44);
   const spec=practice.getByRole('combobox',{name:'연습 참여자 실습실 사양',exact:true});
   check(width+'px practice presets stay available inside the disclosure',await spec.locator('option').count()===4&&await spec.inputValue()==='0');
   check(width+'px practice card explains its own scope',(await practice.innerText()).includes('혼자 복습할 개인 실습실입니다.'));
   await spec.selectOption('custom');
   await practice.getByRole('spinbutton',{name:'연습 참여자 CPU (코어)',exact:true}).fill('2');
   await practice.getByRole('spinbutton',{name:'연습 참여자 메모리 (GiB)',exact:true}).fill('');
   await practice.getByRole('spinbutton',{name:'연습 참여자 디스크 (GiB)',exact:true}).fill('12');
   const optionsBefore=calls.filter(c=>c.path.endsWith('/options')).length;
   await practice.getByRole('button',{name:'보안 키로 승인하고 열기'}).click();
   await practice.getByText('CPU·메모리·디스크를 각각 1 이상의 정수로 입력하세요.',{exact:true}).waitFor();
   check(width+'px invalid custom spec stops before key or API',calls.filter(c=>c.path.endsWith('/options')).length===optionsBefore&&await page.evaluate(()=>window.keyTaps===0)&&await approveIn(practice).count()===1);
   await practice.getByRole('spinbutton',{name:'연습 참여자 메모리 (GiB)',exact:true}).fill('8');
   await page.getByRole('button',{name:'요청 다시 확인',exact:true}).click();
   await page.waitForFunction(id=>{const s=document.getElementById('spec-'+id);return s&&!s.disabled&&s.value==='custom'},practiceId);
   check(width+'px refresh preserves the custom spec draft',await spec.inputValue()==='custom'&&await practice.getByRole('spinbutton',{name:'연습 참여자 CPU (코어)',exact:true}).inputValue()==='2'&&await practice.getByRole('spinbutton',{name:'연습 참여자 메모리 (GiB)',exact:true}).inputValue()==='8'&&await practice.getByRole('spinbutton',{name:'연습 참여자 디스크 (GiB)',exact:true}).inputValue()==='12');
   check(width+'px reload stays wired to a real handler',await page.locator('#reload').evaluate(e=>typeof e.onclick==='function'));
   check(width+'px test acknowledgement stays disabled across refresh',await page.locator('#testAck').evaluate(e=>e.disabled&&e.dataset.hold==='disabled'));
   await page.evaluate(()=>{window.releaseKey=undefined});
   await practice.getByRole('button',{name:'보안 키로 승인하고 열기'}).click();
   await page.waitForFunction(()=>typeof window.releaseKey==='function');
   check(width+'px spec fields stay disabled during key confirmation',await spec.isDisabled()&&await practice.getByRole('spinbutton',{name:'연습 참여자 메모리 (GiB)',exact:true}).isDisabled());
   await page.evaluate(()=>{const release=window.releaseKey;window.releaseKey=undefined;release()});
   await practice.getByText('이 요청의 보안 키 승인에 실패했습니다.',{exact:true}).waitFor();
   await page.waitForFunction(id=>{const card=document.querySelector('article[data-request="'+id+'"]');const button=card&&[...card.querySelectorAll('button')].find(b=>b.textContent==='보안 키로 승인하고 열기');return button&&!button.disabled},practiceId);
   check(width+'px key failure keeps the same approve action',await approveIn(practice).count()===1&&await page.evaluate(()=>window.keyTaps===1));
   await practice.getByRole('button',{name:'보안 키로 승인하고 열기'}).click();
   await page.waitForFunction(()=>typeof window.releaseKey==='function');
   await page.evaluate(()=>{const release=window.releaseKey;window.releaseKey=undefined;release()});
   await practice.getByText(successText,{exact:true}).waitFor();
   const practiceApprovals=choiceOf(practiceId)(calls);
   const practiceOptions=calls.filter(c=>c.path.endsWith('/options')&&c.body&&c.body.id===practiceId);
   assert.equal(practiceApprovals.length,2);
   assert.deepEqual(practiceApprovals[1].body.choice,{hours:1,budget:1,cpu:2,memory:8,disk:12});
   assert.equal(practiceApprovals[1].body.assertion.id,'fixture');
   assert.deepEqual(practiceOptions.at(-1).body.choice,practiceApprovals[1].body.choice);
   check(width+'px one frozen choice is sent for options and approval',true);
   check(width+'px success stays on the card and removes another approve',await approveIn(practice).count()===0&&await practice.locator('.req-status').innerText()===successText);
   await page.getByRole('button',{name:'요청 다시 확인',exact:true}).click();
   await page.waitForFunction(id=>document.querySelector('article[data-request="'+id+'"] .req-status')?.textContent==='승인됐습니다. 생성 결과 확인을 눌러 같은 요청으로 이어가세요.',practiceId);
   check(width+'px reload does not restore approve after success',await approveIn(practice).count()===0&&choiceOf(practiceId)(calls).length===2);
   await unknown.locator('summary').click();
   await unknown.getByRole('button',{name:'보안 키로 승인하고 열기'}).click();
   await page.waitForFunction(()=>typeof window.releaseKey==='function');
   await page.evaluate(()=>{const release=window.releaseKey;window.releaseKey=undefined;release()});
   await unknown.getByText(unknownText).waitFor();
   check(width+'px unknown approval is not described as success',!(await unknown.innerText()).includes(successText)&&await approveIn(unknown).count()===0);
   await page.getByRole('button',{name:'요청 다시 확인',exact:true}).click();
   await page.waitForFunction(id=>!(document.querySelector('article[data-request="'+id+'"]')?.textContent||'').includes('보안 키로 승인하고 열기'),unknownId);
   check(width+'px reload does not offer a second approve after an unknown result',await approveIn(unknown).count()===0&&choiceOf(unknownId)(calls).length===1);
   await unknown.getByRole('button',{name:'같은 요청으로 생성 결과 확인'}).click();
   await unknown.getByText(releasedText,{exact:true}).waitFor();
   check(width+'px resume that never claimed restores approve without sending it again',await approveIn(unknown).count()===1&&choiceOf(unknownId)(calls).length===1&&calls.filter(c=>c.path.endsWith('/resume')&&c.body&&c.body.id===unknownId).length===1);
   await join.locator('summary').click();
   const joinText=await join.innerText();
   check(width+'px join inherits the lab and does not edit resources',joinText.includes('사양·모델·AI 한도는 그 모임을 그대로 따르며, 여기서 바꾸지 않습니다.')&&await join.locator('input[type=number]').count()===0&&await join.locator('select').getAttribute('aria-label')===joinName+' 추가할 모임');
   check(width+'px long Korean name and purpose do not scroll sideways',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
   check(width+'px manager calls stay on the Access-protected path',calls.filter(c=>/\/(session|list|options|approve|resume)$/.test(c.path)).every(c=>c.path.startsWith('/api/lab/open/manager/')));
   listMode='fail';
   await page.getByRole('button',{name:'요청 다시 확인',exact:true}).click();
   await page.locator('#listError').getByText('목록 확인에 실패했습니다. 아래는 마지막에 확인한 목록입니다.',{exact:true}).waitFor();
   check(width+'px stale list keeps the last requests and says so',await practice.count()===1&&(await page.locator('#queue').innerText()).includes('최신 상태를 확인하지 못했습니다'));
   listMode='empty';
   await page.getByRole('button',{name:'요청 다시 확인',exact:true}).click();
   await page.getByText('미처리 요청이 없습니다. 참여자에게 줄 요청 주소는 아래 알림과 요청 주소에 있습니다.',{exact:true}).waitFor();
   check(width+'px empty inbox clears the stale error',await page.locator('#listError').isHidden()&&await practice.count()===0);
   expiredLogin=true;
   await page.getByRole('button',{name:'요청 다시 확인',exact:true}).click();
   await page.getByRole('link',{name:'다시 로그인',exact:true}).waitFor();
   check(width+'px expired login clears private request details',await page.locator('#private').isHidden()&&await page.locator('#requests').textContent()===''&&await page.locator('#sessionTitle').innerText()==='요청함 로그인');
   check(width+'px no automatic push acknowledgement was recorded',calls.every(c=>!/\/push\/(subscribe|ack|test|options|unsubscribe)$/.test(c.path)));
   check(width+'px no script errors',errors.length===0);
  } catch(e) {
   console.error('PAGEERRORS '+errors.join(' | '));
   throw e;
  }
  await context.close();
 }
} finally {await browser.close()}
console.log('PASS lab-open inbox UI '+checks);
