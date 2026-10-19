// Offline quality evaluator for saved Cloudbite project exports (HistoryDetail, {detail, acceptance} or ProjectRun JSON).
// It never fetches URLs, reads browser cookies or calls a model: it reads recorded outputs, keeps them byte-for-byte,
// and writes four separate layers per case — observed structure, heuristic flags, automated/model annotations, human
// rubric scores. Nothing here is a ground-truth verdict: open project decisions have no single right recommendation,
// an available source ID is not a verified fact, and self-reported confidence is not accuracy.
//
//   node tools/evaluate-cloudbite-quality.mjs evaluate --input RUN.json --case CASE_ID [--input RUN2.json --case ID2]
//        [--provenance observed-live|synthetic-qa|test-synthetic] [--ratings RATINGS.jsonl] [--out DIR]
//   node tools/evaluate-cloudbite-quality.mjs compare --input A.json --input B.json --case CASE_ID
//        [--documented-difference "why question/stage/material differ"] [--out DIR]
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const EVALUATOR_VERSION = 'cloudbite-quality/v1';
export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const DEFAULT_FIXTURE = join(ROOT, 'test/fixtures/cloudbite-project-quality.jsonl');
export const DEFAULT_OUT = join(ROOT, '.artifacts/quality-eval');
export const NOT_SCORED = 'NOT_SCORED';

/** Mirrors of runtime bounds (src/cloudbite-personas.ts, cloudbite-decision.ts, cloudbite-cross-review.ts); the test checks drift. */
export const STORED_LIMITS = Object.freeze({
  brief: { title: 120, objective: 2000, context: 8000, maxExperts: 100 },
  decision: { items: 8, item: 300, documents: 6, name: 120, content: 8000, totalContent: 24000, origin: 500 },
  opinion: { summary: 2000, item: 600, items: 12 },
  crossReview: { findings: 6, summary: 600, rationale: 500 },
  report: 48 * 1024, activity: 4000, artifacts: 200, model: 200,
});
export const INPUT_LIMITS = Object.freeze({ bytes: 8 * 1024 * 1024, inputs: 20, ratingsBytes: 1024 * 1024, ratings: 500, note: 2000 });
export const HUMAN_DIMENSIONS = Object.freeze(['relevance', 'evidence_traceability', 'facts_vs_assumptions', 'alternatives_tradeoffs', 'conditional_next_step', 'no_fabricated_signoff']);
export const PROVENANCES = Object.freeze(['observed-live', 'synthetic-qa', 'test-synthetic']);

const HEX64 = /^[0-9a-f]{64}$/, HEX40 = /^[0-9a-f]{40}$/;
const EXPERT_STATUS = ['queued', 'provisioning', 'running', 'completed', 'failed', 'cancelled'];
const PROJECT_STATUS = ['draft', 'running', 'completed', 'partial', 'failed', 'cancelled'];
const STAGES = ['discovery', 'design', 'validation', 'launch', 'operation', 'unspecified'];
const VERDICTS = ['supported', 'challenged', 'insufficient'];
const DIRECTIONS = ['support', 'conditional', 'concern', 'abstain'];

// Credentials and personal data that must not travel into reports. Matching refuses the run; it never rewrites originals.
const SECRET_PATTERNS = [
  ['api-key', /\bsk-[A-Za-z0-9_-]{20,}/], ['github-token', /\bgh[pousr]_[A-Za-z0-9]{20,}/], ['cloudbite-operator-token', /\bcbo_[A-Za-z0-9_-]{20,}/],
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/], ['bearer', /\bBearer\s+[A-Za-z0-9._~+/-]{16,}/i], ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./],
  ['cookie-header', /\b(?:set-)?cookie\s*[:=]\s*\S+=/i], ['admin-header', /\bx-(?:admin|office)-token\b/i], ['aws-key', /\bAKIA[0-9A-Z]{16}\b/],
];
const PRIVATE_PATTERNS = [['email', /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/], ['kr-resident-number', /\b\d{6}-[1-4]\d{6}\b/]];
const FORBIDDEN_ARG = /^--(?:cookie|cookies|token|auth|authorization|header|bearer|session|password|live)(?:=|$)/i;

const sha256 = (v) => createHash('sha256').update(v).digest('hex');
const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const canonical = (v) => Array.isArray(v) ? '[' + v.map(canonical).join(',') + ']'
  : isRecord(v) ? '{' + Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}'
  : JSON.stringify(v);
const lower = (s) => String(s ?? '').toLowerCase();

export function scanSensitive(text) {
  const hits = [];
  for (const [kind, re] of SECRET_PATTERNS) if (re.test(text)) hits.push({ kind, class: 'credential' });
  for (const [kind, re] of PRIVATE_PATTERNS) if (re.test(text)) hits.push({ kind, class: 'personal-data' });
  return hits;
}

// ---------- input ----------

/** Accepts the three saved shapes and returns the HistoryDetail plus how it was found. Throws on anything else. */
export function parseExport(text) {
  let raw;
  try { raw = JSON.parse(text); } catch { throw new Error('input is not JSON'); }
  if (!isRecord(raw)) throw new Error('input must be a JSON object');
  if (isRecord(raw.detail) && isRecord(raw.detail.project)) return { detail: raw.detail, wrapper: 'detail+acceptance', acceptance: isRecord(raw.acceptance) ? raw.acceptance : undefined };
  if (isRecord(raw.project)) return { detail: raw, wrapper: 'history-detail' };
  if (typeof raw.id === 'string' && isRecord(raw.brief) && Array.isArray(raw.experts)) return { detail: { project: raw, roles: [] }, wrapper: 'project-run' };
  throw new Error('input is not a Cloudbite HistoryDetail, {detail, acceptance} or ProjectRun export');
}

/** Structural schema + stored-bound checks. Returns error strings; empty means VALID (structure only). */
export function validateDetail(detail) {
  const e = [], L = STORED_LIMITS;
  const str = (v, max, at, optional) => { if (v === undefined && optional) return; if (typeof v !== 'string') e.push(`${at} must be a string`); else if (v.length > max) e.push(`${at} exceeds ${max} characters`); };
  const list = (v, max, at) => { if (!Array.isArray(v)) { e.push(`${at} must be an array`); return []; } if (v.length > max) e.push(`${at} exceeds ${max} items`); return v.slice(0, max); };
  const p = detail.project;
  if (!isRecord(p)) return ['project missing'];
  str(p.id, 64, 'project.id');
  if (!PROJECT_STATUS.includes(p.status)) e.push('project.status unknown');
  const b = p.brief;
  if (!isRecord(b)) e.push('project.brief missing');
  else {
    str(b.title, L.brief.title, 'brief.title'); str(b.objective, L.brief.objective, 'brief.objective'); str(b.context, L.brief.context, 'brief.context');
    if (b.mode !== 'live' && b.mode !== 'demo') e.push('brief.mode must be live or demo');
    list(b.expertIds, L.brief.maxExperts, 'brief.expertIds');
    if (b.stage !== undefined && !STAGES.includes(b.stage)) e.push('brief.stage unknown');
    if (b.decision !== undefined) {
      if (!isRecord(b.decision)) e.push('brief.decision must be an object');
      else for (const k of ['options', 'constraints', 'successCriteria', 'knownFacts', 'assumptions', 'unknowns'])
        list(b.decision[k], L.decision.items, `decision.${k}`).forEach((x, i) => str(x, L.decision.item, `decision.${k}[${i}]`));
    }
    let total = 0;
    if (b.documents !== undefined) list(b.documents, L.decision.documents, 'brief.documents').forEach((d, i) => {
      if (!isRecord(d)) { e.push(`documents[${i}] must be an object`); return; }
      str(d.id, 64, `documents[${i}].id`); str(d.name, L.decision.name, `documents[${i}].name`);
      str(d.content, L.decision.content, `documents[${i}].content`); str(d.origin, L.decision.origin, `documents[${i}].origin`, true);
      total += typeof d.content === 'string' ? d.content.length : 0;
    });
    if (total > L.decision.totalContent) e.push(`documents exceed ${L.decision.totalContent} characters in total`);
  }
  const experts = list(p.experts, L.brief.maxExperts, 'project.experts');
  experts.forEach((x, i) => {
    if (!isRecord(x)) { e.push(`experts[${i}] must be an object`); return; }
    str(x.expertId, 64, `experts[${i}].expertId`);
    if (!EXPERT_STATUS.includes(x.status)) e.push(`experts[${i}].status unknown`);
    list(x.activity, L.activity, `experts[${i}].activity`); list(x.artifacts, L.artifacts, `experts[${i}].artifacts`);
    if (x.opinion !== undefined) {
      const o = x.opinion;
      if (!isRecord(o) || !DIRECTIONS.includes(o.direction)) e.push(`experts[${i}].opinion.direction unknown`);
      else {
        if (!Number.isInteger(o.confidence) || o.confidence < 0 || o.confidence > 100) e.push(`experts[${i}].opinion.confidence must be an integer 0-100`);
        str(o.summary, L.opinion.summary, `experts[${i}].opinion.summary`);
        for (const k of ['evidence', 'assumptions', 'nextActions']) list(o[k], L.opinion.items, `experts[${i}].opinion.${k}`).forEach((s, j) => str(s, L.opinion.item, `experts[${i}].opinion.${k}[${j}]`));
      }
    }
  });
  if (p.evidenceClaims !== undefined) list(p.evidenceClaims, L.brief.maxExperts * L.opinion.items, 'project.evidenceClaims').forEach((c, i) => {
    if (!isRecord(c) || !Array.isArray(c.references) || (c.status !== 'linked' && c.status !== 'unlinked')) { e.push(`evidenceClaims[${i}] malformed`); return; }
    str(c.text, L.opinion.item, `evidenceClaims[${i}].text`);
    for (const r of c.references) if (!isRecord(r) || (r.kind !== 'document' && r.kind !== 'knowledge') || typeof r.id !== 'string' || typeof r.available !== 'boolean') e.push(`evidenceClaims[${i}].references malformed`);
  });
  if (p.crossReview !== undefined) {
    const cr = p.crossReview;
    if (!isRecord(cr) || !['running', 'completed', 'failed'].includes(cr.status)) e.push('crossReview.status unknown');
    else list(cr.reports, L.brief.maxExperts, 'crossReview.reports').forEach((r, i) => {
      if (!isRecord(r)) { e.push(`crossReview.reports[${i}] malformed`); return; }
      str(r.summary, L.crossReview.summary, `crossReview.reports[${i}].summary`);
      list(r.findings, L.crossReview.findings, `crossReview.reports[${i}].findings`).forEach((f, j) => {
        if (!isRecord(f) || !VERDICTS.includes(f.verdict)) e.push(`crossReview.reports[${i}].findings[${j}].verdict unknown`);
        else str(f.rationale, L.crossReview.rationale, `crossReview.reports[${i}].findings[${j}].rationale`);
      });
    });
  }
  if (detail.model !== undefined) str(detail.model, L.model, 'model');
  if (detail.roles !== undefined) list(detail.roles, L.brief.maxExperts, 'roles').forEach((r, i) => {
    if (!isRecord(r) || typeof r.id !== 'string' || !HEX40.test(r.revision ?? '') || !HEX64.test(r.promptHash ?? '')) e.push(`roles[${i}] needs id, 40-hex revision and 64-hex promptHash`);
  });
  if (detail.reports !== undefined) {
    if (!isRecord(detail.reports)) e.push('reports must be an object');
    else for (const [k, v] of Object.entries(detail.reports)) str(v, L.report, `reports.${k}`);
  }
  return e;
}

// ---------- fingerprints ----------

const questionOf = (b) => ({ title: b.title, objective: b.objective, context: b.context, decision: b.decision ?? null });
const stageOf = (b) => (b.stage && b.stage !== 'unspecified') ? b.stage : 'unspecified';
const materialOf = (b) => (b.documents ?? []).map((d) => ({ id: d.id, name: d.name, content: d.content }));

/** What was asked and with what material (inputs), separate from what produced the answer (model/prompt/knowledge). */
export function fingerprint(detail, inputBytes) {
  const b = detail.project.brief, roles = Array.isArray(detail.roles) ? detail.roles : [];
  const roleIds = [...roles].map((r) => ({ id: r.id, revision: r.revision, promptHash: r.promptHash, basis: r.basis })).sort((x, y) => x.id < y.id ? -1 : 1);
  return {
    inputSha256: inputBytes === undefined ? undefined : sha256(inputBytes),
    questionHash: sha256(canonical(questionOf(b))), stage: stageOf(b), materialHash: sha256(canonical(materialOf(b))),
    expertIds: [...(b.expertIds ?? [])].sort(),
    model: typeof detail.model === 'string' ? detail.model : null,
    roles: roleIds, promptSetHash: roleIds.length ? sha256(canonical(roleIds.map((r) => [r.id, r.promptHash]))) : null,
    knowledgeRevisionHash: roleIds.length ? sha256(canonical(roleIds.map((r) => [r.id, r.revision]))) : null,
    crossReviewSnapshotHash: detail.project.crossReview?.snapshotHash ?? null,
  };
}

export function caseFingerprint(c) {
  return { questionHash: sha256(canonical(questionOf(c.brief))), stage: stageOf(c.brief), materialHash: sha256(canonical(materialOf(c.brief))) };
}

// ---------- cases & ratings ----------

export function loadCases(path = DEFAULT_FIXTURE) {
  const out = new Map();
  for (const [n, line] of readFileSync(path, 'utf8').split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    const c = JSON.parse(line);
    if (typeof c.id !== 'string' || !isRecord(c.brief) || !isRecord(c.rubric)) throw new Error(`case line ${n + 1} needs id, brief and rubric`);
    if (out.has(c.id)) throw new Error(`duplicate case ${c.id}`);
    out.set(c.id, c);
  }
  return out;
}

/** Human ratings bound to an exact input hash. Invalid rows are reported, never repaired; absent dimensions stay NOT_SCORED. */
export function parseRatings(text) {
  const rows = [], errors = [];
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length > INPUT_LIMITS.ratings) throw new Error(`ratings exceed ${INPUT_LIMITS.ratings} rows`);
  lines.forEach((line, i) => {
    let r; try { r = JSON.parse(line); } catch { errors.push(`ratings line ${i + 1}: not JSON`); return; }
    const bad = [];
    if (!isRecord(r)) bad.push('not an object');
    else {
      if (typeof r.caseId !== 'string') bad.push('caseId');
      if (!HEX64.test(r.inputSha256 ?? '')) bad.push('inputSha256 (64-hex of the evaluated file)');
      if (typeof r.reviewer !== 'string' || !r.reviewer.trim() || r.reviewer.length > 120) bad.push('reviewer');
      if (typeof r.ratedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(r.ratedAt) || Number.isNaN(Date.parse(r.ratedAt))) bad.push('ratedAt (ISO timestamp)');
      if (!isRecord(r.scores)) bad.push('scores');
      else for (const [k, v] of Object.entries(r.scores)) {
        if (!HUMAN_DIMENSIONS.includes(k)) bad.push(`unknown dimension ${k}`);
        else if (v !== null && (!Number.isInteger(v) || v < 0 || v > 4)) bad.push(`${k} must be an integer 0-4 or null`);
      }
      if (r.notes !== undefined && (typeof r.notes !== 'string' || r.notes.length > INPUT_LIMITS.note)) bad.push('notes');
    }
    if (bad.length) errors.push(`ratings line ${i + 1}: invalid ${bad.join(', ')}`);
    else rows.push(r);
  });
  return { rows, errors };
}

export function humanLayer(ratings, caseId, inputSha256) {
  const mine = (ratings?.rows ?? []).filter((r) => r.caseId === caseId && r.inputSha256 === inputSha256);
  const reviews = mine.map((r) => ({
    reviewer: r.reviewer, ratedAt: r.ratedAt, notes: r.notes ?? null,
    scores: Object.fromEntries(HUMAN_DIMENSIONS.map((d) => [d, Number.isInteger(r.scores[d]) ? r.scores[d] : NOT_SCORED])),
  }));
  const unbound = (ratings?.rows ?? []).filter((r) => r.caseId === caseId && r.inputSha256 !== inputSha256).length;
  return {
    status: reviews.length === 0 ? NOT_SCORED : reviews.every((r) => HUMAN_DIMENSIONS.every((d) => r.scores[d] !== NOT_SCORED)) ? 'SCORED' : 'PARTIAL',
    scale: '0-4 per dimension, per reviewer; no aggregate pass/fail is computed',
    dimensions: HUMAN_DIMENSIONS, reviews,
    ...(unbound ? { ignoredRatingsForOtherInputs: unbound } : {}),
    ...(ratings?.errors?.length ? { invalidRatingRows: ratings.errors } : {}),
  };
}

// ---------- heuristics ----------

const NEGATION = /(?:\b(?:no|not|never|without|cannot|can't|unable|nor|neither|hasn't|haven't|has not|have not|did not|didn't|isn't|is not|was not|wasn't|unverified|yet to)\b|않|없|아니|못|전에는|미확인|미검증)/i;
const negatedBefore = (text, index) => {
  const start = Math.max(0, text.lastIndexOf('.', index - 1) + 1, text.lastIndexOf('\n', index - 1) + 1, index - 60);
  return NEGATION.test(text.slice(start, index));
};
/** Positive (non-negated) occurrences of a pattern; a negated "no tests were run" is an honest statement, not a claim. */
function assertedMatches(text, re) {
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'), out = [];
  for (const m of text.matchAll(g)) if (!negatedBefore(text, m.index)) out.push(m[0]);
  return out;
}
const FABRICATED_EXECUTION = [
  /\b(?:i|we) (?:have )?(?:ran|run|executed|re-?ran|simulated|benchmarked|measured|tested|validated|verified)\b/i,
  /\b(?:all )?(?:tests?|regressions?|checks?|benchmarks?) (?:have |has )?(?:all )?passed\b/i,
  /\bsigned[- ]off\b|\bsign-?off (?:is |was |has been )?(?:complete|completed|granted|obtained|given)\b/i,
  /\bindependently (?:verified|validated|confirmed)\b/i, /\bclinically (?:validated|approved|safe)\b/i,
  /\bapproved for (?:clinical|production|tape-?out|release)\b/i, /\b(?:is|are|was|were|has been|have been) (?:fully )?(?:verified|validated|certified)\b/i,
  /(?:실행했|실행 완료|검증 완료|검증했|검증되었|승인 완료|승인되었|서명 완료|사인오프 완료|통과했)/,
];
const ASSUMPTION_MARKERS = /\b(?:assum\w*|unverified|unknown|unmeasured|not (?:yet )?(?:measured|verified|supplied|provided)|uncertain\w*|hypothes\w*)\b|가정|미확인|미측정|불확실|알 수 없/i;
const TRADEOFF_MARKERS = /\b(?:trade-?offs?|versus|vs\.?|alternatives?|instead|compared? (?:with|to)|on the other hand|whereas|downside|risk of)\b|대안|반면|비교|장단점|트레이드오프/i;
const CONDITIONAL_MARKERS = /\b(?:if|unless|once|before|provided that|only after|until|conditional\w*|gate)\b|조건|경우|먼저|이전에|전까지|한 뒤/i;
const ACTION_MARKERS = /\b(?:next steps?|actions?|collect|request|run a|measure|define|schedule|draft|compare|review|audit|pilot|stop|decide)\b|다음 단계|조치|수집|요청|측정|정의|검토|중단|결정/i;
const ABSTENTION_MARKERS = /\b(?:not (?:supplied|provided|available|present|included|given)|unavailable|absent|missing|cannot (?:determine|assess|verify|confirm)|insufficient (?:evidence|information|data)|no (?:\w+ ){0,3}(?:was |were |is |are )?(?:supplied|provided|available|measured))\b|미제공|제공되지 않|확인할 수 없|판단할 수 없|부족/i;
const CONTRADICTION_MARKERS = /\b(?:conflict\w*|contradict\w*|inconsisten\w*|disagree\w*|discrepan\w*|do(?:es)? not agree|mismatch\w*)\b|상충|모순|불일치|엇갈/i;
const STAGE_TERMS = { discovery: /\bdiscover\w*|explor\w*|탐색|발굴/i, design: /\bdesign\w*|설계/i, validation: /\bvalidat\w*|검증/i, launch: /\blaunch\w*|release|rollout|출시|배포/i, operation: /\boperat\w*|maintenance|운영/i };

const anchorHit = (text, group) => group.some((t) => text.includes(lower(t)));
const significant = (s) => lower(s).split(/[^\p{L}\p{N}]+/u).filter((t) => t.length >= 2 && !STOP.has(t));
const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'only', 'our', 'are', 'was', 'per', 'all', 'one', 'two', '에서', '으로', '하는', '있는', '대한']);
/** An option is addressed when at least half its significant tokens appear in the answer. */
function optionAddressed(text, option) {
  const toks = [...new Set(significant(option))];
  if (!toks.length) return false;
  return toks.filter((t) => text.includes(t)).length / toks.length >= 0.5;
}

/** Text the expert produced: saved report.md plus the structured opinion when the export kept it. */
function expertText(detail, run) {
  const parts = [];
  const report = isRecord(detail.reports) ? detail.reports[run.expertId] : undefined;
  if (typeof report === 'string') parts.push(report);
  if (isRecord(run.opinion)) parts.push(run.opinion.summary ?? '', ...(run.opinion.evidence ?? []), ...(run.opinion.assumptions ?? []), ...(run.opinion.nextActions ?? []));
  for (const c of detail.project.evidenceClaims ?? []) if (c.expertId === run.expertId) parts.push(c.text);
  return parts.join('\n');
}

function heuristicsFor(detail, run, c) {
  const text = expertText(detail, run), t = lower(text), r = c.rubric, b = detail.project.brief;
  if (!text.trim()) return { output: 'NO_OUTPUT', flags: ['no-recorded-output'] };
  const flags = [], anchors = r.anchors ?? [];
  const hit = anchors.filter((g) => anchorHit(t, g)).length;
  const coverage = anchors.length ? hit / anchors.length : null;
  // Rubric option anchors are bilingual so a Korean brief answered in English (or the reverse) is not misread as off-topic.
  const options = b.decision?.options ?? [];
  const addressed = options.filter((o, i) => Array.isArray(r.optionAnchors?.[i]) ? anchorHit(t, r.optionAnchors[i]) : optionAddressed(t, o));
  const minCoverage = r.minAnchorCoverage ?? 0.34;
  const relevance = (coverage !== null && coverage < minCoverage) || (options.length > 0 && addressed.length === 0) ? 'WARNING' : 'no-warning';
  if (relevance === 'WARNING') flags.push('relevance-warning');
  const stage = c.brief.stage && STAGE_TERMS[c.brief.stage] ? (STAGE_TERMS[c.brief.stage].test(text) ? 'referenced' : 'not-referenced') : 'not-applicable';
  if (stage === 'not-referenced') flags.push('stage-not-referenced');
  const assumptions = ASSUMPTION_MARKERS.test(text) || (isRecord(run.opinion) && (run.opinion.assumptions ?? []).length > 0);
  if (!assumptions) flags.push('no-explicit-facts-vs-assumptions');
  const tradeoff = TRADEOFF_MARKERS.test(text) || addressed.length >= 2;
  if (!tradeoff) flags.push('no-alternative-or-tradeoff-language');
  const conditional = CONDITIONAL_MARKERS.test(text) && ACTION_MARKERS.test(text);
  if (!conditional) flags.push('no-conditional-next-step-language');
  const fabricated = FABRICATED_EXECUTION.flatMap((re) => assertedMatches(text, re));
  if (fabricated.length) flags.push('possible-fabricated-execution-or-signoff');
  const forbidden = (r.forbiddenPhrases ?? []).filter((p) => assertedMatches(text, new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')).length);
  if (forbidden.length) flags.push('rubric-forbidden-phrase');
  const abstains = ABSTENTION_MARKERS.test(text);
  if (r.expectAbstention && !abstains) flags.push('missing-info-not-acknowledged');
  const contradiction = CONTRADICTION_MARKERS.test(text);
  if (r.expectContradictionNotice && !contradiction) flags.push('contradiction-not-acknowledged');
  return {
    output: 'PRESENT', flags,
    relevance: { status: relevance, anchorCoverage: coverage, anchorsHit: hit, anchors: anchors.length, minAnchorCoverage: minCoverage, optionsAddressed: addressed, options: options.length },
    stage, factsVsAssumptionsLanguage: assumptions, tradeoffLanguage: tradeoff, conditionalNextStepLanguage: conditional,
    possibleFabricatedExecution: fabricated, forbiddenPhrases: forbidden, acknowledgesMissingInformation: abstains,
    acknowledgesContradiction: contradiction,
  };
}

// ---------- citations (structural only) ----------

/** Classifies each stored citation by ID presence. "id-present" means only that the ID exists in the supplied
 * documents or the role's catalogue; whether the cited text supports the claim is NOT checked here. */
export function citationLedger(detail) {
  const p = detail.project, docs = new Set((p.brief.documents ?? []).map((d) => d.id));
  const knowledgeByRole = new Map();
  for (const c of p.evidenceClaims ?? []) for (const r of c.references) if (r.kind === 'knowledge' && r.available) {
    if (!knowledgeByRole.has(r.id)) knowledgeByRole.set(r.id, new Set());
    knowledgeByRole.get(r.id).add(c.expertId);
  }
  const claims = (p.evidenceClaims ?? []).map((c) => {
    const refs = c.references.map((r) => {
      let status;
      if (r.kind === 'document') status = docs.has(r.id) ? 'id-present' : 'unknown-document-id';
      else if (r.available) status = 'id-present';
      else status = [...(knowledgeByRole.get(r.id) ?? [])].some((e) => e !== c.expertId) ? 'cross-role-id' : 'unknown-knowledge-id';
      const storedMismatch = r.kind === 'document' && r.available !== docs.has(r.id);
      return { kind: r.kind, id: r.id, status, ...(storedMismatch ? { storedAvailableMismatch: true } : {}) };
    });
    let status;
    if (!refs.length) status = ABSTENTION_MARKERS.test(c.text) ? 'abstention-without-citation' : /\bdoc:[\w-]+|\b(?:PROJECT|DECISION)\.md\b/.test(c.text) ? 'unbracketed-reference' : 'no-citation';
    else if (refs.some((r) => r.status === 'cross-role-id')) status = 'cross-role-citation';
    else if (refs.some((r) => r.status !== 'id-present')) status = 'invalid-citation';
    else status = 'ids-present-content-unverified';
    return { id: c.id, expertId: c.expertId, status, references: refs, text: c.text };
  });
  const count = (s) => claims.filter((c) => c.status === s).length;
  return {
    meaning: 'ID presence ledger only. No claim here is factually verified; counts are not accuracy.',
    claimCount: claims.length,
    byStatus: Object.fromEntries(['ids-present-content-unverified', 'invalid-citation', 'cross-role-citation', 'no-citation', 'abstention-without-citation', 'unbracketed-reference'].map((s) => [s, count(s)])),
    claims,
  };
}

// ---------- evaluate / compare ----------

function provenanceOf(declared, detail) {
  const mode = detail.project.brief?.mode;
  const label = !declared ? 'UNDECLARED' : declared;
  const conflicts = [];
  if (declared === 'observed-live' && mode !== 'live') conflicts.push(`declared observed-live but brief.mode is ${mode}`);
  if (declared === 'test-synthetic' && mode === 'live' && detail.project.experts?.some((e) => e.sandboxId)) conflicts.push('declared test-synthetic but export records sandbox IDs');
  return {
    declared: label, observedMode: mode ?? null, conflicts,
    note: label === 'observed-live' ? 'Declared by the operator as a recorded live run; the evaluator does not re-observe execution.'
      : label === 'synthetic-qa' ? 'Synthetic QA run: a deployment smoke case, not a scored benchmark result.'
      : label === 'test-synthetic' ? 'Fabricated test input written by the test suite; not a model output.'
      : 'Provenance not declared; treat as unverified.',
  };
}

export function evaluateCase({ bytes, inputName, caseRecord, provenance, ratings, now = new Date() }) {
  const text = bytes.toString('utf8');
  const { detail, wrapper, acceptance } = parseExport(text);
  const schemaErrors = validateDetail(detail);
  const fp = fingerprint(detail, bytes), want = caseFingerprint(caseRecord);
  const binding = { questionMatches: fp.questionHash === want.questionHash, stageMatches: fp.stage === want.stage, materialMatches: fp.materialHash === want.materialHash };
  binding.status = binding.questionMatches && binding.stageMatches && binding.materialMatches ? 'MATCH' : 'MISMATCH';
  const report = {
    evaluator: EVALUATOR_VERSION, evaluatedAt: now.toISOString(), caseId: caseRecord.id, suite: caseRecord.suite, caseType: caseRecord.type,
    caseProvenance: caseRecord.provenance, input: { name: inputName, wrapper, bytes: bytes.length, sha256: fp.inputSha256 },
    provenance: provenanceOf(provenance, detail), fingerprint: fp, caseBinding: binding,
    observed: { schema: schemaErrors.length ? 'INVALID' : 'VALID', schemaErrors },
  };
  if (schemaErrors.length || binding.status !== 'MATCH') {
    report.observed.note = schemaErrors.length ? 'Structure invalid; no heuristic layer computed.' : 'Export does not match the case question/stage/material; no heuristic layer computed.';
    report.heuristics = { status: 'NOT_COMPUTED' };
  } else {
    const p = detail.project;
    report.observed = {
      ...report.observed, projectStatus: p.status,
      experts: p.experts.map((x) => ({ expertId: x.expertId, status: x.status, hasReport: typeof detail.reports?.[x.expertId] === 'string', hasOpinion: isRecord(x.opinion),
        selfReportedConfidence: isRecord(x.opinion) ? x.opinion.confidence : null, artifacts: x.artifacts.length })),
      selfReportedConfidenceNote: 'Self-assessed by each role. Not accuracy and not used by any check.',
      citations: citationLedger(detail),
      crossReview: p.crossReview ? { status: p.crossReview.status, execution: p.crossReview.execution, reports: p.crossReview.reports.length,
        verdicts: Object.fromEntries(VERDICTS.map((v) => [v, p.crossReview.reports.flatMap((r) => r.findings).filter((f) => f.verdict === v).length])),
        note: 'Model-written peer review recorded by the product; a "supported" verdict is not independent verification.' } : null,
      ...(acceptance ? { storedAcceptance: acceptance, storedAcceptanceNote: 'Copied from the export wrapper; operational acceptance, not quality.' } : {}),
    };
    report.heuristics = { status: 'COMPUTED', note: 'Keyword heuristics for triage. A flag is a reason to look, absence of flags is not a pass.',
      experts: p.experts.map((x) => ({ expertId: x.expertId, ...heuristicsFor(detail, x, caseRecord) })) };
  }
  report.automated = { modelJudgment: 'NOT_RUN', reason: 'Offline evaluator: no model or network calls are made.' };
  report.human = humanLayer(ratings, caseRecord.id, fp.inputSha256);
  report.remainingHumanReview = HUMAN_DIMENSIONS.filter((d) => report.human.reviews.every((r) => r.scores[d] === NOT_SCORED));
  return report;
}

/** Two runs of one case. Inputs (question/stage/material) must match unless the difference is documented; model,
 * prompt and knowledge hashes are the variables being compared and are reported, not judged. */
export function compareRuns(a, b, { documentedDifference } = {}) {
  const fa = a.fingerprint, fb = b.fingerprint, problems = [];
  if (a.caseId !== b.caseId) problems.push('different case IDs');
  for (const [k, label] of [['questionHash', 'question'], ['stage', 'stage'], ['materialHash', 'material']]) if (fa[k] !== fb[k]) problems.push(`different ${label}`);
  if (fa.inputSha256 === fb.inputSha256) problems.push('same input file twice');
  const inputsDiffer = problems.some((p) => p.startsWith('different ') && p !== 'different case IDs');
  const documented = typeof documentedDifference === 'string' && documentedDifference.trim().length >= 10;
  const blocking = problems.filter((p) => !(documented && inputsDiffer && p.startsWith('different ') && p !== 'different case IDs'));
  const delta = (k) => ({ a: fa[k], b: fb[k], same: canonical(fa[k]) === canonical(fb[k]) });
  const flagsOf = (r) => Object.fromEntries((r.heuristics.experts ?? []).map((e) => [e.expertId, e.flags]));
  return {
    evaluator: EVALUATOR_VERSION, caseId: a.caseId, status: blocking.length ? 'FAIL' : documented && inputsDiffer ? 'COMPARED_WITH_DOCUMENTED_INPUT_DIFFERENCE' : 'COMPARED',
    problems, ...(documented ? { documentedDifference: documentedDifference.trim() } : {}),
    inputs: { a: { name: a.input.name, sha256: fa.inputSha256, provenance: a.provenance.declared }, b: { name: b.input.name, sha256: fb.inputSha256, provenance: b.provenance.declared } },
    variables: { model: delta('model'), promptSetHash: delta('promptSetHash'), knowledgeRevisionHash: delta('knowledgeRevisionHash'), expertIds: delta('expertIds') },
    heuristicFlags: blocking.length ? 'NOT_COMPARED' : { a: flagsOf(a), b: flagsOf(b) },
    human: { a: a.human.status, b: b.human.status },
    note: 'No winner is declared. Heuristic flag differences are prompts for human review, not quality deltas.',
  };
}

// ---------- rendering ----------

const csvCell = (v) => { const s = typeof v === 'string' ? v : JSON.stringify(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
export function toCsv(report) {
  const rows = [['case_id', 'input_sha256', 'layer', 'subject', 'check', 'value']];
  const add = (layer, subject, check, value) => rows.push([report.caseId, report.input.sha256, layer, subject, check, value]);
  add('provenance', 'run', 'declared', report.provenance.declared);
  add('observed', 'run', 'schema', report.observed.schema);
  add('observed', 'run', 'case_binding', report.caseBinding.status);
  for (const c of report.observed.citations?.claims ?? []) add('observed', c.expertId, `citation:${c.id}`, c.status);
  for (const x of report.observed.experts ?? []) add('observed', x.expertId, 'self_reported_confidence_not_accuracy', x.selfReportedConfidence ?? 'absent');
  for (const e of report.heuristics.experts ?? []) {
    add('heuristic', e.expertId, 'relevance', e.relevance?.status ?? e.output);
    add('heuristic', e.expertId, 'flags', e.flags.join(' ') || 'none');
  }
  add('automated', 'run', 'model_judgment', report.automated.modelJudgment);
  if (!report.human.reviews.length) for (const d of HUMAN_DIMENSIONS) add('human', 'run', d, NOT_SCORED);
  for (const r of report.human.reviews) for (const d of HUMAN_DIMENSIONS) add('human', `${r.reviewer}@${r.ratedAt}`, d, r.scores[d]);
  return rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
}

export function toMarkdown(report) {
  const L = [`# Cloudbite quality evaluation — ${report.caseId}`, '',
    `- Evaluator: ${report.evaluator}, ${report.evaluatedAt}`, `- Input: \`${report.input.name}\` (${report.input.wrapper}, sha256 \`${report.input.sha256}\`)`,
    `- Provenance: **${report.provenance.declared}** (brief.mode=${report.provenance.observedMode}). ${report.provenance.note}`,
    ...report.provenance.conflicts.map((c) => `- **Provenance conflict:** ${c}`),
    `- Case: ${report.suite} / ${report.caseType} (${report.caseProvenance}); binding **${report.caseBinding.status}**`,
    `- Model: ${report.fingerprint.model ?? 'not recorded'}; prompt set ${report.fingerprint.promptSetHash ?? 'n/a'}; knowledge revisions ${report.fingerprint.knowledgeRevisionHash ?? 'n/a'}`, '',
    '## 1. Observed structure', '', `Schema: **${report.observed.schema}**`];
  for (const e of report.observed.schemaErrors) L.push(`- ${e}`);
  if (report.observed.note) L.push('', report.observed.note);
  if (report.observed.citations) {
    L.push('', report.observed.citations.meaning, '', '| Citation status | Claims |', '|---|---|');
    for (const [k, v] of Object.entries(report.observed.citations.byStatus)) L.push(`| ${k} | ${v} |`);
    L.push('', '| Role | Status | Self-reported confidence (not accuracy) |', '|---|---|---|');
    for (const x of report.observed.experts) L.push(`| ${x.expertId} | ${x.status} | ${x.selfReportedConfidence ?? '—'} |`);
    if (report.observed.crossReview) L.push('', `Cross-review: ${report.observed.crossReview.status}, verdicts ${JSON.stringify(report.observed.crossReview.verdicts)}. ${report.observed.crossReview.note}`);
  }
  L.push('', '## 2. Heuristic flags', '', report.heuristics.note ?? report.heuristics.status);
  for (const e of report.heuristics.experts ?? []) {
    L.push('', `### ${e.expertId}`, `- Relevance: **${e.relevance?.status ?? e.output}**` + (e.relevance ? ` (anchors ${e.relevance.anchorsHit}/${e.relevance.anchors}, options addressed ${e.relevance.optionsAddressed.length}/${e.relevance.options})` : ''),
      `- Flags: ${e.flags.length ? e.flags.map((f) => '`' + f + '`').join(', ') : 'none (not a pass)'}`);
    if (e.possibleFabricatedExecution?.length) L.push(`- Possible execution/sign-off claims: ${e.possibleFabricatedExecution.map((s) => JSON.stringify(s)).join(', ')}`);
    if (e.forbiddenPhrases?.length) L.push(`- Rubric phrases: ${e.forbiddenPhrases.map((s) => JSON.stringify(s)).join(', ')}`);
  }
  L.push('', '## 3. Automated / model-judgment annotations', '', `${report.automated.modelJudgment} — ${report.automated.reason}`,
    '', '## 4. Human rubric scores', '', `Status: **${report.human.status}** (${report.human.scale})`);
  if (!report.human.reviews.length) L.push('', `All dimensions ${NOT_SCORED}: ${HUMAN_DIMENSIONS.join(', ')}.`);
  for (const r of report.human.reviews) {
    L.push('', `Reviewer ${r.reviewer}, ${r.ratedAt}`, '', '| Dimension | Score |', '|---|---|');
    for (const d of HUMAN_DIMENSIONS) L.push(`| ${d} | ${r.scores[d]} |`);
    if (r.notes) L.push('', `Notes: ${r.notes}`);
  }
  for (const e of report.human.invalidRatingRows ?? []) L.push(`- Rejected rating row: ${e}`);
  L.push('', `Remaining independent human review: ${report.remainingHumanReview.length ? report.remainingHumanReview.join(', ') : 'none for this input'}.`,
    '', 'The original export is preserved unmodified as `original.json` next to this report.', '');
  return L.join('\n');
}

export function compareMarkdown(c) {
  return [`# Cloudbite run comparison — ${c.caseId}`, '', `Status: **${c.status}**`, ...c.problems.map((p) => `- ${p}`),
    ...(c.documentedDifference ? ['', `Documented input difference: ${c.documentedDifference}`] : []), '',
    `- A: \`${c.inputs.a.name}\` (${c.inputs.a.provenance}) ${c.inputs.a.sha256}`, `- B: \`${c.inputs.b.name}\` (${c.inputs.b.provenance}) ${c.inputs.b.sha256}`, '',
    '| Variable | A | B | Same |', '|---|---|---|---|',
    ...Object.entries(c.variables).map(([k, v]) => `| ${k} | ${JSON.stringify(v.a)} | ${JSON.stringify(v.b)} | ${v.same} |`), '',
    `Human status: A ${c.human.a}, B ${c.human.b}.`, '', c.note, ''].join('\n');
}

// ---------- file safety ----------

export function readBoundedFile(path, limit = INPUT_LIMITS.bytes, ext = /\.json$/i) {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) throw new Error('URLs are not fetched; save the export and pass a local file');
  if (!ext.test(path)) throw new Error(`unexpected file type: ${path}`);
  const st = lstatSync(path);
  if (st.isSymbolicLink() || !st.isFile()) throw new Error(`not a regular file: ${path}`);
  if (st.size > limit) throw new Error(`file exceeds ${limit} bytes: ${path}`);
  return readFileSync(path);
}

/** Output must stay in a git-ignored folder of this repository, or outside it only when explicitly allowed. */
export function resolveOutput(out, { allowOutsideRepo = false } = {}) {
  const dir = resolve(out ?? DEFAULT_OUT), rel = relative(ROOT, dir);
  const inside = rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  if (!inside) {
    if (!allowOutsideRepo) throw new Error('output outside the repository needs --allow-outside-repo');
    return dir;
  }
  let ignored = false;
  try { execFileSync('git', ['check-ignore', '-q', join(dir, 'probe.json')], { cwd: ROOT, stdio: 'ignore' }); ignored = true; } catch { ignored = false; }
  if (!ignored) throw new Error(`refusing to write evaluation output to a tracked or unignored path: ${rel || '.'}`);
  return dir;
}

function writeNew(path, data, force) {
  if (existsSync(path) && !force) throw new Error(`refusing to overwrite ${path}; pass --force`);
  writeFileSync(path, data, { flag: force ? 'w' : 'wx' });
}

// ---------- CLI ----------

function parseArgs(argv) {
  const o = { inputs: [], cases: [], flags: new Set() };
  for (const a of argv) if (FORBIDDEN_ARG.test(a)) throw new Error(`refusing argument ${a.split('=')[0]}: credentials are never accepted and --live model calls are not implemented`);
  for (const a of argv) if (scanSensitive(a).some((h) => h.class === 'credential')) throw new Error('refusing: an argument looks like a credential');
  o.command = argv[0];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i], v = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i]; };
    if (a === '--input') o.inputs.push(v()); else if (a === '--case') o.cases.push(v());
    else if (a === '--provenance') o.provenance = v(); else if (a === '--ratings') o.ratings = v();
    else if (a === '--out') o.out = v(); else if (a === '--cases-file') o.casesFile = v();
    else if (a === '--documented-difference') o.documentedDifference = v();
    else if (['--force', '--allow-outside-repo', '--allow-private-local'].includes(a)) o.flags.add(a);
    else throw new Error(`unknown argument ${a}`);
  }
  if (o.provenance !== undefined && !PROVENANCES.includes(o.provenance)) throw new Error(`--provenance must be one of ${PROVENANCES.join(', ')}`);
  if (!o.inputs.length || o.inputs.length > INPUT_LIMITS.inputs) throw new Error(`pass 1-${INPUT_LIMITS.inputs} --input files`);
  if (o.cases.length !== 1 && o.cases.length !== o.inputs.length) throw new Error('pass one --case for all inputs or one per input');
  return o;
}

export function runCli(argv, { log = console.log } = {}) {
  const o = parseArgs(argv);
  if (o.command !== 'evaluate' && o.command !== 'compare') throw new Error('command must be evaluate or compare');
  if (o.command === 'compare' && o.inputs.length !== 2) throw new Error('compare needs exactly two --input files');
  const cases = loadCases(o.casesFile ? resolve(o.casesFile) : DEFAULT_FIXTURE);
  const ratings = o.ratings ? parseRatings(readBoundedFile(o.ratings, INPUT_LIMITS.ratingsBytes, /\.jsonl$/i).toString('utf8')) : undefined;
  const outDir = resolveOutput(o.out, { allowOutsideRepo: o.flags.has('--allow-outside-repo') });
  const force = o.flags.has('--force'), reports = [], written = [];
  o.inputs.forEach((input, i) => {
    const caseId = o.cases[o.cases.length === 1 ? 0 : i], c = cases.get(caseId);
    if (!c) throw new Error(`unknown case ${caseId}`);
    const bytes = readBoundedFile(input);
    const sensitive = scanSensitive(bytes.toString('utf8'));
    if (sensitive.some((h) => h.class === 'credential')) throw new Error(`refusing ${input}: credential-like content (${sensitive.map((h) => h.kind).join(', ')}); remove it from the export first`);
    if (sensitive.length && !o.flags.has('--allow-private-local')) throw new Error(`refusing ${input}: possible personal data (${sensitive.map((h) => h.kind).join(', ')}); pass --allow-private-local to keep results in the ignored local folder`);
    const report = evaluateCase({ bytes, inputName: input.split(/[\\/]/).pop(), caseRecord: c, provenance: o.provenance, ratings });
    if (sensitive.length) report.privateDataSuspected = sensitive.map((h) => h.kind);
    const dir = join(outDir, `${caseId}__${report.input.sha256.slice(0, 12)}`);
    mkdirSync(dir, { recursive: true });
    writeNew(join(dir, 'original.json'), bytes, force);
    writeNew(join(dir, 'report.json'), JSON.stringify(report, null, 2) + '\n', force);
    writeNew(join(dir, 'report.md'), toMarkdown(report), force);
    writeNew(join(dir, 'scores.csv'), toCsv(report), force);
    reports.push(report); written.push(dir);
  });
  let comparison;
  if (o.command === 'compare') {
    comparison = compareRuns(reports[0], reports[1], { documentedDifference: o.documentedDifference });
    const name = `compare__${reports[0].input.sha256.slice(0, 12)}__${reports[1].input.sha256.slice(0, 12)}`;
    writeNew(join(outDir, name + '.json'), JSON.stringify(comparison, null, 2) + '\n', force);
    writeNew(join(outDir, name + '.md'), compareMarkdown(comparison), force);
    written.push(join(outDir, name + '.json'));
  }
  for (const r of reports) log(`${r.caseId}: schema ${r.observed.schema}, binding ${r.caseBinding.status}, provenance ${r.provenance.declared}, human ${r.human.status}`);
  if (comparison) log(`compare: ${comparison.status}${comparison.problems.length ? ' — ' + comparison.problems.join('; ') : ''}`);
  for (const w of written) log(`wrote ${relative(process.cwd(), w) || w}`);
  return { reports, comparison, written, exitCode: comparison?.status === 'FAIL' || reports.some((r) => r.observed.schema !== 'VALID' || r.caseBinding.status !== 'MATCH') ? 3 : 0 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { process.exitCode = runCli(process.argv.slice(2)).exitCode; }
  catch (err) { console.error('evaluate-cloudbite-quality: ' + err.message); process.exitCode = 2; }
}
