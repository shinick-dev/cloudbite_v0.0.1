// Cloudbite latency check pinned without a browser or a cloud call.
// Backend (src/cloudbite-computer-latency.ts, bundled by esbuild): owner authority from the server-derived tag and DO record,
// fixed upstreams only, ownership check before any exec, no start/resume, honest null+reason for unknown/stopped/failure/timeout,
// 30 s cache with coalescing, and no key or provider URL in the answer.
// Page (src/cloudbite-computer-latency-page.ts → CLOUDBITE_COMPUTER_LATENCY_JS) in node:vm with a small fake DOM: nothing is
// requested on load or typing, 5 sequential pings give count/p50/p95 from performance.now(), failures are never shown as 0,
// backend timings stay apart from the browser round trip, a 401 shows the sign-in link, a hidden tab aborts, and KO/EN.
//   node test/cloudbite-computer-latency.mjs
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { build } from 'esbuild';
import {
  CLOUDBITE_COMPUTER_LATENCY_JS, CLOUDBITE_COMPUTER_LATENCY_HTML, CLOUDBITE_COMPUTER_LATENCY_CSS,
  CLOUDBITE_COMPUTER_LATENCY_PATH, CLOUDBITE_COMPUTER_LATENCY_JS_PATH, CLOUDBITE_COMPUTER_LATENCY_CSS_PATH,
} from '../src/cloudbite-computer-latency-page.ts';

let pass = 0;
const test = async (name, fn) => { await fn(); pass++; console.log(`  ok   ${name}`); };

const bundle = await build({ entryPoints: ['src/cloudbite-computer-latency.ts'], bundle: true, write: false, format: 'esm', platform: 'neutral', logLevel: 'silent' });
const L = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));

// ───────────────────────── backend ─────────────────────────

const KEY = 'dtn_secret_key_value';
const ENV = { CLOUDBITE_DAYTONA_API_KEY: KEY, CLOUDBITE_DAYTONA_API_URL: 'https://daytona.example.test/api' };
const TAG = 'abcdef0123456789abcdef01';
const NAME = `cloudbite-computer-primary-${TAG}`;
const LABELS = { 'cloudbite-computer': TAG, 'cloudbite-computer-account': 'primary' };
const machine = (o = {}) => ({ computerMachine: async (tag) => { assert.equal(tag, TAG); return { ok: true, machine: { id: 'sb-own', account: 'primary', name: NAME, labels: LABELS, status: 'running', region: 'us', ...o } }; } });
const sandbox = (o = {}) => ({ id: 'sb-own', name: NAME, state: 'started', labels: { ...LABELS }, toolboxProxyUrl: 'https://toolbox.example.test/toolbox', ...o });

/** fake provider deps with a controlled monotonic clock; every call is recorded */
function deps(o = {}) {
  let t = 1000, wall = Date.parse('2026-10-19T04:00:00.000Z');
  const calls = [];
  const d = {
    clock: () => t, wall: () => wall, cache: new Map(), controlTimeoutMs: 50, execTimeoutMs: 50,
    get: async (c, id) => { calls.push(['get', c, id]); t += o.getMs ?? 42; if (o.get) return o.get(c, id); return sandbox(o.sb); },
    exec: async (c, sb, cmd, sec) => { calls.push(['exec', c, sb.id, cmd, sec]); t += o.execMs ?? 180; if (o.exec) return o.exec(); return { exitCode: 0, result: 'cloudbite-latency\n' }; },
  };
  return { d, calls, advanceWall: (ms) => { wall += ms; } };
}
const noSecrets = (body) => { const s = JSON.stringify(body); for (const x of [KEY, 'daytona.example.test', 'toolbox.example.test', 'Bearer']) assert.ok(!s.includes(x), `leaked ${x}`); };

console.log('cloudbite computer latency');

await test('ping: ok, ISO serverTime, no provider involved', async () => {
  const r = L.latencyPing(Date.parse('2026-10-19T04:00:00.000Z'));
  assert.deepEqual(r, { status: 200, body: { ok: true, schema: 'cloudbite.computer.latency.ping.v1', serverTime: '2026-10-19T04:00:00.000Z' } });
  assert.ok(!Number.isNaN(Date.parse(L.latencyPing().body.serverTime)));
});

await test('backend running: owner GET then the fixed read-only exec; two separate timings, no secrets', async () => {
  const { d, calls } = deps();
  const r = await L.latencyBackend(ENV, machine(), TAG, d);
  assert.equal(r.status, 200);
  const b = r.body;
  assert.equal(b.schema, 'cloudbite.computer.latency.backend.v1');
  assert.deepEqual(b.apiControl, { kind: 'api_control', at: '2026-10-19T04:00:00.000Z', ms: 42, reason: null });
  assert.deepEqual(b.remoteExec, { kind: 'remote_exec', at: '2026-10-19T04:00:00.000Z', ms: 180, reason: null, includes: 'provider_queue_and_execution' });
  assert.deepEqual(b.machine, { status: 'running', providerState: 'started', account: 'primary' });
  assert.equal(b.cached, false); assert.equal(b.cacheTtlMs, 30000);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], ['get', { api: 'https://daytona.example.test/api', key: KEY }, 'sb-own']);
  assert.deepEqual(calls[1].slice(2), ['sb-own', 'echo cloudbite-latency', 5]);
  assert.equal(L.LATENCY_EXEC_COMMAND, 'echo cloudbite-latency');
  noSecrets(b);
});

await test('backend default transport: fixed configured upstreams, key only in the server request', async () => {
  const seen = [], realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), method: init.method, auth: init.headers.authorization, body: init.body });
    if (String(url).endsWith('/sandbox/sb-own')) return new Response(JSON.stringify(sandbox()), { status: 200, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ exitCode: 0, result: 'cloudbite-latency' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const r = await L.latencyBackend(ENV, machine(), TAG, { cache: new Map() });
    assert.equal(r.body.apiControl.reason, null); assert.equal(typeof r.body.apiControl.ms, 'number');
    assert.equal(r.body.remoteExec.reason, null); assert.equal(typeof r.body.remoteExec.ms, 'number');
    assert.deepEqual(seen.map(s => [s.method, s.url]), [['GET', 'https://daytona.example.test/api/sandbox/sb-own'], ['POST', 'https://toolbox.example.test/toolbox/sb-own/process/execute']]);
    assert.ok(seen.every(s => s.auth === `Bearer ${KEY}`));
    assert.deepEqual(JSON.parse(seen[1].body), { command: 'echo cloudbite-latency', timeout: 5 });
    noSecrets(r.body);
  } finally { globalThis.fetch = realFetch; }
});

await test('backend absent / not configured: nothing measured, nothing called, never 0', async () => {
  const { d, calls } = deps();
  const none = { computerMachine: async () => ({ error: { code: 'absent' }, status: 409 }) };
  let b = (await L.latencyBackend(ENV, none, TAG, d)).body;
  assert.deepEqual([b.apiControl.ms, b.apiControl.reason, b.remoteExec.ms, b.remoteExec.reason], [null, 'absent', null, 'absent']);
  assert.equal(b.machine.status, 'absent');
  b = (await L.latencyBackend({}, machine(), TAG, deps().d)).body;
  assert.deepEqual([b.apiControl.ms, b.apiControl.reason, b.remoteExec.reason], [null, 'not_configured', 'not_configured']);
  assert.equal(calls.length, 0);
});

await test('backend ownership: id, name or any owner label mismatch → no timing shown and no exec', async () => {
  for (const sb of [{ id: 'sb-other' }, { name: 'someone-else' }, { labels: { ...LABELS, 'cloudbite-computer': 'otherowner000' } }, { labels: {} }]) {
    const { d, calls } = deps({ sb });
    const b = (await L.latencyBackend(ENV, machine(), TAG, d)).body;
    assert.deepEqual([b.apiControl.ms, b.apiControl.reason, b.remoteExec.ms, b.remoteExec.reason], [null, 'ownership_mismatch', null, 'ownership_mismatch']);
    assert.deepEqual(calls.map(c => c[0]), ['get']);
  }
});

await test('backend stopped / error / not running: control timed, exec skipped with a reason, nothing started', async () => {
  const cases = [[{ state: 'stopped' }, {}, 'stopped'], [{ state: 'archived' }, {}, 'stopped'], [{ state: 'error' }, {}, 'error'],
    [{ state: 'starting' }, {}, 'not_running'], [{ state: 'started' }, { status: 'stopping' }, 'not_running'], [{ state: '<b>x</b>' }, {}, 'not_running']];
  for (const [sb, m, reason] of cases) {
    const { d, calls } = deps({ sb });
    const b = (await L.latencyBackend(ENV, machine(m), TAG, d)).body;
    assert.equal(b.apiControl.ms, 42); assert.equal(b.apiControl.reason, null);
    assert.deepEqual([b.remoteExec.ms, b.remoteExec.reason, b.remoteExec.at], [null, reason, null]);
    assert.deepEqual(calls.map(c => c[0]), ['get']);
    if (sb.state === '<b>x</b>') assert.equal(b.machine.providerState, null);
  }
});

await test('backend failures: provider error, 404, timeouts and a failed command stay null with a reason', async () => {
  // provider errors go through the real transport so the real CbDaytonaError classifies them
  const realFetch = globalThis.fetch, seen = [];
  const viaFetch = async (status) => {
    globalThis.fetch = async (url, init) => { seen.push(init.method); return new Response('{"message":"internal detail"}', { status }); };
    try { return (await L.latencyBackend(ENV, machine(), TAG, { cache: new Map() })).body; } finally { globalThis.fetch = realFetch; }
  };
  let b = await viaFetch(500);
  assert.deepEqual([b.apiControl.ms, b.apiControl.reason, b.remoteExec.reason], [null, 'provider_error', 'skipped_after_control_failure']);
  assert.ok(!JSON.stringify(b).includes('internal detail'));
  b = await viaFetch(404);
  assert.equal(b.apiControl.reason, 'absent');
  assert.deepEqual(seen, ['GET', 'GET']);
  let d, calls;
  ({ d, calls } = deps({ get: () => new Promise(() => {}) }));
  b = (await L.latencyBackend(ENV, machine(), TAG, d)).body;
  assert.deepEqual([b.apiControl.ms, b.apiControl.reason, b.remoteExec.reason], [null, 'timeout', 'skipped_after_control_failure']);
  assert.deepEqual(calls.map(c => c[0]), ['get']);
  ({ d } = deps({ exec: () => new Promise(() => {}) }));
  b = (await L.latencyBackend(ENV, machine(), TAG, d)).body;
  assert.deepEqual([b.apiControl.ms, b.remoteExec.ms, b.remoteExec.reason], [42, null, 'timeout']);
  ({ d } = deps({ exec: () => ({ exitCode: 1, result: '' }) }));
  b = (await L.latencyBackend(ENV, machine(), TAG, d)).body;
  assert.deepEqual([b.remoteExec.ms, b.remoteExec.reason], [null, 'exec_failed']);
  ({ d } = deps({ exec: () => { throw new Error('boom'); } }));
  b = (await L.latencyBackend(ENV, machine(), TAG, d)).body;
  assert.deepEqual([b.remoteExec.ms, b.remoteExec.reason], [null, 'provider_error']);
});

await test('backend cache: reused for 30 s, concurrent callers share one measurement, then measured again', async () => {
  const { d, calls, advanceWall } = deps();
  const [a, b] = await Promise.all([L.latencyBackend(ENV, machine(), TAG, d), L.latencyBackend(ENV, machine(), TAG, d)]);
  assert.equal(calls.length, 2); // one get + one exec for both callers
  assert.deepEqual(a.body.apiControl, b.body.apiControl);
  advanceWall(12_000);
  const c = await L.latencyBackend(ENV, machine(), TAG, d);
  assert.equal(c.body.cached, true); assert.equal(c.body.cacheAgeMs, 12_000); assert.equal(calls.length, 2);
  assert.equal(c.body.measuredAt, a.body.measuredAt);
  advanceWall(18_000);
  const e = await L.latencyBackend(ENV, machine(), TAG, d);
  assert.equal(e.body.cached, false); assert.equal(calls.length, 4);
});

// ───────────────────────── page ─────────────────────────

class El {
  constructor(doc, tag) { this.doc = doc; this.tagName = tag.toUpperCase(); this.children = []; this.attrs = {}; this.listeners = {}; this.parent = null;
    this.className = ''; this._text = ''; this.value = ''; this.disabled = false; this.hidden = false; this.id = ''; }
  get textContent() { return this._text + this.children.map(c => typeof c === 'string' ? c : c.textContent).join(''); }
  set textContent(v) { for (const c of this.children) if (typeof c !== 'string') c.parent = null; this.children = []; this._text = String(v); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }
  dispatch(t, extra = {}) { for (const f of this.listeners[t] || []) f({ type: t, target: this, preventDefault() {}, ...extra }); }
  append(...ns) { for (const n of ns) { if (typeof n === 'string') { this.children.push(n); continue; } if (n.parent) n.remove(); n.parent = this; this.children.push(n); } }
  replaceChildren(...ns) { for (const c of this.children) if (typeof c !== 'string') c.parent = null; this.children = []; this._text = ''; this.append(...ns); }
  remove() { if (this.parent) { this.parent.children = this.parent.children.filter(c => c !== this); this.parent = null; } }
  click() { if (!this.disabled) this.dispatch('click'); }
  *walk() { for (const c of this.children) if (typeof c !== 'string') { yield c; yield* c.walk(); } }
  shown() { let n = this; while (n) { if (n.hidden) return false; n = n.parent; } return true; }
}
const json = (status, body) => Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body });
const PING = '/api/cloudbite/computer/latency/ping', BACKEND = '/api/cloudbite/computer/latency/backend';
const backendBody = (o = {}) => ({ ok: true, schema: 'cloudbite.computer.latency.backend.v1', measuredAt: '2026-10-19T04:00:00.000Z', cached: false, cacheAgeMs: 0, cacheTtlMs: 30000,
  machine: { status: 'running', providerState: 'started', account: 'primary' },
  apiControl: { kind: 'api_control', at: '2026-10-19T04:00:00.000Z', ms: 41.5, reason: null },
  remoteExec: { kind: 'remote_exec', at: '2026-10-19T04:00:00.000Z', ms: 233.2, reason: null, includes: 'provider_queue_and_execution' }, ...o });

/** route(r, clock) answers each fetch; it may advance the page's performance clock to set the measured time */
function page({ route, language = 'en-US', search = '' } = {}) {
  let clock = 0, inFlight = 0, maxInFlight = 0;
  const frames = [];
  const doc = { title: '', documentElement: { lang: 'en' }, visibilityState: 'visible', listeners: {},
    createElement: (t) => new El(doc, t), getElementById: (id) => (id === 'cb-computer-latency' ? root : null),
    addEventListener(t, f) { (this.listeners[t] ||= []).push(f); } };
  const root = new El(doc, 'div');
  const requests = [];
  const ctx = vm.createContext({
    document: doc, location: { pathname: CLOUDBITE_COMPUTER_LATENCY_PATH, search, hash: '' }, URLSearchParams, Date, AbortController, navigator: { language },
    performance: { now: () => clock },
    requestAnimationFrame: (f) => { frames.push(f); return frames.length; },
    setTimeout: () => { throw new Error('the page must not use timers'); },
    fetch: (url, init = {}) => {
      const r = { url, method: init.method || 'GET', init }; requests.push(r);
      if (init.signal?.aborted) return Promise.reject(new Error('aborted'));
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      const p = Promise.resolve(route(r, { advance: (ms) => { clock += ms; } }));
      return new Promise((res, rej) => {
        init.signal?.addEventListener('abort', () => rej(new Error('aborted')));
        p.then(res, rej);
      }).finally(() => { inFlight--; });
    },
  });
  vm.runInContext(CLOUDBITE_COMPUTER_LATENCY_JS, ctx);
  const flush = async () => { for (let i = 0; i < 40; i++) await new Promise(r => setImmediate(r)); };
  const all = () => [...root.walk()];
  const byId = (id) => all().find(e => e.id === id);
  const text = () => all().filter(e => e.shown()).map(e => e._text + e.children.filter(c => typeof c === 'string').join('')).filter(Boolean).join(' | ');
  const facts = (dl) => { const out = {}; for (let i = 0; i < dl.children.length; i += 2) out[dl.children[i].textContent] = dl.children[i + 1].textContent; return out; };
  const dlOf = (btnId) => byId(btnId).parent.parent.children.find(c => c.tagName === 'DL');
  const type = (n, frameMs) => { for (let i = 0; i < n; i++) { byId('cl-typing').dispatch('input', { timeStamp: clock }); clock += frameMs[i % frameMs.length]; frames.shift()?.(); } };
  const setVisibility = (v) => { doc.visibilityState = v; for (const f of doc.listeners.visibilitychange || []) f(); };
  return { doc, root, requests, flush, all, byId, text, facts, dlOf, type, setVisibility, frames, stats: () => ({ maxInFlight }), tick: (ms) => { clock += ms; } };
}

console.log('cloudbite computer latency page');

await test('static page: same-origin script and style only, no inline code, storage, WebAuthn, timers or absolute URL', async () => {
  assert.equal(CLOUDBITE_COMPUTER_LATENCY_PATH, '/cloudbite/computer/latency');
  assert.equal(CLOUDBITE_COMPUTER_LATENCY_JS_PATH, '/cloudbite/computer/latency.js');
  assert.equal(CLOUDBITE_COMPUTER_LATENCY_CSS_PATH, '/cloudbite/computer/latency.css');
  assert.ok(CLOUDBITE_COMPUTER_LATENCY_HTML.includes(`<script src="${CLOUDBITE_COMPUTER_LATENCY_JS_PATH}" defer></script>`));
  assert.ok(CLOUDBITE_COMPUTER_LATENCY_HTML.includes(`<link rel="stylesheet" href="${CLOUDBITE_COMPUTER_LATENCY_CSS_PATH}">`));
  assert.ok(!/<script>|style=|<iframe|https?:\/\//.test(CLOUDBITE_COMPUTER_LATENCY_HTML.replace(/<script src[^>]+><\/script>/, '')));
  assert.ok(!/localStorage|sessionStorage|indexedDB|document\.cookie|innerHTML|insertAdjacentHTML|eval\(|new Function|<iframe|postMessage|setInterval|setTimeout|https?:\/\//.test(CLOUDBITE_COMPUTER_LATENCY_JS));
  assert.ok(!/navigator\.credentials|PublicKeyCredential|Authorization|Bearer|geolocation/i.test(CLOUDBITE_COMPUTER_LATENCY_JS));
  assert.ok(!/@import|url\(/.test(CLOUDBITE_COMPUTER_LATENCY_CSS));
  assert.ok(/min-height:48px/.test(CLOUDBITE_COMPUTER_LATENCY_CSS) && /font-size:16px/.test(CLOUDBITE_COMPUTER_LATENCY_CSS));
});

await test('load and typing send nothing; typing shows local input→frame samples with an honest label', async () => {
  const p = page({ route: () => { throw new Error('no request expected'); } });
  await p.flush();
  assert.equal(p.requests.length, 0);
  assert.ok(p.text().includes('No samples yet.'));
  p.type(5, [8, 16, 12, 30, 10]);
  await p.flush();
  assert.equal(p.requests.length, 0);
  const f = p.facts(p.byId('cl-typing').parent.parent.children.find(c => c.tagName === 'DL'));
  assert.deepEqual(f, { Samples: '5', 'Median (p50)': '12.0 ms', p95: '30.0 ms' });
  assert.ok(p.text().includes('before the screen is painted') && p.text().includes('separate measurement'));
  p.byId('cl-typing-clear').click();
  assert.ok(p.text().includes('No samples yet.'));
  // more than 50 inputs keep only the last 50
  p.type(60, [5]);
  assert.equal(p.facts(p.byId('cl-typing').parent.parent.children.find(c => c.tagName === 'DL')).Samples, '50');
  assert.equal(p.requests.length, 0);
});

await test('measure connection: 5 sequential no-store pings → count, p50, p95 from performance.now()', async () => {
  const delays = [40, 20, 50, 30, 100];
  let i = 0;
  const p = page({ route: (r, c) => { assert.equal(r.url, PING); c.advance(delays[i++]); return json(200, { ok: true, schema: 'cloudbite.computer.latency.ping.v1', serverTime: '2099-01-01T00:00:00.000Z' }); } });
  p.byId('cl-edge-run').click();
  assert.equal(p.byId('cl-edge-run').disabled, true);
  p.byId('cl-edge-run').click(); // ignored while running
  await p.flush();
  assert.equal(p.requests.length, 5);
  assert.equal(p.stats().maxInFlight, 1);
  assert.ok(p.requests.every(r => r.init.cache === 'no-store' && r.init.credentials === 'same-origin' && r.method === 'GET' && !r.init.headers));
  const f = p.facts(p.dlOf('cl-edge-run'));
  assert.equal(f.Samples, '5 / 5'); assert.equal(f['Median (p50)'], '40.0 ms'); assert.equal(f.p95, '100.0 ms');
  assert.equal(f['Each sample'], '40.0 · 20.0 · 50.0 · 30.0 · 100.0');
  assert.ok(!('Failed requests' in f));
  assert.ok(!p.text().includes('2099')); // the server clock is never used
  assert.equal(p.byId('cl-edge-run').disabled, false);
});

await test('connection failures are counted, not timed; none succeeding shows no number', async () => {
  let i = 0;
  let p = page({ route: (r, c) => { c.advance(25); return i++ % 2 ? Promise.reject(new Error('net')) : json(200, { ok: true }); } });
  p.byId('cl-edge-run').click(); await p.flush();
  let f = p.facts(p.dlOf('cl-edge-run'));
  assert.equal(f.Samples, '3 / 5'); assert.equal(f['Failed requests'], '2'); assert.equal(f['Median (p50)'], '25.0 ms');
  assert.ok(p.text().includes('Network error'));
  p = page({ route: (r, c) => { c.advance(5); return json(500, { error: { code: 'latency_unavailable' } }); } });
  p.byId('cl-edge-run').click(); await p.flush();
  f = p.facts(p.dlOf('cl-edge-run'));
  assert.equal(f.Samples, '0 / 5'); assert.equal(f['Failed requests'], '5');
  assert.ok(f['Median (p50)'].includes('No sample succeeded'));
  assert.ok(!/\b0\.0 ms/.test(p.text()));
  assert.ok(p.text().includes('Rejected: latency_unavailable'));
});

await test('401 shows the sign-in link and stops; later clicks send nothing', async () => {
  const p = page({ route: () => json(401, { error: { code: 'owner_required' } }), search: '?lang=en' });
  p.byId('cl-edge-run').click(); await p.flush();
  assert.equal(p.requests.length, 1);
  const a = p.all().find(e => e.tagName === 'A' && e.shown() && e.textContent === 'Sign in on the cloud computer page');
  assert.equal(a.getAttribute('href'), '/cloudbite/computer?lang=en');
  assert.equal(p.byId('cl-edge-run').shown(), false);
  p.byId('cl-backend-run').click(); await p.flush();
  assert.equal(p.requests.length, 1);
});

await test('hidden tab aborts the run in flight and drops late answers', async () => {
  let release;
  const p = page({ route: () => new Promise(r => { release = () => r(json(200, { ok: true })); }) });
  p.byId('cl-edge-run').click(); await p.flush();
  assert.equal(p.requests.length, 1);
  p.setVisibility('hidden');
  assert.equal(p.requests[0].init.signal.aborted, true);
  release(); await p.flush();
  assert.equal(p.requests.length, 1);
  assert.ok(p.text().includes('Stopped because the tab was hidden'));
  assert.equal(p.byId('cl-edge-run').disabled, false);
  p.setVisibility('visible'); await p.flush();
  assert.equal(p.requests.length, 1); // becoming visible again does not measure by itself
});

await test('measure backend: browser round trip apart from server timings; stopped and unknown are honest', async () => {
  let body = backendBody();
  const p = page({ route: (r, c) => { assert.equal(r.url, BACKEND); c.advance(310); return json(200, body); } });
  p.byId('cl-backend-run').click(); await p.flush();
  let f = p.facts(p.dlOf('cl-backend-run'));
  assert.equal(f['This request, browser round trip'], '310.0 ms');
  assert.equal(f['Provider control API round trip'], '41.5 ms');
  assert.equal(f['Remote command round trip'], '233.2 ms');
  assert.equal(f['Computer status'], 'running');
  assert.ok(p.text().includes('not a pure network time') && p.text().includes('Fresh measurement.'));
  assert.equal(p.requests.length, 1);

  body = backendBody({ cached: true, cacheAgeMs: 12_400, machine: { status: 'stopped', providerState: 'stopped', account: 'primary' },
    remoteExec: { kind: 'remote_exec', at: null, ms: null, reason: 'stopped', includes: 'provider_queue_and_execution' } });
  p.byId('cl-backend-run').click(); await p.flush();
  f = p.facts(p.dlOf('cl-backend-run'));
  assert.equal(f['Remote command round trip'], 'unavailable — computer is stopped — nothing was started');
  assert.ok(p.text().includes('Reused from a measurement 12 s ago'));

  // a number paired with a reason, a missing value or an unknown code never turns into a timing
  body = backendBody({ apiControl: { ms: 0, reason: 'timeout' }, remoteExec: { reason: 'brand_new_reason' } });
  p.byId('cl-backend-run').click(); await p.flush();
  f = p.facts(p.dlOf('cl-backend-run'));
  assert.equal(f['Provider control API round trip'], 'unavailable — no answer in time');
  assert.equal(f['Remote command round trip'], 'unavailable — unknown (brand_new_reason)');
  body = backendBody({ apiControl: { ms: 'fast' }, remoteExec: null });
  p.byId('cl-backend-run').click(); await p.flush();
  f = p.facts(p.dlOf('cl-backend-run'));
  assert.equal(f['Provider control API round trip'], 'unavailable — provider did not answer correctly');
  assert.equal(f['Remote command round trip'], 'unavailable — provider did not answer correctly');
  assert.equal(p.requests.length, 4);
});

await test('KO switch keeps the measured values and labels honestly', async () => {
  const p = page({ route: (r, c) => { c.advance(20); return r.url === PING ? json(200, { ok: true }) : json(200, backendBody({ remoteExec: { reason: 'not_running' } })); }, language: 'ko-KR' });
  assert.equal(p.doc.documentElement.lang, 'ko');
  p.byId('cl-edge-run').click(); await p.flush();
  p.byId('cl-backend-run').click(); await p.flush();
  assert.ok(p.text().includes('중앙값 (p50)') && p.text().includes('20.0 ms'));
  assert.ok(p.text().includes('측정 불가 — 컴퓨터가 실행 중이 아님'));
  assert.ok(p.text().includes('화면이 그려지기 전') && p.text().includes('별도로 측정'));
  p.all().find(e => e.tagName === 'BUTTON' && e.textContent === 'EN').click();
  assert.equal(p.doc.documentElement.lang, 'en');
  assert.ok(p.text().includes('Median (p50)') && p.text().includes('20.0 ms'));
  assert.equal(p.requests.length, 6);
});

console.log(`${pass} passed`);
