import assert from 'node:assert/strict';
import { build } from 'esbuild';
const bundle = await build({ entryPoints: ['src/lab-readiness.ts'], bundle: true, write: false, format: 'esm', platform: 'node' });
const { preparationView: prep, seatDiagnostics: diag } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
const at = 1_000_000;
const lab = { id: 'lab' };
const seat = { n: 1, code: 'secret', sandboxId: 'box', who: 'Name', setup: { state: 'ok' } };
const job = { ref: { labId: 'lab', n: 1, code: 'secret', sandboxId: 'box' }, op: 'operation', phase: 'queued', created: at - 1000, deadline: at + 1000, due: at, tries: 0, editors: 0 };
assert.equal(prep(lab, seat, undefined, at).state, 'unknown'); // who and materials ok do not imply ready/opened
assert.equal(prep(lab, seat, job, at).state, 'queued');
for (const phase of ['wake', 'install', 'probe', 'editor']) assert.equal(prep(lab, seat, { ...job, phase, started: at - 500 }, at).state, 'preparing');
for (const phase of ['ready', 'failed', 'uncertain']) assert.deepEqual(prep(lab, seat, { ...job, phase, started: at - 500, endedAt: at - 10 }, at), { state: phase === 'ready' ? 'ready' : 'error', at: at - 10 });
assert.equal(prep(lab, { ...seat, error: 'secret error' }, undefined, at).state, 'error');
for (const field of ['labId', 'n', 'code', 'sandboxId']) assert.equal(prep(lab, seat, { ...job, ref: { ...job.ref, [field]: 'wrong' } }, at).state, 'unknown');
for (const patch of [{ phase: 'ready' }, { phase: 'ready', endedAt: at + 1 }, { deadline: at }, { tries: NaN }, { due: Infinity }, { ref: null }, { phase: 'waiting' }, { phase: 'install' }]) assert.equal(prep(lab, seat, { ...job, ...patch }, at).state, 'unknown');
const cache = { at: at - 1, v: { usage: 2, limit: 10 } };
assert.deepEqual(diag(cache, { at: at - 1, status: 429, n: 2, msg: 'secret provider token' }, at), { usage: 2, limit: 10, usageAt: at - 1, aiError: { at: at - 1, status: 429, count: 2, kind: 'rate-limit' } });
for (const status of [401, 403, 400, 500]) assert.ok(diag(undefined, { at, status, n: 1 }, at).aiError);
for (const v of [{ usage: NaN, limit: 1 }, { usage: -1, limit: 1 }, { usage: '2', limit: 1 }, { usage: 2, limit: Infinity }, { usage: 2, limit: -1 }]) assert.equal(diag({ ...cache, v }, null, at).usageAt, null);
for (const stamp of [at + 1, at - 30_000, NaN]) assert.equal(diag({ ...cache, at: stamp }, null, at).usageAt, null);
for (const patch of [{ status: 200 }, { status: 600 }, { status: '429' }, { n: Infinity }, { n: 0 }, { n: 1_000_001 }, { at: at - 600_000 }, { at: at + 1 }]) assert.equal(diag(null, { at, status: 429, n: 1, ...patch }, at).aiError, null);
assert.equal(JSON.stringify(diag(cache, { at, status: 500, n: 1, msg: 'secret', key: 'secret' }, at)).includes('secret'), false);
console.log('lab-monitor-diagnostics: all focused assertions passed (pure functions, no network)');

assert.equal(prep(lab, { ...seat, setup: { state: 'error', note: '수업 자료를 넣던 중 끝났는지 알 수 없게 되었습니다. 강사가 이 자리 실습실을 새로 만들어야 합니다.' } }, undefined, at).state, 'error');
