// CloudBite computer latency: measurements the root serves only after the owner's cookie/admin credential is verified.
//   GET /api/cloudbite/computer/latency/ping    -> latencyPing()    {ok,serverTime}; no provider call, the browser times it
//   GET /api/cloudbite/computer/latency/backend -> latencyBackend() server-side timings of the owner's machine, cached 30 s
// The backend target is never named by the caller: the server-derived owner tag gives the DO machine record, the configured
// account gives the key, and one provider GET must show the same id, name and every owner label before anything else runs.
// Two separate timings: apiControl is the Worker -> Daytona control API GET; remoteExec is one fixed read-only command through
// the toolbox and includes provider queueing and execution, so it is not a pure network round trip. Nothing is started or
// resumed. A value that was not measured is null with a reason; it is never reported as zero. Keys and URLs stay here.
import type { ComputerAccount, ComputerEnv } from './cloudbite-computer-contract';
import { computerAccounts, computerLabels } from './cloudbite-computer-contract';
import { cbExec, cbGetSandbox, CbDaytonaError, type CbSandbox } from './cloudbite-daytona';
import type { Dt } from './lab';

export const LATENCY_CACHE_MS = 30_000;
export const LATENCY_CONTROL_TIMEOUT_MS = 8_000;
export const LATENCY_EXEC_TIMEOUT_MS = 12_000;
export const LATENCY_EXEC_COMMAND = 'echo cloudbite-latency'; // fixed and read-only; nothing from the request reaches it
const EXEC_SECONDS = 5;
const EXEC_MARK = 'cloudbite-latency';

export type LatencyReason = 'absent' | 'not_configured' | 'ownership_mismatch' | 'stopped' | 'not_running' | 'error'
  | 'timeout' | 'provider_error' | 'exec_failed' | 'skipped_after_control_failure';
export interface LatencySample<K extends string> { kind: K; at: string | null; ms: number | null; reason: LatencyReason | null }
export interface LatencyBackendBody {
  ok: true; schema: 'cloudbite.computer.latency.backend.v1'; measuredAt: string; cached: boolean; cacheAgeMs: number; cacheTtlMs: number;
  machine: { status: string; providerState: string | null; account: ComputerAccount | null };
  apiControl: LatencySample<'api_control'>;
  remoteExec: LatencySample<'remote_exec'> & { includes: 'provider_queue_and_execution' };
}
type Result = { status: number; body: Record<string, unknown> };

/** Structural minimum of the CloudbiteComputer DO stub; snapshots or other callers may pass a wider type. */
export interface LatencyMachineRpc {
  computerMachine(tag: string): Promise<{ ok: true; machine: { id: string; account: ComputerAccount; name: string; status: string } } | { error: unknown; status: number }>;
}
export interface LatencyDeps {
  clock(): number; // monotonic ms, only ever subtracted from itself
  wall(): number;
  get(c: Dt, id: string): Promise<CbSandbox>;
  exec(c: Dt, sb: CbSandbox, command: string, timeoutSec: number): Promise<{ exitCode: number; result: string }>;
  cache: Map<string, { at: number; body: LatencyBackendBody } | { pending: Promise<LatencyBackendBody> }>;
  controlTimeoutMs: number;
  execTimeoutMs: number;
}
const DEFAULT_DEPS: LatencyDeps = {
  clock: () => performance.now(), wall: () => Date.now(),
  get: cbGetSandbox, exec: cbExec, cache: new Map(), controlTimeoutMs: LATENCY_CONTROL_TIMEOUT_MS, execTimeoutMs: LATENCY_EXEC_TIMEOUT_MS,
};

export function latencyPing(now = Date.now()): Result {
  return { status: 200, body: { ok: true, schema: 'cloudbite.computer.latency.ping.v1', serverTime: new Date(now).toISOString() } };
}

const TIMEOUT = Symbol('timeout');
function within<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<typeof TIMEOUT>((r) => { t = setTimeout(() => r(TIMEOUT), ms); })]).finally(() => { if (t !== undefined) clearTimeout(t); });
}
const STOPPED = new Set(['stopped', 'archived', 'paused', 'stopping', 'archiving', 'pausing']);
const providerReason = (state: string): LatencyReason => (STOPPED.has(state) ? 'stopped' : state === 'error' || state === 'build_failed' ? 'error' : 'not_running');
const ms = (a: number, b: number) => Math.max(0, Math.round((b - a) * 10) / 10);

async function measure(env: ComputerEnv, computer: LatencyMachineRpc, tag: string, d: LatencyDeps): Promise<LatencyBackendBody> {
  const body: LatencyBackendBody = {
    ok: true, schema: 'cloudbite.computer.latency.backend.v1', measuredAt: new Date(d.wall()).toISOString(), cached: false, cacheAgeMs: 0, cacheTtlMs: LATENCY_CACHE_MS,
    machine: { status: 'absent', providerState: null, account: null },
    apiControl: { kind: 'api_control', at: null, ms: null, reason: null },
    remoteExec: { kind: 'remote_exec', at: null, ms: null, reason: null, includes: 'provider_queue_and_execution' },
  };
  const skip = (control: LatencyReason, exec: LatencyReason = control) => { body.apiControl.reason ??= control; body.remoteExec.reason = exec; return body; };
  const current = await computer.computerMachine(tag);
  if (!('ok' in current)) return skip('absent');
  const m = current.machine;
  body.machine = { status: m.status, providerState: null, account: m.account };
  const account = computerAccounts(env).find((a) => a.id === m.account);
  if (!account) return skip('not_configured');
  const c = { api: account.api, key: account.key };

  body.apiControl.at = new Date(d.wall()).toISOString();
  const t0 = d.clock();
  let sb: CbSandbox | typeof TIMEOUT;
  try { sb = await within(d.get(c, m.id), d.controlTimeoutMs); }
  catch (e) { return skip(e instanceof CbDaytonaError && e.status === 404 ? 'absent' : 'provider_error', 'skipped_after_control_failure'); }
  if (sb === TIMEOUT) return skip('timeout', 'skipped_after_control_failure');
  const t1 = d.clock();
  // The timing counts only for the owner's own machine; a mismatch is neither shown nor followed by an exec.
  const labels = computerLabels(tag, m.account);
  if (!sb || sb.id !== m.id || (sb as { name?: unknown }).name !== m.name || !Object.entries(labels).every(([k, v]) => sb.labels?.[k] === v)) {
    return skip('ownership_mismatch');
  }
  body.apiControl.ms = ms(t0, t1);
  const state = typeof sb.state === 'string' && /^[a-z_]{1,32}$/.test(sb.state) ? sb.state : null;
  body.machine.providerState = state;
  if (state !== 'started') { body.remoteExec.reason = providerReason(state ?? ''); return body; }
  if (m.status !== 'running') { body.remoteExec.reason = 'not_running'; return body; }

  body.remoteExec.at = new Date(d.wall()).toISOString();
  const e0 = d.clock();
  try {
    const out = await within(d.exec(c, sb, LATENCY_EXEC_COMMAND, EXEC_SECONDS), d.execTimeoutMs);
    if (out === TIMEOUT) body.remoteExec.reason = 'timeout';
    else if (out?.exitCode !== 0 || !String(out.result ?? '').includes(EXEC_MARK)) body.remoteExec.reason = 'exec_failed';
    else body.remoteExec.ms = ms(e0, d.clock());
  } catch { body.remoteExec.reason = 'provider_error'; }
  return body;
}

/**
 * Server-side timings for the signed-in owner's machine. At most one provider GET (+ one exec when running) per tag per
 * LATENCY_CACHE_MS; concurrent callers share the same measurement. The root routes here only after owner authentication.
 */
export async function latencyBackend(env: ComputerEnv, computer: LatencyMachineRpc, tag: string, deps: Partial<LatencyDeps> = {}): Promise<Result> {
  const d: LatencyDeps = { ...DEFAULT_DEPS, ...deps };
  const hit = d.cache.get(tag), now = d.wall();
  if (hit && 'body' in hit && now >= hit.at && now - hit.at < LATENCY_CACHE_MS) {
    return { status: 200, body: { ...hit.body, cached: true, cacheAgeMs: now - hit.at } };
  }
  if (hit && 'pending' in hit) return { status: 200, body: { ...(await hit.pending) } };
  const pending = measure(env, computer, tag, d);
  d.cache.set(tag, { pending });
  try {
    const body = await pending;
    d.cache.set(tag, { at: d.wall(), body });
    return { status: 200, body: { ...body } };
  } catch (e) { d.cache.delete(tag); throw e; }
}
