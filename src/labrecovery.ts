export const LAB_RECOVERY_JS = String.raw`
function createLabRecovery(D){
 const states=new Map(),epoch=s=>D.control?.epoch(s.id)||0;let focused=null;
 document.addEventListener('focusin',e=>{focused=e.target?.closest?.('[data-lab-recovery]')?e.target:null});
 document.addEventListener('pointerdown',e=>{if(!e.target?.closest?.('[data-lab-recovery]'))focused=null},true);
 const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n};
 async function call(path,body){let timer;try{return await Promise.race([Promise.resolve().then(()=>D.call(path,body)),new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('응답 확인 시간이 지났습니다.')),D.timeoutMs||10000))])}finally{clearTimeout(timer)}}
 function invalidate(s){s.ctx=null;s.confirm.hidden=true;s.mode=null;s.seq++;paint(s)}
 function paint(s){
  const busy=!!s.busy,locked=!!s.operation&&['pending','unknown'].includes(s.operation.status),pending=!!s.pending;
  s.select.disabled=busy||pending;s.refresh.disabled=busy||pending&&s.operation?.status!=='unknown';
  s.repair.disabled=busy||pending||locked||!s.ctx?.canRepair;s.replace.disabled=busy||pending||locked||!s.ctx?.canReplace||!s.ctx.verifiedFile&&!s.waiver.checked;
  s.waiver.disabled=busy||pending;s.execute.disabled=busy||pending||!s.ctx||s.loadedEpoch!==epoch(s)||!s.confirmed.checked;s.cancel.disabled=busy;
  s.retry.hidden=!pending;s.retry.disabled=busy;s.inspect.hidden=!locked||s.operation.status!=='unknown';s.unlock.disabled=busy||!s.inspected.checked||!s.ctx;
  s.identity.textContent=s.operation?'복구 요청 '+s.operation.requestId:'';
  s.inspectNote.textContent='불확실한 요청은 자동 재실행하지 않습니다. '+(s.operation?.kind==='repair'?'공급자 화면에서 원래 실습실의 편집기와 기동 요청 상태를 직접 점검하세요.':'공급자 화면에서 원래 실습실과 이 요청 ID(gw-recovery 라벨)의 자원을 직접 점검하세요.')+' 복구 대상·파일 상태 확인을 눌러 현재 자리를 다시 읽고 아래 점검 확인란을 선택하세요. 잠금 해제는 이후 새 복구 요청을 허용하며, 앞 요청의 취소나 자원 삭제는 하지 않습니다.';
 }
 function result(s,r){
  if(!r||!['pending','ready','replaced','unknown','skipped'].includes(r.status)||!Number.isInteger(r.n)||!['repair','replace'].includes(r.kind)||typeof r.requestId!=='string')throw Error('복구 결과 응답을 확인하지 못했습니다.');
  s.operation=r;
  const texts={pending:'복구 진행 중입니다. 같은 요청 결과를 다시 확인하세요.',unknown:'결과 확인 필요 · 해당 자리에 새 요청을 보내지 않습니다. Daytona에서 이 요청 ID의 자원과 원래 자리를 확인하세요.',ready:'편집기 연결을 확인했습니다. 자료와 실행 프로그램 상태는 참여자와 확인하세요. 새로고침 후에도 이전 연결이 남으면 약 30초 뒤 다시 여세요.',replaced:'새 실습실로 교체했습니다. 사용량·예산·종료 시각은 이어집니다. 참여자에게 새 초대 링크를 전달하고, 새 수업 터미널에서 대상을 다시 선택하세요. 파일은 자동으로 옮기지 않습니다.',skipped:'조건이 바뀌어 실행하지 않았습니다. 현재 대상을 다시 확인하세요.'};
  s.msg.textContent=r.n+'번 · '+(r.status==='unknown'&&r.kind==='repair'?'결과 확인 필요 · 해당 자리에 새 요청을 보내지 않습니다. 원래 실습실의 편집기와 기동 요청 상태를 확인하세요.':texts[r.status]);
  if(['ready','replaced','skipped'].includes(r.status))s.pending=null;
  if(r.status==='replaced')D.reload?.();
 }
 async function refresh(s){
  if(s.busy||s.pending&&s.operation?.status!=='unknown')return;if(!s.select.value){s.msg.textContent='복구할 자리 하나를 선택하세요.';return}
  s.busy=true;invalidate(s);s.operation=null;s.waiver.checked=false;s.inspected.checked=false;const seq=s.seq,atEpoch=epoch(s);s.msg.textContent='현재 자리와 파일 확인 상태를 확인하는 중…';paint(s);
  try{const c=await call('/api/lab/recovery/context',{id:s.id,n:Number(s.select.value)});
   if(seq!==s.seq||atEpoch!==epoch(s))throw Error('전달 상태가 바뀌었습니다. 다시 확인하세요.');
   if(c?.n!==Number(s.select.value)||typeof c.generation!=='string'||!Number.isSafeInteger(c.revision)||typeof c.canRepair!=='boolean'||typeof c.canReplace!=='boolean'||typeof c.verifiedFile!=='boolean')throw Error('자리 응답을 확인하지 못했습니다.');
   s.ctx=c;s.loadedEpoch=epoch(s);s.file.textContent=c.verifiedFile?'참여자가 내려받은 ZIP을 직접 열어 확인했습니다. 이후 수정한 내용은 포함되지 않을 수 있습니다.':'현재 자리의 ZIP을 내려받아 직접 확인한 기록이 없습니다. 먼저 참여자에게 파일 보존 확인을 안내하세요.';
   s.msg.textContent=c.canReplace?'대상 확인 완료 · 연결 복구를 먼저 시도하고, 필요할 때 교체하세요.':'기존 예산 세션을 확인할 수 없어 교체를 차단했습니다. 연결 복구 가능 여부를 확인하세요.';
   if(c.operation)result(s,c.operation);
  }catch(e){s.ctx=null;s.msg.textContent=D.cleanErr(e.message)}finally{s.busy=false;paint(s)}
 }
 function prepare(s,kind){if(!s.ctx||s.pending||s.loadedEpoch!==epoch(s))return;
  s.mode=kind;s.confirmed.checked=false;s.confirm.hidden=false;s.targets.textContent=s.ctx.n+'번 · '+(kind==='repair'?'기존 실습실 연결 복구':'새 실습실로 교체');
  s.scope.textContent=kind==='repair'?'기존 파일을 덮어쓰지 않고 편집기 상태를 확인합니다. 필요하면 기존 실습실과 편집기를 켜는 요청을 한 번 보냅니다. 개인 터미널은 종료하지 않습니다.':'기존 예산 세션을 그대로 사용하고 접속 정보만 바꿉니다. 기존 파일은 새 실습실로 자동 복사하지 않습니다. 원래 실습실과 파일은 모임 종료까지 남고, 교체 후에는 새 초대 링크로 들어와야 합니다. 새 실습실 비용이 추가됩니다.';
  s.execute.textContent=kind==='repair'?'이 자리 연결 복구 실행':'이 자리를 새 실습실로 교체';paint(s);s.confirmed.focus();
 }
 async function send(s){
  if(s.busy)return;if(!s.pending){if(!s.ctx||!s.mode||!s.confirmed.checked||s.loadedEpoch!==epoch(s)){invalidate(s);return}s.pending={id:s.id,requestId:crypto.randomUUID(),n:s.ctx.n,kind:s.mode,expectedGeneration:s.ctx.generation,expectedRevision:s.ctx.revision,ackDataLoss:s.mode==='replace'&&!s.ctx.verifiedFile&&s.waiver.checked}}
  const p=s.pending;s.busy=true;s.confirm.hidden=true;paint(s);s.msg.textContent='복구 요청 결과 확인 중… 응답이 끊겨도 새 요청을 만들지 않습니다.';
  try{const r=await call('/api/lab/recovery/create',p);if(r?.requestId!==p.requestId||r.n!==p.n||r.kind!==p.kind)throw Error('요청과 결과가 일치하지 않습니다.');result(s,r)}
  catch(e){s.msg.textContent='결과 확인 필요 · 같은 요청 결과를 다시 확인하세요. '+D.cleanErr(e.message)}
  finally{s.busy=false;D.control?.invalidate(s.id);invalidate(s);paint(s)}
 }
 async function unlock(s){
  if(s.busy||!s.inspected.checked||!s.ctx||s.operation?.status!=='unknown')return;
  s.busy=true;paint(s);const p={id:s.id,requestId:s.operation.requestId,expectedGeneration:s.ctx.generation,ackInspected:true};
  try{const r=await call('/api/lab/recovery/unlock',p);if(r?.requestId!==p.requestId||r.released!==true)throw Error('잠금 해제 응답을 확인하지 못했습니다.');s.pending=null;s.operation=null;s.msg.textContent='잠금을 해제했습니다. 기존 요청을 취소하거나 자원을 삭제하지 않습니다. 새 요청을 보내려면 대상을 다시 확인하세요.';invalidate(s)}
  catch(e){s.msg.textContent='잠금 해제 결과 확인 필요 · '+D.cleanErr(e.message)}finally{s.busy=false;paint(s)}
 }
 function checkbox(text){const label=el('label'),input=el('input');input.type='checkbox';input.style.cssText='width:auto;flex:0 0 auto;margin-top:5px';label.style.cssText='display:flex;align-items:flex-start;gap:8px;margin:12px 0';label.append(input,el('span',text));return{label,input}}
 function box(lab){let s=states.get(lab.id);if(!s){
  s={id:lab.id,lab,seq:0};states.set(lab.id,s);s.el=el('details');s.el.dataset.labRecovery=lab.id;s.el.style.cssText='border-top:1px solid var(--line);margin-top:16px;padding-top:12px';s.el.append(el('summary','자리 연결 복구 · 실습실 교체'));
  s.el.append(el('p','명령 전달을 일시정지한 뒤 자리 하나씩 복구합니다. 교체 중에는 전달 상태를 바꾸지 말고 결과를 확인하세요. 교체는 원래 사용량과 종료 시각을 유지하며, 전체 명령 전달은 직접 재개해야 합니다.','mut'));
  const label=el('label','복구할 자리');s.select=el('select');s.select.setAttribute('aria-label','복구할 자리');s.select.append(el('option','자리 선택'));s.select.firstChild.value='';for(const seat of lab.seats){const o=el('option',seat.n+'번'+(seat.who?' · '+seat.who:''));o.value=seat.n;s.select.append(o)}label.append(s.select);s.select.onchange=()=>{s.operation=null;invalidate(s)};
  s.refresh=D.btn('복구 대상·파일 상태 확인','sec',()=>refresh(s));s.file=el('p','먼저 파일 저장과 ZIP 보존 여부를 참여자와 확인하세요.','mut');
  const waiver=checkbox('파일을 확보하지 못했으며, 참여자와 파일 손실 가능성을 확인하고도 새 실습실로 교체합니다.');s.waiver=waiver.input;s.waiver.onchange=()=>{s.confirm.hidden=true;s.mode=null;paint(s)};
  const actions=el('div',undefined,'row');s.repair=D.btn('기존 연결 복구 범위 확인','sec',()=>prepare(s,'repair'));s.replace=D.btn('새 실습실 교체 범위 확인','sec',()=>prepare(s,'replace'));actions.append(s.repair,s.replace);
  s.confirm=el('section');s.confirm.hidden=true;s.confirm.setAttribute('aria-label','자리 복구 실행 확인');s.targets=el('strong');s.scope=el('p');const confirmed=checkbox('대상 자리와 위 실행 범위를 확인했습니다.');s.confirmed=confirmed.input;s.confirmed.onchange=()=>paint(s);s.execute=D.btn('복구 실행','sec',()=>send(s));s.cancel=D.btn('취소','sec',()=>{s.confirm.hidden=true;s.mode=null;paint(s)});const row=el('div',undefined,'row');row.append(s.execute,s.cancel);s.confirm.append(s.targets,s.scope,confirmed.label,row);
  s.msg=el('p','명령 전달을 일시정지한 뒤 대상을 확인하세요.','mut');s.msg.setAttribute('role','status');s.msg.setAttribute('aria-live','polite');s.identity=el('p');s.identity.style.cssText='overflow-wrap:anywhere';s.retry=D.btn('같은 복구 요청 결과 다시 확인','sec',()=>send(s));
  s.inspect=el('section');s.inspect.hidden=true;s.inspectNote=el('p',undefined,'mut');s.inspect.append(s.inspectNote);
  const inspected=checkbox('Daytona에서 기존 실습실과 이 요청의 자원을 직접 점검했습니다.');s.inspected=inspected.input;s.inspected.onchange=()=>paint(s);s.unlock=D.btn('점검한 요청의 잠금 해제','sec',()=>unlock(s));s.inspect.append(inspected.label,s.unlock);
  s.el.append(label,s.refresh,s.file,waiver.label,actions,s.confirm,s.msg,s.identity,s.retry,s.inspect);
  for(const b of s.el.querySelectorAll('button'))b.style.cssText='width:auto;max-width:100%;min-height:44px;white-space:normal;overflow-wrap:anywhere';
  D.control?.subscribe(lab.id,()=>{if(s.ctx&&s.loadedEpoch!==epoch(s))invalidate(s)});
 }s.lab=lab;paint(s);if(focused&&s.el.contains(focused)){const f=focused;queueMicrotask(()=>{if(f.isConnected)f.focus({preventScroll:true})})}return s.el}
 return{box};
}
`;
