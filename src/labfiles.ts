// Participant file inspection: an explicit human acknowledgment, never an anchor-click claim.
export const LAB_FILES_JS = String.raw`
function createLabFileUI(D){
 if(!D)return null;
 const button=D.el('button',D.BTN,'파일 보존 확인');button.title='ZIP 내려받기와 파일 직접 확인 기록';D.box.insertBefore(button,D.box.lastElementChild);
 let dialog,receipt=null,expected=null,busy=false,check,summary,message,ack,refresh,archiveSelect,archiveStatus,archiveRefresh,archiveDownload,readingArchives=false,downloadingArchive=false;
 const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
 const valid=r=>r&&UUID.test(r.id)&&Number.isFinite(r.at)&&r.at>0&&(r.verifiedAt===null||Number.isFinite(r.verifiedAt)&&r.verifiedAt>=r.at);
 const time=t=>new Date(t).toLocaleString('ko-KR');
 function paint(){
  if(!dialog)return;
  const pending=!!expected&&receipt?.id!==expected;
  summary.textContent=pending?'새 다운로드의 전송 완료 기록을 아직 확인하지 못했습니다. 브라우저 다운로드 목록을 확인한 뒤 상태를 다시 확인하세요.':!receipt?'완료된 전송 기록이 없습니다. 파일을 저장한 뒤 내 작업 받기로 내려받으세요.':receipt.verifiedAt?'참여자가 ZIP 파일을 직접 확인했다고 표시했습니다. '+time(receipt.verifiedAt):'ZIP 전송 기록: '+time(receipt.at)+' · 브라우저에 저장됐는지는 다운로드 목록에서 확인하세요.';
  ack.disabled=busy||downloadingArchive||pending||!receipt||!!receipt.verifiedAt||!check.checked;refresh.disabled=busy;check.disabled=busy||downloadingArchive||pending||!receipt||!!receipt.verifiedAt;
  archiveRefresh.disabled=readingArchives||downloadingArchive;archiveSelect.disabled=readingArchives||downloadingArchive;archiveDownload.disabled=readingArchives||downloadingArchive||!archiveSelect.value;
  for(const b of[ack,refresh,archiveRefresh,archiveDownload]){b.style.opacity=b.disabled?'0.5':'1';b.style.cursor=b.disabled?'not-allowed':'pointer'}
 }
 function take(value){
  const next=valid(value?.transfer)?{...value.transfer}:null;
  if(receipt?.id!==next?.id&&check)check.checked=false;
  receipt=next;paint();
 }
 async function status(){if(busy)return;busy=true;paint();message.textContent='전송 기록 확인 중…';
  try{const r=await D.request('/__lab/files',{method:'GET',cache:'no-store'});take(r);message.textContent='기록 시각 이후에 수정한 파일은 다시 저장하고 내려받아야 합니다.'}
  catch(e){message.textContent='기록을 확인하지 못했습니다. '+String(e.message||e)}finally{busy=false;paint()}
 }
 async function acknowledge(){
  if(busy||downloadingArchive||!receipt||receipt.verifiedAt||!check.checked||expected&&receipt.id!==expected)return;
  const id=receipt.id;busy=true;paint();message.textContent='직접 확인 표시를 저장하는 중…';
  try{const r=await D.request('/__lab/files/ack',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({receiptId:id})});take(r);message.textContent='직접 확인 표시를 저장했습니다. 이후 작업은 다시 저장하고 내려받으세요.'}
  catch(e){message.textContent='표시를 저장하지 못했습니다. 같은 전송 기록으로 다시 확인하세요. '+String(e.message||e)}finally{busy=false;paint()}
 }
 async function loadArchives(){
  if(readingArchives||downloadingArchive)return;readingArchives=true;paint();archiveStatus.textContent='내 자리의 보관본을 확인하는 중…';
  try{
   const r=await D.request('/__lab/checkpoints',{method:'GET',cache:'no-store'});if(!Array.isArray(r?.checkpoints))throw Error('보관본 목록을 읽지 못했습니다.');
   archiveSelect.textContent='';const empty=D.el('option','','보관본을 선택하세요');empty.value='';archiveSelect.append(empty);let count=0;
   for(const c of r.checkpoints){if(!c||typeof c.requestId!=='string'||!UUID.test(c.requestId)||!Number.isFinite(c.at)||!Number.isSafeInteger(c.size)||c.size<0)continue;const option=D.el('option','',time(c.at)+' · '+Math.ceil(c.size/1024)+' KB'+(c.omitted?' · '+c.omitted+'개 제외':''));option.value=c.requestId;archiveSelect.append(option);count++}
   archiveStatus.textContent=count?'모임지기가 만든 저장 파일 보관본입니다. 내려받은 뒤 ZIP을 직접 열어 확인하세요.':'현재 자리에서 내려받을 수 있는 체크포인트가 없습니다.';
  }catch(e){archiveStatus.textContent='보관본을 확인하지 못했습니다. '+String(e.message||e)}finally{readingArchives=false;paint()}
 }
 async function downloadArchive(){
  const id=archiveSelect.value;if(readingArchives||downloadingArchive||!UUID.test(id))return;downloadingArchive=true;paint();archiveStatus.textContent='선택한 보관본의 내려받기를 준비하는 중…';
  try{
   const r=await D.request('/__lab/export',{method:'POST',cache:'no-store',headers:{'content-type':'application/json'},body:JSON.stringify({checkpointId:id})},300000);
   if(typeof r?.ticket!=='string'||!/^[-\w]{24}$/.test(r.ticket)||!UUID.test(r.receiptId))throw Error('내려받기 응답을 확인하지 못했습니다.');
   expected=r.receiptId;check.checked=false;const a=D.el('a');a.href='/__lab/export/'+encodeURIComponent(r.ticket);a.download=r.name||'checkpoint.zip';document.body.append(a);a.click();a.remove();
   archiveStatus.textContent='브라우저 다운로드 목록을 확인하세요. 실습실 안의 보관본은 남아 있으며, 모임 종료 시 함께 삭제됩니다.';
  }catch(e){archiveStatus.textContent='내려받기 결과 확인 필요 · '+String(e.message||e)+' 자동으로 다시 요청하지 않습니다.'}finally{downloadingArchive=false;paint()}
 }
 button.onclick=()=>{
  if(!dialog){
   dialog=D.el('dialog','box-sizing:border-box;width:min(520px,calc(100vw - 32px));max-height:calc(100vh - 48px);overflow:auto;padding:24px;border:1px solid #475569;border-radius:12px;background:#1f2937;color:#f3f4f6;font:15px/1.6 system-ui,sans-serif');
   const heading=D.el('h2','font-size:19px;margin:0 0 12px','내 파일 보존 확인');heading.id='lab-files-title';dialog.setAttribute('aria-labelledby',heading.id);
   const intro=D.el('p','','먼저 편집기에서 파일을 저장하고, 내 작업 받기로 ZIP을 내려받으세요. 다운로드 폴더에서 ZIP을 직접 열어 필요한 파일이 들어 있는지 확인한 뒤 표시해주세요.');
   summary=D.el('p');summary.setAttribute('role','status');summary.setAttribute('aria-live','polite');
   check=D.el('input');check.type='checkbox';check.id='lab-files-inspected';check.style.cssText='width:auto;margin:0 8px 0 0';check.onchange=paint;
   const label=D.el('label','display:flex;align-items:flex-start;padding:12px 0');label.htmlFor=check.id;label.append(check,D.el('span','','내려받은 ZIP을 직접 열어 필요한 파일을 확인했습니다.'));
   ack=D.el('button',D.BTN+';padding:10px 14px;white-space:normal;background:#1d4ed8;color:#fff','직접 확인 표시 저장');ack.onclick=acknowledge;
   refresh=D.el('button',D.BTN+';padding:10px 14px;margin:8px 0;white-space:normal','전송 상태 다시 확인');refresh.onclick=status;
   const archives=D.el('details','margin:16px 0;border-top:1px solid #475569;padding-top:12px');archives.append(D.el('summary','','이전 체크포인트 내려받기'));
   archiveRefresh=D.el('button',D.BTN+';padding:10px 14px;margin:8px 0;white-space:normal','내 자리 체크포인트 목록 확인');archiveRefresh.onclick=loadArchives;
   archiveSelect=D.el('select','display:block;width:100%;max-width:100%;font:inherit;padding:8px;margin:8px 0;background:#111827;color:#f3f4f6');archiveSelect.setAttribute('aria-label','내려받을 체크포인트');archiveSelect.onchange=paint;
   const initial=D.el('option','','먼저 목록을 확인하세요');initial.value='';archiveSelect.append(initial);
   archiveDownload=D.el('button',D.BTN+';padding:10px 14px;white-space:normal','선택한 보관본 내려받기');archiveDownload.onclick=downloadArchive;
   archiveStatus=D.el('p');archiveStatus.setAttribute('role','status');archives.append(archiveRefresh,archiveSelect,archiveDownload,archiveStatus);
   const close=D.el('button',D.BTN+';padding:10px 14px;margin:8px;white-space:normal','닫기');close.onclick=()=>dialog.close();
   message=D.el('p');message.setAttribute('role','status');
   dialog.append(heading,intro,summary,label,ack,refresh,close,message,archives,D.el('p','','실습실 안의 체크포인트도 모임 종료 시 함께 삭제됩니다. 이 표시는 참여자의 직접 확인 기록이며, 이후 수정 내용이나 내 PC의 저장 상태를 자동 검사하지 않습니다.'));document.body.append(dialog);
  }
  if(!dialog.open)dialog.showModal();paint();status();
 };
 const ui={take,download:id=>{if(typeof id==='string'&&UUID.test(id)){expected=id;if(check)check.checked=false;paint()}},fold:value=>{button.style.display=value?'none':''}};
 try{ui.fold(localStorage.getItem('labBarFolded')==='1')}catch{}
 return ui;
}
`;
