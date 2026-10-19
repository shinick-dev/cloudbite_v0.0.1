# Automatic computer backups (`src/cloudbite-computer-backups.ts`)

Product contract: `docs/cloudbite/cloud-files-implementation-plan.md` §6–7. This module is the dependency-injected core
only; the root wires it into the lifecycle end flow (`ComputerBackupHook`) and adapts the Daytona transport. Nothing
here has been run against a live account: the tests use in-memory fakes and prove no persistence, quota or cost.

## What a backup is

A private cold filesystem snapshot (`includeMemory:false`) of the owner's machine, requested only after the safe end
confirmed the provider machine is **stopped**. It is a full disk capture: Daytona documents no source exclusion, so
files on the machine disk are inside it. RAM, open windows and unsaved app buffers are never captured. A failed or
unknown backup never touches the VM disk or user files.

## Contract

```ts
const backups = new ComputerBackups({ store, provider, now, random, protectedNames });
backups.begin(ownerTag, { requestId, machine: { id, account, status }, environmentRevision?: string | null }) // storage only
backups.tick(ownerTag)    // alarm only; the only provider caller, at most 8 provider calls per tick
backups.status(ownerTag)  // storage only, last begin's answer or null
backups.summary(ownerTag) // storage only: owned items, owned count, block reason, usage:'unknown'
backups.reconcile(ownerTag) // explicit owner/root action only (never the alarm): re-reads 'unconfirmed' creates by name
// -> { state: 'pending'|'active'|'coalesced'|'failed'|'blocked'|'unknown', name, reason, work }
```

- `store.get/put` — private persistent store, one owner-bound record `computer-backups:v1:<ownerTag>`; a record whose
  `owner` differs is refused. Calls must be serialised per owner (the DO input queue).
- `provider.getSnapshot(account, nameOrId)` (null = 404, rejection = unknown), `createSnapshot(account, machineId, name,
  {includeMemory:false})`, `removeSnapshot(account, id)` (DELETE by id; `'accepted'` is not completion). Errors carry an
  HTTP `status`; 4xx other than 408/429 is definite, everything else is an unknown outcome.
- `protectedNames(ownerTag)` — names/ids that must not be deleted (selected template, prepared images, manual captures,
  the current machine's template). Read just before every delete; if it fails, nothing is deleted that tick.
- `work:true` means capture/cleanup still needs ticks even when the begin's state is terminal (e.g. the retention
  delete after the new backup became active). The root keeps a bounded alarm while `work` or `pending`/`unknown`.

`pending`/`unknown` keep the lifecycle's `backing_up` phase ticking; `active`, `coalesced`, `failed`, `blocked` end it.
Reasons: `not_stopped`, `busy` (another machine's capture in flight), `recent`, `unchanged`, `daily_limit`,
`retention_blocked`, `cleanup_blocked`, `ownership_unproven`, `foreign`, `name_collision`, `provider_refused`,
`provider_error`, `create_unconfirmed`, `timeout`, `bad_request`, `request_conflict`, `no_backup` (`not_applied` only
appears in ledgers written before this rule; it is no longer produced).

**Unconfirmed create (lifecycle peer note).** A create whose answer was lost (no answer, 5xx, 408/429, or a restart
while `requested`) and that then reads 404 by exact name 5 times answers `{ state: 'unknown', reason:
'create_unconfirmed', work: false }`. The lifecycle keeps its own bounded `backing_up` poll and then ends as
`unknown`; ticks in that state make no provider call. Every new `begin` answers `blocked/create_unconfirmed` until
`reconcile()` proves the resource ours (it then continues as a normal capture) or contrary evidence marks it
`foreign`/`unproven`. The original `requestId` keeps replaying `unknown`, never `failed`.

## Rules

- **Idempotency.** The same `requestId` with the same arguments replays; other arguments are `request_conflict`. A
  begin during an in-flight capture of the same machine joins it.
- **Coalescing.** A verified backup of the same account+machine younger than 6 h answers `coalesced/recent`. A known
  `environmentRevision` equal to the latest verified backup's answers `coalesced/unchanged`. An unknown (null)
  revision never claims unchanged; it only gets time coalescing. At most 4 new captures per 24 h, failed ones included.
- **Create.** Generated name `cbak-<first 16 of ownerTag>-<base36 seconds>-<6 random>`: at most 38 characters for
  every valid owner tag (8–32) and timestamp, inside the restore UI's 3–48 rule and `COMPUTER_SNAPSHOT_NAME`, so a
  backup is selectable for restore. The ledger record and provenance keep the full owner tag. The tick preflights the
  exact name (an existing one is a collision: never adopted, never deleted), persists `requested`, then sends one
  create. A definite 4xx refusal (not 408/429) releases the intent: the provider said no. An unanswered create (or a
  persisted `requested` after a restart) is reconciled by exact name, never resubmitted. Finite 404s do not prove an
  old create cannot still land, so after 5 consecutive 404s it becomes `unconfirmed`: still counted as an owned slot,
  never deleted or dropped, automatic reads stop, and it blocks every new capture (so repeated daily ends cannot pile
  up unaccounted snapshots). Only an explicit `reconcile()` re-reads it; strict ownership proof (exact name, id,
  source machine, `general === false`) recovers it, a 404/error leaves it unconfirmed, contrary evidence marks it
  `foreign`.
- **Ownership proof.** `active` requires the provider DTO to show the exact name, an id (not used by another ledger
  item), `sourceSandboxId === recorded machine id` and `general === false`. Missing evidence → `ownership_unproven`;
  contrary evidence → `foreign`. Both preserve the resource, are never deleted, and block new captures.
- **Retention.** Keep 3 verified backups plus at most one pending replacement (4 owned provider resources). The
  oldest is deleted only after a newer one is verified; the newest verified backup (per account) and protected names
  are never candidates. Owned provider snapshots in `error`/`build_failed` are deleted once ownership is proven. A
  create waits while 4 resources are owned and gives up as `retention_blocked`.
- **Delete.** Fresh GET by id with full ownership proof → persist `deleting` → DELETE by id. Completion is only a
  later GET 404; `removing` is in progress. If the snapshot is still present and not removing, the DELETE is re-sent
  (2 sends in total, each after fresh ownership and protection checks); then `delete_blocked`. A definite refusal is
  `delete_blocked` at once. `delete_blocked` items are only re-read; a 404 clears them.
- **Blocking.** `stale` (a capture still unconfirmed after 120 reads), `unconfirmed` (5 × 404 after an unknown
  create), `delete_blocked`, `unproven`, `foreign` block
  every new capture. They stay counted as owned resources (deleting/unknown included); history is not a resource.
  Expiry or a stale entry never causes a blind create.
- **Bounds.** Owned items ≤ 4 (+ blocked anomalies, which stop growth), 32 begin receipts, 32 removal receipts,
  creates in the last 24 h. Terminal receipt answers are frozen so trimming never rewrites a replay.
- **Usage.** Snapshot size units are undocumented, so `summary().usage` is `'unknown'`; no cost or quota is derived.

## Known limits

- Verified backups are not re-read for out-of-band disappearance; the owned count can then be conservative (too high).
- An `unconfirmed` create blocks all automatic backups for that owner until someone calls `reconcile()` (the root's
  wiring of that explicit action is not part of this module). This is deliberate: blocking is preferred to an
  unaccounted snapshot. Ledgers written before this rule may hold `not_applied` history entries whose late resource is
  not tracked; nothing here deletes it.
- No live Daytona run: field presence of `sourceSandboxId`/`general` on `GET /snapshots/{id}` must be confirmed live
  by the root; without them every backup is `ownership_unproven` (safe, but blocks).

Tests: `node test/cloudbite-computer-backups.mjs` (fakes only).
