// Cloudbite project continuity (v7): a bounded, labeled handoff of the parent memo's coaching proposals into a
// follow-up round, plus an exact-text list of what changed since the parent. Pure leaf: NO imports, no storage,
// network or clock, so both the Worker (cloudbite-revision) and the browser type check (tsconfig.client.json) can use
// its types. The console is a single esbuild transform without bundling, so it mirrors the limits below and the test
// (test/cloudbite-v7-continuity.mjs) pins that mirror.
//
// Standing never changes here: every carried item is an earlier model PROPOSAL. It is not adopted, not executed and
// not verified, whatever later text says. The user's change summary is the user's statement, also unverified. Nothing
// here reads ancestry beyond the one authorized parent memo: the parent's own previousRound/continuity is never read.

export const PROJECT_CONTEXT_VERSION = 'cloudbite-project-context/v1' as const;
/** UTF-8 byte caps. Text is cut on code point boundaries; every cut or drop is listed in `omissions`. */
export const HANDOFF_LIMITS = Object.freeze({
  /** Matches the memo's coaching caps (CB_MEMO_COACHING_LIMITS.repairs/questions); more is refused as unreadable. */
  repairs: 3, questions: 3, expertIds: 8,
  /** A coaching claim is <= 200 UTF-16 units; 600 bytes keeps a full Korean claim whole. */
  claimBytes: 600,
  /** Whole handoff (JSON) budget; lowest-priority items are dropped first. */
  totalBytes: 12 * 1024,
  /** Ids listed per changed subject in the continuity comparison. */
  changeIds: 12,
});
const PRIORITY_ORDER = ['now', 'next', 'later'] as const;
const STANCES = ['proceed-with-scope', 'clarify-first', 'rework', 'pause'] as const;
const KINDS = ['unknown', 'adverse-evidence', 'tradeoff', 'constraint'] as const;
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export type HandoffPriority = (typeof PRIORITY_ORDER)[number];
export interface ContextOmission { path: string; omittedBytes?: number; omittedItems?: number }
/** Claim text plus the experts the memo attributed it to. Parent evidence refs point into parent data and are not carried. */
export interface HandoffClaim { text: string; expertIds: string[] }
export interface HandoffRepair {
  id: string; priority: HandoffPriority; kind: (typeof KINDS)[number];
  issue: HandoffClaim; change: HandoffClaim; check: HandoffClaim; decisionTrigger: HandoffClaim;
  /** Fixed: a carried repair is something proposed, never something done or checked. */
  status: 'proposed-not-executed'; verification: 'not-verified';
}
export interface HandoffQuestion { id: string; text: HandoffClaim; status: 'open-not-answered' }
export interface CoachingHandoff {
  version: typeof PROJECT_CONTEXT_VERSION; source: 'parent-memo-coaching'; standing: 'generated-proposal-not-adopted';
  stance: (typeof STANCES)[number];
  revisedProject: { objective: HandoffClaim; scope: HandoffClaim; nextMilestone: HandoffClaim };
  /** Sorted now → next → later (stable). */
  repairs: HandoffRepair[]; questions: HandoffQuestion[];
  omissions: ContextOmission[];
}
/** none: no memo, a memo that is not completed, or a legacy memo without coaching. unreadable: present but not this shape. */
export type HandoffState = 'present' | 'none' | 'unreadable';
export type ContinuitySubject = 'stage' | 'options' | 'constraints' | 'successCriteria' | 'knownFacts' | 'assumptions' | 'unknowns' | 'documents';
/** Exact-text / exact-hash change of one subject. Counts only; no semantic impact is inferred. */
export interface ContinuityChange { subject: ContinuitySubject; added: number; removed: number; changed: number; ids?: string[] }
export interface RoundContinuity {
  version: typeof PROJECT_CONTEXT_VERSION; label: 'previous-round-continuity'; trust: 'untrusted-data';
  parentCoaching: HandoffState;
  /** Present only when the authorized parent memo carried readable coaching. */
  priorProposals?: CoachingHandoff;
  changeSummaryStanding: 'user-statement-not-verified';
  changed: ContinuityChange[];
  /** Parent documents absent from this round: anything that relied on them needs re-evaluation. */
  missingEvidence: string[];
  reevaluate: boolean;
  /** Fixed constant text, data only (the trusted rules live in the work order). */
  instructions: string[];
  omissions: ContextOmission[];
}
/** Exact-text frame of one round, as cloudbite-revision already holds it. */
export interface ContinuityFrame {
  stage: string; options: readonly string[];
  lists: Partial<Record<'constraints' | 'successCriteria' | 'knownFacts' | 'assumptions' | 'unknowns', readonly string[]>>;
  documents: ReadonlyArray<{ id: string; sha256: string }>;
}

export const CONTINUITY_INSTRUCTIONS: readonly string[] = Object.freeze([
  'priorProposals are the parent memo model\'s proposals. None was adopted, executed or verified by being carried here.',
  'changeSummary is the user\'s own statement of what changed; treat it as a claim and look for support in the current brief and documents.',
  'Where a subject in changed or missingEvidence affects an earlier proposal or conclusion, re-evaluate it and state the new basis next to the old one.',
  'Open questions stay open unless the current brief or documents answer them.',
]);

const enc = new TextEncoder();
const bytes = (s: string) => enc.encode(s).byteLength;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const exactKeys = (v: Record<string, unknown>, keys: readonly string[]) => {
  const k = Object.keys(v);
  return k.length === keys.length && keys.every((x) => k.includes(x));
};

/** Longest code-point prefix within max UTF-8 bytes; a cut is recorded. */
export function capBytes(s: string, max: number, path: string, omissions: ContextOmission[]): string {
  const total = bytes(s);
  if (total <= max) return s;
  let used = 0, out = '';
  for (const ch of s) { const n = bytes(ch); if (used + n > max) break; used += n; out += ch; }
  omissions.push({ path, omittedBytes: total - used });
  return out;
}

function claim(v: unknown, path: string, omissions: ContextOmission[]): HandoffClaim | null {
  if (!isObj(v) || !exactKeys(v, ['text', 'expertIds', 'refs']) || typeof v.text !== 'string' || !v.text.trim() || !Array.isArray(v.refs)) return null;
  const ids = v.expertIds;
  if (!Array.isArray(ids) || ids.length > HANDOFF_LIMITS.expertIds || ids.some((x) => typeof x !== 'string' || !ID.test(x))) return null;
  return { text: capBytes(v.text, HANDOFF_LIMITS.claimBytes, path, omissions), expertIds: [...ids] as string[] };
}

/**
 * Reads the coaching of a stored parent memo (ProjectMemo shape, read as unknown). Never throws: an absent, failed,
 * legacy or foreign memo gives 'none'/'unreadable' and no handoff. The parent memo itself is not changed.
 */
export function readCoachingHandoff(memo: unknown): { state: HandoffState; handoff?: CoachingHandoff } {
  if (memo === undefined || memo === null) return { state: 'none' };
  if (!isObj(memo) || memo.version !== 'cloudbite-memo/v1') return { state: 'unreadable' };
  if (memo.status !== 'completed' || memo.memo === undefined) return { state: 'none' };
  if (!isObj(memo.memo)) return { state: 'unreadable' };
  const c = memo.memo.coaching;
  if (c === undefined) return { state: 'none' };
  if (!isObj(c) || !exactKeys(c, ['version', 'stance', 'viablePath', 'repairs', 'revisedProject', 'questions']) || c.version !== 'cloudbite-coaching/v1'
    || !(STANCES as readonly unknown[]).includes(c.stance) || !Array.isArray(c.repairs) || !Array.isArray(c.questions)
    || c.repairs.length > HANDOFF_LIMITS.repairs || c.questions.length > HANDOFF_LIMITS.questions
    || !isObj(c.revisedProject) || !exactKeys(c.revisedProject, ['objective', 'scope', 'nextMilestone'])
    || claim(c.viablePath, 'viablePath', []) === null) return { state: 'unreadable' };
  const omissions: ContextOmission[] = [];
  const rp = c.revisedProject;
  const objective = claim(rp.objective, 'revisedProject.objective', omissions), scope = claim(rp.scope, 'revisedProject.scope', omissions),
    nextMilestone = claim(rp.nextMilestone, 'revisedProject.nextMilestone', omissions);
  const repairs: HandoffRepair[] = [];
  for (const [i, r] of c.repairs.entries()) {
    if (!isObj(r) || !exactKeys(r, ['issue', 'kind', 'priority', 'change', 'check', 'decisionTrigger'])
      || !(KINDS as readonly unknown[]).includes(r.kind) || !(PRIORITY_ORDER as readonly unknown[]).includes(r.priority)) return { state: 'unreadable' };
    const p = `repairs[${i}]`;
    const issue = claim(r.issue, `${p}.issue`, omissions), change = claim(r.change, `${p}.change`, omissions),
      check = claim(r.check, `${p}.check`, omissions), decisionTrigger = claim(r.decisionTrigger, `${p}.decisionTrigger`, omissions);
    if (!issue || !change || !check || !decisionTrigger) return { state: 'unreadable' };
    repairs.push({ id: `repair-${i + 1}`, priority: r.priority as HandoffPriority, kind: r.kind as HandoffRepair['kind'], issue, change, check, decisionTrigger,
      status: 'proposed-not-executed', verification: 'not-verified' });
  }
  const questions: HandoffQuestion[] = [];
  for (const [i, q] of c.questions.entries()) {
    const text = claim(q, `questions[${i}]`, omissions);
    if (!text) return { state: 'unreadable' };
    questions.push({ id: `question-${i + 1}`, text, status: 'open-not-answered' });
  }
  if (!objective || !scope || !nextMilestone) return { state: 'unreadable' };
  repairs.sort((a, b) => PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(b.priority));
  const handoff: CoachingHandoff = { version: PROJECT_CONTEXT_VERSION, source: 'parent-memo-coaching', standing: 'generated-proposal-not-adopted',
    stance: c.stance as CoachingHandoff['stance'], revisedProject: { objective, scope, nextMilestone }, repairs, questions, omissions };
  // Whole-handoff budget: drop the last question, then the lowest-priority repair, until it fits.
  let droppedQ = 0, droppedR = 0;
  while (bytes(JSON.stringify(handoff)) > HANDOFF_LIMITS.totalBytes && (handoff.questions.length || handoff.repairs.length)) {
    if (handoff.questions.length) { handoff.questions.pop(); droppedQ++; } else { handoff.repairs.pop(); droppedR++; }
  }
  if (droppedQ) omissions.push({ path: 'questions', omittedItems: droppedQ });
  if (droppedR) omissions.push({ path: 'repairs', omittedItems: droppedR });
  return { state: 'present', handoff };
}

function listChange(subject: ContinuitySubject, prev: readonly string[] = [], cur: readonly string[] = []): ContinuityChange {
  const a = new Set(prev), b = new Set(cur);
  return { subject, added: [...b].filter((x) => !a.has(x)).length, removed: [...a].filter((x) => !b.has(x)).length, changed: 0 };
}

/**
 * Exact-text continuity between the authorized parent frame and the new round. Pure; the handoff (if any) is copied.
 * `reevaluate` is true whenever any subject changed or parent evidence is missing — a request to re-check, not a verdict.
 */
export function buildRoundContinuity(input: { state: HandoffState; handoff?: CoachingHandoff; previous: ContinuityFrame; current: ContinuityFrame }): RoundContinuity {
  const { previous: p, current: c } = input, omissions: ContextOmission[] = [];
  const ids = (list: string[], path: string) => {
    if (list.length > HANDOFF_LIMITS.changeIds) omissions.push({ path, omittedItems: list.length - HANDOFF_LIMITS.changeIds });
    return list.slice(0, HANDOFF_LIMITS.changeIds).map((x, i) => capBytes(x, 64, `${path}[${i}]`, omissions));
  };
  const prevDocs = new Map(p.documents.map((d) => [d.id, d.sha256])), curDocs = new Map(c.documents.map((d) => [d.id, d.sha256]));
  const docAdded = c.documents.filter((d) => !prevDocs.has(d.id)).map((d) => d.id);
  const docRemoved = p.documents.filter((d) => !curDocs.has(d.id)).map((d) => d.id);
  const docChanged = c.documents.filter((d) => prevDocs.has(d.id) && prevDocs.get(d.id) !== d.sha256).map((d) => d.id);
  const all: ContinuityChange[] = [
    { subject: 'stage', added: 0, removed: 0, changed: p.stage === c.stage ? 0 : 1 },
    listChange('options', p.options, c.options),
    ...(['constraints', 'successCriteria', 'knownFacts', 'assumptions', 'unknowns'] as const).map((k) => listChange(k, p.lists[k], c.lists[k])),
    { subject: 'documents', added: docAdded.length, removed: docRemoved.length, changed: docChanged.length,
      ...(docAdded.length + docRemoved.length + docChanged.length ? { ids: ids([...docChanged, ...docRemoved, ...docAdded], 'changed.documents.ids') } : {}) },
  ];
  const changed = all.filter((x) => x.added || x.removed || x.changed);
  const missingEvidence = ids(docRemoved, 'missingEvidence');
  return {
    version: PROJECT_CONTEXT_VERSION, label: 'previous-round-continuity', trust: 'untrusted-data', parentCoaching: input.state,
    ...(input.state === 'present' && input.handoff ? { priorProposals: structuredClone(input.handoff) } : {}),
    changeSummaryStanding: 'user-statement-not-verified', changed, missingEvidence,
    reevaluate: changed.length > 0 || docRemoved.length > 0, instructions: [...CONTINUITY_INSTRUCTIONS], omissions,
  };
}
