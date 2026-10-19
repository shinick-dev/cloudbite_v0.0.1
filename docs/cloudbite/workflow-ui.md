# Workflow console UI: decision memo, evidence signals and follow-up rounds

This page covers phase 2 of the console workflow in `client/cloudbite-console.ts`, which is transpiled into `src/cloudbite-page.ts`. Phase 1 is still in place unchanged: stage, response language, the folded call caps, the two-step live run (prepare plan → run this plan, which sends the frozen preview body unchanged), PMC import, and History/owner/visitor navigation.

The UI only shows what the server stored. It never builds a memo or round itself, never counts previous-round opinions as new results, and never shows a missing number as `0`.

## Decision memo

- **Where it appears:**
  - The results panel, in the "Claims and evidence" area, for the current run.
  - The History detail.
- **What it is:** a section titled *Decision memo*.
- **Paid request:**
  - `POST /api/cloudbite/projects/:id/memo` with the body exactly `{}`.
  - Headers: `content-type: application/json` and `authorization: Bearer <project token>`, which is the token from project creation.
  - The request is only offered when all of these are true:
    - It is the current live run in this tab and the run has finished. It is not cancelled and has at least one completed, valid opinion.
    - The memo cap allows it. `usage.memo.available > 0` when the server reports usage; otherwise `brief.budget.maxMemoCalls !== 0`.
    - The server has never tried a memo for this project (`memo` is absent, or `idle` with `attempts: 0`).
    - This screen has not sent a memo request for this project already, except one the server refused with a 409 that a GET then confirmed as untried (below).
    - No cross-review is running for this project, from this screen or as reported by the server.
- **Memo and cross-review never overlap.** The server refuses either one with a 409 while the other runs, and reserves nothing. The console mirrors this in both the buttons and the request handlers: while a memo is running (or being read) there is no *Run cross-review* button, only a note; while a cross-review is running there is no memo button, only a note. If the review was started elsewhere (so this screen does not poll it), the memo section offers *Check memo status*, which only does a GET.
- **One attempt only.** After any request (success, refusal, error or an unknown outcome) the paid button does not come back for that project. To run another round, start a follow-up, which creates a new project. The only exception is a definite 409 followed by a GET that shows no memo attempt (`memo` absent, or `idle` with `attempts: 0`): the server did not start or reserve anything, so the console says so and keeps the first paid attempt. The button returns once nothing else is running; it is sent only when the user clicks it, never automatically.
- **Unknown outcome (network failure or timeout).**
  - The POST is not sent again.
  - The console reads `GET /api/cloudbite/projects/:id` and shows what is stored.
  - If no memo record exists yet, it says so and offers *Check memo status*, which only ever does a GET.
- **409** (running, ineligible, deleted or not current): the console reads the project and shows either the stored state or the server's reason. If that GET itself fails, the outcome is treated as unknown (GET-only, no paid button).
- **Late responses:** a project read older than the one already shown (lower `updatedAt`) is discarded, so a slow read cannot bring back a finished review as running.
- **Other refusals** (`429` budget, `503` not configured, `410`, `401`): the server's reason is shown and nothing is retried.
- **Running:** the console checks with a read every 3 s, and stops after 40 checks with a notice.
- **Rendering:**
  - Summary.
  - Recommendation, labelled as *a derived interpretation of the opinions, not a vote count, accuracy or calibrated confidence*. It shows the exact option IDs and text supplied.
  - Option comparison table: benefits, risks and conditions for each option. Each claim lists its attributed experts and references.
  - Dissent, critical unknowns, what would change the recommendation, and next actions.
  - Input coverage and omissions: what was shortened or omitted, plus the note that full reports and source pages were not read. When `coverage.brief.revisionTruncated` is true, it also states that the follow-up change summary was shortened for the memo input (KO/EN, and in the Markdown export). The field is required: a coverage object without a boolean `revisionTruncated` is treated as unreadable, not as `false`.
- **References** are shown by kind:
  - opinion evidence item
  - document
  - evidence-metadata packet
  - cross-review finding
  - brief field
- **Unchanged inputs:** the original opinions and the summary counts (valid fresh opinions only) are not changed by the memo.
- **History** never offers the paid request. It renders a stored memo read-only, or states that none was written.

## Observed evidence signals

- **Source:** the server's `evidenceSignals` (`cloudbite.evidence-signals/v1`).
- **Per expert, shown beside the self-assessed confidence:**
  - evidence items, and how many have no source ID
  - cited IDs by kind
  - supplied project text present or missing
  - knowledge citations (curated card text, card text omitted, retrieval unverified, not retrieved)
  - unknown IDs
  - assumptions
  - observed retrieval
  - cross-review findings
- **Missing values:** `null` fields (no packet built, no cross-review report) render as **UNKNOWN**, never `0`. A project without signals says so.
- **Packet coverage:** included out of total, plus the omitted expert IDs, with the note that an omitted packet does not mean nothing was retrieved.
- **Wording:** the copy states that a curated card is not the original source page, and that a source ID being present is not accuracy or calibration.
- **Cross-review section:**
  - Planned coverage (reviewers and their cap, peers per reviewer, assigned and completed opinions, unassigned roles).
  - The cap note (at most 3 reviewers × 3 peers), so it is clear that not every role is reviewed.
  - The server's disclosure.
  - For each finding, whether the cited text was in the reviewer input (`textBasis`).

## Follow-up rounds

- **Start:** History detail → *Start follow-up round*. This only appears for a finished live project that is not marked `[deleted]`.
- **What it copies into the editor:**
  - title, objective, context
  - decision items
  - documents, with their `origin`
  - stage and response language
- **What it does not copy:** caps. Normal quotas apply.
- **Setup:**
  - The previous team is preselected for manual choice. The user can change it or switch back to Jev selection.
  - Nothing runs automatically.
- **Change summary:**
  - It is required, trimmed, and at most 2,000 characters.
  - The follow-up box shows a draft diff that matches exact text only: stage, language, options, constraints, success criteria, unknowns, documents and roles.
  - It notes that option IDs are positional, and lists earlier opinions as reference only.
- **Request:**
  - The plan goes through the normal `/api/cloudbite/route` (Jev), then `/api/cloudbite/preview`, then `/api/cloudbite/projects` path. It has a new `requestId` and `revision: { parentId, changeSummary }`.
  - No previous-round data or history token is sent. The server checks that the caller can read the parent and builds `previousRound` itself.
- **Parent errors:** a missing or unreadable parent (`404`) shows an honest message. Other refusals show the server's reason.
- **Deleting the parent** in History clears:
  - the private detail view
  - its disclosure state
  - the follow-up draft and its plan
- **Display:** a project with `previousRound` shows a *Follow-up round* section with the parent ID, the change summary, the server comparison and the omissions. Previous-round opinions sit in a collapsed reference list and are never counted in this round.

## Language, export and accessibility

- **Labels:** every new label exists in both `EN.p2` and `KO.p2`, and the tests check that the two key sets match.
- **Switching the UI language** keeps inputs, files and the prepared plan. The model's `responseLanguage` is a separate, explicit field.
- **Markdown export:** for live runs it adds sections for the follow-up round, evidence signals (with UNKNOWN), cross-review coverage and the decision memo, including omission disclosures. It uses stored data only.
- **Markup and layout:**
  - Sections use headings with `aria-labelledby`.
  - Status changes use `role=status` and errors use `role=alert`.
  - Focus is kept across re-renders through `data-fk`.
  - The memo table scrolls horizontally and the signal grid collapses to one column under 560px.

## Tests

`node tools/build-cloudbite-console.mjs && node test/cloudbite-workflow-ui.mjs` runs the console against a fake DOM. The tests cover:

- the memo request payload and headers
- one attempt only, with no resubmit after a network failure (reads only)
- 409, 429, budget-0, failed, needs-options and cancelled states
- memo/cross-review mutual exclusion in both directions with a held POST (buttons and handlers), and a definite 409 confirmed untried keeping the first paid attempt until the user clicks; stale late reads discarded
- `revisionTruncated` from real server `memoMessages` coverage (true and false), KO/EN lines and export, and missing or non-boolean values rejected
- UNKNOWN versus 0
- review coverage
- the follow-up payload: new `requestId`, `revision`, copied fields, no auto-run, and parent 404 or delete clearing
- previous-round rendering
- the Markdown export
- KO/EN key parity

These are not real browser or provider runs.
