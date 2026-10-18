// 실습실 보조 권한: 범위가 고정된 부여, 질문/답변, 승인된 문구 전달, 전체 일시정지.
// AI·터미널·파일·종료·교체·재개는 없다. State/API 연결은 이 파일 밖에 둔다.
// 토큰 원문은 발급 응답에만 있고, 저장소에는 SHA-256 hex 만 둔다.
import type { Fail, Lab, Seat } from './state';
import { LAB_CONTROL_ACTION_LIMIT, controlKey, controlView, type LabControlRow, type LabControlView } from './lab-control-service';

export const ASSISTANT_SCOPES = ['status:read', 'help:read', 'help:reply', 'template:send', 'control:pause'] as const;
export type AssistantScope = (typeof ASSISTANT_SCOPES)[number];

export interface AssistantTemplate { id: string; title: string; text: string }
export interface AssistantGrant {
  id: string; labId: string; label: string; seats: number[]; scopes: string[];
  createdAt: number; expiresAt: number; revokedAt: number | null; templates: AssistantTemplate[];
}
export interface AssistantQuestion {
  id: string; n: number; question: string; at: number;
  status: 'open' | 'answered' | 'resolved'; reply: string | null; repliedAt: number | null; replyBy: string | null;
}
export interface AssistantMessage { id: string; n: number; at: number; title: string; text: string }
export interface AssistantIdentity { labId: string; n: number; seatCode: string }

interface Deps {
  storage: Pick<DurableObjectStorage, 'get' | 'put' | 'list' | 'delete' | 'transaction'>;
  now(): number;
  checkAdmin(token: string): Promise<boolean>;
}
interface Op { requestId: string; hash: string; result: unknown }
interface StoredGrant extends AssistantGrant { tokenHash: string; operations: Op[] }
interface Thread extends AssistantQuestion { seatHash: string; askRequestId: string; resolveRequestId?: string }
interface StoredMessage extends AssistantMessage { seatHash: string }
interface AuditItem { at: number; grantId: string; action: 'issue' | 'revoke' | 'reply' | 'template' | 'pause'; n?: number; requestId?: string }
type Tx = Pick<DurableObjectStorage, 'get' | 'put' | 'list' | 'delete'>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOKEN = /^la_[A-Za-z0-9_-]{43}$/;
const MAX_GRANTS = 16;
const MAX_THREADS = 100;
const MAX_OPEN = 5;
const MAX_OPS = 128;
const MAX_MESSAGES = 200;
const MAX_AUDIT = 200;
/** SQLite DO 키+값 한도는 2MiB. UTF-8 직렬화 레코드는 1.5MiB에서 거절해 여유를 둔다. */
const MAX_RECORD_BYTES = 1_572_864;
const fail = (status: number, error: string): Fail => ({ status, error });
const isFail = (x: unknown): x is Fail => !!x && typeof x === 'object' && 'status' in x && 'error' in x;

const tokenKey = (hex: string) => `labassist-token:${hex}`;
const grantKey = (id: string) => `labassist:${id}`;
const helpKey = (id: string) => `labhelp:${id}`;
const msgKey = (id: string) => `labassist-msg:${id}`;
const auditKey = (id: string) => `labassist-audit:${id}`;
const stopKey = (id: string) => `labassist-stop:${id}`;

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}
function overRecordBudget(records: readonly { key: string; value: unknown }[]): Fail | null {
  for (const rec of records) {
    const json = JSON.stringify(rec.value);
    if (json == null || utf8Bytes(rec.key) + utf8Bytes(json) > MAX_RECORD_BYTES) return fail(429, '저장 용량 한도를 초과했습니다.');
  }
  return null;
}
function expiredGrant(grant: StoredGrant, now: number): Fail | null {
  if (grant.revokedAt != null) return fail(401, '권한이 취소됐습니다.');
  if (grant.expiresAt <= now) return fail(401, '권한이 만료됐습니다.');
  return null;
}
function labClosed(lab: Lab, now: number): Fail | null {
  if (lab.endRetry || lab.expiresAt <= now) return fail(410, '모임이 끝났습니다.');
  return null;
}

export class LabAssistantService {
  constructor(private d: Deps) {}
  private get s() { return this.d.storage; }

  async issue(admin: string, input: unknown): Promise<{ grant: AssistantGrant; token: string } | Fail> {
    const parsed = parseIssue(input);
    if (isFail(parsed)) return parsed;
    const raw = b64url(crypto.getRandomValues(new Uint8Array(32)));
    if (raw.length !== 43) return fail(503, '권한을 만들지 못했습니다.');
    const token = `la_${raw}`;
    const tokenHash = await sha256(token);
    if (!/^[0-9a-f]{64}$/.test(tokenHash)) return fail(503, '권한을 만들지 못했습니다.');
    const grantId = `ag_${crypto.randomUUID()}`;
    const templates = parsed.templates.map((t) => ({ id: `tp_${crypto.randomUUID()}`, title: t.title, text: t.text }));
    try {
      return await this.s.transaction(async (tx) => {
        const lab = await this.#adminLab(tx, admin, parsed.labId);
        if (isFail(lab)) return lab;
        const seats = seatsOn(lab, parsed.seats);
        if (isFail(seats)) return seats;
        const at = this.d.now();
        const ended = await this.#ended(tx, parsed.labId, lab, at);
        if (ended) return ended;
        const count = await this.#grantCount(tx, parsed.labId);
        if (isFail(count)) return count;
        if (count >= MAX_GRANTS) return fail(429, '이 실습실의 권한 한도(16)에 도달했습니다.');
        const grant: StoredGrant = {
          id: grantId, labId: parsed.labId, label: parsed.label, seats: parsed.seats, scopes: parsed.scopes,
          createdAt: at, expiresAt: Math.min(at + parsed.minutes * 60_000, lab.expiresAt), revokedAt: null,
          templates, tokenHash, operations: [],
        };
        const logged = await this.#audit(tx, parsed.labId, { at, grantId, action: 'issue' });
        if (isFail(logged)) return logged;
        if (typeof admin !== 'string' || !(await this.d.checkAdmin(admin))) return fail(401, '관리 세션이 만료됐습니다.');
        const closed = labClosed(lab, this.d.now());
        if (closed) return closed;
        const tooBig = overRecordBudget([
          { key: grantKey(grantId), value: grant },
          { key: tokenKey(tokenHash), value: grantId },
          { key: auditKey(parsed.labId), value: logged },
        ]);
        if (tooBig) return tooBig;
        await tx.put(grantKey(grantId), grant);
        await tx.put(tokenKey(tokenHash), grantId);
        await tx.put(auditKey(parsed.labId), logged);
        return { grant: pub(grant), token };
      });
    } catch {
      return fail(503, '권한을 저장하지 못했습니다.');
    }
  }

  async list(admin: string, id: string): Promise<{ grants: AssistantGrant[] } | Fail> {
    const bad = labIdOf(id);
    if (bad) return bad;
    try {
      return await this.s.transaction(async (tx) => {
        const lab = await this.#adminLab(tx, admin, id);
        if (isFail(lab)) return lab;
        const grants = await this.#grants(tx, id);
        if (isFail(grants)) return grants;
        return { grants: grants.map(pub).sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1)) };
      });
    } catch {
      return fail(503, '권한 목록을 확인하지 못했습니다.');
    }
  }

  async revoke(admin: string, id: string, grantId: unknown): Promise<{ ok: true; grant: AssistantGrant } | Fail> {
    const bad = labIdOf(id) ?? idOf(grantId, 'ag_', '권한 ID가 올바르지 않습니다.');
    if (bad) return bad;
    try {
      return await this.s.transaction(async (tx) => {
        const lab = await this.#adminLab(tx, admin, id);
        if (isFail(lab)) return lab;
        const grant = await tx.get<StoredGrant>(grantKey(grantId as string));
        if (!grant || grant.id !== grantId) return fail(404, '없는 권한입니다.');
        if (grant.labId !== id) return fail(403, '이 실습실의 권한이 아닙니다.');
        if (grant.revokedAt != null) return { ok: true as const, grant: pub(grant) };
        const at = this.d.now();
        const ended = await this.#ended(tx, id, lab, at);
        if (ended) return ended;
        const next: StoredGrant = { ...grant, revokedAt: at };
        const logged = await this.#audit(tx, id, { at, grantId: grant.id, action: 'revoke' });
        if (isFail(logged)) return logged;
        if (typeof admin !== 'string' || !(await this.d.checkAdmin(admin))) return fail(401, '관리 세션이 만료됐습니다.');
        const closed = labClosed(lab, this.d.now());
        if (closed) return closed;
        const tooBig = overRecordBudget([
          { key: grantKey(grant.id), value: next },
          { key: auditKey(id), value: logged },
        ]);
        if (tooBig) return tooBig;
        await tx.put(grantKey(grant.id), next);
        await tx.put(auditKey(id), logged);
        return { ok: true as const, grant: pub(next) };
      });
    } catch {
      return fail(503, '권한을 취소하지 못했습니다.');
    }
  }

  async audit(admin: string, id: string): Promise<{ items: AuditItem[] } | Fail> {
    const bad = labIdOf(id);
    if (bad) return bad;
    try {
      return await this.s.transaction(async (tx) => {
        const lab = await this.#adminLab(tx, admin, id);
        if (isFail(lab)) return lab;
        const items = await readArr<AuditItem>(tx, auditKey(id));
        if (isFail(items)) return items;
        return { items: items.map(pubAudit) };
      });
    } catch {
      return fail(503, '권한 기록을 확인하지 못했습니다.');
    }
  }

  async authorize(token: string, id: string, scope: string): Promise<{ grant: AssistantGrant } | Fail> {
    const bad = tokenOf(token) ?? labIdOf(id) ?? (scopeOf(scope) ? null : fail(400, '모르는 권한 범위입니다.'));
    if (bad) return bad;
    const tokenHash = await sha256(token);
    try {
      return await this.s.transaction(async (tx) => {
        const auth = await this.#touch(tx, tokenHash, id, scope as AssistantScope);
        if (isFail(auth)) return auth;
        const again = await this.#touch(tx, tokenHash, id, scope as AssistantScope);
        if (isFail(again)) return again;
        const expired = expiredGrant(again.grant, this.d.now());
        if (expired) return expired;
        return { grant: pub(again.grant) };
      });
    } catch {
      return fail(503, '권한을 확인하지 못했습니다.');
    }
  }

  async ask(identity: unknown, input: unknown): Promise<{ question: AssistantQuestion } | Fail> {
    const who = parseIdentity(identity);
    if (isFail(who)) return who;
    const parsed = parseAsk(input);
    if (isFail(parsed)) return parsed;
    const seatHash = await sha256(who.seatCode);
    const threadId = `hq_${crypto.randomUUID()}`;
    try {
      return await this.s.transaction(async (tx) => {
        const seat = await this.#seat(tx, who, seatHash);
        if (isFail(seat)) return seat;
        const threads = await readArr<Thread>(tx, helpKey(who.labId));
        if (isFail(threads)) return threads;
        const prior = threads.find((t) => t.askRequestId === parsed.requestId);
        if (prior) {
          const closed = labClosed(seat.lab, this.d.now());
          if (closed) return closed;
          if (prior.n === who.n && prior.seatHash === seatHash && prior.question === parsed.question) return { question: pubThread(prior) };
          return fail(409, '같은 요청 ID에 다른 동작을 쓸 수 없습니다.');
        }
        if (threads.length >= MAX_THREADS) return fail(429, '이 실습실의 질문 한도(100)에 도달했습니다.');
        const open = threads.filter((t) => t.status === 'open' && t.n === who.n && t.seatHash === seatHash).length;
        if (open >= MAX_OPEN) return fail(429, '이 자리에서 동시에 열 수 있는 질문은 5개입니다.');
        const again = await this.#seat(tx, who, seatHash);
        if (isFail(again)) return again;
        const at = this.d.now();
        const ended = await this.#ended(tx, who.labId, again.lab, at);
        if (ended) return ended;
        const thread: Thread = {
          id: threadId, n: who.n, question: parsed.question, at, status: 'open',
          reply: null, repliedAt: null, replyBy: null, seatHash, askRequestId: parsed.requestId,
        };
        const nextThreads = [...threads, thread];
        const closed = labClosed(again.lab, this.d.now());
        if (closed) return closed;
        const tooBig = overRecordBudget([{ key: helpKey(who.labId), value: nextThreads }]);
        if (tooBig) return tooBig;
        await tx.put(helpKey(who.labId), nextThreads);
        return { question: pubThread(thread) };
      });
    } catch {
      return fail(503, '질문을 저장하지 못했습니다.');
    }
  }

  async participant(identity: unknown): Promise<{ now: number; enabled: boolean; questions: AssistantQuestion[]; messages: AssistantMessage[] } | Fail> {
    const who = parseIdentity(identity);
    if (isFail(who)) return who;
    const seatHash = await sha256(who.seatCode);
    try {
      return await this.s.transaction(async (tx) => {
        const seat = await this.#seat(tx, who, seatHash);
        if (isFail(seat)) return seat;
        const again = await this.#seat(tx, who, seatHash);
        if (isFail(again)) return again;
        const at = this.d.now();
        const ended = await this.#ended(tx, who.labId, again.lab, at);
        if (ended) return ended;
        const grants = await this.#grants(tx, who.labId);
        if (isFail(grants)) return grants;
        const threads = await readArr<Thread>(tx, helpKey(who.labId));
        if (isFail(threads)) return threads;
        const messages = await readArr<StoredMessage>(tx, msgKey(who.labId));
        if (isFail(messages)) return messages;
        const now = this.d.now();
        const closed = labClosed(again.lab, now);
        if (closed) return closed;
        const enabled = grants.some((g) => g.revokedAt == null && g.expiresAt > now && g.seats.includes(who.n) && g.scopes.includes('help:read'));
        return {
          now, enabled,
          questions: threads.filter((t) => t.n === who.n && t.seatHash === seatHash).map(pubThread),
          messages: messages.filter((m) => m.n === who.n && m.seatHash === seatHash).map(pubMessage),
        };
      });
    } catch {
      return fail(503, '자리 도움을 확인하지 못했습니다.');
    }
  }

  async questions(token: string, id: string): Promise<{ now: number; questions: AssistantQuestion[]; messages: AssistantMessage[] } | Fail> {
    const bad = tokenOf(token) ?? labIdOf(id);
    if (bad) return bad;
    const tokenHash = await sha256(token);
    try {
      return await this.s.transaction(async (tx) => {
        const auth = await this.#touch(tx, tokenHash, id, 'help:read');
        if (isFail(auth)) return auth;
        const again = await this.#touch(tx, tokenHash, id, 'help:read');
        if (isFail(again)) return again;
        const at = this.d.now();
        const ended = await this.#ended(tx, id, again.lab, at);
        if (ended) return ended;
        const own = await this.#currentHashes(again.lab, again.grant.seats);
        const threads = await readArr<Thread>(tx, helpKey(id));
        if (isFail(threads)) return threads;
        const messages = await readArr<StoredMessage>(tx, msgKey(id));
        if (isFail(messages)) return messages;
        const now = this.d.now();
        const expired = expiredGrant(again.grant, now);
        if (expired) return expired;
        const closed = labClosed(again.lab, now);
        if (closed) return closed;
        const visible = (n: number, hash: string) => own.get(n) === hash;
        return {
          now,
          questions: threads.filter((t) => visible(t.n, t.seatHash)).map(pubThread),
          messages: messages.filter((m) => visible(m.n, m.seatHash)).map(pubMessage),
        };
      });
    } catch {
      return fail(503, '질문을 확인하지 못했습니다.');
    }
  }

  async reply(token: string, id: string, input: unknown): Promise<{ question: AssistantQuestion } | Fail> {
    const bad = tokenOf(token) ?? labIdOf(id);
    if (bad) return bad;
    const parsed = parseReply(input);
    if (isFail(parsed)) return parsed;
    const tokenHash = await sha256(token);
    const hash = await sha256(JSON.stringify({ kind: 'reply', questionId: parsed.questionId, text: parsed.text }));
    try {
      return await this.s.transaction(async (tx) => {
        const auth = await this.#touch(tx, tokenHash, id, 'help:reply');
        if (isFail(auth)) return auth;
        const replay = replayOf(auth.grant, parsed.requestId, hash);
        if (isFail(replay)) return replay;
        if (replay.hit) {
          const stale = expiredGrant(auth.grant, this.d.now());
          if (stale) return stale;
          return asQuestion(replay.result);
        }
        const threads = await readArr<Thread>(tx, helpKey(id));
        if (isFail(threads)) return threads;
        const idx = threads.findIndex((t) => t.id === parsed.questionId);
        const thread = idx >= 0 ? threads[idx] : undefined;
        if (!thread) return fail(404, '없는 질문입니다.');
        if (!auth.grant.seats.includes(thread.n)) return fail(403, '이 자리는 허용되지 않았습니다.');
        const seat = auth.lab.seats.find((s) => s.n === thread.n && !s.error);
        if (!seat || await sha256(seat.code) !== thread.seatHash) return fail(409, '이 자리의 현재 질문이 아닙니다.');
        if (thread.status !== 'open') return fail(409, '이미 답한 질문입니다.');
        const again = await this.#touch(tx, tokenHash, id, 'help:reply');
        if (isFail(again)) return again;
        if (again.grant.operations.length >= MAX_OPS) return fail(429, '이 권한의 동작 기록 한도(128)에 도달했습니다.');
        const liveSeat = again.lab.seats.find((s) => s.n === thread.n && !s.error);
        if (!liveSeat || !again.grant.seats.includes(thread.n)) return fail(409, '이 자리의 현재 질문이 아닙니다.');
        const liveHash = await sha256(liveSeat.code);
        if (liveHash !== thread.seatHash) return fail(409, '이 자리의 현재 질문이 아닙니다.');
        const at = this.d.now();
        const ended = await this.#ended(tx, id, again.lab, at);
        if (ended) return ended;
        const next: Thread = { ...thread, status: 'answered', reply: parsed.text, repliedAt: at, replyBy: again.grant.id };
        const result = { question: pubThread(next) };
        const logged = await this.#audit(tx, id, { at, grantId: again.grant.id, action: 'reply', n: thread.n, requestId: parsed.requestId });
        if (isFail(logged)) return logged;
        const nextThreads = threads.slice();
        nextThreads[idx] = next;
        const nextGrant: StoredGrant = { ...again.grant, operations: [...again.grant.operations, { requestId: parsed.requestId, hash, result }] };
        const expired = expiredGrant(again.grant, this.d.now());
        if (expired) return expired;
        const closed = labClosed(again.lab, this.d.now());
        if (closed) return closed;
        const tooBig = overRecordBudget([
          { key: helpKey(id), value: nextThreads },
          { key: grantKey(again.grant.id), value: nextGrant },
          { key: auditKey(id), value: logged },
        ]);
        if (tooBig) return tooBig;
        await tx.put(helpKey(id), nextThreads);
        await tx.put(grantKey(again.grant.id), nextGrant);
        await tx.put(auditKey(id), logged);
        return result;
      });
    } catch {
      return fail(503, '답변을 저장하지 못했습니다.');
    }
  }

  async resolve(identity: unknown, input: unknown): Promise<{ question: AssistantQuestion } | Fail> {
    const who = parseIdentity(identity);
    if (isFail(who)) return who;
    const parsed = parseResolve(input);
    if (isFail(parsed)) return parsed;
    const seatHash = await sha256(who.seatCode);
    try {
      return await this.s.transaction(async (tx) => {
        const seat = await this.#seat(tx, who, seatHash);
        if (isFail(seat)) return seat;
        const threads = await readArr<Thread>(tx, helpKey(who.labId));
        if (isFail(threads)) return threads;
        const byReq = threads.find((t) => t.resolveRequestId === parsed.requestId);
        if (byReq) {
          const closed = labClosed(seat.lab, this.d.now());
          if (closed) return closed;
          if (byReq.id === parsed.questionId && byReq.n === who.n && byReq.seatHash === seatHash && byReq.status === 'resolved') return { question: pubThread(byReq) };
          return fail(409, '같은 요청 ID에 다른 동작을 쓸 수 없습니다.');
        }
        const idx = threads.findIndex((t) => t.id === parsed.questionId && t.n === who.n && t.seatHash === seatHash);
        if (idx < 0) return fail(404, '없는 질문입니다.');
        const thread = threads[idx];
        if (thread.status !== 'answered') return fail(409, '답변이 끝난 질문만 닫을 수 있습니다.');
        const again = await this.#seat(tx, who, seatHash);
        if (isFail(again)) return again;
        const at = this.d.now();
        const ended = await this.#ended(tx, who.labId, again.lab, at);
        if (ended) return ended;
        const next: Thread = { ...thread, status: 'resolved', resolveRequestId: parsed.requestId };
        const nextThreads = threads.slice();
        nextThreads[idx] = next;
        const closed = labClosed(again.lab, this.d.now());
        if (closed) return closed;
        const tooBig = overRecordBudget([{ key: helpKey(who.labId), value: nextThreads }]);
        if (tooBig) return tooBig;
        await tx.put(helpKey(who.labId), nextThreads);
        return { question: pubThread(next) };
      });
    } catch {
      return fail(503, '질문을 닫지 못했습니다.');
    }
  }

  async sendTemplate(token: string, id: string, input: unknown): Promise<{ message: AssistantMessage } | Fail> {
    const bad = tokenOf(token) ?? labIdOf(id);
    if (bad) return bad;
    const parsed = parseTemplateSend(input);
    if (isFail(parsed)) return parsed;
    const tokenHash = await sha256(token);
    const hash = await sha256(JSON.stringify({ kind: 'template', templateId: parsed.templateId, n: parsed.n }));
    const messageId = `tm_${crypto.randomUUID()}`;
    try {
      return await this.s.transaction(async (tx) => {
        const auth = await this.#touch(tx, tokenHash, id, 'template:send');
        if (isFail(auth)) return auth;
        const replay = replayOf(auth.grant, parsed.requestId, hash);
        if (isFail(replay)) return replay;
        if (replay.hit) {
          const stale = expiredGrant(auth.grant, this.d.now());
          if (stale) return stale;
          return asMessage(replay.result);
        }
        const template = auth.grant.templates.find((t) => t.id === parsed.templateId);
        if (!template) return fail(404, '없는 문구입니다.');
        const messages = await readArr<StoredMessage>(tx, msgKey(id));
        if (isFail(messages)) return messages;
        if (messages.length >= MAX_MESSAGES) return fail(429, '이 실습실의 문구 전달 한도(200)에 도달했습니다.');
        const again = await this.#touch(tx, tokenHash, id, 'template:send');
        if (isFail(again)) return again;
        if (!again.grant.seats.includes(parsed.n)) return fail(403, '이 자리는 허용되지 않았습니다.');
        const live = again.lab.seats.find((s) => s.n === parsed.n && !s.error);
        if (!live) return fail(403, '이 자리는 허용되지 않았습니다.');
        const kept = again.grant.templates.find((t) => t.id === template.id && t.title === template.title && t.text === template.text);
        if (!kept) return fail(404, '없는 문구입니다.');
        if (again.grant.operations.length >= MAX_OPS) return fail(429, '이 권한의 동작 기록 한도(128)에 도달했습니다.');
        const at = this.d.now();
        const ended = await this.#ended(tx, id, again.lab, at);
        if (ended) return ended;
        const seatHash = await sha256(live.code);
        const stored: StoredMessage = { id: messageId, n: parsed.n, at, title: kept.title, text: kept.text, seatHash };
        const result = { message: pubMessage(stored) };
        const logged = await this.#audit(tx, id, { at, grantId: again.grant.id, action: 'template', n: parsed.n, requestId: parsed.requestId });
        if (isFail(logged)) return logged;
        const nextMessages = [...messages, stored];
        const nextGrant: StoredGrant = { ...again.grant, operations: [...again.grant.operations, { requestId: parsed.requestId, hash, result }] };
        const expired = expiredGrant(again.grant, this.d.now());
        if (expired) return expired;
        const closed = labClosed(again.lab, this.d.now());
        if (closed) return closed;
        const tooBig = overRecordBudget([
          { key: msgKey(id), value: nextMessages },
          { key: grantKey(again.grant.id), value: nextGrant },
          { key: auditKey(id), value: logged },
        ]);
        if (tooBig) return tooBig;
        await tx.put(msgKey(id), nextMessages);
        await tx.put(grantKey(again.grant.id), nextGrant);
        await tx.put(auditKey(id), logged);
        return result;
      });
    } catch {
      return fail(503, '문구를 전달하지 못했습니다.');
    }
  }

  async pause(token: string, id: string, input: unknown): Promise<{ control: LabControlView } | Fail> {
    const bad = tokenOf(token) ?? labIdOf(id);
    if (bad) return bad;
    const parsed = parsePause(input);
    if (isFail(parsed)) return parsed;
    const tokenHash = await sha256(token);
    const hash = await sha256(JSON.stringify({ kind: 'pause', reason: parsed.reason }));
    try {
      return await this.s.transaction(async (tx) => {
        const auth = await this.#touch(tx, tokenHash, id, 'control:pause');
        if (isFail(auth)) return auth;
        const replay = replayOf(auth.grant, parsed.requestId, hash);
        if (isFail(replay)) return replay;
        if (replay.hit) {
          const stale = expiredGrant(auth.grant, this.d.now());
          if (stale) return stale;
          return asControl(replay.result);
        }
        const cur = await tx.get<unknown>(controlKey(id));
        if (cur != null && !isControlRow(cur)) return fail(503, '명령 전달 상태를 확인하지 못했습니다.');
        if (isControlRow(cur) && cur.mode === 'ended') return fail(410, '모임이 끝났습니다.');
        if ((isControlRow(cur) ? cur.actions.length : 0) >= LAB_CONTROL_ACTION_LIMIT) return fail(429, '이 실습실의 제어 동작 기록 한도(128)에 도달했습니다.');
        const again = await this.#touch(tx, tokenHash, id, 'control:pause');
        if (isFail(again)) return again;
        const covered = coversAll(again.lab, again.grant.seats);
        if (isFail(covered)) return covered;
        if (again.grant.operations.length >= MAX_OPS) return fail(429, '이 권한의 동작 기록 한도(128)에 도달했습니다.');
        const at = this.d.now();
        const ended = await this.#ended(tx, id, again.lab, at);
        if (ended) return ended;
        const fresh = await tx.get<unknown>(controlKey(id));
        if (JSON.stringify(fresh) !== JSON.stringify(cur)) return fail(409, '명령 전달 상태가 바뀌었습니다. 다시 확인하세요.');
        const current = controlView(fresh ?? null);
        const control: LabControlView = { mode: 'paused', revision: current.revision + 1, updatedAt: at };
        const row: LabControlRow = {
          mode: control.mode, revision: control.revision, updatedAt: at,
          actions: [...(isControlRow(fresh) ? fresh.actions : []), { id: `assistant:${again.grant.id}:${parsed.requestId}`, kind: 'pause', expectedRevision: null, response: control }],
        };
        const result = { control };
        const logged = await this.#audit(tx, id, { at, grantId: again.grant.id, action: 'pause', requestId: parsed.requestId });
        if (isFail(logged)) return logged;
        const nextGrant: StoredGrant = { ...again.grant, operations: [...again.grant.operations, { requestId: parsed.requestId, hash, result }] };
        const expired = expiredGrant(again.grant, this.d.now());
        if (expired) return expired;
        const closed = labClosed(again.lab, this.d.now());
        if (closed) return closed;
        const tooBig = overRecordBudget([
          { key: controlKey(id), value: row },
          { key: grantKey(again.grant.id), value: nextGrant },
          { key: auditKey(id), value: logged },
        ]);
        if (tooBig) return tooBig;
        await tx.put(controlKey(id), row);
        await tx.put(grantKey(again.grant.id), nextGrant);
        await tx.put(auditKey(id), logged);
        return result;
      });
    } catch {
      return fail(503, '일시정지를 저장하지 못했습니다.');
    }
  }

  async #adminLab(tx: Tx, admin: string, id: string): Promise<Lab | Fail> {
    if (typeof admin !== 'string' || !(await this.d.checkAdmin(admin))) return fail(401, '관리 세션이 만료됐습니다.');
    const first = await this.#readLive(tx, id);
    if (isFail(first)) return first;
    if (!(await this.d.checkAdmin(admin))) return fail(401, '관리 세션이 만료됐습니다.');
    return this.#readLive(tx, id);
  }

  /** 수업 종료 tombstone·만료·종료 재시도는 권한 확인과 참가자 확인마다 거절한다. */
  async #readLive(tx: Tx, id: string): Promise<Lab | Fail> {
    if (await tx.get(stopKey(id)) !== undefined) return fail(410, '모임이 끝났습니다.');
    const lab = await tx.get<Lab>('lab:' + id);
    if (!lab || typeof lab !== 'object' || lab.id !== id) return fail(404, '없는 실습실입니다.');
    if (!Array.isArray(lab.seats) || typeof lab.expiresAt !== 'number') return fail(503, '실습실 상태를 확인하지 못했습니다.');
    if (lab.endRetry || lab.expiresAt <= this.d.now()) return fail(410, '모임이 끝났습니다.');
    return lab;
  }

  async #ended(tx: Tx, id: string, lab: Lab, at: number): Promise<Fail | null> {
    if (await tx.get(stopKey(id)) !== undefined) return fail(410, '모임이 끝났습니다.');
    if (lab.endRetry || lab.expiresAt <= at) return fail(410, '모임이 끝났습니다.');
    return null;
  }

  async #touch(tx: Tx, tokenHash: string, id: string, scope: AssistantScope): Promise<{ grant: StoredGrant; lab: Lab } | Fail> {
    const grantId = await tx.get<string>(tokenKey(tokenHash));
    if (typeof grantId !== 'string') return fail(401, '권한이 없습니다.');
    const grant = await tx.get<StoredGrant>(grantKey(grantId));
    if (!grant || grant.id !== grantId || grant.tokenHash !== tokenHash || !Array.isArray(grant.operations)) return fail(401, '권한이 없습니다.');
    if (grant.labId !== id) return fail(403, '이 실습실의 권한이 아닙니다.');
    if (grant.revokedAt != null) return fail(401, '권한이 취소됐습니다.');
    if (grant.expiresAt <= this.d.now()) return fail(401, '권한이 만료됐습니다.');
    if (!grant.scopes.includes(scope)) return fail(403, '이 동작은 허용되지 않았습니다.');
    const lab = await this.#readLive(tx, id);
    if (isFail(lab)) return lab;
    const expired = expiredGrant(grant, this.d.now());
    if (expired) return expired;
    return { grant, lab };
  }

  async #seat(tx: Tx, who: AssistantIdentity, seatHash: string): Promise<{ lab: Lab; seat: Seat } | Fail> {
    const lab = await this.#readLive(tx, who.labId);
    if (isFail(lab)) return lab;
    const seat = lab.seats.find((s) => s.n === who.n && s.code === who.seatCode && !s.error);
    if (!seat || await sha256(seat.code) !== seatHash) return fail(403, '이 자리의 권한이 없습니다.');
    return { lab, seat };
  }

  async #currentHashes(lab: Lab, seats: number[]): Promise<Map<number, string>> {
    const out = new Map<number, string>();
    for (const seat of lab.seats) {
      if (!seats.includes(seat.n) || seat.error || typeof seat.code !== 'string') continue;
      out.set(seat.n, await sha256(seat.code));
    }
    return out;
  }

  async #grants(tx: Tx, labId: string): Promise<StoredGrant[] | Fail> {
    const all = await tx.list<StoredGrant>({ prefix: 'labassist:' });
    const grants: StoredGrant[] = [];
    for (const [key, grant] of all) {
      if (!grant || typeof grant !== 'object' || grant.labId !== labId) continue;
      if (key !== grantKey(grant.id)) continue;
      grants.push(grant);
    }
    return grants;
  }

  async #grantCount(tx: Tx, labId: string): Promise<number | Fail> {
    const grants = await this.#grants(tx, labId);
    return isFail(grants) ? grants : grants.length;
  }

  async #audit(tx: Tx, labId: string, item: AuditItem): Promise<AuditItem[] | Fail> {
    const prev = await readArr<AuditItem>(tx, auditKey(labId));
    if (isFail(prev)) return prev;
    return [...prev, pubAudit(item)].slice(-MAX_AUDIT);
  }
}

function pub(g: StoredGrant): AssistantGrant {
  return {
    id: g.id, labId: g.labId, label: g.label, seats: [...g.seats], scopes: [...g.scopes],
    createdAt: g.createdAt, expiresAt: g.expiresAt, revokedAt: g.revokedAt,
    templates: g.templates.map((t) => ({ id: t.id, title: t.title, text: t.text })),
  };
}
function pubThread(t: Thread): AssistantQuestion {
  return { id: t.id, n: t.n, question: t.question, at: t.at, status: t.status, reply: t.reply, repliedAt: t.repliedAt, replyBy: t.replyBy };
}
function pubMessage(m: StoredMessage): AssistantMessage {
  return { id: m.id, n: m.n, at: m.at, title: m.title, text: m.text };
}
function pubAudit(item: AuditItem): AuditItem {
  const out: AuditItem = { at: item.at, grantId: item.grantId, action: item.action };
  if (item.n != null) out.n = item.n;
  if (item.requestId != null) out.requestId = item.requestId;
  return out;
}
function replayOf(grant: StoredGrant, requestId: string, hash: string): Fail | { hit: false } | { hit: true; result: unknown } {
  const op = grant.operations.find((o) => o.requestId === requestId);
  if (!op) return { hit: false };
  if (op.hash !== hash) return fail(409, '같은 요청 ID에 다른 동작을 쓸 수 없습니다.');
  if (leaks(op.result)) return fail(503, '저장된 기록을 확인하지 못했습니다.');
  return { hit: true, result: op.result };
}
function leaks(x: unknown): boolean {
  if (!x || typeof x !== 'object') return false;
  for (const [k, v] of Object.entries(x as Record<string, unknown>)) {
    if (k === 'token' || k === 'tokenHash' || k === 'seatHash' || k === 'seatCode' || k === 'operations' || k === 'askRequestId' || k === 'resolveRequestId') return true;
    if (leaks(v)) return true;
  }
  return false;
}
function asQuestion(x: unknown): { question: AssistantQuestion } | Fail {
  const q = x && typeof x === 'object' ? (x as { question?: AssistantQuestion }).question : undefined;
  return q && typeof q.id === 'string' ? { question: q } : fail(503, '저장된 기록을 확인하지 못했습니다.');
}
function asMessage(x: unknown): { message: AssistantMessage } | Fail {
  const m = x && typeof x === 'object' ? (x as { message?: AssistantMessage }).message : undefined;
  return m && typeof m.id === 'string' ? { message: m } : fail(503, '저장된 기록을 확인하지 못했습니다.');
}
function asControl(x: unknown): { control: LabControlView } | Fail {
  const c = x && typeof x === 'object' ? (x as { control?: LabControlView }).control : undefined;
  return c && c.mode === 'paused' && Number.isSafeInteger(c.revision) ? { control: c } : fail(503, '저장된 기록을 확인하지 못했습니다.');
}
function coversAll(lab: Lab, seats: number[]): true | Fail {
  const live = lab.seats.filter((s) => s && !s.error);
  if (live.length === 0) return fail(403, '일시정지할 정상 자리가 없습니다.');
  return live.every((s) => seats.includes(s.n)) ? true : fail(403, '전체 자리를 포함하는 권한만 일시정지할 수 있습니다.');
}
function seatsOn(lab: Lab, seats: number[]): true | Fail {
  for (const n of seats) {
    const seat = lab.seats.find((s) => s.n === n);
    if (!seat) return fail(400, '없는 자리입니다.');
    if (seat.error) return fail(400, '오류 자리에는 권한을 줄 수 없습니다.');
  }
  return true;
}
function isControlRow(x: unknown): x is LabControlRow {
  if (!x || typeof x !== 'object') return false;
  const row = x as LabControlRow;
  return (row.mode === 'running' || row.mode === 'paused' || row.mode === 'ended')
    && Number.isSafeInteger(row.revision) && row.revision >= 0
    && typeof row.updatedAt === 'number' && Number.isFinite(row.updatedAt)
    && Array.isArray(row.actions);
}
async function readArr<T>(tx: Tx, key: string): Promise<T[] | Fail> {
  const value = await tx.get<unknown>(key);
  if (value == null) return [];
  return Array.isArray(value) ? value as T[] : fail(503, '저장된 기록을 확인하지 못했습니다.');
}
function exact(x: unknown, keys: readonly string[]): x is Record<string, unknown> {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return false;
  const got = Object.keys(x);
  return got.length === keys.length && keys.every((k) => got.includes(k));
}
function text(v: unknown, min: number, max: number): string | null {
  return typeof v === 'string' && v.length >= min && v.length <= max ? v : null;
}
function labIdOf(id: unknown): Fail | null {
  return typeof id === 'string' && id.length > 0 && id.length <= 100 ? null : fail(400, '실습실 ID가 올바르지 않습니다.');
}
function tokenOf(token: unknown): Fail | null {
  return typeof token === 'string' && TOKEN.test(token) ? null : fail(401, '권한이 없습니다.');
}
function uuidOf(id: unknown): id is string {
  return typeof id === 'string' && UUID.test(id);
}
function idOf(id: unknown, prefix: string, error: string): Fail | null {
  return typeof id === 'string' && id.startsWith(prefix) && uuidOf(id.slice(prefix.length)) ? null : fail(400, error);
}
function scopeOf(scope: string): scope is AssistantScope {
  return (ASSISTANT_SCOPES as readonly string[]).includes(scope);
}
function seatNo(v: unknown): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 1 && v <= 20;
}
function parseIssue(input: unknown): { labId: string; label: string; seats: number[]; scopes: AssistantScope[]; minutes: number; templates: { title: string; text: string }[] } | Fail {
  if (!exact(input, ['id', 'label', 'seats', 'scopes', 'minutes', 'templates'])) return fail(400, '권한 입력이 올바르지 않습니다.');
  const lab = labIdOf(input.id);
  const label = text(input.label, 1, 60);
  if (lab || !label) return lab ?? fail(400, '권한 이름이 올바르지 않습니다.');
  if (!Array.isArray(input.seats) || input.seats.length < 1 || input.seats.length > 20 || !input.seats.every(seatNo) || new Set(input.seats).size !== input.seats.length) return fail(400, '자리가 올바르지 않습니다.');
  if (!Array.isArray(input.scopes) || input.scopes.some((s) => typeof s !== 'string' || !scopeOf(s)) || new Set(input.scopes).size !== input.scopes.length) return fail(400, '권한 범위가 올바르지 않습니다.');
  const scopes = input.scopes as AssistantScope[];
  if (!scopes.includes('status:read')) return fail(400, 'status:read 범위가 필요합니다.');
  if (scopes.includes('help:reply') && !scopes.includes('help:read')) return fail(400, 'help:reply 는 help:read 가 필요합니다.');
  if (typeof input.minutes !== 'number' || !Number.isSafeInteger(input.minutes) || input.minutes < 5 || input.minutes > 120) return fail(400, '유효 시간은 5~120분 정수입니다.');
  if (!Array.isArray(input.templates) || input.templates.length > 8) return fail(400, '문구는 8개까지입니다.');
  if (scopes.includes('template:send') && input.templates.length === 0) return fail(400, '문구 전달에는 문구가 필요합니다.');
  let chars = 0;
  const templates: { title: string; text: string }[] = [];
  for (const item of input.templates) {
    if (!exact(item, ['title', 'text'])) return fail(400, '문구 형식이 올바르지 않습니다.');
    const title = text(item.title, 1, 80);
    const body = text(item.text, 1, 8000);
    if (!title || !body) return fail(400, '문구 길이가 올바르지 않습니다.');
    chars += title.length + body.length;
    templates.push({ title, text: body });
  }
  if (chars > 24000) return fail(400, '문구 전체 길이가 한도를 넘었습니다.');
  return { labId: input.id as string, label, seats: input.seats as number[], scopes, minutes: input.minutes, templates };
}
function parseIdentity(input: unknown): AssistantIdentity | Fail {
  if (!exact(input, ['labId', 'n', 'seatCode'])) return fail(400, '자리 신원이 올바르지 않습니다.');
  const bad = labIdOf(input.labId);
  const code = text(input.seatCode, 1, 128);
  if (bad || !seatNo(input.n) || !code) return bad ?? fail(400, '자리 신원이 올바르지 않습니다.');
  return { labId: input.labId as string, n: input.n, seatCode: code };
}
function parseAsk(input: unknown): { requestId: string; question: string } | Fail {
  if (!exact(input, ['requestId', 'question'])) return fail(400, '질문 입력이 올바르지 않습니다.');
  const question = text(input.question, 1, 2000);
  if (!uuidOf(input.requestId) || !question) return fail(400, '질문 입력이 올바르지 않습니다.');
  return { requestId: input.requestId, question };
}
function parseReply(input: unknown): { requestId: string; questionId: string; text: string } | Fail {
  if (!exact(input, ['requestId', 'questionId', 'text'])) return fail(400, '답변 입력이 올바르지 않습니다.');
  const body = text(input.text, 1, 2000);
  if (!uuidOf(input.requestId) || idOf(input.questionId, 'hq_', '질문 ID가 올바르지 않습니다.') || !body) return fail(400, '답변 입력이 올바르지 않습니다.');
  return { requestId: input.requestId, questionId: input.questionId as string, text: body };
}
function parseResolve(input: unknown): { requestId: string; questionId: string } | Fail {
  if (!exact(input, ['requestId', 'questionId'])) return fail(400, '질문 닫기 입력이 올바르지 않습니다.');
  if (!uuidOf(input.requestId) || idOf(input.questionId, 'hq_', '질문 ID가 올바르지 않습니다.')) return fail(400, '질문 닫기 입력이 올바르지 않습니다.');
  return { requestId: input.requestId, questionId: input.questionId as string };
}
function parseTemplateSend(input: unknown): { requestId: string; templateId: string; n: number } | Fail {
  if (!exact(input, ['requestId', 'templateId', 'n'])) return fail(400, '문구 전달 입력이 올바르지 않습니다.');
  if (!uuidOf(input.requestId) || idOf(input.templateId, 'tp_', '문구 ID가 올바르지 않습니다.') || !seatNo(input.n)) return fail(400, '문구 전달 입력이 올바르지 않습니다.');
  return { requestId: input.requestId, templateId: input.templateId as string, n: input.n };
}
function parsePause(input: unknown): { requestId: string; reason: string } | Fail {
  if (!exact(input, ['requestId', 'reason'])) return fail(400, '일시정지 입력이 올바르지 않습니다.');
  const reason = text(input.reason, 1, 300);
  if (!uuidOf(input.requestId) || !reason) return fail(400, '일시정지 입력이 올바르지 않습니다.');
  return { requestId: input.requestId, reason };
}
async function sha256(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  let hex = '';
  for (const b of digest) hex += b.toString(16).padStart(2, '0');
  return hex;
}
function b64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
