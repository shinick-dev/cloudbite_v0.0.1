// Separate from transmission pause: explicit, fixed Ctrl+C to a verified teaching pane.
export const LAB_INTERRUPT_JS = String.raw`
function createLabInterrupt(D){
 const states=new Map(),now=()=>D.now?D.now():Date.now();let focused=null;
 const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n};
 document.addEventListener('focusin',e=>{focused=e.target?.closest?.('[data-lab-interrupt]')?e.target:null});
 document.addEventListener('pointerdown',e=>{if(!e.target?.closest?.('[data-lab-interrupt]'))focused=null},true);
 async function call(path,body){let timer;try{return await Promise.race([Promise.resolve().then(()=>D.call(path,body)),new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('응답 확인 시간이 지났습니다. 같은 요청으로 결과를 확인하세요.')),D.timeoutMs||8000))])}finally{clearTimeout(timer)}}
 const epoch=s=>D.control?D.control.epoch(s.id):0;
 const definite=e=>Number.isInteger(e?.status)&&e.status>=400&&e.status<500;
 const message=(s,text)=>{s.msg.textContent=text};
 function clearPreview(s){s.preview=null;s.pendingPreview=null;s.confirm.hidden=true;s.programs.textContent=''}
 function paint(s){
  const pending=!!s.pendingAction,busy=s.reading||s.preparing||s.sending;
  s.refresh.disabled=busy||pending;s.prepare.disabled=busy||pending||!!s.preview||!s.loaded||!s.selected.size;
  s.prepare.textContent=s.pendingPreview?'같은 프로그램 확인 요청 다시 확인':'선택한 자리의 실행 프로그램 확인';
  s.execute.disabled=busy||!s.preview||s.preview.expiresAt<=now()||s.preview.epoch!==epoch(s);
  s.retry.hidden=!pending;s.retry.disabled=busy;s.forget.hidden=!pending;s.forget.disabled=busy;
  for(const c of s.choices.querySelectorAll('input'))c.disabled=busy||pending||!!s.pendingPreview;
  s.cancel.disabled=busy;
 }
 async function refresh(s){
  if(s.reading||s.preparing||s.sending||s.pendingAction)return;
  s.reading=true;s.seq++;const seq=s.seq;clearPreview(s);s.loaded=false;s.selected.clear();s.choices.textContent='';paint(s);
  message(s,'전달 상태와 수업 터미널의 대상을 확인하는 중…');
  try{
   const control=await call('/api/lab/control/status',{id:s.id});
   if(control?.mode!=='paused'||!Number.isSafeInteger(control.revision))throw Error('위의 명령 전달 일시정지를 누른 뒤 다시 확인하세요.');
   const session=await call('/api/lab/terminal/status',{id:s.id});if(seq!==s.seq)return;
   if(session?.needsTakeover)throw Error('수업 터미널 영역에서 상태를 확인하고 이어받은 뒤 다시 확인하세요.');
   if(typeof session?.sessionId!=='string'||!Array.isArray(session.seats)||!session.seats.length)throw Error('중단 요청할 수업 터미널이 없습니다. 각 자리에서 직접 확인하세요.');
   s.revision=control.revision;s.loaded=true;s.loadedEpoch=epoch(s);
   for(const seat of session.seats){
    if(!Number.isInteger(seat.n)||seat.n<1)throw Error('자리 목록을 확인하지 못했습니다.');
    const label=el('label'),check=el('input');check.type='checkbox';check.value=String(seat.n);check.style.cssText='width:auto;flex:0 0 auto';check.setAttribute('aria-label',seat.n+'번 자리 중단 대상');
    label.style.cssText='display:flex;align-items:center;gap:8px;min-height:44px;overflow-wrap:anywhere';
    const who=s.lab.seats.find(x=>x.n===seat.n)?.who;
    label.append(check,el('span',seat.n+'번'+(who?' · '+who:'')));s.choices.append(label);
    check.onchange=()=>{clearPreview(s);if(check.checked)s.selected.add(seat.n);else s.selected.delete(seat.n);paint(s)};
   }
   message(s,'중단 요청할 자리를 직접 선택하세요. 개인 터미널에는 입력을 보내지 않습니다.');
  }catch(e){if(seq===s.seq){s.loaded=false;message(s,D.cleanErr(e.message))}}finally{s.reading=false;paint(s)}
 }
 async function prepare(s){
  if(s.preparing||s.pendingAction||!s.loaded||!s.selected.size)return;
  if(s.loadedEpoch!==epoch(s)){s.loaded=false;message(s,'전달 상태가 바뀌었습니다. 대상 다시 확인을 눌러주세요.');paint(s);return}
  s.pendingPreview??={id:s.id,previewId:crypto.randomUUID(),seats:[...s.selected].sort((a,b)=>a-b),expectedRevision:s.revision};
  const pending=s.pendingPreview,seq=s.seq,atEpoch=epoch(s);s.preparing=true;paint(s);message(s,'선택한 수업 터미널의 프로그램을 확인하는 중… 아직 Ctrl+C를 보내지 않았습니다.');
  try{
   const r=await call('/api/lab/interrupt/preview',pending);if(seq!==s.seq||atEpoch!==epoch(s))return;
   if(r?.previewId!==pending.previewId||r.revision!==pending.expectedRevision||!Number.isFinite(r.expiresAt)||r.expiresAt<=now()||!Array.isArray(r.targets)||JSON.stringify(r.targets.map(t=>t.n))!==JSON.stringify(pending.seats)||r.targets.some(t=>typeof t.program!=='string'))throw Error('프로그램 확인 응답을 확인하지 못했습니다. 같은 요청으로 다시 확인하세요.');
   s.preview={...r,epoch:atEpoch};s.programs.textContent='';
   for(const t of r.targets)s.programs.append(el('li',t.n+'번 · '+t.program));
   s.expires.textContent='확인 유효 시각: '+(D.fmt?D.fmt(r.expiresAt):new Date(r.expiresAt).toLocaleTimeString('ko-KR'));
   s.confirm.hidden=false;message(s,'대상과 프로그램을 확인한 뒤 아래에서 중단 요청을 보내세요.');s.execute.focus();
  }catch(e){if(seq===s.seq){if(definite(e))clearPreview(s);message(s,D.cleanErr(e.message))}}finally{s.preparing=false;paint(s)}
 }
 function result(s,r){
  if(!r||r.requestId!==s.pendingAction.requestId||!Array.isArray(r.results))throw Error('중단 요청 결과를 확인하지 못했습니다. 같은 요청으로 다시 확인하세요.');
  const names={pending:'처리 중',sent:'Ctrl+C 전달됨 · 프로그램 종료 여부는 자리에서 확인',changed:'프로그램이 바뀌어 전달하지 않음',unknown:'전달 여부 확인 필요 · 자동 재전송하지 않음',skipped:'조건이 바뀌어 전달하지 않음'};
  if(r.results.length!==s.pendingAction.seats.length||JSON.stringify(r.results.map(x=>x.n).sort((a,b)=>a-b))!==JSON.stringify(s.pendingAction.seats)||r.results.some(x=>!Object.hasOwn(names,x.status)))throw Error('중단 요청 결과 형식을 확인하지 못했습니다.');
  s.results.textContent='';for(const row of r.results)s.results.append(el('li',row.n+'번 · '+names[row.status]));
  if(!r.results.some(x=>x.status==='pending'||x.status==='unknown')){s.pendingAction=null;s.forgetAsk.hidden=true}
  message(s,'요청 결과를 받았습니다. 실행이 멈췄는지는 각 자리의 수업 터미널에서 확인하세요. 이 기능은 명령 전달 상태를 바꾸지 않습니다.');
 }
 async function send(s){
  if(s.sending||s.preparing||s.reading)return;
  if(!s.pendingAction){
   if(!s.preview||s.preview.expiresAt<=now()||s.preview.epoch!==epoch(s)){clearPreview(s);message(s,'프로그램 확인이 만료되었거나 전달 상태가 바뀌었습니다. 대상을 다시 확인하세요.');paint(s);return}
   s.pendingAction={id:s.id,previewId:s.preview.previewId,requestId:crypto.randomUUID(),seats:s.preview.targets.map(t=>t.n).sort((a,b)=>a-b)};
  }
  const pending=s.pendingAction;s.sending=true;s.confirm.hidden=true;paint(s);message(s,'중단 요청 결과 확인 중… 새 요청을 추가로 보내지 않습니다.');
  try{const r=await call('/api/lab/interrupt/request',{id:pending.id,previewId:pending.previewId,requestId:pending.requestId});result(s,r)}
  catch(e){message(s,'중단 요청 결과 확인 필요 · '+D.cleanErr(e.message)+' 같은 요청으로 다시 확인하세요.')}
  finally{s.sending=false;clearPreview(s);s.loaded=false;paint(s)}
 }
 function box(lab){let s=states.get(lab.id);
  if(!s){
   s={id:lab.id,lab,selected:new Set(),seq:0,loaded:false,preview:null,pendingPreview:null,pendingAction:null};states.set(lab.id,s);
   s.el=el('details');s.el.dataset.labInterrupt=lab.id;s.el.style.cssText='border-top:1px solid var(--line);margin-top:16px;padding-top:12px';
   s.el.append(el('summary','수업 터미널 프로그램 중단 요청'));
   const body=el('div');body.append(el('p','명령 전달을 먼저 일시정지한 뒤 사용하세요. 선택한 수업 터미널의 확인된 프로그램에 Ctrl+C를 한 번 전달합니다. 파일 저장·종료 여부는 각 자리에서 확인해야 합니다.','mut'));
   s.refresh=D.btn('대상 다시 확인','sec',()=>refresh(s));s.choices=el('div');s.choices.setAttribute('role','group');s.choices.setAttribute('aria-label','중단 요청 대상 자리');
   s.prepare=D.btn('선택한 자리의 실행 프로그램 확인','sec',()=>prepare(s));
   s.confirm=el('section');s.confirm.hidden=true;s.confirm.setAttribute('aria-label','프로그램 중단 요청 확인');
   s.programs=el('ul');s.expires=el('p',undefined,'mut');s.execute=D.btn('선택한 프로그램에 중단 요청 보내기','sec',()=>send(s));
   s.cancel=D.btn('취소','sec',()=>{clearPreview(s);message(s,'중단 요청을 보내지 않았습니다.');paint(s);s.prepare.focus()});
   const confirmRow=el('div',undefined,'row');confirmRow.append(s.execute,s.cancel);
   s.confirm.append(el('strong','아래 자리와 실행 프로그램을 확인하세요'),s.programs,s.expires,el('p','확인 뒤 프로그램이 바뀌면 입력을 보내지 않습니다. 개인 터미널이나 실습실 전체를 종료하지 않습니다.','mut'),confirmRow);
   s.msg=el('p','대상 다시 확인을 누르면 현재 상태를 읽습니다.','mut');s.msg.setAttribute('role','status');s.msg.setAttribute('aria-live','polite');
   s.results=el('ul');s.results.setAttribute('aria-label','중단 요청 결과');
   s.retry=D.btn('같은 중단 요청 결과 다시 확인','sec',()=>send(s));s.forget=D.btn('확인 중인 요청 기록 정리','sec',()=>{s.forgetAsk.hidden=false});
   s.forgetAsk=el('section');s.forgetAsk.hidden=true;s.forgetAsk.append(el('p','각 자리에서 실행 상태를 직접 확인하셨나요? 이 화면의 기록만 정리하며, 이미 전달된 Ctrl+C를 취소하지 않습니다.'));
   s.forgetAsk.append(D.btn('직접 확인했음 · 기록 정리','sec',()=>{s.pendingAction=null;s.forgetAsk.hidden=true;s.results.textContent='';s.loaded=false;paint(s)}),D.btn('기록 유지','sec',()=>{s.forgetAsk.hidden=true}));
   const retryRow=el('div',undefined,'row');retryRow.append(s.retry,s.forget);
   body.append(s.refresh,s.choices,s.prepare,s.confirm,s.msg,s.results,retryRow,s.forgetAsk);s.el.append(body);
   for(const b of s.el.querySelectorAll('button'))b.style.cssText='width:auto;max-width:100%;white-space:normal;overflow-wrap:anywhere;min-height:44px';
   D.control?.subscribe(lab.id,()=>{if(s.preview&&s.preview.epoch!==epoch(s)||s.loaded&&s.loadedEpoch!==epoch(s)){s.seq++;clearPreview(s);s.loaded=false;if(!s.pendingAction)message(s,'전달 상태가 바뀌었습니다. 대상을 다시 확인하세요.');paint(s)}});
  }
  s.lab=lab;paint(s);if(focused&&s.el.contains(focused)){const f=focused;queueMicrotask(()=>{if(f.isConnected)f.focus({preventScroll:true})})}return s.el;
 }
 return{box};
}
`;
