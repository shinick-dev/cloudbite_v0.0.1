# Cloudbite follow-up rounds (ITEM5)

A follow-up is a **new project**. It goes through the existing `POST` create path (visitor reservations, quota,
idempotency) and never mutates or reuses the completed parent. `brief.revision = { parentId, changeSummary }` is an
untrusted user claim; it is validated structurally by `cloudbite-workflow.ts` and grants nothing.

Module: `src/cloudbite-revision.ts` (pure leaf). Test: `node test/cloudbite-revision.mjs`.

## Functions

| Function | Purpose |
|---|---|
| `authorizeRoundParent({ parentId, actor, owner, read, now })` | Checks the caller's own history read of the parent and returns a frozen `RoundParentAuthorization` holding a stripped snapshot, or `{ error, status }` (400 bad id, 404 missing/foreign/deleted/purged, 409 parent not terminal). |
| `buildProjectRound(auth, brief)` | For a validated new brief whose `revision.parentId` equals the authorized parent: exact-text comparison plus bounded previous-round reference. Returns a deep-frozen `ProjectPreviousRound` or `{ error, status }`. |
| `previousRoundWorkspaceFiles(round, expertId)` | `evidence/previous-round.json` for a new-round role: untrusted data envelope, the role's own earlier opinion separated from the others. Empty for roles not selected. |
| `previousRoundWorkOrderRules(round)` | Trusted rule lines (constants + validated parent id only) to append to the work order. |

## Caller responsibilities (integration hooks)

1. **Authorization is the caller's job.** Derive `actor` exactly as `cloudbite-history-api.ts` does (`'owner'` for a
   verified owner/operator, else `'v_' + cbHash(history cookie)`), address the parent DO by `revision.parentId`, and
   pass the result of `historyRead(actor, isOwner)` as `read`. Never use body fields or project access tokens as
   authority, and never read another tenant's project by id. The helper refuses authorizations it did not issue,
   rechecks id/actor/owner consistency, expiry, tombstones and terminal status, but cannot see the record's actor.
2. Call `buildProjectRound` after `validateProjectBrief` and before create; store the result as
   `ProjectRun.previousRound` (proposed optional field, type `ProjectPreviousRound`; contract change belongs to the
   coordinator). Quota, idempotency hashing, deletion and language propagation stay with API/ProjectDO.
3. Only `round.newRoles` become `ExpertRun`s. Reference opinions are never copied into a new run, never counted as
   completed or valid, and never shown as fresh output; UI should label them "previous round".
4. Write `previousRoundWorkspaceFiles` into each new role's workspace and append `previousRoundWorkOrderRules`.
5. Retention: the follow-up holds only the bounded snapshot. Deleting the parent later does not touch the child; a
   deleted parent can never be reconstituted because its history read fails (404). Users who want prior material in a
   new round copy it explicitly into the new brief.

## What the snapshot keeps / drops

Keeps: title, objective, stage, response language, decision frame (capped), document id/name/bytes/sha256, per-role
status and, for completed roles only, direction/confidence/summary/evidence (capped). Drops: context, document content,
routing, tokens, sandbox ids, activity, artifacts, reports, error strings, assumptions/nextActions of opinions.

## Comparison semantics

Exact text and content hashes only; `semanticImpact` is always `'not-analyzed'`. Option ids are positional per
snapshot; `exactTextMatches` pairs ids with byte-identical text and never asserts that `option-1` means the same thing
across rounds. Lists (constraints, success criteria, unknowns) diff as exact-text sets against the capped parent
snapshot, so an item longer than the cap shows as removed + added. Documents compare by id then sha256.

## Bounds

`ROUND_LIMITS`: 100 roles, summary 1500 B, 6 evidence items × 500 B, text 2000 B, list 8 × 400 B, change summary
4000 B, total reference 64000 B (selected roles' opinions first). Cuts are on code point boundaries and every cut or
dropped item is recorded in `omissions`.
