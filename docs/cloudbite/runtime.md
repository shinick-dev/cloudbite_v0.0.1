# Cloudbite runtime (v0.0.1 first slice)

Owner: runtime worker. Implements `docs/cloudbite/api-contract.md` on top of the shared types in `src/cloudbite-contract.ts`.

## Modules

| File | Role |
|---|---|
| `src/cloudbite-api.ts` | HTTP surface: pages (`/`, `/cloudbite`, and the assets the page references: `CLOUDBITE_JS_PATH`/`CLOUDBITE_CSS_PATH` from `src/cloudbite-page.ts`, currently `/cloudbite/console.js`, `/cloudbite/console.css`; CSP `script-src 'self'; style-src 'self'`, no inline), `/api/cloudbite/*`, `/p/_cloudbite/worker/*` |
| `src/cloudbite-project.ts` | `CloudbiteProject` Durable Object: one instance per project + one `registry` instance |
| `src/cloudbite-config.ts` | `CLOUDBITE_*` settings, readiness (names only), limits |
| `src/cloudbite-validate.ts` | brief, opinion/result, workspace-path and artifact-path validation (brief/opinion limits and the opinion check come from `src/cloudbite-personas.ts`) |
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
| `CLOUDBITE_NOSANA_BASE_URL` | var | OpenAI-compatible base; production uses the official gateway `https://inference.nosana.com/v1` |
| `CLOUDBITE_NOSANA_API_KEY` | secret | Nosana key — server-side only |
| `CLOUDBITE_NOSANA_MODEL` | var | model id from the gateway's live `/v1/models` catalogue (it changes) |
| `CLOUDBITE_GATEWAY_URL` | var | this Worker's workers.dev origin, reachable from sandboxes |
| `CLOUDBITE_ALLOW_HTTP` | dev var | `1` allows `http://localhost` URLs |
| `MASTER_KEY`, `SETUP_TOKEN` | secrets | existing State auth (register an admin key on this Worker) |

`GET /api/cloudbite/bootstrap` lists missing names; live creation returns 503 naming them. The persona catalogue is part of
readiness: while `CLOUDBITE_EXPERTS` is empty, live (and demo) creation is refused.

## Authority

- **Create** (`POST /api/cloudbite/projects`): exact `Origin == ORIGIN`, `application/json`, ≤ 16 KiB, then
  `x-admin-token` checked through `State.adminList` (storage reads only). 1–5 known experts. Brief limits are
  `CLOUDBITE_BRIEF_LIMITS`: title ≤ 120, objective ≤ 2000, context ≤ 8000, `requestId` 8–64 of `[A-Za-z0-9_-]` — the same
  constants `buildExpertWorkspace` enforces, so an accepted brief always yields a workspace. `requestId` maps
  deterministically to the project id; a retry returns the same project with a fresh access token (≤ 4), a different brief → 409.
- **Project access token** `cbt_…` (hash stored): read, cancel (strict Origin), artifact. 24 h retention, then purge.
- **Worker capability** `cbw_…`: one per expert, hash stored, 13 min expiry, revoked on completion/failure/cancel/timeout.
  Works only for `/p/_cloudbite/worker/<project>/<run>/{inference,activity,complete}`; requests with an `Origin` are refused.
  Inference: ≤ 48 KiB body, ≤ 32 messages, ≤ 8 calls per expert (reserved before the upstream call), one in flight,
  60 s timeout, `max_tokens` 1200, reply reduced to `{content}` ≤ 16 KiB. Upstream errors become a fixed message.
  For the exact model `qwen/qwen3.8-27b` the request adds `chat_template_kwargs: {enable_thinking: false}` (documented
  on the Qwen model card): with thinking on, a realistic persona+workspace prompt spent all 1200 tokens on hidden
  reasoning and returned `content: null`. It also adds `response_format: {type: "json_object"}`: with thinking off the
  model still emitted unparseable JSON on the visitor sample. JSON mode constrains syntax only; the runner's semantic
  checks and round limits are unchanged. Other models keep the plain request shape. An empty/whitespace/null answer
  fails as `inference upstream returned no content`, or `… used its output budget before any content
  (finish_reason=length)`; reasoning fields are never read, returned or substituted.
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
  Every callback sends `User-Agent: Cloudbite-Runner/0.0.1`: Cloudflare refuses Python urllib's default UA (403, error
  1010) before the Worker runs.
- **compact protocol**: the gateway caps each reply at `max_tokens` 1200, and a long final cut off mid-JSON was the
  production failure (PM/strategy turn 6, pricing turns 3/4). The system prompt states that budget, asks for one JSON action
  under 2500 characters and, for final, a report under 100 words, a summary under 300 characters and 1–3 items under 120
  characters per list. The action schema has no preset numerical confidence example. These are prompt guidelines only: the schema limits below are
  unchanged and a valid final is saved exactly as the model sent it. The prompt names `out/result.json`, `out/report.md`,
  `out/manifest.json`, `out/done` as reserved (saved by `final`); a write to one is rejected with that explanation. An
  invalid or incomplete reply or a rejected final gets one short retry hint (reason, budget, compact rules) inside the same
  six turns; incomplete JSON is never repaired or partially accepted. The last turn's message demands only the final JSON
  with its exact keys; a `python`/`write` action on that turn is not run, and without a valid final the expert fails with
  `no valid final opinion within 6 turns`. No extra model call, retry loop or larger budget.
- A failed inference call ends the run with one `error` activity and `out/error.txt` naming a
  local category and allowlisted HTTP status only (e.g. `model provider returned an error (HTTP 502)`) — never the upstream
  body, model output or credentials. No retry and no other provider.
- **`out/result.json` is a flat `ExpertOpinion`** — exactly the workspace's `RESULT.schema.json`: the six properties
  `direction`, `confidence` (integer 0–100, self-assessed), `summary` (1–2000), `evidence`/`assumptions`/`nextActions`
  (1–12 non-empty strings ≤ 600 each), nothing else. It carries no expert id or schema wrapper: identity is the sandbox/run
  the server created and downloads from. Runner (`check_opinion`, rejects a bad final and asks again), server
  (`validateResult` → persona `validateExpertOpinion`) and schema share `CLOUDBITE_OPINION_LIMITS`.
- **running/collecting**: poll `out/done` every 15 s (or immediately after `complete`), download allowlisted files, validate
  `result.json` as above. Malformed (including the old `{schema, expertId, opinion}` wrapper) → `failed`, never `completed`.
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
- Local dev: `npm run dev` (port 8808) with `ORIGIN` `http://localhost:8808` in `wrangler.cloudbite.jsonc` `env.dev`.
- No live Daytona/Nosana call was made during implementation; request shapes follow `src/lab.ts` and the OpenAI chat API.
