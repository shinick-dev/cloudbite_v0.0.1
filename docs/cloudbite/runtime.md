# Cloudbite runtime (v0.0.1 first slice)

Owner: runtime worker. Implements `docs/cloudbite/api-contract.md` on top of the shared types in `src/cloudbite-contract.ts`.

## Modules

| File | Role |
|---|---|
| `src/cloudbite-api.ts` | HTTP surface: pages (`/`, `/cloudbite`, `/cloudbite/app.js`, `/cloudbite/style.css`), `/api/cloudbite/*`, `/p/_cloudbite/worker/*` |
| `src/cloudbite-project.ts` | `CloudbiteProject` Durable Object: one instance per project + one `registry` instance |
| `src/cloudbite-config.ts` | `CLOUDBITE_*` settings, readiness (names only), limits |
| `src/cloudbite-validate.ts` | brief, opinion/result, workspace-path and artifact-path validation |
| `src/cloudbite-daytona.ts` | Daytona REST via `src/lab.ts` `dt`/`download`, with deadlines and status-only errors |
| `src/cloudbite-inference.ts` | Nosana OpenAI-compatible `chat/completions`, bounded body reads |
| `src/cloudbite-runner.ts` | `runner.py` (Python 3 stdlib) uploaded into each sandbox |

Routing: `src/index.ts` calls `cloudbiteRoute` after the existing host checks and before the `/p/<provider>` proxy;
`src/public-get.ts` serves the console for `/` (previously a redirect to `/borrow`; `/borrow` itself is unchanged).

## Configuration (independent of gw-shinick)

Cloudbite never reads the providers stored in gw-shinick's `State` (`prov:daytona`, OpenRouter). It runs as its own
Worker, `wrangler.cloudbite.jsonc` (`cloudbite-v001`, `workers_dev` only, no routes, no shinick.dev hosts), with its own
`State` instance for admin sessions.

| Name | Kind | Purpose |
|---|---|---|
| `CLOUDBITE` | DO binding | `CloudbiteProject` |
| `CLOUDBITE_DAYTONA_API_URL` | var | Daytona API base (https) |
| `CLOUDBITE_DAYTONA_API_KEY` | secret | Daytona key for Cloudbite's organization |
| `CLOUDBITE_DAYTONA_SNAPSHOT` | var, optional | snapshot with `python3`; default Daytona image otherwise |
| `CLOUDBITE_NOSANA_BASE_URL` | var | OpenAI-compatible base, e.g. `…/v1` |
| `CLOUDBITE_NOSANA_API_KEY` | secret | Nosana key — server-side only |
| `CLOUDBITE_NOSANA_MODEL` | var | model id |
| `CLOUDBITE_GATEWAY_URL` | var | this Worker's workers.dev origin, reachable from sandboxes |
| `CLOUDBITE_ALLOW_HTTP` | dev var | `1` allows `http://localhost` URLs |
| `MASTER_KEY`, `SETUP_TOKEN` | secrets | existing State auth (register an admin key on this Worker) |

`GET /api/cloudbite/bootstrap` lists missing names; live creation returns 503 naming them. The persona catalogue is part of
readiness: while `CLOUDBITE_EXPERTS` is empty, live (and demo) creation is refused.

## Authority

- **Create** (`POST /api/cloudbite/projects`): exact `Origin == ORIGIN`, `application/json`, ≤ 16 KiB, then
  `x-admin-token` checked through `State.adminList` (storage reads only). 1–5 known experts. `requestId` maps
  deterministically to the project id; a retry returns the same project with a fresh access token (≤ 4), a different brief → 409.
- **Project access token** `cbt_…` (hash stored): read, cancel (strict Origin), artifact. 24 h retention, then purge.
- **Worker capability** `cbw_…`: one per expert, hash stored, 13 min expiry, revoked on completion/failure/cancel/timeout.
  Works only for `/p/_cloudbite/worker/<project>/<run>/{inference,activity,complete}`; requests with an `Origin` are refused.
  Inference: ≤ 48 KiB body, ≤ 32 messages, ≤ 8 calls per expert (reserved before the upstream call), one in flight,
  60 s timeout, `max_tokens` 1200, reply reduced to `{content}` ≤ 16 KiB. Upstream errors become a fixed message.
- **Global bound**: the `registry` instance allows 2 live projects at once; per project 3 experts provisioned/running at once.

## Execution

Alarm-driven state machine per expert: `queued → creating → booting → uploading → starting → running → collecting → final`.
Each step persists a claim id first and applies its result only if that claim is still current and the project is running.

- **creating**: a cleanup entry for the expert's unique `cloudbite-claim` label and a create-intent mark are written before
  `POST /sandbox`. A lost/5xx response is resolved by label lookup (3 tries); no second sandbox is created blindly.
- **uploading**: `buildExpertWorkspace()` files (validated: plain relative paths, ≤ 24 files, `PERSONA.md`/`PROJECT.md`/`WORKORDER.md`
  required) + `runner.py` + `.cloudbite/capability.json` into `/home/daytona/cloudbite` of that expert's own sandbox.
- **starting**: `timeout 600 python3 -I runner.py` in a Daytona session (idempotent via `out/.started`).
- **runner**: deletes the capability file after reading it; up to 6 model turns via the gateway; actions `python`
  (subprocess, 20 s, ./work, empty env), `write` (flat `out/<name>.(md|txt|json|csv)`, ≤ 4 files), `final` (validated opinion +
  report). Writes `out/result.json`, `out/report.md`, `out/manifest.json`, `out/done`; posts activity and `complete`.
- **running/collecting**: poll `out/done` every 15 s (or immediately after `complete`), download allowlisted files, validate
  `result.json` (`cloudbite.expert-result/v1`, matching expert, opinion schema). Malformed → `failed`, never `completed`.
- **cleanup**: delete only ids returned by our create or found under our exact labels; retries with backoff (8 tries, then
  `stuck`); Daytona `autoStopInterval 20 / autoDeleteInterval 30` minutes is the provider-side backstop.
- **cancel**: one atomic write sets project/experts cancelled and clears capability hashes; late inference returns 410,
  late callbacks 401, late outputs are not collected.

Demo mode (`mode: "demo"`, still admin-only on the server) never fetches; every activity row and opinion says `[demo]`
and no `sandboxId` is set. The public demo remains the browser-local UI simulation.

## Known limits

- Admin check uses `State.adminList` because this slice may not add State methods; a dedicated read-only
  `cloudbiteAdminCheck(token)` would be cheaper (proposed to the coordinator).
- Sandbox outputs (activity text, artifacts, opinion strings) are model-controlled data; the UI must render them as text.
- A step stuck longer than 3 minutes is taken over; its late effects are discarded by the claim check, but a stale upload can
  overwrite the capability file with a revoked one (the expert then fails honestly).
- Records are purged 24 h after creation (48 h if cleanup is still pending); stuck cleanup then relies on Daytona auto-delete.
- No live Daytona/Nosana call was made during implementation; request shapes follow `src/lab.ts` and the OpenAI chat API.
