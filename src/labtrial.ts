// 시험용 1인 실습실과 보내기 전 미리보기. 참여자 터미널로는 명령을 보내지 않는다.
export const LAB_TRIAL_JS = String.raw`
function createLabTrial(D){
 const states=new Map(),openPreview=new Set();let focused=null;
 const now=()=>D.now?D.now():Date.now();
 const time=at=>D.fmt?D.fmt(at):new Date(at).toLocaleTimeString('ko-KR');
 document.addEventListener('focusin',e=>{focused=e.target&&e.target.closest&&e.target.closest('[data-lab-trial]')?e.target:null});
 document.addEventListener('pointerdown',e=>{if(!e.target.closest||!e.target.closest('[data-lab-trial]'))focused=null},true);
 const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n};
 async function request(path,body){
  let timer,late=false;
  const call=Promise.resolve().then(()=>D.call(path,body)).then(v=>v,e=>{if(late)return new Promise(()=>{});throw e});
  try{return await Promise.race([call,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('응답 확인 시간이 지났습니다. 요청은 서버에서 처리 중일 수 있습니다.')),8000)})])}
  finally{late=true;clearTimeout(timer)}
 }
 const is4xx=e=>Number.isInteger(e&&e.status)&&e.status>=400&&e.status<500;
 function badCommand(command){
  if(typeof command!=='string'||!command.trim()||command.length>4096)return true;
  for(let i=0;i<command.length;i++){const c=command.charCodeAt(i);if(c<32||c===127||c===0x2028||c===0x2029)return true}
  return false;
 }
 function bindingOf(r){
  if(!r||typeof r!=='object')return null;
  const b=typeof r.trialId==='string'?r:r.binding;
  if(!b||typeof b.trialId!=='string'||!b.trialId||typeof b.sessionId!=='string'||!b.sessionId||typeof b.closed!=='boolean')return null;
  return{trialId:b.trialId,sessionId:b.sessionId,closed:b.closed};
 }
 function parseStatus(r){
  if(!r||!Array.isArray(r.candidates))return null;
  const candidates=[];
  for(const c of r.candidates){
   if(!c||typeof c.id!=='string'||!c.id||typeof c.name!=='string')return null;
   candidates.push({id:c.id,name:c.name});
  }
  if(r.binding!=null&&!bindingOf(r.binding))return null;
  return{binding:r.binding==null?null:bindingOf(r.binding),candidates,warning:typeof r.warning==='string'?r.warning:''};
 }
 function paint(s){
  const bound=!!(s.binding&&!s.binding.closed);
  s.bindLine.textContent=!s.binding?'연결된 시험 실습실이 없습니다.':s.binding.closed?'시험 실습실이 종료되었습니다.':'시험 실습실에 연결되었습니다.';
  s.refresh.disabled=s.reading;s.run.disabled=s.running||!bound;
  s.run.textContent=s.pendingRun?'같은 시험 요청 다시 확인':'시험 명령 보내기';
  s.outputBtn.disabled=s.readingOutput;s.bindRetry.hidden=!s.pendingBind;s.bindRetry.disabled=s.bindingNow||!s.pendingBind;
  s.pendingLine.textContent=s.pendingBind?'연결 확인 중: '+s.pendingBind.name:'';
  s.forget.hidden=!s.pendingRun;s.forget.disabled=s.running;if(!s.pendingRun)s.forgetAsk.hidden=true;
  if(s.pendingRun){s.pendingHint.textContent='확인되지 않은 시험 요청이 있습니다. 입력란을 바꿔도 아래 명령을 같은 요청으로 다시 확인합니다.';s.pendingCmd.hidden=false;s.pendingCmd.textContent=s.pendingRun.command}
  else{s.pendingHint.textContent='';s.pendingCmd.hidden=true;s.pendingCmd.textContent=''}
 }
 function showCandidates(s){
  s.cand.textContent='';
  if(!s.loaded)return;
  if(!s.candidates.length){s.cand.append(el('p','같은 구성으로 한 번도 사용하지 않은 1인 실습실이 목록에 없습니다. 기존 만들기 화면에서 따로 만든 뒤 시험 상태를 다시 확인하세요.','mut'));return}
  const block=!!s.binding||!!s.pendingBind||s.bindingNow;
  for(const c of s.candidates){
   const row=el('div',undefined,'row'),name=el('span',c.name),btn=D.btn('이 방으로 시험 연결','sec',()=>askBind(s,c));
   btn.disabled=block;btn.style.cssText='width:auto;flex:1 1 150px;word-break:keep-all;white-space:normal';
   row.append(name,btn);s.cand.append(row);
  }
 }
 function askBind(s,c){
  if(s.binding||s.pendingBind||s.bindingNow)return;
  s.askTarget=c;s.askName.textContent=c.name;s.ask.hidden=false;
 }
 function acceptBind(s){
  const c=s.askTarget;
  if(!c||s.binding||s.pendingBind||s.bindingNow)return;
  s.ask.hidden=true;s.askTarget=null;
  s.pendingBind={requestId:crypto.randomUUID(),trialId:c.id,name:c.name};
  doBind(s);
 }
 async function doBind(s){
  if(!s.pendingBind||s.bindingNow)return;
  const pending=s.pendingBind;
  s.bindingNow=true;s.msg.textContent='시험 실습실 연결 확인 중…';paint(s);showCandidates(s);
  try{
   const r=await request('/api/lab/trial/bind',{id:s.id,trialId:pending.trialId,requestId:pending.requestId});
   if(s.pendingBind!==pending)return;
   const b=bindingOf(r);
   if(!b)throw Error('시험 연결 응답을 확인하지 못했습니다.');
   if(s.binding?.trialId!==b.trialId)s.lastTrial=null;s.binding=b;s.pendingBind=null;
   s.msg.textContent=b.closed?'시험 실습실이 종료되었습니다.':'시험 실습실에 연결했습니다. 참여자를 초대하지 않습니다.';
  }catch(e){
   if(s.pendingBind!==pending)return;
   if(is4xx(e)){s.pendingBind=null;s.msg.textContent='시험 연결이 거부되었습니다. 방을 다시 선택한 뒤 연결하세요. '+D.cleanErr(e.message)}
   else s.msg.textContent='시험 연결 결과 확인 필요 · 같은 요청으로 다시 확인하세요. '+D.cleanErr(e.message);
  }finally{s.bindingNow=false;paint(s);showCandidates(s)}
 }
 async function status(s){
  if(s.reading)return;s.reading=true;paint(s);
  try{
   const parsed=parseStatus(await request('/api/lab/trial/status',{id:s.id}));
   if(!parsed)throw Error('시험 상태 응답을 확인하지 못했습니다.');
   s.candidates=parsed.candidates;s.warning=parsed.warning;s.warn.textContent=s.warning;
   if(parsed.binding){if(s.binding?.trialId!==parsed.binding.trialId)s.lastTrial=null;s.binding=parsed.binding;s.pendingBind=null;s.ask.hidden=true;s.askTarget=null}
   else if(!s.pendingBind)s.binding=null;
   s.loaded=true;
   if(!s.pendingBind&&!s.pendingRun)s.msg.textContent='시험 상태를 확인했습니다.';
   showCandidates(s);
  }catch(e){s.msg.textContent='시험 상태 확인 필요 · '+D.cleanErr(e.message)}
  finally{s.reading=false;paint(s)}
 }
 async function run(s){
  if(s.running)return;
  if(!s.binding||s.binding.closed){s.msg.textContent=s.binding&&s.binding.closed?'종료된 시험 실습실에는 명령을 보내지 않습니다.':'먼저 시험 실습실을 연결하세요.';return}
  if(!s.pendingRun){
   const command=s.input.value;
   if(badCommand(command)){s.msg.textContent='시험 명령은 제어 문자 없는 한 줄이며 4096자 이하여야 합니다.';return}
   s.pendingRun={requestId:crypto.randomUUID(),command};
  }
  const pending=s.pendingRun;
  s.running=true;s.msg.textContent='시험 명령 전달 확인 중…';paint(s);
  try{
   const r=await request('/api/lab/trial/run',{id:s.id,requestId:pending.requestId,command:pending.command});
   if(s.pendingRun!==pending)return;
   if(!r||typeof r.runId!=='string'||!r.runId||!['sent','unknown','error'].includes(r.delivery)){s.msg.textContent='시험 실행 응답을 확인하지 못했습니다. 같은 요청으로 다시 확인하세요.';return}
   if(r.delivery==='sent'){s.lastTrial={command:pending.command,runId:r.runId,at:now()};s.pendingRun=null;s.msg.textContent='시험 입력을 전달했습니다. 작업이 끝났는지는 출력을 직접 확인하세요.'}
   else if(r.delivery==='unknown')s.msg.textContent='시험 입력 전달을 확인하지 못했습니다. 같은 요청으로 다시 확인하세요.';
   else{s.pendingRun=null;s.msg.textContent='시험 실행이 거부되었습니다. 명령을 고친 뒤 새 요청으로 보낼 수 있습니다.'}
  }catch(e){
   if(s.pendingRun!==pending)return;
   if(is4xx(e)){s.pendingRun=null;s.msg.textContent='시험 실행이 거부되었습니다. 새 요청을 만들 수 있습니다. '+D.cleanErr(e.message)}
   else s.msg.textContent='시험 실행 결과 확인 필요 · 같은 요청으로 다시 확인하세요. '+D.cleanErr(e.message);
  }finally{s.running=false;paint(s)}
 }
 async function output(s){
  if(s.readingOutput)return;s.readingOutput=true;paint(s);
  try{
   const r=await request('/api/lab/trial/output',{id:s.id});
   if(!r||typeof r.output!=='string'||typeof r.at!=='number'||!Number.isFinite(r.at))throw Error('시험 출력 응답을 확인하지 못했습니다.');
   s.out.textContent=r.output.slice(-8192);
   s.outAt.textContent='출력 확인 시각 '+time(r.at)+' · 작업 완료 여부는 직접 확인하세요.';
  }catch(e){s.msg.textContent='시험 출력 확인 필요 · '+D.cleanErr(e.message)}
  finally{s.readingOutput=false;paint(s)}
 }
 function box(lab){
  let s=states.get(lab.id);
  if(!s){
   s={id:lab.id,loaded:false,reading:false,binding:null,candidates:[],warning:'',pendingBind:null,bindingNow:false,askTarget:null,pendingRun:null,running:false,lastTrial:null,readingOutput:false};
   states.set(s.id,s);
   s.el=el('details');s.el.dataset.labTrial=lab.id;s.el.setAttribute('aria-label','시험용 실습실');
   s.el.style.cssText='border-top:1px solid var(--line);margin-top:16px;padding-top:12px';
   s.el.append(el('summary','시험용 실습실'));
   const help=el('p','모임지기가 참여자에게 명령을 보내기 전에 확인하는 시험 전용 실습실입니다. 수업의 명령 전달을 일시정지해도 시험은 보낼 수 있습니다. 참여자를 초대하지 않으며, 수업이 끝나면 함께 끝납니다.','mut');
   s.refresh=D.btn('시험 상태 확인','sec',()=>status(s));
   s.warn=el('p','','mut');s.warn.setAttribute('role','status');
   s.bindLine=el('p','연결된 시험 실습실이 없습니다.');s.bindLine.setAttribute('role','status');
   s.cand=el('div');
   s.ask=el('div');s.ask.hidden=true;
   s.askName=el('p','','mut');
   const askRow=el('div',undefined,'row');
   const askYes=D.btn('시험 실습실로 연결','sec',()=>acceptBind(s)),askNo=D.btn('연결 취소','sec',()=>{s.ask.hidden=true;s.askTarget=null});
   askRow.append(askYes,askNo);
   s.ask.append(el('p','시험 전용입니다. 참여자를 초대하지 않습니다. 모임지기의 수업이 끝나면 이 시험 실습실도 함께 끝납니다.'),s.askName,askRow);
   s.pendingLine=el('p','','mut');
   s.bindRetry=D.btn('같은 연결 요청 다시 확인','sec',()=>doBind(s));s.bindRetry.hidden=true;
   s.input=document.createElement('input');s.input.type='text';s.input.maxLength=4096;s.input.autocomplete='off';s.input.spellcheck=false;
   s.input.setAttribute('aria-label','시험 명령');s.input.style.cssText='width:100%;box-sizing:border-box';
   s.run=D.btn('시험 명령 보내기','sec',()=>run(s));
   s.outputBtn=D.btn('시험 출력 보기','sec',()=>output(s));
   s.pendingHint=el('p','','mut');
   s.pendingCmd=el('pre','');s.pendingCmd.hidden=true;s.pendingCmd.style.cssText='white-space:pre-wrap;overflow-wrap:anywhere';
   s.forget=D.btn('출력 확인 후 미확인 시험 요청 정리','sec',()=>{s.forgetAsk.hidden=false});
   s.forgetAsk=el('div');s.forgetAsk.hidden=true;
   const forgetYes=D.btn('요청 기록만 정리','sec',()=>{if(s.running)return;s.pendingRun=null;s.msg.textContent='이 탭의 미확인 시험 요청 기록을 정리했습니다. 실행 중인 프로그램을 중단하거나 같은 명령을 다시 실행하지 않습니다.';paint(s)});
   const forgetNo=D.btn('계속 같은 요청 확인','sec',()=>{s.forgetAsk.hidden=true});
   s.forgetAsk.append(el('p','원래 명령이 아직 실행 중일 수 있습니다. 출력을 직접 확인한 뒤 정리하세요. 기록 정리는 프로그램을 중단하지 않습니다. 다음 명령은 직접 선택해서 보내야 합니다.','mut'),forgetYes,forgetNo);
   s.out=el('pre','');s.out.style.cssText='white-space:pre-wrap;word-break:break-word;max-height:240px;overflow:auto';
   s.outAt=el('p','','mut');
   s.msg=el('p','시험 상태를 아직 확인하지 않았습니다.','mut');s.msg.setAttribute('role','status');s.msg.setAttribute('aria-live','polite');
   const runRow=el('div',undefined,'row');runRow.append(s.run,s.outputBtn);
   for(const b of [s.refresh,s.run,s.outputBtn,s.bindRetry,askYes,askNo,s.forget,forgetYes,forgetNo])b.style.cssText='width:auto;flex:1 1 150px;word-break:keep-all;white-space:normal';
   s.el.append(help,s.refresh,s.warn,s.bindLine,s.cand,s.ask,s.pendingLine,s.bindRetry,el('p','시험 명령','mut'),s.input,s.pendingHint,s.pendingCmd,s.forget,s.forgetAsk,runRow,s.out,s.outAt,s.msg);
   s.el.addEventListener('toggle',()=>{if(s.el.open)status(s)});
  }
  paint(s);if(focused&&s.el.contains(focused)){const target=focused;setTimeout(()=>{if(!document.activeElement||document.activeElement===document.body)target.focus({preventScroll:true})})}return s.el;
 }
 function preparePreview(id,sessionId,command,container){
  if(openPreview.has(id))return Promise.reject(Error('이 수업의 미리보기가 이미 열려 있습니다.'));
  if(!container||typeof command!=='string')return Promise.reject(Error('미리보기를 열 수 없습니다.'));
  openPreview.add(id);
  const remembered=states.get(id);
  const trialRunId=remembered&&remembered.lastTrial&&remembered.lastTrial.command===command&&remembered.lastTrial.runId&&now()-remembered.lastTrial.at<300000?remembered.lastTrial.runId:null;
  return new Promise((resolve,reject)=>{
   let panel,settled=false,epoch=0,requestId=null,requestBody=null,ready=null,sending=false;
   const finish=value=>{if(settled)return;settled=true;epoch++;openPreview.delete(id);if(panel)panel.remove();resolve(value)};
   try{
    panel=el('section');panel.dataset.labPreview=String(id);panel.setAttribute('aria-label','명령 미리보기');
    panel.style.cssText='border:1px solid var(--line);margin-top:12px;padding:12px';
    const intro=el('p',trialRunId?'같은 명령의 시험 입력이 전달된 기록이 있습니다. 결과를 직접 확인했다면 선택하세요.':'이 명령의 시험 전달 기록이 없습니다. 시험 없이 진행하려면 아래를 직접 선택하세요.','mut');
    const shown=el('pre',command);shown.style.cssText='white-space:pre-wrap;overflow-wrap:anywhere;max-height:180px;overflow:auto';
    const choice=el('label'),tick=document.createElement('input');tick.type='checkbox';
    choice.append(tick,document.createTextNode(trialRunId?'시험 결과를 직접 확인했습니다':'시험 실행 없이 내용과 대상을 확인했습니다'));
    const fallback=trialRunId?el('label'):null,waiver=trialRunId?document.createElement('input'):null;
    if(waiver){waiver.type='checkbox';fallback.append(waiver,document.createTextNode('이번에는 시험 실행 없이 내용과 대상을 확인했습니다'))}
    const row=el('div',undefined,'row'),note=el('p','','mut'),targets=el('p','');
    note.setAttribute('role','status');note.setAttribute('aria-live','polite');
    const prep=D.btn('미리보기 준비','sec',()=>send()),cancel=D.btn('취소','sec',()=>finish(null)),finalBtn=D.btn('이 내용과 대상에 명령 보내기','sec',()=>confirm());
    prep.disabled=true;finalBtn.hidden=true;
    for(const b of [prep,cancel,finalBtn])b.style.cssText='width:auto;flex:1 1 150px;word-break:keep-all;white-space:normal';
    const acknowledged=()=>tick.checked||!!waiver?.checked;
    tick.addEventListener('change',()=>{if(tick.checked&&waiver)waiver.checked=false;prep.disabled=!acknowledged()||sending||!!ready});
    waiver?.addEventListener('change',()=>{if(waiver.checked)tick.checked=false;prep.disabled=!acknowledged()||sending||!!ready});
    row.append(prep,cancel);
    async function send(){
     if(sending||ready||settled||!acknowledged())return;
     if(!requestId){requestId=crypto.randomUUID();requestBody={id,requestId,command};if(trialRunId&&tick.checked)requestBody.trialRunId=trialRunId;else requestBody.ackWithoutTrial=true}
     const mine=++epoch,body=requestBody;
     tick.disabled=true;if(waiver)waiver.disabled=true;
     sending=true;prep.disabled=true;note.textContent='미리보기 준비 확인 중…';
     try{
      const r=await request('/api/lab/preview',body);
      if(settled||mine!==epoch)return;
      if(!r||typeof r.previewId!=='string'||!r.previewId||!Array.isArray(r.targets)||!r.targets.length||!r.targets.every(n=>Number.isSafeInteger(n)&&n>0)||typeof r.expiresAt!=='number'||!Number.isFinite(r.expiresAt)){
       note.textContent='미리보기 응답을 확인하지 못했습니다. 같은 요청으로 다시 확인하거나 취소하세요.';
       prep.textContent='같은 미리보기 요청 다시 확인';prep.disabled=!acknowledged();return;
      }
      ready={previewId:r.previewId,targets:r.targets.slice(),expiresAt:r.expiresAt};
      targets.textContent='승인된 대상: '+r.targets.map(n=>n+'번').join(', ');
      finalBtn.hidden=false;prep.hidden=true;tick.disabled=true;
      note.textContent=r.tested===true?'시험 기록이 연결된 미리보기입니다.':r.tested===false?'시험 실행 없이 준비한 미리보기입니다.':'미리보기를 준비했습니다. 시간이 지나면 취소하고 새로 준비해야 합니다.';
     }catch(e){
      if(settled||mine!==epoch)return;
      if(is4xx(e)){requestId=null;requestBody=null;tick.disabled=false;if(waiver)waiver.disabled=false;prep.textContent='미리보기 준비';note.textContent='미리보기가 거부되었습니다. 확인 뒤 새로 준비할 수 있습니다. '+D.cleanErr(e.message)}
      else{prep.textContent='같은 미리보기 요청 다시 확인';note.textContent='미리보기 결과 확인 필요 · 같은 요청으로 다시 확인하거나 취소하세요. '+D.cleanErr(e.message)}
      prep.disabled=!acknowledged();
     }finally{if(!settled&&mine===epoch)sending=false}
    }
    function confirm(){
     if(!ready||settled)return;
     if(!(now()<ready.expiresAt)){note.textContent='미리보기 시간이 지났습니다. 취소한 뒤 새로 준비하세요.';finalBtn.disabled=true;return}
     finish(ready.previewId);
    }
    panel.append(intro,shown,choice,...(fallback?[fallback]:[]),row,note,targets,finalBtn);container.append(panel);
   }catch(e){openPreview.delete(id);panel?.remove();reject(e)}
  });
 }
 return{box,preparePreview};
}
`;
