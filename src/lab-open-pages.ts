import { CSS } from './pages';
import { LAB_PRESETS, RES_MAX } from './lab-resources';

const STYLE = `${CSS}
main{max-width:740px;padding:24px 16px;margin:0 auto}h1{font-size:26px;margin:12px 0}h2{font-size:19px;margin:0 0 12px}h3{font-size:17px;margin:0 0 8px}p{overflow-wrap:anywhere}.mut{color:var(--mut)}a{color:var(--acc)}label{display:block;margin:12px 0 4px}textarea{box-sizing:border-box;width:100%;min-height:90px;resize:vertical;font:inherit;padding:10px;background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:8px}.row>*{flex:1 1 160px}.row button{width:auto}button:focus-visible,a:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible{outline:3px solid var(--acc);outline-offset:3px}[hidden]{display:none!important}.request{padding:18px 0;border-top:1px solid var(--line)}.status{font-weight:600}#notice:empty,#error:empty{display:none}#notice,#error{white-space:pre-wrap}.hint{font-size:13px}.request select{margin-bottom:6px}input,select,textarea{box-sizing:border-box}code{overflow-wrap:anywhere}button{min-height:44px}
#sessionCard[data-open=true]{padding:12px 16px}#sessionCard[data-open=true] h2{font-size:14px;margin:0 0 4px}#sessionCard[data-open=true] p{font-size:13px;margin:4px 0}#sessionCard[data-open=true] .row{margin:6px 0 0}#sessionCard[data-open=true] button{flex:none;width:auto;min-height:36px;padding:6px 12px}.inbox-head{display:flex;align-items:center;gap:10px;justify-content:space-between}.inbox-head h2{margin:0}.inbox-head button{width:auto;min-height:36px;font-size:13px;padding:6px 10px;flex:none}
fieldset.resource-fields{border:0;padding:0;margin:6px 0 14px;min-width:0;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}fieldset.resource-fields legend{font-size:14px;margin-bottom:4px}fieldset.resource-fields label{margin:0;font-size:13px}fieldset.resource-fields input{min-width:0;margin-bottom:0}input[aria-invalid=true]{border-color:var(--bad)}
`;
const MANAGER_STYLE = `
.manager{padding:12px 16px 40px;min-width:0;caret-color:var(--fg);scrollbar-color:var(--line) var(--bg)}
.manager ::selection{background:var(--fg);color:var(--bg)}
.manager h1{font-size:22px;line-height:1.25;margin:8px 0 4px;letter-spacing:-0.02em}
.manager h2{margin:0 0 8px}
.manager .lead{margin:0 0 8px}
.manager .lab-nav{display:flex;flex-wrap:wrap;gap:4px;margin:0 0 12px}
.manager .lab-nav a{flex:1 1 22%;min-width:0;min-height:44px;display:flex;align-items:center;justify-content:center;text-align:center;text-decoration:none;color:var(--fg);background:var(--card);border:1px solid var(--line);border-radius:10px;font-weight:600;font-size:13px;line-height:1.2;padding:6px}
.manager .lab-nav a[aria-current=page]{background:var(--acc);color:#fff;border-color:var(--acc)}
.manager a.tap{min-height:44px;display:inline-flex;align-items:center}
.manager #sessionCard[data-open=true]{display:flex;flex-wrap:wrap;align-items:center;gap:4px 12px;padding:8px 12px;margin:8px 0}
.manager #sessionCard[data-open=true] h2{margin:0;font-size:14px}
.manager #sessionCard[data-open=true] p{margin:0;flex:1 1 200px}
.manager #sessionCard[data-open=true] .row{margin:0}
.manager .inbox{margin-top:8px}
.manager .inbox-head{align-items:flex-start}
.manager .inbox-head button{min-height:44px;padding:8px 12px}
.manager .request{min-width:0}
.manager .request h3,.manager .request p,.manager .req-status,.manager .req-error,.manager #queue,.manager #listError,.manager #pushState,.manager #notice{overflow-wrap:anywhere;word-break:break-word;max-width:100%}
.manager .request h3{margin:0 0 4px}
.manager .request .meta,.manager .request .purpose{margin:0 0 6px}
.manager .req-status:empty,.manager .req-error:empty{display:none}
.manager details.reveal{margin-top:8px;min-width:0}
.manager summary{min-height:44px;padding:12px 0;cursor:pointer;font-weight:600;overflow-wrap:anywhere}
.manager summary:focus-visible{outline:3px solid var(--acc);outline-offset:3px}
.manager .detail{min-width:0;padding-top:8px}
.manager .actions{margin-top:12px}
.manager .tools{margin-top:20px}
.manager .tools details{margin-top:8px}
.manager #devices{white-space:pre-wrap;overflow-wrap:anywhere}
.manager select,.manager input{max-width:100%}
@media(max-width:560px){.manager fieldset.resource-fields{grid-template-columns:1fr}}
`;
const head = (title:string,manager=false) => `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>${manager?'<link rel="manifest" href="/__teacher/manifest.webmanifest"><meta name="theme-color" content="#0f172a"><link rel="apple-touch-icon" href="/__teacher/icon-192.png">':''}<style>${STYLE}${manager?MANAGER_STYLE:''}</style></head><body><main${manager?' class="manager"':''}>`;
const common = `
const $=id=>document.getElementById(id);
const node=(tag,text)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;return e};
const date=t=>new Date(t).toLocaleString('ko-KR');
let ADMIN=null;
async function post(action,body={},wait=15000){const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),wait);try{
 const response=await fetch(action.startsWith('/')?action:'/api/lab/open/'+action,{method:'POST',cache:'no-store',redirect:'manual',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:controller.signal});
 if(response.redirected||!response.headers.get('content-type')?.includes('application/json')){const e=new Error('로그인이 만료됐습니다. 요청함에 다시 로그인하세요.');e.status=401;throw e}const value=await response.json();if(!response.ok){const e=new Error(value.error||'응답을 확인하지 못했습니다.');e.status=response.status;throw e}return value;
 }catch(e){if(e.name==='AbortError')throw new Error('응답이 늦어 결과를 모릅니다. 같은 요청의 상태를 확인하세요.');throw e}finally{clearTimeout(timeout)}}
function notice(text,bad=false){$('notice').textContent=text;$('notice').className=bad?'bad':'mut'}
const labels={pending:'승인 대기',approving:'승인됨 · 생성 결과 확인 중',ready:'입장 링크 발급됨',denied:'승인하지 않음',expired:'종료 또는 만료'};
`;

export function labOpenParticipantPage(labOrigin:string) {
  return head('실습실 열기 요청')+`
<a href="${labOrigin}/">실습실 첫 화면</a><h1>실습실을 열어주세요</h1>
<p class="mut">혼자 복습하고 싶거나 모임에 자리가 필요할 때 요청하세요. 모임지기가 보안 키로 승인한 뒤에만 실습실이 만들어집니다.</p>
<form class="card" id="requestForm">
<label for="who">모임에서 쓰는 이름</label><input id="who" type="text" maxlength="40" autocomplete="nickname" required>
<label for="mode">어떤 실습실이 필요한가요?</label><select id="mode"><option value="practice">혼자 복습할 개인 실습실</option><option value="join">진행 중인 모임에 내 자리 추가</option></select>
<label for="purpose">해보고 싶은 작업</label><textarea id="purpose" maxlength="200" required placeholder="예: 어제 메모 두 개로 보고서 만드는 연습을 다시 하고 싶어요."></textarea>
<p class="hint mut">연락처·개인 문서·비밀번호는 쓰지 마세요. 요청은 24시간 동안 유효하며, 시간과 AI 한도는 모임지기가 승인할 때 정합니다.</p>
<button id="submit" type="submit">모임지기에게 요청하기</button></form>
<section class="card" id="result" hidden aria-labelledby="statusTitle"><h2 id="statusTitle">내 요청</h2><p class="status" id="state"></p><p id="detail"></p>
<p><a id="enter" hidden>내 실습실로 이동</a></p><div class="row"><button id="refresh" class="sec">상태 다시 확인</button><button id="retry" class="sec" hidden>같은 요청으로 접수 확인</button><button id="forget" class="sec">이 기기의 요청 기록 지우기</button></div></section>
<p id="notice" role="status" aria-live="polite"></p><p class="hint mut">확인용 비밀값은 이 브라우저에만 보관합니다. 같은 브라우저에서 다시 열면 상태를 볼 수 있습니다. 기록 지우기는 서버의 요청을 취소하거나 실행 중인 실습실을 닫지 않습니다.</p>
</main><script>${common}
const KEY='labOpenOwnRequestV1',ORIGIN=${JSON.stringify(labOrigin)};let own=null,inFlight=false;
try{const s=JSON.parse(localStorage.getItem(KEY)||'null');if(s&&typeof s.id==='string'&&typeof s.secret==='string')own=s}catch{}
const random=()=>{const a=crypto.getRandomValues(new Uint8Array(32));return btoa(String.fromCharCode(...a)).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'')};
function paint(v){$('requestForm').hidden=true;$('result').hidden=false;$('retry').hidden=true;$('state').textContent=labels[v.state]||'상태 확인 필요';$('enter').hidden=true;$('enter').removeAttribute('href');
 if(v.state==='ready'&&v.result&&/^[A-Za-z0-9_-]{16}$/.test(v.result.seatCode)){$('enter').href=ORIGIN+'/j/'+encodeURIComponent(v.result.seatCode);$('enter').hidden=false;$('detail').textContent='종료: '+date(v.result.expiresAt)+' · 접속하면 편집기 준비 상태를 확인합니다. 작업을 마치면 결과를 내려받으세요.'}
 else $('detail').textContent=v.state==='pending'?'요청이 접수됐습니다. 모임지기의 확인을 기다려 주세요.':v.state==='approving'?'모임지기가 승인했습니다. 아직 준비 결과를 확인 중입니다. 요청을 새로 보내지 마세요.':'이 요청으로 들어갈 수 있는 실습실이 없습니다.';
}
async function check(){if(!own||inFlight)return;inFlight=true;try{const v=await post('status',{id:own.id,secret:own.secret});paint(v);notice('마지막 확인: '+new Date().toLocaleTimeString('ko-KR'))}catch(e){$('result').hidden=false;$('requestForm').hidden=true;if(e.status===404)$('retry').hidden=false;notice(e.message+' 새 요청을 만들기 전에 상태를 다시 확인하세요.',true)}finally{inFlight=false}}
$('requestForm').onsubmit=async e=>{e.preventDefault();if(inFlight)return;if(!own&&(!$('who').value.trim()||!$('purpose').value.trim())){notice('이름과 해보고 싶은 작업을 적어주세요.',true);return}inFlight=true;$('submit').disabled=true;
 try{if(!own){own={id:crypto.randomUUID(),secret:random(),issuedAt:Date.now(),mode:$('mode').value,name:$('who').value.trim(),purpose:$('purpose').value.replace(/\\s+/g,' ').trim()};localStorage.setItem(KEY,JSON.stringify(own))}
 const v=await post('submit',own);paint(v);notice('요청을 보냈습니다. 이 화면에서 상태를 확인할 수 있습니다.')}
 catch(e){notice(e.message+' 같은 요청 정보로 다시 확인합니다. 기록을 지우고 연속으로 새 요청을 보내지 마세요.',true);$('result').hidden=false;$('requestForm').hidden=true;$('retry').hidden=false}
 finally{inFlight=false;$('submit').disabled=false}};
$('refresh').onclick=check;
$('retry').onclick=async()=>{if(!own||inFlight)return;inFlight=true;try{paint(await post('submit',own));notice('같은 요청 정보로 접수를 확인했습니다.')}catch(e){notice(e.message,true)}finally{inFlight=false}};
$('forget').onclick=()=>{if(inFlight)return;localStorage.removeItem(KEY);own=null;$('requestForm').hidden=false;$('result').hidden=true;notice('이 브라우저의 확인 정보를 지웠습니다. 서버의 요청과 실습실은 그대로입니다.')};
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')check()});setInterval(()=>{if(document.visibilityState==='visible')check()},10000);if(own)check();
</script></body></html>`;
}

export function labOpenManagerPage() {
 return head('개설 요청 · 모임지기',true)+`
<nav class="lab-nav" aria-label="모임지기 메뉴"><a href="/lab">모임 진행</a><a href="/lab/requests" aria-current="page">개설 요청</a><a href="/lab#prepare">모임 준비</a><a href="/lab#settings">설정</a></nav>
<h1>개설 요청</h1>
<p class="mut lead">알림이 꺼져 있어도 요청은 이 목록에 남습니다. 조건을 연 다음 보안 키로 승인합니다.</p>
<section class="card" id="sessionCard" aria-labelledby="sessionTitle"><h2 id="sessionTitle">요청함 로그인</h2><p id="session" role="status">본인 로그인을 확인하고 요청을 불러오는 중입니다.</p><div class="row"><a id="login" class="tap" href="/lab/requests" hidden>다시 로그인</a><a class="tap" href="/cdn-cgi/access/logout">요청함 로그아웃</a></div></section>
<div id="private" hidden>
<section class="card inbox" id="inbox" aria-labelledby="inboxTitle"><div class="inbox-head"><h2 id="inboxTitle">미처리 요청</h2><button class="sec" id="reload" type="button">요청 다시 확인</button></div><p id="queue" class="mut" role="status"></p><p id="listError" class="bad" role="alert" hidden></p><div id="requests"></div></section>
<section class="card tools" aria-labelledby="toolsTitle"><h2 id="toolsTitle">알림과 요청 주소</h2>
<p id="pushState" role="status" aria-live="polite">이 기기의 알림 상태를 확인하는 중입니다.</p>
<details><summary>이 기기 알림 설정</summary>
<p class="mut">모임지기 웹앱을 홈 화면에 설치한 뒤 알림을 켭니다. 목록은 본인 이메일 로그인으로 보고, 기기 등록과 개설 승인만 보안 키를 사용합니다. 알림 등록은 로그인 유효 시간과 별개입니다.</p>
<p class="hint mut">iPhone·iPad: iOS·iPadOS 16.4 이상, Safari 공유 메뉴에서 홈 화면에 추가한 뒤 설치한 앱으로 엽니다. Android: Chrome 메뉴의 앱 설치 또는 홈 화면에 추가. 참여자용 실습실 앱과는 다른 모임지기 앱입니다.</p>
<label for="deviceLabel">기기 이름</label><input id="deviceLabel" type="text" maxlength="40" value="내 휴대폰">
<div class="row"><button id="pushOn" type="button">개설 요청 알림 켜기</button><button id="pushOff" class="sec" type="button">개설 요청 알림 끄기</button></div>
<div class="row"><button id="test" class="sec" type="button" disabled data-hold="disabled">이 기기에 시험 알림 보내기</button><button id="testAck" class="sec" type="button" disabled data-hold="disabled">휴대폰에서 실제 알림을 봤어요</button></div>
<p class="hint mut">전원, 통신, 집중 모드, OS 설정에 따라 알림이 늦거나 화면에 나오지 않을 수 있습니다. 서버가 푸시를 접수한 것은 휴대폰 도착이 아닙니다. 도착 확인은 아래 버튼으로 직접 기록합니다.</p>
<p id="devices" class="hint">등록된 알림 기기를 확인하는 중입니다.</p>
</details>
<details><summary>참여자에게 줄 요청 주소</summary>
<p><a id="requestLink" href="/lab/request">실습실 열기 요청</a></p><button id="copy" class="sec" type="button">요청 주소 복사</button>
<p class="hint mut">링크는 모임지기가 직접 전달합니다. 요청자에게 관리 키나 관리자 권한을 주지 않습니다.</p>
</details></section>
</div><p id="notice" role="status" aria-live="polite"></p>
</main><script src="/webauthn.js"></script><script>(()=>{${common.replace("'/api/lab/open/'","'/api/lab/open/manager/'")}
let busy=false,registration=null,subscription=null,latest=null,pushConfig=null,listedAt=0,listStale=false,lastTest='';
const drafts=new Map(),notes=new Map(),followup=new Map(),openIds=new Set(),focusAction=new Set();
const active=()=>ADMIN&&ADMIN.expiresAt>Date.now();
const isAuthLoss=e=>!!e&&(e.status===403||['관리 세션이 만료됐습니다.','본인 계정으로 요청함에 다시 로그인하세요.','로그인이 만료됐습니다. 요청함에 다시 로그인하세요.'].indexOf(e.message)>=0);
function btn(text,className){const b=node('button',text);b.type='button';if(className)b.className=className;return b}
function setEnabled(el,enabled){if(!el)return;if(enabled){el.removeAttribute('data-hold');if(busy){el.disabled=true;el.dataset.busyLock='1'}else el.disabled=false}else{el.dataset.hold='disabled';el.disabled=true}}
function lockNew(){if(!busy)return;for(const el of document.querySelectorAll('button,input,select,textarea')){if(el.disabled)continue;el.disabled=true;el.dataset.busyLock='1'}}
function cardOf(id){if(typeof id!=='string'||!/^[0-9a-f-]{36}$/i.test(id))return null;return document.querySelector('article[data-request="'+id+'"]')}
function setReq(id,patch){const n=notes.get(id)||{status:'',error:''};if(Object.prototype.hasOwnProperty.call(patch,'status'))n.status=patch.status;if(Object.prototype.hasOwnProperty.call(patch,'error'))n.error=patch.error;notes.set(id,n);const card=cardOf(id);if(!card)return;const s=card.querySelector('.req-status'),er=card.querySelector('.req-error');if(s)s.textContent=n.status||'';if(er)er.textContent=n.error||''}
function lock(){ADMIN=null;latest=null;listStale=false;drafts.clear();notes.clear();followup.clear();openIds.clear();focusAction.clear();$('sessionCard').dataset.open='false';$('sessionTitle').textContent='요청함 로그인';$('private').hidden=true;$('requests').replaceChildren();$('devices').textContent='';$('queue').textContent='';$('listError').hidden=true;$('listError').textContent='';$('login').hidden=false;$('session').textContent='요청함 로그인이 만료됐습니다. 다시 로그인하면 보안 키 없이 목록을 확인할 수 있습니다.'}
async function run(fn){if(busy)return;busy=true;for(const el of document.querySelectorAll('button,input,select,textarea')){if(el.disabled)continue;el.disabled=true;el.dataset.busyLock='1'}try{await fn()}catch(e){if(isAuthLoss(e)){lock();notice(e.message,true)}else notice(e.message,true)}finally{busy=false;for(const el of [...document.querySelectorAll('[data-busy-lock="1"]')]){el.removeAttribute('data-busy-lock');el.disabled=el.dataset.hold==='disabled'}}}
async function sw(){if(!('serviceWorker' in navigator)||!('PushManager' in window)||!('Notification' in window))throw new Error('이 브라우저에서는 알림을 켤 수 없습니다. iPhone은 홈 화면에 설치한 앱에서 여세요.');await navigator.serviceWorker.register('/lab/teacher-sw.js',{scope:'/lab'});return await Promise.race([navigator.serviceWorker.ready,new Promise((_,r)=>setTimeout(()=>r(new Error('알림 준비가 늦습니다. 다시 열어 확인하세요.')),10000))])}
const RESOURCE_PRESETS=${JSON.stringify(LAB_PRESETS)};
const resourceText=r=>r.cpu+' CPU / 메모리 '+r.memory+' GiB / 디스크 '+r.disk+' GiB';
const modeLabel=m=>m==='practice'?'개인 복습':m==='join'?'모임 자리 추가':'요청 종류 확인 필요';
function choiceSummary(choice){if(typeof choice!=='string'||!choice)return '';try{const plan=JSON.parse(choice);const input=plan&&plan.input;if(!input||typeof input!=='object')return '';if(input.parentLabId)return '승인에 담긴 조건은 기존 모임의 사양·모델·AI 한도입니다. 이 화면에서 사양을 바꾸지 않습니다.';if(typeof input.cpu==='number'&&typeof input.memory==='number'&&typeof input.disk==='number')return '승인에 담긴 조건: '+resourceText(input)+' · '+input.hours+'시간 · AI 한도 $'+input.budget}catch(e){}return ''}
function copyChoice(picked){if(!picked||typeof picked!=='object')throw new Error('선택한 조건을 확인하지 못했습니다.');if(picked.labId!==undefined&&picked.cpu===undefined)return {labId:picked.labId};return {hours:picked.hours,budget:picked.budget,cpu:picked.cpu,memory:picked.memory,disk:picked.disk}}
function practiceChoice(detail,r,data){
 const hours=Array.isArray(data.hours)?data.hours:[],budgets=Array.isArray(data.budgets)?data.budgets:[];
 const intro=node('p','혼자 복습할 개인 실습실입니다. 사양, 사용 시간, AI 한도를 정한 뒤 보안 키로 승인합니다.');intro.className='hint mut';detail.append(intro);
 if(!hours.length||!budgets.length){detail.append(node('p','사용 시간 또는 AI 한도 목록이 없어 승인 버튼을 열지 않았습니다.'));return null}
 const spec=node('select');spec.id='spec-'+r.id;spec.setAttribute('aria-label',r.name+' 실습실 사양');
 for(const [i,p] of RESOURCE_PRESETS.entries()){const o=node('option',resourceText({cpu:p[0],memory:p[1],disk:p[2]}));o.value=String(i);spec.append(o)}
 const custom=node('option','직접 입력');custom.value='custom';spec.append(custom);
 const label=node('label','실습실 사양');label.htmlFor=spec.id;
 const fields=node('fieldset');fields.className='resource-fields';fields.hidden=true;fields.append(node('legend','직접 정할 사양'));
 const inputs={};for(const [key,text,value] of [['cpu','CPU (코어)',1],['memory','메모리 (GiB)',2],['disk','디스크 (GiB)',5]]){
  const l=node('label',text),i=node('input');i.type='number';i.min='1';i.max='${RES_MAX}';i.step='1';i.value=String(value);i.id=key+'-'+r.id;i.setAttribute('aria-label',r.name+' '+text);inputs[key]=i;l.htmlFor=i.id;l.append(i);fields.append(l)
 }
 const h=node('select'),b=node('select');h.id='hours-'+r.id;b.id='budget-'+r.id;h.setAttribute('aria-label',r.name+' 사용 시간');b.setAttribute('aria-label',r.name+' AI 한도');
 for(const hour of hours){const o=node('option',hour+'시간');o.value=hour;h.append(o)}for(const budget of budgets){const o=node('option','AI 한도 $'+budget);o.value=budget;b.append(o)}
 const hl=node('label','사용 시간'),bl=node('label','AI 사용 한도');hl.htmlFor=h.id;bl.htmlFor=b.id;
 const saved=drafts.get(r.id);if(saved){if(saved.preset)spec.value=saved.preset;if(saved.hours)h.value=saved.hours;if(saved.budget)b.value=saved.budget;for(const k of ['cpu','memory','disk'])if(saved[k]!=null)inputs[k].value=saved[k]}
 const syncCustom=()=>{const customOn=spec.value==='custom';fields.hidden=!customOn;for(const k of ['cpu','memory','disk'])setEnabled(inputs[k],customOn)};
 syncCustom();
 const remember=()=>{drafts.set(r.id,{preset:spec.value,hours:h.value,budget:b.value,cpu:inputs.cpu.value,memory:inputs.memory.value,disk:inputs.disk.value});setReq(r.id,{error:''})};
 spec.addEventListener('change',()=>{syncCustom();remember()});
 for(const field of [h,b,...Object.values(inputs)])for(const event of ['input','change'])field.addEventListener(event,remember);
 detail.append(label,spec,fields,hl,h,bl,b);
 const brief=node('p','1자리 · 사양과 사용 시간에 따라 샌드박스 비용이 발생하며, AI 한도와는 별도입니다.');brief.className='hint mut';detail.append(brief);
 return ()=>{let resources;if(spec.value==='custom'){
  resources={};for(const key of ['cpu','memory','disk']){const i=inputs[key],n=Number(i.value);const valid=/^[1-9][0-9]*$/.test(i.value)&&Number.isSafeInteger(n)&&n<=${RES_MAX};i.setAttribute('aria-invalid',String(!valid));if(!valid)throw new Error('CPU·메모리·디스크를 각각 1 이상의 정수로 입력하세요.');resources[key]=n}
 }else{const p=RESOURCE_PRESETS[Number(spec.value)];resources={cpu:p[0],memory:p[1],disk:p[2]}}
 return {hours:Number(h.value),budget:Number(b.value),cpu:resources.cpu,memory:resources.memory,disk:resources.disk}}
}
function joinChoice(detail,r,data){
 const labs=Array.isArray(data.labs)?data.labs:[];
 const note=node('p','진행 중인 모임에 자리를 추가합니다. 사양·모델·AI 한도는 그 모임을 그대로 따르며, 여기서 바꾸지 않습니다. 모임이 끝날 때 함께 종료됩니다.');note.className='hint mut';detail.append(note);
 if(!labs.length){detail.append(node('p','현재 자리를 추가할 모임이 없습니다. 모임 진행에서 모임을 먼저 열거나, 이 요청은 승인하지 않고 둘 수 있습니다.'));return null}
 const s=node('select');s.id='lab-'+r.id;s.setAttribute('aria-label',r.name+' 추가할 모임');
 for(const l of labs){const o=node('option',l.name+' · '+l.seats+'자리 · 종료 '+date(l.expiresAt)+' · AI $'+l.budget+'/자리');o.value=l.id;s.append(o)}
 const saved=drafts.get(r.id);if(saved&&saved.labId)s.value=saved.labId;
 const labLabel=node('label','추가할 모임');labLabel.htmlFor=s.id;
 const inherited=node('p');inherited.className='hint mut';
 const update=()=>{const l=labs.find(x=>x.id===s.value);inherited.textContent=(l?resourceText(l)+' · ':'')+'기존 모임과 같은 사양·모델·AI 한도를 쓰며, 여기서 사양을 바꾸지 않습니다.';drafts.set(r.id,{labId:s.value})};
 s.addEventListener('change',update);update();detail.append(labLabel,s,inherited);return ()=>({labId:s.value})
}
function bindApprove(r,choice){const approve=btn('보안 키로 승인하고 열기');approve.onclick=()=>run(async()=>{let frozen;try{frozen=copyChoice(choice())}catch(e){setReq(r.id,{status:'',error:e.message||'조건을 확인하지 못했습니다.'});return}const scope=r.name+' · '+(frozen.labId!==undefined&&frozen.cpu===undefined?'기존 모임 사양':resourceText(frozen)+' · '+frozen.hours+'시간 · AI 한도 $'+frozen.budget);setReq(r.id,{status:scope+' 조건을 보안 키로 확인합니다.',error:''});let sent=false,result;try{const o=await post('options',{id:r.id,choice:frozen});const assertion=await tapGet(o);setReq(r.id,{status:r.name+' 요청의 승인과 생성 결과를 확인하는 중입니다. 응답이 늦어도 이 요청을 다시 승인하지 않습니다.'});sent=true;result=await post('approve',{id:r.id,choice:frozen,assertion},120000)}catch(e){if(isAuthLoss(e))throw e;if(!sent||e.status===400||e.status===401){setReq(r.id,{status:'',error:e.message||'보안 키 확인 전에 이 요청을 승인하지 못했습니다.'});return}if(e.status===409||e.status===410){if(e.status===409){followup.set(r.id,'approving');openIds.add(r.id);focusAction.add(r.id)}setReq(r.id,{status:'',error:e.message||'이 요청의 승인 결과를 확인하세요.'});await refresh();return}followup.set(r.id,'unknown');openIds.add(r.id);focusAction.add(r.id);setReq(r.id,{status:'',error:(e.message||'승인 결과를 확인하지 못했습니다.')+' 이 요청은 다시 승인하지 않습니다. 같은 요청으로 생성 결과를 확인하세요.'});await refresh();return}if(!result||(result.state!=='ready'&&result.state!=='approving')){followup.set(r.id,'unknown');openIds.add(r.id);focusAction.add(r.id);setReq(r.id,{status:'',error:'승인 응답을 성공으로 처리할 수 없습니다. 같은 요청으로 생성 결과를 확인하세요.'});await refresh();return}followup.set(r.id,'approving');openIds.add(r.id);focusAction.add(r.id);setReq(r.id,{status:result.state==='ready'?'입장 링크가 발급됐습니다. 참여자가 요청 화면에서 열 수 있습니다.':'승인됐습니다. 생성 결과 확인을 눌러 같은 요청으로 이어가세요.',error:''});await refresh()});return approve}
function bindResume(r){const resume=btn('같은 요청으로 생성 결과 확인');resume.onclick=()=>run(async()=>{setReq(r.id,{status:r.name+' 요청의 생성 결과를 확인하는 중입니다.',error:''});let v;try{v=await post('resume',{id:r.id},120000)}catch(e){if(isAuthLoss(e))throw e;if(e.status===409&&String(e.message||'').indexOf('보안 키로 승인한 요청만')>=0){followup.set(r.id,'released');openIds.add(r.id);setReq(r.id,{status:'',error:'이 요청은 아직 승인되지 않았습니다. 조건을 확인한 뒤 보안 키로 승인할 수 있습니다.'});await refresh();return}if(!e.status||e.status>=500||String(e.message||'').indexOf('결과를 모릅니다')>=0){followup.set(r.id,'unknown');setReq(r.id,{status:'',error:(e.message||'결과를 확인하지 못했습니다.')+' 성공으로 처리하지 않습니다. 같은 요청으로 다시 확인하세요.'});return}setReq(r.id,{status:'',error:e.message||'이 요청의 결과를 확인하지 못했습니다.'});return}if(!v||(v.state!=='ready'&&v.state!=='approving')){followup.set(r.id,'unknown');setReq(r.id,{status:'',error:'생성 결과를 성공으로 처리할 수 없습니다. 같은 요청으로 다시 확인하세요.'});return}if(v.state==='ready'){followup.delete(r.id);setReq(r.id,{status:'입장 링크가 발급됐습니다. 참여자가 요청 화면에서 열 수 있습니다.',error:''})}else{followup.set(r.id,'approving');setReq(r.id,{status:'결과가 아직 준비 중입니다. 다른 요청 ID로 다시 만들지 마세요.',error:''})}openIds.add(r.id);await refresh()});return resume}
function bindDeny(r){const deny=btn('승인하지 않기','sec');deny.onclick=()=>run(async()=>{setReq(r.id,{status:r.name+' 요청을 승인하지 않는 중입니다.',error:''});try{await post('deny',{id:r.id})}catch(e){if(isAuthLoss(e))throw e;setReq(r.id,{status:'',error:(e.message||'거절 결과를 확인하지 못했습니다.')+' 승인하지 않음으로 처리했다고 보지 않습니다.'});return}followup.delete(r.id);drafts.delete(r.id);setReq(r.id,{status:'승인하지 않음으로 처리했습니다.',error:''});await refresh()});return deny}
function renderCard(r,data){
 const who=r.name||'요청',card=node('article');card.className='request';card.dataset.request=r.id;
 const h3=node('h3',who);h3.id='req-'+r.id;card.setAttribute('aria-labelledby',h3.id);
 const meta=node('p',modeLabel(r.mode)+' · '+(labels[r.state]||r.state||'상태 확인 필요')+' · 요청 '+date(r.createdAt));meta.className='meta';
 const purpose=node('p',r.purpose||'');purpose.className='purpose';
 const note=notes.get(r.id)||{status:'',error:''};
 const status=node('p',note.status||'');status.className='req-status';status.setAttribute('role','status');
 const error=node('p',note.error||'');error.className='req-error bad';error.setAttribute('role','alert');
 const details=node('details');details.className='reveal';const summary=node('summary','');const detail=node('div');detail.className='detail';
 const pin=followup.get(r.id)||'';const pendingOpen=r.state==='pending'&&(!pin||pin==='released');
 let openLabel=who+' 확인',closeLabel=who+' 닫기';
 if(pendingOpen){openLabel=who+' 조건 확인';closeLabel=who+' 조건 닫기'}
 else if(r.state==='approving'||pin==='unknown'||pin==='approving'){openLabel=who+' 결과 확인';closeLabel=who+' 결과 닫기'}
 if(openIds.has(r.id))details.open=true;summary.textContent=details.open?closeLabel:openLabel;
 summary.addEventListener('click',()=>{details.dataset.stick='1'});
 details.addEventListener('toggle',()=>{if(details.open)openIds.add(r.id);else openIds.delete(r.id);summary.textContent=details.open?closeLabel:openLabel;if(details.dataset.stick==='1'){details.dataset.stick='';const actions=details.querySelector('.actions');if(actions&&actions.getBoundingClientRect().bottom>innerHeight-12)actions.scrollIntoView({block:'end'})}});
 const actions=node('div');actions.className='row actions';
 if(pendingOpen){let choice=null;if(r.mode==='practice')choice=practiceChoice(detail,r,data);else if(r.mode==='join')choice=joinChoice(detail,r,data);else detail.append(node('p','요청 종류를 확인할 수 없어 승인 버튼을 열지 않았습니다.'));if(choice)actions.append(bindApprove(r,choice));actions.append(bindDeny(r));detail.append(actions);if(r.mode==='practice'){const hint=node('p','처음 쓰는 사양은 준비에 시간이 걸릴 수 있습니다. Daytona 기본 1개당 상한은 4 vCPU · 메모리 8 GiB · 디스크 10 GiB이며 조직 전체 한도와 별개입니다. 상향 승인된 계정은 해당 한도를 따릅니다.');hint.className='hint mut';detail.append(hint)}}
 else if(r.state==='approving'||pin==='unknown'||pin==='approving'){const line=choiceSummary(r.choice);if(line)detail.append(node('p',line));detail.append(node('p','이 요청 ID의 생성 결과만 확인합니다. 새 승인이나 다른 요청으로 다시 만들지 않습니다.'));actions.append(bindResume(r));detail.append(actions)}
 else if(r.state==='ready'&&r.result)detail.append(node('p','자리 '+r.result.n+' · 종료 '+date(r.result.expiresAt)));
 else if(r.state==='denied')detail.append(node('p','이 요청은 승인하지 않음으로 남아 있습니다. 참여자 화면에는 들어갈 실습실이 없습니다.'));
 else if(r.state==='expired')detail.append(node('p','이 요청은 종료되었거나 만료됐습니다.'));
 else detail.append(node('p','이 요청의 상태를 목록에서 다시 확인하세요.'));
 details.append(summary,detail);card.append(h3,meta,purpose,status,error,details);
 if(details.open&&focusAction.has(r.id)){focusAction.delete(r.id);requestAnimationFrame(()=>{const target=details.querySelector('.actions')||details;if(target.getBoundingClientRect().bottom>innerHeight-12)target.scrollIntoView({block:'end'})})}
 return card
}
function render(data){
 latest=data;const requests=data.requests;const pendingIds=new Set(requests.filter(r=>r.state==='pending').map(r=>r.id));
 for(const id of drafts.keys())if(!pendingIds.has(id))drafts.delete(id);
 const seen=new Set(requests.map(r=>r.id));for(const id of openIds)if(!seen.has(id))openIds.delete(id);for(const id of notes.keys())if(!seen.has(id))notes.delete(id);
 for(const r of requests){if(r.state==='ready'){followup.delete(r.id);notes.set(r.id,{status:'입장 링크가 발급됐습니다. 참여자가 요청 화면에서 열 수 있습니다.',error:''})}else if(r.state==='denied'){followup.delete(r.id);notes.set(r.id,{status:'승인하지 않음으로 처리했습니다.',error:''})}else if(r.state==='expired'){followup.delete(r.id);notes.set(r.id,{status:'이 요청은 종료되었거나 만료됐습니다.',error:''})}}
 const primary=requests.filter(r=>r.state==='pending'||r.state==='approving'),history=requests.filter(r=>r.state!=='pending'&&r.state!=='approving');
 let q='미처리 '+primary.length+'건 · 마지막 확인 '+new Date(listedAt).toLocaleTimeString('ko-KR');
 if(data.truncated)q+=' · 승인 대기 우선, 최대 128건 표시 / 보관 '+data.total+'건';if(listStale)q+=' · 최신 상태를 확인하지 못했습니다';$('queue').textContent=q;
 const box=$('requests');box.replaceChildren();
 if(!requests.length){box.append(node('p','미처리 요청이 없습니다. 참여자에게 줄 요청 주소는 아래 알림과 요청 주소에 있습니다.'));lockNew();return}
 if(!primary.length)box.append(node('p','미처리 요청이 없습니다.'));
 for(const r of primary)box.append(renderCard(r,data));
 if(history.length){const d=node('details');d.className='reveal';if(history.some(r=>openIds.has(r.id)))d.open=true;d.append(node('summary','처리한 요청 '+history.length+'건'));for(const r of history)d.append(renderCard(r,data));box.append(d)}
 lockNew()
}
async function refresh(){
 if(!active()){lock();return}
 const inbox=$('inbox');if(inbox)inbox.setAttribute('aria-busy','true');
 try{
  const data=await post('list');if(!active())return;
  if(!data||!Array.isArray(data.requests))throw Object.assign(new Error('요청 목록 응답을 확인하지 못했습니다.'),{status:0});
  listedAt=Date.now();listStale=false;$('listError').hidden=true;$('listError').textContent='';render(data);
 }catch(e){
  if(isAuthLoss(e))throw e;
  listStale=true;$('listError').hidden=false;$('listError').textContent=(e.message||'요청 목록을 확인하지 못했습니다.')+' 아래는 마지막에 확인한 목록입니다.';
  if(!latest)$('requests').replaceChildren(node('p','요청 목록을 아직 불러오지 못했습니다.'));
  const q=$('queue');if(q.textContent.indexOf('최신 상태를 확인하지 못했습니다')<0)q.textContent=(q.textContent||'요청 목록')+' · 최신 상태를 확인하지 못했습니다';
 }finally{if(inbox)inbox.setAttribute('aria-busy','false')}
}
function finishPush(text,bad){if(lastTest)text+=String.fromCharCode(10)+lastTest;$('pushState').textContent=text;$('pushState').className=(bad||(lastTest&&lastTest.indexOf('직접 확인')<0))?'bad':'mut'}
async function pushState(){
 try{
  pushConfig=await post('push/config');
  if(!pushConfig||pushConfig.available!==true){setEnabled($('pushOn'),false);setEnabled($('test'),false);setEnabled($('testAck'),false);$('devices').textContent='서버 알림 설정이 없어 기기 목록을 묻지 않았습니다.';finishPush('서버의 개설 요청 알림 설정이 준비되지 않았습니다. 요청은 이 목록에서 확인합니다.',true);return}
  setEnabled($('pushOn'),true);
  let devices=null;
  try{const d=await post('push/devices');devices=Array.isArray(d.devices)?d.devices:[]}catch(e){if(isAuthLoss(e))throw e;$('devices').textContent=e.message||'등록된 기기를 확인하지 못했습니다.'}
  if(devices)$('devices').textContent=devices.map(x=>x.label+' · '+(x.lastOutcome==='accepted'?'푸시 서비스 접수':x.lastOutcome||'전송 기록 없음')+(x.lastAttemptAt?' · '+date(x.lastAttemptAt):'')).join(String.fromCharCode(10))||'등록된 기기 없음';
  const trouble=(devices||[]).filter(x=>x.lastOutcome&&x.lastOutcome!=='accepted').map(x=>x.label+' · '+x.lastOutcome);
  registration=await sw();subscription=await registration.pushManager.getSubscription();
  if(!subscription){setEnabled($('test'),false);setEnabled($('testAck'),false);setEnabled($('pushOff'),true);finishPush('이 기기는 개설 요청 알림이 꺼져 있습니다. 요청은 이 목록에 남습니다.'+(trouble.length?String.fromCharCode(10)+'최근 전송 결과: '+trouble.join(', '):''),false);return}
  const s=await post('push/status',{endpoint:subscription.endpoint});
  setEnabled($('test'),true);setEnabled($('testAck'),s.enabled===true);setEnabled($('pushOff'),true);
  let text=s.enabled?(s.testAcknowledgedAt?'이 기기에 알림을 등록했고, '+date(s.testAcknowledgedAt)+'에 시험 알림을 직접 확인했습니다. 다음 알림도 기기에서 직접 확인합니다.':'이 기기에 알림을 등록했습니다. 시험 알림이 휴대폰에 보이는지는 직접 확인합니다.'):'개설 요청 알림이 꺼져 있거나 다시 등록해야 합니다. 요청은 이 목록에 남습니다.';
  if(trouble.length)text+=' 최근 전송 결과: '+trouble.join(', ');
  finishPush(text,false);
 }catch(e){if(isAuthLoss(e)){lock();notice(e.message,true);return}finishPush(e.message||'알림 상태를 확인하지 못했습니다. 요청 목록은 그대로입니다.',true)}
}
function runPush(fn){return run(async()=>{try{await fn()}catch(e){if(isAuthLoss(e))throw e;finishPush(e.message||'알림 설정을 확인하지 못했습니다.',true)}})}
async function start(){
 ADMIN=await post('session');if(!active()){lock();return}
 $('sessionCard').dataset.open='true';$('private').hidden=false;$('login').hidden=true;
 $('sessionTitle').textContent=ADMIN.email||'요청함 로그인';
 $('session').textContent='로그인 유효 '+date(ADMIN.expiresAt)+' · 목록은 로그인으로 확인하고, 개설 승인만 보안 키를 사용합니다.';
 $('queue').textContent='요청을 불러오는 중입니다.';
 await refresh();await pushState();
}
$('reload').onclick=()=>run(async()=>{await refresh();await pushState()});
$('pushOn').onclick=()=>{if(busy||!active())return;if(!pushConfig||pushConfig.available!==true){finishPush('서버 알림 설정을 먼저 확인해야 합니다. 요청 목록은 계속 사용할 수 있습니다.',true);return}let permission;try{permission=Notification.requestPermission()}catch{finishPush('이 브라우저의 설치·알림 지원 상태를 확인하세요.',true);return}runPush(async()=>{if(await permission!=='granted')throw new Error('알림이 허용되지 않았습니다. 휴대폰의 이 앱 알림 설정을 확인하세요.');registration=await sw();subscription=await registration.pushManager.getSubscription();if(!subscription)subscription=await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:u2b(pushConfig.applicationServerKey)});const device={subscription:subscription.toJSON(),label:$('deviceLabel').value};const o=await post('push/options',device);const assertion=await tapGet(o);await post('push/subscribe',{...device,assertion});await pushState()})};
$('pushOff').onclick=()=>runPush(async()=>{registration=await sw();subscription=await registration.pushManager.getSubscription();if(subscription)await post('push/unsubscribe',{endpoint:subscription.endpoint});subscription=null;await pushState();$('pushState').textContent=$('pushState').textContent+' 손들기 알림 설정은 별도입니다.'});
$('test').onclick=()=>runPush(async()=>{registration=await sw();subscription=await registration.pushManager.getSubscription();if(!subscription)throw new Error('먼저 개설 요청 알림을 켜주세요.');const r=await post('push/test',{endpoint:subscription.endpoint},30000);lastTest=r&&r.outcome==='accepted'?'시험 알림 처리: 푸시 서비스가 접수했습니다. 휴대폰 표시 여부는 직접 확인하세요.':'시험 알림 처리: '+((r&&r.outcome)||'결과를 확인하지 못했습니다.');await pushState()});
$('testAck').onclick=()=>runPush(async()=>{if(!subscription)throw new Error('알림 등록 후 시험 알림부터 보내주세요.');await post('push/ack',{endpoint:subscription.endpoint});lastTest='';await pushState()});
$('copy').onclick=()=>run(async()=>{const url=location.origin+'/lab/request';try{await navigator.clipboard.writeText(url);notice('요청 주소를 복사했습니다. 참여자에게 직접 전달하세요.')}catch{notice('복사하지 못했습니다. 아래 주소를 직접 복사하세요.'+String.fromCharCode(10)+url)}});
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'&&active()&&!busy)run(async()=>{await refresh();await pushState()})});
setInterval(()=>{if(ADMIN&&!active())lock();else if(active()&&!busy&&document.visibilityState==='visible'&&!$('requests').contains(document.activeElement))run(refresh)},15000);
if('serviceWorker' in navigator)navigator.serviceWorker.register('/lab/teacher-sw.js',{scope:'/lab'}).catch(()=>{});
run(start);
})();</script></body></html>`;
}
