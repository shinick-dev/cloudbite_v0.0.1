// Bounded local batch over recorded Cloudbite exports, built on tools/evaluate-cloudbite-quality.mjs. A manifest names
// each case, its saved export, its declared provenance and an optional baseline export. Nothing is fetched and no model
// is called: the batch re-uses evaluateCase/compareRuns per entry and adds an operational summary (role completion,
// timing only where stored timestamps exist, reserved call counts), a separate failure taxonomy, and blinded human
// review packets with blank rating templates bound to each exact input hash. It never scores, ranks or picks a winner.
//
//   node tools/cloudbite-quality-batch.mjs run --manifest MANIFEST.json [--out DIR] [--seed SEED] [--ratings R.jsonl]
//        [--cases-file CASES.jsonl] [--force] [--allow-outside-repo] [--allow-private-local]
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DEFAULT_FIXTURE, FORBIDDEN_ARG, HUMAN_DIMENSIONS, INPUT_LIMITS, NOT_SCORED, PROVENANCES,
  compareMarkdown, compareRuns, evaluateCase, loadCases, parseExport, parseRatings, readBoundedFile, resolveOutput,
  scanSensitive, toCsv, toMarkdown, writeNew,
} from './evaluate-cloudbite-quality.mjs';

export const BATCH_VERSION = 'cloudbite-quality-batch/v1';
export const MANIFEST_LIMITS = Object.freeze({ bytes: 256 * 1024, entries: INPUT_LIMITS.inputs, path: 512, text: 500 });
export const UNKNOWN = 'UNKNOWN', UNAVAILABLE = 'UNAVAILABLE';
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ENTRY_KEYS = new Set(['caseId', 'input', 'provenance', 'baseline', 'baselineProvenance', 'collection']);
const COLLECTION_KEYS = new Set(['collectedAt', 'method', 'note']);
const TERMINAL_ROLE = new Set(['completed', 'failed', 'cancelled']);
const TERMINAL_PROJECT = new Set(['completed', 'partial', 'failed', 'cancelled']);
// Stored timestamps are epoch milliseconds; anything outside this window is treated as not genuinely recorded.
const EPOCH_MIN = Date.UTC(2024, 0, 1), EPOCH_MAX = Date.UTC(2100, 0, 1);
const EVIDENCE_CLASSES = Object.freeze({
  'observed-live-held-out': 'Operator-declared recorded live run of an authored held-out case. Still not a verdict: human scores decide.',
  'observed-live-smoke': 'Operator-declared recorded live run of a non-held-out smoke case; operational evidence only, not held-out proof.',
  'observed-live-conflict': 'Declared observed-live but the export contradicts it (see provenance conflicts); not counted as live.',
  'synthetic-qa': 'Synthetic QA run (deployment smoke brief): operational evidence only, NOT held-out proof and not a benchmark.',
  'test-synthetic': 'Fabricated test input written by a test; not a model output.',
});

const sha256 = (v) => createHash('sha256').update(v).digest('hex');
const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isCount = (v) => Number.isInteger(v) && v >= 0;
const plausibleAt = (v) => Number.isFinite(v) && v >= EPOCH_MIN && v <= EPOCH_MAX;
const tally = (items, key) => items.reduce((o, x) => { const k = key(x); o[k] = (o[k] ?? 0) + 1; return o; }, {});

/** Mirror of src/cloudbite-history.ts errorKind so batch failure kinds read the same as the history report. */
export function errorKind(s) {
  if (/schema|out\/result|invalid.*json|not json|result format/i.test(s)) return 'format';
  if (/timed? ?out|deadline/i.test(s)) return 'timeout';
  if (/429|rate.limit/i.test(s)) return 'rate-limit';
  if (/402|credit|payment|budget/i.test(s)) return 'budget';
  if (/daytona|sandbox|toolbox/i.test(s)) return 'sandbox';
  if (/nosana|inference|model|upstream/i.test(s)) return 'inference';
  return 'other';
}

// ---------- manifest ----------

/** A manifest path must be relative, stay under the manifest's folder and reach a regular file without any symlink or
 * junction on the way; URLs, UNC/device paths and drive-absolute paths are refused so nothing leaves the local disk. */
export function resolveEntryPath(baseDir, p, at) {
  if (typeof p !== 'string' || !p.trim() || p.length > MANIFEST_LIMITS.path) throw new Error(`${at} must be a relative path up to ${MANIFEST_LIMITS.path} characters`);
  if (/[\0-\x1f]/.test(p)) throw new Error(`${at} contains control characters`);
  if (/^[a-z][a-z0-9+.-]*:/i.test(p) || isAbsolute(p) || /^[\\/]/.test(p)) throw new Error(`${at} must be relative to the manifest (no URL, drive, UNC or absolute path)`);
  const full = resolve(baseDir, p), rel = relative(baseDir, full);
  if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new Error(`${at} escapes the manifest folder`);
  if (!existsSync(full)) throw new Error(`${at} not found`);
  const same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  if (!same(realpathSync.native(full), join(realpathSync.native(baseDir), rel))) throw new Error(`${at} passes through a symlink or junction`);
  return full;
}

const text = (v, at, errors) => { if (v !== undefined && (typeof v !== 'string' || v.length > MANIFEST_LIMITS.text)) errors.push(`${at} must be a string up to ${MANIFEST_LIMITS.text} characters`); };

/** Validates shape and bounds; never infers provenance (a file called live.json is still undeclared). */
export function parseManifest(bytes, cases) {
  let m; try { m = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('manifest is not JSON'); }
  const e = [];
  if (!isRecord(m)) throw new Error('manifest must be a JSON object');
  for (const k of Object.keys(m)) if (!['version', 'batchId', 'entries'].includes(k)) e.push(`unknown manifest key ${k}`);
  if (m.version !== BATCH_VERSION) e.push(`version must be ${BATCH_VERSION}`);
  if (typeof m.batchId !== 'string' || !SLUG.test(m.batchId)) e.push('batchId must be 1-64 letters, digits, dot, dash or underscore');
  if (!Array.isArray(m.entries) || !m.entries.length || m.entries.length > MANIFEST_LIMITS.entries) e.push(`entries must list 1-${MANIFEST_LIMITS.entries} cases`);
  for (const [i, x] of (Array.isArray(m.entries) ? m.entries.slice(0, MANIFEST_LIMITS.entries) : []).entries()) {
    const at = `entries[${i}]`;
    if (!isRecord(x)) { e.push(`${at} must be an object`); continue; }
    for (const k of Object.keys(x)) if (!ENTRY_KEYS.has(k)) e.push(`${at}: unknown key ${k}`);
    if (typeof x.caseId !== 'string' || !cases.has(x.caseId)) e.push(`${at}.caseId is not a known case`);
    if (typeof x.input !== 'string') e.push(`${at}.input is required`);
    if (!PROVENANCES.includes(x.provenance)) e.push(`${at}.provenance must be declared as one of ${PROVENANCES.join(', ')}`);
    if (x.baseline !== undefined && typeof x.baseline !== 'string') e.push(`${at}.baseline must be a path`);
    if (x.baseline !== undefined && !PROVENANCES.includes(x.baselineProvenance)) e.push(`${at}.baselineProvenance must be declared when a baseline is given`);
    if (x.baseline === undefined && x.baselineProvenance !== undefined) e.push(`${at}.baselineProvenance without baseline`);
    if (x.collection !== undefined) {
      if (!isRecord(x.collection)) e.push(`${at}.collection must be an object`);
      else for (const [k, v] of Object.entries(x.collection)) { if (!COLLECTION_KEYS.has(k)) e.push(`${at}.collection: unknown key ${k}`); text(v, `${at}.collection.${k}`, e); }
    }
  }
  if (e.length) throw new Error('invalid manifest: ' + e.join('; '));
  return m;
}

// ---------- per-entry measurements (structure only; nothing here is quality) ----------

export function evidenceClass(report, caseRecord) {
  const p = report.provenance.declared;
  if (p === 'observed-live') return report.provenance.conflicts.length ? 'observed-live-conflict' : caseRecord.heldOut === true ? 'observed-live-held-out' : 'observed-live-smoke';
  return p;
}

/** Role completion and failure counts straight from the stored statuses. */
export function roleOutcomes(detail) {
  const p = detail.project, reports = isRecord(detail.reports) ? detail.reports : {};
  const roles = (Array.isArray(p.experts) ? p.experts : []).filter(isRecord).map((x) => {
    const hasOutput = (typeof reports[x.expertId] === 'string' && reports[x.expertId].trim() !== '') || isRecord(x.opinion);
    return { expertId: x.expertId, status: x.status, hasOutput, ...(typeof x.error === 'string' && x.error ? { errorKind: errorKind(x.error), errorExcerpt: x.error.slice(0, 200) } : {}) };
  });
  return { projectStatus: p.status, roles: roles.length, byStatus: tally(roles, (r) => r.status), items: roles };
}

/** Durations only from plausible stored epoch-ms timestamps of terminal records; otherwise UNAVAILABLE with a reason. */
export function observedTiming(detail) {
  const p = detail.project, na = (reason) => ({ status: UNAVAILABLE, reason });
  let endToEnd;
  if (!TERMINAL_PROJECT.has(p.status)) endToEnd = na(`project status ${p.status} was not terminal at export`);
  else if (!plausibleAt(p.createdAt) || !plausibleAt(p.updatedAt) || p.updatedAt < p.createdAt) endToEnd = na('createdAt/updatedAt not recorded as plausible epoch milliseconds');
  else endToEnd = { status: 'OBSERVED', ms: p.updatedAt - p.createdAt, source: 'project.createdAt → project.updatedAt (last stored update; an upper bound that includes review/memo if they ran)' };
  const roles = (p.experts ?? []).filter(isRecord).map((x) => {
    const ats = (Array.isArray(x.activity) ? x.activity : []).map((a) => a?.at).filter(plausibleAt);
    if (!TERMINAL_ROLE.has(x.status)) return { expertId: x.expertId, ...na(`status ${x.status} not terminal`) };
    if (!ats.length || !plausibleAt(x.updatedAt)) return { expertId: x.expertId, ...na('no plausible stored activity/updatedAt timestamps') };
    const start = Math.min(...ats), end = Math.max(x.updatedAt, ...ats);
    return { expertId: x.expertId, status: 'OBSERVED', ms: end - start, source: 'first stored activity → role updatedAt (includes queueing/provisioning)' };
  });
  const cr = p.crossReview;
  const crossReview = !isRecord(cr) ? na('no cross-review recorded') : plausibleAt(cr.startedAt) && plausibleAt(cr.completedAt) && cr.completedAt >= cr.startedAt
    ? { status: 'OBSERVED', ms: cr.completedAt - cr.startedAt, source: 'crossReview.startedAt → completedAt' } : na('cross-review start/completion not both recorded');
  return { endToEnd, roles, crossReview };
}

/** Reserved model-call counts from the stored budget ledger. These are counts, never tokens or money. */
export function observedUsage(detail) {
  const u = detail.project.usage;
  const cost = { usd: UNKNOWN, reason: 'Exports record reserved call counts only, not priced token usage; no USD figure is derived or estimated.' };
  if (u === undefined) return { calls: { status: 'NOT_RECORDED', reason: 'export has no project.usage ledger' }, cost };
  const phase = (k) => isRecord(u[k]) && isCount(u[k].used) ? u[k].used : null;
  const calls = { total: phase('total'), expert: phase('expert'), review: phase('review'), memo: phase('memo') };
  if (!isRecord(u) || calls.total === null) return { calls: { status: 'MALFORMED', reason: 'project.usage present but total.used is not a count' }, cost };
  return {
    calls: { status: 'OBSERVED', source: 'project.usage (budget ledger: reserved calls)', reservedModelCalls: calls,
      jevRoutingCalls: isCount(u.jevCalls) ? u.jevCalls : null, sandboxUpperBound: isCount(u.sandboxMaximum) ? u.sandboxMaximum : null,
      migratedEstimate: u.migrated === true, note: 'Reserved calls are an upper bound of attempts, not tokens, latency or spend.' },
    cost,
  };
}

const PAIR_METRICS = [
  // [name, worse when candidate is ...]
  ['schemaValid', 'lower'], ['caseBound', 'lower'], ['completedRoles', 'lower'], ['failedRoles', 'higher'], ['cancelledRoles', 'higher'],
  ['rolesWithoutOutput', 'higher'], ['invalidCitations', 'higher'], ['crossRoleCitations', 'higher'], ['relevanceWarnings', 'higher'],
  ['possibleFabricatedExecution', 'higher'], ['rubricForbiddenPhrases', 'higher'],
];
function structuralMetrics(report, outcomes) {
  const flags = (report.heuristics.experts ?? []).flatMap((e) => e.flags), cites = report.observed.citations?.byStatus ?? {};
  const count = (f) => flags.filter((x) => x === f).length;
  return {
    schemaValid: report.observed.schema === 'VALID' ? 1 : 0, caseBound: report.caseBinding.status === 'MATCH' ? 1 : 0,
    completedRoles: outcomes.byStatus.completed ?? 0, failedRoles: outcomes.byStatus.failed ?? 0, cancelledRoles: outcomes.byStatus.cancelled ?? 0,
    rolesWithoutOutput: outcomes.items.filter((r) => r.status === 'completed' && !r.hasOutput).length,
    invalidCitations: cites['invalid-citation'] ?? 0, crossRoleCitations: cites['cross-role-citation'] ?? 0,
    relevanceWarnings: count('relevance-warning'), possibleFabricatedExecution: count('possible-fabricated-execution-or-signoff'), rubricForbiddenPhrases: count('rubric-forbidden-phrase'),
  };
}

/** Latest integer score per reviewer and dimension for one exact input. */
function scoresByReviewer(report) {
  const out = new Map();
  for (const r of [...report.human.reviews].sort((a, b) => a.ratedAt < b.ratedAt ? -1 : 1)) {
    const cur = out.get(r.reviewer) ?? {};
    for (const d of HUMAN_DIMENSIONS) if (Number.isInteger(r.scores[d])) cur[d] = { score: r.scores[d], ratedAt: r.ratedAt };
    out.set(r.reviewer, cur);
  }
  return out;
}

/** Baseline vs candidate of the same case/question/stage/material only. Structural deltas are review prompts; human
 * regressions use the same reviewer's scores on both exact inputs; anything else stays NOT_SCORED. No winner. */
export function comparePair(base, cand) {
  const comparison = compareRuns(base.report, cand.report);
  const usable = (s) => s.report.observed.schema === 'VALID' && s.report.caseBinding.status === 'MATCH';
  if (comparison.status === 'COMPARED' && !usable(base)) { comparison.status = 'FAIL'; comparison.problems.push('baseline structure invalid or not bound to the case'); }
  if (comparison.status === 'COMPARED' && !usable(cand)) { comparison.status = 'FAIL'; comparison.problems.push('candidate structure invalid or not bound to the case'); }
  const comparable = comparison.status === 'COMPARED';
  const out = { caseId: cand.report.caseId, baselineSha256: base.report.input.sha256, candidateSha256: cand.report.input.sha256, comparison, comparable,
    note: 'No winner is declared. Structural deltas and flags are prompts for human review, not quality deltas.' };
  if (!comparable) return { ...out, structural: 'NOT_COMPARED', human: 'NOT_COMPARED', reason: 'not the same case/question/stage/material with valid, bound structure on both sides (or the same file twice)' };
  const mb = structuralMetrics(base.report, base.outcomes), mc = structuralMetrics(cand.report, cand.outcomes);
  const changes = PAIR_METRICS.map(([k, worse]) => ({ metric: k, baseline: mb[k], candidate: mc[k], direction: mc[k] === mb[k] ? 'same' : mc[k] > mb[k] ? 'candidate-higher' : 'candidate-lower', worseWhen: worse }));
  const sb = scoresByReviewer(base.report), sc = scoresByReviewer(cand.report);
  const human = Object.fromEntries(HUMAN_DIMENSIONS.map((d) => {
    const pairs = [...sb.keys()].filter((rv) => sc.has(rv) && sb.get(rv)[d] && sc.get(rv)[d])
      .map((rv) => ({ reviewer: rv, baseline: sb.get(rv)[d].score, candidate: sc.get(rv)[d].score, delta: sc.get(rv)[d].score - sb.get(rv)[d].score }));
    return [d, pairs.length ? { status: 'SCORED', pairs, regressedFor: pairs.filter((x) => x.delta < 0).map((x) => x.reviewer) } : { status: NOT_SCORED, reason: 'no reviewer rated this dimension on both exact inputs' }];
  }));
  return { ...out, structural: { changes, regressions: changes.filter((c) => c.direction === (c.worseWhen === 'higher' ? 'candidate-higher' : 'candidate-lower')).map(({ worseWhen: _w, ...c }) => c) },
    human, humanRegressions: HUMAN_DIMENSIONS.filter((d) => human[d].status === 'SCORED' && human[d].regressedFor.length) };
}

// ---------- failure taxonomy ----------

/** Run failures, content-review gaps and evaluation issues kept apart; none is a model quality score. */
export function failureTaxonomy(entries) {
  const run = [], gaps = [], evalIssues = [];
  for (const x of entries) for (const side of [x.candidate, x.baseline].filter(Boolean)) {
    const ref = { caseId: x.caseId, inputSha256: side.report.input.sha256, side: side === x.candidate ? 'candidate' : 'baseline' };
    const o = side.outcomes;
    if (side.report.observed.schema !== 'VALID') evalIssues.push({ ...ref, kind: 'schema-invalid', detail: side.report.observed.schemaErrors.slice(0, 5) });
    if (side.report.caseBinding.status !== 'MATCH') evalIssues.push({ ...ref, kind: 'case-binding-mismatch' });
    for (const c of side.report.provenance.conflicts) evalIssues.push({ ...ref, kind: 'provenance-conflict', detail: c });
    if (o) {
      if (o.projectStatus === 'failed' || o.projectStatus === 'partial' || o.projectStatus === 'cancelled') run.push({ ...ref, kind: `project-${o.projectStatus}` });
      else if (!TERMINAL_PROJECT.has(o.projectStatus)) run.push({ ...ref, kind: 'project-not-terminal-at-export', detail: o.projectStatus });
      for (const r of o.items) {
        if (r.status === 'failed') run.push({ ...ref, subject: r.expertId, kind: `role-failed:${r.errorKind ?? 'no-error-recorded'}`, ...(r.errorExcerpt ? { detail: r.errorExcerpt } : {}) });
        else if (r.status === 'cancelled') run.push({ ...ref, subject: r.expertId, kind: 'role-cancelled' });
        else if (!TERMINAL_ROLE.has(r.status)) run.push({ ...ref, subject: r.expertId, kind: 'role-not-terminal-at-export', detail: r.status });
        else if (!r.hasOutput) run.push({ ...ref, subject: r.expertId, kind: 'role-completed-without-output' });
      }
      if (side.crossReviewStatus === 'failed') run.push({ ...ref, kind: 'cross-review-failed' });
    }
    for (const e of side.report.heuristics.experts ?? []) for (const f of e.flags) gaps.push({ ...ref, subject: e.expertId, kind: `heuristic:${f}` });
    for (const c of side.report.observed.citations?.claims ?? []) if (['invalid-citation', 'cross-role-citation', 'no-citation'].includes(c.status)) gaps.push({ ...ref, subject: c.expertId, kind: `citation:${c.status}` });
    if (side.report.remainingHumanReview.length) gaps.push({ ...ref, kind: 'human-review-missing', detail: side.report.remainingHumanReview });
  }
  for (const x of entries) if (x.pair && !x.pair.comparable) evalIssues.push({ caseId: x.caseId, inputSha256: x.candidate.report.input.sha256, side: 'pair', kind: 'baseline-not-comparable', detail: x.pair.comparison.problems });
  const group = (items, meaning) => ({ meaning, byKind: tally(items, (i) => i.kind), items, ...(items.length ? {} : { note: 'none present in this batch' }) });
  return {
    version: BATCH_VERSION, meaning: 'Triage taxonomy of what went wrong or is still unreviewed. Not a model quality score, not accuracy; counts are not comparable across batches of different size or provenance.',
    runFailures: group(run, 'Operational outcomes stored in the export (role/project/cross-review status and recorded error kind).'),
    contentReviewGaps: group(gaps, 'Heuristic flags, citation ID issues and unscored human dimensions: reasons for a human to look.'),
    evaluationIssues: group(evalIssues, 'Inputs the evaluator could not bind, validate or compare as declared.'),
  };
}

// ---------- blinded review packets ----------

const fence = (s) => { const run = Math.max(2, ...[...String(s).matchAll(/`+/g)].map((m) => m[0].length)); return '`'.repeat(run + 1); };
const block = (s) => { const f = fence(s); return `${f}text\n${s}\n${f}`; };

/** The answer as a reviewer should see it: each role's stored report and opinion text, without model names, prompt or
 * knowledge hashes, sandbox IDs, self-reported confidence or any baseline/candidate label. */
function answerText(detail) {
  const reports = isRecord(detail.reports) ? detail.reports : {}, L = [];
  for (const x of [...(detail.project.experts ?? [])].filter(isRecord).sort((a, b) => a.expertId < b.expertId ? -1 : 1)) {
    L.push(`#### Role ${x.expertId} — status ${x.status}`);
    if (typeof reports[x.expertId] === 'string' && reports[x.expertId].trim()) L.push('', 'Report:', '', block(reports[x.expertId]));
    if (isRecord(x.opinion)) {
      const o = x.opinion;
      L.push('', `Opinion direction: ${o.direction}`, '', 'Summary:', '', block(o.summary ?? ''));
      for (const k of ['evidence', 'assumptions', 'nextActions']) if ((o[k] ?? []).length) L.push('', `${k}:`, '', block(o[k].map((s) => `- ${s}`).join('\n')));
    }
    if (!(typeof reports[x.expertId] === 'string' && reports[x.expertId].trim()) && !isRecord(x.opinion)) L.push('', '_No recorded answer for this role._');
    L.push('');
  }
  return L.join('\n');
}

function questionText(brief) {
  const L = [`**Title:** ${brief.title}`, '', `**Stage:** ${brief.stage ?? 'unspecified'}`, '', '**Objective:**', '', block(brief.objective), '', '**Context:**', '', block(brief.context || '(none)')];
  if (isRecord(brief.decision)) for (const k of ['options', 'constraints', 'successCriteria', 'knownFacts', 'assumptions', 'unknowns'])
    if ((brief.decision[k] ?? []).length) L.push('', `**${k}:**`, '', ...brief.decision[k].map((s) => `- ${s}`));
  for (const d of brief.documents ?? []) L.push('', `**Supplied document \`${d.id}\` (${d.name}) — user-provided, unverified:**`, '', block(d.content));
  return L.join('\n');
}

/** Deterministic, seed-dependent order of the answers in one packet. */
export function blindOrder(seed, caseId, shas) {
  const keyed = shas.map((s) => ({ s, k: sha256(`${seed}\0${caseId}\0${s}`) }));
  return keyed.sort((a, b) => a.k < b.k ? -1 : a.k > b.k ? 1 : 0).map((x) => x.s);
}

export function reviewPackets(entries, seed) {
  const packets = [], template = [], mapping = [];
  entries.forEach((x, i) => {
    const id = `packet-${String(i + 1).padStart(2, '0')}`, c = x.candidate;
    if (c.report.observed.schema !== 'VALID' || c.report.caseBinding.status !== 'MATCH') { mapping.push({ packet: null, caseId: x.caseId, excluded: 'candidate structure invalid or not bound to the case' }); return; }
    const sides = [c, ...(x.pair?.comparable ? [x.baseline] : [])];
    const order = blindOrder(seed, x.caseId, sides.map((s) => s.report.input.sha256));
    const labelled = order.map((s, j) => ({ label: String.fromCharCode(65 + j), side: sides.find((v) => v.report.input.sha256 === s) }));
    const L = [`# Blind review ${id} — case ${x.caseId}`, '',
      'Rate each answer independently on the six dimensions (integer 0-4, or leave null when you cannot judge). Answer labels are',
      'randomised; which run produced which answer is not shown. Enter your own reviewer name and the time you rated in the',
      'template rows for this packet. Leave a dimension null rather than guessing; null stays NOT_SCORED.', '',
      `Dimensions: ${HUMAN_DIMENSIONS.join(', ')}.`, '', '## Question and supplied material', '', questionText(c.detail.project.brief), ''];
    for (const { label, side } of labelled) {
      L.push(`## Answer ${label}`, '', `Bound to input sha256 \`${side.report.input.sha256}\` (copy into the matching template row; do not change).`, '', answerText(side.detail));
      template.push({ caseId: x.caseId, inputSha256: side.report.input.sha256, packet: id, answer: label, reviewer: null, ratedAt: null,
        scores: Object.fromEntries(HUMAN_DIMENSIONS.map((d) => [d, null])), notes: '' });
    }
    L.push('Excluded from this packet: model names, prompt/knowledge hashes, sandbox IDs, self-reported confidence, cross-review verdicts and heuristic flags.', '');
    packets.push({ id, markdown: L.join('\n') });
    mapping.push({ packet: id, caseId: x.caseId, answers: labelled.map(({ label, side }) => ({ answer: label, inputSha256: side.report.input.sha256, role: side === c ? 'candidate' : 'baseline', provenance: side.report.provenance.declared })),
      ...(x.baseline && !x.pair?.comparable ? { baselineExcluded: 'baseline not comparable with candidate' } : {}) });
  });
  return { packets, template, mapping };
}

// ---------- summary ----------

const stats = (ms) => { if (!ms.length) return { observed: 0 }; const s = [...ms].sort((a, b) => a - b); return { observed: s.length, minMs: s[0], medianMs: s[Math.floor((s.length - 1) / 2)], maxMs: s.at(-1) }; };

export function batchSummary(manifest, entries, { seed, seedSource, now }) {
  const rows = entries.map((x) => {
    const r = x.candidate.report;
    return { caseId: x.caseId, inputSha256: r.input.sha256, evidenceClass: x.candidate.evidenceClass, heldOutCase: x.caseRecord.heldOut === true,
      ...(x.collection ? { collection: { ...x.collection, operatorSupplied: true, verified: false } } : {}),
      structure: { schema: r.observed.schema, caseBinding: r.caseBinding.status, provenanceConflicts: r.provenance.conflicts },
      roles: x.candidate.outcomes ? { projectStatus: x.candidate.outcomes.projectStatus, count: x.candidate.outcomes.roles, byStatus: x.candidate.outcomes.byStatus } : UNAVAILABLE,
      timing: x.candidate.timing ?? UNAVAILABLE, usage: x.candidate.usage ?? { calls: { status: UNAVAILABLE }, cost: { usd: UNKNOWN } },
      heuristics: r.heuristics.status === 'COMPUTED' ? { status: 'COMPUTED', flags: tally((r.heuristics.experts ?? []).flatMap((e) => e.flags), (f) => f) } : { status: r.heuristics.status },
      automated: r.automated.modelJudgment, human: { status: r.human.status, remaining: r.remainingHumanReview },
      baseline: x.baseline ? { inputSha256: x.baseline.report.input.sha256, evidenceClass: x.baseline.evidenceClass, comparison: x.pair.comparison.status,
        structuralRegressions: x.pair.comparable ? x.pair.structural.regressions.map((c) => c.metric) : NOT_SCORED, humanRegressions: x.pair.comparable ? x.pair.humanRegressions : NOT_SCORED } : null };
  });
  const byClass = {};
  for (const x of entries) {
    const k = x.candidate.evidenceClass, g = byClass[k] ??= { meaning: EVIDENCE_CLASSES[k], entries: 0, roleStatus: {}, endToEndMs: [], roleMs: [], calls: [] };
    g.entries++;
    for (const [s, n] of Object.entries(x.candidate.outcomes?.byStatus ?? {})) g.roleStatus[s] = (g.roleStatus[s] ?? 0) + n;
    if (x.candidate.timing?.endToEnd.status === 'OBSERVED') g.endToEndMs.push(x.candidate.timing.endToEnd.ms);
    for (const t of x.candidate.timing?.roles ?? []) if (t.status === 'OBSERVED') g.roleMs.push(t.ms);
    if (x.candidate.usage?.calls.status === 'OBSERVED') g.calls.push(x.candidate.usage.calls.reservedModelCalls.total);
  }
  for (const g of Object.values(byClass)) Object.assign(g, { endToEndMs: stats(g.endToEndMs), roleMs: stats(g.roleMs),
    reservedModelCalls: g.calls.length ? { observedEntries: g.calls.length, total: g.calls.reduce((a, b) => a + b, 0) } : { observedEntries: 0 }, calls: undefined, costUsd: UNKNOWN });
  return {
    version: BATCH_VERSION, batchId: manifest.batchId, generatedAt: now.toISOString(), entries: rows.length,
    meaning: 'Operational and structural summary of recorded exports. No aggregate accuracy, quality score or winner is computed. Classes are never pooled: synthetic QA and test inputs are not held-out proof.',
    blinding: { seedSource, seedSha256: sha256(seed), mappingFile: 'blind-mapping.json (do not share with reviewers)' },
    layers: {
      structure: { schema: tally(rows, (r) => r.structure.schema), caseBinding: tally(rows, (r) => r.structure.caseBinding) },
      heuristics: { note: 'Flag occurrences for triage; not a score.', flags: rows.reduce((o, r) => { for (const [f, n] of Object.entries(r.heuristics.flags ?? {})) o[f] = (o[f] ?? 0) + n; return o; }, {}) },
      automated: { modelJudgment: 'NOT_RUN', note: 'No model judge is run by this batch.' },
      human: { status: tally(rows, (r) => r.human.status), note: 'Scores only come from reviewer-supplied rating rows bound to the exact input hash.' },
    },
    byEvidenceClass: byClass, cases: rows,
  };
}

const fmtMs = (t) => t?.status === 'OBSERVED' ? `${(t.ms / 1000).toFixed(1)} s` : UNAVAILABLE;
export function summaryMarkdown(s) {
  const L = [`# Cloudbite quality batch — ${s.batchId}`, '', `Generated ${s.generatedAt} by ${s.version}. ${s.meaning}`, '',
    '| Case | Evidence class | Schema | Binding | Project | Roles (by status) | End-to-end | Reserved calls | USD | Human | Baseline |', '|---|---|---|---|---|---|---|---|---|---|---|'];
  for (const r of s.cases) L.push(`| ${r.caseId} | ${r.evidenceClass} | ${r.structure.schema} | ${r.structure.caseBinding} | ${r.roles.projectStatus ?? UNAVAILABLE} | ${JSON.stringify(r.roles.byStatus ?? {})} | ${fmtMs(r.timing.endToEnd)} | ${r.usage.calls.status === 'OBSERVED' ? r.usage.calls.reservedModelCalls.total : r.usage.calls.status} | ${r.usage.cost.usd} | ${r.human.status} | ${r.baseline ? `${r.baseline.comparison}; structural regressions ${JSON.stringify(r.baseline.structuralRegressions)}; human regressions ${JSON.stringify(r.baseline.humanRegressions)}` : '—'} |`);
  L.push('', '## By evidence class (never pooled)', '');
  for (const [k, g] of Object.entries(s.byEvidenceClass)) L.push(`### ${k}`, '', g.meaning, '', `- Entries: ${g.entries}; role status ${JSON.stringify(g.roleStatus)}`,
    `- End-to-end (observed only): ${JSON.stringify(g.endToEndMs)}; per role: ${JSON.stringify(g.roleMs)}`, `- Reserved model calls: ${JSON.stringify(g.reservedModelCalls)}; USD cost: ${g.costUsd}`, '');
  L.push('## Layers kept separate', '', `- Structure: ${JSON.stringify(s.layers.structure)}`, `- Heuristic flags (triage, not a score): ${JSON.stringify(s.layers.heuristics.flags)}`,
    `- Automated/model judgment: ${s.layers.automated.modelJudgment}`, `- Human: ${JSON.stringify(s.layers.human.status)} — ${s.layers.human.note}`, '',
    'See `failure-taxonomy.md` for run failures and content-review gaps, `review/` for blinded packets and blank rating templates.', '');
  return L.join('\n');
}

export function taxonomyMarkdown(t) {
  const L = ['# Cloudbite quality batch — failure taxonomy', '', t.meaning, ''];
  for (const [k, title] of [['runFailures', 'Run failures'], ['contentReviewGaps', 'Content-review gaps'], ['evaluationIssues', 'Evaluation issues']]) {
    L.push(`## ${title}`, '', t[k].meaning, '');
    if (!t[k].items.length) { L.push('None present in this batch.', ''); continue; }
    L.push('| Kind | Count |', '|---|---|', ...Object.entries(t[k].byKind).map(([kind, n]) => `| ${kind} | ${n} |`), '');
  }
  return L.join('\n');
}

// ---------- run ----------

function loadSide(baseDir, path, at, caseRecord, provenance, ratings, allowPrivate, now) {
  const full = resolveEntryPath(baseDir, path, at), bytes = readBoundedFile(full);
  const sensitive = scanSensitive(bytes.toString('utf8'));
  if (sensitive.some((h) => h.class === 'credential')) throw new Error(`refusing ${at}: credential-like content (${sensitive.map((h) => h.kind).join(', ')}); remove it from the export first`);
  if (sensitive.length && !allowPrivate) throw new Error(`refusing ${at}: possible personal data (${sensitive.map((h) => h.kind).join(', ')}); pass --allow-private-local to keep results in the ignored local folder`);
  const report = evaluateCase({ bytes, inputName: full.split(/[\\/]/).pop(), caseRecord, provenance, ratings, now });
  if (sensitive.length) report.privateDataSuspected = sensitive.map((h) => h.kind);
  const { detail } = parseExport(bytes.toString('utf8'));
  const valid = report.observed.schema === 'VALID';
  return { bytes, report, detail, evidenceClass: evidenceClass(report, caseRecord),
    outcomes: valid ? roleOutcomes(detail) : null, timing: valid ? observedTiming(detail) : null, usage: valid ? observedUsage(detail) : null,
    crossReviewStatus: valid ? detail.project.crossReview?.status : undefined };
}

function parseArgs(argv) {
  for (const a of argv) if (FORBIDDEN_ARG.test(a)) throw new Error(`refusing argument ${a.split('=')[0]}: credentials are never accepted and no live collection is implemented`);
  for (const a of argv) if (scanSensitive(a).some((h) => h.class === 'credential')) throw new Error('refusing: an argument looks like a credential');
  const o = { command: argv[0], flags: new Set() };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i], v = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i]; };
    if (a === '--manifest') o.manifest = v(); else if (a === '--out') o.out = v(); else if (a === '--seed') o.seed = v();
    else if (a === '--ratings') o.ratings = v(); else if (a === '--cases-file') o.casesFile = v();
    else if (['--force', '--allow-outside-repo', '--allow-private-local'].includes(a)) o.flags.add(a);
    else throw new Error(`unknown argument ${a}`);
  }
  if (o.command !== 'run') throw new Error('command must be run');
  if (!o.manifest) throw new Error('--manifest is required');
  if (o.seed !== undefined && (!o.seed.trim() || o.seed.length > 200)) throw new Error('--seed must be 1-200 characters');
  return o;
}

/** Everything is read, validated and evaluated before the first file is written, so a refusal leaves no output. */
export function runBatch(argv, { log = console.log, now = new Date() } = {}) {
  const o = parseArgs(argv);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(o.manifest) || /^[\\/]{2}/.test(o.manifest)) throw new Error('the manifest must be a local file (no URL or UNC path)');
  const manifestPath = resolve(o.manifest), manifestBytes = readBoundedFile(manifestPath, MANIFEST_LIMITS.bytes);
  if (scanSensitive(manifestBytes.toString('utf8')).some((h) => h.class === 'credential')) throw new Error('refusing manifest: credential-like content');
  const cases = loadCases(o.casesFile ? resolve(o.casesFile) : DEFAULT_FIXTURE), manifest = parseManifest(manifestBytes, cases);
  const ratings = o.ratings ? parseRatings(readBoundedFile(o.ratings, INPUT_LIMITS.ratingsBytes, /\.jsonl$/i).toString('utf8')) : undefined;
  const baseDir = dirname(manifestPath), allowPrivate = o.flags.has('--allow-private-local'), seen = new Set();
  const entries = manifest.entries.map((m, i) => {
    const caseRecord = cases.get(m.caseId);
    const candidate = loadSide(baseDir, m.input, `entries[${i}].input`, caseRecord, m.provenance, ratings, allowPrivate, now);
    const key = `${m.caseId}\0${candidate.report.input.sha256}`;
    if (seen.has(key)) throw new Error(`entries[${i}] repeats the same input for case ${m.caseId}`);
    seen.add(key);
    const baseline = m.baseline === undefined ? null : loadSide(baseDir, m.baseline, `entries[${i}].baseline`, caseRecord, m.baselineProvenance, ratings, allowPrivate, now);
    return { caseId: m.caseId, caseRecord, collection: m.collection, candidate, baseline, pair: baseline ? comparePair(baseline, candidate) : null };
  });
  const seed = o.seed ?? manifest.batchId, seedSource = o.seed ? 'operator --seed' : 'default batchId (predictable; pass a private --seed for real blinding)';
  const summary = batchSummary(manifest, entries, { seed, seedSource, now }), taxonomy = failureTaxonomy(entries), review = reviewPackets(entries, seed);

  const outDir = join(resolveOutput(o.out, { allowOutsideRepo: o.flags.has('--allow-outside-repo') }), manifest.batchId), force = o.flags.has('--force');
  if (existsSync(outDir) && !force) throw new Error(`refusing to overwrite batch output ${manifest.batchId}; pass --force`);
  for (const d of ['cases', 'comparisons', 'review']) mkdirSync(join(outDir, d), { recursive: true });
  const put = (rel, data) => writeNew(join(outDir, rel), data, force);
  for (const x of entries) for (const side of [x.candidate, x.baseline].filter(Boolean)) {
    const dir = join('cases', `${x.caseId}__${side.report.input.sha256.slice(0, 12)}`);
    if (existsSync(join(outDir, dir, 'report.json')) && !force) continue; // the same baseline may serve several entries
    mkdirSync(join(outDir, dir), { recursive: true });
    put(join(dir, 'original.json'), side.bytes); put(join(dir, 'report.json'), JSON.stringify(side.report, null, 2) + '\n');
    put(join(dir, 'report.md'), toMarkdown(side.report)); put(join(dir, 'scores.csv'), toCsv(side.report));
  }
  for (const x of entries.filter((e) => e.pair)) {
    const name = join('comparisons', `${x.caseId}__${x.pair.baselineSha256.slice(0, 12)}__${x.pair.candidateSha256.slice(0, 12)}`);
    put(name + '.json', JSON.stringify(x.pair, null, 2) + '\n'); put(name + '.md', compareMarkdown(x.pair.comparison));
  }
  put('summary.json', JSON.stringify(summary, null, 2) + '\n'); put('summary.md', summaryMarkdown(summary));
  put('failure-taxonomy.json', JSON.stringify(taxonomy, null, 2) + '\n'); put('failure-taxonomy.md', taxonomyMarkdown(taxonomy));
  for (const p of review.packets) put(join('review', p.id + '.md'), p.markdown);
  put(join('review', 'rating-template.jsonl'), review.template.map((t) => JSON.stringify(t)).join('\n') + (review.template.length ? '\n' : ''));
  put('blind-mapping.json', JSON.stringify({ version: BATCH_VERSION, batchId: manifest.batchId, seedSource, seed, note: 'Reveals which answer is baseline or candidate. Keep away from reviewers until ratings are in.', packets: review.mapping }, null, 2) + '\n');

  log(`${manifest.batchId}: ${entries.length} entries, ${review.packets.length} review packets, classes ${JSON.stringify(tally(entries, (e) => e.candidate.evidenceClass))}`);
  log(`wrote ${relative(process.cwd(), outDir) || outDir}`);
  const bad = entries.some((x) => [x.candidate, x.baseline].filter(Boolean).some((s) => s.report.observed.schema !== 'VALID' || s.report.caseBinding.status !== 'MATCH') || (x.pair && !x.pair.comparable));
  return { outDir, summary, taxonomy, review, entries, exitCode: bad ? 3 : 0 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.exitCode = runBatch(process.argv.slice(2)).exitCode; }
  catch (err) { console.error('cloudbite-quality-batch: ' + err.message); process.exitCode = 2; }
}
