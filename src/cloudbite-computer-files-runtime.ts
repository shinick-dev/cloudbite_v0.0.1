// Cloud Files runtime: one Durable Object per owner holds the core catalog (cloudbite-computer-files.ts) in its own
// SQLite storage; file bodies go to an optional native R2 binding. Without CLOUDBITE_FILES_BUCKET the catalog still
// works and every body operation answers store_not_configured — there is no fallback store and no simulated success.
// Two HTTP surfaces share the DO:
//   browser  /api/cloudbite/computer/files...            owner auth + Origin checked by computerRoute, then here
//   agent    /p/_cloudbite/computer/files/agent/v1/...   gateway host only, bearer capability bound to one
//                                                         owner + machine + writer epoch; owner cookies are ignored
// The DO class is built by filesObjectClass(DurableObject) in index.ts so this module stays importable outside workerd.
// Bodies stream Worker -> DO -> R2 (never buffered whole). Capability secrets exist in plaintext only in the grant
// return value handed to the private VM install step; at rest they are SHA-256 hashes. Contract: docs/cloudbite/files-runtime.md.

import type { DurableObject as DurableObjectBase } from 'cloudflare:workers';
import { FilesService, durableObjectCatalog, r2BlobStore } from './cloudbite-computer-files';
import { FilesError, type StorageStatusView, type VersionView } from './cloudbite-computer-files-contract';
import { computerOwnerTag, type ComputerMachineRef } from './cloudbite-computer-contract';
import type { Env } from './state';

export const FILES_UPLOAD_MAX_BYTES = 32 * 1024 ** 2;
export const FILES_QUOTA_BYTES = 2 * 1024 ** 3;
export const FILES_JSON_MAX = 8192;
export const FILES_AGENT_PATH = '/p/_cloudbite/computer/files/agent/v1';
export const FILES_AGENT_TTL_MS = 6 * 3600_000;

export type FilesEnv = Env & {
  CLOUDBITE_COMPUTER_FILES?: DurableObjectNamespace; // CloudbiteComputerFiles; stubs are typed as FilesRpc
  CLOUDBITE_FILES_BUCKET?: R2Bucket; // optional; absent = blobs not_configured
};

type Err = { code: string; message: string; retryable: boolean };
export type FilesFail = { error: Err; status: number };
export type FilesOk<T = unknown> = { ok: true; body: T };
export type FilesResult<T = unknown> = FilesOk<T> | FilesFail;
export type FilesRead = { ok: true; descriptor: VersionView; name: string; length: number; body: ReadableStream<Uint8Array> } | FilesFail;
export interface FilesAgentGrant { token: string; machineId: string; writerEpoch: number; workspaceId: string; expiresAt: number; endpoint: string }
type LiveMachine = { id: string; status: string } | null;
type Cap = { ownerId: string; machineId: string; writerEpoch: number; expiresAt: number };
type ReadReq = { fileId: unknown; versionId: unknown; offset?: number; length?: number };

const OPS = ['list', 'status', 'create', 'rename', 'pin', 'open', 'begin', 'getUpload', 'commit', 'abort', 'pending', 'localState'] as const;
export type FilesOp = typeof OPS[number];
const AGENT_OPS: ReadonlySet<FilesOp> = new Set(['list', 'status', 'create', 'open', 'begin', 'getUpload', 'commit', 'abort', 'pending', 'localState']);
const MUTATING: ReadonlySet<FilesOp> = new Set(['create', 'rename', 'pin', 'begin', 'commit', 'abort', 'localState']);
const TOKEN_RE = /^cbfa_[A-Za-z0-9_-]{43}$/, MACHINE_RE = /^[A-Za-z0-9_-]{1,64}$/, GRANT_REQ_RE = /^[A-Za-z0-9._:-]{1,96}$/;

const failOf = (code: string, status: number, retryable = false, message = code): FilesFail => ({ error: { code, message, retryable }, status });
function failFrom(e: unknown, mutating: boolean): FilesFail {
  if (e instanceof FilesError) return { error: e.toJSON().error, status: e.status };
  // Anything unexpected may have happened after a write started: report the retry-safe unknown, never success.
  return mutating ? failOf('commit_unknown', 503, true) : failOf('catalog_unavailable', 503, true);
}
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
const sha256 = async (s: string) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
function b64u(bytes: Uint8Array) { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
const emptyStream = () => new ReadableStream<Uint8Array>({ start(c) { c.close(); } });

export function filesService(storage: DurableObjectStorage | undefined, bucket: R2Bucket | undefined) {
  return new FilesService({ catalog: storage ? durableObjectCatalog(storage) : undefined, blobs: bucket ? r2BlobStore(bucket) : undefined,
    maxFileBytes: FILES_UPLOAD_MAX_BYTES, quotaBytes: FILES_QUOTA_BYTES });
}

// ---- Durable Object ----

export function filesObjectClass(Base: typeof DurableObjectBase) {
  return class CloudbiteComputerFiles extends Base<FilesEnv> {
    private readonly svc: FilesService;
    constructor(ctx: DurableObjectState, env: FilesEnv) {
      super(ctx, env);
      this.svc = filesService(ctx.storage, env.CLOUDBITE_FILES_BUCKET);
    }

    /** One owner per object: the first caller binds it, every other owner id is refused as not_found. */
    private async bind(ownerId: string): Promise<FilesFail | null> {
      if (typeof ownerId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(ownerId)) return failOf('invalid_request', 400);
      const cur = await this.ctx.storage.get<string>('meta/owner');
      if (cur === undefined) { await this.ctx.storage.put('meta/owner', ownerId); return null; }
      return cur === ownerId ? null : failOf('not_found', 404);
    }

    private async run(ownerId: string, op: FilesOp, input: Record<string, unknown>): Promise<FilesResult> {
      const s = this.svc, i = input as never;
      try {
        switch (op) {
          case 'list': return { ok: true, body: await s.list(ownerId, i) };
          case 'status': return { ok: true, body: await s.storageStatus(ownerId) };
          case 'create': return { ok: true, body: await s.create(ownerId, i) };
          case 'rename': return { ok: true, body: await s.rename(ownerId, i) };
          case 'pin': return { ok: true, body: await s.setPinned(ownerId, i) };
          case 'open': return { ok: true, body: await s.open(ownerId, i) };
          case 'begin': return { ok: true, body: await s.beginUpload(ownerId, i) };
          case 'getUpload': return { ok: true, body: await s.getUpload(ownerId, i) };
          case 'commit': return { ok: true, body: await s.commitUpload(ownerId, i) };
          case 'abort': return { ok: true, body: await s.abortUpload(ownerId, i) };
          case 'pending': return { ok: true, body: await s.listPendingUploads(ownerId, i) };
          case 'localState': return { ok: true, body: await s.recordLocalState(ownerId, i) };
        }
      } catch (e) { return failFrom(e, MUTATING.has(op)); }
      return failOf('not_found', 404);
    }

    private async body(ownerId: string, uploadId: unknown, declared: number, body: ReadableStream<Uint8Array> | null): Promise<FilesResult> {
      try {
        const { upload } = await this.svc.getUpload(ownerId, { uploadId: uploadId as string });
        // Fail before any byte moves when the declared length cannot be this upload.
        if (declared !== upload.size) { await body?.cancel().catch(() => {}); return failOf('size_mismatch', 422); }
        return { ok: true, body: await this.svc.writeUploadBody(ownerId, upload.uploadId, body ?? emptyStream()) };
      } catch (e) { await body?.cancel().catch(() => {}); return failFrom(e, true); }
    }

    private async read(ownerId: string, req: ReadReq): Promise<FilesRead> {
      try {
        const { descriptor } = await this.svc.open(ownerId, { fileId: req.fileId as string, versionId: req.versionId as string });
        if (descriptor.versionId !== req.versionId) return failOf('not_found', 404);
        const r = await this.svc.readVersion(ownerId, { fileId: descriptor.fileId, versionId: descriptor.versionId, offset: req.offset, length: req.length });
        const offset = req.offset ?? 0, length = req.length ?? r.descriptor.size - offset;
        return { ok: true, descriptor: r.descriptor, name: descriptor.name, length, body: r.body };
      } catch (e) { return failFrom(e, false); }
    }

    // browser surface (caller already proved owner auth + Origin)
    async filesCall(ownerId: string, op: FilesOp, input: Record<string, unknown>): Promise<FilesResult> {
      if (!OPS.includes(op)) return failOf('not_found', 404);
      return (await this.bind(ownerId)) ?? this.run(ownerId, op, input);
    }
    async filesWriteBody(ownerId: string, uploadId: string, declared: number, body: ReadableStream<Uint8Array> | null): Promise<FilesResult> {
      const b = await this.bind(ownerId); if (b) { await body?.cancel().catch(() => {}); return b; }
      return this.body(ownerId, uploadId, declared, body);
    }
    async filesRead(ownerId: string, req: ReadReq): Promise<FilesRead> {
      return (await this.bind(ownerId)) ?? this.read(ownerId, req);
    }

    /** Mints the machine capability. The caller has verified `machineId` is the owner's running, label-verified computer.
     *  An unclaimed workspace is given to this machine (epoch + 1); a different current writer is never displaced here. */
    async filesGrant(ownerId: string, machineId: string, requestId: string): Promise<FilesResult<Omit<FilesAgentGrant, 'endpoint'>>> {
      const b = await this.bind(ownerId); if (b) return b;
      if (typeof machineId !== 'string' || !MACHINE_RE.test(machineId) || typeof requestId !== 'string' || !GRANT_REQ_RE.test(requestId))
        return failOf('invalid_request', 400);
      try {
        const { status } = await this.svc.storageStatus(ownerId);
        let writerEpoch = status.writerEpoch;
        if (status.writerMachine === null)
          writerEpoch = (await this.svc.advanceWriter(ownerId, { requestId: `grant:${requestId}`, expectedEpoch: writerEpoch, machineId })).writerEpoch;
        else if (status.writerMachine !== machineId) return failOf('writer_conflict', 409);
        const token = 'cbfa_' + b64u(crypto.getRandomValues(new Uint8Array(32)));
        const expiresAt = Date.now() + FILES_AGENT_TTL_MS;
        const old = await this.ctx.storage.list({ prefix: 'cap/' });
        const cap: Cap = { ownerId, machineId, writerEpoch, expiresAt };
        await this.ctx.storage.transaction(async txn => {
          if (old.size) await txn.delete([...old.keys()]);
          await txn.put(`cap/${await sha256(token)}`, cap);
        });
        return { ok: true, body: { token, machineId, writerEpoch, workspaceId: ownerId, expiresAt } };
      } catch (e) { return failFrom(e, true); }
    }

    /** Revokes every machine capability of this owner (e.g. the machine was replaced or stopped for good). */
    async filesRevokeAgents(ownerId: string): Promise<FilesResult<{ revoked: number }>> {
      const b = await this.bind(ownerId); if (b) return b;
      const old = await this.ctx.storage.list({ prefix: 'cap/' });
      if (old.size) await this.ctx.storage.delete([...old.keys()]);
      return { ok: true, body: { revoked: old.size } };
    }

    private async agent(token: unknown, live: LiveMachine): Promise<{ cap: Cap } | FilesFail> {
      if (typeof token !== 'string' || !TOKEN_RE.test(token)) return failOf('capability_invalid', 401);
      const cap = await this.ctx.storage.get<Cap>(`cap/${await sha256(token)}`);
      if (!cap || (await this.ctx.storage.get<string>('meta/owner')) !== cap.ownerId) return failOf('capability_invalid', 401);
      if (Date.now() >= cap.expiresAt) return failOf('capability_expired', 401);
      if (!live || live.id !== cap.machineId || live.status !== 'running') return failOf('not_running', 409);
      try {
        const { status } = await this.svc.storageStatus(cap.ownerId);
        if (status.writerEpoch !== cap.writerEpoch || status.writerMachine !== cap.machineId) return failOf('stale_writer', 409);
      } catch (e) { return failFrom(e, false); }
      return { cap };
    }

    // agent surface: identity comes only from the capability, never from the request
    async filesAgentCall(token: string, live: LiveMachine, op: FilesOp, input: Record<string, unknown>): Promise<FilesResult> {
      const a = await this.agent(token, live); if (!('cap' in a)) return a;
      if (!AGENT_OPS.has(op)) return failOf('not_found', 404);
      const { cap } = a;
      if (op === 'begin' && input.writerEpoch !== cap.writerEpoch) return failOf('stale_writer', 409);
      if (op === 'localState' && (input.writerEpoch !== cap.writerEpoch || input.machineId !== cap.machineId)) return failOf('stale_writer', 409);
      const r = await this.run(cap.ownerId, op, input);
      if (op === 'status' && 'ok' in r)
        return { ok: true, body: { ...(r.body as { status: StorageStatusView }), agent: { machineId: cap.machineId, writerEpoch: cap.writerEpoch, expiresAt: cap.expiresAt } } };
      return r;
    }
    async filesAgentWriteBody(token: string, live: LiveMachine, uploadId: string, declared: number, body: ReadableStream<Uint8Array> | null): Promise<FilesResult> {
      const a = await this.agent(token, live); if (!('cap' in a)) { await body?.cancel().catch(() => {}); return a; }
      return this.body(a.cap.ownerId, uploadId, declared, body);
    }
    async filesAgentRead(token: string, live: LiveMachine, req: ReadReq): Promise<FilesRead> {
      const a = await this.agent(token, live); if (!('cap' in a)) return a;
      return this.read(a.cap.ownerId, req);
    }
  };
}
export type CloudbiteComputerFiles = InstanceType<ReturnType<typeof filesObjectClass>>;

// ---- Worker-side HTTP ----

interface FilesRpc {
  filesCall(ownerId: string, op: FilesOp, input: Record<string, unknown>): Promise<FilesResult>;
  filesWriteBody(ownerId: string, uploadId: string, declared: number, body: ReadableStream<Uint8Array> | null): Promise<FilesResult>;
  filesRead(ownerId: string, req: ReadReq): Promise<FilesRead>;
  filesGrant(ownerId: string, machineId: string, requestId: string): Promise<FilesResult<Omit<FilesAgentGrant, 'endpoint'>>>;
  filesAgentCall(token: string, live: LiveMachine, op: FilesOp, input: Record<string, unknown>): Promise<FilesResult>;
  filesAgentWriteBody(token: string, live: LiveMachine, uploadId: string, declared: number, body: ReadableStream<Uint8Array> | null): Promise<FilesResult>;
  filesAgentRead(token: string, live: LiveMachine, req: ReadReq): Promise<FilesRead>;
}
const stubOf = (env: FilesEnv, tag: string) => {
  const ns = env.CLOUDBITE_COMPUTER_FILES;
  return ns ? ns.get(ns.idFromName(tag)) as unknown as FilesRpc : null;
};

const H = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...H, 'content-type': 'application/json' } });
const send = (r: FilesFail | FilesOk) => ('ok' in r ? json(r.body) : json({ error: r.error }, r.status));
const sendFail = (code: string, status: number, retryable = false) => json({ error: { code, message: code, retryable } }, status);

async function readJson(req: Request): Promise<Record<string, unknown> | null> {
  if (!req.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return null;
  if (Number(req.headers.get('content-length') ?? 0) > FILES_JSON_MAX || !req.body) return null;
  const reader = req.body.getReader(); let n = 0; const parts: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read(); if (done) break;
    n += value.byteLength; if (n > FILES_JSON_MAX) { await reader.cancel(); return null; }
    parts.push(value);
  }
  const bytes = new Uint8Array(n); let at = 0; for (const p of parts) { bytes.set(p, at); at += p.byteLength; }
  try { const v = JSON.parse(new TextDecoder().decode(bytes)); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch { return null; }
}

/** Declared body length: required, decimal, within the per-file cap. */
function declaredLength(req: Request): number | Response {
  const raw = req.headers.get('content-length');
  if (raw === null) return sendFail('length_required', 411);
  if (!/^\d{1,12}$/.test(raw)) return sendFail('invalid_request', 400);
  const n = Number(raw);
  return n > FILES_UPLOAD_MAX_BYTES ? sendFail('too_large', 413) : n;
}

/** Query integers are passed through as numbers only when they are plain decimals; anything else fails core validation. */
const qInt = (v: string | null) => (v === null ? undefined : /^\d{1,16}$/.test(v) ? Number(v) : NaN);

function disposition(name: string) {
  const ascii = name.replace(/[^A-Za-z0-9._ -]/g, '_').slice(0, 150) || 'download';
  const star = encodeURIComponent(name).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="${ascii}"; filename*=UTF-8''${star}`;
}

function streamed(r: Extract<FilesRead, { ok: true }>) {
  const body = typeof FixedLengthStream === 'function' ? r.body.pipeThrough(new FixedLengthStream(r.length)) : r.body;
  return new Response(body, { headers: { ...H, 'content-type': 'application/octet-stream', 'content-length': String(r.length),
    'content-disposition': disposition(r.name), 'content-security-policy': "default-src 'none'; sandbox",
    'x-cloudbite-sha256': r.descriptor.sha256, 'x-cloudbite-version': r.descriptor.versionId } });
}

/** Honest status when the files DO is not bound at all: nothing is configured. */
async function unconfiguredStatus(tag: string) { return json(await filesService(undefined, undefined).storageStatus(tag)); }

const UPLOAD_OP = /^files\/uploads\/(u_[a-z2-7]{26})(\/body|\/commit|\/abort)?$/;
const CONTENT_OP = /^files\/content\/(f_[a-z2-7]{26})$/;

/** Browser routes. computerRoute has already authenticated the owner; `admin` = request used x-admin-token. */
export async function filesBrowserRoute(req: Request, env: FilesEnv, url: URL, op: string, tag: string, admin: boolean): Promise<Response | null> {
  if (op !== 'files' && !op.startsWith('files/')) return null;
  if (req.headers.get('sec-fetch-site') === 'cross-site') return sendFail('bad_origin', 403);
  const m = req.method;
  if (m !== 'GET' && m !== 'HEAD') {
    const origin = req.headers.get('origin');
    if ((origin === null && !admin) || (origin !== null && origin !== env.ORIGIN)) return sendFail('bad_origin', 403);
  }
  const stub = stubOf(env, tag);
  if (m === 'GET' && op === 'files/status') return stub ? call(stub.filesCall(tag, 'status', {}), false) : unconfiguredStatus(tag);
  if (!stub) return sendFail('store_not_configured', 503);
  if (op === 'files') {
    if (m !== 'GET') return sendFail('method_not_allowed', 405);
    const q = url.searchParams;
    return call(stub.filesCall(tag, 'list', { parentId: q.get('parentId') ?? 'root', cursor: q.get('cursor'), limit: qInt(q.get('limit')) }), false);
  }
  const content = CONTENT_OP.exec(op);
  if (content) {
    if (m !== 'GET') return sendFail('method_not_allowed', 405);
    const versionId = url.searchParams.get('versionId');
    if (!versionId) return sendFail('invalid_request', 400);
    return readCall(stub.filesRead(tag, { fileId: content[1], versionId }));
  }
  const up = UPLOAD_OP.exec(op);
  if (up && up[2] === '/body') {
    if (m !== 'PUT') return sendFail('method_not_allowed', 405);
    const n = declaredLength(req); if (n instanceof Response) return n;
    return call(stub.filesWriteBody(tag, up[1], n, req.body), true);
  }
  if (up && !up[2]) return m === 'GET' ? call(stub.filesCall(tag, 'getUpload', { uploadId: up[1] }), false) : sendFail('method_not_allowed', 405);
  if (m !== 'POST') return sendFail('method_not_allowed', 405);
  const input = await readJson(req); if (!input) return sendFail('invalid_request', 400);
  if (up) {
    if (input.uploadId !== undefined && input.uploadId !== up[1]) return sendFail('invalid_request', 400);
    return call(stub.filesCall(tag, up[2] === '/commit' ? 'commit' : 'abort', { uploadId: up[1] }), true);
  }
  const named: Record<string, FilesOp> = { 'files/create': 'create', 'files/rename': 'rename', 'files/pin': 'pin', 'files/open': 'open', 'files/uploads/begin': 'begin' };
  const fop = named[op];
  return fop ? call(stub.filesCall(tag, fop, input), fop !== 'open') : sendFail('not_found', 404);
}

async function call(p: Promise<FilesResult>, mutating: boolean): Promise<Response> {
  try { return send(await p); } catch { return mutating ? sendFail('commit_unknown', 503, true) : sendFail('catalog_unavailable', 503, true); }
}
async function readCall(p: Promise<FilesRead>): Promise<Response> {
  try { const r = await p; return 'ok' in r ? streamed(r) : send(r); } catch { return sendFail('blob_unavailable', 503, true); }
}

interface MachineRpc { computerMachine(tag: string): Promise<{ ok: true; machine: ComputerMachineRef } | { error: unknown; status: number }> }

/** Agent routes on the gateway host. No cookie or owner credential is consulted; only the bearer capability. */
export async function filesAgentRoute(req: Request, env: FilesEnv, url: URL): Promise<Response | null> {
  const p = url.pathname;
  if (p !== FILES_AGENT_PATH && !p.startsWith(FILES_AGENT_PATH + '/')) return null;
  if (!env.CLOUDBITE_GATEWAY_URL || url.origin !== env.CLOUDBITE_GATEWAY_URL || !env.CLOUDBITE_COMPUTER_FILES || !env.CLOUDBITE_COMPUTER) return sendFail('not_found', 404);
  if (req.headers.get('origin') !== null) return sendFail('bad_origin', 403);
  const auth = req.headers.get('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!TOKEN_RE.test(token)) return sendFail('capability_invalid', 401);
  const tag = await computerOwnerTag(), stub = stubOf(env, tag)!;
  let live: LiveMachine = null;
  try {
    const cur = await (env.CLOUDBITE_COMPUTER.get(env.CLOUDBITE_COMPUTER.idFromName('owner')) as unknown as MachineRpc).computerMachine(tag);
    if ('ok' in cur) live = { id: cur.machine.id, status: cur.machine.status };
  } catch { return sendFail('catalog_unavailable', 503, true); }
  const op = p.slice(FILES_AGENT_PATH.length + 1), m = req.method, q = url.searchParams;
  if (m === 'GET' && op === 'status') return call(stub.filesAgentCall(token, live, 'status', {}), false);
  if (m === 'GET' && op === 'list') return call(stub.filesAgentCall(token, live, 'list', { parentId: q.get('parentId') ?? 'root', cursor: q.get('cursor'), limit: qInt(q.get('limit')) }), false);
  if (m === 'GET' && op === 'uploads') return call(stub.filesAgentCall(token, live, 'pending', { cursor: q.get('cursor'), limit: qInt(q.get('limit')) }), false);
  const content = /^content\/(f_[a-z2-7]{26})$/.exec(op);
  if (content) {
    if (m !== 'GET') return sendFail('method_not_allowed', 405);
    const versionId = q.get('versionId'); if (!versionId) return sendFail('invalid_request', 400);
    return readCall(stub.filesAgentRead(token, live, { fileId: content[1], versionId, offset: qInt(q.get('offset')), length: qInt(q.get('length')) }));
  }
  const up = /^uploads\/(u_[a-z2-7]{26})(\/body|\/commit|\/abort)?$/.exec(op);
  if (up && up[2] === '/body') {
    if (m !== 'PUT') return sendFail('method_not_allowed', 405);
    const n = declaredLength(req); if (n instanceof Response) return n;
    return call(stub.filesAgentWriteBody(token, live, up[1], n, req.body), true);
  }
  if (up && !up[2]) return m === 'GET' ? call(stub.filesAgentCall(token, live, 'getUpload', { uploadId: up[1] }), false) : sendFail('method_not_allowed', 405);
  if (m !== 'POST') return sendFail('method_not_allowed', 405);
  const input = await readJson(req); if (!input) return sendFail('invalid_request', 400);
  if (up) {
    if (input.uploadId !== undefined && input.uploadId !== up[1]) return sendFail('invalid_request', 400);
    return call(stub.filesAgentCall(token, live, up[2] === '/commit' ? 'commit' : 'abort', { uploadId: up[1] }), true);
  }
  const named: Record<string, FilesOp> = { create: 'create', open: 'open', 'uploads/begin': 'begin', 'local-state': 'localState' };
  const fop = named[op];
  return fop ? call(stub.filesAgentCall(token, live, fop, input), fop !== 'open') : sendFail('not_found', 404);
}

/** For the root-auth configure route: mint the machine capability after the caller verified `machine` is the owner's
 *  running, label-verified computer. The token must go only to the private VM install step. */
export async function filesAgentGrant(env: FilesEnv, ownerTag: string, machine: ComputerMachineRef, requestId: string): Promise<FilesResult<FilesAgentGrant>> {
  const stub = stubOf(env, ownerTag);
  if (!stub || !env.CLOUDBITE_GATEWAY_URL) return failOf('store_not_configured', 503);
  if (machine.status !== 'running') return failOf('not_running', 409);
  let r: FilesResult<Omit<FilesAgentGrant, 'endpoint'>>;
  try { r = await stub.filesGrant(ownerTag, machine.id, requestId); } catch { return failOf('commit_unknown', 503, true); }
  return 'ok' in r ? { ok: true, body: { ...r.body, endpoint: env.CLOUDBITE_GATEWAY_URL + FILES_AGENT_PATH } } : r;
}

