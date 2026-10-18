// 강사 보기 전용 세션(/api/lab/teacher/*) 회귀 테스트. 실제 src/index.ts 를 설치된 esbuild 로 번들해 Worker.fetch 와 진짜 State(가짜 메모리 저장소)를 돌린다:
//   - 만들기: 방금(3분) 웹 탭 관리 토큰만 (CLI·오래된·보기 세션 토큰 거부), 응답 본문에 토큰 없음, 쿠키 속성 정확히, 기기 16개 상한
//   - 상태: 쿠키만, 8시간 경계(읽어도 안 늘어남)·DO 재시작·로그아웃(저장된 폐기)·중복/틀린 쿠키·Origin·본문, 허용 목록 DTO (코드·라벨·샌드박스·오류 원문 없음)
//   - Daytona·OpenRouter·바깥 fetch 없음, 알람이 teacher: 를 지우고 더 이른 알람을 덮지 않음
//   - 보기 쿠키로는 기존 관리·강사·금고 API(만들기·스냅샷·초대·끝내기 …)를 못 부른다. 관리 토큰 8시간·등록 3분을 각각 확인
// 네트워크·비밀 값 없음 (fetch 는 막아 두고 세기만).  node test/lab-teacher-monitor.mjs

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const cfStub = { name: 'cf-stub', setup(b) {
  b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'cf', namespace: 'cf-stub' }));
  b.onLoad({ filter: /.*/, namespace: 'cf-stub' }, () => ({ contents: 'export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }', loader: 'js' }));
} };
const bundled = await build({
  entryPoints: [join(ROOT, 'src/index.ts')], bundle: true, write: false, format: 'esm', platform: 'node',
  loader: { '.ps1': 'text' }, plugins: [cfStub], logLevel: 'silent',
});
const dir = mkdtempSync(join(tmpdir(), 'lab-teacher-monitor-'));
writeFileSync(join(dir, 'worker.mjs'), bundled.outputFiles[0].text);
let mod;
try { mod = await import(pathToFileURL(join(dir, 'worker.mjs')).href); } finally { rmSync(dir, { recursive: true, force: true }); }
const worker = mod.default;

const outbound = [];
globalThis.fetch = async (u) => { outbound.push(String(u?.url ?? u)); throw new Error(`network blocked in test: ${u}`); };

// 시계: Date.now 를 앞으로만 돌린다
const T0 = Date.now();
let off = 0;
const realNow = Date.now;
Date.now = () => T0 + off;

let pass = 0, failN = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { failN++; console.log(`  FAIL ${name} ${String(extra).slice(0, 400)}`); }
};
const tick = () => new Promise((r) => setTimeout(r, 0));
const J = JSON.stringify;
const b64sha = (s) => createHash('sha256').update(s).digest('base64url');

function memStorage() {
  const m = new Map();
  let alarm = null;
  const c = (v) => (v === undefined ? v : structuredClone(v));
  const s = {
    m,
    get alarmAt() { return alarm; },
    async get(k) { await tick(); if (Array.isArray(k)) { const r = new Map(); for (const x of k) if (m.has(x)) r.set(x, c(m.get(x))); return r; } return c(m.get(k)); },
    async put(k, v) { await tick(); if (typeof k === 'object') { for (const [a, b] of Object.entries(k)) m.set(a, c(b)); } else m.set(k, c(v)); },
    async delete(k) { await tick(); const ks = Array.isArray(k) ? k : [k]; let n = 0; for (const x of ks) if (m.delete(x)) n++; return Array.isArray(k) ? n : n > 0; },
    async list({ prefix = '' } = {}) { await tick(); return new Map([...m.keys()].filter((x) => x.startsWith(prefix)).sort().map((x) => [x, c(m.get(x))])); },
    async getAlarm() { return alarm; },
    async setAlarm(t) { alarm = t; },
    async transaction(f) { const prev = s.q; let done; s.q = new Promise((r) => { done = r; }); await prev; try { return await f(s); } finally { done(); } },
    q: Promise.resolve(),
  };
  return s;
}

const ORIGIN = 'https://k.example.test', LAB_ORIGIN = 'https://lab.example.test';
let daytonaCalls = 0;
class T extends mod.State {
  async daytona() { daytonaCalls++; return { status: 409, error: 'no daytona in test' }; }
}
const envOf = () => ({ ORIGIN, LAB_ORIGIN, LAB_SEAT_DOMAIN: 'example.test', RP_ID: 'example.test', MASTER_KEY: 'dummy-master-key' });
function makeState(storage = memStorage()) {
  const hooks = {}; // hooks.bcw: 직렬 구역(blockConcurrencyWhile) 들어가기 바로 앞에 한 번 (줄 서는 동안 일어난 일 흉내)
  const ctx = { storage, waitUntil() {}, blockConcurrencyWhile: async (f) => { const h = hooks.bcw; hooks.bcw = null; if (h) await h(); return f(); } };
  return { st: new T(ctx, envOf()), storage, hooks };
}
const wctx = { waitUntil() {}, passThroughOnException() {} };
const isFail = (x) => x && typeof x === 'object' && 'error' in x && 'status' in x;

async function http(st, path, { cookie, admin, origin = ORIGIN, body, method = 'POST', headers = {} } = {}) {
  const h = { ...headers };
  if (origin) h.origin = origin;
  if (cookie !== undefined) h.cookie = cookie;
  if (admin !== undefined) h['x-admin-token'] = admin;
  const env = { ...envOf(), STATE: { idFromName: (n) => ({ name: n }), get: () => st } };
  const req = new Request(ORIGIN + path, { method, headers: h, ...(body !== undefined ? { body, ...(body instanceof ReadableStream ? { duplex: 'half' } : {}) } : {}) });
  const res = await worker.fetch(req, env, wctx);
  const raw = await res.text();
  let j; try { j = JSON.parse(raw); } catch {}
  return { res, status: res.status, raw, j, cookie: res.headers.get('set-cookie'), cookies: res.headers.getSetCookie() };
}
const tokenFromCookie = (sc) => /^__Host-lab_teacher=([\w-]{32});/.exec(sc ?? '')?.[1];
const COOKIE_RE = /^__Host-lab_teacher=[\w-]{32}; HttpOnly; Secure; SameSite=Strict; Path=\/; Max-Age=28800$/;
const CLEAR = '__Host-lab_teacher=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0';
const ADMIN_CLEAR = '__Host-lab_admin=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict';
const clearedBoth = r => J(r.cookies) === J([CLEAR, ADMIN_CLEAR]);
const H8 = 8 * 3600e3;

// ── 1. 만들기: 누가 만들 수 있나 ──
console.log('만들기 권한');
{
  off = 0;
  const { st, storage } = makeState();
  const web = (await st.newAdminToken('web')).token;
  const cli = (await st.newAdminToken('cli')).token;
  const r = await http(st, '/api/lab/teacher/session', { admin: web });
  const tok = tokenFromCookie(r.cookie);
  check('웹 관리 토큰(방금) → 200 {ok,expiresAt}', r.status === 200 && r.j?.ok === true && r.j.expiresAt === T0 + H8 && Object.keys(r.j).sort().join() === 'expiresAt,ok', r.raw);
  check('쿠키 속성 정확히 (HttpOnly·Secure·Strict·Path=/·Max-Age=28800)', COOKIE_RE.test(r.cookie ?? ''), r.cookie);
  check('본문에 토큰 원문 없음 + no-store', !!tok && !r.raw.includes(tok) && r.res.headers.get('cache-control') === 'no-store');
  check('저장소에는 해시만 (원문 없음)', storage.m.has(`teacher:${b64sha(tok)}`) && !JSON.stringify([...storage.m]).includes(tok));
  check('알람이 8시간 만료 이전으로 잡힘', storage.alarmAt !== null && storage.alarmAt <= T0 + H8);
  const c1 = await http(st, '/api/lab/teacher/session', { admin: cli });
  check('CLI 관리 토큰 → 403, 쿠키 없음', c1.status === 403 && !c1.cookie, c1.raw);
  const c2 = await http(st, '/api/lab/teacher/session', { cookie: `__Host-lab_teacher=${tok}` });
  check('보기 쿠키만으로 → 403 (새 세션 못 만듦)', c2.status === 403 && !c2.cookie, c2.raw);
  const c3 = await http(st, '/api/lab/teacher/session', { admin: tok });
  check('보기 토큰을 x-admin-token 에 → 403', c3.status === 403 && !c3.cookie, c3.raw);
  const c4 = await http(st, '/api/lab/teacher/session', { admin: web, origin: null });
  check('Origin 없음 → 403', c4.status === 403 && !c4.cookie);
  const c5 = await http(st, '/api/lab/teacher/session', { admin: web, origin: 'https://evil.example' });
  check('다른 Origin → 403', c5.status === 403 && !c5.cookie);
  const c6 = await http(st, '/api/lab/teacher/session', { admin: web, body: '{"x":1}' });
  check('비지 않은 본문 → 400', c6.status === 400 && !c6.cookie);
  const c7 = await http(st, '/api/lab/teacher/session', { admin: web, body: '{}', headers: { 'content-type': 'application/json' } });
  check('본문 {} 은 허용', c7.status === 200 && COOKIE_RE.test(c7.cookie ?? ''));
  const c8 = await http(st, '/api/lab/teacher/session', { admin: web, method: 'GET' });
  check('GET 은 세션을 만들지 않음', !tokenFromCookie(c8.cookie));

  // 등록·쿠키 만들기의 3분 경계와 관리자 8시간 수명을 따로 확인한다.
  off = 3 * 60e3 - 1;
  check('웹 토큰 3분 직전 → 만들기 됨', (await http(st, '/api/lab/teacher/session', { admin: web })).status === 200);
  off = 3 * 60e3;
  const late = await http(st, '/api/lab/teacher/session', { admin: web });
  check('웹 토큰 3분 → 403', late.status === 403 && !late.cookie, late.raw);
  check('3분 이후에도 관리 토큰은 유효 (checkAdmin)', (await st.checkAdmin(web)) === true);
  off = 11 * 60e3;
  check('관리 토큰은 10분 뒤에도 웹·CLI 모두 유효', (await st.checkAdmin(web)) && (await st.checkAdmin(cli)));
  off = 8 * 3600e3 - 1;
  check('관리 토큰 8시간 직전 유효', (await st.checkAdmin(web)) && (await st.checkAdmin(cli)));
  off = 8 * 3600e3;
  check('관리 토큰 8시간 → 웹·CLI 모두 만료', !(await st.checkAdmin(web)) && !(await st.checkAdmin(cli)));
  off = 0;
}

// ── 2. 상태: 8시간·재시작·로그아웃·쿠키 ──
console.log('상태 수명');
{
  off = 0;
  const storage = memStorage();
  const { st } = makeState(storage);
  const web = (await st.newAdminToken('web')).token;
  const tok = tokenFromCookie((await http(st, '/api/lab/teacher/session', { admin: web })).cookie);
  const ck = `__Host-lab_teacher=${tok}`;
  const rec0 = JSON.stringify(storage.m.get(`teacher:${b64sha(tok)}`));
  const s1 = await http(st, '/api/lab/teacher/status', { cookie: ck });
  check('쿠키 → 200 {now,expiresAt,labs}', s1.status === 200 && Object.keys(s1.j).sort().join() === 'expiresAt,labs,now' && s1.j.expiresAt === T0 + H8 && Array.isArray(s1.j.labs), s1.raw);
  check('상태 no-store, 쿠키 다시 굽지 않음', s1.res.headers.get('cache-control') === 'no-store' && !s1.cookie);
  off = 11 * 60e3;
  check('11분 뒤에도 보기와 관리 권한 모두 유지', (await http(st, '/api/lab/teacher/status', { cookie: ck })).status === 200 && (await st.checkAdmin(web)));
  check('읽어도 기록이 그대로 (만료 안 늘어남)', JSON.stringify(storage.m.get(`teacher:${b64sha(tok)}`)) === rec0);
  // DO 재시작 (같은 저장소, 새 인스턴스)
  const st2 = makeState(storage).st;
  off = H8 - 1;
  const s2 = await http(st2, '/api/lab/teacher/status', { cookie: ck });
  check('재시작 뒤 8시간 직전까지 됨, expiresAt 고정', s2.status === 200 && s2.j.expiresAt === T0 + H8, s2.raw);
  off = H8;
  const s3 = await http(st2, '/api/lab/teacher/status', { cookie: ck });
  check('정확히 8시간 → 401 + 쿠키 지움', s3.status === 401 && s3.cookie === CLEAR, `${s3.status} ${s3.cookie}`);
  off = 0;
  check('관리 토큰을 x-admin-token 에 줘도 상태는 쿠키만 (401)', (await http(st2, '/api/lab/teacher/status', { admin: web })).status === 401);
  const dup = await http(st2, '/api/lab/teacher/status', { cookie: `${ck}; __Host-lab_teacher=${tok}` });
  check('같은 이름 쿠키 둘 → 400 + 지움', dup.status === 400 && dup.cookie === CLEAR);
  for (const bad of [`__Host-lab_teacher=${tok}x`, '__Host-lab_teacher=', '__Host-lab_teacher', `__Host-lab_teacher="${tok}"`, `__Host-lab_teacher=${tok.slice(0, 31)}!`]) {
    const r = await http(st2, '/api/lab/teacher/status', { cookie: bad });
    check(`틀린 쿠키 ${JSON.stringify(bad.slice(18, 30))} → 400`, r.status === 400 && r.cookie === CLEAR, r.raw);
  }
  check('다른 쿠키 이름(lab_teacher)은 권한 아님 → 401', (await http(st2, '/api/lab/teacher/status', { cookie: `lab_teacher=${tok}` })).status === 401);
  check('없는(위조) 토큰 → 401', (await http(st2, '/api/lab/teacher/status', { cookie: `__Host-lab_teacher=${'A'.repeat(32)}` })).status === 401);
  check('Origin 없음 → 403', (await http(st2, '/api/lab/teacher/status', { cookie: ck, origin: null })).status === 403);
  check('다른 Origin → 403', (await http(st2, '/api/lab/teacher/status', { cookie: ck, origin: LAB_ORIGIN })).status === 403);
  for (const p of ['/api/lab/teacher/session', '/api/lab/teacher/status', '/api/lab/teacher/logout']) {
    const r = await http(st2, p, { cookie: ck, admin: web, origin: 'null' });
    check(`${p} Origin "null" → 403, 쿠키 안 건드림`, r.status === 403 && !r.cookie, `${r.status} ${r.cookie}`);
  }
  check('본문 있음 → 400', (await http(st2, '/api/lab/teacher/status', { cookie: ck, body: '{"id":"x"}' })).status === 400);
  check('큰 본문 → 400', (await http(st2, '/api/lab/teacher/status', { cookie: ck, body: ' '.repeat(100) })).status === 400);
  // 로그아웃 → 저장된 폐기
  const lo = await http(st2, '/api/lab/teacher/logout', { cookie: ck });
  check('로그아웃 → {ok:true} + 보기·관리 복원 쿠키 지움', lo.status === 200 && lo.j?.ok === true && clearedBoth(lo));
  check('로그아웃: 기록 지워짐', !storage.m.has(`teacher:${b64sha(tok)}`));
  check('로그아웃 뒤 상태 401 (재시작해도)', (await http(st2, '/api/lab/teacher/status', { cookie: ck })).status === 401
    && (await http(makeState(storage).st, '/api/lab/teacher/status', { cookie: ck })).status === 401);
  const lo2 = await http(st2, '/api/lab/teacher/logout', { cookie: 'junk=1' });
  check('쿠키 없이 로그아웃도 ok + 보기·관리 복원 쿠키 지움', lo2.status === 200 && clearedBoth(lo2));
  check('로그아웃 Origin 없음 → 403', (await http(st2, '/api/lab/teacher/logout', { cookie: ck, origin: null })).status === 403);
}

// ── 3. 기기 16개 상한, 알람 ──
console.log('상한·알람');
{
  off = 0;
  const storage = memStorage();
  const { st } = makeState(storage);
  await storage.setAlarm(T0 + 60e3); // 다른 일이 잡아 둔 더 이른 알람
  const web = (await st.newAdminToken('web')).token;
  const toks = [];
  for (let i = 0; i < 17; i++) { off = i; toks.push(tokenFromCookie((await http(st, '/api/lab/teacher/session', { admin: web })).cookie)); }
  const live = [...storage.m.keys()].filter((k) => k.startsWith('teacher:'));
  check('살아 있는 세션 16개', live.length === 16, live.length);
  check('가장 오래된 하나만 폐기', !storage.m.has(`teacher:${b64sha(toks[0])}`) && toks.slice(1).every((t) => storage.m.has(`teacher:${b64sha(t)}`)));
  check('폐기된 기기 상태 401, 나머지 200', (await http(st, '/api/lab/teacher/status', { cookie: `__Host-lab_teacher=${toks[0]}` })).status === 401
    && (await http(st, '/api/lab/teacher/status', { cookie: `__Host-lab_teacher=${toks[16]}` })).status === 200);
  check('더 이른 알람을 덮지 않음', storage.alarmAt === T0 + 60e3, storage.alarmAt - T0);
  // 실패한 만들기는 아무것도 폐기하지 않는다
  off = 4 * 60e3;
  await http(st, '/api/lab/teacher/session', { admin: web });
  check('거부된 만들기는 폐기 없음', [...storage.m.keys()].filter((k) => k.startsWith('teacher:')).length === 16);
  off = H8 + 100;
  await st.alarm();
  check('8시간 뒤 알람이 teacher: 를 지움', ![...storage.m.keys()].some((k) => k.startsWith('teacher:')), [...storage.m.keys()].join());
  off = 0;
}

// ── 4. DTO 허용 목록 · 바깥 호출 없음 ──
console.log('보기 DTO');
{
  off = 0;
  const storage = memStorage();
  const { st } = makeState(storage);
  const SECRET = { code: 'CODEsecret123456', label: 'labelsecretlabelsecretabcd', sandbox: 'sb-secret-id', sid: 'S-secret-sid', pv: 'pv-secret-token', err: 'daytona raw 500 secret-error', note: 'git clone 실패: secret-upstream-text' };
  const seat = (n, extra = {}) => ({ n, code: `${SECRET.code.slice(0, 12)}${String(n).padStart(4, '0')}`, label: SECRET.label, sandboxId: `${SECRET.sandbox}-${n}`, sid: `${SECRET.sid}-${n}`,
    pv: { origin: 'https://pv.secret', token: SECRET.pv }, ...extra });
  const lab = { id: 'labA', name: '1교시', createdAt: T0, expiresAt: T0 + 3600e3, budget: 1, cpu: 1, memory: 2, disk: 5, snapshot: 'snap-secret', model: 'm', gw: 'https://gw.secret', materials: 'https://materials.secret',
    share: { or: { label: 'OR', on: true, cap: 5 } }, clip: { in: true, out: false },
    seats: [
      seat(1, { who: 'Alice', hand: T0 - 5000, opened: T0 - 60e3, setup: { state: 'error', at: T0, note: SECRET.note } }),
      seat(2, { error: SECRET.err, setup: { state: 'error', at: T0, note: '실습실 준비 시간이 지났습니다. 강사에게 알려주세요.' } }),
      seat(3, { setup: { state: 'ok', at: T0, note: 'materials-dir/ (git)' } }),
      ...Array.from({ length: 22 }, (_, i) => seat(4 + i)),
    ] };
  const ending = { ...lab, id: 'labB', name: '끝내는 중', createdAt: T0 - 1, endRetry: T0 + 300e3, seats: [seat(1)] };
  const expired = { ...lab, id: 'labC', name: '지난 수업', createdAt: T0 - 2, expiresAt: T0 - 1, seats: [seat(1)] };
  for (const l of [lab, ending, expired]) await storage.put(`lab:${l.id}`, l);
  await storage.put(`lerr:${SECRET.sid}-1`, { at: T0, status: 500, msg: SECRET.err, n: 3 });
  await storage.put(`sess:${SECRET.sid}-1`, { id: `${SECRET.sid}-1`, orKey: 'sk-or-secret', lastAi: T0 });
  await storage.put(`pres:${lab.seats[0].code}`, { seen: T0 - 10e3, tabs: [['tab-abcdef', { at: T0 - 10e3, idle: 20, vis: true, focus: true, watch: false }], ['tab-watch1', { at: T0 - 5e3, idle: 0, vis: true, focus: true, watch: true }]] });
  const web = (await st.newAdminToken('web')).token;
  const tok = tokenFromCookie((await http(st, '/api/lab/teacher/session', { admin: web })).cookie);
  daytonaCalls = 0; outbound.length = 0;
  const r = await http(st, '/api/lab/teacher/status', { cookie: `__Host-lab_teacher=${tok}` });
  const j = r.j;
  check('끝난 수업 빠짐, 끝내는 중은 ending:true', r.status === 200 && j.labs.map((l) => l.id).join() === 'labA,labB' && j.labs[1].ending === true && j.labs[0].ending === false, r.raw.slice(0, 300));
  check('수업 필드 허용 목록만', j.labs.every((l) => Object.keys(l).sort().join() === 'ending,expiresAt,id,name,seats'), JSON.stringify(Object.keys(j.labs[0])));
  check('자리 필드 허용 목록만', j.labs.flatMap((l) => l.seats).every((s) => Object.keys(s).sort().join() === 'delivery,diagnostics,error,hand,n,opened,preparation,presence,setup,who'));
  check('presence 필드 허용 목록만', j.labs.flatMap((l) => l.seats).every((s) => Object.keys(s.presence).sort().join() === 'idleSec,lastSeen,state'));
  check('자리 20개 상한', j.labs[0].seats.length === 20, j.labs[0].seats.length);
  const s = j.labs[0].seats;
  check('자리 1: 이름·손·입장·상태', s[0].who === 'Alice' && s[0].hand === T0 - 5000 && s[0].opened === T0 - 60e3 && s[0].presence.state === 'active' && s[0].presence.idleSec === 30 && s[0].presence.lastSeen === T0 - 10e3, JSON.stringify(s[0]));
  check('오류 note 원문 대신 일반 문구, 고정 문구는 그대로', s[0].setup.state === 'error' && s[0].setup.note === '수업 자료를 넣지 못했습니다.' && s[1].setup.note === '실습실 준비 시간이 지났습니다. 강사에게 알려주세요.' && s[2].setup.note === '', JSON.stringify(s.slice(0, 3).map((x) => x.setup)));
  check('error 는 불리언만', s[1].error === true && s[0].error === false);
  check('자리 신호 없음 → none, null', s[3].presence.state === 'none' && s[3].presence.idleSec === null && s[3].setup === null && s[3].who === '' && s[3].hand === null);
  const leaks = [...Object.values(SECRET), 'sk-or-secret', 'https://gw.secret', 'https://materials.secret', 'snap-secret', 'pv.secret', tok, 'tab-abcdef', '"share"', '"clip"', '"budget"', '"code"', '"label"', '"sandboxId"', '"sid"', '"err"', '/j/'];
  check('민감 값 없음 (코드·라벨·샌드박스·세션·미리보기·오류 원문·키·주소·토큰)', leaks.every((x) => !r.raw.includes(x)), leaks.filter((x) => r.raw.includes(x)).join(' | '));
  check('preparation 허용 키만, setup=ok도 준비 증명 아님', s.every(x => Object.keys(x.preparation).sort().join() === 'at,state') && s[2].preparation.state === 'unknown');
  check('전달 기록은 시각·상태만, 기록 없으면 확인 안 됨', s.every(x => Object.keys(x.delivery).sort().join() === 'at,status' && x.delivery.status === 'unknown' && x.delivery.at === null));
  check('진단 허용 키만, 유효 세션 없는 캐시 노출 안 함', s.every(x => Object.keys(x.diagnostics).sort().join() === 'aiError,limit,usage,usageAt') && s[0].diagnostics.aiError === null);
  const sid = `${SECRET.sid}-1`;
  const sess = { id: sid, lab: lab.id, expiresAt: T0 + 3600e3, orKey: 'sk-or-secret' };
  await storage.put(`sess:${sid}`, sess);
  st.usageCache.set(sid, { at: T0, v: { usage: 0.75, limit: 5, key: 'must-not-leak' } });
  const status = () => http(st, '/api/lab/teacher/status', { cookie: `__Host-lab_teacher=${tok}` });
  const current = await status(), ds = current.j.labs[0].seats[0].diagnostics;
  check('현재 lab/session의 캐시와 scalar 오류만', ds.usage === .75 && ds.limit === 5 && ds.usageAt === T0 && ds.aiError?.kind === 'upstream' && ds.aiError.count === 3 && Object.keys(ds.aiError).sort().join() === 'at,count,kind,status' && !current.raw.includes(SECRET.err) && !current.raw.includes('must-not-leak'));
  check('끝내는 중인 수업 진단 숨김', current.j.labs[1].seats[0].diagnostics.usageAt === null && current.j.labs[1].seats[0].diagnostics.aiError === null);
  for (const patch of [{ lab: 'other' }, { id: 'other' }, { revoked: true }, { expiresAt: T0 }]) {
    await storage.put(`sess:${sid}`, { ...sess, ...patch });
    check('타 수업/자리·폐기·만료 세션 진단 숨김 ' + JSON.stringify(patch), (await status()).j.labs[0].seats[0].diagnostics.usageAt === null);
  }
  await storage.put(`sess:${sid}`, sess);
  off = 30_000;
  const stale = (await status()).j.labs[0].seats[0].diagnostics;
  check('30초 경계 캐시 누락은 unknown, 최근 오류는 유지', stale.usageAt === null && stale.usage === null && stale.aiError?.count === 3);
  off = 600_001; // 10분 뒤에도 관리자와 읽기 쿠키가 모두 살아 있음
  st.usageCache.set(sid, { at: T0 + off, v: { usage: 1, limit: null } });
  const restored = await status(), rd = restored.j.labs[0].seats[0].diagnostics;
  check('10분 뒤 읽기 진단 유지·관리 유효·한도 없음·오래된 오류 숨김', restored.status === 200 && rd.usage === 1 && rd.limit === null && rd.aiError === null && (await st.checkAdmin(web)));
  off = 0;
  check('Daytona·바깥 fetch 없음', daytonaCalls === 0 && outbound.length === 0, `${daytonaCalls} ${outbound.join(' ')}`);
  check('읽기가 lab 기록을 바꾸지 않음', JSON.stringify(storage.m.get('lab:labA')) === JSON.stringify(lab));
}

// ── 5. 보기 쿠키는 다른 API 권한이 아니다 ──
console.log('권한 경계');
{
  off = 0;
  const storage = memStorage();
  const { st } = makeState(storage);
  const lab = { id: 'labA', name: 'x', createdAt: T0, expiresAt: T0 + 3600e3, budget: 1, cpu: 1, memory: 2, disk: 5, snapshot: 's', model: 'm', gw: 'g', seats: [{ n: 1, code: 'CODEsecret123456', sandboxId: 'sb', sid: 'S1', label: 'l', hand: T0 }] };
  await storage.put('lab:labA', lab);
  await storage.put('vault:meta', { q: [] });
  const web = (await st.newAdminToken('web')).token;
  const tok = tokenFromCookie((await http(st, '/api/lab/teacher/session', { admin: web })).cookie);
  const ck = `__Host-lab_teacher=${tok}`;
  const before = JSON.stringify([...storage.m].filter(([k]) => !k.startsWith('audit')));
  daytonaCalls = 0; outbound.length = 0;
  const paths = [
    ['/api/lab/create', { name: 'n', seats: 1, hours: 1, budget: 1 }], ['/api/lab/snapshot', { snapshot: 'x', cpu: 1, memory: 2, disk: 5 }],
    ['/api/lab/config', {}], ['/api/lab/list', {}], ['/api/lab/invite', { id: 'labA' }], ['/api/lab/invite', { id: 'labA', n: 1 }], ['/api/lab/end', { id: 'labA' }],
    ['/api/lab/clip', { id: 'labA', in: false }], ['/api/lab/share', { id: 'labA', provider: 'or', on: false }], ['/api/lab/hand', { id: 'labA', n: 1 }],
    ['/api/lab/snips', { id: 'labA' }], ['/api/lab/snip', { id: 'labA', text: 'x' }], ['/api/lab/snip-delete', { id: 'labA', snip: 'x' }],
    ['/api/lab/screen/start', { id: 'labA', sdp: 'x' }], ['/api/lab/screen/stop', { id: 'labA' }], ['/api/lab/screen/status', {}],
    ['/api/admin/list', {}], ['/api/admin/revoke', { target: 'all' }], ['/api/admin/provider', { id: 'x', value: 'v' }], ['/api/admin/provider-delete', { id: 'x' }], ['/api/admin/cred-delete', { id: 'x' }],
    ['/api/vault/item', { item: { id: 'x', iv: 'a', ct: 'b' } }], ['/api/vault/item-delete', { id: 'x' }], ['/api/vault/recovery-code', {}], ['/api/vault/init', {}], ['/api/vault/link', {}], ['/api/vault/recovery', {}], ['/api/vault/send', {}],
    ['/api/register/options', {}],
  ];
  for (const [p, b] of paths) {
    const r = await http(st, p, { cookie: ck, body: JSON.stringify(b) });
    check(`${p} 보기 쿠키 → 거부 (${r.status})`, r.status === 401 || r.status === 403, `${r.status} ${r.raw.slice(0, 160)}`);
    const r2 = await http(st, p, { admin: tok, body: JSON.stringify(b) });
    if (!(r2.status === 401 || r2.status === 403)) check(`${p} 보기 토큰을 x-admin-token 에 → 거부`, false, `${r2.status} ${r2.raw.slice(0, 160)}`);
  }
  check('보기 토큰을 x-admin-token 에 넣어도 전부 거부', true);
  check('거부된 호출이 저장소를 바꾸지 않음', JSON.stringify([...storage.m].filter(([k]) => !k.startsWith('audit'))) === before);
  check('Daytona·바깥 fetch 없음', daytonaCalls === 0 && outbound.length === 0, `${daytonaCalls} ${outbound.join(' ')}`);
  // 직접 RPC 로도 (Worker 를 거치지 않는 DO 메서드)
  const rpcs = [
    () => st.labCreate(tok, {}), () => st.labSnapshotPrepare(tok, {}), () => st.labEnd(tok, 'labA'), () => st.labInvite(tok, 'labA'), () => st.labList(tok),
    () => st.labSetClip(tok, 'labA', { in: false, out: false }), () => st.labSetShare(tok, 'labA', 'or', false), () => st.labHandClear(tok, 'labA', 1), () => st.labSnipAdd(tok, 'labA', 'x'),
    () => st.adminList(tok), () => st.vaultPutItem(tok, {}), () => st.registerOptions('', tok, 'src'), () => st.teacherSessionMint(tok),
  ];
  const got = await Promise.all(rpcs.map((f) => f()));
  check('DO 메서드에 보기 토큰 → 전부 Fail', got.every((x) => isFail(x) && (x.status === 401 || x.status === 403)), JSON.stringify(got.map((x) => x?.status)));
  check('보기 세션 메서드는 서비스 # 필드 + 위임 3개만 prototype 에', ['teacherSessionMint', 'teacherStatus', 'teacherLogout'].every((k) => typeof mod.State.prototype[k] === 'function') && !('teacher' in st));
}

// ── 6. 만들기 직렬 구역 안 재확인 · 본문 바이트 상한 ──
console.log('만들기 재확인·바이트 상한');
{
  off = 0;
  const { st, storage, hooks } = makeState();
  const teachers = () => [...storage.m.keys()].filter((k) => k.startsWith('teacher:'));
  const web = (await st.newAdminToken('web')).token;
  // 기존 세션 하나 (실패한 만들기가 지우면 안 됨)
  const keep = tokenFromCookie((await http(st, '/api/lab/teacher/session', { admin: web })).cookie);
  // 첫 확인은 2분 59.999초에 통과, 줄 서는 동안 3분이 됨 → 거부, 아무것도 안 씀/안 지움
  off = 3 * 60e3 - 1;
  hooks.bcw = () => { off = 3 * 60e3; };
  const r1 = await http(st, '/api/lab/teacher/session', { admin: web });
  check('줄 서는 동안 3분 지남 → 403, 쿠키 없음', r1.status === 403 && !r1.cookie, r1.raw);
  check('거부: 새 기록 없음, 기존 기록 그대로', teachers().length === 1 && storage.m.has(`teacher:${b64sha(keep)}`));
  // 줄 서는 동안 관리 토큰 폐기(삭제) → 거부
  off = 60e3;
  const web2 = (await st.newAdminToken('web')).token;
  hooks.bcw = async () => { await storage.delete(`admin:${b64sha(web2)}`); };
  const r2 = await http(st, '/api/lab/teacher/session', { admin: web2 });
  check('줄 서는 동안 관리 토큰 폐기 → 403', r2.status === 403 && !r2.cookie && teachers().length === 1, r2.raw);
  // 통과한 경우: 기록 시각은 실제로 허가된(직렬 구역 안) 시각
  off = 60e3;
  const web3 = (await st.newAdminToken('web')).token;
  hooks.bcw = () => { off = 60e3 + 90e3; };
  const r3 = await http(st, '/api/lab/teacher/session', { admin: web3 });
  const rec3 = storage.m.get(`teacher:${b64sha(tokenFromCookie(r3.cookie) ?? '')}`);
  check('허가 시각 기준 createdAt·expiresAt (첫 확인 시각 아님)', r3.status === 200 && rec3?.createdAt === T0 + 150e3 && rec3.expiresAt === T0 + 150e3 + H8 && r3.j.expiresAt === rec3.expiresAt, `${r3.raw} ${JSON.stringify(rec3)}`);

  // 본문: 바이트로 센다
  off = 0;
  const ck = `__Host-lab_teacher=${keep}`;
  const enc = new TextEncoder();
  const stream = (chunks, st8 = { pulls: 0 }) => new ReadableStream({ pull(c) { st8.pulls++; const x = chunks.shift(); if (x) c.enqueue(x); else c.close(); } }, { highWaterMark: 0 });
  const status = (body) => http(st, '/api/lab/teacher/status', { cookie: ck, body });
  check('ASCII 64바이트 ({} + 공백 62) → 200', (await status('{}' + ' '.repeat(62))).status === 200);
  check('ASCII 65바이트 → 400', (await status('{}' + ' '.repeat(63))).status === 400);
  // U+3000(3바이트, trim 이 지우는 공백): 23글자 = 65바이트. 글자 수로 세면 통과했을 것
  const wide = enc.encode('{}' + '　'.repeat(21));
  check('여러 바이트 글자 65바이트(23글자) → 400', wide.byteLength === 65 && (await status(wide)).status === 400);
  const split = [wide.slice(0, 3), wide.slice(3, 4), wide.slice(4, 40), wide.slice(40)]; // 글자 중간에서 자른 조각
  check('같은 본문을 글자 중간에서 조각내도 → 400', (await status(stream(split))).status === 400);
  const ok62 = enc.encode('　'.repeat(20) + '{}');
  check('여러 바이트 62바이트 조각 → 200', ok62.byteLength === 62 && (await status(stream([ok62.slice(0, 1), ok62.slice(1, 31), ok62.slice(31)]))).status === 200);
  const pulls = { pulls: 0 };
  const big = await status(stream([new Uint8Array(10_000).fill(32), new Uint8Array(10).fill(32), new Uint8Array(10).fill(32)], pulls));
  check('큰 조각 하나(10000바이트) → 400, 다음 조각 안 읽음', big.status === 400 && pulls.pulls === 1, `${big.status} pulls ${pulls.pulls}`);
  const many = { pulls: 0 };
  const r9 = await status(stream(Array.from({ length: 20 }, () => enc.encode('    ')), many));
  check('작은 조각 여러 개: 64바이트 넘는 순간 멈춤', r9.status === 400 && many.pulls === 17, `${r9.status} pulls ${many.pulls}`);
  check('content-length 65 → 400', (await http(st, '/api/lab/teacher/logout', { cookie: ck, body: ' '.repeat(65) })).status === 400);
  check('바이트 상한은 만들기에도 (65바이트 → 400, 기록 없음)', (await http(st, '/api/lab/teacher/session', { admin: (await st.newAdminToken('web')).token, body: '{}' + ' '.repeat(63) })).status === 400 && teachers().length === 2);
}

// ── 7. 다시 확인은 지금 쿠키를 그대로 (늘리지 않음) · 끝난 쿠키로는 새로 못 만듦 · 로그아웃과 만들기 순서 ──
console.log('다시 확인·로그아웃 순서');
{
  off = 0;
  const { st, storage, hooks } = makeState();
  const teachers = () => [...storage.m.keys()].filter((k) => k.startsWith('teacher:')).sort();
  const admin = (t) => storage.m.has(`admin:${b64sha(t)}`);
  const mintNew = async (a) => tokenFromCookie((await http(st, '/api/lab/teacher/session', { admin: a })).cookie);
  const live = async (t) => (await http(st, '/api/lab/teacher/status', { cookie: `__Host-lab_teacher=${t}` })).status === 200;
  const a1 = (await st.newAdminToken('web')).token;
  const c = await mintNew(a1);
  const rec = storage.m.get(`teacher:${b64sha(c)}`);
  check('새 세션 기록: createdAt·expiresAt·issuedBy(관리 토큰 해시)만, 원문 없음', Object.keys(rec).sort().join() === 'createdAt,expiresAt,issuedBy' && rec.issuedBy === b64sha(a1) && !JSON.stringify([...storage.m]).includes(a1), JSON.stringify(rec));
  const sraw = (await http(st, '/api/lab/teacher/status', { cookie: `__Host-lab_teacher=${c}` })).raw;
  check('상태 응답에 issuedBy·해시 없음', !sraw.includes('issuedBy') && !sraw.includes(rec.issuedBy));
  // 2시간 뒤 다시 확인 (새 관리 토큰 + 지금 쿠키): 같은 토큰, 같은 만료, 남은 시간만큼 Max-Age, 기록 그대로
  off = 2 * 3600e3;
  const alarm0 = storage.alarmAt;
  const a2 = (await st.newAdminToken('web')).token;
  const before = teachers(), rec0 = JSON.stringify(storage.m.get(`teacher:${b64sha(c)}`));
  const re = await http(st, '/api/lab/teacher/session', { admin: a2, cookie: `__Host-lab_teacher=${c}` });
  check('다시 확인: 200, 같은 토큰 다시 굽기, expiresAt 처음 그대로', re.status === 200 && tokenFromCookie(re.cookie) === c && re.j.expiresAt === T0 + H8 && Object.keys(re.j).sort().join() === 'expiresAt,ok' && !re.raw.includes(c), `${re.raw} ${re.cookie}`);
  check('다시 확인: Max-Age 는 남은 6시간 (21600, 8시간 아님)', re.cookie === `__Host-lab_teacher=${c}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=21600`, re.cookie);
  check('다시 확인: 새 기록 없음, 기록(createdAt·issuedBy) 그대로, 알람 그대로', J(teachers()) === J(before) && JSON.stringify(storage.m.get(`teacher:${b64sha(c)}`)) === rec0 && storage.alarmAt === alarm0);
  // 관리 토큰 3분 지남 + 살아 있는 쿠키 → 403, 쿠키는 지우지 않는다 (모니터는 계속)
  off = 2 * 3600e3 + 3 * 60e3;
  const old = await http(st, '/api/lab/teacher/session', { admin: a2, cookie: `__Host-lab_teacher=${c}` });
  check('오래된 관리 토큰 + 살아 있는 쿠키 → 403, 쿠키 안 건드림', old.status === 403 && !old.cookie && await live(c), `${old.status} ${old.cookie}`);
  // 틀린·둘 쿠키 + 방금 관리 토큰 → 400 + 지움, 새 기록 없음
  const a3 = (await st.newAdminToken('web')).token;
  for (const bad of [`__Host-lab_teacher=${c}x`, `__Host-lab_teacher=${c}; __Host-lab_teacher=${c}`, '__Host-lab_teacher=']) {
    const r = await http(st, '/api/lab/teacher/session', { admin: a3, cookie: bad });
    check(`틀린 쿠키로 다시 확인 → 400 + 지움, 새 세션 없음 (${bad.length})`, r.status === 400 && r.cookie === CLEAR && J(teachers()) === J(before), `${r.status} ${r.cookie}`);
  }
  // 위조(없는) 쿠키 → 401 + 지움, 새로 만들지 않음
  const forged = await http(st, '/api/lab/teacher/session', { admin: a3, cookie: `__Host-lab_teacher=${'B'.repeat(32)}` });
  check('없는 쿠키로 다시 확인 → 401 + 지움, 새 세션 없음', forged.status === 401 && forged.cookie === CLEAR && J(teachers()) === J(before), `${forged.status} ${forged.cookie}`);
  // 로그아웃된 쿠키로 다시 확인 → 401 + 지움, 새로 만들지 않음
  await http(st, '/api/lab/teacher/logout', { cookie: `__Host-lab_teacher=${c}` });
  const gone = await http(st, '/api/lab/teacher/session', { admin: a3, cookie: `__Host-lab_teacher=${c}` });
  check('로그아웃된 쿠키로 다시 확인 → 401 + 지움, 새 세션 없음', gone.status === 401 && gone.cookie === CLEAR && teachers().length === before.length - 1 && !(await live(c)), `${gone.status} ${gone.raw}`);
  check('쿠키 로그아웃(관리 토큰 없음)은 관리 토큰을 건드리지 않음', admin(a3) && admin(a2));
  // 만료된 쿠키로 다시 확인 → 401, 새로 만들지 않음
  off = 0;
  const a4 = (await st.newAdminToken('web')).token;
  const e = await mintNew(a4);
  off = H8 + 10;
  const a5 = (await st.newAdminToken('web')).token;
  const n0 = teachers().length;
  const exp = await http(st, '/api/lab/teacher/session', { admin: a5, cookie: `__Host-lab_teacher=${e}` });
  check('만료된 쿠키로 다시 확인 → 401 + 지움, 새 세션 없음', exp.status === 401 && exp.cookie === CLEAR && teachers().length === n0, `${exp.status} ${exp.raw}`);
}
{
  // 로그아웃(쿠키 없음 + 같은 화면의 관리 토큰)과 처음 만들기: 어느 순서든 살아 있는 모니터가 남지 않는다. 다른 기기 둘은 그대로
  off = 0;
  const { st, storage, hooks } = makeState();
  const teachers = () => [...storage.m.keys()].filter((k) => k.startsWith('teacher:')).sort();
  const live = async (t) => (await http(st, '/api/lab/teacher/status', { cookie: `__Host-lab_teacher=${t}` })).status === 200;
  const other1 = (await st.newAdminToken('web')).token, other2 = (await st.newAdminToken('web')).token;
  const d1 = tokenFromCookie((await http(st, '/api/lab/teacher/session', { admin: other1 })).cookie);
  const d2 = tokenFromCookie((await http(st, '/api/lab/teacher/session', { admin: other2 })).cookie);
  const others = async () => (await live(d1)) && (await live(d2)) && (await st.checkAdmin(other1)) && (await st.checkAdmin(other2));
  // (가) 만들기가 먼저 끝나고 (쿠키 응답이 늦게 도착), 로그아웃은 그 뒤
  const a = (await st.newAdminToken('web')).token;
  const late = tokenFromCookie((await http(st, '/api/lab/teacher/session', { admin: a })).cookie);
  const lo = await http(st, '/api/lab/teacher/logout', { admin: a });
  check('만들기 → 로그아웃(관리 토큰): 그 관리 토큰으로 만든 세션 지움, 관리 토큰 폐기', lo.status === 200 && clearedBoth(lo) && !(await live(late)) && !(await st.checkAdmin(a)), lo.raw);
  check('(가) 다른 기기 둘·그 관리 토큰은 그대로', await others());
  check('(가) 폐기된 관리 토큰으로 다시 만들기 → 403', (await http(st, '/api/lab/teacher/session', { admin: a })).status === 403 && teachers().length === 2);
  // (나) 만들기가 줄 서 있는 동안 로그아웃이 먼저 (만들기 첫 확인은 통과한 뒤)
  const b = (await st.newAdminToken('web')).token;
  let loB;
  hooks.bcw = async () => { loB = await http(st, '/api/lab/teacher/logout', { admin: b }); };
  const mB = await http(st, '/api/lab/teacher/session', { admin: b });
  check('로그아웃 → 줄 선 만들기: 403, 쿠키 없음, 새 세션 없음', loB?.status === 200 && mB.status === 403 && !mB.cookie && teachers().length === 2, `${loB?.status} ${mB.status} ${mB.raw}`);
  check('(나) 관리 토큰 폐기, 다른 기기 둘은 그대로', !(await st.checkAdmin(b)) && await others());
  // (다) 지금 쿠키로 다시 확인하는 도중 로그아웃(쿠키 + 관리 토큰)이 먼저 → 다시 확인은 403, 쿠키 세션 지워짐
  const c0 = (await st.newAdminToken('web')).token;
  const c = tokenFromCookie((await http(st, '/api/lab/teacher/session', { admin: c0 })).cookie);
  const c1 = (await st.newAdminToken('web')).token;
  hooks.bcw = async () => { await http(st, '/api/lab/teacher/logout', { admin: c1, cookie: `__Host-lab_teacher=${c}` }); };
  const mC = await http(st, '/api/lab/teacher/session', { admin: c1, cookie: `__Host-lab_teacher=${c}` });
  check('쿠키 다시 확인 도중 로그아웃 먼저 → 403·새 세션 없음, 쿠키 세션 지워짐', mC.status === 403 && !tokenFromCookie(mC.cookie) && !(await live(c)) && teachers().length === 2, `${mC.status} ${mC.cookie}`);
  // (라) 다시 확인이 먼저 끝나고 로그아웃 → 같은 쿠키(재사용)라 로그아웃이 지운 그 세션 — 늦게 구워져도 권한 없음
  const d0 = (await st.newAdminToken('web')).token;
  const dck = tokenFromCookie((await http(st, '/api/lab/teacher/session', { admin: d0 })).cookie);
  const dA = (await st.newAdminToken('web')).token;
  const reD = await http(st, '/api/lab/teacher/session', { admin: dA, cookie: `__Host-lab_teacher=${dck}` });
  await http(st, '/api/lab/teacher/logout', { admin: dA, cookie: `__Host-lab_teacher=${dck}` });
  check('다시 확인 → 로그아웃: 늦게 온 쿠키(같은 토큰)는 401', tokenFromCookie(reD.cookie) === dck && !(await live(dck)) && teachers().length === 2 && await st.checkAdmin(d0) === true);
  // 로그아웃: 틀린 관리 토큰·다른 Origin 은 아무것도 지우지 않음
  const n = JSON.stringify([...storage.m].filter(([k]) => k.startsWith('teacher:') || k.startsWith('admin:')));
  await http(st, '/api/lab/teacher/logout', { admin: 'x'.repeat(32) });
  await http(st, '/api/lab/teacher/logout', { admin: 'short' });
  const bo = await http(st, '/api/lab/teacher/logout', { admin: other1, cookie: `__Host-lab_teacher=${d1}`, origin: 'https://evil.example' });
  check('없는 관리 토큰·짧은 값·다른 Origin 로그아웃 → 아무것도 안 지움', bo.status === 403 && n === JSON.stringify([...storage.m].filter(([k]) => k.startsWith('teacher:') || k.startsWith('admin:'))) && await others());
  // CLI 관리 토큰으로 로그아웃: 그 토큰 하나만 폐기 (만든 세션은 없음)
  const cli = (await st.newAdminToken('cli')).token;
  await http(st, '/api/lab/teacher/logout', { admin: cli });
  check('로그아웃에 낸 관리 토큰 하나만 폐기 (다른 관리 토큰·기기 그대로)', !(await st.checkAdmin(cli)) && await others() && teachers().length === 2);
}

Date.now = realNow;
console.log(`\n${pass} passed, ${failN} failed`);
process.exit(failN ? 1 : 0);
