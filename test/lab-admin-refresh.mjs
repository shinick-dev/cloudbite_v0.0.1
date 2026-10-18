// Actual Worker/State + synthetic WebAuthn in isolated Edge. Aside cannot inject a virtual authenticator.
// No real security key, production account, sandbox or provider is used.
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { build } from 'esbuild';

let pass = 0, failN = 0, skipN = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { failN++; console.log(`  FAIL ${name} ${String(extra).slice(0, 400)}`); }
};
const J = JSON.stringify;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64u = (b) => Buffer.from(b).toString('base64url');
const b64sha = (s) => createHash('sha256').update(s).digest('base64url');
const done = () => { console.log(`\n${pass} ok, ${failN} fail, ${skipN} skip`); process.exit(failN ? 1 : 0); };
setTimeout(() => { console.log('  FAIL 전체 시간 상한 180초'); failN++; done(); }, 180000).unref();

let chromium, browser;
try { ({ chromium } = await import('playwright-core')); browser = await chromium.launch({ channel: 'msedge', headless: true }); }
catch (e) { skipN++; console.log(`  skip Edge 없음 (${String(e.message).split('\n')[0]})`); done(); }

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const cfStub = { name: 'cf-stub', setup(b) {
  b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'cf', namespace: 'cf-stub' }));
  b.onLoad({ filter: /.*/, namespace: 'cf-stub' }, () => ({ contents: 'export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }', loader: 'js' }));
} };
const bundled = await build({ entryPoints: [join(ROOT, 'src/index.ts')], bundle: true, write: false, format: 'esm', platform: 'node', loader: { '.ps1': 'text' }, plugins: [cfStub], logLevel: 'silent' });
const mod = await import('data:text/javascript;base64,'+Buffer.from(bundled.outputFiles[0].text).toString('base64'));
const worker = mod.default;
const outbound = [];
globalThis.fetch = async (u) => { outbound.push(String(u?.url ?? u)); throw new Error(`network blocked in test: ${u}`); };

// 저장소: 메모리. blockConcurrencyWhile: 한 번에 하나 (DO 의 직렬 구역 흉내)
const m = new Map();
let alarm = null;
const cl = (v) => (v === undefined ? v : structuredClone(v));
const storage = {
  async get(k) { if (Array.isArray(k)) { const r = new Map(); for (const x of k) if (m.has(x)) r.set(x, cl(m.get(x))); return r; } return cl(m.get(k)); },
  async put(k, v) { if (typeof k === 'object') { for (const [a, b] of Object.entries(k)) m.set(a, cl(b)); } else m.set(k, cl(v)); },
  async delete(k) { const ks = Array.isArray(k) ? k : [k]; let n = 0; for (const x of ks) if (m.delete(x)) n++; return Array.isArray(k) ? n : n > 0; },
  async list({ prefix = '' } = {}) { return new Map([...m.keys()].filter((x) => x.startsWith(prefix)).sort().map((x) => [x, cl(m.get(x))])); },
  async getAlarm() { return alarm; }, async setAlarm(t) { alarm = t; },
};
let q = Promise.resolve();
const bcw = (f) => { const r = q.then(f); q = r.catch(() => {}); return r; };
class T extends mod.State { async daytona() { return { status: 409, error: 'no daytona in test' }; } }

const srv = createServer();
await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
const O = `http://localhost:${srv.address().port}`;
const envOf = () => ({ ORIGIN: O, LAB_ORIGIN: 'https://lab.example.test', LAB_SEAT_DOMAIN: 'example.test', RP_ID: 'localhost', MASTER_KEY: 'dummy-master-key' });
const st = new T({ storage, waitUntil() {}, blockConcurrencyWhile: bcw }, envOf());
const env = { ...envOf(), STATE: { idFromName: (n) => ({ name: n }), get: () => st } };
const credId = randomBytes(16);
const teachers = () => [...m.keys()].filter((k) => k.startsWith('teacher:')).sort();

// session 붙잡기: 'before' = 서버가 처리하기 전에, 'after' = 처리한 뒤 응답(Set-Cookie)만 붙잡기
let hold = null, restoreHold = null, persistHold = null;
const holdSession = (mode) => { const h = { mode }; h.release = null; h.gate = new Promise((r) => (h.release = r)); h.arrived = new Promise((r) => (h.arrive = r)); h.sent = new Promise((r) => (h.send = r)); hold = h; return h; };
const reqs = [];
srv.on('request', async (nreq, nres) => {
  const u = new URL(nreq.url, O), p = u.pathname;
  const chunks = []; for await (const c of nreq) chunks.push(c);
  const raw = Buffer.concat(chunks);
  const h = new Headers(); for (const [k, v] of Object.entries(nreq.headers)) if (k !== 'host' && v !== undefined) h.set(k, Array.isArray(v) ? v.join(', ') : v);
  reqs.push({ p, cookie: h.get('cookie') ?? '', admin: h.get('x-admin-token') ?? '' });
  const send = async (res) => { const hs = {}; res.headers.forEach((v, k) => { if (k !== 'set-cookie') hs[k] = v; }); const sc = res.headers.getSetCookie(); if (sc.length) hs['set-cookie'] = sc;
    nres.writeHead(res.status, hs); nres.end(Buffer.from(await res.arrayBuffer())); };
  const json = (d, status = 200) => new Response(J(d), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
  try {
    if (p === '/api/admin/options') return await send(json({ challenge: b64u(randomBytes(32)), rpId: 'localhost', allowCredentials: [{ type: 'public-key', id: b64u(credId) }], userVerification: 'preferred', timeout: 60000 }));
    if (p === '/api/admin/login') return await send(json(await st.newAdminToken('web')));
    if (p === '/api/lab/config' || p === '/api/lab/list') {
      if (!(await st.checkAdmin(h.get('x-admin-token') ?? ''))) return await send(json({ error: '관리 세션이 만료됐습니다.' }, 401));
      return await send(json(p === '/api/lab/list' ? { labs: [], quota: null, now: Date.now() }
        : { labOrigin: 'https://lab.example.test', quota: null, hours: [1, 2, 3], budgets: [1, 2, 5], daytona: true, openrouter: true, shareable: [], cfg: { gw: 'g', snapshot: 's', model: 'm', clip: { in: true, out: true }, share: {} } }));
    }
    const req = new Request(O + nreq.url, { method: nreq.method, headers: h, ...(raw.length ? { body: raw } : {}) });
    const g = p === '/api/lab/teacher/session' ? hold : p === '/api/lab/admin/session' ? restoreHold : p === '/api/lab/admin/session/remember' ? persistHold : null;
    if (g) { if(p === '/api/lab/teacher/session')hold=null;else if(p === '/api/lab/admin/session')restoreHold=null;else persistHold=null; g.arrive(); if (g.mode === 'before') await g.gate; }
    const res = await worker.fetch(req, env, { waitUntil() {}, passThroughOnException() {} });
    if (g) { g.res = res.headers.getSetCookie(); g.status = res.status; if (g.mode === 'after') { g.processed = true; await g.gate; } }
    await send(res);
    if (g) g.send();
  } catch (e) { nres.writeHead(500); nres.end(String(e)); }
});

async function device(name) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.setDefaultTimeout(10000);
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'usb', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  await cdp.send('WebAuthn.addCredential', { authenticatorId, credential: { credentialId: credId.toString('base64'), isResidentCredential: false, rpId: 'localhost', privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'), signCount: 0 } });
  const txt = (sel) => page.$eval(sel, (e) => e.textContent);
  const until = async (fn, what, ms = 10000) => { const t = Date.now(); for (;;) { const v = await Promise.resolve().then(fn).catch(() => false); if (v) return v; if (Date.now() - t > ms) throw new Error(`${name} timeout: ${what}`); await sleep(25); } };
  const cookie = async () => (await ctx.cookies(O)).find((c) => c.name === '__Host-lab_teacher');
  const status = () => page.evaluate(async () => (await fetch('/api/lab/teacher/status', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status);
  const open = async () => { await page.goto(O + '/lab'); await until(async () => /보안 키로|까지 이 기기에서/.test((await txt('#loginNote')) + (await txt('#monLine'))), 'boot'); };
  const restored = async () => !(await page.$eval('#panel', (e) => e.hidden)) && (await txt('#monLine')).includes('까지 이 기기에서');
  const login = async () => { const n = reqs.length; await page.click('#go'); await until(async () => reqs.slice(n).some((r) => r.p === '/api/lab/list') && await restored() && !(await page.$eval('#go', (e) => e.disabled)), 'login'); };
  return { ctx, page, errors, txt, until, cookie, status, open, restored, login };
}

const assert = (await import('node:assert/strict')).default;
const rawCookie = async ctx => (await ctx.cookies(O)).find(c=>c.name==='__Host-lab_admin');
const adminKey = token=>'admin:'+b64sha(token);
const direct = async(path,{origin=O,cookie='',token='',body='{}',site}={})=>{
 const req=new Request(O+path,{method:'POST',headers:{'content-type':'application/json',...(origin?{origin}:{}),...(cookie?{cookie}:{}),...(token?{'x-admin-token':token}:{}),...(site?{'sec-fetch-site':site}:{})},body});
 return worker.fetch(req,env,{waitUntil(){}});
};
try{
 const A=await device('refresh');await A.open();await A.login();
 const cookie=await rawCookie(A.ctx);assert.ok(cookie&&cookie.httpOnly&&cookie.secure&&cookie.sameSite==='Strict'&&cookie.path==='/');
 assert.equal(await A.page.evaluate(()=>document.cookie.includes('__Host-lab_admin')),false);
 const token=cookie.value,deadline=m.get(adminKey(token)).expiresAt,cookieDeadline=cookie.expires,taps=reqs.filter(r=>r.p==='/api/admin/options').length;
 assert.equal(taps,1);assert.ok(deadline>Date.now()+7*3600000);
 for(let i=0;i<3;i++){
  await A.page.reload();await A.until(()=>A.page.evaluate(()=>adm()),'admin restored');
  assert.equal(m.get(adminKey(token)).expiresAt,deadline);
  assert.equal((await rawCookie(A.ctx)).expires,cookieDeadline);
 }
 assert.equal(reqs.filter(r=>r.p==='/api/admin/options').length,taps);
 assert.equal(reqs.filter(r=>r.p==='/api/lab/admin/session/remember').length,1,'no remint on reload');
 check('three reloads restore the same admin without another tap or deadline extension',true);
 const saved=await A.page.evaluate(()=>JSON.stringify(localStorage)+JSON.stringify(sessionStorage)+location.href);
 assert.ok(!saved.includes(token));check('token stays out of JS storage, URL and document.cookie',true);
 const second=await A.ctx.newPage();await second.goto(O+'/lab');await A.until(()=>second.evaluate(()=>adm()),'same browser tab restore');
 assert.equal(reqs.filter(r=>r.p==='/api/admin/options').length,taps);await second.close();
 check('same browser new tab restores; separate browser has no grant',true);
 const other=await device('other');await other.open();assert.equal(await other.page.evaluate(()=>adm()),false);assert.equal(await rawCookie(other.ctx),undefined);await other.ctx.close();
 const ck='__Host-lab_admin='+token;
 assert.equal((await direct('/api/lab/admin/session',{cookie:ck,origin:''})).status,403);
 assert.equal((await direct('/api/lab/admin/session',{cookie:ck,origin:'https://evil.invalid'})).status,403);
 assert.equal((await direct('/api/lab/admin/session',{cookie:ck,site:'same-site'})).status,403);
 assert.equal((await direct('/api/lab/admin/session',{cookie:ck+'; '+ck})).status,401);
 assert.equal((await direct('/api/lab/admin/session',{cookie:ck,body:'{"token":"ignored"}'})).status,400);
 assert.equal((await direct('/api/lab/admin/session',{cookie:ck,body:' '.repeat(65)})).status,413);
 assert.equal((await direct('/api/lab/end',{cookie:ck,body:'{"id":"never-created"}'})).status,401);
 assert.equal((await direct('/api/lab/admin/session/remember',{cookie:ck})).status,401);
 check('Origin, fetch-site, duplicate cookie, body bounds; cookie is not general admin authority',true);
 const cli=await st.newAdminToken('cli');
 assert.equal((await direct('/api/lab/admin/session',{cookie:'__Host-lab_admin='+cli.token})).status,401);
 assert.equal((await direct('/api/lab/admin/session/remember',{token:cli.token})).status,401);
 const row=m.get(adminKey(token));row.createdAt=Date.now()-4*60000;row.expiresAt-=4*60000;m.set(adminKey(token),row);
 assert.equal((await direct('/api/lab/admin/session/remember',{token})).status,401);
 const resumed=await direct('/api/lab/admin/session',{cookie:ck});assert.equal(resumed.status,200);assert.equal(resumed.headers.get('set-cookie'),null);
 check('CLI cannot persist; old web grant restores but cannot mint a cookie',true);
 row.expiresAt=Date.now()-1;m.set(adminKey(token),row);
 await A.page.reload();await A.until(()=>A.page.evaluate(()=>!!MON),'monitor after expiry');assert.equal(await A.page.evaluate(()=>adm()),false);
 await A.until(async()=>!(await rawCookie(A.ctx)),'expired cookie cleared');
 check('server expiry rejects and clears the restore cookie without automatic WebAuthn',true);
 // Reauthenticate, then hold a completed restore reply while this tab logs out using only cookies.
 await A.page.click('#reauth');await A.until(async()=>await A.page.evaluate(()=>adm())&&!!await rawCookie(A.ctx),'reauth');
 const current=await rawCookie(A.ctx);await A.until(()=>reqs.filter(r=>r.p==='/api/lab/teacher/session').length>=2,'views ready');
 const h={mode:'after'};h.gate=new Promise(r=>h.release=r);h.arrived=new Promise(r=>h.arrive=r);h.sent=new Promise(r=>h.send=r);restoreHold=h;
 const waiting=await A.ctx.newPage();await waiting.goto(O+'/lab');await h.arrived;
 await A.until(()=>waiting.locator('#navSet').isVisible(),'monitor restored');await waiting.click('#navSet');
 await A.until(()=>waiting.locator('#logout').isVisible(),'cookie-only logout visible');
 await waiting.click('#logout');await A.until(async()=>!(await rawCookie(A.ctx)),'cookie logout cleared');
 assert.equal(m.has(adminKey(current.value)),false,'cookie-only logout revoked admin token');
 h.release();await h.sent;await sleep(120);
 assert.equal(await waiting.evaluate(()=>adm()),false,'late restore did not resurrect admin');
 await waiting.reload();await A.until(()=>waiting.locator('#go').isVisible(),'login again');
 assert.equal(await waiting.evaluate(()=>adm()),false);
 check('cookie-only logout revokes the grant; delayed restore and later refresh cannot resurrect it',true);
 await waiting.close();await A.open();await A.login();
 const beforeLate=await rawCookie(A.ctx),beforeLateRow=m.get(adminKey(beforeLate.value));beforeLateRow.expiresAt=Date.now()-1;m.set(adminKey(beforeLate.value),beforeLateRow);
 await A.page.evaluate(()=>{TE=0;admExpired()});
 const late={mode:'after'};late.gate=new Promise(r=>late.release=r);late.arrived=new Promise(r=>late.arrive=r);late.sent=new Promise(r=>late.send=r);persistHold=late;
 await A.page.click('#reauth');await late.arrived;
 const lateToken=await A.page.evaluate(()=>T);
 await A.page.click('#navSet');
 await A.page.click('#logout');await A.until(()=>A.page.locator('#go').isEnabled(),'logout during remember');
 assert.equal(m.has(adminKey(lateToken)),false);
 late.release();await late.sent;await sleep(120);
 await A.open();await A.until(async()=>!(await rawCookie(A.ctx)),'late cookie rejected after reload');
 assert.equal(await A.page.evaluate(()=>adm()),false);
 check('a delayed remember Set-Cookie after logout cannot revive the revoked grant',true);
 assert.deepEqual(A.errors,[]);assert.deepEqual(outbound,[]);
 check('no page errors or outbound provider calls',true);
 await A.ctx.close();
}finally{await browser.close();await new Promise(r=>srv.close(r))}
done();
