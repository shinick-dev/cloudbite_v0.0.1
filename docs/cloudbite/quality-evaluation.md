# Cloudbite output quality evaluation

`tools/evaluate-cloudbite-quality.mjs` evaluates **recorded** Cloudbite project outputs offline. Schema tests
(`test/cloudbite-*.mjs`) already prove the product stores well-formed data; this harness asks a different question —
did the saved answer address the user's actual decision, keep evidence traceable, separate facts from assumptions,
reason about alternatives, give a conditional next step, and avoid claiming execution or sign-off it never had?

Open project decisions have no single correct recommendation, so the tool never produces a ground-truth verdict or
an aggregate pass/fail. It reports four separate layers per case and leaves quality judgment to named humans.

## What it reads and what it never does

- Input: saved Cloudbite exports — `HistoryDetail` JSON, the `{detail, acceptance}` wrapper written by the release
  scripts, or a bare `ProjectRun` — plus the case ID each export answers.
- Local regular `.json` files only, at most 8 MiB each and 20 per run. URLs are refused (nothing is fetched).
- No browser cookies, tokens or auth headers: `--token`, `--cookie`, `--authorization`, `--header`, `--session`,
  `--password` and `--live` are refused, as is any argument that looks like a credential.
- No model or network calls. There is no `--live` mode: the coordinator collects bounded real runs through the UI
  (for example with Aside) and feeds the exported JSON here. `automated.modelJudgment` is therefore always `NOT_RUN`.
- An input containing credential-like text (API keys, bearer tokens, private keys, cookie headers, JWTs) is refused.
  Possible personal data (e-mail addresses, resident numbers) is refused unless `--allow-private-local` is passed,
  which still writes only to the ignored local folder.
- Output defaults to `.artifacts/quality-eval/` (git-ignored). A tracked or unignored directory inside the repository
  is refused; a directory outside the repository needs `--allow-outside-repo`. Existing files are never overwritten
  without `--force`.
- The export is copied byte-for-byte to `original.json` next to the report; the source file is never modified.

## Usage

```
node tools/evaluate-cloudbite-quality.mjs evaluate --input RUN.json --case CASE_ID [--provenance observed-live|synthetic-qa|test-synthetic] [--ratings RATINGS.jsonl] [--out DIR]
node tools/evaluate-cloudbite-quality.mjs compare --input A.json --input B.json --case CASE_ID [--documented-difference "why"] [--out DIR]
```

Several `--input`/`--case` pairs can be evaluated in one call (one `--case` per input, or one for all).
Exit code 0 = reports written and every input is structurally valid and bound to its case; 3 = written but a schema
or case-binding mismatch, or a failed comparison; 2 = refused or error.

Sample invocation against the unified-release production run (run from the repository or worktree root):

```
node tools/evaluate-cloudbite-quality.mjs evaluate --input .artifacts/release-unify/production-run.json --case q-synthetic-falsify-pilot-qa --provenance synthetic-qa --out .artifacts/quality-eval/production-sample
```

That export is a **synthetic deployment QA** run (a smoke brief written for release verification), recorded from the
live service. Its report shows schema VALID, case binding MATCH, provenance `synthetic-qa`, human `NOT_SCORED`. It is
evidence that the evaluator reads a real recorded export end to end — **not a scored benchmark result or a quality
win**.

Per input the tool writes `<out>/<caseId>__<sha12>/`: `original.json`, `report.json` (machine-readable),
`report.md` (readable) and `scores.csv` (one row per layer/subject/check). `compare` also writes
`compare__<a>__<b>.json|.md`.

## The four layers

1. **Observed structure** (`observed`) — schema and stored-bound checks mirroring the runtime limits
   (`CLOUDBITE_BRIEF_LIMITS`, `CLOUDBITE_OPINION_LIMITS`, `DECISION_LIMITS`, `CB_CROSS_REVIEW_LIMITS`; the test fails
   if they drift), case binding (question/stage/material hashes must match the case), per-role status, and a
   **citation ledger**: `ids-present-content-unverified`, `invalid-citation` (unknown document/source ID),
   `cross-role-citation` (a knowledge ID that only another role may cite), `no-citation`,
   `abstention-without-citation` (an honest "not supplied" statement, which is not a factual error) and
   `unbracketed-reference`. ID presence means only that the ID exists; it is never "verified", and claim counts are
   not accuracy. Self-reported confidence is copied as self-assessment and used by no check. Stored cross-review
   verdicts and release acceptance are copied and labelled as model-written review / operational acceptance.
2. **Heuristic flags** (`heuristics`) — keyword triage against the case rubric: relevance (bilingual anchor
   coverage and whether any decision option is addressed — a fluent, confident answer about something else gets
   `relevance-warning`), stage reference, facts-vs-assumptions language, alternative/trade-off language, conditional
   next-step language, asserted (non-negated) execution or sign-off claims, rubric forbidden phrases (injected or
   invented figures), and for missing-info / contradictory cases whether the gap or conflict is acknowledged.
   Only computed when the structure is valid and bound to the case. A flag is a reason to look; no flags is not a pass.
3. **Automated / model judgment** (`automated`) — `NOT_RUN`. Reserved for a future, explicitly opted-in judge;
   any such annotation must stay separate from human scores.
4. **Human rubric scores** (`human`) — from `--ratings` JSONL rows:
   `{"caseId","inputSha256","reviewer","ratedAt","scores":{dimension:0-4|null},"notes"?}`. Dimensions:
   `relevance`, `evidence_traceability`, `facts_vs_assumptions`, `alternatives_tradeoffs`, `conditional_next_step`,
   `no_fabricated_signoff`. A row applies only to the exact input bytes it names (`inputSha256` = the report's
   `input.sha256`). Missing dimensions or missing reviews stay `NOT_SCORED` — never pass, never zero. Invalid rows
   are listed and ignored, not repaired. No aggregate is computed.

## Comparing two runs

`compare` evaluates both inputs and reports the variables that are meant to differ — `model`, `promptSetHash`
(role prompt hashes), `knowledgeRevisionHash` (role pack revisions), expert IDs — plus each input's SHA-256 and
provenance. It **fails** when the case IDs differ, the same file is passed twice, or question, stage or material
differ; a question/stage/material difference is accepted only with `--documented-difference` (≥10 characters), and
the result is then labelled `COMPARED_WITH_DOCUMENTED_INPUT_DIFFERENCE`. No winner is declared.

## Provenance

`--provenance` labels the input: `observed-live` (operator-declared recorded live run; the tool does not re-observe
it, and it flags a conflict if `brief.mode` is not `live`), `synthetic-qa` (deployment smoke brief), or
`test-synthetic` (a fabricated test input). Without it the report says `UNDECLARED`. All inputs built by
`test/cloudbite-quality-eval.mjs` are `test-synthetic`.

## Cases — `test/fixtures/cloudbite-project-quality.jsonl`

Ten authored held-out cases (`heldOut: true`) — five EDA project-planning and five Falsify software/research
project-planning — each one of: normal, missing information, misleading out-of-domain checklist, prompt injection in
a supplied excerpt, contradictory supplied excerpts. None contains clinical, dosing or chemical-experiment content.
Rubric anchors, forbidden phrases and notes are evaluation-only: they are not in runtime knowledge packs or prompts
(the test checks `src/` for case IDs and rubric notes). One non-held-out case, `q-synthetic-falsify-pilot-qa`,
matches the unified-release synthetic QA brief so a recorded export can be bound; it is a smoke case, not a benchmark.

## Remaining independent human review

The harness does not judge quality. Before any quality claim:

- Collect real recorded runs for the held-out cases (fresh project per case, recorded model and pack revisions) and
  evaluate them with `--provenance observed-live`. None are bundled; the fixture has none.
- Have at least one independent reviewer, who did not author the cases or the prompts, score every dimension per
  input with a timestamped ratings row. Every report lists still-unscored dimensions under
  `remainingHumanReview`.
- Check that cited text actually supports each claim (the ledger only checks ID presence) and that cross-review
  verdicts hold up.
- Review heuristic false positives/negatives: keyword anchors can miss paraphrases and can be satisfied by an answer
  that merely mentions the right words.

Tests: `node test/cloudbite-quality-eval.mjs`.
