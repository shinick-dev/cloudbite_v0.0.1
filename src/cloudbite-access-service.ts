// Cloudbite audience access Durable Object (docs/cloudbite/access-service.txt). One instance per event
// (getByName(CB_ACCESS_INBOX)) is the single coordination point for requests, owner decisions and the per-grant
// project quota. Every method runs inside one serial queue and touches storage only, so a read-check-write is one
// atomic step (no fetches, no external calls). The Worker has already checked Origin, body size and owner identity.
//
// Storage keys:
//   req:<id>        AccessRecord — public fields + credential hash (never returned) + quota binding
//   cred:<sha256>   request id the browser credential belongs to
//   rate:<srcHash>  creation times (ms) for that hashed source within the last hour
import { DurableObject } from 'cloudflare:workers';
import type { Env } from './state';
import type { CloudbiteAccessRequest, CloudbiteAccessSession } from './cloudbite-access-contract';
import { CB_MAX_EXPERTS } from './cloudbite-config';

export const CB_ACCESS_INBOX = 'hacksprint-2026-10-18';
export const CB_ACCESS_ID = /^cba_[0-9a-f]{32}$/;
export const CB_ACCESS_PENDING_TTL = 30 * 60_000;
export const CB_ACCESS_GRANT_TTL = 3600_000;
export const CB_ACCESS_RETAIN_AFTER_END = 8 * 3600_000;
export const CB_ACCESS_MAX_PENDING = 100;
export const CB_ACCESS_MAX_RETAINED = 500;
export const CB_ACCESS_RATE = 120;             // new requests per hashed source per hour (a venue shares one NAT address)
export const CB_ACCESS_RATE_WINDOW = 3600_000;
export const CB_ACCESS_LIST_MAX = 100;
export const CB_ACCESS_MAX_PROJECTS = 1;
/** A grant whose project failed with zero completed experts gets its slot back at most this many times (paid-run bound). */
export const CB_ACCESS_MAX_FAILED_REFUNDS = 3;

type Fail = { error: string; status: number };
const fail = (status: number, error: string): Fail => ({ error, status });
const HEX64 = /^[0-9a-f]{64}$/;

interface AccessRecord {
  id: string; name: string; purpose: string;
  status: 'pending' | 'approved' | 'denied' | 'revoked';
  createdAt: number; expiresAt: number; decidedAt?: number;
  credHash: string;
  projectRequestId?: string;   // scoped requestId this grant's one project is bound to (set atomically on first reserve)
  holds: number;               // creates in flight for that requestId
  confirmed?: boolean;         // a project was created (or may exist): the binding is permanent unless refunded
  refunds?: number;            // failed-run refunds used (absent on records written before refunds existed = 0)
  refunded?: string[];         // scoped requestIds already refunded: never bound again
}

export type AccessAction = 'approve' | 'deny' | 'revoke';

export class CloudbiteAccess extends DurableObject<Env> {
  protected clock() { return Date.now(); }
  private queue: Promise<unknown> = Promise.resolve();
  /** One operation at a time for this object, across every await (storage-only bodies). */
  private serial<T>(f: () => Promise<T>): Promise<T> {
    const run = this.queue.then(f, f);
    this.queue = run.catch(() => {});
    return run;
  }

  private status(r: AccessRecord, now: number): CloudbiteAccessRequest['status'] {
    return (r.status === 'pending' || r.status === 'approved') && now >= r.expiresAt ? 'expired' : r.status;
  }
  private view(r: AccessRecord, now: number): CloudbiteAccessRequest {
    return {
      id: r.id, name: r.name, purpose: r.purpose, status: this.status(r, now), createdAt: r.createdAt, expiresAt: r.expiresAt,
      maxExperts: CB_MAX_EXPERTS, maxProjects: CB_ACCESS_MAX_PROJECTS, usedProjects: r.projectRequestId ? 1 : 0,
    };
  }
  private session(r: AccessRecord | null, now: number): CloudbiteAccessSession {
    if (!r) return { request: null, canCreate: false };
    const v = this.view(r, now);
    return { request: v, canCreate: v.status === 'approved' && v.usedProjects < v.maxProjects };
  }
  private async byCred(credHash: unknown): Promise<AccessRecord | null> {
    if (typeof credHash !== 'string' || !HEX64.test(credHash)) return null;
    const id = await this.ctx.storage.get<string>(`cred:${credHash}`);
    if (!id) return null;
    const r = await this.ctx.storage.get<AccessRecord>(`req:${id}`);
    return r && r.credHash === credHash ? r : null;
  }
  private ended(r: AccessRecord, now: number) {
    const s = this.status(r, now);
    return s === 'expired' ? r.expiresAt : s === 'denied' || s === 'revoked' ? r.decidedAt ?? r.createdAt : null;
  }
  /** Drop records that ended more than 8 h ago (and their credential index) and stale rate windows. */
  private async prune(now: number): Promise<AccessRecord[]> {
    const all = [...(await this.ctx.storage.list<AccessRecord>({ prefix: 'req:' })).values()];
    const drop: string[] = [];
    const keep: AccessRecord[] = [];
    for (const r of all) {
      const end = this.ended(r, now);
      if (end !== null && now - end > CB_ACCESS_RETAIN_AFTER_END) drop.push(`req:${r.id}`, `cred:${r.credHash}`);
      else keep.push(r);
    }
    for (const [k, times] of await this.ctx.storage.list<number[]>({ prefix: 'rate:' })) {
      if (!times.some((t) => now - t < CB_ACCESS_RATE_WINDOW)) drop.push(k);
    }
    for (let i = 0; i < drop.length; i += 128) await this.ctx.storage.delete(drop.slice(i, i + 128)); // per-call key limit
    return keep;
  }

  /**
   * Visitor submit. A browser whose credential still maps to a live (pending or approved, unexpired) request gets that
   * same request back (reused: true) — refresh/retry never creates duplicates. Otherwise a new pending request bound
   * to newCredHash, after rate and capacity checks. Name/purpose are already validated text.
   */
  submit(credHash: string | null, newCredHash: string, srcHash: string, name: string, purpose: string):
    Promise<{ session: CloudbiteAccessSession; reused: boolean } | Fail> {
    return this.serial(async () => {
      if (!HEX64.test(newCredHash) || !HEX64.test(srcHash)) return fail(400, 'invalid access credential');
      const now = this.clock();
      const cur = await this.byCred(credHash);
      if (cur) {
        const s = this.status(cur, now);
        if (s === 'pending' || s === 'approved') return { session: this.session(cur, now), reused: true };
      }
      const keep = await this.prune(now);
      const rateKey = `rate:${srcHash}`;
      const times = ((await this.ctx.storage.get<number[]>(rateKey)) ?? []).filter((t) => now - t < CB_ACCESS_RATE_WINDOW);
      if (times.length >= CB_ACCESS_RATE) return fail(429, 'too many access requests from this network; try again later');
      if (keep.filter((r) => this.status(r, now) === 'pending').length >= CB_ACCESS_MAX_PENDING) return fail(429, 'the access queue is full; ask the host');
      if (keep.length >= CB_ACCESS_MAX_RETAINED) return fail(429, 'the access queue is full; ask the host');
      if (await this.ctx.storage.get(`cred:${newCredHash}`)) return fail(409, 'credential collision; retry');
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      const id = 'cba_' + [...bytes].map((x) => x.toString(16).padStart(2, '0')).join('');
      const r: AccessRecord = { id, name, purpose, status: 'pending', createdAt: now, expiresAt: now + CB_ACCESS_PENDING_TTL, credHash: newCredHash, holds: 0 };
      times.push(now);
      await this.ctx.storage.put({ [`req:${id}`]: r, [`cred:${newCredHash}`]: id, [rateKey]: times });
      return { session: this.session(r, now), reused: false };
    });
  }

  /** The request this credential belongs to, or {request:null}. Ids never authenticate; only the credential does. */
  current(credHash: string | null): Promise<CloudbiteAccessSession> {
    return this.serial(async () => this.session(await this.byCred(credHash), this.clock()));
  }

  /** Owner list: newest first, at most 100, public fields only. */
  list(): Promise<{ requests: CloudbiteAccessRequest[] }> {
    return this.serial(async () => {
      const now = this.clock();
      const rows = [...(await this.ctx.storage.list<AccessRecord>({ prefix: 'req:' })).values()];
      rows.sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
      return { requests: rows.slice(0, CB_ACCESS_LIST_MAX).map((r) => this.view(r, now)) };
    });
  }

  /**
   * Owner decision. pending→approved (grant lasts 1 h from now), pending→denied, approved→revoked.
   * Repeating the action already applied is idempotent; nothing revives an expired, denied or revoked request.
   */
  decide(id: string, action: AccessAction): Promise<CloudbiteAccessRequest | Fail> {
    return this.serial(async () => {
      if (!CB_ACCESS_ID.test(id)) return fail(404, 'access request not found');
      const r = await this.ctx.storage.get<AccessRecord>(`req:${id}`);
      if (!r) return fail(404, 'access request not found');
      const now = this.clock(), s = this.status(r, now);
      const done = { approve: 'approved', deny: 'denied', revoke: 'revoked' }[action];
      if (s === done) return this.view(r, now);
      const allowed = (action === 'approve' || action === 'deny') ? s === 'pending' : s === 'approved';
      if (!allowed) return fail(409, `cannot ${action} a request that is ${s}`);
      if (action === 'approve') { r.status = 'approved'; r.expiresAt = now + CB_ACCESS_GRANT_TTL; }
      else r.status = action === 'deny' ? 'denied' : 'revoked';
      r.decidedAt = now;
      await this.ctx.storage.put(`req:${id}`, r);
      return this.view(r, now);
    });
  }

  /** Read-only grant check before the Worker validates a brief: approved and unexpired. reserve() re-checks atomically. */
  grant(credHash: string | null): Promise<{ id: string } | Fail> {
    return this.serial(async () => {
      const r = await this.byCred(credHash);
      if (!r || this.status(r, this.clock()) !== 'approved') return fail(401, 'approved access required');
      return { id: r.id };
    });
  }

  /**
   * Atomically bind this grant's single project to scopedRequestId (or accept a retry of the same one).
   * fresh=true means this call created the binding. Each successful reserve must be followed by confirm or release.
   */
  reserve(credHash: string | null, scopedRequestId: string, experts: number): Promise<{ id: string; fresh: boolean } | Fail> {
    return this.serial(async () => {
      const r = await this.byCred(credHash);
      if (!r || this.status(r, this.clock()) !== 'approved') return fail(401, 'approved access required');
      if (!HEX64.test(scopedRequestId)) return fail(400, 'invalid project request');
      if (!Number.isInteger(experts) || experts < 1 || experts > CB_MAX_EXPERTS) return fail(403, `this access allows at most ${CB_MAX_EXPERTS} experts`);
      if (r.projectRequestId && r.projectRequestId !== scopedRequestId) return fail(409, 'this access has already been used for a project');
      if (r.refunded?.includes(scopedRequestId)) return fail(409, 'that run already failed; start a new run');
      const fresh = !r.projectRequestId;
      r.projectRequestId = scopedRequestId;
      r.holds = (r.holds ?? 0) + 1;
      await this.ctx.storage.put(`req:${r.id}`, r);
      return { id: r.id, fresh };
    });
  }

  /** Approved, unexpired, a confirmed binding with no create in flight: the only state a refund may start from. */
  private refundBinding(r: AccessRecord | null, now: number): r is AccessRecord {
    return !!r && this.status(r, now) === 'approved' && !!r.projectRequestId && r.confirmed === true && !(r.holds ?? 0);
  }

  /**
   * Failed-run refund, step 1 (read-only). The scoped requestId this grant's project is bound to, for the Worker to
   * ask that project (by the server-stored id, never a browser one) whether it failed and was cleaned up.
   */
  refundCandidate(credHash: string | null): Promise<{ session: CloudbiteAccessSession; scoped: string | null; capped: boolean }> {
    return this.serial(async () => {
      const r = await this.byCred(credHash), now = this.clock();
      const ok = this.refundBinding(r, now);
      return { session: this.session(r, now), scoped: ok ? r.projectRequestId! : null, capped: ok && (r.refunds ?? 0) >= CB_ACCESS_MAX_FAILED_REFUNDS };
    });
  }

  /**
   * Failed-run refund, step 2. The Worker has just seen the project report 'refundable' for scoped. Compare-and-clear:
   * only if the grant is still bound to exactly that id, confirmed, nothing in flight and under the cap. That id is
   * remembered so it can never be bound (or refunded) again. A stale or concurrent call is a no-op.
   */
  refund(credHash: string | null, scoped: string): Promise<CloudbiteAccessSession> {
    return this.serial(async () => {
      const r = await this.byCred(credHash), now = this.clock();
      if (this.refundBinding(r, now) && r.projectRequestId === scoped && (r.refunds ?? 0) < CB_ACCESS_MAX_FAILED_REFUNDS) {
        r.refunds = (r.refunds ?? 0) + 1;
        r.refunded = [...(r.refunded ?? []), scoped];
        r.projectRequestId = undefined; r.confirmed = false; r.holds = 0;
        await this.ctx.storage.put(`req:${r.id}`, r);
      }
      return this.session(r, now);
    });
  }

  /** The project now exists (or may): keep the binding for this grant (only a failed-run refund clears it). */
  confirm(id: string, scopedRequestId: string): Promise<{ ok: true }> {
    return this.serial(async () => {
      const r = CB_ACCESS_ID.test(id) ? await this.ctx.storage.get<AccessRecord>(`req:${id}`) : undefined;
      if (r && r.projectRequestId === scopedRequestId) {
        r.confirmed = true; r.holds = Math.max(0, (r.holds ?? 0) - 1);
        await this.ctx.storage.put(`req:${r.id}`, r);
      }
      return { ok: true as const };
    });
  }

  /**
   * Creation definitely did not happen for this attempt. The binding is cleared only when no other attempt for the
   * same requestId is in flight and none ever succeeded — never someone else's slot, never a confirmed one.
   */
  release(id: string, scopedRequestId: string): Promise<{ ok: true }> {
    return this.serial(async () => {
      const r = CB_ACCESS_ID.test(id) ? await this.ctx.storage.get<AccessRecord>(`req:${id}`) : undefined;
      if (r && r.projectRequestId === scopedRequestId) {
        r.holds = Math.max(0, (r.holds ?? 0) - 1);
        if (!r.holds && !r.confirmed) r.projectRequestId = undefined;
        await this.ctx.storage.put(`req:${r.id}`, r);
      }
      return { ok: true as const };
    });
  }
}
