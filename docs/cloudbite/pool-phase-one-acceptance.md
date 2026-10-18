# Cloudbite expert pool — phase-one acceptance

Date: 2026-10-19 (Asia/Seoul). Work Stack: T-0066 (started).
Code candidate: `3d295796c66529ea8a7712c4fc13b1c134282997` on `feat/expert-sandboxes`.
The checks below describe the original local implementation acceptance. This is not an expertise certification.

Production follow-up (2026-10-19 KST, explicitly authorized): release commit `07b1d60daaa0c6680b22ca9f364bbb8c99defcce` fast-forwarded to `main` and deployed to `https://cloudbite.shinick.dev`, Worker version `835a6ed2-6b4b-452b-ae6a-908abc267ed5`. Public bootstrap returned 100 catalogue entries /25 runnable roles, `liveReady: true`, max5. Aside verified the real catalogue and team suggestions. One real Customer Discovery run completed through Daytona and Nosana with all six artifacts and the knowledge audit (self-assessed confidence25; source pages not fetched, no peer verification). Its test history was deleted and Daytona confirmed its sandbox removed (HTTP404). Sanitized local receipt: `.artifacts/pool75/phase-one-live-receipt.json`. The subsequent 75-role extension is documented separately in `pool-expansion.md`.

## Delivered

- 100 planning entries in ten categories, mapped to the actual runtime catalogue.
- 25 runnable roles: original thirteen IDs retained, twelve new IDs added.
- 20 source-linked starter packs: 120 authored cards, 29 distinct sources, 50 per-role source records.
- Separate PrimeTime STA pilot unchanged: 50 cards, 120 source records, eight checklists.
- Four original roles still use metadata-derived personas. Every role remains unvalidated.
- Folded catalogue with search, category/readiness filters, selected-role visibility, locked planned entries and KO/EN.
- Rule-based recommendations with matched-keyword reasons; explicit Apply changes only selection, never starts a project.
- Role-scoped knowledge retrieval, exact-file hashes, capability/expert binding, citation-ID checks and an audit artifact.
- Full pack hash in each enriched persona so history promptHash also tracks source-only changes.
- Existing project selection max5, concurrency3, visitor10, authentication, history retention and cleanup unchanged.

## Repairs accepted

1. Knowledge role artifacts use the runtime's collectable out/ paths; generated evaluation examples use JSON arrays rather than unsupported JSONL artifacts. The held-out fixture stays JSONL outside runtime data.
2. Pack validation rejects invalid/reserved/duplicate paths and limits role deliverables to three, reserving the sixth collected file for the automatic knowledge audit alongside result/report.
3. Runtime follow-up retrieval tests derive queries from the actual role pack; expected retrieval is preserved.
4. Generic citation audit rejects malformed closed tokens, including whitespace and overlong IDs, and unknown IDs. Legacy STA behaviour remains intact.
5. Knowledge digest memoization uses the pack object rather than expertId; alternate objects cannot reuse stale validation/hashes.
6. No-peer disclosure is documented as a literal statement requirement. It does not prove a report contains no contradictory claims.

## Evidence

| Check | Result |
|---|---|
| npm run check | PASS: generated assets and both server/client TypeScript checks |
| npm run test:cloudbite | PASS: all eight configured suites |
| Starter pack/fixture checks | 20 packs, 120 cards, 29 distinct sources, 60 held-out cases |
| Persona suite | 1070 assertions passed; optional external registry cross-check skipped when the reference seed is absent |
| Pool suite | 860 assertions passed |
| Generic knowledge suite | 307 assertions passed, including real Python write/citation/integrity checks |
| STA suite | 24 held-out workspace/retrieval cases; expected-source overlap21/24, not answer quality |
| Console suite | 64 cases passed |
| Runtime suite | 31 cases passed, fake providers plus real Python runner |
| History suite | 10 SQLite/permission/lifetime cases passed |
| Independent workspace check | All20 role workspaces within size limits; hashes match Node crypto; untrusted sentinel confined to project data |
| Aside interaction | Actual local Worker: 100 entries/25 available; suggestion Apply only, planned disabled, five selected; KO/EN preserves brief/search/selection |
| Layout | 1536×1024 and390×844: no horizontal overflow or page errors |
| git diff --check | PASS |

Worktree-only build checks initially lacked a fixed-path dependency; the final repository check above passed with the existing installed dependencies. A coordinator import that exposed a type-reference issue was removed before the final check. No dependency upgrade or type configuration change was needed.

Browser actions used Aside. Its previously verified lack of viewport resizing required a separate installed Edge/Playwright layout-only pass for the two viewport captures.

Local ignored evidence: `.artifacts/pool100/{check-final.log,test-final.log,independent-acceptance.json,viewport-acceptance.json,review.json}`.
No paid provider jobs were started.

## Files

- Catalogue/runtime: `src/cloudbite-pool.ts`, `cloudbite-knowledge.ts`, `cloudbite-phase-one-data.ts`, `cloudbite-personas.ts`, `cloudbite-runner.ts`, `cloudbite-contract.ts`, `cloudbite-api.ts`.
- Console: `client/cloudbite-console.ts`, `client/cloudbite-console.css`, generated `src/cloudbite-page.ts`.
- Checks: new pool/knowledge/pack suites, updated persona/runtime/console suites, `test/fixtures/pool-phase-one-evaluation.jsonl`, `package.json`.
- Product documentation: README, PRODUCT, `docs/cloudbite/{expert-pool-100,phase-one-knowledge,pool-runtime,pool-console}.md`.

## Start and remaining work

Run `npm ci` if dependencies are absent, then `npm run dev`; default `http://localhost:8808/cloudbite`.
The coordinator's separate local preview is `http://localhost:8897/cloudbite?lang=ko` while that dev server runs. It is configured without ready external providers.

Remaining T-0066 work:
- 20 of29 distinct source records are unverified: nineteen not fetched, one HTTP403. Reachability checks on nine documents do not validate each authored card's interpretation.
- The60 held-out cases are authored and unscored. No new live-provider or domain-expert answer-quality evaluation was performed.
- Starter packs are not equivalent in depth to the separate pro-bably STA corpus.
- Review roles have no peer outputs. A budgeted follow-up cross-review pipeline and semantic synthesis are not implemented.
- Seventy-five plan entries are not runnable; existing four metadata-only roles also need deeper material if retained.
- Nothing was pushed, merged to main or deployed to production in this phase.

