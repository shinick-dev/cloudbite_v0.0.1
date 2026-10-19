// CloudbiteComputer DO: the single owner machine record, its lifecycle ledger and desktop capabilities.
// Rules: the ledger is written before every cloud mutation; an unconfirmed outcome becomes `unknown` and is reconciled by
// exact name + labels, never retried blindly; accounts never switch; stop keeps the filesystem; GET/state never mutates cloud
// resources. Long work (start, snapshot, resize) is polled by the DO alarm, never held in one Worker request. A hot resize only
// increases CPU/RAM of the running machine (processes, desktop sessions and snapshots stay); it is pending until a later GET
// observes the new allocation, and an unanswered request is reconciled by GET, never re-sent.
// Own captures are kept in a bounded history; one verified active capture may be selected as the template of a FUTURE new
// machine (same account, machine absent, re-checked active right before create). Selection never touches the current machine.
// Safe end (opt-in): POST end stores phase `draining` and returns; the alarm drains managed files (files_verified) or flushes the
// disk (disk_backup), stops with the disk kept, then hands a private cold capture to the injected backups manager. A session
// deadline never extends paid compute: it stops with the disk kept and records files as pending. Nothing is ever deleted here.
import { DurableObject } from 'cloudflare:workers';
import { COMPUTER_PROBE_COMMAND, computerToolCatalog, parseComputerProbe, type ComputerProbe } from './cloudbite-computer-tools';
import type { Dt } from './lab';
import {
  COMPUTER_ACCOUNTS, COMPUTER_AUTO_STOP_MINUTES, COMPUTER_SNAPSHOT_HISTORY_MAX, COMPUTER_DESKTOP_HEALTH, COMPUTER_DESKTOP_PATH, COMPUTER_DESKTOP_PORT,
  COMPUTER_OWNER_TAG, COMPUTER_POLL_MS, COMPUTER_REQUEST_ID, COMPUTER_SESSION_MS, COMPUTER_SNAPSHOT_NAME, COMPUTER_START_SCRIPT,
  COMPUTER_TICKET_MS, COMPUTER_TICKET_PARAM, ComputerError, computerAccounts, computerDrainVerified, computerErrorBody, computerLabels, computerName,
  computerProxySuffixes, isAccount, isEndMode,
  type ComputerBackupStatus, type ComputerDrainReport, type ComputerDrainResult, type ComputerEndBackup, type ComputerEndFiles, type ComputerEndMode,
  type ComputerEndPhase, type ComputerEndState, type ComputerEndTrigger, type ComputerEndView,
  type ComputerAccount, type ComputerAccountConfig, type ComputerEnv, type ComputerErrorCode, type ComputerMachineRef, type ComputerSnapshotView,
  type ComputerPerformance, type ComputerSnapshotHistoryState, type ComputerSnapshots, type ComputerState, type ComputerStatus, type DesktopStatus,
} from './cloudbite-computer-contract';
import { ComputerDaytonaError, computerUpstreamOrigin, restDaytona, type ComputerDaytona, type ComputerSandbox, type ComputerSnapshotInfo } from './cloudbite-computer-daytona';
import {
  COMPUTER_METRICS_CACHE_MS, COMPUTER_METRICS_COMMAND, COMPUTER_METRICS_TIMEOUT_S, COMPUTER_PRICING, computerHourlyCost, computerPlans,
  isComputerPlan, parseComputerMetrics, type ComputerMetrics,
} from './cloudbite-computer-performance';

export interface ComputerStore {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  setAlarm(at: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}
/** Backups manager seen from the end flow. begin is idempotent per requestId; tick runs from the alarm only; status reads storage only. */
export interface ComputerBackupHook {
  begin(ownerTag: string, req: { requestId: string; machine: { id: string; account: ComputerAccount; status: ComputerStatus }; environmentRevision: string | null }): Promise<ComputerBackupStatus>;
  tick(ownerTag: string): Promise<ComputerBackupStatus>;
  status(ownerTag: string): Promise<ComputerBackupStatus | null>;
}
/**
 * Injected by root. They run inside this DO's serial queue, so they must never call back into ComputerService/DO methods.
 * drain: combined agent prepare-end --flush + watcher report on the running owned machine (no start/stop).
 * resume: leaves draining. Called when an end is blocked or cancelled and the machine keeps running, and, because the agent
 * and the watcher keep draining across restarts, once the SAME drained machine is next observed running after a later start
 * (alarm only, bounded tries per run, retained across DO restarts until one call succeeds). A configured watcher dies with
 * any stop, so an authorized start of the owned stopped machine also owes one resume of that run (same alarm path; requestId =
 * the start's, or the earlier owed one). It must be idempotent.
 */
export interface ComputerEndHooks {
  drain?(machine: ComputerMachineRef, requestId: string): Promise<ComputerDrainResult>;
  resume?(machine: ComputerMachineRef, requestId: string): Promise<void>;
  backup?: ComputerBackupHook;
}
export interface ComputerDeps {
  store: ComputerStore; env: ComputerEnv; daytona: ComputerDaytona;
  now: () => number; random: (n: number) => Uint8Array; sha256: (s: string) => Promise<string>;
  end?: ComputerEndHooks;
}

export type ComputerResult<T = Record<never, never>> = ({ ok: true } & T) | { error: { code: ComputerErrorCode; message: string }; status: number };

interface Machine {
  account: ComputerAccount; name: string; id: string | null;
  created: 'pending' | 'unknown' | 'owned';
  region: string | null; cpu: number | null; memoryGiB: number | null; diskGiB: number | null;
  sandbox?: { toolboxProxyUrl?: string };
  /** Own capture this machine was created from; null/absent = the prepared image. */
  template?: string | null;
}
/** requestId ledger entry: `fp` binds the id to its arguments; `error` is the definite refusal replayed for that id. */
interface Op { id: string; kind: string; fp?: string; error?: { code: ComputerErrorCode; status: number } }
/** A capture is ours only if Daytona names our sandbox as its source, or it appeared after our preflight saw the name free. */
interface SnapshotRec extends ComputerSnapshotView { polls: number; requestedAt?: number; sourceId?: string; preflightAbsent?: boolean; account?: ComputerAccount }
/** One own capture in the bounded history. `mirror` is the last latest-capture state copied in, so a GET re-check is not overwritten. */
interface SnapHist {
  name: string; account: ComputerAccount; sourceId: string; requestedAt: number; state: ComputerSnapshotHistoryState;
  error: ComputerErrorCode | null; checkedAt: number | null; mirror?: string;
}
/** The selected template of a future new machine; requestedAt pins it to one capture even if the name is later reused. */
interface Template { account: ComputerAccount; name: string; requestedAt: number }
/** One hot CPU/RAM increase. requesting = written before the POST; unknown = unanswered; pending = answered, not yet observed. */
interface ResizeRec { cpu: number; memoryGiB: number; state: 'requesting' | 'unknown' | 'pending' | 'done' | 'failed'; error: ComputerErrorCode | null; polls: number }
/** Last cgroup sample of one machine run; a null sample is cached too, so a failing sample is not retried in a burst. */
interface PerfRec { at: number; machineId: string; epoch: number; metrics: ComputerMetrics | null }
/**
 * One safe end. stopAt: a deadline-triggered end stops then at the latest, verified or not. drains/stops/polls bound every
 * outbound step; report is the last drain answer (sanitised). backup mirrors the manager; it never claims files saved.
 */
interface EndRec {
  requestId: string; mode: ComputerEndMode; trigger: ComputerEndTrigger; phase: ComputerEndPhase;
  files: ComputerEndFiles; filesVerifiedAt: number | null; report: ComputerDrainReport | null; drains: number; drainAt: number | null;
  stopAt: number | null; flushed: boolean | null; stops: number; polls: number; machineStopped: boolean;
  backup: ComputerEndBackup; backupName: string | null; error: ComputerErrorCode | null; startedAt: number; updatedAt: number;
  /** The manager still has work (e.g. retention after a new backup turned active); ticked after `done`, at most workPolls. */
  backupWork?: boolean; workPolls?: number;
}
/** A drain left the agent/watcher of this machine draining: resume is owed until one resume call succeeds. Survives new ends. */
interface ResumeRec { requestId: string; machineId: string; tries: number; epoch: number; at: number | null }
interface Rec {
  ownerTag: string | null;
  machine: Machine | null;
  status: ComputerStatus; error: ComputerErrorCode | null;
  sessionEndsAt: number | null;
  snapshot: SnapshotRec | null;
  snapshots?: SnapHist[];
  template?: Template | null;
  desktop: DesktopStatus; desktopLaunches: number; desktopLaunchAt: number | null;
  /** Bumped whenever a machine run ends: previews, cookies and probes of an earlier run are stale. */
  desktopEpoch: number;
  probe?: ComputerProbe | null; probeEpoch?: number | null; probeTries?: number;
  reconcilePolls: number;
  resize?: ResizeRec | null;
  perf?: PerfRec | null;
  end?: EndRec | null;
  resume?: ResumeRec | null;
  /** Definite provider refusals of the stop since the last answered stop/start; the deadline is kept while this is bounded. */
  stopRefusals?: number;
  /** Owner opt-in: start this kind of safe end shortly before the session deadline. Absent = the plain deadline stop. */
  autoEnd?: ComputerEndMode | null;
  ops: Op[];
  tickets: Array<{ h: string; exp: number }>;
  sessions: Array<{ h: string; exp: number }>;
}
/** Kept under its own key so the gateway hot path can refresh it without the mutation queue. */
interface Preview { origin: string; token: string; exp: number; machineId: string; epoch: number }

const KEY = 'computer', PREVIEW_KEY = 'computer-preview';
const OPS_MAX = 64, TICKETS_MAX = 8, SESSIONS_MAX = 8, RECONCILE_MAX = 30, SNAPSHOT_MAX_POLLS = 360, DESKTOP_LAUNCH_MAX = 3, PROBE_TRIES = 3;
const PREVIEW_MS = 10 * 60 * 1000, SNAPSHOT_SKEW_MS = 60_000, PROBE_TIMEOUT_S = 60;
const SNAPSHOT_BUSY = ['waiting_stop', 'requesting', 'unknown', 'snapshotting'];
const RESIZE_PENDING = ['requesting', 'unknown', 'pending'];
const RESIZE_MAX_POLLS = 60; // answered increase: about 10 minutes of alarms before it is reported unconfirmed
const RESIZE_KEYS = new Set(['requestId', 'cpu', 'memoryGiB', 'acknowledgeCost']);
const SELECT_KEYS = new Set(['requestId', 'account', 'name']);
const END_KEYS = new Set(['requestId', 'mode']), END_SETTINGS_KEYS = new Set(['requestId', 'autoEnd']);
const END_ACTIVE: ComputerEndPhase[] = ['draining', 'stopping', 'backing_up'];
const BACKUP_DONE: ComputerEndBackup[] = ['active', 'coalesced', 'failed', 'blocked'];
// User end: up to 12 drains 10 s apart (~2 min) before it is blocked. Stop: 2 sends at most, ~10 min to observe it.
// Backup: ~1 h of alarms. Opted-in owners get the deadline end 5 min before the session ends; it stops at the deadline.
// Owed resume: at most 6 calls per machine run, 10 s apart. A refused stop keeps the deadline for at most 3 refusals.
const RESUME_TRIES = 6, STOP_REFUSALS_MAX = 3;
const END_DRAIN_TRIES = 12, END_STOP_TRIES = 2, END_STOP_MAX_POLLS = 60, END_BACKUP_MAX_POLLS = 360, END_PREEXPIRY_MS = 5 * 60_000, END_FLUSH_TIMEOUT_S = 30;
const DRAIN_COUNTS = ['dirty', 'uploading', 'conflict', 'unconfirmedOps', 'open', 'pendingDeletions', 'errors'] as const;
const RECHECK_MS = 60_000, RECHECK_MAX = 3; // explicit GET: at most 3 active captures re-read, each at most once a minute
const LABELS: Record<ComputerAccount, string> = { primary: 'Primary', secondary: 'Secondary', tertiary: 'Tertiary' };
const WAKING = new Set(['creating', 'starting', 'restoring', 'pulling_snapshot', 'pending_build', 'building_snapshot', 'resuming']);

const fresh = (): Rec => ({ ownerTag: null, machine: null, status: 'absent', error: null, sessionEndsAt: null, snapshot: null,
  desktop: 'not_running', desktopLaunches: 0, desktopLaunchAt: null, desktopEpoch: 0, reconcilePolls: 0, ops: [], tickets: [], sessions: [] });

const fail = (code: ComputerErrorCode, status = 409): ComputerResult<never> => ({ ...computerErrorBody(code), status });
const COOKIE_RE = /^[A-Za-z0-9_-]{43}$/;
const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function mapProviderState(s: string | undefined): ComputerStatus {
  if (s === 'started' || s === 'resizing') return 'running'; // a hot resize keeps the machine and its processes running
  if (s === 'stopped' || s === 'archived') return 'stopped';
  if (s === 'stopping' || s === 'archiving') return 'stopping';
  if (s === 'snapshotting') return 'snapshotting';
  if (s === 'error' || s === 'build_failed') return 'error';
  if (s && WAKING.has(s)) return 'starting';
  return 'unknown';
}

export class ComputerService {
  private queue: Promise<unknown> = Promise.resolve();
  /** In-flight preview lookups per machine run, so a burst of gateway requests makes one provider call. */
  private previewing = new Map<string, Promise<Preview | null>>();
  constructor(private d: ComputerDeps) {}

  /** One operation at a time: outbound fetches would otherwise let a stop interleave with a start. */
  private serial<T>(f: () => Promise<T>): Promise<T> {
    const r = this.queue.then(f, f);
    this.queue = r.catch(() => {});
    return r;
  }
  private async load(): Promise<Rec> { const r = { ...fresh(), ...(await this.d.store.get<Rec>(KEY)) }; this.track(r); return r; }
  private save(r: Rec) { this.track(r); return this.d.store.put(KEY, r); }
  private account(id: ComputerAccount): ComputerAccountConfig | null { return computerAccounts(this.d.env).find((a) => a.id === id) ?? null; }
  private dt(a: ComputerAccountConfig): Dt { return { api: a.api, key: a.key }; }

  view(r: Rec): ComputerState {
    const configured = computerAccounts(this.d.env);
    const m = r.machine;
    return {
      status: r.status, error: r.error,
      machine: m ? { id: m.id, name: m.name, account: m.account, region: m.region, cpu: m.cpu, memoryGiB: m.memoryGiB, diskGiB: m.diskGiB } : null,
      sessionEndsAt: r.sessionEndsAt ? new Date(r.sessionEndsAt).toISOString() : null,
      snapshot: r.snapshot ? { name: r.snapshot.name, state: r.snapshot.state, error: r.snapshot.error } : null,
      desktop: r.desktop,
      configuredAccounts: COMPUTER_ACCOUNTS.map((id) => ({ id, label: LABELS[id], available: configured.some((a) => a.id === id) })),
      ready: r.status === 'running' && r.desktop === 'ready',
      tools: computerToolCatalog(r.probe ?? null),
      template: r.template ? { account: r.template.account, name: r.template.name } : null,
      end: r.end ? this.endView(r.end) : null,
    };
  }

  private endView(e: EndRec): ComputerEndView {
    const iso = (t: number) => new Date(t).toISOString();
    return {
      requestId: e.requestId, mode: e.mode, trigger: e.trigger, phase: e.phase, files: e.files,
      filesVerifiedAt: e.filesVerifiedAt === null ? null : iso(e.filesVerifiedAt), filesDetail: e.report, diskFlushed: e.flushed,
      machineStopped: e.machineStopped, environmentBackup: e.backup, backupName: e.backupName, error: e.error,
      startedAt: iso(e.startedAt), updatedAt: iso(e.updatedAt),
    };
  }

  private endState(r: Rec): ComputerEndState {
    const h = this.d.end;
    return {
      end: r.end ? this.endView(r.end) : null, autoEnd: r.autoEnd ?? null,
      modes: { disk_backup: true, files_verified: !!h?.drain }, backupConfigured: !!h?.backup,
      uploadsFrozen: !!r.end && (r.end.phase === 'draining' || r.end.phase === 'stopping'),
    };
  }

  /**
   * Mirror the latest capture into the history once its request was sent (sourceId recorded). Legacy records without an
   * account are attributed only when their source is the current machine. A collision is never our capture: it is dropped.
   */
  private track(r: Rec) {
    const list = (r.snapshots ??= []);
    const s = r.snapshot;
    if (s?.sourceId && s.requestedAt) {
      const account = s.account ?? (r.machine?.id === s.sourceId ? r.machine.account : null);
      let h = account ? list.find((x) => x.account === account && x.name === s.name) ?? null : null;
      if (h && h.requestedAt !== s.requestedAt) { this.dropHist(r, h); h = null; } // the name was reused by a newer capture
      if (account && s.error === 'snapshot_exists') { if (h) this.dropHist(r, h); }
      else if (account) {
        const mirror = `${s.state}:${s.error ?? ''}`;
        const state: ComputerSnapshotHistoryState = s.state === 'waiting_stop' ? 'requesting' : s.state;
        if (!h) (r.snapshots ??= []).unshift({ name: s.name, account, sourceId: s.sourceId, requestedAt: s.requestedAt, state, error: s.error as ComputerErrorCode | null, checkedAt: null, mirror });
        else if (h.mirror !== mirror) { h.state = state; h.error = s.error as ComputerErrorCode | null; h.mirror = mirror; }
      }
    }
    if (r.template && !this.template(r)) r.template = null;
    // Bounded: the oldest unselected entries go first; the selected template is never dropped by the bound.
    const all = r.snapshots ?? [];
    for (let i = all.length - 1; all.length > COMPUTER_SNAPSHOT_HISTORY_MAX && i >= 0; i--) if (!this.isTemplate(r, all[i])) all.splice(i, 1);
  }
  private isTemplate(r: Rec, h: SnapHist) {
    const t = r.template;
    return !!t && t.account === h.account && t.name === h.name && t.requestedAt === h.requestedAt;
  }
  private template(r: Rec, account?: ComputerAccount): SnapHist | null {
    if (!r.template || (account && r.template.account !== account)) return null;
    return (r.snapshots ?? []).find((h) => this.isTemplate(r, h)) ?? null;
  }
  private dropHist(r: Rec, h: SnapHist) {
    if (this.isTemplate(r, h)) r.template = null;
    r.snapshots = (r.snapshots ?? []).filter((x) => x !== h);
  }

  /**
   * Fresh read-only check of one own capture. true = active and not proven foreign; false = definitely unusable now;
   * undefined = no answer (nothing is concluded). A proven foreign source removes the entry and marks the latest capture.
   */
  private async recheck(r: Rec, h: SnapHist): Promise<boolean | undefined> {
    const a = this.account(h.account); if (!a) return undefined;
    let info: ComputerSnapshotInfo | null;
    try { info = await this.d.daytona.getSnapshot(this.dt(a), h.name); } catch { return undefined; }
    h.checkedAt = this.d.now();
    if (!info) { h.state = 'missing'; h.error = 'snapshot_missing'; return false; }
    const src = info.sourceSandboxId;
    if (typeof src === 'string' && src && src !== h.sourceId) {
      const s = r.snapshot;
      if (s && s.name === h.name && s.requestedAt === h.requestedAt) { s.state = 'error'; s.error = 'snapshot_exists'; }
      this.dropHist(r, h);
      return false;
    }
    if (info.state === 'active') { h.state = 'active'; h.error = null; return true; }
    if (['error', 'build_failed'].includes(info.state ?? '')) { h.state = 'error'; h.error = 'provider_error'; }
    else { h.state = 'unknown'; h.error = null; }
    return false; // other provider states (pending, removing, ...) are not usable now
  }

  private snapshotsView(r: Rec): ComputerSnapshots {
    const t = this.template(r), m = r.machine;
    return {
      items: (r.snapshots ?? []).map((h) => ({
        name: h.name, account: h.account, requestedAt: new Date(h.requestedAt).toISOString(), state: h.state, error: h.error,
        checkedAt: h.checkedAt === null ? null : new Date(h.checkedAt).toISOString(), selected: h === t, selectable: h.state === 'active' && h !== t,
      })),
      selected: t ? { account: t.account, name: t.name } : null,
      latest: r.snapshot ? { name: r.snapshot.name, state: r.snapshot.state, error: r.snapshot.error } : null,
      machine: { status: r.status, account: m?.account ?? null, id: m?.id ?? null, template: m?.template ?? null },
      historyMax: COMPUTER_SNAPSHOT_HISTORY_MAX,
    };
  }

  private bind(r: Rec, ownerTag: string) {
    computerName(ownerTag, 'primary'); // validates the tag
    if (r.ownerTag && r.ownerTag !== ownerTag) throw new ComputerError('bad_request', 403);
    r.ownerTag = ownerTag;
  }

  /** Verified ownership: exact deterministic name and every owner label. */
  private owned(r: Rec, sb: ComputerSandbox | null): sb is ComputerSandbox {
    if (!sb || !r.machine || !r.ownerTag) return false;
    const want = computerLabels(r.ownerTag, r.machine.account);
    return (sb.name === undefined || sb.name === r.machine.name) && Object.entries(want).every(([k, v]) => sb.labels?.[k] === v);
  }

  /** The machine run ended: desktop cookies, tickets and the cached preview of that run are void. */
  private down(r: Rec) { r.sessions = []; r.tickets = []; r.desktopEpoch = (r.desktopEpoch ?? 0) + 1; }

  private adopt(r: Rec, sb: ComputerSandbox) {
    const m = r.machine!;
    m.id = sb.id; m.created = 'owned'; m.region = sb.target ?? m.region;
    m.cpu = sb.cpu ?? m.cpu; m.memoryGiB = sb.memory ?? m.memoryGiB; m.diskGiB = sb.disk ?? m.diskGiB;
    m.sandbox = { toolboxProxyUrl: sb.toolboxProxyUrl };
    const before = r.status;
    r.status = mapProviderState(sb.state);
    if (r.status === 'error') r.error = 'provider_error';
    else if (r.error === 'unknown_outcome' || r.error === 'provider_error') r.error = null;
    if (r.status !== 'running') { r.desktop = 'not_running'; if (before === 'running') this.down(r); }
    else if (r.desktop === 'not_running') r.desktop = 'starting';
  }

  /** Read-only provider refresh / reconcile (GET only). True only when this read observed our labelled machine. */
  private async refresh(r: Rec): Promise<boolean> {
    const m = r.machine; if (!m) return false;
    const a = this.account(m.account); if (!a) { r.error = 'not_configured'; return false; }
    let sb: ComputerSandbox | null;
    try { sb = await this.d.daytona.get(this.dt(a), m.id ?? m.name); }
    catch { if (m.created !== 'owned') r.status = 'unknown'; return false; }
    if (sb && this.owned(r, sb)) {
      const before = r.status;
      this.adopt(r, sb); r.reconcilePolls = 0; this.settleResize(r, sb);
      if (before === 'running' && (r.status === 'stopped' || r.status === 'stopping')) this.stoppedOutside(r);
      return true;
    }
    if (sb) { r.status = 'error'; r.error = 'provider_error'; return false; } // a same-named sandbox without our labels: never touch it
    if (m.created === 'owned') {
      r.machine = null; r.status = 'absent'; r.error = 'provider_error'; r.sessionEndsAt = null; r.desktop = 'not_running'; this.down(r);
      if (this.resizing(r)) r.resize = { ...r.resize!, state: 'failed', error: 'provider_error' };
      return false;
    }
    // Unknown create and nothing by that exact name yet: keep checking, then report without retrying.
    if (++r.reconcilePolls >= RECONCILE_MAX) { r.machine = null; r.status = 'absent'; r.error = 'unknown_outcome'; r.reconcilePolls = 0; }
    else r.status = 'unknown';
    return false;
  }

  /**
   * requestId ledger. The id is recorded with its arguments before the action runs, so it persists with the action's own
   * ledger write. A replay with the same arguments reads current state, or returns the original definite error; other
   * arguments are a conflict. An action that ends in unknown_outcome before accepting anything leaves no entry.
   */
  private async once<T>(r: Rec, requestId: unknown, kind: string, args: string, f: () => Promise<T>, replay?: () => T): Promise<T | ComputerState> {
    if (typeof requestId !== 'string' || !COMPUTER_REQUEST_ID.test(requestId)) throw new ComputerError('bad_request', 400);
    const id = requestId.toLowerCase(), fp = `${kind}:${args}`;
    const seen = r.ops.find((o) => o.id === id);
    if (seen) {
      if (seen.fp ? seen.fp !== fp : seen.kind !== kind) throw new ComputerError('request_conflict');
      if (seen.error) throw new ComputerError(seen.error.code, seen.error.status);
      return replay ? replay() : this.view(r);
    }
    const entry: Op = { id, kind, fp };
    r.ops.push(entry);
    if (r.ops.length > OPS_MAX) r.ops.splice(0, r.ops.length - OPS_MAX);
    try { return await f(); }
    catch (e) {
      if (e instanceof ComputerError && e.code !== 'unknown_outcome') entry.error = { code: e.code, status: e.status };
      else r.ops = r.ops.filter((o) => o !== entry);
      throw e;
    }
  }

  private async schedule(r: Rec) {
    const now = this.d.now();
    const pending = r.status === 'starting' || r.status === 'stopping' || r.status === 'unknown' || r.status === 'snapshotting'
      || (r.status === 'running' && r.desktop === 'starting')
      || (!!r.snapshot && SNAPSHOT_BUSY.includes(r.snapshot.state)) || this.probeDue(r) || this.resizing(r) || this.ending(r) || !!r.end?.backupWork || this.resumeDue(r);
    const fast = r.status === 'starting' || (r.status === 'running' && r.desktop === 'starting');
    // The alarm defers the session stop while a resize is pending; the deadline must not become a 1 s poll meanwhile.
    const deadline = r.status === 'running' && r.sessionEndsAt ? (this.resizing(r) ? Math.max(r.sessionEndsAt, now + COMPUTER_POLL_MS) : r.sessionEndsAt) : null;
    const preEnd = deadline !== null && r.autoEnd && !this.ending(r) ? deadline - END_PREEXPIRY_MS : null;
    const times = [pending ? now + (fast ? 1000 : COMPUTER_POLL_MS) : null, deadline, preEnd].filter((x): x is number => x !== null);
    if (times.length) await this.d.store.setAlarm(Math.max(now + 1000, Math.min(...times)));
    else await this.d.store.deleteAlarm();
  }

  private async run<T>(f: (r: Rec) => Promise<T>): Promise<ComputerResult<T>> {
    return this.serial(async () => {
      const r = await this.load();
      try {
        const out = await f(r);
        await this.save(r); await this.schedule(r);
        return { ok: true as const, ...out };
      } catch (e) {
        await this.save(r); await this.schedule(r);
        if (e instanceof ComputerError) return fail(e.code, e.status);
        throw e;
      }
    });
  }

  state(ownerTag: string) {
    return this.run(async (r) => {
      this.bind(r, ownerTag);
      if (r.machine) await this.refresh(r);
      return this.view(r);
    });
  }

  start(ownerTag: string, body: { requestId?: unknown; account?: unknown }) {
    return this.run(async (r) => {
      this.bind(r, ownerTag);
      if (!isAccount(body.account)) throw new ComputerError('bad_request', 400);
      const account = body.account;
      return this.once(r, body.requestId, 'start', account, async () => {
        const a = this.account(account);
        if (!a) throw new ComputerError('not_configured');
        if (r.machine && r.machine.account !== a.id) throw new ComputerError('account_mismatch');
        if (r.machine && r.machine.created !== 'owned') {
          await this.refresh(r); // reconcile the unknown create by exact name before anything else
          const m = r.machine as Machine | null;
          if (m && m.created !== 'owned') throw new ComputerError('unknown_outcome');
        } else if (r.machine) await this.refresh(r);
        if ((r.snapshot && SNAPSHOT_BUSY.includes(r.snapshot.state)) || this.resizing(r) || this.ending(r)) throw new ComputerError('busy');
        if (!r.machine) return this.create(r, a);
        if (r.status === 'running') { this.extendSessions(r); return this.view(r); }
        if (r.status === 'starting') return this.view(r);
        if (r.status !== 'stopped') throw new ComputerError(r.status === 'unknown' ? 'unknown_outcome' : 'busy');
        r.status = 'starting'; r.error = null; r.sessionEndsAt = this.d.now() + COMPUTER_SESSION_MS; r.stopRefusals = 0;
        this.oweStartResume(r, body.requestId as string);
        await this.save(r); // ledger before mutation (also the owed resume, so a lost start answer or a restart still resumes)
        try { await this.d.daytona.start(this.dt(a), r.machine.id!); }
        catch (e) { this.unconfirmed(r, e); }
        return this.view(r);
      });
    });
  }

  private async create(r: Rec, a: ComputerAccountConfig) {
    const dt = this.dt(a), t = this.template(r, a.id);
    if (t) {
      // A selected own capture of this account, re-read right before the create; never a silent fallback to the prepared image.
      const ok = await this.recheck(r, t);
      if (ok === undefined) throw new ComputerError('unknown_outcome', 503);
      if (!ok) throw new ComputerError('template_unavailable');
    } else {
      if (!a.prepared) { r.error = 'missing_image'; throw new ComputerError('missing_image'); }
      let snap; try { snap = await this.d.daytona.getSnapshot(dt, a.snapshot); } catch { throw new ComputerError('unknown_outcome', 503); }
      if (!snap || snap.state !== 'active') { r.error = 'missing_image'; throw new ComputerError('missing_image'); }
    }
    const source = t ? t.name : a.snapshot;
    const name = computerName(r.ownerTag!, a.id);
    r.machine = { account: a.id, name, id: null, created: 'pending', region: null, cpu: null, memoryGiB: null, diskGiB: null, template: t ? t.name : null };
    r.status = 'starting'; r.error = null; r.reconcilePolls = 0; r.sessionEndsAt = this.d.now() + COMPUTER_SESSION_MS; r.desktop = 'not_running';
    await this.save(r); // ledger before mutation
    // Resources come from the prepared snapshot; no image/cpu/memory/disk here. Persistent: autoDeleteInterval -1.
    // Raw REST POST /sandbox takes `env`; `envVars` is only the SDK option name and the wire API ignores it.
    // https://www.daytona.io/docs/en/sandboxes/#environment-variables
    const body = { name, snapshot: source, labels: computerLabels(r.ownerTag!, a.id), public: false,
      autoStopInterval: COMPUTER_AUTO_STOP_MINUTES, autoDeleteInterval: -1, env: { VNC_RESOLUTION: '1920x1080' } };
    try {
      const sb = await this.d.daytona.create(dt, body);
      if (this.owned(r, sb)) this.adopt(r, sb); else { r.machine.created = 'unknown'; r.status = 'unknown'; }
    } catch (e) {
      // 409 = the exact name exists (an earlier unknown create landed): reconcile it, never create again.
      if (e instanceof ComputerDaytonaError && !e.uncertain && e.status !== 409) {
        r.machine = null; r.status = 'absent'; r.error = 'provider_error'; r.sessionEndsAt = null;
        throw new ComputerError('provider_error', 502);
      }
      r.machine.created = 'unknown'; r.status = 'unknown'; r.error = 'unknown_outcome';
    }
    return this.view(r);
  }

  private unconfirmed(r: Rec, e: unknown) {
    if (e instanceof ComputerDaytonaError && !e.uncertain) { r.error = 'provider_error'; throw new ComputerError('provider_error', 502); }
    r.status = 'unknown'; r.error = 'unknown_outcome';
  }

  private async stopMachine(r: Rec) {
    const a = this.account(r.machine!.account); if (!a) throw new ComputerError('not_configured');
    const deadline = r.sessionEndsAt;
    r.status = 'stopping'; r.sessionEndsAt = null; r.desktop = 'not_running'; this.down(r);
    await this.save(r); // ledger before mutation; also revokes gateway fast reads (sessions + epoch)
    await this.d.store.put(PREVIEW_KEY, null);
    try { await this.d.daytona.stop(this.dt(a), r.machine!.id!); r.stopRefusals = 0; }
    catch (e) {
      // A definite refusal leaves the machine running: keep its hard deadline so a later alarm stops it again (bounded, one
      // alarm apart). An unanswered stop is reconciled by GET and never re-sent, so its deadline stays cleared.
      if (e instanceof ComputerDaytonaError && !e.uncertain && deadline !== null && (r.stopRefusals = (r.stopRefusals ?? 0) + 1) <= STOP_REFUSALS_MAX)
        r.sessionEndsAt = Math.max(deadline, this.d.now() + COMPUTER_POLL_MS);
      this.unconfirmed(r, e);
    }
  }

  stop(ownerTag: string, body: { requestId?: unknown }) {
    return this.run(async (r) => {
      this.bind(r, ownerTag);
      return this.once(r, body.requestId, 'stop', '', async () => {
        if (!r.machine) throw new ComputerError('absent');
        await this.refresh(r);
        if (r.machine?.created !== 'owned') throw new ComputerError('unknown_outcome');
        if (this.resizing(r)) throw new ComputerError('busy');
        if (r.status === 'stopped' || r.status === 'stopping') return this.view(r);
        if (r.status !== 'running' && r.status !== 'starting') throw new ComputerError('busy');
        const e = r.end;
        if (e && this.ending(r)) { // the plain stop overrides a running drain: disk kept, files no longer provable
          if (e.files === 'verifying') e.files = 'unverified';
          e.phase = 'stopping'; e.stops++; e.updatedAt = this.d.now();
        }
        await this.stopMachine(r);
        return this.view(r);
      });
    });
  }

  extend(ownerTag: string, body: { requestId?: unknown }) {
    return this.run(async (r) => {
      this.bind(r, ownerTag);
      return this.once(r, body.requestId, 'extend', '', async () => {
        if (r.status !== 'running' && r.status !== 'starting') throw new ComputerError('not_running');
        if (this.ending(r)) {
          // Extending keeps working: only a deadline end that has not stopped anything yet can be called off.
          const e = r.end!;
          if (e.trigger !== 'deadline' || e.phase !== 'draining') throw new ComputerError('busy');
          e.phase = 'cancelled'; e.updatedAt = this.d.now();
          if (e.files === 'verifying') e.files = 'unverified';
          await this.resumeAgent(r);
        }
        if (r.machine?.id && this.d.daytona.activity) {
          const a=this.account(r.machine.account); if(!a)throw new ComputerError('not_configured');
          try { await this.d.daytona.activity(this.dt(a),r.machine.id); } catch { throw new ComputerError('provider_error',502); }
        }
        this.extendSessions(r);
        return this.view(r);
      });
    });
  }

  /** Bounded (never more than one session from now); desktop cookies still valid now follow the new deadline. */
  private extendSessions(r: Rec) {
    const now = this.d.now(), end = now + COMPUTER_SESSION_MS;
    r.sessionEndsAt = end; r.stopRefusals = 0;
    r.sessions = r.sessions.filter((s) => s.exp > now).map((s) => ({ ...s, exp: end }));
  }

  snapshot(ownerTag: string, body: { requestId?: unknown; name?: unknown }) {
    return this.run(async (r) => {
      this.bind(r, ownerTag);
      if (typeof body.name !== 'string' || !COMPUTER_SNAPSHOT_NAME.test(body.name)) throw new ComputerError('snapshot_name', 400);
      const name = body.name;
      return this.once(r, body.requestId, 'snapshot', name, async () => {
        if (!r.machine) throw new ComputerError('absent');
        await this.refresh(r);
        if (r.machine?.created !== 'owned') throw new ComputerError('unknown_outcome');
        if ((r.snapshot && SNAPSHOT_BUSY.includes(r.snapshot.state)) || this.resizing(r) || this.ending(r)) throw new ComputerError('busy');
        // A taken name is a definite refusal: a prepared base image or an earlier capture is never reported as this capture.
        if (computerAccounts(this.d.env).some((a) => a.snapshot === name)) throw new ComputerError('snapshot_exists');
        const a = this.account(r.machine.account); if (!a) throw new ComputerError('not_configured');
        let existing; try { existing = await this.d.daytona.getSnapshot(this.dt(a), name); } catch { throw new ComputerError('unknown_outcome', 503); }
        if (existing) throw new ComputerError('snapshot_exists');
        r.snapshot = { name, state: 'waiting_stop', error: null, polls: 0, account: r.machine.account };
        // Container snapshots are cold: stop first (filesystem only, no RAM), then the alarm requests the capture.
        if (r.status === 'running' || r.status === 'starting') await this.stopMachine(r);
        else if (r.status === 'stopped') await this.requestSnapshot(r);
        else if (r.status !== 'stopping') { r.snapshot = null; throw new ComputerError('busy'); }
        return this.view(r);
      });
    });
  }

  /** Preflight the exact name again (time has passed since the request), record the proof inputs, then ask once. */
  private async requestSnapshot(r: Rec) {
    const s = r.snapshot!, m = r.machine!, a = this.account(m.account); if (!a) return;
    let existing; try { existing = await this.d.daytona.getSnapshot(this.dt(a), s.name); } catch { return; } // the alarm asks again within its budget
    if (existing) { s.state = 'error'; s.error = 'snapshot_exists'; return; }
    s.state = 'requesting'; s.polls = 0; s.requestedAt = this.d.now(); s.sourceId = m.id!; s.preflightAbsent = true;
    await this.save(r); // ledger before mutation
    try { await this.d.daytona.createSnapshot(this.dt(a), m.id!, s.name); s.state = 'snapshotting'; }
    catch (e) {
      if (e instanceof ComputerDaytonaError && e.status === 409) { s.state = 'error'; s.error = 'snapshot_exists'; } // one request per record: 409 is a collision
      else if (e instanceof ComputerDaytonaError && !e.uncertain) { s.state = 'error'; s.error = 'provider_error'; }
      else s.state = 'unknown'; // reconcile by exact snapshot name, never resubmit
    }
  }

  /** SnapshotDto (daytona_api_client 0.214) carries sourceSandboxId and createdAt; without either proof it is unproven. */
  private snapshotOwner(s: SnapshotRec, info: ComputerSnapshotInfo): 'ours' | 'foreign' | 'unproven' {
    if (typeof info.sourceSandboxId === 'string' && info.sourceSandboxId) return s.sourceId && info.sourceSandboxId === s.sourceId ? 'ours' : 'foreign';
    const created = Date.parse(info.createdAt ?? '');
    return s.preflightAbsent && s.requestedAt && Number.isFinite(created) && created >= s.requestedAt - SNAPSHOT_SKEW_MS ? 'ours' : 'unproven';
  }

  private async pollSnapshot(r: Rec) {
    const s = r.snapshot!, a = this.account(r.machine!.account); if (!a) return;
    // Persisted 'requesting' means the request never answered in its instance (eviction/deploy): reconcile, never resubmit.
    if (s.state === 'requesting') s.state = 'unknown';
    if (s.state === 'waiting_stop') {
      if (++s.polls > SNAPSHOT_MAX_POLLS) { s.state = 'error'; s.error = 'unknown_outcome'; return; }
      if (r.status === 'stopped') await this.requestSnapshot(r);
      return;
    }
    if (s.state !== 'snapshotting' && s.state !== 'unknown') return;
    s.polls++; // transport failures count against the same finite budget
    let info: ComputerSnapshotInfo | null | undefined;
    try { info = await this.d.daytona.getSnapshot(this.dt(a), s.name); } catch { info = undefined; }
    if (info) {
      const owner = this.snapshotOwner(s, info);
      if (owner === 'foreign') { s.state = 'error'; s.error = 'snapshot_exists'; return; }
      // An answered create is ours unless proven foreign; an unanswered one must be proven before it can become active.
      if (owner === 'unproven' && s.state === 'unknown') { s.state = 'unconfirmed'; s.error = 'unknown_outcome'; return; }
      if (info.state === 'active') { s.state = 'active'; s.error = null; return; }
      if (['error', 'build_failed'].includes(info.state ?? '')) { s.state = 'error'; s.error = 'provider_error'; return; }
      s.state = 'snapshotting';
    }
    if (s.polls >= SNAPSHOT_MAX_POLLS || (!info && s.state === 'unknown' && s.polls >= RECONCILE_MAX)) { s.state = 'error'; s.error = 'unknown_outcome'; }
  }

  /** Start computer_use, then the image's fixed launcher once the machine runs, then require an HTTP health answer before `ready`. */
  private async pollDesktop(r: Rec) {
    const m = r.machine!, a = this.account(m.account); if (!a || !m.id) return;
    const sb: ComputerSandbox = { id: m.id, toolboxProxyUrl: m.sandbox?.toolboxProxyUrl };
    const dt = this.dt(a);
    try {
      const health = await this.d.daytona.exec(dt, sb, `curl -fsS -o /dev/null -m 5 http://127.0.0.1:${COMPUTER_DESKTOP_PORT}${COMPUTER_DESKTOP_HEALTH}`, 10);
      if (health.exitCode === 0) {
        // Ready now; the tool probe runs on a later alarm so it never delays the desktop. Prewarm the gateway preview.
        r.desktop = 'ready'; r.probeTries = 0;
        await this.save(r);
        await this.previewFor(m.account, m.id, r.desktopEpoch ?? 0);
        return;
      }
      const now = this.d.now();
      if (r.desktopLaunchAt && now - r.desktopLaunchAt < 60_000) return;
      const present = await this.d.daytona.exec(dt, sb, `test -x ${COMPUTER_START_SCRIPT}`, 10);
      if (present.exitCode !== 0) { r.desktop = 'missing_image'; return; }
      if (r.desktopLaunches >= DESKTOP_LAUNCH_MAX) { r.desktop = 'unhealthy'; return; }
      r.desktopLaunches++; r.desktopLaunchAt = now;
      await this.save(r);
      await this.d.daytona.computerUseStart(dt, sb); // display stack first; the launcher attaches Selkies to it
      await this.d.daytona.spawn(dt, sb, 'cloudbite-desktop', COMPUTER_START_SCRIPT);
    } catch { /* next alarm checks again */ }
  }

  private probeDue(r: Rec) {
    return r.machine?.created === 'owned' && r.status === 'running' && r.desktop === 'ready'
      && r.probeEpoch !== (r.desktopEpoch ?? 0) && (r.probeTries ?? 0) < PROBE_TRIES;
  }

  /** Fixed in-image probe, bounded; at most PROBE_TRIES per machine run. Failure leaves tools `unprobed`, never guessed. */
  private async probeTools(r: Rec) {
    const m = r.machine!, a = this.account(m.account); if (!a || !m.id) return;
    r.probeTries = (r.probeTries ?? 0) + 1;
    try {
      const out = await this.d.daytona.exec(this.dt(a), { id: m.id, toolboxProxyUrl: m.sandbox?.toolboxProxyUrl }, COMPUTER_PROBE_COMMAND, PROBE_TIMEOUT_S);
      const probe = parseComputerProbe(out.result);
      if (probe) { r.probe = probe; r.probeEpoch = r.desktopEpoch ?? 0; }
    } catch { /* a later alarm retries within PROBE_TRIES */ }
  }

  alarm() {
    return this.serial(async () => {
      const r = await this.load();
      try {
        if (r.machine) await this.refresh(r);
        const now = this.d.now();
        if (this.resizing(r)) {
          const z = r.resize!;
          if (z.state === 'requesting') z.state = 'unknown'; // persisted mid-request (eviction/deploy): reconcile, never resend
          if (++z.polls >= (z.state === 'pending' ? RESIZE_MAX_POLLS : RECONCILE_MAX)) { z.state = 'failed'; z.error = 'unknown_outcome'; }
        }
        if (!this.ending(r) && this.autoEndDue(r, now)) this.beginEnd(r, this.uuid(), r.autoEnd!, 'deadline');
        if (this.ending(r)) await this.stepEnd(r);
        else if (r.machine?.created === 'owned' && r.status === 'running' && r.sessionEndsAt && r.sessionEndsAt <= now && !this.resizing(r)) {
          try { await this.stopMachine(r); } catch { /* recorded on r */ }
        }
        if (!this.ending(r) && r.end?.backupWork) await this.tickBackupWork(r);
        if (!this.ending(r)) await this.resumeOwed(r);
        if (r.status !== 'running') { r.desktopLaunches = 0; r.desktopLaunchAt = null; }
        if (r.machine?.created === 'owned' && r.snapshot) await this.pollSnapshot(r);
        if (r.machine?.created === 'owned' && r.status === 'running' && r.desktop === 'starting') await this.pollDesktop(r);
        else if (this.probeDue(r)) await this.probeTools(r);
      } finally {
        await this.save(r); await this.schedule(r);
      }
    });
  }

  /** Own capture history. Provider reads only: the machine refresh plus a bounded re-check of active captures. */
  snapshots(ownerTag: string) {
    return this.run(async (r) => {
      this.bind(r, ownerTag);
      if (r.machine) await this.refresh(r);
      const now = this.d.now();
      const due = (r.snapshots ?? []).filter((h) => ['active', 'unknown'].includes(h.state) && (h.checkedAt === null || now < h.checkedAt || now - h.checkedAt >= RECHECK_MS))
        .sort((x, y) => (x.checkedAt ?? 0) - (y.checkedAt ?? 0)).slice(0, RECHECK_MAX);
      for (const h of due) await this.recheck(r, h);
      return this.snapshotsView(r);
    });
  }

  /**
   * Choose (or with name null, clear) the template of a FUTURE new machine. Only an own active capture that a fresh read still
   * shows active; no provider mutation of any kind, and the current machine is never changed or restarted.
   */
  selectSnapshot(ownerTag: string, body: Record<string, unknown>) {
    return this.run(async (r) => {
      this.bind(r, ownerTag);
      const input: Record<string, unknown> = body && typeof body === 'object' ? body : {};
      if (Object.keys(input).some((k) => !SELECT_KEYS.has(k)) || !isAccount(input.account)
        || (input.name !== null && (typeof input.name !== 'string' || !COMPUTER_SNAPSHOT_NAME.test(input.name)))) throw new ComputerError('bad_request', 400);
      const account = input.account, name = input.name as string | null;
      return this.once(r, input.requestId, 'select', `${account}/${name ?? ''}`, async () => {
        if (name === null) { if (r.template?.account === account) r.template = null; return this.snapshotsView(r); }
        const h = (r.snapshots ?? []).find((x) => x.account === account && x.name === name);
        if (!h || h.state !== 'active') throw new ComputerError('snapshot_not_selectable');
        if (!this.account(account)) throw new ComputerError('not_configured');
        const ok = await this.recheck(r, h);
        if (ok === undefined) throw new ComputerError('unknown_outcome', 503); // nothing concluded: the id stays usable
        if (!ok) throw new ComputerError('snapshot_not_selectable');
        r.template = { account, name, requestedAt: h.requestedAt };
        return this.snapshotsView(r);
      }, () => this.snapshotsView(r));
    });
  }

  private ending(r: Rec) { return !!r.end && END_ACTIVE.includes(r.end.phase); }

  private autoEndDue(r: Rec, now: number) {
    return !!r.autoEnd && r.machine?.created === 'owned' && r.status === 'running' && !!r.sessionEndsAt && r.sessionEndsAt - now <= END_PREEXPIRY_MS
      && !this.resizing(r) && !(r.snapshot && SNAPSHOT_BUSY.includes(r.snapshot.state));
  }

  private uuid() {
    const b = this.d.random(16); b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    const h = [...b].map((v) => v.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }

  /** files: verifying only when a drain can prove it; otherwise honestly unverified (drain wired) or not_configured. */
  private beginEnd(r: Rec, requestId: string, mode: ComputerEndMode, trigger: ComputerEndTrigger) {
    const now = this.d.now(), h = this.d.end;
    r.end = {
      requestId, mode, trigger, phase: 'draining',
      files: mode === 'files_verified' && h?.drain ? 'verifying' : h?.drain ? 'unverified' : 'not_configured',
      filesVerifiedAt: null, report: null, drains: 0, drainAt: null, stopAt: trigger === 'deadline' ? r.sessionEndsAt : null,
      flushed: null, stops: 0, polls: 0, machineStopped: false, backup: h?.backup ? 'not_requested' : 'not_configured', backupName: null,
      error: null, startedAt: now, updatedAt: now,
    };
  }

  /**
   * A refresh saw the running machine stop without us (provider auto-stop, quota, outage). Opted-in owners get an end record
   * that says files are unverified and still gets the environment backup; nothing is restarted. Others keep the plain record.
   */
  private stoppedOutside(r: Rec) {
    if (this.ending(r) || !r.autoEnd) return;
    this.beginEnd(r, this.uuid(), r.autoEnd, 'provider_stop');
    const e = r.end!;
    e.phase = 'stopping';
    if (e.files === 'verifying') e.files = 'unverified';
  }

  private machineRef(r: Rec): ComputerMachineRef {
    const m = r.machine!;
    return { id: m.id!, account: m.account, name: m.name, labels: computerLabels(r.ownerTag!, m.account), status: r.status, region: m.region };
  }

  /** Immediate resume (blocked/cancelled end). A failure keeps the owed resume for the bounded alarm retries. */
  private async resumeAgent(r: Rec) {
    const h = this.d.end, id = r.resume?.requestId ?? r.end?.requestId;
    if (!h?.resume || r.status !== 'running' || !r.machine?.id || !id) return;
    try { await h.resume(this.machineRef(r), id); r.resume = null; }
    catch { if (r.resume) r.resume.at = this.d.now(); } // still draining across restarts: resumeOwed retries it, one alarm later
  }

  /**
   * A configured watcher/agent process dies with every stop, drained or not: an authorized start of this owned stopped machine
   * owes it one resume of the coming run. Only the record is written (dispatched by the alarm once the same machine is observed
   * running); an earlier owed resume of the same machine keeps its requestId. No hook: nothing changes.
   */
  private oweStartResume(r: Rec, requestId: string) {
    const o = r.resume, id = r.machine?.id;
    if (!this.d.end?.resume || r.machine?.created !== 'owned' || !id) return;
    r.resume = { requestId: o && o.machineId === id ? o.requestId : requestId.toLowerCase(), machineId: id, tries: 0, epoch: r.desktopEpoch ?? 0, at: null };
  }

  /** An owed resume can run: the same owned machine that was drained is running, no end is active, this run has tries left. */
  private resumeDue(r: Rec) {
    const o = r.resume, m = r.machine;
    return !!o && !!this.d.end?.resume && m?.created === 'owned' && m.id === o.machineId && r.status === 'running' && !this.ending(r)
      && (o.epoch !== (r.desktopEpoch ?? 0) || o.tries < RESUME_TRIES);
  }

  /** Alarm only (never a GET): one resume call per alarm, recorded before it is sent. Never a provider start or other mutation. */
  private async resumeOwed(r: Rec) {
    const o = r.resume, m = r.machine; if (!o) return;
    if (!m || (m.id && m.id !== o.machineId)) { r.resume = null; return; } // that machine is gone; a new one was never drained
    if (!this.resumeDue(r)) return;
    const now = this.d.now(), epoch = r.desktopEpoch ?? 0;
    if (o.epoch !== epoch) { o.epoch = epoch; o.tries = 0; o.at = null; } // each run of the same machine gets its own bounded tries
    if (o.at !== null && now >= o.at && now - o.at < COMPUTER_POLL_MS) return;
    o.tries++; o.at = now;
    await this.save(r); // attempt persisted before the call
    try { await this.d.end!.resume!(this.machineRef(r), o.requestId); r.resume = null; } catch { /* a later alarm of this run retries */ }
  }

  /** Best-effort `sync` before the stop. The provider stop is what keeps the disk; a failed flush is reported, never hidden. */
  private async flush(r: Rec): Promise<boolean> {
    const m = r.machine!, a = this.account(m.account); if (!a || !m.id) return false;
    try { return (await this.d.daytona.exec(this.dt(a), { id: m.id, toolboxProxyUrl: m.sandbox?.toolboxProxyUrl }, 'sync', END_FLUSH_TIMEOUT_S)).exitCode === 0; }
    catch { return false; }
  }

  /** One drain request, recorded before it is sent. Only known numeric/boolean fields are kept; anything else fails verification. */
  private async drainOnce(r: Rec): Promise<ComputerDrainResult | null> {
    const e = r.end!, o = r.resume, id = r.machine!.id!;
    e.drains++; e.drainAt = this.d.now();
    // From the first drain on, the agent/watcher may be draining: a resume is owed to this machine until one succeeds.
    r.resume = o && o.machineId === id ? { ...o, requestId: e.requestId } : { requestId: e.requestId, machineId: id, tries: 0, epoch: r.desktopEpoch ?? 0, at: null };
    await this.save(r); // phase and attempt persisted before the outbound call
    let res: ComputerDrainResult;
    try { res = await this.d.end!.drain!(this.machineRef(r), e.requestId); } catch { return null; }
    if (!res || typeof res !== 'object') return null;
    if (res.ok) {
      const x = (res.report ?? {}) as unknown as Record<string, unknown>;
      const report = { agentReady: x.agentReady === true, managedScanComplete: x.managedScanComplete === true, scanLimited: x.scanLimited !== false } as ComputerDrainReport;
      for (const k of DRAIN_COUNTS) report[k] = Number.isSafeInteger(x[k]) && (x[k] as number) >= 0 ? x[k] as number : -1;
      e.report = report;
    }
    return res;
  }

  /**
   * Advance the stored end by one alarm. draining: files_verified drains until proven (then stop), until the attempts run out
   * (blocked, machine keeps running) or until the deadline (stop anyway, files pending). disk_backup flushes and stops.
   * stopping: one stop request, observed by GET. backing_up: the injected manager decides; its answer is mirrored, bounded.
   */
  private async stepEnd(r: Rec) {
    const e = r.end!, now = this.d.now(), h = this.d.end;
    e.updatedAt = now;
    if (r.machine?.created !== 'owned' || !r.machine.id) { e.phase = 'failed'; e.error = r.error ?? 'absent'; return; }
    if (e.phase === 'draining') {
      const deadline = e.stopAt ?? r.sessionEndsAt, due = deadline !== null && now >= deadline;
      if (r.status !== 'running') {
        if (e.files === 'verifying') e.files = 'unverified'; // stopped meanwhile: nothing more can be proven
        e.phase = 'stopping';
      } else if (e.mode === 'files_verified' && h?.drain) {
        if (!due && e.drains >= END_DRAIN_TRIES && e.trigger === 'user') {
          // The last attempt was persisted but its answer was lost (DO restart): no drain is left, so block and resume.
          e.phase = 'blocked'; e.files = 'blocked';
          await this.resumeAgent(r);
          return;
        }
        if (!due && (e.drains >= END_DRAIN_TRIES || (e.drainAt !== null && now - e.drainAt < COMPUTER_POLL_MS))) return;
        const res = await this.drainOnce(r);
        const verified = !!res?.ok && computerDrainVerified(e.report);
        if (verified && (e.trigger === 'user' || due)) { e.files = 'verified'; e.filesVerifiedAt = now; e.phase = 'stopping'; }
        else if (due) { e.files = verified ? 'verified' : 'pending'; e.phase = 'stopping'; } // never extend paid compute
        else if (e.trigger === 'user' && ((res && !res.ok && !res.retryable) || e.drains >= END_DRAIN_TRIES)) {
          e.phase = 'blocked'; e.files = 'blocked';
          await this.resumeAgent(r);
          return;
        }
        else return;
      } else {
        if (e.trigger === 'deadline' && !due) return; // disk_backup at the deadline: keep the paid session the owner has
        if (e.files === 'verifying') e.files = e.trigger === 'deadline' ? 'pending' : 'unverified';
        if (e.flushed === null) e.flushed = await this.flush(r);
        e.phase = 'stopping';
      }
    }
    if (e.phase === 'stopping') {
      if (r.status === 'stopped') { e.machineStopped = true; e.polls = 0; e.phase = h?.backup ? 'backing_up' : 'done'; }
      else if (r.status === 'running' || r.status === 'starting') {
        if (e.stops >= END_STOP_TRIES) { e.phase = 'failed'; e.error = 'unknown_outcome'; return; }
        e.stops++;
        try { await this.stopMachine(r); } catch (x) { e.phase = 'failed'; e.error = x instanceof ComputerError ? x.code : 'provider_error'; }
        return;
      } else if (++e.polls >= END_STOP_MAX_POLLS) { e.phase = 'failed'; e.error = 'unknown_outcome'; return; }
      else return;
    }
    if (e.phase === 'backing_up') {
      const b = h?.backup; if (!b) { e.phase = 'done'; return; }
      let st: ComputerBackupStatus | null = null;
      try {
        st = e.backup === 'not_requested'
          ? await b.begin(r.ownerTag!, { requestId: e.requestId, machine: { id: r.machine.id, account: r.machine.account, status: r.status }, environmentRevision: null })
          : await b.tick(r.ownerTag!);
      } catch { st = null; } // begin is idempotent per requestId: the next alarm asks the same request again
      this.mirrorBackup(e, st);
      // An unknown outcome the manager no longer works on (create_unconfirmed: owned and blocking until an explicit reconcile)
      // ends the flow as unknown now; holding the stopped machine busy for the alarm budget would prove nothing.
      if (BACKUP_DONE.includes(e.backup) || (st?.state === 'unknown' && st.work === false)) e.phase = 'done';
      else if (++e.polls >= END_BACKUP_MAX_POLLS) { e.phase = 'done'; e.backup = 'unknown'; }
    }
  }

  private mirrorBackup(e: EndRec, st: ComputerBackupStatus | null) {
    if (!st || !['pending', 'active', 'coalesced', 'failed', 'blocked', 'unknown'].includes(st.state)) return;
    e.backup = st.state; e.backupWork = st.work === true;
    if (typeof st.name === 'string') e.backupName = st.name;
  }

  /** Manager work left after the end finished (retention cleanup): alarm-only ticks, bounded like the backup itself. */
  private async tickBackupWork(r: Rec) {
    const e = r.end!, b = this.d.end?.backup;
    if (!b || (e.workPolls = (e.workPolls ?? 0) + 1) > END_BACKUP_MAX_POLLS) { e.backupWork = false; return; }
    let st: ComputerBackupStatus | null = null;
    try { st = await b.tick(r.ownerTag!); } catch { st = null; }
    this.mirrorBackup(e, st);
  }

  /**
   * One-action safe end. Stores the end and returns; the alarm does the work. Same requestId replays; another requestId joins
   * an active end of the same mode and is busy for the other mode. files_verified needs a wired drain and a running machine.
   */
  end(ownerTag: string, body: Record<string, unknown>) {
    return this.run(async (r) => {
      this.bind(r, ownerTag);
      const input: Record<string, unknown> = body && typeof body === 'object' ? body : {};
      if (Object.keys(input).some((k) => !END_KEYS.has(k)) || !isEndMode(input.mode)) throw new ComputerError('bad_request', 400);
      const mode = input.mode;
      return this.once(r, input.requestId, 'end', mode, async () => {
        if (mode === 'files_verified' && !this.d.end?.drain) throw new ComputerError('files_not_configured');
        if (!r.machine) throw new ComputerError('absent');
        await this.refresh(r);
        if (r.machine?.created !== 'owned') throw new ComputerError('unknown_outcome');
        if (this.ending(r)) { if (r.end!.mode !== mode) throw new ComputerError('busy'); return this.endState(r); }
        if ((r.snapshot && SNAPSHOT_BUSY.includes(r.snapshot.state)) || this.resizing(r)) throw new ComputerError('busy');
        if (mode === 'files_verified' && r.status !== 'running') throw new ComputerError('not_running');
        if (!['running', 'starting', 'stopped'].includes(r.status)) throw new ComputerError(r.status === 'unknown' ? 'unknown_outcome' : 'busy');
        this.beginEnd(r, String(input.requestId).toLowerCase(), mode, 'user');
        return this.endState(r);
      }, () => this.endState(r));
    });
  }

  /** Storage reads only (plus the manager's storage-only status); never a provider call. */
  async endStatus(ownerTag: string): Promise<ComputerResult<ComputerEndState>> {
    if (typeof ownerTag !== 'string' || !COMPUTER_OWNER_TAG.test(ownerTag)) return fail('bad_request', 400);
    const r = await this.load();
    if (r.ownerTag && r.ownerTag !== ownerTag) return fail('bad_request', 403);
    let backup: ComputerBackupStatus | null = null;
    if (this.d.end?.backup) { try { backup = await this.d.end.backup.status(ownerTag); } catch { backup = null; } }
    return { ok: true, ...this.endState(r), backup };
  }

  /** Opt in (or out with null) to the automatic safe end before the session deadline. No provider call. */
  endSettings(ownerTag: string, body: Record<string, unknown>) {
    return this.run(async (r) => {
      this.bind(r, ownerTag);
      const input: Record<string, unknown> = body && typeof body === 'object' ? body : {};
      if (Object.keys(input).some((k) => !END_SETTINGS_KEYS.has(k)) || (input.autoEnd !== null && !isEndMode(input.autoEnd))) throw new ComputerError('bad_request', 400);
      const autoEnd = input.autoEnd as ComputerEndMode | null;
      return this.once(r, input.requestId, 'end-settings', autoEnd ?? '', async () => {
        if (autoEnd === 'files_verified' && !this.d.end?.drain) throw new ComputerError('files_not_configured');
        r.autoEnd = autoEnd;
        return this.endState(r);
      }, () => this.endState(r));
    });
  }

  launch(ownerTag: string) {
    return this.run(async (r) => {
      this.bind(r, ownerTag);
      const gateway = this.d.env.CLOUDBITE_COMPUTER_GATEWAY_ORIGIN;
      if (!gateway || !/^https:\/\/[a-z0-9.-]+$/i.test(gateway)) throw new ComputerError('not_configured');
      if (r.status !== 'running') throw new ComputerError('not_running');
      if (r.desktop === 'missing_image') throw new ComputerError('missing_image');
      if (r.desktop !== 'ready') throw new ComputerError('desktop_unavailable');
      const ticket = b64url(this.d.random(32));
      const now = this.d.now();
      r.tickets = r.tickets.filter((t) => t.exp > now).slice(-(TICKETS_MAX - 1));
      r.tickets.push({ h: await this.d.sha256(ticket), exp: now + COMPUTER_TICKET_MS });
      return { url: `${gateway}${COMPUTER_DESKTOP_PATH}/?${COMPUTER_TICKET_PARAM}=${ticket}` };
    });
  }

  /** Single use: the gateway exchanges the ticket for an HttpOnly cookie value that lives until the session ends. */
  redeemTicket(ticket: string) {
    return this.run(async (r) => {
      if (typeof ticket !== 'string' || !COOKIE_RE.test(ticket)) throw new ComputerError('ticket_invalid', 403);
      const h = await this.d.sha256(ticket), now = this.d.now();
      const t = r.tickets.find((x) => x.h === h);
      r.tickets = r.tickets.filter((x) => x.h !== h && x.exp > now);
      if (!t || t.exp <= now || r.status !== 'running' || r.desktop !== 'ready' || !r.sessionEndsAt) throw new ComputerError('ticket_invalid', 403);
      const cookie = b64url(this.d.random(32));
      r.sessions = r.sessions.filter((s) => s.exp > now).slice(-(SESSIONS_MAX - 1));
      r.sessions.push({ h: await this.d.sha256(cookie), exp: r.sessionEndsAt });
      return { cookie, maxAge: Math.max(1, Math.floor((r.sessionEndsAt - now) / 1000)) };
    });
  }

  /** Read-only check of a gateway cookie against the stored record; never queued behind lifecycle work. */
  private async session(cookie: string): Promise<{ r: Rec; maxAge: number } | null> {
    if (typeof cookie !== 'string' || !COOKIE_RE.test(cookie)) return null;
    const h = await this.d.sha256(cookie), r = await this.load(), now = this.d.now();
    const s = r.sessions.find((x) => x.h === h && x.exp > now);
    if (!s || r.status !== 'running' || r.desktop !== 'ready' || r.machine?.created !== 'owned' || !r.machine.id) return null;
    return { r, maxAge: Math.max(1, Math.floor((s.exp - now) / 1000)) };
  }

  /** Provider preview for one machine run: cached under its own key, one lookup in flight per run, discarded if the run ended. */
  private previewFor(account: ComputerAccount, id: string, epoch: number): Promise<Preview | null> {
    const key = `${id}:${epoch}`;
    let p = this.previewing.get(key);
    if (!p) {
      p = (async () => {
        const a = this.account(account); if (!a) return null;
        let raw; try { raw = await this.d.daytona.preview(this.dt(a), id, COMPUTER_DESKTOP_PORT); } catch { return null; }
        const origin = computerUpstreamOrigin(raw.url, id, computerProxySuffixes(this.d.env));
        if (!origin) return null;
        const got: Preview = { origin, token: raw.token, exp: this.d.now() + PREVIEW_MS, machineId: id, epoch };
        const r = await this.load();
        if (r.status !== 'running' || r.machine?.id !== id || (r.desktopEpoch ?? 0) !== epoch) return null; // stopped or restarted meanwhile
        await this.d.store.put(PREVIEW_KEY, got);
        return got;
      })().finally(() => this.previewing.delete(key));
      this.previewing.set(key, p);
    }
    return p;
  }

  /**
   * Upstream for a gateway request carrying the computer cookie: storage reads only, no fetch while the cached preview of
   * this machine run is fresh. The token stays server-side (proxy header only). maxAge lets the gateway refresh its cookie.
   */
  async desktopUpstream(cookie: string): Promise<ComputerResult<{ origin: string; token: string; maxAge: number }>> {
    const v = await this.session(cookie); if (!v) return fail('ticket_invalid', 403);
    const m = v.r.machine!, epoch = v.r.desktopEpoch ?? 0, now = this.d.now();
    let p = await this.d.store.get<Preview | null>(PREVIEW_KEY);
    if (!p || p.exp <= now || p.machineId !== m.id || p.epoch !== epoch) {
      p = await this.previewFor(m.account, m.id!, epoch);
      if (!p) return fail('desktop_unavailable', 503);
    }
    return { ok: true, origin: p.origin, token: p.token, maxAge: v.maxAge };
  }

  /** The gateway saw 401/403 from the upstream: drop the cached preview so the next request looks it up again. */
  async desktopPreviewRejected(cookie: string): Promise<ComputerResult> {
    const v = await this.session(cookie); if (!v) return fail('ticket_invalid', 403);
    const p = await this.d.store.get<Preview | null>(PREVIEW_KEY);
    if (p && p.machineId === v.r.machine!.id) await this.d.store.put(PREVIEW_KEY, null);
    return { ok: true };
  }

  /** Root-only: the owner's machine identity for nested-compute setup. Read-only; no provider URLs, tokens or keys. */
  async machine(ownerTag: string): Promise<ComputerResult<{ machine: ComputerMachineRef }>> {
    if (typeof ownerTag !== 'string' || !COMPUTER_OWNER_TAG.test(ownerTag)) return fail('bad_request', 400);
    const r = await this.load();
    if (r.ownerTag && r.ownerTag !== ownerTag) return fail('bad_request', 403);
    const m = r.machine;
    if (r.ownerTag !== ownerTag || !m || m.created !== 'owned' || !m.id) return fail('absent');
    return { ok: true, machine: { id: m.id, account: m.account, name: m.name, labels: computerLabels(ownerTag, m.account), status: r.status, region: m.region } };
  }

  private resizing(r: Rec) { return !!r.resize && RESIZE_PENDING.includes(r.resize.state); }

  /** Observed allocation settles a pending increase; nothing is re-sent. 'resizing' proves a request landed and is applying. */
  private settleResize(r: Rec, sb: ComputerSandbox) {
    const z = r.resize; if (!z || !this.resizing(r)) return;
    if (sb.state === 'resizing') { z.state = 'pending'; return; }
    if (sb.state === 'error' || sb.state === 'build_failed') { z.state = 'failed'; z.error = 'provider_error'; return; }
    if (typeof sb.cpu === 'number' && typeof sb.memory === 'number' && sb.cpu >= z.cpu && sb.memory >= z.memoryGiB) {
      z.state = 'done'; z.error = null; r.perf = null; // the old sample describes the old limits
    }
  }

  /** Fixed read-only cgroup sample, bounded; any failure is an unknown sample (null), never zeros. */
  private async sample(r: Rec): Promise<ComputerMetrics | null> {
    const m = r.machine!, a = this.account(m.account); if (!a || !m.id) return null;
    try {
      const out = await this.d.daytona.exec(this.dt(a), { id: m.id, toolboxProxyUrl: m.sandbox?.toolboxProxyUrl }, COMPUTER_METRICS_COMMAND, COMPUTER_METRICS_TIMEOUT_S);
      return out.exitCode === 0 ? parseComputerMetrics(String(out.result ?? ''), { cpu: m.cpu, memoryGiB: m.memoryGiB }) : null;
    } catch { return null; }
  }

  /** Metrics, estimated cost and hot-increase plans. Provider reads happen at most once per COMPUTER_METRICS_CACHE_MS. */
  performance(ownerTag: string) {
    return this.run(async (r): Promise<ComputerPerformance> => {
      this.bind(r, ownerTag);
      if (!r.machine) throw new ComputerError('absent');
      const now = this.d.now(), p = r.perf;
      const fresh = !!p && p.machineId === r.machine.id && p.epoch === (r.desktopEpoch ?? 0) && now >= p.at && now - p.at < COMPUTER_METRICS_CACHE_MS;
      if (!fresh) {
        await this.refresh(r);
        const m = r.machine as Machine | null;
        if (!m) throw new ComputerError('absent');
        if (m.created !== 'owned' || !m.id) throw new ComputerError('unknown_outcome');
        r.perf = { at: now, machineId: m.id, epoch: r.desktopEpoch ?? 0, metrics: r.status === 'running' ? await this.sample(r) : null };
      }
      const m = r.machine!, perf = r.perf!, z = r.resize;
      if (m.created !== 'owned' || !m.id) throw new ComputerError('unknown_outcome');
      if (m.cpu === null || m.memoryGiB === null || m.diskGiB === null) throw new ComputerError('provider_error', 502);
      const current = { cpu: m.cpu, memoryGiB: m.memoryGiB, diskGiB: m.diskGiB };
      return {
        machineId: m.id,
        sampledAt: perf.metrics ? new Date(perf.at).toISOString() : null,
        metrics: perf.metrics,
        current: { ...current, usdPerHour: computerHourlyCost(current) },
        plans: r.status === 'running' && this.d.env.CLOUDBITE_COMPUTER_HOT_RESIZE_ENABLED !== '0' ? computerPlans(current) : [],
        resize: this.d.env.CLOUDBITE_COMPUTER_HOT_RESIZE_ENABLED === '0' ? { status: 'failed', error: 'resize_unavailable' } : z && this.resizing(r) ? { status: 'pending', cpu: z.cpu, memoryGiB: z.memoryGiB }
          : z?.state === 'failed' ? { status: 'failed', cpu: z.cpu, memoryGiB: z.memoryGiB, error: z.error ?? 'unknown_outcome' } : { status: 'idle' },
        pricing: { asOf: COMPUTER_PRICING.asOf, url: COMPUTER_PRICING.url, estimated: true },
      };
    });
  }

  /**
   * Hot CPU/RAM increase of the running owned machine to one fixed plan, with explicit cost acknowledgement. The ledger is
   * written before the single POST; a definite refusal is final for that requestId; an unanswered POST is reconciled by GET.
   * The body names no machine: the target is always the owner-checked record.
   */
  resize(ownerTag: string, body: Record<string, unknown>) {
    return this.run(async (r) => {
      this.bind(r, ownerTag);
      const input: Record<string, unknown> = body && typeof body === 'object' ? body : {};
      if (Object.keys(input).some((k) => !RESIZE_KEYS.has(k)) || input.acknowledgeCost !== true || !isComputerPlan(input.cpu, input.memoryGiB)) {
        throw new ComputerError('bad_request', 400);
      }
      const cpu = input.cpu as number, memoryGiB = input.memoryGiB as number;
      return this.once(r, input.requestId, 'resize', `${cpu}/${memoryGiB}`, async () => {
        if (this.d.env.CLOUDBITE_COMPUTER_HOT_RESIZE_ENABLED === '0') throw new ComputerError('resize_unavailable', 409);
        if (!r.machine) throw new ComputerError('absent');
        const seen = await this.refresh(r); // settles an earlier increase by GET before anything new
        const m = r.machine as Machine | null;
        if (!m) throw new ComputerError('absent');
        if (m.created !== 'owned' || !m.id) throw new ComputerError('unknown_outcome');
        if (this.resizing(r) || this.ending(r) || (r.snapshot && SNAPSHOT_BUSY.includes(r.snapshot.state))) throw new ComputerError('busy');
        if (r.status !== 'running') throw new ComputerError(r.status === 'unknown' ? 'unknown_outcome' : 'not_running');
        if (!seen) throw new ComputerError('unknown_outcome', 503); // no fresh owner-checked read: nothing is sent, the id stays usable
        if (m.cpu === null || m.memoryGiB === null) throw new ComputerError('unknown_outcome');
        if (cpu < m.cpu || memoryGiB < m.memoryGiB || (cpu === m.cpu && memoryGiB === m.memoryGiB)) throw new ComputerError('bad_request', 400);
        const a = this.account(m.account); if (!a) throw new ComputerError('not_configured');
        if (!this.d.daytona.resize) throw new ComputerError('resize_unavailable');
        const z: ResizeRec = { cpu, memoryGiB, state: 'requesting', error: null, polls: 0 };
        r.resize = z;
        await this.save(r); // ledger before mutation
        try { await this.d.daytona.resize(this.dt(a), m.id, { cpu, memory: memoryGiB }); z.state = 'pending'; }
        catch (e) {
          if (e instanceof ComputerDaytonaError && !e.uncertain) {
            const code = e.status === 404 ? 'resize_unavailable' : e.reason === 'quota' ? 'quota_exceeded' : 'provider_error';
            z.state = 'failed'; z.error = code;
            throw new ComputerError(code, code === 'quota_exceeded' ? 409 : 502);
          }
          z.state = 'unknown';
        }
        return this.view(r);
      });
    });
  }
}

type EndHooksFactory = (env: ComputerEnv, storage: DurableObjectStorage) => ComputerEndHooks;
let endHooks: EndHooksFactory | null = null;
/** Root wires the files drain and the backups manager once at module load; without it files_verified stays unavailable. */
export function setComputerEndHooks(f: EndHooksFactory | null) { endHooks = f; }

/**
 * Snapshot names the backups manager must never remove: every configured prepared image, the selected template, the template
 * the current machine came from, the current manual capture and the manual history. Storage read only (no queue, no provider),
 * so it is safe inside end hooks. Fails closed: a record bound to another owner or a bad tag throws, so the caller removes nothing.
 */
export async function computerBackupProtectedNames(env: ComputerEnv, store: { get<T>(key: string): Promise<T | undefined> }, ownerTag: string): Promise<readonly string[]> {
  if (!COMPUTER_OWNER_TAG.test(ownerTag)) throw new ComputerError('bad_request', 400);
  const r = await store.get<Rec>(KEY);
  if (r?.ownerTag && r.ownerTag !== ownerTag) throw new ComputerError('bad_request', 403);
  const names = new Set(computerAccounts(env).filter((a) => a.prepared).map((a) => a.snapshot));
  for (const n of [r?.template?.name, r?.machine?.template, r?.snapshot?.name, ...(r?.snapshots ?? []).map((h) => h.name)]) if (n) names.add(n);
  return Object.freeze([...names]);
}

const sha256 = async (s: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, '0')).join('');

export class CloudbiteComputer extends DurableObject<ComputerEnv> {
  private svc: ComputerService;
  constructor(ctx: DurableObjectState, env: ComputerEnv) {
    super(ctx, env);
    const s = ctx.storage;
    this.svc = new ComputerService({
      env, daytona: restDaytona, now: Date.now, sha256,
      random: (n) => crypto.getRandomValues(new Uint8Array(n)),
      store: { get: (k) => s.get(k), put: (k, v) => s.put(k, v), setAlarm: (at) => s.setAlarm(at), deleteAlarm: () => s.deleteAlarm() },
      end: endHooks?.(env, s),
    });
  }
  computerState(ownerTag: string) { return this.svc.state(ownerTag); }
  computerStart(ownerTag: string, body: { requestId?: unknown; account?: unknown }) { return this.svc.start(ownerTag, body); }
  computerStop(ownerTag: string, body: { requestId?: unknown }) { return this.svc.stop(ownerTag, body); }
  computerExtend(ownerTag: string, body: { requestId?: unknown }) { return this.svc.extend(ownerTag, body); }
  computerSnapshot(ownerTag: string, body: { requestId?: unknown; name?: unknown }) { return this.svc.snapshot(ownerTag, body); }
  computerSnapshots(ownerTag: string) { return this.svc.snapshots(ownerTag); }
  computerSelectSnapshot(ownerTag: string, input: Record<string, unknown>) { return this.svc.selectSnapshot(ownerTag, input); }
  computerLaunch(ownerTag: string) { return this.svc.launch(ownerTag); }
  computerRedeemTicket(ticket: string) { return this.svc.redeemTicket(ticket); }
  computerDesktopUpstream(cookie: string) { return this.svc.desktopUpstream(cookie); }
  computerDesktopPreviewRejected(cookie: string) { return this.svc.desktopPreviewRejected(cookie); }
  computerMachine(ownerTag: string) { return this.svc.machine(ownerTag); }
  computerPerformance(ownerTag: string) { return this.svc.performance(ownerTag); }
  computerResize(ownerTag: string, input: Record<string, unknown>) { return this.svc.resize(ownerTag, input); }
  computerEnd(ownerTag: string, input: Record<string, unknown>) { return this.svc.end(ownerTag, input); }
  computerEndStatus(ownerTag: string) { return this.svc.endStatus(ownerTag); }
  computerEndSettings(ownerTag: string, input: Record<string, unknown>) { return this.svc.endSettings(ownerTag, input); }
  async alarm() { await this.svc.alarm(); }
}
