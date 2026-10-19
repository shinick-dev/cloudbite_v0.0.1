// Real gateway/packet code with controlled embeddings. No model-generated Python or external sandbox is executed.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
const tmp = mkdtempSync(join(tmpdir(), 'cloudbite-v8-'));
const b = await build({ stdin: { contents: `export { CloudbiteProject } from './src/cloudbite-project.ts';
export { CORPUS } from './src/cloudbite-corpus.generated.ts'; export * from './src/cloudbite-evidence-packet.ts';
export * from './src/cloudbite-corpus-evidence.ts'; export * from './src/cloudbite-claim-support.ts';
export { CB_RUNNER_PY } from './src/cloudbite-runner.ts';`, loader: 'ts', resolveDir: process.cwd() }, bundle: true,
  format: 'esm', platform: 'node', write: false, plugins: [{ name: 'cf', setup(b) {
    b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'cf', namespace: 'stub' }));
    b.onLoad({ filter: /^cf$/, namespace: 'stub' }, () => ({ contents: 'export class DurableObject { constructor(ctx,env){this.ctx=ctx;this.env=env;} }' }));
  } }] });
writeFileSync(join(tmp, 'm.mjs'), b.outputFiles[0].text);
const M = await import(pathToFileURL(join(tmp, 'm.mjs')));
const hash = s => createHash('sha256').update(s).digest('hex');
const token = 'cbw_' + 'A'.repeat(43), role = M.CORPUS.sources[0].roles[0];
const source = M.CORPUS.sources.find(s => s.roles.includes(role));
const chunk = M.CORPUS.chunks.find(c => c.sourceId === source.id);
assert.ok(chunk);
function world() {
  const m = new Map(); let q = Promise.resolve();
  const clone = x => x === undefined ? x : structuredClone(x);
  const storage = {
    async get(k) { return Array.isArray(k) ? new Map(k.filter(x => m.has(x)).map(x => [x, clone(m.get(x))])) : clone(m.get(k)); },
    async put(k,v) { for (const [key,value] of typeof k === 'string' ? [[k,v]] : Object.entries(k)) m.set(key,clone(value)); },
    transaction(f) { const r=q.then(()=>f(storage)); q=r.catch(()=>{}); return r; },
  };
  const brief = { objective: 'Decide the smallest useful timing closure experiment.', context: 'An educational project.', expertIds: [role], mode: 'live', requestId: 'v8-test' };
  m.set('project', { id: 'cb'+'a'.repeat(32), brief, status: 'running', runs: ['e0'] });
  m.set('expert:e0', { run: { id: 'e0', expertId: role, activity: [] }, int: { phase: 'running', capHash: hash(token), capExp: Date.now()+60_000, corpusIndex: M.CORPUS.sha256, seq: 0 } });
  return { m, brief, object: new M.CloudbiteProject({ storage }, { CLOUDBITE_EMBEDDING_API_KEY: 'SECRET-EMBEDDING-KEY' }) };
}
let calls=0, hold=null;
globalThis.fetch = async (url, init) => {
  assert.equal(url, 'https://api.openai.com/v1/embeddings'); calls++;
  assert.equal(new Headers(init.headers).get('authorization'), 'Bearer SECRET-EMBEDDING-KEY');
  if (hold) await hold;
  return Response.json({ object: 'list', model: M.CORPUS.model, data: [{ object: 'embedding', index: 0, embedding: chunk.vector }], usage: { total_tokens: 5 } });
};
const query = { query: source.title, indexSha256: M.CORPUS.sha256 };
const w=world();
assert.equal((await w.object.worker('e0','bad','corpus',query)).status,401);
assert.equal((await w.object.worker('e1',token,'corpus',query)).status,401);
assert.equal((await w.object.worker('e0',token,'corpus',{...query,indexSha256:'f'.repeat(64)})).status,409);
assert.equal((await w.object.worker('e0',token,'corpus',{...query,query:'x'.repeat(1001)})).status,400);
assert.equal(calls,0);
const result=await w.object.worker('e0',token,'corpus',query);
assert.ok(result.hits.length>0);
assert.equal(result.strategy,'hybrid-rrf/v1');
assert.equal(w.m.get('corpus:e0').length,1);
assert.equal(JSON.stringify(w.m.get('corpus:e0')).includes('SECRET'),false);
assert.equal(JSON.stringify(w.m.get('corpus:e0')).includes(source.title),false,'receipt retains IDs, not query or source text');
for(let i=1;i<7;i++) assert.ok((await w.object.worker('e0',token,'corpus',query)).hits.length);
assert.equal((await w.object.worker('e0',token,'corpus',query)).status,429);
assert.equal(calls,7);
// Concurrent reservation and cancellation during network I/O cannot publish a stale receipt/reply.
let release; hold=new Promise(r=>release=r);
const c=world(), pending=c.object.worker('e0',token,'corpus',query);
while(calls<8) await new Promise(r=>setTimeout(r,1));
assert.equal((await c.object.worker('e0',token,'corpus',query)).status,429);
c.m.get('project').status='cancelled'; release(); hold=null;
assert.equal((await pending).status,410);
assert.equal(c.m.has('corpus:e0'),false);
const exp=world(); exp.m.get('expert:e0').int.capExp=Date.now()-1;
assert.equal((await exp.object.worker('e0',token,'corpus',query)).status,401);
console.log('PASS gateway: identity, body bounds, receipt, durable 7-search cap, concurrent reservation, cancellation, expiry');
// Only server-held receipts can resolve original text, never a claim copied into the runner audit.
const first=result.hits[0], opinion={ direction:'conditional', confidence:65, summary:'Try a bounded experiment.', evidence:[`Check the method [source:${first.sourceId}]`], assumptions:[], nextActions:['Compare the baseline.'] };
const input={brief:w.brief,expertId:role,opinion,pack:null};
const forged=M.buildEvidencePacket({...input,audit:{originalCorpus:[result]}});
assert.equal(forged.references[0].availability,'unknown-id');
const receipt=M.corpusReceipt(result);
const packet=M.buildEvidencePacket({...input,corpusReceipts:[receipt]});
assert.equal(packet.references[0].availability,'original-corpus-text');
assert.ok(packet.originals.some(c=>c.sha256===first.sha256 && c.text===first.text));
assert.equal(packet.originalSourceTextFetched,false,'offline imported excerpt does not claim a new page fetch');
assert.ok(packet.bytes<=12*1024);
const support=M.buildClaimSupportContext(w.brief,[{expertId:role,opinion}],[packet]);
assert.ok(support.passages.some(p=>p.kind==='original-corpus' && p.textOrigin==='imported-original-excerpt'));
const tampered=M.buildEvidencePacket({...input,corpusReceipts:[{...receipt,indexSha256:'f'.repeat(64)}]});
assert.equal(tampered.references[0].availability,'unknown-id');
const wrong=M.buildEvidencePacket({...input,corpusReceipts:[{...receipt,hits:receipt.hits.map(h=>({...h,sha256:'f'.repeat(64)}))}]});
assert.equal(wrong.references[0].availability,'unknown-id');
assert.equal(M.corpusEvidence('not-a-role',[receipt]).length,0);
const small=M.buildEvidencePacket({...input,corpusReceipts:[receipt]},1700);
assert.ok(small.bytes<=1700);
console.log('PASS evidence: forged audit ignored; exact receipt/role/index/hash binding, claim-support originals, packet byte bounds');
// Run only our static Python harness; actual model-created Python remains inside Daytona.
writeFileSync(join(tmp,'runner.py'),M.CB_RUNNER_PY);
writeFileSync(join(tmp,'result.json'),JSON.stringify(result));
const py=`import runpy,json,os\nn=runpy.run_path('runner.py')\ng=n['corpus_search'].__globals__\ng['cap']={'corpus':{'indexSha256':${JSON.stringify(M.CORPUS.sha256)}}}\nr=json.load(open('result.json',encoding='utf-8'))\ng['post']=lambda *a,**k:r\nx=g['corpus_search']('timing closure')\nassert x['matched']\nassert r['hits'][0]['sourceId'] in g['retrieved_sources']\nassert len(g['corpus_trace'])==1\ng['retrieved_sources'].clear()\nr['hits'][0]['text']+='tampered'\ny=g['corpus_search']('timing closure')\nassert not y['matched']\nassert not g['retrieved_sources']\nprint('PASS Python runner: returned original citations unlocked; tampered excerpt rejected')\n`;
writeFileSync(join(tmp,'harness.py'),py);
const p=spawnSync('python',['-B','harness.py'],{cwd:tmp,encoding:'utf8',timeout:20_000});
assert.equal(p.status,0,p.stdout+p.stderr); process.stdout.write(p.stdout);
