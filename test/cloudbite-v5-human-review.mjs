// Cloudbite product-v5 human review: real Worker router + real CloudbiteProject/History DOs over memory storage (the
// backend-v4 harness shape). Covers the authenticated own-history review write (origin, content type, strict body,
// stale output hash, idempotent retry, concurrent edit, foreign rows, unknown/expired/deleted, late write after delete),
// the regression-candidate export, and the offline importer + batch evaluation on the REAL exported shape. Every answer
// here is test-synthetic (seeded opinions); no sandbox, alarm or model call runs and any network call fails the test.
//   node test/cloudbite-v5-human-review.mjs
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { build } from 'esbuild';
import * as Q from '../tools/evaluate-cloudbite-quality.mjs';
import * as I from '../tools/cloudbite-human-review-import.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'cloudbite-v5-human-review-'));
const built = await build({ stdin: { contents: `export { default, CloudbiteProject, CloudbiteAccess, CloudbiteHistory } from './src/index.ts'; export { CLOUDBITE_EXPERTS, phaseOnePack } from './src/cloudbite-personas.ts';
export { REVIEW_ROLE_IDS } from './src/cloudbite-knowledge.ts'; export * as HR from './src/cloudbite-human-review.ts';`, resolveDir: process.cwd(), loader: 'ts' },
  bundle: true, write: false, platform: 'node', format: 'esm', loader: { '.ps1': 'text' }, plugins: [{ name: 'cf', setup(b) {
    b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'cf', namespace: 'stub' }));
    b.onLoad({ filter: /^cf$/, namespace: 'stub' }, () => ({ contents: 'export class DurableObject { constructor(ctx,env){this.ctx=ctx;this.env=env;} }' }));
  } }] });
writeFileSync(join(tmp, 'm.mjs'), built.outputFiles[0].text);
const M = await import(pathToFileURL(join(tmp, 'm.mjs')));

const BASE = 'https://cb.test', TOKEN = 'cbo_' + randomBytes(32).toString('base64url'), OWNER = { 'x-admin-token': TOKEN };
const hash = (s) => createHash('sha256').update(s).digest('hex');
const realNow = Date.now; let offset = 0; Date.now = () => realNow() + offset;
globalThis.fetch = async (u) => { throw new Error('network forbidden: ' + (typeof u === 'string' ? u : u.url)); };

function storage() {
  const m = new Map(), db = new DatabaseSync(':memory:'); let alarm = null, queue = Promise.resolve();
  const clone = (v) => v === undefined ? undefined : structuredClone(v);
  const s = { m, writes: 0,
    sql: { exec(sql, ...args) { const rows = db.prepare(sql).all(...args); return { toArray: () => rows, [Symbol.iterator]: function* () { yield* rows; } }; } },
    async get(k) { await null; if (Array.isArray(k)) assert.ok(k.length <= 128, 'get batch over the per-call key limit'); return Array.isArray(k) ? new Map(k.filter((x) => m.has(x)).map((x) => [x, clone(m.get(x))])) : clone(m.get(k)); },
    async put(k, v) { await null; s.writes++; for (const [key, value] of typeof k === 'object' ? Object.entries(k) : [[k, v]]) m.set(key, clone(value)); },
    async list({ prefix = '' } = {}) { return new Map([...m].filter(([k]) => k.startsWith(prefix)).sort().map(([k, v]) => [k, clone(v)])); },
    async delete(k) { const keys = Array.isArray(k) ? k : [k]; assert.ok(keys.length <= 128); let n = 0; for (const key of keys) if (m.delete(key)) n++; return Array.isArray(k) ? n : n > 0; },
    transaction(f) { const result = queue.then(() => f(s)); queue = result.catch(() => {}); return result; },
    async getAlarm() { return alarm; }, async setAlarm(at) { alarm = at; }, async deleteAlarm() { alarm = null; },
    async deleteAll() { m.clear(); db.exec('DROP TABLE IF EXISTS history'); alarm = null; },
  }; return s;
}
function world() {
  const w = {};
  const ns = (Class) => {
    const records = new Map();
    const getByName = (name) => {
      if (!records.has(name)) { const s = storage(), ctx = { storage: s, id: { name }, blockConcurrencyWhile: (f) => f(), waitUntil() {} }; records.set(name, { storage: s, ctx, object: new Class(ctx, w.env) }); }
      return records.get(name).object;
    };
    return { records, getByName };
  };
  w.env = { ORIGIN: BASE, RP_ID: 'cb.test', LAB_ORIGIN: 'https://lab.invalid', MASTER_KEY: 'test-key', CLOUDBITE_OPERATOR_TOKEN_HASH: hash(TOKEN), CLOUDBITE_OPERATOR_EXPIRES_AT: String(realNow() + 400 * 86400_000),
    CLOUDBITE_ALLOW_HTTP: '1', CLOUDBITE_DAYTONA_API_URL: 'https://dt.fake', CLOUDBITE_DAYTONA_API_KEY: 'DAYTONA-SECRET-VALUE',
    CLOUDBITE_NOSANA_BASE_URL: 'https://nosana.fake/v1', CLOUDBITE_NOSANA_API_KEY: 'NOSANA-SECRET-VALUE', CLOUDBITE_NOSANA_MODEL: 'fake-model', CLOUDBITE_GATEWAY_URL: 'http://127.0.0.1:9' };
  w.env.CLOUDBITE = ns(M.CloudbiteProject); w.env.CLOUDBITE_ACCESS = ns(M.CloudbiteAccess); w.env.CLOUDBITE_HISTORY = ns(M.CloudbiteHistory);
  w.env.STATE = { idFromName: (x) => x, get: () => ({ cloudbiteOwnerCheck: async () => false, adminList: async () => ({ error: 'no', status: 401 }) }) };
  w.store = (id) => w.env.CLOUDBITE.records.get(id)?.storage;
  return w;
}
async function call(w, method, path, { headers = {}, body, raw } = {}) {
  const r = await M.default.fetch(new Request(BASE + path, { method, headers: { ...(method !== 'GET' ? { origin: BASE, 'content-type': 'application/json' } : {}), ...headers }, ...(body !== undefined || raw !== undefined ? { body: raw ?? JSON.stringify(body) } : {}) }), w.env, { waitUntil() {} });
  const text = await r.text(); let data; try { data = JSON.parse(text); } catch {}
  return { status: r.status, data, text };
}

const ROLES = M.CLOUDBITE_EXPERTS.filter((e) => M.phaseOnePack(e.id) && !M.REVIEW_ROLE_IDS.has(e.id)).slice(0, 2);
const frame = () => ({ options: ['Plan A: in-house', 'Plan B: vendor'], constraints: ['Budget under 50k'], successCriteria: ['Users finish onboarding without help'],
  knownFacts: ['Vendor quote is 42k'], assumptions: ['Team can absorb support'], unknowns: ['Vendor SLA terms'] });
const brief = (over = {}) => ({ title: 'Human review QA', objective: 'Should we pilot the vendor plan?', context: 'Pilot context.', mode: 'live', stage: 'validation',
  expertIds: ROLES.map((r) => r.id), requestId: 'hr-' + randomBytes(8).toString('hex'), decision: frame(), documents: [{ id: 'doc-1', name: 'quote.txt', content: 'Vendor quote 42k.' }], ...over });
const opinion = (id, tag = '') => ({ direction: 'conditional', confidence: 61, summary: `Opinion of ${id}${tag}: pilot the vendor only if the SLA is confirmed.`, evidence: [`${id} evidence [source:PROJECT.md]`], assumptions: ['SLA unknown'], nextActions: ['Request the SLA before deciding'] });
const visitorHistory = () => { const token = 'cbh_' + randomBytes(32).toString('hex'); return { headers: { cookie: `__Host-cb-history=${token}` }, actor: 'v_' + hash(token), token }; };

/** Live project via the real API, then seeded as finished (no sandbox, no alarm). actor: re-own the history record. */
async function finished(w, { b = brief(), actor, tag = '', status = 'completed' } = {}) {
  const r = await call(w, 'POST', '/api/cloudbite/projects', { headers: OWNER, body: b });
  assert.equal(r.status, 201, r.text);
  const id = r.data.project.id, s = w.store(id), p = s.m.get('project');
  for (const run of p.runs) {
    const e = s.m.get('expert:' + run);
    e.int.phase = 'final'; e.run.status = 'completed'; e.run.opinion = opinion(e.run.expertId, tag);
    e.run.artifacts = [{ path: 'out/report.md', label: 'report.md', bytes: 20 }];
    s.m.set(`artifact:${run}:out/report.md`, `# Report of ${e.run.expertId}${tag}\n`); s.m.set('expert:' + run, e);
  }
  p.status = status; p.finishedAt = Date.now(); p.released = true;
  if (actor) p.history.actor = actor;
  await w.env.CLOUDBITE.getByName('registry').registryRelease(id);
  s.m.set('project', p);
  return { id, expertId: ROLES[0].id };
}
const detail = (w, id, headers = OWNER) => call(w, 'GET', '/api/cloudbite/history/' + id, { headers });
const post = (w, id, body, headers = OWNER) => call(w, 'POST', `/api/cloudbite/history/${id}/human-review`, { headers, body });
const exp = (w, id, expertId, headers = OWNER) => call(w, 'GET', `/api/cloudbite/history/${id}/human-review?expertId=${expertId}`, { headers });
const SCORES = (v = 3) => Object.fromEntries(M.HR.HUMAN_DIMENSIONS.map((d, i) => [d, i === 5 ? null : v]));
const body = async (w, x, over = {}, headers = OWNER) => {
  const d = (await detail(w, x.id, headers)).data;
  return { expertId: x.expertId, outputSha256: d.humanReview.outputs[x.expertId].outputSha256, requestId: 'req-' + randomBytes(6).toString('hex'),
    baseRevision: d.humanReview.reviews[x.expertId]?.revision ?? 0, scores: SCORES(), issues: [{ category: 'unsupported-claim', comment: 'SLA claim has no source.' }],
    comment: '근거가 부족합니다 — not enough support.', regressionCandidate: true, ...over };
};
const reviewKeys = (w, id) => [...w.store(id).m.keys()].filter((k) => k.startsWith('humanreview:'));

let passed = 0;
const test = async (name, fn) => { offset = 0; await fn(); passed++; console.log('ok', name); };

await test('rubric and canonical hashes mirror the offline evaluator exactly', async () => {
  assert.deepEqual([...M.HR.HUMAN_DIMENSIONS], [...Q.HUMAN_DIMENSIONS]);
  assert.equal(M.HR.HUMAN_RUBRIC, Q.EVALUATOR_VERSION);
  assert.deepEqual([...M.HR.HUMAN_REVIEW_ISSUES], [...I.ISSUE_CATEGORIES]);
  const b = brief(), fp = await M.HR.inputFingerprint(b), want = Q.caseFingerprint({ brief: b });
  assert.deepEqual(fp, want);
  const v = { b: [1, { z: 'é', a: null }], u: undefined, a: '줄\n' };
  assert.equal(M.HR.canonical(v), Q.canonical(v));
});

await test('detail exposes output hashes of finished live answers; read-only answers are unchanged by reviews', async () => {
  const w = world(), x = await finished(w), d = (await detail(w, x.id)).data;
  assert.equal(d.humanReview.version, 'cloudbite-human-review/v1'); assert.equal(d.humanReview.canReview, true);
  assert.deepEqual(Object.keys(d.humanReview.outputs).sort(), ROLES.map((r) => r.id).sort());
  assert.match(d.humanReview.outputs[x.expertId].outputSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(d.humanReview.reviews, {});
  const before = JSON.stringify(d.project.experts);
  assert.equal((await post(w, x.id, await body(w, x))).status, 200);
  const after = (await detail(w, x.id)).data;
  assert.equal(JSON.stringify(after.project.experts), before, 'the stored answer is never rewritten');
  assert.deepEqual(after.feedback, [], 'helpful/unhelpful feedback stays separate');
  const running = await call(w, 'POST', '/api/cloudbite/projects', { headers: OWNER, body: brief() });
  const rd = (await detail(w, running.data.project.id)).data;
  assert.deepEqual(rd.humanReview.outputs, {}); assert.equal(rd.humanReview.canReview, false);
});

await test('auth, origin, method, content type and strict body', async () => {
  const w = world(), x = await finished(w), ok = await body(w, x), path = `/api/cloudbite/history/${x.id}/human-review`;
  assert.equal((await call(w, 'POST', path, { body: ok })).status, 401, 'no session');
  assert.equal((await call(w, 'POST', path, { headers: { ...OWNER, origin: 'https://evil.test' }, body: ok })).status, 403);
  assert.equal((await call(w, 'POST', path, { headers: { ...OWNER, 'x-admin-token': 'cbo_wrong' }, body: ok })).status, 401);
  assert.equal((await call(w, 'PUT', path, { headers: OWNER, body: ok })).status, 405);
  assert.equal((await call(w, 'POST', path, { headers: { ...OWNER, 'content-type': 'text/plain' }, body: ok })).status, 415);
  assert.equal((await call(w, 'POST', path, { headers: OWNER, raw: '{not json' })).status, 400);
  assert.equal((await call(w, 'POST', path, { headers: OWNER, raw: JSON.stringify({ ...ok, comment: 'x'.repeat(17 * 1024) }) })).status, 400);
  for (const bad of [{ ...ok, actor: 'owner' }, { ...ok, at: 1 }, { ...ok, scores: { ...ok.scores, relevance: 5 } }, { ...ok, scores: { relevance: 1 } },
    { ...ok, scores: { ...ok.scores, relevance: 2.5 } }, { ...ok, issues: [{ category: 'vibes', comment: '' }] }, { ...ok, issues: [ok.issues[0], ok.issues[0]] },
    { ...ok, outputSha256: 'abc' }, { ...ok, requestId: 'x' }, { ...ok, baseRevision: -1 }, { ...ok, regressionCandidate: 'yes' }, { ...ok, comment: 'x'.repeat(1001) },
    { ...ok, scores: Object.fromEntries(Object.keys(ok.scores).map((k) => [k, null])), issues: [], comment: '  ' }, [ok]]) {
    const r = await post(w, x.id, bad);
    assert.equal(r.status, 400, JSON.stringify(bad).slice(0, 120) + ' → ' + r.text);
  }
  assert.deepEqual(reviewKeys(w, x.id), [], 'nothing stored by rejected requests');
});

await test('stale output hash 409; saved review reloads with server time and revision; Korean/English text round-trips', async () => {
  const w = world(), x = await finished(w), b = await body(w, x);
  const stale = await post(w, x.id, { ...b, outputSha256: 'f'.repeat(64) });
  assert.equal(stale.status, 409); assert.match(stale.data.error, /stale output/); assert.equal(stale.data.review, null);
  const t0 = Date.now(), r = await post(w, x.id, b);
  assert.equal(r.status, 200, r.text); assert.equal(r.data.replayed, false);
  assert.equal(r.data.review.revision, 1); assert.equal(r.data.review.recordedBy, 'project-user'); assert.ok(r.data.review.updatedAt >= t0);
  assert.equal('actor' in r.data.review, false); assert.equal('requests' in r.data.review, false);
  const d = (await detail(w, x.id)).data.humanReview.reviews[x.expertId];
  assert.deepEqual(d.scores, b.scores); assert.equal(d.comment, b.comment); assert.deepEqual(d.issues, b.issues); assert.equal(d.outputSha256, b.outputSha256);
  // An edit must name the revision it read.
  assert.equal((await post(w, x.id, { ...b, requestId: 'req-second-0001', comment: 'edited' })).status, 409);
  const ed = await post(w, x.id, { ...b, requestId: 'req-second-0002', baseRevision: 1, comment: 'edited' });
  assert.equal(ed.status, 200); assert.equal(ed.data.review.revision, 2); assert.equal(ed.data.review.createdAt, r.data.review.createdAt);
});

await test('retry with the same requestId is idempotent; reused id with other content and concurrent edits are 409, never lost', async () => {
  const w = world(), x = await finished(w), b = await body(w, x), s = w.store(x.id);
  const first = await post(w, x.id, b), writes = s.writes;
  const again = await post(w, x.id, b);
  assert.equal(again.status, 200); assert.equal(again.data.replayed, true); assert.equal(again.data.review.revision, first.data.review.revision);
  assert.equal(s.writes, writes, 'a replay writes nothing');
  const reused = await post(w, x.id, { ...b, comment: 'different' });
  assert.equal(reused.status, 409); assert.equal(reused.data.review.comment, b.comment);
  // Two tabs that both loaded revision 1 and save at the same moment: exactly one wins, the other gets the saved review.
  const both = await Promise.all([post(w, x.id, { ...b, requestId: 'req-tab-a-0001', baseRevision: 1, comment: 'tab A' }), post(w, x.id, { ...b, requestId: 'req-tab-b-0001', baseRevision: 1, comment: 'tab B' })]);
  assert.deepEqual(both.map((r) => r.status).sort(), [200, 409]);
  const loser = both.find((r) => r.status === 409), winner = both.find((r) => r.status === 200);
  assert.equal(loser.data.review.comment, winner.data.review.comment);
  // The concurrent duplicate of one request (lost response + retry racing) saves once.
  const dup = { ...b, requestId: 'req-dup-00001', baseRevision: 2, comment: 'dup' };
  const pair = await Promise.all([post(w, x.id, dup), post(w, x.id, dup)]);
  assert.deepEqual(pair.map((r) => r.status), [200, 200]); assert.deepEqual(pair.map((r) => r.data.review.revision), [3, 3]);
  // An old request replayed after a later edit is not reapplied.
  const late = await post(w, x.id, b);
  assert.equal(late.status, 409); assert.equal(late.data.review.revision, 3);
});

await test('foreign rows: owner reads and exports but cannot write as the user; other visitors see 404', async () => {
  const w = world(), v = visitorHistory(), other = visitorHistory(), x = await finished(w, { actor: v.actor });
  const own = await detail(w, x.id, v.headers);
  assert.equal(own.status, 200); assert.equal(own.data.humanReview.canReview, true);
  const b = await body(w, x, {}, v.headers);
  assert.equal((await post(w, x.id, b, other.headers)).status, 404);
  assert.equal((await exp(w, x.id, x.expertId, other.headers)).status, 404);
  assert.equal((await detail(w, x.id)).data.humanReview.canReview, false, 'owner reading a foreign row');
  assert.equal((await post(w, x.id, { ...b, requestId: 'req-owner-001' })).status, 403);
  assert.deepEqual(reviewKeys(w, x.id), []);
  assert.equal((await post(w, x.id, b, v.headers)).status, 200);
  assert.equal((await detail(w, x.id)).data.humanReview.reviews[x.expertId].comment, b.comment, 'owner can read the saved review');
  const e = await exp(w, x.id, x.expertId);
  assert.equal(e.status, 200);
  for (const secret of [v.token, v.actor, v.actor.slice(2), TOKEN]) assert.equal(e.text.includes(secret), false, 'no reviewer identity secret in export');
  assert.match(e.data.human.reviewer, /^reviewer-[0-9a-f]{16}$/);
  // Visitor scope: cannot review another user's project even with its exact hash.
  const y = await finished(w, { actor: other.actor });
  assert.equal((await post(w, y.id, { ...b, outputSha256: (await detail(w, y.id)).data.humanReview.outputs[x.expertId].outputSha256 }, v.headers)).status, 404);
});

await test('unknown project/expert 404, unfinished or demo 409, expired 404, delete removes reviews and late writes cannot resurrect', async () => {
  const w = world(), x = await finished(w), b = await body(w, x);
  assert.equal((await post(w, 'cb' + '0'.repeat(32), b)).status, 404);
  assert.equal((await post(w, x.id, { ...b, expertId: 'no-such-role' })).status, 404);
  assert.equal((await exp(w, x.id, 'Bad/Id')).status, 400);
  assert.equal((await exp(w, x.id, x.expertId)).status, 404, 'no saved review yet');
  const run = await call(w, 'POST', '/api/cloudbite/projects', { headers: OWNER, body: brief() });
  assert.equal((await post(w, run.data.project.id, b)).status, 409, 'running project');
  const demo = await finished(w, { b: brief({ mode: 'demo' }) });
  assert.equal((await post(w, demo.id, b)).status, 409, 'demo answers are not rated');
  assert.equal((await post(w, x.id, b)).status, 200);
  offset = 31 * 86400_000;
  assert.equal((await post(w, x.id, { ...b, requestId: 'req-expired-1', baseRevision: 1 })).status, 404);
  assert.equal((await exp(w, x.id, x.expertId)).status, 404);
  offset = 0;
  assert.equal((await call(w, 'DELETE', `/api/cloudbite/history/${x.id}`, { headers: OWNER })).status, 200);
  assert.deepEqual(reviewKeys(w, x.id), []);
  assert.equal((await post(w, x.id, b)).status, 404, 'deleted record, even a replay of a saved request');
  assert.equal((await exp(w, x.id, x.expertId)).status, 404);
  // Late write: the delete commits between the reader's load and the review transaction.
  const y = await finished(w), by = await body(w, y), sy = w.store(y.id), orig = sy.transaction.bind(sy);
  let once = true;
  sy.transaction = (fn) => { if (once) { once = false; assert.equal(sy.m.has('project'), true); return call(w, 'DELETE', `/api/cloudbite/history/${y.id}`, { headers: OWNER }).then(() => orig(fn)); } return orig(fn); };
  assert.equal((await post(w, y.id, by)).status, 404);
  assert.deepEqual(reviewKeys(w, y.id), []);
  // Purge at retention removes everything (deleteAll), so nothing can come back either.
  const z = await finished(w), bz = await body(w, z);
  assert.equal((await post(w, z.id, bz)).status, 200);
  await w.store(z.id).deleteAll();
  assert.equal((await post(w, z.id, { ...bz, requestId: 'req-purged-01' })).status, 404); assert.deepEqual(reviewKeys(w, z.id), []);
});

await test('export → importer → batch: exact hashes, NOT_SCORED for unset dimensions, same-reviewer before/after on the same question', async () => {
  const w = world(), v = visitorHistory(), q = brief();
  const a = await finished(w, { b: q, actor: v.actor }), bq = { ...q, requestId: 'hr-' + randomBytes(8).toString('hex') };
  const c = await finished(w, { b: bq, actor: v.actor, tag: ' (revised)' });
  offset = 1000;
  assert.equal((await post(w, a.id, await body(w, a, { scores: SCORES(3) }, v.headers), v.headers)).status, 200);
  const cBody = await body(w, c, { scores: { ...SCORES(2), relevance: 4 }, issues: [{ category: 'missing-source', comment: '' }] }, v.headers);
  assert.equal((await post(w, c.id, cBody, v.headers)).status, 200);
  const ea = await exp(w, a.id, a.expertId, v.headers), ec = await exp(w, c.id, c.expertId, v.headers);
  assert.equal(ea.status, 200); assert.equal(ea.data.version, 'cloudbite-regression-candidate/v1'); assert.equal(ea.data.human.blind, false);
  assert.equal(ea.data.outputSha256, (await detail(w, a.id, v.headers)).data.humanReview.outputs[a.expertId].outputSha256);
  assert.equal(ea.data.answer.report, `# Report of ${a.expertId}\n`); assert.deepEqual(ea.data.input.brief.documents, q.documents);
  assert.ok(Buffer.byteLength(ea.text) < 128 * 1024, 'bounded export');
  assert.equal(ea.data.human.reviewer, ec.data.human.reviewer, 'one person → one stable label');
  assert.equal(I.parseCandidate(ea.text).errors, undefined, JSON.stringify(I.parseCandidate(ea.text).errors));
  // Tampering with the answer, the question or the hash is refused, never repaired.
  for (const mutate of [(x) => { x.answer.opinion.summary += '!'; }, (x) => { x.input.brief.objective += '?'; }, (x) => { x.outputSha256 = 'a'.repeat(64); }, (x) => { x.human.scores.relevance = 9; }, (x) => { x.human.rubric = 'other/v9'; }]) {
    const t = JSON.parse(ea.text); mutate(t); assert.ok(I.parseCandidate(JSON.stringify(t)).errors?.length);
  }
  const dir = mkdtempSync(join(tmpdir(), 'cb-hr-import-'));
  const fa = join(dir, 'a.json'), fc = join(dir, 'c.json'); writeFileSync(fa, ea.text); writeFileSync(fc, ec.text);
  const out = join(dir, 'out');
  const r = I.runImport(['--input', fc, '--input', fa, '--out', out, '--batch-id', 'hr-test', '--evaluate', '--allow-outside-repo'], { log: () => {} });
  assert.equal(r.built.cases.length, 1, 'same question/stage/material → one case');
  assert.equal(r.built.manifest.entries.length, 2); assert.ok(r.built.manifest.entries[1].baseline, 'later answer gets the earlier as baseline');
  const ratings = readFileSync(join(out, 'ratings.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  for (const row of ratings) assert.equal(row.inputSha256, hash(readFileSync(join(out, r.built.exports.find((e) => e.inputSha256 === row.inputSha256).name))), 'rating bound to exact export bytes');
  const hi = JSON.parse(readFileSync(join(out, 'human-issues.json'), 'utf8')).comparisons[0];
  assert.equal(hi.sameReviewer, true); assert.deepEqual(hi.issues, { persisting: [], resolved: ['unsupported-claim'], introduced: ['missing-source'] });
  assert.deepEqual(hi.scores.relevance, { baseline: 3, candidate: 4, delta: 1 }); assert.equal(hi.scores.no_fabricated_signoff, 'NOT_SCORED');
  const entry = r.batch.entries[1];
  assert.equal(entry.pair.comparable, true, JSON.stringify(entry.pair.comparison?.problems));
  assert.deepEqual(entry.pair.humanRegressions.sort(), ['alternatives_tradeoffs', 'conditional_next_step', 'evidence_traceability', 'facts_vs_assumptions']);
  assert.equal(entry.pair.human.no_fabricated_signoff.status, 'NOT_SCORED');
  assert.equal(entry.candidate.report.human.reviews[0].scores.no_fabricated_signoff, 'NOT_SCORED');
  assert.ok(existsSync(join(out, 'evaluation', 'hr-test', 'summary.json')));
  // A comment-only review yields no rating row: the evaluator stays NOT_SCORED for that answer.
  const t = JSON.parse(ea.text); t.human.scores = Object.fromEntries(Q.HUMAN_DIMENSIONS.map((d) => [d, null]));
  assert.equal(I.buildImport([t]).ratings.length, 0);
  // Different reviewers are never paired.
  const u = JSON.parse(ec.text); u.human.reviewer = 'reviewer-' + '0'.repeat(16);
  assert.equal(I.compareHuman(ea.data, u).scores, 'NOT_SCORED');
  // Credentials or argument tokens are refused before any write.
  const leaked = join(dir, 'leak.json'); writeFileSync(leaked, ea.text.replace('Pilot context.', 'Pilot context. sk-' + 'a'.repeat(30)));
  assert.throws(() => I.runImport(['--input', leaked, '--out', join(dir, 'leak'), '--allow-outside-repo'], { log: () => {} }), /credential/);
  assert.throws(() => I.runImport(['--input', fa, '--token=abc'], { log: () => {} }), /refusing argument/);
  assert.equal(existsSync(join(dir, 'leak')), false);
});

Date.now = realNow;
console.log(`cloudbite-v5-human-review: ${passed} groups passed (test-synthetic answers; no sandbox, model or network).`);
