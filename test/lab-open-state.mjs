// Real State + WebAuthn signatures; fake external billing/sandbox services only.
import assert from 'node:assert/strict';
import {generateKeyPair,exportJWK,SignJWT} from 'jose';
const ownerPair=await generateKeyPair('RS256'),ownerJwk=await exportJWK(ownerPair.publicKey);ownerJwk.kid='owner-fixture';
const ownerEnv={LAB_OPEN_ACCESS_TEAM:'https://fixture.cloudflareaccess.com',LAB_OPEN_AUDIENCE:'request-inbox',LAB_OPEN_OWNER_EMAIL:'owner@example.test'};
const ownerToken='owner:'+await new SignJWT({email:ownerEnv.LAB_OPEN_OWNER_EMAIL}).setProtectedHeader({alg:'RS256',kid:'owner-fixture'}).setIssuer(ownerEnv.LAB_OPEN_ACCESS_TEAM).setAudience(ownerEnv.LAB_OPEN_AUDIENCE).setSubject('owner').setIssuedAt().setExpirationTime('24h').sign(ownerPair.privateKey);
import {build} from 'esbuild';
import {generateKeyPairSync,createHash,randomBytes,sign,createECDH} from 'node:crypto';
import {isoCBOR} from '@simplewebauthn/server/helpers';
const built=await build({entryPoints:['src/state.ts'],bundle:true,write:false,platform:'node',format:'esm',external:['cloudflare:workers'],logLevel:'silent'});
const code=built.outputFiles[0].text.replace(/import\s*\{\s*DurableObject\s*\}\s*from\s*["']cloudflare:workers["'];?/,'class DurableObject {constructor(ctx,env){this.ctx=ctx;this.env=env;}}');
const {State,sha}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
const hash=x=>createHash('sha256').update(x).digest(),b64=x=>Buffer.from(x).toString('base64url');
let checks=0;const check=(name,value)=>{assert.ok(value,name);checks++;console.log('ok '+name)};
function memory(){const data=new Map(),copy=x=>x===undefined?x:structuredClone(x);let lock=Promise.resolve();return {data,
 async get(k){return Array.isArray(k)?new Map(k.filter(x=>data.has(x)).map(x=>[x,copy(data.get(x))])):copy(data.get(k))},
 async put(k,v){if(typeof k==='object')for(const[a,b]of Object.entries(k))data.set(a,copy(b));else data.set(k,copy(v))},
 async delete(k){let n=0;for(const x of Array.isArray(k)?k:[k])n+=data.delete(x)?1:0;return n},
 async list({prefix='',limit=Infinity}={}){return new Map([...data].filter(([k])=>k.startsWith(prefix)).slice(0,limit).map(([k,v])=>[k,copy(v)]))},
 async getAlarm(){return null},async setAlarm(){},transaction(fn){const p=lock.then(()=>fn(this));lock=p.catch(()=>{});return p}}}
class Key {
 constructor(){const pair=generateKeyPairSync('ec',{namedCurve:'P-256'});this.private=pair.privateKey;const j=pair.publicKey.export({format:'jwk'});this.id=b64(randomBytes(16));this.cose=b64(isoCBOR.encode(new Map([[1,2],[3,-7],[-1,1],[-2,Buffer.from(j.x,'base64url')],[-3,Buffer.from(j.y,'base64url')]])));this.counter=0}
 get(options,uv=true){const cd=Buffer.from(JSON.stringify({type:'webauthn.get',challenge:options.challenge,origin:'https://manager.invalid',crossOrigin:false}));const ctr=Buffer.alloc(4);ctr.writeUInt32BE(++this.counter);const ad=Buffer.concat([hash(options.rpId),Buffer.from([uv?5:1]),ctr]);return {id:this.id,rawId:this.id,type:'public-key',response:{clientDataJSON:b64(cd),authenticatorData:b64(ad),signature:b64(sign('sha256',Buffer.concat([ad,hash(cd)]),this.private))},clientExtensionResults:{}}}
}
async function world(){const storage=memory(),key=new Key(),effects=[],background=[];const master=randomBytes(32),env={ORIGIN:'https://manager.invalid',RP_ID:'manager.invalid',LAB_ORIGIN:'https://lab.invalid',LAB_SEAT_DOMAIN:'seat.invalid',LAB_GW:'https://gw.invalid',MASTER_KEY:b64(master),...ownerEnv};
 await storage.put('mig:grants',true);await storage.put('cred:'+key.id,{id:key.id,publicKey:key.cose,counter:0,label:'fixture',createdAt:Date.now()});await storage.put('admin:'+await sha('admin'),{expiresAt:Date.now()+28800000,createdAt:Date.now(),src:'web',credentialId:key.id});
 const iv=randomBytes(12),aes=await crypto.subtle.importKey('raw',master,'AES-GCM',false,['encrypt']);const ct=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:new TextEncoder().encode('prov:openrouter')},aes,new TextEncoder().encode('fixture-management-key'));
 await storage.put('prov:openrouter',{id:'openrouter',kind:'openrouter-mint',upstream:'https://openrouter.ai',label:'fixture',auth:'bearer',envKey:'OPENROUTER_API_KEY',iv:b64(iv),ct:b64(ct),last4:'fake',updatedAt:Date.now(),gen:'fixture-generation'});
 const sandboxes=new Map();let hold=null,afterCreate=null,snapshotReady=true;
 globalThis.fetch=async(input,init={})=>{const u=new URL(input),method=init.method??'GET';
  if(u.host==='fixture.cloudflareaccess.com')return Response.json({keys:[ownerJwk]});
  if(u.host==='daytona.invalid'&&u.pathname.startsWith('/snapshots/')&&method==='GET'){
   const name=decodeURIComponent(u.pathname.split('/').pop()),m=name.match(/-([0-9]+)c([0-9]+)g([0-9]+)d$/);
   if(m&&!snapshotReady)return Response.json({error:'not found'},{status:404});
   return Response.json({state:'active',cpu:m?Number(m[1]):1,mem:m?Number(m[2]):2,disk:m?Number(m[3]):5,buildInfo:{dockerfileContent:'FROM ubuntu:24.04'}});
  }
  if(u.host==='daytona.invalid'&&u.pathname==='/snapshots'&&method==='POST'){effects.push({kind:'snapshot',body:JSON.parse(init.body)});return Response.json({ok:true})}
  if(u.host==='openrouter.ai'&&u.pathname==='/api/v1/keys'&&method==='POST'){effects.push({kind:'mint'});return Response.json({key:'fixture-subkey',data:{hash:'fixture-hash'}})}
  if(u.host==='openrouter.ai'&&method==='DELETE')return Response.json({});
  if(u.host==='daytona.invalid'&&u.pathname==='/sandbox'&&method==='POST'){const body=JSON.parse(init.body),id='sb-'+sandboxes.size;const sb={id,state:'started',toolboxProxyUrl:'https://toolbox.invalid'};sandboxes.set(id,sb);effects.push({kind:'sandbox',body,id});if(afterCreate)await afterCreate();if(hold)await hold;return Response.json(sb)}
  if(u.host==='daytona.invalid'&&u.pathname.startsWith('/sandbox/')){if(method==='DELETE'){sandboxes.delete(u.pathname.split('/')[2]);return Response.json({})}return Response.json(sandboxes.get(u.pathname.split('/')[2])??{id:u.pathname.split('/')[2],state:'started',toolboxProxyUrl:'https://toolbox.invalid'})}
  if(u.host==='toolbox.invalid')return Response.json({exitCode:0,result:'200'});
  throw new Error('unexpected external fetch '+u.href);
 };
 class Fixture extends State {async daytona(){return {api:'https://daytona.invalid',key:'fixture'}}async modelExists(){return true}}
 const fresh=()=>new Fixture({storage,waitUntil:p=>background.push(p),blockConcurrencyWhile:f=>f()},env);const state=fresh();
 const submit=async(mode='practice')=>{const input={id:crypto.randomUUID(),secret:b64(randomBytes(32)),issuedAt:Date.now(),mode,name:'연습 참여자',purpose:'가상 메모 복습'};const r=await state.labOpenSubmit(input,'fixture-source');assert.ok(!r.error,JSON.stringify(r));return input};
 return {storage,key,effects,background,state,fresh,submit,env,set snapshotReady(v){snapshotReady=v},set afterCreate(f){afterCreate=f},set hold(p){hold=p}};
}
{
 const w=await world(),savedConfig={snapshot:'custom-snapshot',model:'fixture/model',gw:'https://gw.invalid'};await w.storage.put('labcfg',savedConfig);const r=await w.submit(),choice={hours:1,budget:1};check('a request creates no cloud resources',w.effects.length===0);
 check('inbox requires admin',(await w.state.labOpenList('bad')).status===401);check('request secret required',(await w.state.labOpenStatus(r.id,b64(randomBytes(32)))).status>=400);
 const options=await w.state.labOpenOptions('admin',r.id,choice,'fixture-source');assert.ok(options.challenge,JSON.stringify(options));
 const wrong=await w.state.labOpenApprove('admin',r.id,{hours:2,budget:1},w.key.get(options));check('key assertion cannot approve changed time/limits',wrong.status===401&&w.effects.length===0);
 const o=await w.state.labOpenOptions('admin',r.id,choice,'fixture-source');const assertion=w.key.get(o);const approved=await w.state.labOpenApprove('admin',r.id,choice,assertion);assert.equal(approved.state,'ready',JSON.stringify(approved));
 check('real signed approval provisions one seat exactly',w.effects.filter(e=>e.kind==='sandbox').length===1&&w.effects.filter(e=>e.kind==='mint').length===1);
 check('practice uses known standard snapshot and preserves shared defaults',w.effects.find(e=>e.kind==='sandbox').body.snapshot==='gw-lab-v5-1c2g'&&JSON.stringify(await w.storage.get('labcfg'))===JSON.stringify(savedConfig));
 const status=await w.state.labOpenStatus(r.id,r.secret);check('only requester gets a seat entry code',status.state==='ready'&&status.result.seatCode.length===16);
 const listed=await w.state.labOpenList('admin');check('manager inbox excludes requester secret and seat code',!JSON.stringify(listed).includes(r.secret)&&!JSON.stringify(listed).includes(status.result.seatCode));
 check('same assertion cannot replay approval',(await w.state.labOpenApprove('admin',r.id,choice,assertion)).status===401);
 await w.fresh().labOpenResume('admin',r.id);check('restarted result lookup never provisions twice',w.effects.filter(e=>e.kind==='sandbox').length===1);
 const lab=await w.storage.get('lab:'+status.result.labId);lab.endRetry=1;await w.storage.put('lab:'+lab.id,lab);const ended=await w.state.labOpenStatus(r.id,r.secret);check('ending lab withdraws old requester entry link',ended.state==='expired'&&!ended.result);
 await Promise.allSettled(w.background);
}
{
 const w=await world(),until=Date.now()+1800000,old={n:1,code:'existing-seat-001',sandboxId:'old-sandbox',sid:'old-session',label:'a'.repeat(26),who:'기존 참여자',opened:Date.now(),setup:{state:'ok',at:Date.now(),note:'keep'}};
 const parent={id:'parent',name:'기존 모임',createdAt:Date.now(),expiresAt:until,budget:1,cpu:1,memory:2,disk:5,snapshot:'gw-lab-v5',model:'fixture/model',gw:'https://gw.invalid',clip:{in:true,out:true},seats:[old]};await w.storage.put('lab:parent',parent);
 const r=await w.submit('join'),choice={labId:'parent'},o=await w.state.labOpenOptions('admin',r.id,choice,'fixture-source');const approved=await w.state.labOpenApprove('admin',r.id,choice,w.key.get(o));assert.equal(approved.state,'ready',JSON.stringify(approved));
 const after=await w.storage.get('lab:parent');check('join appends one seat without changing existing participant work',after.seats.length===2&&JSON.stringify(after.seats[0])===JSON.stringify(old));
 check('join inherits parent end time and resources',after.expiresAt===until&&after.snapshot===parent.snapshot&&w.effects.filter(e=>e.kind==='sandbox')[0].body.labels['gw-lab']==='parent');
 const status=await w.state.labOpenStatus(r.id,r.secret);check('join gives only newly allocated seat',status.result.n===2&&status.result.seatCode!==old.code);
 await w.fresh().labOpenResume('admin',r.id);check('join replay cannot append another seat',(await w.storage.get('lab:parent')).seats.length===2&&w.effects.filter(e=>e.kind==='sandbox').length===1);
 await Promise.allSettled(w.background);
 check('background preparation preserves the original participant seat',JSON.stringify((await w.storage.get('lab:parent')).seats[0])===JSON.stringify(old));
 const parallel=await Promise.all([w.submit('join'),w.submit('join')]);const options=await Promise.all(parallel.map(x=>w.state.labOpenOptions('admin',x.id,choice,'fixture-source')));const proofs=options.map(o=>w.key.get(o));
 const joined=await Promise.all(parallel.map((x,i)=>w.state.labOpenApprove('admin',x.id,choice,proofs[i])));assert.ok(joined.every(x=>x.state==='ready'),JSON.stringify(joined));
 const seats=(await w.storage.get('lab:parent')).seats;check('simultaneous approved joins allocate distinct seat numbers',seats.length===4&&new Set(seats.map(s=>s.n)).size===4&&new Set(seats.map(s=>s.code)).size===4);
 await Promise.allSettled(w.background);
}
{
 const w=await world(),r=await w.submit(),choice={hours:1,budget:1},o=await w.state.labOpenOptions('admin',r.id,choice,'fixture-source');
 check('user verification flag required',(await w.state.labOpenApprove('admin',r.id,choice,w.key.get(o,false))).status===401&&w.effects.length===0);
 check('resume cannot bypass unapproved request',(await w.state.labOpenResume('admin',r.id)).status===409&&w.effects.length===0);
 await Promise.allSettled(w.background);
}
{
 const w=await world();check('missing VAPID is reported unavailable',(await w.state.labOpenPushConfig()).available===false);
 const vapid=generateKeyPairSync('ec',{namedCurve:'P-256'});w.env.TEACHER_PUSH_VAPID_JWK=JSON.stringify(vapid.privateKey.export({format:'jwk'}));
 check('valid configured VAPID exposes only availability/public key',(await w.state.labOpenPushConfig()).available===true);
 const client=createECDH('prime256v1');client.generateKeys();const subscription={endpoint:'https://fcm.googleapis.com/fcm/send/fixture-device',keys:{p256dh:b64(client.getPublicKey()),auth:b64(randomBytes(16))}};
 const options=await w.state.labOpenPushOptions('admin','fixture-source',subscription,'내 휴대폰');const assertion=w.key.get(options);
 const changed={...subscription,endpoint:'https://fcm.googleapis.com/fcm/send/different-device'};
 check('device enrollment key proof cannot be rebound to another endpoint',(await w.state.labOpenPushSubscribe('admin',changed,'내 휴대폰',assertion)).status===401);
 const o=await w.state.labOpenPushOptions('admin','fixture-source',subscription,'내 휴대폰');const registered=await w.state.labOpenPushSubscribe('admin',subscription,'내 휴대폰',w.key.get(o));
 check('real key proof registers a notification-only device',registered.ok===true&&(await w.state.labOpenPushStatus('admin',subscription.endpoint)).enabled===true);
 const subs=await w.storage.list({prefix:'labopen:pushsub:'});check('device subscription is sealed in real State storage',!JSON.stringify([...subs]).includes(subscription.endpoint)&&!JSON.stringify([...subs]).includes(subscription.keys.auth));
 await w.storage.delete('cred:'+w.key.id);check('deleted security key disables its notification registration',(await w.state.labOpenPushStatus('admin',subscription.endpoint)).enabled===false);
 await Promise.allSettled(w.background);
}
{
 const w=await world(),r=await w.submit(),choice={hours:1,budget:1};
 check('Access owner reads inbox without admin key login',Array.isArray((await w.state.labOpenList(ownerToken)).requests));
 check('owner-only inbox authority cannot call general lab creation',(await w.state.labCreate(ownerToken,{seats:1})).status===401&&w.effects.length===0);
 check('owner cannot resume pending unsigned request',(await w.state.labOpenResume(ownerToken,r.id)).status===409&&w.effects.length===0);
 const o=await w.state.labOpenOptions(ownerToken,r.id,choice,'fixture');
 check('Access identity alone cannot approve resources',(await w.state.labOpenApprove(ownerToken,r.id,choice,{})).status===401&&w.effects.length===0);
 const approved=await w.state.labOpenApprove(ownerToken,r.id,choice,w.key.get(o));
 check('single request-bound key tap creates seat without admin login',approved.state==='ready'&&w.effects.filter(x=>x.kind==='sandbox').length===1);
 check('approval response exposes no privileged admin token',!JSON.stringify(approved).includes('token'));
 await w.fresh().labOpenResume(ownerToken,r.id);
 check('Access owner resume preserves idempotent completed operation',w.effects.filter(x=>x.kind==='sandbox').length===1);
 await Promise.allSettled(w.background);
}
{
 const w=await world(),r=await w.submit(),choice={hours:1,budget:1,cpu:2,memory:4,disk:5};
 for(const field of ['cpu','memory','disk']){const o=await w.state.labOpenOptions(ownerToken,r.id,choice,'fixture');const result=await w.state.labOpenApprove(ownerToken,r.id,{...choice,[field]:choice[field]+1},w.key.get(o));check(field+' cannot change after request-bound key options',result.status===401&&w.effects.length===0)}
 for(const spec of [{cpu:2},{cpu:'2',memory:4,disk:5},{cpu:0,memory:4,disk:5},{cpu:1.5,memory:4,disk:5},{cpu:2,memory:-1,disk:5},{cpu:2,memory:4,disk:2147483648},{cpu:true,memory:4,disk:5}])check('malformed approval resources rejected '+JSON.stringify(spec),(await w.state.labOpenOptions(ownerToken,r.id,{hours:1,budget:1,...spec},'fixture')).status===400&&w.effects.length===0);
 const o=await w.state.labOpenOptions(ownerToken,r.id,choice,'fixture');const result=await w.state.labOpenApprove(ownerToken,r.id,choice,w.key.get(o));assert.equal(result.state,'ready',JSON.stringify(result));
 const status=await w.state.labOpenStatus(r.id,r.secret),lab=await w.storage.get('lab:'+status.result.labId);
 check('selected preset reaches stored lab and Daytona snapshot',lab.cpu===2&&lab.memory===4&&lab.disk===5&&w.effects.find(x=>x.kind==='sandbox').body.snapshot==='gw-lab-v5-2c4g');
 check('selected resources never overwrite shared defaults',await w.storage.get('labcfg')===undefined);
 await Promise.allSettled(w.background);
}
{
 const w=await world(),r=await w.submit(),choice={hours:2,budget:1,cpu:2,memory:8,disk:12};w.snapshotReady=false;
 const o=await w.state.labOpenOptions(ownerToken,r.id,choice,'fixture');const pending=await w.state.labOpenApprove(ownerToken,r.id,choice,w.key.get(o));
 check('custom spec prepares snapshot before sandbox or AI subkey',pending.state==='approving'&&pending.creation.snapshotPreparing===true&&w.effects.length===1&&w.effects[0].kind==='snapshot');
 check('snapshot request has exact approved CPU memory and disk',w.effects[0].body.cpu===2&&w.effects[0].body.mem===undefined&&w.effects[0].body.memory===8&&w.effects[0].body.disk===12);
 const changed={...choice,memory:4},different=await w.state.labOpenOptions(ownerToken,r.id,changed,'fixture');const rejected=await w.state.labOpenApprove(ownerToken,r.id,changed,w.key.get(different));
 check('even a fresh key cannot rewrite a frozen approved spec',rejected.status===409&&w.effects.length===1);
 w.snapshotReady=true;const ready=await w.fresh().labOpenResume(ownerToken,r.id);assert.equal(ready.state,'ready',JSON.stringify(ready));
 const status=await w.state.labOpenStatus(r.id,r.secret),lab=await w.storage.get('lab:'+status.result.labId);
 check('resumed custom spec reaches exact matching Daytona snapshot',lab.cpu===2&&lab.memory===8&&lab.disk===12&&w.effects.find(x=>x.kind==='sandbox').body.snapshot==='gw-lab-v5-2c8g12d');
 await w.fresh().labOpenResume(ownerToken,r.id);
 check('custom preparation and completed resume never create twice',w.effects.filter(x=>x.kind==='snapshot').length===1&&w.effects.filter(x=>x.kind==='sandbox').length===1);
 await Promise.allSettled(w.background);
}
{
 const w=await world();await w.storage.put('lab:parent',{id:'parent',name:'기존 모임',createdAt:Date.now(),expiresAt:Date.now()+3600000,budget:1,cpu:4,memory:8,disk:10,snapshot:'gw-lab-v5',seats:[]});const r=await w.submit('join');
 const list=await w.state.labOpenList(ownerToken);check('join approval displays inherited parent resources',list.labs[0].cpu===4&&list.labs[0].memory===8&&list.labs[0].disk===10);
 check('join rejects overriding existing group specs',(await w.state.labOpenOptions(ownerToken,r.id,{labId:'parent',cpu:2,memory:4,disk:5},'fixture')).status===400&&w.effects.length===0);
 await Promise.allSettled(w.background);
}
console.log('PASS lab-open State '+checks);
