# Human review import

`tools/cloudbite-human-review-import.mjs` turns regression-candidate JSON downloaded from the history view (one
person's 0-4 rubric review of one exact saved answer) into inputs for the offline evaluator: `cases.jsonl`, one
HistoryDetail export per answer, `ratings.jsonl` bound to each export's exact bytes, a batch `manifest.json` and
`human-issues.json`. It re-derives every hash and refuses files that do not bind. No network, model or cookies.

```
node tools/cloudbite-human-review-import.mjs --input A.json [--input B.json ...] [--out DIR] [--batch-id ID]
     [--provenance observed-live|synthetic-qa|test-synthetic] [--evaluate] [--force] [--allow-outside-repo] [--allow-private-local]
```

## Comparison scope

A before/after pair exists only between two answers that share **all** of:

- the same question, stage and material (same case id),
- the same role (`expertId`),
- the same reviewer, for issue and score deltas,

and come from **different projects**, the baseline being strictly older (`createdAt`).

Never paired:

- Two roles answering in the same run. They are separate unpaired entries with no baseline and no regression deltas;
  they are different experts, not a before/after.
- Several answers of one role inside one project. All of them stay unpaired and none is used as a baseline.
- Answers with the same `createdAt`, because their order is undefined.
- Ratings from different reviewers. The batch only compares a reviewer's own scores, and `compareHuman` gives
  `NOT_SCORED` for both issues and scores.

`compareHuman` returns `NOT_SCORED` with a `reason` whenever the role differs, the project is the same or the reviewer
differs. A dimension that either side left unset stays `NOT_SCORED`, and a review with no integer score adds no rating
row. `human-issues.json` records the `scope` text, the comparisons and every `unpaired` answer with its reason.
Differences are prompts for review. They are not accuracy figures and they do not pick a winner.

## Provenance is operator-declared

Candidate files are not server-signed. Matching hashes show that a file is internally consistent. They do not show
that a provider produced the answer, and `source.mode: "live"` is not evidence on its own. The importer therefore never
infers provenance. The operator declares it for the whole import:

| `--provenance` | Use for |
|---|---|
| `test-synthetic` (default) | Fixtures written by tests or by hand. Conservative default. |
| `synthetic-qa` | Answers from synthetic QA or deployment-smoke briefs. Operational evidence only. |
| `observed-live` | Real exports of observed production answers that the operator vouches for. |

The declaration is copied into every manifest entry (`provenance`, `baselineProvenance`) and into
`human-issues.json` (`provenance.basis: operator-declared … not a cryptographic provider proof`). Export bytes and
hashes do not depend on it. The batch never pools these classes, and none of them counts as held-out proof.

## Tests

- `node test/cloudbite-v5-human-review-import.mjs` uses test-synthetic fixtures only. It covers two roles in one
  project, the same role across two projects, different reviewers, mixed and partial scores, duplicate same-project and
  equal-time answers, and default, explicit and invalid provenance.
- `node test/cloudbite-v5-human-review.mjs` runs the end-to-end export → import → batch path against the in-process
  backend, also with test-synthetic answers.
