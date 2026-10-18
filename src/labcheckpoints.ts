export const LAB_CHECKPOINT_JS = String.raw`
function createLabCheckpoints(D){
 const states=new Map(),epoch=s=>D.control?.epoch(s.id)||0;let focused=null;
 document.addEventListener('focusin',e=>{focused=e.target?.closest?.('[data-lab-checkpoints]')?e.target:null});
 document.addEventListener('pointerdown',e=>{if(!e.target?.closest?.('[data-lab-checkpoints]'))focused=null},true);
 const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n};
 async function call(path,body){let timer;try{return await Promise.race([Promise.resolve().then(()=>D.call(path,body)),new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('결과 확인 시간이 지났습니다. 같은 요청으로 다시 확인하세요.')),D.timeoutMs||8000))])}finally{clearTimeout(timer)}}
 function paint(s){
  const busy=s.loading||s.sending,pending=!!s.pending;
  s.refresh.disabled=busy||pending;s.prepare.disabled=busy||pending||!!s.confirmEpoch||!s.loaded||!s.selected.size||!s.saved.checked;
  s.retry.hidden=!pending;s.retry.disabled=busy;s.forget.hidden=!pending;s.forget.disabled=busy;s.saved.disabled=busy||pending||!!s.confirmEpoch;if(!pending)s.forgetAsk.hidden=true;
  s.execute.disabled=busy||pending||!s.confirmEpoch||s.confirmEpoch.value!==epoch(s);s.cancel.disabled=busy;
  for(const c of s.choices.querySelectorAll('input'))c.disabled=busy||pending||!!s.confirmEpoch;
 }
 function invalidate(s){s.confirm.hidden=true;s.confirmEpoch=null;s.loaded=false;s.seq++;paint(s)}
 function rows(s,list){
  s.results.textContent='';
  const names={pending:'생성 중',ready:'실습실 안에 보관 · 모임 종료 시 삭제됨',unknown:'결과 확인 필요 · 자동으로 다시 만들지 않음',skipped:'조건이 바뀌어 만들지 않음'};
  for(const op of list){
   if(!Array.isArray(op.results))continue;
   for(const r of op.results){
    const line=el('li',r.n+'번 · '+(names[r.status]||'결과 확인 필요')+(r.status==='ready'?' · '+(Number.isFinite(r.at)?(D.fmt?D.fmt(r.at):new Date(r.at).toLocaleTimeString('ko-KR')):'시각 확인 필요')+' · '+Math.ceil((r.size||0)/1024)+' KB'+(r.omitted?' · '+r.omitted+'개 제외':''):''));s.results.append(line);
   }
  }
 }
 async function refresh(s){
  if(s.loading||s.sending||s.pending)return;s.loading=true;invalidate(s);const seq=s.seq,atEpoch=epoch(s);s.choices.textContent='';s.selected.clear();s.saved.checked=false;s.msg.textContent='전달 상태와 체크포인트 기록을 확인하는 중…';paint(s);
  try{
   const control=await call('/api/lab/control/status',{id:s.id}),history=await call('/api/lab/checkpoint/status',{id:s.id});
   if(seq!==s.seq||atEpoch!==epoch(s))throw Error('전달 상태가 바뀌었습니다. 대상을 다시 확인하세요.');
   if(!Array.isArray(history?.checkpoints))throw Error('체크포인트 기록을 확인하지 못했습니다.');rows(s,history.checkpoints);
   if(control?.mode!=='paused'||!Number.isSafeInteger(control.revision))throw Error('위에서 명령 전달을 일시정지한 뒤 대상을 다시 확인하세요.');
   s.revision=control.revision;s.loadedEpoch=epoch(s);s.loaded=true;
   for(const seat of s.lab.seats){const label=el('label'),check=el('input');check.type='checkbox';check.style.cssText='width:auto;flex:0 0 auto';check.setAttribute('aria-label',seat.n+'번 체크포인트 대상');label.style.cssText='display:flex;align-items:center;gap:8px;min-height:44px;overflow-wrap:anywhere';label.append(check,el('span',seat.n+'번'+(seat.who?' · '+seat.who:'')));s.choices.append(label);check.onchange=()=>{if(check.checked)s.selected.add(seat.n);else s.selected.delete(seat.n);paint(s)}}
   s.msg.textContent='파일 저장 안내 후 대상을 직접 고르세요. 편집기에서 아직 저장하지 않은 내용은 포함하지 않습니다.';
  }catch(e){s.loaded=false;s.msg.textContent=D.cleanErr(e.message)}finally{s.loading=false;paint(s)}
 }
 function prepare(s){
  if(s.pending||!s.loaded||!s.selected.size||!s.saved.checked||s.loadedEpoch!==epoch(s)){invalidate(s);return}
  s.confirmEpoch={value:epoch(s)};s.targets.textContent=[...s.selected].sort((a,b)=>a-b).map(n=>n+'번').join(', ');s.confirm.hidden=false;paint(s);s.execute.focus();
 }
 async function send(s){
  if(s.sending||s.loading)return;
  if(!s.pending){if(!s.confirmEpoch||s.confirmEpoch.value!==epoch(s)){invalidate(s);s.msg.textContent='전달 상태가 바뀌었습니다. 대상을 다시 확인하세요.';return}s.pending={id:s.id,requestId:crypto.randomUUID(),seats:[...s.selected].sort((a,b)=>a-b),expectedRevision:s.revision}}
  const pending=s.pending;s.sending=true;s.confirm.hidden=true;paint(s);s.msg.textContent='체크포인트 결과 확인 중… 아직 외부에 저장된 파일은 아닙니다.';
  try{
   const r=await call('/api/lab/checkpoint/create',pending);
   if(r?.requestId!==pending.requestId||!Array.isArray(r.results)||JSON.stringify(r.results.map(x=>x.n))!==JSON.stringify(pending.seats)||r.results.some(x=>!['pending','ready','unknown','skipped'].includes(x.status)))throw Error('결과 응답을 확인하지 못했습니다. 같은 요청으로 다시 확인하세요.');
   rows(s,[r]);if(!r.results.some(x=>x.status==='pending'||x.status==='unknown'))s.pending=null;
   s.msg.textContent='자리별 결과를 확인하세요. 참여자는 파일 보존 확인에서 ZIP을 내려받아 직접 열어 확인해야 외부에 남길 수 있습니다.';
  }catch(e){s.msg.textContent='체크포인트 결과 확인 필요 · '+D.cleanErr(e.message)+' 같은 요청으로 다시 확인하세요.'}
  finally{s.sending=false;invalidate(s);paint(s)}
 }
 function box(lab){let s=states.get(lab.id);if(!s){
  s={id:lab.id,lab,loaded:false,selected:new Set(),pending:null,seq:0};states.set(lab.id,s);
  s.el=el('details');s.el.dataset.labCheckpoints=lab.id;s.el.style.cssText='border-top:1px solid var(--line);margin-top:16px;padding-top:12px';s.el.append(el('summary','파일 체크포인트'));
  s.el.append(el('p','선택한 자리의 저장된 work 파일을 별도 ZIP으로 보관합니다. 원본을 덮어쓰지 않으며, 모임이 끝나면 내부 ZIP도 함께 삭제됩니다. 파일을 수정 중이면 시점이 섞일 수 있으니 먼저 저장과 작업을 마치도록 안내하세요.','mut'));
  s.refresh=D.btn('체크포인트 대상·기록 확인','sec',()=>refresh(s));s.choices=el('div');s.choices.setAttribute('role','group');s.choices.setAttribute('aria-label','체크포인트 대상 자리');
  const saveLabel=el('label');saveLabel.style.cssText='display:flex;align-items:flex-start;gap:8px;margin:12px 0';s.saved=el('input');s.saved.type='checkbox';s.saved.style.cssText='width:auto;flex:0 0 auto';s.saved.onchange=()=>paint(s);saveLabel.append(s.saved,el('span','참여자에게 파일 저장을 안내했고, 내부 보관본도 모임 종료 시 삭제됨을 확인했습니다.'));
  s.prepare=D.btn('선택한 자리와 보관 범위 확인','sec',()=>prepare(s));s.confirm=el('section');s.confirm.hidden=true;s.confirm.setAttribute('aria-label','파일 체크포인트 만들기 확인');s.targets=el('strong');
  s.execute=D.btn('선택한 자리에 체크포인트 만들기','sec',()=>send(s));s.cancel=D.btn('취소','sec',()=>{s.confirm.hidden=true;s.confirmEpoch=null;paint(s);s.prepare.focus()});const confirmRow=el('div',undefined,'row');confirmRow.append(s.execute,s.cancel);
  s.confirm.append(s.targets,el('p','저장된 파일 최대 64 MiB·4,000개를 대상으로 하며 링크·제외 폴더는 건너뜁니다. 자리마다 최대 5회, 모임당 최대 64회 요청을 보관합니다. 이 버튼은 내 PC로 내려받기를 시작하지 않습니다.','mut'),confirmRow);
  s.retry=D.btn('같은 체크포인트 요청 결과 다시 확인','sec',()=>send(s));s.forget=D.btn('확인 중인 요청 표시 정리','sec',()=>{s.forgetAsk.hidden=false});s.forgetAsk=el('section');s.forgetAsk.hidden=true;
  s.forgetAsk.append(el('p','서버에서 아직 ZIP을 만드는 중일 수 있습니다. 이 화면의 표시만 정리하며 작업 취소나 보관본 삭제는 하지 않습니다.'),D.btn('표시만 정리','sec',()=>{s.pending=null;s.forgetAsk.hidden=true;invalidate(s);s.msg.textContent='표시를 정리했습니다. 대상·기록 확인에서 서버 기록을 다시 확인하세요.'}),D.btn('요청 기록 유지','sec',()=>{s.forgetAsk.hidden=true}));
  s.msg=el('p','명령 전달을 일시정지한 뒤 대상·기록을 확인하세요.','mut');s.msg.setAttribute('role','status');s.msg.setAttribute('aria-live','polite');s.results=el('ul');s.results.setAttribute('aria-label','체크포인트 결과');
  s.el.append(s.refresh,s.choices,saveLabel,s.prepare,s.confirm,s.msg,s.results,s.retry,s.forget,s.forgetAsk);
  for(const b of s.el.querySelectorAll('button'))b.style.cssText='width:auto;max-width:100%;white-space:normal;overflow-wrap:anywhere;min-height:44px';
  D.control?.subscribe(lab.id,()=>{if(s.loaded&&s.loadedEpoch!==epoch(s)){invalidate(s);if(!s.pending)s.msg.textContent='전달 상태가 바뀌었습니다. 대상을 다시 확인하세요.'}});
 }
 s.lab=lab;paint(s);if(focused&&s.el.contains(focused)){const f=focused;queueMicrotask(()=>{if(f.isConnected)f.focus({preventScroll:true})})}return s.el;
 }
 return{box};
}
`;
