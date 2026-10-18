# Jev automatic expert routing

The default flow is question → Jev chooses actual roles → execution. Users no longer have to select experts or apply a keyword recommendation. Explicit manual selection remains an advanced option and old clients remain supported. KO/EN, browser simulation versus live execution, auth and project limits are preserved.

## Decision and policy

The server calls `POST https://api.typesafe.ai/v1/systemone` with the server-only `TYPESAFE_API_KEY`, pinned `jev-1.13.0` and one Noul question for each of the100 runtime roles. All100 candidates are evaluated: no keyword shortlist removes possible specialists. Each question carries the role's name, scope and summary and asks whether that role would contribute directly to the user's actual question. The project title/objective/context are untrusted request data in shared state. Full expert prompts, knowledge corpora and credentials are not sent as routing context.

The router accepts only complete, bounded typed responses from the pinned model. It ranks independent per-role suitability probabilities and selects up to the user's server-side limit (maximum 100). A0.65 minimum is an initial routing policy, not a calibrated measure of expert accuracy. No match yields422 and asks for a more specific question. There is no fallback team, random confidence adjustment or silent keyword substitution on failure. The small live check described below is not a routing benchmark.

API docs: [TypeSafe HTTP contract](https://docs.typesafe.ai/api), [Noul](https://docs.typesafe.ai/primitives/noul), [models](https://docs.typesafe.ai/models), [skill suggestion pattern](https://docs.typesafe.ai/cookbooks/skill_suggestion). Live Markdown docs were retrieved on2026-10-19 KST; provider/model contracts can change. No SDK dependency was added.

## HTTP and authority

- Bootstrap adds optional `configuration.routing:{provider:'typesafe',model,ready,maxExperts}`. Only readiness is public; the key never enters a response or browser.
- `POST /api/cloudbite/route`: exact `{title,objective,context,requestId}` JSON, existing strict Origin/content-type/size checks, owner/operator or approved visitor auth. Invalid explicit admin headers never fall back to cookies. Routing itself consumes no project quota and creates no sandbox.
- Response: `{provider,model,policyVersion,evaluatedCount,threshold,expertIds,matches,queryHash,expiresAt}`. `matches[].relevance` is routing suitability, never answer confidence or accuracy.
- A live start submits the captured brief, same requestId and chosen ids to `POST /api/cloudbite/projects` with `routing:'jev'`. The server reads the actor's cached decision and verifies the exact question/catalogue/policy/limit hash. Changed ids or stale/cross-actor plans are rejected before project slots or providers are touched. Legacy explicit expert-id requests without this flag remain valid.
- A browser demo can ask Jev, but the subsequent expert activity remains local simulation and is labelled accordingly. Anonymous users cannot bill Jev; an explicit manual browser demo remains available.

## Durable cache and failure behavior

Actor-specific instances use the existing CloudbiteProject binding (`routing:<actor hash>`), without a new migration or changes to project/sandbox namespaces. The dedicated routing storage contains only hashes, bounded decisions, attempts and claim/expiry metadata, not the raw question or API key. A claim is committed before the provider call. Concurrent duplicates receive409; completed retries reuse the exact decision for10 minutes and do not call Jev again. Stale claims cannot overwrite newer results. Per actor: at most6 new calls/minute and20 retained decisions; expired entries are cleaned by alarms. Quota-exhausted visitors can read an existing plan but cannot request a new paid judgment.

Provider calls have a20-second deadline and bounded64KiB responses. Errors return fixed categories without upstream bodies. Missing key, rate limit, invalid responses and no-match are explicit failures. UI generation guards prevent late responses or cancelled routing from starting a run. For a lost creation response after the10-minute plan expiry, route again; a changed plan cannot silently alter an already-created project.

The project view persists the observed routing model, role suitability and query hash alongside its normal records. The decision's expiresAt describes the pre-create cache, not the lifetime of the advice. The normal answer model, history and confidence fields retain their previous meaning.

## Configuration and local development

Production: `TYPESAFE_API_KEY` is a Cloudbite Worker secret. Do not add it to Wrangler vars, browser code, Git or an operator token field. Local development can place it in an ignored `.dev.vars.dev` together with the existing dev configuration. `npm run dev` serves the app at `http://localhost:8808/cloudbite`; real routing requires the configured key plus an existing authorized owner/operator/visitor session. Provider-less local development exposes `routing.ready:false` and supports explicitly selected manual simulation.

## Verification

- `test/cloudbite-routing.mjs`: real100-role request contract, caps, strict parsing, no-match, redacted failures, fixed endpoint/deadline, per-actor cache, concurrent claims, stale completion, rate limit and prototype-shaped request IDs.
- `test/cloudbite-runtime.mjs`: auth and invalid-header precedence, approved visitor isolation, quota-exhausted cache-only behavior, route-before-create, authoritative ids, unchanged request/limit binding, idempotent creation and routing metadata.
- Console tests cover auto routing from empty selection, request ordering, auth headers, KO/EN, cancellation/stale responses, malformed results and legacy fallback.
- Four real Jev samples: STA→STA specialist; React state/performance→Frontend; Korean commercial-launch question→pricing/product/discovery/business-model/assumption roles; greeting→no match. Observed local call times306–349ms. These samples do not validate the threshold or quality across all100 roles. Representative held-out routing evaluation remains future work.
