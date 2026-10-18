// Local synthetic operator scene. No Cloudflare, Daytona, real keys, or notifications.
import {createServer} from 'node:http';
import {build} from 'esbuild';
import {pathToFileURL} from 'node:url';
import path from 'node:path';

export async function operatorFixture(port=0,{nativeRTC=false,route}={}) {
 // Optional working-tree composition lets the coordinator check independent patches
 // before promotion. Final acceptance always runs again on integrated committed code.
 const workers=process.env.GW_OPERATOR_UX_WORKERS==='1';
 const roots=path.resolve(process.cwd(),'../.worktrees');
 const plugins=workers?[{name:'working-ux-candidates',setup(b){b.onResolve({filter:/^(?:#lab-live|#lab-renderer|\.\/src\/(?:pages|lab-open-pages)\.ts|\.\/pages)$/},a=>{
  const file=a.path==='#lab-live'?['support','src/lablive.ts']:a.path==='#lab-renderer'?['shell','src/lab-renderer.generated.ts']:a.path.includes('lab-open-pages')?['inbox','src/lab-open-pages.ts']:['shell','src/pages.ts'];
  return{path:path.join(roots,'gw-ux-'+file[0]+'-20261016',file[1])};
 })}}]:[];
 const bundled=await build({stdin:{contents:"export {labPage,WEBAUTHN_JS} from './src/pages.ts';export {labOpenManagerPage} from './src/lab-open-pages.ts'",resolveDir:process.cwd()},plugins,bundle:true,write:false,format:'esm',platform:'node',logLevel:'silent'});
 const {labPage,WEBAUTHN_JS,labOpenManagerPage}=await import('data:text/javascript;base64,'+Buffer.from(bundled.outputFiles[0].text).toString('base64'));
 const now=Date.now(),end=now+28800000;
 const mkSeat=(n,who,options={})=>({n,who,state:'started',opened:now-600000,presence:{state:'active',idleSec:0,lastSeen:now},preparation:{state:'ready',at:now},setup:{state:'ok',note:''},delivery:{status:'sent',at:now-60000},files:null,usage:0.03,limit:3,...options});
 const seats=[mkSeat(1,'연습 참여자 가',{hand:now-120000}),mkSeat(2,'연습 참여자 나'),mkSeat(3,'자리 비운 참여자',{presence:{state:'offline',idleSec:600,lastSeen:now-600000}}),mkSeat(4,'입장 전 자리',{opened:0,presence:{state:'none'}}),mkSeat(5,'이름이 아주 긴 연습 참여자 마',{preparation:{state:'unknown',at:null},delivery:{status:'unknown',at:now-30000}})];
 const rooms=[{id:'ux-a',name:'야간 공부방 · 합성 예시',expiresAt:now+3600000,cpu:2,memory:4,disk:5,budget:3,model:'fixture-model',clip:{in:true,out:true},share:[],seats},{id:'ux-b',name:'두 번째 모임 · 합성 예시',expiresAt:now+7200000,cpu:1,memory:2,disk:5,budget:1,model:'fixture-model',clip:{in:true,out:true},share:[],seats:[mkSeat(1,'다른 모임 참여자')]}];
 const requests=[{id:'00000000-0000-4000-8000-000000000001',name:'복습할 참여자',purpose:'메모 두 개로 보고서를 만드는 연습을 해보고 싶어요.',mode:'practice',state:'pending',createdAt:now-180000},{id:'00000000-0000-4000-8000-000000000002',name:'늦게 온 참여자',purpose:'진행 중 모임에 참여하고 싶어요.',mode:'join',state:'pending',createdAt:now-60000}];
 const state={rooms,requests,calls:[],control:new Map(),focus:null,qualityRevision:0,paused:false,revision:1,admin:true,monitor:true,live:true,failList:false,shared:false,demoReady:false};
 const classroom={revision:1,title:'메모 두 개로 5줄 보고서 만들기 · 합성 예시',currentStep:1,mode:'demo',steps:[{id:'read',title:'메모 두 개 읽기',instruction:'두 메모에서 확인된 사실을 찾아보세요.',prompt:'메모 두 개를 읽고 확인된 사실과 요청 사항을 구분해 주세요.'},{id:'draft',title:'AI에게 초안 요청',instruction:'메모 두 개를 근거로 5줄 보고서 초안을 만듭니다.',prompt:'01_요청메모.txt와 02_진행메모.txt를 읽고 결과.txt를 5줄로 작성하세요. 확정된 사실과 검토·제안을 구분하고, 없는 정보는 확인 필요로 남겨 주세요.'},{id:'verify',title:'사실과 제안 구분',instruction:'숫자와 확정 여부를 원문과 대조하세요.',prompt:'정원은 검토 중, 시간은 제안인지 확인하세요.'},{id:'submit',title:'결과물 제출',instruction:'직접 읽고 수정한 결과.txt를 제출하세요.',prompt:'파일을 직접 확인한 뒤 제출하세요.'},{id:'keep',title:'내 컴퓨터에 보관',instruction:'내려받은 결과물을 직접 열어 확인하세요.',prompt:'내 컴퓨터에서 파일을 열고 보관 확인을 표시하세요.'}],materials:[],recordingUrl:'',chapters:[],updatedAt:now};
 const demoFiles=new Map();
 state.addOperations=new Map();state.addHold=null;state.addLost=false;state.addPosts=0;
 const addInfo=id=>{const l=state.rooms.find(l=>l.id===id);return l?{id:l.id,name:l.name,seats:l.seats.length,maxSeats:20,cpu:l.cpu,memory:l.memory,disk:l.disk,budget:l.budget,model:l.model,expiresAt:l.expiresAt,version:'v'.repeat(43),canAdd:l.seats.length<20}:null};
 const classStatus=id=>({classroom,participants:(state.rooms.find(r=>r.id===id)?.seats||[]).map(s=>({n:s.n,who:s.who,progress:{step:s.n===1?0:1,completed:false,updatedAt:now},submissions:[]}))});
 const json=(res,data,status=200)=>res.writeHead(status,{'content-type':'application/json;charset=utf-8','cache-control':'no-store'}).end(JSON.stringify(data));
 const script=`<script>
 window.__fixtureKeyTaps=0;try{Object.defineProperty(navigator.credentials,'get',{configurable:true,value:async()=>{window.__fixtureKeyTaps++;return{id:'synthetic',rawId:new Uint8Array([1]),type:'public-key',response:{clientDataJSON:new Uint8Array([1]),authenticatorData:new Uint8Array([2]),signature:new Uint8Array([3]),userHandle:null},getClientExtensionResults:()=>({})}}})}catch(e){window.__fixtureCredentialError=e.message}
 window.__fixturePeers=[];window.__fixtureScreens=[];
 const canvasStream=(w=1200,h=800)=>{const c=document.createElement('canvas');c.width=w;c.height=h;const g=c.getContext('2d');g.scale(w/1200,h/800);let n=0;const draw=()=>{g.fillStyle='#17212e';g.fillRect(0,0,1200,800);g.fillStyle='#d6deeb';g.font='28px sans-serif';g.fillText('합성 실습 화면 · 실제 참여자 아님',50,65);g.font='24px monospace';['01_요청메모.txt','02_진행메모.txt','','> 메모 두 개로 보고서 5줄 만들기','> 사실과 제안을 구분해서 써 주세요.','','결과.txt','신청 인원: 10명','정원: 12명 검토 중','진행 시간: 40분 제안','참가비: 확인 필요','갱신 '+(++n)].forEach((t,i)=>g.fillText(t,50,125+i*44))};draw();const timer=setInterval(draw,900),stream=c.captureStream(2);stream.getVideoTracks()[0].addEventListener('ended',()=>clearInterval(timer));return stream};
 try{Object.defineProperty(navigator.mediaDevices,'getDisplayMedia',{configurable:true,value:async options=>{window.__fixtureDisplayConstraints=options;const s=canvasStream(options.video.width.ideal||1200,options.video.height.ideal||800);window.__fixtureScreens.push(s);return s}})}catch(e){window.__fixtureDisplayError=e.message}
 if(${nativeRTC?'false':'true'})window.RTCPeerConnection=class{constructor(){this.localDescription={sdp:'synthetic'};this.bytes=0;this.connectionState='connected';window.__fixturePeers.push(this)}async createOffer(){return{type:'offer',sdp:'synthetic'}}async createAnswer(){return{type:'answer',sdp:'synthetic'}}async setLocalDescription(d){this.localDescription=d}async setRemoteDescription(){if(this.ontrack){this.stream=canvasStream();this.ontrack({streams:[this.stream]})}}addTransceiver(track,options){this.sentTrack=track;this.sendOptions=options;return{mid:'0',sender:{getParameters:()=>({}),setParameters:async()=>{}}}}close(){this.closed=true;this.stream?.getTracks().forEach(t=>t.stop())}async getStats(){this.bytes+=25000;return new Map([['video',{id:'video',type:'inbound-rtp',kind:'video',ssrc:1,bytesReceived:this.bytes}],...(this.sentTrack?[['sent',{id:'sent',type:'outbound-rtp',kind:'video',frameWidth:this.sentTrack.getSettings().width,frameHeight:this.sentTrack.getSettings().height,framesPerSecond:2}]]:[])])}};
 </script>`;
 const badge='<aside style="position:fixed;bottom:0;left:0;z-index:9999;background:#fef3c7;color:#422006;padding:3px 10px;font:12px system-ui;pointer-events:none">로컬 합성 예시 · 실제 모임 조작 없음</aside>';
 const html=(body,boot='')=>body.replace('<head>','<head>'+script).replace('</body>',badge+boot+'</body>');
 const bootstrap=`<script>window.__uxReady=(async()=>{await login();if(!adm())throw Error('synthetic login failed');return true})()</script>`;
 const server=createServer(async(req,res)=>{try{
  if(await route?.(req,res,state))return;
  const u=new URL(req.url,'http://127.0.0.1');
  if(req.method==='GET'){
   if(u.pathname==='/lab')return res.writeHead(200,{'content-type':'text/html;charset=utf-8','cache-control':'no-store'}).end(html(labPage(),bootstrap));
   if(u.pathname==='/lab/requests')return res.writeHead(200,{'content-type':'text/html;charset=utf-8','cache-control':'no-store'}).end(html(labOpenManagerPage()));
   if(u.pathname==='/webauthn.js')return res.writeHead(200,{'content-type':'application/javascript'}).end(WEBAUTHN_JS+"\nif(new URL(location.href).searchParams.get('preview')==='1')tapGet=async()=>({id:'synthetic-preview'});");
   if(u.pathname==='/fixture/state')return json(res,{...state,control:[...state.control]});
   return res.writeHead(404).end();
  }
  let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw||'{}');state.calls.push({path:u.pathname,body,at:Date.now()});
  const action=u.pathname.split('/').at(-1);
  if(u.pathname.startsWith('/fixture/')){
   if(action==='consent'){state.control.set(body.id+'/'+body.n,{state:'active',requestId:body.requestId,expiresAt:Date.now()+300000});return json(res,{ok:true})}
   if(action==='empty'){state.rooms=[];return json(res,{ok:true})}
   return json(res,{error:'unknown fixture action'},404);
  }
  if(u.pathname==='/api/admin/options')return json(res,{challenge:'Zml4dHVyZQ',rpId:'localhost',allowCredentials:[]});
  if(u.pathname==='/api/admin/login')return json(res,{token:'synthetic-admin',expiresAt:end});
  if(u.pathname==='/api/lab/admin/session')return json(res,{error:'synthetic restore absent'},401);
  if(u.pathname==='/api/lab/seat-add/status'){
   const info=addInfo(body.id);if(!info)return json(res,{error:'ended'},410);
   const operation=body.requestId?state.addOperations.get(body.requestId):null;
   return json(res,{seatAdd:{...info,...(operation?.seat?{seat:operation.seat}:{})},...(body.requestId?{requestId:body.requestId,creationState:operation?.state||'unknown'}:{})});
  }
  if(u.pathname==='/api/lab/seat-add'){
   if(state.addHold)await state.addHold;
   const info=addInfo(body.id);if(!info)return json(res,{error:'ended'},410);
   let operation=state.addOperations.get(body.requestId);
   if(!operation){state.addPosts++;const lab=state.rooms.find(l=>l.id===body.id),n=Math.max(...lab.seats.map(s=>s.n))+1;lab.seats.push(mkSeat(n,'추가 합성 자리',{opened:0,presence:{state:'none'}}));operation={state:'completed',seat:{n,ready:true,error:null}};state.addOperations.set(body.requestId,operation)}
   if(state.addLost)return json(res,{error:'합성 응답 유실'},503);
   return json(res,{requestId:body.requestId,creationState:operation.state,ok:true,seatAdd:{...addInfo(body.id),seat:operation.seat}});
  }
  if(u.pathname==='/api/lab/invite')return json(res,{n:body.n,name:state.rooms.find(l=>l.id===body.id)?.name,who:'합성 새 참여자',link:'https://lab.example.test/j/synthetic-new-seat',qr:'<svg xmlns="http://www.w3.org/2000/svg"></svg>'});
  if(u.pathname==='/api/lab/classroom/status')return json(res,classStatus(body.id));
  if(u.pathname==='/api/lab/classroom/update'){Object.assign(classroom,body.patch||{},{revision:++classroom.revision});return json(res,classStatus(body.id))}
  if(u.pathname==='/api/lab/classroom/demo/prepare')state.demoReady=true;
  if(u.pathname==='/api/lab/classroom/demo/status'||u.pathname==='/api/lab/classroom/demo/prepare')return json(res,{state:state.demoReady===false?'none':'ready',message:'합성 시연실 · 실제 자원 사용 없음'});
  if(u.pathname==='/api/lab/classroom/demo/open'&&state.demoUrl)return json(res,{url:state.demoUrl});
  if(u.pathname==='/api/lab/classroom/demo/file'){if(typeof body.content==='string')demoFiles.set(body.filename,body.content);return json(res,{file:{filename:body.filename,exists:demoFiles.has(body.filename),content:demoFiles.get(body.filename)||'',hash:'synthetic-hash'}})}
  if(u.pathname==='/api/lab/classroom/demo/send')return json(res,{state:'ready',output:'합성 시연 결과입니다.'});
  if(u.pathname.startsWith('/api/lab/open/manager/')){
   if(action==='session')return json(res,{email:'synthetic@example.test',expiresAt:end});
   if(action==='list'){if(state.openListHold)await state.openListHold;if(state.openListStatus)return json(res,{error:'합성 본인 로그인 필요'},state.openListStatus);return json(res,{requests:state.requests,labs:state.rooms.map(r=>({...r,seats:r.seats.length})),hours:[1,2,4],budgets:[1,2,3]})}
   if(action==='options')return json(res,{challenge:'Zml4dHVyZQ'});
   if(action==='approve'){if(state.openApproveHold)await state.openApproveHold;state.requests.find(r=>r.id===body.id).state='approving';if(state.openApproveLost)return json(res,{error:'합성 승인 응답 유실'},503);return json(res,{state:'approving'})}
   if(action==='deny'){state.requests.find(r=>r.id===body.id).state='denied';return json(res,{ok:true})}
   if(action==='resume'){if(state.openResumeReady){state.requests.find(r=>r.id===body.id).state='ready';return json(res,{state:'ready'})}return json(res,{state:'approving'})};
   if(u.pathname.includes('/push/'))return json(res,{available:false,devices:[],enabled:false});
  }
  if(u.pathname.startsWith('/api/lab/screen/')){if(action==='start')state.shared=true;if(action==='stop')state.shared=false;return json(res,action==='status'?{screens:state.shared?{'ux-a':{on:true,startedAt:now}}:{}}:{sdp:'synthetic',startedAt:now})}
  if(u.pathname.startsWith('/api/lab/live/')){
   if(action==='logout'){state.live=false;return json(res,{ok:true})}
   if(!state.live)return json(res,{error:'합성 화면 세션 종료'},401);
   if(u.pathname.includes('/screen/')){if(action==='start')state.shared=true;if(action==='stop')state.shared=false;return json(res,action==='status'?{screens:state.shared?{'ux-a':{on:true,startedAt:now}}:{}}:{sdp:'synthetic',startedAt:now})}
   if(action==='status')return json(res,{now:Date.now(),expiresAt:end,labs:state.rooms.map(l=>({id:l.id,name:l.name,seats:l.seats.map(s=>({n:s.n,who:s.who,v:s.n,sharing:s.n<3,capable:s.n<3,width:1200,height:800,quality:state.focus?.id===l.id&&state.focus?.n===s.n?'detail':'preview',control:state.control.get(l.id+'/'+s.n)||null}))}))});
   if(action==='quality'){if(body.revision>state.qualityRevision){state.focus=body.focus;state.qualityRevision=body.revision}return json(res,{ok:true})}
   if(action==='request'){state.control.set(body.id+'/'+body.n,{state:'requested',requestId:body.requestId,expiresAt:Date.now()+300000});return json(res,{ok:true})}
   if(action==='release'){state.control.delete(body.id+'/'+body.n);return json(res,{ok:true})}
   if(action==='pull')return json(res,{sid:'synthetic-sid',sdp:'synthetic'});
   return json(res,{ok:true});
  }
  if(u.pathname==='/api/lab/list')return state.failList?json(res,{error:'합성 조회 실패'},503):json(res,{now:Date.now(),labs:state.rooms,quota:{cpu:[12,100],memory:[24,200],disk:[30,300]}});
  if(u.pathname==='/api/lab/teacher/status')return state.monitor?json(res,{now:Date.now(),expiresAt:end,labs:state.rooms.map(l=>({id:l.id,name:l.name,expiresAt:l.expiresAt,ending:l.ending,seats:l.seats.map(s=>({n:s.n,who:s.who,hand:s.hand,opened:s.opened,presence:s.presence,preparation:s.preparation,delivery:s.delivery,setup:s.setup,error:!!s.error,diagnostics:{usage:s.usage??null,limit:s.limit??null,usageAt:Date.now(),aiError:null}}))}))}):json(res,{error:'합성 모니터 만료'},401);
  if(u.pathname==='/api/lab/teacher/session')return json(res,{expiresAt:end});
  if(u.pathname==='/api/lab/teacher/logout'){state.monitor=false;return json(res,{ok:true})}
  if(u.pathname.includes('/push/'))return json(res,{available:false});
  if(u.pathname.startsWith('/api/lab/control/')){if(action==='pause'){state.paused=true;state.revision++}if(action==='resume'){state.paused=false;state.revision++}return json(res,{mode:state.paused?'paused':'running',revision:state.revision})}
  if(u.pathname==='/api/lab/snips')return json(res,{items:[]});
  if(u.pathname==='/api/lab/hand'){const l=state.rooms.find(l=>l.id===body.id);if(l)l.seats.find(s=>s.n===body.n).hand=0;return json(res,{ok:true})}
  if(u.pathname==='/api/lab/config')return json(res,{labOrigin:'https://lab.example.test',quota:{cpu:[12,100],memory:[24,200],disk:[30,300]},hours:[1,2,4],budgets:[1,2,3],shareable:[],daytona:true,openrouter:true,maxSeats:20,cfg:{gw:'https://gw.example.test',model:'fixture-model',snapshot:'gw-lab-v5',clip:{in:true,out:true},share:{}}});
  if(u.pathname==='/api/lab/end'){state.rooms=state.rooms.filter(l=>l.id!==body.id);return json(res,{ok:true})}
  return json(res,{ok:true});
 }catch(e){json(res,{error:e.message},500)}});
 await new Promise(r=>server.listen(port,'127.0.0.1',r));
 return {server,state,origin:'http://127.0.0.1:'+server.address().port,close:()=>new Promise(r=>server.close(r))};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){const fixture=await operatorFixture(Number(process.env.UX_FIXTURE_PORT||8876));console.log('Synthetic operator UI: '+fixture.origin+'/lab (Ctrl+C to stop)')}
