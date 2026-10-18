# Project-team harness (`project-team/v1`)

Cloudbite questions are usually project advice with no single correct answer. The routing goal is therefore a team of complementary experts, not "every role that sounds relevant" and not a fixed top-five. This document describes the two-call harness defined by the shared contract (`CloudbiteRoutingHarness` in `src/cloudbite-contract.ts`), how new catalogue roles join it, its boundaries and failure model, and the held-out fixtures used to check it. It complements [jev-routing.md](jev-routing.md), which describes the existing single-call v1 router, HTTP authority and cache.

## Two calls

Both calls go to the TypeSafe System One API with the pinned `jev-1.13.0` model and typed primitives. The project title/objective/context are untrusted request data in shared state; instructions and meaning live in the question instructions/state, not only in IDs. No URL in the brief is fetched.

1. **Assessment.** One Noul fit judgment per eligible candidate (up to 100), and one Noul need judgment per fixed authored perspective. Perspective IDs: `architecture`, `implementation`, `validation`, `performance`, `security`, `privacy`, `user-value`, `commercial`, `finance`, `delivery`, `assumptions`, `decision`, `regulatory`, `operability`. Labels may be refined; the bounded meaning of each ID may not. No keyword prefilter removes a specialist before this call.
2. **Team review.** For each perspective with need ≥ 0.65, a Choice over eligible candidates plus `none` picks the best primary coverage. `none` means "no catalogue role covers this needed perspective" and is reported as missing coverage; it is distinct from a perspective that is simply not needed. The same call carries strict Noul duplicate-contribution probes between candidates of the same catalogue category: each eligible candidate is compared with up to six higher-ranked peers in its category (stable tie-breaks, ≤ 600 probes). Model option symbols map to real IDs; invented IDs are rejected.

Composition then keeps the chosen perspective representatives first, and prunes another role only when it directly overlaps an already selected role above the explicit policy threshold (about 0.85) — i.e. one role covers substantially all of the other's requested contribution. A missing pair probe is not evidence of overlap. Same category alone is not redundancy: physical design, STA, RTL and synthesis roles asked for different deliverables are all kept. There is no small fixed team cap; a broad, non-redundant brief can select up to 100. When the actor limit truncates, needed perspectives are protected first and the decision says `limited`/`uncovered` instead of claiming coverage.

The versioned explanation records perspective need and status, each selected role's contribution kind (`coverage` or `additional-domain`), exclusions with fixed reasons (`overlap`, `limit`, `below-threshold`), warnings as fixed codes (for example `uncovered-perspectives`, `actor-limit`) and `peerReview: 'not-performed'`. Team suitability is not answer confidence or accuracy. The UI shows fixed KO/EN reasons from these codes, never model-generated text as authority.

## Catalogue extensibility

Candidates are passed to the engine as `{id, name, domain, mission, summary, category}`. Category comes from pool metadata; when that is missing the coordinator falls back to the domain/category it already has. A newly registered expert therefore needs no router ID table, keyword list or perspective mapping: it is assessed by its own description in call 1 and is eligible for coverage and same-category overlap probes in call 2. The perspective set is authored and versioned with the harness; adding a perspective is a harness version change, not a catalogue change.

## Boundaries and failure model

- Engine (`src/cloudbite-routing-harness.ts`, coordinator-owned) is pure: it builds request bodies and parses responses but performs no fetch or storage. The coordinator owns the provider call, the claim lease covering both bounded calls, the 256 KiB response bound, caching and the `jev-routing/v2` protocol. The harness field is optional so v1 decisions and history remain readable.
- Parsing is strict and fails closed: exact required question keys, expected answer type and model, finite probabilities in range, Choice options from the allowlist only, and no missing or extra answers. Failures raise fixed safe errors without upstream bodies, keys or raw questions.
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
