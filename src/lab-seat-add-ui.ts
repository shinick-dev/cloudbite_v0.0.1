// Only non-secret operation references survive refresh; auth stays in the host page.
export const LAB_SEAT_ADD_JS = String.raw`
function createLabSeatAdd(D){
 const $=id=>document.getElementById(id),dialog=$('seatAddDialog'),ops=new Map(),KEY='labSeatAddOperations';
 const rid=/^lc_[0-9]{13}_[a-f0-9]{32}$/,room=/^[\w-]{1,100}$/,version=/^[A-Za-z0-9_-]{43}$/;
 let gen=0,target=null,info=null,busy=false,storageWarning=false;
 function save(){try{if(ops.size)sessionStorage.setItem(KEY,JSON.stringify([...ops].map(([id,o])=>({id,requestId:o.requestId,version:o.version}))));else sessionStorage.removeItem(KEY)}catch{storageWarning=true}}
 try{const raw=sessionStorage.getItem(KEY);if(raw){if(raw.length>10000)throw Error();const rows=JSON.parse(raw);if(!Array.isArray(rows)||rows.length>20)throw Error();for(const row of rows){if(!row||Object.keys(row).sort().join(',')!=='id,requestId,version'||!room.test(row.id)||!rid.test(row.requestId)||!version.test(row.version))throw Error();ops.set(row.id,{requestId:row.requestId,version:row.version,state:'unknown'})}}}catch{ops.clear();try{sessionStorage.removeItem(KEY)}catch{storageWarning=true}}
 const active=()=>ops.get(target),valid=i=>dialog.open&&target===i.id&&gen===i.gen&&D.epoch()===i.auth&&D.admin();
 function note(text,bad){$('seatAddNote').textContent=text+(storageWarning?' 복구 ID를 저장하지 못했습니다. 결과를 확인할 때까지 이 탭을 유지하세요.':'');$('seatAddNote').className=bad?'bad':'mut'}
 function paint(){const op=active(),auth=D.admin();$('seatAddConfirm').hidden=!!op;$('seatAddConfirm').disabled=busy||!auth||!info||!info.canAdd;
  $('seatAddCheck').hidden=!op;$('seatAddCheck').disabled=busy||!auth;
  $('seatAddResume').hidden=!op||!['preparing','not-started'].includes(op.state);$('seatAddResume').disabled=busy||!auth;
  $('seatAddNext').hidden=!op||!['completed','not-started'].includes(op.state);$('seatAddNext').disabled=busy||!auth;
  $('seatAddInvite').hidden=!op||!op.seat?.ready;$('seatAddInvite').disabled=busy||!auth;
 }
 function accept(r){const v=r&&r.seatAdd;if(!v||v.id!==target||typeof v.name!=='string'||!Number.isSafeInteger(v.seats)||!Number.isSafeInteger(v.maxSeats)||!Number.isFinite(v.expiresAt)||!version.test(v.version))throw Error('좌석 정보를 확인하지 못했습니다. 같은 요청의 결과를 확인하세요.');
  info=v;$('seatAddInfo').textContent=v.name+' · 현재 '+v.seats+' / '+v.maxSeats+'자리 · 추가 사양 '+v.cpu+' vCPU / '+v.memory+' GiB / '+v.disk+' GiB · AI 한도 $'+v.budget+' · 종료 '+new Date(v.expiresAt).toLocaleString('ko-KR');
  const op=active();if(!op){note(v.canAdd?'현재 모임과 같은 조건으로 한 자리를 추가합니다. 기존 참여자의 작업은 그대로 유지됩니다.':'이 모임의 좌석 한도에 도달했습니다.');paint();return}
  if(r.requestId!==op.requestId||!['completed','preparing','running','unknown','not-started'].includes(r.creationState))throw Error('복구 응답을 확인하지 못했습니다. 새 요청을 보내지 마세요.');
  op.state=r.creationState;op.seat=v.seat;
  if(op.state==='completed'){if(!op.seat||!Number.isSafeInteger(op.seat.n))throw Error('새 좌석 번호를 확인하지 못했습니다.');note(op.seat.ready?op.seat.n+'번 좌석을 추가했습니다. 새 좌석 초대를 눌러 전달하세요.':op.seat.n+'번 자리 기록은 생겼지만 실습실 준비를 완료하지 못했습니다. 모임 도구에서 복구 상태를 확인하세요.',!op.seat.ready);D.changed?.()}
  else if(op.state==='not-started')note('아직 좌석 생성이 시작되지 않았습니다. 조건을 확인한 뒤 같은 요청으로 계속하거나 새 입력으로 돌아갈 수 있습니다.');
  else note(op.state==='preparing'?'스냅샷을 준비 중입니다. 같은 요청 결과를 확인한 뒤 계속하세요.':'좌석 추가 결과를 확인 중입니다. 새 요청을 보내지 않고 같은 요청의 결과만 확인하세요.',op.state==='unknown');
  paint();
 }
 async function run(write=false){if(busy||!D.admin()||!target)return;const op=active();if(write&&!op)return;
  const i={id:target,gen,auth:D.epoch()};busy=true;paint();
  try{const r=await D.call(write?'/api/lab/seat-add':'/api/lab/seat-add/status',{id:target,...(op?{requestId:op.requestId}:{}),...(write?{version:op.version}:{})});if(valid(i))accept(r)}
  catch(e){if(valid(i))note(D.clean(e)+' 같은 요청 결과 확인을 사용하세요. 자동으로 다시 만들지 않습니다.',true)}
  finally{if(gen===i.gen&&target===i.id){busy=false;paint()}}
 }
 $('seatAddConfirm').onclick=()=>{if(busy||!D.admin()||!info||!info.canAdd||active())return;
  if(!confirm(info.name+'에 1자리를 추가할까요? '+info.cpu+' vCPU / '+info.memory+' GiB / '+info.disk+' GiB, AI 한도 $'+info.budget+'. 실습실 자원·요금이 추가되며 현재 모임 종료 시각에 함께 종료합니다.'))return;
  if(ops.size>=20){note('이 탭의 복구 기록이 가득 찼습니다. 기존 결과를 먼저 확인하세요.',true);return}
  ops.set(target,{requestId:'lc_'+Date.now()+'_'+crypto.randomUUID().replace(/-/g,''),version:info.version,state:'unknown'});save();run(true);
 };
 $('seatAddCheck').onclick=()=>run(false);$('seatAddResume').onclick=()=>run(true);
 $('seatAddNext').onclick=()=>{const op=active();if(busy||!op||!['completed','not-started'].includes(op.state))return;ops.delete(target);save();info=null;paint();run(false)};
 $('seatAddInvite').onclick=async()=>{const op=active();if(busy||!op?.seat?.ready||!D.admin())return;const i={id:target,gen,auth:D.epoch()};busy=true;paint();try{const r=await D.invite(i.id,op.seat.n);if(valid(i))D.showInvite(i.id,r)}catch(e){if(valid(i))note(D.clean(e),true)}finally{if(gen===i.gen){busy=false;paint()}}};
 $('seatAddClose').onclick=()=>dialog.close();dialog.addEventListener('close',()=>{gen++;busy=false;info=null});
 return{open(){if(!D.admin())return;const id=D.selected();if(!room.test(id||''))return;target=id;gen++;busy=false;info=null;$('seatAddInfo').textContent='현재 모임 조건을 확인하는 중…';note(active()?'이 탭에 남은 좌석 추가 요청을 확인합니다. 자동으로 생성하지 않습니다.':'추가할 좌석 조건을 확인하세요.');if(!dialog.open)dialog.showModal();paint();run(false)}};
}
`;
