// 자리 미리 준비(P2) State 쪽 회귀 테스트. src/state.ts 를 설치된 esbuild 로 번들해 진짜 State 를 가짜 ctx(메모리 저장소)로 만든다.
// 공개 메서드(labCreate·labJoin·labRoute·labHand·labHandClear·alarm)와 끝내기(endLab)만 부른다 — 준비 도우미는 #private 라 밖에서 못 부른다:
//   - labCreate 뒤 미리 준비: who·opened·pv·입장 감사 기록 없음. 자료는 한 번만, setup 은 필드만 (손·이름 그대로)
//   - 입장(labJoin)이 겹쳐도 자료 넣기는 한 번. 끝난 setup(ok·error)·입장한 자리는 다시 넣지 않음. ready 뒤에도 편집기 확인은 다시
//   - 끝내기: 준비 멈춤(labprepstop)을 바깥 정리(DELETE)보다 먼저 저장. 붙잡힌 자료 넣기·키 풀기가 끝나도 바깥 호출·되살아남 없음
//   - 끝 시각 지남·지우기 실패(endRetry)도 막힌 채로. 미리보기 주소(pv)·이름·손도 끝난 뒤엔 안 씀
//   - 알람 시각은 더 이른 쪽만 남는다 (덮어쓰지 않음)
//   - State.prototype 에 새 준비 도우미(RPC 로 열릴 수 있는 메서드)가 없다
// 네트워크·비밀 값 없음 (fetch 는 가짜, 진짜 Daytona·OpenRouter·자료 주소를 부르지 않는다).  node test/lab-preparation-state.mjs

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  const dir = mkdtempSync(join(tmpdir(), 'lab-prep-state-'));
  writeFileSync(join(dir, name), out.outputFiles[0].text);
  try { return await import(pathToFileURL(join(dir, name)).href); } finally { rmSync(dir, { recursive: true, force: true }); }
}

let pass = 0, failN = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { failN++; console.log(`  FAIL ${name} ${String(extra).slice(0, 400)}`); }
};
const tick = () => new Promise((r) => setTimeout(r, 0));
const until = async (f, n = 200) => { for (let i = 0; i < n && !f(); i++) await tick(); return f(); };
const hold = () => { let release; const p = new Promise((r) => { release = r; }); return { p, release }; };

// ── 가짜 바깥 (Daytona·toolbox) ──
const ev = [];        // 순서 기록: 'put <key>' · 'del <key>' · '<METHOD> <host><path>'
const outbound = [];  // 가짜가 모르는 주소 (있으면 안 됨)
const H = {};
const reset = () => { Object.assign(H, { state: 'started', health: '200', clones: 0, cloneHold: null, pvHold: null, delFail: 0, starts: 0, editors: 0, healths: 0, made: 0, dtSkip: -1, dtHold: null, dtHeld: false }); ev.length = 0; };
reset();
const jr = (x, status = 200) => new Response(JSON.stringify(x), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (input, init = {}) => {
  const u = new URL(typeof input === 'string' ? input : input.url);
  const method = init.method ?? 'GET';
  ev.push(`${method} ${u.host}${u.pathname}`);
  if (u.host === 'dt.fake') {
    if (/\/ports\/8080\/preview-url$/.test(u.pathname)) { if (H.pvHold) await H.pvHold.p; return jr({ url: 'https://pv.fake/x', token: 'pv-tok' }); }
    let g;
    if (u.pathname === '/sandbox' && method === 'POST') return jr({ id: `sbm-${++H.made}`, state: 'creating' });
    if ((g = u.pathname.match(/^\/sandbox\/([\w-]+)\/start$/))) { H.starts++; return jr({}); }
    if ((g = u.pathname.match(/^\/sandbox\/([\w-]+)$/))) {
      if (method === 'DELETE') return H.delFail > 0 ? (H.delFail--, jr({ message: 'x' }, 500)) : jr({});
      return jr({ id: g[1], state: H.state, toolboxProxyUrl: 'https://tb.fake' });
    }
    if (u.pathname === '/sandbox') return jr([]);
  }
  if (u.host === 'tb.fake') {
    if (/\/process\/execute$/.test(u.pathname)) {
      const { command } = JSON.parse(init.body);
      if (command.includes('/healthz')) return H.healths++, jr({ exitCode: 0, result: H.health });
      if (command.includes('git clone')) { H.clones++; if (H.cloneHold) await H.cloneHold.p; return jr({ exitCode: 0, result: '' }); }
      if (command.includes('test -d')) return jr({ exitCode: 0, result: 'ok' });
      return jr({ exitCode: 0, result: '' });
    }
    if (/\/process\/session\/lab\/exec$/.test(u.pathname)) { H.editors++; return jr({}); }
    if (/\/process\/session$/.test(u.pathname)) return jr({});
  }
  outbound.push(`${method} ${u.href}`);
  return jr({ error: 'blocked' }, 503);
};

// ── 가짜 저장소 (값은 복사해서 넣고 뺀다) ──
function memStorage() {
  const m = new Map();
  let alarm = null;
  const c = (v) => (v === undefined ? v : structuredClone(v));
  const s = {
    m,
    async get(k) { await tick(); if (Array.isArray(k)) { const r = new Map(); for (const x of k) if (m.has(x)) r.set(x, c(m.get(x))); return r; } return c(m.get(k)); },
    async put(k, v) { await tick(); if (typeof k === 'object') { for (const [a, b] of Object.entries(k)) { ev.push(`put ${a}`); m.set(a, c(b)); } } else { ev.push(`put ${k}`); m.set(k, c(v)); } },
    async delete(k) { await tick(); const ks = Array.isArray(k) ? k : [k]; let n = 0; for (const x of ks) { ev.push(`del ${x}`); if (m.delete(x)) n++; } return Array.isArray(k) ? n : n > 0; },
    async list({ prefix = '' } = {}) { await tick(); return new Map([...m.keys()].filter((x) => x.startsWith(prefix)).sort().map((x) => [x, c(m.get(x))])); },
    async getAlarm() { return alarm; },
    async setAlarm(t) { alarm = t; },
    // 진짜 DO 처럼 트랜잭션끼리는 차례로 (안에서 다른 트랜잭션이 끼지 않는다)
    async transaction(f) { const prev = s.q; let done; s.q = new Promise((r) => { done = r; }); await prev; try { return await f(s); } finally { done(); } },
    q: Promise.resolve(),
  };
  return s;
}

const S = await load('src/state.ts', 'state.mjs');
const PS = await load('src/lab-preparation-service.ts', 'prep.mjs');

function make({ daytona = true } = {}) {
  const storage = memStorage();
  const waits = [];
  const ctx = { storage, waitUntil: (p) => waits.push(p), blockConcurrencyWhile: (f) => f() };
  // fixture: 기존 TS-private 훅만 바꾼다 (lab-security fixture 처럼). 준비 도우미는 #private 라 못 바꾼다
  class T extends S.State {
    async daytona() {
      if (H.dtSkip >= 0 && H.dtSkip-- === 0) { H.dtHeld = true; await H.dtHold.p; }
      return daytona ? { api: 'https://dt.fake', key: 'fx-key' } : { status: 409, error: 'Daytona 공급자 키가 없습니다. kv.ps1 push 로 올리세요.' };
    }
    async checkAdmin(token) { return token === 'admin'; }
    async labShareInput() { return { share: {}, defs: [] }; }
    async listProviders() { return [{ id: 'or', kind: 'openrouter-mint' }]; }
    async modelExists() { return true; }
    async newSession() { return { sid: `S${Math.random().toString(36).slice(2, 10)}`, token: 'tok' }; }
  }
  const st = new T(ctx, { LAB_SEAT_DOMAIN: 'seat.fake', LAB_ORIGIN: 'https://lab.fake' });
  const drain = async () => { for (let i = 0; i < 100; i++) { await tick(); const w = waits.splice(0); if (!w.length) { await tick(); if (!waits.length) return; } await Promise.allSettled(w); } };
  return { st, storage, drain };
}

let seq = 0;
const code = () => `c${String(++seq).padStart(3, '0')}xxxxxxxxxxxx`; // 16자
async function seedLab(storage, { seats = 1, materials = 'https://github.com/a/b', expiresAt = Date.now() + 3600e3, setup, opened, who } = {}) {
  const id = `lab${++seq}`;
  const lab = { id, name: '수업', createdAt: Date.now(), expiresAt, budget: 1, cpu: 1, memory: 2, disk: 5, snapshot: 's', model: 'm', gw: 'https://gw.fake', materials,
    seats: Array.from({ length: seats }, (_, i) => ({ n: i + 1, code: code(), label: `label${i + 1}`, sandboxId: `sb-${id}-${i + 1}`, sid: `S-${id}-${i + 1}`, setup, opened, who })) };
  await storage.put(`lab:${id}`, lab);
  for (const x of lab.seats) await storage.put(`seat:${x.code}`, { lab: id, n: x.n });
  return lab;
}
/** 줄에 넣은 것과 같은 일 기록 (labCreate 없이 알람이 돌리게) */
async function seedJob(storage, lab, n = 1, extra = {}) {
  const s = lab.seats[n - 1], t = Date.now();
  const job = { ref: { labId: lab.id, n, code: s.code, sandboxId: s.sandboxId }, op: `op-${++seq}`, phase: 'queued', created: t, deadline: t + PS.PREP_DEADLINE, due: t, tries: 0, editors: 0, ...extra };
  await storage.put(PS.prepJobKey(s.code), job);
  return job;
}
const labOf = (storage, id) => storage.m.get(`lab:${id}`);
const audits = (storage, e) => (storage.m.get('audit') ?? []).filter((a) => a.event === e);
const V = { name: '준비', seats: 2, hours: 1, budget: 1, cpu: 1, memory: 2, disk: 5, gw: 'https://gw-x.workers.dev', snapshot: 'gw-lab-v4', model: 'deepseek/deepseek-v4.1-flash', materials: 'https://github.com/a/b' };

// ── 0. 새 도우미가 prototype(RPC) 에 없음 ──
console.log('RPC 표면');
{
  const names = Object.getOwnPropertyNames(S.State.prototype);
  check('prep*·seatPatch·saveSeat 같은 새/옛 자리 쓰기 도우미가 prototype 에 없음', !names.some((x) => /^prep|seatPatch|saveSeat|prepDaytona/i.test(x)), names.filter((x) => /prep|seat/i.test(x)).join(','));
  const { st } = make();
  check('인스턴스에도 없음 (#private)', ['prepDaytona', 'prepActive', 'prepPatchSetup', 'prepEnqueue', 'seatPatch', 'prepSeat'].every((k) => !(k in st)));
}

// ── 1. labCreate 뒤 미리 준비: 입장 흔적 없음, 자료 한 번 ──
console.log('labCreate → 미리 준비');
{
  reset();
  const { st, storage, drain } = make();
  const r = await st.labCreate('admin', V);
  check('labCreate ok (준비를 기다리지 않음)', r.ok === true && H.clones === 0, JSON.stringify(r).slice(0, 300));
  const id = r.lab.id, lab0 = labOf(storage, id);
  check('자리마다 일 기록 (저장된 자리에서)', lab0.seats.every((x) => storage.m.get(PS.prepJobKey(x.code))?.ref.sandboxId === x.sandboxId), JSON.stringify([...storage.m.keys()]));
  await drain();
  const l = labOf(storage, id);
  check('두 자리 모두 자료 ok (한 번씩)', H.clones === 2 && l.seats.every((x) => x.setup?.state === 'ok'), `${H.clones} ${JSON.stringify(l.seats.map((x) => x.setup))}`);
  check('opened·who·pv 안 씀', l.seats.every((x) => !x.opened && !x.who && !x.pv), JSON.stringify(l.seats));
  check('입장·이름 감사 기록 없음', audits(storage, 'lab-join').length === 0 && audits(storage, 'lab-name').length === 0);
  check('일 기록 ready', l.seats.every((x) => storage.m.get(PS.prepJobKey(x.code))?.phase === 'ready'));
  check('미리보기 주소 안 받음', !ev.some((e) => e.includes('preview-url')));
  const before = ev.filter((e) => e.startsWith('POST tb.fake')).length;
  const j = await st.labJoin(l.seats[0].code, '  Alice  ');
  check('입장 ready + 이름', j.status === 'ready' && j.who === 'Alice' && j.materials === undefined, JSON.stringify(j));
  check('입장: 다시 넣지 않음, 편집기 확인은 다시', H.clones === 2 && ev.filter((e) => e.startsWith('POST tb.fake')).length > before);
  const l2 = labOf(storage, id);
  check('입장: opened 와 감사 기록 하나씩', !!l2.seats[0].opened && !l2.seats[1].opened && audits(storage, 'lab-join').length === 1 && audits(storage, 'lab-name').length === 1);
  check('labTiming: 요청 total + 새 준비 일 관측만 (재지 않은 단계 없음)', typeof j.labTiming?.total === 'number' && ['prep_queue', 'prep_elapsed', 'prep_sandbox', 'prep_health'].every((k) => typeof j.labTiming[k] === 'number') && ['prep_materials', 'prep_wake', 'prep_start', 'prep_wait'].every((k) => !(k in j.labTiming)), JSON.stringify(j.labTiming));
  const j2 = await st.labJoin(l.seats[0].code, 'Mallory');
  check('다시 입장: 이름 그대로, 감사 기록 더 없음', j2.status === 'ready' && j2.who === 'Alice' && audits(storage, 'lab-join').length === 1 && audits(storage, 'lab-name').length === 1, JSON.stringify(j2));
  check('가짜 밖 주소 호출 없음', outbound.length === 0, outbound.join(' '));
  check('labCreate 거부(401)는 준비 안 함', (await st.labCreate('bad', V)).status === 401);
}

// ── 2. 입장 겹침 + 손·이름 필드 보존 ──
console.log('입장 겹침·필드 보존');
{
  reset();
  const { st, storage, drain } = make();
  const lab = await seedLab(storage);
  const c = lab.seats[0].code;
  H.cloneHold = hold();
  await seedJob(storage, lab);
  await st.alarm();
  await until(() => H.clones === 1);
  check('알람이 돌린 준비가 자료 넣는 중', H.clones === 1 && labOf(storage, lab.id).seats[0].setup?.state === 'running');
  // 넣는 중 입장 3개는 같은 일을 같이 기다린다 (새로 넣지 않음)
  let settled = 0;
  const joins = [st.labJoin(c, 'Bob'), st.labJoin(c), st.labJoin(c)].map((p) => p.finally(() => settled++));
  await st.labHand(c, true);
  await until(() => labOf(storage, lab.id).seats[0].who === 'Bob');
  const mid = labOf(storage, lab.id).seats[0];
  check('넣는 중 입장은 기다림 (아직 끝나지 않음, opened 없음)', settled === 0 && !mid.opened, `${settled} ${JSON.stringify(mid)}`);
  check('넣는 중에 이름·손 저장 (setup running 그대로)', mid.who === 'Bob' && !!mid.hand && mid.setup?.state === 'running', JSON.stringify(mid));
  H.cloneHold.release();
  const rs = await Promise.all(joins);
  await drain();
  const s1 = labOf(storage, lab.id).seats[0];
  check('자료 ok 저장 뒤에도 이름·손 그대로 (필드만 저장)', s1.setup?.state === 'ok' && s1.who === 'Bob' && !!s1.hand, JSON.stringify(s1));
  check('동시 입장 3개: 자료는 한 번만', H.clones === 1, H.clones);
  check('동시 입장: ready 이고 opened·입장 기록 한 번', rs.every((x) => x.status === 'ready') && !!s1.opened && audits(storage, 'lab-join').length === 1, JSON.stringify(rs.map((x) => x.status)));
  check('강사 손 내림: hand 만 (setup·opened 그대로)', (await st.labHandClear('admin', lab.id, 1)).ok === true && !labOf(storage, lab.id).seats[0].hand && labOf(storage, lab.id).seats[0].setup?.state === 'ok' && !!labOf(storage, lab.id).seats[0].opened);
  const again = await st.labJoin(c);
  check('다시 입장: 자료 다시 안 넣음', again.status === 'ready' && H.clones === 1, JSON.stringify(again));
}

// ── 3. 일 번호가 바뀌면 결과를 안 씀 ──
console.log('일 번호');
{
  reset();
  const { st, storage, drain } = make();
  const lab = await seedLab(storage);
  H.cloneHold = hold();
  const job = await seedJob(storage, lab);
  await st.alarm();
  await until(() => H.clones === 1);
  const cur = storage.m.get(PS.prepJobKey(job.ref.code));
  storage.m.set(PS.prepJobKey(job.ref.code), { ...cur, op: 'someone-else' });
  H.cloneHold.release();
  await drain();
  check('주인이 바뀐 뒤 옛 일의 자료 결과(ok) 안 씀, 다시 넣지 않음', labOf(storage, lab.id).seats[0].setup?.state !== 'ok' && H.clones === 1, JSON.stringify(labOf(storage, lab.id).seats[0]));
}

// ── 4. 끝난 setup 은 다시 하지 않음 ──
console.log('끝난 setup');
{
  reset();
  const { st, storage } = make();
  const lab = await seedLab(storage, { setup: { state: 'error', at: Date.now(), note: 'git clone 실패: x' } });
  const r = await st.labJoin(lab.seats[0].code);
  check('setup error: 다시 안 넣고 ready + 자료 경고', H.clones === 0 && r.status === 'ready' && r.materials === 'git clone 실패: x', JSON.stringify(r));
  const lab2 = await seedLab(storage, { opened: Date.now() - 1000 });
  const r2 = await st.labJoin(lab2.seats[0].code);
  check('이미 입장한 자리(setup 없음): 자료 안 넣음', H.clones === 0 && r2.status === 'ready', JSON.stringify(r2));
  const lab3 = await seedLab(storage, { setup: { state: 'running', at: Date.now() - 10 * 60e3, note: '' } });
  const r3 = await st.labJoin(lab3.seats[0].code);
  const s3 = labOf(storage, lab3.id).seats[0];
  check('주인 없는 running(3분 지남): 다시 넣지 않음, running 으로 남지 않음', H.clones === 0 && s3.setup?.state !== 'running', JSON.stringify([r3, s3.setup]));
  check('주인 없는 running: 끝났는지 모름 → ready 아님, opened 없음', r3.status !== 'ready' && !s3.opened && audits(storage, 'lab-join').length === 1, JSON.stringify(r3));
}

// ── 5. 끝내기: 멈춤이 먼저, 되살아나지 않음 ──
console.log('끝내기 (cancelLab 먼저)');
{
  reset();
  const { st, storage, drain } = make();
  const lab = await seedLab(storage);
  H.cloneHold = hold();
  await seedJob(storage, lab);
  await st.alarm();
  await until(() => H.clones === 1);
  ev.length = 0;
  const ok = await st.endLab(labOf(storage, lab.id), 'end');
  const stop = ev.indexOf(`put ${PS.prepStopKey(lab.id)}`), del = ev.findIndex((e) => e.startsWith('DELETE dt.fake'));
  check('끝내기 성공', ok === true);
  check('멈춤 저장이 샌드박스 DELETE 보다 먼저', stop >= 0 && del > stop, ev.slice(0, 6).join(' | '));
  check('일 기록 지움', !storage.m.has(PS.prepJobKey(lab.seats[0].code)));
  ev.length = 0;
  const h0 = H.healths, e0 = H.editors;
  H.cloneHold.release();
  await drain();
  check('붙잡힌 자료 넣기가 끝나도 수업 되살아나지 않음', !storage.m.has(`lab:${lab.id}`) && !storage.m.has(`seat:${lab.seats[0].code}`) && !storage.m.has(PS.prepJobKey(lab.seats[0].code)));
  check('그 뒤 새 바깥 호출 없음 (돌던 자료 넣기만 끝까지: 상태 확인·켜기·편집기 확인·켜기 없음)', H.clones === 1 && H.healths === h0 && H.editors === e0 && H.starts === 0 && !ev.some((e) => /^GET dt\.fake\/sandbox\//.test(e) || e.includes('/process/session')), ev.join(' | '));
  check('끝난 수업 입장 → 404/410', [404, 410].includes((await st.labJoin(lab.seats[0].code)).status));
}

// ── 6. 키 풀기(daytona) 중 끝내기 + 지우기 실패: 늦은 켜기 호출 없음 ──
console.log('키 풀기 중 끝내기');
{
  reset();
  const { st, storage, drain } = make();
  const lab = await seedLab(storage);
  H.state = 'stopped';        // 1) 상태 확인 → 2) 켜기. 켜기 직전의 daytona() 를 붙잡는다
  H.dtSkip = 1; H.dtHold = hold();
  await seedJob(storage, lab);
  await st.alarm();
  await until(() => H.dtHeld);
  check('켜기 직전 키 풀기에서 붙잡힘', H.dtHeld && H.starts === 0);
  H.delFail = 1;
  const ok = await st.endLab(labOf(storage, lab.id), 'end');
  check('지우기 실패 → false, endRetry, 멈춤 표시 남음', ok === false && !!labOf(storage, lab.id)?.endRetry && storage.m.has(PS.prepStopKey(lab.id)));
  ev.length = 0;
  H.dtHold.release();
  await drain();
  check('풀린 뒤에도 켜기(POST start)·toolbox 호출 없음', H.starts === 0 && !ev.some((e) => /POST (dt|tb)\.fake/.test(e)), ev.join(' | '));
  check('setup·opened 안 씀', !labOf(storage, lab.id).seats[0].setup && !labOf(storage, lab.id).seats[0].opened);
  // 끝내는 중(endRetry) 수업: 알람이 다시 끝내기 전에도 준비는 다시 시작하지 않는다
  await seedJob(storage, lab);
  ev.length = 0;
  H.delFail = 1;
  await st.alarm();
  await drain();
  check('endRetry 중 알람: 준비 바깥 호출 없음', H.starts === 0 && H.clones === 0 && !ev.some((e) => /(GET|POST) (dt|tb)\.fake\/(sandbox\/[\w-]+$|sb-|[\w-]+\/process)/.test(e) && !e.startsWith('DELETE')), ev.join(' | '));
  H.state = 'started';
}

// ── 7. 끝 시각 지남 ──
console.log('끝 시각');
{
  reset();
  const { st, storage, drain } = make();
  const lab = await seedLab(storage, { expiresAt: Date.now() + 60e3 });
  H.cloneHold = hold();
  await seedJob(storage, lab);
  await st.alarm();
  await until(() => H.clones === 1);
  const real = Date.now;
  Date.now = () => real() + 120e3;
  try {
    H.cloneHold.release();
    await drain();
    const s = labOf(storage, lab.id).seats[0];
    check('끝 시각 뒤 자료 결과는 안 씀 (running 그대로, opened 없음)', s.setup?.state === 'running' && !s.opened, JSON.stringify(s));
    check('끝 시각 뒤 입장 → 410', (await st.labJoin(s.code)).status === 410);
  } finally { Date.now = real; }
}

// ── 8. 미리보기 주소: 필드만, 끝난 뒤 안 씀 ──
console.log('labRoute pv');
{
  reset();
  const { st, storage } = make();
  const lab = await seedLab(storage);
  const c = lab.seats[0].code;
  H.pvHold = hold();
  const p = st.labRoute(c);
  await until(() => ev.some((e) => e.includes('preview-url')));
  await st.labHand(c, true);
  H.pvHold.release();
  const r = await p;
  const s = labOf(storage, lab.id).seats[0];
  check('pv 저장 + 그 사이 손 그대로', r.origin === 'https://pv.fake' && s.pv?.token === 'pv-tok' && !!s.hand, JSON.stringify(s));
  const lab2 = await seedLab(storage);
  H.pvHold = hold();
  ev.length = 0;
  const p2 = st.labRoute(lab2.seats[0].code);
  await until(() => ev.some((e) => e.includes('preview-url')));
  H.delFail = 1; // 지우기 실패 → endRetry 로 수업 기록이 남는다
  await st.endLab(labOf(storage, lab2.id), 'end');
  H.pvHold.release();
  const r2 = await p2;
  const s2 = labOf(storage, lab2.id)?.seats[0];
  check('끝내는 중 pv: 410, 저장 안 함', r2.status === 410 && !s2?.pv, JSON.stringify([r2, s2]));
}

// ── 9. Daytona 없음 ──
console.log('Daytona 없음');
{
  reset();
  const { st, storage, drain } = make({ daytona: false });
  const lab = await seedLab(storage);
  const r = await st.labJoin(lab.seats[0].code);
  check('입장: 409 그대로', r.status === 409, JSON.stringify(r));
  await seedJob(storage, lab);
  await st.alarm();
  await drain();
  check('미리 준비: 바깥 호출 없음·자료 안 넣음·opened 없음', !ev.some((e) => /fake/.test(e)) && outbound.length === 0 && !labOf(storage, lab.id).seats[0].opened && !labOf(storage, lab.id).seats[0].setup, ev.join(' | '));
}

// ── 10. 알람: 더 이른 쪽만 ──
console.log('알람');
{
  reset();
  const { st, storage, drain } = make();
  H.state = 'starting'; // 켜지는 중 → 준비 일이 다음 시각을 잡는다
  const lab = await seedLab(storage);
  await seedJob(storage, lab);
  await st.alarm();
  await drain();
  const a1 = await storage.getAlarm();
  check('알람: 준비 다음 시각(수업 끝보다 이름)을 잡는다', a1 !== null && a1 < lab.expiresAt, `${a1}`);
  const early = Date.now() + 500;
  await storage.setAlarm(early);
  await st.labJoin(lab.seats[0].code); // 입장도 기다림(starting) → 더 늦은 시각을 schedule
  await drain();
  check('더 늦은 준비 시각이 이른 알람을 덮지 않음', (await storage.getAlarm()) === early, `${await storage.getAlarm()} ${early}`);
  H.state = 'started';
}

// ── 11. 소스 구조 ──
console.log('state.ts 구조');
{
  const src = readFileSync(join(ROOT, 'src/state.ts'), 'utf8').replace(/\r\n/g, '\n');
  const body = (sig) => { const a = src.indexOf(sig); return src.slice(a, src.indexOf('\n  }\n', a)); };
  const create = body('  async #labCreateRun(token: string');
  check('labCreate: audit 뒤 #prepEnqueue, labJoin 안 부름', create.indexOf('await this.#prepEnqueue(id)') > create.indexOf("this.audit('lab-create'") && !/labJoin/.test(create));
  const end = body('  private async endLab(lab: Lab');
  const endOrder = ['this.#prepStopped.add(lab.id)', 'await this.#prep.cancelLab(lab.id)', 'this.#lifecycle.end'].map(x => end.indexOf(x));
  // Other services may cancel between these gates; adjacency is not the safety property.
  check('endLab: 메모리 멈춤 → cancelLab 기다림 → lifecycle', endOrder.every(x => x >= 0) && endOrder[0] < endOrder[1] && endOrder[1] < endOrder[2]);
  const join_ = body(src.includes('  async #demoJoin(') ? '  async #demoJoin(' : '  async labJoin(code: string');
  const aw = [...join_.matchAll(/await ([\w.#]+)\(/g)].map((m) => m[1]).filter(name => name !== 'this.#demoLiveLab');
  check('labJoin: seatOf → (이름) → daytona → ensure → opened 순서', JSON.stringify(aw) === JSON.stringify(['this.seatOf', 'this.#seatPatch', 'this.audit', 'this.daytona', 'this.#prep.ensure', 'this.#seatPatch', 'this.audit']), JSON.stringify(aw));
  check('saveSeat·통째 자리 쓰기 없음', !/saveSeat|\.\.\.seat, who:/.test(src));
  const remote = body('  async #prepRemote<T>');
  check('#prepRemote: 키 풀기 → 멈춤·주인(prepOwns)·자리 확인 → 호출', /await this\.daytona\(\)[\s\S]*#prepStopped\.has[\s\S]*prepOwns\([\s\S]*#prepSeat\([\s\S]*#prepStopped\.has\(ref\.labId\)\)[\s\S]*return f\(c\);/.test(remote), remote);
  // gate(PrepGate) 는 마지막 인자. 마지막 await 뒤에 부르고, gate 와 f(c) 사이엔 await 없음 (행동 테스트는 12 가 맡는다)
  const gname = remote.split('\n')[0].match(/(\w+)\??: PrepGate\b/)?.[1];
  const gi = gname ? remote.lastIndexOf(`${gname}(`) : -1, fi = remote.indexOf('return f(c)');
  check('#prepRemote: PrepGate 인자를 받아 마지막 await 뒤·f(c) 바로 앞에서 부름', !!gname && gi > remote.lastIndexOf('await ') && gi < fi && !/await/.test(remote.slice(gi, fi)), remote);
  const opsBlock = src.slice(src.indexOf('    ops: {', src.indexOf('readonly #prep = new LabPreparationService')), src.indexOf('\n    },', src.indexOf('readonly #prep = new LabPreparationService')));
  for (const op of ['sandbox', 'wake', 'install', 'health', 'editor']) {
    const line = opsBlock.split('\n').find((l) => l.trimStart().startsWith(`${op}:`)) ?? '';
    const last = line.match(/^\s*\w+: \(([^)]*)\)/)?.[1].split(',').map((x) => x.trim()).pop();
    const call = line.slice(line.indexOf('#prepRemote(') + 1);
    check(`ops.${op}: 마지막 인자 gate 를 #prepRemote 로 넘김`, !!last && !['ref', 'sb', 'm'].includes(last) && line.includes('#prepRemote(') && new RegExp(`[(,]\\s*${last}\\s*[,)]`).test(call), line);
  }
}

// ── 12. 키 풀기(daytona) 를 붙잡은 채 끝 시각·호출 시간·수업 만료가 지남 → 풀려도 실제 바깥 효과 없음 ──
// 진짜 State·진짜 준비 서비스. 서비스의 #ext 남은 시간 확인은 호출 시작 때뿐이라, 키 풀기 뒤 gate(PrepGate) 가 막아야 한다.
// no-op gate 면 POST start·git clone·healthz·spawn 이 일어나 실패한다. 시계는 Date.now 를 밀고, 1초 이상 setTimeout 은 가짜(직접 울림)
console.log('키 풀기 붙잡힘 + 끝 시각/호출 시간/만료');
{
  const realST = globalThis.setTimeout, realCT = globalThis.clearTimeout;
  const long = new Map(); let lid = 0;
  globalThis.setTimeout = (fn, ms, ...a) => {
    if (!(ms >= 1000)) return realST(fn, ms, ...a);
    const h = { id: ++lid, unref() { return h; }, ref() { return h; } };
    long.set(h, { fn, ms, a }); return h;
  };
  globalThis.clearTimeout = (h) => { if (long.has(h)) long.delete(h); else realCT(h); };
  const fireLong = (max) => { for (const [h, x] of [...long]) if (x.ms <= max) { long.delete(h); x.fn(...x.a); } };
  const realNow = Date.now;
  const effect = {
    wake: () => H.starts + ev.filter((e) => /^POST dt\.fake\/sandbox\/[\w-]+\/start$/.test(e)).length,
    install: () => H.clones,
    health: () => H.healths,
    editor: () => H.editors + ev.filter((e) => e.includes('/process/session')).length,
  };
  try {
    for (const target of ['wake', 'install', 'health', 'editor']) {
      for (const how of ['deadline', 'timer', 'expire']) {
        reset(); Date.now = realNow;
        const { st, storage, drain } = make();
        const t0 = realNow();
        const lab = await seedLab(storage, {
          expiresAt: how === 'expire' ? t0 + 60e3 : t0 + 3600e3,
          setup: target === 'health' || target === 'editor' ? { state: 'ok', at: t0, note: 'x' } : undefined,
        });
        if (target === 'wake') H.state = 'stopped';
        if (target === 'editor') H.health = '000';
        H.dtSkip = target === 'editor' ? 2 : 1; H.dtHold = hold(); // 0: 상태 확인(GET), 1: 대상 (editor 는 1: healthz, 2: spawn)
        await seedJob(storage, lab);
        await st.alarm();
        const tag = `${target}/${how}`;
        await until(() => H.dtHeld);
        check(`${tag}: 대상 호출의 키 풀기에서 붙잡힘, 효과 아직 없음`, H.dtHeld && effect[target]() === 0 && (target !== 'install' || labOf(storage, lab.id).seats[0].setup?.state === 'running'), JSON.stringify([H, labOf(storage, lab.id).seats[0].setup]));
        const audit0 = audits(storage, 'lab-join').length;
        // 수업은 살아 있는 채 (expire 만 끝남) 시각을 민다
        const jump = how === 'deadline' ? PS.PREP_DEADLINE + 1 : how === 'timer' ? (target === 'install' ? PS.PREP_DEADLINE + 1 : PS.PREP_OP_TIMEOUT + 1) : 120e3;
        Date.now = () => realNow() + jump;
        if (how === 'timer') fireLong(jump); // 기다림이 먼저 그만둔 뒤 늦게 풀린 키
        ev.length = 0;
        H.dtHold.release();
        await drain();
        const s = labOf(storage, lab.id)?.seats[0];
        const cur = storage.m.get(PS.prepJobKey(s.code));
        check(`${tag}: 풀린 뒤 대상 바깥 효과 0`, effect[target]() === 0, ev.join(' | '));
        if (how !== 'timer' || target === 'install' || target === 'wake') // health 호출 시간 끝 뒤 새 편집기 켜기는 새 호출이라 허용
          check(`${tag}: 풀린 뒤 새 POST(dt·tb) 없음`, !ev.some((e) => /^POST (dt|tb)\.fake/.test(e)), ev.join(' | '));
        check(`${tag}: ready·opened·입장 감사 없음`, cur?.phase !== 'ready' && !s.opened && audits(storage, 'lab-join').length === audit0, JSON.stringify([cur?.phase, s]));
        if (target === 'install') check(`${tag}: setup ok 아님`, s.setup?.state !== 'ok', JSON.stringify(s.setup));
        if (target === 'health' || target === 'editor') check(`${tag}: setup 그대로`, s.setup?.state === 'ok' && s.setup.note === 'x', JSON.stringify(s.setup));
        if (how !== 'timer' || target === 'install') {
          // 뒤이은 알람·입장도 같은 효과를 다시 하지 않고 ready·opened 를 주지 않는다 (uncertain 은 덮지 않는다)
          const was = structuredClone(s.setup);
          ev.length = 0;
          await st.alarm(); await drain();
          const j = await st.labJoin(s.code); await drain();
          const s2 = labOf(storage, lab.id)?.seats[0];
          check(`${tag}: 뒤 알람·입장도 효과 0·ready 아님·opened 없음`, effect[target]() === 0 && j.status !== 'ready' && !s2?.opened && audits(storage, 'lab-join').length === audit0, JSON.stringify([j, ev]));
          if (PS.prepUncertain(was)) check(`${tag}: uncertain 덮지 않음`, PS.prepUncertain(s2?.setup), JSON.stringify(s2?.setup));
        }
        check(`${tag}: 가짜 밖 주소 호출 없음`, outbound.length === 0, outbound.join(' '));
      }
    }
  } finally {
    Date.now = realNow; globalThis.setTimeout = realST; globalThis.clearTimeout = realCT;
    long.clear();
    H.state = 'started'; H.health = '200';
  }
}

// ── 13. 입장 저장 트랜잭션이 다시 돌 때: 첫 시도의 running 판단이 남지 않는다 (커밋된 setup 으로만) ──
console.log('입장 트랜잭션 재시도');
{
  reset();
  const { st, storage, drain } = make();
  const lab = await seedLab(storage, { setup: { state: 'ok', at: Date.now(), note: 'x' } });
  const c = lab.seats[0].code;
  await seedJob(storage, lab, 1, { phase: 'ready', endedAt: Date.now() });
  const txn = storage.transaction;
  let seen = 0, attempts = 0;
  // setup ok 경로라 준비 쪽 setup 저장(트랜잭션)은 없고, 이름 없는 입장의 트랜잭션은 opened 저장 하나뿐이다.
  // 그 첫 시도는 setup running 인 모습을 보고 (쓰기는 버려짐) 충돌로 다시 돌고, 두 번째 시도가 저장된 ok 를 보고 커밋한다 (DO 트랜잭션 재시도 흉내)
  storage.transaction = async (f) => {
    if (++seen !== 1) return txn.call(storage, f);
    const view = { ...storage,
      async get(k) { const r = await storage.get(k); const l = r instanceof Map ? r.get(`lab:${lab.id}`) : null; if (l) l.seats[0].setup = { state: 'running', at: Date.now(), note: '' }; return r; },
      async put() {}, async delete() {} };
    attempts++;
    try { await f(view); } catch {}
    attempts++;
    return txn.call(storage, f);
  };
  let j;
  try { j = await st.labJoin(c); await drain(); } finally { storage.transaction = txn; }
  const s = labOf(storage, lab.id).seats[0];
  check('재시도 트랜잭션: 입장 트랜잭션 하나가 두 번 돌았음', seen === 1 && attempts === 2, `${attempts} ${seen}`);
  check('재시도 뒤 커밋된 ok 로 ready (첫 시도의 running 판단 안 남음)', j.status === 'ready' && j.materials === undefined, JSON.stringify(j));
  check('opened 한 번·입장 감사 한 번', !!s.opened && audits(storage, 'lab-join').length === 1, JSON.stringify([s, audits(storage, 'lab-join')]));
}

console.log(`\n${pass} passed, ${failN} failed`);
process.exit(failN ? 1 : 0);
