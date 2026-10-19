// Cloudbite response language (ko/en): the shared script heuristic, its Python port inside the ACTUAL runner.py,
// last-turn final repair for wrong-language finals within the unchanged 6+2=8 call budget, and the cross-review and
// decision-memo prompts/parsers. Local fake gateway with a scripted model; only 127.0.0.1 is contacted.
// Output directories are new unique folders under .artifacts/ and are left in place.
//   node test/cloudbite-language.mjs        (needs python3 or PYTHON=<path>)
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';

const PY = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
mkdirSync(join(process.cwd(), '.artifacts'), { recursive: true });
const tmp = mkdtempSync(join(process.cwd(), '.artifacts', 'cloudbite-language-test-'));
const entry = `export * from './src/cloudbite-runner.ts'; export * from './src/cloudbite-language.ts';
export * as review from './src/cloudbite-cross-review.ts'; export * as memo from './src/cloudbite-memo.ts';
export { KNOWLEDGE_SCHEMA, PEER_REVIEW_STATEMENT } from './src/cloudbite-knowledge.ts'; export { CB_INFERENCE_MAX_CALLS } from './src/cloudbite-config.ts';`;
const bundle = await build({ stdin: { contents: entry, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, format: 'esm', platform: 'node' });
writeFileSync(join(tmp, 'm.mjs'), bundle.outputFiles[0].text);
const M = await import(pathToFileURL(join(tmp, 'm.mjs')));
writeFileSync(join(tmp, 'runner.py'), M.CB_RUNNER_PY);

let count = 0;
const check = async (name, f) => { await f(); count++; console.log('ok', name); };
const TOKEN = 'cbw_LANGUAGE-TEST-CAPABILITY';

// ── fixtures: prose in each script, technical-term-rich Korean, quoted originals, short/ambiguous text ──
const KO = '블록의 셋업 여유가 음수이므로 배치를 다시 조정하고 클록 경로를 재검토해야 한다. 현재 근거는 교육용 자료뿐이며 실제 사인오프를 대신하지 않는다.';
const EN = 'The block has negative setup slack, so placement should be revised and the clock paths reviewed again. The evidence is educational material only and does not replace signoff.';
const KO_TECH = 'PrimeTime STA 결과에서 hold violation이 남아 있으므로 ECO를 권장한다. `report_timing -delay_type min` 출력과 [source:src-known] 기준으로 판단했고 https://example.com/notes 문서는 참고만 했다.';
const EN_WITH_KO_QUOTE = 'The vendor note says "타이밍 마진이 부족하여 일정 지연이 예상됩니다 추가 검토가 필요합니다" and the team should confirm the remaining margin with the vendor before committing to the delivery schedule.';
const EN_WITH_KO_NAMES = 'The review covered the 거제 site plan and the 서울 lab notes; the remaining risk is the unverified supplier schedule and the missing test coverage.';
const SHORT = 'OK [source:src-known]';
const FIXTURES = [[KO, 'ko', 'consistent'], [KO, 'en', 'mismatch'], [EN, 'en', 'consistent'], [EN, 'ko', 'mismatch'], [KO_TECH, 'ko', 'consistent'],
  [EN_WITH_KO_QUOTE, 'en', 'consistent'], [EN_WITH_KO_NAMES, 'en', 'consistent'], [SHORT, 'ko', 'unknown'], [SHORT, 'en', 'unknown'], ['`code only`', 'ko', 'unknown']];

await check('script heuristic: clear mismatches only; technical Korean, quoted originals and proper names are not rejected; short text is unknown', () => {
  for (const [t, lang, want] of FIXTURES) assert.equal(M.languageIntegrity([t], lang).status, want, `${lang}: ${t}`);
  assert.equal(M.languageIntegrity([KO], 'ko').basis, 'script-heuristic');
  assert.ok(!/verified/i.test(JSON.stringify(M.languageIntegrity([KO], 'ko'))), 'no verification claim in the result');
  assert.ok(!M.narrativeText([EN_WITH_KO_QUOTE]).includes('타이밍'), 'quoted original excluded, not translated');
});

await check('the Python port inside runner.py gives the same status and counts as the TypeScript check', () => {
  const cases = JSON.stringify(FIXTURES.map(([t, lang]) => [t, lang]));
  writeFileSync(join(tmp, 'cases.json'), cases);
  const code = 'import importlib.util,json,sys\ns=importlib.util.spec_from_file_location("r",sys.argv[1]);r=importlib.util.module_from_spec(s);s.loader.exec_module(r)\n'
    + 'print(json.dumps([list(r.language_integrity([t],l)) for t,l in json.load(open(sys.argv[2],encoding="utf-8"))]))';
  const p = spawnSync(PY, ['-I', '-c', code, join(tmp, 'runner.py'), join(tmp, 'cases.json')], { encoding: 'utf8' });
  assert.equal(p.status, 0, p.stderr);
  const py = JSON.parse(p.stdout);
  FIXTURES.forEach(([t, lang], i) => { const ts = M.languageIntegrity([t], lang); assert.deepEqual(py[i], [ts.status, ts.hangul, ts.latin], t); });
});

// ── fake gateway and actual runner ──
let RUN = null;
const server = createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  const action = req.url.split('/').at(-1);
  assert.equal(req.headers.authorization, 'Bearer ' + TOKEN);
  if (action === 'inference') {
    RUN.calls.push(body.messages); RUN.bytes.push(Buffer.byteLength(JSON.stringify(body)));
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ content: RUN.model(body.messages, RUN.calls.length) })); return;
  }
  if (action === 'activity') RUN.activity.push(body.message);
  if (action === 'complete') RUN.complete.push(body.status);
  res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const GATEWAY = `http://127.0.0.1:${server.address().port}`;
const CARD = { id: 'card-1', title: 'Timing closure basics', source_ids: ['src-known'], match: ['timing'] };
const SOURCE = { id: 'src-known', title: 'Educational timing notes', tool_scope: 'education', aliases: [] };

function workspace(project, { review = false } = {}) {
  const dir = mkdtempSync(join(tmp, 'sb-'));
  for (const d of ['out', 'work', '.cloudbite', 'knowledge']) mkdirSync(join(dir, d));
  const files = { 'INSTRUCTIONS.md': '# Instructions\nWrite in clear English.', 'PERSONA.md': '# Persona\nPhysical design engineer (AI role). Answers in English.', 'WORKORDER.md': 'Review the floorplan.',
    'PROJECT.md': '# Project', 'RESULT.schema.json': '{"type":"object"}', 'KNOWLEDGE.md': 'Use the knowledge action.' };
  for (const [p, t] of Object.entries(files)) writeFileSync(join(dir, p), t);
  if (project) writeFileSync(join(dir, 'project.json'), JSON.stringify(project, null, 2) + '\n');
  const cards = JSON.stringify([CARD]), sources = JSON.stringify([SOURCE]);
  const sha = (t) => createHash('sha256').update(t).digest('hex');
  writeFileSync(join(dir, 'knowledge', 'cards.json'), cards);
  writeFileSync(join(dir, 'knowledge', 'sources.json'), sources);
  writeFileSync(join(dir, 'knowledge', 'manifest.json'), JSON.stringify({ schema: M.KNOWLEDGE_SCHEMA, version: 'fixture-1', expertId: 'cb-pd', cards: 1, sources: 1,
    initialCardIds: ['card-1'], provenance: { cardsSha256: sha(cards), sourcesSha256: sha(sources) }, ...(review ? { peerReview: { peerInputsProvided: false } } : {}) }));
  writeFileSync(join(dir, 'runner.py'), M.CB_RUNNER_PY);
  writeFileSync(join(dir, '.cloudbite', 'capability.json'), JSON.stringify({ gateway: GATEWAY, project: 'p1', run: 'r1', expertId: 'cb-pd', token: TOKEN,
    expiresAt: Date.now() + 600_000, rounds: M.CB_RUNNER_ROUNDS, maxCalls: M.CB_INFERENCE_MAX_CALLS }));
  return dir;
}
async function run(model, project, opts) {
  const dir = workspace(project, opts);
  RUN = { model, calls: [], bytes: [], activity: [], complete: [] };
  const code = await new Promise((resolve) => {
    const p = spawn(PY, ['-I', 'runner.py'], { cwd: dir, env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT ?? '' } });
    let out = ''; p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d));
    p.on('close', (c) => { if (out.trim()) console.error(out); resolve(c); });
  });
  const read = (f) => (existsSync(join(dir, 'out', f)) ? readFileSync(join(dir, 'out', f), 'utf8') : null);
  const diag = read('diagnostic.json');
  return { ...RUN, code, read, diag, diagnostic: diag && JSON.parse(diag) };
}
const lastUser = (messages) => messages.filter((m) => m.role === 'user').at(-1).content;
const finalOnly = (messages) => /^This is the last turn\./.test(lastUser(messages));
const repairTurn = (messages) => /\nFinal repair \d of 2: tools are no longer available/.test(lastUser(messages));
const search = JSON.stringify({ action: 'knowledge', query: 'timing' });
const tool = (n) => JSON.stringify({ action: 'python', code: `print(${n})` });
const busy = (onFinal) => (messages, n) => (finalOnly(messages) || repairTurn(messages) ? onFinal(messages, n) : n === 1 ? search : tool(n));
const final = (o, report) => JSON.stringify({ action: 'final', opinion: o, report });
const QUOTE = '"Setup slack is the required time minus the arrival time"';
const enOpinion = { direction: 'conditional', confidence: 58, summary: EN, evidence: [`[source:src-known] defines slack as ${QUOTE}, so negative slack means the path is late.`],
  assumptions: ['The educational timing model applies to this block without changes.'], nextActions: ['Rerun placement with a revised floorplan and compare the slack report.'] };
const koOpinion = { direction: 'conditional', confidence: 58, summary: KO, evidence: [`[source:src-known] 자료는 슬랙을 ${QUOTE} 로 정의하므로 음수 슬랙은 경로가 늦다는 뜻이다.`],
  assumptions: ['교육용 타이밍 모델이 이 블록에도 그대로 적용된다고 가정한다.'], nextActions: ['수정한 플로어플랜으로 배치를 다시 돌리고 `report_timing` 결과를 비교한다.'] };
const enReport = '# Timing review\nThe floorplan needs revision before signoff; the evidence is educational only.';
const koReport = '# 타이밍 검토\n사인오프 전에 플로어플랜 수정이 필요하며, 근거는 교육용 자료뿐이다.';
const KO_PROJECT = { title: '블록 타이밍', objective: '블록 타이밍을 닫을 방법을 검토한다.', context: '', expertIds: ['cb-pd'], mode: 'live', requestId: 'lang-1' };

await check('runner: a Korean project rejects an English last-turn final and repairs it to Korean inside the 8-call cap; the repaired final is saved unchanged', async () => {
  const r = await run(busy((messages) => (repairTurn(messages) ? final(koOpinion, koReport) : final(enOpinion, enReport))), KO_PROJECT);
  assert.equal(r.code, 0); assert.deepEqual(r.complete, ['ok']);
  assert.equal(r.calls.length, 7, 'six turns + one repair; never more than the existing budget');
  assert.ok(r.calls.length <= M.CB_INFERENCE_MAX_CALLS && M.CB_INFERENCE_MAX_CALLS === 8 && M.CB_RUNNER_ROUNDS === 6 && M.CB_RUNNER_REPAIRS === 2);
  assert.ok(r.bytes.every((b) => b <= M.CB_RUNNER_INFERENCE_MAX), 'every request stays inside the runner body bound');
  const system = r.calls[0][0].content;
  assert.match(system, /Response language: ko — Korean \(한국어\)/);
  assert.match(system, /even when the persona, instructions or supplied material are in another language/, 'English persona does not override');
  assert.match(lastUser(r.calls[5]), /Write the narrative in Korean \(한국어\)\./);
  assert.match(lastUser(r.calls[6]), /^Final rejected: final narrative is not in the selected response language \(ko, Korean \(한국어\)\)/);
  assert.ok(!lastUser(r.calls[6]).includes(EN), 'the rejected prose is never echoed back');
  assert.deepEqual(JSON.parse(r.read('result.json')), koOpinion, 'saved exactly as the model wrote it: no server-side translation or rewrite');
  assert.ok(JSON.parse(r.read('result.json')).evidence[0].includes(QUOTE), 'English source quote kept verbatim in a Korean answer');
  assert.equal(r.read('report.md').replace(/\r\n/g, '\n'), koReport);
  assert.ok(r.activity.some((a) => /^turn 6: final rejected: final narrative is not in the selected response language/.test(a)));
  assert.ok(r.activity.some((a) => /^final repair 1: response language ko check consistent \(script heuristic, not verified language identification/.test(a)), r.activity.join('\n'));
});

await check('runner: explicit responseLanguage en wins over a Korean objective; a Korean final is rejected and an English one accepted', async () => {
  const r = await run(busy((messages) => (repairTurn(messages) ? final(enOpinion, enReport) : final(koOpinion, koReport))), { ...KO_PROJECT, responseLanguage: 'en' });
  assert.equal(r.code, 0); assert.equal(r.calls.length, 7);
  assert.match(r.calls[0][0].content, /Response language: en — English/);
  assert.ok(!/Response language: ko/.test(r.calls[0][0].content));
  assert.deepEqual(JSON.parse(r.read('result.json')), enOpinion);
});

await check('runner: an English objective defaults to en; Korean technical-term-rich text is not mistaken for English and vice versa', async () => {
  const r = await run(busy(() => final(enOpinion, enReport)), { ...KO_PROJECT, objective: 'Review how to close block timing.' });
  assert.equal(r.code, 0); assert.equal(r.calls.length, 6, 'a correct-language final needs no repair');
  assert.match(r.calls[0][0].content, /Response language: en/);
  const tech = { ...koOpinion, summary: KO_TECH };
  const k = await run(busy(() => final(tech, koReport)), KO_PROJECT);
  assert.equal(k.code, 0); assert.equal(k.calls.length, 6, 'Korean with English tool names, code, URL and citation is accepted');
});

await check('runner: an early wrong-language final is rejected inside the normal turns, with no extra call', async () => {
  const r = await run((messages, n) => (n === 1 ? search : n === 2 ? final(enOpinion, enReport) : final(koOpinion, koReport)), KO_PROJECT);
  assert.equal(r.code, 0); assert.equal(r.calls.length, 3);
  assert.match(lastUser(r.calls[2]), /^Final rejected: final narrative is not in the selected response language \(ko/);
});

await check('runner: a final that stays in the wrong language ends as an explicit, allowlisted language failure after exactly 8 calls', async () => {
  const r = await run(busy(() => final(enOpinion, enReport)), KO_PROJECT);
  assert.equal(r.code, 1); assert.deepEqual(r.complete, ['error']);
  assert.equal(r.calls.length, 8);
  assert.equal(r.read('result.json'), null);
  assert.deepEqual(r.diagnostic, { schema: M.RUNNER_DIAGNOSTIC_SCHEMA, code: 'final_language', turn: 6, repairs: 2, http: 0, calls: 8 });
  assert.equal(M.runnerFailureMessage(r.diag), 'runner finished without a valid final opinion: final narrative was not in the selected response language (language) at turn 6 after 2 final repair attempts; 8 model calls');
  assert.equal(r.read('error.txt'), 'no valid final opinion within 6 turns and 2 final repair attempts; last problem: final_language');
});

await check('runner: short ambiguous narrative is accepted and honestly reported as unknown, never as verified', async () => {
  const short = { direction: 'abstain', confidence: 10, summary: 'OK', evidence: ['[source:src-known]'], assumptions: ['n/a'], nextActions: ['TBD'] };
  const r = await run(busy(() => final(short, '# OK')), KO_PROJECT);
  assert.equal(r.code, 0); assert.equal(r.calls.length, 6);
  assert.ok(r.activity.some((a) => /^turn 6: response language ko check unknown \(script heuristic, not verified/.test(a)), r.activity.join('\n'));
});

await check('runner: the required English peer statement in a Korean review report is a fixed quote, not wrong-language narrative', async () => {
  const report = `# 검토\n${M.PEER_REVIEW_STATEMENT} 브리프만 검토했으며 다른 역할의 결과는 확인하지 않았다.`;
  const r = await run(busy(() => final(koOpinion, report)), KO_PROJECT, { review: true });
  assert.equal(r.code, 0); assert.equal(r.calls.length, 6);
});

await check('runner: a workspace without project.json keeps the earlier prompt (no language rule, no check)', async () => {
  const r = await run(busy(() => final(enOpinion, enReport)), null);
  assert.equal(r.code, 0);
  assert.ok(!/Response language:/.test(r.calls[0][0].content) && !/Write the narrative in/.test(lastUser(r.calls[5])));
  assert.ok(!r.activity.some((a) => /response language/.test(a)));
});
server.close();

// ── cross-review ──
const R = M.review;
const brief = (over = {}) => ({ title: 'Pilot', objective: '두 파일럿 중 하나를 고른다.', context: '예산 검토가 다음 달에 있다.', expertIds: ['exp-a', 'exp-b'], mode: 'live', requestId: 'lang-review-1',
  documents: [{ id: 'doc-1', name: 'quote.md', content: 'Total: 42k' }], ...over });
const op = (direction) => ({ direction, confidence: 70, summary: `${direction} summary`, evidence: ['Quote is 42k [doc:doc-1]', 'SLA unknown'], assumptions: ['a'], nextActions: ['n'] });
const reviewer = { expertId: 'exp-a', name: 'Review analyst', opinion: op('support') };
const peers = [{ expertId: 'exp-b', name: 'B', opinion: op('concern') }];
const reviewReply = (summary, rationale) => JSON.stringify({ summary, findings: [{ targetExpertId: 'exp-b', evidenceIndex: 0, verdict: 'supported', rationale }] });

await check('cross-review: explicit selected-language rule, actual objective and stage/revision as untrusted data in prompt and snapshot', () => {
  const b = brief({ stage: 'validation', revision: { parentId: 'cb' + '0'.repeat(32), changeSummary: '가격 조건 갱신' } });
  const [system, user] = R.reviewMessages(reviewer, peers, b);
  assert.ok(system.content.includes(M.responseLanguageRule('ko', 'summary and every rationale')));
  assert.ok(!/Use the same language as the project objective/.test(system.content));
  const data = JSON.parse(user.content.replace(/^Untrusted review data \(JSON\):\n/, ''));
  assert.equal(data.project.objective, '두 파일럿 중 하나를 고른다.');
  assert.deepEqual(data.project.workflow, { kind: 'user-statement-unverified', stage: 'validation', responseLanguage: 'ko', revision: { parentId: 'cb' + '0'.repeat(32), changeSummary: '가격 조건 갱신' } });
  const base = R.reviewSnapshot(b, peers);
  assert.notEqual(base, R.reviewSnapshot({ ...b, stage: 'launch' }, peers), 'stage change changes the snapshot');
  assert.notEqual(base, R.reviewSnapshot({ ...b, revision: { ...b.revision, changeSummary: '다른 변경' } }, peers), 'revision change changes the snapshot');
  assert.notEqual(base, R.reviewSnapshot({ ...b, responseLanguage: 'en' }, peers), 'language change changes the snapshot');
  const old = brief({ objective: 'Pick a pilot.' });
  assert.deepEqual(JSON.parse(R.reviewSnapshot(old, peers)).brief.workflow, { kind: 'user-statement-unverified', stage: 'unspecified', responseLanguage: 'en', revision: null }, 'old brief works');
  assert.match(R.reviewMessages(reviewer, peers, old)[0].content, /Response language: en — English/);
});

await check('cross-review: strict parser rejects clear wrong-language prose with category language, accepts technical Korean and short text', () => {
  const en = R.parseReviewReply(reviewReply(EN, 'The quote document states the total, which supports the cost claim made in this evidence item.'), reviewer, peers, { language: 'ko' });
  assert.deepEqual(en, { invalid: 'reviewer reply is not written in the selected language (ko)', category: 'language' });
  assert.ok(!JSON.stringify(en).includes('negative setup slack'), 'reply text never echoed');
  assert.ok(!('invalid' in R.parseReviewReply(reviewReply(KO_TECH, '[doc:doc-1] 문서의 Total 값이 비용 주장을 뒷받침한다.'), reviewer, peers, { language: 'ko' })));
  assert.equal(R.parseReviewReply(reviewReply(KO, '견적 문서가 비용 주장을 뒷받침한다.'), reviewer, peers, { language: 'en' }).category, 'language');
  assert.ok(!('invalid' in R.parseReviewReply(reviewReply('OK', 'ok'), reviewer, peers, { language: 'ko' })), 'short ambiguous text is not rejected');
  assert.ok(!('invalid' in R.parseReviewReply(reviewReply(EN, 'Supported.'), reviewer, peers)), 'no language option: earlier behaviour');
});

// ── decision memo ──
const MM = M.memo;
const frame = { options: ['Plan A: in-house', 'Plan B: vendor'], constraints: ['Budget under 50k'], successCriteria: ['Live in 8 weeks'], knownFacts: ['Quote 42k'], assumptions: ['ok'], unknowns: ['SLA'] };
const memoBrief = (over = {}) => ({ ...brief(), decision: frame, ...over });
const completed = [{ expertId: 'exp-a', name: 'A', opinion: op('support') }, { expertId: 'exp-b', name: 'B', opinion: op('concern') }];
const claim = (text, expertIds = [], refs = []) => ({ text, expertIds, refs });
const memoReply = (t) => JSON.stringify({
  summary: t.summary, recommendation: { status: 'recommend', optionIds: ['option-2'], rationale: t.rationale, expertIds: ['exp-a'], refs: ['doc:doc-1'] },
  options: [{ optionId: 'option-1', benefits: [claim(t.c1, ['exp-b'])], risks: [], conditions: [] }, { optionId: 'option-2', benefits: [claim(t.c2, ['exp-a'])], risks: [], conditions: [] }],
  dissent: t.dissent ? [claim(t.dissent, ['exp-b'])] : [], criticalUnknowns: [], changeTriggers: [claim(t.c3)], nextActions: [claim(t.c4, ['exp-a'])] });
const KO_MEMO = { summary: '완료된 두 전문가 의견을 읽었고 방향이 엇갈리므로 Plan B는 조건부로 본다. PrimeTime 같은 도구 이름과 [doc:doc-1] 표기는 원문대로 둔다.',
  rationale: '벤더 견적이 예산 안에 들어온다는 문서 근거가 있다.', c1: '내부 통제가 쉽다', c2: '예산에 맞는다', c3: 'SLA 조건이 업무 시간보다 나쁘면 바뀐다', c4: 'SLA 초안을 요청한다' };
const EN_MEMO = { summary: 'Two finished expert opinions were read; their directions conflict, so Plan B is treated as conditional on the vendor terms.',
  rationale: 'The vendor quote document shows the cost fits the budget constraint stated in the brief.', c1: 'Full internal control', c2: 'Fits the budget', c3: 'An SLA worse than business hours', c4: 'Request the SLA draft' };
const memoPrompt = (b, o) => { const p = MM.memoMessages(b, completed, o); assert.equal(p.kind, 'prompt'); return p; };

await check('memo: stage/revision/language in the actual prompt and in the snapshot; changing them changes the snapshot; old brief works', () => {
  const b = memoBrief({ stage: 'design', revision: { parentId: 'cb' + '1'.repeat(32), changeSummary: '옵션 B 가격 갱신' } });
  const p = memoPrompt(b);
  const data = JSON.parse(p.messages[1].content.replace(/^Untrusted memo data \(JSON\):\n/, ''));
  assert.equal(data.brief.stage, 'design'); assert.equal(data.brief.responseLanguage, 'ko');
  assert.deepEqual(data.brief.revision, { parentId: 'cb' + '1'.repeat(32), changeSummary: '옵션 B 가격 갱신', changeSummaryTruncated: false });
  assert.equal(data.brief.kind, 'user-statement-unverified');
  const snap = JSON.parse(p.snapshot);
  assert.equal(snap.brief.stage, 'design'); assert.equal(snap.brief.revision.changeSummary, '옵션 B 가격 갱신');
  assert.ok(!MM.isMemoSnapshotCurrent(p.snapshot, { ...b, stage: 'launch' }, completed), 'stage change detected');
  assert.ok(!MM.isMemoSnapshotCurrent(p.snapshot, { ...b, revision: { ...b.revision, changeSummary: '다름' } }, completed), 'revision change detected');
  assert.ok(MM.isMemoSnapshotCurrent(p.snapshot, { ...b, budget: { maxExperts: 2, maxModelCalls: 16, maxReviewCalls: 0, maxMemoCalls: 1 } }, completed), 'budget is a documented exclusion');
  const long = memoPrompt(memoBrief({ revision: { parentId: 'cb' + '1'.repeat(32), changeSummary: '가'.repeat(2000) } }));
  assert.equal(long.coverage.brief.revisionTruncated, true, 'revision text is bounded and its truncation disclosed');
  const old = memoPrompt(memoBrief({ objective: 'Pick a pilot.' }));
  assert.equal(JSON.parse(old.snapshot).brief.stage, 'unspecified'); assert.equal(JSON.parse(old.snapshot).brief.revision, null); assert.equal(old.language, 'en');
});

await check('memo: needs-options reason is deterministic KO/EN text with no paid call', () => {
  const ko = MM.memoMessages(memoBrief({ decision: undefined }), completed);
  assert.equal(ko.kind, 'needs-options'); assert.equal(ko.language, 'ko'); assert.equal(ko.reason, MM.MEMO_PLAN_REASONS.ko.needsOptions); assert.ok(/[가-힣]/.test(ko.reason));
  const en = MM.memoMessages(memoBrief({ decision: undefined, responseLanguage: 'en' }), completed);
  assert.equal(en.reason, MM.MEMO_PLAN_REASONS.en.needsOptions);
  assert.equal(MM.memoPlan(memoBrief(), []).reason, MM.MEMO_PLAN_REASONS.ko.noOpinions);
});

await check('memo: language check over every narrative field; clear mismatch fails with category language, technical Korean accepted', () => {
  const ko = memoPrompt(memoBrief()), en = memoPrompt(memoBrief({ responseLanguage: 'en' }));
  assert.deepEqual(MM.parseMemoReply(memoReply(EN_MEMO), ko), { invalid: 'memo is not written in the selected language (ko)', category: 'language' });
  assert.ok(!('invalid' in MM.parseMemoReply(memoReply(KO_MEMO), ko)), JSON.stringify(MM.parseMemoReply(memoReply(KO_MEMO), ko)));
  assert.equal(MM.parseMemoReply(memoReply(KO_MEMO), en).category, 'language');
  assert.ok(!('invalid' in MM.parseMemoReply(memoReply(EN_MEMO), en)));
  assert.ok(ko.messages[0].content.includes(MM.MEMO_LANGUAGE_INSTRUCTIONS.ko) && ko.messages[1].content.includes('두 파일럿 중 하나를 고른다.'), 'explicit KO rule plus the actual objective');
});

await check('memo: honest absence/negation of consensus or a vote is allowed (EN/KO); positive unsupported agreement is still refused', () => {
  const en = memoPrompt(memoBrief({ responseLanguage: 'en' })), ko = memoPrompt(memoBrief());
  for (const d of ['No consensus can be inferred from two conflicting directions.', 'No vote was taken; experts stated directions toward the brief only.',
    'There is no consensus among the experts, and no peer verification happened.', 'Experts did not vote on the options.'])
    assert.ok(!('invalid' in MM.parseMemoReply(memoReply({ ...EN_MEMO, dissent: d }), en)), d);
  for (const d of ['전문가 간 합의는 확인되지 않았다.', '투표는 진행되지 않았고 각자 방향만 밝혔다.', '합의에 도달하지 않았으며 상호 검증도 없었다.', '모든 전문가가 동의한 것은 아니다.'])
    assert.ok(!('invalid' in MM.parseMemoReply(memoReply({ ...KO_MEMO, dissent: d }), ko)), d);
  for (const d of ['All experts agree on option-2.', 'exp-a voted for option-2.', 'The experts reached a consensus on Plan B.', 'The decision was unanimous.', 'The majority of experts support Plan B.'])
    assert.match(MM.parseMemoReply(memoReply({ ...EN_MEMO, dissent: d }), en).invalid ?? '', /vote or consensus/, d);
  for (const d of ['모든 전문가가 동의했다.', '만장일치로 Plan B를 골랐다.', '전문가들이 합의에 도달했다.', '전원 찬성으로 결정되었다.'])
    assert.match(MM.parseMemoReply(memoReply({ ...KO_MEMO, dissent: d }), ko).invalid ?? '', /vote or consensus/, d);
  assert.ok(!/do not use the words/.test(en.messages[0].content), 'no broad word ban in the prompt');
});

console.log(`cloudbite language: ${count} checks passed (outputs left under ${tmp})`);
