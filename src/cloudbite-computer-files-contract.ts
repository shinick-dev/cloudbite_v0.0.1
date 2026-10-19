// Cloud Files contract: owner-scoped metadata catalog, immutable per-file versions, verified canonical commit.
// Wire shapes only; the service lives in cloudbite-computer-files.ts. Nothing here carries file bodies or provider URLs.

export const FILES_LIMITS = {
  listPageMax: 200,
  listPageDefault: 100,
  nameBytesMax: 255,
  depthMax: 32,
  childrenMax: 100_000,
  requestIdMax: 128,
  cursorMax: 1024,
  machineIdMax: 64,
  pendingUploadsMax: 64,
  uploadTtlMs: 24 * 3600_000,
  fileBytesDefault: 2 * 1024 ** 3,
  fileBytesHardMax: 50 * 1024 ** 3,
  conflictNameAttempts: 20,
} as const;

export const ROOT_ID = 'root';

export type FilesErrorCode =
  | 'invalid_request'      // malformed field / out-of-bound input
  | 'invalid_name'         // empty, '.', '..', separator, control char, trailing dot/space, >255 UTF-8 bytes, lone surrogate
  | 'name_conflict'        // sibling with the same NFC + case-folded name
  | 'unsupported_kind'     // symlinks, devices, anything not file/dir
  | 'not_found'            // unknown id, or id owned by another owner (indistinguishable on purpose)
  | 'not_a_directory'
  | 'is_a_directory'
  | 'invalid_move'         // move into itself/descendant, or moving root
  | 'depth_exceeded'
  | 'too_many_children'
  | 'invalid_cursor'
  | 'request_conflict'     // requestId reused with different arguments
  | 'stale_revision'       // expectedRev does not match the entry
  | 'stale_writer'         // writerEpoch is not the workspace's current epoch
  | 'invalid_upload_state' // e.g. body write after commit, expired upload
  | 'too_large'            // size above per-file bound, or body longer than declared
  | 'quota_exceeded'
  | 'too_many_uploads'
  | 'size_mismatch'        // stored body size differs from declared size
  | 'hash_mismatch'        // stored body SHA-256 differs from declared hash
  | 'body_missing'         // provider has no object for the upload
  | 'not_durable'          // provider has not acknowledged durable persistence; retry later
  | 'not_verified'         // clean local state claimed for a version that is not canonical
  | 'commit_unknown'       // catalog write outcome unknown; retry the same uploadId to reconcile
  | 'catalog_busy'         // optimistic write lost a race; safe to retry
  | 'catalog_unavailable'  // catalog read failed before any write
  | 'blob_unavailable'     // provider call failed; nothing is claimed stored
  | 'store_not_configured';

export const FILES_ERROR_STATUS: Record<FilesErrorCode, number> = {
  invalid_request: 400, invalid_name: 400, unsupported_kind: 400, invalid_cursor: 400, invalid_move: 400,
  depth_exceeded: 400, not_a_directory: 400, is_a_directory: 400,
  not_found: 404,
  name_conflict: 409, request_conflict: 409, stale_revision: 409, stale_writer: 409, invalid_upload_state: 409,
  not_verified: 409, catalog_busy: 409,
  too_large: 413, quota_exceeded: 507, too_many_uploads: 429, too_many_children: 507,
  size_mismatch: 422, hash_mismatch: 422, body_missing: 422,
  not_durable: 503, commit_unknown: 503, store_not_configured: 503, catalog_unavailable: 503, blob_unavailable: 503,
};

export const FILES_RETRYABLE: ReadonlySet<FilesErrorCode> = new Set([
  'not_durable', 'commit_unknown', 'catalog_busy', 'body_missing', 'catalog_unavailable', 'blob_unavailable']);

export class FilesError extends Error {
  readonly status: number;
  readonly retryable: boolean;
  constructor(readonly code: FilesErrorCode, message: string = code) {
    super(message);
    this.status = FILES_ERROR_STATUS[code];
    this.retryable = FILES_RETRYABLE.has(code);
  }
  toJSON() { return { error: { code: this.code, message: this.message, retryable: this.retryable } }; }
}

export type FileKind = 'file' | 'dir';
/** remote: canonical copy only; local: writer machine reports a clean copy of the canonical version;
 *  dirty: writer machine reports unconfirmed local changes (never cleared by a stale/older report). */
export type LocalState = 'remote' | 'local' | 'dirty';

export interface FileEntryView {
  fileId: string;
  parentId: string;
  name: string;              // NFC
  kind: FileKind;
  size: number;              // bytes of currentVersion (0 for dirs / no version)
  mtime: number;             // ms epoch of last metadata or version change
  currentVersion: string | null;
  versionSeq: number;        // monotonic per file, 0 = no version
  pinned: boolean;
  state: LocalState;
  rev: number;               // optimistic revision for rename/move
}

export interface VersionView {
  fileId: string;
  versionId: string;
  versionSeq: number;
  size: number;
  sha256: string;            // lowercase hex, verified against the stored object
  committedAt: number;
  writerEpoch: number;
  baseVersion: string | null;
}

export type UploadPhase = 'begun' | 'body_written' | 'committed' | 'conflict' | 'aborted';

export interface UploadView {
  uploadId: string;
  fileId: string;
  baseVersion: string | null;
  writerEpoch: number;
  size: number;
  sha256: string;
  phase: UploadPhase;
  createdAt: number;
  expiresAt: number;
  result: CommitResult | null;
}

export interface CommitResult {
  status: 'committed' | 'conflict';
  fileId: string;            // canonical target on commit; original file on conflict
  versionId: string;         // the new immutable version (on conflict it belongs to conflictFileId)
  versionSeq: number;
  size: number;
  sha256: string;
  conflictFileId: string | null; // sibling holding the preserved content when base was stale
  durable: true;             // only ever returned after provider-durable + content-verified observation
}

export interface LocalCopyView {
  machineId: string;
  fileId: string;
  versionId: string | null;
  dirty: boolean;
  seq: number;
  updatedAt: number;
}

export interface StorageStatusView {
  catalog: 'configured' | 'not_configured';
  blobs: 'configured' | 'not_configured';
  blobKind: string | null;
  writerEpoch: number;
  writerMachine: string | null;
  usedBytes: number;          // committed version bytes, all retained versions
  reservedBytes: number;      // bytes reserved by open uploads
  quotaBytes: number;
  maxFileBytes: number;
  pendingUploads: number;
  dirtyFiles: number;
  pinnedFiles: number;
}

// ---- JSON method contracts (request -> response). Errors are FilesError.toJSON() with FILES_ERROR_STATUS. ----
export interface ListRequest { parentId: string; cursor?: string | null; limit?: number }
export interface ListResponse { parentId: string; entries: FileEntryView[]; nextCursor: string | null }
export interface CreateRequest { requestId: string; parentId: string; name: string; kind: FileKind }
export interface RenameRequest { requestId: string; fileId: string; expectedRev: number; name?: string; parentId?: string }
export interface EntryResponse { entry: FileEntryView }
export interface BeginUploadRequest { requestId: string; fileId: string; baseVersion: string | null; writerEpoch: number; size: number; sha256: string }
export interface UploadResponse { upload: UploadView }
export interface CommitRequest { uploadId: string }
export interface CommitResponse { result: CommitResult }
export interface OpenRequest { fileId: string; versionId?: string | null }
export interface OpenResponse { descriptor: VersionView & { name: string } }
export interface ListVersionsRequest { fileId: string; cursor?: string | null; limit?: number }
export interface ListVersionsResponse { versions: VersionView[]; nextCursor: string | null }
export interface SetPinnedRequest { requestId: string; fileId: string; pinned: boolean }
export interface LocalStateRequest { machineId: string; writerEpoch: number; seq: number; fileId: string; versionId: string | null; dirty: boolean }
export interface LocalStateResponse { local: LocalCopyView; applied: boolean }
export interface AdvanceWriterRequest { requestId: string; expectedEpoch: number; machineId: string }
export interface AdvanceWriterResponse { writerEpoch: number; writerMachine: string }
export interface StorageStatusResponse { status: StorageStatusView }
