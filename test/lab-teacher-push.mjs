// 강사 손 알림(Web Push) 통합 테스트. 실제 src/index.ts 를 esbuild 로 번들해 Worker.fetch + 진짜 State(가짜 메모리 저장소·시계·fetch)로 돌린다.
//   - /api/lab/teacher/push/*: Origin·쿠키(하나·형식)·401 은 암호·저장·발송 전에, 관리 토큰으로는 안 됨, 바이트 상한(조각), SSRF/틀린 endpoint, 다른 필드 거부
//   - 저장: MASTER_KEY 봉인만 (AAD teacher-push:<해시>), 응답·저장에 endpoint·auth·p256dh·VAPID d 없음
//   - 주인·다시 묶기·재시작·로그아웃·8시간·밀려남·세션 4개·전체 64개
//   - 손: 새로 든 손만·이미 든 손 그대로·트랜잭션 재실행에도 일 하나·60초 throttle·outbox 32·재시도 3번·gone·리다이렉트 안 따름
//         넣은 뒤~풀기~네트워크 사이의 내림·강사 내림·끝내기·만료·로그아웃 → 새 요청 없음, 임차로 재시작 중복 없음, 더 이른 알람 유지
// 일회용 키는 이 프로세스 안에서만 만든다. 바깥 네트워크·비밀·브라우저 없음.  node test/lab-teacher-push.mjs
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import * as nodeCrypto from 'node:crypto';
import { build } from 'esbuild';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const cfStub = { name: 'cf-stub', setup(b) {
  b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'cf', namespace: 'cf-stub' }));
  b.onLoad({ filter: /.*/, namespace: 'cf-stub' }, () => ({ contents: 'export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }', loader: 'js' }));
} };
const bundled = await build({ entryPoints: [join(ROOT, 'src/index.ts')], bundle: true, write: false, format: 'esm', platform: 'node', loader: { '.ps1': 'text' }, plugins: [cfStub], logLevel: 'silent' });
const dir = mkdtempSync(join(tmpdir(), 'lab-teacher-push-'));
writeFileSync(join(dir, 'worker.mjs'), bundled.outputFiles[0].text);
let mod;
try { mod = await import(pathToFileURL(join(dir, 'worker.mjs')).href); } finally { rmSync(dir, { recursive: true, force: true }); }
const worker = mod.default;

// ── 가짜 네트워크: 푸시 서비스 응답만 흉내 ──
const net = { calls: [], respond: () => 201 };
globalThis.fetch = async (u, init) => {
  const url = String(u?.url ?? u);
  net.calls.push({ url, init });
  const s = net.respond(url);
  if (s === 'throw') throw new Error('network down');
  return new Response(null, { status: s, headers: s >= 300 && s < 400 ? { location: 'https://evil.example/x' } : {} });
};
const logged = [];
for (const k of ['info', 'warn', 'error', 'debug']) { const o = console[k].bind(console); console[k] = (...a) => { logged.push(a.join(' ')); o(...a); }; }

const T0 = Date.now();
let off = 0;
const realNow = Date.now;
Date.now = () => T0 + off;

let pass = 0, failN = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { failN++; console.log(`  FAIL ${name} ${String(typeof extra === 'string' ? extra : JSON.stringify(extra)).slice(0, 400)}`); }
};
const tick = () => new Promise((r) => setTimeout(r, 0));
const b64u = (b) => Buffer.from(b).toString('base64url');
const b64sha = (s) => nodeCrypto.createHash('sha256').update(s).digest('base64url');

// 일회용 키
const vapidJwk = nodeCrypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' });
const VAPID = JSON.stringify(vapidJwk);
const VAPID_PUB = b64u(Buffer.concat([Buffer.from([4]), Buffer.from(vapidJwk.x, 'base64url'), Buffer.from(vapidJwk.y, 'base64url')]));
const MASTER = b64u(nodeCrypto.randomBytes(32));

function newSub(tag = nodeCrypto.randomBytes(6).toString('hex')) {
  const ecdh = nodeCrypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = nodeCrypto.randomBytes(16);
  return { json: { endpoint: `https://fcm.googleapis.com/fcm/send/dev-${tag}`, expirationTime: null, keys: { p256dh: b64u(ecdh.getPublicKey()), auth: b64u(auth) } }, ecdh, auth };
}
function receiverDecrypt(body, sub) {
  const salt = body.subarray(0, 16), idlen = body[20], asPublic = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen);
  const secret = sub.ecdh.computeSecret(asPublic);
  const ikm = Buffer.from(nodeCrypto.hkdfSync('sha256', secret, sub.auth, Buffer.concat([Buffer.from('WebPush: info\0'), sub.ecdh.getPublicKey(), asPublic]), 32));
  const cek = Buffer.from(nodeCrypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(nodeCrypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const d = nodeCrypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const rec = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  return JSON.parse(rec.subarray(0, rec.length - 1).toString());
}

function memStorage() {
  const m = new Map();
  let alarm = null;
  const c = (v) => (v === undefined ? v : structuredClone(v));
  const s = {
    m, retryNext: 0,
    get alarmAt() { return alarm; },
    async get(k) { await tick(); if (Array.isArray(k)) { const r = new Map(); for (const x of k) if (m.has(x)) r.set(x, c(m.get(x))); return r; } return c(m.get(k)); },
    async put(k, v) { await tick(); if (typeof k === 'object') { for (const [a, b] of Object.entries(k)) m.set(a, c(b)); } else m.set(k, c(v)); },
    async delete(k) { await tick(); const ks = Array.isArray(k) ? k : [k]; let n = 0; for (const x of ks) if (m.delete(x)) n++; return Array.isArray(k) ? n : n > 0; },
    async list({ prefix = '' } = {}) { await tick(); return new Map([...m.keys()].filter((x) => x.startsWith(prefix)).sort().map((x) => [x, c(m.get(x))])); },
    async getAlarm() { return alarm; },
    async setAlarm(t) { alarm = t; },
    // retryNext: 다음 트랜잭션을 한 번 돌린 뒤 되돌리고 다시 돌린다 (충돌 재시도 흉내)
    async transaction(f) {
      const prev = s.q; let done; s.q = new Promise((r) => { done = r; }); await prev;
      try {
        if (s.retryNext > 0) {
          s.retryNext--; s.txRuns = (s.txRuns ?? 0) + 1;
          const snap = new Map([...m].map(([k, v]) => [k, c(v)])), a = alarm;
          await f(s);
          m.clear(); for (const [k, v] of snap) m.set(k, v); alarm = a;
        }
        s.txRuns = (s.txRuns ?? 0) + 1;
        return await f(s);
      } finally { done(); }
    },
    q: Promise.resolve(),
  };
  return s;
}

const ORIGIN = 'https://k.example.test', LAB_ORIGIN = 'https://lab.example.test';
const hooks = { open: null };
class T extends mod.State {
  async daytona() { return { status: 409, error: 'no daytona in test' }; }
  async unseal(...a) { const h = hooks.open; hooks.open = null; if (h) await h(); return super.unseal(...a); }
}
const envOf = (o = {}) => ({ ORIGIN, LAB_ORIGIN, LAB_SEAT_DOMAIN: 'example.test', RP_ID: 'example.test', MASTER_KEY: MASTER, TEACHER_PUSH_VAPID_JWK: VAPID, ...o });
const pending = [];
function makeState(storage = memStorage(), envX = {}) {
  const ctx = { storage, waitUntil(p) { pending.push(p); }, blockConcurrencyWhile: async (f) => f() };
  return { st: new T(ctx, envOf(envX)), storage };
}
const settle = async () => { while (pending.length) await Promise.all(pending.splice(0)); };
const wctx = { waitUntil() {}, passThroughOnException() {} };

async function http(st, path, { cookie, admin, origin = ORIGIN, body, headers = {} } = {}) {
  const h = { ...headers };
  if (origin) h.origin = origin;
  if (cookie !== undefined) h.cookie = cookie;
  if (admin !== undefined) h['x-admin-token'] = admin;
  const req = new Request(ORIGIN + path, { method: 'POST', headers: h, ...(body !== undefined ? { body, ...(body instanceof ReadableStream ? { duplex: 'half' } : {}) } : {}) });
  const res = await worker.fetch(req, { ...envOf(), STATE: { idFromName: (n) => ({ name: n }), get: () => st } }, wctx);
  const raw = await res.text();
  let j; try { j = JSON.parse(raw); } catch {}
  return { res, status: res.status, raw, j, cookie: res.headers.get('set-cookie') };
}
const CLEAR = '__Host-lab_teacher=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0';
const H8 = 8 * 3600e3;
async function session(st) {
  const web = (await st.newAdminToken('web')).token;
  const r = await http(st, '/api/lab/teacher/session', { admin: web });
  const tok = /^__Host-lab_teacher=([\w-]{32});/.exec(r.cookie ?? '')?.[1];
  return { tok, ck: `__Host-lab_teacher=${tok}`, owner: b64sha(tok), web };
}
const P = (x) => `/api/lab/teacher/push/${x}`;
const subscribe = (st, ck, sub, extra = {}) => http(st, P('subscribe'), { cookie: ck?.ck ?? ck, body: JSON.stringify({ subscription: sub.json ?? sub, ...extra }) });
const subKeyOf = (sub) => `tpsub:${b64sha(sub.json.endpoint)}`;
const subs = (storage) => [...storage.m.keys()].filter((k) => k.startsWith('tpsub:'));

// crypto 호출 세기 (권한 없는 요청은 암호를 쓰지 않는다)
const cc = { importKey: 0, encrypt: 0, decrypt: 0, sign: 0 };
for (const k of Object.keys(cc)) { const o = crypto.subtle[k].bind(crypto.subtle); crypto.subtle[k] = (...a) => { cc[k]++; return o(...a); }; }
const ccSum = () => cc.importKey + cc.encrypt + cc.decrypt + cc.sign;

function labOf(id, nSeats, extra = {}) {
  return { id, name: id, createdAt: T0, expiresAt: T0 + 3 * 3600e3, budget: 1, cpu: 1, memory: 2, disk: 5, snapshot: 's', model: 'm', gw: 'g',
    seats: Array.from({ length: nSeats }, (_, i) => ({ n: i + 1, code: `${id}${String(i + 1).padStart(16 - id.length, '0')}`, sandboxId: `sb-${id}-${i + 1}`, sid: `S-${id}-${i + 1}`, label: `l${i}` })), ...extra };
}
async function putLab(storage, lab) {
  await storage.put(`lab:${lab.id}`, lab);
  for (const s of lab.seats) await storage.put(`seat:${s.code}`, { lab: lab.id, n: s.n });
  return lab;
}
const outbox = (storage) => storage.m.get('tpush:outbox') ?? { jobs: [], thr: {} };
const handOf = (storage, labId, n) => storage.m.get(`lab:${labId}`).seats.find((x) => x.n === n).hand;

// ── 1. 권한 경계: 암호·저장·발송 전에 ──
console.log('권한 경계 (Origin·쿠키·관리 토큰)');
{
  off = 0;
  const { st, storage } = makeState();
  const { ck, tok, web } = await session(st);
  const sub = newSub();
  const before = JSON.stringify([...storage.m].filter(([k]) => !k.startsWith('audit')));
  const c0 = ccSum(); net.calls.length = 0;
  const bodies = { config: '', subscribe: JSON.stringify({ subscription: sub.json }), status: JSON.stringify({ endpoint: sub.json.endpoint }), unsubscribe: JSON.stringify({ endpoint: sub.json.endpoint }) };
  let all = true;
  for (const [p, body] of Object.entries(bodies)) {
    const cases = [
      ['쿠키 없음', { body }, 401, null],
      ['관리 토큰만', { admin: web, body }, 401, null],
      ['보기 토큰을 x-admin-token 에', { admin: tok, body }, 401, null],
      ['Origin 없음', { cookie: ck, origin: null, body }, 403, null],
      ['다른 Origin', { cookie: ck, origin: LAB_ORIGIN, body }, 403, null],
      ['Origin "null"', { cookie: ck, origin: 'null', body }, 403, null],
      ['쿠키 둘', { cookie: `${ck}; ${ck}`, body }, 400, CLEAR],
      ['틀린 쿠키', { cookie: `__Host-lab_teacher=${tok}x`, body }, 400, CLEAR],
      ['위조 토큰', { cookie: `__Host-lab_teacher=${'A'.repeat(32)}`, body }, 401, CLEAR],
    ];
    for (const [name, o, status, cookie] of cases) {
      const r = await http(st, P(p), o);
      if (r.status !== status || r.cookie !== cookie) { all = false; console.log('    ', p, name, r.status, r.cookie, r.raw); }
    }
  }
  check('4개 경로 × (쿠키 없음·관리 토큰·Origin·중복/틀린/위조 쿠키) → 401/403/400', all);
  check('거부된 요청: 저장소 그대로', JSON.stringify([...storage.m].filter(([k]) => !k.startsWith('audit'))) === before);
  check('거부된 요청: 암호(importKey·encrypt·decrypt·sign) 0, fetch 0', ccSum() === c0 && net.calls.length === 0, `${ccSum() - c0} ${net.calls.length}`);
  // 로그아웃한 세션 → 401 (구독도 못 함)
  await http(st, '/api/lab/teacher/logout', { cookie: ck });
  const c1 = ccSum();
  const r = await subscribe(st, ck, sub);
  check('로그아웃 뒤 subscribe → 401 + 쿠키 지움, 암호 0, 저장 없음', r.status === 401 && r.cookie === CLEAR && ccSum() === c1 && subs(storage).length === 0, r.raw);
}

// ── 2. config ──
console.log('config');
{
  off = 0;
  const { st } = makeState();
  const { ck } = await session(st);
  const r = await http(st, P('config'), { cookie: ck });
  check('config → {available:true, expiresAt, applicationServerKey} 만, no-store', r.status === 200 && r.j.available === true && r.j.expiresAt === T0 + H8 && r.j.applicationServerKey === VAPID_PUB
    && Object.keys(r.j).sort().join() === 'applicationServerKey,available,expiresAt' && r.res.headers.get('cache-control') === 'no-store', r.raw);
  check('config 응답에 개인키 d 없음', !r.raw.includes(vapidJwk.d));
  check('config 본문 {} 허용 / 다른 본문 400', (await http(st, P('config'), { cookie: ck, body: '{}' })).status === 200 && (await http(st, P('config'), { cookie: ck, body: '{"subscription":1}' })).status === 400);
  for (const [name, env] of [['키 없음', { TEACHER_PUSH_VAPID_JWK: undefined }], ['틀린 JWK', { TEACHER_PUSH_VAPID_JWK: JSON.stringify({ ...vapidJwk, d: b64u(Buffer.alloc(32)) }) }], ['MASTER_KEY 틀림', { MASTER_KEY: 'short' }]]) {
    const s2 = makeState(undefined, env);
    const c = (await session(s2.st)).ck;
    const x = await http(s2.st, P('config'), { cookie: c });
    check(`${name} → {available:false, expiresAt} 만`, x.status === 200 && x.j.available === false && Object.keys(x.j).sort().join() === 'available,expiresAt', x.raw);
    const y = await subscribe(s2.st, c, newSub());
    check(`${name} → subscribe 409 고정 문구, 저장 없음`, y.status === 409 && y.j.error === '지금은 알림을 켤 수 없습니다.' && subs(s2.storage).length === 0, y.raw);
  }
}

// ── 3. subscribe 입력·저장 ──
console.log('subscribe 입력·저장');
{
  off = 0;
  const { st, storage } = makeState();
  const { ck, owner } = await session(st);
  const sub = newSub();
  const bad = [
    ['다른 필드 message', { subscription: sub.json, message: 'hi' }], ['다른 필드 url', { subscription: sub.json, url: '/x' }], ['recipient', { subscription: sub.json, recipient: 'all' }],
    ['subscription 없음', { endpoint: sub.json.endpoint }], ['http', { subscription: { ...sub.json, endpoint: 'http://fcm.googleapis.com/fcm/send/x' } }],
    ['다른 호스트', { subscription: { ...sub.json, endpoint: 'https://evil.example/fcm/send/x' } }], ['접미사 호스트', { subscription: { ...sub.json, endpoint: 'https://fcm.googleapis.com.evil.example/x' } }],
    ['localhost', { subscription: { ...sub.json, endpoint: 'https://127.0.0.1/x' } }], ['메타데이터', { subscription: { ...sub.json, endpoint: 'https://169.254.169.254/x' } }],
    ['포트', { subscription: { ...sub.json, endpoint: 'https://fcm.googleapis.com:8443/x' } }],
    ['곡선 밖 p256dh', { subscription: { ...sub.json, keys: { ...sub.json.keys, p256dh: b64u(Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)])) } } }],
    ['auth 15바이트', { subscription: { ...sub.json, keys: { ...sub.json.keys, auth: b64u(Buffer.alloc(15, 1)) } } }],
  ];
  let ok = true;
  for (const [name, b] of bad) { const r = await http(st, P('subscribe'), { cookie: ck, body: JSON.stringify(b) }); if (r.status !== 400) { ok = false; console.log('    ', name, r.status, r.raw); } }
  for (const raw of ['', 'not json', '[]', 'null', '{"subscription":"x"}']) { const r = await http(st, P('subscribe'), { cookie: ck, body: raw }); if (r.status !== 400) { ok = false; console.log('    raw', raw, r.status); } }
  check('다른 필드·SSRF·틀린 endpoint·키·JSON → 400', ok);
  check('거부: 저장·fetch 없음', subs(storage).length === 0 && net.calls.length === 0);
  // 바이트 상한
  check('content-length 4097 → 413', (await http(st, P('subscribe'), { cookie: ck, body: ' '.repeat(4097) })).status === 413);
  const pulls = { n: 0 };
  const stream = (chunks) => new ReadableStream({ pull(c) { pulls.n++; const x = chunks.shift(); if (x) c.enqueue(x); else c.close(); } }, { highWaterMark: 0 });
  const big = await http(st, P('subscribe'), { cookie: ck, body: stream([new Uint8Array(5000).fill(32), new Uint8Array(10).fill(32)]) });
  check('큰 조각 하나 → 413, 다음 조각 안 읽음', big.status === 413 && pulls.n === 1, `${big.status} ${pulls.n}`);
  const exact = JSON.stringify({ subscription: sub.json });
  const pad = Buffer.from(exact + ' '.repeat(4096 - Buffer.byteLength(exact)));
  pulls.n = 0;
  const r4096 = await http(st, P('subscribe'), { cookie: ck, body: stream([pad.subarray(0, 100), pad.subarray(100, 101), pad.subarray(101)]) });
  check('정확히 4096바이트(조각) → 200 {ok, expiresAt}', pad.length === 4096 && r4096.status === 200 && r4096.j.ok === true && r4096.j.expiresAt === T0 + H8 && Object.keys(r4096.j).sort().join() === 'expiresAt,ok', r4096.raw);
  const wide = Buffer.from(exact + '　'.repeat(Math.ceil((4097 - Buffer.byteLength(exact)) / 3)));
  check('여러 바이트 글자로 4096 넘음 → 413', (await http(st, P('subscribe'), { cookie: ck, body: stream([wide.subarray(0, 3000), wide.subarray(3000)]) })).status === 413);
  // 저장: 봉인만
  const key = subKeyOf(sub);
  const rec = storage.m.get(key);
  const dump = JSON.stringify([...storage.m]);
  check('tpsub:<endpoint 해시> 하나, 주인=세션 해시, 고정 만료', subs(storage).length === 1 && rec.owner === owner && rec.expiresAt === T0 + H8 && Object.keys(rec).sort().join() === 'at,ct,expiresAt,iv,owner', JSON.stringify(rec));
  check('저장소에 endpoint·auth·p256dh 원문 없음', !dump.includes(sub.json.endpoint) && !dump.includes('dev-') && !dump.includes(sub.json.keys.auth) && !dump.includes(sub.json.keys.p256dh));
  const h = key.slice(6);
  const opened = await st.unseal(`teacher-push:${h}`, rec.iv, rec.ct);
  check('AAD teacher-push:<해시> 로만 풀림', JSON.parse(opened ?? '{}').endpoint === sub.json.endpoint
    && (await st.unseal(`prov:${h}`, rec.iv, rec.ct)) === null && (await st.unseal(`teacher-push:${b64sha('other')}`, rec.iv, rec.ct)) === null);
  check('응답에 endpoint·키 없음', ![r4096.raw].some((x) => x.includes('fcm') || x.includes(sub.json.keys.auth)));
}

// ── 4. 주인·다시 묶기·상한·로그아웃·8시간·밀려남 ──
console.log('주인·상한·수명');
{
  off = 0;
  const storage = memStorage();
  const { st } = makeState(storage);
  const A = await session(st), B = await session(st);
  const sa = newSub('a');
  await subscribe(st, A.ck, sa);
  const status = (s, who, sub) => http(s, P('status'), { cookie: who.ck, body: JSON.stringify({ endpoint: sub.json.endpoint }) });
  const unsub = (s, who, sub) => http(s, P('unsubscribe'), { cookie: who.ck, body: JSON.stringify({ endpoint: sub.json.endpoint }) });
  const sA = await status(st, A, sa), sB = await status(st, B, sa);
  check('status: 주인 enabled:true, 다른 세션 false (같은 expiresAt 모양)', sA.j.enabled === true && sB.j.enabled === false && Object.keys(sA.j).sort().join() === 'enabled,expiresAt' && Object.keys(sB.j).sort().join() === 'enabled,expiresAt', sA.raw + sB.raw);
  check('status 다른 필드 → 400, 허용 밖 endpoint → enabled:false', (await http(st, P('status'), { cookie: A.ck, body: JSON.stringify({ endpoint: sa.json.endpoint, x: 1 }) })).status === 400
    && (await http(st, P('status'), { cookie: A.ck, body: JSON.stringify({ endpoint: 'https://evil.example/x' }) })).j.enabled === false);
  const u = await unsub(st, B, sa);
  check('다른 세션 unsubscribe → {ok:true} 지만 그대로', u.j?.ok === true && storage.m.get(subKeyOf(sa))?.owner === A.owner);
  // 재시작
  const st2 = makeState(storage).st;
  check('DO 재시작 뒤에도 enabled', (await status(st2, A, sa)).j.enabled === true);
  // 같은 기기를 새 세션(B)으로 다시 묶기
  const re = await subscribe(st2, B, sa);
  check('같은 endpoint 를 B 가 다시 구독 → B 로 묶임 (하나), A 는 false', re.status === 200 && subs(storage).length === 1 && storage.m.get(subKeyOf(sa)).owner === B.owner && (await status(st2, A, sa)).j.enabled === false && (await status(st2, B, sa)).j.enabled === true);
  const recB = JSON.stringify(storage.m.get(subKeyOf(sa)));
  off = 7;
  const again = await subscribe(st2, B, sa);
  check('같은 세션·같은 구독 다시 → 기록 바이트 그대로 (다시 봉인·다시 묶기 없음), 고정 만료', again.status === 200 && again.j.expiresAt === T0 + H8 && subs(storage).length === 1 && JSON.stringify(storage.m.get(subKeyOf(sa))) === recB);
  const rotated = { json: { ...sa.json, keys: { ...newSub().json.keys } } };
  await subscribe(st2, B, rotated);
  check('같은 endpoint 키가 바뀌면 → 새로 봉인 (주인·만료 그대로)', JSON.stringify(storage.m.get(subKeyOf(sa))) !== recB && storage.m.get(subKeyOf(sa)).owner === B.owner && storage.m.get(subKeyOf(sa)).expiresAt === T0 + H8);
  await subscribe(st2, B, sa);
  off = 0;
  check('주인 unsubscribe → 지워짐', (await unsub(st2, B, sa)).j?.ok === true && subs(storage).length === 0);
  // 세션당 4개: 다섯 번째는 이 세션의 가장 오래된 것을 민다 (다른 세션 것은 그대로)
  const bs = await subscribe(st2, B, newSub('b0'));
  const a5 = [];
  for (let i = 0; i < 5; i++) { off = 10 + i; const s = newSub(`a${i}`); a5.push(s); await subscribe(st2, A, s); }
  const mineA = subs(storage).filter((k) => storage.m.get(k).owner === A.owner);
  check('세션당 4개: A 5번째 → 가장 오래된 A 하나만 빠짐, B 그대로', bs.status === 200 && mineA.length === 4 && !storage.m.has(subKeyOf(a5[0])) && a5.slice(1).every((s) => storage.m.has(subKeyOf(s))) && subs(storage).length === 5);
  // 로그아웃: A 구독만
  await http(st2, '/api/lab/teacher/logout', { cookie: A.ck });
  check('A 로그아웃 → A 구독 전부 지워짐, B 그대로', subs(storage).length === 1 && storage.m.get(subs(storage)[0]).owner === B.owner);
  // 전체 64: 살아 있는 다른 주인 64개를 직접 넣고 새 구독 → 429, 쓰기 없음 (C 는 먼저 만든다 — 만들기의 기기 16개 상한이 가짜 주인을 밀지 않게)
  const C = await session(st2);
  for (let i = 0; i < 64; i++) {
    await storage.put(`teacher:own${i}`, { createdAt: T0, expiresAt: T0 + H8 });
    await storage.put(`tpsub:fake${String(i).padStart(3, '0')}`, { owner: `own${i}`, expiresAt: T0 + H8, at: T0, iv: 'x', ct: 'y' });
  }
  await storage.delete(subs(storage).filter((k) => !k.startsWith('tpsub:fake')));
  const snap = JSON.stringify(subs(storage));
  const full = await subscribe(st2, C, newSub('c'));
  check('전체 64개 → 429, 쓰기·삭제 없음', full.status === 429 && JSON.stringify(subs(storage)) === snap, full.raw);
  // 주인이 죽은 것은 자리로 안 센다 → 정리하고 받음
  await storage.delete('teacher:own0');
  const ok65 = await subscribe(st2, C, newSub('c'));
  check('주인 없는 구독은 정리되고 새 구독 받음', ok65.status === 200 && !storage.m.has('tpsub:fake000') && subs(storage).length === 64, ok65.raw);
  // 8시간: 알람이 지운다
  off = H8 + 100;
  await st2.alarm(); await settle();
  check('8시간 뒤 알람: 만료된 세션의 구독 전부 지움 (fake 주인도 만료)', subs(storage).length === 0, subs(storage).join());
  check('8시간 뒤 config 401', (await http(st2, P('config'), { cookie: C.ck })).status === 401);
  off = 0;
}
{
  // 기기 16개 상한으로 밀려난 세션의 구독도 지운다
  off = 0;
  const { st, storage } = makeState();
  const first = await session(st);
  await subscribe(st, first.ck, newSub('evict'));
  for (let i = 1; i <= 16; i++) { off = i; await session(st); }
  check('17번째 세션으로 가장 오래된 세션이 밀리면 그 구독도 지움', !storage.m.has(`teacher:${first.owner}`) && subs(storage).length === 0);
  off = 0;
}

// ── 5. 손 → outbox → 발송 ──
console.log('손 알림');
async function rig(o = {}) {
  off = 0; net.calls.length = 0; net.respond = () => 201; pending.length = 0;
  const { st, storage } = makeState(undefined, o.env ?? {});
  const lab = await putLab(storage, labOf('labA', o.seats ?? 3));
  const A = await session(st);
  const sub = newSub();
  if (!o.noSub) await subscribe(st, A.ck, sub);
  return { st, storage, lab, A, sub, code: (n) => lab.seats[n - 1].code };
}
{
  const { st, storage, sub, code, A } = await rig();
  await storage.setAlarm(T0 + 1000); // 다른 일의 더 이른 알람
  const r = await st.labHand(code(1), true);
  const h1 = handOf(storage, 'labA', 1);
  check('손 들기 → {hand:true}, 시각 저장, outbox 일 하나 (같은 트랜잭션)', r.hand === true && h1 === T0 && outbox(storage).jobs.length === 1 && outbox(storage).jobs[0].hand === h1);
  check('더 이른 알람을 덮지 않음', storage.alarmAt === T0 + 1000, storage.alarmAt - T0);
  await settle();
  const c = net.calls[0];
  check('보내기 1번: 그 endpoint, POST·redirect manual·aes128gcm·vapid', net.calls.length === 1 && c.url === sub.json.endpoint && c.init.method === 'POST' && c.init.redirect === 'manual' && c.init.headers['Content-Encoding'] === 'aes128gcm' && c.init.headers.Authorization.includes(`k=${VAPID_PUB}`));
  const pl = receiverDecrypt(Buffer.from(c.init.body), sub);
  check('수신자 복호화 = 고정 문구 (이름·자리·수업 없음)', JSON.stringify(pl) === JSON.stringify({ title: '공부방 실습실', body: '학생이 손을 들었습니다. 강사 화면에서 확인하세요.', url: '/lab', tag: 'lab-hand' }), JSON.stringify(pl));
  check('성공 → outbox 비움', outbox(storage).jobs.length === 0);
  off = 5000;
  await st.labHand(code(1), true); await settle();
  check('이미 든 손 다시 → 시각 그대로, 새 일·발송 없음', handOf(storage, 'labA', 1) === T0 && net.calls.length === 1 && outbox(storage).jobs.length === 0);
  // 내렸다 다시 (60초 안) → 손은 바뀌지만 알림 없음
  off = 10e3; await st.labHand(code(1), false);
  check('내림 → 손 없음', handOf(storage, 'labA', 1) === undefined);
  off = 20e3; await st.labHand(code(1), true); await settle();
  check('60초 안 다시 들기 → 손 시각 새로, 알림 없음 (throttle)', handOf(storage, 'labA', 1) === T0 + 20e3 && net.calls.length === 1 && outbox(storage).jobs.length === 0);
  off = 20e3 + 1; await st.labHand(code(2), true); await settle();
  check('다른 자리는 따로 → 알림 1번 더', net.calls.length === 2);
  off = 70e3; await st.labHand(code(1), false); await st.labHand(code(1), true); await settle();
  check('60초 뒤 → 다시 알림', net.calls.length === 3);
  const all = JSON.stringify([...storage.m]);
  check('저장소·로그에 endpoint·키·VAPID d 없음', !all.includes(sub.json.endpoint) && !all.includes(sub.json.keys.auth) && !all.includes(vapidJwk.d) && logged.length === 0, logged.join('|'));
  void A;
}
{
  // 트랜잭션 재실행 (충돌 흉내): 손·일 하나, 시각 일치
  const { st, storage, code } = await rig();
  storage.retryNext = 1; storage.txRuns = 0;
  await st.labHand(code(1), true); await settle();
  const ob = outbox(storage);
  check('트랜잭션이 두 번 돌아도 일 하나·발송 하나', net.calls.length === 1 && ob.jobs.length === 0 && Object.keys(ob.thr).length === 1, `${net.calls.length} ${JSON.stringify(ob)}`);
}
{
  // 알림 꺼짐: 손은 그대로, outbox 안 씀
  const { st, storage, code } = await rig({ env: { TEACHER_PUSH_VAPID_JWK: undefined }, noSub: true });
  await st.labHand(code(1), true); await settle();
  check('VAPID 없음 → 손 들기 됨, outbox·fetch 없음', handOf(storage, 'labA', 1) === T0 && !storage.m.has('tpush:outbox') && net.calls.length === 0);
}
{
  // 받는 기기 없음 → 일 정리, fetch 없음
  const { st, storage, code } = await rig({ noSub: true });
  await st.labHand(code(1), true); await settle();
  check('구독 없음 → fetch 없음, 일 정리', net.calls.length === 0 && outbox(storage).jobs.length === 0);
}
{
  // 준비 멈춤(끝내는 중) → 손도 일도 안 씀
  const { st, storage, code } = await rig();
  await storage.put('labprepstop:labA', { at: T0 });
  const keys = [...storage.m.keys()].filter((k) => k.startsWith('prep'));
  const r = await st.labHand(code(1), true); await settle();
  check('멈춤 표시가 있으면 410, 손·일·발송 없음', (r.status === 410 || keys.length === 0) && (r.status !== 410 || (handOf(storage, 'labA', 1) === undefined && outbox(storage).jobs.length === 0 && net.calls.length === 0)), JSON.stringify(r) + keys.join());
}
{
  // 재시도: 503 → 10초 → 503 → 30초 → 503 → 정리 (3번), 120초 안
  const { st, storage, code } = await rig();
  net.respond = () => 503;
  await st.labHand(code(1), true); await settle();
  const j1 = outbox(storage).jobs[0];
  check('503 → 다시 시도 대기 (tries 1, 10초 뒤)', net.calls.length === 1 && j1?.tries === 1 && j1.due === T0 + 10e3 && j1.lease === 0, JSON.stringify(j1));
  check('다음 알람이 다시 시도 시각 이전', storage.alarmAt !== null && storage.alarmAt <= T0 + 10e3 + 1, storage.alarmAt - T0);
  off = 5e3; await st.alarm(); await settle();
  check('때가 안 됐으면 안 보냄', net.calls.length === 1);
  off = 10e3; await st.alarm(); await settle();
  const j2 = outbox(storage).jobs[0];
  check('두 번째 503 → tries 2, 30초 뒤', net.calls.length === 2 && j2?.tries === 2 && j2.due === T0 + 40e3);
  off = 40e3; await st.alarm(); await settle();
  check('세 번째 실패 → 정리 (모두 3번)', net.calls.length === 3 && outbox(storage).jobs.length === 0);
  off = 200e3; await st.alarm(); await settle();
  check('더는 안 보냄', net.calls.length === 3);
}
{
  // 429 → 다음에 201
  const { st, storage, code } = await rig();
  let n = 0; net.respond = () => (n++ === 0 ? 429 : 201);
  await st.labHand(code(1), true); await settle();
  off = 10e3; await st.alarm(); await settle();
  check('429 → 다시 시도 → 201 → 정리', net.calls.length === 2 && outbox(storage).jobs.length === 0);
}
{
  // 네트워크 오류 → 재시도 / 410 → 구독 삭제 / 3xx → 따라가지 않고 정리
  const { st, storage, code, sub } = await rig();
  net.respond = () => 'throw';
  await st.labHand(code(1), true); await settle();
  check('네트워크 오류 → 재시도 대기', outbox(storage).jobs[0]?.tries === 1);
  net.respond = () => 410;
  off = 10e3; await st.alarm(); await settle();
  check('410 → 구독 지우고 정리', net.calls.length === 2 && !storage.m.has(subKeyOf(sub)) && outbox(storage).jobs.length === 0);
}
{
  const { st, storage, code } = await rig();
  net.respond = () => 302;
  await st.labHand(code(1), true); await settle();
  check('302 → fetch 1번 (Location 안 따라감), 정리', net.calls.length === 1 && net.calls.every((c) => c.url.startsWith('https://fcm.googleapis.com/')) && outbox(storage).jobs.length === 0);
}
{
  // 기기 여러 개: 한 일에 기기마다 한 번, 실패한 기기만 다시
  const { st, storage, code, A } = await rig();
  const s2 = newSub('two');
  await subscribe(st, A.ck, s2);
  net.respond = (u) => (u === s2.json.endpoint ? 503 : 201);
  await st.labHand(code(1), true); await settle();
  check('두 기기 → 2번, 실패한 기기만 남김', net.calls.length === 2 && outbox(storage).jobs[0]?.left.length === 1);
  net.respond = () => 201;
  off = 10e3; await st.alarm(); await settle();
  check('다시 시도는 실패한 기기에만', net.calls.length === 3 && net.calls[2].url === s2.json.endpoint && outbox(storage).jobs.length === 0);
}
{
  // 여러 자리가 같이 → 기기마다 한 번으로 합침
  const { st, storage, code } = await rig();
  hooks.open = async () => { await st.labHand(code(2), true); await st.labHand(code(3), true); };
  net.respond = () => 503;
  await st.labHand(code(1), true); await settle();
  net.respond = () => 201;
  off = 10e3; await st.alarm(); await settle();
  check('다른 자리 일들은 한 번의 보내기로 합쳐짐', outbox(storage).jobs.length === 0 && net.calls.length <= 3, net.calls.length);
}

// ── 6. 넣은 뒤 ~ 풀기 ~ 네트워크 사이의 취소 ──
console.log('보내기 직전 취소');
const raceCases = [
  ['참가자 손 내림', async (x) => { await x.st.labHand(x.code(1), false); }],
  ['강사 손 내림', async (x) => { const t = (await x.st.newAdminToken('web')).token; await x.st.labHandClear(t, 'labA', 1); }],
  ['수업 끝내기', async (x) => { const lab = x.storage.m.get('lab:labA'); await x.st.endLab(lab, 'end'); }],
  ['수업 만료', async () => { off = 3 * 3600e3 + 1; }],
  ['강사 로그아웃', async (x) => { await http(x.st, '/api/lab/teacher/logout', { cookie: x.A.ck }); }],
  ['강사 세션 8시간', async (x) => { await x.storage.put('lab:labA', { ...x.storage.m.get('lab:labA'), expiresAt: T0 + 10 * 3600e3 }); off = H8; }],
  ['구독 해제', async (x) => { await http(x.st, P('unsubscribe'), { cookie: x.A.ck, body: JSON.stringify({ endpoint: x.sub.json.endpoint }) }); }],
  ['다른 세션으로 다시 묶임', async (x) => { const B = await session(x.st); await subscribe(x.st, B.ck, x.sub); x.rebound = true; }],
];
for (const [name, act] of raceCases) {
  for (const when of ['풀기 전', '암호화 뒤 fetch 전']) {
    const x = await rig();
    if (when === '풀기 전') hooks.open = () => act(x);
    else {
      const orig = crypto.subtle.sign; let once = true;
      crypto.subtle.sign = async (...a) => { const r = await orig(...a); if (once) { once = false; crypto.subtle.sign = orig; await act(x); } return r; };
    }
    await x.st.labHand(x.code(1), true); await settle();
    hooks.open = null;
    const sent = net.calls.length;
    check(`${name} (${when}) → fetch 0${x.rebound ? '' : ', 일 정리'}`, sent === 0 && (x.rebound || outbox(x.storage).jobs.length === 0), `${sent} ${JSON.stringify(outbox(x.storage).jobs)}`);
    off = 0;
  }
}

{
  // 같은 세션이 보내기 사이에 같은 구독을 다시 보내도 (재인증·새로고침) 묶음이 유지되어 보내진다
  const x = await rig();
  hooks.open = async () => { await subscribe(x.st, x.A.ck, x.sub); };
  await x.st.labHand(x.code(1), true); await settle();
  check('같은 세션 같은 구독 재전송 (풀기 전) → 그대로 보냄 1번', net.calls.length === 1 && outbox(x.storage).jobs.length === 0, net.calls.length);
}

// ── 7. 임차: 재시작·동시 처리 중복 없음, outbox 상한 ──
console.log('임차·상한');
{
  const x = await rig();
  let release; const gate = new Promise((r) => { release = r; });
  hooks.open = () => gate; // 첫 처리가 풀기 직전에서 멈춤 (일은 임차됨)
  await x.st.labHand(x.code(1), true);
  for (let i = 0; i < 5; i++) await tick();
  const j = outbox(x.storage).jobs[0];
  check('처리 중인 일은 임차됨 (60초)', j?.lease === T0 + 60e3, JSON.stringify(j));
  // 같은 저장소의 새 인스턴스(재시작)가 알람을 돌려도 임차 중인 일은 못 잡음
  const st2 = makeState(x.storage).st;
  await st2.alarm();
  check('재시작 인스턴스: 임차 중 → 보내지 않음', net.calls.length === 0);
  // 임차가 끝나면 새 인스턴스가 잡아 보낸다, 그 뒤 풀려난 예전 처리는 보내지 않는다
  off = 60e3 + 1;
  await st2.alarm();
  check('임차 끝 → 새 인스턴스가 1번 보냄', net.calls.length === 1);
  release(); await settle();
  check('예전 처리(임차 끝남)는 보내지 않음 → 모두 1번', net.calls.length === 1 && outbox(x.storage).jobs.length === 0);
  off = 0;
}
{
  // outbox 32개 상한 (처리를 멈춰 둔 채 40자리)
  const x = await rig({ seats: 20 });
  await putLab(x.storage, labOf('labB', 20));
  let release; const gate = new Promise((r) => { release = r; });
  hooks.open = () => gate;
  for (let i = 1; i <= 20; i++) await x.st.labHand(x.code(i), true);
  const labB = x.storage.m.get('lab:labB');
  for (const s of labB.seats) await x.st.labHand(s.code, true);
  check('40자리가 들어도 outbox 일 32개 이하, 손은 전부', outbox(x.storage).jobs.length === 32 && labB.seats.every((s) => handOf(x.storage, 'labB', s.n) !== undefined));
  check('throttle 기록 64개 이하', Object.keys(outbox(x.storage).thr).length <= 64);
  release(); hooks.open = null; await settle();
  off = 60e3 + 1; await x.st.alarm(); await settle();
  off = 130e3; await x.st.alarm(); await settle();
  check('합쳐서 보냄 (기기 하나에 일 32개여도 처리마다 한 번), 끝에는 비움', outbox(x.storage).jobs.length === 0 && net.calls.length <= 8, net.calls.length);
  off = 0;
}
{
  // 알람: 다른 정리 실패 없이, 더 이른 알람 유지, 실패해도 다른 정리는 됨
  const x = await rig();
  net.respond = () => 503;
  await x.st.labHand(x.code(1), true); await settle();
  await x.storage.put('admin:old', { expiresAt: T0 + 1 });
  await x.storage.setAlarm(T0 + 2000);
  off = 3000;
  await x.st.alarm();
  check('알람: 만료 관리 토큰 정리 + 푸시 다시 시도 시각 유지', !x.storage.m.has('admin:old') && x.storage.alarmAt !== null && x.storage.alarmAt <= T0 + 10e3, x.storage.alarmAt - T0);
  // 푸시 처리가 throw 해도 다른 정리는 끝남
  await x.storage.put('tpush:outbox', 'garbage');
  await x.storage.put('admin:old2', { expiresAt: T0 + 1 });
  await x.st.alarm();
  check('푸시 처리 실패해도 알람의 다른 정리는 됨', !x.storage.m.has('admin:old2') && x.storage.alarmAt !== null);
  off = 0;
}

// ── 8. W1 다시 확인·로그아웃과 맞물림: 같은 주인·같은 만료, issuedBy 로 지운 세션 전부의 구독, 다른 기기 그대로 ──
console.log('다시 확인·로그아웃 (W1)');
const reauth = (st, who, admin) => http(st, '/api/lab/teacher/session', { cookie: who.ck, admin });
const logoutW = (st, o) => http(st, '/api/lab/teacher/logout', o);
const tokOf = (r) => /^__Host-lab_teacher=([\w-]{32});/.exec(r.cookie ?? '')?.[1];
const maxAgeOf = (r) => Number(/Max-Age=(\d+)/.exec(r.cookie ?? '')?.[1]);
const recs = (storage, ks) => JSON.stringify(ks.map((k) => storage.m.get(k)));
{
  // 살아 있는 쿠키로 다시 확인 → 같은 토큰·같은 기록·남은 시간만, 구독 묶음·만료 그대로, 새 알람·삭제 없음
  off = 0; net.calls.length = 0; net.respond = () => 201; pending.length = 0;
  const { st, storage } = makeState();
  const lab = await putLab(storage, labOf('labA', 2));
  const A = await session(st), B = await session(st);
  const sa = newSub('ra'), sb = newSub('rb');
  await subscribe(st, A.ck, sa); await subscribe(st, B.ck, sb);
  off = 60e3;
  const web2 = (await st.newAdminToken('web')).token;
  const recA = JSON.stringify(storage.m.get(`teacher:${A.owner}`));
  const before = recs(storage, [subKeyOf(sa), subKeyOf(sb)]);
  const nTeach = [...storage.m.keys()].filter((k) => k.startsWith('teacher:')).length;
  const alarm0 = storage.alarmAt;
  const r = await reauth(st, A, web2);
  check('다시 확인 → 200, 같은 토큰, Max-Age = 남은 시간 (8시간 늘지 않음), 본문 expiresAt 원래 값', r.status === 200 && tokOf(r) === A.tok && maxAgeOf(r) === H8 / 1000 - 60 && r.j?.expiresAt === T0 + H8 && !r.raw.includes(A.tok), `${r.status} ${r.cookie} ${r.raw}`);
  check('다시 확인: teacher 기록 바이트 그대로 (issuedBy 도 처음 관리 토큰), 새 기록 없음', JSON.stringify(storage.m.get(`teacher:${A.owner}`)) === recA && JSON.parse(recA).issuedBy === b64sha(A.web) && [...storage.m.keys()].filter((k) => k.startsWith('teacher:')).length === nTeach);
  check('다시 확인: 구독 두 개 바이트 그대로 (주인·만료 유지, 정리 콜백 없음), 알람 그대로', recs(storage, [subKeyOf(sa), subKeyOf(sb)]) === before && storage.alarmAt === alarm0);
  const s1 = await http(st, P('status'), { cookie: A.ck, body: JSON.stringify({ endpoint: sa.json.endpoint }) });
  check('다시 확인 뒤 status enabled, expiresAt 원래 값', s1.j?.enabled === true && s1.j.expiresAt === T0 + H8, s1.raw);
  // 보내는 도중(풀기 전) 같은 쿠키로 다시 확인 → 묶음 유지, 그대로 보냄
  hooks.open = async () => { await reauth(st, A, web2); };
  await st.labHand(lab.seats[0].code, true); await settle();
  hooks.open = null;
  check('보내기 도중 다시 확인 → A·B 기기 각각 1번씩 보냄', net.calls.filter((c) => c.url === sa.json.endpoint).length === 1 && net.calls.filter((c) => c.url === sb.json.endpoint).length === 1 && outbox(storage).jobs.length === 0, net.calls.map((c) => c.url).join());
  // 끝난 쿠키로 다시 확인 → 401 + 쿠키 지움, 새 세션·구독 없음
  await logoutW(st, { cookie: A.ck });
  const n2 = [...storage.m.keys()].filter((k) => k.startsWith('teacher:')).length;
  const web3 = (await st.newAdminToken('web')).token;
  const dead = await reauth(st, A, web3);
  check('로그아웃한 쿠키로 다시 확인 → 401 + 쿠키 지움, 새 세션 없음, A 구독 없음, B 그대로', dead.status === 401 && dead.cookie === CLEAR && [...storage.m.keys()].filter((k) => k.startsWith('teacher:')).length === n2 && !storage.m.has(subKeyOf(sa)) && storage.m.get(subKeyOf(sb))?.owner === B.owner, `${dead.status} ${dead.cookie}`);
  off = 0;
}
{
  // 기기 16개가 찬 상태에서 다시 확인 → 아무도 밀리지 않음 (구독도 그대로)
  off = 0;
  const { st, storage } = makeState();
  const all = [];
  for (let i = 0; i < 16; i++) { off = i; all.push(await session(st)); }
  const s0 = newSub('cap0');
  await subscribe(st, all[0].ck, s0);
  off = 100;
  const r = await reauth(st, all[0], (await st.newAdminToken('web')).token);
  check('16개 찬 상태에서 가장 오래된 기기가 다시 확인 → 같은 토큰, 16개 모두·구독 그대로', r.status === 200 && tokOf(r) === all[0].tok && all.every((x) => storage.m.has(`teacher:${x.owner}`)) && storage.m.get(subKeyOf(s0))?.owner === all[0].owner);
  off = 101;
  await session(st);
  check('그다음 새 기기 → 가장 오래된 것이 밀리고 그 구독도 지움 (상한 16 그대로)', !storage.m.has(`teacher:${all[0].owner}`) && !storage.m.has(subKeyOf(s0)) && [...storage.m.keys()].filter((k) => k.startsWith('teacher:')).length === 16);
  off = 0;
}
{
  // 관리 토큰을 낸 로그아웃 → 그 관리 토큰으로 만든 세션 전부(이 쿠키 + 다른 기기)의 구독을 바로 지움. 다른 관리 토큰의 두 기기는 그대로
  off = 0; net.calls.length = 0;
  const { st, storage } = makeState();
  const A = await session(st);
  const r2 = await http(st, '/api/lab/teacher/session', { admin: A.web }); // 같은 관리 토큰, 쿠키 없는 다른 기기
  const A2 = { tok: tokOf(r2) }; A2.ck = `__Host-lab_teacher=${A2.tok}`; A2.owner = b64sha(A2.tok);
  const B = await session(st), C = await session(st);
  const a1 = newSub('la1'), a2 = newSub('la2'), a3 = newSub('la3'), sb = newSub('lb'), sc = newSub('lc');
  for (const [w, s] of [[A, a1], [A, a2], [A2, a3], [B, sb], [C, sc]]) await subscribe(st, w.ck, s);
  check('준비: 같은 관리 토큰으로 두 세션 (issuedBy 같음), 구독 5개', r2.status === 200 && A2.tok && A2.tok !== A.tok && storage.m.get(`teacher:${A2.owner}`)?.issuedBy === b64sha(A.web) && subs(storage).length === 5);
  const keepBC = recs(storage, [subKeyOf(sb), subKeyOf(sc), `teacher:${B.owner}`, `teacher:${C.owner}`, `admin:${b64sha(B.web)}`, `admin:${b64sha(C.web)}`]);
  const c0 = ccSum();
  const lo = await logoutW(st, { cookie: A.ck, admin: A.web });
  check('로그아웃(쿠키 + 관리 토큰) → 200 + 쿠키 지움, A·A2 기록과 그 관리 토큰 지움', lo.status === 200 && lo.cookie === CLEAR && !storage.m.has(`teacher:${A.owner}`) && !storage.m.has(`teacher:${A2.owner}`) && !storage.m.has(`admin:${b64sha(A.web)}`));
  check('A 구독 둘 + A2 구독 하나 바로 지움 (알람 기다리지 않음), 암호 0', !storage.m.has(subKeyOf(a1)) && !storage.m.has(subKeyOf(a2)) && !storage.m.has(subKeyOf(a3)) && subs(storage).length === 2 && ccSum() === c0);
  check('다른 관리 토큰의 두 기기(B·C): 세션·구독·관리 토큰 바이트 그대로', recs(storage, [subKeyOf(sb), subKeyOf(sc), `teacher:${B.owner}`, `teacher:${C.owner}`, `admin:${b64sha(B.web)}`, `admin:${b64sha(C.web)}`]) === keepBC);
  const sB = await http(st, P('status'), { cookie: B.ck, body: JSON.stringify({ endpoint: sb.json.endpoint }) });
  const sC = await http(st, '/api/lab/teacher/status', { cookie: C.ck });
  check('B 알림 enabled, C 상태 200', sB.j?.enabled === true && sC.status === 200);
  check('A2 쿠키 → config 401 + 쿠키 지움', (await http(st, P('config'), { cookie: A2.ck })).cookie === CLEAR);
  check('관리 토큰 로그아웃 경로에 fetch 없음', net.calls.length === 0);
}
// 보내기 직전(풀기 전 / 암호화 뒤 fetch 전) 다른 화면이 관리 토큰만으로 로그아웃 → 그 관리 토큰 세션 기기는 0번, 다른 관리 토큰 기기는 그대로 받음
for (const when of ['풀기 전', '암호화 뒤 fetch 전']) {
  const x = await rig();
  const B = await session(x.st);
  const sb = newSub('raceb');
  await subscribe(x.st, B.ck, sb);
  // 두 기기가 같이 처리되므로, 첫 기기에서 시작한 로그아웃이 끝날 때까지 다른 기기도 그 시점에서 기다린다 (이미 시작된 보내기 경쟁은 범위 밖)
  let done = null;
  const act = () => (done ??= logoutW(x.st, { admin: x.A.web }));
  const orig = crypto.subtle.sign;
  if (when === '풀기 전') { const h = async () => { hooks.open = h; await act(); }; hooks.open = h; }
  else crypto.subtle.sign = async (...a) => { const r = await orig(...a); await act(); return r; };
  await x.st.labHand(x.code(1), true); await settle();
  hooks.open = null; crypto.subtle.sign = orig;
  const toA = net.calls.filter((c) => c.url === x.sub.json.endpoint).length, toB = net.calls.filter((c) => c.url === sb.json.endpoint).length;
  check(`관리 토큰 로그아웃 (${when}) → A 기기 fetch 0·구독 지움, B 기기 1번, 일 정리`, toA === 0 && toB === 1 && !x.storage.m.has(subKeyOf(x.sub)) && x.storage.m.has(subKeyOf(sb)) && outbox(x.storage).jobs.length === 0, `${toA} ${toB} ${JSON.stringify(outbox(x.storage).jobs)}`);
  off = 0;
}
{
  // 쿠키 없는 만들기가 먼저 처리되고 응답이 늦음 → 관리 토큰만 낸 로그아웃이 그 기록을 지움. 늦은 쿠키로는 알림을 못 켬. 상한·알람 그대로
  off = 0;
  const { st, storage } = makeState();
  const B = await session(st);
  const sb = newSub('pb');
  await subscribe(st, B.ck, sb);
  const web = (await st.newAdminToken('web')).token;
  await storage.setAlarm(T0 + 1000);
  const late = await http(st, '/api/lab/teacher/session', { admin: web }); // 응답(쿠키)은 브라우저에 아직 안 갔다고 본다
  const L = { tok: tokOf(late) }; L.ck = `__Host-lab_teacher=${L.tok}`;
  check('늦은 만들기: 새 세션 하나·더 이른 알람 유지', late.status === 200 && storage.m.has(`teacher:${b64sha(L.tok)}`) && storage.alarmAt === T0 + 1000);
  const keep = recs(storage, [subKeyOf(sb), `teacher:${B.owner}`]);
  const lo = await logoutW(st, { admin: web });
  check('관리 토큰만 로그아웃 → 늦은 세션·관리 토큰 지움, B 그대로, 알람 그대로', lo.status === 200 && !storage.m.has(`teacher:${b64sha(L.tok)}`) && !storage.m.has(`admin:${b64sha(web)}`) && recs(storage, [subKeyOf(sb), `teacher:${B.owner}`]) === keep && storage.alarmAt === T0 + 1000);
  const c0 = ccSum();
  const sub = await subscribe(st, L.ck, newSub('late'));
  check('늦게 구워진 쿠키로 subscribe → 401 + 쿠키 지움, 암호 0, 구독 없음', sub.status === 401 && sub.cookie === CLEAR && ccSum() === c0 && subs(storage).length === 1);
  const again = await reauth(st, L, web);
  check('늦은 쿠키 + 지운 관리 토큰으로 다시 확인 → 403, 쿠키 안 구움, 새 세션 없음', again.status === 403 && !again.cookie?.includes(`=${L.tok};`) && [...storage.m.keys()].filter((k) => k.startsWith('teacher:')).length === 1);
}
{
  // 로그아웃이 먼저 처리되고 쿠키 없는 만들기가 뒤 → 403, 쿠키·기록·알람 없음
  off = 0;
  const { st, storage } = makeState();
  const B = await session(st);
  const web = (await st.newAdminToken('web')).token;
  await storage.setAlarm(T0 + 1000);
  const keys = JSON.stringify([...storage.m.keys()].filter((k) => k.startsWith('teacher:') || k.startsWith('tpsub:')));
  await logoutW(st, { admin: web });
  const m = await http(st, '/api/lab/teacher/session', { admin: web });
  check('로그아웃 → 만들기: 403, Set-Cookie 없음, 세션·구독 그대로, 알람 그대로', m.status === 403 && m.cookie === null && JSON.stringify([...storage.m.keys()].filter((k) => k.startsWith('teacher:') || k.startsWith('tpsub:'))) === keys && storage.alarmAt === T0 + 1000 && storage.m.has(`teacher:${B.owner}`), `${m.status} ${m.cookie}`);
}
{
  // 알림 경로는 관리 토큰 로그아웃·다시 확인을 열지 않는다 (구독 endpoint 로 보내는 대상·내용을 받지 않음)
  off = 0; net.calls.length = 0;
  const { st, storage } = makeState();
  const A = await session(st);
  const extra = await subscribe(st, A.ck, newSub('x'), { url: 'https://evil.example/x', message: 'hi' });
  const send = await http(st, P('send'), { cookie: A.ck, body: JSON.stringify({ endpoint: 'https://fcm.googleapis.com/fcm/send/x' }) });
  check('subscribe 다른 필드 400, 없는 push 경로는 처리 안 함, fetch 0', extra.status === 400 && send.status !== 200 && subs(storage).length === 0 && net.calls.length === 0, `${extra.status} ${send.status}`);
}

Date.now = realNow;
check('로그 없음', logged.length === 0, logged.join('|'));
console.log(`\n${pass} passed, ${failN} failed`);
process.exit(failN ? 1 : 0);
