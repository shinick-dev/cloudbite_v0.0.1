// CloudBite personal computer: one persistent owner Linux desktop in Daytona, state in the CloudbiteComputer DO.
// HTTP contract (root routes /api/cloudbite/computer/* to the DO methods after ownerCookieValid):
//   GET  state                         -> ComputerState            (never mutates cloud resources)
//   POST start    {requestId,account}  -> ComputerState            (create once, or resume the stopped machine)
//   POST stop     {requestId}          -> ComputerState            (filesystem and browser profile are kept)
//   POST extend   {requestId}          -> ComputerState            (session ends at most SESSION_MS from now)
//   POST snapshot {requestId,name}     -> ComputerState            (private cold filesystem capture; stops first, no RAM)
//   POST launch   {}                   -> {url}                    (gateway URL with a single-use short ticket)
// requestId replays: same id + same arguments -> current state, or the original definite error; same id + other arguments
// -> request_conflict. Root-only RPCs: redeemTicket, desktopUpstream (cookie -> {origin,token,maxAge}; read-only fast path),
// desktopPreviewRejected (upstream 401/403 drops the cached preview) and machine(ownerTag) -> {id,account,name,labels,status}.
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
}
/** Internal identity for root RPC only (nested-compute setup); never contains provider URLs, tokens or keys. */
export interface ComputerMachineRef { id: string; account: ComputerAccount; name: string; labels: Record<string, string>; status: ComputerStatus }

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

/** Env subset the computer reads. Keys are Worker secrets; the snapshot is organization-scoped and never inherited. */
export interface ComputerEnv {
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
