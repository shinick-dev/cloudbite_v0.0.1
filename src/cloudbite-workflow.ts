// Cloudbite optional workflow fields (stage, response language, budget, revision) and decision option ids.
// Pure leaf: type imports only, no storage, network or clock. Every value here is a user claim or code-assembled data,
// never authority: a stage or revision cannot grant capabilities, and a budget is only an upper bound that the budget
// module still clamps. Absent fields stay absent so payloads and hashes from before these fields remain unchanged.
import type { DecisionFrame, ExpertAssignment, ProjectBrief, ProjectBudget, ProjectRevision, ProjectStage, ResponseLanguage } from './cloudbite-contract';

export const PROJECT_STAGES = ['discovery', 'design', 'validation', 'launch', 'operation', 'unspecified'] as const satisfies readonly ProjectStage[];
export const RESPONSE_LANGUAGES = ['ko', 'en'] as const satisfies readonly ResponseLanguage[];
export const WORKFLOW_FIELDS = ['stage', 'responseLanguage', 'budget', 'revision'] as const;
export const BUDGET_FIELDS = ['maxExperts', 'maxModelCalls', 'maxReviewCalls', 'maxMemoCalls'] as const;
export const BUDGET_LIMITS = Object.freeze({
  maxExperts: [1, 100], maxModelCalls: [1, 804], maxReviewCalls: [0, 3], maxMemoCalls: [0, 1],
} as const satisfies Record<(typeof BUDGET_FIELDS)[number], readonly [number, number]>);
export const REVISION_PARENT_ID = /^cb[0-9a-f]{32}$/;
export const REVISION_LIMITS = Object.freeze({ changeSummary: 2000 });
/** Decision option ids are positional per snapshot (DECISION_LIMITS.items = 8), never user-chosen names or paths. */
export const DECISION_OPTION_MAX = 8;
export const DECISION_OPTION_ID = /^option-[1-8]$/;
export const ASSIGNMENT_LIMITS = Object.freeze({ question: 800, items: 8, item: 400, perspectives: 14 });
export const ASSIGNMENT_SOURCES = ['jev-coverage', 'manual-scope'] as const satisfies readonly ExpertAssignment['source'][];

type Invalid = { invalid: string };
export type WorkflowData = { stage?: Exclude<ProjectStage, 'unspecified'>; responseLanguage?: ResponseLanguage; budget?: ProjectBudget; revision?: ProjectRevision };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const own = (o: Record<string, unknown>, k: string) => Object.prototype.hasOwnProperty.call(o, k);
// C0/C1 controls (except tab, LF, CR), bidi overrides/isolates and the binary-decoding replacement character.
const CONTROL_ANY = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\ufffd]/;
const CONTROL_LINE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff\ufffd]/;
const HANGUL = /[\u1100-\u11ff\u3130-\u318f\ua960-\ua97f\uac00-\ud7af\ud7b0-\ud7ff]/;
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

function validateBudget(raw: unknown): ProjectBudget | Invalid {
  if (!isRecord(raw)) return { invalid: 'budget must be an object' };
  if (Object.keys(raw).some((k) => !(BUDGET_FIELDS as readonly string[]).includes(k))) return { invalid: 'unknown budget field' };
  const out = {} as ProjectBudget;
  for (const field of BUDGET_FIELDS) {
    const [min, max] = BUDGET_LIMITS[field], v = raw[field];
    if (!Number.isInteger(v) || (v as number) < min || (v as number) > max) return { invalid: `budget.${field} must be an integer ${min}-${max}` };
    out[field] = v as number;
  }
  return out;
}

function validateRevision(raw: unknown): ProjectRevision | Invalid {
  if (!isRecord(raw)) return { invalid: 'revision must be an object' };
  if (Object.keys(raw).some((k) => k !== 'parentId' && k !== 'changeSummary')) return { invalid: 'unknown revision field' };
  if (typeof raw.parentId !== 'string' || !REVISION_PARENT_ID.test(raw.parentId)) return { invalid: 'revision.parentId must be a Cloudbite project id' };
  const summary = typeof raw.changeSummary === 'string' ? raw.changeSummary.replace(/\r\n?/g, '\n').trim() : '';
  if (typeof raw.changeSummary !== 'string' || CONTROL_ANY.test(raw.changeSummary) || !summary || summary.length > REVISION_LIMITS.changeSummary)
    return { invalid: `revision.changeSummary must be plain text of 1-${REVISION_LIMITS.changeSummary} characters` };
  return { parentId: raw.parentId, changeSummary: summary };
}

/**
 * Optional workflow fields of a raw brief or routing query. Absent fields stay absent and an explicit 'unspecified'
 * stage is normalized to absent, so equivalent payloads validate and hash identically. Unknown values are refused.
 */
export function validateWorkflowData(raw: Record<string, unknown>): WorkflowData | Invalid {
  const out: WorkflowData = {};
  if (own(raw, 'stage')) {
    if (typeof raw.stage !== 'string' || !(PROJECT_STAGES as readonly string[]).includes(raw.stage)) return { invalid: `stage must be one of ${PROJECT_STAGES.join(', ')}` };
    if (raw.stage !== 'unspecified') out.stage = raw.stage as WorkflowData['stage'];
  }
  if (own(raw, 'responseLanguage')) {
    if (raw.responseLanguage !== 'ko' && raw.responseLanguage !== 'en') return { invalid: 'responseLanguage must be ko or en' };
    out.responseLanguage = raw.responseLanguage;
  }
  if (own(raw, 'budget')) {
    const budget = validateBudget(raw.budget);
    if ('invalid' in budget) return budget;
    out.budget = budget;
  }
  if (own(raw, 'revision')) {
    const revision = validateRevision(raw.revision);
    if ('invalid' in revision) return revision;
    out.revision = revision;
  }
  return out;
}

/** The validated workflow fields only, in a fixed key order, for route/create hashes and state parity. */
export function workflowHashFields(data: Pick<ProjectBrief, (typeof WORKFLOW_FIELDS)[number]>): WorkflowData {
  const out: WorkflowData = {};
  if (data.stage && data.stage !== 'unspecified') out.stage = data.stage;
  if (data.responseLanguage) out.responseLanguage = data.responseLanguage;
  if (data.budget) out.budget = Object.fromEntries(BUDGET_FIELDS.map((f) => [f, data.budget![f]])) as unknown as ProjectBudget;
  if (data.revision) out.revision = { parentId: data.revision.parentId, changeSummary: data.revision.changeSummary };
  return out;
}

/** Stated stage, else 'unspecified'. A known stage is never inferred from free text. */
export function projectStage(brief: Pick<ProjectBrief, 'stage'>): ProjectStage {
  return brief.stage && (PROJECT_STAGES as readonly string[]).includes(brief.stage) ? brief.stage : 'unspecified';
}

/** Stated response language, else 'ko' when the objective contains Hangul, else 'en'. */
export function defaultResponseLanguage(brief: Pick<ProjectBrief, 'objective' | 'responseLanguage'>): ResponseLanguage {
  if (brief.responseLanguage === 'ko' || brief.responseLanguage === 'en') return brief.responseLanguage;
  return typeof brief.objective === 'string' && HANGUL.test(brief.objective) ? 'ko' : 'en';
}

/** option-1..N for the options of this decision snapshot, in their listed order. */
export function decisionOptionIds(decision: Pick<DecisionFrame, 'options'> | undefined): string[] {
  const n = Math.min(decision?.options?.length ?? 0, DECISION_OPTION_MAX);
  return Array.from({ length: n }, (_, i) => `option-${i + 1}`);
}

/** The option text an id refers to in this snapshot, or undefined for an id outside it. */
export function decisionOption(decision: Pick<DecisionFrame, 'options'> | undefined, id: unknown): string | undefined {
  if (typeof id !== 'string' || !DECISION_OPTION_ID.test(id)) return undefined;
  return decision?.options?.[Number(id.slice(7)) - 1];
}

function list(v: unknown, field: string, maxItems: number, maxItem: number, min = 0): string[] | Invalid {
  if (!Array.isArray(v) || v.length < min || v.length > maxItems) return { invalid: `assignment.${field} must list ${min}-${maxItems} items` };
  for (const item of v) if (typeof item !== 'string' || !item.trim() || item.length > maxItem || CONTROL_LINE.test(item)) return { invalid: `assignment.${field} items must be single-line text of 1-${maxItem} characters` };
  return [...v];
}

/**
 * Structural check of an ExpertAssignment. `expect` binds it to one workspace: the expert it is for, the option ids of
 * its stage, the option ids of the brief's decision snapshot and the known perspective ids. Returns a copy; never trusts extra properties.
 */
export function validateExpertAssignment(raw: unknown, expect: { expertId?: string; stage?: ProjectStage; optionIds?: readonly string[]; perspectiveIds?: readonly string[] } = {}): ExpertAssignment | Invalid {
  if (!isRecord(raw)) return { invalid: 'assignment must be an object' };
  const keys = ['expertId', 'stage', 'question', 'optionIds', 'deliverables', 'requiredEvidence', 'boundaries', 'perspectiveIds', 'source'];
  if (Object.keys(raw).some((k) => !keys.includes(k)) || keys.some((k) => !own(raw, k))) return { invalid: 'assignment fields are not exact' };
  if (typeof raw.expertId !== 'string' || !ID.test(raw.expertId)) return { invalid: 'assignment.expertId is invalid' };
  if (expect.expertId !== undefined && raw.expertId !== expect.expertId) return { invalid: 'assignment belongs to a different expert' };
  if (typeof raw.stage !== 'string' || !(PROJECT_STAGES as readonly string[]).includes(raw.stage)) return { invalid: 'assignment.stage is invalid' };
  if (expect.stage !== undefined && raw.stage !== expect.stage) return { invalid: 'assignment stage differs from the brief' };
  if (typeof raw.question !== 'string' || !raw.question.trim() || raw.question.length > ASSIGNMENT_LIMITS.question || CONTROL_ANY.test(raw.question)) return { invalid: `assignment.question must be 1-${ASSIGNMENT_LIMITS.question} characters` };
  if (raw.source !== 'jev-coverage' && raw.source !== 'manual-scope') return { invalid: 'assignment.source is invalid' };
  const optionIds = list(raw.optionIds, 'optionIds', DECISION_OPTION_MAX, 9);
  if ('invalid' in optionIds) return optionIds;
  if (optionIds.some((id) => !DECISION_OPTION_ID.test(id) || (expect.optionIds && !expect.optionIds.includes(id))) || new Set(optionIds).size !== optionIds.length) return { invalid: 'assignment.optionIds must be distinct option ids of this decision' };
  const perspectiveIds = list(raw.perspectiveIds, 'perspectiveIds', ASSIGNMENT_LIMITS.perspectives, 64);
  if ('invalid' in perspectiveIds) return perspectiveIds;
  if (perspectiveIds.some((id) => !ID.test(id) || (expect.perspectiveIds && !expect.perspectiveIds.includes(id))) || new Set(perspectiveIds).size !== perspectiveIds.length) return { invalid: 'assignment.perspectiveIds are invalid' };
  if (raw.source === 'manual-scope' && perspectiveIds.length) return { invalid: 'manual-scope assignments carry no Jev perspectives' };
  const out: Partial<ExpertAssignment> = { expertId: raw.expertId, stage: raw.stage as ProjectStage, question: raw.question, optionIds };
  for (const field of ['deliverables', 'requiredEvidence', 'boundaries'] as const) {
    const items = list(raw[field], field, ASSIGNMENT_LIMITS.items, ASSIGNMENT_LIMITS.item, 1);
    if ('invalid' in items) return items;
    out[field] = items;
  }
  return { ...out, perspectiveIds, source: raw.source } as ExpertAssignment;
}
