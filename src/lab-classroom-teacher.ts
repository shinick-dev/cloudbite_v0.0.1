// 모임지기 수업 셸. 토큰·저장소는 쓰지 않고 pages.ts 가 넘긴 콜백으로만 서버를 부른다.
// 방식 변경·단계 안내는 수업 구성 개정만 바꾸고, 명령 전달이나 참여자 진행은 건드리지 않는다.
export const LAB_CLASSROOM_TEACHER_JS = String.raw`
function createLabClassroomTeacher(D){
 const el=(tag,text,cls)=>{const e=document.createElement(tag);if(text!=null)e.textContent=text;if(cls)e.className=cls;return e};
 const clean=e=>{const raw=e&&e.message?String(e.message):String(e||'');try{return D.cleanErr?D.cleanErr(raw):raw}catch{return raw}};
 const auth=()=>{try{return D.auth?D.auth():{admin:false,readOnly:false}}catch{return{admin:false,readOnly:false}}};
 const labNow=()=>{try{return D.lab?D.lab():null}catch{return null}};
 const sid=id=>typeof id==='string'&&/^[A-Za-z0-9_-]+$/.test(id)?id:'';
 const MEMO_REQUEST='AI 공부방 모임 안내를 위한 보고서가 필요합니다.\n메모 두 개를 근거로 5줄로 정리해 주세요.\n확정된 사실과 아직 검토·제안 중인 내용을 구분해 주세요.';
 const MEMO_PROGRESS='현재 신청자: 10명\n정원 12명: 검토 중\n진행 시간 40분: 제안\n참가비: 아직 확인하지 않음';
 const TEMPLATE={title:'메모 두 개로 5줄 보고서 만들기',steps:[
  {id:'memo-read',title:'메모 두 개 읽기',instruction:'어떤 자료가 있고, 무엇이 요청됐는지 확인하세요.',prompt:'01_요청메모.txt와 02_진행메모.txt를 읽고, 요청 사항과 확인된 사실을 각각 알려 주세요. 파일은 아직 만들지 마세요.'},
  {id:'memo-draft',title:'AI에게 초안 요청',instruction:'메모를 근거로 5줄짜리 결과.txt를 만들어 보세요.',prompt:'두 메모만 근거로 안내 보고서를 5줄로 써서 결과.txt에 저장해 주세요. 확정된 사실과 검토·제안 중인 내용을 구분하고, 없는 정보는 확인 필요로 적어 주세요.'},
  {id:'memo-split',title:'사실과 제안 구분',instruction:'정원·진행 시간·참가비 표현을 원문과 대조하세요.',prompt:'결과.txt를 두 메모와 대조해 주세요. 12명은 검토 중, 40분은 제안입니다. 참가비는 확인 필요로 고치고 5줄을 유지해 주세요.'},
  {id:'memo-submit',title:'결과물 제출',instruction:'직접 읽고 수정한 결과.txt를 제출하세요.',prompt:'결과.txt를 직접 열어 5줄인지 확인하세요. 없는 사실이 추가되지 않았는지 본 다음 제출하세요.'},
  {id:'memo-keep',title:'내 컴퓨터에 보관',instruction:'내려받은 파일을 직접 열고, 다음에 연습할 곳을 남기세요.',prompt:'결과.txt를 내려받아 내 컴퓨터에서 직접 열어 보세요. 확인한 다음 보관 확인을 표시하고 복습할 단계를 골라 주세요.'}
 ],materials:[{name:'01_요청메모.txt',content:MEMO_REQUEST},{name:'02_진행메모.txt',content:MEMO_PROGRESS}]};
 const modeLabel={demo:'시연 보기',together:'함께 실행',individual:'개별 실습'};
 let archiveId='',courses=[],historyBusy=false,historyError='',epoch=0,pollTimer=0,ended=false,lastLiveId=null;
 const creationIds=new Map(),pendingCommands=new Map();
 let view='live',watching=false,boundId=null,lastAuth='',known=false,server=null,people=[],peopleError=false,loadError='',stale=false,dirty=false,loading=false,busy=false,gen=0,focusField='',focusSel=null;
 let draft=blank();
 let demo={state:'none',message:'',output:'',requestId:''};
 let demoCommand='',demoLink='',feedbackDraft='',selectedN=null,selectedSub='',demoStatusRead=false,demoAutoTried=false,demoPollTimer=0;
 let statusText='',statusBad=false;
 function blank(){return{title:'',steps:[],materials:[],recordingUrl:'',chapters:[]}}
 function clone(v){return JSON.parse(JSON.stringify(v))}
 function note(text,bad){statusText=text||'';statusBad=!!bad&&!!statusText;const n=document.getElementById('classNote');if(!n||loadError||stale)return;n.textContent=statusText;n.className=statusBad?'bad':'mut'}
 function currentId(){if(archiveId&&(view==='sub'||view==='review'))return archiveId;const lab=labNow();return lab&&typeof lab.id==='string'&&lab.id?lab.id:null}
 function authKey(){const a=auth();return (a.admin?'a':a.readOnly?'r':'x')}
 function str(v,max){return typeof v==='string'&&v.length<=max?v:null}
 function num(v,max){return typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=max?v:null}
 function validate(c){
  if(!c||typeof c!=='object')return null;
  const revision=num(c.revision,1e15),currentStep=num(c.currentStep,100000);
  const title=str(c.title,500),recordingUrl=str(c.recordingUrl,2000);
  if(revision==null||currentStep==null||title==null||recordingUrl==null)return null;
  if(c.mode!=='demo'&&c.mode!=='together'&&c.mode!=='individual')return null;
  if(!Array.isArray(c.steps)||c.steps.length>12||!Array.isArray(c.materials)||c.materials.length>40||!Array.isArray(c.chapters)||c.chapters.length>40)return null;
  const steps=[];
  for(const s of c.steps){const id=str(s&&s.id,80),t=str(s&&s.title,500),instruction=str(s&&s.instruction,8000),prompt=str(s&&s.prompt,8000);if(!id||t==null||instruction==null||prompt==null)return null;steps.push({id,title:t,instruction,prompt})}
  const materials=[];
  for(const m of c.materials){const name=str(m&&m.name,200),content=str(m&&m.content,100000);if(name==null||content==null)return null;materials.push({name,content})}
  const chapters=[];
  for(const ch of c.chapters){const t=str(ch&&ch.title,500),seconds=num(ch&&ch.seconds,8640000),step=num(ch&&ch.step,100000);if(t==null||seconds==null||step==null)return null;chapters.push({title:t,seconds,step})}
  return{revision,title,mode:c.mode,currentStep,steps,materials,recordingUrl,chapters,updatedAt:typeof c.updatedAt==='number'?c.updatedAt:0};
 }
 function person(p){
  if(!p||typeof p.n!=='number'||!Number.isInteger(p.n)||p.n<1)return null;
  const submissions=[];
  if(p.submissions!=null&&!Array.isArray(p.submissions))return {bad:true,n:p.n,who:typeof p.who==='string'?p.who:'',progress:null,submissions:[]};
  for(const s of p.submissions||[]){
   if(!s||typeof s.id!=='string'||typeof s.content!=='string'||typeof s.filename!=='string'||typeof s.version!=='number'||typeof s.submittedAt!=='number'||typeof s.step!=='number'||typeof s.feedback!=='string'){submissions.push({bad:true,id:s&&typeof s.id==='string'?s.id:''});continue}
   submissions.push({id:s.id,version:s.version,filename:s.filename,content:s.content,submittedAt:s.submittedAt,step:s.step,feedback:s.feedback,feedbackAt:typeof s.feedbackAt==='number'?s.feedbackAt:null});
  }
  const progress=p.progress&&typeof p.progress==='object'&&typeof p.progress.step==='number'?{step:p.progress.step,completed:p.progress.completed===true,updatedAt:typeof p.progress.updatedAt==='number'?p.progress.updatedAt:0}:null;
  return{n:p.n,who:typeof p.who==='string'?p.who:'',progress,submissions};
 }
 function parseStatus(data){
  if(!data||typeof data!=='object')return{error:'수업 구성 응답을 확인하지 못했습니다.'};
  if(!('classroom' in data)||!('participants' in data))return{error:'수업 구성 응답을 확인하지 못했습니다.'};
  if(data.classroom==null){
   if(!Array.isArray(data.participants))return{classroom:null,participants:[],peopleError:true};
   const list=data.participants.map(person).filter(Boolean);
   return{classroom:null,participants:list.filter(x=>!x.bad),peopleError:list.some(x=>x.bad)};
  }
  const classroom=validate(data.classroom);
  if(!classroom)return{error:'수업 구성 응답을 확인하지 못했습니다.'};
  if(!Array.isArray(data.participants))return{classroom,participants:[],peopleError:true};
  const list=data.participants.map(person).filter(Boolean);
  return{classroom,participants:list.filter(x=>!x.bad),peopleError:list.some(x=>x.bad)};
 }
 function contentOf(c){return{title:c.title,steps:clone(c.steps),materials:clone(c.materials),recordingUrl:c.recordingUrl,chapters:clone(c.chapters)}}
 function readForm(){
  const title=document.querySelector('[data-field="title"]');if(title)draft.title=title.value;
  const rec=document.querySelector('[data-field="recording"]');if(rec)draft.recordingUrl=rec.value;
  const fb=document.querySelector('[data-field="feedback"]');if(fb)feedbackDraft=fb.value;
  const cmd=document.querySelector('[data-field="demo-command"]');if(cmd)demoCommand=cmd.value;
  for(let i=0;i<draft.steps.length;i++){const t=document.querySelector('[data-field="step-title-'+i+'"]'),a=document.querySelector('[data-field="step-instruction-'+i+'"]'),p=document.querySelector('[data-field="step-prompt-'+i+'"]');if(t)draft.steps[i].title=t.value;if(a)draft.steps[i].instruction=a.value;if(p)draft.steps[i].prompt=p.value}
  for(let i=0;i<draft.materials.length;i++){const n=document.querySelector('[data-field="mat-name-'+i+'"]'),c=document.querySelector('[data-field="mat-content-'+i+'"]');if(n)draft.materials[i].name=n.value;if(c)draft.materials[i].content=c.value}
  for(let i=0;i<draft.chapters.length;i++){const t=document.querySelector('[data-field="ch-title-'+i+'"]'),s=document.querySelector('[data-field="ch-seconds-'+i+'"]'),p=document.querySelector('[data-field="ch-step-'+i+'"]');if(t)draft.chapters[i].title=t.value;if(s)draft.chapters[i].seconds=s.value;if(p)draft.chapters[i].step=p.value}
 }
 function rememberFocus(){const a=document.activeElement;focusField=a&&a.dataset&&a.dataset.field?a.dataset.field:'';focusSel=a&&typeof a.selectionStart==='number'?[a.selectionStart,a.selectionEnd]:null}
 function capture(){readForm();rememberFocus()}
 function restore(){if(!focusField)return;const node=document.querySelector('[data-field="'+focusField+'"]');if(!node||typeof node.focus!=='function')return;try{node.focus()}catch{return}if(focusSel&&node.setSelectionRange)try{node.setSelectionRange(focusSel[0],focusSel[1])}catch{}}
 function mark(){dirty=true;readForm();rememberFocus()}
 function field(tag,label,value,key,area){
  const wrap=el('label','', 'class-field');wrap.append(el('span',label,'mut'));
  const input=document.createElement(tag);input.value=value==null?'':String(value);input.dataset.field=key;const max=key==='title'?60:key==='feedback'?1000:key==='recording'?400:key.startsWith('step-title-')?40:key.startsWith('step-instruction-')?240:key.startsWith('step-prompt-')?480:key.startsWith('mat-name-')?40:key.startsWith('mat-content-')?2000:key.startsWith('ch-title-')?40:0;if(max)input.maxLength=max;if(tag==='textarea')input.rows=area||3;
  input.oninput=()=>{if(key!=='feedback'&&key!=='demo-command')dirty=true;readForm();rememberFocus()};wrap.append(input);return wrap;
 }
 function btn(text,cls,fn){const b=el('button',text,cls||'');b.type='button';b.onclick=fn;return b}
 function httpsUrl(value){try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password?u:null}catch{return null}}
 function clock(seconds){const s=Math.max(0,Math.floor(Number(seconds)||0));return String(Math.floor(s/60)).padStart(2,'0')+':'+String(s%60).padStart(2,'0')}
 function when(t){if(typeof t!=='number'||!Number.isFinite(t))return'시각 확인 필요';try{return new Date(t).toLocaleString('ko-KR')}catch{return'시각 확인 필요'}}
 async function pull(id){
  const a=auth();
  if(a.admin)return D.admin('/api/lab/classroom/status',{id});
  if(a.readOnly)return D.read(id);
  const e=new Error('수업 구성을 보려면 보안 키로 열거나 읽기 전용 모니터가 필요합니다. 요청은 보내지 않았습니다.');e.status=401;throw e;
 }
 function applyParsed(parsed,replaceDraft){
  if(parsed.error){loadError=parsed.error;return}
  loadError='';known=true;
  const prevRev=server?server.revision:null;
  server=parsed.classroom;
  people=parsed.participants||[];
  peopleError=parsed.peopleError===true;
  if(server){
   if(replaceDraft||!dirty){draft=contentOf(server);dirty=false;stale=false}
   else stale=prevRev!==null&&server.revision!==prevRev||stale;
  }else if(replaceDraft||!dirty){draft=blank();dirty=false;stale=false}
 }
 async function refresh(keep){
  if(loading||busy||ended)return;const id=boundId,ticket=++gen;if(!id){paint();return}
  loading=true;if(keep!==false)capture();statusText='';statusBad=false;paint();
  try{const data=await pull(id);if(ticket!==gen||id!==boundId)return;applyParsed(parseStatus(data),!dirty)}
  catch(e){if(ticket!==gen||id!==boundId)return;loadError=clean(e)}
  finally{if(ticket===gen){loading=false;paint();armPoll()}}
 }
 async function reloadKeep(){
  const id=boundId,ticket=++gen;if(!id)return;
  capture();const kept=clone(draft),keptDirty=true,keptFeedback=feedbackDraft;
  loading=true;
  try{const data=await pull(id);if(ticket!==gen||id!==boundId)return;applyParsed(parseStatus(data),false);draft=kept;dirty=keptDirty;feedbackDraft=keptFeedback;stale=true;loadError=''}
  catch(e){if(ticket===gen)loadError='서버 내용을 다시 읽지 못했습니다. 입력 초안은 유지했습니다. '+clean(e);stale=true}
  finally{if(ticket===gen){loading=false;paint()}}
 }
 function limits(){
  if(draft.title.trim().length<1||draft.title.length>60)return'수업 이름은 1~60자로 적어 주세요.';
  if(draft.steps.length>12)return'단계는 12개까지입니다.';
  for(const s of draft.steps){if(!/^[a-z0-9][a-z0-9-]{0,31}$/.test(s.id)||!s.title.trim()||s.title.length>40||s.instruction.length>240||s.prompt.length>480)return'단계 이름·안내·요청문은 각각 40자·240자·480자까지입니다.'}
  if(draft.materials.length>4)return'자료는 4개까지입니다.';
  for(const m of draft.materials){if(!m.name.trim()||m.name.startsWith('.')||/[<>:"/\\|?*\x00-\x1f]/.test(m.name)||m.name.length>40||m.content.length>2000)return'자료 이름은 경로 없이 40자, 내용은 2000자까지입니다.'}
  const url=draft.recordingUrl.trim();
  if(url&&!httpsUrl(url))return'녹화 주소는 비우거나 https 주소만 저장할 수 있습니다.';
  if(url.length>400)return'녹화 주소가 너무 깁니다.';
  if(draft.chapters.length>12)return'재생 위치는 12개까지입니다.';
  for(const ch of draft.chapters){const seconds=Number(ch.seconds),step=Number(ch.step);if(!ch.title||ch.title.length>40||!Number.isSafeInteger(seconds)||seconds<0||seconds>86400||!Number.isSafeInteger(step)||step<0||step>=draft.steps.length)return'재생 위치는 이름, 0 이상의 초, 0 이상의 단계 번호가 필요합니다.'}
  return'';
 }
 function payloadContent(){
  return{title:draft.title.trim(),steps:draft.steps.map(s=>({id:s.id,title:s.title.trim(),instruction:s.instruction,prompt:s.prompt})),materials:draft.materials.map(m=>({name:m.name.trim(),content:m.content})),recordingUrl:draft.recordingUrl.trim(),chapters:draft.chapters.map(ch=>({title:ch.title.trim(),seconds:Number(ch.seconds),step:Number(ch.step)}))};
 }
 async function update(patch){
  if(busy)return;
  const a=auth();if(!a.admin||archiveId){note('관리 작업은 보안 키로 다시 확인한 뒤에 저장할 수 있습니다.',true);return}
  const id=boundId||currentId();if(!id){note('모임을 먼저 고르세요.',true);return}
  const revision=server?server.revision:0,ticket=epoch;++gen;loading=false;
  busy=true;paint();
  try{const data=await D.admin('/api/lab/classroom/update',{id,revision,patch});if(!actionCurrent(id,ticket))return;const parsed=parseStatus(data);if(parsed.error){loadError=parsed.error;note(parsed.error,true);return}
   const contentPatch=patch.title!=null||patch.steps||patch.materials||patch.recordingUrl!=null||patch.chapters;
   applyParsed(parsed,contentPatch);if(contentPatch)dirty=false;note('수업 구성을 저장했습니다. 참여자 진행은 바꾸지 않았습니다.');}
  catch(e){if(!actionCurrent(id,ticket))return;if(e&&e.status===409){note('다른 저장과 겹쳤습니다. 입력 초안은 유지하고 서버 내용만 다시 읽습니다.',true);await reloadKeep();return}note('저장하지 못했습니다. '+clean(e),true)}
  finally{if(actionCurrent(id,ticket)){busy=false;++gen;paint();armPoll()}}
 }
 async function setMode(next){
  if(archiveId||!server||server.mode===next||busy)return;
  if(!confirm('수업 방식을 '+modeLabel[next]+'(으)로 바꿉니다. 명령은 보내지 않고, 실행 중인 작업도 멈추지 않습니다.'))return;
  await update({mode:next});
 }
 async function setStep(step){
  if(archiveId||!server||busy)return;
  if(!Number.isSafeInteger(step)||step<0||step>=server.steps.length){note('저장할 단계 번호가 목록에 없습니다.',true);return}
  if(!confirm((step+1)+'단계 안내로 저장합니다. 참여자의 진행 단계는 바꾸지 않습니다.'))return;
  await update({currentStep:step});
 }
 function releaseTerminal(){
  const host=document.querySelector('#classMain [data-terminal-host]');if(!host)return;
  const box=host.querySelector('[data-lab-terminal]');if(!box)return;
  const id=sid(box.dataset.labTerminal||'');
  const section=id?document.querySelector('#labs [data-lab="'+id+'"] [data-lab-section="터미널 실행"]'):null;
  if(section)section.append(box);else box.remove();
 }
 function placeTerminal(lab){
  const host=document.querySelector('#classMain [data-terminal-host]');if(!host||!lab)return;
  const id=sid(lab.id);let box=id?document.querySelector('[data-lab-terminal="'+id+'"]'):null;
  if(!box){try{box=D.terminal(lab)}catch{return}}
  if(box&&box.parentElement!==host)host.append(box);
  if(box&&box.tagName==='DETAILS')box.open=true;
 }
 function paintPeople(){
  if(!D.rail)return;
  let host=document.getElementById('classPeople');
  if(!host){host=el('section');host.id='classPeople';host.setAttribute('aria-label','참여자 진행');D.rail.insertBefore(host,D.rail.firstChild)}
  host.replaceChildren();host.hidden=false;
  if(!archiveId&&D.people&&D.people(people)){host.hidden=true;return}
  host.append(el('h2','참여자'));
  if(archiveId){host.append(el('p','지난 모임의 보관 기록을 보고 있습니다. 실시간 지원은 수업 진행에서 여세요.','mut'));return}
  if(!watching){host.append(el('p','수업 구성을 불러오면 참여자 진행이 여기에 표시됩니다.','mut'));return}
  if(peopleError)host.append(el('p','참여자 정보 일부를 확인하지 못했습니다.','bad'));
  if(!people.length){host.append(el('p','표시할 참여자가 없습니다.','mut'));return}
  for(const p of people){
   const row=el('div','','class-person');
   const who=(p.who?p.who+' · ':'')+p.n+'번';
   const own=p.progress?('참여자 진행 '+(p.progress.step+1)+'단계'+(p.progress.completed?' · 본인 완료 표시':'')):'참여자 진행 기록 없음';
   row.append(el('strong',who),el('p',own+' · 제출 '+(p.submissions.filter(s=>!s.bad).length)+'개','mut'));
   const help=btn('도와주기','sec',()=>{const lab=labNow();const step=server&&server.steps[server.currentStep];const text=(step?(server.currentStep+1)+'단계 '+step.title+' 안내. ':'')+who+' 지원을 엽니다. 참여자 진행은 바꾸지 않습니다.';if(D.help)D.help(p.n,text)});
   help.setAttribute('aria-label',who+' 도와주기');row.append(help);host.append(row);
  }
 }
 function paintNav(){
  const side=D.side;if(!side)return;
  side.replaceChildren();
  const nav=el('nav');nav.setAttribute('aria-label','수업');
  for(const [id,text] of [['live','수업 진행'],['prep','수업 준비'],['sub','제출·피드백'],['review','복습하기']]){
   const b=btn(text,'',()=>goto(id));if(view===id)b.setAttribute('aria-current','page');nav.append(b);
  }
  side.append(nav);
  const steps=el('div','','class-steps');
  if(!server||!server.steps.length)steps.append(el('p','저장된 단계가 없습니다.','mut'));
  else server.steps.forEach((s,i)=>{const b=btn((i+1)+'. '+s.title,'',()=>setStep(i));if(server.currentStep===i)b.setAttribute('aria-current','step');if(archiveId||!auth().admin||busy)b.disabled=true;steps.append(b)});
  const stepMenu=el('details');stepMenu.open=!D.guide&&(window.matchMedia?window.matchMedia('(min-width:1001px)').matches:true);stepMenu.append(el('summary','오늘의 순서'),steps);side.append(stepMenu);
  side.append(el('p','개설 요청과 설정은 위쪽 메뉴에 있습니다.','mut'));
 }
 function stepStrip(){
  const box=el('section','','class-card');
  if(!known){box.append(el('h2','수업 구성을 아직 불러오지 않았습니다'),el('p','저장된 단계·자료·제출만 표시합니다. 예시 참여자나 실행 결과는 만들지 않습니다.','mut'));return box}
  if(!server){box.append(el('h2','저장된 수업 구성이 없습니다'),el('p','예시 참여자나 실행 결과는 만들지 않습니다. 메모 연습 템플릿은 수업 준비에서 직접 저장할 때만 만듭니다.','mut'));return box}
  const step=server.steps[server.currentStep];
  box.append(el('p',server.title,'class-step-context'));
  if(!step)box.append(el('p','저장된 현재 단계 번호가 단계 목록과 맞지 않습니다.','bad'));
  else{box.append(el('h2','지금 '+(server.currentStep+1)+' / '+server.steps.length+' · '+step.title));box.append(el('p',step.instruction));const pre=el('pre',step.prompt,'class-prompt');box.append(pre)}
  const row=el('div','','class-row');
  const next=btn('다음 단계로 안내','',()=>setStep(Math.min(server.steps.length-1,server.currentStep+1)));
  if(!auth().admin||!server.steps.length||server.currentStep>=server.steps.length-1||busy)next.disabled=true;
  row.append(next);box.append(row);
  box.append(el('p','단계 안내는 모임 공통 현재 단계만 바꿉니다. 참여자 각각의 진행은 바꾸지 않습니다.','mut'));
  return box;
 }
 function modeSwitch(){
  const box=el('div','','class-row');box.setAttribute('role','group');box.setAttribute('aria-label','수업 방식');
  for(const key of ['demo','together','individual']){const b=btn(modeLabel[key],server&&server.mode===key?'':'sec',()=>setMode(key));b.setAttribute('aria-pressed',String(!!server&&server.mode===key));if(!server||!auth().admin||busy)b.disabled=true;box.append(b)}
  const hint=server&&server.mode==='demo'?'시연실 명령은 참여자 자리에 전달되지 않습니다.':server&&server.mode==='together'?'함께 실행은 고른 참여자 자리에서만, 확인 뒤에 보냅니다.':'개별 실습은 각자 자기 실습실에서 작업합니다. 방식을 바꿔도 명령은 보내지 않습니다.';
  const wrap=el('section','','class-card');wrap.dataset.classModes='1';wrap.append(box,el('p',hint,'mut'));return wrap;
 }
 function actionCurrent(id,ticket){return !ended&&id===boundId&&ticket===epoch&&auth().admin}
 async function demoAction(kind){
  if(busy||!auth().admin||!boundId||archiveId)return;
  const id=boundId,ticket=epoch;readForm();let body={id};
  if(kind==='prepare'){
   if(!confirm('참여자 자리와 별도인 시연실을 준비합니다. 추가 자원·요금이 발생할 수 있습니다. 기존 요청이 있으면 같은 요청으로 확인합니다.'))return;
   if(!creationIds.has(id))creationIds.set(id,crypto.randomUUID());
   body.requestId=creationIds.get(id);demo.requestId=body.requestId;
   demoAutoTried=false;
  }
  if(kind==='send'){
   let pending=pendingCommands.get(id);
   if(!pending){const command=demoCommand;if(!command.trim()||command.length>4000||/[\r\n\t]/.test(command)){note('시연 명령은 줄바꿈·탭 없이 4000자까지 적어 주세요.',true);return}pending={requestId:crypto.randomUUID(),command};pendingCommands.set(id,pending)}
   Object.assign(body,pending);demo.requestId=body.requestId;
  }
  busy=true;paint();
  try{
   const r=await D.admin('/api/lab/classroom/demo/'+(kind==='popout'?'open':kind),body);if(!actionCurrent(id,ticket))return;
   if(kind==='open'||kind==='popout'){
    const raw=r&&typeof r.url==='string'?r.url:'',url=httpsUrl(raw)||(()=>{try{const u=new URL(raw);return u.protocol==='http:'&&['localhost','127.0.0.1'].includes(u.hostname)&&!u.username&&!u.password?u:null}catch{return null}})();
    if(!url){note('시연실 주소를 확인하지 못했습니다.',true);return}
    if(kind==='popout'){demoLink=url.href;window.open(url.href,'_blank','noopener,noreferrer');note('시연실을 열었습니다. 새 탭을 확인해 주세요.')}
    else{if(typeof D.mountDemo!=='function')throw Error('중앙 시연 연결을 사용할 수 없습니다.');await D.mountDemo(id,url.href);if(!actionCurrent(id,ticket))return;note('')}
   }else{
    demo.state=r&&r.state||'unknown';demo.message=r&&typeof r.message==='string'?r.message:'';demo.output=r&&typeof r.output==='string'?r.output:'';if(r&&typeof r.requestId==='string'&&/^[0-9a-f-]{36}$/.test(r.requestId))creationIds.set(id,r.requestId);
    if(kind==='send'&&demo.state==='ready')pendingCommands.delete(id);
   }
  }catch(e){if(!actionCurrent(id,ticket))return;if(kind==='open'||kind==='popout')note('시연실을 열지 못했습니다. 중앙에서 열기로 다시 시도해 주세요. '+clean(e),true);else{demo.state='unknown';demo.message='결과를 확인하지 못했습니다. 상태나 같은 요청으로 확인하세요. '+clean(e)}}
  finally{if(actionCurrent(id,ticket)){busy=false;paint();armPoll();armDemoCheck();if((kind==='prepare'||kind==='status')&&demo.state==='ready'&&!demoAutoTried&&!D.isDemoMounted?.(id)){demoAutoTried=true;queueMicrotask(()=>{if(actionCurrent(id,ticket))demoAction('open')})}}}
 }
 const demoPrepare=()=>demoAction('prepare'),demoStatus=()=>demoAction('status'),demoSend=()=>demoAction('send'),demoOpen=()=>demoAction('open'),demoPopout=()=>demoAction('popout');
 function armDemoCheck(){clearTimeout(demoPollTimer);demoPollTimer=0;if(ended||view!=='live'||demo.state!=='creating'||!auth().admin||!boundId)return;const id=boundId,ticket=epoch;demoPollTimer=setTimeout(()=>{demoPollTimer=0;if(!actionCurrent(id,ticket)||view!=='live')return;if(busy)armDemoCheck();else demoStatus()},3000)}
 function demoPanel(){
  const box=el('section','','class-card class-demo');box.dataset.demoRoom=boundId||'';box.append(el('h2','내 시연'));
  const state=demo.state||'none';
  const known={none:'시연실 상태 없음',creating:'시연실 만드는 중',ready:'시연실 준비됨',unknown:'시연 결과 확인 필요',error:'시연 오류'};
  box.append(el('p',(known[state]||'시연 결과 확인 필요')+(demo.message?' · '+demo.message:''),state==='error'||state==='unknown'?'bad':'mut'));

  if(demo.requestId)box.append(el('p','최근 요청 ID는 결과 확인에만 씁니다. 자동으로 다시 실행하지 않습니다.','mut'));
  const row=el('div','','class-row');
  row.append(btn('시연실 만들기','',demoPrepare),btn('시연 상태 확인','sec',demoStatus),btn('중앙에서 열기','sec',demoOpen),btn('시연실 새 탭으로 열기','sec',demoPopout));
  for(const b of row.querySelectorAll('button'))if(!auth().admin||busy)b.disabled=true;
  box.append(row);
  const workspace=el('div','','class-demo-work'),commands=el('div','','class-demo-commands');
  commands.append(field('textarea','시연실에만 보낼 명령',demoCommand,'demo-command',2));
  const send=btn(pendingCommands.has(boundId)?'같은 시연 요청 결과 확인':'시연 명령 보내기','',demoSend);if(!auth().admin||busy)send.disabled=true;commands.append(send);
  const link=el('a','시연실 직접 열기');link.id='classDemoLink';link.target='_blank';link.rel='noopener noreferrer';if(demoLink){link.href=demoLink;link.hidden=false}else link.hidden=true;commands.append(link);
  if(pendingCommands.has(boundId)){const pending=pendingCommands.get(boundId);commands.append(el('pre',pending.command,'class-text'),el('p','실행 결과가 미확정입니다. 같은 번호로 확인하며 다시 실행하지 않습니다.','mut'));const abandon=btn('실제 터미널 확인 후 미확정 요청 닫기','sec',()=>{if(confirm('실제 시연실 터미널에서 기존 명령 결과를 확인하셨나요? 닫은 뒤 새 명령은 별도 실행됩니다.')){pendingCommands.delete(boundId);paint()}});if(!auth().admin||busy)abandon.disabled=true;commands.append(abandon)}
  if(demo.output)commands.append(el('pre',demo.output,'class-text'));
  if(D.demoEditor&&boundId)workspace.append(D.demoEditor(boundId,server?server.materials:[]));workspace.append(commands);box.append(workspace);
  box.append(el('p','이곳의 명령과 파일은 모임지기 시연실에서만 사용합니다.','mut'));
  return box;
 }
 function togetherPanel(){
  const box=el('section','','class-card');box.append(el('h2','함께 실행'));
  box.append(el('p','아래에서 고른 참여자 자리에만 같은 한 줄을 보냅니다. 보내기 전에 기존 확인을 거칩니다. 방식을 바꿔도 이미 실행 중인 작업은 멈추지 않습니다.','mut'));
  if(!auth().admin)box.append(el('p','함께 실행은 보안 키로 다시 확인한 뒤에 보낼 수 있습니다.','bad'));
  const host=el('div');host.dataset.terminalHost='1';box.append(host);return box;
 }
 function individualPanel(){
  const box=el('section','','class-card');box.append(el('h2','개별 실습'));
  box.append(el('p','참여자는 각자 자기 실습실에서 작업합니다. 모임지기가 방식을 바꿔도 명령을 보내지 않고, 실행 중인 작업도 멈추지 않습니다.'));
  box.append(el('p','도움이 필요하면 오른쪽 참여자에서 기존 지원을 엽니다. 화면 제어는 참여자 동의가 있을 때만 가능합니다.','mut'));
  return box;
 }
 function liveView(){
  const main=D.main;(D.guide||main).append(stepStrip());main.append(modeSwitch());
  if(!server){const card=el('section','','class-card');card.append(btn(loading?'불러오는 중…':'수업 구성 불러오기','',()=>activate()));main.append(card);return}
  main.append(demoPanel());
  if(server.mode==='together')main.append(togetherPanel());
  if(auth().admin&&!demoStatusRead&&!busy){demoStatusRead=true;const id=boundId,ticket=epoch;queueMicrotask(()=>{if(actionCurrent(id,ticket))demoAction('status')})}
 }
 function editorList(title,items,render,addLabel,blankItem,max){
  const box=el('section','','class-card');box.append(el('h2',title));
  items.forEach((item,i)=>box.append(render(item,i)));
  const add=btn(addLabel,'sec',()=>{if(items.length>=max){note(title+'은 '+max+'개까지입니다.',true);return}capture();items.push(blankItem());dirty=true;paint()});
  if(!auth().admin||busy)add.disabled=true;box.append(add);return box;
 }
 function prepView(){
  const main=D.main;
  const base=el('section','','class-card');base.append(el('h2','수업 준비'));
  if(!watching){base.append(el('p','저장 버튼을 누르기 전에는 수업 구성을 바꾸지 않습니다.','mut'),btn('수업 구성 불러오기','',()=>activate()));main.append(base);return}
  base.append(field('input','수업 이름',draft.title,'title'));
  if(stale)base.append(el('p','서버 개정과 이 화면의 초안이 다릅니다. 초안은 유지했습니다.','bad'));
  const actions=el('div','','class-row');
  const save=btn('준비 내용 저장','',()=>{capture();const why=limits();if(why){note(why,true);return}update(payloadContent())});
  const templ=btn('메모 연습 템플릿 저장','sec',async()=>{if(!confirm('메모 연습 템플릿을 이 모임의 수업 구성에 저장합니다. 참여자 진행은 바꾸지 않고, 명령도 보내지 않습니다.'))return;const patch={title:TEMPLATE.title,steps:clone(TEMPLATE.steps),materials:clone(TEMPLATE.materials)};if(!server)Object.assign(patch,{mode:'individual',currentStep:0});await update(patch)});
  const reload=btn('서버 내용 불러오기','sec',()=>{if(!confirm('서버에 저장된 내용으로 초안을 바꿀까요? 아직 저장하지 않은 입력은 이 화면에서 사라집니다.'))return;if(server){draft=contentOf(server);dirty=false;stale=false;paint()}else refresh()});
  if(!auth().admin||busy){save.disabled=templ.disabled=true}
  actions.append(save,templ,reload,btn(loading?'불러오는 중…':'수업 구성 다시 불러오기','sec',()=>refresh()));
  base.append(actions);main.append(base);
  main.append(editorList('단계',draft.steps,(s,i)=>{const card=el('div','','class-card');card.append(field('input','단계 이름',s.title,'step-title-'+i),field('textarea','안내',s.instruction,'step-instruction-'+i,3),field('textarea','요청문',s.prompt,'step-prompt-'+i,4));const rm=btn('이 단계 빼기','sec',()=>{capture();draft.steps.splice(i,1);dirty=true;paint()});if(!auth().admin||busy)rm.disabled=true;card.append(rm);return card},'단계 추가',()=>({id:'s-'+Math.random().toString(16).slice(2),title:'',instruction:'',prompt:''}),12));
  main.append(editorList('텍스트 자료',draft.materials,(m,i)=>{const card=el('div','','class-card');card.append(field('input','파일 이름',m.name,'mat-name-'+i),field('textarea','내용',m.content,'mat-content-'+i,5));const rm=btn('이 자료 빼기','sec',()=>{capture();draft.materials.splice(i,1);dirty=true;paint()});if(!auth().admin||busy)rm.disabled=true;card.append(rm);return card},'자료 추가',()=>({name:'',content:''}),4));
  const rec=el('section','','class-card');rec.append(el('h2','녹화 주소와 재생 위치'),el('p','주소는 비우거나 https 링크만 저장합니다. 이 페이지에서 재생하지 않습니다.','mut'),field('input','녹화 https 주소',draft.recordingUrl,'recording'));
  rec.append(editorList('재생 위치',draft.chapters,(ch,i)=>{const card=el('div','','class-card');card.append(field('input','위치 이름',ch.title,'ch-title-'+i),field('input','초',ch.seconds,'ch-seconds-'+i),field('input','단계 번호 (0부터)',ch.step,'ch-step-'+i));const rm=btn('이 위치 빼기','sec',()=>{capture();draft.chapters.splice(i,1);dirty=true;paint()});if(!auth().admin||busy)rm.disabled=true;card.append(rm);return card},'재생 위치 추가',()=>({title:'',seconds:0,step:0}),12));
  main.append(rec);
 }
 function chosenPerson(){return people.find(p=>p.n===selectedN)||people[0]||null}
 function chosenSub(p){if(!p)return null;const good=p.submissions.filter(s=>!s.bad);return good.find(s=>s.id===selectedSub)||good[good.length-1]||null}
 function subView(){
  const main=D.main;const box=el('section','','class-card');box.append(el('h2','제출·피드백'),historyPanel());
  if(!watching){box.append(btn('수업 구성 불러오기','',()=>activate()));main.append(box);return}
  if(!people.length){box.append(el('p','표시할 참여자가 없습니다.','mut'));main.append(box);return}
  const list=el('div','','class-row');
  for(const p of people){const b=btn((p.who||p.n+'번'),p.n===(chosenPerson()&&chosenPerson().n)?'':'sec',()=>{selectedN=p.n;selectedSub='';feedbackDraft='';paint()});list.append(b)}
  box.append(list);
  const p=chosenPerson();const good=(p.submissions||[]).filter(s=>!s.bad);
  if(p.submissions.some(s=>s.bad))box.append(el('p','일부 제출 내용을 확인하지 못했습니다.','bad'));
  if(!good.length){box.append(el('p','저장된 제출물이 없습니다.','mut'));main.append(box);return}
  const versions=el('div','','class-row');
  for(const s of good){const b=btn('v'+s.version+' · '+s.filename,s.id===(chosenSub(p)&&chosenSub(p).id)?'':'sec',()=>{selectedSub=s.id;feedbackDraft=s.feedback||'';paint()});versions.append(b)}
  box.append(versions);
  const sub=chosenSub(p);
  box.append(el('p',sub.filename+' · '+when(sub.submittedAt)+' · 제출 당시 단계 '+(sub.step+1),'mut'));
  box.append(el('pre',sub.content,'class-text'));
  const saved=el('p',sub.feedback?'저장된 피드백':'저장된 피드백 없음','mut');box.append(saved);
  if(sub.feedback)box.append(el('pre',sub.feedback,'class-text'));
  box.append(field('textarea','피드백',feedbackDraft||'','feedback',4));
  const save=btn('피드백 저장','',async()=>{
   if(busy||archiveId||!auth().admin){note('관리 작업은 보안 키로 다시 확인한 뒤에 저장할 수 있습니다.',true);return}
   readForm();const text=feedbackDraft;if(text.length>1000){note('피드백은 1000자까지입니다.',true);return}
   const id=boundId,ticket=epoch;++gen;loading=false;busy=true;paint();
   try{const data=await D.admin('/api/lab/classroom/feedback',{id,n:p.n,submissionId:sub.id,feedback:text});if(!actionCurrent(id,ticket))return;const parsed=parseStatus(data);if(parsed.error){note(parsed.error,true);return}applyParsed(parsed,!dirty);feedbackDraft=text;note('피드백을 저장했습니다.')}
   catch(e){if(!actionCurrent(id,ticket))return;if(e&&e.status===409){note('제출 상태가 바뀌어 피드백을 저장하지 못했습니다. 입력 초안은 유지합니다.',true);await reloadKeep();return}note('피드백을 저장하지 못했습니다. '+clean(e),true)}
   finally{if(actionCurrent(id,ticket)){busy=false;++gen;paint();armPoll()}}
  });
  if(archiveId||!auth().admin||busy)save.disabled=true;box.append(save);
  const zip=btn('ZIP·보관 기록 보기','sec',()=>{const lab=labNow();const found=lab&&D.archive?D.archive(lab):null;if(!found||(!found.finish&&!found.checkpoint)){note('ZIP 전송 기록과 내부 보관 도구가 아직 없습니다. 내려받기와 직접 확인은 서로 다릅니다.',true);return}if(found.finish){found.finish.open=true;try{found.finish.scrollIntoView({block:'nearest'})}catch{}}if(found.checkpoint)found.checkpoint.open=true;note('기존 마무리·보관 기록을 열었습니다. 내려받기, 내부 보관, PC에서 직접 열기 확인은 서로 다릅니다.')});
  if(archiveId)zip.disabled=true;box.append(zip);
  box.append(el('p','제출 내용·피드백·ZIP 전송·참여자가 PC에서 직접 연 확인은 서로 다른 기록입니다.','mut'));
  main.append(box);
 }
 function reviewView(){
  const main=D.main;const box=el('section','','class-card');box.append(el('h2','복습하기'),historyPanel());
  if(!server){box.append(el('p',known?'저장된 녹화 주소가 없습니다.':'저장된 녹화와 재생 위치만 표시합니다.','mut'),btn(watching?'수업 구성 다시 불러오기':'수업 구성 불러오기','',()=>watching?refresh():activate()));main.append(box);return}
  const url=server.recordingUrl.trim();
  if(!url)box.append(el('p','저장된 녹화 주소가 없습니다.','mut'));
  else if(!httpsUrl(url))box.append(el('p','저장된 녹화 주소가 https가 아니라 열지 않습니다.','bad'));
  else{const a=el('a','저장된 녹화 열기');a.href=url;a.target='_blank';a.rel='noopener noreferrer';box.append(a);box.append(el('p','녹화는 새 탭의 저장 주소로만 엽니다. 이 페이지에 재생기를 넣지 않습니다.','mut'))}
  if(!server.chapters.length)box.append(el('p','저장된 재생 위치가 없습니다.','mut'));
  else{const list=el('div','','class-steps');
   for(const ch of server.chapters){const row=el('div','','class-card');row.append(el('strong',clock(ch.seconds)+' · '+ch.title));const known=server.steps[ch.step];row.append(el('p',known?((ch.step+1)+'단계 · '+known.title):'저장된 단계 번호가 목록과 맞지 않습니다.','mut'));
    const go=btn('이 단계로 안내 맞추기','sec',()=>setStep(ch.step));if(archiveId||!auth().admin||!known||busy)go.disabled=true;row.append(go);list.append(row)}
   box.append(list)}
  box.append(el('p','복습에서 단계를 맞춰도 참여자 진행은 바꾸지 않습니다.','mut'));
  main.append(box);
 }
 function forgetRoom(){++epoch;++gen;clearTimeout(demoPollTimer);demoPollTimer=0;busy=false;loading=false;if(D.clearDemo)D.clearDemo();known=false;server=null;people=[];peopleError=false;loadError='';stale=false;dirty=false;draft=blank();statusText='';statusBad=false;demo={state:'none',message:'',output:'',requestId:''};demoStatusRead=false;demoAutoTried=false;demoLink='';demoCommand='';feedbackDraft='';selectedN=null;selectedSub=''}
 function paint(){
  rememberFocus();
  releaseTerminal();
  if(D.side)paintNav();
  if(D.guide)D.guide.replaceChildren();
  if(D.main){D.main.dataset.classView=view;D.main.dataset.classMode=server?.mode||'';D.main.replaceChildren();const banner=el('p','','mut');banner.id='classNote';banner.setAttribute('role','status');banner.setAttribute('aria-live','polite');if(D.notice)D.notice.replaceChildren(banner);else D.main.append(banner);
   if(loadError){banner.textContent=loadError;banner.className='bad'}
   else if(stale){banner.textContent='서버에 더 새로운 저장이 있습니다. 이 화면의 입력 초안은 유지했습니다.';banner.className='bad'}
   else if(statusText){banner.textContent=statusText;banner.className=statusBad?'bad':'mut'}
   else if(!currentId())banner.textContent='모임을 고르면 그 모임의 수업 구성을 불러올 수 있습니다.';
   else if(!auth().admin&&!auth().readOnly)banner.textContent='보안 키로 열거나 읽기 전용 모니터가 있어야 수업 구성을 봅니다.';
   if(view==='prep')prepView();else if(view==='sub')subView();else if(view==='review')reviewView();else liveView();
  }
  paintPeople();
  if(view==='live'&&server&&server.mode==='together'&&auth().admin)placeTerminal(labNow());
  restore();
  D.onPaint?.();
 }
 function goto(next){capture();if(D.navigate)D.navigate(next);view=next;if(next==='live'||next==='prep')archiveId='';watching=true;const id=currentId();if(id!==boundId){forgetRoom();boundId=id;feedbackDraft='';}if(id)refresh(false);else paint()}
 function activate(){watching=true;const id=currentId();if(id!==boundId){forgetRoom();boundId=id}if(boundId)return refresh();else{loadError='모임을 먼저 고르세요.';paint()}}
 function armPoll(){if(pollTimer||ended||!watching||document.hidden||!boundId||(!auth().admin&&!auth().readOnly))return;pollTimer=setTimeout(()=>{pollTimer=0;if(!busy&&!loading&&!focusInForm())refresh();else armPoll()},10000)}
 function focusInForm(){const a=document.activeElement;return !!(a&&D.main&&D.main.contains(a)&&['INPUT','TEXTAREA','SELECT'].includes(a.tagName))}
 function sync(){
  const live=labNow(),liveId=live&&live.id||null,key=authKey();
  if(liveId!==lastLiveId){archiveId='';lastLiveId=liveId}
  const authChanged=key!==lastAuth;lastAuth=key;
  if(authChanged){++epoch;++gen;busy=false;loading=false;if(D.clearDemo)D.clearDemo();if(!auth().admin){archiveId='';courses=[];historyBusy=false;historyError='';creationIds.clear();pendingCommands.clear();forgetRoom()}}
  const id=currentId(),roomChanged=id!==boundId;
  if(roomChanged){forgetRoom();boundId=id;}
  if(id&&(auth().admin||auth().readOnly)&&(!watching||roomChanged||authChanged)){watching=true;refresh(false);return}
  if(!focusInForm()&&!busy&&!loading)paint();armPoll();
 }
 async function loadHistory(){if(historyBusy||!auth().admin)return;historyBusy=true;historyError='';const ticket=epoch;paint();try{const r=await D.admin('/api/lab/classroom/history',{});if(ticket!==epoch)return;if(!r||!Array.isArray(r.courses))throw Error('지난 모임 목록을 확인하지 못했습니다.');courses=r.courses.filter(x=>x&&sid(x.id)&&typeof x.title==='string'&&Number.isFinite(x.retainUntil)&&x.retainUntil>Date.now()).slice(0,128)}catch(e){if(ticket===epoch)historyError=clean(e)}finally{if(ticket===epoch){historyBusy=false;paint()}}}
 function historyPanel(){const box=el('div','','class-history');if(!auth().admin){box.append(el('p','지난 모임 기록은 모임지기의 관리 세션에서 확인합니다.','mut'));return box}
  const label=el('label','기록을 볼 모임'),select=el('select');select.setAttribute('aria-label','기록을 볼 모임');const live=labNow();const first=el('option','현재 모임'+(live?' · '+(live.name||live.id):''));first.value='';select.append(first);
  for(const c of courses){const option=el('option',c.title+' · '+when(c.endedAt));option.value=c.id;select.append(option)}select.value=archiveId;
  select.onchange=()=>{capture();archiveId=select.value;forgetRoom();boundId=currentId();watching=true;if(boundId)refresh(false);else paint()};select.disabled=busy||loading;label.append(select);box.append(label,btn(historyBusy?'지난 모임 확인 중…':'지난 모임 목록 불러오기','sec',loadHistory));
  if(historyError)box.append(el('p',historyError,'bad'));if(archiveId){const c=courses.find(c=>c.id===archiveId);box.append(el('p','종료한 모임의 읽기 전용 기록'+(c?' · '+when(c.retainUntil)+'까지 보관':''),'mut'))}return box;
 }
 document.addEventListener('visibilitychange',()=>{if(document.hidden){clearTimeout(pollTimer);pollTimer=0}else if(watching&&!busy&&!loading&&!focusInForm())refresh()});
 window.addEventListener('pagehide',()=>{ended=true;++epoch;++gen;clearTimeout(pollTimer);clearTimeout(demoPollTimer);pollTimer=demoPollTimer=0;if(D.clearDemo)D.clearDemo()});
 window.addEventListener('pageshow',()=>{if(ended){ended=false;sync()}});
 paint();
 return{sync,activate,openDemo:demoOpen,popoutDemo:demoPopout};
}
`;
