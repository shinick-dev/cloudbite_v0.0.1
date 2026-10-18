// 직접 입력 사양 스냅샷 자동 준비 회귀 테스트 (네트워크·진짜 Daytona·비밀 값 없음).
//   진짜 State(esbuild 번들, 가짜 ctx·fetch·시계) + lab-api 라우터(가짜 ApiContext):
//   관리 토큰·입력 확인이 먼저(호출·저장 없음), 없으면 원본(-1c2g) 레시피로 POST 한 번 → 202 준비 중, 다시 물어 active·사양 일치면 ready → 수업 만들기,
//   원본·사양이 안 맞으면 POST 없음, 같은·다른 사양 동시 요청, 시간 초과·500·409·400·재시작에서 중복 POST 없음, 본문·키·레시피가 응답·저장소에 안 남음, 기본 사양은 예전 경로
//   node test/lab-snapshot-auto.mjs
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const cfStub = { name: 'cf-stub', setup(b) {
  b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'cf', namespace: 'cf-stub' }));
  b.onLoad({ filter: /.*/, namespace: 'cf-stub' }, () => ({ contents: 'export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }', loader: 'js' }));
} };
async function load(entry, name) {
  const out = await build({ entryPoints: [join(ROOT, entry)], bundle: true, write: false, format: 'esm', platform: 'node', loader: { '.ps1': 'text' }, plugins: [cfStub], logLevel: 'silent' });
  const dir = mkdtempSync(join(tmpdir(), 'lab-snap-auto-'));
  writeFileSync(join(dir, name), out.outputFiles[0].text);
  try { return await import(pathToFileURL(join(dir, name)).href); } finally { rmSync(dir, { recursive: true, force: true }); }
}

let pass = 0, failN = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { failN++; console.log(`  FAIL ${name} ${String(extra).slice(0, 500)}`); }
};
const tick = () => new Promise((r) => setTimeout(r, 0));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = JSON.stringify;

// ── 시계 (State 의 now() 는 Date.now) ──
const realNow = Date.now.bind(Date);
let skew = 0;
Date.now = () => realNow() + skew;

// ── 가짜 Daytona ──
const SECRET = 'sk-SECRET-provider-body-qqqq';
const KEY = 'fx-daytona-key-zzzz';
const RECIPE = `FROM ubuntu:24.04\n# RECIPE-MARKER-${'x'.repeat(18000)}\nRUN echo ok\n`;
const ev = [];
const outbound = [];
const D = {};         // 이름 → 스냅샷 (서버 쪽 상태)
const H = {};         // 테스트별 바꾸기: get(name), post(body)
const posts = [];
const jr = (x, status = 200) => new Response(JSON.stringify(x), { status, headers: { 'content-type': 'application/json' } });
// 기한(AbortSignal)까지 응답 없음. Node 의 AbortSignal.timeout 은 이벤트 루프를 붙잡지 않으므로 기다리는 동안 타이머 하나를 둔다
const hang = (init) => new Promise((_, rej) => { const keep = setInterval(() => {}, 20); init.signal?.addEventListener('abort', () => { clearInterval(keep); rej(init.signal.reason); }); });
const source = (over = {}) => ({ id: 'src', name: 'gw-lab-v4-1c2g', state: 'active', cpu: 1, mem: 2, disk: 5, imageName: '', sandboxClass: 'container',
  buildInfo: { dockerfileContent: RECIPE, contextHashes: null, createdAt: 'c', updatedAt: 'u', snapshotRef: 'ref-' + SECRET }, secretish: SECRET, ...over });
function defaultGet(name) {
  if (name === 'gw-lab-v4-1c2g') return jr(source());
  if (D[name]) return jr(D[name]);
  return jr({ message: `not found ${SECRET}` }, 404);
}
function defaultPost(body) {
  D[body.name] = { id: 'n-' + body.name, name: body.name, state: 'pending', cpu: body.cpu, mem: body.memory, disk: body.disk };
  return jr({ ...D[body.name], buildInfo: { dockerfileContent: body.buildInfo.dockerfileContent }, log: SECRET });
}
globalThis.fetch = async (input, init = {}) => {
  const u = new URL(typeof input === 'string' ? input : input.url);
  const method = init.method ?? 'GET';
  if (u.host === 'dt.fake') {
    if (init.headers?.authorization !== `Bearer ${KEY}`) throw new Error('key header missing');
    if (u.pathname.startsWith('/organizations/') && u.pathname.endsWith('/usage')) {
      ev.push('GET usage');
      return H.usage ? H.usage() : jr({}, 503);
    }
    if (u.pathname.startsWith('/snapshots/') && method === 'GET') {
      const name = decodeURIComponent(u.pathname.slice('/snapshots/'.length));
      ev.push(`GET ${name}`);
      return (H.get ?? defaultGet)(name, init);
    }
    if (u.pathname === '/snapshots' && method === 'POST') {
      const body = JSON.parse(init.body);
      ev.push(`POST ${body.name}`); posts.push(body);
      return (H.post ?? defaultPost)(body, init);
    }
    ev.push(method === 'POST' && u.pathname === '/sandbox' ? 'POST /sandbox' : `dt ${method} ${u.pathname}`); // 자리 준비 GET 등 (앞 인스턴스 것일 수 있음)
    if (u.pathname === '/sandbox' && method === 'POST') { H.sandboxes?.push(JSON.parse(init.body)); return jr({ id: `sb-${ev.length}`, state: 'creating' }); }
    return jr({ id: 'x', state: 'started', items: [] });
  }
  outbound.push(`${method} ${u.href}`);
  return jr({ error: 'blocked' }, 503);
};

let CUR = null; // 지금 보는 저장소 — 앞 인스턴스의 늦은 쓰기(자리 준비)는 ev 에 안 센다
function memStorage() {
  const m = new Map();
  const log = (x) => { if (s === CUR) ev.push(x); };
  let alarm = null;
  const c = (v) => (v === undefined ? v : structuredClone(v));
  const s = {
    m,
    async get(k) { await tick(); if (Array.isArray(k)) { const r = new Map(); for (const x of k) if (m.has(x)) r.set(x, c(m.get(x))); return r; } return c(m.get(k)); },
    async put(k, v) { await tick(); if (typeof k === 'object') { for (const [a, b] of Object.entries(k)) { log(`put ${a}`); m.set(a, c(b)); } } else { log(`put ${k}`); m.set(k, c(v)); } },
    async delete(k) { await tick(); const ks = Array.isArray(k) ? k : [k]; let n = 0; for (const x of ks) { if (m.delete(x)) { n++; log(`del ${x}`); } } return Array.isArray(k) ? n : n > 0; },
    async list({ prefix = '' } = {}) { await tick(); return new Map([...m.keys()].filter((x) => x.startsWith(prefix)).sort().map((x) => [x, c(m.get(x))])); },
    async getAlarm() { return alarm; },
    async setAlarm(t) { log('alarm'); alarm = t; },
    async transaction(f) { return f(s); },
  };
  return s;
}

const S = await load('src/state.ts', 'state.mjs');
const API = await load('src/lab-api.ts', 'api.mjs');
let TO = { get: 200, post: 200 };
async function make(storage = memStorage()) {
  const ctx = { storage, waitUntil: () => {}, blockConcurrencyWhile: (f) => f() };
  class T extends S.State {
    async daytona() { return { api: 'https://dt.fake', key: KEY }; }
    async checkAdmin(token) { ev.push('auth'); return token === 'admin'; }
    async labShareInput() { return { share: {}, defs: [] }; }
    async listProviders() { return [{ id: 'or', kind: 'openrouter-mint' }]; }
    async modelExists() { return true; }
    async newSession() { ev.push('mint'); return { sid: `S${Math.random().toString(36).slice(2, 10)}`, token: 'tok' }; }
    async endSession() {}
    async audit() {}
    snapshotTimeouts() { return TO; }
  }
  const st = new T(ctx, { LAB_SEAT_DOMAIN: 'seat.fake', LAB_ORIGIN: 'https://lab.fake' });
  // 생성자 migrateGrants 가 끝난 뒤부터 센다
  for (let i = 0; i < 200 && !storage.m.has('mig:grants'); i++) await sleep(5);
  storage.m.delete('mig:grants');
  CUR = storage;
  ev.length = 0;
  return { st, storage };
}
function reset() {
  ev.length = 0; posts.length = 0; skew = 0; TO = { get: 200, post: 200 };
  for (const k of Object.keys(D)) delete D[k];
  for (const k of Object.keys(H)) delete H[k];
}
const T8 = 'gw-lab-v4-2c8g10d';
const SPEC = { snapshot: 'gw-lab-v4', cpu: 2, memory: 8, disk: 10 };
const V = { name: '자동', seats: 2, hours: 1, budget: 1, cpu: 2, memory: 8, disk: 10, gw: 'https://gw-x.workers.dev', snapshot: 'gw-lab-v4', model: 'deepseek/deepseek-v4.1-flash' };
const pendingOf = (state) => J({ snapshotPreparing: true, snapshot: T8, state, retryAfterMs: 5000 });
const LAB_WRITES = /^(put (labcfg|lab:|seat:|sess:|labprep:)|mint|alarm|POST \/sandbox)/;
const noLab = () => !ev.some((e) => LAB_WRITES.test(e));
const providerCalls = () => ev.filter((e) => /^(GET|POST|DELETE|PUT|PATCH) /.test(e));
const clean = (x) => { const s = J(x); return !s.includes(SECRET) && !s.includes(KEY) && !s.includes('RECIPE-MARKER') && !s.includes('FROM ubuntu'); };
const jobs = (storage) => [...storage.m.keys()].filter((k) => k.startsWith('snapjob:'));

console.log('관리 토큰·입력 확인이 먼저 (호출·저장 없음)');
{
  reset();
  const { st, storage } = await make();
  let r = await st.labSnapshotPrepare('bad', SPEC);
  check('관리 토큰 틀림 → 401, Daytona 호출·저장 없음', r.status === 401 && J(ev) === J(['auth']) && storage.m.size === 0, J(r) + J(ev));
  r = await st.labSnapshotPrepare('bad', { snapshot: {}, cpu: true });
  check('토큰 틀림 + 입력 틀림 → 401 (토큰이 먼저)', r.status === 401);
  const bad = [
    [{ ...SPEC, cpu: true }, '사양'], [{ ...SPEC, cpu: '2.0' }, '사양'], [{ ...SPEC, disk: '10\n' }, '사양'], [{ ...SPEC, memory: 0 }, '사양'],
    [{ ...SPEC, disk: 2147483648 }, '사양'], [{ snapshot: 'gw-lab-v4' }, '사양'],
    [{ ...SPEC, cpu: 1, memory: 2, disk: 5 }, '기본'], [{ ...SPEC, cpu: 4, memory: 8, disk: 10 }, '기본'],
    [{ ...SPEC, snapshot: { toString: () => 'x' } }, '이름'], [{ ...SPEC, snapshot: ['gw'] }, '이름'], [{ ...SPEC, snapshot: 'a b' }, '이름'],
    [{ ...SPEC, snapshot: 'a\nb' }, '이름'], [{ ...SPEC, snapshot: '../../x?y' }, '이름'], [{ ...SPEC, snapshot: 's'.repeat(113) }, '이름'], [{ ...SPEC, snapshot: 'x#y' }, '이름'], [{ ...SPEC, snapshot: 'x%2F' }, '이름'],
  ];
  for (const [input, why] of bad) {
    ev.length = 0;
    r = await st.labSnapshotPrepare('admin', input);
    check(`입력 거부 (${why}) ${J(input).slice(0, 60)} → 400, 호출·저장 없음`, r.status === 400 && providerCalls().length === 0 && storage.m.size === 0, J(r) + J(ev));
  }
  ev.length = 0;
  r = await st.labSnapshotPrepare('admin', { ...SPEC, snapshot: 's'.repeat(112) });
  check('이름 + -2c8g10d 가 딱 120자면 받음 (GET 으로 감)', !isNaN(1) && providerCalls()[0] === `GET ${'s'.repeat(112)}-2c8g10d`, J(ev));
}

console.log('없음 → POST 한 번 → 202 준비 중 → active 확인 → 수업 만들기');
{
  reset();
  const { st, storage } = await make();
  const r = await st.labCreate('admin', V);
  check('labCreate: 없음 → 준비 중 (고정 모양)', J(r) === pendingOf('requested'), J(r));
  check('labCreate 준비 중: 수업·labcfg·세션·자리·알람·샌드박스 없음', noLab() && [...storage.m.keys()].every((k) => k.startsWith('snapjob:')), J(ev));
  check('순서: GET 목표 → GET 원본 → 기록 → POST → 기록', J(ev.filter((e) => e !== 'auth')) === J([`GET ${T8}`, 'GET gw-lab-v4-1c2g', `put snapjob:${T8}`, `POST ${T8}`, `put snapjob:${T8}`]), J(ev));
  check('POST 본문: 이름·사양·Dockerfile 만 (원본 메타·contextHashes·snapshotRef 없음)', posts.length === 1 && J(Object.keys(posts[0]).sort()) === J(['buildInfo', 'cpu', 'disk', 'memory', 'name'])
    && J(Object.keys(posts[0].buildInfo)) === J(['dockerfileContent']) && posts[0].buildInfo.dockerfileContent === RECIPE && posts[0].cpu === 2 && posts[0].memory === 8 && posts[0].disk === 10 && posts[0].name === T8, J(posts[0]).slice(0, 300));
  const job = storage.m.get(`snapjob:${T8}`);
  check('기록: posted, 레시피·키·공급자 본문 없음', job?.phase === 'posted' && clean(job) && J(Object.keys(job).sort()) === J(['at', 'base', 'cpu', 'disk', 'memory', 'phase']), J(job));
  check('응답에 레시피·키·공급자 본문 없음', clean(r));

  ev.length = 0;
  let p = await st.labSnapshotPrepare('admin', SPEC);
  check('다시 묻기 (pending) → 준비 중 building, POST 없음, 토큰 다시 확인', J(p) === pendingOf('building') && ev[0] === 'auth' && J(providerCalls()) === J([`GET ${T8}`]), J(p) + J(ev));
  D[T8].state = 'building';
  p = await st.labSnapshotPrepare('admin', SPEC);
  check('building → 준비 중', J(p) === pendingOf('building'));
  p = await st.labSnapshotPrepare('bad', SPEC);
  check('다시 묻기도 토큰이 틀리면 401', p.status === 401);
  D[T8].state = 'active';
  ev.length = 0;
  p = await st.labSnapshotPrepare('admin', SPEC);
  check('active + 사양 일치 → snapshotReady', J(p) === J({ snapshotReady: true, snapshot: T8 }), J(p));
  check('ready 면 기록을 지움', jobs(storage).length === 0 && ev.includes(`del snapjob:${T8}`), J(ev));
  H.sandboxes = [];
  ev.length = 0;
  const c = await st.labCreate('admin', V);
  check('그 뒤 labCreate → 수업 만들어짐, 목표 스냅샷으로 샌드박스', c.ok === true && H.sandboxes.length === 2 && H.sandboxes.every((b) => b.snapshot === T8), J(c).slice(0, 200));
  check('labCreate 가 다시 GET 으로 확인 (POST 없음)', providerCalls()[0] === `GET ${T8}` && !ev.some((e) => e.startsWith('POST gw')), J(ev));
}

console.log('ready 는 언제나 GET 의 active + 사양 일치');
{
  reset();
  H.post = (b) => { D[b.name] = { name: b.name, state: 'active', cpu: b.cpu, mem: 4, disk: b.disk }; return jr({ name: b.name, state: 'active', cpu: 2, mem: 8, disk: 10 }); };
  const { st, storage } = await make();
  let r = await st.labSnapshotPrepare('admin', SPEC);
  check('POST 응답이 active 라 해도 준비 중 (POST 응답을 믿지 않음)', J(r) === pendingOf('requested'), J(r));
  ev.length = 0;
  r = await st.labSnapshotPrepare('admin', SPEC);
  check('만든 것이 사양 다름(mem 4) → 409, 다시 만들지 않음', r.status === 409 && /다릅니다/.test(r.error) && !ev.some((e) => /^(POST|DELETE)/.test(e)), J(r) + J(ev));
  r = await st.labCreate('admin', V);
  check('사양 다름이면 labCreate 도 409, 수업 없음', r.status === 409 && noLab() && posts.length === 1, J(r));
  check('기록 정리됨', jobs(storage).length === 0);
}

console.log('원본을 쓸 수 없으면 POST 없음 (기록도 없음)');
{
  const bads = [
    ['원본 없음', () => jr({ message: SECRET }, 404), /원본 스냅샷 gw-lab-v4-1c2g 이 Daytona 에 없어/],
    ['원본 500', () => jr({ message: SECRET }, 500), /원본 스냅샷 gw-lab-v4-1c2g 을 확인하지 못했습니다 \(Daytona 500\)/],
    ['원본 사양 다름 (cpu 2)', () => jr(source({ cpu: 2 })), /active 1 vCPU/],
    ['원본 inactive', () => jr(source({ state: 'inactive' })), /active 1 vCPU/],
    ['원본 contextHashes 있음', () => jr(source({ buildInfo: { dockerfileContent: RECIPE, contextHashes: ['abc'] } })), /빌드 정보/],
    ['원본 buildInfo 없음 (imageName 만)', () => jr(source({ buildInfo: undefined, imageName: 'docker.io/evil/img:1' })), /빌드 정보/],
    ['원본 imageName 있음 (레시피도 있음)', () => jr(source({ imageName: 'docker.io/evil/img:1' })), /빌드 정보/],
    ['원본이 살아 있는 샌드박스에서 뜸 (sourceSandboxId)', () => jr(source({ sourceSandboxId: 'sb-live-classroom' })), /빌드 정보/],
    ['원본 sandboxClass 컨테이너 아님', () => jr(source({ sandboxClass: 'vm' })), /빌드 정보/],
    ['원본 buildInfo 배열', () => jr(source({ buildInfo: [RECIPE] })), /빌드 정보/],
    ['원본 building', () => jr(source({ state: 'building' })), /active 1 vCPU/],
    ['Dockerfile 128KiB 넘음', () => jr(source({ buildInfo: { dockerfileContent: 'FROM a\n' + 'x'.repeat(128 * 1024) } })), /빌드 정보/],
    ['Dockerfile 제어 문자', () => jr(source({ buildInfo: { dockerfileContent: 'FROM a\n\u0000RUN x' } })), /빌드 정보/],
    ['Dockerfile FROM 없음', () => jr(source({ buildInfo: { dockerfileContent: 'RUN curl evil' } })), /빌드 정보/],
    ['Dockerfile 빈 문자열', () => jr(source({ buildInfo: { dockerfileContent: '  ' } })), /빌드 정보/],
    ['Dockerfile 숫자', () => jr(source({ buildInfo: { dockerfileContent: 7 } })), /빌드 정보/],
  ];
  for (const [name, src, re] of bads) {
    reset();
    H.get = (n) => (n === 'gw-lab-v4-1c2g' ? src() : jr({ message: SECRET }, 404));
    const { st, storage } = await make();
    const r = await st.labCreate('admin', V);
    check(`${name} → 409, POST·기록·수업 없음, 본문 안 샘`, r.status === 409 && re.test(r.error) && posts.length === 0 && storage.m.size === 0 && noLab() && clean(r), J(r) + J(ev));
  }
  for (const [name, ctx, over] of [['contextHashes 없음', undefined, {}], ['contextHashes []', [], {}], ['contextHashes null', null, {}],
    ['sourceSandboxId null·sandboxClass 없음', null, { sourceSandboxId: null, sandboxClass: undefined }], ['imageName 없음', null, { imageName: undefined }]]) {
    reset();
    H.get = (n) => (n === 'gw-lab-v4-1c2g' ? jr(source({ ...over, buildInfo: { dockerfileContent: RECIPE, ...(ctx === undefined ? {} : { contextHashes: ctx }) } })) : defaultGet(n));
    const { st } = await make();
    const r = await st.labSnapshotPrepare('admin', SPEC);
    check(`${name} → 받음 (POST 한 번)`, r.snapshotPreparing === true && posts.length === 1, J(r));
  }
}

console.log('있는 스냅샷이 실패·inactive 면 알리기만 (지우거나 다시 만들지 않음)');
for (const state of ['error', 'build_failed', 'inactive', 'removing', 'weird']) { // 기록 없이 이미 있는 것
  reset();
  D[T8] = { name: T8, state, cpu: 2, mem: 8, disk: 10, errorReason: SECRET };
  const { st, storage } = await make();
  const r = await st.labSnapshotPrepare('admin', SPEC);
  check(`${state} → 409, POST·DELETE 없음, 공급자 이유 안 샘`, r.status === 409 && J(providerCalls()) === J([`GET ${T8}`]) && storage.m.size === 0 && clean(r) && !r.error.includes('weird'), J(r) + J(ev));
}

console.log('동시 요청');
{
  reset();
  let release;
  H.post = (b, init) => new Promise((res) => { release = () => res(defaultPost(b)); });
  TO = { get: 2000, post: 2000 };
  const { st, storage } = await make();
  const a = st.labSnapshotPrepare('admin', SPEC), b = st.labCreate('admin', V), c = st.labSnapshotPrepare('admin', SPEC);
  const d = st.labSnapshotPrepare('admin', { ...SPEC, memory: 4 });
  while (!release) await sleep(5);
  await sleep(20);
  check('POST 진행 중에는 다른 요청이 기다림 (POST 하나)', posts.length === 1, J(ev));
  release();
  H.post = undefined;
  const [ra, rb, rc, rd] = await Promise.all([a, b, c, d]);
  check('같은 사양 세 요청 → POST 한 번, 모두 준비 중', posts.length === 1 && [ra, rb, rc].every((x) => x.snapshotPreparing === true), J([ra, rb, rc]));
  check('labCreate 동시 요청도 수업 안 만듦', noLab(), J(ev));
  check('다른 사양(2/4/10) → 진행 중이라 409, POST 없음', rd.status === 409 && /다른 사양의 스냅샷\(gw-lab-v4-2c8g10d\)/.test(rd.error) && !posts.some((p) => p.name === 'gw-lab-v4-2c4g10d'), J(rd));
  check('기록은 하나', J(jobs(storage)) === J([`snapjob:${T8}`]));
  for (const [label, meta] of [['모르는 상태', { name: T8, state: 'weird', cpu: 2, mem: 8, disk: 10 }], ['removing', { name: T8, state: 'removing' }], ['상태 없음', { name: T8 }], ['배열 응답', [1]], ['상태 숫자', { state: 7 }]]) {
    D[T8] = meta;
    const rx = await st.labSnapshotPrepare('admin', { ...SPEC, memory: 4 });
    check(`앞 목표가 ${label} → 자리 안 풀림 (다른 사양 POST 없음, 기록 그대로)`, rx.status === 409 && posts.length === 1 && J(jobs(storage)) === J([`snapjob:${T8}`]), J(rx));
  }
  D[T8] = { name: T8, state: 'weird', cpu: 2, mem: 8, disk: 10 };
  const rw = await st.labSnapshotPrepare('admin', SPEC);
  check('내 목표가 모르는 상태 → 409, 기록 그대로 (풀지 않음)', rw.status === 409 && J(jobs(storage)) === J([`snapjob:${T8}`]) && !rw.error.includes('weird'), J(rw));
  D[T8] = { name: T8, state: 'active', cpu: 2, mem: 8, disk: 10 };
  D[T8].state = 'active';
  const re = await st.labSnapshotPrepare('admin', { ...SPEC, memory: 4 });
  check('앞의 만들기가 끝나면(active) 다른 사양도 POST', re.snapshotPreparing === true && re.snapshot === 'gw-lab-v4-2c4g10d' && posts.length === 2 && J(jobs(storage)) === J(['snapjob:gw-lab-v4-2c4g10d']), J(re) + J(jobs(storage)));
}

console.log('애매한 POST (시간 초과·500·연결 끊김) → 다시 보내지 않음');
for (const [name, post] of [
  ['시간 초과', (b, init) => hang(init)],
  ['500', () => jr({ message: SECRET }, 500)],
  ['연결 끊김', () => { throw new TypeError('reset ' + SECRET); }],
  ['408', () => jr({}, 408)],
]) {
  reset();
  H.post = post;
  const { st, storage } = await make();
  const t0 = realNow();
  let r = await st.labSnapshotPrepare('admin', SPEC);
  check(`${name}: 준비 중 checking (기한 안에 끝남), 기록 uncertain`, J(r) === pendingOf('checking') && storage.m.get(`snapjob:${T8}`)?.phase === 'uncertain' && realNow() - t0 < 2000, J(r));
  r = await st.labSnapshotPrepare('admin', SPEC);
  check(`${name}: 다시 물음 + GET 404 (기다림 시간 안) → 준비 중, POST 없음`, J(r) === pendingOf('checking') && posts.length === 1, J(r));
  r = await st.labCreate('admin', V);
  check(`${name}: labCreate 도 POST 없이 준비 중, 수업 없음`, r.snapshotPreparing === true && posts.length === 1 && noLab(), J(r));
  skew = 2 * 60e3;
  r = await st.labSnapshotPrepare('admin', SPEC);
  check(`${name}: 기다림이 지나도 404 → 확인 못 함 409, 자동 재요청 없음`, r.status === 409 && /자동으로 다시 요청하지 않습니다/.test(r.error) && posts.length === 1 && clean(r), J(r));
  // 사실은 만들어져 있었다 → GET 으로 맞춰 봄
  if (name === '500') {
    D[T8] = { name: T8, state: 'active', cpu: 2, mem: 8, disk: 10 };
    r = await st.labSnapshotPrepare('admin', SPEC);
    check('500 뒤 나중에 보이면 → ready, POST 여전히 한 번', r.snapshotReady === true && posts.length === 1, J(r));
  }
  if (name === '시간 초과') {
    H.post = undefined;
    for (const [later, label] of [[46 * 60e3, '46분'], [3 * 24 * 3600e3, '3일']]) {
      skew = later;
      r = await st.labSnapshotPrepare('admin', SPEC);
      check(`시간 초과: ${label} 뒤에도 404 → 확인 못 함, 기록 그대로, 다시 POST 안 함`, r.status === 409 && posts.length === 1 && storage.m.get(`snapjob:${T8}`)?.phase === 'uncertain', J(r));
    }
    const restarted = await make(storage);
    r = await restarted.st.labCreate('admin', V);
    check('시간 초과: 3일 뒤 재시작해도 POST·수업 없음', r.status === 409 && posts.length === 1 && noLab(), J(r));
    r = await restarted.st.labSnapshotPrepare('admin', { ...SPEC, memory: 4 });
    check('시간 초과: 풀리지 않은 기록이 있으면 다른 사양도 POST 안 함 (한 DO 에 하나)', r.status === 409 && /아직 끝나지 않았습니다/.test(r.error) && posts.length === 1, J(r));
    // 운영자가 Daytona 에서 확인하고 lab/snapshot.ps1 로 만듦 → 다음 GET 이 기록을 푼다
    D[T8] = { name: T8, state: 'active', cpu: 2, mem: 8, disk: 10 };
    r = await restarted.st.labSnapshotPrepare('admin', SPEC);
    check('시간 초과: 운영자가 만든 뒤 → ready, 기록 풀림, POST 여전히 한 번', r.snapshotReady === true && jobs(storage).length === 0 && posts.length === 1, J(r));
  }
}

console.log('확실한 응답의 POST');
{
  const org = '7d8b7740-cc0e-4a00-b84b-c884af823a60';
  const spec9 = { ...SPEC, cpu: 4, memory: 9, disk: 10 };
  reset();
  H.get = n => n === 'gw-lab-v4-1c2g' ? jr(source({ organizationId: org })) : defaultGet(n);
  H.usage = () => jr({ regionUsage: [{ regionId: 'us', sandboxClass: 'container', totalCpuQuota: 100, totalMemoryQuota: 200, totalDiskQuota: 300, maxCpuPerSandbox: null, maxMemoryPerSandbox: null, maxDiskPerSandbox: null }] });
  let { st, storage } = await make();
  let r = await st.labSnapshotPrepare('admin', spec9);
  check('200GiB 조직 전체 용량과 별개로 기본 개별 8GiB 초과를 POST 전에 거부', r.status === 422 && /메모리 상한은 8 GiB/.test(r.error) && /요청 9 GiB/.test(r.error) && posts.length === 0 && jobs(storage).length === 0 && noLab() && clean(r), J(r));
  H.usage = () => jr({ regionUsage: [{ sandboxClass: 'container', totalCpuQuota: 100, maxCpuPerSandbox: 8, maxMemoryPerSandbox: 16, maxDiskPerSandbox: 20 }] });
  r = await st.labSnapshotPrepare('admin', spec9);
  check('조직 개별 상한이 상향되면 9GiB 사양을 임의로 낮추거나 막지 않음', r.snapshotPreparing === true && posts.length === 1 && posts[0].memory === 9, J(r));
  reset();
  H.post = () => jr({ message: 'Memory request 9GB exceeds maximum allowed per sandbox (8GB).\n' + SECRET }, 400);
  ({ st, storage } = await make());
  r = await st.labSnapshotPrepare('admin', spec9);
  check('정책 조회가 없을 때 실제 400의 숫자 상한만 번역, 본문·비밀은 숨김', r.status === 422 && /8 GiB/.test(r.error) && /9 GiB/.test(r.error) && jobs(storage).length === 0 && clean(r), J(r));
  reset();
  H.post = () => jr({ message: 'Memory request 99GB exceeds maximum allowed per sandbox (8GB).\n' + SECRET }, 400);
  ({ st } = await make());
  r = await st.labSnapshotPrepare('admin', spec9);
  check('요청 숫자가 실제 입력과 다르면 공급자 문자열을 신뢰해 번역하지 않음', r.status === 409 && clean(r) && !r.error.includes('99'), J(r));
}
{
  reset();
  H.post = (b) => { D[b.name] = { name: b.name, state: 'building', cpu: 2, mem: 8, disk: 10 }; return jr({ message: 'already exists ' + SECRET }, 409); };
  let { st, storage } = await make();
  let r = await st.labSnapshotPrepare('admin', SPEC);
  check('409 (이미 있음) → 준비 중, GET 으로 맞춰 봄', J(r) === pendingOf('requested') && storage.m.get(`snapjob:${T8}`)?.phase === 'posted', J(r));
  r = await st.labSnapshotPrepare('admin', SPEC);
  check('409 뒤 다시 물음 → building, POST 한 번', J(r) === pendingOf('building') && posts.length === 1);

  reset();
  H.post = () => jr({ message: 'bad ' + SECRET }, 400);
  ({ st, storage } = await make());
  r = await st.labSnapshotPrepare('admin', SPEC);
  check('400 (받지 않음) → 409, 기록 지움, 본문 안 샘', r.status === 409 && /받지 않았습니다 \(Daytona 400\)/.test(r.error) && jobs(storage).length === 0 && clean(r), J(r));
  H.post = undefined;
  r = await st.labSnapshotPrepare('admin', SPEC);
  check('400 은 만들어지지 않은 것 → 다시 하면 POST (두 번째)', r.snapshotPreparing === true && posts.length === 2, J(r));

  reset();
  H.get = (n) => (n === T8 ? jr({ message: SECRET }, 503) : defaultGet(n));
  ({ st, storage } = await make());
  r = await st.labSnapshotPrepare('admin', SPEC);
  check('목표 GET 503 (기록 없음) → 409 확인 못 함, 원본·POST 없음', r.status === 409 && /Daytona 503/.test(r.error) && J(providerCalls()) === J([`GET ${T8}`]) && clean(r), J(r));
  reset();
  H.get = (n, init) => (n === T8 ? hang(init) : defaultGet(n));
  ({ st, storage } = await make());
  r = await st.labSnapshotPrepare('admin', SPEC);
  check('목표 GET 시간 초과 → 기한 안에 409', r.status === 409 && /확인하지 못했습니다\./.test(r.error) && posts.length === 0, J(r));
}

console.log('재시작: 기록이 남아 있으면 다시 POST 하지 않음');
{
  reset();
  const storage = memStorage();
  // POST 직전·중에 DO 가 죽은 경우: posting 기록만 남음
  storage.m.set(`snapjob:${T8}`, { base: 'gw-lab-v4', cpu: 2, memory: 8, disk: 10, phase: 'posting', at: Date.now() });
  let { st } = await make(storage);
  let r = await st.labSnapshotPrepare('admin', SPEC);
  check('새 인스턴스 + posting 기록 + GET 404 → 준비 중 checking, POST 없음', J(r) === pendingOf('checking') && posts.length === 0, J(r));
  skew = 2 * 60e3;
  r = await st.labCreate('admin', V);
  check('기다림 지나도 404 → 확인 못 함 409, POST·수업 없음', r.status === 409 && posts.length === 0 && noLab(), J(r));
  skew = 30 * 24 * 3600e3;
  ({ st } = await make(storage));
  r = await st.labSnapshotPrepare('admin', SPEC);
  check('30일 뒤 재시작 + 404 → 여전히 확인 못 함, posting 기록 그대로, POST 없음', r.status === 409 && posts.length === 0 && storage.m.get(`snapjob:${T8}`)?.phase === 'posting', J(r));
  D[T8] = { name: T8, state: 'building', cpu: 2, mem: 8, disk: 10 };
  ({ st } = await make(storage));
  r = await st.labSnapshotPrepare('admin', SPEC);
  check('또 재시작 + 공급자에 보이면 → building, POST 없음 (브라우저를 닫아도 공급자에서 계속)', J(r) === pendingOf('building') && posts.length === 0, J(r));
  D[T8].state = 'active';
  r = await st.labSnapshotPrepare('admin', SPEC);
  check('→ ready', r.snapshotReady === true && jobs(storage).length === 0);
}

console.log('같은 목표가 모르는·이상한 상태여도 기록을 풀지 않음 → 재시작 뒤 404 여도 다시 POST 없음');
for (const [label, meta] of [['모르는 상태', { name: T8, state: 'weird', cpu: 2, mem: 8, disk: 10 }], ['removing', { name: T8, state: 'removing' }], ['상태 없음', { name: T8 }], ['배열 응답', [1]], ['상태 숫자', { state: 7 }]]) {
  reset();
  const storage = memStorage();
  let { st } = await make(storage);
  let r = await st.labSnapshotPrepare('admin', SPEC);
  check(`${label}: 처음 POST 한 번`, r.snapshotPreparing === true && posts.length === 1, J(r));
  D[T8] = meta;
  r = await st.labSnapshotPrepare('admin', SPEC);
  check(`${label}: 같은 목표 → 409, 기록 그대로`, r.status === 409 && storage.m.get(`snapjob:${T8}`)?.phase === 'posted' && clean(r), J(r));
  delete D[T8];
  skew = 7 * 24 * 3600e3;
  ({ st } = await make(storage));
  r = await st.labCreate('admin', V);
  check(`${label}: 7일 뒤 재시작 + 404 → 확인 못 함 409, POST 한 번 그대로, 수업 없음`, r.status === 409 && /자동으로 다시 요청하지 않습니다/.test(r.error) && posts.length === 1 && noLab() && jobs(storage).length === 1, J(r));
}

console.log('기본 세 가지는 예전 경로 (스냅샷 조회·POST 없음)');
for (const [c, m, d, want] of [[1, 2, 5, 'gw-lab-v4-1c2g'], [2, 4, 5, 'gw-lab-v4-2c4g'], [4, 8, 10, 'gw-lab-v4-4c8g']]) {
  reset();
  H.sandboxes = [];
  const { st, storage } = await make();
  const r = await st.labCreate('admin', { ...V, cpu: c, memory: m, disk: d });
  check(`${c}/${m}/${d}: ok, /snapshots 호출·snapjob 없음, 본문 ${want}`, r.ok === true && !ev.some((e) => /^(GET|POST) gw-lab/.test(e)) && jobs(storage).length === 0 && H.sandboxes.every((b) => b.snapshot === want), J(ev));
}

console.log('lab-api: /api/lab/create · /api/lab/snapshot 응답 상태');
{
  const calls = [];
  const replies = { create: null, snap: null };
  const stub = {
    labCreate: async (admin, b) => { calls.push(['create', admin, b]); return replies.create; },
    labSnapshotPrepare: async (admin, b) => { calls.push(['snap', admin, b]); return replies.snap; },
  };
  const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  const out = (r) => (r && typeof r === 'object' && 'error' in r && 'status' in r ? json({ error: r.error }, r.status) : json(r));
  const ctxOf = (path, body) => ({ req: { body }, path, env: {}, state: stub, src: '', admin: 'tok-h', body: async (req) => req.body, json, out });
  const call = async (path, body) => { const res = await API.labApi(ctxOf(path, body)); return { status: res.status, j: await res.json() }; };
  const P = { snapshotPreparing: true, snapshot: T8, state: 'requested', retryAfterMs: 5000 };

  replies.snap = { ...P, extra: SECRET };
  let r = await call('/api/lab/snapshot', { snapshot: 'gw-lab-v4', cpu: 2, memory: 8, disk: 10, dockerfile: 'FROM evil', imageName: 'evil', env: { A: 1 }, url: 'https://evil' });
  check('snapshot: 준비 중 → 202, 고정 모양만 (그 밖의 필드 안 실음)', r.status === 202 && J(r.j) === J(P), J(r));
  check('snapshot: State 에는 x-admin-token 과 네 칸만', J(calls.at(-1)) === J(['snap', 'tok-h', { snapshot: 'gw-lab-v4', cpu: 2, memory: 8, disk: 10 }]), J(calls.at(-1)));
  replies.snap = { snapshotReady: true, snapshot: T8 };
  r = await call('/api/lab/snapshot', SPEC);
  check('snapshot: ready → 200', r.status === 200 && r.j.snapshotReady === true);
  replies.snap = { status: 401, error: '관리 세션이 만료됐습니다.' };
  r = await call('/api/lab/snapshot', SPEC);
  check('snapshot: Fail → 그 상태', r.status === 401 && J(r.j) === J({ error: '관리 세션이 만료됐습니다.' }));
  replies.create = P;
  r = await call('/api/lab/create', V);
  check('create: 준비 중 → 202', r.status === 202 && J(r.j) === J(P), J(r));
  replies.create = { snapshotPreparing: 'yes', snapshot: T8 };
  r = await call('/api/lab/create', V);
  check('create: snapshotPreparing 가 true 가 아니면 202 아님', r.status === 200);
  replies.create = { status: 409, error: 'x' };
  r = await call('/api/lab/create', V);
  check('create: Fail → 409', r.status === 409);
  replies.create = { ok: true, lab: { id: 'l' } };
  r = await call('/api/lab/create', V);
  check('create: 성공 → 200 그대로', r.status === 200 && r.j.ok === true);
  check('/api/lab 그 자체는 새 경로 아님 (null)', API.labApi(ctxOf('/api/lab', {})) === null);
}

check('가짜 밖 주소 호출 없음', outbound.length === 0, outbound.join(' '));
console.log(`\n${pass} ok, ${failN} fail`);
process.exit(failN ? 1 : 0);
