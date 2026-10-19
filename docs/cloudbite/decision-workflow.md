# Decision and evidence workflow

Cloudbite now separates **the decision**, **provided evidence**, **original independent opinions**, and **an optional second-pass cross-review**. All are project-scoped. Existing briefs without the new fields remain valid.

## Using the console

1. Enter the project objective. Open the optional decision details to record options, constraints, success criteria, user-stated facts, assumptions, and unknowns. One item per line; none is silently promoted to a verified fact.
2. Add optional TXT, Markdown (`.md`), CSV, or JSON documents. Review their actual text and remove unwanted files before starting. These are plain-text sources, not instructions. No document URL is fetched.
3. Let Jev choose the team, or choose roles manually. A change to either decision data or document contents invalidates a previously cached routing decision.
4. Run the original experts. Each receives the same complete decision/evidence files in its own Daytona workspace. A citation such as `[doc:doc-1]` must name an actual supplied document; unknown document citations are rejected by the Python runner.
5. Read the claim/evidence ledger. It enumerates each completed opinion's evidence items and source IDs. **Linked means the ID exists in the supplied documents or that role's source catalogue. It does not mean the assertion is true, the source was fetched, or the claim entails the conclusion.** Existing curated-knowledge retrieval validation is separate.
6. On a finished live project with at least two completed opinions, request the optional cross-review. It makes up to three additional Nosana calls, one per reviewer, using actual original opinions and supplied document text. It creates no new Daytona sandboxes. Original opinions and their confidence scores remain unchanged.

## Bounds and supported inputs

- Six decision lists, at most eight items of 300 characters in each.
- Up to six plain-text files, at most 8,000 characters per file and 24,000 characters total. The rendered JSON evidence file also has a 48 KiB UTF-8 bound; multi-byte text may reach that byte bound first. Invalid/oversized data is explicitly rejected.
- Display names and document IDs are validated. Files are stored as data in `DECISION.md` and `evidence/documents.json`; a supplied filename never becomes an executable path.
- PDF/OCR, DOCX, automatic repository ingestion, Crossref retrieval, and arbitrary URL fetching are not implemented. The only external import is the fixed PMC service (`POST /api/cloudbite/pmc/import`, PMCID or DOI), which returns licensed verbatim sections as documents for the user to review; it is paced, serial and hourly-limited. Otherwise export relevant passages/tables to a supported text file; preserve source locations in that file.
- Original sandbox limits are unchanged: six normal turns and at most eight inference calls per expert, including final repair calls. The separate second pass adds at most three calls per project.
- Cross-review is opt-in, one paid attempt per project. Repeated completed/failed requests return the saved result without new calls; concurrent requests are rejected. A lost stale attempt is closed as failed on a subsequent authenticated project read or POST and is never automatically rerun.
- At most three completed reviewers are selected, preferring review/analyst/auditor roles. Each receives up to three other opinions; this is a **bounded partial review**, not an all-to-all discussion among 100 experts. Its verdicts are AI judgments, not calibrated correctness scores. A missing external source text should yield `insufficient`.

## Budget, memo and follow-up rounds (product v2)

- **Budget.** A stated `budget` (or the default: 8 calls per role plus review and memo earmarks) caps every Nosana call of the project in one ledger (`budget` key). Each expert turn, reviewer and memo call is reserved atomically before the request; a failed or lost call still counts and nothing is refunded. Two roles racing for the last pooled call get exactly one. A role that cannot afford even one call is reported as not started and gets no sandbox. Projects created before the ledger are migrated conservatively (unreadable counts = the full per-role cap); a v1 project with a corrupt ledger fails closed. Jev routing's two typed calls are disclosed separately (`usage.jevCalls`).
- **Preview.** `POST /api/cloudbite/preview` shows the team, the per-role assignments, the budget envelope and warnings before anything is reserved.
- **Decision memo.** On a finished, non-cancelled live project with at least one completed opinion, `POST …/memo` makes one paid attempt: the claim and its budget reservation are written before the call (`max_tokens` 8192, the only allowed override), the reply is parsed strictly against the supplied options/experts/references, and the result is committed only if the same claim is current, the token is still valid, the project is not deleted and the inputs (opinions, reviews, packets) are unchanged. Without decision options the outcome is a deterministic `needs-options` record and no call. Failed and stale attempts are never retried.
- **Follow-up round.** A brief with `revision: {parentId, changeSummary}` creates a new project bound to a parent the same actor may read in history; the parent itself is never modified. Each workspace receives the bounded previous round as `evidence/previous-round.json` with the rules in `WORKORDER.md`.

## Authority, isolation and retention

The create/route endpoints retain owner or approved-visitor authentication, strict same-origin checks, actor-bound routing caches, visitor quotas, and idempotent creation. Review requires the existing project capability plus same-origin JSON POST; owner status alone is not a project bearer capability. Provider credentials stay server-side.

All author/model text is untrusted data. No new command execution or arbitrary URL-fetch endpoint is introduced. Review results use a strict schema: the target must be an actual peer supplied to that reviewer and the evidence index must exist. No reviewer can review itself. Failures do not fabricate a report.

Project/history retention remains the existing policy (30 days with history, otherwise runtime retention). New decision data, documents, ledger-derived content, and review results follow the project. History deletion removes the new inputs, the second-pass key, the memo, sealed packets, retrieval audits, the stored previous round, assignments and the revision claim (the budget ledger stays as operational bookkeeping), and an in-flight review or memo response cannot recreate deleted content. Purge removes everything. This does not erase any model-provider copies governed by that provider's policy.

## API additions

`ProjectBrief` and routing queries accept optional `decision` and `documents` (see `src/cloudbite-contract.ts`). Missing fields preserve old payloads. The routing hash includes validated full optional data, not merely document names.

`ProjectRun.evidenceClaims` is generated from completed live opinions and their structural references. It is not generated by the browser demo.

`POST /api/cloudbite/projects/:id/review`, JSON body `{}`, project Bearer token, same-origin: starts or returns a saved cross-review. `GET /api/cloudbite/projects/:id` and authorized history detail include `crossReview`. Status is independent of the original project's run status. Replies preserve `execution: server-nosana`, snapshot hash, timestamps, reviewer IDs, target evidence indices, and supported/challenged/insufficient findings.

## Validation record

See the release evidence in `.artifacts/decision-workflow/` (ignored local artifacts). Contract and state-machine checks use synthetic input/fake providers; they are not a scientific-quality evaluation. Live/browser acceptance results are recorded separately after integration.

## Integration acceptance

The coordinator ran all 19 Cloudbite suites plus `npm run check` on the isolated integration checkout. New coverage includes real Python runner execution with actual curated, generic and STA workspaces, documented ASCII maxima and accepted multi-byte inputs, complete document tails and decision fields, history deletion during cross-review, and route/create payload parity. The old 46 KiB runner cap was independently rejected and repaired to the gateway-derived byte bound (252 KiB, with 4 KiB headroom under the 256 KiB gateway).

Browser checks used Aside for actual input/file/language actions. Because Aside did not expose viewport resizing and its screenshot command timed out, an isolated headless Chrome checked 1536x1024 and 390x844: file text and inputs survived KO/EN switching, no page errors or horizontal overflow. This did not use the user's Chrome profile.

Real-provider probes used only synthetic planning text. Jev evaluated all 120 roles with the full optional input; a Nosana evidence reviewer supported the explicitly supplied two-week budget and challenged an invented claim of measured 99% accuracy. These are smoke checks, not a scored scientific evaluation or calibrated quality guarantee.

A concurrent deployment changed the production Worker to v4 (CloudbiteComputer and CloudbiteComputerNested) while this release was under final review. The first upload was rejected because the isolated release checkout only knew v3; it did not replace the running version. Integration preserves the existing computer/desktop source, bindings, variables and v4 migration, rather than deleting/recreating namespaces or removing the running feature. The desktop gateway Worker itself is not redeployed by this workflow. The preservation snapshot and regression logs are retained in the local release artifacts.

Production acceptance: two actual Daytona expert sandboxes completed the synthetic Falsify planning question, with one uploaded Korean source file and a structured decision frame. The ledger contained nine evidence items (six structurally linked). The opt-in live Nosana second pass returned two reviewer reports / eight findings, while every original opinion/status remained byte-equivalent. KO/EN result views and read-only history displayed the saved review. A canonical-workspace alias omission observed in that first probe was then corrected; a separate real Nosana probe correctly recognised PROJECT.md as the provided brief rather than a missing upload.

Only the coordinator's synthetic QA record was deleted after evidence capture: it disappeared from the index and its detail returned 404. Both owning-account sandbox GETs returned 404, and all three Daytona accounts had zero project-labelled sandboxes. The final Worker release was `6247ef1c-d19d-4733-83c7-af70348fbf2c` (runtime commit `510b78c`); later documentation commits do not change that deployed runtime. Computer preservation checks also passed (six JS suites); the installer suite reported 11 executed passes and 5 Windows skips.
