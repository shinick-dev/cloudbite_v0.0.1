# Jev automatic expert routing

The default flow is question → Jev chooses actual roles → execution. Users no longer have to select experts or apply a keyword recommendation. Explicit manual selection remains an advanced option and old clients remain supported. KO/EN, browser simulation versus live execution, auth and project limits are preserved.

## Decision and policy

The server calls `POST https://api.typesafe.ai/v1/systemone` with server-only `TYPESAFE_API_KEY` and pinned `jev-1.13.0`. `jev-routing/v2` uses the [project-team harness](project-team-harness.md): assessment of all registered runtime roles (120 currently, catalogue bound 200) plus 14 project perspectives, then primary-owner assignment and direct-overlap review. Full knowledge corpora and credentials are not routing context. Project inputs are untrusted data. Role metadata and catalogue growth are incorporated without a keyword shortlist or a hardcoded role-to-perspective table. The catalogue bound is separate from the maximum 100 selected experts per project.

The router accepts bounded typed responses from the pinned model. Initial fit and perspective need thresholds are 0.65; direct-overlap pruning requires 0.85. Needed perspectives can recover a real specialist missed by initial fit, without changing its score. Representatives are protected before the actor limit (maximum 100). Gaps and exclusions are disclosed; no peer output is checked by this harness. No initial match yields 422. Failed team review never falls back to a partial first-stage team. Thresholds and small live samples are not calibrated accuracy claims.

API docs: [TypeSafe HTTP contract](https://docs.typesafe.ai/api), [Noul](https://docs.typesafe.ai/primitives/noul), [models](https://docs.typesafe.ai/models), [skill suggestion pattern](https://docs.typesafe.ai/cookbooks/skill_suggestion). Live Markdown docs were retrieved on2026-10-19 KST; provider/model contracts can change. No SDK dependency was added.

## HTTP and authority

- Bootstrap adds optional `configuration.routing:{provider:'typesafe',model,ready,maxExperts}`. Only readiness is public; the key never enters a response or browser.
- `POST /api/cloudbite/route`: exact `{title,objective,context,requestId}` JSON, existing strict Origin/content-type/size checks, owner/operator or approved visitor auth. Invalid explicit admin headers never fall back to cookies. Routing itself consumes no project quota and creates no sandbox.
- Response: `{provider,model,policyVersion,evaluatedCount,threshold,expertIds,matches,queryHash,expiresAt,harness}`. `harness.version` is `project-team/v1`. `matches[].relevance` is first-pass routing suitability, never answer confidence or accuracy. The console preserves readable v1 history but requires valid harness metadata for new v2 plans.
- A live start submits the captured brief, same requestId and chosen ids to `POST /api/cloudbite/projects` with `routing:'jev'`. The server reads the actor's cached decision and verifies the exact question/catalogue/policy/limit hash. Changed ids or stale/cross-actor plans are rejected before project slots or providers are touched. Legacy explicit expert-id requests without this flag remain valid.
- A browser demo can ask Jev, but the subsequent expert activity remains local simulation and is labelled accordingly. Anonymous users cannot bill Jev; an explicit manual browser demo remains available.

## Durable cache and failure behavior

Actor-specific instances use the existing CloudbiteProject binding (`routing:<actor hash>`), without migrations or project/sandbox namespace changes. Routing storage contains only hashes, bounded decisions, attempts and claim/expiry metadata. A 50-second claim is committed before either provider call. Concurrent duplicates receive 409; completed retries reuse the exact decision for 10 minutes. Stale claims cannot overwrite newer results. Per actor: at most six new plans/minute (up to 12 provider calls) and 20 retained decisions. Alarms clean expired entries. Quota-exhausted visitors can read an existing plan but cannot request a new paid judgment. Hashes bind the exact brief, current candidate metadata, policy/harness/model versions and actor limit.

Each of up to two provider calls has a 20-second deadline and a 256 KiB response bound. Errors return fixed categories without upstream bodies. Missing key, rate limit, invalid responses and no-match are explicit failures. UI generation guards prevent late responses or cancelled routing from starting a run. For a lost creation response after the 10-minute plan expiry, route again; a changed plan cannot silently alter an already-created project.

The project view persists the observed routing model, role suitability and query hash alongside its normal records. The decision's expiresAt describes the pre-create cache, not the lifetime of the advice. The normal answer model, history and confidence fields retain their previous meaning.

## Configuration and local development

Production: `TYPESAFE_API_KEY` is a Cloudbite Worker secret. Do not add it to Wrangler vars, browser code, Git or an operator token field. Local development can place it in an ignored `.dev.vars.dev` together with the existing dev configuration. `npm run dev` serves the app at `http://localhost:8808/cloudbite`; real routing requires the configured key plus an existing authorized owner/operator/visitor session. Provider-less local development exposes `routing.ready:false` and supports explicitly selected manual simulation.

## Verification

- `test/cloudbite-routing.mjs`: full-catalogue request contract including roles above number 100, project caps, strict parsing, no-match, redacted failures, fixed endpoint/deadline, per-actor cache, concurrent claims, stale completion, rate limit and prototype-shaped request IDs.
- `test/cloudbite-runtime.mjs`: auth and invalid-header precedence, approved visitor isolation, quota-exhausted cache-only behavior, route-before-create, authoritative ids, unchanged request/limit binding, idempotent creation and routing metadata.
- Console tests cover auto routing from empty selection, request ordering, auth headers, KO/EN, cancellation/stale responses, malformed results and legacy fallback.
- v2 live smoke: synthetic EDA tapeout and B2B pilot queries completed both stages (~0.74s locally); a greeting returned no match. EDA recovered a functional-verification specialist missed by initial fit. Full details and limitations are in the harness document. Earlier v1 samples do not establish v2 quality. Representative scored evaluation remains future work.
