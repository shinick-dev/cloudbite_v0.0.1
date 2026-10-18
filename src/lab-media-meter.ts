// Browser-local video payload counters. Never sent to the server or persisted.
// These exclude transport overhead and are not the provider's billing meter.
export const LAB_MEDIA_METER_JS = String.raw`
function createLabMediaMeter(direction){
 const peers=new Map(),channels=new Map();let epoch=0;
 const time=()=>performance.now();
 function add(pc,key){if(!pc||peers.has(pc))return;let channel=channels.get(key);if(!channel){channel={bytes:0,known:false};channels.set(key,channel)}peers.set(pc,{pc,key,channel,active:true,lastAt:time(),counters:new Map(),rate:null,stamp:0,pending:null,epoch})}
 function readPeer(p){
  if(p.pending)return p.pending;
  if(typeof p.pc.getStats!=='function')return Promise.resolve();
  const generation=epoch;let timer;
  const work=(async()=>{
   try{
    const report=await Promise.race([p.pc.getStats(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('stats timeout')),1200)})]);
    if(generation!==epoch)return;
    let delta=0,found=false;
    report.forEach(r=>{if(r.type!==direction||(r.kind||r.mediaType)!=='video')return;
     const n=direction==='inbound-rtp'?r.bytesReceived:r.bytesSent;
     if(!Number.isSafeInteger(n)||n<0)return;found=true;
     const key=String(r.id||'')+'/'+String(r.ssrc??''),prior=p.counters.get(key);
     // A new SSRC or a reset counter starts at zero; never subtract totals.
     delta+=prior===undefined||n<prior?n:n-prior;p.counters.set(key,n);
    });
    if(!found){p.rate=null;return}
    const at=time(),elapsed=at-p.lastAt;p.lastAt=at;p.stamp=at;
    p.channel.bytes+=delta;p.channel.known=true;p.rate=elapsed>0?delta*8/elapsed/1000:null;
   }catch{p.rate=null}finally{clearTimeout(timer)}
  })();
  p.pending=work;void work.finally(()=>{if(p.pending===work)p.pending=null});return work;
 }
 function remove(pc){const p=peers.get(pc);if(!p)return;const done=readPeer(p);p.active=false;void done.finally(()=>{if(peers.get(pc)===p)peers.delete(pc)})}
 function read(key){const selected=key===undefined?[...channels.values()]:[channels.get(key)].filter(Boolean);let rate=0,fresh=false;
  for(const p of peers.values())if(p.active&&(key===undefined||p.key===key)&&p.rate!==null&&time()-p.stamp<10000){rate+=p.rate;fresh=true}
  return{bytes:selected.reduce((n,c)=>n+c.bytes,0),known:selected.some(c=>c.known),active:[...peers.values()].filter(p=>p.active&&(key===undefined||p.key===key)).length,mbps:fresh?rate:null};
 }
 return{add,remove,read,sample:async()=>{await Promise.all([...peers.values()].filter(p=>p.active).map(readPeer));return read()},clear:()=>{epoch++;peers.clear();channels.clear()}};
}
function labMediaSummary(value){return value.known?labMediaBytes(value.bytes)+' · '+labMediaRate(value.mbps,value.active):value.active?'측정 중':'대기'}
function labMediaBytes(n){return n>=1e9?(n/1e9).toFixed(2)+' GB':(n/1e6).toFixed(2)+' MB'}
function labMediaRate(n,active=true){return n===null?(active?'측정 중':'대기'):n.toFixed(2)+' Mbps'}
`;
