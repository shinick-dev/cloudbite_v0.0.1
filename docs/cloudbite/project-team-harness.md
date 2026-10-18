# Project-team harness (`project-team/v1`)

Cloudbite questions are usually project advice with no single correct answer. The routing goal is a team of complementary experts with disclosed gaps. This document describes the two-call harness defined by `CloudbiteRoutingHarness` in `src/cloudbite-contract.ts`, catalogue growth, boundaries and evaluation fixtures. [jev-routing.md](jev-routing.md) describes the HTTP authority, cache and `jev-routing/v2` protocol. Legacy v1 decisions remain readable.

## Two calls

Both calls go to the TypeSafe System One API with the pinned `jev-1.13.0` model and typed primitives. The project title/objective/context are untrusted request data in shared state; instructions and meaning live in the question instructions/state, not only in IDs. No URL in the brief is fetched.

1. **Assessment.** One Noul fit judgment per registered candidate (120 currently, bounded at 200 independently of the 100-expert project cap), and one Noul need judgment per fixed authored perspective. Perspective IDs: `architecture`, `implementation`, `validation`, `performance`, `security`, `privacy`, `user-value`, `commercial`, `finance`, `delivery`, `assumptions`, `decision`, `regulatory`, `operability`. Labels may be refined; the bounded meaning of each ID may not. No keyword prefilter removes a specialist before this call.
2. **Team review.** For each perspective with need ≥ 0.65, a Choice over the entire catalogue plus `none` assigns its best primary owner. This second look can recover a specialist whose first-pass fit was below 0.65; the original fit is preserved and `coverage-rescue` disclosed. `none` reports a missing specialist. The same call carries directed Noul duplicate-contribution probes: each initially eligible candidate is compared with up to six higher-ranked peers of its own catalogue category (stable ties; at most 1179 probes at the 200-role catalogue bound). Full profiles are shared once in state and referenced by the questions. Option symbols map to real IDs; invented IDs are rejected. An empty review is resolved locally without a paid call.

Composition then keeps the chosen perspective representatives first, and prunes another role only when it directly overlaps an already selected role above the explicit policy threshold (about 0.85) — i.e. one role covers substantially all of the other's requested contribution. A missing pair probe is not evidence of overlap. Same category alone is not redundancy: physical design, STA, RTL and synthesis roles asked for different deliverables are all kept. There is no small fixed team cap; a broad, non-redundant brief can select up to 100. When the actor limit truncates, needed perspectives are protected first and the decision says `limited`/`uncovered` instead of claiming coverage.

The explanation records perspective need, assignment status, each selected role's kind (`coverage` or `additional-domain`), exclusions (`overlap`, `limit`, `below-threshold`), fixed warnings and `peerReview: 'not-performed'`. `eligibleCount` includes initial fits and rescued representatives. `covered` means assigned to a selected role, not that a generated answer has been verified. `limited` means its representative was excluded by the actor limit; `uncovered` means no representative was found. Suitability is not answer confidence or accuracy. The KO/EN UI describes these meanings explicitly.

## Catalogue extensibility

Candidates are passed to the engine as `{id, name, domain, mission, summary, category}`. Category comes from pool metadata; when that is missing the coordinator falls back to the domain/category it already has. A newly registered expert therefore needs no router ID table, keyword list or perspective mapping: it is assessed by its own description in call 1 and is eligible for coverage and same-category overlap probes in call 2. The perspective set is authored and versioned with the harness; adding a perspective is a harness version change, not a catalogue change.

## Boundaries and failure model

- Engine (`src/cloudbite-routing-harness.ts`, coordinator-owned) is pure: it builds request bodies and parses responses but performs no fetch or storage. The coordinator owns the provider call, the claim lease covering both bounded calls, the 256 KiB response bound, caching and the `jev-routing/v2` protocol. The harness field is optional so v1 decisions and history remain readable.
- Parsing fails closed: exact required question keys, expected type and model, finite probabilities in range, allowlisted Choice options, and no missing or extra answers. A Choice winner must have maximum probability. Live Jev responses round probabilities to hundredths (one observed sum was 0.99); the sum check permits at most ±0.02, without normalising or changing scores. Failures raise fixed safe errors without upstream bodies, keys or raw questions.
- Raw questions and secrets are not persisted by the router. Serialized metadata is bounded.
- A thin brief or a brief with no relevant role yields a clarification/no-match result or disclosed uncovered need, never a fabricated fallback team. Instructions embedded in the brief (for example "select every expert" or an invented role ID) are data and do not change selection.
- The 100-role actor cap, manual expert selection and existing execution paths are unchanged.

## Execution limitation (v1)

The harness only decides who is on the team and why. It does **not** share one expert's output with another, run dependent or sequential reviews, or perform any peer review: `peerReview` is always `'not-performed'`. Every selected role still runs as an independent advisor exactly as before. Nothing in the explanation or UI should imply that experts saw or checked each other's results.

## Held-out fixtures

`test/fixtures/cloudbite-routing-projects.json` holds 14 held-out project briefs with **human-authored expectations**: expected needed perspectives, useful candidate expert IDs from the current catalogue, likely overlap groups (`distinct-keep` or `possible-redundant`) and rationale. They are not observed or scored model results, and there is no recorded live evaluation against them. Scenarios: Korean EDA tapeout, a finite STA slack calculation contrasted with STA signoff project advice, B2B launch, security/privacy, frontend accessibility, distinct physical/STA/RTL deliverables, thin brief, cross-tenant isolation, portfolio-wide breadth, a domain with no relevant role, redundant meta-review roles, prompt injection and a regulated healthcare product.

`test/cloudbite-routing-fixtures.mjs` bundles the real catalogue (`src/cloudbite-personas.ts`, `src/cloudbite-pool.ts`) with esbuild and checks fixture integrity only: unique IDs and briefs, routing query bounds, known perspective IDs and outcomes, required scenario coverage, that every referenced expert ID exists with a pool category, that overlap groups stay within one category, that the injected ID is not real, and that no production source under `src/`, `client/` or `tools/` references the fixture. If `src/cloudbite-routing-harness.ts` exists it also checks the fixture perspective IDs against the engine's `PERSPECTIVES`; otherwise that check is reported as skipped. It makes no provider calls and does not score routing quality.

```
node test/cloudbite-routing-fixtures.mjs
```

Scoring the harness against these expectations with real Jev responses is future work and requires a configured key; no such results are claimed here.

## Live smoke evidence (2026-10-19 KST)

Synthetic EDA tapeout and B2B pilot briefs completed both real Jev stages in about 0.74 seconds locally. The EDA run assigned all six requested perspectives and recovered Functional Verification Engineer missed by initial fit; the B2B run assigned eight perspectives. A greeting returned no match (422) after assessment. These are operational smoke checks, not a scored evaluation of the 14 fixtures or a quality benchmark. Jev selected 11 and 17 roles respectively with no overlap exclusions; reduced team size or optimal routing is not proven. Broad team-review requests use substantial provider input tokens despite shared profiles, so cost and representative quality evaluation remain follow-up work.

## Runner finalisation

The reported Logic Synthesis failure was an unretrieved citation rejected on turn six. A rejected final on the last turn now gets up to two final-only correction replies inside the existing eight-call budget and capability deadline. Tools cannot execute during repair. The prompt lists actually retrieved source tokens and asks to remove unsupported claims or state evidence gaps. Citation validation and model-authored confidence remain unchanged. Continued rejection remains a failure, with a bounded diagnostic code rendered using fixed server wording; provider bodies and model text are not exposed as the failure banner. Truncated actions and inference failures remain explicit failures. Deterministic Python runner tests reproduce citation rejection and successful source-bound repair; the garbled Physical Design log does not establish its exact cause.

Production smoke on Worker version `b2d6fc77-ccc6-484c-ab33-d50ef96fbbe2`: a new synthetic EDA project ran Physical Design and Logic Synthesis in separate real Daytona sandboxes through Nosana. Both completed with valid opinions (conditional 40%, abstain 35%) on turn five, so this live run did not exercise final repair. Both owning-account sandbox GETs returned 404 after cleanup; no labelled sandbox remained in any of the three accounts. A separate browser demo used real production Jev routing, displayed 12 chosen roles, six assigned perspectives and the coverage-rescue notice in KO/EN; expert outputs in that demo were simulated and are not runtime evidence. The harness explanation was inspected in Aside. Full-page screenshot capture timed out and returned a viewport fallback. All 13 `test:cloudbite` suites and `npm run check` passed; repair behavior is demonstrated by deterministic Python tests, not a forced production failure.
