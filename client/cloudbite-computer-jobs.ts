// Cloudbite job runner (browser). tools/build-cloudbite-computer-jobs.mjs transforms this file (no bundling) into
// src/cloudbite-computer-jobs-page.ts → CLOUDBITE_COMPUTER_JOBS_JS, served same-origin at /cloudbite/computer/jobs.js
// for the page /cloudbite/computer/jobs (?lang=ko|en, optional ?sandboxId=&account= for a sandbox the server verifies).
// Sign-in stays on the main computer page (/cloudbite/computer): this page only uses the existing HttpOnly cookie, and a 401
// shows a link there. It never starts WebAuthn, reads storage or holds a token.
// The target (sandbox, GPU and country) comes only from GET /api/cloudbite/computer/jobs/context and is shown read-only.
// A job is created only by Review → Run: Review checks and locks the inputs; Run sends one POST whose requestId and exact body
// are kept in memory until the server gives a definite answer, so Retry repeats the same request and never makes a second job.
// Nothing runs from typing, loading or polling. Enter never submits (there is no form). The job list polls only while the tab
// is visible, signed in and a job is still active, with a backoff of at least 5 seconds.
// Everything is drawn with createElement/textContent. Text comes from DICT (EN/KO); server error codes are shown verbatim.

const API = '/api/cloudbite/computer';
const JOBS_API = `${API}/jobs`;
const NESTED_JOBS = `${API}/nested/jobs`;
const COMPUTER_PATH = '/cloudbite/computer';
const DEFAULT_IMAGE = 'python:3.12-slim';
const TIMEOUTS = [30, 60, 120, 300, 600];
const DEFAULT_TIMEOUT = 60;
const MIN_TIMEOUT = 10;
const MAX_TIMEOUT = 600;
// CPU worker size is fixed by the server (2 vCPU · 4 GiB RAM · 8 GiB disk)
const CPU_SPEC = { cpu: 2, memoryGiB: 4, diskGiB: 8 };
const MAX_FILES = 3;
const MAX_FILE_BYTES = 16384; // total decoded bytes of all files
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_ARGS = 64;
const MAX_ARG = 4096;
const MAX_COMMAND_BYTES = 16 * 1024;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_LOG_CHARS = 64 * 1024;
const IMAGE = /^[a-z0-9][a-z0-9._/-]{0,150}(?::[\w][\w.-]{0,63})?(?:@sha256:[0-9a-f]{64})?$/;
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/;
const SAFE_ID = /^[A-Za-z0-9._:-]{1,120}$/;
const SAFE_ACCOUNT = /^[A-Za-z0-9_-]{1,40}$/;
const SAFE_CODE = /^[a-z0-9_.-]{1,64}$/i;
const POLL_FIRST_MS = 5000;
const POLL_MAX_MS = 30000;
const POLL_MAX = 120;

type Provider = 'daytona' | 'nosana';
type JobStatus = 'creating' | 'queued' | 'running' | 'collecting' | 'uncertain' | 'succeeded' | 'failed' | 'timed_out' | 'stopped' | 'completed' | 'error';
const JOB_STATUSES: JobStatus[] = ['creating', 'queued', 'running', 'collecting', 'uncertain', 'succeeded', 'failed', 'timed_out', 'stopped', 'completed', 'error'];
const ACTIVE: JobStatus[] = ['creating', 'queued', 'running', 'collecting', 'uncertain'];
const STOPPABLE: JobStatus[] = ['creating', 'queued', 'running', 'uncertain'];
type Cleanup = 'none' | 'pending' | 'done' | 'failed' | 'unknown';
const CLEANUPS: Cleanup[] = ['none', 'pending', 'done', 'failed', 'unknown'];
type Ctx = {
  sandbox: { id: string; account: string; name: string; region: string };
  selection: { candidateId: string; gpu: string; country: string; market: string | null } | null;
  pricing: { cpuUsdPerHour: number; gpuBaseUsdPerHour: number | null; observedAt: string | null };
};
type Job = {
  id: string; provider: Provider; status: JobStatus; image: string; command: string[]; timeoutSec: number;
  createdAt: string | null; finishedAt: string | null; cleanup: Cleanup; error: string | null; providerState: string;
  gpu: string; country: string; note: string;
  result: { exitCode: number | null; timedOut: boolean; output: string; truncated: boolean } | null;
};
type UploadFile = { name: string; contentBase64: string; size: number };
// What Review froze: everything Run sends except the acknowledgements, plus what the review box shows
type Review = {
  ctxKey: string; provider: Provider; image: string; timeout: number; command: string[]; files: UploadFile[];
  sandboxId: string; account: string; target: string; usdPerHour: number | null; minutes: number;
};
type Op = { requestId: string; json: string; phase: 'sending' | 'uncertain' };
type Reply = { ok: true; status: number; body: unknown } | { ok: false; status: number; code: string };
type Lang = 'en' | 'ko';
type Msg = { text: () => string; kind: 'ok' | 'warn' | 'info' } | null;

// Friendly examples: they only fill the form; nothing runs until Review → Run
type Sample = { id: string; provider: Provider; image: string; command: string[]; label: { en: string; ko: string } };
const SAMPLES: Sample[] = [
  { id: 'gpu-info', provider: 'nosana', image: 'nvidia/cuda:12.4.1-base-ubuntu22.04', command: ['nvidia-smi'], label: { en: 'GPU info', ko: 'GPU 정보' } },
  { id: 'python-hello', provider: 'daytona', image: DEFAULT_IMAGE, command: ['python3', '-c', "print('hello from Cloudbite')"], label: { en: 'Python hello', ko: 'Python 인사' } },
];

// ───────────────────────── Text ─────────────────────────

const DICT = {
  en: {
    title: 'Cloudbite — Jobs', brand: 'Cloudbite', sub: 'Jobs', back: 'Cloud computer',
    h1: 'Run a job', lead: 'Run one bounded command in a fresh container — a CPU worker, or a rented GPU host. Nothing runs until you review it and press Run.',
    loading: 'Loading…', ctxFailed: 'Could not load the job target.', ctxOdd: 'The server answered in an unexpected way.', retryLoad: 'Try again',
    netErr: 'Network error — nothing was confirmed.', httpErr: (n: number) => `Server answered ${n}.`, rejected: (c: string) => `Rejected: ${c}`,
    signedOut: 'You are not signed in to your cloud computer. Sign in on the cloud computer page, then come back.', signInLink: 'Sign in on the cloud computer page',
    checkAgain: 'Check again',
    targetTitle: 'Target', targetLead: 'Set by the server for your signed-in computer. Change the GPU on the cloud computer page.',
    sandbox: 'Computer', region: 'Region', gpu: 'GPU', noGpu: 'No GPU chosen. GPU jobs need one: choose a GPU and country on the cloud computer page.',
    gpuLine: (g: string, c: string, _m: string) => `${g} · ${c}`,
    formTitle: 'Job', provider: 'Where it runs',
    providerOpt: { daytona: 'CPU worker (2 vCPU · 4 GiB RAM · 8 GiB disk)', nosana: 'GPU host (Nosana)' } as Record<Provider, string>,
    gpuNeedsChoice: 'GPU host — choose a GPU first',
    samples: 'Examples (fill the form only)', image: 'Container image', imageHint: (d: string) => `Leave empty for ${d}.`,
    imageBad: 'Use a plain container reference such as python:3.12-slim.',
    command: 'Command (JSON list of arguments)', commandHint: 'One JSON array of strings, e.g. ["python3", "-c", "print(1)"]. No shell: pipes, quotes and $VARS are not interpreted.',
    commandBad: (why: string) => `Command not valid: ${why}`,
    whyJson: 'it is not valid JSON', whyArray: 'it must be a JSON array of strings', whyCount: `use 1 to ${MAX_ARGS} arguments`,
    whyFirst: 'the first argument (the program) must not be empty', whyArg: `each argument must be text up to ${MAX_ARG} characters without control characters`,
    whyLong: 'the command is too long',
    timeout: 'Time limit', timeoutOpt: (s: number) => (s < 60 ? `${s} seconds` : `${s / 60} min`),
    files: 'Input files (optional)', filesHint: `Up to ${MAX_FILES} files, ${MAX_FILE_BYTES / 1024} KiB in total. They are placed in the job's empty working folder. Only files you pick are sent.`,
    filesNone: 'No files chosen.', filesClear: 'Remove files', filesReset: 'Files removed when switching to public GPU jobs. Choose them again if you want to publish them.', fileLine: (n: string, b: number) => `${n} — ${b} bytes`,
    fileTooMany: `Choose at most ${MAX_FILES} files.`, fileTooBig: `The files are larger than ${MAX_FILE_BYTES / 1024} KiB in total.`,
    fileBadName: (n: string) => `File name not allowed: ${n}. Use letters, digits, dot, dash or underscore, up to 64 characters.`,
    fileDup: (n: string) => `Two files are named ${n}.`, fileRead: 'A file could not be read. Choose it again.',
    publicWarn: 'GPU jobs are public: the image, the command and the input files are published in the Nosana job definition. Never put passwords, API keys or private data in them.',
    privateNote: 'CPU jobs run in a private worker under your provider account.',
    review: 'Review', reviewing: 'Checking…', edit: 'Edit', reviewTitle: 'Review before running',
    rTarget: 'Runs on', rImage: 'Image', rCommand: 'Command', rFiles: 'Files', rTimeout: 'Time limit', rCost: 'Estimated cost',
    rCpu: (s: string) => `CPU worker · ${CPU_SPEC.cpu} vCPU · ${CPU_SPEC.memoryGiB} GiB RAM · ${CPU_SPEC.diskGiB} GiB disk · ${s}`,
    rNone: 'none', rFilesVal: (n: number, b: number) => `${n} file(s), ${b} bytes`,
    cost: (usd: string, min: number, rate: string) => `Base estimate ${usd} (${min} min at ${rate}/h)`,
    costUnknown: 'unknown — the server has no current GPU price',
    costNote: 'CPU: time limit plus 2 minutes of start-up. GPU: a minimum 50-minute provider reservation, independent of the shorter command timeout. These are base estimates, not final bills; network fees are excluded. A GPU host is not reserved until execution and may not be found.',
    ackCost: 'I understand this job may cost money.', ackPublic: 'I understand the image, command and files are published and contain no secrets.',
    run: 'Run', running: 'Sending…', runOk: 'Job accepted. It counts as running only when the list below says so.',
    runUncertain: 'No definite answer from the server. Retry sends the same request with the same ID, so it will not run twice.',
    retrySame: 'Retry same request', forget: 'Forget it', forgot: 'Forgotten. If the job was created it appears in the list below.',
    stale: 'The target changed (computer, GPU or price). Review again.',
    jobsTitle: 'Your jobs', refresh: 'Refresh', jobsFailed: 'Could not load jobs.', jobsNone: 'No jobs yet.',
    pollPaused: 'Automatic refresh paused. Press Refresh to check again.',
    status: {
      creating: 'Creating — not running yet', queued: 'Queued — waiting for a host, not running yet', running: 'Running',
      collecting: 'Finished — collecting output', uncertain: 'Not confirmed — the provider did not confirm the job',
      succeeded: 'Succeeded', completed: 'Completed', failed: 'Failed', timed_out: 'Timed out', stopped: 'Stopped', error: 'Error',
    } as Record<JobStatus, string>,
    cleanup: { none: '', pending: 'Cleaning up provider resources', done: 'Cleaned up', failed: 'Cleanup failed', unknown: 'Cleanup not confirmed' } as Record<Cleanup, string>,
    kindCpu: 'CPU', kindGpu: 'GPU', providerSays: (s: string) => `Provider reports ${s}`, errorCode: (c: string) => `Error: ${c}`,
    exit: (c: string) => `Exit code ${c}`, exitUnknown: 'Exit code not reported', timedOut: 'Stopped at the time limit.',
    truncated: 'The output was cut to its last 64 KiB.', logShow: 'Show output', logHide: 'Hide output', logEmpty: '(no output)',
    download: 'Download output', stop: 'Stop', stopping: 'Stopping…', stopOk: 'Stop accepted.',
    stopUncertain: 'No definite answer to Stop. Retry sends the same stop request.', retryStop: 'Retry stop',
    created: (t: string) => `Started ${t}`, limit: (s: number) => `limit ${s} s`,
  },
  ko: {
    title: 'Cloudbite — 작업', brand: 'Cloudbite', sub: '작업', back: '클라우드 컴퓨터',
    h1: '작업 실행', lead: '새 컨테이너에서 제한 시간이 있는 명령 하나를 실행합니다 — CPU 워커나 빌린 GPU 호스트에서. 검토하고 실행을 누르기 전에는 아무것도 돌지 않습니다.',
    loading: '불러오는 중…', ctxFailed: '작업 대상을 불러오지 못했습니다.', ctxOdd: '서버가 예상과 다른 형태로 답했습니다.', retryLoad: '다시 시도',
    netErr: '네트워크 오류 — 확인된 것이 없습니다.', httpErr: (n: number) => `서버 응답 ${n}.`, rejected: (c: string) => `거부됨: ${c}`,
    signedOut: '클라우드 컴퓨터에 로그인되어 있지 않습니다. 클라우드 컴퓨터 페이지에서 로그인한 뒤 돌아오세요.', signInLink: '클라우드 컴퓨터 페이지에서 로그인',
    checkAgain: '다시 확인',
    targetTitle: '대상', targetLead: '로그인한 컴퓨터를 기준으로 서버가 정합니다. GPU 는 클라우드 컴퓨터 페이지에서 바꿉니다.',
    sandbox: '컴퓨터', region: '지역', gpu: 'GPU', noGpu: '선택한 GPU 가 없습니다. GPU 작업에는 필요합니다 — 클라우드 컴퓨터 페이지에서 GPU 와 국가를 고르세요.',
    gpuLine: (g: string, c: string, _m: string) => `${g} · ${c}`,
    formTitle: '작업', provider: '실행 위치',
    providerOpt: { daytona: 'CPU 워커 (2 vCPU · 4 GiB RAM · 8 GiB 디스크)', nosana: 'GPU 호스트 (Nosana)' } as Record<Provider, string>,
    gpuNeedsChoice: 'GPU 호스트 — 먼저 GPU 를 고르세요',
    samples: '예시 (양식만 채움)', image: '컨테이너 이미지', imageHint: (d: string) => `비워 두면 ${d} 입니다.`,
    imageBad: 'python:3.12-slim 같은 일반 컨테이너 이름을 쓰세요.',
    command: '명령 (인자의 JSON 목록)', commandHint: '문자열의 JSON 배열 하나, 예: ["python3", "-c", "print(1)"]. 셸이 없으므로 파이프·따옴표·$변수는 해석되지 않습니다.',
    commandBad: (why: string) => `명령이 올바르지 않습니다: ${why}`,
    whyJson: '올바른 JSON 이 아닙니다', whyArray: '문자열의 JSON 배열이어야 합니다', whyCount: `인자는 1~${MAX_ARGS}개여야 합니다`,
    whyFirst: '첫 인자(프로그램)는 비어 있으면 안 됩니다', whyArg: `각 인자는 제어 문자 없는 ${MAX_ARG}자 이하의 텍스트여야 합니다`,
    whyLong: '명령이 너무 깁니다',
    timeout: '제한 시간', timeoutOpt: (s: number) => (s < 60 ? `${s}초` : `${s / 60}분`),
    files: '입력 파일 (선택)', filesHint: `최대 ${MAX_FILES}개, 합계 ${MAX_FILE_BYTES / 1024} KiB. 작업의 빈 작업 폴더에 놓입니다. 직접 고른 파일만 보냅니다.`,
    filesNone: '선택한 파일이 없습니다.', filesClear: '파일 빼기', filesReset: '공개 GPU 작업으로 전환하여 첨부 파일을 비웠습니다. 공개할 파일은 다시 선택해 주세요.', fileLine: (n: string, b: number) => `${n} — ${b}바이트`,
    fileTooMany: `파일은 ${MAX_FILES}개까지 고를 수 있습니다.`, fileTooBig: `파일 합계가 ${MAX_FILE_BYTES / 1024} KiB 를 넘습니다.`,
    fileBadName: (n: string) => `허용되지 않는 파일 이름: ${n}. 영문·숫자·점·대시·밑줄로 64자까지 쓰세요.`,
    fileDup: (n: string) => `같은 이름의 파일이 둘 있습니다: ${n}`, fileRead: '파일을 읽지 못했습니다. 다시 고르세요.',
    publicWarn: 'GPU 작업은 공개됩니다: 이미지·명령·입력 파일이 Nosana 작업 정의에 공개로 실립니다. 비밀번호·API 키·개인 자료를 넣지 마세요.',
    privateNote: 'CPU 작업은 내 공급자 계정의 비공개 워커에서 돕니다.',
    review: '검토', reviewing: '확인 중…', edit: '수정', reviewTitle: '실행 전 검토',
    rTarget: '실행 위치', rImage: '이미지', rCommand: '명령', rFiles: '파일', rTimeout: '제한 시간', rCost: '예상 비용',
    rCpu: (s: string) => `CPU 워커 · ${CPU_SPEC.cpu} vCPU · ${CPU_SPEC.memoryGiB} GiB RAM · ${CPU_SPEC.diskGiB} GiB 디스크 · ${s}`,
    rNone: '없음', rFilesVal: (n: number, b: number) => `${n}개, ${b}바이트`,
    cost: (usd: string, min: number, rate: string) => `기본요금 추정 ${usd} (${min}분 × 시간당 ${rate})`,
    costUnknown: '알 수 없음 — 서버에 현재 GPU 가격이 없습니다',
    costNote: 'CPU는 제한 시간에 시작 준비 2분을 더해 추정합니다. GPU는 짧은 명령 제한 시간과 별개로 제공업체의 최소 50분 예약이 필요합니다. 기본요금 추정이며 최종 청구액이 아닙니다. 네트워크 수수료는 제외됩니다. GPU 호스트는 실행 시 예약하며 찾지 못할 수 있습니다.',
    ackCost: '이 작업에 비용이 들 수 있음을 이해합니다.', ackPublic: '이미지·명령·파일이 공개되며 비밀이 없음을 확인합니다.',
    run: '실행', running: '보내는 중…', runOk: '작업이 접수되었습니다. 아래 목록이 실행 중이라고 할 때만 실행 중입니다.',
    runUncertain: '서버의 확실한 답이 없습니다. 다시 보내기는 같은 ID 의 같은 요청이라 두 번 실행되지 않습니다.',
    retrySame: '같은 요청 다시 보내기', forget: '잊기', forgot: '잊었습니다. 작업이 만들어졌다면 아래 목록에 나옵니다.',
    stale: '대상(컴퓨터·GPU·가격)이 바뀌었습니다. 다시 검토하세요.',
    jobsTitle: '내 작업', refresh: '새로 고침', jobsFailed: '작업 목록을 불러오지 못했습니다.', jobsNone: '아직 작업이 없습니다.',
    pollPaused: '자동 새로 고침을 멈췄습니다. 새로 고침을 눌러 다시 확인하세요.',
    status: {
      creating: '만드는 중 — 아직 실행 전', queued: '대기 중 — 호스트를 기다리며 아직 실행 전', running: '실행 중',
      collecting: '끝남 — 출력 모으는 중', uncertain: '확인 안 됨 — 공급자가 작업을 확인하지 않았습니다',
      succeeded: '성공', completed: '완료', failed: '실패', timed_out: '시간 초과', stopped: '중지됨', error: '오류',
    } as Record<JobStatus, string>,
    cleanup: { none: '', pending: '공급자 자원 정리 중', done: '정리됨', failed: '정리 실패', unknown: '정리 확인 안 됨' } as Record<Cleanup, string>,
    kindCpu: 'CPU', kindGpu: 'GPU', providerSays: (s: string) => `공급자 보고: ${s}`, errorCode: (c: string) => `오류: ${c}`,
    exit: (c: string) => `종료 코드 ${c}`, exitUnknown: '종료 코드 보고 없음', timedOut: '제한 시간에 멈췄습니다.',
    truncated: '출력은 마지막 64 KiB 만 남겼습니다.', logShow: '출력 보기', logHide: '출력 숨기기', logEmpty: '(출력 없음)',
    download: '출력 내려받기', stop: '중지', stopping: '중지하는 중…', stopOk: '중지가 접수되었습니다.',
    stopUncertain: '중지에 대한 확실한 답이 없습니다. 다시 보내기는 같은 중지 요청입니다.', retryStop: '중지 다시 보내기',
    created: (t: string) => `시작 ${t}`, limit: (s: number) => `제한 ${s}초`,
  },
};
type Dict = typeof DICT.en;

// ───────────────────────── Helpers ─────────────────────────

function isObj(v: unknown): v is Record<string, unknown> { return typeof v === 'object' && v !== null && !Array.isArray(v); }
const str = (v: unknown, max = 200): string => (typeof v === 'string' ? v.slice(0, max) : '');
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
/** printable text only (no control characters) — server text is still drawn with textContent */
const plain = (v: unknown, max: number): string => str(v, max).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
const iso = (v: unknown): string | null => (typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v)) ? v : null);
const byteLen = (s: string): number => new TextEncoder().encode(s).byteLength;

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

function errorCode(body: unknown): string {
  if (!isObj(body)) return '';
  const e = body.error;
  if (isObj(e)) { const c = str(e.code, 64); return SAFE_CODE.test(c) ? c : ''; }
  const c = str(e, 64);
  return SAFE_CODE.test(c) ? c : '';
}

/** POST bodies are passed already serialised so a retry sends exactly the same bytes */
async function call(path: string, signal: AbortSignal, json?: string): Promise<Reply> {
  let res: Response;
  try {
    res = await fetch(path, json === undefined
      ? { method: 'GET', credentials: 'same-origin', cache: 'no-store', signal }
      : { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: json, signal });
  } catch { return { ok: false, status: 0, code: '' }; }
  let parsed: unknown = null;
  try { parsed = await res.json(); } catch { /* no body */ }
  if (res.ok && isObj(parsed) && parsed.ok === true && (parsed.error === undefined || parsed.error === null)) return { ok: true, status: res.status, body: parsed };
  return { ok: false, status: res.ok ? 502 : res.status, code: errorCode(parsed) };
}
/** No answer, a server-side failure or a throttle: the request may or may not have happened */
const uncertainStatus = (s: number): boolean => s === 0 || s === 408 || s === 429 || s >= 500;
const authStatus = (s: number): boolean => s === 401 || s === 403;

function normalizeCtx(raw: unknown): Ctx | null {
  if (!isObj(raw) || !isObj(raw.sandbox) || !isObj(raw.pricing)) return null;
  const sb = raw.sandbox, p = raw.pricing;
  const id = str(sb.id, 120), account = str(sb.account, 40);
  if (!SAFE_ID.test(id) || !SAFE_ACCOUNT.test(account)) return null;
  const cpu = num(p.cpuUsdPerHour);
  if (cpu === null) return null;
  let selection: Ctx['selection'] = null;
  if (isObj(raw.selection)) {
    const s = raw.selection;
    const gpu = plain(s.gpu, 80), candidateId = plain(s.candidateId, 120), c = str(s.country, 2);
    if (!gpu || !candidateId || !/^[A-Z]{2}$/.test(c)) return null;
    selection = { candidateId, gpu, country: c, market: plain(s.market, 80) || null };
  } else if (raw.selection !== null) return null;
  return {
    sandbox: { id, account, name: plain(sb.name, 120), region: plain(sb.region, 40) },
    selection,
    pricing: { cpuUsdPerHour: cpu, gpuBaseUsdPerHour: num(p.gpuBaseUsdPerHour), observedAt: iso(p.observedAt) },
  };
}
const ctxKey = (c: Ctx): string => JSON.stringify([c.sandbox.account, c.sandbox.id, c.selection?.candidateId ?? null, c.selection?.gpu ?? null,
  c.selection?.country ?? null, c.pricing.cpuUsdPerHour, c.pricing.gpuBaseUsdPerHour]);

/** Raw output as text: newlines kept, other control characters replaced, bounded */
function logText(v: unknown): string {
  const s = typeof v === 'string' ? v : '';
  const cut = s.length > MAX_LOG_CHARS ? s.slice(s.length - MAX_LOG_CHARS) : s;
  return cut.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '�');
}

function normalizeJob(raw: unknown): Job | null {
  if (!isObj(raw)) return null;
  const id = str(raw.id, 120);
  if (!SAFE_ID.test(id) || (raw.provider !== 'daytona' && raw.provider !== 'nosana')) return null;
  const status: JobStatus = JOB_STATUSES.includes(raw.status as JobStatus) ? raw.status as JobStatus : 'uncertain';
  const r = raw.result;
  const err = str(raw.error, 64);
  return {
    id, provider: raw.provider, status, image: plain(raw.image, 220),
    command: Array.isArray(raw.command) ? raw.command.slice(0, MAX_ARGS).map(a => plain(a, 400)) : [],
    timeoutSec: num(raw.timeoutSec) ?? 0, createdAt: iso(raw.createdAt), finishedAt: iso(raw.finishedAt),
    cleanup: CLEANUPS.includes(raw.cleanup as Cleanup) ? raw.cleanup as Cleanup : 'unknown',
    error: err ? (SAFE_CODE.test(err) ? err : 'error') : null, providerState: plain(raw.providerState, 40),
    gpu: plain(raw.gpu, 80), country: /^[A-Z]{2}$/.test(str(raw.country, 2)) ? str(raw.country, 2) : '', note: plain(raw.note, 200),
    result: isObj(r) ? {
      exitCode: typeof r.exitCode === 'number' && Number.isInteger(r.exitCode) ? r.exitCode : null,
      timedOut: r.timedOut === true, output: logText(r.output), truncated: r.truncated === true,
    } : null,
  };
}

/** The command textarea → argv, or the reason it is not one. No shell parsing: one JSON array of strings. */
function parseArgv(text: string, d: Dict): string[] | string {
  let v: unknown;
  try { v = JSON.parse(text); } catch { return d.whyJson; }
  if (!Array.isArray(v) || !v.every(a => typeof a === 'string')) return d.whyArray;
  const a = v as string[];
  if (a.length < 1 || a.length > MAX_ARGS) return d.whyCount;
  if (!a[0].trim()) return d.whyFirst;
  if (a.some(x => x.length > MAX_ARG || CONTROL.test(x))) return d.whyArg;
  if (byteLen(JSON.stringify(a)) > MAX_COMMAND_BYTES) return d.whyLong;
  return a;
}

/** The chosen files → the reason they cannot be sent, or '' when they can (sizes from the File objects) */
function checkFiles(files: File[], d: Dict): string {
  if (files.length > MAX_FILES) return d.fileTooMany;
  const seen = new Set<string>();
  let total = 0;
  for (const f of files) {
    if (!FILE_NAME.test(f.name) || f.name === '.' || f.name === '..') return d.fileBadName(plain(f.name, 80));
    if (seen.has(f.name)) return d.fileDup(f.name);
    seen.add(f.name); total += f.size;
  }
  return total > MAX_FILE_BYTES ? d.fileTooBig : '';
}

function toBase64(buf: ArrayBuffer): string {
  const b = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i += 0x2000) s += String.fromCharCode(...b.subarray(i, i + 0x2000));
  return btoa(s);
}

const usd = (v: number): string => `$${v < 1 ? v.toFixed(4) : v.toFixed(2)}`;
const rate = (v: number): string => `$${String(Number(v.toFixed(6)))}`;
/** time limit rounded up to whole minutes, plus 2 minutes of start-up */
const billedMinutes = (timeoutSec: number, provider: string): number => provider === 'nosana' ? 50 : Math.ceil(timeoutSec / 60) + 2;

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
  if (m) { el.textContent = m.text(); el.className = `cj-msg cj-${m.kind}`; }
}

// ───────────────────────── App ─────────────────────────

function mount(root: HTMLElement): void {
  const params = new URLSearchParams(location.search);
  const qs = params.get('lang');
  let lang: Lang = qs === 'ko' || qs === 'en' ? qs : (navigator.language || '').toLowerCase().startsWith('ko') ? 'ko' : 'en';
  const T = (): Dict => DICT[lang] as Dict;
  // an explicit sandbox is only a request: the server verifies it belongs to the signed-in owner
  const wantId = params.get('sandboxId') || '', wantAccount = params.get('account') || '';
  const ctxQuery = SAFE_ID.test(wantId) && SAFE_ACCOUNT.test(wantAccount)
    ? `?${new URLSearchParams({ sandboxId: wantId, account: wantAccount }).toString()}` : '';

  const S = {
    auth: 'loading' as 'loading' | 'in' | 'out' | 'failed', ctx: null as Ctx | null, ctxLoading: false, ctxMsg: null as Msg,
    provider: 'daytona' as Provider, files: [] as File[], fileMsg: null as Msg, formMsg: null as Msg,
    reviewing: false, review: null as Review | null, ackCost: false, ackPublic: false, op: null as Op | null, runMsg: null as Msg,
    jobs: null as Job[] | null, jobsLoading: false, jobsMsg: null as Msg, pollPaused: false,
    stops: new Map<string, Op>(), stopMsgs: new Map<string, Msg>(), openLogs: new Set<string>(),
  };
  // gen is bumped on sign-out: every answer that arrives later is dropped and in-flight requests are aborted.
  // ctxSeq / jobsSeq drop an older answer that arrives after a newer request of the same kind.
  let gen = 0, ctxSeq = 0, jobsSeq = 0, ac = new AbortController();
  let pollTimer: ReturnType<typeof setTimeout> | null = null, polls = 0;

  // ── skeleton ──
  const brand = h('strong', 'cj-brand'), brandSub = h('span', 'cj-sub');
  const backLink = link('cj-nav-link', COMPUTER_PATH);
  const langNav = h('nav', 'cj-lang');
  const langBtns = (['en', 'ko'] as Lang[]).map(l => {
    const b = button('cj-lang-btn', () => { if (lang !== l) { lang = l; render(); } });
    b.textContent = l.toUpperCase(); b.setAttribute('lang', l);
    langNav.append(b);
    return b;
  });
  const header = h('header', 'cj-header', h('div', 'cj-brand-row', brand, brandSub), h('div', 'cj-header-side', backLink, langNav));
  const h1 = h('h1'), lead = h('p', 'cj-lead');

  const loadMsg = h('p', 'cj-msg');
  loadMsg.setAttribute('role', 'status');
  const signInLink = link('cj-btn cj-primary', COMPUTER_PATH);
  const checkBtn = button('cj-btn', () => { void loadCtx(); });
  const gateActions = h('div', 'cj-actions', signInLink, checkBtn);
  const gate = h('section', 'cj-card', loadMsg, gateActions);

  // target (read-only, from the server)
  const targetTitle = h('h2'), targetLead = h('p', 'cj-fine'), targetFacts = h('dl', 'cj-facts'), noGpu = h('p', 'cj-msg cj-info'), ctxMsg = h('p', 'cj-msg');
  const noGpuLink = link('cj-text-link', COMPUTER_PATH);
  const targetCard = h('section', 'cj-card', targetTitle, targetLead, ctxMsg, targetFacts, h('div', '', noGpu, noGpuLink));

  // job form
  const formTitle = h('h2');
  const providerLabel = h('label', 'cj-field-label'), providerSel = h('select', 'cj-select');
  providerSel.id = 'cj-provider'; providerLabel.setAttribute('for', 'cj-provider');
  const providerOpts = (['daytona', 'nosana'] as Provider[]).map(p => { const o = h('option'); o.value = p; providerSel.append(o); return o; });
  providerSel.addEventListener('change', () => { changeProvider(providerSel.value === 'nosana' ? 'nosana' : 'daytona'); S.formMsg = null; render(); });
  const providerNote = h('p', 'cj-fine');
  const publicWarn = h('p', 'cj-callout');
  const samplesLabel = h('p', 'cj-field-label');
  const sampleBtns = SAMPLES.map(s => {
    const b = button('cj-btn cj-chip', () => { applySample(s); });
    b.setAttribute('data-sample', s.id);
    return b;
  });
  const samplesRow = h('div', 'cj-chips', ...sampleBtns);
  const imageLabel = h('label', 'cj-field-label'), imageIn = h('input', 'cj-input'), imageHint = h('p', 'cj-fine');
  imageIn.id = 'cj-image'; imageLabel.setAttribute('for', 'cj-image');
  for (const [k, v] of [['autocomplete', 'off'], ['autocapitalize', 'none'], ['spellcheck', 'false'], ['maxlength', '220'], ['placeholder', DEFAULT_IMAGE]]) imageIn.setAttribute(k, v);
  const cmdLabel = h('label', 'cj-field-label'), cmdIn = h('textarea', 'cj-input cj-code'), cmdHint = h('p', 'cj-fine');
  cmdIn.id = 'cj-command'; cmdLabel.setAttribute('for', 'cj-command');
  for (const [k, v] of [['autocomplete', 'off'], ['autocapitalize', 'none'], ['spellcheck', 'false'], ['rows', '4'], ['maxlength', String(MAX_COMMAND_BYTES)]]) cmdIn.setAttribute(k, v);
  cmdIn.value = JSON.stringify(SAMPLES[1].command);
  const timeoutLabel = h('label', 'cj-field-label'), timeoutSel = h('select', 'cj-select');
  timeoutSel.id = 'cj-timeout'; timeoutLabel.setAttribute('for', 'cj-timeout');
  const timeoutOpts = TIMEOUTS.map(s => { const o = h('option'); o.value = String(s); timeoutSel.append(o); return o; });
  timeoutSel.value = String(DEFAULT_TIMEOUT);
  const filesLabel = h('label', 'cj-field-label'), filesIn = h('input', 'cj-file'), filesHint = h('p', 'cj-fine');
  filesIn.id = 'cj-files'; filesLabel.setAttribute('for', 'cj-files');
  filesIn.setAttribute('type', 'file'); filesIn.setAttribute('multiple', '');
  filesIn.addEventListener('change', () => { S.files = Array.from(filesIn.files || []); S.fileMsg = null; S.formMsg = null; render(); });
  const filesList = h('ul', 'cj-files'), fileMsg = h('p', 'cj-msg');
  const filesClear = button('cj-btn cj-quiet', () => { S.files = []; filesIn.value = ''; S.fileMsg = null; render(); });
  const formMsg = h('p', 'cj-msg');
  formMsg.setAttribute('role', 'status');
  const reviewBtn = button('cj-btn cj-primary', () => { void startReview(); });
  const formCard = h('section', 'cj-card',
    formTitle,
    h('div', 'cj-field', providerLabel, providerSel, providerNote), publicWarn,
    h('div', 'cj-field', samplesLabel, samplesRow),
    h('div', 'cj-field', imageLabel, imageIn, imageHint),
    h('div', 'cj-field', cmdLabel, cmdIn, cmdHint),
    h('div', 'cj-field', timeoutLabel, timeoutSel),
    h('div', 'cj-field', filesLabel, filesIn, filesHint, filesList, fileMsg, filesClear),
    formMsg, h('div', 'cj-actions', reviewBtn));

  // review: the explicit cost and publication step before Run
  const reviewTitle = h('h2'), reviewFacts = h('dl', 'cj-facts'), costNote = h('p', 'cj-fine'), reviewPublic = h('p', 'cj-callout');
  const ackCostIn = h('input'), ackCostText = h('span'), ackPublicIn = h('input'), ackPublicText = h('span');
  ackCostIn.setAttribute('type', 'checkbox'); ackPublicIn.setAttribute('type', 'checkbox');
  ackCostIn.addEventListener('change', () => { S.ackCost = ackCostIn.checked; render(); });
  ackPublicIn.addEventListener('change', () => { S.ackPublic = ackPublicIn.checked; render(); });
  const ackCostRow = h('label', 'cj-check', ackCostIn, ackCostText), ackPublicRow = h('label', 'cj-check', ackPublicIn, ackPublicText);
  const runBtn = button('cj-btn cj-primary', () => { void run(); });
  const editBtn = button('cj-btn', () => { discardReview(null); });
  const retryBtn = button('cj-btn cj-primary', () => { if (S.op) void sendRun(S.op); });
  const forgetBtn = button('cj-btn cj-quiet', () => { S.op = null; discardReview({ text: () => T().forgot, kind: 'info' }); void loadJobs(); });
  const runMsg = h('p', 'cj-msg');
  runMsg.setAttribute('role', 'status');
  const reviewCard = h('section', 'cj-card cj-review', reviewTitle, reviewFacts, costNote, reviewPublic, ackCostRow, ackPublicRow,
    runMsg, h('div', 'cj-actions', runBtn, editBtn, retryBtn, forgetBtn));

  // jobs
  const jobsTitle = h('h2'), jobsMsg = h('p', 'cj-msg'), pollNote = h('p', 'cj-fine');
  jobsMsg.setAttribute('role', 'status');
  const jobsRefresh = button('cj-btn cj-quiet', () => { polls = 0; S.pollPaused = false; void loadJobs(); });
  const jobsList = h('ul', 'cj-jobs');
  const jobsCard = h('section', 'cj-card', h('div', 'cj-head', jobsTitle, jobsRefresh), jobsMsg, pollNote, jobsList);

  const work = h('div', 'cj-grid', targetCard, h('div', 'cj-stack', formCard, reviewCard), jobsCard);
  const main = h('main', 'cj-main', h1, lead, gate, work);
  root.replaceChildren(header, main);

  // ── form ──
  const locked = (): boolean => S.reviewing || !!S.review || !!S.op;
  function changeProvider(next: Provider): void {
    if (S.provider !== 'nosana' && next === 'nosana' && S.files.length) {
      S.files = []; filesIn.value = '';
      S.fileMsg = { text: () => T().filesReset, kind: 'warn' };
    }
    S.provider = next;
  }
  function applySample(s: Sample): void {
    if (locked()) return;
    changeProvider(s.provider === 'nosana' && !S.ctx?.selection ? 'daytona' : s.provider);
    imageIn.value = s.image === DEFAULT_IMAGE ? '' : s.image;
    cmdIn.value = JSON.stringify(s.command);
    S.formMsg = null; render();
  }
  function discardReview(m: Msg): void {
    if (S.op) return;
    S.review = null; S.ackCost = false; S.ackPublic = false; S.runMsg = null; S.formMsg = m;
    render();
  }

  async function startReview(): Promise<void> {
    if (locked() || S.auth !== 'in' || !S.ctx) return;
    const d = T(), ctx = S.ctx, provider = S.provider;
    if (provider === 'nosana' && !ctx.selection) { S.formMsg = { text: () => T().noGpu, kind: 'warn' }; render(); return; }
    const image = imageIn.value.trim();
    if (image && !IMAGE.test(image)) { S.formMsg = { text: () => T().imageBad, kind: 'warn' }; render(); return; }
    const argv = parseArgv(cmdIn.value, d);
    if (typeof argv === 'string') { const why = argv; S.formMsg = { text: () => T().commandBad(why), kind: 'warn' }; render(); return; }
    const timeout = Number(timeoutSel.value);
    if (!Number.isSafeInteger(timeout) || timeout < MIN_TIMEOUT || timeout > MAX_TIMEOUT) return;
    const chosen = S.files.slice();
    const bad = checkFiles(chosen, d);
    if (bad) { S.fileMsg = { text: () => bad, kind: 'warn' }; render(); return; }
    S.reviewing = true; S.formMsg = null; render();
    const g = gen;
    const files: UploadFile[] = [];
    let total = 0;
    try {
      for (const f of chosen) {
        const buf = await f.arrayBuffer();
        total += buf.byteLength;
        files.push({ name: f.name, contentBase64: toBase64(buf), size: buf.byteLength });
      }
    } catch { if (g === gen) { S.reviewing = false; S.fileMsg = { text: () => T().fileRead, kind: 'warn' }; render(); } return; }
    if (g !== gen) return;
    S.reviewing = false;
    if (total > MAX_FILE_BYTES) { S.fileMsg = { text: () => T().fileTooBig, kind: 'warn' }; render(); return; }
    const gpu = provider === 'nosana' && ctx.selection ? ctx.selection : null;
    S.review = {
      ctxKey: ctxKey(ctx), provider, image, timeout, command: argv, files, sandboxId: ctx.sandbox.id, account: ctx.sandbox.account,
      target: gpu ? d.gpuLine(gpu.gpu, gpu.country, gpu.market || '') : '',
      usdPerHour: provider === 'nosana' ? ctx.pricing.gpuBaseUsdPerHour : ctx.pricing.cpuUsdPerHour, minutes: billedMinutes(timeout, provider),
    };
    S.ackCost = false; S.ackPublic = false; S.runMsg = null;
    if (JSON.stringify(bodyOf(S.review, uuid())).length > MAX_BODY_BYTES) { S.review = null; S.formMsg = { text: () => T().commandBad(T().whyLong), kind: 'warn' }; }
    render();
  }

  function bodyOf(r: Review, requestId: string): Record<string, unknown> {
    return {
      requestId, sandboxId: r.sandboxId, account: r.account, provider: r.provider, ...(r.image ? { image: r.image } : {}), timeout: r.timeout, command: r.command,
      ...(r.files.length ? { files: r.files.map(f => ({ name: f.name, contentBase64: f.contentBase64 })) } : {}),
      acknowledgeCost: true, ...(r.provider === 'nosana' ? { acknowledgePublic: true } : {}),
    };
  }

  async function run(): Promise<void> {
    const r = S.review;
    if (!r || S.op || S.auth !== 'in' || !S.ackCost || (r.provider === 'nosana' && !S.ackPublic)) return;
    if (!S.ctx || ctxKey(S.ctx) !== r.ctxKey) { discardReview({ text: () => T().stale, kind: 'warn' }); return; }
    const requestId = uuid();
    const json = JSON.stringify(bodyOf(r, requestId));
    if (byteLen(json) > MAX_BODY_BYTES) { discardReview({ text: () => T().commandBad(T().whyLong), kind: 'warn' }); return; }
    await sendRun({ requestId, json, phase: 'sending' });
  }

  async function sendRun(op: Op): Promise<void> {
    // a different pending request, or this one still in flight: never a second send
    if (S.auth !== 'in' || (S.op && (S.op !== op || op.phase === 'sending'))) return;
    op.phase = 'sending'; S.op = op; S.runMsg = { text: () => T().running, kind: 'info' }; render();
    const g = gen;
    const res = await call(`${JOBS_API}/run`, ac.signal, op.json);
    if (g !== gen || S.op !== op) return;
    if (res.ok) {
      const job = isObj(res.body) ? normalizeJob(res.body.job) : null;
      S.op = null; S.review = null; S.ackCost = false; S.ackPublic = false; S.runMsg = null;
      S.formMsg = { text: () => T().runOk, kind: 'ok' };
      if (job) mergeJob(job);
      polls = 0; S.pollPaused = false; render(); void loadJobs(); return;
    }
    if (authStatus(res.status)) { signedOut(); return; }
    if (uncertainStatus(res.status)) { op.phase = 'uncertain'; S.runMsg = { text: () => T().runUncertain, kind: 'warn' }; render(); schedule(); return; }
    // a definite rejection: nothing was created; the inputs stay as typed and unlock for editing
    const code = res.code || String(res.status);
    S.op = null; S.review = null; S.ackCost = false; S.ackPublic = false; S.runMsg = null;
    S.formMsg = { text: () => T().rejected(code), kind: 'warn' };
    render();
  }

  // ── jobs ──
  function mergeJob(j: Job): void {
    const list = (S.jobs || []).filter(x => x.id !== j.id);
    S.jobs = [j, ...list];
  }

  async function stopJob(id: string): Promise<void> {
    const prev = S.stops.get(id);
    if (S.auth !== 'in' || (prev && prev.phase === 'sending')) return;
    const op: Op = prev || { requestId: uuid(), json: '', phase: 'sending' };
    if (!op.json) op.json = JSON.stringify({ requestId: op.requestId, jobId: id });
    op.phase = 'sending'; S.stops.set(id, op); S.stopMsgs.delete(id); render();
    const g = gen;
    const res = await call(`${JOBS_API}/stop`, ac.signal, op.json);
    if (g !== gen || S.stops.get(id) !== op) return;
    if (res.ok) {
      S.stops.delete(id); S.stopMsgs.set(id, { text: () => T().stopOk, kind: 'ok' });
      const job = isObj(res.body) ? normalizeJob(res.body.job) : null;
      if (job && job.id === id) mergeJob(job);
      polls = 0; S.pollPaused = false; render(); void loadJobs(); return;
    }
    if (authStatus(res.status)) { signedOut(); return; }
    if (uncertainStatus(res.status)) { op.phase = 'uncertain'; S.stopMsgs.set(id, { text: () => T().stopUncertain, kind: 'warn' }); render(); return; }
    const code = res.code || String(res.status);
    S.stops.delete(id); S.stopMsgs.set(id, { text: () => T().rejected(code), kind: 'warn' }); render();
  }

  async function loadJobs(): Promise<void> {
    if (S.auth !== 'in') return;
    const g = gen, seq = ++jobsSeq;
    S.jobsLoading = true; render();
    const res = await call(NESTED_JOBS, ac.signal);
    if (g !== gen || seq !== jobsSeq) return;
    S.jobsLoading = false;
    if (res.ok && isObj(res.body) && Array.isArray(res.body.jobs)) {
      S.jobs = res.body.jobs.map(normalizeJob).filter((j): j is Job => !!j);
      S.jobsMsg = null;
      for (const id of [...S.openLogs]) if (!S.jobs.some(j => j.id === id)) S.openLogs.delete(id);
    } else if (!res.ok && authStatus(res.status)) { signedOut(); return; }
    else {
      const m = res.ok ? '' : res.status === 0 ? 'net' : res.code || String(res.status);
      S.jobsMsg = { text: () => `${T().jobsFailed} ${m === 'net' ? T().netErr : m && !res.ok ? T().rejected(m) : T().ctxOdd}`, kind: 'warn' };
    }
    render(); schedule();
  }

  async function loadCtx(): Promise<void> {
    const g = gen, seq = ++ctxSeq;
    S.ctxLoading = true; if (S.auth !== 'in') S.auth = 'loading'; render();
    const res = await call(`${JOBS_API}/context${ctxQuery}`, ac.signal);
    if (g !== gen || seq !== ctxSeq) return;
    S.ctxLoading = false;
    if (!res.ok && authStatus(res.status)) { signedOut(); return; }
    const ctx = res.ok ? normalizeCtx(res.body) : null;
    if (!ctx) {
      const m = res.ok ? 'odd' : res.status === 0 ? 'net' : res.code || String(res.status);
      S.ctxMsg = { text: () => `${T().ctxFailed} ${m === 'odd' ? T().ctxOdd : m === 'net' ? T().netErr : T().rejected(m)}`, kind: 'warn' };
      if (S.auth !== 'in') S.auth = 'failed';
      render(); return;
    }
    const wasIn = S.auth === 'in';
    S.ctx = ctx; S.ctxMsg = null; S.auth = 'in';
    if (!ctx.selection && S.provider === 'nosana' && !S.review && !S.op) S.provider = 'daytona';
    // a review made for another target is not sent; an uncertain request keeps its exact payload for Retry
    if (S.review && !S.op && S.review.ctxKey !== ctxKey(ctx)) discardReview({ text: () => T().stale, kind: 'warn' });
    render();
    if (!wasIn) void loadJobs();
  }

  // Sign-out (any 401/403): abort everything in flight, forget the target, review, pending requests and jobs.
  // The typed command, image and chosen files stay in the form.
  function signedOut(): void {
    gen++; ac.abort(); ac = new AbortController(); stopPoll();
    Object.assign(S, { auth: 'out', ctx: null, ctxLoading: false, ctxMsg: null, reviewing: false, review: null, ackCost: false, ackPublic: false,
      op: null, runMsg: null, jobs: null, jobsLoading: false, jobsMsg: null, pollPaused: false, formMsg: null });
    S.stops.clear(); S.stopMsgs.clear(); S.openLogs.clear();
    render();
  }

  // ── polling: only while visible, signed in and a job (or a request) is still unsettled; ≥ 5 s with backoff ──
  function pendingWork(): boolean {
    return !!S.op || (S.jobs || []).some(j => ACTIVE.includes(j.status) || j.cleanup === 'pending' || j.cleanup === 'unknown');
  }
  function stopPoll(): void { if (pollTimer !== null) { clearTimeout(pollTimer); pollTimer = null; } }
  function schedule(): void {
    stopPoll();
    if (S.auth !== 'in' || document.visibilityState !== 'visible' || !pendingWork()) return;
    if (polls >= POLL_MAX) { S.pollPaused = true; render(); return; }
    const delay = Math.min(POLL_MAX_MS, Math.round(POLL_FIRST_MS * 1.5 ** Math.min(polls, 10)));
    pollTimer = setTimeout(() => { pollTimer = null; polls++; void loadJobs(); }, delay);
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { polls = 0; S.pollPaused = false; if (S.auth === 'in') { void loadCtx(); void loadJobs(); } }
    else stopPoll();
  });

  // ── render ──
  function fact(dl: HTMLElement, k: string, v: string): void { dl.append(h('dt', '', k), h('dd', '', v)); }

  function render(): void {
    const d = T();
    document.documentElement.lang = lang; document.title = d.title;
    brand.textContent = d.brand; brandSub.textContent = d.sub;
    backLink.textContent = d.back; backLink.setAttribute('href', `${COMPUTER_PATH}?lang=${lang}`);
    langNav.setAttribute('aria-label', 'Language');
    for (const b of langBtns) b.setAttribute('aria-pressed', String(b.getAttribute('lang') === lang));
    h1.textContent = d.h1; lead.textContent = d.lead;

    // gate: loading, signed out or failed
    const inside = S.auth === 'in';
    gate.hidden = inside; work.hidden = !inside;
    showMsg(loadMsg, S.auth === 'out' ? { text: () => T().signedOut, kind: 'info' } : S.auth === 'failed' ? S.ctxMsg : { text: () => T().loading, kind: 'info' });
    signInLink.textContent = d.signInLink; signInLink.setAttribute('href', `${COMPUTER_PATH}?lang=${lang}`);
    signInLink.hidden = S.auth !== 'out';
    checkBtn.textContent = S.auth === 'out' ? d.checkAgain : d.retryLoad;
    checkBtn.hidden = S.auth === 'loading'; checkBtn.disabled = S.ctxLoading;
    if (!inside || !S.ctx) return;
    const ctx = S.ctx;

    // target
    targetTitle.textContent = d.targetTitle; targetLead.textContent = d.targetLead;
    showMsg(ctxMsg, S.ctxMsg); // a later context check that failed: the last confirmed target stays shown
    targetFacts.replaceChildren();
    fact(targetFacts, d.sandbox, ctx.sandbox.name || ctx.sandbox.id);
    if (ctx.sandbox.region) fact(targetFacts, d.region, ctx.sandbox.region);
    if (ctx.selection) fact(targetFacts, d.gpu, d.gpuLine(ctx.selection.gpu, ctx.selection.country, ctx.selection.market || ''));
    noGpu.hidden = !!ctx.selection; noGpu.textContent = d.noGpu;
    noGpuLink.hidden = !!ctx.selection; noGpuLink.textContent = d.back; noGpuLink.setAttribute('href', `${COMPUTER_PATH}?lang=${lang}`);

    // form
    const lock = locked();
    formTitle.textContent = d.formTitle; providerLabel.textContent = d.provider;
    for (const o of providerOpts) {
      const p = o.value as Provider;
      o.textContent = p === 'nosana' && !ctx.selection ? d.gpuNeedsChoice : d.providerOpt[p];
      o.disabled = p === 'nosana' && !ctx.selection;
    }
    providerSel.value = S.provider; providerSel.disabled = lock;
    providerNote.textContent = S.provider === 'nosana' ? '' : d.privateNote; providerNote.hidden = S.provider === 'nosana';
    publicWarn.textContent = d.publicWarn; publicWarn.hidden = S.provider !== 'nosana';
    samplesLabel.textContent = d.samples;
    SAMPLES.forEach((s, i) => { sampleBtns[i].textContent = s.label[lang]; sampleBtns[i].disabled = lock; });
    imageLabel.textContent = d.image; imageHint.textContent = d.imageHint(DEFAULT_IMAGE); imageIn.disabled = lock;
    cmdLabel.textContent = d.command; cmdHint.textContent = d.commandHint; cmdIn.disabled = lock;
    timeoutLabel.textContent = d.timeout; timeoutSel.disabled = lock;
    timeoutOpts.forEach((o, i) => { o.textContent = d.timeoutOpt(TIMEOUTS[i]); });
    filesLabel.textContent = d.files; filesHint.textContent = d.filesHint; filesIn.disabled = lock;
    filesList.replaceChildren(...(S.files.length ? S.files.map(f => h('li', '', d.fileLine(plain(f.name, 80), f.size))) : [h('li', 'cj-muted', d.filesNone)]));
    filesClear.textContent = d.filesClear; filesClear.hidden = !S.files.length; filesClear.disabled = lock;
    showMsg(fileMsg, S.fileMsg);
    reviewBtn.textContent = S.reviewing ? d.reviewing : d.review; reviewBtn.disabled = lock;
    showMsg(formMsg, S.review ? null : S.formMsg);

    // review
    const r = S.review;
    reviewCard.hidden = !r;
    if (r) {
      reviewTitle.textContent = d.reviewTitle;
      reviewFacts.replaceChildren();
      fact(reviewFacts, d.rTarget, r.provider === 'nosana' ? `${d.providerOpt.nosana} · ${r.target}` : d.rCpu(ctx.sandbox.region || ctx.sandbox.name || ctx.sandbox.id));
      fact(reviewFacts, d.rImage, r.image || DEFAULT_IMAGE);
      fact(reviewFacts, d.rCommand, JSON.stringify(r.command));
      fact(reviewFacts, d.rFiles, r.files.length ? `${d.rFilesVal(r.files.length, r.files.reduce((a, f) => a + f.size, 0))}: ${r.files.map(f => f.name).join(', ')}` : d.rNone);
      fact(reviewFacts, d.rTimeout, d.timeoutOpt(r.timeout));
      fact(reviewFacts, d.rCost, r.usdPerHour === null ? d.costUnknown : d.cost(usd(r.usdPerHour * r.minutes / 60), r.minutes, rate(r.usdPerHour)));
      costNote.textContent = d.costNote;
      reviewPublic.textContent = d.publicWarn; reviewPublic.hidden = r.provider !== 'nosana';
      const sending = !!S.op;
      ackCostText.textContent = d.ackCost; ackCostIn.checked = S.ackCost; ackCostIn.disabled = sending;
      ackPublicText.textContent = d.ackPublic; ackPublicIn.checked = S.ackPublic; ackPublicIn.disabled = sending; ackPublicRow.hidden = r.provider !== 'nosana';
      runBtn.textContent = S.op?.phase === 'sending' ? d.running : d.run;
      runBtn.hidden = S.op?.phase === 'uncertain';
      runBtn.disabled = sending || !S.ackCost || (r.provider === 'nosana' && !S.ackPublic);
      editBtn.textContent = d.edit; editBtn.hidden = sending;
      retryBtn.textContent = d.retrySame; retryBtn.hidden = S.op?.phase !== 'uncertain';
      forgetBtn.textContent = d.forget; forgetBtn.hidden = S.op?.phase !== 'uncertain';
      showMsg(runMsg, S.runMsg);
    }

    // jobs
    jobsTitle.textContent = d.jobsTitle;
    // stays pressable while a check is in flight: a newer answer replaces a hung one (jobsSeq)
    jobsRefresh.textContent = d.refresh; jobsRefresh.setAttribute('aria-busy', String(S.jobsLoading));
    showMsg(jobsMsg, S.jobsMsg);
    pollNote.textContent = d.pollPaused; pollNote.hidden = !S.pollPaused;
    const jobs = S.jobs || [];
    jobsList.replaceChildren(...(S.jobs && !jobs.length ? [h('li', 'cj-muted', d.jobsNone)] : jobs.map(jobItem)));
  }

  function jobItem(j: Job): HTMLLIElement {
    const d = T();
    const pill = h('span', `cj-pill cj-s-${j.status}`, d.status[j.status]);
    const kind = j.provider === 'nosana' ? `${d.kindGpu}${j.gpu ? ` · ${j.gpu}` : ''}${j.country ? ` · ${j.country}` : ''}` : d.kindCpu;
    const head = h('div', 'cj-job-head', h('strong', '', kind), pill);
    const facts = h('dl', 'cj-facts');
    fact(facts, d.rImage, j.image || DEFAULT_IMAGE);
    fact(facts, d.rCommand, JSON.stringify(j.command));
    fact(facts, d.rTimeout, `${j.createdAt ? `${d.created(new Date(j.createdAt).toLocaleString(lang))} · ` : ''}${d.limit(j.timeoutSec)}`);
    const notes = h('div', 'cj-job-notes');
    const line = (t: string, cls = 'cj-fine') => { if (t) notes.append(h('p', cls, t)); };
    if (j.providerState) line(d.providerSays(j.providerState));
    if (j.error) line(d.errorCode(j.error), 'cj-fine cj-bad');
    if (d.cleanup[j.cleanup]) line(d.cleanup[j.cleanup]);
    if (j.note) line(j.note);
    const li = h('li', 'cj-job', head, facts, notes);
    li.setAttribute('data-job', j.id);
    if (j.result) {
      const res = j.result;
      line(res.exitCode === null ? d.exitUnknown : d.exit(String(res.exitCode)));
      if (res.timedOut) line(d.timedOut);
      if (res.truncated) line(d.truncated);
      const open = S.openLogs.has(j.id);
      const toggle = button('cj-btn cj-quiet', () => { if (S.openLogs.has(j.id)) S.openLogs.delete(j.id); else S.openLogs.add(j.id); render(); });
      toggle.textContent = open ? d.logHide : d.logShow; toggle.setAttribute('aria-expanded', String(open));
      const dl = link('cj-btn cj-quiet', `${JOBS_API}/${encodeURIComponent(j.id)}/output`);
      dl.setAttribute('download', `cloudbite-job-${j.id.replace(/[^A-Za-z0-9._-]/g, '_')}.txt`);
      dl.textContent = d.download;
      li.append(h('div', 'cj-actions', toggle, dl));
      if (open) li.append(h('pre', 'cj-log', res.output || d.logEmpty));
    }
    const stop = S.stops.get(j.id), stopMsg = S.stopMsgs.get(j.id);
    if (STOPPABLE.includes(j.status) || stop) {
      const b = button('cj-btn', () => { void stopJob(j.id); });
      b.textContent = stop?.phase === 'sending' ? d.stopping : stop?.phase === 'uncertain' ? d.retryStop : d.stop;
      b.disabled = stop?.phase === 'sending';
      li.append(h('div', 'cj-actions', b));
    }
    if (stopMsg) { const p = h('p', 'cj-msg'); showMsg(p, stopMsg); li.append(p); }
    return li;
  }

  render();
  void loadCtx();
}

const rootEl = document.getElementById('cb-computer-jobs');
if (rootEl) mount(rootEl);

// Module scope for tsc only (keeps names out of the shared client global scope); the build strips this line.
export {};
