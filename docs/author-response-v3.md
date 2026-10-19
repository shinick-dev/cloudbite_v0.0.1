# Author response (product v3)

Leaf module: `src/cloudbite-author-response.ts`. Test: `node test/cloudbite-author-response.mjs`.

An author response is an **explicitly requested new follow-up project**. After a parent project has finished and
its cross-review has completed, the authors whose evidence was challenged (or found insufficient) run again in a
new child project, with that child's own normal budget, and answer each finding with `revise`, `withdraw` or
`maintain` plus a rationale. Nothing runs automatically and no paid loop is started by this module.

## What stays unchanged

- The parent's original opinions, cross-review and memo. The plan holds bounded copies plus exact hashes.
- `ExpertOpinion` keeps its six keys. The author response travels beside it as a sibling `authorResponse` value in
  the runner's final action, and the application writes `out/author-response.json`.
- Normal follow-ups: `auth.round` is the ordinary `RoundParentAuthorization`, so `buildProjectRound` still builds
  the child's `previousRound` from the same read.
- The child may produce its own one-attempt memo. The parent memo is never overwritten.

## Flow (coordinator integration)

1. **Authorize.** The caller does the parent's server-side `historyRead(actor, owner)` exactly as for a normal
   follow-up, then passes the result to `authorizeAuthorResponseParent({ parentId, actor, owner, read, now })`.
   That function reuses `authorizeRoundParent` (terminal, live, own/owner, not deleted) and also requires
   `read.project.crossReview.status === 'completed'` with a 64-hex `snapshotHash`. Authority never comes from
   body fields.
2. **Candidates.** Every stored finding is checked again. A finding becomes a candidate only if all of these hold:
   - its verdict is `challenged` or `insufficient`;
   - the reviewer and the target are both completed parent authors, and they are different experts;
   - the evidence slot it names exists.

   All other findings go into `excluded` with a reason: `self-target`, `foreign-reviewer`, `foreign-target`,
   `stale-evidence-index`, `malformed`, `duplicate`, `duplicate-reviewer`, `over-reviewer-bound` or
   `over-finding-bound`. The finding text is never echoed back.
3. **Finding IDs.** Each ID is `arf_` followed by 32 hex characters of a sha256 over the version, `parentId`,
   `snapshotHash`, reviewer, target, `evidenceIndex`, verdict and the full rationale. The same review always gives
   the same IDs. A different snapshot or an edited rationale gives new IDs.
4. **Plan.** `buildAuthorResponsePlan(auth, childBrief)` checks the child brief:
   - `childBrief.revision.parentId` must name the authorized parent;
   - `childBrief.revision.reviewSnapshotHash` must equal the completed review's `snapshotHash` exactly. A missing
     hash is rejected with 400 and a different (stale) one with 409;
   - `childBrief.expertIds` must be 1–100 distinct roles, all of them affected authors
     (`authorResponseAffectedAuthors(auth)`).

   **Cap:** 3 reviewers × 6 findings can produce up to 18 findings, across at most 9 authors. A plan carries at
   most **9 findings**. They are assigned round-robin across the selected authors, so each author gets at least one.
   Within each author the order is challenged first, then reviewer order, then evidence index. Findings left out
   are listed by ID in `capped.omittedFindingIds` and stated in `disclosure`.

   **Text bounds:** summary 1500 B, evidence item 800 B. Every cut is recorded in `omissions`.

   The plan is deep-frozen and bound by `planSha256`. `verifyAuthorResponsePlan` re-checks that hash after
   persistence. Its `execution` field is `{ kind: 'new-child-project', automaticCalls: 0, budget: 'child-normal',
   parentMutation: 'none', parentMemo: 'unchanged', childMemo: 'own-optional' }`.
5. **Workspace and rules.** `authorResponseWorkspaceFiles(plan, expertId)` produces
   `evidence/author-response-findings.json`, which holds only that author's own findings and own original summary.
   It is marked as untrusted data and is bounded to 32 KiB. `authorResponseWorkOrderRules(plan, expertId)` holds
   only constants, IDs and the KO/EN `responseLanguageRule`.
6. **Collect.** `parseAuthorResponse(authorResponse, plan, expertId)` accepts either an object or JSON text up to
   32 KiB. The schema is strict: `{responses:[{findingId, disposition, rationale}]}`.

   It rejects any of the following:
   - unknown keys;
   - spoofed IDs, or IDs belonging to another author;
   - duplicate IDs;
   - an unknown disposition;
   - an empty rationale, or one longer than 600 characters;
   - more entries than the author was assigned;
   - a clearly wrong script for the plan's language (category `language`).

   Missing findings are allowed and reported in `coverage` (`complete` / `partial` / `none`).
   `authorResponseArtifact(plan, parsed)` writes the app-generated `out/author-response.json`.
   `validateCollectedAuthorResponse(plan, expertId, content)` re-validates a collected artifact. It checks the plan
   hash and these exact bindings: parent, plan hash, snapshot hash, author and original-opinion hash. It also checks
   that the stored coverage matches the responses.

## Limits and non-claims

- A response is the author's own position. It is not a verification and not an adjudication of the reviewer.
- The plan cannot recompute the parent's cross-review `snapshotHash`, because that hash covers packets rebuilt inside
  the DO. It binds the stored hash exactly, and binds each original opinion by its own sha256.
- History authorization, persistence, budget reservation, the runner's sibling `authorResponse` handling and the UI
  belong to the coordinator (contract/API/DO/runner/client), not to this leaf.
