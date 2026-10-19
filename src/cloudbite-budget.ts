// Cloudbite project budget: a preflight envelope for one project and a versioned, serializable call ledger.
// Pure leaf: no storage, network or clock. Every Nosana model call of a project (expert turns, cross-review reviewers,
// the decision memo) is reserved here BEFORE it is sent, and a reserved call stays consumed whatever happens upstream
// (failure, timeout, lost response): there is no refund, release or reset. Atomicity is the caller's: the Durable
// Object re-reads BudgetUsage, calls reserveBudget and writes the result inside ONE storage transaction, then calls
// upstream only after that write. Jev routing (typesafe) runs its own typed calls and is never counted here.
// A budget is an upper bound only: it never raises visitor, operator or per-role quotas, and nothing here prices calls.
import type { ExpertAssignment, ExpertDefinition, ProjectBrief, ProjectBudget } from './cloudbite-contract';
import { CB_INFERENCE_MAX_CALLS } from './cloudbite-config';
import { CB_CROSS_REVIEW_MAX_REVIEWERS } from './cloudbite-cross-review';
import { PROJECT_MAX_EXPERTS } from './cloudbite-catalogue-limits';
import { BUDGET_FIELDS, BUDGET_LIMITS } from './cloudbite-workflow';

export const CB_BUDGET_VERSION = 'cloudbite-budget/v1';
/** Per-role turn cap; a stated budget can lower the project total but never raise this. */
export const CB_BUDGET_PER_EXPERT = CB_INFERENCE_MAX_CALLS;
export const CB_BUDGET_DEFAULT_REVIEW = CB_CROSS_REVIEW_MAX_REVIEWERS;
export const CB_BUDGET_DEFAULT_MEMO = BUDGET_LIMITS.maxMemoCalls[1];
/** Jev routing calls per plan (assessment + team review). Typed typesafe calls, not Nosana; never in maxModelCalls. */
export const CB_BUDGET_ROUTING_CALLS = 2;
/** Serialized BudgetUsage bound (100 keys of 64 characters at the cap is about 9 KiB). */
export const CB_BUDGET_USAGE_MAX_BYTES = 16 * 1024;
export const CB_BUDGET_KEY = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export type BudgetPhase = 'expert' | 'review' | 'memo';
export type BudgetPlanDenial = 'invalid-budget' | 'no-experts' | 'duplicate-expert' | 'unsupported-expert' | 'too-many-experts'
  | 'assignment-mismatch' | 'budget-too-small';
export type BudgetDenial = 'invalid-usage' | 'unknown-expert' | 'out-of-order' | 'per-expert-cap' | 'expert-phase-cap'
  | 'review-phase-cap' | 'memo-phase-cap' | 'phase-disabled' | 'total-cap';

/** Effective caps for one project. expertPool = maxModelCalls - maxReviewCalls - maxMemoCalls (review/memo are earmarked). */
export interface BudgetCaps {
  maxExperts: number; maxModelCalls: number; maxReviewCalls: number; maxMemoCalls: number;
  perExpertCalls: number; expertPool: number;
}
export interface BudgetPlanOk {
  ok: true; version: typeof CB_BUDGET_VERSION; source: 'stated' | 'default'; selectedCount: number; expertIds: string[]; caps: BudgetCaps;
  /** One Daytona sandbox per selected expert; review and memo run server-side without a sandbox. */
  maxSandboxes: number;
  /** Upper bound of Nosana calls this project can make (all phases), never more than caps.maxModelCalls. */
  maxNosanaCalls: number;
  phases: Record<BudgetPhase, { max: number }>;
  routing: { provider: 'typesafe'; typedCalls: typeof CB_BUDGET_ROUTING_CALLS; countedInModelCalls: false };
  cost: { estimate: null; reason: string };
  notes: string[];
}
export interface BudgetPlanDenied { ok: false; reason: BudgetPlanDenial; message: string }
export type BudgetPlan = BudgetPlanOk | BudgetPlanDenied;

export interface BudgetPlanInput {
  brief: Pick<ProjectBrief, 'expertIds' | 'budget'>;
  /** Runnable experts of this deployment; planned-only pool entries are not runnable. */
  catalogue: readonly Pick<ExpertDefinition, 'id'>[];
  assignments?: readonly Pick<ExpertAssignment, 'expertId'>[];
  /** Effective team cap already applied by the API (visitor/operator/routing); the plan takes the minimum. */
  maxExperts?: number;
}

/** Persisted by the project DO (one value, written only inside a storage transaction). Counts only ever grow. */
export interface BudgetUsage {
  version: typeof CB_BUDGET_VERSION;
  caps: BudgetCaps;
  /** Reserved calls per expert key (expert id or run id, fixed at creation). */
  experts: Record<string, number>;
  /** Reviewer keys whose one call is reserved, in reservation order. */
  reviewers: string[];
  memo: number;
  total: number;
  /** Increments on every effective reservation; lets a caller detect a stale copy. */
  rev: number;
  /** Set when reconstructed from a pre-budget project; counts are conservative upper estimates. */
  migrated?: true;
}
export type BudgetRequest =
  | { phase: 'expert'; key: string; seq: number }
  | { phase: 'review'; key: string }
  | { phase: 'memo'; seq: number };
export type BudgetReservation =
  | { ok: true; usage: BudgetUsage; duplicate: boolean }
  | { ok: false; reason: BudgetDenial; message: string; usage: BudgetUsage };
export interface BudgetPhaseMetric { used: number; max: number; available: number; exhausted: boolean }
export interface BudgetMetrics {
  version: typeof CB_BUDGET_VERSION; migrated: boolean;
  total: BudgetPhaseMetric; expert: BudgetPhaseMetric; review: BudgetPhaseMetric; memo: BudgetPhaseMetric;
  perExpertCalls: number;
  /** No further call of any phase can be reserved. */
  exhausted: boolean;
  /** No selected expert can reserve another turn (pool, total or every role at its cap). */
  expertsExhausted: boolean;
}
export interface BudgetPublic extends BudgetMetrics { caps: BudgetCaps; perExpert: Record<string, number> }

const DENIAL_TEXT: Record<BudgetPlanDenial | BudgetDenial, string> = {
  'invalid-budget': 'the stated budget is not a valid ProjectBudget',
  'no-experts': 'select at least one expert',
  'duplicate-expert': 'each expert may be selected once',
  'unsupported-expert': 'a selected expert is not runnable in this deployment',
  'too-many-experts': 'more experts are selected than the effective expert cap allows',
  'assignment-mismatch': 'an assignment names an expert that is not selected',
  'budget-too-small': 'maxModelCalls must leave at least one call per selected expert after review and memo calls',
  'invalid-usage': 'the stored project budget is missing, corrupt or of an unsupported version',
  'unknown-expert': 'this expert is not part of the project budget',
  'out-of-order': 'a budget reservation skipped a call number',
  'per-expert-cap': `this expert has used its ${CB_BUDGET_PER_EXPERT} model calls`,
  'expert-phase-cap': 'the project\'s expert call pool is used up',
  'review-phase-cap': 'the project\'s cross-review calls are used up',
  'memo-phase-cap': 'the project\'s memo call is used up',
  'phase-disabled': 'this phase is disabled by the project budget',
  'total-cap': 'the project\'s total model call budget is used up',
};
/** Stable user-facing text for a denial (no internal state). */
export const budgetDenialMessage = (reason: BudgetPlanDenial | BudgetDenial) => DENIAL_TEXT[reason];

const denyPlan = (reason: BudgetPlanDenial): BudgetPlanDenied => ({ ok: false, reason, message: DENIAL_TEXT[reason] });
const isInt = (v: unknown, min: number, max: number): v is number => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function validBudget(b: unknown): b is ProjectBudget {
  return isRecord(b) && Object.keys(b).length === BUDGET_FIELDS.length
    && BUDGET_FIELDS.every((f) => isInt(b[f], BUDGET_LIMITS[f][0], BUDGET_LIMITS[f][1]));
}

/** Caps for a selected team: the stated budget, else selectedCount*8 + 3 review + 1 memo. Undefined when invalid. */
export function budgetCapsFor(budget: ProjectBudget | undefined, selectedCount: number, maxExperts = PROJECT_MAX_EXPERTS): BudgetCaps | undefined {
  if (budget !== undefined && !validBudget(budget)) return undefined;
  const teamCap = Math.max(0, Math.min(PROJECT_MAX_EXPERTS, Math.floor(maxExperts), budget?.maxExperts ?? PROJECT_MAX_EXPERTS));
  const review = budget?.maxReviewCalls ?? CB_BUDGET_DEFAULT_REVIEW, memo = budget?.maxMemoCalls ?? CB_BUDGET_DEFAULT_MEMO;
  const total = budget?.maxModelCalls ?? selectedCount * CB_BUDGET_PER_EXPERT + review + memo;
  return { maxExperts: teamCap, maxModelCalls: total, maxReviewCalls: review, maxMemoCalls: memo,
    perExpertCalls: CB_BUDGET_PER_EXPERT, expertPool: Math.max(0, total - review - memo) };
}

/**
 * Preflight envelope, before any sandbox or model call. Fails (never trims) when the selection is empty, duplicated,
 * not runnable, larger than the effective expert cap, inconsistent with its assignments, or when the stated total
 * cannot afford one call per selected expert after the earmarked review and memo calls.
 */
export function planProjectBudget(input: BudgetPlanInput): BudgetPlan {
  const ids = input.brief.expertIds;
  if (input.brief.budget !== undefined && !validBudget(input.brief.budget)) return denyPlan('invalid-budget');
  if (!Array.isArray(ids) || ids.length === 0) return denyPlan('no-experts');
  if (new Set(ids).size !== ids.length) return denyPlan('duplicate-expert');
  const runnable = new Set(input.catalogue.map((e) => e.id));
  if (ids.some((id) => typeof id !== 'string' || !runnable.has(id) || !CB_BUDGET_KEY.test(id))) return denyPlan('unsupported-expert');
  if (input.assignments?.some((a) => !ids.includes(a.expertId))) return denyPlan('assignment-mismatch');
  const caps = budgetCapsFor(input.brief.budget, ids.length, input.maxExperts ?? PROJECT_MAX_EXPERTS)!;
  if (ids.length > caps.maxExperts) return denyPlan('too-many-experts');
  if (caps.expertPool < ids.length) return denyPlan('budget-too-small');
  const expertMax = Math.min(caps.expertPool, ids.length * CB_BUDGET_PER_EXPERT);
  // Cross-review needs two completed opinions and uses at most one reviewer per completed expert.
  const reviewMax = ids.length >= 2 ? Math.min(caps.maxReviewCalls, ids.length) : 0;
  const memoMax = caps.maxMemoCalls;
  const notes = [
    `${ids.length} expert sandbox(es) at most; cross-review and memo run server-side without sandboxes.`,
    `Experts share a pool of ${caps.expertPool} model call(s); each role is capped at ${CB_BUDGET_PER_EXPERT} turns, but neither the pool nor the cap guarantees any role ${CB_BUDGET_PER_EXPERT} turns.`,
    `${caps.maxReviewCalls} cross-review and ${caps.maxMemoCalls} memo call(s) are earmarked inside the ${caps.maxModelCalls}-call total.`,
    'A reserved call counts even if the provider fails or the response is lost; exhausted roles stop and are reported, not retried.',
    `Jev routing uses ${CB_BUDGET_ROUTING_CALLS} separate typed calls that are not part of this model call budget.`,
  ];
  if (caps.maxReviewCalls === 0) notes.push('Cross-review is disabled by this budget.');
  if (caps.maxMemoCalls === 0) notes.push('The decision memo is disabled by this budget.');
  if (caps.expertPool < ids.length * CB_BUDGET_PER_EXPERT) notes.push('The expert pool is smaller than one full turn cap per role; some roles may run out of calls first.');
  return {
    ok: true, version: CB_BUDGET_VERSION, source: input.brief.budget ? 'stated' : 'default', selectedCount: ids.length, expertIds: [...ids], caps,
    maxSandboxes: ids.length, maxNosanaCalls: Math.min(caps.maxModelCalls, expertMax + reviewMax + memoMax),
    phases: { expert: { max: expertMax }, review: { max: reviewMax }, memo: { max: memoMax } },
    routing: { provider: 'typesafe', typedCalls: CB_BUDGET_ROUTING_CALLS, countedInModelCalls: false },
    cost: { estimate: null, reason: 'no provider receipt or pricing is known, so no dollar or token estimate is made' },
    notes,
  };
}

/** A fresh ledger for a planned project. keys default to the selected expert ids (pass run ids to key by run). */
export function createBudgetUsage(plan: BudgetPlanOk, keys?: readonly string[]): BudgetUsage {
  const list = keys ?? plan.expertIds;
  if (keys && (keys.length !== plan.selectedCount || new Set(keys).size !== keys.length || keys.some((k) => !CB_BUDGET_KEY.test(k))))
    throw new Error('budget keys must be distinct, valid and one per selected expert');
  return { version: CB_BUDGET_VERSION, caps: { ...plan.caps }, experts: Object.fromEntries(list.map((k) => [k, 0])), reviewers: [], memo: 0, total: 0, rev: 0 };
}

/** Validates a stored value; anything else (other version, corrupt, oversized) is undefined and must fail closed. */
export function parseBudgetUsage(raw: unknown): BudgetUsage | undefined {
  if (!isRecord(raw) || raw.version !== CB_BUDGET_VERSION) return undefined;
  let bytes: number;
  try { bytes = new TextEncoder().encode(JSON.stringify(raw)).length; } catch { return undefined; }
  if (bytes > CB_BUDGET_USAGE_MAX_BYTES) return undefined;
  const c = raw.caps;
  if (!isRecord(c) || !isInt(c.maxExperts, 0, PROJECT_MAX_EXPERTS) || !isInt(c.maxModelCalls, 1, BUDGET_LIMITS.maxModelCalls[1])
    || !isInt(c.maxReviewCalls, 0, BUDGET_LIMITS.maxReviewCalls[1]) || !isInt(c.maxMemoCalls, 0, BUDGET_LIMITS.maxMemoCalls[1])
    || c.perExpertCalls !== CB_BUDGET_PER_EXPERT || c.expertPool !== Math.max(0, c.maxModelCalls - c.maxReviewCalls - c.maxMemoCalls)) return undefined;
  if (!isRecord(raw.experts) || Object.keys(raw.experts).length > PROJECT_MAX_EXPERTS) return undefined;
  const experts: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw.experts)) { if (!CB_BUDGET_KEY.test(k) || !isInt(v, 0, CB_BUDGET_PER_EXPERT)) return undefined; experts[k] = v; }
  const r = raw.reviewers;
  if (!Array.isArray(r) || r.length > BUDGET_LIMITS.maxReviewCalls[1] || r.some((k) => typeof k !== 'string' || !CB_BUDGET_KEY.test(k)) || new Set(r).size !== r.length) return undefined;
  if (!isInt(raw.memo, 0, BUDGET_LIMITS.maxMemoCalls[1]) || !isInt(raw.rev, 0, Number.MAX_SAFE_INTEGER)) return undefined;
  const sum = Object.values(experts).reduce((a, b) => a + b, 0) + r.length + raw.memo;
  if (raw.total !== sum) return undefined;
  if (raw.migrated !== undefined && raw.migrated !== true) return undefined;
  return { version: CB_BUDGET_VERSION, caps: { maxExperts: c.maxExperts, maxModelCalls: c.maxModelCalls, maxReviewCalls: c.maxReviewCalls,
    maxMemoCalls: c.maxMemoCalls, perExpertCalls: c.perExpertCalls, expertPool: c.expertPool },
  experts, reviewers: [...r] as string[], memo: raw.memo, total: sum, rev: raw.rev, ...(raw.migrated ? { migrated: true as const } : {}) };
}

const reviewLimit = (u: BudgetUsage) => { const n = Object.keys(u.experts).length; return n >= 2 ? Math.min(u.caps.maxReviewCalls, n) : 0; };
const expertUsed = (u: BudgetUsage) => Object.values(u.experts).reduce((a, b) => a + b, 0);

function check(u: BudgetUsage, req: BudgetRequest): BudgetDenial | 'duplicate' | null {
  if (req.phase === 'expert') {
    if (!Object.prototype.hasOwnProperty.call(u.experts, req.key)) return 'unknown-expert';
    const n = u.experts[req.key];
    if (!Number.isInteger(req.seq) || req.seq < 1) return 'out-of-order';
    if (req.seq <= n) return 'duplicate';
    if (req.seq > n + 1) return 'out-of-order';
    if (n >= u.caps.perExpertCalls) return 'per-expert-cap';
    if (expertUsed(u) >= u.caps.expertPool) return 'expert-phase-cap';
  } else if (req.phase === 'review') {
    if (u.reviewers.includes(req.key)) return 'duplicate';
    if (!CB_BUDGET_KEY.test(req.key)) return 'unknown-expert';
    if (u.caps.maxReviewCalls === 0) return 'phase-disabled';
    // Same bound the plan discloses (phases.review.max): one reviewer per budget expert, none for a single expert.
    // Keys are not required to be expert keys (ledgers may be keyed by run id while reviews use expert ids).
    if (u.reviewers.length >= reviewLimit(u)) return 'review-phase-cap';
  } else {
    if (!Number.isInteger(req.seq) || req.seq < 1) return 'out-of-order';
    if (req.seq <= u.memo) return 'duplicate';
    if (req.seq > u.memo + 1) return 'out-of-order';
    if (u.caps.maxMemoCalls === 0) return 'phase-disabled';
    if (u.memo >= u.caps.maxMemoCalls) return 'memo-phase-cap';
  }
  if (u.total >= u.caps.maxModelCalls) return 'total-cap';
  return null;
}

function apply(u: BudgetUsage, req: BudgetRequest): BudgetUsage {
  const next: BudgetUsage = { ...u, caps: { ...u.caps }, experts: { ...u.experts }, reviewers: [...u.reviewers], total: u.total + 1, rev: u.rev + 1 };
  if (req.phase === 'expert') next.experts[req.key]++;
  else if (req.phase === 'review') next.reviewers.push(req.key);
  else next.memo++;
  return next;
}

/**
 * Reserves one model call. Never mutates `usage`. Expert and memo requests carry the call number they are about to
 * make (seq = calls already reserved + 1); a replayed callback with a seq that is already reserved, or a reviewer key
 * already reserved, returns duplicate: true with the SAME usage, so idempotent handling never double-reserves and the
 * caller must not send a second upstream call for it. Call inside the DO storage transaction that persists the result.
 */
export function reserveBudget(usage: BudgetUsage, req: BudgetRequest): BudgetReservation {
  const u = parseBudgetUsage(usage);
  if (!u) return { ok: false, reason: 'invalid-usage', message: DENIAL_TEXT['invalid-usage'], usage };
  const r = check(u, req);
  if (r === 'duplicate') return { ok: true, usage, duplicate: true };
  if (r) return { ok: false, reason: r, message: DENIAL_TEXT[r], usage };
  return { ok: true, usage: apply(u, req), duplicate: false };
}

/** All-or-nothing reservation of several calls (e.g. every reviewer of one cross-review claim). */
export function reserveBudgetBatch(usage: BudgetUsage, reqs: readonly BudgetRequest[]): BudgetReservation {
  let cur = usage, changed = false;
  for (const req of reqs) {
    const r = reserveBudget(cur, req);
    if (!r.ok) return { ...r, usage };
    if (!r.duplicate) changed = true;
    cur = r.usage;
  }
  return { ok: true, usage: cur, duplicate: !changed };
}

/** The prefix of reviewer keys the budget can still afford (already reserved keys are kept). */
export function affordableReviewers(usage: BudgetUsage, keys: readonly string[]): string[] {
  const out: string[] = [];
  let cur = usage;
  for (const key of keys) {
    const r = reserveBudget(cur, { phase: 'review', key });
    if (!r.ok) break;
    out.push(key); cur = r.usage;
  }
  return out;
}

/** Whether this expert can reserve its next turn; when not, the backend fails/finishes the run with the reason. */
export function expertCanContinue(usage: BudgetUsage, key: string): { ok: true } | { ok: false; reason: BudgetDenial; message: string } {
  const u = parseBudgetUsage(usage);
  if (!u) return { ok: false, reason: 'invalid-usage', message: DENIAL_TEXT['invalid-usage'] };
  const r = check(u, { phase: 'expert', key, seq: (u.experts[key] ?? 0) + 1 });
  return r && r !== 'duplicate' ? { ok: false, reason: r, message: DENIAL_TEXT[r] } : { ok: true };
}

const metric = (used: number, max: number, roomLeft: number): BudgetPhaseMetric => {
  const available = Math.max(0, Math.min(max - used, roomLeft));
  return { used, max, available, exhausted: available === 0 };
};

/** Usage metrics; available never goes negative, even for a migrated ledger over its caps. */
export function budgetMetrics(usage: BudgetUsage): BudgetMetrics {
  const c = usage.caps, left = Math.max(0, c.maxModelCalls - usage.total), used = expertUsed(usage);
  const roleRoom = Object.values(usage.experts).reduce((a, n) => a + Math.max(0, c.perExpertCalls - n), 0);
  const expert = metric(used, c.expertPool, Math.min(left, roleRoom));
  const experts = Object.keys(usage.experts).length;
  const reviewMax = experts >= 2 ? Math.min(c.maxReviewCalls, experts) : 0;
  const review = metric(usage.reviewers.length, reviewMax, left), memo = metric(usage.memo, c.maxMemoCalls, left);
  return {
    version: CB_BUDGET_VERSION, migrated: usage.migrated === true,
    total: metric(usage.total, c.maxModelCalls, left), expert, review, memo, perExpertCalls: c.perExpertCalls,
    exhausted: expert.exhausted && review.exhausted && memo.exhausted, expertsExhausted: expert.exhausted,
  };
}

/** Browser-safe projection: caps, counts and metrics only (no tokens, claims, capability or account data). */
export function publicBudget(usage: BudgetUsage): BudgetPublic {
  return { ...budgetMetrics(usage), caps: { ...usage.caps }, perExpert: { ...usage.experts } };
}

/** What a pre-budget project persisted: each expert's int.calls and, when present, the cross-review claim. */
export interface LegacyBudgetState {
  brief: Pick<ProjectBrief, 'expertIds' | 'budget'>;
  experts: ReadonlyArray<{ key: string; calls: unknown }>;
  /** The stored CrossReviewRecord, if any: its reviewers were reserved when claimed (never retried). */
  crossReview?: { reviewers?: unknown };
  /** Set when the project already sent its memo call (or may have). */
  memoClaimed?: boolean;
}

/**
 * Ledger for a project created before budgets: caps from its brief (or defaults) and conservative counts — an
 * unreadable expert count is taken as the full per-role cap, a cross-review claim without a readable reviewer list
 * as every review call. Nothing is reset to zero, and counts above the new caps simply leave nothing available.
 */
export function migrateBudgetUsage(legacy: LegacyBudgetState): BudgetUsage {
  const caps = budgetCapsFor(validBudget(legacy.brief.budget) ? legacy.brief.budget : undefined, legacy.experts.length)!;
  const experts: Record<string, number> = {};
  for (const e of legacy.experts.slice(0, PROJECT_MAX_EXPERTS)) {
    if (!CB_BUDGET_KEY.test(e.key) || experts[e.key] !== undefined) continue;
    experts[e.key] = isInt(e.calls, 0, Number.MAX_SAFE_INTEGER) ? Math.min(e.calls, CB_BUDGET_PER_EXPERT) : CB_BUDGET_PER_EXPERT;
  }
  let reviewers: string[] = [];
  if (legacy.crossReview) {
    const r = legacy.crossReview.reviewers;
    const listed = Array.isArray(r) ? [...new Set(r.filter((k): k is string => typeof k === 'string' && CB_BUDGET_KEY.test(k)))] : [];
    reviewers = (Array.isArray(r) && listed.length === r.length ? listed : [...listed, ...['legacy-review-1', 'legacy-review-2', 'legacy-review-3'].filter((k) => !listed.includes(k))])
      .slice(0, BUDGET_LIMITS.maxReviewCalls[1]);
  }
  const memo = legacy.memoClaimed ? 1 : 0;
  const total = Object.values(experts).reduce((a, b) => a + b, 0) + reviewers.length + memo;
  return { version: CB_BUDGET_VERSION, caps, experts, reviewers, memo, total, rev: 0, migrated: true };
}
