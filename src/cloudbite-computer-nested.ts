// Cloudbite nested compute (personal computer → bounded extra compute). One Durable Object instance per owner
// (getByName('owner')) keeps the ledger of nested jobs that the owner's persistent Linux computer may start through a
// scoped, revocable, hashed 2h capability. The Worker-stored Daytona/Nosana master keys stay in this object: the
// owner machine holds only the capability, and each Daytona sandbox holds only its own per-job callback token.
// Nosana job definitions are public (IPFS), so a Nosana job carries NO secret: its status comes only from the
// authenticated deployment job list, a Nosana job never gets a callback, and its output is reported as unavailable.
//
// Contract (root owns routing; this module owns behaviour):
//   Owner RPC (owner WebAuthn cookie already checked by the root route):
//     configure({ requestId, ownerMachineId }) -> { ok, capability: { id, expiresAt }, install: CbNestedInstall, replay? }
//                                    mint + revoke older; a retried requestId within 2h returns the same install
//     revokeAll()                    -> { ok, revoked }
//     ownerJobs()                    -> { ok, jobs: CbNestedJobView[] }
//   Gateway (stub.fetch(request) for /p/_cloudbite/computer/nested/*; terminal Bearer only, any Origin header is refused):
//     POST run          Bearer capability  { requestId: UUID, provider: 'daytona'|'nosana', image?, timeout?, command: string[] }
//     GET  jobs         Bearer capability
//     POST stop         Bearer capability  { requestId: UUID, jobId }
//     POST result/<id>  Bearer callback    { exitCode, timedOut, output, truncated }   (Daytona jobs only)
//   Replies are { ok: true, ... } or { error: { code, message } } with fixed codes; never keys, tokens or provider text.
//
// Money/ownership rules: the ledger record (deterministic name + labels / Nosana idempotency key) is written before any
// external call; an uncertain create is never retried — the alarm reconciles read-only (labels / idempotency_key) and
// then cleans up only a resource proven to be this job's. Cleanup touches nothing but the exact recorded resource id
// after an ownership check, so the owner's personal computer (no nested label) is never stopped or deleted.
//
// Storage keys:
//   cap:<sha256>   Capability   (hash of the bearer capability; the token itself is never stored)
//   job:<id>       NestedJob
//   req:<uuid>     job id the mutating requestId created (idempotent replay)
//   cfg:<sha256>   configure replay: install AES-GCM sealed under a key derived from the requestId (never stored)
import { DurableObject } from 'cloudflare:workers';
import type { Env } from './state';
import { dt, DtError, type Dt, type Sandbox } from './lab';
import { cbDeleteSandbox, cbFindByLabels, cbGetSandbox, cbUpload, CbDaytonaError, type CbSandbox } from './cloudbite-daytona';
import { cloudbiteConfig, type CbAccountId } from './cloudbite-config';

export const CBN_CAP_TTL = 2 * 3600_000;
export const CBN_MAX_CAPS = 3;
export const CBN_MAX_ACTIVE = 2;
export const CBN_MAX_SECONDS = 600;
export const CBN_MIN_SECONDS = 10;
export const CBN_DEFAULT_SECONDS = 300;
export const CBN_OUTPUT_MAX = 64 * 1024;
export const CBN_RUN_BODY_MAX = 32 * 1024;
export const CBN_RESULT_BODY_MAX = CBN_OUTPUT_MAX * 6 + 4096; // worst case: every byte a 6-byte JSON escape
export const CBN_GRACE = 3 * 60_000;            // provisioning / image pull on top of the command timeout
export const CBN_RECONCILE_WINDOW = 60 * 60_000; // an unknown create keeps counting as active this long after its deadline
export const CBN_CLEANUP_MAX_TRIES = 12;
export const CBN_TICK = 15_000;
export const CBN_KEEP_JOBS = 50;
export const CBN_RETAIN = 24 * 3600_000;
export const CBN_DEFAULT_IMAGE = 'python:3.12-slim';
export const CBN_DAYTONA_RESOURCES = { cpu: 2, memory: 4, disk: 8 } as const;
export const CBN_NOSANA_API = 'https://client-manager.k8s.prd.nosana.com';
export const CBN_NOSANA_MARKET = '97G9NnvBDQ2WpKu6fasoMsAKmfj63C9rhysJnkeWodAf'; // RTX 4090
export const CBN_NOSANA_MAX_MINUTES = 10;
export const CBN_NOSANA_PAGES = 5;               // bounded cursor pagination of owner deployment lists
export const CBN_NOSANA_OUTPUT_NOTE = 'nosana_output_unavailable';
export const CBN_NOSANA_PUBLIC_NOTE = 'Nosana GPU job definitions (image and command) are public; never put secrets in them.';
export const CBN_LABEL_JOB = 'cloudbite-nested';
export const CBN_LABEL_OWNER = 'cloudbite-nested-owner';
export const CBN_WORKDIR = '/home/daytona/cloudbite-nested';
export const CBN_GATEWAY_PREFIX = '/p/_cloudbite/computer/nested';
export const CBN_CONFIG_PATH = '~/.config/cloudbite/compute.json';
export const CBN_CLI_PATH = '~/.local/bin/cloudbite-compute';
export const CBN_SCOPES = ['nested:run', 'nested:jobs', 'nested:stop'] as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const JOB_ID = /^nj[0-9a-f]{24}$/;
const IMAGE = /^[a-z0-9][a-z0-9._\/-]{0,150}(?::[\w][\w.-]{0,63})?(?:@sha256:[0-9a-f]{64})?$/;
const MACHINE = /^[\w.:-]{1,128}$/;
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/;

export type CbNestedProvider = 'daytona' | 'nosana';
export type CbNestedStatus = 'creating' | 'running' | 'uncertain' | 'succeeded' | 'failed' | 'timed_out' | 'stopped' | 'completed' | 'error';
type Cleanup = 'none' | 'pending' | 'done' | 'failed' | 'unknown';

interface Capability { id: string; ownerMachineId: string; scopes: string[]; createdAt: number; expiresAt: number; revoked?: boolean }
interface NestedJob {
  id: string; requestId: string; capId: string; ownerMachineId: string;
  provider: CbNestedProvider; image: string; command: string[]; timeoutSec: number;
  status: CbNestedStatus; createdAt: number; deadline: number; finishedAt?: number;
  name: string;                 // deterministic provider resource name
  account?: CbAccountId;        // Daytona account the sandbox lives in
  idempotencyKey?: string;      // Nosana create key, fixed before the create call
  resourceId?: string;
  launched?: boolean;           // Daytona runner started (re-start is safe: the runner exits on its marker)
  launchTries?: number;
  callbackHash?: string;        // Daytona only; a Nosana job has no callback
  providerState?: string;       // Nosana job state from the authenticated deployment job list
  providerJob?: string;         // Nosana job address from that list
  result?: { exitCode: number; timedOut: boolean; output: string; truncated: boolean; at: number };
  cleanup: Cleanup; cleanupTries: number;
  error?: string;               // fixed code only
}

export interface CbNestedJobView {
  id: string; provider: CbNestedProvider; status: CbNestedStatus; image: string; command: string[]; timeoutSec: number;
  createdAt: string; deadline: string; finishedAt: string | null; cleanup: Cleanup; error: string | null;
  result: { exitCode: number; timedOut: boolean; output: string; truncated: boolean } | null;
  providerState: string | null; public: boolean; note: string | null;
}

/** What the root installs on the owner machine (server side only; never sent to a browser). */
export interface CbNestedInstall {
  files: { path: string; mode: number; content: string }[];
  configPath: string; cliPath: string;
}

/** Everything external, injectable for tests. Keys are resolved here and never leave this object. */
export interface CbNestedDeps {
  now(): number;
  random(bytes: number): Uint8Array;
  daytona(): { account: CbAccountId; c: Dt } | null;
  nosanaKey(): string | null;
  gateway(): string | null;           // https origin the nested resources and the CLI call back to
}

export interface CbNestedStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(entries: Record<string, unknown>): Promise<void>;
  delete(keys: string[]): Promise<unknown>;
  list<T>(o: { prefix: string }): Promise<Map<string, T>>;
  setAlarm(at: number): Promise<void>;
}

type Reply = { status: number; body: Record<string, unknown> };
const ok = (body: Record<string, unknown> = {}, status = 200): Reply => ({ status, body: { ok: true, ...body } });
const err = (status: number, code: string, message: string): Reply => ({ status, body: { error: { code, message } } });

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const b64u = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export async function cbNestedHash(token: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`cloudbite-nested|${token}`))));
}
const bytes = (s: string) => new TextEncoder().encode(s).byteLength;
const iso = (t: number | undefined) => (t === undefined ? null : new Date(t).toISOString());
const terminal = (s: CbNestedStatus) => s === 'succeeded' || s === 'failed' || s === 'timed_out' || s === 'stopped' || s === 'completed' || s === 'error';

/** Keep the last max bytes of UTF-8 text (tail is what a failing command shows). */
export function cbNestedTail(s: string, max = CBN_OUTPUT_MAX): { text: string; cut: boolean } {
  const b = new TextEncoder().encode(s);
  if (b.byteLength <= max) return { text: s, cut: false };
  return { text: new TextDecoder().decode(b.slice(b.byteLength - max)).replace(/^�+/, ''), cut: true };
}

export interface CbNestedRunInput { requestId: string; provider: CbNestedProvider; image: string; timeoutSec: number; command: string[] }
/** Validate a run body. Metadata must be plain; the command is the owner's own intentional remote command. */
export function cbNestedParseRun(b: unknown): CbNestedRunInput | string {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return 'body must be a JSON object';
  const o = b as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!['requestId', 'provider', 'image', 'timeout', 'command'].includes(k)) return `unknown field ${k.slice(0, 32)}`;
  if (typeof o.requestId !== 'string' || !UUID.test(o.requestId)) return 'requestId must be a lowercase UUID';
  if (o.provider !== 'daytona' && o.provider !== 'nosana') return 'provider must be daytona or nosana';
  const image = o.image === undefined ? CBN_DEFAULT_IMAGE : o.image;
  if (typeof image !== 'string' || !IMAGE.test(image)) return 'image must be a plain container reference';
  const timeoutSec = o.timeout === undefined ? CBN_DEFAULT_SECONDS : o.timeout;
  if (typeof timeoutSec !== 'number' || !Number.isSafeInteger(timeoutSec) || timeoutSec < CBN_MIN_SECONDS || timeoutSec > CBN_MAX_SECONDS) return `timeout must be ${CBN_MIN_SECONDS}..${CBN_MAX_SECONDS} seconds`;
  const c = o.command;
  if (!Array.isArray(c) || c.length < 1 || c.length > 64) return 'command must be 1..64 strings';
  if (!c.every((a) => typeof a === 'string' && a.length <= 4096 && !CONTROL.test(a)) || !c[0]) return 'command arguments must be plain strings without control characters';
  if (bytes(JSON.stringify(c)) > 16 * 1024) return 'command is too long';
  return { requestId: o.requestId, provider: o.provider, image, timeoutSec, command: c as string[] };
}

function view(j: NestedJob): CbNestedJobView {
  return {
    id: j.id, provider: j.provider, status: j.status, image: j.image, command: j.command, timeoutSec: j.timeoutSec,
    createdAt: iso(j.createdAt)!, deadline: iso(j.deadline)!, finishedAt: iso(j.finishedAt), cleanup: j.cleanup, error: j.error ?? null,
    result: j.result ? { exitCode: j.result.exitCode, timedOut: j.result.timedOut, output: j.result.output, truncated: j.result.truncated } : null,
    providerState: j.providerState ?? null, public: j.provider === 'nosana',
    note: j.provider === 'nosana' ? `${CBN_NOSANA_PUBLIC_NOTE} Output: ${CBN_NOSANA_OUTPUT_NOTE}` : null,
  };
}

/** A job may still hold (or create) paid resources. */
function active(j: NestedJob, now: number) {
  if (j.cleanup === 'done') return false;
  if (j.cleanup === 'unknown' || j.cleanup === 'failed') return now < j.deadline + CBN_RECONCILE_WINDOW;
  if (j.status === 'error' && !j.resourceId && j.cleanup === 'none') return false;
  return true;
}

class NosanaError extends Error {
  constructor(public status: number) { super(`Nosana HTTP ${status || 'unreachable'}`); }
  get uncertain() { return this.status === 0 || this.status >= 500 || this.status === 408 || this.status === 429; }
}
interface NosanaDeployment { id: string; name: string; status: string }
interface NosanaPage { cursor_next?: string | null }
interface NosanaJob { job: string; deployment: string; market: string; state: string }

async function nosana<T>(key: string, method: string, path: string, body?: unknown): Promise<T> {
  let r: Response;
  try {
    r = await fetch(CBN_NOSANA_API + path, {
      method, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000),
    });
  } catch { throw new NosanaError(0); }
  const text = await r.text().catch(() => '');
  if (!r.ok) throw new NosanaError(r.status);
  try { return (text ? JSON.parse(text) : {}) as T; } catch { throw new NosanaError(0); }
}

/** The nested job service. Every state change runs in one serial queue; provider calls happen between steps. */
export class CbNestedService {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private s: CbNestedStorage, private d: CbNestedDeps) {}
  private serial<T>(f: () => Promise<T>): Promise<T> {
    const run = this.queue.then(f, f);
    this.queue = run.catch(() => {});
    return run;
  }
  private token(prefix: string) { return prefix + b64u(this.d.random(32)); }
  private async jobs(): Promise<NestedJob[]> {
    return [...(await this.s.list<NestedJob>({ prefix: 'job:' })).values()].sort((a, b) => b.createdAt - a.createdAt);
  }
  private async save(j: NestedJob) { await this.s.put({ [`job:${j.id}`]: j }); }
  private async patch(id: string, f: (j: NestedJob) => void) {
    return this.serial(async () => {
      const j = await this.s.get<NestedJob>(`job:${id}`);
      if (!j) return undefined;
      f(j); await this.save(j); return j;
    });
  }
  private wake(at: number) { return this.s.setAlarm(at); }

  // ---- owner RPC ----
  async configure(input: { requestId: string; ownerMachineId: string }): Promise<Reply> {
    if (!input || typeof input.requestId !== 'string' || !UUID.test(input.requestId)) return err(400, 'bad_request', 'requestId must be a lowercase UUID');
    if (typeof input.ownerMachineId !== 'string' || !MACHINE.test(input.ownerMachineId)) return err(400, 'bad_request', 'ownerMachineId is invalid');
    const gateway = this.d.gateway();
    if (!gateway) return err(503, 'not_configured', 'nested compute gateway is not configured');
    const cfgKey = `cfg:${await cbNestedHash(`cfg|${input.requestId}`)}`;
    return this.serial(async () => {
      const now = this.d.now();
      const prior = await this.s.get<SealedInstall>(cfgKey);
      if (prior) {
        if (prior.ownerMachineId !== input.ownerMachineId) return err(409, 'conflict', 'requestId was already used for a different machine');
        const cap = await this.s.get<Capability>(prior.capKey);
        if (!cap || cap.revoked || cap.expiresAt <= now) return err(409, 'conflict', 'requestId was already used and its capability has ended');
        const install = await unseal(input.requestId, prior).catch(() => null);
        if (!install) return err(409, 'conflict', 'requestId was already used');
        return ok({ capability: { id: cap.id, expiresAt: iso(cap.expiresAt) }, install, replay: true });
      }
      const caps = [...(await this.s.list<Capability>({ prefix: 'cap:' })).entries()].sort((a, b) => b[1].createdAt - a[1].createdAt);
      const drop: string[] = [];
      for (const [k, c] of caps) if (c.revoked || c.expiresAt <= now) drop.push(k);
      for (const [k, c] of await this.s.list<SealedInstall>({ prefix: 'cfg:' })) if (c.expiresAt <= now) drop.push(k);
      const live = caps.filter(([k]) => !drop.includes(k));
      // Keep at most CBN_MAX_CAPS - 1 older live capabilities (a reinstall overlaps briefly); revoke the rest.
      const revoke = live.slice(CBN_MAX_CAPS - 1).map(([k, c]) => [k, { ...c, revoked: true }] as const);
      if (drop.length) await this.s.delete(drop);
      const token = this.token('cbn_');
      const cap: Capability = { id: 'cap' + hex(this.d.random(8)), ownerMachineId: input.ownerMachineId, scopes: [...CBN_SCOPES], createdAt: now, expiresAt: now + CBN_CAP_TTL };
      const capKey = `cap:${await cbNestedHash(token)}`;
      const install = cbNestedInstall(gateway, token, cap.expiresAt);
      const sealed = await seal(input.requestId, install, { capKey, ownerMachineId: input.ownerMachineId, expiresAt: cap.expiresAt });
      await this.s.put({ [capKey]: cap, [cfgKey]: sealed, ...Object.fromEntries(revoke) });
      return ok({ capability: { id: cap.id, expiresAt: iso(cap.expiresAt) }, install });
    });
  }

  async revokeAll(): Promise<Reply> {
    return this.serial(async () => {
      const caps = await this.s.list<Capability>({ prefix: 'cap:' });
      const cfgs = await this.s.list<SealedInstall>({ prefix: 'cfg:' });
      await this.s.delete([...caps.keys(), ...cfgs.keys()]);
      return ok({ revoked: caps.size });
    });
  }

  async ownerJobs(): Promise<Reply> { return ok({ jobs: (await this.jobs()).map(view) }); }

  // ---- gateway ----
  private async capability(req: Request, scope: string): Promise<Capability | Reply> {
    const m = /^Bearer (cbn_[\w-]{43})$/.exec(req.headers.get('authorization') ?? '');
    if (!m) return err(401, 'unauthorized', 'capability required');
    const cap = await this.s.get<Capability>(`cap:${await cbNestedHash(m[1])}`);
    if (!cap || cap.revoked || cap.expiresAt <= this.d.now()) return err(401, 'unauthorized', 'capability expired or revoked');
    if (!cap.scopes.includes(scope)) return err(403, 'forbidden', 'capability scope does not allow this');
    return cap;
  }

  async fetch(req: Request): Promise<Response> {
    const r = await this.route(req);
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  }

  private async route(req: Request): Promise<Reply> {
    if (req.headers.has('origin')) return err(403, 'forbidden', 'terminal clients only');
    const path = new URL(req.url).pathname;
    const i = path.indexOf(CBN_GATEWAY_PREFIX + '/');
    const sub = i < 0 ? '' : path.slice(i + CBN_GATEWAY_PREFIX.length + 1);
    const res = /^result\/([^/]+)$/.exec(sub);
    if (res && req.method === 'POST') return this.result(req, res[1]);
    if (sub === 'jobs' && req.method === 'GET') {
      const cap = await this.capability(req, 'nested:jobs');
      return 'status' in cap ? cap : ok({ jobs: (await this.jobs()).slice(0, CBN_KEEP_JOBS).map(view) });
    }
    if ((sub === 'run' || sub === 'stop') && req.method === 'POST') {
      const cap = await this.capability(req, `nested:${sub}`);
      if ('status' in cap) return cap;
      const body = await readJson(req, CBN_RUN_BODY_MAX);
      if (body === undefined) return err(400, 'bad_request', 'body must be JSON within the size limit');
      return sub === 'run' ? this.run(cap, body) : this.stop(body);
    }
    return err(404, 'not_found', 'unknown nested route');
  }

  async run(cap: Capability, body: unknown): Promise<Reply> {
    const p = cbNestedParseRun(body);
    if (typeof p === 'string') return err(400, 'bad_request', p);
    if (p.provider === 'daytona' ? !this.d.daytona() : !this.d.nosanaKey()) return err(503, 'not_configured', `${p.provider} is not configured`);
    const gateway = this.d.gateway();
    if (!gateway) return err(503, 'not_configured', 'nested compute gateway is not configured');
    const callback = p.provider === 'daytona' ? this.token('cbr_') : null;
    const admitted = await this.serial(async (): Promise<Reply | NestedJob> => {
      const now = this.d.now();
      const prior = await this.s.get<string>(`req:${p.requestId}`);
      if (prior) {
        const j = await this.s.get<NestedJob>(`job:${prior}`);
        if (!j) return err(409, 'conflict', 'requestId was already used');
        const same = j.provider === p.provider && j.image === p.image && j.timeoutSec === p.timeoutSec && JSON.stringify(j.command) === JSON.stringify(p.command);
        return same ? ok({ job: view(j), replay: true }) : err(409, 'conflict', 'requestId was already used for a different run');
      }
      const all = await this.jobs();
      if (all.filter((j) => active(j, now)).length >= CBN_MAX_ACTIVE) return err(429, 'busy', `at most ${CBN_MAX_ACTIVE} nested jobs may be active`);
      const id = 'nj' + hex(this.d.random(12));
      const dy = p.provider === 'daytona' ? this.d.daytona() : null;
      const minutes = Math.min(CBN_NOSANA_MAX_MINUTES, Math.ceil(p.timeoutSec / 60) + 2);
      const j: NestedJob = {
        id, requestId: p.requestId, capId: cap.id, ownerMachineId: cap.ownerMachineId,
        provider: p.provider, image: p.image, command: p.command, timeoutSec: p.timeoutSec,
        status: 'creating', createdAt: now,
        deadline: now + (p.provider === 'nosana' ? minutes * 60_000 : Math.min(CBN_MAX_SECONDS * 1000, p.timeoutSec * 1000 + 60_000)) + CBN_GRACE,
        name: `cbn-${id}`, ...(dy ? { account: dy.account } : {}),
        ...(p.provider === 'nosana' ? { idempotencyKey: uuidFrom(this.d.random(16)) } : {}),
        ...(callback ? { callbackHash: await cbNestedHash(callback) } : {}), cleanup: 'none', cleanupTries: 0,
      };
      // Ledger first: the record (name, labels, idempotency key) exists before any provider call.
      await this.s.put({ [`job:${id}`]: j, [`req:${p.requestId}`]: id });
      await this.prune(all, now);
      await this.wake(Math.min(j.deadline, now + CBN_TICK));
      return j;
    });
    if ('body' in admitted) return admitted;
    const j = admitted;
    const callbackUrl = `${gateway}${CBN_GATEWAY_PREFIX}/result/${j.id}`;
    const done = callback ? await this.createDaytona(j, callbackUrl, callback) : await this.createNosana(j);
    return ok({ job: view(done ?? j) }, 202);
  }

  private async createDaytona(j: NestedJob, callbackUrl: string, callback: string) {
    const dy = this.d.daytona();
    if (!dy || dy.account !== j.account) return this.patch(j.id, (x) => { x.status = 'error'; x.error = 'account_changed'; });
    const labels = { [CBN_LABEL_JOB]: j.id, [CBN_LABEL_OWNER]: j.ownerMachineId };
    const body = {
      labels, ...CBN_DAYTONA_RESOURCES, public: false, autoStopInterval: 15, autoDeleteInterval: 0,
      buildInfo: { dockerfileContent: `FROM ${j.image}\n` },
    };
    let sb: CbSandbox;
    try { sb = await dt<CbSandbox>(dy.c, 'POST', '/sandbox', body, AbortSignal.timeout(45_000)); }
    catch (e) {
      const status = e instanceof DtError ? e.status : 0;
      const uncertain = status === 0 || status >= 500 || status === 408 || status === 429;
      // No retry of a paid create: an uncertain one is reconciled read-only by labels in the alarm.
      return this.patch(j.id, (x) => {
        if (uncertain) { x.status = 'uncertain'; x.cleanup = 'unknown'; x.error = 'create_uncertain'; }
        else { x.status = 'error'; x.error = 'create_rejected'; x.finishedAt = this.d.now(); }
      });
    }
    const after = await this.patch(j.id, (x) => { x.resourceId = sb.id; x.status = 'running'; });
    if (sb.state === 'started') await this.launchDaytona(after ?? j, sb, callbackUrl, callback);
    else await this.s.put({ [`launch:${j.id}`]: { callbackUrl, callback } }); // per-job secret held until launch, deleted then
    return this.s.get<NestedJob>(`job:${j.id}`);
  }

  private async launchDaytona(j: NestedJob, sb: Sandbox, callbackUrl: string, callback: string) {
    const dy = this.d.daytona();
    if (!dy || dy.account !== j.account) return;
    const job = { jobId: j.id, command: j.command, timeout: j.timeoutSec, callback: callbackUrl, token: callback };
    const t: Dt = { ...dy.c, api: sb.toolboxProxyUrl ?? 'https://proxy.app.daytona.io/toolbox' };
    const sessionId = `cbn-${j.id}`;
    try {
      await cbUpload(dy.c, sb, `${CBN_WORKDIR}/runner.py`, CBN_RUNNER_PY);
      await cbUpload(dy.c, sb, `${CBN_WORKDIR}/job.json`, JSON.stringify(job));
      try { await dt(t, 'POST', `/${sb.id}/process/session`, { sessionId }, AbortSignal.timeout(20_000)); }
      catch (e) { if (!(e instanceof DtError) || e.status >= 500) throw e; } // 4xx: the session already exists
      const command = `bash -c 'cd ${CBN_WORKDIR} && exec timeout -k 5 ${j.timeoutSec + 60} python3 -I runner.py job.json >> runner.log 2>&1'`;
      await dt(t, 'POST', `/${sb.id}/process/session/${sessionId}/exec`, { command, runAsync: true }, AbortSignal.timeout(20_000));
      await this.patch(j.id, (x) => { x.launched = true; });
      await this.s.delete([`launch:${j.id}`]);
    } catch {
      // Re-launch is safe (the runner exits when its start marker exists); the alarm retries a few times.
      await this.patch(j.id, (x) => { x.launchTries = (x.launchTries ?? 0) + 1; });
    }
  }

  private async createNosana(j: NestedJob) {
    const key = this.d.nosanaKey()!;
    // Public job definition: no callback URL, no token, no key. The runner prints its bounded JSON result to stdout.
    const job = b64u(new TextEncoder().encode(JSON.stringify({ jobId: j.id, command: j.command, timeout: j.timeoutSec })));
    const body = {
      idempotency_key: j.idempotencyKey, name: j.name, market: CBN_NOSANA_MARKET, replicas: 1,
      timeout: Math.min(CBN_NOSANA_MAX_MINUTES, Math.ceil(j.timeoutSec / 60) + 2), autostart: true, strategy: 'SIMPLE',
      job_definition: {
        version: '0.1', type: 'container',
        ops: [{ id: 'work', type: 'container/run', args: {
          image: j.image, gpu: true,
          cmd: ['python3', '-I', '-c', CBN_RUNNER_PY, '--b64', job],
        } }],
      },
    };
    try {
      const d = await nosana<NosanaDeployment>(key, 'POST', '/deployments/create', body);
      return this.patch(j.id, (x) => { x.resourceId = d.id; x.status = 'running'; });
    } catch (e) {
      const st = e instanceof NosanaError ? e.status : 0;
      if (st === 409) return this.reconcileNosana(j.id);
      const uncertain = !(e instanceof NosanaError) || e.uncertain;
      return this.patch(j.id, (x) => {
        if (uncertain) { x.status = 'uncertain'; x.cleanup = 'unknown'; x.error = 'create_uncertain'; }
        else { x.status = 'error'; x.error = 'create_rejected'; x.finishedAt = this.d.now(); }
      });
    }
  }

  /** Read-only: find this job's deployment by its exact idempotency key and name. Never re-creates. */
  private async reconcileNosana(id: string) {
    const j = await this.s.get<NestedJob>(`job:${id}`);
    const key = this.d.nosanaKey();
    if (!j || !key || !j.idempotencyKey) return j;
    try {
      // No `limit` (the live list rejected limit=1 with 400): follow cursor_next a bounded number of pages and match
      // the exact name client side as well as by the server-side idempotency_key filter.
      let hit: NosanaDeployment | undefined, cursor: string | null | undefined;
      for (let page = 0; page < CBN_NOSANA_PAGES && !hit; page++) {
        const q = `idempotency_key=${encodeURIComponent(j.idempotencyKey)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
        const list = await nosana<{ deployments?: NosanaDeployment[]; pagination?: NosanaPage }>(key, 'GET', `/deployments?${q}`);
        hit = (Array.isArray(list.deployments) ? list.deployments : []).find((d) => d && d.name === j.name && typeof d.id === 'string');
        cursor = list.pagination?.cursor_next;
        if (!cursor) break;
      }
      return this.patch(id, (x) => {
        if (hit) { x.resourceId = hit.id; if (x.status === 'uncertain' || x.status === 'creating') x.status = 'running'; if (x.cleanup === 'unknown') x.cleanup = terminal(x.status) ? 'pending' : 'none'; delete x.error; }
        else if (x.status === 'creating') { x.status = 'uncertain'; x.cleanup = 'unknown'; x.error = 'create_uncertain'; }
      });
    } catch { return this.patch(id, (x) => { if (x.status === 'creating') { x.status = 'uncertain'; x.cleanup = 'unknown'; x.error = 'create_uncertain'; } }); }
  }

  private async reconcileDaytona(id: string) {
    const j = await this.s.get<NestedJob>(`job:${id}`);
    const dy = this.d.daytona();
    if (!j || !dy || dy.account !== j.account) return;
    try {
      const hit = (await cbFindByLabels(dy.c, { [CBN_LABEL_JOB]: j.id, [CBN_LABEL_OWNER]: j.ownerMachineId }))[0];
      // Found: adopt it only to delete it — the callback secret was never persisted for a later launch.
      if (hit) await this.patch(id, (x) => { x.resourceId = hit.id; x.cleanup = 'pending'; if (!terminal(x.status)) { x.status = 'error'; x.finishedAt = this.d.now(); } x.error = 'create_uncertain'; });
    } catch { /* still unknown; retained */ }
  }

  async stop(body: unknown): Promise<Reply> {
    const o = body as Record<string, unknown> | null;
    if (!o || typeof o.requestId !== 'string' || !UUID.test(o.requestId)) return err(400, 'bad_request', 'requestId must be a lowercase UUID');
    if (typeof o.jobId !== 'string' || !JOB_ID.test(o.jobId)) return err(400, 'bad_request', 'jobId is invalid');
    const j = await this.patch(o.jobId, (x) => {
      if (terminal(x.status)) return;
      x.status = 'stopped'; x.finishedAt = this.d.now();
      if (x.cleanup === 'none') x.cleanup = 'pending';
    });
    if (!j) return err(404, 'not_found', 'no such job');
    await this.wake(this.d.now());
    return ok({ job: view(j) });
  }

  async result(req: Request, id: string): Promise<Reply> {
    if (!JOB_ID.test(id)) return err(404, 'not_found', 'no such job');
    const m = /^Bearer (cbr_[\w-]{43})$/.exec(req.headers.get('authorization') ?? '');
    if (!m) return err(401, 'unauthorized', 'callback token required');
    const hash = await cbNestedHash(m[1]);
    const body = await readJson(req, CBN_RESULT_BODY_MAX);
    const o = body as Record<string, unknown> | undefined;
    if (!o || !Number.isSafeInteger(o.exitCode) || typeof o.timedOut !== 'boolean' || typeof o.output !== 'string' || typeof o.truncated !== 'boolean')
      return err(400, 'bad_request', 'result must be { exitCode, timedOut, output, truncated }');
    const out = cbNestedTail(o.output as string);
    let outcome: Reply = ok();
    await this.serial(async () => {
      const j = await this.s.get<NestedJob>(`job:${id}`);
      if (!j || j.provider !== 'daytona' || !j.callbackHash || j.callbackHash !== hash) { outcome = err(401, 'unauthorized', 'callback token rejected'); return; }
      if (j.result) { outcome = err(409, 'conflict', 'result already recorded'); return; }
      const now = this.d.now();
      j.result = { exitCode: o.exitCode as number, timedOut: o.timedOut as boolean, output: out.text, truncated: (o.truncated as boolean) || out.cut, at: now };
      if (!terminal(j.status) || j.status === 'stopped') {
        if (j.status !== 'stopped') j.status = j.result.timedOut ? 'timed_out' : j.result.exitCode === 0 ? 'succeeded' : 'failed';
        j.finishedAt ??= now;
      }
      if (j.cleanup === 'none' || j.cleanup === 'unknown') j.cleanup = j.resourceId ? 'pending' : j.cleanup;
      await this.save(j);
      await this.s.delete([`launch:${id}`]);
    });
    if ('error' in outcome.body) return outcome;
    await this.wake(this.d.now());
    return ok();
  }

  /** Alarm: launch, expire, reconcile (read-only) and clean up owned resources only. Returns the next wake time or null. */
  async alarm(): Promise<number | null> {
    const now = this.d.now();
    let next: number | null = null;
    const soon = (t: number) => { next = next === null ? t : Math.min(next, t); };
    for (const j0 of await this.jobs()) {
      let j: NestedJob | undefined = j0;
      if (!terminal(j.status) && now >= j.deadline) {
        j = await this.patch(j.id, (x) => { if (!terminal(x.status)) { x.status = x.status === 'uncertain' ? 'error' : 'timed_out'; x.finishedAt = now; } if (x.resourceId && x.cleanup === 'none') x.cleanup = 'pending'; });
      }
      if (!j) continue;
      if (j.status === 'creating' && j.provider === 'nosana' && now - j.createdAt > 60_000) j = await this.reconcileNosana(j.id);
      if (!j) continue;
      if (j.cleanup === 'unknown' && now < j.deadline + CBN_RECONCILE_WINDOW) {
        if (j.provider === 'nosana') await this.reconcileNosana(j.id); else await this.reconcileDaytona(j.id);
        j = await this.s.get<NestedJob>(`job:${j.id}`);
        if (!j) continue;
        if (j.cleanup === 'unknown') { soon(now + 60_000); continue; }
      }
      if (j.provider === 'nosana' && j.status === 'running' && j.resourceId && j.cleanup === 'none') {
        j = await this.pollNosana(j);
        if (!j) continue;
      }
      if (j.provider === 'daytona' && j.status === 'running' && j.resourceId && !j.launched && j.cleanup === 'none') {
        await this.tryLaunch(j);
        soon(now + CBN_TICK);
        continue;
      }
      if (j.cleanup === 'pending') {
        await this.cleanupOne(j);
        const after = await this.s.get<NestedJob>(`job:${j.id}`);
        if (after?.cleanup === 'pending') soon(now + Math.min(5 * 60_000, CBN_TICK * 2 ** Math.min(4, after.cleanupTries)));
        continue;
      }
      if (!terminal(j.status)) soon(Math.min(j.deadline, now + CBN_TICK));
    }
    if (next !== null) await this.wake(next);
    return next;
  }

  private async tryLaunch(j: NestedJob) {
    const pending = await this.s.get<{ callbackUrl: string; callback: string }>(`launch:${j.id}`);
    const dy = this.d.daytona();
    if (!pending || !dy || dy.account !== j.account || (j.launchTries ?? 0) >= 5) {
      await this.patch(j.id, (x) => { x.status = 'error'; x.error = 'launch_failed'; x.finishedAt = this.d.now(); x.cleanup = 'pending'; });
      return;
    }
    let sb: CbSandbox;
    try { sb = await cbGetSandbox(dy.c, j.resourceId!); } catch { return; }
    if (sb.labels?.[CBN_LABEL_JOB] !== j.id) { await this.patch(j.id, (x) => { x.status = 'error'; x.error = 'ownership_mismatch'; x.cleanup = 'failed'; }); return; }
    if (sb.state === 'started') await this.launchDaytona(j, sb, pending.callbackUrl, pending.callback);
    else if (sb.state === 'error' || sb.state === 'build_failed') await this.patch(j.id, (x) => { x.status = 'error'; x.error = 'sandbox_failed'; x.finishedAt = this.d.now(); x.cleanup = 'pending'; });
  }

  /** Read-only: the authenticated owner deployment job list is the only source of a Nosana job's state. */
  private async pollNosana(j: NestedJob): Promise<NestedJob | undefined> {
    const key = this.d.nosanaKey();
    if (!key || !j.resourceId) return j;
    let found: NosanaJob | undefined, cursor: string | null | undefined;
    try {
      for (let page = 0; page < CBN_NOSANA_PAGES; page++) {
        const q = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
        const list = await nosana<{ jobs?: NosanaJob[]; pagination?: NosanaPage }>(key, 'GET', `/deployments/${encodeURIComponent(j.resourceId)}/jobs${q}`);
        // Only a job of this exact deployment on the pinned market counts.
        found = (Array.isArray(list.jobs) ? list.jobs : []).find((x) => x && x.deployment === j.resourceId && x.market === CBN_NOSANA_MARKET && typeof x.job === 'string');
        cursor = list.pagination?.cursor_next;
        if (found || !cursor) break;
      }
    } catch { return j; }
    if (!found) return j;
    const f = found;
    return this.patch(j.id, (x) => {
      if (terminal(x.status)) return;
      x.providerState = f.state; x.providerJob = f.job;
      if (f.state === 'COMPLETED' || f.state === 'STOPPED') {
        x.status = f.state === 'COMPLETED' ? 'completed' : 'stopped';
        x.finishedAt = this.d.now(); x.error = CBN_NOSANA_OUTPUT_NOTE;
        x.cleanup = 'pending';
      }
    });
  }

  /** Stop/delete exactly the recorded resource after proving it is this job's. Never anything else. */
  private async cleanupOne(j: NestedJob) {
    const mark = async (c: Cleanup, code?: string) => {
      await this.patch(j.id, (x) => { x.cleanup = c; x.cleanupTries++; if (code) x.error = code; });
      if (c === 'done') await this.s.delete([`launch:${j.id}`]);
    };
    if (!j.resourceId) return mark('done');
    if (j.cleanupTries >= CBN_CLEANUP_MAX_TRIES) return mark('failed', 'cleanup_failed');
    try {
      if (j.provider === 'daytona') {
        const dy = this.d.daytona();
        if (!dy || dy.account !== j.account) return mark('pending');
        let sb: CbSandbox | null = null;
        try { sb = await cbGetSandbox(dy.c, j.resourceId); }
        catch (e) { if (e instanceof CbDaytonaError && e.status === 404) return mark('done'); throw e; }
        if (sb.labels?.[CBN_LABEL_JOB] !== j.id) return mark('failed', 'ownership_mismatch');
        await cbDeleteSandbox(dy.c, j.resourceId);
        return mark('done');
      }
      const key = this.d.nosanaKey();
      if (!key) return mark('pending');
      let d: NosanaDeployment;
      try { d = await nosana<NosanaDeployment>(key, 'GET', `/deployments/${encodeURIComponent(j.resourceId)}`); }
      catch (e) { if (e instanceof NosanaError && e.status === 404) return mark('done'); throw e; }
      if (d.name !== j.name) return mark('failed', 'ownership_mismatch');
      if (d.status === 'ARCHIVED') return mark('done');
      if (d.status !== 'STOPPED') {
        if (d.status !== 'STOPPING') await nosana(key, 'POST', `/deployments/${encodeURIComponent(j.resourceId)}/stop`);
        return mark('pending'); // delete requires STOPPED; the next alarm deletes
      }
      try { await nosana(key, 'DELETE', `/deployments/${encodeURIComponent(j.resourceId)}`); }
      catch (e) { if (!(e instanceof NosanaError && e.status === 404)) throw e; }
      return mark('done');
    } catch { return mark('pending'); }
  }

  private async prune(all: NestedJob[], now: number) {
    const old = all.filter((j) => j.cleanup === 'done' && terminal(j.status) && now - (j.finishedAt ?? j.createdAt) > CBN_RETAIN);
    const extra = all.filter((j) => j.cleanup === 'done' && terminal(j.status)).slice(CBN_KEEP_JOBS);
    const drop = [...new Set([...old, ...extra])];
    if (drop.length) await this.s.delete(drop.flatMap((j) => [`job:${j.id}`, `req:${j.requestId}`]));
  }
}

interface SealedInstall { capKey: string; ownerMachineId: string; expiresAt: number; iv: string; ct: string }
async function sealKey(requestId: string) {
  const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`cloudbite-nested-seal|${requestId}`));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
async function seal(requestId: string, install: CbNestedInstall, meta: Omit<SealedInstall, 'iv' | 'ct'>): Promise<SealedInstall> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(meta.capKey) }, await sealKey(requestId), new TextEncoder().encode(JSON.stringify(install)));
  return { ...meta, iv: hex(iv), ct: btoa(String.fromCharCode(...new Uint8Array(ct))) };
}
async function unseal(requestId: string, s: SealedInstall): Promise<CbNestedInstall> {
  const iv = new Uint8Array(s.iv.match(/../g)!.map((h) => parseInt(h, 16)));
  const ct = Uint8Array.from(atob(s.ct), (c) => c.charCodeAt(0));
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(s.capKey) }, await sealKey(requestId), ct);
  return JSON.parse(new TextDecoder().decode(pt)) as CbNestedInstall;
}

function uuidFrom(b: Uint8Array) {
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = hex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

async function readJson(req: Request, max: number): Promise<unknown> {
  if (Number(req.headers.get('content-length') ?? 0) > max) return undefined;
  const buf = await req.arrayBuffer().catch(() => null);
  if (!buf || buf.byteLength > max) return undefined;
  try { return JSON.parse(new TextDecoder().decode(buf)); } catch { return undefined; }
}

/** Files the root writes on the owner machine (mode 0600 config, 0700 CLI). The token appears only in the config file. */
export function cbNestedInstall(gateway: string, token: string, expiresAt: number): CbNestedInstall {
  const config = { version: 1, gateway, prefix: CBN_GATEWAY_PREFIX, token, expiresAt: new Date(expiresAt).toISOString() };
  return {
    configPath: CBN_CONFIG_PATH, cliPath: CBN_CLI_PATH,
    files: [
      { path: CBN_CONFIG_PATH, mode: 0o600, content: JSON.stringify(config, null, 2) + '\n' },
      { path: CBN_CLI_PATH, mode: 0o700, content: CBN_CLI_PY },
    ],
  };
}

/** The Durable Object. Root binds it (e.g. CLOUDBITE_COMPUTER_NESTED) and routes owner RPC + gateway fetch here. */
export class CloudbiteComputerNested extends DurableObject<Env> {
  private svc?: CbNestedService;
  protected deps(): CbNestedDeps {
    const cfg = cloudbiteConfig(this.env);
    return {
      now: () => Date.now(),
      random: (n) => crypto.getRandomValues(new Uint8Array(n)),
      daytona: () => (cfg ? { account: 'primary', c: { api: cfg.daytona.api, key: cfg.daytona.key } } : null),
      nosanaKey: () => this.env.CLOUDBITE_NOSANA_API_KEY || null,
      gateway: () => cfg?.gateway ?? null,
    };
  }
  protected service() {
    const st = this.ctx.storage;
    return this.svc ??= new CbNestedService({
      get: (k) => st.get(k), put: (e) => st.put(e), delete: (k) => st.delete(k),
      list: (o) => st.list(o), setAlarm: (t) => st.setAlarm(t),
    } as CbNestedStorage, this.deps());
  }
  configure(input: { requestId: string; ownerMachineId: string }) { return this.service().configure(input); }
  revokeAll() { return this.service().revokeAll(); }
  ownerJobs() { return this.service().ownerJobs(); }
  async ownerJobsJson(): Promise<string> { return JSON.stringify(await this.service().ownerJobs()); }
  async configureJson(input: { ownerMachineId: string; requestId: string }): Promise<string> { return JSON.stringify(await this.service().configure(input)); }
  fetch(req: Request) { return this.service().fetch(req); }
  async alarm() { await this.service().alarm(); }
}

// Fixed runner (Daytona file or Nosana `python3 -I -c`). Runs the owner's command with a hard timeout, keeps the last
// 64 KiB of combined output, posts it once to the HTTPS callback with the per-job token. No provider key is ever present.
export const CBN_RUNNER_PY = String.raw`import base64, json, os, subprocess, sys, time, urllib.request
MAX = 65536
if len(sys.argv) >= 3 and sys.argv[1] == '--b64':
    s = sys.argv[2]; job = json.loads(base64.urlsafe_b64decode(s + '=' * (-len(s) % 4)))
    token = ''
else:
    path = sys.argv[1]
    try:
        fd = os.open(path + '.started', os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600); os.close(fd)
    except FileExistsError:
        sys.exit(0)
    with open(path) as f: job = json.load(f)
    os.remove(path)
    token = job.pop('token', '')
env = {k: v for k, v in os.environ.items() if k != 'CLOUDBITE_JOB_TOKEN'}
env.setdefault('PYTHONUNBUFFERED', '1')
posix = os.name == 'posix'
buf = bytearray(); cut = False; timed = False; code = -1
try:
    p = subprocess.Popen(job['command'], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, env=env, start_new_session=posix)
    end = time.monotonic() + int(job['timeout'])
    os.set_blocking(p.stdout.fileno(), False)
    while True:
        chunk = p.stdout.read(65536)
        if chunk:
            buf += chunk
            if len(buf) > MAX: del buf[:len(buf) - MAX]; cut = True
        elif p.poll() is not None:
            break
        else:
            time.sleep(0.1)
        if time.monotonic() > end:
            timed = True
            try:
                os.killpg(p.pid, 9) if posix else p.kill()
            except Exception:
                p.kill()
            p.wait(); break
    code = p.returncode if p.returncode is not None else -1
except Exception as e:
    buf += ('runner: could not start command: %s' % type(e).__name__).encode()
body = json.dumps({'exitCode': int(code), 'timedOut': timed, 'output': buf.decode('utf-8', 'replace'), 'truncated': cut}, ensure_ascii=False).encode()
if not job.get('callback'):
    sys.stdout.write('CLOUDBITE_RESULT ' + body.decode() + '\n'); sys.stdout.flush(); sys.exit(0)
req = urllib.request.Request(job['callback'], data=body, method='POST', headers={'authorization': 'Bearer ' + token, 'content-type': 'application/json', 'user-agent': 'CloudBiteCompute/1.0'})
for i in range(4):
    try:
        urllib.request.urlopen(req, timeout=30).read(); break
    except urllib.error.HTTPError as e:
        if e.code < 500: break
    except Exception:
        pass
    time.sleep(2 ** i)
`;

// Owner-machine CLI. Reads the root-installed private config; never prints the token.
export const CBN_CLI_PY = String.raw`#!/usr/bin/env python3
"""cloudbite-compute: run bounded extra compute (Daytona CPU / Nosana GPU) from this Cloudbite computer."""
import json, os, stat, sys, time, uuid, urllib.request, urllib.error
from urllib.parse import urlparse
CONFIG = os.path.expanduser(os.environ.get('CLOUDBITE_COMPUTE_CONFIG', '~/.config/cloudbite/compute.json'))
USAGE = '''usage:
  cloudbite-compute doctor
  cloudbite-compute jobs
  cloudbite-compute run --provider daytona|nosana [--image IMAGE] [--timeout SECONDS] [--no-wait] -- COMMAND [ARGS...]
  cloudbite-compute stop JOBID'''

class Usage(Exception): pass

def parse(argv):
    if not argv or argv[0] in ('-h', '--help', 'help'): raise Usage(USAGE)
    cmd, rest = argv[0], argv[1:]
    if cmd in ('doctor', 'jobs'):
        if rest: raise Usage('%s takes no arguments' % cmd)
        return {'cmd': cmd}
    if cmd == 'stop':
        if len(rest) != 1: raise Usage('stop needs exactly one JOBID')
        return {'cmd': 'stop', 'jobId': rest[0]}
    if cmd != 'run': raise Usage('unknown command: %s' % cmd[:40])
    if '--' not in rest: raise Usage('run needs -- before the command')
    i = rest.index('--'); opts, command = rest[:i], rest[i + 1:]
    if not command: raise Usage('run needs a command after --')
    out = {'cmd': 'run', 'provider': None, 'image': None, 'timeout': 300, 'wait': True, 'command': command}
    j = 0
    while j < len(opts):
        o = opts[j]
        if o == '--no-wait': out['wait'] = False; j += 1; continue
        if o not in ('--provider', '--image', '--timeout') or j + 1 >= len(opts): raise Usage('bad option: %s' % o[:40])
        v = opts[j + 1]; j += 2
        if o == '--provider':
            if v not in ('daytona', 'nosana'): raise Usage('--provider must be daytona or nosana')
            out['provider'] = v
        elif o == '--image': out['image'] = v
        else:
            if not v.isdigit() or not 10 <= int(v) <= 600: raise Usage('--timeout must be 10..600 seconds')
            out['timeout'] = int(v)
    if not out['provider']: raise Usage('--provider is required')
    return out

def load():
    st = os.stat(CONFIG)
    if os.name == 'posix' and st.st_mode & (stat.S_IRWXG | stat.S_IRWXO): raise SystemExit('config %s must be private (chmod 600)' % CONFIG)
    with open(CONFIG) as f: c = json.load(f)
    u = urlparse(c['gateway'])
    if not (u.scheme == 'https' or (u.scheme == 'http' and u.hostname == '127.0.0.1')): raise SystemExit('config gateway must be https')
    return c

def call(c, method, sub, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(c['gateway'] + c['prefix'] + '/' + sub, data=data, method=method,
                                 headers={'authorization': 'Bearer ' + c['token'], 'content-type': 'application/json', 'user-agent': 'CloudBiteCompute/1.0'})
    try:
        with urllib.request.urlopen(req, timeout=60) as r: return json.loads(r.read() or b'{}')
    except urllib.error.HTTPError as e:
        try: j = json.loads(e.read())
        except Exception: j = {}
        err = j.get('error') if isinstance(j, dict) else None
        raise SystemExit('error %s: %s' % (err.get('code'), err.get('message')) if isinstance(err, dict) else 'error: HTTP %d' % e.code)
    except urllib.error.URLError:
        raise SystemExit('error: gateway unreachable (outcome unknown; check "jobs" before retrying)')

def show(j):
    print('%s  %-8s %-10s cleanup=%s  %s' % (j['id'], j['provider'], j['status'], j['cleanup'], ' '.join(j['command'])[:80]))

def main(argv):
    try: a = parse(argv)
    except Usage as e: print(e, file=sys.stderr); return 2
    c = load()
    if a['cmd'] == 'doctor':
        print('config: %s (private)' % CONFIG); print('gateway: %s' % c['gateway']); print('capability expires: %s' % c['expiresAt'])
        n = len(call(c, 'GET', 'jobs').get('jobs', [])); print('gateway: ok (%d jobs)' % n); return 0
    if a['cmd'] == 'jobs':
        for j in call(c, 'GET', 'jobs').get('jobs', []): show(j)
        return 0
    if a['cmd'] == 'stop':
        show(call(c, 'POST', 'stop', {'requestId': str(uuid.uuid4()), 'jobId': a['jobId']})['job']); return 0
    body = {'requestId': str(uuid.uuid4()), 'provider': a['provider'], 'timeout': a['timeout'], 'command': a['command']}
    if a['image']: body['image'] = a['image']
    if a['provider'] == 'nosana':
        print('notice: Nosana GPU job definitions (image and command) are public; output is not returned to Cloudbite.', file=sys.stderr)
    job = call(c, 'POST', 'run', body)['job']; show(job)
    if not a['wait']: return 0
    end = time.time() + a['timeout'] + 900
    while time.time() < end and job['status'] in ('creating', 'running', 'uncertain'):
        time.sleep(5)
        job = next((j for j in call(c, 'GET', 'jobs').get('jobs', []) if j['id'] == job['id']), job)
    show(job)
    if job.get('result'): sys.stdout.write(job['result']['output']); return job['result']['exitCode'] if job['status'] == 'succeeded' else 1
    if job['status'] == 'completed': print('provider reports completed; output unavailable', file=sys.stderr); return 0
    return 1

if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
`;
