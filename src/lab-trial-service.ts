// 1인 체험 실습실의 연결·예약·명령 전달 기록만 영속한다.
// 샌드박스 생성, 명령 실행, HTTP, 프로세스 제어는 이 파일 밖에 둔다.
import type { Fail } from './state';

export const LAB_TRIAL_RUN_LIMIT = 100;
const PROOF_MS = 5 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const fail = (status: number, error: string): Fail => ({ status, error });
const isFail = (x: unknown): x is Fail => !!x && typeof x === 'object' && 'error' in x && 'status' in x;

export interface TrialLab {
  id: string;
  name: string;
  expiresAt: number;
  endRetry?: number;
  fingerprint: string;
  eligible: boolean;
  seats: Array<{ n: number; sandboxId?: string }>;
}
export interface TrialBinding {
  bindingId: string;
  parentId: string;
  trialId: string;
  sandboxId: string;
  sessionId: string;
  configFingerprint: string;
  closed: boolean;
  boundAt: number;
}
export interface TrialReservation { parentId: string; trialId: string; bindingId: string }
export interface TrialProof { commandHash: string; configFingerprint: string; expiresAt: number }
export interface TrialClaim { claimed: true; runId: string; binding: TrialBinding }
export interface TrialReplay { claimed: false; runId: string; delivery: 'sent' | 'unknown' | 'error' }
interface TrialRequest { id: string; trialId: string; binding: TrialBinding }
interface StoredBinding extends TrialBinding { requests: TrialRequest[] }
interface TrialRun {
  runId: string;
  parentId: string;
  bindingId: string;
  trialId: string;
  sandboxId: string;
  configFingerprint: string;
  commandHash: string;
  delivery: 'pending' | 'sent' | 'unknown' | 'error';
  claimedAt: number;
}
interface Tomb { closed: true }
interface Deps {
  storage: Pick<DurableObjectStorage, 'get' | 'put' | 'list' | 'transaction'>;
  now(): number;
  checkAdmin(token: string): Promise<boolean>;
  lab(id: string): Promise<TrialLab | undefined>;
  audit(event: string, detail: string): Promise<void>;
}

export const trialBindingKey = (parentId: string) => `labtrial:bind:${parentId}`;
export const trialReserveKey = (trialId: string) => `labtrial:reserve:${trialId}`;
export const trialRunKey = (parentId: string, runId: string) => `labtrial:run:${parentId}:${runId}`;
const tombKey = (parentId: string) => `labtrial:tomb:${parentId}`;
const runPrefix = (parentId: string) => `labtrial:run:${parentId}:`;

const view = (b: TrialBinding): TrialBinding => ({
  bindingId: b.bindingId, parentId: b.parentId, trialId: b.trialId, sandboxId: b.sandboxId,
  sessionId: b.sessionId, configFingerprint: b.configFingerprint, closed: b.closed, boundAt: b.boundAt,
});
const isBinding = (x: unknown): x is TrialBinding => {
  if (!x || typeof x !== 'object') return false;
  const b = x as TrialBinding;
  return UUID.test(b.bindingId) && typeof b.parentId === 'string' && typeof b.trialId === 'string' && typeof b.sandboxId === 'string' && b.sandboxId.length > 0
    && UUID.test(b.sessionId) && typeof b.configFingerprint === 'string' && b.configFingerprint.length > 0 && typeof b.closed === 'boolean'
    && typeof b.boundAt === 'number' && Number.isFinite(b.boundAt);
};
const isRequest = (x: unknown): x is TrialRequest => !!x && typeof x === 'object' && typeof (x as TrialRequest).id === 'string' && typeof (x as TrialRequest).trialId === 'string' && isBinding((x as TrialRequest).binding);
const isStored = (x: unknown): x is StoredBinding => isBinding(x) && Array.isArray((x as StoredBinding).requests) && (x as StoredBinding).requests.every(isRequest);
const isReserve = (x: unknown): x is TrialReservation => {
  if (!x || typeof x !== 'object') return false;
  const r = x as TrialReservation;
  return typeof r.parentId === 'string' && typeof r.trialId === 'string' && UUID.test(r.bindingId);
};
const isDelivery = (x: unknown): x is TrialRun['delivery'] => x === 'pending' || x === 'sent' || x === 'unknown' || x === 'error';
const isRun = (x: unknown): x is TrialRun => {
  if (!x || typeof x !== 'object') return false;
  const r = x as TrialRun;
  return UUID.test(r.runId) && typeof r.parentId === 'string' && UUID.test(r.bindingId) && typeof r.trialId === 'string'
    && typeof r.sandboxId === 'string' && typeof r.configFingerprint === 'string' && /^[0-9a-f]{64}$/.test(r.commandHash)
    && isDelivery(r.delivery) && typeof r.claimedAt === 'number' && Number.isFinite(r.claimedAt);
};
const isTomb = (x: unknown): x is Tomb => !!x && typeof x === 'object' && (x as Tomb).closed === true;

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export class LabTrialService {
  #closed = new Set<string>();
  constructor(private d: Deps) {}
  private get s() { return this.d.storage; }

  async bind(token: string, parentId: string, trialId: string, requestId: unknown) {
    const bad = this.#id(parentId) ?? this.#id(trialId) ?? this.#uuid(requestId);
    if (bad) return bad;
    if (parentId === trialId) return fail(400, '체험 실습실은 부모 실습실과 달라야 합니다.');
    const req = requestId as string;
    try {
      if (!(await this.d.checkAdmin(token))) return fail(401, '관리 세션이 만료됐습니다.');
      await this.d.lab(parentId);
      await this.d.lab(trialId);
      if (this.#shut(parentId)) return fail(410, '모임이 끝났습니다.');
      const reply = await this.s.transaction(async (tx) => {
        if (!(await this.d.checkAdmin(token))) return fail(401, '관리 세션이 만료됐습니다.');
        const parent = await this.d.lab(parentId);
        const trial = await this.d.lab(trialId);
        const stored = await tx.get<unknown>(trialBindingKey(parentId));
        const reserve = await tx.get<unknown>(trialReserveKey(trialId));
        const parentReserve = await tx.get<unknown>(trialReserveKey(parentId));
        const trialParent = await tx.get<unknown>(trialBindingKey(trialId));
        const tomb = await tx.get<unknown>(tombKey(parentId));
        const priorId = isStored(stored) ? stored.trialId : '';
        const prior = priorId && priorId !== trialId ? await this.d.lab(priorId) : undefined;
        if (!(await this.d.checkAdmin(token))) return fail(401, '관리 세션이 만료됐습니다.');
        if (this.#shut(parentId) || isTomb(tomb)) return fail(410, '모임이 끝났습니다.');
        const parentFail = this.#live(parent, parentId);
        if (parentFail) return parentFail;
        if (stored != null && !isStored(stored)) return fail(503, '체험 연결을 확인하지 못했습니다.');
        const row = isStored(stored) ? stored : null;
        if (row?.closed) return fail(410, '모임이 끝났습니다.');
        const seen = row?.requests.find((r) => r.id === req);
        if (seen) {
          if (seen.trialId !== trialId || seen.binding.parentId !== parentId) return fail(409, '같은 요청 ID에 다른 체험 실습실을 쓸 수 없습니다.');
          return { body: view(seen.binding), changed: false };
        }
        if (row && row.requests.length >= 128) return fail(429, '이 실습실의 시험 연결 요청 한도(128)에 도달했습니다.');
        const trialFail = this.#live(trial, trialId);
        if (trialFail) return trialFail;
        if (parentReserve != null) return fail(409, '체험 실습실을 부모로 쓸 수 없습니다.');
        if (trialParent != null) return fail(409, '이미 체험을 가진 실습실을 체험 자리로 쓸 수 없습니다.');
        if (reserve != null && !isReserve(reserve)) return fail(503, '체험 예약을 확인하지 못했습니다.');
        const held = isReserve(reserve) ? reserve : null;
        if (row && row.trialId === trialId) {
          if (held && (held.parentId !== parentId || held.bindingId !== row.bindingId)) return fail(409, '이미 예약된 체험 실습실입니다.');
          const matched = this.#same(parent!, trial!, row);
          if (isFail(matched)) return matched;
          const body = view(row);
          await tx.put(trialBindingKey(parentId), { ...row, requests: [...row.requests, { id: req, trialId, binding: body }] });
          if (!held) await tx.put(trialReserveKey(trialId), { parentId, trialId, bindingId: row.bindingId });
          return { body, changed: false };
        }
        if (row && !this.#gone(prior, row.trialId)) return fail(409, '기존 체험 실습실이 아직 끝나지 않았습니다.');
        if (held) return fail(409, '이미 예약된 체험 실습실입니다.');
        const sandbox = this.#seat(trial!);
        if (isFail(sandbox)) return sandbox;
        if (!parent!.fingerprint || parent!.fingerprint !== trial!.fingerprint) return fail(409, '체험 실습실 구성이 부모와 다릅니다.');
        const binding: TrialBinding = {
          bindingId: req, parentId, trialId, sandboxId: sandbox, sessionId: crypto.randomUUID(),
          configFingerprint: trial!.fingerprint, closed: false, boundAt: this.d.now(),
        };
        await tx.put(trialBindingKey(parentId), { ...binding, requests: [...(row?.requests ?? []), { id: req, trialId, binding }] });
        await tx.put(trialReserveKey(trialId), { parentId, trialId, bindingId: binding.bindingId });
        return { body: binding, changed: true };
      });
      if (isFail(reply)) return reply;
      if (reply.changed) await this.#audit('lab-trial-bind', `${parentId} ${trialId}`);
      return reply.body;
    } catch {
      return fail(503, '체험 연결을 저장하지 못했습니다.');
    }
  }

  async status(token: string, parentId: string) {
    const bad = this.#id(parentId);
    if (bad) return bad;
    try {
      if (!(await this.d.checkAdmin(token))) return fail(401, '관리 세션이 만료됐습니다.');
      const parent = await this.d.lab(parentId);
      const stored = await this.s.get<unknown>(trialBindingKey(parentId));
      const child = isStored(stored) ? await this.d.lab(stored.trialId) : undefined;
      if (!(await this.d.checkAdmin(token))) return fail(401, '관리 세션이 만료됐습니다.');
      const parentFail = this.#live(parent, parentId);
      if (parentFail) return parentFail;
      if (stored == null) return { binding: null };
      if (!isStored(stored)) return fail(503, '체험 연결을 확인하지 못했습니다.');
      const childFail = this.#openChild(child, stored.trialId);
      if (childFail) return childFail;
      const matched = this.#same(parent!, child!, stored);
      if (isFail(matched)) return matched;
      return { binding: { ...view(stored), closed: stored.closed || this.#shut(parentId) } };
    } catch {
      return fail(503, '체험 연결을 확인하지 못했습니다.');
    }
  }

  /** 참가자 입장 가드가 읽는 예약. 부모를 닫아도 정리 전까지 유지하며 권한을 주지 않는다. */
  async reserved(trialId: string) {
    const bad = this.#id(trialId);
    if (bad) return bad;
    try {
      const row = await this.s.get<unknown>(trialReserveKey(trialId));
      if (row == null) return null;
      if (!isReserve(row)) return fail(503, '체험 예약을 확인하지 못했습니다.');
      return { parentId: row.parentId, trialId: row.trialId, bindingId: row.bindingId };
    } catch {
      return fail(503, '체험 예약을 확인하지 못했습니다.');
    }
  }

  async begin(token: string, parentId: string, runId: unknown, command: unknown) {
    const bad = this.#id(parentId) ?? this.#uuid(runId) ?? this.#command(command);
    if (bad) return bad;
    const id = runId as string;
    try {
      const commandHash = await sha256(command as string);
      if (!(await this.d.checkAdmin(token))) return fail(401, '관리 세션이 만료됐습니다.');
      await this.d.lab(parentId);
      if (this.#shut(parentId)) return fail(410, '모임이 끝났습니다.');
      return await this.s.transaction(async (tx) => {
        if (!(await this.d.checkAdmin(token))) return fail(401, '관리 세션이 만료됐습니다.');
        const parent = await this.d.lab(parentId);
        const stored = await tx.get<unknown>(trialBindingKey(parentId));
        const tomb = await tx.get<unknown>(tombKey(parentId));
        const run = await tx.get<unknown>(trialRunKey(parentId, id));
        const child = isStored(stored) ? await this.d.lab(stored.trialId) : undefined;
        const runs = isRun(run) ? null : await tx.list<unknown>({ prefix: runPrefix(parentId), limit: LAB_TRIAL_RUN_LIMIT });
        if (!(await this.d.checkAdmin(token))) return fail(401, '관리 세션이 만료됐습니다.');
        if (this.#shut(parentId) || isTomb(tomb)) return fail(410, '모임이 끝났습니다.');
        const parentFail = this.#live(parent, parentId);
        if (parentFail) return parentFail;
        if (stored == null) return fail(404, '체험 연결이 없습니다.');
        if (!isStored(stored)) return fail(503, '체험 연결을 확인하지 못했습니다.');
        if (stored.closed) return fail(410, '모임이 끝났습니다.');
        const childFail = this.#openChild(child, stored.trialId);
        if (childFail) return childFail;
        const matched = this.#same(parent!, child!, stored);
        if (isFail(matched)) return matched;
        if (run != null && !isRun(run)) return fail(503, '체험 실행을 확인하지 못했습니다.');
        if (isRun(run)) {
          if (run.commandHash !== commandHash || run.bindingId !== stored.bindingId) return fail(409, '같은 요청 ID에 다른 명령을 쓸 수 없습니다.');
          return { claimed: false as const, runId: id, delivery: run.delivery === 'pending' ? 'unknown' as const : run.delivery };
        }
        if ((runs?.size ?? 0) >= LAB_TRIAL_RUN_LIMIT) return fail(429, '이 실습실의 체험 실행 기록 한도(100)에 도달했습니다.');
        const record: TrialRun = {
          runId: id, parentId, bindingId: stored.bindingId, trialId: stored.trialId, sandboxId: stored.sandboxId,
          configFingerprint: stored.configFingerprint, commandHash, delivery: 'pending', claimedAt: this.d.now(),
        };
        await tx.put(trialRunKey(parentId, id), record);
        return { claimed: true as const, runId: id, binding: view(stored) };
      });
    } catch {
      return fail(503, '체험 실행을 저장하지 못했습니다.');
    }
  }

  /** 코디네이터가 전달 결과만 기록한다. 새 기록을 만들거나 닫힌 연결을 덮지 않는다. */
  async finish(parentId: string, runId: string, delivery: unknown) {
    const bad = this.#id(parentId) ?? this.#uuid(runId);
    if (bad) return bad;
    if (delivery !== 'sent' && delivery !== 'unknown' && delivery !== 'error') return fail(400, '전달 상태가 올바르지 않습니다.');
    if (this.#shut(parentId)) return fail(410, '모임이 끝났습니다.');
    try {
      return await this.s.transaction(async (tx) => {
        const stored = await tx.get<unknown>(trialBindingKey(parentId));
        const tomb = await tx.get<unknown>(tombKey(parentId));
        const run = await tx.get<unknown>(trialRunKey(parentId, runId));
        if (this.#shut(parentId) || isTomb(tomb) || (isStored(stored) && stored.closed)) return fail(410, '모임이 끝났습니다.');
        if (run == null) return fail(404, '없는 체험 실행입니다.');
        if (!isRun(run) || !isStored(stored)) return fail(503, '체험 실행을 확인하지 못했습니다.');
        if (run.bindingId !== stored.bindingId) return fail(409, '체험 연결이 바뀌었습니다.');
        if (run.delivery !== 'pending') return fail(409, '이미 기록된 체험 실행입니다.');
        const next: TrialRun = { ...run, delivery };
        await tx.put(trialRunKey(parentId, runId), next);
        return { runId, delivery };
      });
    } catch {
      return fail(503, '체험 실행 기록을 저장하지 못했습니다.');
    }
  }

  async proof(token: string, parentId: string, runId: unknown): Promise<TrialProof | Fail> {
    const bad = this.#id(parentId) ?? this.#uuid(runId);
    if (bad) return bad;
    const id = runId as string;
    try {
      if (!(await this.d.checkAdmin(token))) return fail(401, '관리 세션이 만료됐습니다.');
      const parent = await this.d.lab(parentId);
      const stored = await this.s.get<unknown>(trialBindingKey(parentId));
      const tomb = await this.s.get<unknown>(tombKey(parentId));
      const run = await this.s.get<unknown>(trialRunKey(parentId, id));
      const child = isStored(stored) ? await this.d.lab(stored.trialId) : undefined;
      if (!(await this.d.checkAdmin(token))) return fail(401, '관리 세션이 만료됐습니다.');
      if (this.#shut(parentId) || isTomb(tomb)) return fail(410, '모임이 끝났습니다.');
      const parentFail = this.#live(parent, parentId);
      if (parentFail) return parentFail;
      if (!isStored(stored) || stored.closed) return fail(410, '모임이 끝났습니다.');
      const childFail = this.#openChild(child, stored.trialId);
      if (childFail) return childFail;
      const matched = this.#same(parent!, child!, stored);
      if (isFail(matched)) return matched;
      if (!isRun(run) || run.delivery !== 'sent' || run.bindingId !== stored.bindingId) return fail(409, '전달이 확인된 체험 실행이 아닙니다.');
      if (run.sandboxId !== stored.sandboxId || run.configFingerprint !== stored.configFingerprint) return fail(409, '체험 실습실 구성이 바뀌었습니다.');
      if (this.d.now() - run.claimedAt >= PROOF_MS) return fail(410, '체험 전달 증명이 만료됐습니다.');
      return { commandHash: run.commandHash, configFingerprint: run.configFingerprint, expiresAt: run.claimedAt + PROOF_MS };
    } catch {
      return fail(503, '체험 전달 증명을 확인하지 못했습니다.');
    }
  }

  async close(parentId: string) {
    const bad = this.#id(parentId);
    if (bad) return bad;
    this.#closed.add(parentId);
    try {
      const reply = await this.s.transaction(async (tx) => {
        const stored = await tx.get<unknown>(trialBindingKey(parentId));
        await tx.put(tombKey(parentId), { closed: true });
        if (stored != null && !isStored(stored)) return fail(503, '체험 연결을 저장하지 못했습니다.');
        if (!isStored(stored)) return { trialId: null, changed: false };
        const changed = !stored.closed;
        if (changed) await tx.put(trialBindingKey(parentId), { ...stored, closed: true });
        return { trialId: stored.trialId, changed };
      });
      if (isFail(reply)) return reply;
      if (reply.changed && reply.trialId) await this.#audit('lab-trial-close', `${parentId} ${reply.trialId}`);
      return { trialId: reply.trialId };
    } catch {
      return fail(503, '체험 연결을 저장하지 못했습니다.');
    }
  }

  async #audit(event: string, detail: string) {
    await this.d.audit(event, detail).catch(() => {});
  }
  #shut(parentId: string) { return this.#closed.has(parentId); }
  #live(lab: TrialLab | undefined, id: string): Fail | null {
    if (!lab || lab.id !== id) return fail(404, '없는 실습실입니다.');
    if (lab.endRetry || lab.expiresAt <= this.d.now()) return fail(410, '모임이 끝났습니다.');
    return null;
  }
  #openChild(lab: TrialLab | undefined, id: string): Fail | null {
    if (!lab || lab.id !== id || lab.endRetry || lab.expiresAt <= this.d.now()) return fail(410, '체험 실습실이 끝났습니다.');
    return null;
  }
  #gone(lab: TrialLab | undefined, id: string) {
    return !lab || lab.id !== id || !!lab.endRetry || lab.expiresAt <= this.d.now();
  }
  #same(parent: TrialLab, trial: TrialLab, row: TrialBinding): true | Fail {
    if (parent.fingerprint !== row.configFingerprint || trial.fingerprint !== row.configFingerprint) return fail(409, '체험 실습실 구성이 바뀌었습니다.');
    if (!Array.isArray(trial.seats) || trial.seats.length !== 1 || trial.seats[0]?.sandboxId !== row.sandboxId) return fail(409, '체험 실습실 구성이 바뀌었습니다.');
    return true;
  }
  #seat(trial: TrialLab): string | Fail {
    if (trial.eligible !== true || !Array.isArray(trial.seats) || trial.seats.length !== 1) return fail(409, '체험 실습실로 쓸 수 없습니다.');
    const sandboxId = trial.seats[0]?.sandboxId;
    if (typeof sandboxId !== 'string' || sandboxId.length === 0) return fail(409, '체험 실습실은 준비된 자리 하나여야 합니다.');
    return sandboxId;
  }
  #id(id: unknown): Fail | null {
    return typeof id === 'string' && id.length > 0 && id.length <= 100 ? null : fail(400, '실습실 ID가 올바르지 않습니다.');
  }
  #uuid(id: unknown): Fail | null {
    return typeof id === 'string' && UUID.test(id) ? null : fail(400, '요청 ID가 올바르지 않습니다.');
  }
  #command(command: unknown): Fail | null {
    if (typeof command !== 'string' || !command.trim() || command.length > 4096) return fail(400, '시험 명령이 올바르지 않습니다.');
    for (let i = 0; i < command.length; i++) {
      const code = command.charCodeAt(i);
      if (code <= 31 || code === 127) return fail(400, '체험 명령이 올바르지 않습니다.');
    }
    return null;
  }
}
