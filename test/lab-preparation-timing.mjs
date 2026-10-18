// 고정 키·표본 수·숫자 상한·만료, 주입 시계 관측만 (서버·네트워크 없음).
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = await build({ entryPoints: [join(root, 'src/lab-preparation-timing.ts')], bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent' });
const dir = mkdtempSync(join(tmpdir(), 'lab-prep-timing-'));
writeFileSync(join(dir, 'timing.mjs'), out.outputFiles[0].text);
let T;
try { T = await import(pathToFileURL(join(dir, 'timing.mjs')).href); } finally { rmSync(dir, { recursive: true, force: true }); }
globalThis.fetch = async () => { throw new Error('network blocked'); };
let n = 0;
function test(name, f) { f(); console.log(`  ok ${name}`); n++; }

test('고정 숫자 키만, 문자열·ID·주소·상속 값 거부', () => {
  assert.deepEqual(T.prepTimingClean({ prep_sandbox: 11.4, prep_health: '8', prep_start: NaN, total: 99, url: 'https://test.invalid', error: 'text' }), { prep_sandbox: 11 });
  assert.deepEqual(T.prepTimingClean(Object.create({ prep_health: 1 })), {});
});
test('빈 단계는 비움 (0 채우지 않음)', () => {
  assert.deepEqual(T.prepTimingView(undefined, 1, 2, 3), {});
  assert.deepEqual(T.prepTimingView(T.prepTimingNew(100), undefined, undefined, 120), { prep_queue: 20 });
});
test('단계마다 128개 표본, 합도 600000ms 상한', () => {
  const m = T.prepTimingNew(100);
  for (let i = 0; i < 1000; i++) T.prepTimingAdd(m, 'prep_sandbox', 1e6, 100);
  assert.equal(m.counts.prep_sandbox, T.PREP_TIMING_SAMPLES);
  assert.equal(m.values.prep_sandbox, 600000);
  assert.equal(Object.keys(m.values).length, 1);
});
test('음수·비유한·임의 단계는 저장 안 함', () => {
  const m = T.prepTimingNew(100);
  for (const d of [-1, NaN, Infinity]) T.prepTimingAdd(m, 'prep_health', d, 100);
  T.prepTimingAdd(m, 'description', 1, 100);
  T.prepTimingAdd(m, 'prep_elapsed', 1, 100);
  assert.deepEqual(m.values, {});
  assert.deepEqual(m.counts, {});
});
test('실제 wait 간격만 합산, resume 중복 없음', () => {
  const m = T.prepTimingNew(100); m.waitAt = 125;
  assert.deepEqual(T.prepTimingView(m, 110, undefined, 150), { prep_elapsed: 40, prep_wait: 25 });
  T.prepTimingResume(m, 200); T.prepTimingResume(m, 210);
  assert.equal(m.values.prep_wait, 75);
  assert.equal(m.counts.prep_wait, 1);
});
test('재시작 벽시계 elapsed에 큐는 제외 (모르는 호출은 없음)', () => {
  const m = T.prepTimingNew(100);
  T.prepTimingAdd(m, 'prep_queue', 20, 120);
  T.prepTimingAdd(m, 'prep_sandbox', 10, 130);
  const restarted = structuredClone(m);
  assert.deepEqual(T.prepTimingView(restarted, 120, undefined, 10120), { prep_queue: 20, prep_elapsed: 10000, prep_sandbox: 10 });
});
test('기록 24h 만료 뒤 내보내거나 표본 추가 안 함', () => {
  const m = T.prepTimingNew(100); T.prepTimingAdd(m, 'prep_health', 7, 100);
  const late = 101 + T.PREP_TIMING_KEEP;
  T.prepTimingAdd(m, 'prep_health', 9, late);
  assert.equal(m.values.prep_health, 7);
  assert.deepEqual(T.prepTimingView(m, 100, undefined, late), {});
});
test('시계 역행·잘못된 종료로 elapsed 0 만들지 않음', () => {
  const m = T.prepTimingNew(100);
  assert.deepEqual(T.prepTimingView(m, 120, 110, 150), {});
  assert.deepEqual(T.prepTimingView(m, 120, undefined, 99), {});
});
test('깨진 예전 저장 모양은 관측 없이 통과, 예외 없음', () => {
  for (const m of [{ at: 100 }, { at: 100, values: null, counts: {} }, { at: 100, values: {}, counts: null }, { at: 100, values: [], counts: {} }]) {
    T.prepTimingAdd(m, 'prep_health', 5, 100);
    T.prepTimingResume(m, 100);
    assert.deepEqual(T.prepTimingView(m, 100, undefined, 100), {});
    assert.equal(T.prepTimingExpired(m, 100), true);
  }
});
console.log(`\n${n} passed, 0 failed`);
