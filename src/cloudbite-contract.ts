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
}
export interface CloudbiteRoutingQuery { title: string; objective: string; context: string; requestId: string }
/** Team composition judgments, not answer correctness or a completed peer review. */
export interface CloudbiteRoutingHarness {
  version: 'project-team/v1';
  stages: ['assessment', 'team-review'];
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
