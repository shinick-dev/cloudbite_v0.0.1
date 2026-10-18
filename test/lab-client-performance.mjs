// 실습실 로컬 성능 측정(src/labperf.ts 의 LAB_PERF_JS) 단위 테스트.
// 브라우저·네트워크 없이 돈다: 설치된 esbuild 로 TS 를 옮겨 문자열을 꺼내고, node:vm 안에서 가짜 window·
// sessionStorage·performance·requestAnimationFrame·PerformanceObserver·타이머로 실행한다 (시계는 손으로 돌린다).
// 가짜이므로 진짜 브라우저의 이벤트 순서·rAF 시점·longtask 보고는 확인하지 못한다 (PERFORMANCE.md).
//
//   node test/lab-client-performance.mjs
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { transform } from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src', 'labperf.ts');

let pass = 0, failN = 0, section = '';
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   [${section}] ${name}`); }
  else { failN++; console.log(`  FAIL [${section}] ${name}${extra ? ` — ${extra}` : ''}`); }
};
const sec = (s) => { section = s; console.log(`\n# ${s}`); };

const { code } = await transform(fs.readFileSync(SRC, 'utf8'), { loader: 'ts', format: 'cjs', target: 'es2022' });
const mod = { exports: {} };
vm.runInNewContext(code, { module: mod, exports: mod.exports });
const JS = mod.exports.LAB_PERF_JS;

/** 가짜 브라우저 하나. 쓰거나 보내거나 남기면 rec 에 기록된다 */
function makeEnv(o = {}) {
  const opt = { storage: '1', raf: true, po: true, nav: true, ...o };
  const rec = { net: [], log: [], writes: [], reads: [], pd: 0, sp: 0, raf: 0, caf: [], disconnect: 0, observe: [] };
  const clock = { t: 1000 };
  const listeners = [];
  const rafQ = new Map(); let rafId = 0;
  const timers = new Map(); let timerId = 0;
  let poCb = null;
  const g = {};
  g.window = g;
  const trap = (name) => (...a) => { rec.net.push(name); void a; };
  g.fetch = trap('fetch');
  g.XMLHttpRequest = function XMLHttpRequest() { rec.net.push('xhr'); };
  g.WebSocket = function WebSocket() { rec.net.push('ws'); };
  g.EventSource = function EventSource() { rec.net.push('es'); };
  g.Image = function Image() { rec.net.push('img'); };
  g.navigator = { sendBeacon: trap('sendBeacon'), clipboard: { readText: trap('clipboard'), writeText: trap('clipboard') } };
  g.console = new Proxy({}, { get: (_, k) => (...a) => { rec.log.push(String(k)); void a; } });
  const store = (name, getItem) => ({
    getItem, setItem: (k) => rec.writes.push(`${name}.setItem:${k}`), removeItem: (k) => rec.writes.push(`${name}.removeItem:${k}`), clear: () => rec.writes.push(`${name}.clear`),
  });
  g.localStorage = store('localStorage', () => { rec.reads.push('localStorage'); return null; });
  if (opt.storage === 'throwAccess') Object.defineProperty(g, 'sessionStorage', { get() { throw new Error('SecurityError'); } });
  else g.sessionStorage = store('sessionStorage', (k) => {
    if (opt.storage === 'throwGet') throw new Error('SecurityError');
    return k === 'labPerf' ? opt.storage : null;
  });
  g.performance = {
    now: () => clock.t,
    ...(opt.nav ? {
      getEntriesByType: (ty) => {
        if (opt.nav === 'throw') throw new Error('boom');
        return ty === 'navigation' ? [{
          name: 'https://lab.example/j/SECRET-INVITE?code=SECRET-CODE', entryType: 'navigation', type: 'navigate', nextHopProtocol: 'h3',
          serverTiming: [{ name: 'SECRET-TIMING', duration: 3 }],
          requestStart: 10.04, responseStart: 120.44, responseEnd: 130, domInteractive: 300.06, domContentLoadedEventEnd: 320, loadEventEnd: 0,
          duration: 400.5, transferSize: 2048,
        }] : [];
      },
    } : {}),
  };
  if (opt.raf) {
    g.requestAnimationFrame = (cb) => {
      rec.raf++;
      if (opt.raf === 'throw') throw new Error('no rAF');
      rafQ.set(++rafId, cb); return rafId;
    };
    g.cancelAnimationFrame = (id) => { rec.caf.push(id); rafQ.delete(id); };
  }
  g.setTimeout = (fn, ms) => { timers.set(++timerId, { fn, at: clock.t + ms }); return timerId; };
  g.clearTimeout = (id) => { timers.delete(id); };
  g.addEventListener = (type, fn, opts) => { listeners.push({ type, fn, opts }); };
  g.removeEventListener = (type, fn, opts) => {
    const cap = opts === true || (opts && opts.capture === true);
    const i = listeners.findIndex((l) => l.type === type && l.fn === fn && (l.opts === true || (l.opts && l.opts.capture === true)) === cap);
    if (i >= 0) listeners.splice(i, 1);
  };
  if (opt.po) {
    g.PerformanceObserver = class {
      static get supportedEntryTypes() { return opt.po === 'nolongtask' ? ['navigation'] : ['longtask', 'navigation']; }
      constructor(cb) { poCb = cb; }
      observe(x) { rec.observe.push(JSON.stringify(x)); if (opt.po === 'throwObserve') throw new Error('nope'); }
      disconnect() { rec.disconnect++; }
    };
  }
  vm.createContext(g);
  const env = {
    g, rec, clock, listeners,
    run: () => vm.runInContext(JS, g),
    tick: (ms) => { clock.t += ms; },
    flushRaf: () => { const q = [...rafQ]; rafQ.clear(); for (const [, cb] of q) cb(clock.t); return q.length; },
    pendingRaf: () => rafQ.size,
    runTimers: () => { for (const [id, t] of [...timers]) if (t.at <= clock.t) { timers.delete(id); t.fn(); } },
    timerCount: () => timers.size,
    fire: (type, ev) => { for (const l of listeners.filter((x) => x.type === type)) l.fn(ev); },
    longtask: (entries) => poCb && poCb({ getEntries: () => entries }),
    perf: () => g.__labPerf,
    snap: () => JSON.parse(JSON.stringify(g.__labPerf.snapshot())),
  };
  return env;
}

/** 내용을 담은 가짜 keydown. key·code·값을 읽으면 rec.reads 에 남는다 */
function keyEv(env, sel, over = {}) {
  const { rec, clock } = env;
  const watch = (name, v) => ({ get() { rec.reads.push(name); return v; }, enumerable: true });
  const target = Object.defineProperties({
    closest: over.closestThrows ? () => { throw new Error('detached'); } : (s) => (sel && s === sel ? {} : null),
  }, {
    value: watch('target.value', 'SECRET-VALUE'), textContent: watch('target.textContent', 'SECRET-TEXT'),
    innerText: watch('target.innerText', 'SECRET-TEXT'), id: watch('target.id', 'SECRET-ID'), baseURI: watch('target.baseURI', 'https://SECRET-URL'),
  });
  const ev = Object.defineProperties({
    isTrusted: over.isTrusted ?? true, timeStamp: over.timeStamp ?? clock.t, target,
    preventDefault: () => { rec.pd++; }, stopPropagation: () => { rec.sp++; }, stopImmediatePropagation: () => { rec.sp++; },
  }, {
    key: watch('key', 'SECRET-KEY'), code: watch('code', 'KeySECRET'), keyCode: watch('keyCode', 83), which: watch('which', 83),
    charCode: watch('charCode', 83), data: watch('data', 'SECRET-DATA'), clipboardData: watch('clipboardData', null),
  });
  return ev;
}

const CATS = new Set(['editor', 'terminal', 'other']);
/** 스냅샷 안에 숫자·null·불리언·고정 분류 문자열만 있는가 */
function safeShape(v, at = 'snap') {
  if (v === null || typeof v === 'number' || typeof v === 'boolean') return typeof v !== 'number' || Number.isFinite(v) ? null : at;
  if (typeof v === 'string') return CATS.has(v) ? null : `${at}=${v}`;
  if (Array.isArray(v)) { if (v.length > 128) return `${at}.length`; for (let i = 0; i < v.length; i++) { const r = safeShape(v[i], `${at}[${i}]`); if (r) return r; } return null; }
  if (typeof v === 'object') { for (const [k, x] of Object.entries(v)) { const r = safeShape(x, `${at}.${k}`); if (r) return r; } return null; }
  return at;
}
const noSecret = (s) => !/SECRET|https?:|lab\.example/i.test(JSON.stringify(s));
const quiet = (rec) => rec.net.length === 0 && rec.log.length === 0 && rec.writes.length === 0;

sec('source');
check('LAB_PERF_JS 는 문자열', typeof JS === 'string' && JS.length > 500);
for (const [name, re] of [
  ['fetch', /\bfetch\b/], ['sendBeacon', /sendBeacon/], ['WebSocket', /WebSocket/], ['XMLHttpRequest', /XMLHttpRequest/], ['EventSource', /EventSource/],
  ['storage 쓰기', /setItem|removeItem|\.clear\(/], ['localStorage', /localStorage/], ['console', /console/], ['clipboard', /clipboard/i],
  ['preventDefault', /preventDefault/], ['stopPropagation', /stopPropagation|stopImmediatePropagation/],
  ['.key/.code/.value/.data', /\.(key|code|keyCode|which|charCode|value|data|textContent|innerText|innerHTML)\b/],
  ['entry name·URL', /\.(name|href|baseURI|serverTiming)\b|location/], ['eval·Function', /\beval\b|new Function/],
]) check(`${name} 없음`, !re.test(JS));
check('opt-in 은 sessionStorage labPerf === "1" 뿐', /sessionStorage\.getItem\('labPerf'\) === '1'/.test(JS));
check('표본 상한·간격·관찰 시간 상수', /RING = 128, GAP = 100, SPAN = 60e3/.test(JS));

sec('default-off');
for (const [label, storage] of [['값 없음', null], ['"0"', '0'], ['"true"', 'true'], ['getItem 이 던짐', 'throwGet'], ['sessionStorage 접근이 던짐', 'throwAccess']]) {
  const e = makeEnv({ storage });
  let threw = null;
  try { e.run(); } catch (err) { threw = err; }
  check(`${label}: 예외 없음`, threw === null, String(threw));
  check(`${label}: 리스너·관찰자·타이머·__labPerf 없음`, e.listeners.length === 0 && e.rec.observe.length === 0 && e.timerCount() === 0 && e.perf() === undefined);
  check(`${label}: 쓰기·전송·로그 없음`, quiet(e.rec));
}

sec('enable');
{
  const e = makeEnv();
  e.run();
  const kd = e.listeners.find((l) => l.type === 'keydown');
  const ph = e.listeners.find((l) => l.type === 'pagehide');
  check('keydown 리스너 capture+passive', kd && kd.opts.capture === true && kd.opts.passive === true);
  check('pagehide 리스너', !!ph);
  check('리스너는 둘뿐', e.listeners.length === 2);
  check('longtask 관찰 (buffered)', e.rec.observe.length === 1 && JSON.parse(e.rec.observe[0]).type === 'longtask');
  check('60초 타이머 하나', e.timerCount() === 1);
  check('__labPerf 는 snapshot·stop 만, frozen', Object.keys(e.perf()).sort().join() === 'snapshot,stop' && Object.isFrozen(e.perf()));
  e.run();
  check('두 번 넣어도 한 번만 설치', e.listeners.length === 2 && e.rec.observe.length === 1);
  const s = e.snap();
  check('처음 스냅샷: 표본 0, active', s.active === true && s.keyToFrame.sampled === 0 && s.keyToFrame.recent.length === 0);
  check('처음 스냅샷 모양 안전', safeShape(s) === null, safeShape(s));
}

sec('no-content/no-network');
{
  const e = makeEnv();
  e.run();
  e.fire('keydown', keyEv(e, '.monaco-editor'));
  e.tick(16); e.flushRaf();
  e.longtask([{ duration: 75.123, name: 'https://lab.example/SECRET', attribution: [{ containerSrc: 'https://SECRET' }] }]);
  const s = e.snap();
  check('key·code·값·텍스트·id 를 읽지 않음', e.rec.reads.length === 0, e.rec.reads.join());
  check('preventDefault·stopPropagation 안 부름', e.rec.pd === 0 && e.rec.sp === 0);
  check('전송·저장소 쓰기·로그 없음', quiet(e.rec), JSON.stringify(e.rec));
  check('스냅샷에 내용·주소 없음', noSecret(s));
  check('스냅샷 모양 안전 (숫자·고정 분류만)', safeShape(s) === null, safeShape(s));
  check('탐색 타이밍 숫자만 (0.1ms 반올림)', s.nav.responseStart === 120.4 && s.nav.domInteractive === 300.1 && s.nav.transferSize === 2048 && !('name' in s.nav) && !('type' in s.nav));
  check('탐색 타이밍 키는 정해진 것만', Object.keys(s.nav).sort().join() === 'domContentLoadedEventEnd,domInteractive,duration,loadEventEnd,requestStart,responseEnd,responseStart,transferSize');
}

sec('sampling bounds');
{
  const e = makeEnv();
  e.run();
  e.fire('keydown', keyEv(e, '.monaco-editor', { isTrusted: false }));
  check('신뢰되지 않은 keydown 무시', e.rec.raf === 0);
  e.fire('keydown', keyEv(e, '.monaco-editor'));          // t=1000 표본
  check('신뢰된 keydown → rAF 하나', e.rec.raf === 1 && e.pendingRaf() === 1);
  e.tick(10); e.fire('keydown', keyEv(e, '.monaco-editor')); // 대기 중 rAF 있음
  check('대기 중 rAF 는 하나뿐', e.rec.raf === 1 && e.pendingRaf() === 1);
  e.tick(6); e.flushRaf();                                  // t=1016
  let s = e.snap();
  check('지연 = rAF 콜백 시각 − 이벤트 timeStamp', s.keyToFrame.sampled === 1 && s.keyToFrame.recent[0].ms === 16 && s.keyToFrame.recent[0].category === 'editor');
  e.tick(34); e.fire('keydown', keyEv(e, '.monaco-editor'));  // t=1050, 앞 표본에서 50ms
  check('100ms 안의 keydown 은 건너뜀', e.rec.raf === 1);
  e.tick(50); e.fire('keydown', keyEv(e, '.xterm'));          // t=1100
  check('100ms 뒤 다시 표본', e.rec.raf === 2);
  e.tick(5); e.flushRaf();
  s = e.snap();
  check('건너뛴 수 셈', s.keyToFrame.skipped === 2, String(s.keyToFrame.skipped));
  for (let i = 0; i < 300; i++) {
    e.tick(100);
    e.fire('keydown', keyEv(e, ['.monaco-editor', '.xterm', null][i % 3]));
    e.tick(1 + (i % 7)); e.flushRaf();
  }
  s = e.snap();
  check('누적 표본 302', s.keyToFrame.sampled === 302, String(s.keyToFrame.sampled));
  check('최근 고리 ≤128', s.keyToFrame.recent.length === 128);
  const c = s.keyToFrame.categories;
  check('분류별 누적 n 합 = 표본 수', c.editor.n + c.terminal.n + c.other.n === 302);
  check('분류별 recentN 합 = 고리 길이', c.editor.recentN + c.terminal.recentN + c.other.recentN === 128);
  check('평균·최대·p50·p95 는 유한한 숫자', ['editor', 'terminal', 'other'].every((k) => [c[k].meanMs, c[k].maxMs, c[k].p50Ms, c[k].p95Ms].every(Number.isFinite)));
  check('rAF 요청 수 = 표본 수', e.rec.raf === 302);
  check('스냅샷 모양 안전', safeShape(s) === null && noSecret(s));
  const a = e.perf().snapshot();
  a.keyToFrame.recent.length = 0; a.keyToFrame.categories.editor.n = -1;
  const b = e.snap();
  check('스냅샷은 복사본 (바꿔도 내부 그대로)', b.keyToFrame.recent.length === 128 && b.keyToFrame.categories.editor.n > 0);
  for (let i = 0; i < 300; i++) e.longtask([{ duration: 50 + i }]);
  const l = e.snap().longtask;
  check('longtask 수·최대·최근 ≤128', l.supported === true && l.count === 300 && l.maxMs === 349 && l.recentMs.length === 128);
}

sec('fixed categories');
{
  const e = makeEnv();
  e.run();
  const order = [['.monaco-editor', 'editor'], ['.xterm', 'terminal'], [null, 'other'], ['.something-else', 'other']];
  for (const [sel] of order) { e.tick(200); e.fire('keydown', keyEv(e, sel)); e.tick(3); e.flushRaf(); }
  e.tick(200); e.fire('keydown', keyEv(e, '.monaco-editor', { closestThrows: true })); e.tick(3); e.flushRaf();
  const got = e.snap().keyToFrame.recent.map((x) => x.category);
  check('editor/terminal/other 분류', got.join() === 'editor,terminal,other,other,other', got.join());
  check('분류 키는 셋뿐', Object.keys(e.snap().keyToFrame.categories).sort().join() === 'editor,other,terminal');
}

sec('window bound');
{
  const e = makeEnv();
  e.run();
  e.tick(60001);
  e.fire('keydown', keyEv(e, '.xterm'));
  const s = e.snap();
  check('60초 넘은 keydown → 멈춤·표본 없음', s.active === false && e.rec.raf === 0 && s.keyToFrame.sampled === 0);
  check('멈추면 리스너 없음·관찰자 해제·타이머 해제', e.listeners.length === 0 && e.rec.disconnect === 1 && e.timerCount() === 0);
  check('elapsedMs 는 멈춘 때에 고정', s.elapsedMs === 60001 && (e.tick(5000), e.snap().elapsedMs === 60001));
  const f = makeEnv();
  f.run();
  f.tick(60000); f.runTimers();
  check('60초 타이머가 멈춤', f.snap().active === false && f.listeners.length === 0 && f.rec.disconnect === 1);
}

sec('stop cleanup');
{
  const e = makeEnv();
  e.run();
  e.fire('keydown', keyEv(e, '.monaco-editor'));
  check('대기 중 rAF 하나', e.pendingRaf() === 1);
  e.fire('pagehide', {});
  check('pagehide → rAF 취소', e.rec.caf.length === 1 && e.pendingRaf() === 0);
  check('pagehide → 리스너·관찰자·타이머 정리', e.listeners.length === 0 && e.rec.disconnect === 1 && e.timerCount() === 0);
  e.longtask([{ duration: 90 }]);
  const s = e.snap();
  check('멈춘 뒤 longtask 무시', s.longtask.count === 0 && s.active === false && s.keyToFrame.sampled === 0);
  e.perf().stop(); e.perf().stop();
  check('stop() 여러 번 안전', e.rec.disconnect === 1 && e.rec.caf.length === 1);
  const f = makeEnv();
  f.run();
  f.tick(200); f.fire('keydown', keyEv(f, '.xterm'));
  f.perf().stop();
  f.flushRaf();
  check('stop() 뒤 늦은 rAF 콜백 무시', f.snap().keyToFrame.sampled === 0 && f.listeners.length === 0);
  check('정리 중 전송·쓰기·로그 없음', quiet(e.rec) && quiet(f.rec));
}

sec('feature absence / exceptions');
{
  const e = makeEnv({ raf: false, po: false, nav: false });
  let threw = null;
  try { e.run(); e.fire('keydown', keyEv(e, '.monaco-editor')); } catch (err) { threw = err; }
  const s = e.snap();
  check('rAF·PerformanceObserver·getEntriesByType 없음: 예외 없음', threw === null, String(threw));
  check('없으면 표본·longtask·nav 비움', s.keyToFrame.sampled === 0 && s.longtask.supported === false && s.nav === null);
  const f = makeEnv({ po: 'nolongtask' });
  f.run();
  check('longtask 미지원이면 관찰 안 함', f.rec.observe.length === 0 && f.snap().longtask.supported === false);
  const g = makeEnv({ po: 'throwObserve', nav: 'throw' });
  threw = null;
  try { g.run(); } catch (err) { threw = err; }
  check('observe·getEntriesByType 가 던져도 계속', threw === null && g.snap().longtask.supported === false && g.snap().nav === null && g.listeners.length === 2);
  const h = makeEnv({ raf: 'throw' });
  h.run();
  threw = null;
  try { h.fire('keydown', keyEv(h, '.xterm')); h.tick(150); h.fire('keydown', keyEv(h, '.xterm')); } catch (err) { threw = err; }
  check('rAF 가 던져도 예외 없음·다시 시도', threw === null && h.rec.raf === 2 && h.snap().keyToFrame.sampled === 0);
  const k = makeEnv();
  k.run();
  threw = null;
  try { k.fire('keydown', null); k.fire('keydown', { isTrusted: true }); k.flushRaf(); } catch (err) { threw = err; }
  check('이상한 이벤트에도 예외 없음', threw === null && k.snap().keyToFrame.recent.every((x) => CATS.has(x.category)));
  const m = makeEnv();
  m.run();
  m.fire('keydown', keyEv(m, '.monaco-editor', { timeStamp: 999999 }));
  m.tick(7); m.flushRaf();
  check('미래 timeStamp 는 무시하고 처리 시각 기준', m.snap().keyToFrame.recent[0]?.ms === 7);
  check('모든 경우 전송·쓰기·로그 없음', [e, f, g, h, k, m].every((x) => quiet(x.rec)));
}

console.log(`\n${pass} ok, ${failN} fail`);
process.exit(failN ? 1 : 0);
