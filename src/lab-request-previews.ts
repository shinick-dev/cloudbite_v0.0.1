import {LAB_PRESETS,RES_MAX} from '#lab-resources';

export const LAB_REQUEST_PREVIEWS_JS=String.raw`
function createLabRequestPreviews(D){
 const el=(tag,text)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;return n},root=el('section');root.id='requestPreviews';root.setAttribute('aria-label','실습실 개설 요청');
 const head=el('div'),title=el('h3','개설 요청 확인 중'),refresh=el('button','요청 확인'),history=el('a','기록·알림');head.className='request-preview-head';refresh.type='button';refresh.className='sec';history.href='/lab/requests';history.target='_blank';history.rel='noopener';head.append(title,refresh,history);
 const message=el('p'),grid=el('div');message.className='request-preview-note';message.setAttribute('role','status');grid.className='request-preview-grid';root.append(head,message,grid);D.root.append(root);
 const rows=new Map(),uncertain=new Set(),KEY='labRequestFollowup',presets=${JSON.stringify(LAB_PRESETS)};
 let on=false,gen=0,epoch=null,timer=0,reading=false,flight=null,data=null,last=0,stale=true,locked=false,notice='',storageError=false;
 try{const raw=sessionStorage.getItem(KEY);if(raw){if(raw.length>8192)throw Error();const ids=JSON.parse(raw);if(!Array.isArray(ids)||ids.length>128||!ids.every(id=>typeof id==='string'&&/^[a-f0-9-]{36}$/.test(id)))throw Error();ids.forEach(id=>uncertain.add(id))}}catch{try{sessionStorage.removeItem(KEY)}catch{storageError=true}}
 function save(){try{if(uncertain.size)sessionStorage.setItem(KEY,JSON.stringify([...uncertain]));else sessionStorage.removeItem(KEY)}catch{storageError=true}}
 const live=g=>on&&gen===g&&epoch===D.epoch()&&D.active(),date=t=>new Date(t).toLocaleString('ko-KR'),spec=c=>c.cpu+' CPU · '+c.memory+' GiB · 디스크 '+c.disk+' GiB';
 async function post(action,body={},wait=10000){const c=new AbortController(),t=setTimeout(()=>c.abort(),wait);try{
  const r=await fetch('/api/lab/open/manager/'+action,{method:'POST',credentials:'same-origin',redirect:'manual',cache:'no-store',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:c.signal});
  if(r.type==='opaqueredirect'||r.status===0||!r.headers.get('content-type')?.includes('application/json'))throw Object.assign(Error('본인 로그인 후 요청을 확인하세요.'),{status:403});
  const v=await r.json();if(!r.ok)throw Object.assign(Error(v.error||'요청을 확인하지 못했습니다.'),{status:r.status});return v;
 }catch(e){if(e.name==='AbortError')throw Error('응답이 늦어 결과를 확인하지 못했습니다.');throw e}finally{clearTimeout(t)}}
 function clear(){gen++;clearTimeout(timer);reading=false;flight=null;data=null;last=0;stale=true;locked=false;notice='';rows.clear();grid.replaceChildren();message.textContent='';title.textContent='개설 요청 확인 중'}
 function paint(){root.hidden=!rows.size&&!stale&&!locked&&!notice;title.textContent=locked?'개설 요청 · 본인 로그인 필요':stale?'개설 요청 · 확인 필요':'개설 요청 '+rows.size+'건';refresh.disabled=reading||!!flight;
  message.textContent=notice||(locked?'기록·알림에서 본인 로그인 후 요청 확인을 누르세요.':stale?'이전 요청 정보입니다. 확인 전에는 승인하지 않습니다.':rows.size?'승인하면 새 실습실 비용이 발생합니다.':'대기 중인 요청이 없습니다.');
  if(storageError)message.textContent+=' 복구 참조를 저장하지 못했습니다. 결과 확인 전까지 이 탭을 유지하세요.';
  for(const row of rows.values()){const disabled=stale||locked||!!flight;for(const x of row.controls)x.disabled=disabled;row.approve.disabled=disabled||!row.choice();row.box.dataset.waiting=row.request.state==='pending'&&!uncertain.has(row.request.id)?'true':'false'}
 }
 function select(label,values){const l=el('label',label),s=el('select');s.setAttribute('aria-label',label);for(const [value,text]of values){const o=el('option',text);o.value=String(value);s.append(o)}l.append(s);return{label:l,input:s}}
 function build(r){const box=el('article');box.className='request-preview';box.dataset.request=r.id;
  const name=el('h3',r.name||'참여자'),stub=el('div'),badge=el('strong','개설 요청 대기'),purpose=el('p',r.purpose||'');stub.className='request-preview-screen';stub.append(badge,el('span',r.mode==='join'?'현재 모임에 합류':'개인 복습 실습실'));purpose.className='request-preview-purpose';
  const brief=el('p'),details=el('details'),summary=el('summary','승인 조건 변경'),fields=el('div'),status=el('p'),approve=el('button','승인하고 열기'),resume=el('button','같은 요청 결과 확인');brief.className='request-preview-brief';status.className='request-preview-status';status.setAttribute('role','status');approve.type=resume.type='button';resume.className='sec';
  const controls=[approve,resume],row={box,request:r,controls,approve,resume,badge,brief,status,fields,details,choice:()=>null};
  if(r.mode==='practice'){
   const h=select((r.name||'참여자')+' 사용 시간',data.hours.map(n=>[n,n+'시간'])),b=select((r.name||'참여자')+' AI 한도',data.budgets.map(n=>[n,'$'+n])),p=select((r.name||'참여자')+' 실습실 사양',[...presets.map((v,i)=>[i,spec({cpu:v[0],memory:v[1],disk:v[2]})]),['custom','직접 입력']]);
   const custom=el('div'),inputs={};custom.className='request-preview-custom';custom.hidden=true;for(const [key,label,value]of [['cpu','CPU',1],['memory','메모리 GiB',2],['disk','디스크 GiB',5]]){const l=el('label',label),i=el('input');i.type='number';i.min='1';i.max='${RES_MAX}';i.step='1';i.value=String(value);i.setAttribute('aria-label',(r.name||'참여자')+' '+label);inputs[key]=i;l.append(i);custom.append(l);controls.push(i)}
   fields.append(p.label,custom,h.label,b.label);controls.push(p.input,h.input,b.input);
   row.choice=()=>{const v=presets[Number(p.input.value)],resources=p.input.value==='custom'?Object.fromEntries(Object.entries(inputs).map(([key,i])=>[key,Number(i.value)])):v?{cpu:v[0],memory:v[1],disk:v[2]}:null;if(!resources||Object.values(resources).some(n=>!Number.isSafeInteger(n)||n<1||n>${RES_MAX})||!h.input.value||!b.input.value)return null;return{hours:Number(h.input.value),budget:Number(b.input.value),...resources}};
   row.update=()=>{custom.hidden=p.input.value!=='custom';const c=row.choice();brief.textContent=c?spec(c)+' · '+c.hours+'시간 · AI $'+c.budget:'사양·시간·AI 한도를 확인하세요.'};
  }else if(r.mode==='join'){
   const s=select((r.name||'참여자')+' 추가할 모임',[]);fields.append(s.label);controls.push(s.input);row.lab=s.input;s.input.addEventListener('change',()=>row.chosen=true);
   row.choice=()=>{const l=data.labs.find(l=>l.id===s.input.value);return l?{labId:l.id}:null};
   row.update=()=>{const l=data.labs.find(l=>l.id===s.input.value);brief.textContent=l?l.name+' · '+spec(l)+' · AI $'+l.budget+' · 종료 '+date(l.expiresAt):'추가할 수 있는 모임이 없습니다.'};
  }else row.update=()=>{brief.textContent='요청 종류를 확인할 수 없습니다.'};
  fields.addEventListener('input',()=>{row.update();paint()});fields.addEventListener('change',()=>{row.update();paint()});details.append(summary,el('p',r.purpose||''),fields);box.append(name,stub,purpose,brief,approve,resume,status,details);approve.onclick=()=>act(row,false);resume.onclick=()=>act(row,true);return row;
 }
 function render(next){data=next;const keep=new Set();
  for(const r of next.requests){if(!r||typeof r.id!=='string'||!/^[a-f0-9-]{36}$/.test(r.id))continue;if(r.state!=='pending'&&r.state!=='approving'){if(uncertain.delete(r.id))save();continue}keep.add(r.id);let row=rows.get(r.id);if(!row){row=build(r);rows.set(r.id,row);grid.append(row.box)}row.request=r;
   if(row.lab){const previous=row.lab.value,selected=D.selected(),available=next.labs;row.lab.replaceChildren();for(const l of available){const o=el('option',l.name);o.value=l.id;row.lab.append(o)}row.lab.value=row.chosen&&available.some(l=>l.id===previous)?previous:available.some(l=>l.id===selected)?selected:available[0]?.id||''}
   const follow=r.state==='approving'||uncertain.has(r.id);row.approve.hidden=follow;row.resume.hidden=!follow;row.details.hidden=follow;row.badge.textContent=follow?'승인 결과 확인 중':'개설 요청 대기';row.update();if(follow)row.brief.textContent='승인 조건을 바꾸지 않고 같은 요청의 생성 결과만 확인합니다.';
  }
  for(const [id,row]of rows)if(!keep.has(id)){row.box.remove();rows.delete(id)}paint();
 }
 function schedule(){clearTimeout(timer);if(on&&!document.hidden&&!locked)timer=setTimeout(poll,15000)}
 async function poll(){clearTimeout(timer);if(!on||document.hidden||reading||flight)return;reading=true;const g=gen;paint();try{const v=await post('list');if(!live(g))return;if(!Array.isArray(v.requests)||!Array.isArray(v.labs)||!Array.isArray(v.hours)||!Array.isArray(v.budgets))throw Error('요청 목록 응답을 확인하지 못했습니다.');last=Date.now();stale=false;locked=false;render(v)}catch(e){if(!live(g))return;stale=true;if(e.status===401||e.status===403){locked=true;rows.clear();grid.replaceChildren()}notice=e.message;paint()}finally{if(live(g)){reading=false;paint();schedule()}}}
 async function act(row,resuming){if(flight||reading||stale||locked||!on||Date.now()-last>30000){notice='최신 요청과 조건을 먼저 확인하세요.';stale=true;paint();poll();return}
  const r=row.request,g=gen;let choice;if(!resuming){choice=row.choice();if(!choice)return;if(uncertain.size>=128&&!uncertain.has(r.id)){notice='먼저 기존 요청의 결과를 확인하세요.';paint();return}choice={...choice}}flight=r.id;clearTimeout(timer);paint();row.status.textContent=resuming?'같은 요청의 생성 결과를 확인하는 중…':'표시된 조건을 보안 키로 확인하세요.';let sent=resuming;
  try{let result;if(resuming)result=await post('resume',{id:r.id},120000);else{const options=await post('options',{id:r.id,choice});if(!live(g))return;const assertion=await D.tap(options);if(!live(g))return;uncertain.add(r.id);save();sent=true;result=await post('approve',{id:r.id,choice,assertion},120000)}if(!live(g))return;
   if(!result||!['ready','approving'].includes(result.state))throw Error('생성 결과를 확인하지 못했습니다.');notice=result.state==='ready'?(r.name||'참여자')+' · 입장 링크가 준비됐습니다. 참여자가 요청 화면에서 열 수 있습니다.':(r.name||'참여자')+' · 준비 중입니다. 같은 요청 결과를 확인하세요.';if(result.state==='ready'){uncertain.delete(r.id);save();D.changed?.()}else{uncertain.add(r.id);save()}
  }catch(e){if(!live(g))return;if(resuming&&e.status===409&&String(e.message).includes('보안 키로 승인한 요청만')){uncertain.delete(r.id);save();row.status.textContent='아직 승인되지 않은 요청입니다. 조건 확인 후 승인하세요.'}else{if(sent){uncertain.add(r.id);save()}row.status.textContent=e.message+(sent?' 새 승인 없이 같은 요청 결과를 확인하세요.':' 승인하지 않았습니다.')}if(e.status===403){locked=true;stale=true;rows.clear();grid.replaceChildren();notice='본인 로그인을 다시 확인하세요. 승인 결과를 모르면 같은 요청으로 확인하세요.'}}
  finally{if(live(g)){flight=null;for(const row of rows.values()){const follow=row.request.state==='approving'||uncertain.has(row.request.id);row.approve.hidden=follow;row.resume.hidden=!follow;row.details.hidden=follow}paint();poll()}}
 }
 refresh.onclick=()=>{notice='';poll()};addEventListener('visibilitychange',()=>{if(!document.hidden)sync();else clearTimeout(timer)});addEventListener('focus',()=>{if(on&&!reading&&!flight)poll()});
 function sync(){if(!D.active()){if(on){on=false;clear()}return}if(root.parentElement!==D.root)D.root.insertBefore(root,D.root.querySelector('.lab-live-room'));for(const row of rows.values())if(row.lab&&!row.chosen&&row.request.state==='pending'&&!uncertain.has(row.request.id)&&data?.labs.some(l=>l.id===D.selected())){row.lab.value=D.selected();row.update()}const e=D.epoch();if(!on||epoch!==e){clear();on=true;epoch=e;poll()}else if(!locked&&!document.hidden&&!timer&&!reading&&!flight)poll();paint()}
 return{sync};
}
`;
