// Guarded production deploy (tools/deploy-cloudbite.mjs) against throwaway local git repos.
// Real git for repository state; npm and wrangler are faked, so nothing builds, uploads or touches the network.
// Run: node test/cloudbite-deploy-guard.mjs
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deployCloudbite, spawnRunner, DeployGuardError, CLOUDBITE_CONFIG } from '../tools/deploy-cloudbite.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let checks = 0;
const ok = (cond, message) => { assert.ok(cond, message); checks++; };

const pkg = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
ok(pkg.scripts.deploy === 'node tools/deploy-cloudbite.mjs', 'npm run deploy routes through the guard only');
ok(!/wrangler\.jsonc|gw-shinick/.test(readFileSync(path.join(repoRoot, 'tools/deploy-cloudbite.mjs'), 'utf8').replace(/wrangler\.cloudbite\.jsonc/g, '')), 'guard never names the legacy config');

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
// Fake runner: real git, recorded npm/wrangler with scriptable outcomes.
function runner({ fail = {}, during } = {}) {
  const calls = [];
  const run = (cmd, args, opts) => {
    if (cmd === 'git') { const r = spawnRunner(cmd, args, { ...opts, env: { ...opts.env, ...gitEnv } }); calls.push({ git: args, status: r.status }); return r; }
    ok(cmd === NODE && opts.capture === false, `non-git commands run via the node binary without a shell: ${cmd}`);
    calls.push({ cmd, args, env: opts.env });
    const key = args[0] === NPM ? args[2] : 'wrangler';
    if (args[0] === NPM && during?.[key]) during[key]();
    return { status: fail[key] ?? 0, stdout: '', stderr: '' };
  };
  return { run, calls, external: () => calls.filter((c) => c.cmd).map((c) => c.args) };
}
const env = { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, npm_execpath: NPM, CLOUDFLARE_API_TOKEN: 'secret-token-value' };
const deploy = (dir, r, argv = [], e = env) => deployCloudbite({ repo: dir, argv, env: e, run: r.run, nodePath: NODE, wranglerBin: WRANGLER });
const refuses = (fn, re, message) => {
  try { fn(); } catch (e) { ok(e instanceof DeployGuardError && re.test(e.message), `${message}: ${e.message}`); return; }
  assert.fail(`${message}: expected refusal`);
};
const noDeploy = (r, message) => ok(!r.external().some((a) => a[0] === WRANGLER), `${message}: wrangler never ran`);

try {
  // Normal path: exact command sequence, verified hash tag/message, caller env (secrets) passed through untouched.
  {
    const { dir } = setup();
    const head = sh(dir, 'rev-parse', 'HEAD');
    const r = runner();
    const res = deploy(dir, r);
    ok(res.head === head && res.main === head && res.dryRun === false, 'normal deploy reports the verified candidate');
    assert.deepEqual(r.external(), [
      [NPM, 'run', 'check'],
      [NPM, 'run', 'test:cloudbite'],
      [WRANGLER, 'deploy', '--config', 'wrangler.cloudbite.jsonc', '--tag', head.slice(0, 12), '--message', `guarded deploy ${head}`],
    ]); checks++;
    ok(r.calls.filter((c) => c.cmd).every((c) => c.env.CLOUDFLARE_API_TOKEN === 'secret-token-value'), 'secrets reach npm/wrangler unchanged');
    ok(r.calls.some((c) => c.git?.join(' ') === 'fetch --no-tags origin refs/heads/main:refs/remotes/origin/main'), 'fetches origin main explicitly');
    // Ignored paths are fine; dry-run appends --dry-run and nothing else.
    mkdirSync(path.join(dir, '.artifacts'));
    writeFileSync(path.join(dir, '.artifacts', 'note.json'), 'ignored');
    mkdirSync(path.join(dir, 'node_modules'));
    writeFileSync(path.join(dir, 'node_modules', 'x.js'), 'ignored');
    const d = runner();
    ok(deploy(dir, d, ['--dry-run']).dryRun === true, 'dry-run accepted with ignored files present');
    assert.deepEqual(d.external().at(-1), [WRANGLER, 'deploy', '--config', 'wrangler.cloudbite.jsonc', '--tag', head.slice(0, 12), '--message', `guarded deploy ${head}`, '--dry-run']); checks++;
    ok(d.external().length === 3, 'dry-run still runs check and test:cloudbite');
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
  }

  // Failed fetch (unreachable origin) does not fall back to a stale origin/main.
  {
    const { dir } = setup();
    sh(dir, 'remote', 'set-url', 'origin', path.join(tmp, 'missing-origin.git'));
    const r = runner();
    refuses(() => deploy(dir, r), /fetching origin main failed/, 'failed fetch refused');
    ok(r.external().length === 0, 'failed fetch: nothing ran');
  }

  // Failed check / failed test:cloudbite.
  for (const script of ['check', 'test:cloudbite']) {
    const { dir } = setup();
    const r = runner({ fail: { [script]: 1 } });
    refuses(() => deploy(dir, r), new RegExp(`npm run ${script} failed`), `failed ${script} refused`);
    noDeploy(r, `failed ${script}`);
  }

  // Failed wrangler surfaces as a refusal (non-zero exit).
  {
    const { dir } = setup();
    refuses(() => deploy(dir, runner({ fail: { wrangler: 1 } })), /wrangler deploy failed/, 'wrangler failure reported');
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
    for (const argv of [['--config', 'wrangler.jsonc'], ['--env', 'dev'], ['--name', 'gw-shinick'], ['--route', 'x.example'], ['--dry-run', '--force'], ['--config=wrangler.jsonc']]) {
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
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
console.log(`cloudbite-deploy-guard: ${checks} checks passed`);
