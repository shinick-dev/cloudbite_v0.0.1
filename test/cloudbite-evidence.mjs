import assert from 'node:assert/strict';
import { build } from 'esbuild';
const b=await build({stdin:{contents:"export {evidenceClaims} from './src/cloudbite-evidence.ts'; export {CLOUDBITE_EXPERTS,phaseOnePack} from './src/cloudbite-personas.ts'",resolveDir:process.cwd(),loader:'ts'},bundle:true,write:false,platform:'node',format:'esm'});
const M=await import('data:text/javascript;base64,'+Buffer.from(b.outputFiles[0].text).toString('base64'));
const brief={title:'Pilot',objective:'Select a benchmark scope',context:'No manuscripts',expertIds:['cb-role-101'],mode:'live',requestId:'evidence-test-001',documents:[{id:'doc-1',name:'pilot.md',content:'Budget: two weeks.'}]};
const role=M.CLOUDBITE_EXPERTS.find(x=>x.id==='cb-role-101');
const source=M.phaseOnePack(role.id).sources[0].id;
const run=(status='completed',evidence=[])=>({id:'e0',expertId:role.id,name:role.name,status,activity:[],artifacts:[],updatedAt:1,opinion:{direction:'conditional',confidence:54,summary:'Pilot',evidence,assumptions:['Unknown effect size'],nextActions:['Collect evidence']}});
let n=0;const test=(name,fn)=>{fn();n++;console.log('ok',name)};
test('document source links to the actual project document, never means factual verification',()=>{
 const r=M.evidenceClaims(brief,[run('completed',['[doc:doc-1] Budget is stated as two weeks.'])]);
 assert.equal(r[0].status,'linked');assert.deepEqual(r[0].references,[{kind:'document',id:'doc-1',available:true}]);
 assert.equal(r[0].id,'e0-claim-0');assert.equal(r[0].expertId,role.id);
 assert.equal(r[0].verified,undefined);
});
test('known role source is structural catalogue availability, unknown sources stay unlinked',()=>{
 const r=M.evidenceClaims(brief,[run('completed',[`[source:${source}] method guidance`,'[source:invented] no basis'])]);
 assert.equal(r[0].status,'linked');assert.equal(r[1].status,'unlinked');assert.equal(r[1].references[0].available,false);
});
test('mixed supported/unknown references cannot hide a broken ID',()=>{
 const r=M.evidenceClaims(brief,[run('completed',['[doc:doc-1] + [doc:doc-9] mixed'])]);assert.equal(r[0].status,'unlinked');
 assert.deepEqual(r[0].references.map(x=>x.available),[true,false]);
});
test('unreferenced evidence is not silently considered sourced',()=>assert.equal(M.evidenceClaims(brief,[run('completed',['Trust me'])])[0].status,'unlinked'));
test('identical IDs deduplicated without stripping the original text',()=>{
 const text='[doc:doc-1] <script>payload</script> [doc:doc-1]';const r=M.evidenceClaims(brief,[run('completed',[text])]);assert.equal(r[0].text,text);assert.equal(r[0].references.length,1);
});
test('noncompleted opinions never enter final ledger and original objects remain unchanged',()=>{
 const experts=[run('failed',['[doc:doc-1] text']),run('running',['x'])];const before=structuredClone(experts);assert.deepEqual(M.evidenceClaims(brief,experts),[]);assert.deepEqual(experts,before);
});
test('cross-tenant or removed documents cannot be resolved through another source type',()=>{
 const r=M.evidenceClaims({...brief,documents:[]},[run('completed',['[doc:doc-1] removed'])]);assert.equal(r[0].status,'unlinked');
 const other=run('completed',[`[source:${source}] foreign source`]);other.expertId='demo-other';assert.equal(M.evidenceClaims(brief,[other])[0].status,'unlinked');
});
console.log(`cloudbite evidence: ${n} checks passed`);
