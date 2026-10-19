# Claim-to-cited-text support (cross-review)

Pure helpers in `src/cloudbite-claim-support.ts`, wired into `src/cloudbite-cross-review.ts`. No network, no storage,
no extra model call: the support assessment rides inside the existing opt-in cross-review reply (at most
`CB_CROSS_REVIEW_MAX_REVIEWERS` calls per project, unchanged). Integration (project DO, API, UI) is owned by the
coordinator; this page lists the hooks.

## What it is, and what it is not

A reviewer model reads exact server-held passages that a peer's evidence item cites, and states whether they
`supported` / `partial` / `contradicted` / `insufficient` the claim, quoting the passage. The server checks only that
each quote is an exact substring of a known passage that is bound to the same evidence slot.

- The status is **one model's reading** (`basis: 'model-assessment'`). It is not truth verification, not a majority,
  and not a calibrated accuracy figure. `quoteCheck: 'exact-substring'` names the only mechanical check performed.
- A citation ID, a source title, URL or license is **metadata, never support**. Source records never become passages.
- No URL is fetched. Only text the server already holds is used.

## Original vs curated text (`textOrigin`)

| textOrigin | where the text comes from | is it the original source wording? |
|---|---|---|
| `user-document` | `brief.documents[].content` cited as `[doc:ID]` | user's own text (user statement) |
| `imported-original-excerpt` | a brief document whose `origin` is a PMC OAI-PMH import | original article wording the user imported earlier; not re-fetched, still user-supplied |
| `workspace-field` | `[source:PROJECT.md]` / `[source:DECISION.md]`, rendered from brief fields | user statement |
| `curated-card` | a bound `EvidencePacket` card whose sources include the cited `[source:ID]` | **no** — a project-authored paraphrase; the original source text was never fetched |

Knowledge passages exist only when the peer's packet is `bound` and the reference's availability is
`curated-card-text`. `not-retrieved`, `retrieval-unverified`, `curated-card-text-omitted`, `unknown-id`,
`missing-project-text` give no passage, so only `insufficient` is accepted for that citation.

## Packet (`buildClaimSupportContext(brief, peers, packets?)`)

Deterministic, deeply frozen, `bytes`/`sha256` of its canonical JSON. Schema `cloudbite.claim-support-packet/v1`.

- **Slots** (`s1`…): at most 6. Cited evidence first, then uncited, round-robin by evidence index across peers
  (peer order breaks ties). Others are listed in `omitted.slots` (`slot-limit`). Duplicate peers collapse.
- **Citations** per slot: at most 4 (`omittedCitations` counts the rest); each has `availability` (from the peer's
  packet for knowledge refs, else from the brief), `passageIds`, and `text`: `included` / `truncated` / `omitted`
  (available but cut by bounds) / `unavailable`. Slot `citedText`: `available` / `partial` / `unavailable` / `uncited`.
- **Passages** (`p1`…): at most 16, one per document / workspace file / (peer, card); duplicate refs merge and list
  every citing slot in `slotIds`. Each has exact `text` (a leading excerpt on line boundaries, never paraphrased),
  `sha256` of that excerpt, `location` (`startOffset`/`endOffset` in UTF-16 code units, 1-based lines,
  `totalChars`/`totalLines`, `sourceSha256` of the full source) and `truncated`. Cuts are listed in
  `omitted.passages` (`passage-limit` / `byte-budget`) and `omitted.truncatedPassages`.
  `endLine` is the line of the last covered character: an excerpt or quote ending with `\n` ends on the line that
  newline terminates, not the empty line after it. `endOffset` stays the exact exclusive UTF-16 end.
- **Bounds** (`CLAIM_SUPPORT_LIMITS`): the full serialized packet — `JSON.stringify(ctx)` with slots, citations,
  passage metadata, omission listings, notes, `bytes` and `sha256` — is at most 24 KiB of UTF-8 per reviewer; 4 KiB per
  passage, 200-byte minimum share. `bytes`/`sha256` describe the canonical JSON of the packet without those two fields.
  Every part counts against the bound, in this order:
  - a citation ref (as written in peer evidence) longer than `refBytes` (96 bytes, JSON-escaped) is shown as
    `doc:#sha256:HEX` / `source:#sha256:HEX`, HEX being the SHA-256 of the ref as written; its availability and
    `unavailable`/`omitted` text label are unchanged, and a note explains the marker;
  - metadata is sized first with every kept passage counted as a `byte-budget` cut; if even that does not fit, the
    `omitted.slots` listing and then the `passage-limit` listing collapse into `omitted.unlistedSlots` /
    `omitted.unlistedPassages` counts, and only then trailing slots move to `omitted.slots` with reason `byte-budget`;
  - passage text is placed only when the whole packet still fits; otherwise that passage is a `byte-budget` cut and
    its citations say `omitted` (never `included`/`available`).
  This is added once per reviewer call on top of the existing prompt; the project documents already in
  `project.documents` are unchanged (no snapshot change). `CLAIM_SUPPORT_SYSTEM` states these limit values.
- Citations are parsed from peer evidence only. Text inside documents (including `[doc:ID]`, fake passage IDs or
  instructions) never creates passages, bindings or system text; it is untrusted data in the user message.

## Prompt and reply

`reviewMessages(reviewer, peers, brief, definition?, packets?, artifacts?, claimSupport?)`:
with `packets` present and `claimSupport` undefined the packet is built from `(brief, peers, packets)` and added as
`claimSupport` in the data, plus `CLAIM_SUPPORT_SYSTEM`. Pass a prebuilt context to use one object for both prompt
and parse; `null` disables it. Without packets the prompt is byte-identical to before.

Reply finding (with context):

```json
{"targetExpertId": "...", "evidenceIndex": 0, "verdict": "supported|challenged|insufficient", "rationale": "...",
 "claimSupport": {"status": "supported|partial|contradicted|insufficient",
                  "quotes": [{"passageId": "p1", "quote": "verbatim 8-300 chars"}], "rationale": "<=400 chars"}}
```

## Parse (`parseReviewReply(..., { language?, claimSupportContext? })`)

With `claimSupportContext` every finding must carry `claimSupport` (exact keys) and the whole report is rejected,
without echoing reply text, when: status unknown; rationale empty/over 400; more than 3 quotes; a quote names an
unknown passage, a passage not bound to the finding's own slot (cross-role or cross-slot), is under 8 / over 300
characters, is not an exact substring, or repeats; `supported`/`partial`/`contradicted` without a valid quote; the same
slot assessed twice. A slot outside the packet, uncited or with unavailable text can therefore only be
`insufficient` — a gap, never a contradiction. `claimSupport.rationale` joins the response-language check; quotes stay
verbatim in the source language and are not part of that check.

Stored `CrossReviewFinding.claimSupport` (`ClaimSupportAssessment` in `src/cloudbite-contract.ts`): `status`,
`quotes[]` (`passageId`, `ref`, `textOrigin`, `quote`, `sourceSha256`, offsets, lines), `rationale`,
`basis: 'model-assessment'`, `quoteCheck: 'exact-substring'`, `citedText` (adds `not-in-packet`), `packetSha256`.

Legacy: without a context the old four-key finding is accepted as before; a `claimSupport` key, if a model sends one,
is discarded unchecked, so a legacy parse never stores an assessment. Old stored findings have no `claimSupport`
(render as "not assessed"). The ordinary verdict and the six-key `ExpertOpinion` are unchanged.

## Integration hooks (coordinator)

- At the DO parse call: `const ctx = buildClaimSupportContext(brief, peers, packets)` when packets exist; pass `ctx`
  to both `reviewMessages(..., ctx)` and `parseReviewReply(..., { language, claimSupportContext: ctx })`.
  Until then the prompt asks for claimSupport and the legacy parse drops it (no failure, nothing stored).
- UI: show `status` as a model reading, each quote with `textOrigin` (curated-card ≠ original), `ref` and lines, and
  `citedText`; show "not assessed" when absent.
