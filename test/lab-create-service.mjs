// 만들기 요청 방벽. 실제 코드 번들 + 가짜 저장소/시계/효과만, 네트워크 없음.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
const out = await build({ entryPoints: ['src/lab-create-service.ts'], bundle: true, write: false, format: 'esm', platform: 'node' });
const dir = mkdtempSync(join(tmpdir(), 'lab-create-'));
writeFileSync(join(dir, 'service.mjs'), out.outputFiles[0].text);
const M = await import(pathToFileURL(join(dir, 'service.mjs')));
rmSync(dir, { recursive: true, force: true });
globalThis.fetch = () => { throw Error('network forbidden'); };
let count = 0;
const check = (name, f) => { f(); count++; console.log('ok', name); };
const gate = () => { let resolve; const p = new Promise((r) => resolve = r); return { p, resolve }; };
const tick = () => new Promise((r) => setImmediate(r));
async function until(f) { for (let i = 0; i < 100 && !f(); i++) await tick(); assert.ok(f()); }
const ID = (t, n = 0) => `lc_${t}_${n.toString(16).padStart(32, '0')}`;
function world() {
  let T = 1800000000000, admin = true, failPut = null, failRead = false;
  const store = new Map(), labs = new Map(), events = [];
  let effects = 0, validations = 0, hold = null, throwAfter = false, pending = false, rejectBefore = false, rejectAfter = false;
  const storage = {
    async get(k) { if (failRead) throw Error('storage secret'); return structuredClone(store.get(k)); },
    async put(k, v) { if (failPut?.(v)) throw Error('storage secret'); events.push(v.phase); store.set(k, structuredClone(v)); },
    async delete(k) { store.delete(k); },
    async list({ prefix, limit = Infinity }) { return new Map([...store].filter(([k]) => k.startsWith(prefix)).slice(0, limit)); },
  };
  const deps = {
    storage, now: () => T, checkAdmin: async (token) => admin && token === 'admin',
    async validate(input) { validations++; return input.valid === false ? { status: 400, error: 'invalid' } : input; },
    async execute(token, input, arm) {
      if (rejectBefore) return { status: 422, error: '메모리 상한은 8 GiB입니다.' };
      if (pending) return { snapshotPreparing: true, snapshot: 'safe-3c3g6d', state: 'building', retryAfterMs: 5000 };
      const labId = 'L' + effects;
      await arm(labId);
      assert.ok([...store.values()].some((v) => v.phase === 'running'));
      labs.set(labId, { id: labId, name: '수업', createdAt: T, expiresAt: T + 3600000, seatCount: 2, failedSeats: 0 });
      effects++; events.push('effect');
      if (rejectAfter) return { status: 422, error: 'must not imply safe rejection after arm' };
      if (hold) await hold.p;
      if (throwAfter) throw new DOMException('raw provider secret', 'AbortError');
      labs.set(labId, { id: labId, name: '수업', createdAt: T, expiresAt: T + 3600000, seatCount: 2, failedSeats: 0 });
      return { labId };
    },
    async summary(id) { const l = labs.get(id); return l && l.expiresAt > T && !l.ended ? { ...l } : { status: 410, error: 'ended' }; },
  };
  // validate-only test flag is conveyed through name, preserving real allowed input schema.
  deps.validate = async (input) => { validations++; return input.name === 'invalid' ? { status: 400, error: 'invalid' } : input; };
  const make = () => new M.LabCreateService(deps);
  return { make, store, labs, events, get id() { return ID(T); }, input: (id = ID(T), name = '수업') => ({ requestId: id, name, seats: 2 }), get effects() { return effects; }, get validations() { return validations; },
    set hold(v) { hold = v; }, set admin(v) { admin = v; }, set failPut(v) { failPut = v; }, set failRead(v) { failRead = v; }, set throwAfter(v) { throwAfter = v; }, set pending(v) { pending = v; }, set rejectBefore(v) { rejectBefore = v; }, set rejectAfter(v) { rejectAfter = v; }, set time(v) { T = v; }, get time() { return T; } };
}
{
  const w = world(), s = w.make(); w.rejectBefore = true;
  assert.equal((await s.create('admin', w.input())).status, 422);
  const restored = await w.make().status('admin', w.id);
  check('unarmed rejected request is recoverable as not-started after restart', () => { assert.deepEqual(restored, { requestId: w.id, creationState: 'not-started' }); assert.equal(w.effects, 0); });
  w.rejectBefore = false; w.rejectAfter = true;
  const other = ID(w.time, 9), armed = await s.create('admin', w.input(other));
  check('422 after arm remains unknown and never unlocks corrected input', () => { assert.equal(armed.status, 422); assert.equal(w.effects, 1); });
  assert.equal((await w.make().status('admin', other)).creationState, 'unknown');
}
{
  const w = world(), s = w.make(), h = gate(); w.hold = h;
  const a = s.create('admin', w.input()); await until(() => w.effects === 1);
  const b = s.create('admin', w.input());
  check('durable running before resource effect', () => assert.ok(w.events.indexOf('running') < w.events.indexOf('effect')));
  check('status while running', () => assert.equal(w.store.get(M.CREATE_PREFIX + w.id).phase, 'running'));
  assert.equal((await s.status('admin', w.id)).creationState, 'running');
  check('different concurrent payload409', () => {}); assert.equal((await s.create('admin', w.input(w.id, '다름'))).status, 409);
  h.resolve(); const [x,y] = await Promise.all([a,b]);
  check('identical calls join once', () => { assert.deepEqual(x,y); assert.equal(w.effects,1); });
  check('completed replay after lost response', () => assert.equal(x.creationState, 'completed'));
  assert.deepEqual(await s.create('admin', w.input()), x); assert.equal(w.effects,1);
  check('replay after restart no effects', () => {}); assert.deepEqual(await w.make().create('admin', w.input()), x); assert.equal(w.effects,1);
  check('summary fixed output fields', () => assert.deepEqual(Object.keys(x.lab), ['id','name','createdAt','expiresAt','seatCount','failedSeats']));
  w.labs.delete(x.lab.id);
  assert.equal((await s.status('admin', w.id)).status,410); assert.equal((await s.create('admin',w.input())).status,410);
  check('deleted completion cannot resurrect', () => assert.equal(w.effects,1));
}
{
  const w=world(), s=w.make(), h=gate(); w.hold=h; const a=s.create('admin',w.input()); await until(()=>w.effects===1);
  const restarted=w.make(); assert.equal((await restarted.create('admin',w.input())).creationState,'unknown');
  assert.equal((await restarted.status('admin',w.id)).creationState,'unknown');
  check('restart running never reexecutes',()=>assert.equal(w.effects,1));
  h.resolve(); await a;
}
{
  const w=world(), s=w.make(); w.throwAfter=true;
  const r=await s.create('admin',w.input()); assert.equal(r.creationState,'unknown');
  check('thrown/cancelled effect retains unknown sanitized result',()=>{assert.equal(w.store.get(M.CREATE_PREFIX+w.id).phase,'unknown');assert.ok(!JSON.stringify(r).includes('secret'));});
  const rr=await w.make().create('admin',w.input()); assert.equal(rr.creationState,'unknown'); assert.equal(w.effects,1);
  check('cancelled request same ID cannot spend twice',()=>assert.equal(w.effects,1));
}
{
  const w=world(), s=w.make();
  assert.equal((await s.create('admin',w.input(w.id,'invalid'))).status,400); assert.equal(w.store.size,0);
  assert.equal((await s.create('admin',w.input())).creationState,'completed');
  check('validation rejection does not poison corrected ID',()=>assert.equal(w.effects,1));
}
{
  const w=world(), s=w.make(); w.pending=true;
  const r=await s.create('admin',w.input()); assert.equal(r.creationState,'preparing'); assert.equal(w.effects,0);
  assert.equal((await w.make().status('admin',w.id)).snapshot,'safe-3c3g6d');
  assert.equal((await w.make().create('admin',w.input(w.id,'changed'))).status,409);
  w.pending=false; assert.equal((await w.make().create('admin',w.input())).creationState,'completed');
  check('snapshot preparing retains payload binding but permits same input resume',()=>assert.equal(w.effects,1));
}
{
  const w=world(), s=w.make(); w.admin=false;
  assert.equal((await s.create('admin',w.input())).status,401); assert.equal((await s.status('admin',w.id)).status,401); assert.equal(w.store.size,0);
  check('auth before create/status metadata',()=>assert.equal(w.validations,0));
  w.admin=true; const h=gate(); w.hold=h; const p=s.create('admin',w.input());await until(()=>w.effects===1);w.admin=false;h.resolve();
  assert.equal((await p).status,401); w.admin=true;
  assert.equal((await s.status('admin',w.id)).creationState,'unknown');
  check('auth expiry after provider wait fails closed',()=>assert.equal(w.effects,1));
}
{
  const w=world(),s=w.make();w.failPut=(v)=>v.phase==='preparing';assert.equal((await s.create('admin',w.input())).status,503);
  check('claim storage failure no effects',()=>assert.equal(w.effects,0));
  w.failPut=(v)=>v.phase==='running'; const r=await s.create('admin',w.input());assert.equal(w.effects,0);assert.equal(r.creationState,'unknown');
  check('running barrier storage failure no effects',()=>assert.equal(w.effects,0));
}
{
  const w=world(),s=w.make();w.failPut=(v)=>v.phase==='completed';assert.equal((await s.create('admin',w.input())).creationState,'unknown');
  w.failPut=null;assert.equal((await w.make().create('admin',w.input())).creationState,'unknown');
  check('completion write failure preserves no retry guarantee',()=>assert.equal(w.effects,1));
  w.failRead=true;assert.equal((await s.status('admin',w.id)).status,503);check('status storage failure sanitized',()=>{});
}
{
  const w=world(),s=w.make(), old=ID(w.time-M.CREATE_WINDOW);assert.equal((await s.create('admin',w.input(old))).status,410);
  for(let n=0;n<M.CREATE_MAX;n++)w.store.set(M.CREATE_PREFIX+ID(w.time,n+1),{issuedAt:w.time,phase:'unknown',hash:'x'});
  assert.equal((await s.create('admin',w.input())).status,429);assert.equal(w.effects,0);
  check('record cap before resource effects',()=>assert.equal(w.effects,0));
  const expired=ID(w.time-M.CREATE_KEEP);w.store.clear();w.store.set(M.CREATE_PREFIX+expired,{issuedAt:w.time-M.CREATE_KEEP,phase:'unknown',hash:'x'});
  assert.equal((await s.create('admin',w.input())).creationState,'completed');assert.ok(!w.store.has(M.CREATE_PREFIX+expired));
  assert.equal((await s.create('admin',w.input(expired))).status,410);
  check('expired record pruning never reopens same ID',()=>assert.equal(w.effects,1));
}
{
  const w=world(),s=w.make();assert.equal((await s.create('admin',{...w.input(),requestId:w.id+'\n'})).status,400);
  assert.equal((await s.status('admin',w.id)).status,404);
  check('strict ID exact end and unknown status',()=>assert.equal(w.effects,0));
  check('canonical order only, values/types/missing distinct',()=>{assert.equal(M.createPayload({name:'x',seats:2}),M.createPayload({seats:2,name:'x'}));assert.notEqual(M.createPayload({seats:2}),M.createPayload({seats:'2'}));assert.notEqual(M.createPayload({}),M.createPayload({name:null}));assert.notEqual(M.createPayload({name:' x '}),M.createPayload({name:'x'}));});
  check('payload unknown/array/oversize invalid',()=>{assert.equal(M.createPayload({evil:1}).status,400);assert.equal(M.createPayload({share:[]}).status,400);assert.equal(M.createPayload({name:'x'.repeat(17000)}).status,400);});
}
console.log(`${count} checks passed`);