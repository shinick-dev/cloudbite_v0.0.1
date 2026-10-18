// 수업 tmux 창에 대한 중단 의도를 미리보기·요청 두 단계로 영속한다.
// 이 서비스는 샌드박스를 멈추거나 지우지 않고, 입력도 직접 보내지 않는다.
// Ctrl+C 전달은 프로그램이 멈췄다는 증거가 아니다. 창 증명과 입력은 주입된 remote만 다룬다.
import type { Fail } from './state';

export const LAB_INTERRUPT_PREVIEW_LIMIT = 128;
export const LAB_INTERRUPT_ACTION_LIMIT = 100;
export const LAB_INTERRUPT_TTL_MS = 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const PANE = /^%[0-9]+$/;
const CONTROLS = /[\x00-\x1f\x7f]/;
const fail = (status: number, error: string): Fail => ({ status, error });
const isFail = (x: unknown): x is Fail => !!x && typeof x === 'object' && 'status' in x && 'error' in x && typeof (x as Fail).status === 'number' && typeof (x as Fail).error === 'string';

export interface InterruptRef { labId: string; n: number; code: string; sandboxId: string }
export interface InterruptContext { owner: string; sessionId: string; revision: number; fingerprint: string; refs: InterruptRef[] }
export interface InterruptPaneProof { fingerprint: string; paneId: string; program: string }
export interface InterruptPreviewRecord {
  previewId: string;
  owner: string;
  sessionId: string;
  revision: number;
  fingerprint: string;
  targets: Array<{ ref: InterruptRef; proof: InterruptPaneProof }>;
  createdAt: number;
  expiresAt: number;
  consumedBy: string | null;
}
/** end(id) 이후 false. remote는 입력을 보내기 직전에 다시 호출한다. true일 때만 전달한다. */
export type InterruptGate = () => boolean;
export interface InterruptPreviewView { previewId: string; expiresAt: number; targets: Array<{ n: number; program: string }>; revision: number }
export type InterruptStatus = 'pending' | 'sent' | 'changed' | 'unknown' | 'skipped';
export interface InterruptResultRow { n: number; status: InterruptStatus; note: string }
export interface InterruptRequestView { requestId: string; results: InterruptResultRow[] }

const NOTES: Record<InterruptStatus, string> = {
  pending: '중단 입력 결과를 아직 확정하지 못했습니다.',
  sent: '중단 입력을 전달했습니다. 종료 여부는 확인하지 않습니다.',
  changed: '창 상태가 미리보기와 달라 입력을 보내지 않았습니다.',
  unknown: '중단 입력 결과를 확인하지 못했습니다. 다시 보내지 않습니다.',
  skipped: '수업 상태가 바뀌어 입력을 보내지 않았습니다.',
};

interface InterruptOperation { requestId: string; previewId: string; results: InterruptResultRow[] }
interface Deps {
  storage: Pick<DurableObjectStorage, 'get' | 'put' | 'list' | 'transaction'>;
  now(): number;
  authorize(token: string, id: string): Promise<Fail | null>;
  context(token: string, id: string): Promise<InterruptContext | Fail>;
  probe(token: string, ref: InterruptRef, sessionId: string): Promise<InterruptPaneProof | Fail>;
  remote(token: string, ref: InterruptRef, record: InterruptPreviewRecord, requestId: string, gate: InterruptGate): Promise<'sent' | 'changed' | 'duplicate'>;
  audit(event: string, detail: string): Promise<void>;
}
type Tx = Pick<DurableObjectStorage, 'get' | 'put' | 'list'>;
type Target = InterruptPreviewRecord['targets'][number];
type Claimed = { replay: true; op: InterruptOperation } | { replay: false; op: InterruptOperation; preview: InterruptPreviewRecord };

const previewPrefix = (id: string) => `labint:p:${encodeURIComponent(id)}:`;
const operationPrefix = (id: string) => `labint:o:${encodeURIComponent(id)}:`;
/** State가 미리보기 한 건을 찾는 키. 값은 InterruptPreviewRecord 다. */
export const interruptPreviewKey = (id: string, previewId: string) => `${previewPrefix(id)}${previewId}`;
/** 중단 요청 한 건의 키. 값은 요청 ID·미리보기 ID·자리별 상태뿐이고 명령·출력은 없다. */
export const interruptOperationKey = (id: string, requestId: string) => `${operationPrefix(id)}${requestId}`;

const safeText = (x: unknown, max: number): x is string => typeof x === 'string' && x.length >= 1 && x.length <= max && !CONTROLS.test(x);
const seatOk = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 1 && n <= 50;
const copyRef = (r: InterruptRef): InterruptRef => ({ labId: r.labId, n: r.n, code: r.code, sandboxId: r.sandboxId });
const copyProof = (p: InterruptPaneProof): InterruptPaneProof => ({ fingerprint: p.fingerprint, paneId: p.paneId, program: p.program });
const sameRef = (a: InterruptRef, b: InterruptRef) => a.labId === b.labId && a.n === b.n && a.code === b.code && a.sandboxId === b.sandboxId;
const previewView = (row: InterruptPreviewRecord): InterruptPreviewView => ({
  previewId: row.previewId,
  expiresAt: row.expiresAt,
  revision: row.revision,
  targets: row.targets.map((t) => ({ n: t.ref.n, program: t.proof.program })),
});
const requestView = (op: InterruptOperation): InterruptRequestView => ({
  requestId: op.requestId,
  results: op.results.map((r) => ({ n: r.n, status: r.status, note: r.note })),
});

function isRef(x: unknown, labId: string): x is InterruptRef {
  if (!x || typeof x !== 'object') return false;
  const r = x as InterruptRef;
  return r.labId === labId && seatOk(r.n) && safeText(r.code, 200) && safeText(r.sandboxId, 200);
}
function isProof(x: unknown): x is InterruptPaneProof {
  if (!x || typeof x !== 'object' || isFail(x)) return false;
  const p = x as InterruptPaneProof;
  return typeof p.fingerprint === 'string' && HEX64.test(p.fingerprint) && typeof p.paneId === 'string' && PANE.test(p.paneId) && safeText(p.program, 80);
}
function isContext(x: unknown, labId: string): x is InterruptContext {
  if (!x || typeof x !== 'object' || isFail(x)) return false;
  const c = x as InterruptContext;
  if (!safeText(c.owner, 512) || !safeText(c.sessionId, 200) || !safeText(c.fingerprint, 512)) return false;
  if (typeof c.revision !== 'number' || !Number.isSafeInteger(c.revision) || c.revision < 0) return false;
  if (!Array.isArray(c.refs) || c.refs.length > 50) return false;
  const seen = new Set<number>();
  return c.refs.every((r) => {
    if (!isRef(r, labId) || seen.has(r.n)) return false;
    seen.add(r.n);
    return true;
  });
}
function normalize(ctx: InterruptContext): InterruptContext {
  return {
    owner: ctx.owner,
    sessionId: ctx.sessionId,
    revision: ctx.revision,
    fingerprint: ctx.fingerprint,
    refs: [...ctx.refs].sort((a, b) => a.n - b.n).map(copyRef),
  };
}
function sameContext(a: InterruptContext, b: InterruptContext) {
  return a.owner === b.owner && a.sessionId === b.sessionId && a.revision === b.revision && a.fingerprint === b.fingerprint
    && a.refs.length === b.refs.length && a.refs.every((r, i) => sameRef(r, b.refs[i]));
}
function recordMatches(row: InterruptPreviewRecord, ctx: InterruptContext, seats: number[]) {
  if (row.owner !== ctx.owner || row.sessionId !== ctx.sessionId || row.revision !== ctx.revision || row.fingerprint !== ctx.fingerprint) return false;
  if (row.targets.length !== seats.length) return false;
  return row.targets.every((t, i) => {
    if (t.ref.n !== seats[i]) return false;
    const cur = ctx.refs.find((r) => r.n === t.ref.n);
    return !!cur && sameRef(cur, t.ref);
  });
}
function isPreview(x: unknown, labId: string, previewId: string): x is InterruptPreviewRecord {
  if (!x || typeof x !== 'object') return false;
  const r = x as InterruptPreviewRecord;
  if (r.previewId !== previewId || !UUID.test(r.previewId)) return false;
  if (!safeText(r.owner, 512) || !safeText(r.sessionId, 200) || !safeText(r.fingerprint, 512)) return false;
  if (typeof r.revision !== 'number' || !Number.isSafeInteger(r.revision) || r.revision < 0) return false;
  if (typeof r.createdAt !== 'number' || !Number.isFinite(r.createdAt) || typeof r.expiresAt !== 'number' || !Number.isFinite(r.expiresAt)) return false;
  if (r.consumedBy !== null && (typeof r.consumedBy !== 'string' || !UUID.test(r.consumedBy))) return false;
  if (!Array.isArray(r.targets) || r.targets.length < 1 || r.targets.length > 50) return false;
  return r.targets.every((t, i) => !!t && isRef(t.ref, labId) && isProof(t.proof) && (i === 0 || t.ref.n > r.targets[i - 1].ref.n));
}
function isOp(x: unknown): x is InterruptOperation {
  if (!x || typeof x !== 'object') return false;
  const o = x as InterruptOperation;
  const status = new Set<InterruptStatus>(['pending', 'sent', 'changed', 'unknown', 'skipped']);
  return UUID.test(o.requestId) && UUID.test(o.previewId) && Array.isArray(o.results) && o.results.length > 0 && o.results.length <= 50
    && o.results.every((r, i) => !!r && seatOk(r.n) && status.has(r.status) && typeof r.note === 'string' && r.note.length <= 200 && !CONTROLS.test(r.note) && (i === 0 || r.n > o.results[i - 1].n));
}
function clonePreview(row: InterruptPreviewRecord): InterruptPreviewRecord {
  return {
    previewId: row.previewId, owner: row.owner, sessionId: row.sessionId, revision: row.revision, fingerprint: row.fingerprint,
    createdAt: row.createdAt, expiresAt: row.expiresAt, consumedBy: row.consumedBy,
    targets: row.targets.map((t) => ({ ref: copyRef(t.ref), proof: copyProof(t.proof) })),
  };
}
function rowOf(n: number, status: InterruptStatus): InterruptResultRow {
  return { n, status, note: NOTES[status] };
}

export class LabInterruptService {
  #ended = new Set<string>();
  #inflight = new Set<string>();
  #claiming = new Map<string, number>();
  #lanes = new Map<string, Promise<unknown>>();
  constructor(private d: Deps) {}
  private get s() { return this.d.storage; }

  /** 같은 실습실의 미리보기만 줄 세운다. 요청과 end는 이 대기열을 타지 않는다. */
  #lane<T>(id: string, run: () => Promise<T>): Promise<T> {
    const prev = this.#lanes.get(id) ?? Promise.resolve();
    const next = prev.then(run, run);
    this.#lanes.set(id, next);
    return next.finally(() => { if (this.#lanes.get(id) === next) this.#lanes.delete(id); }) as Promise<T>;
  }

  async prepare(token: string, id: string, previewId: unknown, seats: unknown, expectedRevision: unknown): Promise<InterruptPreviewView | Fail> {
    const bad = this.#labId(id) ?? this.#uuid(previewId, '미리보기 ID가 올바르지 않습니다.') ?? this.#revision(expectedRevision);
    if (bad) return bad;
    const chosen = this.#seats(seats);
    if (isFail(chosen)) return chosen;
    return this.#lane(id, () => this.#prepare(token, id, previewId as string, chosen, expectedRevision as number));
  }

  async request(token: string, id: string, previewId: unknown, requestId: unknown): Promise<InterruptRequestView | Fail> {
    const bad = this.#labId(id) ?? this.#uuid(previewId, '미리보기 ID가 올바르지 않습니다.') ?? this.#uuid(requestId, '중단 요청 ID가 올바르지 않습니다.');
    if (bad) return bad;
    const pid = previewId as string;
    const rid = requestId as string;
    const opKey = interruptOperationKey(id, rid);
    try {
      const auth = await this.#auth(token, id);
      if (auth) return auth;
      if (this.#inflight.has(opKey)) {
        const live = await this.s.get<unknown>(opKey);
        if (isOp(live)) {
          if (live.previewId !== pid) return fail(409, '같은 중단 요청 ID에 다른 미리보기를 쓸 수 없습니다.');
          return await this.#auth(token, id) ?? requestView(live);
        }
      }
      const existing = await this.s.get<unknown>(opKey);
      if (existing != null && !isOp(existing)) return fail(503, '중단 요청을 확인하지 못했습니다.');
      if (isOp(existing)) return this.#replay(token, id, opKey, existing, pid);
      if (this.#ended.has(id)) return fail(410, '모임이 끝났습니다.');
      this.#claiming.set(opKey, (this.#claiming.get(opKey) ?? 0) + 1);
      let claimed: Claimed | Fail;
      try {
        claimed = await this.s.transaction((tx) => this.#claim(tx, token, id, pid, rid));
        if (!isFail(claimed) && !claimed.replay) this.#inflight.add(opKey);
      } finally {
        const left = (this.#claiming.get(opKey) ?? 1) - 1;
        if (left) this.#claiming.set(opKey, left); else this.#claiming.delete(opKey);
      }
      if (isFail(claimed)) return claimed;
      if (claimed.replay) return this.#replay(token, id, opKey, claimed.op, pid);
      try {
        const done = await this.#execute(token, id, rid, claimed.op, claimed.preview);
        if (isFail(done)) return done;
        await this.#audit('lab-interrupt-request', `${id} ${rid} ${claimed.op.results.length}`);
        return await this.#auth(token, id) ?? requestView(claimed.op);
      } finally {
        this.#inflight.delete(opKey);
      }
    } catch {
      return fail(503, '중단 요청을 저장하지 못했습니다.');
    }
  }

  /** 저장을 기다리지 않는다. 이 인스턴스의 이후 입력만 막으며, 재구성 뒤의 벽은 context·authorize다. */
  end(id: string): Fail | { ended: true } {
    const bad = this.#labId(id);
    if (bad) return bad;
    this.#ended.add(id);
    return { ended: true };
  }

  async #prepare(token: string, id: string, previewId: string, seats: number[], expectedRevision: number): Promise<InterruptPreviewView | Fail> {
    try {
      const auth = await this.#auth(token, id);
      if (auth) return auth;
      if (this.#ended.has(id)) return fail(410, '모임이 끝났습니다.');
      const ctx = await this.#ctx(token, id);
      if (isFail(ctx)) return ctx;
      if (ctx.revision !== expectedRevision) return fail(409, '명령 전달 상태가 바뀌었습니다. 대상을 다시 확인하세요.');
      const refs = this.#pick(ctx, seats);
      if (isFail(refs)) return refs;
      const key = interruptPreviewKey(id, previewId);
      const cur = await this.s.get<unknown>(key);
      const again = await this.#ctx(token, id);
      if (isFail(again)) return again;
      if (!sameContext(ctx, again)) return fail(409, '중단 대상이 바뀌었습니다. 다시 확인하세요.');
      const authAgain = await this.#auth(token, id);
      if (authAgain) return authAgain;
      if (this.#ended.has(id)) return fail(410, '모임이 끝났습니다.');
      if (cur != null && !isPreview(cur, id, previewId)) return fail(503, '중단 미리보기를 확인하지 못했습니다.');
      if (isPreview(cur, id, previewId)) {
        if (!recordMatches(cur, again, seats)) return fail(409, '같은 미리보기 ID에 다른 내용을 쓸 수 없습니다.');
        if (cur.expiresAt <= this.d.now()) return fail(410, '중단 미리보기가 만료됐습니다.');
        return previewView(cur);
      }
      if ((await this.s.list({ prefix: previewPrefix(id), limit: LAB_INTERRUPT_PREVIEW_LIMIT })).size >= LAB_INTERRUPT_PREVIEW_LIMIT) {
        return fail(429, '이 실습실의 중단 미리보기 한도(128)에 도달했습니다.');
      }
      const proofs: InterruptPaneProof[] = [];
      for (const ref of refs) {
        if (this.#ended.has(id)) return fail(410, '모임이 끝났습니다.');
        const authProbe = await this.#auth(token, id);
        if (authProbe) return authProbe;
        const live = await this.#ctx(token, id);
        if (isFail(live)) return live;
        const current = live.refs.find((r) => r.n === ref.n);
        if (!sameContext(again, live) || !current || !sameRef(current, ref)) return fail(409, '중단 대상이 바뀌었습니다. 다시 확인하세요.');
        const proof = await this.#probe(token, current, live.sessionId);
        if (isFail(proof)) return proof;
        if (this.#ended.has(id)) return fail(410, '모임이 끝났습니다.');
        proofs.push(proof);
      }
      const ready = await this.#ctx(token, id);
      if (isFail(ready)) return ready;
      if (!sameContext(again, ready)) return fail(409, '중단 대상이 바뀌었습니다. 다시 확인하세요.');
      const reply = await this.s.transaction((tx) => this.#commitPreview(tx, token, id, previewId, seats, proofs, ready));
      if (isFail(reply)) return reply;
      if (reply.changed) await this.#audit('lab-interrupt-preview', `${id} ${previewId} ${reply.body.targets.length}`);
      return reply.body;
    } catch {
      return fail(503, '중단 미리보기를 저장하지 못했습니다.');
    }
  }

  async #commitPreview(tx: Tx, token: string, id: string, previewId: string, seats: number[], proofs: InterruptPaneProof[], captured: InterruptContext) {
    const key = interruptPreviewKey(id, previewId);
    const cur = await tx.get<unknown>(key);
    const auth = await this.#auth(token, id);
    if (auth) return auth;
    if (this.#ended.has(id)) return fail(410, '모임이 끝났습니다.');
    const fresh = await this.#ctx(token, id);
    if (isFail(fresh)) return fresh;
    if (!sameContext(captured, fresh)) return fail(409, '중단 대상이 바뀌었습니다. 다시 확인하세요.');
    const auth2 = await this.#auth(token, id);
    if (auth2) return auth2;
    const cur2 = await tx.get<unknown>(key);
    if (this.#ended.has(id)) return fail(410, '모임이 끝났습니다.');
    if (JSON.stringify(cur) !== JSON.stringify(cur2)) return fail(409, '중단 미리보기가 바뀌었습니다. 다시 확인하세요.');
    if (cur2 != null && !isPreview(cur2, id, previewId)) return fail(503, '중단 미리보기를 확인하지 못했습니다.');
    if (isPreview(cur2, id, previewId)) {
      if (!recordMatches(cur2, fresh, seats)) return fail(409, '같은 미리보기 ID에 다른 내용을 쓸 수 없습니다.');
      if (cur2.expiresAt <= this.d.now()) return fail(410, '중단 미리보기가 만료됐습니다.');
      return { body: previewView(cur2), changed: false };
    }
    if ((await tx.list({ prefix: previewPrefix(id), limit: LAB_INTERRUPT_PREVIEW_LIMIT })).size >= LAB_INTERRUPT_PREVIEW_LIMIT) {
      return fail(429, '이 실습실의 중단 미리보기 한도(128)에 도달했습니다.');
    }
    const latest = await this.#ctx(token, id);
    if (isFail(latest)) return latest;
    if (!sameContext(fresh, latest)) return fail(409, '중단 대상이 바뀌었습니다. 다시 확인하세요.');
    const finalAuth = await this.#auth(token, id);
    if (finalAuth) return finalAuth;
    if (this.#ended.has(id)) return fail(410, '모임이 끝났습니다.');
    const targets: Target[] = [];
    for (let i = 0; i < seats.length; i++) {
      const ref = latest.refs.find((r) => r.n === seats[i]);
      const proof = proofs[i];
      if (!ref || !proof || !isProof(proof)) return fail(409, '선택한 자리가 현재 일시정지된 수업에 없습니다.');
      targets.push({ ref: copyRef(ref), proof: copyProof(proof) });
    }
    const now = this.d.now();
    const row: InterruptPreviewRecord = {
      previewId, owner: latest.owner, sessionId: latest.sessionId, revision: latest.revision, fingerprint: latest.fingerprint,
      targets, createdAt: now, expiresAt: now + LAB_INTERRUPT_TTL_MS, consumedBy: null,
    };
    if (this.#leaks(row, token) || this.#ended.has(id)) return this.#ended.has(id) ? fail(410, '모임이 끝났습니다.') : fail(503, '중단 미리보기를 저장하지 못했습니다.');
    await tx.put(key, row);
    return { body: previewView(row), changed: true };
  }

  async #claim(tx: Tx, token: string, id: string, previewId: string, requestId: string): Promise<Claimed | Fail> {
    const opKey = interruptOperationKey(id, requestId);
    const existing = await tx.get<unknown>(opKey);
    if (existing != null && !isOp(existing)) return fail(503, '중단 요청을 확인하지 못했습니다.');
    if (isOp(existing)) {
      if (existing.previewId !== previewId) return fail(409, '같은 중단 요청 ID에 다른 미리보기를 쓸 수 없습니다.');
      return { replay: true, op: existing };
    }
    const key = interruptPreviewKey(id, previewId);
    const cur = await tx.get<unknown>(key);
    const auth = await this.#auth(token, id);
    if (auth) return auth;
    if (this.#ended.has(id)) return fail(410, '모임이 끝났습니다.');
    if (cur == null) return fail(404, '중단 미리보기가 없습니다.');
    if (!isPreview(cur, id, previewId)) return fail(503, '중단 미리보기를 확인하지 못했습니다.');
    if (cur.expiresAt <= this.d.now()) return fail(410, '중단 미리보기가 만료됐습니다.');
    if (cur.consumedBy && cur.consumedBy !== requestId) return fail(409, '이 미리보기는 다른 중단 요청에 이미 사용됐습니다.');
    if (cur.consumedBy === requestId) return fail(503, '중단 요청을 확인하지 못했습니다.');
    const ctx = await this.#ctx(token, id);
    if (isFail(ctx)) return ctx;
    if (!recordMatches(cur, ctx, cur.targets.map((t) => t.ref.n))) return fail(409, '중단 미리보기가 현재 수업과 다릅니다.');
    const againCur = await tx.get<unknown>(key);
    const again = await this.#ctx(token, id);
    if (isFail(again)) return again;
    const auth2 = await this.#auth(token, id);
    if (auth2) return auth2;
    if (this.#ended.has(id)) return fail(410, '모임이 끝났습니다.');
    if (!isPreview(againCur, id, previewId) || JSON.stringify(cur) !== JSON.stringify(againCur)) return fail(409, '중단 미리보기가 바뀌었습니다. 다시 확인하세요.');
    if (!recordMatches(againCur, again, againCur.targets.map((t) => t.ref.n))) return fail(409, '중단 미리보기가 현재 수업과 다릅니다.');
    if ((await tx.list({ prefix: operationPrefix(id), limit: LAB_INTERRUPT_ACTION_LIMIT })).size >= LAB_INTERRUPT_ACTION_LIMIT) {
      return fail(429, '이 실습실의 중단 요청 기록 한도(100)에 도달했습니다.');
    }
    const finalAuth = await this.#auth(token, id);
    if (finalAuth) return finalAuth;
    if (this.#ended.has(id)) return fail(410, '모임이 끝났습니다.');
    if (againCur.expiresAt <= this.d.now()) return fail(410, '중단 미리보기가 만료됐습니다.');
    const preview = clonePreview(againCur);
    preview.consumedBy = requestId;
    const op: InterruptOperation = { requestId, previewId, results: preview.targets.map((t) => rowOf(t.ref.n, 'pending')) };
    if (this.#leaks(preview, token) || this.#leaks(op, token)) return fail(503, '중단 요청을 저장하지 못했습니다.');
    await tx.put(key, preview);
    await tx.put(opKey, op);
    return { replay: false, op, preview };
  }

  async #execute(token: string, id: string, requestId: string, op: InterruptOperation, preview: InterruptPreviewRecord): Promise<Fail | null> {
    const opKey = interruptOperationKey(id, requestId);
    const targets = preview.targets;
    for (let i = 0; i < targets.length; i++) {
      const row = op.results.find((r) => r.n === targets[i].ref.n);
      if (!row || row.status !== 'pending') continue;
      if (this.#ended.has(id)) {
        this.#markFrom(op, targets, i, 'skipped');
        return this.#writeResults(opKey, op);
      }
      let ctx: InterruptContext | Fail;
      try {
        const auth = await this.#auth(token, id);
        if (auth) {
          this.#markFrom(op, targets, i, 'unknown');
          return await this.#writeResults(opKey, op);
        }
        ctx = await this.#ctx(token, id);
      } catch {
        this.#markFrom(op, targets, i, 'unknown');
        return this.#writeResults(opKey, op);
      }
      if (isFail(ctx)) {
        this.#markFrom(op, targets, i, ctx.status === 401 || ctx.status === 403 ? 'unknown' : 'skipped');
        return this.#writeResults(opKey, op);
      }
      if (!recordMatches(preview, ctx, targets.map((t) => t.ref.n)) || this.#ended.has(id)) {
        this.#markFrom(op, targets, i, 'skipped');
        return this.#writeResults(opKey, op);
      }
      const stored = await this.s.get<unknown>(opKey);
      const storedRow = isOp(stored) ? stored.results.find((r) => r.n === row.n) : undefined;
      if (!storedRow || storedRow.status !== 'pending') {
        if (storedRow) { row.status = storedRow.status; row.note = storedRow.note; }
        continue;
      }
      if (this.#ended.has(id)) {
        this.#markFrom(op, targets, i, 'skipped');
        return this.#writeResults(opKey, op);
      }
      let outcome: InterruptStatus = 'unknown';
      try {
        const gate: InterruptGate = () => !this.#ended.has(id);
        const result = await this.d.remote(token, copyRef(targets[i].ref), clonePreview(preview), requestId, gate);
        outcome = result === 'sent' || result === 'changed' ? result : 'unknown';
      } catch { outcome = 'unknown'; }
      row.status = outcome;
      row.note = NOTES[outcome];
      const saved = await this.#writeResults(opKey, op);
      if (saved) return saved;
    }
    return null;
  }

  async #replay(token: string, id: string, opKey: string, op: InterruptOperation, previewId: string): Promise<InterruptRequestView | Fail> {
    const auth = await this.#auth(token, id);
    if (auth) return auth;
    if (op.previewId !== previewId) return fail(409, '같은 중단 요청 ID에 다른 미리보기를 쓸 수 없습니다.');
    if (!op.results.some((r) => r.status === 'pending')) return requestView(op);
    if (this.#inflight.has(opKey) || this.#claiming.has(opKey)) return requestView(op);
    try {
      const saved = await this.s.transaction(async (tx) => {
        if (this.#inflight.has(opKey) || this.#claiming.has(opKey)) return { live: true, op };
        const cur = await tx.get<unknown>(opKey);
        const auth = await this.#auth(token, id);
        if (auth) return auth;
        if (!isOp(cur) || cur.previewId !== previewId) return { live: false, op: isOp(cur) ? cur : null };
        if (!cur.results.some((r) => r.status === 'pending')) return { live: false, op: cur };
        const next: InterruptOperation = { requestId: cur.requestId, previewId: cur.previewId, results: cur.results.map((r) => r.status === 'pending' ? rowOf(r.n, 'unknown') : { n: r.n, status: r.status, note: r.note }) };
        await tx.put(opKey, next);
        return { live: false, op: next };
      });
      if (isFail(saved)) return saved;
      if (!saved.op) return fail(503, '중단 요청을 확인하지 못했습니다.');
      return await this.#auth(token, id) ?? requestView(saved.op);
    } catch {
      return fail(503, '중단 요청을 확인하지 못했습니다.');
    }
  }

  async #writeResults(opKey: string, op: InterruptOperation): Promise<Fail | null> {
    try {
      const results = await this.s.transaction(async (tx) => {
        const cur = await tx.get<unknown>(opKey);
        if (!isOp(cur)) return op.results.map((r) => ({ ...r }));
        const merged = cur.results.map((r) => {
          const next = op.results.find((x) => x.n === r.n);
          if (!next || r.status !== 'pending') return { n: r.n, status: r.status, note: r.note };
          return { n: next.n, status: next.status, note: next.note };
        });
        await tx.put(opKey, { requestId: cur.requestId, previewId: cur.previewId, results: merged });
        return merged;
      });
      op.results = results;
      return null;
    } catch {
      return fail(503, '중단 요청을 저장하지 못했습니다.');
    }
  }

  #markFrom(op: InterruptOperation, targets: Target[], index: number, status: 'unknown' | 'skipped') {
    const ns = new Set(targets.slice(index).map((t) => t.ref.n));
    for (const row of op.results) if (row.status === 'pending' && ns.has(row.n)) { row.status = status; row.note = NOTES[status]; }
  }

  async #probe(token: string, ref: InterruptRef, sessionId: string): Promise<InterruptPaneProof | Fail> {
    try {
      const proof = await this.d.probe(token, ref, sessionId);
      if (isFail(proof)) return fail(proof.status >= 400 && proof.status <= 599 ? proof.status : 503, '선택한 자리의 창을 확인하지 못했습니다.');
      if (!isProof(proof)) return fail(502, '선택한 자리의 창 증명이 올바르지 않습니다.');
      return copyProof(proof);
    } catch {
      return fail(503, '선택한 자리의 창을 확인하지 못했습니다.');
    }
  }

  async #auth(token: string, id: string): Promise<Fail | null> {
    try {
      const auth = await this.d.authorize(token, id);
      if (isFail(auth)) return auth;
      if (auth != null) return fail(401, '관리 세션이 만료됐습니다.');
      return null;
    } catch {
      return fail(503, '관리 세션을 확인하지 못했습니다.');
    }
  }

  async #ctx(token: string, id: string): Promise<InterruptContext | Fail> {
    try {
      const ctx = await this.d.context(token, id);
      if (isFail(ctx)) return ctx;
      if (!isContext(ctx, id) || ctx.owner === token || (token.length > 0 && JSON.stringify(ctx).includes(token))) return fail(503, '수업 상태를 확인하지 못했습니다.');
      return normalize(ctx);
    } catch {
      return fail(503, '수업 상태를 확인하지 못했습니다.');
    }
  }

  #pick(ctx: InterruptContext, seats: number[]): InterruptRef[] | Fail {
    const refs: InterruptRef[] = [];
    for (const n of seats) {
      const found = ctx.refs.filter((r) => r.n === n);
      if (found.length !== 1) return fail(409, '선택한 자리가 현재 일시정지된 수업에 없습니다.');
      refs.push(copyRef(found[0]));
    }
    return refs;
  }

  #leaks(value: unknown, token: string) {
    return token.length > 0 && JSON.stringify(value).includes(token);
  }

  async #audit(event: string, detail: string) {
    await this.d.audit(event, detail).catch(() => {});
  }

  #labId(id: unknown): Fail | null {
    return typeof id === 'string' && id.length > 0 && id.length <= 100 ? null : fail(400, '실습실 ID가 올바르지 않습니다.');
  }
  #uuid(id: unknown, error: string): Fail | null {
    return typeof id === 'string' && UUID.test(id) ? null : fail(400, error);
  }
  #revision(v: unknown): Fail | null {
    return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? null : fail(400, '명령 전달 상태를 다시 확인하세요.');
  }
  #seats(seats: unknown): number[] | Fail {
    if (!Array.isArray(seats) || seats.length < 1 || seats.length > 50 || seats.some((n) => !seatOk(n)) || new Set(seats).size !== seats.length) return fail(400, '자리 선택이 올바르지 않습니다.');
    return [...seats].sort((a, b) => a - b);
  }
}
