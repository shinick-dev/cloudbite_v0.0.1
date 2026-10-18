// Cloudbite Daytona transport: the same REST surface as src/lab.ts (dt/download), with deadlines on every call.
// Errors keep only an HTTP status — Daytona messages never reach project records or clients.
import { dt, DtError, download, type Dt, type Sandbox } from './lab';
import { CB_DAYTONA_TIMEOUT, CB_RUNNER_SECONDS, CB_WORKDIR } from './cloudbite-config';
import { boundedText } from './cloudbite-inference';

export const CB_LABEL_PROJECT = 'cloudbite-project';
export const CB_LABEL_RUN = 'cloudbite-run';
export const CB_LABEL_CLAIM = 'cloudbite-claim';

export interface CbSandbox extends Sandbox { labels?: Record<string, string> }

/** status 0 = no HTTP answer (network/timeout): the outcome of the call is unknown */
export class CbDaytonaError extends Error {
  constructor(public status: number, public op: string) { super(`Daytona ${op} ${status ? `HTTP ${status}` : 'unreachable'}`); }
  get uncertain() { return this.status === 0 || this.status >= 500 || this.status === 408 || this.status === 429; }
}

const signal = (ms = CB_DAYTONA_TIMEOUT) => AbortSignal.timeout(ms);
const toolbox = (c: Dt, sb: Sandbox): Dt => ({ ...c, api: sb.toolboxProxyUrl ?? 'https://proxy.app.daytona.io/toolbox' });

async function wrap<T>(op: string, f: () => Promise<T>): Promise<T> {
  try { return await f(); }
  catch (e) { throw new CbDaytonaError(e instanceof DtError ? e.status : 0, op); }
}

export function cbCreateSandbox(c: Dt, labels: Record<string, string>, snapshot?: string) {
  // autoStop/autoDelete are a provider-side backstop; the project alarm deletes owned sandboxes first.
  const body = { ...(snapshot ? { snapshot } : {}), labels, autoStopInterval: 20, autoDeleteInterval: 30, public: false };
  return wrap('create', () => dt<CbSandbox>(c, 'POST', '/sandbox', body, signal()));
}

export function cbGetSandbox(c: Dt, id: string) {
  return wrap('get', () => dt<CbSandbox>(c, 'GET', `/sandbox/${encodeURIComponent(id)}`, undefined, signal(20_000)));
}

export async function cbFindByLabels(c: Dt, labels: Record<string, string>): Promise<CbSandbox[]> {
  const q = encodeURIComponent(JSON.stringify(labels));
  const list = await wrap('list', () => dt<{ items?: CbSandbox[] } | CbSandbox[]>(c, 'GET', `/sandbox?labels=${q}`, undefined, signal(20_000)));
  const items = Array.isArray(list) ? list : (list.items ?? []);
  // Ownership is proven by every requested label on the returned sandbox, not by the filter alone.
  return items.filter((s) => typeof s?.id === 'string' && Object.entries(labels).every(([k, v]) => s.labels?.[k] === v));
}

/** true = deleted or already gone */
export async function cbDeleteSandbox(c: Dt, id: string): Promise<true> {
  try { await dt(c, 'DELETE', `/sandbox/${encodeURIComponent(id)}`, undefined, signal(30_000)); return true; }
  catch (e) {
    if (e instanceof DtError && e.status === 404) return true;
    throw new CbDaytonaError(e instanceof DtError ? e.status : 0, 'delete');
  }
}

export function cbExec(c: Dt, sb: Sandbox, command: string, timeout = 20) {
  return wrap('exec', () => dt<{ exitCode: number; result: string }>(toolbox(c, sb), 'POST', `/${sb.id}/process/execute`, { command, timeout }, signal((timeout + 15) * 1000)));
}

export async function cbUpload(c: Dt, sb: Sandbox, path: string, content: string) {
  const fd = new FormData();
  fd.append('file', new Blob([new TextEncoder().encode(content)]), path.split('/').pop());
  let r: Response;
  try {
    r = await fetch(`${toolbox(c, sb).api}/${sb.id}/files/upload?path=${encodeURIComponent(path)}`, {
      method: 'POST', headers: { authorization: `Bearer ${c.key}` }, body: fd, signal: signal(),
    });
  } catch { throw new CbDaytonaError(0, 'upload'); }
  await r.body?.cancel();
  if (!r.ok) throw new CbDaytonaError(r.status, 'upload');
}

/** Read a sandbox file up to max bytes. null = file absent (404). */
export async function cbDownload(c: Dt, sb: Sandbox, path: string, max: number): Promise<string | null> {
  let r: Response;
  try { r = await download(c, sb, path, signal(30_000)); }
  catch (e) {
    if (e instanceof DtError && e.status === 404) return null;
    throw new CbDaytonaError(e instanceof DtError ? e.status : 0, 'download');
  }
  try { return await boundedText(r, max); }
  catch (e) { throw new CbDaytonaError(e instanceof RangeError ? 413 : 0, 'download'); }
}

/** Start the runner asynchronously in a session. Idempotent: the runner exits if out/.started already exists. */
export async function cbStartRunner(c: Dt, sb: Sandbox, sessionId: string) {
  const t = toolbox(c, sb);
  try { await dt(t, 'POST', `/${sb.id}/process/session`, { sessionId }, signal(20_000)); }
  catch (e) { if (!(e instanceof DtError) || e.status >= 500 || e.status === 0) throw new CbDaytonaError(e instanceof DtError ? e.status : 0, 'session'); }
  const command = `bash -c 'cd ${CB_WORKDIR} && mkdir -p out && exec timeout -k 5 ${CB_RUNNER_SECONDS} python3 -I runner.py >> out/runner.log 2>&1'`;
  await wrap('start', () => dt(t, 'POST', `/${sb.id}/process/session/${sessionId}/exec`, { command, runAsync: true }, signal(20_000)));
}
