# Cloudbite production deployment

`npm run deploy` is the standard production entry point. It runs `tools/deploy-cloudbite.mjs`, a fail-closed guard
added after a divergent, older Computer feature worktree was deployed over `main` and removed the released
decision, evidence and cross-review features.

## Usage

```
npm run deploy                 # verified real deploy of HEAD
npm run deploy -- --dry-run    # same guard; ends with `wrangler deploy --dry-run` (bundles, uploads nothing)
```

`--dry-run` is the only accepted argument. `--config`, `--env`, `--name`, `--route` and anything else are refused:
the target is always `wrangler.cloudbite.jsonc` (Worker `cloudbite-v001`). The legacy `wrangler.jsonc` /
`gw-shinick` is never used.

## What the guard checks, in order

1. The script runs from the root of its git worktree, and `wrangler.cloudbite.jsonc` names `cloudbite-v001`.
2. The worktree is clean (`git status --porcelain --untracked-files=all` empty). Ignored paths such as `.artifacts/`
   and `node_modules/` are fine; modified, staged or untracked files are refused.
3. HEAD is pinned to its full commit hash.
4. `git fetch --no-tags origin refs/heads/main:refs/remotes/origin/main` must succeed. A failed fetch is a refusal;
   there is no fallback to a stale local `origin/main`.
5. `origin/main` must be an ancestor of HEAD. A candidate that lacks released work on `main` is refused: merge or
   rebase onto the latest `main` first.
6. `npm run check` and `npm run test:cloudbite` (which includes the decision, evidence and cross-review suites) must
   pass. npm is invoked as `node <npm_execpath> run …`, so the guard must be started through `npm run deploy`.
7. HEAD and the worktree are re-checked: a commit or file change during the checks is refused.
8. Project-local Wrangler (`node_modules/wrangler`, never a global one) runs
   `wrangler deploy --config wrangler.cloudbite.jsonc --tag <hash[0:12]> --message "guarded deploy <hash>"`
   (`--dry-run` appended in dry-run mode). The Worker version is therefore labelled with the verified commit.

All subprocesses are argv arrays with no shell. The caller's environment (for example `CLOUDFLARE_API_TOKEN`) is
passed through to npm and Wrangler unchanged and is never printed. The guard never forces, resets, cleans, pushes or
changes namespaces; any refusal exits non-zero with the reason and nothing deployed.

## Limits

- The guard covers the standard entry point only. Running `npx wrangler deploy …` (or Wrangler from another
  checkout) directly is not technically prevented; operators must not do that for production.
- Ancestry is checked against `origin/main` at fetch time. Work pushed to `main` after the fetch, or released work
  that never reached `main`, is not detected.
- Environment variables that Wrangler itself reads are passed through as-is.

## Tests

`node test/cloudbite-deploy-guard.mjs` builds throwaway local git repositories and fakes npm/Wrangler: divergent
`origin/main`, dirty and untracked files, failed fetch/check/test/wrangler, candidate changed during checks, refused
arguments, wrong config name, and the exact commands for the normal and dry-run paths. No network or upload.
