// Read-only result reader for a public Nosana job: indexer job row -> ipfsResult CID -> official gateway FlowState
// -> stdout of op 'work' -> last CLOUDBITE_RESULT_JSON marker. No credentials, callbacks or caller-supplied URLs.
// Schema source: @nosana/types 2.14.2 FlowState/OpState/Log, @nosana/api 2.20.0 blockchain-indexer, @nosana/ipfs
// 2.14.2 defaultIPFSConfig.gateway; shape cross-checked read-only against public prd indexer/gateway rows.
// The caller proves the address belongs to its own deployment; job definitions are public, so output is not secret.

export const NOSANA_INDEXER = 'https://blockchain-indexer.k8s.prd.nos.ci';
export const NOSANA_GATEWAY = 'https://nosana.mypinata.cloud/ipfs/';
export const RESULT_MARKER = 'CLOUDBITE_RESULT_JSON:';
export const WORK_OP = 'work';
const TIMEOUT_MS = 15_000, BODY_MAX = 2 * 1024 * 1024, OUTPUT_MAX = 64 * 1024, LINE_MAX = 1024 * 1024;
// solBytesArrayToIpfsHash of 32 zero bytes: the on-chain "no result yet" value (see @nosana/kit JobsProgram).
const EMPTY_CID = 'QmNLei78zWmzUdbeRB3CiUfAizWUrbeeZh5K1rhAQKCh51';

export type NosanaRunResult = { exitCode: number | null; output: string; timedOut: boolean; truncated: boolean };
export type NosanaJobResult = { kind: 'ready'; result: NosanaRunResult } | { kind: 'pending' } | { kind: 'unavailable' };
type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;
const PENDING = { kind: 'pending' } as const, UNAVAILABLE = { kind: 'unavailable' } as const;

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(s: string): Uint8Array | null {
  const out: number[] = [];
  for (const ch of s) {
    let carry = B58.indexOf(ch);
    if (carry < 0) return null;
    for (let i = 0; i < out.length; i++) { carry += out[i] * 58; out[i] = carry & 255; carry >>= 8; }
    while (carry) { out.push(carry & 255); carry >>= 8; }
  }
  for (const ch of s) { if (ch !== '1') break; out.push(0); }
  return Uint8Array.from(out.reverse());
}
function base32(s: string): Uint8Array | null {
  const out: number[] = []; let bits = 0, value = 0;
  for (const ch of s) {
    const v = 'abcdefghijklmnopqrstuvwxyz234567'.indexOf(ch);
    if (v < 0) return null;
    value = (value << 5) | v; bits += 5;
    if (bits >= 8) { out.push((value >> (bits - 8)) & 255); bits -= 8; }
  }
  return Uint8Array.from(out);
}

/** Solana public key: base58 text that decodes to exactly 32 bytes. */
export function isJobAddress(s: unknown): s is string {
  return typeof s === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s) && base58(s)?.length === 32;
}
/** CIDv0 (Qm…, sha2-256 multihash) or base32 CIDv1 with dag-pb/raw codec and a sha2-256 multihash. */
export function isResultCid(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  if (/^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(s)) { const b = base58(s); return b?.length === 34 && b[0] === 0x12 && b[1] === 0x20; }
  if (/^b[a-z2-7]{58}$/.test(s)) {
    const b = base32(s.slice(1));
    return b?.length === 36 && b[0] === 0x01 && (b[1] === 0x70 || b[1] === 0x55) && b[2] === 0x12 && b[3] === 0x20;
  }
  return false;
}

type Body = { status: 'ok'; json: unknown } | { status: 'pending' } | { status: 'unavailable' };
async function getJson(url: string, host: string, fetcher: Fetcher): Promise<Body> {
  if (new URL(url).host !== host) return { status: 'unavailable' };
  let res: Response;
  try {
    res = await fetcher(url, { method: 'GET', redirect: 'manual', headers: { accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch { return { status: 'pending' }; }
  // Never follow a redirect: the trust root is the fixed host, not wherever it points.
  if (res.redirected || (res.type as string) === 'opaqueredirect' || (res.status >= 300 && res.status < 400) || (res.url && new URL(res.url).host !== host)) return discard(res, 'unavailable');
  if (res.status === 404 || res.status === 408 || res.status === 425 || res.status === 429 || res.status >= 500) return discard(res, 'pending');
  if (res.status !== 200) return discard(res, 'unavailable');
  const declared = Number(res.headers.get('content-length'));
  if (declared > BODY_MAX) return discard(res, 'unavailable');
  let text: string;
  try {
    const bytes = await readCapped(res);
    if (!bytes) return { status: 'unavailable' };
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch { return { status: 'pending' }; }
  try { return { status: 'ok', json: JSON.parse(text) }; } catch { return { status: 'unavailable' }; }
}
async function discard(res: Response, status: 'pending' | 'unavailable'): Promise<Body> {
  try { await res.body?.cancel(); } catch { /* already closed */ }
  return { status };
}
async function readCapped(res: Response): Promise<Uint8Array | null> {
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > BODY_MAX) { try { await reader.cancel(); } catch { /* ignore */ } return null; }
    chunks.push(value);
  }
  const out = new Uint8Array(size); let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Indexer GET /jobs/{address} row -> CID, still pending, or unusable. Numeric state follows JobState 0..3. */
export function parseIndexerJob(row: unknown, jobAddress: string): { cid: string } | { kind: 'pending' } | { kind: 'unavailable' } {
  if (!isObject(row) || row.address !== jobAddress || !Number.isInteger(row.state) || (row.state as number) < 0 || (row.state as number) > 3) return UNAVAILABLE;
  const cid = row.ipfsResult;
  // Queued/running, or finished but the result hash has not reached the indexer yet: the caller owns expiry.
  if (cid === null || cid === undefined || cid === EMPTY_CID) return PENDING;
  return isResultCid(cid) ? { cid } : UNAVAILABLE;
}

/** FlowState (IPFS result) -> concatenated stdout of the op whose operationId is 'work', or null on unknown schema. */
export function workStdout(flow: unknown): string | null {
  if (!isObject(flow) || typeof flow.status !== 'string' || !Array.isArray(flow.opStates)) return null;
  const ops = flow.opStates.filter(o => isObject(o) && o.operationId === WORK_OP);
  if (ops.length !== 1) return null;
  const logs = (ops[0] as Record<string, unknown>).logs;
  if (!Array.isArray(logs)) return null;
  let out = '';
  for (const l of logs) {
    if (!isObject(l) || !['stdin', 'stdout', 'stderr', 'nodeerr'].includes(l.type as string)) return null;
    if (l.log !== undefined && typeof l.log !== 'string') return null;
    if (l.type === 'stdout' && l.log) out += l.log;
  }
  return out;
}

/** Last strict runner result in stdout: a `CLOUDBITE_RESULT_JSON:{…}` line, else a bare JSON result line. */
export function parseRunnerStdout(stdout: string): NosanaRunResult | null {
  const lines = stdout.split('\n').map(l => l.endsWith('\r') ? l.slice(0, -1) : l);
  const pick = (want: (l: string) => string | null) => {
    for (let i = lines.length - 1; i >= 0; i--) {
      const body = want(lines[i]);
      if (body !== null) return body.length <= LINE_MAX ? strictResult(body) : null;
    }
    return undefined;
  };
  const marked = pick(l => l.startsWith(RESULT_MARKER) ? l.slice(RESULT_MARKER.length) : null);
  if (marked !== undefined) return marked;
  // Transitional: runner versions that print only the JSON object line. Only an exact-schema line qualifies.
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (l.startsWith('{') && l.length <= LINE_MAX) { const r = strictResult(l); if (r) return r; }
  }
  return null;
}
function strictResult(text: string): NosanaRunResult | null {
  let v: unknown;
  try { v = JSON.parse(text); } catch { return null; }
  if (!isObject(v)) return null;
  const keys = Object.keys(v).sort().join(',');
  if (keys !== 'exitCode,output,timedOut,truncated') return null;
  const { exitCode, output, timedOut, truncated } = v;
  if (!(exitCode === null || (Number.isInteger(exitCode) && (exitCode as number) >= -255 && (exitCode as number) <= 255))) return null;
  if (typeof output !== 'string' || typeof timedOut !== 'boolean' || typeof truncated !== 'boolean') return null;
  const tail = plainTail(output);
  return { exitCode: exitCode as number | null, output: tail.text, timedOut, truncated: truncated || tail.cut };
}
/** Untrusted text -> plain text: ANSI/control sequences removed, last OUTPUT_MAX UTF-8 bytes kept. */
export function plainTail(s: string): { text: string; cut: boolean } {
  const clean = s.replace(/\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '').replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '�');
  const bytes = new TextEncoder().encode(clean);
  if (bytes.length <= OUTPUT_MAX) return { text: clean, cut: false };
  let start = bytes.length - OUTPUT_MAX;
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
  return { text: new TextDecoder().decode(bytes.subarray(start)), cut: true };
}

/** Getter only: never posts, pays, signs or follows provider-supplied URLs. Errors collapse to pending/unavailable. */
export async function readNosanaJobResult(jobAddress: string, fetcher: Fetcher = fetch): Promise<NosanaJobResult> {
  if (!isJobAddress(jobAddress)) return UNAVAILABLE;
  try {
    const job = await getJson(`${NOSANA_INDEXER}/jobs/${encodeURIComponent(jobAddress)}`, new URL(NOSANA_INDEXER).host, fetcher);
    if (job.status !== 'ok') return job.status === 'pending' ? PENDING : UNAVAILABLE;
    const row = parseIndexerJob(job.json, jobAddress);
    if (!('cid' in row)) return row;
    const flow = await getJson(NOSANA_GATEWAY + encodeURIComponent(row.cid), new URL(NOSANA_GATEWAY).host, fetcher);
    if (flow.status !== 'ok') return flow.status === 'pending' ? PENDING : UNAVAILABLE;
    const stdout = workStdout(flow.json);
    const result = stdout === null ? null : parseRunnerStdout(stdout);
    return result ? { kind: 'ready', result } : UNAVAILABLE;
  } catch { return UNAVAILABLE; }
}
