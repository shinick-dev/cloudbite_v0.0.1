// 공부방 입장 시간 재기 (P1 계측). 정한 이름의 숫자 길이(ms)만 — 자리 코드·샌드박스 id·주소·토큰·오류 문구는 담지 않는다.
// labJoin 은 성공 결과(ready·starting)에만 labTiming 을 붙이고, 입장 호스트가 공개 JSON 을 만들기 전에 떼어 Server-Timing 헤더로만 보낸다.
// 이 모듈은 기록·전송하지 않는다 (응답 헤더 하나뿐). prep_* 숫자 관측은 준비 일 기록에서 온다. 실패 응답은 그대로.

// total은 이 입장 요청, prep_*는 함께 기다리는 준비 일의 관측 시간(원격 RTT 아님).
export const PREP_TIMING_PHASES = ['prep_queue', 'prep_wait', 'prep_elapsed', 'prep_sandbox', 'prep_wake', 'prep_materials', 'prep_health', 'prep_start'] as const;
export type PrepTimingPhase = (typeof PREP_TIMING_PHASES)[number];
export type PrepTiming = Partial<Record<PrepTimingPhase, number>>;
export const LAB_TIMING_PHASES = ['sandbox', 'materials', 'health', 'start', 'total', ...PREP_TIMING_PHASES] as const;
export type LabTimingPhase = (typeof LAB_TIMING_PHASES)[number];
export type LabTiming = Partial<Record<LabTimingPhase, number>>;

const MAX_MS = 10 * 60e3; // 이보다 길면 이 값으로 (헤더 길이 고정)

/** 유한한 숫자만 → 0..MAX_MS 정수 ms. 아니면 null */
export function labDur(x: unknown): number | null {
  if (typeof x !== 'number' || !Number.isFinite(x)) return null;
  return Math.min(MAX_MS, Math.max(0, Math.round(x)));
}

/** 정한 단계 이름의 길이만 남긴다 (모르는 키·숫자 아닌 값은 버린다) */
export function labTimingClean(x: unknown): LabTiming {
  const out: LabTiming = {};
  if (!x || typeof x !== 'object') return out;
  for (const k of LAB_TIMING_PHASES) {
    const d = Object.hasOwn(x, k) ? labDur((x as Record<string, unknown>)[k]) : null;
    if (d !== null) out[k] = d;
  }
  return out;
}

/** labJoin 안에서 쓰는 시계. await 를 감싸지 않는다 — 앞뒤로 시각만 읽으므로 순서·권한·실패 처리는 그대로 */
export function labTimer(clock: () => number = Date.now) {
  const t0 = clock();
  const d: LabTiming = {};
  return {
    now: clock,
    add(k: LabTimingPhase, from: number) { d[k] = (d[k] ?? 0) + (clock() - from); },
    done(): LabTiming { return labTimingClean({ ...d, total: clock() - t0 }); },
  };
}
export type LabTimer = ReturnType<typeof labTimer>;

/** 성공 결과에 붙이기 (입장 호스트가 떼어 낸다) */
export function withLabTiming<T extends object>(r: T, t: LabTimer, prep?: PrepTiming) {
  const shared: PrepTiming = {};
  for (const k of PREP_TIMING_PHASES) {
    const d = prep && Object.hasOwn(prep, k) ? labDur(prep[k]) : null;
    if (d !== null) shared[k] = d;
  }
  return { ...r, labTiming: labTimingClean({ ...shared, ...t.done() }) };
}

/** Server-Timing 값: 정한 이름 + 숫자만 */
export const serverTiming = (t: LabTiming) =>
  LAB_TIMING_PHASES.filter((k) => t[k] !== undefined).map((k) => `${k};dur=${t[k]}`).join(', ');

/** 결과에서 labTiming 을 떼고(공개 JSON 에 안 나가게) Server-Timing 값을 만든다. 값이 없으면 '' */
export function takeLabTiming<T extends object>(r: T): { body: Omit<T, 'labTiming'>; header: string } {
  const { labTiming, ...body } = r as T & { labTiming?: unknown };
  return { body: body as Omit<T, 'labTiming'>, header: serverTiming(labTimingClean(labTiming)) };
}

/** 자리 호스트 HTML 문서: upstream 응답(헤더)까지 걸린 시간 */
export const upstreamTiming = (ms: unknown) => {
  const d = labDur(ms);
  return d === null ? '' : `upstream;dur=${d}`;
};
