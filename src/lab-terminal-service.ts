// 선택한 자리의 전용 tmux 세션에 한 줄 + Enter를 보낸다. 개인 터미널 입력은 수집하지 않는다.
// pending을 먼저 영속화하며, 응답 유실·DO 재시작 뒤에는 같은 명령을 다시 보내지 않는다.
// 마지막 전송 포인터와 작업 시각은 전송 기록에만 남긴다. delivery()는 그 기록을 읽기만 한다.
import type { Fail, Lab } from './state';
import type { LabControlEpoch } from './lab-control-service';
import type { LabPreviewRecord } from './lab-preview-service';

export const TERM_PREFIX = 'labterm:';
export const TERM_SESSION = 'gw-lesson';
export const TERM_MAX_COMMAND = 4096;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const fail = (status: number, error: string): Fail => ({ status, error });
const controlChanged = () => ({ ...fail(409, '명령 전달 상태가 바뀌어 새 요청을 보내지 않았습니다. 상태를 확인한 뒤 다시 선택하세요.'), code: 'control_revision_changed' });
const isFail = (x: unknown): x is Fail => !!x && typeof x === 'object' && 'error' in x && 'status' in x;
const hash = async (s: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))).map((b) => b.toString(16).padStart(2, '0')).join('');
// State.sha()의 관리자 토큰 키와 같은 base64url 표현. 명령 fingerprint(hex)와 섞지 않는다.
const ownerHash = async (s: string) => btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export interface TerminalRef { labId: string; n: number; code: string; sandboxId: string }
type Phase = 'pending' | 'ready' | 'sent' | 'error' | 'unknown' | 'skipped';
interface Row { n: number; status: Phase; note?: string }
export interface TerminalSession { sessionId: string; owner: string; active: boolean; refs: TerminalRef[]; seats: Row[]; count: number; startedAt: number; lastRequestId?: string }
export interface TerminalDeliveryView { n: number; status: 'none' | 'pending' | 'sent' | 'unknown' | 'error' | 'skipped'; at: number | null }
export interface TerminalEffect { kind: 'start' | 'send' | 'capture'; approval?: LabPreviewRecord; operationId?: string; commandHash?: string }
interface Operation { requestId: string; hash: string; results: Row[]; createdAt?: number; updatedAt?: number }
export const terminalCurrentKey = (id: string) => `${TERM_PREFIX}${id}:current`;
export const terminalSessionKey = (id: string, session: string) => `${TERM_PREFIX}${id}:session:${session}`;
export const terminalOperationKey = (id: string, session: string, requestId: string) => `${TERM_PREFIX}${id}:op:${session}:${requestId}`;
interface Deps {
  storage: Pick<DurableObjectStorage, 'get' | 'put' | 'delete' | 'list' | 'transaction'>;
  now(): number;
  checkAdmin(token: string): Promise<boolean>;
  lab(id: string): Promise<Lab | undefined>;
  acquire(id: string): Promise<LabControlEpoch | Fail>;
  admit?(token: string, id: string, sessionId: string): Promise<Fail | null>;
  // State는 매 외부 호출 직전 인증·수업·자리·샌드박스·활성 세션을 다시 검증하고 마지막에 gate를 부른다.
  remote(token: string, ref: TerminalRef, sessionId: string, command: string, gate: () => void, epoch: LabControlEpoch, effect: TerminalEffect): Promise<{ exitCode: number; result: string }>;
  audit(event: string, detail: string): Promise<void>;
}
export class LabTerminalService {
  constructor(private d: Deps) {}
  #busy = new Set<string>();
  #ended = new Set<string>();
  #controls = new Map<string, { stopped: boolean }>();
  #inflight = new Set<string>();
  private get s() { return this.d.storage; }
  async #auth(token: string) { return await this.d.checkAdmin(token) ? null : fail(401, '관리 세션이 만료됐습니다.'); }
  async #lab(id: string) {
    if (typeof id !== 'string' || !id || id.length > 100) return fail(400, '실습실 ID가 올바르지 않습니다.');
    const lab = await this.d.lab(id);
    return !lab ? fail(404, '없는 실습실입니다.') : lab.endRetry || lab.expiresAt <= this.d.now() || this.#ended.has(id) ? fail(410, '모임이 끝났습니다.') : lab;
  }
  #rows(rows: Row[], live = false) { return rows.map((r) => r.status === 'pending' ? { n: r.n, status: live ? 'pending' : 'unknown', note: live ? '처리 중입니다.' : '결과를 확인하지 못했습니다. 자동 재전송하지 않습니다.' } : { ...r }); }
  #view(s: TerminalSession) { return { sessionId: s.sessionId, active: s.active, seats: this.#rows(s.seats, this.#inflight.has(s.sessionId)) }; }
  async #owned(token: string, id: string, sessionId?: unknown, allowOther = false) {
    const a = await this.#auth(token); if (a) return a;
    const lab = await this.#lab(id); if (isFail(lab)) return lab;
    const sid = sessionId ?? await this.s.get<string>(terminalCurrentKey(id));
    if (sid === undefined) return null;
    if (typeof sid !== 'string' || !UUID.test(sid)) return fail(400, '수업 터미널 세션이 올바르지 않습니다.');
    const s = await this.s.get<TerminalSession>(terminalSessionKey(id, sid));
    if (!s) return fail(404, '수업 터미널 세션이 없습니다.');
    if (!allowOther && s.owner !== await ownerHash(token)) return fail(403, '다시 인증한 관리 세션이라면 상태 확인 후 수업 터미널을 이어받으세요.');
    return await this.#auth(token) ?? s;
  }
  async status(token: string, id: string) {
    try { const s = await this.#owned(token, id, undefined, true); return isFail(s) ? s : s ? { ...this.#view(s), needsTakeover: s.owner !== await ownerHash(token) } : { active: false }; }
    catch { return fail(503, '수업 터미널 상태를 확인하지 못했습니다.'); }
  }
  async takeover(token: string, id: string, sessionId: unknown) {
    try {
      if (typeof sessionId !== 'string' || !UUID.test(sessionId)) return fail(400, '이어받을 터미널 세션을 지정하세요.');
      const s = await this.#owned(token, id, sessionId, true); if (!s || isFail(s)) return s ?? fail(404, '터미널이 없습니다.');
      const owner = await ownerHash(token);
      const result = await this.s.transaction(async (tx) => {
        const key = terminalSessionKey(id, s.sessionId), cur = await tx.get<TerminalSession>(key);
        if (!cur || this.#ended.has(id)) return null;
        cur.owner = owner; await tx.put(key, cur); return cur;
      });
      if (!result) return fail(410, '모임이 끝났습니다.');
      await this.d.audit('lab-terminal-takeover', id);
      return await this.#auth(token) ?? { ...this.#view(result), needsTakeover: false };
    } catch { return fail(503, '수업 터미널 이어받기 결과를 확인하지 못했습니다. 상태를 확인하세요.'); }
  }
  async seatState(id: string, n: number) {
    const sid = await this.s.get<string>(terminalCurrentKey(id));
    const s = sid ? await this.s.get<TerminalSession>(terminalSessionKey(id, sid)) : undefined;
    const row = s?.seats.find((r) => r.n === n);
    return { active: !!s?.active, selected: !!row, ready: row?.status === 'ready' };
  }
  #gate(id: string, sessionId: string) {
    return () => { if (this.#ended.has(id) || this.#controls.get(sessionId)?.stopped) throw Error('stopped'); };
  }
  async #patchRow(id: string, sid: string, n: number, row: Row) {
    await this.s.transaction(async (tx) => {
      const key = terminalSessionKey(id, sid), cur = await tx.get<TerminalSession>(key);
      if (!cur || this.#ended.has(id)) return;
      cur.seats = cur.seats.map((x) => x.n === n ? row : x);
      await tx.put(key, cur);
    });
  }
  async #saveOp(id: string, sid: string, key: string, op: Operation) {
    await this.s.transaction(async (tx) => {
      if (!this.#ended.has(id) && await tx.get(terminalSessionKey(id, sid))) {
        op.updatedAt = this.d.now();
        await tx.put(key, op);
      }
    });
  }
  async start(token: string, id: string, requestId: unknown, seats: unknown, expectedRevision?: unknown) {
    const a = await this.#auth(token); if (a) return a;
    if (typeof requestId !== 'string' || !UUID.test(requestId)) return fail(400, '시작 요청 ID가 올바르지 않습니다.');
    if (!Array.isArray(seats) || !seats.length || seats.length > 50 || seats.some((n) => !Number.isInteger(n) || n < 1) || new Set(seats).size !== seats.length) return fail(400, '실행할 자리 번호를 중복 없이 선택하세요 (최대 50자리).');
    if (this.#busy.has(id)) return fail(409, '다른 터미널 요청을 처리 중입니다. 상태를 확인한 뒤 같은 요청으로 다시 확인하세요.');
    this.#busy.add(id);
    try {
      const lab = await this.#lab(id); if (isFail(lab)) return lab;
      const chosen = [...seats].sort((x, y) => x - y) as number[];
      const prior = await this.s.get<TerminalSession>(terminalSessionKey(id, requestId));
      if (prior) {
        const owned = await this.#owned(token, id, requestId); if (!owned || isFail(owned)) return owned ?? fail(404, '세션이 없습니다.');
        if (JSON.stringify(prior.refs.map((r) => r.n)) !== JSON.stringify(chosen)) return fail(409, '같은 시작 요청 ID에 다른 자리를 쓸 수 없습니다.');
        return this.#view(prior);
      }
      const current = await this.s.get<string>(terminalCurrentKey(id));
      const active = current ? await this.s.get<TerminalSession>(terminalSessionKey(id, current)) : null;
      if (active?.active) return fail(409, '이미 수업 터미널을 제어 중입니다. 먼저 현재 전송을 중지하세요.');
      const epoch = await this.d.acquire(id); if (isFail(epoch)) return epoch;
      if (expectedRevision !== undefined && epoch.revision !== expectedRevision) return controlChanged();
      if ((await this.s.list({ prefix: `${TERM_PREFIX}${id}:session:`, limit: 9 })).size >= 8) return fail(429, '이 실습실의 터미널 시작 횟수 한도(8회)에 도달했습니다.');
      const refs: TerminalRef[] = [];
      for (const n of chosen) {
        const seat = lab.seats.find((x) => x.n === n);
        if (!seat?.sandboxId || seat.error || seat.setup?.state === 'running' || seat.setup?.state === 'error') return fail(400, `${n}번 자리가 준비되지 않았습니다. 준비 완료된 자리만 선택하세요.`);
        refs.push({ labId: id, n, code: seat.code, sandboxId: seat.sandboxId });
      }
      const s: TerminalSession = { sessionId: requestId, owner: await ownerHash(token), active: true, refs, seats: refs.map((r) => ({ n: r.n, status: 'pending' })), count: 0, startedAt: this.d.now() };
      if (await this.#auth(token)) return fail(401, '관리 세션이 만료됐습니다.');
      const admission = await this.d.admit?.(token, id, requestId); if (admission) return admission;
      await this.s.put({ [terminalCurrentKey(id)]: requestId, [terminalSessionKey(id, requestId)]: s });
      this.#controls.set(requestId, { stopped: false }); this.#inflight.add(requestId);
      for (const ref of refs) {
        let row: Row;
        try {
          this.#gate(id, requestId)();
          const current = await this.d.acquire(id);
          if (isFail(current) || current.revision !== epoch.revision) {
            await this.#patchRow(id, requestId, ref.n, { n: ref.n, status: 'skipped', note: '명령 전달 상태가 바뀌어 준비를 건너뛰었습니다.' });
            continue;
          }
          const r = await this.d.remote(token, ref, requestId, terminalStartCommand(), this.#gate(id, requestId), epoch, { kind: 'start' });
          row = r.exitCode === 0 && r.result.trim() === 'READY' ? { n: ref.n, status: 'ready' } : { n: ref.n, status: 'error', note: '수업 터미널을 준비하지 못했습니다.' };
        } catch { row = { n: ref.n, status: 'unknown', note: '준비 결과를 확인하지 못했습니다.' }; }
        await this.#patchRow(id, requestId, ref.n, row);
      }
      await this.d.audit('lab-terminal-start', `${id} ${chosen.join(',')}번`);
      const result = await this.#owned(token, id, requestId);
      return isFail(result) ? result : result ? this.#view(result) : fail(410, '모임이 끝났습니다.');
    } catch { return fail(503, '수업 터미널 준비 결과를 확인하지 못했습니다. 같은 요청 ID로 확인하세요.'); }
    finally { this.#busy.delete(id); this.#inflight.delete(requestId); }
  }
  async send(token: string, id: string, sessionId: unknown, requestId: unknown, command: unknown, expectedRevision?: unknown, approval?: LabPreviewRecord) {
    const a = await this.#auth(token); if (a) return a;
    if (typeof sessionId !== 'string' || !UUID.test(sessionId) || typeof requestId !== 'string' || !UUID.test(requestId)) return fail(400, '터미널 요청 ID가 올바르지 않습니다.');
    if (typeof command !== 'string' || !command.trim() || command.length > TERM_MAX_COMMAND || /[\x00-\x1f\x7f]/.test(command)) return fail(400, `명령은 줄바꿈·탭 등 제어문자 없는 한 줄로 1~${TERM_MAX_COMMAND}자까지 입력하세요.`);
    if (this.#busy.has(id)) return fail(409, '다른 터미널 요청을 처리 중입니다. 상태를 확인한 뒤 같은 요청으로 다시 확인하세요.');
    this.#busy.add(id);
    const key = terminalOperationKey(id, sessionId, requestId);
    try {
      const session = await this.#owned(token, id, sessionId); if (!session || isFail(session)) return session ?? fail(404, '터미널이 없습니다.');
      const fingerprint = await hash(command);
      const old = await this.s.get<Operation>(key);
      if (old) return old.hash !== fingerprint ? fail(409, '같은 전송 요청 ID에 다른 명령을 쓸 수 없습니다.') : { requestId, results: this.#rows(old.results, this.#inflight.has(requestId)) };
      if (!session.active || (await this.s.get<string>(terminalCurrentKey(id))) !== sessionId) return fail(409, '명령 전송이 중지된 세션입니다.');
      if (session.count >= 100) return fail(429, '이 세션의 전송 한도(100회)에 도달했습니다.');
      const epoch = await this.d.acquire(id); if (isFail(epoch)) return epoch;
      if (expectedRevision !== undefined && epoch.revision !== expectedRevision) return controlChanged();
      const claimedAt = this.d.now();
      const op: Operation = { requestId, hash: fingerprint, createdAt: claimedAt, updatedAt: claimedAt, results: session.seats.map((r) => r.status === 'ready' ? { n: r.n, status: 'pending' } : { n: r.n, status: 'skipped', note: '준비 완료가 확인되지 않아 보내지 않았습니다.' }) };
      const claimed = await this.s.transaction(async (tx) => {
        const sk = terminalSessionKey(id, sessionId), cur = await tx.get<TerminalSession>(sk);
        if (!cur?.active || cur.owner !== session.owner || this.#ended.has(id)) return false;
        cur.count++;
        cur.lastRequestId = requestId;
        await tx.put({ [key]: op, [sk]: cur });
        return true;
      });
      if (!claimed) return fail(409, '명령 전송이 중지된 세션입니다.');
      this.#inflight.add(requestId);
      this.#controls.set(sessionId, this.#controls.get(sessionId) ?? { stopped: false });
      for (const ref of session.refs) {
        const row = op.results.find((r) => r.n === ref.n)!;
        if (row.status !== 'pending') continue;
        try {
          this.#gate(id, sessionId)();
          const current = await this.d.acquire(id);
          if (isFail(current) || current.revision !== epoch.revision) {
            row.status = 'skipped'; row.note = '명령 전달 상태가 바뀌어 보내지 않았습니다.';
            await this.#saveOp(id, sessionId, key, op);
            continue;
          }
          const r = await this.d.remote(token, ref, sessionId, terminalSendCommand(sessionId, requestId, command), this.#gate(id, sessionId), epoch, { kind: 'send', approval, operationId: requestId, commandHash: fingerprint });
          row.status = r.exitCode === 0 && r.result.trim() === 'SENT' ? 'sent' : r.exitCode === 0 && r.result.trim() === 'DUPLICATE' ? 'unknown' : 'error';
          if (row.status !== 'sent') row.note = row.status === 'unknown' ? '이미 전송을 시도한 명령입니다. 다시 보내지 않았습니다.' : '전송하지 못했습니다. 해당 자리의 수업 터미널을 확인하세요.';
        } catch { row.status = 'unknown'; row.note = '전송 결과를 확인하지 못했습니다. 자동 재전송하지 않습니다.'; }
        await this.#saveOp(id, sessionId, key, op);
      }
      await this.d.audit('lab-terminal-send', `${id} ${session.refs.length}자리 ${command.length}자`);
      return await this.#auth(token) ?? { requestId, results: op.results };
    } catch { return fail(503, '전송 결과를 확인하지 못했습니다. 같은 요청 ID로 확인하세요.'); }
    finally { this.#busy.delete(id); this.#inflight.delete(requestId); }
  }
  async stop(token: string, id: string, sessionId: unknown) {
    try {
      if (typeof sessionId !== 'string' || !UUID.test(sessionId)) return fail(400, '중지할 터미널 세션을 지정하세요.');
      const s = await this.#owned(token, id, sessionId); if (!s || isFail(s)) return s ?? fail(404, '터미널이 없습니다.');
      this.#controls.set(s.sessionId, { stopped: true });
      await this.s.transaction(async (tx) => { const key = terminalSessionKey(id, s.sessionId), cur = await tx.get<TerminalSession>(key); if (cur) { cur.active = false; await tx.put(key, cur); } });
      await this.d.audit('lab-terminal-stop', id);
      return { ok: true };
    } catch { return fail(503, '전송 중지 결과를 확인하지 못했습니다. 상태를 확인하세요.'); }
  }
  // 현재 세션과 마지막 작업만 정확한 키로 읽는다. at는 자리별 완료 시각이 아니라 작업 상태 기록 시각이다.
  async delivery(id: string): Promise<TerminalDeliveryView[]> {
    try {
      if (typeof id !== 'string' || !id || id.length > 100) return [];
      const sid = await this.s.get<string>(terminalCurrentKey(id));
      if (typeof sid !== 'string' || !UUID.test(sid)) return [];
      const session = await this.s.get<TerminalSession>(terminalSessionKey(id, sid));
      if (!session || session.sessionId !== sid || !Array.isArray(session.seats)) return [];
      const seats = session.seats;
      const current = async (rows: TerminalDeliveryView[]): Promise<TerminalDeliveryView[]> => {
        const [lab, pointer] = await Promise.all([this.d.lab(id), this.s.get<string>(terminalCurrentKey(id))]);
        return rows.map(row => {
          const ref = session.refs?.find(r => r.n === row.n), seat = lab?.seats.find(s => s.n === row.n);
          return pointer === sid && lab && !lab.endRetry && lab.expiresAt > this.d.now() && ref?.labId === id && ref.code === seat?.code && ref.sandboxId === seat?.sandboxId
            ? row : {n: row.n, status: 'unknown', at: null};
        });
      };
      const unknown = (): TerminalDeliveryView[] => seats.map((r) => ({ n: r.n, status: 'unknown', at: null }));
      if (session.count === 0) return await current(seats.map((r) => ({ n: r.n, status: 'none', at: null })));
      const last = session.lastRequestId;
      if (typeof last !== 'string' || !UUID.test(last)) return unknown();
      const op = await this.s.get<Operation>(terminalOperationKey(id, sid, last));
      if (!op || typeof op !== 'object' || op.requestId !== last || !Array.isArray(op.results)) return unknown();
      const at = typeof op.updatedAt === 'number' && Number.isFinite(op.updatedAt) && op.updatedAt >= 0 && op.updatedAt <= this.d.now() ? op.updatedAt : null;
      if (at === null) return unknown();
      const live = this.#inflight.has(last);
      return await current(seats.map((seat) => {
        const row = op.results.find((r) => r?.n === seat.n);
        const phase = row?.status;
        if (phase !== 'pending' && phase !== 'sent' && phase !== 'unknown' && phase !== 'error' && phase !== 'skipped') return { n: seat.n, status: 'unknown', at: null };
        if (phase === 'pending') return { n: seat.n, status: live ? 'pending' : 'unknown', at };
        return { n: seat.n, status: phase, at };
      }));
    } catch { return []; }
  }
  async clear(id: string) {
    this.#ended.add(id); // 첫 await 전에 모든 진행 중 요청의 마지막 문을 닫는다.
    for (const [key] of await this.s.list({ prefix: `${TERM_PREFIX}${id}:` })) await this.s.delete(key);
  }
}

// 외부 명령 전체를 base64로 운반한다. 쉘 quoting 대신 Node execFileSync 인자를 써서 텍스트를 그대로 보낸다.
const nodeCommand = (script: string) => `node -e 'eval(Buffer.from("${btoa(String.fromCharCode(...new TextEncoder().encode(script)))}","base64").toString("utf8"))'`;
export function terminalStartCommand(work = '/home/daytona/work') {
  return nodeCommand(`const {execFileSync:e}=require('node:child_process'); try { e('tmux',['has-session','-t','=${TERM_SESSION}'],{stdio:'ignore'}); } catch { e('tmux',['-u','new-session','-d','-s','${TERM_SESSION}','-c',${JSON.stringify(work)},'bash','-l'],{stdio:'ignore'}); } process.stdout.write('READY');`);
}
export function terminalSendCommand(sessionId: string, requestId: string, command: string) {
  if (!UUID.test(sessionId) || !UUID.test(requestId)) throw Error('bad terminal request');
  return nodeCommand(`const f=require('node:fs'),p=require('node:path'),{execFileSync:e}=require('node:child_process'); const root=p.join(require('node:os').homedir(),'.gw-lesson'); f.mkdirSync(root,{recursive:true,mode:448}); try { f.mkdirSync(p.join(root,${JSON.stringify(sessionId + '-' + requestId)}),{mode:448}); } catch(x) { if(x.code==='EEXIST'){process.stdout.write('DUPLICATE'); process.exit(0);} throw x; } e('tmux',['send-keys','-t','=${TERM_SESSION}:0.0','-l','--',${JSON.stringify(command)}],{stdio:'ignore'}); e('tmux',['send-keys','-t','=${TERM_SESSION}:0.0','Enter'],{stdio:'ignore'}); process.stdout.write('SENT');`);
}
