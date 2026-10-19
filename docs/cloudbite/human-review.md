# Human review → regression candidates

A person who ran a live project can score each completed role answer on the same
0–4 rubric the offline evaluator uses (`cloudbite-quality/v1`), mark structured
problems, and export that answer as a versioned regression candidate. The score
is **a person's judgment of one exact answer**. It is not model truth, accuracy,
a pass, or a release gate. Reviews are **not blind**: the reviewer sees the role,
model and self-reported confidence.

## Where it lives

- Source: `src/cloudbite-human-review.ts` (versions, rubric mirror, parsing,
  hashes, export), stored by `src/cloudbite-project.ts` as a sidecar key
  `humanreview:<expertId>` in the project Durable Object. Opinions, the six-key
  feedback rows and the original review/source objects are never modified.
- UI: history detail → each completed role → collapsed **Human review (your
  score)** / **사람 평가 (내 점수)**. It names the rated material (that role's
  summary, evidence, assumptions, next actions and report shown above) and the
  first 16 hex characters of the output hash.
- The existing helpful/unhelpful feedback stays separate; a rubric review never
  writes it and vice versa.

## Binding

`outputSha256 = sha256(canonical({v:'cloudbite-human-review-output/v1', projectId,
expertId, questionHash, stage, materialHash, answerSha256}))`, where
`answerSha256` covers the stored opinion and report. A review is saved only when
the client's `outputSha256` equals the server's current value for that answer.
Actor and time are set by the server (`recordedBy: 'project-user'`); exports carry
only a one-way `reviewer-<16 hex>` label, never the cookie, token or actor id.

## API (same origin, JSON)

| Request | Result |
|---|---|
| `GET /api/cloudbite/history/<id>` | detail now includes `humanReview: {version, rubric, dimensions, issues, outputs, reviews, canReview}` |
| `POST /api/cloudbite/history/<id>/human-review` | body `{expertId, outputSha256, requestId, baseRevision, scores, issues, comment, regressionCandidate}` (≤16 KiB) |
| `GET /api/cloudbite/history/<id>/human-review?expertId=x` | `cloudbite-regression-candidate/v1` JSON for a saved review |

- `scores` must list all six dimensions, each `0–4` or `null` (= NOT_SCORED).
  At least one score, issue or comment is required. Issues: up to 6 of
  `factual-error, unsupported-claim, missing-source, misread-material,
  missing-alternative, unsafe-next-step, fabricated-execution, too-generic,
  off-topic, other`, each with an optional ≤300-character comment; overall
  comment ≤1000 characters.
- 400 malformed · 403 owner writing another user's record (owners may read) ·
  404 unknown, expired, deleted, foreign-to-visitor, or unknown expert · 405 ·
  415 non-JSON · 409 stale output hash, `baseRevision` mismatch, project not
  finished, answer not completed, or a reused `requestId` with different
  content. 409 responses include the current saved review (or `null`).
- Idempotency: the same `requestId` with the same content returns the stored
  review (`replayed: true`) without a new revision. Writes run inside a storage
  transaction, so concurrent saves with the same base revision produce one
  winner and one 409.
- Deleting the record or its expiry purge removes reviews with the project; late
  writes return 404 and nothing is resurrected.

## Console behaviour

- Drafts live only in tab memory, keyed by project and role. They survive KO/EN
  switches, re-renders and failed saves; they are cleared on delete, sign-out or
  identity change.
- Statuses: saving · saved (revision + server time) · conflict (shows the saved
  values, keeps the draft, next save targets the shown revision) · stale ·
  not confirmed (retry resends the **same** `requestId`; changing the draft
  makes a new one) · signed out · not own · gone · invalid.
- Reload shows the persisted review. Read-only viewers see the saved score but
  no form. **Download regression JSON** appears only after a save.

## Offline importer

```
npm run evaluate:cloudbite:human -- --input candidate.json --provenance observed-live --out .artifacts/human-review-import --evaluate
```

It re-verifies every hash, keeps the latest revision per output, writes
HistoryDetail exports, `cloudbite-quality-batch/v1` manifests and rating files bound to the export bytes. Baselines
require the same question, stage, material and expert role in a different, strictly earlier project; different roles
in one run remain unpaired. Ratings are written
only when a person scored at least one dimension; unscored dimensions stay
`NOT_SCORED`. `--evaluate` runs the existing batch, so before/after comparisons
use the same question and rubric and only the same reviewer's scores are
compared. The importer never generates scores; it converts the explicitly saved reviewer annotations. It
refuses credential-looking content and paths outside the repo unless told
otherwise.

Provenance is operator-declared, with a conservative `test-synthetic` default. Declare `observed-live` only for actual
production answers; use `synthetic-qa` for UI simulations. Content hashes establish internal consistency, not provider
origin. See `human-review-import.md` for pairing, provenance and import refusal rules.

## Core-claim findings (shared UI)

If a cross-review report carries the optional `claimFindings` (≤3 per report, ≤6 including evidence findings:
`{targetExpertId, target:{kind:'summary'|'assumption'|'nextAction', index, quote},
verdict, issue, rationale}`), the console checks the shape and shows them under
**Core-claim checks**; a malformed list is dropped for that report with a notice,
leaving evidence verdicts intact. The author-response button also opens when a
`supported` evidence verdict carries claim support `partial`, `contradicted` or
`insufficient`, or a core finding is `challenged`/`insufficient`. The server planner and console both support those
cases, retaining the ordinary verdict and the source reading separately. Core quotes must occur in the named field;
the server rechecks the parent authorization and exact target before preparing a new child project.

## Limits

- Same-person, same-model, non-blind judgments; no inter-rater agreement.
- Run `npm run test:cloudbite:v5` for the focused integration regressions. Synthetic QA scores are test data, not a
  completed human quality evaluation of the revised model prompts.
