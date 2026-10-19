# Cloudbite quality pilot — collection hand-off

Hand-off from the quality batch workflow (`tools/cloudbite-quality-batch.mjs`, see `quality-evaluation.md`) to whoever
runs the actual paid smoke through the authenticated Cloudbite UI. The batch tool itself never collects: it has no
network, browser or provider access and must not be given credentials. Collection is a separate, operator-performed
step; evaluation is offline.

## 1. Collect (operator, authenticated UI — paid)

1. For each case to sample, start a **fresh** project in live mode whose brief is the case's `brief` from
   `test/fixtures/cloudbite-project-quality.jsonl` exactly (title, objective, context, stage, decision frame, documents).
   Any edit changes the question/material hash and the export will not bind (`case-binding-mismatch`).
2. Wait until the project is terminal (`completed`, `partial`, `failed` or `cancelled`). Exports of a running project
   are accepted but report timing as `UNAVAILABLE` and roles as `not-terminal-at-export`.
3. Save the history detail as returned by `GET /api/cloudbite/history/<project>` (or the release scripts'
   `{detail, acceptance}` wrapper) as a `.json` file. Save the response body only — never headers, cookies or tokens.
   Do not edit, pretty-print or re-save the file after collection: ratings bind to its exact SHA-256.
4. Put all exports and the manifest in one local folder under an ignored path, for example
   `.artifacts/quality-pilot/<batchId>/`. No symlinks or junctions inside it.
5. Record how each file was collected in the entry's `collection` (who/when/how). It is copied as operator-supplied
   and unverified.

Failed or partial runs are kept, not re-run silently: they are the input to the run-failure taxonomy.

## 2. Manifest

```json
{
  "version": "cloudbite-quality-batch/v1",
  "batchId": "pilot-2026-10-19",
  "entries": [
    { "caseId": "q-eda-signoff-scope", "input": "q-eda-signoff-scope.live.json", "provenance": "observed-live",
      "collection": { "collectedAt": "2026-10-19T10:00:00Z", "method": "UI export after terminal status", "note": "fresh project" } },
    { "caseId": "q-synthetic-falsify-pilot-qa", "input": "smoke.json", "provenance": "synthetic-qa",
      "baseline": "smoke-previous.json", "baselineProvenance": "synthetic-qa" }
  ]
}
```

- At most 20 entries. Provenance must be declared per file; `observed-live` is only a declaration and is reported as
  `observed-live-conflict` if the export's `brief.mode` is not `live`.
- `observed-live` on `q-synthetic-falsify-pilot-qa` (not held out) is classed `observed-live-smoke`: it shows the
  pipeline ran, not held-out quality.
- A `baseline` is compared only with a candidate of the same case, question, stage and material.

## 3. Evaluate (offline)

```
node tools/cloudbite-quality-batch.mjs run --manifest .artifacts/quality-pilot/pilot-2026-10-19/manifest.json --out .artifacts/quality-batch --seed <private seed>
```

Output: `.artifacts/quality-batch/<batchId>/` with `summary.*`, `failure-taxonomy.*`, `cases/`, `comparisons/`,
`review/packet-NN.md`, `review/rating-template.jsonl`, and `blind-mapping.json`. Exit 2 means refused (credential-like
text, personal data without `--allow-private-local`, bad path, existing output without `--force`); fix the input,
do not edit the tool's checks.

## 4. Human review

1. Give reviewers the `review/` folder only — not `blind-mapping.json`, `summary.*` or `cases/`.
2. Each reviewer copies `rating-template.jsonl`, fills in their own `reviewer` and `ratedAt` (ISO time of rating),
   scores 0-4 or leaves `null`, and returns it. Nobody fills these on a reviewer's behalf; blank rows are rejected and
   stay `NOT_SCORED`.
3. Concatenate returned files and re-run with `--ratings ratings.jsonl --out <new dir>` (or `--force`). Human regressions
   between baseline and candidate appear only for dimensions the same reviewer scored on both exact inputs.

## Limits

- USD cost is `UNKNOWN`: exports record reserved call counts, not priced token usage. Use the provider's billing
  for spend; do not back-compute it from call counts.
- Durations come from stored timestamps (`createdAt`→`updatedAt`, first activity→role `updatedAt`) and include queueing;
  they are not model latency.
- Heuristic flags and citation ID checks are triage, not truth labels. Synthetic QA and test inputs are not
  held-out proof. No step here produces an accuracy figure or a winner.
