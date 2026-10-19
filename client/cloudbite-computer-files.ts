// Cloudbite computer files (browser). tools/build-cloudbite-computer-files.mjs transforms this file (no bundling) into
// src/cloudbite-computer-files-page.ts → CLOUDBITE_COMPUTER_FILES_JS, served same-origin at /cloudbite/computer/files.js
// for the page /cloudbite/computer/files (?lang=ko|en).
// Sign-in stays on the main computer page (/cloudbite/computer): this page only uses the existing HttpOnly cookie, and a 401
// shows a link there. It never starts WebAuthn, keeps browser-side data or holds a token.
// Browsing is metadata only: GET status and GET list never fetch a file body. Bytes move only on an explicit press:
// Download posts files/open for a descriptor and then activates one same-origin content link (kept visible as the fallback);
// Upload hashes one user-chosen file (≤ 32 MiB) and runs create → uploads/begin → PUT body → commit. Only a committed,
// durable result whose size and SHA-256 match the local file counts as saved; a conflict keeps the sibling copy and says so.
// Every write keeps its requestId and exact body in memory until the server answers definitely, so Retry repeats the same
// request; an upload whose answer was lost first reads GET uploads/<id> and never mints a new write on its own.
// No polling: a visible tab refreshes once when it becomes visible again. Nothing starts a machine or any paid provider action.
// Everything is drawn with createElement/textContent (names isolated in <bdi>). Text comes from DICT (EN/KO); server error
// codes are shown verbatim. A message keeps what happened (code, HTTP status) and is worded when drawn, so switching language
// never mixes an old-language detail into a new sentence; the switch also rewrites ?lang= (replaceState) so a reload keeps it.
// A failed list read keeps the rows already shown and never leaves a loading line behind.

const API = '/api/cloudbite/computer/files';
const STATUS_API = `${API}/status`;
const CREATE_API = `${API}/create`;
const RENAME_API = `${API}/rename`;
const PIN_API = `${API}/pin`;
const OPEN_API = `${API}/open`;
const BEGIN_API = `${API}/uploads/begin`;
const COMPUTER_PATH = '/cloudbite/computer';
const ROOT = 'root';
const FILE_ID = /^f_[A-Za-z0-9]{1,64}$/;
const VERSION_ID = /^v_[A-Za-z0-9]{1,64}$/;
const UPLOAD_ID = /^u_[A-Za-z0-9]{1,64}$/;
const SHA = /^[0-9a-f]{64}$/;
const SAFE_CODE = /^[a-z0-9_.-]{1,64}$/i;
const PAGE_LIMIT = 100;
const MAX_ENTRIES = 5000;
const CURSOR_MAX = 1024;
const NAME_BYTES_MAX = 255;
const UPLOAD_MAX = 32 * 1024 * 1024;
// The server may refuse these safely and the same request can be repeated.
const RETRYABLE = ['catalog_busy', 'body_missing', 'not_durable', 'commit_unknown', 'catalog_unavailable', 'blob_unavailable'];

type Kind = 'file' | 'dir';
type LocalState = 'remote' | 'local' | 'dirty';
const LOCAL_STATES: LocalState[] = ['remote', 'local', 'dirty'];
type Entry = {
  fileId: string; parentId: string; name: string; kind: Kind; size: number; mtime: number;
  currentVersion: string | null; versionSeq: number; pinned: boolean; state: LocalState; rev: number;
};
type Status = {
  catalog: boolean; blobs: boolean; writerEpoch: number; usedBytes: number; quotaBytes: number; maxFileBytes: number;
  pendingUploads: number; dirtyFiles: number; pinnedFiles: number;
};
type Phase = 'begun' | 'body_written' | 'committed' | 'conflict' | 'aborted';
const PHASES: Phase[] = ['begun', 'body_written', 'committed', 'conflict', 'aborted'];
type Result = { status: 'committed' | 'conflict'; fileId: string; versionId: string; size: number; sha256: string; conflictFileId: string | null; durable: boolean };
type Upload = { uploadId: string; fileId: string; size: number; sha256: string; phase: Phase; result: Result | null };
type Dir = { id: string; name: string };
type Op = { kind: 'mkdir' | 'rename' | 'pin'; url: string; json: string; phase: 'sending' | 'uncertain'; key: string; label: () => string };
type Step = 'create' | 'begin' | 'body' | 'commit';
type Up = {
  name: string; size: number; sha: string; bytes: ArrayBuffer; parentId: string; dirs: Dir[]; writerEpoch: number;
  createJson: string; beginId: string; beginJson: string | null; fileId: string | null; uploadId: string | null;
  step: Step; phase: 'sending' | 'uncertain' | 'failed'; code: string;
};
type Reply = { ok: true; status: number; body: Record<string, unknown> } | { ok: false; status: number; code: string; retryable: boolean };
type Lang = 'en' | 'ko';
type Msg = { text: () => string; kind: 'ok' | 'warn' | 'info' } | null;

// ───────────────────────── Text ─────────────────────────

const DICT = {
  en: {
    title: 'Cloudbite — Files', brand: 'Cloudbite', sub: 'Files', back: 'Cloud computer',
    h1: 'My files', lead: 'Your cloud files are listed without downloading them. Content moves only when you press Download or Upload.',
    loading: 'Loading…', loadFailed: 'Could not load your files.', odd: 'The server answered in an unexpected way.', retryLoad: 'Try again',
    netErr: 'Network error — nothing was confirmed.', rejected: (c: string) => `Rejected: ${c}`,
    signedOut: 'You are not signed in to your cloud computer. Sign in on the cloud computer page, then come back.', signInLink: 'Sign in on the cloud computer page',
    checkAgain: 'Check again',
    notConfigured: 'File storage is not configured for this Cloudbite yet. Nothing is stored and no files can be listed.',
    blobsMissing: 'File contents storage is not configured. You can browse names, but downloads and uploads are off.',
    storeTitle: 'Storage', sConnected: 'Connected', sConfigured: 'Configured', sUnread: 'Configured — list not read', sNotConfigured: 'Not configured', sCatalog: 'File list', sBlobs: 'File contents',
    sUsed: 'Used', sUsedOf: (u: string, q: string) => `${u} of ${q}`, sPending: 'Unfinished uploads', sDirty: 'Changed on cloud computer, not uploaded', sPinned: 'Kept on cloud computer',
    whereTitle: 'Three different places',
    where: [
      'Cloudbite files (remote storage) hold the saved original. A file counts as saved only after the server verifies its size and checksum.',
      'Download puts a separate copy on this device. Changes to that copy are not sent back.',
      'The cloud computer cache is the copy on your cloud computer\'s own disk, shown per file. Opening files directly on the cloud computer comes later.',
    ],
    listTitle: 'Files', refresh: 'Refresh', up: 'Up one folder', home: 'My files', pathLabel: 'Folder', listNone: 'This folder is empty.',
    listFailed: 'Could not refresh the list.', more: 'Show more', moreLoading: 'Loading more…', capped: (n: number) => `Showing the first ${n} items.`,
    folderGone: 'This folder no longer exists. Go up or back to My files.',
    kind: { file: 'File', dir: 'Folder' } as Record<Kind, string>,
    state: { remote: 'Remote only', local: 'Copy on cloud computer', dirty: 'Changed on cloud computer — not uploaded yet' } as Record<LocalState, string>,
    pinned: 'Kept on cloud computer', noContent: 'No content uploaded yet', version: (n: number) => `version ${n}`,
    openFolder: (n: string) => `Open folder ${n}`, details: 'Details',
    download: 'Download to this device', opening: 'Preparing…', dlStarted: (n: string, s: string) => `Downloading ${n} (${s}) to this device as a separate copy. Edits to it are not saved back.`,
    dlFallback: 'Download did not start? Save the file', dlNone: 'This file has no saved content to download yet.', dlFailed: 'Could not prepare the download.',
    pin: 'Keep on cloud computer', unpin: 'Stop keeping on cloud computer', pinning: 'Saving…',
    pinOk: 'Kept. The cloud computer will not free this file to save space.', unpinOk: 'No longer kept. Once its copy is verified as saved it may be freed to save space.',
    rename: 'Rename', renameLabel: 'New name', save: 'Save name', saving: 'Saving…', cancel: 'Cancel', renameOk: 'Renamed.',
    nameHint: 'Up to 255 bytes. Not allowed: / \\, control characters, a trailing dot or space, "." or "..". Names are compared ignoring case.',
    nameBad: 'That name is not allowed here.', nameSame: 'That is already its name.',
    addTitle: 'Add', folderLabel: 'New folder name', mkdir: 'Create folder', mkdirOk: (n: string) => `Folder ${n} created.`,
    uploadTitle: 'Upload a file', uploadLimit: 'Up to 32 MiB per file for now. Larger transfers come later.', uploadLimitAt: (s: string) => `Up to ${s} per file for now. Larger transfers come later.`,
    fileLabel: 'File from this device', saveAsLabel: 'Save as', upload: 'Upload', uploadNeeds: 'Choose a file first.',
    tooBig: (s: string, m: string) => `This file is ${s}. Uploads here are limited to ${m} per file for now.`,
    uploadOff: 'Uploads are off until file storage is configured.',
    hashing: 'Reading and checksumming the file…', readFailed: 'Could not read the file. Nothing was sent.', fileChanged: 'The file changed while it was being read. Nothing was sent; choose it again.',
    noCrypto: 'This browser cannot checksum files here, so nothing was sent.',
    steps: { create: 'Creating the file entry…', begin: 'Reserving space…', body: 'Sending the file…', commit: 'Verifying and saving…' } as Record<Step, string>,
    uploadTo: (n: string, w: string) => `${n} → ${w}`,
    upUncertain: 'No definite answer from the server. Continue checks what the server already recorded and repeats the same requests with the same IDs, so nothing is uploaded twice.',
    upContinue: 'Continue same upload', upFailed: (c: string) => `Upload not saved: ${c}`,
    upMismatch: 'The server reported a different size or checksum, so this upload is not counted as saved.',
    upAborted: 'The server ended this upload before it was saved (expired or cancelled). Nothing new was saved; Forget it and choose the file again.',
    upOk: (n: string) => `Saved ${n}. The server verified its size and checksum.`,
    upConflict: (n: string) => `${n} was changed by someone else first. Your upload was kept as a separate conflict copy in the same folder; nothing was overwritten.`,
    upForgot: 'Forgotten on this page. Anything the server already recorded stays; refresh to see it.',
    uncertain: 'No definite answer from the server. Retry sends the same request with the same ID, so it will not happen twice.',
    retrySame: 'Retry same request', forget: 'Forget it', forgot: 'Forgotten. Refresh to see what the server recorded.',
    pendingOp: (l: string) => `Not confirmed: ${l}`, opMkdir: (n: string) => `create folder ${n}`, opRename: (n: string) => `rename to ${n}`,
    opPin: (n: string) => `keep ${n} on cloud computer`, opUnpin: (n: string) => `stop keeping ${n}`,
    codes: {
      name_conflict: 'Another item in this folder already uses that name (case is ignored).',
      invalid_name: 'The server refused that name.',
      stale_revision: 'This item changed since the list loaded. The list was refreshed; check it and try again.',
      not_found: 'That item no longer exists. The list was refreshed.',
      too_large: 'The file is larger than the server allows.',
      quota_exceeded: 'Your storage space is full.',
      too_many_children: 'This folder has too many items.',
      depth_exceeded: 'Folders cannot be nested that deep.',
      too_many_uploads: 'Too many unfinished uploads. Wait for them to finish or expire.',
      stale_writer: 'Another computer became the writer for these files, so this upload was refused. Nothing was saved.',
      hash_mismatch: 'The server received different content than this file. Nothing was saved.',
      size_mismatch: 'The server received a different size than this file. Nothing was saved.',
      store_not_configured: 'File storage is not configured. Nothing was stored.',
      request_conflict: 'This request ID was already used for a different change. Nothing new happened.',
      invalid_upload_state: 'The upload is no longer in a state that can continue.',
      not_verified: 'The server could not verify this yet.',
    } as Record<string, string>,
    bytes: ['B', 'KiB', 'MiB', 'GiB', 'TiB'],
  },
  ko: {
    title: 'Cloudbite — 파일', brand: 'Cloudbite', sub: '파일', back: '클라우드 컴퓨터',
    h1: '내 파일', lead: '클라우드 파일은 내용을 내려받지 않고 목록만 보여 줍니다. 내용은 내려받기나 올리기를 누를 때만 오갑니다.',
    loading: '불러오는 중…', loadFailed: '파일을 불러오지 못했습니다.', odd: '서버가 예상과 다른 형태로 답했습니다.', retryLoad: '다시 시도',
    netErr: '네트워크 오류 — 확인된 것이 없습니다.', rejected: (c: string) => `거부됨: ${c}`,
    signedOut: '클라우드 컴퓨터에 로그인되어 있지 않습니다. 클라우드 컴퓨터 페이지에서 로그인한 뒤 돌아오세요.', signInLink: '클라우드 컴퓨터 페이지에서 로그인',
    checkAgain: '다시 확인',
    notConfigured: '이 Cloudbite 에는 아직 파일 저장소가 설정되지 않았습니다. 저장된 것이 없고 파일 목록도 볼 수 없습니다.',
    blobsMissing: '파일 내용 저장소가 설정되지 않았습니다. 이름은 볼 수 있지만 내려받기와 올리기는 꺼져 있습니다.',
    storeTitle: '저장소', sConnected: '연결됨', sConfigured: '설정됨', sUnread: '설정됨 — 목록 못 읽음', sNotConfigured: '설정 안 됨', sCatalog: '파일 목록', sBlobs: '파일 내용',
    sUsed: '사용량', sUsedOf: (u: string, q: string) => `${q} 중 ${u}`, sPending: '끝나지 않은 올리기', sDirty: '클라우드 컴퓨터에서 바뀌었고 아직 올리지 않음', sPinned: '클라우드 컴퓨터에 항상 보관',
    whereTitle: '서로 다른 세 곳',
    where: [
      'Cloudbite 파일(원격 저장소)은 저장된 원본입니다. 서버가 크기와 체크섬을 확인한 뒤에만 저장된 것으로 칩니다.',
      '내려받기는 이 기기에 별도의 사본을 만듭니다. 그 사본을 고쳐도 다시 올라가지 않습니다.',
      '클라우드 컴퓨터 캐시는 클라우드 컴퓨터 디스크에 있는 사본이며 파일마다 표시합니다. 클라우드 컴퓨터에서 바로 여는 기능은 나중에 제공합니다.',
    ],
    listTitle: '파일', refresh: '새로 고침', up: '상위 폴더로', home: '내 파일', pathLabel: '폴더', listNone: '이 폴더는 비어 있습니다.',
    listFailed: '목록을 새로 고치지 못했습니다.', more: '더 보기', moreLoading: '더 불러오는 중…', capped: (n: number) => `처음 ${n}개 항목만 보여 줍니다.`,
    folderGone: '이 폴더는 더 이상 없습니다. 상위 폴더나 내 파일로 돌아가세요.',
    kind: { file: '파일', dir: '폴더' } as Record<Kind, string>,
    state: { remote: '원격에만 있음', local: '클라우드 컴퓨터에 사본 있음', dirty: '클라우드 컴퓨터에서 바뀜 — 아직 올리지 않음' } as Record<LocalState, string>,
    pinned: '클라우드 컴퓨터에 항상 보관', noContent: '아직 올린 내용 없음', version: (n: number) => `버전 ${n}`,
    openFolder: (n: string) => `${n} 폴더 열기`, details: '자세히',
    download: '이 기기로 내려받기', opening: '준비 중…', dlStarted: (n: string, s: string) => `${n} (${s}) 을(를) 이 기기에 별도 사본으로 내려받습니다. 이 사본을 고쳐도 다시 저장되지 않습니다.`,
    dlFallback: '내려받기가 시작되지 않았나요? 파일 저장', dlNone: '이 파일에는 아직 내려받을 저장된 내용이 없습니다.', dlFailed: '내려받기를 준비하지 못했습니다.',
    pin: '클라우드 컴퓨터에 항상 보관', unpin: '항상 보관 해제', pinning: '저장 중…',
    pinOk: '보관합니다. 클라우드 컴퓨터는 공간 확보를 위해 이 파일을 비우지 않습니다.', unpinOk: '보관을 해제했습니다. 사본이 저장된 것으로 확인되면 공간 확보를 위해 비울 수 있습니다.',
    rename: '이름 바꾸기', renameLabel: '새 이름', save: '이름 저장', saving: '저장 중…', cancel: '취소', renameOk: '이름을 바꿨습니다.',
    nameHint: '255바이트까지. 쓸 수 없는 것: / \\, 제어 문자, 끝의 점이나 공백, "." 또는 "..". 대소문자는 구분하지 않고 비교합니다.',
    nameBad: '여기에 쓸 수 없는 이름입니다.', nameSame: '이미 그 이름입니다.',
    addTitle: '추가', folderLabel: '새 폴더 이름', mkdir: '폴더 만들기', mkdirOk: (n: string) => `${n} 폴더를 만들었습니다.`,
    uploadTitle: '파일 올리기', uploadLimit: '지금은 파일당 32 MiB 까지입니다. 더 큰 전송은 나중에 제공합니다.', uploadLimitAt: (s: string) => `지금은 파일당 ${s} 까지입니다. 더 큰 전송은 나중에 제공합니다.`,
    fileLabel: '이 기기의 파일', saveAsLabel: '저장할 이름', upload: '올리기', uploadNeeds: '먼저 파일을 고르세요.',
    tooBig: (s: string, m: string) => `이 파일은 ${s} 입니다. 지금은 파일당 ${m} 까지만 올릴 수 있습니다.`,
    uploadOff: '파일 저장소가 설정될 때까지 올리기는 꺼져 있습니다.',
    hashing: '파일을 읽고 체크섬을 계산하는 중…', readFailed: '파일을 읽지 못했습니다. 아무것도 보내지 않았습니다.', fileChanged: '읽는 동안 파일이 바뀌었습니다. 아무것도 보내지 않았으니 다시 고르세요.',
    noCrypto: '이 브라우저는 여기서 체크섬을 계산할 수 없어 아무것도 보내지 않았습니다.',
    steps: { create: '파일 항목 만드는 중…', begin: '공간 예약 중…', body: '파일 보내는 중…', commit: '확인하고 저장하는 중…' } as Record<Step, string>,
    uploadTo: (n: string, w: string) => `${n} → ${w}`,
    upUncertain: '서버의 확실한 답이 없습니다. 이어 하기는 서버에 이미 기록된 것을 먼저 확인하고 같은 ID 의 같은 요청을 다시 보내므로 두 번 올라가지 않습니다.',
    upContinue: '같은 올리기 이어 하기', upFailed: (c: string) => `저장되지 않음: ${c}`,
    upMismatch: '서버가 다른 크기나 체크섬을 알려 와서 이 올리기는 저장된 것으로 치지 않습니다.',
    upAborted: '저장되기 전에 서버가 이 올리기를 끝냈습니다(만료 또는 취소). 새로 저장된 것은 없으니 잊기를 누르고 파일을 다시 고르세요.',
    upOk: (n: string) => `${n} 을(를) 저장했습니다. 서버가 크기와 체크섬을 확인했습니다.`,
    upConflict: (n: string) => `다른 곳에서 ${n} 을(를) 먼저 바꿨습니다. 올린 파일은 같은 폴더에 별도 충돌 사본으로 남겼고 아무것도 덮어쓰지 않았습니다.`,
    upForgot: '이 페이지에서 잊었습니다. 서버에 이미 기록된 것은 남아 있으니 새로 고침으로 확인하세요.',
    uncertain: '서버의 확실한 답이 없습니다. 다시 보내기는 같은 ID 의 같은 요청이라 두 번 일어나지 않습니다.',
    retrySame: '같은 요청 다시 보내기', forget: '잊기', forgot: '잊었습니다. 새로 고침으로 서버 기록을 확인하세요.',
    pendingOp: (l: string) => `확인 안 됨: ${l}`, opMkdir: (n: string) => `${n} 폴더 만들기`, opRename: (n: string) => `${n} 으로 이름 바꾸기`,
    opPin: (n: string) => `${n} 항상 보관`, opUnpin: (n: string) => `${n} 보관 해제`,
    codes: {
      name_conflict: '이 폴더에 같은 이름의 항목이 이미 있습니다(대소문자 무시).',
      invalid_name: '서버가 그 이름을 거부했습니다.',
      stale_revision: '목록을 불러온 뒤 이 항목이 바뀌었습니다. 목록을 새로 고쳤으니 확인하고 다시 시도하세요.',
      not_found: '그 항목은 더 이상 없습니다. 목록을 새로 고쳤습니다.',
      too_large: '서버가 허용하는 크기보다 큰 파일입니다.',
      quota_exceeded: '저장 공간이 가득 찼습니다.',
      too_many_children: '이 폴더의 항목이 너무 많습니다.',
      depth_exceeded: '폴더를 그렇게 깊게 만들 수 없습니다.',
      too_many_uploads: '끝나지 않은 올리기가 너무 많습니다. 끝나거나 만료될 때까지 기다리세요.',
      stale_writer: '다른 컴퓨터가 이 파일들의 쓰기 담당이 되어 이 올리기를 거부했습니다. 저장된 것은 없습니다.',
      hash_mismatch: '서버가 받은 내용이 이 파일과 다릅니다. 저장된 것은 없습니다.',
      size_mismatch: '서버가 받은 크기가 이 파일과 다릅니다. 저장된 것은 없습니다.',
      store_not_configured: '파일 저장소가 설정되지 않았습니다. 저장된 것은 없습니다.',
      request_conflict: '이 요청 ID 는 이미 다른 변경에 쓰였습니다. 새로 일어난 것은 없습니다.',
      invalid_upload_state: '이 올리기는 더 이어 갈 수 없는 상태입니다.',
      not_verified: '서버가 아직 확인하지 못했습니다.',
    } as Record<string, string>,
    bytes: ['B', 'KiB', 'MiB', 'GiB', 'TiB'],
  },
};
type Dict = typeof DICT.en;

// ───────────────────────── Helpers ─────────────────────────

function isObj(v: unknown): v is Record<string, unknown> { return typeof v === 'object' && v !== null && !Array.isArray(v); }
const str = (v: unknown, max = 200): string => (typeof v === 'string' ? v.slice(0, max) : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
const idOr = (v: unknown, re: RegExp): string | null => (typeof v === 'string' && re.test(v) ? v : null);
const utf8 = new TextEncoder();
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** The same rules the catalog enforces, so an obviously refused name is never sent */
function validName(raw: string): boolean {
  if (!raw || raw === '.' || raw === '..' || /[/\\]/.test(raw) || CONTROL.test(raw) || LONE_SURROGATE.test(raw) || /[. ]$/.test(raw)) return false;
  return utf8.encode(raw.normalize('NFC')).length <= NAME_BYTES_MAX;
}

function uuid(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  const b = new Uint8Array(16);
  if (!c || typeof c.getRandomValues !== 'function') throw new Error('no crypto');
  c.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const x = Array.from(b, v => v.toString(16).padStart(2, '0')).join('');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const subtle = (globalThis as { crypto?: Crypto }).crypto?.subtle;
  if (!subtle) throw new Error('no subtle');
  const d = new Uint8Array(await subtle.digest('SHA-256', bytes));
  return Array.from(d, v => v.toString(16).padStart(2, '0')).join('');
}

/** JSON bodies are passed already serialised, and upload bodies as the same ArrayBuffer, so a retry sends exactly the same bytes */
async function call(method: 'GET' | 'POST' | 'PUT', path: string, signal: AbortSignal, body?: string | ArrayBuffer): Promise<Reply> {
  let res: Response;
  try {
    const init: RequestInit = { method, credentials: 'same-origin', cache: 'no-store', signal };
    if (body !== undefined) {
      init.headers = { 'content-type': typeof body === 'string' ? 'application/json' : 'application/octet-stream' };
      init.body = body;
    }
    res = await fetch(path, init);
  } catch { return { ok: false, status: 0, code: '', retryable: true }; }
  let parsed: unknown = null;
  try { parsed = await res.json(); } catch { /* no body */ }
  if (res.ok && isObj(parsed) && (parsed.error === undefined || parsed.error === null)) return { ok: true, status: res.status, body: parsed };
  const e = isObj(parsed) && isObj(parsed.error) ? parsed.error : null;
  const c = e ? str(e.code, 64) : '';
  const code = SAFE_CODE.test(c) ? c : '';
  return { ok: false, status: res.ok ? 502 : res.status, code, retryable: (!!e && e.retryable === true) || RETRYABLE.includes(code) };
}
/** No answer, a server-side failure or a retryable refusal: the request may or may not have happened */
const uncertain = (r: Reply): boolean => !r.ok && (r.status === 0 || r.status === 408 || r.retryable || (r.status >= 500 && r.code !== 'store_not_configured'));
const authStatus = (s: number): boolean => s === 401 || s === 403;

function normalizeEntry(raw: unknown): Entry | null {
  if (!isObj(raw)) return null;
  const fileId = idOr(raw.fileId, FILE_ID), name = typeof raw.name === 'string' && raw.name.length <= 512 ? raw.name : '';
  const parentId = raw.parentId === ROOT ? ROOT : idOr(raw.parentId, FILE_ID);
  if (!fileId || !name || !parentId || (raw.kind !== 'file' && raw.kind !== 'dir')) return null;
  const currentVersion = raw.currentVersion === null ? null : idOr(raw.currentVersion, VERSION_ID);
  return {
    fileId, parentId, name, kind: raw.kind, size: num(raw.size), mtime: num(raw.mtime), currentVersion, versionSeq: Math.floor(num(raw.versionSeq)),
    pinned: raw.pinned === true, state: LOCAL_STATES.includes(raw.state as LocalState) ? raw.state as LocalState : 'remote', rev: Math.floor(num(raw.rev)),
  };
}

function normalizeStatus(raw: unknown): Status | null {
  if (!isObj(raw) || !isObj(raw.status)) return null;
  const s = raw.status;
  return {
    catalog: s.catalog === 'configured', blobs: s.blobs === 'configured', writerEpoch: Math.floor(num(s.writerEpoch)), usedBytes: num(s.usedBytes),
    quotaBytes: num(s.quotaBytes), maxFileBytes: num(s.maxFileBytes), pendingUploads: num(s.pendingUploads), dirtyFiles: num(s.dirtyFiles), pinnedFiles: num(s.pinnedFiles),
  };
}

function normalizeResult(raw: unknown): Result | null {
  if (!isObj(raw) || (raw.status !== 'committed' && raw.status !== 'conflict')) return null;
  const fileId = idOr(raw.fileId, FILE_ID), versionId = idOr(raw.versionId, VERSION_ID), sha256 = idOr(raw.sha256, SHA);
  if (!fileId || !versionId || !sha256 || typeof raw.size !== 'number') return null;
  return { status: raw.status, fileId, versionId, size: raw.size, sha256, conflictFileId: idOr(raw.conflictFileId, FILE_ID), durable: raw.durable === true };
}

function normalizeUpload(raw: unknown): Upload | null {
  if (!isObj(raw)) return null;
  const uploadId = idOr(raw.uploadId, UPLOAD_ID), fileId = idOr(raw.fileId, FILE_ID), sha256 = idOr(raw.sha256, SHA);
  if (!uploadId || !fileId || !sha256 || typeof raw.size !== 'number' || !PHASES.includes(raw.phase as Phase)) return null;
  return { uploadId, fileId, size: raw.size, sha256, phase: raw.phase as Phase, result: raw.result == null ? null : normalizeResult(raw.result) };
}

type Kid = Node | string | null | undefined | false;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', ...kids: Kid[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  for (const k of kids) if (k) el.append(k);
  return el;
}
function button(cls: string, onClick: () => void): HTMLButtonElement {
  const b = h('button', cls);
  b.setAttribute('type', 'button');
  b.addEventListener('click', onClick);
  return b;
}
function link(cls: string, href: string): HTMLAnchorElement {
  const a = h('a', cls);
  a.setAttribute('href', href);
  return a;
}
function showMsg(el: HTMLElement, m: Msg): void {
  el.hidden = !m;
  if (m) { el.textContent = m.text(); el.className = `cf-msg cf-${m.kind}`; }
}
function field(id: string, label: HTMLElement, input: HTMLInputElement, ...rest: Kid[]): HTMLDivElement {
  input.id = id; label.setAttribute('for', id);
  return h('div', 'cf-field', label, input, ...rest);
}
function textInput(): HTMLInputElement {
  const i = h('input', 'cf-input');
  for (const [k, v] of [['type', 'text'], ['autocomplete', 'off'], ['autocapitalize', 'none'], ['spellcheck', 'false']]) i.setAttribute(k, v);
  return i;
}

// ───────────────────────── App ─────────────────────────

function mount(root: HTMLElement): void {
  const params = new URLSearchParams(location.search);
  const qs = params.get('lang');
  let lang: Lang = qs === 'ko' || qs === 'en' ? qs : (navigator.language || '').toLowerCase().startsWith('ko') ? 'ko' : 'en';
  const T = (): Dict => DICT[lang] as Dict;

  const S = {
    auth: 'loading' as 'loading' | 'in' | 'out' | 'failed', loading: false, loadMsg: null as Msg,
    status: null as Status | null, path: [] as Dir[], entries: [] as Entry[], cursor: null as string | null, listed: false,
    listing: false, more: false, listMsg: null as Msg, listFail: false, gone: false, listVer: 0,
    sel: null as string | null, renaming: null as string | null, drafts: new Map<string, string>(), rowMsg: null as Msg,
    op: null as Op | null, opMsg: null as Msg, mkMsg: null as Msg,
    dl: null as { fileId: string; phase: 'sending' | 'ready' } | null, dlLink: null as { fileId: string; href: string; name: string; size: number } | null, dlMsg: null as Msg,
    pick: null as File | null, up: null as Up | null, upMsg: null as Msg, upBusy: false,
  };
  // gen is bumped on sign-out: every answer that arrives later is dropped and in-flight requests are aborted.
  // seq drops an older list answer that arrives after a newer one.
  let gen = 0, seq = 0, ac = new AbortController(), rowsKey = '';
  const cur = (): Dir => S.path[S.path.length - 1] || { id: ROOT, name: '' };
  const sel = (): Entry | null => S.entries.find(e => e.fileId === S.sel) || null;
  const maxUpload = (): number => Math.min(UPLOAD_MAX, S.status && S.status.maxFileBytes > 0 ? S.status.maxFileBytes : UPLOAD_MAX);
  const codeText = (c: string): string => T().codes[c] || T().rejected(c);
  /** The detail of a failed answer, worded in the language shown when it is drawn (known codes explained when asked) */
  const failText = (r: Reply, explain = false) => (): string =>
    (r.ok ? T().odd : r.status === 0 ? T().netErr : explain ? codeText(r.code || String(r.status)) : T().rejected(r.code || String(r.status)));

  // ── skeleton ──
  const brand = h('strong', 'cf-brand'), brandSub = h('span', 'cf-sub');
  const backLink = link('cf-nav-link', COMPUTER_PATH);
  const langNav = h('nav', 'cf-lang');
  const langBtns = (['en', 'ko'] as Lang[]).map(l => {
    const b = button('cf-lang-btn', () => { if (lang !== l) { lang = l; keepLang(); render(); } });
    b.textContent = l.toUpperCase(); b.setAttribute('lang', l);
    langNav.append(b);
    return b;
  });
  const header = h('header', 'cf-header', h('div', 'cf-brand-row', brand, brandSub), h('div', 'cf-header-side', backLink, langNav));
  const h1 = h('h1'), lead = h('p', 'cf-lead');

  const loadMsg = h('p', 'cf-msg');
  loadMsg.setAttribute('role', 'status');
  const signInLink = link('cf-btn cf-primary', COMPUTER_PATH);
  const checkBtn = button('cf-btn', () => { void refresh(); });
  const gate = h('section', 'cf-card', loadMsg, h('div', 'cf-actions', signInLink, checkBtn));

  // list
  const listTitle = h('h2');
  listTitle.setAttribute('tabindex', '-1');
  const refreshBtn = button('cf-btn cf-quiet', () => { void refresh(); });
  const upBtn = button('cf-btn', () => { go(S.path.slice(0, -1)); });
  const homeBtn = button('cf-btn cf-quiet', () => { go([]); });
  const pathLine = h('p', 'cf-path');
  const listMsg = h('p', 'cf-msg'), storeNote = h('p', 'cf-msg');
  listMsg.setAttribute('role', 'status');
  const opMsg = h('p', 'cf-msg');
  opMsg.setAttribute('role', 'status');
  const opRetry = button('cf-btn cf-primary', () => { if (S.op) void sendOp(S.op); });
  const opForget = button('cf-btn cf-quiet', () => { S.op = null; S.opMsg = { text: () => T().forgot, kind: 'info' }; render(); void listDir(false); });
  const opBox = h('div', 'cf-pending', opMsg, h('div', 'cf-actions', opRetry, opForget));
  const list = h('ul', 'cf-rows');
  const moreBtn = button('cf-btn cf-more', () => { void listDir(true); });
  const listCard = h('section', 'cf-card cf-list', h('div', 'cf-head', listTitle, refreshBtn),
    h('div', 'cf-toolbar', pathLine, h('div', 'cf-toolbar-btns', upBtn, homeBtn)), storeNote, listMsg, opBox, list, moreBtn);

  // selected file details: one panel, moved into the selected row
  const panelFacts = h('dl', 'cf-facts');
  const dlBtn = button('cf-btn cf-primary', () => { void openFile(); });
  const dlMsg = h('p', 'cf-msg');
  dlMsg.setAttribute('role', 'status');
  const dlLink = link('cf-text-link', '#');
  const pinBtn = button('cf-btn', () => { void togglePin(); });
  const renameBtn = button('cf-btn', () => { const e = sel(); if (!e) return; S.renaming = e.fileId; if (!S.drafts.has(e.fileId)) S.drafts.set(e.fileId, e.name); S.rowMsg = null; render(); });
  const renameLabel = h('label', 'cf-field-label'), renameIn = textInput(), renameHint = h('p', 'cf-fine');
  renameIn.setAttribute('maxlength', '255');
  renameIn.addEventListener('input', () => { if (S.sel) S.drafts.set(S.sel, renameIn.value); S.rowMsg = null; render(); });
  const renameSave = button('cf-btn cf-primary', () => { void rename(); });
  const renameCancel = button('cf-btn cf-quiet', () => { if (S.sel) S.drafts.delete(S.sel); S.renaming = null; S.rowMsg = null; render(); });
  const renameBox = h('div', 'cf-rename', field('cf-rename-name', renameLabel, renameIn, renameHint), h('div', 'cf-actions', renameSave, renameCancel));
  const rowMsg = h('p', 'cf-msg');
  rowMsg.setAttribute('role', 'status');
  const panel = h('div', 'cf-panel', panelFacts, dlMsg, dlLink, h('div', 'cf-actions', dlBtn, pinBtn, renameBtn), renameBox, rowMsg);

  // storage status
  const storeTitle = h('h2'), storeFacts = h('dl', 'cf-facts');
  const storeCard = h('section', 'cf-card', storeTitle, storeFacts);

  // add: new folder + upload
  const addTitle = h('h2');
  const mkLabel = h('label', 'cf-field-label'), mkIn = textInput();
  mkIn.setAttribute('maxlength', '255');
  mkIn.addEventListener('input', () => { S.mkMsg = null; render(); });
  const mkBtn = button('cf-btn', () => { void mkdir(); });
  const mkMsg = h('p', 'cf-msg');
  mkMsg.setAttribute('role', 'status');
  const upTitle = h('h3'), upLimit = h('p', 'cf-fine');
  const fileLabel = h('label', 'cf-field-label'), fileIn = h('input', 'cf-file');
  fileIn.setAttribute('type', 'file');
  fileIn.addEventListener('change', () => {
    if (S.up) return;
    const f = fileIn.files && fileIn.files[0] ? fileIn.files[0] : null;
    S.pick = f; S.upMsg = null;
    if (f) saveAsIn.value = f.name;
    render();
  });
  const saveAsLabel = h('label', 'cf-field-label'), saveAsIn = textInput();
  saveAsIn.setAttribute('maxlength', '255');
  saveAsIn.addEventListener('input', () => { S.upMsg = null; render(); });
  const uploadBtn = button('cf-btn cf-primary', () => { void startUpload(); });
  const upMsg = h('p', 'cf-msg');
  upMsg.setAttribute('role', 'status');
  const upRetry = button('cf-btn cf-primary', () => { const u = S.up; if (u) void runUpload(u, true); });
  const upForget = button('cf-btn cf-quiet', () => {
    S.up = null; S.pick = null; fileIn.value = ''; S.upMsg = { text: () => T().upForgot, kind: 'info' }; render(); void listDir(false);
  });
  const addCard = h('section', 'cf-card', addTitle,
    field('cf-folder-name', mkLabel, mkIn), mkMsg, h('div', 'cf-actions', mkBtn),
    h('div', 'cf-upload', upTitle, upLimit, field('cf-upload-file', fileLabel, fileIn), field('cf-upload-name', saveAsLabel, saveAsIn),
      upMsg, h('div', 'cf-actions', uploadBtn, upRetry, upForget)));

  const whereTitle = h('h2'), whereList = h('ol', 'cf-about');
  const whereCard = h('section', 'cf-card cf-note', whereTitle, whereList);

  const work = h('div', 'cf-grid', listCard, h('div', 'cf-stack', addCard, storeCard, whereCard));
  root.replaceChildren(header, h('main', 'cf-main', h1, lead, gate, work));

  /** The language lives only in ?lang= (no storage, no new history entry); if the address cannot change, the page still switches */
  function keepLang(): void {
    const g = globalThis as { history?: History };
    if (!g.history || typeof g.history.replaceState !== 'function') return;
    const q = new URLSearchParams(location.search || '');
    q.set('lang', lang);
    try { g.history.replaceState(g.history.state, '', `${location.pathname || ''}?${q.toString()}${location.hash || ''}`); } catch { /* text still switches */ }
  }

  // ── data ──
  async function refresh(): Promise<void> {
    const g = gen;
    S.loading = true; if (S.auth !== 'in') S.auth = 'loading'; render();
    const res = await call('GET', STATUS_API, ac.signal);
    if (g !== gen) return;
    S.loading = false;
    if (!res.ok && authStatus(res.status)) { signedOut(); return; }
    const st = res.ok ? normalizeStatus(res.body) : null;
    if (!st) {
      const inside = S.auth === 'in', detail = failText(res);
      const msg: Msg = { text: () => `${inside ? T().listFailed : T().loadFailed} ${detail()}`, kind: 'warn' };
      // signed in already: the rows shown so far stay, only marked as not refreshed
      if (inside) { S.listMsg = msg; S.listFail = true; } else { S.loadMsg = msg; S.auth = 'failed'; }
      render(); return;
    }
    S.status = st; S.auth = 'in'; S.loadMsg = null;
    if (!st.catalog) { S.entries = []; S.cursor = null; S.listed = false; S.listMsg = null; S.listVer++; render(); return; }
    render();
    await listDir(false);
  }

  async function listDir(append: boolean): Promise<void> {
    if (S.auth !== 'in' || !S.status?.catalog || (append && !S.cursor)) return;
    const g = gen, s = ++seq, parentId = cur().id, cursor = append ? S.cursor : null;
    S.listing = true; S.more = append; render();
    const q = `parentId=${encodeURIComponent(parentId)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}&limit=${PAGE_LIMIT}`;
    const res = await call('GET', `${API}?${q}`, ac.signal);
    if (g !== gen || s !== seq) return;
    S.listing = false; S.more = false;
    if (!res.ok && authStatus(res.status)) { signedOut(); return; }
    if (!res.ok && res.code === 'store_not_configured' && S.status) { S.status = { ...S.status, catalog: false }; S.entries = []; S.listVer++; render(); return; }
    if (!res.ok && res.code === 'not_found') { S.gone = true; S.entries = []; S.cursor = null; S.listed = true; S.listMsg = null; S.listFail = false; S.listVer++; render(); return; }
    const b = res.ok ? res.body : null;
    const next = b && (b.nextCursor === null || (typeof b.nextCursor === 'string' && b.nextCursor.length <= CURSOR_MAX)) ? b.nextCursor as string | null : undefined;
    if (!b || b.parentId !== parentId || !Array.isArray(b.entries) || next === undefined) {
      // a definite failure: rows already shown stay (not cleared, not marked loading); a first read shows only the failure
      const detail = failText(res);
      S.listMsg = { text: () => `${T().listFailed} ${detail()}`, kind: 'warn' }; S.listFail = true; render(); return;
    }
    const page = b.entries.slice(0, 200).map(normalizeEntry).filter((e): e is Entry => !!e && e.parentId === parentId);
    const base = append ? S.entries : [];
    const seen = new Set(base.map(e => e.fileId));
    S.entries = base.concat(page.filter(e => !seen.has(e.fileId))).slice(0, MAX_ENTRIES);
    S.cursor = S.entries.length >= MAX_ENTRIES ? null : next;
    S.listed = true; S.gone = false; S.listMsg = null; S.listFail = false; S.listVer++;
    if (S.sel && !S.entries.some(e => e.fileId === S.sel) && !append) { S.sel = null; S.renaming = null; }
    render();
  }

  function go(path: Dir[]): void {
    S.path = path; S.entries = []; S.cursor = null; S.listed = false; S.listFail = false; S.gone = false; S.sel = null; S.renaming = null; S.rowMsg = null; S.listMsg = null;
    S.dlLink = null; S.dlMsg = null; S.listVer++;
    render();
    if (typeof listTitle.focus === 'function') listTitle.focus();
    void listDir(false);
  }

  function select(e: Entry): void {
    if (e.kind === 'dir') { go(S.path.concat([{ id: e.fileId, name: e.name }])); return; }
    S.sel = S.sel === e.fileId ? null : e.fileId; S.renaming = null; S.rowMsg = null;
    if (S.dlLink && S.dlLink.fileId !== S.sel) { S.dlLink = null; S.dlMsg = null; }
    render();
  }

  // ── simple writes: one at a time, exact bytes on retry ──
  async function sendOp(op: Op): Promise<void> {
    if (S.auth !== 'in' || (S.op && (S.op !== op || op.phase === 'sending'))) return;
    op.phase = 'sending'; S.op = op; S.opMsg = null; render();
    const g = gen;
    const res = await call('POST', op.url, ac.signal, op.json);
    if (g !== gen || S.op !== op) return;
    if (!res.ok && authStatus(res.status)) { signedOut(); return; }
    if (!res.ok && uncertain(res)) { op.phase = 'uncertain'; S.opMsg = { text: () => `${T().pendingOp(op.label())} — ${T().uncertain}`, kind: 'warn' }; render(); return; }
    S.op = null;
    const entry = res.ok ? normalizeEntry(res.body.entry) : null;
    const where: (m: Msg) => void = op.kind === 'mkdir' ? (m) => { S.mkMsg = m; } : (m) => { S.rowMsg = m; };
    if (!res.ok || !entry) {
      const c = res.ok ? '' : res.code || String(res.status);
      where({ text: () => (c ? codeText(c) : T().odd), kind: 'warn' });
      render(); void listDir(false); return;
    }
    if (op.kind === 'mkdir') {
      mkIn.value = '';
      S.mkMsg = { text: () => T().mkdirOk(entry.name), kind: 'ok' };
      render(); void listDir(false); return;
    }
    const i = S.entries.findIndex(e => e.fileId === entry.fileId);
    if (i >= 0) { S.entries = S.entries.slice(); S.entries[i] = entry; S.listVer++; }
    if (op.kind === 'rename') { S.drafts.delete(entry.fileId); if (S.renaming === entry.fileId) S.renaming = null; S.rowMsg = { text: () => T().renameOk, kind: 'ok' }; }
    else S.rowMsg = { text: () => (entry.pinned ? T().pinOk : T().unpinOk), kind: 'ok' };
    render();
  }

  function mkdir(): void {
    const name = mkIn.value;
    if (S.op || S.auth !== 'in' || !S.status?.catalog) return;
    if (!validName(name)) { S.mkMsg = { text: () => T().nameBad, kind: 'warn' }; render(); return; }
    const n = name.normalize('NFC'), requestId = uuid();
    void sendOp({ kind: 'mkdir', url: CREATE_API, json: JSON.stringify({ requestId, parentId: cur().id, name: n, kind: 'dir' }), phase: 'sending', key: '', label: () => T().opMkdir(n) });
  }

  function rename(): void {
    const e = sel();
    if (S.op || S.auth !== 'in' || !e) return;
    const name = S.drafts.get(e.fileId) ?? e.name;
    if (!validName(name)) { S.rowMsg = { text: () => T().nameBad, kind: 'warn' }; render(); return; }
    const n = name.normalize('NFC');
    if (n === e.name) { S.rowMsg = { text: () => T().nameSame, kind: 'info' }; render(); return; }
    const requestId = uuid();
    void sendOp({ kind: 'rename', url: RENAME_API, json: JSON.stringify({ requestId, fileId: e.fileId, expectedRev: e.rev, name: n }), phase: 'sending', key: e.fileId,
      label: () => T().opRename(n) });
  }

  function togglePin(): void {
    const e = sel();
    if (S.op || S.auth !== 'in' || !e) return;
    const pinned = !e.pinned, name = e.name, requestId = uuid();
    void sendOp({ kind: 'pin', url: PIN_API, json: JSON.stringify({ requestId, fileId: e.fileId, pinned }), phase: 'sending', key: e.fileId,
      label: () => (pinned ? T().opPin(name) : T().opUnpin(name)) });
  }

  // ── explicit download: descriptor first, then one same-origin content link ──
  async function openFile(): Promise<void> {
    const e = sel();
    if (S.dl?.phase === 'sending' || S.auth !== 'in' || !e || e.kind !== 'file' || !S.status?.blobs) return;
    if (!e.currentVersion) { S.dlMsg = { text: () => T().dlNone, kind: 'info' }; render(); return; }
    const fileId = e.fileId, versionId = e.currentVersion;
    S.dl = { fileId, phase: 'sending' }; S.dlLink = null; S.dlMsg = null; render();
    const g = gen;
    const res = await call('POST', OPEN_API, ac.signal, JSON.stringify({ fileId, versionId }));
    if (g !== gen || S.dl?.fileId !== fileId) return;
    S.dl = null;
    if (!res.ok && authStatus(res.status)) { signedOut(); return; }
    const d = res.ok && isObj(res.body.descriptor) ? res.body.descriptor : null;
    const vid = d ? idOr(d.versionId, VERSION_ID) : null;
    if (!d || d.fileId !== fileId || vid !== versionId || typeof d.size !== 'number') {
      const detail = failText(res, true);
      S.dlMsg = { text: () => `${T().dlFailed} ${detail()}`, kind: 'warn' }; render(); return;
    }
    const name = typeof d.name === 'string' && d.name ? d.name : e.name, size = d.size;
    S.dlLink = { fileId, href: `${API}/content/${encodeURIComponent(fileId)}?versionId=${encodeURIComponent(vid)}`, name, size };
    S.dlMsg = { text: () => T().dlStarted(name, bytes(size)), kind: 'ok' };
    render();
    // the explicit press above is the intent; the same link stays visible in case the browser blocks this activation
    dlLink.click();
  }

  // ── upload: hash locally, then create → begin → body → commit with immutable IDs ──
  async function startUpload(): Promise<void> {
    if (S.up || S.upBusy || S.auth !== 'in' || !canUpload()) return;
    const file = S.pick, name = saveAsIn.value;
    if (!file) { S.upMsg = { text: () => T().uploadNeeds, kind: 'info' }; render(); return; }
    if (!validName(name)) { S.upMsg = { text: () => T().nameBad, kind: 'warn' }; render(); return; }
    const limit = maxUpload();
    if (file.size > limit) { S.upMsg = { text: () => T().tooBig(bytes(file.size), bytes(limit)), kind: 'warn' }; render(); return; }
    S.upBusy = true; S.upMsg = { text: () => T().hashing, kind: 'info' }; render();
    const g = gen;
    let buf: ArrayBuffer, sha: string;
    try { buf = await file.arrayBuffer(); } catch { S.upBusy = false; S.upMsg = { text: () => T().readFailed, kind: 'warn' }; render(); return; }
    if (buf.byteLength !== file.size || buf.byteLength > limit) { S.upBusy = false; S.upMsg = { text: () => T().fileChanged, kind: 'warn' }; render(); return; }
    try { sha = await sha256Hex(buf); } catch { S.upBusy = false; S.upMsg = { text: () => T().noCrypto, kind: 'warn' }; render(); return; }
    S.upBusy = false;
    const st = S.status;
    if (g !== gen || S.auth !== 'in' || !st || !canUpload()) { S.upMsg = null; render(); return; }
    const n = name.normalize('NFC'), parentId = cur().id;
    const up: Up = {
      name: n, size: buf.byteLength, sha, bytes: buf, parentId, dirs: S.path.slice(), writerEpoch: st.writerEpoch,
      createJson: JSON.stringify({ requestId: uuid(), parentId, name: n, kind: 'file' }), beginId: uuid(), beginJson: null, fileId: null, uploadId: null,
      step: 'create', phase: 'sending', code: '',
    };
    S.up = up; S.upMsg = null;
    await runUpload(up, false);
  }

  async function runUpload(up: Up, resume: boolean): Promise<void> {
    if (S.auth !== 'in' || S.up !== up || (resume && up.phase !== 'uncertain')) return;
    up.phase = 'sending'; up.code = ''; S.upMsg = null; render();
    const g = gen;
    const live = (): boolean => g === gen && S.up === up;
    const stop = (r: Reply): void => {
      if (!live() || r.ok) return;
      if (authStatus(r.status)) { signedOut(); return; }
      if (uncertain(r)) up.phase = 'uncertain'; else { up.phase = 'failed'; up.code = r.code || String(r.status); }
      render();
    };
    const fail = (code: string): void => { up.phase = 'failed'; up.code = code; render(); };
    // after a lost answer, first read what the server already has for this upload
    let check = resume && !!up.uploadId && (up.step === 'body' || up.step === 'commit');
    for (;;) {
      if (!live()) return;
      if (check && up.uploadId) {
        check = false;
        const r = await call('GET', `${API}/uploads/${encodeURIComponent(up.uploadId)}`, ac.signal);
        if (!live()) return;
        if (!r.ok) { stop(r); return; }
        const u = normalizeUpload(r.body.upload);
        if (!u || !same(u, up)) { fail('mismatch'); return; }
        if (u.phase === 'aborted') { fail('aborted'); return; }
        if (u.phase === 'committed' || u.phase === 'conflict') { if (u.result) finish(up, u.result); else { up.phase = 'uncertain'; render(); } return; }
        up.step = u.phase === 'body_written' ? 'commit' : 'body';
        continue;
      }
      render();
      if (up.step === 'create') {
        const r = await call('POST', CREATE_API, ac.signal, up.createJson);
        if (!live()) return;
        if (!r.ok) { stop(r); return; }
        const e = normalizeEntry(r.body.entry);
        if (!e || e.kind !== 'file' || e.parentId !== up.parentId) { fail('odd'); return; }
        up.fileId = e.fileId;
        up.beginJson = JSON.stringify({ requestId: up.beginId, fileId: e.fileId, baseVersion: null, writerEpoch: up.writerEpoch, size: up.size, sha256: up.sha });
        up.step = 'begin';
      } else if (up.step === 'begin' && up.beginJson) {
        const r = await call('POST', BEGIN_API, ac.signal, up.beginJson);
        if (!live()) return;
        if (!r.ok) { stop(r); return; }
        const u = normalizeUpload(r.body.upload);
        if (!u || u.fileId !== up.fileId || u.size !== up.size || u.sha256 !== up.sha) { fail('mismatch'); return; }
        up.uploadId = u.uploadId;
        if (u.phase === 'committed' || u.phase === 'conflict') { if (u.result) { finish(up, u.result); return; } check = true; continue; }
        if (u.phase === 'aborted') { fail('aborted'); return; }
        up.step = u.phase === 'body_written' ? 'commit' : 'body';
      } else if (up.step === 'body' && up.uploadId) {
        const r = await call('PUT', `${API}/uploads/${encodeURIComponent(up.uploadId)}/body`, ac.signal, up.bytes);
        if (!live()) return;
        if (!r.ok) { stop(r); return; }
        const u = normalizeUpload(r.body.upload);
        if (!u || !same(u, up)) { fail('mismatch'); return; }
        if (u.phase === 'begun') { up.phase = 'uncertain'; render(); return; }
        if (u.phase === 'aborted') { fail('aborted'); return; }
        up.step = 'commit';
      } else if (up.step === 'commit' && up.uploadId) {
        const r = await call('POST', `${API}/uploads/${encodeURIComponent(up.uploadId)}/commit`, ac.signal, JSON.stringify({ uploadId: up.uploadId }));
        if (!live()) return;
        if (!r.ok) { stop(r); return; }
        const res = normalizeResult(r.body.result);
        if (!res) { fail('odd'); return; }
        finish(up, res); return;
      } else { fail('odd'); return; }
    }
  }
  const same = (u: Upload, up: Up): boolean => u.uploadId === up.uploadId && u.fileId === up.fileId && u.size === up.size && u.sha256 === up.sha;

  /** Only a durable committed result with the local size and checksum is a save; a conflict is explained, never counted */
  function finish(up: Up, r: Result): void {
    if (r.fileId !== up.fileId || r.size !== up.size || r.sha256 !== up.sha) { up.phase = 'failed'; up.code = 'mismatch'; render(); return; }
    if (!r.durable) { up.phase = 'uncertain'; render(); return; }
    const n = up.name;
    S.up = null; S.pick = null; fileIn.value = ''; saveAsIn.value = '';
    S.upMsg = r.status === 'committed' ? { text: () => T().upOk(n), kind: 'ok' } : { text: () => T().upConflict(n), kind: 'warn' };
    render();
    if (up.parentId === cur().id) void listDir(false);
  }

  // Sign-out (any 401/403): abort everything in flight and drop the listing. The folder, selection, drafts and pending
  // writes stay in memory (an in-flight write becomes unconfirmed) so that, signed in again, Retry repeats the same request.
  function signedOut(): void {
    gen++; ac.abort(); ac = new AbortController();
    if (S.op?.phase === 'sending') S.op.phase = 'uncertain';
    if (S.up?.phase === 'sending') S.up.phase = 'uncertain';
    Object.assign(S, { auth: 'out', loading: false, loadMsg: null, status: null, entries: [], cursor: null, listed: false, listing: false, more: false, listMsg: null, listFail: false, dl: null, dlLink: null, dlMsg: null, upBusy: false });
    S.listVer++;
    render();
  }

  // no polling; a tab that becomes visible again re-reads once (never while hidden)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && S.auth === 'in' && !S.loading && !S.listing) void refresh();
  });

  const canUpload = (): boolean => !!S.status && S.status.catalog && S.status.blobs;

  // ── render ──
  const nf = (): Intl.NumberFormat => new Intl.NumberFormat(lang);
  function bytes(n: number): string {
    const u = T().bytes;
    let v = n, i = 0;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    const s = new Intl.NumberFormat(lang, { maximumFractionDigits: i === 0 || v >= 10 ? 0 : 1 }).format(v);
    return `${s} ${u[i]}`;
  }
  const when = (ms: number): string => (ms > 0 ? new Date(ms).toLocaleString(lang) : '');
  function pathText(dirs: Dir[] = S.path): string { return [T().home].concat(dirs.map(d => d.name)).join(' / '); }
  function fact(dl: HTMLElement, k: string, v: string): void { dl.append(h('dt', '', k), h('dd', '', v)); }

  function render(): void {
    const d = T();
    document.documentElement.lang = lang; document.title = d.title;
    brand.textContent = d.brand; brandSub.textContent = d.sub;
    backLink.textContent = d.back; backLink.setAttribute('href', `${COMPUTER_PATH}?lang=${lang}`);
    langNav.setAttribute('aria-label', 'Language');
    for (const b of langBtns) b.setAttribute('aria-pressed', String(b.getAttribute('lang') === lang));
    h1.textContent = d.h1; lead.textContent = d.lead;

    const inside = S.auth === 'in' && !!S.status;
    gate.hidden = inside; work.hidden = !inside;
    showMsg(loadMsg, S.auth === 'out' ? { text: () => T().signedOut, kind: 'info' } : S.auth === 'failed' ? S.loadMsg : { text: () => T().loading, kind: 'info' });
    signInLink.textContent = d.signInLink; signInLink.setAttribute('href', `${COMPUTER_PATH}?lang=${lang}`);
    signInLink.hidden = S.auth !== 'out';
    checkBtn.textContent = S.auth === 'out' ? d.checkAgain : d.retryLoad;
    checkBtn.hidden = S.auth === 'loading'; checkBtn.disabled = S.loading;
    if (!inside || !S.status) return;
    const st = S.status;

    // storage
    storeTitle.textContent = d.storeTitle;
    storeFacts.replaceChildren();
    // configured is not connected: the list counts as connected only after its last read succeeded; contents are never read here
    fact(storeFacts, d.sCatalog, !st.catalog ? d.sNotConfigured : S.listed && !S.listFail ? d.sConnected : S.listFail ? d.sUnread : d.sConfigured);
    fact(storeFacts, d.sBlobs, st.blobs ? d.sConfigured : d.sNotConfigured);
    if (st.catalog) {
      fact(storeFacts, d.sUsed, st.quotaBytes > 0 ? d.sUsedOf(bytes(st.usedBytes), bytes(st.quotaBytes)) : bytes(st.usedBytes));
      fact(storeFacts, d.sPending, nf().format(st.pendingUploads));
      fact(storeFacts, d.sDirty, nf().format(st.dirtyFiles));
      fact(storeFacts, d.sPinned, nf().format(st.pinnedFiles));
    }
    showMsg(storeNote, !st.catalog ? { text: () => T().notConfigured, kind: 'warn' } : !st.blobs ? { text: () => T().blobsMissing, kind: 'info' } : null);
    whereTitle.textContent = d.whereTitle;
    whereList.replaceChildren(...d.where.map(t => h('li', '', t)));

    // list
    listTitle.textContent = d.listTitle;
    refreshBtn.textContent = d.refresh; refreshBtn.setAttribute('aria-busy', String(S.loading || S.listing)); refreshBtn.disabled = S.loading;
    pathLine.replaceChildren(h('span', 'cf-path-label', `${d.pathLabel}: `), h('bdi', '', pathText()));
    upBtn.textContent = d.up; upBtn.hidden = !S.path.length;
    homeBtn.textContent = d.home; homeBtn.hidden = S.path.length < 2;
    showMsg(listMsg, S.listMsg || (S.gone ? { text: () => T().folderGone, kind: 'warn' } : null));
    opBox.hidden = S.op?.phase !== 'uncertain';
    showMsg(opMsg, S.opMsg);
    opRetry.textContent = d.retrySame; opForget.textContent = d.forget;
    list.hidden = !st.catalog;
    moreBtn.hidden = !st.catalog || !S.cursor;
    moreBtn.textContent = S.more ? d.moreLoading : d.more; moreBtn.disabled = S.listing;

    const key = `${lang}|${S.listVer}|${S.sel}|${st.catalog}|${S.listed}|${S.listFail}`;
    if (key !== rowsKey) {
      rowsKey = key;
      const rows = S.entries.map(row);
      // empty only after a successful read; loading only while no read has finished; a failed first read shows just its message
      if (!rows.length && S.listed && !S.listFail && !S.gone) rows.push(h('li', 'cf-empty', d.listNone));
      if (!rows.length && !S.listed && !S.listFail && st.catalog) rows.push(h('li', 'cf-empty', d.loading));
      if (S.entries.length >= MAX_ENTRIES) rows.push(h('li', 'cf-empty', d.capped(MAX_ENTRIES)));
      list.replaceChildren(...rows);
    }
    renderPanel(d);

    // add
    addTitle.textContent = d.addTitle;
    mkLabel.textContent = d.folderLabel;
    mkIn.disabled = !!S.op;
    mkBtn.textContent = S.op?.kind === 'mkdir' && S.op.phase === 'sending' ? d.saving : d.mkdir;
    mkBtn.disabled = !!S.op || !st.catalog || !mkIn.value;
    showMsg(mkMsg, S.mkMsg);

    upTitle.textContent = d.uploadTitle;
    upLimit.textContent = maxUpload() === UPLOAD_MAX ? d.uploadLimit : d.uploadLimitAt(bytes(maxUpload()));
    fileLabel.textContent = d.fileLabel; saveAsLabel.textContent = d.saveAsLabel;
    const up = S.up, locked = !!up || S.upBusy;
    fileIn.disabled = locked || !canUpload(); saveAsIn.disabled = locked || !canUpload();
    uploadBtn.textContent = up?.phase === 'sending' || S.upBusy ? d.saving : d.upload;
    uploadBtn.hidden = !!up && up.phase !== 'sending';
    const tooBig = !!S.pick && S.pick.size > maxUpload();
    uploadBtn.disabled = locked || !canUpload() || !S.pick || !saveAsIn.value || tooBig;
    upRetry.textContent = d.upContinue; upRetry.hidden = up?.phase !== 'uncertain';
    upForget.textContent = d.forget; upForget.hidden = !up || up.phase === 'sending';
    let um: Msg = S.upMsg;
    if (up) {
      const target = d.uploadTo(up.name, pathText(up.dirs));
      if (up.phase === 'sending') um = { text: () => `${target} · ${T().steps[up.step]}`, kind: 'info' };
      else if (up.phase === 'uncertain') um = { text: () => `${target} · ${T().upUncertain}`, kind: 'warn' };
      else um = { text: () => `${target} · ${up.code === 'mismatch' ? T().upMismatch : up.code === 'aborted' ? T().upAborted : up.code === 'odd' ? T().odd : T().upFailed(codeText(up.code))}`, kind: 'warn' };
    } else if (!um && !canUpload()) um = { text: () => T().uploadOff, kind: 'info' };
    else if (!um && tooBig && S.pick) { const f = S.pick; um = { text: () => T().tooBig(bytes(f.size), bytes(maxUpload())), kind: 'warn' }; }
    showMsg(upMsg, um);
  }

  function row(e: Entry): HTMLLIElement {
    const d = T();
    const isSel = e.fileId === S.sel;
    const main = button('cf-row-btn', () => { select(e); });
    const meta: string[] = [d.kind[e.kind]];
    if (e.kind === 'file') meta.push(e.currentVersion ? bytes(e.size) : d.noContent);
    if (e.mtime) meta.push(when(e.mtime));
    main.append(h('bdi', 'cf-name', e.name), h('span', 'cf-meta', meta.join(' · ')));
    if (e.kind === 'dir') main.setAttribute('aria-label', d.openFolder(e.name));
    else main.setAttribute('aria-expanded', String(isSel));
    const tags = h('span', 'cf-tags');
    if (e.kind === 'file') tags.append(h('span', `cf-pill cf-s-${e.state}`, d.state[e.state]));
    if (e.pinned) tags.append(h('span', 'cf-pill cf-s-pinned', d.pinned));
    if (tags.children.length) main.append(tags);
    const li = h('li', `cf-row cf-k-${e.kind}${isSel ? ' cf-sel' : ''}`, main);
    li.setAttribute('data-file', e.fileId);
    if (isSel) li.append(panel);
    return li;
  }

  function renderPanel(d: Dict): void {
    const e = sel();
    if (!e) { panel.remove(); return; }
    panelFacts.replaceChildren();
    fact(panelFacts, d.kind.file, e.currentVersion ? `${bytes(e.size)} · ${d.version(e.versionSeq)}` : d.noContent);
    fact(panelFacts, d.storeTitle, d.state[e.state] + (e.pinned ? ` · ${d.pinned}` : ''));
    const busy = !!S.op;
    dlBtn.textContent = S.dl?.phase === 'sending' ? d.opening : d.download;
    dlBtn.disabled = S.dl?.phase === 'sending' || !S.status?.blobs || !e.currentVersion;
    showMsg(dlMsg, S.dlMsg || (!e.currentVersion ? { text: () => T().dlNone, kind: 'info' } : null));
    const l = S.dlLink && S.dlLink.fileId === e.fileId ? S.dlLink : null;
    dlLink.hidden = !l;
    if (l) { dlLink.setAttribute('href', l.href); dlLink.setAttribute('download', l.name); dlLink.textContent = d.dlFallback; }
    pinBtn.textContent = S.op?.kind === 'pin' && S.op.key === e.fileId && S.op.phase === 'sending' ? d.pinning : e.pinned ? d.unpin : d.pin;
    pinBtn.disabled = busy;
    pinBtn.setAttribute('aria-pressed', String(e.pinned));
    const editing = S.renaming === e.fileId;
    renameBtn.textContent = d.rename; renameBtn.hidden = editing; renameBtn.disabled = busy;
    renameBox.hidden = !editing;
    renameLabel.textContent = d.renameLabel; renameHint.textContent = d.nameHint;
    const draft = S.drafts.get(e.fileId) ?? e.name;
    if (renameIn.value !== draft) renameIn.value = draft;
    renameIn.disabled = busy;
    renameSave.textContent = S.op?.kind === 'rename' && S.op.phase === 'sending' ? d.saving : d.save;
    renameSave.disabled = busy || !draft;
    renameCancel.textContent = d.cancel; renameCancel.disabled = busy;
    showMsg(rowMsg, S.rowMsg);
  }

  render();
  void refresh();
}

const rootEl = document.getElementById('cb-computer-files');
if (rootEl) mount(rootEl);

// Module scope for tsc only (keeps names out of the shared client global scope); the build strips this line.
export {};
