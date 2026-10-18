// 강사 보기 전용 세션 (teacher:<sha256>) — State(DO) 안에서만 쓰는 서비스. Worker 에서 내보내지 않는다 (RPC 로 안 열린다).
// 방금(3분 안) 웹에서 키를 탭한 관리 토큰으로만 만든다. 8시간 고정 (읽어도·다시 확인해도 늘지 않는다), 살아 있는 기기 16개까지 (넘으면 가장 오래된 것부터 지운다).
// 다시 확인은 이 기기의 지금 쿠키를 그대로 쓴다 (새 세션 없음). 로그아웃은 만들기와 같은 직렬 구역에서 쿠키·같은 화면의 관리 토큰·그 토큰으로 만든 세션을 지운다.
// 이 세션으로 할 수 있는 일은 수업 상태 읽기(monitor) 하나뿐 — 만들기·끝내기·초대·클립보드·공유 키·손 내리기·코드 보내기·금고·공급자·스냅샷은
// 전부 예전 관리 토큰(x-admin-token)만 받는다. 저장소에는 토큰 해시만, 원문은 쿠키로 한 번 나가고 끝.
// 상태는 저장소와 참가자 상태(메모리/pres:)만 읽는다 — Daytona·OpenRouter 를 부르지 않는다.
import { isoBase64URL } from '@simplewebauthn/server/helpers';
import type { Fail, Lab, Seat } from './state';
import { preparationView, emptyDiagnostics, type PreparationView, type SeatDiagnostics } from './lab-readiness';
import type { TerminalDeliveryView } from './lab-terminal-service';

// state.ts 의 같은 이름 도우미와 똑같다 (state.ts 를 런타임에 들여오지 않으려고 따로 둔다)
const now = () => Date.now();
const fail = (status: number, error: string): Fail => ({ status, error });
const rand = (n: number) => isoBase64URL.fromBuffer(crypto.getRandomValues(new Uint8Array(n)));

export const TEACHER_TTL = 8 * 3600e3;
export const TEACHER_MAX_LIVE = 16;
export const TEACHER_PREFIX = 'teacher:';
/** rand(24) 의 base64url = 32자 */
export const TEACHER_TOKEN = /^[\w-]{32}$/;
const SEATS_MAX = 20; // state.ts 의 LAB_MAX_SEATS 와 같다
// 자료 넣기 note 는 바깥(Daytona·자료 주소) 오류 원문이 들어갈 수 있다 — 고정 문구만 그대로, 나머지 오류는 일반 문구
const NOTE_FAILED = '수업 자료를 넣지 못했습니다.';

/** issuedBy: 만든 관리 토큰의 해시 (원문 아님) — 같은 화면이 로그아웃하며 그 관리 토큰을 내면, 그 토큰으로 만든 보기 세션도 함께 지운다 */
export interface TeacherTok { createdAt: number; expiresAt: number; issuedBy?: string }
type Presence = { state: 'active' | 'away' | 'offline' | 'none'; idleSec?: number; lastSeen?: number };

export interface LabTeacherDeps {
  storage: Pick<DurableObjectStorage, 'get' | 'put' | 'delete' | 'list'>;
  blockConcurrencyWhile<T>(f: () => Promise<T>): Promise<T>;
  freshWebAdmin(token: string): Promise<boolean>;
  /** 이 관리 토큰이 살아 있으면 그것 하나만 지운다 (다른 관리 토큰·다른 기기는 그대로) */
  revokeAdmin(token: string): Promise<void>;
  seatPresence(code: string): Promise<Presence>;
  schedule(t: number): Promise<void>;
  /** 세션이 로그아웃·밀려남으로 끝났을 때 (해시 주인들) — 그 세션의 알림 구독 정리. 실패해도 세션 처리는 그대로 */
  ended?(owners: string[]): Promise<void>;
  /** 오류 note 중 그대로 보여도 되는 고정 문구 (준비 서비스의 PREP_*) */
  fixedNotes: readonly string[];
  diagnostics?(lab: Lab, seat: Seat, at: number): Promise<SeatDiagnostics>;
  trialOnly?(id: string): Promise<boolean>;
  delivery?(id: string): Promise<TerminalDeliveryView[]>;
}

export interface TeacherSeatView {
  n: number; who: string; hand: number | null; opened: number | null;
  presence: { state: Presence['state']; idleSec: number | null; lastSeen: number | null };
  setup: { state: 'running' | 'ok' | 'error'; note: string } | null;
  error: boolean;
  preparation: PreparationView;
  diagnostics: SeatDiagnostics;
  delivery: { status: TerminalDeliveryView['status']; at: number | null };
}
export interface TeacherLabView { id: string; name: string; expiresAt: number; ending: boolean; seats: TeacherSeatView[] }

const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : null);

/** 보기 전용 수업 하나: 허용 목록 필드만 새로 만든다 (자리 코드·라벨·샌드박스 id·세션 id·미리보기·오류 원문·공유 설정 없음) */
export function teacherLabView(lab: Lab, pres: Presence[], fixedNotes: readonly string[]): TeacherLabView {
  return {
    id: String(lab.id), name: String(lab.name ?? ''), expiresAt: lab.expiresAt, ending: !!lab.endRetry,
    seats: lab.seats.slice(0, SEATS_MAX).map((x, i) => {
      const p = pres[i] ?? { state: 'none' };
      const st = x.setup?.state;
      return {
        n: x.n, who: typeof x.who === 'string' ? x.who : '', hand: num(x.hand), opened: num(x.opened),
        presence: { state: p.state, idleSec: num(p.idleSec), lastSeen: num(p.lastSeen) },
        setup: st === 'running' || st === 'ok' || st === 'error'
          ? { state: st, note: st === 'error' ? (fixedNotes.includes(x.setup!.note) ? x.setup!.note : NOTE_FAILED) : '' }
          : null,
        error: !!x.error,
        preparation: { state: x.error ? 'error' : 'unknown', at: null },
        diagnostics: emptyDiagnostics(),
        delivery: { status: 'unknown', at: null },
      };
    }),
  };
}

export class LabTeacherService {
  constructor(private d: LabTeacherDeps, private prefix = TEACHER_PREFIX) {}
  private get s() { return this.d.storage; }

  private async key(token: string) {
    return `${this.prefix}${await sha(token)}`;
  }

  /** 살아 있는 세션 기록 또는 null. 읽기만 한다 (만료를 늘리지 않는다) */
  private async live(token: unknown) {
    if (typeof token !== 'string' || !TEACHER_TOKEN.test(token)) return null;
    const t = await this.s.get<TeacherTok>(await this.key(token));
    return t && t.expiresAt > now() ? t : null;
  }

  /** 보기 세션. 방금 웹에서 탭한 관리 토큰만 (CLI 토큰·오래된 토큰·보기 세션으로는 못 만든다). 원문은 Worker 가 쿠키로만 내보낸다.
   *  prior(이 기기가 보낸 지금 쿠키)가 있으면 새로 만들지 않고 그 세션을 그대로 돌려준다 — 같은 토큰·같은 createdAt/expiresAt (다시 확인해도 8시간은 늘지 않는다).
   *  prior 가 지워졌거나(로그아웃·상한) 만료됐으면 401 — 그 쿠키를 근거로 새 세션을 만들지 않는다 (Worker 가 쿠키를 지운다).
   *  쿠키가 없을 때만 새 세션을 만들고, 만든 관리 토큰의 해시(issuedBy)를 붙인다. 그대로 쓰는 세션은 해시 주인·만료가 같아 알림 구독도 그대로 */
  async mint(adminToken: string, prior?: string): Promise<{ token: string; expiresAt: number } | Fail> {
    const stale = fail(403, '관리 로그인 후 3분이 지났습니다. 키로 다시 로그인하세요.');
    if (!(await this.d.freshWebAdmin(adminToken))) return stale;
    const issuedBy = await sha(adminToken);
    const token = prior ?? rand(24);
    const key = await this.key(token);
    const done = await this.d.blockConcurrencyWhile(async (): Promise<{ rec: TeacherTok; drop: string[] } | Fail> => {
      // 줄 서 있는 동안 3분이 지났거나 관리 토큰이 없어졌을 수 있다(로그아웃 포함) — 쓰기 바로 앞에서 다시 본다 (통과 못 하면 아무것도 지우지 않는다)
      if (!(await this.d.freshWebAdmin(adminToken))) return stale;
      if (prior !== undefined) {
        const t = await this.live(prior);
        return t ? { rec: t, drop: [] } : fail(401, '이 기기의 강사 보기 세션이 끝났습니다 (만료됐거나 로그아웃됨). 보안 키로 다시 확인하면 새로 엽니다.');
      }
      const all = await this.s.list<TeacherTok>({ prefix: this.prefix });
      const at = now(); // 실제로 허가된 시각
      const r: TeacherTok = { createdAt: at, expiresAt: at + TEACHER_TTL, issuedBy };
      // 만료된 것은 지우고, 살아 있는 것이 상한이면 가장 오래된 것부터 (새 것 자리 하나를 비운다)
      const live: [string, TeacherTok][] = [];
      const dead: string[] = [];
      for (const [k, v] of all) if (v.expiresAt > at) live.push([k, v]); else dead.push(k);
      live.sort((a, b) => a[1].createdAt - b[1].createdAt);
      const drop = [...dead, ...live.slice(0, Math.max(0, live.length - (TEACHER_MAX_LIVE - 1))).map(([k]) => k)];
      if (drop.length) await this.s.delete(drop);
      await this.s.put(key, r);
      return { rec: r, drop };
    });
    if ('error' in done) return done;
    const { rec, drop } = done;
    if (drop.length) await this.d.ended?.(drop.map((k) => k.slice(this.prefix.length)))?.catch(() => {});
    if (prior === undefined) await this.d.schedule(rec.expiresAt);
    return { token, expiresAt: rec.expiresAt };
  }

  /** 알림 서비스용 좁은 확인: 살아 있는 세션의 해시 주인과 고정 만료 (HTTP 로 열지 않는다, 읽기만) */
  async owner(token: unknown): Promise<{ owner: string; expiresAt: number } | null> {
    if (typeof token !== 'string' || !TEACHER_TOKEN.test(token)) return null;
    const owner = await sha(token);
    const t = await this.s.get<TeacherTok>(`${this.prefix}${owner}`);
    return t && t.expiresAt > now() ? { owner, expiresAt: t.expiresAt } : null;
  }

  /** 보기 전용 상태. 쿠키 토큰만 — 끝난 수업은 빼고, 끝내는 중(재시도)인 수업은 ending 표시만 */
  async status(token: string) {
    const t = await this.live(token);
    if (!t) return fail(401, '강사 보기 세션이 만료됐습니다.');
    const at = now();
    const labs = [...(await this.s.list<Lab>({ prefix: 'lab:' })).values()]
      .filter((l) => l && Array.isArray(l.seats) && l.expiresAt > at)
      .sort((a, b) => b.createdAt - a.createdAt);
    const views: TeacherLabView[] = [];
    for (const lab of labs) {
      if (await this.d.trialOnly?.(lab.id)) continue;
      const pres = await Promise.all(lab.seats.slice(0, SEATS_MAX).map((x) => this.d.seatPresence(x.code)));
      const view = teacherLabView(lab, pres, this.d.fixedNotes);
      const delivery = await this.d.delivery?.(lab.id) ?? [];
      for (const seat of view.seats) {
        const row = delivery.find(r => r.n === seat.n);
        if (row && ['none','pending','sent','unknown','error','skipped'].includes(row.status) && (row.at === null || (typeof row.at === 'number' && Number.isFinite(row.at) && row.at >= 0 && row.at <= now()))) seat.delivery = { status: row.status, at: row.at };
      }
      await Promise.all(lab.seats.slice(0, SEATS_MAX).map(async (seat, i) => {
        view.seats[i].preparation = preparationView(lab, seat, await this.s.get(`labprep:${seat.code}`), at);
        view.seats[i].diagnostics = await this.d.diagnostics?.(lab, seat, at) ?? emptyDiagnostics();
      }));
      views.push(view);
    }
    return { now: at, expiresAt: t.expiresAt, labs: views };
  }

  /** 이 기기의 보기 세션(쿠키)을 지운다. adminToken(이 화면이 메모리에 들고 있던 관리 토큰)을 함께 내면 그 관리 토큰 하나와 그 토큰으로 만든
   *  보기 세션도 지운다 — 응답이 늦게 와 로그아웃 뒤에 구워질 쿠키까지. 만들기와 같은 직렬 구역이라 만들기가 먼저면 그 기록을 지우고,
   *  로그아웃이 먼저면 만들기의 재확인(관리 토큰 없음)이 막는다. 다른 관리 토큰·그 토큰으로 만든 다른 기기 세션은 그대로. 없거나 틀린 토큰이어도 ok.
   *  지운 해시 주인 전부(이 쿠키 + issuedBy 가 같은 것)의 알림 구독도 정리한다 */
  async logout(token: unknown, adminToken?: unknown) {
    const own = typeof token === 'string' && TEACHER_TOKEN.test(token) ? await this.key(token) : null;
    // 관리 토큰도 rand(24) — 보기 토큰과 같은 모양
    const admin = typeof adminToken === 'string' && TEACHER_TOKEN.test(adminToken) ? adminToken : null;
    const by = admin && await sha(admin);
    const drop = await this.d.blockConcurrencyWhile(async () => {
      const drop = own ? [own] : [];
      if (admin) {
        await this.d.revokeAdmin(admin);
        for (const [k, v] of await this.s.list<TeacherTok>({ prefix: this.prefix })) if (v.issuedBy === by && k !== own) drop.push(k);
      }
      if (drop.length) await this.s.delete(drop);
      return drop;
    });
    if (drop.length) await this.d.ended?.(drop.map((k) => k.slice(this.prefix.length)))?.catch(() => {});
    return { ok: true as const };
  }
}

async function sha(s: string) {
  return isoBase64URL.fromBuffer(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))));
}
