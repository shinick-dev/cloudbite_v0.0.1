// Cloud Files VM bridge: installs the files agent and its private machine-scoped capability on the owner's
// current running computer, and drives explicit materialize/status through the agent CLI.
// Dependency-injected (contract: docs/cloudbite/files-bridge.md). Never starts, stops, restarts or snapshots a
// machine; touches only the fixed private directory and the dedicated workspace root below.
// The capability token travels only inside an upload body to a 0600 placeholder; never in argv, logs or responses.
import type { Dt } from './lab';
import type { CbSandbox } from './cloudbite-daytona';

export const FILES_AGENT_PREFIX = '/api/cloudbite/computer/files/agent/v1';
export const FILES_CAPABILITY_SCHEMA = 'cloudbite.files.agent-capability.v1';

const BASE = '/home/daytona/.local/share/cloudbite-files';
export const FILES_BRIDGE_PATHS = {
  base: BASE,
  agent: `${BASE}/agent/files-agent.py`,
  capability: `${BASE}/capability.json`,
  state: `${BASE}/state`,
  manifests: `${BASE}/manifests`,
  ownedMarker: `${BASE}/root-owned`,
  root: '/home/daytona/CloudFiles',
} as const;

export const FILES_BRIDGE_LIMITS = {
  agentSourceBytes: 256 * 1024,
  manifestEntries: 64,
  manifestBytes: 64 * 1024,
  outputBytes: 64 * 1024,
  capabilityMinTtlMs: 60_000,
  installTimeoutS: 30,
  materializeTimeoutS: 180,
} as const;

export interface FilesAgentCapability { token: string; expiresAt: number; machineId: string; workspaceId: string; writerEpoch: number }
export interface FilesBridgeMachine { id: string; name: string; account: string }
export type FilesManifestEntry =
  | { kind: 'dir'; fileId: string; path: string }
  | { kind: 'file'; fileId: string; path: string; versionId: string; size: number; sha256: string };

export interface FilesBridgeDeps {
  origin: string;
  /** Current RUNNING machine of this owner, or null. Must never start one. */
  machine(): Promise<FilesBridgeMachine | null>;
  account(accountId: string): Dt | null;
  labels(accountId: string): Record<string, string>;
  getSandbox(c: Dt, id: string): Promise<CbSandbox | null>;
  exec(c: Dt, sb: CbSandbox, command: string, timeoutS: number): Promise<{ exitCode: number; result: string }>;
  upload(c: Dt, sb: CbSandbox, path: string, content: string): Promise<void>;
  agentSource: string;
  capability(req: { ownerMachineId: string; requestId: string }):
    Promise<{ ok: true; capability: FilesAgentCapability } | { ok: false; code: string; status: number }>;
  now?: () => number;
}

export type FilesBridgeError = 'not_configured' | 'bad_request' | 'not_running' | 'ownership_mismatch'
  | 'workspace_exists_unowned' | 'install_failed' | 'agent_not_installed' | 'agent_failed' | 'unknown_outcome';
export interface FilesBridgeResult { status: number; body: Record<string, unknown> }

const STATUS: Record<FilesBridgeError, number> = {
  not_configured: 503, bad_request: 400, not_running: 409, ownership_mismatch: 409, workspace_exists_unowned: 409,
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

function validCapability(cap: unknown, machineId: string, now: number): cap is FilesAgentCapability {
  const c = cap as FilesAgentCapability;
  return !!c && typeof c === 'object' && typeof c.token === 'string' && TOKEN.test(c.token)
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
  if (!filesBridgeOrigin(deps.origin)) return fail('not_configured');
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

const isResult = (v: Owned | FilesBridgeResult): v is FilesBridgeResult => 'status' in v && 'body' in v;
const P = FILES_BRIDGE_PATHS;
const agentCmd = (args: string) => `python3 ${P.agent} --state ${P.state} --capability ${P.capability} ${args}`;

// Fixed script, no interpolated user data. Creates only missing paths; refuses a symlinked base/root and an existing
// workspace root this bridge did not create. Placeholders are created 0600 before any secret byte is written.
const PREPARE = `bash -c 'set -eu; umask 077; B=${P.base}; R=${P.root}; `
  + `for p in "$B" "$R"; do if [ -L "$p" ]; then exit 41; fi; done; `
  + `mkdir -p "$B/agent" "$B/state" "$B/manifests"; `
  + `if [ -e "$R" ]; then if [ ! -d "$R" ] || [ ! -f "$B/root-owned" ]; then exit 42; fi; `
  + `else mkdir -m 700 "$R"; : > "$B/root-owned"; fi; `
  + `rm -f "$B/agent/files-agent.py.next" "$B/capability.json.next"; `
  + `install -m 600 /dev/null "$B/agent/files-agent.py.next"; install -m 600 /dev/null "$B/capability.json.next"'`;
const ACTIVATE = `bash -c 'set -eu; B=${P.base}; chmod 600 "$B/agent/files-agent.py.next" "$B/capability.json.next"; `
  + `mv -f "$B/agent/files-agent.py.next" "$B/agent/files-agent.py"; mv -f "$B/capability.json.next" "$B/capability.json"'`;
export const FILES_BRIDGE_SCRIPTS = { prepare: PREPARE, activate: ACTIVATE } as const;

/** Explicit install/refresh on the current running owned machine. Paid-free: no start, no snapshot. */
export async function filesBridgeInstall(deps: FilesBridgeDeps, req: { requestId?: unknown }): Promise<FilesBridgeResult> {
  if (typeof req?.requestId !== 'string' || !REQUEST.test(req.requestId)) return fail('bad_request');
  if (typeof deps.agentSource !== 'string' || !deps.agentSource.startsWith('#!/usr/bin/env python3')
    || utf8.encode(deps.agentSource).byteLength > FILES_BRIDGE_LIMITS.agentSourceBytes) return fail('not_configured');
  const o = await owned(deps);
  if (isResult(o)) return o;
  const now = (deps.now ?? Date.now)();
  let grant: Awaited<ReturnType<FilesBridgeDeps['capability']>>;
  try { grant = await deps.capability({ ownerMachineId: o.machine.id, requestId: req.requestId }); }
  catch { return fail('unknown_outcome'); }
  if (!grant.ok) {
    const code = typeof grant.code === 'string' && AGENT_CODE.test(grant.code) ? grant.code : 'not_configured';
    const status = Number.isInteger(grant.status) && grant.status >= 400 && grant.status < 600 ? grant.status : 503;
    return { status, body: { error: { code, message: code } } };
  }
  const cap = grant.capability;
  if (!validCapability(cap, o.machine.id, now)) return fail('install_failed');
  const config = JSON.stringify({ schema: FILES_CAPABILITY_SCHEMA, origin: filesBridgeOrigin(deps.origin), token: cap.token,
    machineId: cap.machineId, workspaceId: cap.workspaceId, writerEpoch: cap.writerEpoch, expiresAt: cap.expiresAt });
  try {
    const prep = await deps.exec(o.c, o.sb, PREPARE, FILES_BRIDGE_LIMITS.installTimeoutS);
    if (prep.exitCode === 42) return fail('workspace_exists_unowned');
    if (prep.exitCode !== 0) return fail('install_failed');
    await deps.upload(o.c, o.sb, `${P.agent}.next`, deps.agentSource);
    await deps.upload(o.c, o.sb, `${P.capability}.next`, config);
    const act = await deps.exec(o.c, o.sb, ACTIVATE, FILES_BRIDGE_LIMITS.installTimeoutS);
    if (act.exitCode !== 0) return fail('install_failed');
    const init = await deps.exec(o.c, o.sb, `python3 ${P.agent} --state ${P.state} init --root ${P.root} `
      + `--workspace-id=${cap.workspaceId} --machine-id=${cap.machineId} --writer-epoch=${cap.writerEpoch}`, FILES_BRIDGE_LIMITS.installTimeoutS);
    const initOut = agentJson(init.result);
    if (init.exitCode !== 0 || initOut?.ok !== true) return { status: 409, body: { error: { code: agentCode(initOut), message: 'agent_init' } } };
    const check = agentJson((await deps.exec(o.c, o.sb, agentCmd('status'), FILES_BRIDGE_LIMITS.installTimeoutS)).result);
    if (check?.ok !== true || check.transportConfigured !== true) return { status: 409, body: { error: { code: agentCode(check), message: 'agent_status' } } };
  } catch { return fail('install_failed'); }
  return { status: 200, body: { ok: true, installed: true, machineId: cap.machineId, writerEpoch: cap.writerEpoch, expiresAt: cap.expiresAt } };
}

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
    const prep = await deps.exec(o.c, o.sb, `bash -c 'set -eu; umask 077; test -f ${P.agent} && test -f ${P.capability} || exit 43; `
      + `rm -f ${m}.next; install -m 600 /dev/null ${m}.next'`, FILES_BRIDGE_LIMITS.installTimeoutS);
    if (prep.exitCode === 43) return fail('agent_not_installed');
    if (prep.exitCode !== 0) return fail('install_failed');
    await deps.upload(o.c, o.sb, `${m}.next`, JSON.stringify(manifest));
    const run = await deps.exec(o.c, o.sb, `bash -c 'mv -f ${m}.next ${m} && ${agentCmd(`register --manifest ${m}`)} `
      + `&& ${agentCmd(`open --file-id=${req.fileId} --version=${req.versionId}`)}; rc=$?; rm -f ${m}; exit $rc'`,
      FILES_BRIDGE_LIMITS.materializeTimeoutS);
    const out = agentJson(run.result);
    if (run.exitCode !== 0 || out?.ok !== true) return { status: 409, body: { error: { code: agentCode(out), message: 'agent_open' } } };
    return { status: 200, body: { ok: true, open: { leaseId: out.leaseId, path: out.path, state: out.state,
      versionId: out.versionId, fetchedBytes: out.fetchedBytes } } };
  } catch { return fail('unknown_outcome'); }
}

/** Agent counts/readiness on the running machine. Reads no file bodies and sends nothing remote. */
export async function filesBridgeStatus(deps: FilesBridgeDeps): Promise<FilesBridgeResult> {
  const o = await owned(deps);
  if (isResult(o)) return o;
  try {
    const run = await deps.exec(o.c, o.sb, `bash -c 'test -f ${P.agent} && test -f ${P.capability} || exit 43; ${agentCmd('status')}'`,
      FILES_BRIDGE_LIMITS.installTimeoutS);
    if (run.exitCode === 43) return fail('agent_not_installed');
    const out = agentJson(run.result);
    if (run.exitCode !== 0 || out?.ok !== true) return { status: 409, body: { error: { code: agentCode(out), message: 'agent_status' } } };
    return { status: 200, body: { ok: true, agent: out } };
  } catch { return fail('unknown_outcome'); }
}
