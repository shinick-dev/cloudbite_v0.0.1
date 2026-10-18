// 모임지기 /lab: 선택한 자리의 전용 수업 터미널에 한 줄씩 보낸다.
// 인증·통신은 주입한 call 콜백만 사용한다. 초안과 재시도 ID는 이 탭 메모리에만 둔다.
export const LAB_TERMINAL_JS = String.raw`
function createLabTerminal(D){
 const states=new Map();let focused=null;
 const el=(tag,text,cls)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e};
 const call=(path,body)=>{let timer;const pending=D.call(path,body);return Promise.race([pending,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('응답을 확인하는 데 시간이 걸리고 있습니다.')),8000)})]).finally(()=>clearTimeout(timer))};
 const message=(s,text,bad)=>{s.msg.textContent=text;s.msg.className=bad?'bad':'mut'};
 const labels={ready:'준비됨',sent:'보냄',error:'실패',unknown:'확인 필요',skipped:'건너뜀'};
 document.addEventListener('focusin',e=>{focused=e.target&&e.target.closest&&e.target.closest('[data-lab-terminal]')?e.target:null});
 document.addEventListener('pointerdown',e=>{if(!e.target.closest||!e.target.closest('[data-lab-terminal]'))focused=null},true);
 function paint(s){
  const busy=s.busy||s.stopping,locked=busy||s.active||!!s.startPending;
  for(const [n,input] of s.inputs)input.disabled=locked||s.unavailable.has(n);
  const controlBlocked=D.control&&!D.control.allowsNew(s.id);
  s.start.disabled=busy||s.active||!!s.pending||(controlBlocked&&!s.startPending)||(!s.startPending&&![...s.inputs.values()].some(i=>i.checked&&!i.disabled));
  s.start.textContent=s.startPending?'같은 시작 요청 다시 확인':'선택한 자리에서 시작';
  s.stop.disabled=s.stopping||(s.busy&&!s.sending)||s.needsTakeover||(!s.active&&!s.startPending);
  s.takeover.hidden=!s.sessionId||!s.needsTakeover;s.takeover.disabled=busy;
  s.forget.hidden=s.active||(!s.pending&&!s.startPending);s.forget.disabled=busy;
  s.refresh.disabled=busy;
  s.command.disabled=busy||!!s.pending;
  s.send.disabled=busy||(!s.active&&!s.pending)||s.needsTakeover||(controlBlocked&&!s.pending)||(!s.pending&&!s.command.value.trim());
  s.send.textContent=s.pending?(s.active?'같은 명령 다시 확인':'명령 결과 확인'):'명령 보내기';
  s.state.textContent=s.needsTakeover?'다시 인증한 관리 세션에서 이어받기 필요':s.active?'전송 중 · 대상 '+s.targets.map(n=>n+'번').join(', '):'새 명령 전송 꺼짐';
  s.target.textContent='선택: '+[...s.inputs].filter(([,i])=>i.checked).map(([n])=>n+'번').join(', ')+(s.active?' · 전송 대상은 중지 후 바꿀 수 있습니다.':'');
 }
 function results(s,rows){
  s.results.replaceChildren();if(!Array.isArray(rows))return;
  for(const x of rows){const li=el('li',x.n+'번 · '+(labels[x.status]||'확인 필요')+(x.note?' · '+D.cleanErr(x.note):''));if(x.status==='error'||x.status==='unknown')li.className='bad';s.results.append(li)}
 }
 function take(s,r){
  s.active=r.active===true;s.needsTakeover=r.needsTakeover===true;s.sessionId=typeof r.sessionId==='string'?r.sessionId:s.sessionId;
  if(Array.isArray(r.seats)){s.targets=r.seats.map(x=>typeof x==='number'?x:x.n);for(const [n,i] of s.inputs)i.checked=s.targets.includes(n);results(s,r.seats.filter(x=>typeof x==='object'))}
  if(r.last&&Array.isArray(r.last.results))results(s,r.last.results);
  // 상태 조회만으로 미확인 명령을 폐기하지 않는다. 동일 ID로 응답을 다시 받는다.
  if(s.active&&s.sessionId&&!s.needsTakeover)s.startPending=null;
  // 비활성 상태여도 응답이 유실된 요청 ID는 보존한다. 기록을 지우는 별도 선택이 필요하다.
 }
 async function status(s){if(s.busy||s.stopping)return;s.busy=true;paint(s);message(s,'수업 터미널 상태 확인 중…');
  try{take(s,await call('/api/lab/terminal/status',{id:s.id}));s.known=true;message(s,'상태를 확인했습니다. 명령이 실행됐는지는 각 자리의 수업 터미널에서 확인하세요.')}
  catch(e){message(s,'상태를 확인하지 못했습니다. '+D.cleanErr(e.message),true)}finally{s.busy=false;paint(s)}
 }
 async function start(s){if(s.busy||s.stopping||s.active||s.pending)return;
  if(!s.startPending&&D.control&&!D.control.allowsNew(s.id))return;
  const seats=[...s.inputs].filter(([,i])=>i.checked&&!i.disabled).map(([n])=>n);
  if(!s.startPending){if(!seats.length)return; s.startPending={id:s.id,requestId:crypto.randomUUID(),seats,expectedControlRevision:D.control?.revision?.(s.id)}}
  s.busy=true;paint(s);message(s,'선택한 자리의 수업 터미널 준비 중…');
  try{const r=await call('/api/lab/terminal/start',s.startPending);take(s,r);s.known=true;message(s,'자리별 준비 결과를 확인하고 한 줄 명령을 보내세요.')}
  catch(e){if(e.code==='control_revision_changed'){s.startPending=null;D.control?.invalidate?.(s.id)}message(s,'시작 결과를 확인하지 못했습니다. 같은 시작 요청을 다시 확인하거나 상태를 확인하세요. '+D.cleanErr(e.message),true)}finally{s.busy=false;paint(s)}
 }
 async function send(s){if(s.busy||s.stopping||(!s.active&&!s.pending)||s.needsTakeover||(!s.sessionId&&!s.pending))return;
  if(!s.pending&&D.control&&!D.control.allowsNew(s.id))return;
  if(!s.pending){const command=s.command.value;if(!command.trim())return;
   if(command.length>4096||/[\x00-\x1f\x7f]/.test(command)){message(s,'줄바꿈·탭 없이 한 줄로, 4,096자 이내로 입력하세요.',true);return}
   const sessionId=s.sessionId,epoch=D.control?.epoch(s.id),stopRevision=s.stopRevision||0;
   s.busy=true;paint(s);message(s,'명령과 대상 자리를 확인하세요. 아직 참여자에게 보내지 않았습니다.');
   try{
    const previewId=D.trial?await D.trial.preparePreview(s.id,sessionId,command,s.el):undefined;
    if(D.trial&&!previewId){message(s,'전달 확인을 취소했습니다. 참여자에게 보내지 않았습니다.');return}
    if(!s.active||s.sessionId!==sessionId||(s.stopRevision||0)!==stopRevision||D.control?.epoch(s.id)!==epoch||(D.control&&!D.control.allowsNew(s.id))||s.command.value!==command){message(s,'확인 중 전달 상태가 바뀌었습니다. 상태와 내용을 다시 확인한 뒤 직접 보내세요.',true);return}
    s.pending={id:s.id,sessionId,requestId:crypto.randomUUID(),command,previewId,expectedControlRevision:D.control?.revision?.(s.id)};
   }catch(e){message(s,'전달 확인을 마치지 못했습니다. '+D.cleanErr(e.message),true);return}
   finally{s.busy=false;paint(s)}
  }
  const pending=s.pending,stopRevision=s.stopRevision||0,controlEpoch=D.control?.epoch(s.id);s.sending=true;s.busy=true;paint(s);message(s,'명령을 보내는 중…');
  try{const r=await call('/api/lab/terminal/send',pending);results(s,r.results);
   if((s.stopRevision||0)!==stopRevision||D.control?.epoch(s.id)!==controlEpoch)return; // 중지·제어 변경 뒤 늦은 응답은 미확인 요청 ID를 버리지 않는다.
   if(s.pending===pending)s.pending=null;
   const uncertain=(r.results||[]).some(x=>x.status==='error'||x.status==='unknown'||x.status==='skipped');
   message(s,uncertain?'일부 자리는 전송 확인이 필요합니다. 아래 결과와 해당 터미널을 확인하세요.':'명령을 보냈습니다. 완료 여부와 결과는 각 자리 터미널에서 확인하세요.',uncertain)}
  catch(e){if((e.code==='control_revision_changed'||e.code==='preview_rejected')&&s.pending===pending){s.pending=null;if(e.code==='control_revision_changed')D.control?.invalidate?.(s.id);message(s,'새 명령이 거부됐습니다. 상태·명령·대상을 다시 확인하고 직접 보내세요. '+D.cleanErr(e.message),true)}else if((s.stopRevision||0)===stopRevision)message(s,'전송 결과를 확인하지 못했습니다. 같은 명령 다시 확인을 누르면 같은 요청 ID를 사용합니다. '+D.cleanErr(e.message),true)}finally{s.sending=false;s.busy=false;paint(s)}
 }
 async function stop(s){if(s.stopping||(s.busy&&!s.sending)||s.needsTakeover)return;s.stopping=true;s.stopRevision=(s.stopRevision||0)+1;paint(s);message(s,'새 명령 전송 중지 요청 중…');
  try{if(!s.sessionId){take(s,await call('/api/lab/terminal/status',{id:s.id}));if(!s.active)return}
   await call('/api/lab/terminal/stop',{id:s.id,sessionId:s.sessionId});s.active=false;if(!s.sending)s.pending=null;s.startPending=null;
   message(s,'새 명령 전송을 중지했습니다. 이미 실행 중인 명령과 수업 터미널은 그대로 유지됩니다.')}
  catch(e){message(s,'중지 여부를 확인하지 못했습니다. 상태 확인 후 다시 중지하세요. '+D.cleanErr(e.message),true)}finally{s.stopping=false;paint(s)}
 }
 async function takeover(s){if(s.busy||s.stopping||!s.sessionId||!s.needsTakeover)return;s.busy=true;paint(s);
  try{take(s,await call('/api/lab/terminal/takeover',{id:s.id,sessionId:s.sessionId}));message(s,'이 관리 세션으로 이어받았습니다. 입력과 미확인 요청 ID를 유지했습니다.')}
  catch(e){message(s,'이어받지 못했습니다. 상태를 확인한 뒤 다시 시도하세요. '+D.cleanErr(e.message),true)}finally{s.busy=false;paint(s)}
 }
 function box(lab){let s=states.get(lab.id);
  if(!s){s={id:lab.id,inputs:new Map(),unavailable:new Set(),targets:[],active:false,busy:false,known:false};states.set(lab.id,s);
   D.control?.subscribe(lab.id,()=>paint(s));
   const d=s.el=el('details');d.dataset.labTerminal=lab.id;d.style.cssText='border-top:1px solid var(--line);margin-top:16px;padding-top:12px';
   const summary=el('summary','수업 터미널 함께 실행');summary.style.cursor='pointer';
   const help=el('p','선택한 자리마다 같은 한 줄 입력을 보내고 Enter를 누릅니다. 각자 수업 터미널에서 결과를 봅니다. 전용 수업 터미널을 사용하며, 기존 개인 터미널은 조작하지 않습니다.','mut');
   const guide=el('p','참가자는 VS Code 터미널 새 프로필에서 “수업 따라보기 (모임지기와 함께 보기)”를 선택하세요. 프로필이 없는 실습실은 아래 명령을 터미널에 붙여넣으세요. 시작한 뒤 연결할 수 있습니다.','mut');
   const code=el('code','tmux -u attach -r -t gw-lesson');code.style.cssText='display:block;overflow-wrap:anywhere;padding:8px;background:var(--code);font-size:13px';
   const cp=D.btn('참가자 연결 명령 복사','sec',()=>D.copy(cp,code.textContent).catch(e=>message(s,D.cleanErr(e.message),true)));cp.style.cssText='width:auto;padding:6px 10px;margin-top:8px';
   const seats=s.seats=el('div');seats.style.cssText='display:flex;flex-wrap:wrap;gap:8px;margin-top:12px';
   s.target=el('p','','mut');s.state=el('p','','mut');
   const row=el('div',undefined,'row');s.start=D.btn('선택한 자리에서 시작','',()=>start(s));s.stop=D.btn('새 명령 전송 중지','sec',()=>stop(s));s.refresh=D.btn('상태 확인','sec',()=>status(s));s.takeover=D.btn('이 관리 세션에서 이어받기','',()=>takeover(s));s.forget=D.btn('터미널 결과 확인 후 미확인 요청 기록 지우기','sec',()=>{if(s.active||s.busy)return;s.pending=null;s.startPending=null;message(s,'이 탭의 미확인 요청 기록을 지웠습니다. 기존 명령을 다시 실행하지는 않습니다.');paint(s)});for(const b of [s.start,s.stop,s.refresh,s.takeover,s.forget])b.style.cssText='width:auto;flex:1 1 150px';row.append(s.start,s.stop,s.refresh,s.takeover,s.forget);
   const label=el('label','보낼 한 줄 명령');label.htmlFor='lesson-command-'+lab.id;
   const ta=s.command=el('textarea');ta.id=label.htmlFor;ta.rows=2;ta.maxLength=4096;ta.spellcheck=false;ta.placeholder='예: pwd';ta.style.cssText='display:block;font:14px/1.5 ui-monospace,Consolas,monospace;width:100%;max-width:100%;padding:10px;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--fg);margin:4px 0 8px;resize:vertical';ta.oninput=()=>paint(s);
   s.send=D.btn('명령 보내기','',()=>send(s));const note=el('p','입력은 현재 열린 수업 프로그램(셸·OpenCode 등)으로 전달됩니다. 보내기를 눌러야 실행합니다. 타이핑 중 실시간 전송과 Ctrl+C 등 특수키는 지원하지 않습니다. 중지는 이미 실행 중인 명령을 종료하지 않습니다. 터미널 준비 중에는 시작 결과를 받은 뒤 중지할 수 있습니다.','mut');
   s.msg=el('p','','mut');s.msg.setAttribute('role','status');s.msg.setAttribute('aria-live','polite');s.results=el('ul');s.results.style.cssText='padding-left:20px;overflow-wrap:anywhere';
   d.append(summary,help,guide,code,cp,seats,s.target,s.state,row,label,ta,s.send,note,s.msg,s.results);
   d.ontoggle=()=>{if(d.open&&!s.known&&!s.busy)status(s)};
  }
  // 참가자 선택은 초기에는 모두 꺼짐. 목록 새로고침에도 초안·선택·재시도 ID를 유지한다.
  const present=new Set();s.unavailable.clear();
  for(const seat of lab.seats){present.add(seat.n);if(seat.error)s.unavailable.add(seat.n);let i=s.inputs.get(seat.n);
   if(!i){const l=el('label');l.style.cssText='display:flex;gap:6px;align-items:center;padding:6px 8px;border:1px solid var(--line);border-radius:8px';i=el('input');i.type='checkbox';i.checked=false;i.onchange=()=>paint(s);const span=el('span');l.append(i,span);s.seats.append(l);s.inputs.set(seat.n,i)}
   i.parentElement.lastChild.textContent=seat.n+'번'+(seat.who?' '+seat.who:'')+(seat.error?' · 사용 불가':'');if(seat.error&&!s.active)i.checked=false;
  }
  for(const [n,i] of s.inputs)if(!present.has(n)){i.parentElement.remove();s.inputs.delete(n)}
  paint(s);if(focused&&s.el.contains(focused)){const focusTarget=focused;setTimeout(()=>{if(!document.activeElement||document.activeElement===document.body)focusTarget.focus({preventScroll:true})})}return s.el;
 }
 return {box};
}
`;
