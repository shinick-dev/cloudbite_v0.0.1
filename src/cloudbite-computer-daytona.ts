// CloudBite computer Daytona transport. Every path is from the local daytona_api_client 0.214 spec:
//   POST /sandbox                                  CreateSandbox {name,snapshot,labels,public,autoStopInterval,autoDeleteInterval}
//   GET  /sandbox/{sandboxIdOrName}                exact name lookup (reconciles an unknown create)
//   POST /sandbox/{sandboxIdOrName}/start|stop
//   POST /sandbox/{sandboxIdOrName}/snapshot       CreateSandboxSnapshot {name, includeMemory:false} -> Sandbox
//   GET  /snapshots/{id}                           "Snapshot ID or name"
//   GET  /sandbox/{sandboxIdOrName}/ports/{port}/preview-url -> {sandboxId,url,token}
//   POST <toolboxProxyUrl>/{id}/computeruse/start  (daytona_toolbox_api_client 0.214 ComputerUseApi.start, no body)
//   POST /sandbox/{sandboxIdOrName}/resize         ResizeSandbox {cpu,memory} -> Sandbox (state 'resizing' until applied).
//        Hot resize on a running sandbox accepts only CPU/memory increases (daytona 0.214 Sandbox.resize); disk is never sent.
// Errors carry only an HTTP status (0 = no answer: outcome unknown). Provider messages never reach clients.
import { dt, DtError, type Dt } from './lab';
import { COMPUTER_DESKTOP_PATH, COMPUTER_DESKTOP_PORT } from './cloudbite-computer-contract';

export interface ComputerSandbox {
  id: string; name?: string; state?: string; labels?: Record<string, string>; target?: string;
  cpu?: number; memory?: number; disk?: number; toolboxProxyUrl?: string; errorReason?: string;
}
export interface ComputerSnapshotInfo { id?: string; name?: string; state?: string; errorReason?: string | null }
export interface ComputerPreview { url: string; token: string }

export class ComputerDaytonaError extends Error {
  /** quota: a definite refusal whose provider message names a quota/limit (the message itself never leaves this module). */
  constructor(public status: number, public op: string, public reason?: 'quota') { super(`Daytona ${op} ${status ? `HTTP ${status}` : 'unreachable'}`); }
  /** The provider may or may not have applied the change. */
  get uncertain() { return this.status === 0 || this.status >= 500 || this.status === 408 || this.status === 429; }
}

/** What the service needs from Daytona; tests pass a fake with the same shape. */
export interface ComputerDaytona {
  activity?(c: Dt, id: string): Promise<void>;
  create(c: Dt, body: Record<string, unknown>): Promise<ComputerSandbox>;
  get(c: Dt, idOrName: string): Promise<ComputerSandbox | null>;
  start(c: Dt, id: string): Promise<void>;
  stop(c: Dt, id: string): Promise<void>;
  createSnapshot(c: Dt, id: string, name: string): Promise<void>;
  getSnapshot(c: Dt, name: string): Promise<ComputerSnapshotInfo | null>;
  preview(c: Dt, id: string, port: number): Promise<ComputerPreview>;
  exec(c: Dt, sb: ComputerSandbox, command: string, timeout: number): Promise<{ exitCode: number; result: string }>;
  /** Background process in a toolbox session (execute reaps children), as src/lab.ts spawn. */
  spawn(c: Dt, sb: ComputerSandbox, sessionId: string, command: string): Promise<void>;
  /** Base image X/VNC stack (Xvfb, xfce, …) that the Selkies launcher attaches to. */
  computerUseStart(c: Dt, sb: ComputerSandbox): Promise<void>;
  /** Hot CPU/RAM increase of a running sandbox. Optional so fakes without it stay valid; absent = resize_unavailable. */
  resize?(c: Dt, id: string, body: { cpu: number; memory: number }): Promise<ComputerSandbox | null>;
}

const signal = (ms: number) => AbortSignal.timeout(ms);
const enc = encodeURIComponent;

async function call<T>(op: string, f: () => Promise<T>, absentOn404 = false): Promise<T | null> {
  try { return await f(); }
  catch (e) {
    if (absentOn404 && e instanceof DtError && e.status === 404) return null;
    throw new ComputerDaytonaError(e instanceof DtError ? e.status : 0, op);
  }
}

export const restDaytona: ComputerDaytona = {
  async activity(c, id) { await call('activity', () => dt(c, 'POST', `/sandbox/${enc(id)}/last-activity`, undefined, signal(20_000))); },
  async create(c, body) { return (await call('create', () => dt<ComputerSandbox>(c, 'POST', '/sandbox', body, signal(60_000))))!; },
  get: (c, idOrName) => call('get', () => dt<ComputerSandbox>(c, 'GET', `/sandbox/${enc(idOrName)}`, undefined, signal(20_000)), true),
  async start(c, id) { await call('start', () => dt(c, 'POST', `/sandbox/${enc(id)}/start`, undefined, signal(60_000))); },
  async stop(c, id) { await call('stop', () => dt(c, 'POST', `/sandbox/${enc(id)}/stop`, undefined, signal(60_000))); },
  async createSnapshot(c, id, name) {
    await call('snapshot', () => dt(c, 'POST', `/sandbox/${enc(id)}/snapshot`, { name, includeMemory: false }, signal(60_000)));
  },
  getSnapshot: (c, name) => call('snapshot-get', () => dt<ComputerSnapshotInfo>(c, 'GET', `/snapshots/${enc(name)}`, undefined, signal(20_000)), true),
  async preview(c, id, port) {
    const p = await call('preview', () => dt<ComputerPreview>(c, 'GET', `/sandbox/${enc(id)}/ports/${port}/preview-url`, undefined, signal(20_000)));
    if (!p || typeof p.url !== 'string' || typeof p.token !== 'string') throw new ComputerDaytonaError(502, 'preview');
    return p;
  },
  async exec(c, sb, command, timeout) {
    const box: Dt = { ...c, api: sb.toolboxProxyUrl ?? 'https://proxy.app.daytona.io/toolbox' };
    return (await call('exec', () => dt<{ exitCode: number; result: string }>(box, 'POST', `/${enc(sb.id)}/process/execute`, { command, timeout }, signal((timeout + 15) * 1000))))!;
  },
  async spawn(c, sb, sessionId, command) {
    const box: Dt = { ...c, api: sb.toolboxProxyUrl ?? 'https://proxy.app.daytona.io/toolbox' };
    try { await dt(box, 'POST', `/${enc(sb.id)}/process/session`, { sessionId }, signal(20_000)); }
    catch (e) { if (!(e instanceof DtError) || e.status >= 500) throw new ComputerDaytonaError(e instanceof DtError ? e.status : 0, 'session'); }
    await call('spawn', () => dt(box, 'POST', `/${enc(sb.id)}/process/session/${enc(sessionId)}/exec`, { command, runAsync: true }, signal(20_000)));
  },
  async resize(c, id, body) {
    try { return await dt<ComputerSandbox>(c, 'POST', `/sandbox/${enc(id)}/resize`, { cpu: body.cpu, memory: body.memory }, signal(60_000)); }
    catch (e) {
      const status = e instanceof DtError ? e.status : 0;
      const quota = status >= 400 && status < 500 && status !== 408 && status !== 429 && /quota|limit|exceed/i.test(e instanceof Error ? e.message : '');
      throw new ComputerDaytonaError(status, 'resize', quota ? 'quota' : undefined);
    }
  },
  async computerUseStart(c, sb) {
    const box: Dt = { ...c, api: sb.toolboxProxyUrl ?? 'https://proxy.app.daytona.io/toolbox' };
    await call('computeruse', () => dt(box, 'POST', `/${enc(sb.id)}/computeruse/start`, undefined, signal(60_000)));
  },
};

/** Exact upstream origin for the desktop port: https, no credentials/port/path, host `{port}-{sandboxId}{suffix}`. */
export function computerUpstreamOrigin(rawUrl: string, sandboxId: string, suffixes: string[]): string | null {
  let u: URL;
  try { u = new URL(rawUrl); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || u.port || (u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) return null;
  const host = u.hostname.toLowerCase();
  const id = sandboxId.toLowerCase();
  if (!/^[a-z0-9-]{8,64}$/.test(id)) return null;
  const ok = suffixes.some((s) => host === `${COMPUTER_DESKTOP_PORT}-${id}${s}`);
  return ok ? `https://${host}` : null;
}

// Request headers that must never reach the desktop: our cookies/credentials, caller origin, and Cloudflare/forwarding controls.
const STRIP_REQUEST = ['cookie', 'authorization', 'proxy-authorization', 'origin', 'referer', 'host', 'cf-connecting-ip', 'cf-ipcountry', 'cf-ray',
  'cf-visitor', 'cf-worker', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip', 'forwarded', 'true-client-ip',
  'x-daytona-preview-token', 'x-daytona-skip-preview-warning', 'x-admin-token'];
const STRIP_RESPONSE = ['set-cookie', 'clear-site-data', 'access-control-allow-origin', 'access-control-allow-credentials',
  'access-control-allow-headers', 'access-control-allow-methods', 'access-control-expose-headers', 'access-control-max-age', 'alt-svc'];

/** Path confined to the desktop subfolder: no dot segments, no encoded slashes or backslashes. */
export function computerDesktopPath(url: URL): string | null {
  const p = url.pathname;
  if (p !== COMPUTER_DESKTOP_PATH && !p.startsWith(`${COMPUTER_DESKTOP_PATH}/`)) return null;
  if (/%2f|%5c|%2e|\\/i.test(p) || p.split('/').some((s) => s === '.' || s === '..')) return null;
  return p;
}

/**
 * Proxy one gateway request to the owner's desktop. The caller (root gateway route) has already verified the
 * computer cookie and obtained {origin, token} from the DO. The body streams both ways; WebSocket upgrades pass through.
 */
export async function proxyComputerDesktop(req: Request, upstream: { origin: string; token: string }, fetcher: typeof fetch = fetch): Promise<Response> {
  const url = new URL(req.url);
  const path = computerDesktopPath(url);
  if (!path) return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  const headers = new Headers(req.headers);
  for (const h of STRIP_REQUEST) headers.delete(h);
  headers.set('x-daytona-preview-token', upstream.token);
  headers.set('x-daytona-skip-preview-warning', 'true');
  // The gateway already checked the browser Origin. Selkies is behind the Daytona reverse proxy;
  // forwarding the external preview Origin makes it reject its own proxied WebSocket.
  const target = upstream.origin + path + url.search;
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  const up = await fetcher(target, { method: req.method, headers, body: hasBody ? req.body : undefined, redirect: 'manual' });
  if (up.status === 101) return up;
  const rh = new Headers(up.headers);
  for (const h of STRIP_RESPONSE) rh.delete(h);
  const loc = rh.get('location');
  if (loc) {
    try {
      const l = new URL(loc, target);
      if (l.origin !== upstream.origin || !computerDesktopPath(l)) rh.delete('location');
      else rh.set('location', l.pathname + l.search);
    } catch { rh.delete('location'); }
  }
  rh.set('cache-control', rh.get('cache-control') ?? 'no-store');
  rh.set('referrer-policy', 'no-referrer');
  rh.set('x-content-type-options', 'nosniff');
  rh.set('permissions-policy', 'publickey-credentials-get=(), publickey-credentials-create=()');
  return new Response(up.body, { status: up.status, statusText: up.statusText, headers: rh });
}
