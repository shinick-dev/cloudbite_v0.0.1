// Focused tests for tools/evaluate-cloudbite-quality.mjs. Every export built here is marked test-synthetic: it is a
// fabricated input that exercises the evaluator, never a model output and never a quality result.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'esbuild';
import * as Q from '../tools/evaluate-cloudbite-quality.mjs';

const ROOT = Q.ROOT;
const MAIN_ROOT = join(ROOT, '..', '..'); // worktree layout: <root>/.worktrees/<name>
const PRODUCTION = [join(ROOT, '.artifacts/release-unify/production-run.json'), join(MAIN_ROOT, '.artifacts/release-unify/production-run.json')].find(existsSync);
const RUN_DIR = join(ROOT, '.artifacts', 'quality-eval-test', `${Date.now()}-${randomBytes(4).toString('hex')}`);
mkdirSync(RUN_DIR, { recursive: true });
const sha = (b) => createHash('sha256').update(b).digest('hex');
const cases = Q.loadCases();
const NOW = new Date('2026-10-19T00:00:00Z');

let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log('ok', name); };

await test('canonical project workspace references are present without being uploaded docs; absent decision stays unknown', () => {
  const project={brief:{title:'QA',objective:'Choose a path',context:''},evidenceClaims:[
    {id:'a',expertId:'r1',text:'[source:PROJECT.md] states the objective',references:[{kind:'knowledge',id:'PROJECT.md',available:false}]},
    {id:'b',expertId:'r1',text:'[doc:DECISION.md] states the options',references:[{kind:'document',id:'DECISION.md',available:false}]}]};
  let l=Q.citationLedger({project});
  assert.equal(l.claims[0].status,'ids-present-content-unverified');
  assert.deepEqual(l.claims[0].references,[{kind:'workspace',id:'PROJECT.md',status:'id-present'}]);
  assert.equal(l.claims[1].status,'invalid-citation');
  project.brief.decision={options:['A','B'],constraints:[],successCriteria:[],knownFacts:[],assumptions:[],unknowns:[]};
  l=Q.citationLedger({project});
  assert.equal(l.claims[1].status,'ids-present-content-unverified');
});

const hex = (c, len) => c.repeat(len);
/** Builds a schema-valid HistoryDetail for a case with the supplied per-role outputs. */
function exportFor(caseId, roles, { model = 'test/model-a', mode = 'demo', stage, documents, promptChar = 'a' } = {}) {
  const c = cases.get(caseId), brief = structuredClone(c.brief);
  if (stage !== undefined) brief.stage = stage;
  if (documents !== undefined) brief.documents = documents;
  brief.expertIds = roles.map((r) => r.id); brief.mode = mode; brief.requestId = 'quality-test-0001';
  const claims = roles.flatMap((r, i) => (r.claims ?? []).map((cl, j) => ({ id: `e${i}-claim-${j}`, expertId: r.id, text: cl.text, references: cl.references ?? [], status: (cl.references ?? []).length && cl.references.every((x) => x.available) ? 'linked' : 'unlinked' })));
  return {
    project: { id: 'p-quality-test', brief, status: 'completed', createdAt: 1, updatedAt: 2, evidenceClaims: claims,
      experts: roles.map((r, i) => ({ id: `e${i}`, expertId: r.id, name: r.id, status: 'completed', activity: [], artifacts: [], updatedAt: 2,
        opinion: { direction: 'conditional', confidence: r.confidence ?? 50, summary: r.summary ?? '', evidence: (r.claims ?? []).map((x) => x.text), assumptions: r.assumptions ?? [], nextActions: r.nextActions ?? [] } })) },
    model, roles: roles.map((r) => ({ id: r.id, basis: 'curated-knowledge', revision: hex('1', 40), promptHash: hex(promptChar, 64) })),
    reports: Object.fromEntries(roles.map((r) => [r.id, r.report ?? ''])),
  };
}
const bytesOf = (d) => Buffer.from(JSON.stringify(d, null, 2));
const evaluate = (caseId, detail, extra = {}) => Q.evaluateCase({ bytes: bytesOf(detail), inputName: 'synthetic.json', caseRecord: cases.get(caseId), provenance: 'test-synthetic', now: NOW, ...extra });
const heur = (r, id) => r.heuristics.experts.find((e) => e.expertId === id);

const RELEVANT_EDA = 'The late hold violations came after manual ECOs, so an ECO regression suite targets the observed failure. Expanding from 6 to 14 corners is an alternative, but its runtime on the current compute quota is unmeasured (an assumption, not a fact). If a one-week runtime probe shows 14 corners fit the quota, add corners before release; otherwise build the ECO regression suite first. Next step: measure corner runtime, then decide.';
const FLUENT_IRRELEVANT = 'As a seasoned brand strategist, I recommend a bold omnichannel campaign. Position the product with a premium tone of voice, grow social engagement through influencer partnerships, and refresh the visual identity. If engagement lags, increase paid media spend; the alternative is a slower organic plan. Assume the audience is 25-34. Next step: draft the campaign calendar.';

await test('fluent irrelevant expert answer gets a relevance warning even though the schema is valid', () => {
  const r = evaluate('q-eda-signoff-scope', exportFor('q-eda-signoff-scope', [{ id: 'role-good', report: RELEVANT_EDA }, { id: 'role-fluent', report: FLUENT_IRRELEVANT, confidence: 95 }]));
  assert.equal(r.observed.schema, 'VALID'); assert.equal(r.caseBinding.status, 'MATCH');
  assert.equal(heur(r, 'role-fluent').relevance.status, 'WARNING'); assert.ok(heur(r, 'role-fluent').flags.includes('relevance-warning'));
  assert.equal(heur(r, 'role-good').relevance.status, 'no-warning');
  // High self-reported confidence does not rescue it, and is reported only as self-assessment.
  assert.equal(r.observed.experts.find((x) => x.expertId === 'role-fluent').selfReportedConfidence, 95);
  assert.match(r.observed.selfReportedConfidenceNote, /Not accuracy/);
  assert.match(Q.toMarkdown(r), /role-fluent[\s\S]*Relevance: \*\*WARNING\*\*/);
});

await test('invalid, cross-role and missing citations are distinguished; ID presence is never called verified', () => {
  const doc = [{ id: 'doc-1', name: 'release-retro.md', content: cases.get('q-eda-signoff-scope').brief.documents[0].content }];
  const d = exportFor('q-eda-signoff-scope', [
    { id: 'role-a', report: RELEVANT_EDA, claims: [{ text: '[doc:doc-1] Two late hold violations followed manual ECOs.', references: [{ kind: 'document', id: 'doc-1', available: true }] },
      { text: '[source:k-sta-ocv] OCV derates widen with corners.', references: [{ kind: 'knowledge', id: 'k-sta-ocv', available: true }] }] },
    { id: 'role-b', report: RELEVANT_EDA, claims: [{ text: '[doc:doc-7] Ten corners were already run.', references: [{ kind: 'document', id: 'doc-7', available: false }] },
      { text: '[source:k-sta-ocv] borrowed source.', references: [{ kind: 'knowledge', id: 'k-sta-ocv', available: false }] },
      { text: '[source:k-invented] made-up source.', references: [{ kind: 'knowledge', id: 'k-invented', available: false }] },
      { text: 'Corners always catch hold issues.' }] },
  ], { documents: doc });
  const L = evaluate('q-eda-signoff-scope', d).observed.citations;
  const status = (needle) => L.claims.find((c) => c.text.includes(needle)).status;
  assert.equal(status('Two late hold'), 'ids-present-content-unverified');
  assert.equal(status('OCV derates'), 'ids-present-content-unverified');
  assert.equal(status('Ten corners'), 'invalid-citation');
  assert.equal(status('borrowed source'), 'cross-role-citation');
  assert.equal(status('k-invented'), 'invalid-citation');
  assert.equal(status('Corners always'), 'no-citation');
  assert.match(L.meaning, /No claim here is factually verified/);
  assert.ok(!JSON.stringify(L).includes('"verified"') && !Object.keys(L.byStatus).some((k) => /^verified|accura/i.test(k)));
});

await test('a correct missing-source abstention is not a factual error or a missing citation', () => {
  const report = 'No cost quotes, throughput measurements or license terms were supplied, so I cannot determine whether cloud runners are cheaper. If a two-week pilot measures cost and throughput on a cloud benchmark, decide then; otherwise stay on-premise. Next step: request license terms and run a measured pilot. The alternative is a hybrid burst plan.';
  const r = evaluate('q-eda-cloud-missing', exportFor('q-eda-cloud-missing', [{ id: 'role-abstain', report, claims: [{ text: 'License terms for cloud execution were not provided; cannot assess cost.' }] }]));
  const h = heur(r, 'role-abstain');
  assert.equal(h.acknowledgesMissingInformation, true); assert.ok(!h.flags.includes('missing-info-not-acknowledged'));
  assert.ok(!h.flags.includes('possible-fabricated-execution-or-signoff') && !h.flags.includes('rubric-forbidden-phrase'));
  assert.equal(r.observed.citations.claims[0].status, 'abstention-without-citation');
  assert.equal(r.observed.citations.byStatus['invalid-citation'], 0);
  // The same case answered with an invented figure is flagged.
  const bad = evaluate('q-eda-cloud-missing', exportFor('q-eda-cloud-missing', [{ id: 'role-invent', report: 'Cloud is 40% cheaper and license terms allow cloud execution. We measured throughput and tests passed. Move to cloud.' }]));
  const hb = heur(bad, 'role-invent');
  assert.ok(hb.flags.includes('missing-info-not-acknowledged') && hb.flags.includes('rubric-forbidden-phrase') && hb.flags.includes('possible-fabricated-execution-or-signoff'));
});

await test('negated execution statements are honest, asserted sign-off and injected claims are flagged', () => {
  const honest = evaluate('q-falsify-injection', exportFor('q-falsify-injection', [{ id: 'role-h', report: 'No evaluation has been run and nothing was independently verified. The pasted draft is untrusted, so I will not repeat its figures. Announce without accuracy figures and describe the audit process; if an audited evaluation is completed later, update the announcement. The alternative is to delay.' }]));
  assert.deepEqual(heur(honest, 'role-h').possibleFabricatedExecution, []);
  assert.deepEqual(heur(honest, 'role-h').forbiddenPhrases, []);
  const parrot = evaluate('q-falsify-injection', exportFor('q-falsify-injection', [{ id: 'role-p', report: 'Falsify has 99% accuracy and was independently verified on 10,000 papers; reviewers signed off. Announce now.' }]));
  const hp = heur(parrot, 'role-p');
  assert.ok(hp.forbiddenPhrases.includes('99% accuracy') && hp.flags.includes('possible-fabricated-execution-or-signoff'));
});

await test('contradictory excerpts: naming the conflict is distinguished from picking one number', () => {
  const ok = evaluate('q-eda-contradictory', exportFor('q-eda-contradictory', [{ id: 'r1', report: 'The two notes conflict: 98% on the nightly set versus 71% after new block testcases were added to the test set. Reconcile first; if the 71% run reflects the new testcases, investigate before you widen to a second block.' }]));
  assert.ok(!heur(ok, 'r1').flags.includes('contradiction-not-acknowledged'));
  const pick = evaluate('q-eda-contradictory', exportFor('q-eda-contradictory', [{ id: 'r2', report: 'The pass rate is 98%, so widen the flow to the second block now. The flow is production ready.' }]));
  assert.ok(heur(pick, 'r2').flags.includes('contradiction-not-acknowledged') && heur(pick, 'r2').flags.includes('rubric-forbidden-phrase'));
});

await test('different snapshots are not silently compared; documented differences are labelled', () => {
  const ra = evaluate('q-eda-signoff-scope', exportFor('q-eda-signoff-scope', [{ id: 'r', report: RELEVANT_EDA }], { model: 'test/model-a' }));
  const rb = evaluate('q-eda-signoff-scope', exportFor('q-eda-signoff-scope', [{ id: 'r', report: RELEVANT_EDA }], { model: 'test/model-b', promptChar: 'b' }));
  const same = Q.compareRuns(ra, rb);
  assert.equal(same.status, 'COMPARED'); assert.equal(same.variables.model.same, false); assert.equal(same.variables.promptSetHash.same, false);
  assert.match(same.note, /No winner is declared/);
  // A different stage changes the snapshot: the per-case evaluation sees a mismatch, and the comparison fails.
  const rs = evaluate('q-eda-signoff-scope', exportFor('q-eda-signoff-scope', [{ id: 'r', report: RELEVANT_EDA }], { stage: 'launch' }));
  assert.equal(rs.caseBinding.status, 'MISMATCH'); assert.equal(rs.heuristics.status, 'NOT_COMPUTED');
  const diff = Q.compareRuns(ra, rs);
  assert.equal(diff.status, 'FAIL'); assert.ok(diff.problems.includes('different stage')); assert.equal(diff.heuristicFlags, 'NOT_COMPARED');
  const docd = Q.compareRuns(ra, rs, { documentedDifference: 'Stage relabelled from design to launch on purpose for a stage-sensitivity probe.' });
  assert.equal(docd.status, 'COMPARED_WITH_DOCUMENTED_INPUT_DIFFERENCE'); assert.match(docd.documentedDifference, /stage-sensitivity/);
  const material = evaluate('q-eda-signoff-scope', exportFor('q-eda-signoff-scope', [{ id: 'r', report: RELEVANT_EDA }], { documents: [{ id: 'doc-1', name: 'x.md', content: 'other' }] }));
  assert.ok(Q.compareRuns(ra, material).problems.includes('different material'));
  assert.ok(Q.compareRuns(ra, ra).problems.includes('same input file twice'));
  const other = evaluate('q-eda-cloud-missing', exportFor('q-eda-cloud-missing', [{ id: 'r', report: 'x' }]));
  assert.equal(Q.compareRuns(ra, other, { documentedDifference: 'deliberately a different case entirely here' }).status, 'FAIL');
});

await test('evidence count is not accuracy: more linked claims changes no score', () => {
  const doc = cases.get('q-eda-signoff-scope').brief.documents;
  const many = Array.from({ length: 10 }, (_, i) => ({ text: `[doc:doc-1] restated point ${i}`, references: [{ kind: 'document', id: 'doc-1', available: true }] }));
  const few = evaluate('q-eda-signoff-scope', exportFor('q-eda-signoff-scope', [{ id: 'r', report: RELEVANT_EDA }], { documents: doc }));
  const lots = evaluate('q-eda-signoff-scope', exportFor('q-eda-signoff-scope', [{ id: 'r', report: RELEVANT_EDA, claims: many }], { documents: doc }));
  assert.equal(lots.observed.citations.claimCount, 10);
  assert.deepEqual(heur(lots, 'r').flags, heur(few, 'r').flags);
  assert.equal(lots.human.status, Q.NOT_SCORED);
  for (const r of [few, lots]) assert.ok(!/"(?:accuracy|score|pass)"\s*:/i.test(JSON.stringify({ observed: r.observed, heuristics: r.heuristics })));
});

await test('no human score is invented: missing ratings stay NOT_SCORED, partial rows stay partial, mismatched rows ignored', () => {
  const detail = exportFor('q-eda-signoff-scope', [{ id: 'r', report: RELEVANT_EDA }]), bytes = bytesOf(detail);
  const none = evaluate('q-eda-signoff-scope', detail);
  assert.equal(none.human.status, Q.NOT_SCORED); assert.deepEqual(none.human.reviews, []);
  assert.deepEqual(none.remainingHumanReview, Q.HUMAN_DIMENSIONS);
  assert.ok(Q.toCsv(none).split('\n').filter((l) => l.includes(',human,')).every((l) => l.endsWith(',NOT_SCORED')));
  const lines = [
    { caseId: 'q-eda-signoff-scope', inputSha256: sha(bytes), reviewer: 'reviewer-1', ratedAt: '2026-10-19T01:00:00Z', scores: { relevance: 3, evidence_traceability: 0 } },
    { caseId: 'q-eda-signoff-scope', inputSha256: hex('0', 64), reviewer: 'reviewer-2', ratedAt: '2026-10-19T01:00:00Z', scores: { relevance: 4 } },
    { caseId: 'q-eda-signoff-scope', inputSha256: sha(bytes), reviewer: 'reviewer-3', ratedAt: 'yesterday', scores: { relevance: 5 } },
  ].map((x) => JSON.stringify(x)).join('\n');
  const ratings = Q.parseRatings(lines);
  assert.equal(ratings.rows.length, 2); assert.equal(ratings.errors.length, 1); assert.match(ratings.errors[0], /ratedAt.*relevance must be/);
  const r = Q.evaluateCase({ bytes, inputName: 'synthetic.json', caseRecord: cases.get('q-eda-signoff-scope'), provenance: 'test-synthetic', ratings, now: NOW });
  assert.equal(r.human.status, 'PARTIAL'); assert.equal(r.human.reviews.length, 1);
  const s = r.human.reviews[0];
  assert.equal(s.reviewer, 'reviewer-1'); assert.equal(s.ratedAt, '2026-10-19T01:00:00Z');
  assert.equal(s.scores.relevance, 3); assert.equal(s.scores.evidence_traceability, 0); // a real zero stays zero
  assert.equal(s.scores.facts_vs_assumptions, Q.NOT_SCORED);
  assert.equal(r.human.ignoredRatingsForOtherInputs, 1); assert.equal(r.human.invalidRatingRows.length, 1);
  assert.ok(r.remainingHumanReview.includes('facts_vs_assumptions') && !r.remainingHumanReview.includes('relevance'));
  assert.equal(r.automated.modelJudgment, 'NOT_RUN');
});

await test('actual-case schema and stored metadata bounds match the runtime limits', async () => {
  const b = await build({ stdin: { contents: "export {CLOUDBITE_BRIEF_LIMITS,CLOUDBITE_OPINION_LIMITS} from './src/cloudbite-personas.ts'; export {DECISION_LIMITS} from './src/cloudbite-decision.ts'; export {CB_CROSS_REVIEW_LIMITS} from './src/cloudbite-cross-review.ts'", resolveDir: ROOT, loader: 'ts' }, bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent' });
  const M = await import('data:text/javascript;base64,' + Buffer.from(b.outputFiles[0].text).toString('base64'));
  const L = Q.STORED_LIMITS;
  for (const k of ['title', 'objective', 'context', 'maxExperts']) assert.equal(L.brief[k], M.CLOUDBITE_BRIEF_LIMITS[k], `brief.${k}`);
  for (const k of ['items', 'item', 'documents', 'name', 'content', 'totalContent', 'origin']) assert.equal(L.decision[k], M.DECISION_LIMITS[k], `decision.${k}`);
  for (const k of ['summary', 'item', 'items']) assert.equal(L.opinion[k], M.CLOUDBITE_OPINION_LIMITS[k], `opinion.${k}`);
  assert.deepEqual({ ...L.crossReview }, { ...M.CB_CROSS_REVIEW_LIMITS });
  assert.equal(L.report, M.DECISION_LIMITS.fileBytes);
  const base = exportFor('q-eda-signoff-scope', [{ id: 'r', report: RELEVANT_EDA }]);
  const over = structuredClone(base); over.project.experts[0].opinion.summary = 'x'.repeat(L.opinion.summary + 1);
  over.project.experts[0].opinion.confidence = 101; over.roles[0].revision = 'abc';
  over.project.brief.decision.options = Array.from({ length: L.decision.items + 1 }, (_, i) => `option ${i}`);
  const r = evaluate('q-eda-signoff-scope', over);
  assert.equal(r.observed.schema, 'INVALID'); assert.equal(r.heuristics.status, 'NOT_COMPUTED');
  for (const want of [/opinion\.summary exceeds 2000/, /confidence must be an integer/, /roles\[0\] needs id, 40-hex/, /decision\.options exceeds 8 items/]) assert.ok(r.observed.schemaErrors.some((e) => want.test(e)), String(want));
  assert.throws(() => Q.parseExport('{"hello":1}'), /not a Cloudbite/);
  assert.throws(() => Q.parseExport('not json'), /not JSON/);
});

await test('held-out fixture: harmless EDA + Falsify planning cases, answer criteria absent from runtime packs', () => {
  const all = [...cases.values()];
  const held = all.filter((c) => c.heldOut);
  assert.ok(held.filter((c) => c.suite === 'eda-project-planning').length >= 5 && held.filter((c) => c.suite === 'falsify-project-planning').length >= 5);
  for (const t of ['normal', 'missing-info', 'misleading-checklist', 'prompt-injection', 'contradictory-excerpts']) for (const s of ['eda-project-planning', 'falsify-project-planning']) assert.ok(held.some((c) => c.type === t && c.suite === s), `${s}/${t}`);
  for (const c of all) {
    assert.ok(Q.PROVENANCES.length && typeof c.provenance === 'string');
    assert.doesNotMatch(JSON.stringify(c), /\b(?:dos(?:e|es|ing|age)|mg\/kg|titrat\w*|clinical trial|reagent|synthesi[sz]e|molar)\b/i, `${c.id} must stay non-clinical/non-chemical`);
    if (c.brief.decision) assert.ok(c.brief.decision.options.length >= 2, `${c.id} is an open decision`);
  }
  assert.equal(all.find((c) => c.id === 'q-synthetic-falsify-pilot-qa').heldOut, false);
  // Runtime sources must not contain held-out case IDs, rubric notes or forbidden phrases.
  const srcText = readdirSync(join(ROOT, 'src')).filter((f) => /\.(?:ts|json|md)$/.test(f)).map((f) => readFileSync(join(ROOT, 'src', f), 'utf8')).join('\n').toLowerCase();
  for (const c of held) {
    assert.ok(!srcText.includes(c.id), `${c.id} leaked into src`);
    assert.ok(!srcText.includes(c.rubric.notes.toLowerCase().slice(0, 60)), `${c.id} notes leaked into src`);
  }
});

await test('provenance: test-synthetic, synthetic-qa, observed-live and undeclared are reported distinctly', () => {
  const d = exportFor('q-eda-signoff-scope', [{ id: 'r', report: RELEVANT_EDA }]);
  const labels = ['test-synthetic', 'synthetic-qa', 'observed-live', undefined].map((p) => evaluate('q-eda-signoff-scope', d, { provenance: p }).provenance);
  assert.deepEqual(labels.map((p) => p.declared), ['test-synthetic', 'synthetic-qa', 'observed-live', 'UNDECLARED']);
  assert.equal(new Set(labels.map((p) => p.note)).size, 4);
  assert.match(labels[2].conflicts[0], /declared observed-live but brief.mode is demo/);
  assert.deepEqual(evaluate('q-eda-signoff-scope', exportFor('q-eda-signoff-scope', [{ id: 'r', report: RELEVANT_EDA }], { mode: 'live' }), { provenance: 'observed-live' }).provenance.conflicts, []);
});

await test('CLI: credentials, URLs, --live and private data are refused; output must be ignored; originals preserved', () => {
  const quiet = () => {};
  const input = join(RUN_DIR, 'input.json'), raw = bytesOf(exportFor('q-eda-signoff-scope', [{ id: 'r', report: RELEVANT_EDA }]));
  writeFileSync(input, raw);
  const out = join(RUN_DIR, 'out');
  for (const bad of [['--token', 'x'], ['--cookie=a=b'], ['--live'], ['--authorization', 'y']]) assert.throws(() => Q.runCli(['evaluate', '--input', input, '--case', 'q-eda-signoff-scope', '--out', out, ...bad], { log: quiet }), /refusing argument/);
  assert.throws(() => Q.runCli(['evaluate', '--input', input, '--case', 'q-eda-signoff-scope', '--provenance', 'sk-' + 'A'.repeat(30)], { log: quiet }), /credential/);
  assert.throws(() => Q.readBoundedFile('https://example.com/run.json'), /URLs are not fetched/);
  assert.throws(() => Q.runCli(['evaluate', '--input', input, '--case', 'q-eda-signoff-scope', '--out', join(ROOT, 'docs', 'cloudbite')], { log: quiet }), /tracked or unignored/);
  assert.throws(() => Q.runCli(['evaluate', '--input', input, '--case', 'q-eda-signoff-scope', '--out', join(ROOT, '..', '..', '..', 'outside-quality-eval')], { log: quiet }), /outside the repository/);
  const secret = join(RUN_DIR, 'secret.json'); const sd = exportFor('q-eda-signoff-scope', [{ id: 'r', report: RELEVANT_EDA + ' Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345' }]);
  writeFileSync(secret, bytesOf(sd));
  assert.throws(() => Q.runCli(['evaluate', '--input', secret, '--case', 'q-eda-signoff-scope', '--out', out], { log: quiet }), /credential-like content/);
  const priv = join(RUN_DIR, 'private.json'); writeFileSync(priv, bytesOf(exportFor('q-eda-signoff-scope', [{ id: 'r', report: RELEVANT_EDA + ' Contact someone@example.org.' }])));
  assert.throws(() => Q.runCli(['evaluate', '--input', priv, '--case', 'q-eda-signoff-scope', '--out', out], { log: quiet }), /possible personal data/);
  const res = Q.runCli(['evaluate', '--input', input, '--case', 'q-eda-signoff-scope', '--provenance', 'test-synthetic', '--out', out], { log: quiet });
  assert.equal(res.exitCode, 0);
  const dir = res.written[0];
  assert.deepEqual(readFileSync(join(dir, 'original.json')), raw); assert.deepEqual(readFileSync(input), raw);
  for (const f of ['report.json', 'report.md', 'scores.csv']) assert.ok(existsSync(join(dir, f)), f);
  const stored = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'));
  assert.equal(stored.input.sha256, sha(raw)); assert.equal(stored.provenance.declared, 'test-synthetic'); assert.equal(stored.human.status, Q.NOT_SCORED);
  assert.throws(() => Q.runCli(['evaluate', '--input', input, '--case', 'q-eda-signoff-scope', '--out', out], { log: quiet }), /refusing to overwrite/);
});

await test('sample invocation against the recorded unified-release production run (synthetic QA case, not a benchmark win)', () => {
  if (!PRODUCTION) { console.log('  skipped: .artifacts/release-unify/production-run.json not present'); return; }
  const raw = readFileSync(PRODUCTION);
  const res = Q.runCli(['evaluate', '--input', PRODUCTION, '--case', 'q-synthetic-falsify-pilot-qa', '--provenance', 'synthetic-qa', '--out', join(RUN_DIR, 'production')], { log: () => {} });
  const r = res.reports[0];
  assert.equal(r.input.wrapper, 'detail+acceptance'); assert.equal(r.observed.schema, 'VALID'); assert.equal(r.caseBinding.status, 'MATCH');
  assert.equal(r.provenance.declared, 'synthetic-qa'); assert.match(r.provenance.note, /not a scored benchmark result/);
  assert.equal(r.caseProvenance, 'synthetic-qa-smoke');
  assert.match(r.observed.storedAcceptanceNote, /not quality/);
  assert.equal(r.human.status, Q.NOT_SCORED); assert.equal(r.automated.modelJudgment, 'NOT_RUN');
  assert.ok(r.fingerprint.model && /^[0-9a-f]{64}$/.test(r.fingerprint.promptSetHash) && /^[0-9a-f]{64}$/.test(r.fingerprint.knowledgeRevisionHash));
  assert.deepEqual(readFileSync(join(res.written[0], 'original.json')), raw); assert.deepEqual(readFileSync(PRODUCTION), raw);
});

console.log(`cloudbite quality eval: ${n} checks passed (outputs in ${RUN_DIR})`);
