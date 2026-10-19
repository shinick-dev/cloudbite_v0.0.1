# Retrieval evaluation (v8 licensed corpus)

`tools/cloudbite-rag-eval.mjs` measures saved corpus-search results offline. It reads three things: an authored
query set, the licensed corpus index, and one or two saved retrieval runs. It re-derives every hash, then reports
recall@3, MRR, role leakage, invalid source/chunk citations, no-hit counts and degraded counts. It does not fetch
anything, embed anything or call a model.

```
node tools/cloudbite-rag-eval.mjs validate [--queries Q.jsonl] [--index INDEX.json | --index-module src/cloudbite-corpus.generated.ts]
node tools/cloudbite-rag-eval.mjs evaluate --run CANDIDATE.json (--index INDEX.json | --index-module src/cloudbite-corpus.generated.ts)
     [--index-export CORPUS] [--baseline BASELINE.json] [--queries Q.jsonl] [--out DIR] [--force] [--allow-outside-repo]
node tools/cloudbite-rag-eval.mjs template [--queries Q.jsonl] [--out DIR] [--force]
```

The defaults are `--queries test/fixtures/cloudbite-rag-queries.jsonl` and `--out .artifacts/rag-eval`.

## What the numbers mean, and what they do not

- **Relevance is an annotation, not truth.** `relevantSourceIds` lists the sources a named operator judged relevant
  after reading them. The report says `relevance.truth: false`. A high recall@3 means the search found the sources
  that this annotator picked. It does not show that the sources support any claim, or that the answer was good.
- **Unannotated means null.** If a query has no annotation (`relevance.status: "pending"`), its recall@3 and
  reciprocal rank are `null`. They are never `0` and never counted as success. A run where no query is annotated
  shows `meanRecallAt3: null, mrr: null` and the note `NO_RELEVANCE_ANNOTATION`.
- **Advice quality stays with humans.** Every report has `adviceQuality.status: PENDING_HUMAN_REVIEW` and
  `winner: null`. The tool never makes up scores and never picks a winner. Retrieval deltas are prompts for review.

Definitions (also written into each report under `metricDefinitions`):

| Metric | Definition |
|---|---|
| `recallAt3` | Distinct annotated-relevant source IDs among the valid, role-eligible hits at ranks 1-3, divided by the number of annotated-relevant sources. |
| `reciprocalRank` | 1 / hit rank of the first valid, role-eligible hit from an annotated-relevant source; `0` when there is none. `mrr` is the mean over annotated queries that have a result. |
| `roleLeakHits` | Hits from a source whose `roles` do not include the query's `expertId`. They are never credited. |
| `invalidCitationHits` | Hits whose chunk ID, source, parent/heading location, chunk `sha256` or exact text do not match the verified index, or whose source is not listed in `result.sources` with metadata that matches the index exactly. They are never credited. `invalidSourceRecords` counts the listed source records that are unknown or carry false metadata. |
| `noHit` / `degraded` | Results with zero hits / results with a non-null `degraded` reason (for example the `corpus-lexical/v1` fallback). Reasons are tallied in `degradedReasons`. |

Means are over queries, rounded to 6 decimals.

## Inputs

**Query set** (JSONL, at most 256 KiB and 200 lines). One object per line with `caseId`, `expertId`, `query`
(1-1000 characters, the same bound the runner search uses), `relevantSourceIds` and `relevance`. The optional fields
are `suite`, `heldOut`, `provenance`, `purpose` and `authoring`. Unknown keys are refused, so an expected answer
cannot be added by accident. `relevance.status` must be one of:

- `pending`: `relevantSourceIds` must be empty.
- `annotated`: needs at least one source ID, `annotatedBy`, an ISO `annotatedAt` and a `basis` that says how the
  sources were reviewed.

When an index is given, every annotated source must exist in the corpus and must be eligible for the query's role.
If not, the run is refused, because that label could never be met.

The query identity is `sha256(canonical({caseId, expertId, query}))`. The set identity `querySetSha256` covers every
`[caseId, expertId, queryHash]`. Annotations are hashed separately as `annotationSetSha256`, so adding source IDs
later does not change the query set that runs were recorded against.

**Corpus index.** This is the `CorpusIndex` from `src/cloudbite-corpus-contract.ts`, given either as:

- `--index` a local JSON file (at most 64 MiB), or
- `--index-module` a TypeScript module under `src/`, normally `src/cloudbite-corpus.generated.ts`. It is bundled
  in-process with esbuild, as the build tools do, and the tool reads its `CORPUS` export (`--index-export` picks
  another export).

The tool re-derives the identity the importer and the search engine use:

- each source `sha256` and chunk `sha256` over its exact text,
- every chunk is an excerpt of its own source,
- each vector has 256 finite numbers,
- the index `sha256` is computed over canonical `{chunks, dimensions, model, schema, sources}` without its own hash.

Any mismatch refuses the evaluation. The report records `indexSha256`, the source/chunk counts, a `sourceSetSha256`
(id, hash, license, roles) and where the index came from.

**Saved run** (`version: "cloudbite-rag-run/v1"`, at most 4 MiB):

```json
{ "version": "cloudbite-rag-run/v1", "runId": "candidate-hybrid", "provenance": "observed-live",
  "querySetSha256": "<64-hex from validate>",
  "retrievalConfig": { "rrfK": 60, "maxHits": 3, "perSource": 2, "similarityFloor": 0.4 },
  "identities": { "promptSetHash": "<64-hex>", "instructionSetHash": "<64-hex>", "knowledgeRevisionHash": "<64-hex>" },
  "collection": { "method": "how it was recorded", "note": "..." },
  "results": [ { "caseId": "v8-rag-eda-01", "expertId": "probably-primetime-sta", "queryHash": "<64-hex>",
                 "result": { "schema": "cloudbite.corpus-search/v1", "indexSha256": "...", "strategy": "hybrid-rrf/v1",
                             "model": "text-embedding-3-small", "matched": true, "degraded": null, "sources": [], "hits": [] } } ] }
```

- `result` is the exact `CorpusSearchResult` that the search returned, with at most 10 hits. Metrics use ranks 1-3.
- The operator declares `provenance` (`observed-live`, `synthetic-qa` or `test-synthetic`). It is reported as
  operator-declared and never inferred.
- `retrievalConfig` is hashed into `retrievalConfigSha256`.
- `identities` holds the prompt, instruction and knowledge identities from the quality evaluator's export
  fingerprint. They are echoed next to the corpus identity, so one report names the corpus, the retrieval config and
  the prior prompt/instruction identities together. They are only used when supplied.
- Credential-like content refuses the file.

## Binding and refusal

A run is **refused as a whole** (`status: REFUSED`, `metrics: null`, exit code 3) when any of these hold:

- its `querySetSha256` is not the query set's,
- a result names an unknown case,
- a result's `expertId` differs from the query's role,
- a result's `queryHash` does not match the authored query text,
- a result's `indexSha256` is not the verified index.

A query with no result is listed under `missingResults` and given null metrics. It is not scored as a miss.

A **paired comparison** (`--baseline`) is `REFUSED` in any of these cases:

- either run was refused,
- the query sets differ,
- the corpus index identity differs,
- a case has a different role or query,
- both sides are the same file.

Different strategies, retrieval configs and prompt/instruction identities are allowed. They are listed under
`variables`, so that a reviewer can see what changed. Queries missing from the baseline are disclosed in
`missingBaselines` and left out of the paired means. Without `--baseline` the comparison is `BASELINE_MISSING`.
Paired means use only queries that are annotated and present on both sides. If there are none, retrieval is
`NOT_SCORED`.

## Output

Output is `<runId>[__vs__<baselineRunId>].json` and `.md` in a git-ignored folder. A folder outside the repository
needs `--allow-outside-repo`. Existing files are only replaced with `--force`. Everything is read and checked before
the first write.

- By default the report holds IDs and hashes only. It holds no query text, no chunk text and no project material.
- `contentSha256` covers the whole report except `generatedAt`, so the same inputs give the same hash.

Exit codes: 0 written and every run evaluated; 3 written with a refused run or comparison; 2 refused before writing.

## Held-out query fixtures

`test/fixtures/cloudbite-rag-queries.jsonl` holds 10 held-out retrieval queries:

- EDA: timing closure after ECO, constraint trust, MMMC scenario choice, resizing/buffering repair, and ideal vs
  propagated clocks.
- Falsify: abstract vs full-text claim support, the causes of false findings, multiple testing and selective
  reporting, recording claim support, and publication bias.

The roles are the corpus role IDs (`probably-primetime-sta`, `cb-role-075`, `cb-role-076`, `cb-role-101`,
`cb-role-105`, `cb-role-106`, `cb-role-118`).

The queries were **written by the evaluation agent** before it saw any corpus source or search output
(`authoring.humanReviewed: false`). They are evaluation-only: never indexed, never put in a runtime corpus and never
used to tune ranking parameters.

All ten are `relevance.status: "pending"` with an empty `relevantSourceIds`, because no corpus source IDs had been
reviewed when they were written. So any evaluation today reports null recall/MRR and only the leakage, citation,
no-hit and degraded counts.

### Adding relevance annotations (human step)

1. Build or regenerate the corpus. Then read the licensed source texts themselves (`knowledge/cloudbite-corpus/`),
   not search output.
2. For each query, list the source IDs a careful reader would need. Each one must be eligible for the query's role.
   Set `relevance` to `{"status":"annotated","annotatedBy":"<reviewer>","annotatedAt":"<ISO>","basis":"<what was read and why>"}`.
   Never copy IDs from a search result: that measures the search against itself.
3. Run `node tools/cloudbite-rag-eval.mjs validate --index-module src/cloudbite-corpus.generated.ts`. It refuses IDs
   that are not in the corpus or not eligible for the role.
4. Annotations change `annotationSetSha256` only, so saved runs stay bound to the same `querySetSha256`. Report
   annotation changes together with any metric you quote.

## Recording runs and comparing advice

1. Run `node tools/cloudbite-rag-eval.mjs template`. It writes two files to `.artifacts/rag-eval/`:
   - `retrieval-run.template.json`: the query set hash and each `queryHash`, with `result: null`. An unfilled
     skeleton is refused, so replace each `null` with the saved `CorpusSearchResult` from the run you record.
   - `quality-batch-manifest.json`: a `cloudbite-quality-batch/v1` manifest for the two full project-advice cases
     in `test/fixtures/cloudbite-expert-workflow.jsonl` (`v7-eda-closure`, `v7-falsify-evidence`), with
     candidate/baseline paths and `observed-live` provenance placeholders.
2. Save one retrieval run per configuration (for example baseline `corpus-lexical/v1` or the pre-corpus build, and
   candidate `hybrid-rrf/v1`) against the same index, then compare them:
   `node tools/cloudbite-rag-eval.mjs evaluate --index-module src/cloudbite-corpus.generated.ts --run cand.json --baseline base.json`.
3. For advice quality, record one fresh project export per case and configuration. Keep the model, question, stage,
   materials and roles fixed, so that only the retrieval differs. Save the exports next to the manifest as
   `candidate/<caseId>.json` and `baseline/<caseId>.json`, fix the `collection.method` text, and run:
   `node tools/cloudbite-quality-batch.mjs run --manifest .artifacts/rag-eval/quality-batch-manifest.json --cases-file test/fixtures/cloudbite-expert-workflow.jsonl --seed <private>`
4. Reviewers fill the batch's blinded `review/rating-template.jsonl`. Re-run with `--ratings`. History-view
   regression candidates go through `tools/cloudbite-human-review-import.mjs` (`docs/cloudbite/human-review-import.md`).
   Ratings, schemas and blinding are the existing ones; this tool does not duplicate them and collects no model
   answers.

Until rating rows exist, held-out advice quality is **pending human review**. A retrieval improvement alone is not
an advice-quality claim.

Tests: `node test/cloudbite-v8-rag-eval.mjs`.
