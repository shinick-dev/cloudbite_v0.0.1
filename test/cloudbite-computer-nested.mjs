// Cloudbite nested compute (src/cloudbite-computer-nested.ts): the CbNestedService over yielding memory storage with a
// fake fetch for Daytona and the Nosana client manager, plus the generated Python runner and CLI against a local HTTP
// server. No network leaves this process; no provider is called.
//   node test/cloudbite-computer-nested.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { build } from 'esbuild';

const stubs = { name: 'stubs', setup(b) {
  b.onResolve({ filter: /^cloudflare:workers$/ }, () => ({ path: 'cf', namespace: 'stub' }));
  b.onLoad({ filter: /^cf$/, namespace: 'stub' }, () => ({ contents: 'export class DurableObject { constructor(ctx,env){this.ctx=ctx;this.env=env;} }' }));
} };
const tmp = mkdtempSync(join(tmpdir(), 'cloudbite-nested-'));
const bundle = await build({ entryPoints: ['src/cloudbite-computer-nested.ts'], bundle: true, write: false, format: 'esm', platform: 'node', plugins: [stubs] });
writeFileSync(join(tmp, 'm.mjs'), bundle.outputFiles[0].text);
const M = await import(pathToFileURL(join(tmp, 'm.mjs')));

let count = 0;
const check = async (name, f) => { await f(); count++; console.log('ok', name); };
const DAYTONA_KEY = 'dtn_MASTER_SECRET_daytona_0123456789';
const NOSANA_KEY = 'nos_MASTER_SECRET_nosana_0123456789';
const GATEWAY = 'https://gw.example.test';
const P = M.CBN_GATEWAY_PREFIX;
const uuid = () => crypto.randomUUID();

function memStorage() {
  const m = new Map(); let alarm = null;
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const clone = (v) => (v === undefined ? undefined : structuredClone(v));
  return {
    m, get alarm() { return alarm; },
    async get(k) { await tick(); return clone(m.get(k)); },
    async put(e) { await tick(); for (const [k, v] of Object.entries(e)) m.set(k, clone(v)); },
    async delete(keys) { await tick(); for (const k of keys) m.delete(k); },
    async list({ prefix }) { await tick(); return new Map([...m].filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [k, clone(v)])); },
    async setAlarm(t) { alarm = t; },
  };
}

/** Fake provider network. handlers: [method, regex, (req, body, match) => Response | throw] */
function fakeNet() {
  const calls = []; const handlers = [];
  globalThis.fetch = async (url, init = {}) => {
    const req = new Request(url, init);
    const raw = init.body instanceof FormData ? init.body : init.body ? String(init.body) : null;
    let text = null;
    if (raw instanceof FormData) text = await raw.get('file').text(); else text = raw;
    const call = { method: req.method, url: req.url, auth: req.headers.get('authorization'), body: text };
    calls.push(call);
    for (const [m, re, h] of handlers) { const g = re.exec(req.url); if (m === req.method && g) return h(call, g); }
    throw new Error('unexpected fetch ' + req.method + ' ' + req.url);
  };
  return { calls, on: (m, re, h) => handlers.unshift([m, re, h]), reset: () => { calls.length = 0; } };
}
const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

function setup(opts = {}) {
  const clock = { t: Date.parse('2026-10-19T10:00:00Z') };
  const st = memStorage();
  const deps = {
    now: () => clock.t,
    random: (n) => crypto.getRandomValues(new Uint8Array(n)),
    daytona: () => (opts.noDaytona ? null : { account: 'primary', c: { api: 'https://dt.example.test/api', key: DAYTONA_KEY } }),
    nosanaKey: () => (opts.noNosana ? null : NOSANA_KEY),
    gateway: () => GATEWAY,
  };
  const svc = new M.CbNestedService(st, deps);
  const net = fakeNet();
  return { svc, st, clock, net };
}
async function owner(svc) {
  const r = await svc.configure({ requestId: uuid(), ownerMachineId: 'cbc-owner-machine-1' });
  assert.equal(r.status, 200);
  const cfg = JSON.parse(r.body.install.files.find((f) => f.path === M.CBN_CONFIG_PATH).content);
  return { token: cfg.token, install: r.body.install, cap: r.body.capability };
}
const gw = async (svc, method, sub, token, body, headers = {}) => {
  const r = await svc.fetch(new Request(GATEWAY + P + '/' + sub, {
    method, headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
  return { status: r.status, body: await r.json() };
};
const noSecrets = (v) => {
  const s = JSON.stringify(v);
  for (const k of [DAYTONA_KEY, NOSANA_KEY, 'cbr_', 'cbn_', 'callbackHash', 'idempotencyKey']) assert.ok(!s.includes(k), 'leaked ' + k);
};
const nosanaCreateOk = (net, id = 'dep-1') => net.on('POST', /client-manager\.k8s\.prd\.nosana\.com\/deployments\/create$/, (c) => json({ id, name: JSON.parse(c.body).name, status: 'STARTING' }));

await check('configure mints a hashed 2h capability and a private install payload', async () => {
  const { svc, st } = setup();
  const { token, install, cap } = await owner(svc);
  assert.match(token, /^cbn_[\w-]{43}$/);
  const cfg = install.files.find((f) => f.path === M.CBN_CONFIG_PATH), cli = install.files.find((f) => f.path === M.CBN_CLI_PATH);
  assert.equal(cfg.mode, 0o600); assert.equal(cli.mode, 0o700);
  assert.ok(!cli.content.includes(token) && cli.content.startsWith('#!/usr/bin/env python3'));
  assert.equal(Date.parse(cap.expiresAt) - Date.parse('2026-10-19T10:00:00Z'), 2 * 3600_000);
  const stored = JSON.stringify([...st.m]);
  assert.ok(!stored.includes(token), 'raw capability must not be stored');
  for (const k of [DAYTONA_KEY, NOSANA_KEY]) assert.ok(!JSON.stringify(install).includes(k), 'master key in install payload');
  const keys = [...st.m.keys()].filter((k) => k.startsWith('cap:'));
  assert.equal(keys.length, 1); assert.deepEqual(st.m.get(keys[0]).scopes, ['nested:run', 'nested:jobs', 'nested:stop']);
  assert.equal((await svc.configure({ requestId: uuid(), ownerMachineId: 'bad id with spaces' })).status, 400);
  assert.equal((await svc.configure({ ownerMachineId: 'cbc-owner-machine-1' })).status, 400, 'requestId required');
});

await check('configure retry with the same requestId returns the same install; sealed at rest; ends with the capability', async () => {
  const { svc, st, clock } = setup();
  const rid = uuid();
  const a = await svc.configure({ requestId: rid, ownerMachineId: 'cbc-owner-machine-1' });
  const b = await svc.configure({ requestId: rid, ownerMachineId: 'cbc-owner-machine-1' });
  assert.equal(b.status, 200); assert.equal(b.body.replay, true);
  assert.deepEqual(b.body.install, a.body.install); assert.equal(b.body.capability.id, a.body.capability.id);
  assert.equal([...st.m.keys()].filter((k) => k.startsWith('cap:')).length, 1, 'retry mints nothing new');
  const tok = JSON.parse(a.body.install.files[0].content).token;
  const stored = JSON.stringify([...st.m]);
  assert.ok(!stored.includes(tok) && !stored.includes(rid), 'token and requestId not stored in clear');
  assert.equal((await svc.configure({ requestId: rid, ownerMachineId: 'other-machine' })).status, 409);
  clock.t += 2 * 3600_000;
  assert.equal((await svc.configure({ requestId: rid, ownerMachineId: 'cbc-owner-machine-1' })).status, 409, 'no replay after expiry');
  const rid2 = uuid();
  await svc.configure({ requestId: rid2, ownerMachineId: 'cbc-owner-machine-1' });
  await svc.revokeAll();
  assert.ok(![...st.m.keys()].some((k) => k.startsWith('cfg:') || k.startsWith('cap:')), 'revokeAll drops sealed installs');
  assert.equal((await svc.configure({ requestId: rid2, ownerMachineId: 'cbc-owner-machine-1' })).status, 200, 'a revoked request may mint again');
});

await check('capability auth: missing, browser Origin, expired, revoked, older caps revoked beyond the bound', async () => {
  const { svc, clock } = setup();
  const { token } = await owner(svc);
  assert.equal((await gw(svc, 'GET', 'jobs', null)).status, 401);
  assert.equal((await gw(svc, 'GET', 'jobs', token, undefined, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await gw(svc, 'GET', 'jobs', token)).status, 200);
  assert.equal((await gw(svc, 'GET', 'jobs', token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A'))).status, 401);
  assert.equal((await gw(svc, 'GET', 'owner', token)).status, 404, 'no route beyond run/jobs/stop/result');
  assert.equal((await gw(svc, 'GET', 'vault', token)).status, 404);
  clock.t += 2 * 3600_000;
  assert.equal((await gw(svc, 'GET', 'jobs', token)).status, 401, 'expired at 2h');
  const mint = async () => { clock.t += 1000; return (await owner(svc)).token; };
  const t2 = await mint(), t3 = await mint(), t4 = await mint();
  assert.equal((await gw(svc, 'GET', 'jobs', t2)).status, 200, 'up to CBN_MAX_CAPS live capabilities overlap');
  await mint();
  assert.equal((await gw(svc, 'GET', 'jobs', t2)).status, 401, 'oldest live capability revoked past CBN_MAX_CAPS');
  assert.equal((await gw(svc, 'GET', 'jobs', t3)).status, 200);
  assert.equal((await svc.revokeAll()).status, 200);
  assert.equal((await gw(svc, 'GET', 'jobs', t4)).status, 401, 'revoked');
});

await check('run validation rejects control metadata, bad requestId, overlength and unknown fields', async () => {
  const { svc, net } = setup();
  const { token } = await owner(svc);
  const base = { requestId: uuid(), provider: 'nosana', command: ['python3', '-c', 'print(1)'] };
  for (const bad of [
    { ...base, requestId: 'not-a-uuid' }, { ...base, provider: 'aws' }, { ...base, image: 'python:3.12\n' }, { ...base, image: 'https://x/y' },
    { ...base, timeout: 601 }, { ...base, timeout: 5 }, { ...base, command: [] }, { ...base, command: ['a\u0001b'] },
    { ...base, command: Array(65).fill('x') }, { ...base, command: ['x'.repeat(4097)] }, { ...base, extra: 1 },
  ]) assert.equal((await gw(svc, 'POST', 'run', token, bad)).status, 400, JSON.stringify(bad).slice(0, 80));
  assert.equal(net.calls.length, 0, 'no provider call for invalid input');
  assert.equal(typeof M.cbNestedParseRun({ ...base, command: ['bash', '-c', 'echo a\nb\techo'] }), 'object', 'newline/tab allowed in owner command args');
});

await check('nosana run: exact client-manager create body, master key only in the Authorization header, public definition carries no secret', async () => {
  const { svc, net, st } = setup();
  const { token } = await owner(svc);
  nosanaCreateOk(net);
  const r = await gw(svc, 'POST', 'run', token, { requestId: uuid(), provider: 'nosana', timeout: 300, command: ['nvidia-smi'] });
  assert.equal(r.status, 202); assert.equal(r.body.job.status, 'running');
  noSecrets(r.body);
  assert.equal(net.calls.length, 1);
  const c = net.calls[0];
  assert.equal(c.url, 'https://client-manager.k8s.prd.nosana.com/deployments/create');
  assert.equal(c.auth, 'Bearer ' + NOSANA_KEY);
  const b = JSON.parse(c.body);
  assert.match(b.idempotency_key, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(b.market, '97G9NnvBDQ2WpKu6fasoMsAKmfj63C9rhysJnkeWodAf');
  assert.deepEqual([b.replicas, b.strategy, b.autostart, b.timeout], [1, 'SIMPLE', true, 7]);
  assert.equal(b.name, 'cbn-' + r.body.job.id);
  assert.deepEqual(Object.keys(b.job_definition), ['version', 'type', 'ops']);
  const op = b.job_definition.ops[0];
  assert.deepEqual([op.id, op.type, op.args.image, op.args.gpu], ['work', 'container/run', 'python:3.12-slim', true]);
  assert.equal(op.args.env, undefined, 'no env in the public job definition');
  assert.deepEqual(op.args.cmd.slice(0, 3), ['python3', '-I', '-c']);
  const job = JSON.parse(Buffer.from(op.args.cmd[5], 'base64url'));
  assert.deepEqual(job.command, ['nvidia-smi']);
  assert.deepEqual(Object.keys(job).sort(), ['command', 'jobId', 'timeout'], 'no callback in the public job definition');
  for (const k of [NOSANA_KEY, DAYTONA_KEY, token, 'cbr_', '/result/', GATEWAY]) assert.ok(!c.body.includes(k), 'public deployment leaks ' + k);
  assert.ok(!('callbackHash' in st.m.get('job:' + r.body.job.id)), 'a Nosana job has no callback secret');
  assert.equal(r.body.job.public, true); assert.match(r.body.job.note, /public/);
  const timed = await gw(svc, 'POST', 'run', token, { requestId: uuid(), provider: 'nosana', timeout: 600, command: ['x'] });
  assert.equal(JSON.parse(net.calls[1].body).timeout, 10, 'Nosana timeout capped at 10 minutes');
  assert.equal(timed.status, 202);
});

await check('duplicate requestId replays without a second paid create; a different payload conflicts', async () => {
  const { svc, net } = setup();
  const { token } = await owner(svc);
  nosanaCreateOk(net);
  const body = { requestId: uuid(), provider: 'nosana', command: ['echo', 'hi'] };
  const [a, b] = await Promise.all([gw(svc, 'POST', 'run', token, body), gw(svc, 'POST', 'run', token, body)]);
  assert.equal(net.calls.filter((c) => c.method === 'POST').length, 1, 'concurrent duplicates create once');
  assert.equal(a.body.job.id, b.body.job.id);
  assert.equal((await gw(svc, 'POST', 'run', token, { ...body, command: ['echo', 'other'] })).status, 409);
});

await check('max two active nested jobs; the third is refused before any provider call', async () => {
  const { svc, net } = setup();
  const { token } = await owner(svc);
  nosanaCreateOk(net);
  for (let i = 0; i < 2; i++) assert.equal((await gw(svc, 'POST', 'run', token, { requestId: uuid(), provider: 'nosana', command: ['x'] })).status, 202);
  net.reset();
  const third = await gw(svc, 'POST', 'run', token, { requestId: uuid(), provider: 'nosana', command: ['x'] });
  assert.equal(third.status, 429); assert.equal(third.body.error.code, 'busy');
  assert.equal(net.calls.length, 0);
});

await check('uncertain Nosana create is never retried; alarm reconciles read-only by idempotency_key and cleans up', async () => {
  const { svc, net, clock } = setup();
  const { token } = await owner(svc);
  net.on('POST', /deployments\/create$/, () => { throw new TypeError('network'); });
  const r = await gw(svc, 'POST', 'run', token, { requestId: uuid(), provider: 'nosana', command: ['x'] });
  assert.equal(r.body.job.status, 'uncertain');
  const id = r.body.job.id, key = JSON.parse(net.calls[0].body).idempotency_key;
  // Still counts as active: a possibly-created paid deployment.
  const listed = (await svc.ownerJobs()).body.jobs[0];
  assert.equal(listed.cleanup, 'unknown'); assert.equal(listed.error, 'create_uncertain');
  net.reset();
  // No limit param (live list rejected limit with 400); bounded cursor pagination; exact name match client side.
  net.on('GET', /\/deployments\?idempotency_key=/, (c) => {
    assert.ok(c.url.includes(encodeURIComponent(key))); assert.ok(!c.url.includes('limit='), 'no limit parameter');
    return c.url.includes('cursor=p2')
      ? json({ deployments: [{ id: 'dep-X', name: 'cbn-' + id, status: 'RUNNING' }], pagination: { cursor_next: null } })
      : json({ deployments: [{ id: 'dep-other', name: 'cbn-njsomeoneelse', status: 'RUNNING' }], pagination: { cursor_next: 'p2' } });
  });
  await svc.alarm();
  assert.equal(net.calls.filter((c) => c.method === 'POST').length, 0, 'no automatic paid retry');
  let j = (await svc.ownerJobs()).body.jobs[0];
  assert.equal(j.status, 'running'); assert.equal(j.cleanup, 'none');
  // Past the deadline: stop, then delete once STOPPED, each only after the name ownership check.
  clock.t += 20 * 60_000;
  let status = 'RUNNING';
  net.on('GET', /\/deployments\/dep-X$/, () => json({ id: 'dep-X', name: 'cbn-' + id, status }));
  net.on('POST', /\/deployments\/dep-X\/stop$/, () => { status = 'STOPPED'; return json({}); });
  net.on('DELETE', /\/deployments\/dep-X$/, () => json({}));
  await svc.alarm();
  j = (await svc.ownerJobs()).body.jobs[0];
  assert.equal(j.status, 'timed_out'); assert.equal(j.cleanup, 'pending');
  await svc.alarm();
  assert.equal((await svc.ownerJobs()).body.jobs[0].cleanup, 'done');
  assert.deepEqual(net.calls.filter((c) => c.method !== 'GET').map((c) => c.method + ' ' + new URL(c.url).pathname), ['POST /deployments/dep-X/stop', 'DELETE /deployments/dep-X']);
});

await check('409 on create reconciles the existing deployment instead of creating again', async () => {
  const { svc, net } = setup();
  const { token } = await owner(svc);
  net.on('POST', /deployments\/create$/, () => json({ error: 'exists' }, 409));
  net.on('GET', /\/deployments\?idempotency_key=/, (c) => json({ deployments: [{ id: 'dep-9', name: 'cbn-' + /cbn-(nj\w+)/.exec(net.calls[0].body)[1], status: 'STARTING' }] }));
  const r = await gw(svc, 'POST', 'run', token, { requestId: uuid(), provider: 'nosana', command: ['x'] });
  assert.equal(r.body.job.status, 'running');
  assert.equal(net.calls.filter((c) => c.method === 'POST').length, 1);
});

const daytonaOk = (net, id = 'sb-N') => {
  let labels;
  net.on('POST', /dt\.example\.test\/api\/sandbox$/, (c) => { labels = JSON.parse(c.body).labels; return json({ id, state: 'started', toolboxProxyUrl: 'https://tb.example.test/toolbox', labels }); });
  net.on('POST', /tb\.example\.test\/toolbox\/.+\/files\/upload/, () => new Response('', { status: 200 }));
  net.on('POST', /tb\.example\.test\/toolbox\/.+\/process\/session$/, () => json({}));
  net.on('POST', /tb\.example\.test\/toolbox\/.+\/process\/session\/[\w-]+\/exec$/, () => json({ cmdId: 'c1' }));
  return () => labels;
};

await check('callback auth (Daytona): per-job token only, single use, bounded output, then owned cleanup', async () => {
  const { svc, net } = setup();
  const { token } = await owner(svc);
  const labels = daytonaOk(net, 'sb-C');
  const r = await gw(svc, 'POST', 'run', token, { requestId: uuid(), provider: 'daytona', command: ['x'] });
  const id = r.body.job.id;
  const cb = JSON.parse(net.calls.filter((c) => c.url.includes('/files/upload'))[1].body).token;
  const result = { exitCode: 0, timedOut: false, output: 'é'.repeat(40_000) + 'END', truncated: false };
  assert.equal((await gw(svc, 'POST', `result/${id}`, token, result)).status, 401, 'capability is not a callback token');
  assert.equal((await gw(svc, 'POST', `result/${id}`, 'cbr_' + 'A'.repeat(43), result)).status, 401);
  const other = await gw(svc, 'POST', 'run', token, { requestId: uuid(), provider: 'daytona', command: ['y'] });
  assert.equal((await gw(svc, 'POST', `result/${other.body.job.id}`, cb, result)).status, 401, 'token bound to its own job');
  assert.equal((await gw(svc, 'POST', 'jobs', cb)).status, 404);
  assert.equal((await gw(svc, 'GET', 'jobs', cb)).status, 401, 'callback token cannot list jobs');
  const res = await svc.fetch(new Request(`${GATEWAY}${P}/result/${id}?token=${cb}`, { method: 'POST', body: JSON.stringify(result) }));
  assert.equal(res.status, 401, 'token in URL is not accepted');
  assert.equal((await gw(svc, 'POST', `result/${id}`, cb, result)).status, 200);
  assert.equal((await gw(svc, 'POST', `result/${id}`, cb, result)).status, 409, 'single use');
  const j = (await gw(svc, 'GET', 'jobs', token)).body.jobs.find((x) => x.id === id);
  assert.equal(j.status, 'succeeded'); assert.equal(j.cleanup, 'pending'); assert.equal(j.public, false);
  assert.ok(new TextEncoder().encode(j.result.output).byteLength <= M.CBN_OUTPUT_MAX); assert.ok(j.result.truncated && j.result.output.endsWith('END'));
  noSecrets((await gw(svc, 'GET', 'jobs', token)).body);
  net.reset();
  net.on('GET', /\/api\/sandbox\/sb-C$/, () => json({ id: 'sb-C', state: 'started', labels: { 'cloudbite-nested': id } }));
  net.on('DELETE', /\/api\/sandbox\/sb-C$/, () => json({}));
  await svc.alarm();
  assert.equal((await svc.ownerJobs()).body.jobs.find((x) => x.id === id).cleanup, 'done');
  assert.ok(!net.calls.some((c) => c.method === 'DELETE' && !c.url.endsWith('/sb-C')));
  void labels;
});

await check('nosana: no callback is ever accepted; status only from the owner deployment job list; output honestly unavailable', async () => {
  const { svc, net, st } = setup();
  const { token } = await owner(svc);
  nosanaCreateOk(net, 'dep-G');
  const r = await gw(svc, 'POST', 'run', token, { requestId: uuid(), provider: 'nosana', command: ['nvidia-smi'] });
  const id = r.body.job.id;
  const forged = { exitCode: 0, timedOut: false, output: 'forged', truncated: false };
  for (const t of ['cbr_' + 'A'.repeat(43), token]) assert.equal((await gw(svc, 'POST', `result/${id}`, t, forged)).status, 401, 'Nosana result callback refused');
  assert.equal(st.m.get('job:' + id).result, undefined);
  assert.equal(st.m.get('job:' + id).cleanup, 'none', 'a forged callback cannot trigger cleanup');
  net.reset();
  let state = 'RUNNING';
  net.on('GET', /\/deployments\/dep-G\/jobs/, (c) => {
    assert.ok(!c.url.includes('limit='));
    return json({ jobs: [
      { job: 'JobOtherMarket', deployment: 'dep-G', market: 'SomeOtherMarket', state: 'COMPLETED' },
      { job: 'JobWrongDep', deployment: 'dep-Z', market: M.CBN_NOSANA_MARKET, state: 'COMPLETED' },
      { job: 'JobAddr1', deployment: 'dep-G', market: M.CBN_NOSANA_MARKET, state },
    ], pagination: { cursor_next: null } });
  });
  await svc.alarm();
  let j = (await svc.ownerJobs()).body.jobs[0];
  assert.deepEqual([j.status, j.providerState, j.cleanup], ['running', 'RUNNING', 'none'], 'non-matching jobs ignored');
  state = 'COMPLETED';
  net.on('GET', /\/deployments\/dep-G$/, () => json({ id: 'dep-G', name: 'cbn-' + id, status: 'STOPPED' }));
  net.on('DELETE', /\/deployments\/dep-G$/, () => json({}));
  await svc.alarm();
  j = (await svc.ownerJobs()).body.jobs[0];
  assert.deepEqual([j.status, j.providerState, j.result, j.error], ['completed', 'COMPLETED', null, 'nosana_output_unavailable']);
  assert.equal(j.cleanup, 'done');
  assert.deepEqual(net.calls.filter((c) => c.method !== 'GET').map((c) => c.method + ' ' + new URL(c.url).pathname), ['DELETE /deployments/dep-G']);
});

await check('cleanup ownership: a resource whose name/labels do not match is never stopped or deleted', async () => {
  const { svc, net } = setup();
  const { token } = await owner(svc);
  nosanaCreateOk(net, 'dep-P');
  const r = await gw(svc, 'POST', 'run', token, { requestId: uuid(), provider: 'nosana', command: ['x'] });
  await gw(svc, 'POST', 'stop', token, { requestId: uuid(), jobId: r.body.job.id });
  net.reset();
  net.on('GET', /\/deployments\/dep-P$/, () => json({ id: 'dep-P', name: 'someone-elses-deployment', status: 'RUNNING' }));
  await svc.alarm();
  assert.deepEqual(net.calls.map((c) => c.method), ['GET']);
  const j = (await svc.ownerJobs()).body.jobs[0];
  assert.equal(j.cleanup, 'failed'); assert.equal(j.error, 'ownership_mismatch'); assert.equal(j.status, 'stopped');
  assert.equal((await gw(svc, 'POST', 'stop', token, { jobId: r.body.job.id })).status, 400, 'stop requires a requestId UUID');
});

await check('daytona run: 2cpu/4GiB/8GiB labelled sandbox, runner gets only the job token, cleanup checks labels', async () => {
  const { svc, net, clock } = setup();
  const { token } = await owner(svc);
  let sbLabels;
  net.on('POST', /dt\.example\.test\/api\/sandbox$/, (c) => { sbLabels = JSON.parse(c.body).labels; return json({ id: 'sb-N', state: 'started', toolboxProxyUrl: 'https://tb.example.test/toolbox', labels: sbLabels }); });
  net.on('POST', /tb\.example\.test\/toolbox\/sb-N\/files\/upload/, () => new Response('', { status: 200 }));
  net.on('POST', /tb\.example\.test\/toolbox\/sb-N\/process\/session$/, () => json({}));
  net.on('POST', /tb\.example\.test\/toolbox\/sb-N\/process\/session\/[\w-]+\/exec$/, () => json({ cmdId: 'c1' }));
  const r = await gw(svc, 'POST', 'run', token, { requestId: uuid(), provider: 'daytona', timeout: 120, command: ['python3', '-c', 'print(2)'] });
  assert.equal(r.status, 202); assert.equal(r.body.job.status, 'running');
  const create = JSON.parse(net.calls[0].body);
  assert.equal(net.calls[0].auth, 'Bearer ' + DAYTONA_KEY);
  assert.deepEqual([create.cpu, create.memory, create.disk, create.public], [2, 4, 8, false]);
  assert.deepEqual(create.labels, { 'cloudbite-nested': r.body.job.id, 'cloudbite-nested-owner': 'cbc-owner-machine-1' });
  assert.equal(create.buildInfo.dockerfileContent, 'FROM python:3.12-slim\n');
  const uploads = net.calls.filter((c) => c.url.includes('/files/upload'));
  assert.equal(uploads.length, 2);
  const jobFile = JSON.parse(uploads[1].body);
  assert.match(jobFile.token, /^cbr_/);
  for (const c of net.calls.slice(1)) assert.ok(!(c.body ?? '').includes(DAYTONA_KEY) && !(c.body ?? '').includes(NOSANA_KEY), 'no master key inside the sandbox');
  assert.match(net.calls.at(-1).body, /timeout -k 5 180 python3 -I runner\.py job\.json/);
  // Expiry: cleanup GETs the exact id, verifies the job label, deletes it; never the owner's personal machine.
  clock.t += 11 * 60_000;
  net.reset();
  net.on('GET', /\/sandbox\/sb-N$/, () => json({ id: 'sb-N', state: 'started', labels: sbLabels }));
  net.on('DELETE', /\/sandbox\/sb-N$/, () => json({}));
  await svc.alarm();
  assert.deepEqual(net.calls.map((c) => c.method + ' ' + new URL(c.url).pathname), ['GET /api/sandbox/sb-N', 'DELETE /api/sandbox/sb-N']);
  const j = (await svc.ownerJobs()).body.jobs[0];
  assert.deepEqual([j.status, j.cleanup], ['timed_out', 'done']);
});

await check('daytona uncertain create: label lookup only, never a second create; a sandbox without the job label is untouched', async () => {
  const { svc, net, clock } = setup();
  const { token } = await owner(svc);
  net.on('POST', /\/api\/sandbox$/, () => new Response('upstream', { status: 502 }));
  const r = await gw(svc, 'POST', 'run', token, { requestId: uuid(), provider: 'daytona', command: ['x'] });
  assert.equal(r.body.job.status, 'uncertain');
  net.reset();
  // The personal computer shows up in a loose listing but lacks the job label: it must not be adopted.
  net.on('GET', /\/api\/sandbox\?labels=/, () => json([{ id: 'personal-pc', state: 'started', labels: { 'cloudbite-computer': 'owner' } }]));
  await svc.alarm();
  assert.deepEqual(net.calls.map((c) => c.method), ['GET']);
  assert.equal((await svc.ownerJobs()).body.jobs[0].cleanup, 'unknown');
  net.reset();
  net.on('GET', /\/api\/sandbox\?labels=/, () => json([{ id: 'sb-late', state: 'started', labels: { 'cloudbite-nested': r.body.job.id, 'cloudbite-nested-owner': 'cbc-owner-machine-1' } }]));
  net.on('GET', /\/api\/sandbox\/sb-late$/, () => json({ id: 'sb-late', state: 'started', labels: { 'cloudbite-nested': r.body.job.id } }));
  net.on('DELETE', /\/api\/sandbox\/sb-late$/, () => json({}));
  clock.t += 30_000;
  await svc.alarm();
  assert.ok(!net.calls.some((c) => c.method === 'POST'), 'no create retry');
  assert.ok(!net.calls.some((c) => c.url.includes('personal-pc')));
  assert.deepEqual(net.calls.filter((c) => c.method === 'DELETE').map((c) => new URL(c.url).pathname), ['/api/sandbox/sb-late']);
  assert.equal((await svc.ownerJobs()).body.jobs[0].cleanup, 'done');
});

await check('provider not configured: refused without storing a job or calling out', async () => {
  const { svc, net, st } = setup({ noNosana: true });
  const { token } = await owner(svc);
  const r = await gw(svc, 'POST', 'run', token, { requestId: uuid(), provider: 'nosana', command: ['x'] });
  assert.equal(r.status, 503); assert.equal(r.body.error.code, 'not_configured');
  assert.equal(net.calls.length, 0); assert.ok(![...st.m.keys()].some((k) => k.startsWith('job:')));
});

// ---- generated Python: runner and CLI against a local HTTP server ----
const py = spawnSync('python3', ['--version']).status === 0 ? 'python3' : 'python';
const seen = [];
let reply = (req, body) => ({ status: 200, json: { ok: true } });
const server = createServer((req, res) => {
  let data = ''; req.on('data', (d) => { data += d; }); req.on('end', () => {
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, origin: req.headers.origin, body: data });
    const r = reply(req, data); res.writeHead(r.status, { 'content-type': 'application/json' }); res.end(JSON.stringify(r.json));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const runPy = (args, env = {}) => new Promise((resolve) => {
  const p = spawn(py, args, { env: { ...process.env, ...env } });
  let out = '', errOut = ''; p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { errOut += d; });
  p.on('close', (code) => resolve({ code, out, err: errOut }));
});

await check('python runner: runs the command, bounds output to 64 KiB, posts once with the job token, keeps no token on disk', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cbn-runner-'));
  writeFileSync(join(dir, 'runner.py'), M.CBN_RUNNER_PY);
  const job = { jobId: 'nj' + '0'.repeat(24), command: [py, '-c', 'import sys; sys.stdout.write("x"*70000 + "TAIL"); sys.exit(3)'], timeout: 30, callback: base + '/cb', token: 'cbr_' + 'T'.repeat(43) };
  writeFileSync(join(dir, 'job.json'), JSON.stringify(job));
  seen.length = 0;
  const r = await runPy(['-I', join(dir, 'runner.py'), join(dir, 'job.json')]);
  assert.equal(r.code, 0, r.err);
  assert.equal(seen.length, 1); assert.equal(seen[0].auth, 'Bearer ' + job.token);
  const b = JSON.parse(seen[0].body);
  assert.equal(b.exitCode, 3); assert.equal(b.timedOut, false); assert.equal(b.truncated, true);
  assert.ok(b.output.length <= 65536 && b.output.endsWith('TAIL'));
  assert.ok(!existsSync(join(dir, 'job.json')), 'job file (with token) removed after reading');
  seen.length = 0;
  writeFileSync(join(dir, 'job.json'), JSON.stringify(job));
  assert.equal((await runPy(['-I', join(dir, 'runner.py'), join(dir, 'job.json')])).code, 0);
  assert.equal(seen.length, 0, 'second start is a no-op (start marker)');
  // Nosana form: job via base64 argv, no callback and no token; bounded JSON result printed to stdout only.
  seen.length = 0;
  const b64 = Buffer.from(JSON.stringify({ jobId: job.jobId, timeout: 2, command: [py, '-c', 'import time; print("hello"); time.sleep(10)'] })).toString('base64url');
  const n = await runPy(['-I', '-c', M.CBN_RUNNER_PY, '--b64', b64]);
  assert.equal(n.code, 0, n.err);
  assert.equal(seen.length, 0, 'Nosana runner never calls back');
  const line = n.out.split('\n').find((l) => l.startsWith('CLOUDBITE_RESULT '));
  const nb = JSON.parse(line.slice('CLOUDBITE_RESULT '.length));
  assert.equal(nb.timedOut, true); assert.ok(nb.output.includes('hello'));
});

await check('python CLI: parsing, Bearer only, UUID requestId, token never printed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cbn-cli-'));
  const cli = join(dir, 'cloudbite-compute'); writeFileSync(cli, M.CBN_CLI_PY);
  const tok = 'cbn_' + 'S'.repeat(43);
  const cfgPath = join(dir, 'compute.json');
  writeFileSync(cfgPath, JSON.stringify({ version: 1, gateway: base, prefix: P, token: tok, expiresAt: '2026-10-19T12:00:00.000Z' }), { mode: 0o600 });
  const env = { CLOUDBITE_COMPUTE_CONFIG: cfgPath };
  const jobView = { id: 'nj' + 'a'.repeat(24), provider: 'nosana', status: 'running', cleanup: 'none', command: ['nvidia-smi'] };
  for (const [args, msg] of [[[], 'usage'], [['run', '--provider', 'nosana'], 'needs --'], [['run', '--', 'x'], '--provider is required'],
    [['run', '--provider', 'gcp', '--', 'x'], 'daytona or nosana'], [['run', '--provider', 'nosana', '--timeout', '9000', '--', 'x'], '10..600'],
    [['stop'], 'exactly one'], [['jobs', 'x'], 'no arguments'], [['frobnicate'], 'unknown command']]) {
    const r = await runPy(['-I', cli, ...args], env);
    assert.equal(r.code, 2, args.join(' ')); assert.ok(r.err.includes(msg), r.err);
  }
  seen.length = 0;
  reply = (req) => req.url.endsWith('/run') ? { status: 202, json: { ok: true, job: jobView } } : { status: 200, json: { ok: true, jobs: [jobView] } };
  const run = await runPy(['-I', cli, 'run', '--provider', 'nosana', '--image', 'pytorch/pytorch:2.4.0-cuda12.1-cudnn9-runtime', '--timeout', '120', '--no-wait', '--', 'python', '-c', 'print(1)'], env);
  assert.equal(run.code, 0, run.err);
  assert.ok(run.err.includes('public'), 'Nosana run tells the user its definition is public');
  const sent = JSON.parse(seen[0].body);
  assert.equal(seen[0].url, P + '/run'); assert.equal(seen[0].auth, 'Bearer ' + tok); assert.equal(seen[0].origin, undefined);
  assert.match(sent.requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.deepEqual([sent.provider, sent.timeout, sent.image, sent.command], ['nosana', 120, 'pytorch/pytorch:2.4.0-cuda12.1-cudnn9-runtime', ['python', '-c', 'print(1)']]);
  const doc = await runPy(['-I', cli, 'doctor'], env);
  assert.equal(doc.code, 0, doc.err); assert.ok(doc.out.includes('gateway: ok (1 jobs)'));
  for (const o of [run, doc]) assert.ok(!(o.out + o.err).includes(tok), 'token never printed');
  reply = () => ({ status: 429, json: { error: { code: 'busy', message: 'at most 2 nested jobs may be active' } } });
  const busy = await runPy(['-I', cli, 'run', '--provider', 'daytona', '--', 'true'], env);
  assert.notEqual(busy.code, 0); assert.ok(busy.err.includes('error busy'));
});

server.close();
console.log(`cloudbite-computer-nested: ${count} checks passed`);
