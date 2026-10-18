// 수업 카드에서 항상 보이는 전달 제어. 진행 중인 프로그램은 종료하지 않는다.
export const LAB_CONTROL_JS = String.raw`
function createLabControl(D){
 const states=new Map(),listeners=new Map();
 const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n};
 const notify=s=>{for(const f of listeners.get(s.id)||[])f()};
 const valid=r=>r&&['running','paused','ended'].includes(r.mode)&&Number.isSafeInteger(r.revision)&&r.revision>=0;
 async function request(path,body){let timer;try{return await Promise.race([D.call(path,body),new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('응답 확인 시간이 지났습니다. 요청은 서버에서 처리 중일 수 있습니다.')),D.timeoutMs||8000))])}finally{clearTimeout(timer)}}
 const blocked=s=>!s||!s.known||s.view.mode!=='running'||!!s.pausePending||!!s.resumePending||!!s.uncertain;
 function paint(s){
  s.label.textContent=!s.known||s.uncertain&&s.view.mode==='running'?'명령 전달 상태 확인 필요':s.view.mode==='paused'?'명령 전달 일시정지':s.view.mode==='ended'?'수업 종료':'명령 전달 가능';
  s.label.className=!blocked(s)?'ok':'bad';
  s.pause.disabled=s.pausing||s.view?.mode==='ended';s.pause.textContent=s.pausePending?'같은 일시정지 요청 다시 확인':'명령 전달 일시정지';
  s.resume.disabled=s.pausing||s.resuming||!s.known||s.view.mode!=='paused'||!!s.pausePending||s.uncertain&&!s.resumePending;
  s.resume.textContent=s.resumePending?'같은 재개 요청 다시 확인':'명령 전달 재개';s.refresh.disabled=s.reading;
  notify(s);
 }
 function take(s,r){
  if(!valid(r))throw Error('명령 전달 상태 응답을 확인하지 못했습니다.');
  if(s.known&&r.revision<s.view.revision)return;
  if(s.known&&r.revision===s.view.revision&&r.mode!==s.view.mode)throw Error('같은 상태 번호의 응답이 일치하지 않습니다. 다시 확인하세요.');
  if(!s.known||r.revision!==s.view.revision||r.mode!==s.view.mode)s.epoch++;
  s.view=r;s.known=true;s.lastCheck=Date.now();
 }
 async function status(s){
  if(s.reading)return;s.reading=true;const sequence=s.sequence;paint(s);
  try{const r=await request('/api/lab/control/status',{id:s.id});
   if(sequence!==s.sequence)return;take(s,r);
   if(s.resumePending&&(r.revision!==s.resumePending.expectedRevision||r.mode!=='paused'))s.resumePending=null;
   if(!s.pausePending&&!s.resumePending){s.uncertain=false;s.msg.textContent='서버 상태를 확인했습니다. 프로그램 실행 여부는 각 자리에서 확인하세요.'}
  }catch(e){if(sequence===s.sequence){s.uncertain=true;s.msg.textContent='전달 상태 확인 필요 · '+D.cleanErr(e.message)}}finally{s.reading=false;paint(s);if(sequence!==s.sequence)queueMicrotask(()=>status(s))}
 }
 async function pause(s){
  if(s.pausing||s.view?.mode==='ended')return;
  if(!s.pausePending)s.pausePending={id:s.id,requestId:crypto.randomUUID()};
  // 새 일시정지는 이전 재개보다 우선한다. 서버도 새 개정 번호로 이전 재개를 차단한다.
  s.resumePending=null;s.sequence++;s.epoch++;s.pausing=true;s.uncertain=true;const sequence=s.sequence,pending=s.pausePending;
  s.msg.textContent='명령 전달 일시정지 요청 중… 이미 실행 중인 프로그램은 계속 실행될 수 있습니다.';paint(s);
  try{const r=await request('/api/lab/control/pause',pending);if(sequence!==s.sequence)return;take(s,r);s.pausePending=null;s.uncertain=false;
   s.msg.textContent='일시정지 요청 결과를 받았습니다. 이미 전달된 명령은 취소되지 않습니다.';
  }catch(e){if(sequence===s.sequence)s.msg.textContent='일시정지 결과 확인 필요 · 같은 요청으로 다시 확인하세요. '+D.cleanErr(e.message)}finally{s.pausing=false;paint(s)}
 }
 async function resume(s){
  if(s.pausing||s.resuming||!s.known||s.view.mode!=='paused'||s.pausePending)return;
  if(!s.resumePending){
   if(s.uncertain)return;
   if(!window.confirm('새 명령 전달을 다시 허용할까요? 중지 전에 보내던 명령과 프로그램을 자동으로 다시 실행하지 않습니다.'))return;
   s.resumePending={id:s.id,requestId:crypto.randomUUID(),expectedRevision:s.view.revision};
  }
  s.sequence++;s.epoch++;s.resuming=true;s.uncertain=true;const sequence=s.sequence,pending=s.resumePending;paint(s);s.msg.textContent='명시적으로 명령 전달 재개 요청 중…';
  try{const r=await request('/api/lab/control/resume',pending);if(sequence!==s.sequence)return;take(s,r);s.resumePending=null;s.uncertain=false;
   s.msg.textContent='재개 요청 결과를 받았습니다. 새 명령은 모임지기가 다시 보내야 합니다.';
  }catch(e){if(sequence===s.sequence){
   // 409 등의 명확한 거부는 최신 상태 확인 뒤 새 요청을 만들 수 있다. 응답 유실은 같은 ID를 유지한다.
   if(e.status===409||e.status===410||e.status===400)s.resumePending=null;
   s.msg.textContent='재개 결과 확인 필요 · '+D.cleanErr(e.message);
  }}finally{s.resuming=false;paint(s)}
 }
 function box(lab){let s=states.get(lab.id);
  if(!s){s={id:lab.id,known:false,view:null,epoch:0,sequence:0,lastCheck:0};states.set(s.id,s);
   s.el=el('section');s.el.dataset.labControl=lab.id;s.el.setAttribute('aria-label','수업 명령 전달 제어');s.el.style.cssText='border-top:1px solid var(--line);margin-top:16px;padding-top:12px';
   s.label=el('strong','명령 전달 상태 확인 필요');s.label.setAttribute('role','status');s.label.setAttribute('aria-live','polite');
   const row=el('div',undefined,'row');s.pause=D.btn('명령 전달 일시정지','sec',()=>pause(s));s.resume=D.btn('명령 전달 재개','sec',()=>resume(s));s.refresh=D.btn('전달 상태 확인','sec',()=>status(s));
   for(const b of [s.pause,s.resume,s.refresh])b.style.cssText='width:auto;flex:1 1 150px;word-break:keep-all;white-space:normal';row.append(s.pause,s.resume,s.refresh);
   s.msg=el('p','서버 상태 확인 중…','mut');s.msg.setAttribute('role','status');s.msg.setAttribute('aria-live','polite');
   s.el.append(s.label,row,el('p','일시정지는 이후 명령 전달을 막습니다. 이미 실행 중인 프로그램과 참여자의 개인 터미널은 종료하지 않습니다.','mut'),s.msg);
   queueMicrotask(()=>status(s));
  }else if(Date.now()-s.lastCheck>10000&&!s.reading&&!s.pausing&&!s.resuming)queueMicrotask(()=>status(s));
  paint(s);return s.el;
 }
 return{box,allowsNew:id=>!blocked(states.get(id)),epoch:id=>states.get(id)?.epoch||0,revision:id=>states.get(id)?.view?.revision,
  invalidate:id=>{const s=states.get(id);if(s){s.uncertain=true;s.sequence++;s.epoch++;paint(s);status(s)}},
  subscribe:(id,fn)=>{if(!listeners.has(id))listeners.set(id,new Set());listeners.get(id).add(fn)}};
}
`;
