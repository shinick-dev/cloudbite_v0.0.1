// Cloud Files VM bridge tests. Every provider call is a recorded mock (no Daytona, no VM, no network); the
// capability and manifest the bridge would upload are checked against the real Python agent in a temp dir.
// Nothing here is live install, persistence or latency evidence.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const tmp = mkdtempSync(join(tmpdir(), 'cloudbite-files-bridge-'));
const built = await build({ entryPoints: ['src/cloudbite-computer-files-bridge.ts'], bundle: true, write: false, platform: 'node', format: 'esm' });
writeFileSync(join(tmp, 'm.mjs'), built.outputFiles[0].text);
const B = await import(pathToFileURL(join(tmp, 'm.mjs')));
globalThis.fetch = async (u) => { throw new Error('network forbidden in this test: ' + u); };

const AGENT = readFileSync('images/cloudbite-computer/files-agent.py', 'utf8');
const TOKEN = 'tok_' + 'Zq9'.repeat(14);
const REQ = '0f8fad5b-d9cb-469f-a165-70867728950e';
const MACHINE = { id: 'sb-1111', name: 'cloudbite-computer-abc', account: 'primary' };
const LABELS = { 'cloudbite-computer': 'owner123', 'cloudbite-account': 'primary' };
const NOW = 1_800_000_000_000;
const GATEWAY = 'https://gw.cloudbite.example';
const ENDPOINT = GATEWAY + '/p/_cloudbite/computer/files/agent/v1';
const GRANT = { token: TOKEN, machineId: MACHINE.id, writerEpoch: 3, workspaceId: 'w_owner', expiresAt: NOW + 3600_000, endpoint: ENDPOINT };
const PY = process.platform === 'win32' ? 'python' : 'python3';
const skips = [];

function harness(over = {}) {
  const calls = [];
  const logs = [];
  const sandbox = { id: MACHINE.id, name: MACHINE.name, state: 'started', labels: { ...LABELS }, ...over.sandbox };
  const execResults = [...(over.exec ?? [])];
  const deps = {
    gateway: GATEWAY,
    now: () => NOW,
    agentSource: AGENT,
    machine: async () => { calls.push(['machine']); return 'machine' in over ? over.machine : MACHINE; },
    account: (id) => { calls.push(['account', id]); return over.noAccount ? null : { api: 'https://api.invalid', key: 'PROVIDER-KEY-x' }; },
    labels: () => ({ ...LABELS }),
    getSandbox: async (_c, id) => { calls.push(['getSandbox', id]); return sandbox; },
    exec: async (_c, _sb, command, timeout) => {
      calls.push(['exec', command, timeout]);
      const next = execResults.shift();
      if (next instanceof Error) throw next;
      return next ?? { exitCode: 0, result: '{"ok": true, "configured": true, "transportConfigured": true}' };
    },
    upload: async (_c, _sb, path, content) => {
      calls.push(['upload', path, content]);
      if (over.uploadThrows) throw new Error('upload lost');
    },
    grant: async (req) => {
      calls.push(['grant', req]);
      return 'grant' in over ? over.grant : { ok: true, body: { ...GRANT } };
    },
    ...over.deps,
  };
  const origLog = console.log, origErr = console.error;
  return { deps, calls, logs, sandbox,
    kinds: () => calls.map(c => c[0]),
    async run(fn) {
      console.log = (...a) => logs.push(a.join(' ')); console.error = console.log;
      try { return await fn(); } finally { console.log = origLog; console.error = origErr; }
    } };
}

const providerWrites = (h) => h.calls.filter(c => c[0] === 'exec' || c[0] === 'upload' || c[0] === 'grant');
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('fails closed before any provider call when not configured or not running', async () => {
  for (const [over, code] of [
    [{ deps: { gateway: 'http://gw.cloudbite.example' } }, 'not_configured'],
    [{ deps: { gateway: 'https://gw.cloudbite.example/app' } }, 'not_configured'],
    [{ deps: { gateway: '' } }, 'not_configured'],
    [{ deps: { gateway: undefined } }, 'not_configured'],
    [{ machine: null }, 'not_running'],
    [{ noAccount: true }, 'not_configured'],
    [{ sandbox: { state: 'stopped' } }, 'not_running'],
  ]) {
    const h = harness(over);
    const r = await h.run(() => B.filesBridgeInstall(h.deps, { requestId: REQ }));
    assert.equal(r.body.error.code, code, JSON.stringify(over));
    assert.deepEqual(providerWrites(h), [], 'no capability mint, exec or upload');
  }
  const h = harness();
  assert.equal((await B.filesBridgeInstall(h.deps, { requestId: 'not-a-uuid' })).body.error.code, 'bad_request');
  assert.equal((await B.filesBridgeInstall({ ...h.deps, agentSource: 'print(1)' }, { requestId: REQ })).body.error.code, 'not_configured');
  assert.deepEqual(h.calls, []);
});

test('ownership is exact name + id + every label', async () => {
  for (const sandbox of [{ name: 'someone-else' }, { id: 'sb-2222' }, { labels: { 'cloudbite-computer': 'owner123' } },
    { labels: { ...LABELS, 'cloudbite-computer': 'other' } }]) {
    const h = harness({ sandbox });
    const r = await h.run(() => B.filesBridgeInstall(h.deps, { requestId: REQ }));
    assert.equal(r.body.error.code, 'ownership_mismatch', JSON.stringify(sandbox));
    assert.deepEqual(providerWrites(h), []);
  }
  const h = harness({ deps: { labels: () => ({}) } });
  assert.equal((await B.filesBridgeInstall(h.deps, { requestId: REQ })).body.error.code, 'ownership_mismatch', 'empty label set never proves ownership');
});

test('install: private placeholders, secret only in upload body, atomic activate, init + scope check', async () => {
  const h = harness();
  const r = await h.run(() => B.filesBridgeInstall(h.deps, { requestId: REQ }));
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.deepEqual(r.body, { ok: true, installed: true, machineId: MACHINE.id, writerEpoch: 3, expiresAt: NOW + 3600_000 });
  assert.deepEqual(h.kinds(), ['machine', 'account', 'getSandbox', 'grant', 'exec', 'upload', 'upload', 'exec', 'exec', 'exec']);
  const [prep, activate, init, status] = h.calls.filter(c => c[0] === 'exec').map(c => c[1]);
  assert.match(prep, /umask 077/);
  assert.match(prep, /install -m 600 \/dev\/null "\$B\/capability\.json\.next"/);
  assert.match(prep, /if \[ -L "\$p" \]; then exit 41/);
  assert.match(prep, /M="cloudbite-files-bridge v1 machine=sb-1111 workspace=w_owner"/);
  assert.match(prep, /then exit 44/);
  assert.match(prep, /\[ ! -f "\$B\/root-owned" \]; \}; then exit 42/);
  assert.ok(prep.indexOf("exit 42") < prep.indexOf("mkdir"), "every refusal precedes the first write");
  assert.match(activate, /if \[ -L "\$f" \] \|\| \[ ! -f "\$f" \]; then exit 45/);
  assert.match(activate, /chmod 600 .*mv -f "\$B\/capability\.json\.next" "\$B\/capability\.json"/);
  assert.match(init, /init --root \/home\/daytona\/CloudFiles --workspace-id=w_owner --machine-id=sb-1111 --writer-epoch=3$/);
  assert.match(status, /--capability \/home\/daytona\/\.local\/share\/cloudbite-files\/capability\.json status$/);
  const uploads = h.calls.filter(c => c[0] === 'upload');
  assert.deepEqual(uploads.map(u => u[1]), [B.FILES_BRIDGE_PATHS.agent + '.next', B.FILES_BRIDGE_PATHS.capability + '.next']);
  assert.equal(uploads[0][2], AGENT);
  const cap = JSON.parse(uploads[1][2]);
  assert.deepEqual(Object.keys(cap).sort(), ['endpoint', 'expiresAt', 'machineId', 'schema', 'token', 'workspaceId', 'writerEpoch']);
  assert.equal(cap.endpoint, ENDPOINT);
  assert.deepEqual(h.calls.find(c => c[0] === 'grant')[1], { machine: MACHINE, requestId: REQ });
  // secret placement: only the capability upload body carries the token; never argv, results or logs
  for (const c of h.calls) if (!(c[0] === 'upload' && c[1].endsWith('capability.json.next'))) assert.ok(!JSON.stringify(c).includes(TOKEN), c[0]);
  assert.ok(!JSON.stringify(r).includes(TOKEN) && !h.logs.join('\n').includes(TOKEN));
  assert.ok(!JSON.stringify(h.calls.filter(c => c[0] === 'exec')).includes('PROVIDER-KEY'));
  // scope: no HOME-wide scans, no recursive deletes, only bridge-owned paths written
  for (const [, cmd] of h.calls.filter(c => c[0] === 'exec')) {
    assert.ok(!/\b(find|du|ls -R|chown|sudo)\b|rm -rf|~\//.test(cmd), cmd);
    for (const m of cmd.matchAll(/\/home\/daytona\/[^\s"';]*/g))
      assert.ok(m[0].startsWith(B.FILES_BRIDGE_PATHS.base) || m[0] === B.FILES_BRIDGE_PATHS.root, m[0]);
  }
  assert.ok(!h.kinds().some(k => /start|stop|snapshot|delete/i.test(k)));
});

test('install refuses bad capability grants and unowned workspace, without uploading secrets', async () => {
  const good = GRANT;
  for (const capability of [{ ...good, machineId: 'sb-other' }, { ...good, expiresAt: NOW + 1000 }, { ...good, token: 'short' },
    { ...good, workspaceId: '-x' }, { ...good, writerEpoch: 0 }, { ...good, token: 'a b'.repeat(20) },
    // endpoint must be exactly the configured gateway + agent prefix
    { ...good, endpoint: undefined }, { ...good, endpoint: 'https://evil.example/p/_cloudbite/computer/files/agent/v1' },
    { ...good, endpoint: GATEWAY + '/api/cloudbite/computer/files/agent/v1' }, { ...good, endpoint: ENDPOINT + '/' },
    { ...good, endpoint: 'http://gw.cloudbite.example/p/_cloudbite/computer/files/agent/v1' }, { ...good, endpoint: GATEWAY }]) {
    const h = harness({ grant: { ok: true, body: capability } });
    const r = await h.run(() => B.filesBridgeInstall(h.deps, { requestId: REQ }));
    assert.equal(r.body.error.code, 'install_failed', JSON.stringify(capability));
    assert.ok(!h.kinds().includes('upload') && !h.kinds().includes('exec'));
  }
  const refused = harness({ grant: { error: { code: 'writer_conflict', message: 'writer_conflict', retryable: false }, status: 409 } });
  const rf = await B.filesBridgeInstall(refused.deps, { requestId: REQ });
  assert.equal(rf.status, 409); assert.equal(rf.body.error.code, 'writer_conflict');
  assert.ok(!refused.kinds().includes('exec'));
  for (const grant of [{ error: { code: '<script>' }, status: 200 }, { ok: true }, { ok: 'yes', body: GRANT }, null, { ok: false, code: 'x', status: 503 }]) {
    const weird = harness({ grant });
    const w = await B.filesBridgeInstall(weird.deps, { requestId: REQ });
    assert.equal(w.body.error.code, 'install_failed', JSON.stringify(grant)); assert.ok(w.status >= 400);
    assert.ok(!weird.kinds().includes('upload') && !weird.kinds().includes('exec'));
  }
  const base = harness({ exec: [{ exitCode: 44, result: '' }] });
  const bo = await B.filesBridgeInstall(base.deps, { requestId: REQ });
  assert.equal(bo.status, 409); assert.equal(bo.body.error.code, 'base_exists_unowned');
  assert.ok(!base.kinds().includes('upload'), 'pre-existing unowned private base untouched');
  const swapped = harness({ exec: [{ exitCode: 0, result: '' }, { exitCode: 45, result: '' }] });
  assert.equal((await B.filesBridgeInstall(swapped.deps, { requestId: REQ })).body.error.code, 'install_failed');
  assert.equal(swapped.calls.filter(c => c[0] === 'exec').length, 2, 'no init after a refused activate');
  assert.throws(() => B.filesBridgePrepareScript('-x', 'w'), /bad identifier/);
  assert.throws(() => B.filesBridgePrepareScript('sb', 'w o'), /bad identifier/);
  const unowned = harness({ exec: [{ exitCode: 42, result: '' }] });
  assert.equal((await B.filesBridgeInstall(unowned.deps, { requestId: REQ })).body.error.code, 'workspace_exists_unowned');
  assert.ok(!unowned.kinds().includes('upload'), 'existing user folder untouched, nothing uploaded');
  const symlinked = harness({ exec: [{ exitCode: 41, result: '' }] });
  assert.equal((await B.filesBridgeInstall(symlinked.deps, { requestId: REQ })).body.error.code, 'install_failed');
  const lost = harness({ uploadThrows: true });
  assert.equal((await B.filesBridgeInstall(lost.deps, { requestId: REQ })).body.error.code, 'install_failed');
  assert.equal(lost.calls.filter(c => c[0] === 'exec').length, 1, 'no activate after a failed upload');
  const stale = harness({ exec: [{ exitCode: 0, result: '' }, { exitCode: 0, result: '' }, { exitCode: 2, result: '{"ok": false, "code": "stale_writer_epoch"}' }] });
  const s = await B.filesBridgeInstall(stale.deps, { requestId: REQ });
  assert.equal(s.status, 409); assert.equal(s.body.error.code, 'stale_writer_epoch');
  const garbage = harness({ exec: [{ exitCode: 0, result: '' }, { exitCode: 0, result: '' }, { exitCode: 0, result: 'Traceback ' + TOKEN }] });
  const g = await B.filesBridgeInstall(garbage.deps, { requestId: REQ });
  assert.equal(g.body.error.code, 'agent_failed'); assert.ok(!JSON.stringify(g).includes(TOKEN));
  const scope = harness({ exec: [{ exitCode: 0, result: '' }, { exitCode: 0, result: '' }, { exitCode: 0, result: '{"ok": true}' },
    { exitCode: 2, result: '{"ok": false, "code": "scope_mismatch"}' }] });
  assert.equal((await B.filesBridgeInstall(scope.deps, { requestId: REQ })).body.error.code, 'scope_mismatch');
  const unknown = harness({ exec: [new Error('socket hang up')] });
  assert.equal((await B.filesBridgeInstall(unknown.deps, { requestId: REQ })).body.error.code, 'install_failed');
});

const FILE = { kind: 'file', fileId: 'f_abc', path: 'docs/a.txt', versionId: 'v_1', size: 3, sha256: 'a'.repeat(64) };
const DIR = { kind: 'dir', fileId: 'f_dir', path: 'docs' };

test('materialize validates the manifest before any provider call', async () => {
  for (const manifest of [[], [DIR], [FILE, { ...FILE, fileId: 'f_two' }], [{ ...FILE, path: '../x' }], [{ ...FILE, path: '/abs' }],
    [{ ...FILE, path: 'a//b' }], [{ ...FILE, fileId: 'f_other' }], [{ ...FILE, extra: 1 }], [{ ...FILE, sha256: 'X'.repeat(64) }],
    [{ ...FILE, size: -1 }], [{ ...DIR, kind: 'link' }, FILE], Array(65).fill(DIR).concat([FILE]), 'nope']) {
    const h = harness();
    const r = await B.filesBridgeMaterialize(h.deps, { requestId: REQ, manifest, fileId: 'f_abc', versionId: 'v_1' });
    assert.equal(r.body.error.code, 'bad_request', JSON.stringify(manifest).slice(0, 80));
    assert.deepEqual(h.calls, []);
  }
  const h = harness();
  assert.equal((await B.filesBridgeMaterialize(h.deps, { requestId: REQ, manifest: [FILE], fileId: '-rf', versionId: 'v_1' })).body.error.code, 'bad_request');
});

test('materialize: explicit open on the running owned machine only', async () => {
  const opened = '{"ok": true, "added": 2}\n{"ok": true, "leaseId": "l1", "path": "docs/a.txt", "state": "clean", "versionId": "v_1", "fetchedBytes": 3}';
  const h = harness({ exec: [{ exitCode: 0, result: '' }, { exitCode: 0, result: opened }] });
  const r = await B.filesBridgeMaterialize(h.deps, { requestId: REQ, manifest: [DIR, FILE], fileId: 'f_abc', versionId: 'v_1' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.open, { leaseId: 'l1', path: 'docs/a.txt', state: 'clean', versionId: 'v_1', fetchedBytes: 3 });
  assert.ok(!h.kinds().includes('grant'), 'materialize never mints a capability');
  const [prep, run] = h.calls.filter(c => c[0] === 'exec').map(c => c[1]);
  assert.match(prep, /install -m 600 \/dev\/null .*manifests\/0f8fad5b-d9cb-469f-a165-70867728950e\.json\.next/);
  assert.match(run, /register --manifest .* open --file-id=f_abc --version=v_1; rc=\$\?; rm -f /);
  assert.deepEqual(JSON.parse(h.calls.find(c => c[0] === 'upload')[2]), [DIR, FILE]);
  for (const over of [{ machine: null }, { sandbox: { state: 'stopped' } }, { sandbox: { name: 'x' } }]) {
    const n = harness(over);
    const rr = await B.filesBridgeMaterialize(n.deps, { requestId: REQ, manifest: [FILE], fileId: 'f_abc', versionId: 'v_1' });
    assert.ok(['not_running', 'ownership_mismatch'].includes(rr.body.error.code));
    assert.deepEqual(providerWrites(n), []);
  }
  const missing = harness({ exec: [{ exitCode: 43, result: '' }] });
  assert.equal((await B.filesBridgeMaterialize(missing.deps, { requestId: REQ, manifest: [FILE], fileId: 'f_abc', versionId: 'v_1' })).body.error.code, 'agent_not_installed');
  assert.ok(!missing.kinds().includes('upload'));
  const refused = harness({ exec: [{ exitCode: 0, result: '' }, { exitCode: 2, result: '{"ok": false, "code": "checksum_mismatch"}' }] });
  assert.equal((await B.filesBridgeMaterialize(refused.deps, { requestId: REQ, manifest: [FILE], fileId: 'f_abc', versionId: 'v_1' })).body.error.code, 'checksum_mismatch');
  const lost = harness({ exec: [{ exitCode: 0, result: '' }, new Error('timeout')] });
  assert.equal((await B.filesBridgeMaterialize(lost.deps, { requestId: REQ, manifest: [FILE], fileId: 'f_abc', versionId: 'v_1' })).body.error.code, 'unknown_outcome');
});

test('status reads agent counts only', async () => {
  const h = harness({ exec: [{ exitCode: 0, result: '{"ok": true, "states": {"clean": 1}, "transportConfigured": true}' }] });
  const r = await B.filesBridgeStatus(h.deps);
  assert.equal(r.status, 200); assert.deepEqual(r.body.agent.states, { clean: 1 });
  assert.deepEqual(h.kinds(), ['machine', 'account', 'getSandbox', 'exec']);
  const n = harness({ exec: [{ exitCode: 43, result: '' }] });
  assert.equal((await B.filesBridgeStatus(n.deps)).body.error.code, 'agent_not_installed');
});

test('prepare-end helper: fixed agent command on the running owned machine, report passed through', async () => {
  const report = { ok: true, dirty: [], uploading: [], conflict: [], unconfirmedOps: [], open: ['a.txt'], ready: false,
    remoteSaved: false, safeToDelete: false, errors: [] };
  const h = harness({ exec: [{ exitCode: 0, result: JSON.stringify(report) }] });
  const r = await B.filesBridgePrepareEnd(h.deps, { flush: true });
  assert.equal(r.status, 200); assert.deepEqual(r.body.end, report);
  assert.deepEqual(h.kinds(), ['machine', 'account', 'getSandbox', 'exec']);
  const [, cmd, timeout] = h.calls.find(c => c[0] === 'exec');
  assert.match(cmd, /--capability \/home\/daytona\/\.local\/share\/cloudbite-files\/capability\.json prepare-end --flush'$/);
  assert.equal(timeout, B.FILES_BRIDGE_LIMITS.prepareEndTimeoutS);
  const plain = harness({ exec: [{ exitCode: 0, result: JSON.stringify(report) }] });
  await B.filesBridgePrepareEnd(plain.deps);
  assert.match(plain.calls.find(c => c[0] === 'exec')[1], / prepare-end'$/);
  const bad = harness();
  assert.equal((await B.filesBridgePrepareEnd(bad.deps, { flush: 'yes' })).body.error.code, 'bad_request');
  assert.deepEqual(bad.calls, []);
  for (const over of [{ machine: null }, { sandbox: { state: 'stopped' } }]) {
    const n = harness(over);
    assert.equal((await B.filesBridgePrepareEnd(n.deps, { flush: true })).body.error.code, 'not_running');
    assert.deepEqual(providerWrites(n), [], 'never starts a machine to drain it');
  }
  assert.equal((await B.filesBridgePrepareEnd(harness({ exec: [{ exitCode: 43, result: '' }] }).deps)).body.error.code, 'agent_not_installed');
  assert.equal((await B.filesBridgePrepareEnd(harness({ exec: [new Error('timeout')] }).deps)).body.error.code, 'unknown_outcome');
  const busy = await B.filesBridgePrepareEnd(harness({ exec: [{ exitCode: 2, result: '{"ok": false, "code": "io_error"}' }] }).deps);
  assert.equal(busy.status, 409); assert.equal(busy.body.error.code, 'io_error');
});

test('generated agent source bundle is the exact Python agent and passes --check', async () => {
  const gen = await build({ entryPoints: ['src/cloudbite-computer-files-agent-source.ts'], bundle: true, write: false, platform: 'node', format: 'esm' });
  writeFileSync(join(tmp, 's.mjs'), gen.outputFiles[0].text);
  const S = await import(pathToFileURL(join(tmp, 's.mjs')));
  assert.equal(S.FILES_AGENT_SOURCE, AGENT.replace(/\r\n/g, '\n'));
  assert.equal(S.FILES_AGENT_SOURCE_SHA256, createHash('sha256').update(S.FILES_AGENT_SOURCE).digest('hex'));
  assert.ok(S.FILES_AGENT_SOURCE_BYTES <= B.FILES_BRIDGE_LIMITS.agentSourceBytes);
  assert.ok(S.FILES_AGENT_SOURCE.includes(`AGENT_PREFIX = "${B.FILES_AGENT_PREFIX}"`), 'agent and bridge share the frozen prefix');
  const check = spawnSync(process.execPath, ['tools/build-cloudbite-files-agent.mjs', '--check'], { encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr);
  const h = harness({ deps: { agentSource: S.FILES_AGENT_SOURCE } });
  assert.equal((await h.run(() => B.filesBridgeInstall(h.deps, { requestId: REQ }))).status, 200);
  assert.equal(h.calls.find(c => c[0] === 'upload')[2], S.FILES_AGENT_SOURCE);
});

test('uploaded capability and manifest are accepted by the real Python agent', async () => {
  const h = harness();
  await B.filesBridgeInstall(h.deps, { requestId: REQ });
  const dir = mkdtempSync(join(tmpdir(), 'cloudbite-bridge-py-'));
  try {
    writeFileSync(join(dir, 'cap.json'), h.calls.find(c => c[0] === 'upload' && c[1].endsWith('capability.json.next'))[2], { mode: 0o600 });
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify([DIR, FILE]));
    writeFileSync(join(dir, 'ambiguous.json'), JSON.stringify([{ ...FILE, path: 'Straße.txt' }]));
    const script = [
      'import importlib.util, json, os, sys',
      'spec = importlib.util.spec_from_file_location("fa", sys.argv[1]); fa = importlib.util.module_from_spec(spec); spec.loader.exec_module(fa)',
      'd = sys.argv[2]; os.mkdir(os.path.join(d, "root"))',
      'be = fa.HttpBackend.load(os.path.join(d, "cap.json"), clock=lambda: 1_800_000_000)',
      'a = fa.FilesAgent.init(os.path.join(d, "state"), os.path.join(d, "root"), be.scope["workspaceId"], be.scope["machineId"], be.scope["writerEpoch"])',
      'a.close(); a = fa.FilesAgent(os.path.join(d, "state"), backend=be)',
      'out = {"scope": be.scope, "register": a.register(json.load(open(os.path.join(d, "manifest.json"), encoding="utf-8")))}',
      'try:\n    a.register(json.load(open(os.path.join(d, "ambiguous.json"), encoding="utf-8")))\nexcept fa.AgentError as e:\n    out["ambiguous"] = e.code',
      'out["repr"] = repr(be); a.close(); print(json.dumps(out))',
    ].join('\n');
    const p = spawnSync(PY, ['-B', '-c', script, 'images/cloudbite-computer/files-agent.py', dir], { encoding: 'utf8' });
    assert.equal(p.status, 0, p.stderr);
    const out = JSON.parse(p.stdout.trim());
    assert.deepEqual(out.scope, { machineId: MACHINE.id, workspaceId: 'w_owner', writerEpoch: 3 });
    assert.deepEqual(out.register, { added: 2, updated: 0 });
    assert.equal(out.ambiguous, 'path_ambiguous', 'JS lower-case vs Python casefold disagreement is refused');
    assert.ok(!p.stdout.includes(TOKEN) && !p.stderr.includes(TOKEN));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('install shell scripts on a throwaway POSIX home: private modes, idempotent, refuse unowned/symlink', async () => {
  const shell = process.platform !== 'win32' ? ['bash', ['-s']]
    : spawnSync('wsl', ['-d', 'Ubuntu', '--', 'true']).status === 0 ? ['wsl', ['-d', 'Ubuntu', '--', 'bash', '-s']] : null;
  if (!shell) { skips.push('POSIX install scripts (no bash/WSL on this host)'); return; }
  const S = B.FILES_BRIDGE_SCRIPTS, sub = (s) => s.replaceAll('/home/daytona', '$T');
  const prep = sub(S.prepare('sb-1111', 'w_owner')), other = sub(S.prepare('sb-1111', 'w_other'));
  const D = '$T/.local/share/cloudbite-files';
  // `tree` fingerprints everything under $T so refusals can be shown to have changed nothing.
  const fresh = (setup) => `rm -rf "$T"; T=$(mktemp -d); ${setup}; before=$(tree)`;
  const same = (label) => `echo ${label}=$? same_${label}=$([ "$before" = "$(tree)" ] && echo y || echo n)`;
  const script = [
    'set -u; export T; mode() { stat -c %a "$1"; }; tree() { (cd "$T" && find . -printf "%p %y %m %s\\n" | sort | md5sum); }',
    'T=$(mktemp -d)', prep, 'echo prep1=$?',
    `echo "mode_root=$(mode $T/CloudFiles) mode_base=$(mode ${D}) mode_cap=$(mode ${D}/capability.json.next) owned=$(test -f ${D}/root-owned && echo y) mark=$([ \"$(cat ${D}/owner)\" = \"cloudbite-files-bridge v1 machine=sb-1111 workspace=w_owner\" ] && echo y)"`,
    `echo SECRET > ${D}/capability.json.next; echo code > ${D}/agent/files-agent.py.next`,
    sub(S.activate), 'echo act=$?',
    `echo "final=$(mode ${D}/capability.json) next=$(ls ${D}/*.next 2>/dev/null | wc -l)"`,
    prep, `echo prep2=$? kept=$(cat ${D}/capability.json)`,
    'before=$(tree)', other, same('otherws'),
    // activate refuses a placeholder swapped for a symlink and leaves the target alone
    `${prep} >/dev/null; echo outside > $T/target; rm -f ${D}/capability.json.next; ln -s $T/target ${D}/capability.json.next`,
    sub(S.activate), `echo swapped=$? target=$(cat $T/target)`,
    fresh('mkdir $T/CloudFiles; echo mine > $T/CloudFiles/user.txt'), prep, same('unowned'),
    fresh('mkdir $T/elsewhere; ln -s $T/elsewhere $T/CloudFiles'), prep, same('symlink'),
    fresh(`mkdir -p ${D}; echo theirs > ${D}/notes`), prep, same('base'),
    fresh('mkdir -p $T/.local $T/real; ln -s $T/real $T/.local/share'), prep, same('share'),
    fresh(`mkdir -p ${D} $T/real; printf %s "cloudbite-files-bridge v1 machine=sb-1111 workspace=w_owner" > ${D}/owner; ln -s $T/real ${D}/state`), prep, same('sub'),
    fresh(`mkdir -p ${D}; ln -s $T/real ${D}/owner`), prep, same('markerlink'),
    'rm -rf "$T"',
  ].join('\n') + '\n';
  const p = spawnSync(shell[0], shell[1], { input: script, encoding: 'utf8' });
  const out = Object.fromEntries(p.stdout.split(/\s+/).filter(t => t.includes('=')).map(t => t.split('=')));
  assert.deepEqual(out, { prep1: '0', mode_root: '700', mode_base: '700', mode_cap: '600', owned: 'y',
    mark: 'y', act: '0', final: '600', next: '0', prep2: '0', kept: 'SECRET',
    otherws: '44', same_otherws: 'y', swapped: '45', target: 'outside',
    unowned: '42', same_unowned: 'y', symlink: '41', same_symlink: 'y', base: '44', same_base: 'y',
    share: '41', same_share: 'y', sub: '41', same_sub: 'y', markerlink: '41', same_markerlink: 'y' }, p.stdout + p.stderr);
});

let passed = 0;
for (const [name, fn] of tests) { await fn(); passed++; console.log('ok', name); }
for (const s of skips) console.log('skip', s);
rmSync(tmp, { recursive: true, force: true });
console.log(`cloudbite-computer-files-bridge: ${passed} tests passed, ${skips.length} skips`);
