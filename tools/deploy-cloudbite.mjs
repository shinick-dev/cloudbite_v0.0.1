#!/usr/bin/env node
// Guarded Cloudbite production deploy: the only path behind `npm run deploy`.
// Fail-closed: clean worktree, fresh origin/main contained in HEAD, check + test:cloudbite green,
// candidate unchanged afterwards, then project-local Wrangler with the exact Cloudbite config.
//   npm run deploy                 (real deploy of the verified commit)
//   npm run deploy -- --dry-run    (same guard, `wrangler deploy --dry-run`: bundles, uploads nothing)
// Docs: docs/cloudbite/deployment.md. Direct `wrangler deploy` calls bypass this guard.
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CLOUDBITE_CONFIG = 'wrangler.cloudbite.jsonc';
export const CLOUDBITE_WORKER = 'cloudbite-v001';
export const REQUIRED_SCRIPTS = ['check', 'test:cloudbite'];

export class DeployGuardError extends Error {}

const fail = (message) => { throw new DeployGuardError(message); };

// Default runner: argv arrays only, never a shell. Git output is captured; npm/wrangler stream to the terminal.
export function spawnRunner(cmd, args, { cwd, env, capture }) {
  const r = spawnSync(cmd, args, { cwd, env, shell: false, windowsHide: true, encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
  return { status: r.error ? null : r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error };
}

export function parseArgs(argv) {
  let dryRun = false;
  for (const a of argv) {
    if (a === '--dry-run') dryRun = true;
    else fail(`unsupported argument ${JSON.stringify(a)}: only --dry-run is accepted (config, env, name and routes are fixed to ${CLOUDBITE_CONFIG})`);
  }
  return { dryRun };
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

/**
 * Runs the full guard and the final wrangler call. Throws DeployGuardError on any refusal.
 * @param {{ repo: string, argv?: string[], env?: NodeJS.ProcessEnv, run?: typeof spawnRunner,
 *   nodePath?: string, wranglerBin?: string, log?: (line: string) => void }} opts
 */
export function deployCloudbite({ repo, argv = [], env = process.env, run = spawnRunner, nodePath = process.execPath, wranglerBin, log = () => {} }) {
  const { dryRun } = parseArgs(argv);
  const git = (args, what) => {
    const r = run('git', args, { cwd: repo, env, capture: true });
    if (r.status !== 0) fail(`${what} failed (git ${args.join(' ')} exited ${r.status ?? 'without starting'})${r.stderr ? `: ${r.stderr.trim()}` : ''}`);
    return r.stdout.trim();
  };
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

  const top = git(['rev-parse', '--show-toplevel'], 'locating the git worktree');
  if (!samePath(top, repo)) fail(`${repo} is not the root of its git worktree (${top})`);
  verifyConfig(repo);
  assertClean('before checks');
  const head = git(['rev-parse', '--verify', 'HEAD^{commit}'], 'resolving HEAD');
  if (!/^[0-9a-f]{40}$/.test(head)) fail(`unexpected HEAD ${JSON.stringify(head)}`);

  log(`fetching origin main for candidate ${head}`);
  git(['fetch', '--no-tags', 'origin', 'refs/heads/main:refs/remotes/origin/main'], 'fetching origin main');
  const main = git(['rev-parse', '--verify', 'refs/remotes/origin/main^{commit}'], 'resolving origin/main');
  if (!isAncestor(main, head)) fail(`origin/main ${main} is not an ancestor of HEAD ${head}: merge or rebase onto the latest main first; deploying would drop released work`);

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

  const bin = wranglerBin ?? resolveWrangler(repo);
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
    const { head, dryRun } = deployCloudbite({ repo, argv: process.argv.slice(2), log: (line) => console.log(`deploy-cloudbite: ${line}`) });
    console.log(`deploy-cloudbite: ${dryRun ? 'dry run complete (nothing uploaded)' : 'deployed'} ${head}`);
  } catch (e) {
    console.error(`deploy-cloudbite: ${e instanceof DeployGuardError ? e.message : (e?.stack ?? e)}`);
    process.exitCode = 1;
  }
}
