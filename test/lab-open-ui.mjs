// Isolated browser fixture; no real WebAuthn key, push service, or sandbox is contacted.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {chromium} from 'playwright-core';
const bundle=await build({stdin:{contents:"export {labOpenParticipantPage,labOpenManagerPage} from './src/lab-open-pages.ts';export {WEBAUTHN_JS} from './src/pages.ts'",resolveDir:process.cwd()},bundle:true,format:'esm',platform:'neutral',write:false,logLevel:'silent'});
const {labOpenParticipantPage,labOpenManagerPage,WEBAUTHN_JS}=await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
for(const html of [labOpenParticipantPage('https://lab.example.test'),labOpenManagerPage()]) for(const s of html.matchAll(/<script(?: [^>]*)?>([\s\S]*?)<\/script>/g)) new Function(s[1]);
const browser=await chromium.launch({channel:'msedge',headless:true});let checks=0;
const check=(name,value)=>{assert.ok(value,name);checks++;console.log('ok '+name)};
try {
 for(const width of [390,1280]) {
  const context=await browser.newContext({viewport:{width,height:850}}),page=await context.newPage(),calls=[],errors=[];
  await page.addInitScript(()=>{window.keyTaps=0;Object.defineProperty(navigator.credentials,'get',{value:async()=>{window.keyTaps++;await new Promise(r=>window.releaseKey=r);return {id:'fixture',rawId:new Uint8Array([1]),type:'public-key',response:{clientDataJSON:new Uint8Array([1]),authenticatorData:new Uint8Array([2]),signature:new Uint8Array([3]),userHandle:null},getClientExtensionResults:()=>({})}}})});
  page.on('pageerror',e=>errors.push(e.message));let state='pending',failSubmit=false,expiredLogin=false;
  await page.route('https://k.example.test/**',async route=>{const url=new URL(route.request().url()),body=route.request().postDataJSON?.();
   if(url.pathname==='/lab/request')return route.fulfill({contentType:'text/html',body:labOpenParticipantPage('https://lab.example.test')});
   if(url.pathname==='/lab/requests')return route.fulfill({contentType:'text/html',body:labOpenManagerPage()});
   if(url.pathname==='/webauthn.js')return route.fulfill({contentType:'application/javascript',body:WEBAUTHN_JS});
   if(url.pathname.endsWith('teacher-sw.js'))return route.fulfill({status:404,body:'fixture has no push'});
   calls.push({path:url.pathname,body});
   if(expiredLogin&&url.pathname.endsWith('/list'))return route.fulfill({status:403,json:{error:'로그인 만료'}});
   if(url.pathname.endsWith('/submit')){if(failSubmit){failSubmit=false;return route.abort('failed')}return route.fulfill({json:{id:body.id,state,expiresAt:Date.now()+86400000}})}
   if(url.pathname.endsWith('/status'))return route.fulfill({json:{state,...(state==='ready'?{result:{seatCode:'a'.repeat(16),expiresAt:Date.now()+3600000}}:{})}});
   if(url.pathname.endsWith('/session'))return route.fulfill({json:{email:'owner@example.test',expiresAt:Date.now()+86400000}});
   if(url.pathname.endsWith('/options'))return route.fulfill({json:{challenge:'Zml4dHVyZQ'}});
   if(url.pathname.endsWith('/login'))return route.fulfill({json:{token:'fixture-admin',expiresAt:Date.now()+28800000}});
   if(url.pathname.endsWith('/list'))return route.fulfill({json:{requests:[{id:'00000000-0000-4000-8000-000000000001',name:'연습 참여자',purpose:'메모로 보고서 만들기',mode:'practice',state:'pending',createdAt:Date.now()}],labs:[],hours:[1,2],budgets:[1,2]}});
   if(url.pathname.endsWith('/approve'))return route.fulfill({json:{state:'approving'}});
   return route.fulfill({json:{available:false}});
  });
  await page.goto('https://k.example.test/lab/request');await page.getByLabel('모임에서 쓰는 이름').fill('연습 참여자');await page.getByLabel('해보고 싶은 작업').fill('메모로 보고서\n다시 만들기');
  failSubmit=true;await page.getByRole('button',{name:'모임지기에게 요청하기'}).click();await page.getByRole('button',{name:'같은 요청으로 접수 확인'}).waitFor();await page.getByRole('button',{name:'같은 요청으로 접수 확인'}).click();await page.getByText('승인 대기',{exact:true}).waitFor();
  const submitted=calls.filter(c=>c.path.endsWith('/submit'));check(width+'px lost submit reuses exact ID/secret/payload',submitted.length===2&&JSON.stringify(submitted[0].body)===JSON.stringify(submitted[1].body));
  check(width+'px multiline purpose is sent without forbidden control characters',submitted[0].body.purpose==='메모로 보고서 다시 만들기');
  check(width+'px request secret stays out of URL',!page.url().includes(submitted[0].body.secret));
  state='ready';await page.getByRole('button',{name:'상태 다시 확인'}).click();await page.getByRole('link',{name:'내 실습실로 이동'}).waitFor();check(width+'px ready opens fixed seat host',await page.getByRole('link',{name:'내 실습실로 이동'}).getAttribute('href')==='https://lab.example.test/j/'+'a'.repeat(16));
  check(width+'px participant no horizontal overflow',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.goto('https://k.example.test/lab/requests');await page.locator('.request summary').first().click();await page.getByRole('button',{name:'보안 키로 승인하고 열기'}).waitFor();check(width+'px owner inbox loads without key ceremony',await page.evaluate(()=>window.keyTaps===0)&&!calls.some(c=>c.path==='/api/admin/login'));await page.getByRole('button',{name:'요청 다시 확인',exact:true}).click();check(width+'px refresh button is connected with real WebAuthn helper',await page.locator('#reload').evaluate(e=>typeof e.onclick==='function'));
  const spec=page.getByRole('combobox',{name:'연습 참여자 실습실 사양',exact:true});
  check(width+'px resource presets and custom input available',(await spec.locator('option').count())===4&&await spec.inputValue()==='0');
  await spec.selectOption('custom');await page.getByRole('spinbutton',{name:'연습 참여자 CPU (코어)',exact:true}).fill('2');await page.getByRole('spinbutton',{name:'연습 참여자 메모리 (GiB)',exact:true}).fill('');await page.getByRole('spinbutton',{name:'연습 참여자 디스크 (GiB)',exact:true}).fill('12');
  const before=calls.filter(c=>c.path.endsWith('/options')).length;
  await page.getByRole('button',{name:'보안 키로 승인하고 열기'}).click();await page.getByText('CPU·메모리·디스크를 각각 1 이상의 정수로 입력하세요.',{exact:true}).waitFor();check(width+'px invalid custom spec stops before key or API',calls.filter(c=>c.path.endsWith('/options')).length===before&&await page.evaluate(()=>window.keyTaps===0));
  await page.getByRole('spinbutton',{name:'연습 참여자 메모리 (GiB)',exact:true}).fill('8');
  await page.getByRole('button',{name:'요청 다시 확인',exact:true}).click();check(width+'px refresh preserves selected custom CPU memory disk',await spec.inputValue()==='custom'&&await page.getByRole('spinbutton',{name:'연습 참여자 CPU (코어)',exact:true}).inputValue()==='2'&&await page.getByRole('spinbutton',{name:'연습 참여자 메모리 (GiB)',exact:true}).inputValue()==='8'&&await page.getByRole('spinbutton',{name:'연습 참여자 디스크 (GiB)',exact:true}).inputValue()==='12');
  check(width+'px custom spec no horizontal overflow',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await page.getByRole('button',{name:'보안 키로 승인하고 열기'}).click();await page.waitForFunction(()=>typeof window.releaseKey==='function');check(width+'px resource fields locked during key confirmation',await spec.isDisabled()&&await page.getByRole('spinbutton',{name:'연습 참여자 메모리 (GiB)',exact:true}).isDisabled());await page.evaluate(()=>window.releaseKey());await page.getByText('승인됐습니다. 생성 결과 확인을 눌러 같은 요청으로 이어가세요.').waitFor();

  const approval=calls.filter(c=>c.path.endsWith('/approve'));check(width+'px approval sends explicit limits and assertion once',approval.length===1&&approval[0].body.choice.hours===1&&approval[0].body.choice.budget===1&&approval[0].body.choice.cpu===2&&approval[0].body.choice.memory===8&&approval[0].body.choice.disk===12&&approval[0].body.assertion.id==='fixture'&&await page.evaluate(()=>window.keyTaps===1));
  const keyOptions=calls.find(c=>c.path.endsWith('/options'));check(width+'px key options and approval use identical resource selection',JSON.stringify(keyOptions.body.choice)===JSON.stringify(approval[0].body.choice));
  check(width+'px manager no horizontal overflow',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));check(width+'px no script errors',errors.length===0);
  check(width+'px manager calls use Access-protected API path',calls.filter(c=>/\/(session|list|approve)$/.test(c.path)).every(c=>c.path.startsWith('/api/lab/open/manager/')));
  expiredLogin=true;await page.getByRole('button',{name:'요청 다시 확인',exact:true}).click();await page.getByRole('link',{name:'다시 로그인',exact:true}).waitFor();check(width+'px expired login clears private request details',await page.locator('#private').isHidden()&&await page.locator('#requests').textContent()==='');
  await context.close();
 }
}finally{await browser.close()}
console.log('PASS lab-open UI '+checks);
