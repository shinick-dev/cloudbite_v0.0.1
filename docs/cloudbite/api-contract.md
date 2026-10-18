# Cloudbite first-slice integration contract

Shared types: `src/cloudbite-contract.ts`. The coordinator owns this file; propose contract changes through the report before changing it. Workers may import types into independent modules.

## API

- GET `/cloudbite` and new primary `/`: product console, rendered from `CLOUDBITE_HTML` in `src/cloudbite-page.ts`. UI exports `CLOUDBITE_JS` and `CLOUDBITE_CSS` separately if CSP needs same-origin script/style routes.
- GET `/api/cloudbite/bootstrap`: `CloudbiteBootstrap`, public catalogue and configuration presence (names only; never values).
- POST `/api/cloudbite/projects`: `ProjectBrief` JSON. Live creation requires the existing admin session (`x-admin-token` using State authorization), strict same-origin and size/count limits. Returns `CloudbiteProjectCreated`. Start execution as part of creation; no extra start endpoint needed.
- GET `/api/cloudbite/projects/:id`: `ProjectRun`, with `Authorization: Bearer <accessToken>`.
- POST `/api/cloudbite/projects/:id/cancel`: same project access token, strict Origin; returns updated project, revokes worker authority and schedules owned sandbox cleanup.
- GET `/api/cloudbite/projects/:id/artifact?expert=<id>&path=<path>`: project access token; allowlisted generated text artifacts only. No arbitrary sandbox filesystem fetch.
- `/p/_cloudbite/worker/...`: runtime-defined callback/inference endpoints. Must work on the workers.dev gateway host (existing router admits `/p/` there). Per-expert short-lived opaque worker capability, never project/admin/provider credentials. Model prompts and user content are not authority.
- Errors: `{error: string}` with appropriate non-2xx HTTP status, no secret/upstream body reflection.

## UI demo and live paths

Public demo uses a browser-local explicit simulation and never silently falls back from failed live execution. It demonstrates project creation, 3–5 expert workspace activities and artifacts, aggregate opinions, confidence distribution and cancellation. No claim that a demo created real Daytona resources or ran Nosana.

Live UI reads bootstrap, accepts an existing admin token only in memory, creates a project and polls with the returned scoped access token. Server configuration is set out-of-band; the UI never asks for Daytona or Nosana API keys. Missing config explains which settings must be supplied and blocks live execution.

## Persona/workspace API

`src/cloudbite-personas.ts` exports `CLOUDBITE_EXPERTS`, `findExpert(id)` and `buildExpertWorkspace(expert, brief)` returning `Array<{path:string;content:string}>`. The workspace contains `PERSONA.md`, `PROJECT.md`, `WORKORDER.md`, and a result JSON schema/instructions. Original prompts are not in pro-bably's seed; describe these as freshly authored metadata-derived personas, preserving repository/path/revision/license provenance. These are AI roles, not real people's endorsements.

## Runtime

Independent Daytona sandbox per selected expert, bounded concurrency/count and timed work. The runtime must materially run code/tools inside that sandbox, not just store a persona string in a UI. Nosana OpenAI-compatible inference is called server-side through a configured endpoint and short-lived expert capabilities. A Python stdlib runner can request a bounded number of inference/tool rounds and write final `out/result.json` and `out/report.md`. Show actual returned activity and artifacts. Do not treat model-reported confidence as calibrated accuracy. No live resources are created during implementation tests.

Runtime owns new backend modules, tests, routing additions in index/public-get, Env additions in state, and independent Cloudbite Wrangler config. UI owns cloudbite-page and client/browser demo files. Persona worker owns cloudbite-personas, its focused tests and provenance docs. Coordinator owns shared contract and final integration.
