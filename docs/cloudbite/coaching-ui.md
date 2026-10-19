# Cloudbite v6 — coaching UI (client)

Client-only changes in `client/cloudbite-console.ts` / `.css` (bundled into `src/cloudbite-page.ts` by
`npm run build:cloudbite-console`). Test: `node test/cloudbite-v6-coaching-ui.mjs` (fake DOM, no browser).

## 1. Brief helper (local drafting aid)

- A folded `<details>` under the objective field. Three optional questions: who decides/uses it, what
  decision this round should inform, the current constraint. Labelled as a local, rule-based drafting
  aid — no model call, no server request, no cost.
- "Preview" composes a labelled block (`Working assumptions confirmed by me (drafted with the local brief helper):`)
  from non-empty answers only; nothing is invented for unanswered questions. Nothing changes until "Apply".
- Apply **appends** the block to the end of Context (existing text is kept, objective and decision fields —
  including known facts — are untouched), then goes through the normal semantic-edit path, so the routing
  preview is invalidated and the user can edit before routing/running.
- The draft is bound to a signature of objective + context + answers at preview time. Any later edit
  makes it stale: Apply is disabled and the handler re-checks the signature. A draft that would exceed the
  context limit is refused. Answers are skeleton inputs, so they survive KO/EN switches and re-renders; the
  block labels follow the UI language, the user's answer text is never translated.
- Direct input and Start never depend on the helper.

## 2. `memo.coaching` display

- Local mirror types `ProjectCoaching` / `CoachingRepair` and `ConsoleDecisionMemo = DecisionMemo & { coaching?, invalidCoaching? }`
  (no shared-file change, no runtime import). The backend's `DecisionMemo` in `src/cloudbite-memo.ts` now carries
  `coaching?`, but the browser mirror the console imports (`src/cloudbite-contract.ts` `DecisionMemo`) does not, and
  `src/cloudbite-coaching.ts` cannot be imported under `tsconfig.client.json` (it pulls Workers types through
  `cloudbite-memo`). So the `coaching?` intersection stays until the contract mirror gains it; `invalidCoaching` is a
  UI-only sidecar either way.
- Normalisation (`projectCoaching`): exact keys at every level, version `cloudbite-coaching/v1`, closed enums
  for stance/kind/priority, ≤3 repairs and ≤3 questions (server `CB_MEMO_COACHING_LIMITS`). Every coaching claim has
  exactly the keys `text`, `expertIds`, `refs` (an extra key is rejected, not ignored), non-empty text ≤200 chars
  (server `CB_MEMO_COACHING_LIMITS.claim`), ≤8 expertIds and ≤6 refs (server `CB_MEMO_LIMITS`), then the existing
  `memoClaim` shape check. Legacy memo claims keep their own path and the server's 280-char legacy bound; the
  brief helper's answer fields keep their own 280-char input cap. These are shape checks only: they mirror server
  bounds and are not semantic validation (citations, ordering and attribution rules stay the server's, and passing
  them is not evidence that a claim is true). Any violation (including `coaching: null`) keeps the memo and sets
  `invalidCoaching`, shown as an alert line in the memo and in the export. Absent field = legacy memo,
  shown with a short help line.
- Rendered right after the memo summary, ahead of recommendation/comparison/dissent, under
  "Proposed project revision" with the badge "Proposal — not adopted or validated". Stance, viable path,
  repairs (kind · priority tag, change, smallest check, evidence that would change the decision), revised
  objective/scope/next milestone, questions. No numeric score. Narrative text is shown verbatim.
- Markdown/download export contains the same section in the same position.
- Thin briefs: client eligibility already allowed a memo without options; the help text now says so, and a
  memo with an empty comparison says "no decision options were given". The legacy `needs-options` memo
  status is still displayed (marked as the earlier rule).
- The memo action reads "Build project improvement plan (1 model call)" / "프로젝트 개선안 만들기 (모델 호출 1회)"; the
  memo title stays "Decision memo". The short explanation now says the single call also proposes a revised scope and
  concrete repairs, and keeps the one-attempt, derived-interpretation and originals-unchanged facts. No new button,
  no automatic call.
- Loading/error/retry use the existing one-call memo flow unchanged.

## 3. Revised project → next-round draft

- Button "Use revised project as next-round draft" in the coaching section (only when the project is
  follow-up eligible and the coaching is valid). It opens the existing follow-up draft (parent provenance,
  previous round, role selection, decision fields all as before), then:
  - replaces the objective with the proposed objective (clipped to the field limit);
  - appends a labelled `Proposed revision from the parent memo (edit or remove; not adopted or validated):` block with scope and next
    milestone to Context, or notes in the change summary that there was no room;
  - sets the change summary to say it came from the memo's proposal.
- It never launches a preview/run, never edits known facts or other decision fields, and the user must
  still review and start the round. Repairs/questions are deliberately **not** copied (too broad to put
  into a brief silently).

## 4. Overview wording

Fixed judgments ("move straight to…", "do not expand…") are replaced by neutral direction-distribution
lines that state counts describe what roles stated, not decision quality or consensus. The section title
is "Stated directions". Counts, mean confidence, partial-basis note and details are unchanged.

## Not verified

No real browser, server or provider run. The coordinator does browser QA.
