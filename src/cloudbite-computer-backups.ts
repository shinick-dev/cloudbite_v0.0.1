// CloudBite computer automatic backups: bounded private cold filesystem snapshots of a STOPPED owned machine after a
// safe end, coalesced across frequent ends, with retention over the provider resources this ledger created.
// Everything is injected (store, provider, clock, random, protected names), so there is no Daytona/DO import here;
// the root adapts the lifecycle's ComputerBackupHook to this manager (structurally compatible).
//
// Provider rules (Daytona openapi + /docs/en/snapshots, root-verified 2026-10-19): GET /snapshots/{id} takes a name or
// an id; DELETE /snapshots/{id} takes the id only; a 200 DELETE is not completion: a later GET by id answering 404
// confirms removal, state 'removing' is in progress. Deleting also removes warm pools, so only snapshots this ledger
// generated, proven by exact name + id + sourceSandboxId === recorded machine + general === false, are ever deleted.
// Missing or unknown ownership preserves the resource and blocks new captures; a name prefix alone never proves it.
//
// Invariants: intent is persisted before every provider create/delete; an unanswered create/delete is reconciled by exact
// name/id and never blindly resubmitted (a create whose outcome stays unknown is never closed as 'not applied': finite 404s
// do not prove an old create cannot still land, so it stays owned and blocks new captures until an explicit reconcile()
// proves it); every op uses the item's own account (no substitution); the newest verified
// backup is kept until a newer one is verified; old backups are deleted only after a replacement is active+verified.
// begin() and status() are storage only; tick() is the only provider caller (alarm). Callers serialise calls per
// owner (the DO input queue); this module never calls back into the computer service.

export const BACKUP_PREFIX = 'cbak';
export const BACKUP_LIMITS = {
  retainVerified: 3,        // verified backups kept
  maxOwned: 4,              // provider resources owned at once (3 kept + one replacement), counting delete-unknown ones
  minIntervalMs: 6 * 3600_000,
  maxNewPerDay: 4,
  createPolls: 120,         // reads of a pending capture before it is 'stale' (still owned + re-read, blocks new ones)
  reconcileAbsent: 5,       // 404 reads of an unanswered create before automatic reads stop: 'unconfirmed' (owned, blocks)
  intentPolls: 30,          // ticks an intent may wait for retention room before it gives up
  deletePolls: 60,          // reads of a deleting snapshot before 'delete_blocked'
  deleteSends: 2,           // DELETE requests per snapshot, each after a fresh ownership/protection check
  tickOps: 8,               // provider calls per tick
  receipts: 32,             // requestId receipts and removal receipts kept
} as const;

const OWNER_TAG = /^[a-z0-9]{8,32}$/;
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACCOUNT = /^[a-z0-9][a-z0-9-]{0,31}$/;
const MACHINE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
/** The restore UI's 3–48 rule (inside COMPUTER_SNAPSHOT_NAME). Generated: cbak-<ownerTag[0,16)>-<base36 s>-<6 random>,
 *  at most 5+16+1+9+1+6 = 38 for any valid owner tag and timestamp; the ledger keeps the full owner tag. */
const SNAPSHOT_NAME = /^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$/;
const NAME_OWNER = 16;
const KEY = (ownerTag: string) => `computer-backups:v1:${ownerTag}`;

// ---- public contract (compatible with the lifecycle ComputerBackupHook) ----

export type ComputerBackupState = 'pending' | 'active' | 'coalesced' | 'failed' | 'blocked' | 'unknown';
export type ComputerBackupReason =
  | 'bad_request' | 'request_conflict' | 'not_stopped' | 'busy' | 'recent' | 'unchanged' | 'daily_limit'
  | 'retention_blocked' | 'cleanup_blocked' | 'ownership_unproven' | 'foreign' | 'name_collision'
  | 'provider_refused' | 'provider_error' | 'not_applied' | 'create_unconfirmed' | 'timeout' | 'no_backup';
export interface ComputerBackupStatus {
  state: ComputerBackupState;
  /** The backup this answer is about (the new one, the in-flight one joined, or the one coalesced into). */
  name?: string | null;
  reason?: ComputerBackupReason | null;
  /** More provider work (capture/cleanup) waits for tick(); storage-derived, never a provider read. */
  work?: boolean;
}
export interface ComputerBackupBegin {
  requestId: string;
  machine: { id: string; account: string; status: string };
  /** A verified environment fingerprint, or null/absent when unknown (then only time coalescing applies). */
  environmentRevision?: string | null;
}
export interface ComputerBackupHook {
  begin(ownerTag: string, req: ComputerBackupBegin): Promise<ComputerBackupStatus>;
  tick(ownerTag: string): Promise<ComputerBackupStatus>;
  status(ownerTag: string): Promise<ComputerBackupStatus | null>;
}

// ---- injected dependencies ----

/** Daytona SnapshotDto subset. Absent fields are treated as unknown, never as proof. */
export interface BackupSnapshotInfo {
  id?: string; name?: string; state?: string; sourceSandboxId?: string | null; general?: boolean;
  createdAt?: string; errorReason?: string | null;
}
/** Errors carry an HTTP `status` (0/none = no answer). 4xx other than 408/429 is a definite refusal; the rest is unknown. */
export interface BackupProvider {
  /** null = 404 absent; a rejection = unknown. */
  getSnapshot(account: string, nameOrId: string): Promise<BackupSnapshotInfo | null>;
  createSnapshot(account: string, machineId: string, name: string, opts: { includeMemory: false }): Promise<void>;
  /** DELETE /snapshots/{id}; 'accepted' (200) is not completion, 'absent' = 404. */
  removeSnapshot(account: string, id: string): Promise<'accepted' | 'absent'>;
}
/** Private persistent store (a DO's ctx.storage fits). One record per owner tag. */
export interface BackupStore { get(key: string): Promise<unknown>; put(key: string, value: unknown): Promise<void> }
export interface BackupDeps {
  store: BackupStore;
  provider: BackupProvider;
  now(): number;
  /** [0,1), e.g. Math.random or a crypto-backed equivalent. */
  random(): number;
  /** Names/ids that must never be deleted right now (selected template, prepared images, manual captures, the
   *  current machine's template). Read just before every delete; a rejection skips deletion for this tick. */
  protectedNames(ownerTag: string): Promise<Iterable<string>> | Iterable<string>;
}

// ---- ledger ----

type ItemState =
  | 'intent' | 'requested' | 'unknown' | 'snapshotting' | 'active' | 'failed_resource' | 'stale'
  | 'deleting' | 'delete_blocked' | 'unproven' | 'foreign' | 'unconfirmed';
interface Item {
  name: string; id: string | null; account: string; machineId: string; requestId: string; revision: string | null;
  state: ItemState; intentAt: number; requestedAt: number | null; activeAt: number | null;
  polls: number; absent: number; deletes: number; deleteAt: number | null; why: ComputerBackupReason | null;
}
/** 'not_applied' is read from older ledgers only; an unknown create is never closed that way any more. */
/** 'gone': a proven-own capture that a read by its id later found absent before this ledger retired it (never claimed saved). */
type DoneOutcome = 'removed' | 'not_applied' | 'refused' | 'collision' | 'skipped' | 'gone';
interface Done { name: string; id: string | null; outcome: DoneOutcome; why: ComputerBackupReason | null; at: number }
interface Receipt { requestId: string; key: string; at: number; item: string | null; result: ComputerBackupStatus; final: boolean }
interface Ledger { v: 1; owner: string; items: Item[]; done: Done[]; begins: Receipt[]; creates: number[] }

export interface ComputerBackupItemView {
  name: string; account: string; machineId: string; state: ItemState; intentAt: number; activeAt: number | null;
  revision: string | null; reason: ComputerBackupReason | null;
}
export interface ComputerBackupSummary {
  items: ComputerBackupItemView[];
  /** Provider resources this ledger owns or may own (deleting/unknown included); history is not counted. */
  owned: number; limits: typeof BACKUP_LIMITS;
  blocked: ComputerBackupReason | null;
  /** Snapshot size units are undocumented: never estimated, no cost/quota figure is derived. */
  usage: 'unknown';
}

const INFLIGHT: ItemState[] = ['intent', 'requested', 'unknown', 'snapshotting'];
const BLOCKING: ItemState[] = ['stale', 'delete_blocked', 'unproven', 'foreign', 'unconfirmed'];
const status = (state: ComputerBackupState, name: string | null = null, reason: ComputerBackupReason | null = null): ComputerBackupStatus =>
  ({ state, name, reason });
const definite = (e: unknown) => {
  const s = (e as { status?: unknown })?.status;
  return typeof s === 'number' && s >= 400 && s < 500 && s !== 408 && s !== 429;
};
const httpStatus = (e: unknown) => { const s = (e as { status?: unknown })?.status; return typeof s === 'number' ? s : 0; };

export class ComputerBackups implements ComputerBackupHook {
  constructor(private d: BackupDeps) {}

  async begin(ownerTag: string, req: ComputerBackupBegin): Promise<ComputerBackupStatus> {
    const m = req?.machine, rev = req?.environmentRevision ?? null;
    if (!OWNER_TAG.test(ownerTag ?? '') || typeof req?.requestId !== 'string' || !REQUEST_ID.test(req.requestId)
      || !m || typeof m.id !== 'string' || !MACHINE_ID.test(m.id) || typeof m.account !== 'string' || !ACCOUNT.test(m.account)
      || typeof m.status !== 'string' || (rev !== null && (typeof rev !== 'string' || !rev || rev.length > 128))) return status('failed', null, 'bad_request');
    const l: Ledger = await this.load(ownerTag) ?? { v: 1, owner: ownerTag, items: [], done: [], begins: [], creates: [] };
    const key = JSON.stringify([m.id, m.account, m.status, rev]);
    const seen = l.begins.find((b) => b.requestId === req.requestId);
    if (seen) return seen.key === key ? this.view(l, seen) : status('failed', null, 'request_conflict');

    const now = this.d.now();
    const r: Receipt = { requestId: req.requestId, key, at: now, item: null, result: status('blocked'), final: true };
    const blocked = this.blocked(l), inflight = l.items.find((i) => INFLIGHT.includes(i.state));
    const latest = l.items.filter((i) => i.state === 'active' && i.account === m.account && i.machineId === m.id)
      .sort((a, b) => b.intentAt - a.intentAt)[0];
    l.creates = l.creates.filter((t) => t > now - 86_400_000);
    if (m.status !== 'stopped') r.result = status('blocked', null, 'not_stopped');
    else if (blocked) r.result = status('blocked', null, blocked);
    else if (inflight) {
      if (inflight.account === m.account && inflight.machineId === m.id) { r.item = inflight.name; r.final = false; }
      else r.result = status('blocked', inflight.name, 'busy');
    }
    // A known identical verified revision may dedupe; an unknown one never claims "unchanged", only time coalescing.
    else if (latest && rev !== null && latest.revision === rev) r.result = status('coalesced', latest.name, 'unchanged');
    else if (latest && now - latest.intentAt < BACKUP_LIMITS.minIntervalMs) r.result = status('coalesced', latest.name, 'recent');
    else if (l.creates.length >= BACKUP_LIMITS.maxNewPerDay) r.result = latest ? status('coalesced', latest.name, 'daily_limit') : status('blocked', null, 'daily_limit');
    else {
      const name = this.newName(ownerTag, now, l);
      l.items.push({ name, id: null, account: m.account, machineId: m.id, requestId: req.requestId, revision: rev, state: 'intent',
        intentAt: now, requestedAt: null, activeAt: null, polls: 0, absent: 0, deletes: 0, deleteAt: null, why: null });
      l.creates.push(now);
      r.item = name; r.final = false;
    }
    l.begins.push(r);
    if (l.begins.length > BACKUP_LIMITS.receipts) l.begins.splice(0, l.begins.length - BACKUP_LIMITS.receipts);
    await this.save(l);
    return this.view(l, r);
  }

  async status(ownerTag: string): Promise<ComputerBackupStatus | null> {
    const l = OWNER_TAG.test(ownerTag ?? '') ? await this.load(ownerTag) : null;
    const r = l?.begins.at(-1);
    return l && r ? this.view(l, r) : null;
  }

  /** Storage only: the owned items for an owner page or the root's diagnostics. */
  async summary(ownerTag: string): Promise<ComputerBackupSummary | null> {
    const l = OWNER_TAG.test(ownerTag ?? '') ? await this.load(ownerTag) : null;
    if (!l) return null;
    return {
      items: l.items.map((i) => ({ name: i.name, account: i.account, machineId: i.machineId, state: i.state, intentAt: i.intentAt,
        activeAt: i.activeAt, revision: i.revision, reason: i.why })),
      owned: this.owned(l), limits: BACKUP_LIMITS, blocked: this.blocked(l), usage: 'unknown',
    };
  }

  /** Alarm only: advances captures, reconciles unknown outcomes, and applies retention. Bounded provider calls. */
  async tick(ownerTag: string): Promise<ComputerBackupStatus> {
    const l = OWNER_TAG.test(ownerTag ?? '') ? await this.load(ownerTag) : null;
    if (!l) return status('blocked', null, 'no_backup');
    const ops = { n: 0 };
    // A persisted 'requested' means the create never answered in its instance: reconcile it, never resubmit.
    for (const i of l.items) if (i.state === 'requested') i.state = 'unknown';
    for (const i of [...l.items]) {
      if (ops.n >= BACKUP_LIMITS.tickOps) break;
      if (['unknown', 'snapshotting', 'stale', 'unproven'].includes(i.state)) await this.reconcileCreate(l, i, ops);
      else if (i.state === 'deleting' || i.state === 'delete_blocked') await this.reconcileDelete(l, i, ops);
    }
    await this.retain(l, ops);
    const intent = l.items.find((i) => i.state === 'intent');
    if (intent && ops.n < BACKUP_LIMITS.tickOps) await this.create(l, intent, ops);
    await this.save(l);
    const r = l.begins.at(-1);
    return r ? this.view(l, r) : status('blocked', null, 'no_backup');
  }

  /** Explicit owner/root action only, never the alarm: one read by exact name per 'unconfirmed' create. Strict ownership
   *  proof recovers it; a 404 or an error keeps it owned and blocking. Never creates, deletes or drops anything. */
  async reconcile(ownerTag: string): Promise<ComputerBackupStatus> {
    const l = OWNER_TAG.test(ownerTag ?? '') ? await this.load(ownerTag) : null;
    if (!l) return status('blocked', null, 'no_backup');
    const ops = { n: 0 };
    for (const i of l.items.filter((x) => x.state === 'unconfirmed')) {
      if (ops.n >= BACKUP_LIMITS.tickOps) break;
      await this.reconcileCreate(l, i, ops);
    }
    await this.save(l);
    const r = l.begins.at(-1);
    return r ? this.view(l, r) : status('blocked', null, 'no_backup');
  }

  // ---- create ----

  private async create(l: Ledger, i: Item, ops: { n: number }) {
    const blocked = this.blocked(l);
    if (blocked) return this.drop(l, i, 'skipped', blocked);
    if (this.owned(l) >= BACKUP_LIMITS.maxOwned) {
      if (++i.polls > BACKUP_LIMITS.intentPolls) this.drop(l, i, 'skipped', 'retention_blocked');
      return;
    }
    // Preflight the exact generated name: an existing one is never adopted, and never deleted.
    let existing; ops.n++;
    try { existing = await this.d.provider.getSnapshot(i.account, i.name); }
    catch { if (++i.polls > BACKUP_LIMITS.intentPolls) this.drop(l, i, 'skipped', 'timeout'); return; }
    if (existing) return this.drop(l, i, 'collision', 'name_collision');
    i.state = 'requested'; i.requestedAt = this.d.now(); i.polls = 0;
    await this.save(l); // intent before the mutation
    ops.n++;
    try { await this.d.provider.createSnapshot(i.account, i.machineId, i.name, { includeMemory: false }); i.state = 'snapshotting'; }
    catch (e) {
      if (definite(e) && httpStatus(e) === 409) this.drop(l, i, 'collision', 'name_collision');
      else if (definite(e)) this.drop(l, i, 'refused', 'provider_refused');
      else i.state = 'unknown';
    }
  }

  private async reconcileCreate(l: Ledger, i: Item, ops: { n: number }) {
    let info: BackupSnapshotInfo | null | undefined; ops.n++;
    try { info = await this.d.provider.getSnapshot(i.account, i.id ?? i.name); } catch { info = undefined; }
    i.polls++;
    if (info === undefined) { if (i.polls >= BACKUP_LIMITS.createPolls && INFLIGHT.includes(i.state)) this.mark(i, 'stale', 'timeout'); return; }
    if (info === null) {
      // i.id is recorded only from a read that proved the capture ours, so a 404 by that exact id confirms it is gone (the
      // same rule as sendDelete): keep the receipt, free the slot, send nothing. Without a proven id a 404 proves nothing.
      if (i.id) return this.drop(l, i, 'gone', 'provider_error');
      if (i.state === 'active') { this.mark(i, 'unproven', 'ownership_unproven'); return; }
      // Absent so far is not proof an old create cannot still land: stop automatic reads, keep it owned and blocking.
      if (i.state !== 'unconfirmed' && ++i.absent >= BACKUP_LIMITS.reconcileAbsent) this.mark(i, 'unconfirmed', 'create_unconfirmed');
      return;
    }
    i.absent = 0;
    const own = this.ownership(l, i, info);
    if (own === 'foreign') return this.mark(i, 'foreign', 'foreign');
    if (own === 'ours') {
      i.id = info.id!;
      if (i.state === 'unconfirmed') { i.state = 'snapshotting'; i.why = null; i.polls = 0; } // proven: normal reads resume
    }
    if (info.state === 'active') return own === 'ours' ? this.mark(i, 'active', null, true) : this.mark(i, 'unproven', 'ownership_unproven');
    if (info.state === 'error' || info.state === 'build_failed') return own === 'ours' ? this.mark(i, 'failed_resource', 'provider_error') : this.mark(i, 'unproven', 'ownership_unproven');
    if (i.polls >= BACKUP_LIMITS.createPolls && INFLIGHT.includes(i.state)) this.mark(i, 'stale', 'timeout');
  }

  /** Exact name + id + source machine + private (general === false). Missing evidence is never proof. */
  private ownership(l: Ledger, i: Item, info: BackupSnapshotInfo): 'ours' | 'foreign' | 'unproven' {
    if (typeof info.name === 'string' && info.name !== i.name) return 'foreign';
    if (i.id && typeof info.id === 'string' && info.id !== i.id) return 'foreign';
    if (typeof info.sourceSandboxId === 'string' && info.sourceSandboxId && info.sourceSandboxId !== i.machineId) return 'foreign';
    if (info.general === true) return 'foreign';
    if (typeof info.id === 'string' && info.id && l.items.some((o) => o !== i && o.id === info.id)) return 'unproven'; // duplicate id
    return info.name === i.name && typeof info.id === 'string' && !!info.id && info.sourceSandboxId === i.machineId && info.general === false
      ? 'ours' : 'unproven';
  }

  // ---- retention / delete ----

  private async retain(l: Ledger, ops: { n: number }) {
    const active = l.items.filter((i) => i.state === 'active').sort((a, b) => (b.activeAt ?? 0) - (a.activeAt ?? 0));
    const newestPerAccount = new Set<Item>();
    for (const a of active) if (![...newestPerAccount].some((n) => n.account === a.account)) newestPerAccount.add(a);
    // Old verified backups go only after a newer one is verified; failed owned resources go whenever ownership is proven.
    const candidates = [
      ...l.items.filter((i) => i.state === 'failed_resource'),
      ...active.slice(BACKUP_LIMITS.retainVerified).filter((i) => i !== active[0] && !newestPerAccount.has(i)).reverse(),
    ];
    if (!candidates.length || ops.n >= BACKUP_LIMITS.tickOps) return;
    let guard: Set<string>;
    try { guard = new Set(await this.d.protectedNames(l.owner)); } catch { return; }
    for (const i of candidates) {
      if (ops.n >= BACKUP_LIMITS.tickOps) return;
      if (guard.has(i.name) || (i.id && guard.has(i.id))) continue;
      await this.sendDelete(l, i, ops);
    }
  }

  /** Fresh read by id, full ownership proof, persist intent, then one DELETE. */
  private async sendDelete(l: Ledger, i: Item, ops: { n: number }) {
    if (!i.id) return this.mark(i, 'unproven', 'ownership_unproven');
    let info; ops.n++;
    try { info = await this.d.provider.getSnapshot(i.account, i.id); } catch { return; }
    if (info === null) return this.drop(l, i, 'removed', null); // 404 by id confirms it is gone
    const own = this.ownership(l, i, info);
    if (own !== 'ours') return this.mark(i, own === 'foreign' ? 'foreign' : 'unproven', own === 'foreign' ? 'foreign' : 'ownership_unproven');
    if (info.state === 'removing') { i.state = 'deleting'; i.deleteAt ??= this.d.now(); return; }
    if (i.deletes >= BACKUP_LIMITS.deleteSends) return this.mark(i, 'delete_blocked', 'cleanup_blocked');
    if (i.state !== 'deleting') i.polls = 0;
    i.state = 'deleting'; i.deletes++; i.deleteAt = this.d.now();
    await this.save(l); // intent before the mutation
    ops.n++;
    try { await this.d.provider.removeSnapshot(i.account, i.id); } // 'accepted'/'absent' alike: a later GET 404 confirms
    catch (e) { if (definite(e) && httpStatus(e) !== 404) this.mark(i, 'delete_blocked', 'cleanup_blocked'); }
  }

  private async reconcileDelete(l: Ledger, i: Item, ops: { n: number }) {
    if (!i.id) return this.mark(i, 'unproven', 'ownership_unproven');
    let info; ops.n++;
    try { info = await this.d.provider.getSnapshot(i.account, i.id); }
    catch { if (++i.polls >= BACKUP_LIMITS.deletePolls) this.mark(i, 'delete_blocked', 'cleanup_blocked'); return; }
    if (info === null) return this.drop(l, i, 'removed', null);
    const own = this.ownership(l, i, info);
    if (own !== 'ours') return this.mark(i, own === 'foreign' ? 'foreign' : 'unproven', own === 'foreign' ? 'foreign' : 'ownership_unproven');
    if (i.state === 'delete_blocked') return; // re-read only: a confirmed 404 above is the only way out
    if (info.state === 'removing') { if (++i.polls >= BACKUP_LIMITS.deletePolls) this.mark(i, 'delete_blocked', 'cleanup_blocked'); return; }
    // Still present and not removing: the DELETE did not take. Re-send (bounded) only after a fresh protection check.
    let guard: Set<string>;
    try { guard = new Set(await this.d.protectedNames(l.owner)); } catch { return; }
    if (guard.has(i.name) || guard.has(i.id)) return this.mark(i, 'delete_blocked', 'cleanup_blocked');
    await this.sendDelete(l, i, ops);
  }

  // ---- helpers ----

  private mark(i: Item, state: ItemState, why: ComputerBackupReason | null, verified = false) {
    i.state = state; i.why = why;
    if (verified) { i.activeAt ??= this.d.now(); i.polls = 0; }
  }

  private drop(l: Ledger, i: Item, outcome: DoneOutcome, why: ComputerBackupReason | null) {
    l.items = l.items.filter((x) => x !== i);
    l.done.push({ name: i.name, id: i.id, outcome, why, at: this.d.now() });
    if (l.done.length > BACKUP_LIMITS.receipts) l.done.splice(0, l.done.length - BACKUP_LIMITS.receipts);
  }

  /** Provider resources that exist or may exist (an intent has not been sent; a foreign one is not ours). */
  private owned(l: Ledger) { return l.items.filter((i) => i.state !== 'intent' && i.state !== 'foreign').length; }

  private blocked(l: Ledger): ComputerBackupReason | null {
    const b = l.items.find((i) => BLOCKING.includes(i.state));
    return !b ? null : b.state === 'foreign' ? 'foreign' : b.state === 'unproven' ? 'ownership_unproven'
      : b.state === 'unconfirmed' ? 'create_unconfirmed' : 'cleanup_blocked';
  }

  private work(l: Ledger) {
    const active = l.items.filter((i) => i.state === 'active').length;
    return l.items.some((i) => !['active', 'foreign', 'delete_blocked', 'unconfirmed'].includes(i.state)) || active > BACKUP_LIMITS.retainVerified;
  }

  private itemStatus(l: Ledger, name: string): ComputerBackupStatus {
    const i = l.items.find((x) => x.name === name);
    if (i) {
      switch (i.state) {
        case 'intent': case 'requested': case 'snapshotting': return status('pending', name);
        case 'unknown': return status('unknown', name);
        case 'unconfirmed': return status('unknown', name, 'create_unconfirmed');
        case 'active': case 'deleting': case 'delete_blocked': return status('active', name);
        case 'failed_resource': return status('failed', name, 'provider_error');
        case 'stale': return status('failed', name, 'timeout');
        case 'unproven': return status('blocked', name, 'ownership_unproven');
        case 'foreign': return status('blocked', name, 'foreign');
      }
    }
    const d = l.done.find((x) => x.name === name);
    if (d?.outcome === 'removed') return status('active', name); // verified once, later retired by retention
    if (d?.outcome === 'skipped') return status('blocked', name, d.why);
    return status('failed', name, d?.why ?? 'not_applied');
  }

  private view(l: Ledger, r: Receipt): ComputerBackupStatus {
    const s = r.final || !r.item ? r.result : this.itemStatus(l, r.item);
    return { ...s, work: this.work(l) };
  }

  private newName(ownerTag: string, now: number, l: Ledger) {
    const time = Math.max(0, Math.floor(now / 1000)).toString(36);
    for (let k = 0; k < 16; k++) {
      let rnd = ''; while (rnd.length < 6) rnd += Math.floor(this.d.random() * 36).toString(36);
      const name = `${BACKUP_PREFIX}-${ownerTag.slice(0, NAME_OWNER)}-${time}-${rnd.slice(0, 6)}`;
      if (SNAPSHOT_NAME.test(name) && !l.items.some((i) => i.name === name) && !l.done.some((d) => d.name === name)) return name;
    }
    throw new Error('backup name generation failed');
  }

  private async load(ownerTag: string): Promise<Ledger | null> {
    const raw = await this.d.store.get(KEY(ownerTag));
    if (!raw) return null;
    const l = JSON.parse(JSON.stringify(raw)) as Ledger;
    if (l.v !== 1 || l.owner !== ownerTag) throw new Error('backup ledger owner mismatch'); // never reuse another owner's record
    return l;
  }

  private async save(l: Ledger) {
    // Freeze receipts whose answer can no longer change, so trimming items/done never rewrites a replay.
    for (const r of l.begins) if (!r.final && r.item) {
      const s = this.itemStatus(l, r.item);
      if (s.state !== 'pending' && s.state !== 'unknown') { r.result = s; r.final = true; }
    }
    await this.d.store.put(KEY(l.owner), l);
  }
}
