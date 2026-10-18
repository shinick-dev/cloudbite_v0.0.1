// 자리 미리 준비(깨우기 → 수업 자료 → 편집기 확인) — State(DO) 안에서만 쓰는 서비스. Worker 에서 내보내지 않는다 (RPC 로 안 열린다).
// 자리·수업이 아직 유효한지(seatmap·lab·sandbox·만료·끝내는 중·멈춤)와 setup 저장은 State 가 넘긴 active·patchSetup 이 정한다.
// 이 서비스는 who·opened·preview·쿠키·입장 감사 기록을 쓰지 않는다. 자기 일 기록(labprep:<code>)과 멈춤 표시(labprepstop:<labId>)만 쓴다.
// 규칙: 이 서비스의 저장(일 기록·멈춤·setup 패치)은 전부 #tx 한 줄로 차례대로 한다 (바깥 호출은 그 줄 밖). 줄 안에서 멈춤·일 번호를 보고 쓴다.
//       바깥 호출(Daytona·자료) 직전에는 await 없이 메모리(멈춤·바뀜)를 보고, 호출을 기다린 뒤에는 매번 "멈춤 없음 + 내 일 번호 그대로 + 자리 유효" 를 다시 본다.
//       자료 넣기는 일 기록과 setup 'running' 을 먼저 남기고 시작한다. 끝났는지 모르는 자료 넣기(다시 뜸·끝 시각)는 다시 하지 않고
//       '알 수 없음'(PREP_UNCERTAIN) 으로 닫는다 — ready·재시도 없음, 강사가 실습실을 새로 만들어야 풀린다.
//       blockConcurrencyWhile 은 쓰지 않는다. 한 DO 에서 동시에 도는 일은 PREP_LIMIT(처음엔 1) 개, 무거운 자료 넣기는 1 개 —
//       끝 시각이 지나 기다림을 그만둔 호출도 실제로 끝날 때까지 자리를 잡고 있는다 (시간으로 놓아 주지 않는다).
//       자리가 비면 그 일이 끝나며 kick 한다. 자리가 찬 동안의 알람은 PREP_BUSY_WAIT 간격으로만 (1초마다 깨우지 않는다).
// 한계: 동시 개수·자료 넣기 1개는 지금 살아 있는 이 DO 인스턴스 안에서만 지킨다 (전역 보장 아님). 서버가 다시 뜨면 앞 인스턴스가
//       시작한 바깥 자료 넣기가 아직 도는지 증명할 수 없다 — 그 자리(같은 샌드박스)는 '알 수 없음' 으로 막고, 다른 자리 준비는 이어 간다.
//       앞 호출을 끊거나 전역으로 정리하지 않는다.
import type { Materials, Sandbox } from './lab';
import { labErrorText, labStateError, labWakeDetail, labWakeStep } from './lab-setup';
import { PREP_TIMING_KEEP, prepTimingAdd, prepTimingExpired, prepTimingNew, prepTimingResume, prepTimingView, type PrepMeasurements, type PrepTiming } from './lab-preparation-timing';

/** State 가 seatmap 에서 꺼내 준 자리 (믿을 수 있는 값만) */
export interface PrepRef { labId: string; n: number; code: string; sandboxId: string }
export type PrepSetup = { state: 'running' | 'ok' | 'error'; at: number; note: string }; // Seat['setup'] 과 같은 모양
/** active() 가 돌려주는 지금 자리 모습 (자격 증명 없음). materials 는 State 가 확인한 자료 주소 (없으면 null) */
export interface PrepSnapshot { materials: Materials | null; setup?: PrepSetup; opened?: number }

/** uncertain: 자료 넣기가 끝났는지 알 수 없음 — 끝난 단계지만 알람이 지우지 않고, 같은 샌드박스로는 새 일을 만들지 않는다 */
export type PrepPhase = 'queued' | 'wake' | 'install' | 'probe' | 'editor' | 'ready' | 'failed' | 'uncertain';
/** labprep:<code> 에 남는 일 기록 */
export interface PrepJob {
  ref: PrepRef; op: string; phase: PrepPhase;
  created: number; deadline: number; due: number;
  started?: number;     // 처음 돈 시각 — 끝 시각은 여기서부터 (줄에서 기다린 시간은 세지 않는다)
  tries: number;        // 확인(샌드박스·편집기) 실패·기다림 횟수 — PREP_PROBES 까지
  wokeAt?: number;      // 마지막 켜기 요청
  editorAt?: number;    // 마지막 편집기 켜기 요청 (요청 전에 적는다)
  editors: number;      // 편집기 켜기 요청 횟수
  note?: string; endedAt?: number;
  timing?: PrepMeasurements; // 새 일의 숫자 관측만 (예전 일·중간에 죽은 호출은 빠짐)
}
export interface PrepStop { at: number }

export type PrepResult =
  | { status: 'ready'; setup?: PrepSetup; prepTiming?: PrepTiming }
  | { status: 'starting'; detail: string; prepTiming?: PrepTiming }
  | { status: 'error'; message: string; final: boolean }
  | { status: 'gone' };

export const PREP_JOB = 'labprep:';
export const PREP_STOP = 'labprepstop:';
export const prepJobKey = (code: string) => PREP_JOB + code;
export const prepStopKey = (labId: string) => PREP_STOP + labId;
export const prepSameRef = (a: PrepRef, b: PrepRef) => a.labId === b.labId && a.n === b.n && a.code === b.code && a.sandboxId === b.sandboxId;
const terminal = (j: PrepJob) => j.phase === 'ready' || j.phase === 'failed' || j.phase === 'uncertain';
/** patchSetup 이 저장 직전에 쓴다: job·stop 을 한 번에 읽어(get([...]))서 이 일 번호가 아직 주인인지 (ref 네 값 모두 같아야) */
export const prepOwns = (job: PrepJob | undefined, stop: PrepStop | undefined, ref: PrepRef, op: string) =>
  !stop && !!job && job.op === op && prepSameRef(job.ref, ref) && !terminal(job);

export const PREP_LIMIT = 1;              // 한 DO 에서 동시에 도는 일
export const PREP_DEADLINE = 5 * 60e3;    // 일 하나의 끝 시각
export const PREP_PROBES = 40;            // 확인 실패·기다림 횟수 (입장 폴링도 센다 — 끝 시각과 함께 막는다)
export const PREP_OP_TIMEOUT = 60e3;      // 확인·켜기 호출 하나 (자료 넣기는 끝 시각까지)
export const PREP_BACKOFF = [2e3, 4e3, 8e3, 15e3, 30e3];
export const PREP_WAKE_WAIT = 20e3;       // 켜기 요청 사이
export const PREP_EDITOR_WAIT = 45e3;     // 편집기 켜기 요청 사이 (앞 요청이 아직 켜는 중일 수 있다)
export const PREP_EDITORS = 2;
export const PREP_RETRY_AFTER = 30e3;     // 실패한 일을 입장(ensure)이 새로 시작할 수 있는 때 (uncertain 은 해당 없음)
export const PREP_QUEUE_MAX = 40;         // 끝나지 않은 일 기록 수 (enqueue·ensure 모두 #tx 안에서 세고 만든다)
export const PREP_BATCH_MAX = 20;         // enqueue 한 번 (State 는 수업 하나 20자리까지)
export const PREP_KEEP = 24 * 3600e3;     // 끝난 일(ready·failed)·멈춤 표시를 알람이 지우는 때. uncertain 은 지우지 않는다

export const PREP_QUEUED = '실습실을 준비하는 중';
export const PREP_INSTALLING = '수업 자료를 넣는 중';
export const PREP_EDITOR = '편집기를 켜는 중';
export const PREP_UNCERTAIN = '수업 자료를 넣던 중 끝났는지 알 수 없게 되었습니다. 강사가 이 자리 실습실을 새로 만들어야 합니다.';
export const PREP_TIMEOUT = '실습실 준비 시간이 지났습니다. 강사에게 알려주세요.';
/** State 의 labJoin·labReady 앞에서 쓴다: 이 setup 이면 ready 로 보내지 않는다 (자료 경고가 아니라 막힘) */
export const prepUncertain = (setup: PrepSetup | undefined) => setup?.state === 'error' && setup.note === PREP_UNCERTAIN;

/** 바깥 호출의 마지막 문. State 는 키 풀기·자리 확인 등 모든 await 를 마친 뒤, 바깥 호출 바로 앞(사이에 await 없이)에서 꼭 부른다.
 *  던지면 호출하지 않는다 (잡지 말고 그대로 내보낸다). 자격 증명은 없다.
 *  op: 이 호출을 연 일 번호 (State 가 저장된 일 기록과 맞춰 본다), cut: 이 호출의 끝 시각 (절대 시각, 호출 하나·일 끝 시각 중 이른 쪽) */
export type PrepGate = (() => void) & { readonly op: string; readonly cut: number };

export interface PrepOps {
  sandbox(ref: PrepRef, gate: PrepGate): Promise<Sandbox>;                          // GET /sandbox/<id>
  wake(ref: PrepRef, sb: Sandbox, gate: PrepGate): Promise<void>;                   // POST /sandbox/<id>/start
  install(ref: PrepRef, sb: Sandbox, m: Materials, gate: PrepGate): Promise<string>; // putMaterials → 강사 화면 한 줄 (중간에 끊지 않는다)
  health(ref: PrepRef, sb: Sandbox, gate: PrepGate): Promise<boolean>;              // healthz 200
  editor(ref: PrepRef, sb: Sandbox, gate: PrepGate): Promise<void>;                 // spawn lab-start
}

export interface LabPrepDeps {
  storage: Pick<DurableObjectStorage, 'get' | 'put' | 'delete' | 'list'>;
  now(): number;
  waitUntil(p: Promise<unknown>): void;
  schedule(at: number): Promise<void>;                 // State 가 자기 알람과 합친다 (더 이른 쪽)
  active(ref: PrepRef): Promise<PrepSnapshot | null>;  // 지금 유효한 자리면 모습, 아니면 null (cancelLab 을 기다리면 안 된다)
  patchSetup(ref: PrepRef, op: string, setup: PrepSetup): Promise<boolean>; // 주인일 때만 저장 → true (#tx 안에서 불린다 — cancelLab 을 기다리면 안 된다)
  ops: PrepOps;
  delay?(ms: number): Promise<void>;                   // 호출 시간 제한용 (테스트는 가짜 시계)
  limit?: number;
}

const LOST = Symbol('lost');      // 주인이 아니게 됨 (멈춤·바뀜·자리 없음) — 아무것도 더 쓰지 않는다
const TIMEOUT = Symbol('timeout');
type Lost = typeof LOST;
/** 호출 하나의 문 상태: why 는 문이 거절한 까닭, shut 은 기다림이 시간으로 끝남 */
type GateBox = { why: Lost | typeof TIMEOUT | null; shut: boolean; gate: PrepGate };
const GONE: PrepResult = { status: 'gone' };
const PREP_BUSY_WAIT = 30e3; // 자리가 찼을 때 다시 볼 간격 (보통은 끝난 일의 kick 이 먼저 깨운다)
const queued = (): PrepResult => ({ status: 'starting', detail: PREP_QUEUED });
const uncertain = (): PrepResult => ({ status: 'error', message: PREP_UNCERTAIN, final: true });

export class LabPreparationService {
  #live = new Map<string, { op: string; ref: PrepRef; p: Promise<PrepResult> }>(); // code → 도는 일 (같은 자리는 하나)
  #entering = new Map<string, { ref: PrepRef; p: Promise<PrepResult> }>(); // code → 진행 중인 입장 (그동안 enqueue·알람은 이 자리 일을 만들거나 시작하지 않는다)
  #busy = 0;            // 쓰는 자리 (기다림을 그만둔 호출도 실제로 끝날 때까지 센다)
  #heavy = false;       // 자료 넣기 중 (실제로 끝날 때까지)
  #stopped = new Map<string, number>(); // labId → 멈춘 시각 (저장 전에 메모리에서 먼저 막는다)
  #dead = new Set<string>();            // 멈춘 수업·바뀐 자리의 도는 일 번호
  #q: Promise<void> = Promise.resolve(); // #tx 줄
  #seq = 0;

  constructor(private d: LabPrepDeps) {}
  private get s() { return this.d.storage; }
  get #limit() { return Math.max(1, this.d.limit ?? PREP_LIMIT); }

  /** 백그라운드 준비 줄에 넣기 (이미 있거나 끝난 자리는 건너뜀). 넣은 수 */
  async enqueue(refs: PrepRef[]) {
    let added = 0;
    for (const ref of refs.slice(0, PREP_BATCH_MAX)) {
      if (await this.#isStopped(ref.labId)) continue;
      if (!(await this.d.active(ref))) continue; // 지난 자리로 지금 일을 바꾸지 않게
      // 같은 자리 기록이 있으면(도는 중·끝남 모두) 그대로. uncertain 은 같은 샌드박스로는 바꾸지 않는다
      if (!(await this.#create(ref, false, (old) => !old || (!prepSameRef(old.ref, ref) && !(old.phase === 'uncertain' && old.ref.sandboxId === ref.sandboxId))))) continue;
      added++;
    }
    if (added) this.kick();
    return added;
  }

  /** 기다리는 일을 빈 자리만큼 백그라운드로 돌린다 (기다리지 않음) */
  kick() { this.d.waitUntil(this.#pump().catch(() => {})); }

  /** 입장(labJoin): 이 자리를 지금 확인한다. 같은 자리(ref 네 값)가 이미 돌면 그 결과를 같이 기다린다. 빈 자리가 없으면 줄에 두고 starting.
   *  ready 였던 자리도 편집기 상태는 다시 확인한다 (ready 를 권한으로 보지 않는다). 자리 유효성은 State 가 먼저 본다 */
  ensure(ref: PrepRef): Promise<PrepResult> {
    const live = this.#live.get(ref.code);
    if (live && prepSameRef(live.ref, ref) && !this.#dead.has(live.op)) return live.p;
    const entering = this.#entering.get(ref.code); // 같은 자리 입장이 겹치면 하나로 (첫 await 전에 묶는다)
    if (entering && prepSameRef(entering.ref, ref)) return entering.p;
    const p = this.#ensure(ref).finally(() => { if (this.#entering.get(ref.code)?.p === p) this.#entering.delete(ref.code); });
    if (!entering) this.#entering.set(ref.code, { ref, p });
    return p;
  }

  async #ensure(ref: PrepRef): Promise<PrepResult> {
    if (await this.#isStopped(ref.labId)) return GONE;
    const snap = await this.d.active(ref);
    if (!snap || this.#stopped.has(ref.labId)) return GONE;
    if (prepUncertain(snap.setup)) return uncertain();
    let job = await this.s.get<PrepJob>(prepJobKey(ref.code));
    const share = () => { const l = this.#live.get(ref.code); return l && prepSameRef(l.ref, ref) && !this.#dead.has(l.op) ? l.p : null; };
    const again = share();
    if (again) return again;
    const same = !!job && prepSameRef(job.ref, ref);
    if (job && same && job.phase === 'uncertain') return uncertain();
    if (job && same && job.phase === 'failed' && this.d.now() - (job.endedAt ?? 0) < PREP_RETRY_AFTER)
      return { status: 'error', message: job.note ?? PREP_TIMEOUT, final: true };
    if (!job || !same || terminal(job)) {
      const made = await this.#create(ref, true, (old) => {
        if (!old) return true;
        if (old.phase === 'uncertain' && old.ref.sandboxId === ref.sandboxId) return false;
        if (!prepSameRef(old.ref, ref)) return true;
        return old.phase === 'ready' || (old.phase === 'failed' && this.d.now() - (old.endedAt ?? 0) >= PREP_RETRY_AFTER);
      });
      if (!made) {
        if (this.#stopped.has(ref.labId)) return GONE;
        const cur = await this.s.get<PrepJob>(prepJobKey(ref.code));
        if (cur && prepSameRef(cur.ref, ref) && cur.phase === 'uncertain') return uncertain();
        return share() ?? queued();
      }
      job = made;
      const raced = share();
      if (raced) return raced;
    }
    if (this.#busy >= this.#limit || this.#live.has(ref.code)) { this.#scheduleSoon(Math.max(job.due, this.d.now() + PREP_BUSY_WAIT)); return this.#timed(job, queued()); }
    return this.#start(job);
  }

  /** 수업 끝내기·만료·멈춤: 먼저 메모리로 막고, #tx 줄에서 멈춤 표시를 쓴 뒤 일 기록을 지운다. State 는 이걸 기다린 뒤에 바깥 정리를 시작한다.
   *  줄에서 이미 쓰던 저장(일 기록·setup 패치)은 끝난 뒤 지워지고, 뒤에 선 저장은 메모리 멈춤을 보고 쓰지 않는다.
   *  돌던 호출(자료 넣기 포함)은 끊지 않는다 — 끝나도 더 쓰지 않는다 */
  async cancelLab(labId: string) {
    const t = this.d.now();
    this.#stopped.set(labId, this.#stopped.get(labId) ?? t);
    for (const x of this.#live.values()) if (x.ref.labId === labId) this.#dead.add(x.op);
    await this.#tx(async () => {
      await this.s.put(prepStopKey(labId), { at: t } satisfies PrepStop);
      const gone: string[] = [];
      for (const [k, j] of await this.s.list<PrepJob>({ prefix: PREP_JOB })) if (j.ref.labId === labId) gone.push(k);
      for (let i = 0; i < gone.length; i += 128) await this.s.delete(gone.slice(i, i + 128));
    });
    this.#scheduleSoon(t + PREP_KEEP + 1); // 멈춤 표시 정리
  }

  /** 알람: 오래된 기록 정리 + 기다리는 일 돌리기. 다음 시각(정리 시각 포함, 없으면 null) */
  async alarm(t = this.d.now()): Promise<number | null> {
    let next: number | null = null;
    const at = (x: number) => { next = next === null ? x : Math.min(next, x); };
    await this.#tx(async () => {
      for (const [k, v] of await this.s.list<PrepStop>({ prefix: PREP_STOP })) {
        if (t - v.at <= PREP_KEEP) { at(v.at + PREP_KEEP + 1); continue; }
        await this.s.delete(k);
        this.#stopped.delete(k.slice(PREP_STOP.length));
      }
      for (const [k, j] of await this.s.list<PrepJob>({ prefix: PREP_JOB })) {
        if (prepTimingExpired(j.timing, t)) { delete j.timing; await this.s.put(k, j); }
        else if (j.timing) at(j.timing.at + PREP_TIMING_KEEP + 1); // uncertain 보호 기록도 숫자 관측은 제때 거둔다
        if (!terminal(j) || j.phase === 'uncertain') continue; // uncertain 은 시간이 지나도 지우지 않는다
        const end = (j.endedAt ?? j.created) + PREP_KEEP;
        if (t <= end || this.#live.has(j.ref.code)) { at(Math.max(end + 1, t + 1e3)); continue; }
        await this.s.delete(k);
      }
    });
    return this.#pump(t, next);
  }

  // ── 안쪽 ──

  /** 이 서비스의 저장을 한 줄로 (바깥 호출은 넣지 않는다. 안에서 #tx 를 다시 부르지 않는다) */
  #tx<T>(f: () => Promise<T>): Promise<T> {
    const r = this.#q.then(f);
    this.#q = r.then(() => {}, () => {});
    return r;
  }

  async #isStopped(labId: string) {
    if (this.#stopped.has(labId)) return true;
    const st = await this.s.get<PrepStop>(prepStopKey(labId));
    if (st) this.#stopped.set(labId, this.#stopped.get(labId) ?? st.at);
    return this.#stopped.has(labId);
  }

  /** 지금 도는 일이 아직 살아 있나 (await 없이 — 바깥 호출 바로 앞에서) */
  #alive(ref: PrepRef, op: string) { return !this.#dead.has(op) && !this.#stopped.has(ref.labId); }

  /** 새 일 기록 (#tx 안에서 멈춤·기존 기록·끝나지 않은 일 수를 보고 만든다). 같은 자리가 다른 ref 로 돌던 일은 바뀐 것으로 막는다 */
  async #create(ref: PrepRef, foreground: boolean, want: (old: PrepJob | undefined) => boolean): Promise<PrepJob | null> {
    const blocked = () => this.#stopped.has(ref.labId) || (!foreground && this.#entering.has(ref.code));
    return this.#tx(async () => {
      if (blocked()) return null;
      const got = await this.s.get<PrepJob | PrepStop>([prepJobKey(ref.code), prepStopKey(ref.labId)]);
      const old = got.get(prepJobKey(ref.code)) as PrepJob | undefined, stop = got.get(prepStopKey(ref.labId)) as PrepStop | undefined;
      if (stop) { this.#stopped.set(ref.labId, this.#stopped.get(ref.labId) ?? stop.at); return null; }
      if (!want(old)) return null;
      let open = 0;
      for (const j of (await this.s.list<PrepJob>({ prefix: PREP_JOB })).values()) if (!terminal(j) && j.ref.code !== ref.code) open++;
      if (open >= PREP_QUEUE_MAX || blocked()) return null;
      const live = this.#live.get(ref.code);
      if (live && prepSameRef(live.ref, ref) && !this.#dead.has(live.op)) return null; // 그 일이 주인 — 부른 쪽이 같이 기다린다
      if (live) this.#dead.add(live.op); // 다른 ref 로 돌던 일: 바뀜
      const t = this.d.now();
      const job: PrepJob = { ref: { labId: ref.labId, n: ref.n, code: ref.code, sandboxId: ref.sandboxId }, op: `${t.toString(36)}-${(++this.#seq).toString(36)}-${crypto.randomUUID().slice(0, 8)}`,
        phase: 'queued', created: t, deadline: t + PREP_DEADLINE, due: t, tries: 0, editors: 0, timing: prepTimingNew(t) };
      await this.s.put(prepJobKey(ref.code), job);
      this.#scheduleSoon(t + PREP_TIMING_KEEP + 1); // ready/failed/uncertain 어느 단계로 끝나도 관측 만료 알람은 남긴다
      return job;
    });
  }

  /** 기다리는 일을 빈 자리만큼 시작. 다음 시각 */
  async #pump(t = this.d.now(), next: number | null = null): Promise<number | null> {
    const jobs = [...(await this.s.list<PrepJob>({ prefix: PREP_JOB })).values()]
      .filter((j) => !terminal(j)).sort((a, b) => a.due - b.due || a.created - b.created);
    for (const j of jobs) {
      if (this.#live.has(j.ref.code) || this.#entering.has(j.ref.code) || this.#stopped.has(j.ref.labId)) continue;
      if (j.due <= t && this.#busy < this.#limit) { this.d.waitUntil(this.#start(j).catch(() => {})); continue; }
      const at = Math.max(j.due, t + (this.#busy >= this.#limit ? PREP_BUSY_WAIT : 1e3)); // 자리가 차 있으면 끝난 일의 kick 을 기다리고, 알람은 드물게
      next = next === null ? at : Math.min(next, at);
    }
    if (next !== null) await this.d.schedule(next);
    return next;
  }

  #scheduleSoon(due: number) { this.d.waitUntil(this.d.schedule(Math.max(due, this.d.now() + 1e3)).catch(() => {})); }

  /** 자리를 하나 잡고 일을 돌린다. 같은 자리 일은 하나 (live 로 묶음). 이 함수 안 첫 await 전에 live·busy 를 잡는다 */
  #start(job: PrepJob): Promise<PrepResult> {
    const code = job.ref.code;
    const live = this.#live.get(code);
    if (live) return live.op === job.op ? live.p : Promise.resolve(queued());
    this.#busy++;
    const orphans: Promise<unknown>[] = [];
    const p = (async () => {
      let r: PrepResult = GONE;
      try { return r = await this.#run(job.ref, job.op, orphans); }
      catch (e) { return r = { status: 'error', message: labErrorText(e), final: false }; }
      finally {
        await this.#settle(job, r).catch(() => {});
        if (this.#live.get(code)?.op === job.op) this.#live.delete(code);
        // 기다림을 그만둔 호출도 실제로 끝난 뒤에 자리를 돌려준다 (동시 개수가 넘지 않게 — 시간으로 놓아 주지 않는다)
        void Promise.allSettled(orphans).then(() => { this.#dead.delete(job.op); this.#busy--; this.kick(); });
      }
    })();
    this.#live.set(code, { op: job.op, ref: job.ref, p });
    return p;
  }

  /** 실행이 끝난 뒤 내 기록(일 번호가 그대로일 때만)이 남아 같은 자리를 곧바로 다시 돌리지 않게 한다:
   *  gone(자리 없음·멈춤) 이면 기록을 거두고, 예외로 끝나 다음 시각이 지나 있으면 조금 미룬다 */
  #settle(job: PrepJob, r: PrepResult) {
    return this.#tx(async () => {
      const cur = await this.s.get<PrepJob>(prepJobKey(job.ref.code));
      if (!cur || cur.op !== job.op || terminal(cur)) return;
      if (r.status === 'gone') { await this.s.delete(prepJobKey(job.ref.code)); return; }
      if (cur.due <= this.d.now() && this.#alive(job.ref, job.op)) { cur.due = this.d.now() + PREP_BACKOFF[0]; await this.s.put(prepJobKey(job.ref.code), cur); }
    });
  }

  /** 지금도 주인인가: 메모리 멈춤 → 자리 유효(active) → 저장된 멈춤·일 번호 → 메모리 다시. 아니면 LOST */
  async #own(ref: PrepRef, op: string): Promise<{ job: PrepJob; snap: PrepSnapshot } | Lost> {
    if (!this.#alive(ref, op)) return LOST;
    const snap = await this.d.active(ref);
    if (!snap || !this.#alive(ref, op)) return LOST;
    const got = await this.s.get<PrepJob | PrepStop>([prepJobKey(ref.code), prepStopKey(ref.labId)]);
    const job = got.get(prepJobKey(ref.code)) as PrepJob | undefined, stop = got.get(prepStopKey(ref.labId)) as PrepStop | undefined;
    if (stop) this.#stopped.set(ref.labId, this.#stopped.get(ref.labId) ?? stop.at);
    if (!prepOwns(job, stop, ref, op) || !this.#alive(ref, op)) return LOST;
    return { job: job!, snap };
  }

  /** 내 일 기록 저장 — #tx 안에서 메모리 멈춤·저장된 멈춤·일 번호(끝나지 않은 내 기록)를 보고 쓴다. 바뀐 주인의 기록은 덮지 않는다 */
  #save(job: PrepJob) {
    return this.#tx(async () => {
      if (!this.#alive(job.ref, job.op)) return false;
      const got = await this.s.get<PrepJob | PrepStop>([prepJobKey(job.ref.code), prepStopKey(job.ref.labId)]);
      const cur = got.get(prepJobKey(job.ref.code)) as PrepJob | undefined, stop = got.get(prepStopKey(job.ref.labId)) as PrepStop | undefined;
      if (stop) this.#stopped.set(job.ref.labId, this.#stopped.get(job.ref.labId) ?? stop.at);
      if (!prepOwns(cur, stop, job.ref, job.op) || !this.#alive(job.ref, job.op)) return false;
      if (prepTimingExpired(job.timing, this.d.now())) delete job.timing;
      await this.s.put(prepJobKey(job.ref.code), job);
      return this.#alive(job.ref, job.op); // 쓰는 사이 멈췄으면 (cancelLab 이 줄 뒤에서 지운다) 이어 가지 않는다
    });
  }

  /** setup 저장 — #tx 안에서 (cancelLab 의 멈춤 표시·기록 지우기와 겹치지 않게). false 면 주인이 아니게 된 것 */
  #patch(ref: PrepRef, op: string, setup: PrepSetup) {
    return this.#tx(async () => this.#alive(ref, op) && (await this.d.patchSetup(ref, op, setup)) && this.#alive(ref, op));
  }

  /** 시간 제한 타이머. 호출이 먼저 끝나면 clear 로 진짜 타이머를 지운다 (남은 타이머가 DO·프로세스를 붙잡지 않게). 주입된 delay(테스트)는 그대로 */
  #timer(ms: number): { p: Promise<void>; clear(): void } {
    if (this.d.delay) return { p: this.d.delay(ms), clear() {} };
    let h: ReturnType<typeof setTimeout> | undefined;
    return { p: new Promise<void>((r) => { h = setTimeout(r, ms); }), clear() { if (h !== undefined) clearTimeout(h); } };
  }

  /** 바깥 호출 하나의 문 (cut: 이 호출의 끝 시각, 절대 시각). 일이 살아 있고(멈춤·바뀜 없음, 지금 도는 일 번호 그대로) cut 전이고
   *  기다림이 아직 끝나지 않았을 때만 통과. 한 번 닫히면(why) 다시 열리지 않는다 */
  #gate(ref: PrepRef, op: string, cut: number): GateBox {
    const g: GateBox = {
      why: null, // 문이 거절한 까닭 (일 전체를 죽이지 않는다 — 이 호출만)
      shut: false, // 기다림이 끝남 (시간 제한) — 늦게 온 State 는 부르지 않는다
      gate: Object.freeze(Object.assign(() => {
        if (!g.why) {
          if (!this.#alive(ref, op) || this.#live.get(ref.code)?.op !== op) g.why = LOST;
          else if (g.shut || !(this.d.now() < cut)) g.why = TIMEOUT;
        }
        if (g.why) throw new Error('prep gate closed');
      }, { op, cut })) as PrepGate,
    };
    return g;
  }

  /** 기다림. 시간이 지나면 기다림만 멈춘다 (호출은 끊지 않고 orphans 로 남겨 자리를 계속 센다). onFire 는 시간이 지난 바로 그때 (await 없이) */
  async #race<T>(p: Promise<T>, ms: number, orphans: Promise<unknown>[], onFire?: () => void): Promise<T | typeof TIMEOUT> {
    let fired = false;
    const t = this.#timer(Math.max(0, ms));
    try {
      const r = await Promise.race([p, t.p.then(() => { fired = true; onFire?.(); return TIMEOUT; })]);
      if (r === TIMEOUT && fired) { orphans.push(p.catch(() => {})); return TIMEOUT; } // 기다림만 그만둔다 — 호출은 orphans 로 자리를 계속 잡는다
      return r as T;
    } finally { t.clear(); }
  }

  /** 바깥 호출 하나 — 부르기 바로 앞(await 없이)에서 살아 있는지 본다.
   *  남은 시간이 없으면(앞 저장·확인을 기다리는 사이 끝 시각이 지남, 0 이하·NaN) 부르지 않고 TIMEOUT — 끝 시각 뒤에 바깥 호출을 시작하지 않는다 */
  #ext<T>(ref: PrepRef, op: string, f: (gate: PrepGate) => Promise<T>, ms: number, orphans: Promise<unknown>[]): Promise<T | typeof TIMEOUT | Lost> {
    if (!this.#alive(ref, op)) return Promise.resolve(LOST);
    if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve(TIMEOUT);
    // 끝 시각은 부르기 전에 절대 시각으로 잡는다. State 가 키 풀기·확인을 기다리는 사이 이 시각·멈춤·바뀜이 지나면 문이 막는다
    const g = this.#gate(ref, op, this.d.now() + ms);
    let p: Promise<T>;
    try { p = f(g.gate); } catch (e) { p = Promise.reject(e); }
    return this.#race(p, ms, orphans, () => { g.shut = true; })
      .then((r) => (r !== TIMEOUT && g.why) || r, (e) => { if (g.why) return g.why; throw e; }); // 문이 막았으면 부르지 않은 것 — 시간 제한·주인 잃음으로 본다
  }

  /** 지금 주인의 관측만 응답에 붙임. 실패·gone에는 붙이지 않는다. */
  #timed(job: PrepJob, r: PrepResult): PrepResult {
    if (r.status !== 'ready' && r.status !== 'starting') return r;
    return { ...r, prepTiming: prepTimingView(job.timing, job.started, job.endedAt, this.d.now()) };
  }

  /** 다음 시도까지 기다림 (확인 횟수 하나). 횟수를 넘으면 실패 */
  async #wait(job: PrepJob, detail: string): Promise<PrepResult> {
    job.tries++;
    if (job.timing) job.timing.waitAt = this.d.now();
    if (job.tries >= PREP_PROBES) return this.#fail(job, PREP_TIMEOUT);
    job.due = this.d.now() + PREP_BACKOFF[Math.min(job.tries - 1, PREP_BACKOFF.length - 1)];
    if (!(await this.#save(job))) return GONE;
    this.#scheduleSoon(job.due);
    return this.#timed(job, { status: 'starting', detail });
  }

  async #fail(job: PrepJob, msg: string, phase: 'failed' | 'uncertain' = 'failed'): Promise<PrepResult> {
    job.phase = phase; job.note = msg; job.endedAt = this.d.now();
    if (!(await this.#save(job))) return GONE;
    if (phase === 'failed') this.#scheduleSoon(job.endedAt + PREP_KEEP + 1); // 기록 정리
    return { status: 'error', message: msg, final: true };
  }

  async #run(ref: PrepRef, op: string, orphans: Promise<unknown>[]): Promise<PrepResult> {
    let own = await this.#own(ref, op);
    if (own === LOST) return GONE;
    let { job, snap } = own;
    const fresh = async () => { own = await this.#own(ref, op); if (own === LOST) return false; ({ job, snap } = own); return true; };
    const left = () => job.deadline - this.d.now();
    // 끝났는지 모르는 자료 넣기: 주인 없는 'running'(예전 방식·다시 뜸) 은 '알 수 없음' 으로 닫는다 (다시 넣지 않음)
    const unknown = async (): Promise<PrepResult> => {
      if (!prepUncertain(snap.setup) && !(await this.#patch(ref, op, { state: 'error', at: this.d.now(), note: PREP_UNCERTAIN }))) return GONE;
      if (!(await fresh())) return GONE;
      return this.#fail(job, PREP_UNCERTAIN, 'uncertain');
    };
    const stuck = () => snap.setup?.state === 'running' || prepUncertain(snap.setup);
    if (stuck()) return unknown();
    prepTimingResume(job.timing, this.d.now());
    if (job.started === undefined) {
      job.started = this.d.now(); job.deadline = job.started + PREP_DEADLINE;
      prepTimingAdd(job.timing, 'prep_queue', job.started - job.created, this.d.now());
    }
    if (!(await this.#save(job))) return GONE;

    // 서버가 다시 떠서 이어 받은 일 (같은 자리 일은 메모리에서 하나뿐이라, 여기서 install·editor 단계면 앞 실행이 죽은 것):
    // 자료 넣기는 'running' 을 적은 뒤에만 시작하므로, 'running' 이면 위에서 '알 수 없음' 으로 닫혔고, 아니면 시작도 안 한 것이다.
    // 편집기 켜기는 확인부터 (editorAt 이 요청 전에 적혀 있어 PREP_EDITOR_WAIT 안에는 다시 켜지 않는다)
    if (job.phase === 'install' || job.phase === 'editor') {
      job.phase = 'probe';
      if (!(await this.#save(job))) return GONE;
    }

    for (let step = 0; step < 8; step++) {
      if (!(await fresh())) return GONE; // 앞 저장(시작·단계 바꿈)을 기다리는 사이 멈춤·바뀜
      if (left() <= 0) return this.#fail(job, PREP_TIMEOUT);

      // 1) 샌드박스 상태 — ready 였어도 매번 본다
      let sandboxAt: number | undefined;
      const sb = await this.#ext(ref, op, (gate) => { sandboxAt = this.d.now(); return this.d.ops.sandbox(ref, gate); }, Math.min(PREP_OP_TIMEOUT, left()), orphans).catch((e) => ({ err: e }));
      const sandboxMs = sandboxAt === undefined ? NaN : this.d.now() - sandboxAt;
      if (sb === LOST || !(await fresh())) return GONE;
      prepTimingAdd(job.timing, 'prep_sandbox', sandboxMs, this.d.now());
      if (!(await this.#save(job))) return GONE;
      if (sb === TIMEOUT) return this.#wait(job, PREP_QUEUED);
      if ('err' in sb) { const w = await this.#wait(job, PREP_QUEUED); return w.status === 'starting' ? { status: 'error', message: labErrorText(sb.err), final: false } : w; }
      if (sb.id !== ref.sandboxId) return this.#fail(job, labStateError({ state: 'mismatch', errorReason: undefined }));
      const ws = labWakeStep(sb.state);
      if (ws === 'bad') return this.#fail(job, labStateError(sb));
      if (ws !== 'ready') {
        if (ws === 'start' && (!job.wokeAt || this.d.now() - job.wokeAt >= PREP_WAKE_WAIT)) {
          job.phase = 'wake'; job.wokeAt = this.d.now();
          if (!(await this.#save(job)) || !(await fresh())) return GONE; // 저장하는 사이 멈춤·바뀜도 본다
          let wakeAt: number | undefined;
          const r = await this.#ext(ref, op, (gate) => { wakeAt = this.d.now(); return this.d.ops.wake(ref, sb, gate); }, Math.min(PREP_OP_TIMEOUT, left()), orphans).catch((e) => ({ err: e }));
          const wakeMs = wakeAt === undefined ? NaN : this.d.now() - wakeAt;
          if (r === LOST || !(await fresh())) return GONE;
          prepTimingAdd(job.timing, 'prep_wake', wakeMs, this.d.now());
          if (!(await this.#save(job))) return GONE;
          if (r && r !== TIMEOUT && 'err' in r) return this.#wait(job, labWakeDetail('start'));
        }
        return this.#wait(job, labWakeDetail(ws));
      }

      // 2) 수업 자료 — 아직 안 넣었고 아무도 입장하지 않은 자리만. ok·error·opened 는 그대로
      if (stuck()) return unknown();
      if (snap.materials && !snap.setup && !snap.opened) {
        if (this.#heavy) { job.due = this.d.now() + PREP_BUSY_WAIT; if (job.timing) job.timing.waitAt = this.d.now(); if (!(await this.#save(job))) return GONE; this.#scheduleSoon(job.due); return this.#timed(job, { status: 'starting', detail: PREP_INSTALLING }); }
        this.#heavy = true; // 첫 await 전에 잡는다. 자료 넣기를 시작하지 않고 나가면 finally 가 놓는다
        let inst: Promise<{ state: 'ok' | 'error'; note: string }> | null = null;
        let g: GateBox | null = null;
        let installAt: number | undefined;
        try {
          job.phase = 'install';
          if (!(await this.#save(job))) return GONE;      // 주인 기록이 먼저
          if (!(await fresh())) return GONE;
          const m = snap.materials;
          if (snap.setup || snap.opened || !m) { job.phase = 'probe'; if (!(await this.#save(job))) return GONE; continue; }
          if (!(await this.#patch(ref, op, { state: 'running', at: this.d.now(), note: '' }))) return GONE; // patchSetup 이 자리 유효·주인을 본다
          // 'running' 을 쓰는 사이 만료·끝내기·바뀜·끝 시각이 지났을 수 있다 — 자리·주인·끝 시각을 다시 본다 (내가 쓴 'running' 은 주인 없는 것으로 보지 않는다).
          // 여기서 나가면 자료 넣기는 시작하지 않은 것: 주인을 잃었으면 'running' 이 남아 다음 일은 '알 수 없음' (막는 쪽), 끝 시각이면 보통 오류
          if (!(await fresh()) || (snap.setup as PrepSetup | undefined)?.state !== 'running' || snap.materials?.url !== m.url) return GONE;
          if (left() <= 0) {
            if (!(await this.#patch(ref, op, { state: 'error', at: this.d.now(), note: PREP_TIMEOUT }))) return GONE;
            if (!(await fresh())) return GONE;
            return this.#fail(job, PREP_TIMEOUT);
          }
          if (!this.#alive(ref, op)) return GONE; // 부르기 바로 앞 (await 없이)
          g = this.#gate(ref, op, job.deadline); // 일 끝 시각 (left() > 0 을 위에서 봤다)
          installAt = this.d.now();
          let raw: Promise<string>;
          try { raw = this.d.ops.install(ref, sb, m, g.gate); } catch (e) { raw = Promise.reject(e); }
          inst = raw.then((note) => ({ state: 'ok' as const, note }), (e) => ({ state: 'error' as const, note: labErrorText(e) }));
          void inst.finally(() => { this.#heavy = false; this.kick(); }); // 실제로 끝날 때까지 다음 자료 넣기를 막는다
        } finally { if (!inst) this.#heavy = false; }
        const gi = g!;
        const r = await this.#race(inst!, gi.gate.cut - this.d.now(), orphans, () => { gi.shut = true; });
        const installMs = this.d.now() - installAt!;
        if (r !== TIMEOUT && gi.why === LOST) return GONE; // 문이 막음: 자료 넣기는 시작하지 않았다 ('running' 이 남아 다음 일은 '알 수 없음')
        if (!(await fresh())) return GONE; // 멈췄으면 결과를 쓰지 않는다 ('running' 이 남아 다음 일은 '알 수 없음')
        if (gi.why !== TIMEOUT) {
          prepTimingAdd(job.timing, 'prep_materials', installMs, this.d.now());
          if (!(await this.#save(job))) return GONE;
        }
        if (r === TIMEOUT) return unknown(); // 끝났는지 모른다 — 오류·재시도 아님
        if (gi.why === TIMEOUT) { // 문이 끝 시각으로 막음: 시작하지 않았다 — 자료 경고(ready)가 아니라 시간 초과
          if (!(await this.#patch(ref, op, { state: 'error', at: this.d.now(), note: PREP_TIMEOUT }))) return GONE;
          if (!(await fresh())) return GONE;
          return this.#fail(job, PREP_TIMEOUT);
        }
        if (!(await this.#patch(ref, op, { ...r, at: this.d.now() }))) return GONE;
        if (!(await fresh())) return GONE;
        job.phase = 'probe';
        if (!(await this.#save(job))) return GONE;
        continue; // 샌드박스부터 다시 (자료 넣는 사이 꺼졌을 수 있다)
      }

      // 3) 편집기 확인 → 안 떠 있으면 켜기 (앞 요청이 아직 켜는 중이면 기다림)
      if (job.phase !== 'probe') { job.phase = 'probe'; if (!(await this.#save(job)) || !(await fresh())) return GONE; }
      let healthAt: number | undefined;
      const h = await this.#ext(ref, op, (gate) => { healthAt = this.d.now(); return this.d.ops.health(ref, sb, gate); }, Math.min(PREP_OP_TIMEOUT, left()), orphans).catch(() => false);
      const healthMs = healthAt === undefined ? NaN : this.d.now() - healthAt;
      if (h === LOST || !(await fresh())) return GONE;
      prepTimingAdd(job.timing, 'prep_health', healthMs, this.d.now());
      if (!(await this.#save(job))) return GONE;
      if (stuck()) return unknown();
      if (h === true) {
        job.phase = 'ready'; job.endedAt = this.d.now(); job.note = undefined;
        if (!(await this.#save(job))) return GONE;
        this.#scheduleSoon(job.endedAt + PREP_KEEP + 1); // 기록 정리
        const last = await this.d.active(ref); // 저장하는 사이 자리가 바뀌었으면 ready 를 내보내지 않는다 (권한은 State 가 다시 본다)
        if (!last || !this.#alive(ref, op) || prepUncertain(last.setup) || last.setup?.state === 'running') return GONE;
        return this.#timed(job, { status: 'ready', setup: last.setup });
      }
      if (job.editors < PREP_EDITORS && (!job.editorAt || this.d.now() - job.editorAt >= PREP_EDITOR_WAIT)) {
        job.phase = 'editor'; job.editorAt = this.d.now(); job.editors++;
        if (!(await this.#save(job)) || !(await fresh())) return GONE; // 요청 전에 적는다 (다시 떠도 겹쳐 켜지 않게). 저장하는 사이 멈춤·바뀜도 본다
        let editorAt: number | undefined;
        const e = await this.#ext(ref, op, (gate) => { editorAt = this.d.now(); return this.d.ops.editor(ref, sb, gate); }, Math.min(PREP_OP_TIMEOUT, left()), orphans).catch(() => undefined);
        const editorMs = editorAt === undefined ? NaN : this.d.now() - editorAt;
        if (e === LOST || !(await fresh())) return GONE;
        prepTimingAdd(job.timing, 'prep_start', editorMs, this.d.now());
        if (!(await this.#save(job))) return GONE;
        job.phase = 'probe';
      }
      return this.#wait(job, PREP_EDITOR);
    }
    return this.#wait(job, PREP_QUEUED);
  }
}
