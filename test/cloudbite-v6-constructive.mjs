// Cloudbite v6 constructive expert instructions: the constructive-review, sparse-input and revised-proposal guidance
// reaches the assignment (EN/KO, every stage, Jev and manual routes), WORKORDER.md and the ACTUAL runner.py system
// prompt, while the six-field opinion, assignment bounds and runner turn/call budget stay unchanged. These are
// prompt-delivery checks only; they say nothing about answer quality. Local fake gateway, no provider network.
//   node test/cloudbite-v6-constructive.mjs        (needs python3 or PYTHON=<path>)
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { build } from 'esbuild';

const PY = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
const tmp = mkdtempSync(join(tmpdir(), 'cloudbite-v6-constructive-'));
const entry = `export * from './src/cloudbite-runner.ts'; export * from './src/cloudbite-workorders.ts';
export { ASSIGNMENT_LIMITS, validateExpertAssignment } from './src/cloudbite-workflow.ts';
export { buildExpertWorkspace, validateProjectBrief, findExpert, CLOUDBITE_EXPERTS, CLOUDBITE_OPINION_LIMITS } from './src/cloudbite-personas.ts';
export { PEER_REVIEW_STATEMENT } from './src/cloudbite-knowledge.ts';
export { CB_INFERENCE_MAX_CALLS } from './src/cloudbite-config.ts';`;
const bundle = await build({ stdin: { contents: entry, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, format: 'esm', platform: 'node' });
writeFileSync(join(tmp, 'm.mjs'), bundle.outputFiles[0].text);
const M = await import(pathToFileURL(join(tmp, 'm.mjs')));

let count = 0;
const check = async (name, f) => { await f(); count++; console.log('ok', name); };
const GENERIC = 'agency-design-ux-architect', STA = 'probably-primetime-sta', CURATED = 'cb-evidence-auditor';
const STAGES = ['discovery', 'design', 'validation', 'launch', 'operation', 'unspecified'];
const EARLY = new Set(['discovery', 'design', 'unspecified']);
const OBJECTIVE = { en: 'Choose how to pilot the new scheduling app with two clinics.', ko: '두 병원 중 어디서 일정 앱 파일럿을 먼저 할지 정하기' };
const frame = { options: ['Pilot A: one clinic first', 'Pilot B: both clinics'], constraints: ['Budget under 20k'], successCriteria: ['Booking time halves'],
  knownFacts: ['Clinic staff use paper today'], assumptions: ['Staff can train in a week'], unknowns: ['Vendor SLA'] };
const brief = (lang, stage, extra = {}) => M.validateProjectBrief({ title: 'Pilot rollout', objective: OBJECTIVE[lang], context: 'Small team.', expertIds: [GENERIC, STA, CURATED],
  mode: 'demo', requestId: 'constructive-test-01', ...(stage === 'unspecified' ? {} : { stage }), decision: frame, ...extra });
const harness = (perspectives) => ({ provider: 'typesafe', model: 'jev-1.13.0', policyVersion: 'jev-routing/v2', evaluatedCount: M.CLOUDBITE_EXPERTS.length, threshold: 0.65,
  expertIds: [GENERIC, CURATED], matches: [], queryHash: 'a'.repeat(64), expiresAt: 1,
  harness: { version: 'project-team/v1', stages: ['assessment', 'team-review'], eligibleCount: 2, peerReview: 'not-performed', warnings: [], excluded: [],
    perspectives: perspectives.map(id => ({ id, name: id, need: 0.8, status: 'covered', expertIds: [GENERIC] })),
    selections: [{ expertId: GENERIC, perspectiveIds: perspectives, kind: 'coverage' }, { expertId: CURATED, perspectiveIds: [], kind: 'additional-domain' }] } });
const ROUTING = harness(['user-value', 'delivery']);

// ─────────────── assignments and WORKORDER.md ───────────────
await check('constructive deliverables and boundaries reach every EN/KO stage and route, unclipped and within the assignment bounds', async () => {
  for (const lang of ['en', 'ko']) for (const stage of STAGES) for (const routing of [ROUTING, undefined]) {
    const t = M.WORKORDER_TEMPLATES[lang], b = brief(lang, stage);
    for (const a of M.buildExpertAssignments(b, M.CLOUDBITE_EXPERTS, routing)) {
      const where = `${lang}/${stage}/${a.source}/${a.expertId}`;
      assert.ok(!('invalid' in M.validateExpertAssignment(a)), where);
      assert.equal(a.stage, stage, where);
      assert.ok(a.deliverables.length <= M.ASSIGNMENT_LIMITS.items && a.boundaries.length <= M.ASSIGNMENT_LIMITS.items, where);
      assert.ok(a.deliverables.includes(t.constructive), `${where}: constructive concern deliverable`);
      assert.ok(a.deliverables.includes(t.compare('option-1, option-2')), `${where}: revised-proposal deliverable`);
      assert.ok(a.requiredEvidence.includes(t.missing), `${where}: sparse-input rule`);
      for (const rule of [t.noQuota, t.proposed(EARLY.has(stage)), t.safety, t.noCertification, t.untrusted]) assert.ok(a.boundaries.includes(rule), `${where}: ${rule}`);
      assert.ok(!a.boundaries.includes(t.proposed(!EARLY.has(stage))), `${where}: stage-matched proposal rule only`);
      for (const item of [...a.deliverables, ...a.requiredEvidence, ...a.boundaries]) assert.ok(item.length <= M.ASSIGNMENT_LIMITS.item && !item.endsWith('…'), `${where}: clipped ${item}`);
      const text = JSON.stringify(a);
      // Only the user's own launch stage asks for launch blockers; early stages get no gate.
      if (EARLY.has(stage)) assert.ok(!text.includes('launch blockers') && !text.includes('출시 차단 요소와'), `${where}: no launch gate`);
      assert.equal(a.source === 'jev-coverage', routing !== undefined && a.expertId !== STA, where);
    }
  }
  // no decision frame: the recommendation deliverable carries the revised proposal instead
  for (const lang of ['en', 'ko']) {
    const a = M.buildExpertAssignments(M.validateProjectBrief({ title: 't', objective: OBJECTIVE[lang], context: '', expertIds: [GENERIC], mode: 'demo', requestId: 'constructive-test-02' }), M.CLOUDBITE_EXPERTS)[0];
    assert.ok(a.deliverables.includes(M.WORKORDER_TEMPLATES[lang].recommend) && a.deliverables.includes(M.WORKORDER_TEMPLATES[lang].constructive), lang);
  }
});

await check('KO templates stay Korean, EN templates stay free of Hangul, and stage thresholds are proposals', async () => {
  const hangul = /[가-힣]/;
  const en = M.WORKORDER_TEMPLATES.en, ko = M.WORKORDER_TEMPLATES.ko;
  for (const s of [en.constructive, en.missing, en.noQuota, en.proposed(true), en.safety, en.recommend]) assert.ok(!hangul.test(s), s);
  for (const s of [ko.constructive, ko.missing, ko.noQuota, ko.proposed(true), ko.safety, ko.recommend]) assert.ok(hangul.test(s), s);
  assert.match(en.stages.validation.deliverable, /labeled as proposed/);
  assert.match(ko.stages.validation.deliverable, /합격\/불합격 기준은 성공 기준에서 가져오거나 제안임을 밝히세요/);
  assert.match(en.missing, /only when information decisive/); assert.match(en.missing, /at most three clarifying questions/); assert.match(en.missing, /Unknowns are not evidence of failure/);
});

await check('many owned perspectives collapse into one deliverable that keeps every name instead of dropping the constructive item', async () => {
  const many = ['user-value', 'delivery', 'security', 'privacy', 'performance'];
  for (const lang of ['en', 'ko']) {
    const t = M.WORKORDER_TEMPLATES[lang];
    const a = M.buildExpertAssignments(brief(lang, 'launch'), M.CLOUDBITE_EXPERTS, harness(many))[0];
    assert.deepEqual([...a.perspectiveIds].sort(), [...many].sort());
    assert.ok(a.deliverables.length <= M.ASSIGNMENT_LIMITS.items && a.deliverables.includes(t.constructive));
    const owns = a.deliverables.at(-1);
    for (const id of many) assert.ok(owns.includes(t.perspectives[id]), `${lang} ${id} in ${owns}`);
    const few = M.buildExpertAssignments(brief(lang, 'launch'), M.CLOUDBITE_EXPERTS, ROUTING)[0];
    assert.equal(few.deliverables.length, 8, `${lang}: two perspectives keep their own items`);
    assert.ok(few.deliverables.slice(-2).every((d, i) => d.startsWith(t.owns(t.perspectives[few.perspectiveIds[i]], '').trim())), `${lang}: ${few.deliverables.slice(-2)}`);
  }
});

await check('WORKORDER.md of generic, curated and STA roles carries the constructive assignment in the selected language', async () => {
  for (const lang of ['en', 'ko']) for (const stage of ['discovery', 'launch']) {
    const t = M.WORKORDER_TEMPLATES[lang], b = brief(lang, stage);
    for (const a of M.buildExpertAssignments(b, M.CLOUDBITE_EXPERTS, ROUTING)) {
      const w = M.buildExpertWorkspace(M.findExpert(a.expertId), b, a).find(f => f.path === 'WORKORDER.md').content;
      for (const s of [t.constructive, t.missing, t.noQuota, t.proposed(stage === 'discovery'), t.safety]) assert.ok(w.includes(`- ${s}`), `${lang}/${stage}/${a.expertId}: ${s}`);
    }
  }
  // Old payloads without an assignment keep their unchanged work order; the runner prompt still carries the guidance.
  const old = M.validateProjectBrief({ title: 't', objective: OBJECTIVE.en, context: '', expertIds: [GENERIC], mode: 'demo', requestId: 'constructive-test-03' });
  assert.ok(!M.buildExpertWorkspace(M.findExpert(GENERIC), old).find(f => f.path === 'WORKORDER.md').content.includes('## Assignment'));
});

// ─────────────── the actual runner ───────────────
let RUN = null;
const server = createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks), body = JSON.parse(raw.toString('utf8') || '{}');
  const action = req.url.split('/').at(-1);
  if (action === 'inference') {
    RUN.calls.push(body.messages); RUN.bytes.push(raw.length);
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ content: RUN.model(body.messages, RUN.calls.length) })); return;
  }
  if (action === 'complete') RUN.complete.push(body.status);
  res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const GATEWAY = `http://127.0.0.1:${server.address().port}`;

async function run(files, expertId, model) {
  const dir = mkdtempSync(join(tmp, 'sb-'));
  for (const d of ['out', 'work', '.cloudbite']) mkdirSync(join(dir, d));
  for (const f of files) { mkdirSync(dirname(join(dir, f.path)), { recursive: true }); writeFileSync(join(dir, f.path), f.content); }
  writeFileSync(join(dir, 'runner.py'), M.CB_RUNNER_PY);
  writeFileSync(join(dir, '.cloudbite', 'capability.json'), JSON.stringify({ gateway: GATEWAY, project: 'p1', run: 'r1', expertId, token: 'cbw_TEST',
    expiresAt: Date.now() + 600_000, rounds: M.CB_RUNNER_ROUNDS, maxCalls: M.CB_INFERENCE_MAX_CALLS }));
  RUN = { model, calls: [], bytes: [], complete: [] };
  const code = await new Promise((resolve) => {
    const p = spawn(PY, ['-I', 'runner.py'], { cwd: dir, env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT ?? '' } });
    let out = ''; p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d));
    p.on('close', (c) => { if (out.trim()) console.error(out); resolve(c); });
  });
  const read = (f) => (existsSync(join(dir, 'out', f)) ? readFileSync(join(dir, 'out', f), 'utf8') : null);
  return { ...RUN, code, read };
}
const OPINION = {
  en: { direction: 'support', confidence: 62, summary: 'Pilot one clinic first; no material concern beyond the vendor SLA, which is an unknown, not a failure.',
    evidence: ['Brief: staff use paper today'], assumptions: ['Staff can train in a week'], nextActions: ['Ask the vendor for its SLA before week two'] },
  ko: { direction: 'support', confidence: 62, summary: '한 병원부터 파일럿하세요. 공급사 SLA는 실패 증거가 아닌 미지수입니다.',
    evidence: ['브리프: 직원이 현재 종이를 씁니다'], assumptions: ['직원 교육은 일주일이면 됩니다'], nextActions: ['둘째 주 전에 공급사 SLA를 확인합니다'] },
};
const REPORT = { en: '# Review\nNo material concerns. Revised proposal (proposal, not a requirement): one clinic first.', ko: '# 검토\n중요한 우려가 없습니다. 수정 제안(요구사항 아님): 한 병원부터 시작합니다.' };

await check('actual runner.py: system prompt carries the constructive rules on every route; WORKORDER guidance reaches the model; output stays six fields', async () => {
  const rules = M.CB_RUNNER_PY.match(/CONSTRUCTIVE_RULES = \(([\s\S]*?)\)\n/)[1];
  const lines = [...rules.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map(x => x[1].replace(/\\n$/, ''));
  assert.ok(lines.length >= 10);
  const cases = [
    ['en', 'launch', GENERIC, ROUTING], ['ko', 'discovery', GENERIC, undefined], ['en', 'design', CURATED, ROUTING], ['ko', 'validation', CURATED, ROUTING], ['en', 'unspecified', GENERIC, null],
  ];
  for (const [lang, stage, expertId, routing] of cases) {
    const b = brief(lang, stage);
    const a = routing === null ? undefined : M.buildExpertAssignments(b, M.CLOUDBITE_EXPERTS, routing).find(x => x.expertId === expertId);
    const files = M.buildExpertWorkspace(M.findExpert(expertId), b, a);
    const report = `${REPORT[lang]}\n${M.PEER_REVIEW_STATEMENT}`;
    const r = await run(files, expertId, () => JSON.stringify({ action: 'final', opinion: OPINION[lang], report }));
    const where = `${lang}/${stage}/${expertId}/${a ? a.source : 'no assignment'}`;
    assert.equal(r.code, 0, where); assert.deepEqual(r.complete, ['ok'], where);
    assert.equal(r.calls.length, 1, `${where}: one call, budget untouched`);
    assert.ok(r.bytes[0] <= M.CB_RUNNER_INFERENCE_MAX, where);
    const [system, user] = r.calls[0];
    assert.equal(system.role, 'system');
    for (const line of lines) assert.ok(system.content.includes(line), `${where}: system prompt line ${line}`);
    assert.ok(system.content.includes('exactly those six properties') && system.content.includes('You have 6 turns'), where);
    assert.ok(system.content.includes(lang === 'ko' ? 'Korean' : 'English'), `${where}: language rule kept`);
    const t = M.WORKORDER_TEMPLATES[lang];
    if (a) for (const s of [t.constructive, t.missing, t.noQuota, t.proposed(EARLY.has(stage)), t.safety]) assert.ok(user.content.includes(s), `${where}: ${s}`);
    else assert.ok(!user.content.includes('## Assignment'), where);
    const result = JSON.parse(r.read('result.json'));
    assert.deepEqual(Object.keys(result), ['direction', 'confidence', 'summary', 'evidence', 'assumptions', 'nextActions'], where);
    assert.deepEqual(result, OPINION[lang], where);
    assert.equal(r.read('report.md').replace(/\r\n/g, '\n'), report, where); // text-mode write on Windows hosts
  }
});

await check('runner budget constants and opinion limits are unchanged by v6', async () => {
  assert.equal(M.CB_RUNNER_ROUNDS, 6); assert.equal(M.CB_RUNNER_REPAIRS, 2); assert.equal(M.CB_INFERENCE_MAX_CALLS, 8);
  assert.deepEqual(M.ASSIGNMENT_LIMITS, { question: 800, items: 8, item: 400, perspectives: 14 });
  assert.ok(M.CB_RUNNER_PY.includes("OPINION_KEYS = ('direction', 'confidence', 'summary', 'evidence', 'assumptions', 'nextActions')"));
});

server.close();
rmSync(tmp, { recursive: true, force: true });
console.log(`cloudbite v6 constructive: ${count} checks passed`);
