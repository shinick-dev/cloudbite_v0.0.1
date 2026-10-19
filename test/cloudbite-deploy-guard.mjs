// Guarded production deploy (tools/deploy-cloudbite.mjs) against throwaway local git repos.
// Real git for repository state and real separate processes for the deploy lock; npm and wrangler are faked,
// so nothing builds, uploads or touches the network.
// Run: node test/cloudbite-deploy-guard.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  deployCloudbite, spawnRunner, DeployGuardError, CLOUDBITE_CONFIG, LOCK_NAME,
  acquireDeployLock, recoverStaleLock, canonicalDeployment,
} from '../tools/deploy-cloudbite.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let checks = 0;
const ok = (cond, message) => { assert.ok(cond, message); checks++; };

const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
ok(pkg.scripts.deploy === 'node tools/deploy-cloudbite.mjs', 'npm run deploy routes through the guard only');
ok(!/wrangler\.jsonc|gw-shinick/.test(readFileSync(path.join(repoRoot, 'tools/deploy-cloudbite.mjs'), 'utf8').replace(/wrangler\.cloudbite\.jsonc/g, '')), 'guard never names the legacy config');

// Manual production workflow: main only, serialized, npm run deploy, secrets referenced but never echoed.
{
  const wf = readFileSync(path.join(repoRoot, '.github/workflows/cloudbite-production.yml'), 'utf8');
  const on = /^on:\n((?:[ #].*\n|\n)*)/m.exec(wf)?.[1] ?? '';
  ok(/^\s+workflow_dispatch:/m.test(on) && !/^\s+(push|pull_request|pull_request_target|schedule|workflow_run|repository_dispatch):/m.test(on), 'workflow is manual workflow_dispatch only');
  ok(/if: github\.ref == 'refs\/heads\/main'/.test(wf), 'workflow job runs only on main');
  ok(/concurrency:\n\s+group: cloudbite-production\n\s+cancel-in-progress: false/.test(wf), 'workflow serialized in cloudbite-production without cancelling');
  ok(/^permissions:\n {2}contents: read\n\S*\n/m.test(wf), 'workflow token is contents: read only');
  ok(/run: npm ci\n/.test(wf) && /run: npm run deploy\n/.test(wf) && !/wrangler (deploy|secret)/.test(wf), 'workflow installs with npm ci and deploys only through the guard');
  ok(/node-version: '\d+\.\d+\.\d+'/.test(wf) && /python-version: '\d+\.\d+\.\d+'/.test(wf), 'Node and Python versions are pinned exactly');
  ok([...wf.matchAll(/uses: (\S+)/g)].every((m) => /@[0-9a-f]{40}$/.test(m[1])), 'actions pinned to full commit SHAs');
  ok(!/echo[^\n]*\$\{?\{?\s*(secrets\.|CLOUDFLARE_API_TOKEN|CLOUDFLARE_ACCOUNT_ID)/.test(wf.replace(/\[ -z "\$CLOUDFLARE_[A-Z_]+" \]/g, '')), 'credentials are never echoed');
  ok(/-z "\$CLOUDFLARE_API_TOKEN"/.test(wf) && /-z "\$CLOUDFLARE_ACCOUNT_ID"/.test(wf) && /exit 1/.test(wf), 'missing credentials fail with a clear configuration error');
}

const tmp = mkdtempSync(path.join(os.tmpdir(), 'cb-deploy-guard-'));
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
const sh = (cwd, ...args) => { const r = spawnRunner('git', args, { cwd, env: gitEnv, capture: true }); assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`); return r.stdout.trim(); };
const CONFIG = '{\n  // test\n  "name": "cloudbite-v001",\n  "env": { "dev": { "name": "x" } }\n}\n';
let n = 0;
function setup() {
  const dir = path.join(tmp, `case-${++n}`);
  const origin = `${dir}-origin.git`;
  sh(tmp, 'init', '-q', '--bare', '-b', 'main', origin);
  sh(tmp, 'init', '-q', '-b', 'main', dir);
  writeFileSync(path.join(dir, CLOUDBITE_CONFIG), CONFIG);
  writeFileSync(path.join(dir, '.gitignore'), '.artifacts/\nnode_modules/\n');
  writeFileSync(path.join(dir, 'app.txt'), 'v1\n');
  sh(dir, 'add', '-A'); sh(dir, 'commit', '-q', '-m', 'base');
  sh(dir, 'remote', 'add', 'origin', origin);
  sh(dir, 'push', '-q', 'origin', 'main');
  return { dir, origin };
}
const commit = (dir, file, text, msg = 'change') => { writeFileSync(path.join(dir, file), text); sh(dir, 'add', '-A'); sh(dir, 'commit', '-q', '-m', msg); return sh(dir, 'rev-parse', 'HEAD'); };

const NODE = '/fake/node', NPM = '/fake/npm-cli.js', WRANGLER = '/fake/wrangler.js';
const STATUS_ARGS = [WRANGLER, 'deployments', 'status', '--config', 'wrangler.cloudbite.jsonc', '--json'];
// Shape of `wrangler deployments status --json` (wrangler 4.143). author_email must never be printed.
const deployment = (id, versions) => JSON.stringify({ id, source: 'wrangler', strategy: 'percentage', author_email: 'private@example.invalid', annotations: {}, versions, created_on: '2026-10-19T00:00:00Z' }, null, 2);
const STABLE = deployment('dep-1', [{ version_id: 'ver-a', percentage: 100 }]);
// Fake runner: real git, recorded npm/wrangler with scriptable outcomes.
// status: successive `deployments status` results (string stdout or { status, stdout }); the last one repeats.
function runner({ fail = {}, during, status = [STABLE] } = {}) {
  const calls = [];
  let reads = 0;
  const run = (cmd, args, opts) => {
    if (cmd === 'git') { const r = spawnRunner(cmd, args, { ...opts, env: { ...opts.env, ...gitEnv } }); calls.push({ git: args, status: r.status }); return r; }
    const isStatus = args[0] === WRANGLER && args[1] === 'deployments';
    ok(cmd === NODE && opts.capture === isStatus, `non-git commands run via the node binary without a shell, capturing only remote state: ${cmd} ${args[1]}`);
    calls.push({ cmd, args, env: opts.env });
    if (isStatus) {
      const s = status[Math.min(reads++, status.length - 1)];
      return typeof s === 'string' ? { status: 0, stdout: s, stderr: '' } : { stdout: '', stderr: '', ...s };
    }
    const key = args[0] === NPM ? args[2] : 'wrangler';
    if (args[0] === NPM && during?.[key]) during[key]();
    return { status: fail[key] ?? 0, stdout: '', stderr: '' };
  };
  return { run, calls, external: () => calls.filter((c) => c.cmd).map((c) => c.args) };
}
const env = { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, npm_execpath: NPM, CLOUDFLARE_API_TOKEN: 'secret-token-value' };
const logs = [];
const deploy = (dir, r, argv = [], e = env) => deployCloudbite({ repo: dir, argv, env: e, run: r.run, nodePath: NODE, wranglerBin: WRANGLER, log: (l) => logs.push(l) });
const refuses = (fn, re, message) => {
  try { fn(); } catch (e) { ok(e instanceof DeployGuardError && re.test(e.message), `${message}: ${e.message}`); return; }
  assert.fail(`${message}: expected refusal`);
};
const noDeploy = (r, message) => ok(!r.external().some((a) => a[0] === WRANGLER && a[1] === 'deploy'), `${message}: wrangler deploy never ran`);
const lockPath = (dir) => path.join(dir, '.git', LOCK_NAME);
const noLock = (dir, message) => ok(!readdirSync(path.join(dir, '.git')).some((f) => f.startsWith(LOCK_NAME)), `${message}: deploy lock released, no leftovers`);

// Separate lock-holder process: acquires the real lock, prints its token, releases on "release".
const HOLDER = path.join(tmp, 'lock-holder.mjs');
writeFileSync(HOLDER, `import { acquireDeployLock } from ${JSON.stringify(pathToFileURL(path.join(repoRoot, 'tools/deploy-cloudbite.mjs')).href)};
import { createInterface } from 'node:readline';
let lock;
try { lock = acquireDeployLock(process.argv[2], { worktree: 'holder', head: 'holder-head' }); }
catch (e) { console.log('BUSY ' + e.message.replace(/\\n/g, ' ')); process.exit(3); }
console.log('ACQUIRED ' + lock.token);
createInterface({ input: process.stdin }).on('line', (l) => { if (l === 'release') { console.log('RELEASED ' + lock.release()); process.exit(0); } });
`);
function holder(commonDir) {
  const child = spawn(process.execPath, [HOLDER, commonDir], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
  const queue = [], waiters = [];
  createInterface({ input: child.stdout }).on('line', (l) => (waiters.length ? waiters.shift()(l) : queue.push(l)));
  const next = () => new Promise((res) => (queue.length ? res(queue.shift()) : waiters.push(res)));
  const exited = new Promise((res) => child.on('exit', (code, signal) => res({ code, signal })));
  return { child, next, exited };
}

try {
  // Normal path: exact command sequence, verified hash tag/message, caller env (secrets) passed through untouched.
  {
    const { dir } = setup();
    const head = sh(dir, 'rev-parse', 'HEAD');
    const r = runner();
    const res = deploy(dir, r);
    ok(res.head === head && res.main === head && res.dryRun === false, 'normal deploy reports the verified candidate');
    assert.deepEqual(r.external(), [
      STATUS_ARGS,
      [NPM, 'run', 'check'],
      [NPM, 'run', 'test:cloudbite'],
      STATUS_ARGS,
      [WRANGLER, 'deploy', '--config', 'wrangler.cloudbite.jsonc', '--tag', head.slice(0, 12), '--message', `guarded deploy ${head}`],
    ]); checks++;
    ok(r.calls.filter((c) => c.cmd).every((c) => c.env.CLOUDFLARE_API_TOKEN === 'secret-token-value'), 'secrets reach npm/wrangler unchanged');
    ok(r.calls.some((c) => c.git?.join(' ') === 'fetch --no-tags origin refs/heads/main:refs/remotes/origin/main'), 'fetches origin main explicitly');
    ok(!logs.join('\n').includes('private@example.invalid') && !logs.join('\n').includes('secret-token-value'), 'remote state JSON (author email) and secrets are never logged');
    ok(logs.some((l) => l.includes('dep-1 [ver-a=100]')), 'canonical production state is logged');
    noLock(dir, 'normal deploy');
    // Ignored paths are fine; dry-run appends --dry-run and nothing else.
    mkdirSync(path.join(dir, '.artifacts'));
    writeFileSync(path.join(dir, '.artifacts', 'note.json'), 'ignored');
    mkdirSync(path.join(dir, 'node_modules'));
    writeFileSync(path.join(dir, 'node_modules', 'x.js'), 'ignored');
    const d = runner();
    ok(deploy(dir, d, ['--dry-run']).dryRun === true, 'dry-run accepted with ignored files present');
    assert.deepEqual(d.external().at(-1), [WRANGLER, 'deploy', '--config', 'wrangler.cloudbite.jsonc', '--tag', head.slice(0, 12), '--message', `guarded deploy ${head}`, '--dry-run']); checks++;
    ok(d.external().length === 3, 'dry-run still runs check and test:cloudbite');
    ok(!d.external().some((a) => a[1] === 'deployments'), 'dry-run reads no remote deployment state');
    noLock(dir, 'dry-run');
  }

  // Candidate ahead of origin/main is allowed (feature on top of latest main).
  {
    const { dir } = setup();
    const head = commit(dir, 'app.txt', 'v2\n');
    const r = runner();
    ok(deploy(dir, r).head === head, 'HEAD ahead of origin/main deploys');
  }

  // Divergent: origin/main has released work the candidate lacks (the regression this guard exists for).
  {
    const { dir, origin } = setup();
    const other = path.join(tmp, `other-${n}`);
    sh(tmp, 'clone', '-q', origin, other);
    commit(other, 'released.txt', 'decision feature\n', 'released');
    sh(other, 'push', '-q', 'origin', 'main');
    commit(dir, 'app.txt', 'old computer branch\n');
    const r = runner();
    refuses(() => deploy(dir, r), /not an ancestor of HEAD/, 'divergent origin/main refused');
    ok(r.external().length === 0, 'divergent: no checks or deploy ran');
    noLock(dir, 'divergent');
  }

  // Dirty tracked file and untracked file.
  {
    const { dir } = setup();
    writeFileSync(path.join(dir, 'app.txt'), 'edited\n');
    let r = runner();
    refuses(() => deploy(dir, r), /not clean before checks[\s\S]*app\.txt/, 'modified tracked file refused');
    noDeploy(r, 'dirty');
    sh(dir, 'checkout', '--', 'app.txt');
    writeFileSync(path.join(dir, 'new-module.ts'), 'export {}\n');
    r = runner();
    refuses(() => deploy(dir, r), /not clean before checks[\s\S]*new-module\.ts/, 'untracked file refused');
    ok(r.external().length === 0, 'untracked: nothing ran');
    noLock(dir, 'dirty');
  }

  // Failed fetch (unreachable origin) does not fall back to a stale origin/main.
  {
    const { dir } = setup();
    sh(dir, 'remote', 'set-url', 'origin', path.join(tmp, 'missing-origin.git'));
    const r = runner();
    refuses(() => deploy(dir, r), /fetching origin main failed/, 'failed fetch refused');
    ok(r.external().length === 0, 'failed fetch: nothing ran');
    noLock(dir, 'failed fetch');
  }

  // Failed check / failed test:cloudbite.
  for (const script of ['check', 'test:cloudbite']) {
    const { dir } = setup();
    const r = runner({ fail: { [script]: 1 } });
    refuses(() => deploy(dir, r), new RegExp(`npm run ${script} failed`), `failed ${script} refused`);
    noDeploy(r, `failed ${script}`);
    noLock(dir, `failed ${script}`);
  }

  // Failed wrangler surfaces as a refusal (non-zero exit).
  {
    const { dir } = setup();
    refuses(() => deploy(dir, runner({ fail: { wrangler: 1 } })), /wrangler deploy failed/, 'wrangler failure reported');
    noLock(dir, 'failed wrangler');
  }

  // Production state: read before checks and again right before upload; any change or bad read fails closed.
  {
    const { dir } = setup();
    let r = runner({ status: [STABLE, deployment('dep-2', [{ version_id: 'ver-b', percentage: 100 }])] });
    refuses(() => deploy(dir, r), /production deployment changed during checks[\s\S]*dep-1[\s\S]*dep-2/, 'remote deploy during checks refused');
    noDeploy(r, 'remote changed');
    ok(r.external().filter((a) => a[1] === 'deployments').length === 2 && r.external().some((a) => a[2] === 'test:cloudbite'), 'remote state read before and after the checks');
    noLock(dir, 'remote changed');
    const split = (a, b) => deployment('dep-1', [{ version_id: 'ver-a', percentage: a }, { version_id: 'ver-b', percentage: b }]);
    r = runner({ status: [split(50, 50), split(90, 10)] });
    refuses(() => deploy(dir, r), /changed during checks/, 'same deployment id with a changed split refused');
    noDeploy(r, 'split changed');
    r = runner({ status: [split(50, 50), deployment('dep-1', [{ version_id: 'ver-b', percentage: 50 }, { version_id: 'ver-a', percentage: 50 }])] });
    ok(deploy(dir, r).dryRun === false && r.external().at(-1)[1] === 'deploy', 'stable state (versions reordered) permits deploy');
    const bad = {
      'non-JSON': 'Not logged in', 'empty': '', 'array': '[]',
      'no id': JSON.stringify({ versions: [{ version_id: 'v', percentage: 100 }] }),
      'no versions': JSON.stringify({ id: 'd', versions: [] }),
      'string percentage': deployment('d', [{ version_id: 'v', percentage: '100' }]),
      'percentage out of range': deployment('d', [{ version_id: 'v', percentage: 150 }]),
      'missing version id': deployment('d', [{ percentage: 100 }]),
    };
    for (const [what, out] of Object.entries(bad)) {
      ok(canonicalDeployment(out) === null, `malformed state rejected: ${what}`);
      r = runner({ status: [out] });
      refuses(() => deploy(dir, r), /unexpected output before checks/, `malformed first read refused: ${what}`);
      ok(r.external().length === 1, `malformed first read (${what}): no checks, no deploy`);
    }
    r = runner({ status: [STABLE, 'garbage'] });
    refuses(() => deploy(dir, r), /unexpected output before upload/, 'malformed second read refused');
    noDeploy(r, 'malformed second read');
    for (const s of [{ status: 1 }, { status: null }]) {
      r = runner({ status: [s] });
      refuses(() => deploy(dir, r), /reading the production deployment before checks failed/, `unavailable state (exit ${s.status}) refused`);
      ok(r.external().length === 1, `unavailable state (exit ${s.status}): nothing else ran`);
      r = runner({ status: [STABLE, s] });
      refuses(() => deploy(dir, r), /before upload failed/, `unavailable state before upload (exit ${s.status}) refused`);
      noDeploy(r, 'unavailable before upload');
    }
    noLock(dir, 'remote state failures');
  }

  // Candidate changed during checks: new commit, or a dirtied file.
  {
    const { dir } = setup();
    let r = runner({ during: { 'test:cloudbite': () => commit(dir, 'app.txt', 'sneaky\n') } });
    refuses(() => deploy(dir, r), /HEAD moved from/, 'HEAD change during checks refused');
    noDeploy(r, 'HEAD moved');
    const { dir: dir2 } = setup();
    r = runner({ during: { check: () => writeFileSync(path.join(dir2, 'app.txt'), 'dirty\n') } });
    refuses(() => deploy(dir2, r), /not clean after checks/, 'worktree change during checks refused');
    noDeploy(r, 'dirtied during checks');
  }

  // No caller bypass of config/env/name/route; no npm-less start; wrong config target refused.
  {
    const { dir } = setup();
    for (const argv of [['--config', 'wrangler.jsonc'], ['--env', 'dev'], ['--name', 'gw-shinick'], ['--route', 'x.example'], ['--dry-run', '--force'], ['--config=wrangler.jsonc'], ['--recover-stale-lock=abc'], ['--recover-stale-lock']]) {
      const r = runner();
      refuses(() => deploy(dir, r, argv), /unsupported argument/, `argv ${argv.join(' ')} refused`);
      ok(r.calls.length === 0, `argv ${argv.join(' ')}: nothing ran`);
    }
    const r = runner();
    refuses(() => deploy(dir, r, [], { ...env, npm_execpath: '' }), /npm run deploy/, 'missing npm_execpath refused');
    noDeploy(r, 'no npm_execpath');
    commit(dir, CLOUDBITE_CONFIG, CONFIG.replace('cloudbite-v001', 'gw-shinick'));
    sh(dir, 'push', '-q', 'origin', 'main');
    const w = runner();
    refuses(() => deploy(dir, w), /expected cloudbite-v001/, 'config naming another Worker refused');
    ok(w.external().length === 0, 'wrong config: nothing ran');
  }

  // Not the worktree root (guard must judge the whole repository).
  {
    const { dir } = setup();
    const sub = path.join(dir, 'sub');
    mkdirSync(sub);
    refuses(() => deploy(sub, runner()), /not the root of its git worktree/, 'subdirectory repo refused');
  }

  // Deploy lock across worktrees, held by a real separate process: contention, refused recovery, release.
  {
    const { dir } = setup();
    const wt = path.join(tmp, `wt-${n}`);
    sh(dir, 'worktree', 'add', '-q', '-b', 'feature', wt);
    const common = path.join(dir, '.git');
    const h1 = holder(common);
    const first = await h1.next();
    ok(/^ACQUIRED [0-9a-f]{32}$/.test(first), `holder process acquired the lock: ${first}`);
    const token = first.split(' ')[1];
    const h2 = holder(common);
    const busy = await h2.next();
    ok(/^BUSY another Cloudbite deploy holds/.test(busy) && busy.includes(token), 'second process is refused while the lock is held');
    ok((await h2.exited).code === 3, 'contending process exits without the lock');
    for (const w of [dir, wt]) {
      const r = runner();
      refuses(() => deploy(w, r), new RegExp(`another Cloudbite deploy holds[\\s\\S]*recover-stale-lock=${token}`), `deploy from ${w === dir ? 'main' : 'second'} worktree refused while held`);
      ok(r.external().length === 0 && !r.calls.some((c) => c.git?.[0] === 'fetch'), 'contended deploy: no fetch, checks or wrangler');
    }
    refuses(() => deploy(dir, runner(), [`--recover-stale-lock=${'0'.repeat(32)}`]), /token does not match/, 'recovery with a wrong token refused');
    refuses(() => deploy(wt, runner(), [`--recover-stale-lock=${token}`]), /still running on this host/, 'recovery of a live holder refused');
    ok(existsSync(lockPath(dir)), 'refused recovery never deletes the active lock');
    h1.child.stdin.write('release\n');
    ok((await h1.next()) === 'RELEASED true', 'holder released its own lock');
    await h1.exited;
    noLock(dir, 'holder release');
    const r = runner();
    ok(deploy(wt, r).head === sh(wt, 'rev-parse', 'HEAD') && r.external().at(-1)[1] === 'deploy', 'second worktree deploys once the lock is free');
    noLock(dir, 'second worktree deploy');
  }

  // Crashed holder: the lock persists (no automatic stale removal) until explicit token recovery.
  {
    const { dir } = setup();
    const h = holder(path.join(dir, '.git'));
    const token = (await h.next()).split(' ')[1];
    h.child.kill('SIGKILL');
    await h.exited;
    let r = runner();
    refuses(() => deploy(dir, r), /another Cloudbite deploy holds/, 'dead holder lock still refuses without explicit recovery');
    ok(r.external().length === 0, 'dead holder: nothing ran');
    refuses(() => deploy(dir, runner(), [`--recover-stale-lock=${token}`, '--dry-run']), /must be used alone/, 'recovery combined with a deploy refused');
    r = runner();
    ok(deploy(dir, r, [`--recover-stale-lock=${token}`]).recovered === token && r.external().length === 0, 'explicit recovery removes a dead holder lock and deploys nothing');
    noLock(dir, 'recovered');
    refuses(() => deploy(dir, runner(), [`--recover-stale-lock=${token}`]), /no deploy lock/, 'recovery without a lock refused');
    ok(deploy(dir, runner()).dryRun === false, 'deploy proceeds after recovery');
    noLock(dir, 'after recovery');
  }

  // A holder whose lock was recovered never deletes the next holder's lock.
  {
    const { dir } = setup();
    const common = path.join(dir, '.git');
    const a = acquireDeployLock(common, { worktree: 'a', head: 'a' });
    recoverStaleLock(common, a.token, { isAlive: () => false });
    const b = acquireDeployLock(common, { worktree: 'b', head: 'b' });
    ok(a.release() === false && JSON.parse(readFileSync(path.join(lockPath(dir), 'owner.json'), 'utf8')).token === b.token, 'stale holder release leaves the new holder lock intact');
    ok(b.release() === true, 'new holder releases its lock');
    noLock(dir, 'replaced lock');
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
console.log(`cloudbite-deploy-guard: ${checks} checks passed`);
