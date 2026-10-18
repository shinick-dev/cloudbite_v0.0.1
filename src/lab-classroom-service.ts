// 수업 안내·자리 진행·제출. State 가 Daytona 읽기를 넘기고, 이 서비스는 저장과 권한 경계만 가진다.
// 키는 수업당 문서 하나(labclassroom:<id>)와 자리당 하나(labclassroom-seat:<id>:<n>, n=1..20).
// 제출은 자리마다 최대 10개, 본문은 호출자가 넘긴 64KiB 이하 텍스트만 저장한다. 목록 스캔으로 본문을 모으지 않는다.
// 모임이 끝나면 자리는 즉시 거부한다. 관리자 검토용 문서·제출은 7일(CLASSROOM_RETENTION_MS)만 남기고 알람이 그 키만 지운다.
// 기존 수업 정리(샌드박스·세션·lab: 삭제)는 건드리지 않는다. 보기 쿠키는 상태 읽기만 되고, 공급자 비밀·자리 코드·승인 원문은 응답에 넣지 않는다.
import type { Fail } from './state';

export const CLASSROOM_RETENTION_MS = 7 * 24 * 3600 * 1000;
export const CLASSROOM_FILE_NAME = '결과.txt';
export const CLASSROOM_BYTES = 64 * 1024;
export const CLASSROOM_WORK = '/home/daytona/work';
export const CLASSROOM_SEAT_CAP = 20;
export const CLASSROOM_SUBMISSION_CAP = 10;
const PENDING_CAP = 4;
const REJECTED_CAP = 16;
const LAB_ID = /^[\w-]{1,100}$/;
const SEAT_CODE = /^[\w-]{16}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STEP_ID = /^[a-z0-9](?:[a-z0-9-]{0,31})$/;
const DOC_PREFIX = 'labclassroom:';
const RETAIN_PREFIX = 'labclassroom-retain:';
const GC_CURSOR = 'labclassroom-gc-cursor';
interface RetainIntent { at: number; roster: { n: number; who: string }[] }

const fail = (status: number, error: string): Fail => ({ status, error });
const isFail = (x: unknown): x is Fail => !!x && typeof x === 'object' && 'error' in x && 'status' in x;

export const classroomDocKey = (id: string) => `${DOC_PREFIX}${id}`;
export const classroomSeatKey = (id: string, n: number) => `labclassroom-seat:${id}:${n}`;

export interface ClassroomStep { id: string; title: string; instruction: string; prompt: string }
export interface ClassroomMaterial { name: string; content: string }
export interface ClassroomChapter { title: string; seconds: number; step: number }
export type ClassroomMode = 'demo' | 'together' | 'individual';
export interface ClassroomPublic {
  revision: number; title: string; mode: ClassroomMode; currentStep: number;
  steps: ClassroomStep[]; materials: ClassroomMaterial[]; recordingUrl: string;
  chapters: ClassroomChapter[]; updatedAt: number;
}
export interface ClassroomProgress { step: number; completed: boolean; updatedAt: number }
export interface ClassroomSubmission {
  id: string; version: number; filename: string; content: string; submittedAt: number;
  step: number; feedback: string; feedbackAt: number | null;
}
export interface ClassroomParticipant { n: number; who: string; progress: ClassroomProgress; submissions: ClassroomSubmission[] }
export interface ClassroomAdminView { classroom: ClassroomPublic; participants: ClassroomParticipant[] }
export interface ClassroomSeatView { classroom: ClassroomPublic; progress: ClassroomProgress; submissions: ClassroomSubmission[] }
export interface ClassroomSeatRef { labId: string; n: number; who: string; code: string; sandboxId: string }
export interface ClassroomLab { id: string; live: boolean; seats: ClassroomSeatRef[] }
interface StoredDoc extends ClassroomPublic { endedAt: number | null; retainUntil: number | null; roster: { n: number; who: string }[] }
interface StoredSubmission extends ClassroomSubmission { requestId: string }
interface Pending { requestId: string; submissionId: string; sandboxId: string; code: string; at: number }
interface SeatRow { progress: ClassroomProgress; submissions: StoredSubmission[]; pending: Pending[]; rejected: string[] }
type Tx = Pick<DurableObjectStorage, 'get' | 'put' | 'delete'>;
export interface ClassroomDeps {
  storage: Pick<DurableObjectStorage, 'get' | 'put' | 'delete' | 'list' | 'transaction'>;
  now(): number;
  checkAdmin(token: string): Promise<boolean>;
  /** #teacher.status 결과에서 id·ending 만. 승인·자리 코드는 넘기지 않는다. */
  teacherLabs(token: string): Promise<{ id: string; ending: boolean }[] | Fail>;
  lab(id: string): Promise<ClassroomLab | null>;
  live(id: string, tx: Pick<DurableObjectStorage, 'get'>): Promise<ClassroomLab | Fail>;
  seat(code: string): Promise<ClassroomSeatRef | Fail>;
  seatIn(code: string, tx: Pick<DurableObjectStorage, 'get'>): Promise<ClassroomSeatRef | Fail>;
  readFile(ref: ClassroomSeatRef, gate: () => boolean): Promise<{ content: string } | Fail>;
  schedule(t: number): Promise<void>;
}

const DEFAULT_STEPS: ClassroomStep[] = [
  { id: 'memo', title: '메모 두 개 읽기', instruction: '어떤 자료가 있고, 무엇이 요청됐는지 확인하세요.', prompt: '01_요청메모.txt와 02_진행메모.txt를 읽고, 요청 사항과 확인된 사실을 각각 알려 주세요. 파일은 아직 만들지 마세요.' },
  { id: 'draft', title: 'AI에게 초안 요청', instruction: '메모를 근거로 5줄짜리 결과.txt를 만들어 보세요.', prompt: '두 메모만 근거로 안내 보고서를 5줄로 써서 결과.txt에 저장해 주세요. 확정된 사실과 검토·제안 중인 내용을 구분하고, 없는 정보는 확인 필요로 적어 주세요.' },
  { id: 'compare', title: '사실과 제안 구분', instruction: '정원·진행 시간·참가비 표현을 원문과 대조하세요.', prompt: '결과.txt를 두 메모와 대조해 주세요. 12명은 검토 중, 40분은 제안입니다. 참가비는 확인 필요로 고치고 5줄을 유지해 주세요.' },
  { id: 'submit', title: '결과물 제출', instruction: '직접 읽고 수정한 결과.txt를 제출하세요.', prompt: '결과.txt를 직접 열어 5줄인지 확인하세요. 없는 사실이 추가되지 않았는지 본 다음 제출하세요.' },
  { id: 'keep', title: '내 컴퓨터에 보관', instruction: '내려받은 파일을 직접 열고, 다음에 연습할 곳을 남기세요.', prompt: '결과.txt를 내려받아 내 컴퓨터에서 직접 열어 보세요. 확인한 다음 보관 확인을 표시하고 복습할 단계를 골라 주세요.' },
];
const DEFAULT_MATERIALS: ClassroomMaterial[] = [
  { name: '01_요청메모.txt', content: 'AI 공부방 모임 안내를 위한 보고서가 필요합니다.\n메모 두 개를 근거로 5줄로 정리해 주세요.\n확정된 사실과 아직 검토·제안 중인 내용을 구분해 주세요.' },
  { name: '02_진행메모.txt', content: '현재 신청자: 10명\n정원 12명: 검토 중\n진행 시간 40분: 제안\n참가비: 아직 확인하지 않음' },
];
const DEFAULT_CHAPTERS: ClassroomChapter[] = [
  { title: '메모에서 사실 찾기', seconds: 0, step: 0 },
  { title: 'AI에게 요청을 구체적으로 쓰기', seconds: 480, step: 1 },
  { title: '확정과 제안 구분하기', seconds: 960, step: 2 },
  { title: '결과물 제출과 피드백', seconds: 1560, step: 3 },
  { title: '내 파일 보관하고 다음 연습 정하기', seconds: 2100, step: 4 },
];

const PROBE_JS = [
  "const fs=require('fs');const crypto=require('crypto');",
  'function main(){',
  "const WORK='/home/daytona/work',name='\uacb0\uacfc.txt',max=65536;",
  "let root;try{root=fs.realpathSync(WORK)}catch(e){return 'ERR work'}",
  "const target=WORK+'/'+name;let lst;try{lst=fs.lstatSync(target)}catch(e){return 'ERR missing'}",
  "if(lst.isSymbolicLink())return 'ERR symlink';if(!lst.isFile())return 'ERR type';",
  "let real;try{real=fs.realpathSync(target)}catch(e){return 'ERR realpath'}",
  "if(real!==root+'/'+name)return 'ERR outside';",
  "if(typeof fs.constants.O_NOFOLLOW!=='number')return 'ERR nofollow';",
  'let fd;try{fd=fs.openSync(target,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW)}catch(e){',
  "return e&&(e.code==='ELOOP'||e.code==='EMLINK'||e.code==='EPERM')?'ERR symlink':'ERR open'}",
  'try{const st=fs.fstatSync(fd);',
  "if(st.ino!==lst.ino||st.dev!==lst.dev||!st.isFile())return 'ERR symlink';",
  "if(st.size>max)return 'ERR oversize';const buf=Buffer.alloc(max+1);let off=0;",
  'while(off<=max){const n=fs.readSync(fd,buf,off,max+1-off,off);if(!n)break;off+=n;if(off>max)return \'ERR oversize\'}',
  "const hash=crypto.createHash('sha256').update(buf.subarray(0,off)).digest('hex');return 'OK '+hash+' '+off",
  '}finally{try{fs.closeSync(fd)}catch(e){}}}',
  'const msg=main();process.stdout.write(msg+"\\n",()=>process.exit(msg.startsWith(\'OK \')?0:3));',
].join('');

function base64(bytes: Uint8Array) {
  const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i], b = i + 1 < bytes.length ? bytes[i + 1] : 0, c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const n = (a << 16) | (b << 8) | c;
    out += alpha[(n >> 18) & 63] + alpha[(n >> 12) & 63] + (i + 1 < bytes.length ? alpha[(n >> 6) & 63] : '=') + (i + 2 < bytes.length ? alpha[n & 63] : '=');
  }
  return out;
}

/** 요청 파일명을 받지 않는다. 샌드박스 안에서 WORK/결과.txt 만 realpath·O_NOFOLLOW 로 확인한다. */
export function classroomProbeCommand() {
  const b64 = base64(new TextEncoder().encode(PROBE_JS));
  return `node -e "eval(Buffer.from('${b64}','base64').toString())"`;
}

const emptyProgress = (): ClassroomProgress => ({ step: 0, completed: false, updatedAt: 0 });
const defaultDoc = (): StoredDoc => ({
  revision: 0, title: '메모 두 개로 5줄 보고서 만들기', mode: 'together', currentStep: 0,
  steps: DEFAULT_STEPS.map((s) => ({ ...s })), materials: DEFAULT_MATERIALS.map((m) => ({ ...m })),
  recordingUrl: '', chapters: DEFAULT_CHAPTERS.map((c) => ({ ...c })), updatedAt: 0,
  endedAt: null, retainUntil: null, roster: [],
});
const emptySeat = (): SeatRow => ({ progress: emptyProgress(), submissions: [], pending: [], rejected: [] });

function bounded(value: unknown, max: number, multiline: boolean) {
  if (typeof value !== 'string' || value.length < 1 || value.length > max || value.includes('\0')) return null;
  if (multiline ? /[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value) : /[\u0000-\u001F\u007F]/.test(value)) return null;
  if (new TextEncoder().encode(value).length > max * 3) return null;
  return value;
}
function cleanWho(value: unknown) {
  return typeof value === 'string' ? [...value].slice(0, 80).join('').replace(/[\u0000-\u001F\u007F]/g, '') : '';
}
function publicClassroom(doc: StoredDoc): ClassroomPublic {
  return {
    revision: doc.revision, title: doc.title, mode: doc.mode, currentStep: doc.currentStep,
    steps: doc.steps.map((s) => ({ ...s })), materials: doc.materials.map((m) => ({ ...m })),
    recordingUrl: doc.recordingUrl, chapters: doc.chapters.map((c) => ({ ...c })), updatedAt: doc.updatedAt,
  };
}
function publicSubmission(s: StoredSubmission): ClassroomSubmission {
  return { id: s.id, version: s.version, filename: s.filename, content: s.content, submittedAt: s.submittedAt, step: s.step, feedback: s.feedback, feedbackAt: s.feedbackAt };
}
function seatViewOf(doc: StoredDoc, row: SeatRow): ClassroomSeatView {
  return { classroom: publicClassroom(doc), progress: { ...row.progress }, submissions: row.submissions.map(publicSubmission) };
}
function sameSeat(a: ClassroomSeatRef, b: ClassroomSeatRef) {
  return a.labId === b.labId && a.n === b.n && a.code === b.code && a.sandboxId === b.sandboxId;
}
function seatSig(lab: ClassroomLab) {
  return lab.seats.map((s) => `${s.n}\0${s.code}\0${s.sandboxId}\0${s.who}`).join('\n');
}

function readDoc(raw: unknown): StoredDoc | null | Fail {
  if (raw == null) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail(503, '수업 안내를 확인하지 못했습니다.');
  const r = raw as Partial<StoredDoc>;
  const steps = readSteps(r.steps);
  const materials = readMaterials(r.materials);
  const chapters = !isFail(steps) && steps ? readChapters(r.chapters, steps.length) : null;
  if (!steps || isFail(steps) || !materials || isFail(materials) || !chapters || isFail(chapters)) return fail(503, '수업 안내를 확인하지 못했습니다.');
  const revision = r.revision, currentStep = r.currentStep;
  if ((r.mode !== 'demo' && r.mode !== 'together' && r.mode !== 'individual') || typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) return fail(503, '수업 안내를 확인하지 못했습니다.');
  if (typeof currentStep !== 'number' || !Number.isSafeInteger(currentStep) || currentStep < 0 || currentStep >= steps.length) return fail(503, '수업 안내를 확인하지 못했습니다.');
  const title = bounded(r.title, 60, false);
  const recording = r.recordingUrl === '' || (typeof r.recordingUrl === 'string' && parseRecording(r.recordingUrl) === r.recordingUrl) ? r.recordingUrl : null;
  if (!title || recording === null || typeof r.updatedAt !== 'number' || !Number.isFinite(r.updatedAt)) return fail(503, '수업 안내를 확인하지 못했습니다.');
  const endedAt = r.endedAt == null ? null : r.endedAt;
  const retainUntil = r.retainUntil == null ? null : r.retainUntil;
  if ((endedAt != null && (!Number.isFinite(endedAt) || endedAt < 0)) || (retainUntil != null && (!Number.isFinite(retainUntil) || retainUntil < 0))) return fail(503, '수업 안내를 확인하지 못했습니다.');
  if (!Array.isArray(r.roster) || r.roster.length > CLASSROOM_SEAT_CAP) return fail(503, '수업 안내를 확인하지 못했습니다.');
  const roster: { n: number; who: string }[] = [];
  for (const seat of r.roster) {
    if (!seat || typeof seat !== 'object' || !Number.isInteger(seat.n) || seat.n < 1 || seat.n > CLASSROOM_SEAT_CAP) return fail(503, '수업 안내를 확인하지 못했습니다.');
    roster.push({ n: seat.n, who: cleanWho(seat.who) });
  }
  return { revision, title, mode: r.mode, currentStep, steps, materials, recordingUrl: recording, chapters, updatedAt: r.updatedAt, endedAt, retainUntil, roster };
}
function readSteps(raw: unknown): ClassroomStep[] | null {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 12) return null;
  const steps: ClassroomStep[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') return null;
    const s = item as Partial<ClassroomStep>;
    const title = bounded(s.title, 40, false), instruction = bounded(s.instruction, 240, true), prompt = bounded(s.prompt, 480, true);
    if (typeof s.id !== 'string' || !STEP_ID.test(s.id) || seen.has(s.id) || !title || !instruction || !prompt) return null;
    seen.add(s.id);
    steps.push({ id: s.id, title, instruction, prompt });
  }
  return steps;
}
function readMaterials(raw: unknown): ClassroomMaterial[] | null {
  if (!Array.isArray(raw) || raw.length > 4) return null;
  const out: ClassroomMaterial[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') return null;
    const m = item as Partial<ClassroomMaterial>;
    const name = bounded(m.name, 40, false), content = bounded(m.content, 2000, true);
    if (!name || !content || name.includes('/') || name.includes('\\') || name === '.' || name === '..' || seen.has(name)) return null;
    seen.add(name);
    out.push({ name, content });
  }
  return out;
}
function readChapters(raw: unknown, stepCount: number): ClassroomChapter[] | null {
  if (!Array.isArray(raw) || raw.length > 12) return null;
  const out: ClassroomChapter[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') return null;
    const c = item as Partial<ClassroomChapter>;
    const title = bounded(c.title, 40, false);
    const seconds = c.seconds, step = c.step;
    if (!title || typeof seconds !== 'number' || !Number.isSafeInteger(seconds) || seconds < 0 || seconds > 86400 || typeof step !== 'number' || !Number.isSafeInteger(step) || step < 0 || step >= stepCount) return null;
    out.push({ title, seconds, step });
  }
  return out;
}
function parseRecording(value: unknown): string | Fail {
  if (value === '') return '';
  if (typeof value !== 'string' || value.length > 400 || /[\s\u0000-\u001F\u007F]/.test(value) || !value.startsWith('https://')) return fail(400, '녹화 주소는 빈 값이나 https 주소만 가능합니다.');
  let url: URL;
  try { url = new URL(value); } catch { return fail(400, '녹화 주소가 올바르지 않습니다.'); }
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname) return fail(400, '녹화 주소는 빈 값이나 https 주소만 가능합니다.');
  return value;
}
function submissionOk(raw: unknown): StoredSubmission | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Partial<StoredSubmission>;
  if (typeof s.id !== 'string' || !UUID.test(s.id) || typeof s.requestId !== 'string' || !UUID.test(s.requestId)) return null;
  const version = s.version, step = s.step;
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1 || s.filename !== CLASSROOM_FILE_NAME) return null;
  if (typeof s.content !== 'string' || s.content.includes('\0') || /[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(s.content)) return null;
  if (new TextEncoder().encode(s.content).length > CLASSROOM_BYTES) return null;
  if (typeof s.submittedAt !== 'number' || !Number.isFinite(s.submittedAt) || typeof step !== 'number' || !Number.isSafeInteger(step) || step < 0 || step > 11) return null;
  if (typeof s.feedback !== 'string' || s.feedback.length > 1000 || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(s.feedback)) return null;
  if (s.feedbackAt != null && (typeof s.feedbackAt !== 'number' || !Number.isFinite(s.feedbackAt))) return null;
  return { id: s.id, requestId: s.requestId, version, filename: CLASSROOM_FILE_NAME, content: s.content, submittedAt: s.submittedAt, step, feedback: s.feedback, feedbackAt: s.feedbackAt ?? null };
}
function readSeat(raw: unknown): SeatRow | null | Fail {
  if (raw == null) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail(503, '제출 기록을 확인하지 못했습니다.');
  const r = raw as Partial<SeatRow>;
  const progress = r.progress;
  if (!progress || !Number.isSafeInteger(progress.step) || progress.step < 0 || progress.step > 11 || typeof progress.completed !== 'boolean' || !Number.isFinite(progress.updatedAt)) return fail(503, '제출 기록을 확인하지 못했습니다.');
  if (!Array.isArray(r.submissions) || r.submissions.length > CLASSROOM_SUBMISSION_CAP || !Array.isArray(r.pending) || r.pending.length > PENDING_CAP || !Array.isArray(r.rejected) || r.rejected.length > REJECTED_CAP) return fail(503, '제출 기록을 확인하지 못했습니다.');
  const submissions: StoredSubmission[] = [];
  for (const item of r.submissions) {
    const parsed = submissionOk(item);
    if (!parsed) return fail(503, '제출 기록을 확인하지 못했습니다.');
    submissions.push(parsed);
  }
  const pending: Pending[] = [];
  for (const item of r.pending) {
    if (!item || typeof item.requestId !== 'string' || !UUID.test(item.requestId) || !UUID.test(item.submissionId) || typeof item.sandboxId !== 'string' || !SEAT_CODE.test(item.code)) return fail(503, '제출 기록을 확인하지 못했습니다.');
    pending.push({ requestId: item.requestId, submissionId: item.submissionId, sandboxId: item.sandboxId, code: item.code, at: Number.isFinite(item.at) ? item.at : 0 });
  }
  if (r.rejected.some((id) => typeof id !== 'string' || !UUID.test(id))) return fail(503, '제출 기록을 확인하지 못했습니다.');
  return { progress: { step: progress.step, completed: progress.completed, updatedAt: progress.updatedAt }, submissions, pending, rejected: [...r.rejected] };
}
function textOk(content: string) {
  return !content.includes('\0') && !/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(content) && new TextEncoder().encode(content).length <= CLASSROOM_BYTES;
}

const PATCH_KEYS = new Set(['title', 'mode', 'currentStep', 'steps', 'materials', 'recordingUrl', 'chapters']);
function applyPatch(doc: StoredDoc, patch: unknown): StoredDoc | Fail {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return fail(400, '수업 안내 형식이 올바르지 않습니다.');
  const raw = patch as Record<string, unknown>;
  const keys = Object.keys(raw);
  if (!keys.length || keys.some((key) => !PATCH_KEYS.has(key))) return fail(400, '수업 안내에 모르는 항목이 있습니다.');
  const next = readDoc(doc);
  if (!next || isFail(next)) return fail(503, '수업 안내를 확인하지 못했습니다.');
  if ('title' in raw) {
    const title = bounded(raw.title, 60, false);
    if (!title) return fail(400, '수업 이름이 올바르지 않습니다.');
    next.title = title;
  }
  if ('mode' in raw) {
    if (raw.mode !== 'demo' && raw.mode !== 'together' && raw.mode !== 'individual') return fail(400, '수업 방식이 올바르지 않습니다.');
    next.mode = raw.mode;
  }
  if ('steps' in raw) {
    const steps = readSteps(raw.steps);
    if (!steps) return fail(400, '단계가 올바르지 않습니다.');
    next.steps = steps;
  }
  if ('currentStep' in raw) {
    const current = raw.currentStep;
    if (typeof current !== 'number' || !Number.isSafeInteger(current) || current < 0 || current >= next.steps.length) return fail(400, '현재 단계가 올바르지 않습니다.');
    next.currentStep = current;
  } else if (next.currentStep >= next.steps.length) return fail(400, '현재 단계가 올바르지 않습니다.');
  if ('materials' in raw) {
    const materials = readMaterials(raw.materials);
    if (!materials) return fail(400, '자료가 올바르지 않습니다.');
    next.materials = materials;
  }
  if ('recordingUrl' in raw) {
    const recording = parseRecording(raw.recordingUrl);
    if (isFail(recording)) return recording;
    next.recordingUrl = recording;
  }
  if ('chapters' in raw) {
    const chapters = readChapters(raw.chapters, next.steps.length);
    if (!chapters) return fail(400, '복습 구간이 올바르지 않습니다.');
    next.chapters = chapters;
  } else if (next.chapters.some((chapter) => chapter.step >= next.steps.length)) return fail(400, '복습 구간이 올바르지 않습니다.');
  if (new TextEncoder().encode(JSON.stringify(publicClassroom(next))).length > 96 * 1024) return fail(413, '수업 안내가 너무 큽니다.');
  return next;
}

export class LabClassroomService {
  async history(admin: string) {
    if (!await this.d.checkAdmin(admin)) return fail(401, '관리 세션이 만료됐습니다.');
    const records = await this.s.list<unknown>({ prefix: DOC_PREFIX, limit: 128 });
    const courses: { id: string; title: string; endedAt: number; retainUntil: number }[] = [];
    for (const [key, value] of records) {
      const doc = readDoc(value), id = key.slice(DOC_PREFIX.length);
      if (!doc || isFail(doc) || !LAB_ID.test(id) || doc.endedAt == null || doc.retainUntil == null || doc.retainUntil <= this.d.now()) continue;
      courses.push({ id, title: doc.title, endedAt: doc.endedAt, retainUntil: doc.retainUntil });
    }
    if (!await this.d.checkAdmin(admin)) return fail(401, '관리 세션이 만료됐습니다.');
    courses.sort((a,b) => b.endedAt - a.endedAt);
    return { courses };
  }
  constructor(private d: ClassroomDeps) {}
  private get s() { return this.d.storage; }

  async status(admin: string, id: string) {
    const bad = this.#id(id);
    if (bad) return bad;
    if (!(await this.d.checkAdmin(admin))) return fail(401, '관리 세션이 만료됐습니다.');
    const first = await this.#adminSnapshot(id);
    if (isFail(first)) return first;
    if (!(await this.d.checkAdmin(admin))) return fail(401, '관리 세션이 만료됐습니다.');
    const second = await this.#adminSnapshot(id);
    if (isFail(second)) return second;
    if (JSON.stringify(first) !== JSON.stringify(second)) return fail(409, '수업 상태가 바뀌었습니다. 다시 확인하세요.');
    return second;
  }

  async teacherStatus(token: string, id: string) {
    const bad = this.#id(id);
    if (bad) return bad;
    const opened = await this.#teacher(token, id);
    if (isFail(opened)) return opened;
    const first = await this.#adminSnapshot(id);
    if (isFail(first)) return first;
    const again = await this.#teacher(token, id);
    if (isFail(again)) return again;
    const second = await this.#adminSnapshot(id);
    if (isFail(second)) return second;
    if (JSON.stringify(first) !== JSON.stringify(second)) return fail(409, '수업 상태가 바뀌었습니다. 다시 확인하세요.');
    return second;
  }

  async update(admin: string, id: string, revision: unknown, patch: unknown) {
    const bad = this.#id(id) ?? this.#revision(revision);
    if (bad) return bad;
    if (!(await this.d.checkAdmin(admin))) return fail(401, '관리 세션이 만료됐습니다.');
    try {
      return await this.s.transaction(async (tx) => {
        if (!(await this.d.checkAdmin(admin))) return fail(401, '관리 세션이 만료됐습니다.');
        const live = await this.d.live(id, tx);
        if (isFail(live)) return live;
        const stored = readDoc(await tx.get(classroomDocKey(id)));
        if (isFail(stored)) return stored;
        const doc = stored ?? defaultDoc();
        if (doc.endedAt != null || doc.retainUntil != null) return fail(410, '모임이 끝났습니다.');
        if (doc.revision !== revision) return fail(409, '수업 안내가 바뀌었습니다. 다시 확인하세요.');
        const next = applyPatch(doc, patch);
        if (isFail(next)) return next;
        for (const seat of live.seats) {
          const row = readSeat(await tx.get(classroomSeatKey(id, seat.n)));
          if (isFail(row)) return row;
          if (row && row.progress.step >= next.steps.length) return fail(409, '참여자 진행보다 단계를 줄일 수 없습니다.');
        }
        const again = await this.d.live(id, tx);
        if (isFail(again)) return again;
        if (!(await this.d.checkAdmin(admin)) || seatSig(live) !== seatSig(again)) return seatSig(live) === seatSig(again) ? fail(401, '관리 세션이 만료됐습니다.') : fail(409, '자리 정보가 바뀌었습니다. 다시 확인하세요.');
        const raced = readDoc(await tx.get(classroomDocKey(id)));
        if (isFail(raced) || (raced?.revision ?? 0) !== revision) return fail(409, '수업 안내가 바뀌었습니다. 다시 확인하세요.');
        const saved: StoredDoc = { ...next, revision: doc.revision + 1, updatedAt: this.d.now(), endedAt: null, retainUntil: null, roster: again.seats.map((seat) => ({ n: seat.n, who: cleanWho(seat.who) })) };
        await tx.put(classroomDocKey(id), saved);
        return this.#participants(tx, id, saved, again.seats);
      });
    } catch {
      return fail(503, '수업 안내를 저장하지 못했습니다.');
    }
  }

  async feedback(admin: string, id: string, n: unknown, submissionId: unknown, feedback: unknown) {
    const bad = this.#id(id) ?? this.#seatNo(n) ?? this.#uuid(submissionId, '제출물');
    if (bad) return bad;
    if (typeof feedback !== 'string' || feedback.length > 1000 || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(feedback)) return fail(400, '피드백이 올바르지 않습니다.');
    if (!(await this.d.checkAdmin(admin))) return fail(401, '관리 세션이 만료됐습니다.');
    const seatNo = n as number;
    const target = submissionId as string;
    try {
      return await this.s.transaction(async (tx) => {
        if (!(await this.d.checkAdmin(admin))) return fail(401, '관리 세션이 만료됐습니다.');
        const live = await this.d.live(id, tx);
        if (isFail(live)) return live;
        if (!live.seats.some((seat) => seat.n === seatNo)) return fail(404, '없는 자리입니다.');
        const row = readSeat(await tx.get(classroomSeatKey(id, seatNo))) ?? emptySeat();
        if (isFail(row)) return row;
        const stored = readDoc(await tx.get(classroomDocKey(id)));
        if (isFail(stored)) return stored;
        const doc = stored ?? defaultDoc();
        if (doc.endedAt != null) return fail(410, '모임이 끝났습니다.');
        const found = row.submissions.find((item) => item.id === target);
        if (!found) return fail(404, '제출물을 찾지 못했습니다.');
        found.feedback = feedback;
        found.feedbackAt = feedback ? this.d.now() : null;
        const again = await this.d.live(id, tx);
        if (isFail(again)) return again;
        if (!(await this.d.checkAdmin(admin))) return fail(401, '관리 세션이 만료됐습니다.');
        const owner = live.seats.find((seat) => seat.n === seatNo);
        if (!again.seats.some((seat) => seat.n === seatNo && seat.code === owner?.code && seat.sandboxId === owner?.sandboxId)) return fail(409, '자리 정보가 바뀌었습니다. 다시 확인하세요.');
        await tx.put(classroomSeatKey(id, seatNo), row);
        return this.#participants(tx, id, doc, again.seats);
      });
    } catch {
      return fail(503, '피드백을 저장하지 못했습니다.');
    }
  }

  async seatStatus(code: string) {
    const ref = await this.d.seat(code);
    if (isFail(ref)) return ref;
    const first = await this.#seatSnapshot(ref);
    if (isFail(first)) return first;
    const again = await this.d.seat(code);
    if (isFail(again)) return again;
    if (!sameSeat(ref, again)) return fail(409, '자리 정보가 바뀌었습니다. 다시 확인하세요.');
    const second = await this.#seatSnapshot(again);
    if (isFail(second)) return second;
    if (JSON.stringify(first) !== JSON.stringify(second)) return fail(409, '수업 상태가 바뀌었습니다. 다시 확인하세요.');
    return second;
  }

  async progress(code: string, step: unknown, completed: unknown) {
    if (!Number.isSafeInteger(step) || (step as number) < 0 || (step as number) > 11 || typeof completed !== 'boolean') return fail(400, '진행 단계가 올바르지 않습니다.');
    const ref = await this.d.seat(code);
    if (isFail(ref)) return ref;
    const chosen = step as number;
    try {
      return await this.s.transaction(async (tx) => {
        const live = await this.d.seatIn(code, tx);
        if (isFail(live)) return live;
        if (!sameSeat(ref, live)) return fail(409, '자리 정보가 바뀌었습니다. 다시 확인하세요.');
        const stored = readDoc(await tx.get(classroomDocKey(live.labId)));
        if (isFail(stored)) return stored;
        const doc = stored ?? defaultDoc();
        if (doc.endedAt != null) return fail(410, '모임이 끝났습니다.');
        if (chosen >= doc.steps.length) return fail(400, '진행 단계가 올바르지 않습니다.');
        const row = readSeat(await tx.get(classroomSeatKey(live.labId, live.n))) ?? emptySeat();
        if (isFail(row)) return row;
        row.progress = { step: chosen, completed, updatedAt: this.d.now() };
        const again = await this.d.seatIn(code, tx);
        if (isFail(again) || !sameSeat(live, again)) return fail(409, '자리 정보가 바뀌었습니다. 다시 확인하세요.');
        await tx.put(classroomSeatKey(live.labId, live.n), row);
        return seatViewOf(doc, row);
      });
    } catch {
      return fail(503, '진행을 저장하지 못했습니다.');
    }
  }

  async submit(code: string, requestId: unknown, filename: unknown) {
    if (filename !== CLASSROOM_FILE_NAME) return fail(400, '제출 파일은 결과.txt 만 가능합니다.');
    const bad = this.#uuid(requestId, '제출 요청');
    if (bad) return bad;
    const ref = await this.d.seat(code);
    if (isFail(ref)) return ref;
    const id = requestId as string;
    let claim: { kind: 'read'; submissionId: string } | { kind: 'replay'; view: ClassroomSeatView } | Fail;
    try { claim = await this.s.transaction((tx) => this.#claim(tx, ref, id)); }
    catch { return fail(503, '제출을 저장하지 못했습니다.'); }
    if (isFail(claim)) return claim;
    if (claim.kind === 'replay') return claim.view;
    let read: { content: string } | Fail;
    try { read = await this.d.readFile(ref, () => true); }
    catch { read = fail(503, '결과.txt 를 읽지 못했습니다. 같은 요청으로 다시 확인하세요.'); }
    if (!isFail(read) && (typeof read.content !== 'string' || !textOk(read.content))) read = fail(400, '결과.txt 가 올바른 UTF-8 텍스트가 아닙니다.');
    try {
      return await this.s.transaction((tx) => this.#finish(tx, ref, id, claim.submissionId, read));
    } catch {
      return fail(503, '제출을 확인하지 못했습니다. 같은 요청으로 다시 확인하세요.');
    }
  }

  /** 수업 정리가 자리·샌드박스를 지우기 전에 검토 명단만 고정한다. 제출 본문은 지우지 않는다. */
  async retain(id: string, roster: { n: number; who: string }[]) {
    const bad = this.#id(id);
    if (bad) return bad;
    const seats = roster.filter((seat) => Number.isInteger(seat.n) && seat.n >= 1 && seat.n <= CLASSROOM_SEAT_CAP).slice(0, CLASSROOM_SEAT_CAP);
    const intentKey = RETAIN_PREFIX + id;
    const intent = await this.s.transaction(async tx => {
      const prior = await tx.get<RetainIntent>(intentKey);
      if (prior) return prior;
      const next = { at: this.d.now(), roster: seats.map(seat => ({n:seat.n,who:cleanWho(seat.who)})) };
      await tx.put(intentKey,next);
      return next;
    });
    // Keep a small durable retry before cleanup removes the live lab record.
    await this.d.schedule(this.d.now() + 60_000);
    const at = intent.at, until = at + CLASSROOM_RETENTION_MS;
    let kept = false, deadline = until;
    await this.s.transaction(async (tx) => {
      const stored = readDoc(await tx.get(classroomDocKey(id)));
      if (isFail(stored)) throw Error('invalid retained classroom');
      let any = !!stored;
      if (!any) for (const seat of seats) if (await tx.get(classroomSeatKey(id, seat.n))) { any = true; break; }
      if (!any) return;
      const doc = stored ?? defaultDoc();
      doc.endedAt = doc.endedAt ?? at;
      doc.retainUntil = doc.retainUntil ?? until;
      deadline = doc.retainUntil;
      doc.roster = intent.roster;
      await tx.put(classroomDocKey(id), doc);
      kept = true;
    });
    if (kept) await this.d.schedule(deadline);
    await this.s.delete(intentKey);
    return { ok: true as const };
  }

  /** 검토 기간이 지난 수업 문서와 그 자리 1..20 키만 지운다. */
  async alarm(t: number) {
    let next = Infinity;
    const intents = await this.s.list<RetainIntent>({prefix:RETAIN_PREFIX,limit:32});
    for (const [key,intent] of intents) {
      const id=key.slice(RETAIN_PREFIX.length);
      if (!LAB_ID.test(id)) { await this.s.delete(key); continue; }
      if (Number.isFinite(intent.at) && intent.at + CLASSROOM_RETENTION_MS <= t) {
        await this.s.delete([key,classroomDocKey(id),...Array.from({length:CLASSROOM_SEAT_CAP},(_,i)=>classroomSeatKey(id,i+1))]);
      } else {
        try { await this.retain(id,intent.roster); } catch { next=Math.min(next,t+60_000); }
      }
    }
    if (intents.size===32) next=Math.min(next,t+60_000);
    const cursor=await this.s.get<string>(GC_CURSOR);
    const listed = await this.s.list<unknown>({ prefix: DOC_PREFIX, limit: 128, ...(cursor ? {startAfter:cursor} : {}) });
    let removed = 0;
    let last = cursor;
    for (const [key, value] of listed) {
      last=key;
      const id = key.slice(DOC_PREFIX.length);
      if (!LAB_ID.test(id)) continue;
      const doc = readDoc(value);
      if (!doc || isFail(doc) || doc.retainUntil == null) continue;
      if (doc.retainUntil > t) { next = Math.min(next, doc.retainUntil); continue; }
      const keys = [key];
      for (let n = 1; n <= CLASSROOM_SEAT_CAP; n++) keys.push(classroomSeatKey(id, n));
      await this.s.delete(keys);
      removed++;
      if (removed >= 32) { next = Math.min(next, t + 1000); break; }
    }
    if (listed.size >= 128 || removed >= 32) {
      if(last) await this.s.put(GC_CURSOR,last);
      next = Math.min(next, t + 60_000);
    } else {
      await this.s.delete(GC_CURSOR);
      if(cursor) next=Math.min(next,t+60_000);
    }
    return next;
  }

  async #claim(tx: Tx, ref: ClassroomSeatRef, requestId: string): Promise<{ kind: 'read'; submissionId: string } | { kind: 'replay'; view: ClassroomSeatView } | Fail> {
    const live = await this.d.seatIn(ref.code, tx);
    if (isFail(live)) return live;
    if (!sameSeat(ref, live)) return fail(409, '자리 정보가 바뀌었습니다. 다시 확인하세요.');
    const stored = readDoc(await tx.get(classroomDocKey(live.labId)));
    if (isFail(stored)) return stored;
    const doc = stored ?? defaultDoc();
    if (doc.endedAt != null) return fail(410, '모임이 끝났습니다.');
    const row = readSeat(await tx.get(classroomSeatKey(live.labId, live.n))) ?? emptySeat();
    if (isFail(row)) return row;
    const obsolete = row.pending.filter(item => item.sandboxId !== live.sandboxId || item.code !== live.code);
    if (obsolete.length) {
      row.rejected = [...row.rejected, ...obsolete.map(item=>item.requestId)].slice(-REJECTED_CAP);
      row.pending = row.pending.filter(item => item.sandboxId === live.sandboxId && item.code === live.code);
      await tx.put(classroomSeatKey(live.labId, live.n),row);
    }
    const done = row.submissions.find((item) => item.requestId === requestId);
    if (done) return { kind: 'replay', view: seatViewOf(doc, row) };
    if (row.rejected.includes(requestId)) return fail(409, '같은 요청 ID는 바뀐 자리에 다시 쓸 수 없습니다.');
    const pending = row.pending.find((item) => item.requestId === requestId);
    if (pending) {
      if (pending.sandboxId !== live.sandboxId || pending.code !== live.code) return fail(409, '같은 요청 ID는 바뀐 자리에 다시 쓸 수 없습니다.');
      return { kind: 'read', submissionId: pending.submissionId };
    }
    if (row.submissions.length >= CLASSROOM_SUBMISSION_CAP) return fail(409, '제출은 자리마다 10개까지입니다.');
    if (row.pending.length >= PENDING_CAP) return fail(409, '제출 확인이 너무 많이 대기 중입니다. 같은 요청으로 다시 확인하세요.');
    const submissionId = crypto.randomUUID();
    row.pending.push({ requestId, submissionId, sandboxId: live.sandboxId, code: live.code, at: this.d.now() });
    const again = await this.d.seatIn(ref.code, tx);
    if (isFail(again) || !sameSeat(live, again)) return fail(409, '자리 정보가 바뀌었습니다. 다시 확인하세요.');
    await tx.put(classroomSeatKey(live.labId, live.n), row);
    return { kind: 'read', submissionId };
  }

  async #finish(tx: Tx, ref: ClassroomSeatRef, requestId: string, submissionId: string, read: { content: string } | Fail): Promise<ClassroomSeatView | Fail> {
    const live = await this.d.seatIn(ref.code, tx);
    const key = classroomSeatKey(ref.labId, ref.n);
    const row = readSeat(await tx.get(key)) ?? emptySeat();
    if (isFail(row)) return row;
    const stored = readDoc(await tx.get(classroomDocKey(ref.labId)));
    if (isFail(stored)) return stored;
    const doc = stored ?? defaultDoc();
    const done = row.submissions.find((item) => item.requestId === requestId);
    if (done && !isFail(live) && sameSeat(ref, live) && doc.endedAt == null) return seatViewOf(doc, row);
    const drop = () => { row.pending = row.pending.filter((item) => item.requestId !== requestId); };
    if (isFail(live) || !sameSeat(ref, live) || doc.endedAt != null) {
      return isFail(live) ? (live.status === 410 ? live : fail(409, '자리 정보가 바뀌었습니다. 다시 확인하세요.')) : doc.endedAt != null ? fail(410, '모임이 끝났습니다.') : fail(409, '자리 정보가 바뀌었습니다. 다시 확인하세요.');
    }
    if (isFail(read)) {
      if (read.status >= 500) return read;
      const had = row.pending.some((item) => item.requestId === requestId);
      drop();
      const again = await this.d.seatIn(ref.code, tx);
      if (isFail(again) || !sameSeat(live, again)) return fail(409, '자리 정보가 바뀌었습니다. 다시 확인하세요.');
      if (had) await tx.put(key, row);
      return read;
    }
    if (row.submissions.length >= CLASSROOM_SUBMISSION_CAP) {
      drop();
      row.rejected = [...row.rejected, requestId].slice(-REJECTED_CAP);
      await tx.put(key, row);
      return fail(409, '제출은 자리마다 10개까지입니다.');
    }
    const pending = row.pending.find((item) => item.requestId === requestId && item.submissionId === submissionId && item.sandboxId === ref.sandboxId && item.code === ref.code);
    if (!pending) return fail(503, '제출을 확인하지 못했습니다. 같은 요청으로 다시 확인하세요.');
    const version = row.submissions.reduce((max, item) => Math.max(max, item.version), 0) + 1;
    drop();
    row.submissions.push({ id: submissionId, requestId, version, filename: CLASSROOM_FILE_NAME, content: read.content, submittedAt: this.d.now(), step: row.progress.step, feedback: '', feedbackAt: null });
    const again = await this.d.seatIn(ref.code, tx);
    if (isFail(again) || !sameSeat(live, again)) return fail(409, '자리 정보가 바뀌었습니다. 다시 확인하세요.');
    await tx.put(key, row);
    return seatViewOf(doc, row);
  }

  async #teacher(token: string, id: string) {
    const labs = await this.d.teacherLabs(token);
    if (isFail(labs)) return labs;
    const hit = labs.find((lab) => lab && lab.id === id);
    if (!hit) return fail(404, '없는 수업이거나 볼 수 없습니다.');
    if (hit.ending) return fail(410, '모임이 끝났습니다.');
    return null;
  }

  async #adminSnapshot(id: string): Promise<ClassroomAdminView | Fail> {
    const found = await this.d.lab(id);
    const stored = readDoc(await this.s.get(classroomDocKey(id)));
    if (isFail(stored)) return stored;
    const at = this.d.now();
    const retained = !!stored && stored.retainUntil != null && stored.retainUntil > at;
    if (!found && !retained) return fail(404, '없는 수업입니다.');
    const seats = found?.seats.length ? found.seats : (stored?.roster ?? []).map((seat) => ({ labId: id, n: seat.n, who: seat.who, code: '', sandboxId: '' }));
    return this.#participants(this.s, id, stored ?? defaultDoc(), seats);
  }

  async #participants(tx: Pick<DurableObjectStorage, 'get'>, id: string, doc: StoredDoc, seats: { n: number; who: string }[]): Promise<ClassroomAdminView | Fail> {
    const participants: ClassroomParticipant[] = [];
    for (const seat of seats.slice(0, CLASSROOM_SEAT_CAP)) {
      if (!Number.isInteger(seat.n) || seat.n < 1 || seat.n > CLASSROOM_SEAT_CAP) continue;
      const row = readSeat(await tx.get(classroomSeatKey(id, seat.n)));
      if (isFail(row)) return row;
      const progress = row?.progress ?? emptyProgress();
      participants.push({ n: seat.n, who: cleanWho(seat.who), progress: { ...progress }, submissions: row ? row.submissions.map(publicSubmission) : [] });
    }
    participants.sort((a, b) => a.n - b.n);
    return { classroom: publicClassroom(doc), participants };
  }

  async #seatSnapshot(ref: ClassroomSeatRef): Promise<ClassroomSeatView | Fail> {
    const stored = readDoc(await this.s.get(classroomDocKey(ref.labId)));
    if (isFail(stored)) return stored;
    const doc = stored ?? defaultDoc();
    if (doc.endedAt != null) return fail(410, '모임이 끝났습니다.');
    const row = readSeat(await this.s.get(classroomSeatKey(ref.labId, ref.n)));
    if (isFail(row)) return row;
    return seatViewOf(doc, row ?? emptySeat());
  }

  #id(id: unknown): Fail | null { return typeof id === 'string' && LAB_ID.test(id) ? null : fail(400, '실습실 ID가 올바르지 않습니다.'); }
  #revision(value: unknown): Fail | null { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? null : fail(400, '수업 개정 번호가 올바르지 않습니다.'); }
  #seatNo(value: unknown): Fail | null { return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= CLASSROOM_SEAT_CAP ? null : fail(400, '자리 번호가 올바르지 않습니다.'); }
  #uuid(value: unknown, label: string): Fail | null { return typeof value === 'string' && UUID.test(value) ? null : fail(400, `${label} ID가 올바르지 않습니다.`); }
}
