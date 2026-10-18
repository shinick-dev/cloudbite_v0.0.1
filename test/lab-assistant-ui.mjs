// Aside does not mock requests or viewports. Isolated Edge fixtures only; no live backend.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { LAB_HELP_JS } from '../src/labhelp.ts';
import { LAB_ASSISTANTS_JS } from '../src/labassistants.ts';
import { LAB_ASSISTANT_HTML } from '../src/lab-assistant-page.ts';

new Function(LAB_HELP_JS);
new Function(LAB_ASSISTANTS_JS);
const pageScript = LAB_ASSISTANT_HTML.match(/<script>([\s\S]*)<\/script>/);
assert.ok(pageScript, 'assistant page script');
new Function(pageScript[1]);

const TOKEN = 'tok-once-9f3a';
const SESSION = 'sess-token-zz';
const NO_ASSISTANT = '연결된 조교가 아직 없습니다. 모임지기에게 음성/손들기로 알려주세요.';
const PAUSE_NOTE = '새 전달 일시정지는 수업 전체에 적용되고, 실행 중인 프로그램은 멈추지 않습니다. 쓸 수 있는 자리를 모두 선택해야 합니다.';
const ISSUE_UNKNOWN = '응답 시간을 넘겼습니다. 일회용 토큰이 이미 만들어졌을 수 있어 자동으로 다시 보내지 않습니다. 목록을 새로고침하고, 방금 권한이 보이면 그 권한을 회수한 뒤 새 권한을 만드세요.';
let passed = 0;
const failed = [];
let browser;
try { browser = await chromium.launch({ channel: 'msedge', headless: true }); }
catch (e) {
  console.log('skip Edge 없음 ' + String(e.message).split('\n')[0]);
  console.log('SKIP lab assistant UI');
  process.exit(0);
}

const helpHtml = '<!doctype html><html lang="ko"><meta charset="utf-8"><style>html,body{margin:0}body{background:#0f172a}</style><body><script>'
  + "window.__hid=false;Object.defineProperty(Document.prototype,'visibilityState',{configurable:true,get(){return window.__hid?'hidden':'visible'}});"
  + "window.__pack={enabled:false,now:1,questions:[],messages:[]};window.__hold='';window.__calls=[];window.__waiters=[];"
  + "window.fetch=(url,opt)=>new Promise((resolve,reject)=>{"
  + "const path=new URL(url,location.href).pathname;const method=(opt&&opt.method)||'GET';let body=null;try{body=opt&&opt.body?JSON.parse(opt.body):null}catch(e){body=null}"
  + "window.__calls.push({path,method,body});let settled=false;"
  + "const fail=()=>{if(settled)return;settled=true;reject(Object.assign(new Error('aborted'),{name:'AbortError'}))};"
  + "const ok=(payload,status)=>{if(settled)return;settled=true;resolve(new Response(JSON.stringify(payload),{status:status||200,headers:{'content-type':'application/json'}}))};"
  + "if(opt&&opt.signal){if(opt.signal.aborted)return fail();opt.signal.addEventListener('abort',fail,{once:true})}"
  + "if(window.__hold===method+' '+path){window.__waiters.push({ok,fail,body});return}"
  + "if(window.__authFail)return ok({error:'expired'},401);"
  + "if(method==='GET'&&path==='/__lab/help')return ok(window.__pack);"
  + "if(method==='POST'&&path==='/__lab/help')return ok({question:{id:'q-new',n:1,question:body.question,at:1,status:'open',reply:''}});"
  + "if(path==='/__lab/help/resolve')return ok({question:{id:body.questionId,n:1,question:'설치가 안 돼요',at:1,status:'resolved',reply:'이렇게 하세요',repliedAt:2,replyBy:'조교'}});"
  + "return ok({error:'not mocked'},404);});"
  + "const el=(t,css,text)=>{const e=document.createElement(t);if(css)e.style.cssText=css;if(text!=null)e.textContent=text;return e};"
  + "const box=el('div','display:flex;flex-wrap:wrap;gap:6px;max-width:100%');const fold=el('button','','–');fold.type='button';box.append(fold);document.body.append(box);"
  + "window.__labBarUI={box,note:()=>{},el,BTN:'all:unset;cursor:pointer;padding:3px 9px'};"
  + '</script><script>' + LAB_HELP_JS + '</script></body></html>';

function assistantsHtml() {
  return '<!doctype html><html lang="ko"><meta charset="utf-8"><style>*{box-sizing:border-box}html,body{margin:0;background:#f4f7f6;color:#0f172a}main{padding:8px;max-width:100%}button,input,textarea{max-width:100%}</style><body><main></main><script>'
    + LAB_ASSISTANTS_JS
    + "const params=new URLSearchParams(location.search);const now=Date.now();"
    + "const lab={id:params.has('short')?'short':'long',name:params.has('short')?'짧은 수업':'긴 수업',expiresAt:now+(params.has('short')?20*60000+59000:3*3600000),seats:[{n:1,who:'김 <img src=x onerror=alert(1)>'},{n:2,who:'오류',error:'boom'},{n:3,who:'이'}]};"
    + "window.grants=params.has('revoke')?[{id:'g1',labId:lab.id,label:'Grok 총괄조교',seats:[1,3],scopes:['status:read','help:read'],createdAt:1,expiresAt:now+3600000,revokedAt:null,templates:[]}]:[];"
    + "window.calls=[];window.holds={};window.waiters=[];"
    + "const api=async(path,body)=>{calls.push({path,body:structuredClone(body)});if(holds[path])return new Promise((resolve,reject)=>waiters.push({resolve,reject,body,path}));"
    + "if(path.endsWith('/list'))return{grants:window.grants};if(path.endsWith('/audit'))return{items:[]};"
    + "if(path.endsWith('/issue'))return{grant:{id:'g-new',labId:body.id,label:body.label,seats:body.seats,scopes:body.scopes,createdAt:now,expiresAt:now+body.minutes*60000,revokedAt:null,templates:(body.templates||[]).map((t,i)=>({id:'t'+i,title:t.title,text:t.text}))},token:" + JSON.stringify(TOKEN) + "};"
    + "if(path.endsWith('/revoke')){const g=window.grants.find(x=>x.id===body.grantId);g.revokedAt=now;return{ok:true,grant:g}}throw Error('unexpected '+path)};"
    + "window.ui=createLabAssistants({api,timeoutMs:Number(params.get('timeout')||10000)});document.querySelector('main').append(ui.button(lab));"
    + '</script></body></html>';
}

function statusOf(scopes) {
  return {
    now: 1,
    grant: { id: 'g1', labId: 'lab1', label: 'Grok 총괄조교', seats: [1, 3], scopes, createdAt: 1, expiresAt: 1, revokedAt: null, templates: [{ id: 't1', title: '설치 안내', text: '노드를 확인하세요 <img src=x onerror=alert(1)>' }] },
    lab: { id: 'lab1', name: '저녁 수업', expiresAt: 1, ending: false, seats: [
      { n: 1, who: '김 <img src=x onerror=alert(1)>', hand: 0, presence: { state: 'active' }, setup: { state: 'ok' }, preparation: { state: 'ready', at: 1 }, diagnostics: { usage: 0, limit: 1, usageAt: 1, aiError: null }, delivery: { status: 'none', at: null } },
      { n: 2, who: '숨은자리', hand: 0, presence: { state: 'away' }, setup: { state: 'ok' }, preparation: { state: 'ready', at: 1 }, diagnostics: null, delivery: { status: 'none', at: null } },
      { n: 3, who: '이', hand: 1, presence: { state: 'away' }, setup: { state: 'ok' }, preparation: { state: 'preparing', at: 1 }, diagnostics: null, delivery: { status: 'sent', at: 1 } },
    ] },
    control: { mode: 'running', revision: 1, updatedAt: 1 },
  };
}

async function fits(page) {
  const box = await page.evaluate(() => {
    const d = document.querySelector('dialog[open]');
    const r = (d || document.body).getBoundingClientRect();
    return { doc: document.documentElement.scrollWidth <= window.innerWidth, left: r.left >= -1, right: r.right <= window.innerWidth + 1, width: r.width <= window.innerWidth + 1 };
  });
  assert.equal(box.doc && box.left && box.right && box.width, true, JSON.stringify(box));
}
async function test(name, fn, width = 1100) {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.setDefaultTimeout(8000);
  try { await fn(page); assert.deepEqual(errors, []); if(process.env.LAB_ASSISTANT_CAPTURE_DIR && name.includes('fits ')){fs.mkdirSync(process.env.LAB_ASSISTANT_CAPTURE_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.LAB_ASSISTANT_CAPTURE_DIR,name.replace(/[^a-z0-9]+/gi,'-')+'.png'),fullPage:true});} passed++; console.log('ok', name); }
  catch (e) { failed.push(name + ': ' + (e.stack || e.message)); console.log('FAIL', name, e.stack || e.message); }
  finally { await context.close(); }
}
async function openHelp(page) {
  await page.clock.install({ time: new Date('2026-10-15T09:00:00Z') });
  await page.route('https://help.invalid/**', (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body: helpHtml }));
  await page.goto('https://help.invalid/');
  await page.getByRole('button', { name: '도움 요청', exact: true }).click();
  await page.getByRole('dialog', { name: '도움 요청' }).waitFor();
}
async function openAssistants(page, query = '') {
  await page.route('https://assist.invalid/**', (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body: assistantsHtml() }));
  await page.goto('https://assist.invalid/' + query);
  await page.getByRole('button', { name: '조교 권한', exact: true }).click();
  await page.getByRole('dialog', { name: '조교 권한' }).waitFor();
  await page.waitForFunction(() => { const g = document.querySelector('[data-grants]')?.textContent || ''; const t = document.querySelector('[data-list-msg]')?.textContent || ''; return t === '' && (g.includes('없습니다') || g.includes('Grok')); });
}
async function assistantPage(page) {
  await page.clock.install({ time: new Date('2026-10-15T09:00:00Z') });
  await page.addInitScript(() => {
    window.__hid = false;
    Object.defineProperty(Document.prototype, 'visibilityState', { configurable: true, get() { return window.__hid ? 'hidden' : 'visible'; } });
    window.__st = { calls: [], hold: '', waiters: [], statusCode: 401, status: null, questions: { now: 1, questions: [{ id: 'q1', n: 1, question: '설치가 안 돼요', at: 1, status: 'open', reply: '' }], messages: [{ id: 'm1', n: 1, at: 1, title: '안내', text: '텍스트만 <img src=x onerror=alert(1)>' }] }, badQuestions: false, authFail: false };
    window.fetch = (url, opt) => new Promise((resolve, reject) => {
      const path = new URL(url, location.href).pathname;
      let body = null; try { body = opt && opt.body ? JSON.parse(opt.body) : null; } catch (e) { body = null; }
      window.__st.calls.push({ path, body });
      let settled = false;
      const fail = () => { if (settled) return; settled = true; reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); };
      const ok = (payload, status) => { if (settled) return; settled = true; resolve(new Response(JSON.stringify(payload), { status: status || 200, headers: { 'content-type': 'application/json' } })); };
      if (opt && opt.signal) { if (opt.signal.aborted) return fail(); opt.signal.addEventListener('abort', fail, { once: true }); }
      const st = window.__st;
      if (st.hold === path) { st.waiters.push({ ok, fail, body }); return; }
      if (st.authFail && path !== '/api/lab/assistant/session') return ok({ error: 'no' }, 401);
      if (path === '/api/lab/assistant/session') return ok({ ok: true }, st.sessionCode || 200);
      if (path === '/api/lab/assistant/logout') return ok({ ok: true });
      if (path === '/api/lab/assistant/status') return ok(st.statusCode === 200 ? st.status : { error: 'no' }, st.statusCode);
      if (path === '/api/lab/assistant/questions') return ok(st.badQuestions ? { now: 1, questions: 'bad' } : st.questions);
      if (path === '/api/lab/assistant/reply') return ok({ question: { id: body.questionId, n: 1, question: '설치가 안 돼요', at: 1, status: 'answered', reply: body.text, repliedAt: 2, replyBy: '조교' } });
      if (path === '/api/lab/assistant/template') return ok({ message: { id: 'm-new', text: '텍스트만 전달' } });
      if (path === '/api/lab/assistant/pause') return ok({ control: { mode: 'paused', revision: 2, updatedAt: 2 } });
      return ok({ error: 'not mocked' }, 404);
    });
  });
  await page.route('https://assistant.invalid/**', (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body: LAB_ASSISTANT_HTML }));
  await page.goto('https://assistant.invalid/lab/assistant?token=' + SESSION + '#t=' + SESSION);
  await page.waitForFunction(() => window.__st.calls.some((c) => c.path === '/api/lab/assistant/status'));
}
async function login(page, scopes) {
  await page.evaluate((status) => { window.__st.statusCode = 200; window.__st.status = status; }, statusOf(scopes));
  await page.getByLabel('조교 토큰').fill(SESSION);
  await page.getByRole('button', { name: '들어가기', exact: true }).click();
  await page.getByRole('heading', { name: '저녁 수업' }).waitFor();
}
const posts = (page, path) => page.evaluate((path) => window.__calls.filter((c) => c.path === path && c.method === 'POST'), path);
const apiCalls = (page, suffix) => page.evaluate((suffix) => calls.filter((c) => c.path.endsWith(suffix)), suffix);

try {
  await test('help stays askable without an assistant and polls only while open and visible', async (page) => {
    await page.clock.install({ time: new Date('2026-10-15T09:00:00Z') });
    await page.route('https://help.invalid/**', (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body: helpHtml }));
    await page.goto('https://help.invalid/');
    await page.clock.runFor(12000);
    assert.equal(await page.evaluate(() => window.__calls.filter((c) => c.path === '/__lab/help').length), 0);
    await page.getByRole('button', { name: '도움 요청', exact: true }).click();
    await page.getByText(NO_ASSISTANT, { exact: true }).waitFor();
    await page.getByPlaceholder('비밀번호, 개인정보, 토큰은 적지 마세요.').waitFor();
    assert.equal(await page.evaluate(() => window.__calls.filter((c) => c.path === '/__lab/help').length), 1);
    await page.evaluate(() => { window.__hold = 'GET /__lab/help'; });
    await page.clock.runFor(6000);
    await page.waitForFunction(() => window.__waiters.length === 1);
    await page.clock.runFor(4000);
    assert.equal(await page.evaluate(() => window.__waiters.length), 1);
    await page.evaluate(() => { window.__hid = true; document.dispatchEvent(new Event('visibilitychange')); window.__waiters.splice(0).forEach((w) => w.ok(window.__pack)); window.__hold = ''; });
    const n = await page.evaluate(() => window.__calls.filter((c) => c.path === '/__lab/help').length);
    await page.clock.runFor(15000);
    assert.equal(await page.evaluate(() => window.__calls.filter((c) => c.path === '/__lab/help').length), n);
  });

  await test('unknown help submit keeps the same uuid until abandon', async (page) => {
    await openHelp(page);
    await page.getByRole('textbox', { name: '도움 내용' }).fill('설치 순서를 알려 주세요');
    await page.evaluate(() => { window.__hold = 'POST /__lab/help'; });
    await page.getByRole('button', { name: '도움 요청 보내기', exact: true }).click();
    await page.clock.runFor(11000);
    await page.getByRole('button', { name: '같은 도움 요청 다시 보내기', exact: true }).waitFor();
    assert.equal(await page.getByRole('textbox', { name: '도움 내용' }).isDisabled(), true);
    assert.equal(await page.evaluate(() => document.body.innerText.includes('실패')), false);
    assert.equal((await posts(page, '/__lab/help')).length, 1);
    await page.evaluate(() => { const area = document.querySelector('textarea'); area.disabled = false; area.value = '바꾼 내용'; window.__hold = ''; });
    await page.getByRole('button', { name: '같은 도움 요청 다시 보내기', exact: true }).click();
    await page.getByText('요청을 보냈습니다. 연결된 조교가 없으면 답변을 보장하지 않습니다.').waitFor();
    const sent = await posts(page, '/__lab/help');
    assert.equal(sent.length, 2);
    assert.deepEqual(sent[0].body, sent[1].body);
    assert.equal(sent[0].body.question, '설치 순서를 알려 주세요');
    assert.match(sent[0].body.requestId, /^[0-9a-f-]{36}$/);
    await page.getByRole('textbox', { name: '도움 내용' }).fill('다른 요청');
    await page.evaluate(() => { window.__hold = 'POST /__lab/help'; });
    await page.getByRole('button', { name: '도움 요청 보내기', exact: true }).click();
    await page.clock.runFor(11000);
    await page.getByRole('button', { name: '이 요청 버리기', exact: true }).click();
    assert.equal((await posts(page, '/__lab/help')).length, 3);
    assert.equal(await page.getByRole('textbox', { name: '도움 내용' }).isDisabled(), false);
  });

  await test('answered help is not auto-resolved and approved text is not executed', async (page) => {
    await openHelp(page);
    await page.evaluate(() => { window.__pack = { enabled: true, now: 1, questions: [{ id: 'q1', n: 1, question: '설치가 안 돼요', at: 1, status: 'answered', reply: '이렇게 하세요', repliedAt: 2, replyBy: '조교' }], messages: [{ id: 'm1', n: 1, at: 1, title: '안내', text: '텍스트만 <img src=x onerror=alert(1)>' }] }; });
    await page.getByRole('button', { name: '닫기', exact: true }).click();
    await page.getByRole('button', { name: '도움 요청', exact: true }).click();
    await page.getByRole('button', { name: '해결 확인', exact: true }).waitFor();
    await page.clock.runFor(15000);
    assert.equal(await page.evaluate(() => window.__calls.filter((c) => c.path === '/__lab/help/resolve').length), 0);
    assert.equal(await page.getByText('본인확인', { exact: true }).count(), 0);
    assert.equal(await page.locator('img').count(), 0);
    assert.match(await page.locator('pre').innerText(), /<img/);
    await page.evaluate(() => { navigator.clipboard.writeText = async () => { throw Error('no'); }; });
    await page.getByRole('button', { name: '요청문 복사', exact: true }).click();
    await page.getByRole('button', { name: '선택됨 · 직접 복사', exact: true }).waitFor();
    await page.getByRole('button', { name: '해결 확인', exact: true }).click();
    await page.getByText('1번 · 본인확인', { exact: true }).waitFor();
    const resolved = await page.evaluate(() => window.__calls.filter((c) => c.path === '/__lab/help/resolve'));
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0].body.questionId, 'q1');
    assert.match(resolved[0].body.requestId, /^[0-9a-f-]{36}$/);
    assert.equal(await page.getByRole('button', { name: '해결 확인', exact: true }).count(), 0);
  });

  for (const width of [390, 1280]) await test('help dialog fits ' + width, async (page) => { await openHelp(page); await fits(page); }, width);

  await test('assistant grant form shows scopes, explicit seats, and pause limits', async (page) => {
    await openAssistants(page);
    assert.equal(await page.getByLabel('표시 이름').inputValue(), 'Grok 총괄조교');
    assert.equal(await page.getByRole('checkbox', { name: '자리 상태 보기' }).isChecked(), true);
    assert.equal(await page.getByRole('checkbox', { name: '자리 상태 보기' }).isDisabled(), true);
    assert.equal(await page.getByRole('checkbox', { name: '도움 요청 보기' }).isChecked(), true);
    assert.equal(await page.getByRole('checkbox', { name: '도움 답변' }).isChecked(), true);
    assert.equal(await page.getByRole('checkbox', { name: '승인된 요청문 보내기' }).isChecked(), false);
    assert.equal(await page.getByRole('checkbox', { name: '새 전달 일시정지' }).isChecked(), false);
    assert.equal(await page.getByLabel('유효 시간(분)').inputValue(), '60');
    assert.equal(await page.getByLabel('유효 시간(분)').getAttribute('max'), '120');
    assert.equal(await page.getByRole('checkbox', { name: /1번 자리/ }).isChecked(), false);
    assert.equal(await page.getByRole('checkbox', { name: /2번 자리/ }).isDisabled(), true);
    assert.equal(await page.locator('img').count(), 0);
    await expectText(page, PAUSE_NOTE);
    await page.getByRole('checkbox', { name: '새 전달 일시정지' }).check();
    await page.getByRole('checkbox', { name: /1번 자리/ }).check();
    await page.getByRole('button', { name: '조교 권한 만들기', exact: true }).click();
    assert.equal(await page.locator('[data-form-msg]').innerText(), PAUSE_NOTE);
    assert.equal((await apiCalls(page, '/issue')).length, 0);
  });

  await test('assistant minutes are capped by lab expiry', async (page) => {
    await openAssistants(page, '?short');
    assert.equal(await page.getByLabel('유효 시간(분)').inputValue(), '20');
    assert.equal(await page.getByLabel('유효 시간(분)').getAttribute('max'), '20');
  });

  await test('one-time assistant token is masked and cleared on close and admin end', async (page) => {
    const logs = [];
    page.on('console', (msg) => logs.push(msg.text()));
    await openAssistants(page);
    await page.getByRole('checkbox', { name: /1번 자리/ }).check();
    await page.getByRole('checkbox', { name: /3번 자리/ }).check();
    await page.getByLabel('요청문 1 제목').fill('안내');
    await page.getByLabel('요청문 1 내용').fill('설치만 하세요');
    await page.getByRole('button', { name: '조교 권한 만들기', exact: true }).click();
    await page.getByLabel('일회용 토큰').waitFor();
    assert.equal(await page.getByLabel('일회용 토큰').inputValue(), TOKEN);
    assert.equal(await page.getByLabel('일회용 토큰').getAttribute('type'), 'password');
    const issued = await apiCalls(page, '/issue');
    assert.equal(issued.length, 1);
    assert.deepEqual(issued[0].body, { id: 'long', label: 'Grok 총괄조교', seats: [1, 3], scopes: ['status:read', 'help:read', 'help:reply'], minutes: 60, templates: [{ title: '안내', text: '설치만 하세요' }] });
    assert.equal(JSON.stringify(issued).includes(TOKEN), false);
    assert.equal(await leaked(page, TOKEN), false);
    await expectText(page, '/lab/assistant');
    await page.evaluate(() => ui.close());
    await page.waitForFunction(() => !document.querySelector('dialog')?.open);
    assert.equal(await tokenLeft(page, TOKEN), false);
    await page.getByRole('button', { name: '조교 권한', exact: true }).click();
    await page.getByRole('button', { name: '조교 권한 만들기', exact: true }).click();
    await page.getByLabel('일회용 토큰').waitFor();
    await page.evaluate(() => window.dispatchEvent(new Event('lab-admin-ended')));
    await page.waitForFunction(() => !document.querySelector('dialog')?.open);
    assert.equal(await tokenLeft(page, TOKEN), false);
    assert.equal(logs.some((line) => line.includes(TOKEN)), false);
  });

  await test('assistant issue timeout does not resubmit', async (page) => {
    await openAssistants(page, '?timeout=400');
    await page.getByRole('checkbox', { name: /1번 자리/ }).check();
    await page.evaluate(() => { holds['/api/lab/assistants/issue'] = true; });
    await page.getByRole('button', { name: '조교 권한 만들기', exact: true }).click();
    await page.getByText(ISSUE_UNKNOWN, { exact: true }).waitFor();
    await page.waitForTimeout(700);
    assert.equal((await apiCalls(page, '/issue')).length, 1);
    assert.equal(await page.locator('[data-token-box]').isHidden(), true);
    assert.equal(await page.locator('[data-token]').inputValue(), '');
  });

  await test('assistant issue ignores a duplicate click', async (page) => {
    await openAssistants(page);
    await page.getByRole('checkbox', { name: /1번 자리/ }).check();
    await page.evaluate(() => { holds['/api/lab/assistants/issue'] = true; });
    await page.locator('[data-issue]').click();
    await page.waitForFunction(() => calls.filter((c) => c.path.endsWith('/issue')).length === 1);
    assert.equal(await page.locator('[data-issue]').isDisabled(), true);
    await page.locator('[data-issue]').click({ force: true });
    assert.equal((await apiCalls(page, '/issue')).length, 1);
  });

  await test('assistant revoke sends the grant id', async (page) => {
    await openAssistants(page, '?revoke');
    await page.getByRole('button', { name: '권한 회수 Grok 총괄조교', exact: true }).click();
    await page.getByText(/회수됨/).waitFor();
    const sent = await apiCalls(page, '/revoke');
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].body, { id: 'long', grantId: 'g1' });
  });

  for (const width of [390, 1280]) await test('assistant dialog fits ' + width, async (page) => { await openAssistants(page); await fits(page); }, width);

  await test('assistant page 401 is quiet and session token is not stored', async (page) => {
    const logs = [];
    page.on('console', (msg) => logs.push(msg.text()));
    await assistantPage(page);
    assert.equal(await page.locator('#loginMsg').innerText(), '');
    assert.equal(await page.getByText('다시 인증해 주세요.', { exact: true }).count(), 0);
    const loc = await page.evaluate(() => location.href);
    assert.equal(loc.includes(SESSION), false, loc);
    await login(page, ['status:read', 'help:read', 'help:reply', 'template:send', 'control:pause']);
    assert.equal(await page.locator('#token').inputValue(), '');
    assert.equal(await leaked(page, SESSION), false);
    assert.equal(await page.evaluate((t) => document.body.innerText.includes(t), SESSION), false);
    assert.equal(logs.some((line) => line.includes(SESSION)), false);
  });

  await test('assistant page hides help, templates, and pause without those scopes', async (page) => {
    await assistantPage(page);
    await login(page, ['status:read']);
    assert.equal(await page.locator('#help').isHidden(), true);
    assert.equal(await page.locator('#sendBox').isHidden(), true);
    assert.equal(await page.getByRole('button', { name: '새 전달 일시정지', exact: true }).count(), 0);
    await page.clock.runFor(12000);
    assert.equal(await page.evaluate(() => window.__st.calls.filter((c) => c.path === '/api/lab/assistant/questions').length), 0);
    assert.equal(await page.getByRole('combobox', { name: '다른 수업' }).count(), 0);
  });

  await test('assistant page shows one lab, does not execute text, and confirms pause', async (page) => {
    await assistantPage(page);
    await login(page, ['status:read', 'help:read', 'help:reply', 'template:send', 'control:pause']);
    await page.getByText('설치가 안 돼요').waitFor();
    assert.equal(await page.locator('img').count(), 0);
    assert.equal(await page.getByRole('heading', { name: '저녁 수업' }).count(), 1);
    assert.equal(await page.getByRole('button', { name: '해결 확인' }).count(), 0);
    assert.equal(await page.getByRole('button', { name: '명령 전달 재개' }).count(), 0);
    assert.equal(await page.getByRole('button', { name: '지금 끝내기' }).count(), 0);
    assert.equal(await page.getByRole('button', { name: /복구/ }).count(), 0);
    const options = await page.locator('#seatPick option').allTextContents();
    assert.deepEqual(options, ['자리 선택', '1번', '3번']);
    assert.equal(await page.getByText(/숨은자리/).count(),0);
    await page.getByLabel('승인된 요청문').selectOption('t1');
    assert.match(await page.locator('#templatePreview').innerText(), /<img/);
    assert.equal(await page.locator('img').count(), 0);
    await page.getByRole('button', { name: '새 전달 일시정지', exact: true }).click();
    await page.getByRole('dialog', { name: '수업 전체 일시정지' }).waitFor();
    assert.equal(await page.evaluate(() => window.__st.calls.filter((c) => c.path === '/api/lab/assistant/pause').length), 0);
    await page.getByLabel('일시정지 이유').fill('모두 파일부터 저장');
    await page.getByRole('button', { name: '수업 전체 일시정지 확인', exact: true }).click();
    await page.getByText('새 전달을 일시정지했습니다. 이미 실행 중인 프로그램은 멈추지 않습니다.').waitFor();
    const paused = await page.evaluate(() => window.__st.calls.filter((c) => c.path === '/api/lab/assistant/pause'));
    assert.equal(paused.length, 1);
    assert.equal(paused[0].body.reason, '모두 파일부터 저장');
    assert.equal(paused[0].body.id, 'lab1');
    assert.match(paused[0].body.requestId, /^[0-9a-f-]{36}$/);
  });

  await test('unknown assistant reply retries the same uuid and does not send a second reply', async (page) => {
    await assistantPage(page);
    await login(page, ['status:read', 'help:read', 'help:reply']);
    await page.getByRole('textbox', { name: '답변 내용' }).fill('설치 순서를 확인하세요');
    await page.evaluate(() => { window.__st.hold = '/api/lab/assistant/reply'; });
    await page.getByRole('button', { name: '답변 보내기', exact: true }).click();
    await page.clock.runFor(11000);
    await page.getByRole('button', { name: '같은 답변 다시 보내기', exact: true }).waitFor();
    assert.equal(await page.getByRole('textbox', { name: '답변 내용' }).isDisabled(), true);
    assert.equal(await page.evaluate(() => window.__st.calls.filter((c) => c.path === '/api/lab/assistant/reply').length), 1);
    await page.evaluate(() => { const area = document.querySelector('textarea'); area.disabled = false; area.value = '바꾼 답변'; window.__st.hold = ''; });
    await page.getByRole('button', { name: '같은 답변 다시 보내기', exact: true }).click();
    await page.getByText('답변을 보냈습니다. 같은 질문에는 다시 답하지 않습니다.').waitFor();
    const sent = await page.evaluate(() => window.__st.calls.filter((c) => c.path === '/api/lab/assistant/reply'));
    assert.equal(sent.length, 2);
    assert.deepEqual(sent[0].body, sent[1].body);
    assert.equal(sent[0].body.text, '설치 순서를 확인하세요');
    assert.equal(sent[0].body.questionId, 'q1');
    assert.equal(await page.getByRole('button', { name: '답변 보내기', exact: true }).count(), 0);
    assert.equal(await page.getByRole('textbox', { name: '답변 내용' }).count(), 0);
  });

  await test('assistant questions do not overlap and pause while hidden', async (page) => {
    await assistantPage(page);
    await login(page, ['status:read', 'help:read']);
    await page.waitForFunction(() => window.__st.calls.filter((c) => c.path === '/api/lab/assistant/questions').length >= 1);
    await page.evaluate(() => { window.__st.hold = '/api/lab/assistant/questions'; });
    await page.clock.runFor(6000);
    await page.waitForFunction(() => window.__st.waiters.length === 1);
    await page.clock.runFor(4000);
    assert.equal(await page.evaluate(() => window.__st.waiters.length), 1);
    const n = await page.evaluate(() => window.__st.calls.filter((c) => c.path === '/api/lab/assistant/questions').length);
    await page.evaluate(() => { window.__hid = true; document.dispatchEvent(new Event('visibilitychange')); window.__st.waiters.splice(0).forEach((w) => w.ok(window.__st.questions)); window.__st.hold = ''; });
    await page.clock.runFor(15000);
    assert.equal(await page.evaluate(() => window.__st.calls.filter((c) => c.path === '/api/lab/assistant/questions').length), n);
  });

  await test('assistant auth failure clears stale seats and stops polling', async (page) => {
    await assistantPage(page);
    await login(page, ['status:read', 'help:read', 'help:reply']);
    await page.getByText(/김/).waitFor();
    assert.equal(await page.locator('img').count(), 0);
    await page.evaluate(() => { window.__st.authFail = true; });
    await page.clock.runFor(6000);
    await page.getByText('다시 인증해 주세요.', { exact: true }).waitFor();
    assert.equal(await page.locator('#app').isHidden(), true);
    assert.equal(await page.locator('#seats').innerText(), '');
    assert.equal(await page.locator('#labName').innerText(), '');
    const n = await page.evaluate(() => window.__st.calls.filter((c) => c.path === '/api/lab/assistant/questions').length);
    await page.clock.runFor(15000);
    assert.equal(await page.evaluate(() => window.__st.calls.filter((c) => c.path === '/api/lab/assistant/questions').length), n);
  });

  await test('bad assistant question payload is not treated as complete', async (page) => {
    await assistantPage(page);
    await page.evaluate(() => { window.__st.badQuestions = true; });
    await login(page, ['status:read', 'help:read']);
    await page.getByText('도움 요청 응답을 확인하지 못했습니다.', { exact: true }).waitFor();
    assert.equal(await page.getByText('본인확인', { exact: true }).count(), 0);
    assert.match(await page.locator('#actionLog').innerText(), /아직 확인된 처리가 없습니다/);
  });

  await test('reply draft and focus survive fresh status and question polls', async (page) => {
    await assistantPage(page);
    await login(page, ['status:read', 'help:read', 'help:reply']);
    const area=page.getByRole('textbox',{name:'답변 내용'});
    await area.fill('작성 중인 답변을 보존합니다');
    await area.focus();
    await area.evaluate(el=>el.setSelectionRange(3,5));
    await page.evaluate(()=>{window.__st.status.lab.seats[0].who='바뀐 상태';});
    await page.clock.runFor(6000);
    await page.locator('#seats').getByText(/바뀐 상태/).waitFor();
    assert.equal(await area.inputValue(),'작성 중인 답변을 보존합니다');
    assert.deepEqual(await area.evaluate(el=>[document.activeElement===el,el.selectionStart,el.selectionEnd]),[true,3,5]);
    assert.ok(await page.evaluate(()=>window.__st.calls.filter(c=>c.path==='/api/lab/assistant/status').length>=3));
  });

  await test('status-only assistant refreshes seats without fetching questions', async(page)=>{
    await assistantPage(page);await login(page,['status:read']);
    await page.evaluate(()=>{window.__st.status.lab.seats[0].who='새 자리 상태';});
    await page.clock.runFor(6000);
    await page.locator('#seats').getByText(/새 자리 상태/).waitFor();
    assert.equal(await page.evaluate(()=>window.__st.calls.filter(c=>c.path==='/api/lab/assistant/questions').length),0);
  });

  await test('participant auth loss clears old questions and stops polling',async(page)=>{
    await openHelp(page);
    await page.evaluate(()=>{window.__pack.questions=[{id:'old',n:1,question:'이전 질문',status:'answered',reply:'이전 답변',at:1}];window.__pack.messages=[{id:'m1',title:'이전 안내',text:'개인 안내',at:1}];});
    await page.clock.runFor(6000);
    await page.getByText('이전 질문',{exact:true}).waitFor();
    await page.evaluate(()=>{window.__authFail=true;});
    await page.clock.runFor(6000);
    await page.getByText('실습실 연결을 확인해 주세요.',{exact:true}).waitFor();
    assert.equal(await page.getByText('이전 질문',{exact:true}).count(),0);
    assert.equal(await page.getByText('이전 안내',{exact:true}).count(),0);
    assert.equal(await page.getByRole('button',{name:'도움 요청 보내기',exact:true}).isDisabled(),true);
    const n=await page.evaluate(()=>window.__calls.length);
    await page.clock.runFor(15000);
    assert.equal(await page.evaluate(()=>window.__calls.length),n);
  });

  for (const width of [390, 1280]) await test('assistant page fits ' + width, async (page) => {
    await assistantPage(page);
    await login(page, ['status:read', 'help:read', 'template:send', 'control:pause']);
    await page.getByRole('button', { name: '새 전달 일시정지', exact: true }).click();
    await page.getByRole('dialog', { name: '수업 전체 일시정지' }).waitFor();
    await fits(page);
  }, width);
} finally { await browser.close(); }

function locationHas(href, token) { return href.includes(token); }
async function leaked(page, token) {
  return page.evaluate((token) => location.href.includes(token) || JSON.stringify(localStorage).includes(token) || JSON.stringify(sessionStorage).includes(token) || document.cookie.includes(token), token);
}
async function tokenLeft(page, token) {
  return page.evaluate((token) => location.href.includes(token) || JSON.stringify(localStorage).includes(token) || JSON.stringify(sessionStorage).includes(token) || [...document.querySelectorAll('input,textarea,pre')].some((n) => ((n.value || '') + (n.textContent || '')).includes(token)), token);
}
async function expectText(page, text) { await page.getByText(text, { exact: false }).first().waitFor(); }

console.log(passed + ' ok, ' + failed.length + ' fail');
if (failed.length) { console.log(failed.join('\n')); process.exit(1); }
console.log('PASS lab assistant UI', passed);
