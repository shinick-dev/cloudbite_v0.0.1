// Focused tests for tools/cloudbite-quality-batch.mjs. Every export built here is test-synthetic: a fabricated input
// that exercises the batch workflow, never a model output and never a quality result.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as Q from '../tools/evaluate-cloudbite-quality.mjs';
import * as B from '../tools/cloudbite-quality-batch.mjs';

const ROOT = Q.ROOT;
const MAIN_ROOT = join(ROOT, '..', '..'); // worktree layout: <root>/.worktrees/<name>
const PRODUCTION = [join(ROOT, '.artifacts/release-unify/production-run.json'), join(MAIN_ROOT, '.artifacts/release-unify/production-run.json')].find(existsSync);
const RUN_DIR = join(ROOT, '.artifacts', 'quality-batch-test', `${Date.now()}-${randomBytes(4).toString('hex')}`);
mkdirSync(RUN_DIR, { recursive: true });
const sha = (b) => createHash('sha256').update(b).digest('hex');
const cases = Q.loadCases();
const NOW = new Date('2026-10-19T00:00:00Z');
const T0 = Date.UTC(2026, 9, 18, 12, 0, 0);
const quiet = () => {};

let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log('ok', name); };

const RELEVANT_EDA = 'The late hold violations came after manual ECOs, so an ECO regression suite targets the observed failure. Expanding from 6 to 14 corners is an alternative, but its runtime on the current compute quota is unmeasured (an assumption, not a fact). If a one-week runtime probe shows 14 corners fit the quota, add corners before release; otherwise build the ECO regression suite first. Next step: measure corner runtime, then decide.';

/** Schema-valid HistoryDetail for a case. roles: {id, status?, error?, report?}. Timestamps are fake unless `timed`. */
function exportFor(caseId, roles, { model = 'test/model-a', mode = 'demo', stage, status = 'completed', timed = false, usage, promptChar = 'a' } = {}) {
  const c = cases.get(caseId), brief = structuredClone(c.brief);
  if (stage !== undefined) brief.stage = stage;
  brief.expertIds = roles.map((r) => r.id); brief.mode = mode; brief.requestId = 'quality-batch-0001';
  const at = (s) => timed ? T0 + s * 1000 : s;
  return {
    project: { id: 'p-batch-test', brief, status, createdAt: at(0), updatedAt: at(120), evidenceClaims: [], ...(usage ? { usage } : {}),
      experts: roles.map((r, i) => {
        const st = r.status ?? 'completed', done = st === 'completed';
        return { id: `e${i}`, expertId: r.id, name: r.id, status: st, activity: [{ id: 'a0', at: at(1), kind: 'status', message: 'queued' }], artifacts: [], updatedAt: at(30 + i * 10),
          ...(r.error ? { error: r.error } : {}),
          ...(done ? { opinion: { direction: 'conditional', confidence: 50, summary: r.report ?? RELEVANT_EDA, evidence: ['planning note'], assumptions: ['runtime unmeasured'], nextActions: ['measure runtime'] } } : {}) };
      }) },
    model, roles: roles.map((r) => ({ id: r.id, basis: 'curated-knowledge', revision: '1'.repeat(40), promptHash: promptChar.repeat(64) })),
    reports: Object.fromEntries(roles.filter((r) => (r.status ?? 'completed') === 'completed').map((r) => [r.id, r.report ?? RELEVANT_EDA])),
  };
}
const bytesOf = (d) => Buffer.from(JSON.stringify(d, null, 2));
let dirN = 0;
/** Fresh folder holding the given exports and a manifest naming them. */
function batchDir(files, entries, batchId = `b${++dirN}`) {
  const dir = join(RUN_DIR, `in-${dirN}`); mkdirSync(dir, { recursive: true });
  for (const [name, detail] of Object.entries(files)) writeFileSync(join(dir, name), Buffer.isBuffer(detail) ? detail : bytesOf(detail));
  const manifest = join(dir, 'manifest.json');
  writeFileSync(manifest, JSON.stringify({ version: B.BATCH_VERSION, batchId, entries }));
  return { dir, manifest, out: join(RUN_DIR, `out-${dirN}`) };
}
const run = (m, extra = []) => B.runBatch(['run', '--manifest', m.manifest, '--out', m.out, ...extra], { log: quiet, now: NOW });
const CASE = 'q-eda-signoff-scope';

await test('manifest bounds: entry count, unknown keys, unknown cases and undeclared provenance are refused', () => {
  const ok = { caseId: CASE, input: 'a.json', provenance: 'test-synthetic' };
  const parse = (m) => B.parseManifest(Buffer.from(JSON.stringify({ version: B.BATCH_VERSION, batchId: 'x', ...m })), cases);
  assert.equal(parse({ entries: [ok] }).entries.length, 1);
  assert.equal(B.MANIFEST_LIMITS.entries, Q.INPUT_LIMITS.inputs);
  assert.throws(() => parse({ entries: Array.from({ length: Q.INPUT_LIMITS.inputs + 1 }, () => ok) }), /entries must list 1-20/);
  assert.throws(() => parse({ entries: [] }), /entries must list/);
  assert.throws(() => parse({ entries: [{ ...ok, score: 4 }] }), /unknown key score/);
  assert.throws(() => parse({ entries: [{ ...ok, caseId: 'q-nope' }] }), /not a known case/);
  assert.throws(() => parse({ entries: [{ ...ok, baseline: 'b.json' }] }), /baselineProvenance must be declared/);
  assert.throws(() => parse({ entries: [{ ...ok, collection: { collectedAt: 'x'.repeat(501) } }] }), /up to 500/);
  assert.throws(() => B.parseManifest(Buffer.from(JSON.stringify({ version: 'v0', batchId: '../x', entries: [ok] })), cases), /version must be.*batchId must be/);
  // A file named like a live run is still undeclared: provenance is never inferred from the filename.
  const live = { caseId: CASE, input: 'observed-live-run.json' };
  assert.throws(() => parse({ entries: [live] }), /provenance must be declared/);
  assert.throws(() => parse({ entries: [{ ...live, provenance: 'live' }] }), /provenance must be declared/);
});

await test('actual-vs-synthetic labels: classes come from declared provenance, export mode and held-out status, never pooled', () => {
  const m = batchDir({ 'live.json': exportFor(CASE, [{ id: 'r' }], { mode: 'live', timed: true }), 'demo-says-live.json': exportFor(CASE, [{ id: 'r' }]),
    'qa.json': exportFor(CASE, [{ id: 'r' }], { promptChar: 'b' }), 'syn.json': exportFor(CASE, [{ id: 'r' }], { promptChar: 'c' }) }, [
    { caseId: CASE, input: 'live.json', provenance: 'observed-live', collection: { collectedAt: '2026-10-19T01:00:00Z', method: 'UI export by operator' } },
    { caseId: CASE, input: 'demo-says-live.json', provenance: 'observed-live' },
    { caseId: CASE, input: 'qa.json', provenance: 'synthetic-qa' }, { caseId: CASE, input: 'syn.json', provenance: 'test-synthetic' }]);
  const r = run(m), classes = r.summary.cases.map((c) => c.evidenceClass);
  assert.deepEqual(classes, ['observed-live-held-out', 'observed-live-conflict', 'synthetic-qa', 'test-synthetic']);
  assert.match(r.summary.byEvidenceClass['synthetic-qa'].meaning, /NOT held-out proof/);
  assert.match(r.summary.byEvidenceClass['observed-live-conflict'].meaning, /not counted as live/);
  assert.equal(r.summary.byEvidenceClass['observed-live-held-out'].entries, 1);
  assert.deepEqual(r.summary.cases[0].collection, { collectedAt: '2026-10-19T01:00:00Z', method: 'UI export by operator', operatorSupplied: true, verified: false });
  assert.ok(r.taxonomy.evaluationIssues.items.some((i) => i.kind === 'provenance-conflict'));
  // A synthetic-qa label on the non-held-out smoke case stays synthetic-qa; observed-live there is smoke, not held-out.
  assert.equal(B.evidenceClass({ provenance: { declared: 'observed-live', conflicts: [] } }, cases.get('q-synthetic-falsify-pilot-qa')), 'observed-live-smoke');
  assert.ok(!/"(?:accuracy|winner|qualityScore)"\s*:/i.test(JSON.stringify(r.summary)));
});

await test('absent timing and cost: implausible or missing timestamps are UNAVAILABLE, USD is always UNKNOWN', () => {
  const fake = exportFor(CASE, [{ id: 'r' }]), timed = exportFor(CASE, [{ id: 'r' }, { id: 's' }], { timed: true }), running = exportFor(CASE, [{ id: 'r', status: 'running' }], { status: 'running', timed: true });
  const t0 = B.observedTiming(fake);
  assert.equal(t0.endToEnd.status, B.UNAVAILABLE); assert.match(t0.endToEnd.reason, /plausible epoch/); assert.equal(t0.roles[0].status, B.UNAVAILABLE);
  const t1 = B.observedTiming(timed);
  assert.deepEqual([t1.endToEnd.status, t1.endToEnd.ms], ['OBSERVED', 120_000]); assert.deepEqual(t1.roles.map((x) => x.ms), [29_000, 39_000]);
  assert.equal(t1.crossReview.status, B.UNAVAILABLE);
  const t2 = B.observedTiming(running);
  assert.match(t2.endToEnd.reason, /not terminal/); assert.match(t2.roles[0].reason, /not terminal/);
  const none = B.observedUsage(fake);
  assert.equal(none.calls.status, 'NOT_RECORDED'); assert.equal(none.cost.usd, B.UNKNOWN);
  const phase = (used, max) => ({ used, max, available: max - used, exhausted: false });
  const usage = { version: 'cloudbite-budget/v1', migrated: false, total: phase(5, 12), expert: phase(4, 8), review: phase(1, 3), memo: phase(0, 1), perExpertCalls: 2, exhausted: false, expertsExhausted: false, caps: {}, perExpert: {}, jevCalls: 1, sandboxMaximum: 2 };
  const u = B.observedUsage(exportFor(CASE, [{ id: 'r' }], { usage }));
  assert.deepEqual(u.calls.reservedModelCalls, { total: 5, expert: 4, review: 1, memo: 0 });
  assert.equal(u.calls.jevRoutingCalls, 1); assert.equal(u.cost.usd, B.UNKNOWN); assert.match(u.cost.reason, /not priced token usage/);
  assert.equal(B.observedUsage(exportFor(CASE, [{ id: 'r' }], { usage: { total: { used: -1 } } })).calls.status, 'MALFORMED');
  const m = batchDir({ 'a.json': fake }, [{ caseId: CASE, input: 'a.json', provenance: 'test-synthetic' }]);
  const r = run(m), text = readFileSync(join(r.outDir, 'summary.json'), 'utf8');
  assert.equal(r.summary.cases[0].usage.cost.usd, B.UNKNOWN); assert.equal(r.summary.byEvidenceClass['test-synthetic'].costUsd, B.UNKNOWN);
  assert.deepEqual(r.summary.byEvidenceClass['test-synthetic'].endToEndMs, { observed: 0 });
  assert.ok(!/"(?:usd|costUsd)"\s*:\s*\d/.test(text) && !/tokens?"\s*:/i.test(text), 'no invented money or token figures');
});

await test('failed roles: per-role status counts and a run-failure taxonomy separate from content-review gaps', () => {
  const d = exportFor(CASE, [{ id: 'ok' }, { id: 'boom', status: 'failed', error: 'Nosana inference upstream returned 503' }, { id: 'slow', status: 'failed', error: 'sandbox timed out after 600s' },
    { id: 'stop', status: 'cancelled' }, { id: 'empty', report: '' }], { status: 'partial' });
  d.project.experts[4].opinion = undefined;
  const m = batchDir({ 'p.json': d }, [{ caseId: CASE, input: 'p.json', provenance: 'test-synthetic' }]);
  const r = run(m), row = r.summary.cases[0];
  assert.deepEqual(row.roles.byStatus, { completed: 2, failed: 2, cancelled: 1 });
  const kinds = r.taxonomy.runFailures.byKind;
  assert.deepEqual(kinds, { 'project-partial': 1, 'role-failed:inference': 1, 'role-failed:timeout': 1, 'role-cancelled': 1, 'role-completed-without-output': 1 });
  assert.ok(r.taxonomy.contentReviewGaps.items.some((i) => i.kind === 'human-review-missing'));
  assert.ok(r.taxonomy.contentReviewGaps.items.every((i) => !i.kind.startsWith('role-')));
  assert.match(r.taxonomy.meaning, /Not a model quality score/);
  assert.equal(B.errorKind('HTTP 429 rate limit'), 'rate-limit'); assert.equal(B.errorKind('weird'), 'other');
  const clean = B.failureTaxonomy([]);
  assert.equal(clean.runFailures.note, 'none present in this batch');
});

await test('baseline: only the same case/question/stage/material is compared; regressions are structural or same-reviewer human only', () => {
  const base = exportFor(CASE, [{ id: 'r' }, { id: 's' }]), cand = exportFor(CASE, [{ id: 'r' }, { id: 's', status: 'failed', error: 'result format invalid json' }], { model: 'test/model-b', promptChar: 'b', status: 'partial' });
  const other = exportFor(CASE, [{ id: 'r' }], { stage: 'launch', promptChar: 'c' });
  const bb = bytesOf(base), cb = bytesOf(cand);
  const rows = [
    { caseId: CASE, inputSha256: sha(bb), reviewer: 'rev-1', ratedAt: '2026-10-19T01:00:00Z', scores: { relevance: 3, evidence_traceability: 2 } },
    { caseId: CASE, inputSha256: sha(cb), reviewer: 'rev-1', ratedAt: '2026-10-19T02:00:00Z', scores: { relevance: 2 } },
    { caseId: CASE, inputSha256: sha(cb), reviewer: 'rev-2', ratedAt: '2026-10-19T02:00:00Z', scores: { evidence_traceability: 4 } },
  ];
  const m = batchDir({ 'base.json': bb, 'cand.json': cb, 'cand2.json': exportFor(CASE, [{ id: 'r' }], { promptChar: 'e' }), 'other.json': other }, [
    { caseId: CASE, input: 'cand.json', provenance: 'test-synthetic', baseline: 'base.json', baselineProvenance: 'test-synthetic' },
    { caseId: CASE, input: 'cand2.json', provenance: 'test-synthetic', baseline: 'other.json', baselineProvenance: 'test-synthetic' }]);
  writeFileSync(join(m.dir, 'ratings.jsonl'), rows.map((x) => JSON.stringify(x)).join('\n'));
  const r = run(m, ['--ratings', join(m.dir, 'ratings.jsonl')]);
  const [same, diff] = r.entries.map((e) => e.pair);
  assert.equal(same.comparison.status, 'COMPARED'); assert.equal(same.comparison.variables.model.same, false);
  assert.deepEqual(same.structural.regressions.map((c) => c.metric), ['completedRoles', 'failedRoles']);
  assert.deepEqual(same.human.relevance, { status: 'SCORED', pairs: [{ reviewer: 'rev-1', baseline: 3, candidate: 2, delta: -1 }], regressedFor: ['rev-1'] });
  assert.equal(same.human.evidence_traceability.status, Q.NOT_SCORED, 'different reviewers are never paired');
  assert.equal(same.human.facts_vs_assumptions.status, Q.NOT_SCORED);
  assert.deepEqual(same.humanRegressions, ['relevance']);
  assert.equal(diff.comparison.status, 'FAIL'); assert.ok(diff.comparison.problems.includes('different stage'));
  assert.equal(diff.structural, 'NOT_COMPARED'); assert.equal(diff.human, 'NOT_COMPARED');
  assert.equal(r.summary.cases[1].baseline.structuralRegressions, Q.NOT_SCORED);
  assert.ok(r.taxonomy.evaluationIssues.items.some((i) => i.kind === 'baseline-not-comparable'));
  assert.equal(r.exitCode, 3);
  const mapping = JSON.parse(readFileSync(join(r.outDir, 'blind-mapping.json'), 'utf8'));
  assert.equal(mapping.packets[0].answers.length, 2); assert.equal(mapping.packets[1].answers.length, 1);
  assert.match(mapping.packets[1].baselineExcluded, /not comparable/);
  for (const p of [same, diff]) assert.ok(!('winner' in p) && /No winner/.test(p.note));
});

await test('blind packets and templates: deterministic seeded order, no run identity, blank rows stay NOT_SCORED, originals untouched', () => {
  const files = {}, entries = [];
  for (let i = 0; i < 8; i++) {
    files[`b${i}.json`] = exportFor(CASE, [{ id: 'r', report: `${RELEVANT_EDA} Variant x-${i}.` }]);
    files[`c${i}.json`] = exportFor(CASE, [{ id: 'r', report: `${RELEVANT_EDA} Variant y-${i}.` }], { model: 'secret-model-name/x', promptChar: 'd' });
    entries.push({ caseId: CASE, input: `c${i}.json`, provenance: 'test-synthetic', baseline: `b${i}.json`, baselineProvenance: 'test-synthetic' });
  }
  const raw = Object.fromEntries(Object.entries(files).map(([k, v]) => [k, bytesOf(v)]));
  const m = batchDir(raw, entries, 'blind');
  const r1 = run(m, ['--seed', 'seed-one']);
  const again = B.reviewPackets(r1.entries, 'seed-one'), other = B.reviewPackets(r1.entries, 'seed-two');
  assert.deepEqual(again.mapping, r1.review.mapping, 'same seed, same order');
  assert.notDeepEqual(other.mapping.map((p) => p.answers.map((a) => a.role)), r1.review.mapping.map((p) => p.answers.map((a) => a.role)), 'seed changes the order');
  assert.ok(r1.review.mapping.some((p) => p.answers[0].role === 'baseline') && r1.review.mapping.some((p) => p.answers[0].role === 'candidate'));
  assert.equal(readdirSync(join(r1.outDir, 'review')).filter((f) => f.endsWith('.md')).length, 8);
  for (const p of r1.review.packets) {
    assert.ok(!/secret-model-name|test\/model-a|d{64}|a{64}|baseline|candidate|confidence:/i.test(p.markdown), p.id);
    assert.match(p.markdown, /## Answer A[\s\S]*## Answer B/);
  }
  const tpl = readFileSync(join(r1.outDir, 'review', 'rating-template.jsonl'), 'utf8');
  const rows = tpl.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows.length, 16);
  for (const row of rows) { assert.equal(row.reviewer, null); assert.equal(row.ratedAt, null); assert.ok(Q.HUMAN_DIMENSIONS.every((d) => row.scores[d] === null)); }
  const mappedShas = new Set(r1.review.mapping.flatMap((p) => p.answers.map((a) => a.inputSha256)));
  assert.deepEqual(new Set(rows.map((x) => x.inputSha256)), mappedShas);
  for (const s of mappedShas) assert.ok(Object.values(raw).some((b) => sha(b) === s), 'template binds the exact input bytes');
  // An unfilled template fed back as ratings is rejected row by row, so nothing becomes scored.
  const parsed = Q.parseRatings(tpl);
  assert.equal(parsed.rows.length, 0); assert.equal(parsed.errors.length, 16);
  const rep = Q.evaluateCase({ bytes: raw['c0.json'], inputName: 'c0.json', caseRecord: cases.get(CASE), provenance: 'test-synthetic', ratings: parsed, now: NOW });
  assert.equal(rep.human.status, Q.NOT_SCORED); assert.deepEqual(rep.remainingHumanReview, Q.HUMAN_DIMENSIONS);
  // A row the reviewer fills in themselves is accepted as is.
  const filled = { ...rows[0], reviewer: 'independent-reviewer', ratedAt: '2026-10-20T09:00:00Z', scores: { ...rows[0].scores, relevance: 3 } };
  assert.equal(Q.parseRatings(JSON.stringify(filled)).rows.length, 1);
  for (const [k, b] of Object.entries(raw)) assert.deepEqual(readFileSync(join(m.dir, k)), b, `${k} unchanged`);
  const caseDirs = readdirSync(join(r1.outDir, 'cases'));
  assert.equal(caseDirs.length, 16);
  for (const d of caseDirs) { const o = readFileSync(join(r1.outDir, 'cases', d, 'original.json')); assert.equal(sha(o).slice(0, 12), d.split('__')[1]); }
  assert.equal(r1.summary.blinding.seedSource, 'operator --seed'); assert.ok(!JSON.stringify(r1.summary).includes('seed-one'));
  assert.throws(() => run(m, ['--seed', 'seed-one']), /refusing to overwrite batch output/);
  assert.equal(run(m, ['--seed', 'seed-one', '--force']).exitCode, 0);
});

await test('no secret output: credential-bearing inputs, manifests and arguments are refused before anything is written', () => {
  const leak = exportFor(CASE, [{ id: 'r', report: RELEVANT_EDA + ' Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345' }]);
  const m = batchDir({ 'ok.json': exportFor(CASE, [{ id: 'r' }]), 'leak.json': leak }, [
    { caseId: CASE, input: 'ok.json', provenance: 'test-synthetic' }, { caseId: CASE, input: 'leak.json', provenance: 'test-synthetic' }]);
  assert.throws(() => run(m), /refusing entries\[1\]\.input: credential-like content \(bearer\)/);
  assert.ok(!existsSync(m.out), 'no partial output');
  try { run(m); } catch (e) { assert.ok(!e.message.includes('abcdefghij'), 'error does not echo the secret'); }
  const p = batchDir({ 'p.json': exportFor(CASE, [{ id: 'r', report: RELEVANT_EDA + ' Mail a.person@example.org' }]) }, [{ caseId: CASE, input: 'p.json', provenance: 'test-synthetic' }]);
  assert.throws(() => run(p), /possible personal data/);
  assert.equal(run(p, ['--allow-private-local']).entries[0].candidate.report.privateDataSuspected[0], 'email');
  for (const bad of [['--token', 'x'], ['--cookie=a=b'], ['--live'], ['--header', 'h']]) assert.throws(() => run(m, bad), /refusing argument/);
  assert.throws(() => run(m, ['--seed', 'sk-' + 'A'.repeat(30)]), /looks like a credential/);
  const sm = batchDir({ 'ok.json': exportFor(CASE, [{ id: 'r' }]) }, [{ caseId: CASE, input: 'ok.json', provenance: 'test-synthetic', collection: { note: 'token ghp_' + 'x'.repeat(30) } }]);
  assert.throws(() => run(sm), /refusing manifest: credential-like content/);
  assert.throws(() => run(p, ['--allow-private-local', '--out', join(ROOT, 'docs', 'cloudbite')]), /tracked or unignored/);
});

await test('malicious paths: escapes, absolute, drive, UNC, URL, non-JSON and junction/symlink paths are refused', () => {
  const good = exportFor(CASE, [{ id: 'r' }]);
  const m = batchDir({ 'ok.json': good }, []);
  writeFileSync(join(RUN_DIR, 'outside.json'), bytesOf(good)); writeFileSync(join(m.dir, 'notes.txt'), 'x');
  const target = join(RUN_DIR, 'elsewhere'); mkdirSync(target, { recursive: true }); writeFileSync(join(target, 'x.json'), bytesOf(good));
  let linked = false;
  try { symlinkSync(target, join(m.dir, 'linked'), 'junction'); linked = true; } catch { console.log('  junction not creatable here; link case skipped'); }
  const cases_ = [['../outside.json', /escapes the manifest folder/], [join(RUN_DIR, 'outside.json'), /must be relative/], ['C:outside.json', /must be relative/],
    ['\\\\server\\share\\x.json', /must be relative/], ['//server/share/x.json', /must be relative/], ['https://example.com/x.json', /must be relative/],
    ['sub/../../outside.json', /escapes/], ['missing.json', /not found/], ['notes.txt', /unexpected file type/], ['ok.json\u0000.txt', /control characters/],
    ...(linked ? [['linked/x.json', /symlink or junction/]] : [])];
  for (const [p, re] of cases_) {
    writeFileSync(m.manifest, JSON.stringify({ version: B.BATCH_VERSION, batchId: 'paths', entries: [{ caseId: CASE, input: p, provenance: 'test-synthetic' }] }));
    assert.throws(() => run(m), re, p);
  }
  assert.throws(() => B.runBatch(['run', '--manifest', 'https://example.com/m.json'], { log: quiet }), /local file/);
  assert.throws(() => B.runBatch(['run', '--manifest', '\\\\server\\m.json'], { log: quiet }), /local file/);
  writeFileSync(m.manifest, JSON.stringify({ version: B.BATCH_VERSION, batchId: 'paths', entries: [{ caseId: CASE, input: 'ok.json', provenance: 'test-synthetic' }] }));
  assert.equal(run(m).exitCode, 0);
});

await test('recorded unified-release production run through the batch (synthetic QA smoke, not held-out proof)', () => {
  if (!PRODUCTION) { console.log('  skipped: .artifacts/release-unify/production-run.json not present'); return; }
  const m = batchDir({}, [{ caseId: 'q-synthetic-falsify-pilot-qa', input: 'production-run.json', provenance: 'synthetic-qa' }], 'production');
  copyFileSync(PRODUCTION, join(m.dir, 'production-run.json'));
  const raw = readFileSync(PRODUCTION), r = run(m), row = r.summary.cases[0];
  assert.equal(r.exitCode, 0); assert.equal(row.inputSha256, sha(raw));
  assert.equal(row.evidenceClass, 'synthetic-qa'); assert.equal(row.heldOutCase, false);
  assert.equal(row.structure.schema, 'VALID'); assert.equal(row.structure.caseBinding, 'MATCH');
  assert.equal(row.timing.endToEnd.status, 'OBSERVED'); assert.ok(row.timing.endToEnd.ms > 0);
  assert.equal(row.timing.crossReview.status, 'OBSERVED');
  assert.equal(row.usage.calls.status, 'NOT_RECORDED'); assert.equal(row.usage.cost.usd, B.UNKNOWN);
  assert.equal(row.human.status, Q.NOT_SCORED); assert.equal(row.automated, 'NOT_RUN');
  assert.equal(r.review.packets.length, 1); assert.ok(!r.review.packets[0].markdown.includes(r.entries[0].candidate.report.fingerprint.model));
  assert.deepEqual(readFileSync(PRODUCTION), raw);
});

console.log(`cloudbite quality batch: ${n} checks passed (outputs in ${RUN_DIR})`);
