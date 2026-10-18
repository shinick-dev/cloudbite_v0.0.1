// 조교 전용 화면(/lab/assistant). 토큰은 입장 요청에만 쓰고 주소·저장소·로그에 남기지 않는다.
// 보이는 동안에만 도움 요청을 5초마다 읽고, 응답을 모르는 쓰기는 같은 requestId 로만 다시 확인한다.

export const LAB_ASSISTANT_HTML = String.raw`<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>조교 화면</title>
<style>
*{box-sizing:border-box}
html,body{margin:0;background:#f4f7f6;color:#0f172a}
body{font:16px/1.5 system-ui,"Segoe UI","Malgun Gothic",sans-serif}
main{max-width:720px;margin:0 auto;padding:16px}
h1,h2{font-size:20px;margin:0 0 8px}
button,input,textarea,select{font:inherit;max-width:100%}
input,textarea,select{width:100%;padding:8px;border:1px solid #d5e0dc;border-radius:8px;background:#fff;color:#0f172a}
textarea{min-height:88px}
button{min-height:44px;background:#0f766e;color:#fff;border:0;border-radius:10px;padding:10px 14px;font-weight:600}
button.sec{background:#fff;color:#0f172a;border:1px solid #d5e0dc}
button:disabled{opacity:.55}
.card{background:#fff;border:1px solid #d5e0dc;border-radius:12px;padding:12px;margin:12px 0}
p,h1,h2,li,label,button{overflow-wrap:anywhere}
pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.45 ui-monospace,Consolas,monospace}
.mut{color:#52606d}
.row{display:flex;flex-wrap:wrap;gap:8px}
dialog{box-sizing:border-box;width:min(480px,calc(100vw - 24px));max-width:calc(100vw - 24px);max-height:calc(100vh - 24px);overflow:auto;border:1px solid #d5e0dc;border-radius:12px;background:#fff;color:#0f172a;padding:16px}
</style>
</head>
<body>
<main>
<section id="login">
<h1>조교 화면</h1>
<p class="mut">모임지기가 알려 준 조교 토큰으로 이 수업에만 들어갑니다. 주소에 토큰을 붙이지 마세요.</p>
<label>조교 토큰<input id="token" type="password" autocomplete="off" spellcheck="false"></label>
<div class="row">
<button id="enter" type="button">들어가기</button>
<button id="enterRetry" class="sec" type="button" hidden>같은 입장 요청 다시 확인</button>
<button id="enterDrop" class="sec" type="button" hidden>입장 요청 버리기</button>
</div>
<p id="loginMsg" role="status"></p>
</section>
<section id="app" hidden>
<h1 id="labName"></h1>
<p id="labMeta" class="mut"></p>
<p id="controlLine" role="status"></p>
<div class="row"><button id="logout" class="sec" type="button">로그아웃</button></div>
<div id="seats" class="card" aria-label="자리 상태"></div>
<section id="help" hidden>
<h2>도움 요청</h2>
<p id="hint" class="mut" role="status"></p>
<div id="qList"></div>
<h2>승인된 요청문 수신</h2>
<p class="mut">승인된 요청문입니다. 여기서는 복사만 할 수 있고 실행하지 않습니다.</p>
<div id="mList"></div>
</section>
<section id="sendBox" hidden>
<h2>승인된 요청문 보내기</h2>
<label>승인된 요청문<select id="templatePick"></select></label>
<pre id="templatePreview"></pre>
<label>받을 자리<select id="seatPick"></select></label>
<div class="row">
<button id="sendTemplate" type="button">승인된 요청문 보내기</button>
<button id="templateRetry" class="sec" type="button" hidden>같은 요청문 다시 보내기</button>
<button id="templateDrop" class="sec" type="button" hidden>이 요청문 요청 버리기</button>
</div>
<p id="templateMsg" role="status"></p>
</section>
<div class="row">
<button id="pauseBtn" type="button" hidden>새 전달 일시정지</button>
<button id="pauseRetry" class="sec" type="button" hidden>같은 일시정지 요청 다시 확인</button>
<button id="pauseDrop" class="sec" type="button" hidden>이 일시정지 요청 버리기</button>
</div>
<p id="pauseMsg" role="status"></p>
<section>
<h2>처리 기록</h2>
<ul id="actionLog"><li>아직 확인된 처리가 없습니다.</li></ul>
</section>
</section>
</main>
<dialog id="pauseDlg" aria-labelledby="pauseTitle">
<h2 id="pauseTitle">수업 전체 일시정지</h2>
<p>수업 전체의 새 명령 전달을 일시정지합니다. 이미 실행 중인 프로그램은 멈추지 않습니다. 재개, 종료, 복구는 이 화면에서 하지 않습니다.</p>
<label>일시정지 이유<textarea id="reason" maxlength="300"></textarea></label>
<div class="row">
<button id="pauseConfirm" type="button">수업 전체 일시정지 확인</button>
<button id="pauseCancel" class="sec" type="button">취소</button>
</div>
</dialog>
<script>
(function(){
const $=id=>document.getElementById(id);
const login=$('login'),app=$('app'),tokenInput=$('token'),loginMsg=$('loginMsg');
const enterBtn=$('enter'),enterRetry=$('enterRetry'),enterDrop=$('enterDrop');
const labName=$('labName'),labMeta=$('labMeta'),controlLine=$('controlLine'),seats=$('seats');
const help=$('help'),hint=$('hint'),qList=$('qList'),mList=$('mList');
const sendBox=$('sendBox'),templatePick=$('templatePick'),seatPick=$('seatPick'),templatePreview=$('templatePreview');
const sendTemplate=$('sendTemplate'),templateRetry=$('templateRetry'),templateDrop=$('templateDrop'),templateMsg=$('templateMsg');
const pauseBtn=$('pauseBtn'),pauseRetry=$('pauseRetry'),pauseDrop=$('pauseDrop'),pauseMsg=$('pauseMsg');
const pauseDlg=$('pauseDlg'),reasonInput=$('reason'),actionLog=$('actionLog');
let view=null,authEpoch=0,timer=0,polling=false,writeBusy=false,pendingLogin=null,pendingReply=null,pendingTemplate=null,pendingPause=null,questions=[];
const replyDrafts=new Map();
tokenInput.autocomplete='off';
function stripUrl(){try{if(location.search||location.hash)History.prototype.replaceState.call(history,null,'',location.pathname||'/')}catch(e){}}
function has(scope){return !!(view&&Array.isArray(view.grant.scopes)&&view.grant.scopes.indexOf(scope)>=0)}
function validQuestion(q){return !!q&&typeof q.id==='string'&&typeof q.question==='string'&&typeof q.n==='number'&&(q.status==='open'||q.status==='answered'||q.status==='resolved')&&typeof q.at==='number'&&(q.reply==null||typeof q.reply==='string')}
function validStatus(j){
 if(!j||typeof j.now!=='number'||!j.grant||!j.lab||!j.control)return false;
 if(typeof j.lab.id!=='string'||typeof j.lab.name!=='string'||!Array.isArray(j.lab.seats))return false;
 if(j.grant.labId!==j.lab.id||!Array.isArray(j.grant.scopes)||j.grant.scopes.indexOf('status:read')<0)return false;
 if(!Array.isArray(j.grant.seats)||!Array.isArray(j.grant.templates))return false;
 if(j.control.mode!=='running'&&j.control.mode!=='paused'&&j.control.mode!=='ended')return false;
 if(!Number.isSafeInteger(j.control.revision))return false;
 return true;
}
function validPack(j){
 return !!j&&Array.isArray(j.questions)&&j.questions.every(validQuestion)&&Array.isArray(j.messages)&&j.messages.every(m=>!!m&&typeof m.id==='string'&&typeof m.title==='string'&&typeof m.text==='string'&&typeof m.at==='number');
}
async function request(path,body){
 const controller=new AbortController();
 let live=true,timerId=0;
 const timeout=new Promise((_,reject)=>{timerId=setTimeout(()=>{live=false;controller.abort();reject(Object.assign(new Error('응답 확인 시간이 지났습니다. 같은 요청으로 다시 확인하세요.'),{unknown:true}))},10000)});
 const work=(async()=>{
  let response;
  try{response=await fetch(path,{method:'POST',cache:'no-store',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify(body||{}),signal:controller.signal})}
  catch(e){if(!live)return null;throw Object.assign(new Error('응답 확인 시간이 지났습니다. 같은 요청으로 다시 확인하세요.'),{unknown:true})}
  if(!live)return null;
  let text='',parsed=null;
  try{text=await response.text()}catch(e){if(!live)return null;throw Object.assign(new Error('응답 확인 시간이 지났습니다. 같은 요청으로 다시 확인하세요.'),{unknown:true})}
  if(!live)return null;
  if(text){try{parsed=JSON.parse(text)}catch(e){parsed=null}}else parsed={};
  if(response.status===401||response.status===403||response.status===410)throw Object.assign(new Error('다시 인증해 주세요.'),{status:response.status,auth:true});
  const known=response.status>=400&&response.status<500&&parsed&&typeof parsed==='object';
  if(!response.ok||!parsed||typeof parsed!=='object')throw Object.assign(new Error((parsed&&parsed.error)||('HTTP '+response.status)),{status:response.status,known:!!known,unknown:!known});
  return parsed;
 })();
 try{
  const result=await Promise.race([work,timeout]);
  if(!live||result==null)throw Object.assign(new Error('응답 확인 시간이 지났습니다. 같은 요청으로 다시 확인하세요.'),{unknown:true});
  return result;
 }finally{live=false;clearTimeout(timerId)}
}
function clearStale(quiet){
 authEpoch++;
 clearTimeout(timer);timer=0;polling=false;view=null;questions=[];
 pendingReply=null;pendingTemplate=null;pendingPause=null;
 replyDrafts.clear();
 app.hidden=true;login.hidden=false;help.hidden=true;sendBox.hidden=true;pauseBtn.hidden=true;
 seats.replaceChildren();qList.replaceChildren();mList.replaceChildren();
 labName.textContent='';labMeta.textContent='';controlLine.textContent='';hint.textContent='';
 templatePreview.textContent='';templateMsg.textContent='';pauseMsg.textContent='';
 actionLog.replaceChildren();const empty=document.createElement('li');empty.textContent='아직 확인된 처리가 없습니다.';actionLog.append(empty);
 if(pauseDlg.open)pauseDlg.close();
 loginMsg.textContent=quiet?'':'다시 인증해 주세요.';
 paintLogin();paintWrites();
}
function paintLogin(){
 enterRetry.hidden=!pendingLogin;enterDrop.hidden=!pendingLogin;enterBtn.disabled=writeBusy||!!pendingLogin;enterRetry.disabled=writeBusy;enterDrop.disabled=writeBusy;
}
function paintWrites(){
 templateRetry.hidden=!pendingTemplate;templateDrop.hidden=!pendingTemplate;
 pauseRetry.hidden=!pendingPause;pauseDrop.hidden=!pendingPause;
 sendTemplate.disabled=writeBusy||!!pendingTemplate;templateRetry.disabled=writeBusy;templateDrop.disabled=writeBusy;
 pauseBtn.disabled=writeBusy||!!pendingPause||!view||view.control.mode==='ended';
 pauseRetry.disabled=writeBusy;pauseDrop.disabled=writeBusy;reasonInput.disabled=writeBusy||!!pendingPause;
}
function remember(text){
 if(actionLog.children.length===1&&actionLog.textContent.indexOf('아직 확인된 처리가 없습니다.')>=0)actionLog.replaceChildren();
 const li=document.createElement('li');
 let stamp='';
 try{stamp=new Date().toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit'})+' · '}catch(e){stamp=''}
 li.textContent=stamp+text;actionLog.prepend(li);
}
function seatText(s){
 const who=typeof s.who==='string'&&s.who?' · '+s.who:'';
 const hand=s.hand?' · 손 듦':'';
 const prep=s.preparation&&typeof s.preparation.state==='string'?' · 서버 준비 '+s.preparation.state:'';
 const del=s.delivery&&typeof s.delivery.status==='string'?' · 마지막 전달 '+s.delivery.status:'';
 return (typeof s.n==='number'?s.n+'번':'자리')+who+hand+prep+del;
}
function drawSeats(){
 seats.replaceChildren();
 for(const s of view.lab.seats){if(!view.grant.seats.includes(s.n))continue;const p=document.createElement('p');p.textContent=seatText(s);seats.append(p)}
}
function controlLabel(mode){return mode==='paused'?'새 전달 일시정지 중':mode==='ended'?'수업 종료':'새 전달 가능'}
function showApp(j){
 view=j;login.hidden=true;app.hidden=false;loginMsg.textContent='';
 labName.textContent=j.lab.name;
 const ending=j.lab.ending?' · 정리 재시도 중':'';
 labMeta.textContent='이 수업에만 연결되어 있습니다'+ending;
 controlLine.textContent=controlLabel(j.control.mode);
 drawSeats();
 help.hidden=!has('help:read');
 sendBox.hidden=!has('template:send');
 pauseBtn.hidden=!has('control:pause')||j.control.mode==='ended';
 fillPicks();
 paintWrites();
 poll(true);
}
function fillPicks(){
 templatePick.replaceChildren();seatPick.replaceChildren();
 const blankT=document.createElement('option');blankT.value='';blankT.textContent='요청문 선택';templatePick.append(blankT);
 for(const t of view.grant.templates){
  if(!t||typeof t.id!=='string'||typeof t.title!=='string')continue;
  const o=document.createElement('option');o.value=t.id;o.textContent=t.title;templatePick.append(o);
 }
 const blankS=document.createElement('option');blankS.value='';blankS.textContent='자리 선택';seatPick.append(blankS);
 for(const n of view.grant.seats){
  if(!Number.isInteger(n))continue;
  const o=document.createElement('option');o.value=String(n);o.textContent=n+'번';seatPick.append(o);
 }
 previewTemplate();
}
function previewTemplate(){
 const t=(view&&view.grant.templates||[]).find(item=>item&&item.id===templatePick.value);
 templatePreview.textContent=t&&typeof t.text==='string'?t.text:'';
}
function statusText(s){return s==='open'?'접수':s==='answered'?'답변':'본인확인'}
function drawQuestions(list){
 const active=document.activeElement;
 const focusId=active&&active.dataset&&active.dataset.replyQuestion;
 const selection=focusId?{start:active.selectionStart,end:active.selectionEnd}:null;
 for(const area of qList.querySelectorAll('textarea[data-reply-question]'))if(!area.disabled)replyDrafts.set(area.dataset.replyQuestion,area.value);
 questions=list;
 const openIds=new Set(list.filter(q=>q.status==='open').map(q=>q.id));
 for(const id of replyDrafts.keys())if(!openIds.has(id))replyDrafts.delete(id);
 if(pendingReply&&questions.some(q=>q.id===pendingReply.questionId&&q.status!=='open'))pendingReply=null;
 qList.replaceChildren();
 if(!questions.length){const p=document.createElement('p');p.className='mut';p.textContent='열린 도움 요청이 없습니다.';qList.append(p);return}
 for(const q of questions){
  const card=document.createElement('article');card.className='card';
  const head=document.createElement('p');head.textContent=q.n+'번 · '+statusText(q.status);card.append(head);
  const body=document.createElement('p');body.style.whiteSpace='pre-wrap';body.textContent=q.question;card.append(body);
  if(q.reply){const reply=document.createElement('p');reply.style.whiteSpace='pre-wrap';reply.textContent='답변: '+q.reply;card.append(reply)}
  if(q.status==='open'){
   const pending=pendingReply&&pendingReply.questionId===q.id;
   const label=document.createElement('label');label.textContent='답변 내용';
   const area=document.createElement('textarea');area.maxLength=2000;area.setAttribute('aria-label','답변 내용');
   area.dataset.replyQuestion=q.id;
   area.value=pending?pendingReply.text:(replyDrafts.get(q.id)||'');area.disabled=writeBusy||!!pendingReply;
   area.oninput=()=>replyDrafts.set(q.id,area.value);
   label.append(area);
   const row=document.createElement('div');row.className='row';
   const send=document.createElement('button');send.type='button';send.textContent=pending?'같은 답변 다시 보내기':'답변 보내기';
   send.disabled=writeBusy||(!!pendingReply&&!pending);
   send.onclick=()=>sendReply(q.id,area);
   row.append(send);
   if(pending){
    const drop=document.createElement('button');drop.type='button';drop.className='sec';drop.textContent='이 답변 요청 버리기';drop.disabled=writeBusy;
    drop.onclick=()=>{if(writeBusy||!pendingReply)return;pendingReply=null;hint.textContent='이 화면의 답변 요청을 버렸습니다. 서버에 이미 반영됐을 수 있습니다.';drawQuestions(questions)};
    row.append(drop);
   }
   card.append(label,row);
  }
  qList.append(card);
 }
 if(focusId){const area=[...qList.querySelectorAll('textarea[data-reply-question]')].find(a=>a.dataset.replyQuestion===focusId);if(area&&!area.disabled){area.focus({preventScroll:true});if(selection)area.setSelectionRange(selection.start,selection.end)}}
}
async function copyText(text,button,node){
 try{await navigator.clipboard.writeText(text);button.textContent='복사됨'}
 catch(e){const range=document.createRange();range.selectNodeContents(node);const sel=getSelection();sel.removeAllRanges();sel.addRange(range);button.textContent='선택됨 · 직접 복사'}
 setTimeout(()=>{button.textContent='요청문 복사'},1500);
}
function drawMessages(list){
 mList.replaceChildren();
 if(!list.length){const p=document.createElement('p');p.className='mut';p.textContent='받은 승인 요청문이 없습니다.';mList.append(p);return}
 for(const m of list){
  const card=document.createElement('article');card.className='card';
  const title=document.createElement('p');title.textContent=m.title;card.append(title);
  const pre=document.createElement('pre');pre.textContent=m.text;
  const copy=document.createElement('button');copy.type='button';copy.className='sec';copy.textContent='요청문 복사';
  copy.onclick=()=>copyText(m.text,copy,pre);
  card.append(pre,copy);mList.append(card);
 }
}
function arm(){
 clearTimeout(timer);timer=0;
 if(!view||document.visibilityState!=='visible')return;
 timer=setTimeout(()=>poll(),5000);
}
async function poll(initial=false){
 if(polling||!view||document.visibilityState!=='visible')return;
 if(writeBusy&&!initial){arm();return}
 const ticket=authEpoch;polling=true;
 try{
  if(!initial){
   const status=await request('/api/lab/assistant/status',{});
   if(ticket!==authEpoch)return;
   if(!validStatus(status)){hint.textContent='상태 응답을 확인하지 못했습니다.';return}
   if(status.grant.id!==view.grant.id||status.lab.id!==view.lab.id){clearStale(false);loginMsg.textContent='조교 연결이 바뀌었습니다. 다시 확인해 주세요.';return}
   view=status;labName.textContent=status.lab.name;controlLine.textContent=controlLabel(status.control.mode);drawSeats();
   pauseBtn.hidden=!has('control:pause')||status.control.mode==='ended';paintWrites();
  }
  if(!has('help:read'))return;
  const data=await request('/api/lab/assistant/questions',{id:view.lab.id});
  if(ticket!==authEpoch)return;
  if(!validPack(data)){hint.textContent='도움 요청 응답을 확인하지 못했습니다.';return}
  hint.textContent='';
  drawQuestions(data.questions);drawMessages(data.messages);
 }catch(e){
  if(e&&e.auth){clearStale(false);return}
  if(ticket===authEpoch)hint.textContent='도움 요청을 확인하지 못했습니다.';
 }finally{polling=false;if(ticket===authEpoch&&view)arm()}
}
document.addEventListener('visibilitychange',()=>{clearTimeout(timer);if(document.visibilityState==='visible')poll()});
async function enter(){
 if(writeBusy)return;
 if(!pendingLogin){
  const token=tokenInput.value;
  if(!token.trim()){loginMsg.textContent='토큰을 입력하세요.';return}
  tokenInput.value='';
  pendingLogin={token};
 }
 const token=pendingLogin.token;
 writeBusy=true;paintLogin();
 loginMsg.textContent='입장 결과를 확인하는 중…';
 try{
  await request('/api/lab/assistant/session',{token});
  pendingLogin=null;paintLogin();
  const data=await request('/api/lab/assistant/status',{});
  if(!validStatus(data)){loginMsg.textContent='상태 응답을 확인하지 못했습니다.';return}
  writeBusy=false;
  showApp(data);
 }catch(e){
  if(e&&(e.auth||e.known)){pendingLogin=null;loginMsg.textContent=e.auth?'토큰을 확인하지 못했습니다.':(e.message||'입장하지 못했습니다.')}
  else loginMsg.textContent='입장 결과를 확인하지 못했습니다. 같은 요청으로 다시 확인하세요.';
 }finally{writeBusy=false;paintLogin();if(view)paintWrites()}
}
async function sendReply(questionId,area){
 if(writeBusy||!view)return;
 if(!pendingReply){
  const text=area.value;
  if(!text.trim()||text.length>2000){hint.textContent='답변은 2000자 이내로 적어 주세요.';return}
  pendingReply={requestId:crypto.randomUUID(),questionId,text};
 }
 const pending=pendingReply;
 writeBusy=true;drawQuestions(questions);paintWrites();
 hint.textContent='답변 결과를 확인하는 중…';
 const ticket=authEpoch;
 try{
  const data=await request('/api/lab/assistant/reply',{id:view.lab.id,requestId:pending.requestId,questionId:pending.questionId,text:pending.text});
  if(ticket!==authEpoch)return;
  if(!data||!validQuestion(data.question)||data.question.id!==pending.questionId||data.question.status==='open'){hint.textContent='답변 응답을 확인하지 못했습니다. 같은 요청으로 다시 확인하세요.';return}
  pendingReply=null;
  const i=questions.findIndex(q=>q.id===data.question.id);
  if(i>=0)questions[i]=data.question;else questions.unshift(data.question);
  hint.textContent='답변을 보냈습니다. 같은 질문에는 다시 답하지 않습니다.';
  remember('도움 답변을 보냈습니다.');
  drawQuestions(questions);
 }catch(e){
  if(e&&e.auth){clearStale(false);return}
  if(e&&e.known){pendingReply=null;hint.textContent=e.message||'답변이 거절됐습니다.'}
  else hint.textContent='답변 결과를 확인하지 못했습니다. 같은 요청으로 다시 확인하세요.';
 }finally{writeBusy=false;if(view)drawQuestions(questions);paintWrites()}
}
async function sendTemplateNow(){
 if(writeBusy||!view||!has('template:send'))return;
 if(!pendingTemplate){
  const templateId=templatePick.value;
  const n=Number(seatPick.value);
  if(!templateId||!Number.isInteger(n)){templateMsg.textContent='승인된 요청문과 받을 자리를 선택하세요.';return}
  pendingTemplate={requestId:crypto.randomUUID(),templateId,n};
 }
 const pending=pendingTemplate;
 writeBusy=true;paintWrites();
 templateMsg.textContent='요청문 전송 결과를 확인하는 중…';
 const ticket=authEpoch;
 try{
  const data=await request('/api/lab/assistant/template',{id:view.lab.id,requestId:pending.requestId,templateId:pending.templateId,n:pending.n});
  if(ticket!==authEpoch)return;
  if(!data||!data.message||typeof data.message.text!=='string'||typeof data.message.id!=='string'){templateMsg.textContent='요청문 응답을 확인하지 못했습니다. 같은 요청으로 다시 확인하세요.';return}
  pendingTemplate=null;
  const pre=document.createElement('pre');pre.textContent=data.message.text;templateMsg.textContent='';templateMsg.append('요청문을 보냈습니다. 실행하지 않습니다.');templateMsg.append(pre);
  remember('승인된 요청문을 보냈습니다.');
 }catch(e){
  if(e&&e.auth){clearStale(false);return}
  if(e&&e.known){pendingTemplate=null;templateMsg.textContent=e.message||'요청문이 거절됐습니다.'}
  else templateMsg.textContent='요청문 결과를 확인하지 못했습니다. 같은 요청으로 다시 확인하세요.';
 }finally{writeBusy=false;paintWrites()}
}
async function sendPause(){
 if(writeBusy||!view||!has('control:pause'))return;
 if(!pendingPause){
  const reason=reasonInput.value;
  if(!reason.trim()||reason.length>300){pauseMsg.textContent='이유는 300자 이내로 적어 주세요.';return}
  pendingPause={requestId:crypto.randomUUID(),reason};
 }
 const pending=pendingPause;
 writeBusy=true;paintWrites();
 pauseMsg.textContent='일시정지 결과를 확인하는 중…';
 const ticket=authEpoch;
 try{
  const data=await request('/api/lab/assistant/pause',{id:view.lab.id,requestId:pending.requestId,reason:pending.reason});
  if(ticket!==authEpoch)return;
  if(!data||!data.control||(data.control.mode!=='running'&&data.control.mode!=='paused'&&data.control.mode!=='ended')||!Number.isSafeInteger(data.control.revision)){
   pauseMsg.textContent='일시정지 응답을 확인하지 못했습니다. 같은 요청으로 다시 확인하세요.';return;
  }
  pendingPause=null;reasonInput.value='';
  view.control=data.control;
  controlLine.textContent=controlLabel(data.control.mode);
  pauseBtn.hidden=!has('control:pause')||data.control.mode==='ended';
  if(pauseDlg.open)pauseDlg.close();
  pauseMsg.textContent='새 전달을 일시정지했습니다. 이미 실행 중인 프로그램은 멈추지 않습니다.';
  remember('새 전달을 일시정지했습니다.');
 }catch(e){
  if(e&&e.auth){clearStale(false);return}
  if(e&&e.known){pendingPause=null;pauseMsg.textContent=e.message||'일시정지가 거절됐습니다.'}
  else pauseMsg.textContent='일시정지 결과를 확인하지 못했습니다. 같은 요청으로 다시 확인하세요.';
 }finally{writeBusy=false;paintWrites()}
}
enterBtn.onclick=()=>enter();
enterRetry.onclick=()=>enter();
enterDrop.onclick=()=>{if(writeBusy||!pendingLogin)return;pendingLogin=null;loginMsg.textContent='입장 요청을 화면에서 버렸습니다.';paintLogin()};
tokenInput.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();enter()}});
$('logout').onclick=async()=>{
 if(writeBusy)return;
 writeBusy=true;
 try{await request('/api/lab/assistant/logout',{})}catch(e){}
 writeBusy=false;
 clearStale(true);
 loginMsg.textContent='로그아웃했습니다.';
};
templatePick.onchange=()=>previewTemplate();
sendTemplate.onclick=()=>sendTemplateNow();
templateRetry.onclick=()=>sendTemplateNow();
templateDrop.onclick=()=>{if(writeBusy||!pendingTemplate)return;pendingTemplate=null;templateMsg.textContent='이 화면의 요청문 전송을 버렸습니다. 서버에 이미 반영됐을 수 있습니다.';paintWrites()};
pauseBtn.onclick=()=>{if(writeBusy||pendingPause||!has('control:pause'))return;pauseDlg.showModal();reasonInput.focus()};
pauseRetry.onclick=()=>sendPause();
pauseDrop.onclick=()=>{if(writeBusy||!pendingPause)return;pendingPause=null;pauseMsg.textContent='이 화면의 일시정지 요청을 버렸습니다. 서버에 이미 반영됐을 수 있습니다.';paintWrites()};
$('pauseConfirm').onclick=()=>sendPause();
$('pauseCancel').onclick=()=>{if(pauseDlg.open)pauseDlg.close()};
async function boot(){
 stripUrl();
 try{
  const data=await request('/api/lab/assistant/status',{});
  if(!validStatus(data)){loginMsg.textContent='상태 응답을 확인하지 못했습니다.';return}
  showApp(data);
 }catch(e){
  if(e&&e.auth){loginMsg.textContent='';return}
  loginMsg.textContent='상태 확인 시간이 지났습니다. 다시 시도해 주세요.';
 }
}
boot();
})();
</script>
</body>
</html>
`;
