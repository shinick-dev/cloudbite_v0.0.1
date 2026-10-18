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

function env({ route, language = 'en-US', search = '', hash = '', webauthn = true, create = async () => attestation() } = {}) {
  const timers = new Map(); let seq = 0, now = 0;
  const doc = { activeElement: null, title: '', documentElement: { lang: 'en' }, visibilityState: 'visible', listeners: {},
    createElement: (t) => new El(doc, t), getElementById: (id) => (id === 'cb-computer' ? root : null),
    addEventListener(t, f) { (this.listeners[t] ||= []).push(f); } };
  const root = new El(doc, 'div');
  doc.body = new El(doc, 'body'); doc.body.append(root);
  const requests = [], gets = [], creates = [], replaced = [];
  const location = { pathname: CLOUDBITE_COMPUTER_PATH, search, hash };
  const history = { state: null, replaceState(st, t, url) { replaced.push({ url, requests: requests.length, rendered: root.children.length, hashAtCall: location.hash }); location.hash = ''; } };
  const ctx = vm.createContext({
    document: doc, location, history, URLSearchParams, URL, atob, btoa, Date, Uint8Array, ArrayBuffer,
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
  return { doc, root, requests, gets, creates, replaced, location, timers, flush, advance, all, visible, btn, links, setVisibility,
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
  const ends = new Date(Date.now() + 47 * 60000).toISOString();
  const { route } = owned(state({ status: 'running', machine: MACHINE, ready: true, sessionEndsAt: ends }), { launch: () => json(200, { ok: true, url }) });
  const e = env({ route });
  await e.flush();
  assert.match(e.text(), /4 vCPU · 8 GiB RAM · 10 GiB disk/);
  assert.match(e.text(), /min left\). The machine then stops; data is kept\./);
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

console.log(`cloudbite-computer-ui: ${pass} passed`);
