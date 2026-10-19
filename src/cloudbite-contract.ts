/** Shared Cloudbite v0.0.1 contract. Confidence is self-assessed 0–100. */
export type ExpertStatus = 'queued' | 'provisioning' | 'running' | 'completed' | 'failed' | 'cancelled';
export type ProjectStatus = 'draft' | 'running' | 'completed' | 'partial' | 'failed' | 'cancelled';
export type OpinionDirection = 'support' | 'conditional' | 'concern' | 'abstain';
export interface ExpertDefinition {
  id: string;
  name: string;
  domain: string;
  summary: string;
  prompt: string;
  tools: string[];
  outputs: string[];
  source: { repository: string; path: string; revision: string; license: string; basis: 'metadata-derived' | 'curated-knowledge' };
}
export interface ProjectBrief {
  title: string;
  objective: string;
  context: string;
  expertIds: string[];
  mode: 'demo' | 'live';
  requestId: string;
  decision?: DecisionFrame;
  documents?: ProjectDocument[];
  /** Optional user claims about the project (data, not authority); validated by cloudbite-workflow.ts. */
  stage?: ProjectStage;
  responseLanguage?: ResponseLanguage;
  budget?: ProjectBudget;
  revision?: ProjectRevision;
}
/** 'unspecified' is the normalized value of an absent stage; code never infers a known stage. */
export type ProjectStage = 'discovery' | 'design' | 'validation' | 'launch' | 'operation' | 'unspecified';
export type ResponseLanguage = 'ko' | 'en';
/** Requested upper bounds (integers): maxExperts 1-100, maxModelCalls 1-804 in total, maxReviewCalls 0-3, maxMemoCalls 0-1. */
export interface ProjectBudget { maxExperts: number; maxModelCalls: number; maxReviewCalls: number; maxMemoCalls: number }
/** A user's claim that this brief revises an earlier project; parentId is not proof of ownership. */
export interface ProjectRevision {
  parentId: string; changeSummary: string;
  /** Explicit author-response round, bound to the authorized parent's completed cross-review. */
  reviewSnapshotHash?: string;
}
/** Code-assembled work order for one selected role. optionIds are option-1..8 of the brief's decision snapshot. */
export interface ExpertAssignment {
  expertId: string; stage: ProjectStage; question: string; optionIds: string[];
  deliverables: string[]; requiredEvidence: string[]; boundaries: string[]; perspectiveIds: string[];
  source: 'jev-coverage' | 'manual-scope';
}
/** A validated plan, not a reservation or permission to execute. Creation revalidates the same brief. */
export interface ProjectPreview {
  expertIds: string[];
  assignments: ExpertAssignment[];
  budget: ProjectBudget;
  envelope: {
    sandboxMaximum: number;
    nosanaMaximum: number;
    expertMaximum: number;
    reviewMaximum: number;
    memoMaximum: number;
    /** Separate typed routing calls, outside the Nosana budget; zero for manual selection. */
    jevCalls: number;
  };
  warnings: string[];
}
export interface DecisionFrame {
  options: string[]; constraints: string[]; successCriteria: string[];
  knownFacts: string[]; assumptions: string[]; unknowns: string[];
}
/** User-provided evidence, never trusted instructions or independently verified facts. */
export interface ProjectDocument { id: string; name: string; content: string; origin?: string }
export interface EvidenceClaim {
  id: string; expertId: string; text: string;
  references: Array<{ kind: 'document' | 'knowledge'; id: string; available: boolean }>;
  status: 'linked' | 'unlinked';
}
export interface CrossReviewFinding {
  targetExpertId: string; evidenceIndex: number; verdict: 'supported' | 'challenged' | 'insufficient';
  rationale: string;
}
export interface CrossReviewReport { reviewerExpertId: string; findings: CrossReviewFinding[]; summary: string }
export interface ProjectCrossReview {
  status: 'running' | 'completed' | 'failed'; snapshotHash: string; startedAt: number; completedAt?: number;
  reports: CrossReviewReport[]; error?: string;
  /** No sandbox is created for this bounded server-side second pass. */
  execution: 'server-nosana';
  /** Planned reviewer/peer coverage of this attempt (after budget trimming) and its plain-language limits. */
  coverage?: CrossReviewCoverage; disclosure?: string;
  /** Per finding: which cited texts were actually in the reviewer's input. Never changes a verdict. */
  textAvailability?: CrossReviewTextAvailability[];
  /** Exact stored artifact excerpts supplied to the reviewers. Reading is not execution or verification. */
  artifactCoverage?: Array<{
    expertId: string; packetSha256: string;
    files: Array<{ path: string; sha256: string; startLine: number; endLine: number; totalLines: number; excerptTruncated: boolean; storedTruncated: boolean }>;
    omitted: Array<{ path: string; reason: string }>;
  }>;
}
export interface CloudbiteRoutingQuery {
  title: string; objective: string; context: string; requestId: string;
  decision?: DecisionFrame; documents?: ProjectDocument[];
  stage?: ProjectStage; responseLanguage?: ResponseLanguage; budget?: ProjectBudget; revision?: ProjectRevision;
}
/** Team composition judgments, not answer correctness or a completed peer review. */
export interface CloudbiteRoutingHarness {
  version: 'project-team/v1';
  stages: Array<'assessment' | 'team-review'>; // exact order checked at runtime; RPC serializes tuples as arrays
  eligibleCount: number;
  perspectives: Array<{ id: string; name: string; need: number; status: 'covered' | 'uncovered' | 'limited'; expertIds: string[] }>;
  selections: Array<{ expertId: string; perspectiveIds: string[]; kind: 'coverage' | 'additional-domain' }>;
  excluded: Array<{ expertId: string; reason: 'overlap' | 'limit' | 'below-threshold'; coveredBy?: string }>;
  warnings: string[];
  peerReview: 'not-performed';
}
export interface CloudbiteRoutingDecision {
  provider: 'typesafe'; model: string; policyVersion: string; evaluatedCount: number; threshold: number;
  expertIds: string[]; matches: Array<{ expertId: string; relevance: number }>; queryHash: string; expiresAt: number;
  harness?: CloudbiteRoutingHarness;
}
export interface ExpertOpinion {
  direction: OpinionDirection;
  confidence: number;
  summary: string;
  evidence: string[];
  assumptions: string[];
  nextActions: string[];
}
export interface ExpertActivity {
  id: string;
  at: number;
  kind: 'status' | 'thought' | 'tool' | 'artifact' | 'error';
  message: string;
}
export interface ExpertArtifact { path: string; label: string; content?: string; bytes?: number }
export interface ExpertRun {
  id: string;
  expertId: string;
  name: string;
  status: ExpertStatus;
  sandboxId?: string;
  activity: ExpertActivity[];
  artifacts: ExpertArtifact[];
  opinion?: ExpertOpinion;
  error?: string;
  updatedAt: number;
  assignment?: ExpertAssignment;
  /** Response to parent review, separate from the unchanged six-key opinion and its completion status. */
  authorResponse?: import('./cloudbite-author-response').AuthorResponseParsed | { invalid: string };
}
export interface ProjectRun {
  id: string;
  brief: ProjectBrief;
  status: ProjectStatus;
  experts: ExpertRun[];
  createdAt: number;
  updatedAt: number;
  /** Observed routing result at creation; expiresAt refers to the pre-create decision cache. */
  routing?: CloudbiteRoutingDecision;
  evidenceClaims?: EvidenceClaim[];
  crossReview?: ProjectCrossReview;
  assignments?: ExpertAssignment[];
  /** Opt-in final decision memo (src/cloudbite-memo.ts): one paid attempt, a derived interpretation, never a vote. */
  memo?: ProjectMemo;
  /** Model-call ledger of this project (src/cloudbite-budget.ts): caps and reserved counts, not money or tokens. */
  usage?: ProjectUsage;
  /** Observed citation/retrieval counts beside each self-assessed confidence; never a probability or accuracy score. */
  evidenceSignals?: import('./cloudbite-evidence').EvidenceSignals;
  /** Application-built evidence packets of completed experts, in completed order, under one total byte bound. */
  evidencePackets?: import('./cloudbite-evidence-packet').EvidencePacket[];
  /** Follow-up round: bounded, labelled reference to the parent project (untrusted data, never fresh opinions). */
  previousRound?: import('./cloudbite-revision').ProjectPreviousRound;
  /** Epistemic origin and explicit user adoption; neither is independent fact verification. */
  provenance?: { ledger: import('./cloudbite-provenance').ProvenanceLedger; state: import('./cloudbite-provenance').ProvenanceState };
}
// Public mirrors of leaf types whose modules import server-only configuration (cloudbite-config → state), so the
// browser build (tsconfig.client.json) can read them. src/cloudbite-project.ts asserts at compile time that each
// mirror and its leaf type (cloudbite-memo, cloudbite-budget, cloudbite-cross-review) are mutually assignable.
export interface CrossReviewCoverage { completedOpinions: number; assignedOpinions: number; unassigned: string[]; reviewers: number; maxReviewers: number; maxPeersPerReviewer: number }
export interface CrossReviewTextAvailability {
  reviewerExpertId: string; targetExpertId: string; evidenceIndex: number; verdict: CrossReviewFinding['verdict'];
  availability: import('./cloudbite-evidence-packet').TextAvailability[];
  textBasis: 'available' | 'partial' | 'unavailable' | 'uncited';
}
export interface BudgetCapsView { maxExperts: number; maxModelCalls: number; maxReviewCalls: number; maxMemoCalls: number; perExpertCalls: number; expertPool: number }
export interface BudgetPhaseView { used: number; max: number; available: number; exhausted: boolean }
/** Mirror of cloudbite-budget BudgetPublic. */
export interface BudgetView {
  version: 'cloudbite-budget/v1'; migrated: boolean;
  total: BudgetPhaseView; expert: BudgetPhaseView; review: BudgetPhaseView; memo: BudgetPhaseView;
  perExpertCalls: number; exhausted: boolean; expertsExhausted: boolean;
  caps: BudgetCapsView; perExpert: Record<string, number>;
}
/** Public budget view plus the separate, uncounted routing calls and the sandbox upper bound (not actual spend). */
export type ProjectUsage = BudgetView & {
  /** Typed Jev routing calls of the routing decision this project was created from; 0 for manual selection. */
  jevCalls: number;
  /** One Daytona sandbox per selected expert at most; an upper bound, not a spend figure. */
  sandboxMaximum: number;
};
export type MemoReference =
  | { kind: 'opinion-evidence'; expertId: string; index: number }
  | { kind: 'document'; id: string }
  | { kind: 'packet'; id: string }
  | { kind: 'review-finding'; reviewerExpertId: string; index: number }
  | { kind: 'brief'; field: string };
export interface MemoClaim { text: string; expertIds: string[]; refs: MemoReference[] }
export interface MemoOptionComparison { optionId: string; optionText: string; benefits: MemoClaim[]; risks: MemoClaim[]; conditions: MemoClaim[] }
export interface MemoRecommendation {
  status: 'recommend' | 'no-recommendation'; optionIds: string[]; options: Array<{ id: string; text: string }>;
  rationale: string; expertIds: string[]; refs: MemoReference[];
}
/** Mirror of cloudbite-memo DecisionMemo: a derived interpretation with no calibrated confidence. */
export interface DecisionMemo {
  summary: string; recommendation: MemoRecommendation; comparison: MemoOptionComparison[];
  dissent: MemoClaim[]; criticalUnknowns: MemoClaim[]; changeTriggers: MemoClaim[]; nextActions: MemoClaim[];
  basis: 'derived-interpretation'; confidence: 'not-calibrated';
}
export interface MemoSectionCoverage { included: number; total: number; truncated: number; omitted: number }
export interface MemoExpertCoverage {
  expertId: string; summaryTruncated: boolean; evidenceIncluded: number[]; evidenceTotal: number; itemsTruncated: number;
  assumptionsIncluded: number; assumptionsTotal: number; nextActionsIncluded: number; nextActionsTotal: number;
}
/** Code-computed coverage: completed/teamSize is the honest share of the selected team behind a memo. */
export interface MemoCoverage {
  teamSize: number; completed: number; statusCounts: Partial<Record<ExpertStatus, number>>;
  statedDirections: Record<OpinionDirection, number>;
  experts: MemoExpertCoverage[]; documents: Array<{ id: string; includedBytes: number; originalBytes: number; truncated: boolean }>;
  brief: { objectiveTruncated: boolean; contextTruncated: boolean; decisionItemsTruncated: number; decisionItemsOmitted: number; revisionTruncated: boolean };
  reviews: MemoSectionCoverage & { reports: number };
  packets: MemoSectionCoverage & { invalid: number; metadataOnly: number };
  fullReportsReviewed: false; sourcePagesReviewed: false;
  promptBytes: number;
}
/** Mirror of cloudbite-memo ProjectMemo. attempts is persisted before inference; a lost attempt is never rerun. */
export interface ProjectMemo {
  version: 'cloudbite-memo/v1'; status: 'idle' | 'running' | 'completed' | 'failed' | 'needs-options'; attempts: number;
  snapshotHash?: string; startedAt?: number; completedAt?: number; language?: ResponseLanguage;
  coverage?: MemoCoverage; memo?: DecisionMemo; reason?: string; error?: string;
  execution: 'server-nosana' | 'none';
}
export interface CloudbiteBootstrap {
  experts: ExpertDefinition[];
  configuration: { liveReady: boolean; missing: string[]; maxExperts: number; maxConcurrent?: number; historyRetentionDays?: number;
    routing?: { provider: 'typesafe'; model: string; ready: boolean; maxExperts: number } };
  access?: import('./cloudbite-access-contract').CloudbiteAccessSession;
  /** Optional 100-role planning catalogue. Only `available` entries map to runnable `experts`; all are unvalidated. */
  pool?: import('./cloudbite-pool').ExpertPool;
}
export interface CloudbiteProjectCreated { project: ProjectRun; accessToken: string }
