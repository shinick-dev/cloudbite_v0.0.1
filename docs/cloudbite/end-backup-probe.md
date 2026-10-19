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
4. Manager `begin()` (status `stopped`) then `tick()` every 10 s until the manager reports `active`.
5. Independent proof by name and by id: exact generated name, same id, `sourceSandboxId == source`, `general === false`.
6. Delete the source (verify 404) — only then create the restore machine from that exact snapshot (same caps check).
7. Walk the restore tree and compare every file/dir/link to the spec and to the source manifest (missing/extra/hash/mode).
8. Stop/delete the restore (verify 404); delete the one test snapshot by id after a fresh ownership proof, poll to 404.

Never addressed: the user's personal VM (hard-coded guard), the public base, any id not in the ledger. Key only from
`DAYTONA_API_KEY` (Bearer header), never argv/files/output; redirects refused; errors are HTTP status + short sanitized reason.

## Result 2026-10-19 (run `3a9df4abcc57`, n=1 — no percentile claims)

Manager source `src/cloudbite-computer-backups.ts` at base `33ddfea`, sha256 `1376b75e…c69d0`; compiled module
sha256 `7af6194f…ec27f` (esbuild 0.28.1). Result **verified**, remaining resources **0**.

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
- Active machine time: source 3.2 s, restore 3.3 s.

## Limitations

Validates a cold filesystem capture/restore of a stopped 1 CPU machine only. Not covered: R2, a physical phone, the CloudBite
endpoint/auth/end UI flow, retention across several backups, running processes/RAM, app/OAuth/profile recovery, larger
disks. Not T0085 whole acceptance.
