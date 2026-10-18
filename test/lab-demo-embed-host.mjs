// Authenticated teacher-demo embed only. Local stubs. No provider, network, or deployment.
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const cf = { name: 'local-runtime-stub', setup(b) {
  b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'cf', namespace: 'stub' }));
  b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }' }));
} };
async function load(entry) {
  const built = await build({ entryPoints: [entry], bundle: true, write: false, format: 'esm', platform: 'node', plugins: [cf], loader: { '.ps1': 'text' } });
  return import('data:text/javascript;base64,' + Buffer.from(built.outputFiles[0].text).toString('base64'));
}

let count = 0;
async function test(name, fn) { await fn(); count++; console.log('ok', name); }

const ENV = { ORIGIN: 'https://k.example.test', LAB_ORIGIN: 'https://lab.example.test', LAB_SEAT_DOMAIN: 'example.test' };
const LABEL = 'abcdefghijklmnopqrstuvwxyz';
const ME = `https://s-${LABEL}.${ENV.LAB_SEAT_DOMAIN}`;
const CODE = 'demoseatcode0001';
const PART = 'participant00001';
const ADMIN = 'fixture-admin-token';
const PREVIEW = 'preview-tok';
const GRANT = 'ab'.repeat(32);
const TOP_SCRIPTS = ['/__lab/bar.js', '/__lab/snips.js', '/__lab/help.js', '/__lab/screen.js', '/__lab/rtc.js', '/__lab/dom-capture.js', '/__lab/live.js', '/__lab/classroom.js', '/__lab/perf.js'];
const EMBED_SCRIPTS = ['/__lab/bar.js', '/__lab/snips.js', '/__lab/dom-capture.js', '/__lab/demo-bridge.js', '/__lab/perf.js'];
const OPEN_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function memory() {
  const data = new Map(); let queue = Promise.resolve();
  const copy = (v) => v === undefined ? undefined : structuredClone(v);
  return {
    data,
    async get(k) { return Array.isArray(k) ? new Map(k.map((a) => [a, copy(data.get(a))])) : copy(data.get(k)); },
    async put(k, v) { for (const [a, b] of typeof k === 'object' ? Object.entries(k) : [[k, v]]) data.set(a, copy(b)); },
    async delete(k) { for (const a of Array.isArray(k) ? k : [k]) data.delete(a); },
    async list({ prefix = '', limit = Infinity } = {}) { return new Map([...data].filter(([key]) => key.startsWith(prefix)).slice(0, limit).map(([key, value]) => [key, copy(value)])); },
    transaction(fn) { const p = queue.then(() => fn(this)); queue = p.catch(() => {}); return p; },
    async getAlarm() { return null; }, async setAlarm() {},
  };
}
const labOf = (id, extra = {}, seat = null) => ({
  id, name: id, createdAt: Date.now(), expiresAt: Date.now() + 3600000, budget: 1, cpu: 1, memory: 2, disk: 5,
  snapshot: 'gw-lab-v5', model: 'm', gw: 'https://gw.invalid', seats: seat ? [seat] : [], ...extra,
});

const { State } = await load('src/state.ts');
const previewCalls = [];
let dropParentDuringPreview = false;
globalThis.fetch = async (url) => {
  const u = new URL(url);
  assert.equal(u.host, 'dt.invalid', 'state fixture must stay on the local stub');
  previewCalls.push(u.pathname);
  if (dropParentDuringPreview) currentState.data.get('lab:parent').expiresAt = Date.now() - 1000;
  return Response.json({ url: 'https://pv.invalid/sandbox', token: 'preview-token' });
};
let currentState;
async function stateWorld(pv = true) {
  const s = memory(); currentState = s; previewCalls.length = 0; dropParentDuringPreview = false;
  const demoSeat = { n: 1, code: CODE, label: LABEL, sandboxId: 'sb-demo', ...(pv ? { pv: { origin: 'https://upstream.invalid', token: 'stored-token' } } : {}) };
  const partSeat = { n: 1, code: PART, label: LABEL, sandboxId: 'sb-part', pv: { origin: 'https://peer.invalid', token: 'peer-token' } };
  await s.put({
    'mig:grants': 1,
    'lab:parent': labOf('parent'),
    'lab:demo': labOf('demo', { teacherDemoFor: 'parent' }, demoSeat),
    'lab:class': labOf('class', {}, partSeat),
    ['seat:' + CODE]: { lab: 'demo', n: 1 },
    ['seat:' + PART]: { lab: 'class', n: 1 },
  });
  class Fixture extends State {
    async daytona() { previewCalls.push('daytona'); return { api: 'https://dt.invalid', key: 'fixture-only' }; }
    async checkAdmin() { return false; }
    async audit() {}
  }
  const state = new Fixture({ storage: s, blockConcurrencyWhile: (fn) => fn(), waitUntil() {} }, { ...ENV });
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { s, state };
}
const closed = (got) => got && got.status === 410 && !('demoParent' in got) && !('token' in got) && !('origin' in got);

await test('active parent adds demoParent; participant route omits it', async () => {
  const { state } = await stateWorld(true);
  const demo = await state.labRoute(CODE);
  const part = await state.labRoute(PART);
  assert.equal(demo.demoParent, 'parent');
  assert.equal(demo.origin, 'https://upstream.invalid');
  assert.equal(previewCalls.length, 0);
  assert.equal('demoParent' in part, false);
  assert.equal(part.origin, 'https://peer.invalid');
});
await test('expired, stopping, or missing parent fails closed before a preview lookup', async () => {
  const { s, state } = await stateWorld(false);
  s.data.get('lab:parent').expiresAt = Date.now() - 1000;
  assert.equal(closed(await state.labRoute(CODE)), true);
  s.data.get('lab:parent').expiresAt = Date.now() + 3600000;
  s.data.get('lab:parent').endRetry = 1;
  assert.equal(closed(await state.labRoute(CODE)), true);
  delete s.data.get('lab:parent').endRetry;
  await s.put('labprepstop:parent', { at: 1 });
  assert.equal(closed(await state.labRoute(CODE)), true);
  await s.delete('labprepstop:parent');
  await s.delete('lab:parent');
  assert.equal(closed(await state.labRoute(CODE)), true);
  assert.deepEqual(previewCalls, []);
  assert.equal(s.data.get('lab:demo').seats[0].pv, undefined);
});
await test('preview lookup rechecks the parent and still returns demoParent when it stays live', async () => {
  const { state } = await stateWorld(false);
  const demo = await state.labRoute(CODE);
  assert.equal(demo.demoParent, 'parent');
  assert.equal(demo.origin, 'https://pv.invalid');
  assert.deepEqual(previewCalls, ['daytona', '/sandbox/sb-demo/ports/8080/preview-url']);
  const again = await state.labRoute(CODE);
  assert.equal(again.demoParent, 'parent');
  assert.equal(previewCalls.length, 2);
});
await test('parent expiring during preview lookup does not return demoParent', async () => {
  const { state } = await stateWorld(false);
  dropParentDuringPreview = true;
  assert.equal(closed(await state.labRoute(CODE)), true);
  assert.deepEqual(previewCalls, ['daytona', '/sandbox/sb-demo/ports/8080/preview-url']);
});

const { labSeatHost } = await load('src/labhost.ts');
const { labDemoHost } = await load('src/lab-demo-host.ts');
const { labDemoEmbedBridgeJS } = await load('src/lab-demo-embed-bridge.ts');
const calls = [];
let routeImpl = () => ({ origin: 'https://upstream.example.test', token: PREVIEW, expiresAt: Date.now() + 3600e3, seat: 1, clip: { in: true, out: true }, label: LABEL, demoParent: 'parent' });
const state = new Proxy({}, { get: (_target, key) => async (...args) => { calls.push([key, ...args]); return key === 'labRoute' ? routeImpl(...args) : { error: 'unused', status: 500 }; } });
const fetched = [];
let upstream = { status: 200, body: '<html><head><script nonce="n0nce"></script></head><body>editor</body></html>', headers: { 'content-type': 'text/html; charset=utf-8' } };
globalThis.fetch = async (url, init = {}) => {
  fetched.push({ url: String(url), method: init.method ?? 'GET', headers: new Headers(init.headers) });
  return new Response(upstream.body, { status: upstream.status, headers: upstream.headers });
};
const rw = { prepend: [], before: [] };
const resetRw = () => { rw.prepend = []; rw.before = []; };
globalThis.HTMLRewriter = class {
  constructor() { this.h = []; }
  on(sel, handler) { this.h.push([sel, handler]); return this; }
  transform(res) {
    const el = (attrs = {}) => ({ prepend: (html) => rw.prepend.push(html), append() {}, remove() {}, getAttribute: (name) => attrs[name] ?? null, onEndTag: (fn) => fn({ before: (html) => rw.before.push(html) }) });
    for (const [sel, handler] of this.h) handler.element(sel === 'script[nonce]' ? el({ nonce: 'n0nce' }) : el());
    return res;
  }
};
const routeCalls = () => calls.filter((call) => call[0] === 'labRoute').length;
const srcs = () => [...rw.before.join('').matchAll(/src="([^"]+)"/g)].map((match) => match[1]);
const leak = (text, res) => text + [...res.headers].map(([name, value]) => name + ':' + value).join('\n');
async function seat(path, { method = 'GET', headers = {}, cookie = `__Host-lab_seat=${CODE}; other=keep` } = {}) {
  const req = new Request(ME + path, { method, headers: { ...headers, ...(cookie ? { cookie } : {}) } });
  const res = await labSeatHost(req, ENV, state, new URL(req.url), LABEL);
  return { res, text: await res.text() };
}
const frame = (extra = {}) => ({ 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe', ...extra });
const htmlHeaders = (csp, xfo = 'SAMEORIGIN') => ({ 'content-type': 'text/html; charset=utf-8', 'content-security-policy': csp, ...(xfo ? { 'x-frame-options': xfo } : {}) });

await test('cached demo route cannot authorize the root or the bridge after the parent is no longer live', async () => {
  upstream.headers = htmlHeaders("default-src 'self'; script-src 'nonce-keep'");
  resetRw();
  const doc = await seat('/', { headers: { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', accept: 'text/html' } });
  assert.equal(doc.res.status, 200);
  assert.deepEqual(srcs(), TOP_SCRIPTS);
  assert.equal(doc.res.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.equal(routeCalls(), 1);
  const assetBefore = fetched.length;
  const asset = await seat('/static/app.js', { headers: { 'sec-fetch-site': 'same-origin', 'sec-fetch-dest': 'script' } });
  assert.equal(asset.res.status, 200);
  assert.equal(routeCalls(), 1);
  assert.equal(fetched.length, assetBefore + 1);
  assert.equal(fetched.at(-1).headers.get('x-daytona-preview-token'), PREVIEW);
  assert.equal(fetched.at(-1).headers.get('cookie'), 'other=keep');
  routeImpl = () => ({ origin: 'https://upstream.example.test', token: PREVIEW, expiresAt: Date.now() + 3600e3, seat: 1, clip: { in: true, out: true }, label: LABEL });
  const participantFrame = await seat('/', { headers: frame({ origin: ENV.ORIGIN }) });
  assert.equal(participantFrame.res.status, 403);
  assert.equal(fetched.length, assetBefore + 1);
  assert.equal(routeCalls(), 2);
  const participantBridge = await seat('/__lab/demo-bridge.js', { headers: { 'sec-fetch-site': 'same-origin', 'sec-fetch-dest': 'script' } });
  assert.equal(participantBridge.res.status, 403);
  assert.equal(participantBridge.text.includes('gw-demo-ready'), false);
  assert.equal(routeCalls(), 3);
  routeImpl = () => ({ error: '모임이 끝났습니다.', status: 410 });
  const expired = await seat('/', { headers: frame() });
  assert.equal(expired.res.status, 403);
  assert.equal(fetched.length, assetBefore + 1);
  const expiredBridge = await seat('/__lab/demo-bridge.js', { headers: { 'sec-fetch-site': 'same-origin', 'sec-fetch-dest': 'script' } });
  assert.equal(expiredBridge.res.status, 410);
  assert.equal(expiredBridge.text.includes('gw-demo-ready'), false);
  assert.equal(routeCalls(), 5);
});

routeImpl = () => ({ origin: 'https://upstream.example.test', token: PREVIEW, expiresAt: Date.now() + 3600e3, seat: 1, clip: { in: true, out: true }, label: LABEL, demoParent: 'parent' });
const freshCode = 'demoseatcode0002';
await test('verified demo root iframe is embeddable without the query flag and rewrites only frame-ancestors', async () => {
  const policies = [
    ["default-src 'none'; script-src 'self' 'nonce-Ab+c/1='; style-src 'unsafe-inline'; frame-ancestors 'self' https://evil.example; img-src 'self' data:", "default-src 'none'; script-src 'self' 'nonce-Ab+c/1='; style-src 'unsafe-inline'; frame-ancestors https://k.example.test; img-src 'self' data:"],
    ["default-src 'self'; script-src 'nonce-keep'; worker-src 'self'", "default-src 'self'; script-src 'nonce-keep'; worker-src 'self'; frame-ancestors https://k.example.test"],
    ["script-src 'nonce-one'; frame-ancestors 'none', default-src 'self'; style-src 'unsafe-inline'", "script-src 'nonce-one'; frame-ancestors https://k.example.test, default-src 'self'; style-src 'unsafe-inline'; frame-ancestors https://k.example.test"],
  ];
  for (const [csp, expected] of policies) {
    upstream.headers = htmlHeaders(csp);
    resetRw();
    const before = fetched.length;
    const got = await seat('/?folder=/work', { cookie: `__Host-lab_seat=${freshCode}; other=keep`, headers: frame() });
    assert.equal(got.res.status, 200);
    assert.equal(got.res.headers.get('x-frame-options'), null);
    assert.equal(got.res.headers.get('content-security-policy'), expected);
    assert.deepEqual(srcs(), EMBED_SCRIPTS);
    assert.ok(rw.prepend.includes('<script src="/__lab/guard.js"></script>'));
    assert.ok(rw.prepend.includes('<script src="/__lab/dom-capture-prelude.js"></script>'));
    assert.match(rw.before.join(''), /nonce="n0nce"/);
    assert.equal(fetched.length, before + 1);
    assert.equal(fetched.at(-1).method, 'GET');
    assert.equal(fetched.at(-1).headers.get('x-daytona-preview-token'), PREVIEW);
    assert.equal(fetched.at(-1).headers.get('cookie'), 'other=keep');
    assert.equal(leak(got.text, got.res).includes(PREVIEW), false);
    assert.equal(leak(got.text, got.res).includes(ADMIN), false);
  }
  upstream.headers = htmlHeaders("default-src 'self'; frame-ancestors 'none'");
  resetRw();
  const headed = await seat('/', { method: 'HEAD', cookie: `__Host-lab_seat=${freshCode}`, headers: frame({ origin: ENV.ORIGIN }) });
  assert.equal(headed.res.status, 200);
  assert.equal(headed.res.headers.get('x-frame-options'), null);
  assert.match(headed.res.headers.get('content-security-policy'), /frame-ancestors https:\/\/k\.example\.test/);
  assert.equal(fetched.at(-1).method, 'HEAD');
  assert.equal(fetched.at(-1).headers.get('origin'), 'https://upstream.example.test');
  resetRw();
  const flagged = await seat('/?__demo_embed=1', { cookie: `__Host-lab_seat=${freshCode}`, headers: frame({ 'sec-fetch-site': 'same-origin' }) });
  assert.equal(flagged.res.status, 200);
  assert.deepEqual(srcs(), EMBED_SCRIPTS);
});

await test('cookie, label, origin, and site failures do not reach upstream', async () => {
  const before = fetched.length;
  const routesBefore = routeCalls();
  const denied = async (path, options) => {
    const got = await seat(path, options);
    assert.equal(got.res.status, 403);
    assert.equal(got.text.includes('gw-demo-ready'), false);
  };
  await denied('/?__demo_embed=1', { cookie: '', headers: frame({ origin: ENV.ORIGIN }) });
  await denied('/', { cookie: '__Host-lab_seat=short', headers: frame() });
  routeImpl = () => ({ origin: 'https://upstream.example.test', token: PREVIEW, expiresAt: Date.now() + 3600e3, seat: 1, clip: { in: true, out: true }, label: 'z'.repeat(26), demoParent: 'parent' });
  await denied('/', { cookie: `__Host-lab_seat=${freshCode}`, headers: frame({ origin: ENV.ORIGIN }) });
  routeImpl = () => ({ origin: 'https://upstream.example.test', token: PREVIEW, expiresAt: Date.now() + 3600e3, seat: 1, clip: { in: true, out: true }, label: LABEL, demoParent: 'parent' });
  await denied('/', { headers: frame({ origin: 'https://evil.example' }) });
  await denied('/', { headers: frame({ origin: ME }) });
  await denied('/', { headers: frame({ 'sec-fetch-site': 'cross-site', origin: ENV.ORIGIN }) });
  await denied('/static/x.js', { headers: { 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'script' } });
  await denied('/__lab/me', { headers: { 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' } });
  await denied('/', { method: 'POST', headers: { 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', origin: ENV.ORIGIN } });
  await denied('/', { headers: { ...frame(), upgrade: 'websocket' } });
  assert.equal(fetched.length, before);
  const badCookieBridge = await seat('/__lab/demo-bridge.js', { cookie: '', headers: { 'sec-fetch-site': 'same-origin', 'sec-fetch-dest': 'script' } });
  assert.equal(badCookieBridge.res.status, 401);
  assert.equal(badCookieBridge.text.includes('gw-demo-ready'), false);
  assert.equal(routeCalls(), routesBefore + 1);
});

await test('nested iframe keeps guard, XFO, and CSP; site none is not an embed allow', async () => {
  const csp = "default-src 'self'; script-src 'nonce-keep'; frame-ancestors 'self'";
  upstream.headers = htmlHeaders(csp);
  resetRw();
  const nested = await seat('/webview/index.html', { headers: { 'sec-fetch-site': 'same-origin', 'sec-fetch-dest': 'iframe', accept: 'text/html' } });
  assert.equal(nested.res.status, 200);
  assert.deepEqual(rw.prepend, ['<script src="/__lab/guard.js"></script>']);
  assert.deepEqual(srcs(), []);
  assert.equal(nested.res.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.equal(nested.res.headers.get('content-security-policy'), csp);
  resetRw();
  const direct = await seat('/', { headers: { 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe' } });
  assert.equal(direct.res.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.equal(direct.res.headers.get('content-security-policy'), csp);
  assert.deepEqual(srcs(), []);
  assert.equal(direct.text.includes('gw-demo-ready'), false);
});

await test('demo bridge is the authenticated no-store script and nothing else', async () => {
  const got = await seat('/__lab/demo-bridge.js', { cookie: `__Host-lab_seat=${freshCode}`, headers: { 'sec-fetch-site': 'same-origin', 'sec-fetch-dest': 'script' } });
  assert.equal(got.res.status, 200);
  assert.equal(got.res.headers.get('cache-control'), 'no-store');
  assert.equal(got.text, labDemoEmbedBridgeJS(ENV.ORIGIN));
  assert.equal(got.text.includes(PREVIEW), false);
  assert.equal(got.text.includes(ADMIN), false);
  assert.equal(got.text.includes(GRANT), false);
  assert.equal(got.text.includes(CODE), false);
});

await test('default landing stays framed-off; embed=1 allows only env.ORIGIN and redirects without the grant', async () => {
  const origin = ME;
  const open = (path) => labDemoHost(new Request(origin + path), { ...ENV, ADMIN }, {}, new URL(origin + path), LABEL);
  const plain = await open('/__lab/demo-open');
  const plainText = await plain.text();
  assert.equal(plain.headers.get('x-frame-options'), 'DENY');
  assert.equal(plain.headers.get('content-security-policy'), OPEN_CSP);
  const other = await open('/__lab/demo-open?embed=true');
  assert.equal(other.headers.get('x-frame-options'), 'DENY');
  assert.equal(other.headers.get('content-security-policy'), OPEN_CSP);
  const embedded = await open('/__lab/demo-open?embed=1#ignored');
  const html = await embedded.text();
  assert.equal(embedded.headers.get('x-frame-options'), null);
  assert.equal(embedded.headers.get('content-security-policy'), OPEN_CSP.replace("frame-ancestors 'none'", `frame-ancestors ${ENV.ORIGIN}`));
  assert.equal(html.includes(ADMIN), false);
  assert.equal(html.includes(GRANT), false);
  assert.equal(html.includes(PREVIEW), false);
  const run = async (search) => {
    const events = []; let posted = null;
    const location = { pathname: '/__lab/demo-open', search, hash: '#' + GRANT, replace: (url) => events.push(['replace', url]) };
    const history = { replaceState: (_state, _title, url) => { events.push(['history', url, location.search]); location.search = ''; location.hash = ''; } };
    const note = { textContent: '' }; const button = { hidden: true };
    const document = { getElementById: (id) => id === 'note' ? note : button };
    const fetchImpl = async (url, init) => { posted = { url, method: init.method, body: init.body }; events.push(['fetch', location.hash]); return { ok: true, json: async () => ({ ok: true }) }; };
    const script = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>'));
    new Function('location', 'history', 'document', 'fetch', 'AbortController', 'setTimeout', 'clearTimeout', script)(location, history, document, fetchImpl, AbortController, setTimeout, clearTimeout);
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    return { events, posted };
  };
  const embedRun = await run('?embed=1');
  assert.deepEqual(embedRun.events[0], ['history', '/__lab/demo-open', '?embed=1']);
  assert.equal(embedRun.posted.url, '/__lab/demo-enter');
  assert.equal(embedRun.posted.method, 'POST');
  assert.deepEqual(JSON.parse(embedRun.posted.body), { grant: GRANT });
  assert.deepEqual(embedRun.events.at(-1), ['replace', '/?__demo_embed=1']);
  const plainRun = await run('');
  assert.deepEqual(plainRun.events.at(-1), ['replace', '/']);
  const notEmbed = await run('?embed=true');
  assert.deepEqual(notEmbed.events.at(-1), ['replace', '/']);
  const claim = await labDemoHost(new Request(origin + '/__lab/demo-enter', { method: 'POST', headers: { origin, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }, body: JSON.stringify({ grant: GRANT }) }), ENV, { labClassroomDemoClaim: async (...args) => { assert.deepEqual(args, [GRANT, LABEL]); return { code: 'private-fixture', expiresAt: Date.now() + 60000 }; } }, new URL(origin + '/__lab/demo-enter'), LABEL);
  assert.equal(claim.status, 200);
  assert.deepEqual(await claim.json(), { ok: true });
  assert.match(claim.headers.get('set-cookie'), /^__Host-lab_seat=private-fixture;/);
  assert.equal(claim.headers.get('x-frame-options'), 'DENY');
  const foreign = await labDemoHost(new Request(origin + '/__lab/demo-enter', { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: JSON.stringify({ grant: GRANT }) }), ENV, { labClassroomDemoClaim() { throw Error('must not be called'); } }, new URL(origin + '/__lab/demo-enter'), LABEL);
  assert.equal(foreign.status, 403);
});

await test('operator framing policy allows seat children only on the classroom page', async () => {
  const {publicGet}=await load('src/public-get.ts');
  const get=path=>publicGet({path,url:new URL(path,ENV.ORIGIN),env:{...ENV,RP_ID:'example.test'},state:{},sec:{'x-frame-options':'DENY'},html:body=>new Response(body),json:body=>Response.json(body),out:body=>Response.json(body)});
  const page=await get('/lab'),requests=await get('/lab/requests');
  assert.match(page.headers.get('content-security-policy'),/frame-src https:\/\/\*\.example\.test(?:;|$)/);
  assert.match(page.headers.get('content-security-policy'),/frame-ancestors 'none'/);
  assert.equal(page.headers.get('x-frame-options'),'DENY');
  assert.equal(requests.headers.get('content-security-policy').includes('frame-src'),false);
});
console.log(count + ' demo embed host checks passed');
