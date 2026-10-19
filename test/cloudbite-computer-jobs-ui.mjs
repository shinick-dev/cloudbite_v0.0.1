// Cloudbite job runner page (src/cloudbite-computer-jobs-page.ts → CLOUDBITE_COMPUTER_JOBS_JS) pinned without a browser: a small fake DOM
// in node:vm with a mock API drives the 401 sign-in link, the read-only server target, argv/file validation, Review → explicit Run,
// requestId and exact-body reuse after uncertain answers, definite rejections, stop, honest job statuses, bounded raw logs,
// visible-only polling with ≥5 s backoff, stale-answer guards after sign-out and target change, and the KO/EN switch.
// No real sign-in, cloud call or browser. Real-browser and 390px visual checks are the coordinator's.
//   node test/cloudbite-computer-jobs-ui.mjs
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import {
  CLOUDBITE_COMPUTER_JOBS_JS, CLOUDBITE_COMPUTER_JOBS_HTML, CLOUDBITE_COMPUTER_JOBS_CSS,
  CLOUDBITE_COMPUTER_JOBS_PATH, CLOUDBITE_COMPUTER_JOBS_JS_PATH, CLOUDBITE_COMPUTER_JOBS_CSS_PATH,
} from '../src/cloudbite-computer-jobs-page.ts';

let pass = 0;
const test = async (name, fn) => { await fn(); pass++; console.log(`  ok   ${name}`); };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const API = '/api/cloudbite/computer';
const CTX = `${API}/jobs/context`, RUN = `${API}/jobs/run`, STOP = `${API}/jobs/stop`, JOBS = `${API}/nested/jobs`;

class El {
  constructor(doc, tag) { this.doc = doc; this.tagName = tag.toUpperCase(); this.children = []; this.attrs = {}; this.listeners = {}; this.parent = null;
    this.className = ''; this._text = ''; this.value = ''; this.disabled = false; this.hidden = false; this.checked = false; this.files = null; this.id = ''; }
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
const deferred = () => { let resolve; const p = new Promise(r => { resolve = r; }); return { p, resolve }; };
const CPU_RATE = 0.165924;
const ctxBody = (o = {}) => ({ ok: true, sandbox: { id: 'sb-1', account: 'primary', name: 'cloudbite-computer-owner', region: 'us' },
  selection: { candidateId: 'cand-1', gpu: 'RTX 4090', country: 'DE', market: 'mkt-4090' },
  pricing: { cpuUsdPerHour: CPU_RATE, gpuBaseUsdPerHour: 0.4, networkFeeIncluded: false, observedAt: '2026-10-19T00:00:00.000Z' }, ...o });
const job = (o = {}) => ({ id: 'job-1', provider: 'daytona', status: 'running', image: 'python:3.12-slim', command: ['python3', '-c', 'print(1)'], timeoutSec: 60,
  createdAt: '2026-10-19T01:00:00.000Z', deadline: '2026-10-19T01:04:00.000Z', finishedAt: null, cleanup: 'none', error: null, result: null,
  providerState: null, public: false, note: null, gpu: null, country: null, ...o });
const file = (name, bytes) => ({ name, size: bytes.length, arrayBuffer: async () => new Uint8Array(bytes).buffer });

/** a mock API: context, job list, run and stop; handlers may be replaced per test */
function api(o = {}) {
  const s = { ctx: ctxBody(o.ctx || {}), jobs: o.jobs || [], unauth: !!o.unauth, run: o.run || null, stop: o.stop || null, jobsRoute: o.jobsRoute || null, ctxRoute: o.ctxRoute || null };
  const route = (r) => {
    if (s.unauth) return json(401, { error: { code: 'unauthorized', message: 'x' } });
    if (r.url.startsWith(CTX)) return s.ctxRoute ? s.ctxRoute(r, s) : json(200, s.ctx);
    if (r.url === JOBS) return s.jobsRoute ? s.jobsRoute(r, s) : json(200, { ok: true, jobs: s.jobs });
    if (r.url === RUN && r.method === 'POST') return s.run ? s.run(r, s) : json(200, { ok: true, job: job({ id: 'job-new', status: 'creating' }) });
    if (r.url === STOP && r.method === 'POST') return s.stop ? s.stop(r, s) : json(200, { ok: true, job: job({ id: r.body.jobId, status: 'stopped' }) });
    return json(404, { error: { code: 'not_found', message: 'x' } });
  };
  return { s, route };
}

function env({ route, language = 'en-US', search = '' } = {}) {
  const timers = new Map(); let seq = 0, now = 0;
  const doc = { title: '', documentElement: { lang: 'en' }, visibilityState: 'visible', listeners: {},
    createElement: (t) => new El(doc, t), getElementById: (id) => (id === 'cb-computer-jobs' ? root : null),
    addEventListener(t, f) { (this.listeners[t] ||= []).push(f); } };
  const root = new El(doc, 'div');
  const requests = [];
  const ctx = vm.createContext({
    document: doc, location: { pathname: CLOUDBITE_COMPUTER_JOBS_PATH, search, hash: '' }, URLSearchParams, URL, atob, btoa, Date, Uint8Array, ArrayBuffer,
    TextEncoder, AbortController, crypto: webcrypto, navigator: { language },
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { at: now + (ms || 0), ms, fn }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    fetch: (url, init = {}) => {
      const r = { url, method: init.method || 'GET', raw: init.body, body: init.body === undefined ? undefined : JSON.parse(init.body), init };
      requests.push(r);
      if (init.signal?.aborted) return Promise.reject(new Error('aborted'));
      const p = route(r);
      // an aborted fetch rejects as the browser would, even when the mock answers later
      return new Promise((res, rej) => { init.signal?.addEventListener('abort', () => rej(new Error('aborted'))); p.then(res, rej); });
    },
  });
  const flush = async () => { for (let i = 0; i < 30; i++) await new Promise(r => setImmediate(r)); };
  const advance = async (ms) => {
    const end = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]); now = due[1].at; due[1].fn(); await flush();
    }
    now = end;
  };
  vm.runInContext(CLOUDBITE_COMPUTER_JOBS_JS, ctx);
  const all = () => [...root.walk()];
  const visible = () => all().filter(e => e.shown());
  const btn = (text) => visible().find(e => e.tagName === 'BUTTON' && e.textContent === text);
  const byId = (id) => all().find(e => e.id === id);
  const setVisibility = (v) => { doc.visibilityState = v; for (const f of doc.listeners.visibilitychange || []) f(); };
  const text = () => visible().map(e => e._text + e.children.filter(c => typeof c === 'string').join('')).filter(Boolean).join(' | ');
  const posts = (p) => requests.filter(r => r.method === 'POST' && r.url === p);
  const checks = () => visible().filter(e => e.tagName === 'INPUT' && e.getAttribute('type') === 'checkbox');
  const setCommand = (v) => { const c = byId('cj-command'); c.value = v; c.dispatch('input'); };
  const pickFiles = (fs) => { const f = byId('cj-files'); f.files = fs; f.dispatch('change'); };
  const choose = (id, v) => { const s = byId(id); s.value = v; s.dispatch('change'); };
  const tick = (i) => { const c = checks()[i]; c.checked = true; c.dispatch('change'); };
  return { doc, root, requests, timers, flush, advance, all, visible, btn, byId, setVisibility, text, posts, checks, setCommand, pickFiles, choose, tick };
}

console.log('cloudbite computer jobs page');

await test('static page: same-origin script and style only, no inline code, no storage, no WebAuthn, no absolute URL', async () => {
  assert.equal(CLOUDBITE_COMPUTER_JOBS_PATH, '/cloudbite/computer/jobs');
  assert.equal(CLOUDBITE_COMPUTER_JOBS_JS_PATH, '/cloudbite/computer/jobs.js');
  assert.equal(CLOUDBITE_COMPUTER_JOBS_CSS_PATH, '/cloudbite/computer/jobs.css');
  assert.ok(CLOUDBITE_COMPUTER_JOBS_HTML.includes(`<script src="${CLOUDBITE_COMPUTER_JOBS_JS_PATH}" defer></script>`));
  assert.ok(CLOUDBITE_COMPUTER_JOBS_HTML.includes(`<link rel="stylesheet" href="${CLOUDBITE_COMPUTER_JOBS_CSS_PATH}">`));
  assert.ok(!/<script>|style=|<iframe|https?:\/\//.test(CLOUDBITE_COMPUTER_JOBS_HTML.replace(/<script src[^>]+><\/script>/, '')));
  assert.ok(!/localStorage|sessionStorage|indexedDB|document\.cookie|innerHTML|insertAdjacentHTML|eval\(|new Function|<iframe|postMessage/.test(CLOUDBITE_COMPUTER_JOBS_JS));
  assert.ok(!/navigator\.credentials|PublicKeyCredential|Authorization|Bearer/i.test(CLOUDBITE_COMPUTER_JOBS_JS));
  assert.ok(!/https?:\/\//.test(CLOUDBITE_COMPUTER_JOBS_JS));
  assert.ok(!/@import|url\(/i.test(CLOUDBITE_COMPUTER_JOBS_CSS));
});

await test('CSS stays inside a 390px viewport: no fixed widths over 360px outside media queries, 48px targets, 16px inputs', async () => {
  const base = CLOUDBITE_COMPUTER_JOBS_CSS.split('@media')[0];
  for (const m of base.matchAll(/(?:^|[;{])\s*(?:width|min-width)\s*:\s*(\d+)px/g)) assert.ok(Number(m[1]) <= 360, `fixed width ${m[0]}`);
  for (const m of base.matchAll(/minmax\((\d+)px/g)) assert.ok(Number(m[1]) <= 180, m[0]);
  assert.match(CLOUDBITE_COMPUTER_JOBS_CSS, /\.cj-btn\{min-height:48px/);
  assert.match(CLOUDBITE_COMPUTER_JOBS_CSS, /\.cj-lang-btn\{min-width:48px;min-height:48px/);
  assert.match(CLOUDBITE_COMPUTER_JOBS_CSS, /\.cj-check\{[^}]*min-height:48px/);
  assert.match(CLOUDBITE_COMPUTER_JOBS_CSS, /\.cj-select,\.cj-input\{[^}]*font-size:16px/);
  assert.match(CLOUDBITE_COMPUTER_JOBS_CSS, /\.cj-code\{[^}]*font-size:16px/);
  assert.match(CLOUDBITE_COMPUTER_JOBS_CSS, /\.cj-log\{[^}]*max-height:320px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere/);
});

await test('401 from the context: a link to the main computer sign-in, no WebAuthn, no job list or run call', async () => {
  const { route } = api({ unauth: true });
  const e = env({ route, search: '?lang=en' });
  await e.flush();
  assert.match(e.text(), /not signed in to your cloud computer/);
  const a = e.visible().find(x => x.tagName === 'A' && x.textContent === 'Sign in on the cloud computer page');
  assert.equal(a.getAttribute('href'), '/cloudbite/computer?lang=en');
  assert.deepEqual(e.requests.map(r => r.url), [CTX]);
  assert.ok(!e.byId('cj-command').shown(), 'the form is not offered while signed out');
  await e.advance(120000);
  assert.deepEqual(e.requests.map(r => r.url), [CTX], 'no polling while signed out');
});

await test('signed in: the target is the server context (read-only), jobs load, and nothing is created by loading, typing, Enter or time', async () => {
  const { route } = api();
  const e = env({ route, search: '?sandboxId=evil&account=primary&gpu=H100' });
  await e.flush();
  assert.equal(e.requests[0].url, `${CTX}?sandboxId=evil&account=primary`, 'only sandboxId+account are forwarded; the server verifies them');
  assert.ok(e.requests.some(r => r.url === JOBS));
  assert.match(e.text(), /cloudbite-computer-owner/);
  assert.match(e.text(), /RTX 4090 · DE · mkt-4090/);
  assert.ok(!e.all().some(x => x.tagName === 'INPUT' && /gpu|country/i.test(x.id)), 'no GPU or country input on this page');
  e.setCommand('["python3","-c","print(2)"]');
  e.byId('cj-command').dispatch('keydown', { key: 'Enter' });
  e.byId('cj-image').dispatch('keydown', { key: 'Enter' });
  await e.advance(300000);
  assert.equal(e.requests.filter(r => r.method === 'POST').length, 0);
  assert.equal(e.requests.filter(r => r.url === JOBS).length, 1, 'no polling without an active job');
  const bad = env({ route, search: '?sandboxId=a%20b&account=primary' });
  await bad.flush();
  assert.equal(bad.requests[0].url, CTX, 'a malformed sandbox id is not forwarded');
});

await test('command validation: JSON argv only, explicit reasons, the typed text is kept', async () => {
  const { route } = api();
  const e = env({ route });
  await e.flush();
  for (const [v, why] of [['python3 -c print(1)', /not valid JSON/], ['{"a":1}', /JSON array of strings/], ['[]', /1 to 64 arguments/],
    ['[""]', /must not be empty/], ['["a", 1]', /JSON array of strings/], ['["a","b\\u0007"]', /control characters/]]) {
    e.setCommand(v);
    e.btn('Review').click(); await e.flush();
    assert.match(e.text(), why, v);
    assert.equal(e.byId('cj-command').value, v);
    assert.ok(!e.btn('Run'), 'no review for an invalid command');
  }
  e.setCommand('["echo","ok"]');
  e.byId('cj-image').value = 'Not An Image!';
  e.btn('Review').click(); await e.flush();
  assert.match(e.text(), /plain container reference/);
  assert.equal(e.posts(RUN).length, 0);
});

await test('CPU: Review locks inputs and shows the fixed worker, time limit and estimate; Run needs the cost acknowledgement and sends the exact contract body', async () => {
  const { route } = api();
  const e = env({ route });
  await e.flush();
  e.setCommand('["python3","-c","print(1)"]');
  e.choose('cj-timeout', '120');
  e.btn('Review').click(); await e.flush();
  for (const id of ['cj-command', 'cj-image', 'cj-timeout', 'cj-provider', 'cj-files']) assert.equal(e.byId(id).disabled, true, `${id} locked during review`);
  const t = e.text();
  assert.match(t, /CPU worker · 2 vCPU · 4 GiB RAM · 8 GiB disk/);
  assert.match(t, /python:3\.12-slim/);
  // ceil(120/60)+2 = 4 min at 0.165924/h = 0.0110616
  assert.match(t, /up to about \$0\.0111 \(4 min at \$0\.165924\/h\)/);
  assert.match(t, /Network fees are not included/);
  assert.equal(e.checks().length, 1, 'no public acknowledgement for a private CPU job');
  assert.equal(e.btn('Run').disabled, true);
  e.btn('Run').click(); await e.flush();
  assert.equal(e.posts(RUN).length, 0);
  e.tick(0);
  e.btn('Run').click(); await e.flush();
  const [p] = e.posts(RUN);
  assert.match(p.body.requestId, UUID);
  assert.deepEqual(Object.keys(p.body).sort(), ['account', 'acknowledgeCost', 'command', 'provider', 'requestId', 'sandboxId', 'timeout']);
  assert.deepEqual({ ...p.body, requestId: 0 }, { requestId: 0, sandboxId: 'sb-1', account: 'primary', provider: 'daytona', timeout: 120, command: ['python3', '-c', 'print(1)'], acknowledgeCost: true });
  assert.match(e.text(), /Job accepted/);
  assert.equal(e.byId('cj-command').disabled, false, 'unlocked after a definite answer');
});

await test('GPU: offered only with a server selection; the public warning and acknowledgement are required; the body carries no GPU fields', async () => {
  const none = api({ ctx: { selection: null } });
  const n = env({ route: none.route });
  await n.flush();
  const opt = n.all().find(x => x.tagName === 'OPTION' && x.value === 'nosana');
  assert.equal(opt.disabled, true);
  assert.match(n.text(), /No GPU chosen/);
  n.btn('GPU info').click(); await n.flush();
  assert.equal(n.byId('cj-provider').value, 'daytona', 'the GPU sample cannot select a GPU host without a selection');

  const { route } = api();
  const e = env({ route });
  await e.flush();
  e.btn('GPU info').click(); await e.flush();
  assert.equal(e.byId('cj-provider').value, 'nosana');
  assert.equal(e.byId('cj-command').value, '["nvidia-smi"]');
  assert.match(e.text(), /GPU jobs are public/);
  e.btn('Review').click(); await e.flush();
  const t = e.text();
  assert.match(t, /GPU host \(Nosana\) · RTX 4090 · DE · mkt-4090/);
  // ceil(60/60)+2 = 3 min at 0.4/h = 0.02
  assert.match(t, /up to about \$0\.0200 \(3 min at \$0\.4\/h\)/);
  assert.match(t, /not reserved/);
  assert.equal(e.checks().length, 2);
  e.tick(0);
  assert.equal(e.btn('Run').disabled, true, 'cost acknowledgement alone is not enough for a public job');
  e.tick(1);
  e.btn('Run').click(); await e.flush();
  const [p] = e.posts(RUN);
  assert.equal(p.body.provider, 'nosana');
  assert.equal(p.body.image, 'nvidia/cuda:12.4.1-base-ubuntu22.04');
  assert.equal(p.body.acknowledgePublic, true);
  assert.equal(p.body.acknowledgeCost, true);
  for (const k of ['gpu', 'country', 'market', 'candidateId']) assert.ok(!(k in p.body), `no ${k} from the browser`);

  const unpriced = api({ ctx: { pricing: { cpuUsdPerHour: CPU_RATE, gpuBaseUsdPerHour: null, networkFeeIncluded: false, observedAt: '2026-10-19T00:00:00.000Z' } } });
  const u = env({ route: unpriced.route });
  await u.flush();
  u.choose('cj-provider', 'nosana');
  u.btn('Review').click(); await u.flush();
  assert.match(u.text(), /unknown — the server has no current GPU price/);
});

await test('uncertain answer: Retry resends the same requestId and byte-identical body; inputs stay locked; no automatic retry', async () => {
  let n = 0;
  const created = job({ id: 'job-new', status: 'creating' });
  const { route } = api({ run: (r, st) => (++n < 3 ? (n === 1 ? Promise.reject(new Error('net')) : json(503, {})) : (st.jobs = [created], json(200, { ok: true, job: created }))) });
  const e = env({ route });
  await e.flush();
  e.btn('Python hello').click();
  e.btn('Review').click(); await e.flush();
  e.tick(0); e.btn('Run').click(); await e.flush();
  assert.match(e.text(), /No definite answer/);
  assert.ok(!e.btn('Run'), 'Run is replaced by Retry');
  assert.equal(e.byId('cj-command').disabled, true);
  assert.equal(e.checks()[0].disabled, true, 'acknowledgements frozen with the request');
  await e.advance(60000);
  assert.equal(e.posts(RUN).length, 1, 'polling never resends a run');
  e.btn('Retry same request').click(); await e.flush();
  e.btn('Retry same request').click(); await e.flush();
  const runs = e.posts(RUN);
  assert.equal(runs.length, 3);
  assert.equal(runs[1].raw, runs[0].raw);
  assert.equal(runs[2].raw, runs[0].raw);
  assert.match(e.text(), /Job accepted/);
  assert.ok(e.all().some(x => x.getAttribute('data-job') === 'job-new'));
});

await test('Forget after an uncertain answer unlocks the form and refreshes the list; the next Run is a new requestId', async () => {
  const { route } = api({ run: () => json(502, {}) });
  const e = env({ route });
  await e.flush();
  e.btn('Review').click(); await e.flush();
  e.tick(0); e.btn('Run').click(); await e.flush();
  const before = e.requests.filter(r => r.url === JOBS).length;
  e.btn('Forget it').click(); await e.flush();
  assert.match(e.text(), /If the job was created it appears in the list below/);
  assert.equal(e.byId('cj-command').disabled, false);
  assert.ok(e.requests.filter(r => r.url === JOBS).length > before);
  e.btn('Review').click(); await e.flush();
  e.tick(0); e.btn('Run').click(); await e.flush();
  const runs = e.posts(RUN);
  assert.notEqual(runs[1].body.requestId, runs[0].body.requestId);
});

await test('definite rejection: the server code is shown, inputs and files are kept and unlocked; Edit unlocks without sending', async () => {
  const { route } = api({ run: () => json(409, { error: { code: 'request_conflict', message: 'x' } }) });
  const e = env({ route });
  await e.flush();
  e.setCommand('["echo","keep me"]');
  e.pickFiles([file('in.txt', [104, 105])]);
  e.btn('Review').click(); await e.flush();
  e.btn('Edit').click(); await e.flush();
  assert.equal(e.byId('cj-command').disabled, false);
  assert.equal(e.posts(RUN).length, 0);
  e.btn('Review').click(); await e.flush();
  e.tick(0); e.btn('Run').click(); await e.flush();
  assert.match(e.text(), /Rejected: request_conflict/);
  assert.equal(e.byId('cj-command').value, '["echo","keep me"]');
  assert.match(e.text(), /in\.txt — 2 bytes/);
  assert.equal(e.byId('cj-command').disabled, false);
  await e.advance(60000);
  assert.equal(e.posts(RUN).length, 1, 'no implicit retry');
});

await test('files: at most 3, 16 KiB decoded in total, flat safe names, no duplicates; valid files are sent as base64', async () => {
  const { route } = api();
  const e = env({ route });
  await e.flush();
  const reject = async (fs, why) => {
    e.pickFiles(fs);
    e.btn('Review').click(); await e.flush();
    assert.match(e.text(), why);
    assert.ok(!e.btn('Run'));
  };
  await reject([file('a', [1]), file('b', [1]), file('c', [1]), file('d', [1])], /at most 3 files/);
  await reject([file('../x', [1])], /File name not allowed: \.\.\/x/);
  await reject([file('.env', [1])], /File name not allowed/);
  await reject([file('a b.txt', [1])], /File name not allowed/);
  await reject([file('dir\\x', [1])], /File name not allowed/);
  await reject([file('same.txt', [1]), file('same.txt', [2])], /Two files are named same\.txt/);
  await reject([file('big.bin', new Array(16385).fill(0))], /larger than 16 KiB/);
  // a File whose reported size understates its content is still bounded by the bytes actually read
  await reject([{ name: 'liar.bin', size: 1, arrayBuffer: async () => new Uint8Array(16385).buffer }], /larger than 16 KiB/);
  await reject([{ name: 'gone.txt', size: 1, arrayBuffer: async () => { throw new Error('NotReadableError'); } }], /could not be read/);
  e.pickFiles([file('main.py', [...Buffer.from('print(1)\n')]), file('data.bin', [0, 255, 128])]);
  e.setCommand('["python3","main.py"]');
  e.btn('Review').click(); await e.flush();
  assert.match(e.text(), /2 file\(s\), 12 bytes: main\.py, data\.bin/);
  e.tick(0); e.btn('Run').click(); await e.flush();
  const [p] = e.posts(RUN);
  assert.deepEqual(p.body.files, [{ name: 'main.py', contentBase64: Buffer.from('print(1)\n').toString('base64') }, { name: 'data.bin', contentBase64: 'AP+A' }]);
  e.btn('Remove files').click(); await e.flush();
  assert.match(e.text(), /No files chosen/);
});

await test('job list: honest statuses, raw output as bounded text, download link, provider state and cleanup shown', async () => {
  const big = 'x'.repeat(70000) + 'END';
  const { route } = api({ jobs: [
    job({ id: 'q1', provider: 'nosana', status: 'queued', gpu: 'RTX 4090', country: 'DE', providerState: 'RUNNING', public: true, note: 'Nosana GPU job definitions (image and command) are public; never put secrets in them.' }),
    job({ id: 'd1', status: 'succeeded', cleanup: 'pending', result: { exitCode: 0, timedOut: false, output: '<img src=x onerror=alert(1)>\r\nline2\u0007\n' + big, truncated: true } }),
    job({ id: 'u1', status: 'uncertain', error: 'create_uncertain', cleanup: 'unknown' }),
    job({ id: 'bad id!', status: 'running' }),
  ] });
  const e = env({ route });
  await e.flush();
  const t = e.text();
  assert.match(t, /GPU · RTX 4090 · DE/);
  assert.match(t, /Queued — waiting for a host, not running yet/);
  assert.match(t, /Provider reports RUNNING/, 'a RUNNING deployment is shown as the provider state, the job stays queued');
  assert.match(t, /Not confirmed — the provider did not confirm the job/);
  assert.match(t, /Error: create_uncertain/);
  assert.match(t, /Cleaning up provider resources/);
  assert.match(t, /Cleanup not confirmed/);
  assert.match(t, /Exit code 0/);
  assert.match(t, /cut to its last 64 KiB/);
  assert.ok(!e.all().some(x => x.getAttribute('data-job') === 'bad id!'), 'a malformed job id is not drawn');
  const dl = e.visible().find(x => x.tagName === 'A' && x.textContent === 'Download output');
  assert.equal(dl.getAttribute('href'), '/api/cloudbite/computer/jobs/d1/output');
  assert.equal(dl.getAttribute('download'), 'cloudbite-job-d1.txt');
  assert.ok(!e.visible().some(x => x.tagName === 'PRE'), 'output is closed until asked for');
  e.btn('Show output').click(); await e.flush();
  const pre = e.visible().find(x => x.tagName === 'PRE');
  assert.equal(pre.children.length, 1);
  assert.equal(typeof pre.children[0], 'string', 'drawn as one text node');
  assert.ok(pre.textContent.length <= 64 * 1024);
  assert.ok(pre.textContent.endsWith('END'));
  assert.ok(!/[\r\u0007]/.test(pre.textContent));
  const short = api({ jobs: [job({ id: 'd2', status: 'failed', result: { exitCode: 2, timedOut: true, output: '<b>raw</b>\r\nok\u0007', truncated: false } })] });
  const s = env({ route: short.route });
  await s.flush();
  s.btn('Show output').click(); await s.flush();
  assert.equal(s.visible().find(x => x.tagName === 'PRE').textContent, '<b>raw</b>\nok�');
  assert.match(s.text(), /Exit code 2/);
  assert.match(s.text(), /Stopped at the time limit/);
  assert.ok(!s.btn('Stop'), 'a finished job has no Stop');
});

await test('stop: one POST {requestId, jobId}; an uncertain answer is retried only by the user with the same request', async () => {
  let n = 0;
  const { s, route } = api({ jobs: [job({ id: 'r1', status: 'running' })], stop: (r) => (++n === 1 ? json(500, {}) : json(200, { ok: true, job: job({ id: r.body.jobId, status: 'stopped' }) })) });
  const e = env({ route });
  await e.flush();
  e.btn('Stop').click(); await e.flush();
  assert.match(e.text(), /No definite answer to Stop/);
  await e.advance(30000);
  assert.equal(e.posts(STOP).length, 1);
  s.jobs = [job({ id: 'r1', status: 'stopped' })];
  e.btn('Retry stop').click(); await e.flush();
  const stops = e.posts(STOP);
  assert.equal(stops.length, 2);
  assert.deepEqual(Object.keys(stops[0].body).sort(), ['jobId', 'requestId']);
  assert.equal(stops[0].body.jobId, 'r1');
  assert.equal(stops[1].raw, stops[0].raw);
  assert.match(e.text(), /Stop accepted/);
  assert.ok(!e.btn('Stop'));
});

await test('polling: only while a job is active and the tab is visible, first after 5 s with growing backoff; stops when settled', async () => {
  const { s, route } = api({ jobs: [job({ id: 'r1', status: 'queued' })] });
  const e = env({ route });
  await e.flush();
  const count = () => e.requests.filter(r => r.url === JOBS).length;
  assert.equal(count(), 1);
  const delays = () => [...e.timers.values()].map(t => t.ms);
  assert.ok(delays().every(ms => ms >= 5000));
  await e.advance(4999); assert.equal(count(), 1);
  await e.advance(1); assert.equal(count(), 2);
  assert.ok(delays()[0] > 5000, 'backoff grows');
  e.setVisibility('hidden');
  assert.equal(e.timers.size, 0, 'hidden: no timer');
  await e.advance(600000); assert.equal(count(), 2);
  e.setVisibility('visible'); await e.flush();
  assert.equal(count(), 3, 'one check on return to the tab');
  assert.ok(e.requests.filter(r => r.url.startsWith(CTX)).length >= 2, 'the target is checked again too');
  s.jobs = [job({ id: 'r1', status: 'succeeded', cleanup: 'done', result: { exitCode: 0, timedOut: false, output: 'ok', truncated: false } })];
  await e.advance(5000);
  const settled = count();
  await e.advance(600000);
  assert.equal(count(), settled, 'no polling once every job settled');
  assert.equal(e.timers.size, 0);
});

await test('polling is bounded and pauses with a note; Refresh resumes it', async () => {
  const { route } = api({ jobs: [job({ id: 'r1', status: 'running' })] });
  const e = env({ route });
  await e.flush();
  for (let i = 0; i < 130; i++) await e.advance(30000);
  const count = e.requests.filter(r => r.url === JOBS).length;
  assert.equal(count, 121);
  assert.match(e.text(), /Automatic refresh paused/);
  e.btn('Refresh').click(); await e.flush();
  assert.ok(!/Automatic refresh paused/.test(e.text()));
  assert.equal(e.timers.size, 1);
});

await test('sign-out during work: 401 aborts in-flight requests, a late answer is dropped, polling stops, the draft is kept', async () => {
  const late = deferred();
  const { s, route } = api({ jobs: [job({ id: 'r1', status: 'running' })], run: () => late.p });
  const e = env({ route });
  await e.flush();
  e.setCommand('["echo","draft"]');
  e.btn('Review').click(); await e.flush();
  e.tick(0); e.btn('Run').click(); await e.flush();
  const runReq = e.posts(RUN)[0];
  s.unauth = true;
  await e.advance(5000);
  assert.equal(runReq.init.signal.aborted, true, 'the run request is aborted');
  assert.match(e.text(), /not signed in/);
  late.resolve({ ok: true, status: 200, json: async () => ({ ok: true, job: job({ id: 'ghost', status: 'running' }) }) });
  await e.flush();
  assert.ok(!e.all().some(x => x.getAttribute('data-job') === 'ghost'), 'the late answer is not drawn');
  assert.ok(!/Job accepted/.test(e.text()));
  assert.equal(e.timers.size, 0);
  await e.advance(600000);
  assert.equal(e.requests.filter(r => r.url === JOBS).length, 2);
  assert.equal(e.byId('cj-command').value, '["echo","draft"]');
  s.unauth = false;
  e.btn('Check again').click(); await e.flush();
  assert.match(e.text(), /Your jobs/);
  assert.equal(e.byId('cj-command').disabled, false, 'no stale review after signing back in');
  assert.equal(e.posts(RUN).length, 1);
});

await test('stale answers: an older context or job list answer arriving after a newer one is dropped; a target change discards the review', async () => {
  const slow = deferred();
  let jobsN = 0;
  const { s, route } = api({ jobsRoute: (r, st) => (++jobsN === 2 ? slow.p : json(200, { ok: true, jobs: st.jobs })) });
  const e = env({ route });
  await e.flush();
  e.btn('Refresh').click(); await e.flush(); // #2 hangs
  s.jobs = [job({ id: 'fresh', status: 'succeeded', cleanup: 'done' })];
  e.btn('Refresh').click(); await e.flush(); // #3 answers
  assert.ok(e.all().some(x => x.getAttribute('data-job') === 'fresh'));
  slow.resolve({ ok: true, status: 200, json: async () => ({ ok: true, jobs: [job({ id: 'old', status: 'running' })] }) });
  await e.flush();
  assert.ok(!e.all().some(x => x.getAttribute('data-job') === 'old'), 'older list dropped');

  const slowCtx = deferred();
  let ctxN = 0;
  s.ctxRoute = (r, st) => (++ctxN === 1 ? slowCtx.p : json(200, st.ctx));
  e.setVisibility('hidden'); e.setVisibility('visible'); await e.flush(); // context check #2 hangs
  e.setVisibility('hidden'); e.setVisibility('visible'); await e.flush(); // #3 answers with the current target
  slowCtx.resolve({ ok: true, status: 200, json: async () => ctxBody({ selection: { candidateId: 'cand-old', gpu: 'A100', country: 'FR', market: null } }) });
  await e.flush();
  assert.ok(!/A100/.test(e.text()), 'older context answer dropped');
  assert.match(e.text(), /RTX 4090 · DE/);
  s.ctxRoute = null;

  e.btn('Review').click(); await e.flush();
  assert.ok(e.btn('Run'));
  s.ctx = ctxBody({ selection: { candidateId: 'cand-2', gpu: 'H100', country: 'US', market: null } });
  e.setVisibility('hidden'); e.setVisibility('visible'); await e.flush();
  assert.match(e.text(), /The target changed/);
  assert.ok(!e.btn('Run'));
  assert.match(e.text(), /H100 · US/);
  assert.equal(e.posts(RUN).length, 0);
});

await test('KO/EN: switching language keeps the draft, the chosen files and the review; ?lang=ko starts in Korean', async () => {
  const { route } = api();
  const e = env({ route, search: '?lang=ko' });
  await e.flush();
  assert.equal(e.doc.documentElement.lang, 'ko');
  assert.match(e.text(), /작업 실행/);
  assert.equal(e.btn('KO').getAttribute('aria-pressed'), 'true');
  e.setCommand('["echo","유지"]');
  e.pickFiles([file('a.txt', [1, 2, 3])]);
  e.btn('검토').click(); await e.flush();
  assert.match(e.text(), /실행 전 검토/);
  e.btn('EN').click(); await e.flush();
  assert.equal(e.doc.documentElement.lang, 'en');
  assert.match(e.text(), /Review before running/);
  assert.equal(e.byId('cj-command').value, '["echo","유지"]');
  assert.match(e.text(), /a\.txt — 3 bytes/);
  e.btn('KO').click(); await e.flush();
  assert.match(e.text(), /비용이 들 수 있음/);
  const back = e.visible().find(x => x.tagName === 'A' && x.textContent === '클라우드 컴퓨터');
  assert.equal(back.getAttribute('href'), '/cloudbite/computer?lang=ko');
});

console.log(`${pass} passed`);
