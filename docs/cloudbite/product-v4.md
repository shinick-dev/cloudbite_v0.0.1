# Cloudbite: evidence support, calculation reproduction and quality batches

This increment keeps the original opinions and their self-assessed confidence unchanged. It adds three distinct
ways to examine a project decision; none is a factual-accuracy score.

## Claim-to-text support

The existing opt-in cross-review call now receives an application-built packet of cited passages. A finding can
record `supported`, `partial`, `contradicted` or `insufficient`, with a rationale and up to three verbatim quotes.
The server checks quote identity, exact substring, source hash and evidence-slot binding. Semantic support remains
the reviewer's model judgment. An exact quote can still be irrelevant or the source itself wrong.

The console distinguishes supplied documents, user project statements, imported original excerpts and curated
summary cards. Role search does not newly fetch original web pages. A missing source is a gap, not contradiction.
The packet covers at most six evidence slots and 24 KiB per reviewer. Selection/omissions are included in the model
input, and each stored assessment identifies its packet and text availability. This is selective evidence review,
not exhaustive review of every sentence. Previously saved reviews stay unchanged and may have no assessment.

No new model calls are introduced. The expanded quotation-bearing schema uses a fixed server output allowance of
4096 tokens per reviewer (previously 1200); existing maximum three reviewer calls and project call ledger remain.
This can increase the token usage of a review. A malformed reply fails explicitly; there is no automatic paid retry.

## Calculation reproduction

After a live project finishes, open **Claims and evidence → Reproduce a calculation** (KO: **주장과 근거 → 계산 재현**).
Choose a formula and optional variables, or a stored CSV and exact numeric column name. The server runs a bounded
deterministic parser; this endpoint cannot execute Python, shell commands or arbitrary code. The existing independent
sandbox Python tool is preserved.

`POST /api/cloudbite/projects/:id/quantitative` uses the existing project bearer, same-origin JSON and retention
rules. Body:

```json
{"request":{"kind":"arithmetic","expression":"required-arrival","variables":{"required":{"value":0.99,"unit":"ns"},"arrival":{"value":1.0,"unit":"ns"}}}}
```

CSV:

```json
{"request":{"kind":"csv-summary","column":"wns_ns"},"source":{"kind":"artifact","expertId":"EXPERT_ID","path":"out/qor.csv"}}
```

`source` may instead be `{"kind":"document","id":"doc-1"}` for a supplied `.csv` document. The server resolves
only this project's completed expert metadata or brief documents; callers cannot supply CSV text or a source hash.
The record binds the actual stored text hash. CSV summaries report included and excluded rows; CSV units stay unknown.
Formula literals are dimensionless and compatible units are normalized to base units. API arithmetic also supports
explicit expected-value comparison and one-variable ±delta sensitivity; see `quantitative-checks.md` for their schema.

Records include exact request, result, source binding and server time. Identical requests over the same source
deduplicate, including concurrent retries. At most 20 distinct records are retained per project. There is no model
or sandbox call and no effect on the model-call budget. A computation error is a recorded error, never completion
of an expert task. Calculation does not prove input truth, data completeness, experimental validity or sign-off.

Current-run UI can create checks; history is read-only. KO/EN switching preserves the draft. A lost response is
shown as unknown/failed rather than a fabricated saved record; reloading retrieves records and identical resubmission
is idempotent. Deleting history removes calculation records atomically with the other derived data; a late write
cannot restore them. Calculations do not automatically rewrite a saved review, memo or follow-up round.

## Quality evaluation

`npm run evaluate:cloudbite:batch -- run --manifest MANIFEST.json --out .artifacts/quality-batches/NAME`
reads bounded, local recorded exports and preserves the exact originals. See `quality-pilot.md` for collection and
manifest format. No network or paid inference is hidden in this tool. It separates held-out observed runs, deployment
smoke runs and fabricated test data, and leaves human ratings `NOT_SCORED` until a reviewer supplies them.

Reports show completion/failures, recorded durations including queueing, recorded call reservations and a failure
taxonomy. Durations are not provider latency, reserved calls are not billed tokens, and USD costs remain UNKNOWN.
Blinded review packets and blank rating templates are bound to exact export bytes. Baseline comparisons require
the same case/question/stage/material and do not automatically declare a quality winner.

## Checks

- `npm run check`
- `npm run test:cloudbite:v4` — source binding, deterministic numerical cases, offline batch, real router/DO over
  memory storage, and generated UI over a fake DOM. Provider calls in these tests are mocked.
- `npm run test:cloudbite` — required regression suite; platform-dependent skips must be reported as skips.

Real Daytona/Nosana trials and independent human rubric scores are separate evidence from these tests. Neither a
mock-provider integration pass nor a production synthetic smoke is a scored held-out benchmark.
