# Third Daytona account

The tertiary slot extends the existing account-pinned runtime. The stable account ids are `primary`, `secondary`,
and `tertiary`; an omitted slot is not renumbered. Every expert's existing assignment and credential binding remain
unchanged when another account is added. Placement uses the available account array when admitting new experts.

## Local registration

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\user\.secrets\Add-DaytonaTertiary.ps1"
```

This uses `Set-Keys.ps1` hidden input for User environment `DAYTONA_TERTIARY_API_KEY`, then
`Push-DaytonaTertiary.ps1` to register only the `daytona-tertiary` API-provider entry at `k.shinick.dev`.
The existing primary and secondary keys/providers are preserved. The existing CLI security-key authentication
opens in Aside. Neither key values nor administrator tokens are printed or stored by these helpers.

The previous encrypted-backup attempt failed passphrase verification. To avoid blocking registration on that
unresolved step, the tertiary helper defaults to **no encrypted backup** and states that explicitly. Existing
`keys.enc.json` is not changed. `Set-Keys.ps1` and `KeyStore.ps1` default name lists include the tertiary variable,
so a later normal backup includes it. Supply `-Backup` only when the existing store's passphrase is known.
`-NoVault` performs local key entry alone and does not claim remote registration.

If only local entry succeeded, continue without entering the key again:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\user\.secrets\Push-DaytonaTertiary.ps1"
```

After first registration the normal `kv.ps1 push -Sources DAYTONA_TERTIARY_API_KEY` flow can update that provider.
This is the API-provider key store, separate from the end-to-end encrypted `/vault` login-item feature.

## Worker configuration

| Name | Meaning |
|---|---|
| `CLOUDBITE_DAYTONA_TERTIARY_API_KEY` | Optional Worker secret. Transfer the local User environment value through stdin. |
| `CLOUDBITE_DAYTONA_TERTIARY_API_URL` | Optional; defaults to the primary Daytona API URL. |
| `CLOUDBITE_DAYTONA_TERTIARY_SNAPSHOT` | Optional; no snapshot by default. Never inherits another organization's snapshot. |

An incomplete/invalid tertiary configuration or a key equal to either existing key blocks live execution and
reports only setting names. Authentication and distinct organization identity must be checked before activation;
different keys alone do not prove separate quota. No application expert/concurrency/project caps are changed.
The existing account fingerprint, same-account uncertain-create recovery, cancellation and cleanup rules apply.
Drain all assigned sandboxes and cleanup entries before removing or rotating a slot's credentials.

## Checks

`npm run check` and `node test/cloudbite-runtime.mjs` pass (42 runtime checks). New coverage includes three real
Python runners against separate fake organizations, every lifecycle operation using its owning credential,
snapshot isolation, partial/duplicate config rejection, omitted secondary with a stable tertiary slot, and tertiary
lost-create adoption followed by restart, key removal/rotation, blocked cleanup, restoration and no duplicate POST.
The existing 39 checks still pass. These runtime tests do not contact the real providers.

Local helper checks use Windows PowerShell 5.1 with mocked HTTP for creation, value-only updates, denied approval,
misconfigured-provider rejection and no credential output; they do not claim actual remote Vault registration.

Read-only local-key probes authenticated all three keys, identified three distinct organizations and verified
sandbox create/delete permissions. Key values and organization identifiers were not written to the report.
