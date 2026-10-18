import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import net from 'node:net';import {fileURLToPath} from 'node:url';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),TMP=fs.mkdtempSync(path.join(os.tmpdir(),'gw-assistant-sqlite-'));
const freePort=()=>new Promise(r=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p))})});
const PORT=await freePort(),INSP=await freePort(),GW='http://127.0.0.1:'+PORT,ADMIN='https://admin.invalid';
const code1='seat000000000001',code2='seat000000000002',host1='s-'+'a'.repeat(26)+'.class.invalid',host2='s-'+'b'.repeat(26)+'.class.invalid';
const uuid=n=>'d0000000-0000-4000-8000-'+n.toString(16).padStart(12,'0'),sleep=ms=>new Promise(r=>setTimeout(r,ms)),fwd=s=>s.replace(/\\/g,'/');
let child,log='',count=0;
fs.writeFileSync(path.join(TMP,'entry.js'),"import production from '"+fwd(path.join(ROOT,'src/index.ts'))+"';\nimport {State as Base,sha} from '"+fwd(path.join(ROOT,'src/state.ts'))+"';\nimport {makeAssistantFixture} from '"+fwd(path.join(ROOT,'test/fixtures/lab-assistant/fixture.js'))+"';\nconst f=makeAssistantFixture(Base,production,sha);export const State=f.State;export default f.worker;");
fs.writeFileSync(path.join(TMP,'wrangler.json'),JSON.stringify({name:'gw-assistant-sqlite-fixture',main:'entry.js',compatibility_date:'2026-09-01',compatibility_flags:['nodejs_compat'],vars:{RP_ID:'invalid',ORIGIN:ADMIN,LAB_ORIGIN:'https://lab.invalid',LAB_SEAT_DOMAIN:'class.invalid'},durable_objects:{bindings:[{name:'STATE',class_name:'State'}]},migrations:[{tag:'v1',new_sqlite_classes:['State']}],rules:[{type:'Text',globs:['**/*.ps1'],fallthrough:true}]}));
async function start(){
 child=spawn(process.execPath,[path.join(ROOT,'node_modules/wrangler/bin/wrangler.js'),'dev','--config',path.join(TMP,'wrangler.json'),'--port',String(PORT),'--ip','127.0.0.1','--inspector-port',String(INSP),'--persist-to',path.join(TMP,'state'),'--show-interactive-dev-session=false','--log-level','warn'],{cwd:TMP,windowsHide:true,env:{...process.env,WRANGLER_SEND_METRICS:'false',NO_COLOR:'1'},stdio:['ignore','pipe','pipe']});
 child.stdout.on('data',d=>log+=d);child.stderr.on('data',d=>log+=d);
 const end=Date.now()+25000;while(Date.now()<end){try{if((await fetch(GW,{redirect:'manual',signal:AbortSignal.timeout(500)})).status===302)return}catch{}if(child.exitCode!==null)break;await sleep(100)}throw Error('fixture did not start '+log.slice(-1200))
}
async function stop(){if(!child)return;const own=child;child=null;try{if(process.platform==='win32')execFileSync('taskkill',['/PID',String(own.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});else own.kill('SIGTERM')}catch{}if(own.exitCode===null)await Promise.race([new Promise(r=>own.once('exit',r)),sleep(3000)])}
async function fx(name,...args){const r=await fetch(GW+'/'+name,{method:'POST',body:JSON.stringify(args),redirect:'manual',signal:AbortSignal.timeout(15000)});assert.equal(r.status,200);return r.json()}
async function api(p,b={},h={},method='POST'){
 const r=await fetch(GW+p,{method,headers:{origin:ADMIN,'content-type':'application/json',...h},...(method==='GET'?{}:{body:JSON.stringify(b)}),redirect:'manual',signal:AbortSignal.timeout(15000)});
 const text=await r.text();let body;try{body=JSON.parse(text)}catch{body={html:text}}return{status:r.status,body,headers:r.headers};
}
function ok(cond,message){assert.ok(cond,message);count++}
try{
 await start();await fx('fxSeed');
 ok((await api('/api/lab/assistant/status')).status===401,'unconnected helper denied');
 const issued=await api('/api/lab/assistants/issue',{id:'lab',label:'Grok fixture',seats:[1,2],scopes:['status:read','help:read','help:reply','template:send','control:pause'],minutes:60,templates:[{title:'첫 요청',text:'두 원본을 읽고 결과.txt로 저장해줘.'}]},{'x-admin-token':'fixture-admin'});
 ok(issued.status===200,'owner issue succeeds');const {token,grant}=issued.body;ok(/^la_/.test(token),'one-time credential returned');const ah={'x-lab-assistant':token};
 const session=await api('/api/lab/assistant/session',{token});ok(session.status===200,'cookie exchange succeeds');ok(session.headers.get('set-cookie').includes('HttpOnly'),'HttpOnly cookie');ok(!JSON.stringify(session.body).includes(token),'no raw token in session JSON');
 const status=await api('/api/lab/assistant/status',{},ah);ok(status.status===200,'scoped status');ok(status.body.lab.id==='lab'&&status.body.lab.seats.length===2,'one bound classroom');ok(!JSON.stringify(status.body).includes(code1),'seat credential redacted');
 ok((await api('/api/lab/assistant/questions',{id:'other'},ah)).status===403,'cross-classroom denied');
 const seatH=(host,code)=>({'x-fixture-host':host,origin:'https://'+host,cookie:'__Host-lab_seat='+code,'sec-fetch-site':'same-origin'}),ph1=seatH(host1,code1),ph2=seatH(host2,code2);
 const asked=await api('/__lab/help',{requestId:uuid(1),question:'결과.txt가 보이지 않아요.'},ph1);ok(asked.status===200,'participant question accepted');const q=asked.body.question;
 ok((await api('/__lab/help',{requestId:uuid(10),question:'spoof',n:2},ph1)).status===400,'participant cannot choose another seat in body');
 ok((await api('/__lab/help',{requestId:uuid(10),question:'cross-origin'},{...ph1,origin:'https://evil.invalid'})).status===403,'participant cross-origin write refused');
 const replay=await api('/__lab/help',{requestId:uuid(1),question:'결과.txt가 보이지 않아요.'},ph1);ok(replay.body.question.id===q.id,'same question request replays');
 ok((await api('/__lab/help',{requestId:uuid(1),question:'changed'},ph1)).status===409,'changed replay rejected');
 ok((await api('/api/lab/assistant/questions',{id:'lab'},ah)).body.questions.length===1,'helper inbox receives question');
 ok((await api('/__lab/help',{},ph2,'GET')).body.questions.length===0,'other participant cannot read question');
 const answer={id:'lab',requestId:uuid(2),questionId:q.id,text:'현재 폴더에서 결과.txt를 찾아 열어보세요.'};
 ok((await api('/api/lab/assistant/reply',answer,ah)).status===200,'reply accepted');
 const seen=await api('/__lab/help',{},ph1,'GET');ok(seen.body.questions[0].status==='answered','reply is not resolution');ok(seen.body.questions[0].reply===answer.text,'participant receives answer');
 ok((await api('/__lab/help/resolve',{requestId:uuid(3),questionId:q.id},ph2)).status>=400,'other seat cannot resolve');
 ok((await api('/__lab/help/resolve',{requestId:uuid(3),questionId:q.id},ph1)).body.question.status==='resolved','participant explicitly resolves');
 ok((await api('/api/lab/assistant/template',{id:'lab',requestId:uuid(4),templateId:grant.templates[0].id,n:1},ah)).status===200,'approved text delivered');
 ok((await api('/__lab/help',{},ph1,'GET')).body.messages.length===1,'target receives template');ok((await api('/__lab/help',{},ph2,'GET')).body.messages.length===0,'other seat receives no template');
 ok((await api('/api/lab/assistant/template',{id:'lab',requestId:uuid(5),templateId:grant.templates[0].id,n:1,text:'arbitrary shell'},ah)).status===400,'arbitrary text refused');
 const pause={id:'lab',requestId:uuid(6),reason:'가상 다중 전달 사건'},pauses=await Promise.all(Array.from({length:5},()=>api('/api/lab/assistant/pause',pause,ah)));
 ok(pauses.every(r=>r.status===200&&r.body.control.revision===1),'concurrent same request changes control once');
 ok((await api('/api/lab/control/resume',{id:'lab',requestId:uuid(7),expectedRevision:1},ah)).status===401,'helper cannot resume through admin API');
 ok((await fx('fxResume',0,uuid(7))).status===409,'stale admin resume refused');ok((await fx('fxResume',1,uuid(8))).mode==='running','fresh explicit admin resume works');
 const auditBefore=await fx('fxInfo');await fx('fxAudit',{invalid:true});
 ok((await api('/api/lab/assistant/pause',{id:'lab',requestId:uuid(11),reason:'audit rollback'},ah)).status===503,'corrupt audit reports storage failure');
 const auditAfter=await fx('fxInfo');ok(JSON.stringify(auditAfter['labctrl:lab'])===JSON.stringify(auditBefore['labctrl:lab']),'actual SQLite rolls back failed pause and does not change control');
 ok(JSON.stringify(auditAfter['labassist:'+grant.id])===JSON.stringify(auditBefore['labassist:'+grant.id]),'actual SQLite rolls back failed operation receipt');
 await fx('fxAudit',auditBefore['labassist-audit:lab']);
 ok(!JSON.stringify(await fx('fxInfo')).includes(token),'SQLite stores no raw token');
 await stop();await start();
 ok((await api('/api/lab/assistant/status',{},ah)).status===200,'grant survives runtime restart');
 ok((await api('/api/lab/assistant/reply',answer,ah)).body.question.id===q.id,'reply receipt survives runtime restart');
 await fx('fxRotate');ok((await api('/__lab/help',{},ph1,'GET')).status>=400,'old participant cookie loses access after rotation');
 const rotated=await api('/__lab/help',{},seatH(host1,'newc000000000001'),'GET');ok(rotated.status===200&&rotated.body.questions.length===0&&rotated.body.messages.length===0,'new seat credential cannot read old questions or messages');
 ok((await api('/api/lab/assistants/revoke',{id:'lab',grantId:grant.id},{'x-admin-token':'fixture-admin'})).status===200,'owner revokes');
 ok((await api('/api/lab/assistant/reply',answer,ah)).status>=400,'revoked grant cannot replay success');ok((await api('/api/lab/assistant/status',{},ah)).status>=400,'revoked grant cannot read');
 const limited=await api('/api/lab/assistants/issue',{id:'lab',label:'limited',seats:[1],scopes:['status:read','control:pause'],minutes:5,templates:[]},{'x-admin-token':'fixture-admin'});
 ok(limited.status===200,'limited scope issued');const lh={'x-lab-assistant':limited.body.token};
 ok((await api('/api/lab/assistant/status',{},lh)).body.lab.seats.length===1,'limited grant sees one seat only');
 ok((await api('/api/lab/assistant/pause',{id:'lab',requestId:uuid(9),reason:'test'},lh)).status===403,'partial-seat grant cannot pause class');
 await fx('fxExpire',limited.body.grant.id);ok((await api('/api/lab/assistant/status',{},lh)).status>=400,'expired grant denied');
 const last=await api('/api/lab/assistants/issue',{id:'lab',label:'ending',seats:[1],scopes:['status:read'],minutes:5,templates:[]},{'x-admin-token':'fixture-admin'});
 ok(last.status===200,'last scoped credential issued');const eh={'x-lab-assistant':last.body.token};
 await fx('fxStop');ok((await api('/api/lab/assistant/status',{},eh)).status>=400,'end tombstone blocks helper before provider cleanup');
 ok((await api('/api/lab/assistants/issue',{id:'lab',label:'late',seats:[1],scopes:['status:read'],minutes:5,templates:[]},{'x-admin-token':'fixture-admin'})).status>=400,'end tombstone prevents new grants');
 await fx('fxClose');const ended=await fx('fxInfo');ok(!ended['labhelp:lab']&&!ended['labassist-msg:lab'],'class ending removes questions and targeted messages');
 const page=await api('/lab/assistant',{},{} ,'GET');ok(page.status===200&&page.headers.get('cache-control')==='no-store','helper page no-store');
 console.log('PASS assistant actual Worker/SQLite',count,'checks');
}catch(e){console.error(log.slice(-1200));throw e}finally{await stop()}
console.log('Synthetic fixture evidence retained:',TMP);
