export const LAB_BROADCAST_PREVIEW_JS=String.raw`
function createLabBroadcastPreview(D){
 const $=id=>document.getElementById(id),root=$('broadcastPreviewStage'),video=$('broadcastPreviewVideo'),status=$('broadcastPreviewStatus'),toggle=$('broadcastPreviewSize'),full=$('broadcastPreviewFull');
 let id=null,source=null,gen=0,timer=0,size='large',reading=false;
 function exitFull(){if(document.fullscreenElement===root)document.exitFullscreen().catch(()=>{})}
 function layout(){const visible=!!source&&D.selected()===id;root.hidden=!visible;const mode=D.workspace();root.hidden=!visible||(size==='small'&&mode!=='home');$('viewRun').dataset.broadcast=visible?size:'';root.dataset.size=size;toggle.textContent=size==='large'?'작게 보기':'크게 보기';$('broadcastPreviewShow').hidden=!source;
  $('broadcastPreviewShow').textContent=id===D.selected()?'내 송출 화면':'공유 중인 모임 화면';if(visible){video.play().catch(()=>{})}else exitFull();
 }
 async function sample(){clearTimeout(timer);if(!source)return;const g=gen,me=source,t=me.s.getVideoTracks()[0],s=t?.getSettings?.()||{};let text='캡처 '+(s.width&&s.height?s.width+' × '+s.height:'크기 확인 중');
  const cap=s.width&&s.height?{width:s.width,height:s.height}:null;let sent=null;
  if(!reading&&!document.hidden){reading=true;try{const reports=await me.pc.getStats();for(const r of reports.values())if(r.type==='outbound-rtp'&&(r.kind==='video'||r.mediaType==='video')&&!r.isRemote&&r.frameWidth&&r.frameHeight)sent={width:r.frameWidth,height:r.frameHeight,fps:r.framesPerSecond}}catch{}finally{if(gen===g)reading=false}}
  if(gen!==g||me!==source)return;text+=' · 송출 '+(sent?sent.width+' × '+sent.height:'크기 확인 중');if(sent?.fps)text+=' · '+Math.round(sent.fps)+'fps';status.textContent=text;root.dataset.capture=cap?cap.width+'x'+cap.height:'';root.dataset.sent=sent?sent.width+'x'+sent.height:'';timer=setTimeout(sample,3000);
 }
 toggle.onclick=()=>{size=size==='large'?'small':'large';exitFull();layout()};full.onclick=()=>{if(!source||root.hidden)return;if(document.fullscreenElement===root){exitFull();return}root.requestFullscreen?.().catch(()=>{status.textContent+=' · 전체 화면을 열지 못했습니다.'})};
 addEventListener('fullscreenchange',()=>{full.textContent=document.fullscreenElement===root?'전체 화면 나가기':'전체 화면'});
 $('broadcastPreviewShow').onclick=()=>{if(!source)return;D.select(id);D.home();size='large';layout()};
 return{attach(room,me){gen++;clearTimeout(timer);id=room;source=me;reading=false;video.srcObject=me.s;size='large';layout();sample()},detach(room){if(id!==room)return;gen++;clearTimeout(timer);exitFull();source=null;id=null;reading=false;video.pause();video.srcObject=null;status.textContent='';root.dataset.capture=root.dataset.sent='';layout()},sync(){layout()},small(){if(source){size='small';exitFull();layout()}}};
}
`;
