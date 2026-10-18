import type { Lab, Seat, Session } from './state';
import { checkpointContextText } from './lab-checkpoint';

export interface RecoveryNativeRef { labId: string; n: number; code: string; sandboxId: string; sid: string; generation: string }
export interface RecoveryAuthority { owner: string; revision: number; fingerprint: string; ref: RecoveryNativeRef; verifiedFileId: string | null }
export interface RecoveryNativeIntent extends RecoveryAuthority { requestId: string; kind: 'repair' | 'replace'; ackDataLoss: boolean; createdAt: number; status: string }
export const sameRecoveryRef = (a: RecoveryNativeRef | undefined, b: RecoveryNativeRef) => !!a && a.labId === b.labId && a.n === b.n && a.code === b.code && a.sandboxId === b.sandboxId && a.sid === b.sid && a.generation === b.generation;
export interface RecoveryNativeResource {
  requestId: string; labId: string; n: number; kind: 'repair' | 'replace';
  originalRevision: number; nativeRevision: number; fingerprint: string; oldRef: RecoveryNativeRef;
  phase: 'intent' | 'candidate' | 'adopted' | 'healthy'; createdAt: number; at?: number;
  candidate?: { code: string; label: string; generation: string; tokenHash: string; seal: {iv: string; ct: string}; sandboxId?: string };
  resultGeneration?: string;
}
export const recoveryResourceKey = (id: string, requestId: string) => `labrecover-resource:${encodeURIComponent(id)}:${requestId}`;
export const recoveryGenerationText = (lab: Lab, seat: Seat) => JSON.stringify([lab.id, seat.n, seat.code, seat.sandboxId ?? '', seat.generation ?? 'legacy', seat.label ?? '']);
/** Fingerprints immutable authority and quota settings, never changing usage counters. */
export function recoveryBindingText(lab: Lab, seat: Seat, session: Session | undefined, providerRows: unknown[]) {
  return JSON.stringify([checkpointContextText(lab), lab.expiresAt, lab.budget, recoveryGenerationText(lab, seat), session ? {
    id: session.id, tokenHash: session.tokenHash, lab: session.lab, providers: session.providers, gens: session.gens,
    orKeyHash: session.orKeyHash, orProvider: session.orProvider, budget: session.budget, expiresAt: session.expiresAt,
    limits: session.limits, revoked: !!session.revoked,
  } : null, providerRows]);
}
/** Reuse the metered account. Only its gateway credential and upper expiry change. */
export function replacementSession(fresh: Session, tokenHash: string, labExpiresAt: number): Session {
  if (!fresh.tokenHash || fresh.revoked || !tokenHash || !Number.isFinite(labExpiresAt)) throw Error('invalid replacement session');
  return { ...fresh, tokenHash, expiresAt: Math.min(fresh.expiresAt, labExpiresAt) };
}
export function replacementSeat(old: Seat, candidate: NonNullable<RecoveryNativeResource['candidate']>): Seat {
  if (!old.sid || !candidate.sandboxId) throw Error('candidate unavailable');
  return { n: old.n, code: candidate.code, label: candidate.label, generation: candidate.generation,
    sid: old.sid, sandboxId: candidate.sandboxId, ...(old.who ? {who: old.who} : {}) };
}
export const repairHealthCommand = () => 'curl --max-time 5 -s -o /dev/null -w "%{http_code}" http://127.0.0.1:8080/healthz';
