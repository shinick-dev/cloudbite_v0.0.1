// Offline importer for regression-candidate JSON downloaded from the history view (one person's 0-4 rubric review of one
// exact saved answer, src/cloudbite-human-review.ts). It re-derives every hash from the included material, refuses
// anything that does not bind, and turns the files into inputs the existing offline evaluator already understands:
// a cases file, one HistoryDetail export per answer, rating rows bound to each export's exact bytes, and a batch manifest
// that pairs a later answer of the SAME role to the same question (same question/stage/material and expertId) from a
// DIFFERENT, strictly earlier project with that earlier answer as baseline. Two roles of one run are never a before/after,
// and repeated answers of one role inside one project stay unpaired. human-issues.json compares the person's issue
// categories and scores before/after for the SAME reviewer, role and rubric only.
// Provenance is operator-declared (--provenance, default test-synthetic): the files are not server-signed, so hashes prove
// internal consistency only, never that a provider produced the answer. Declare observed-live only for real history exports.
// Nothing here scores, ranks or declares a winner; unset dimensions stay NOT_SCORED. No network, no model, no cookies.
//
//   node tools/cloudbite-human-review-import.mjs --input A.json [--input B.json ...] [--out DIR] [--batch-id ID]
//        [--provenance observed-live|synthetic-qa|test-synthetic] [--evaluate] [--force] [--allow-outside-repo] [--allow-private-local]
// --evaluate then runs tools/cloudbite-quality-batch.mjs on the written manifest (output in DIR/evaluation/<batch-id>).
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  EVALUATOR_VERSION, FORBIDDEN_ARG, HUMAN_DIMENSIONS, INPUT_LIMITS, NOT_SCORED, PROVENANCES, ROOT, canonical, caseFingerprint, readBoundedFile, resolveOutput, scanSensitive, writeNew,
} from './evaluate-cloudbite-quality.mjs';
import { BATCH_VERSION, runBatch } from './cloudbite-quality-batch.mjs';

export const IMPORT_VERSION = 'cloudbite-human-review-import/v1';
export const CANDIDATE_VERSION = 'cloudbite-regression-candidate/v1';
export const DEFAULT_PROVENANCE = 'test-synthetic';
export const PAIRING_SCOPE = 'Before/after pairs are answers of the same role (expertId) to the same question/stage/material from different projects, '
  + 'strictly older first. Different roles, the same project and equal createdAt are never paired; scores and issues are compared only for the same reviewer.';
export const DEFAULT_IMPORT_OUT = join(ROOT, '.artifacts/human-review-import');
export const ISSUE_CATEGORIES = Object.freeze(['factual-error', 'unsupported-claim', 'missing-source', 'misread-material', 'missing-alternative', 'unsafe-next-step',
  'fabricated-execution', 'too-generic', 'off-topic', 'other']);
const HEX64 = /^[0-9a-f]{64}$/, REVIEWER = /^reviewer-[0-9a-f]{16}$/, PROJECT = /^cb[0-9a-f]{32}$/, EXPERT = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const sha256 = (v) => createHash('sha256').update(v).digest('hex');
const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Validates one downloaded file and re-derives its hashes. Returns { candidate } or { errors } (never repaired). */
export function parseCandidate(text) {
  let c; try { c = JSON.parse(text); } catch { return { errors: ['not JSON'] }; }
  const e = [];
  if (!isRecord(c)) return { errors: ['not an object'] };
  if (c.version !== CANDIDATE_VERSION) e.push(`version must be ${CANDIDATE_VERSION}`);
  const s = c.source, i = c.input, a = c.answer, h = c.human;
  if (!isRecord(s) || !PROJECT.test(s.projectId ?? '') || !EXPERT.test(s.expertId ?? '') || !Number.isSafeInteger(s.createdAt) || s.mode !== 'live' || typeof s.model !== 'string') e.push('source needs projectId, expertId, createdAt, model and mode live');
  if (!isRecord(i) || !isRecord(i.brief) || typeof i.brief.title !== 'string' || typeof i.brief.objective !== 'string' || typeof i.brief.context !== 'string') e.push('input.brief needs title, objective and context');
  if (!isRecord(a) || !isRecord(a.opinion) || (a.report !== null && typeof a.report !== 'string') || a.expertId !== s?.expertId) e.push('answer needs the rated expert\'s opinion and report (or null)');
  if (!isRecord(h) || h.rubric !== EVALUATOR_VERSION || canonical(h.dimensions) !== canonical(HUMAN_DIMENSIONS)) e.push(`human.rubric must be ${EVALUATOR_VERSION} with dimensions ${HUMAN_DIMENSIONS.join(', ')}`);
  else {
    if (!isRecord(h.scores) || Object.keys(h.scores).length !== HUMAN_DIMENSIONS.length || HUMAN_DIMENSIONS.some((d) => !(h.scores[d] === null || (Number.isInteger(h.scores[d]) && h.scores[d] >= 0 && h.scores[d] <= 4)))) e.push('human.scores must give every dimension an integer 0-4 or null');
    if (!Array.isArray(h.issues) || h.issues.length > 6 || h.issues.some((x) => !isRecord(x) || !ISSUE_CATEGORIES.includes(x.category) || typeof x.comment !== 'string' || x.comment.length > 300)) e.push('human.issues must be known categories with short comments');
    if (typeof h.comment !== 'string' || h.comment.length > 1000 || typeof h.regressionCandidate !== 'boolean') e.push('human.comment / regressionCandidate malformed');
    if (!REVIEWER.test(h.reviewer ?? '')) e.push('human.reviewer must be a reviewer-<16 hex> label');
    if (typeof h.recordedAt !== 'string' || Number.isNaN(Date.parse(h.recordedAt)) || !Number.isSafeInteger(h.revision) || h.revision < 1) e.push('human.recordedAt / revision malformed');
  }
  if (e.length) return { errors: e };
  const want = caseFingerprint({ brief: i.brief });
  if (want.questionHash !== i.questionHash || want.stage !== i.stage || want.materialHash !== i.materialHash) e.push('input hashes do not match the included question/stage/material');
  const answer = sha256(canonical({ expertId: a.expertId, opinion: a.opinion, report: a.report }));
  if (answer !== a.answerSha256) e.push('answerSha256 does not match the included answer');
  const output = sha256(canonical({ v: 'cloudbite-human-review-output/v1', projectId: s.projectId, expertId: s.expertId, questionHash: want.questionHash, stage: want.stage, materialHash: want.materialHash, answerSha256: answer }));
  if (!HEX64.test(c.outputSha256 ?? '') || output !== c.outputSha256) e.push('outputSha256 does not match the included input and answer');
  return e.length ? { errors: e } : { candidate: c };
}

export const caseIdFor = (c) => `hr-${c.input.questionHash.slice(0, 12)}-${c.input.materialHash.slice(0, 8)}-${c.input.stage}`;
const scored = (c) => HUMAN_DIMENSIONS.some((d) => Number.isInteger(c.human.scores[d]));

/** The HistoryDetail the evaluator reads: only the rated answer, byte-stable for the same candidate. */
export function exportDetail(c) {
  const s = c.source, role = isRecord(s.role) && typeof s.role.id === 'string' ? s.role : null;
  return JSON.stringify({
    project: { id: s.projectId, status: s.projectStatus, createdAt: s.createdAt, updatedAt: s.createdAt, brief: { ...c.input.brief, expertIds: [s.expertId] }, evidenceClaims: [],
      experts: [{ id: 'run-' + s.expertId, expertId: s.expertId, name: s.expertName ?? s.expertId, status: 'completed', activity: [], artifacts: [], opinion: c.answer.opinion }] },
    model: s.model, roles: role ? [{ id: role.id, basis: role.basis, revision: role.revision, promptHash: role.promptHash }] : [],
    reports: c.answer.report === null ? {} : { [s.expertId]: c.answer.report },
  }, null, 2) + '\n';
}

/** Same reviewer, role and rubric across different projects only: issue categories persisting/resolved/introduced and
 * per-dimension score deltas. Anything else is NOT_SCORED with a reason. */
export function compareHuman(base, cand) {
  const sameReviewer = base.human.reviewer === cand.human.reviewer, sameRole = base.source.expertId === cand.source.expertId;
  const sameProject = base.source.projectId === cand.source.projectId;
  const cats = (c) => c.human.issues.map((x) => x.category);
  const out = { caseId: caseIdFor(cand), rubric: EVALUATOR_VERSION, sameReviewer, sameRole, sameProject, scope: PAIRING_SCOPE,
    baseline: { projectId: base.source.projectId, expertId: base.source.expertId, outputSha256: base.outputSha256, reviewer: base.human.reviewer, issues: cats(base), regressionCandidate: base.human.regressionCandidate },
    candidate: { projectId: cand.source.projectId, expertId: cand.source.expertId, outputSha256: cand.outputSha256, reviewer: cand.human.reviewer, issues: cats(cand), regressionCandidate: cand.human.regressionCandidate },
    note: 'One person\'s annotations of two exact answers to the same question. Differences are prompts for review, not accuracy or a winner.' };
  if (!sameRole) return { ...out, issues: NOT_SCORED, scores: NOT_SCORED, reason: 'different roles: answers of two experts are not a before/after' };
  if (sameProject) return { ...out, issues: NOT_SCORED, scores: NOT_SCORED, reason: 'same project: answers from one run are not a before/after' };
  if (!sameReviewer) return { ...out, issues: NOT_SCORED, scores: NOT_SCORED, reason: 'different reviewers: annotations are not paired' };
  const b = new Set(cats(base)), k = new Set(cats(cand));
  return { ...out,
    issues: { persisting: [...b].filter((x) => k.has(x)), resolved: [...b].filter((x) => !k.has(x)), introduced: [...k].filter((x) => !b.has(x)) },
    scores: Object.fromEntries(HUMAN_DIMENSIONS.map((d) => {
      const x = base.human.scores[d], y = cand.human.scores[d];
      return [d, Number.isInteger(x) && Number.isInteger(y) ? { baseline: x, candidate: y, delta: y - x } : NOT_SCORED];
    })) };
}

/** Pure: candidates → files to write. Later reviews of the same output replace earlier ones; nothing is merged. */
export function buildImport(candidates, { batchId = 'human-review-import', provenance = DEFAULT_PROVENANCE } = {}) {
  if (!SLUG.test(batchId)) throw new Error('--batch-id must be 1-64 letters, digits, dot, dash or underscore');
  if (!PROVENANCES.includes(provenance)) throw new Error(`--provenance must be one of ${PROVENANCES.join(', ')}`);
  const latest = new Map();
  for (const c of candidates) { const cur = latest.get(c.outputSha256); if (!cur || c.human.revision > cur.human.revision) latest.set(c.outputSha256, c); }
  const groups = new Map();
  for (const c of [...latest.values()].sort((x, y) => x.source.createdAt - y.source.createdAt || (x.outputSha256 < y.outputSha256 ? -1 : 1))) {
    const id = caseIdFor(c) + '\n' + c.source.expertId; if (!groups.has(id)) groups.set(id, []); groups.get(id).push(c);
  }
  const cases = [], exports = [], ratings = [], entries = [], comparisons = [], unpaired = [], seenCases = new Set();
  for (const list of groups.values()) {
    const caseId = caseIdFor(list[0]), b = list[0].input.brief;
    // A role answering twice inside one project has no defined before/after: those answers are neither paired nor a baseline.
    const perProject = new Map(); for (const c of list) perProject.set(c.source.projectId, (perProject.get(c.source.projectId) ?? 0) + 1);
    const dup = (c) => perProject.get(c.source.projectId) > 1;
    if (!seenCases.has(caseId)) seenCases.add(caseId), cases.push({ id: caseId, suite: 'human-regression', type: 'regression-candidate', provenance: 'human-review-export', heldOut: false,
      purpose: 'Built from person-reviewed history answers. Not held out and not a benchmark; the rubric anchors are empty on purpose.',
      brief: { title: b.title, objective: b.objective, context: b.context, ...(b.stage ? { stage: b.stage } : {}), ...(b.decision ? { decision: b.decision } : {}), ...(b.documents ? { documents: b.documents } : {}) },
      rubric: { anchors: [], forbiddenPhrases: [] } });
    let prev = null;
    for (const c of list) {
      const base = prev && !dup(c) && prev.source.createdAt < c.source.createdAt ? prev : null;
      const text = exportDetail(c), name = `exports/${caseId}__${c.outputSha256.slice(0, 12)}.json`, inputSha256 = sha256(Buffer.from(text, 'utf8'));
      exports.push({ name, text, caseId, inputSha256 });
      // A review with no integer score adds no rating row: the evaluator keeps every dimension NOT_SCORED.
      if (scored(c)) ratings.push({ caseId, inputSha256, reviewer: c.human.reviewer, ratedAt: c.human.recordedAt, scores: c.human.scores,
        notes: [c.human.comment, c.human.issues.length ? 'issues: ' + c.human.issues.map((x) => x.category).join(', ') : ''].filter(Boolean).join(' | ').slice(0, INPUT_LIMITS.note) });
      entries.push({ caseId, input: name, provenance, ...(base ? { baseline: `exports/${caseId}__${base.outputSha256.slice(0, 12)}.json`, baselineProvenance: provenance } : {}),
        collection: { method: 'history human-review export', collectedAt: c.exportedAt ?? c.human.recordedAt,
          note: `reviewed answer of ${c.source.expertId} in ${c.source.projectId}; provenance operator-declared, not provider-signed` } });
      if (base) comparisons.push(compareHuman(base, c));
      else unpaired.push({ caseId, expertId: c.source.expertId, projectId: c.source.projectId, outputSha256: c.outputSha256,
        reason: dup(c) ? 'same role answered more than once in this project' : prev ? 'same createdAt as the previous answer: order undefined' : 'first answer of this role to this question' });
      if (!dup(c)) prev = c;
    }
  }
  if (entries.length > INPUT_LIMITS.inputs) throw new Error(`at most ${INPUT_LIMITS.inputs} reviewed answers per import (the batch limit)`);
  return { cases, exports, ratings, comparisons, unpaired, provenance, manifest: { version: BATCH_VERSION, batchId, entries } };
}

function parseArgs(argv) {
  for (const a of argv) if (FORBIDDEN_ARG.test(a)) throw new Error(`refusing argument ${a.split('=')[0]}: credentials are never accepted and nothing is fetched`);
  const o = { inputs: [], flags: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i]; };
    if (a === '--input') o.inputs.push(v()); else if (a === '--out') o.out = v(); else if (a === '--batch-id') o.batchId = v(); else if (a === '--provenance') o.provenance = v();
    else if (['--evaluate', '--force', '--allow-outside-repo', '--allow-private-local'].includes(a)) o.flags.add(a);
    else throw new Error(`unknown argument ${a}`);
  }
  if (!o.inputs.length || o.inputs.length > INPUT_LIMITS.inputs) throw new Error(`pass 1-${INPUT_LIMITS.inputs} --input files`);
  return o;
}

/** Everything is read and validated before the first write; a refusal leaves no output. */
export function runImport(argv, { log = console.log } = {}) {
  const o = parseArgs(argv), candidates = [];
  for (const input of o.inputs) {
    const bytes = readBoundedFile(input), text = bytes.toString('utf8'), hits = scanSensitive(text);
    if (hits.some((h) => h.class === 'credential')) throw new Error(`refusing ${input}: credential-like content (${hits.map((h) => h.kind).join(', ')})`);
    if (hits.length && !o.flags.has('--allow-private-local')) throw new Error(`refusing ${input}: possible personal data (${hits.map((h) => h.kind).join(', ')}); pass --allow-private-local to keep results local`);
    const r = parseCandidate(text);
    if (r.errors) throw new Error(`refusing ${input}: ${r.errors.join('; ')}`);
    candidates.push(r.candidate);
  }
  const built = buildImport(candidates, { batchId: o.batchId, provenance: o.provenance });
  const allowOutside = o.flags.has('--allow-outside-repo'), force = o.flags.has('--force');
  const out = resolveOutput(o.out ?? DEFAULT_IMPORT_OUT, { allowOutsideRepo: allowOutside });
  if (existsSync(join(out, 'manifest.json')) && !force) throw new Error(`refusing to overwrite ${out}; pass --force`);
  mkdirSync(join(out, 'exports'), { recursive: true });
  for (const x of built.exports) writeNew(join(out, x.name), x.text, force);
  writeNew(join(out, 'cases.jsonl'), built.cases.map((c) => JSON.stringify(c)).join('\n') + '\n', force);
  writeNew(join(out, 'ratings.jsonl'), built.ratings.map((r) => JSON.stringify(r)).join('\n') + (built.ratings.length ? '\n' : ''), force);
  writeNew(join(out, 'manifest.json'), JSON.stringify(built.manifest, null, 2) + '\n', force);
  writeNew(join(out, 'human-issues.json'), JSON.stringify({ version: IMPORT_VERSION, rubric: EVALUATOR_VERSION, scope: PAIRING_SCOPE,
    provenance: { declared: built.provenance, basis: 'operator-declared via --provenance; not a cryptographic provider proof' },
    comparisons: built.comparisons, unpaired: built.unpaired }, null, 2) + '\n', force);
  log(`${built.manifest.batchId}: ${built.exports.length} reviewed answers, ${built.cases.length} questions, ${built.ratings.length} rating rows, ${built.comparisons.length} before/after pairs, ${built.unpaired.length} unpaired; provenance ${built.provenance} (operator-declared)`);
  log(`wrote ${relative(process.cwd(), out) || out}`);
  let batch = null;
  if (o.flags.has('--evaluate')) {
    batch = runBatch(['run', '--manifest', join(out, 'manifest.json'), '--cases-file', join(out, 'cases.jsonl'), '--out', join(out, 'evaluation'),
      ...(built.ratings.length ? ['--ratings', join(out, 'ratings.jsonl')] : []), ...(force ? ['--force'] : []), ...(allowOutside ? ['--allow-outside-repo'] : []),
      ...(o.flags.has('--allow-private-local') ? ['--allow-private-local'] : [])], { log });
  }
  return { out, built, batch, exitCode: batch ? batch.exitCode : 0 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.exitCode = runImport(process.argv.slice(2)).exitCode; }
  catch (err) { console.error('cloudbite-human-review-import: ' + err.message); process.exitCode = 2; }
}
