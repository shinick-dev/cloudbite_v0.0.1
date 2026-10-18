// Cloudbite runner finalization: the ACTUAL runner.py (CB_RUNNER_PY bundled from src/cloudbite-runner.ts by esbuild)
// runs against a local fake gateway with a scripted fake model. No provider network: only 127.0.0.1 is contacted.
// Covers last-turn final repair inside the existing maxCalls budget, honest hard failure with an allowlisted
// out/diagnostic.json, and the server-side rendering of that diagnostic (runnerFailureMessage).
//   node test/cloudbite-runner-finalization.mjs        (needs python3 or PYTHON=<path>)
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';

const PY = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
const tmp = mkdtempSync(join(tmpdir(), 'cloudbite-finalization-'));
const entry = `export * from './src/cloudbite-runner.ts'; export { KNOWLEDGE_SCHEMA, PEER_REVIEW_STATEMENT } from './src/cloudbite-knowledge.ts'; export { CB_INFERENCE_MAX_CALLS } from './src/cloudbite-config.ts';`;
const bundle = await build({ stdin: { contents: entry, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, format: 'esm', platform: 'node' });
writeFileSync(join(tmp, 'runner.mjs'), bundle.outputFiles[0].text);
const M = await import(pathToFileURL(join(tmp, 'runner.mjs')));

let count = 0;
const check = async (name, f) => { await f(); count++; console.log('ok', name); };
const TOKEN = 'cbw_CAPABILITY-SECRET-VALUE';
const MARKER = 'MODEL-BODY-MARKER';
const UPSTREAM = 'UPSTREAM-BODY-SECRET';
const GENERIC = 'runner finished without a valid final opinion';

// ── fake gateway: one scripted model per run, every request recorded ──
let RUN = null;
const server = createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  const action = req.url.split('/').at(-1);
  assert.equal(req.headers.authorization, 'Bearer ' + TOKEN);
  if (action === 'inference') {
    RUN.calls.push(body.messages);
    const reply = RUN.model(body.messages, RUN.calls.length);
    if (typeof reply === 'object') { res.writeHead(reply.status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: UPSTREAM })); return; }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ content: reply })); return;
  }
  if (action === 'activity') RUN.activity.push(body.message);
  if (action === 'complete') RUN.complete.push(body.status);
  res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const GATEWAY = `http://127.0.0.1:${server.address().port}`;

// A generic phase-one style knowledge pack: one card, one source, optional peer-review role.
const CARD = { id: 'card-1', title: 'Timing closure basics', source_ids: ['src-known'], match: ['timing'] };
const SOURCE = { id: 'src-known', title: 'Educational timing notes', tool_scope: 'education', aliases: [] };
function workspace({ knowledge = true, review = false, documents = [] } = {}) {
  const dir = mkdtempSync(join(tmp, 'sb-'));
  for (const d of ['out', 'work', '.cloudbite', 'knowledge']) mkdirSync(join(dir, d));
  const files = { 'INSTRUCTIONS.md': '# Instructions', 'PERSONA.md': '# Persona\nPhysical design engineer (AI role).', 'WORKORDER.md': 'Review the floorplan.',
    'PROJECT.md': '# EDA project\nClose timing on a block.', 'RESULT.schema.json': '{"type":"object"}', 'KNOWLEDGE.md': 'Use the knowledge action.' };
  for (const [p, t] of Object.entries(files)) writeFileSync(join(dir, p), t);
  if (documents.length) {
    mkdirSync(join(dir, 'evidence'));
    writeFileSync(join(dir, 'evidence', 'documents.json'), JSON.stringify({ documents }));
    writeFileSync(join(dir, 'DECISION.md'), 'UNTRUSTED DECISION: options pilot or postpone; unknown: real-world accuracy.');
  }
  if (knowledge) {
    const cards = JSON.stringify([CARD]), sources = JSON.stringify([SOURCE]);
    const sha = (t) => createHash('sha256').update(t).digest('hex');
    writeFileSync(join(dir, 'knowledge', 'cards.json'), cards);
    writeFileSync(join(dir, 'knowledge', 'sources.json'), sources);
    writeFileSync(join(dir, 'knowledge', 'manifest.json'), JSON.stringify({ schema: M.KNOWLEDGE_SCHEMA, version: 'fixture-1', expertId: 'cb-pd', cards: 1, sources: 1,
      initialCardIds: ['card-1'], provenance: { cardsSha256: sha(cards), sourcesSha256: sha(sources) }, ...(review ? { peerReview: { peerInputsProvided: false } } : {}) }));
  }
  writeFileSync(join(dir, 'runner.py'), M.CB_RUNNER_PY);
  writeFileSync(join(dir, '.cloudbite', 'capability.json'), JSON.stringify({ gateway: GATEWAY, project: 'p1', run: 'r1', expertId: 'cb-pd', token: TOKEN,
    expiresAt: Date.now() + 600_000, rounds: M.CB_RUNNER_ROUNDS, maxCalls: M.CB_INFERENCE_MAX_CALLS }));
  return dir;
}
async function run(model, opts) {
  const dir = workspace(opts);
  RUN = { model, calls: [], activity: [], complete: [] };
  const code = await new Promise((resolve) => {
    const p = spawn(PY, ['-I', 'runner.py'], { cwd: dir, env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT ?? '' } });
    let out = ''; p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d));
    p.on('close', (c) => { if (out.trim()) console.error(out); resolve(c); });
  });
  const read = (f) => (existsSync(join(dir, 'out', f)) ? readFileSync(join(dir, 'out', f), 'utf8') : null);
  const diag = read('diagnostic.json');
  return { ...RUN, dir, code, read, diag, diagnostic: diag && JSON.parse(diag), work: readdirSync(join(dir, 'work')).sort() };
}
const lastUser = (messages) => messages.filter((m) => m.role === 'user').at(-1).content;
const finalOnly = (messages) => /^This is the last turn\./.test(lastUser(messages));
const repairTurn = (messages) => /\nFinal repair \d of 2: tools are no longer available/.test(lastUser(messages));
const opinion = (patch = {}) => ({ direction: 'conditional', confidence: 58, summary: 'Timing closes only with a revised floorplan.', evidence: ['[source:src-known] slack definitions'], assumptions: ['educational model only'], nextActions: ['rerun placement'], ...patch });
const final = (o = opinion(), report = '# Physical design\nEducational review only.') => JSON.stringify({ action: 'final', opinion: o, report });
const tool = (n) => JSON.stringify({ action: 'python', code: `print(${n})` });
const search = JSON.stringify({ action: 'knowledge', query: 'timing' });
// five tool/reasoning turns (first one retrieves the source), then the model answers the final-only turn
const busy = (onFinal) => (messages, n) => (finalOnly(messages) || repairTurn(messages) ? onFinal(messages, n) : n === 1 ? search : tool(n));
const assertNoLeak = (r) => {
  for (const f of ['error.txt', 'diagnostic.json', 'done']) {
    const t = r.read(f) ?? '';
    for (const s of [MARKER, UPSTREAM, TOKEN]) assert.ok(!t.includes(s), `${f} must not reflect ${s}`);
  }
  if (r.diag) for (const s of [MARKER, UPSTREAM, TOKEN]) assert.ok(!M.runnerFailureMessage(r.diag).includes(s));
};

// ─────────────────────────── tests ───────────────────────────
await check('repro: a role whose final keeps citing an unretrieved source exhausts every turn; the hard failure keeps a specific, safe cause', async () => {
  const bad = opinion({ evidence: [`[source:made-up-${MARKER}] fabricated claim`] });
  const r = await run(busy(() => final(bad)));
  assert.equal(r.code, 1); assert.deepEqual(r.complete, ['error']);
  assert.equal(r.calls.length, M.CB_INFERENCE_MAX_CALLS, 'six turns + two repairs = the existing maxCalls budget, never more');
  assert.equal(r.calls.length, 8);
  assert.equal(r.calls.filter(repairTurn).length, 2);
  assert.equal(r.read('done'), 'error');
  assert.equal(r.read('result.json'), null); assert.equal(r.read('report.md'), null);
  assert.equal(r.read('error.txt'), 'no valid final opinion within 6 turns and 2 final repair attempts; last problem: final_citation');
  assert.deepEqual(r.diagnostic, { schema: M.RUNNER_DIAGNOSTIC_SCHEMA, code: 'final_citation', turn: 6, repairs: 2, http: 0, calls: 8 });
  assert.equal(M.runnerFailureMessage(r.diag), `${GENERIC}: final cited a source not retrieved for this role (citation) at turn 6 after 2 final repair attempts; 8 model calls`);
  assert.ok(r.activity.some((a) => /^final repair 2: final rejected: a cited source was not retrieved/.test(a)), r.activity.join('\n'));
  assertNoLeak(r);
});

await check('recovery: a last-turn final missing the peer statement is repaired once; the valid final is saved unchanged with no further call', async () => {
  const fixed = opinion({ confidence: 61 });
  const report = `# Review\n${M.PEER_REVIEW_STATEMENT} Only the brief was reviewed.`;
  const r = await run(busy((messages) => (repairTurn(messages) ? final(fixed, report) : final(opinion(), '# Review\nI verified the peer results.'))), { review: true });
  assert.equal(r.code, 0); assert.deepEqual(r.complete, ['ok']);
  assert.equal(r.calls.length, 7, 'exactly one repair call, none after the valid final');
  const repair = lastUser(r.calls[6]);
  assert.match(repair, /^Final rejected: review role without peer inputs: the report must state "No peer result verification occurred\."\.\nFinal repair 1 of 2/);
  assert.match(repair, /Do not invent\nevidence, results or sources/);
  assert.deepEqual(JSON.parse(r.read('result.json')), fixed, 'the model opinion is saved as given');
  assert.equal(r.read('report.md').replace(/\r\n/g, '\n'), report);
  assert.equal(r.read('error.txt'), null); assert.equal(r.diag, null);
  const audit = JSON.parse(r.read('knowledge.json'));
  assert.equal(audit.peerResultsVerified, false); assert.equal(audit.citationIdsValidated, true);
  assert.deepEqual(r.work, [2, 3, 4, 5].map((i) => `step_${i}.py`), 'tools ran only on turns 2-5');
});

await check('repair accepts only a final: a tool requested during repair is never run; the next repair may still finish', async () => {
  let repairs = 0;
  const r = await run(busy((messages) => {
    if (!repairTurn(messages)) return final(opinion({ confidence: 'high' }));
    repairs++;
    return repairs === 1 ? JSON.stringify({ action: 'python', code: 'open("forged.txt","w").write("x")' }) : final(opinion({ confidence: 64 }));
  }));
  assert.equal(r.code, 0); assert.equal(r.calls.length, 8);
  assert.ok(!r.work.includes('step_7.py') && !r.work.includes('forged.txt'), 'nothing executed during repair');
  assert.match(lastUser(r.calls[7]), /^Final rejected: python action not run; only the final is accepted\.\nFinal repair 2 of 2/);
  assert.equal(JSON.parse(r.read('result.json')).confidence, 64);
});

await check('a last-turn unknown citation can be repaired using an actually retrieved source, without changing confidence',async()=>{
 const r=await run(busy((messages)=>repairTurn(messages)?final(opinion({evidence:['[source:src-known] retrieved timing notes']})):final(opinion({evidence:['[source:unknown-1] unsupported']}))));
 assert.equal(r.code,0);assert.equal(r.calls.length,7);
 assert.match(lastUser(r.calls[6]),/Retrieved citation tokens:.*\[source:src-known\]/);
 assert.match(lastUser(r.calls[6]),/Card IDs are not source IDs/);
 assert.equal(JSON.parse(r.read('result.json')).confidence,58);
 assert.deepEqual(JSON.parse(r.read('result.json')).evidence,['[source:src-known] retrieved timing notes']);
 assert.equal(r.read('diagnostic.json'),null);assertNoLeak(r);
});

await check('format failure without a knowledge pack: two failed repairs end in a format diagnostic; model text never reaches error or diagnostic', async () => {
  const r = await run((messages) => final({ ...opinion({ evidence: ['computed'] }), [MARKER]: 'x' }), { knowledge: false });
  assert.equal(r.code, 1); assert.equal(r.calls.length, 8);
  assert.deepEqual(r.diagnostic, { schema: M.RUNNER_DIAGNOSTIC_SCHEMA, code: 'final_format', turn: 6, repairs: 2, http: 0, calls: 8 });
  assert.equal(M.runnerFailureMessage(r.diag), `${GENERIC}: final did not match the result format (format) at turn 6 after 2 final repair attempts; 8 model calls`);
  assertNoLeak(r);
});

await check('provider failure during repair stays an explicit inference failure, is not repaired as content, and makes no further call', async () => {
  const r = await run(busy((messages) => (repairTurn(messages) ? { status: 502 } : final(opinion({ evidence: ['[source:unknown-1] x'] })))));
  assert.equal(r.code, 1); assert.equal(r.calls.length, 7);
  assert.equal(r.read('error.txt'), 'final repair 1: inference failed: model provider returned an error (HTTP 502)');
  assert.deepEqual(r.diagnostic, { schema: M.RUNNER_DIAGNOSTIC_SCHEMA, code: 'inference', turn: 6, repairs: 1, http: 502, calls: 7 });
  assert.equal(M.runnerFailureMessage(r.diag), `${GENERIC}: model inference failed (inference) (provider error, HTTP 502) at turn 6 after 1 final repair attempt; 7 model calls`);
  assert.equal(r.read('result.json'), null);
  assertNoLeak(r);
  const first = await run(() => ({ status: 401 }), { knowledge: false });
  assert.equal(first.calls.length, 1);
  assert.deepEqual(first.diagnostic, { schema: M.RUNNER_DIAGNOSTIC_SCHEMA, code: 'inference', turn: 1, repairs: 0, http: 401, calls: 1 });
  assertNoLeak(first);
});

await check('no repair outside a rejected last-turn final: truncated replies and a last-turn tool keep the six-call honest failure', async () => {
  const cut = await run(() => '{"action":"final","opinion":{"direction":"support","summary":"' + MARKER, { knowledge: false });
  assert.equal(cut.calls.length, 6); assert.equal(cut.read('error.txt'), 'no valid final opinion within 6 turns');
  assert.deepEqual(cut.diagnostic, { schema: M.RUNNER_DIAGNOSTIC_SCHEMA, code: 'reply_format', turn: 6, repairs: 0, http: 0, calls: 6 });
  assert.equal(M.runnerFailureMessage(cut.diag), `${GENERIC}: reply was not a complete JSON action (format) at turn 6; 6 model calls`);
  assertNoLeak(cut);
  const tools = await run((messages, n) => tool(n), { knowledge: false });
  assert.equal(tools.calls.length, 6); assert.ok(!tools.work.includes('step_6.py'));
  assert.equal(tools.diagnostic.code, 'final_turn_tool');
  assert.match(M.runnerFailureMessage(tools.diag), /a tool was requested when the final was required \(turns\) at turn 6; 6 model calls$/);
});

await check('out/diagnostic.json is reserved for the runner; a model write to it is rejected', async () => {
  const r = await run((messages, n) => (n === 1 ? JSON.stringify({ action: 'write', path: 'out/diagnostic.json', content: '{"code":"crash"}' }) : final(opinion({ evidence: ['done'] }))), { knowledge: false });
  assert.equal(r.code, 0); assert.equal(r.calls.length, 2);
  assert.match(lastUser(r.calls[1]), /^rejected: out\/diagnostic\.json is reserved/);
  assert.equal(r.diag, null);
});

await check('server rendering: only exact allowlisted diagnostics change the message; old runners and forgeries keep the generic one', async () => {
  const ok = { schema: M.RUNNER_DIAGNOSTIC_SCHEMA, code: 'budget', turn: 3, repairs: 0, http: 0, calls: 8 };
  assert.equal(M.runnerFailureMessage(JSON.stringify(ok)), `${GENERIC}: runner inference budget or deadline exhausted (budget) at turn 3; 8 model calls`);
  assert.equal(M.runnerFailureMessage(JSON.stringify({ ...ok, code: 'crash', turn: 0 })), `${GENERIC}: runner stopped unexpectedly; 8 model calls`);
  for (const bad of [null, '', 'not json', '[]', 'null', JSON.stringify({ ...ok, schema: 'v0' }), JSON.stringify({ ...ok, code: '<b>x</b>' }),
    JSON.stringify({ ...ok, code: 'toString' }), JSON.stringify({ ...ok, extra: MARKER }), JSON.stringify({ ...ok, turn: 7 }), JSON.stringify({ ...ok, turn: 1.5 }),
    JSON.stringify({ ...ok, repairs: 3 }), JSON.stringify({ ...ok, calls: 9 }), JSON.stringify({ ...ok, http: 502 }), JSON.stringify({ ...ok, code: 'inference', http: 418 }),
    JSON.stringify({ ...ok, code: 'inference', http: '502' }), JSON.stringify({ ...ok, calls: -1 }), JSON.stringify(ok) + ' '.repeat(M.RUNNER_DIAGNOSTIC_MAX)])
    assert.equal(M.runnerFailureMessage(bad), GENERIC, String(bad).slice(0, 80));
  for (const code of ['reply_format', 'final_format', 'final_citation', 'final_peer_review', 'final_turn_tool', 'budget', 'inference', 'crash'])
    assert.ok(M.runnerFailureMessage(JSON.stringify({ ...ok, code })).length <= 300, 'fits the 300-character expert error');
});

await check('actual runner includes complete optional documents for curated and legacy roles and accepts only provided document IDs', async () => {
  const content = 'USER-DOCUMENT-BEGIN ' + '가'.repeat(7800) + ' USER-DOCUMENT-END';
  for (const knowledge of [true, false]) {
    const r = await run((messages, n) => {
      const initial = messages[1].content;
      assert.ok(initial.includes(content), 'full supplied content must reach the model, including its tail');
      assert.ok(initial.includes('unknown: real-world accuracy'));
      return n === 1 ? final(opinion({ evidence: ['[doc:doc-6] unknown document'] }))
        : final(opinion({ evidence: ['[doc:doc-1] USER-DOCUMENT-BEGIN, first line'] }));
    }, { knowledge, documents: [{ id: 'doc-1', name: 'pilot.md', content }] });
    assert.equal(r.code, 0); assert.equal(r.calls.length, 2);
    assert.match(lastUser(r.calls[1]), /cited project document was not supplied/);
    assert.deepEqual(JSON.parse(r.read('result.json')).evidence, ['[doc:doc-1] USER-DOCUMENT-BEGIN, first line']);
  }
});

await check('document citation validation rejects spoofing in report and repair reveals only supplied IDs', async () => {
  const r = await run(busy(messages => repairTurn(messages)
    ? final(opinion({ evidence: ['[doc:doc-1] budget line'] }))
    : final(opinion(), '# [doc:doc-1 ] spoofed ID')),
    { documents: [{ id: 'doc-1', name: 'budget.csv', content: 'weeks,2' }] });
  assert.equal(r.code, 0); assert.equal(r.calls.length, 7);
  assert.match(lastUser(r.calls[6]), /Supplied project document tokens: \[doc:doc-1\]/);
  const absent = await run(() => final(opinion({ evidence: ['[doc:doc-1] invented'] })), { knowledge: false });
  assert.equal(absent.code, 1); assert.equal(absent.diagnostic.code, 'final_citation');
});

server.close();
rmSync(tmp, { recursive: true, force: true });
console.log(`cloudbite runner finalization: ${count} checks passed`);
