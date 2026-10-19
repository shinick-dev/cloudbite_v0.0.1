// Constructive project advice is a proposed interpretation, never an adopted user decision.
// Legacy memos have no coaching field. Every claim retains the existing memo attribution contract.
import type { MemoClaim } from './cloudbite-memo';

export const CB_COACHING_VERSION = 'cloudbite-coaching/v1' as const;
export interface CoachingRepair {
  issue: MemoClaim;
  kind: 'unknown' | 'adverse-evidence' | 'tradeoff' | 'constraint';
  priority: 'now' | 'next' | 'later';
  change: MemoClaim;
  check: MemoClaim;
  decisionTrigger: MemoClaim;
}
export interface ProjectCoaching {
  version: typeof CB_COACHING_VERSION;
  stance: 'proceed-with-scope' | 'clarify-first' | 'rework' | 'pause';
  viablePath: MemoClaim;
  repairs: CoachingRepair[];
  revisedProject: { objective: MemoClaim; scope: MemoClaim; nextMilestone: MemoClaim };
  questions: MemoClaim[];
}
