# Jev routing production acceptance

2026-10-19 KST · WorkBite T-0066. Public app: https://cloudbite.shinick.dev/.
Current deployed code: `461ebad95ed7b751372c7266faea735e6fb947a3`.
Worker `cloudbite-v001`, version `21afb726-e292-4486-8b9b-91067900d66f`.

## Delivered

Users enter a question and press Run. Server-side Jev evaluates all100 actual expert roles using independent Noul judgments, selects1–5 within the session limit and hands those ids to the existing execution path. Automatic routing is the default; manual picking is an explicit secondary option. TypeSafe credentials are stored as a Worker secret, not browser data. The operator token is unrelated to that provider key.

The routing result is bound to actor, exact brief, catalogue, model/policy and limit. Pending claims prevent concurrent duplicate calls; successful retries use a10-minute durable cache. The server re-reads that decision before creation and refuses edited, stale or cross-actor selections. Routing itself consumes no visitor project slot. No match, missing configuration and provider errors do not silently create a substitute team. The project retains the observed routing metadata; deleting its history also removes that metadata.

The existing max5/project, concurrency3, visitor10 projects, one-hour visitor grant, owner security-key sessions,30-day history, source/citation checks and domain configuration remain. Visitor onboarding copy now describes automatic Jev selection in both languages. No new DO class or migration was needed.

## Implementation and checks

- UI worker: StackBite Claude Code Opus5.5 medium, actual provider screen verified; base41d3d94→85e7171, integrated as5f334d8. Matching native generation/turn completion recorded and the owned seat closed. The coordinator implemented server/API/storage integration and accepted the combined result.
- `npm run check`: generated assets plus server/client TypeScript passed on the final code.
- Full `npm run test:cloudbite`: all10 suites passed on7e0ce9a, including11 routing,75 console and34 runtime cases. Existing knowledge, STA, pool, persona and real-SQLite history suites passed.
- Final deletion patch:34 runtime cases rerun successfully, including erasure of routing metadata. Onboarding copy:20 access UI tests passed and generated assets verified. Unchanged suites were not repeatedly rerun for documentation/copy edits.
- Unit/API coverage: complete typed responses; irrelevant questions; unknown ids, invalid probabilities and oversized responses; provider redaction/timeouts; fixed upstream URL; auth/header precedence; visitor isolation and exhausted-quota cache-only reads; stale/concurrent claims; per-actor rate cap; same-question idempotence; cancellation, changed inputs, KO/EN and legacy bootstrap.
- Public bootstrap reports100 roles and `routing.ready:true` with `jev-1.13.0`. Anonymous routing returns401. The actual provider key was checked absent from public bootstrap, HTML and JavaScript responses. No secret values were committed or included in receipts.

## Real provider and browser proof

Four direct real-Jev samples took306–349ms each: STA→STA specialist; React state/performance→Frontend; Korean commercial launch→pricing/product/discovery/business-model/assumption roles; greeting→422/no team. This is a small smoke test, not a routing benchmark.

Aside then used the existing public visitor-request UI and its already-enabled automatic approval policy. It entered a frontend question, verification context and QA project title, chose no experts, and clicked Run once. Production Jev selected:

| Role | Routing suitability | Final answer self-assessment |
|---|---:|---:|
| Frontend Engineer | .91 | 35% |
| Software Quality Engineer | .86 | 45% |
| Assumption Auditor | .79 | 55% |
| Accessibility Specialist | .69 | 30% |

All4 completed through independent real Daytona sandboxes and Nosana inference, returning4 valid opinions,0 failures and their report/knowledge/role files. Three ran concurrently and the fourth waited. The visitor counter decreased from10 to9, once. The question intentionally supplied no code or measurements, so conditional/abstaining advice was appropriate; no answer-quality score is claimed. KO→EN preserved the question, selected roles, probabilities and completed results. History retained the actual Jev model, ids and query hash.

The owned QA history was deleted through the normal two-step browser flow; a subsequent history read returned404. Daytona returned404 for all4 owned sandbox ids. The test visitor grant follows the pre-existing one-hour auto-approval expiry; no new approval policy was enabled and no other user's record was changed.

Sanitized local evidence: `.artifacts/jev-routing/{live-probe,production-flow,release}.json`, `production-completed.png`, `full-tests.log`, `runtime-final.log`, `check-final.log`, `access-ui.log`, and the native worker completion receipt. The real browser run used initial routing release7e0ce9a/version82dca926; the final update preserved that path and added onboarding wording plus routing-data deletion.

## Limits

The.65 selection threshold is an initial policy checked with a few samples, not calibrated on a held-out routing set. Suitability probabilities are not expert confidence or answer accuracy. All expert packs remain unvalidated. True peer cross-review and representative routing/answer-quality benchmarks remain future work. Manual mode and explicitly simulated browser demos remain available; they are never labelled real Jev/sandbox execution when they are not.
