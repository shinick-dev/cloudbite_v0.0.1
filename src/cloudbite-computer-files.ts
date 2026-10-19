// Cloud Files domain service: owner-scoped metadata catalog + immutable per-file versions + verified canonical commit.
// Storage is injected: CatalogStore (granular keys, one atomic conditional batch per mutation; a Durable Object fits)
// and BlobStore (streamed bodies, provider observation). Listing never touches BlobStore. A commit is only reported
// after the provider says the object is durable AND its size and SHA-256 match (provider-verified checksum, or a
// bounded streaming re-read). A stale base never overwrites: the content is kept as a conflict sibling instead.
// Contract and error codes: cloudbite-computer-files-contract.ts, docs/cloudbite/files-core-contract.md.

import {
  FILES_LIMITS as L, FilesError, ROOT_ID,
  type AdvanceWriterRequest, type AdvanceWriterResponse, type BeginUploadRequest, type CommitRequest, type CommitResponse,
  type CommitResult, type CreateRequest, type EntryResponse, type FileEntryView, type FileKind, type ListRequest,
  type ListResponse, type ListVersionsRequest, type ListVersionsResponse, type LocalCopyView, type LocalStateRequest,
  type LocalStateResponse, type ManifestDir, type OpenRequest, type OpenResponse, type RenameRequest,
  type ResolveManifestRequest, type ResolveManifestResponse, type SetPinnedRequest,
  type StorageStatusView, type UploadResponse, type UploadView, type VersionView,
} from './cloudbite-computer-files-contract';

// ---- injected stores ----

/** JSON-safe record; `rev` is the storage revision used for conditional writes (0 = absent). */
export type CatalogRecord = { rev: number } & Record<string, unknown>;
export interface CatalogBatch { expect: Array<[string, number]>; put: Array<[string, CatalogRecord]>; del: string[] }
export interface CatalogStore {
  get(key: string): Promise<CatalogRecord | undefined>;
  getMany(keys: string[]): Promise<Map<string, CatalogRecord>>;
  /** Ascending key order, keys strictly after `startAfter`, at most `limit` (<= 201). */
  list(prefix: string, opts: { startAfter?: string; limit: number }): Promise<Array<[string, CatalogRecord]>>;
  /** Atomic: when every expected rev matches, apply all puts/deletes and resolve true; otherwise change nothing, false.
   *  A rejection means the outcome is unknown. */
  write(batch: CatalogBatch): Promise<boolean>;
}

/** What the provider itself reports. `sha256` only when the provider computed/verified it from received bytes
 *  (never an ETag). `durable` only when the provider acknowledges persistence, not a local buffer/cache write. */
export interface BlobObservation { size: number; sha256: string | null; durable: boolean }
export interface BlobStore {
  readonly kind: string;
  put(key: string, body: ReadableStream<Uint8Array>, expect: { size: number; sha256: string }): Promise<void>;
  head(key: string): Promise<BlobObservation | null>;
  get(key: string, range?: { offset: number; length: number }): Promise<ReadableStream<Uint8Array> | null>;
}

export interface Sha256Stream { write(chunk: Uint8Array): void | Promise<void>; digest(): Promise<string> }
export type Sha256Factory = () => Sha256Stream;

export interface FilesServiceOptions {
  catalog?: CatalogStore;
  blobs?: BlobStore;
  sha256?: Sha256Factory;
  now?: () => number;
  randomId?: () => string; // 26 chars of [a-z2-7]
  quotaBytes?: number;
  maxFileBytes?: number;
}

// ---- records ----

type Ws = CatalogRecord & { writerEpoch: number; writerMachine: string | null; usedBytes: number; reservedBytes: number;
  pendingUploads: number; dirtyFiles: number; pinnedFiles: number };
type Entry = CatalogRecord & { fileId: string; parentId: string; name: string; fold: string; kind: FileKind; size: number;
  mtime: number; currentVersion: string | null; versionSeq: number; pinned: boolean };
type Counter = CatalogRecord & { children: number };
type Ver = CatalogRecord & Omit<VersionView, never> & { objectKey: string; uploadId: string };
type Upload = CatalogRecord & Omit<UploadView, never> & { objectKey: string; requestId: string };
type Req = CatalogRecord & { op: string; args: string; result: unknown };
type Local = CatalogRecord & LocalCopyView;

const OWNER_RE = /^[A-Za-z0-9_-]{1,128}$/, MACHINE_RE = /^[A-Za-z0-9_-]{1,64}$/, REQ_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const FILE_RE = /^f_[a-z2-7]{26}$/, UPLOAD_RE = /^u_[a-z2-7]{26}$/, VER_RE = /^v_(\d{13})_[a-z2-7]{26}$/, HEX_RE = /^[0-9a-f]{64}$/;
const SEQ_TOP = 9_999_999_999_999, ATTEMPTS = 5;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

const bad = (msg: string) => new FilesError('invalid_request', msg);
const utf8 = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');

function str(v: unknown, re: RegExp, field: string): string {
  if (typeof v !== 'string' || !re.test(v)) throw bad(`${field} is invalid`);
  return v;
}
function int(v: unknown, field: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > max) throw bad(`${field} is invalid`);
  return v;
}
const fileIdOf = (v: unknown, field = 'fileId') => (v === ROOT_ID ? ROOT_ID : str(v, FILE_RE, field));

/** NFC name + collision key (NFC of lower-cased NFC). Applied identically on create, rename and conflict copies. */
export function normalizeName(raw: unknown): { name: string; fold: string } {
  if (typeof raw !== 'string' || raw.length > 1024 || LONE_SURROGATE.test(raw)) throw new FilesError('invalid_name');
  const name = raw.normalize('NFC');
  if (name === '' || name === '.' || name === '..' || /[\u0000-\u001f\u007f/\\]/.test(name) || /[. ]$/.test(name)
    || utf8.encode(name).byteLength > L.nameBytesMax) throw new FilesError('invalid_name');
  return { name, fold: name.toLowerCase().normalize('NFC') };
}

function b64u(s: string): string {
  let bin = ''; for (const b of utf8.encode(s)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64u(s: string): string {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
}
function encodeCursor(scope: string, after: string) { return b64u(JSON.stringify({ s: scope, a: after })); }
function decodeCursor(cursor: unknown, scope: string): string | undefined {
  if (cursor === undefined || cursor === null) return undefined;
  if (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > L.cursorMax || !/^[A-Za-z0-9_-]+$/.test(cursor))
    throw new FilesError('invalid_cursor');
  try {
    const c = JSON.parse(unb64u(cursor));
    if (c && c.s === scope && typeof c.a === 'string' && c.a.length > 0 && !c.a.includes('/')) return c.a;
  } catch { /* fallthrough */ }
  throw new FilesError('invalid_cursor');
}

function defaultRandomId(): string {
  let out = '';
  for (const b of crypto.getRandomValues(new Uint8Array(26))) out += 'abcdefghijklmnopqrstuvwxyz234567'[b & 31];
  return out;
}

/** Workers DigestStream; other runtimes inject `sha256`. */
export function platformSha256(): Sha256Factory | undefined {
  const D = (crypto as unknown as { DigestStream?: typeof DigestStream }).DigestStream;
  if (!D) return undefined;
  return () => {
    const ds = new D('SHA-256'), w = ds.getWriter();
    return { write: chunk => w.write(chunk), digest: async () => { await w.close(); return hex(await ds.digest); } };
  };
}

// ---- service ----

export class FilesService {
  private readonly catalog?: CatalogStore;
  private readonly blobs?: BlobStore;
  private readonly sha?: Sha256Factory;
  private readonly now: () => number;
  private readonly rid: () => string;
  readonly quotaBytes: number;
  readonly maxFileBytes: number;

  constructor(o: FilesServiceOptions = {}) {
    this.catalog = o.catalog; this.blobs = o.blobs; this.sha = o.sha256 ?? platformSha256();
    this.now = o.now ?? Date.now; this.rid = o.randomId ?? defaultRandomId;
    this.maxFileBytes = Math.min(o.maxFileBytes ?? L.fileBytesDefault, L.fileBytesHardMax);
    this.quotaBytes = o.quotaBytes ?? this.maxFileBytes * 10;
  }

  // keys: every key carries the validated owner, so an id from another owner simply does not resolve
  private k(o: string, ...parts: string[]) { return `fs/${o}/${parts.join('/')}`; }
  private vKey(o: string, fileId: string, versionId: string) {
    const m = VER_RE.exec(versionId); if (!m) throw new FilesError('not_found', 'version not found');
    return this.k(o, 'v', fileId, m[1]);
  }

  private cat(): CatalogStore { if (!this.catalog) throw new FilesError('store_not_configured', 'catalog store not configured'); return this.catalog; }
  private blob(): BlobStore { if (!this.blobs) throw new FilesError('store_not_configured', 'blob store not configured'); return this.blobs; }
  private hasher(): Sha256Stream { if (!this.sha) throw new FilesError('store_not_configured', 'sha256 unavailable'); return this.sha(); }
  private owner(o: unknown) { return str(o, OWNER_RE, 'ownerId'); }

  private async read<T>(p: Promise<T>): Promise<T> {
    try { return await p; } catch { throw new FilesError('catalog_unavailable'); }
  }
  private async get<T extends CatalogRecord>(key: string): Promise<T | undefined> { return (await this.read(this.cat().get(key))) as T | undefined; }

  /** Optimistic transaction: `plan` re-reads state each attempt and returns a batch + result, or a final value. */
  private async tx<T>(plan: () => Promise<{ done: T } | { batch: CatalogBatch; result: T }>): Promise<T> {
    for (let i = 0; i < ATTEMPTS; i++) {
      const p = await plan();
      if ('done' in p) return p.done;
      let ok: boolean;
      try { ok = await this.cat().write(p.batch); } catch {
        throw new FilesError('commit_unknown', 'catalog write outcome unknown; retry with the same requestId/uploadId');
      }
      if (ok) return p.result;
    }
    throw new FilesError('catalog_busy');
  }

  /** Idempotency: same requestId + same args returns the persisted result; different args is a conflict. */
  private async replay(o: string, requestId: string, op: string, args: string): Promise<{ hit: true; result: unknown } | { hit: false; key: string }> {
    const key = this.k(o, 'r', requestId), r = await this.get<Req>(key);
    if (!r) return { hit: false, key };
    if (r.op !== op || r.args !== args) throw new FilesError('request_conflict');
    return { hit: true, result: r.result };
  }

  private async ws(o: string): Promise<Ws> {
    const key = this.k(o, 'ws'), cur = await this.get<Ws>(key);
    if (cur) return cur;
    const ws: Ws = { rev: 1, writerEpoch: 1, writerMachine: null, usedBytes: 0, reservedBytes: 0, pendingUploads: 0, dirtyFiles: 0, pinnedFiles: 0 };
    const root: Entry = { rev: 1, fileId: ROOT_ID, parentId: ROOT_ID, name: '', fold: '', kind: 'dir', size: 0, mtime: this.now(),
      currentVersion: null, versionSeq: 0, pinned: false };
    let ok = false;
    try {
      ok = await this.cat().write({ expect: [[key, 0], [this.k(o, 'e', ROOT_ID), 0]],
        put: [[key, ws], [this.k(o, 'e', ROOT_ID), root], [this.k(o, 'n', ROOT_ID), { rev: 1, children: 0 }]], del: [] });
    } catch { throw new FilesError('catalog_unavailable'); }
    if (ok) return ws;
    const again = await this.get<Ws>(key);
    if (!again) throw new FilesError('catalog_busy');
    return again;
  }

  private async entry(o: string, fileId: string): Promise<Entry> {
    if (fileId === ROOT_ID) await this.ws(o);
    const e = await this.get<Entry>(this.k(o, 'e', fileId));
    if (!e) throw new FilesError('not_found');
    return e;
  }
  private async dir(o: string, fileId: string): Promise<Entry> {
    const e = await this.entry(o, fileId);
    if (e.kind !== 'dir') throw new FilesError('not_a_directory');
    return e;
  }
  /** `dirId` and its ancestors below root, nearest first (length = depth of dirId; root = []). `avoid` on the chain
   *  is a move into its own subtree. Callers put every chain rev into their batch expectations: a concurrent move of
   *  any ancestor then fails the write, so depth and acyclicity are checked against the state actually written. */
  private async ancestry(o: string, dirId: string, avoid?: string): Promise<Entry[]> {
    const chain: Entry[] = [];
    for (let id = dirId; id !== ROOT_ID;) {
      if (id === avoid) throw new FilesError('invalid_move');
      if (chain.length >= L.depthMax) throw new FilesError('depth_exceeded');
      const e = await this.entry(o, id);
      chain.push(e); id = e.parentId;
    }
    return chain;
  }
  private revs(o: string, chain: Entry[]): Array<[string, number]> { return chain.map(e => [this.k(o, 'e', e.fileId), e.rev]); }

  /** Proves the subtree under `dirId` is at most `budget` levels tall by a bounded breadth-first scan. Returns the
   *  child-counter revs of every scanned directory: any create/move into the subtree bumps one, failing the batch. */
  private async subtreeFits(o: string, dirId: string, budget: number): Promise<Array<[string, number]>> {
    const expect: Array<[string, number]> = [];
    let level = [dirId], height = 0, scanned = 0;
    while (level.length) {
      const next: string[] = [];
      for (const d of level) {
        expect.push([this.k(o, 'n', d), (await this.counter(o, d)).rev]);
        const prefix = this.k(o, 'c', d) + '/';
        for (let after: string | undefined; ;) {
          const rows = await this.read(this.cat().list(prefix, { startAfter: after, limit: L.listPageMax }));
          if ((scanned += rows.length) > L.moveScanMax) throw new FilesError('invalid_move', 'directory too large to move deeper');
          if (rows.length) {
            if (height + 1 > budget) throw new FilesError('depth_exceeded');
            const got = await this.read(this.cat().getMany(rows.map(([, r]) => this.k(o, 'e', String(r.fileId)))));
            for (const e of got.values()) if ((e as Entry).kind === 'dir') next.push((e as Entry).fileId);
          }
          if (rows.length < L.listPageMax) break;
          after = rows[rows.length - 1]![0];
        }
      }
      level = next; height++;
    }
    return expect;
  }
  private async counter(o: string, dirId: string): Promise<Counter> {
    return (await this.get<Counter>(this.k(o, 'n', dirId))) ?? { rev: 0, children: 0 };
  }

  private view(e: Entry, local: Local | undefined): FileEntryView {
    const state = !local ? 'remote' : local.dirty ? 'dirty' : local.versionId && local.versionId === e.currentVersion ? 'local' : 'remote';
    return { fileId: e.fileId, parentId: e.parentId, name: e.name, kind: e.kind, size: e.size, mtime: e.mtime,
      currentVersion: e.currentVersion, versionSeq: e.versionSeq, pinned: e.pinned, state, rev: e.rev };
  }
  private async viewOne(o: string, e: Entry): Promise<FileEntryView> {
    const ws = await this.ws(o);
    return this.view(e, ws.writerMachine ? await this.get<Local>(this.k(o, 'l', ws.writerMachine, e.fileId)) : undefined);
  }
  private uploadView(u: Upload): UploadView {
    return { uploadId: u.uploadId, fileId: u.fileId, baseVersion: u.baseVersion, writerEpoch: u.writerEpoch, size: u.size,
      sha256: u.sha256, phase: u.phase, createdAt: u.createdAt, expiresAt: u.expiresAt, result: u.result };
  }
  private versionView(v: Ver): VersionView {
    return { fileId: v.fileId, versionId: v.versionId, versionSeq: v.versionSeq, size: v.size, sha256: v.sha256,
      committedAt: v.committedAt, writerEpoch: v.writerEpoch, baseVersion: v.baseVersion };
  }

  // ---- catalog (metadata only; BlobStore is never consulted) ----

  async list(ownerId: string, req: ListRequest): Promise<ListResponse> {
    const o = this.owner(ownerId), parentId = fileIdOf(req?.parentId, 'parentId');
    const limit = req.limit === undefined ? L.listPageDefault : int(req.limit, 'limit', 1, L.listPageMax);
    const after = decodeCursor(req.cursor, parentId);
    await this.dir(o, parentId);
    const prefix = this.k(o, 'c', parentId) + '/';
    const rows = await this.read(this.cat().list(prefix, { startAfter: after === undefined ? undefined : prefix + after, limit: limit + 1 }));
    const page = rows.slice(0, limit), ids = page.map(([, r]) => String(r.fileId));
    const ws = await this.ws(o);
    const keys = ids.map(id => this.k(o, 'e', id)).concat(ws.writerMachine ? ids.map(id => this.k(o, 'l', ws.writerMachine!, id)) : []);
    const got = keys.length ? await this.read(this.cat().getMany(keys)) : new Map<string, CatalogRecord>();
    const entries: FileEntryView[] = [];
    for (const id of ids) {
      const e = got.get(this.k(o, 'e', id)) as Entry | undefined;
      if (e) entries.push(this.view(e, ws.writerMachine ? got.get(this.k(o, 'l', ws.writerMachine, id)) as Local | undefined : undefined));
    }
    const last = page[page.length - 1];
    return { parentId, entries, nextCursor: rows.length > limit && last ? encodeCursor(parentId, last[0].slice(prefix.length)) : null };
  }

  async create(ownerId: string, req: CreateRequest): Promise<EntryResponse> {
    const o = this.owner(ownerId), requestId = str(req?.requestId, REQ_RE, 'requestId'), parentId = fileIdOf(req.parentId, 'parentId');
    if (req.kind !== 'file' && req.kind !== 'dir') throw new FilesError('unsupported_kind');
    const { name, fold } = normalizeName(req.name), kind: FileKind = req.kind;
    const args = JSON.stringify([parentId, name, kind]);
    const fileId = 'f_' + this.rid();
    return this.tx<EntryResponse>(async () => {
      const rp = await this.replay(o, requestId, 'create', args);
      if (rp.hit) return { done: rp.result as EntryResponse };
      const parent = await this.dir(o, parentId), chain = await this.ancestry(o, parentId);
      if (chain.length + 1 > L.depthMax) throw new FilesError('depth_exceeded');
      const idxKey = this.k(o, 'c', parentId, fold);
      if (await this.get(idxKey)) throw new FilesError('name_conflict');
      const n = await this.counter(o, parentId);
      if (n.children >= L.childrenMax) throw new FilesError('too_many_children');
      const e: Entry = { rev: 1, fileId, parentId, name, fold, kind, size: 0, mtime: this.now(), currentVersion: null, versionSeq: 0, pinned: false };
      const result: EntryResponse = { entry: this.view(e, undefined) };
      return { result, batch: {
        expect: [[rp.key, 0], [idxKey, 0], [this.k(o, 'e', fileId), 0], [this.k(o, 'e', parentId), parent.rev], [this.k(o, 'n', parentId), n.rev],
          ...this.revs(o, chain)],
        put: [[this.k(o, 'e', fileId), e], [idxKey, { rev: 1, fileId }], [this.k(o, 'n', parentId), { rev: n.rev + 1, children: n.children + 1 }],
          ...(kind === 'dir' ? [[this.k(o, 'n', fileId), { rev: 1, children: 0 }] as [string, CatalogRecord]] : []),
          [rp.key, { rev: 1, op: 'create', args, result }]],
        del: [] } };
    });
  }

  async rename(ownerId: string, req: RenameRequest): Promise<EntryResponse> {
    const o = this.owner(ownerId), requestId = str(req?.requestId, REQ_RE, 'requestId'), fileId = fileIdOf(req.fileId);
    if (fileId === ROOT_ID) throw new FilesError('invalid_move');
    const expectedRev = int(req.expectedRev, 'expectedRev', 1);
    const nn = req.name === undefined ? null : normalizeName(req.name);
    const np = req.parentId === undefined ? null : fileIdOf(req.parentId, 'parentId');
    const args = JSON.stringify([fileId, expectedRev, nn?.name ?? null, np]);
    return this.tx<EntryResponse>(async () => {
      const rp = await this.replay(o, requestId, 'rename', args);
      if (rp.hit) return { done: rp.result as EntryResponse };
      const e = await this.entry(o, fileId);
      if (e.rev !== expectedRev) throw new FilesError('stale_revision');
      const name = nn?.name ?? e.name, fold = nn?.fold ?? e.fold, parentId = np ?? e.parentId;
      const parent = await this.dir(o, parentId);
      const oldIdx = this.k(o, 'c', e.parentId, e.fold), newIdx = this.k(o, 'c', parentId, fold);
      const moved = oldIdx !== newIdx;
      const expect: Array<[string, number]> = [[rp.key, 0], [this.k(o, 'e', fileId), e.rev], [this.k(o, 'e', parentId), parent.rev]];
      if (parentId !== e.parentId) {
        // both chains are pinned: the new one for acyclicity and depth, the old one for the depth the subtree had
        const to = await this.ancestry(o, parentId, fileId), from = await this.ancestry(o, e.parentId);
        const depth = to.length + 1;
        if (depth > L.depthMax) throw new FilesError('depth_exceeded');
        expect.push(...this.revs(o, to), ...this.revs(o, from));
        // a subtree that only moves sideways or up stays within the bound it already met; deeper needs proof
        if (e.kind === 'dir' && depth > from.length + 1) expect.push(...await this.subtreeFits(o, fileId, L.depthMax - depth));
      }
      const put: Array<[string, CatalogRecord]> = [], del: string[] = [];
      if (moved) {
        const oldRow = await this.get(oldIdx);
        if (await this.get(newIdx)) throw new FilesError('name_conflict');
        expect.push([oldIdx, oldRow?.rev ?? 0], [newIdx, 0]);
        put.push([newIdx, { rev: 1, fileId }]); del.push(oldIdx);
        if (parentId !== e.parentId) {
          const from = await this.counter(o, e.parentId), to = await this.counter(o, parentId);
          if (to.children >= L.childrenMax) throw new FilesError('too_many_children');
          expect.push([this.k(o, 'n', e.parentId), from.rev], [this.k(o, 'n', parentId), to.rev]);
          put.push([this.k(o, 'n', e.parentId), { rev: from.rev + 1, children: Math.max(0, from.children - 1) }],
            [this.k(o, 'n', parentId), { rev: to.rev + 1, children: to.children + 1 }]);
        }
      }
      const next: Entry = { ...e, rev: e.rev + 1, name, fold, parentId, mtime: this.now() };
      const result: EntryResponse = { entry: await this.viewOne(o, next) };
      put.push([this.k(o, 'e', fileId), next], [rp.key, { rev: 1, op: 'rename', args, result }]);
      return { result, batch: { expect, put, del } };
    });
  }

  async setPinned(ownerId: string, req: SetPinnedRequest): Promise<EntryResponse> {
    const o = this.owner(ownerId), requestId = str(req?.requestId, REQ_RE, 'requestId'), fileId = fileIdOf(req.fileId);
    if (typeof req.pinned !== 'boolean') throw bad('pinned is invalid');
    const pinned = req.pinned, args = JSON.stringify([fileId, pinned]);
    return this.tx<EntryResponse>(async () => {
      const rp = await this.replay(o, requestId, 'pin', args);
      if (rp.hit) return { done: rp.result as EntryResponse };
      const e = await this.entry(o, fileId), ws = await this.ws(o);
      const next: Entry = e.pinned === pinned ? e : { ...e, rev: e.rev + 1, pinned };
      const result: EntryResponse = { entry: await this.viewOne(o, next) };
      const put: Array<[string, CatalogRecord]> = [[rp.key, { rev: 1, op: 'pin', args, result }]];
      const expect: Array<[string, number]> = [[rp.key, 0], [this.k(o, 'e', fileId), e.rev]];
      if (next !== e) {
        put.push([this.k(o, 'e', fileId), next], [this.k(o, 'ws'), { ...ws, rev: ws.rev + 1, pinnedFiles: Math.max(0, ws.pinnedFiles + (pinned ? 1 : -1)) }]);
        expect.push([this.k(o, 'ws'), ws.rev]);
      }
      return { result, batch: { expect, put, del: [] } };
    });
  }

  // ---- versions ----

  async open(ownerId: string, req: OpenRequest): Promise<OpenResponse> {
    const o = this.owner(ownerId), fileId = fileIdOf(req?.fileId);
    const e = await this.entry(o, fileId);
    if (e.kind !== 'file') throw new FilesError('is_a_directory');
    const versionId = req.versionId ?? e.currentVersion;
    if (versionId === null || typeof versionId !== 'string') throw new FilesError('not_found', 'file has no version');
    const v = await this.get<Ver>(this.vKey(o, fileId, versionId));
    if (!v || v.versionId !== versionId || v.fileId !== fileId) throw new FilesError('not_found', 'version not found');
    return { descriptor: { ...this.versionView(v), name: e.name } };
  }

  async listVersions(ownerId: string, req: ListVersionsRequest): Promise<ListVersionsResponse> {
    const o = this.owner(ownerId), fileId = fileIdOf(req?.fileId);
    const limit = req.limit === undefined ? L.listPageDefault : int(req.limit, 'limit', 1, L.listPageMax);
    const after = decodeCursor(req.cursor, fileId);
    await this.entry(o, fileId);
    const prefix = this.k(o, 'v', fileId) + '/';
    const rows = await this.read(this.cat().list(prefix, { startAfter: after === undefined ? undefined : prefix + after, limit: limit + 1 }));
    const page = rows.slice(0, limit), last = page[page.length - 1];
    return { versions: page.map(([, v]) => this.versionView(v as Ver)),
      nextCursor: rows.length > limit && last ? encodeCursor(fileId, last[0].slice(prefix.length)) : null };
  }

  /** Metadata-only materialize plan: canonical path of `fileId` built from this owner's entries (each hop checked
   *  against its parent's child index), plus the version's size/hash. The walk is re-read in one getMany and must be
   *  unchanged, so a concurrent rename/move is never mixed into the path. At most depthMax hops; BlobStore untouched. */
  async resolveManifest(ownerId: string, req: ResolveManifestRequest): Promise<ResolveManifestResponse> {
    const o = this.owner(ownerId), fileId = fileIdOf(req?.fileId);
    if (fileId === ROOT_ID) throw new FilesError('is_a_directory');
    const want = req.versionId === undefined || req.versionId === null ? null : str(req.versionId, VER_RE, 'versionId');
    attempt: for (let i = 0; i < ATTEMPTS; i++) {
      const e = await this.entry(o, fileId);
      if (e.kind !== 'file') throw new FilesError('is_a_directory');
      const versionId = want ?? e.currentVersion;
      if (versionId === null) throw new FilesError('not_found', 'file has no version');
      const v = await this.get<Ver>(this.vKey(o, fileId, versionId));
      if (!v || v.versionId !== versionId || v.fileId !== fileId) throw new FilesError('not_found', 'version not found');
      const chain: Entry[] = [e]; // target first, then ancestors up to (excluding) root
      for (let id = e.parentId; id !== ROOT_ID;) {
        if (chain.length >= L.depthMax) throw new FilesError('depth_exceeded');
        const d = await this.get<Entry>(this.k(o, 'e', id));
        if (!d || d.kind !== 'dir') continue attempt;
        chain.push(d); id = d.parentId;
      }
      const idx = chain.map(c => this.k(o, 'c', c.parentId, c.fold));
      const again = await this.read(this.cat().getMany(chain.map(c => this.k(o, 'e', c.fileId)).concat(idx)));
      if (chain.some((c, j) => again.get(this.k(o, 'e', c.fileId))?.rev !== c.rev || again.get(idx[j]!)?.fileId !== c.fileId)) continue;
      const dirs: ManifestDir[] = [];
      let path = '';
      for (const d of chain.slice(1).reverse()) { path = path ? `${path}/${d.name}` : d.name; dirs.push({ fileId: d.fileId, name: d.name, path }); }
      return { manifest: { rootId: ROOT_ID, fileId, name: e.name, path: path ? `${path}/${e.name}` : e.name, versionId,
        versionSeq: v.versionSeq, size: v.size, sha256: v.sha256, dirs } };
    }
    throw new FilesError('catalog_busy');
  }

  /** Streams bytes of one immutable version (bounded range). The transport is wired by the caller; no provider URL. */
  async readVersion(ownerId: string, req: { fileId: string; versionId: string; offset?: number; length?: number }):
    Promise<{ descriptor: VersionView; body: ReadableStream<Uint8Array> }> {
    const blobs = this.blob(), o = this.owner(ownerId), fileId = fileIdOf(req?.fileId);
    const v = await this.get<Ver>(this.vKey(o, fileId, str(req.versionId, VER_RE, 'versionId')));
    if (!v || v.versionId !== req.versionId || v.fileId !== fileId) throw new FilesError('not_found', 'version not found');
    const offset = req.offset === undefined ? 0 : int(req.offset, 'offset', 0, v.size);
    const length = req.length === undefined ? v.size - offset : int(req.length, 'length', 0, v.size - offset);
    let body: ReadableStream<Uint8Array> | null;
    try { body = await blobs.get(v.objectKey, offset === 0 && length === v.size ? undefined : { offset, length }); }
    catch { throw new FilesError('blob_unavailable'); }
    if (!body) throw new FilesError('body_missing');
    return { descriptor: this.versionView(v), body };
  }

  // ---- upload: begin -> body -> verified canonical commit ----

  async beginUpload(ownerId: string, req: BeginUploadRequest): Promise<UploadResponse> {
    this.blob();
    const o = this.owner(ownerId), requestId = str(req?.requestId, REQ_RE, 'requestId'), fileId = fileIdOf(req.fileId);
    const baseVersion = req.baseVersion === null ? null : str(req.baseVersion, VER_RE, 'baseVersion');
    const writerEpoch = int(req.writerEpoch, 'writerEpoch', 1);
    const size = int(req.size, 'size', 0);
    if (size > this.maxFileBytes) throw new FilesError('too_large');
    const sha256 = str(req.sha256, HEX_RE, 'sha256');
    const args = JSON.stringify([fileId, baseVersion, writerEpoch, size, sha256]);
    const uploadId = 'u_' + this.rid();
    const done = await this.tx<string>(async () => {
      const rp = await this.replay(o, requestId, 'begin', args);
      if (rp.hit) return { done: (rp.result as { uploadId: string }).uploadId };
      const ws = await this.ws(o);
      if (ws.writerEpoch !== writerEpoch) throw new FilesError('stale_writer');
      const e = await this.entry(o, fileId);
      if (e.kind !== 'file') throw new FilesError('is_a_directory');
      if (baseVersion !== null) {
        const b = await this.get<Ver>(this.vKey(o, fileId, baseVersion));
        if (!b || b.versionId !== baseVersion) throw new FilesError('not_found', 'base version not found');
      }
      if (ws.pendingUploads >= L.pendingUploadsMax) throw new FilesError('too_many_uploads');
      if (ws.usedBytes + ws.reservedBytes + size > this.quotaBytes) throw new FilesError('quota_exceeded');
      const t = this.now();
      const u: Upload = { rev: 1, uploadId, fileId, baseVersion, writerEpoch, size, sha256, phase: 'begun', createdAt: t,
        expiresAt: t + L.uploadTtlMs, result: null, objectKey: `${o}/${fileId}/${uploadId}`, requestId };
      return { result: uploadId, batch: {
        expect: [[rp.key, 0], [this.k(o, 'u', uploadId), 0], [this.k(o, 'ws'), ws.rev]],
        put: [[this.k(o, 'u', uploadId), u], [this.k(o, 'ws'), { ...ws, rev: ws.rev + 1, reservedBytes: ws.reservedBytes + size, pendingUploads: ws.pendingUploads + 1 }],
          [rp.key, { rev: 1, op: 'begin', args, result: { uploadId } }]],
        del: [] } };
    });
    return this.getUpload(o, { uploadId: done });
  }

  async getUpload(ownerId: string, req: CommitRequest): Promise<UploadResponse> {
    const o = this.owner(ownerId), u = await this.get<Upload>(this.k(o, 'u', str(req?.uploadId, UPLOAD_RE, 'uploadId')));
    if (!u) throw new FilesError('not_found');
    return { upload: this.uploadView(u) };
  }

  /** Streams the body to the provider, bounded to the declared size and hash. Never a commit or durability claim. */
  async writeUploadBody(ownerId: string, uploadId: string, body: ReadableStream<Uint8Array>): Promise<UploadResponse> {
    const blobs = this.blob(), o = this.owner(ownerId), key = this.k(o, 'u', str(uploadId, UPLOAD_RE, 'uploadId'));
    const u = await this.get<Upload>(key);
    if (!u) throw new FilesError('not_found');
    if ((u.phase !== 'begun' && u.phase !== 'body_written') || this.now() > u.expiresAt) throw new FilesError('invalid_upload_state');
    if (!body || typeof (body as ReadableStream).getReader !== 'function') throw bad('body is required');
    // fenced before streaming (no paid transfer for a stale writer) and re-checked after; commit fences again atomically
    if ((await this.ws(o)).writerEpoch !== u.writerEpoch) throw new FilesError('stale_writer');
    const h = this.hasher();
    let n = 0, failure: FilesError | null = null;
    const fail = (e: FilesError) => { failure = e; throw e; };
    const limited = body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      async transform(chunk, c) {
        n += chunk.byteLength;
        if (n > u.size) fail(new FilesError('too_large', 'body longer than declared size'));
        await h.write(chunk); c.enqueue(chunk);
      },
      async flush() {
        if (n !== u.size) fail(new FilesError('size_mismatch'));
        if ((await h.digest()) !== u.sha256) fail(new FilesError('hash_mismatch'));
      },
    }));
    try { await blobs.put(u.objectKey, limited, { size: u.size, sha256: u.sha256 }); }
    catch { throw failure ?? new FilesError('blob_unavailable'); }
    if (failure) throw failure;
    const ws = await this.ws(o);
    if (ws.writerEpoch !== u.writerEpoch) throw new FilesError('stale_writer'); // object stays for owned-object GC
    if (u.phase === 'begun') {
      try { await this.cat().write({ expect: [[key, u.rev], [this.k(o, 'ws'), ws.rev]], put: [[key, { ...u, rev: u.rev + 1, phase: 'body_written' }]], del: [] }); }
      catch { /* phase is advisory; commit verifies the provider object itself */ }
    }
    return this.getUpload(o, { uploadId });
  }

  /** Provider observation: object exists, provider says durable, size matches, SHA-256 matches. */
  private async verify(u: Upload): Promise<void> {
    const blobs = this.blob();
    let obs: BlobObservation | null;
    try { obs = await blobs.head(u.objectKey); } catch { throw new FilesError('blob_unavailable'); }
    if (!obs) throw new FilesError('body_missing');
    if (obs.size !== u.size) throw new FilesError('size_mismatch');
    if (!obs.durable) throw new FilesError('not_durable');
    if (obs.sha256 !== null) {
      if (obs.sha256.toLowerCase() !== u.sha256) throw new FilesError('hash_mismatch');
      return;
    }
    const h = this.hasher();
    let stream: ReadableStream<Uint8Array> | null;
    try { stream = await blobs.get(u.objectKey); } catch { throw new FilesError('blob_unavailable'); }
    if (!stream) throw new FilesError('body_missing');
    const reader = stream.getReader();
    let n = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        n += value.byteLength;
        if (n > u.size) throw new FilesError('size_mismatch');
        await h.write(value);
      }
    } catch (e) { reader.cancel().catch(() => {}); throw e instanceof FilesError ? e : new FilesError('blob_unavailable'); }
    if (n !== u.size) throw new FilesError('size_mismatch');
    if ((await h.digest()) !== u.sha256) throw new FilesError('hash_mismatch');
  }

  private conflictName(name: string, n: number): { name: string; fold: string } {
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 ? name.slice(dot) : '', suffix = ` (conflict ${n})${ext}`;
    let stem = [...(dot > 0 ? name.slice(0, dot) : name)];
    while (stem.length && utf8.encode(stem.join('') + suffix).byteLength > L.nameBytesMax) stem = stem.slice(0, -1);
    return normalizeName((stem.join('') || 'file') + suffix);
  }

  async commitUpload(ownerId: string, req: CommitRequest): Promise<CommitResponse> {
    this.blob();
    const o = this.owner(ownerId), uploadId = str(req?.uploadId, UPLOAD_RE, 'uploadId'), uKey = this.k(o, 'u', uploadId);
    const first = await this.get<Upload>(uKey);
    if (!first) throw new FilesError('not_found');
    if (first.result) return { result: first.result };
    if (first.phase === 'aborted') throw new FilesError('invalid_upload_state', 'upload aborted');
    if (this.now() > first.expiresAt) throw new FilesError('invalid_upload_state', 'upload expired');
    if ((await this.ws(o)).writerEpoch !== first.writerEpoch) throw new FilesError('stale_writer');
    await this.verify(first);
    const versionId = (seq: number) => `v_${String(SEQ_TOP - seq).padStart(13, '0')}_${this.rid()}`;
    const conflictFileId = 'f_' + this.rid();
    const result = await this.tx<CommitResult>(async () => {
      const u = await this.get<Upload>(uKey);
      if (!u) throw new FilesError('not_found');
      if (u.result) return { done: u.result };
      if (u.phase === 'aborted') throw new FilesError('invalid_upload_state', 'upload aborted');
      const t = this.now();
      if (t > u.expiresAt) throw new FilesError('invalid_upload_state', 'upload expired');
      const ws = await this.ws(o);
      if (ws.writerEpoch !== u.writerEpoch) throw new FilesError('stale_writer');
      const e = await this.entry(o, u.fileId);
      const wsNext: Ws = { ...ws, rev: ws.rev + 1, reservedBytes: Math.max(0, ws.reservedBytes - u.size),
        usedBytes: ws.usedBytes + u.size, pendingUploads: Math.max(0, ws.pendingUploads - 1) };
      const expect: Array<[string, number]> = [[uKey, u.rev], [this.k(o, 'ws'), ws.rev], [this.k(o, 'e', e.fileId), e.rev]];
      const put: Array<[string, CatalogRecord]> = [[this.k(o, 'ws'), wsNext]];
      let res: CommitResult, target: Entry;
      if (u.baseVersion === e.currentVersion) {
        const seq = e.versionSeq + 1, vid = versionId(seq);
        target = { ...e, rev: e.rev + 1, size: u.size, mtime: t, currentVersion: vid, versionSeq: seq };
        res = { status: 'committed', fileId: e.fileId, versionId: vid, versionSeq: seq, size: u.size, sha256: u.sha256, conflictFileId: null, durable: true };
      } else {
        // stale base: never overwrite the newer canonical version; keep this content as a sibling file
        const parent = await this.dir(o, e.parentId), n = await this.counter(o, e.parentId);
        if (n.children >= L.childrenMax) throw new FilesError('too_many_children');
        let picked: { name: string; fold: string } | null = null;
        for (let i = 1; i <= L.conflictNameAttempts && !picked; i++) {
          const c = this.conflictName(e.name, i);
          if (!(await this.get(this.k(o, 'c', e.parentId, c.fold)))) picked = c;
        }
        if (!picked) throw new FilesError('name_conflict');
        const vid = versionId(1), idx = this.k(o, 'c', e.parentId, picked.fold);
        target = { rev: 1, fileId: conflictFileId, parentId: e.parentId, name: picked.name, fold: picked.fold, kind: 'file', size: u.size,
          mtime: t, currentVersion: vid, versionSeq: 1, pinned: false };
        expect.push([idx, 0], [this.k(o, 'e', conflictFileId), 0], [this.k(o, 'e', parent.fileId), parent.rev], [this.k(o, 'n', e.parentId), n.rev]);
        put.push([idx, { rev: 1, fileId: conflictFileId }], [this.k(o, 'n', e.parentId), { rev: n.rev + 1, children: n.children + 1 }]);
        res = { status: 'conflict', fileId: e.fileId, versionId: vid, versionSeq: 1, size: u.size, sha256: u.sha256, conflictFileId, durable: true };
      }
      const v: Ver = { rev: 1, fileId: target.fileId, versionId: res.versionId, versionSeq: res.versionSeq, size: u.size, sha256: u.sha256,
        committedAt: t, writerEpoch: u.writerEpoch, baseVersion: u.baseVersion, objectKey: u.objectKey, uploadId };
      const vKey = this.vKey(o, target.fileId, res.versionId);
      expect.push([vKey, 0]);
      put.push([this.k(o, 'e', target.fileId), target], [vKey, v], [uKey, { ...u, rev: u.rev + 1, phase: res.status, result: res }]);
      return { result: res, batch: { expect, put, del: [] } };
    });
    return { result };
  }

  /** Releases the reservation of an uncommitted upload. The staged object is left for a separate owned-object GC. */
  async abortUpload(ownerId: string, req: CommitRequest): Promise<UploadResponse> {
    const o = this.owner(ownerId), uploadId = str(req?.uploadId, UPLOAD_RE, 'uploadId'), uKey = this.k(o, 'u', uploadId);
    await this.tx<null>(async () => {
      const u = await this.get<Upload>(uKey);
      if (!u) throw new FilesError('not_found');
      if (u.result) throw new FilesError('invalid_upload_state', 'upload already committed');
      if (u.phase === 'aborted') return { done: null };
      const ws = await this.ws(o);
      return { result: null, batch: { expect: [[uKey, u.rev], [this.k(o, 'ws'), ws.rev]],
        put: [[uKey, { ...u, rev: u.rev + 1, phase: 'aborted' }],
          [this.k(o, 'ws'), { ...ws, rev: ws.rev + 1, reservedBytes: Math.max(0, ws.reservedBytes - u.size), pendingUploads: Math.max(0, ws.pendingUploads - 1) }]],
        del: [] } };
    });
    return this.getUpload(o, { uploadId });
  }

  // ---- writer + local state ----

  /** Caller must already have confirmed the previous writer is stopped/blocked; this only fences by epoch. */
  async advanceWriter(ownerId: string, req: AdvanceWriterRequest): Promise<AdvanceWriterResponse> {
    const o = this.owner(ownerId), requestId = str(req?.requestId, REQ_RE, 'requestId');
    const expectedEpoch = int(req.expectedEpoch, 'expectedEpoch', 1), machineId = str(req.machineId, MACHINE_RE, 'machineId');
    const args = JSON.stringify([expectedEpoch, machineId]);
    return this.tx<AdvanceWriterResponse>(async () => {
      const rp = await this.replay(o, requestId, 'writer', args);
      if (rp.hit) return { done: rp.result as AdvanceWriterResponse };
      const ws = await this.ws(o);
      if (ws.writerEpoch !== expectedEpoch) throw new FilesError('stale_writer');
      const result: AdvanceWriterResponse = { writerEpoch: ws.writerEpoch + 1, writerMachine: machineId };
      return { result, batch: { expect: [[rp.key, 0], [this.k(o, 'ws'), ws.rev]],
        put: [[this.k(o, 'ws'), { ...ws, rev: ws.rev + 1, writerEpoch: result.writerEpoch, writerMachine: machineId }],
          [rp.key, { rev: 1, op: 'writer', args, result }]], del: [] } };
    });
  }

  /** Agent report of its local copy. Older/equal seq is ignored, so a late "clean" never erases a newer "dirty".
   *  Clean requires the canonical current version; a clean claim for anything else is not_verified. */
  async recordLocalState(ownerId: string, req: LocalStateRequest): Promise<LocalStateResponse> {
    const o = this.owner(ownerId), machineId = str(req?.machineId, MACHINE_RE, 'machineId'), fileId = fileIdOf(req.fileId);
    const writerEpoch = int(req.writerEpoch, 'writerEpoch', 1), seq = int(req.seq, 'seq', 1);
    if (typeof req.dirty !== 'boolean') throw bad('dirty is invalid');
    const versionId = req.versionId === null ? null : str(req.versionId, VER_RE, 'versionId'), dirty = req.dirty;
    return this.tx<LocalStateResponse>(async () => {
      const ws = await this.ws(o);
      if (ws.writerEpoch !== writerEpoch || ws.writerMachine !== machineId) throw new FilesError('stale_writer');
      const lKey = this.k(o, 'l', machineId, fileId), cur = await this.get<Local>(lKey);
      if (cur && cur.seq >= seq) return { done: { local: this.localView(cur), applied: false } };
      const e = await this.entry(o, fileId);
      if (e.kind !== 'file') throw new FilesError('is_a_directory');
      if (!dirty && (versionId === null || versionId !== e.currentVersion)) throw new FilesError('not_verified');
      const next: Local = { rev: (cur?.rev ?? 0) + 1, machineId, fileId, versionId, dirty, seq, updatedAt: this.now() };
      const delta = (dirty ? 1 : 0) - (cur?.dirty ? 1 : 0);
      // ws is always expected (even with no counter change): it carries the writer fence, so an advanceWriter landing
      // between this read and the write rejects the batch and the retry reports stale_writer
      const expect: Array<[string, number]> = [[lKey, cur?.rev ?? 0], [this.k(o, 'e', fileId), e.rev], [this.k(o, 'ws'), ws.rev]];
      const put: Array<[string, CatalogRecord]> = [[lKey, next]];
      if (delta) put.push([this.k(o, 'ws'), { ...ws, rev: ws.rev + 1, dirtyFiles: Math.max(0, ws.dirtyFiles + delta) }]);
      return { result: { local: this.localView(next), applied: true }, batch: { expect, put, del: [] } };
    });
  }
  private localView(l: Local): LocalCopyView {
    return { machineId: l.machineId, fileId: l.fileId, versionId: l.versionId, dirty: l.dirty, seq: l.seq, updatedAt: l.updatedAt };
  }

  /** Uncommitted uploads, for reconcile after a crash between body write and catalog commit. Does not delete. */
  async listPendingUploads(ownerId: string, req: { cursor?: string | null; limit?: number } = {}): Promise<{ uploads: UploadView[]; nextCursor: string | null }> {
    const o = this.owner(ownerId), limit = req.limit === undefined ? L.listPageDefault : int(req.limit, 'limit', 1, L.listPageMax);
    const after = decodeCursor(req.cursor, 'uploads'), prefix = this.k(o, 'u') + '/';
    const rows = await this.read(this.cat().list(prefix, { startAfter: after === undefined ? undefined : prefix + after, limit: limit + 1 }));
    const page = rows.slice(0, limit), last = page[page.length - 1];
    return { uploads: page.map(([, u]) => this.uploadView(u as Upload)).filter(u => !u.result),
      nextCursor: rows.length > limit && last ? encodeCursor('uploads', last[0].slice(prefix.length)) : null };
  }

  async storageStatus(ownerId: string): Promise<{ status: StorageStatusView }> {
    const o = this.owner(ownerId);
    const base = { blobs: this.blobs ? 'configured' as const : 'not_configured' as const, blobKind: this.blobs?.kind ?? null,
      quotaBytes: this.quotaBytes, maxFileBytes: this.maxFileBytes };
    if (!this.catalog) return { status: { catalog: 'not_configured', ...base, writerEpoch: 0, writerMachine: null, usedBytes: 0,
      reservedBytes: 0, pendingUploads: 0, dirtyFiles: 0, pinnedFiles: 0 } };
    const ws = await this.ws(o);
    return { status: { catalog: 'configured', ...base, writerEpoch: ws.writerEpoch, writerMachine: ws.writerMachine, usedBytes: ws.usedBytes,
      reservedBytes: ws.reservedBytes, pendingUploads: ws.pendingUploads, dirtyFiles: ws.dirtyFiles, pinnedFiles: ws.pinnedFiles } };
  }
}

// ---- real adapters (root chooses; no fake remote here) ----

/** Durable Object storage as CatalogStore: conditional batch inside storage.transaction(). */
export function durableObjectCatalog(storage: DurableObjectStorage): CatalogStore {
  const chunks = <T>(a: T[], n = 128) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));
  return {
    get: key => storage.get<CatalogRecord>(key),
    async getMany(keys) {
      const out = new Map<string, CatalogRecord>();
      for (const c of chunks(keys)) for (const [k, v] of await storage.get<CatalogRecord>(c)) out.set(k, v);
      return out;
    },
    async list(prefix, { startAfter, limit }) {
      return [...(await storage.list<CatalogRecord>({ prefix, startAfter, limit: Math.min(limit, L.listPageMax + 1) }))];
    },
    write: batch => storage.transaction(async txn => {
      for (const c of chunks(batch.expect)) {
        const cur = await txn.get<CatalogRecord>(c.map(([k]) => k));
        for (const [k, rev] of c) if ((cur.get(k)?.rev ?? 0) !== rev) return false;
      }
      for (const c of chunks(batch.put)) await txn.put(Object.fromEntries(c));
      for (const c of chunks(batch.del)) await txn.delete(c);
      return true;
    }),
  };
}

/** R2 as BlobStore. put passes the declared SHA-256 so R2 verifies the received bytes server-side and rejects a
 *  mismatch; head reports that stored checksum. An R2 put resolves only after the write is committed by R2. */
export function r2BlobStore(bucket: R2Bucket): BlobStore {
  return {
    kind: 'r2',
    async put(key, body, { size, sha256 }) {
      await bucket.put(key, body.pipeThrough(new FixedLengthStream(size)), { sha256 });
    },
    async head(key) {
      const obj = await bucket.head(key);
      if (!obj) return null;
      const sum = obj.checksums.sha256;
      return { size: obj.size, sha256: sum ? hex(sum) : null, durable: true };
    },
    async get(key, range) {
      const obj = await bucket.get(key, range ? { range } : undefined);
      return obj ? obj.body : null;
    },
  };
}
