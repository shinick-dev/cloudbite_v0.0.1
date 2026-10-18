// 방송 전에 명령 미리보기를 영속한다. 명령 원문·출력·파일·토큰은 저장하지 않는다.
// 미리보기는 실행 완료나 정답을 뜻하지 않는다. tested 는 시험 전달 증명이 맞다는 뜻뿐이다.
// 전달 일시정지·재개는 LabControlService 가 따로 본다. 이 서비스는 그 검사를 건너뛰지 않는다.
import type { Fail } from './state';

export const LAB_PREVIEW_LIMIT = 256;
export const LAB_PREVIEW_TTL_MS = 5 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const fail = (status: number, error: string): Fail => ({ status, error });
const isFail = (x: unknown): x is Fail => !!x && typeof x === 'object' && 'error' in x && 'status' in x;

export interface PreviewContext {
  owner: string;
  sessionId: string;
  targets: number[];
  targetFingerprint: string;
  configFingerprint: string;
}
export interface TrialProof {
  commandHash: string;
  configFingerprint: string;
  expiresAt: number;
}
export interface PreviewView {
  previewId: string;
  targets: number[];
  expiresAt: number;
  tested: boolean;
}
export interface PreviewConsumeView extends PreviewView {
  operationId: string;
}
export interface LabPreviewRecord {
  previewId: string;
  commandHash: string;
  owner: string;
  sessionId: string;
  targets: number[];
  targetFingerprint: string;
  configFingerprint: string;
  tested: boolean;
  trialRunId: string | null;
  createdAt: number;
  expiresAt: number;
  consumedBy: string | null;
}
interface Deps {
  storage: Pick<DurableObjectStorage, 'get' | 'put' | 'list' | 'transaction'>;
  now(): number;
  audit(event: string, detail: string): Promise<void>;
  context(token: string, id: string): Promise<PreviewContext | Fail>;
  trial(token: string, id: string, runId: string): Promise<TrialProof | Fail>;
}
type Tx = Pick<DurableObjectStorage, 'get' | 'put' | 'list'>;
type Mode = { kind: 'trial'; trialRunId: string } | { kind: 'waiver' };
type Identity = Pick<LabPreviewRecord, 'commandHash' | 'owner' | 'sessionId' | 'targets' | 'targetFingerprint' | 'configFingerprint' | 'tested' | 'trialRunId'>;
interface Decision<T> { body: T; changed: boolean }

/** State·터미널 서비스가 미리보기 한 건을 찾는 키. 값은 LabPreviewRecord 다. */
export const previewKey = (id: string, previewId: string) => `labpv:${id}:${previewId}`;
/** 실습실 한도의 list 는 이 접두사와 limit 256 만 쓴다. */
export const previewPrefix = (id: string) => `labpv:${id}:`;

/** 명령 UTF-8 바이트의 SHA-256 hex. 원문 대신 이 값만 저장한다. */
export async function shaCommand(command: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(command));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const sameTargets = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((n, i) => n === b[i]);
const sameContext = (a: PreviewContext, b: PreviewContext) => a.owner === b.owner && a.sessionId === b.sessionId && sameTargets(a.targets, b.targets) && a.targetFingerprint === b.targetFingerprint && a.configFingerprint === b.configFingerprint;
const viewOf = (row: LabPreviewRecord): PreviewView => ({ previewId: row.previewId, targets: [...row.targets], expiresAt: row.expiresAt, tested: row.tested });
const identityOf = (mode: Mode, commandHash: string, ctx: PreviewContext): Identity => ({
  commandHash,
  owner: ctx.owner,
  sessionId: ctx.sessionId,
  targets: ctx.targets,
  targetFingerprint: ctx.targetFingerprint,
  configFingerprint: ctx.configFingerprint,
  tested: mode.kind === 'trial',
  trialRunId: mode.kind === 'trial' ? mode.trialRunId : null,
});
const samePayload = (row: LabPreviewRecord, next: Identity) => row.commandHash === next.commandHash && row.owner === next.owner && row.sessionId === next.sessionId && sameTargets(row.targets, next.targets) && row.targetFingerprint === next.targetFingerprint && row.configFingerprint === next.configFingerprint && row.tested === next.tested && row.trialRunId === next.trialRunId;

function isContext(x: unknown): x is PreviewContext {
  if (!x || typeof x !== 'object' || isFail(x)) return false;
  const c = x as PreviewContext;
  return typeof c.owner === 'string' && c.owner.length > 0 && c.owner.length <= 512
    && typeof c.sessionId === 'string' && c.sessionId.length > 0 && c.sessionId.length <= 200
    && Array.isArray(c.targets) && c.targets.length <= LAB_PREVIEW_LIMIT && c.targets.every((n) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0)
    && typeof c.targetFingerprint === 'string' && c.targetFingerprint.length > 0 && c.targetFingerprint.length <= 512
    && typeof c.configFingerprint === 'string' && c.configFingerprint.length > 0 && c.configFingerprint.length <= 512;
}
function isRecord(x: unknown): x is LabPreviewRecord {
  if (!x || typeof x !== 'object') return false;
  const r = x as LabPreviewRecord;
  return typeof r.previewId === 'string' && UUID.test(r.previewId)
    && typeof r.commandHash === 'string' && /^[0-9a-f]{64}$/.test(r.commandHash)
    && typeof r.owner === 'string' && r.owner.length > 0 && r.owner.length <= 512
    && typeof r.sessionId === 'string' && r.sessionId.length > 0 && r.sessionId.length <= 200
    && Array.isArray(r.targets) && r.targets.length <= LAB_PREVIEW_LIMIT && r.targets.every((n) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0)
    && typeof r.targetFingerprint === 'string' && r.targetFingerprint.length > 0
    && typeof r.configFingerprint === 'string' && r.configFingerprint.length > 0
    && typeof r.tested === 'boolean'
    && (r.trialRunId === null || (typeof r.trialRunId === 'string' && r.trialRunId.length > 0))
    && typeof r.createdAt === 'number' && Number.isFinite(r.createdAt)
    && typeof r.expiresAt === 'number' && Number.isFinite(r.expiresAt)
    && (r.consumedBy === null || (typeof r.consumedBy === 'string' && UUID.test(r.consumedBy)));
}

export class LabPreviewService {
  constructor(private d: Deps) {}
  private get s() { return this.d.storage; }

  async prepare(token: string, id: string, requestId: unknown, command: unknown, options: unknown): Promise<PreviewView | Fail> {
    const bad = this.#labId(id) ?? this.#uuid(requestId, '미리보기 요청 ID가 올바르지 않습니다.') ?? this.#command(command);
    if (bad) return bad;
    const mode = this.#options(options, token);
    if (isFail(mode)) return mode;
    try {
      const reply = await this.s.transaction((tx) => this.#prepare(tx, token, id, requestId as string, command as string, mode));
      if (isFail(reply)) return reply;
      if (reply.changed) await this.#audit('lab-preview-prepare', `${id} ${requestId} ${reply.body.tested ? 'tested' : 'ack'}`);
      return reply.body;
    } catch {
      return fail(503, '명령 미리보기를 저장하지 못했습니다.');
    }
  }

  async consume(token: string, id: string, previewId: unknown, operationId: unknown, command: unknown): Promise<PreviewConsumeView | Fail> {
    const bad = this.#labId(id) ?? this.#uuid(previewId, '미리보기 ID가 올바르지 않습니다.') ?? this.#uuid(operationId, '작업 ID가 올바르지 않습니다.') ?? this.#command(command);
    if (bad) return bad;
    try {
      const reply = await this.s.transaction((tx) => this.#consume(tx, token, id, previewId as string, operationId as string, command as string));
      if (isFail(reply)) return reply;
      if (reply.changed) await this.#audit('lab-preview-consume', `${id} ${previewId} ${operationId}`);
      return reply.body;
    } catch {
      return fail(503, '명령 미리보기를 확인하지 못했습니다.');
    }
  }

  async #prepare(tx: Tx, token: string, id: string, previewId: string, command: string, mode: Mode): Promise<Decision<PreviewView> | Fail> {
    const ctx = await this.#context(token, id);
    if (isFail(ctx)) return ctx;
    const commandHash = await shaCommand(command);
    const key = previewKey(id, previewId);
    const cur = await tx.get<unknown>(key);
    const again = await this.#context(token, id);
    if (isFail(again)) return again;
    if (!sameContext(ctx, again)) return fail(409, '미리보기 대상이 바뀌었습니다. 다시 확인하세요.');
    if (cur != null && !isRecord(cur)) return fail(503, '명령 미리보기를 확인하지 못했습니다.');
    const requested = identityOf(mode, commandHash, again);
    if (isRecord(cur)) {
      if (cur.previewId !== previewId || !samePayload(cur, requested)) return fail(409, '같은 미리보기 ID에 다른 내용을 쓸 수 없습니다.');
      return { body: viewOf(cur), changed: false };
    }
    const proven = await this.#prove(token, id, commandHash, again, mode);
    if (isFail(proven)) return proven;
    const listed = await tx.list<unknown>({ prefix: previewPrefix(id), limit: LAB_PREVIEW_LIMIT });
    const ready = await this.#context(token, id);
    if (isFail(ready)) return ready;
    if (!sameContext(proven, ready)) return fail(409, '미리보기 대상이 바뀌었습니다. 다시 확인하세요.');
    if (listed.size >= LAB_PREVIEW_LIMIT) return fail(429, '이 실습실의 명령 미리보기 한도(256)에 도달했습니다.');
    const now = this.d.now();
    const row: LabPreviewRecord = {
      ...identityOf(mode, commandHash, ready),
      targets: [...ready.targets],
      previewId,
      createdAt: now,
      expiresAt: now + LAB_PREVIEW_TTL_MS,
      consumedBy: null,
    };
    if (this.#leaks(row, token)) return fail(503, '명령 미리보기를 저장하지 못했습니다.');
    await tx.put(key, row);
    return { body: viewOf(row), changed: true };
  }

  async #consume(tx: Tx, token: string, id: string, previewId: string, operationId: string, command: string): Promise<Decision<PreviewConsumeView> | Fail> {
    const ctx = await this.#context(token, id);
    if (isFail(ctx)) return ctx;
    const cur = await tx.get<unknown>(previewKey(id, previewId));
    const commandHash = await shaCommand(command);
    const again = await this.#context(token, id);
    if (isFail(again)) return again;
    if (!sameContext(ctx, again)) return fail(409, '미리보기 대상이 바뀌었습니다. 다시 확인하세요.');
    if (cur == null) return fail(404, '명령 미리보기가 없습니다.');
    if (!isRecord(cur) || cur.previewId !== previewId) return fail(503, '명령 미리보기를 확인하지 못했습니다.');
    if (cur.expiresAt <= this.d.now()) return fail(410, '명령 미리보기가 만료됐습니다.');
    if (cur.commandHash !== commandHash) return fail(409, '미리보기와 명령이 다릅니다.');
    if (!sameContext(again, { owner: cur.owner, sessionId: cur.sessionId, targets: cur.targets, targetFingerprint: cur.targetFingerprint, configFingerprint: cur.configFingerprint })) return fail(409, '미리보기 대상이 현재 선택과 다릅니다.');
    if (cur.consumedBy && cur.consumedBy !== operationId) return fail(409, '이 미리보기는 다른 작업에 이미 사용됐습니다.');
    if (cur.consumedBy === operationId) return { body: { ...viewOf(cur), operationId }, changed: false };
    const next: LabPreviewRecord = { ...cur, targets: [...cur.targets], consumedBy: operationId };
    await tx.put(previewKey(id, previewId), next);
    return { body: { ...viewOf(next), operationId }, changed: true };
  }

  /** 새 행에만 시험 증명을 요구한다. 같은 페이로드 재시도는 저장된 만료 시각을 유지한다. */
  async #prove(token: string, id: string, commandHash: string, ctx: PreviewContext, mode: Mode): Promise<PreviewContext | Fail> {
    if (mode.kind === 'waiver') {
      const fresh = await this.#context(token, id);
      if (isFail(fresh)) return fresh;
      if (!sameContext(ctx, fresh)) return fail(409, '미리보기 대상이 바뀌었습니다. 다시 확인하세요.');
      return fresh;
    }
    const proof = await this.d.trial(token, id, mode.trialRunId);
    const fresh = await this.#context(token, id);
    if (isFail(fresh)) return fresh;
    if (!sameContext(ctx, fresh)) return fail(409, '미리보기 대상이 바뀌었습니다. 다시 확인하세요.');
    if (isFail(proof)) return proof;
    if (!proof || typeof proof !== 'object') return fail(503, '시험 실행 증명을 확인하지 못했습니다.');
    const p = proof as Partial<TrialProof>;
    if (typeof p.commandHash !== 'string' || typeof p.configFingerprint !== 'string' || typeof p.expiresAt !== 'number' || !Number.isFinite(p.expiresAt)) return fail(503, '시험 실행 증명을 확인하지 못했습니다.');
    if (p.expiresAt <= this.d.now()) return fail(410, '시험 실행 증명이 만료됐습니다.');
    if (p.commandHash !== commandHash) return fail(409, '시험 실행이 이 명령과 맞지 않습니다.');
    if (p.configFingerprint !== fresh.configFingerprint) return fail(409, '시험 실행이 현재 실습 설정과 맞지 않습니다.');
    return fresh;
  }

  async #context(token: string, id: string): Promise<PreviewContext | Fail> {
    const ctx = await this.d.context(token, id);
    if (isFail(ctx)) return ctx;
    if (!isContext(ctx) || ctx.owner === token) return fail(503, '미리보기 대상을 확인하지 못했습니다.');
    return { owner: ctx.owner, sessionId: ctx.sessionId, targets: [...ctx.targets], targetFingerprint: ctx.targetFingerprint, configFingerprint: ctx.configFingerprint };
  }

  #leaks(row: LabPreviewRecord, token: string) {
    return token.length > 0 && JSON.stringify(row).includes(token);
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
  #command(command: unknown): Fail | null {
    return typeof command === 'string' && command.trim().length >= 1 && command.length <= 4096 && !/[\x00-\x1f\x7f]/.test(command) ? null : fail(400, '명령은 줄바꿈·탭 등 제어문자 없는 한 줄로 1~4096자까지 입력하세요.');
  }
  #options(options: unknown, token: string): Mode | Fail {
    if (!options || typeof options !== 'object' || Array.isArray(options)) return fail(400, '미리보기 옵션이 올바르지 않습니다.');
    const o = options as { trialRunId?: unknown; ackWithoutTrial?: unknown };
    if (Object.keys(o).some((k) => k !== 'trialRunId' && k !== 'ackWithoutTrial')) return fail(400, '미리보기 옵션이 올바르지 않습니다.');
    const hasTrial = o.trialRunId !== undefined;
    const hasAck = o.ackWithoutTrial !== undefined;
    if (hasTrial && hasAck) return fail(400, '시험 실행과 시험 생략을 함께 지정할 수 없습니다.');
    if (hasTrial) {
      if (typeof o.trialRunId !== 'string' || o.trialRunId.length < 1 || o.trialRunId.length > 200 || /[\x00-\x1f\x7f]/.test(o.trialRunId) || o.trialRunId === token || o.trialRunId.includes(token)) return fail(400, '시험 실행 ID가 올바르지 않습니다.');
      return { kind: 'trial', trialRunId: o.trialRunId };
    }
    if (o.ackWithoutTrial !== true) return fail(400, '시험 실행 증명이 없으면 시험 생략을 명시해야 합니다.');
    return { kind: 'waiver' };
  }
}
