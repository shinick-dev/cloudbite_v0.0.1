import type { ProjectRun, ProjectStatus } from './cloudbite-contract';

export const HISTORY_DAYS = 30;
export const HISTORY_TTL = HISTORY_DAYS * 86400_000;
export const HISTORY_ISSUES = ['incorrect', 'missing-sources', 'too-generic', 'off-topic', 'slow', 'other'] as const;
export type HistoryIssue = typeof HISTORY_ISSUES[number];
export interface HistoryFeedback { expertId: string; rating: 'helpful' | 'unhelpful'; issue?: HistoryIssue; comment: string; at: number }
export interface HistoryRole { id: string; basis: string; revision: string; promptHash: string }
export interface HistoryIdentity { actor: string; model: string; roles: HistoryRole[]; revision: number; published: number; nextAt: number; deleted?: boolean }
export interface HistoryExpertSignal { id: string; status: string; confidence?: number; referenced: boolean; errorKind?: string }
export interface HistoryRow {
  id: string; actor: string; title: string; mode: 'live' | 'demo'; status: ProjectStatus;
  createdAt: number; updatedAt: number; expiresAt: number; revision: number; deleted: boolean;
  model: string; roles: HistoryRole[]; experts: HistoryExpertSignal[]; feedback: HistoryFeedback[];
}
export type HistoryListRow = Omit<HistoryRow, 'actor' | 'roles' | 'experts' | 'feedback' | 'revision' | 'deleted'> & { expertCount: number; feedbackCount: number; browser?: string };
export interface HistoryDetail { project: ProjectRun; model: string; roles: HistoryRole[]; feedback: HistoryFeedback[]; reports?: Record<string, string>; expiresAt: number; canFeedback: boolean }
export interface HistoryList { rows: HistoryListRow[]; next: string | null; owner: boolean; retentionDays: number }
export interface HistoryReport {
  sampleLimit: number; analyzed: number; live: number; demoExcluded: number; pending: number;
  experts: number; completed: number; failed: number; cancelled: number; referenced: number;
  uniformConfidenceProjects: number; confidenceBins: number[];
  feedback: { helpful: number; unhelpful: number; issues: Record<string, number> };
  errors: Record<string, number>;
  roles: Array<{ id: string; completed: number; failed: number; referenced: number; unhelpful: number; basis: string; revisions: string[] }>;
  models: Array<{ model: string; projects: number; failed: number }>;
  insights: Array<{ kind: 'execution' | 'sources' | 'confidence' | 'feedback' | 'knowledge'; count: number; total: number }>;
}
