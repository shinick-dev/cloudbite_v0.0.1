// 수업 끝내기·만료 — State(DO) 안에서만 쓰는 서비스. Worker 에서 내보내지 않는다 (RPC 로 안 열린다).
// State 하나에 하나씩 만들고, 저장소·Daytona·세션 폐기·받기/화면 정리·알람 예약·감사 기록·메모리 캐시는 State 가 넘겨 준 것만 쓴다 (만들 때 I/O 없음).
// 끝내는 순서는 바꾸지 않는다: 샌드박스·세션 → 라벨로 한 번 더 → 참가자 흔적 → 수업 지우기 또는 5분 뒤 재시도.
import { dt, DtError, type Dt, type Sandbox } from './lab';
import type { Fail, Lab, Seat, Session } from './state';

// state.ts 의 같은 이름 도우미와 똑같다 (state.ts 를 런타임에 들여오지 않으려고 따로 둔다)
const now = () => Date.now();
const isFail = (x: unknown): x is Fail => typeof x === 'object' && x !== null && 'error' in x && 'status' in x;
const RETRY = 5 * 60e3;

type Why = 'end' | 'expire';

/** State 가 넘겨 주는 것. 콜백은 State 의 메서드·캐시를 그대로 부른다 (receiver 는 State — fixture 가 바꾼 Daytona 도 그대로) */
export interface LabLifecycleDeps {
  storage: Pick<DurableObjectStorage, 'get' | 'put' | 'delete' | 'list'>;
  daytona(): Promise<Dt | Fail>;
  labSandboxes(c: Dt, labId: string): Promise<Sandbox[]>;
  endSession(sess: Session): Promise<boolean>;
  endLab(lab: Lab, why: Why): Promise<boolean>; // 알람은 State.endLab 을 거친다 (원래 들어가는 길 그대로)
  exportClear(codes: string[], why: Why): Promise<void>;
  screenClear(labId: string): Promise<void>;
  dropPresence(code: string): void;
  dropSnipVer(labId: string): void;
  schedule(t: number): Promise<void>;
  audit(event: string, sid: string | null, ip: string | null, detail?: string): Promise<void>;
}

export class LabLifecycleService {
  constructor(private d: LabLifecycleDeps) {}
  private get s() { return this.d.storage; }

  /** 샌드박스 전부 삭제 + 세션(서브키) 전부 폐기. 하나라도 못 지우면 false → 알람이 5분 뒤 다시 */
  async end(lab: Lab, why: Why) {
    const c = await this.d.daytona();
    let ok = !isFail(c);
    for (const seat of lab.seats) {
      if (!(await this.#seatSandbox(c, seat))) ok = false;
      await this.#seatSession(seat);
    }
    // 라벨로 한 번 더: 만들다 응답을 못 받은 샌드박스가 있을 수 있다
    if (ok && !isFail(c)) ok = await this.#sweep(c, lab.id);
    await this.#forget(lab, why);
    return ok ? this.#finish(lab, why) : this.#retry(lab);
  }

  /** 알람: 끝 시각(또는 재시도 시각)이 지난 수업을 끝낸다. 다음 시각을 돌려준다 */
  async alarm(t: number) {
    let next = Infinity;
    for (const lab of (await this.s.list<Lab>({ prefix: 'lab:' })).values()) {
      const due = lab.endRetry ?? lab.expiresAt;
      if (due <= t) {
        if (!(await this.d.endLab(lab, 'expire'))) next = Math.min(next, t + RETRY);
      } else next = Math.min(next, due);
    }
    return next;
  }

  /** 자리 샌드박스 지우기 (404 도 지운 것). 못 지우면 false */
  async #seatSandbox(c: Dt | Fail, seat: Seat) {
    if (!seat.sandboxId || isFail(c)) return true;
    try { await dt(c, 'DELETE', `/sandbox/${seat.sandboxId}`); seat.sandboxId = undefined; }
    catch (e) { if (e instanceof DtError && e.status === 404) seat.sandboxId = undefined; else return false; }
    return true;
  }

  /** 자리 세션 폐기. 폐기를 못 하면 sid 를 남긴다 (샌드박스 결과 ok 와는 따로) */
  async #seatSession(seat: Seat) {
    if (!seat.sid) return;
    const sess = await this.s.get<Session>(`sess:${seat.sid}`);
    if (!sess || (await this.d.endSession(sess))) seat.sid = undefined;
  }

  /** 라벨이 이 수업인 샌드박스를 한 번 더 지운다 (이미 지워졌거나 지우는 중이면 건너뜀) */
  async #sweep(c: Dt, labId: string) {
    let ok = true;
    try {
      for (const sb of await this.d.labSandboxes(c, labId)) {
        if (sb.state === 'destroyed' || sb.state === 'destroying') continue;
        try { await dt(c, 'DELETE', `/sandbox/${sb.id}`); } catch (e) { if (!(e instanceof DtError && e.status === 404)) ok = false; }
      }
    } catch { ok = false; }
    return ok;
  }

  /** 참가자 흔적 지우기 — 재시도로 가도 먼저 한다 (자리 권한부터 없앤다) */
  async #forget(lab: Lab, why: Why) {
    // 내 작업 받기: 받는 중이면 끊고 묶은 폴더 지우기를 남긴다 (샌드박스가 지워졌으면 404 → 끝)
    await this.d.exportClear(lab.seats.map((x) => x.code), why);
    await this.s.delete(lab.seats.map((x) => `seat:${x.code}`));
    for (const x of lab.seats) this.d.dropPresence(x.code);
    await this.s.delete(lab.seats.map((x) => `pres:${x.code}`));
    await this.d.screenClear(lab.id);
    if (lab.cls) await this.s.delete(`cls:${lab.cls}`);
    await this.s.delete([`snips:${lab.id}`, `snipv:${lab.id}`]); // 받은 코드
    this.d.dropSnipVer(lab.id);
  }

  async #finish(lab: Lab, why: Why) {
    await this.s.delete(`lab:${lab.id}`);
    await this.d.audit(why === 'end' ? 'lab-end' : 'lab-expire', null, null, lab.name);
    return true;
  }

  async #retry(lab: Lab) {
    lab.endRetry = now() + RETRY;
    await this.s.put(`lab:${lab.id}`, lab);
    await this.d.schedule(lab.endRetry);
    await this.d.audit('lab-end-retry', null, null, lab.name);
    return false;
  }
}
