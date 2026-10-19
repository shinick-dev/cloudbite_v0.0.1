// Cloudbite computer costs: src/cloudbite-computer-costs.ts with an injected fetch (no network, no keys) and the generated page
// (src/cloudbite-computer-costs-page.ts) in a small fake DOM. Pins running vs stopped rates, Daytona 403 as unavailable (never
// zero), malformed or non-finite Nosana figures, bounded paging, the 60 s cache and refresh floor, cache isolation between
// configurations, and that no key, email or raw provider body reaches the answer or the page. Real-browser checks are the coordinator's.
//   node test/cloudbite-computer-costs.mjs
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { build } from 'esbuild';
import { CLOUDBITE_COMPUTER_COSTS_JS, CLOUDBITE_COMPUTER_COSTS_HTML, CLOUDBITE_COMPUTER_COSTS_CSS, CLOUDBITE_COMPUTER_COSTS_PATH } from '../src/cloudbite-computer-costs-page.ts';

const b = await build({ entryPoints: ['src/cloudbite-computer-costs.ts'], write: false, bundle: true, platform: 'neutral', format: 'esm' });
const m = await import('data:text/javascript;base64,' + Buffer.from(b.outputFiles[0].text).toString('base64'));
const { COMPUTER_PRICING: P } = await import('data:text/javascript;base64,' + Buffer.from((await build({ entryPoints: ['src/cloudbite-computer-performance.ts'], write: false, bundle: true, platform: 'neutral', format: 'esm' })).outputFiles[0].text).toString('base64'));

let pass = 0;
const test = async (name, fn) => { m.computerCostsCacheClear(); await fn(); pass++; console.log(`  ok   ${name}`); };
const KEY = 'dtn_primary_SECRET', KEY2 = 'dtn_secondary_SECRET', NKEY = 'nos_SECRET_key';
const OWNER = 'abcdef0123456789abcdef01';
const sb = (o = {}) => ({ id: 'sandbox-run-1', organizationId: 'org-1', name: 'cloudbite-computer-primary', state: 'started', cpu: 4, memory: 8, disk: 30, gpu: 0, target: 'us',
  labels: { 'cloudbite-computer': OWNER }, env: { SECRET: 'hidden-env' }, toolboxProxyUrl: 'https://private.invalid', ...o });
const usage = { regionUsage: [{ regionId: 'us', sandboxClass: 'container', currentCpuUsage: 6, totalCpuQuota: 10, currentMemoryUsage: 12, totalMemoryQuota: 20, currentDiskUsage: 60, totalDiskQuota: 100, maxCpuPerSandbox: 4, maxMemoryPerSandbox: 8, maxDiskPerSandbox: 50 }] };
const res = (status, body) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** routes by URL; records every call (method, url, auth) */
function fake(routes) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url, method: init.method, auth: init.headers?.authorization, redirect: init.redirect, signal: !!init.signal });
    for (const [re, fn] of routes) if (re.test(url)) return fn(url, init);
    return res(404, { message: 'no route' });
  };
  return { fetch, calls };
}
const daytonaOk = (list = [sb(), sb({ id: 'sandbox-stop-1', name: 'old-box', state: 'stopped', cpu: 2, memory: 4, disk: 20, labels: {} })]) => [
  [/app\.daytona\.io\/api\/sandbox\?/, () => res(200, { items: list, nextCursor: null })],
  [/\/organizations\/org-1\/usage$/, () => res(200, usage)],
];
const nosanaOk = [[/api\.nosana\.com\/api\/credits\/balance$/, () => res(200, { assignedCredits: 50, reservedCredits: 12.5, settledCredits: 5.005 })]];
const env1 = { CLOUDBITE_DAYTONA_API_KEY: KEY, CLOUDBITE_COMPUTER_NOSANA_API_KEY: NKEY };
let clock = 1_800_000_000_000;
const deps = (f) => ({ fetch: f.fetch, now: () => clock });
const noSecrets = (o) => assert.doesNotMatch(JSON.stringify(o), /SECRET|hidden-env|private\.invalid|@example|no route|Bearer/);

await test('running pays CPU+RAM+disk, stopped pays disk only, archived is free; owner computer flagged; quota from usage', async () => {
  const f = fake([...daytonaOk([sb(), sb({ id: 'sandbox-stop-1', name: 'old-box', state: 'stopped', labels: {} }), sb({ id: 'sandbox-arch-1', state: 'archived', labels: {} })]), ...nosanaOk]);
  const { status, body } = await m.computerCosts(env1, { ownerTag: OWNER, deps: deps(f) });
  assert.equal(status, 200); assert.equal(body.ok, true); assert.equal(body.partial, false); assert.equal(body.cached, false);
  const [a] = body.daytona.accounts;
  assert.equal(a.id, 'primary'); assert.equal(a.status, 'ok');
  const run = 4 * P.cpuPerHour + 8 * P.memoryGiBPerHour + (30 - P.freeDiskGiB) * P.diskGiBPerHour, stop = (30 - P.freeDiskGiB) * P.diskGiBPerHour;
  const byId = Object.fromEntries(a.sandboxes.map((s) => [s.id, s]));
  assert.ok(Math.abs(byId['sandbox-run-1'].usdPerHour - run) < 1e-6); assert.equal(byId['sandbox-run-1'].rateBasis, 'running_all'); assert.equal(byId['sandbox-run-1'].computer, true);
  assert.ok(Math.abs(byId['sandbox-stop-1'].usdPerHour - stop) < 1e-6); assert.equal(byId['sandbox-stop-1'].rateBasis, 'stopped_disk'); assert.equal(byId['sandbox-stop-1'].computer, false);
  assert.ok(byId['sandbox-stop-1'].usdPerHour < byId['sandbox-run-1'].usdPerHour / 10, 'stopped storage rate is distinct from running burn');
  assert.equal(byId['sandbox-arch-1'].usdPerHour, 0); assert.equal(byId['sandbox-arch-1'].rateBasis, 'archived_free');
  assert.ok(Math.abs(body.daytona.totals.runningUsdPerHour - run) < 1e-6); assert.ok(Math.abs(body.daytona.totals.stoppedUsdPerHour - stop) < 1e-6);
  assert.deepEqual([a.totals.running, a.totals.stopped, a.totals.archived], [1, 1, 1]);
  assert.equal(a.usage.status, 'ok'); assert.deepEqual(a.usage.regions[0].cpu, { used: 6, quota: 10 }); assert.equal(a.usage.regions[0].maxCpuPerSandbox, 4, 'max CPU comes from the provider, not a constant');
  assert.equal(a.balance.status, 'not_available_via_api');
  assert.deepEqual(body.nosana, { status: 'ok', error: null, unit: 'usd', assignedUsd: 50, reservedUsd: 12.5, settledUsd: 5.005, availableUsd: 32.495, dashboardUrl: 'https://dashboard.nosana.com/' });
  assert.ok(body.excluded.includes('snapshots') && body.excluded.includes('network'));
  assert.ok(f.calls.every((c) => c.method === 'GET' && c.redirect === 'manual' && c.signal), 'read-only bounded GETs only');
  assert.equal(f.calls.find((c) => c.url.includes('nosana')).auth, `Bearer ${NKEY}`);
  assert.ok(f.calls.filter((c) => c.url.includes('daytona')).every((c) => c.auth === `Bearer ${KEY}`));
  noSecrets(body);
});

await test('live Nosana USD contract: raw balance 20 minus 1.254 remains $18.746, not $0.18746', async () => {
  const f = fake([...daytonaOk(), [/credits\/balance$/,()=>res(200,{assignedCredits:20,reservedCredits:0,settledCredits:1.254})]]);
  const {body} = await m.computerCosts(env1,{deps:deps(f)});
  assert.equal(body.nosana.assignedUsd,20);
  assert.equal(body.nosana.settledUsd,1.254);
  assert.equal(body.nosana.availableUsd,18.746);
});

await test('unknown rates stay null: GPU, non-finite sizes and transitional states are counted, not priced', async () => {
  const f = fake([...daytonaOk([sb({ id: 'sandbox-gpu-1', gpu: 1 }), sb({ id: 'sandbox-nan-1', cpu: 'x' }), sb({ id: 'sandbox-strt-1', state: 'starting' }), sb({ id: 'bad' })]), ...nosanaOk]);
  const { body } = await m.computerCosts(env1, { deps: deps(f) });
  const [a] = body.daytona.accounts;
  assert.equal(a.sandboxes.length, 3, 'invalid ids are dropped');
  assert.ok(a.sandboxes.every((s) => s.usdPerHour === null && s.rateBasis === 'unknown'));
  assert.equal(body.daytona.totals.unknownRate, 3); assert.equal(body.daytona.totals.runningUsdPerHour, 0);
  assert.equal(a.sandboxes.find((s) => s.id === 'sandbox-nan-1').cpu, null);
});

await test('unknown GPU allocation cannot be priced as a proven CPU-only machine', async () => {
  const f = fake([...daytonaOk([sb({gpu:null}), sb({id:'sandbox-bad-gpu',gpu:'unknown'}), sb({id:'sandbox-no-gpu',gpu:undefined})]), ...nosanaOk]);
  const {body} = await m.computerCosts(env1,{deps:deps(f)});
  assert.equal(body.daytona.totals.unknownRate,3);
  assert.ok(body.daytona.accounts[0].sandboxes.every(s=>s.usdPerHour===null));
});

await test('Daytona 403 is unavailable (not zero) with a fixed code; another account still listed; partial', async () => {
  const f = fake([
    [/secondary\.invalid\/api\/sandbox\?/, () => res(403, { message: 'Forbidden for owner@example.com key dtn_secondary_SECRET' })],
    ...daytonaOk(), ...nosanaOk]);
  const env = { ...env1, CLOUDBITE_DAYTONA_SECONDARY_API_KEY: KEY2, CLOUDBITE_DAYTONA_SECONDARY_API_URL: 'https://secondary.invalid/api' };
  const { body } = await m.computerCosts(env, { deps: deps(f) });
  assert.equal(body.partial, true);
  const sec = body.daytona.accounts.find((a) => a.id === 'secondary');
  assert.equal(sec.status, 'unavailable'); assert.equal(sec.error, 'forbidden'); assert.deepEqual(sec.sandboxes, []);
  assert.equal(sec.usage.status, 'unknown');
  assert.equal(body.daytona.accounts.find((a) => a.id === 'primary').status, 'ok');
  noSecrets(body);
});

await test('usage 403 is unavailable; no sandboxes means quota unknown; Nosana not configured', async () => {
  let f = fake([[/\/sandbox\?/, () => res(200, { items: [sb()], nextCursor: null })], [/\/usage$/, () => res(403, 'denied owner@example.com')]]);
  let { body } = await m.computerCosts({ CLOUDBITE_DAYTONA_API_KEY: KEY }, { deps: deps(f) });
  assert.equal(body.daytona.accounts[0].usage.status, 'unavailable'); assert.equal(body.daytona.accounts[0].usage.error, 'forbidden'); assert.equal(body.partial, true);
  assert.equal(body.nosana.status, 'not_configured'); assert.equal(body.nosana.availableUsd, null);
  assert.ok(!f.calls.some((c) => c.url.includes('nosana')), 'no Nosana call without the key');
  noSecrets(body);
  m.computerCostsCacheClear();
  f = fake([[/\/sandbox\?/, () => res(200, { items: [], nextCursor: null })]]);
  ({ body } = await m.computerCosts({ CLOUDBITE_DAYTONA_API_KEY: KEY }, { deps: deps(f) }));
  assert.equal(body.daytona.accounts[0].usage.status, 'unknown'); assert.equal(f.calls.length, 1);
  assert.equal(body.daytona.accounts[0].status, 'ok');
});

await test('Nosana malformed, non-finite, string or failing answers are never numbers', async () => {
  for (const [answer, status, error] of [
    [() => res(200, { assignedCredits: '5000', reservedCredits: 0, settledCredits: 0 }), 'invalid_response', 'invalid_response'],
    [() => res(200, '{"assignedCredits":1e999,"reservedCredits":0,"settledCredits":0}'), 'invalid_response', 'invalid_response'],
    [() => res(200, { assignedCredits: 1, reservedCredits: null, settledCredits: 0 }), 'invalid_response', 'invalid_response'],
    [() => res(200, '<html>oops</html>'), 'unavailable', 'invalid_response'],
    [() => res(401, { message: 'bad key nos_SECRET_key' }), 'unavailable', 'unauthorized'],
    [() => res(429, {}), 'unavailable', 'rate_limited'],
    [() => res(502, 'gateway owner@example.com'), 'unavailable', 'upstream_error'],
    [() => res(302, ''), 'unavailable', 'upstream_error'],
    [() => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); }, 'unavailable', 'timeout'],
    [() => { throw new TypeError('fetch failed nos_SECRET_key'); }, 'unavailable', 'unreachable'],
  ]) {
    m.computerCostsCacheClear();
    const f = fake([...daytonaOk(), [/credits\/balance$/, answer]]);
    const { body } = await m.computerCosts(env1, { deps: deps(f) });
    assert.equal(body.nosana.status, status); assert.equal(body.nosana.error, error);
    assert.deepEqual([body.nosana.assignedUsd, body.nosana.reservedUsd, body.nosana.settledUsd, body.nosana.availableUsd, body.nosana.unit], [null, null, null, null, null]);
    assert.equal(body.partial, true); noSecrets(body);
  }
});

await test('listing stops after 2 pages: truncated, partial, still priced; malformed list is invalid_response', async () => {
  let n = 0;
  let f = fake([[/\/sandbox\?/, (url) => { n++; return res(200, { items: [sb({ id: `sandbox-page-${n}` })], nextCursor: `c${n}` }); }], [/\/usage$/, () => res(200, usage)], ...nosanaOk]);
  let { body } = await m.computerCosts(env1, { deps: deps(f) });
  const a = body.daytona.accounts[0];
  assert.equal(n, 2); assert.equal(a.truncated, true); assert.equal(a.status, 'partial'); assert.equal(a.sandboxes.length, 2); assert.equal(body.partial, true);
  const pages = f.calls.filter((c) => c.url.includes('/sandbox?'));
  assert.ok(pages[1].url.includes('cursor=c1') && pages[0].url.includes('limit=100'));
  m.computerCostsCacheClear();
  f = fake([[/\/sandbox\?/, () => res(200, { items: 'nope' })], ...nosanaOk]);
  ({ body } = await m.computerCosts(env1, { deps: deps(f) }));
  assert.equal(body.daytona.accounts[0].status, 'unavailable'); assert.equal(body.daytona.accounts[0].error, 'invalid_response');
  assert.equal(body.daytona.totals.runningUsdPerHour, 0); assert.equal(body.daytona.accounts[0].totals.running, 0);
});

await test('cache: 60 s reuse with age, refresh honoured only after 10 s, concurrent callers share one observation', async () => {
  const f = fake([...daytonaOk(), ...nosanaOk]);
  const first = (await m.computerCosts(env1, { deps: deps(f) })).body;
  const calls = f.calls.length;
  clock += 5_000;
  let r = (await m.computerCosts(env1, { deps: deps(f) })).body;
  assert.equal(r.cached, true); assert.equal(r.cacheAgeMs, 5_000); assert.equal(r.observedAt, first.observedAt); assert.equal(f.calls.length, calls);
  r = (await m.computerCosts(env1, { refresh: true, deps: deps(f) })).body;
  assert.equal(r.cached, true, 'refresh inside 10 s reuses the cache'); assert.equal(f.calls.length, calls);
  clock += 6_000;
  r = (await m.computerCosts(env1, { refresh: true, deps: deps(f) })).body;
  assert.equal(r.cached, false); assert.equal(f.calls.length, calls * 2);
  clock += 59_000;
  assert.equal((await m.computerCosts(env1, { deps: deps(f) })).body.cached, true);
  clock += 2_000;
  assert.equal((await m.computerCosts(env1, { deps: deps(f) })).body.cached, false);
  m.computerCostsCacheClear();
  const g = fake([...daytonaOk(), ...nosanaOk]);
  const [x, y] = await Promise.all([m.computerCosts(env1, { deps: deps(g) }), m.computerCosts(env1, { deps: deps(g) })]);
  assert.equal(x.body.observedAt, y.body.observedAt); assert.equal(g.calls.length, calls, 'one observation for two concurrent callers');
});

await test('cache isolation: another key, account set or owner never sees a cached answer', async () => {
  const f = fake([...daytonaOk(), ...nosanaOk]);
  await m.computerCosts(env1, { ownerTag: OWNER, deps: deps(f) });
  const n = f.calls.length;
  await m.computerCosts({ ...env1, CLOUDBITE_DAYTONA_API_KEY: 'other' }, { ownerTag: OWNER, deps: deps(f) });
  assert.equal(f.calls.length, n * 2);
  await m.computerCosts(env1, { ownerTag: 'ffffffff00000000ffffffff', deps: deps(f) });
  assert.equal(f.calls.length, n * 3);
  await m.computerCosts({ CLOUDBITE_DAYTONA_API_KEY: KEY }, { ownerTag: OWNER, deps: deps(f) });
  assert.ok(f.calls.length > n * 3);
});

// ───────────────────────── page ─────────────────────────

class El {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.attrs = {}; this.listeners = {}; this.parent = null; this.className = ''; this._text = ''; this.disabled = false; this.hidden = false; }
  get textContent() { return this._text + this.children.map((c) => typeof c === 'string' ? c : c.textContent).join(''); }
  set textContent(v) { this.children = []; this._text = String(v); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }
  append(...ns) { for (const n of ns) { if (typeof n !== 'string') n.parent = this; this.children.push(n); } }
  replaceChildren(...ns) { this.children = []; this._text = ''; this.append(...ns); }
  click() { if (!this.disabled) for (const f of this.listeners.click || []) f({}); }
  *walk() { for (const c of this.children) if (typeof c !== 'string') { yield c; yield* c.walk(); } }
  shown() { let n = this; while (n) { if (n.hidden) return false; n = n.parent; } return true; }
}
async function page({ route, search = '' }) {
  const root = new El('div'), requests = [];
  const doc = { title: '', documentElement: { lang: 'en' }, createElement: (t) => new El(t), getElementById: (id) => (id === 'cb-computer-costs' ? root : null) };
  const ctx = vm.createContext({ document: doc, location: { search }, URLSearchParams, Date, navigator: { language: 'en-US' },
    fetch: async (url, init) => { requests.push({ url, init }); return route(url); } });
  vm.runInContext(CLOUDBITE_COMPUTER_COSTS_JS, ctx);
  const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
  await flush();
  const all = () => [...root.walk()];
  const text = () => all().filter((e) => e.shown()).map((e) => [e._text, ...e.children.filter((c) => typeof c === 'string')].join('')).join(' | ');
  const btn = (label) => all().find((e) => e.tagName === 'BUTTON' && e.shown() && e.textContent === label);
  return { root, doc, requests, flush, all, text, btn };
}
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

await test('page: static contract, no inline code, same-origin only, fixed official links', async () => {
  assert.equal(CLOUDBITE_COMPUTER_COSTS_PATH, '/cloudbite/computer/costs');
  assert.match(CLOUDBITE_COMPUTER_COSTS_HTML, /<script src="\/cloudbite\/computer\/costs\.js" defer><\/script>/);
  assert.doesNotMatch(CLOUDBITE_COMPUTER_COSTS_HTML, /<script>|\sstyle=|\son\w+=/);
  assert.doesNotMatch(CLOUDBITE_COMPUTER_COSTS_CSS, /@import|url\(/);
  assert.doesNotMatch(CLOUDBITE_COMPUTER_COSTS_JS, /localStorage|sessionStorage|innerHTML|eval\(|PublicKeyCredential|navigator\.credentials|setInterval/);
  const urls = new Set(CLOUDBITE_COMPUTER_COSTS_JS.match(/https:\/\/[^'"\s]+/g));
  assert.deepEqual([...urls].sort(), ['https://app.daytona.io/dashboard/billing/wallet', 'https://dashboard.nosana.com/', 'https://learn.nosana.com/api/credits.html', 'https://www.daytona.io/docs/en/billing', 'https://www.daytona.io/pricing']);
});

await test('page: 401 shows the main sign-in link only; no WebAuthn, no retry loop', async () => {
  const p = await page({ route: () => json(401, { error: { code: 'unauthorized' } }) });
  assert.equal(p.requests.length, 1); assert.equal(p.requests[0].url, '/api/cloudbite/computer/costs');
  assert.equal(p.requests[0].init.credentials, 'same-origin'); assert.equal(p.requests[0].init.headers, undefined);
  const a = p.all().find((e) => e.tagName === 'A' && e.shown() && e.getAttribute('href') === '/cloudbite/computer' && /Sign in/.test(e.textContent));
  assert.ok(a); assert.match(p.text(), /not signed in/); assert.equal(p.btn('Refresh'), undefined);
});

await test('page: renders estimates apart from balances, unavailable not zero, explicit refresh, KO switch', async () => {
  const f = fake([
    [/secondary\.invalid\/api\/sandbox\?/, () => res(403, {})], ...daytonaOk(), ...nosanaOk]);
  m.computerCostsCacheClear();
  const env = { ...env1, CLOUDBITE_DAYTONA_SECONDARY_API_KEY: KEY2, CLOUDBITE_DAYTONA_SECONDARY_API_URL: 'https://secondary.invalid/api' };
  const body = (await m.computerCosts(env, { ownerTag: OWNER, deps: deps(f) })).body;
  // a hostile name must stay text
  body.daytona.accounts[0].sandboxes[1].name = '<img src=x onerror=alert(1)>';
  const p = await page({ route: () => json(200, body) });
  const est = p.all().find((e) => e.getAttribute('data-section') === 'estimates'), bal = p.all().find((e) => e.getAttribute('data-section') === 'balances');
  assert.ok(est && bal && est !== bal);
  assert.match(est.textContent, /Running now/); assert.match(est.textContent, /Stopped \(storage\)/); assert.match(est.textContent, /\/h/);
  assert.doesNotMatch(est.textContent, /Nosana credits/); assert.doesNotMatch(bal.textContent, /Running now/);
  assert.match(bal.textContent, /Available\$32\.49/); assert.match(bal.textContent, /Reserved\$12\.50/); assert.match(bal.textContent, /no balance API/);
  const sec = p.all().find((e) => e.getAttribute('data-account') === 'secondary');
  assert.match(sec.textContent, /unavailable/); assert.match(sec.textContent, /forbidden/); assert.doesNotMatch(sec.textContent, /\$0\.00/);
  assert.match(p.text(), /Some providers did not answer/); assert.match(p.text(), /Observed /);
  assert.ok(p.all().some((e) => e.tagName === 'STRONG' && e.textContent === '<img src=x onerror=alert(1)>'));
  assert.ok(!p.all().some((e) => e.tagName === 'IMG'));
  assert.ok(p.all().filter((e) => e.tagName === 'A').every((e) => e.getAttribute('href').startsWith('/') || e.getAttribute('rel') === 'noopener noreferrer'));
  p.btn('Refresh').click(); await p.flush();
  assert.equal(p.requests.length, 2); assert.equal(p.requests[1].url, '/api/cloudbite/computer/costs?refresh=1');
  p.all().find((e) => e.tagName === 'BUTTON' && e.textContent === 'KO').click();
  assert.equal(p.doc.documentElement.lang, 'ko'); assert.match(p.text(), /예상 시간당 비용/); assert.match(p.text(), /확인 불가/);
  assert.equal(p.requests.length, 2, 'language switch does not refetch');
});

await test('page: malformed server answer and non-finite balance are shown as unexpected, never as numbers', async () => {
  let p = await page({ route: () => json(200, { ok: true }) });
  assert.match(p.text(), /unexpected way/);
  const body = { ok: true, observedAt: '2026-10-19T00:00:00.000Z', cacheAgeMs: 0, daytona: { accounts: [], totals: {} },
    nosana: { status: 'ok', assignedUsd: 'NaN', reservedUsd: 1, settledUsd: 1, availableUsd: 1 } };
  p = await page({ route: () => json(200, body) });
  const nb = p.all().find((e) => e.getAttribute('data-nosana'));
  assert.equal(nb.getAttribute('data-nosana'), 'invalid_response'); assert.doesNotMatch(nb.textContent, /\$/);
  assert.match(p.all().find((e) => e.getAttribute('data-section') === 'estimates').textContent, /unknown/);
});

await test('page: no inventory observed means unknown total, not a zero-dollar estimate', async () => {
  const f = fake([[/./,()=>res(403,{})]]);
  const {body} = await m.computerCosts(env1,{deps:deps(f)});
  const p = await page({route:()=>json(200,body)});
  const est = p.all().find(e=>e.getAttribute('data-section')==='estimates');
  assert.match(est.textContent,/unknown/);
  assert.doesNotMatch(est.textContent,/\$0\.00/);
});

console.log(`cloudbite-computer-costs: ${pass} passed`);
