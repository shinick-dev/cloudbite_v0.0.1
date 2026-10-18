// 실습실 지연 합성(synthetic) 모델 — 오프라인·결정적·의존성 없음.
//   node tools/lab-latency-benchmark.mjs [--rtt=80] [--jitter=20] [--frame=16.7] [--samples=2000] [--seed=1]
//                                        [--interval=2500] [--server=150] [--ready-window=60000]
// 측정이 아니다: 브라우저·PTY·네트워크·공급자·저장소를 쓰지 않고, 주어진 숫자로 만든 가상 표본만 계산한다.
// 결과는 "이 가정이면 이렇게 된다" 일 뿐, 실제 참가자 지연이나 실제로 줄어든 시간의 증거가 아니다.
//
// 1) 입장 대기 폴링 간격 (cadence)
//    old   : 응답을 받은 뒤 interval 만큼 쉬고 다음 요청 (9d0b008 src/pages.ts 의 response + 2500ms).
//            마감은 요청을 시작하기 전에만 본다(시작 < 300000) — 마감에 걸치거나 넘어서 도착한 ready 도 받아들인다.
//    start : 입장 후보(gw-entry) 그대로 — 다음 시작 = max(이전 시작 + interval, 이전 응답 + 250ms), 동시에 한 요청만,
//            사용자 동작 한 번에 요청 최대 120번, 300초 뒤에는 요청을 시작하지 않고, ready 를 300000ms 에 또는 그 뒤에
//            보면(seen >= 300000) 입장 form 을 보내지 않는다.
//    자리가 ready 가 되는 시각 R 은 [0, readyWindow) 에서 고르고, 요청이 서버에 닿은 시각(시작 + rtt/2 + server)이
//    R 이상이면 그 응답에서 ready 를 본다. 두 방식은 같은 R·같은 요청별 지연(rtt + jitter + server)을 쓴다(짝 비교).
//    표본 하나씩 보면 start 가 늘 이기지는 않는다(요청 격자가 달라서) — 분포(p50·p95)로만 비교한다.
//    timeout: old 는 300초 안에 시작한 요청으로 ready 를 못 볼 때, start 는 그에 더해 120번을 다 쓰거나 300000ms 이상에 볼 때.
//    자료 경고 뒤 4초 대기·오류 뒤 다시 시도는 모델에 없다.
// 2) 키 입력 세 단계 — 각자 자기 경계로 계산하고 서로에게서 끌어내지 않는다.
//    keyToFrame    : 키 → 다음 로컬 프레임. 현재 P1 도구의 keyToFrame 이 근사하는 것. 왕복과 동시에 흐르므로 합에 넣지 않는다.
//    networkToEcho : 키 → (가상 왕복 rtt + jitter) → 권위 있는(서버 쪽) 터미널 에코가 브라우저에 도착.
//    echoToRender  : 에코 도착 → 그 다음 프레임.
//    keyToRender   = networkToEcho + echoToRender (겹치지 않고 이어진 두 구간).

import { pathToFileURL } from 'node:url';

export const MODEL = 'lab-latency-synthetic/1';
export const LABEL = 'SYNTHETIC MODEL — not live browser/PTY evidence, not a measured improvement';

export const STAGES = Object.freeze({
  keyToFrame: 'local: key event -> next animation frame (what P1 keyToFrame approximates; NOT terminal RTT)',
  networkToEcho: 'simulated: key -> network round trip (rtt + jitter) -> authoritative terminal echo arrives',
  echoToRender: 'local: echo arrival -> next animation frame',
  keyToRender: 'networkToEcho + echoToRender (keyToFrame runs concurrently and is not added)',
});

export const CADENCES = Object.freeze({
  old: 'next request starts after response + interval (9d0b008 src/pages.ts wake loop); deadline checked only before starting a request, so a ready seen at or after 300000ms is still accepted',
  start: 'request-start cadence: next start = max(prev start + interval, prev response + 250ms); one request in flight; max 120 attempts; no start at or after 300000ms; no submit when ready is seen at or after 300000ms',
});

// 이름 → [기본값, 최소, 최대, 정수만]
const SPEC = {
  rttMs: [80, 0, 10_000, false],
  jitterMs: [20, 0, 10_000, false],
  frameMs: [1000 / 60, 1, 1000, false],
  samples: [2000, 1, 10_000, true],
  seed: [1, 0, 0xffffffff, true],
  intervalMs: [2500, 250, 60_000, false],
  serverMs: [150, 0, 60_000, false],
  readyWindowMs: [60_000, 0, 300_000, false],
};
const CEILING_MS = 300_000;
export const RESPONSE_GAP_MS = 250; // start: 응답 뒤 최소 간격
export const MAX_ATTEMPTS = 120;    // start: 사용자 동작 한 번에 요청 수 상한

/** 다음 요청 시작 시각. start = 이번 요청 시작, latency = 이번 요청 왕복 */
export function nextStart(mode, start, latency, intervalMs) {
  return mode === 'old'
    ? start + latency + intervalMs
    : Math.max(start + intervalMs, start + latency + RESPONSE_GAP_MS);
}

export function normalizeConfig(input = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('config must be an object');
  for (const k of Object.keys(input)) if (!Object.hasOwn(SPEC, k)) throw new RangeError(`unknown option: ${k}`);
  const out = {};
  for (const [k, [def, min, max, int]] of Object.entries(SPEC)) {
    const v = !Object.hasOwn(input, k) || input[k] === undefined ? def : input[k];
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new RangeError(`${k} must be a finite number`);
    if (int && !Number.isInteger(v)) throw new RangeError(`${k} must be an integer`);
    if (v < min || v > max) throw new RangeError(`${k} must be within [${min}, ${max}]`);
    out[k] = v;
  }
  return out;
}

// mulberry32 — 시드가 같으면 같은 수열
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// 가장 가까운 순위(nearest-rank) 백분위
export function percentile(values, p) {
  if (!values.length) return null;
  const s = Float64Array.from(values).sort();
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}

const nextFrame = (t, f) => (Math.floor(t / f) + 1) * f;
const r1 = (x) => (x === null ? null : Math.round(x * 10) / 10);
const stat = (xs) => ({ n: xs.length, p50: r1(percentile(xs, 50)), p95: r1(percentile(xs, 95)) });

/** 키 입력 표본 하나: 세 단계 (ms) */
export function keySample(c, rand) {
  const k = rand() * 1000 * c.frameMs; // 프레임 격자에 대한 위상이 임의인 키 시각
  const keyToFrame = nextFrame(k, c.frameMs) - k;
  const networkToEcho = c.rttMs + rand() * c.jitterMs;
  const echo = k + networkToEcho;
  const echoToRender = nextFrame(echo, c.frameMs) - echo;
  return { keyToFrame, networkToEcho, echoToRender, keyToRender: networkToEcho + echoToRender };
}

/** 입장 폴링 표본 하나: 같은 R·같은 요청별 지연으로 두 방식 */
export function cadenceSample(c, rand) {
  const ready = rand() * c.readyWindowMs;
  const lat = []; // i 번째 요청의 왕복 (두 방식 공유)
  const latency = (i) => { while (lat.length <= i) lat.push(c.rttMs + rand() * c.jitterMs + c.serverMs); return lat[i]; };
  const run = (mode) => {
    let s = 0;
    for (let i = 0; s < CEILING_MS && (mode === 'old' || i < MAX_ATTEMPTS); i++) {
      const d = latency(i);
      if (s + c.rttMs / 2 + c.serverMs >= ready) {
        const seen = s + d;
        // old 는 시작 전에만 마감을 봐서 늦은 ready 도 받는다. start 는 300000ms 에 또는 그 뒤에 본 ready 로 입장하지 않는다
        return mode === 'old' || seen < CEILING_MS ? { delay: seen - ready, requests: i + 1 } : null;
      }
      s = nextStart(mode, s, d, c.intervalMs);
    }
    return null;
  };
  return { old: run('old'), start: run('start') };
}

export function simulate(input = {}) {
  const c = normalizeConfig(input);
  // 키 단계와 폴링은 따로 된 수열: 한쪽 설정(RTT 등)이 다른 쪽 표본을 바꾸지 않게
  const keyRand = rng(c.seed);
  const cadRand = rng((c.seed ^ 0x9e3779b9) >>> 0);
  const keys = { keyToFrame: [], networkToEcho: [], echoToRender: [], keyToRender: [] };
  const cad = { old: { delay: [], requests: [], timeouts: 0 }, start: { delay: [], requests: [], timeouts: 0 } };
  for (let i = 0; i < c.samples; i++) {
    const k = keySample(c, keyRand);
    for (const name of Object.keys(keys)) keys[name].push(k[name]);
    const e = cadenceSample(c, cadRand);
    for (const m of ['old', 'start']) {
      if (e[m]) { cad[m].delay.push(e[m].delay); cad[m].requests.push(e[m].requests); }
      else cad[m].timeouts++;
    }
  }
  return {
    model: MODEL,
    label: LABEL,
    synthetic: true,
    config: { ...c, ceilingMs: CEILING_MS, responseGapMs: RESPONSE_GAP_MS, maxAttempts: MAX_ATTEMPTS },
    stages: Object.fromEntries(Object.entries(keys).map(([k, xs]) => [k, { definition: STAGES[k], ...stat(xs) }])),
    cadence: Object.fromEntries(Object.entries(cad).map(([m, v]) => [m, {
      definition: CADENCES[m], readyToSeenMs: stat(v.delay), requests: stat(v.requests), timeouts: v.timeouts,
    }])),
  };
}

const FLAGS = {
  rtt: 'rttMs', jitter: 'jitterMs', frame: 'frameMs', samples: 'samples', seed: 'seed',
  interval: 'intervalMs', server: 'serverMs', 'ready-window': 'readyWindowMs',
};

export function parseArgs(argv) {
  const cfg = {};
  for (const a of argv) {
    const m = /^--([a-z-]+)=(.*)$/.exec(a);
    if (!m || !Object.hasOwn(FLAGS, m[1])) throw new RangeError(`unknown argument (allowed: ${Object.keys(FLAGS).map((f) => `--${f}=<n>`).join(' ')})`);
    if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(m[2])) throw new RangeError(`--${m[1]} must be numeric`);
    cfg[FLAGS[m[1]]] = Number(m[2]);
  }
  return cfg;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(JSON.stringify(simulate(parseArgs(process.argv.slice(2))), null, 2));
  } catch (e) {
    console.error(`lab-latency-benchmark: ${e.message}`);
    process.exit(2);
  }
}
