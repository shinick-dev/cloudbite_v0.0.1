import type { Lab } from './state';
import type { CheckpointArchive } from './lab-export-service';
import type { FileRef } from './lab-file-receipt-service';
import { LAB_CHECKPOINT_MAX_ARCHIVE, LAB_CHECKPOINT_MAX_BYTES, LAB_CHECKPOINT_MAX_ENTRIES } from './lab-checkpoint-service';
import { trialConfigText } from './lab-trial';

export const CHECKPOINT_LIMITS = { bytes: LAB_CHECKPOINT_MAX_BYTES, entries: LAB_CHECKPOINT_MAX_ENTRIES, seconds: 30 };
export function checkpointContextText(lab: Lab) {
  return JSON.stringify([trialConfigText(lab), lab.seats.map(s => [s.n, s.code, s.sandboxId ?? null, !!s.error, s.setup?.state ?? null]).sort((a,b) => Number(a[0]) - Number(b[0]))]);
}
export interface StoredCheckpoint {
  requestId: string; revision: number; createdAt: number;
  seats: Array<{n: number; code: string; sandboxId: string}>;
  results: Array<{n: number; status: string; at: number | null; size?: number; entries?: number; bytes?: number; omitted?: number}>;
}
const count = (n: unknown, max: number): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n <= max;
/** An opaque request ID is useful only for its exact current participant seat. */
export function checkpointArchive(row: unknown, ref: FileRef, id: string, now: number): CheckpointArchive | null {
  if (!row || typeof row !== 'object') return null;
  const r = row as StoredCheckpoint;
  if (r.requestId !== id || !Number.isFinite(r.createdAt) || r.createdAt < 0 || r.createdAt > now || !Array.isArray(r.seats) || r.seats.length > 50 || !Array.isArray(r.results) || r.results.length > 50) return null;
  const seat = r.seats.filter(s => s.n === ref.n), result = r.results.filter(s => s.n === ref.n);
  if (seat.length !== 1 || result.length !== 1 || seat[0].code !== ref.code || seat[0].sandboxId !== ref.sandboxId) return null;
  const m = result[0];
  if (m.status !== 'ready' || typeof m.at !== 'number' || !Number.isFinite(m.at) || m.at < r.createdAt || m.at > now || !count(m.size, LAB_CHECKPOINT_MAX_ARCHIVE) || !count(m.entries, LAB_CHECKPOINT_MAX_ENTRIES) || !count(m.bytes, LAB_CHECKPOINT_MAX_BYTES) || !count(m.omitted, LAB_CHECKPOINT_MAX_ENTRIES)) return null;
  return { id, ...ref, size: m.size, entries: m.entries, bytes: m.bytes, skipped: m.omitted };
}
