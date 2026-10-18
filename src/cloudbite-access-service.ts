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
export const CB_ACCESS_MAX_PROJECTS = 10;
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
  projects?: Binding[];        // this grant's non-refunded project slots, at most CB_ACCESS_MAX_PROJECTS
  refunds?: number;            // failed-run refunds used (absent on records written before refunds existed = 0)
  refunded?: string[];         // scoped requestIds already refunded: never bound again
  // Single-project records written before the multi-project quota (read through bindings(); dropped on the next write).
  projectRequestId?: string; holds?: number; confirmed?: boolean;
}
/** One project slot: a scoped requestId, bound atomically on its first reserve. */
interface Binding {
  id: string;
  holds: number;               // creates in flight for this requestId
  confirmed?: boolean;         // a project was created (or may exist): the slot is permanent unless refunded
}

/** The record's slots; a legacy single binding (with its holds and confirmation) reads as a one-entry list. */
function bindings(r: AccessRecord): Binding[] {
  if (r.projects) return r.projects;
  return r.projectRequestId ? [{ id: r.projectRequestId, holds: r.holds ?? 0, ...(r.confirmed ? { confirmed: true } : {}) }] : [];
}
/** Store slots in the current shape (lazy migration: legacy fields go; refunds/refunded tombstones stay). */
function setBindings(r: AccessRecord, list: Binding[]) {
  r.projects = list;
  delete r.projectRequestId; delete r.holds; delete r.confirmed;
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
      maxExperts: CB_MAX_EXPERTS, maxProjects: CB_ACCESS_MAX_PROJECTS, usedProjects: Math.min(CB_ACCESS_MAX_PROJECTS, bindings(r).length),
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
      const r: AccessRecord = { id, name, purpose, status: 'pending', createdAt: now, expiresAt: now + CB_ACCESS_PENDING_TTL, credHash: newCredHash, projects: [] };
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
   * Atomically bind one of this grant's project slots to scopedRequestId, or accept a retry of an id it already holds
   * (a retry never takes another slot, even at full quota). fresh=true means this call created the slot. Each
   * successful reserve must be followed by confirm or release of the same id.
   */
  reserve(credHash: string | null, scopedRequestId: string, experts: number): Promise<{ id: string; fresh: boolean } | Fail> {
    return this.serial(async () => {
      const r = await this.byCred(credHash);
      if (!r || this.status(r, this.clock()) !== 'approved') return fail(401, 'approved access required');
      if (!HEX64.test(scopedRequestId)) return fail(400, 'invalid project request');
      if (!Number.isInteger(experts) || experts < 1 || experts > CB_MAX_EXPERTS) return fail(403, `this access allows at most ${CB_MAX_EXPERTS} experts`);
      if (r.refunded?.includes(scopedRequestId)) return fail(409, 'that run already failed; start a new run');
      const list = bindings(r);
      const b = list.find((x) => x.id === scopedRequestId);
      if (!b && list.length >= CB_ACCESS_MAX_PROJECTS) return fail(409, `this access has already been used for ${CB_ACCESS_MAX_PROJECTS} projects`);
      setBindings(r, b ? list.map((x) => (x === b ? { ...x, holds: x.holds + 1 } : x)) : [...list, { id: scopedRequestId, holds: 1 }]);
      await this.ctx.storage.put(`req:${r.id}`, r);
      return { id: r.id, fresh: !b };
    });
  }

  /** Slots a refund may start from: approved, unexpired grant; confirmed slots with no create in flight. */
  private refundable(r: AccessRecord | null, now: number): Binding[] {
    if (!r || this.status(r, now) !== 'approved') return [];
    return bindings(r).filter((b) => b.confirmed === true && !b.holds);
  }

  /**
   * Failed-run refund, step 1 (read-only). The scoped requestIds of this grant's settled slots (at most
   * CB_ACCESS_MAX_PROJECTS), for the Worker to ask each project (by the server-stored id, never a browser one) whether
   * it failed and was cleaned up. left = failed-run refunds this grant may still use.
   */
  refundCandidate(credHash: string | null): Promise<{ session: CloudbiteAccessSession; scoped: string[]; left: number }> {
    return this.serial(async () => {
      const r = await this.byCred(credHash), now = this.clock();
      const scoped = this.refundable(r, now).map((b) => b.id);
      return { session: this.session(r, now), scoped, left: Math.max(0, CB_ACCESS_MAX_FAILED_REFUNDS - (r?.refunds ?? 0)) };
    });
  }

  /**
   * Failed-run refund, step 2. The Worker has just seen each of these projects report 'refundable'. Compare-and-clear
   * per id, in order, while refunds remain: only a slot this grant still holds for exactly that id, confirmed and with
   * nothing in flight. Each refunded id is remembered so it can never be bound (or refunded) again; other slots are
   * untouched. A stale, foreign or concurrent id is a no-op.
   */
  refund(credHash: string | null, scoped: string[]): Promise<CloudbiteAccessSession> {
    return this.serial(async () => {
      const r = await this.byCred(credHash), now = this.clock();
      if (r && Array.isArray(scoped)) {
        const ok = new Set(this.refundable(r, now).map((b) => b.id));
        const done: string[] = [];
        for (const id of scoped.slice(0, CB_ACCESS_MAX_PROJECTS)) {
          if ((r.refunds ?? 0) + done.length >= CB_ACCESS_MAX_FAILED_REFUNDS) break;
          if (typeof id === 'string' && ok.delete(id)) done.push(id);
        }
        if (done.length) {
          r.refunds = (r.refunds ?? 0) + done.length;
          r.refunded = [...(r.refunded ?? []), ...done];
          setBindings(r, bindings(r).filter((b) => !done.includes(b.id)));
          await this.ctx.storage.put(`req:${r.id}`, r);
        }
      }
      return this.session(r, now);
    });
  }

  /** The project now exists (or may): keep that slot for this grant (only a failed-run refund clears it). */
  confirm(id: string, scopedRequestId: string): Promise<{ ok: true }> {
    return this.serial(async () => {
      const r = CB_ACCESS_ID.test(id) ? await this.ctx.storage.get<AccessRecord>(`req:${id}`) : undefined;
      const list = r ? bindings(r) : [];
      if (r && list.some((b) => b.id === scopedRequestId)) {
        setBindings(r, list.map((b) => (b.id === scopedRequestId ? { id: b.id, holds: Math.max(0, b.holds - 1), confirmed: true } : b)));
        await this.ctx.storage.put(`req:${r.id}`, r);
      }
      return { ok: true as const };
    });
  }

  /**
   * Creation definitely did not happen for this attempt. That slot is freed only when no other attempt for the same
   * requestId is in flight and none ever succeeded — never another id's slot, never a confirmed one.
   */
  release(id: string, scopedRequestId: string): Promise<{ ok: true }> {
    return this.serial(async () => {
      const r = CB_ACCESS_ID.test(id) ? await this.ctx.storage.get<AccessRecord>(`req:${id}`) : undefined;
      const list = r ? bindings(r) : [];
      if (r && list.some((b) => b.id === scopedRequestId)) {
        setBindings(r, list.flatMap((b) => {
          if (b.id !== scopedRequestId) return [b];
          const holds = Math.max(0, b.holds - 1);
          return !holds && !b.confirmed ? [] : [{ ...b, holds }];
        }));
        await this.ctx.storage.put(`req:${r.id}`, r);
      }
      return { ok: true as const };
    });
  }
}
