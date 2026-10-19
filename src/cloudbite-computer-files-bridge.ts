// Cloud Files VM bridge: installs the files agent, the workspace watcher and the private machine-scoped capability on
// the owner's current running computer, launches the bounded watcher session, and drives explicit materialize/status
// through the agent CLI. Dependency-injected (contract: docs/cloudbite/files-bridge.md). Never starts, stops, restarts
// or snapshots a machine; touches only the fixed private directory and the dedicated workspace root below.
// The capability token travels only inside an upload body to a 0600 placeholder; never in argv, logs or responses.
import type { Dt } from './lab';
import type { CbSandbox } from './cloudbite-daytona';

// Must equal FILES_AGENT_PATH in cloudbite-computer-files-runtime.ts and AGENT_PREFIX in files-agent.py.
export const FILES_AGENT_PREFIX = '/p/_cloudbite/computer/files/agent/v1';
export const FILES_CAPABILITY_SCHEMA = 'cloudbite.files.agent-capability.v1';

const BASE = '/home/daytona/.local/share/cloudbite-files';
export const FILES_BRIDGE_PATHS = {
  base: BASE,
  agent: `${BASE}/agent/files-agent.py`,
  capability: `${BASE}/capability.json`,
  state: `${BASE}/state`,
  manifests: `${BASE}/manifests`,
  ownerMarker: `${BASE}/owner`,
  rootMarker: `${BASE}/root-owned`,
  root: '/home/daytona/CloudFiles',
  watcher: `${BASE}/agent/files-watch.py`,
  watchState: `${BASE}/watch`,
  watchLog: `${BASE}/watch.log`,
} as const;
/** Toolbox session that runs the watcher in the background (process/execute would reap it). */
export const FILES_WATCH_SESSION = 'cloudbite-files-watch';

export const FILES_BRIDGE_LIMITS = {
  agentSourceBytes: 256 * 1024,
  watchSourceBytes: 256 * 1024,
  /** Watcher `run` lifetime: never past MAX_RUNTIME in files-watch.py nor the capability it syncs with. */
  watchMaxRuntimeS: 6 * 3600,
  watchMinRuntimeS: 60,
  watchKillGraceS: 30,
  watchLogBytes: 1024 * 1024,
  watchResumeTimeoutS: 60,
  manifestEntries: 64,
  manifestBytes: 64 * 1024,
  outputBytes: 64 * 1024,
  capabilityMinTtlMs: 60_000,
  installTimeoutS: 30,
  materializeTimeoutS: 180,
  prepareEndTimeoutS: 300,
} as const;

/** Runtime `filesAgentGrant` body (cloudbite-computer-files-runtime.ts). */
export interface FilesAgentGrant { token: string; machineId: string; writerEpoch: number; workspaceId: string; expiresAt: number; endpoint: string }
export type FilesGrantResult = { ok: true; body: FilesAgentGrant } | { error: { code?: unknown; message?: unknown; retryable?: unknown }; status: number };
export interface FilesBridgeMachine { id: string; name: string; account: string }
export type FilesManifestEntry =
  | { kind: 'dir'; fileId: string; path: string }
  | { kind: 'file'; fileId: string; path: string; versionId: string; size: number; sha256: string };

export interface FilesBridgeDeps {
  /** Configured CLOUDBITE_GATEWAY_URL: the only origin a capability endpoint may name. */
  gateway: string;
  /** Current RUNNING machine of this owner, or null. Must never start one. */
  machine(): Promise<FilesBridgeMachine | null>;
  account(accountId: string): Dt | null;
  labels(accountId: string): Record<string, string>;
  getSandbox(c: Dt, id: string): Promise<CbSandbox | null>;
  exec(c: Dt, sb: CbSandbox, command: string, timeoutS: number): Promise<{ exitCode: number; result: string }>;
  upload(c: Dt, sb: CbSandbox, path: string, content: string): Promise<void>;
  /** Asynchronous command in a toolbox session; resolving means submitted, not running. */
  spawn(c: Dt, sb: CbSandbox, sessionId: string, command: string): Promise<void>;
  agentSource: string;
  watchSource: string;
  /** Mints the scoped machine capability (root wires filesAgentGrant for this exact machine). */
  grant(req: { machine: FilesBridgeMachine; requestId: string }): Promise<FilesGrantResult>;
  now?: () => number;
}

export type FilesBridgeError = 'not_configured' | 'bad_request' | 'not_running' | 'ownership_mismatch'
  | 'workspace_exists_unowned' | 'base_exists_unowned' | 'install_failed' | 'agent_not_installed' | 'agent_failed' | 'unknown_outcome';
export interface FilesBridgeResult { status: number; body: Record<string, unknown> }

const STATUS: Record<FilesBridgeError, number> = {
  not_configured: 503, bad_request: 400, not_running: 409, ownership_mismatch: 409, workspace_exists_unowned: 409, base_exists_unowned: 409,
  install_failed: 502, agent_not_installed: 409, agent_failed: 409, unknown_outcome: 503,
};
const fail = (code: FilesBridgeError, status = STATUS[code]): FilesBridgeResult => ({ status, body: { error: { code, message: code } } });

const IDENT = /^[A-Za-z0-9._:-]{1,128}$/;
const MACHINE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;   // leading '-' would read as a CLI option
const REQUEST = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^[A-Za-z0-9._~+/=-]{32,512}$/;
const HEX = /^[0-9a-f]{64}$/;
const AGENT_CODE = /^[a-z_]{1,48}$/;
const utf8 = new TextEncoder();

/** https://host[:port] with nothing else, or null. */
export function filesBridgeOrigin(origin: unknown): string | null {
  if (typeof origin !== 'string') return null;
  let u: URL;
  try { u = new URL(origin); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) return null;
  return u.origin === origin.replace(/\/$/, '') ? u.origin : null;
}

/** Exact agent endpoint for a configured gateway, or null. */
export function filesBridgeEndpoint(gateway: unknown): string | null {
  const origin = filesBridgeOrigin(gateway);
  return origin && origin + FILES_AGENT_PREFIX;
}

function validGrant(cap: unknown, machineId: string, endpoint: string, now: number): cap is FilesAgentGrant {
  const c = cap as FilesAgentGrant;
  return !!c && typeof c === 'object' && typeof c.token === 'string' && TOKEN.test(c.token) && c.endpoint === endpoint
    && c.machineId === machineId && typeof c.workspaceId === 'string' && IDENT.test(c.workspaceId) && !c.workspaceId.startsWith('-')
    && Number.isSafeInteger(c.writerEpoch) && c.writerEpoch >= 1
    && Number.isSafeInteger(c.expiresAt) && c.expiresAt > now + FILES_BRIDGE_LIMITS.capabilityMinTtlMs;
}

/** Validates a server-built manifest (dir chain + exactly one file). Path checks mirror the agent's; the agent re-checks. */
export function filesBridgeManifest(manifest: unknown, fileId: string, versionId: string): FilesManifestEntry[] | null {
  if (!Array.isArray(manifest) || manifest.length < 1 || manifest.length > FILES_BRIDGE_LIMITS.manifestEntries) return null;
  let files = 0;
  for (const e of manifest as FilesManifestEntry[]) {
    if (!e || typeof e !== 'object' || typeof e.fileId !== 'string' || !IDENT.test(e.fileId) || typeof e.path !== 'string') return null;
    const parts = e.path.split('/');
    if (utf8.encode(e.path).byteLength > 4096 || e.path.startsWith('/') || e.path.includes('\\')
      || /[\u0000-\u001f\u007f]/.test(e.path) || parts.some(p => p === '' || p === '.' || p === '..')) return null;
    if (e.kind === 'dir') { if (Object.keys(e).length !== 3) return null; continue; }
    if (e.kind !== 'file' || Object.keys(e).length !== 6 || typeof e.versionId !== 'string' || !IDENT.test(e.versionId)
      || !Number.isSafeInteger(e.size) || e.size < 0 || typeof e.sha256 !== 'string' || !HEX.test(e.sha256)) return null;
    if (e.fileId !== fileId || e.versionId !== versionId) return null;
    files++;
  }
  if (files !== 1) return null;
  const json = JSON.stringify(manifest);
  return utf8.encode(json).byteLength <= FILES_BRIDGE_LIMITS.manifestBytes ? manifest as FilesManifestEntry[] : null;
}

/** Last JSON object line of agent output, bounded. */
function agentJson(out: string): Record<string, unknown> | null {
  const text = typeof out === 'string' ? out.slice(-FILES_BRIDGE_LIMITS.outputBytes) : '';
  const line = text.trim().split('\n').reverse().find(l => l.trim().startsWith('{'));
  if (!line) return null;
  try { const v = JSON.parse(line); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch { return null; }
}

const agentCode = (v: Record<string, unknown> | null) =>
  typeof v?.code === 'string' && AGENT_CODE.test(v.code) ? v.code : 'agent_failed';

interface Owned { c: Dt; sb: CbSandbox; machine: FilesBridgeMachine }

/** Current running machine, proven owned by exact name and every label. No provider write happens before this. */
async function owned(deps: FilesBridgeDeps): Promise<Owned | FilesBridgeResult> {
  if (!filesBridgeEndpoint(deps.gateway)) return fail('not_configured');
  const machine = await deps.machine();
  if (!machine || typeof machine.id !== 'string' || !MACHINE.test(machine.id)) return fail('not_running');
  const c = deps.account(machine.account);
  if (!c) return fail('not_configured');
  let sb: CbSandbox | null;
  try { sb = await deps.getSandbox(c, machine.id); } catch { return fail('unknown_outcome'); }
  const labels = deps.labels(machine.account);
  if (!sb || sb.id !== machine.id || (sb as { name?: string }).name !== machine.name
    || !Object.keys(labels).length || !Object.entries(labels).every(([k, v]) => sb!.labels?.[k] === v)) return fail('ownership_mismatch');
  if (sb.state !== 'started') return fail('not_running');
  return { c, sb, machine };
}

const isResult = (v: object): v is FilesBridgeResult => 'status' in v && 'body' in v;
const P = FILES_BRIDGE_PATHS;
const agentCmd = (args: string) => `python3 ${P.agent} --state ${P.state} --capability ${P.capability} ${args}`;

// Fixed script; the only interpolated values are the validated machine/workspace identifiers of the owner marker.
// Every check runs before the first write: no fixed path component (.local, .local/share, base, its subdirs, the
// marker, the watcher log, the workspace root) may be a symlink or of the wrong type; an existing base must carry this
// exact owner marker (machine + workspace), and an existing workspace root must have been created by this bridge.
// Otherwise nothing is touched (41 symlink/type, 44 unowned base, 42 unowned root). Placeholders are created 0600
// before any secret byte.
const ownerMark = (machineId: string, workspaceId: string) => `cloudbite-files-bridge v1 machine=${machineId} workspace=${workspaceId}`;
const HOME = P.root.slice(0, P.root.lastIndexOf('/'));
export function filesBridgePrepareScript(machineId: string, workspaceId: string): string {
  if (!MACHINE.test(machineId) || !IDENT.test(workspaceId) || workspaceId.startsWith('-')) throw new Error('bad identifier');
  return `bash -c 'set -eu; umask 077; H=${HOME}; L=$H/.local; S=$L/share; B=${P.base}; R=${P.root}; `
    + `M="${ownerMark(machineId, workspaceId)}"; `
    + `for p in "$L" "$S" "$B" "$B/agent" "$B/state" "$B/manifests" "$B/watch" "$B/owner" "$B/root-owned" "$B/watch.log" "$R"; do if [ -L "$p" ]; then exit 41; fi; done; `
    + `for p in "$L" "$S" "$B" "$B/agent" "$B/state" "$B/manifests" "$B/watch" "$R"; do if [ -e "$p" ] && [ ! -d "$p" ]; then exit 41; fi; done; `
    + `if [ -e "$B/watch.log" ] && [ ! -f "$B/watch.log" ]; then exit 41; fi; `
    + `fresh=1; if [ -e "$B" ]; then fresh=0; if [ ! -f "$B/owner" ] || [ "$(head -c 512 "$B/owner")" != "$M" ]; then exit 44; fi; fi; `
    + `if [ -e "$R" ] && { [ "$fresh" = 1 ] || [ ! -f "$B/root-owned" ]; }; then exit 42; fi; `
    + `mkdir -p "$S"; if [ "$fresh" = 1 ]; then mkdir -m 700 "$B"; printf "%s" "$M" > "$B/owner"; fi; `
    + `mkdir -p "$B/agent" "$B/state" "$B/manifests" "$B/watch"; `
    + `if [ ! -e "$R" ]; then mkdir -m 700 "$R"; : > "$B/root-owned"; fi; `
    + `rm -f "$B/agent/files-agent.py.next" "$B/agent/files-watch.py.next" "$B/capability.json.next"; `
    + `install -m 600 /dev/null "$B/agent/files-agent.py.next"; install -m 600 /dev/null "$B/agent/files-watch.py.next"; `
    + `install -m 600 /dev/null "$B/capability.json.next"'`;
}
// Uploaded placeholders must still be regular files (not swapped for symlinks) before they become live.
const activate = (files: readonly string[]) => `bash -c 'set -eu; B=${P.base}; for f in ${files.map(f => `"$B/${f}.next"`).join(' ')}; do `
  + `if [ -L "$f" ] || [ ! -f "$f" ]; then exit 45; fi; done; chmod 600 ${files.map(f => `"$B/${f}.next"`).join(' ')}; `
  + files.map(f => `mv -f "$B/${f}.next" "$B/${f}"`).join('; ') + `'`;
const ACTIVATE = activate(['agent/files-agent.py', 'agent/files-watch.py', 'capability.json']);
const ACTIVATE_CAPABILITY = activate(['capability.json']);

// Read-only probe of a prior install by this bridge for this machine (any workspace): 0 installed, 43 not installed or
// not this machine's, 41 a fixed component is a symlink. Writes nothing, so an unconfigured machine stays untouched.
export function filesBridgeProbeScript(machineId: string): string {
  if (!MACHINE.test(machineId)) throw new Error('bad identifier');
  return `bash -c 'H=${HOME}; B=${P.base}; `
    + `for p in "$H/.local" "$H/.local/share" "$B" "$B/agent" "$B/state" "$B/watch" "$B/owner" "$B/agent/files-agent.py" "$B/agent/files-watch.py" "$B/capability.json"; do `
    + `if [ -L "$p" ]; then exit 41; fi; done; `
    + `for p in "$B/owner" "$B/agent/files-agent.py" "$B/agent/files-watch.py" "$B/capability.json" "$B/state/journal.sqlite3"; do if [ ! -f "$p" ]; then exit 43; fi; done; `
    + `case "$(head -c 512 "$B/owner")" in "cloudbite-files-bridge v1 machine=${machineId} workspace="*) exit 0;; esac; exit 43'`;
}
// Capability refresh on an installed machine: same symlink/type/owner-marker guards as prepare, then one fresh 0600
// placeholder; nothing else is created (an uninstalled machine answers 43 and is left alone).
export function filesBridgeRefreshScript(machineId: string, workspaceId: string): string {
  if (!MACHINE.test(machineId) || !IDENT.test(workspaceId) || workspaceId.startsWith('-')) throw new Error('bad identifier');
  return `bash -c 'set -eu; umask 077; H=${HOME}; B=${P.base}; M="${ownerMark(machineId, workspaceId)}"; `
    + `for p in "$H/.local" "$H/.local/share" "$B" "$B/agent" "$B/state" "$B/watch" "$B/owner" "$B/capability.json"; do if [ -L "$p" ]; then exit 41; fi; done; `
    + `for p in "$B" "$B/agent" "$B/state" "$B/watch"; do if [ ! -d "$p" ]; then exit 43; fi; done; `
    + `if [ ! -f "$B/owner" ] || [ "$(head -c 512 "$B/owner")" != "$M" ]; then exit 44; fi; `
    + `rm -f "$B/capability.json.next"; install -m 600 /dev/null "$B/capability.json.next"'`;
}

// Watcher CLI with every path fixed (the watcher pins them in its private config at first use; the capability file is
// passed through to the agent and never read by the watcher).
const watchCmd = (args: string) => `python3 -I -B ${P.watcher} --state ${P.watchState} --agent ${P.agent} --agent-state ${P.state} `
  + `--capability ${P.capability} --root ${P.root} ${args}`;
const WATCH_RESUME = `bash -c 'test -f ${P.watcher} && test ! -L ${P.watcher} && test -f ${P.agent} || exit 43; ${watchCmd('resume')}'`;
/** Background watcher run, bounded twice: `--max-runtime` inside, `timeout` (then SIGKILL) outside. A second launch while
 *  one runs exits at once on the watcher lock (watcher_busy), so the session never holds two workers. Output (JSON
 *  metadata only) goes to the private log, truncated when it passes the cap. */
export function filesBridgeWatchRunScript(runtimeS: number): string {
  const L = FILES_BRIDGE_LIMITS;
  if (!Number.isSafeInteger(runtimeS) || runtimeS < L.watchMinRuntimeS || runtimeS > L.watchMaxRuntimeS) throw new Error('bad runtime');
  return `bash -c 'umask 077; G=${P.watchLog}; for p in ${P.base} ${P.watcher} "$G"; do if [ -L "$p" ]; then exit 41; fi; done; `
    + `test -f ${P.watcher} || exit 43; if [ -e "$G" ] && [ ! -f "$G" ]; then exit 41; fi; `
    + `if [ -f "$G" ] && [ "$(stat -c %s "$G")" -gt ${L.watchLogBytes} ]; then : > "$G"; fi; `
    + `exec timeout -k ${L.watchKillGraceS} ${runtimeS + L.watchKillGraceS} ${watchCmd(`run --max-runtime ${runtimeS}`)} >> "$G" 2>&1'`;
}
export const FILES_BRIDGE_SCRIPTS = {
  prepare: filesBridgePrepareScript, activate: ACTIVATE, activateCapability: ACTIVATE_CAPABILITY, probe: filesBridgeProbeScript,
  refresh: filesBridgeRefreshScript, watchResume: WATCH_RESUME, watchRun: filesBridgeWatchRunScript,
} as const;

const sourceOk = (s: unknown, max: number) =>
  typeof s === 'string' && s.startsWith('#!/usr/bin/env python3') && utf8.encode(s).byteLength <= max;

/** Mints the capability for the proven machine; the result is either a validated grant or the refusal to return. */
async function grantFor(deps: FilesBridgeDeps, o: Owned, requestId: string, now: number): Promise<FilesAgentGrant | FilesBridgeResult> {
  let grant: FilesGrantResult;
  try { grant = await deps.grant({ machine: o.machine, requestId }); }
  catch { return fail('unknown_outcome'); }
  if (!grant || !('ok' in grant) || grant.ok !== true) {
    const e = grant && 'error' in grant ? grant : null;
    const code = typeof e?.error?.code === 'string' && AGENT_CODE.test(e.error.code) ? e.error.code : 'install_failed';
    const status = Number.isInteger(e?.status) && e!.status >= 400 && e!.status < 600 ? e!.status : 502;
    return { status, body: { error: { code, message: code } } };
  }
  return validGrant(grant.body, o.machine.id, filesBridgeEndpoint(deps.gateway)!, now) ? grant.body : fail('install_failed');
}

const capabilityFile = (cap: FilesAgentGrant) => JSON.stringify({ schema: FILES_CAPABILITY_SCHEMA, endpoint: cap.endpoint, token: cap.token,
  machineId: cap.machineId, workspaceId: cap.workspaceId, writerEpoch: cap.writerEpoch, expiresAt: cap.expiresAt });

/** Watcher run length for a capability: whole seconds, at most 6 h and never past the capability expiry. */
export function filesBridgeWatchRuntime(expiresAt: number, now: number): number {
  const L = FILES_BRIDGE_LIMITS;
  return Math.max(L.watchMinRuntimeS, Math.min(L.watchMaxRuntimeS, Math.floor((expiresAt - now) / 1000) - L.watchKillGraceS));
}

/** Watcher `resume` (clears its pause/draining and resumes the agent; deferred to the running watcher when it holds the
 *  lock), then one bounded background `run`. `launch: 'submitted'` is the provider's acceptance of the async command,
 *  not an observation that the watcher is running. Throws only when the outcome of a provider call is unknown. */
async function startWatcher(deps: FilesBridgeDeps, o: Owned, cap: FilesAgentGrant, now: number): Promise<Record<string, unknown> | FilesBridgeResult> {
  const r = await deps.exec(o.c, o.sb, WATCH_RESUME, FILES_BRIDGE_LIMITS.watchResumeTimeoutS);
  if (r.exitCode === 43) return fail('agent_not_installed');
  const out = agentJson(r.result);
  if (r.exitCode !== 0 || out?.ok !== true) return { status: 409, body: { error: { code: agentCode(out), message: 'watch_resume' } } };
  await deps.spawn(o.c, o.sb, FILES_WATCH_SESSION, filesBridgeWatchRunScript(filesBridgeWatchRuntime(cap.expiresAt, now)));
  return { resumed: out.deferred === true ? 'deferred' : true, agentResumed: out.deferred === true ? null : out.agentResumed === true,
    launch: 'submitted', running: 'not_observed' };
}

/** Explicit install/refresh on the current running owned machine: agent, watcher, capability, agent init, watcher
 *  resume + bounded background run. Paid-free: no start, no snapshot. Repeating it is safe (one watcher holds the lock). */
export async function filesBridgeInstall(deps: FilesBridgeDeps, req: { requestId?: unknown }): Promise<FilesBridgeResult> {
  if (typeof req?.requestId !== 'string' || !REQUEST.test(req.requestId)) return fail('bad_request');
  if (!sourceOk(deps.agentSource, FILES_BRIDGE_LIMITS.agentSourceBytes) || !sourceOk(deps.watchSource, FILES_BRIDGE_LIMITS.watchSourceBytes)
    || typeof deps.spawn !== 'function') return fail('not_configured');
  const o = await owned(deps);
  if (isResult(o)) return o;
  const now = (deps.now ?? Date.now)();
  const cap = await grantFor(deps, o, req.requestId, now);
  if (isResult(cap)) return cap;
  const g = cap;
  let watcher: Record<string, unknown> | FilesBridgeResult;
  try {
    const prep = await deps.exec(o.c, o.sb, filesBridgePrepareScript(g.machineId, g.workspaceId), FILES_BRIDGE_LIMITS.installTimeoutS);
    if (prep.exitCode === 42) return fail('workspace_exists_unowned');
    if (prep.exitCode === 44) return fail('base_exists_unowned');
    if (prep.exitCode !== 0) return fail('install_failed');
    await deps.upload(o.c, o.sb, `${P.agent}.next`, deps.agentSource);
    await deps.upload(o.c, o.sb, `${P.watcher}.next`, deps.watchSource);
    await deps.upload(o.c, o.sb, `${P.capability}.next`, capabilityFile(g));
    const act = await deps.exec(o.c, o.sb, ACTIVATE, FILES_BRIDGE_LIMITS.installTimeoutS);
    if (act.exitCode !== 0) return fail('install_failed');
    const init = await deps.exec(o.c, o.sb, `python3 ${P.agent} --state ${P.state} init --root ${P.root} `
      + `--workspace-id=${g.workspaceId} --machine-id=${g.machineId} --writer-epoch=${g.writerEpoch}`, FILES_BRIDGE_LIMITS.installTimeoutS);
    const initOut = agentJson(init.result);
    if (init.exitCode !== 0 || initOut?.ok !== true) return { status: 409, body: { error: { code: agentCode(initOut), message: 'agent_init' } } };
    const check = agentJson((await deps.exec(o.c, o.sb, agentCmd('status'), FILES_BRIDGE_LIMITS.installTimeoutS)).result);
    if (check?.ok !== true || check.transportConfigured !== true) return { status: 409, body: { error: { code: agentCode(check), message: 'agent_status' } } };
  } catch { return fail('install_failed'); }
  try { watcher = await startWatcher(deps, o, g, now); } catch { return fail('unknown_outcome'); }
  if (isResult(watcher)) return watcher;
  return { status: 200, body: { ok: true, installed: true, machineId: g.machineId, writerEpoch: g.writerEpoch, expiresAt: g.expiresAt, watcher } };
}

/** Continuous sync after an ordinary stop/start (or a blocked/cancelled end) of the SAME machine. Only a machine this
 *  bridge already installed is touched: a read-only probe comes first and an uninstalled or foreign machine is skipped
 *  untouched. Then a fresh capability (the caller has proven this machine is already the files writer), the watcher
 *  resume and one bounded background run. Idempotent; never installs, starts or promotes anything. */
export async function filesBridgeResume(deps: FilesBridgeDeps, req: { requestId?: unknown }): Promise<FilesBridgeResult> {
  if (typeof req?.requestId !== 'string' || !REQUEST.test(req.requestId)) return fail('bad_request');
  if (typeof deps.spawn !== 'function') return fail('not_configured');
  const o = await owned(deps);
  if (isResult(o)) return o;
  try {
    const probe = await deps.exec(o.c, o.sb, filesBridgeProbeScript(o.machine.id), FILES_BRIDGE_LIMITS.installTimeoutS);
    if (probe.exitCode === 43) return { status: 200, body: { ok: true, skipped: 'not_installed' } };
    if (probe.exitCode !== 0) return fail('install_failed');
  } catch { return fail('unknown_outcome'); }
  const now = (deps.now ?? Date.now)();
  const cap = await grantFor(deps, o, req.requestId, now);
  if (isResult(cap)) return cap;
  const g = cap;
  let watcher: Record<string, unknown> | FilesBridgeResult;
  try {
    const prep = await deps.exec(o.c, o.sb, filesBridgeRefreshScript(g.machineId, g.workspaceId), FILES_BRIDGE_LIMITS.installTimeoutS);
    if (prep.exitCode === 43) return fail('agent_not_installed');
    if (prep.exitCode === 44) return fail('base_exists_unowned');
    if (prep.exitCode !== 0) return fail('install_failed');
    await deps.upload(o.c, o.sb, `${P.capability}.next`, capabilityFile(g));
    if ((await deps.exec(o.c, o.sb, ACTIVATE_CAPABILITY, FILES_BRIDGE_LIMITS.installTimeoutS)).exitCode !== 0) return fail('install_failed');
    watcher = await startWatcher(deps, o, g, now);
  } catch { return fail('unknown_outcome'); }
  if (isResult(watcher)) return watcher;
  return { status: 200, body: { ok: true, resumed: true, machineId: g.machineId, writerEpoch: g.writerEpoch, expiresAt: g.expiresAt, watcher } };
}

/** Lease id of one materialize request: the request id without dashes, so a retried open reuses its lease instead of
 *  taking a second one that would never be closed. */
export const filesBridgeLeaseId = (requestId: string) => requestId.toLowerCase().replace(/-/g, '');

/** Explicit user open: registers one file (and its parent dirs) and has the agent fetch + verify it. */
export async function filesBridgeMaterialize(deps: FilesBridgeDeps,
  req: { requestId?: unknown; manifest?: unknown; fileId?: unknown; versionId?: unknown }): Promise<FilesBridgeResult> {
  if (typeof req?.requestId !== 'string' || !REQUEST.test(req.requestId)) return fail('bad_request');
  if (typeof req.fileId !== 'string' || !IDENT.test(req.fileId) || req.fileId.startsWith('-')
    || typeof req.versionId !== 'string' || !IDENT.test(req.versionId) || req.versionId.startsWith('-')) return fail('bad_request');
  const manifest = filesBridgeManifest(req.manifest, req.fileId, req.versionId);
  if (!manifest) return fail('bad_request');
  const o = await owned(deps);
  if (isResult(o)) return o;
  const m = `${P.manifests}/${req.requestId.toLowerCase()}.json`;
  try {
    const prep = await deps.exec(o.c, o.sb, `bash -c 'set -eu; umask 077; test -f ${P.agent} && test -f ${P.capability} || exit 43; test ! -L ${P.manifests} || exit 41; `
      + `rm -f ${m}.next; install -m 600 /dev/null ${m}.next'`, FILES_BRIDGE_LIMITS.installTimeoutS);
    if (prep.exitCode === 43) return fail('agent_not_installed');
    if (prep.exitCode !== 0) return fail('install_failed');
    await deps.upload(o.c, o.sb, `${m}.next`, JSON.stringify(manifest));
    const run = await deps.exec(o.c, o.sb, `bash -c 'mv -f ${m}.next ${m} && ${agentCmd(`register --manifest ${m}`)} `
      + `&& ${agentCmd(`open --file-id=${req.fileId} --version=${req.versionId} --lease=${filesBridgeLeaseId(req.requestId)}`)}; rc=$?; rm -f ${m}; exit $rc'`,
      FILES_BRIDGE_LIMITS.materializeTimeoutS);
    const out = agentJson(run.result);
    if (run.exitCode !== 0 || out?.ok !== true) return { status: 409, body: { error: { code: agentCode(out), message: 'agent_open' } } };
    return { status: 200, body: { ok: true, open: { leaseId: out.leaseId, path: out.path, state: out.state,
      versionId: out.versionId, fetchedBytes: out.fetchedBytes } } };
  } catch { return fail('unknown_outcome'); }
}

/** Runs one fixed agent command on the current running owned machine; never installs or starts anything. */
async function installedAgent(deps: FilesBridgeDeps, args: string, timeoutS: number, label: string,
  key: string): Promise<FilesBridgeResult> {
  const o = await owned(deps);
  if (isResult(o)) return o;
  try {
    const run = await deps.exec(o.c, o.sb, `bash -c 'test -f ${P.agent} && test -f ${P.capability} || exit 43; ${agentCmd(args)}'`,
      timeoutS);
    if (run.exitCode === 43) return fail('agent_not_installed');
    const out = agentJson(run.result);
    if (run.exitCode !== 0 || out?.ok !== true) return { status: 409, body: { error: { code: agentCode(out), message: label } } };
    return { status: 200, body: { ok: true, [key]: out } };
  } catch { return fail('unknown_outcome'); }
}

const LEASE = /^[0-9a-f]{32}$/;

/** Explicit user close of one open lease taken by materialize. Without it every open would keep the file `open` and block a
 *  verified end forever; the agent is never asked to close a lease on its own while an app may still use the file. */
export function filesBridgeClose(deps: FilesBridgeDeps, req: { leaseId?: unknown }): Promise<FilesBridgeResult> {
  if (typeof req?.leaseId !== 'string' || !LEASE.test(req.leaseId)) return Promise.resolve(fail('bad_request'));
  return installedAgent(deps, `close --lease=${req.leaseId}`, FILES_BRIDGE_LIMITS.installTimeoutS, 'agent_close', 'closed');
}

/** Agent counts/readiness on the running machine. Reads no file bodies and sends nothing remote. */
export function filesBridgeStatus(deps: FilesBridgeDeps): Promise<FilesBridgeResult> {
  return installedAgent(deps, 'status', FILES_BRIDGE_LIMITS.installTimeoutS, 'agent_status', 'agent');
}

/** End-of-session readiness for a future lifecycle step: enters draining (new fetches refused) and, with `flush`,
 *  reconciles and uploads pending work first. `end.ready` (== remoteSaved == safeToDelete) is true only when nothing is
 *  dirty, uploading, conflicted, unconfirmed or open. Never stops or deletes anything; `resume` is the agent's undo. */
export function filesBridgePrepareEnd(deps: FilesBridgeDeps, req: { flush?: unknown } = {}): Promise<FilesBridgeResult> {
  if (req.flush !== undefined && typeof req.flush !== 'boolean') return Promise.resolve(fail('bad_request'));
  return installedAgent(deps, req.flush ? 'prepare-end --flush' : 'prepare-end', FILES_BRIDGE_LIMITS.prepareEndTimeoutS,
    'agent_prepare_end', 'end');
}
