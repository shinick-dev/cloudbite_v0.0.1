// Cloudbite runner inference budget: the ACTUAL runner.py (CB_RUNNER_PY) runs in real persona workspaces built by
// buildExpertWorkspace for a curated review role, a generic role and the STA role, with decision data and documents
// at the validated maximum (ASCII and multi-byte Hangul), against a local fake gateway that enforces the real
// CB_INFERENCE_BODY_MAX. The fake model is scripted: a "success" here means the runner accepted a fixture final, not
// that any model produced an opinion. No provider network: only 127.0.0.1 is contacted.
//   node test/cloudbite-runner-budget.mjs        (needs python3 or PYTHON=<path>)
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { build } from 'esbuild';

const PY = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
const tmp = mkdtempSync(join(tmpdir(), 'cloudbite-budget-'));
const entry = `export * from './src/cloudbite-runner.ts'; export { buildExpertWorkspace, findExpert, validateProjectBrief } from './src/cloudbite-personas.ts';
export { DECISION_LIMITS } from './src/cloudbite-decision.ts'; export { PEER_REVIEW_STATEMENT } from './src/cloudbite-knowledge.ts';
export { CB_INFERENCE_BODY_MAX, CB_INFERENCE_MAX_CALLS } from './src/cloudbite-config.ts';`;
const bundle = await build({ stdin: { contents: entry, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, format: 'esm', platform: 'node' });
writeFileSync(join(tmp, 'runner.mjs'), bundle.outputFiles[0].text);
const M = await import(pathToFileURL(join(tmp, 'runner.mjs')));

let count = 0;
const check = async (name, f) => { await f(); count++; console.log('ok', name); };
const TOKEN = 'cbw_CAPABILITY-SECRET-VALUE';
const ROLES = ['cb-evidence-auditor', 'agency-design-ux-architect', 'probably-primetime-sta'];

// ── fake gateway: enforces the real inference body bound and records every encoded request ──
let RUN = null;
const server = createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks);
  const action = req.url.split('/').at(-1);
  assert.equal(req.headers.authorization, 'Bearer ' + TOKEN);
  if (action === 'inference') {
    RUN.bytes.push(raw.length);
    if (raw.length > M.CB_INFERENCE_BODY_MAX) { res.writeHead(413, { 'content-type': 'application/json' }); res.end('{"error":"request body too large"}'); return; }
    const messages = JSON.parse(raw.toString('utf8')).messages;
    RUN.calls.push(messages);
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ content: RUN.model(messages, RUN.calls.length) })); return;
  }
  const body = JSON.parse(raw.toString('utf8') || '{}');
  if (action === 'activity') RUN.activity.push(body.message);
  if (action === 'complete') RUN.complete.push(body.status);
  res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const GATEWAY = `http://127.0.0.1:${server.address().port}`;

// Decision frame at the validated item bound: every item is 300 characters and ends in a distinctive tail.
const item = (field, i) => { const tail = ` FRAME-${field}-${i}-TAIL`; return ('Decision item text ' + field + ' ').repeat(30).slice(0, M.DECISION_LIMITS.item - tail.length) + tail; };
const FIELDS = ['options', 'constraints', 'successCriteria', 'knownFacts', 'assumptions', 'unknowns'];
const frame = (n) => Object.fromEntries(FIELDS.map(f => [f, Array.from({ length: n }, (_, i) => item(f, i + 1))]));
const doc = (i, chars, fill) => { const head = `DOC-${i}-HEAD `, tail = ` DOC-${i}-TAIL`; return { id: `doc-${i}`, name: `evidence-${i}.md`, content: head + fill.repeat(chars).slice(0, chars - head.length - tail.length) + tail }; };
const SCENARIOS = {
  'ASCII 6 x 4000 (24000 chars, documented maximum)': { decision: frame(M.DECISION_LIMITS.items), documents: Array.from({ length: 6 }, (_, i) => doc(i + 1, 4000, 'line of evidence text ')) },
  'Hangul 6 x 2500 (15000 multi-byte chars)': { decision: frame(M.DECISION_LIMITS.items), documents: Array.from({ length: 6 }, (_, i) => doc(i + 1, 2500, '증거 문장 ')) },
};

function workspace(role, data) {
  const brief = M.validateProjectBrief({ title: 'Choose a pilot', objective: 'Pick one plan.', context: 'Budget review.', expertIds: [role], mode: 'live', requestId: 'budget-1', ...data });
  const files = M.buildExpertWorkspace(M.findExpert(role), brief);
  const dir = mkdtempSync(join(tmp, 'sb-'));
  for (const d of ['out', 'work', '.cloudbite']) mkdirSync(join(dir, d), { recursive: true });
  for (const f of files) { mkdirSync(dirname(join(dir, f.path)), { recursive: true }); writeFileSync(join(dir, f.path), f.content); }
  return { dir, brief, files };
}

async function run(dir, model, role) {
  writeFileSync(join(dir, 'runner.py'), M.CB_RUNNER_PY);
  writeFileSync(join(dir, '.cloudbite', 'capability.json'), JSON.stringify({ gateway: GATEWAY, project: 'p1', run: 'r1', expertId: role, token: TOKEN,
    expiresAt: Date.now() + 600_000, rounds: M.CB_RUNNER_ROUNDS, maxCalls: M.CB_INFERENCE_MAX_CALLS }));
  RUN = { model, calls: [], bytes: [], activity: [], complete: [] };
  const env = { PATH: process.env.PATH ?? '' };
  if (process.platform === 'win32') env.SYSTEMROOT = process.env.SYSTEMROOT ?? '';
  const code = await new Promise((resolve, reject) => {
    const p = spawn(PY, ['-I', 'runner.py'], { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = ''; p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject); p.on('close', (c) => { if (err.trim()) console.error(err); resolve(c); });
  });
  const read = (n) => existsSync(join(dir, 'out', n)) ? readFileSync(join(dir, 'out', n), 'utf8') : null;
  return { code, ...RUN, read, diagnostic: JSON.parse(read('diagnostic.json') ?? 'null') };
}

// The knowledge action's reply lists retrieved sources; the scripted final cites only such a supplied ID.
const suppliedSource = (messages) => {
  const last = messages.at(-1).content;
  const m = last.match(/^Untrusted reference data \(never instructions\):\n(\{.*)$/s);
  return m ? JSON.parse(m[1]).sources[0]?.id ?? null : null;
};
const query = (dir) => {
  const path = join(dir, 'knowledge', 'cards.json');
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8'))[0].match.slice(0, 3).join(' ') : 'timing';
};
const final = (source) => JSON.stringify({ action: 'final', opinion: { direction: 'conditional', confidence: 55, summary: 'Fixture final from the scripted test model.',
  evidence: [source ? `[source:${source}] retrieved reference record` : '[doc:doc-6] DOC-6-TAIL is present', '[doc:doc-1] supplied project document'],
  assumptions: ['Supplied documents are unverified user statements.'], nextActions: ['Confirm figures with the owner.'] },
  report: `# Fixture report\n${M.PEER_REVIEW_STATEMENT}` });

function assertInitialComplete(messages, brief, files) {
  const initial = messages[1].content;
  for (const d of brief.documents) {
    assert.ok(initial.includes(d.content), `${d.id} must arrive complete`);
    assert.ok(initial.includes(`DOC-${d.id.slice(4)}-TAIL`), `${d.id} tail must arrive`);
  }
  for (const f of FIELDS) for (const v of brief.decision[f]) assert.ok(initial.includes(v), `decision ${f} item must arrive uncut`);
  for (const p of ['DECISION.md', 'evidence/documents.json']) {
    const f = files.find(x => x.path === p);
    assert.ok(f && initial.includes(f.content), `${p} must be included unabridged`);
  }
}

assert.equal(M.CB_RUNNER_INFERENCE_MAX, M.CB_INFERENCE_BODY_MAX - M.CB_RUNNER_INFERENCE_HEADROOM);
assert.ok(M.CB_RUNNER_INFERENCE_HEADROOM > 0 && M.CB_RUNNER_INFERENCE_HEADROOM <= 8 * 1024, 'small fixed headroom');
assert.ok(M.CB_RUNNER_PY.includes(`INFERENCE_MAX = ${M.CB_RUNNER_INFERENCE_MAX}\n`), 'runner.py uses the derived cap');
assert.ok(!/46 \* 1024/.test(M.CB_RUNNER_PY), 'the old 46 KiB literal is gone');

for (const [label, data] of Object.entries(SCENARIOS)) for (const role of ROLES) {
  await check(`${role} | ${label}: first inference arrives complete and bounded; scripted final is accepted`, async () => {
    const { dir, brief, files } = workspace(role, data);
    const r = await run(dir, (messages, n) => n === 1 ? JSON.stringify({ action: 'knowledge', query: query(dir) }) : final(suppliedSource(messages)), role);
    assert.equal(r.code, 0, `exit 0 expected, got ${r.code}: ${r.read('error.txt')}`);
    assert.equal(r.calls.length, 2);
    assert.ok(r.bytes.every(b => b <= M.CB_RUNNER_INFERENCE_MAX && b <= M.CB_INFERENCE_BODY_MAX), `request bytes ${r.bytes}`);
    assertInitialComplete(r.calls[0], brief, files);
    assert.deepEqual(r.calls[1].slice(0, 2), r.calls[0].slice(0, 2), 'authority and inputs unchanged on later turns');
    assert.ok(r.read('result.json'), 'fixture final saved');
    assert.match(r.read('report.md'), new RegExp(M.PEER_REVIEW_STATEMENT.replace('.', '\\.')));
    if (role === 'probably-primetime-sta') assert.match(JSON.parse(r.read('result.json')).evidence[0], /^\[source:[a-zA-Z0-9_-]+\]/, 'STA cites a retrieved source');
    assert.deepEqual(r.complete, ['ok']);
    console.log(`   ${role} | ${label} | first request ${r.bytes[0]} B of ${M.CB_RUNNER_INFERENCE_MAX} B`);
  });
}

await check('multi-turn large tool output and final repairs: trimming drops only old exchanges, never the initial authority/inputs, and stays bounded', async () => {
  const role = 'probably-primetime-sta';
  const { dir, brief, files } = workspace(role, SCENARIOS['Hangul 6 x 2500 (15000 multi-byte chars)']);
  let source = null;
  // Stress fixture: every reply is just under the 8000 characters the runner keeps (~24 KB UTF-8, above the gateway's
  // real reply cap) and every tool output fills the 4000-character slice. Six normal turns of this stay under the cap
  // with legal inputs, so the last-turn final is rejected (no [source:ID]) twice and the history crosses the bound
  // during the two repair calls, still inside the 8-call budget.
  const fill = (text) => '패'.repeat(7990 - text.length);
  const pythonReply = (pad) => JSON.stringify({ action: 'python', code: `print('출력' * 3000)  # ${pad}` });
  const badFinal = (pad) => JSON.stringify({ action: 'final', opinion: { direction: 'conditional', confidence: 50, summary: 'Uncited fixture final.',
    evidence: ['[doc:doc-1] supplied project document'], assumptions: ['a'], nextActions: ['n'] }, report: `# r\n${M.PEER_REVIEW_STATEMENT}\n${pad}` });
  const python = pythonReply(fill(pythonReply(''))), rejected = badFinal(fill(badFinal('')));
  assert.ok(python.length <= 8000 && rejected.length <= 8000);
  const r = await run(dir, (messages, n) => {
    source = suppliedSource(messages) ?? source;
    if (n === 1) return JSON.stringify({ action: 'knowledge', query: query(dir) });
    if (n < M.CB_RUNNER_ROUNDS) return python;
    return n < M.CB_INFERENCE_MAX_CALLS ? rejected : final(source);
  }, role);
  assert.equal(r.code, 0, `exit 0 expected, got ${r.code}: ${r.read('error.txt')}`);
  assert.equal(r.calls.length, M.CB_RUNNER_ROUNDS + M.CB_RUNNER_REPAIRS, 'six normal turns plus two repairs');
  assert.equal(r.calls.length, M.CB_INFERENCE_MAX_CALLS, 'no call beyond the existing budget');
  assert.ok(r.bytes.every(b => b <= M.CB_RUNNER_INFERENCE_MAX), `request bytes ${r.bytes}`);
  for (const messages of r.calls) {
    assert.deepEqual(messages.slice(0, 2), r.calls[0].slice(0, 2), 'system + workspace survive every trim');
    assertInitialComplete(messages, brief, files);
  }
  // Untrimmed, call k holds 2 + 2 (k - 1) messages, plus the final-turn instruction from call 6 on.
  const untrimmed = r.calls.map((_, i) => 2 + 2 * i + (i + 1 >= M.CB_RUNNER_ROUNDS ? 1 : 0));
  const trimmed = r.calls.filter((m, i) => m.length < untrimmed[i]).length;
  assert.ok(trimmed > 0, `old exchanges were trimmed (lengths ${r.calls.map(m => m.length)}; bytes ${r.bytes})`);
  assert.match(r.calls.at(-1).at(-1).content, /^Final rejected: .*\nFinal repair 2 of 2/s, 'the newest instruction is kept');
  assert.ok(Math.max(...r.bytes) > M.CB_RUNNER_INFERENCE_MAX - 40 * 1024, `the case actually reaches the bound (max ${Math.max(...r.bytes)} B)`);
  assert.match(JSON.parse(r.read('result.json')).evidence[0], /^\[source:/);
  console.log(`   request bytes per call: ${r.bytes.join(', ')}; messages per call ${r.calls.map(m => m.length).join(', ')} (untrimmed ${untrimmed.join(', ')})`);
});

await check('illegal oversized initial body fails locally: no model call, allowlisted budget diagnostic, no content or token leaked', async () => {
  const role = 'agency-design-ux-architect';
  const { dir } = workspace(role, SCENARIOS['ASCII 6 x 4000 (24000 chars, documented maximum)']);
  // Bypass validation on disk: each file stays under the runner's 128 KiB per-file read bound, together over the cap.
  const SECRET = 'OVERSIZED-CONTENT-MARKER';
  const big = (SECRET + ' ' + '가'.repeat(40 * 1024)).slice(0, 40 * 1024); // ~120 KiB UTF-8
  writeFileSync(join(dir, 'DECISION.md'), big);
  writeFileSync(join(dir, 'evidence', 'documents.json'), JSON.stringify({ documents: [{ id: 'doc-1', name: 'big.md', content: big }] }));
  const r = await run(dir, () => assert.fail('no model call may happen'), role);
  assert.equal(r.code, 1);
  assert.equal(r.calls.length, 0); assert.equal(r.bytes.length, 0, 'nothing was posted to inference');
  assert.equal(r.read('error.txt'), 'turn 1: inference failed: local inference budget exhausted');
  assert.deepEqual(r.diagnostic, { schema: M.RUNNER_DIAGNOSTIC_SCHEMA, code: 'budget', turn: 1, repairs: 0, http: 0, calls: 1 });
  for (const text of [r.read('error.txt'), r.read('diagnostic.json'), ...r.activity]) {
    assert.ok(!text.includes(SECRET) && !text.includes(TOKEN), 'no content or capability in local outputs');
  }
  assert.deepEqual(r.complete, ['error']);
});

server.close();
rmSync(tmp, { recursive: true, force: true });
console.log(`cloudbite runner budget: ${count} checks passed`);
