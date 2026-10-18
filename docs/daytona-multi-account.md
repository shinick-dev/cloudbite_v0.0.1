# Cloudbite — optional second Daytona account

Cloudbite can place expert sandboxes in two different Daytona organizations so that both organizations'
capacity pools are used. This is placement only: it does **not** raise Cloudbite's own limits (3 experts
provisioning/running at once per project, 5 experts per project, 2 live projects), and it makes no claim about
provider quota or throughput. Each organization's own Daytona limits still apply to the sandboxes placed in it.

## Settings

| Name | Required | Meaning |
|---|---|---|
| `CLOUDBITE_DAYTONA_API_KEY` | yes | Primary account key (Worker secret). Unchanged. |
| `CLOUDBITE_DAYTONA_API_URL` | yes | Primary API URL. Unchanged. |
| `CLOUDBITE_DAYTONA_SNAPSHOT` | no | Primary snapshot. Unchanged; never sent to the secondary. |
| `CLOUDBITE_DAYTONA_SECONDARY_API_KEY` | no | Secondary account key (Worker secret). Must be a key of a **different** account. |
| `CLOUDBITE_DAYTONA_SECONDARY_API_URL` | no | Secondary API URL. Defaults to the primary URL. |
| `CLOUDBITE_DAYTONA_SECONDARY_SNAPSHOT` | no | Secondary snapshot. Defaults to **no snapshot** (snapshots are organization-scoped). |

- No secondary setting at all: single-account behavior, every expert on the primary account (as before).
- Fail closed: any secondary URL/snapshot without a key, a key equal to the primary key, an invalid secondary URL or
  an invalid secondary snapshot makes live execution unavailable. Bootstrap and the 503 error list only setting
  names (e.g. `CLOUDBITE_DAYTONA_SECONDARY_API_KEY`), never values. Cloudbite never silently drops to primary-only.
  As with any other live setting, a malformed configuration also pauses cleanup until it is fixed.

## Placement and pinning (`src/cloudbite-project.ts`)

- Account ids are internal and stable: `primary`, `secondary`.
- When an expert is admitted (queued → creating), it is assigned an account and this is persisted **before** the
  first provider create: `accounts[(projectOffset + runIndex) % accounts.length]`, where `projectOffset` comes from
  the project id. Deterministic and balanced; no module-level or global round-robin state.
- With the account, a credential binding fingerprint is stored (truncated SHA-256 of account id, API URL and key).
  The expert record and every cleanup entry (sandbox id entries, the creation-label entry of an uncertain create,
  ids found later by label after cancelled or lost claims) carry `account` + `binding`.
- Every get/list/exec/upload/download/session/start/delete for an expert or a cleanup entry uses the pinned account.
  A lost create response is resolved by label lookup in that account only. Creation is never retried in another
  account after a timeout, 429 or 5xx, and there is never a second POST for an uncertain create.
- Account id, binding and keys stay in internal records only; project reads, bootstrap, history and activity text do
  not contain them.

### Account missing, key rotated or URL changed

If the pinned account is no longer configured, or its key/URL no longer matches the stored binding:

- a non-final expert on that account is failed (`assigned Daytona account is no longer configured with the same
  credentials; cleanup is retained`); it never continues on another account;
- its cleanup entries stay pending without consuming retries and are retried every ~10 minutes; another account is
  never asked, so another organization's 404 can never confirm a deletion;
- the project's live slot is held until cleanup confirms (the registry TTL still frees a leaked slot).

### Legacy records

Expert and cleanup records written before this change have no account. They resolve to **primary**, and are pinned
to primary (with the current primary binding) before any lookup, adoption, delete or other provider call — even if a
secondary account has been added since.

## Operating: adding, removing, rotating keys

- **Adding** a secondary: set `CLOUDBITE_DAYTONA_SECONDARY_API_KEY` (and URL/snapshot if needed). Only experts
  admitted afterwards can be placed there.
- **Removing** a secondary, **rotating** either key, or **changing** an API URL: first drain — wait until no live
  project is running and every cleanup has completed with the old credentials. Changing them earlier fails the
  experts pinned to that account and leaves their sandboxes pending cleanup until the original credentials are
  restored (Daytona's own auto-stop/auto-delete interval remains the provider-side backstop).
- Do not swap the primary and secondary keys; the binding includes the account id, so swapped keys are treated as
  changed credentials.

## Verification

`node test/cloudbite-runtime.mjs` — the fake Daytona accepts two distinct bearer keys and gives every sandbox an
owning account (another account sees 404). Covered: config defaults/fail-closed names, distribution over both
accounts with the owning key for the whole lifecycle, pin-before-create, no inherited snapshot, lost secondary create
adopted in the secondary without a second POST, cancellation cleanup per account, removed/rotated secondary key
keeping cleanup pending (no wrong 404), restart with legacy records resolving to primary, and secret redaction.
No real provider is contacted.
