// Execute the actual embedded Python runner against a local scripted gateway; no provider or sandbox spend.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { build } from 'esbuild';

const built = await build({ stdin: { contents: "export { CB_RUNNER_PY } from './src/cloudbite-runner.ts'", resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, platform: 'node', format: 'esm' });
const { CB_RUNNER_PY } = await import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'));
const root = mkdtempSync(join(tmpdir(), 'cloudbite-author-runner-'));
const findingId = 'arf_' + 'a'.repeat(32), otherId = 'arf_' + 'b'.repeat(32);
const opinion = { direction: 'conditional', confidence: 58, summary: 'A bounded pilot needs an explicit human decision.', evidence: ['This educational brief offers no measured success threshold.'], assumptions: ['The pilot remains a proposal.'], nextActions: ['Ask the owner to adopt or reject the proposed criterion.'] };
const response = { responses: [{ findingId, disposition: 'revise', rationale: 'I withdraw the invented threshold and label a replacement as a proposal.' }] };
const final = (authorResponse = response) => JSON.stringify({ action: 'final', opinion, report: '# Revised view\nThe threshold was proposed, not user-stated.', ...(authorResponse === undefined ? {} : { authorResponse }) });
let active;
const server = createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
  assert.equal(req.headers.authorization, 'Bearer fixture-cap');
  let data = {};
  if (req.url.endsWith('/inference')) { active.messages.push(body.messages); data = { content: active.model(active.messages.length, body.messages) }; }
  if (req.url.endsWith('/activity')) active.events.push(body.message);
  if (req.url.endsWith('/complete')) active.complete.push(body.status);
  res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(data));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
async function run(model, feedback = true) {
  const dir = mkdtempSync(join(root, 'run-'));
  for (const name of ['out', 'work', '.cloudbite', 'evidence']) mkdirSync(join(dir, name));
  for (const name of ['INSTRUCTIONS.md', 'PERSONA.md', 'WORKORDER.md', 'PROJECT.md', 'RESULT.schema.json']) writeFileSync(join(dir, name), '# Educational fixture');
  writeFileSync(join(dir, 'project.json'), JSON.stringify({ objective: 'Plan a pilot', responseLanguage: 'en' }));
  writeFileSync(join(dir, 'evidence/provenance.txt'), 'User-stated success criterion: record a readable evidence location. A numeric 80% threshold was NOT adopted.');
  if (feedback) writeFileSync(join(dir, 'evidence/author-response-findings.json'), JSON.stringify({ kind: 'cloudbite-author-response-findings', findings: [{ findingId, verdict: 'challenged', reviewerRationale: 'The brief never stated this threshold.' }] }));
  writeFileSync(join(dir, 'runner.py'), CB_RUNNER_PY);
  writeFileSync(join(dir, '.cloudbite/capability.json'), JSON.stringify({ gateway: `http://127.0.0.1:${server.address().port}`, project: 'fixture', run: 'r1', expertId: 'author', token: 'fixture-cap', expiresAt: Date.now() + 600_000, rounds: 6, maxCalls: 8 }));
  active = { model, messages: [], events: [], complete: [] };
  const outcome = active;
  const exit = await new Promise((resolve, reject) => {
    const child = spawn(process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3'), ['-I', 'runner.py'], { cwd: dir, env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT ?? '' } });
    let errors = ''; child.stderr.on('data', d => errors += d); child.on('error', reject);
    child.on('close', code => resolve({ code, errors }));
  });
  assert.equal(exit.errors, '');
  const read = p => existsSync(join(dir, 'out', p)) ? readFileSync(join(dir, 'out', p), 'utf8') : null;
  return { ...outcome, exit: exit.code, read };
}
let checks = 0;
try {
  const complete = await run(() => final());
  assert.equal(complete.exit, 0); assert.equal(complete.messages.length, 1);
  assert.deepEqual(JSON.parse(complete.read('result.json')), opinion);
  assert.deepEqual(JSON.parse(complete.read('author-response.json')), response);
  assert.ok(JSON.parse(complete.read('manifest.json')).files.includes('out/author-response.json'));
  assert.match(complete.messages[0][1].content, /NOT adopted/);
  assert.match(complete.messages[0][1].content, /arf_aaaaaaaa/); checks++;

  const repaired = await run(n => n === 1 ? final({ responses: [{ ...response.responses[0], findingId: otherId }] }) : final());
  assert.equal(repaired.messages.length, 2); assert.equal(repaired.read('done'), 'ok');
  assert.ok(repaired.events.some(e => /unknown, foreign or duplicate/.test(e))); checks++;

  const duplicate = await run(n => n === 1 ? final({ responses: [response.responses[0], response.responses[0]] }) : final());
  assert.equal(duplicate.messages.length, 2); assert.equal(duplicate.read('done'), 'ok'); checks++;

  const missing = await run(() => JSON.stringify({ action: 'final', opinion, report: '# Missing reply\nA valid opinion alone cannot pretend to answer a review.' }));
  assert.equal(missing.messages.length, 8); assert.equal(missing.read('done'), 'error');
  assert.equal(missing.read('result.json'), null); assert.equal(missing.read('author-response.json'), null); checks++;

  const partial = await run(() => final({ responses: [] }));
  assert.equal(partial.read('done'), 'ok'); assert.deepEqual(JSON.parse(partial.read('author-response.json')), { responses: [] }); checks++;

  const reserved = await run(n => n === 1 ? JSON.stringify({ action: 'write', path: 'out/author-response.json', content: '{"responses":[]}' }) : final());
  assert.equal(reserved.read('done'), 'ok'); assert.ok(reserved.events.some(e => /reserved/.test(e)));
  assert.deepEqual(JSON.parse(reserved.read('author-response.json')), response); checks++;

  const ordinary = await run(() => final(), false);
  assert.equal(ordinary.read('done'), 'ok'); assert.equal(ordinary.read('author-response.json'), null); checks++;
  console.log(`cloudbite-runner-author-response: ${checks} execution scenarios passed`);
} finally { await new Promise(r => server.close(r)); }
