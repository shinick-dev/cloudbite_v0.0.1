// Isolated peer/statistics/response-order fixture; Aside cannot inject RTC peers.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { LAB_LIVE_TEACHER_JS } from '../src/lablive.ts';
const artifact=path.resolve('../.artifacts/live-quality-ui');await mkdir(artifact,{recursive:true});
const state={requests:[],focus:null,revision:0,hold:true,release:()=>{},status:200};
let heldResolve;const held=new Promise(r=>{heldResolve=r});state.release=heldResolve;
const html=`<!doctype html><meta charset="utf-8"><style>body{font:16px/1.5 system-ui;margin:16px}main{max-width:1200px;margin:auto}.row{display:flex;gap:8px;flex-wrap:wrap}.lab-live-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,340px),1fr));gap:20px}.lab-live-seat{min-width:0}.mut{color:#555}button{font:inherit}textarea{max-width:100%}</style><main><div id="root"></div></main><script>
window.__pcs=[];
window.RTCPeerConnection=class{constructor(){this.localDescription={sdp:'fixture'};this.bytes=0;window.__pcs.push(this)}async createAnswer(){return{type:'answer',sdp:'fixture'}}async setRemoteDescription(){}async setLocalDescription(d){this.localDescription=d}close(){this.closed=true}async getStats(){this.bytes+=125000;return new Map([['in',{id:'in',type:'inbound-rtp',kind:'video',ssrc:1,bytesReceived:this.bytes}],['out',{id:'out',type:'outbound-rtp',kind:'video',ssrc:2,bytesSent:this.bytes}]])}};
${LAB_LIVE_TEACHER_JS}
const btn=(text,cls,fn)=>{const b=document.createElement('button');b.type='button';b.textContent=text;b.className=cls;b.onclick=fn;return b};
window.ui=createLabLiveTeacher({root:document.getElementById('root'),btn,screenRow:()=>document.createElement('div'),call:async(p,b)=>{const r=await fetch(p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)});const j=await r.json();if(!r.ok)throw Object.assign(Error(j.error),{status:r.status});return j}});ui.start();
</script>`;
const server=createServer(async(req,res)=>{
 if(req.method==='GET'){res.setHeader('content-type','text/html;charset=utf-8');res.end(html);return}
 let raw='';for await(const part of req)raw+=part;const body=JSON.parse(raw||'{}'),action=req.url.split('/').at(-1);state.requests.push({action,body});
 let result={ok:true},status=200;
 if(action==='quality'){
  if(body.revision>state.revision){state.revision=body.revision;state.focus=body.focus}
  if(state.hold&&body.focus?.n===1){state.hold=false;await held;status=503;result={error:'old request failed'}}
 }else if(action==='status'){
  status=state.status;result=status===200?{now:Date.now(),expiresAt:Date.now()+3600000,labs:[{id:'room',name:'두 자리 모임',seats:[1,2].map(n=>({n,who:'참여자 '+n,v:n,sharing:true,capable:true,width:1200,height:800,quality:state.focus?.n===n?'detail':'preview',control:null}))}]}:{error:'expired'};
 }else if(action==='pull')result={sid:'sid',sdp:'fixture'};
 res.writeHead(status,{'content-type':'application/json'}).end(JSON.stringify(result));
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({channel:'msedge',headless:true}),page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
try{
 await page.goto('http://127.0.0.1:'+server.address().port);
 const one=page.locator('[data-live-seat="1"]'),two=page.locator('[data-live-seat="2"]');await one.waitFor();await two.waitFor();
 await one.getByRole('button',{name:'크게 보기',exact:true}).click();
 await two.getByRole('button',{name:'크게 보기',exact:true}).click();
 assert.equal(await page.locator('.expanded').count(),1);assert.ok(await two.getAttribute('class').then(x=>x.includes('expanded')));
 await page.waitForFunction(()=>document.querySelector('[data-live-seat="2"] [data-live-media]').textContent.startsWith('선명한 화면'));
 state.release();await page.waitForTimeout(150);
 assert.ok(!(await two.locator('[data-live-media]').innerText()).includes('확인 필요'),'old failed response cannot replace new focus');
 assert.ok(state.requests.filter(x=>x.action==='quality').every(x=>x.body.viewerTab&&x.body.revision&&x.body.at));
 await page.evaluate(()=>{window.sentPeer=new RTCPeerConnection();ui.trackSend(window.sentPeer,'room')});
 await page.waitForFunction(()=>/모임지기 영상 송신 \d+\.\d+ MB/.test(document.querySelector('[data-live-usage]').textContent));
 await page.getByText('영상 연결·사용량',{exact:true}).click();
 assert.ok(/참여자 영상 수신 \d+\.\d+ MB/.test(await page.locator('[data-live-usage]').innerText()));
 assert.ok((await page.locator('#root').innerText()).includes('Cloudflare 청구량과는 다릅니다'));
 const current=await two.locator('[data-live-media]').innerText();assert.ok(current.includes('MB')&&current.includes('Mbps'));
 await page.screenshot({path:path.join(artifact,'desktop.png'),fullPage:true});
 await two.getByRole('button',{name:'작게 보기',exact:true}).click();
 await page.waitForFunction(()=>document.querySelectorAll('.expanded').length===0);
 for(let i=0;state.focus!==null&&i<50;i++)await page.waitForTimeout(20);assert.equal(state.focus,null);
 await page.evaluate(()=>ui.end());assert.equal(await page.locator('#root').isHidden(),true);assert.ok(!(await page.locator('[data-live-usage]').textContent()).includes(' MB'));
 state.status=200;await page.evaluate(()=>ui.start());await page.locator('[data-live-seat="1"]').waitFor();
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(artifact,'mobile.png'),fullPage:true});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 assert.deepEqual(errors,[]);
 console.log('PASS quality wall: one expanded seat, stale reply isolation, payload counters, billing scope, clear/reset and mobile layout');
}finally{state.release();await browser.close();await new Promise(r=>server.close(r))}
