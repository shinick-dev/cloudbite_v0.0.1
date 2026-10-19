# Cloudbite first-slice integration contract

Shared types: `src/cloudbite-contract.ts`. The coordinator owns this file; propose contract changes through the report before changing it. Workers may import types into independent modules.

## API

- GET `/cloudbite` and new primary `/`: product console, rendered from `CLOUDBITE_HTML` in `src/cloudbite-page.ts`. UI exports `CLOUDBITE_JS` and `CLOUDBITE_CSS` separately if CSP needs same-origin script/style routes.
- GET `/cloudbite/console.js` and `/cloudbite/console.css`: same-origin assets, using the exported paths from the console builder.
- GET `/cloudbite/access`, `/cloudbite/access.css`, `/cloudbite/access-qr.svg`: public QR guide/assets bridging to the existing participant request URL. These routes grant no execution authority and do not provision resources.
- GET `/api/cloudbite/bootstrap`: `CloudbiteBootstrap`, public catalogue and configuration presence (names only; never values).
- POST `/api/cloudbite/projects`: `ProjectBrief` JSON. Live creation requires the existing admin session (`x-admin-token` using State authorization), strict same-origin and size/count limits. Returns `CloudbiteProjectCreated`. Start execution as part of creation; no extra start endpoint needed.
- GET `/api/cloudbite/projects/:id`: `ProjectRun`, with `Authorization: Bearer <accessToken>`.
- POST `/api/cloudbite/projects/:id/cancel`: same project access token, strict Origin; returns updated project, revokes worker authority and schedules owned sandbox cleanup.
- GET `/api/cloudbite/projects/:id/artifact?expert=<id>&path=<path>`: project access token; allowlisted generated text artifacts only. No arbitrary sandbox filesystem fetch.
- `/p/_cloudbite/worker/...`: runtime-defined callback/inference endpoints. Must work on the workers.dev gateway host (existing router admits `/p/` there). Per-expert short-lived opaque worker capability, never project/admin/provider credentials. Model prompts and user content are not authority.
- Errors: `{error: string}` with appropriate non-2xx HTTP status, no secret/upstream body reflection.

### Product v2 additions (`src/cloudbite-api.ts`, `src/cloudbite-project.ts`)

- POST `/api/cloudbite/preview`: same body, authority, Origin/content-type checks and validation as `/projects` (one shared `prepareProject` path), returns `ProjectPreview` (expert ids, the exact `ExpertAssignment`s create would store, budget, envelope, warnings). It reserves nothing, starts no sandbox, writes no project and makes no model call. `envelope.jevCalls` is 2 for `routing: 'jev'` (the cached decision is read, never re-routed) and 0 for a manual selection; demo envelopes report 0 sandboxes/Nosana calls.
- Effective team cap = `min(CB_MAX_EXPERTS, visitor session maxExperts, brief.budget.maxExperts)`, applied identically by `/route`, `/preview` and `/projects`.
- POST `/api/cloudbite/projects`: an automatic (`routing: 'jev'`) create forwards `decision`, `documents`, `stage`, `responseLanguage`, `budget` and `revision` into the routing query. Order: authority → validation/plan → revision parent → visitor slot → live slot → create. Assignments are computed once and stored on the project (`ProjectRun.assignments`) and on each run (`ExpertRun.assignment`); the workspace's `WORKORDER.md` is built from that stored assignment.
- Follow-up round (`brief.revision`): the parent is read through `parentDO.historyRead(actor, owner)` with the actor from `prepareHistory` (owner credential or the visitor's history identity), then `authorizeRoundParent` + `buildProjectRound`, before any reservation or create. A foreign, deleted, expired or unfinished parent is 404/409 and nothing is written. A revision is a new project; its bounded round is stored under `round`, exposed as `ProjectRun.previousRound`, and written to `evidence/previous-round.json` in each workspace. A retried create of an existing follow-up replays with its originally stored round, even after the parent was deleted.
- POST `/api/cloudbite/projects/:id/memo`, body `{}`, project Bearer token, strict Origin: decision memo (see decision-workflow.md). Errors are `{error}`; budget exhaustion is 429.
- POST `/api/cloudbite/pmc/import`, body exactly `{identifier}` (≤1 KiB; PMCID or DOI, never a URL): owner, or an approved visitor whose session can still create. Returns `PmcImport` documents for the user to review and attach; nothing is stored except pacing counters. Errors are `{error, code}` (`invalid_identifier`, `busy`, `hourly_limit`, upstream codes) with `Retry-After` when known. One import at a time (lease), ≤10 per actor per hour, global spacing between NCBI requests; only `https://pmc.ncbi.nlm.nih.gov` is reachable and cookie/authorization headers are never forwarded. GET is 405; unauthenticated requests make no fetch.
- `ProjectRun.usage`: public ledger (`publicBudget`) plus `jevCalls` and `sandboxMaximum`. Every model call (expert turn, review, memo) is reserved in the `budget` key inside one storage transaction before the outbound request and is never refunded. `ProjectRun.evidencePackets` / `evidenceSignals` come from collected `out/knowledge.json` audits; projects without audits show unobserved retrieval (`observedRetrieval: null`, `packetCoverage.supplied: false`).

## UI demo and live paths

Public demo uses a browser-local explicit simulation and never silently falls back from failed live execution. It demonstrates project creation, 3–5 expert workspace activities and artifacts, aggregate opinions, confidence distribution and cancellation. No claim that a demo created real Daytona resources or ran Nosana.

Live UI reads bootstrap, accepts an existing admin token only in memory, creates a project and polls with the returned scoped access token. Server configuration is set out-of-band; the UI never asks for Daytona or Nosana API keys. Missing config explains which settings must be supplied and blocks live execution.

## Persona/workspace API

`src/cloudbite-personas.ts` exports `CLOUDBITE_EXPERTS`, `findExpert(id)` and `buildExpertWorkspace(expert, brief)` returning `Array<{path:string;content:string}>`. The workspace contains `PERSONA.md`, `PROJECT.md`, `WORKORDER.md`, and a result JSON schema/instructions. Original prompts are not in pro-bably's seed; describe these as freshly authored metadata-derived personas, preserving repository/path/revision/license provenance. These are AI roles, not real people's endorsements.

## Runtime

Independent Daytona sandbox per selected expert, bounded concurrency/count and timed work. The runtime must materially run code/tools inside that sandbox, not just store a persona string in a UI. Nosana OpenAI-compatible inference is called server-side through a configured endpoint and short-lived expert capabilities. A Python stdlib runner can request a bounded number of inference/tool rounds and write final `out/result.json` and `out/report.md`. Show actual returned activity and artifacts. Do not treat model-reported confidence as calibrated accuracy. No live resources are created during implementation tests.

Runtime owns new backend modules, tests, routing additions in index/public-get, Env additions in state, and independent Cloudbite Wrangler config. UI owns cloudbite-page and client/browser demo files. Persona worker owns cloudbite-personas, its focused tests and provenance docs. Coordinator owns shared contract and final integration.
