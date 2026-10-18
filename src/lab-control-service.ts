// 실습실마다 명령 전달 상태(running/paused/ended)를 영속한다.
// 터미널 소유자나 전송 잠금과 무관하다. API·State 연결·화면은 이 파일 밖에 둔다.
import type { Fail } from './state';

export const LAB_CONTROL_ACTION_LIMIT = 128;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const fail = (status: number, error: string): Fail => ({ status, error });
const isFail = (x: unknown): x is Fail => !!x && typeof x === 'object' && 'error' in x && 'status' in x;
const legacy = (): LabControlView => ({ mode: 'running', revision: 0, updatedAt: null });

export type LabControlMode = 'running' | 'paused' | 'ended';
export interface LabControlView { mode: LabControlMode; revision: number; updatedAt: number | null }
export interface LabControlEpoch { labId: string; revision: number }
export interface LabControlAction {
  id: string;
  kind: 'pause' | 'resume';
  expectedRevision: number | null;
  response: LabControlView | Fail;
}
export interface LabControlRow {
  mode: LabControlMode;
  revision: number;
  updatedAt: number;
  actions: LabControlAction[];
}
interface ControlLab { id: string; expiresAt: number; endRetry?: number }
interface Deps {
  storage: Pick<DurableObjectStorage, 'get' | 'put' | 'transaction'>;
  now(): number;
  checkAdmin(token: string): Promise<boolean>;
  lab(id: string): Promise<ControlLab | undefined>;
  audit(event: string, detail: string): Promise<void>;
}
interface Decision { body: LabControlView | Fail; changed: boolean }

/** State가 마지막 저장소 읽기에 넣을 키. 값은 LabControlRow 다. */
export const controlKey = (id: string) => `labctrl:${id}`;

/** 없는 행이고 수업이 살아 있으면 running revision 0. 깨진 행은 전달 불가로 본다. */
export function controlView(row: unknown): LabControlView {
  if (row == null) return legacy();
  if (typeof row !== 'object') return { mode: 'ended', revision: 0, updatedAt: null };
  const r = row as Partial<LabControlRow>;
  if ((r.mode === 'running' || r.mode === 'paused' || r.mode === 'ended') && Number.isSafeInteger(r.revision) && (r.revision ?? -1) >= 0) {
    return { mode: r.mode, revision: r.revision as number, updatedAt: typeof r.updatedAt === 'number' && Number.isFinite(r.updatedAt) ? r.updatedAt : null };
  }
  return { mode: 'ended', revision: 0, updatedAt: null };
}

/** acquire가 잡은 running epoch가 아직 그 행과 같은지. 권한 판정은 하지 않는다. */
export function controlEpochMatches(epoch: LabControlEpoch, row: unknown): boolean {
  if (!epoch || typeof epoch.labId !== 'string' || !epoch.labId || !Number.isSafeInteger(epoch.revision) || epoch.revision < 0) return false;
  if (row != null && !isStoredRow(row)) return false;
  const view = controlView(row);
  return view.mode === 'running' && view.revision === epoch.revision;
}

const isMode = (x: unknown): x is LabControlMode => x === 'running' || x === 'paused' || x === 'ended';
function isStoredRow(x: unknown): x is LabControlRow {
  if (!x || typeof x !== 'object') return false;
  const row = x as LabControlRow;
  return isMode(row.mode) && Number.isSafeInteger(row.revision) && row.revision >= 0 && typeof row.updatedAt === 'number' && Number.isFinite(row.updatedAt) && Array.isArray(row.actions);
}

export class LabControlService {
  #ended = new Set<string>();
  constructor(private d: Deps) {}
  private get s() { return this.d.storage; }

  async status(token: string, id: string) {
    const bad = this.#labId(id);
    if (bad) return bad;
    try {
      if (!(await this.d.checkAdmin(token))) return fail(401, '관리 세션이 만료됐습니다.');
      const live = await this.#live(id);
      if (isFail(live)) return live;
      const row = await this.s.get<unknown>(controlKey(id));
      const again = await this.#live(id);
      if (isFail(again)) return again;
      if (row != null && !isStoredRow(row)) return fail(503, '명령 전달 상태를 확인하지 못했습니다.');
      return controlView(row);
    } catch {
      return fail(503, '명령 전달 상태를 확인하지 못했습니다.');
    }
  }

  async pause(token: string, id: string, requestId: unknown) {
    const bad = this.#labId(id) ?? this.#actionId(requestId);
    if (bad) return bad;
    try { return await this.#mutate(token, id, requestId as string, 'pause', null); }
    catch { return fail(503, '명령 전달 상태를 저장하지 못했습니다.'); }
  }

  async resume(token: string, id: string, requestId: unknown, expectedRevision: unknown) {
    const bad = this.#labId(id) ?? this.#actionId(requestId) ?? this.#revision(expectedRevision);
    if (bad) return bad;
    try { return await this.#mutate(token, id, requestId as string, 'resume', expectedRevision as number); }
    catch { return fail(503, '명령 전달 상태를 저장하지 못했습니다.'); }
  }

  /** 수업 종료가 제어 변경보다 우선이다. ended 행을 남기고, 이미 ended면 개정 번호를 올리지 않는다. */
  async end(id: string) {
    const bad = this.#labId(id);
    if (bad) return bad;
    this.#ended.add(id); // 저장을 기다리는 동안에도 종료가 진행 중인 재개보다 우선한다.
    try {
      const reply = await this.s.transaction(async (tx) => {
        const cur = await tx.get<unknown>(controlKey(id));
        if (cur != null && !isStoredRow(cur)) return fail(503, '명령 전달 종료 상태를 저장하지 못했습니다.');
        if (isStoredRow(cur) && cur.mode === 'ended') return { body: controlView(cur), changed: false };
        const next: LabControlView = { mode: 'ended', revision: (isStoredRow(cur) ? cur.revision : 0) + 1, updatedAt: this.d.now() };
        await tx.put(controlKey(id), { ...next, actions: isStoredRow(cur) ? cur.actions : [] });
        return { body: next, changed: true };
      });
      if (isFail(reply)) return reply;
      if (reply.changed) await this.#audit('lab-control-end', id, reply.body.revision);
      return reply.body;
    } catch {
      return fail(503, '명령 전달 종료 상태를 저장하지 못했습니다.');
    }
  }

  /**
   * 지금 전달이 허용되면 그 running epoch를 돌려준다. 인증하지 않는다.
   * State는 외부 변경 직전에 같은 키를 다시 읽어 controlEpochMatches로 비교한다.
   */
  async acquire(id: string): Promise<LabControlEpoch | Fail> {
    const bad = this.#labId(id);
    if (bad) return bad;
    try {
      const live = await this.#live(id);
      if (isFail(live)) return live;
      const row = await this.s.get<unknown>(controlKey(id));
      const liveAgain = await this.#live(id);
      if (isFail(liveAgain)) return liveAgain;
      const again = await this.s.get<unknown>(controlKey(id));
      if (JSON.stringify(row) !== JSON.stringify(again)) return fail(409, '명령 전달 상태가 바뀌었습니다. 다시 확인하세요.');
      if (again != null && !isStoredRow(again)) return fail(503, '명령 전달 상태를 확인하지 못했습니다.');
      const view = controlView(again);
      if (view.mode === 'paused') return fail(409, '명령 전달이 일시정지되어 있습니다.');
      if (view.mode !== 'running') return fail(410, '모임이 끝났습니다.');
      return { labId: id, revision: view.revision };
    } catch {
      return fail(503, '명령 전달 상태를 확인하지 못했습니다.');
    }
  }

  async #mutate(token: string, id: string, requestId: string, kind: 'pause' | 'resume', expectedRevision: number | null) {
    if (!(await this.d.checkAdmin(token))) return fail(401, '관리 세션이 만료됐습니다.');
    const live = await this.#live(id);
    if (isFail(live)) return live;
    const reply = await this.s.transaction(async (tx) => {
      if (!(await this.d.checkAdmin(token))) return fail(401, '관리 세션이 만료됐습니다.');
      const liveNow = await this.#live(id);
      if (isFail(liveNow)) return liveNow;
      const cur = await tx.get<unknown>(controlKey(id));
      // Lab lookup and storage reads can yield. Revalidate authority at the write boundary.
      if (!(await this.d.checkAdmin(token))) return fail(401, '관리 세션이 만료됐습니다.');
      if (this.#ended.has(id) || liveNow.expiresAt <= this.d.now()) return fail(410, '모임이 끝났습니다.');
      if (cur != null && !isStoredRow(cur)) return fail(503, '명령 전달 상태를 확인하지 못했습니다.');
      const row = isStoredRow(cur) ? cur : null;
      const prior = row?.actions.find((a) => a.id === requestId);
      if (prior) {
        if (prior.kind !== kind || prior.expectedRevision !== expectedRevision) return fail(409, '같은 요청 ID에 다른 동작을 쓸 수 없습니다.');
        return { body: prior.response, changed: false };
      }
      if ((row?.actions.length ?? 0) >= LAB_CONTROL_ACTION_LIMIT) return fail(429, '이 실습실의 제어 동작 기록 한도(128)에 도달했습니다.');
      if (row?.mode === 'ended') return this.#keep(tx, id, row, fail(410, '모임이 끝났습니다.'), requestId, kind, expectedRevision);
      const current = controlView(row);
      if (kind === 'resume') {
        if (current.mode !== 'paused') return this.#keep(tx, id, row, fail(409, '명령 전달이 일시정지 상태가 아닙니다.'), requestId, kind, expectedRevision);
        if (current.revision !== expectedRevision) return this.#keep(tx, id, row, fail(409, '명령 전달 재개 개정 번호가 현재와 다릅니다.'), requestId, kind, expectedRevision);
        const next: LabControlView = { mode: 'running', revision: current.revision + 1, updatedAt: this.d.now() };
        return this.#keep(tx, id, row, next, requestId, kind, expectedRevision);
      }
      // A distinct pause invalidates any older in-flight resume, even when already paused.
      const next: LabControlView = { mode: 'paused', revision: current.revision + 1, updatedAt: this.d.now() };
      return this.#keep(tx, id, row, next, requestId, kind, expectedRevision);
    });
    if (isFail(reply)) return reply;
    if (reply.changed && !isFail(reply.body)) await this.#audit(kind === 'pause' ? 'lab-control-pause' : 'lab-control-resume', id, reply.body.revision);
    return reply.body;
  }

  async #keep(tx: Pick<DurableObjectStorage, 'put'>, id: string, row: LabControlRow | null, body: LabControlView | Fail, requestId: string, kind: 'pause' | 'resume', expectedRevision: number | null): Promise<Decision> {
    const next = isFail(body) ? null : body;
    const changed = !!next && (next.mode !== (row?.mode ?? 'running') || next.revision !== (row?.revision ?? 0));
    const view = next ?? (row ? controlView(row) : legacy());
    const stored: LabControlRow = {
      mode: view.mode, revision: view.revision, updatedAt: view.updatedAt ?? this.d.now(),
      actions: [...(row?.actions ?? []), { id: requestId, kind, expectedRevision, response: body }],
    };
    await tx.put(controlKey(id), stored);
    return { body, changed };
  }

  async #audit(event: string, id: string, revision: number) {
    await this.d.audit(event, `${id} ${revision}`).catch(() => {});
  }

  async #live(id: string) {
    const lab = await this.d.lab(id);
    if (this.#ended.has(id)) return fail(410, '모임이 끝났습니다.');
    if (!lab || lab.id !== id) return fail(404, '없는 실습실입니다.');
    if (lab.endRetry || lab.expiresAt <= this.d.now()) return fail(410, '모임이 끝났습니다.');
    return lab;
  }

  #labId(id: unknown): Fail | null {
    return typeof id === 'string' && id.length > 0 && id.length <= 100 ? null : fail(400, '실습실 ID가 올바르지 않습니다.');
  }
  #actionId(id: unknown): Fail | null {
    return typeof id === 'string' && UUID.test(id) ? null : fail(400, '제어 요청 ID가 올바르지 않습니다.');
  }
  #revision(v: unknown): Fail | null {
    return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? null : fail(400, '재개 개정 번호가 올바르지 않습니다.');
  }
}
