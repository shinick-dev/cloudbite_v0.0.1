# Cloudbite v7 — project continuity

A follow-up round can now carry the parent memo's coaching (proposed repairs, open questions, revised
milestone) forward **as proposals**, together with an exact-text list of what changed since the parent.
No new public API: everything rides on the existing authenticated follow-up path
(`brief.revision.parentId` → `parentDO.historyRead(actor, owner)` → `authorizeRoundParent` → `buildProjectRound`).

## Standing (never changes)

| Item | Standing |
|---|---|
| Carried repair | `status: proposed-not-executed`, `verification: not-verified` |
| Carried question | `status: open-not-answered` |
| Handoff as a whole | `standing: generated-proposal-not-adopted` |
| User's change summary | `changeSummaryStanding: user-statement-not-verified` |

Carrying an item never adopts it (provenance adoption is unchanged and still exact-claim only), never runs
anything, and never writes into known facts or other decision fields.

## Data flow

1. `src/cloudbite-project-context.ts` (pure leaf, no imports): `readCoachingHandoff(memo)` reads the
   authorized parent's own stored `ProjectMemo` as `unknown`. States: `present`, `none` (no memo, not
   completed, legacy memo without coaching), `unreadable` (foreign version or shape). It never throws.
   Repairs are sorted now → next → later; parent evidence refs are not carried (they point into parent
   data), expert attribution is.
2. `authorizeRoundParent` adds optional `coachingState` / `coaching` to the frozen snapshot. Only the parent's
   memo is read — never the parent's own `previousRound` — so ancestry does not recurse.
3. `buildProjectRound` adds optional `continuity` (`buildRoundContinuity`): carried proposals, changed
   subjects (stage, options, constraints, success criteria, known facts, assumptions, unknowns, documents by
   content hash), `missingEvidence` (parent documents absent now), `reevaluate`, fixed instructions.
   `semanticImpact` stays `not-analyzed`; nothing infers meaning.
4. `previousRoundWorkspaceFiles` puts `continuity` into the same untrusted
   `evidence/previous-round.json` (all v6 keys kept). `previousRoundWorkOrderRules` adds two constant rules
   only when continuity exists: carried items are not done/checked/decisions; re-evaluate what depended on
   changed subjects and state the new basis next to the old one.

Old stored rounds have no `continuity`; their workspace file and rules are unchanged (5 rules).

## Bounds

`HANDOFF_LIMITS`: 3 repairs, 3 questions (more → unreadable, matching the memo's coaching caps), 600 UTF-8
bytes per claim (cut on code points, recorded in `omissions`), 12 KiB per handoff (questions then lowest
repairs dropped, recorded), 12 ids per changed subject. In the 32 KiB workspace, other previous opinions and
then the detailed comparison are trimmed first; continuity is reduced to a notice only as a last step,
recorded as `workspace.continuity`. No provider call is added (6 + 2 bounded calls and budgets unchanged).

## Console

- Memo → "Use revised project as next-round draft" still copies objective/scope/milestone, then — as Context
  room allows — priority repairs (now → next → later) and decision-changing questions under labelled
  "proposed, not done or verified" headings. The first item that does not fit stops the copy; the omitted
  count is shown in the draft note and the change summary. If scope + milestone do not fit, nothing is added
  (v6 behaviour).
- The follow-up box lists the parent memo's open points tagged "Proposed · not done" / "Check (not verified)"
  and asks the user to say in "What changed" what they actually did or found.
- A child project's previous-round view and Markdown export show the continuity section; an unreadable
  continuity is disclosed (`invalidContinuity`) without hiding the rest of the round.
- The brief helper picks questions by fixed rules from the stage and empty decision fields (who; decision if
  no options; constraint if none; success/evidence at validation-or-later with empty criteria/facts; biggest
  unknown at early stages with none), shows what each answer influences, keeps answered questions visible,
  and still only writes Context through explicit preview → apply with the stale-preview guard. No model call.
- The console is one unbundled esbuild transform, so it imports only types from the leaf; its `CONTINUITY`
  mirror is pinned to `HANDOFF_LIMITS` by `test/cloudbite-v7-continuity.mjs`.

## Checks

`node test/cloudbite-v7-continuity.mjs` (backend pure modules + fake DOM; not browser, server or provider
evidence), plus `cloudbite-revision`, `cloudbite-v6-coaching-ui`, `cloudbite-workflow-ui`, console build and
both `tsc` configs.
