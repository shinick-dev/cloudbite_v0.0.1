# Product v3 — backend integration (`src/cloudbite-api.ts`, `src/cloudbite-project.ts`)

Root integration of the three v3 leaves (`cloudbite-provenance`, `cloudbite-artifact-review`, `cloudbite-author-response`)
into the Worker router and the `CloudbiteProject` DO. Verified by `node test/cloudbite-backend-v3.mjs` (real router and
DOs over memory storage, fake Nosana only, no sandbox).

## Claim adoption — `POST /api/cloudbite/history/:id/adopt`

- Authority is the history route only (owner credential or the visitor's history cookie, strict Origin, JSON ≤ 8 KiB).
  A project bearer token cannot adopt.
- Body is exactly `{ claimId, text, snapshot }`; actor and time are the server's (`validateAdoption` refuses any other key).
- Only the project's own history actor adopts. An owner session that can read another browser's project gets 403:
  adopting is the user's statement, like feedback, and must not be made on that user's behalf.
- Refused (409): unfinished, cancelled or demo project; a running cross-review or memo; stale snapshot; text not
  identical; user statements, carried or truncated claims; duplicates (concurrent identical adoptions serialize in the
  DO transaction, one wins). A stored state that does not parse for this project fails closed (409) and is not overwritten.
- Adoption changes only the `provenance` key and the history revision: no budget change, no model call, the six-key
  opinions and any finished memo stay byte-identical.

## Carry into a follow-up

`authorizeRoundParent` reads the parent through `historyRead` and carries `nextRoundCarry` (exact active adoptions only).
Unadopted generated thresholds are never carried; they stay proposals. A corrupt parent state carries nothing.
The child workspace gets `evidence/provenance.txt` (untrusted data) with the carried text.

## Cross-review reads stored artifacts

Only metadata-listed, already collected text of the reviewed peers (multi-get ≤ 128 keys per call) is packed by the
leaf (16 KiB/peer, 48 KiB total). The text is in the reviewer input and in `snapshotHash`; `crossReview.artifactCoverage`
binds each file by sha256 with line range and `excerptTruncated`/`storedTruncated`, and lists metadata without stored
text as `missing-text`.

## Author-response child round

Request: a normal create/preview with `revision: { parentId, changeSummary, reviewSnapshotHash }` (validated in route,
preview and create; part of the routing and brief hashes).

- Live child only (400 otherwise, before the parent is read).
- Parent bound by this request's own history actor (`historyRead`); a foreign/deleted/expired parent is 404.
- Parent cross-review must be completed and its `snapshotHash` equal the requested one (409 stale).
- `expertIds` must be affected completed authors (`buildAuthorResponsePlan`); the plan is built by the API, never from
  the body (unknown `revision.*` or top-level `round` fields are 400).
- The DO checks the same binding in **preview and create** (`roundBinding`): round version/parent/roles, round ≤ 192 KiB,
  plan hash (`verifyAuthorResponsePlan`), snapshot and exact role set. Plan integrity is binding, not authorization.
- Per-author workspace: `evidence/author-response-findings.json` with only that author's findings (≤ 32 KiB, whole
  workspace ≤ 256 KiB) plus work-order rules.
- The child has its own normal budget and its own optional memo; creating it makes no model call; the parent's
  opinions, cross-review and memo are not written.

## Collecting the runner reply

The runner writes the raw sibling `{responses}` to `out/author-response.json` (reserved; never collected as an extra).
`collectAuthorResponse` rechecks the stored plan hash, parses the raw reply strictly against that plan, generates the
canonical application artifact at the same path and revalidates it with `validateCollectedAuthorResponse` before
storing. One artifact slot is kept for it. Missing, oversize, foreign/duplicate ids, bad disposition, extra keys or the
wrong language give `run.authorResponse = { invalid }` and no artifact; the opinion stays completed on its own.
`partial` and `none` coverage are stored as such, never as complete.

## History delete

Removes `round` (with the plan), `provenance`, cross-review, memo, packets, every `artifact:`/`audit:` key and
`run.authorResponse`. Delete needs a terminal project, so no collection can write back afterwards; a deleted parent
stops new author-response children (404).

## Limits (not covered here)

- The full sandbox `collecting` phase is not driven end to end in this suite; `collectAuthorResponse` is exercised
  directly with the stored plan. The runner's own `authorResponse` check is in `src/cloudbite-runner.ts` (not changed).
- A corrupt provenance state is shown in the project view as an empty state (no adoptions), not as an explicit error.
- Automatic (Jev) routing is not refused for an author-response request; a Jev selection outside the affected authors
  fails the plan (400).
