# Third Daytona account

> Updated 2026-10-19: selection now supports 100 roles and the old concurrency-3 pilot is removed. See [current parallel execution policy](cloudbite/parallel-execution.md). Earlier acceptance records below describe their original release.


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

## Production acceptance (2026-10-19 KST)

Source `5b7397031bb269b1c4ff599db0a1b4ad9f2e5e33` was deployed to the existing independent `cloudbite-v001`
Worker. After the tertiary secret upload, active version `49d284a6-114c-401e-8cd5-4391503b10f6` served
`https://cloudbite.shinick.dev`; bootstrap reported live execution and Jev routing ready with no missing settings.
`npm run check` and all ten suites in `npm run test:cloudbite` passed, including 42 runtime checks.

One synthetic browser run selected Product Manager, Business Strategist and Software Architect. Read-only
label-filtered Daytona queries, authenticated separately with each account, observed exactly one running QA
sandbox in each of the three organizations. All three experts completed with three valid opinions and zero
failures (6, 5 and 6 collected artifacts respectively). Every assigned sandbox then returned 404 with its owning
key, and all three organizations' project-label listings were empty. The coordinator deleted only its own QA
history through the UI, verified its source returned 404 and it left the index, then restored the default Jev
new-question screen. This was a connectivity and lifecycle test, not a throughput or quota benchmark.

The user confirmed local key entry only. Remote API-provider Vault registration still requires the existing
physical-security-key approval, and encrypted backup remains unconfirmed. Neither was claimed complete.
