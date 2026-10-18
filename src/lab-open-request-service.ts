// 참여자 실습실 열기 요청 인박스.
// 공급자 호출이나 자리 발급은 하지 않는다. 관측된 생성 결과만 finish로 기록한다.
// 비밀·출처 원문은 저장하지 않고, 같은 선택의 동작 ID는 재시작 후에도 유지한다.
import type { Fail } from './state';

export const OPEN_REQ_PREFIX = 'labopen:req:';
export const OPEN_RATE_PREFIX = 'labopen:rate:';
export const OPEN_MAX_AGE = 24 * 3600e3;
export const OPEN_RETAIN = 48 * 3600e3;
export const OPEN_FIRST_USE = 5 * 60e3;
export const OPEN_RATE_LIMIT = 5;
export const OPEN_RATE_WINDOW = 10 * 60e3;
export const OPEN_PENDING_MAX = 128;
export const OPEN_LIST_MAX = 128;
export const OPEN_CHOICE_MAX = 8192;
/** 요청 행과 출처 한도 행을 합쳐 스캔하는 상한. 넘치면 새 요청은 거절한다. */
export const OPEN_STORE_MAX = 4096;
export const OPEN_DENIED_MESSAGE = '실습실 열기 요청이 거절됐습니다.';

const CONTROL = /[\u0000-\u001F\u007F-\u009F]/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OP_ID = /^lc_\d{13}_[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const PAGE = 128;
const MAX_RECORD_BYTES = 32_768;
const BASE_FIELDS = ['id', 'secret', 'mode', 'name', 'purpose', 'issuedAt'] as const;

const fail = (status: number, error: string): Fail => ({ status, error });
const isFail = (x: unknown): x is Fail => {
  if (!x || typeof x !== 'object') return false;
  const row = x as { status?: unknown; error?: unknown };
  return typeof row.status === 'number' && typeof row.error === 'string';
};

export type OpenRequestState = 'pending' | 'approving' | 'ready' | 'denied' | 'expired';
export interface OpenRequestResult { labId: string; n: number; seatCode: string; expiresAt: number }
export interface OpenRequestRecord {
  id: string;
  secretHash: string;
  mode: 'practice' | 'join';
  name: string;
  purpose: string;
  targetLabId?: string;
  source: string;
  createdAt: number;
  expiresAt: number;
  state: OpenRequestState;
  choice?: string;
  operationId?: string;
  approvedAt?: number;
  result?: OpenRequestResult;
  payloadHash: string;
}
export interface OpenRequestAck { id: string; state: OpenRequestState; expiresAt: number }
export interface OpenRequestStatusView {
  id: string;
  mode: 'practice' | 'join';
  name: string;
  purpose: string;
  targetLabId?: string;
  state: OpenRequestState;
  createdAt: number;
  expiresAt: number;
  message?: string;
  result?: OpenRequestResult;
}
export interface OpenRequestListItem {
  id: string;
  mode: 'practice' | 'join';
  name: string;
  purpose: string;
  targetLabId?: string;
  state: OpenRequestState;
  createdAt: number;
  expiresAt: number;
  choice?: string;
  result?: { labId: string; n: number; expiresAt: number };
}
export interface LabOpenDeps {
  storage: Pick<DurableObjectStorage, 'get' | 'put' | 'list' | 'delete' | 'transaction'>;
  now(): number;
  checkAdmin(token: string): Promise<boolean>;
  schedule(t: number): Promise<void>;
}

interface Parsed {
  id: string;
  secret: string;
  mode: 'practice' | 'join';
  name: string;
  purpose: string;
  issuedAt: number;
  targetLabId?: string;
}
interface RateHit { id: string; at: number }
interface RateRow { hits: RateHit[] }
interface Scheduled { schedule: boolean; ack: OpenRequestAck }
type Tx = DurableObjectTransaction;

const reqKey = (id: string) => OPEN_REQ_PREFIX + id;
const rateKey = (sourceHash: string) => OPEN_RATE_PREFIX + sourceHash;
const adminFail = () => fail(401, '관리 세션이 만료됐습니다.');

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}
function plain(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === 'object' && !Array.isArray(x) && Object.getPrototypeOf(x) === Object.prototype;
}
function uuidOk(id: unknown): id is string {
  return typeof id === 'string' && UUID.test(id);
}
function textOk(v: unknown, max: number): v is string {
  return typeof v === 'string' && v.length <= max && !CONTROL.test(v);
}
function secretOk(v: unknown): v is string {
  if (typeof v !== 'string' || v.length !== 43) return false;
  for (let i = 0; i < v.length; i++) if (B64.indexOf(v.charAt(i)) < 0) return false;
  return (B64.indexOf(v.charAt(42)) & 3) === 0;
}
function intOk(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v);
}
function sameHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
function overBudget(key: string, value: unknown): Fail | null {
  const json = JSON.stringify(value);
  if (json == null || utf8Bytes(key) + utf8Bytes(json) > MAX_RECORD_BYTES) return fail(429, '저장 용량 한도를 초과했습니다.');
  return null;
}
async function sha256(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  let hex = '';
  for (const b of digest) hex += b.toString(16).padStart(2, '0');
  return hex;
}
function canonical(p: Parsed): string {
  const body: Record<string, string | number> = {
    id: p.id, issuedAt: p.issuedAt, mode: p.mode, name: p.name, purpose: p.purpose,
  };
  if (p.targetLabId !== undefined) body.targetLabId = p.targetLabId;
  const keys = Object.keys(body).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + JSON.stringify(body[k])).join(',') + '}';
}
function parseInput(input: unknown): Parsed | Fail {
  if (!plain(input)) return fail(400, '실습실 열기 요청 입력이 올바르지 않습니다.');
  const keys = Object.keys(input);
  const allowed = new Set<string>(BASE_FIELDS);
  if (Object.prototype.hasOwnProperty.call(input, 'targetLabId')) allowed.add('targetLabId');
  if (!BASE_FIELDS.every((k) => keys.includes(k)) || keys.some((k) => !allowed.has(k))) return fail(400, '실습실 열기 요청 항목이 올바르지 않습니다.');
  if (!uuidOk(input.id) || !secretOk(input.secret)) return fail(400, '실습실 열기 요청 입력이 올바르지 않습니다.');
  if (input.mode !== 'practice' && input.mode !== 'join') return fail(400, '실습실 열기 요청 입력이 올바르지 않습니다.');
  if (!textOk(input.name, 40) || !textOk(input.purpose, 200) || !intOk(input.issuedAt) || input.issuedAt < 0) return fail(400, '실습실 열기 요청 입력이 올바르지 않습니다.');
  const parsed: Parsed = { id: input.id, secret: input.secret, mode: input.mode, name: input.name, purpose: input.purpose, issuedAt: input.issuedAt };
  if (Object.prototype.hasOwnProperty.call(input, 'targetLabId')) {
    if (!textOk(input.targetLabId, 100)) return fail(400, '실습실 열기 요청 입력이 올바르지 않습니다.');
    parsed.targetLabId = input.targetLabId;
  }
  if (parsed.name.includes(parsed.secret) || parsed.purpose.includes(parsed.secret) || (parsed.targetLabId !== undefined && parsed.targetLabId.includes(parsed.secret))) {
    return fail(400, '실습실 열기 요청 입력이 올바르지 않습니다.');
  }
  return parsed;
}
function parseChoice(choice: unknown): string | Fail {
  if (typeof choice !== 'string' || choice.length === 0 || choice.length > OPEN_CHOICE_MAX || utf8Bytes(choice) > OPEN_CHOICE_MAX || CONTROL.test(choice)) return fail(400, '선택이 올바르지 않습니다.');
  try {
    const parsed: unknown = JSON.parse(choice);
    if (JSON.stringify(parsed) !== choice) return fail(400, '선택이 올바르지 않습니다.');
  } catch {
    return fail(400, '선택이 올바르지 않습니다.');
  }
  return choice;
}
function parseResult(input: unknown): OpenRequestResult | Fail {
  if (!plain(input)) return fail(400, '요청 결과가 올바르지 않습니다.');
  const keys = Object.keys(input);
  if (keys.length !== 4 || !keys.includes('labId') || !keys.includes('n') || !keys.includes('seatCode') || !keys.includes('expiresAt')) return fail(400, '요청 결과가 올바르지 않습니다.');
  if (!textOk(input.labId, 100) || input.labId.length < 1 || !textOk(input.seatCode, 200) || input.seatCode.length < 1) return fail(400, '요청 결과가 올바르지 않습니다.');
  if (!intOk(input.n) || input.n < 0 || input.n > 100000 || !intOk(input.expiresAt) || input.expiresAt < 0) return fail(400, '요청 결과가 올바르지 않습니다.');
  return { labId: input.labId, n: input.n, seatCode: input.seatCode, expiresAt: input.expiresAt };
}
function isResult(x: unknown): x is OpenRequestResult {
  if (!plain(x)) return false;
  return textOk(x.labId, 100) && x.labId.length >= 1 && intOk(x.n) && x.n >= 0 && x.n <= 100000
    && textOk(x.seatCode, 200) && x.seatCode.length >= 1 && intOk(x.expiresAt) && x.expiresAt >= 0;
}
function isRate(x: unknown): x is RateRow {
  if (!plain(x) || !Array.isArray(x.hits)) return false;
  return x.hits.every((hit) => plain(hit) && uuidOk(hit.id) && intOk(hit.at));
}
function isRecord(x: unknown): x is OpenRequestRecord {
  if (!plain(x) || !uuidOk(x.id) || typeof x.secretHash !== 'string' || !HEX64.test(x.secretHash)) return false;
  if (typeof x.payloadHash !== 'string' || !HEX64.test(x.payloadHash)) return false;
  if (x.mode !== 'practice' && x.mode !== 'join') return false;
  if (!textOk(x.name, 40) || !textOk(x.purpose, 200)) return false;
  if (x.targetLabId !== undefined && !textOk(x.targetLabId, 100)) return false;
  if (typeof x.source !== 'string' || !HEX64.test(x.source)) return false;
  if (!intOk(x.createdAt) || !intOk(x.expiresAt) || x.expiresAt !== x.createdAt + OPEN_MAX_AGE) return false;
  if (x.state !== 'pending' && x.state !== 'approving' && x.state !== 'ready' && x.state !== 'denied' && x.state !== 'expired') return false;
  const decided = x.state === 'approving' || x.state === 'ready';
  if (decided) {
    if (typeof x.choice !== 'string' || x.choice.length === 0 || x.choice.length > OPEN_CHOICE_MAX) return false;
    if (typeof x.operationId !== 'string' || !OP_ID.test(x.operationId) || !intOk(x.approvedAt)) return false;
  } else if (x.choice !== undefined || x.operationId !== undefined || x.approvedAt !== undefined) return false;
  if (x.state === 'ready') return isResult(x.result);
  return x.result === undefined;
}
function persist(rec: OpenRequestRecord): OpenRequestRecord {
  const out: OpenRequestRecord = {
    id: rec.id, secretHash: rec.secretHash, payloadHash: rec.payloadHash, mode: rec.mode, name: rec.name, purpose: rec.purpose,
    source: rec.source, createdAt: rec.createdAt, expiresAt: rec.expiresAt, state: rec.state,
  };
  if (rec.targetLabId !== undefined) out.targetLabId = rec.targetLabId;
  if (rec.choice !== undefined) out.choice = rec.choice;
  if (rec.operationId !== undefined) out.operationId = rec.operationId;
  if (rec.approvedAt !== undefined) out.approvedAt = rec.approvedAt;
  if (rec.result !== undefined) out.result = { labId: rec.result.labId, n: rec.result.n, seatCode: rec.result.seatCode, expiresAt: rec.result.expiresAt };
  return out;
}
function visibleState(rec: OpenRequestRecord, now: number): OpenRequestState {
  if (rec.state === 'pending' && now >= rec.expiresAt) return 'expired';
  if (rec.state === 'ready' && (!rec.result || rec.result.expiresAt <= now)) return 'expired';
  return rec.state;
}
function ackOf(rec: OpenRequestRecord, now: number): OpenRequestAck {
  return { id: rec.id, state: visibleState(rec, now), expiresAt: rec.expiresAt };
}
function statusView(rec: OpenRequestRecord, now: number): OpenRequestStatusView {
  const state = visibleState(rec, now);
  const view: OpenRequestStatusView = {
    id: rec.id, mode: rec.mode, name: rec.name, purpose: rec.purpose, state, createdAt: rec.createdAt, expiresAt: rec.expiresAt,
  };
  if (rec.targetLabId !== undefined) view.targetLabId = rec.targetLabId;
  if (state === 'denied') view.message = OPEN_DENIED_MESSAGE;
  if (state === 'ready' && rec.result) view.result = { labId: rec.result.labId, n: rec.result.n, seatCode: rec.result.seatCode, expiresAt: rec.result.expiresAt };
  return view;
}
function listItem(rec: OpenRequestRecord, now: number): OpenRequestListItem {
  const state = visibleState(rec, now);
  const item: OpenRequestListItem = {
    id: rec.id, mode: rec.mode, name: rec.name, purpose: rec.purpose, state, createdAt: rec.createdAt, expiresAt: rec.expiresAt,
  };
  if (rec.targetLabId !== undefined) item.targetLabId = rec.targetLabId;
  if ((state === 'approving' || state === 'ready') && rec.choice !== undefined) item.choice = rec.choice;
  if (state === 'ready' && rec.result) item.result = { labId: rec.result.labId, n: rec.result.n, expiresAt: rec.result.expiresAt };
  return item;
}
function sameResult(a: OpenRequestResult, b: OpenRequestResult): boolean {
  return a.labId === b.labId && a.n === b.n && a.seatCode === b.seatCode && a.expiresAt === b.expiresAt;
}
function operationId(now: number): string | null {
  const stamp = String(now);
  if (!/^\d{13}$/.test(stamp)) return null;
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return hex.length === 32 ? `lc_${stamp}_${hex}` : null;
}
function pruneHits(hits: readonly RateHit[], now: number): RateHit[] {
  const live: RateHit[] = [];
  for (const hit of hits) if (now - hit.at < OPEN_RATE_WINDOW && !live.some((row) => row.id === hit.id)) live.push({ id: hit.id, at: hit.at });
  return live;
}
function firstUse(issuedAt: number, now: number): Fail | null {
  if (issuedAt > now + OPEN_FIRST_USE) return fail(400, '요청 시각이 올바르지 않습니다.');
  if (now - issuedAt >= OPEN_RETAIN) return fail(410, '요청 기록이 만료됐습니다.');
  if (now - issuedAt >= OPEN_FIRST_USE) return fail(410, '요청 시각이 지났습니다. 새로 요청하세요.');
  return null;
}
async function readRows(tx: Tx, prefix: string): Promise<Map<string, unknown> | Fail> {
  const out = new Map<string, unknown>();
  let startAfter: string | undefined;
  for (let page = 0; page < OPEN_STORE_MAX / PAGE; page++) {
    const batch = await tx.list<unknown>({ prefix, limit: PAGE, startAfter });
    const keys = [...batch.keys()].sort();
    for (const key of keys) out.set(key, batch.get(key));
    if (batch.size < PAGE) return out;
    const last = keys[keys.length - 1];
    if (last === undefined) return out;
    startAfter = last;
  }
  const more = await tx.list<unknown>({ prefix, limit: 1, startAfter });
  return more.size > 0 ? fail(429, '저장된 요청이 한도를 넘었습니다.') : out;
}

export class LabOpenRequestService {
  constructor(private d: LabOpenDeps) {}

  async submit(input: unknown, source: string): Promise<OpenRequestAck | Fail> {
    const parsed = parseInput(input);
    if (isFail(parsed)) return parsed;
    if (typeof source !== 'string' || source.length === 0 || source.length > 512 || CONTROL.test(source)) return fail(400, '요청 출처가 올바르지 않습니다.');
    try {
      const secretHash = await sha256(parsed.secret);
      const payloadHash = await sha256(canonical(parsed));
      const sourceHash = await sha256(source);
      const outcome = await this.d.storage.transaction((tx) => this.#submitTx(tx, parsed, secretHash, payloadHash, sourceHash));
      if (isFail(outcome)) return outcome;
      if (outcome.schedule) {
        try { await this.d.schedule(this.d.now()); }
        catch { return fail(503, '요청 알림을 예약하지 못했습니다. 같은 요청으로 다시 시도하세요.'); }
      }
      return outcome.ack;
    } catch {
      return fail(503, '요청을 저장하지 못했습니다.');
    }
  }

  async status(id: unknown, secret: unknown): Promise<OpenRequestStatusView | Fail> {
    if (!uuidOk(id)) return fail(400, '요청 ID가 올바르지 않습니다.');
    if (!secretOk(secret)) return fail(400, '요청 비밀이 올바르지 않습니다.');
    try {
      const secretHash = await sha256(secret);
      return await this.d.storage.transaction(async (tx) => {
        const loaded = await this.#load(tx, id);
        if (isFail(loaded)) return loaded;
        if (!loaded) return fail(404, '요청이 없습니다.');
        if (!sameHex(loaded.secretHash, secretHash)) return fail(401, '요청 비밀이 올바르지 않습니다.');
        const now = this.d.now();
        if (now - loaded.createdAt >= OPEN_RETAIN) {
          await tx.delete(reqKey(id));
          return fail(410, '요청 기록이 만료됐습니다.');
        }
        const current = await this.#expirePending(tx, loaded, now);
        return statusView(current, now);
      });
    } catch {
      return fail(503, '요청을 확인하지 못했습니다.');
    }
  }

  async list(token: string): Promise<{ requests: OpenRequestListItem[]; now: number; total: number; truncated: boolean } | Fail> {
    if (typeof token !== 'string' || !(await this.d.checkAdmin(token))) return adminFail();
    try {
      return await this.d.storage.transaction(async (tx) => {
        if (!(await this.d.checkAdmin(token))) return adminFail();
        const rows = await readRows(tx, OPEN_REQ_PREFIX);
        if (isFail(rows)) return rows;
        if (!(await this.d.checkAdmin(token))) return adminFail();
        const now = this.d.now();
        const records: OpenRequestRecord[] = [];
        for (const [key, value] of rows) {
          if (!isRecord(value)) return fail(503, '요청 목록을 확인하지 못했습니다.');
          const kept = await this.#retain(tx, key, value, now);
          if (kept) records.push(await this.#expirePending(tx, kept, now));
        }
        const rank = (r: OpenRequestRecord) => r.state === 'pending' ? 0 : r.state === 'approving' ? 1 : 2;
        records.sort((a, b) => rank(a)-rank(b) || b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
        return { requests: records.slice(0, OPEN_LIST_MAX).map((rec) => listItem(rec, now)), now, total: records.length, truncated: records.length > OPEN_LIST_MAX };
      });
    } catch {
      return fail(503, '요청 목록을 확인하지 못했습니다.');
    }
  }

  async claim(token: string, id: unknown, choice: unknown): Promise<{ record: OpenRequestRecord; fresh: boolean } | Fail> {
    if (!uuidOk(id)) return fail(400, '요청 ID가 올바르지 않습니다.');
    const picked = parseChoice(choice);
    if (isFail(picked)) return picked;
    if (typeof token !== 'string' || !(await this.d.checkAdmin(token))) return adminFail();
    try {
      return await this.d.storage.transaction(async (tx) => {
        if (!(await this.d.checkAdmin(token))) return adminFail();
        const loaded = await this.#load(tx, id);
        if (isFail(loaded)) return loaded;
        if (!loaded) return fail(404, '요청이 없습니다.');
        if (!(await this.d.checkAdmin(token))) return adminFail();
        const now = this.d.now();
        const retained = await this.#retain(tx, reqKey(id), loaded, now);
        if (!retained) return fail(410, '요청 기록이 만료됐습니다.');
        const current = await this.#expirePending(tx, retained, now);
        if (current.state === 'expired' || (current.state === 'ready' && visibleState(current, now) === 'expired')) return fail(410, '요청이 만료됐습니다.');
        if (current.state === 'denied') return fail(409, '이미 거절된 요청입니다.');
        if (current.state === 'approving' || current.state === 'ready') {
          if (current.choice !== picked) return fail(409, '같은 요청에 다른 선택을 쓸 수 없습니다.');
          return { record: persist(current), fresh: false };
        }
        if (current.state !== 'pending') return fail(409, '이 요청은 승인할 수 없습니다.');
        const op = operationId(now);
        if (!op) return fail(503, '승인 동작을 만들지 못했습니다.');
        const next = persist({ ...current, state: 'approving', choice: picked, operationId: op, approvedAt: now });
        const tooBig = overBudget(reqKey(id), next);
        if (tooBig) return tooBig;
        if (!(await this.d.checkAdmin(token))) return adminFail();
        await tx.put(reqKey(id), next);
        return { record: next, fresh: true };
      });
    } catch {
      return fail(503, '요청을 승인하지 못했습니다.');
    }
  }

  async deny(token: string, id: unknown): Promise<{ ok: true } | Fail> {
    if (!uuidOk(id)) return fail(400, '요청 ID가 올바르지 않습니다.');
    if (typeof token !== 'string' || !(await this.d.checkAdmin(token))) return adminFail();
    try {
      return await this.d.storage.transaction(async (tx) => {
        if (!(await this.d.checkAdmin(token))) return adminFail();
        const loaded = await this.#load(tx, id);
        if (isFail(loaded)) return loaded;
        if (!loaded) return fail(404, '요청이 없습니다.');
        if (!(await this.d.checkAdmin(token))) return adminFail();
        const now = this.d.now();
        const retained = await this.#retain(tx, reqKey(id), loaded, now);
        if (!retained) return fail(410, '요청 기록이 만료됐습니다.');
        const current = await this.#expirePending(tx, retained, now);
        if (current.state === 'denied') return { ok: true as const };
        if (current.state === 'expired') return fail(410, '요청이 만료됐습니다.');
        if (current.state !== 'pending') return fail(409, '진행 중이거나 완료된 요청은 거절할 수 없습니다.');
        const next = persist({ ...current, state: 'denied' });
        if (!(await this.d.checkAdmin(token))) return adminFail();
        await tx.put(reqKey(id), next);
        return { ok: true as const };
      });
    } catch {
      return fail(503, '요청을 거절하지 못했습니다.');
    }
  }

  async get(id: string): Promise<OpenRequestRecord | undefined> {
    if (!uuidOk(id)) return undefined;
    return await this.d.storage.transaction(async (tx) => {
      const loaded = await this.#load(tx, id);
      if (isFail(loaded)) throw new Error('stored request');
      if (!loaded || this.d.now() - loaded.createdAt >= OPEN_RETAIN) {
        if (loaded) await tx.delete(reqKey(id));
        return undefined;
      }
      return persist(await this.#expirePending(tx, loaded, this.d.now()));
    });
  }

  async finish(id: string, operationIdValue: string, result: { labId: string; n: number; seatCode: string; expiresAt: number }): Promise<{ ok: true } | Fail> {
    if (!uuidOk(id) || !OP_ID.test(operationIdValue)) return fail(400, '승인 동작이 올바르지 않습니다.');
    const observed = parseResult(result);
    if (isFail(observed)) return observed;
    try {
      return await this.d.storage.transaction(async (tx) => {
        const loaded = await this.#load(tx, id);
        if (isFail(loaded)) return loaded;
        if (!loaded) return fail(404, '요청이 없습니다.');
        if (loaded.operationId !== operationIdValue || (loaded.state !== 'approving' && loaded.state !== 'ready')) return fail(409, '이 동작으로 마칠 수 있는 요청이 아닙니다.');
        if (loaded.state === 'ready') {
          if (!loaded.result || !sameResult(loaded.result, observed)) return fail(409, '요청 결과가 일치하지 않습니다.');
          return { ok: true as const };
        }
        const next = persist({ ...loaded, state: 'ready', result: observed });
        const tooBig = overBudget(reqKey(id), next);
        if (tooBig) return tooBig;
        await tx.put(reqKey(id), next);
        return { ok: true as const };
      });
    } catch {
      return fail(503, '요청 결과를 저장하지 못했습니다.');
    }
  }

  async pendingIds(): Promise<string[]> {
    return await this.d.storage.transaction(async (tx) => {
      const rows = await readRows(tx, OPEN_REQ_PREFIX);
      if (isFail(rows)) throw new Error('pending scan');
      const now = this.d.now();
      const ids: { id: string; createdAt: number }[] = [];
      for (const [key, value] of rows) {
        if (!isRecord(value)) continue;
        const kept = await this.#retain(tx, key, value, now);
        if (!kept) continue;
        const current = await this.#expirePending(tx, kept, now);
        if (current.state === 'pending') ids.push({ id: current.id, createdAt: current.createdAt });
      }
      ids.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      return ids.map((row) => row.id);
    });
  }

  /** 대기 만료와 48시간·출처 한도 정리만 한다. 생성은 다시 시도하지 않는다. */
  async alarm(t: number): Promise<number> {
    if (!intOk(t)) return Number.POSITIVE_INFINITY;
    return await this.d.storage.transaction(async (tx) => {
      let next = Number.POSITIVE_INFINITY;
      const rows = await readRows(tx, OPEN_REQ_PREFIX);
      if (!isFail(rows)) {
        for (const [key, value] of rows) {
          if (!isRecord(value)) {
            await tx.delete(key);
            continue;
          }
          if (t - value.createdAt >= OPEN_RETAIN) {
            await tx.delete(key);
            continue;
          }
          const current = await this.#expirePending(tx, value, t);
          const cleanupAt = current.createdAt + OPEN_RETAIN;
          if (cleanupAt < next) next = cleanupAt;
          if (current.state === 'pending' && current.expiresAt < next) next = current.expiresAt;
        }
      }
      const rates = await readRows(tx, OPEN_RATE_PREFIX);
      if (!isFail(rates)) {
        for (const [key, value] of rates) {
          if (!isRate(value)) {
            await tx.delete(key);
            continue;
          }
          const live = pruneHits(value.hits, t);
          if (live.length === 0) {
            await tx.delete(key);
            continue;
          }
          if (live.length !== value.hits.length) await tx.put(key, { hits: live });
          for (const hit of live) {
            const at = hit.at + OPEN_RATE_WINDOW;
            if (at < next) next = at;
          }
        }
      }
      return next;
    });
  }

  async #submitTx(tx: Tx, parsed: Parsed, secretHash: string, payloadHash: string, sourceHash: string): Promise<Scheduled | Fail> {
    const now = this.d.now();
    const loaded = await this.#load(tx, parsed.id);
    if (isFail(loaded)) return loaded;
    if (loaded) {
      if (now - loaded.createdAt >= OPEN_RETAIN) {
        await tx.delete(reqKey(parsed.id));
        return fail(410, '요청 기록이 만료됐습니다.');
      }
      if (!sameHex(loaded.secretHash, secretHash) || !sameHex(loaded.payloadHash, payloadHash)) return fail(409, '같은 요청 ID에 다른 입력은 쓸 수 없습니다.');
      const current = await this.#expirePending(tx, loaded, now);
      return { schedule: current.state === 'pending', ack: ackOf(current, now) };
    }
    const stale = firstUse(parsed.issuedAt, now);
    if (stale) return stale;
    const rows = await readRows(tx, OPEN_REQ_PREFIX);
    if (isFail(rows)) return rows;
    let pending = 0;
    for (const value of rows.values()) {
      if (!isRecord(value)) return fail(503, '저장된 요청을 확인하지 못했습니다.');
      if (value.state === 'pending' && now < value.expiresAt) pending++;
    }
    if (pending >= OPEN_PENDING_MAX) return fail(429, '대기 중인 요청이 가득 찼습니다.');
    const rateRaw = await tx.get<unknown>(rateKey(sourceHash));
    if (rateRaw != null && !isRate(rateRaw)) return fail(503, '요청 한도를 확인하지 못했습니다.');
    const live = pruneHits(rateRaw == null ? [] : rateRaw.hits, now);
    if (!live.some((hit) => hit.id === parsed.id) && live.length >= OPEN_RATE_LIMIT) return fail(429, '같은 출처의 새 요청 한도(5/10분)에 도달했습니다.');
    if (!live.some((hit) => hit.id === parsed.id)) live.push({ id: parsed.id, at: now });
    const record = persist({
      id: parsed.id, secretHash, payloadHash, mode: parsed.mode, name: parsed.name, purpose: parsed.purpose,
      ...(parsed.targetLabId !== undefined ? { targetLabId: parsed.targetLabId } : {}),
      source: sourceHash, createdAt: now, expiresAt: now + OPEN_MAX_AGE, state: 'pending',
    });
    if (JSON.stringify(record).includes(parsed.secret)) return fail(503, '요청을 저장하지 못했습니다.');
    const rate: RateRow = { hits: live };
    const tooBig = overBudget(reqKey(parsed.id), record) ?? overBudget(rateKey(sourceHash), rate);
    if (tooBig) return tooBig;
    await tx.put(reqKey(parsed.id), record);
    await tx.put(rateKey(sourceHash), rate);
    return { schedule: true, ack: ackOf(record, now) };
  }

  async #load(tx: Tx, id: string): Promise<OpenRequestRecord | Fail | undefined> {
    const value = await tx.get<unknown>(reqKey(id));
    if (value == null) return undefined;
    return isRecord(value) ? value : fail(503, '저장된 요청을 확인하지 못했습니다.');
  }

  async #expirePending(tx: Tx, rec: OpenRequestRecord, now: number): Promise<OpenRequestRecord> {
    if (rec.state !== 'pending' || now < rec.expiresAt) return rec;
    const next = persist({ ...rec, state: 'expired' });
    await tx.put(reqKey(rec.id), next);
    return next;
  }

  async #retain(tx: Tx, key: string, rec: OpenRequestRecord, now: number): Promise<OpenRequestRecord | undefined> {
    if (now - rec.createdAt < OPEN_RETAIN) return rec;
    await tx.delete(key);
    return undefined;
  }
}
