// Offline regression probes for tools/cloudbite-human-review-import.mjs pairing and provenance (HR-1). Every candidate
// here is a test-synthetic fixture built in this file with recomputed hashes: it is NOT an observed production answer.
// No sandbox, model, network or provider call.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import * as Q from '../tools/evaluate-cloudbite-quality.mjs';
import * as I from '../tools/cloudbite-human-review-import.mjs';

let passed = 0;
async function test(name, fn) { try { await fn(); passed++; } catch (err) { console.error(`FAIL ${name}`); throw err; } }
const sha = (s) => createHash('sha256').update(s).digest('hex');
const brief = { title: 'T', objective: 'Should we pilot the vendor plan?', context: 'Pilot context.', mode: 'live', expertIds: ['architect', 'security'], requestId: 'req-12345678' };
const fp = Q.caseFingerprint({ brief });
const all = (v) => Object.fromEntries(Q.HUMAN_DIMENSIONS.map((d) => [d, v]));
const PROJECT = (n) => 'cb' + String(n).repeat(32);
const REVIEWER = 'reviewer-' + 'a'.repeat(16), OTHER = 'reviewer-' + 'b'.repeat(16);

/** Synthetic, hash-consistent regression candidate (same shape as the history export). */
function mk(expertId, { project = 1, createdAt = 1, scores = all(3), issues = [], reviewer = REVIEWER, tag = '' } = {}) {
  const opinion = { direction: 'conditional', confidence: 61, summary: `Opinion of ${expertId}${tag}: pilot only if the SLA is confirmed.`, evidence: [expertId + ' evidence'],
    assumptions: ['SLA unknown'], nextActions: ['Request the SLA before deciding'] }, report = null, projectId = PROJECT(project);
  const answerSha256 = sha(Q.canonical({ expertId, opinion, report }));
  const outputSha256 = sha(Q.canonical({ v: 'cloudbite-human-review-output/v1', projectId, expertId, ...fp, answerSha256 }));
  const c = { version: I.CANDIDATE_VERSION, exportedAt: '2026-10-19T00:00:00.000Z',
    source: { projectId, createdAt, projectStatus: 'completed', mode: 'live', model: 'm', expertId, expertName: expertId, role: null },
    input: { brief, ...fp }, answer: { expertId, status: 'completed', opinion, report, answerSha256 }, outputSha256,
    human: { rubric: Q.EVALUATOR_VERSION, dimensions: Q.HUMAN_DIMENSIONS, scores, issues, comment: '', regressionCandidate: false, reviewer, recordedAt: '2026-10-19T00:00:00.000Z', revision: 1 } };
  assert.equal(I.parseCandidate(JSON.stringify(c)).errors, undefined, 'fixture is a valid candidate');
  return c;
}
function run(cands, extra = []) {
  const d = mkdtempSync(join(tmpdir(), 'cb-hr-import-v5-')), args = [];
  cands.forEach((c, i) => { const f = join(d, `${i}.json`); writeFileSync(f, JSON.stringify(c)); args.push('--input', f); });
  const r = I.runImport([...args, '--out', join(d, 'out'), '--evaluate', '--allow-outside-repo', ...extra], { log: () => {} });
  return { ...r, issues: JSON.parse(readFileSync(join(d, 'out', 'human-issues.json'), 'utf8')) };
}

await test('two roles of one project: no baseline, no comparison, no regression deltas', () => {
  const a = mk('architect', { scores: all(4) }), b = mk('security', { scores: all(1) });
  for (const order of [[a, b], [b, a]]) {
    const built = I.buildImport(order);
    assert.equal(built.cases.length, 1, 'one question → one case');
    assert.equal(built.manifest.entries.length, 2);
    assert.ok(built.manifest.entries.every((e) => e.baseline === undefined), 'no before/after across roles');
    assert.equal(built.comparisons.length, 0);
    assert.deepEqual(built.unpaired.map((u) => u.reason), ['first answer of this role to this question', 'first answer of this role to this question']);
  }
  const cmp = I.compareHuman(a, b);
  assert.equal(cmp.sameRole, false); assert.equal(cmp.sameProject, true);
  assert.equal(cmp.scores, 'NOT_SCORED'); assert.equal(cmp.issues, 'NOT_SCORED'); assert.match(cmp.reason, /different roles/);
  const r = run([a, b]);
  assert.ok(r.batch.entries.every((e) => !e.pair), 'batch has no pair for same-run roles');
  assert.equal(r.issues.comparisons.length, 0); assert.equal(r.issues.unpaired.length, 2); assert.match(r.issues.scope, /same role/);
});

await test('same role, two projects: later answer compares against strictly earlier one, independent of input order', () => {
  const old = mk('architect', { project: 1, createdAt: 1, scores: all(3), issues: [{ category: 'unsupported-claim', comment: '' }] });
  const neu = mk('architect', { project: 2, createdAt: 2, scores: { ...all(2), relevance: 4 }, issues: [{ category: 'missing-source', comment: '' }], tag: ' (revised)' });
  for (const order of [[old, neu], [neu, old]]) {
    const built = I.buildImport(order), [e0, e1] = built.manifest.entries;
    assert.equal(e0.baseline, undefined);
    assert.equal(e1.baseline, e0.input, 'older project is the baseline');
    assert.equal(built.comparisons.length, 1);
    const c = built.comparisons[0];
    assert.equal(c.baseline.projectId, PROJECT(1)); assert.equal(c.candidate.projectId, PROJECT(2));
    assert.deepEqual(c.scores.relevance, { baseline: 3, candidate: 4, delta: 1 });
    assert.deepEqual(c.issues, { persisting: [], resolved: ['unsupported-claim'], introduced: ['missing-source'] });
  }
  const p = run([neu, old]).batch.entries[1].pair;
  assert.equal(p.comparable, true, JSON.stringify(p.comparison?.problems));
  assert.ok(p.humanRegressions.includes('facts_vs_assumptions') && !p.humanRegressions.includes('relevance'));
});

await test('different reviewers: issues and scores stay unpaired (importer and batch)', () => {
  const old = mk('architect', { project: 1, createdAt: 1, scores: all(4), issues: [{ category: 'too-generic', comment: '' }] });
  const neu = mk('architect', { project: 2, createdAt: 2, scores: all(1), reviewer: OTHER, tag: ' (revised)' });
  const r = run([old, neu]), c = r.issues.comparisons[0];
  assert.equal(c.sameReviewer, false); assert.equal(c.scores, 'NOT_SCORED'); assert.equal(c.issues, 'NOT_SCORED'); assert.match(c.reason, /different reviewers/);
  const p = r.batch.entries[1].pair;
  assert.deepEqual(p.humanRegressions, [], 'no cross-reviewer regression');
  assert.ok(Q.HUMAN_DIMENSIONS.every((d) => p.human[d].status === 'NOT_SCORED'));
});

await test('mixed and partial scores: only dimensions scored on both sides compare; unset stays NOT_SCORED', () => {
  const old = mk('architect', { project: 1, createdAt: 1, scores: { ...all(null), relevance: 3, evidence_traceability: 2 } });
  const neu = mk('architect', { project: 2, createdAt: 2, scores: { ...all(null), relevance: 1, facts_vs_assumptions: 4 }, tag: ' (revised)' });
  const c = I.compareHuman(old, neu);
  assert.deepEqual(c.scores.relevance, { baseline: 3, candidate: 1, delta: -2 });
  assert.equal(c.scores.evidence_traceability, 'NOT_SCORED'); assert.equal(c.scores.facts_vs_assumptions, 'NOT_SCORED');
  const p = run([old, neu]).batch.entries[1].pair;
  assert.deepEqual(p.humanRegressions, ['relevance']);
  assert.equal(p.human.facts_vs_assumptions.status, 'NOT_SCORED');
  const blank = mk('security', { scores: all(null) });
  assert.equal(I.buildImport([blank]).ratings.length, 0, 'comment-only review adds no rating row');
});

await test('same role twice in one project and equal createdAt: unpaired, never a baseline', () => {
  const p1 = mk('architect', { project: 1, createdAt: 1 });
  const d1 = mk('architect', { project: 2, createdAt: 2, tag: ' v1' }), d2 = mk('architect', { project: 2, createdAt: 3, scores: all(0), tag: ' v2' });
  const later = mk('architect', { project: 3, createdAt: 4, tag: ' later' });
  const built = I.buildImport([later, d2, p1, d1]);
  const byProject = (n) => built.manifest.entries.filter((e) => e.collection.note.includes(PROJECT(n)));
  assert.ok(byProject(2).every((e) => e.baseline === undefined), 'duplicate same-project answers unpaired');
  assert.equal(byProject(3)[0].baseline, byProject(1)[0].input, 'next pair skips the duplicated project');
  assert.equal(built.comparisons.length, 1);
  assert.equal(built.unpaired.filter((u) => u.reason === 'same role answered more than once in this project').length, 2);
  const same = I.compareHuman(d1, d2);
  assert.equal(same.sameProject, true); assert.equal(same.scores, 'NOT_SCORED'); assert.match(same.reason, /same project/);
  const t1 = mk('security', { project: 4, createdAt: 9 }), t2 = mk('security', { project: 5, createdAt: 9, tag: ' tie' });
  const tie = I.buildImport([t1, t2]);
  assert.equal(tie.comparisons.length, 0); assert.ok(tie.unpaired.some((u) => /same createdAt/.test(u.reason)));
});

await test('provenance: default test-synthetic, explicit operator declaration, invalid refused before write', () => {
  const old = mk('architect', { project: 1, createdAt: 1 }), neu = mk('architect', { project: 2, createdAt: 2, tag: ' (revised)' });
  const def = I.buildImport([old, neu]);
  assert.equal(def.provenance, 'test-synthetic');
  assert.ok(def.manifest.entries.every((e) => e.provenance === 'test-synthetic'), 'source.mode live alone never implies observed-live');
  assert.equal(def.manifest.entries[1].baselineProvenance, 'test-synthetic');
  for (const p of Q.PROVENANCES) assert.ok(I.buildImport([old, neu], { provenance: p }).manifest.entries.every((e) => e.provenance === p));
  assert.throws(() => I.buildImport([old], { provenance: 'live' }), /--provenance must be one of/);
  const r = run([old, neu], ['--provenance', 'synthetic-qa']);
  assert.deepEqual(r.issues.provenance, { declared: 'synthetic-qa', basis: 'operator-declared via --provenance; not a cryptographic provider proof' });
  assert.equal(r.batch.entries[1].candidate.report.provenance.declared, 'synthetic-qa');
  assert.equal(run([old]).batch.entries[0].candidate.report.provenance.declared, 'test-synthetic');
  const d = mkdtempSync(join(tmpdir(), 'cb-hr-import-v5-')), f = join(d, 'a.json'); writeFileSync(f, JSON.stringify(old));
  assert.throws(() => I.runImport(['--input', f, '--out', join(d, 'out'), '--allow-outside-repo', '--provenance', 'observed'], { log: () => {} }), /--provenance/);
  assert.throws(() => readFileSync(join(d, 'out', 'manifest.json')), /ENOENT/);
  // Export bytes (and so their hashes) do not depend on the declared provenance.
  assert.deepEqual(I.buildImport([old], { provenance: 'observed-live' }).exports, I.buildImport([old]).exports);
});

console.log(`cloudbite-v5-human-review-import: ${passed} groups passed (test-synthetic fixtures; no sandbox, model or network).`);
