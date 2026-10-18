// Cloudbite 접근 화면 (src/cloudbite-access-page.ts 의 CLOUDBITE_ACCESS_JS) 을 브라우저 없이 고정한다: 작은 가짜 DOM 으로
// 주인 보안 키 로그인·첫 키 등록(#setup=)·세션 복원·로그아웃·다른 탭 로그아웃·명시 토큰, 한국어/영어 전환(입력값·포커스·폴링 유지), 공개 QR 문구.
// 실제 브라우저 확인은 조정자가 한다 — 이 파일은 브라우저 증거가 아니다.
//   node test/cloudbite-access-ui.mjs
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import {
  CLOUDBITE_ACCESS_JS, CLOUDBITE_ACCESS_HTML, CLOUDBITE_REQUEST_HTML, CLOUDBITE_REQUESTS_HTML, CLOUDBITE_ACCESS_QR, CLOUDBITE_ACCESS_URL,
} from '../src/cloudbite-access-page.ts';

let pass = 0;
const test = async (name, fn) => { await fn(); pass++; console.log(`  ok   ${name}`); };
const OPERATOR = 'cbo_' + 'A'.repeat(42) + 'A';

class Node_ {
  constructor(doc, tag) { this.doc = doc; this.tagName = tag.toUpperCase(); this.children = []; this.attrs = {}; this.listeners = {}; this.parent = null;
    this.className = ''; this._text = ''; this.value = ''; this.disabled = false; this.hidden = false; this.open = false; }
  get textContent() { return this._text + this.children.map(c => typeof c === 'string' ? c : c.textContent).join(''); }
  set textContent(v) { for (const c of this.children) if (typeof c !== 'string') c.parent = null; this.children = []; this._text = String(v); }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id') this.id = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  hasAttribute(k) { return k in this.attrs; }
  addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }
  dispatch(t, ev = {}) { const e = { type: t, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...ev }; for (const f of this.listeners[t] || []) f(e); return e; }
  append(...ns) { for (const n of ns) { if (typeof n === 'string') { this.children.push(n); continue; } if (n.parent) n.remove(); n.parent = this; this.children.push(n); } }
  replaceChildren(...ns) { for (const c of this.children) if (typeof c !== 'string') c.parent = null; this.children = []; this._text = ''; this.append(...ns); }
  remove() { if (this.parent) { this.parent.children = this.parent.children.filter(c => c !== this); this.parent = null; } }
  focus() { this.doc.activeElement = this; }
  click() { if (this.disabled) return; this.dispatch('click'); if (this.tagName === 'BUTTON' && (this.attrs.type || 'submit') === 'submit') { let f = this.parent; while (f && f.tagName !== 'FORM') f = f.parent; if (f) f.dispatch('submit'); } }
  *walk() { for (const c of this.children) if (typeof c !== 'string') { yield c; yield* c.walk(); } }
  connected() { let n = this; while (n.parent) n = n.parent; return n === this.doc.body; }
  /** 숨은 조상이 없는가 */
  shown() { let n = this; while (n) { if (n.hidden) return false; n = n.parent; } return true; }
}

function env({ route, search = '', language = 'en-US', webauthn = true, credGet, credCreate, noCreate = false } = {}) {
  const timers = new Map(); let seq = 0, now = 0;
  const doc = { readyState: 'complete', activeElement: null, title: '', documentElement: { lang: 'en' }, visibilityState: 'visible',
    createElement: (t) => new Node_(doc, t), getElementById: (id) => (id === 'cb-access' ? root : null), listeners: {}, addEventListener(t, f) { (this.listeners[t] ||= []).push(f); } };
  const root = new Node_(doc, 'div'); root.id = 'cb-access';
  doc.body = new Node_(doc, 'body'); doc.body.append(root);
  const location = { pathname: '/cloudbite/requests', search, hash: '', replace() {} };
  const urls = [];
  const history = { state: null, replaceState(_s, _t, url) { urls.push(url); const i = url.indexOf('?'); location.search = i < 0 ? '' : url.slice(i); } };
  const requests = [];
  const gets = [], creates = [];
  const credentials = { get: async (opts) => { gets.push(opts); return credGet ? credGet(opts) : assertion(); },
    ...(noCreate ? {} : { create: async (opts) => { creates.push(opts); return credCreate ? credCreate(opts) : attestation(); } }) };
  const ctx = vm.createContext({
    document: doc, location, history, URLSearchParams, atob, btoa, Intl,
    navigator: { language, languages: [language], credentials },
    ...(webauthn ? { PublicKeyCredential: function PublicKeyCredential() {} } : {}),
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { at: now + (ms || 0), fn }); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    fetch: (url, init = {}) => { const r = { url, init, method: init.method || 'GET', headers: init.headers || {}, body: init.body === undefined ? undefined : JSON.parse(init.body) }; requests.push(r); return route(r, requests.length); },
  });
  const flush = async () => { for (let i = 0; i < 30; i++) await new Promise(r => setImmediate(r)); };
  const advance = async (ms) => {
    const end = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]); now = due[1].at; due[1].fn(); await flush();
    }
    now = end; await flush();
  };
  const all = () => [...root.walk()];
  const byText = (tag, text) => all().find(n => n.tagName === tag && n.textContent.trim() === text);
  const shownBtn = (text) => all().find(n => n.tagName === 'BUTTON' && n.textContent.trim() === text && n.shown());
  return { root, doc, ctx, location, urls, requests, gets, creates, flush, advance, all, byText, shownBtn, timers, boot: async (view) => { root.setAttribute('data-view', view); vm.runInContext(CLOUDBITE_ACCESS_JS, ctx); await flush(); } };
}
const json = (status, body) => Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body });
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
const buf = (...bytes) => new Uint8Array(bytes).buffer;
function assertion() {
  return { id: 'cred-1', rawId: buf(1, 2, 3), type: 'public-key', authenticatorAttachment: 'cross-platform',
    response: { clientDataJSON: buf(123, 125), authenticatorData: buf(9, 9), signature: buf(255, 254, 253), userHandle: buf(7) },
    getClientExtensionResults: () => ({}) };
}
function attestation() {
  return { id: 'new-1', rawId: buf(4, 5, 6), type: 'public-key', authenticatorAttachment: 'cross-platform',
    response: { clientDataJSON: buf(123, 125), attestationObject: buf(161, 0), getTransports: () => ['usb', 'nfc'] },
    getClientExtensionResults: () => ({ prf: { enabled: true } }) };
}
const ROW = (over = {}) => ({ id: 'r1', status: 'pending', name: 'Ada <b>', purpose: 'try it', createdAt: 1_000, expiresAt: Date.now() + 20 * 60_000, maxExperts: 5, maxProjects: 10, usedProjects: 0, ...over });
const OPTIONS = { challenge: 'AAEC_-8', rpId: 'cb.test', allowCredentials: [{ id: 'AQID', type: 'public-key', transports: ['usb'] }], userVerification: 'required', timeout: 60000 };
const SETUP = 'S3tup_' + 'x'.repeat(30);
const REG_OPTIONS = { challenge: 'AAEC_-8', rp: { name: 'shinick gw', id: 'cb.test' }, user: { id: 'b3duZXI', name: 'owner', displayName: 'owner' },
  pubKeyCredParams: [{ alg: -7, type: 'public-key' }], timeout: 180000, attestation: 'none', excludeCredentials: [{ id: 'AQID', type: 'public-key' }],
  authenticatorSelection: { residentKey: 'discouraged', userVerification: 'required', authenticatorAttachment: 'cross-platform' }, extensions: { prf: {} }, hints: ['security-key'] };
/** 주인 API 모형: 세션 상태와 요청함. 쿠키 세션은 인증 상태로만 표현한다 */
function ownerServer({ authenticated = false, hasCredentials = true, rows = [ROW()], login = 200 } = {}) {
  const s = { authenticated, hasCredentials, rows, login, inbox: null, logout: null, regOptions: null, verify: null };
  s.route = (r) => {
    if (r.url === '/api/cloudbite/owner/session') return json(200, { authenticated: s.authenticated, hasCredentials: s.hasCredentials });
    if (r.url === '/api/cloudbite/owner/options') return json(200, OPTIONS);
    if (r.url === '/api/cloudbite/owner/login') { if (s.login !== 200) return json(s.login, { error: 'signature check failed' }); s.authenticated = true; return json(200, { authenticated: true, hasCredentials: true }); }
    if (r.url === '/api/register/options') { if (s.regOptions) return s.regOptions(r); return r.body?.setup === SETUP ? json(200, REG_OPTIONS) : json(403, { error: 'setup token이 틀렸습니다.' }); }
    if (r.url === '/api/register/verify') { if (s.verify) return s.verify(r); if (r.body?.setup !== SETUP) return json(403, { error: 'no' }); s.hasCredentials = true; return json(200, { ok: true, id: 'new-1', label: r.body.label, prf: true }); }
    if (r.url === '/api/cloudbite/owner/logout') { if (s.logout) return s.logout(r); s.authenticated = false; return json(200, { authenticated: false }); }
    if (r.url === '/api/cloudbite/access/requests') {
      if (s.inbox) return s.inbox(r);
      const tok = r.headers['x-admin-token'];
      if (tok ? tok !== OPERATOR : !s.authenticated) return json(401, { error: 'unauthorized' });
      return json(200, { requests: s.rows });
    }
    const m = /^\/api\/cloudbite\/access\/requests\/([^/]+)\/(approve|deny|revoke)$/.exec(r.url);
    if (m) { if (!r.headers['x-admin-token'] && !s.authenticated) return json(401, { error: 'unauthorized' }); const row = { ...s.rows.find(x => x.id === m[1]), status: m[2] === 'approve' ? 'approved' : m[2] === 'deny' ? 'denied' : 'revoked' }; s.rows = s.rows.map(x => x.id === row.id ? row : x); return json(200, row); }
    return json(404, { error: 'not found' });
  };
  return s;
}
const inboxCalls = (e) => e.requests.filter(r => r.url === '/api/cloudbite/access/requests');
const rowsShown = (e) => e.all().filter(n => n.tagName === 'LI' && n.className.startsWith('ax-row'));

// ───────── 공개 표면
await test('공개 QR: 두 언어 블록, 같은 공개 요청 URL, 비밀·보안 키 주장 없음, 스크립트는 같은 출처 하나', () => {
  assert.equal(CLOUDBITE_ACCESS_URL, 'https://cloudbite-v001.ai-gongbu.workers.dev/cloudbite/request');
  for (const html of [CLOUDBITE_ACCESS_HTML, readFileSync(new URL('../demo/access-qr.html', import.meta.url), 'utf8')]) {
    assert.ok(html.includes('lang="ko"') && html.includes('lang="en"'), 'both languages');
    assert.ok(html.includes('Cloudbite를 직접 써 보세요.') && html.includes('Try Cloudbite yourself.'));
    assert.ok(!/security[\s-]*key|보안\s*키|webauthn|passkey/i.test(html), 'no security-key claim on public QR surfaces');
    assert.ok(!/cbo_[A-Za-z0-9_-]{20}|x-admin-token/.test(html), 'no credential');
    assert.ok(!/\s(?:style|on\w+)=/.test(html), 'no inline style attribute or handler');
  }
  assert.ok(!CLOUDBITE_ACCESS_QR.includes('lang='), 'QR encodes the bare public request URL');
  assert.equal((CLOUDBITE_ACCESS_HTML.match(/<script/g) || []).length, 1);
  assert.ok(CLOUDBITE_ACCESS_HTML.includes('<script src="/cloudbite/access.js" defer></script>'));
  const standalone = readFileSync(new URL('../demo/access-qr.html', import.meta.url), 'utf8');
  assert.ok(!/<script/i.test(standalone), 'standalone QR file has no script');
  assert.ok(standalone.includes('href="#ko"') && standalone.includes('href="#en"'), 'standalone switches by fragment');
  for (const html of [CLOUDBITE_REQUEST_HTML, CLOUDBITE_REQUESTS_HTML]) assert.ok(!/security[\s-]*key|보안\s*키/i.test(html));
  assert.ok(/Sign in with security key/.test(CLOUDBITE_ACCESS_JS) && /보안 키로 로그인/.test(CLOUDBITE_ACCESS_JS), 'true owner login copy is allowed in the script');
  assert.ok(!/innerHTML|localStorage|sessionStorage|indexedDB|document\.cookie|eval\(/.test(CLOUDBITE_ACCESS_JS));
});

await test('공개 QR 페이지: ?lang=ko 면 한국어 블록만, 전환하면 주소의 lang 만 바꾸고 제목·html lang 을 따른다', async () => {
  const e = env({ route: () => json(404, {}), search: '?lang=ko' });
  const mk = (l) => {
    const block = new Node_(e.doc, 'div'); block.setAttribute('data-lang-block', l); block.setAttribute('data-title', l === 'ko' ? 'Cloudbite — 사용 요청' : 'Cloudbite — Request access');
    const links = ['ko', 'en'].map(x => { const a = new Node_(e.doc, 'a'); a.setAttribute('data-lang-link', x); return a; });
    block.append(...links); return { block, links };
  };
  const en = mk('en'), ko = mk('ko');
  e.root.append(en.block, ko.block);
  const q = (sel) => { const m = /^\[data-lang-block="(\w+)"\] a\[data-lang-link="(\w+)"\]$/.exec(sel); return (m[1] === 'ko' ? ko : en).links.find(a => a.getAttribute('data-lang-link') === m[2]); };
  e.root.querySelectorAll = (sel) => sel === '[data-lang-block]' ? [en.block, ko.block] : [...en.links, ...ko.links];
  e.root.querySelector = q;
  await e.boot('qr');
  assert.equal(en.block.hidden, true); assert.equal(ko.block.hidden, false);
  assert.equal(e.doc.documentElement.lang, 'ko'); assert.equal(e.doc.title, 'Cloudbite — 사용 요청');
  const ev = ko.links[1].dispatch('click');
  assert.equal(ev.defaultPrevented, true);
  assert.equal(en.block.hidden, false); assert.equal(ko.block.hidden, true);
  assert.equal(e.doc.documentElement.lang, 'en'); assert.equal(e.urls.at(-1), '/cloudbite/requests?lang=en');
  assert.equal(e.doc.activeElement, en.links[1], 'focus moves to the same control in the visible block');
});

// ───────── 주인: 로그인
await test('세션 복원: 로그인된 브라우저는 다시 로그인하지 않고 쿠키로 요청함을 열고 5초마다 갱신한다 (x-admin-token 없음)', async () => {
  const s = ownerServer({ authenticated: true });
  const e = env({ route: s.route });
  await e.boot('owner');
  assert.equal(e.requests[0].url, '/api/cloudbite/owner/session');
  assert.equal(e.requests[0].init.credentials, 'same-origin');
  assert.equal(inboxCalls(e).length, 1);
  assert.equal(inboxCalls(e)[0].headers['x-admin-token'], undefined, 'cookie only');
  assert.equal(rowsShown(e).length, 1);
  assert.ok(e.byText('STRONG', 'Ada <b>'), 'user data drawn as text');
  assert.ok(e.shownBtn('Log out')); assert.ok(!e.shownBtn('Sign in with security key'));
  assert.equal(e.gets.length, 0, 'no key prompt when the session is restored');
  await e.advance(5000);
  assert.equal(inboxCalls(e).length, 2, 'polling continues');
  e.shownBtn('Approve').click(); await e.flush();
  const post = e.requests.find(r => r.url === '/api/cloudbite/access/requests/r1/approve');
  assert.equal(post.headers['content-type'], 'application/json'); assert.deepEqual(post.body, {}); assert.equal(post.headers['x-admin-token'], undefined);
  assert.match(e.root.textContent, /Approved “Ada <b>”/);
});

await test('보안 키 로그인: options → credentials.get(ArrayBuffer) → login JSON(base64url) → 쿠키로 요청함', async () => {
  const s = ownerServer();
  const e = env({ route: s.route });
  await e.boot('owner');
  assert.equal(inboxCalls(e).length, 0, 'no inbox call before sign-in');
  assert.match(e.root.textContent, /Sign in to open the inbox\./);
  e.shownBtn('Sign in with security key').click(); await e.flush();
  const opt = e.requests.find(r => r.url === '/api/cloudbite/owner/options');
  assert.equal(opt.method, 'POST'); assert.equal(opt.headers['content-type'], 'application/json'); assert.deepEqual(opt.body, {});
  const pk = e.gets[0].publicKey;
  assert.deepEqual([...new Uint8Array(pk.challenge)], [...Buffer.from(OPTIONS.challenge, 'base64url')]);
  assert.deepEqual([...new Uint8Array(pk.allowCredentials[0].id)], [1, 2, 3]);
  assert.equal(pk.rpId, 'cb.test'); assert.equal(pk.userVerification, 'required');
  const login = e.requests.find(r => r.url === '/api/cloudbite/owner/login');
  assert.deepEqual(login.body, { response: { id: 'cred-1', rawId: 'AQID', type: 'public-key',
    response: { clientDataJSON: 'e30', authenticatorData: 'CQk', signature: '__79', userHandle: 'Bw' }, clientExtensionResults: {}, authenticatorAttachment: 'cross-platform' } });
  assert.equal(inboxCalls(e).length, 1); assert.equal(inboxCalls(e)[0].headers['x-admin-token'], undefined);
  assert.ok(e.shownBtn('Log out')); assert.equal(rowsShown(e).length, 1);
  assert.equal(e.doc.activeElement, e.shownBtn('Log out'), 'focus moves to Log out');
});

await test('취소·거절·지원 안 함·바쁨: 거짓 로그인 없이 문구만, 다시 시도할 수 있다', async () => {
  const cancel = Object.assign(new Error('x'), { name: 'NotAllowedError' });
  let mode = 'cancel';
  const s = ownerServer();
  const e = env({ route: s.route, credGet: () => { if (mode === 'cancel') throw cancel; if (mode === 'hang') return new Promise(() => {}); return assertion(); } });
  await e.boot('owner');
  e.shownBtn('Sign in with security key').click(); await e.flush();
  assert.match(e.root.textContent, /Sign-in was cancelled or timed out/);
  assert.ok(!e.requests.some(r => r.url === '/api/cloudbite/owner/login'), 'no login post after cancel');
  assert.ok(!e.shownBtn('Log out'));
  s.login = 401; mode = 'ok';
  e.shownBtn('Sign in with security key').click(); await e.flush();
  assert.match(e.root.textContent, /Cloudbite did not accept this security key\. .* — signature check failed/);
  assert.ok(!e.shownBtn('Log out')); assert.equal(inboxCalls(e).length, 0);
  mode = 'hang';
  e.shownBtn('Sign in with security key').click(); await e.flush();
  const busy = e.shownBtn('Waiting for your security key…');
  assert.ok(busy && busy.disabled, 'busy state disables the button');
  busy.disabled = false; busy.click(); await e.flush();
  assert.equal(e.gets.length, 3, 'a second press while busy does nothing');

  const u = env({ route: ownerServer().route, webauthn: false });
  await u.boot('owner');
  u.shownBtn('Sign in with security key').click(); await u.flush();
  assert.match(u.root.textContent, /cannot use a security key on this page/);
  assert.equal(u.gets.length, 0);
});

await test('등록된 키 없음: 이 도메인에 등록이 필요하다고 설명하고 /register 로 안내, 로그인 단추 없음', async () => {
  const e = env({ route: ownerServer({ hasCredentials: false }).route, search: '?lang=ko', language: 'en-US' });
  await e.boot('owner');
  assert.match(e.root.textContent, /이 Cloudbite 도메인에 등록된 보안 키가 아직 없습니다/);
  assert.match(e.root.textContent, /소유자 설정 토큰/);
  const reg = e.all().find(n => n.tagName === 'A' && n.getAttribute('href') === '/register?lang=ko');
  assert.ok(reg && reg.shown());
  assert.ok(!e.shownBtn('보안 키로 로그인'));
});

// ───────── 첫 키 등록
const setupField = (e) => e.all().find(n => n.id === 'ax-setup');
const regCalls = (e) => e.requests.filter(r => r.url.startsWith('/api/register/'));
/** 설정 토큰이 등록 요청 본문 말고 어디에도(주소·헤더·다른 본문·기록) 가지 않았는가 */
function setupOnlyInRegister(e, token) {
  for (const r of e.requests) {
    assert.ok(!r.url.includes(token) && !JSON.stringify(r.headers).includes(token), `no setup in url/headers: ${r.url}`);
    if (!r.url.startsWith('/api/register/')) assert.ok(!JSON.stringify(r.body ?? null).includes(token), `no setup in body: ${r.url}`);
  }
  assert.ok(!e.urls.some(u => u.includes(token)), 'no setup in history');
}

await test('첫 키 등록 화면: 키 없음일 때만 설정 토큰 칸과 등록 단추, 누르기 전에는 등록하지 않는다', async () => {
  const e = env({ route: ownerServer({ hasCredentials: false }).route });
  await e.boot('owner');
  const btn = e.shownBtn('Register security key');
  assert.ok(btn && setupField(e).shown(), 'setup field and button in the auth panel');
  assert.equal(setupField(e).attrs.type, 'password');
  assert.match(e.root.textContent, /Register your first key here once with the private owner setup token/);
  assert.ok(!e.shownBtn('Sign in with security key'));
  await e.advance(20000);
  assert.equal(regCalls(e).length, 0, 'no automatic registration'); assert.equal(e.creates.length, 0);
  for (const over of [{ hasCredentials: true }, { authenticated: true }]) {
    const x = env({ route: ownerServer(over).route });
    await x.boot('owner');
    assert.ok(!x.shownBtn('Register security key') && !setupField(x).shown(), `no enrollment when ${JSON.stringify(over)}`);
  }
});

await test('#setup= 링크: 어떤 요청보다 먼저 조각을 지우고 입력칸에만 둔다, 운영자 조각과 섞이지 않고 잘못된 조각도 지운다', async () => {
  let firstFetchUrls = -1;
  const s = ownerServer({ hasCredentials: false });
  const e = env({ route: (r, n) => { if (n === 1) firstFetchUrls = e.urls.length; return s.route(r); }, search: '?lang=ko' });
  e.location.hash = `#setup=${SETUP}&operator=${OPERATOR}`;
  await e.boot('owner');
  assert.equal(firstFetchUrls, 1, 'address rewritten before the first request');
  assert.equal(e.urls[0], '/cloudbite/requests?lang=ko', 'fragment removed, language query kept');
  assert.equal(setupField(e).value, SETUP);
  assert.equal(inboxCalls(e)[0].headers['x-admin-token'], OPERATOR, 'operator link still works beside the setup link');
  assert.equal(regCalls(e).length, 0);
  e.byText('BUTTON', 'EN').click(); await e.flush();
  setupOnlyInRegister(e, SETUP);
  // 운영자 조각처럼 보이는 값이 setup 안에 있어도 운영자 링크로 읽지 않는다. 퍼센트 인코딩은 한 번만 푼다
  let core;
  vm.runInContext(CLOUDBITE_ACCESS_JS, vm.createContext({ __cloudbiteAccessTestHook: (c) => { core = c; }, URLSearchParams }));
  const cbo = 'cbo_' + 'B'.repeat(30);
  assert.deepEqual(JSON.parse(JSON.stringify(core.handoffFragment(`#setup=${cbo}`))), { operator: { present: false, token: '' }, setup: { present: true, token: cbo } });
  assert.equal(core.handoffFragment(`#setup=%41${'a'.repeat(25)}`).setup.token, 'A' + 'a'.repeat(25));
  assert.equal(core.handoffFragment(`#setup=%2541${'a'.repeat(25)}`).setup.token, '', 'decoded once only');
  assert.equal(core.handoffFragment('#setup=short').setup.token, '');
  assert.equal(core.handoffFragment('#operator=' + OPERATOR).operator.token, OPERATOR);
  // 잘못된 setup 조각: 지우고 알린다, 입력칸은 비어 있다
  const m = env({ route: ownerServer({ hasCredentials: false }).route });
  m.location.hash = '#setup=bad%ZZ';
  await m.boot('owner');
  assert.equal(m.urls[0], '/cloudbite/requests');
  assert.equal(setupField(m).value, '');
  assert.match(m.root.textContent, /owner setup link was malformed/);
  assert.equal(m.all().find(n => n.tagName === 'DETAILS').open, false, 'a setup link does not open the operator token section');
  // 이미 키가 있으면 링크를 쓰지 않고 메모리에서도 지운다
  const k = env({ route: ownerServer({ hasCredentials: true }).route });
  k.location.hash = `#setup=${SETUP}`;
  await k.boot('owner');
  assert.equal(setupField(k).value, ''); assert.match(k.root.textContent, /setup link was not used and was cleared/);
  assert.equal(regCalls(k).length, 0);
});

await test('등록: options{setup} → create(ArrayBuffer, 서버 옵션 유지) → verify{setup,response,label} → 토큰을 지우고 다시 확인, 로그인은 따로 누른다', async () => {
  const s = ownerServer({ hasCredentials: false });
  s.verify = (r) => { s.hasCredentials = true; return json(200, { ok: true, authenticated: true, id: 'new-1' }); }; // 응답이 로그인을 주장해도 믿지 않는다
  const e = env({ route: s.route });
  await e.boot('owner');
  setupField(e).value = `  ${SETUP} `;
  e.shownBtn('Register security key').click(); await e.flush();
  const opt = e.requests.find(r => r.url === '/api/register/options');
  assert.equal(opt.method, 'POST'); assert.equal(opt.headers['content-type'], 'application/json'); assert.deepEqual(opt.body, { setup: SETUP });
  assert.equal(opt.headers['x-admin-token'], undefined);
  assert.equal(e.creates.length, 1);
  const pk = e.creates[0].publicKey;
  assert.deepEqual([...new Uint8Array(pk.challenge)], [...Buffer.from(REG_OPTIONS.challenge, 'base64url')]);
  assert.deepEqual([...new Uint8Array(pk.user.id)], [...Buffer.from('owner')]);
  assert.equal(pk.user.name, 'owner');
  assert.deepEqual([...new Uint8Array(pk.excludeCredentials[0].id)], [1, 2, 3]);
  assert.deepEqual(pk.authenticatorSelection, REG_OPTIONS.authenticatorSelection, 'cross-platform, UV required kept');
  assert.deepEqual(pk.extensions, { prf: {} }); assert.deepEqual(pk.rp, REG_OPTIONS.rp); assert.deepEqual(pk.pubKeyCredParams, REG_OPTIONS.pubKeyCredParams);
  assert.equal(pk.timeout, 180000);
  const ver = e.requests.find(r => r.url === '/api/register/verify');
  assert.deepEqual(ver.body, { setup: SETUP, label: 'Cloudbite owner key', response: { id: 'new-1', rawId: 'BAUG', type: 'public-key',
    response: { clientDataJSON: 'e30', attestationObject: 'oQA', transports: ['usb', 'nfc'] }, clientExtensionResults: { prf: { enabled: true } }, authenticatorAttachment: 'cross-platform' } });
  assert.match(e.root.textContent, /Key registered\. Sign in with your security key\./);
  assert.equal(setupField(e).value, '', 'setup cleared after success');
  assert.equal(e.requests.filter(r => r.url === '/api/cloudbite/owner/session').length, 2, 'session checked again');
  assert.ok(e.shownBtn('Sign in with security key')); assert.ok(!e.shownBtn('Log out'), 'registration is not a login');
  assert.ok(!e.shownBtn('Register security key'));
  assert.equal(e.gets.length, 0, 'no second native prompt'); assert.equal(inboxCalls(e).length, 0);
  setupOnlyInRegister(e, SETUP);
  e.shownBtn('Sign in with security key').click(); await e.flush();
  assert.equal(e.gets.length, 1); assert.ok(e.shownBtn('Log out'));
  // 서버가 다시 확인해도 로그인되지 않았다고 하면 등록 응답만으로 로그인으로 치지 않는다
  const t = ownerServer({ hasCredentials: false });
  t.verify = () => { t.hasCredentials = true; return json(200, { ok: true, authenticated: true }); };
  const x = env({ route: t.route });
  await x.boot('owner');
  setupField(x).value = SETUP; x.shownBtn('Register security key').click(); await x.flush();
  assert.ok(!x.shownBtn('Log out')); assert.equal(inboxCalls(x).length, 0); assert.match(x.root.textContent, /Sign in to open the inbox\./);
});

await test('등록 실패: 빈칸·형식·지원 안 함·취소·틀린 토큰·검증 실패·형식 오류 — 로그인 없음, 토큰 유지, 다시 시도할 수 있다', async () => {
  let mode = 'cancel';
  const s = ownerServer({ hasCredentials: false });
  const e = env({ route: s.route, credCreate: () => { if (mode === 'cancel') throw Object.assign(new Error('x'), { name: 'NotAllowedError' }); if (mode === 'dup') throw Object.assign(new Error('x'), { name: 'InvalidStateError' }); return attestation(); } });
  await e.boot('owner');
  const press = async () => { e.shownBtn('Register security key').click(); await e.flush(); };
  await press();
  assert.match(e.root.textContent, /Enter the owner setup token\./); assert.equal(regCalls(e).length, 0);
  setupField(e).value = 'has spaces in it and more';
  await press();
  assert.match(e.root.textContent, /owner setup token has the wrong format/); assert.equal(regCalls(e).length, 0);
  setupField(e).value = SETUP;
  await press();
  assert.match(e.root.textContent, /Key registration was cancelled or timed out/);
  assert.ok(!e.requests.some(r => r.url === '/api/register/verify'), 'no verify after cancel');
  mode = 'dup';
  await press();
  assert.match(e.root.textContent, /This security key is already registered on this domain/);
  mode = 'ok';
  setupField(e).value = 'W' + SETUP.slice(1);
  await press();
  assert.match(e.root.textContent, /Could not start key registration\. The owner setup token was rejected.* — setup token이 틀렸습니다\./);
  setupField(e).value = SETUP;
  s.verify = () => json(400, { error: '등록 검증 실패' });
  await press();
  assert.match(e.root.textContent, /Cloudbite did not verify this registration\. Try again\. — 등록 검증 실패/);
  s.verify = () => json(200, { ok: false });
  await press();
  assert.match(e.root.textContent, /unexpected format\. No key was confirmed/);
  assert.equal(setupField(e).value, SETUP, 'setup kept for a retry');
  assert.ok(e.shownBtn('Register security key') && !e.shownBtn('Register security key').disabled, 'retryable');
  assert.ok(!e.shownBtn('Log out')); assert.equal(inboxCalls(e).length, 0); assert.equal(e.gets.length, 0);
  s.verify = null;
  await press();
  assert.match(e.root.textContent, /Key registered/);
  setupOnlyInRegister(e, SETUP);
  const u = env({ route: ownerServer({ hasCredentials: false }).route, noCreate: true });
  await u.boot('owner');
  setupField(u).value = SETUP; u.shownBtn('Register security key').click(); await u.flush();
  assert.match(u.root.textContent, /cannot register a security key on this page/); assert.equal(regCalls(u).length, 0);
});

await test('등록 중 KO/EN 전환: 입력칸·바쁜 상태를 유지하고, 끝난 뒤 문구는 새 언어로', async () => {
  const s = ownerServer({ hasCredentials: false });
  const hold = deferred();
  const e = env({ route: s.route, credCreate: () => hold.promise });
  await e.boot('owner');
  const field = setupField(e);
  field.value = SETUP;
  e.shownBtn('Register security key').click(); await e.flush();
  const busy = e.shownBtn('Registering — follow your browser\'s prompt…');
  assert.ok(busy && busy.disabled && field.disabled);
  busy.disabled = false; busy.click(); await e.flush();
  assert.equal(e.creates.length, 1, 'a second press while busy does nothing');
  e.byText('BUTTON', 'KO').click(); await e.flush();
  assert.equal(setupField(e), field, 'same input element'); assert.equal(field.value, SETUP);
  assert.ok(e.shownBtn('등록 중 — 브라우저 안내를 따르세요…')?.disabled, 'busy survives the switch');
  assert.ok(e.byText('LABEL', '소유자 설정 토큰'));
  assert.equal(e.all().find(n => n.tagName === 'FORM' && n.className.includes('ax-enroll')).getAttribute('aria-label'), '보안 키 등록');
  hold.resolve(attestation()); await e.flush();
  assert.match(e.root.textContent, /키를 등록했습니다\. 보안 키로 로그인하세요\./);
  assert.ok(e.shownBtn('보안 키로 로그인')); assert.equal(e.gets.length, 0);
});

// ───────── 로그아웃
await test('로그아웃: 서버 확인 뒤에만 로그인 상태로, 타이머·목록·토큰을 지우고 늦은 응답은 그리지 않는다', async () => {
  const s = ownerServer({ authenticated: true });
  const e = env({ route: s.route });
  await e.boot('owner');
  const late = deferred();
  s.inbox = () => late.promise;
  await e.advance(5000); // 요청 하나가 떠 있다
  s.inbox = null;
  { const lo = e.shownBtn('Log out'); lo.focus(); lo.click(); } await e.flush();
  const out = e.requests.find(r => r.url === '/api/cloudbite/owner/logout');
  assert.equal(out.method, 'POST'); assert.deepEqual(out.body, {}); assert.equal(out.headers['content-type'], 'application/json');
  assert.match(e.root.textContent, /You are logged out in this browser\./);
  assert.equal(rowsShown(e).length, 0); assert.ok(e.shownBtn('Sign in with security key'));
  assert.equal(e.doc.activeElement, e.shownBtn('Sign in with security key'));
  late.resolve(await json(200, { requests: [ROW({ id: 'stale', name: 'Old row' })] })); await e.flush();
  assert.ok(!/Old row/.test(e.root.textContent), 'stale reply after logout is dropped');
  const before = e.requests.length;
  await e.advance(30000);
  assert.equal(e.requests.length, before, 'no polling after logout');
});

await test('로그아웃 실패: 로그인 상태와 목록을 그대로 두고 실패를 보인다', async () => {
  const s = ownerServer({ authenticated: true });
  s.logout = () => json(500, { error: 'store unavailable' });
  const e = env({ route: s.route });
  await e.boot('owner');
  e.shownBtn('Log out').click(); await e.flush();
  assert.match(e.root.textContent, /Logout did not complete, so you are still signed in\. .* — store unavailable/);
  assert.ok(e.shownBtn('Log out')); assert.equal(rowsShown(e).length, 1);
  assert.ok(!/logged out in this browser/.test(e.root.textContent));
  s.logout = () => json(0, null);
  s.logout = () => Promise.reject(new Error('offline'));
  e.shownBtn('Log out').click(); await e.flush();
  assert.match(e.root.textContent, /Logout did not complete/);
  await e.advance(5000);
  assert.ok(inboxCalls(e).length >= 2, 'polling resumes while still signed in');
});

await test('다른 탭 로그아웃: 다음 갱신의 401 에서 로그인 화면으로 돌아가고 목록을 지운다', async () => {
  const s = ownerServer({ authenticated: true });
  const e = env({ route: s.route });
  await e.boot('owner');
  assert.equal(rowsShown(e).length, 1);
  s.authenticated = false;
  await e.advance(5000);
  assert.equal(rowsShown(e).length, 0);
  assert.match(e.root.textContent, /You were signed out — the session ended in another tab or expired/);
  assert.ok(e.shownBtn('Sign in with security key'));
  const n = inboxCalls(e).length;
  await e.advance(20000);
  assert.equal(inboxCalls(e).length, n, 'no polling once signed out');
});

await test('명시 토큰: 헤더로만 쓰고 거부돼도 쿠키로 넘어가지 않는다. 토큰 지우기는 로그아웃이 아니다', async () => {
  const s = ownerServer({ authenticated: true });
  const e = env({ route: s.route });
  await e.boot('owner');
  const tokenIn = e.all().find(n => n.id === 'ax-token');
  tokenIn.value = 'wrong-admin-session'; tokenIn.dispatch('input');
  e.shownBtn('Use token').click(); await e.flush();
  const last = inboxCalls(e).at(-1);
  assert.equal(last.headers['x-admin-token'], 'wrong-admin-session');
  assert.match(e.root.textContent, /The admin session was rejected or has expired/);
  assert.equal(rowsShown(e).length, 0);
  const n = inboxCalls(e).length;
  await e.advance(15000);
  assert.ok(inboxCalls(e).slice(n).every(r => r.headers['x-admin-token'] === 'wrong-admin-session'), 'never falls back to the cookie');
  assert.ok(e.shownBtn('Log out'), 'cookie session untouched');
  e.shownBtn('Clear token').click(); await e.flush();
  assert.equal(inboxCalls(e).at(-1).headers['x-admin-token'], undefined, 'clearing the token reopens with the cookie');
  assert.equal(rowsShown(e).length, 1); assert.ok(e.shownBtn('Log out'));
  assert.ok(!e.requests.some(r => r.url === '/api/cloudbite/owner/logout'), 'clear token is not a logout');
});

await test('운영자 링크: 조각을 먼저 지우고 고급을 연다, 로그인 없이도 토큰으로 요청함', async () => {
  const s = ownerServer();
  const e = env({ route: s.route });
  e.location.hash = '#operator=' + OPERATOR;
  await e.boot('owner');
  assert.equal(e.urls[0], '/cloudbite/requests');
  assert.equal(e.all().find(n => n.tagName === 'DETAILS').open, true);
  assert.equal(inboxCalls(e)[0].headers['x-admin-token'], OPERATOR);
  assert.match(e.root.textContent, /temporary operator token in memory/);
});

// ───────── 언어
await test('기본 언어: ?lang 우선, 없으면 브라우저 언어, 잘못된 값은 무시', async () => {
  let core;
  const ctx = vm.createContext({ __cloudbiteAccessTestHook: (c) => { core = c; }, URLSearchParams });
  vm.runInContext(CLOUDBITE_ACCESS_JS, ctx);
  assert.equal(core.pickLang('?lang=ko', 'en-US'), 'ko');
  assert.equal(core.pickLang('?lang=en', 'ko-KR'), 'en');
  assert.equal(core.pickLang('?lang=fr', 'ko-KR'), 'ko');
  assert.equal(core.pickLang('', ''), 'en');
  assert.deepEqual(Object.keys(core.DICT.ko).sort(), Object.keys(core.DICT.en).sort(), 'every message exists in both languages');
  const e = env({ route: ownerServer().route, language: 'ko-KR' });
  await e.boot('owner');
  assert.equal(e.doc.documentElement.lang, 'ko'); assert.equal(e.doc.title, 'Cloudbite — 접근 요청함');
  assert.ok(e.shownBtn('보안 키로 로그인'));
});

await test('방문자 전환: 이름·목적·포커스·대기 요청·폴링을 그대로 두고 문구·aria·제목·링크만 바뀐다', async () => {
  let status = { request: null, canCreate: false };
  const e = env({ route: (r) => r.url === '/api/cloudbite/access/status' ? json(200, status) : r.url === '/api/cloudbite/access/requests' ? json(400, { error: 'name: bad' }) : json(404, {}) });
  e.location.pathname = '/cloudbite/request';
  await e.boot('request');
  assert.equal(e.doc.title, 'Cloudbite — Request access');
  const nameIn = e.all().find(n => n.id === 'ax-name'), purposeIn = e.all().find(n => n.id === 'ax-purpose');
  nameIn.value = '김하나'; purposeIn.value = 'my plan';
  e.shownBtn('Request access').click(); await e.flush();
  assert.match(e.root.textContent, /The request was not accepted\. Check your name and purpose\. — name: bad/);
  purposeIn.focus();
  const ko = e.all().find(n => n.tagName === 'BUTTON' && n.getAttribute('lang') === 'ko');
  assert.equal(ko.getAttribute('aria-pressed'), 'false');
  ko.click(); await e.flush();
  assert.equal(ko.getAttribute('aria-pressed'), 'true');
  assert.equal(e.all().find(n => n.tagName === 'BUTTON' && n.getAttribute('lang') === 'en').getAttribute('aria-pressed'), 'false');
  assert.equal(e.doc.documentElement.lang, 'ko'); assert.equal(e.doc.title, 'Cloudbite — 사용 요청');
  assert.equal(e.urls.at(-1), '/cloudbite/request?lang=ko');
  assert.equal(nameIn.value, '김하나'); assert.equal(purposeIn.value, 'my plan'); assert.equal(e.doc.activeElement, purposeIn);
  assert.ok(nameIn.connected(), 'same input element kept');
  assert.match(e.root.textContent, /요청이 접수되지 않았습니다\. 이름과 목적을 확인하세요\. — name: bad/, 'error re-rendered in Korean, raw server text kept');
  assert.ok(e.byText('LABEL', '이름')); assert.ok(e.shownBtn('사용 요청 보내기'));
  assert.equal(e.all().find(n => n.className === 'ax-brand').getAttribute('href'), '/cloudbite?lang=ko');
  // 대기 중 요청: 전환해도 폴링·상태가 이어진다
  const p = env({ route: (r) => r.url === '/api/cloudbite/access/status' ? json(200, { request: { ...ROW(), name: 'Ada' }, canCreate: false }) : json(404, {}) });
  p.location.pathname = '/cloudbite/request';
  await p.boot('request');
  const nStatus = () => p.requests.filter(r => r.url === '/api/cloudbite/access/status').length;
  assert.equal(nStatus(), 1);
  assert.match(p.root.textContent, /Waiting for approval/);
  p.byText('BUTTON', 'KO').click(); await p.flush();
  assert.match(p.root.textContent, /승인 대기/); assert.match(p.root.textContent, /분 후/, 'relative time via Intl');
  await p.advance(5000);
  assert.equal(nStatus(), 2, 'polling survives the switch');
  assert.match(p.root.textContent, /승인 대기/);
});

await test('주인 전환: 목록·바쁜 상태·폴링을 유지하고 행 단추 포커스를 되돌린다', async () => {
  const s = ownerServer({ authenticated: true });
  const hold = deferred();
  const e = env({ route: (r) => /\/approve$/.test(r.url) ? hold.promise : s.route(r) });
  await e.boot('owner');
  const deny = e.shownBtn('Deny'); deny.focus();
  e.byText('BUTTON', 'KO').click(); await e.flush();
  assert.equal(e.doc.activeElement.getAttribute('data-key'), 'deny:r1', 'focus restored onto the redrawn row button');
  assert.ok(e.shownBtn('거절')); assert.match(e.root.textContent, /요청 1건/); assert.match(e.root.textContent, /보안 키 세션/);
  e.shownBtn('승인').click(); await e.flush();
  assert.ok(e.shownBtn('처리 중…'));
  e.byText('BUTTON', 'EN').click(); await e.flush();
  assert.ok(e.shownBtn('Working…'), 'busy row stays busy across the switch');
  assert.equal(e.urls.at(-1), '/cloudbite/requests?lang=en');
  hold.resolve(await json(200, { ...ROW(), status: 'approved' })); await e.flush();
  assert.match(e.root.textContent, /Approved “Ada <b>”/);
  const n = inboxCalls(e).length;
  await e.advance(5000);
  assert.equal(inboxCalls(e).length, n + 1);
  const links = e.all().filter(n => n.tagName === 'A').map(a => a.getAttribute('href'));
  assert.ok(links.includes('/cloudbite/request?lang=en') && links.includes('/cloudbite?lang=en'));
});

console.log(`cloudbite-access-ui: ${pass} checks passed`);
