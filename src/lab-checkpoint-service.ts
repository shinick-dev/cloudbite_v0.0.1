// 선택한 자리의 저장된 파일 체크포인트 의도를 영속한다.
// 샌드박스를 멈추거나 지우지 않고, 원본을 덮어쓰지 않으며, 아카이브 파일도 두지 않는다.
// 원격 아카이브는 주입된 remote가 요청마다 대상 하나당 한 번만 만든다.
import type { Fail } from './state';

export const LAB_CHECKPOINT_LIMIT = 64;
export const LAB_CHECKPOINT_SEAT_LIMIT = 5;
export const LAB_CHECKPOINT_MAX_ENTRIES = 4000;
export const LAB_CHECKPOINT_MAX_BYTES = 64 * 1024 * 1024;
export const LAB_CHECKPOINT_MAX_ARCHIVE = LAB_CHECKPOINT_MAX_BYTES + Math.ceil(LAB_CHECKPOINT_MAX_BYTES / 1024) + LAB_CHECKPOINT_MAX_ENTRIES * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CONTROLS = /[\x00-\x1f\x7f]/;
const fail = (status: number, error: string): Fail => ({ status, error });
const isFail = (x: unknown): x is Fail => !!x && typeof x === 'object' && typeof (x as Fail).status === 'number' && typeof (x as Fail).error === 'string';

export type CheckpointRef = { labId: string; n: number; code: string; sandboxId: string };
export type CheckpointContext = { owner: string; revision: number; fingerprint: string; refs: CheckpointRef[] };
export type CheckpointStatus = 'pending' | 'ready' | 'unknown' | 'skipped';
export type CheckpointResult = { n: number; status: CheckpointStatus; at: number | null; entries?: number; bytes?: number; size?: number; omitted?: number };
export type CheckpointOperation = { requestId: string; owner: string; revision: number; fingerprint: string; refs: CheckpointRef[]; createdAt: number; results: CheckpointResult[] };
export type CheckpointView = { requestId: string; results: CheckpointResult[] };
type SeatId = { n: number; code: string; sandboxId: string };
type StoredOp = { requestId: string; revision: number; createdAt: number; seats: SeatId[]; results: CheckpointResult[] };
type Meta = { entries: number; bytes: number; size: number; omitted: number };
type Deps = {
  storage: Pick<DurableObjectStorage, 'get' | 'put' | 'list' | 'transaction'>;
  now(): number;
  authorize(token: string, id: string): Promise<Fail | null>;
  context(token: string, id: string): Promise<CheckpointContext | Fail>;
  remote(token: string, ref: CheckpointRef, record: CheckpointOperation, gate: () => boolean): Promise<Meta>;
  audit(event: string, detail: string): Promise<void>;
};
type Tx = Pick<DurableObjectStorage, 'get' | 'put' | 'list'>;
type Claimed = { replay: true; op: StoredOp } | { replay: false; op: CheckpointOperation };

const opPrefix = (id: string) => `labckpt:${encodeURIComponent(id)}:`;
/** 체크포인트 요청 한 건의 키. 저장값은 요청 ID·개정·시각·자리 신원·결과뿐이고 소유자·지문·경로는 없다. */
export const checkpointOperationKey = (id: string, requestId: string) => `${opPrefix(id)}${requestId}`;

const safeText = (x: unknown, max: number): x is string => typeof x === 'string' && x.length >= 1 && x.length <= max && !CONTROLS.test(x);
const seatOk = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 1 && n <= 50;
const bounded = (n: unknown, max: number): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n <= max;
const copyRef = (r: CheckpointRef): CheckpointRef => ({ labId: r.labId, n: r.n, code: r.code, sandboxId: r.sandboxId });
const sameRef = (a: CheckpointRef, b: CheckpointRef) => a.labId === b.labId && a.n === b.n && a.code === b.code && a.sandboxId === b.sandboxId;
const seatKey = (s: SeatId) => `${s.n}\0${s.code}\0${s.sandboxId}`;
const cloneResult = (r: CheckpointResult): CheckpointResult => r.status === 'ready'
  ? { n: r.n, status: r.status, at: r.at, entries: r.entries, bytes: r.bytes, size: r.size, omitted: r.omitted }
  : { n: r.n, status: r.status, at: r.at };
const view = (op: { requestId: string; results: CheckpointResult[] }): CheckpointView => ({ requestId: op.requestId, results: op.results.map(cloneResult) });

function isRef(x: unknown, labId: string): x is CheckpointRef {
  if (!x || typeof x !== 'object') return false;
  const r = x as CheckpointRef;
  return r.labId === labId && seatOk(r.n) && safeText(r.code, 200) && safeText(r.sandboxId, 200);
}
function isContext(x: unknown, labId: string): x is CheckpointContext {
  if (!x || typeof x !== 'object' || isFail(x)) return false;
  const c = x as CheckpointContext;
  if (!safeText(c.owner, 512) || !safeText(c.fingerprint, 512)) return false;
  if (typeof c.revision !== 'number' || !Number.isSafeInteger(c.revision) || c.revision < 0) return false;
  if (!Array.isArray(c.refs) || c.refs.length > 50) return false;
  const seen = new Set<number>();
  return c.refs.every((r) => isRef(r, labId) && !seen.has(r.n) && !!seen.add(r.n));
}
function isResult(r: unknown): r is CheckpointResult {
  if (!r || typeof r !== 'object') return false;
  const row = r as CheckpointResult;
  const status = new Set<CheckpointStatus>(['pending', 'ready', 'unknown', 'skipped']);
  if (!seatOk(row.n) || !status.has(row.status)) return false;
  if (row.status === 'ready') return typeof row.at === 'number' && Number.isFinite(row.at) && bounded(row.entries, LAB_CHECKPOINT_MAX_ENTRIES) && bounded(row.bytes, LAB_CHECKPOINT_MAX_BYTES) && bounded(row.size, LAB_CHECKPOINT_MAX_ARCHIVE) && bounded(row.omitted, LAB_CHECKPOINT_MAX_ENTRIES);
  return row.at === null && row.entries === undefined && row.bytes === undefined && row.size === undefined && row.omitted === undefined;
}
function isStored(x: unknown): x is StoredOp {
  if (!x || typeof x !== 'object') return false;
  const o = x as StoredOp;
  if (!UUID.test(o.requestId) || !Number.isSafeInteger(o.revision) || o.revision < 0 || !Number.isFinite(o.createdAt)) return false;
  if ('owner' in o || 'fingerprint' in o || 'refs' in o) return false;
  if (!Array.isArray(o.seats) || !Array.isArray(o.results) || o.seats.length < 1 || o.seats.length > 50 || o.seats.length !== o.results.length) return false;
  return o.seats.every((s, i) => !!s && seatOk(s.n) && safeText(s.code, 200) && safeText(s.sandboxId, 200) && isResult(o.results[i]) && o.results[i].n === s.n && (i === 0 || s.n > o.seats[i - 1].n));
}
const samePayload = (op: StoredOp, seats: number[], revision: number) => op.revision === revision && op.results.length === seats.length && op.results.every((r, i) => r.n === seats[i]);
const metaOf = (x: unknown): Meta | null => {
  if (!x || typeof x !== 'object' || isFail(x)) return null;
  const m = x as Meta;
  return bounded(m.entries, LAB_CHECKPOINT_MAX_ENTRIES) && bounded(m.bytes, LAB_CHECKPOINT_MAX_BYTES) && bounded(m.size, LAB_CHECKPOINT_MAX_ARCHIVE) && bounded(m.omitted, LAB_CHECKPOINT_MAX_ENTRIES)
    ? { entries: m.entries, bytes: m.bytes, size: m.size, omitted: m.omitted } : null;
};

export class LabCheckpointService {
  #ended = new Set<string>();
  #inflight = new Set<string>();
  #claiming = new Map<string, number>();
  constructor(private d: Deps) {}
  private get s() { return this.d.storage; }

  async create(token: string, id: string, requestId: unknown, seats: unknown, expectedRevision: unknown): Promise<CheckpointView | Fail> {
    const bad = this.#labId(id) ?? this.#uuid(requestId) ?? this.#revision(expectedRevision);
    if (bad) return bad;
    const chosen = this.#seats(seats);
    if (isFail(chosen)) return chosen;
    const rid = requestId as string;
    const revision = expectedRevision as number;
    const key = checkpointOperationKey(id, rid);
    let started = false;
    try {
      const auth = await this.#auth(token, id);
      if (auth) return auth;
      if (this.#inflight.has(key)) {
        const live = await this.s.get<unknown>(key);
        if (!isStored(live) || !samePayload(live, chosen, revision)) return isStored(live) ? fail(409, '같은 요청 ID에 다른 내용을 쓸 수 없습니다.') : fail(503, '체크포인트를 확인하지 못했습니다.');
        return await this.#auth(token, id) ?? view(live);
      }
      const existing = await this.s.get<unknown>(key);
      if (existing != null && !isStored(existing)) return fail(503, '체크포인트를 확인하지 못했습니다.');
      if (isStored(existing)) return this.#replay(token, id, key, existing, chosen, revision);
      if (this.#ended.has(id)) return fail(410, '모임이 끝났습니다.');
      this.#claiming.set(key, (this.#claiming.get(key) ?? 0) + 1);
      let claimed: Claimed | Fail | undefined;
      try {
        claimed = await this.s.transaction((tx) => this.#claim(tx, token, id, rid, chosen, revision));
        if (!isFail(claimed) && !claimed.replay) { this.#inflight.add(key); started = true; }
      } finally {
        const left = (this.#claiming.get(key) ?? 1) - 1;
        if (left > 0) this.#claiming.set(key, left); else this.#claiming.delete(key);
      }
      if (!claimed || isFail(claimed)) return claimed ?? fail(503, '체크포인트를 저장하지 못했습니다.');
      if (claimed.replay) return this.#replay(token, id, key, claimed.op, chosen, revision);
      const err = await this.#execute(token, id, claimed.op);
      if (err) return err;
      await this.#audit('lab-checkpoint', `${id} ${rid} ${claimed.op.results.length}`);
      return await this.#auth(token, id) ?? view(claimed.op);
    } catch {
      return fail(503, '체크포인트를 저장하지 못했습니다.');
    } finally {
      if (started) this.#inflight.delete(key);
    }
  }

  async status(token: string, id: string) {
    const bad = this.#labId(id);
    if (bad) return bad;
    try {
      const auth = await this.#auth(token, id);
      if (auth) return auth;
      const listed = await this.s.list({ prefix: opPrefix(id), limit: LAB_CHECKPOINT_LIMIT });
      const again = await this.#auth(token, id);
      if (again) return again;
      const checkpoints: { requestId: string; createdAt: number; results: CheckpointResult[] }[] = [];
      for (const [key, value] of listed) {
        if (!isStored(value)) return fail(503, '체크포인트를 확인하지 못했습니다.');
        const live = this.#inflight.has(key) || this.#claiming.has(key);
        checkpoints.push({ requestId: value.requestId, createdAt: value.createdAt, results: value.results.map((r) => live || r.status !== 'pending' ? cloneResult(r) : { n: r.n, status: 'unknown' as const, at: null }) });
      }
      checkpoints.sort((a, b) => b.createdAt - a.createdAt || (a.requestId < b.requestId ? 1 : -1));
      return { checkpoints };
    } catch {
      return fail(503, '체크포인트를 확인하지 못했습니다.');
    }
  }

  /** 저장을 기다리지 않는다. 이 인스턴스의 이후 remote만 막으며, 아카이브는 지우지 않는다. */
  end(id: string): Fail | { ended: true } {
    const bad = this.#labId(id);
    if (bad) return bad;
    this.#ended.add(id);
    return { ended: true };
  }

  async #claim(tx: Tx, token: string, id: string, requestId: string, seats: number[], revision: number): Promise<Claimed | Fail> {
    const key = checkpointOperationKey(id, requestId);
    const existing = await tx.get<unknown>(key);
    if (existing != null && !isStored(existing)) return fail(503, '체크포인트를 확인하지 못했습니다.');
    if (isStored(existing)) return samePayload(existing, seats, revision) ? { replay: true, op: existing } : fail(409, '같은 요청 ID에 다른 내용을 쓸 수 없습니다.');
    const auth = await this.#auth(token, id);
    if (auth) return auth;
    if (this.#ended.has(id)) return fail(410, '모임이 끝났습니다.');
    const ctx = await this.#ctx(token, id);
    if (isFail(ctx)) return ctx;
    if (ctx.revision !== revision) return fail(409, '수업 상태가 바뀌었습니다. 다시 확인하세요.');
    const refs = this.#pick(ctx, seats);
    if (isFail(refs)) return refs;
    const fresh = await this.#ctx(token, id);
    if (isFail(fresh)) return fresh;
    if (!this.#aligned(ctx, fresh, refs)) return fail(409, '수업 상태가 바뀌었습니다. 다시 확인하세요.');
    const raced = await tx.get<unknown>(key);
    if (raced != null) return isStored(raced) && samePayload(raced, seats, revision) ? { replay: true, op: raced } : fail(isStored(raced) ? 409 : 503, isStored(raced) ? '같은 요청 ID에 다른 내용을 쓸 수 없습니다.' : '체크포인트를 확인하지 못했습니다.');
    const listed = await tx.list({ prefix: opPrefix(id), limit: LAB_CHECKPOINT_LIMIT });
    if (listed.size >= LAB_CHECKPOINT_LIMIT) return fail(429, '이 실습실의 체크포인트 한도(64)에 도달했습니다.');
    const counts = new Map<string, number>();
    for (const value of listed.values()) {
      if (!isStored(value)) return fail(503, '체크포인트를 확인하지 못했습니다.');
      for (const seat of value.seats) counts.set(seatKey(seat), (counts.get(seatKey(seat)) ?? 0) + 1);
    }
    if (refs.some((r) => (counts.get(seatKey(r)) ?? 0) >= LAB_CHECKPOINT_SEAT_LIMIT)) return fail(429, '이 자리의 체크포인트 한도(5)에 도달했습니다.');
    const finalCtx = await this.#ctx(token, id);
    if (isFail(finalCtx)) return finalCtx;
    const finalAuth = await this.#auth(token, id);
    if (finalAuth) return finalAuth;
    if (this.#ended.has(id)) return fail(410, '모임이 끝났습니다.');
    if (!this.#aligned(fresh, finalCtx, refs)) return fail(409, '수업 상태가 바뀌었습니다. 다시 확인하세요.');
    const now = this.d.now();
    const stored: StoredOp = { requestId, revision, createdAt: now, seats: refs.map((r) => ({ n: r.n, code: r.code, sandboxId: r.sandboxId })), results: refs.map((r) => ({ n: r.n, status: 'pending' as const, at: null })) };
    if (this.#leaks(stored, token)) return fail(503, '체크포인트를 저장하지 못했습니다.');
    await tx.put(key, stored);
    return { replay: false, op: { requestId, owner: finalCtx.owner, revision: finalCtx.revision, fingerprint: finalCtx.fingerprint, refs, createdAt: now, results: stored.results.map(cloneResult) } };
  }

  async #execute(token: string, id: string, op: CheckpointOperation): Promise<Fail | null> {
    const key = checkpointOperationKey(id, op.requestId);
    for (let i = 0; i < op.refs.length; i++) {
      const row = op.results.find((r) => r.n === op.refs[i].n);
      if (!row || row.status !== 'pending') continue;
      if (this.#ended.has(id)) return this.#seal(id, op, i, 'skipped');
      let ctx: CheckpointContext | Fail;
      try {
        const auth = await this.#auth(token, id);
        if (auth) return this.#seal(id, op, i, 'unknown');
        ctx = await this.#ctx(token, id);
      } catch {
        return this.#seal(id, op, i, 'unknown');
      }
      if (isFail(ctx)) return this.#seal(id, op, i, ctx.status === 401 || ctx.status === 403 ? 'unknown' : 'skipped');
      if (!this.#matches(op, ctx) || this.#ended.has(id)) return this.#seal(id, op, i, 'skipped');
      const stored = await this.s.get<unknown>(key);
      const prior = isStored(stored) ? stored.results.find((r) => r.n === row.n) : undefined;
      if (!prior) return this.#seal(id, op, i, 'unknown');
      if (prior.status !== 'pending') { Object.assign(row, cloneResult(prior)); continue; }
      if (this.#ended.has(id)) return this.#seal(id, op, i, 'skipped');
      let ready: Meta | null = null;
      try { ready = metaOf(await this.d.remote(token, copyRef(op.refs[i]), this.#record(op), () => !this.#ended.has(id))); }
      catch { ready = null; }
      if (ready) Object.assign(row, { status: 'ready' as const, at: this.d.now(), entries: ready.entries, bytes: ready.bytes, size: ready.size, omitted: ready.omitted });
      else Object.assign(row, { status: 'unknown' as const, at: null });
      const saved = await this.#write(id, op);
      if (saved) return saved;
      if (this.#ended.has(id)) return this.#seal(id, op, i + 1, 'skipped');
    }
    return null;
  }

  async #replay(token: string, id: string, key: string, op: StoredOp, seats: number[], revision: number): Promise<CheckpointView | Fail> {
    const auth = await this.#auth(token, id);
    if (auth) return auth;
    if (!samePayload(op, seats, revision)) return fail(409, '같은 요청 ID에 다른 내용을 쓸 수 없습니다.');
    if (!op.results.some((r) => r.status === 'pending') || this.#inflight.has(key) || this.#claiming.has(key)) return view(op);
    try {
      const saved = await this.s.transaction(async (tx) => {
        if (this.#inflight.has(key) || this.#claiming.has(key)) return { live: true, op };
        const cur = await tx.get<unknown>(key);
        const again = await this.#auth(token, id);
        if (again) return again;
        if (!isStored(cur) || !samePayload(cur, seats, revision)) return samePayloadSafe(cur, seats, revision);
        if (!cur.results.some((r) => r.status === 'pending')) return { live: false, op: cur };
        const next: StoredOp = { requestId: cur.requestId, revision: cur.revision, createdAt: cur.createdAt, seats: cur.seats.map((s) => ({ n: s.n, code: s.code, sandboxId: s.sandboxId })), results: cur.results.map((r) => r.status === 'pending' ? { n: r.n, status: 'unknown' as const, at: null } : cloneResult(r)) };
        await tx.put(key, next);
        return { live: false, op: next };
      });
      if (isFail(saved)) return saved;
      if (!saved.op) return fail(503, '체크포인트를 확인하지 못했습니다.');
      return await this.#auth(token, id) ?? view(saved.op);
    } catch {
      return fail(503, '체크포인트를 확인하지 못했습니다.');
    }
  }

  async #write(id: string, op: CheckpointOperation): Promise<Fail | null> {
    const key = checkpointOperationKey(id, op.requestId);
    try {
      const results = await this.s.transaction(async (tx) => {
        const cur = await tx.get<unknown>(key);
        if (!isStored(cur)) throw new Error('checkpoint row missing');
        const merged = cur.results.map((r) => {
          const next = op.results.find((x) => x.n === r.n);
          return !next || r.status !== 'pending' ? cloneResult(r) : cloneResult(next);
        });
        await tx.put(key, { requestId: cur.requestId, revision: cur.revision, createdAt: cur.createdAt, seats: cur.seats.map((s) => ({ ...s })), results: merged });
        return merged;
      });
      op.results = results;
      return null;
    } catch {
      return fail(503, '체크포인트를 저장하지 못했습니다.');
    }
  }

  async #seal(id: string, op: CheckpointOperation, index: number, status: 'unknown' | 'skipped') {
    const ns = new Set(op.refs.slice(index).map((r) => r.n));
    for (const row of op.results) if (row.status === 'pending' && ns.has(row.n)) Object.assign(row, { status, at: null });
    return this.#write(id, op);
  }

  #record(op: CheckpointOperation): CheckpointOperation {
    return { requestId: op.requestId, owner: op.owner, revision: op.revision, fingerprint: op.fingerprint, refs: op.refs.map(copyRef), createdAt: op.createdAt, results: op.results.map(cloneResult) };
  }
  #matches(op: CheckpointOperation, ctx: CheckpointContext) {
    return op.owner === ctx.owner && op.revision === ctx.revision && op.fingerprint === ctx.fingerprint && op.refs.every((r) => {
      const hits = ctx.refs.filter((c) => c.n === r.n);
      return hits.length === 1 && sameRef(hits[0], r);
    });
  }
  #aligned(a: CheckpointContext, b: CheckpointContext, refs: CheckpointRef[]) {
    return a.owner === b.owner && a.revision === b.revision && a.fingerprint === b.fingerprint && refs.every((r) => {
      const left = a.refs.filter((c) => c.n === r.n);
      const right = b.refs.filter((c) => c.n === r.n);
      return left.length === 1 && right.length === 1 && sameRef(left[0], r) && sameRef(right[0], r);
    });
  }
  #pick(ctx: CheckpointContext, seats: number[]): CheckpointRef[] | Fail {
    const refs: CheckpointRef[] = [];
    for (const n of seats) {
      const found = ctx.refs.filter((r) => r.n === n);
      if (found.length !== 1) return fail(409, '선택한 자리가 현재 일시정지된 수업에 없습니다.');
      refs.push(copyRef(found[0]));
    }
    return refs;
  }
  async #auth(token: string, id: string): Promise<Fail | null> {
    try {
      const auth = await this.d.authorize(token, id);
      if (isFail(auth)) return token.length > 0 && auth.error.includes(token) ? fail(auth.status, '관리 세션이 만료됐습니다.') : auth;
      return auth == null ? null : fail(401, '관리 세션이 만료됐습니다.');
    } catch {
      return fail(503, '관리 세션을 확인하지 못했습니다.');
    }
  }
  async #ctx(token: string, id: string): Promise<CheckpointContext | Fail> {
    try {
      const ctx = await this.d.context(token, id);
      if (isFail(ctx)) return ctx;
      if (!isContext(ctx, id) || (token.length > 0 && (ctx.owner === token || JSON.stringify(ctx).includes(token)))) return fail(503, '수업 상태를 확인하지 못했습니다.');
      return { owner: ctx.owner, revision: ctx.revision, fingerprint: ctx.fingerprint, refs: [...ctx.refs].sort((a, b) => a.n - b.n).map(copyRef) };
    } catch {
      return fail(503, '수업 상태를 확인하지 못했습니다.');
    }
  }
  async #audit(event: string, detail: string) { await this.d.audit(event, detail).catch(() => {}); }
  #leaks(value: unknown, token: string) { return token.length > 0 && JSON.stringify(value).includes(token); }
  #labId(id: unknown): Fail | null { return typeof id === 'string' && id.length > 0 && id.length <= 100 ? null : fail(400, '실습실 ID가 올바르지 않습니다.'); }
  #uuid(id: unknown): Fail | null { return typeof id === 'string' && UUID.test(id) ? null : fail(400, '체크포인트 요청 ID가 올바르지 않습니다.'); }
  #revision(v: unknown): Fail | null { return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? null : fail(400, '수업 개정 번호가 올바르지 않습니다.'); }
  #seats(seats: unknown): number[] | Fail {
    if (!Array.isArray(seats) || seats.length < 1 || seats.length > 50 || seats.some((n) => !seatOk(n)) || new Set(seats).size !== seats.length) return fail(400, '자리 선택이 올바르지 않습니다.');
    return [...seats].sort((a, b) => a - b);
  }
}

function samePayloadSafe(cur: unknown, seats: number[], revision: number) {
  if (!isStored(cur)) return { live: false, op: null as StoredOp | null };
  return samePayload(cur, seats, revision) ? { live: false, op: cur } : fail(409, '같은 요청 ID에 다른 내용을 쓸 수 없습니다.');
}
