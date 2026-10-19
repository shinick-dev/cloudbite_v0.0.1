# Cloudbite production deployment

`npm run deploy` is the standard production entry point. It runs `tools/deploy-cloudbite.mjs`, a fail-closed guard
added after a divergent, older Computer feature worktree was deployed over `main` and removed the released
decision, evidence and cross-review features. It was later strengthened after a concurrent Computer deploy landed
while another worktree was still running its long checks: `main` ancestry alone did not see that deploy.

## Usage

```
npm run deploy                                   # verified real deploy of HEAD
npm run deploy -- --dry-run                      # same guard; ends with `wrangler deploy --dry-run` (bundles, uploads nothing)
npm run deploy -- --recover-stale-lock=<token>   # remove a confirmed-dead holder's deploy lock; deploys nothing
```

`--dry-run` and `--recover-stale-lock=<token>` (alone) are the only accepted arguments. `--config`, `--env`, `--name`,
`--route` and anything else are refused: the target is always `wrangler.cloudbite.jsonc` (Worker `cloudbite-v001`).
The legacy `wrangler.jsonc` / `gw-shinick` is never used.

## What the guard checks, in order

1. The script runs from the root of its git worktree, and `wrangler.cloudbite.jsonc` names `cloudbite-v001`.
2. HEAD is pinned to its full commit hash.
3. The deploy lock is taken (see below). Everything after this runs while holding it, and the lock is released in a
   `finally`, on success and on every refusal.
4. The worktree is clean (`git status --porcelain --untracked-files=all` empty). Ignored paths such as `.artifacts/`
   and `node_modules/` are fine; modified, staged or untracked files are refused.
5. `git fetch --no-tags origin refs/heads/main:refs/remotes/origin/main` must succeed. A failed fetch is a refusal;
   there is no fallback to a stale local `origin/main`.
6. `origin/main` must be an ancestor of HEAD. A candidate that lacks released work on `main` is refused: merge or
   rebase onto the latest `main` first.
7. Real deploy only: project-local Wrangler reads the production state with
   `wrangler deployments status --config wrangler.cloudbite.jsonc --json`.
8. `npm run check` and `npm run test:cloudbite` (which includes the decision, evidence, cross-review, deployment guard,
   and personal computer suites) must pass. npm is invoked as `node <npm_execpath> run …`, so the guard must be
   started through `npm run deploy`.
9. HEAD and the worktree are re-checked: a commit or file change during the checks is refused.
10. Real deploy only: the production state is read again immediately before upload and must equal the first read.
11. Project-local Wrangler (`node_modules/wrangler`, never a global one) runs
    `wrangler deploy --config wrangler.cloudbite.jsonc --tag <hash[0:12]> --message "guarded deploy <hash>"`
    (`--dry-run` appended in dry-run mode). The Worker version is therefore labelled with the verified commit.

All subprocesses are argv arrays with no shell. The caller's environment (for example `CLOUDFLARE_API_TOKEN`) is
passed through to npm and Wrangler unchanged and is never printed. The guard never forces, resets, cleans, pushes or
changes namespaces; any refusal exits non-zero with the reason and nothing deployed.

## Deploy lock (local serialization)

The lock is the directory `cloudbite-deploy.lock` inside the git **common** directory
(`git rev-parse --git-common-dir`, i.e. the main clone's `.git`), so every worktree of one clone shares it. It is
created atomically: an `owner.json` (token, pid, host, worktree, candidate, start time) is written into a private
staging directory that is then renamed onto the lock path; the rename fails if a lock already exists. A second deploy
fails at once with the holder's details and nothing else runs (no fetch, checks or Wrangler).

Release only removes the lock while its `owner.json` still carries the releasing process's token, so a process never
deletes a lock that another process now holds.

A crashed holder (killed terminal, power loss) leaves the lock behind; the guard does **not** remove it automatically,
because a recorded pid is not proof of anything: another host, pid reuse or a different user make it unreliable. To
recover, first confirm the holder is really gone, then run
`npm run deploy -- --recover-stale-lock=<token>` with the token quoted in the refusal message. Recovery refuses when the
token does not match the current lock, or when the holder's host is this machine and its pid is still running. It
removes the lock and deploys nothing; start the deploy again afterwards.

Scope: the lock serializes standard `npm run deploy` runs from worktrees of the **same clone on the same disk**. It does
not see other clones, other machines, GitHub Actions runs or direct Wrangler calls. It is not a distributed lock.

## Production state check (remote)

For a real deploy, `wrangler deployments status --json` output is reduced to a canonical form: the deployment `id` plus
the sorted `version_id=percentage` tuples. The two reads (before the checks and just before upload) must be identical;
a changed deployment id or traffic split means someone else deployed meanwhile, and the guard stops without uploading.
A non-zero Wrangler exit, missing credentials, a Worker without deployments, or output that is not that JSON shape also
stops the deploy (fail closed). The JSON is captured and never printed (it also carries the deploying author's
e-mail); only the canonical id/version form is logged. No secret value is read.

`--dry-run` skips both remote reads, so it needs no Cloudflare credentials beyond what `wrangler deploy --dry-run` needs.

This narrows the race but does not eliminate it: a deploy that lands between the second read and the upload is not
detected, and nothing stops a direct `wrangler deploy` from elsewhere.

## Manual GitHub Actions deploy

`.github/workflows/cloudbite-production.yml` runs the same guard on GitHub-hosted runners:

- `workflow_dispatch` only (no push, pull-request or schedule trigger), and the job is skipped unless the selected ref
  is `refs/heads/main`.
- `concurrency: cloudbite-production` with `cancel-in-progress: false`: dispatched runs queue instead of overlapping or
  cancelling a deploy in progress.
- `permissions: contents: read`; actions pinned to commit SHAs; Node `24.19.0` and Python `3.12.10` pinned to the
  versions the project is developed with; full-history checkout (`fetch-depth: 0`) for the ancestry check;
  `npm ci`, then `npm run deploy` with the same lock, remote-state and test checks.
- A first step fails with a clear `::error::` when the repository secret `CLOUDFLARE_API_TOKEN` or
  `CLOUDFLARE_ACCOUNT_ID` is not configured. Values are never echoed.

Operator setup: an administrator must add those two repository secrets (Settings → Secrets and variables → Actions)
with a token scoped to deploy Workers on the Cloudbite account. Nothing in this repository sets them. GitHub's
concurrency group only serializes runs of this workflow; it cannot stop local `npm run deploy` runs or direct
Wrangler calls, which remain an operator rule. The workflow has not been run as part of adding it.

## Limits

- The guard covers the standard entry point only. Running `npx wrangler deploy …` (or Wrangler from another
  checkout) directly is not technically prevented; operators must not do that for production.
- Ancestry is checked against `origin/main` at fetch time. Work pushed to `main` after the fetch, or released work
  that never reached `main`, is not detected; the production state check catches a deploy made during the checks,
  but not one in the final moment before upload.
- The deploy lock is per clone (see above).
- Environment variables that Wrangler itself reads are passed through as-is.

`npm run test:cloudbite:computer` runs the eleven Computer JavaScript suites plus the Python display, installer,
sign-in and keyring checks. Python uses `-B` so testing does not leave bytecode files that would dirty the release worktree. The display
test reports skipped Selkies checks when that package is absent; the installer reports platform-specific skips.

The [unified release acceptance](unified-release.md) records the restored workflow, preserved Computer release,
production version, actual expert/cross-review checks and remaining verification limits.

## Tests

`node test/cloudbite-deploy-guard.mjs` builds throwaway local git repositories and fakes npm/Wrangler: divergent
`origin/main`, dirty and untracked files, failed fetch/check/test/wrangler, candidate changed during checks, refused
arguments, wrong config name, and the exact commands for the normal and dry-run paths. It also covers the production
state check (changed deployment or split blocks the upload, reordered stable state passes, malformed/unavailable
output fails closed, dry-run reads nothing remote, the JSON is never logged) and the deploy lock with real separate
processes (contention from a second process and from a second worktree, refused recovery of a live holder or wrong
token, release, crashed-holder recovery, a recovered holder not deleting the next lock), plus static checks of the
workflow triggers, concurrency, permissions and pins. No network or upload.
