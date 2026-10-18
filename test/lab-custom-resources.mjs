// 실습실 사양 직접 입력 회귀 테스트 (네트워크·진짜 Daytona/OpenRouter·비밀 값 없음).
//   1) 순수 함수: 사양 한 항목 확인(lab-resources.ts), 스냅샷 이름 규칙(기본 세 가지 <이름>-<c>c<m>g, 그 밖 <이름>-<c>c<m>g<d>d),
//      labCreateInput 오류 순서, labSandboxBody 의 snapshot
//   2) 진짜 State(esbuild 번들, 가짜 ctx·fetch): 직접 입력 사양은 저장·서브키·샌드박스 전에 GET /snapshots/<이름> 으로 확인,
//      사양 다름·inactive·공급자 오류·(원본까지) 없음은 아무것도 만들지 않고 409 (본문·키 없음). 기본 사양은 예전 경로(조회 없음)
//   3) /lab 화면 (설치된 Edge headless, 요청은 전부 route 로 흉내 — 바깥 호출 없음. Edge 가 없으면 skip)
//   node test/lab-custom-resources.mjs   [--no-browser]
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { build } from 'esbuild';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const cfStub = { name: 'cf-stub', setup(b) {
  b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'cf', namespace: 'cf-stub' }));
  b.onLoad({ filter: /.*/, namespace: 'cf-stub' }, () => ({ contents: 'export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }', loader: 'js' }));
} };
async function load(entry, name) {
  const out = await build({ entryPoints: [join(ROOT, entry)], bundle: true, write: false, format: 'esm', platform: 'node', loader: { '.ps1': 'text' }, plugins: [cfStub], logLevel: 'silent' });
  const dir = mkdtempSync(join(tmpdir(), 'lab-custom-res-'));
  writeFileSync(join(dir, name), out.outputFiles[0].text);
  try { return await import(pathToFileURL(join(dir, name)).href); } finally { rmSync(dir, { recursive: true, force: true }); }
}

let pass = 0, failN = 0, skipN = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { failN++; console.log(`  FAIL ${name} ${String(extra).slice(0, 400)}`); }
};
const tick = () => new Promise((r) => setTimeout(r, 0));
const J = JSON.stringify;

const R = await load('src/lab-resources.ts', 'res.mjs');
const LS = await load('src/lab-setup.ts', 'setup.mjs');

// ── 1. 순수 함수 ──
console.log('사양 한 항목 (labResourceInt)');
{
  const good = [[1, 1], [8, 8], ['8', 8], ['10', 10], [2147483647, 2147483647], ['2147483647', 2147483647]];
  for (const [v, want] of good) check(`받음 ${J(v)} → ${want}`, R.labResourceInt(v) === want, R.labResourceInt(v));
  const bad = [0, -1, 1.5, 2147483648, NaN, Infinity, -Infinity, true, false, null, undefined, [2], {}, '', '0', '-1', '+1', '1e1', '1E1', '2.0', '1.5', ' 2', '2 ', '2\n', '\n2', '2\r\n', '2\r', '\r\n2', '2\n3', '0x10', '08', '2147483648', '99999999999', 'Infinity', 'NaN', '１'];
  for (const v of bad) check(`거부 ${typeof v === 'number' ? String(v) : J(v) ?? String(v)}`, R.labResourceInt(v) === null, R.labResourceInt(v));
  check('labResourcesOf: 하나라도 틀리면 null', R.labResourcesOf({ cpu: 2, memory: '8', disk: true }) === null && J(R.labResourcesOf({ cpu: 2, memory: '8', disk: 10 })) === J({ cpu: 2, memory: 8, disk: 10 }));
}

console.log('스냅샷 이름 규칙');
{
  const name = (c, m, d) => R.labSnapshotName('base', { cpu: c, memory: m, disk: d });
  const table = [[1, 2, 5, 'base-1c2g'], [2, 4, 5, 'base-2c4g'], [4, 8, 10, 'base-4c8g'],
    [2, 8, 10, 'base-2c8g10d'], [2, 4, 10, 'base-2c4g10d'], [1, 2, 10, 'base-1c2g10d'], [4, 8, 5, 'base-4c8g5d'], [2, 2, 5, 'base-2c2g5d']];
  for (const [c, m, d, want] of table) check(`${c}/${m}/${d} → ${want}`, name(c, m, d) === want, name(c, m, d));
  check('저장된 예전 수업에 disk 없음 → 예전 이름', R.labSnapshotName('base', { cpu: 2, memory: 8 }) === 'base-2c8g');
  check('기본 세 가지 판정', R.labIsPreset({ cpu: 4, memory: 8, disk: 10 }) && !R.labIsPreset({ cpu: 4, memory: 8, disk: 11 }));
}

console.log('스냅샷 정보 맞춰 보기 (labSnapshotFits)');
{
  const r = { cpu: 2, memory: 8, disk: 10 };
  const f = (m) => R.labSnapshotFits(m, r);
  check('active + 같은 정수 → ok', f({ state: 'active', cpu: 2, mem: 8, disk: 10 }) === 'ok');
  check('memory 필드도 받음', f({ state: 'active', cpu: 2, memory: 8, disk: 10 }) === 'ok');
  check('mem·memory 둘 다 같으면 ok', f({ state: 'active', cpu: 2, mem: 8, memory: 8, disk: 10 }) === 'ok');
  check('mem 맞고 memory 다르면 mismatch', f({ state: 'active', cpu: 2, mem: 8, memory: 4, disk: 10 }) === 'mismatch');
  check('mem 다르고 memory 맞으면 mismatch', f({ state: 'active', cpu: 2, mem: 4, memory: 8, disk: 10 }) === 'mismatch');
  check('mem·memory 둘 다 없으면 mismatch', f({ state: 'active', cpu: 2, disk: 10 }) === 'mismatch');
  check('active 아님 → inactive', f({ state: 'building', cpu: 2, mem: 8, disk: 10 }) === 'inactive' && f({ cpu: 2, mem: 8, disk: 10 }) === 'inactive');
  for (const m of [{ state: 'active', cpu: 2, mem: 4, disk: 10 }, { state: 'active', cpu: '2', mem: 8, disk: 10 }, { state: 'active', cpu: 2, mem: 8 },
    { state: 'active', cpu: 2, mem: 8.0000001, disk: 10 }, { state: 'active', cpu: 2, mem: NaN, disk: 10 }, null, [], 'x'])
    check(`다름 → mismatch ${J(m)}`, f(m) === 'mismatch', f(m));
}

console.log('labCreateInput (사양 확인 자리·순서 그대로)');
{
  const rules = { maxSeats: 20, hours: [1, 2, 3], budgets: [1, 2], defaults: { snapshot: 'gw-lab-v4', model: 'm/x' }, allowShortTtl: false, devHttp: false, today: () => '2026-10-02' };
  const V = { seats: 2, hours: 1, budget: 1, cpu: 2, memory: 8, disk: 10, gw: 'https://gw-x.workers.dev', snapshot: 'gw-lab-v4', model: 'm/x' };
  const err = (p) => { const v = LS.labCreateInput({ ...V, ...p }, rules); return 'error' in v ? v.error : null; };
  check('직접 입력 2/8/10 통과', err({}) === null);
  check('숫자 문자열 "2"/"8"/"10" 통과, 숫자로', (() => { const v = LS.labCreateInput({ ...V, cpu: '2', memory: '8', disk: '10' }, rules); return v.cpu === 2 && v.memory === 8 && v.disk === 10; })());
  for (const p of [{ cpu: true }, { memory: [8] }, { disk: {} }, { disk: '1e1' }, { cpu: '2.0' }, { cpu: ' 2' }, { cpu: '2\n' }, { cpu: '2\r\n' }, { disk: '10\r' }, { cpu: 0 }, { cpu: -2 }, { disk: 2147483648 }, { memory: NaN }])
    check(`사양 거부 ${J(p)}`, err(p) === '사양이 올바르지 않습니다.', err(p));
  const spec = { seats: 2, hours: 1, budget: 1, cpu: 2, memory: 8, disk: 10 };
  check('labNumbersError 도 같은 확인 (상한 넘음·0·소수 직접 넣어도 거부)', LS.labNumbersError(spec, rules) === null
    && [{ cpu: 2147483648 }, { memory: 0 }, { disk: 1.5 }, { cpu: -1 }].every((p) => LS.labNumbersError({ ...spec, ...p }, rules) === '사양이 올바르지 않습니다.'));
  check('인원이 먼저 (사양도 틀렸을 때)', err({ seats: 0, cpu: true }) === '인원은 1~20명');
  check('사양이 게이트웨이보다 먼저', err({ cpu: true, gw: 'ftp://x' }) === '사양이 올바르지 않습니다.');
  check('직접 입력: 붙인 이름이 120자 넘으면 이름 오류', err({ snapshot: 's'.repeat(113) }) === '스냅샷·모델 이름이 올바르지 않습니다.' && err({ snapshot: 's'.repeat(112) }) === null && `${'s'.repeat(112)}-2c8g10d`.length === 120);
  check('기본 사양: 스냅샷 120자 그대로 통과 (예전 규칙)', err({ cpu: 1, memory: 2, disk: 5, snapshot: 's'.repeat(120) }) === null);
  check('스냅샷 이름 줄바꿈 거부', err({ snapshot: 'a\nb' }) === '스냅샷·모델 이름이 올바르지 않습니다.' && err({ snapshot: 'ab\n' }) === null /* trim 뒤 'ab' */);
}

console.log('labSandboxBody snapshot');
{
  const lab = (cpu, memory, disk) => ({ id: 'L', name: 'n', expiresAt: Date.now() + 3600e3, budget: 1, cpu, memory, disk, snapshot: 'base', model: 'm', gw: 'https://gw' });
  const sn = (l) => LS.labSandboxBody(l, 1, 'tok', 'or', 1, []).snapshot;
  check('기본 1/2/5 → base-1c2g', sn(lab(1, 2, 5)) === 'base-1c2g');
  check('기본 4/8/10 → base-4c8g', sn(lab(4, 8, 10)) === 'base-4c8g');
  check('직접 2/8/10 → base-2c8g10d', sn(lab(2, 8, 10)) === 'base-2c8g10d');
  check('직접 2/4/10 → base-2c4g10d', sn(lab(2, 4, 10)) === 'base-2c4g10d');
  const { disk: _d, ...old } = lab(2, 4, 5);
  check('disk 없는 저장된 수업 → 예전 이름', sn(old) === 'base-2c4g');
}

// ── 2. 진짜 State (가짜 ctx·fetch) ──
const ev = [];        // 'put <key>' · '<METHOD> <path>' · 'mint' — 지금 인스턴스(CUR)의 것만
// 앞 인스턴스의 자리 미리 준비(#prep)·생성자 migrateGrants 는 계속 돌 수 있다 → 인스턴스마다 Daytona 주소(/i<n>)·저장소를 따로 두고,
// 지금 인스턴스의 호출·쓰기만 센다 (순서 확인은 그대로 엄격하게)
let CUR = 0, CUR_STORAGE = null, seq = 0;
const outbound = [];
const H = { snap: null, made: 0 };
const jr = (x, status = 200) => new Response(JSON.stringify(x), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (input, init = {}) => {
  const u = new URL(typeof input === 'string' ? input : input.url);
  const method = init.method ?? 'GET';
  if (u.host === 'dt.fake') {
    const [, inst, path] = u.pathname.match(/^\/i(\d+)(\/.*)$/) ?? [, '0', u.pathname];
    const mine = Number(inst) === CUR;
    if (!mine) return jr({ id: 'x', state: 'creating' }); // 앞 인스턴스: 응답만 (스냅샷·샌드박스 만들기 흉내 안 함)
    ev.push(`${method} ${path}`);
    if (path.startsWith('/snapshots/')) return H.snap(decodeURIComponent(path.slice('/snapshots/'.length)), { pathname: path });
    if (path === '/sandbox' && method === 'POST') { H.bodies.push(JSON.parse(init.body)); return jr({ id: `sbm-${++H.made}`, state: 'creating' }); }
    return jr({ id: 'x', state: 'creating' });
  }
  outbound.push(`${method} ${u.href}`);
  return jr({ error: 'blocked' }, 503);
};
function memStorage() {
  const m = new Map();
  let alarm = null;
  const c = (v) => (v === undefined ? v : structuredClone(v));
  const log = (x) => { if (s === CUR_STORAGE) ev.push(x); };
  const s = {
    m,
    async get(k) { await tick(); if (Array.isArray(k)) { const r = new Map(); for (const x of k) if (m.has(x)) r.set(x, c(m.get(x))); return r; } return c(m.get(k)); },
    async put(k, v) { await tick(); if (typeof k === 'object') { for (const [a, b] of Object.entries(k)) { log(`put ${a}`); m.set(a, c(b)); } } else { log(`put ${k}`); m.set(k, c(v)); } },
    async delete(k) { await tick(); const ks = Array.isArray(k) ? k : [k]; let n = 0; for (const x of ks) if (m.delete(x)) n++; return Array.isArray(k) ? n : n > 0; },
    async list({ prefix = '' } = {}) { await tick(); return new Map([...m.keys()].filter((x) => x.startsWith(prefix)).sort().map((x) => [x, c(m.get(x))])); },
    async getAlarm() { return alarm; },
    async setAlarm(t) { log('alarm'); alarm = t; },
    async transaction(f) { const prev = s.q; let done; s.q = new Promise((r) => { done = r; }); await prev; try { return await f(s); } finally { done(); } },
    q: Promise.resolve(),
  };
  return s;
}
const S = await load('src/state.ts', 'state.mjs');
async function make() {
  const storage = memStorage();
  const ctx = { storage, waitUntil: () => {}, blockConcurrencyWhile: (f) => f() };
  const id = ++seq;
  class T extends S.State {
    async daytona() { return { api: `https://dt.fake/i${id}`, key: 'fx-daytona-key' }; }
    async checkAdmin(token) { return token === 'admin'; }
    async labShareInput() { return { share: {}, defs: [] }; }
    async listProviders() { return [{ id: 'or', kind: 'openrouter-mint' }]; }
    async modelExists() { return true; }
    async newSession() { if (id === CUR) ev.push('mint'); return { sid: `S${Math.random().toString(36).slice(2, 10)}`, token: 'tok' }; }
    async endSession() {}
    async audit() {}
  }
  const st = new T(ctx, { LAB_SEAT_DOMAIN: 'seat.fake', LAB_ORIGIN: 'https://lab.fake' });
  // 생성자의 migrateGrants 가 끝난 뒤부터 이 인스턴스를 센다
  for (let i = 0; i < 200 && !storage.m.has('mig:grants'); i++) await new Promise((r) => setTimeout(r, 5));
  storage.m.delete('mig:grants');
  CUR = id; CUR_STORAGE = storage; ev.length = 0;
  return { st, storage };
}
const reset = (snap) => { ev.length = 0; H.bodies = []; H.made = 0; H.snap = snap; };
const V = { name: '사양', seats: 2, hours: 1, budget: 1, cpu: 2, memory: 8, disk: 10, gw: 'https://gw-x.workers.dev', snapshot: 'gw-lab-v4', model: 'deepseek/deepseek-v4.1-flash' };
const nothingMade = (storage) => !ev.some((e) => e.startsWith('put ') || e === 'mint' || e === 'alarm' || e === 'POST /sandbox') && storage.m.size === 0;
const SECRET = 'sk-or-SECRET-body-zzzzzzzz';

console.log('State.labCreate — 직접 입력 사양');
{
  reset(() => { throw new Error('호출되면 안 됨'); });
  let { st, storage } = await make();
  let r = await st.labCreate('bad', V);
  check('관리 토큰 틀림 → 401, 바깥 호출·저장 없음', r.status === 401 && ev.length === 0 && storage.m.size === 0, J(r) + J(ev));
  r = await st.labCreate('admin', { ...V, cpu: true });
  check('사양 true → 400, 조회 없음', r.status === 400 && ev.length === 0, J(r));

  // 자동 준비(lab-snapshot-service.ts)가 생긴 뒤: 없음 → 원본(-1c2g)까지 확인. 원본도 없으면 POST 없이 409. 만드는 중·준비 성공은 test/lab-snapshot-auto.mjs
  const ONE = ['GET /snapshots/gw-lab-v4-2c8g10d'], TWO = [...ONE, 'GET /snapshots/gw-lab-v4-1c2g'];
  const cases = [
    ['스냅샷·원본 모두 없음 (404)', () => jr({ message: `not found ${SECRET}` }, 404), /원본 스냅샷 gw-lab-v4-1c2g 이 Daytona 에 없어/, TWO],
    ['사양 다름 (mem 4)', (n) => jr({ name: n, state: 'active', cpu: 2, mem: 4, disk: 10 }), /사양이 2 vCPU · 8 GiB · 디스크 10 GiB 와 다릅니다/, ONE],
    ['disk 문자열 "10" → 다름', (n) => jr({ name: n, state: 'active', cpu: 2, mem: 8, disk: '10' }), /다릅니다/, ONE],
    ['inactive', (n) => jr({ name: n, state: 'inactive', cpu: 2, mem: 8, disk: 10 }), /active/, ONE],
    ['공급자 오류 500 (본문에 비밀 모양)', () => jr({ message: SECRET }, 500), /확인하지 못했습니다 \(Daytona 500\)/, ONE],
    ['연결 실패 (fetch throw)', () => { throw new TypeError('network down ' + SECRET); }, /확인하지 못했습니다\./, ONE],
  ];
  for (const [name, snap, re, calls] of cases) {
    reset(snap);
    ({ st, storage } = await make());
    r = await st.labCreate('admin', V);
    check(`${name} → 409 문구`, r.status === 409 && re.test(r.error), J(r));
    check(`${name}: 응답에 공급자 본문·키 없음`, !J(r).includes(SECRET) && !J(r).includes('fx-daytona-key'), J(r));
    check(`${name}: GET 만 ${calls.length}번 — labcfg·수업·자리·알람·서브키·샌드박스 없음`, J(ev) === J(calls) && nothingMade(storage), J(ev));
  }

  reset((n) => jr({ id: 'snap-1', name: n, state: 'active', cpu: 2, mem: 8, disk: 10 }));
  ({ st, storage } = await make());
  r = await st.labCreate('admin', V);
  check('맞는 스냅샷 → ok', r.ok === true && r.lab.seats.length === 2, J(r).slice(0, 300));
  const iSnap = ev.indexOf('GET /snapshots/gw-lab-v4-2c8g10d');
  const firstSide = ev.findIndex((e) => e.startsWith('put ') || e === 'mint' || e === 'POST /sandbox');
  check('조회가 저장·서브키·샌드박스보다 먼저', iSnap === 0 && firstSide > iSnap && ev.indexOf('put labcfg') > iSnap, J(ev));
  check('샌드박스 본문 두 자리 모두 snapshot gw-lab-v4-2c8g10d', H.bodies.length === 2 && H.bodies.every((b) => b.snapshot === 'gw-lab-v4-2c8g10d'), J(H.bodies.map((b) => b.snapshot)));
  const lab = storage.m.get(`lab:${r.lab.id}`);
  check('저장된 수업 cpu/memory/disk 숫자', lab.cpu === 2 && lab.memory === 8 && lab.disk === 10, J(lab));
  check('labcfg 에는 기본 이름만', storage.m.get('labcfg').snapshot === 'gw-lab-v4');
  const oldLab = structuredClone(lab);
  const migratedCfg = await st.labConfig('admin');
  check('저장된 v4 설정은 다음 수업 기본 v5로 안내', migratedCfg.cfg?.snapshot === 'gw-lab-v5', J(migratedCfg.cfg));
  check('기본 안내를 바꿔도 진행 중인 수업·자리의 v4 스냅샷 유지', J(storage.m.get(`lab:${r.lab.id}`)) === J(oldLab)
    && storage.m.get(`lab:${r.lab.id}`).snapshot === 'gw-lab-v4');
  storage.m.set('labcfg', { ...storage.m.get('labcfg'), snapshot: 'gw-lab-v4-diag-20261006' });
  const customCfg = await st.labConfig('admin');
  check('직접 고른 진단 스냅샷 설정은 유지', customCfg.cfg?.snapshot === 'gw-lab-v4-diag-20261006', J(customCfg.cfg));

  // 이름은 encodeURIComponent 로 경로 한 칸
  let seen = null;
  reset((n, u) => { seen = u.pathname; return jr({ state: 'active', cpu: 3, mem: 6, disk: 20 }); });
  ({ st, storage } = await make());
  r = await st.labCreate('admin', { ...V, cpu: '3', memory: '6', disk: '20', snapshot: 'org/img:v1' });
  check('스냅샷 이름 / · : 는 인코딩된 한 칸 (/snapshots/org%2Fimg%3Av1-3c6g20d)', r.ok === true && seen === '/snapshots/org%2Fimg%3Av1-3c6g20d', seen);
  check('숫자 문자열 사양 → 같은 본문', H.bodies.every((b) => b.snapshot === 'org/img:v1-3c6g20d'));

  reset((n) => jr({ state: 'active', cpu: 2, mem: 4, disk: 10 }));
  ({ st, storage } = await make());
  r = await st.labCreate('admin', { ...V, memory: 4 });
  check('2/4/10 → gw-lab-v4-2c4g10d 로 조회·생성', r.ok === true && ev[0] === 'GET /snapshots/gw-lab-v4-2c4g10d' && H.bodies.every((b) => b.snapshot === 'gw-lab-v4-2c4g10d'), J(ev));
}

console.log('State.labCreate — 기본 세 가지는 예전 경로');
for (const [c, m, d, want] of [[1, 2, 5, 'gw-lab-v4-1c2g'], [2, 4, 5, 'gw-lab-v4-2c4g'], [4, 8, 10, 'gw-lab-v4-4c8g']]) {
  reset(() => { throw new Error('기본 사양은 조회하지 않음'); });
  const { st } = await make();
  const r = await st.labCreate('admin', { ...V, cpu: c, memory: m, disk: d });
  check(`${c}/${m}/${d}: 조회 없이 ok, 본문 ${want}`, r.ok === true && !ev.some((e) => e.includes('/snapshots')) && H.bodies.length === 2 && H.bodies.every((b) => b.snapshot === want), J(ev));
}
check('가짜 밖 주소 호출 없음', outbound.length === 0, outbound.join(' '));

// ── 3. /lab 화면 ──
console.log('/lab 화면 (Edge headless, route 흉내)');
if (process.argv.includes('--no-browser')) { skipN++; console.log('  skip --no-browser'); }
else {
  let chromium, browser;
  try { ({ chromium } = await import('playwright-core')); browser = await chromium.launch({ channel: 'msedge', headless: true }); }
  catch (e) { skipN++; console.log(`  skip Edge 없음 (${String(e.message).split('\n')[0]})`); }
  if (browser) {
    try { await ui(browser); } finally { await browser.close(); }
  }
}

async function ui(browser) {
  const { labPage, WEBAUTHN_JS } = await import(new URL('../src/pages.ts', import.meta.url).href);
  const ORIGIN = 'http://localhost:8799', TOKEN = 'adm-res-' + randomBytes(6).toString('hex');
  const b64u = (b) => Buffer.from(b).toString('base64url');
  const creates = [], external = [], teacher = [], unknown = [];
  let logins = 0;
  // 강사 앱 머리의 manifest·아이콘 (브라우저가 스스로 받을 수 있다). 이 둘만 GET 404 로 받고 나머지 모르는 경로는 그대로 실패로 센다
  const TEACHER_HEAD = new Set(['/__teacher/manifest.webmanifest', '/__teacher/icon-192.png']);
  let snapCfg = 'gw-lab-v4';
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  let credId;
  await ctx.route('**/*', async (route) => {
    const req = route.request(), u = new URL(req.url());
    if (u.origin !== ORIGIN) { external.push(req.url()); return route.abort('blockedbyclient'); }
    const p = u.pathname, json = (o, status = 200) => route.fulfill({ status, contentType: 'application/json', body: J(o) });
    let body; try { body = req.postDataJSON(); } catch { body = null; }
    if (p === '/lab') return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: labPage() });
    if (p === '/webauthn.js') return route.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: WEBAUTHN_JS });
    if (p === '/api/admin/options') return json({ challenge: b64u(randomBytes(32)), rpId: 'localhost', allowCredentials: [{ type: 'public-key', id: credId }], userVerification: 'preferred', timeout: 60000 });
    // 관리 토큰은 진짜처럼 10분 (서버 시계 = 이 PC 시계)
    if (p === '/api/admin/login') { logins++; return json({ token: TOKEN, expiresAt: Date.now() + 600000 }); }
    if (req.method() === 'GET' && TEACHER_HEAD.has(p)) return route.fulfill({ status: 404, body: '' });
    // 모니터 계약: 이 기기에 모니터 쿠키 없음(status 401), 모니터 세션은 만들지 못함(503) → 관리 토큰 화면만으로 돈다
    if (p === '/api/lab/teacher/status' || p === '/api/lab/teacher/session') {
      teacher.push({ p, method: req.method(), token: req.headers()['x-admin-token'] ?? null, body: req.postData() });
      return p.endsWith('/status') ? json({ error: '모니터 세션이 없습니다' }, 401) : json({ error: '모니터 세션을 만들 수 없습니다 (테스트)' }, 503);
    }
    if (req.headers()['x-admin-token'] !== TOKEN) return json({ error: 'no auth' }, 401);
    if (p === '/api/lab/config') return json({ labOrigin: 'https://lab.example.test', quota: { cpu: [0, 20], memory: [0, 40], disk: [0, 100] }, hours: [1, 2, 3], budgets: [1, 2, 5], daytona: true, openrouter: true, shareable: [], cfg: { gw: 'https://gw.example.test', snapshot: snapCfg, model: 'test/model', clip: { in: true, out: true }, share: {} } });
    if (p === '/api/lab/list') return json({ labs: [], quota: null, now: Date.now() });
    if (p === '/api/lab/create') { creates.push(body); return json({ error: '테스트: 만들지 않음' }, 409); }
    unknown.push(req.method() + ' ' + p);
    return json({ error: 'not mocked' }, 404);
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => { window.__pwn = 0; });
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'usb', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  const id = randomBytes(16);
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  await cdp.send('WebAuthn.addCredential', { authenticatorId, credential: { credentialId: id.toString('base64'), isResidentCredential: false, rpId: 'localhost', privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'), signCount: 0 } });
  credId = b64u(id);
  await page.goto(`${ORIGIN}/lab`);
  await page.click('#go');
  await page.waitForSelector('#panel:not([hidden])', { timeout: 15000 });
  await page.waitForFunction(() => document.querySelectorAll('#l_spec option').length === 4 && document.getElementById('l_snap').value !== '');
  if (!(await page.$eval('#newLab', (e) => e.open))) await page.click('#newLab > summary');
  const txt = (sel) => page.$eval(sel, (e) => e.textContent);
  const cls = (sel) => page.$eval(sel, (e) => e.className);
  const hidden = (sel) => page.$eval(sel, (e) => e.hidden);
  await page.fill('#l_seats', '5');

  check('처음: 첫 옵션 1/2/5, 직접 입력 칸 숨김', await page.$eval('#l_spec', (e) => e.value) === '1/2/5' && await hidden('#l_custom'));
  check('세 기본 옵션 그대로 + 직접 입력', J(await page.$$eval('#l_spec option', (o) => o.map((x) => x.value))) === J(['1/2/5', '2/4/5', '4/8/10', 'custom']));
  check('기본 1/2/5: 이름 gw-lab-v4-1c2g', (await txt('#l_snapname')) === '쓸 스냅샷: gw-lab-v4-1c2g', await txt('#l_snapname'));
  check('세 입력에 각각 라벨', J(await page.$$eval('#l_custom label', (l) => l.map((x) => `${x.htmlFor}:${x.textContent}`))) === J(['l_cpu:CPU (vCPU)', 'l_memory:메모리 (GiB)', 'l_disk:디스크 (GiB)']));

  await page.selectOption('#l_spec', 'custom');
  await page.fill('#l_cpu', '2'); await page.fill('#l_memory', '8'); await page.fill('#l_disk', '10');
  check('직접 입력 2/8/10: 칸 보임, 합계 10 vCPU · 40 GiB · 50 GiB', !(await hidden('#l_custom')) && (await txt('#l_total')).startsWith('이번 수업 10 vCPU · 40 GiB · 디스크 50 GiB'), await txt('#l_total'));
  check('직접 입력 2/8/10: 이름 gw-lab-v4-2c8g10d', (await txt('#l_snapname')) === '쓸 스냅샷: gw-lab-v4-2c8g10d');
  await page.fill('#l_memory', '9');
  check('남은 한도(40 GiB) 넘으면 경고', (await cls('#l_total')) === 'bad', await txt('#l_total'));
  await page.fill('#l_memory', '4');
  check('2/4/10 → gw-lab-v4-2c4g10d', (await txt('#l_snapname')) === '쓸 스냅샷: gw-lab-v4-2c4g10d');
  await page.click('#l_make');
  await page.waitForFunction(() => document.getElementById('l_msg').textContent.includes('만들지 못했습니다'));
  check('보낸 값은 숫자 2/4/10', creates.length === 1 && creates[0].cpu === 2 && creates[0].memory === 4 && creates[0].disk === 10, J(creates));

  // 화면의 확인 함수도 줄바꿈·CR 을 받지 않는다 (서버 labResourceInt 와 같게)
  const pageRes = await page.evaluate(() => ['2', '2\n', '2\r\n', '2\r', '\n2', '1e1', '2.0', '08', '2147483647', '2147483648'].map((v) => resInt(v)));
  check('화면 resInt: 줄바꿈·CR·지수·소수·앞 0·상한 넘음 거부', J(pageRes) === J([2, null, null, null, null, null, null, null, 2147483647, null]), J(pageRes));
  // 한 줄 입력칸은 브라우저가 값에서 줄바꿈을 지운다 (HTML 규칙) — 남는 '2' 는 올바른 값
  await page.$eval('#l_cpu', (e) => { e.value = '2\r\n'; e.dispatchEvent(new Event('input')); });
  check('입력칸에 "2\\r\\n" → 값은 "2" (브라우저가 지움), 합계 정상', await page.$eval('#l_cpu', (e) => e.value) === '2' && (await cls('#l_total')) !== 'bad', await txt('#l_total'));
  for (const bad of ['', '0', '1.5', '1e1', '-2', 'abc', ' 2', '2147483648', '08']) {
    await page.$eval('#l_cpu', (e, v) => { e.value = v; e.dispatchEvent(new Event('input')); }, bad);
    const t = await txt('#l_total');
    check(`CPU ${J(bad)}: NaN·이상한 합계 대신 안내`, t === 'CPU·메모리·디스크는 1 이상 정수(숫자만)로 적어 주세요.' && (await cls('#l_total')) === 'bad' && (await txt('#l_snapname')) === '', t);
  }
  await page.click('#l_make');
  await page.waitForFunction(() => document.getElementById('l_msg').textContent.includes('1 이상 정수'));
  check('틀린 직접 입력은 보내지 않음', creates.length === 1, J(creates));
  check('만들기 버튼 다시 켜짐', !(await page.$eval('#l_make', (e) => e.disabled)));

  await page.selectOption('#l_spec', '2/4/5');
  await page.click('#l_make');
  await page.waitForTimeout(300);
  check('기본 2/4/5 다시 고르면: 칸 숨김, 2/4/5 를 숫자로 보냄 (직접 입력 칸 값 무시)', await hidden('#l_custom') && creates.length === 2 && J([creates[1].cpu, creates[1].memory, creates[1].disk]) === J([2, 4, 5]), J(creates));
  check('기본 2/4/5: 이름 gw-lab-v4-2c4g (예전 그대로)', (await txt('#l_snapname')) === '쓸 스냅샷: gw-lab-v4-2c4g');

  // 스냅샷 칸의 적대적 문자열은 글자로만
  const HOST = '<img src=x onerror="window.__pwn=1"><script>window.__pwn=2</script>';
  await page.$eval('#l_snap', (e) => { e.closest('details').open = true; });
  await page.fill('#l_snap', HOST);
  await page.waitForTimeout(100);
  check('스냅샷 이름 표시는 textContent (요소·실행 없음)', (await txt('#l_snapname')) === `쓸 스냅샷: ${HOST}-2c4g` && await page.$eval('#l_snapname', (e) => e.children.length) === 0 && await page.evaluate(() => window.__pwn) === 0);
  check('페이지 오류 없음', errors.length === 0, errors.join(' | '));
  check('바깥 요청 없음', external.length === 0, external.join(' '));
  const st = teacher.filter((x) => x.p.endsWith('/status')), ses = teacher.filter((x) => x.p.endsWith('/session'));
  check('모니터 계약: 처음 상태 1번 (POST·빈 본문·관리 토큰 없음) + 로그인마다 세션 (POST·관리 토큰)', st.length === 1 && st[0].method === 'POST' && st[0].body === '{}' && st[0].token === null && logins === 1 && ses.length === 1 && ses[0].method === 'POST' && ses[0].token === TOKEN, J(teacher));
  check('흉내 안 된 요청 없음', unknown.length === 0, unknown.join(' '));
  await ctx.close();
}

console.log(`\n${pass} ok, ${failN} fail, ${skipN} skip`);
process.exit(failN ? 1 : 0);
