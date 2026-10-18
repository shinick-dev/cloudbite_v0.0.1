// 모임지기 시연실 iframe. 부모 페이지가 이 문자열을 클래식 스크립트로 실행한다.
// 같은 방 open()이 이미 살아있는 송출이면 같은 핸들을 돌려준다.
// 첫 프레임을 기다리는 중이면 같은 Promise를 돌려준다.
// 끊긴 송출만 멈추고 새로 시작한다. 갤러리 전환(setVisible)은 iframe을 유지한다.
// D.now는 선택적 테스트 시계다. 부모가 넘기지 않으면 performance.now()를 쓴다.
// allowedOrigin이 없으면 같은 출처만 허용한다. 부모와 자식이 모두
// localhost, 127.0.0.1, ::1 인 HTTP/HTTPS만 로컬 테스트 예외로 허용한다.
export const LAB_DEMO_WORKSPACE_JS = String.raw`
function createLabDemoWorkspace(D){
  var root=D.root;
  if(!root||root.nodeType!==1)throw Error('시연실 영역을 찾지 못했습니다.');
  var OUTPUT_W=1920,OUTPUT_H=1080,MAX_W=1920,MAX_H=1200;
  var BG='#101418';
  var roomId=null,origin=null,iframe=null,visible=true,childReady=false;
  var observer=null,watchTimer=0,heartbeat=0,generation=0,readyDeadline=0;
  var session=null,pending=null,canvas=null,ctx=null;
  var statusNode=null,retryBtn=null,losing=false;
  function now(){
    if(typeof D.now==='function'){
      try{var value=D.now();if(typeof value==='number'&&value===value&&value!==Infinity&&value!==-Infinity)return value;}catch(e){}
    }
    return performance.now();
  }
  function say(text){
    try{if(typeof D.onStatus==='function')D.onStatus(text);}catch(e){}
    try{
      if(!statusNode||!statusNode.isConnected){
        statusNode=document.createElement('p');
        statusNode.setAttribute('role','status');
        statusNode.setAttribute('data-demo-status','1');
        root.append(statusNode);
      }
      statusNode.textContent=text;
    }catch(e){}
  }
  function fail(error){try{if(typeof D.onError==='function')D.onError(error);}catch(e){}}
  function touch(){try{if(typeof D.changed==='function')D.changed();}catch(e){}}
  function readSelected(){try{return D.selected();}catch(e){return null;}}
  function readAuthorized(){try{return D.authorized()===true;}catch(e){return false;}}
  function loopback(host){return host==='localhost'||host==='127.0.0.1'||host==='::1'||host==='[::1]';}
  function parseGrant(raw){
    if(typeof raw!=='string'||raw.length<16||raw.length>2048)return null;
    var url;try{url=new URL(raw);}catch(e){return null;}
    if(url.username||url.password)return null;
    if(url.pathname!=='/__lab/demo-open')return null;
    if(url.search)return null;
    var fragment=url.hash.charAt(0)==='#'?url.hash.slice(1):'';
    if(fragment.length!==64)return null;
    var i;for(i=0;i<fragment.length;i++){var c=fragment.charCodeAt(i);if(!((c>=48&&c<=57)||(c>=97&&c<=102)))return null;}
    var host=url.hostname;
    var https=url.protocol==='https:';
    var httpLocal=url.protocol==='http:'&&loopback(host);
    if(!https&&!httpLocal)return null;
    var childOrigin=url.origin;
    if(typeof D.allowedOrigin==='function'){
      var allowed=false;try{allowed=D.allowedOrigin(childOrigin)===true;}catch(e){allowed=false;}
      if(!allowed)return null;
    }else if(childOrigin!==location.origin&&!(loopback(location.hostname)&&loopback(host)))return null;
    url.search='?embed=1';
    return {href:url.href,origin:childOrigin};
  }
  function contextOk(id){
    if(!id||roomId!==id||!iframe||!iframe.isConnected)return false;
    if(!readAuthorized()||readSelected()!==id)return false;
    return true;
  }
  function post(data){
    if(!childReady||!iframe||!origin)return false;
    var win=iframe.contentWindow;if(!win)return false;
    try{win.postMessage(data,origin);return true;}catch(e){return false;}
  }
  function sendStart(){if(session&&!session.stopped&&session.nonce)post({type:'gw-demo-start',nonce:session.nonce});}
  function sendStop(current){
    if(!current||current.stopSent||!current.nonce)return;
    current.stopSent=true;
    post({type:'gw-demo-stop',nonce:current.nonce});
  }
  function stopTracks(media){
    if(!media)return;
    try{media.getTracks().forEach(function(track){try{track.stop();}catch(e){}});}catch(e){}
  }
  function finishStream(current,asError,message){
    if(!current||current.finished)return;
    current.finished=true;current.stopped=true;
    sendStop(current);
    if(heartbeat&&session===current){clearInterval(heartbeat);heartbeat=0;}
    var media=current.stream;current.track=null;current.stream=null;
    stopTracks(media);
    if(message){say(message);if(asError)fail(Error(message));}
  }
  function removeRetry(){if(retryBtn){retryBtn.remove();retryBtn=null;}}
  function showRetry(id){
    removeRetry();
    if(typeof D.retry!=='function')return;
    retryBtn=document.createElement('button');
    retryBtn.type='button';
    retryBtn.textContent='다시 시도';
    retryBtn.setAttribute('data-demo-retry',id);
    retryBtn.addEventListener('click',function(){try{D.retry(id);}catch(e){}});
    root.append(retryBtn);
  }
  function destroyIframe(){
    childReady=false;readyDeadline=0;
    if(watchTimer){clearInterval(watchTimer);watchTimer=0;}
    if(observer){observer.disconnect();observer=null;}
    removeRetry();
    if(iframe){iframe.removeEventListener('load',onLoad);iframe.removeEventListener('error',onFrameError);iframe.remove();iframe=null;}
  }
  function loseContext(message){
    if(losing)return;losing=true;
    try{
      var waiter=pending;pending=null;
      if(session)finishStream(session,true,message);
      else{say(message);fail(Error(message));}
      generation+=1;
      destroyIframe();roomId=null;origin=null;
      if(waiter&&!waiter.done){waiter.done=true;try{waiter.reject(Error(message));}catch(e){}}
      touch();
    }finally{losing=false;}
  }
  function fillCanvas(){
    if(!ctx)return;
    ctx.setTransform(1,0,0,1,0,0);
    ctx.fillStyle=BG;
    ctx.fillRect(0,0,OUTPUT_W,OUTPUT_H);
  }
  function ensureCanvas(){
    if(canvas&&ctx)return true;
    canvas=document.createElement('canvas');
    canvas.width=OUTPUT_W;canvas.height=OUTPUT_H;
    ctx=canvas.getContext('2d',{alpha:false});
    if(!ctx)return false;
    ctx.imageSmoothingEnabled=false;
    fillCanvas();
    return true;
  }
  function drawBitmap(bitmap,w,h){
    if(!ensureCanvas())return false;
    fillCanvas();
    var scale=Math.min(OUTPUT_W/w,OUTPUT_H/h);
    var dw=Math.round(w*scale),dh=Math.round(h*scale);
    var dx=Math.floor((OUTPUT_W-dw)/2),dy=Math.floor((OUTPUT_H-dh)/2);
    ctx.drawImage(bitmap,dx,dy,dw,dh);
    return true;
  }
  function layout(){
    if(!iframe||!visible)return;
    var rect=root.getBoundingClientRect();
    var scale=rect.width>0&&rect.height>0?Math.min(rect.width/OUTPUT_W,rect.height/OUTPUT_H):0;
    iframe.style.position='absolute';
    iframe.style.left=Math.max(0,(rect.width-OUTPUT_W*scale)/2)+'px';iframe.style.top=Math.max(0,(rect.height-OUTPUT_H*scale)/2)+'px';iframe.style.margin='0';
    iframe.style.display='block';
    iframe.style.width='1920px';iframe.style.height='1080px';
    iframe.style.transformOrigin='0 0';
    iframe.style.transform='scale('+String(scale)+')';
    iframe.hidden=false;
    try{iframe.inert=false;}catch(e){}
    iframe.removeAttribute('aria-hidden');
    // Keep the same browsing context: moving an iframe between parents reloads it.
  }
  function park(){
    if(!iframe)return;
    iframe.style.position='fixed';
    iframe.style.left='0';iframe.style.top='0';iframe.style.margin='0';
    iframe.style.display='block';
    iframe.style.width='1920px';iframe.style.height='1080px';
    iframe.style.transformOrigin='0 0';
    iframe.style.transform='translate3d(-20000px,-20000px,0)';
    iframe.hidden=false;
    try{iframe.inert=true;}catch(e){}
    iframe.setAttribute('aria-hidden','true');
    // The root remains mounted; offscreen CSS preserves editing and capture.
  }
  function applyVisible(){if(visible)layout();else park();}
  function isBlankFrame(){
    try{return !iframe.contentWindow||iframe.contentWindow.location.href==='about:blank';}
    catch(e){return false;}
  }
  function onLoad(event){
    if(event&&event.target!==iframe)return;
    if(!iframe||!roomId||isBlankFrame())return;
    if(!contextOk(roomId))return;
    // A landing page or an error response can load too. Only the trusted
    // child bridge handshake confirms readiness.
    if(!childReady)say('시연실 화면을 준비하고 있습니다.');
  }
  function onFrameError(event){
    if(event&&event.target!==iframe)return;
    var message='시연실을 열지 못했습니다. 다시 시도해 주세요.';
    say(message);fail(Error(message));
    if(roomId)showRetry(roomId);
  }
  function tick(){
    if(iframe&&!childReady&&readyDeadline&&now()>=readyDeadline){readyDeadline=0;onFrameError();}
    if(session&&!session.stopped&&session.stream&&session.track?.readyState!=='live'){
      finishStream(session,true,'시연 영상 트랙이 끝나 송출을 멈췄습니다.');generation+=1;
    }
    if(roomId&&(!readAuthorized()||readSelected()!==roomId)){
      loseContext('선택한 모임이나 권한이 바뀌어 시연실을 닫았습니다.');
      return;
    }
    if(pending&&!pending.done&&now()-pending.startedAt>=10000){
      var waiter=pending;pending=null;
      var message='시연 화면의 첫 프레임을 받지 못했습니다.';
      if(session&&session.gen===waiter.gen)finishStream(session,true,message);
      else{say(message);fail(Error(message));}
      generation+=1;
      if(waiter&&!waiter.done){waiter.done=true;try{waiter.reject(Error(message));}catch(e){}}
      return;
    }
    if(session&&!session.stopped&&session.stream&&session.lastFrameAt&&now()-session.lastFrameAt>=10000){
      fillCanvas();
      finishStream(session,true,'시연 화면이 멈춰 송출을 멈췄습니다.');
      generation+=1;
    }
  }
  function makeNonce(){
    var bytes=new Uint8Array(16);
    crypto.getRandomValues(bytes);
    var out='',i;for(i=0;i<bytes.length;i++)out+=(bytes[i]<16?'0':'')+bytes[i].toString(16);
    return out;
  }
  function createHandle(gen){
    return {
      stream:null,
      stop:function(){
        if(!session||session.gen!==gen)return;
        if(session.finished)return;
        finishStream(session,false,'시연 송출을 멈췄습니다.');
        touch();
      },
      stats:function(){
        var current=session&&session.gen===gen?session:null;
        var at=current&&current.lastFrameAt?current.lastFrameAt:0;
        var age=at?Math.round(now()-at):null;
        var stopped=!current||current.stopped;
        return {quality:'detail',width:OUTPUT_W,height:OUTPUT_H,frames:current?current.frames:0,ageMs:age,seq:current?current.lastSeq:null,fresh:!stopped&&age!==null&&age<10000};
      },
      isCurrent:function(){
        var current=session&&session.gen===gen?session:null;
        if(!current||current.stopped||!current.track||current.track.readyState!=='live')return false;
        if(!contextOk(current.room))return false;
        if(!current.lastFrameAt||now()-current.lastFrameAt>=10000)return false;
        return true;
      }
    };
  }
  function startCapture(sess,waiter){
    if(!sess||sess.stream||sess.stopped||sess.gen!==generation)return;
    if(!contextOk(sess.room)){loseContext('선택한 모임이나 권한이 바뀌어 시연실을 닫았습니다.');return;}
    var err=Error('시연 화면 스트림을 시작하지 못했습니다.');
    if(!canvas||typeof canvas.captureStream!=='function'){
      pending=null;finishStream(sess,true,err.message);generation+=1;
      if(waiter&&!waiter.done){waiter.done=true;try{waiter.reject(err);}catch(e){}}
      return;
    }
    var media=null;
    try{media=canvas.captureStream(15);}catch(e){media=null;}
    var video=media&&media.getVideoTracks()[0];
    if(!video){
      pending=null;stopTracks(media);finishStream(sess,true,err.message);generation+=1;
      if(waiter&&!waiter.done){waiter.done=true;try{waiter.reject(err);}catch(e){}}
      return;
    }
    try{video.contentHint='text';}catch(e){}
    sess.stream=media;sess.track=video;sess.handle.stream=media;
    pending=null;waiter.done=true;waiter.resolve(sess.handle);touch();
  }
  function closeBitmap(bitmap){if(bitmap instanceof ImageBitmap){try{bitmap.close();}catch(e){}}}
  function onMessage(event){
    var data=event.data;
    if(!data||typeof data!=='object')return;
    var bitmap=data.bitmap;
    var type=data.type;
    if(type==='gw-demo-ready'){
      closeBitmap(bitmap);
      if(!iframe||event.source!==iframe.contentWindow||event.origin!==origin||!contextOk(roomId))return;
      childReady=true;readyDeadline=0;removeRetry();say('시연실을 열었습니다.');
      try{if(typeof D.onReady==='function')D.onReady();}catch(e){}
      sendStart();return;
    }
    if(type!=='gw-demo-frame'&&type!=='gw-demo-error'){closeBitmap(bitmap);return;}
    if(!iframe||event.source!==iframe.contentWindow||!origin||event.origin!==origin){closeBitmap(bitmap);return;}
    if(!session||session.stopped||session.finished||session.gen!==generation||typeof data.nonce!=='string'||data.nonce!==session.nonce){closeBitmap(bitmap);return;}
    if(!contextOk(session.room)){closeBitmap(bitmap);loseContext('선택한 모임이나 권한이 바뀌어 시연실을 닫았습니다.');return;}
    if(type==='gw-demo-error'){
      closeBitmap(bitmap);
      var waiter=pending;var gen=session.gen;
      var message='시연실에서 화면을 받지 못했습니다.';
      pending=null;finishStream(session,true,message);generation+=1;
      if(waiter&&!waiter.done&&waiter.gen===gen){waiter.done=true;try{waiter.reject(Error(message));}catch(e){}}
      return;
    }
    if(!Number.isSafeInteger(data.seq)||data.seq<0||(session.lastSeq!==null&&data.seq<=session.lastSeq)){closeBitmap(bitmap);return;}
    if(!(bitmap instanceof ImageBitmap)||!Number.isSafeInteger(data.width)||!Number.isSafeInteger(data.height)||data.width<1||data.height<1||data.width>MAX_W||data.height>MAX_H||bitmap.width!==data.width||bitmap.height!==data.height){closeBitmap(bitmap);return;}
    var drew=false;
    try{drew=drawBitmap(bitmap,data.width,data.height);}catch(e){drew=false;}
    closeBitmap(bitmap);
    if(!drew||!session||session.gen!==generation||session.stopped){if(!drew)fail(Error('시연 화면 스트림을 시작하지 못했습니다.'));return;}
    if(!contextOk(session.room)){loseContext('선택한 모임이나 권한이 바뀌어 시연실을 닫았습니다.');return;}
    session.lastSeq=data.seq;session.frames+=1;session.lastFrameAt=now();
    post({type:'gw-demo-ack',nonce:session.nonce,seq:data.seq});
    if(pending&&!pending.done&&pending.gen===session.gen&&!session.stream)startCapture(session,pending);
  }
  function beginOpen(id){
    if(session&&!session.finished)finishStream(session,false,'');
    var gen=++generation;
    var handle=createHandle(gen);
    session={gen:gen,room:id,nonce:makeNonce(),frames:0,lastSeq:null,lastFrameAt:0,stream:null,track:null,stopped:false,finished:false,stopSent:false,handle:handle};
    var resolve,reject;
    var promise=new Promise(function(res,rej){resolve=res;reject=rej;});
    pending={room:id,gen:gen,startedAt:now(),done:false,resolve:resolve,reject:reject,promise:promise};
    sendStart();
    if(heartbeat)clearInterval(heartbeat);
    heartbeat=setInterval(function(){
      if(!session||session.gen!==gen||session.stopped)return;
      if(!contextOk(id)){loseContext('선택한 모임이나 권한이 바뀌어 시연실을 닫았습니다.');return;}
      sendStart();
    },1000);
    return promise;
  }
  addEventListener('message',onMessage);
  addEventListener('pagehide',function(){
    var waiter=pending;var had=(waiter&&!waiter.done)||(session&&!session.finished);
    pending=null;
    if(session)finishStream(session,had,had?'시연 화면 요청이 취소되었습니다.':'');
    generation+=1;
    if(watchTimer){clearInterval(watchTimer);watchTimer=0;}
    if(observer){observer.disconnect();observer=null;}
    if(waiter&&!waiter.done){waiter.done=true;try{waiter.reject(Error('시연 화면 요청이 취소되었습니다.'));}catch(e){}}
  });
  addEventListener('pageshow',function(){
    if(!iframe)return;
    if(!contextOk(roomId)){loseContext('선택한 모임이나 권한이 바뀌어 시연실을 닫았습니다.');return;}
    if(!observer){observer=new ResizeObserver(function(){if(visible)layout();});observer.observe(root);}
    if(!watchTimer)watchTimer=setInterval(tick,250);
    applyVisible();
  });
  return {
    mount:function(id,raw){
      if(readSelected()!==id||!readAuthorized()){
        var denied=Error('선택한 모임이나 권한을 확인하지 못했습니다.');
        say(denied.message);fail(denied);return false;
      }
      var parsed=parseGrant(typeof raw==='string'?raw:String(raw==null?'':raw));
      if(!parsed){
        var bad=Error('시연실 주소를 확인하지 못했습니다.');
        say(bad.message);fail(bad);return false;
      }
      if(iframe||roomId){
        var previous=roomId;
        if(previous!=null){
          var switching=pending;pending=null;
          if(session)finishStream(session,false,'');
          generation+=1;destroyIframe();roomId=null;origin=null;
          if(switching&&!switching.done){switching.done=true;try{switching.reject(Error('시연 화면 요청이 취소되었습니다.'));}catch(e){}}
        }
        if(readSelected()!==id||!readAuthorized())return false;
      }
      roomId=id;origin=parsed.origin;childReady=false;readyDeadline=now()+20000;
      iframe=document.createElement('iframe');
      iframe.title='모임지기 시연실';
      iframe.referrerPolicy='no-referrer';
      iframe.setAttribute('referrerpolicy','no-referrer');
      iframe.setAttribute('loading','eager');
      iframe.setAttribute('width','1920');
      iframe.setAttribute('height','1080');
      iframe.style.border='0';iframe.style.margin='0';iframe.style.display='block';
      iframe.style.background=BG;
      iframe.style.width='1920px';iframe.style.height='1080px';
      root.append(iframe);
      iframe.addEventListener('load',onLoad);
      iframe.addEventListener('error',onFrameError);
      applyVisible();
      iframe.src=parsed.href;
      if(!observer){observer=new ResizeObserver(function(){if(visible)layout();});observer.observe(root);}
      if(!watchTimer)watchTimer=setInterval(tick,250);
      say('시연실을 열고 있습니다.');
      touch();
      return true;
    },
    setVisible:function(flag){visible=flag===true;applyVisible();touch();},
    clear:function(which){
      if(which!=null&&which!==roomId)return;
      var waiter=pending;pending=null;
      if(session)finishStream(session,false,'');
      generation+=1;destroyIframe();roomId=null;origin=null;
      if(waiter&&!waiter.done){waiter.done=true;try{waiter.reject(Error('시연 화면 요청이 취소되었습니다.'));}catch(e){}}
      touch();
    },
    isMounted:function(id){return !!iframe&&iframe.isConnected&&roomId===id;},
    open:function(id){
      if(readSelected()!==id||!readAuthorized()){
        var denied=Error('시연실 송출을 시작할 권한이 없습니다.');
        fail(denied);return Promise.reject(denied);
      }
      if(!iframe||roomId!==id||!origin){
        var missing=Error('시연실이 아직 열려 있지 않습니다.');
        fail(missing);return Promise.reject(missing);
      }
      if(session&&session.room===id&&session.handle&&!session.stopped&&!session.finished&&session.handle.isCurrent())return Promise.resolve(session.handle);
      if(pending&&pending.room===id&&!pending.done)return pending.promise;
      return beginOpen(id);
    }
  };
}
`;
