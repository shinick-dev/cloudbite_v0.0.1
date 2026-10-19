// CloudBite computer files page (src/cloudbite-computer-files-page.ts) in a small fake DOM against an in-memory mock of the
// files API contract (cloudbite.files.core-contract.v1). Pins: browsing is metadata only and never fetches a body, only an
// explicit Download posts files/open and activates one same-origin content link, unconfigured storage and 401 are honest,
// UTF-8 and hostile/long names stay plain text, stale/refused renames, uncertain writes retry the exact bytes, a lost upload
// answer is reconciled through GET uploads/<id> without a second write, hash/size/conflict results are never counted as saved,
// KO/EN keeps the folder, selection, drafts and pending work, hidden tabs never poll, and the 390px CSS floor; the cloud computer
// prepare/set-up/release presses send exact bodies, explain a stopped machine and never start one; occupied = used + reserved.
// Mock API only — no live storage, browser or provider.
//   node test/cloudbite-computer-files-ui.mjs
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createHash, webcrypto } from 'node:crypto';
import {
  CLOUDBITE_COMPUTER_FILES_JS, CLOUDBITE_COMPUTER_FILES_HTML, CLOUDBITE_COMPUTER_FILES_CSS,
  CLOUDBITE_COMPUTER_FILES_PATH, CLOUDBITE_COMPUTER_FILES_JS_PATH, CLOUDBITE_COMPUTER_FILES_CSS_PATH,
} from '../src/cloudbite-computer-files-page.ts';

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log('ok', name); };

const API = '/api/cloudbite/computer/files';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const sha = (b) => createHash('sha256').update(b).digest('hex');
const MiB = 1024 * 1024;

// ───────────────────────── fake DOM ─────────────────────────

class El {
  constructor(doc, tag) { this.doc = doc; this.tagName = tag.toUpperCase(); this.children = []; this.attrs = {}; this.listeners = {}; this.parent = null;
    this.className = ''; this._text = ''; this.value = ''; this.disabled = false; this.hidden = false; this.checked = false; this.id = ''; this.files = null; }
  get textContent() { return this._text + this.children.map((c) => typeof c === 'string' ? c : c.textContent).join(''); }
  set textContent(v) { for (const c of this.children) if (typeof c !== 'string') c.parent = null; this.children = []; this._text = String(v); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }
  dispatch(t) { for (const f of this.listeners[t] || []) f({ type: t, target: this, preventDefault() {} }); }
  append(...ns) { for (const n of ns) { if (typeof n === 'string') { this.children.push(n); continue; } if (n.parent) n.remove(); n.parent = this; this.children.push(n); } }
  replaceChildren(...ns) { for (const c of this.children) if (typeof c !== 'string') c.parent = null; this.children = []; this._text = ''; this.append(...ns); }
  remove() { if (this.parent) { this.parent.children = this.parent.children.filter((c) => c !== this); this.parent = null; } }
  focus() { this.doc.focused = this; }
  click() {
    if (this.disabled) return;
    if (this.tagName === 'A') this.doc.activated.push({ href: this.getAttribute('href'), download: this.getAttribute('download'), shown: this.shown() });
    this.dispatch('click');
  }
  *walk() { for (const c of this.children) if (typeof c !== 'string') { yield c; yield* c.walk(); } }
  shown() { let n = this; while (n) { if (n.hidden) return false; n = n.parent; } return true; }
}

// ───────────────────────── mock files API ─────────────────────────

const respond = (status, body) => Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body });
const err = (status, code, retryable = false) => respond(status, { error: { code, message: 'x', retryable } });
const fold = (n) => n.normalize('NFC').toLowerCase();
let idn = 0;
const id = (p) => `${p}_${(++idn).toString(36).padStart(8, 'a')}`;

function server(o = {}) {
  const s = {
    status: { catalog: 'configured', blobs: 'configured', blobKind: 'r2', writerEpoch: 3, writerMachine: null, usedBytes: 5 * MiB, reservedBytes: 0,
      quotaBytes: 10 * 1024 * MiB, maxFileBytes: 2048 * MiB, pendingUploads: 0, dirtyFiles: 0, pinnedFiles: 0, ...(o.status || {}) },
    entries: new Map(), uploads: new Map(), versions: [], memo: new Map(), unauth: !!o.unauth, faults: {}, bodies: new Map(),
  };
  const add = (e) => { const full = { parentId: 'root', kind: 'file', size: 0, mtime: 1_800_000_000_000, currentVersion: null, versionSeq: 0, pinned: false, state: 'remote', rev: 1, ...e };
    s.entries.set(full.fileId, full); return full; };
  s.add = add;
  const fault = (k) => { const q = s.faults[k]; return q && q.length ? q.shift() : null; };
  const ok = (body) => respond(200, body);
  const children = (p) => [...s.entries.values()].filter((e) => e.parentId === p).sort((a, b) => (fold(a.name) < fold(b.name) ? -1 : 1));
  s.route = (r) => {
    if (s.unauth) return err(401, 'unauthorized');
    const u = new URL(r.url, 'http://x');
    const p = u.pathname, f = fault(`${r.method} ${p.replace(/u_[a-z0-9]+/, ':u')}`);
    if (f && f.before) return f.before();
    const out = handle(r, u, p);
    if (f && f.after) return f.after(out);
    return out;
  };
  function handle(r, u, p) {
    if (r.method === 'GET' && p === `${API}/status`) return ok({ status: s.status });
    if (s.status.catalog !== 'configured') return err(503, 'store_not_configured');
    if (r.method === 'GET' && p === API) {
      const parentId = u.searchParams.get('parentId'), limit = Number(u.searchParams.get('limit')), at = Number(u.searchParams.get('cursor') || 0);
      if (parentId !== 'root' && !s.entries.has(parentId)) return err(404, 'not_found');
      const all = children(parentId), page = all.slice(at, at + limit);
      return ok({ parentId, entries: page.map((e) => ({ ...e })), nextCursor: at + limit < all.length ? String(at + limit) : null });
    }
    const b = r.body;
    if (r.method === 'POST' && p === `${API}/create`) {
      const m = s.memo.get(b.requestId);
      if (m) return m.raw === r.raw ? ok({ entry: { ...s.entries.get(m.fileId) } }) : err(409, 'request_conflict');
      if (children(b.parentId).some((e) => fold(e.name) === fold(b.name))) return err(409, 'name_conflict');
      const e = add({ fileId: id('f'), parentId: b.parentId, name: b.name, kind: b.kind });
      s.memo.set(b.requestId, { raw: r.raw, fileId: e.fileId });
      return ok({ entry: { ...e } });
    }
    if (r.method === 'POST' && p === `${API}/rename`) {
      const e = s.entries.get(b.fileId);
      if (!e) return err(404, 'not_found');
      const m = s.memo.get(b.requestId);
      if (m) return ok({ entry: { ...e } });
      if (e.rev !== b.expectedRev) return err(409, 'stale_revision');
      if (children(e.parentId).some((x) => x !== e && fold(x.name) === fold(b.name))) return err(409, 'name_conflict');
      e.name = b.name; e.rev++; s.memo.set(b.requestId, { raw: r.raw });
      return ok({ entry: { ...e } });
    }
    if (r.method === 'POST' && p === `${API}/pin`) {
      const e = s.entries.get(b.fileId);
      e.pinned = b.pinned; e.rev++;
      return ok({ entry: { ...e } });
    }
    if (r.method === 'POST' && p === `${API}/open`) {
      const e = s.entries.get(b.fileId);
      if (!e || !e.currentVersion) return err(404, 'not_found');
      return ok({ descriptor: { fileId: e.fileId, versionId: b.versionId || e.currentVersion, versionSeq: e.versionSeq, size: e.size, sha256: 'a'.repeat(64),
        committedAt: 1, writerEpoch: 3, baseVersion: null, name: e.name } });
    }
    if (r.method === 'POST' && p === `${API}/uploads/begin`) {
      const m = s.memo.get(b.requestId);
      if (m) return m.raw === r.raw ? ok({ upload: { ...s.uploads.get(m.uploadId) } }) : err(409, 'request_conflict');
      if (b.writerEpoch !== s.status.writerEpoch) return err(409, 'stale_writer');
      const up = { uploadId: id('u'), fileId: b.fileId, baseVersion: b.baseVersion, writerEpoch: b.writerEpoch, size: b.size, sha256: b.sha256, phase: 'begun',
        createdAt: 1, expiresAt: 2, result: null };
      s.uploads.set(up.uploadId, up); s.memo.set(b.requestId, { raw: r.raw, uploadId: up.uploadId });
      return ok({ upload: { ...up } });
    }
    const um = p.match(/^\/api\/cloudbite\/computer\/files\/uploads\/(u_[a-z0-9]+)(\/body|\/commit)?$/);
    if (um) {
      const up = s.uploads.get(um[1]);
      if (!up) return err(404, 'not_found');
      if (r.method === 'GET' && !um[2]) return ok({ upload: { ...up } });
      if (r.method === 'PUT' && um[2] === '/body') {
        if (r.raw.length !== up.size) return err(422, 'size_mismatch');
        s.bodies.set(up.uploadId, r.raw); if (up.phase === 'begun') up.phase = 'body_written';
        return ok({ upload: { ...up } });
      }
      if (r.method === 'POST' && um[2] === '/commit') {
        if (up.result) return ok({ result: { ...up.result } });
        const body = s.bodies.get(up.uploadId);
        if (!body) return err(422, 'body_missing', true);
        if (sha(body) !== up.sha256) return err(422, 'hash_mismatch');
        const e = s.entries.get(up.fileId), vid = id('v');
        const conflict = !!s.conflictNext;
        const res = { status: conflict ? 'conflict' : 'committed', fileId: e.fileId, versionId: vid, versionSeq: 1, size: up.size, sha256: up.sha256,
          conflictFileId: conflict ? id('f') : null, durable: true };
        if (!conflict) { e.currentVersion = vid; e.versionSeq = 1; e.size = up.size; }
        s.versions.push(res); up.phase = res.status; up.result = res;
        return ok({ result: { ...res } });
      }
    }
    // cloud computer bridge (mock): the agent reply shape the integration route passes through; never a machine start
    if (r.method === 'POST' && s.cloud && [`${API}/materialize`, `${API}/agent/configure`, `${API}/close`].includes(p)) {
      if (s.status.blobs !== 'configured') return err(503, 'store_not_configured');
      if (!s.cloud.running) return err(409, 'not_running');
      if (p.endsWith('/configure')) { s.cloud.installed = true; return ok({ ok: true, installed: { ok: true } }); }
      if (!s.cloud.installed) return err(409, 'agent_not_installed');
      if (p.endsWith('/close')) return ok({ ok: true, closed: { ok: true } });
      const e = s.entries.get(b.fileId);
      return ok({ ok: true, open: { leaseId: b.requestId.replace(/-/g, ''), path: `/home/daytona/CloudFiles/${e.name}`, state: 'open', versionId: b.versionId,
        fetchedBytes: e.size }, workspace: '~/CloudFiles', launched: false });
    }
    return err(404, 'not_found');
  }
  return s;
}

function env({ srv = server(), language = 'en-US', search = '?lang=en', withHistory = false } = {}) {
  const urls = [];
  const history = withHistory ? { state: null, replaceState(st, _t, url) { urls.push(url); } } : undefined;
  const doc = { title: '', documentElement: { lang: 'en' }, visibilityState: 'visible', listeners: {}, activated: [], focused: null,
    createElement: (t) => new El(doc, t), getElementById: (i) => (i === 'cb-computer-files' ? root : null),
    addEventListener(t, f) { (this.listeners[t] ||= []).push(f); } };
  const root = new El(doc, 'div');
  const requests = [];
  const timers = new Map(); let tid = 0;
  const ctx = vm.createContext({
    document: doc, location: { pathname: CLOUDBITE_COMPUTER_FILES_PATH, search, hash: '' }, URLSearchParams, URL, Date, Uint8Array, Intl,
    TextEncoder, AbortController, crypto: webcrypto, navigator: { language }, ...(history ? { history } : {}),
    setTimeout: (fn, ms) => { const i = ++tid; timers.set(i, { fn, ms }); return i; }, clearTimeout: (i) => { timers.delete(i); },
    fetch: (url, init = {}) => {
      const raw = typeof init.body === 'string' ? init.body : init.body === undefined ? undefined : Buffer.from(init.body);
      const r = { url, method: init.method || 'GET', raw, body: typeof raw === 'string' ? JSON.parse(raw) : undefined, init };
      requests.push(r);
      if (init.signal?.aborted) return Promise.reject(new Error('aborted'));
      return srv.route(r);
    },
  });
  // crypto.subtle.digest settles on the thread pool, so let real time pass as well as the microtask queue
  const flush = async () => { for (let i = 0; i < 40; i++) { await new Promise((r) => setImmediate(r)); if (i % 8 === 7) await new Promise((r) => setTimeout(r, 2)); } };
  vm.runInContext(CLOUDBITE_COMPUTER_FILES_JS, ctx);
  const all = () => [...root.walk()];
  const visible = () => all().filter((e) => e.shown());
  const btn = (text) => visible().find((e) => e.tagName === 'BUTTON' && e.textContent === text);
  const btnLike = (re) => visible().find((e) => e.tagName === 'BUTTON' && re.test(e.textContent));
  const byId = (i) => all().find((e) => e.id === i);
  const text = () => visible().map((e) => e._text + e.children.filter((c) => typeof c === 'string').join('')).filter(Boolean).join(' | ');
  const posts = (p) => requests.filter((r) => r.method === 'POST' && r.url === `${API}${p}`);
  const type = (i, v) => { const c = byId(i); c.value = v; c.dispatch('input'); };
  const row = (name) => visible().find((e) => e.tagName === 'LI' && e.children[0]?.children?.[0]?.textContent === name);
  const rowBtn = (name) => row(name).children[0];
  const pick = (file) => { const c = byId('cf-upload-file'); c.files = file ? [file] : []; c.dispatch('change'); };
  const setVisibility = (v) => { doc.visibilityState = v; for (const f of doc.listeners.visibilitychange || []) f(); };
  return { srv, doc, requests, timers, flush, all, visible, btn, btnLike, byId, text, posts, type, row, rowBtn, pick, setVisibility, urls };
}
const fakeFile = (name, bytes, o = {}) => ({ name, size: o.size ?? bytes.length, type: 'application/octet-stream', reads: 0,
  async arrayBuffer() { this.reads++; if (o.noRead) throw new Error('must not be read'); const c = Uint8Array.from(bytes); return c.buffer; } });
const seeded = (o) => {
  const s = server(o);
  s.add({ fileId: 'f_docs', name: 'Documents', kind: 'dir' });
  s.add({ fileId: 'f_report', name: '보고서 2026 – 최종.pdf', size: 2_500_000, currentVersion: 'v_r1', versionSeq: 4, state: 'local', pinned: true });
  s.add({ fileId: 'f_empty', name: 'empty.txt', size: 0, currentVersion: null });
  s.add({ fileId: 'f_inner', parentId: 'f_docs', name: 'inner.md', size: 12, currentVersion: 'v_i1', versionSeq: 1 });
  return s;
};
const listGets = (e) => e.requests.filter((r) => r.method === 'GET' && new URL(r.url, 'http://x').pathname === API);
const noBody = (e) => e.requests.every((r) => !/\/content\/|\/open$|\/body$/.test(r.url));

// ───────────────────────── tests ─────────────────────────

await test('page: same-origin script and style only, no inline code, storage, WebAuthn or absolute URL; 48px targets, 16px inputs, 390px floor', async () => {
  assert.equal(CLOUDBITE_COMPUTER_FILES_PATH, '/cloudbite/computer/files');
  assert.equal(CLOUDBITE_COMPUTER_FILES_JS_PATH, '/cloudbite/computer/files.js');
  assert.equal(CLOUDBITE_COMPUTER_FILES_CSS_PATH, '/cloudbite/computer/files.css');
  assert.ok(CLOUDBITE_COMPUTER_FILES_HTML.includes(`<script src="${CLOUDBITE_COMPUTER_FILES_JS_PATH}" defer></script>`));
  assert.ok(CLOUDBITE_COMPUTER_FILES_HTML.includes(`<link rel="stylesheet" href="${CLOUDBITE_COMPUTER_FILES_CSS_PATH}">`));
  assert.ok(!/<script>|style=|<iframe|https?:\/\//.test(CLOUDBITE_COMPUTER_FILES_HTML.replace(/<script src[^>]+><\/script>/, '')));
  assert.ok(!/localStorage|sessionStorage|indexedDB|document\.cookie|innerHTML|outerHTML|insertAdjacentHTML|eval\(|new Function|<iframe|postMessage/.test(CLOUDBITE_COMPUTER_FILES_JS));
  assert.ok(!/navigator\.credentials|PublicKeyCredential|Authorization|Bearer/i.test(CLOUDBITE_COMPUTER_FILES_JS));
  assert.ok(!/https?:\/\//.test(CLOUDBITE_COMPUTER_FILES_JS));
  assert.ok(!/@import|url\(/i.test(CLOUDBITE_COMPUTER_FILES_CSS));
  const base = CLOUDBITE_COMPUTER_FILES_CSS.split('@media')[0];
  for (const m of base.matchAll(/(?:^|[;{])\s*(?:width|min-width)\s*:\s*(\d+)px/g)) assert.ok(Number(m[1]) <= 358, `fixed width ${m[0]} breaks 390px`);
  assert.ok(!/(?:^|[;{])\s*white-space\s*:\s*nowrap/.test(base), 'no unbreakable text at phone width');
  assert.match(CLOUDBITE_COMPUTER_FILES_CSS, /\.cf-btn\{min-height:48px/);
  assert.match(CLOUDBITE_COMPUTER_FILES_CSS, /\.cf-lang-btn\{min-width:48px;min-height:48px/);
  assert.match(CLOUDBITE_COMPUTER_FILES_CSS, /\.cf-row-btn\{width:100%;min-height:56px/);
  assert.match(CLOUDBITE_COMPUTER_FILES_CSS, /\.cf-input\{[^}]*font-size:16px/);
  assert.match(CLOUDBITE_COMPUTER_FILES_CSS, /\.cf-file\{[^}]*min-height:48px[^}]*font-size:16px/);
  assert.match(CLOUDBITE_COMPUTER_FILES_CSS, /\.cf-name\{[^}]*overflow-wrap:anywhere/);
  assert.match(CLOUDBITE_COMPUTER_FILES_CSS, /\.cf-grid\{display:grid;grid-template-columns:minmax\(0,1fr\)/);
  assert.match(CLOUDBITE_COMPUTER_FILES_CSS, /--navy:#142440/);
  // storage/detail facts: a long label wraps, the value column keeps at least 7rem (no one-letter vertical stack at 320–390px)
  assert.match(CLOUDBITE_COMPUTER_FILES_CSS, /\.cf-facts\{display:grid;grid-template-columns:minmax\(0,max-content\) minmax\(7rem,1fr\)/);
});

await test('browse: status then one metadata page; UTF-8, hostile and 255-byte names are plain text; folders navigate; never a body fetch', async () => {
  const s = seeded();
  const hostile = '<img src=x onerror=alert(1)>.txt', rtl = '‮exe.txt', long = '가'.repeat(85);
  assert.equal(Buffer.byteLength(long), 255);
  for (const [i, n] of [hostile, rtl, long].entries()) s.add({ fileId: `f_h${i}`, name: n, size: 1, currentVersion: `v_h${i}`, versionSeq: 1 });
  const e = env({ srv: s });
  await e.flush();
  assert.deepEqual(e.requests.map((r) => `${r.method} ${r.url}`), [`GET ${API}/status`, `GET ${API}?parentId=root&limit=100`]);
  for (const n of ['Documents', '보고서 2026 – 최종.pdf', 'empty.txt', hostile, rtl, long]) {
    const nameEl = e.row(n).children[0].children[0];
    assert.equal(nameEl.tagName, 'BDI'); assert.equal(nameEl.textContent, n);
  }
  assert.ok(!e.all().some((x) => x.tagName === 'IMG' || x.tagName === 'SCRIPT'), 'names never become markup');
  const t = e.text();
  assert.match(t, /Copy on cloud computer/); assert.match(t, /Keep requested/); assert.match(t, /No content uploaded yet/);
  assert.match(t, /2\.4 MiB/);
  assert.match(t, /Download puts a separate copy on this device/); assert.match(t, /it does not open an app and never starts the computer/);
  // selecting a file only expands its details
  e.rowBtn('보고서 2026 – 최종.pdf').click(); await e.flush();
  assert.equal(e.rowBtn('보고서 2026 – 최종.pdf').getAttribute('aria-expanded'), 'true');
  assert.ok(e.btn('Download to this device'));
  assert.ok(!e.btn('Delete') && !/delete/i.test(e.text()), 'no deletion control yet');
  // folders
  e.rowBtn('Documents').click(); await e.flush();
  assert.equal(listGets(e).at(-1).url, `${API}?parentId=f_docs&limit=100`);
  assert.ok(e.row('inner.md')); assert.match(e.text(), /Folder: +\| My files \/ Documents/);
  assert.equal(e.doc.focused?.tagName, 'H2', 'focus moves to the list heading');
  e.btn('Up one folder').click(); await e.flush();
  assert.equal(listGets(e).at(-1).url, `${API}?parentId=root&limit=100`);
  assert.ok(e.row('Documents'));
  assert.ok(noBody(e)); assert.equal(e.doc.activated.length, 0);
  assert.ok(e.requests.every((r) => r.method === 'GET'), 'browsing never writes');
});

await test('browse: Show more follows the cursor and appends; hidden tabs never poll, a visible tab re-reads once', async () => {
  const s = server();
  for (let i = 0; i < 130; i++) s.add({ fileId: `f_n${String(i).padStart(3, '0')}`, name: `file-${String(i).padStart(3, '0')}.txt`, size: i, currentVersion: `v_n${i}`, versionSeq: 1 });
  const e = env({ srv: s });
  await e.flush();
  assert.ok(e.row('file-099.txt')); assert.ok(!e.row('file-100.txt'));
  e.btn('Show more').click(); await e.flush();
  assert.equal(listGets(e).at(-1).url, `${API}?parentId=root&cursor=100&limit=100`);
  assert.ok(e.row('file-129.txt')); assert.equal(e.btn('Show more'), undefined);
  assert.equal(e.timers.size, 0, 'no timers: nothing polls');
  const n = e.requests.length;
  e.setVisibility('hidden'); await e.flush();
  assert.equal(e.requests.length, n);
  e.setVisibility('visible'); await e.flush();
  assert.deepEqual(e.requests.slice(n).map((r) => r.url), [`${API}/status`, `${API}?parentId=root&limit=100`]);
  assert.ok(noBody(e));
});

await test('download: only an explicit press posts files/open and activates one same-origin content link that stays as the fallback', async () => {
  const e = env({ srv: seeded() });
  await e.flush();
  e.rowBtn('empty.txt').click(); await e.flush();
  assert.equal(e.btn('Download to this device').disabled, true, 'no content: nothing to download');
  assert.match(e.text(), /no saved content to download yet/);
  e.rowBtn('보고서 2026 – 최종.pdf').click(); await e.flush();
  assert.equal(e.posts('/open').length, 0);
  e.btn('Download to this device').click(); await e.flush();
  const [open] = e.posts('/open');
  assert.equal(open.raw, JSON.stringify({ fileId: 'f_report', versionId: 'v_r1' }));
  assert.equal(e.doc.activated.length, 1);
  assert.deepEqual(e.doc.activated[0], { href: `${API}/content/f_report?versionId=v_r1`, download: '보고서 2026 – 최종.pdf', shown: true });
  const fallback = e.visible().find((x) => x.tagName === 'A' && x.textContent === 'Download did not start? Save the file');
  assert.equal(fallback.getAttribute('href'), `${API}/content/f_report?versionId=v_r1`);
  assert.match(e.text(), /separate copy\. Edits to it are not saved back/);
  assert.ok(!e.requests.some((r) => r.url.includes('/content/')), 'the page itself never fetches the body');
});

await test('unconfigured storage is honest: no list, no writes, uploads off; contents storage missing keeps names but no transfer', async () => {
  const e = env({ srv: server({ status: { catalog: 'not_configured', blobs: 'not_configured' } }) });
  await e.flush();
  assert.deepEqual(e.requests.map((r) => r.url), [`${API}/status`]);
  assert.match(e.text(), /File storage is not configured for this Cloudbite yet\. Nothing is stored/);
  assert.match(e.text(), /File list \| Not configured/);
  assert.equal(e.btn('Create folder').disabled, true);
  assert.equal(e.btn('Upload').disabled, true);
  assert.equal(e.byId('cf-upload-file').disabled, true);
  assert.match(e.text(), /Uploads are off until file storage is configured/);

  const b = env({ srv: seeded({ status: { blobs: 'not_configured' } }) });
  await b.flush();
  assert.ok(b.row('Documents'));
  assert.match(b.text(), /downloads and uploads are off/);
  b.rowBtn('보고서 2026 – 최종.pdf').click(); await b.flush();
  assert.equal(b.btn('Download to this device').disabled, true);
  assert.equal(b.btn('Upload').disabled, true);
});

await test('401 shows the main-page sign-in link in the current language and sends nothing else', async () => {
  const e = env({ srv: server({ unauth: true }), search: '?lang=ko' });
  await e.flush();
  const a = e.visible().find((x) => x.tagName === 'A' && x.textContent === '클라우드 컴퓨터 페이지에서 로그인');
  assert.equal(a.getAttribute('href'), '/cloudbite/computer?lang=ko');
  assert.deepEqual(e.requests.map((r) => `${r.method} ${r.url}`), [`GET ${API}/status`]);
});

await test('rename: exact body with expectedRev; stale revision refreshes and keeps the draft; refused and invalid names; success updates the row', async () => {
  const s = seeded();
  const e = env({ srv: s });
  await e.flush();
  e.rowBtn('empty.txt').click(); await e.flush();
  e.btn('Rename').click(); await e.flush();
  assert.equal(e.byId('cf-rename-name').value, 'empty.txt');
  e.type('cf-rename-name', 'bad/name'); e.btn('Save name').click(); await e.flush();
  assert.match(e.text(), /That name is not allowed here/); assert.equal(e.posts('/rename').length, 0);
  e.type('cf-rename-name', 'trailing. '); e.btn('Save name').click(); await e.flush();
  assert.equal(e.posts('/rename').length, 0);
  // somebody else renamed it meanwhile
  s.entries.get('f_empty').rev = 7;
  const before = listGets(e).length;
  e.type('cf-rename-name', 'notes.txt'); e.btn('Save name').click(); await e.flush();
  const [first] = e.posts('/rename');
  assert.match(first.body.requestId, UUID);
  assert.equal(first.raw, JSON.stringify({ requestId: first.body.requestId, fileId: 'f_empty', expectedRev: 1, name: 'notes.txt' }));
  assert.match(e.text(), /changed since the list loaded/);
  assert.equal(listGets(e).length, before + 1, 'list refreshed');
  assert.equal(e.byId('cf-rename-name').value, 'notes.txt', 'draft kept');
  // case-insensitive collision is refused by the server
  e.type('cf-rename-name', 'DOCUMENTS'); e.btn('Save name').click(); await e.flush();
  assert.equal(JSON.parse(e.posts('/rename')[1].raw).expectedRev, 7);
  assert.match(e.text(), /already uses that name/);
  e.type('cf-rename-name', 'notes.txt'); e.btn('Save name').click(); await e.flush();
  assert.match(e.text(), /Renamed\./);
  assert.ok(e.row('notes.txt')); assert.ok(!e.row('empty.txt'));
  assert.equal(s.entries.get('f_empty').name, 'notes.txt');
  const ids = e.posts('/rename').map((r) => r.body.requestId);
  assert.equal(new Set(ids).size, 3, 'each new attempt is a new request');
});

await test('new folder and pin: an uncertain answer retries the byte-identical request; pin sends the exact body', async () => {
  const s = seeded();
  s.faults[`POST ${API}/create`] = [{ after: (out) => out.then(() => err(503, 'catalog_unavailable', true)) }];
  const e = env({ srv: s });
  await e.flush();
  e.type('cf-folder-name', 'Projects'); e.btn('Create folder').click(); await e.flush();
  assert.match(e.text(), /Not confirmed: create folder Projects/);
  assert.equal(e.btn('Create folder').disabled, true, 'no second write while unconfirmed');
  e.btn('Retry same request').click(); await e.flush();
  const [a, b] = e.posts('/create');
  assert.equal(b.raw, a.raw, 'byte-identical retry');
  assert.deepEqual(a.body, { requestId: a.body.requestId, parentId: 'root', name: 'Projects', kind: 'dir' });
  assert.equal([...s.entries.values()].filter((x) => x.name === 'Projects').length, 1, 'one folder, not two');
  assert.match(e.text(), /Folder Projects created/);
  assert.ok(e.row('Projects'));
  e.rowBtn('보고서 2026 – 최종.pdf').click(); await e.flush();
  e.btn('Remove keep request').click(); await e.flush();
  const [pin] = e.posts('/pin');
  assert.equal(pin.raw, JSON.stringify({ requestId: pin.body.requestId, fileId: 'f_report', pinned: false }));
  assert.match(e.text(), /Keep request removed/);
  assert.ok(e.btn('Request keeping on cloud computer'));
});

const content = Buffer.from('hello cloudbite — 파일 내용\n'.repeat(40));

await test('upload: create → begin → body → commit; uncertain create and a lost commit answer reuse the same IDs and reconcile, never a duplicate', async () => {
  const s = seeded();
  s.faults[`POST ${API}/create`] = [{ before: () => err(503, 'catalog_unavailable', true) }];
  s.faults[`POST ${API}/uploads/:u/commit`] = [{ after: (out) => out.then(() => err(503, 'commit_unknown', true)) }];
  const e = env({ srv: s });
  await e.flush();
  assert.match(e.text(), /Up to 32 MiB per file for now/);
  const f = fakeFile('메모 <b>.txt', content);
  e.pick(f); await e.flush();
  assert.equal(e.byId('cf-upload-name').value, '메모 <b>.txt');
  e.btn('Upload').click(); await e.flush();
  assert.match(e.text(), /No definite answer from the server\. Continue checks/);
  assert.equal(e.byId('cf-upload-file').disabled, true, 'the selection is frozen while unconfirmed');
  assert.equal(e.btn('Upload'), undefined, 'no fresh upload while unconfirmed');
  e.btn('Continue same upload').click(); await e.flush();
  // the commit answer was lost after the server committed
  assert.match(e.text(), /No definite answer/);
  e.btn('Continue same upload').click(); await e.flush();
  const creates = e.posts('/create'), begins = e.posts('/uploads/begin');
  assert.equal(creates.length, 2); assert.equal(creates[1].raw, creates[0].raw);
  assert.deepEqual(creates[0].body, { requestId: creates[0].body.requestId, parentId: 'root', name: '메모 <b>.txt', kind: 'file' });
  assert.equal(begins.length, 1);
  const fileId = [...s.entries.values()].find((x) => x.name === '메모 <b>.txt').fileId;
  assert.deepEqual(begins[0].body, { requestId: begins[0].body.requestId, fileId, baseVersion: null, writerEpoch: 3, size: content.length, sha256: sha(content) });
  assert.notEqual(begins[0].body.requestId, creates[0].body.requestId);
  const puts = e.requests.filter((r) => r.method === 'PUT');
  assert.equal(puts.length, 1); assert.ok(puts[0].raw.equals(content), 'raw bytes');
  assert.equal(puts[0].init.headers['content-type'], 'application/octet-stream');
  const commits = e.requests.filter((r) => r.url.endsWith('/commit'));
  assert.equal(commits.length, 1, 'reconciled through GET, commit not repeated');
  assert.equal(e.requests.filter((r) => r.method === 'GET' && /\/uploads\/u_/.test(r.url)).length, 1);
  assert.equal(s.versions.length, 1); assert.equal([...s.entries.values()].filter((x) => x.name === '메모 <b>.txt').length, 1);
  assert.match(e.text(), /Saved 메모 <b>\.txt\. The server verified its size and checksum/);
  assert.equal(f.reads, 1);
  assert.ok(e.row('메모 <b>.txt'));
});

await test('upload: a lost body answer is reconciled (no second PUT); stale writer and hash mismatch are definite and never saved', async () => {
  const s = seeded();
  s.faults[`PUT ${API}/uploads/:u/body`] = [{ after: (out) => out.then(() => err(502, 'blob_unavailable', true)) }];
  const e = env({ srv: s });
  await e.flush();
  e.pick(fakeFile('a.bin', content)); e.btn('Upload').click(); await e.flush();
  e.btn('Continue same upload').click(); await e.flush();
  assert.equal(e.requests.filter((r) => r.method === 'PUT').length, 1);
  assert.match(e.text(), /Saved a\.bin/);

  s.status.writerEpoch = 4; // another machine took over after this page read the status
  e.pick(fakeFile('b.bin', content)); e.btn('Upload').click(); await e.flush();
  assert.match(e.text(), /Another computer became the writer/);
  assert.equal(e.btn('Continue same upload'), undefined, 'a definite refusal is not retried');
  e.btn('Forget it').click(); await e.flush();

  s.status.writerEpoch = 4;
  const corrupt = Buffer.from(content);
  s.faults[`PUT ${API}/uploads/:u/body`] = [{ before: () => { s.bodies.set([...s.uploads.keys()].at(-1), Buffer.from('other bytes')); return respond(200, { upload: { ...[...s.uploads.values()].at(-1), phase: 'body_written' } }); } }];
  e.btn('Refresh').click(); await e.flush();
  e.pick(fakeFile('c.bin', content)); e.btn('Upload').click(); await e.flush();
  assert.match(e.text(), /The server received different content than this file\. Nothing was saved/);
  assert.equal(s.versions.length, 1, 'only a.bin was saved');
});

await test('upload: a result with another size or checksum is not counted as saved; a conflict explains the kept sibling copy', async () => {
  const s = seeded();
  s.faults[`POST ${API}/uploads/:u/commit`] = [{ after: (out) => out.then((r) => r.json()).then((b) => respond(200, { result: { ...b.result, sha256: 'b'.repeat(64) } })) }];
  const e = env({ srv: s });
  await e.flush();
  e.pick(fakeFile('x.bin', content)); e.btn('Upload').click(); await e.flush();
  assert.match(e.text(), /reported a different size or checksum, so this upload is not counted as saved/);
  assert.ok(!/Saved x\.bin/.test(e.text()));
  e.btn('Forget it').click(); await e.flush();
  s.conflictNext = true;
  e.pick(fakeFile('y.bin', content)); e.btn('Upload').click(); await e.flush();
  assert.match(e.text(), /changed by someone else first\. Your upload was kept as a separate conflict copy in the same folder; nothing was overwritten/);
  assert.ok(!/Saved y\.bin/.test(e.text()));
});

await test('upload: over 32 MiB is refused before reading; the server limit lowers it further', async () => {
  const e = env({ srv: seeded() });
  await e.flush();
  const big = fakeFile('video.mp4', Buffer.alloc(1), { size: 32 * MiB + 1, noRead: true });
  e.pick(big); await e.flush();
  assert.equal(e.btn('Upload').disabled, true);
  assert.match(e.text(), /This file is 32 MiB\. Uploads here are limited to 32 MiB per file for now/);
  assert.equal(big.reads, 0); assert.equal(e.posts('/create').length, 0);
  const small = env({ srv: seeded({ status: { maxFileBytes: 4 * MiB } }) });
  await small.flush();
  assert.match(small.text(), /Up to 4 MiB per file for now/);
  small.pick(fakeFile('five.bin', Buffer.alloc(1), { size: 5 * MiB, noRead: true })); await small.flush();
  assert.equal(small.btn('Upload').disabled, true);
});

await test('KO/EN switch keeps the folder, selection, drafts and the pending write; links follow the language', async () => {
  const s = seeded();
  s.faults[`POST ${API}/rename`] = [{ before: () => err(503, 'catalog_busy', true) }];
  const e = env({ srv: s, language: 'ko-KR', search: '' });
  await e.flush();
  assert.equal(e.doc.documentElement.lang, 'ko');
  e.rowBtn('Documents').click(); await e.flush();
  e.rowBtn('inner.md').click(); await e.flush();
  e.btn('이름 바꾸기').click(); await e.flush();
  e.type('cf-rename-name', 'inner-2.md');
  e.type('cf-folder-name', 'draft-folder');
  e.btn('이름 저장').click(); await e.flush();
  assert.match(e.text(), /확인 안 됨: inner-2\.md 으로 이름 바꾸기/);
  const n = e.requests.length;
  e.btn('EN').click(); await e.flush();
  assert.equal(e.doc.documentElement.lang, 'en');
  assert.equal(e.requests.length, n, 'switching sends nothing');
  assert.match(e.text(), /Not confirmed: rename to inner-2\.md/);
  assert.match(e.text(), /My files \/ Documents/);
  assert.equal(e.rowBtn('inner.md').getAttribute('aria-expanded'), 'true');
  assert.equal(e.byId('cf-rename-name').value, 'inner-2.md');
  assert.equal(e.byId('cf-folder-name').value, 'draft-folder');
  const back = e.visible().find((x) => x.tagName === 'A' && x.textContent === 'Cloud computer');
  assert.equal(back.getAttribute('href'), '/cloudbite/computer?lang=en');
  e.btn('Retry same request').click(); await e.flush();
  const [a, b] = e.posts('/rename');
  assert.equal(b.raw, a.raw);
  assert.match(e.text(), /Renamed\./);
});

await test('sign-out during an upload keeps it unconfirmed; after signing in again Continue reuses the same IDs', async () => {
  const s = seeded();
  s.faults[`POST ${API}/uploads/begin`] = [{ before: () => { s.unauth = true; return err(401, 'unauthorized'); } }];
  const e = env({ srv: s });
  await e.flush();
  e.pick(fakeFile('later.bin', content)); e.btn('Upload').click(); await e.flush();
  assert.match(e.text(), /not signed in/);
  s.unauth = false;
  e.btn('Check again').click(); await e.flush();
  assert.match(e.text(), /No definite answer/);
  e.btn('Continue same upload').click(); await e.flush();
  const begins = e.posts('/uploads/begin');
  assert.equal(begins.length, 2); assert.equal(begins[1].raw, begins[0].raw);
  assert.equal(e.posts('/create').length, 1);
  assert.match(e.text(), /Saved later\.bin/);
});

const netDown = { before: () => Promise.reject(new Error('offline')) };
const badShape = { before: () => respond(200, { parentId: 'root', entries: 'nope', nextCursor: null }) };

await test('first list read that fails (network or bad shape) ends loading: only the failure shows, the list is not called connected; Refresh recovers', async () => {
  for (const [f, re] of [[netDown, /Could not refresh the list\. Network error — nothing was confirmed\./], [badShape, /Could not refresh the list\. The server answered in an unexpected way\./]]) {
    const s = seeded();
    s.faults[`GET ${API}`] = [f];
    const e = env({ srv: s });
    await e.flush();
    assert.match(e.text(), re);
    assert.ok(!/Loading…/.test(e.text()), 'no indefinite loading line after a definite failure');
    assert.ok(!/This folder is empty/.test(e.text()), 'a failure is not an empty folder');
    assert.match(e.text(), /File list \| Configured — list not read/);
    assert.ok(!/File list \| Connected/.test(e.text()));
    e.btn('Refresh').click(); await e.flush();
    assert.ok(e.row('Documents'));
    assert.ok(!/Could not refresh/.test(e.text()));
    assert.match(e.text(), /File list \| Connected/);
    assert.match(e.text(), /File contents \| Configured/);
  }
});

await test('a refresh that fails keeps the rows already shown (list or status failure) and never shows loading or empty', async () => {
  const s = seeded();
  const e = env({ srv: s });
  await e.flush();
  e.rowBtn('보고서 2026 – 최종.pdf').click(); await e.flush();
  s.faults[`GET ${API}`] = [netDown];
  e.btn('Refresh').click(); await e.flush();
  for (const n of ['Documents', '보고서 2026 – 최종.pdf', 'empty.txt']) assert.ok(e.row(n), `${n} kept`);
  assert.equal(e.rowBtn('보고서 2026 – 최종.pdf').getAttribute('aria-expanded'), 'true', 'selection kept');
  assert.match(e.text(), /Could not refresh the list\. Network error/);
  assert.ok(!/Loading…|This folder is empty/.test(e.text()));
  s.faults[`GET ${API}/status`] = [{ before: () => err(500, 'catalog_unavailable', true) }];
  e.btn('Refresh').click(); await e.flush();
  assert.ok(e.row('Documents') && e.row('empty.txt'));
  assert.match(e.text(), /Could not refresh the list\. Rejected: catalog_unavailable/);
  e.btn('Refresh').click(); await e.flush();
  assert.ok(!/Could not refresh/.test(e.text())); assert.ok(e.row('Documents'));
});

await test('error details are worded in the language shown now, not the one active when the error happened', async () => {
  const s = seeded();
  s.faults[`GET ${API}`] = [netDown];
  const e = env({ srv: s, search: '?lang=ko' });
  await e.flush();
  assert.match(e.text(), /목록을 새로 고치지 못했습니다\. 네트워크 오류 — 확인된 것이 없습니다\./);
  e.btn('EN').click(); await e.flush();
  assert.match(e.text(), /Could not refresh the list\. Network error — nothing was confirmed\./);
  assert.ok(!/네트워크|목록을/.test(e.text()), 'no Korean detail left inside the English sentence');
  e.btn('Refresh').click(); await e.flush();
  // a known code in a download failure is explained, and re-explained after switching
  s.faults[`POST ${API}/open`] = [{ before: () => err(409, 'not_verified') }];
  e.rowBtn('보고서 2026 – 최종.pdf').click(); await e.flush();
  e.btn('Download to this device').click(); await e.flush();
  assert.match(e.text(), /Could not prepare the download\. The server could not verify this yet\./);
  e.btn('KO').click(); await e.flush();
  assert.match(e.text(), /내려받기를 준비하지 못했습니다\. 서버가 아직 확인하지 못했습니다\./);
  assert.ok(!/could not verify/.test(e.text()));
});

await test('switching language rewrites ?lang= in place (kept on reload) and keeps other query and hash; no history API is harmless', async () => {
  const e = env({ srv: seeded(), search: '?lang=ko&x=1', withHistory: true });
  await e.flush();
  assert.equal(e.urls.length, 0, 'loading does not touch the address');
  e.btn('EN').click(); await e.flush();
  assert.deepEqual(e.urls, ['/cloudbite/computer/files?lang=en&x=1']);
  const n = e.requests.length;
  e.btn('EN').click(); await e.flush();
  assert.equal(e.urls.length, 1, 'pressing the current language changes nothing');
  assert.equal(e.requests.length, n);
  const plain = env({ srv: seeded(), search: '?lang=ko' });
  await plain.flush();
  plain.btn('EN').click(); await plain.flush();
  assert.equal(plain.doc.documentElement.lang, 'en');
});

const noStart = (e) => e.requests.every((r) => r.url.startsWith(API) && !/start|resume|restore|snapshot/i.test(r.url));

await test('cloud computer: prepare is a separate explicit press, honestly worded; set up, prepare and release send exact bodies; nothing starts a machine', async () => {
  const s = seeded(); s.cloud = { running: true, installed: false };
  const e = env({ srv: s });
  await e.flush();
  e.rowBtn('보고서 2026 – 최종.pdf').click(); await e.flush();
  assert.match(e.text(), /Prepare places a verified copy of the saved version in ~\/CloudFiles on your running cloud computer\. It does not open an app and never starts the computer\./);
  assert.ok(e.btn('Download to this device') && e.btn('Prepare on cloud computer'), 'download and prepare are separate controls');
  assert.equal(e.posts('/materialize').length, 0, 'selecting never prepares');
  e.btn('Prepare on cloud computer').click(); await e.flush();
  assert.match(e.text(), /Not done on the cloud computer: File access is not set up on your cloud computer yet\./);
  e.btn('Set up file access on cloud computer').click(); await e.flush();
  const [cfg] = e.posts('/agent/configure');
  assert.match(cfg.body.requestId, UUID); assert.deepEqual(Object.keys(cfg.body), ['requestId']);
  assert.match(e.text(), /File access is set up/);
  assert.equal(e.btn('Set up file access on cloud computer'), undefined);
  e.btn('Prepare on cloud computer').click(); await e.flush();
  const mat = e.posts('/materialize').at(-1);
  assert.equal(mat.raw, JSON.stringify({ requestId: mat.body.requestId, fileId: 'f_report', versionId: 'v_r1' }));
  assert.match(mat.body.requestId, UUID);
  assert.match(e.text(), /A verified copy is ready on your cloud computer at \/home\/daytona\/CloudFiles\/보고서 2026 – 최종\.pdf\. No app was opened\./);
  assert.equal(e.btn('Prepare on cloud computer'), undefined, 'one lease per file on this page');
  e.btn('Release on cloud computer').click(); await e.flush();
  const [close] = e.posts('/close');
  assert.equal(close.raw, JSON.stringify({ leaseId: mat.body.requestId.replace(/-/g, '') }));
  assert.match(e.text(), /Released on the cloud computer/);
  assert.ok(e.btn('Prepare on cloud computer'));
  // the lease message stays with its file
  e.rowBtn('empty.txt').click(); await e.flush();
  assert.ok(!/Released on the cloud computer/.test(e.text()));
  assert.equal(e.btn('Prepare on cloud computer').disabled, true, 'nothing saved yet: nothing to prepare');
  assert.ok(noStart(e)); assert.equal(e.doc.activated.length, 0, 'prepare never downloads to this device');
  e.btn('KO').click(); await e.flush();
  e.rowBtn('보고서 2026 – 최종.pdf').click(); await e.flush();
  assert.match(e.text(), /앱을 열지 않고 컴퓨터를 켜지도 않습니다/); assert.ok(e.btn('클라우드 컴퓨터에 준비'));
});

await test('cloud computer: a stopped machine is explained (no start); missing R2 disables prepare; a lost answer retries the same request', async () => {
  const s = seeded(); s.cloud = { running: false, installed: true };
  const e = env({ srv: s });
  await e.flush();
  e.rowBtn('보고서 2026 – 최종.pdf').click(); await e.flush();
  e.btn('Prepare on cloud computer').click(); await e.flush();
  assert.match(e.text(), /Your cloud computer is not running\. Start it on the cloud computer page; this page never starts it\./);
  assert.ok(noStart(e)); assert.equal(e.posts('/materialize').length, 1);
  assert.equal(e.btn('Retry same request'), undefined, 'a definite refusal is not retried');
  s.cloud.running = true;
  s.faults[`POST ${API}/materialize`] = [{ after: () => err(503, 'unknown_outcome') }];
  e.btn('Prepare on cloud computer').click(); await e.flush();
  assert.match(e.text(), /Not confirmed: prepare 보고서 2026 – 최종\.pdf on cloud computer/);
  e.btn('Retry same request').click(); await e.flush();
  const [, a, b] = e.posts('/materialize');
  assert.equal(b.raw, a.raw, 'byte-identical retry keeps the requestId (and so the lease id)');
  assert.match(e.text(), /A verified copy is ready/);
  const off = env({ srv: seeded({ status: { blobs: 'not_configured' } }) });
  await off.flush();
  off.rowBtn('보고서 2026 – 최종.pdf').click(); await off.flush();
  assert.equal(off.btn('Prepare on cloud computer').disabled, true);
  assert.match(off.text(), /Needs file contents storage, which is not configured\./);
  off.btn('Prepare on cloud computer').click(); await off.flush();
  assert.equal(off.posts('/materialize').length, 0);
});

await test('storage: occupied is saved versions plus held upload bytes (pending cleanup included); keep is worded as a request, not residency', async () => {
  const e = env({ srv: seeded({ status: { usedBytes: 5 * MiB, reservedBytes: 3 * MiB, pinnedFiles: 1 } }) });
  await e.flush();
  const t = e.text();
  assert.match(t, /Occupied \| 8 MiB of 10 GiB \| Saved versions \| 5 MiB \| Held by unfinished or ended uploads until cleanup \| 3 MiB/);
  assert.match(t, /Keep requests \| 1/);
  assert.ok(!/sav(e|ing) space|will not free|always/i.test(t), 'no savings or residency promise');
  e.rowBtn('보고서 2026 – 최종.pdf').click(); await e.flush();
  e.btn('Remove keep request').click(); await e.flush();
  e.btn('Request keeping on cloud computer').click(); await e.flush();
  assert.match(e.text(), /Keep request saved\. It is a setting stored with your file list; it does not guarantee a copy stays on the cloud computer\./);
  e.btn('KO').click(); await e.flush();
  assert.match(e.text(), /차지한 공간 \| 10 GiB 중 8 MiB/);
  assert.ok(!/항상 보관/.test(e.text()));
});

console.log(`${passed} cloudbite-computer-files-ui tests passed`);
