# Product v3 — epistemic provenance (`src/cloudbite-provenance.ts`)

Goal: a generated numeric threshold (">=80% task completion", ">=5 regression tests") never becomes a canonical
requirement unless the user explicitly adopts that exact text. The user's own qualitative success criteria stay
exactly as written.

## Model

- **Ledger** (`buildProvenanceLedger(projectId, brief, experts, { sourceCatalogue?, carried? })`): pure, deterministic,
  recomputed from immutable inputs. Claims:
  - `user-statement`: brief `objective`, `context`, and decision `options/constraints/successCriteria/knownFacts/assumptions/unknowns`.
  - `generated-opinion`: each expert's `summary`, `evidence[i]`, `assumptions[i]`, `nextActions[i]` (ExpertOpinion unchanged).
  - `parent-adoption`: adoptions carried from an authorized parent project.
- **Stable IDs**: `cl-<64-bit hash>` over version, origin, kind, field, index, expertId and the FULL original text.
  Same input → same ID; any text change → new ID. `snapshot` (`ps-…`) hashes the project ID plus all claim IDs.
  The hash is an identifier, not a security boundary: adoption also checks exact text and snapshot server-side.
- **Standing** (`claimStanding`): `user-stated` | `generated-proposal` | `user-adopted`. Generated text is always a
  proposal until adopted. `numericThresholdHint` is a lexical hint for UI emphasis only and never changes standing.
- **Refs**: `[doc:..]`/`[source:..]` tags become `supplied-document` / `catalogue-listed` / `not-found`. This is text
  availability, not truth, retrieval or verification (`factsVerified: false`, `sourcesRetrieved: false`).

## Adoption (root/DO integration)

1. Client sends exactly `{ claimId, text, snapshot }`. Any other key (actor, at, role, …) is refused.
2. DO recomputes the ledger, restores state with `parseProvenanceState(raw, projectId)` (malformed → `null` → treat as
   no adoptions), then calls `validateAdoption(ledger, state, body, { projectId, actor, at })` with the
   authenticated server actor and server time.
3. Refused: stale snapshot, unknown/malformed ID, text not byte-identical, other project, user statements and carried
   adoptions (already have standing), truncated claims (full text was never shown), duplicates, > 64 adoptions.
4. Persist `applyAdoption(state, adoption)` (pure). Meaning is fixed: `user-adoption-not-verification`.

`effectiveAdoptions(ledger, state)` splits active vs stale adoptions; stale ones give no standing.

## Future rounds

`nextRoundCarry(ledger, state)` returns only active adoptions (and adoptions this ledger itself carried), keeping the
original project, claim ID, actor and time. Pass them as `carried` to the child ledger; malformed or duplicate
entries are dropped and counted (`carriedInvalid`). Parent proposals, opinions and memo are never carried. Carrying is
for an explicitly requested follow-up; the root decides authorization.

## Rendering

- `provenancePromptContext(ledger, state, { language, maxBytes = 6 KiB, listedProposals = 12 })` → bounded text with
  fixed non-authority rules (KO/EN), exact user success criteria and constraints, user-adopted claims, threshold-like
  generated proposals, counts and limits. Rules and limits are always kept; omitted lines are disclosed.
- `renderProvenanceWorkspace(ledger, state, language, maxBytes = 48 KiB)` → the same with up to 200 listed proposals.
- `memoProvenanceContext(ledger, state, language)` → `{ snapshot, text }` for `memoMessages(..., { provenance })`.

## Memo change (`src/cloudbite-memo.ts`, additive)

`MemoInputOptions.provenance?: { snapshot, text }`. When absent, the prompt, snapshot and coverage are byte-identical
to before. When present: clipped to `CB_MEMO_PROVENANCE_MAX_BYTES` (8 KiB), included as
`provenance: { kind: 'provenance-context-not-authority', … }`, part of the memo snapshot, disclosed in
`coverage.provenance`, and one extra system rule says generated thresholds are proposals unless listed as user-adopted.

## Bounds

100 experts, 12 items per list/field, 1000 characters per claim, 8 refs per claim, 64 adoptions. All omissions and
truncations are counted in `coverage`. No provider calls, storage, budgets or costs are involved.

## Limits

- Standing is structural (who wrote it, whether the user adopted it), never semantic; the threshold hint is a regex
  hint and may miss or over-flag phrasing.
- Adoption is a user decision, not verification of the claim.
- Ledger reads the opinion fields only, not full reports/artifacts or source pages.
- The memo model is instructed, not forced, to respect standing; the memo parser does not check threshold wording.
- Integration (API route, DO storage, runner/workspace file, client UI, contract types) is owned by the root.
