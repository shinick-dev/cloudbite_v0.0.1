# Unified expert and Computer release

The decision/evidence workflow had reached main, but a later deployment from a divergent Computer worktree removed
it from production. Main now includes both histories: the decision workflow (`29f925f`), the Computer runtime
(`0e05c51`), and its subsequent deployed CLI/sign-in/image repair (`8f2b611`). No feature branch was force-pushed.

## Production

- Application: https://cloudbite.shinick.dev/cloudbite
- Personal computer: https://cloudbite.shinick.dev/cloudbite/computer
- Worker: `cloudbite-v001`, config `wrangler.cloudbite.jsonc`; the original `gw-shinick` and desktop gateway Worker were not deployed.
- Runtime commit: `8f059c5cb42151e2ad254fbd0d66261f8015872c`.
- Worker version: `7491aa74-6a6a-473b-8f55-484cc7233a32`, deployed 2026-10-19 07:49 KST.
- Existing eight Durable Object namespace bindings retained their IDs; secret binding names were unchanged.
- Latest existing Computer snapshot `cloudbite-computer-d2e6a902c06d` retained. No user VM was recreated or stopped.

Both public JS/CSS pairs matched the unified source byte for byte. Bootstrap returned 120 runnable roles,
Jev `jev-1.13.0` ready, and live providers ready. Unauthenticated Computer state returned 401 and the retired
workers.dev public API returned 410.

The raw Daytona create request now sends the VNC setting in `env`, the field shown in the
[official REST example](https://www.daytona.io/docs/en/sandboxes/#environment-variables). `envVars` is the SDK
option name. The exact request-body test covers this distinction.

## Validation

- `npm run check` passed; generated bundles and server/client TypeScript checks were current.
- `npm run test:cloudbite` passed through the guarded deployment: 19 expert/decision suites, the deployment-guard
  suite (63 checks), 11 Computer JS suites and four Python suites. Platform-dependent skips were reported.
- Independently executed Linux checks: sign-in 21/21 and installer 16/16 without skips; keyring boundary/idempotency
  checks passed. Display reported 35 checks with Selkies-dependent checks skipped because that package was absent.
- Independent Claude review accepted the initial combined runtime and guard at `d89bc85`; the coordinator reviewed
  the subsequent, already-deployed Computer delta and independently checked the fresh Claude REST-field repair.
- Actual approved-visitor test: a synthetic Falsify planning brief, structured decision fields and one 337-character
  Markdown file reached the saved project. Both selected experts completed in separate Daytona sandboxes.
- The ledger contained nine claims, five structurally linked. The opt-in Nosana cross-review produced two reports
  and eight findings. Original expert opinions, statuses and confidence values stayed unchanged.
- KO/EN switching retained the inputs and attached document; the saved history displayed the review in read-only mode.
- All three Daytona accounts had zero sandboxes labelled for this synthetic test project; direct owning-account
  sandbox reads returned 404. Only this test history was deleted: absent from the index, detail returned 404.
- The Computer page rendered its passkey login screen after deployment. No actual phone biometric/OAuth login or
  new persistent Computer start was performed during this integration.

Detailed local evidence is under `.artifacts/release-unify/` (ignored): release/review/native receipts, final deployment
log, Linux checks, production metadata, bundle hashes, actual run, deletion and sandbox-cleanup records.

## Remaining limits

Text uploads support TXT/MD/CSV/JSON, not PDF/OCR, repositories or automatic external literature retrieval.
Cross-review is bounded to three reviewers and three peers each, not all-to-all review. Source-ID presence is
not entailment, factual verification or calibrated accuracy; confidence remains the model's self-assessment.

The separate legacy `auth-router-parity` suite has four pre-existing SETUP_TOKEN parity failures reported and
reproduced at ancestor `e09a009` by the Computer auditor. That suite is outside this release's affected regression
set; this integration does not claim every historical repository test is green.

Use `npm run deploy` from a clean checkout containing latest main. It fetches main, refuses missing ancestry or dirty
source, runs both feature sets' regressions and labels the deployment with the verified commit. It does not prevent
direct Wrangler calls or act as a distributed deployment lock. A concurrent Computer deployment observed during
this release was preserved and merged before the final upload; do not deploy an older isolated worktree over it.
