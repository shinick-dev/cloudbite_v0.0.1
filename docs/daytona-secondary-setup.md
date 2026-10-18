# Second Daytona account: local onboarding

Use the existing Windows secret tooling; do not create another encrypted credential file inside the repository.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\Users\user\.secrets\Add-DaytonaSecondary.ps1"
```

The helper performs three steps:

1. `Set-Keys.ps1 -Names DAYTONA_SECONDARY_API_KEY -SkipWslenv -NoVault`: hidden input into the User environment. The primary `DAYTONA_API_KEY` is preserved.
2. `KeyStore.ps1 -Action backup`: include the secondary name in the normal `keys.enc.json` encrypted backup. Supply the existing passphrase; leave existing vault-only entries blank to preserve them. Both tools' default name lists include the secondary key.
3. `Push-DaytonaSecondary.ps1`: use the existing `k.shinick.dev` CLI login and physical security-key approval in Aside; create the separate `daytona-secondary` provider or update only its value when its destination and environment source match. Verify its registration through the administrator list. Mismatched definitions stop without an update.

The API provider store is different from `/vault`, which stores end-to-end encrypted login items. This onboarding uses the provider store, as the normal `Set-Keys.ps1` → `kv.ps1` workflow does. It does not change the original provider, deploy `gw-shinick`, or alter its authentication policy.

After a successful encrypted backup, retry only the remote step if authentication was interrupted:

```powershell
& "C:\Users\user\.secrets\Push-DaytonaSecondary.ps1"
```

After the first registration, the existing CLI can update it:

```powershell
& "C:\Users\user\source\gw-shinick\kv.ps1" push -Sources DAYTONA_SECONDARY_API_KEY
```

## Cloudbite activation

Vault registration is not Worker activation. The coordinator must validate the second credential, confirm that it belongs to a different Daytona organization, and transfer its User environment value through stdin to Cloudbite's `CLOUDBITE_DAYTONA_SECONDARY_API_KEY` Worker secret. No key belongs in CLI arguments, chat, source, screenshots, or logs. No key-store ciphertext or passphrase needs to be inspected by an agent.

Daytona organization quotas are independent; two keys for one organization do not add capacity. Two different organizations' available resources can be used together, but this does not establish a 2× application throughput improvement. Nosana capacity and application admission limits remain separate. See [Daytona organizations](https://www.daytona.io/docs/en/organizations/) and [limits](https://www.daytona.io/docs/en/limits/).

## Verification

The local onboarding scripts were parsed with Windows PowerShell 5.1. A mock-only HTTP harness exercised provider creation, value-only updates, rejection of a mismatched provider, denied authentication, and absence of credential values in output. Those checks do not constitute a real Vault upload, encrypted backup, security-key authentication, or activation of the second account. Those require the user's actual input and a subsequent runtime check.
