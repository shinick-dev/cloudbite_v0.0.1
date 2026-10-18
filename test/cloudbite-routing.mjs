import assert from 'node:assert/strict';
import vm from 'node:vm';
import { build } from 'esbuild';
import { jevFixtureResponse } from './helpers/cloudbite-jev-provider.mjs';
const b = await build({stdin:{contents:"export * from './src/cloudbite-routing.ts'; export {CLOUDBITE_EXPERTS} from './src/cloudbite-personas.ts'; export {CLOUDBITE_JS} from './src/cloudbite-page.ts'; export * from './src/cloudbite-catalogue-limits.ts'; export {CB_MAX_EXPERTS} from './src/cloudbite-config.ts'",resolveDir:process.cwd(),loader:'ts'},bundle:true,write:false,platform:'node',format:'esm'});
const m = await import('data:text/javascript;base64,'+Buffer.from(b.outputFiles[0].text).toString('base64'));
const experts=m.CLOUDBITE_EXPERTS;
const q=(over={})=>({title:'Routing question',objective:'Plan frontend and backend delivery for the project.',context:'Small team, four weeks.',requestId:'routing-test-001',...over});
const good={'cb-role-022':0.94,'cb-role-023':0.79};
const reply=data=>new Response(JSON.stringify(data),{headers:{'content-type':'application/json'}});
const body=init=>JSON.parse(init.body);
const fake=(scores=good,options={})=>async (_url,init)=>reply(jevFixtureResponse(body(init),{relevance:scores,...options}));
const ask=(transport=fake(),max=5)=>m.askJev(q(),experts,'TEST-KEY',max,'a'.repeat(64),1000,transport);
function storage(){const data=new Map();let alarm=null,queue=Promise.resolve();return {data,async get(k){return structuredClone(data.get(k));},async put(k,v){data.set(k,structuredClone(v));},async delete(k){return data.delete(k);},async getAlarm(){return alarm;},async setAlarm(t){alarm=t;},transaction(fn){const p=queue.then(()=>fn(this));queue=p.catch(()=>{});return p;}};}
let passed=0;const test=async(name,fn)=>{await fn();passed++;console.log('ok '+name);};
await test('assessment includes every real candidate and project perspectives, never full expert prompts or keys',()=>{
 const request=m.jevRoutingRequest(q(),experts);
 assert.equal(Object.keys(request.questions).filter(id=>id.startsWith('fit:')).length,experts.length);assert.ok(experts.length>=100);
 assert.ok(Object.keys(request.questions).some(id=>id.startsWith('need:')));
 assert.deepEqual(request.state.request,{title:q().title,objective:q().objective,context:q().context});
 assert.ok(!JSON.stringify(request).includes(experts[0].prompt));assert.ok(!JSON.stringify(request).includes('TEST-KEY'));
});
await test('two-stage composition preserves relevance order, v2 provenance and a lower actor cap',async()=>{
 let calls=0;const transport=async(url,init)=>{calls++;return fake()(url,init);};
 const r=await ask(transport);assert.equal(r.policyVersion,'jev-routing/v2');assert.equal(r.harness.version,'project-team/v1');assert.equal(r.harness.peerReview,'not-performed');
 assert.deepEqual(r.expertIds,['cb-role-022','cb-role-023']);assert.equal(calls,2);
 assert.equal((await ask(fake(),1)).expertIds.length,1);
});
await test('no match fails before any team-review call and never fabricates a substitute',async()=>{
 let calls=0;const r=await ask(async(u,i)=>{calls++;return fake({})(u,i);});assert.equal(r.status,422);assert.equal(calls,1);assert.equal(r.expertIds,undefined);
});
await test('broad nonredundant projects can select 100; routing cache binds actor limits',async()=>{
 const scores=Object.fromEntries(experts.map(e=>[e.id,0.9]));
 assert.equal((await ask(fake(scores),100)).expertIds.length,100);
 assert.equal((await ask(fake(scores),12)).expertIds.length,12);
 const router=new m.RoutingSession(storage(),experts,'TEST-KEY',()=>10000,fake(scores));
 const decision=await router.plan(q(),100);assert.equal(decision.expertIds.length,100);assert.deepEqual(await router.read(q(),100),decision);
 assert.equal((await router.read(q(),5)).status,409);
 for(const limit of [0,101,1.5])assert.equal((await router.plan(q(),limit)).status,400);
});
await test('malformed assessment: missing, extra, wrong types/probabilities/model rejected',async()=>{
 const mutations=[d=>{delete d.answers[Object.keys(d.answers)[0]];},d=>{d.answers.extra={type:'noul',noul:1};},d=>{d.model='jev-TEST-KEY';},...[-0.1,1.01,'0.9',null].map(n=>d=>{d.answers['fit:'+experts[0].id].noul=n;}),d=>{d.answers['fit:'+experts[0].id].type='choice';}];
 for(const mutate of mutations){const r=await ask(async(_u,init)=>{const d=jevFixtureResponse(body(init),{relevance:good});mutate(d);return reply(d);});assert.equal(r.status,502);assert.ok(!JSON.stringify(r).includes('TEST-KEY'));}
});
await test('a broken team-review response cannot publish a partial assessment as an executable team',async()=>{
 let calls=0;const s=storage();const router=new m.RoutingSession(s,experts,'TEST-KEY',()=>10000,async(u,init)=>{calls++;return calls%2?fake()(u,init):reply({model:m.JEV_MODEL,answers:{bad:{type:'noul',noul:1}}});});
 assert.equal((await router.plan(q(),5)).status,502);assert.equal((await router.read(q(),5)).status,409);assert.equal(calls,2);
 assert.ok([...s.data.values()].every(v=>!JSON.stringify(v).includes('TEST-KEY')));
});
await test('second-stage provider errors are explicit, redacted and leave no fallback decision',async()=>{
 for(const status of [401,429,500]){let calls=0;const r=await ask(async(u,init)=>++calls===1?fake()(u,init):new Response('TEST-KEY private trace',{status}));assert.equal(r.status,status===429?429:503);assert.equal(r.expertIds,undefined);assert.ok(!JSON.stringify(r).includes('TEST-KEY'));}
});
await test('missing config, invalid/oversized bodies, transport errors and fixed endpoint/deadline',async()=>{
 assert.equal((await m.askJev(q(),experts,'',5,'h',0,()=>{throw Error('must not call');})).status,503);
 for(const text of ['not json','x'.repeat(256*1024+1)])assert.equal((await ask(async()=>new Response(text))).status,502);
 assert.equal((await ask(async()=>{throw Error('TEST-KEY network');})).status,503);
 await ask(async(url,init)=>{assert.equal(url,'https://api.typesafe.ai/v1/systemone');assert.equal(init.headers.authorization,'Bearer TEST-KEY');assert.ok(init.signal);assert.equal(body(init).model,m.JEV_MODEL);return fake()(url,init);});
});
await test('completed two-stage decision is cached once, edited questions and other actors cannot reuse it',async()=>{
 let calls=0,now=10000;const s=storage(),transport=async(u,i)=>{calls++;return fake()(u,i);};const router=new m.RoutingSession(s,experts,'TEST-KEY',()=>now,transport);
 const first=await router.plan(q(),5);assert.equal(first.provider,'typesafe');assert.deepEqual(await router.plan(q(),5),first);assert.deepEqual(await router.read(q(),5),first);assert.equal(calls,2);
 assert.equal((await router.plan(q({objective:'Different question'}),5)).status,409);assert.equal((await router.read(q(),2)).status,409);
 const other=new m.RoutingSession(storage(),experts,'TEST-KEY',()=>now,transport);assert.equal((await other.read(q(),5)).status,409);
 assert.ok(!JSON.stringify([...s.data]).includes(q().objective));assert.ok(!JSON.stringify([...s.data]).includes('TEST-KEY'));
 now+=m.ROUTING_TTL+1;assert.equal((await router.read(q(),5)).status,409);await router.cleanup();assert.equal(await s.get('routing:state'),undefined);
});
await test('one durable claim covers a pending second call and does not resubmit either stage',async()=>{
 let release,reached,calls=0;const entered=new Promise(r=>{reached=r;});const transport=async(u,i)=>{calls++;if(calls===2){reached();await new Promise(r=>{release=r;});}return fake()(u,i);};
 const router=new m.RoutingSession(storage(),experts,'TEST-KEY',()=>10000,transport);const first=router.plan(q(),5);await entered;
 assert.equal((await router.plan(q(),5)).status,409);assert.equal(calls,2);release();assert.equal((await first).provider,'typesafe');assert.equal(calls,2);
});
await test('stale completion cannot overwrite a new two-stage plan after claim expiry',async()=>{
 let now=10000,release,reached,calls=0;const entered=new Promise(r=>{reached=r;});const s=storage();
 const router=new m.RoutingSession(s,experts,'TEST-KEY',()=>now,async(u,i)=>{if(++calls===1){reached();await new Promise(r=>{release=r;});return fake()(u,i);}return fake({'cb-role-023':0.98})(u,i);});
 const old=router.plan(q(),5);await entered;now+=51000;const current=await router.plan(q(),5);assert.equal(current.provider,'typesafe');release();assert.equal((await old).status,409);assert.deepEqual((await router.read(q(),5)).expertIds,current.expertIds);
});
await test('rate cap counts at most six routing attempts, cached two-stage results incur no new calls',async()=>{
 let calls=0;const router=new m.RoutingSession(storage(),experts,'TEST-KEY',()=>10000,async(u,i)=>{calls++;return fake()(u,i);});
 for(let i=0;i<6;i++)assert.equal((await router.plan(q({requestId:`rate-test-${i}`}),5)).provider,'typesafe');
 assert.equal((await router.plan(q({requestId:'rate-test-7'}),5)).status,429);assert.equal((await router.plan(q({requestId:'rate-test-0'}),5)).provider,'typesafe');assert.equal(calls,12);
});
await test('catalogue scope/category and special request IDs remain hash-bound and prototype-safe',async()=>{
 const router=new m.RoutingSession(storage(),experts,'TEST-KEY',()=>10000,fake());
 for(const requestId of ['__proto__','constructor'])assert.equal((await router.plan(q({requestId}),5)).provider,'typesafe');
 const altered=experts.map((e,i)=>i?e:{...e,domain:'a-new-domain'});
 assert.notEqual(await m.routingQueryHash(q(),experts,5),await m.routingQueryHash(q(),altered,5));assert.equal(({}).result,undefined);
});
await test('actual engine metadata is accepted by the console across coverage, gaps, no-perspective and actor limits', async()=>{
 let core;vm.runInNewContext(m.CLOUDBITE_JS,{__cloudbiteTestHook:c=>{core=c;},crypto:globalThis.crypto});
 const allowed=experts.map(e=>e.id);
 for(const options of [{},{needs:{architecture:0.9},coverage:{architecture:'role_1'}},{needs:{privacy:0.95}},{needs:{architecture:0.9,implementation:0.85},coverage:{architecture:'role_1',implementation:'role_2'}}]){
  const result=await ask(fake(good,options),1);assert.equal(result.policyVersion,'jev-routing/v2');assert.ok(core.normalizeRoute(result,allowed,1),JSON.stringify(result.harness));
 }
});
// The worktree runtime may still hold 100 roles; synthesise the extra catalogue entries from real definitions.
const grown=n=>[...experts,...Array.from({length:n-experts.length},(_,i)=>({...experts[i%experts.length],id:`cb-role-${experts.length+i+1}`,name:`Catalogue role ${experts.length+i+1}`}))];
await test('catalogue bound 200 is separate from the 100-expert selection bound',async()=>{
 assert.equal(m.CATALOGUE_MAX_ROLES,200);assert.equal(m.PROJECT_MAX_EXPERTS,100);assert.equal(m.CB_MAX_EXPERTS,m.PROJECT_MAX_EXPERTS);
 const cat=grown(120);
 const request=m.jevRoutingRequest(q(),cat);const fits=Object.keys(request.questions).filter(id=>id.startsWith('fit:'));
 assert.equal(fits.length,120);assert.ok(fits.includes('fit:cb-role-120'),'role 120 is assessed, not truncated');
 assert.equal(m.routingCandidates(cat).length,120);
 // A role past the first 100 can win on its own merits; more than 100 exclusions are kept
 const late=await m.askJev(q(),cat,'TEST-KEY',5,'a'.repeat(64),1000,fake({'cb-role-120':0.97}));
 assert.deepEqual(late.expertIds,['cb-role-120']);assert.equal(late.evaluatedCount,120);assert.equal(late.harness.excluded.length,119);
 // Everything relevant: still at most 100 selected, the rest are explicit limit exclusions
 const all=await m.askJev(q(),cat,'TEST-KEY',100,'a'.repeat(64),1000,fake(Object.fromEntries(cat.map(e=>[e.id,0.9]))));
 assert.equal(all.expertIds.length,100);assert.equal(all.harness.eligibleCount,120);
 assert.equal(all.harness.excluded.filter(e=>e.reason==='limit').length,20);assert.ok(all.harness.warnings.includes('actor-limit'));
 let core;vm.runInNewContext(m.CLOUDBITE_JS,{__cloudbiteTestHook:c=>{core=c;},crypto:globalThis.crypto});
 const ids=cat.map(e=>e.id);
 assert.equal(core.normalizeRoute(late,ids,5).harness.excluded.length,119,'console keeps >100 exclusions');
 assert.equal(core.normalizeRoute(all,ids,100).expertIds.length,100,'console accepts a 120-role v2 decision');
 for(const limit of [101,120])assert.equal((await m.askJev(q(),cat,'TEST-KEY',limit,'h',0,()=>{throw Error('must not call');})).status,400);
 const router=new m.RoutingSession(storage(),cat,'TEST-KEY',()=>10000,fake(Object.fromEntries(cat.map(e=>[e.id,0.9]))));
 assert.equal((await router.plan(q(),100)).expertIds.length,100);assert.equal((await router.plan(q({requestId:'routing-test-101'}),101)).status,400);
});
await test('a catalogue above 200 fails explicitly before any provider call instead of a silent prefix',async()=>{
 let calls=0;const r=await m.askJev(q(),grown(201),'TEST-KEY',5,'h',0,async()=>{calls++;throw Error('must not call');});
 assert.equal(r.status,503);assert.equal(calls,0);assert.equal(r.expertIds,undefined);
 assert.equal((await m.askJev(q(),grown(200),'TEST-KEY',5,'h',0,fake({'cb-role-200':0.9}))).expertIds[0],'cb-role-200');
});
await test('decision fields and full document contents reach Jev, and any evidence change invalidates the cached decision', async()=>{
 const decision={options:['Pilot','Postpone'],constraints:['Two weeks'],successCriteria:['Reproducible review'],knownFacts:['No private data'],assumptions:['Teams will return'],unknowns:['Willingness to pay']};
 const documents=[{id:'doc-1',name:'scope.md',content:'Synthetic source: pilot two weeks.'}];
 const query=q({decision,documents});
 assert.deepEqual(m.routingQuery(query),query);
 const request=m.jevRoutingRequest(query,experts);assert.deepEqual(request.state.request.decision,decision);assert.deepEqual(request.state.request.documents,documents);
 const base=await m.routingQueryHash(query,experts,5);
 assert.notEqual(base,await m.routingQueryHash(q(),experts,5));
 assert.notEqual(base,await m.routingQueryHash({...query,documents:[{...documents[0],content:'Changed budget'}]},experts,5));
 assert.notEqual(base,await m.routingQueryHash({...query,decision:{...decision,assumptions:['Different premise']}},experts,5));
 const router=new m.RoutingSession(storage(),experts,'TEST-KEY',()=>10000,fake());
 assert.ok((await router.plan(query,5)).expertIds.length);
 assert.equal((await router.read({...query,documents:[{...documents[0],content:'Changed'}]},5)).status,409);
 assert.equal(m.routingQuery({...query,documents:[{...documents[0],id:'doc-99'}]}).status,400);
 assert.equal(m.routingQuery({...query,decision:{...decision,secret:'instruction'}}).status,400);
});
console.log(`cloudbite-routing: ${passed} checks passed`);
