// 모임지기 화면 모아보기와 참여자 동의 기반 탭 지원. 실제 영상은 Realtime SFU, 제어는 짧은 수명의 입력 큐.
import { LAB_MEDIA_METER_JS } from '#lab-media-meter';

export const LAB_LIVE_TEACHER_JS = String.raw`
${LAB_MEDIA_METER_JS}
const LIVE_STYLE='.lab-live-root{color:var(--fg,#1c1c1a)}.lab-live-root h2{font-size:16px;font-weight:700;letter-spacing:-.02em;margin:16px 0 8px}.lab-live-root .lab-live-grid{align-items:start}.lab-live-root .lab-live-seat{min-width:0}.lab-live-root .lab-live-seat h3{margin:0;font-size:16px;font-weight:700;letter-spacing:-.02em}.lab-live-root .lab-live-state{margin:4px 0 0;font-size:14px}.lab-live-root .lab-live-state[data-hand="1"]{color:var(--bad,#c23b2e);font-weight:700}.lab-live-root .lab-live-wait{margin:8px 0 0;padding:10px 12px;border:1px solid var(--line,#e3e3de);border-radius:8px;background:var(--bg,#f7f7f5);color:var(--mut,#6b6b66);font-size:14px}.lab-live-root video{display:block;width:100%;aspect-ratio:16/9;object-fit:contain;background:#141413;border-radius:8px;max-height:min(75vh,420px);margin-top:8px}.lab-live-root .lab-live-seat.expanded video{max-height:75vh}.lab-live-root .lab-live-primary,.lab-live-root .lab-live-tools{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0 0}.lab-live-root .lab-live-primary button,.lab-live-root .lab-live-tools button,.lab-live-root .lab-live-endbar button,.lab-live-root .lab-live-support button{width:auto;min-height:44px;padding:8px 12px;justify-self:start}.lab-live-root .lab-live-support{display:grid;gap:8px;margin-top:12px;padding-top:12px;border-top:1px solid var(--line,#e3e3de)}.lab-live-root .lab-live-meta,.lab-live-root .lab-live-consent{margin:0;font-size:14px;color:var(--mut,#6b6b66)}.lab-live-root .lab-live-consent[data-kind="active"]{color:var(--fg,#1c1c1a);font-weight:700}.lab-live-root .lab-live-consent[data-kind="expired"],.lab-live-root .lab-live-consent[data-kind="revoked"],.lab-live-root .lab-live-consent[data-kind="unknown"]{color:var(--bad,#c23b2e)}.lab-live-root details{margin-top:8px}.lab-live-root details:not([open]) > :not(summary){display:none !important}.lab-live-root summary{cursor:pointer;font-weight:600;min-height:44px;display:flex;align-items:center}.lab-live-root .lab-live-endbar{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin:0 0 12px;padding:10px 12px;border:1px solid var(--bad,#c23b2e);border-radius:12px;background:var(--card,#fff)}.lab-live-root .lab-live-endbar p,.lab-live-root .lab-live-empty{margin:0}.lab-live-root .lab-live-endbar p{flex:1 1 220px}.lab-live-root .lab-live-empty{margin:8px 0}.lab-live-root [hidden]{display:none !important}.lab-live-root textarea{caret-color:var(--fg,#1c1c1a)}.lab-live-root :focus-visible{outline:2px solid var(--acc,#2f5bea);outline-offset:2px}.lab-live-root p,.lab-live-root h2,.lab-live-root h3{overflow-wrap:anywhere}';
function createLabLiveTeacher(D){
 const rx=createLabMediaMeter('inbound-rtp'),tx=createLabMediaMeter('outbound-rtp'),viewerTab=crypto.randomUUID();let focused=null,supportSeat=null,qRevision=0,qAt=0,qWanted='',qError=null,usageTimer=0;
 const root=D.root, rooms=new Map(), meta=new Map(), progress=new Map(), seenHands=new Map(), labNames=new Map();let enabled=false,confirmed=false,timer=0,busy=false,again=false,generation=0,last=0,skew=0,revClock=0,roomMode='all',desiredRoom=null,pollSeen=false,pendingOpen=null,controlGate=null,requestFlight=0,helpQueue=[],helpSeq=0,helpArmed=false,autoMark=false,focusKey='',queueSent=-1;
 function session(value){if(confirmed!==value){confirmed=value;D.onSession?.()}}
 const el=(t,text)=>{const n=document.createElement(t);if(text!==undefined)n.textContent=text;return n};
 root.classList.add('lab-live-root');
 const style=el('style');style.dataset.liveStyle='1';style.textContent=LIVE_STYLE;
 const hint=el('p','모임 화면 세션을 확인하는 중…');hint.setAttribute('role','status');
 const usage=el('p');usage.className='mut';usage.dataset.liveUsage='';
 const usageNote=el('p','이 탭의 영상만 집계합니다. 새로고침 시 초기화되며 Cloudflare 청구량과는 다릅니다.');usageNote.className='mut';usageNote.style.fontSize='12px';
 const banner=el('div');banner.className='lab-live-endbar';banner.hidden=true;banner.setAttribute('role','status');
 const bannerText=el('p');banner.append(bannerText);
 const empty=el('p');empty.className='lab-live-empty';empty.dataset.liveEmpty='1';empty.hidden=true;
 const endBtn=D.btn('제어 끝내기','bad',()=>{});endBtn.type='button';endBtn.hidden=true;banner.append(endBtn);
 const metrics=el('details');metrics.className='live-metrics';metrics.append(el('summary','영상 연결·사용량'),usage,usageNote);root.append(style,hint,banner,empty,metrics);
 const channelKey=s=>s.id+'/'+s.n;
 function paintUsage(){const r=rx.read(),t=tx.read();usage.textContent='참여자 영상 수신 '+labMediaSummary(r)+' / 모임지기 영상 송신 '+labMediaSummary(t);for(const room of rooms.values())for(const s of room.seats.values())paintQuality(s)}
 async function sampleUsage(){clearTimeout(usageTimer);if(!enabled)return;const gen=generation;await Promise.all([rx.sample(),tx.sample()]);if(gen!==generation||!enabled)return;paintUsage();usageTimer=setTimeout(sampleUsage,5000)}
 function focusPayload(){return !document.hidden&&focused&&focused.pc&&focused.sharing&&!focused.paused&&focused.sourceV>0?{id:focused.id,n:focused.n,v:focused.sourceV}:null}
 async function sendQuality(force=false){if(!enabled)return;const focus=focusPayload(),wanted=focus?JSON.stringify(focus):'';
  if(!force&&wanted===qWanted&&(!qError&&!focus||Date.now()-qAt<5000))return;
  const revision=++qRevision,gen=generation;qAt=Date.now();qWanted=wanted;
  try{await call('quality',{viewerTab,revision,at:Math.round(Date.now()+skew),focus});if(gen===generation&&revision===qRevision)qError=null}
  catch(e){if(gen===generation&&revision===qRevision)qError=e.message}
  if(gen===generation)paintUsage();
 }
 let focusRevision=0;
 function plainWho(s){const m=metaOf(s);if(m&&typeof m.who==='string')return m.who;return s.who||''}
 function seatLabel(s){const who=plainWho(s),seat=s.n+'번 좌석';return who?who+' · '+seat:seat}
 function focusView(){const s=focused;if(!s)return null;const m=metaOf(s);return {id:s.id,n:s.n,who:plainWho(s),hand:m&&m.hand||null,automatic:!!(autoMark&&supportSeat===s),support:supportSeat===s}}
 function emitFocus(){const next=focusView(),key=next?JSON.stringify(next):'';if(key===focusKey)return;focusKey=key;D.onFocus?.(next)}
 function keepFocus(previous){const active=document.activeElement,inSeat=n=>!!(n&&n.closest&&(n.closest('.lab-live-seat')||n.closest('.lab-live-root')));
  if(previous&&previous!==document.body&&previous!==document.documentElement&&previous.isConnected){if(active!==previous){try{previous.focus({preventScroll:true})}catch{}}if(document.activeElement!==previous&&inSeat(document.activeElement)){try{document.activeElement.blur()}catch{}}return}
  if(inSeat(active)){try{active.blur()}catch{}}}
 function selectDetail(s){if(focused===s)return;focusRevision++;const previous=document.activeElement;const old=focused;focused=s;if(s&&s.more&&!D.stage)s.more.open=true;
  for(const item of [old,s])if(item){const big=item===s;item.box.classList.toggle('expanded',big);item.box.style.gridColumn=big?'1 / -1':'';if(D.stage){if(big){item.home.hidden=false;D.stage.append(item.box)}else{item.home.before(item.box);item.home.hidden=true}if(item.sharing)item.video.play().catch(()=>{})}refresh(item)}
  keepFocus(previous);emitFocus();sendQuality(true);paintUsage();
 }
 function paintQuality(s){if(!s.info)return;const r=rx.read(channelKey(s));let mode=s.actualQuality==='detail'?'선명한 화면':s.actualQuality==='preview'?'모아보기':'화질 확인 중';
  if(focused===s&&s.sharing&&!s.paused&&s.actualQuality!=='detail')mode='선명한 화면 전환 중';
  if(focused===s&&qError)mode='화질 전환 확인 필요';
  s.info.textContent=mode+' · '+(s.pc?'수신 '+labMediaSummary(r):(r.known?'누적 수신 '+labMediaBytes(r.bytes)+' · ':'')+'연결 없음');s.info.title=qError&&focused===s?qError:'이 탭에서 받은 영상 데이터입니다. 통신 헤더와 다른 시청자의 사용량은 포함하지 않습니다.';
 }
 const call=(action,body={})=>{let wait;const work=Promise.resolve().then(()=>D.call('/api/lab/live/'+action,body)).finally(()=>clearTimeout(wait));const raced=Promise.race([work,new Promise((_,rej)=>{wait=setTimeout(()=>rej(Object.assign(Error('응답 시간 초과'),{status:0})),10000)})]);work.catch(()=>{});return raced};
 const message=(s,text)=>{s.msg.textContent=text};
 function liveControl(s){return s.control?.state==='active'&&s.control.requestId!==s.blocked&&Date.now()+skew<s.control.expiresAt}
 function pendingControl(s){return s.control?.state==='requested'&&s.control.requestId!==s.blocked&&Date.now()+skew<s.control.expiresAt}
 function framesLive(s){return !s.video.paused&&!s.video.ended&&s.video.readyState>=2&&Date.now()-(s.mediaAt||0)<15000}
 function canInput(s){return enabled&&s.capable&&!!s.pc&&framesLive(s)&&liveControl(s)&&Date.now()-last<8000}
 function stamp(t){return typeof t==='number'&&Number.isFinite(t)&&t>0}
 function freshAt(t){return stamp(t)&&t<=Date.now()+skew&&Date.now()+skew-t<=5*60e3}
 function fmt(t){try{return new Date(t).toLocaleString('ko-KR',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})}catch{return ''}}
 function dur(sec){sec=Math.max(0,Math.floor(Number(sec)||0));if(sec<60)return '1분 미만';if(sec<3600)return Math.floor(sec/60)+'분';return Math.floor(sec/3600)+'시간 '+(Math.floor(sec/60)%60)+'분'}
 function ago(t){const s=Math.floor((Date.now()+skew-t)/1000);return !Number.isFinite(s)?'':s<60?'방금':dur(s)+' 전'}
 function metaOf(s){const seats=meta.get(s.id);return seats&&seats.get(s.n)||null}
 function seatName(s){return seatLabel(s)}
 function roomVisible(id){return roomMode==='all'||desiredRoom===id}
 function showTerminate(s){if(s.uncertain||s.endFlight&&s.held)return true;if(s.control&&(s.control.state==='active'||s.control.state==='requested')&&s.control.requestId!==s.blocked&&Date.now()+skew<s.control.expiresAt)return true;return !s.sharing&&!!s.held&&(s.held.state==='active'||s.held.state==='requested')&&Date.now()+skew<s.held.expiresAt}
 function consentSeat(){for(const r of rooms.values())for(const s of r.seats.values())if(showTerminate(s))return s;return null}
 function connectionText(s){const m=metaOf(s);if(s.paused)return '영상 보기를 멈춘 상태';if(s.sharing&&s.pc&&!framesLive(s))return '화면 연결됨 · 최신 화면 대기';if(s.sharing&&s.pc)return '화면 연결됨';if(s.sharing)return '화면 연결 중';if(!m||!m.presence)return m&&m.opened?'화면 연결 대기':'입장 여부 확인 안 됨';
  const p=m.presence.state;if(p==='offline')return '현재 오프라인'+(stamp(m.presence.lastSeen)?' · '+ago(m.presence.lastSeen):'');if(p==='none'&&!m.opened)return '입장 전';if(p==='active'||p==='away'||p==='none'||m.opened)return '화면 연결 대기';return '화면 연결 대기'}
 function stateLine(s){const m=metaOf(s),parts=[];if(m&&m.hand)parts.push('손 듦');if(s.uncertain)parts.push('제어 종료 확인 필요');else if(liveControl(s)||s.verdict==='active'&&showTerminate(s))parts.push('제어 중');else if(pendingControl(s)||s.verdict==='requested'&&showTerminate(s))parts.push('제어 허용 대기');else if(s.verdict==='unknown')parts.push('제어 상태 확인 안 됨');parts.push(connectionText(s));return parts.join(' · ')}
 function consentLine(s){if(s.uncertain)return '종료 확인 필요 · 다른 참여자 제어를 시작하지 않습니다';if(pendingControl(s)||s.verdict==='requested'&&showTerminate(s))return '요청됨 · 참여자의 허용을 기다리는 중';if(liveControl(s)||s.verdict==='active'&&showTerminate(s))return '제어 중 · 참여자가 허용한 동안만 입력합니다';if(s.verdict==='expired')return '만료됨 · 새 입력은 보내지 않습니다';if(s.verdict==='revoked')return '종료됨 · 거절·철회·종료 이후에는 입력을 보내지 않습니다';if(s.verdict==='unknown')return '확인 안 됨 · 확인 전에는 새 입력을 보내지 않습니다';return '제어 없음 · 제어 요청은 참여자 허용이 있어야 시작합니다'}
 function consentKind(s){if(s.uncertain||s.verdict==='unknown')return 'unknown';if(s.verdict==='expired'||s.verdict==='revoked')return s.verdict;if(liveControl(s)||s.verdict==='active'&&showTerminate(s))return 'active';if(pendingControl(s)||s.verdict==='requested')return 'requested';return 'none'}
 function prepText(m){const labels={queued:'준비 대기',preparing:'서버 준비 중',ready:'마지막 서버 준비 확인',error:'서버 준비 실패'},p=m&&m.preparation,k=p&&Object.hasOwn(labels,p.state)?p.state:'unknown';
  if(k==='unknown'||k==='ready'&&(!stamp(p.at)||p.at>Date.now()+skew))return '서버 준비 확인 안 됨';
  return labels[k]+(stamp(p.at)&&p.at<=Date.now()+skew?' · '+fmt(p.at)+(k==='ready'&&!freshAt(p.at)?' · 오래된 확인':''):'')}
 function deliveryText(m){const labels={none:'아직 전달 기록 없음',pending:'전달 처리 중',sent:'입력 보냄',unknown:'결과 확인 필요',error:'전달 실패',skipped:'전달 건너뜀'},d=m&&m.delivery,ok=d&&Object.hasOwn(labels,d.status)&&((d.status==='none'||d.status==='unknown')&&d.at===null||stamp(d.at)&&d.at<=Date.now()+skew);
  return '마지막 명령 전달: '+(ok?labels[d.status]+(stamp(d.at)?' · 상태 기록 '+fmt(d.at)+(!freshAt(d.at)?' · 오래된 기록':''):''):'확인 안 됨')}
 function fileText(m){const f=m&&m.files,at=f&&f.at,valid=stamp(at)&&at<=Date.now()+skew,checked=valid&&stamp(f.verifiedAt)&&f.verifiedAt>=at&&f.verifiedAt<=Date.now()+skew;
  return !valid?'ZIP 전송 기록 확인 안 됨':checked?'참여자 직접 확인 표시 · '+fmt(f.verifiedAt):'ZIP 전송 기록 · '+fmt(at)+' · 직접 확인 전'}
 function money(n){return '$'+n.toFixed(2)}
 function usageText(m){if(!m)return '사용액 확인 안 됨';
  if(m.hasDiag){const limitOk=m.dLimit===null||typeof m.dLimit==='number';if(typeof m.dUsage!=='number'||!freshAt(m.dAt)||!limitOk)return '사용액 확인 안 됨'+(stamp(m.dAt)&&m.dAt<=Date.now()+skew?' · 마지막 기준 '+fmt(m.dAt)+' · 오래된 확인':'');
   return '사용액 '+money(m.dUsage)+(m.dLimit===null?' · 한도 없음':' / '+money(m.dLimit))+' · 기준 '+fmt(m.dAt)}
  if(typeof m.usage!=='number')return '사용액 확인 안 됨';
  return '사용액 '+money(m.usage)+(typeof m.limit==='number'?' / '+money(m.limit):'')}
 function paintMeta(s){const m=metaOf(s);if(!s.prep)return;s.prep.textContent=prepText(m);s.delivery.textContent=deliveryText(m);s.files.textContent=fileText(m);s.usageLine.textContent=usageText(m)+(m&&m.error?' · 자리 기록에 오류 표시가 있습니다. 화면 연결과는 별개입니다.':'');s.presence.textContent=m&&m.presence?presenceText(m):'참여자 상태 기록 없음'}
 function presenceText(m){const p=m.presence;if(!p||!p.state)return '참여자 상태 확인 안 됨';if(p.state==='active')return '활동 중';if(p.state==='away')return '자리 비움'+(p.idleSec!==null?' · '+dur(p.idleSec)+'째':'');if(p.state==='offline')return '현재 오프라인'+(stamp(p.lastSeen)?' · '+ago(p.lastSeen):'');if(p.state==='none')return m.opened?'입장함 · 신호 없음':'입장 전';return '참여자 상태 확인 안 됨'}
 function paint(s){const active=canInput(s),pending=pendingControl(s),supporting=supportSeat===s;paintQuality(s);paintMeta(s);
  const other=consentSeat();s.request.disabled=!!controlGate||requestFlight>0||s.requesting||!s.sharing||!s.capable||liveControl(s)||pending||!!(other&&other!==s);
  s.send.disabled=!active;s.text.disabled=!active;s.form.hidden=!(supporting&&liveControl(s));
  s.support.hidden=!supporting;s.box.dataset.mode=supporting?'support':'watch';s.box.dataset.control=active?'active':pending?'requested':'none';s.box.dataset.consent=consentKind(s);
  s.video.hidden=!s.sharing||!!s.paused;s.video.style.cursor=active?'crosshair':'default';const showWait=supporting&&(!s.sharing||!!s.paused||!s.pc);s.wait.hidden=!showWait;if(showWait)s.wait.textContent=seatName(s)+' · 화면 연결 대기';s.zoom.hidden=!s.sharing;
  s.title.textContent=seatName(s);s.state.textContent=stateLine(s);paintProgress(s);s.homeName.textContent=seatName(s);s.homeState.textContent=stateLine(s);s.homeProgress.textContent=s.progress.textContent;s.state.dataset.hand=metaOf(s)&&metaOf(s).hand?'1':'0';
  s.zoom.textContent=focused===s?'작게 보기':'크게 보기';s.zoom.setAttribute('aria-pressed',String(focused===s));
  s.help.textContent=supporting?'지원 닫기':'도와주기';s.help.setAttribute('aria-pressed',String(supporting));
  s.consent.textContent=consentLine(s);s.consent.dataset.kind=consentKind(s);s.pause.textContent=s.paused?'영상 보기':'영상 보기 멈추기';
  clearTimeout(s.armTimer);const exp=(s.control||s.held)?.expiresAt;if(showTerminate(s)&&Number.isFinite(exp)){const ms=exp-(Date.now()+skew)+40;if(ms>0)s.armTimer=setTimeout(()=>refresh(s),ms)}
  paintEnd()}
 function paintEnd(){const s=consentSeat();if(!s){banner.hidden=true;endBtn.hidden=true;return}
  endBtn.hidden=false;endBtn.disabled=false;endBtn.textContent=s.uncertain?'종료 다시 확인':'제어 끝내기';endBtn.onclick=()=>beginEnd(s);
  const inSupport=supportSeat===s&&roomVisible(s.id)&&!s.support.hidden;const host=inSupport?s.endSlot:banner;if(endBtn.parentElement!==host)host.append(endBtn);
  banner.hidden=!!inSupport;bannerText.textContent=seatName(s)+' · '+(s.uncertain?'제어 종료가 확인되지 않았습니다. 다른 참여자 제어를 시작하지 않습니다. '+s.uncertain.message:'제어를 끝낼 수 있습니다. 화면이 없거나 멈춰도 이 버튼으로 종료합니다.');}
 function speak(s){if(s.uncertain)message(s,'종료 확인 필요 · 이 제어가 끝났는지 확인되기 전에는 다른 참여자 제어를 시작하지 않습니다. '+s.uncertain.message);
  else if(s.endFlight)message(s,'제어 종료를 확인하는 중입니다. 확인 전에는 다른 참여자 제어를 시작하지 않습니다.');
  else if(canInput(s))message(s,'모임지기가 제어 중 · 참여자도 언제든 종료할 수 있습니다.');
  else if(liveControl(s))message(s,'제어는 유지 중입니다. 화면이 멈춰 새 입력은 보내지 않습니다. 제어 끝내기를 누를 수 있습니다.');
  else if(pendingControl(s))message(s,'참여자의 제어 허용을 기다리는 중…');
  else if(s.verdict==='expired')message(s,'제어 시간이 만료됐습니다. 새 입력을 보내지 않습니다.');
  else if(s.verdict==='revoked')message(s,'제어가 끝났습니다. 자동 미리보기는 화면이 연결되어 있으면 계속됩니다.');
  else if(s.verdict==='unknown')message(s,'제어 상태를 확인하지 못했습니다. 확인 전에는 새 입력을 보내지 않습니다.');
  else if(s.paused)message(s,'영상 보기를 멈췄습니다. 다시 보려면 “영상 보기”를 누르세요.');
  else if(!s.sharing)message(s,supportSeat===s?'참여자가 실습실을 열면 화면이 나타납니다. 진행 중인 제어는 화면이 없어도 끝낼 수 있습니다.':'');
  else if(s.pc&&!framesLive(s))message(s,'최신 화면을 기다리는 중 · 참여자가 실습실 탭을 열어 두면 갱신됩니다.');
  else if(!s.capable)message(s,'실습실 화면 연결을 확인하는 중입니다.');
  else message(s,supportSeat===s?'클릭·키보드 입력은 참여자가 허용한 뒤 시작됩니다.':'')}
 function refresh(s){paint(s);speak(s)}
 function mark(s){s.mark=++revClock}
 function keepLocal(s,pollClock){return !!(s.control&&s.mark>pollClock&&s.control.requestId!==s.blocked&&(s.control.state==='active'||s.control.state==='requested')&&Date.now()+skew<s.control.expiresAt)}
 function clearGate(id){if(controlGate?.requestId===id)controlGate=null}
 function adoptControl(s,next,sharing,pollClock){
  if(s.endFlight){s.control=null;return}
  if(s.blocked&&next?.requestId===s.blocked&&(next.state==='active'||next.state==='requested')){s.held={requestId:next.requestId,state:next.state,expiresAt:next.expiresAt};s.control=null;return}
  if(next&&(next.state==='denied'||next.state==='stopped')){s.control=null;s.held=null;s.blocked=null;s.uncertain=null;s.verdict='revoked';clearGate(next.requestId);return}
  if(next&&next.state!=='active'&&next.state!=='requested'){s.control=null;s.verdict='unknown';return}
  if(!next&&keepLocal(s,pollClock))return;
  if(!next&&s.uncertain&&sharing){const id=s.uncertain.requestId;s.control=null;s.held=null;s.blocked=null;s.uncertain=null;s.verdict='revoked';clearGate(id);return}
  if(!next&&!sharing&&s.held&&(s.held.state==='active'||s.held.state==='requested')&&Date.now()+skew<s.held.expiresAt){s.control=null;return}
  if(!next&&s.held&&Date.now()+skew>=s.held.expiresAt&&!s.uncertain){s.verdict='expired';s.control=null;s.held=null;s.blocked=null;if(controlGate&&!controlGate.uncertain)controlGate=null;return}
  if(!next&&s.control&&(s.control.state==='active'||s.control.state==='requested')&&sharing){s.verdict=Date.now()+skew>=s.control.expiresAt?'expired':'revoked';const id=s.control.requestId;s.control=null;s.held=null;s.blocked=null;if(controlGate&&!controlGate.uncertain)clearGate(id);return}
  if(s.blocked&&!next&&sharing&&!s.uncertain&&!s.endFlight){const id=s.blocked;s.blocked=null;s.held=null;s.control=null;s.verdict='revoked';clearGate(id);return}
  s.control=next||null;if(s.control){s.held={requestId:s.control.requestId,state:s.control.state,expiresAt:s.control.expiresAt};s.verdict=s.control.state;s.blocked=null}
 }
 function beginEnd(s){const current=s.control&&(s.control.state==='active'||s.control.state==='requested')?s.control:s.held&&(s.uncertain||Date.now()+skew<s.held.expiresAt)?s.held:null;const requestId=current?.requestId||s.uncertain?.requestId;if(!requestId)return Promise.resolve(true);
  if(s.endFlight&&s.endFlight.requestId===requestId)return s.endFlight.promise;
  s.blocked=requestId;if(current)s.held={requestId,state:current.state||'active',expiresAt:current.expiresAt};s.control=null;mark(s);controlGate={id:s.id,n:s.n,requestId,uncertain:!!s.uncertain};const gen=generation,epoch=++s.endEpoch;
  const p=(async()=>{let err=null;try{await call('release',{id:s.id,n:s.n,requestId})}catch(e){err=e}
   if(gen!==generation||epoch!==s.endEpoch)return false;s.endFlight=null;
   if(!err||err.status===404||err.status===410){s.uncertain=null;s.held=null;s.blocked=null;s.verdict='revoked';clearGate(requestId);message(s,err?'제어 대상을 찾지 못했습니다. 이 자리의 새 입력은 보내지 않습니다.':'제어를 끝냈습니다.');refresh(s);return true}
   s.uncertain={requestId,message:err.message||'응답 없음'};controlGate={id:s.id,n:s.n,requestId,uncertain:true};message(s,'종료 확인 필요 · 이 제어가 끝났는지 확인되기 전에는 다른 참여자 제어를 시작하지 않습니다. '+(err.message||''));refresh(s);return false})();
  s.endFlight={requestId,promise:p};refresh(s);return p}
 function drop(s,notify=true){if(s.pc){const pc=s.pc;s.pc=null;try{rx.remove(pc)}catch{}pc.close();if(notify)call('close',{id:s.id,n:s.n}).catch(()=>{})}s.video.srcObject=null;s.v=-1;s.mediaAt=0;clearTimeout(s.armTimer);clearTimeout(s.wheelTimer);s.wheelTimer=0;s.wheel=null}
 function end(){if(enabled&&qWanted)call('quality',{viewerTab,revision:++qRevision,at:Math.round(Date.now()+skew),focus:null}).catch(()=>{});enabled=false;generation++;clearTimeout(usageTimer);focused=null;supportSeat=null;qWanted='';qError=null;again=false;clearTimeout(timer);controlGate=null;pendingOpen=null;pollSeen=false;roomMode='all';desiredRoom=null;meta.clear();helpQueue=[];seenHands.clear();labNames.clear();helpArmed=false;autoMark=false;focusKey='';queueSent=-1;
  for(const r of rooms.values())for(const s of r.seats.values()){drop(s,false);s.box.remove()}rooms.clear();progress.clear();D.stage?.replaceChildren();D.broadcast?.replaceChildren();D.onFocus?.(null);D.onHelpQueue?.(0);queueSent=0;banner.hidden=true;endBtn.hidden=true;banner.append(endBtn);empty.hidden=true;root.replaceChildren(style,hint,banner,empty,metrics);rx.clear();tx.clear();paintUsage();root.hidden=true;document.body.classList.remove('lab-live-open');D.ended?.();session(false)}
 async function input(s,event){if(!canInput(s))return;
  const requestId=s.control.requestId,eventId=crypto.randomUUID(),gen=generation;
  // 입력 순서를 보존한다. 결과를 모르면 다음 입력을 보내지 않고 제어를 끝낸다.
  s.queue=s.queue.then(async()=>{if(gen!==generation||!canInput(s)||s.control?.requestId!==requestId)return;
   try{await call('input',{id:s.id,n:s.n,requestId,eventId,event})}catch(e){if(gen!==generation)return;s.blocked=requestId;s.control=null;if(s.held?.requestId!==requestId)s.held={requestId,state:'active',expiresAt:Date.now()+skew+300000};mark(s);controlGate={id:s.id,n:s.n,requestId,uncertain:false};refresh(s);message(s,'입력 결과 확인 필요 · '+e.message);
    try{await call('release',{id:s.id,n:s.n,requestId});if(gen!==generation)return;s.blocked=null;s.held=null;s.uncertain=null;s.verdict='revoked';clearGate(requestId);message(s,'입력 결과 확인 필요 · 제어를 끝냈습니다. '+e.message);refresh(s)}
    catch(err){if(gen!==generation)return;s.uncertain={requestId,message:err.message||e.message};controlGate={id:s.id,n:s.n,requestId,uncertain:true};message(s,'종료 확인 필요 · 이 제어가 끝났는지 확인되기 전에는 다른 참여자 제어를 시작하지 않습니다. '+(err.message||''));refresh(s)}}
  });
 }
 function coords(s,e){const r=s.video.getBoundingClientRect(),vw=s.video.videoWidth,vh=s.video.videoHeight;if(!vw||!vh)return null;
  const scale=Math.min(r.width/vw,r.height/vh),w=vw*scale,h=vh*scale,x=(e.clientX-r.left-(r.width-w)/2)/w,y=(e.clientY-r.top-(r.height-h)/2)/h;
  return x>=0&&x<=1&&y>=0&&y<=1?{x,y,width:s.width,height:s.height}:null;
 }
 function closeSupport(s){if(supportSeat===s)supportSeat=null;if(s){s.support.hidden=true;s.box.dataset.mode='watch';refresh(s)}}
 function openSupport(s){autoMark=false;dequeueHelp(s.id,s.n);publishQueue();supportSeat=s;s.support.hidden=false;s.box.dataset.mode='support';if(focused!==s)selectDetail(s);else{refresh(s);emitFocus()}s.title.tabIndex=-1;try{s.title.focus({preventScroll:true});if(!D.stage)s.box.scrollIntoView({block:'start'})}catch{}}
 function seat(r,x){let s=r.seats.get(x.n);if(s)return s;
  s={id:r.id,n:x.n,v:-1,pc:null,control:null,queue:Promise.resolve(),pending:null,blocked:null,requesting:false,sharing:false,capable:false,who:'',verdict:'none',held:null,uncertain:null,endFlight:null,endEpoch:0,reqEpoch:0,mark:0,boundV:0};r.seats.set(x.n,s);
  s.box=el('section');s.box.className='lab-live-seat';s.box.dataset.liveSeat=String(x.n);s.box.dataset.mode='watch';
  s.home=el('div');s.home.className='lab-live-home';s.home.hidden=true;s.home.dataset.liveHome=String(x.n);s.homeName=el('strong');s.homeState=el('p');s.homeProgress=el('p');const homeButton=D.btn('중앙에서 보는 중','sec',()=>openSupport(s));s.home.append(s.homeName,s.homeState,s.homeProgress,homeButton);
  s.progress=el('p');s.progress.className='lab-live-progress';s.progress.dataset.liveProgress='1';
  s.title=el('h3');s.state=el('p');s.state.className='lab-live-state';s.state.dataset.liveState='1';
  s.video=el('video');s.video.autoplay=true;s.video.muted=true;s.video.playsInline=true;s.video.tabIndex=0;s.video.setAttribute('aria-label',x.n+'번 참여자 화면. 제어 허용 후 클릭하거나 키보드를 입력하세요.');s.video.hidden=true;
  s.wait=el('p');s.wait.className='lab-live-wait';s.wait.dataset.liveWait='1';
  const primary=el('div');primary.className='lab-live-primary';
  s.zoom=D.btn('크게 보기','sec',()=>{if(focused===s){if(D.stage)clearFocus();else selectDetail(null);return}const other=consentSeat();if(other&&other!==s)beginEnd(other);if(supportSeat&&supportSeat!==s)closeSupport(supportSeat);selectDetail(s)});s.zoom.type='button';s.zoom.setAttribute('aria-pressed','false');
  s.help=D.btn('도와주기','',()=>{if(supportSeat===s){beginEnd(s);closeSupport(s);if(focused===s)selectDetail(null);return}const other=consentSeat();if(other&&other!==s)beginEnd(other);if(supportSeat&&supportSeat!==s)closeSupport(supportSeat);openSupport(s)});s.help.type='button';s.help.setAttribute('aria-pressed','false');
  primary.append(s.zoom,s.help);
  s.support=el('div');s.support.className='lab-live-support';s.support.dataset.liveSupport='1';s.support.hidden=true;
  s.presence=el('p');s.presence.className='lab-live-meta';s.consent=el('p');s.consent.className='lab-live-consent';s.consent.dataset.liveConsent='1';
  s.endSlot=el('div');s.endSlot.className='lab-live-tools';
  s.request=D.btn('제어 요청','sec',async()=>{if(s.request.disabled||s.requesting||requestFlight||controlGate||supportSeat!==s)return;s.requesting=true;requestFlight++;const gen=generation,epoch=++s.reqEpoch;refresh(s);
   if(!s.pending)s.pending=crypto.randomUUID();const requestId=s.pending;let failed=null;
   try{await call('request',{id:s.id,n:s.n,requestId});
    if(gen!==generation||epoch!==s.reqEpoch||supportSeat!==s||!roomVisible(s.id)){s.pending=null;s.blocked=requestId;s.held={requestId,state:'requested',expiresAt:Date.now()+skew+300000};mark(s);
     try{await call('release',{id:s.id,n:s.n,requestId});if(gen===generation&&epoch===s.reqEpoch){s.blocked=null;s.held=null;s.verdict='revoked';clearGate(requestId)}}
     catch(e){if(gen!==generation||epoch!==s.reqEpoch)return;s.uncertain={requestId,message:e.message||'응답 없음'};controlGate={id:s.id,n:s.n,requestId,uncertain:true};message(s,'종료 확인 필요 · 이 제어가 끝났는지 확인되기 전에는 다른 참여자 제어를 시작하지 않습니다. '+(e.message||''));refresh(s)}
     return}
    s.pending=null;s.control={state:'requested',requestId,expiresAt:Date.now()+skew+300000};s.held={...s.control};s.verdict='requested';mark(s);poll()}
   catch(e){failed=e}finally{s.requesting=false;requestFlight=Math.max(0,requestFlight-1);if(gen===generation&&epoch===s.reqEpoch){refresh(s);if(failed)message(s,'요청 결과 확인 필요 · 다시 누르면 같은 요청을 확인합니다. '+failed.message)}}
  });s.request.type='button';
  s.support.append(s.presence,s.consent,s.endSlot,s.request);
  const form=el('form'),label=el('label','한글·긴 문장은 아래에 적어 보내세요');s.text=el('textarea');s.text.maxLength=1000;s.text.rows=2;s.text.style.cssText='box-sizing:border-box;width:100%;font:inherit;padding:8px;background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:8px';label.append(s.text);
  s.send=D.btn('입력 보내기','sec',()=>{});s.send.type='submit';form.append(label,s.send);form.hidden=true;s.form=form;form.onsubmit=e=>{e.preventDefault();if(canInput(s)&&s.text.value){input(s,{kind:'text',text:s.text.value});s.text.value=''}};
  s.support.append(form);
  s.more=el('details');const summary=el('summary','연결·기록');s.more.append(summary);
  s.info=el('p');s.info.className='mut';s.info.dataset.liveMedia='';s.info.style.fontSize='12px';
  s.prep=el('p');s.prep.className='mut';s.prep.dataset.livePrep='1';s.prep.title='서버 준비 상태입니다. 연결되었거나 준비가 확인됐다는 사실로 학습 진행을 판단하지 않습니다.';
  s.delivery=el('p');s.delivery.className='mut';s.delivery.dataset.liveDelivery='1';s.delivery.title='수업 터미널 입력 전달 기록입니다. 프로그램 완료나 결과 정확성을 뜻하지 않습니다.';
  s.files=el('p');s.files.className='mut';s.files.dataset.liveFiles='1';s.files.title='전송과 참여자의 ZIP 직접 확인 기록입니다. 확인 시각 이후의 파일까지 검사하지는 않습니다.';
  s.usageLine=el('p');s.usageLine.className='mut';s.usageLine.dataset.liveSpend='1';s.usageLine.title='수업 한도 기록입니다. 이 탭의 영상 수신량이나 Cloudflare 청구액이 아닙니다.';
  const tools=el('div');tools.className='lab-live-tools';
  s.retry=D.btn('영상 다시 연결','sec',()=>{drop(s);refresh(s);poll()});s.retry.type='button';
  s.pause=D.btn('영상 보기 멈추기','sec',()=>{s.paused=!s.paused;if(s.paused){beginEnd(s);drop(s)}refresh(s);poll()});s.pause.type='button';
  tools.append(s.retry,s.pause);s.more.append(s.info,s.prep,s.delivery,s.files,s.usageLine,tools);
  s.msg=el('p');s.msg.className='mut';s.msg.setAttribute('role','status');
  s.video.addEventListener('click',e=>{if(!canInput(s))return;const p=coords(s,e);if(p)input(s,{kind:'click',...p,button:0,count:e.detail>1?2:1})});
  s.video.addEventListener('contextmenu',e=>{if(!canInput(s))return;e.preventDefault();const p=coords(s,e);if(p)input(s,{kind:'click',...p,button:2,count:1})});
  s.video.addEventListener('wheel',e=>{if(!canInput(s))return;e.preventDefault();const p=coords(s,e);if(!p)return;
   const previous=s.wheel;s.wheel={kind:'wheel',...p,dx:Math.max(-2000,Math.min(2000,(previous?.dx||0)+e.deltaX)),dy:Math.max(-2000,Math.min(2000,(previous?.dy||0)+e.deltaY))};
   if(!s.wheelTimer)s.wheelTimer=setTimeout(()=>{s.wheelTimer=0;const value=s.wheel;s.wheel=null;if(value&&canInput(s))input(s,value)},120);
  },{passive:false});
  s.video.addEventListener('keydown',e=>{if(document.activeElement!==s.video||!canInput(s)||e.isComposing||e.key==='Process'||['Control','Alt','Shift','Meta'].includes(e.key))return;e.preventDefault();
   if(e.key.length===1&&!e.ctrlKey&&!e.altKey&&!e.metaKey)input(s,{kind:'text',text:e.key});
   else input(s,{kind:'key',key:e.key,code:e.code,ctrl:e.ctrlKey,alt:e.altKey,shift:e.shiftKey,meta:e.metaKey});
  });
  s.video.addEventListener('pause',()=>{s.mediaAt=0;refresh(s)});
  s.video.addEventListener('ended',()=>{s.mediaAt=0;refresh(s)});
  s.video.addEventListener('playing',()=>{if(s.video.readyState>=2)s.mediaAt=Date.now();refresh(s)});
  s.video.addEventListener('timeupdate',()=>{if(s.video.paused||s.video.readyState<2)return;const was=canInput(s);s.mediaAt=Date.now();if(was!==canInput(s))refresh(s)});
  s.box.append(s.title,s.state,s.progress,s.video,s.wait,primary,s.support,s.more,s.msg);r.grid.append(s.box,s.home);return s;
 }
 function alive(s,pc,gen){return gen===generation&&s.pc===pc&&roomVisible(s.id)}
 async function connect(s,x){if(!roomVisible(s.id)||s.paused)return;if(s.connecting||s.pc&&s.v===x.v)return;if([...rooms.values()].flatMap(r=>[...r.seats.values()]).filter(x=>x.pc).length>=8&&!s.pc){message(s,'동시 영상 8개 상한입니다. 다른 영상을 닫은 뒤 연결하세요.');return}
  drop(s);s.connecting=true;const gen=generation,pc=new RTCPeerConnection({iceServers:[{urls:'stun:stun.cloudflare.com:3478'}],bundlePolicy:'max-bundle'});s.pc=pc;s.v=x.v;rx.add(pc,channelKey(s));
  pc.ontrack=e=>{if(!alive(s,pc,gen))return;try{if(e.receiver&&'jitterBufferTarget'in e.receiver)e.receiver.jitterBufferTarget=0}catch{}s.video.srcObject=e.streams[0]||new MediaStream([e.track]);s.mediaAt=Date.now();s.video.play().catch(()=>{});
   const frame=()=>{if(!alive(s,pc,gen))return;const was=canInput(s);s.mediaAt=Date.now();if(was!==canInput(s))refresh(s);s.video.requestVideoFrameCallback?.(frame)};s.video.requestVideoFrameCallback?.(frame);
  };
  pc.onconnectionstatechange=()=>{if(s.pc!==pc)return;if(pc.connectionState==='failed'){drop(s);refresh(s);message(s,'영상 연결이 끊겼습니다. 다시 연결합니다.')}};
  try{const offer=await call('pull',{id:s.id,n:s.n});if(!alive(s,pc,gen)){if(s.pc===pc)drop(s);return}await pc.setRemoteDescription({type:'offer',sdp:offer.sdp});
   const answer=await pc.createAnswer();if(!alive(s,pc,gen)){if(s.pc===pc)drop(s);return}await pc.setLocalDescription(answer);if(!alive(s,pc,gen)){if(s.pc===pc)drop(s);return}
   await call('answer',{id:s.id,n:s.n,sid:offer.sid,sdp:pc.localDescription.sdp});if(!alive(s,pc,gen)&&s.pc===pc)drop(s);
  }catch(e){if(gen===generation&&s.pc===pc){drop(s);refresh(s);message(s,'영상 연결 실패 · '+e.message)}}finally{s.connecting=false}
 }
 function paintEmpty(){if(roomMode!=='one'){empty.hidden=true;return}const has=!!(desiredRoom&&rooms.has(desiredRoom));if(has){empty.hidden=true;return}empty.hidden=false;empty.textContent=!desiredRoom?'선택한 모임이 없습니다. 다른 모임의 화면에는 연결하지 않습니다.':!pollSeen?'선택한 모임 화면을 확인하는 중…':'이 모임의 실시간 화면이 없습니다. 다른 모임에는 연결하지 않습니다.'}
 function applyRooms(){for(const r of rooms.values()){const on=roomVisible(r.id);r.box.hidden=!on;if(D.broadcast){if(on)D.broadcast.append(r.share);else r.box.insertBefore(r.share,r.grid)}r.title.hidden=roomMode==='one';if(!on){if(focused&&focused.id===r.id)selectDetail(null);if(supportSeat&&supportSeat.id===r.id)supportSeat=null;for(const s of r.seats.values())if(s.pc||s.connecting)drop(s);r.share.replaceChildren()}}paintEmpty()}
 function findSeat(id,n){const r=rooms.get(id);return r&&r.seats.get(n)||null}
 async function poll(){clearTimeout(timer);if(!enabled)return;if(busy){again=true;return}busy=true;again=false;const gen=generation,pollClock=revClock;
  try{const d=await call('status');if(gen!==generation)return;last=Date.now();skew=Number.isFinite(d.now)?d.now-Date.now():0;pollSeen=true;root.hidden=false;document.body.classList.add('lab-live-open');session(true);
   hint.textContent='참여자 화면 · 자동 미리보기';hint.title='화면 지원 세션 '+new Date(d.expiresAt).toLocaleTimeString('ko-KR')+'까지 · 클릭·키보드는 별도 허용 후 시작';
   const seen=new Set();for(const lab of d.labs||[]){if(!lab||typeof lab.id!=='string')continue;seen.add(lab.id);if(typeof lab.name==='string'&&lab.name)labNames.set(lab.id,lab.name);const r=ensureRoom(lab.id,lab.name);
    if(typeof lab.name==='string'&&lab.name)r.title.textContent=lab.name;r.box.hidden=!roomVisible(lab.id);
    if(roomVisible(lab.id))r.share.replaceChildren(D.screenRow(lab));else r.share.replaceChildren();
    for(const x of lab.seats||[]){if(!x||!Number.isInteger(x.n))continue;const s=seat(r,x);if(typeof x.who==='string')s.who=x.who;
     if(x.v&&s.boundV&&x.v!==s.boundV&&showTerminate(s))beginEnd(s);if(x.v)s.boundV=x.v;
     s.sharing=!!x.sharing;s.capable=!!x.capable;s.width=x.width;s.height=x.height;s.sourceV=x.v;s.actualQuality=x.quality;
     adoptControl(s,x.control||null,!!x.sharing,pollClock);
     if(x.sharing&&!s.paused&&roomVisible(r.id))connect(s,x);else drop(s);refresh(s)}
   }
   for(const [id,r]of rooms)if(!seen.has(id)){for(const s of r.seats.values()){if(focused===s)selectDetail(null);if(supportSeat===s)supportSeat=null;if(showTerminate(s))beginEnd(s);drop(s,false)}for(const s of r.seats.values())s.box.remove();r.share.remove();r.box.remove();rooms.delete(id);D.endedLab?.(id)}
   if(focused&&!roomVisible(focused.id))selectDetail(null);
   if(pendingOpen){const p=pendingOpen,s=findSeat(p.id,p.n);if(s&&roomVisible(p.id)){pendingOpen=null;openSupport(s)}}
   applyRooms();drainHelp();sendQuality();
  }catch(e){if(gen!==generation)return;if(e.status===401){end();return}hint.textContent='모임 화면 상태 확인 지연 · '+e.message+' · 진행 중인 제어 종료는 그대로 누를 수 있습니다.';for(const r of rooms.values())for(const s of r.seats.values())refresh(s)}
  finally{busy=false;if(!enabled)return;if(gen!==generation||again){again=false;poll();return}timer=setTimeout(poll,3000)}
 }
 function setMetadata(labs){if(!Array.isArray(labs))return;const next=new Map();
  for(const lab of labs){if(!lab||typeof lab.id!=='string'||!lab.id||!Array.isArray(lab.seats))continue;const seats=new Map();
   for(const seat of lab.seats){if(!seat||!Number.isInteger(seat.n)||seat.n<1)continue;seats.set(seat.n,snapshotMeta(seat))}
   next.set(lab.id,seats);if(typeof lab.name==='string'&&lab.name)labNames.set(lab.id,lab.name)}
  meta.clear();for(const [id,seats]of next)meta.set(id,seats);for(const r of rooms.values())for(const s of r.seats.values())refresh(s);syncHelp();emitFocus()}
 function snapshotMeta(s){const who=typeof s.who==='string'?s.who:'';const hand=typeof s.hand==='number'&&s.hand>0?s.hand:null;const opened=stamp(s.opened)?s.opened:null;
  const raw=s.presence&&typeof s.presence==='object'?s.presence:null;const state=raw&&typeof raw.state==='string'?raw.state:'';
  const presence=raw?{state:['active','away','offline','none'].includes(state)?state:'',idleSec:typeof raw.idleSec==='number'&&raw.idleSec>=0?raw.idleSec:null,lastSeen:stamp(raw.lastSeen)?raw.lastSeen:null}:null;
  const prep=s.preparation&&typeof s.preparation==='object'?{state:typeof s.preparation.state==='string'?s.preparation.state:'',at:stamp(s.preparation.at)?s.preparation.at:null}:null;
  const delivery=s.delivery&&typeof s.delivery==='object'?{status:typeof s.delivery.status==='string'?s.delivery.status:'',at:s.delivery.at===null?null:stamp(s.delivery.at)?s.delivery.at:undefined}:null;
  const files=s.files&&typeof s.files==='object'?{at:stamp(s.files.at)?s.files.at:null,verifiedAt:stamp(s.files.verifiedAt)?s.files.verifiedAt:null}:null;
  const diag=s.diagnostics&&typeof s.diagnostics==='object'?s.diagnostics:null;const hasDiag=!!diag;
  const dUsage=hasDiag&&typeof diag.usage==='number'&&diag.usage>=0?diag.usage:null;const dLimit=hasDiag?(diag.limit===null?null:typeof diag.limit==='number'&&diag.limit>=0?diag.limit:undefined):undefined;const dAt=hasDiag&&stamp(diag.usageAt)?diag.usageAt:null;
  return {who,hand,opened,presence,preparation:prep,delivery,files,hasDiag,dUsage,dLimit,dAt,usage:typeof s.usage==='number'&&s.usage>=0?s.usage:null,limit:typeof s.limit==='number'&&s.limit>=0?s.limit:null,error:s.error===true||typeof s.error==='string'&&!!s.error}}
 function setRoom(id){roomMode='one';const next=typeof id==='string'&&id?id:null;if(desiredRoom===next&&roomMode==='one'){applyRooms();drainHelp();return}
  const victim=consentSeat();if(victim&&victim.id!==next)beginEnd(victim);autoMark=false;if(focused&&focused.id!==next)selectDetail(null);desiredRoom=next;helpQueue=[];helpArmed=false;publishQueue();applyRooms();if(enabled)poll()}
 function selectSeat(id,n){if(typeof id!=='string'||!id||!Number.isInteger(n)||n<1)return;pendingOpen={id,n};
  if(roomMode!=='one'||desiredRoom!==id){const victim=consentSeat();if(victim&&victim.id!==id)beginEnd(victim);autoMark=false;if(focused&&focused.id!==id)selectDetail(null);roomMode='one';desiredRoom=id;helpQueue=[];helpArmed=false;publishQueue();applyRooms();root.dispatchEvent(new CustomEvent('lab-live-room',{bubbles:true,detail:{id}}));if(enabled)poll()}
  const s=findSeat(id,n);if(s&&roomVisible(id)){pendingOpen=null;if(supportSeat!==s){const other=consentSeat();if(other&&other!==s)beginEnd(other);if(supportSeat&&supportSeat!==s)closeSupport(supportSeat);openSupport(s)}}}
  function paintProgress(s){const p=progress.get(s.id+'/'+s.n);s.progress.textContent='';if(p)s.progress.textContent=(p.progress?'본인 표시 '+(p.progress.step+1)+'단계'+(p.progress.completed?' · 완료 표시':''):'진행 표시 없음')+' · 제출 '+(p.submissions||[]).filter(v=>!v.bad).length+'개'}
  function setProgress(id,people){for(const key of progress.keys())if(key.startsWith(id+'/'))progress.delete(key);for(const p of people||[])progress.set(id+'/'+p.n,p);for(const r of rooms.values())for(const s of r.seats.values())paintProgress(s)}
  function clearFocus(){focusRevision++;const s=supportSeat||focused;if(s){beginEnd(s);closeSupport(s)}autoMark=false;if(focused)selectDetail(null);focusKey='';D.onFocus?.(null)}
  function queuedCount(){return roomMode==='one'&&desiredRoom?helpQueue.filter(x=>x.id===desiredRoom).length:0}
  function publishQueue(){const count=queuedCount();if(count===queueSent)return;queueSent=count;D.onHelpQueue?.(count)}
  function dequeueHelp(id,n){helpQueue=helpQueue.filter(x=>!(x.id===id&&x.n===n))}
  function enqueueHelp(id,n,hand){if(!(typeof hand==='number'&&hand>0))return;const cur=helpQueue.find(x=>x.id===id&&x.n===n);if(cur)cur.hand=hand;else helpQueue.push({id,n,hand,seq:++helpSeq});helpQueue.sort((a,b)=>a.hand-b.hand||a.seq-b.seq)}
  function isCurrent(id,n){return !!(focused&&focused.id===id&&focused.n===n)||!!(supportSeat&&supportSeat.id===id&&supportSeat.n===n)}
  function autoAllowed(){if(!enabled||roomMode!=='one'||!desiredRoom)return false;if(typeof D.canAutoOpen==='function'&&D.canAutoOpen()===false)return false;return true}
  function helpBlocked(){return !autoAllowed()||!!focused||!!supportSeat||!!pendingOpen||!!consentSeat()||!!controlGate||requestFlight>0}
  function ensureRoom(id,name){let r=rooms.get(id);if(!r){r={id,seats:new Map(),box:el('section'),grid:el('div'),share:el('div'),title:el('h2',typeof name==='string'?name:'')};rooms.set(id,r);r.box.className='lab-live-room';r.box.dataset.liveRoom=id;r.grid.className='lab-live-grid';r.box.append(r.title,r.share,r.grid);root.append(r.box)}else if(typeof name==='string'&&name)r.title.textContent=name;return r}
  function materializeSeat(id,n){if(typeof id!=='string'||!id||!Number.isInteger(n)||n<1)return null;const r=ensureRoom(id,labNames.get(id)||'');let s=r.seats.get(n);if(!s)s=seat(r,{n});const who=meta.get(id)?.get(n)?.who;if(typeof who==='string'&&who)s.who=who;r.box.hidden=!roomVisible(id);r.title.hidden=roomMode==='one';paintEmpty();return s}
  function baselineRoom(id){const have=meta.get(id)||new Map(),seen=new Map();for(const [n,m] of have)seen.set(n,m.hand||null);seenHands.set(id,seen);helpQueue=helpQueue.filter(x=>x.id!==id)}
  function applyDeltas(id){const have=meta.get(id)||new Map();let seen=seenHands.get(id);if(!seen){seen=new Map();seenHands.set(id,seen)}
   for(const [n,m] of have){const hand=m.hand||null,known=seen.has(n),prev=known?seen.get(n):null;seen.set(n,hand);
    if(!known){if(hand&&!isCurrent(id,n))enqueueHelp(id,n,hand);continue}
    if(prev===hand)continue;if(!hand){dequeueHelp(id,n);continue}if(isCurrent(id,n))continue;enqueueHelp(id,n,hand)}
   for(const n of [...seen.keys()])if(!have.has(n)){seen.delete(n);dequeueHelp(id,n)}}
  // 선택 직후 첫 스냅샷은 기준선이다. 이미 본 손들기 시각은 다시 열지 않는다.
  function syncHelp(){if(!enabled||roomMode!=='one'||!desiredRoom){publishQueue();return}if(!helpArmed){baselineRoom(desiredRoom);helpArmed=true;publishQueue();return}applyDeltas(desiredRoom);publishQueue();drainHelp()}
  function openAutomatic(s){autoMark=true;supportSeat=s;s.support.hidden=false;s.box.dataset.mode='support';if(focused!==s)selectDetail(s);else{refresh(s);emitFocus()}}
  function drainHelp(){if(!helpArmed||helpBlocked()){publishQueue();return}while(helpQueue.length){const item=helpQueue[0];if(item.id!==desiredRoom){helpQueue.shift();continue}const hand=meta.get(item.id)?.get(item.n)?.hand||null;if(hand!==item.hand){helpQueue.shift();continue}const s=materializeSeat(item.id,item.n);if(!s){publishQueue();return}helpQueue.shift();publishQueue();openAutomatic(s);return}publishQueue()}
  async function finishSupport(){const s=supportSeat||focused;if(!s)return;const gen=generation,revision=focusRevision;const ok=await beginEnd(s);if(gen!==generation||revision!==focusRevision||(supportSeat||focused)!==s||ok===false||s.uncertain)return;dequeueHelp(s.id,s.n);closeSupport(s);autoMark=false;if(focused===s)selectDetail(null);else{focusKey='';D.onFocus?.(null)}drainHelp()}
 document.addEventListener('visibilitychange',()=>{if(enabled){sendQuality(true);if(!document.hidden)poll()}});
 addEventListener('pagehide',()=>{if(enabled&&qWanted)fetch('/api/lab/live/quality',{method:'POST',keepalive:true,headers:{'content-type':'application/json'},body:JSON.stringify({viewerTab,revision:++qRevision,at:Math.round(Date.now()+skew),focus:null})}).catch(()=>{})});
 return {start:()=>{const was=enabled;enabled=true;poll();if(!was)sampleUsage()},trackSend:(pc,id)=>tx.add(pc,'broadcast:'+id),untrackSend:pc=>tx.remove(pc),end,call,enabled:()=>enabled,hasSession:()=>confirmed,setMetadata,setRoom,selectSeat,clearFocus,getFocus:()=>focusView(),finishSupport,setProgress,hasSeats:id=>!!rooms.get(id)?.seats.size};
}
`;

export const LAB_LIVE_SEAT_JS = String.raw`
(()=>{
 if(window.__labLiveSeat)return;window.__labLiveSeat=1;
 ${LAB_MEDIA_METER_JS}
 try{if(sessionStorage.getItem('labWatch')==='1')return}catch{}
 const start=()=>{const U=window.__labBarUI;if(!U||!document.body)return setTimeout(start,300);
  const sent=createLabMediaMeter('outbound-rtp');let usageTimer=0,quality='preview',sender=null,qualityJob=Promise.resolve();
  const tab=crypto.randomUUID();let capture=null,stream=null,pc=null,starting=false,closing=false,ended=false,unavailable=false,yielded=false,retryTimer=0,failures=0,gen=0,timer=0,flight=false,control=null,applied=0,ackRequest=null,allowed=null,last=0,blocked=null;
  const el=(t,text)=>{const n=document.createElement(t);if(text!==undefined)n.textContent=text;return n};
  const badge=el('span','실습실 화면 자동 연결 중');badge.dataset.liveAuto='';badge.setAttribute('role','status');badge.style.cssText='padding:3px 7px;color:#d1fae5';badge.title='실습실 안의 화면이 모임지기에게 기본으로 보입니다. 개인 PC의 다른 창은 포함하지 않습니다.';U.box.insertBefore(badge,U.box.lastChild);
  const usageBadge=el('span','송신 측정 중');usageBadge.dataset.liveUsage='';usageBadge.style.cssText='font-size:11px;color:#d1fae5';usageBadge.title='이 탭에서 보낸 영상 데이터입니다. 새로고침 시 초기화되며 Cloudflare 청구량과 다릅니다.';U.box.insertBefore(usageBadge,U.box.lastChild);
  async function sampleSent(){clearTimeout(usageTimer);if(ended)return;await sent.sample();const r=sent.read();usageBadge.textContent=(quality==='detail'?'선명한 화면':'모아보기')+' · 송신 '+labMediaSummary(r);if(!ended)usageTimer=setTimeout(sampleSent,5000)}
  function observedQuality(){try{return capture?.stats?.().quality}catch{return undefined}}
  function setQuality(next){next=next==='detail'?'detail':'preview';if(next===quality)return;quality=next;const g=gen,c=capture,send=sender;
   c?.setQuality?.(next);
   qualityJob=qualityJob.catch(()=>{}).then(async()=>{if(g!==gen||c!==capture||next!==quality||!send)return;try{const p=send.getParameters();if(p.encodings?.length){for(const e of p.encodings){e.maxBitrate=next==='detail'?4000000:400000;e.maxFramerate=next==='detail'?8:2}p.degradationPreference='maintain-resolution';await send.setParameters(p)}}catch{}});
  }
  const banner=el('section');banner.dataset.liveSupport='';banner.style.cssText='position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:2147483647;box-sizing:border-box;width:min(620px,calc(100vw - 16px));padding:12px 16px;background:#f4f7f6;color:#0f172a;border:1px solid #52606d;border-radius:12px;font:16px/1.5 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.2)';banner.hidden=true;
  const status=el('p');status.style.margin='0 0 8px';status.setAttribute('role','status');status.setAttribute('aria-live','polite');
  const allow=el('button','5분 동안 제어 허용'),deny=el('button','거절'),revoke=el('button','제어 즉시 끝내기');
  for(const b of [allow,deny,revoke]){b.type='button';b.style.cssText='font:inherit;min-height:44px;padding:8px 12px;margin:0 8px 0 0;border:1px solid #52606d;border-radius:8px;background:#fff;color:#0f172a;cursor:pointer'}
  banner.append(status,allow,deny,revoke);document.body.append(banner);
  const post=async(action,body={})=>{const c=new AbortController(),t=setTimeout(()=>c.abort(),10000);try{const r=await fetch('/__lab/live/'+action,{method:'POST',cache:'no-store',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:c.signal});const j=await r.json();if(!r.ok)throw Object.assign(Error(j.error||'HTTP '+r.status),{status:r.status});return j}finally{clearTimeout(t)}};
  function ownCapture(){try{return !!capture&&capture.stream===stream&&stream?.getVideoTracks()[0]?.readyState==='live'&&capture.isCurrent?.()!==false}catch{return false}}
  function ui(){const fresh=!!control&&control.requestId!==blocked&&Date.now()<control.expiresAt;
   const active=fresh&&control.state==='active'&&allowed===control.requestId&&ownCapture()&&Date.now()-last<3000;
   const requested=fresh&&control.state==='requested';
   const label=unavailable?'실습실 화면 자동 연결을 지원하지 않는 브라우저입니다':ended?'실습실 화면 연결 종료':starting?'실습실 화면 자동 연결 중':stream?'실습실 화면 자동 공유 중':yielded?'다른 실습실 탭의 화면 공유 중':'실습실 화면 자동 재연결 대기';if(badge.textContent!==label)badge.textContent=label;
   banner.hidden=!active&&!requested;
   status.textContent=active?'모임지기가 실습실을 제어 중입니다. 잠시 입력을 멈춰 주세요. 언제든 아래 버튼으로 끝낼 수 있습니다.':requested?'모임지기가 잠시 실습실의 클릭·키보드 제어를 요청했습니다. 허용할까요?':'제어가 끝났습니다. 실습실 자동 미리보기는 계속됩니다.';
   allow.hidden=deny.hidden=!requested;allow.disabled=!ownCapture();revoke.hidden=!active;
  }
  async function consent(yes){if(!control||control.requestId===blocked)return;const id=control.requestId,g=gen;
   // 허용 클릭이 없으면 어떤 입력도 적용하지 않는다. 거절/철회는 서버 응답 전에 로컬부터 차단.
   if(!yes){blocked=id;allowed=null;control=null;ui()}else if(!ownCapture())return;
   try{await post('consent',{tab,requestId:id,allow:yes});
    if(g!==gen||blocked===id||(yes&&!ownCapture())){allowed=null;blocked=id;if(control?.requestId===id)control=null;if(yes)post('consent',{tab,requestId:id,allow:false}).catch(()=>{});ui();return}
    if(yes){allowed=id;applied=0;ackRequest=id}poll()}catch(e){allowed=null;if(yes)blocked=id;U.note('제어 동의 상태 확인 필요 · '+e.message);ui()}
  }
  allow.onclick=e=>{if(e.isTrusted)consent(true)};deny.onclick=revoke.onclick=()=>consent(false);
  function localStop(){gen++;allowed=null;blocked=null;control=null;applied=0;ackRequest=null;const c=capture,s=stream,p=pc;capture=stream=pc=null;sender=null;quality='preview';starting=false;try{c?.stop()}catch{}try{s?.getTracks().forEach(t=>t.stop())}catch{}try{if(p)sent.remove(p)}catch{}try{p?.close()}catch{}ui()}
  function retry(){clearTimeout(retryTimer);if(!ended&&!yielded)retryTimer=setTimeout(autoStart,Math.min(60000,10000*Math.max(1,++failures)))}
  async function stop(){if(closing)return;closing=true;localStop();try{await post('stop',{tab})}catch(e){U.note('실습실 화면 연결 정리 확인 필요 · '+e.message)}finally{closing=false;retry()}}
  async function autoStart(){if(ended||yielded||stream||starting||closing)return;clearTimeout(retryTimer);
   if(!window.__labDomCapture?.open||!window.RTCPeerConnection){ended=unavailable=true;ui();return}
   starting=true;ui();const g=++gen;let captured;
   let renderer;try{renderer=await window.__labDomCapture.open({quality:'preview',onError:e=>{if(g===gen){U.note('실습실 화면 갱신 실패 · '+(e?.message||'다시 연결합니다'));stop()}}});captured=renderer.stream;
    if(g!==gen){renderer.stop();return}capture=renderer;stream=captured;const track=stream.getVideoTracks()[0];track.contentHint='text';track.onended=()=>{if(stream===captured)stop()};
    pc=new RTCPeerConnection({iceServers:[{urls:'stun:stun.cloudflare.com:3478'}],bundlePolicy:'max-bundle'});const me=pc;sent.add(me,'seat');
    const tr=me.addTransceiver(track,{direction:'sendonly',streams:[stream],sendEncodings:[{maxBitrate:400000,maxFramerate:2}]});sender=tr.sender;
    me.onconnectionstatechange=()=>{if(pc===me&&me.connectionState==='failed'){U.note('실습실 화면 연결을 다시 시도합니다.');stop()}};
    await me.setLocalDescription(await me.createOffer());const r=await post('start',{tab,sdp:me.localDescription.sdp,tracks:[{mid:tr.mid,trackName:'screen'}]});
    if(g!==gen||pc!==me){try{me.close();renderer.stop()}catch{}if(stream===captured)stream=null;if(capture===renderer)capture=null;if(pc===me)pc=null;if(g===gen)starting=false;if(!stream&&!starting)post('stop',{tab}).catch(()=>{});ui();return}
    await me.setRemoteDescription({type:'answer',sdp:r.sdp});try{const p=tr.sender.getParameters();p.degradationPreference='maintain-resolution';await tr.sender.setParameters(p)}catch{}if(g!==gen||pc!==me){if(g===gen)starting=false;if(!stream&&!starting)post('stop',{tab}).catch(()=>{});ui();return}starting=false;failures=0;ui();poll();
   }catch(e){if(renderer&&renderer!==capture)renderer.stop();if(g===gen){localStop();post('stop',{tab}).catch(()=>{});U.note('실습실 화면 자동 연결 실패 · '+e.message);retry()}}
  }
  function targetAt(x,y){let doc=document,node=doc.elementFromPoint(x,y),px=x,py=y;
   for(let i=0;i<8&&node;i++){if(node===banner||banner.contains(node)||U.box.contains(node))return null;
    if(node.shadowRoot){const child=node.shadowRoot.elementFromPoint(px,py);if(child&&child!==node){node=child;continue}}
    if(node.tagName==='IFRAME'){try{const d=node.contentDocument,r=node.getBoundingClientRect();if(d){px-=r.left;py-=r.top;doc=d;node=doc.elementFromPoint(px,py);continue}}catch{}return null}break;
   }return node?{node,x:px,y:py}:null;
  }
  function focused(){let d=document,n=d.activeElement;for(let i=0;i<8&&n;i++){if(n.tagName==='IFRAME'){try{d=n.contentDocument;n=d?.activeElement;continue}catch{return null}}if(n.shadowRoot?.activeElement){n=n.shadowRoot.activeElement;continue}break}return n&&n!==document.body&&!banner.contains(n)&&!U.box.contains(n)?n:null}
  function apply(e){
   if(e.kind==='click'||e.kind==='wheel'){
    if(e.width!==innerWidth||e.height!==innerHeight)return;const target=targetAt(Math.min(innerWidth-1,e.x*innerWidth),Math.min(innerHeight-1,e.y*innerHeight));if(!target)return;
    const n=target.node,w=n.ownerDocument.defaultView,base={bubbles:true,cancelable:true,composed:true,view:w,clientX:target.x,clientY:target.y,button:e.button,buttons:e.button===2?2:1,detail:e.count};
    if(e.kind==='wheel'){n.dispatchEvent(new w.WheelEvent('wheel',{...base,deltaX:e.dx,deltaY:e.dy}));let scroll=n;while(scroll&&scroll.scrollHeight<=scroll.clientHeight)scroll=scroll.parentElement;if(scroll)scroll.scrollBy(e.dx,e.dy);return}
    n.dispatchEvent(new w.PointerEvent('pointerdown',{...base,pointerId:1,pointerType:'mouse',isPrimary:true}));n.dispatchEvent(new w.MouseEvent('mousedown',base));
    if(n.matches('input,textarea,button,select,[contenteditable],a,[tabindex]'))n.focus({preventScroll:true});
    n.dispatchEvent(new w.PointerEvent('pointerup',{...base,buttons:0,pointerId:1,pointerType:'mouse',isPrimary:true}));n.dispatchEvent(new w.MouseEvent('mouseup',{...base,buttons:0}));
    if(e.button===2)n.dispatchEvent(new w.MouseEvent('contextmenu',base));else{n.dispatchEvent(new w.MouseEvent('click',{...base,buttons:0}));if(e.count===2)n.dispatchEvent(new w.MouseEvent('dblclick',{...base,buttons:0}))}return;
   }
   const n=focused();if(!n||n.type==='password'||n.readOnly||n.disabled)return;const d=n.ownerDocument,w=d.defaultView;
   if(e.kind==='text'){
    if(n.editContext&&w.TextUpdateEvent){const ec=n.editContext,a=Math.min(ec.selectionStart,ec.selectionEnd),b=Math.max(ec.selectionStart,ec.selectionEnd),end=a+e.text.length;
     ec.updateText(a,b,e.text);ec.updateSelection(end,end);ec.dispatchEvent(new w.TextUpdateEvent('textupdate',{text:e.text,updateRangeStart:a,updateRangeEnd:b,selectionStart:end,selectionEnd:end}));return;
    }
    if(!n.matches('textarea,input:not([type=password]),[contenteditable=true]'))return;
    if(!d.execCommand('insertText',false,e.text))throw Error('이 입력칸은 원격 텍스트 입력을 지원하지 않습니다.');
   }else if(e.kind==='key'){
    const keys={Enter:13,Tab:9,Backspace:8,Delete:46,Escape:27,ArrowLeft:37,ArrowUp:38,ArrowRight:39,ArrowDown:40,Home:36,End:35,PageUp:33,PageDown:34};
    const k={key:e.key,code:e.code,ctrlKey:e.ctrl,altKey:e.alt,shiftKey:e.shift,metaKey:e.meta,bubbles:true,cancelable:true,composed:true,keyCode:keys[e.key]||e.key.toUpperCase().charCodeAt(0),which:keys[e.key]||e.key.toUpperCase().charCodeAt(0)};
    const handled=!n.dispatchEvent(new w.KeyboardEvent('keydown',k));
    if(!handled&&!e.ctrl&&!e.alt&&!e.meta&&n.matches('textarea,input,[contenteditable=true]')){
     if(e.key==='Backspace')d.execCommand('delete');else if(e.key==='Delete')d.execCommand('forwardDelete');else if(e.key==='Enter'&&n.tagName==='TEXTAREA')d.execCommand('insertText',false,'\n');
    }n.dispatchEvent(new w.KeyboardEvent('keyup',k));
   }
  }
  async function poll(){clearTimeout(timer);if(flight)return;flight=true;const g=gen,wasStarting=starting;
   try{const r=await post('state',{tab,ack:applied,ackRequest,viewport:{capable:ownCapture(),width:innerWidth,height:innerHeight,quality:observedQuality()}});if(g!==gen||wasStarting||starting)return;last=Date.now();
    if(!r.own&&stream){yielded=!!r.sharing;localStop();if(!yielded)retry();return}
    if(r.own&&stream)setQuality(r.quality);
    const next=r.control||null;
    if(blocked&&next?.requestId===blocked&&(next.state==='requested'||next.state==='active')){control=null;allowed=null}
    else{if(!next||next.requestId!==blocked)blocked=null;control=next;
     if(!control||control.state!=='active'||control.requestId!==allowed||Date.now()>=control.expiresAt||!ownCapture()){if(control?.state!=='requested'){allowed=null;applied=0;ackRequest=null}}}
    if(allowed&&control?.state==='active'&&control.requestId===allowed&&blocked!==allowed&&Date.now()<control.expiresAt&&ownCapture()){
     for(const i of control.inputs||[]){if(Date.now()>=control.expiresAt||!ownCapture()||allowed!==control.requestId)break;if(i.seq<=applied)continue;applied=i.seq;try{apply(i.event)}catch(e){allowed=null;blocked=control.requestId;post('consent',{tab,requestId:control.requestId,allow:false}).catch(()=>{});U.note('원격 입력을 멈췄습니다 · '+e.message);break}}
    }ui();
   }catch(e){allowed=null;control=null;ui();if([401,404,410].includes(e.status)){ended=true;clearTimeout(retryTimer);localStop()}}
   finally{flight=false;if(!ended)timer=setTimeout(poll,allowed?250:stream?2000:5000)}
  }
  addEventListener('pagehide',()=>{ended=true;clearTimeout(retryTimer);clearTimeout(timer);clearTimeout(usageTimer);localStop();sent.clear();fetch('/__lab/live/stop',{method:'POST',keepalive:true,headers:{'content-type':'application/json'},body:JSON.stringify({tab})}).catch(()=>{})});
  const foreground=()=>{if(!document.hidden&&!ended){yielded=false;autoStart();poll()}};
  document.addEventListener('visibilitychange',foreground);addEventListener('focus',foreground);
  poll();autoStart();sampleSent();
 };start();
})();
`;
