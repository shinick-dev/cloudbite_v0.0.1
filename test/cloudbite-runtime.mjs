// Cloudbite runtime: real Worker router + real CloudbiteProject DO + memory storage + fake Daytona/Nosana.
// The fake Daytona toolbox maps each sandbox to its own temp directory and, for live runs, executes the real
// Python runner (runner.py) there; the runner calls back through a local HTTP gateway into the Worker router.
// No external network: any host other than the fakes and 127.0.0.1 fails the test.
// Most checks use a small fixture catalogue (stable ids, EXPERT_ID marker) that re-exports the real opinion/brief
// contract. The last check bundles the ACTUAL catalogue and buildExpertWorkspace (real-catalogue integration smoke).
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
export { CLOUDBITE_BRIEF_LIMITS, CLOUDBITE_OPINION_LIMITS, validateExpertOpinion } from './src/cloudbite-personas.ts';
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
const stubs = (fixture) => ({ name: 'stubs', setup(b) {
  b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'cf', namespace: 'stub' }));
  b.onLoad({ filter: /^cf$/, namespace: 'stub' }, () => ({ contents: 'export class DurableObject { constructor(ctx,env){this.ctx=ctx;this.env=env;} }' }));
  if (fixture) {
    b.onResolve({ filter: /cloudbite-personas$/ }, () => ({ path: 'personas', namespace: 'stub' }));
    b.onLoad({ filter: /^personas$/, namespace: 'stub' }, () => ({ contents: PERSONAS, loader: 'js', resolveDir: process.cwd() }));
  }
} });
const entry = `export { default, CloudbiteProject } from './src/index.ts'; export * from './src/cloudbite-config.ts'; export * from './src/cloudbite-validate.ts'; export { CB_RUNNER_PY } from './src/cloudbite-runner.ts'; export { CLOUDBITE_OPINION_LIMITS, CLOUDBITE_BRIEF_LIMITS } from './src/cloudbite-personas.ts';`;
const tmp = mkdtempSync(join(tmpdir(), 'cloudbite-runtime-'));
async function load(fixture) {
  const bundle = await build({ stdin: { contents: entry, resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, format: 'esm', platform: 'node', plugins: [stubs(fixture)], loader: { '.ps1': 'text' } });
  const file = join(tmp, fixture ? 'fixture.mjs' : 'real.mjs');
  writeFileSync(file, bundle.outputFiles[0].text);
  return import(pathToFileURL(file));
}
const M = await load(true);      // fixture catalogue
const REAL = await load(false);  // actual src/cloudbite-personas.ts catalogue and workspace packs

let count = 0;
const check = async (name, f) => { await f(); count++; console.log('ok', name); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const gate = () => { let resolve; const p = new Promise((r) => (resolve = r)); return { p, resolve }; };
const jr = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
const SECRETS = ['DAYTONA-SECRET-VALUE', 'NOSANA-SECRET-VALUE', 'ADMIN-TOKEN-VALUE'];
const QWEN = 'qwen/qwen3.8-27b';
const HIDDEN = 'HIDDEN-REASONING-TRACE';
const PLAIN_KEYS = ['max_tokens', 'messages', 'model', 'stream', 'temperature'];

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
  const w = { M, now: 1_800_000_000_000, sandboxes: new Map(), posts: 0, deletes: [], creating: 0, maxCreating: 0, nosana: [], fetches: [], uas: [], dirs: tmp, runner: opts.runner ?? 'python', procs: [], ...opts };
  const objects = new Map();
  class TestProject extends w.M.CloudbiteProject { clock() { return w.now; } }
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
  const r = await w.M.default.fetch(new Request('https://cb.test' + path, init), w.env, { waitUntil() {} });
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
    if (w.nosanaEmpty) return jr({ choices: [{ message: { content: w.nosanaEmpty.content, reasoning_content: HIDDEN + ' ' + SECRETS[1] }, finish_reason: w.nosanaEmpty.finish }] });
    // Like qwen/qwen3.8-27b on a realistic prompt: with thinking on, reasoning eats max_tokens and content stays null.
    if (req.model === QWEN && req.chat_template_kwargs?.enable_thinking !== false) return jr({ choices: [{ message: { content: null, reasoning_content: HIDDEN }, finish_reason: 'length' }] });
    // Like qwen/qwen3.8-27b with thinking off but no JSON mode on the visitor sample: a long, unparseable JSON-ish answer.
    if (req.model === QWEN && req.response_format?.type !== 'json_object') return jr({ choices: [{ message: { content: '{"action": "finish", "summary": "unescaped "quote" and' + ' x'.repeat(1000) }, finish_reason: 'stop' }] });
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
  const ws = req.messages[1].content;
  const id = (ws.match(/EXPERT_ID=(\w+)/) ?? ws.match(/^Expert id: `([a-z0-9-]+)`/m) ?? [])[1];
  if (W.model) return W.model(req, turn);
  if (W.badFinal) return '{"action":"final","opinion":{"direction":"maybe"},"report":""}';
  if (W.finalPatch && turn >= 2) return JSON.stringify({ action: 'final', opinion: { direction: 'support', confidence: 72, summary: 's', evidence: ['e'], assumptions: ['a'], nextActions: ['n'], ...W.finalPatch }, report: '# r' });
  if (turn === 0) return 'Plan: compute.\n```json\n{"action":"python","code":"import json\\nprint(\\"ROI\\", sum(range(10)))\\nopen(\\"calc.txt\\",\\"w\\").write(\\"45\\")"}\n```';
  if (turn === 1) return JSON.stringify({ action: 'write', path: 'out/analysis.md', content: `# ${id} analysis\nTool said: ${req.messages.at(-1).content.slice(0, 60)}` });
  return JSON.stringify({ action: 'final', opinion: { direction: id === 'risk' ? 'concern' : 'support', confidence: 72, summary: `${id} summary`, evidence: ['computed 45 in sandbox'], assumptions: ['fixture'], nextActions: ['pilot'] }, report: `# ${id} report\n\nBased on the python tool.` });
}

// Local gateway: sandbox runner → http://127.0.0.1:<port>/p/_cloudbite/worker/... → Worker router.
// Like Cloudflare's edge in production, it refuses urllib's default User-Agent (403, error code 1010) before the Worker.
const RUNNER_UA = 'Cloudbite-Runner/0.0.1';
const server = createServer(async (req, res) => {
  const ua = req.headers['user-agent'] ?? '';
  W?.uas.push(ua);
  if (/^Python-urllib\//.test(ua)) { res.writeHead(403, { 'content-type': 'text/plain' }); res.end('error code: 1010'); return; }
  const chunks = []; for await (const c of req) chunks.push(c);
  const r = await W.M.default.fetch(new Request('https://gw.test' + req.url, { method: req.method, headers: Object.fromEntries(Object.entries(req.headers).filter(([k]) => k !== 'host' && k !== 'connection' && k !== 'content-length')), body: chunks.length ? Buffer.concat(chunks) : undefined }), W.env, { waitUntil() {} });
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
  for (const p of ['/', '/cloudbite']) {
    const r = await call(w, 'GET', p); assert.equal(r.status, 200);
    const csp = r.headers.get('content-security-policy');
    assert.match(csp, /script-src 'self';/); assert.match(csp, /style-src 'self';/); assert.ok(!csp.includes('unsafe-inline'));
    // every asset the served page references is served by the same router with the right type
    const scripts = [...r.text.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]);
    const styles = [...r.text.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*href="([^"]+)"/g)].map((m) => m[1]);
    assert.equal(scripts.length, 1); assert.equal(styles.length, 1);
    assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>|<style\b|\sstyle="/.test(r.text), 'no inline script/style for the strict CSP');
    for (const [src, type] of [[scripts[0], 'text/javascript; charset=utf-8'], [styles[0], 'text/css; charset=utf-8']]) {
      assert.match(src, /^\/cloudbite\//);
      const a = await call(w, 'GET', src);
      assert.equal(a.status, 200, src); assert.equal(a.headers.get('content-type'), type); assert.ok(a.text.length > 1000, src);
    }
  }
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
  // every runner callback (activity, inference, complete) went through with the explicit runner User-Agent
  assert.ok(w.uas.length >= 3 * 4, 'runner callbacks reached the gateway');
  assert.deepEqual([...new Set(w.uas)], [RUNNER_UA]);
  // secrets never reached sandbox files, the model input or the public project
  for (const [, text] of allText(w)) for (const s of SECRETS) assert.ok(!text.includes(s));
  for (const req of w.nosana) { assert.equal(req.model, 'fake-model'); assert.ok(req.max_tokens <= 1200); assert.deepEqual(Object.keys(req).sort(), PLAIN_KEYS, 'generic model keeps the plain request shape'); for (const s of SECRETS) assert.ok(!JSON.stringify(req).includes(s)); }
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
  write(ex[0], { 'out/result.json': JSON.stringify({ direction: 'support', confidence: 140, summary: 'x', evidence: ['e'], assumptions: ['a'], nextActions: ['n'] }), 'out/report.md': '# r', 'out/done': 'ok' });
  write(ex[1], { 'out/result.json': JSON.stringify({ direction: 'concern', confidence: 50, summary: 'fine', evidence: ['e'], assumptions: ['a'], nextActions: ['n'] }), 'out/report.md': '# ok', 'out/manifest.json': JSON.stringify({ files: ['../../etc/passwd', 'out/notes.md', '/x'] }), 'out/notes.md': 'n', 'out/done': 'ok' });
  for (const c of caps) await wcall(w, c, 'complete', { status: 'ok' });
  const p = await drive(w, obj, (p) => p.status !== 'running');
  const after = await experts(obj);
  assert.equal(after[0].run.status, 'failed'); assert.match(after[0].run.error, /malformed result: confidence/); assert.equal(after[0].run.opinion, undefined);
  assert.equal(after[1].run.status, 'completed'); assert.deepEqual(after[1].run.artifacts.map((a) => a.path), ['out/result.json', 'out/report.md', 'out/notes.md']);
  assert.equal(p.status, 'partial');
});

await check('legacy wrapped, fractional-confidence and over-limit result.json files are failed, not completed', async () => {
  const L = M.CLOUDBITE_OPINION_LIMITS;
  const good = { direction: 'support', confidence: 60, summary: 's', evidence: ['e'], assumptions: ['a'], nextActions: ['n'] };
  const cases = [
    [{ schema: 'cloudbite.expert-result/v1', expertId: 'market', opinion: good }, /unexpected property/],
    [{ ...good, confidence: 60.5 }, /confidence must be an integer/],
    [{ ...good, evidence: Array(L.items + 1).fill('e') }, /evidence/],
  ];
  const w = freshWorld({ runner: 'none' });
  const { obj, caps } = await manualRun(w, cases.length);
  const ex = await experts(obj);
  for (const [i, [result]] of cases.entries()) {
    const dir = sbDir(w, ex[i].run.sandboxId); mkdirSync(join(dir, 'out'), { recursive: true });
    writeFileSync(join(dir, 'out', 'result.json'), JSON.stringify(result)); writeFileSync(join(dir, 'out', 'report.md'), '# r'); writeFileSync(join(dir, 'out', 'done'), 'ok');
  }
  for (const c of caps) await wcall(w, c, 'complete', { status: 'ok' });
  const p = await drive(w, obj, (p) => p.status !== 'running');
  const after = await experts(obj);
  for (const [i, [, why]] of cases.entries()) { assert.equal(after[i].run.status, 'failed'); assert.match(after[i].run.error, why); assert.equal(after[i].run.opinion, undefined); }
  assert.equal(p.status, 'failed');
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
  const L = M.CLOUDBITE_OPINION_LIMITS;
  const edge = { direction: 'abstain', confidence: 0, summary: 's'.repeat(L.summary), evidence: Array(L.items).fill('e'.repeat(L.item)), assumptions: ['a'], nextActions: ['n'] };
  assert.ok(!M.isInvalid(M.validateOpinion(edge)), 'opinion at exact limits');
  assert.ok(!M.isInvalid(M.validateResult(JSON.stringify(edge))), 'flat result.json at exact limits');
  for (const bad of [{ confidence: true }, { confidence: 0.5 }, { evidence: [] }, { summary: 's'.repeat(L.summary + 1) }, { assumptions: ['x'.repeat(L.item + 1)] }, { extra: 1 }])
    assert.ok(M.isInvalid(M.validateOpinion({ ...edge, ...bad })), JSON.stringify(bad).slice(0, 60));
  const B = M.CLOUDBITE_BRIEF_LIMITS;
  const ok = { title: 't'.repeat(B.title), objective: 'o'.repeat(B.objective), context: 'c'.repeat(B.context), expertIds: ['market'], mode: 'demo', requestId: 'r'.repeat(B.requestIdMin) };
  assert.ok(!M.isInvalid(M.validateBrief(ok)), 'brief at exact limits');
  for (const bad of [{ title: 't'.repeat(B.title + 1) }, { objective: 'o'.repeat(B.objective + 1) }, { context: 'c'.repeat(B.context + 1) }, { requestId: 'r'.repeat(B.requestIdMin - 1) }, { requestId: 'r'.repeat(B.requestId + 1) }])
    assert.ok(M.isInvalid(M.validateBrief({ ...ok, ...bad })), Object.keys(bad)[0]);
  assert.ok(M.CB_RUNNER_PY.includes("os.remove(CAP_FILE)"));
});

await check('real catalogue: actual persona workspace -> python runner -> flat out/result.json -> server validation and artifact', async () => {
  const w = freshWorld({ M: REAL });
  const boot = await call(w, 'GET', '/api/cloudbite/bootstrap');
  assert.ok(boot.j.experts.length >= 10 && boot.j.experts.every((e) => e.id.startsWith('agency-')), 'actual catalogue, not the fixture');
  const ids = boot.j.experts.slice(0, 3).map((e) => e.id);
  // the console sends crypto.randomUUID() request ids
  const created = await call(w, 'POST', '/api/cloudbite/projects', { body: brief({ expertIds: ids, requestId: crypto.randomUUID() }), headers: admin });
  assert.equal(created.status, 201, created.text);
  const obj = await project(w, created);
  await drive(w, obj, (p) => p.status !== 'running', 2000);
  await Promise.all(w.procs);
  const p = await obj.storage.get('project'); const ex = await experts(obj);
  assert.equal(p.status, 'completed', JSON.stringify(ex.map((e) => [e.run.status, e.run.error, e.run.activity.at(-1)])));
  for (const e of ex) {
    const dir = sbDir(w, e.run.sandboxId);
    assert.ok(readFileSync(join(dir, 'PERSONA.md'), 'utf8').includes('Expert id: `' + e.run.expertId + '`'), 'actual persona placed in its own sandbox');
    const schema = JSON.parse(readFileSync(join(dir, 'RESULT.schema.json'), 'utf8'));
    const result = JSON.parse(readFileSync(join(dir, 'out', 'result.json'), 'utf8'));
    // the file the runner wrote is exactly the shape the workspace's schema declares
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(Object.keys(result).sort(), Object.keys(schema.properties).sort());
    assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort());
    assert.ok(schema.properties.direction.enum.includes(result.direction) && Number.isInteger(result.confidence));
    for (const k of ['evidence', 'assumptions', 'nextActions']) assert.ok(result[k].length >= schema.properties[k].minItems && result[k].length <= schema.properties[k].maxItems);
    assert.equal(e.run.status, 'completed');
    assert.deepEqual(e.run.opinion, result);
    const art = await call(w, 'GET', `/api/cloudbite/projects/${created.j.project.id}/artifact?expert=${e.run.id}&path=out/result.json`, { headers: { authorization: 'Bearer ' + created.j.accessToken } });
    assert.equal(art.status, 200); assert.deepEqual(JSON.parse(art.j.content), result);
  }
  for (const [, text] of allText(w)) for (const s of SECRETS) assert.ok(!text.includes(s));
});

await check('real catalogue: runner refuses a non-canonical final (fractional confidence); the expert fails, never completes', async () => {
  const w = freshWorld({ M: REAL, finalPatch: { confidence: 72.5 } });
  const id = (await call(w, 'GET', '/api/cloudbite/bootstrap')).j.experts[0].id;
  const created = await call(w, 'POST', '/api/cloudbite/projects', { body: brief({ expertIds: [id] }), headers: admin });
  const obj = await project(w, created);
  const p = await drive(w, obj, (p) => p.status !== 'running', 2000);
  await Promise.all(w.procs);
  const [e] = await experts(obj);
  assert.equal(p.status, 'failed'); assert.equal(e.run.status, 'failed'); assert.equal(e.run.opinion, undefined);
  assert.ok(e.run.activity.some((a) => /final rejected: confidence must be an integer/.test(a.message)));
  assert.ok(!existsSync(join(sbDir(w, e.run.sandboxId), 'out', 'result.json')));
});

await check('runner gateway: urllib default User-Agent is refused like the Cloudflare edge; the runner sends its own', async () => {
  const w = freshWorld({ runner: 'none' });
  const { caps: [a] } = await manualRun(w);
  const probe = (headers) => new Promise((resolve) => {
    const code = `import json,sys,urllib.request,urllib.error
req=urllib.request.Request(sys.argv[1],data=b'{}',method='POST',headers=json.loads(sys.argv[2]))
try:
  urllib.request.urlopen(req,timeout=10); print(200)
except urllib.error.HTTPError as e: print(e.code, e.read().decode())`;
    const p = spawn(PY, ['-I', '-c', code, `http://127.0.0.1:${PORT}/p/_cloudbite/worker/${a.project}/${a.run}/activity`, JSON.stringify(headers)], { env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT ?? '' } });
    let out = ''; p.stdout.on('data', (d) => (out += d)); p.on('close', () => resolve(out.trim()));
  });
  assert.equal(await probe({ 'content-type': 'application/json' }), '403 error code: 1010', 'default urllib UA blocked before the Worker');
  // the explicit runner UA reaches the Worker, which then rejects the missing capability itself
  assert.match(await probe({ 'content-type': 'application/json', 'user-agent': RUNNER_UA }), /^401 /);
  assert.match(M.CB_RUNNER_PY, /USER_AGENT = 'Cloudbite-Runner\/0\.0\.1'/);
  assert.match(M.CB_RUNNER_PY, /'user-agent': USER_AGENT/);
});

await check('real python runner: upstream inference failure is visible as a bounded category, never the upstream body or a secret', async () => {
  const w = freshWorld({ nosanaFail: true });
  const created = await call(w, 'POST', '/api/cloudbite/projects', { body: brief({ expertIds: ['market'] }), headers: admin });
  const obj = await project(w, created);
  const p = await drive(w, obj, (p) => p.status !== 'running', 2000);
  await Promise.all(w.procs);
  const [e] = await experts(obj);
  assert.equal(p.status, 'failed'); assert.equal(e.run.status, 'failed'); assert.equal(e.run.opinion, undefined);
  assert.equal(w.nosana.length, 1, 'no retries or fallback provider');
  const msgs = e.run.activity.map((a) => a.message);
  assert.ok(msgs.some((m) => /model call 1 failed: inference upstream failed \(500\)/.test(m)), msgs.join('\n'));
  assert.ok(e.run.activity.some((a) => a.kind === 'error' && a.message === 'sandbox: turn 1: inference failed: model provider returned an error (HTTP 502)'), msgs.join('\n'));
  const err = readFileSync(join(sbDir(w, e.run.sandboxId), 'out', 'error.txt'), 'utf8');
  assert.equal(err, 'turn 1: inference failed: model provider returned an error (HTTP 502)');
  assert.ok(!existsSync(join(sbDir(w, e.run.sandboxId), 'out', 'result.json')), 'no fabricated opinion');
  const read = await call(w, 'GET', `/api/cloudbite/projects/${created.j.project.id}`, { headers: { authorization: 'Bearer ' + created.j.accessToken } });
  for (const text of [read.text, JSON.stringify(e), ...allText(w).map(([, t]) => t)]) {
    assert.ok(!text.includes('upstream says') && !text.includes('internal trace'), 'upstream body never reflected');
    for (const s of SECRETS) assert.ok(!text.includes(s));
  }
  assert.deepEqual([...new Set(w.uas)], [RUNNER_UA]);
});

await check('real python runner: qwen/qwen3.8-27b is sent enable_thinking=false and json_object mode and completes; the fake answers only then', async () => {
  const w = freshWorld({ env: { CLOUDBITE_NOSANA_MODEL: QWEN } });
  const created = await call(w, 'POST', '/api/cloudbite/projects', { body: brief({ expertIds: ['market'] }), headers: admin });
  const obj = await project(w, created);
  const p = await drive(w, obj, (p) => p.status !== 'running', 2000);
  await Promise.all(w.procs);
  const [e] = await experts(obj);
  assert.equal(p.status, 'completed', JSON.stringify(e.run.activity.map((a) => a.message)));
  assert.equal(e.run.status, 'completed'); assert.equal(e.run.opinion.direction, 'support');
  assert.ok(w.nosana.length >= 3);
  for (const req of w.nosana) {
    assert.deepEqual(Object.keys(req).sort(), [...PLAIN_KEYS, 'chat_template_kwargs', 'response_format'].sort());
    assert.deepEqual(req.chat_template_kwargs, { enable_thinking: false });
    assert.deepEqual(req.response_format, { type: 'json_object' });
    assert.equal(req.model, QWEN); assert.equal(req.max_tokens, 1200); assert.equal(req.temperature, 0.3); assert.equal(req.stream, false);
  }
});

await check('empty model answers (null / length / whitespace) fail by bounded category; reasoning and body never surface', async () => {
  const w = freshWorld({ runner: 'none' });
  const { created, obj, caps: [a] } = await manualRun(w);
  const cases = [
    [{ content: null, finish: 'length' }, 'inference upstream used its output budget before any content (finish_reason=length)'],
    [{ content: null, finish: 'stop' }, 'inference upstream returned no content'],
    [{ content: ' \n\t ', finish: 'stop' }, 'inference upstream returned no content'],
    [{ content: '', finish: 'length' }, 'inference upstream used its output budget before any content (finish_reason=length)'],
  ];
  for (const [empty, error] of cases) {
    w.nosanaEmpty = empty;
    const r = await wcall(w, a, 'inference', msgs);
    assert.equal(r.status, 502); assert.deepEqual(Object.keys(r.j), ['error']); assert.equal(r.j.error, error);
  }
  w.nosanaEmpty = null;
  const [e] = await experts(obj);
  const errs = e.run.activity.filter((x) => x.kind === 'error').map((x) => x.message);
  assert.deepEqual(errs, cases.map(([, error], i) => `model call ${i + 1} failed: ${error}`));
  const read = await call(w, 'GET', `/api/cloudbite/projects/${created.j.project.id}`, { headers: { authorization: 'Bearer ' + created.j.accessToken } });
  for (const text of [read.text, JSON.stringify(e)]) {
    assert.ok(!text.includes(HIDDEN), 'hidden reasoning never reflected');
    for (const s of SECRETS) assert.ok(!text.includes(s));
  }
});

await check('real python runner: a length-exhausted empty answer fails the expert once, with no fabricated opinion or retry', async () => {
  const w = freshWorld({ nosanaEmpty: { content: null, finish: 'length' } });
  const created = await call(w, 'POST', '/api/cloudbite/projects', { body: brief({ expertIds: ['market'] }), headers: admin });
  const obj = await project(w, created);
  const p = await drive(w, obj, (p) => p.status !== 'running', 2000);
  await Promise.all(w.procs);
  const [e] = await experts(obj);
  assert.equal(p.status, 'failed'); assert.equal(e.run.status, 'failed'); assert.equal(e.run.opinion, undefined);
  assert.equal(w.nosana.length, 1, 'no retries, larger budget or fallback model');
  assert.ok(e.run.activity.some((x) => x.message === 'model call 1 failed: inference upstream used its output budget before any content (finish_reason=length)'));
  assert.equal(readFileSync(join(sbDir(w, e.run.sandboxId), 'out', 'error.txt'), 'utf8'), 'turn 1: inference failed: model provider returned an error (HTTP 502)');
  assert.ok(!existsSync(join(sbDir(w, e.run.sandboxId), 'out', 'result.json')), 'no fabricated opinion');
  const read = await call(w, 'GET', `/api/cloudbite/projects/${created.j.project.id}`, { headers: { authorization: 'Bearer ' + created.j.accessToken } });
  for (const text of [read.text, JSON.stringify(e), ...allText(w).map(([, t]) => t)]) {
    assert.ok(!text.includes(HIDDEN), 'hidden reasoning never reflected');
    for (const s of SECRETS) assert.ok(!text.includes(s));
  }
});

// ── compact final protocol: the 1200-token reply budget, reserved outputs and the last turn ──
const lastUser = (req) => req.messages.filter((m) => m.role === 'user').at(-1).content;
// What a 1200-token cut-off looks like: a final whose long report never reaches its closing braces.
const TRUNCATED = '{"action":"final","opinion":{"direction":"support","confidence":70,"summary":"Long.","evidence":["a"],"assumptions":["b"],"nextActions":["c"]},"report":"# Report\\n' + 'Very long analysis. '.repeat(240);
const oneExpert = async (w) => {
  const created = await call(w, 'POST', '/api/cloudbite/projects', { body: brief({ expertIds: ['market'] }), headers: admin });
  const obj = await project(w, created);
  const p = await drive(w, obj, (p) => p.status !== 'running', 3000);
  const procs = await Promise.all(w.procs);
  const [e] = await experts(obj);
  return { created, p, e, dir: sbDir(w, e.run.sandboxId), procs };
};

await check('real python runner: the prompt states the reply budget, reserved outputs and a valid compact final example', async () => {
  const w = freshWorld();
  const { p } = await oneExpert(w);
  assert.equal(p.status, 'completed');
  const system = w.nosana[0].messages[0].content;
  assert.match(system, /limited to about 1200 tokens/);
  assert.match(system, /out\/result\.json, out\/report\.md, out\/manifest\.json and out\/done are reserved/);
  // the example the model is shown is itself a final the runner and the server accept
  const example = JSON.parse(system.match(/^\{"action":"final".*\}$/m)[0]);
  assert.ok(!M.isInvalid(M.validateOpinion(example.opinion)) && example.report.trim());
  assert.ok(JSON.stringify(example).length < 2500);
});

await check('real python runner: truncated final and reserved write get compact guidance; the model recovers with a real-script final', async () => {
  const opinion = { direction: 'conditional', confidence: 64, summary: 'ROI is positive once the pilot cost is covered.', evidence: [], assumptions: ['pilot cost is fixed'], nextActions: ['run a two-week pilot', 'recheck ROI'] };
  const w = freshWorld({ model: (req, turn) => {
    const hint = lastUser(req);
    if (turn === 0) return TRUNCATED;
    // like the production PM/strategy roles: tries to save the reserved result file itself
    if (turn === 1) return /cut off/.test(hint) && /under 2500 characters/.test(hint) ? JSON.stringify({ action: 'write', path: 'out/result.json', content: '{"direction":"support","forged":true}' }) : TRUNCATED;
    if (turn === 2) return /reserved and saved automatically by action=final/.test(hint)
      ? JSON.stringify({ action: 'python', code: 'cost, gain = 40, 58\nopen("roi.txt", "w").write(str(gain - cost))\nprint("ROI", gain - cost)' }) : TRUNCATED;
    if (turn === 3) return JSON.stringify({ action: 'write', path: 'out/analysis.md', content: '# Analysis\n' + hint.split('\n')[1] });
    // evidence comes from the tool output the runner actually returned
    const tool = req.messages.find((m) => m.role === 'user' && m.content.startsWith('Tool output:')).content;
    return JSON.stringify({ action: 'final', opinion: { ...opinion, evidence: [tool.split('\n')[2]] }, report: '# Market\n\nPilot first; ROI computed in the sandbox.' });
  } });
  const { p, e, dir } = await oneExpert(w);
  assert.equal(p.status, 'completed', JSON.stringify(e.run.activity.map((a) => a.message)));
  assert.equal(w.nosana.length, 5, 'recovered within the existing six turns, one call per turn');
  const msgs = e.run.activity.map((a) => a.message);
  assert.ok(msgs.some((m) => /turn 1: reply was not a valid action: JSON object is incomplete .* \(\d{4,} chars\)/.test(m)), msgs.join('\n'));
  assert.ok(msgs.some((m) => /turn 2: rejected: out\/result\.json is reserved/.test(m)), msgs.join('\n'));
  // the python tool really ran in the workspace and its output is the evidence
  assert.equal(readFileSync(join(dir, 'work', 'roi.txt'), 'utf8'), '18');
  const result = JSON.parse(readFileSync(join(dir, 'out', 'result.json'), 'utf8'));
  assert.deepEqual(result, { ...opinion, evidence: ['ROI 18'] }, 'the model opinion is saved as given, nothing forged or trimmed');
  assert.ok(!M.isInvalid(M.validateResult(readFileSync(join(dir, 'out', 'result.json'), 'utf8'))));
  assert.deepEqual(e.run.opinion, result);
  assert.equal(readFileSync(join(dir, 'out', 'report.md'), 'utf8').replace(/\r\n/g, '\n'), '# Market\n\nPilot first; ROI computed in the sandbox.');
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'out', 'manifest.json'), 'utf8')), { files: ['out/analysis.md'] });
  assert.match(readFileSync(join(dir, 'out', 'analysis.md'), 'utf8').replace(/\r\n/g, '\n'), /^# Analysis\nexit 0$/);
});

await check('real python runner: object/list/null write paths are rejected without crashing the runner; the later final is collected', async () => {
  const opinion = { direction: 'support', confidence: 61, summary: 'Paths were fixed after feedback.', evidence: ['three rejected writes'], assumptions: ['fixture'], nextActions: ['ship'] };
  const BAD = [{ file: 'out/result.json' }, ['out/result.json'], null];
  const w = freshWorld({ model: (req, turn) => turn < BAD.length
    ? JSON.stringify({ action: 'write', path: BAD[turn], content: 'x' })
    : JSON.stringify({ action: 'final', opinion, report: '# Market\n\nFinal after path feedback.' }) });
  const { p, e, dir, procs } = await oneExpert(w);
  assert.equal(p.status, 'completed', JSON.stringify(e.run.activity.map((a) => a.message)));
  assert.deepEqual(procs.map((r) => r.code), [0], procs.map((r) => r.err).join('\n'));
  assert.equal(w.nosana.length, 4, 'one call per turn, no extra retries');
  for (const r of w.nosana.slice(1)) assert.equal(lastUser(r), 'rejected: path must be out/<name>.(md|txt|json|csv) and not reserved');
  const msgs = e.run.activity.map((a) => a.message);
  for (const t of [1, 2, 3]) assert.ok(msgs.includes(`sandbox: turn ${t}: rejected: path must be out/<name>.(md|txt|json|csv) and not reserved`), msgs.join('\n'));
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'out', 'result.json'), 'utf8')), opinion);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'out', 'manifest.json'), 'utf8')), { files: [] });
  assert.ok(!existsSync(join(dir, 'out', 'error.txt')));
  assert.deepEqual(e.run.opinion, opinion);
});

await check('real python runner: the last turn demands only the final; a tool action there is not run and the expert fails', async () => {
  const tool = (turn) => JSON.stringify({ action: 'python', code: `print(${turn})` });
  const finalOnly = (req) => /^This is the last turn\. Reply with only the compact final JSON object now: no python, no write/.test(lastUser(req));
  // a model that keeps using tools but obeys the last-turn instruction completes on turn 6
  const w = freshWorld({ model: (req, turn) => finalOnly(req)
    ? JSON.stringify({ action: 'final', opinion: { direction: 'support', confidence: 55, summary: 'Five checks ran.', evidence: ['five python runs'], assumptions: ['fixture'], nextActions: ['ship'] }, report: '# r' })
    : tool(turn) });
  const ok = await oneExpert(w);
  assert.equal(ok.p.status, 'completed', JSON.stringify(ok.e.run.activity.map((a) => a.message)));
  assert.equal(w.nosana.length, 6);
  assert.deepEqual(w.nosana.map(finalOnly), [false, false, false, false, false, true]);
  assert.deepEqual(readdirSync(join(ok.dir, 'work')).sort(), [1, 2, 3, 4, 5].map((i) => `step_${i}.py`));
  // a model that ignores it: the last-turn python is not executed, no opinion is synthesized
  const w2 = freshWorld({ model: (req, turn) => tool(turn) });
  const bad = await oneExpert(w2);
  assert.equal(bad.p.status, 'failed'); assert.equal(bad.e.run.opinion, undefined);
  assert.equal(w2.nosana.length, 6);
  assert.ok(!existsSync(join(bad.dir, 'work', 'step_6.py')), 'no tool run after the final turn instruction');
  assert.ok(bad.e.run.activity.some((a) => /turn 6: python action not run on the last turn; final was required/.test(a.message)));
  assert.equal(readFileSync(join(bad.dir, 'out', 'error.txt'), 'utf8'), 'no valid final opinion within 6 turns');
  assert.ok(!existsSync(join(bad.dir, 'out', 'result.json')) && !existsSync(join(bad.dir, 'out', 'report.md')));
});

await check('real python runner: invalid replies on every turn fail honestly within six calls, never a partial or synthesized opinion', async () => {
  const w = freshWorld({ model: (req, turn) => (turn % 2 ? '{"action":"final","opinion":{"direction":"support","confidence":70,"summary":"x"' : TRUNCATED) });
  const { p, e, dir } = await oneExpert(w);
  assert.equal(p.status, 'failed'); assert.equal(e.run.status, 'failed'); assert.equal(e.run.opinion, undefined);
  assert.equal(w.nosana.length, 6, 'no extra retries or larger budget');
  assert.ok(w.nosana.every((r) => r.max_tokens === 1200));
  assert.equal(e.run.activity.filter((a) => /reply was not a valid action: JSON object is incomplete/.test(a.message)).length, 6);
  // every retry after an invalid reply carried the compact protocol guidance
  for (const r of w.nosana.slice(1)) assert.match(r.messages.filter((m) => m.role === 'user').find((m) => m.content.startsWith('Invalid reply: ')).content, /about 1200 tokens is the hard limit/);
  assert.equal(readFileSync(join(dir, 'out', 'error.txt'), 'utf8'), 'no valid final opinion within 6 turns');
  for (const f of ['result.json', 'report.md']) assert.ok(!existsSync(join(dir, 'out', f)), 'nothing fabricated: ' + f);
  assert.equal(readFileSync(join(dir, 'out', 'done'), 'utf8'), 'error');
});

server.close();
rmSync(tmp, { recursive: true, force: true });
console.log(`\n${count} cloudbite runtime checks passed`);
