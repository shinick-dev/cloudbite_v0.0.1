// Only the authenticated private demonstration document includes this script.
// Pixel frames go to its exact operator parent; no token or input authority crosses it.
export function labDemoEmbedBridgeJS(parentOrigin: string): string {
  const origin = new URL(parentOrigin).origin;
  return '(()=>{const operatorOrigin='+JSON.stringify(origin)+';'+String.raw`
 if(window.parent===window)return;
 let generation=0,nonce='',capture=null,timer=0,lease=0,heartbeat=0,seq=0,awaiting=0,sentAt=0,lastFrame=-1;
 const send=value=>window.parent.postMessage(value,operatorOrigin);
 function stop(){generation++;clearTimeout(timer);clearInterval(lease);timer=lease=0;nonce='';awaiting=0;const old=capture;capture=null;try{old?.stop()}catch{}}
 function fail(message){const token=nonce;stop();if(token)send({type:'gw-demo-error',nonce:token,message})}
 async function pump(){clearTimeout(timer);if(!capture||!nonce)return;const current=capture,g=generation,token=nonce;
  try{
   const stats=current.stats();
   if(awaiting&&Date.now()-sentAt>2000)awaiting=0;
   if(!awaiting&&stats.frames!==lastFrame&&current.isCurrent()){
    const bitmap=await createImageBitmap(current.snapshot());
    if(g!==generation||current!==capture||token!==nonce){bitmap.close();return}
    if(bitmap.width<1||bitmap.height<1||bitmap.width>1920||bitmap.height>1200){bitmap.close();throw Error('시연 영상 크기를 확인하지 못했습니다.')}
    lastFrame=stats.frames;awaiting=++seq;sentAt=Date.now();
    try{window.parent.postMessage({type:'gw-demo-frame',nonce:token,seq,width:bitmap.width,height:bitmap.height,bitmap},operatorOrigin,[bitmap])}catch(e){bitmap.close();throw e}
   }
  }catch{if(g===generation)fail('시연실 영상을 연결하지 못했습니다. 시연 송출을 다시 시작해 주세요.');return}
  if(g===generation&&capture)timer=setTimeout(pump,250);
 }
 async function start(token){if(token===nonce){heartbeat=Date.now();return}stop();nonce=token;heartbeat=Date.now();seq=0;lastFrame=-1;const g=generation;
  lease=setInterval(()=>{if(Date.now()-heartbeat>5000)stop()},1000);
  try{if(!window.__labDomCapture?.open)throw Error('not ready');const opened=await window.__labDomCapture.open({quality:'detail',onError:()=>{if(g===generation)fail('시연실 화면을 갱신하지 못했습니다. 송출을 다시 시작해 주세요.')}});
   if(g!==generation||nonce!==token){opened.stop();return}capture=opened;pump();
  }catch{if(g===generation)fail('시연실 화면이 아직 준비되지 않았습니다. 잠시 뒤 송출을 다시 시작해 주세요.')}
 }
 addEventListener('message',event=>{if(event.source!==window.parent||event.origin!==operatorOrigin)return;const value=event.data;if(!value||typeof value!=='object'||typeof value.nonce!=='string'||!/^[A-Za-z0-9_-]{16,128}$/.test(value.nonce))return;
  if(value.type==='gw-demo-start'){start(value.nonce);return}if(value.nonce!==nonce)return;
  if(value.type==='gw-demo-stop')stop();else if(value.type==='gw-demo-ack'&&value.seq===awaiting)awaiting=0;
 });
 addEventListener('pagehide',stop);
 send({type:'gw-demo-ready'});
})();`;
}
