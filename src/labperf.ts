// 실습실 화면의 로컬 성능 측정 — 기본은 꺼져 있다. 이 탭에서만 켠다: DevTools 콘솔에
//   sessionStorage.setItem('labPerf', '1'); location.reload()
// 켜면 window.__labPerf.snapshot() 이 숫자·고정 분류(editor/terminal/other)만 담은 복사본을 돌려주고, stop() 으로 멈춘다.
// 재는 것: 탐색 타이밍(숫자 필드만), 신뢰된 keydown → 다음 requestAnimationFrame 콜백까지의 지연(표본),
//   longtask 수·길이. keydown→rAF 는 터미널 에코·왕복(RTT)·글자 그리기가 아니다 (PERFORMANCE.md).
// 보내지 않는다: fetch·sendBeacon·WebSocket 없음, 저장소에 쓰지 않음, 콘솔 출력 없음.
// 읽지 않는다: 키 값(key/code)·입력 내용·클립보드·주소·요청 본문·식별자. 대상 요소는 closest() 로 분류만 한다.
// 묶음: 최근 표본 ≤128 (고리), 표본 사이 ≥100ms, 대기 중 rAF 하나, 관찰은 60초까지, pagehide 에 멈춤.
// 리스너는 passive·capture 이고 preventDefault/stopPropagation 을 부르지 않는다 (guard.js·VS Code 에 영향 없음).
// 서버 쪽 시간(Server-Timing 등)은 DevTools 네트워크 탭에서 따로 본다 — 여기서는 리소스 주소를 모으지 않는다.

export const LAB_PERF_JS = `(() => {
'use strict';
const w = window;
try { if (w.__labPerf) return; } catch { return; }
let on = false;
try { on = w.sessionStorage.getItem('labPerf') === '1'; } catch { on = false; }
if (!on) return;
const RING = 128, GAP = 100, SPAN = 60e3, CATS = ['editor', 'terminal', 'other'];
const NAVK = ['requestStart', 'responseStart', 'responseEnd', 'domInteractive', 'domContentLoadedEventEnd', 'loadEventEnd', 'duration', 'transferSize'];
let P = null;
try { P = w.performance || null; } catch { P = null; }
const now = () => { try { const t = P && typeof P.now === 'function' ? P.now() : NaN; return typeof t === 'number' && isFinite(t) ? t : 0; } catch { return 0; } };
const num = (x) => (typeof x === 'number' && isFinite(x) && x >= 0 ? Math.round(x * 10) / 10 : null);
const push = (a, v) => { a.push(v); if (a.length > RING) a.shift(); };
const cat = (t) => {
  try {
    if (t && typeof t.closest === 'function') {
      if (t.closest('.xterm')) return 1;
      if (t.closest('.monaco-editor')) return 0;
    }
  } catch {}
  return 2;
};
const t0 = now();
let stopped = false, stopAt = 0, busy = false, raf = 0, last = -Infinity, timer = 0, obs = null, ltOk = false;
let sampled = 0, skipped = 0;
const lag = [];
const agg = CATS.map(() => ({ n: 0, sum: 0, max: 0 }));
const lt = { n: 0, sum: 0, max: 0, recent: [] };

function stop() {
  if (stopped) return;
  stopped = true; stopAt = now();
  try { w.removeEventListener('keydown', onKey, true); } catch {}
  try { w.removeEventListener('pagehide', onHide, true); } catch {}
  try { if (busy && typeof w.cancelAnimationFrame === 'function') w.cancelAnimationFrame(raf); } catch {}
  busy = false; raf = 0;
  try { if (obs) obs.disconnect(); } catch {}
  obs = null;
  try { if (timer) w.clearTimeout(timer); } catch {}
  timer = 0;
}
function onHide() { stop(); }
function onKey(e) {
  try {
    if (stopped || !e || e.isTrusted !== true) return;
    const t = now();
    if (t - t0 > SPAN) { stop(); return; }
    if (busy || t - last < GAP) { skipped++; return; }
    if (typeof w.requestAnimationFrame !== 'function') return;
    const ts = typeof e.timeStamp === 'number' && e.timeStamp > 0 && e.timeStamp <= t ? e.timeStamp : t;
    const c = cat(e.target);
    last = t; busy = true;
    raf = w.requestAnimationFrame(() => {
      busy = false; raf = 0;
      try {
        if (stopped) return;
        const ms = num(now() - ts);
        if (ms === null || ms > SPAN) return;
        sampled++;
        const a = agg[c]; a.n++; a.sum += ms; if (ms > a.max) a.max = ms;
        push(lag, { c, ms });
      } catch {}
    });
  } catch { busy = false; raf = 0; }
}
const nav = () => {
  try {
    const e = P && typeof P.getEntriesByType === 'function' ? P.getEntriesByType('navigation')[0] : null;
    if (!e) return null;
    const r = {};
    for (const k of NAVK) r[k] = num(e[k]);
    return r;
  } catch { return null; }
};
const pct = (s, p) => (s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null);
function snapshot() {
  try {
    const cats = {};
    CATS.forEach((name, i) => {
      const a = agg[i];
      const s = lag.filter((x) => x.c === i).map((x) => x.ms).sort((x, y) => x - y);
      cats[name] = { n: a.n, meanMs: a.n ? num(a.sum / a.n) : null, maxMs: a.n ? a.max : null, p50Ms: pct(s, 0.5), p95Ms: pct(s, 0.95), recentN: s.length };
    });
    return {
      version: 1, active: !stopped, elapsedMs: num((stopped ? stopAt : now()) - t0), windowMs: SPAN,
      nav: nav(),
      keyToFrame: { sampled, skipped, categories: cats, recent: lag.map((x) => ({ category: CATS[x.c], ms: x.ms })) },
      longtask: { supported: ltOk, count: lt.n, totalMs: num(lt.sum), maxMs: lt.n ? lt.max : null, recentMs: lt.recent.slice() },
    };
  } catch { return null; }
}

try {
  const PO = w.PerformanceObserver;
  const types = PO && PO.supportedEntryTypes;
  if (typeof PO === 'function' && types && typeof types.includes === 'function' && types.includes('longtask')) {
    const o = new PO((list) => {
      try {
        if (stopped) return;
        for (const en of list.getEntries()) {
          const d = num(en && en.duration);
          if (d === null) continue;
          lt.n++; lt.sum += d; if (d > lt.max) lt.max = d;
          push(lt.recent, d);
        }
      } catch {}
    });
    try { o.observe({ type: 'longtask', buffered: true }); obs = o; ltOk = true; }
    catch { try { o.disconnect(); } catch {} }
  }
} catch { obs = null; ltOk = false; }
try { w.addEventListener('keydown', onKey, { capture: true, passive: true }); } catch {}
try { w.addEventListener('pagehide', onHide, { capture: true, passive: true }); } catch {}
try { if (typeof w.setTimeout === 'function') timer = w.setTimeout(stop, SPAN); } catch { timer = 0; }
try { Object.defineProperty(w, '__labPerf', { value: Object.freeze({ snapshot: () => snapshot(), stop: () => { stop(); } }), configurable: true }); } catch {}
})();
`;
