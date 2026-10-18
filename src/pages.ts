// HTML 페이지. 외부 스크립트 없음 — 인증 페이지에 CDN 코드를 싣지 않는다.
// 동적 값은 전부 textContent 로 넣는다 (UA 같은 건 요청자가 조작할 수 있다).

import { LAB_RENDERER_JS } from '#lab-renderer';
import { LAB_TERMINAL_JS } from '#lab-terminal';
import { LAB_CONTROL_JS } from '#lab-control';
import { LAB_TRIAL_JS } from '#lab-trial';
import { LAB_INTERRUPT_JS } from '#lab-interrupt';
import { LAB_CHECKPOINT_JS } from '#lab-checkpoints';
import { LAB_RECOVERY_JS } from '#lab-recovery';
import { LAB_ASSISTANTS_JS } from '#lab-assistants';
import { LAB_LIVE_TEACHER_JS } from '#lab-live';
import { LAB_CLASSROOM_TEACHER_JS } from '#lab-classroom-teacher';
import { LAB_SEAT_ADD_JS } from '#lab-seat-add-ui';
import { LAB_REQUEST_PREVIEWS_JS } from '#lab-request-previews';
import { LAB_BROADCAST_PREVIEW_JS } from '#lab-broadcast-preview';
import { LAB_DEMO_BROADCAST_JS } from '#lab-demo-broadcast';
import { LAB_DEMO_WORKSPACE_JS } from '#lab-demo-workspace';
import { LAB_COMMAND_CENTER_CSS } from '#lab-command-center';
import { LAB_DEMO_EDITOR_JS } from '#lab-demo-editor';

export const CSS = `
:root{--bg:#f7f7f5;--fg:#1c1c1a;--mut:#6b6b66;--card:#fff;--line:#e3e3de;--acc:#2f5bea;--ok:#1f8a4c;--bad:#c23b2e;--code:#f0f0ec}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#141413;--fg:#ecebe6;--mut:#9a9993;--card:#1d1d1b;--line:#2e2e2b;--acc:#7c9bff;--ok:#4cc27e;--bad:#ff7a6b;--code:#262624}}
:root[data-theme=dark]{--bg:#141413;--fg:#ecebe6;--mut:#9a9993;--card:#1d1d1b;--line:#2e2e2b;--acc:#7c9bff;--ok:#4cc27e;--bad:#ff7a6b;--code:#262624}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI","Apple SD Gothic Neo","Malgun Gothic",sans-serif}
main{max-width:560px;margin:0 auto;padding:24px 16px 48px}h1{font-size:20px;margin:0 0 4px}p{margin:8px 0}.mut{color:var(--mut);font-size:14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin:16px 0}
.code{font:600 34px/1.2 ui-monospace,Consolas,monospace;letter-spacing:.18em;text-align:center;margin:8px 0}
.qr{background:#fff;border-radius:8px;padding:12px;width:min(260px,100%);margin:8px auto;display:block}.qr svg{width:100%;height:auto;display:block}
button{font:inherit;font-weight:600;border:0;border-radius:10px;padding:12px 16px;background:var(--acc);color:#fff;cursor:pointer;width:100%}
button.sec{background:transparent;color:var(--fg);border:1px solid var(--line)}button.bad{background:var(--bad);color:#fff}button:disabled{opacity:.5;cursor:default}
.row{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0}.row label{flex:1 1 auto;border:1px solid var(--line);border-radius:10px;padding:10px;display:flex;gap:8px;align-items:center}
pre{background:var(--code);border-radius:8px;padding:12px;overflow-x:auto;white-space:pre-wrap;word-break:break-all;font:13px/1.5 ui-monospace,Consolas,monospace;margin:8px 0}
.ok{color:var(--ok)}.bad{color:var(--bad)}dl{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;margin:0;font-size:14px}dt{color:var(--mut)}dd{margin:0;word-break:break-all}
input[type=text],input[type=password],input[type=number],select{font:inherit;width:100%;padding:10px;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--fg);margin:4px 0 8px}
table{width:100%;border-collapse:collapse;font-size:13px}td,th{border-bottom:1px solid var(--line);padding:6px 4px;text-align:left;vertical-align:top}
`;

// base64url ↔ ArrayBuffer 와 WebAuthn JSON 직렬화. @simplewebauthn/browser 가 하는 일의 최소판.
export const WEBAUTHN_JS = `
const b2u=b=>{let s='';for(const x of new Uint8Array(b))s+=String.fromCharCode(x);return btoa(s).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'')};
const u2b=s=>{s=s.replace(/-/g,'+').replace(/_/g,'/');while(s.length%4)s+='=';return Uint8Array.from(atob(s),c=>c.charCodeAt(0))};
async function tapGet(o){const c=await navigator.credentials.get({publicKey:{...o,challenge:u2b(o.challenge),allowCredentials:(o.allowCredentials||[]).map(x=>({...x,id:u2b(x.id)}))}});
 return{id:c.id,rawId:b2u(c.rawId),type:c.type,response:{clientDataJSON:b2u(c.response.clientDataJSON),authenticatorData:b2u(c.response.authenticatorData),signature:b2u(c.response.signature),userHandle:c.response.userHandle?b2u(c.response.userHandle):undefined},clientExtensionResults:c.getClientExtensionResults(),authenticatorAttachment:c.authenticatorAttachment||undefined}}
async function tapCreate(o){const c=await navigator.credentials.create({publicKey:{...o,challenge:u2b(o.challenge),user:{...o.user,id:u2b(o.user.id)},excludeCredentials:(o.excludeCredentials||[]).map(x=>({...x,id:u2b(x.id)}))}});
 return{id:c.id,rawId:b2u(c.rawId),type:c.type,response:{clientDataJSON:b2u(c.response.clientDataJSON),attestationObject:b2u(c.response.attestationObject),transports:c.response.getTransports?c.response.getTransports():[]},clientExtensionResults:c.getClientExtensionResults(),authenticatorAttachment:c.authenticatorAttachment||undefined}}
async function api(path,body,headers={}){const r=await fetch(path,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)});
 const j=await r.json().catch(()=>({error:'HTTP '+r.status}));if(!r.ok)throw Object.assign(new Error(j.error||('HTTP '+r.status)),{status:r.status,code:typeof j.code==='string'?j.code:undefined});return j}
const $=id=>document.getElementById(id);
// 빌린 PC 공개키의 지문. PC 와 폰이 각자 계산해 같은지 본다 — 서버가 공개키를 바꿔치기하면 코드가 달라진다.
async function fpCode(pub){const h=new Uint8Array(await crypto.subtle.digest('SHA-256',u2b(pub)));const A='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';let s='';for(let i=0;i<6;i++)s+=A[h[i]%32];return s}
async function sendKey(shared,pub,usage){const hk=await crypto.subtle.importKey('raw',shared,'HKDF',false,['deriveKey']);
 return crypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt:u2b(pub),info:new TextEncoder().encode('shinick-send-v1')},hk,{name:'AES-GCM',length:256},false,[usage])}
const fmt=t=>new Date(t).toLocaleString('ko-KR',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
// 금고 복구 코드: 서버가 한 번만 내주는 값. 화면에만 띄우고 어디에도 저장하지 않는다 (확인을 누르면 지운다)
function showRc(code){if(!code)return;const old=document.getElementById('rcBox');if(old)old.remove();
 const c=document.createElement('div');c.className='card';c.id='rcBox';const t=document.createElement('p');t.innerHTML='<b>금고 복구 코드</b> — 지금 한 번만 보입니다. 종이에 적어 보안 키와 다른 곳에 두세요.';
 const k=document.createElement('div');k.className='code';k.style.fontSize='20px';k.style.letterSpacing='.08em';k.style.wordBreak='break-all';k.textContent=code;
 const m=document.createElement('p');m.className='mut';m.textContent='보안 키를 둘 다 잃어버렸을 때 이 코드와 복구 질문 답이 함께 있어야 금고를 열 수 있습니다. 복구에 성공하면 새 코드가 나오고 이 코드는 무효가 됩니다.';
 const cp=document.createElement('button');cp.className='sec';cp.id='rcCopy';cp.textContent='복사';cp.onclick=async()=>{try{await navigator.clipboard.writeText(code);cp.textContent='복사됨'}catch{cp.textContent='복사 안 됨 — 직접 적으세요'}};
 const b=document.createElement('button');b.textContent='적어 뒀습니다 — 화면에서 지우기';b.onclick=()=>{k.textContent='';c.remove()};
 c.append(t,k,m,cp,b);document.querySelector('main').prepend(c)}
`;

// 실습실 호스트 페이지는 PWA (src/labhost.ts 의 manifest). 설치는 입장 호스트의 런처(/·/j/)에서만 권한다 —
// 자리 호스트 화면·끝 화면은 아이콘·색만 싣고 manifest 를 광고하지 않는다 (labPwa=false)
const LAB_ICON = '<meta name="theme-color" content="#0f172a"><link rel="icon" href="/__lab/icon-192.png"><link rel="apple-touch-icon" href="/__lab/icon-192.png">';
const LAB_HEAD = '<link rel="manifest" href="/__lab/manifest.webmanifest">' + LAB_ICON;
// 강사 /lab 설치 앱 (k.shinick.dev, 참가자 런처와 별개). 경로를 주는 쪽은 src/lab-teacher-app.ts — 여기는 node 테스트가 바로 불러서 상대 import 를 두지 않는다
export const TEACHER_SCOPE = '/lab', TEACHER_SW = '/lab/teacher-sw.js', TEACHER_MANIFEST = '/__teacher/manifest.webmanifest';
const TEACHER_HEAD = `<link rel="manifest" href="${TEACHER_MANIFEST}"><meta name="theme-color" content="#0f172a"><link rel="icon" href="/__teacher/icon-192.png"><link rel="apple-touch-icon" href="/__teacher/icon-192.png">`;
function page(title: string, body: string, script: string, src = '/webauthn.js', labPwa = true, head = '') {
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${title}</title><style>${CSS}</style>${src === '/__lab/app.js' ? (labPwa ? LAB_HEAD : LAB_ICON) : ''}${head}</head>
<body><main>${body}</main><script src="${src}"></script><script>${script}</script></body></html>`;
}
// 서버 값을 인라인 스크립트에 넣을 때 (</script> 로 빠져나가지 못하게)
const js = (v: unknown) => JSON.stringify(v).replace(/</g, '\\u003c');

export const borrowPage = () => page('키 빌리기', `
<h1>이 PC 에서 API 키 쓰기</h1>
<p class="mut">폰으로 QR 을 찍고 보안 키를 태깅하면, 이 창에 임시 토큰이 나타납니다. 진짜 키는 이 PC 로 오지 않습니다.</p>
<p class="mut">사이트 로그인 정보가 필요하면 <a href="/recv">금고에서 받기</a> · 자동 로그인은 PowerShell 에서 <code>irm https://k.shinick.dev/go | iex</code></p>
<div class="card" id="wait">
  <p class="mut" style="text-align:center">폰 화면의 코드와 같은지 확인하세요</p>
  <div class="code" id="code">······</div>
  <div class="qr" id="qr"></div>
  <p class="mut" style="text-align:center"><a id="link" href="#">QR 대신 링크</a> · <span id="left"></span></p>
  <p id="st" class="mut" style="text-align:center">승인 대기 중…</p>
</div>
<div id="done" hidden>
  <div class="card"><p class="ok"><b>승인됨</b> · <span id="exp"></span> 까지 · <span id="scope"></span></p>
  <p class="mut">PowerShell (이 창을 닫으면 사라지는 프로세스 한정 설정)</p><pre id="ps"></pre><button class="sec" data-copy="ps">복사</button>
  <p class="mut">bash / zsh</p><pre id="sh"></pre><button class="sec" data-copy="sh">복사</button>
  <div id="claude" hidden><p class="mut">Claude Code 를 OpenRouter 로 쓰려면 (PowerShell)</p><pre id="cps"></pre><button class="sec" data-copy="cps">복사</button></div>
  </div>
  <button class="bad" id="end">다 썼어요 — 지금 토큰 폐기</button>
  <p class="mut">안 눌러도 만료 시각에 자동 폐기됩니다. 폰의 /admin 에서도 끊을 수 있습니다.</p>
</div>
<p id="err" class="bad"></p>`, `
let token=null;
document.addEventListener('click',e=>{const k=e.target.dataset&&e.target.dataset.copy;if(k){navigator.clipboard.writeText($(k).textContent);e.target.textContent='복사됨'}});
(async()=>{try{
 const d=await api('/api/borrow',{});
 $('code').textContent=d.code;$('qr').innerHTML=d.qr;$('link').href=d.approveUrl;
 const tick=setInterval(()=>{const s=Math.max(0,Math.round((d.expiresAt-Date.now())/1000));$('left').textContent=Math.floor(s/60)+'분 '+(s%60)+'초 남음'},1000);
 while(true){await new Promise(r=>setTimeout(r,2000));
  const p=await api('/api/borrow/'+d.id+'/poll',{secret:d.secret});
  if(p.status==='approved'){clearInterval(tick);token=p.token;$('wait').hidden=true;$('done').hidden=false;
   $('exp').textContent=fmt(p.expiresAt);$('scope').textContent=p.providers.join(', ')+(p.budget?' · OpenRouter $'+p.budget:'')+(p.limits?' · 상한 총 '+p.limits.total+'회 · 분당 '+p.limits.perMinute+' · 동시 '+p.limits.concurrent:'')+(p.manage&&p.manage.length?' · ⚠ Daytona 관리 API 허용 ('+p.manage.join(', ')+')':'');
   $('ps').textContent=p.env.powershell;$('sh').textContent=p.env.bash;
   if(p.env.claudePowershell){$('claude').hidden=false;$('cps').textContent=p.env.claudePowershell}
   history.replaceState(null,'','/borrow');return}
  if(p.status==='denied'){$('st').textContent='거절됨';$('st').className='bad';clearInterval(tick);return}
  if(p.status==='expired'){$('st').textContent='만료됨 — 새로고침하세요';$('st').className='bad';clearInterval(tick);return}
 }}catch(e){$('err').textContent=e.message}})();
$('end').onclick=async()=>{try{await api('/api/end',{},{authorization:'Bearer '+token});$('done').innerHTML='<div class="card ok"><b>폐기됨.</b> 이 PC 의 토큰은 더 이상 동작하지 않습니다.</div>'}catch(e){$('err').textContent=e.message}};
`);

export const approvePage = (id: string) => page('승인', `
<h1 id="title">API 키 사용 승인</h1>
<p class="mut" id="lead">빌린 PC 화면의 코드와 <b>같을 때만</b> 승인하세요.</p>
<div class="card" id="adminWarn" hidden><p class="bad"><b>관리 권한 요청입니다.</b></p>
<p class="mut">PC 의 kv.ps1 이 공급자 키를 올리거나 바꾸려고 합니다. <b>방금 직접 실행한 게 아니면 거절하세요.</b> 승인하면 그 PC 에 8시간 관리 권한이 넘어갑니다.</p></div>
<div class="card"><div class="code" id="code">······</div>
<dl><dt>요청 위치</dt><dd id="where"></dd><dt>IP</dt><dd id="ip"></dd><dt>브라우저</dt><dd id="ua"></dd><dt>요청 시각</dt><dd id="at"></dd></dl></div>
<div class="card" id="form">
  <div id="borrowOpts">
  <p><b>허용할 공급자</b></p><div class="row" id="prov"></div>
  <p><b>유효 시간</b></p><div class="row" id="ttl"></div>
  <div id="budgetBox"><p><b>OpenRouter 한도</b></p><div class="row" id="budget"></div></div>
  <div id="mgBox" hidden><div class="row"><label><input type="checkbox" id="manage"> Daytona 조직·계정 관리 API 도 허용</label></div>
  <p class="bad" style="font-size:14px">기본은 꺼짐 — 샌드박스·스냅샷 같은 일반 호출만 됩니다. 켜면 이 PC 가 조직 멤버·역할·한도·감사 로그·웹훅, API 키 발급·삭제, 계정 API 를 부를 수 있습니다. <b>정말 필요할 때만</b> 켜세요.</p></div>
  <p><b>호출 상한</b> <span class="mut">(낮출 수만 있음)</span></p>
  <label class="mut">총 호출 수 (최대 <span id="mxT"></span>)</label><input type="number" id="limT" min="1" step="1" inputmode="numeric">
  <label class="mut">1분당 호출 수 (최대 <span id="mxR"></span>)</label><input type="number" id="limR" min="1" step="1" inputmode="numeric">
  <label class="mut">동시 호출 수 (최대 <span id="mxC"></span>)</label><input type="number" id="limC" min="1" step="1" inputmode="numeric">
  </div>
  <button id="ok">보안 키로 승인</button>
  <p class="mut" style="text-align:center">버튼을 누른 뒤 NFC 키를 폰 뒷면에 대세요 (PC 라면 키를 터치)</p>
  <button class="sec" id="no">거절</button>
</div>
<p id="msg"></p>`, `
const id=${JSON.stringify(id)};
let KIND='borrow';const MINT=new Set(),DT=new Set();let LMAX={total:10000,perMinute:300,concurrent:10};
const radio=(box,name,vals,fmtv,def)=>{for(const v of vals){const l=document.createElement('label');const i=document.createElement('input');i.type='radio';i.name=name;i.value=v;i.checked=v===def;l.append(i,document.createTextNode(fmtv(v)));$(box).append(l)}};
const val=n=>Number(document.querySelector('input[name='+n+']:checked').value);
const done=(t,cls)=>{$('form').hidden=true;$('msg').textContent=t;$('msg').className=cls};
(async()=>{try{const d=await api('/api/approve/'+id);KIND=d.kind;
 if(KIND==='send'){location.replace('/vault#send='+id);return}
 $('code').textContent=d.code;$('where').textContent=[d.city,d.country].filter(Boolean).join(', ')||'알 수 없음';
 $('ip').textContent=d.ip;$('ua').textContent=d.ua;$('at').textContent=fmt(d.createdAt);
 if(d.status!=='pending'){done('이미 처리된 요청입니다 ('+d.status+')','mut');return}
 if(KIND==='admin'){$('title').textContent='관리 권한 승인';$('lead').textContent='PC 터미널에 표시된 코드와 같을 때만 승인하세요.';$('adminWarn').hidden=false;$('borrowOpts').hidden=true;$('ok').textContent='보안 키로 관리 권한 승인';return}
 if(!d.providers.length){done('등록된 공급자가 없습니다. /admin 이나 kv.ps1 push 로 먼저 추가하세요.','bad');return}
 if(d.limitMax)LMAX=d.limitMax;for(const [k,i] of [['total','T'],['perMinute','R'],['concurrent','C']]){$('lim'+i).max=LMAX[k];$('lim'+i).value=LMAX[k];$('mx'+i).textContent=LMAX[k]}
 for(const p of d.providers){if(p.kind==='openrouter-mint')MINT.add(p.id);if(p.daytona)DT.add(p.id);const l=document.createElement('label');const i=document.createElement('input');i.type='checkbox';i.value=p.id;i.checked=true;i.onchange=sync;l.append(i,document.createTextNode(p.label));$('prov').append(l)}
 radio('ttl','ttl',d.ttlChoices,v=>v+'시간',3);radio('budget','budget',d.budgetChoices,v=>'$'+v,5);sync();
}catch(e){done(e.message,'bad')}})();
function picked(){return[...document.querySelectorAll('#prov input:checked')].map(i=>i.value)}
function sync(){$('budgetBox').hidden=!picked().some(p=>MINT.has(p));const dt=picked().some(p=>DT.has(p));$('mgBox').hidden=!dt;if(!dt)$('manage').checked=false}
function lim(i,k){const v=$('lim'+i).value.trim();if(!/^\\d+$/.test(v)||Number(v)<1||Number(v)>LMAX[k])throw new Error('호출 상한은 1~'+LMAX[k]+' 정수로');return Number(v)}
$('ok').onclick=async()=>{const b=$('ok');b.disabled=true;$('msg').textContent='';try{
 if(KIND==='borrow'&&!picked().length)throw new Error('공급자를 하나 이상 고르세요');
 const limits=KIND==='admin'?null:{total:lim('T','total'),perMinute:lim('R','perMinute'),concurrent:lim('C','concurrent')};
 const opts=await api('/api/approve/'+id+'/options',{});
 const assertion=await tapGet(opts);
 const choice=KIND==='admin'?{}:{providers:picked(),ttlHours:val('ttl'),budget:val('budget'),limits,...(picked().some(p=>DT.has(p))?{manage:$('manage').checked}:{})};
 await api('/api/approve/'+id,{assertion,choice});
 done(KIND==='admin'?'승인했습니다. 터미널로 돌아가세요.':'승인했습니다. 빌린 PC 화면에 토큰이 나타납니다.','ok');
}catch(e){$('msg').textContent=e.name==='NotAllowedError'?'취소됐거나 시간이 지났습니다.':e.message;$('msg').className='bad';b.disabled=false}};
$('no').onclick=async()=>{try{await api('/api/approve/'+id+'/deny',{});done('거절했습니다.','mut')}catch(e){$('msg').textContent=e.message}};
`);

export const registerPage = () => page('보안 키 등록', `
<h1>보안 키 등록</h1>
<p class="mut">키마다 한 번씩. FIDO2 PIN 이 설정돼 있어야 합니다. Setup token 은 처음 쓴 뒤 30분 동안 키 2개(Nano + NFC)까지 등록할 수 있습니다.</p>
<div class="card">
  <label class="mut">Setup token</label><input type="password" id="setup" autocomplete="off">
  <label class="mut">이름 (예: NFC, Nano)</label><input type="text" id="label" maxlength="40">
  <button id="go">키 등록</button>
</div><p id="msg"></p>`, `
// deploy.ps1 이 /register#<token> 으로 연다. fragment 는 서버로 가지 않고, 읽자마자 주소창에서 지운다.
if(location.hash.length>1){$('setup').value=decodeURIComponent(location.hash.slice(1));history.replaceState(null,'','/register')}
$('go').onclick=async()=>{const b=$('go');b.disabled=true;$('msg').textContent='';try{
 const setup=$('setup').value;const opts=await api('/api/register/options',{setup});
 const response=await tapCreate(opts);
 const r=await api('/api/register/verify',{setup,response,label:$('label').value});
 $('msg').textContent='등록됨: '+r.label;$('msg').className='ok';$('label').value='';
}catch(e){$('msg').textContent=e.message;$('msg').className='bad'}b.disabled=false};
`);

export const adminPage = () => page('관리', `
<h1>관리</h1>
<div class="card" id="login"><p class="mut">보안 키 확인 후 8시간 관리할 수 있습니다.</p><button id="go">보안 키로 열기</button></div>
<div id="panel" hidden>
  <button class="bad" id="all">모든 세션 지금 끊기</button>
  <div class="card"><b>활성 세션</b><table id="sess"></table></div>
  <div class="card"><b>공급자</b><p class="mut">진짜 키는 서버에 암호화돼 있고 끝 4자리만 보입니다.</p><p class="mut">"실습실에 나눠 줄 수 있음" 을 켜면 /lab 수업을 만들 때 고를 수 있습니다 (참가자에게는 가짜 토큰만 갑니다). 약관상 다른 사람에게 써도 되는 키인지는 운영자가 판단하세요. Daytona·OpenRouter 는 켤 수 없습니다.</p><table id="provs"></table>
    <details><summary style="cursor:pointer;margin-top:12px"><b>공급자 추가 · 키 교체</b></summary>
      <label class="mut">종류</label><select id="preset"></select>
      <div id="custom" hidden>
        <label class="mut">id (소문자, 주소 /p/&lt;id&gt; 에 쓰임)</label><input type="text" id="f_id">
        <label class="mut">이름</label><input type="text" id="f_label">
        <label class="mut">upstream (https://…)</label><input type="text" id="f_upstream">
        <label class="mut">인증 헤더</label><select id="f_auth"><option>bearer</option><option>xi-api-key</option><option>x-api-key</option></select>
        <label class="mut">빌린 PC 의 키 환경변수 이름</label><input type="text" id="f_envKey">
        <label class="mut">base URL 환경변수 이름 (선택)</label><input type="text" id="f_envBase">
        <label class="mut">base 경로 (선택, 예: /v1)</label><input type="text" id="f_basePath">
        <label class="mut">고정 헤더 (선택, 한 줄에 하나: X-Tenant-Id: …)</label><textarea id="f_headers" rows="2"></textarea>
      </div>
      <label class="mut">키 값 (이미 있는 공급자의 정의만 고칠 때는 비워 두기)</label><input type="password" id="f_value" autocomplete="off">
      <button id="save">저장</button>
    </details>
  </div>
  <div class="card"><b>등록된 보안 키</b><table id="creds"></table>
    <details><summary style="cursor:pointer;margin-top:12px"><b>PRF 키 등록</b> <span class="mut">(금고용 · 로그인 후 3분 안)</span></summary>
      <p class="mut">등록할 키를 꽂고 누르세요. 이미 등록된 키도 PRF 로 한 번 더 등록할 수 있습니다. 둘 다 끝나면 "PRF 없음" 표시된 예전 등록은 삭제해도 됩니다.</p>
      <label class="mut">이름 (예: NFC, Nano)</label><input type="text" id="r_label" maxlength="40">
      <button id="r_go">키 등록</button>
    </details></div>
  <p class="mut">금고는 <a href="/vault">/vault</a> · 공부방 실습실은 <a href="/lab">/lab</a></p>
  <div class="card"><b>최근 이벤트</b><table id="audit"></table></div>
</div><p id="msg"></p>`, `
let T=null;const H=()=>({'x-admin-token':T});
const cell=(tr,t)=>{const td=document.createElement('td');td.textContent=t;tr.append(td);return td};
const btn=(td,t,fn)=>{const b=document.createElement('button');b.className='sec';b.style.padding='4px 8px';b.textContent=t;b.onclick=fn;td.append(b)};
const say=(t,cls)=>{$('msg').textContent=t;$('msg').className=cls||''};
function provs(list){const p=$('provs');p.replaceChildren();if(!list.length)cell(p.insertRow(),'없음 — 아래에서 추가하거나 PC 에서 kv.ps1 push');
 for(const x of list){const tr=p.insertRow();cell(tr,x.label+' ('+x.id+')');cell(tr,'…'+x.last4);cell(tr,fmt(x.updatedAt));
  btn(cell(tr,''),'삭제',async()=>{if(confirm(x.label+' 을(를) 삭제할까요? 이 공급자를 쓰던 세션도 바로 막힙니다.')){await api('/api/admin/provider-delete',{id:x.id},H());load()}});
  shareCell(cell(tr,''),x);
  if(x.kind==='proxy')btn(tr.cells[3],'헤더',async()=>{const cur=Object.entries(x.headers||{}).map(([k,v])=>k+': '+v).join(' ; ');const t=prompt(x.label+' 고정 헤더 — 이름: 값, 여러 개는 ; 로 구분, 비우면 없앰 (예: X-Tenant-Id: <workspace id>)',cur);if(t===null)return;
   try{await api('/api/admin/provider',{id:x.id,headers:t},H());say(x.label+': 고정 헤더 저장','ok');load()}catch(e){say(e.message,'bad')}});
  if(x.headers){const c=cell(p.insertRow(),'고정 헤더: '+Object.entries(x.headers).map(([k,v])=>k+': '+v).join(' · '));c.colSpan=5;c.className='mut'}
  if(x.note){const c=cell(p.insertRow(),x.note);c.colSpan=5;c.className='mut'}}}
function shareCell(td,x){if(x.kind!=='proxy'||x.id==='daytona')return;const l=document.createElement('label');l.className='mut';const i=document.createElement('input');i.type='checkbox';i.checked=!!x.labShare;
 i.onchange=async()=>{try{await api('/api/admin/provider',{id:x.id,labShare:i.checked},H());say(x.label+(i.checked?': 실습실에 나눠 줄 수 있음':': 실습실에 안 나눠 줌 (진행 중인 수업도 바로 막힘)'),'ok')}catch(e){i.checked=!i.checked;say(e.message,'bad')}};
 l.append(i,' 실습실에 나눠 줄 수 있음');td.append(l)}
async function presets(){const sel=$('preset');sel.replaceChildren();
 for(const p of await api('/api/presets')){const o=document.createElement('option');o.value=p.id;o.textContent=p.label;sel.append(o)}
 const o=document.createElement('option');o.value='';o.textContent='직접 입력…';sel.append(o);
 sel.onchange=()=>{$('custom').hidden=sel.value!==''}}
$('save').onclick=async()=>{try{const sel=$('preset').value,v=$('f_value').value;
 const body=sel?{preset:sel,value:v}:{id:$('f_id').value.trim(),label:$('f_label').value.trim(),upstream:$('f_upstream').value.trim(),auth:$('f_auth').value,envKey:$('f_envKey').value.trim(),envBase:$('f_envBase').value.trim(),basePath:$('f_basePath').value.trim(),headers:$('f_headers').value,value:v};
 const r=await api('/api/admin/provider',body,H());$('f_value').value='';say('저장됨: '+r.provider.label+' (…'+r.provider.last4+')'+(r.warn?' — '+r.warn:''),r.warn?'bad':'ok');load()}catch(e){say(e.message,'bad')}};
async function load(){const d=await api('/api/admin/list',{},H());
 const s=$('sess');s.replaceChildren();if(!d.sessions.length){cell(s.insertRow(),'없음')}
 for(const x of d.sessions){const tr=s.insertRow();cell(tr,x.providers.join(', ')+(x.budget?' $'+x.budget:''));cell(tr,[x.city,x.country].filter(Boolean).join(', ')+' '+x.ip);cell(tr,'~'+fmt(x.expiresAt)+' · '+x.uses+'/'+x.limits.total+'회 · 1분 '+x.lastMinute+'/'+x.limits.perMinute+' · 진행 중 '+x.inflight+'/'+x.limits.concurrent+(x.manage.length?' · ⚠ Daytona 관리 API 허용 ('+x.manage.join(', ')+')':'')+(x.revoked?' (정리 재시도 중)':''));btn(cell(tr,''),'끊기',async()=>{await api('/api/admin/revoke',{target:x.id},H());load()})}
 provs(d.providers);
 const c=$('creds');c.replaceChildren();for(const x of d.creds){const tr=c.insertRow();cell(tr,x.label+(x.prf?' · PRF':' · PRF 없음'));cell(tr,'등록 '+fmt(x.createdAt));cell(tr,x.lastUsed?'사용 '+fmt(x.lastUsed):'');btn(cell(tr,''),'삭제',async()=>{if(confirm(x.label+' 키를 삭제할까요?')){await api('/api/admin/cred-delete',{id:x.id},H());load()}})}
 const a=$('audit');a.replaceChildren();for(const x of d.audit.slice(0,30)){const tr=a.insertRow();cell(tr,fmt(x.t));cell(tr,x.event);cell(tr,(x.detail||'')+' '+(x.ip||''))}}
$('go').onclick=async()=>{try{const opts=await api('/api/admin/options',{});const assertion=await tapGet(opts);
 const L=await api('/api/admin/login',{assertion,recoveryCode:true});T=L.token;showRc(L.recoveryCode);$('login').hidden=true;$('panel').hidden=false;await presets();await load()}catch(e){$('msg').textContent=e.message;$('msg').className='bad'}};
$('r_go').onclick=async()=>{const b=$('r_go');b.disabled=true;try{
 const opts=await api('/api/register/options',{},H());const response=await tapCreate(opts);
 const r=await api('/api/register/verify',{response,label:$('r_label').value},H());
 say('등록됨: '+r.label+(r.prf?' (PRF 지원)':' — PRF 가 켜지지 않았습니다'),r.prf?'ok':'bad');$('r_label').value='';load()}catch(e){say(e.name==='InvalidStateError'?'이 키는 이미 PRF 로 등록돼 있습니다.':e.message,'bad')}b.disabled=false};
$('all').onclick=async()=>{if(!confirm('모든 세션을 끊을까요?'))return;try{const r=await api('/api/admin/revoke',{target:'all'},H());$('msg').textContent=r.revoked+'개 끊음';$('msg').className='ok';load()}catch(e){$('msg').textContent=e.message}};
`);

// PRF(hmac-secret) 지원 확인용. 서버에 아무것도 저장하지 않는다 — 테스트용 크레덴셜은 키 안 슬롯도 쓰지 않는다(non-resident).
export const prfPage = (rpId: string) => page('PRF 테스트', `
<h1>PRF 테스트</h1>
<p class="mut">보안 키가 이 기기·브라우저에서 PRF(키에서 비밀값 뽑기)를 지원하는지 봅니다. 금고 기능에 필요합니다. 서버에는 아무것도 저장되지 않습니다.</p>
<div class="card">
  <p><b>1.</b> 테스트용 크레덴셜 만들기 (키 터치 + PIN)</p><button id="mk">만들기</button>
  <p><b>2.</b> 같은 입력으로 비밀값 두 번 뽑기 (터치 두 번)</p><button id="ev" disabled>뽑기</button>
</div>
<div class="card"><table id="log"></table></div>
<p id="msg"></p>`, `
const RP=${JSON.stringify(rpId)};let CID=null;
const rnd=n=>crypto.getRandomValues(new Uint8Array(n));
const hex=b=>[...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,'0')).join('');
const row=(k,v,cls)=>{const tr=$('log').insertRow();const a=tr.insertCell();a.textContent=k;const b=tr.insertCell();b.textContent=v;if(cls)b.className=cls};
const err=e=>{$('msg').textContent=e.name==='NotAllowedError'?'취소됐거나 시간이 지났습니다.':(e.name+': '+e.message);$('msg').className='bad'};
row('브라우저',navigator.userAgent.replace('Mozilla/5.0 ','').slice(0,120));
$('mk').onclick=async()=>{$('msg').textContent='';try{
 const c=await navigator.credentials.create({publicKey:{rp:{id:RP,name:'shinick prf test'},user:{id:rnd(16),name:'prf-test',displayName:'prf-test'},challenge:rnd(32),
  pubKeyCredParams:[{type:'public-key',alg:-7},{type:'public-key',alg:-8},{type:'public-key',alg:-257}],
  authenticatorSelection:{residentKey:'discouraged',userVerification:'required',authenticatorAttachment:'cross-platform'},hints:['security-key'],
  timeout:180000,extensions:{prf:{}}}});
 const x=c.getClientExtensionResults().prf;CID=c.rawId;
 row('만들기','성공 ('+(c.response.getTransports?c.response.getTransports().join(','):'?')+')','ok');
 row('PRF enabled',x===undefined?'브라우저가 PRF 를 모름':String(x.enabled),x&&x.enabled?'ok':'bad');
 $('ev').disabled=false;
}catch(e){err(e)}};
$('ev').onclick=async()=>{$('msg').textContent='';try{
 const salt=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode('shinick-prf-test')));
 const outs=[];
 for(let i=1;i<=2;i++){
  const a=await navigator.credentials.get({publicKey:{rpId:RP,challenge:rnd(32),userVerification:'required',timeout:180000,hints:['security-key'],
   allowCredentials:[{type:'public-key',id:CID,transports:['usb','nfc']}],extensions:{prf:{eval:{first:salt}}}}});
  const r=a.getClientExtensionResults().prf;const f=r&&r.results&&r.results.first;
  if(!f){row('뽑기 '+i,'결과 없음 → 이 조합은 PRF 불가','bad');return}
  outs.push(hex(f));row('뽑기 '+i,f.byteLength+'바이트, 지문 '+hex(f).slice(0,12)+'…','ok');
 }
 const same=outs[0]===outs[1];
 row('결론',same?'PRF 지원 ✓ (같은 입력 → 같은 값)':'값이 매번 다름 — 금고에 못 씀',same?'ok':'bad');
}catch(e){err(e)}};
`);

// 금고. 금고 키(VK)는 이 페이지 메모리에만 있다. 서버에는 암호문만 간다.
//   보안 키: PRF(고정 salt) → HKDF → KEK → VK 감싸기 (키마다 하나)
//   복구:    복구 코드(서버가 한 번만 내줌, 해시만 보관) + 질문 답(정규화) → PBKDF2-SHA256 100만 회 → 앞 32바이트 KEK,
//            뒤 32바이트 검증값(서버는 해시만 보관, 복구 코드마다 24시간 5회 제한). 복구에 성공하면 새 복구 코드가 나온다
//   항목:    AES-GCM(VK), AAD = vitem:<id>
export const vaultPage = () => page('금고', `
<h1>금고</h1>
<p class="mut">비밀번호 같은 비밀은 이 화면 안에서만 풀립니다. 서버에는 암호문만 저장됩니다.</p>
<div class="card" id="sendBox" hidden><p><b>빌린 PC 로 보내기</b></p>
 <p class="mut" style="text-align:center">PC 화면의 코드와 <b>같을 때만</b> 보내세요</p><div class="code" id="sendCode">······</div>
 <dl><dt>위치</dt><dd id="sendWhere"></dd><dt>IP</dt><dd id="sendIp"></dd><dt>브라우저</dt><dd id="sendUa"></dd></dl>
 <p class="mut">금고를 열고, 보낼 항목을 펼쳐 "이 PC 로 보내기"를 누르세요. "PC 로 보내기 허용" 항목만 보낼 수 있습니다. 그 PC 창만 풀 수 있게 암호화돼 갑니다.</p>
 <button class="sec" id="sendDeny">거절</button></div>
<div class="card" id="vNoKey" hidden><p><b>PRF 로 등록된 보안 키가 없습니다.</b></p>
 <p class="mut"><a href="/admin">/admin</a> 에 키로 로그인한 뒤 "PRF 키 등록"으로 NFC 키와 Nano 를 다시 등록하세요.</p></div>
<div class="card" id="vSetup" hidden><p><b>금고 만들기</b></p>
 <p class="mut">보안 키를 둘 다 잃어버렸을 때는 <b>복구 코드</b>(금고를 만들면 한 번 보여 줍니다)와 복구 질문 답이 함께 있어야 금고를 열 수 있습니다. 질문은 복구 화면에서 <b>누구나 볼 수 있으니</b> 질문에 답의 힌트를 넣지 마세요. 답은 대소문자·띄어쓰기를 무시합니다. 답을 합친 길이가 길수록 안전합니다.</p>
 <div id="qaSetup"></div><button class="sec" id="qaAdd">질문 추가</button>
 <p></p><button id="doSetup">보안 키로 금고 만들기</button></div>
<div class="card" id="vLocked" hidden><button id="doOpen">보안 키로 열기</button>
 <p class="mut" style="text-align:center"><a href="#" id="toRecover">키를 잃어버렸나요? 복구 질문으로 열기</a></p></div>
<div class="card" id="vRecover" hidden><p><b>복구 질문으로 열기</b></p><p class="mut" id="recLeft"></p>
 <label class="mut">복구 코드 (XXXX-XXXX-…)</label><input type="text" id="recCode" autocomplete="off" maxlength="64" autocapitalize="characters" spellcheck="false">
 <div id="qaRec"></div><button id="doRecover">열기</button><p></p><button class="sec" id="recBack">돌아가기</button></div>
<div id="vOpen" hidden>
 <div class="row"><button class="sec" id="doLock" style="flex:1">잠그기</button><button id="newItem" style="flex:1">+ 새 로그인</button></div>
 <p class="mut" id="openInfo"></p>
 <div class="card" id="form" hidden>
  <label class="mut">이름</label><input type="text" id="f_title" maxlength="80">
  <label class="mut">주소 (로그인 페이지)</label><input type="text" id="f_url" placeholder="https://">
  <label class="mut">아이디</label><input type="text" id="f_user" autocomplete="off">
  <label class="mut">비밀번호</label><input type="password" id="f_pw" autocomplete="new-password">
  <div class="row"><button class="sec" id="f_show" style="flex:1">보기</button><button class="sec" id="f_gen" style="flex:1">새로 생성</button></div>
  <label class="mut">메모</label><input type="text" id="f_note">
  <label class="mut">로그인 후 열 사이트 (선택 — 예: Google 로그인 후 https://claude.ai, 그 사이트의 "Google 로 계속" 까지 누름)</label><input type="text" id="f_then" placeholder="https://">
  <p><b>빌린 PC 로 보내기</b></p><div class="row">
   <label><input type="radio" name="pol" value="phone" checked>폰에서만 보기</label>
   <label><input type="radio" name="pol" value="send">PC 로 보내기 허용</label></div>
  <button id="f_save">저장</button><p></p>
  <div class="row"><button class="sec" id="f_cancel" style="flex:1">취소</button><button class="bad" id="f_del" style="flex:1">삭제</button></div>
 </div>
 <input type="text" id="q" placeholder="검색">
 <div id="list"></div>
 <details class="card"><summary style="cursor:pointer"><b>보안 키 연결</b></summary>
  <p class="mut">금고를 열 수 있는 키. 새로 PRF 등록한 키는 여기서 "연결"해야 금고를 열 수 있습니다.</p><table id="keys"></table></details>
 <details class="card" id="recBox"><summary style="cursor:pointer"><b>복구 질문 바꾸기</b></summary>
  <div id="qaChange"></div><button class="sec" id="qaAdd2">질문 추가</button><p></p><button id="doChange">바꾸기</button>
  <p class="mut">복구 코드를 잃어버렸으면 새로 받으세요 (보안 키로 연 뒤 3분 안). 예전 코드는 바로 무효가 됩니다.</p><button class="sec" id="doRc">복구 코드 새로 받기</button></details>
</div>
<p id="msg"></p>`, `
const enc=new TextEncoder(),dec=new TextDecoder();
const rnd=n=>crypto.getRandomValues(new Uint8Array(n));
const PRF_SALT=crypto.subtle.digest('SHA-256',enc.encode('shinick-vault-prf-v1'));
const ITER=1000000;
let TOK=null,VK=null,VKEY=null,ITEMS=[],KEYS=[],EDIT=null,lockT=null,openT=null,SEND=null;
const say=(t,cls)=>{$('msg').textContent=t;$('msg').className=cls||''};
const oops=e=>say(e.name==='NotAllowedError'?'취소됐거나 시간이 지났습니다.':e.message,'bad');
const show=id=>{for(const v of ['vNoKey','vSetup','vLocked','vRecover','vOpen'])$(v).hidden=v!==id};
const H=()=>({'x-admin-token':TOK});

async function kekFromPrf(prf){const base=await crypto.subtle.importKey('raw',prf,'HKDF',false,['deriveKey']);
 return crypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt:new Uint8Array(0),info:enc.encode('shinick-vault-kek-v1')},base,{name:'AES-GCM',length:256},false,['encrypt','decrypt'])}
async function seal(key,data,aad){const iv=rnd(12);const ct=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:enc.encode(aad)},key,data);return{iv:b2u(iv),ct:b2u(ct)}}
async function unseal(key,s,aad){return new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:u2b(s.iv),additionalData:enc.encode(aad)},key,u2b(s.ct)))}
const norm=a=>a.normalize('NFKC').toLowerCase().split(/\\s+/).join('');
async function recDerive(answers,salt,iter){
 const base=await crypto.subtle.importKey('raw',enc.encode(answers.map(norm).join('|')),'PBKDF2',false,['deriveBits']);
 const bits=new Uint8Array(await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt,iterations:iter},base,512));
 return{kek:await crypto.subtle.importKey('raw',bits.slice(0,32),'AES-GCM',false,['encrypt','decrypt']),verifier:b2u(bits.slice(32))}}

// 한 번의 탭으로 서버 검증(관리 토큰)과 PRF 값을 같이 얻는다. PRF 값은 서버로 보내지 않는다.
async function tapPrf(credId){
 const o=await api('/api/vault/options',credId?{credId}:{});
 const c=await navigator.credentials.get({publicKey:{...o,challenge:u2b(o.challenge),allowCredentials:o.allowCredentials.map(x=>({...x,id:u2b(x.id)})),extensions:{prf:{eval:{first:await PRF_SALT}}}}});
 const r=c.getClientExtensionResults();const prf=r.prf&&r.prf.results&&r.prf.results.first;
 const assertion={id:c.id,rawId:b2u(c.rawId),type:c.type,response:{clientDataJSON:b2u(c.response.clientDataJSON),authenticatorData:b2u(c.response.authenticatorData),signature:b2u(c.response.signature),userHandle:c.response.userHandle?b2u(c.response.userHandle):undefined},clientExtensionResults:{}};
 const d=await api('/api/vault/open',{assertion});showRc(d.recoveryCode);delete d.recoveryCode;
 if(!prf)throw new Error('이 브라우저·키 조합에서 PRF 값을 받지 못했습니다.');
 TOK=d.token;armLock(Math.min(d.expiresAt, Date.now()+10*60e3)); // 금고 화면 잠금은 관리 세션과 따로, 최대 10분
 return{d,kek:await kekFromPrf(prf)}}

function qaRows(box,n){$(box).replaceChildren();for(let i=0;i<n;i++)qaAdd(box,'')}
function qaAdd(box,q){const d=document.createElement('div');d.className='qa';
 const qi=document.createElement('input');qi.type='text';qi.placeholder='질문';qi.maxLength=200;
 if(q){qi.value=q;qi.readOnly=true}
 const ai=document.createElement('input');ai.type='text';ai.placeholder='답';ai.autocomplete='off';ai.setAttribute('autocapitalize','off');
 d.append(qi,ai);$(box).append(d)}
function qaRead(box){const qs=[],as=[];for(const d of $(box).querySelectorAll('.qa')){const [q,a]=d.querySelectorAll('input');if(q.value.trim()&&a.value.trim()){qs.push(q.value.trim());as.push(a.value)}}
 if(qs.length<2)throw new Error('질문과 답을 2개 이상 채우세요.');
 const len=as.map(norm).join('').length;
 if(len<12&&!confirm('답을 합친 길이가 '+len+'자로 짧습니다. 서버 데이터가 유출되면 추측될 수 있습니다. 그래도 계속할까요?'))throw new Error('취소했습니다.');
 return{qs,as}}
async function makeRec(qs,as){const salt=rnd(16);say('복구 키 만드는 중… (몇 초 걸립니다)');
 const{kek,verifier}=await recDerive(as,salt,ITER);const w=await seal(kek,VK,'vrec');
 return{salt:b2u(salt),iter:ITER,questions:qs,iv:w.iv,ct:w.ct,verifier}}

async function useVK(raw,items){VK=raw;VKEY=await crypto.subtle.importKey('raw',VK,'AES-GCM',false,['encrypt','decrypt']);
 ITEMS=[];for(const it of items){try{ITEMS.push({...it,data:JSON.parse(dec.decode(await unseal(VKEY,it,'vitem:'+it.id)))})}catch{ITEMS.push({...it,data:{title:'(풀 수 없는 항목)'},broken:true})}}
 show('vOpen');render();await loadKeys()}
function armLock(exp){clearTimeout(lockT);lockT=setTimeout(()=>{lock();say('10분이 지나 잠겼습니다.','mut')},Math.max(0,exp-Date.now()));
 clearInterval(openT);openT=setInterval(()=>{const s=Math.max(0,Math.round((exp-Date.now())/1000));$('openInfo').textContent=(TOK?'':'복구로 열림 (읽기 전용) · ')+Math.floor(s/60)+'분 '+(s%60)+'초 뒤 자동 잠김'},1000)}
function lock(){if(VK)VK.fill(0);VK=VKEY=TOK=null;ITEMS=[];EDIT=null;$('list').replaceChildren();$('form').hidden=true;clearTimeout(lockT);clearInterval(openT);boot()}

async function boot(){try{const st=await api('/api/vault/status',{});KEYS=st.keys;
 if(!st.keys.some(k=>k.prf)){show('vNoKey');return}
 if(!st.initialized){show('vSetup');if(!$('qaSetup').children.length)qaRows('qaSetup',3);return}
 show('vLocked')}catch(e){oops(e)}}
async function loadKeys(){const st=await api('/api/vault/status',{});KEYS=st.keys;const t=$('keys');t.replaceChildren();
 for(const k of KEYS){const tr=t.insertRow();const a=tr.insertCell();a.textContent=k.label;const b=tr.insertCell();
  b.textContent=!k.prf?'PRF 없음 (금고 불가)':k.linked?'연결됨':'연결 안 됨';b.className=k.linked?'ok':'mut';
  const c=tr.insertCell();if(k.prf&&!k.linked){const x=document.createElement('button');x.className='sec';x.style.padding='4px 8px';x.textContent='연결';x.onclick=()=>link(k.id);c.append(x)}}
 $('recBox').hidden=!TOK}

$('qaAdd').onclick=()=>qaAdd('qaSetup','');
$('qaAdd2').onclick=()=>qaAdd('qaChange','');
$('doSetup').onclick=async()=>{try{const{qs,as}=qaRead('qaSetup');say('보안 키를 대세요…');
 const{d,kek}=await tapPrf();if(d.initialized)throw new Error('금고가 이미 있습니다. 새로고침하세요.');
 const raw=rnd(32);VK=raw;const wrap=await seal(kek,raw,'vwrap:'+d.credId);
 const rec=await makeRec(qs,as);
 const made=await api('/api/vault/init',{credId:d.credId,wrap,rec},H());showRc(made.recoveryCode); // 응답을 받자마자 — 뒤 단계가 실패해도 코드는 보인다
 $('qaSetup').replaceChildren();await useVK(raw,[]);say('금고를 만들었습니다. 위 복구 코드를 적어 두고, 다른 보안 키도 아래 "보안 키 연결"에서 연결하세요.','ok')}catch(e){oops(e)}};
$('doOpen').onclick=async()=>{try{say('보안 키를 대세요…');const{d,kek}=await tapPrf();
 if(!d.initialized){boot();return}
 if(!d.wrap)throw new Error('이 키는 아직 금고에 연결되지 않았습니다. 연결된 다른 키로 연 뒤 "보안 키 연결"에서 연결하세요.');
 await useVK(await unseal(kek,d.wrap,'vwrap:'+d.credId),d.items);say('')}catch(e){oops(e)}};
async function link(credId){try{if(!VK)throw new Error('먼저 금고를 여세요.');say('연결할 키를 대세요…');
 const{d,kek}=await tapPrf(credId);
 await api('/api/vault/link',{credId:d.credId,wrap:await seal(kek,VK,'vwrap:'+d.credId)},H());
 await loadKeys();render();say('연결했습니다.','ok')}catch(e){oops(e)}}
$('toRecover').onclick=async e=>{e.preventDefault();try{const r=await api('/api/vault/recover-info',{});
 $('qaRec').replaceChildren();for(const q of r.questions)qaAdd('qaRec',q);
 $('recLeft').textContent=r.hasCode?'복구 코드와 답이 함께 필요합니다. 이 코드로 남은 시도 '+r.left+'회 (24시간 기준)':'아직 복구 코드가 없습니다 — 보안 키로 금고를 한 번 열면 발급됩니다.';show('vRecover');$('doRecover').dataset.salt=r.salt;$('doRecover').dataset.iter=r.iter}catch(e){oops(e)}};
$('recBack').onclick=()=>boot();
$('doRecover').onclick=async()=>{try{const as=[...$('qaRec').querySelectorAll('.qa')].map(d=>d.querySelectorAll('input')[1].value);
 const code=$('recCode').value.trim();if(!code)throw new Error('복구 코드를 넣으세요.');
 say('확인 중… (몇 초 걸립니다)');
 const{kek,verifier}=await recDerive(as,u2b($('doRecover').dataset.salt),Number($('doRecover').dataset.iter));
 const r=await api('/api/vault/recover',{code,verifier});$('recCode').value='';
 // 서버는 성공하는 순간 코드를 바꾼다 — 새 코드는 응답을 받자마자 띄운다 (뒤의 풀기·목록 요청이 실패해도 잃지 않게)
 showRc(r.recoveryCode);
 try{armLock(Date.now()+10*60e3);await useVK(await unseal(kek,r.wrap,'vrec'),r.items)}
 catch(e){say((e.message||'열기 실패')+' — 예전 복구 코드는 이미 무효입니다. 위 새 복구 코드를 적어 두세요.','bad');return}
 say('복구 질문으로 열었습니다. 예전 복구 코드는 이제 무효입니다 — 위 새 코드를 적어 두세요. 새 보안 키를 등록했다면 아래에서 연결하세요.','ok')}catch(e){oops(e)}};
$('doRc').onclick=async()=>{try{if(!confirm('새 복구 코드를 받으면 예전 코드는 바로 무효가 됩니다. 계속할까요?'))return;const r=await api('/api/vault/recovery-code',{},H());showRc(r.recoveryCode)}catch(e){oops(e)}};
$('doLock').onclick=()=>{lock();say('잠갔습니다.','mut')};
$('doChange').onclick=async()=>{try{const{qs,as}=qaRead('qaChange');const rec=await makeRec(qs,as);
 await api('/api/vault/recovery',{rec},H());qaRows('qaChange',0);say('복구 질문을 바꿨습니다.','ok')}catch(e){oops(e)}};

function render(){const q=$('q').value.trim().toLowerCase();const box=$('list');box.replaceChildren();
 $('newItem').disabled=!TOK;
 const list=ITEMS.filter(i=>!q||[i.data.title,i.data.url,i.data.username].join(' ').toLowerCase().includes(q)).sort((a,b)=>(a.data.title||'').localeCompare(b.data.title||''));
 if(!list.length){const p=document.createElement('p');p.className='mut';p.textContent=ITEMS.length?'검색 결과 없음':'아직 항목이 없습니다. "+ 새 로그인"으로 추가하세요.';box.append(p)}
 for(const it of list){const c=document.createElement('div');c.className='card';
  const h=document.createElement('div');h.style.cursor='pointer';const t=document.createElement('b');t.textContent=it.data.title||'(이름 없음)';
  const s=document.createElement('div');s.className='mut';s.textContent=[it.data.username,host(it.data.url),it.policy==='send'?'PC 전송 허용':'폰 전용'].filter(Boolean).join(' · ');
  h.append(t,s);const body=document.createElement('div');body.hidden=true;h.onclick=()=>{body.hidden=!body.hidden};
  if(!it.broken){
   if(it.data.url)field(body,'주소',it.data.url,false,true);
   if(it.data.username)field(body,'아이디',it.data.username,false);
   if(it.data.password)field(body,'비밀번호',it.data.password,true);
   if(it.data.note)field(body,'메모',it.data.note,false);
   if(it.data.then)field(body,'다음 사이트',it.data.then,false,true);
   if(SEND&&it.policy==='send'&&TOK){const x=document.createElement('button');x.textContent='이 PC 로 보내기 ('+SEND.code+')';x.onclick=()=>sendTo(it);body.append(x,document.createElement('p'))}
   else if(SEND){const x=document.createElement('p');x.className='mut';x.textContent=it.policy!=='send'?'폰 전용 항목이라 보낼 수 없습니다.':'복구로 연 금고에서는 보낼 수 없습니다. 보안 키로 여세요.';body.append(x)}
   if(TOK){const e=document.createElement('button');e.className='sec';e.textContent='수정';e.onclick=()=>edit(it);body.append(e)}}
  c.append(h,body);box.append(c)}}
const host=u=>{try{return new URL(u).host}catch{return u||''}};
function field(box,label,val,secret,link){const d=document.createElement('div');d.className='row';d.style.alignItems='center';
 const l=document.createElement('span');l.className='mut';l.style.minWidth='64px';l.textContent=label;
 const safe=link&&/^https?:/i.test(val);
 const v=document.createElement(safe?'a':'span');v.style.flex='1';v.style.wordBreak='break-all';v.textContent=secret?'••••••••':val;if(safe){v.href=val;v.target='_blank';v.rel='noreferrer'}
 d.append(l,v);
 if(secret){const s=document.createElement('button');s.className='sec';s.style.width='auto';s.style.padding='4px 8px';s.textContent='보기';s.onclick=()=>{const hid=v.textContent==='••••••••';v.textContent=hid?val:'••••••••';s.textContent=hid?'숨기기':'보기'};d.append(s)}
 const cp=document.createElement('button');cp.className='sec';cp.style.width='auto';cp.style.padding='4px 8px';cp.textContent='복사';
 cp.onclick=async()=>{await navigator.clipboard.writeText(val);cp.textContent='복사됨';setTimeout(()=>{cp.textContent='복사';if(secret&&document.hasFocus())navigator.clipboard.writeText('').catch(()=>{})},30000)};
 d.append(cp);box.append(d)}
$('q').oninput=render;

// 빌린 PC 로 보내기: PC 페이지의 ECDH 공개키 + 이번에만 쓰는 폰 쪽 키 → AES-GCM. 서버는 중계만 한다.
(async()=>{const m=location.hash.match(/^#send=([\\w-]{16})$/);if(!m)return;
 try{const d=await api('/api/approve/'+m[1]);
  if(d.kind!=='send'||d.status!=='pending'){say('보내기 요청이 만료됐거나 이미 처리됐습니다.','bad');return}
  SEND={id:m[1],pub:d.pub,code:await fpCode(d.pub)};
  $('sendCode').textContent=SEND.code;$('sendWhere').textContent=[d.city,d.country].filter(Boolean).join(', ')||'알 수 없음';$('sendIp').textContent=d.ip;$('sendUa').textContent=d.ua;
  $('sendBox').hidden=false;render()}catch(e){oops(e)}})();
function endSend(){SEND=null;$('sendBox').hidden=true;history.replaceState(null,'','/vault');render()}
$('sendDeny').onclick=async()=>{try{await api('/api/approve/'+SEND.id+'/deny',{});endSend();say('거절했습니다.','mut')}catch(e){oops(e)}};
async function sendTo(it){try{if(!confirm('"'+(it.data.title||'')+'" 을(를) 코드 '+SEND.code+' 인 PC 로 보낼까요?'))return;
 const pk=await crypto.subtle.importKey('raw',u2b(SEND.pub),{name:'ECDH',namedCurve:'P-256'},false,[]);
 const eph=await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']);
 const k=await sendKey(await crypto.subtle.deriveBits({name:'ECDH',public:pk},eph.privateKey,256),SEND.pub,'encrypt');
 const iv=rnd(12);const ct=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:enc.encode('send:'+SEND.id)},k,enc.encode(JSON.stringify(it.data)));
 await api('/api/vault/send',{id:SEND.id,itemId:it.id,box:{epk:b2u(await crypto.subtle.exportKey('raw',eph.publicKey)),iv:b2u(iv),ct:b2u(ct)}},H());
 endSend();say('보냈습니다. PC 화면을 확인하세요.','ok')}catch(e){oops(e)}}

function edit(it){EDIT=it||null;const d=it?it.data:{};$('f_title').value=d.title||'';$('f_url').value=d.url||'';$('f_user').value=d.username||'';$('f_pw').value=d.password||'';$('f_note').value=d.note||'';$('f_then').value=d.then||'';
 $('f_pw').type='password';$('f_show').textContent='보기';
 for(const r of document.querySelectorAll('input[name=pol]'))r.checked=r.value===((it&&it.policy)||'phone');
 $('f_del').hidden=!it;$('form').hidden=false;$('form').scrollIntoView({behavior:'smooth'})}
$('newItem').onclick=()=>edit(null);
$('f_cancel').onclick=()=>{$('form').hidden=true;EDIT=null};
$('f_show').onclick=()=>{const p=$('f_pw');p.type=p.type==='password'?'text':'password';$('f_show').textContent=p.type==='password'?'보기':'숨기기'};
$('f_gen').onclick=()=>{const A='ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#%^&*-_=+?';let s='';
 const lim=Math.floor(256/A.length)*A.length;
 while(s.length<20)for(const b of rnd(64)){if(b<lim)s+=A[b%A.length];if(s.length===20)break}
 $('f_pw').value=s;$('f_pw').type='text';$('f_show').textContent='숨기기'};
$('f_save').onclick=async()=>{try{if(!TOK)throw new Error('세션이 만료됐습니다. 다시 여세요.');
 const data={title:$('f_title').value.trim(),url:$('f_url').value.trim(),username:$('f_user').value,password:$('f_pw').value,note:$('f_note').value};
 const then=$('f_then').value.trim();if(then){if(!/^https?:[/][/]/i.test(then))throw new Error('다음 사이트는 https:// 주소로 넣으세요.');data.then=then}
 if(!data.title)throw new Error('이름을 넣으세요.');
 if(data.url){let x=null;try{x=new URL(data.url)}catch{}const lo=h=>['localhost','127.0.0.1','[::1]'].includes(h);
  if(!x||x.username||x.password||!(x.protocol==='https:'||(x.protocol==='http:'&&lo(x.hostname)&&location.protocol==='http:'&&lo(location.hostname))))throw new Error('로그인 주소는 https:// 로 시작하는 전체 주소로 넣으세요 (아이디·비밀번호를 주소에 넣지 마세요).')}
 const id=EDIT?EDIT.id:b2u(rnd(12));const policy=document.querySelector('input[name=pol]:checked').value;
 const s=await seal(VKEY,enc.encode(JSON.stringify(data)),'vitem:'+id);
 const r=await api('/api/vault/item',{item:{id,iv:s.iv,ct:s.ct,policy}},H());
 ITEMS=ITEMS.filter(i=>i.id!==id).concat([{...r.item,data}]);$('form').hidden=true;EDIT=null;render();say('저장했습니다.','ok')}catch(e){oops(e)}};
$('f_del').onclick=async()=>{try{if(!EDIT||!confirm((EDIT.data.title||'이 항목')+' 을(를) 삭제할까요?'))return;
 await api('/api/vault/item-delete',{id:EDIT.id},H());ITEMS=ITEMS.filter(i=>i.id!==EDIT.id);$('form').hidden=true;EDIT=null;render();say('삭제했습니다.','ok')}catch(e){oops(e)}};
boot();
`);

// 빌린 PC: 금고 항목 받기. ECDH 개인키는 이 페이지 메모리에만 있다 (내보낼 수 없게 만든다).
// ?go=1 이면 go.ps1 이 조종하는 창 — 받은 값을 화면에 그리지 않고 window.__kv 로만 넘긴다.
export const recvPage = () => page('금고에서 받기', `
<h1>금고에서 받기</h1>
<p class="mut">폰으로 QR 을 찍고, 금고에서 보낼 로그인을 고르세요. 내용은 이 창에서만 풀리고 서버는 볼 수 없습니다.</p>
<div class="card" id="wait">
  <p class="mut" style="text-align:center">폰 화면의 코드와 같은지 확인하세요</p>
  <div class="code" id="code">······</div>
  <div class="qr" id="qr"></div>
  <p class="mut" style="text-align:center"><a id="link" href="#">QR 대신 링크</a> · <span id="left"></span></p>
  <p id="st" class="mut" style="text-align:center">기다리는 중…</p>
</div>
<div class="card" id="goMsg" hidden><p class="ok"><b>받았습니다.</b> 로그인 창으로 넘어갑니다…</p></div>
<div id="got" hidden>
  <div class="card"><p class="ok"><b id="gtitle"></b></p><div id="fields"></div></div>
  <button class="bad" id="clear">지금 지우기</button>
  <p class="mut">5분 뒤 자동으로 지웁니다. 창을 닫아도 지워집니다.</p>
</div>
<p id="err" class="bad"></p>`, `
const GO=new URLSearchParams(location.search).has('go');
let DATA=null,clearT=null;
function field(label,val,secret){const d=document.createElement('div');d.className='row';d.style.alignItems='center';
 const l=document.createElement('span');l.className='mut';l.style.minWidth='64px';l.textContent=label;
 const v=document.createElement('span');v.style.flex='1';v.style.wordBreak='break-all';v.textContent=secret?'••••••••':val;d.append(l,v);
 if(secret){const s=document.createElement('button');s.className='sec';s.style.width='auto';s.style.padding='4px 8px';s.textContent='보기';s.onclick=()=>{const h=v.textContent==='••••••••';v.textContent=h?val:'••••••••';s.textContent=h?'숨기기':'보기'};d.append(s)}
 const c=document.createElement('button');c.className='sec';c.style.width='auto';c.style.padding='4px 8px';c.textContent='복사';
 c.onclick=async()=>{await navigator.clipboard.writeText(val);c.textContent='복사됨';setTimeout(()=>{c.textContent='복사';if(secret&&document.hasFocus())navigator.clipboard.writeText('').catch(()=>{})},30000)};
 d.append(c);$('fields').append(d)}
function showData(){const x=DATA;if(!x)return;$('gtitle').textContent=x.title||'';$('fields').replaceChildren();
 if(x.url)field('주소',x.url,false);if(x.username)field('아이디',x.username,false);if(x.password)field('비밀번호',x.password,true);if(x.note)field('메모',x.note,false);if(x.then)field('다음 사이트',x.then,false);
 $('got').hidden=false;$('goMsg').hidden=true;clearT=setTimeout(wipe,5*60e3)}
function wipe(){DATA=null;window.__kv=null;$('fields').replaceChildren();$('got').innerHTML='<div class="card ok"><b>지웠습니다.</b></div>';clearTimeout(clearT)}
window.__kvShow=showData;
$('clear').onclick=wipe;
(async()=>{try{
 const kp=await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},false,['deriveBits']);
 const pub=b2u(await crypto.subtle.exportKey('raw',kp.publicKey));
 const d=await api('/api/recv',{pub});
 $('code').textContent=await fpCode(pub);$('qr').innerHTML=d.qr;$('link').href=d.approveUrl;window.__kvUrl=d.approveUrl;
 const tick=setInterval(()=>{const s=Math.max(0,Math.round((d.expiresAt-Date.now())/1000));$('left').textContent=Math.floor(s/60)+'분 '+(s%60)+'초 남음'},1000);
 while(true){await new Promise(r=>setTimeout(r,2000));
  const p=await api('/api/borrow/'+d.id+'/poll',{secret:d.secret});
  if(p.status==='approved'){clearInterval(tick);
   const epk=await crypto.subtle.importKey('raw',u2b(p.epk),{name:'ECDH',namedCurve:'P-256'},false,[]);
   const k=await sendKey(await crypto.subtle.deriveBits({name:'ECDH',public:epk},kp.privateKey,256),pub,'decrypt');
   const pt=await crypto.subtle.decrypt({name:'AES-GCM',iv:u2b(p.iv),additionalData:new TextEncoder().encode('send:'+d.id)},k,u2b(p.ct));
   DATA=JSON.parse(new TextDecoder().decode(pt));$('wait').hidden=true;
   if(GO){window.__kv=DATA;$('goMsg').hidden=false}else showData();
   return}
  if(p.status==='denied'||p.status==='expired'){clearInterval(tick);const t=p.status==='denied'?'폰에서 거절했습니다.':'만료됐습니다 — 새로고침하세요.';$('st').textContent=t;$('st').className='bad';window.__kvErr=t;return}
 }}catch(e){$('err').textContent=e.message;window.__kvErr=e.message}})();
`);

// 공부방 실습실 — 강사용. /admin 과 같은 키 탭 로그인(8시간).
export const labPage = (seatDomain = 'shinick.dev') => page('공부방 실습실', `
<style>
h2{font-size:16px;margin:20px 0 8px}h3{font-size:15px;margin:20px 0 4px}
[hidden]{display:none !important}
main{max-width:1120px}
::selection{background:var(--acc);color:#fff}
#labNav{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0 16px}
#labNav button,#labNav a{width:auto;flex:1 1 22%;min-width:0;min-height:44px;display:inline-flex;align-items:center;justify-content:center;text-align:center;text-decoration:none;padding:8px 6px;border-radius:10px;border:1px solid var(--line);background:transparent;color:var(--fg);font:inherit;font-size:14px;font-weight:600}
#labNav [aria-current=page]{background:var(--acc);color:#fff;border-color:transparent}
#roomHead{display:flex;flex-wrap:wrap;gap:12px 20px;align-items:flex-end;justify-content:space-between;padding-bottom:12px;margin-bottom:16px;border-bottom:1px solid var(--line)}
#roomHead .who{flex:1 1 260px;min-width:min(100%,220px)}
#roomHead .auth{flex:0 1 auto;display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:flex-end;font-size:13px}
#roomHead .auth p{margin:0}
#roomHead .auth button{width:auto;min-height:44px;padding:8px 12px}
#roomSelect{margin:4px 0 0}#roomStat,#fresh,#authBrief{margin:4px 0 0}
#roomHead .who{display:grid;grid-template-columns:max-content minmax(0,1fr);align-items:center;gap:6px 10px}#roomHead .who>label{font-size:14px}
#roomHead #roomSelect{margin:0}#roomHead .room-notes{grid-column:1/-1;display:flex;flex-wrap:wrap;gap:2px 12px;font-size:14px}#roomHead .room-notes p{margin:0}
#roomHead{gap:8px 14px;margin-bottom:8px;padding-bottom:8px}#viewRunH{margin:8px 0;font-size:14px}
.work{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:20px;align-items:start}
.work>#liveTools,.work>#handsBar{min-width:0;margin:0}
@media(max-width:1000px){.work{grid-template-columns:minmax(0,1fr)}.work>#handsBar{grid-row:1}#handList{max-height:28vh}}
#deliveryDock{margin:0 0 16px;padding:12px 16px;background:var(--card);border:1px solid var(--line);border-radius:12px}
#deliveryDock p{margin:4px 0}#deliveryDock button,#handList button,summary{min-height:44px}
#deliveryDock [data-lab-control]{border:0!important;margin:0!important;padding:0!important;display:flex;flex-wrap:wrap;align-items:center;gap:4px 12px}
#deliveryDock .row{margin:0;flex:1 1 280px;justify-content:flex-end}#deliveryDock .row>button{flex:0 1 auto!important;padding:8px 10px}
#deliveryDock .row>button:nth-child(2):disabled{display:none}#deliveryDock p{flex-basis:100%;font-size:13px}
#deliveryDock [data-lab-control]:has(>strong.ok)>p[role=status]{display:none}
#newForm .row>div>label{border:0;padding:0;display:block;border-radius:0}
#labs details[data-lab-section]{border-top:1px solid var(--line);padding:8px 0}#labs details[data-lab-section]>summary{cursor:pointer;font-weight:600;display:flex;align-items:center}
#labs .card{margin-top:0}#prepExtras{margin:16px 0}#prepExtras>summary{cursor:pointer;font-weight:600;display:flex;align-items:center}
#createAlert{padding:10px 12px;border:1px solid var(--line);border-radius:10px;margin:0 0 12px}#createAlert button{width:auto;min-height:44px}
.hands{position:static}.hands[data-hands]:not([data-hands="0"]){border-color:var(--bad)}
.hrow{display:flex;gap:8px;align-items:center;justify-content:space-between;flex-wrap:wrap}.hrow h2{margin:0}
#handList,#handLog{list-style:none;margin:8px 0 0;padding:0;max-height:40vh;overflow:auto}
#handList li,#handLog li{display:flex;flex-wrap:wrap;gap:4px 10px;align-items:center;padding:8px 0;border-top:1px solid var(--line)}#handList li:first-child,#handLog li:first-child{border-top:0}
#handList .go{margin-left:auto}.hwho{font-weight:700}.hwait{font-variant-numeric:tabular-nums}
#handList button,.hrow button,#sess button,#handAck,#roomHead button{width:auto;padding:6px 12px}
.alert{font-weight:700;color:var(--bad);margin:8px 0 0}.alert:empty{display:none}
#sess{display:flex;flex-wrap:wrap;gap:4px 12px;align-items:center}#sess p{margin:0;flex:1 1 260px}
#fresh{font-variant-numeric:tabular-nums}
tr.flash{outline:2px solid var(--acc);outline-offset:-2px}
:focus-visible{outline:2px solid var(--acc);outline-offset:2px}
#newLab>summary{cursor:pointer}
#bigHands{font-weight:700;color:var(--bad);font-size:clamp(18px,3vw,32px);margin-top:12px}#bigHands:empty{display:none}
#pushCard .hrow button{width:auto;padding:6px 12px}#pushCard p{margin:8px 0 0}#pushMsg:empty{display:none}
.lab-live-open main{max-width:1440px}.lab-live-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,340px),1fr));gap:20px}
.lab-live-seat{min-width:0;border-top:1px solid var(--line);padding-top:16px}.lab-live-seat[data-control=active]{outline:2px solid var(--acc);outline-offset:4px}
#liveTools textarea:focus-visible,#liveTools video:focus-visible{outline:2px solid var(--acc);outline-offset:2px}
#labs .card[data-selected="1"]{outline:2px solid var(--acc);outline-offset:2px}
#labs .seat-wrap{margin-top:4px}
main{max-width:1440px}
#viewRun:not([hidden]){display:grid;grid-template-columns:180px minmax(0,1fr) 300px;grid-template-areas:"runHead runHead runHead" "classSide classMain classRail" "share share share" "tools tools tools" "labs labs labs";column-gap:16px;row-gap:12px;align-items:start}
#classShell{display:contents}
#viewRunH{grid-area:runHead}
#classSide{grid-area:classSide}
#classMain{grid-area:classMain}
#classRail{grid-area:classRail;min-width:0}
#classRail .work{display:flex;flex-direction:column;gap:12px}
#classRail .work>section{width:100%;box-sizing:border-box}
#classRail #deliveryDock{padding:12px}
#classRail #deliveryDock .row{flex-basis:100%;justify-content:flex-start}
#classRail #deliveryDock .row>button{flex:1 1 auto!important}
#shareHold{grid-area:share}
#viewRun>h2:not(#viewRunH){grid-area:tools}
#labs{grid-area:labs;min-width:0}
#classSide,#classMain,#classPeople{color:#20242c;overflow-wrap:anywhere;min-width:0}
#classSide{background:#f7f7f5;border:1px solid #e3e3de;border-radius:12px;padding:8px}
#classPeople{background:#f7f7f5;border:1px solid #e3e3de;border-radius:12px;padding:12px;margin:0 0 12px}
#classMain .class-card{background:#fff;color:#20242c;border:1px solid #e3e3de;border-radius:12px;padding:12px;margin:0 0 12px;min-width:0;overflow-wrap:anywhere}
#classSide .mut,#classMain .mut,#classPeople .mut{color:#5c6570}
#classMain .class-prompt,#classMain .class-text,#classMain textarea{background:#18212f;color:#dbe5f2}
#classMain textarea,#classMain input,#classMain pre{max-width:100%}
#classSide button,#classMain button,#classPeople button{width:auto;max-width:100%;min-height:44px}
#classSide nav{display:flex;flex-direction:column;gap:8px}
#classSide nav button,#classSide .class-steps button{width:100%;text-align:left}
#classSide button:not(.sec),#classMain button:not(.sec),#classPeople button:not(.sec){background:#315cf2;color:#fff}
#classSide button.sec,#classMain button.sec,#classPeople button.sec{background:transparent;color:#20242c;border:1px solid #c9c9c2}
#classSide [aria-current=page]{background:#315cf2;color:#fff}
#classSide nav button:not(.sec),#classSide .class-steps button:not(.sec){background:transparent;color:#20242c;border:0}
#classSide nav button[aria-current=page]:not(.sec){background:#315cf2;color:#fff}
#classSide .class-steps button[aria-current=step]:not(.sec){background:#e8edff;color:#2447c6}
#classSide .class-steps button{font-size:13px;line-height:1.5;margin:3px 0}
#classMain .class-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
#classMain .class-prompt,#classMain .class-text{white-space:pre-wrap;overflow-wrap:anywhere}
#classPeople .class-person+.class-person{margin-top:12px;padding-top:12px;border-top:1px solid #d9d9d3}
#classMain .class-field{display:flex;flex-direction:column;gap:4px;margin:8px 0;min-width:0}
#classMain a{color:#315cf2;overflow-wrap:anywhere}
@media(max-width:1000px){#viewRun:not([hidden]){display:block}#classSide{margin-bottom:16px}#classSide nav{display:grid;grid-template-columns:1fr 1fr}#classRail{margin-top:16px}}
${LAB_COMMAND_CENTER_CSS}
</style>
<h1>공부방 실습실</h1>
<nav id="labNav" aria-label="모임">
 <button type="button" id="navSet" class="nav-utility" data-view="set" aria-haspopup="dialog" aria-controls="settingsDialog" aria-expanded="false">설정</button>
</nav>
<div class="card" id="login">
 <p class="mut">참가자마다 Daytona 실습실(브라우저 VS Code + Claude Code·OpenCode)과 $ 한도가 걸린 OpenRouter 가짜 토큰을 만듭니다. 참가자마다 자리 초대 링크(QR)를 따로 줍니다 — 링크는 그 자리 전용이라 다른 사람이 쓸 수 없습니다. 끝나는 시각에 실습실·토큰·서브키가 모두 지워집니다.</p>
 <p class="mut">보안 키로 열면 이 기기에서 8시간 동안 수업과 손 든 사람을 계속 봅니다(새로고침·앱 다시 열기 포함 — 보안 키로 다시 확인해도 이 8시간은 늘지 않습니다). 수업 만들기·초대·끝내기 같은 관리 작업은 8시간 동안만 되고, 그 뒤에는 보안 키를 다시 댑니다.</p>
 <p id="loginNote" role="status" aria-live="polite"></p>
 <button id="go">보안 키로 열기</button>
 <p></p><button class="sec" id="mRetry" hidden>모니터 다시 확인</button>
</div>
<div id="panel" hidden>
 <header id="roomHead">
  <div class="who">
   <label for="roomSelect">선택한 모임</label>
   <select id="roomSelect"></select>
   <div class="room-notes"><p id="roomStat" role="status"></p><p id="fresh" class="mut"></p></div>
  </div>
  <div class="auth">
   <p id="authBrief" role="status"></p>
   <button id="reauth" hidden>보안 키로 다시 확인</button>
  </div>
 </header>
 <div id="createAlert" role="status" hidden><span>생성 결과를 확인할 모임이 있습니다.</span> <button id="createAlertGo" class="sec">생성 결과 확인</button></div>
 <div id="viewRun">
  <div id="runBar"><h2 id="viewRunH">모임 진행</h2><div id="classSide"></div>
   <div id="runActions"><section id="deliveryDock" aria-label="선택한 모임 명령 전달" hidden></section><button id="runAddSeat" class="sec" aria-haspopup="dialog" aria-controls="seatAddDialog" disabled>좌석 추가</button><button id="runMaterials" class="sec">자료·코드</button><button id="runTools" class="sec">모임 도구</button></div>
  </div>
  <div id="workspaceTabs" aria-label="중앙 작업 화면">
   <button id="workspaceGallery" class="sec" aria-pressed="false">참여자 모아보기</button>
   <button id="workspaceHome" class="sec" hidden>내 시연으로 돌아가기</button>
   <button id="workspaceFinish" class="sec" hidden>도움 마치기</button>
   <button id="workspaceSize" class="sec" aria-pressed="false">시연 크게 보기</button>
   <button id="workspaceFull" class="sec">전체 화면</button>
   <span id="workspaceQueue" role="status" hidden></span>
   <button id="broadcastPreviewShow" class="sec" hidden>내 송출 화면</button><p id="workspaceStatus" role="status"></p><div id="broadcastDock"></div>
  </div>
  <div id="classShell"><div id="classMain"></div></div>
  <section id="demoWorkspace" aria-label="모임지기 실제 시연실" hidden><header><strong>내 시연실</strong><div id="demoWorkspaceModes"></div><p id="demoWorkspaceStatus" role="status">시연실을 연결하고 있습니다…</p><button id="demoWorkspaceRetry" class="sec">다시 연결</button><button id="demoWorkspacePopout" class="sec">새 탭으로 열기</button></header><div id="demoWorkspaceFrame"></div></section>
  <section id="broadcastPreviewStage" aria-label="내 송출 화면 미리보기" hidden><header><strong>내 송출 화면</strong><div><button id="broadcastPreviewSize" class="sec">작게 보기</button><button id="broadcastPreviewFull" class="sec">전체 화면</button></div></header><video id="broadcastPreviewVideo" autoplay muted playsinline></video><p id="broadcastPreviewStatus" role="status"></p><p class="mut">미리보기 크기만 바뀝니다. 실습실 탭이나 창을 공유하면 글자를 읽기 좋습니다.</p></section>
  <section id="supportStage" aria-label="선택한 참여자 지원"></section>
  <div id="classNotices"></div><footer id="runGuide" aria-label="현재 안내와 다음 단계"></footer>
  <div id="classRail">
  <div class="work">
   <section class="card" id="liveTools" aria-label="모임 화면과 참여자 지원" hidden></section>
   <section class="card hands" id="handsBar" aria-labelledby="handsH" data-hands="0">
    <div class="hrow"><h2 id="handsH">도움 요청 <span id="handN"></span></h2><button class="sec" id="sound" aria-pressed="false">소리 알림 켜기</button></div>
    <p class="mut">모든 모임의 현재 요청입니다.</p>
    <p class="alert" id="handAlert" role="alert"></p><button class="sec" id="handAck" hidden>알림 확인</button>
    <ul id="handList"></ul>
    <p id="handRo" class="mut" hidden>손 내리기는 보안 키로 다시 확인한 뒤에 할 수 있습니다.</p>
    <details id="handHistory"><summary id="handPastH">지난 알림</summary><ul id="handLog"></ul>
    <p class="mut" id="handAckNote">알림 확인은 요청 해결과 다릅니다. 현재 요청은 위 목록에서 확인하세요.</p></details>
   </section>
  </div>
  </div>
  <div id="shareHold" hidden></div>
  <dialog id="opsDialog" aria-labelledby="opsTitle"><div class="ops-heading"><h2 id="opsTitle">모임 도구</h2><button id="opsClose" class="sec">닫고 수업으로 돌아가기</button></div><div id="labs"></div></dialog>
 </div>
 <dialog id="prepDialog" class="utility-dialog" aria-labelledby="viewPrepH"><div class="utility-heading"><h2 id="viewPrepH">새 모임 만들기</h2><button id="prepClose" class="sec">닫고 수업으로 돌아가기</button></div>
 <div id="viewPrep">
 <details class="card" id="newLab"><summary><b>새 모임 만들기</b></summary>
 <p id="newLocked" class="mut" hidden>관리 작업은 보안 키로 다시 확인 — 이 패널을 닫고 상단의 "보안 키로 다시 확인"을 누르세요. 적어 둔 입력은 그대로 남습니다.</p>
 <div id="newForm">
 <p id="warn" hidden></p>
  <label class="mut" for="l_name">모임 이름</label><input type="text" id="l_name" maxlength="40" placeholder="예: 10/6 멀티 에이전트">
  <div class="row"><div style="flex:1"><label class="mut" for="l_seats">인원</label><input type="text" id="l_seats" inputmode="numeric" value="5"></div>
   <div style="flex:1"><label class="mut" for="l_hours">시간</label><select id="l_hours"></select></div>
   <div style="flex:1"><label class="mut" for="l_budget">1인 한도</label><select id="l_budget"></select></div></div>
  <label class="mut" for="l_spec">사양 (1명당)</label><select id="l_spec">
   <option value="1/2/5">가벼움 · 1 vCPU · 2 GiB · 디스크 5 GiB</option>
   <option value="2/4/5">보통 · 2 vCPU · 4 GiB · 디스크 5 GiB</option>
   <option value="4/8/10">멀티 에이전트 · 4 vCPU · 8 GiB · 디스크 10 GiB</option>
   <option value="custom">직접 입력 (그 사양의 스냅샷이 없으면 처음 한 번 자동으로 준비합니다 — 몇 분)</option>
  </select>
  <div class="row" id="l_custom" hidden><div style="flex:1"><label class="mut" for="l_cpu">CPU (vCPU)</label><input type="text" id="l_cpu" inputmode="numeric" value="2"></div>
   <div style="flex:1"><label class="mut" for="l_memory">메모리 (GiB)</label><input type="text" id="l_memory" inputmode="numeric" value="4"></div>
   <div style="flex:1"><label class="mut" for="l_disk">디스크 (GiB)</label><input type="text" id="l_disk" inputmode="numeric" value="10"></div></div>
  <p class="mut" id="l_total"></p>
  <label class="mut" for="l_mat">모임 자료 (선택) — 모든 자리의 work 폴더에 미리 넣어 둡니다</label><input type="text" id="l_mat" placeholder="GitHub 저장소 · ZIP 링크 · 구글 드라이브 공유 링크">
  <details id="prepExtras"><summary>복사·API 사용 설정</summary>
  <label class="mut">클립보드 (수업 중에도 바꿀 수 있음 — 막아도 실습실 안 복사·붙여넣기는 됩니다)</label>
  <div class="row"><label><input type="checkbox" id="l_cin" checked> 내 PC → 실습실 붙여넣기</label><label><input type="checkbox" id="l_cout" checked> 실습실 → 내 PC 복사</label></div>
  <label class="mut">이 수업에서 나눠 줄 API 키 (선택) — 참가자에게는 가짜 토큰만 갑니다. 자리당 호출 수 상한(1~10000회)은 수업 중에도 바꿀 수 있고, 잠시 막으려면 수업 카드에서 끄세요</label>
  <div id="l_share"></div>
  </details>
  <details><summary class="mut" style="cursor:pointer">고급</summary>
   <p class="mut">Daytona 기본 실습실 1개당 상한은 4 vCPU · 메모리 8 GiB · 디스크 10 GiB입니다. 조직 전체의 남은 용량과 별개이며, 상향 승인된 계정은 해당 한도를 따릅니다.</p>
   <p class="mut" id="l_snapname"></p>
   <label class="mut" for="l_gw">게이트웨이 workers.dev 주소 (샌드박스가 부르는 곳, 기본값은 wrangler 변수 LAB_GW)</label><input type="text" id="l_gw" placeholder="https://gw-shinick.<계정>.workers.dev">
   <label class="mut" for="l_snap">스냅샷 기본 이름 (사양에 따라 -2c4g · -2c8g10d 처럼 붙여 씁니다)</label><input type="text" id="l_snap">
   <label class="mut" for="l_model">모델 (OpenRouter id)</label><input type="text" id="l_model">
  </details>
  <button id="l_make">만들기</button>
 </div>
 <p id="l_msg" role="status" aria-live="polite" aria-atomic="true"></p>
 <p id="l_reauth" class="mut" hidden>결과 복구도 관리 작업입니다. 위의 "보안 키로 다시 확인"을 누른 뒤 복구하세요. 읽기 전용 모니터는 결과를 복구할 권한이 없습니다.</p>
 <button class="sec" id="l_recheck" hidden>결과 복구</button><button class="sec" id="l_new" hidden>새 수업 입력으로 돌아가기</button>
 </details>
 </div>
 </dialog>
 <dialog id="settingsDialog" class="utility-dialog utility-small" aria-labelledby="viewSetH"><div class="utility-heading"><h2 id="viewSetH">설정</h2><button id="settingsClose" class="sec">닫기</button></div>
 <div id="viewSet">
  <div class="card" id="sess"><p><span id="monLine"></span><br><span id="admLine"></span></p><button class="sec" id="logout">로그아웃</button></div>
  <section class="card" id="pushCard" aria-labelledby="pushH" data-state="off" hidden>
   <div class="hrow"><h2 id="pushH">화면을 꺼도 손들기 알림</h2><span><button id="pushOn" hidden>이 기기에서 켜기</button><button class="sec" id="pushOff" hidden>이 기기에서 끄기</button></span></div>
   <details><summary>알림 사용 안내</summary><p class="mut">이 기기에서 "켜기"를 눌러 허용해야만 받습니다(기기마다 따로). 지금 모니터 세션(8시간)이 끝나거나 로그아웃하면 멈춥니다. 잠금 화면에는 이름 없이 "학생이 손을 들었습니다"만 뜹니다. 기기의 방해 금지·알림 설정·네트워크에 따라 늦거나 오지 않을 수 있으니 이 화면도 함께 보세요. iPhone·iPad 는 iOS·iPadOS 16.4 이상에서 홈 화면에 추가한 앱으로 열어야 합니다.</p></details>
   <p id="pushMsg" role="status" aria-live="polite"></p>
  </section>
  <details class="card" id="instCard"><summary><b>모임지기 앱으로 설치</b></summary><p class="mut" id="instMsg">설치 버튼이 보이지 않으면 브라우저 메뉴의 "앱 설치" 또는 "홈 화면에 추가"를 쓰세요. 앱은 모임 정보를 기기에 저장하지 않습니다.</p><button class="sec" id="inst" hidden>설치</button></details>
  <div class="row"><button type="button" id="navPrep" class="sec utility-action" data-view="prep" aria-haspopup="dialog" aria-controls="prepDialog" aria-expanded="false">새 모임</button></div>
  <p class="mut"><a href="/lab/requests" target="_blank" rel="noopener">요청 기록·알림</a> · <a href="/admin">관리</a></p>
 </div>
 </dialog>
 <dialog id="seatAddDialog" class="utility-dialog utility-small" aria-labelledby="seatAddTitle">
  <div class="utility-heading"><h2 id="seatAddTitle">현재 모임에 좌석 추가</h2><button id="seatAddClose" class="sec">닫기</button></div>
  <p id="seatAddInfo"></p><p class="mut">기존 모임의 사양·AI 한도·종료 시각을 따릅니다. 한 자리만 새로 만들며 실습실 자원·요금이 추가됩니다.</p>
  <p id="seatAddNote" role="status" aria-live="polite"></p>
  <div class="row"><button id="seatAddConfirm">1자리 추가</button><button id="seatAddCheck" class="sec" hidden>같은 요청 결과 확인</button><button id="seatAddResume" class="sec" hidden>같은 요청으로 계속 준비</button><button id="seatAddNext" class="sec" hidden>다른 좌석 추가</button><button id="seatAddInvite" hidden>새 좌석 초대</button></div>
 </dialog>
</div><p id="msg"></p>
<div id="big" hidden style="position:fixed;inset:0;background:var(--bg);z-index:9;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;text-align:center">
 <div id="bigName" style="font-size:28px;font-weight:700"></div>
 <div id="bigQr" style="background:#fff;border-radius:16px;padding:20px;width:min(70vh,90vw);margin:16px 0"></div>
 <div id="bigUrl" style="font:700 clamp(20px,4vw,44px)/1.2 ui-monospace,Consolas,monospace;word-break:break-all"></div>
 <div id="bigCount" class="mut" style="font-size:20px;margin-top:8px"></div>
 <div id="bigHands" role="status"></div>
 <button class="sec" id="bigClose" style="width:auto;margin-top:16px">닫기</button>
</div>`, `
// 관리 토큰(T)은 이 페이지 메모리에만 두고 서버가 준 expiresAt 까지만 쓴다 (TE: 이 기기 시계로 옮긴 값, 받은 때부터 8시간을 넘지 않게). 지나면 관리 요청을 아예 보내지 않고
// 보안 키를 다시 묻는다 — 자동 재시도·연장 없음. 모니터(읽기 전용, 8시간)는 서버가 굽는 HttpOnly 쿠키라 JS 는 모른다
let T=null,TE=0,AG=0,LO='',Q=null,bigId=null,bigTimer=null,CFG=false; // AG: 관리 세대 — 로그인 시작·로그아웃·만료마다 올려 늦게 온 응답을 버린다
const AUTH_MSG='관리 작업은 보안 키로 다시 확인';
const adm=()=>!!T&&Date.now()<TE;
const H=()=>{if(!adm()){admExpired();const e=new Error(AUTH_MSG+'해 주세요 — 요청은 보내지 않았습니다.');e.name='AdminExpired';throw e}return{'x-admin-token':T}};
const say=(t,cls)=>{$('msg').textContent=t;$('msg').className=cls||''};
const opt=(sel,vals,f,def)=>{$(sel).replaceChildren();for(const v of vals){const o=document.createElement('option');o.value=v;o.textContent=f(v);o.selected=v===def;$(sel).append(o)}};
// 사양: 기본 세 가지 또는 직접 입력. 직접 입력은 1 이상 정수(숫자만)일 때만 [cpu,memory,disk], 아니면 null
const PRESETS=['1/2/5','2/4/5','4/8/10'];
const resInt=v=>{v=String(v);if(!/^[1-9][0-9]{0,9}$/.test(v))return null;const n=Number(v);return String(n)===v&&n<=2147483647?n:null};
function spec(){const v=$('l_spec').value;$('l_custom').hidden=v!=='custom';if(v!=='custom')return v.split('/').map(Number);
 const r=['l_cpu','l_memory','l_disk'].map(k=>resInt($(k).value));return r.every(x=>x!==null)?r:null}
// 서버(lab-resources.ts labSnapshotName)와 같은 이름: 기본 세 가지는 -<cpu>c<mem>g, 그 밖은 -<cpu>c<mem>g<disk>d
const snapName=([c,m,d])=>($('l_snap').value.trim()||'?')+'-'+c+'c'+m+'g'+(PRESETS.includes(c+'/'+m+'/'+d)?'':d+'d');
function total(){const n=Number($('l_seats').value)||0;const r=spec();
 if(!r){$('l_total').textContent='CPU·메모리·디스크는 1 이상 정수(숫자만)로 적어 주세요.';$('l_total').className='bad';$('l_snapname').textContent='';return}
 const [c,m,d]=r;$('l_snapname').textContent='쓸 스냅샷: '+snapName(r);
 let t='이번 수업 '+n*c+' vCPU · '+n*m+' GiB · 디스크 '+n*d+' GiB',bad;
 if(Q){const f=k=>Q[k][1]-Q[k][0];t+='  ·  Daytona 남은 한도 '+f('cpu')+' vCPU · '+f('memory')+' GiB · '+f('disk')+' GiB (전체 '+Q.cpu[1]+' · '+Q.memory[1]+' · '+Q.disk[1]+')';bad=n*c>f('cpu')||n*m>f('memory')||n*d>f('disk')}
 else{t+='  (Daytona 한도는 첫 수업을 만든 뒤부터 보입니다)';bad=false}
 $('l_total').textContent=t;$('l_total').className=bad?'bad':'mut'}
$('l_seats').oninput=total;$('l_spec').onchange=total;for(const k of ['l_cpu','l_memory','l_disk','l_snap'])$(k).oninput=total;
// 보안 키 로그인: 관리 토큰(8시간) → 모니터 쿠키 굽기(/api/lab/teacher/session, 이 관리 토큰으로) → 설정·목록.
// 다시 확인(reauth)도 같은 길. 설정의 기본값은 처음 로그인 때만 칸에 넣는다 — 다시 확인할 때는 적어 둔 입력·코드 초안을 그대로 둔다
let LG=0;
// 관리 만료 시각은 서버가 늘 준다 — 없거나 숫자가 아니거나 이미 지났으면 열지 않는다 (fail closed)
async function login(){if(LOP)return;const g=++LG,a=++AG;$('go').disabled=$('reauth').disabled=true;
 try{const opts=await api('/api/admin/options',{});const assertion=await tapGet(opts);
  const L=await api('/api/admin/login',{assertion});if(a!==AG)return;
  await openAdmin(L,a,true)}
 catch(e){if(a===AG)say(e&&e.name==='NotAllowedError'?'취소됐거나 시간이 지났습니다.':e.message,'bad')}
 finally{if(!LOP)$('go').disabled=$('reauth').disabled=false;view()}}
async function openAdmin(L,a,freshLogin){
  const left=typeof L.expiresAt==='number'&&Number.isFinite(L.expiresAt)?L.expiresAt-srvNow():NaN;
  if(typeof L.token!=='string'||!L.token||!(left>0))throw new Error('관리 로그인 응답의 만료 시각을 알 수 없어 열지 않았습니다. 다시 시도하세요.');
  T=L.token;TE=Date.now()+Math.min(8*3600e3,left);
  if(freshLogin){
  try{await tpost('/api/lab/admin/session/remember',{},H(),10000);if(a!==AG)return}catch(e){if(a!==AG)return;if(e.status===401){T=null;TE=0;throw e}say('이 기기의 새로고침 유지 설정을 저장하지 못했습니다. 다시 열 때 보안 키가 필요할 수 있습니다.','bad')}
  try{const m=await tpost('/api/lab/teacher/session',{},H(),10000);if(a!==AG)return;if(typeof m.expiresAt!=='number'||!Number.isFinite(m.expiresAt))throw new Error('응답을 알아볼 수 없습니다');MON={expiresAt:m.expiresAt};MONERR='';swReg();pushInit()}
  catch(e){if(a!==AG)return;MONERR='모니터 유지 세션을 만들지 못했습니다 ('+cleanErr(e.message)+') — 관리 작업 시간 동안만 보입니다.'+(e.status===401?' 다시 확인하면 새로 엽니다.':'');
   if(e.status===401&&MON)monEnd(MONERR)} // 이 기기의 모니터 쿠키가 이미 끝남(서버가 지웠다): 옛 모니터를 계속 보이지 않는다
  try{await tpost('/api/lab/live/session',{},H(),10000);if(a!==AG)return;LLIVE.start()}catch(e){if(a===AG)say('모임 화면 세션을 열지 못했습니다. 다시 확인하세요. '+cleanErr(e.message),'bad')}
  }
  $('loginNote').textContent='';view();if(MON)mKick();
  const c=await api('/api/lab/config',{},H());if(a!==AG||!adm())return;LO=c.labOrigin;Q=c.quota;if(Number.isInteger(c.maxSeats)&&c.maxSeats>0&&c.maxSeats<=128)CMAX=c.maxSeats;
  if(!CFG){opt('l_hours',c.hours,h=>h+'시간',3);opt('l_budget',c.budgets,b=>'$'+b,2);
   shareForm(c);$('l_gw').value=c.cfg.gw;if(c.cfg.clip){$('l_cin').checked=c.cfg.clip.in;$('l_cout').checked=c.cfg.clip.out}$('l_snap').value=c.cfg.snapshot;$('l_model').value=c.cfg.model;
   if(!c.cfg.gw)$('l_gw').closest('details').open=true;CFG=true}
  const w=[];if(!c.daytona)w.push('Daytona 키가 없습니다 — PC 에서 kv.ps1 push');if(!c.openrouter)w.push('OpenRouter 관리 키가 없습니다 — kv.ps1 push');
  $('warn').hidden=!w.length;$('warn').textContent=w.join(' · ');$('warn').className='bad';total();await load()
}
let adminBootBusy=false;
async function restoreAdmin(g,a){if(adminBootBusy||T||LOP)return;adminBootBusy=true;try{const L=await tpost('/api/lab/admin/session',{},{},10000);if(g!==LG||a!==AG||LOP||T)return;await openAdmin(L,a,false)}catch(e){if(g===LG&&a===AG){if(T)say('관리 인증은 복원됐지만 설정을 불러오지 못했습니다. 새로고침해 다시 시도해 주세요.','bad');else if(e.status!==401){$('loginNote').textContent='관리 세션을 확인하지 못했습니다. 다시 확인하거나 보안 키로 여세요.';$('mRetry').hidden=false}}}finally{adminBootBusy=false}}
$('go').onclick=()=>login();$('reauth').onclick=()=>login();
setInterval(()=>{if(adm()&&!bigId&&!document.hidden)load(true).catch(()=>{})},15000);
// 새 수업 결과는 만들기 버튼 바로 밑(l_msg)에 — 폰에서는 #msg 가 수업 목록 맨 아래라 화면 밖이다
const lsay=(t,cls)=>{const e=$('l_msg');e.textContent=t;e.className=cls||'';try{e.scrollIntoView({block:'nearest'})}catch{}};
// 공급자 오류 문구: script·style 내용과 태그, 토큰 모양을 지우고 200자까지 (textContent 로만 넣는다)
const cleanErr=t=>String(t==null?'':t).replace(/<(script|style)\\b[\\s\\S]*?(?:<\\/\\1\\s*>|$)/gi,' ').replace(/<[^>]*>?/g,' ').replace(/(bearer\\s+)\\S+/gi,'$1…').replace(/\\b(?:kvt_|sk-)[\\w-]{8,}/g,'…').replace(/\\s+/g,' ').trim().slice(0,200)||'알 수 없는 오류';
const failed=lab=>lab.seats.filter(s=>s.error);const usable=lab=>lab.seats.some(s=>!s.error);
const firstErr=lab=>cleanErr((failed(lab)[0]||{}).error);
const failNote=lab=>failed(lab).length+'/'+lab.seats.length+'자리 실패 — 첫 오류: '+firstErr(lab);
// 접수한 만들기 작업은 ID로만 복구한다. 저장소에는 ID와 버전만 — 입력·관리 토큰·초대 링크는 저장하지 않는다.
const OP_KEY='labCreateOperation',OP_RE=/^lc_[0-9]{13}_[0-9a-f]{32}$/;
let making=false,OP=null,opStore=false,CMAX=20;
const opDone=()=>OP&&['completed','ended','preparingRestored','not-started'].includes(OP.state);
function opSave(){try{if(OP)sessionStorage.setItem(OP_KEY,JSON.stringify({v:1,requestId:OP.id}));else sessionStorage.removeItem(OP_KEY)}catch{opStore=true}}
function opPaint(){const active=!!OP;$('l_make').disabled=making||active;$('l_recheck').hidden=!active||!!opDone();$('l_recheck').disabled=making||!adm();
 $('createAlert').hidden=!active||!!opDone();
 $('l_new').hidden=!opDone();$('l_new').disabled=making||!adm();$('l_reauth').hidden=!active||adm();$('l_msg').dataset.state=OP?OP.state:''}
function opNote(t,c){lsay(t+(opStore?' 이 브라우저가 복구 ID 저장을 막았습니다. 새로고침하면 이 작업을 복원할 수 없으니 이 탭을 유지하세요.':''),c);opPaint()}
function opUnknown(t){if(!OP)return;OP.state='unknown';opNote(t||'결과를 모릅니다 — 수업이 이미 만들어졌을 수 있습니다. 만들기를 다시 보내지 않고 "결과 복구"로 이 작업만 확인하세요.','bad')}
function opNotStarted(reason){if(!OP)return;OP.state='not-started';OP.sent=null;opNote((reason?cleanErr(reason)+' ':'')+'수업·실습실은 생성하지 않았습니다. 자동으로 다시 만들지 않습니다. "새 수업 입력으로 돌아가기"를 눌러 사양을 수정한 뒤 직접 만드세요.','bad')}
// 처음 누른 관리 세대·작업을 끝까지 묶는다. 새 인증은 옛 만들기 의도를 이어받지 않는다.
const opIntent=()=>({a:AG,id:OP.id,op:OP});
const opSame=i=>OP===i.op&&OP.id===i.id;
const opLive=i=>opSame(i)&&i.a===AG&&adm();
function opContinue(i){if(!opSame(i))return false;if(opLive(i))return true;
 opUnknown('관리 인증이 바뀌었거나 시간이 끝나 이전 요청의 대기를 멈췄습니다. 보안 키로 다시 확인한 뒤 "결과 복구"를 누르세요.');return false}
try{const raw=sessionStorage.getItem(OP_KEY);if(raw){const x=raw.length<180?JSON.parse(raw):null;
 if(!x||x.v!==1||typeof x.requestId!=='string'||x.requestId.length!==49||!OP_RE.test(x.requestId)||Object.keys(x).length!==2)throw new Error('invalid operation');
 OP={id:x.requestId,state:'unknown',sent:null};opNote('이 탭의 만들기 작업 ID를 복원했습니다. 보안 키로 다시 확인한 뒤 "결과 복구"를 누르세요. 자동으로 수업을 만들지 않습니다.','mut');$('newLab').open=true}}
catch{try{sessionStorage.removeItem(OP_KEY)}catch{opStore=true}lsay('저장된 복구 기록을 읽지 못했습니다. 자동으로 수업을 만들지 않습니다. 진행 중 수업 목록을 확인한 뒤 새 수업을 직접 만드세요.','bad')}
// JSON 아닌 성공·5xx도 결과 미확정이다. 관리 401은 별도로 알리고 읽기 전용 권한으로 재시도하지 않는다.
async function opPost(path,body,i){const headers=H(),a=AG,c=new AbortController(),ms=path==='/api/lab/create-status'?10000:180000;let tm;
 const late=new Promise((_,no)=>{tm=setTimeout(()=>{const e=new Error('결과 응답을 기다리는 시간이 끝났습니다');e.name='Timeout';no(e);c.abort()},ms)});
 try{return await Promise.race([(async()=>{const r=await fetch(path,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body),signal:c.signal});
  let j;try{j=await r.json()}catch{const e=new Error('HTTP '+r.status);e.status=r.status;if(r.status===401&&a===AG&&(!i||opSame(i)))admExpired();throw e}
  if(!r.ok){const e=new Error(cleanErr(j&&j.error||('HTTP '+r.status)));e.status=r.status;e.json=!!j&&typeof j==='object'&&!Array.isArray(j)&&typeof j.error==='string';if(r.status===401&&a===AG&&(!i||opSame(i)))admExpired();throw e}return j})(),late])}
 finally{clearTimeout(tm)}}
const SNAP_POLL=5000,SNAP_MAX=8*60000,SNAP_RE=/^[\\w./:-]{1,160}$/,SNAP_ST=/^[a-z][a-z_-]{0,23}$/;
const snapPending=r=>!!r&&typeof r==='object'&&r.snapshotPreparing===true&&typeof r.snapshot==='string'&&SNAP_RE.test(r.snapshot);
const snapReady=r=>!!r&&typeof r==='object'&&r.snapshotReady===true&&typeof r.snapshot==='string'&&SNAP_RE.test(r.snapshot);
const snapFor=(r,q)=>{const t='-'+q.cpu+'c'+q.memory+'g'+(PRESETS.includes(q.cpu+'/'+q.memory+'/'+q.disk)?'':q.disk+'d');return q.snapshot?r.snapshot===q.snapshot+t:r.snapshot.length>t.length&&r.snapshot.endsWith(t)};
const mmss=ms=>{const s=Math.max(0,Math.floor(ms/1000));return Math.floor(s/60)+'분 '+(s%60)+'초'};
const snapLater=' 수업은 아직 만들지 않았습니다. 접수된 스냅샷 준비는 계속될 수 있습니다. "결과 복구"로 같은 작업을 확인하세요.';
const snapOver=name=>{OP.state='pending';opNote(mmss(SNAP_MAX)+' 안에 스냅샷 '+name+' 준비를 확인하지 못해 기다리기를 멈췄습니다.'+snapLater,'bad');return 0};
async function snapPoll(q,ms,i){const a=AG,c=new AbortController();let tm,watch;
 const late=new Promise((_,no)=>{tm=setTimeout(()=>{const e=new Error('snapshot poll timeout');e.name='SnapTimeout';no(e);c.abort()},ms);
  if(i)watch=setInterval(()=>{if(!opLive(i)){const e=new Error('snapshot intent ended');e.name='SnapStopped';no(e);c.abort()}},250)});
 try{return await Promise.race([(async()=>{const r=await fetch('/api/lab/snapshot',{method:'POST',headers:{'content-type':'application/json',...H()},body:JSON.stringify(q),signal:c.signal});
  const j=await r.json().catch(()=>({error:'HTTP '+r.status}));if(!r.ok){const e=new Error(cleanErr(j.error||('HTTP '+r.status)));e.status=r.status;if(r.status===401&&a===AG&&(!i||opSame(i)))admExpired();throw e}return j})(),late])}
 finally{clearTimeout(tm);clearInterval(watch)}}
async function snapWait(base,first,i){if(!opContinue(i))return 0;const name=first.snapshot,t0=Date.now(),end=t0+SNAP_MAX;let r=first;
 const q={snapshot:base.snapshot,cpu:base.cpu,memory:base.memory,disk:base.disk};OP.state='pending';opPaint();
 for(;;){if(!opContinue(i))return 0;const st=typeof r.state==='string'&&SNAP_ST.test(r.state)?' · 상태 '+r.state:'';
  opNote('스냅샷 '+name+' 준비 중 ('+mmss(Date.now()-t0)+' 지남'+st+'). 처음 쓰는 사양은 몇 분 걸릴 수 있고, 같은 사양은 다음부터 바로 씁니다. 준비되면 처음 입력으로 수업을 한 번만 만듭니다 — 아직 수업은 만들지 않았습니다.','mut');
  if(Date.now()>=end)return snapOver(name);const next=Math.min(end,Date.now()+SNAP_POLL);
  while(Date.now()<next){await new Promise(f=>setTimeout(f,Math.min(250,next-Date.now())));if(!opContinue(i))return 0}
  if(Date.now()>=end)return snapOver(name);
  try{r=await snapPoll(q,end-Date.now(),i)}catch(e){if(!opContinue(i))return 0;if(e.name==='SnapTimeout'||Date.now()>=end)return snapOver(name);
   opNote(e.status===401||e.name==='AdminExpired'?'관리 시간이 끝났습니다. 보안 키로 다시 확인한 뒤 "결과 복구"를 누르세요.'+snapLater:'스냅샷 준비 상태를 확인하지 못했습니다: '+cleanErr(e.message)+'.'+snapLater,'bad');return 0}
  if(!opContinue(i))return 0;if(Date.now()>=end)return snapOver(name);if(snapReady(r)&&r.snapshot===name)return end;
  if(!snapPending(r)||r.snapshot!==name){opNote('스냅샷 상태 응답을 알아볼 수 없어 멈췄습니다.'+snapLater,'bad');return 0}}}
// 결과는 고정된 작은 요약만. 전체 관리 목록은 별도로 읽고 초대는 기존 보호 경로로만 받는다.
const opSummary=l=>!!l&&typeof l==='object'&&typeof l.id==='string'&&l.id.length>0&&l.id.length<=80&&typeof l.name==='string'&&l.name.length<=80&&
 Number.isSafeInteger(l.createdAt)&&l.createdAt>0&&Number.isSafeInteger(l.expiresAt)&&l.expiresAt>=l.createdAt&&Number.isInteger(l.seatCount)&&l.seatCount>0&&l.seatCount<=CMAX&&Object.keys(l).length===6&&Number.isInteger(l.failedSeats)&&l.failedSeats>=0&&l.failedSeats<=l.seatCount;
async function opComplete(r,i){if(!opContinue(i))return;if(!OP||!r||typeof r!=='object'||r.requestId!==OP.id||r.creationState!=='completed'||r.ok!==true||r.snapshotPreparing!==undefined||r.snapshotReady!==undefined||r.creationPending===true||!opSummary(r.lab))return opUnknown('결과 응답을 알아볼 수 없어 멈췄습니다. "결과 복구"로 같은 작업을 확인하세요.');
 if(OP.sent){const q=JSON.parse(OP.sent);if($('l_name').value===q.name)$('l_name').value='';if($('l_mat').value.trim()===q.materials)$('l_mat').value=''}
 OP.state='completed';OP.sent=null;const l=r.lab,t=l.failedSeats===l.seatCount?'수업은 만들어졌지만 자리를 하나도 준비하지 못했습니다. 위 수업 카드에서 확인하고 "지금 끝내기"로 정리하세요.':l.failedSeats?'만들었습니다. '+l.failedSeats+'/'+l.seatCount+'자리 실패 — 위 수업 카드에서 확인하세요.':'만들었습니다. 위 수업 카드의 자리 표 "초대"로 자리마다 QR·링크를 주세요.';
 opNote(t,l.failedSeats?'bad':'ok');try{await load();if(opContinue(i))opNote(t,l.failedSeats?'bad':'ok')}catch(e){if(opContinue(i))opNote(t+' (목록 새로고침 실패: '+cleanErr(e.message)+')',l.failedSeats?'bad':'ok')}}
async function opDispatch(i,final=false){if(!opContinue(i))return;let r;OP.state='pending';opNote('만드는 중… 자리마다 서브키·실습실을 만듭니다 (1~2분). 이 탭을 유지하세요.','mut');
 try{r=await opPost('/api/lab/create',JSON.parse(OP.sent),i)}catch(e){if(!opContinue(i))return;return opUnknown(e.status===401||e.name==='AdminExpired'?'관리 시간이 끝났습니다. 보안 키로 다시 확인한 뒤 "결과 복구"를 누르세요.':e.json&&e.status<500?'만들지 못했습니다: '+cleanErr(e.message)+'. "결과 복구"로 접수 기록을 확인하세요.':undefined)}
 if(!opContinue(i))return;
 if(snapPending(r)&&r.creationState==='preparing'&&r.creationPending!==true&&!r.lab&&r.requestId===OP.id&&snapFor(r,JSON.parse(OP.sent))){if(final){OP.state='pending';return opNote('서버가 스냅샷을 아직 준비 중이라고 합니다.'+snapLater,'mut')}const end=await snapWait(JSON.parse(OP.sent),r,i);if(!opContinue(i)||!end)return;if(Date.now()>=end)return snapOver(r.snapshot);return opDispatch(i,true)}
 if(r&&r.requestId===OP.id&&r.creationState==='running'){OP.state='pending';return opNote('서버에서 수업을 만드는 중입니다. "결과 복구"로 진행 결과를 확인하세요.','mut')}
 if(r&&r.requestId===OP.id&&r.creationState==='unknown')return opUnknown();
 return opComplete(r,i)}
$('l_make').onclick=async()=>{if(making||OP)return;const rs=spec();if(!rs)return lsay('CPU·메모리·디스크는 1 이상 정수(숫자만)로 적어 주세요.','bad');
 try{H()}catch(e){return lsay(e.message,'bad')}
 const [cpu,memory,disk]=rs;let id;try{const b=crypto.getRandomValues(new Uint8Array(16));id='lc_'+Date.now()+'_'+Array.from(b,x=>x.toString(16).padStart(2,'0')).join('')}catch{return lsay('이 브라우저에서 안전한 작업 ID를 만들 수 없습니다.','bad')}
 const sent=JSON.stringify({name:$('l_name').value,seats:Number($('l_seats').value),hours:Number($('l_hours').value),budget:Number($('l_budget').value),cpu,memory,disk,gw:$('l_gw').value.trim(),snapshot:$('l_snap').value.trim(),model:$('l_model').value.trim(),materials:$('l_mat').value.trim(),clipIn:$('l_cin').checked,clipOut:$('l_cout').checked,share:sharePicked(),requestId:id});
 OP={id,sent,state:'pending'};opSave();making=true;opPaint();const i=opIntent();try{await opDispatch(i)}finally{if(opSame(i)){making=false;opPaint()}}};
$('l_recheck').onclick=async()=>{if(making||!OP)return;making=true;opPaint();const i=opIntent();
 try{const r=await opPost('/api/lab/create-status',{requestId:i.id},i);if(!opContinue(i))return;
  if(!r||r.requestId!==OP.id)return opUnknown('복구 응답을 알아볼 수 없습니다. 만들기를 다시 보내지 말고 "결과 복구"로 확인하세요.');
  if(r.creationState==='not-started'&&!r.lab&&!r.snapshotPreparing&&r.creationPending!==true)return opNotStarted('이 요청은 자원 생성 단계 전에 중단됐습니다. 스냅샷 준비가 접수됐다면 별도로 계속될 수 있습니다.');
  if(r.creationState==='completed')return await opComplete(r,i);
  if(r.creationState==='preparing'&&r.creationPending!==true&&!r.lab&&snapPending(r)){if(OP.sent&&!snapFor(r,JSON.parse(OP.sent)))return opUnknown('복구 응답의 스냅샷이 처음 입력과 달라 멈췄습니다. 만들기를 다시 보내지 말고 결과를 확인하세요.');if(OP.sent){const end=await snapWait(JSON.parse(OP.sent),r,i);if(opContinue(i)&&end&&Date.now()<end)await opDispatch(i)}
   else{OP.state='preparingRestored';opNote('이 작업은 스냅샷 준비만 접수했고 수업은 아직 만들지 않았습니다. 새로고침으로 원래 입력은 지웠습니다. 준비는 계속될 수 있습니다 — "새 수업 입력으로 돌아가기"를 눌러 입력을 확인하고 직접 만드세요.','mut')}return}
  if(r.creationState==='running'){OP.state='pending';return opNote('서버에서 수업을 만드는 중입니다. 잠시 뒤 "결과 복구"로 같은 작업을 확인하세요.','mut')}
  return opUnknown('서버가 생성 결과를 확정하지 못했습니다. 관리 목록에서 이 작업의 수업을 확인하고 필요하면 끝낸 뒤 "결과 복구"로 종료를 확인하세요. 찾을 수 없으면 복구 기록이 종료될 때까지 새 생성은 막습니다.');
 }catch(e){if(!opContinue(i))return;if(e.json&&(e.status===404||e.status===410)){OP.state='ended';OP.sent=null;return opNote(e.status===410?'이 작업 또는 수업이 끝났습니다. 다시 만들지 않았습니다. 새 수업은 입력을 확인한 뒤 직접 시작하세요.':'서버에 이 작업의 생성 기록이 없습니다. 다시 보내지 않았습니다. 새 수업은 입력을 확인한 뒤 직접 시작하세요.','mut')}
  opUnknown(e.status===401||e.name==='AdminExpired'?'결과 복구는 보안 키로 다시 확인한 뒤 할 수 있습니다. 읽기 전용 모니터 권한은 그대로입니다.':'결과를 복구하지 못했습니다: '+cleanErr(e.message)+'. 만들기를 다시 보내지 말고 "결과 복구"로 확인하세요.')
 }finally{if(opSame(i)){making=false;opPaint()}}};
$('l_new').onclick=()=>{if(making||!adm()||!opDone())return;OP=null;opSave();$('l_msg').textContent='입력을 확인한 뒤 "만들기"를 누르면 새 작업 ID로 시작합니다.';opPaint()};
// 나눠 줄 API 키: 공급자마다 체크 + 자리당 상한. 마지막 선택(labcfg)이 기본값
function shareForm(c){const box=$('l_share');box.replaceChildren();const last=c.cfg.share||{};
 if(!c.shareable.length){const p=document.createElement('p');p.className='mut';p.textContent='나눠 줄 수 있는 키가 없습니다 — /admin 공급자 목록에서 "실습실에 나눠 줄 수 있음" 을 켜세요.';box.append(p);return}
 for(const x of c.shareable){const r=document.createElement('div');r.className='row';const l=document.createElement('label');const i=document.createElement('input');i.type='checkbox';i.value=x.id;i.checked=x.id in last;i.dataset.share='1';
  l.append(i,' '+x.label+' ('+x.envKey+')');const n=document.createElement('input');n.type='text';n.inputMode='numeric';n.id='l_cap_'+x.id;n.value=String(last[x.id]||500);n.style.width='90px';n.style.margin='0';n.title='자리당 호출 수 상한';n.setAttribute('aria-label',x.label+' 자리당 호출 수');
  const u=document.createElement('span');u.className='mut';u.textContent='회/자리';u.style.alignSelf='center';r.append(l,n,u);box.append(r)}}
function sharePicked(){const o={};for(const i of document.querySelectorAll('#l_share input[data-share]'))if(i.checked)o[i.value]=Number($('l_cap_'+i.value).value);return o}
function shareRow(lab,x){const r=document.createElement('div');r.className='row';const l=document.createElement('label');const i=document.createElement('input');i.type='checkbox';i.checked=x.on;
 const n=document.createElement('input');n.type='text';n.inputMode='numeric';n.value=String(x.cap);n.style.width='90px';n.style.margin='0';n.title='자리당 호출 수 상한';n.setAttribute('aria-label',x.label+' 자리당 호출 수');
 const set=async(b)=>{try{const y=await api('/api/lab/share',{id:lab.id,provider:x.id,...b},H());x.on=y.share.on;x.cap=y.share.cap;i.checked=x.on;n.value=String(x.cap);say(x.label+': '+(x.on?'켬':'끔 — 바로 거부됩니다')+' · 자리당 '+x.cap+'회','ok')}catch(e){i.checked=x.on;n.value=String(x.cap);say(e.message,'bad')}};
 i.onchange=()=>set({on:i.checked});const s=btn('상한 저장','sec',()=>set({cap:Number(n.value)}));s.style.width='auto';s.style.padding='4px 8px';
 l.append(i,' '+x.label+' 켜기');const u=document.createElement('span');u.className='mut';u.textContent='회/자리';u.style.alignSelf='center';r.append(l,n,u,s);return r}
// 코드 보내기 (참가자 VS Code 막대의 📥 받은 코드). 15초마다 카드를 다시 그려도 쓰던 글이 남게 수업마다 같은 요소를 다시 붙이고, 쓰던 칸의 포커스도 돌려준다
const SN={};let SNF=null;const inSnip=e=>e.target&&e.target.closest&&e.target.closest('[data-snip]');
document.addEventListener('focusin',e=>{SNF=inSnip(e)?e.target:null});document.addEventListener('pointerdown',e=>{if(!inSnip(e))SNF=null},true);
function snipBox(lab){let S=SN[lab.id];
 if(!S){S=SN[lab.id]={v:0};const d=S.el=document.createElement('div');d.dataset.snip=lab.id;d.style.cssText='border-top:1px solid var(--line);margin-top:12px;padding-top:8px';
  const h=document.createElement('b');h.textContent='보낼 내용';const p=document.createElement('p');p.className='mut';p.textContent='대상은 참여자 받은 코드입니다. 글만 가고, 터미널은 실행하지 않습니다. 10초 안에 뜨면 참여자가 눌러 복사합니다 (최근 30개).';
  const tiL=document.createElement('label');tiL.className='mut';tiL.textContent='제목 (선택)';
  const ti=S.ti=document.createElement('input');ti.type='text';ti.maxLength=60;ti.id='snTitle_'+lab.id;tiL.htmlFor=ti.id;
  const taL=document.createElement('label');taL.className='mut';taL.textContent='보낼 코드';
  const ta=S.ta=document.createElement('textarea');ta.rows=5;ta.spellcheck=false;ta.id='snBody_'+lab.id;taL.htmlFor=ta.id;ta.setAttribute('aria-label','보낼 코드');
  ta.style.cssText='font:13px/1.5 ui-monospace,Consolas,monospace;width:100%;padding:10px;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--fg);margin:4px 0 8px;resize:vertical;tab-size:4;white-space:pre;overflow:auto';
  ta.onkeydown=e=>{if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){e.preventDefault();snipSend(lab.id)}};
  S.btn=btn('보내기','',()=>snipSend(lab.id));S.list=document.createElement('div');d.append(h,p,tiL,ti,taL,ta,S.btn,S.list)}
 snipLoad(lab.id);
 if(SNF&&S.el.contains(SNF))setTimeout(()=>{if(!document.activeElement||document.activeElement===document.body)SNF.focus({preventScroll:true})});
 return S.el}
async function snipLoad(id){try{snipList(id,await api('/api/lab/snips',{id},H()))}catch{}}
async function snipSend(id){const S=SN[id];if(!S.ta.value.trim())return say('보낼 내용을 넣으세요.','bad');S.btn.disabled=true;
 try{const r=await api('/api/lab/snip',{id,text:S.ta.value,title:S.ti.value.trim()},H());S.ta.value='';S.ti.value='';snipList(id,r);say('보냈습니다 — 참가자 화면에 10초 안에 뜹니다.','ok')}catch(e){say(e.message,'bad')}S.btn.disabled=false}
async function snipDel(id,snip){try{snipList(id,await api('/api/lab/snip-delete',{id,snip},H()));say(snip==='all'?'보낸 코드를 모두 지웠습니다.':'지웠습니다 — 참가자 화면에서도 사라집니다.','ok')}catch(e){say(e.message,'bad')}}
function snipList(id,d){const S=SN[id];if(d.v<S.v)return;S.v=d.v;S.list.replaceChildren();if(!d.items.length)return;
 const t=document.createElement('table');
 for(const x of d.items){const tr=t.insertRow();const tc=tr.insertCell();tc.textContent=fmt(x.at);tc.style.whiteSpace='nowrap';const c=tr.insertCell();
  if(x.title){const b=document.createElement('b');b.textContent=x.title;c.append(b)}
  const pv=document.createElement('div');pv.className='mut';pv.style.cssText='font:12px/1.4 ui-monospace,Consolas,monospace;white-space:pre;overflow:hidden;text-overflow:ellipsis;max-width:340px';pv.textContent=x.text.split('\\n').slice(0,2).join('\\n').slice(0,160);pv.title=x.text.slice(0,2000);c.append(pv);
  const del=btn('삭제','sec',()=>snipDel(id,x.id));del.style.cssText='width:auto;padding:4px 8px';tr.insertCell().append(del)}
 S.list.append(t);
 if(d.items.length>1){const a=btn('모두 지우기','sec',()=>{if(confirm('보낸 코드 '+d.items.length+'개를 모두 지울까요? 참가자 화면에서도 사라집니다.'))snipDel(id,'all')});a.style.cssText='width:auto;padding:4px 8px;margin-top:6px';S.list.append(a)}}
// 자리 초대 링크는 목록에 싣지 않고, 누를 때마다 /api/lab/invite 로 받는다 (기록이 남는다)
const fresh=p=>{const g=AG;return p.then(x=>{if(g!==AG||!adm())throw new Error(AUTH_MSG+'해 주세요.');return x})};
const invite=(lab,n)=>api('/api/lab/invite',n===undefined?{id:lab.id}:{id:lab.id,n},H());
// 참가자 상태 (Teams 비슷하게). 서버 시계 기준(d.now)으로 '몇 분 전'
let SK=0;const dur=s=>s<3600?Math.max(1,Math.floor(s/60))+'분':Math.floor(s/3600)+'시간';const ago=t=>{const s=Math.floor((Date.now()+SK-t)/1000);return s<60?'방금':dur(s)+' 전'};
const btn=(t,cls,f)=>{const b=document.createElement('button');b.className=cls;b.textContent=t;b.onclick=f;return b};
const copy=async(b,text)=>{await navigator.clipboard.writeText(text);const o=b.textContent;b.textContent='복사됨';setTimeout(()=>b.textContent=o,1500)};
const joined=lab=>lab.seats.filter(s=>!s.error&&typeof s.opened==='number'&&Number.isFinite(s.opened)&&s.opened>0).length+' / '+lab.seats.filter(s=>!s.error).length+' 명 입장';
function showBig(lab,inv){closeUtilityDialogs();bigId=lab.id;$('bigName').textContent=lab.name+' · '+inv.n+'번'+(inv.who?' '+inv.who:'');$('bigQr').innerHTML=inv.qr;$('bigUrl').textContent=inv.link.replace(/^https?:[/][/]/,'');$('bigCount').textContent=joined(lab);
 $('big').hidden=false;$('big').style.display='flex';bigHands(HL);clearInterval(bigTimer);bigTimer=setInterval(()=>{if(adm())load(true).catch(()=>{})},5000)}
// 닫을 때마다(로그아웃·관리 만료 포함) 초대 QR·링크 글자·이름·인원·손 요약을 숨긴 DOM 에도 남기지 않는다. 다시 열면 showBig 이 새로 채운다
function closeBig(){bigId=null;clearInterval(bigTimer);$('big').hidden=true;$('big').style.display='none';$('bigQr').replaceChildren();for(const k of ['bigUrl','bigName','bigCount','bigHands'])$(k).textContent=''}
$('bigClose').onclick=closeBig;$('big').style.display='none';
// 수업 목록 카드·자리 표 그리기: client/lab-renderer.ts (npm run build:lab-renderer). 토큰·api 는 넘기지 않고 아래 콜백으로만 서버를 부른다
${LAB_RENDERER_JS}
${LAB_CONTROL_JS}
${LAB_TRIAL_JS}
${LAB_INTERRUPT_JS}
${LAB_CHECKPOINT_JS}
${LAB_RECOVERY_JS}
${LAB_ASSISTANTS_JS}
${LAB_TERMINAL_JS}
const LCTL=createLabControl({btn,cleanErr,call:(path,body)=>fresh(api(path,body,H()))});
const LTRIAL=createLabTrial({btn,cleanErr,fmt,now:()=>Date.now()+SK,call:(path,body)=>fresh(api(path,body,H()))});
const LT=createLabTerminal({btn,copy,cleanErr,control:LCTL,trial:LTRIAL,call:(path,body)=>fresh(api(path,body,H()))});
const LINT=createLabInterrupt({btn,cleanErr,control:LCTL,fmt,now:()=>Date.now()+SK,call:(path,body)=>fresh(api(path,body,H()))});
const LCKPT=createLabCheckpoints({btn,cleanErr,control:LCTL,fmt,call:(path,body)=>fresh(api(path,body,H()))});
const LREC=createLabRecovery({btn,cleanErr,control:LCTL,reload:()=>load(),call:(path,body)=>fresh(api(path,body,H()))});
const LASSIST=createLabAssistants({api:(path,body)=>fresh(tpost(path,body,H(),10000))});
const LR=createLabRenderer({now:()=>Date.now()+SK,fmt,dur,ago,cleanErr,joined,usable,failed,failNote,firstErr,btn,copy,say,
 shareRow,screenRow:lab=>screenRow(lab),sharing:id=>!!SH[id],omitScreen:()=>liveGalleryOn(),selectedId:()=>RID,controlDock:()=>!!$('deliveryDock'),helpSeat:(id,n)=>openSeat(id,n),snipBox,controlBox:lab=>LCTL.box(lab),trialBox:lab=>LTRIAL.box(lab),terminalBox:lab=>LT.box(lab),interruptBox:lab=>LINT.box(lab),checkpointBox:lab=>LCKPT.box(lab),recoveryBox:lab=>LREC.box(lab),assistantBox:lab=>LASSIST.button(lab),
 inviteAll:lab=>fresh(invite(lab)),inviteSeat:(lab,n)=>fresh(invite(lab,n)),showInvite:(lab,inv)=>showBig(lab,inv),
 setClip:(id,c)=>api('/api/lab/clip',{id,...c},H()),lowerHand:(id,n)=>api('/api/lab/hand',{id,n},H()).then(x=>{mKick();return x}),endLab:id=>api('/api/lab/end',{id},H()),reload:()=>load()});
// 전체 목록(공급자 상태까지 묻는 비싼 조회): 관리 시간 동안만 15초마다. 손 요약은 모니터가 없을 때만 여기서 (있으면 3초 모니터가)
let LD=null,LOK=0,LERR='',NEWSEEN=false,RID=null,VIEWCHOSEN=false,HH=[];
function liveCall(name,arg){try{const fn=LLIVE[name];if(typeof fn==='function')fn(arg)}catch{}}
function liveMeta(labs){liveCall('setMetadata',labs||[])}
function liveRoom(id){for(const key in SH)if(SH[key].kind==='demo'&&key!==id)shStop(key,'모임을 바꿔 이전 시연 송출을 멈췄습니다.');if(!DEMO_WORKSPACE.isMounted(id))DEMO_WORKSPACE.clear();liveCall('setRoom',id||null)}
function liveSeat(id,n){try{if(typeof LLIVE.selectSeat==='function')LLIVE.selectSeat(id,n)}catch{}}
function liveGalleryOn(){try{return !!(LLIVE.hasSession?.()&&!$('liveTools').hidden)}catch{return false}}
function currentLabs(){return adm()&&LD?LD:(MON&&MD?MD:[])}
function remainText(expiresAt){if(typeof expiresAt!=='number'||!Number.isFinite(expiresAt))return '남은 시간 확인 필요';const minutes=Math.max(0,Math.ceil((expiresAt-(Date.now()+SK))/60000));return minutes?(minutes>=60?Math.floor(minutes/60)+'시간 ':'')+(minutes%60)+'분 남음':'종료 시각 지남'}
function commandLayout(){document.body.classList.toggle('lab-command-run',!$('panel').hidden&&!$('viewRun').hidden)}
function openRunTools(materials){const dialog=$('opsDialog');if(!dialog.open)dialog.showModal();if(materials){for(const section of dialog.querySelectorAll('[data-lab-section]'))if(section.dataset.labSection==='코드 보내기'){section.open=true;section.querySelector('summary')?.focus()}}}
$('runTools').onclick=()=>openRunTools(false);$('runMaterials').onclick=()=>openRunTools(true);$('opsClose').onclick=()=>$('opsDialog').close();
let pendingUtility=null;
function closeUtilityDialogs(){for(const id of ['opsDialog','prepDialog','settingsDialog','seatAddDialog'])if($(id).open)$(id).close()}
for(const [id,button] of [['prepDialog','navPrep'],['settingsDialog','navSet']])$(id).addEventListener('close',()=>$(button).setAttribute('aria-expanded',String($(id).open)));
$('prepClose').onclick=()=>{$('prepDialog').close();$('navSet').focus({preventScroll:true})};$('settingsClose').onclick=()=>$('settingsDialog').close();
function showView(v,focus){if(v!=='run'&&v!=='prep'&&v!=='set')return;closeUtilityDialogs();$('viewRun').hidden=false;$('viewPrep').hidden=false;$('viewSet').hidden=false;commandLayout();

 if(v==='prep'||v==='set'){if($('panel').hidden){pendingUtility=v;return}const dialog=$(v==='prep'?'prepDialog':'settingsDialog');dialog.showModal();$(v==='prep'?'navPrep':'navSet').setAttribute('aria-expanded','true');if(v==='prep')$('newLab').open=true;return}
 pendingUtility=null;if(focus){$('viewRunH').tabIndex=-1;$('viewRunH').focus({preventScroll:true})}}
function pickDefault(n){if(VIEWCHOSEN)return;VIEWCHOSEN=true;showView('run',false)}
function paintRoomStat(labs){BROADCAST_PREVIEW.sync();paintBroadcastDock();$('runAddSeat').disabled=!adm()||!RID||!(labs||[]).some(l=>l.id===RID&&!l.ending);const e=$('roomStat');if(!e)return;const l=(labs||[]).find(x=>x.id===RID);
 if(!l){e.textContent=labs&&labs.length?'모임을 고르세요.':(!adm()&&!MON&&LLIVE.hasSession?.()?'모임 상세 상태 확인 필요 · 화면 지원 연결은 유지됩니다.':'진행 중인 모임이 없습니다.');return}
 const entered=l.seats?joined(l):'입장 확인 필요';
 e.textContent=entered+' · '+remainText(l.expiresAt)}
function syncRooms(labs){const sel=$('roomSelect');if(!sel)return;const list=labs||[];const ids=list.map(l=>l.id);const prev=RID;
 sel.replaceChildren();const o0=document.createElement('option');o0.value='';o0.textContent=ids.length?'모임을 고르세요':'진행 중인 모임 없음';sel.append(o0);
 for(const l of list){const o=document.createElement('option');o.value=l.id;o.textContent=l.name||l.id;sel.append(o)}
 RID=prev&&ids.includes(prev)?prev:(ids[0]||null);sel.value=RID||'';liveRoom(RID);paintRoomStat(list)}
function paintShareHold(){paintBroadcastDock();const hold=$('shareHold');if(!hold)return;
 const live=liveGalleryOn();const covered=new Set([...document.querySelectorAll('#broadcastDock [data-screen-lab]')].map(r=>r.dataset.screenLab));
 if(live){for(const row of document.querySelectorAll('#liveTools [data-screen-lab],#broadcastDock [data-screen-lab]')){const id=row.dataset.screenLab;if(!id)continue;covered.add(id);
  if(SH[id]){const me=SH[id],b=row.querySelector('button');if(b&&!b.dataset.other){b.textContent='시연 송출 멈추기';b.className='bad'}const st=row.querySelector('[data-screen-status]');if(st){st.textContent=(me.startedAt?'송출 중':'연결 중…')+' · '+(me.kind==='demo'?'내 시연 · 원본 1920 × 1080':'외부 화면 공유');st.className='ok'}}}}
 else{for(const row of document.querySelectorAll('#labs [data-screen-lab]')){const id=row.dataset.screenLab;if(id)covered.add(id)}}
 const need=Object.keys(SH).filter(id=>!covered.has(id));
 const have=[...hold.children].map(n=>n.dataset.shareHold||'');
 if(need.length===have.length&&need.every((id,i)=>id===have[i])){hold.hidden=!need.length;return}
 hold.replaceChildren();
 for(const id of need){const labs=currentLabs();const row=screenRow((labs||[]).find(l=>l.id===id)||{id,name:id});row.dataset.shareHold=id;hold.append(row)}
 hold.hidden=!need.length}
function paintDeliveryDock(){const box=$('deliveryDock'),lab=adm()&&(LD||[]).find(l=>l.id===RID&&!l.ending);box.hidden=!lab;
 if(!lab){box.replaceChildren();return}const control=LCTL.box(lab);const note=control.querySelector('p:not([role])');if(note)note.textContent='새 명령 전달만 막습니다. 이미 실행 중인 프로그램은 계속됩니다.';if(box.firstElementChild!==control)box.replaceChildren(control)}
function repaintLabs(){if(adm()&&$('labs').dataset.mode==='admin'&&LD)LR.renderLabs($('labs'),LD);else if(MON&&$('labs').dataset.mode==='monitor'&&MD)LR.renderMonitor($('labs'),MD);paintShareHold();paintDeliveryDock();CLASSROOM.sync()}
function openSeat(id,n){VIEWCHOSEN=true;showView('run',false);RID=id;const sel=$('roomSelect');if(sel&&[...sel.options].some(o=>o.value===id))sel.value=id;const live=!!LLIVE.hasSession?.();if(live){liveRoom(id);liveSeat(id,n)}repaintLabs();if(!live||typeof LLIVE.selectSeat!=='function')jump(id,n)}
async function load(quiet){const g=AG;let d;try{d=await api('/api/lab/list',{},H())}catch(e){if(g===AG){LERR=cleanErr(e.message);paintFresh()}throw e}
 if(g!==AG||!adm())return; // 로그아웃·다시 확인·만료 사이에 온 응답: 상태·화면을 건드리지 않고 버린다
 LERR='';LOK=Date.now();LD=d.labs;Q=d.quota||Q;total();if(d.now)SK=d.now-Date.now();
 if(!MON)hands(d.labs);
 if(!NEWSEEN&&adm()){NEWSEEN=true;if(!d.labs.length)$('newLab').open=true} // 진행 중 모임이 없으면 새 수업을 펼쳐 둔다
 if(bigId){const l=d.labs.find(x=>x.id===bigId);if(l)$('bigCount').textContent=joined(l);if(quiet){syncRooms(d.labs);liveMeta(d.labs);paintFresh();paintShareHold();CLASSROOM.sync();return}}
 syncRooms(d.labs);liveMeta(d.labs);pickDefault((d.labs||[]).length);
 LR.renderLabs($('labs'),d.labs);$('labs').dataset.mode='admin';paintFresh();paintShareHold();paintDeliveryDock();CLASSROOM.sync()}
// 강사 화면 공유 (Cloudflare Realtime SFU): 이 탭이 화면을 올리고 참가자 VS Code 의 강사 화면 보기 창에 뜬다. 소리 없음. 탭을 닫으면 끊긴다
// 글자 읽기 좋게: 최대 1920px·15fps, contentHint text(해상도 유지), 2.5Mbps 상한 — SFU 는 GB 당 과금
const SH={},SH_START=new Map();let SS=null,SSat=0;
${LAB_DEMO_WORKSPACE_JS}
const DEMO_SEAT_DOMAIN=${js(seatDomain)};
const DEMO_WORKSPACE=createLabDemoWorkspace({root:$('demoWorkspaceFrame'),selected:()=>RID,authorized:()=>!LOP&&adm(),allowedOrigin:origin=>{try{const u=new URL(origin);if(['localhost','127.0.0.1'].includes(location.hostname))return u.protocol==='http:'&&['localhost','127.0.0.1'].includes(u.hostname);const suffix='.'+DEMO_SEAT_DOMAIN;return u.protocol==='https:'&&u.hostname.startsWith('s-')&&u.hostname.endsWith(suffix)&&/^[a-z0-9-]+$/.test(u.hostname.slice(2,-suffix.length))}catch{return false}},onStatus:text=>$('demoWorkspaceStatus').textContent=text,onError:error=>{for(const id in SH)if(SH[id].kind==='demo')shStop(id,'시연실 송출을 멈췄습니다. 다시 연결해 주세요.');$('demoWorkspaceStatus').textContent=error?.message||'시연실을 연결하지 못했습니다. 다시 연결을 눌러 주세요.';syncDemoSourceLayout()},onReady:()=>{syncDemoSourceLayout()},retry:()=>CLASSROOM.openDemo()});
${LAB_DEMO_BROADCAST_JS}
const DEMO_BROADCAST=window.createLabDemoBroadcast({root:()=>document.querySelector('#classMain .class-demo'),selected:()=>RID,authorized:()=>!LOP&&(adm()||!!LLIVE.hasSession?.()),onError:error=>{for(const id in SH)if(SH[id].kind==='demo')shStop(id,'시연 송출을 멈췄습니다. '+(error?.message||'시연 화면을 다시 확인하세요.'))}});
${LAB_BROADCAST_PREVIEW_JS}
const BROADCAST_PREVIEW=createLabBroadcastPreview({selected:()=>RID,workspace:()=>$('viewRun').dataset.workspace||'home',home:()=>{LLIVE.clearFocus?.();setWorkspace('home')},select:id=>{RID=id;$('roomSelect').value=id;liveRoom(id);paintRoomStat(currentLabs());repaintLabs()}});
const screenCall=(action,body)=>LLIVE.hasSession?.()?LLIVE.call('screen/'+action,body):api('/api/lab/screen/'+action,body,H());
const scrState=()=>{if(!SS||Date.now()-SSat>4000){SSat=Date.now();try{SS=screenCall('status',{}).then(x=>x.screens).catch(()=>({}))}catch{SS=Promise.resolve({})}}return SS};
function paintBroadcastDock(){const dock=$('broadcastDock'),lab=currentLabs()?.find(l=>l.id===RID&&!l.ending);
 if(!lab){dock.replaceChildren();return}
 let row=dock.firstElementChild;if(!row||row.dataset.screenLab!==lab.id){row=screenRow(lab);dock.replaceChildren(row)}else row.updateScreen?.();
}
function screenRow(lab){const r=document.createElement('div');r.className='row';r.style.alignItems='center';r.dataset.screenLab=lab.id;let version=0;
 const b=btn('시연 송출 시작','',()=>{const me=SH[lab.id];if(me||b.dataset.other)shStop(lab.id,'시연 송출을 멈췄습니다.');else shStart(lab)});b.style.width='auto';b.style.padding='6px 12px';
 const st=document.createElement('span');st.className='mut';st.dataset.screenStatus='1';st.setAttribute('role','status');st.style.flex='1';r.append(b,st);
 const more=document.createElement('details'),summary=document.createElement('summary'),external=btn('다른 탭·창 공유','sec',()=>{more.open=false;shStart(lab,true)});summary.textContent='다른 화면';more.className='broadcast-other';more.append(summary,external);r.append(more);
 r.updateScreen=()=>{const ticket=++version,me=SH[lab.id],pending=SH_START.has(lab.id),authorized=adm()||!!LLIVE.hasSession?.();
  delete b.dataset.other;b.textContent='시연 송출 시작';b.className='';b.disabled=pending||(!me&&!authorized);external.disabled=pending||!authorized;st.className='mut';
  st.textContent=pending?'시연 송출을 준비하고 있습니다…':authorized?'나만 보는 중 · 시작하면 참여자에게 보입니다':'송출하려면 보안 키로 다시 확인하세요';
  if(me){b.textContent='시연 송출 멈추기';b.className='bad';st.className='ok';st.textContent=(me.startedAt?'참여자에게 송출 중 · '+dur(Math.max(0,(Date.now()+SK-me.startedAt)/1000)):'연결 중…')+(me.kind==='demo'?' · 내 시연만 공유':' · 외부 화면 공유')}
  else if(authorized&&!pending)scrState().then(s=>{if(ticket!==version||!r.isConnected||SH[lab.id]||SH_START.has(lab.id))return;const x=s[lab.id];if(x&&x.on){b.dataset.other='1';b.disabled=false;b.textContent='🖥 화면 공유 멈추기';b.className='bad';st.className='bad';st.textContent='다른 탭의 공유가 남아 있습니다 · 멈춘 뒤 여기서 다시 시작하세요'}});
 };r.updateScreen();return r}
function shEnd(id){SH_START.delete(id);const me=SH[id];delete SH[id];BROADCAST_PREVIEW.detach(id);if(me){try{me.source?.stop()}catch{}try{me.s.getTracks().forEach(t=>t.stop())}catch{}try{LLIVE.untrackSend(me.pc)}catch{}try{me.pc.close()}catch{}}syncDemoSourceLayout()}
async function shStop(id,msg){shEnd(id);SS=null;try{await screenCall('stop',{id});say(msg,'ok')}catch(e){say('이 탭의 공유는 끊었습니다. 서버 상태 정리 실패: '+e.message+' — 참가자 화면은 1분 안에 저절로 닫힙니다.','bad')}load().catch(()=>{})}
async function shStart(lab,external=false){if(!adm()&&!LLIVE.hasSession?.()){say('송출하려면 보안 키로 다시 확인하세요.','bad');return}if(SH[lab.id]||SH_START.has(lab.id))return;const shareEpoch=LG,ticket={};SH_START.set(lab.id,ticket);const md=navigator.mediaDevices;
 if(!window.RTCPeerConnection||(external&&!md?.getDisplayMedia)){SH_START.delete(lab.id);say('이 브라우저는 송출을 지원하지 않습니다. PC의 크롬·엣지에서 여세요.','bad');return}
 let s,source;try{if(external)s=await md.getDisplayMedia({video:{frameRate:{ideal:15,max:15},width:{ideal:1920,max:1920},height:{ideal:1080,max:1080}},audio:false,selfBrowserSurface:'exclude'});else{LLIVE.clearFocus?.();setWorkspace('home');source=await (DEMO_WORKSPACE.isMounted(lab.id)?DEMO_WORKSPACE:DEMO_BROADCAST).open(lab.id);s=source.stream}}
 catch(e){if(SH_START.get(lab.id)===ticket)SH_START.delete(lab.id);if(shareEpoch!==LG||LOP)return;say(e?.name==='NotAllowedError'?'화면 공유를 취소했습니다.':'시연 송출을 시작하지 못했습니다. '+(e?.message||e),'bad');return}
 if(shareEpoch!==LG||LOP||RID!==lab.id||SH_START.get(lab.id)!==ticket){source?.stop();s.getTracks().forEach(t=>t.stop());return}SH_START.delete(lab.id);const t=s.getVideoTracks()[0];if(!t){source?.stop();s.getTracks().forEach(t=>t.stop());return}try{t.contentHint='text'}catch{}
 const pc=new RTCPeerConnection({iceServers:[{urls:'stun:stun.cloudflare.com:3478'}],bundlePolicy:'max-bundle'});
 const me={pc,s,source,kind:external?'external':'demo',startedAt:0,starting:true};SH[lab.id]=me;LLIVE.trackSend(pc,lab.id);LLIVE.clearFocus?.();if(external)BROADCAST_PREVIEW.attach(lab.id,me);syncDemoSourceLayout();load().catch(()=>{});
 t.onended=()=>{if(SH[lab.id]===me)shStop(lab.id,'브라우저에서 공유를 중지해 화면 공유를 멈췄습니다.')};
 pc.onconnectionstatechange=()=>{if(pc.connectionState==='failed'&&SH[lab.id]===me)shStop(lab.id,'화면 공유 연결이 끊겼습니다. 다시 시작하세요.')};
 try{const tr=pc.addTransceiver(t,{direction:'sendonly',streams:[s],sendEncodings:[{maxBitrate:2500000,maxFramerate:15}]});
  await pc.setLocalDescription(await pc.createOffer());
  const r=await screenCall('start',{id:lab.id,sdp:pc.localDescription.sdp,tracks:[{mid:tr.mid,trackName:'screen'}]});
  if(SH[lab.id]!==me)return;
  await pc.setRemoteDescription({type:'answer',sdp:r.sdp});me.startedAt=r.startedAt;me.starting=false;SS=null;
  try{const p=tr.sender.getParameters();p.degradationPreference='maintain-resolution';await tr.sender.setParameters(p)}catch{}
  say(external?'선택한 외부 화면을 공유합니다.':'내 시연을 송출합니다. 참여자 지원·모아보기로 전환해도 시연 화면은 유지됩니다.','ok')}
 catch(e){if(SH[lab.id]===me)shEnd(lab.id);say('화면 공유를 시작하지 못했습니다: '+e.message,'bad')}
 load().catch(()=>{})}
addEventListener('beforeunload',e=>{if(Object.keys(SH).length){e.preventDefault();e.returnValue=''}});
addEventListener('pagehide',()=>{for(const id in SH)fetch(LLIVE.hasSession?.()?'/api/lab/live/screen/stop':'/api/lab/screen/stop',{method:'POST',keepalive:true,headers:{'content-type':'application/json',...(adm()?{'x-admin-token':T}:{})},body:JSON.stringify({id})}).catch(()=>{})});
${LAB_LIVE_TEACHER_JS}
let workspaceReturn='home';
function syncDemoSourceLayout(){const run=$('viewRun'),main=$('classMain');if(!run.dataset.workspace)run.dataset.workspace='home';const home=run.dataset.workspace==='home',on=SH[RID]?.kind==='demo',mounted=DEMO_WORKSPACE.isMounted(RID)&&main.dataset.classView==='live',embedded=mounted&&main.dataset.classMode==='demo',show=home&&!run.hidden;const modes=main.querySelector('[data-class-modes]');if(embedded&&modes)$('demoWorkspaceModes').replaceChildren(modes);else if(!embedded)$('demoWorkspaceModes').replaceChildren();run.dataset.demoCapture=on&&!embedded?'on':'';run.dataset.demoMounted=embedded?'on':'';const dock=$('broadcastDock'),dockParent=embedded&&home?$('demoWorkspace').querySelector('header'):$('workspaceTabs');if(dock.parentElement!==dockParent)dockParent.append(dock);$('demoWorkspace').hidden=!mounted;$('demoWorkspace').dataset.parked=String(!show||!embedded);DEMO_WORKSPACE.setVisible(show&&embedded);main.inert=!home||embedded;if(home&&!embedded){const r=main.getBoundingClientRect();if(r.width>0){main.style.setProperty('--demo-source-width',r.width+'px');main.style.setProperty('--demo-source-height',Math.max(300,r.height)+'px')}}}
function setWorkspace(mode){const root=$('liveTools'),run=$('viewRun');BROADCAST_PREVIEW.small();if(mode==='gallery'){root.classList.add('gallery-focus');$('supportStage').append(root)}else{root.classList.remove('gallery-focus');const rail=$('classRail').querySelector('.work');if(root.parentElement!==rail)rail.prepend(root)}run.dataset.workspace=mode;$('workspaceGallery').textContent=mode==='gallery'?'내 시연 보기':'참여자 모아보기';$('workspaceGallery').setAttribute('aria-pressed',String(mode==='gallery'));$('workspaceHome').hidden=mode!=='support';$('workspaceHome').textContent=workspaceReturn==='gallery'?'모아보기로 돌아가기':'내 시연으로 돌아가기';$('workspaceFinish').hidden=mode!=='support';$('workspaceSize').hidden=mode!=='home';if(mode!=='support')$('workspaceStatus').textContent=mode==='gallery'?'전체 참여자 화면':'내 시연';syncDemoSourceLayout();BROADCAST_PREVIEW.sync()}
function workspaceFocus(value){const before=$('viewRun').dataset.workspace||'home';if(value){if(before!=='support')workspaceReturn=before==='gallery'?'gallery':'home';setWorkspace('support');$('workspaceStatus').textContent=(value.who||'입장 아이디 미입력')+' · '+value.n+'번 좌석 · '+(value.hand?'도움 요청':value.support?'참여자 지원':'화면 보기')}else setWorkspace(before==='support'?workspaceReturn:before)}
const LLIVE=createLabLiveTeacher({root:$('liveTools'),stage:$('supportStage'),onFocus:workspaceFocus,onHelpQueue:count=>{const badge=$('workspaceQueue');badge.hidden=!count;badge.textContent='도움 대기 '+count+'명'},canAutoOpen:()=>!LOP&&!$('viewRun').hidden&&$('classMain').dataset.classView==='live'&&!document.querySelector('dialog[open]'),btn,screenRow:()=>document.createDocumentFragment(),call:(path,body)=>tpost(path,body,{},10000),onSession:()=>{if(LOP)return;view();setTimeout(()=>{if(!LOP)repaintLabs()},0)},endedLab:id=>{shEnd(id);SS=null},ended:()=>{for(const id in SH)shEnd(id);SH_START.clear();SS=null}});
$('workspaceHome').onclick=()=>LLIVE.clearFocus?.();
$('workspaceFinish').onclick=()=>LLIVE.finishSupport?.();
$('workspaceGallery').onclick=()=>{const mode=$('viewRun').dataset.workspace==='gallery'?'home':'gallery';LLIVE.clearFocus?.();setWorkspace(mode)};
$('workspaceSize').onclick=()=>{const large=$('viewRun').dataset.demoSize!=='large';$('viewRun').dataset.demoSize=large?'large':'';$('workspaceSize').textContent=large?'시연 작게 보기':'시연 크게 보기';$('workspaceSize').setAttribute('aria-pressed',String(large));syncDemoSourceLayout()};
$('workspaceFull').onclick=()=>{const stage=($('viewRun').dataset.workspace||'home')==='home'?(DEMO_WORKSPACE.isMounted(RID)?$('demoWorkspace'):$('classMain')):$('supportStage');if(document.fullscreenElement)document.exitFullscreen().catch(()=>{});else stage.requestFullscreen?.().catch(()=>say('전체 화면을 열지 못했습니다.','bad'))};
addEventListener('fullscreenchange',()=>{$('workspaceFull').textContent=document.fullscreenElement?'전체 화면 나가기':'전체 화면';syncDemoSourceLayout()});
new ResizeObserver(()=>{if(($('viewRun').dataset.workspace||'home')==='home')syncDemoSourceLayout()}).observe($('classMain'));
const SW_URL=${js(TEACHER_SW)},SW_SCOPE=${js(TEACHER_SCOPE)};
// ── 모니터: POST /api/lab/teacher/status (빈 본문, same-origin 쿠키). 보이는 탭에서만 3초마다, 한 번에 하나, 요청마다 10초 상한
// (응답 JSON 읽기까지). 401 이면 멈추고 화면 상태를 지운 뒤 보안 키를 묻는다. 탭이 다시 보이면 바로 한 번. 옛 데이터를 실시간처럼 보이지 않는다
let MON=null,MONERR='',MD=null,MOK=0,MERR='',mBusy=false,mTimer=0,mGen=0,SEEN=null,HL=[],SND=null;
const srvNow=()=>Date.now()+SK;
async function tpost(path,body,headers,ms){const c=new AbortController();let tm;
 const late=new Promise((_,no)=>{tm=setTimeout(()=>{const e=new Error(Math.round(ms/1000)+'초 안에 응답이 없습니다');e.name='Timeout';no(e);try{c.abort()}catch{}},ms)});
 try{return await Promise.race([(async()=>{const r=await fetch(path,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body),signal:c.signal});
  const j=await r.json().catch(()=>null);if(!r.ok){const e=new Error((j&&typeof j.error==='string'&&j.error)||('HTTP '+r.status));e.status=r.status;throw e}
  if(!j||typeof j!=='object')throw new Error('응답을 알아볼 수 없습니다');return j})(),late])}
 finally{clearTimeout(tm)}}
${LAB_SEAT_ADD_JS}
const SEAT_ADD=createLabSeatAdd({admin:adm,epoch:()=>AG,selected:()=>RID,clean:e=>cleanErr(e.message||e),call:(path,body)=>fresh(tpost(path,body,H(),path.endsWith('/status')?10000:180000)),changed:()=>{if(adm())load(true).catch(()=>{})},invite:(id,n)=>fresh(invite({id},n)),showInvite:(id,r)=>{const lab=currentLabs().find(l=>l.id===id);if(lab)showBig(lab,r)}});
$('runAddSeat').onclick=()=>{closeUtilityDialogs();SEAT_ADD.open()};
${LAB_REQUEST_PREVIEWS_JS}
const REQUEST_PREVIEWS=createLabRequestPreviews({root:$('liveTools'),active:()=>!LOP&&(adm()||!!MON||!!LLIVE.hasSession?.()),epoch:()=>LG,selected:()=>RID,tap:tapGet,changed:()=>{if(adm())load(true).catch(()=>{});else mKick()}});
${LAB_DEMO_EDITOR_JS}
const DEMO_EDITOR=createLabDemoEditor({admin:adm,call:(path,body)=>fresh(tpost(path,body,H(),20000))});
window.addEventListener('lab-admin-ended',()=>{for(const id in SH)if(SH[id].kind==='demo')shStop(id,'관리 인증이 끝나 시연 송출을 멈췄습니다.');DEMO_WORKSPACE.clear();DEMO_EDITOR.clear()});
${LAB_CLASSROOM_TEACHER_JS}
const CLASSROOM=createLabClassroomTeacher({
 admin:(path,body)=>fresh(tpost(path,body,H(),path.endsWith('/demo/prepare')?180000:path.endsWith('/demo/send')?30000:10000)),
 demoEditor:(id,materials)=>DEMO_EDITOR.box(id,materials),clearDemo:()=>{DEMO_WORKSPACE.clear();DEMO_EDITOR.clear()},
 mountDemo:async(id,url)=>{if(id!==RID||!adm()||LOP)return;if(SH[id]?.kind==='demo')await shStop(id,'시연실을 다시 연결해 송출을 멈췄습니다. 연결 후 다시 송출해 주세요.');if(id!==RID||!adm()||LOP)return;if(!DEMO_WORKSPACE.mount(id,url))throw Error('시연실 주소나 연결 권한을 확인하지 못했습니다.');syncDemoSourceLayout()},isDemoMounted:id=>DEMO_WORKSPACE.isMounted(id),onPaint:syncDemoSourceLayout,
 read:id=>tpost('/api/lab/classroom/status',{id},{},10000),
 lab:()=>{const id=RID;if(!id)return null;const list=currentLabs();return list.find(l=>l.id===id)||{id,name:id,seats:[]}},
 auth:()=>({admin:adm(),readOnly:!adm()&&(!!MON||!!(LLIVE.hasSession?.()))}),
 help:(n,text)=>{const id=RID;if(id)openSeat(id,n);if(text)say(text,'')},
 terminal:lab=>LT.box(lab),
 archive:lab=>{if(!lab||!lab.id)return null;const card=document.querySelector('#labs [data-lab="'+CSS.escape(lab.id)+'"]');if(!card)return null;return{finish:card.querySelector('details[data-lab-section="마무리"]'),checkpoint:card.querySelector('details[data-lab-section="모임 도구"]')}},
 people:(people)=>{LLIVE.setProgress?.(RID,people);return !!LLIVE.hasSeats?.(RID)},navigate:next=>{LLIVE.clearFocus?.();if(next!=='live'&&SH[RID]?.kind==='demo')shStop(RID,'교안 화면으로 이동해 시연 송출을 멈췄습니다.')},
 guide:$('runGuide'),notice:$('classNotices'),cleanErr,side:$('classSide'),main:$('classMain'),rail:$('classRail')});
$('demoWorkspaceRetry').onclick=()=>CLASSROOM.openDemo();$('demoWorkspacePopout').onclick=()=>CLASSROOM.popoutDemo();
const mNext=()=>{clearTimeout(mTimer);if(MON&&!document.hidden)mTimer=setTimeout(mPoll,3000)};
async function mPoll(){if(mBusy||!MON||document.hidden)return;clearTimeout(mTimer);mBusy=true;const g=mGen;
 try{const d=await tpost('/api/lab/teacher/status',{},{},10000);if(g!==mGen)return;
  if(!Array.isArray(d.labs)||typeof d.expiresAt!=='number')throw new Error('응답을 알아볼 수 없습니다');monData(d)}
 catch(e){if(g!==mGen)return;if(e.status===401){monEnd('모니터 세션이 끝났습니다 (만료됐거나 로그아웃됨). 다시 보려면 보안 키로 여세요.');return}MERR=cleanErr(e.message);paintFresh()}
 finally{if(g===mGen){mBusy=false;mNext()}}}
const mKick=()=>{if(MON&&!mBusy)mPoll()};
function monData(d){MON.expiresAt=d.expiresAt;if(typeof d.now==='number')SK=d.now-Date.now();MD=d.labs;MOK=Date.now();MERR='';
 hands(MD);if(!adm()){renderMon();liveMeta(MD)}
 if(bigId){const l=MD.find(x=>x.id===bigId);if(l)$('bigCount').textContent=joined(l)}
 paintFresh();sessText()}
function renderMon(){if(adm())return;syncRooms(MD||[]);pickDefault((MD||[]).length);LR.renderMonitor($('labs'),MD||[]);$('labs').dataset.mode='monitor';paintShareHold();paintDeliveryDock();CLASSROOM.sync()}
function monEnd(msg){mGen++;mBusy=false;clearTimeout(mTimer);MON=null;MD=null;MOK=0;MERR='';SEEN=null;pushStop();
 if(adm()){hands(LD||[]);liveMeta(LD||[])}else{LD=null;clearHands();$('labs').replaceChildren();$('labs').dataset.mode='';closeBig();liveMeta([]);if(!LLIVE.hasSession?.()){liveRoom(null);RID=null}}
 $('loginNote').textContent=msg;$('loginNote').className='bad';view();paintFresh()}
// 관리 시간이 끝남: 관리 조회·조작을 멈추고 읽기 전용으로. 모니터는 그대로 (적어 둔 입력·코드 초안도 그대로)
// 관리 화면(초대·QR·버튼)은 바로 걷어 낸다: 모니터 데이터가 있으면 읽기 전용으로, 없으면 비운다. 크게 보기(초대 QR)도 닫는다
function admExpired(){if(!T)return;T=null;TE=0;AG++;LD=null;LOK=0;LERR='';closeBig();window.dispatchEvent(new Event('lab-admin-ended'));
 if(MON){if(MD){renderMon();liveMeta(MD)}else{$('labs').replaceChildren();$('labs').dataset.mode='';liveMeta([])}}else{clearHands();$('labs').replaceChildren();$('labs').dataset.mode='';liveMeta([]);$('loginNote').textContent='관리 작업 시간이 끝났습니다. 모니터 세션이 없어 목록도 닫았습니다 — 보안 키로 다시 여세요.';$('loginNote').className='bad'}
 view()}
function view(){const a=adm(),live=!!LLIVE.hasSession?.(),on=a||!!MON||live;$('login').hidden=on;$('panel').hidden=!on;commandLayout();REQUEST_PREVIEWS.sync();if(!on)closeUtilityDialogs();else if(pendingUtility){const next=pendingUtility;pendingUtility=null;showView(next,false)}if(!a&&$('seatAddDialog').open)$('seatAddDialog').close();
 $('newForm').hidden=!a;$('newLocked').hidden=a;$('reauth').hidden=a;$('logout').hidden=!MON&&!a&&!live;paintHands();sessText();paintFresh();pushPaint();opPaint();paintShareHold();paintDeliveryDock();CLASSROOM.sync()}
function sessText(){$('monLine').textContent=MON?'모니터: '+fmt(MON.expiresAt)+' 까지 이 기기에서 계속 봅니다 (읽기 전용).':(MONERR||'모니터 세션 없음 — 관리 작업 시간 동안만 보입니다.');
 const a=$('admLine');if(adm()){const s=TE===Infinity?-1:Math.max(0,Math.floor((TE-Date.now())/1000));a.textContent='관리 작업: '+(s<0?'가능':Math.floor(s/60)+'분 '+(s%60)+'초 남음');a.className='mut'}
 else{a.textContent=AUTH_MSG+' — 수업 만들기·초대·손 내리기·끝내기는 보안 키를 다시 대야 합니다.';a.className='bad'}
 const brief=$('authBrief');if(brief){if(adm()){const s=Math.max(0,Math.floor((TE-Date.now())/1000));brief.textContent='관리 가능';brief.title='관리 인증 '+Math.floor(s/60)+'분 '+(s%60)+'초 남음 · 자세한 내용은 설정';brief.className='mut'}else if(onAuth()){brief.textContent='읽기 전용 · 다시 확인 필요';brief.title='';brief.className='bad'}else brief.textContent=''}}
function onAuth(){return !!MON||!!(typeof LLIVE!=='undefined'&&LLIVE.hasSession?.())}
const agoS=ms=>{const s=Math.floor(ms/1000);return s<60?s+'초 전':dur(s)+' 전'};
function paintFresh(){const f=$('fresh');if(!MON&&!adm()){f.textContent='';f.dataset.state='';return}
 const x=MON?{ok:MOK,err:MERR,lim:10000,what:'3초마다'}:{ok:LOK,err:LERR,lim:40000,what:'15초마다'};
 const age=x.ok?Date.now()-x.ok:0,at=x.ok?new Date(x.ok).toLocaleTimeString('ko-KR'):'';let t,c,st;
 if(x.err){t='⚠ 연결 끊김 — '+(x.ok?at+' ('+agoS(age)+')에 받은 내용입니다. 지금과 다를 수 있습니다.':'아직 받은 내용이 없습니다.')+' 오류: '+x.err;c='bad';st='down'}
 else if(!x.ok){t='불러오는 중…';c='mut';st='loading'}
 else if(age>x.lim){t='⚠ 늦어짐 — 마지막 확인 '+at+' ('+agoS(age)+'). 지금과 다를 수 있습니다.';c='bad';st='stale'}
 else{t='실시간 · '+x.what+' 확인 · 마지막 '+at;c='mut';st='live'}
 if(MON&&LERR&&adm())t+=' · 관리 목록 갱신 실패: '+LERR;
 f.textContent=t;f.className=c;f.dataset.state=st;$('labs').dataset.fresh=st}
// 손 든 사람: 수업·자리·손 든 시각으로 구분. 처음 받은 목록(새로고침·앱 다시 열기)은 조용히 기억만 하고, 그 뒤 새로 생긴 손만 알린다
function handList(labs){const o=[];for(const l of labs||[])for(const s of l.seats||[])if(typeof s.hand==='number'&&s.hand>0&&!s.error)o.push({lab:l,s,key:l.id+':'+s.n+':'+s.hand});o.sort((a,b)=>a.s.hand-b.s.hand);return o}
const hName=x=>x.lab.name+' '+x.s.n+'번'+(x.s.who?' '+x.s.who:'');
const waitText=t=>{const s=Math.max(0,Math.floor((srvNow()-t)/1000));return s<60?'방금':dur(s)+'째 기다림'};
function hands(labs){const L=handList(labs);
 if(SEEN){const nw=L.filter(x=>!SEEN.has(x.key));if(nw.length)alertHands(nw)}
 const up=new Set(L.map(x=>x.key));
 for(const h of HH){const was=h.up;h.up=up.has(h.key);if(was&&!h.up)h.acked=false}
 for(const x of L)if(!HH.some(h=>h.key===x.key))HH.push({key:x.key,name:hName(x),lab:x.lab.id,n:x.s.n,up:true,acked:false});
 SEEN=new Set(L.map(x=>x.key));HL=L;paintHands();setTitle(L.length);bigHands(L)}
const setTitle=n=>{document.title=(n?'✋'+n+' ':'')+'공부방 실습실'};
const clearHands=()=>{HL=[];SEEN=null;HH=[];paintHands();setTitle(0);bigHands([]);$('handAlert').textContent='';$('handAck').hidden=true};
function alertHands(nw){$('handAlert').textContent='✋ 새로 손 듦: '+nw.map(hName).join(', ');$('handAck').hidden=false;if(SND)beep()}
$('handAck').onclick=()=>{for(const h of HH)if(!h.up)h.acked=true;$('handAlert').textContent='';$('handAck').hidden=true;paintHands()};
function paintHist(){const ul=$('handLog');if(!ul)return;ul.replaceChildren();const items=HH.filter(h=>!h.acked&&!h.up);
 if(!items.length){const li=document.createElement('li');li.className='mut';li.textContent='확인하지 않은 지난 알림이 없습니다.';ul.append(li);return}
 for(const h of items){const li=document.createElement('li');li.dataset.unacked=h.key;li.textContent=h.name+' · 목록에서는 손이 내려짐 · 해결로 표시하지 않음';ul.append(li)}}
function paintHands(){const ul=$('handList'),L=HL,a=adm();ul.replaceChildren();$('handN').textContent=L.length?L.length+'명':'';$('handsBar').dataset.hands=String(L.length);
 $('handRo').hidden=a||!L.length;paintHist();
 if(!L.length){const li=document.createElement('li');li.className='mut';li.textContent='지금 손 든 참여자가 없습니다.';ul.append(li);return}
 for(const x of L){const li=document.createElement('li');li.dataset.hand=x.key;
  const w=document.createElement('span');w.className='hwho';w.textContent=x.s.n+'번'+(x.s.who?' '+x.s.who:'');
  const c=document.createElement('span');c.className='mut';c.textContent=x.lab.name;
  const t=document.createElement('span');t.className='hwait';t.dataset.since=String(x.s.hand);t.textContent=waitText(x.s.hand);
  const help=btn('도와주기','sec go',()=>openSeat(x.lab.id,x.s.n));help.setAttribute('aria-label',hName(x)+' 도와주기');li.append(w,c,t,help);
  if(a){const lo=btn('내리기','sec',async()=>{lo.disabled=true;try{await api('/api/lab/hand',{id:x.lab.id,n:x.s.n},H());const i=HH.findIndex(h=>h.key===x.key);if(i>=0)HH.splice(i,1);say(hName(x)+' 손을 내렸습니다.','ok');mKick();if(adm())load().catch(()=>{})}catch(e){say(e.message,'bad');lo.disabled=false}});lo.setAttribute('aria-label',hName(x)+' 손 내리기');li.append(lo)}
  ul.append(li)}}
function bigHands(L){const e=$('bigHands');if(!e||!bigId)return;/* 닫혀 있으면 숨은 칸에 쓰지 않는다 */e.textContent=L.length?'✋ 손 든 사람 '+L.length+'명 — '+L.slice(0,6).map(x=>hName(x)+' ('+waitText(x.s.hand)+')').join(' · ')+(L.length>6?' 외 '+(L.length-6)+'명':''):''}
function jump(id,n){openRunTools(false);const c=[...document.querySelectorAll('#labs [data-lab]')].find(e=>e.dataset.lab===id);if(!c){say('그 수업 카드를 찾지 못했습니다 — 목록을 다시 받는 중일 수 있습니다.','bad');return}
 const r=[...c.querySelectorAll('tr[data-seat]')].find(e=>e.dataset.seat===String(n))||c;for(let p=r.parentElement;p&&p!==c;p=p.parentElement)if(p.tagName==='DETAILS')p.open=true;r.tabIndex=-1;r.scrollIntoView({block:'center'});try{r.focus({preventScroll:true})}catch{}
 r.classList.add('flash');setTimeout(()=>r.classList.remove('flash'),2500)}
// 소리: "소리 알림 켜기" 를 누른 뒤에만 (그 누름으로 오디오를 연다). 저장하지 않는다 — 새로 열면 다시 꺼져 있다
function beep(){try{const o=SND.createOscillator(),g=SND.createGain(),t=SND.currentTime;o.frequency.value=880;g.gain.setValueAtTime(.0001,t);g.gain.exponentialRampToValueAtTime(.2,t+.02);g.gain.exponentialRampToValueAtTime(.0001,t+.35);o.connect(g).connect(SND.destination);o.start(t);o.stop(t+.4)}catch{}}
$('sound').onclick=()=>{const b=$('sound');if(SND){try{SND.close()}catch{}SND=null;b.textContent='소리 알림 켜기';b.setAttribute('aria-pressed','false');return}
 try{const A=window.AudioContext||window.webkitAudioContext;SND=new A();SND.resume&&SND.resume();beep();b.textContent='소리 알림 끄기';b.setAttribute('aria-pressed','true')}catch{say('이 브라우저에서는 소리를 낼 수 없습니다.','bad')}};
// 1초마다: 남은 시간·기다린 시간·신선도 글자만 (네트워크 없음). 관리·모니터 만료는 여기서 알아챈다
setInterval(()=>{if(T&&!adm())admExpired();if(MON&&srvNow()>=MON.expiresAt)monEnd('모니터 8시간이 끝났습니다. 다시 보려면 보안 키로 여세요.');
 if($('panel').hidden)return;sessText();paintFresh();paintRoomStat(currentLabs());paintShareHold();for(const e of document.querySelectorAll('#handList [data-since]'))e.textContent=waitText(Number(e.dataset.since));if(bigId)bigHands(HL)},1000);
document.addEventListener('visibilitychange',()=>{if(document.hidden){clearTimeout(mTimer);return}if(T&&!adm())admExpired();mKick();paintFresh()});
// 로그아웃: 서버가 모니터 쿠키를 지운다. 이 화면의 관리 토큰·목록·QR 도 지운다 (실패하면 그대로 알린다)
// 누르는 즉시 이 화면의 관리 토큰·세대·목록을 지우고(늦게 온 로그인·목록·상태 응답은 버려진다) 끝날 때까지 다시 확인·로그인을 막는다.
// 서버에는 지금 쿠키와 함께, 들고 있던 관리 토큰도 낸다 — 그 관리 토큰과 그것으로 만든 모니터 쿠키(아직 응답이 안 온 것까지)를 서버가 지운다.
// 화면 공유는 그 관리 토큰으로 서버 정리를 한 번씩만 (다시 보내지 않음) 보낸 뒤에 로그아웃한다
let LOP=false;
$('logout').onclick=async()=>{if(LOP)return;LOP=true;window.dispatchEvent(new Event('lab-admin-ended'));const b=$('logout');b.disabled=$('go').disabled=$('reauth').disabled=true;let why='';
 const t=T,ids=Object.keys(SH);liveMeta([]);liveRoom(null);LLIVE.end();
 T=null;TE=0;AG++;LG++;LD=null;LOK=0;LERR='';closeBig();for(const id of ids)shEnd(id);SS=null;
 monEnd('로그아웃하는 중…');clearHands();$('labs').replaceChildren();
 try{await Promise.allSettled(ids.map(id=>tpost('/api/lab/live/screen/stop',{id},{},5000)));
  const results=await Promise.allSettled([tpost('/api/lab/live/logout',{},t?{'x-admin-token':t}:{},10000),tpost('/api/lab/teacher/logout',{},t?{'x-admin-token':t}:{},10000)]);
  for(const result of results)if(result.status==='rejected'&&result.reason.status!==401&&result.reason.status!==404)why=cleanErr(result.reason.message);
 }catch(e){if(e.status!==401)why=cleanErr(e.message)}
 LOP=false;
 monEnd(why?'이 화면에서는 지웠지만 서버 로그아웃을 확인하지 못했습니다 ('+why+'). 새로고침하면 모니터가 다시 보일 수 있으니 연결이 돌아오면 다시 로그아웃하세요.':'로그아웃했습니다. 다시 보려면 보안 키로 여세요.');
 $('loginNote').className=why?'bad':'ok';clearHands();$('labs').replaceChildren();b.disabled=$('go').disabled=$('reauth').disabled=false;view()};
// ── 화면을 꺼도 손들기 알림 (Web Push, 이 기기만, 지금 모니터 세션까지). 권한 요청·구독·서버 등록은 "켜기"를 누를 때만.
// 모니터가 생길 때마다(세대 P.gen) 공개 설정을 한 번 받고, 이 브라우저에 구독이 이미 있으면 서버에 이 기기 상태만 묻는다 — 자동 구독·자동 재등록 없음.
// 서버 요청은 tpost(10초 상한), 브라우저 대기(ready·getSubscription·subscribe·unsubscribe)도 상한을 둔다. 로그아웃·8시간·다시 확인으로 세대가 바뀌면 늦은 결과는 버리고
// 그 사이 새로 만든 구독은 지운다. 구독 정보는 브라우저가 가진 PushSubscription 말고는 어디에도 저장하지 않는다
const PUSH_HOSTS=['fcm.googleapis.com','updates.push.services.mozilla.com','web.push.apple.com'],PUSH_WAIT=10000;
const PUSH_DENIED='이 사이트 알림이 막혀 있습니다 — 브라우저·기기 설정에서 알림을 허용한 뒤 화면을 다시 여세요.';
const PUSH_HOST_MSG='이 브라우저의 알림 서버는 지원하지 않습니다 — Chrome·Firefox, iPhone·iPad 는 홈 화면에 추가한 앱(Safari)으로 여세요. 이 화면의 손 알림은 그대로 됩니다.';
const pNew=(gen,st,msg)=>({gen,st,msg:msg||'',on:false,exp:0,key:null,reg:null,busy:false});
let P=pNew(0,'off');
const within=(p,ms)=>{let tm;return Promise.race([Promise.resolve(p),new Promise((_,no)=>{tm=setTimeout(()=>{const e=new Error(Math.round(ms/1000)+'초 안에 끝나지 않았습니다');e.name='Timeout';no(e)},ms)})]).finally(()=>clearTimeout(tm))};
const pushOk=()=>{try{return isSecureContext&&'serviceWorker' in navigator&&'PushManager' in window&&'Notification' in window}catch{return false}};
// 서버 공개 키(base64url) → P-256 비압축 점 65바이트. 모양이 다르면 null
function pushKey(s){try{if(typeof s!=='string')return null;s=s.replace(/=+$/,'');if(!/^[A-Za-z0-9_-]{80,100}$/.test(s))return null;const b=atob(s.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-s.length%4)%4));
 const k=Uint8Array.from(b,c=>c.charCodeAt(0));return k.length===65&&k[0]===4?k:null}catch{return null}}
const pushHost=ep=>{try{const u=new URL(ep);return u.protocol==='https:'&&PUSH_HOSTS.includes(u.hostname)}catch{return false}};
const sameKey=(sub,k)=>{try{const a=sub.options&&sub.options.applicationServerKey;if(!a)return true;const b=new Uint8Array(a);return b.length===k.length&&b.every((x,i)=>x===k[i])}catch{return true}};
// st: off(꺼짐) on(켜짐) pending(확인·처리 중) failed(실패 — on 이 null 이면 서버 상태를 모름) denied unsupported unavailable
function pushSet(st,msg,on){P.st=st;P.msg=msg||'';P.on=on!==undefined?on:st==='on';pushPaint()}
function pushPaint(){const c=$('pushCard');if(!c)return;c.hidden=!MON;c.dataset.state=P.st;const st=P.st,on=$('pushOn'),off=$('pushOff');
 if(st!=='pending'){on.hidden=!((st==='off'||st==='failed')&&P.on!==true);off.hidden=!((st==='on'||st==='failed')&&P.on!==false)}
 on.disabled=off.disabled=st==='pending'||P.busy;
 let t=P.msg;if(st==='on'){t='켜짐 — '+(P.exp?fmt(P.exp)+' 까지 ':'')+'이 기기로 손들기 알림이 갑니다 (모니터 세션이 끝나거나 로그아웃하면 멈춤).'+(P.msg?' '+P.msg:'')}
 else if(!t&&st==='off')t='꺼짐 — 이 기기는 알림을 받지 않습니다.';
 const m=$('pushMsg');m.textContent=t;m.className=st==='on'?'ok':st==='failed'||st==='denied'?'bad':'mut'}
function pushStop(){P=pNew(P.gen+1,'off');pushPaint()}
async function pushInit(){P=pNew(P.gen+1,'pending','이 기기의 알림 상태를 확인하는 중…');const g=P.gen;pushPaint();
 let c;try{c=await tpost('/api/lab/teacher/push/config',{},{},PUSH_WAIT)}
 catch(e){if(g!==P.gen)return;return pushSet('unavailable',e.status===409?'지금은 서버에서 알림을 쓸 수 없습니다.':e.status===401?'모니터 세션이 끝났습니다.':'알림 설정을 받지 못했습니다 ('+cleanErr(e.message)+'). 화면을 다시 열면 다시 확인합니다.')}
 if(g!==P.gen)return;
 if(typeof c.available!=='boolean'||typeof c.expiresAt!=='number')return pushSet('unavailable','알림 설정 응답을 알아볼 수 없습니다.');
 P.exp=c.expiresAt;const key=c.available?pushKey(c.applicationServerKey):null;
 if(!c.available)return pushSet('unavailable','이 서버에는 백그라운드 알림이 설정되어 있지 않습니다.');
 if(!key)return pushSet('unavailable','서버의 알림 키를 알아볼 수 없습니다.');
 if(!pushOk())return pushSet('unsupported',IOS?'iPhone·iPad 는 iOS·iPadOS 16.4 이상에서 Safari "홈 화면에 추가"로 설치한 앱으로 열어야 합니다.':'이 브라우저는 백그라운드 알림(Web Push)을 지원하지 않습니다. 이 화면의 손 알림은 그대로 됩니다.');
 if(Notification.permission==='denied')return pushSet('denied',PUSH_DENIED);
 let reg,sub;try{reg=await within(navigator.serviceWorker.ready,PUSH_WAIT);if(g!==P.gen)return;sub=await within(reg.pushManager.getSubscription(),PUSH_WAIT)}
 catch(e){if(g!==P.gen)return;return pushSet('unavailable','이 기기의 알림 준비를 확인하지 못했습니다 ('+cleanErr(e.message)+'). 화면을 다시 열면 다시 확인합니다.')}
 if(g!==P.gen)return;P.key=key;P.reg=reg;
 if(!sub||!pushHost(sub.endpoint))return pushSet('off');
 try{const s=await tpost('/api/lab/teacher/push/status',{endpoint:sub.endpoint},{},PUSH_WAIT);if(g!==P.gen)return;
  if(typeof s.enabled!=='boolean')throw new Error('응답을 알아볼 수 없습니다');if(typeof s.expiresAt==='number')P.exp=s.expiresAt;pushSet(s.enabled?'on':'off')}
 catch(e){if(g!==P.gen)return;if(e.status===401||e.status===409)return pushSet('unavailable',e.status===409?'지금은 서버에서 알림을 쓸 수 없습니다.':'모니터 세션이 끝났습니다.');
  pushSet('failed','서버에서 이 기기 알림 상태를 확인하지 못했습니다 ('+cleanErr(e.message)+') — 켜져 있는지 모릅니다.',null)}}
// 켜기: 권한 요청은 누른 그 자리에서 바로 (iOS 는 기다린 뒤에는 사용자 동작으로 치지 않는다). 그다음 구독 → 서버 등록
$('pushOn').onclick=()=>{if(P.busy||!P.key||!P.reg||!MON||P.st==='pending')return;const g=P.gen,reg=P.reg,key=P.key;let perm;
 try{perm=new Promise(ok=>{const r=Notification.requestPermission(ok);if(r&&r.then)r.then(ok,()=>ok('default'))})}catch{perm=Promise.resolve('default')}
 P.busy=true;pushSet('pending','알림 권한을 묻는 중… 브라우저 창에서 "허용"을 누르세요.',P.on);
 pushEnable(g,reg,key,perm).finally(()=>{if(g===P.gen){P.busy=false;pushPaint()}})};
async function pushEnable(g,reg,key,perm){let p;try{p=await within(perm,60000)}catch{p='timeout'}
 if(g!==P.gen)return;
 if(p!=='granted')return p==='denied'?pushSet('denied',PUSH_DENIED):pushSet('off','알림을 허용하지 않아 켜지 않았습니다.');
 pushSet('pending','이 기기를 알림에 등록하는 중…',false);let sub=null,made=false;
 try{const old=await within(reg.pushManager.getSubscription(),PUSH_WAIT);if(g!==P.gen)return;
  if(old&&!sameKey(old,key))await within(old.unsubscribe(),PUSH_WAIT);else sub=old;
  if(!sub){const sp=reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:key});made=true;
   try{sub=await within(sp,PUSH_WAIT)}catch(e){sp.then(s=>s&&s.unsubscribe()).catch(()=>{});throw e}}}
 catch(e){if(g!==P.gen)return;return pushSet('failed','이 브라우저에서 알림 구독을 만들지 못했습니다 ('+cleanErr(e.message)+'). 켜지지 않았습니다.',false)}
 const drop=()=>{if(made)within(sub.unsubscribe(),PUSH_WAIT).catch(()=>{})};
 if(g!==P.gen)return drop();
 if(!pushHost(sub.endpoint)){drop();return pushSet('unsupported',PUSH_HOST_MSG)}
 let r;try{r=await tpost('/api/lab/teacher/push/subscribe',{subscription:sub.toJSON()},{},PUSH_WAIT)}
 catch(e){drop();if(g!==P.gen)return;
  if(e.status===401||e.status===409)return pushSet('failed',(e.status===409?'지금은 서버에서 알림을 쓸 수 없어':'모니터 세션이 끝나')+' 등록하지 못했습니다. 켜지지 않았습니다.',false);
  return pushSet('failed','서버 등록에 실패했습니다 ('+cleanErr(e.message)+'). '+(made||!unsure(e)&&e.name!=='Timeout'?'켜지지 않았습니다.':'켜졌는지 모릅니다 — 끄려면 "끄기", 다시 켜려면 "켜기"를 누르세요.'),made||!unsure(e)&&e.name!=='Timeout'?false:null)}
 if(g!==P.gen)return drop();
 if(!r||r.ok!==true||typeof r.expiresAt!=='number'){drop();return pushSet('failed','서버 응답을 알아볼 수 없습니다 — 켜졌는지 모릅니다. 끄려면 "끄기"를 누르세요.',made?false:null)}
 P.exp=r.expiresAt;pushSet('on')}
// 끄기: 서버에서 먼저 지운 뒤 이 브라우저 구독을 지운다. 서버가 확인해 주지 않으면 꺼졌다고 하지 않는다
$('pushOff').onclick=()=>{if(P.busy||!P.reg||!MON||P.st==='pending')return;const g=P.gen,reg=P.reg;P.busy=true;pushSet('pending','이 기기 알림을 끄는 중…',P.on);
 pushDisable(g,reg).finally(()=>{if(g===P.gen){P.busy=false;pushPaint()}})};
async function pushDisable(g,reg){const was=P.on;let sub;
 try{sub=await within(reg.pushManager.getSubscription(),PUSH_WAIT)}catch(e){if(g!==P.gen)return;return pushSet('failed','이 브라우저의 구독을 읽지 못했습니다 — 알림이 아직 켜져 있을 수 있습니다. 다시 누르세요.',was===false?false:null)}
 if(g!==P.gen)return;
 if(!sub)return pushSet('off','이 브라우저에 구독이 없어 이 기기로는 알림이 오지 않습니다.');
 try{await tpost('/api/lab/teacher/push/unsubscribe',{endpoint:sub.endpoint},{},PUSH_WAIT)}
 catch(e){if(g!==P.gen)return;if(e.status!==401)return pushSet('failed','끄지 못했습니다 ('+cleanErr(e.message)+') — 서버에서 알림이 아직 켜져 있을 수 있습니다. 다시 누르세요.',was===false?false:null)}
 try{await within(sub.unsubscribe(),PUSH_WAIT)}catch{}
 if(g!==P.gen)return;pushSet('off','이 기기 알림을 껐습니다.')}
// 처음 열 때: 보호된 쿠키로 원래 관리 세션을 복원하고, 독립적인 보기 세션도 함께 확인한다.
async function boot(){if(LOP)return;const g=LG,a=AG;restoreAdmin(g,a);$('mRetry').hidden=true;$('loginNote').className='mut';$('loginNote').textContent='이 기기의 모니터를 확인하는 중…';
 LLIVE.start();
 try{const d=await tpost('/api/lab/teacher/status',{},{},10000);if(g!==LG||MON)return;
  if(!Array.isArray(d.labs)||typeof d.expiresAt!=='number')throw new Error('응답을 알아볼 수 없습니다');
  MON={expiresAt:d.expiresAt};$('loginNote').textContent='';monData(d);view();mNext();swReg();pushInit()}
 catch(e){if(g!==LG||MON)return;if(e.status===401){$('loginNote').textContent='보안 키로 열어 주세요.';return}
  $('loginNote').textContent='모니터 상태를 확인하지 못했습니다 ('+cleanErr(e.message)+'). 다시 확인하거나 보안 키로 여세요.';$('loginNote').className='bad';$('mRetry').hidden=false}}
$('mRetry').onclick=()=>boot();
$('roomSelect').onchange=()=>{VIEWCHOSEN=true;RID=$('roomSelect').value||null;REQUEST_PREVIEWS.sync();liveRoom(RID);paintRoomStat(currentLabs());repaintLabs()};
$('createAlertGo').onclick=()=>{VIEWCHOSEN=true;showView('prep',true);$('newLab').open=true;};
for(const id of ['navPrep','navSet'])$(id).onclick=()=>{VIEWCHOSEN=true;showView($(id).dataset.view,true)};
function openLinkedView(){const v=location.hash==='#prepare'?'prep':location.hash==='#settings'?'set':null;if(v){VIEWCHOSEN=true;showView(v,false);if(v==='prep')$('newLab').open=true}}
openLinkedView();addEventListener('hashchange',openLinkedView);
addEventListener('lab-live-room',e=>{const id=e.detail&&e.detail.id;if(typeof id!=='string'||!id||id===RID)return;RID=id;const sel=$('roomSelect');if(sel&&[...sel.options].some(o=>o.value===id))sel.value=id;paintRoomStat(currentLabs());repaintLabs()});
view();boot();
// 설치: 강사 앱(/lab 범위). 서비스 워커는 모니터가 있을 때만 등록하고 아무것도 저장하지 않는다
function swReg(){try{if(navigator.serviceWorker&&isSecureContext)navigator.serviceWorker.register(SW_URL,{scope:SW_SCOPE}).catch(()=>{})}catch{}}
const SA=(()=>{try{return matchMedia('(display-mode: standalone)').matches||navigator.standalone===true}catch{return false}})();
const IOS=/iPad|iPhone|iPod/.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
if(SA)$('instCard').hidden=true;else if(IOS)$('instMsg').textContent='iPhone·iPad: Safari 아래쪽 공유 버튼 → "홈 화면에 추가"를 누르세요. 앱은 모임 정보를 기기에 저장하지 않습니다.';
let IP=null;addEventListener('beforeinstallprompt',e=>{e.preventDefault();IP=e;if(!SA)$('inst').hidden=false});
addEventListener('appinstalled',()=>{IP=null;$('inst').hidden=true;$('instMsg').textContent='설치했습니다. 다음부터는 "실습실 모임지기" 앱으로 여세요.'});
$('inst').onclick=async()=>{if(!IP)return;IP.prompt();try{await IP.userChoice}catch{}IP=null;$('inst').hidden=true};
`, '/webauthn.js', true, TEACHER_HEAD);

// ── 실습실 호스트(LAB_ORIGIN) 페이지. 공용 스크립트는 /__lab/app.js (code-server 경로와 안 겹치게) ──

const labGuide = `
<div class="card"><b>사용법</b>
 <p>브라우저에 VS Code 가 열립니다. 터미널: 왼쪽 위 메뉴 ☰ → Terminal → New Terminal (단축키 Ctrl + \`)</p>
 <pre>claude       # Claude Code
opencode     # OpenCode
lab-status   # 남은 사용 한도·시간
lab-doctor   # 안 될 때 자가 진단</pre>
 <p class="mut">두 도구 모두 로그인 없이 바로 됩니다. 두뇌는 OpenRouter 의 <span id="model">공개 모델</span> 이고, 1인당 사용 한도가 걸려 있습니다.</p>
</div>
<div class="card"><b>알아둘 것</b>
 <p class="mut">수업이 끝나면 실습실과 그 안의 파일·기록이 모두 지워집니다. 남기고 싶은 건 수업 중에 받아 두세요: VS Code 오른쪽 아래 <b>⬇ 내 작업 받기</b> 를 누르면 work 폴더가 zip 으로 받아집니다. 막히면 <b>✋ 손 들기</b> — 강사 화면에 표시됩니다.</p>
 <p class="mut">회사 코드·문서, 개인정보는 넣지 마세요. 입력한 내용은 AI 모델 제공자에게 전달됩니다.</p>
 <p class="mut">모임지기에게 이 실습실의 편집기·터미널 화면과 활동 상태가 자동으로 보입니다. 내 PC의 다른 창은 포함하지 않습니다. 클릭·키보드 조작은 별도로 허용해야 하며 언제든 끝낼 수 있습니다.</p>
</div>`;

// 자리 초대 (#14·#19): 수업·자리를 보여 주고, "입장" 을 눌러야 깨운 뒤 그 자리 호스트로 폼 POST 한다 (이 화면은 쿠키를 굽지 않는다).
// 이름은 그 자리에 이름이 없을 때만 한 번 적힌다 — 이름으로 다른 자리를 고르지 않는다
export const labJoinPage = (o: { code: string; seatOrigin: string; name: string; seat: number; who: string; expiresAt: number; model: string }) => page('AI 실습실', `
<h1 id="title">AI 실습실</h1>
<p class="mut" id="who"></p>
<div class="card" id="nameCard">
 <p id="seatLine"></p>
 <div id="nmBox"><label>이름 (선택)</label><input type="text" id="nm" maxlength="20" autocomplete="name" placeholder="모임지기에게 보일 이름"></div>
 <p class="mut" data-auto-view-notice>이 실습실의 편집기·터미널 화면은 모임지기에게 자동으로 보입니다. 클릭·키보드 조작을 도와드릴 때는 먼저 허용을 요청합니다.</p>
 <button id="go">입장</button>
 <p class="mut">이 링크는 이 자리 전용입니다. 다른 사람에게 보내지 마세요.</p>
</div>
<div class="card" id="wait" hidden><p id="st">준비 중…</p><p class="mut">처음에는 1분쯤 걸릴 수 있습니다. 이 창을 그대로 두세요.</p></div>
<p id="err" class="bad"></p>
${labGuide}`, `
const O=${js(o)};
let W='';try{if(new URLSearchParams(location.search).get('watch')==='1')W='1'}catch{} // 강사 "들어가 보기" → 자리 호스트가 막대에 알려 참가자 상태 판정에서 뺀다
const info=r=>{if(r.name)$('title').textContent=r.name;if(r.model)$('model').textContent=r.model;
 const w=[];if(r.seat)w.push(r.seat+'번 자리');if(r.who)w.push(r.who);if(r.expiresAt)w.push('~'+fmt(r.expiresAt)+' 까지');$('who').textContent=w.join(' · ')};
info(O);$('seatLine').textContent=O.seat+'번 자리로 들어갑니다'+(O.who?' ('+O.who+')':'')+(W?' — 강사 보기':'');$('nmBox').hidden=!!O.who||!!W;
function enter(){const f=document.createElement('form');f.method='post';f.action=O.seatOrigin+'/__lab/enter';
 for(const [k,v] of [['code',O.code],['watch',W]]){const i=document.createElement('input');i.type='hidden';i.name=k;i.value=v;f.append(i)}
 document.body.append(f);f.submit()}
// 깨우기: 한 번에 하나만(버튼 잠금). 요청 시작 간격 2.5초 이상, 응답 뒤 최소 0.25초 (단조 시계). 5분·120번이 넘으면 멈추고 다시 누를 수 있게 한다
let busy=false;const now=()=>performance.now(),sleep=ms=>new Promise(x=>setTimeout(x,ms));
function idle(m){$('err').textContent=m;$('wait').hidden=true;$('nameCard').hidden=false;$('go').disabled=false;busy=false}
async function wake(name){if(busy)return;busy=true;$('go').disabled=true;$('nameCard').hidden=true;$('wait').hidden=false;$('err').textContent='';
 const t0=now(),end=t0+300000;let next=t0;
 for(let n=0;n<120&&next<end;n++){const w=next-now();if(w>0)await sleep(w);
  const s=now();if(s>=end)break;
  let r;try{r=await api('/__lab/wake',{code:O.code,name})}catch(e){return idle(e.message)}
  const got=now();if(got>=end)break;
  info(r);name='';
  if(r.status==='ready'){$('st').textContent='여는 중…';$('st').className='ok';
   if(r.materials){$('err').textContent='수업 자료를 넣지 못했습니다: '+r.materials;await sleep(4000);if(now()>=end)break}
   enter();return}
  $('st').textContent=(r.detail||'준비 중')+'… ('+Math.round((got-t0)/1000)+'초)';
  next=Math.max(s+2500,got+250)}
 idle('시간이 오래 걸립니다. 새로고침해 보세요.')}
$('go').onclick=()=>wake(W?'':$('nm').value.trim());
$('nm').onkeydown=e=>{if(e.key==='Enter')$('go').click()};
`, '/__lab/app.js');

// 자리 호스트: 입장 POST 가 맞으면 쿠키와 함께 이 화면 → 곧바로 VS Code (/)
// 인라인 스크립트만 돈다 — /__lab/app.js 를 기다리지 않게 page() 를 거치지 않는다 (자리 호스트라 manifest 는 싣지 않는다)
export const labEnterPage = (watch: boolean) => `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>AI 실습실</title><style>${CSS}</style>${LAB_ICON}</head>
<body><main>
<h1>AI 실습실</h1><div class="card"><p>여는 중…</p><p class="mut"><a href="/">안 열리면 여기를 누르세요</a></p></div></main><script>
try{${watch ? "sessionStorage.setItem('labWatch','1')" : "sessionStorage.removeItem('labWatch')"}}catch{}
location.replace('/');
</script></body></html>`;

// 자리 호스트: 다른 자리·입장 호스트(같은 사이트)의 링크로 바로 들어옴 (#18). upstream 에 닿기 전에 한 번 묻는다 —
// "계속" 은 이 출처 안의 이동이라 그다음 요청은 same-origin 으로 온다. to: 이 자리 출처의 절대 주소
export const labConfirmPage = (to: string) => page('AI 실습실', `
<h1>AI 실습실</h1><div class="card"><p>다른 주소의 링크로 이 실습실을 열었습니다. 내 자리가 맞을 때만 계속하세요.</p>
<p><a id="go" href="#">계속</a></p></div>`, `
$('go').href=${js(to)};
`, '/__lab/app.js', false);

// 런처 (입장 호스트 /): 한 번 설치해 두고, 수업마다 새 초대 링크(또는 코드)를 붙여 넣어 연다.
// 받아들이는 것: 이 런처와 출처가 똑같은 http(s)://…/j/<16자> (끝 / 허용), /j/<16자>, 16자 코드. 그 밖(다른 호스트, //, 인코딩, \,
// 제어 문자, 계정·쿼리·# 등)은 거절. 이동 주소는 입력이 아니라 location.origin + 검증된 코드로 만든다. 누를 때만 이동하고, 코드는 어디에도 저장하지 않는다
export const labLandingPage = (requestUrl = 'https://k.shinick.dev/lab/request') => page('AI 실습실', `
<h1>AI 실습실</h1>
<p class="mut">강사에게 받은 내 자리 초대 링크(또는 QR)로 들어오세요. 초대 링크는 자리마다 다릅니다.</p>
<form class="card" id="joinForm" novalidate><label for="inv"><b>초대 링크 넣기</b></label>
 <p class="mut" id="invHelp">새 수업의 초대 링크(또는 16자 코드)를 붙여 넣고 열기를 누르세요.</p>
 <input type="text" id="inv" maxlength="200" autocomplete="off" autocapitalize="off" spellcheck="false" inputmode="url" aria-describedby="invHelp invErr" placeholder="초대 링크 붙여 넣기">
 <button type="submit" id="invGo">열기</button>
 <p id="invErr" class="bad" role="alert" aria-live="polite"></p>
</form>
<p>실습할 자리가 필요한가요? <a href="${requestUrl}">모임지기에게 실습실 열기 요청</a></p>
<div class="card" id="instCard"><b>앱으로 설치</b><p class="mut">이 첫 화면을 한 번 설치해 두면, 다음 수업에서 새 초대 링크를 받아도 앱을 열고 위에 붙여 넣기만 하면 됩니다.</p>
 <p class="mut">실습 화면(VS Code)은 자리마다 다른 주소에서 열립니다. 브라우저에 따라 주소창이 보이거나 다른 창으로 열리는 등 모양이 달라질 수 있습니다.</p>
 <p class="mut" id="instMsg">설치 버튼이 보이지 않으면 브라우저 메뉴의 "앱 설치" 또는 "홈 화면에 추가"를 쓰세요.</p><button class="sec" id="inst" hidden>설치</button></div>`, `
const INV_MAX=200,INV_CODE=/^[\\w-]{16}$/,INV_PATH=/^\\/j\\/([\\w-]{16})\\/?$/,INV_ABS=/^https?:\\/\\/[^\\/?#@]+\\/j\\/[\\w-]{16}\\/?$/i;
function invCode(raw,origin){if(typeof raw!=='string'||raw.length>INV_MAX)return null;const s=raw.trim();
 if(!s||!/^[\\x21-\\x7e]+$/.test(s)||/[\\\\%]/.test(s))return null; // 보이는 ASCII 만 — 공백·제어 문자·\\·%인코딩은 거절
 if(INV_CODE.test(s))return s;let m=s.match(INV_PATH);if(m)return m[1];
 if(!INV_ABS.test(s))return null;let u;try{u=new URL(s)}catch{return null}
 if(u.username||u.password||u.search||u.hash||u.origin!==origin)return null;
 m=u.pathname.match(INV_PATH);return m?m[1]:null}
$('joinForm').addEventListener('submit',e=>{e.preventDefault();const c=invCode($('inv').value,location.origin);
 if(!c){$('inv').setAttribute('aria-invalid','true');$('invErr').textContent='이 실습실의 초대 링크가 아닙니다. 강사에게 받은 링크를 그대로 붙여 넣으세요.';$('inv').focus();return}
 $('inv').removeAttribute('aria-invalid');$('invErr').textContent='';location.assign(location.origin+'/j/'+c)});
const SA=(()=>{try{return matchMedia('(display-mode: standalone)').matches||navigator.standalone===true}catch{return false}})();
if(SA)$('instMsg').textContent='설치된 앱으로 열려 있습니다. 새 수업 초대 링크는 위 칸에 붙여 넣으세요.';
let IP=null;addEventListener('beforeinstallprompt',e=>{e.preventDefault();IP=e;if(!SA){$('inst').hidden=false;$('instMsg').hidden=true}});
addEventListener('appinstalled',()=>{IP=null;$('inst').hidden=true;$('instMsg').hidden=false;$('instMsg').textContent='설치했습니다. 다음부터는 앱 아이콘으로 열고 초대 링크를 붙여 넣으세요.'});
$('inst').onclick=async()=>{if(!IP)return;IP.prompt();try{await IP.userChoice}catch{}IP=null;$('inst').hidden=true;$('instMsg').hidden=false};
`, '/__lab/app.js');

// again: 다시 열기 주소 (입장 호스트의 초대 화면 등, 절대 주소)
export const labEndedPage = (msg: string, again?: string) => page('AI 실습실', `
<h1>AI 실습실</h1>
<div class="card"><p id="m"></p>${again ? `<button id="again">다시 열기</button>` : ''}<p><a id="home" href="/__lab/home">다른 실습실 열기</a></p>
<p class="mut">예전에 실습 화면에서 설치한 앱이라면, 실습실 첫 화면을 열어 그곳에서 다시 설치하세요. 첫 화면 앱이 이미 있다면 "다른 실습실 열기"로 새 초대 링크를 넣으면 됩니다.</p></div>`, `
$('m').textContent=${js(msg)};
${again ? `$('again').onclick=()=>location.href=${js(again)};` : ''}
`, '/__lab/app.js', false);
