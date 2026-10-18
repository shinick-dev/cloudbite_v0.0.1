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
export interface ProjectRevision { parentId: string; changeSummary: string }
/** Code-assembled work order for one selected role. optionIds are option-1..8 of the brief's decision snapshot. */
export interface ExpertAssignment {
  expertId: string; stage: ProjectStage; question: string; optionIds: string[];
  deliverables: string[]; requiredEvidence: string[]; boundaries: string[]; perspectiveIds: string[];
  source: 'jev-coverage' | 'manual-scope';
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
