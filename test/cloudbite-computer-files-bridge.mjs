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
const WATCH = readFileSync('images/cloudbite-computer/files-watch.py', 'utf8');
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
    watchSource: WATCH,
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
    spawn: async (_c, _sb, session, command) => {
      calls.push(['spawn', session, command]);
      if (over.spawnThrows) throw new Error('spawn lost');
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

const providerWrites = (h) => h.calls.filter(c => c[0] === 'exec' || c[0] === 'upload' || c[0] === 'grant' || c[0] === 'spawn');
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
  assert.deepEqual(r.body, { ok: true, installed: true, machineId: MACHINE.id, writerEpoch: 3, expiresAt: NOW + 3600_000,
    watcher: { resumed: true, agentResumed: false, launch: 'submitted', running: 'not_observed' } });
  assert.deepEqual(h.kinds(), ['machine', 'account', 'getSandbox', 'grant', 'exec', 'upload', 'upload', 'upload', 'exec', 'exec', 'exec', 'exec', 'spawn']);
  const [prep, activate, init, status, resume] = h.calls.filter(c => c[0] === 'exec').map(c => c[1]);
  assert.match(prep, /install -m 600 \/dev\/null "\$B\/agent\/files-watch\.py\.next"/);
  assert.match(prep, /"\$B\/watch" "\$B\/owner" "\$B\/root-owned" "\$B\/watch\.log" "\$R"; do if \[ -L "\$p" \]; then exit 41/);
  assert.match(activate, /"\$B\/agent\/files-watch\.py\.next" "\$B\/capability\.json\.next"; do if \[ -L "\$f" \]/);
  assert.match(activate, /mv -f "\$B\/agent\/files-watch\.py\.next" "\$B\/agent\/files-watch\.py"/);
  const W = B.FILES_BRIDGE_PATHS;
  const watchArgs = `python3 -I -B ${W.watcher} --state ${W.watchState} --agent ${W.agent} --agent-state ${W.state} --capability ${W.capability} --root ${W.root}`;
  assert.equal(resume, `bash -c 'test -f ${W.watcher} && test ! -L ${W.watcher} && test -f ${W.agent} || exit 43; ${watchArgs} resume'`);
  const [, session, run] = h.calls.find(c => c[0] === 'spawn');
  assert.equal(session, B.FILES_WATCH_SESSION);
  // capability lifetime 3600 s minus the kill grace bounds the run; the outer timeout adds only the grace
  assert.ok(run.endsWith(`exec timeout -k 30 3600 ${watchArgs} run --max-runtime 3570 >> "$G" 2>&1'`), run);
  assert.match(run, /for p in \/home\/daytona\/\.local\/share\/cloudbite-files \S+files-watch\.py "\$G"; do if \[ -L "\$p" \]; then exit 41/);
  assert.match(run, /-gt 1048576 \]; then : > "\$G"; fi/);
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
  assert.deepEqual(uploads.map(u => u[1]), [B.FILES_BRIDGE_PATHS.agent + '.next', B.FILES_BRIDGE_PATHS.watcher + '.next', B.FILES_BRIDGE_PATHS.capability + '.next']);
  assert.equal(uploads[0][2], AGENT);
  assert.equal(uploads[1][2], WATCH);
  const cap = JSON.parse(uploads[2][2]);
  assert.deepEqual(Object.keys(cap).sort(), ['endpoint', 'expiresAt', 'machineId', 'schema', 'token', 'workspaceId', 'writerEpoch']);
  assert.equal(cap.endpoint, ENDPOINT);
  assert.deepEqual(h.calls.find(c => c[0] === 'grant')[1], { machine: MACHINE, requestId: REQ });
  // secret placement: only the capability upload body carries the token; never argv, results or logs
  for (const c of h.calls) if (!(c[0] === 'upload' && c[1].endsWith('capability.json.next'))) assert.ok(!JSON.stringify(c).includes(TOKEN), c[0]);
  assert.ok(!JSON.stringify(r).includes(TOKEN) && !h.logs.join('\n').includes(TOKEN));
  assert.ok(!JSON.stringify(h.calls.filter(c => c[0] === 'exec')).includes('PROVIDER-KEY'));
  // scope: no HOME-wide scans, no recursive deletes, only bridge-owned paths written
  for (const [, cmd] of h.calls.filter(c => c[0] === 'exec' || c[0] === 'spawn').map(c => [c[0], c[0] === 'exec' ? c[1] : c[2]])) {
    assert.ok(!/\b(find|du|ls -R|chown|sudo|nohup|setsid|disown)\b|rm -rf|~\/|&\s*$/.test(cmd), cmd);
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

test('install launches the watcher honestly: resume first, bounded async run, failures never claim running', async () => {
  for (const deps of [{ watchSource: 'print(1)' }, { watchSource: '#!/usr/bin/env python3\n' + 'x'.repeat(300 * 1024) }, { spawn: undefined }]) {
    const h = harness({ deps });
    assert.equal((await B.filesBridgeInstall(h.deps, { requestId: REQ })).body.error.code, 'not_configured');
    assert.deepEqual(h.calls, [], 'refused before any provider call or grant');
  }
  const OK = { exitCode: 0, result: '{"ok": true, "transportConfigured": true}' };
  // watcher resume refused (e.g. a pinned config from another layout): no background run is submitted
  const refused = harness({ exec: [OK, OK, OK, OK, { exitCode: 2, result: '{"ok": false, "code": "config_mismatch"}' }] });
  const rr = await B.filesBridgeInstall(refused.deps, { requestId: REQ });
  assert.equal(rr.status, 409); assert.equal(rr.body.error.code, 'config_mismatch');
  assert.ok(!refused.kinds().includes('spawn'));
  // a watcher that holds the lock defers the resume to its next tick; the second run then exits on the lock
  const deferred = harness({ exec: [OK, OK, OK, OK, { exitCode: 0, result: '{"deferred": true, "ok": true}' }] });
  const d = await B.filesBridgeInstall(deferred.deps, { requestId: REQ });
  assert.deepEqual(d.body.watcher, { resumed: 'deferred', agentResumed: null, launch: 'submitted', running: 'not_observed' });
  const resumed = harness({ exec: [OK, OK, OK, OK, { exitCode: 0, result: '{"agentCode": null, "agentResumed": true, "draining": false, "ok": true}' }] });
  assert.equal((await B.filesBridgeInstall(resumed.deps, { requestId: REQ })).body.watcher.agentResumed, true);
  // the submission outcome is unknown: reported as such (retryable), never as installed + running
  const lost = harness({ spawnThrows: true });
  const l = await B.filesBridgeInstall(lost.deps, { requestId: REQ });
  assert.equal(l.status, 503); assert.equal(l.body.error.code, 'unknown_outcome');
  // repeated configure: same fixed command into the same session (the watcher lock keeps one worker)
  const twice = harness();
  await B.filesBridgeInstall(twice.deps, { requestId: REQ }); await B.filesBridgeInstall(twice.deps, { requestId: REQ });
  const spawns = twice.calls.filter(c => c[0] === 'spawn');
  assert.equal(spawns.length, 2); assert.equal(spawns[0][2], spawns[1][2]); assert.equal(spawns[0][1], spawns[1][1]);
  // lifetime: whole seconds, never past 6 h nor the capability (minus the kill grace), never below the minimum
  assert.equal(B.filesBridgeWatchRuntime(NOW + 10 * 3600_000, NOW), 6 * 3600);
  assert.equal(B.filesBridgeWatchRuntime(NOW + 600_000, NOW), 570);
  assert.equal(B.filesBridgeWatchRuntime(NOW + 61_000, NOW), 60);
  const short = harness({ grant: { ok: true, body: { ...GRANT, expiresAt: NOW + 600_000 } } });
  await B.filesBridgeInstall(short.deps, { requestId: REQ });
  assert.match(short.calls.find(c => c[0] === 'spawn')[2], /timeout -k 30 600 .* run --max-runtime 570 >>/);
  for (const n of [59, 6 * 3600 + 1, 1.5, NaN]) assert.throws(() => B.filesBridgeWatchRunScript(n), /bad runtime/);
});

test('resume: only a machine this bridge set up; capability refresh + watcher resume + bounded run; secret only in upload', async () => {
  const OK = { exitCode: 0, result: '{"ok": true}' };
  const h = harness({ exec: [OK, OK, OK, { exitCode: 0, result: '{"agentCode": null, "agentResumed": true, "draining": false, "ok": true}' }] });
  const r = await h.run(() => B.filesBridgeResume(h.deps, { requestId: REQ }));
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.deepEqual(r.body, { ok: true, resumed: true, machineId: MACHINE.id, writerEpoch: 3, expiresAt: NOW + 3600_000,
    watcher: { resumed: true, agentResumed: true, launch: 'submitted', running: 'not_observed' } });
  assert.deepEqual(h.kinds(), ['machine', 'account', 'getSandbox', 'exec', 'grant', 'exec', 'upload', 'exec', 'exec', 'spawn']);
  const [probe, refresh, activate, resume] = h.calls.filter(c => c[0] === 'exec').map(c => c[1]);
  assert.equal(probe, B.FILES_BRIDGE_SCRIPTS.probe(MACHINE.id));
  assert.ok(!/mkdir|install|rm |mv |>/.test(probe.replace(/2>\/dev\/null/g, '')), 'the probe writes nothing');
  assert.match(probe, /"cloudbite-files-bridge v1 machine=sb-1111 workspace="\*\) exit 0;; esac; exit 43'$/);
  assert.equal(refresh, B.FILES_BRIDGE_SCRIPTS.refresh(MACHINE.id, 'w_owner'));
  assert.ok(refresh.indexOf('exit 44') < refresh.indexOf('install -m 600'), 'owner marker checked before the placeholder');
  assert.ok(!/mkdir/.test(refresh), 'refresh never creates the install');
  assert.equal(activate, B.FILES_BRIDGE_SCRIPTS.activateCapability);
  assert.equal(resume, B.FILES_BRIDGE_SCRIPTS.watchResume);
  assert.deepEqual(h.calls.filter(c => c[0] === 'upload').map(c => c[1]), [B.FILES_BRIDGE_PATHS.capability + '.next'], 'only the capability is replaced');
  for (const c of h.calls) if (!(c[0] === 'upload')) assert.ok(!JSON.stringify(c).includes(TOKEN), c[0]);
  assert.ok(!JSON.stringify(r).includes(TOKEN) && !h.logs.join('\n').includes(TOKEN));
  assert.ok(!h.kinds().some(k => /start|stop|snapshot|delete/i.test(k)));

  // never set up here (or set up for another machine): skipped before any grant or write
  const fresh = harness({ exec: [{ exitCode: 43, result: '' }] });
  assert.deepEqual((await B.filesBridgeResume(fresh.deps, { requestId: REQ })).body, { ok: true, skipped: 'not_installed' });
  assert.deepEqual(fresh.kinds(), ['machine', 'account', 'getSandbox', 'exec']);
  const linked = harness({ exec: [{ exitCode: 41, result: '' }] });
  assert.equal((await B.filesBridgeResume(linked.deps, { requestId: REQ })).body.error.code, 'install_failed');
  assert.ok(!linked.kinds().includes('grant'));
  const probeLost = harness({ exec: [new Error('timeout')] });
  assert.equal((await B.filesBridgeResume(probeLost.deps, { requestId: REQ })).body.error.code, 'unknown_outcome');
  assert.ok(!probeLost.kinds().includes('grant'));
  // a different writer or a refused grant: nothing written
  const conflict = harness({ exec: [OK], grant: { error: { code: 'writer_conflict' }, status: 409 } });
  assert.equal((await B.filesBridgeResume(conflict.deps, { requestId: REQ })).body.error.code, 'writer_conflict');
  assert.ok(!conflict.kinds().includes('upload') && !conflict.kinds().includes('spawn'));
  const foreignBase = harness({ exec: [OK, { exitCode: 44, result: '' }] });
  assert.equal((await B.filesBridgeResume(foreignBase.deps, { requestId: REQ })).body.error.code, 'base_exists_unowned');
  assert.ok(!foreignBase.kinds().includes('upload'));
  const swapped = harness({ exec: [OK, OK, { exitCode: 45, result: '' }] });
  assert.equal((await B.filesBridgeResume(swapped.deps, { requestId: REQ })).body.error.code, 'install_failed');
  assert.ok(!swapped.kinds().includes('spawn'));
  const spawnLost = harness({ exec: [OK, OK, OK, OK], spawnThrows: true });
  assert.equal((await B.filesBridgeResume(spawnLost.deps, { requestId: REQ })).body.error.code, 'unknown_outcome');
  for (const over of [{ machine: null }, { sandbox: { state: 'stopped' } }, { sandbox: { labels: {} } }]) {
    const n = harness(over);
    assert.ok(['not_running', 'ownership_mismatch'].includes((await B.filesBridgeResume(n.deps, { requestId: REQ })).body.error.code));
    assert.deepEqual(providerWrites(n), [], 'never starts or touches a machine that is not running and owned');
  }
  const bad = harness();
  assert.equal((await B.filesBridgeResume(bad.deps, { requestId: 'x' })).body.error.code, 'bad_request');
  assert.equal((await B.filesBridgeResume({ ...bad.deps, spawn: undefined }, { requestId: REQ })).body.error.code, 'not_configured');
  assert.deepEqual(bad.calls, []);
  assert.throws(() => B.filesBridgeProbeScript('-x'), /bad identifier/);
  assert.throws(() => B.filesBridgeRefreshScript('sb', "w'x"), /bad identifier/);
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
  assert.match(run, /register --manifest .* open --file-id=f_abc --version=v_1 --lease=0f8fad5bd9cb469fa16570867728950e; rc=\$\?; rm -f /);
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

test('lease close: explicit, validated lease id, fixed agent command on the running owned machine', async () => {
  const lease = 'a'.repeat(32);
  const h = harness({ exec: [{ exitCode: 0, result: `{"ok": true, "closed": "${lease}"}` }] });
  const r = await B.filesBridgeClose(h.deps, { leaseId: lease });
  assert.equal(r.status, 200); assert.equal(r.body.closed.closed, lease);
  assert.deepEqual(h.kinds(), ['machine', 'account', 'getSandbox', 'exec']);
  assert.match(h.calls.find(c => c[0] === 'exec')[1], new RegExp(` close --lease=${lease}'$`));
  for (const leaseId of [undefined, '', 'A'.repeat(32), 'a'.repeat(31), "a'; rm -rf ~; '", '--lease=x' + 'a'.repeat(23)]) {
    const b = harness();
    assert.equal((await B.filesBridgeClose(b.deps, { leaseId })).body.error.code, 'bad_request');
    assert.deepEqual(b.calls, [], 'refused before any provider call');
  }
  const stopped = harness({ sandbox: { state: 'stopped' } });
  assert.equal((await B.filesBridgeClose(stopped.deps, { leaseId: lease })).body.error.code, 'not_running');
  assert.deepEqual(providerWrites(stopped), []);
  const gone = await B.filesBridgeClose(harness({ exec: [{ exitCode: 2, result: '{"ok": false, "code": "not_found"}' }] }).deps, { leaseId: lease });
  assert.equal(gone.status, 409); assert.equal(gone.body.error.code, 'not_found');
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

test('watcher wiring on a throwaway POSIX home: probe/refresh guards, real agent + watcher CLI, one worker, private log', async () => {
  const shell = process.platform !== 'win32' ? ['bash', ['-s']]
    : spawnSync('wsl', ['-d', 'Ubuntu', '--', 'true']).status === 0 ? ['wsl', ['-d', 'Ubuntu', '--', 'bash', '-s']] : null;
  if (!shell) { skips.push('POSIX watcher wiring (no bash/WSL on this host)'); return; }
  const host = (f) => process.platform !== 'win32' ? join(process.cwd(), f)
    : spawnSync('wsl', ['-d', 'Ubuntu', '--', 'wslpath', '-a', join(process.cwd(), f).replace(/\\/g, '/')], { encoding: 'utf8' }).stdout.trim();
  const S = B.FILES_BRIDGE_SCRIPTS, sub = (s) => s.replaceAll('/home/daytona', '$T');
  const D = '$T/.local/share/cloudbite-files';
  const cap = JSON.stringify({ schema: B.FILES_CAPABILITY_SCHEMA, endpoint: 'http://127.0.0.1:9' + B.FILES_AGENT_PREFIX, token: TOKEN,
    machineId: 'sb-1111', workspaceId: 'w_owner', writerEpoch: 3, expiresAt: Date.now() + 3600_000 });
  const RUN = sub(S.watchRun(60));
  const tree = 'tree() { (cd "$T" && find . -printf "%p %y %m %s\\n" | sort | md5sum); }';
  const script = [
    `set -u; export T; mode() { stat -c %a "$1"; }; ${tree}`,
    'T=$(mktemp -d)', 'before=$(tree)',
    sub(S.probe('sb-1111')), 'echo probe0=$?',
    sub(S.refresh('sb-1111', 'w_owner')), 'echo refresh0=$? same_refresh0=$([ "$before" = "$(tree)" ] && echo y || echo n)',
    sub(S.watchRun(60)), 'echo run0=$? same_run0=$([ "$before" = "$(tree)" ] && echo y || echo n)',
    sub(S.prepare('sb-1111', 'w_owner')), 'echo prep=$? mode_watch=$(mode ' + D + '/watch) mode_wnext=$(mode ' + D + '/agent/files-watch.py.next)',
    `cat '${host('images/cloudbite-computer/files-agent.py')}' > ${D}/agent/files-agent.py.next`,
    `cat '${host('images/cloudbite-computer/files-watch.py')}' > ${D}/agent/files-watch.py.next`,
    `printf '%s' '${cap}' > ${D}/capability.json.next`,
    sub(S.activate), `echo act=$? mode_w=$(mode ${D}/agent/files-watch.py)`,
    sub(S.probe('sb-1111')), 'echo probe_noinit=$?',
    `python3 -I -B ${D}/agent/files-agent.py --state ${D}/state init --root $T/CloudFiles --workspace-id=w_owner --machine-id=sb-1111 --writer-epoch=3 >/dev/null; echo init=$?`,
    sub(S.probe('sb-1111')), 'echo probe1=$?',
    sub(S.probe('sb-2222')), 'echo probe_other=$?',
    'before=$(tree)', sub(S.refresh('sb-1111', 'w_other')), 'echo refresh_other=$? same_other=$([ "$before" = "$(tree)" ] && echo y || echo n)',
    sub(S.refresh('sb-1111', 'w_owner')), `echo refresh1=$? mode_cnext=$(mode ${D}/capability.json.next)`,
    `printf '%s' '${cap}' > ${D}/capability.json.next`, sub(S.activateCapability), `echo actcap=$? mode_cap=$(mode ${D}/capability.json) cnext=$(ls ${D}/capability.json.next 2>/dev/null | wc -l)`,
    // real watcher CLI: resume with no running worker resumes the agent; then one bounded background run
    `out=$(${sub(S.watchResume)}); echo resume1=$?; case "$out" in *'"agentResumed": true'*'"ok": true'*) echo resumed=y;; *) echo resumed=n;; esac`,
    `(${RUN}) & sleep 4`,
    `${RUN}; echo dup=$?`,
    `out=$(${sub(S.watchResume)}); case "$out" in *'"deferred": true'*) echo deferred=y;; *) echo deferred=n;; esac`,
    `pkill -TERM -f "$T/.local/share/cloudbite-files/agent/files-watch.py --state"; wait`,
    `echo busy=$(grep -c '"code": "watcher_busy"' ${D}/watch.log) stopped=$(grep -c '"stopped": "terminated"' ${D}/watch.log) mode_log=$(mode ${D}/watch.log)`,
    `echo leak=$(grep -c '${TOKEN}' ${D}/watch.log)`,
    `rm -f ${D}/watch.log; echo outside > $T/target; ln -s $T/target ${D}/watch.log`, RUN, 'echo linklog=$? target=$(cat $T/target)',
    `rm -f ${D}/watch.log; mv ${D}/agent/files-watch.py $T/w.py`, RUN, 'echo nowatch=$?',
    `mv $T/w.py ${D}/agent/files-watch.py; rm -f ${D}/capability.json; ln -s $T/target ${D}/capability.json`, sub(S.probe('sb-1111')), 'echo probe_link=$?',
    'rm -rf "$T"',
  ].join('\n') + '\n';
  const p = spawnSync(shell[0], shell[1], { input: script, encoding: 'utf8', timeout: 120_000 });
  const out = Object.fromEntries(p.stdout.split(/\s+/).filter(t => /^[a-z_0-9]+=/.test(t)).map(t => t.split('=')));
  assert.deepEqual(out, { probe0: '43', refresh0: '43', same_refresh0: 'y', run0: '43', same_run0: 'y',
    prep: '0', mode_watch: '700', mode_wnext: '600', act: '0', mode_w: '600', probe_noinit: '43', init: '0', probe1: '0', probe_other: '43',
    refresh_other: '44', same_other: 'y', refresh1: '0', mode_cnext: '600', actcap: '0', mode_cap: '600', cnext: '0',
    resume1: '0', resumed: 'y', dup: '2', deferred: 'y', busy: '1', stopped: '1', mode_log: '600', leak: '0',
    linklog: '41', target: 'outside', nowatch: '43', probe_link: '41' }, p.stdout + p.stderr);
});
let passed = 0;
for (const [name, fn] of tests) { await fn(); passed++; console.log('ok', name); }
for (const s of skips) console.log('skip', s);
rmSync(tmp, { recursive: true, force: true });
console.log(`cloudbite-computer-files-bridge: ${passed} tests passed, ${skips.length} skips`);
