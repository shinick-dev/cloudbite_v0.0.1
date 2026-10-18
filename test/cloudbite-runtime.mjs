// Cloudbite runtime: real Worker router + real CloudbiteProject DO + memory storage + fake Daytona/Nosana.
// The fake Daytona toolbox maps each sandbox to its own temp directory and, for live runs, executes the real
// Python runner (runner.py) there; the runner calls back through a local HTTP gateway into the Worker router.
// No external network: any host other than the fakes and 127.0.0.1 fails the test.
//   node test/cloudbite-runtime.mjs        (needs python3 or PYTHON=<path>)
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { build } from 'esbuild';

const PY = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
const PERSONAS = `
export const CLOUDBITE_EXPERTS = ['market','risk','ops','legal','finance','ux'].map((id) => ({ id, name: 'Expert ' + id, domain: id, summary: 's', prompt: 'p', tools: ['python'], outputs: ['report'], source: { repository: 'fixture', path: id, revision: 'r', license: 'MIT', basis: 'metadata-derived' } }));
export const findExpert = (id) => CLOUDBITE_EXPERTS.find((e) => e.id === id);
export function buildExpertWorkspace(expert, brief) {
  if (globalThis.__badWorkspace) return [{ path: '../escape.md', content: 'x' }];
  return [
    { path: 'PERSONA.md', content: '# Persona\\nEXPERT_ID=' + expert.id + '\\n' },
    { path: 'PROJECT.md', content: '# ' + brief.title + '\\n' + brief.objective },
    { path: 'WORKORDER.md', content: 'Analyse as ' + expert.id },
    { path: 'contract/result.schema.json', content: '{"type":"object"}' },
  ];
}`;
const stub = { name: 'stubs', setup(b) {
  b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'cf', namespace: 'stub' }));
  b.onLoad({ filter: /^cf$/, namespace: 'stub' }, () => ({ contents: 'export class DurableObject { constructor(ctx,env){this.ctx=ctx;this.env=env;} }' }));
  if (process.env.CLOUDBITE_REAL_PERSONAS !== '1') {
    b.onResolve({ filter: /cloudbite-personas$/ }, () => ({ path: 'personas', namespace: 'stub' }));
    b.onLoad({ filter: /^personas$/, namespace: 'stub' }, () => ({ contents: PERSONAS, loader: 'js' }));
  }
} };
const entry = `export { default, CloudbiteProject } from './src/index.ts'; export * from './src/cloudbite-config.ts'; export * from './src/cloudbite-validate.ts'; export { CB_RUNNER_PY } from './src/cloudbite-runner.ts';`;
const bundle = await build({ stdin: { contents: entry, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, format: 'esm', platform: 'node', plugins: [stub], loader: { '.ps1': 'text' } });
const tmp = mkdtempSync(join(tmpdir(), 'cloudbite-runtime-'));
writeFileSync(join(tmp, 'w.mjs'), bundle.outputFiles[0].text);
const M = await import(pathToFileURL(join(tmp, 'w.mjs')));
const worker = M.default;

let count = 0;
const check = async (name, f) => { await f(); count++; console.log('ok', name); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const gate = () => { let resolve; const p = new Promise((r) => (resolve = r)); return { p, resolve }; };
const jr = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
const SECRETS = ['DAYTONA-SECRET-VALUE', 'NOSANA-SECRET-VALUE', 'ADMIN-TOKEN-VALUE'];

// ── world: storage per DO name, clock, fake providers ──
function memStorage(w) {
  const m = new Map(); let alarm = null;
  const clone = (v) => (v === undefined ? undefined : structuredClone(v));
  return {
    m,
    async get(k) { await null; return Array.isArray(k) ? new Map(k.filter((x) => m.has(x)).map((x) => [x, clone(m.get(x))])) : clone(m.get(k)); },
    async put(k, v) { await null; for (const [a, b] of typeof k === 'object' ? Object.entries(k) : [[k, v]]) m.set(a, clone(b)); },
    async delete(k) { for (const x of Array.isArray(k) ? k : [k]) m.delete(x); },
    async list({ prefix = '' } = {}) { return new Map([...m].filter(([k]) => k.startsWith(prefix)).sort().map(([k, v]) => [k, clone(v)])); },
    async getAlarm() { return alarm; }, async setAlarm(t) { alarm = t; }, async deleteAlarm() { alarm = null; },
    async deleteAll() { m.clear(); },
    get alarm() { return alarm; },
  };
}

function makeWorld(opts = {}) {
  const w = { now: 1_800_000_000_000, sandboxes: new Map(), posts: 0, deletes: [], creating: 0, maxCreating: 0, nosana: [], fetches: [], dirs: tmp, runner: opts.runner ?? 'python', procs: [], ...opts };
  const objects = new Map();
  class TestProject extends M.CloudbiteProject { clock() { return w.now; } }
  w.ns = { getByName(name) { if (!objects.has(name)) { const storage = memStorage(w); objects.set(name, new TestProject({ storage, id: { name } }, w.env)); objects.get(name).storage = storage; } return objects.get(name); } };
  w.objects = objects;
  w.env = {
    ORIGIN: 'https://cb.test', LAB_ORIGIN: 'https://lab.cloudbite.invalid', RP_ID: 'cb.test', MASTER_KEY: 'k',
    STATE: { idFromName: () => 'main', get: () => w.state },
    CLOUDBITE: w.ns,
    CLOUDBITE_DAYTONA_API_URL: 'https://dt.fake', CLOUDBITE_DAYTONA_API_KEY: SECRETS[0],
    CLOUDBITE_NOSANA_BASE_URL: 'https://nosana.fake/v1', CLOUDBITE_NOSANA_API_KEY: SECRETS[1], CLOUDBITE_NOSANA_MODEL: 'fake-model',
    CLOUDBITE_GATEWAY_URL: w.gateway ?? 'http://127.0.0.1:9', CLOUDBITE_ALLOW_HTTP: '1',
    ...(opts.env ?? {}),
  };
  w.state = { adminList: async (t) => (t === SECRETS[2] ? { sessions: [] } : { error: 'expired', status: 401 }), labShareStatus: async () => ({}), requestInfo: async () => ({ error: 'x', status: 404 }) };
  return w;
}

// Worker fetch through the real router
async function call(w, method, path, { body, headers = {}, raw } = {}) {
  const init = { method, headers: { ...headers } };
  if (body !== undefined) { init.body = raw ?? JSON.stringify(body); init.headers['content-type'] ??= 'application/json'; }
  const r = await worker.fetch(new Request('https://cb.test' + path, init), w.env, { waitUntil() {} });
  const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch {}
  return { status: r.status, j, text, headers: r.headers };
}
const admin = { origin: 'https://cb.test', 'x-admin-token': SECRETS[2] };
const brief = (over = {}) => ({ title: 'Launch a 100-expert advisory', objective: 'Should we launch?', context: 'ctx', expertIds: ['market', 'risk', 'ops'], mode: 'live', requestId: 'req-' + Math.random().toString(36).slice(2, 12), ...over });

// ── fake Daytona + Nosana (installed as global fetch) ──
const sbDir = (w, id) => join(w.dirs, id);
const local = (w, id, p) => join(sbDir(w, id), p.replace(/^\/home\/daytona\/cloudbite\/?/, ''));
let W;
globalThis.fetch = async (u, init = {}) => {
  const url = new URL(typeof u === 'string' ? u : u.url), method = init.method ?? 'GET', w = W;
  w.fetches.push([url.host, method, url.pathname]);
  const auth = new Headers(init.headers).get('authorization');
  if (url.host === 'nosana.fake') {
    assert.equal(auth, 'Bearer ' + SECRETS[1]);
    const req = JSON.parse(init.body);
    w.nosana.push(req);
    if (w.nosanaHold) await w.nosanaHold.p;
    if (w.nosanaFail) return new Response('upstream says ' + SECRETS[1] + ' internal trace', { status: 500 });
    return jr({ choices: [{ message: { content: script(req) } }] });
  }
  assert.equal(url.host, 'dt.fake', 'unknown network forbidden: ' + url.host);
  assert.equal(auth, 'Bearer ' + SECRETS[0]);
  const p = url.pathname;
  if (p === '/sandbox' && method === 'POST') {
    w.posts++; w.creating++; w.maxCreating = Math.max(w.maxCreating, w.creating);
    try {
      if (w.createHold) await w.createHold.p;
      const b = JSON.parse(init.body); const id = 'SB-' + w.posts;
      w.sandboxes.set(id, { id, labels: b.labels, state: 'started', body: b });
      mkdirSync(sbDir(w, id), { recursive: true });
      if (w.loseCreate) { w.loseCreate = false; throw new TypeError('fixture: response lost after provider effect'); }
      return jr({ id, state: 'creating', labels: b.labels, toolboxProxyUrl: 'https://dt.fake/toolbox' });
    } finally { w.creating--; }
  }
  if (p === '/sandbox' && method === 'GET') {
    const want = JSON.parse(url.searchParams.get('labels'));
    return jr([...w.sandboxes.values()].filter((s) => Object.entries(want).every(([k, v]) => s.labels[k] === v)).map((s) => ({ id: s.id, state: s.state, labels: s.labels, toolboxProxyUrl: 'https://dt.fake/toolbox' })));
  }
  let m = p.match(/^\/sandbox\/(SB-\d+)$/);
  if (m && method === 'GET') { const s = w.sandboxes.get(m[1]); return s ? jr({ id: s.id, state: s.state, labels: s.labels, toolboxProxyUrl: 'https://dt.fake/toolbox' }) : jr({ message: 'nf' }, 404); }
  if (m && method === 'DELETE') {
    if (w.deleteFailures > 0) { w.deleteFailures--; return jr({ message: 'busy ' + SECRETS[0] }, 500); }
    w.deletes.push(m[1]); const had = w.sandboxes.delete(m[1]); return had ? jr({}) : jr({ message: 'gone' }, 404);
  }
  m = p.match(/^\/toolbox\/(SB-\d+)\/(.*)$/);
  assert.ok(m, 'unexpected Daytona path ' + p);
  const [, id, rest] = m; const sb = w.sandboxes.get(id);
  if (!sb) return jr({ message: 'no sandbox' }, 404);
  if (rest === 'files/upload') {
    const file = init.body.get('file'); const dest = local(w, id, url.searchParams.get('path'));
    assert.ok(existsSync(dirname(dest)), 'upload into a directory created by mkdir: ' + dest);
    writeFileSync(dest, Buffer.from(await file.arrayBuffer()));
    return jr({});
  }
  if (rest === 'files/download') { const f = local(w, id, url.searchParams.get('path')); return existsSync(f) ? new Response(readFileSync(f)) : jr({ message: 'nf' }, 404); }
  if (rest === 'process/execute') {
    const { command } = JSON.parse(init.body);
    const mk = command.match(/mkdir -p (.*)'$/);
    if (mk) { for (const d of mk[1].split(' ')) mkdirSync(local(w, id, d), { recursive: true }); return jr({ exitCode: 0, result: '' }); }
    const cat = command.match(/^cat (\S+) 2>\/dev\/null/);
    if (cat) { const f = local(w, id, cat[1]); return jr({ exitCode: 0, result: existsSync(f) ? readFileSync(f, 'utf8') : '' }); }
    throw Error('unexpected exec ' + command);
  }
  if (rest === 'process/session' && method === 'POST') return jr({});
  if (/^process\/session\/[\w-]+\/exec$/.test(rest)) {
    const { command, runAsync } = JSON.parse(init.body);
    assert.equal(runAsync, true); assert.match(command, /python3 -I runner\.py/);
    if (w.runner === 'python') w.procs.push(runPython(w, id));
    sb.started = (sb.started ?? 0) + 1;
    return jr({ cmdId: 'c1' });
  }
  throw Error('unexpected toolbox path ' + rest);
};

// Model script: python tool → write artifact → final (or malformed when w.badFinal)
function script(req) {
  const turn = req.messages.filter((m) => m.role === 'assistant').length;
  const id = (req.messages[1].content.match(/EXPERT_ID=(\w+)/) ?? [])[1];
  if (W.badFinal) return '{"action":"final","opinion":{"direction":"maybe"},"report":""}';
  if (turn === 0) return 'Plan: compute.\n```json\n{"action":"python","code":"import json\\nprint(\\"ROI\\", sum(range(10)))\\nopen(\\"calc.txt\\",\\"w\\").write(\\"45\\")"}\n```';
  if (turn === 1) return JSON.stringify({ action: 'write', path: 'out/analysis.md', content: `# ${id} analysis\nTool said: ${req.messages.at(-1).content.slice(0, 60)}` });
  return JSON.stringify({ action: 'final', opinion: { direction: id === 'risk' ? 'concern' : 'support', confidence: 72, summary: `${id} summary`, evidence: ['computed 45 in sandbox'], assumptions: ['fixture'], nextActions: ['pilot'] }, report: `# ${id} report\n\nBased on the python tool.` });
}

// Local gateway: sandbox runner → http://127.0.0.1:<port>/p/_cloudbite/worker/... → Worker router
const server = createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const r = await worker.fetch(new Request('https://gw.test' + req.url, { method: req.method, headers: Object.fromEntries(Object.entries(req.headers).filter(([k]) => k !== 'host' && k !== 'connection' && k !== 'content-length')), body: chunks.length ? Buffer.concat(chunks) : undefined }), W.env, { waitUntil() {} });
  res.writeHead(r.status, { 'content-type': 'application/json' }); res.end(Buffer.from(await r.arrayBuffer()));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;

function runPython(w, id) {
  return new Promise((resolve) => {
    const p = spawn(PY, ['-I', 'runner.py'], { cwd: sbDir(w, id), env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT ?? '' } });
    let err = ''; p.stderr.on('data', (d) => (err += d)); p.stdout.on('data', (d) => (err += d));
    p.on('close', (code) => resolve({ id, code, err }));
  });
}

async function project(w, created) { return w.ns.getByName(created.j.project.id); }
/** Drive alarms with a fake clock until cond(project) or limit. */
async function drive(w, obj, cond, limit = 400) {
  for (let i = 0; i < limit; i++) {
    const s = obj.storage;
    if (s.alarm !== null && s.alarm <= w.now) await obj.alarm();
    const v = await obj.storage.get('project');
    if (await cond(v)) return v;
    w.now += 1000; await sleep(w.runner === 'python' ? 15 : 0);
  }
  throw Error('drive limit reached');
}
const experts = async (obj) => { const p = await obj.storage.get('project'); return Promise.all(p.runs.map((r) => obj.storage.get('expert:' + r))); };
const allText = (w) => { const out = []; const walk = (d) => { for (const n of readdirSync(d)) { const f = join(d, n); statSync(f).isDirectory() ? walk(f) : out.push([f, readFileSync(f, 'utf8')]); } }; walk(w.dirs); return out; };
const freshWorld = (opts) => { const dirs = mkdtempSync(join(tmp, 'w-')); W = makeWorld({ ...opts, dirs, gateway: `http://127.0.0.1:${PORT}` }); return W; };

// ───────────────────────── tests ─────────────────────────
await check('bootstrap reports configuration names only, never values', async () => {
  const w = freshWorld();
  const r = await call(w, 'GET', '/api/cloudbite/bootstrap');
  assert.equal(r.status, 200); assert.equal(r.j.configuration.liveReady, true); assert.equal(r.j.configuration.maxExperts, 5); assert.equal(r.j.experts.length, 6);
  for (const s of SECRETS) assert.ok(!r.text.includes(s));
  w.env.CLOUDBITE_NOSANA_API_KEY = ''; w.env.CLOUDBITE_DAYTONA_API_URL = 'http://evil.example';
  const r2 = await call(w, 'GET', '/api/cloudbite/bootstrap');
  assert.equal(r2.j.configuration.liveReady, false);
  assert.deepEqual(r2.j.configuration.missing, ['CLOUDBITE_DAYTONA_API_URL', 'CLOUDBITE_NOSANA_API_KEY']);
  assert.ok(!r2.text.includes('evil.example'));
  assert.equal(M.cloudbiteMissing({}, 0).at(-1), 'expert catalogue (src/cloudbite-personas.ts)');
});

await check('pages: / and /cloudbite serve the console with same-origin CSP; legacy /borrow and /p/ token gate preserved', async () => {
  const w = freshWorld();
  for (const p of ['/', '/cloudbite']) { const r = await call(w, 'GET', p); assert.equal(r.status, 200); assert.match(r.headers.get('content-security-policy'), /script-src 'self'/); }
  assert.equal((await call(w, 'GET', '/cloudbite/app.js')).headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal((await call(w, 'GET', '/borrow')).status, 200);
  assert.equal((await call(w, 'POST', '/p/openrouter/api/v1/chat', { body: {} })).status, 401);
});

await check('create requires admin session, exact Origin, JSON, body limit and bounded expert count', async () => {
  const w = freshWorld();
  assert.equal((await call(w, 'POST', '/api/cloudbite/projects', { body: brief(), headers: { origin: 'https://cb.test' } })).status, 401);
  assert.equal((await call(w, 'POST', '/api/cloudbite/projects', { body: brief(), headers: { ...admin, 'x-admin-token': 'nope' } })).status, 401);
  assert.equal((await call(w, 'POST', '/api/cloudbite/projects', { body: brief(), headers: { 'x-admin-token': SECRETS[2] } })).status, 403);
  assert.equal((await call(w, 'POST', '/api/cloudbite/projects', { body: brief(), headers: { ...admin, origin: 'https://evil.test' } })).status, 403);
  assert.equal((await call(w, 'POST', '/api/cloudbite/projects', { body: brief(), headers: { ...admin, 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await call(w, 'POST', '/api/cloudbite/projects', { body: brief(), raw: JSON.stringify({ ...brief(), context: 'x'.repeat(20000) }), headers: admin })).status, 413);
  assert.equal((await call(w, 'POST', '/api/cloudbite/projects', { body: brief({ expertIds: ['market', 'risk', 'ops', 'legal', 'finance', 'ux'] }), headers: admin })).status, 400);
  assert.equal((await call(w, 'POST', '/api/cloudbite/projects', { body: brief({ expertIds: ['nobody'] }), headers: admin })).status, 400);
  assert.equal((await call(w, 'POST', '/api/cloudbite/projects', { body: { ...brief(), extra: 1 }, headers: admin })).status, 400);
  assert.equal(w.posts, 0); assert.equal(w.fetches.length, 0);
});

await check('live run: distinct sandbox per expert, persona placement, real python runner tools, artifacts and cleanup', async () => {
  const w = freshWorld();
  const created = await call(w, 'POST', '/api/cloudbite/projects', { body: brief(), headers: admin });
  assert.equal(created.status, 201, created.text);
  assert.match(created.j.accessToken, /^cbt_/);
  const obj = await project(w, created);
  await drive(w, obj, (p) => p.status !== 'running', 2000);
  await Promise.all(w.procs);
  const ex = await experts(obj);
  const p = await obj.storage.get('project');
  assert.equal(p.status, 'completed', JSON.stringify(ex.map((e) => [e.run.status, e.run.error, e.run.activity.at(-1)])));
  // one sandbox per expert, labelled with its own run and claim
  assert.equal(w.posts, 3);
  const ids = ex.map((e) => e.run.sandboxId); assert.equal(new Set(ids).size, 3);
  for (const e of ex) {
    const sb = [...w.deletes].includes(e.run.sandboxId);
    assert.ok(sb, 'owned sandbox deleted');
    const persona = readFileSync(join(sbDir(w, e.run.sandboxId), 'PERSONA.md'), 'utf8');
    assert.match(persona, new RegExp('EXPERT_ID=' + e.run.expertId + '\\n'));
    assert.ok(existsSync(join(sbDir(w, e.run.sandboxId), 'contract', 'result.schema.json')));
    assert.ok(!existsSync(join(sbDir(w, e.run.sandboxId), '.cloudbite', 'capability.json')), 'capability file removed by runner');
    assert.equal(readFileSync(join(sbDir(w, e.run.sandboxId), 'work', 'calc.txt'), 'utf8'), '45', 'python tool executed inside the workspace');
    assert.equal(e.run.status, 'completed');
    assert.deepEqual(e.run.artifacts.map((a) => a.path), ['out/result.json', 'out/report.md', 'out/analysis.md']);
    assert.ok(e.run.activity.some((a) => a.kind === 'tool' && /python -> exit 0/.test(a.message)));
    assert.equal(e.run.opinion.confidence, 72);
  }
  assert.equal(ex.find((e) => e.run.expertId === 'risk').run.opinion.direction, 'concern');
  assert.deepEqual([...w.deletes].sort(), [...ids].sort());
  // secrets never reached sandbox files, the model input or the public project
  for (const [, text] of allText(w)) for (const s of SECRETS) assert.ok(!text.includes(s));
  for (const req of w.nosana) { assert.equal(req.model, 'fake-model'); assert.ok(req.max_tokens <= 1200); for (const s of SECRETS) assert.ok(!JSON.stringify(req).includes(s)); }
  const read = await call(w, 'GET', `/api/cloudbite/projects/${created.j.project.id}`, { headers: { authorization: 'Bearer ' + created.j.accessToken } });
  assert.equal(read.status, 200); assert.equal(read.j.status, 'completed');
  for (const s of SECRETS) assert.ok(!read.text.includes(s));
  const art = await call(w, 'GET', `/api/cloudbite/projects/${created.j.project.id}/artifact?expert=market&path=out/report.md`, { headers: { authorization: 'Bearer ' + created.j.accessToken } });
  assert.equal(art.status, 200); assert.match(art.j.content, /market report/);
  // registry slot is released after cleanup
  assert.deepEqual(await w.ns.getByName('registry').storage.get('reg'), {});
});

await check('artifact endpoint rejects traversal/arbitrary paths and requires the project token', async () => {
  const w = freshWorld({ runner: 'none' });
  const created = await call(w, 'POST', '/api/cloudbite/projects', { body: brief({ mode: 'demo' }), headers: admin });
  const obj = await project(w, created); await drive(w, obj, (p) => p.status !== 'running');
  const base = `/api/cloudbite/projects/${created.j.project.id}/artifact?expert=e0&path=`;
  const h = { authorization: 'Bearer ' + created.j.accessToken };
  for (const bad of ['../x', 'out/../../etc/passwd', '/etc/passwd', 'runner.py', '.cloudbite/capability.json', 'out/a/b.md', 'out/.started', 'out/x.sh', 'out%2F..%2Fx'])
    assert.equal((await call(w, 'GET', base + encodeURIComponent(bad), { headers: h })).status, 400, bad);
  assert.equal((await call(w, 'GET', base + 'out/notes.md', { headers: h })).status, 404);
  assert.equal((await call(w, 'GET', base + 'out/report.md')).status, 401);
  assert.equal((await call(w, 'GET', base + 'out/report.md', { headers: { authorization: 'Bearer cbt_' + 'A'.repeat(43) } })).status, 401);
  assert.equal((await call(w, 'GET', base + 'out/report.md', { headers: h })).status, 200);
});

await check('demo mode never contacts providers and is labelled as simulated', async () => {
  const w = freshWorld({ runner: 'none', env: { CLOUDBITE_DAYTONA_API_KEY: '', CLOUDBITE_NOSANA_API_KEY: '' } });
  const created = await call(w, 'POST', '/api/cloudbite/projects', { body: brief({ mode: 'demo', expertIds: ['market', 'risk', 'ops', 'legal', 'finance'] }), headers: admin });
  assert.equal(created.status, 201);
  const obj = await project(w, created); const p = await drive(w, obj, (p) => p.status !== 'running');
  assert.equal(p.status, 'completed'); assert.equal(w.fetches.length, 0);
  for (const e of await experts(obj)) { assert.equal(e.run.sandboxId, undefined); assert.ok(e.run.activity.every((a) => a.message.includes('[demo]'))); assert.match(e.run.opinion.summary, /\[demo\]/); }
  // live creation with missing config is refused by name
  const live = await call(w, 'POST', '/api/cloudbite/projects', { body: brief(), headers: admin });
  assert.equal(live.status, 503); assert.match(live.j.error, /CLOUDBITE_DAYTONA_API_KEY/);
});

await check('bounded concurrency: 5 experts never exceed 3 provisioning/running at once', async () => {
  const w = freshWorld({ runner: 'none' });
  const created = await call(w, 'POST', '/api/cloudbite/projects', { body: brief({ expertIds: ['market', 'risk', 'ops', 'legal', 'finance'] }), headers: admin });
  const obj = await project(w, created);
  let peak = 0;
  for (let i = 0; i < 40; i++) {
    if (obj.storage.alarm !== null && obj.storage.alarm <= w.now) await obj.alarm();
    const ex = await experts(obj); peak = Math.max(peak, ex.filter((e) => !['queued', 'final'].includes(e.int.phase)).length);
    w.now += 1000;
  }
  const ex = await experts(obj);
  assert.equal(peak, 3); assert.equal(w.posts, 3);
  assert.equal(ex.filter((e) => e.run.status === 'queued').length, 2);
  assert.equal(ex.filter((e) => e.run.status === 'running').length, 3);
});

/** Run with the in-test "runner": read the uploaded capability, then call the worker endpoints directly. */
async function manualRun(w, n = 1) {
  const created = await call(w, 'POST', '/api/cloudbite/projects', { body: brief({ expertIds: ['market', 'risk', 'ops'].slice(0, n) }), headers: admin });
  const obj = await project(w, created);
  await drive(w, obj, async () => (await experts(obj)).every((e) => e.run.status === 'running'));
  const caps = (await experts(obj)).map((e) => JSON.parse(readFileSync(join(sbDir(w, e.run.sandboxId), '.cloudbite', 'capability.json'), 'utf8')));
  return { created, obj, caps };
}
const wcall = (w, cap, action, body, extra = {}) => call(w, 'POST', `/p/_cloudbite/worker/${extra.project ?? cap.project}/${extra.run ?? cap.run}/${action}`, { body, headers: { authorization: 'Bearer ' + (extra.token ?? cap.token), ...(extra.headers ?? {}) } });
const msgs = { messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'EXPERT_ID=market' }] };

await check('worker capability: scoped to one expert, bounded calls, one in flight, expiry, no upstream leakage', async () => {
  const w = freshWorld({ runner: 'none' });
  const { caps } = await manualRun(w, 2);
  const [a, b] = caps;
  assert.equal(a.gateway, `http://127.0.0.1:${PORT}`);
  assert.equal((await wcall(w, a, 'inference', msgs)).status, 200);
  assert.equal((await wcall(w, a, 'inference', msgs, { run: b.run })).status, 401, 'expert A token cannot act as B');
  assert.equal((await wcall(w, a, 'inference', msgs, { token: 'cbw_' + 'B'.repeat(43) })).status, 401);
  assert.equal((await wcall(w, a, 'inference', msgs, { headers: { origin: 'https://cb.test' } })).status, 403, 'browser-origin calls refused');
  assert.equal((await wcall(w, a, 'inference', { messages: [{ role: 'tool', content: 'x' }] })).status, 400);
  assert.equal((await call(w, 'POST', `/p/_cloudbite/worker/${a.project}/${a.run}/inference`, { raw: 'x'.repeat(60 * 1024), body: 1, headers: { authorization: 'Bearer ' + a.token } })).status, 413);
  // one at a time
  w.nosanaHold = gate();
  const pending = wcall(w, a, 'inference', msgs); await sleep(5);
  assert.equal((await wcall(w, a, 'inference', msgs)).status, 429);
  w.nosanaHold.resolve(); assert.equal((await pending).status, 200); w.nosanaHold = null;
  // upstream failure: generic error, no body/secret reflection
  w.nosanaFail = true;
  const bad = await wcall(w, a, 'inference', msgs);
  assert.equal(bad.status, 502); assert.ok(!bad.text.includes('upstream says')); assert.ok(!bad.text.includes(SECRETS[1]));
  w.nosanaFail = false;
  // budget: 8 calls total per expert (3 used + 5 more), then 429
  for (let i = 0; i < 5; i++) assert.equal((await wcall(w, a, 'inference', msgs)).status, 200);
  assert.equal((await wcall(w, a, 'inference', msgs)).status, 429);
  assert.equal(w.nosana.length, 8);
  // expiry
  w.now = a.expiresAt + 1;
  assert.equal((await wcall(w, b, 'inference', msgs)).status, 401);
});

await check('cancellation revokes capability before cleanup; late inference/complete cannot resurrect', async () => {
  const w = freshWorld({ runner: 'none' });
  const { created, obj, caps } = await manualRun(w, 1);
  const [a] = caps;
  w.nosanaHold = gate();
  const inflight = wcall(w, a, 'inference', msgs); await sleep(5);
  const c = await call(w, 'POST', `/api/cloudbite/projects/${created.j.project.id}/cancel`, { body: {}, headers: { origin: 'https://cb.test', authorization: 'Bearer ' + created.j.accessToken } });
  assert.equal(c.status, 200); assert.equal(c.j.status, 'cancelled'); assert.equal(c.j.experts[0].status, 'cancelled');
  const e0 = (await experts(obj))[0]; assert.equal(e0.int.capHash, undefined);
  assert.equal(w.deletes.length, 0, 'revocation persisted before any cleanup call');
  w.nosanaHold.resolve(); assert.equal((await inflight).status, 410);
  assert.equal((await wcall(w, a, 'complete', { status: 'ok' })).status, 401);
  // a finished runner's outputs appear late — still not collected
  const dir = sbDir(w, e0.run.sandboxId); mkdirSync(join(dir, 'out'), { recursive: true }); writeFileSync(join(dir, 'out', 'done'), 'ok');
  await drive(w, obj, () => w.deletes.length === 1);
  const p = await obj.storage.get('project'); const after = (await experts(obj))[0];
  assert.equal(p.status, 'cancelled'); assert.equal(after.run.status, 'cancelled'); assert.equal(after.run.opinion, undefined);
  assert.deepEqual(w.deletes, [e0.run.sandboxId]);
  // cancel is idempotent; bad origin refused
  assert.equal((await call(w, 'POST', `/api/cloudbite/projects/${created.j.project.id}/cancel`, { body: {}, headers: { origin: 'https://cb.test', authorization: 'Bearer ' + created.j.accessToken } })).j.status, 'cancelled');
  assert.equal((await call(w, 'POST', `/api/cloudbite/projects/${created.j.project.id}/cancel`, { body: {}, headers: { authorization: 'Bearer ' + created.j.accessToken } })).status, 403);
});

await check('malformed result is failed, not completed', async () => {
  const w = freshWorld({ runner: 'none' });
  const { obj, caps } = await manualRun(w, 2);
  const ex = await experts(obj);
  const write = (e, files) => { for (const [p, t] of Object.entries(files)) { mkdirSync(dirname(join(sbDir(w, e.run.sandboxId), p)), { recursive: true }); writeFileSync(join(sbDir(w, e.run.sandboxId), p), t); } };
  write(ex[0], { 'out/result.json': JSON.stringify({ schema: 'cloudbite.expert-result/v1', expertId: 'market', opinion: { direction: 'support', confidence: 140, summary: 'x', evidence: [], assumptions: [], nextActions: [] } }), 'out/report.md': '# r', 'out/done': 'ok' });
  write(ex[1], { 'out/result.json': JSON.stringify({ schema: 'cloudbite.expert-result/v1', expertId: 'risk', opinion: { direction: 'concern', confidence: 50, summary: 'fine', evidence: ['e'], assumptions: [], nextActions: [] } }), 'out/report.md': '# ok', 'out/manifest.json': JSON.stringify({ files: ['../../etc/passwd', 'out/notes.md', '/x'] }), 'out/notes.md': 'n', 'out/done': 'ok' });
  for (const c of caps) await wcall(w, c, 'complete', { status: 'ok' });
  const p = await drive(w, obj, (p) => p.status !== 'running');
  const after = await experts(obj);
  assert.equal(after[0].run.status, 'failed'); assert.match(after[0].run.error, /malformed result: confidence/); assert.equal(after[0].run.opinion, undefined);
  assert.equal(after[1].run.status, 'completed'); assert.deepEqual(after[1].run.artifacts.map((a) => a.path), ['out/result.json', 'out/report.md', 'out/notes.md']);
  assert.equal(p.status, 'partial');
});

await check('lost create response adopts the labelled sandbox instead of creating a duplicate', async () => {
  const w = freshWorld({ runner: 'none', loseCreate: true });
  const created = await call(w, 'POST', '/api/cloudbite/projects', { body: brief({ expertIds: ['market'] }), headers: admin });
  const obj = await project(w, created);
  await drive(w, obj, async () => (await experts(obj))[0].run.status === 'running');
  const [e] = await experts(obj);
  assert.equal(w.posts, 1); assert.equal(e.run.sandboxId, 'SB-1');
  assert.ok(e.run.activity.some((a) => /adopted sandbox SB-1/.test(a.message)));
});

await check('cleanup retries failed deletes, is idempotent and deletes only owned ids', async () => {
  const w = freshWorld({ runner: 'none', deleteFailures: 2 });
  w.sandboxes.set('SB-999', { id: 'SB-999', labels: { 'cloudbite-project': 'someone-else' }, state: 'started' });
  const { created, obj } = await manualRun(w, 2);
  await call(w, 'POST', `/api/cloudbite/projects/${created.j.project.id}/cancel`, { body: {}, headers: { origin: 'https://cb.test', authorization: 'Bearer ' + created.j.accessToken } });
  await drive(w, obj, () => w.deletes.length === 2, 3000);
  assert.ok(w.sandboxes.has('SB-999'));
  assert.deepEqual([...w.deletes].sort(), ['SB-1', 'SB-2']);
  const entries = [...(await obj.storage.list({ prefix: 'cleanup:' })).values()];
  assert.ok(entries.every((x) => x.done)); assert.ok(entries.some((x) => x.tries > 0));
  // TTL purge removes the record after retention
  w.now += 25 * 3600_000; await obj.alarm();
  assert.equal(obj.storage.m.size, 0);
});

await check('idempotent create: retried requestId returns the same project, new token, no new sandboxes; changed brief is 409', async () => {
  const w = freshWorld({ runner: 'none' });
  const b = brief({ expertIds: ['market'] });
  const first = await call(w, 'POST', '/api/cloudbite/projects', { body: b, headers: admin });
  const obj = await project(w, first); await drive(w, obj, async () => (await experts(obj))[0].run.status === 'running');
  const again = await call(w, 'POST', '/api/cloudbite/projects', { body: b, headers: admin });
  assert.equal(again.status, 201); assert.equal(again.j.project.id, first.j.project.id); assert.notEqual(again.j.accessToken, first.j.accessToken);
  await drive(w, obj, () => true); assert.equal(w.posts, 1);
  assert.equal((await call(w, 'POST', '/api/cloudbite/projects', { body: { ...b, title: 'other' }, headers: admin })).status, 409);
});

await check('registry bounds active live projects; unsupported workspace pack is refused before any provider call', async () => {
  const w = freshWorld({ runner: 'none' });
  assert.equal((await call(w, 'POST', '/api/cloudbite/projects', { body: brief(), headers: admin })).status, 201);
  assert.equal((await call(w, 'POST', '/api/cloudbite/projects', { body: brief(), headers: admin })).status, 201);
  const third = await call(w, 'POST', '/api/cloudbite/projects', { body: brief(), headers: admin });
  assert.equal(third.status, 429);
  const w2 = freshWorld({ runner: 'none' });
  globalThis.__badWorkspace = true;
  const r = await call(w2, 'POST', '/api/cloudbite/projects', { body: brief(), headers: admin });
  globalThis.__badWorkspace = false;
  assert.equal(r.status, 503); assert.match(r.j.error, /workspace pack unavailable/); assert.equal(w2.fetches.length, 0);
  assert.deepEqual(await w2.ns.getByName('registry').storage.get('reg'), {});
});

await check('validators: workspace paths and opinion schema', async () => {
  assert.ok(M.isInvalid(M.validateWorkspace([{ path: 'runner.py', content: '' }])));
  assert.ok(M.isInvalid(M.validateWorkspace([{ path: '/abs.md', content: '' }])));
  assert.ok(M.isInvalid(M.validateWorkspace([{ path: 'a/../b.md', content: '' }])));
  assert.ok(M.isInvalid(M.validateWorkspace([{ path: 'PERSONA.md', content: '' }, { path: 'PROJECT.md', content: '' }])));
  assert.ok(M.isInvalid(M.validateOpinion({ direction: 'support', confidence: true, summary: 's', evidence: [], assumptions: [], nextActions: [] })));
  assert.ok(!M.isInvalid(M.validateOpinion({ direction: 'abstain', confidence: 0, summary: 's', evidence: [], assumptions: [], nextActions: [] })));
  assert.ok(M.CB_RUNNER_PY.includes("os.remove(CAP_FILE)"));
});

server.close();
rmSync(tmp, { recursive: true, force: true });
console.log(`\n${count} cloudbite runtime checks passed`);
