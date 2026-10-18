import type { Lab, Seat } from './state';
import { PREP_UNCERTAIN, type PrepJob } from './lab-preparation-service';

export interface PreparationView { state: 'queued' | 'preparing' | 'ready' | 'error' | 'unknown'; at: number | null }
export interface SeatDiagnostics {
  usage: number | null; limit: number | null; usageAt: number | null;
  aiError: { at: number; status: number; count: number; kind: 'rate-limit' | 'access' | 'upstream' | 'request' | 'other' } | null;
}
const nonnegative = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0;
const recent = (x: unknown, at: number, ttl: number): x is number => nonnegative(x) && x <= at && at - x < ttl;
export const emptyDiagnostics = (): SeatDiagnostics => ({ usage: null, limit: null, usageAt: null, aiError: null });

/** Saved server preparation only; participant names and materials completion are independent. */
export function preparationView(lab: Lab, seat: Seat, value: unknown, at: number): PreparationView {
  const unknown: PreparationView = { state: 'unknown', at: null };
  if (seat.error || (seat.setup?.state === 'error' && seat.setup.note === PREP_UNCERTAIN)) return { state: 'error', at: null };
  const j = value as PrepJob | undefined;
  if (!j || !j.ref || !seat.sandboxId || j.ref.labId !== lab.id || j.ref.n !== seat.n || j.ref.code !== seat.code || j.ref.sandboxId !== seat.sandboxId) return unknown;
  if (typeof j.op !== 'string' || !j.op || !nonnegative(j.created) || j.created > at || !nonnegative(j.deadline) || j.deadline < j.created || !nonnegative(j.due) || !Number.isInteger(j.tries) || j.tries < 0 || !Number.isInteger(j.editors) || j.editors < 0) return unknown;
  if (j.phase === 'ready' || j.phase === 'failed' || j.phase === 'uncertain') {
    if (!nonnegative(j.endedAt) || j.endedAt < j.created || j.endedAt > at || (j.phase !== 'uncertain' && at - j.endedAt >= 24 * 3600e3)) return unknown;
    if (j.phase === 'ready' && (!nonnegative(j.started) || j.started < j.created || j.started > j.endedAt || j.endedAt > j.deadline)) return unknown;
    return { state: j.phase === 'ready' ? 'ready' : 'error', at: j.endedAt };
  }
  if (j.deadline <= at) return unknown;
  if (j.phase === 'queued') return { state: 'queued', at: j.created };
  if (['wake', 'install', 'probe', 'editor'].includes(j.phase) && nonnegative(j.started) && j.started >= j.created && j.started <= at) return { state: 'preparing', at: j.started };
  return unknown;
}

/** Whitelist scalars from a fresh cache and recent stored error; no provider data escapes. */
export function seatDiagnostics(cache: unknown, error: unknown, at: number): SeatDiagnostics {
  const out = emptyDiagnostics();
  const c = cache as { at?: unknown; v?: { usage?: unknown; limit?: unknown } } | undefined;
  if (c && recent(c.at, at, 30e3) && c.v && nonnegative(c.v.usage) && (c.v.limit === null || nonnegative(c.v.limit))) {
    out.usage = c.v.usage; out.limit = c.v.limit; out.usageAt = c.at;
  }
  const e = error as { at?: unknown; status?: unknown; n?: unknown } | undefined;
  if (e && recent(e.at, at, 10 * 60e3) && typeof e.status === 'number' && Number.isInteger(e.status) && e.status >= 400 && e.status <= 599 && typeof e.n === 'number' && Number.isInteger(e.n) && e.n > 0 && e.n <= 1_000_000) {
    const status = e.status;
    out.aiError = { at: e.at, status, count: e.n, kind: status === 429 ? 'rate-limit' : status === 401 || status === 403 ? 'access' : status >= 500 ? 'upstream' : status < 500 ? 'request' : 'other' };
  }
  return out;
}
