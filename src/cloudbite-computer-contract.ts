// CloudBite personal computer: one persistent owner Linux desktop in Daytona, state in the CloudbiteComputer DO.
// HTTP contract (root routes /api/cloudbite/computer/* to the DO methods after ownerCookieValid):
//   GET  state                         -> ComputerState            (never mutates cloud resources)
//   POST start    {requestId,account}  -> ComputerState            (create once, or resume the stopped machine)
//   POST stop     {requestId}          -> ComputerState            (filesystem and browser profile are kept)
//   POST extend   {requestId}          -> ComputerState            (session ends at most SESSION_MS from now)
//   POST snapshot {requestId,name}     -> ComputerState            (private cold filesystem capture; stops first, no RAM)
//   POST launch   {}                   -> {url}                    (gateway URL with a single-use short ticket)
//   GET  snapshots                     -> ComputerSnapshots        (own capture history; provider reads only, bounded re-checks)
//   POST snapshots/select {requestId,account,name|null} -> ComputerSnapshots (template for a FUTURE new machine; no provider mutation)
//   GET  performance                   -> ComputerPerformance      (cgroup sample cached >=10 s, estimated costs, hot-increase plans)
//   POST resize   {requestId,cpu,memoryGiB,acknowledgeCost:true} -> ComputerState (running CPU/RAM increase; pending until observed)
//   POST end      {requestId,mode}     -> ComputerEndState         (one-action safe end; the phase is stored, the alarm advances it)
//   GET  end                           -> ComputerEndState         (storage reads only; no provider call)
//   POST end/settings {requestId,autoEnd:mode|null} -> ComputerEndState (opt-in automatic safe end at the session deadline)
// requestId replays: same id + same arguments -> current state, or the original definite error; same id + other arguments
// -> request_conflict. Root-only RPCs: redeemTicket, desktopUpstream (cookie -> {origin,token,maxAge}; read-only fast path),
// desktopPreviewRejected (upstream 401/403 drops the cached preview) and machine(ownerTag) -> {id,account,name,labels,status,region}.
// Responses: {ok:true,...} or {error:{code,message}} with the fixed codes below. Provider URLs, tokens and keys never leave the DO.

export const COMPUTER_ACCOUNTS = ['primary', 'secondary', 'tertiary'] as const;
export type ComputerAccount = typeof COMPUTER_ACCOUNTS[number];
export type ComputerStatus = 'absent' | 'starting' | 'running' | 'stopped' | 'stopping' | 'snapshotting' | 'error' | 'unknown';
export type DesktopStatus = 'ready' | 'not_running' | 'starting' | 'missing_image' | 'unhealthy';

export const COMPUTER_ERRORS = {
  bad_request: 'The request is not valid.',
  request_conflict: 'This request id was already used for a different action.',
  not_configured: 'That Daytona account is not configured.',
  missing_image: 'The prepared CloudBite desktop image is not available in that account.',
  account_mismatch: 'Your computer lives in a different account. Accounts are never switched automatically.',
  absent: 'There is no computer yet. Start one first.',
  not_running: 'The computer is not running.',
  busy: 'Another change is still in progress. Wait and try again.',
  unknown_outcome: 'Daytona did not confirm the last change. CloudBite is checking it; do not retry yet.',
  provider_error: 'Daytona refused the change.',
  desktop_unavailable: 'The desktop is not ready yet.',
  snapshot_name: 'Use 3-63 lowercase letters, digits or dashes for the snapshot name.',
  snapshot_exists: 'A snapshot with that name already exists. Choose a new name; nothing was captured.',
  ticket_invalid: 'This desktop link is no longer valid. Open the computer again from CloudBite.',
  quota_exceeded: 'Daytona refused the increase: a resource quota or limit is reached. Nothing was changed.',
  resize_unavailable: 'Live resource increases are not available for this computer.',
  snapshot_not_selectable: 'Only a finished snapshot captured by this computer can be chosen. Nothing was changed.',
  snapshot_missing: 'That snapshot no longer exists in Daytona.',
  template_unavailable: 'The chosen snapshot is not available as a finished capture of this computer. Choose another one or clear the choice; nothing was created.',
  files_not_configured: 'Checked file saving is not set up for this computer. Use "End and keep environment" instead; nothing was changed.',
} as const;
export type ComputerErrorCode = keyof typeof COMPUTER_ERRORS;

export class ComputerError extends Error {
  constructor(public code: ComputerErrorCode, public status = 409) { super(COMPUTER_ERRORS[code]); }
}
export const computerErrorBody = (code: ComputerErrorCode) => ({ error: { code, message: COMPUTER_ERRORS[code] } });

export interface ComputerMachine { id: string | null; name: string; account: ComputerAccount; region: string | null; cpu: number | null; memoryGiB: number | null; diskGiB: number | null }
export interface ComputerSnapshotView { name: string; state: 'waiting_stop' | 'requesting' | 'unknown' | 'snapshotting' | 'active' | 'unconfirmed' | 'error'; error: string | null }
export interface ComputerState {
  status: ComputerStatus;
  error: ComputerErrorCode | null;
  machine: ComputerMachine | null;
  sessionEndsAt: string | null;
  snapshot: ComputerSnapshotView | null;
  desktop: DesktopStatus;
  configuredAccounts: Array<{ id: ComputerAccount; label: string; available: boolean }>;
  ready: boolean;
  tools?: readonly { id: string; status: string; version: string | null }[];
  /** Selected template for a future new machine (never applied to the current one). */
  template?: { account: ComputerAccount; name: string } | null;
  /** Current or last safe end; null when none was requested. */
  end?: ComputerEndView | null;
}

// Safe end. disk_backup: flush the filesystem, stop with the disk kept, then an optional private cold capture of the whole disk
// (local files included; no exclusion is claimed). files_verified: additionally requires the managed files drain to prove every
// managed file remotely saved before the stop; otherwise the end is blocked and the machine keeps running. Neither mode deletes
// the machine or its disk, and neither saves RAM or unsaved application buffers. Files and environment backup are separate states.
export const COMPUTER_END_MODES = ['disk_backup', 'files_verified'] as const;
export type ComputerEndMode = typeof COMPUTER_END_MODES[number];
export const isEndMode = (v: unknown): v is ComputerEndMode => typeof v === 'string' && (COMPUTER_END_MODES as readonly string[]).includes(v);
/** draining → stopping → backing_up → done; blocked/failed/cancelled are terminal with the disk kept. */
export type ComputerEndPhase = 'draining' | 'stopping' | 'backing_up' | 'done' | 'blocked' | 'failed' | 'cancelled';
export type ComputerEndTrigger = 'user' | 'deadline' | 'provider_stop';
/** External managed files only. pending = the deadline stopped the machine before the drain proved anything (disk kept). */
export type ComputerEndFiles = 'not_configured' | 'unverified' | 'verifying' | 'verified' | 'blocked' | 'pending';
/** Environment backup as reported by the injected backup manager; coalesced = no new capture, the previous one is kept. */
export type ComputerEndBackup = 'not_configured' | 'not_requested' | 'pending' | 'active' | 'coalesced' | 'failed' | 'blocked' | 'unknown';
/** Combined agent + watcher prepare-end report. A bare agent journal with zero entries is not proof by itself. */
export interface ComputerDrainReport {
  agentReady: boolean; managedScanComplete: boolean; scanLimited: boolean;
  dirty: number; uploading: number; conflict: number; unconfirmedOps: number; open: number; pendingDeletions: number; errors: number;
}
export type ComputerDrainResult = { ok: true; report: ComputerDrainReport } | { ok: false; code: string; retryable: boolean };
/** Verified only when every flag proves it; anything missing, non-numeric or non-zero is not verified. */
export function computerDrainVerified(r: ComputerDrainReport | null | undefined): boolean {
  if (!r || r.agentReady !== true || r.managedScanComplete !== true || r.scanLimited !== false) return false;
  return (['dirty', 'uploading', 'conflict', 'unconfirmedOps', 'open', 'pendingDeletions', 'errors'] as const).every((k) => r[k] === 0);
}
export interface ComputerEndView {
  requestId: string; mode: ComputerEndMode; trigger: ComputerEndTrigger; phase: ComputerEndPhase;
  files: ComputerEndFiles; filesVerifiedAt: string | null; filesDetail: ComputerDrainReport | null;
  /** Result of the best-effort filesystem flush before the stop (null = not attempted). */
  diskFlushed: boolean | null;
  machineStopped: boolean; environmentBackup: ComputerEndBackup; backupName: string | null;
  error: ComputerErrorCode | null; startedAt: string; updatedAt: string;
}
/**
 * Backups manager answer (src/cloudbite-computer-backups.ts). active/coalesced/failed/blocked end the backing_up phase;
 * work = retention/capture still needs tick() after that (the alarm keeps ticking, bounded). coalesced = the previous
 * recovery point is reused: newer changes are only on the kept disk, not in a fresh backup.
 */
export interface ComputerBackupStatus {
  state: 'pending' | 'active' | 'coalesced' | 'failed' | 'blocked' | 'unknown'; name?: string | null; reason?: string | null; work?: boolean;
}
export interface ComputerEndState {
  end: ComputerEndView | null;
  /** Latest backups manager status (storage read); null when no manager is wired or it did not answer. */
  backup?: ComputerBackupStatus | null;
  autoEnd: ComputerEndMode | null;
  modes: Record<ComputerEndMode, boolean>;
  backupConfigured: boolean;
  /** True while an end is draining or stopping: the files runtime refuses new managed uploads. */
  uploadsFrozen: boolean;
}
export const COMPUTER_SNAPSHOT_HISTORY_MAX = 20;
export type ComputerSnapshotHistoryState = Exclude<ComputerSnapshotView['state'], 'waiting_stop'> | 'missing';
/** One own capture: requested by this owner from its machine (collisions with foreign snapshots never appear here). */
export interface ComputerSnapshotItem {
  name: string; account: ComputerAccount; requestedAt: string; state: ComputerSnapshotHistoryState; error: ComputerErrorCode | null;
  checkedAt: string | null; selected: boolean; selectable: boolean;
}
export interface ComputerSnapshots {
  items: ComputerSnapshotItem[];
  selected: { account: ComputerAccount; name: string } | null;
  latest: ComputerSnapshotView | null;
  machine: { status: ComputerStatus; account: ComputerAccount | null; id: string | null; template: string | null };
  historyMax: number;
}
/** Internal identity for root RPC only (nested-compute setup); never contains provider URLs, tokens or keys. */
export interface ComputerMachineRef { id: string; account: ComputerAccount; name: string; labels: Record<string, string>; status: ComputerStatus; region?: string | null }
export interface ComputerPerformance {
  machineId: string; sampledAt: string | null;
  metrics: null | { cpuPercent: number | null; memoryUsedGiB: number; memoryLimitGiB: number; memoryPercent: number; load1: number };
  current: { cpu: number; memoryGiB: number; diskGiB: number; usdPerHour: number };
  plans: Array<{ cpu: number; memoryGiB: number; usdPerHour: number; deltaUsdPerHour: number }>;
  resize: { status: 'idle' | 'pending' | 'failed'; cpu?: number; memoryGiB?: number; error?: ComputerErrorCode };
  pricing: { asOf: string; url: string; estimated: true };
}

export const COMPUTER_DESKTOP_PATH = '/p/_cloudbite/computer/desktop';
export const COMPUTER_DESKTOP_PORT = 8082;
export const COMPUTER_DESKTOP_HEALTH = `${COMPUTER_DESKTOP_PATH}/api/health`;
export const COMPUTER_START_SCRIPT = '/opt/cloudbite/computer/bin/cloudbite-start-desktop'; // fixed launcher in the prepared image
// No fallback image: a plain daytona-large sandbox has no desktop payload, so an unset snapshot means missing_image.
export const COMPUTER_SESSION_MS = 2 * 60 * 60 * 1000;
export const COMPUTER_AUTO_STOP_MINUTES = 130;  // provider backstop; DO stops at the explicit 2h deadline
export const COMPUTER_POLL_MS = 10_000;
export const COMPUTER_TICKET_MS = 60_000;
export const COMPUTER_TICKET_PARAM = 'cbt';
export const COMPUTER_COOKIE = '__Host-cb_computer';
export const COMPUTER_LABEL_OWNER = 'cloudbite-computer';
export const COMPUTER_LABEL_ACCOUNT = 'cloudbite-computer-account';
/** Daytona documents preview URLs as https://{port}-{sandboxId}.proxy.daytona.works; root may override per deployment. */
export const COMPUTER_PROXY_SUFFIXES = ['.proxy.daytona.works'];

export const COMPUTER_REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const COMPUTER_SNAPSHOT_NAME = /^[a-z0-9][a-z0-9-]{2,62}$/;
export const COMPUTER_OWNER_TAG = /^[a-z0-9]{8,32}$/;
/** Same stable hex identity for the HTTP router and deployment bootstrap; State.sha uses base64url instead. */
export async function computerOwnerTag(): Promise<string> {
  const d=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode('cloudbite-personal-computer-owner-v1')));
  return [...d].map(v=>v.toString(16).padStart(2,'0')).join('').slice(0,24);
}

/** Env subset the computer reads. Keys are Worker secrets; the snapshot is organization-scoped and never inherited. */
export interface ComputerEnv {
  CLOUDBITE_COMPUTER_HOT_RESIZE_ENABLED?: string;
  CLOUDBITE_COMPUTER_NOSANA_API_KEY?: string;
  CLOUDBITE_DAYTONA_API_URL?: string;
  CLOUDBITE_DAYTONA_API_KEY?: string;
  CLOUDBITE_DAYTONA_SECONDARY_API_URL?: string;
  CLOUDBITE_DAYTONA_SECONDARY_API_KEY?: string;
  CLOUDBITE_DAYTONA_TERTIARY_API_URL?: string;
  CLOUDBITE_DAYTONA_TERTIARY_API_KEY?: string;
  CLOUDBITE_COMPUTER_SNAPSHOT?: string;
  CLOUDBITE_COMPUTER_SECONDARY_SNAPSHOT?: string;
  CLOUDBITE_COMPUTER_TERTIARY_SNAPSHOT?: string;
  CLOUDBITE_COMPUTER_GATEWAY_ORIGIN?: string;   // e.g. https://cloudbite-v001.ai-gongbu.workers.dev
  CLOUDBITE_COMPUTER_PROXY_SUFFIXES?: string;   // comma separated, each starting with '.'
}

export interface ComputerAccountConfig { id: ComputerAccount; api: string; key: string; snapshot: string; prepared: boolean }

const DEFAULT_API = 'https://app.daytona.io/api';

/** Explicit accounts only: secondary/tertiary need their own key; a prepared snapshot must be named for that account. */
export function computerAccounts(env: ComputerEnv): ComputerAccountConfig[] {
  const raw: Array<[ComputerAccount, string | undefined, string | undefined, string | undefined]> = [
    ['primary', env.CLOUDBITE_DAYTONA_API_KEY, env.CLOUDBITE_DAYTONA_API_URL, env.CLOUDBITE_COMPUTER_SNAPSHOT],
    ['secondary', env.CLOUDBITE_DAYTONA_SECONDARY_API_KEY, env.CLOUDBITE_DAYTONA_SECONDARY_API_URL ?? env.CLOUDBITE_DAYTONA_API_URL, env.CLOUDBITE_COMPUTER_SECONDARY_SNAPSHOT],
    ['tertiary', env.CLOUDBITE_DAYTONA_TERTIARY_API_KEY, env.CLOUDBITE_DAYTONA_TERTIARY_API_URL ?? env.CLOUDBITE_DAYTONA_API_URL, env.CLOUDBITE_COMPUTER_TERTIARY_SNAPSHOT],
  ];
  return raw.filter(([, key]) => !!key).map(([id, key, api, snapshot]) => ({
    id, key: key!, api: (api || DEFAULT_API).replace(/\/+$/, ''), snapshot: snapshot ?? '', prepared: !!snapshot,
  }));
}

export function computerProxySuffixes(env: ComputerEnv): string[] {
  const list = (env.CLOUDBITE_COMPUTER_PROXY_SUFFIXES ?? '').split(',').map((s) => s.trim().toLowerCase()).filter((s) => /^\.[a-z0-9.-]+\.[a-z]{2,}$/.test(s));
  return list.length ? list : COMPUTER_PROXY_SUFFIXES;
}

/** Deterministic, owner-scoped identity: the same owner and account always map to one Daytona name and label set. */
export function computerName(ownerTag: string, account: ComputerAccount) {
  if (!COMPUTER_OWNER_TAG.test(ownerTag)) throw new ComputerError('bad_request', 400);
  return `cloudbite-computer-${account}-${ownerTag}`;
}
export const computerLabels = (ownerTag: string, account: ComputerAccount): Record<string, string> =>
  ({ [COMPUTER_LABEL_OWNER]: ownerTag, [COMPUTER_LABEL_ACCOUNT]: account });

export const isAccount = (v: unknown): v is ComputerAccount => typeof v === 'string' && (COMPUTER_ACCOUNTS as readonly string[]).includes(v);
