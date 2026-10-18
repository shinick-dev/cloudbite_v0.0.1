// 준비 일 하나의 관측 시간(ms)만. 호출은 응답·오류·시간 제한까지 기다린 길이의 합이며 원격 RTT가 아니다.
// queue: 첫 실행 전, wait: 실행 사이 실제 쉼, elapsed: 첫 실행부터(쉼·서버 재시작 포함).
// 다시 뜨기 전 끝나 저장된 표본만 이어 쓴다. 중간에 죽은 호출·예전 일의 빠진 단계는 추정하거나 0으로 채우지 않는다.
import { labDur, PREP_TIMING_PHASES, type PrepTimingPhase, type PrepTiming } from './lab-timing';
export { PREP_TIMING_PHASES, type PrepTimingPhase, type PrepTiming } from './lab-timing';

export type PrepSamplePhase = Exclude<PrepTimingPhase, 'prep_elapsed'>;
const SAMPLE_PHASES = PREP_TIMING_PHASES.filter((k) => k !== 'prep_elapsed');
export const PREP_TIMING_SAMPLES = 128; // 단계마다 표본 수 상한 — 배열·호출 설명은 저장하지 않는다
export const PREP_TIMING_KEEP = 24 * 3600e3;
export interface PrepMeasurements {
  at: number;
  values: PrepTiming;
  counts: Partial<Record<PrepSamplePhase, number>>;
  waitAt?: number;
}

export function prepTimingNew(at: number): PrepMeasurements { return { at, values: {}, counts: {} }; }

/** 저장·내보내기 모두 정한 이름과 숫자만. 측정 안 한 값은 없음. */
export function prepTimingClean(x: unknown): PrepTiming {
  const out: PrepTiming = {};
  if (!x || typeof x !== 'object') return out;
  for (const k of PREP_TIMING_PHASES) {
    const v = Object.hasOwn(x, k) ? labDur((x as Record<string, unknown>)[k]) : null;
    if (v !== null) out[k] = v;
  }
  return out;
}

const bag = (x: unknown) => !!x && typeof x === 'object' && !Array.isArray(x);
const valid = (m: PrepMeasurements | undefined, now: number): m is PrepMeasurements =>
  !!m && bag(m.values) && bag(m.counts) && Number.isFinite(m.at) && Number.isFinite(now) && now >= m.at && now - m.at <= PREP_TIMING_KEEP;
export const prepTimingExpired = (m: PrepMeasurements | undefined, now: number) => !!m && !valid(m, now);

/** 음수·비유한 관측은 버린다. 합·표본 수·키 수 모두 상한이 있다. */
export function prepTimingAdd(m: PrepMeasurements | undefined, phase: PrepSamplePhase, ms: number, now: number) {
  if (!valid(m, now) || !SAMPLE_PHASES.includes(phase) || !Number.isFinite(ms) || ms < 0) return;
  const count = m.counts[phase] ?? 0;
  if (!Number.isInteger(count) || count < 0 || count >= PREP_TIMING_SAMPLES) return;
  m.counts[phase] = count + 1;
  m.values[phase] = labDur((m.values[phase] ?? 0) + ms)!;
}

export function prepTimingResume(m: PrepMeasurements | undefined, now: number) {
  if (!m) return;
  if (m.waitAt !== undefined) prepTimingAdd(m, 'prep_wait', now - m.waitAt, now);
  delete m.waitAt;
}

/** 실행 전 queue는 현재까지의 실제 대기. elapsed는 요청 total과 별개의 공유 일 벽시계 시간. */
export function prepTimingView(m: PrepMeasurements | undefined, started: number | undefined, ended: number | undefined, now: number): PrepTiming {
  if (!valid(m, now)) return {};
  const out = prepTimingClean(m.values);
  if (started === undefined) out.prep_queue = labDur(now - m.at)!;
  else if (Number.isFinite(started) && started >= m.at && started <= now && (ended === undefined || (Number.isFinite(ended) && ended >= started && ended <= now))) out.prep_elapsed = labDur((ended ?? now) - started)!;
  if (m.waitAt !== undefined && Number.isFinite(m.waitAt) && m.waitAt <= now && (m.counts.prep_wait ?? 0) < PREP_TIMING_SAMPLES) out.prep_wait = labDur((out.prep_wait ?? 0) + now - m.waitAt)!;
  return out;
}
