// Person-entered rubric review of one exact saved answer (history sidecar). A review is bound to the output hash the
// reader actually saw; the server records who (the project's own history actor) and when. Nothing here is model truth,
// accuracy or a pass: the 0-4 rubric is the offline evaluator's (tools/evaluate-cloudbite-quality.mjs HUMAN_DIMENSIONS),
// and an unset dimension stays NOT_SCORED. Reviews never change the stored answer; they live in `humanreview:<expertId>`.
import type { ExpertOpinion, ProjectBrief } from './cloudbite-contract';

export const HUMAN_REVIEW_VERSION = 'cloudbite-human-review/v1';
export const REGRESSION_EXPORT_VERSION = 'cloudbite-regression-candidate/v1';
/** Mirror of tools/evaluate-cloudbite-quality.mjs EVALUATOR_VERSION + HUMAN_DIMENSIONS; the test checks drift. */
export const HUMAN_RUBRIC = 'cloudbite-quality/v1';
export const HUMAN_DIMENSIONS = ['relevance', 'evidence_traceability', 'facts_vs_assumptions', 'alternatives_tradeoffs', 'conditional_next_step', 'no_fabricated_signoff'] as const;
export type HumanDimension = typeof HUMAN_DIMENSIONS[number];
export const HUMAN_REVIEW_ISSUES = ['factual-error', 'unsupported-claim', 'missing-source', 'misread-material', 'missing-alternative', 'unsafe-next-step',
  'fabricated-execution', 'too-generic', 'off-topic', 'other'] as const;
export type HumanReviewIssue = typeof HUMAN_REVIEW_ISSUES[number];
export const HUMAN_REVIEW_LIMITS = Object.freeze({ body: 16 * 1024, comment: 1000, issues: 6, issueComment: 300, requests: 8 });
const REQUEST_ID = /^[A-Za-z0-9_-]{8,64}$/, HEX64 = /^[0-9a-f]{64}$/;
export const HUMAN_REVIEW_EXPERT = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface HumanReviewIssueNote { category: HumanReviewIssue; comment: string }
/** What a reader may see: no actor, no request ids. */
export interface HumanReviewPublic {
  version: typeof HUMAN_REVIEW_VERSION; expertId: string; outputSha256: string; revision: number;
  scores: Record<HumanDimension, number | null>; issues: HumanReviewIssueNote[]; comment: string; regressionCandidate: boolean;
  recordedBy: 'project-user'; createdAt: number; updatedAt: number;
}
export interface HumanReviewStored extends Omit<HumanReviewPublic, 'recordedBy'> { actor: string; requests: Array<{ id: string; hash: string; revision: number }> }
export interface HumanReviewOutput { outputSha256: string; answerSha256: string; questionHash: string; materialHash: string; stage: string }
export interface HumanReviewDetail {
  version: typeof HUMAN_REVIEW_VERSION; rubric: typeof HUMAN_RUBRIC; dimensions: readonly HumanDimension[]; issues: readonly HumanReviewIssue[];
  /** Only finished live answers that can be rated; keyed by expertId. */
  outputs: Record<string, HumanReviewOutput>; reviews: Record<string, HumanReviewPublic>; canReview: boolean;
}
export interface HumanReviewInput {
  expertId: string; outputSha256: string; requestId: string; baseRevision: number;
  scores: Record<HumanDimension, number | null>; issues: HumanReviewIssueNote[]; comment: string; regressionCandidate: boolean;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
/** Same canonical form as tools/evaluate-cloudbite-quality.mjs `canonical` (sorted keys, undefined dropped). */
export const canonical = (v: unknown): string => Array.isArray(v) ? '[' + v.map(canonical).join(',') + ']'
  : isObj(v) ? '{' + Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}'
  : JSON.stringify(v);
async function sha256(s: string) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  return [...d].map(x => x.toString(16).padStart(2, '0')).join('');
}

/** questionHash/stage/materialHash exactly as the offline evaluator's caseFingerprint computes them. */
export async function inputFingerprint(b: ProjectBrief) {
  const question = { title: b.title, objective: b.objective, context: b.context, decision: b.decision ?? null };
  const material = (b.documents ?? []).map(d => ({ id: d.id, name: d.name, content: d.content }));
  return { questionHash: await sha256(canonical(question)), stage: b.stage && b.stage !== 'unspecified' ? b.stage : 'unspecified', materialHash: await sha256(canonical(material)) };
}
export async function answerSha256(expertId: string, opinion: ExpertOpinion, report: string | null) {
  return sha256(canonical({ expertId, opinion, report }));
}
export async function outputFingerprint(projectId: string, brief: ProjectBrief, expertId: string, opinion: ExpertOpinion, report: string | null): Promise<HumanReviewOutput> {
  const input = await inputFingerprint(brief), answer = await answerSha256(expertId, opinion, report);
  const outputSha256 = await sha256(canonical({ v: 'cloudbite-human-review-output/v1', projectId, expertId, ...input, answerSha256: answer }));
  return { outputSha256, answerSha256: answer, ...input };
}

/** Strict body check: every key known, every dimension present (integer 0-4 or null), and at least one human statement. */
export function parseHumanReview(raw: unknown): HumanReviewInput | { invalid: string } {
  if (!isObj(raw)) return { invalid: 'review must be a JSON object' };
  const keys = ['expertId', 'outputSha256', 'requestId', 'baseRevision', 'scores', 'issues', 'comment', 'regressionCandidate'];
  const extra = Object.keys(raw).find(k => !keys.includes(k));
  if (extra) return { invalid: `unknown field ${extra}` };
  if (typeof raw.expertId !== 'string' || !HUMAN_REVIEW_EXPERT.test(raw.expertId)) return { invalid: 'invalid expertId' };
  if (typeof raw.outputSha256 !== 'string' || !HEX64.test(raw.outputSha256)) return { invalid: 'outputSha256 must be the 64-hex output hash shown with the answer' };
  if (typeof raw.requestId !== 'string' || !REQUEST_ID.test(raw.requestId)) return { invalid: 'requestId must be 8-64 letters, digits, _ or -' };
  if (!Number.isSafeInteger(raw.baseRevision) || (raw.baseRevision as number) < 0) return { invalid: 'baseRevision must be a non-negative integer' };
  if (!isObj(raw.scores) || Object.keys(raw.scores).length !== HUMAN_DIMENSIONS.length) return { invalid: `scores must list exactly ${HUMAN_DIMENSIONS.join(', ')}` };
  const scores = {} as Record<HumanDimension, number | null>;
  for (const d of HUMAN_DIMENSIONS) {
    const v = (raw.scores as Record<string, unknown>)[d];
    if (v !== null && !(Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 4)) return { invalid: `${d} must be an integer 0-4 or null` };
    scores[d] = v as number | null;
  }
  if (!Array.isArray(raw.issues) || raw.issues.length > HUMAN_REVIEW_LIMITS.issues) return { invalid: `issues must be a list of at most ${HUMAN_REVIEW_LIMITS.issues}` };
  const issues: HumanReviewIssueNote[] = [];
  for (const x of raw.issues) {
    if (!isObj(x) || Object.keys(x).some(k => k !== 'category' && k !== 'comment') || !HUMAN_REVIEW_ISSUES.includes(x.category as HumanReviewIssue)
      || typeof x.comment !== 'string' || x.comment.length > HUMAN_REVIEW_LIMITS.issueComment) return { invalid: `each issue needs a known category and a comment up to ${HUMAN_REVIEW_LIMITS.issueComment} characters` };
    if (issues.some(i => i.category === x.category)) return { invalid: 'each issue category may appear once' };
    issues.push({ category: x.category as HumanReviewIssue, comment: x.comment });
  }
  if (typeof raw.comment !== 'string' || raw.comment.length > HUMAN_REVIEW_LIMITS.comment) return { invalid: `comment must be a string up to ${HUMAN_REVIEW_LIMITS.comment} characters` };
  if (typeof raw.regressionCandidate !== 'boolean') return { invalid: 'regressionCandidate must be true or false' };
  if (HUMAN_DIMENSIONS.every(d => scores[d] === null) && !issues.length && !raw.comment.trim()) return { invalid: 'a review needs at least one score, issue or comment' };
  return { expertId: raw.expertId, outputSha256: raw.outputSha256, requestId: raw.requestId, baseRevision: raw.baseRevision as number, scores, issues, comment: raw.comment, regressionCandidate: raw.regressionCandidate };
}
/** Hash of what a retry must repeat byte-for-byte in meaning (requestId and baseRevision excluded). */
export const reviewContentHash = (r: HumanReviewInput) => sha256(canonical({ expertId: r.expertId, outputSha256: r.outputSha256, scores: r.scores, issues: r.issues, comment: r.comment, regressionCandidate: r.regressionCandidate }));

export function parseStoredReview(v: unknown): HumanReviewStored | null {
  if (!isObj(v) || v.version !== HUMAN_REVIEW_VERSION || typeof v.expertId !== 'string' || typeof v.actor !== 'string' || !Number.isSafeInteger(v.revision) || !Array.isArray(v.requests)) return null;
  return v as unknown as HumanReviewStored;
}
export const publicReview = ({ actor: _a, requests: _r, ...r }: HumanReviewStored): HumanReviewPublic => ({ ...r, recordedBy: 'project-user' });

/** Next stored record: requests keep the last few ids so a lost-response retry is answered without a second write. */
export function nextReview(prev: HumanReviewStored | null, r: HumanReviewInput, actor: string, contentHash: string, now: number): HumanReviewStored {
  const revision = (prev?.revision ?? 0) + 1;
  return { version: HUMAN_REVIEW_VERSION, expertId: r.expertId, outputSha256: r.outputSha256, revision, scores: r.scores, issues: r.issues, comment: r.comment,
    regressionCandidate: r.regressionCandidate, createdAt: prev?.createdAt ?? now, updatedAt: now, actor,
    requests: [...(prev?.requests ?? []), { id: r.requestId, hash: contentHash, revision }].slice(-HUMAN_REVIEW_LIMITS.requests) };
}

/** Non-identifying, stable per history actor: lets the offline compare pair one person's before/after scores. */
export async function reviewerLabel(actor: string) { return 'reviewer-' + (await sha256('cloudbite-human-reviewer-v1|' + actor)).slice(0, 16); }

export interface RegressionExportSource {
  projectId: string; createdAt: number; projectStatus: string; mode: 'live' | 'demo'; model: string; brief: ProjectBrief;
  expertId: string; expertName: string; role: { id: string; basis: string; revision: string; promptHash: string } | null;
  opinion: ExpertOpinion; report: string | null; output: HumanReviewOutput; review: HumanReviewStored; now: number;
}
/** Bounded, versioned regression candidate: exact input, the one rated answer, its hashes and the person's annotation. */
export async function regressionExport(s: RegressionExportSource) {
  const b = s.brief;
  return {
    version: REGRESSION_EXPORT_VERSION, exportedAt: new Date(s.now).toISOString(),
    meaning: 'One person\'s 0-4 rubric annotation of one exact saved answer. It is not model truth, not accuracy and not a pass/fail; unset dimensions are NOT_SCORED.',
    source: { projectId: s.projectId, createdAt: s.createdAt, projectStatus: s.projectStatus, mode: s.mode, model: s.model, expertId: s.expertId, expertName: s.expertName, role: s.role },
    input: { brief: { title: b.title, objective: b.objective, context: b.context, mode: b.mode, expertIds: [s.expertId], requestId: b.requestId,
      ...(b.stage ? { stage: b.stage } : {}), ...(b.decision ? { decision: b.decision } : {}), ...(b.documents ? { documents: b.documents.map(d => ({ id: d.id, name: d.name, content: d.content, ...(d.origin ? { origin: d.origin } : {}) })) } : {}),
      ...(b.responseLanguage ? { responseLanguage: b.responseLanguage } : {}) },
      questionHash: s.output.questionHash, stage: s.output.stage, materialHash: s.output.materialHash },
    answer: { expertId: s.expertId, status: 'completed', opinion: s.opinion, report: s.report, answerSha256: s.output.answerSha256 },
    outputSha256: s.output.outputSha256,
    human: { rubric: HUMAN_RUBRIC, dimensions: HUMAN_DIMENSIONS, scale: '0-4 per dimension; null = NOT_SCORED', scores: s.review.scores, issues: s.review.issues,
      comment: s.review.comment, regressionCandidate: s.review.regressionCandidate, reviewer: await reviewerLabel(s.review.actor),
      recordedAt: new Date(s.review.updatedAt).toISOString(), revision: s.review.revision, recordedBy: 'server-recorded project user',
      blind: false, blindNote: 'Not blinded: the reviewer saw the role, model name and self-reported confidence in the history view.' },
    excluded: ['reviewer cookie or history identity', 'other roles\' answers', 'cross-review, memo and adoptions', 'sandbox ids and activity logs', 'helpful/unhelpful feedback'],
  };
}
export type RegressionCandidate = Awaited<ReturnType<typeof regressionExport>>;
