// 모임지기 수업 카드의 조교 권한. 인증 헤더는 호출하는 쪽이 api 에 넣는다.
// 일회용 토큰은 이 대화상자가 열려 있는 동안에만 보이고, 닫기·만료·로그아웃에서 지운다.

export const LAB_ASSISTANTS_JS = String.raw`
function createLabAssistants(D){
 const buttons=new Map(), labs=new Map();
 let dialog=null, current=null, secret='', epoch=0, issuing=false, reading=false, revoking=false;
 const ISSUE_UNKNOWN='응답 시간을 넘겼습니다. 일회용 토큰이 이미 만들어졌을 수 있어 자동으로 다시 보내지 않습니다. 목록을 새로고침하고, 방금 권한이 보이면 그 권한을 회수한 뒤 새 권한을 만드세요.';
 const PAUSE_NOTE='새 전달 일시정지는 수업 전체에 적용되고, 실행 중인 프로그램은 멈추지 않습니다. 쓸 수 있는 자리를 모두 선택해야 합니다.';
 const TOKEN_WARN='일반 채팅, 주소, 화면 공유로 토큰을 보내지 마세요. 조교 입장은 /lab/assistant 이며 토큰을 주소에 넣지 않습니다. 자동으로 보내지 않습니다.';
 const SCOPE_TEXT={'status:read':'자리 상태 보기','help:read':'도움 요청 보기','help:reply':'도움 답변','template:send':'승인된 요청문 보내기','control:pause':'새 전달 일시정지'};
 const el=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n};
 const known=e=>Number.isInteger(e&&e.status)&&e.status>=400&&e.status<500;
 function wipeToken(){
  secret='';
  if(!dialog)return;
  const input=dialog.querySelector('[data-token]');
  const fallback=dialog.querySelector('[data-token-fallback]');
  const box=dialog.querySelector('[data-token-box]');
  if(input){input.value='';input.type='password'}
  if(fallback)fallback.textContent='';
  if(box)box.hidden=true;
 }
 function close(){
  epoch++;
  wipeToken();
  if(dialog&&dialog.open)dialog.close();
 }
 window.addEventListener('lab-admin-ended',()=>{close()});
 async function call(path,body){
  const wait=D.timeoutMs||10000;
  let live=true,timer;
  try{
   return await Promise.race([
    Promise.resolve().then(()=>D.api(path,body)).then(v=>{if(!live)return null;return v}).catch(e=>{if(!live)return null;throw e}),
    new Promise((_,reject)=>{timer=setTimeout(()=>{live=false;reject(Object.assign(new Error(ISSUE_UNKNOWN),{unknown:true}))},wait)})
   ]);
  }finally{live=false;clearTimeout(timer)}
 }
 function checkbox(text,checked,disabled){
  const label=el('label'),input=el('input'),span=el('span',text);
  input.type='checkbox';input.checked=!!checked;input.disabled=!!disabled;
  input.style.cssText='width:auto;flex:0 0 auto;margin-top:4px';
  label.style.cssText='display:flex;align-items:flex-start;gap:8px;margin:6px 0;overflow-wrap:anywhere';
  label.append(input,span);return{label,input};
 }
 function paint(){
  if(!dialog)return;
  const issue=dialog.querySelector('[data-issue]');
  const refresh=dialog.querySelector('[data-refresh]');
  if(issue)issue.disabled=issuing||reading||revoking;
  if(refresh)refresh.disabled=issuing||reading||revoking;
 }
 function capOf(lab){
  const remain=Math.floor((Number(lab.expiresAt)-Date.now())/60000);
  if(!Number.isFinite(remain))return 0;
  return Math.min(120,remain);
 }
 function fillForm(lab){
  dialog.querySelector('[data-lab-name]').textContent=lab.name||'';
  const label=dialog.querySelector('[data-label]');
  label.value='Grok 총괄조교';
  const seats=dialog.querySelector('[data-seats]');
  seats.replaceChildren();
  for(const seat of lab.seats||[]){
   const usable=!seat.error;
   const text=seat.n+'번 자리'+(seat.who?' · '+seat.who:'')+(usable?'':' · 사용할 수 없음');
   const box=checkbox(text,false,!usable);
   box.input.dataset.seat=String(seat.n);
   if(usable)box.input.dataset.usable='1';
   seats.append(box.label);
  }
  dialog.querySelector('[data-scope="status:read"]').checked=true;
  dialog.querySelector('[data-scope="help:read"]').checked=true;
  dialog.querySelector('[data-scope="help:reply"]').checked=true;
  dialog.querySelector('[data-scope="template:send"]').checked=false;
  dialog.querySelector('[data-scope="control:pause"]').checked=false;
  const cap=capOf(lab),minutes=dialog.querySelector('[data-minutes]');
  if(cap<5){
   minutes.value='';minutes.disabled=true;minutes.max='0';
   dialog.querySelector('[data-cap]').textContent='모임 종료까지 5분이 남지 않아 조교 권한을 만들 수 없습니다.';
  }else{
   minutes.disabled=false;minutes.min='5';minutes.max=String(cap);minutes.value=String(Math.min(60,cap));
   dialog.querySelector('[data-cap]').textContent='유효 시간은 5분에서 '+cap+'분까지입니다. 모임 종료 시각을 넘기지 않습니다.';
  }
  for(const row of dialog.querySelectorAll('[data-template]')){row.querySelector('input').value='';row.querySelector('textarea').value=''}
 }
 function selectedSeats(){
  return [...dialog.querySelectorAll('[data-seat]:checked')].map(n=>Number(n.dataset.seat)).filter(n=>Number.isInteger(n)).sort((a,b)=>a-b);
 }
 function usableSeats(){
  return [...dialog.querySelectorAll('[data-usable]')].map(n=>Number(n.dataset.seat)).filter(n=>Number.isInteger(n)).sort((a,b)=>a-b);
 }
 function build(){
  const msg=dialog.querySelector('[data-form-msg]');
  const lab=current;
  if(!lab){msg.textContent='수업을 다시 여세요.';return null}
  const label=dialog.querySelector('[data-label]').value.trim();
  if(!label||label.length>60){msg.textContent='표시 이름은 1자에서 60자까지입니다.';return null}
  const seats=selectedSeats();
  const usable=usableSeats();
  if(!seats.length){msg.textContent='자리를 하나 이상 선택하세요.';return null}
  if(seats.some(n=>!usable.includes(n))){msg.textContent='사용할 수 없는 자리는 선택하지 않습니다.';return null}
  const pause=dialog.querySelector('[data-scope="control:pause"]').checked;
  if(pause&&(seats.length!==usable.length||usable.some(n=>!seats.includes(n)))){msg.textContent=PAUSE_NOTE;return null}
  const cap=capOf(lab);
  const minutes=Number(dialog.querySelector('[data-minutes]').value);
  if(cap<5||!Number.isInteger(minutes)||minutes<5||minutes>Math.min(120,cap)){msg.textContent='유효 시간은 5분에서 '+Math.min(120,cap)+'분까지이며 모임 종료를 넘길 수 없습니다.';return null}
  const scopes=['status:read'];
  for(const key of ['help:read','help:reply','template:send','control:pause'])if(dialog.querySelector('[data-scope="'+key+'"]').checked)scopes.push(key);
  const templates=[];
  for(const row of dialog.querySelectorAll('[data-template]')){
   const title=row.querySelector('input').value.trim();
   const text=row.querySelector('textarea').value;
   if(!title&&!text.trim())continue;
   if(!title||!text.trim()||title.length>80||text.length>8000){msg.textContent='승인된 요청문은 제목 80자, 내용 8000자 이내로 제목과 내용을 함께 적으세요.';return null}
   templates.push({title,text});
  }
  if(templates.length>3){msg.textContent='승인된 요청문은 3개까지입니다.';return null}
  msg.textContent='';
  return{id:lab.id,label,seats,scopes,minutes,templates};
 }
 function validGrant(g,labId){
  return !!g&&typeof g.id==='string'&&g.labId===labId&&typeof g.label==='string'&&Array.isArray(g.seats)&&g.seats.every(n=>Number.isInteger(n))&&Array.isArray(g.scopes)&&g.scopes.every(s=>typeof s==='string')&&Number.isFinite(g.createdAt)&&Number.isFinite(g.expiresAt)&&(g.revokedAt==null||Number.isFinite(g.revokedAt))&&Array.isArray(g.templates);
 }
 function hm(t){try{return new Date(t).toLocaleString('ko-KR',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})}catch(e){return ''}}
 function drawGrants(data){
  const box=dialog.querySelector('[data-grants]');
  const note=dialog.querySelector('[data-list-msg]');
  if(!data||!Array.isArray(data.grants)||data.grants.some(g=>!validGrant(g,current.id))){note.textContent='권한 목록 응답을 확인하지 못했습니다.';return}
  note.textContent='';
  box.replaceChildren();
  if(!data.grants.length){box.append(el('p','등록된 조교 권한이 없습니다.'));return}
  for(const g of data.grants){
   const card=el('article');
   card.style.cssText='margin:8px 0;padding:8px;border:1px solid #d5e0dc;border-radius:8px;background:#fff';
   card.append(el('p',g.label));
   card.append(el('p','자리 '+g.seats.map(n=>n+'번').join(', ')));
   card.append(el('p','권한 '+g.scopes.map(s=>SCOPE_TEXT[s]||s).join(', ')));
   card.append(el('p','만료 '+hm(g.expiresAt)+(g.revokedAt?' · 회수됨':' · 사용 중')));
   if(!g.revokedAt){
    const b=el('button','권한 회수');
    b.type='button';b.className='sec';
    b.style.cssText='width:auto;max-width:100%;min-height:44px;white-space:normal';
    b.setAttribute('aria-label','권한 회수 '+g.label);
    b.onclick=()=>revoke(g.id);
    card.append(b);
   }
   box.append(card);
  }
 }
 function drawAudit(data){
  const box=dialog.querySelector('[data-audit]');
  if(!data||!Array.isArray(data.items)||data.items.some(item=>!item||typeof item.grantId!=='string'||typeof item.action!=='string'||!Number.isFinite(item.at))){
   box.replaceChildren(el('p','권한 기록을 확인하지 못했습니다.'));return;
  }
  box.replaceChildren();
  if(!data.items.length){box.append(el('p','권한 기록이 없습니다.'));return}
  for(const item of data.items){
   const bits=[hm(item.at),item.action,item.grantId];
   if(item.n!=null)bits.push(String(item.n)+'번');
   if(item.requestId)bits.push(String(item.requestId));
   const p=el('p',bits.join(' · '));
   p.style.overflowWrap='anywhere';
   box.append(p);
  }
 }
 async function refresh(){
  if(reading||issuing||!current)return;
  reading=true;paint();
  const ticket=epoch,id=current.id;
  const note=dialog.querySelector('[data-list-msg]');
  try{
   const list=await call('/api/lab/assistants/list',{id});
   if(ticket!==epoch||!current||current.id!==id)return;
   if(list==null){note.textContent='목록을 확인하지 못했습니다.';return}
   drawGrants(list);
   const audit=await call('/api/lab/assistants/audit',{id});
   if(ticket!==epoch||!current||current.id!==id)return;
   if(audit==null){note.textContent='목록을 확인하지 못했습니다.';return}
   drawAudit(audit);
  }catch(e){if(ticket===epoch)note.textContent='목록을 확인하지 못했습니다.'}
  finally{reading=false;paint()}
 }
 function showToken(value){
  if(!dialog||!dialog.open)return;
  secret=value;
  const box=dialog.querySelector('[data-token-box]');
  const input=dialog.querySelector('[data-token]');
  box.hidden=false;
  input.type='password';
  input.value=value;
 }
 async function issue(){
  if(issuing||reading||revoking)return;
  const payload=build();
  if(!payload)return;
  issuing=true;paint();
  const ticket=epoch;
  wipeToken();
  const msg=dialog.querySelector('[data-form-msg]');
  msg.textContent='조교 권한 결과를 확인하는 중… 응답이 늦으면 자동으로 다시 보내지 않습니다.';
  try{
   const data=await call('/api/lab/assistants/issue',payload);
   if(ticket!==epoch||!dialog.open)return;
   if(data==null||typeof data.token!=='string'||!data.token||!validGrant(data.grant,current.id)){
    msg.textContent='권한 응답을 확인하지 못했습니다. 목록을 새로고침하고, 불명확한 권한은 회수한 뒤 새로 만드세요. 자동으로 다시 보내지 않습니다.';
    return;
   }
   showToken(data.token);
   msg.textContent='조교 권한을 만들었습니다. 토큰은 이 창을 닫으면 다시 볼 수 없습니다.';
   issuing=false;
   await refresh();
  }catch(e){
   if(ticket!==epoch||!dialog.open)return;
   msg.textContent=known(e)?(e.message||'권한을 만들지 못했습니다.'):ISSUE_UNKNOWN;
  }finally{issuing=false;paint()}
 }
 async function revoke(grantId){
  if(issuing||reading||revoking||!current)return;
  revoking=true;paint();
  const ticket=epoch,id=current.id;
  const note=dialog.querySelector('[data-list-msg]');
  note.textContent='회수 결과를 확인하는 중…';
  try{
   const data=await call('/api/lab/assistants/revoke',{id,grantId});
   if(ticket!==epoch||!current||current.id!==id)return;
   if(!data||data.ok!==true||!validGrant(data.grant,id)||data.grant.id!==grantId||!data.grant.revokedAt){
    note.textContent='회수 응답을 확인하지 못했습니다. 자동으로 다시 보내지 않습니다. 목록을 새로고침해 확인하세요.';
    return;
   }
   note.textContent='권한을 회수했습니다.';
   revoking=false;
   await refresh();
  }catch(e){
   if(ticket!==epoch)return;
   note.textContent=known(e)?(e.message||'회수하지 못했습니다.'):'회수 결과를 확인하지 못했습니다. 자동으로 다시 보내지 않습니다. 목록을 새로고침해 확인하세요.';
  }finally{revoking=false;paint()}
 }
 function ensure(){
  if(dialog)return;
  dialog=el('dialog');
  dialog.style.cssText='box-sizing:border-box;width:min(560px,calc(100vw - 24px));max-width:calc(100vw - 24px);max-height:calc(100vh - 24px);overflow:auto;padding:16px;border:1px solid #d5e0dc;border-radius:12px;background:#f4f7f6;color:#0f172a;font:16px/1.5 system-ui,sans-serif';
  const title=el('h2','조교 권한');title.id='lab-assist-title';title.tabIndex=-1;title.style.margin='0 0 8px';
  dialog.setAttribute('aria-labelledby',title.id);
  const labName=el('p','');labName.dataset.labName='1';labName.style.overflowWrap='anywhere';
  const warn=el('p',TOKEN_WARN);warn.style.cssText='color:#52606d;overflow-wrap:anywhere';
  const pauseNote=el('p',PAUSE_NOTE);pauseNote.style.cssText='color:#52606d;overflow-wrap:anywhere';
  const labelField=el('label');labelField.append(el('span','표시 이름'));
  const label=el('input');label.dataset.label='1';label.maxLength=60;label.autocomplete='off';label.style.cssText='box-sizing:border-box;display:block;width:100%;max-width:100%;margin:4px 0 8px;padding:8px';
  labelField.append(label);
  const seatLegend=el('p','자리 선택');
  const seats=el('div');seats.dataset.seats='1';seats.setAttribute('role','group');seats.setAttribute('aria-label','자리 선택');
  const scopeLegend=el('p','권한 범위');
  const scopes=el('div');scopes.setAttribute('role','group');scopes.setAttribute('aria-label','권한 범위');
  const scopeDefs=[['status:read',true,true],['help:read',true,false],['help:reply',true,false],['template:send',false,false],['control:pause',false,false]];
  for(const [key,checked,disabled] of scopeDefs){
   const box=checkbox(SCOPE_TEXT[key],checked,disabled);
   box.input.dataset.scope=key;
   scopes.append(box.label);
  }
  const minuteField=el('label');minuteField.append(el('span','유효 시간(분)'));
  const minutes=el('input');minutes.type='number';minutes.dataset.minutes='1';minutes.style.cssText='box-sizing:border-box;display:block;width:100%;max-width:100%;margin:4px 0 8px;padding:8px';
  minuteField.append(minutes);
  const cap=el('p','');cap.dataset.cap='1';cap.style.cssText='color:#52606d;overflow-wrap:anywhere';
  const templates=el('div');
  for(let i=1;i<=3;i++){
   const row=el('div');row.dataset.template=String(i);
   const tLabel=el('label');tLabel.append(el('span','요청문 '+i+' 제목'));
   const t=el('input');t.maxLength=80;t.autocomplete='off';t.style.cssText='box-sizing:border-box;display:block;width:100%;max-width:100%;margin:4px 0 8px;padding:8px';
   tLabel.append(t);
   const xLabel=el('label');xLabel.append(el('span','요청문 '+i+' 내용'));
   const area=el('textarea');area.maxLength=8000;area.style.cssText='box-sizing:border-box;display:block;width:100%;max-width:100%;min-height:72px;margin:4px 0 8px;padding:8px';
   xLabel.append(area);row.append(tLabel,xLabel);templates.append(row);
  }
  const issueBtn=el('button','조교 권한 만들기');issueBtn.type='button';issueBtn.dataset.issue='1';
  issueBtn.style.cssText='width:auto;max-width:100%;min-height:44px;margin:4px 8px 4px 0;background:#0f766e;color:#fff;border:0;border-radius:10px;padding:8px 12px;white-space:normal';
  issueBtn.onclick=()=>issue();
  const formMsg=el('p','');formMsg.dataset.formMsg='1';formMsg.setAttribute('role','status');formMsg.style.overflowWrap='anywhere';
  const tokenBox=el('div');tokenBox.dataset.tokenBox='1';tokenBox.hidden=true;
  const tokenLabel=el('label');tokenLabel.append(el('span','일회용 토큰'));
  const token=el('input');token.dataset.token='1';token.type='password';token.readOnly=true;token.autocomplete='off';token.setAttribute('aria-label','일회용 토큰');
  token.style.cssText='box-sizing:border-box;display:block;width:100%;max-width:100%;margin:4px 0 8px;padding:8px';
  tokenLabel.append(token);
  const copy=el('button','토큰 복사');copy.type='button';copy.className='sec';
  copy.style.cssText='width:auto;max-width:100%;min-height:44px;white-space:normal';
  const fallback=el('pre','');fallback.dataset.tokenFallback='1';fallback.style.cssText='white-space:pre-wrap;overflow-wrap:anywhere';
  copy.onclick=async()=>{
   if(!secret)return;
   try{await navigator.clipboard.writeText(secret);copy.textContent='복사됨'}
   catch(e){
    fallback.textContent=secret;
    const range=document.createRange();range.selectNodeContents(fallback);const sel=getSelection();sel.removeAllRanges();sel.addRange(range);
    copy.textContent='선택됨 · 직접 복사';
   }
   setTimeout(()=>{copy.textContent='토큰 복사'},1500);
  };
  tokenBox.append(tokenLabel,copy,fallback);
  const refreshBtn=el('button','목록 새로고침');refreshBtn.type='button';refreshBtn.dataset.refresh='1';refreshBtn.className='sec';
  refreshBtn.style.cssText='width:auto;max-width:100%;min-height:44px;white-space:normal';
  refreshBtn.onclick=()=>refresh();
  const listMsg=el('p','');listMsg.dataset.listMsg='1';listMsg.setAttribute('role','status');listMsg.style.overflowWrap='anywhere';
  const grants=el('div');grants.dataset.grants='1';
  const auditHead=el('h3','권한 기록');auditHead.style.fontSize='16px';
  const audit=el('div');audit.dataset.audit='1';
  const closeBtn=el('button','닫기');closeBtn.type='button';closeBtn.className='sec';
  closeBtn.style.cssText='width:auto;max-width:100%;min-height:44px;white-space:normal';
  closeBtn.onclick=()=>close();
  dialog.append(title,labName,warn,pauseNote,labelField,seatLegend,seats,scopeLegend,scopes,minuteField,cap,templates,issueBtn,formMsg,tokenBox,refreshBtn,listMsg,grants,auditHead,audit,closeBtn);
  dialog.addEventListener('close',()=>{epoch++;wipeToken()});
  dialog.addEventListener('keydown',e=>{if(e.key==='Escape')e.stopPropagation()});
  document.body.append(dialog);
 }
 function open(lab){
  ensure();
  labs.set(lab.id,lab);
  if(issuing){if(!dialog.open)dialog.showModal();dialog.querySelector('#lab-assist-title').focus();return}
  if(!current||current.id!==lab.id){if(current&&current.id!==lab.id){epoch++;wipeToken()}current=lab;fillForm(lab)}
  if(!dialog.open)dialog.showModal();
  dialog.querySelector('[data-label]').focus();
  refresh();
 }
 function button(lab){
  let node=buttons.get(lab.id);
  if(!node){
   node=el('button','조교 권한');
   node.type='button';node.className='sec';
   node.style.cssText='width:auto;max-width:100%;min-height:44px;white-space:normal;overflow-wrap:anywhere';
   buttons.set(lab.id,node);
  }
  labs.set(lab.id,lab);
  node.onclick=()=>open(labs.get(lab.id));
  return node;
 }
 return{button,close};
}
window.createLabAssistants=createLabAssistants;
`;
