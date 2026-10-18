// Real Worker + project/access DOs + real SQLite day indexes; no provider calls. Server demos exercise the
// lifecycle. Separately labeled fixtures test live-only analytics without claiming a paid-provider run.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { build } from 'esbuild';

const tmp = mkdtempSync(join(tmpdir(), 'cloudbite-history-'));
const built = await build({ stdin: { contents: `export { default, State, CloudbiteProject, CloudbiteAccess, CloudbiteHistory } from './src/index.ts'; export { CLOUDBITE_EXPERTS } from './src/cloudbite-personas.ts'; export { historyReport, historyRow } from './src/cloudbite-history.ts';`, resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, write: false, platform: 'node', format: 'esm', loader: { '.ps1': 'text' }, plugins: [{ name: 'cf', setup(b) {
    b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'cf', namespace: 'stub' }));
    b.onLoad({ filter: /^cf$/, namespace: 'stub' }, () => ({ contents: 'export class DurableObject { constructor(ctx,env){this.ctx=ctx;this.env=env;} }' }));
  } }] });
writeFileSync(join(tmp, 'm.mjs'), built.outputFiles[0].text);
const M = await import(pathToFileURL(join(tmp, 'm.mjs')));
let network = 0; globalThis.fetch = async () => { network++; throw new Error('provider network forbidden'); };
const BASE = 'https://cb.test', TOKEN = 'cbo_' + randomBytes(32).toString('base64url'), OWNER = { 'x-admin-token': TOKEN };
const hash = s => createHash('sha256').update(s).digest('hex');
const realNow = Date.now; let offset = 0; Date.now = () => realNow() + offset;
let passed = 0;
const test = async (name, fn) => { offset = 0; await fn(); passed++; console.log('ok', name); };
function storage() {
  const m = new Map(), db = new DatabaseSync(':memory:'); let alarm = null, queue = Promise.resolve();
  const clone = v => v === undefined ? undefined : structuredClone(v);
  const s = { m, db,
    sql: { exec(sql, ...args) { const rows = db.prepare(sql).all(...args); return { toArray: () => rows, [Symbol.iterator]: function* () { yield* rows; } }; } },
    async get(k) { return Array.isArray(k) ? new Map(k.filter(x => m.has(x)).map(x => [x, clone(m.get(x))])) : clone(m.get(k)); },
    async put(k, v) { for (const [key, value] of typeof k === 'object' ? Object.entries(k) : [[k, v]]) m.set(key, clone(value)); },
    async list({ prefix = '' } = {}) { return new Map([...m].filter(([k]) => k.startsWith(prefix)).sort().map(([k, v]) => [k, clone(v)])); },
    async delete(k) { const keys = Array.isArray(k) ? k : [k]; assert.ok(keys.length <= 128); let n = 0; for (const key of keys) if (m.delete(key)) n++; return Array.isArray(k) ? n : n > 0; },
    transaction(f) { const result = queue.then(() => f(s)); queue = result.catch(() => {}); return result; },
    async getAlarm() { return alarm; }, async setAlarm(at) { alarm = at; }, async deleteAlarm() { alarm = null; },
    async deleteAll() { m.clear(); db.exec('DROP TABLE IF EXISTS history'); alarm = null; },
  }; return s;
}
function world() {
  const w = { failIndex: false }, namespaces = [];
  const ns = Class => {
    const records = new Map();
    const getByName = name => {
      if (!records.has(name)) {
        const s = storage(), ctx = { storage: s, id: { name }, blockConcurrencyWhile: f => f(), waitUntil() {} };
        records.set(name, { storage: s, ctx, object: new Class(ctx, w.env) });
      }
      return records.get(name).object;
    };
    const result = { records, getByName }; namespaces.push(result); return result;
  };
  w.env = { ORIGIN: BASE, RP_ID: 'cb.test', LAB_ORIGIN: 'https://lab.invalid', MASTER_KEY: 'test-key', CLOUDBITE_OPERATOR_TOKEN_HASH: hash(TOKEN), CLOUDBITE_OPERATOR_EXPIRES_AT: String(realNow() + 400 * 86400_000) };
  w.env.CLOUDBITE = ns(M.CloudbiteProject); w.env.CLOUDBITE_ACCESS = ns(M.CloudbiteAccess);
  class Index extends M.CloudbiteHistory { async upsert(row) { if (w.failIndex) throw new Error('index offline'); return super.upsert(row); } }
  w.env.CLOUDBITE_HISTORY = ns(Index);
  w.env.STATE = { idFromName: x => x, get: () => ({ cloudbiteOwnerCheck: async () => false, adminList: async () => ({ error: 'no', status: 401 }) }) };
  w.restart = () => { for (const n of namespaces) for (const rec of n.records.values()) rec.object = new rec.object.constructor(rec.ctx, w.env); };
  return w;
}
async function call(w, method, path, { headers = {}, body, raw } = {}) {
  const r = await M.default.fetch(new Request(BASE + path, { method, headers: { ...(method !== 'GET' ? { origin: BASE, 'content-type': 'application/json' } : {}), ...headers }, ...(body !== undefined || raw !== undefined ? { body: raw ?? JSON.stringify(body) } : {}) }), w.env, { waitUntil() {} });
  const text = await r.text(); let data; try { data = JSON.parse(text); } catch {}
  return { status: r.status, data, text, cookie: r.headers.get('set-cookie') };
}
const jar = value => value.split(';')[0];
const get = (w, path, headers = OWNER) => call(w, 'GET', '/api/cloudbite/history' + path, { headers });
async function visitor(w, name = 'Visitor') {
  const r = await call(w, 'POST', '/api/cloudbite/access/requests', { body: { name, purpose: 'History QA' } }); assert.equal(r.status, 201, r.text);
  const a = await call(w, 'POST', `/api/cloudbite/access/requests/${r.data.request.id}/approve`, { headers: OWNER, body: {} }); assert.equal(a.status, 200);
  return { cookie: jar(r.cookie) };
}
const brief = () => ({ title: 'History QA <script>', objective: 'Should we launch?', context: 'Private context', mode: 'demo', expertIds: M.CLOUDBITE_EXPERTS.slice(0, 3).map(e => e.id), requestId: 'history-' + randomBytes(8).toString('hex') });
async function create(w, headers = OWNER, b = brief()) { const r = await call(w, 'POST', '/api/cloudbite/projects', { headers, body: b }); assert.equal(r.status, 201, r.text); return r; }
async function finish(w, id) { for (let i = 0; i < 5; i++) { offset += 2000; await w.env.CLOUDBITE.getByName(id).alarm(); } assert.equal((await get(w, '/' + id)).data.project.status, 'completed'); }

await test('records are captured by project alarms, survive reconstruction and retain real answers beyond 24 hours', async () => {
  const w = world(), r = await create(w), id = r.data.project.id;
  assert.equal((await get(w, '')).data.rows.length, 0);
  await w.env.CLOUDBITE.getByName(id).alarm();
  assert.equal((await get(w, '')).data.rows[0].id, id);
  await finish(w, id); w.restart(); offset += 2 * 86400_000;
  const d = await get(w, '/' + id); assert.equal(d.status, 200); assert.equal(d.data.project.brief.context, 'Private context');
  assert.equal(d.data.project.experts.filter(e => e.opinion).length, 3); assert.equal(d.data.roles[0].promptHash.length, 64);
  assert.equal(Object.keys(d.data.reports).length, 3); assert.ok(Object.values(d.data.reports).every(s => s.includes('simulated report')));
  assert.ok(!d.text.includes('accessToken')); assert.ok(!d.text.includes(TOKEN));
  assert.equal(d.data.expiresAt - d.data.project.createdAt, 30 * 86400_000);
});
await test('visitor cookie scopes history, survives grant expiry, cannot run projects or read others; explicit invalid header wins', async () => {
  const w = world(), v = await visitor(w), a = await create(w, v), id = a.data.project.id;
  assert.match(a.cookie, /^__Host-cb-history=cbh_[a-f0-9]{64}; Path=\/; Max-Age=2592000; HttpOnly; SameSite=Strict; Secure$/);
  const h = { cookie: jar(a.cookie) }; await finish(w, id);
  const other = await visitor(w, 'Other'), b = await create(w, other); await finish(w, b.data.project.id);
  assert.equal((await get(w, '', h)).data.rows.length, 1);
  assert.equal((await get(w, '/' + b.data.project.id, h)).status, 404);
  assert.equal((await get(w, '?scope=all', h)).status, 403);
  assert.equal((await get(w, '/report', h)).status, 403);
  assert.equal((await get(w, '', { ...h, 'x-admin-token': '' })).status, 401);
  offset += 2 * 3600_000; assert.equal((await get(w, '/' + id, h)).status, 200);
  assert.equal((await call(w, 'POST', '/api/cloudbite/projects', { headers: h, body: brief() })).status, 401);
  assert.equal((await get(w, '?scope=all')).data.rows.length, 2);
});
await test('lost-create retries reuse history identity; the owner sees own records separately', async () => {
  const w = world(), v = await visitor(w), b = brief();
  const a = await create(w, v, b), retry = await create(w, v, b);
  assert.equal(a.cookie, retry.cookie); assert.equal(a.data.project.id, retry.data.project.id);
  await finish(w, a.data.project.id); const owner = await create(w); await finish(w, owner.data.project.id);
  assert.deepEqual((await get(w, '')).data.rows.map(r => r.id), [owner.data.project.id]);
  assert.equal((await get(w, '?scope=all')).data.rows.length, 2);
});
await test('feedback updates one review per expert, preserves concurrent reviews; other users and owner cannot impersonate reviewer', async () => {
  const w = world(), v = await visitor(w), a = await create(w, v), id = a.data.project.id, cookie = { cookie: jar(a.cookie) };
  await finish(w, id);
  const expertId = a.data.project.experts[0].expertId;
  const path = '/api/cloudbite/history/' + id + '/feedback', f = { expertId, rating: 'unhelpful', issue: 'too-generic', comment: '<script>private feedback</script>' };
  assert.equal((await call(w, 'POST', path, { headers: cookie, body: f })).status, 200);
  assert.equal((await call(w, 'POST', path, { headers: cookie, body: { expertId, rating: 'helpful', comment: '' } })).status, 200);
  const second = { expertId: a.data.project.experts[1].expertId, rating: 'helpful', comment: 'Second expert' };
  assert.ok((await Promise.all([call(w, 'POST', path, { headers: cookie, body: f }), call(w, 'POST', path, { headers: cookie, body: second })])).every(r => r.status === 200));
  const d = await get(w, '/' + id, cookie); assert.equal(d.data.feedback.length, 2);
  assert.equal((await call(w, 'POST', path, { headers: OWNER, body: f })).status, 404);
  assert.equal((await call(w, 'POST', path, { headers: { ...cookie, origin: 'https://evil.test' }, body: f })).status, 403);
  for (const body of [{ ...f, actor: 'owner' }, { ...f, comment: 'x'.repeat(1001) }, { ...f, rating: 'helpful' }]) assert.equal((await call(w, 'POST', path, { headers: cookie, body })).status, 400);
});
await test('durable index retry: outage cannot lose answers; old or duplicate revisions cannot undo final state', async () => {
  const w = world(); w.failIndex = true; const r = await create(w), id = r.data.project.id;
  await finish(w, id); assert.equal((await get(w, '')).data.rows.length, 0);
  w.restart(); w.failIndex = false; offset += 61_000; await w.env.CLOUDBITE.getByName(id).alarm();
  assert.equal((await get(w, '')).data.rows[0].status, 'completed');
  const day = w.env.CLOUDBITE_HISTORY.getByName('day:' + Math.floor(r.data.project.createdAt / 86400_000));
  const row = (await day.rows(null, { at: Date.now() + 1, id: '~' }, 50))[0];
  await day.upsert({ ...row, revision: 1, status: 'running' }); await day.upsert(row);
  assert.equal((await get(w, '')).data.rows[0].status, 'completed');
});
await test('delete erases source answers, feedback and artifacts and tombstones the index; cannot resurrect on restart/retry', async () => {
  const w = world(), r = await create(w), id = r.data.project.id;
  assert.equal((await call(w, 'DELETE', '/api/cloudbite/history/' + id, { headers: OWNER })).status, 409);
  await finish(w, id);
  assert.ok(w.env.CLOUDBITE.records.get(id).storage.m.size > 3);
  assert.equal((await call(w, 'DELETE', '/api/cloudbite/history/' + id, { headers: OWNER })).status, 200);
  assert.equal((await get(w, '/' + id)).status, 404); assert.equal((await get(w, '')).data.rows.length, 0);
  const s = w.env.CLOUDBITE.records.get(id).storage;
  assert.equal([...s.m.keys()].filter(k => k.startsWith('artifact:')).length, 0);
  assert.ok(!JSON.stringify([...s.m.values()]).includes('Private context'));
  w.restart(); await w.env.CLOUDBITE.getByName(id).alarm(); assert.equal((await get(w, '')).data.rows.length, 0);
});
await test('30-day expiry is enforced on reads even before alarm delivery; retention alarm purges source/index storage', async () => {
  const w = world(), r = await create(w), id = r.data.project.id; await finish(w, id);
  offset += 31 * 86400_000;
  assert.equal((await call(w, 'GET', '/api/cloudbite/projects/' + id, { headers: { authorization: 'Bearer ' + r.data.accessToken } })).status, 401);
  assert.equal((await get(w, '/' + id)).status, 404); assert.equal((await get(w, '')).data.rows.length, 0);
  await w.env.CLOUDBITE.getByName(id).alarm(); assert.equal(w.env.CLOUDBITE.records.get(id).storage.m.size, 0);
  for (const rec of w.env.CLOUDBITE_HISTORY.records.values()) { await rec.object.alarm(); assert.equal(rec.storage.db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='history'").get().n, 0); }
});
await test('pagination: stable timestamp ties, owner-only global scope, malformed cursors and anonymous requests rejected', async () => {
  const w = world(), at = Date.now(), day = w.env.CLOUDBITE_HISTORY.getByName('day:' + Math.floor(at / 86400_000));
  for (let i = 1; i <= 53; i++) await day.upsert({ id: 'cb' + i.toString(16).padStart(32, '0'), actor: 'owner', title: 'Fixture ' + i, mode: 'demo', status: 'completed', createdAt: at, updatedAt: at, expiresAt: at + 30 * 86400_000, revision: 1, deleted: false, model: 'fixture', roles: [], experts: [], feedback: [] });
  const first = await get(w, ''), second = await get(w, '?before=' + encodeURIComponent(first.data.next));
  assert.equal(first.data.rows.length, 50); assert.equal(second.data.rows.length, 3); assert.equal(new Set([...first.data.rows, ...second.data.rows].map(x => x.id)).size, 53);
  assert.equal((await get(w, '?before=not-json')).status, 400);
  assert.equal((await get(w, '', {})).status, 401);
});
await test('feedback/delete race cannot revive deleted metadata or feedback, including delayed outbox acknowledgement', async () => {
  const w = world(), r = await create(w), id = r.data.project.id; await finish(w, id);
  await Promise.all([call(w, 'POST', '/api/cloudbite/history/' + id + '/feedback', { headers: OWNER, body: { expertId: r.data.project.experts[0].expertId, rating: 'unhelpful', issue: 'other', comment: 'Race QA' } }), call(w, 'DELETE', '/api/cloudbite/history/' + id, { headers: OWNER })]);
  await w.env.CLOUDBITE.getByName(id).alarm();
  assert.equal((await get(w, '')).data.rows.length, 0); assert.equal((await get(w, '/' + id)).status, 404);
  assert.deepEqual(w.env.CLOUDBITE.records.get(id).storage.m.get('project').feedback, []);
});
await test('analytics fixture: exclude demos/pending, preserve 55% cluster without jitter, count reviews not clicks and source syntax not truth', async () => {
  const p = { id: 'cb' + '1'.repeat(32), brief: { ...brief(), mode: 'live' }, status: 'completed', createdAt: Date.now(), updatedAt: Date.now(), experts: [0, 1, 2].map(i => ({ id: 'e' + i, expertId: 'role-' + i, name: 'Role', status: 'completed', activity: [], artifacts: [], updatedAt: Date.now(), opinion: { direction: 'conditional', confidence: 55, summary: 'Fixture', evidence: i === 0 ? ['https://source.test'] : [], assumptions: [], nextActions: [] } })) };
  const identity = { actor: 'owner', model: 'fixture-model', roles: p.experts.map(e => ({ id: e.expertId, basis: 'metadata-derived', revision: 'source-v1', promptHash: 'a'.repeat(64) })), revision: 2, published: 0, nextAt: 0 };
  const row = M.historyRow(p, identity, [{ expertId: 'role-1', rating: 'unhelpful', issue: 'too-generic', comment: 'not in index', at: Date.now() }]);
  assert.equal(row.feedback[0].comment, '');
  const report = M.historyReport([row, { ...row, mode: 'demo' }, { ...row, status: 'running' }]);
  assert.equal(report.completed, 3); assert.equal(report.referenced, 1); assert.equal(report.demoExcluded, 1); assert.equal(report.pending, 1);
  assert.equal(report.uniformConfidenceProjects, 1); assert.deepEqual(report.confidenceBins, [0, 0, 3, 0, 0]);
  assert.equal(report.feedback.unhelpful, 1); assert.equal(report.feedback.issues['too-generic'], 1);
  assert.ok(report.insights.some(i => i.kind === 'knowledge'));
});
assert.equal(network, 0); offset = 0; Date.now = realNow;
console.log(`cloudbite-history: ${passed} checks passed; SQLite indexes, no provider network`);
