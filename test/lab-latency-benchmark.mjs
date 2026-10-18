// tools/lab-latency-benchmark.mjs (합성 지연 모델) 단위 테스트 — 오프라인, 네트워크·브라우저·저장소 없음.
//   node test/lab-latency-benchmark.mjs
// 확인하는 것: 잘못된·유한하지 않은·음수·너무 큰·모르는(물려받는 이름 포함) 입력 거부, 표본 수 상한, 세 단계 정의(서로 끌어내지 않음·keyToRender =
//              networkToEcho + echoToRender), 입장 폴링 두 방식의 정의·300초 마감 처리(손 계산), 같은 시드 재현성
//              (소수 프레임 설정 그대로 보고·재현), CLI 출력 모양·합성 표시.

import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  normalizeConfig, simulate, keySample, cadenceSample, percentile, rng, parseArgs, nextStart, STAGES, CADENCES, LABEL,
  RESPONSE_GAP_MS, MAX_ATTEMPTS,
} from '../tools/lab-latency-benchmark.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TOOL = resolve(ROOT, 'tools/lab-latency-benchmark.mjs');

let pass = 0, failN = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { failN++; console.log(`  FAIL ${name} ${extra}`); }
};
const throws = (fn) => { try { fn(); return false; } catch (e) { return e instanceof RangeError || e instanceof TypeError; } };

console.log('\n[1] 입력 검사');
for (const [k, v] of [
  ['rttMs', NaN], ['rttMs', Infinity], ['jitterMs', -Infinity], ['rttMs', -1], ['jitterMs', -0.5], ['frameMs', 0],
  ['rttMs', 1e9], ['frameMs', 1e6], ['samples', 0], ['samples', 10_001], ['samples', 1e12], ['samples', 2.5],
  ['seed', -1], ['seed', 2 ** 32], ['intervalMs', 0], ['readyWindowMs', 1e9], ['serverMs', -3], ['rttMs', '80'], ['samples', null],
]) check(`거부: ${k}=${String(v)}`, throws(() => normalizeConfig({ [k]: v })));
check('거부: 모르는 옵션', throws(() => normalizeConfig({ url: 1 })));
// 프로토타입에서 물려받는 이름도 모르는 옵션이다 (JSON.parse 는 __proto__ 도 자기 키로 만든다)
for (const n of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
  check(`거부: 물려받는 이름 ${n}`, throws(() => normalizeConfig(JSON.parse(`{"${n}":1}`))));
}
check('물려받은 값은 쓰지 않음 (자기 키만)', normalizeConfig(Object.create({ rttMs: 5 })).rttMs === 80);
check('거부: 객체가 아님', throws(() => normalizeConfig(null)) && throws(() => normalizeConfig([])) && throws(() => normalizeConfig('x')));
check('simulate 도 같은 검사 (너무 큰 표본 수)', throws(() => simulate({ samples: 1e7 })));
const d = normalizeConfig({});
check('기본값: rtt 80·jitter 20·60Hz·2000 표본·2500ms', d.rttMs === 80 && d.jitterMs === 20 && Math.abs(d.frameMs - 1000 / 60) < 1e-9 && d.samples === 2000 && d.intervalMs === 2500);
check('경계값 허용 (0·상한)', !throws(() => normalizeConfig({ rttMs: 0, jitterMs: 0, serverMs: 0, readyWindowMs: 0, samples: 10_000, seed: 0xffffffff })));

console.log('\n[2] CLI 인자');
check('숫자 인자', JSON.stringify(parseArgs(['--rtt=40', '--frame=8.3', '--ready-window=1e4'])) === '{"rttMs":40,"frameMs":8.3,"readyWindowMs":10000}');
for (const a of [['--rtt=abc'], ['--rtt='], ['--rtt=NaN'], ['--rtt=Infinity'], ['--rtt=0x10'], ['--url=http://x'], ['rtt=1'], ['--RTT=1']]) {
  check(`거부: ${a[0]}`, throws(() => parseArgs(a)));
}
const bad = spawnSync(process.execPath, [TOOL, '--samples=99999999'], { encoding: 'utf8' });
check('CLI: 범위 밖 → 종료 코드 2·stdout 비어 있음', bad.status === 2 && bad.stdout === '' && bad.stderr.includes('samples'), JSON.stringify(bad.status));
const neg = spawnSync(process.execPath, [TOOL, '--jitter=-5'], { encoding: 'utf8' });
check('CLI: 음수 → 종료 코드 2', neg.status === 2 && neg.stdout === '');
for (const n of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
  check(`거부: --${n}=1 (parseArgs)`, throws(() => parseArgs([`--${n}=1`])));
  const r = spawnSync(process.execPath, [TOOL, `--${n}=1`], { encoding: 'utf8' });
  check(`CLI: --${n}=1 → unknown argument·종료 코드 2`, r.status === 2 && r.stdout === '' && r.stderr.includes('unknown argument'), JSON.stringify([r.status, r.stderr]));
}

console.log('\n[3] 세 단계 정의');
{
  const c = normalizeConfig({ rttMs: 100, jitterMs: 30, frameMs: 16 });
  const rand = rng(7);
  let ok = true, sumOk = true, frameOk = true;
  for (let i = 0; i < 5000; i++) {
    const s = keySample(c, rand);
    if (!(s.networkToEcho >= 100 && s.networkToEcho < 130)) ok = false;
    if (s.keyToRender !== s.networkToEcho + s.echoToRender) sumOk = false;
    for (const x of [s.keyToFrame, s.echoToRender]) if (!(x > 0 && x <= 16 + 1e-9)) frameOk = false;
  }
  check('networkToEcho ∈ [rtt, rtt + jitter)', ok);
  check('keyToRender = networkToEcho + echoToRender (keyToFrame 은 더하지 않음)', sumOk);
  check('keyToFrame·echoToRender ∈ (0, frame]', frameOk);
  // keyToFrame 은 로컬 다음 프레임만: rtt·jitter 를 바꿔도 같은 시드면 그대로
  const a = simulate({ samples: 300, seed: 3, rttMs: 10, jitterMs: 0 });
  const b = simulate({ samples: 300, seed: 3, rttMs: 900, jitterMs: 0 });
  check('keyToFrame 은 왕복(RTT)과 무관', JSON.stringify(a.stages.keyToFrame) === JSON.stringify(b.stages.keyToFrame));
  check('networkToEcho 는 RTT 를 따름 (jitter 0)', a.stages.networkToEcho.p50 === 10 && b.stages.networkToEcho.p95 === 900);
  check('단계 정의 문구: keyToFrame 은 터미널 RTT 가 아님', /NOT terminal RTT/.test(STAGES.keyToFrame) && /not added/.test(STAGES.keyToRender));
}

console.log('\n[4] 입장 폴링 간격');
{
  const c = normalizeConfig({ rttMs: 100, jitterMs: 0, serverMs: 400, intervalMs: 2500, readyWindowMs: 60_000 });
  const rand = rng(11);
  const d = 100 + 400, oneWay = 50 + 400; // jitter 0 → 요청 왕복은 늘 500ms
  let nonneg = true, oldMax = 0, startMax = 0, oldSum = 0, startSum = 0, req = true;
  for (let i = 0; i < 2000; i++) {
    const s = cadenceSample(c, rand);
    if (!s.old || !s.start || s.old.delay < 0 || s.start.delay < 0) { nonneg = false; break; }
    oldMax = Math.max(oldMax, s.old.delay); startMax = Math.max(startMax, s.start.delay);
    oldSum += s.old.delay; startSum += s.start.delay;
    if (s.start.requests + 1 < s.old.requests) req = false;
  }
  check('지연 음수 없음·timeout 없음', nonneg);
  // 서버 도착 시각 격자의 간격(old: d + interval, start: max(interval, d + 250)) 안에서 ready 가 생긴다
  check('old 최악 < (d + interval) - oneWay + d', oldMax < d + 2500 - oneWay + d, String(oldMax));
  check('start 최악 < max(interval, d + 250) - oneWay + d', startMax < Math.max(2500, d + 250) - oneWay + d, String(startMax));
  check('평균: start < old (같은 R·같은 지연)', startSum < oldSum, `${startSum} ${oldSum}`);
  check('요청 수: start 가 old 보다 1 넘게 적지 않음', req);
  // 손 계산 회귀: 입장 후보 next = max(시작 + 2500, 응답 + 250)
  check('상수: 응답 뒤 250ms·120번', RESPONSE_GAP_MS === 250 && MAX_ATTEMPTS === 120);
  check('slow 3000ms 응답 → 다음 시작 3250 (응답 + 250)', nextStart('start', 0, 3000, 2500) === 3250);
  check('fast 100ms 응답 → 다음 시작 2500 (시작 + 2500)', nextStart('start', 0, 100, 2500) === 2500);
  check('경계 2250ms 응답 → 2500, 2251ms → 2501', nextStart('start', 0, 2250, 2500) === 2500 && nextStart('start', 0, 2251, 2500) === 2501);
  check('old: slow 3000 → 5500, fast 100 → 2600', nextStart('old', 0, 3000, 2500) === 5500 && nextStart('old', 0, 100, 2500) === 2600);
  {
    // 같은 회귀를 표본으로: 응답 3000ms(rtt 0·server 3000), R = 3001 → old 는 5500 에 다시 시작, start 는 3250
    const cs = normalizeConfig({ rttMs: 0, jitterMs: 0, serverMs: 3000, readyWindowMs: 6002 });
    const v = cadenceSample(cs, () => 0.5);
    check('slow 표본: start 두 번째 요청 3250 시작 → 6250 에 봄', v.start.requests === 2 && v.start.delay === 6250 - 3001 && v.old.delay === 8500 - 3001, JSON.stringify(v));
    const cf = normalizeConfig({ rttMs: 100, jitterMs: 0, serverMs: 0, readyWindowMs: 200 });
    const f = cadenceSample(cf, () => 0.5); // R = 100, 도착 50 < 100 → 두 번째 요청
    check('fast 표본: start 두 번째 요청 2500 시작 → 2600 에 봄 (old 2600 시작 → 2700)', f.start.delay === 2500 && f.old.delay === 2600, JSON.stringify(f));
  }
  {
    // 120번 상한: 간격 250·응답 0 이면 start 는 120번째 시작(29750) 뒤로 요청이 없다 → R 이 그보다 늦으면 timeout
    const cc = normalizeConfig({ rttMs: 0, jitterMs: 0, serverMs: 0, intervalMs: 250, readyWindowMs: 60_000 });
    const late = cadenceSample(cc, () => 0.6); // R = 36000
    check('120번 다 쓰면 start 는 더 시작하지 않음 (timeout)', late.start === null && late.old !== null, JSON.stringify(late));
    const edge = cadenceSample(cc, () => 29_750 / 60_000); // R = 29750 = 120번째 시작
    check('120번째 요청에서는 봄', edge.start?.requests === 120 && edge.start.delay === 0, JSON.stringify(edge));
    const sim = simulate({ samples: 300, rttMs: 0, jitterMs: 0, serverMs: 0, intervalMs: 250 });
    check('simulate: start 요청 수 ≤ 120', sim.cadence.start.requests.p95 <= 120 && sim.cadence.start.timeouts > 0 && sim.config.maxAttempts === 120);
  }
  {
    // 300초 마감 (손 계산, rtt 0·jitter 0 → 서버 도착 = 응답 = 시작 + server). R = 0.875 × 300000 = 262500
    const at = (serverMs, intervalMs, r = 0.875) =>
      cadenceSample(normalizeConfig({ rttMs: 0, jitterMs: 0, serverMs, intervalMs, readyWindowMs: 300_000 }), () => r);
    // server 10000·interval 58000: start 시작 0,58000,…,290000 → 300000 에 봄 = 마감 정각 → 입장 안 함.
    //                              old 시작 0,68000,…,272000 → 282000 에 봄
    const a = at(10_000, 58_000);
    check('start: ready 를 정확히 300000 에 보면 입장 안 함', a.start === null && a.old?.delay === 282_000 - 262_500 && a.old.requests === 5, JSON.stringify(a));
    // server 10000·interval 48000: old 시작 0,58000,…,290000 → 300000 에 봄 (시작은 마감 전) → 받아들임.
    //                              start 시작 0,48000,…,288000 → 298000 에 봄
    const b = at(10_000, 48_000);
    check('old: 마감 전에 시작한 요청이 정확히 300000 에 ready → 받아들임', b.old?.delay === 300_000 - 262_500 && b.old.requests === 6, JSON.stringify(b));
    check('start: 298000 에 봄 (마감 전)', b.start?.delay === 298_000 - 262_500 && b.start.requests === 7, JSON.stringify(b));
    // server 30000·interval 2500, R = 0.984375 × 300000 = 295312.5: old 시작 0,32500,…,292500 → 322500 에 봄 (마감 뒤) → 받아들임.
    //   start 시작 0,30250,…,272250 → 302250 에 봄 → 입장 안 함 (다음 시작 302500 은 마감 뒤라 없음)
    const c = at(30_000, 2500, 0.984375);
    check('old: 마감 뒤 도착한 늦은 ready 도 받아들임', c.old?.delay === 322_500 - 295_312.5 && c.old.requests === 10, JSON.stringify(c));
    check('start: 마감 뒤 도착한 ready 는 입장 안 함 (timeout)', c.start === null, JSON.stringify(c));
    // server 10000·interval 57999: start 시작 0,57999,…,289995 → 299995 에 봄 (마감 5ms 전) → 입장
    const e = at(10_000, 57_999);
    check('start: 마감 직전(299995) ready 는 입장', e.start?.delay === 299_995 - 262_500 && e.start.requests === 6, JSON.stringify(e));
  }
  // 응답이 interval 보다 길면 start 는 겹치지 않고 응답 + 250 에 시작 (동시에 한 요청)
  const slow = normalizeConfig({ rttMs: 0, jitterMs: 0, serverMs: 4000, intervalMs: 2500, readyWindowMs: 0, samples: 1 });
  const one = cadenceSample({ ...slow, readyWindowMs: 0 }, rng(1));
  check('ready 가 0 이면 첫 응답에서 봄 (요청 1)', one.old.requests === 1 && one.start.requests === 1 && one.old.delay === 4000);
  const r = cadenceSample({ ...slow, readyWindowMs: 10_000 }, () => 0.5); // R = 5000
  // old 시작: 0, 6500 → 6500+4000 ≥ 5000 → 10500 에 봄. start 시작: 0, 4250 (max(2500, 4000 + 250)) → 8250 에 봄
  check('old = 응답 + interval, start = max(시작 + interval, 응답 + 250)', r.old.delay === 5500 && r.start.delay === 3250, JSON.stringify(r));
  const s = simulate({ samples: 200, readyWindowMs: 300_000, rttMs: 10_000, serverMs: 60_000 });
  check('300초 상한을 넘으면 timeout 으로 셈 (무한 반복 없음)', s.cadence.start.timeouts > 0
    && s.cadence.old.timeouts + s.cadence.old.readyToSeenMs.n === 200 && s.cadence.start.timeouts + s.cadence.start.readyToSeenMs.n === 200);
  check('방식 정의 문구', /response \+ interval/.test(CADENCES.old) && /seen at or after 300000ms is still accepted/.test(CADENCES.old)
    && /response \+ 250ms/.test(CADENCES.start) && /max 120 attempts/.test(CADENCES.start)
    && /no start at or after 300000ms/.test(CADENCES.start) && /no submit when ready is seen at or after 300000ms/.test(CADENCES.start));
}

console.log('\n[5] 재현성·모양');
{
  const a = simulate({ samples: 500, seed: 42 });
  const b = simulate({ samples: 500, seed: 42 });
  const c = simulate({ samples: 500, seed: 43 });
  check('같은 시드 → 같은 결과', JSON.stringify(a) === JSON.stringify(b));
  check('다른 시드 → 다른 표본', JSON.stringify(a.stages) !== JSON.stringify(c.stages));
  check('합성 표시', a.synthetic === true && a.label === LABEL && /SYNTHETIC/.test(LABEL) && /not a measured improvement/.test(LABEL));
  const nums = [...Object.values(a.stages), ...Object.values(a.cadence).flatMap((x) => [x.readyToSeenMs, x.requests])];
  check('p50·p95 숫자, p50 ≤ p95', nums.every((x) => Number.isFinite(x.p50) && Number.isFinite(x.p95) && x.p50 <= x.p95));
  check('설정 그대로 보고', a.config.samples === 500 && a.config.seed === 42 && a.config.ceilingMs === 300_000);
  // 소수 프레임: 설정은 반올림 없이 그대로 → 그 설정으로 다시 돌리면 같은 결과 (지표만 0.1ms 반올림)
  const replay = (cfg) => Object.fromEntries(Object.entries(cfg).filter(([k]) => !['ceilingMs', 'responseGapMs', 'maxAttempts'].includes(k)));
  check('기본 프레임 1000/60 그대로 보고', a.config.frameMs === 1000 / 60, String(a.config.frameMs));
  for (const frameMs of [1000 / 60, 16.66, 1000 / 144, 8.3333]) {
    const f = simulate({ samples: 400, seed: 9, frameMs });
    const g = simulate(replay(f.config));
    check(`frame ${frameMs}: 보고된 설정으로 재현`, f.config.frameMs === frameMs && JSON.stringify(f) === JSON.stringify(g));
  }
  const fr = simulate({ samples: 400, seed: 9, frameMs: 16.66 });
  check('반올림 프레임(16.7)으로는 다른 표본 → 설정 반올림이면 재현이 깨짐', JSON.stringify(simulate({ samples: 400, seed: 9, frameMs: 16.7 }).stages) !== JSON.stringify(fr.stages));
  check('지표는 0.1ms 반올림', Object.values(fr.stages).every((x) => Math.round(x.p50 * 10) / 10 === x.p50 && Math.round(x.p95 * 10) / 10 === x.p95));
  const cliF = JSON.parse(execFileSync(process.execPath, [TOOL, '--samples=300', '--seed=5', `--frame=${1000 / 60}`], { encoding: 'utf8' }));
  check('CLI: 소수 프레임 그대로 출력·재현', cliF.config.frameMs === 1000 / 60 && JSON.stringify(cliF) === JSON.stringify(simulate(replay(cliF.config))));
  check('percentile nearest-rank', percentile([5, 1, 4, 2, 3], 50) === 3 && percentile([5, 1, 4, 2, 3], 95) === 5 && percentile([], 50) === null);
  const out = execFileSync(process.execPath, [TOOL, '--samples=300', '--seed=42'], { encoding: 'utf8' });
  const j = JSON.parse(out);
  check('CLI = simulate (같은 설정)', JSON.stringify(j) === JSON.stringify(simulate({ samples: 300, seed: 42 })));
  check('CLI 출력: 설정·라벨·단계·폴링', j.synthetic && j.config.rttMs === 80 && 'keyToFrame' in j.stages && 'old' in j.cadence && 'start' in j.cadence);
}

console.log('\n[6] 오프라인 (소스 검사)');
{
  const src = readFileSync(TOOL, 'utf8');
  const imports = [...src.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]);
  check('import 는 node:url 뿐', JSON.stringify(imports) === '["node:url"]', JSON.stringify(imports));
  check('네트워크·저장소·자식 프로세스·환경 변수 없음', !/\bfetch\(|WebSocket|XMLHttpRequest|localStorage|sessionStorage|writeFile|child_process|process\.env|Date\.now|performance\.now/.test(src));
}

console.log(`\n${pass} passed, ${failN} failed\n`);
process.exit(failN ? 1 : 0);
