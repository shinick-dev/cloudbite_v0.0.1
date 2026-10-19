# End backup live probe (cold filesystem capture/restore)

`tools/cloudbite-end-backup-probe.py` (orchestrator, sandboxes) + `tools/cloudbite-end-backup-probe.mjs` (manager driver)
validate the end backup against real Daytona using the **actual** `src/cloudbite-computer-backups.ts` manager,
compiled with esbuild into an artifact module. It is not a separate capture flow: `begin()`/`tick()` run unchanged with a
private file-backed store and a real REST provider (`GET /snapshots/{nameOrId}`, `POST /sandbox/{source}/snapshot
{name, includeMemory:false}`; the driver refuses `removeSnapshot` and any create for a machine other than the owned source).

```
python tools/cloudbite-end-backup-probe.py                      # dry run (default): plan only, no network
python tools/cloudbite-end-backup-probe.py --live --out DIR     # bounded live run
python tools/cloudbite-end-backup-probe.py --cleanup --ledger DIR/ledger-<run>.json
python -B test/cloudbite-end-backup-probe.py                    # offline checks
```

## Flow and safety

1. Re-read the public base `daytonaio/sandbox:0.8.0`; refuse unless `general:true`, `active`, cpu 1 / mem 1 / disk 3, no GPU.
2. Create one source machine (ledger intent first, exact name + `owner`/`cbbak-probe-run`/`cbbak-role` labels); refuse
   unless REST shows cpu<=1, memory<=1 GiB, disk<=3 GiB, gpu 0. Unknown create → reconcile by exact name + labels, never re-sent.
3. Write deterministic synthetic files (~28.1 MiB: config files with 0600/0700, an executable, Unicode/emoji/space names,
   empty file/dir, a symlink), fsync files and dirs, `sync`; record size/SHA-256/mode only (no content logged). Stop, confirm `stopped`.
4. Manager `begin()` (status `stopped`) then `tick()` every 10 s until the manager reports `active` (or the budget ends).
5. Independent proof by name and by id: exact generated name, same id, `sourceSandboxId == source`, `general === false`.
6. Delete the source (verify 404) — only then create the restore machine from that exact snapshot (same caps check).
7. Walk the restore tree and compare every file/dir/link to the spec and to the source manifest (missing/extra/hash/mode).
8. Stop/delete the restore (verify 404); delete the one test snapshot by id after a fresh ownership proof, poll to 404.

Never addressed: the user's personal VM (hard-coded guard), the public base, any id not in the ledger. Key only from
`DAYTONA_API_KEY` (Bearer header), never argv/files/output; redirects refused; errors are HTTP status + short sanitized reason.

## Budget guard (added after the live run below; not itself run live)

Guard version: `.py` sha256 `eb2f7b450c80…3195da` (`.mjs` unchanged, `85da0a2503bd…3284f9`).

`Budget` uses a monotonic clock and enforces the declared limits instead of only recording them:

- **Work**: everything except cleanup must fit `phaseSeconds − cleanupReserveSeconds` (30 min − 6 min).
- **Active machine time**: cumulative over both machines ≤ `activeCpuSeconds − stopReserveSeconds` (15 min − 90 s). A
  machine's interval opens at create *intent* (startup and an unknown create count) and closes only when it is confirmed
  `stopped` or absent; an interval that never closes keeps growing, and no new machine is created while one is open.
- Before every create, upload, in-machine command, manager `build`/`begin`/`tick` and capture wait the remainder is checked;
  the SDK/subprocess timeout is clamped to it (never `0`, which the SDK reads as "no timeout"). Below `minStepSeconds`
  the step is refused with `BudgetExhausted` → result `budget-exhausted`.
- The restore machine is created only if create + upload + verify + stop (`restoreNeedSeconds`, 240 s) fit both budgets;
  otherwise nothing is allocated. An earlier `intent`/`unknown`/`delete-unknown` outcome also blocks any new resource.
- Provider backstops are derived at create time: idle auto-stop = min(5, active minutes left); TTL (from creation) =
  auto-delete = phase minutes left. The live run below used the old fixed 15 / 40 / 45 min, which could exceed the
  30 min phase and 15 min active limits in a slow run.
- Stop and cleanup of ledger-proven resources are never refused for budget (stop timeout stays within the phase when it
  can, minimum 10 s); the cleanup reserve is a plan, not a hard stop, because stranding an owned resource is worse.
- The ledger (schema v2) records `activeWall` with `measure: wall-clock … not provider-billed CPU usage`, the derived
  provider settings per machine, and the SHA-256 of both probe scripts. Billed CPU usage is not measured by this probe.

Offline regressions (`test/cloudbite-end-backup-probe.py`) drive the real `run_live`/`Machines`/`Manager`/`cleanup` code
with a fake clock, provider and Node driver: normal run; slow capture → no restore create, source + snapshot still
deleted; capture never active → ticks stop at the work budget; slow source startup/upload/command → no restore though
phase time remains; unknown create → interval stays open, nothing re-sent; every timeout ≤ remainder; only ledger ids
(and the public base) are addressed, never the protected VM; default/`--help` stay offline and never echo the key.

## Result 2026-10-19 (run `3a9df4abcc57`, n=1 — no percentile claims)

Manager source `src/cloudbite-computer-backups.ts` at base `33ddfea`, sha256 `1376b75e…c69d0`; compiled module
sha256 `7af6194f…ec27f` (esbuild 0.28.1). Result **verified**, remaining resources **0**; afterwards an independent
GET by id returned 404 for source, restore and snapshot.

Probe version that ran: the scripts as committed in `98eb8ec` (2026-10-19 18:00:06 +0900; the run's source create is
09:00:20Z) — `.py` blob `ce4555b7`, sha256 `19534c66e5e7…b119bc`; `.mjs` blob `ac09afbe`, sha256 `85da0a2503bd…3284f9`.
The v1 ledger did not record a script hash, so this attribution rests on commit/run timing. That version had the
unenforced budget described above; the budget guard is a later revision whose exact code has **not** been run live.

| phase | s |
|---|---|
| preflight (base read) | 2.4 |
| source create | 2.1 |
| synthetic write + fsync | 1.8 |
| stop (confirmed) | 1.4 |
| manager begin | 0.1 |
| capture (begin → manager `active`, 27 ticks; 25 reads `snapshotting`) | 284.1 |
| ownership proof | 0.9 |
| source delete (404) | 1.6 |
| restore create | 3.5 |
| restore verify | 1.5 |
| cleanup (restore 404, snapshot `removing` → 404) | 8.1 |
| total | 309.9 |

- 29,425,850 bytes, 9 files / 8 dirs / 1 symlink: restore matched spec and source on size, SHA-256 and mode (0 mismatches).
- Snapshot proof by name and id: `general:false`, `sourceSandboxId` = owned source, state `active`, cpu1/mem1/disk3/gpu0.
- Provider calls by the manager: 1 POST (200), 26 GET 200, 1 GET 404 (preflight). Probe: 1 DELETE snapshot (200), then 404.
- Machine started-to-stopped wall-clock (ledger `activeCpuSecondsSource/Restore`, measured from create *return* to
  confirmed stop, so startup is excluded): source 3.2 s, restore 3.3 s. This is not billed CPU usage, which was not measured.

## Limitations

Validates a cold filesystem capture/restore of a stopped 1 CPU machine only. Not covered: R2, a desktop or physical phone client, the CloudBite
endpoint/auth/end UI flow, retention across several backups, running processes/RAM, app/OAuth/profile recovery, larger
disks, billed CPU usage, a slow run hitting the budget against the real provider. Not T0085 whole acceptance.
