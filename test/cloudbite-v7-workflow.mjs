// End-to-end plumbing across authored project case -> actual Python runner -> artifact memo -> authorized follow-up.
// All model replies and calculations are controlled synthetic inputs, never observed advice quality.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { coachingFixture } from './fixtures/cloudbite-coaching.mjs';
import { loadCases } from '../tools/evaluate-cloudbite-quality.mjs';
const bundle = await build({ stdin: { contents: `export * from './src/cloudbite-personas.ts'; export * from './src/cloudbite-workorders.ts'; export * from './src/cloudbite-revision.ts'; export * from './src/cloudbite-memo.ts'; export * from './src/cloudbite-memo-artifacts.ts'; export * from './src/cloudbite-runner.ts'; export {STA_PACK} from './src/cloudbite-sta-data.ts';`, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, format: 'esm', platform: 'node' });
const M = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
const cases = loadCases('test/fixtures/cloudbite-expert-workflow.jsonl');
const root = mkdtempSync(join(tmpdir(), 'cloudbite-v7-flow-'));
let current;
const server = createServer(async (req, res) => {
  const chunks = []; let bytes = 0;
  for await (const c of req) { bytes += c.length; if (bytes > 256 * 1024) { res.writeHead(413); res.end(); return; } chunks.push(c); }
  const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
  const action = req.url.split('/').at(-1);
  let result = {};
  if (action === 'inference') {
    current.calls++;
    const initial = body.messages[1].content;
    assert.ok(initial.includes('## Expert playbook'), 'playbook reaches actual runner context');
    assert.ok(initial.includes(current.brief.objective));
    const act = current.calls === 1 ? { action: 'knowledge', query: current.query }
      : current.calls === 2 ? { action: 'python', code: 'print(2 + 3)' }
      : current.calls === 3 ? { action: 'write', path: 'out/constructive-plan.md', content: 'SYNTHETIC proposal: compare alternatives, measure the missing input and revisit the decision. Not a completed project check.' }
      : { action: 'final', opinion: { direction: 'conditional', confidence: 50, summary: 'Synthetic transport result: compare alternatives after measuring the missing input.',
        evidence: [`Curated reference [source:${current.sourceId}]`], assumptions: ['The proposed project check has not been performed.'], nextActions: ['Measure the missing input and revisit the decision.'] },
        report: '# Synthetic plumbing check\nThe controlled arithmetic printed 5; this is not project evidence. The proposed measurement remains unexecuted.\nNo peer result verification occurred.' };
    result = { content: JSON.stringify(act) };
  } else if (action === 'complete') current.status = body.status;
  res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(result));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
let passed = 0;
try {
  for (const [caseId, expertId] of [['v7-eda-closure', 'probably-primetime-sta'], ['v7-falsify-evidence', 'cb-role-101']]) {
    const brief = M.validateProjectBrief({ ...cases.get(caseId).brief, expertIds: [expertId], responseLanguage: 'en', mode: 'live', requestId: 'v7-workflow-test' });
    const assignment = M.buildExpertAssignments(brief, M.CLOUDBITE_EXPERTS)[0];
    const files = M.buildExpertWorkspace(M.findExpert(expertId), brief, assignment);
    const pack = M.phaseOnePack(expertId) ?? M.STA_PACK;
    const manifest = JSON.parse(files.find(f => f.path === 'knowledge/manifest.json').content);
    const dir = join(root, caseId); mkdirSync(dir);
    for (const d of ['out', 'work', '.cloudbite']) mkdirSync(join(dir, d));
    for (const f of files) { mkdirSync(dirname(join(dir, f.path)), { recursive: true }); writeFileSync(join(dir, f.path), f.content); }
    writeFileSync(join(dir, 'runner.py'), M.CB_RUNNER_PY);
    writeFileSync(join(dir, '.cloudbite/capability.json'), JSON.stringify({ gateway: `http://127.0.0.1:${server.address().port}`, project: 'p-v7-flow', run: 'run-1', expertId, token: 'cbw_SYNTHETIC', expiresAt: Date.now() + 600000, rounds: M.CB_RUNNER_ROUNDS, maxCalls: 8 }));
    current = { brief, query: pack.cards[0].match[0], sourceId: manifest.initialSourceIds[0], calls: 0 };
    const output = await new Promise((resolve, reject) => {
      const p = spawn(process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3'), ['-I', 'runner.py'], { cwd: dir, env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT ?? '' } });
      let text = ''; p.stdout.on('data', b => text += b); p.stderr.on('data', b => text += b); p.on('error', reject); p.on('close', code => resolve({ code, text }));
    });
    assert.equal(output.code, 0, output.text); assert.equal(current.status, 'ok'); assert.equal(current.calls, 4);
    const read = name => readFileSync(join(dir, 'out', name), 'utf8');
    const opinion = JSON.parse(read('result.json')), audit = JSON.parse(read('knowledge.json'));
    assert.ok(audit.retrievals.length >= 2); assert.ok(existsSync(join(dir, 'out/constructive-plan.md')));
    const artifacts = readdirSync(join(dir, 'out')).map(name => ({ path: 'out/' + name, bytes: Buffer.byteLength(read(name)) }));
    const expert = { run: { id: 'run-1', expertId, status: 'completed', artifacts } };
    const selected = M.selectMemoArtifacts([expert]);
    const packets = M.memoArtifactPackets(selected, new Map(selected.entries.map(a => [a.key, read(a.path.slice(4))])));
    const prompt = M.memoMessages(brief, [{ expertId, name: 'Synthetic role', opinion }], { coaching: true, packets });
    assert.equal(prompt.kind, 'prompt'); assert.ok(prompt.allowed.refs.includes('pkt:artifact-1'));
    const coaching = coachingFixture(expertId);
    const reply = { summary: 'One of one selected experts completed. This is a synthetic conditional proposal.',
      recommendation: { status: 'no-recommendation', optionIds: [], rationale: 'A proposed measurement is still missing.', expertIds: [expertId], refs: ['brief:objective'] },
      options: brief.decision.options.map((_, i) => ({ optionId: `option-${i + 1}`, benefits: [], risks: [], conditions: [] })),
      dissent: [], criticalUnknowns: [], changeTriggers: [], nextActions: [], coaching };
    const parsed = M.parseMemoReply(JSON.stringify(reply), prompt); assert.ok(!('invalid' in parsed), parsed.invalid);
    const now = Date.now(), parentId = 'cb' + '1'.repeat(32);
    const parent = { project: { id: parentId, brief, status: 'completed', createdAt: now - 1000, updatedAt: now,
      experts: [{ id: 'run-1', expertId, name: 'Synthetic role', status: 'completed', opinion, artifacts, activity: [], updatedAt: now }],
      memo: { version: 'cloudbite-memo/v1', status: 'completed', memo: parsed.memo } }, expiresAt: now + 600000 };
    const auth = await M.authorizeRoundParent({ parentId, actor: 'owner', owner: true, read: parent, now }); assert.ok(!('error' in auth));
    const changed = M.validateProjectBrief({ ...brief, context: brief.context + '\nUser now reports a small new measurement; still unverified.',
      decision: { ...brief.decision, knownFacts: [...brief.decision.knownFacts, 'User reports a new measurement.'] },
      revision: { parentId, changeSummary: 'New user-reported measurement added for re-evaluation.' }, requestId: 'v7-followup-test' });
    const round = await M.buildProjectRound(auth, changed); assert.ok(!('error' in round), JSON.stringify(round));
    const previous = M.previousRoundWorkspaceFiles(round, expertId).map(f => f.content).join('\n');
    assert.match(previous, /proposed-not-executed/); assert.match(previous, /not-verified/); assert.match(previous, /knownFacts/);
    assert.ok(!JSON.stringify(changed.decision.knownFacts).includes(coaching.repairs[0].change.text));
    assert.equal(parent.project.brief, brief, 'parent input untouched');
    passed++; console.log('ok', caseId, ': real Python runner + lexical search + controlled calculation + artifact memo + authorized follow-up (synthetic model)');
  }
} finally { server.close(); }
console.log(`${passed} v7 integrated project workflows passed; no model quality or live sandbox claim.`);
