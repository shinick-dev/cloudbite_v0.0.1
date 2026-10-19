# Source review flow (v5): claimSupport and core claims after the cross-review

Pure helpers in `src/cloudbite-author-response.ts` and `src/cloudbite-memo.ts`. No network, storage, clock or model
call; nothing runs automatically and nothing is retried. Test: `node test/cloudbite-v5-source-flow.mjs`.

## What flows where

| stored in the parent cross-review | author-response plan / workspace | final memo |
|---|---|---|
| `findings[].verdict` | kept exactly as stored (`verdict`) | kept (`crossReview[].findings[].verdict`, `ordinaryVerdict`) |
| `findings[].claimSupport` | re-checked copy as `sourceAssessment` | `coverage.sourceAssessments` + prompt `sourceAssessments` |
| `claimFindings[]` (core claims) | `kind: 'core-claim'` findings | `coverage.coreClaims` + prompt `coreClaimFindings` |

A source assessment is one reviewer model's reading of cited text (`basis: 'model-assessment'`); the only server
check was that each quote is an exact substring of a supplied passage (`quoteCheck: 'exact-substring'`). It is never
truth, verification or calibrated accuracy, and it never replaces or recounts the ordinary verdict.

## Stored-data re-check (`readStoredClaimSupport`, `readStoredCoreClaimFinding`)

The packet is not stored, so the quote check cannot be re-run. Stored readings are re-checked for shape and internal
consistency only: exact keys, known status / `textOrigin` / `citedText`, 64-hex `packetSha256` and `sourceSha256`,
at most 3 quotes of 8-300 characters with `endOffset - startOffset === quote.length` and lines >= 1, no repeated
quote, a quote for every status other than `insufficient`, and `insufficient` with no quote when the cited text was
`unavailable` / `uncited` / `not-in-packet`. Readings of one report that name different packets are all treated as
foreign. Core claims: exact keys and enums, target author other than the reviewer and among completed authors,
summary index 0 (others zero-based and in range), and a non-empty quote of at most 300 characters that is an exact
substring of the field's FULL current text (otherwise `stale-core-target`). Both helpers live in the author-response
leaf so the browser build never imports the memo module; `cloudbite-memo` re-exports them.

## Author response eligibility

| ordinary verdict | stored claimSupport | result |
|---|---|---|
| challenged / insufficient | none | eligible (v1, unchanged id) |
| challenged / insufficient | valid | eligible; `eligibleBy` `verdict` or `verdict-and-source-assessment`; `sourceConflict` when reading is supported |
| challenged / insufficient | malformed / foreign | eligible by verdict only; `sourceAssessmentDropped: 'malformed'`; v1 id |
| supported | none or valid `supported` | not eligible (counted in `supported`) |
| supported | valid partial / contradicted / insufficient | eligible, `verdict: 'supported'` kept, `eligibleBy: 'source-assessment'`, `sourceConflict: true` |
| supported | malformed / foreign | not eligible, excluded `malformed-source-assessment` |

Core claims: `challenged` / `insufficient` are eligible; `supported` is counted only. At most 3 per report and 6
evidence + core per report (`over-core-bound`, `over-finding-bound`). The usual reviewer/self/foreign checks apply
to every new path, and authorization is still the caller's own server-side history read (a foreign actor gets 404).

Counts: `crossReview.findings` / `supported` keep their v1 meaning. `crossReview.sourceAssessments`
(`assessed`, `malformed`, `conflicts`, `supportedWithSourceGap`) and `crossReview.coreClaims` (`findings`,
`supported`, `eligible`) appear only when such data was stored.

Ids: v1 findings keep the v1 id. A finding with a valid reading adds `'claim-support', sha256(canonical assessment)`
to the id input. A core finding id hashes version, parent, snapshot, reviewer, target author, `'core-claim'`, kind,
index, quote, `textSha256` (sha256 of the full field text), verdict, issue and rationale. Data without the new
fields produces a byte-identical v1 plan (same `planSha256`; checked against base 18d73db in the test).

Plan / workspace bounds: a copied assessment is at most 3 KiB (rationale cut to 800 bytes on code points, then whole
trailing quotes dropped — kept quotes stay exact; omissions listed). Core `targetText` is cut to 800 bytes; the quote
travels whole in `target.quote`. Workspace bound raised to 48 KiB. Order per author: challenged, insufficient,
supported-with-gap; reviewer order; evidence (by index) before core (summary, assumptions, next actions).

Work order rules add a source-reading line and a core-target line only when the author's own findings have them;
replies use the same strict `{findingId, disposition, rationale}` schema.

## Memo

`coverage.sourceAssessments` (only when a finding carried a `claimSupport` key): counts of assessed / malformed /
not assessed, per-status counts, conflicts, gaps, and up to 16 KiB of whole items (`ordinaryVerdict`, `sourceStatus`,
`citedText`, `gap`, `conflict`, exact quotes with `ref` / `textOrigin` / `sourceSha256` / offsets / lines, rationale,
`packetSha256`); `omitted` counts items left out. The stored memo keeps this coverage. The prompt gets the same items
(compact quotes) and a rule: not verification, keep the ordinary verdict, name conflicts and leave both standing, a
gap is never a contradiction, curated-card is a paraphrase. Core claims go in `coreClaimFindings` (6 KiB) without
refs. Legacy reviews leave the prompt and coverage unchanged.

Both sections live inside the unchanged 160 KiB global prompt bound (`CB_MEMO_PROMPT_MAX_BYTES`). When either is
present, its actual prompt bytes (rows, model-facing counts, system rule, plus 128 B slack) are reserved out of the
80 KiB expert section before the per-expert fair share is computed, so a maximum-shaped team (100 Korean roles at
the field bounds, 6 documents, 3 full reports, packets, provenance) gets a smaller share, disclosed per expert as
truncation, instead of overflowing. Ordinary 5-10 role projects keep the 3 KiB per-expert cap and an identical expert
section; prompts without annotations are byte-identical to the pre-repair builder (`test/cloudbite-v5-memo-bound.mjs`).

## Console and limits

`normalizeAuthorPlan` reads the server's leaf shapes: an evidence finding keeps
its ordinary verdict (`supported` only beside a non-supported, well-formed `sourceAssessment`, with `eligibleBy` /
`sourceConflict` re-derived and required to match) and `kind: 'core-claim'` findings keep target kind/index/quote/
`textSha256`, `targetText` and issue. Malformed shapes are unreadable; the server validates role authority and current
target text before issuing the plan. No text or index is invented. The child view and Markdown report show both readings (EN/KO), the exact quotes and
the "model reading, not verification" note. Core-claim checks are read only within the server bounds (≤3 per report,
≤6 with evidence findings; otherwise only the core part is disclosed as unreadable), and the "ask authors" button
requires the quote to occur in the named summary/assumption/next-action slot (the server re-checks).
Test: `node test/cloudbite-v5-author-plan-ui.mjs` (server-built plans, fake DOM).

The stored memo coverage includes source/core counts and omissions; the console does not yet render that entire
coverage table. Stored source readings are shape-checked by downstream consumers; the original review packet is not
stored for rechecking quotations there. These are model readings, never truth or a source-authenticity guarantee.
