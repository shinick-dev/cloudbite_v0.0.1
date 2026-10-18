# Independent parallel expert execution

Cloudbite now accepts 1–100 distinct runnable expert IDs per project. Jev evaluates the 100-role catalogue
in one server-side TypeSafe request, retains only roles above the existing 0.65 suitability threshold,
and respects the authenticated actor limit. It no longer truncates relevant roles to five. A narrow
question can still choose one role; a broad question is not automatically forced to use 100.

Each selected expert still owns a separate Daytona sandbox with its persona, knowledge pack, common
brief and work order. Default project admission starts the entire selected team (up to 100), without
waiting for three earlier experts to finish. `CLOUDBITE_MAX_CONCURRENT`, an optional Worker variable,
lets the operator set an integer 1–100 when provider capacity requires a smaller budget. Absent means
100. Invalid values block live readiness and execution; demo simulation remains available.
`GET /api/cloudbite/bootstrap` reports `configuration.maxExperts` and `configuration.maxConcurrent`.
No account key or internal assignment is exposed.

The existing two-live-project registry, one-hour visitor session, ten visitor project attempts,
per-expert inference budgets, claim persistence, uncertain-create recovery, cancellation and cleanup
are retained. `e0` through `e99` are valid run IDs, including legacy IDs; leading zero variants and e100
are rejected. A selected expert stays pinned to its assigned primary/secondary/tertiary organization
for every operation and cleanup. A failed create is never retried blindly in another organization.

The browser uses the advertised server and visitor limits for live and browser-demo routing. KO/EN
console guidance, QR access and owner approval descriptions no longer advertise the old five-role pilot.
Old cached routing decisions are bound to the original limit and must be recomputed after the change.

## Verification

- `npm run check`: generated asset checks and both TypeScript projects passed.
- `npm run test:cloudbite`: all ten suites passed, including 12 routing, 76 console and 44 runtime checks.
- Additional access (21), access UI (20) and owner-session (17) checks passed.
- A mock-provider integration created the real 100-role workspaces, held all 100 create responses until
  every expert had started, verified persisted account pinning across three organizations (33/33/34),
  then cancelled and verified 100 unique deletions using only each sandbox's owning credential.
- Configured concurrency 3 remains covered as an explicit operator override, not the default.
- Full catalogue routing, smaller actor limits, stale decision rejection and run-ID bounds are covered.

These are local integration checks with fake provider services, not a claim of 100 concurrent real
sandboxes or measured AI advice quality. Actual capacity remains subject to each Daytona organization,
Nosana rate limits and Cloudflare runtime limits. Three API keys do not prove triple capacity.
The Workers runtime may queue outbound HTTP connection establishment; that transport behavior does
not imply that only three expert sandboxes can run.

References: [TypeSafe API](https://docs.typesafe.ai/api),
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/),
[Durable Object alarms](https://developers.cloudflare.com/durable-objects/api/alarms/).

## Release

Production deployment and smoke checks are recorded here after the verified build is released.
