#!/usr/bin/env node
// Guarded Cloudbite production deploy: the only path behind `npm run deploy`.
// Fail-closed: clean worktree, one deploy at a time per clone (lock in the git common dir),
// fresh origin/main contained in HEAD, production deployment state read before the checks,
// check + test:cloudbite green, candidate and production state unchanged afterwards,
// then project-local Wrangler with the exact Cloudbite config.
//   npm run deploy                 (real deploy of the verified commit)
//   npm run deploy -- --dry-run    (same guard, `wrangler deploy --dry-run`: bundles, uploads nothing, reads no remote state)
//   npm run deploy -- --recover-stale-lock=<token>   (removes a confirmed-dead holder's lock; deploys nothing)
// Docs: docs/cloudbite/deployment.md. Direct `wrangler deploy` calls bypass this guard.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CLOUDBITE_CONFIG = 'wrangler.cloudbite.jsonc';
export const CLOUDBITE_WORKER = 'cloudbite-v001';
export const REQUIRED_SCRIPTS = ['check', 'test:cloudbite'];
export const LOCK_NAME = 'cloudbite-deploy.lock';

export class DeployGuardError extends Error {}

const fail = (message) => { throw new DeployGuardError(message); };

// Default runner: argv arrays only, never a shell. Git and remote-state output is captured; npm/wrangler deploy stream to the terminal.
export function spawnRunner(cmd, args, { cwd, env, capture }) {
  const r = spawnSync(cmd, args, { cwd, env, shell: false, windowsHide: true, encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
  return { status: r.error ? null : r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error };
}

export function parseArgs(argv) {
  let dryRun = false;
  let recoverToken = null;
  for (const a of argv) {
    const m = /^--recover-stale-lock=([0-9a-f]{32})$/.exec(a);
    if (a === '--dry-run') dryRun = true;
    else if (m && recoverToken === null) recoverToken = m[1];
    else fail(`unsupported argument ${JSON.stringify(a)}: only --dry-run or --recover-stale-lock=<token> is accepted (config, env, name and routes are fixed to ${CLOUDBITE_CONFIG})`);
  }
  if (recoverToken && argv.length !== 1) fail('--recover-stale-lock=<token> must be used alone; it only removes a stale lock and deploys nothing');
  return { dryRun, recoverToken };
}

const samePath = (a, b) => {
  const norm = (p) => { const r = realpathSync.native(path.resolve(p)); return process.platform === 'win32' ? r.toLowerCase() : r; };
  return norm(a) === norm(b);
};

export function resolveWrangler(repo) {
  const req = createRequire(path.join(repo, 'package.json'));
  let pkgPath;
  try { pkgPath = req.resolve('wrangler/package.json'); } catch { fail('project-local wrangler is not installed (npm install); refusing to use a global wrangler'); }
  const bin = JSON.parse(readFileSync(pkgPath, 'utf8')).bin?.wrangler;
  if (typeof bin !== 'string') fail(`wrangler package at ${pkgPath} has no wrangler bin`);
  return path.join(path.dirname(pkgPath), bin);
}

export function verifyConfig(repo) {
  let text;
  try { text = readFileSync(path.join(repo, CLOUDBITE_CONFIG), 'utf8'); } catch { fail(`${CLOUDBITE_CONFIG} is missing`); }
  const names = [...text.matchAll(/^\s*"name"\s*:\s*"([^"]*)"/gm)].map((m) => m[1]);
  if (names[0] !== CLOUDBITE_WORKER) fail(`${CLOUDBITE_CONFIG} top-level name is ${JSON.stringify(names[0] ?? null)}, expected ${CLOUDBITE_WORKER}`);
}

// Deploy lock: a directory under the git common dir, so every worktree of one clone shares it. It is published
// atomically by renaming a fully written staging directory and never removed unless its token matches.
// It serializes standard deploys of one clone only: other clones, machines, CI runs and direct Wrangler calls
// do not see it. A recorded pid is not proof of liveness across hosts or pid reuse, so recovery is manual.
const readOwner = (dir) => { try { return JSON.parse(readFileSync(path.join(dir, 'owner.json'), 'utf8')); } catch { return null; } };
const describeOwner = (o) => (o ? `pid ${o.pid} on ${o.host}, worktree ${o.worktree}, candidate ${o.head}, since ${o.startedAt}, token ${o.token}` : 'owner record unreadable');

export function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

export function acquireDeployLock(commonDir, info = {}) {
  const lockDir = path.join(commonDir, LOCK_NAME);
  const token = randomBytes(16).toString('hex');
  const owner = { token, pid: process.pid, host: os.hostname(), startedAt: new Date().toISOString(), ...info };
  const staging = `${lockDir}.acquire-${token}`;
  mkdirSync(staging);
  try {
    writeFileSync(path.join(staging, 'owner.json'), `${JSON.stringify(owner, null, 2)}\n`, { flag: 'wx' });
    try { renameSync(staging, lockDir); } catch (e) {
      if (!existsSync(lockDir)) fail(`could not create deploy lock ${lockDir} (${e.code ?? e.message}); nothing was deployed`);
      const held = readOwner(lockDir);
      fail(`another Cloudbite deploy holds ${lockDir} (${describeOwner(held)}); nothing was deployed. Wait for it to finish. `
        + `Only once you have confirmed that process is gone, remove the lock with: npm run deploy -- --recover-stale-lock=${held?.token ?? '<token>'}`);
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  let done = false;
  return {
    lockDir,
    token,
    /** Removes the lock only while it is still ours; returns false when it was recovered or replaced meanwhile. */
    release() {
      if (done) return false;
      done = true;
      if (readOwner(lockDir)?.token !== token) return false;
      const trash = `${lockDir}.release-${token}`;
      renameSync(lockDir, trash);
      if (readOwner(trash)?.token !== token) { renameSync(trash, lockDir); return false; }
      rmSync(trash, { recursive: true, force: true });
      return true;
    },
  };
}

/** Explicit stale-lock recovery: the caller quotes the holder's exact token, and a live same-host pid refuses. */
export function recoverStaleLock(commonDir, token, { isAlive = pidAlive } = {}) {
  const lockDir = path.join(commonDir, LOCK_NAME);
  if (!existsSync(lockDir)) fail(`no deploy lock at ${lockDir}; nothing to recover`);
  const held = readOwner(lockDir);
  if (!held) fail(`deploy lock ${lockDir} has no readable owner record; inspect it and move it aside by hand`);
  if (held.token !== token) fail(`token does not match the current lock (${describeOwner(held)}); nothing was recovered`);
  if (held.host === os.hostname() && isAlive(held.pid)) fail(`lock holder pid ${held.pid} is still running on this host; nothing was recovered`);
  const moved = `${lockDir}.stale-${token}`;
  renameSync(lockDir, moved);
  if (readOwner(moved)?.token !== token) {
    try { renameSync(moved, lockDir); } catch { fail(`the lock changed during recovery and could not be put back; it is at ${moved}`); }
    fail('the lock changed during recovery; it was put back and nothing was recovered');
  }
  rmSync(moved, { recursive: true, force: true });
  return held;
}

/**
 * Canonical production state from `wrangler deployments status --json`: deployment id plus sorted
 * version_id=percentage tuples, or null when the output is not that shape.
 */
export function canonicalDeployment(stdout) {
  let d;
  try { d = JSON.parse(stdout); } catch { return null; }
  if (!d || typeof d !== 'object' || typeof d.id !== 'string' || !d.id || !Array.isArray(d.versions) || d.versions.length === 0) return null;
  const tuples = [];
  for (const v of d.versions) {
    if (!v || typeof v.version_id !== 'string' || !v.version_id) return null;
    if (typeof v.percentage !== 'number' || !Number.isFinite(v.percentage) || v.percentage < 0 || v.percentage > 100) return null;
    tuples.push(`${v.version_id}=${v.percentage}`);
  }
  return `${d.id} [${tuples.sort().join(', ')}]`;
}

/**
 * Runs the full guard and the final wrangler call. Throws DeployGuardError on any refusal.
 * @param {{ repo: string, argv?: string[], env?: NodeJS.ProcessEnv, run?: typeof spawnRunner,
 *   nodePath?: string, wranglerBin?: string, log?: (line: string) => void }} opts
 */
export function deployCloudbite({ repo, argv = [], env = process.env, run = spawnRunner, nodePath = process.execPath, wranglerBin, log = () => {} }) {
  const { dryRun, recoverToken } = parseArgs(argv);
  const git = (args, what) => {
    const r = run('git', args, { cwd: repo, env, capture: true });
    if (r.status !== 0) fail(`${what} failed (git ${args.join(' ')} exited ${r.status ?? 'without starting'})${r.stderr ? `: ${r.stderr.trim()}` : ''}`);
    return r.stdout.trim();
  };

  const top = git(['rev-parse', '--show-toplevel'], 'locating the git worktree');
  if (!samePath(top, repo)) fail(`${repo} is not the root of its git worktree (${top})`);
  const commonDir = path.resolve(repo, git(['rev-parse', '--path-format=absolute', '--git-common-dir'], 'locating the git common directory'));
  if (recoverToken) {
    const held = recoverStaleLock(commonDir, recoverToken);
    log(`removed stale deploy lock of pid ${held.pid} on ${held.host} (candidate ${held.head})`);
    return { recovered: held.token };
  }
  verifyConfig(repo);
  const head = git(['rev-parse', '--verify', 'HEAD^{commit}'], 'resolving HEAD');
  if (!/^[0-9a-f]{40}$/.test(head)) fail(`unexpected HEAD ${JSON.stringify(head)}`);

  const lock = acquireDeployLock(commonDir, { worktree: repo, head, dryRun });
  log(`holding deploy lock ${lock.lockDir}`);
  try {
    return guardedDeploy({ repo, env, run, nodePath, wranglerBin, log, dryRun, head, git });
  } finally {
    if (!lock.release()) log(`deploy lock ${lock.lockDir} was no longer ours; left it in place`);
  }
}

function guardedDeploy({ repo, env, run, nodePath, wranglerBin, log, dryRun, head, git }) {
  const isAncestor = (anc, desc) => {
    const r = run('git', ['merge-base', '--is-ancestor', anc, desc], { cwd: repo, env, capture: true });
    if (r.status === 0) return true;
    if (r.status === 1) return false;
    fail(`git merge-base --is-ancestor failed (exit ${r.status ?? 'without starting'})${r.stderr ? `: ${r.stderr.trim()}` : ''}`);
  };
  const assertClean = (when) => {
    const dirty = git(['status', '--porcelain=v1', '--untracked-files=all'], `git status ${when}`);
    if (dirty) fail(`worktree is not clean ${when}; commit or move these first (nothing was deployed):\n${dirty}`);
  };

  assertClean('before checks');
  log(`fetching origin main for candidate ${head}`);
  git(['fetch', '--no-tags', 'origin', 'refs/heads/main:refs/remotes/origin/main'], 'fetching origin main');
  const main = git(['rev-parse', '--verify', 'refs/remotes/origin/main^{commit}'], 'resolving origin/main');
  if (!isAncestor(main, head)) fail(`origin/main ${main} is not an ancestor of HEAD ${head}: merge or rebase onto the latest main first; deploying would drop released work`);

  const bin = wranglerBin ?? resolveWrangler(repo);
  // Production state (deployment id + version split). Captured and never printed: the JSON also carries the author email.
  const remoteState = (when) => {
    const r = run(nodePath, [bin, 'deployments', 'status', '--config', CLOUDBITE_CONFIG, '--json'], { cwd: repo, env, capture: true });
    if (r.status !== 0) fail(`reading the production deployment ${when} failed (wrangler deployments status exited ${r.status ?? 'without starting'}); nothing was deployed. Diagnose with: npx wrangler deployments status --config ${CLOUDBITE_CONFIG}`);
    const state = canonicalDeployment(r.stdout);
    if (!state) fail(`wrangler deployments status returned unexpected output ${when}; nothing was deployed`);
    return state;
  };
  let before = null;
  if (!dryRun) {
    before = remoteState('before checks');
    log(`production deployment before checks: ${before}`);
  }

  const npmCli = env.npm_execpath;
  if (!npmCli || !/\.[cm]?js$/i.test(npmCli)) fail('npm_execpath is not set to npm-cli.js: start this through `npm run deploy`');
  for (const script of REQUIRED_SCRIPTS) {
    log(`npm run ${script}`);
    const r = run(nodePath, [npmCli, 'run', script], { cwd: repo, env, capture: false });
    if (r.status !== 0) fail(`npm run ${script} failed (exit ${r.status ?? 'without starting'}); nothing was deployed`);
  }

  const after = git(['rev-parse', '--verify', 'HEAD^{commit}'], 're-resolving HEAD');
  if (after !== head) fail(`HEAD moved from ${head} to ${after} during checks; nothing was deployed`);
  assertClean('after checks');

  if (!dryRun) {
    const now = remoteState('before upload');
    if (now !== before) fail(`production deployment changed during checks (was ${before}, now ${now}): someone else deployed; nothing was deployed. Re-run on top of the latest main`);
  }
  const wranglerArgs = [bin, 'deploy', '--config', CLOUDBITE_CONFIG, '--tag', head.slice(0, 12), '--message', `guarded deploy ${head}`];
  if (dryRun) wranglerArgs.push('--dry-run');
  log(`${dryRun ? 'dry-run ' : ''}wrangler deploy --config ${CLOUDBITE_CONFIG} for ${head}`);
  const r = run(nodePath, wranglerArgs, { cwd: repo, env, capture: false });
  if (r.status !== 0) fail(`wrangler deploy${dryRun ? ' --dry-run' : ''} failed (exit ${r.status ?? 'without starting'})`);
  return { head, main, dryRun };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  try {
    const res = deployCloudbite({ repo, argv: process.argv.slice(2), log: (line) => console.log(`deploy-cloudbite: ${line}`) });
    if (res.recovered) console.log('deploy-cloudbite: stale lock removed; nothing was deployed');
    else console.log(`deploy-cloudbite: ${res.dryRun ? 'dry run complete (nothing uploaded)' : 'deployed'} ${res.head}`);
  } catch (e) {
    console.error(`deploy-cloudbite: ${e instanceof DeployGuardError ? e.message : (e?.stack ?? e)}`);
    process.exitCode = 1;
  }
}
