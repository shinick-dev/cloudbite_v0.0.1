// 수업 만들기 요청의 작은 영속 방벽. 공급자 결과를 추측하거나 재실행하지 않는다.
// lc:<시간>:<난수> 대신 lc_<13자리 ms>_<32자리 hex>. 첫 사용 24h, 기록 48h: 지운 옛 ID는 다시 쓸 수 없다.
import type { Fail } from './state';
import { isSnapPending, type SnapPending } from './lab-snapshot-service';

export const CREATE_PREFIX = 'labcreate:';
export const CREATE_WINDOW = 24 * 3600e3;
export const CREATE_KEEP = 48 * 3600e3;
export const CREATE_MAX = 128;
const SKEW = 5 * 60e3;
const fail = (status: number, error: string): Fail => ({ status, error });
const isFail = (x: unknown): x is Fail => !!x && typeof x === 'object' && 'status' in x && 'error' in x;
export interface CreateSummary { id: string; name: string; createdAt: number; expiresAt: number; seatCount: number; failedSeats: number }
export interface CreatePending { requestId: string; creationState: 'preparing' | 'running' | 'unknown'; retryAfterMs: number; snapshotPreparing?: true; snapshot?: string; state?: string }
export interface CreateDone { ok: true; requestId: string; creationState: 'completed'; lab: CreateSummary }
export interface CreateNotStarted { requestId: string; creationState: 'not-started' }
export type CreateResult = CreatePending | CreateDone | CreateNotStarted | Fail;
interface Claim { hash: string; issuedAt: number; phase: 'preparing' | 'running' | 'unknown' | 'completed'; labId?: string; snapshot?: SnapPending }
export interface CreateDeps<P> {
  storage: Pick<DurableObjectStorage, 'get' | 'put' | 'delete' | 'list'>;
  now(): number;
  checkAdmin(token: string): Promise<boolean>;
  validate(input: Record<string, unknown>): Promise<P | Fail>;
  execute(token: string, prepared: P, arm: (labId: string) => Promise<void>): Promise<{ labId: string } | SnapPending | Fail>;
  summary(labId: string): Promise<CreateSummary | Fail>;
}
const ALLOWED = new Set(['name','seats','hours','budget','cpu','memory','disk','snapshot','model','gw','materials','clipIn','clipOut','share','parentLabId','openRequestId','parentVersion']);

/** JSON 값·형식·생략을 그대로 묶는다. 키 순서만 맞추고 trim/Number/default는 쓰지 않는다. */
export function createPayload(input: Record<string, unknown>): string | Fail {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail(400, '수업 만들기 입력이 올바르지 않습니다.');
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(input)) {
    if (key === 'requestId') continue;
    if (!ALLOWED.has(key)) return fail(400, '수업 만들기 입력 항목이 올바르지 않습니다.');
    out[key] = input[key];
  }
  let nodes = 0;
  const encode = (x: unknown, depth = 0): string => {
    if (++nodes > 256 || depth > 4) throw new Error();
    if (x === null || typeof x === 'string' || typeof x === 'boolean' || (typeof x === 'number' && Number.isFinite(x))) return JSON.stringify(x);
    if (x && typeof x === 'object' && !Array.isArray(x) && Object.getPrototypeOf(x) === Object.prototype) {
      return '{' + Object.keys(x).sort().map((k) => JSON.stringify(k) + ':' + encode((x as Record<string, unknown>)[k], depth + 1)).join(',') + '}';
    }
    // JSON 본문 밖 RPC 값(undefined/NaN/배열/특수 object)은 받지 않는다.
    throw new Error();
  };
  try { const s = encode(out); return new TextEncoder().encode(s).length <= 16384 ? s : fail(400, '수업 만들기 입력이 너무 큽니다.'); }
  catch { return fail(400, '수업 만들기 입력 형식이 올바르지 않습니다.'); }
}

export class LabCreateService<P> {
  constructor(private d: CreateDeps<P>) {}
  #lock: Promise<unknown> = Promise.resolve();
  #live = new Map<string, Promise<CreateResult>>();
  async #auth(token: string) { return await this.d.checkAdmin(token) ? null : fail(401, '관리 세션이 만료됐습니다.'); }
  #id(id: unknown): { id: string; issuedAt: number } | Fail {
    if (typeof id !== 'string' || id.length !== 49 || !/^lc_\d{13}_[a-f0-9]{32}$/.test(id)) return fail(400, '만들기 요청 ID가 올바르지 않습니다.');
    const issuedAt = Number(id.slice(3, 16));
    if (issuedAt > this.d.now() + SKEW) return fail(400, '만들기 요청 ID의 시각이 올바르지 않습니다.');
    if (this.d.now() - issuedAt >= CREATE_KEEP) return fail(410, '만들기 요청 기록이 만료됐습니다. 수업 목록을 확인하세요.');
    return { id, issuedAt };
  }
  #pending(id: string, c: Claim): CreatePending {
    return { requestId: id, creationState: c.phase === 'completed' ? 'unknown' : c.phase, retryAfterMs: 5000, ...(c.phase === 'preparing' && c.snapshot ? { snapshotPreparing: true as const, snapshot: c.snapshot.snapshot, state: c.snapshot.state } : {}) };
  }
  async #view(id: string, c: Claim): Promise<CreateResult> {
    // No arm() barrier was crossed and no process is still executing this ID.
    // Legacy pre-snapshot validation failures otherwise trap the UI forever.
    if (c.phase === 'preparing' && !c.labId && !c.snapshot && !this.#live.has(id)) return { requestId: id, creationState: 'not-started' };
    if (c.labId && (c.phase === 'completed' || !this.#live.has(id))) { const current = await this.d.summary(c.labId); if (isFail(current)) return current; }
    if (c.phase !== 'completed' || !c.labId) return this.#pending(id, { ...c, phase: c.phase === 'running' && !this.#live.has(id) ? 'unknown' : c.phase });
    const lab = await this.d.summary(c.labId);
    return isFail(lab) ? lab : { ok: true, requestId: id, creationState: 'completed', lab };
  }
  async status(token: string, rawId: unknown): Promise<CreateResult> {
    try {
      const a = await this.#auth(token); if (a) return a;
      const id = this.#id(rawId); if (isFail(id)) return id;
      const c = await this.d.storage.get<Claim>(CREATE_PREFIX + id.id);
      const r = c ? await this.#view(id.id, c) : fail(404, '만들기 요청 기록이 없습니다.');
      return await this.#auth(token) ?? r;
    } catch { return fail(503, '만들기 요청 기록을 확인하지 못했습니다. 수업 목록을 확인하세요.'); }
  }
  async create(token: string, input: Record<string, unknown>): Promise<CreateResult> {
    try {
      const a = await this.#auth(token); if (a) return a;
      const id = this.#id(input?.requestId); if (isFail(id)) return id;
      const payload = createPayload(input); if (isFail(payload)) return payload;
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload)))).map((b) => b.toString(16).padStart(2, '0')).join('');
      // 바깥 응답을 기다리다 다른 요청이 들어와도 claim과 live 설정은 한 줄로 처리한다.
      const acquire = this.#lock.then(async (): Promise<{ run: Promise<CreateResult> } | { result: CreateResult }> => {
        const auth = await this.#auth(token); if (auth) return { result: auth };
        const key = CREATE_PREFIX + id.id;
        let c = await this.d.storage.get<Claim>(key);
        if (c && c.hash !== hash) return { result: fail(409, '같은 만들기 요청 ID에 다른 입력은 쓸 수 없습니다.') };
        if (c) {
          const run = this.#live.get(id.id); if (run) return { run };
          if (c.phase !== 'preparing') return { result: await this.#view(id.id, c) };
        } else {
          if (this.d.now() - id.issuedAt >= CREATE_WINDOW) return { result: fail(410, '만들기 요청 ID가 만료됐습니다. 수업 목록을 확인하세요.') };
          const all = await this.d.storage.list<Claim>({ prefix: CREATE_PREFIX, limit: CREATE_MAX + 1 });
          let count = all.size;
          for (const [k, v] of all) if (this.d.now() - v.issuedAt >= CREATE_KEEP) { await this.d.storage.delete(k); count--; }
          if (count >= CREATE_MAX) return { result: fail(429, '만들기 요청 기록이 가득 찼습니다. 나중에 다시 시도하세요.') };
        }
        const prepared = await this.d.validate(JSON.parse(payload));
        if (isFail(prepared)) return { result: prepared };
        const auth2 = await this.#auth(token); if (auth2) return { result: auth2 };
        c ??= { hash, issuedAt: id.issuedAt, phase: 'preparing' };
        await this.d.storage.put(key, c); // snapshot POST도 이 뒤에만.
        const run = this.#run(token, id.id, c, prepared);
        this.#live.set(id.id, run);
        void run.finally(() => { this.#live.delete(id.id); }).catch(() => {});
        return { run };
      });
      this.#lock = acquire.catch(() => {});
      const got = await acquire;
      const r = 'run' in got ? await got.run : got.result;
      return await this.#auth(token) ?? r;
    } catch { return fail(503, '만들기 요청 결과를 확인하지 못했습니다. 같은 요청 ID로 확인하세요.'); }
  }
  async #run(token: string, id: string, claim: Claim, prepared: P): Promise<CreateResult> {
    const key = CREATE_PREFIX + id;
    let c = { ...claim };
    try {
      const r = await this.d.execute(token, prepared, async (labId) => {
        const a = await this.#auth(token); if (a) throw a;
        c = { ...c, phase: 'running', labId, snapshot: undefined };
        await this.d.storage.put(key, c); // 세션·샌드박스 부작용 전에 반드시 기다린다.
        const after = await this.#auth(token); if (after) throw after;
      });
      const auth = await this.#auth(token); if (auth) throw auth;
      if (isSnapPending(r)) { c = { ...c, phase: 'preparing', snapshot: r }; await this.d.storage.put(key, c); return this.#pending(id, c); }
      if (isFail(r)) {
        if (c.phase === 'running') { c = { ...c, phase: 'unknown' }; await this.d.storage.put(key, c); }
        return r;
      }
      if (c.phase !== 'running' || c.labId !== r.labId) throw new Error();
      const summary = await this.d.summary(r.labId);
      if (isFail(summary)) { c = { ...c, phase: 'unknown' }; await this.d.storage.put(key, c); return summary; }
      c = { ...c, phase: 'completed' };
      await this.d.storage.put(key, c);
      return await this.#view(id, c); // 완료 기록 뒤에도 현재 lab을 읽는다.
    } catch (e) {
      // 쓰기에 실패해도 앞선 running 기록은 남는다. 다음 요청은 재실행하지 않는다.
      if (c.phase === 'running') { c = { ...c, phase: 'unknown' }; try { await this.d.storage.put(key, c); } catch {} }
      return isFail(e) ? e : this.#pending(id, { ...c, phase: c.phase === 'preparing' ? 'preparing' : 'unknown' });
    }
  }
}