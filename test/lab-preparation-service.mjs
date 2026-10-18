// 자리 미리 준비 서비스(src/lab-preparation-service.ts) 단위 테스트. 설치된 esbuild 로 번들해 그대로 부른다.
// 저장소·시계·Daytona 호출은 전부 이 파일의 가짜 (네트워크·서버·비밀 값 없음 — fetch 는 막는다).
// 확인하는 것: 중복 enqueue·입장 묶기, 매 await 중 끝내기·만료·멈춤, 주인 바뀜, 되살아나지 않음, 동시 개수, 다시 뜬 뒤 단계,
//              끝났는지 모르는 자료 넣기 안 되풀이, 끝 시각·오류, 미리 준비된 자리의 편집기 재확인, 기존 ok/error/opened 보존.
//   node test/lab-preparation-service.mjs

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const bundled = await build({ entryPoints: [join(ROOT, 'src/lab-preparation-service.ts')], bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent', loader: { '.sh': 'text', '.txt': 'text', '.py': 'text', '.js': 'js' } });
const dir = mkdtempSync(join(tmpdir(), 'lab-prep-'));
writeFileSync(join(dir, 'prep.mjs'), bundled.outputFiles[0].text);
let M;
try { M = await import(pathToFileURL(join(dir, 'prep.mjs')).href); } finally { rmSync(dir, { recursive: true, force: true }); }
const { LabPreparationService, prepJobKey, prepStopKey, prepOwns, prepUncertain, PREP_UNCERTAIN, PREP_TIMEOUT, PREP_QUEUED, PREP_EDITOR_WAIT, PREP_DEADLINE, PREP_BATCH_MAX, PREP_QUEUE_MAX, PREP_KEEP, PREP_OP_TIMEOUT } = M;

globalThis.fetch = async (u) => { throw new Error(`network blocked in test: ${u}`); };
const unhandled = [];
process.on('unhandledRejection', (e) => { unhandled.push(String(e?.message ?? e)); });

let pass = 0, failN = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { failN++; console.log(`  FAIL ${name} ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`); }
};
const flush = async (n = 30) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const deferred = () => { let resolve, reject; const p = new Promise((a, b) => { resolve = a; reject = b; }); return { p, resolve, reject }; };

// ── 가짜 세상 ──
function world({ seats = 3, materials = { kind: 'git', url: 'https://github.com/a/b.git', dir: 'b' }, limit, costs = {} } = {}) {
  let T = 1_000_000;
  const store = new Map();
  const clone = (v) => v === undefined ? undefined : structuredClone(v);
  const patchHolds = []; // { state, d, hit }
  const holdPatch = (state) => { const h = { state, d: deferred(), hit: false }; patchHolds.push(h); return h; };
  const putHolds = []; // { pred, d, hit } — 맞는 put 하나를 d 가 풀릴 때까지 붙잡는다 (저장 await 중 경쟁)
  const holdPut = (pred) => { const h = { pred, d: deferred(), hit: false }; putHolds.push(h); return h; };
  const storage = {
    async get(k) { await null; return Array.isArray(k) ? new Map(k.filter((x) => store.has(x)).map((x) => [x, clone(store.get(x))])) : clone(store.get(k)); },
    async put(k, v) {
      await null; const c = clone(v);
      const h = putHolds.find((x) => !x.hit && x.pred(k, c));
      if (h) { h.hit = true; await h.d.p; }
      store.set(k, c);
    },
    async delete(k) { await null; for (const x of Array.isArray(k) ? k : [k]) store.delete(x); },
    async list({ prefix }) { await null; return new Map([...store.keys()].filter((k) => k.startsWith(prefix)).sort().map((k) => [k, clone(store.get(k))])); },
  };
  const lab = { id: 'L1', ended: false, materials };
  const seat = {}; // code → { n, sandboxId, setup?, opened? }
  for (let i = 1; i <= seats; i++) seat['c' + i] = { n: i, sandboxId: 'sb' + i };
  const sb = {}; // sandboxId → state
  for (let i = 1; i <= seats; i++) sb['sb' + i] = 'started';
  const healthy = {}; // sandboxId → bool
  const calls = [];   // [op, code, sandboxId]
  const patches = []; // { code, op, setup, ok }
  const gates = {};   // op → deferred[] (설정하면 호출이 그 약속을 기다린다)
  const timers = [];
  const bg = [];
  const scheduled = [];
  const gate = (op) => (gates[op] ??= []);
  const hold = (op) => { const d = deferred(); gate(op).push(d); return d; };
  const fl = { now: 0, max: 0 };
  const wait = async (op, v) => { T += costs[op] ?? 0; const g = gates[op]?.shift(); fl.max = Math.max(fl.max, ++fl.now); try { return g ? await g.p : v; } finally { fl.now--; } };
  // 마지막 인자 gate(PrepGate): State 처럼 자기 await(키 풀기 = pre) 를 지난 뒤, 실제 바깥 효과(effects) 바로 앞에서 부른다.
  // gate 가 던지면 효과 없이 그 예외로 실패한다. gate 가 없으면 missingGate 에 적고 그대로 진행 (no-op gate 처럼 — 거부 테스트가 잡는다)
  const effects = [];     // [op, code, sandboxId] — gate 를 통과해 실제로 시작된 바깥 효과
  const denied = [];      // [op, code, message]
  const missingGate = []; // [op, typeof gate]
  const pres = {};        // op → deferred[] (gate 앞 자기 await 을 붙잡는다)
  const pre = (op) => { const d = deferred(); (pres[op] ??= []).push(d); return d; };
  const preHit = {};
  const through = async (op, ref, g) => {
    const d = pres[op]?.shift();
    if (d) { preHit[op] = (preHit[op] ?? 0) + 1; await d.p; }
    if (typeof g !== 'function') missingGate.push([op, typeof g]);
    else {
      try { const x = g(); if (x && typeof x.then === 'function') await x; }
      catch (e) { denied.push([op, ref.code, String(e?.message ?? e)]); throw e; }
    }
    effects.push([op, ref.code, ref.sandboxId]);
  };
  const ops = {
    async sandbox(ref, g) { calls.push(['sandbox', ref.code, ref.sandboxId]); await through('sandbox', ref, g); return wait('sandbox', { id: ref.sandboxId, state: sb[ref.sandboxId], toolboxProxyUrl: 'http://toolbox.invalid' }); },
    async wake(ref, s, g) { calls.push(['wake', ref.code, ref.sandboxId]); await through('wake', ref, g); await wait('wake'); },
    async install(ref, s, m, g) { calls.push(['install', ref.code, ref.sandboxId]); await through('install', ref, g); return wait('install', `자료 ${m.dir ?? 'file'}`); },
    async health(ref, s, g) { calls.push(['health', ref.code, ref.sandboxId]); await through('health', ref, g); return wait('health', !!healthy[ref.sandboxId]); },
    async editor(ref, s, g) { calls.push(['editor', ref.code, ref.sandboxId]); await through('editor', ref, g); await wait('editor'); },
  };
  const ref = (code) => ({ labId: lab.id, n: seat[code].n, code, sandboxId: seat[code].sandboxId });
  const snapshot = (r) => {
    const s = seat[r.code];
    if (lab.ended || r.labId !== lab.id || !s || s.n !== r.n || s.sandboxId !== r.sandboxId) return null;
    return { materials: lab.materials, setup: clone(s.setup), opened: s.opened };
  };
  const deps = {
    storage, limit,
    now: () => T,
    waitUntil: (p) => { bg.push(p); },
    schedule: async (at) => { scheduled.push(at); },
    active: async (r) => { await null; return snapshot(r); },
    // State 쪽 계약: job·stop 을 한 번에 읽고 prepOwns + 자리 유효일 때만 쓴다
    patchSetup: async (r, op, setup) => {
      const got = await storage.get([prepJobKey(r.code), prepStopKey(r.labId)]);
      const ok = prepOwns(got.get(prepJobKey(r.code)), got.get(prepStopKey(r.labId)), r, op) && !!snapshot(r);
      patches.push({ code: r.code, op, setup: clone(setup), ok });
      if (ok) seat[r.code].setup = clone(setup);
      const h = patchHolds.find((x) => !x.hit && x.state === setup.state); // 쓴 뒤 돌아오기 전 (쓰는 await 중)
      if (h) { h.hit = true; await h.d.p; }
      return ok;
    },
    ops,
    delay: (ms) => { const d = deferred(); timers.push({ at: T + ms, d }); return d.p; },
  };
  const advance = async (ms) => {
    T += ms;
    for (const t of timers.filter((x) => x.at <= T)) { timers.splice(timers.indexOf(t), 1); t.d.resolve(); }
    await flush();
  };
  const svc = () => new LabPreparationService(deps);
  return { fl, store, storage, holdPut, holdPatch, lab, seat, sb, healthy, calls, patches, hold, gates, ref, deps, svc, advance, bg, scheduled, setT: (t) => { T = t; }, now: () => T,
    effects, denied, missingGate, pre, preHit, timers,
    count: (op, code) => calls.filter((c) => c[0] === op && (!code || c[1] === code)).length,
    eff: (op, sid) => effects.filter((c) => c[0] === op && (!sid || c[2] === sid)).length };
}

// ── 1. 기본 흐름 ──
console.log('basic ensure');
{
  const w = world(); w.healthy.sb1 = true;
  const s = w.svc();
  const r = await s.ensure(w.ref('c1'));
  check('ready', r.status === 'ready', r);
  check('setup ok with note', r.setup?.state === 'ok' && r.setup.note === '자료 b', r);
  check('install once', w.count('install') === 1);
  check('running patched before install, then ok', w.patches.map((p) => p.setup.state).join() === 'running,ok', w.patches);
  check('service never writes opened/who', w.seat.c1.opened === undefined && !('who' in w.seat.c1));
  check('job ready', w.store.get(prepJobKey('c1'))?.phase === 'ready');
  const keys = [...w.store.keys()];
  check('only labprep keys written', keys.every((k) => k.startsWith('labprep:')), keys);
  const job = w.store.get(prepJobKey('c1'));
  check('job record has no credentials', !JSON.stringify(job).match(/token|key|secret|toolbox/i), job);
  check('every op got a callable gate as its final arg', w.missingGate.length === 0 && w.effects.length === w.calls.length, [w.missingGate, w.calls.length, w.effects.length]);
}

// ── 2. 중복 입장·중복 enqueue ──
console.log('dedup');
{
  const w = world(); w.healthy.sb1 = true;
  const s = w.svc();
  const g = w.hold('install');
  const a = s.ensure(w.ref('c1')), b = s.ensure(w.ref('c1'));
  await flush();
  const c = s.ensure(w.ref('c1'));
  g.resolve('자료 b');
  const [ra, rb, rc] = await Promise.all([a, b, c]);
  check('three joins same ready', [ra, rb, rc].every((x) => x.status === 'ready'), [ra, rb, rc]);
  check('install once for concurrent joins', w.count('install') === 1, w.calls);
  check('sandbox fetched once (shared run)', w.count('sandbox') <= 2, w.calls);
  const w2 = world();
  const s2 = w2.svc();
  w2.hold('sandbox'); // 첫 일은 멈춰 둔다
  const n1 = await s2.enqueue([w2.ref('c1'), w2.ref('c1'), w2.ref('c2')]);
  const n2 = await s2.enqueue([w2.ref('c1'), w2.ref('c2')]);
  check('enqueue dedups', n1 === 2 && n2 === 0, [n1, n2]);
  check('two job records', [...w2.store.keys()].filter((k) => k.startsWith('labprep:')).length === 2);
}

// ── 3. 기존 setup·opened 보존 ──
console.log('preserve existing setup/opened');
for (const [name, init] of [['ok', { setup: { state: 'ok', at: 1, note: 'old' } }], ['error', { setup: { state: 'error', at: 1, note: 'bad zip' } }], ['opened no setup', { opened: 5 }]]) {
  const w = world(); w.healthy.sb1 = true;
  Object.assign(w.seat.c1, structuredClone(init));
  const r = await w.svc().ensure(w.ref('c1'));
  check(`${name}: ready`, r.status === 'ready', r);
  check(`${name}: no install`, w.count('install') === 0);
  check(`${name}: no setup patch`, w.patches.length === 0, w.patches);
  check(`${name}: unchanged`, JSON.stringify(w.seat.c1.setup) === JSON.stringify(init.setup) && w.seat.c1.opened === init.opened);
  if (name === 'error') check('error: materials warning preserved via setup', r.setup?.note === 'bad zip');
}
{
  const w = world({ materials: null }); w.healthy.sb1 = true;
  const r = await w.svc().ensure(w.ref('c1'));
  check('no materials: ready without install/patch', r.status === 'ready' && w.count('install') === 0 && w.patches.length === 0);
}

// ── 4. 예전 '진행 중'·주인 없는 running ──
console.log('legacy running');
{
  const w = world(); w.healthy.sb1 = true;
  w.seat.c1.setup = { state: 'running', at: 1, note: '' };
  const r = await w.svc().ensure(w.ref('c1'));
  check('legacy running → no install', w.count('install') === 0);
  check('legacy running → uncertain error', w.seat.c1.setup.state === 'error' && w.seat.c1.setup.note === PREP_UNCERTAIN, w.seat.c1.setup);
  check('legacy running → final error, never ready', r.status === 'error' && r.final && r.message === PREP_UNCERTAIN, r);
  check('legacy running → no external op at all (fail closed first)', w.calls.length === 0, w.calls);
  check('legacy running → job uncertain', w.store.get(prepJobKey('c1'))?.phase === 'uncertain');
  check('prepUncertain helper', prepUncertain(w.seat.c1.setup) && !prepUncertain({ state: 'error', at: 1, note: 'bad zip' }));
  w.setT(w.now() + 10 * 60e3); // 예전 3분 stale 이 지나도
  const r2 = await w.svc().ensure(w.ref('c1'));
  check('no stale retry later', w.count('install') === 0 && r2.status === 'error' && r2.message === PREP_UNCERTAIN, r2);
  w.setT(w.now() + 2 * PREP_KEEP);
  const s3 = w.svc();
  await s3.alarm(w.now());
  check('uncertain job never cleaned by elapsed time', w.store.get(prepJobKey('c1'))?.phase === 'uncertain');
  check('uncertain still blocks after retention/restart', (await s3.ensure(w.ref('c1'))).status === 'error' && (await s3.enqueue([w.ref('c1')])) === 0 && w.count('install') === 0);
  // 일 기록이 없어져도 setup 표시만으로 막힌다
  w.store.delete(prepJobKey('c1'));
  const r4 = await w.svc().ensure(w.ref('c1'));
  check('uncertain setup alone blocks (no job record)', r4.status === 'error' && r4.message === PREP_UNCERTAIN && w.count('install') === 0 && !w.store.has(prepJobKey('c1')), r4);
  // 강사가 실습실을 새로 만듦 (새 샌드박스, setup 비움) → 그때만 다시 준비
  w.seat.c1.sandboxId = 'sbN'; w.sb.sbN = 'started'; w.healthy.sbN = true; delete w.seat.c1.setup;
  const r5 = await w.svc().ensure(w.ref('c1'));
  check('manual recreate is the recovery path', r5.status === 'ready' && w.count('install') === 1, r5);
}

// ── 5. 다시 뜬 뒤 단계 ──
console.log('restart phases');
{
  const w = world(); w.healthy.sb1 = true;
  const s = w.svc();
  const g = w.hold('install');
  const p = s.ensure(w.ref('c1'));
  await flush();
  check('install pending', w.count('install') === 1 && w.store.get(prepJobKey('c1'))?.phase === 'install');
  check('ownership persisted before install', w.patches[0]?.setup.state === 'running');
  // 서버가 다시 뜸: 새 인스턴스, 저장소만 남음
  const s2 = w.svc();
  const next = await s2.alarm(w.now());
  await flush(); await Promise.allSettled(w.bg); await flush();
  check('restart: no install replay', w.count('install') === 1, w.calls);
  check('restart: setup uncertain error', w.seat.c1.setup.state === 'error' && w.seat.c1.setup.note === PREP_UNCERTAIN, w.seat.c1.setup);
  check('restart: job terminal uncertain', w.store.get(prepJobKey('c1'))?.phase === 'uncertain');
  const r2 = await s2.ensure(w.ref('c1'));
  check('restart: join while original install still held → final error, not ready', r2.status === 'error' && r2.final && r2.message === PREP_UNCERTAIN, r2);
  w.setT(w.now() + PREP_DEADLINE + 31e3);
  const r2b = await w.svc().ensure(w.ref('c1'));
  check('restart: still uncertain after 30s/deadline/another restart', r2b.status === 'error' && r2b.message === PREP_UNCERTAIN && w.count('install') === 1, r2b);
  check('restart: no health/editor called as fake proof', w.count('health') === 0 && w.count('editor') === 0, w.calls);
  g.resolve('late ok'); const r = await p; await flush();
  check('old instance late result does not overwrite', w.seat.c1.setup.note === PREP_UNCERTAIN && r.status === 'gone', [w.seat.c1.setup, r]);
  check('after late finish still uncertain', (await s2.ensure(w.ref('c1'))).status === 'error');
  check('alarm returns number|null', next === null || typeof next === 'number');
}
{
  // install 단계로 적었지만 running 을 못 적고 죽음 → 시작도 안 한 것: 넣는다 (한 번)
  const w = world(); w.healthy.sb1 = true;
  const job = { ref: w.ref('c1'), op: 'dead-op', phase: 'install', created: w.now(), deadline: w.now() + PREP_DEADLINE, due: w.now(), tries: 0, editors: 0 };
  w.store.set(prepJobKey('c1'), job);
  const s = w.svc();
  await s.alarm(w.now()); await Promise.allSettled(w.bg); await flush();
  check('install-phase without running: installs once', w.count('install') === 1 && w.seat.c1.setup?.state === 'ok', [w.calls, w.seat.c1.setup]);
}
{
  // editor 단계에서 죽음: 확인부터, 바로 다시 켜지 않음
  const w = world();
  const job = { ref: w.ref('c1'), op: 'dead-op', phase: 'editor', created: w.now(), deadline: w.now() + PREP_DEADLINE, due: w.now(), tries: 0, editors: 1, editorAt: w.now() };
  w.seat.c1.setup = { state: 'ok', at: 1, note: 'x' };
  w.store.set(prepJobKey('c1'), job);
  const s = w.svc();
  await s.alarm(w.now()); await Promise.allSettled(w.bg); await flush();
  check('restart editor: health probed', w.count('health') === 1);
  check('restart editor: no duplicate editor start', w.count('editor') === 0, w.calls);
  check('restart editor: still probing', w.store.get(prepJobKey('c1'))?.phase === 'probe');
}

// ── 6. 매 await 중 끝내기·만료·멈춤 ──
console.log('cancel/end/expiry during each held await');
for (const op of ['sandbox', 'wake', 'install', 'health', 'editor']) {
  for (const how of ['cancel', 'end', 'replace']) {
    const w = world();
    if (op === 'wake') w.sb.sb1 = 'stopped';
    if (op === 'editor') w.healthy.sb1 = false; else w.healthy.sb1 = true;
    if (op === 'health' || op === 'editor') w.seat.c1.setup = { state: 'ok', at: 1, note: 'x' };
    const s = w.svc();
    const g = w.hold(op);
    const p = s.ensure(w.ref('c1'));
    await flush();
    check(`${op}/${how}: op held`, w.count(op) === 1, w.calls);
    const before = { patches: w.patches.length, calls: w.calls.length, setup: structuredClone(w.seat.c1.setup) };
    if (how === 'cancel') await s.cancelLab('L1');
    else if (how === 'end') w.lab.ended = true;
    else { const j = w.store.get(prepJobKey('c1')); w.store.set(prepJobKey('c1'), { ...j, op: 'other-owner', due: w.now() + 3600e3 }); } // 다른 주인 (그 주인이 돌리는 중)
    g.resolve(op === 'install' ? 'late' : op === 'health' ? true : op === 'sandbox' ? { id: 'sb1', state: w.sb.sb1 } : undefined);
    const r = await p; await flush(); await Promise.allSettled(w.bg); await flush();
    check(`${op}/${how}: gone`, r.status === 'gone', r);
    check(`${op}/${how}: no further external op`, w.calls.length === before.calls, w.calls.slice(before.calls));
    check(`${op}/${how}: no late setup save`, JSON.stringify(w.seat.c1.setup) === JSON.stringify(before.setup) && w.patches.filter((x) => x.ok).length === before.patches - (before.patches && 0), [w.seat.c1.setup, w.patches]);
    if (how === 'cancel') {
      check(`${op}/cancel: job gone, fence kept`, !w.store.has(prepJobKey('c1')) && w.store.has(prepStopKey('L1')));
      const n = await s.enqueue([w.ref('c1'), w.ref('c2')]);
      const r2 = await s.ensure(w.ref('c2'));
      check(`${op}/cancel: no resurrection`, n === 0 && r2.status === 'gone' && !w.store.has(prepJobKey('c1')) && !w.store.has(prepJobKey('c2')));
      const s2 = w.svc(); // 다시 뜬 뒤에도 표시로 막힌다
      check(`${op}/cancel: fence survives restart`, (await s2.enqueue([w.ref('c3')])) === 0 && (await s2.ensure(w.ref('c3'))).status === 'gone');
    }
    if (how === 'replace') check(`${op}/replace: new owner record untouched`, w.store.get(prepJobKey('c1'))?.op === 'other-owner');
  }
}
{
  // cancelLab 이 enqueue 와 겹쳐도 되살아나지 않음
  const w = world();
  const s = w.svc();
  w.hold('sandbox');
  const e = s.enqueue([w.ref('c1'), w.ref('c2'), w.ref('c3')]);
  const c = s.cancelLab('L1');
  await Promise.all([e, c]); await flush(); await Promise.allSettled(w.bg); await flush();
  check('racing enqueue/cancel: no job records', [...w.store.keys()].filter((k) => k.startsWith('labprep:')).length === 0, [...w.store.keys()]);
}
{
  // 만료: 자료 넣는 중 끝 시각(시간 제한) — 결과를 쓰지 않고 자리도 계속 센다
  const w = world(); w.healthy.sb1 = true; w.healthy.sb2 = true;
  const s = w.svc();
  const g = w.hold('install');
  const p = s.ensure(w.ref('c1'));
  await flush();
  await w.advance(PREP_DEADLINE + 1);
  const r = await p;
  check('install deadline: final uncertain error', r.status === 'error' && r.final && r.message === PREP_UNCERTAIN, r);
  check('install deadline: setup uncertain (not ok, not ordinary error)', prepUncertain(w.seat.c1.setup), w.seat.c1.setup);
  check('install deadline: job uncertain', w.store.get(prepJobKey('c1'))?.phase === 'uncertain');
  const r2 = await s.ensure(w.ref('c2'));
  check('orphaned install still holds the slot', r2.status === 'starting' && r2.detail === PREP_QUEUED && w.count('install', 'c2') === 0, r2);
  g.resolve('finally done'); await flush(); await Promise.allSettled(w.bg); await flush();
  check('late install result not saved', w.seat.c1.setup.note === PREP_UNCERTAIN);
  check('slot freed after real finish → c2 proceeds', w.count('install', 'c2') === 1 && w.seat.c2.setup?.state === 'ok', [w.calls, w.seat.c2]);
  const r3 = await s.ensure(w.ref('c1'));
  check('uncertain: join right after gets final error', r3.status === 'error' && r3.final && r3.message === PREP_UNCERTAIN);
  w.setT(w.now() + 31e3);
  const r4 = await s.ensure(w.ref('c1'));
  check('uncertain: never retried/ready later, no reinstall', w.count('install', 'c1') === 1 && r4.status === 'error' && r4.message === PREP_UNCERTAIN, [r4, w.calls]);
}

{
  // 끝나지 않는 자료 넣기: 실제로 끝날 때까지 자리·자료 넣기 자리를 잡는다 (시간으로 놓지 않는다)
  const w = world(); w.healthy.sb2 = true;
  const s = w.svc();
  const g = w.hold('install');
  const p = s.ensure(w.ref('c1'));
  await flush();
  await w.advance(PREP_DEADLINE + 1);
  await p;
  check('hung install: c2 queued while orphan counted', (await s.ensure(w.ref('c2'))).status === 'starting' && w.count('sandbox', 'c2') === 0);
  check('no timed release export', !('PREP_ORPHAN_MAX' in M));
  await w.advance(11 * 60e3); await w.advance(60 * 60e3);
  await s.alarm(w.now()); await flush(); await Promise.allSettled(w.bg); await flush();
  const r2 = await s.ensure(w.ref('c2'));
  check('hung install >10min: slot still occupied, no c2 work', r2.status === 'starting' && w.count('sandbox', 'c2') === 0 && w.count('install', 'c2') === 0, [r2, w.calls]);
  check('hung install: never more than one install in flight', w.fl.max === 1, w.fl.max);
  const r1 = await s.ensure(w.ref('c1'));
  check('hung install: c1 repeat join is uncertain, no bypass', r1.status === 'error' && r1.message === PREP_UNCERTAIN && w.count('install') === 1, r1);
  g.resolve('very late'); await flush(); await Promise.allSettled(w.bg); await flush(); await Promise.allSettled(w.bg); await flush();
  check('hung install: slot released only after actual settle → c2 proceeds', w.count('install', 'c2') === 1 && w.seat.c2.setup?.state === 'ok', [w.calls, w.seat.c2]);
  check('hung install: c1 still uncertain', prepUncertain(w.seat.c1.setup));
}

// ── 7. 동시 개수 ──
console.log('bounded concurrency');
{
  const w = world({ seats: 5 });
  const s = w.svc();
  const holds = [1, 2, 3, 4, 5].map(() => w.hold('sandbox'));
  const n = await s.enqueue(['c1', 'c2', 'c3', 'c4', 'c5'].map(w.ref));
  await flush();
  check('enqueued five', n === 5);
  check('only one in flight', w.count('sandbox') === 1, w.calls);
  const r = await s.ensure(w.ref('c4'));
  check('foreground ensure does not bypass limit', r.status === 'starting' && r.detail === PREP_QUEUED && w.count('sandbox') === 1, r);
  for (let i = 0; i < holds.length; i++) {
    check(`step ${i}: one sandbox call per finished job`, w.count('sandbox') === i + 1, w.calls);
    holds[i].resolve({ id: 'x', state: 'started' }); // id 가 다르면 실패로 닫힌다 — 개수만 본다
    await flush(60);
  }
  check('never more than one external call in flight', w.fl.max === 1, w.fl.max);
  check('all five eventually ran', w.count('sandbox') >= 5, w.calls);
  const w2 = world({ seats: 30 });
  for (let i = 4; i <= 30; i++) { w2.seat['c' + i] = { n: i, sandboxId: 'sb' + i }; w2.sb['sb' + i] = 'started'; }
  w2.hold('sandbox');
  const refs = Array.from({ length: 30 }, (_, i) => w2.ref('c' + (i + 1)));
  const k = await w2.svc().enqueue(refs);
  check('batch bounded', k === PREP_BATCH_MAX, k);
}

// ── 8. 미리 준비된 자리가 나중에 편집기가 죽음 ──
console.log('prewarmed then unhealthy');
{
  const w = world(); w.healthy.sb1 = true;
  const s = w.svc();
  await s.enqueue([w.ref('c1')]);
  await flush(); await Promise.allSettled(w.bg); await flush();
  check('background prewarm ready', w.store.get(prepJobKey('c1'))?.phase === 'ready' && w.count('install') === 1);
  w.healthy.sb1 = false;
  const h0 = w.count('health');
  const r = await s.ensure(w.ref('c1'));
  check('join rechecks health even after ready', w.count('health') === h0 + 1);
  check('unhealthy → editor start, starting', r.status === 'starting' && w.count('editor') === 1, r);
  const r2 = await s.ensure(w.ref('c1'));
  check('no duplicate editor start while pending', w.count('editor') === 1 && r2.status === 'starting');
  w.setT(w.now() + PREP_EDITOR_WAIT);
  await s.ensure(w.ref('c1'));
  check('editor restarted only after wait', w.count('editor') === 2);
  w.setT(w.now() + PREP_EDITOR_WAIT);
  await s.ensure(w.ref('c1'));
  check('editor starts bounded', w.count('editor') === 2);
  check('no reinstall', w.count('install') === 1);
  const n = await s.enqueue([w.ref('c1')]);
  check('enqueue of existing job is no-op', n === 0);
}

// ── 9. 끝내는 오류·끝 시각 ──
console.log('terminal errors');
{
  const w = world(); w.sb.sb1 = 'error';
  const r = await w.svc().ensure(w.ref('c1'));
  check('bad sandbox state → final error', r.status === 'error' && r.final && /error/.test(r.message), r);
  check('no install on bad sandbox', w.count('install') === 0 && w.patches.length === 0);
}
{
  const w = world(); w.sb.sb1 = 'starting';
  const s = w.svc();
  let r;
  for (let i = 0; i < 100 && r?.status !== 'error'; i++) { r = await s.ensure(w.ref('c1')); w.setT(w.now() + 5e3); }
  check('waking forever → bounded final error', r.status === 'error' && r.final, r);
  const calls = w.count('sandbox');
  check('bounded probes', calls <= 61, calls);
}
{
  const w = world(); w.healthy.sb1 = true;
  const s = w.svc();
  const g = w.hold('sandbox');
  const p = s.ensure(w.ref('c1'));
  await flush();
  await w.advance(60e3);
  const r = await p;
  check('hung sandbox call times out (not stuck)', r.status === 'starting', r);
  g.resolve({ id: 'sb1', state: 'started' }); await flush(); await Promise.allSettled(w.bg); await flush();
  check('slot released after hung call settles', (await s.ensure(w.ref('c1'))).status === 'ready');
}
{
  const w = world(); w.healthy.sb1 = true;
  const g = w.hold('install');
  const p = w.svc().ensure(w.ref('c1'));
  await flush();
  g.reject(new Error('Daytona 500: boom'));
  const r = await p;
  check('install error → ready with materials warning (labReady compatible)', r.status === 'ready' && r.setup?.state === 'error' && r.setup.note === 'Daytona 500: boom', r);
}

// ── 9b. 저장(put) await 중 끝내기·자리 바뀜 — 모든 자기 단계 저장 ──
console.log('cancel/replace during each held storage put');
for (const phase of ['queued', 'wake', 'install', 'editor', 'ready', 'failed']) {
  for (const how of ['cancel', 'recreate']) {
    const w = world();
    if (phase === 'wake') w.sb.sb1 = 'stopped';
    if (phase === 'failed') w.sb.sb1 = 'error';
    if (phase === 'editor' || phase === 'ready') w.seat.c1.setup = { state: 'ok', at: 1, note: 'x' };
    w.healthy.sb1 = phase === 'ready';
    const s = w.svc();
    const h = w.holdPut((k, v) => k === prepJobKey('c1') && v.phase === phase && (phase !== 'queued' || !!v.started));
    const p = s.ensure(w.ref('c1'));
    await flush();
    const tag = `${phase}/${how}`;
    check(`${tag}: put held`, h.hit, w.calls);
    const nCalls = w.calls.length, okPatches = w.patches.filter((x) => x.ok).length;
    let p2 = null;
    if (how === 'cancel') {
      const c = s.cancelLab('L1');
      await flush();
      h.d.resolve(); await c;
    } else {
      w.seat.c1.sandboxId = 'sbR'; w.sb.sbR = 'started'; w.healthy.sbR = true; // State 가 자리 실습실을 새로 만듦
      p2 = s.ensure(w.ref('c1'));
      await flush();
      h.d.resolve();
    }
    const r = await p; await flush(); await Promise.allSettled(w.bg); await flush();
    const late = w.calls.slice(nCalls).filter((c) => c[2] === 'sb1');
    check(`${tag}: no external op on old seat after held put`, late.length === 0, late);
    check(`${tag}: never ready for old ref`, r.status !== 'ready', r);
    if (phase !== 'failed') check(`${tag}: old run gone`, r.status === 'gone', r);
    if (how === 'cancel') {
      check(`${tag}: no late setup save`, w.patches.filter((x) => x.ok).length === okPatches, w.patches);
      check(`${tag}: no resurrection`, !w.store.has(prepJobKey('c1')) && w.store.has(prepStopKey('L1')), [...w.store.keys()]);
      check(`${tag}: later enqueue/ensure blocked`, (await s.enqueue([w.ref('c1')])) === 0 && (await s.ensure(w.ref('c1'))).status === 'gone' && !w.store.has(prepJobKey('c1')));
    } else {
      await p2; await flush(); await Promise.allSettled(w.bg); await flush(); await Promise.allSettled(w.bg); await flush();
      const cur = w.store.get(prepJobKey('c1'));
      check(`${tag}: replacement record kept (not overwritten/deleted by old run)`, cur?.ref.sandboxId === 'sbR', cur);
      const r3 = await s.ensure(w.ref('c1'));
      check(`${tag}: replacement proceeds on new sandbox`, r3.status === 'ready' && w.calls.some((c) => c[2] === 'sbR'), [r3, cur]);
    }
  }
}

// ── 9c. ref 네 값 (n 포함) ──
console.log('full ref identity');
{
  const w = world(); w.healthy.sb1 = true;
  const s = w.svc();
  const g = w.hold('sandbox');
  const good = w.ref('c1');
  const p = s.ensure(good);
  await flush();
  const bad = { ...good, n: 9 };
  const pb = s.ensure(bad);
  check('n-mismatched ref does not share live promise', pb !== p);
  const rb = await pb;
  check('n-mismatched ref → gone', rb.status === 'gone', rb);
  check('n-mismatched ref wrote nothing', w.store.get(prepJobKey('c1'))?.ref.n === 1 && w.patches.length === 0);
  g.resolve({ id: 'sb1', state: 'started' });
  const r = await p;
  check('original ref still ready', r.status === 'ready', r);
  check('stale ref enqueue no-op', (await s.enqueue([{ ...good, sandboxId: 'old' }, { ...good, n: 2 }])) === 0);
  const rs = await s.ensure({ ...good, sandboxId: 'old' });
  check('stale sandbox ref → gone without write', rs.status === 'gone' && w.store.get(prepJobKey('c1'))?.ref.sandboxId === 'sb1', rs);
}
{
  // 바깥 호출 중 State 가 실습실을 새로 만듦 → 새 ref 로 입장: 옛 일은 바뀐 것으로 멈추고 새 일만 돈다
  const w = world(); w.healthy.sb1 = true;
  const s = w.svc();
  const g = w.hold('sandbox');
  const p = s.ensure(w.ref('c1'));
  await flush();
  w.seat.c1.sandboxId = 'sbR'; w.sb.sbR = 'started'; w.healthy.sbR = true;
  const r2 = await s.ensure(w.ref('c1'));
  check('replace during external op: new ref queued (does not share old promise)', r2.status === 'starting', r2);
  const newOp = w.store.get(prepJobKey('c1'))?.op;
  g.resolve({ id: 'sb1', state: 'started' });
  const r = await p; await flush(); await Promise.allSettled(w.bg); await flush(); await Promise.allSettled(w.bg); await flush();
  check('replace during external op: old run gone, no further sb1 op', r.status === 'gone' && w.calls.filter((c) => c[2] === 'sb1').length === 1, [r, w.calls]);
  check('replace: settle did not delete replacement op', w.store.get(prepJobKey('c1'))?.op === newOp);
  const r3 = await s.ensure(w.ref('c1'));
  check('replace: new ref ready', r3.status === 'ready' && w.count('install') === 1, [r3, w.calls]);
}

// ── 9d. 줄 크기 — enqueue·ensure 가 겹쳐도 40 을 넘지 않음 ──
console.log('bounded queue admission');
{
  const w = world({ seats: 70 });
  const s = w.svc();
  w.hold('sandbox');
  const refs = Array.from({ length: 70 }, (_, i) => w.ref('c' + (i + 1)));
  const work = [s.enqueue(refs.slice(0, 20)), s.enqueue(refs.slice(20, 40)), s.enqueue(refs.slice(40, 60))];
  const joins = refs.slice(60, 70).map((r) => s.ensure(r)); // 하나는 붙잡힌 호출을 기다릴 수 있다 — 끝을 기다리지 않는다
  await Promise.all(work); await flush(200);
  const settled = (await Promise.all(joins.map((j) => Promise.race([j, flush(50).then(() => null)])))).filter(Boolean);
  check('foreground joins queued (bounded)', settled.every((x) => x.status === 'starting') && settled.length >= 9, settled);
  const open = [...w.store.values()].filter((j) => j && j.phase && !['ready', 'failed', 'uncertain'].includes(j.phase)).length;
  check('open jobs never exceed PREP_QUEUE_MAX under concurrent enqueue+ensure', open <= PREP_QUEUE_MAX && open >= 20, open);
  check('one external call in flight', w.fl.max === 1, w.fl.max);
}

// ── 9e. 정리 시각 ──
console.log('retention scheduling');
{
  const w = world(); w.healthy.sb1 = true;
  const s = w.svc();
  const r = await s.ensure(w.ref('c1'));
  await flush(); await Promise.allSettled(w.bg);
  const end = w.store.get(prepJobKey('c1')).endedAt;
  check('ready job schedules its retention cleanup', r.status === 'ready' && w.scheduled.includes(end + PREP_KEEP + 1), w.scheduled);
  const next = await s.alarm(w.now());
  check('alarm with no open job still returns retention time', next === end + PREP_KEEP + 1, next);
  w.setT(end + PREP_KEEP + 2);
  check('alarm after retention removes ready record', (await s.alarm(w.now())) === null && !w.store.has(prepJobKey('c1')));
  const t0 = w.now();
  await s.cancelLab('L1'); await Promise.allSettled(w.bg);
  check('cancel schedules stop cleanup', w.scheduled.includes(t0 + PREP_KEEP + 1), w.scheduled.slice(-3));
  check('alarm returns stop cleanup time', (await s.alarm(w.now())) === t0 + PREP_KEEP + 1);
  w.setT(t0 + PREP_KEEP + 2);
  check('stop removed after retention', (await s.alarm(w.now())) === null && !w.store.has(prepStopKey('L1')));
}

// ── 9f. setup 'running' 쓰는 await 중 만료·끝 시각·바뀜 → 자료 넣기 시작 안 함 ──
console.log('held running patch');
for (const how of ['expire', 'deadline', 'recreate', 'cancel']) {
  const w = world(); w.healthy.sb1 = true;
  const s = w.svc();
  const h = w.holdPatch('running');
  const p = s.ensure(w.ref('c1'));
  await flush();
  check(`patch/${how}: running patch held`, h.hit && w.seat.c1.setup?.state === 'running', w.seat.c1.setup);
  if (how === 'expire') w.lab.ended = true;
  else if (how === 'deadline') w.setT(w.now() + PREP_DEADLINE + 1);
  else if (how === 'recreate') { w.seat.c1.sandboxId = 'sbR'; w.sb.sbR = 'started'; }
  const c = how === 'cancel' ? s.cancelLab('L1') : null;
  await flush();
  h.d.resolve(); await c;
  const r = await p; await flush(); await Promise.allSettled(w.bg); await flush();
  check(`patch/${how}: no install`, w.count('install') === 0, w.calls);
  check(`patch/${how}: not ready`, r.status !== 'ready', r);
  if (how === 'deadline') {
    check('patch/deadline: final timeout error, job failed (not uncertain — install never started)', r.status === 'error' && r.message === PREP_TIMEOUT && w.store.get(prepJobKey('c1'))?.phase === 'failed', [r, w.store.get(prepJobKey('c1'))]);
    check('patch/deadline: setup ordinary error', w.seat.c1.setup?.state === 'error' && w.seat.c1.setup.note === PREP_TIMEOUT, w.seat.c1.setup);
  } else check(`patch/${how}: gone`, r.status === 'gone', r);
  if (how === 'expire' || how === 'cancel') check(`patch/${how}: no further external op`, w.calls.filter((x) => x[0] !== 'sandbox').length === 0, w.calls);
  if (how !== 'deadline') check(`patch/${how}: running persisted (install never started)`, w.seat.c1.setup?.state === 'running', w.seat.c1.setup);
  // 뒤이은 알람·다시 뜬 인스턴스·입장에서도 옛 샌드박스에 자료를 넣지 않는다
  w.setT(w.now() + 31e3);
  await s.alarm(w.now()); await flush(); await Promise.allSettled(w.bg); await flush();
  const s2 = w.svc();
  await s2.alarm(w.now()); await flush(); await Promise.allSettled(w.bg); await flush();
  const again = await s2.ensure({ labId: 'L1', n: 1, code: 'c1', sandboxId: 'sb1' });
  check(`patch/${how}: zero install on sb1 after release, alarm and restart`, w.calls.filter((x) => x[0] === 'install' && x[2] === 'sb1').length === 0, [again, w.calls]);
  if (how === 'deadline') check('patch/deadline: later join = ordinary materials warning (install never started), no install', again.status === 'ready' && again.setup?.note === PREP_TIMEOUT, again);
  else if (how === 'recreate') check('patch/recreate: old ref gone', again.status === 'gone', again);
  else check(`patch/${how}: later join not ready`, again.status !== 'ready', again);
  if (how === 'recreate') {
    // 새 샌드박스는 State 가 setup 을 비운 뒤 새로 준비 (옛 'running' 은 옛 샌드박스 것)
    delete w.seat.c1.setup; w.healthy.sbR = true;
    const r3 = await s2.ensure(w.ref('c1'));
    check('patch/recreate: new sandbox prepared once', r3.status === 'ready' && w.calls.filter((x) => x[0] === 'install' && x[2] === 'sbR').length === 1, [r3, w.calls]);
  }
}
{
  // 내가 쓴 'running' 은 주인 없는 것으로 보지 않는다 (보통 흐름은 그대로 ok)
  const w = world(); w.healthy.sb1 = true;
  const h = w.holdPatch('running');
  const p = w.svc().ensure(w.ref('c1'));
  await flush(); h.d.resolve();
  const r = await p;
  check('own running not classified as orphan', r.status === 'ready' && w.seat.c1.setup?.state === 'ok' && w.count('install') === 1, [r, w.seat.c1.setup]);
}

// ── 9f2. 앞 저장·확인(fresh)을 기다리는 사이 끝 시각이 지남 → 켜기·확인·편집기 호출을 시작하지 않음 ──
console.log('deadline crossed during held write/fresh before wake/health/editor');
for (const op of ['wake', 'health', 'editor']) {
  for (const where of ['put', 'fresh']) {
    for (const past of [0, 1]) { // 끝 시각 정확히(남은 0) · 지나서
      const w = world();
      if (op === 'wake') w.sb.sb1 = 'stopped';
      else w.seat.c1.setup = { state: 'ok', at: 1, note: 'x' };
      w.healthy.sb1 = op === 'health';
      const phase = op === 'health' ? 'probe' : op; // 그 호출 바로 앞에서 쓰는 일 기록 단계
      const tag = `${op}/${where}/+${past}`;
      let held, release;
      if (where === 'put') {
        const h = w.holdPut((k, v) => k === prepJobKey('c1') && v.phase === phase);
        held = () => h.hit; release = () => h.d.resolve();
      } else {
        const d = deferred();
        let arm = false, hit = false;
        w.holdPut((k, v) => { if (k === prepJobKey('c1') && v.phase === phase) arm = true; return false; }); // 붙잡지 않고 표시만
        const orig = w.deps.active;
        w.deps.active = async (r) => { if (arm) { arm = false; hit = true; await d.p; } return orig(r); }; // 그 저장 뒤 첫 fresh 의 active 를 붙잡는다
        held = () => hit; release = () => d.resolve();
      }
      const s = w.svc();
      const p = s.ensure(w.ref('c1'));
      await flush();
      check(`${tag}: held before ${op}`, held() && w.count(op) === 0, w.calls);
      const job = w.store.get(prepJobKey('c1'));
      w.setT(job.deadline + past);
      const nCalls = w.calls.length;
      release();
      const r = await p; await flush(); await Promise.allSettled(w.bg); await flush();
      check(`${tag}: ${op} never invoked after deadline`, w.count(op) === 0, w.calls);
      check(`${tag}: no later external op after release`, w.calls.length === nCalls, w.calls.slice(nCalls));
      check(`${tag}: not ready, no setup change`, r.status === 'starting' && JSON.stringify(w.seat.c1.setup) === JSON.stringify(op === 'wake' ? undefined : { state: 'ok', at: 1, note: 'x' }) && w.patches.length === 0, [r, w.seat.c1.setup, w.patches]);
      const r2 = await s.ensure(w.ref('c1')); await flush(); await Promise.allSettled(w.bg); await flush();
      check(`${tag}: next run closes with ordinary timeout, still no external op`, r2.status === 'error' && r2.final && r2.message === PREP_TIMEOUT && w.store.get(prepJobKey('c1'))?.phase === 'failed' && w.calls.length === nCalls, [r2, w.calls.slice(nCalls)]);
    }
  }
}
{
  // 남은 시간이 NaN(망가진 기록) 이어도 호출을 시작하지 않는다
  const w = world(); w.healthy.sb1 = true;
  const t = w.now();
  w.store.set(prepJobKey('c1'), { ref: w.ref('c1'), op: 'nan-op', phase: 'probe', created: t, started: t, deadline: NaN, due: t, tries: 0, editors: 0 });
  const s = w.svc();
  await s.alarm(t); await flush(); await Promise.allSettled(w.bg); await flush();
  check('non-finite budget: no external op invoked', w.calls.length === 0, w.calls);
  check('non-finite budget: job not ready', w.store.get(prepJobKey('c1'))?.phase !== 'ready', w.store.get(prepJobKey('c1')));
}
{
  // 남은 시간이 있으면 그대로 부른다 (끝 시각 1ms 전)
  const w = world(); w.sb.sb1 = 'stopped';
  const h = w.holdPut((k, v) => k === prepJobKey('c1') && v.phase === 'wake');
  const s = w.svc();
  const p = s.ensure(w.ref('c1'));
  await flush();
  w.setT(w.store.get(prepJobKey('c1')).deadline - 1);
  h.d.resolve(); await p; await flush();
  check('positive budget: wake still invoked', w.count('wake') === 1, w.calls);
}

// ── 9g. 자리가 찬 동안 1초마다 알람을 걸지 않음 ──
console.log('no busy-loop while slot is held');
{
  const w = world(); w.healthy.sb2 = true; w.healthy.sb3 = true;
  const s = w.svc();
  const g = w.hold('install');
  const p = s.ensure(w.ref('c1'));
  await flush();
  await w.advance(PREP_DEADLINE + 1); await p; // 기다림은 그만뒀지만 호출은 살아 있음 → 자리 계속 잡힘
  const from = w.scheduled.length, t0 = w.now();
  await s.enqueue([w.ref('c2'), w.ref('c3')]);
  await flush(); await Promise.allSettled(w.bg); await flush();
  const r2 = await s.ensure(w.ref('c2'));
  for (let i = 0; i < 5; i++) { await w.advance(30e3); await s.alarm(w.now()); await flush(); await Promise.allSettled(w.bg); }
  const soon = w.scheduled.slice(from).filter((at) => at < t0 + 29e3);
  check('held slot: no ~1s alarm polling (>=30s fallback only)', r2.status === 'starting' && soon.length === 0, w.scheduled.slice(from).map((x) => x - t0));
  check('held slot: alarms bounded', w.scheduled.length - from <= 20, w.scheduled.length - from);
  check('held slot: no work started', w.count('sandbox', 'c2') === 0 && w.count('sandbox', 'c3') === 0);
  g.resolve('late'); await flush(); for (let i = 0; i < 6; i++) { await Promise.allSettled(w.bg); await flush(); }
  check('completion kick starts queued work without alarm', w.count('install', 'c2') + w.count('install', 'c3') >= 1, w.calls);
}
{
  // 다시 뜬 인스턴스: 앞 인스턴스의 자료 넣기는 멈췄다고 증명 못 함 → 같은 샌드박스는 막고, 다른 자리는 이어 간다 (인스턴스 안 보장만)
  const w = world(); w.healthy.sb1 = true; w.healthy.sb2 = true;
  const s = w.svc();
  w.hold('install');
  void s.ensure(w.ref('c1'));
  await flush();
  const s2 = w.svc();
  const r1 = await s2.ensure(w.ref('c1'));
  const r2 = await s2.ensure(w.ref('c2'));
  check('restart: same sandbox fail closed', r1.status === 'error' && r1.message === PREP_UNCERTAIN && w.count('install', 'c1') === 1, r1);
  check('restart: other seat continues (per-incarnation limit, documented)', r2.status === 'ready' && w.count('install', 'c2') === 1, r2);
}

// ── 9h. 진짜 타이머 (delay 주입 없음): 호출이 먼저 끝나면 타이머가 남지 않는다 ──
console.log('real timers cleared');
{
  const w = world(); w.healthy.sb1 = true; w.sb.sb2 = 'stopped';
  const { delay, ...deps } = w.deps;
  const timeouts = () => process.getActiveResourcesInfo().filter((x) => x === 'Timeout').length;
  const before = timeouts();
  const s = new LabPreparationService(deps);
  const r = await s.ensure(w.ref('c1'));
  const r2 = await s.ensure(w.ref('c2')); // 켜기 경로 (sandbox·wake)
  await flush();
  check('real timers: ops ran', r.status === 'ready' && w.count('wake', 'c2') === 1, [r, r2]);
  check('real timers: no 60s/5min timer left after ops resolved', timeouts() === before, [before, timeouts(), process.getActiveResourcesInfo()]);
  // 실제로 시간이 지나 그만둔 호출은 orphans 로 자리를 잡는다 (짧은 시간 제한으로 확인할 수 없어 주입 delay 테스트가 맡는다)
}

// ── 9i. gate: 호출이 자기 await(키 풀기) 를 지난 뒤 부르는 마지막 확인 ──
// #ext 의 남은 시간 확인은 호출 시작 때뿐이다. 키 풀기를 기다리는 사이 끝 시각·호출 시간·멈춤·바뀜이 지나면 gate 가 거부해야
// 실제 바깥 효과가 늦게 시작되지 않는다. no-op gate(언제나 통과)·gate 없음이면 여기 거부 테스트가 효과를 보고 실패한다.
console.log('gate after own async boundary (deadline / per-call budget / cancel / replace / non-finite)');
for (const op of ['sandbox', 'wake', 'install', 'health', 'editor']) {
  const hows = ['deadline0', 'deadline1', 'timer', 'cancel', 'replace', 'nan', 'ok'];
  if (op !== 'install') hows.splice(2, 0, 'call0'); // 호출 시간(60초)이 끝 시각보다 먼저인 호출만
  for (const how of hows) {
    const w = world();
    if (op === 'wake') w.sb.sb1 = 'stopped';
    w.healthy.sb1 = op !== 'editor';
    if (op === 'health' || op === 'editor') w.seat.c1.setup = { state: 'ok', at: 1, note: 'x' };
    const s = w.svc();
    const d = w.pre(op);
    const u0 = unhandled.length;
    const p = s.ensure(w.ref('c1'));
    await flush();
    const tag = `gate ${op}/${how}`;
    const T0 = w.now();
    const job = w.store.get(prepJobKey('c1'));
    const budget = op === 'install' ? job.deadline - T0 : Math.min(PREP_OP_TIMEOUT, job.deadline - T0);
    check(`${tag}: held inside op before gate`, w.preHit[op] === 1 && w.count(op) === 1 && w.eff(op) === 0, [w.preHit, w.calls]);
    const setup0 = structuredClone(w.seat.c1.setup);
    let p2 = null;
    if (how === 'deadline0') w.setT(job.deadline);          // 남은 0 — 거부
    else if (how === 'deadline1') w.setT(job.deadline + 1);
    else if (how === 'call0') w.setT(T0 + budget);          // 타이머는 안 울렸어도 호출 시간 끝 — 거부 (절대 시각)
    else if (how === 'timer') await w.advance(budget);     // 기다림이 먼저 그만둔 뒤 늦게 풀린 호출
    else if (how === 'cancel') await s.cancelLab('L1');
    else if (how === 'replace') { w.seat.c1.sandboxId = 'sbR'; w.sb.sbR = 'started'; w.healthy.sbR = true; p2 = s.ensure(w.ref('c1')); await flush(); }
    else if (how === 'nan') w.setT(NaN);
    else if (how === 'ok') w.setT(T0 + budget - 1);         // 1ms 남음 — 통과 (이르게 거부하지 않음)
    d.resolve();
    await flush();
    if (how === 'nan') w.setT(T0 + 1);
    const r = await p; await flush(); await Promise.allSettled(w.bg); await flush();
    if (how === 'ok') {
      check(`${tag}: positive remaining budget passes gate, effect starts`, w.eff(op, 'sb1') >= 1 && w.effects[w.calls.findIndex((c) => c[0] === op)]?.[0] === op && !w.denied.some((x) => x[0] === op), [w.denied, w.effects]);
      continue;
    }
    check(`${tag}: gate denied`, w.denied.some((x) => x[0] === op && x[1] === 'c1'), [w.denied, w.missingGate]);
    check(`${tag}: zero remote effect for the held op`, w.eff(op, 'sb1') === 0, w.effects);
    check(`${tag}: handled — not ready, no opened`, r.status !== 'ready' && w.seat.c1.opened === undefined, r);
    check(`${tag}: no unhandled rejection`, unhandled.length === u0, unhandled.slice(u0));
    if (how === 'cancel' || how === 'replace') check(`${tag}: old run gone`, r.status === 'gone', r);
    if (how === 'cancel') check(`${tag}: no job record, fence kept`, !w.store.has(prepJobKey('c1')) && w.store.has(prepStopKey('L1')));
    if (how === 'replace') { await p2; check(`${tag}: replacement record kept`, w.store.get(prepJobKey('c1'))?.ref.sandboxId === 'sbR', w.store.get(prepJobKey('c1'))); }
    if (op === 'install') {
      check(`${tag}: setup never ok`, w.seat.c1.setup?.state !== 'ok', w.seat.c1.setup);
      if (how !== 'cancel' && how !== 'replace') {
        const was = structuredClone(w.seat.c1.setup);
        w.setT(w.now() + 31e3);
        await s.alarm(w.now()); await flush(); await Promise.allSettled(w.bg); await flush();
        const again = await w.svc().ensure(w.ref('c1')); await flush(); await Promise.allSettled(w.bg); await flush();
        check(`${tag}: no install replay after alarm/restart/join`, w.count('install') === 1 && w.eff('install') === 0, [again, w.calls]);
        if (prepUncertain(was)) check(`${tag}: uncertain not overwritten`, prepUncertain(w.seat.c1.setup) && again.status !== 'ready', [w.seat.c1.setup, again]);
      }
    } else if (op === 'health' || op === 'editor') {
      check(`${tag}: setup untouched`, JSON.stringify(w.seat.c1.setup) === JSON.stringify(setup0), w.seat.c1.setup);
    }
    if ((how === 'deadline0' || how === 'deadline1') && op !== 'install') { // install 은 위에서 +31초 뒤 새 일(새 끝 시각)까지 봤다
      const before = w.effects.length;
      const r2 = await s.ensure(w.ref('c1')); await flush(); await Promise.allSettled(w.bg); await flush();
      check(`${tag}: next run after deadline starts no remote effect`, w.effects.length === before && r2.status !== 'ready', [r2, w.effects.slice(before)]);
    }
  }
}
{
  // 이미 gate 를 지나 시작된 자료 넣기: 끝 시각이 지나도 실제로 끝날 때까지 자리·자료 넣기 자리를 잡는다 (끊는지는 보지 않는다)
  const w = world(); w.healthy.sb1 = true; w.healthy.sb2 = true;
  const s = w.svc();
  const g = w.hold('install');
  const p = s.ensure(w.ref('c1'));
  await flush();
  check('started install: gate passed, effect started', w.eff('install', 'sb1') === 1 && w.denied.length === 0, [w.effects, w.denied]);
  await w.advance(PREP_DEADLINE + 1);
  const r = await p;
  check('started install past deadline: uncertain, not ready', r.status === 'error' && r.message === PREP_UNCERTAIN, r);
  const r2 = await s.ensure(w.ref('c2'));
  check('started install keeps permit until settle', r2.status === 'starting' && w.count('sandbox', 'c2') === 0, [r2, w.calls]);
  g.resolve('late'); await flush(); for (let i = 0; i < 4; i++) { await Promise.allSettled(w.bg); await flush(); }
  check('permit released only after settle → c2 installs', w.eff('install', 'sb2') === 1 && w.seat.c2.setup?.state === 'ok' && prepUncertain(w.seat.c1.setup), [w.effects, w.seat]);
}
{
  // 남은 시간 0·NaN: 호출 자체를 부르지 않는다 (gate 까지 가지 않음)
  for (const dl of ['zero', 'nan']) {
    const w = world(); w.healthy.sb1 = true;
    const t = w.now();
    w.store.set(prepJobKey('c1'), { ref: w.ref('c1'), op: `${dl}-op`, phase: 'probe', created: t, started: t, deadline: dl === 'zero' ? t : NaN, due: t, tries: 0, editors: 0 });
    const s = w.svc();
    await s.alarm(t); await flush(); await Promise.allSettled(w.bg); await flush();
    check(`${dl} budget: no op invoked, no gate, no effect`, w.calls.length === 0 && w.effects.length === 0 && w.denied.length === 0, [w.calls, w.denied]);
  }
}

// ── 10. 프로토콜 도우미 ──
console.log('protocol helpers');
{
  const ref = { labId: 'L', n: 1, code: 'c', sandboxId: 's' };
  const job = { ref, op: 'o', phase: 'probe' };
  check('prepOwns ok', prepOwns(job, undefined, ref, 'o') === true);
  check('prepOwns stop', prepOwns(job, { at: 1 }, ref, 'o') === false);
  check('prepOwns other op', prepOwns(job, undefined, ref, 'x') === false);
  check('prepOwns other sandbox', prepOwns(job, undefined, { ...ref, sandboxId: 'z' }, 'o') === false);
  check('prepOwns other n', prepOwns(job, undefined, { ...ref, n: 2 }, 'o') === false);
  check('prepOwns other lab', prepOwns(job, undefined, { ...ref, labId: 'M' }, 'o') === false);
  check('prepOwns uncertain', prepOwns({ ...job, phase: 'uncertain' }, undefined, ref, 'o') === false);
  check('prepOwns terminal', prepOwns({ ...job, phase: 'ready' }, undefined, ref, 'o') === false);
  check('keys', prepJobKey('c') === 'labprep:c' && prepStopKey('L') === 'labprepstop:L');
}

// ── 11. 공유 일의 숫자 관측 (시계 주입, 네트워크 없음) ──
console.log('bounded shared-job timing');
{
  const w = world({ materials: null, costs: { sandbox: 11, health: 17 } }); w.healthy.sb1 = true;
  const s = w.svc(), r = await s.ensure(w.ref('c1'));
  check('timing: measured spans and shared elapsed exact', r.prepTiming.prep_queue === 0 && r.prepTiming.prep_elapsed === 28 && r.prepTiming.prep_sandbox === 11 && r.prepTiming.prep_health === 17, r);
  check('timing: unmeasured install/wake/start/wait omitted', ['prep_materials', 'prep_wake', 'prep_start', 'prep_wait'].every((k) => !(k in r.prepTiming)), r);
  const old = structuredClone(r.prepTiming), op = w.store.get(prepJobKey('c1')).op;
  await w.advance(1000); const r2 = await s.ensure(w.ref('c1'));
  check('timing: ready recheck gets new job, no stale elapsed or sums', w.store.get(prepJobKey('c1')).op !== op && JSON.stringify(r2.prepTiming) === JSON.stringify(old), r2);
}
{
  const w = world({ costs: { sandbox: 5, install: 7, health: 3 } }); w.healthy.sb1 = true;
  const s = w.svc(), g = w.hold('install');
  const a = s.ensure(w.ref('c1')); await flush();
  await w.advance(37); const b = s.ensure(w.ref('c1'));
  g.resolve('ok'); const [ra, rb] = await Promise.all([a, b]); await flush();
  check('timing: concurrent joins share one sample set', w.count('install') === 1 && JSON.stringify(ra.prepTiming) === JSON.stringify(rb.prepTiming), [ra, rb]);
  check('timing: observed install wait includes held span once', ra.prepTiming.prep_materials === 44 && ra.prepTiming.prep_sandbox === 10 && ra.prepTiming.prep_health === 3 && ra.prepTiming.prep_elapsed === 57, ra);
}
{
  const w = world({ materials: null }); w.healthy.sb1 = w.healthy.sb2 = true;
  const s = w.svc(), g = w.hold('sandbox'), a = s.ensure(w.ref('c1')); await flush();
  await s.enqueue([w.ref('c2')]); await w.advance(123);
  const queued = await s.ensure(w.ref('c2'));
  check('timing: queued job only actual queue, no fabricated phases', JSON.stringify(queued.prepTiming) === '{"prep_queue":123}', queued);
  g.resolve({ id: 'sb1', state: 'started' }); await a; await flush();
  check('timing: queued first start freezes queue', w.store.get(prepJobKey('c2')).timing.values.prep_queue === 123, w.store.get(prepJobKey('c2')));
}
{
  const w = world({ materials: null, costs: { sandbox: 11, wake: 7, health: 13, editor: 17 } }); w.sb.sb1 = 'stopped';
  const s = w.svc(); const r1 = await s.ensure(w.ref('c1')); await flush();
  check('timing: wake request observed, readiness still pending', r1.status === 'starting' && r1.prepTiming.prep_sandbox === 11 && r1.prepTiming.prep_wake === 7 && !('prep_health' in r1.prepTiming), r1);
  await w.advance(2000); w.sb.sb1 = 'started';
  const r2 = await s.ensure(w.ref('c1')); await flush();
  check('timing: poll adds actual wait and editor attempt', r2.prepTiming.prep_wait === 2000 && r2.prepTiming.prep_start === 17 && r2.prepTiming.prep_health === 13, r2);
  await w.advance(4000); w.healthy.sb1 = true;
  const r3 = await s.ensure(w.ref('c1'));
  check('timing: sums survive successive polls without double count', r3.status === 'ready' && r3.prepTiming.prep_wait === 6000 && r3.prepTiming.prep_sandbox === 33 && r3.prepTiming.prep_health === 26 && r3.prepTiming.prep_start === 17 && r3.prepTiming.prep_elapsed === 6083, r3);
}
{
  const w = world({ materials: null }); w.healthy.sb1 = true;
  const s = w.svc(), g = w.hold('sandbox'), p = s.ensure(w.ref('c1')); await flush();
  await w.advance(PREP_OP_TIMEOUT + 1); const r = await p; await flush();
  const before = structuredClone(w.store.get(prepJobKey('c1')).timing);
  check('timing: timeout is waiter span, not remote completion', r.status === 'starting' && r.prepTiming.prep_sandbox === PREP_OP_TIMEOUT + 1 && !('prep_health' in r.prepTiming), r);
  g.resolve({ id: 'sb1', state: 'started' }); await flush();
  check('timing: orphan completion cannot add another sample', JSON.stringify(before) === JSON.stringify(w.store.get(prepJobKey('c1')).timing), w.store.get(prepJobKey('c1')));
}
{
  const w = world(); w.healthy.sb1 = true;
  const s = w.svc(), g = w.hold('install'), p = s.ensure(w.ref('c1')); await flush();
  const restarted = w.svc(); await restarted.alarm(w.now()); await flush();
  const terminal = structuredClone(w.store.get(prepJobKey('c1')));
  check('timing: restart interrupted install remains unknown, not zero', terminal.phase === 'uncertain' && !('prep_materials' in terminal.timing.values), terminal);
  await w.advance(10); g.resolve('late'); await p; await flush();
  check('timing: late old instance cannot alter uncertain measurements', JSON.stringify(terminal.timing) === JSON.stringify(w.store.get(prepJobKey('c1')).timing), terminal);
}
{
  const w = world({ materials: null }); w.healthy.sb1 = true;
  const s = w.svc(), g = w.hold('health'), p = s.ensure(w.ref('c1')); await flush();
  const other = { ref: { ...w.ref('c1'), sandboxId: 'new' }, op: 'new-owner', phase: 'queued', created: w.now(), deadline: w.now() + PREP_DEADLINE, due: w.now() + PREP_DEADLINE, tries: 0, editors: 0, timing: { at: w.now(), values: { prep_queue: 77 }, counts: { prep_queue: 1 } } };
  w.seat.c1.sandboxId = 'new'; w.store.set(prepJobKey('c1'), structuredClone(other));
  await w.advance(25); g.resolve(true); const r = await p; await flush();
  check('timing: changed ref/owner prevents late sample writes or disclosure', r.status === 'gone' && !r.prepTiming && JSON.stringify(w.store.get(prepJobKey('c1'))) === JSON.stringify(other), r);
}
{
  const w = world({ materials: null }); w.healthy.sb1 = true;
  const t = w.now(); w.store.set(prepJobKey('c1'), { ref: w.ref('c1'), op: 'legacy', phase: 'probe', created: t, started: t, deadline: t + PREP_DEADLINE, due: t, tries: 0, editors: 0 });
  const r = await w.svc().ensure(w.ref('c1'));
  check('timing: legacy/restarted missing observations remain absent', r.status === 'ready' && JSON.stringify(r.prepTiming) === '{}', r);
}
{
  const w = world({ materials: null }); w.sb.sb1 = 'error';
  const s = w.svc(); const r1 = await s.ensure(w.ref('c1')); await flush();
  const oldOp = w.store.get(prepJobKey('c1')).op;
  await w.advance(30001); w.sb.sb1 = 'started'; w.healthy.sb1 = true;
  const r2 = await s.ensure(w.ref('c1'));
  check('timing: failed job retry resets samples and elapsed', r1.status === 'error' && r2.status === 'ready' && w.store.get(prepJobKey('c1')).op !== oldOp && w.store.get(prepJobKey('c1')).timing.counts.prep_sandbox === 1 && r2.prepTiming.prep_elapsed === 0, r2);
}
{
  const w = world(); w.seat.c1.setup = { state: 'running', at: w.now(), note: '' };
  const s = w.svc(); await s.ensure(w.ref('c1')); await flush();
  const expiry = w.store.get(prepJobKey('c1')).timing.at + PREP_KEEP + 1;
  check('timing: create schedules expiry even when immediately uncertain', w.scheduled.includes(expiry), w.scheduled);
  const restarted = w.svc(), next = await restarted.alarm(w.now()); await flush();
  check('timing: restarted alarm retains uncertain metric expiry as next', next === expiry && w.scheduled.at(-1) === expiry && w.calls.length === 0, [next, w.scheduled]);
  await w.advance(expiry - w.now()); await restarted.alarm(w.now()); await flush();
  const j = w.store.get(prepJobKey('c1'));
  check('timing: scheduled expiry drops metrics, keeps fence, adds no provider calls', j.phase === 'uncertain' && j.timing === undefined && (await restarted.ensure(w.ref('c1'))).status === 'error' && w.calls.length === 0, j);
}

console.log(`\n${pass} passed, ${failN} failed`);
process.exit(failN ? 1 : 0);
