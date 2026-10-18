// 강사 화면 공유 (Cloudflare Realtime SFU) — State(DO) 안에서만 쓰는 서비스. Worker 에서 내보내지 않는다 (RPC 로 안 열린다).
// State 하나에 하나씩 만들고, 저장소·권한 확인·알람 예약·감사 기록은 State 가 넘겨 준 것만 쓴다 (만들 때 I/O 없음).
// 저장 키·흐름 설명은 state.ts 의 '강사 화면 공유' 절.
import { isoBase64URL } from '@simplewebauthn/server/helpers';
import type { Env, Fail } from './state';

const SFU_API = 'https://rtc.live.cloudflare.com/v1';
const SCR_STALE = 60e3;          // 시작하고 이만큼 지났는데 강사 트랙이 SFU 에 없으면(탭이 멈추지 못하고 닫힘) 멈춤으로 바꾼다
const SCR_PULLS_PER_SEAT = 4;    // 자리 하나의 받기 세션 (기다림 + 연결됨). 넘치면 가장 오래된 연결을 닫고(트랙까지) 새로
const SCR_PENDING_PER_SEAT = 2;  // 그중 answer 를 기다리는 것 (넘치면 429 — SFU 를 부르기 전에 거절)
export const SCR_ANSWER_TTL = 30e3; // offer 를 준 뒤 answer 를 이만큼만 기다린다 (지나면 알람이 트랙을 닫는다)
const SCR_BUSY_MAX = 45e3;       // SFU 호출 중(busy) 표시가 이보다 오래면 그 요청은 죽은 것 (호출 하나 10초 · 받기는 둘)
const SCR_CLOSE_TRIES = 3;
interface ScrTrack { mid: string; trackName: string }
interface LabScreen { sessionId?: string; tracks: ScrTrack[]; startedAt?: number; v: number; starting?: string } // sessionId 가 없으면 멈춤
// 받기 세션: SFU 를 부르기 전에 먼저 적고(reserving), 세션 id·remote mid 를 받는 즉시 적는다. 닫는 쪽은 기록을 지운 쪽 하나뿐
interface ScrPull {
  code: string; lab: string; at: number; v: number;
  state: 'reserving' | 'offered' | 'live';
  exp?: number;        // reserving·offered: 이때까지 answer 가 없으면 닫는다
  busy?: number;       // SFU 호출 중 (그 요청이 끝나고 닫는다)
  closing?: boolean;   // 호출 중에 멈춤·끝내기·밀려남 → 호출한 요청이 끝나는 대로 닫는다
  sessionId?: string; mids?: string[];
}
interface ScrClose { sessionId: string; mids?: string[]; tries: number; next: number } // mids 가 없으면 세션을 조회해 찾는다
interface SfuTracks {
  sessionDescription?: { type: string; sdp: string };
  tracks?: { mid?: string; trackName?: string; errorCode?: string; errorDescription?: string }[];
  requiresImmediateRenegotiation?: boolean;
}
const okSdp = (x: unknown): x is string => typeof x === 'string' && x.startsWith('v=0') && x.length < 100_000;
function scrTracks(x: unknown): ScrTrack[] | null {
  if (!Array.isArray(x) || x.length < 1 || x.length > 2) return null;
  const out = x.map((t) => ({ mid: String(t?.mid ?? ''), trackName: String(t?.trackName ?? '') }));
  return out.every((t) => /^[\w-]{1,16}$/.test(t.mid) && /^[\w-]{1,64}$/.test(t.trackName)) ? out : null;
}

// state.ts 의 같은 이름 도우미와 똑같다 (state.ts 를 런타임에 들여오지 않으려고 따로 둔다)
const now = () => Date.now();
const rand = (n: number) => isoBase64URL.fromBuffer(crypto.getRandomValues(new Uint8Array(n)));
const fail = (status: number, error: string): Fail => ({ status, error });
const isFail = (x: unknown): x is Fail => typeof x === 'object' && x !== null && 'error' in x && 'status' in x;

/** 이 서비스가 보는 수업 필드 (State 의 Lab 이 그대로 맞는다) */
interface ScrLab { id: string; name: string; expiresAt: number; endRetry?: number }

// start·pull 의 판단만 떼어 둔 동기 도우미 (저장소·SFU 호출과 다시 읽기는 공개 메서드가 그대로 한다)
const PULL_CANCELED = '강사 화면 연결이 취소됐습니다. 다시 시도합니다.';
const labEnded = (lab: ScrLab | undefined) => !lab || !!lab.endRetry || lab.expiresAt <= now();
const trackError = (r: SfuTracks | Fail) => isFail(r) ? undefined : r.tracks?.find((t) => t.errorCode);

/** 강사 트랙 올리기 응답이 쓸 만하고 수업이 아직 살아 있으면 answer, 아니면 null (now 는 수업 확인에서만 부른다) */
function startAnswer(r: SfuTracks | Fail, cur: ScrLab | undefined) {
  if (isFail(r) || trackError(r) || r.sessionDescription?.type !== 'answer' || labEnded(cur)) return null;
  return { sdp: r.sessionDescription!.sdp };
}

/** startAnswer 가 null 일 때 돌려줄 오류: SFU 오류 > 수업 끝남 > 트랙 오류·응답 형식 */
function startFailure(r: SfuTracks | Fail, cur: ScrLab | undefined): Fail {
  if (isFail(r)) return r;
  if (labEnded(cur)) return fail(410, '수업이 끝났습니다.');
  const bad = trackError(r);
  return fail(502, `화면 공유 서버가 화면을 받지 않았습니다: ${bad?.errorDescription ?? bad?.errorCode ?? '응답 형식'}`);
}

/** 자리 잡기: 기다리는 것이 차면 429, 아니면 새 자리를 위해 닫을 가장 오래된 연결들의 sid (mine 은 at 순) */
function pullEvictions(mine: [string, ScrPull][]): string[] | Fail {
  if (mine.filter(([, p]) => p.state !== 'live').length >= SCR_PENDING_PER_SEAT) return fail(429, '강사 화면 연결을 이미 기다리는 중입니다. 잠시 뒤 다시 시도합니다.');
  const live = mine.filter(([, p]) => p.state === 'live');
  return live.slice(0, Math.max(0, mine.length - SCR_PULLS_PER_SEAT + 1)).map(([k]) => k.slice(5));
}

/** 받기 세션을 만든 뒤: SFU 오류 > 세션 id 없음 > 기록이 지워졌거나 닫는 중. 괜찮으면 세션 id 를 붙인 기록 */
function pullOpened(ss: { sessionId?: string } | Fail, p: ScrPull | undefined): { pull: ScrPull; sessionId: string } | Fail {
  if (isFail(ss)) return ss;
  if (!ss.sessionId) return fail(502, '화면 공유 서버가 세션을 만들지 않았습니다.');
  if (!p || p.closing) return fail(409, PULL_CANCELED);
  return { pull: { ...p, sessionId: ss.sessionId }, sessionId: ss.sessionId };
}

/** SFU 가 준 remote mid (성공·실패와 상관없이). 응답을 못 받았으면 undefined → 닫을 때 세션을 조회 */
const pulledMids = (r: SfuTracks | Fail) => isFail(r) ? undefined : (r.tracks ?? []).filter((x) => x.mid !== undefined && x.mid !== null && x.mid !== '').map((x) => String(x.mid));

/** 강사 트랙 받기 응답이 offer 이고 닫는 중이 아니면 offer, 아니면 null */
function pullOffer(r: SfuTracks | Fail, p: ScrPull) {
  if (isFail(r) || trackError(r) || r.sessionDescription?.type !== 'offer' || p.closing) return null;
  return { sdp: r.sessionDescription!.sdp };
}

/** 강사 탭이 멈추지 못하고 닫혔는가: 받던 그 공유가 아직 켜져 있고 시작한 지 SCR_STALE 이 지났다 (시작 직후엔 아직 연결 중일 수 있다) */
function teacherStale(cur: LabScreen | undefined, sessionId: string, env: LabScreenDeps['env']): cur is LabScreen & { sessionId: string } {
  return cur?.sessionId === sessionId && now() - (cur!.startedAt ?? 0) > (env.ALLOW_SHORT_TTL === '1' ? 0 : SCR_STALE);
}

/** State 가 넘겨 주는 것. 콜백은 State 의 메서드를 그대로 부른다 (receiver 는 State) */
export interface LabScreenDeps {
  storage: Pick<DurableObjectStorage, 'get' | 'put' | 'delete' | 'list'>;
  env: Pick<Env, 'REALTIME_APP_ID' | 'REALTIME_APP_TOKEN' | 'REALTIME_API' | 'ALLOW_SHORT_TTL'>;
  waitUntil(p: Promise<unknown>): void;
  checkAdmin(token: string): Promise<boolean>;
  seatOf(code: string): Promise<{ lab: ScrLab } | Fail>;
  schedule(t: number): Promise<void>;
  audit(event: string, sid: string | null, ip: string | null, detail?: string): Promise<void>;
  answerTtl(): number;
}

export class LabScreenService {
  private closing = new Set<string>();
  constructor(private d: LabScreenDeps) {}
  private get s() { return this.d.storage; }

  /** 강사: 화면 공유 시작. offer + 올릴 트랙(mid·이름) → SFU answer. 다른 탭에서 하던 공유는 끊고 바꾼다 */
  async start(token: string, id: string, sdp: unknown, tracks: unknown) {
    if (!(await this.d.checkAdmin(token))) return fail(401, '관리 세션이 만료됐습니다.');
    const tr = scrTracks(tracks);
    if (!okSdp(sdp) || !tr) return fail(400, '화면 공유 요청 형식이 올바르지 않습니다 (sdp, tracks 1~2개).');
    const lab = await this.s.get<ScrLab>(`lab:${id}`);
    if (!lab) return fail(404, '없는 수업입니다.');
    if (labEnded(lab)) return fail(410, '수업이 끝났습니다.');
    const previous = await this.s.get<LabScreen>(`scr:${id}`), intent = rand(16);
    await this.s.put(`scr:${id}`, { ...(previous ?? { tracks: [], v: 0 }), starting: intent } satisfies LabScreen);
    const reset = async () => {
      const current = await this.s.get<LabScreen>(`scr:${id}`);
      if (current?.starting === intent) { const { starting: _, ...rest } = current; await this.s.put(`scr:${id}`, rest); }
    };
    const ss = await this.sfu<{ sessionId?: string }>('POST', '/sessions/new');
    if (isFail(ss)) { await reset(); return ss; }
    const sessionId = ss.sessionId;
    if (!sessionId) { await reset(); return fail(502, '화면 공유 서버가 세션을 만들지 않았습니다.'); }
    const r = await this.sfu<SfuTracks>('POST', `/sessions/${sessionId}/tracks/new`, {
      sessionDescription: { type: 'offer', sdp }, tracks: tr.map((t) => ({ location: 'local', ...t })),
    });
    const cur = await this.s.get<ScrLab>(`lab:${id}`);
    const answer = startAnswer(r, cur);
    if (!answer) {
      // 올린 트랙(mid 는 강사가 준 것)을 닫는다 — 실패 응답이어도 일부가 생겼을 수 있다
      await this.closeQueue(`s:${sessionId}`, { sessionId, mids: tr.map((t) => t.mid) });
      await reset();
      return startFailure(r, cur);
    }
    const authorized = await this.d.checkAdmin(token);
    const prev = await this.s.get<LabScreen>(`scr:${id}`);
    if (!authorized || prev?.starting !== intent) {
      await this.closeQueue(`s:${sessionId}`, { sessionId, mids: tr.map(t => t.mid) });
      await reset();
      return fail(409, '화면 공유 시작이 취소됐거나 권한이 끝났습니다. 다시 확인하세요.');
    }
    const scr: LabScreen = { sessionId, tracks: tr, startedAt: now(), v: (prev?.v ?? 0) + 1 };
    await this.s.put(`scr:${id}`, scr);
    if (prev?.sessionId) await this.closeQueue(`s:${prev.sessionId}`, { sessionId: prev.sessionId, mids: prev.tracks.map((t) => t.mid) });
    await this.pullsClear(id);
    await this.d.audit('lab-screen', null, null, `${lab.name} 시작`);
    return { sdp: answer.sdp, v: scr.v, startedAt: scr.startedAt };
  }

  /** 강사: 화면 공유 멈춤 (이미 멈춰 있으면 그대로). 참가자는 다음 확인(10초)에 창을 닫는다 */
  async stop(token: string, id: string) {
    if (!(await this.d.checkAdmin(token))) return fail(401, '관리 세션이 만료됐습니다.');
    const lab = await this.s.get<ScrLab>(`lab:${id}`);
    const scr = await this.s.get<LabScreen>(`scr:${id}`);
    if (!lab && !scr) return fail(404, '없는 수업입니다.');
    if (!scr?.sessionId) {
      if (scr?.starting) await this.s.put(`scr:${id}`, { tracks: [], v: scr.v + 1 } satisfies LabScreen);
      await this.pullsClear(id); return { ok: true, v: scr?.starting ? scr.v + 1 : scr?.v ?? 0 };
    }
    const v = scr.v + 1;
    await this.s.put(`scr:${id}`, { tracks: [], v } satisfies LabScreen);
    await this.closeQueue(`s:${scr.sessionId}`, { sessionId: scr.sessionId, mids: scr.tracks.map((t) => t.mid) });
    await this.pullsClear(id);
    await this.d.audit('lab-screen', null, null, `${lab?.name ?? id} 멈춤`);
    return { ok: true, v };
  }

  /** 강사 /lab: 수업별 공유 상태 (다른 탭이나 닫힌 탭의 공유가 남아 있는지) */
  async list(token: string) {
    if (!(await this.d.checkAdmin(token))) return fail(401, '관리 세션이 만료됐습니다.');
    const screens: Record<string, { on: boolean; startedAt?: number; v: number }> = {};
    for (const [k, x] of await this.s.list<LabScreen>({ prefix: 'scr:' })) screens[k.slice(4)] = { on: !!x.sessionId, startedAt: x.sessionId ? x.startedAt : undefined, v: x.v };
    return { screens, now: now() };
  }

  /** 참가자 막대가 10초(숨은 탭 30초)마다 묻는다. 저장소에 쓰지 않는다 */
  async state(code: string) {
    const got = await this.d.seatOf(code);
    if (isFail(got)) return got;
    const scr = await this.s.get<LabScreen>(`scr:${got.lab.id}`);
    return scr?.sessionId ? { on: true, v: scr.v, title: '강사 화면' } : { on: false, v: scr?.v ?? 0 };
  }

  private async seatPulls(code: string) {
    return [...(await this.s.list<ScrPull>({ prefix: 'scrp:' }))].filter(([, p]) => p.code === code).sort((a, b) => a[1].at - b[1].at);
  }

  /** 모임지기가 닫거나 로그아웃한 수신 연결 정리 (다른 수신자·송출은 유지). */
  async releaseReceiver(code: string, prefix = false) {
    for (const [k, p] of await this.s.list<ScrPull>({ prefix: 'scrp:' })) {
      if (prefix ? p.code.startsWith(code) : p.code === code) await this.closePull(k.slice(5));
    }
  }

  /** 참가자: 받기 세션을 만들고 강사 트랙을 remote 로 요청 → SFU 의 offer. 돌려주는 sid 는 우리 쪽 id (SFU 세션 id 아님) */
  async pull(code: string) {
    const got = await this.d.seatOf(code);
    if (isFail(got)) return got;
    const { lab } = got;
    const scr = await this.s.get<LabScreen>(`scr:${lab.id}`);
    if (!scr?.sessionId) return fail(409, '강사가 화면을 공유하고 있지 않습니다.');
    // 자리 잡기 (SFU 를 부르기 전에): 기다리는 것이 차면 거절, 전체가 차면 가장 오래된 연결부터 닫는다
    const evict = pullEvictions(await this.seatPulls(code));
    if (isFail(evict)) return evict;
    for (const old of evict) await this.closePull(old);
    const sid = rand(16), k = `scrp:${sid}`, t = now();
    await this.s.put(k, { code, lab: lab.id, at: t, v: scr.v, state: 'reserving', exp: t + this.d.answerTtl(), busy: t } satisfies ScrPull);
    await this.d.schedule(t + SCR_BUSY_MAX);

    const ss = await this.sfu<{ sessionId?: string }>('POST', '/sessions/new');
    const reserved = await this.s.get<ScrPull>(k);
    const opened = pullOpened(ss, reserved);
    if (isFail(opened)) {
      // 트랙이 아직 없다 — 세션만 있으면 SFU 가 스스로 정리한다. 기록만 지운다
      if (reserved) await this.s.delete(k);
      return opened;
    }
    const { sessionId } = opened;
    await this.s.put(k, opened.pull);
    const r = await this.sfu<SfuTracks>('POST', `/sessions/${sessionId}/tracks/new`, {
      tracks: scr.tracks.map((x) => ({ location: 'remote', sessionId: scr.sessionId, trackName: x.trackName })),
    });
    // 받은 mid 는 성공·실패와 상관없이 바로 적는다 (응답을 못 받았으면 mid 를 모름 → 닫을 때 세션을 조회)
    const mids = pulledMids(r);
    const again = await this.s.get<ScrPull>(k);
    if (!again) return fail(409, PULL_CANCELED); // 지운 쪽이 닫았다
    const p: ScrPull = { ...again, mids };
    const offer = pullOffer(r, p);
    if (!offer) {
      await this.s.delete(k);
      await this.closeQueue(`p:${sid}`, { sessionId, mids });
      if (p.closing) return fail(409, PULL_CANCELED);
      if (isFail(r)) return r;
      // 강사 탭이 멈추지 못하고 닫혔다 → 멈춤으로 바꿔 참가자들이 계속 다시 시도하지 않게 (시작 직후엔 아직 연결 중일 수 있어 잠시 기다린다)
      const cur = trackError(r) ? await this.s.get<LabScreen>(`scr:${lab.id}`) : undefined;
      if (teacherStale(cur, scr.sessionId, this.d.env)) {
        await this.s.put(`scr:${lab.id}`, { tracks: [], v: cur.v + 1 } satisfies LabScreen);
        await this.closeQueue(`s:${cur.sessionId}`, { sessionId: cur.sessionId, mids: cur.tracks.map((x) => x.mid) });
        await this.pullsClear(lab.id);
      }
      return fail(409, '강사 화면에 연결하지 못했습니다. 잠시 뒤 다시 시도합니다.');
    }
    const exp = now() + this.d.answerTtl();
    await this.s.put(k, { ...p, state: 'offered', busy: undefined, exp } satisfies ScrPull);
    await this.d.schedule(exp);
    return { sid, sdp: offer.sdp, v: scr.v };
  }

  /** 참가자: SFU offer 에 대한 answer. 그 자리(쿠키)가 만든 받기 세션만, offer 뒤 30초 안에 한 번 */
  async answer(code: string, sid: unknown, sdp: unknown) {
    if (typeof sid !== 'string' || !/^[\w-]{8,64}$/.test(sid) || !okSdp(sdp)) return fail(400, '형식이 올바르지 않습니다.');
    const got = await this.d.seatOf(code);
    if (isFail(got)) return got;
    const k = `scrp:${sid}`;
    const p = await this.s.get<ScrPull>(k);
    if (!p) return fail(404, '받기 세션이 없습니다. 다시 연결합니다.');
    if (p.code !== code || p.lab !== got.lab.id) return fail(403, '이 자리의 받기 세션이 아닙니다.');
    if (p.state !== 'offered' || p.busy || p.closing || !p.sessionId) return fail(409, '받기 세션이 answer 를 기다리고 있지 않습니다.');
    if ((p.exp ?? 0) <= now()) { await this.closePull(sid); return fail(410, '강사 화면 연결 시간이 지났습니다. 다시 연결합니다.'); }
    await this.s.put(k, { ...p, busy: now() } satisfies ScrPull);
    const r = await this.sfu('PUT', `/sessions/${p.sessionId}/renegotiate`, { sessionDescription: { type: 'answer', sdp } });
    const q = await this.s.get<ScrPull>(k);
    if (!q) return fail(409, '강사 화면 연결이 취소됐습니다.');
    if (isFail(r) || q.closing) {
      await this.s.delete(k);
      await this.closeQueue(`p:${sid}`, { sessionId: q.sessionId!, mids: q.mids });
      return isFail(r) ? r : fail(409, '강사 화면 연결이 취소됐습니다.');
    }
    await this.s.put(k, { ...q, state: 'live', busy: undefined, exp: undefined } satisfies ScrPull);
    return { ok: true };
  }

  /** 받기 하나 닫기. SFU 호출 중이면 표시만 (호출한 요청이 끝나고 닫는다). force: 알람이 죽은 호출(busy 가 오래됨)을 정리할 때 */
  private async closePull(sid: string, force = false) {
    const k = `scrp:${sid}`;
    const p = await this.s.get<ScrPull>(k);
    if (!p) return;
    if (p.busy && !force && now() - p.busy < SCR_BUSY_MAX) {
      if (!p.closing) await this.s.put(k, { ...p, closing: true } satisfies ScrPull);
      return;
    }
    await this.s.delete(k);
    if (p.sessionId) await this.closeQueue(`p:${sid}`, { sessionId: p.sessionId, mids: p.mids });
  }

  /** 지금 저장소에 남은 발행. on 은 세션이 살아 있을 때만. 자리 조회는 하지 않는다 */
  async generation(id: string) {
    const scr = await this.s.get<LabScreen>(`scr:${id}`);
    return { on: !!scr?.sessionId, v: scr?.v ?? 0 };
  }

  /** 끝내기·만료: 공유 상태와 받기 세션 정리 (트랙 닫기는 scrq 로 한 번). expectV 가 있으면 그 세대만 지우고, 더 새 발행은 그대로 둔다 */
  async clear(labId: string, expectV?: number) {
    // 이 읽기·판단·삭제 사이에는 외부 I/O를 넣지 않는다. DO storage input gate가 다른 이벤트의 끼어들기를 막는다.
    // https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/
    const scr = await this.s.get<LabScreen>(`scr:${labId}`);
    if (expectV !== undefined && scr && scr.v !== expectV) return;
    if (scr) await this.s.delete(`scr:${labId}`);
    if (scr?.sessionId) await this.closeQueue(`s:${scr.sessionId}`, { sessionId: scr.sessionId, mids: scr.tracks.map((t) => t.mid) });
    await this.pullsClear(labId);
  }

  private async pullsClear(labId: string) {
    for (const [k, p] of await this.s.list<ScrPull>({ prefix: 'scrp:' })) if (p.lab === labId) await this.closePull(k.slice(5));
  }

  /** 닫을 트랙을 적고(이미 있으면 그대로) 바로 한 번 시도한다 (응답은 기다리지 않는다) */
  private async closeQueue(id: string, x: { sessionId: string; mids?: string[] }) {
    const k = `scrq:${id}`;
    if (await this.s.get(k)) return;
    await this.s.put(k, { sessionId: x.sessionId, mids: x.mids, tries: 0, next: now() } satisfies ScrClose);
    this.d.waitUntil(this.closeRun(id));
  }

  private async closeRun(id: string) {
    if (this.closing.has(id)) return;
    const k = `scrq:${id}`;
    const q = await this.s.get<ScrClose>(k);
    if (!q) return;
    this.closing.add(id);
    try {
      await this.s.put(k, { ...q, next: now() + 30e3 } satisfies ScrClose); // 도는 동안 알람이 또 집지 않게
      let mids = q.mids, ok = false;
      if (!mids) {
        // 트랙을 만들다 응답을 못 받았다: 세션의 트랙을 조회해 닫는다 (Realtime GET /sessions/<id>)
        const st = await this.sfu<{ tracks?: { mid?: string; status?: string }[] }>('GET', `/sessions/${q.sessionId}`);
        if (!isFail(st)) mids = (st.tracks ?? []).filter((t) => t.mid && t.status !== 'inactive').map((t) => String(t.mid));
      }
      if (mids && !mids.length) ok = true;
      else if (mids) ok = !isFail(await this.sfu('PUT', `/sessions/${q.sessionId}/tracks/close`, { tracks: mids.map((mid) => ({ mid })), force: true }));
      if (ok || q.tries + 1 >= SCR_CLOSE_TRIES) await this.s.delete(k);
      else {
        const next = now() + 30e3;
        await this.s.put(k, { ...q, mids, tries: q.tries + 1, next } satisfies ScrClose);
        await this.d.schedule(next);
      }
    } finally { this.closing.delete(id); }
  }

  /** 알람: 시간이 지난 받기·죽은 SFU 호출·끝난 수업의 받기를 닫고, 닫기 재시도. 다음 시각을 돌려준다 */
  async alarm(t: number) {
    let next = Infinity;
    const labs = new Map<string, ScrLab | undefined>();
    for (const [k, p] of await this.s.list<ScrPull>({ prefix: 'scrp:' })) {
      if (!labs.has(p.lab)) labs.set(p.lab, await this.s.get<ScrLab>(`lab:${p.lab}`));
      const lab = labs.get(p.lab);
      const gone = !lab || lab.endRetry || lab.expiresAt <= t;
      if (p.busy) {
        if (t - p.busy >= SCR_BUSY_MAX) await this.closePull(k.slice(5), true);
        else next = Math.min(next, p.busy + SCR_BUSY_MAX);
      } else if (gone || (p.state !== 'live' && (p.exp ?? 0) <= t)) await this.closePull(k.slice(5));
      else if (p.state !== 'live') next = Math.min(next, p.exp!);
    }
    for (const [k, q] of await this.s.list<ScrClose>({ prefix: 'scrq:' })) {
      if (q.next <= t) await this.closeRun(k.slice(5));
      else next = Math.min(next, q.next);
    }
    return next;
  }

  /** SFU HTTPS API. 비밀은 헤더로만, 오류 메시지는 한국어로 (참가자·강사가 읽는다) */
  private async sfu<T>(method: 'POST' | 'PUT' | 'GET', path: string, body?: unknown): Promise<T | Fail> {
    const app = this.d.env.REALTIME_APP_ID, tok = this.d.env.REALTIME_APP_TOKEN;
    if (!app || !tok) return fail(503, '화면 공유가 아직 설정되지 않았습니다 (REALTIME_APP_TOKEN). 운영자에게 알려주세요.');
    try {
      // sessions/new 는 본문 없이 보내야 한다 ('{}' 는 400)
      const r = await fetch(`${this.d.env.REALTIME_API || SFU_API}/apps/${app}${path}`, {
        method, signal: AbortSignal.timeout(10e3),
        headers: { Authorization: `Bearer ${tok}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const j = await r.json<T & { errorCode?: string; errorDescription?: string }>().catch(() => ({}) as T & { errorCode?: string; errorDescription?: string });
      if (!r.ok || j.errorCode) return fail(502, `화면 공유 서버 오류: ${String(j.errorDescription ?? j.errorCode ?? r.status).slice(0, 200)}`);
      return j;
    } catch (e) {
      return fail(502, `화면 공유 서버에 연결하지 못했습니다: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
