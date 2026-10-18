// 자리 하나의 수리·교체 의도와, 결과를 모르는 잠금의 명시적 해제를 영속한다.
// 샌드박스를 멈추거나 지우지 않고, 예산 키를 만들거나 바꾸지 않으며, 파일을 고치거나
// 직접 프로비저닝하거나 토큰을 회전하지 않는다. 공급자 효과는 요청마다 run 한 번뿐이다.
import type { Fail } from './state';

export const LAB_SEAT_RECOVERY_LIMIT = 64;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CONTROLS = /[\x00-\x1f\x7f]/;
const fail = (status: number, error: string): Fail => ({ status, error });
const isFail = (x: unknown): x is Fail => !!x && typeof x === 'object' && typeof (x as Fail).status === 'number' && typeof (x as Fail).error === 'string';

const CONFLICT = '같은 요청 ID에 다른 내용을 쓸 수 없습니다.';
const MOVED = '수업 상태가 바뀌었습니다. 다시 확인하세요.';
const NEED_FILE = '자리를 바꾸려면 완료된 파일 확인 또는 데이터 손실 동의가 필요합니다.';
const LOCKED = '이 자리의 다른 복구가 진행 중입니다.';
const LIVE_LOCK = '진행 중인 복구 잠금은 해제할 수 없습니다.';
const ENDED = '모임이 끝났습니다.';
const CAP = '이 실습실의 복구 한도(64)에 도달했습니다.';
const SAVE = '복구를 저장하지 못했습니다.';
const READ = '복구를 확인하지 못했습니다.';
const MISSING = '없는 복구 요청입니다.';
const EXPIRED = '관리 세션이 만료됐습니다.';
const AUTH_DOWN = '관리 세션을 확인하지 못했습니다.';
const CTX_DOWN = '수업 상태를 확인하지 못했습니다.';
const UNLOCK_SAVE = '복구 잠금을 해제하지 못했습니다.';
const NOTE_UNKNOWN = '결과를 확인하지 못했습니다. 같은 요청은 다시 실행하지 않습니다.';
const NOTE_SKIPPED = '수업 상태가 바뀌어 실행하지 않았습니다.';
const NOTE_KNOWN = '이미 확인된 복구입니다.';

export type RecoveryKind = 'repair' | 'replace';
export type RecoveryStatus = 'pending' | 'ready' | 'replaced' | 'unknown' | 'skipped';
export type RecoverySuccess = 'ready' | 'replaced';
export type RecoveryRef = { labId: string; n: number; code: string; sandboxId: string; sid: string; generation: string };
export type RecoveryContext = { owner: string; revision: number; fingerprint: string; ref: RecoveryRef; verifiedFileId: string | null };
export type RecoveryRecord = {
  requestId: string;
  kind: RecoveryKind;
  owner: string;
  revision: number;
  fingerprint: string;
  ref: RecoveryRef;
  verifiedFileId: string | null;
  ackDataLoss: boolean;
  createdAt: number;
  status: RecoveryStatus;
  at: number | null;
  resultGeneration?: string;
  releasedAt?: number;
};
export type RecoveryOutcome = { status: RecoverySuccess; at: number; generation: string };
export type RecoveryView = { requestId: string; kind: RecoveryKind; n: number; status: RecoveryStatus; at: number | null; generation?: string; note?: string };
export type RecoveryUnlockView = { requestId: string; released: true; at: number; note?: string };
type Deps = {
  storage: Pick<DurableObjectStorage, 'get' | 'put' | 'delete' | 'list' | 'transaction'>;
  now(): number;
  authorize(token: string, id: string): Promise<Fail | null>;
  context(token: string, id: string, n: number): Promise<RecoveryContext | Fail>;
  /** State rechecks authoritative storage in the same transaction before a new lock or unlock. */
  validateContext?(context: RecoveryContext, tx: Tx, requireFile: boolean): Promise<Fail | null>;
  run(token: string, record: RecoveryRecord, gate: () => boolean): Promise<RecoveryOutcome>;
  observe(token: string, record: RecoveryRecord): Promise<RecoveryOutcome | null>;
  audit(event: string, detail: string): Promise<void>;
};
type Tx = Pick<DurableObjectStorage, 'get' | 'put' | 'delete' | 'list'>;
type Claimed = { replay: true; record: RecoveryRecord } | { replay: false; record: RecoveryRecord };

const opPrefix = (id: string) => `labseatrec:${encodeURIComponent(id)}:`;
/** 복구 요청 한 건. 응답·감사에는 이 키와 자리 코드·SID를 넣지 않는다. */
export const recoveryOperationKey = (id: string, requestId: string) => `${opPrefix(id)}${requestId}`;
/** 자리 하나의 진행 잠금. 값은 그 잠금을 잡은 요청 ID다. */
export const recoveryActiveKey = (id: string, n: number) => `labseatact:${encodeURIComponent(id)}:${n}`;

const safeText = (x: unknown, max: number): x is string => typeof x === 'string' && x.length >= 1 && x.length <= max && !CONTROLS.test(x);
const seatOk = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 1 && n <= 50;
const kindOk = (kind: RecoveryKind, status: RecoverySuccess) => kind === 'repair' ? status === 'ready' : status === 'replaced';
const copyRef = (r: RecoveryRef): RecoveryRef => ({ labId: r.labId, n: r.n, code: r.code, sandboxId: r.sandboxId, sid: r.sid, generation: r.generation });
const sameRef = (a: RecoveryRef, b: RecoveryRef) => a.labId === b.labId && a.n === b.n && a.code === b.code && a.sandboxId === b.sandboxId && a.sid === b.sid && a.generation === b.generation;
const samePayload = (op: RecoveryRecord, n: number, kind: RecoveryKind, generation: string, revision: number, ack: boolean) => op.ref.n === n && op.kind === kind && op.ref.generation === generation && op.revision === revision && op.ackDataLoss === ack;

function isRef(x: unknown): x is RecoveryRef {
  if (!x || typeof x !== 'object') return false;
  const r = x as Partial<RecoveryRef>;
  return safeText(r.labId, 100) && seatOk(r.n) && safeText(r.code, 200) && safeText(r.sandboxId, 200) && safeText(r.sid, 200) && safeText(r.generation, 128);
}
function isContext(x: unknown, labId: string, n: number): x is RecoveryContext {
  if (!x || typeof x !== 'object' || isFail(x)) return false;
  const c = x as Partial<RecoveryContext>;
  if (!safeText(c.owner, 512) || !safeText(c.fingerprint, 512)) return false;
  if (typeof c.revision !== 'number' || !Number.isSafeInteger(c.revision) || c.revision < 0) return false;
  if (!isRef(c.ref) || c.ref.labId !== labId || c.ref.n !== n) return false;
  return c.verifiedFileId === null || safeText(c.verifiedFileId, 200);
}
function isRecord(x: unknown, labId: string): x is RecoveryRecord {
  if (!x || typeof x !== 'object') return false;
  const o = x as RecoveryRecord;
  if (!safeText(o.requestId, 36) || !UUID.test(o.requestId)) return false;
  if (o.kind !== 'repair' && o.kind !== 'replace') return false;
  if (!safeText(o.owner, 512) || !safeText(o.fingerprint, 512)) return false;
  if (typeof o.revision !== 'number' || !Number.isSafeInteger(o.revision) || o.revision < 0) return false;
  if (!isRef(o.ref) || o.ref.labId !== labId) return false;
  if (o.verifiedFileId !== null && !safeText(o.verifiedFileId, 200)) return false;
  if (typeof o.ackDataLoss !== 'boolean') return false;
  if (typeof o.createdAt !== 'number' || !Number.isFinite(o.createdAt)) return false;
  if (o.status !== 'pending' && o.status !== 'ready' && o.status !== 'replaced' && o.status !== 'unknown' && o.status !== 'skipped') return false;
  if (o.releasedAt !== undefined && (typeof o.releasedAt !== 'number' || !Number.isFinite(o.releasedAt))) return false;
  if (o.status === 'ready' || o.status === 'replaced') {
    return kindOk(o.kind, o.status) && typeof o.at === 'number' && Number.isFinite(o.at) && safeText(o.resultGeneration, 128);
  }
  return o.at === null && o.resultGeneration === undefined;
}
function asOutcome(x: unknown): RecoveryOutcome | null {
  if (!x || typeof x !== 'object') return null;
  const o = x as Partial<RecoveryOutcome>;
  if (o.status !== 'ready' && o.status !== 'replaced') return null;
  if (typeof o.at !== 'number' || !Number.isFinite(o.at) || !safeText(o.generation, 128)) return null;
  return { status: o.status, at: o.at, generation: o.generation };
}
function pack(r: RecoveryRecord): RecoveryRecord {
  const out: RecoveryRecord = {
    requestId: r.requestId, kind: r.kind, owner: r.owner, revision: r.revision, fingerprint: r.fingerprint,
    ref: copyRef(r.ref), verifiedFileId: r.verifiedFileId, ackDataLoss: r.ackDataLoss, createdAt: r.createdAt, status: r.status, at: r.at,
  };
  if (r.resultGeneration !== undefined) out.resultGeneration = r.resultGeneration;
  if (r.releasedAt !== undefined) out.releasedAt = r.releasedAt;
  return out;
}
function apply(record: RecoveryRecord, saved: RecoveryRecord) {
  record.kind = saved.kind;
  record.owner = saved.owner;
  record.revision = saved.revision;
  record.fingerprint = saved.fingerprint;
  record.ref = copyRef(saved.ref);
  record.verifiedFileId = saved.verifiedFileId;
  record.ackDataLoss = saved.ackDataLoss;
  record.createdAt = saved.createdAt;
  record.status = saved.status;
  record.at = saved.at;
  if (saved.resultGeneration === undefined) delete record.resultGeneration;
  else record.resultGeneration = saved.resultGeneration;
  if (saved.releasedAt === undefined) delete record.releasedAt;
  else record.releasedAt = saved.releasedAt;
}
function view(record: RecoveryRecord): RecoveryView {
  const out: RecoveryView = { requestId: record.requestId, kind: record.kind, n: record.ref.n, status: record.status, at: record.at };
  if ((record.status === 'ready' || record.status === 'replaced') && record.resultGeneration) out.generation = record.resultGeneration;
  if (record.status === 'unknown') out.note = NOTE_UNKNOWN;
  else if (record.status === 'skipped') out.note = NOTE_SKIPPED;
  return out;
}
function knownUnlock(record: RecoveryRecord): RecoveryUnlockView {
  if (record.releasedAt !== undefined) return { requestId: record.requestId, released: true, at: record.releasedAt };
  return { requestId: record.requestId, released: true, at: record.at ?? record.createdAt, note: NOTE_KNOWN };
}
function aligned(a: RecoveryContext, b: RecoveryContext, kind: RecoveryKind, ack: boolean) {
  if (a.owner !== b.owner || a.revision !== b.revision || a.fingerprint !== b.fingerprint || !sameRef(a.ref, b.ref)) return false;
  if (kind === 'replace' && !ack) return a.verifiedFileId !== null && a.verifiedFileId === b.verifiedFileId;
  return true;
}
function bound(record: RecoveryRecord, ctx: RecoveryContext) {
  if (record.owner !== ctx.owner || record.revision !== ctx.revision || record.fingerprint !== ctx.fingerprint || !sameRef(record.ref, ctx.ref)) return false;
  if (record.kind === 'replace' && !record.ackDataLoss) return ctx.verifiedFileId !== null && ctx.verifiedFileId === record.verifiedFileId;
  return true;
}
function canMove(from: RecoveryStatus, to: RecoveryStatus) {
  if (from === 'pending') return to === 'ready' || to === 'replaced' || to === 'unknown' || to === 'skipped';
  return from === 'unknown' && (to === 'ready' || to === 'replaced');
}

export class LabSeatRecoveryService {
  #ended = new Set<string>();
  #inflight = new Set<string>();
  #claiming = new Map<string, number>();
  constructor(private d: Deps) {}
  private get s() { return this.d.storage; }
  #live(key: string) { return this.#inflight.has(key) || this.#claiming.has(key); }

  async create(token: string, id: string, requestId: unknown, n: unknown, kind: unknown, expectedGeneration: unknown, expectedRevision: unknown, ackDataLoss: unknown): Promise<RecoveryView | Fail> {
    const bad = this.#labId(id) ?? this.#uuid(requestId) ?? this.#seat(n) ?? this.#kind(kind) ?? this.#generation(expectedGeneration) ?? this.#revision(expectedRevision) ?? this.#ack(ackDataLoss);
    if (bad) return bad;
    const rid = requestId as string;
    const seat = n as number;
    const mode = kind as RecoveryKind;
    const gen = expectedGeneration as string;
    const rev = expectedRevision as number;
    const ack = ackDataLoss as boolean;
    const key = recoveryOperationKey(id, rid);
    let started = false;
    try {
      const auth = await this.#auth(token, id);
      if (auth) return auth;
      if (this.#inflight.has(key)) return this.#liveView(token, id, key, seat, mode, gen, rev, ack);
      const existing = await this.s.get<unknown>(key);
      if (existing != null && !isRecord(existing, id)) return fail(503, READ);
      if (isRecord(existing, id)) {
        if (!samePayload(existing, seat, mode, gen, rev, ack)) return fail(409, CONFLICT);
        return this.#open(token, id, existing);
      }
      if (this.#ended.has(id)) return fail(410, ENDED);
      const ctx = await this.#ctx(token, id, seat);
      if (isFail(ctx)) return ctx;
      const expect = this.#expect(ctx, gen, rev, mode, ack);
      if (expect) return expect;
      const auth2 = await this.#auth(token, id);
      if (auth2) return auth2;
      if (this.#ended.has(id)) return fail(410, ENDED);
      const ctx2 = await this.#ctx(token, id, seat);
      if (isFail(ctx2)) return ctx2;
      if (!aligned(ctx, ctx2, mode, ack)) return fail(409, MOVED);
      const again = this.#expect(ctx2, gen, rev, mode, ack);
      if (again) return again;
      const createdAt = this.d.now();
      this.#claiming.set(key, (this.#claiming.get(key) ?? 0) + 1);
      let claimed: Claimed | Fail | undefined;
      try {
        claimed = await this.s.transaction((tx) => this.#claim(tx, id, rid, ctx2, mode, ack, createdAt));
        if (claimed && !isFail(claimed) && !claimed.replay) {
          this.#inflight.add(key);
          started = true;
        }
      } finally {
        const left = (this.#claiming.get(key) ?? 1) - 1;
        if (left > 0) this.#claiming.set(key, left);
        else this.#claiming.delete(key);
      }
      if (!claimed || isFail(claimed)) return claimed ?? fail(503, SAVE);
      if (claimed.replay) {
        if (!samePayload(claimed.record, seat, mode, gen, rev, ack)) return fail(409, CONFLICT);
        return this.#open(token, id, claimed.record);
      }
      const err = await this.#execute(token, id, claimed.record);
      if (err) return err;
      const auth3 = await this.#auth(token, id);
      if (auth3) return auth3;
      return view(claimed.record);
    } catch {
      return fail(503, SAVE);
    } finally {
      if (started) this.#inflight.delete(key);
    }
  }

  async status(token: string, id: string, requestId: unknown): Promise<RecoveryView | Fail> {
    const bad = this.#labId(id) ?? this.#uuid(requestId);
    if (bad) return bad;
    const rid = requestId as string;
    try {
      const auth = await this.#auth(token, id);
      if (auth) return auth;
      const row = await this.s.get<unknown>(recoveryOperationKey(id, rid));
      if (row == null) return fail(404, MISSING);
      if (!isRecord(row, id) || row.requestId !== rid) return fail(503, READ);
      const again = await this.#auth(token, id);
      if (again) return again;
      return this.#open(token, id, row);
    } catch {
      return fail(503, READ);
    }
  }

  async unlock(token: string, id: string, requestId: unknown, expectedGeneration: unknown, ackInspected: unknown): Promise<RecoveryUnlockView | Fail> {
    const bad = this.#labId(id) ?? this.#uuid(requestId) ?? this.#generation(expectedGeneration);
    if (bad) return bad;
    if (ackInspected !== true) return fail(400, '잠금 해제 확인이 필요합니다.');
    const rid = requestId as string;
    const gen = expectedGeneration as string;
    const key = recoveryOperationKey(id, rid);
    try {
      const auth = await this.#auth(token, id);
      if (auth) return auth;
      const row = await this.s.get<unknown>(key);
      if (row == null) return fail(404, MISSING);
      if (!isRecord(row, id) || row.requestId !== rid) return fail(503, READ);
      const again = await this.#auth(token, id);
      if (again) return again;
      if (this.#live(key)) return fail(409, LIVE_LOCK);
      if (row.releasedAt !== undefined) return { requestId: rid, released: true, at: row.releasedAt };
      if (row.status !== 'pending' && row.status !== 'unknown') return knownUnlock(row);
      const ctx = await this.#ctx(token, id, row.ref.n);
      if (isFail(ctx)) return ctx;
      if (ctx.ref.generation !== gen) return fail(409, MOVED);
      const auth2 = await this.#auth(token, id);
      if (auth2) return auth2;
      const ctx2 = await this.#ctx(token, id, row.ref.n);
      if (isFail(ctx2)) return ctx2;
      if (ctx2.ref.generation !== gen || !aligned(ctx, ctx2, 'repair', true)) return fail(409, MOVED);
      if (this.#live(key)) return fail(409, LIVE_LOCK);
      const at = this.d.now();
      const saved = await this.s.transaction(async (tx) => {
        if (this.#live(key)) return fail(409, LIVE_LOCK);
        const cur = await tx.get<unknown>(key);
        if (!isRecord(cur, id) || cur.requestId !== rid) return fail(503, READ);
        if (cur.releasedAt !== undefined) return { body: { requestId: rid, released: true as const, at: cur.releasedAt }, wrote: false };
        if (cur.status !== 'pending' && cur.status !== 'unknown') return { body: knownUnlock(cur), wrote: false };
        const act = await tx.get<unknown>(recoveryActiveKey(id, cur.ref.n));
        const denied = await this.d.validateContext?.(ctx2, tx, false);
        if (denied) return denied;
        if (this.#ended.has(id) || this.#live(key)) return fail(409, MOVED);
        const next = pack({ ...cur, status: 'unknown', at: null, releasedAt: at });
        delete next.resultGeneration;
        await tx.put(key, next);
        if (act === rid) await tx.delete(recoveryActiveKey(id, cur.ref.n));
        return { body: { requestId: rid, released: true as const, at }, wrote: true };
      });
      if (isFail(saved)) return saved;
      const auth3 = await this.#auth(token, id);
      if (auth3) return auth3;
      if (saved.wrote) await this.#audit('lab-seat-recovery-unlock', `${id} ${rid}`);
      return saved.body;
    } catch {
      return fail(503, UNLOCK_SAVE);
    }
  }

  /** 이 인스턴스의 이후 run만 막는다. 수업 종료 기록과 샌드박스 정리는 조정자가 한다. */
  end(id: string): Fail | { ended: true } {
    const bad = this.#labId(id);
    if (bad) return bad;
    this.#ended.add(id);
    return { ended: true };
  }

  async #claim(tx: Tx, id: string, requestId: string, ctx: RecoveryContext, kind: RecoveryKind, ack: boolean, createdAt: number): Promise<Claimed | Fail> {
    const key = recoveryOperationKey(id, requestId);
    const existing = await tx.get<unknown>(key);
    if (existing != null && !isRecord(existing, id)) return fail(503, READ);
    if (isRecord(existing, id)) {
      return samePayload(existing, ctx.ref.n, kind, ctx.ref.generation, ctx.revision, ack) ? { replay: true, record: existing } : fail(409, CONFLICT);
    }
    if (this.#ended.has(id)) return fail(410, ENDED);
    const actKey = recoveryActiveKey(id, ctx.ref.n);
    const active = await tx.get<unknown>(actKey);
    if (active != null) return typeof active === 'string' ? fail(409, LOCKED) : fail(503, READ);
    const listed = await tx.list({ prefix: opPrefix(id), limit: LAB_SEAT_RECOVERY_LIMIT });
    if (listed.size >= LAB_SEAT_RECOVERY_LIMIT) return fail(429, CAP);
    for (const value of listed.values()) if (!isRecord(value, id)) return fail(503, READ);
    const raced = await tx.get<unknown>(key);
    if (isRecord(raced, id)) return samePayload(raced, ctx.ref.n, kind, ctx.ref.generation, ctx.revision, ack) ? { replay: true, record: raced } : fail(409, CONFLICT);
    if (raced != null) return fail(503, READ);
    const activeAgain = await tx.get<unknown>(actKey);
    if (activeAgain != null) return typeof activeAgain === 'string' ? fail(409, LOCKED) : fail(503, READ);
    const denied = await this.d.validateContext?.(ctx, tx, kind === 'replace' && !ack);
    if (denied) return denied;
    if (this.#ended.has(id)) return fail(410, ENDED);
    const record: RecoveryRecord = {
      requestId, kind, owner: ctx.owner, revision: ctx.revision, fingerprint: ctx.fingerprint, ref: copyRef(ctx.ref),
      verifiedFileId: ctx.verifiedFileId, ackDataLoss: ack, createdAt, status: 'pending', at: null,
    };
    await tx.put(key, record);
    await tx.put(actKey, requestId);
    return { replay: false, record };
  }

  async #execute(token: string, id: string, record: RecoveryRecord): Promise<Fail | null> {
    if (this.#ended.has(id)) return this.#finish(id, record, 'skipped');
    const auth = await this.#auth(token, id);
    if (auth) return auth;
    if (this.#ended.has(id)) return this.#finish(id, record, 'skipped');
    const ctx = await this.#ctx(token, id, record.ref.n);
    if (isFail(ctx)) {
      if (ctx.status === 401 || ctx.status === 403) return ctx;
      if (ctx.status === 409 || ctx.status === 410) return this.#finish(id, record, 'skipped');
      return this.#finish(id, record, 'unknown');
    }
    if (!bound(record, ctx) || this.#ended.has(id)) return this.#finish(id, record, 'skipped');
    let outcome: RecoveryOutcome | null = null;
    try { outcome = asOutcome(await this.d.run(token, pack(record), () => !this.#ended.has(id))); }
    catch { outcome = null; }
    if (!outcome || !kindOk(record.kind, outcome.status)) return this.#finish(id, record, 'unknown');
    const err = await this.#finish(id, record, outcome.status, outcome);
    if (err) return err;
    if (record.status === 'ready' || record.status === 'replaced') await this.#audit('lab-seat-recovery', `${id} ${record.requestId} ${record.kind} ${record.status}`);
    return null;
  }

  async #open(token: string, id: string, record: RecoveryRecord): Promise<RecoveryView | Fail> {
    const key = recoveryOperationKey(id, record.requestId);
    if (this.#live(key)) return this.#liveView(token, id, key, record.ref.n, record.kind, record.ref.generation, record.revision, record.ackDataLoss);
    if (record.status !== 'pending' && record.status !== 'unknown') {
      const auth = await this.#auth(token, id);
      return auth ?? view(record);
    }
    const auth = await this.#auth(token, id);
    if (auth) return auth;
    let outcome: RecoveryOutcome | null = null;
    try { outcome = asOutcome(await this.d.observe(token, pack(record))); }
    catch { outcome = null; }
    const again = await this.#auth(token, id);
    if (again) return again;
    if (this.#live(key)) return this.#liveView(token, id, key, record.ref.n, record.kind, record.ref.generation, record.revision, record.ackDataLoss);
    if (outcome && kindOk(record.kind, outcome.status)) {
      const err = await this.#finish(id, record, outcome.status, outcome);
      if (err) return err;
      const done = await this.#auth(token, id);
      return done ?? view(record);
    }
    if (record.status === 'unknown') {
      const done = await this.#auth(token, id);
      return done ?? view(record);
    }
    const err = await this.#finish(id, record, 'unknown');
    if (err) return err;
    const done = await this.#auth(token, id);
    return done ?? view(record);
  }

  async #liveView(token: string, id: string, key: string, n: number, kind: RecoveryKind, generation: string, revision: number, ack: boolean): Promise<RecoveryView | Fail> {
    const auth = await this.#auth(token, id);
    if (auth) return auth;
    const live = await this.s.get<unknown>(key);
    if (!isRecord(live, id)) return fail(503, READ);
    if (!samePayload(live, n, kind, generation, revision, ack)) return fail(409, CONFLICT);
    const again = await this.#auth(token, id);
    if (again) return again;
    return view(live);
  }

  async #finish(id: string, record: RecoveryRecord, status: RecoveryStatus, outcome?: RecoveryOutcome): Promise<Fail | null> {
    const key = recoveryOperationKey(id, record.requestId);
    const actKey = recoveryActiveKey(id, record.ref.n);
    const retain = status === 'unknown';
    try {
      const saved = await this.s.transaction(async (tx) => {
        const cur = await tx.get<unknown>(key);
        if (!isRecord(cur, id)) throw new Error('recovery row missing');
        if (!canMove(cur.status, status)) return pack(cur);
        const next = pack({ ...cur, status, at: outcome ? outcome.at : null, resultGeneration: outcome?.generation });
        if (!outcome) delete next.resultGeneration;
        await tx.put(key, next);
        if (!retain) {
          const act = await tx.get<unknown>(actKey);
          if (act === cur.requestId) await tx.delete(actKey);
        }
        return next;
      });
      apply(record, saved);
      return null;
    } catch {
      return fail(503, SAVE);
    }
  }

  #expect(ctx: RecoveryContext, gen: string, rev: number, kind: RecoveryKind, ack: boolean): Fail | null {
    if (ctx.ref.generation !== gen || ctx.revision !== rev) return fail(409, MOVED);
    if (kind === 'replace' && !ack && ctx.verifiedFileId === null) return fail(409, NEED_FILE);
    return null;
  }
  async #auth(token: string, id: string): Promise<Fail | null> {
    try {
      const auth = await this.d.authorize(token, id);
      if (auth == null) return null;
      if (isFail(auth)) return { status: auth.status, error: auth.error };
      return fail(401, EXPIRED);
    } catch {
      return fail(503, AUTH_DOWN);
    }
  }
  async #ctx(token: string, id: string, n: number): Promise<RecoveryContext | Fail> {
    try {
      const ctx = await this.d.context(token, id, n);
      if (isFail(ctx)) return { status: ctx.status, error: ctx.error };
      if (!isContext(ctx, id, n)) return fail(503, CTX_DOWN);
      return { owner: ctx.owner, revision: ctx.revision, fingerprint: ctx.fingerprint, ref: copyRef(ctx.ref), verifiedFileId: ctx.verifiedFileId };
    } catch {
      return fail(503, CTX_DOWN);
    }
  }
  async #audit(event: string, detail: string) {
    try { await this.d.audit(event, detail); } catch { /* 감사 실패가 복구 결과를 바꾸지 않는다 */ }
  }
  #labId(id: unknown): Fail | null { return typeof id === 'string' && id.length > 0 && id.length <= 100 ? null : fail(400, '실습실 ID가 올바르지 않습니다.'); }
  #uuid(id: unknown): Fail | null { return typeof id === 'string' && UUID.test(id) ? null : fail(400, '복구 요청 ID가 올바르지 않습니다.'); }
  #seat(n: unknown): Fail | null { return seatOk(n) ? null : fail(400, '자리 번호가 올바르지 않습니다.'); }
  #kind(kind: unknown): Fail | null { return kind === 'repair' || kind === 'replace' ? null : fail(400, '복구 종류가 올바르지 않습니다.'); }
  #generation(v: unknown): Fail | null { return safeText(v, 128) ? null : fail(400, '세대 값이 올바르지 않습니다.'); }
  #revision(v: unknown): Fail | null { return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? null : fail(400, '수업 개정 번호가 올바르지 않습니다.'); }
  #ack(v: unknown): Fail | null { return typeof v === 'boolean' ? null : fail(400, '데이터 손실 확인 값이 올바르지 않습니다.'); }
}
