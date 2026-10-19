# Personal computer snapshots

A snapshot is a cold copy of the personal computer's filesystem: files and installed programs. Memory is never captured (`includeMemory:false`), so open windows, running programs and unsaved work are lost. Capturing stops the computer first; the DO alarm requests the capture once Daytona reports the machine stopped. Nothing restarts it afterwards.

## Owner APIs

All routes live under `/api/cloudbite/computer`, behind the existing owner cookie. The DO methods are on `CloudbiteComputer`.

| Route | DO method | Effect |
|---|---|---|
| `POST snapshot {requestId,name}` | `computerSnapshot` | Unchanged capture flow (stop first, one request, reconcile by exact name). The standalone page also sends `acknowledgeStop:true`; the service ignores extra keys, so the root router enforces it for that page. |
| `GET snapshots` | `computerSnapshots` | Own capture history. Provider reads only: the machine refresh plus a re-check of at most 3 `active` captures per request, each at most once a minute. A re-check can mark a capture `missing`, or drop it when Daytona names another sandbox as its source. |
| `POST snapshots/select {requestId,account,name}` | `computerSelectSnapshot` | Chooses the template of a future new machine, or clears the choice with `name:null`. Keys are exactly these three. No provider mutation of any kind. |

`GET snapshots` and `POST snapshots/select` answer `{ok:true, items, selected, latest, machine, historyMax}`:

- `items`: newest first, at most 20, each `{name, account, requestedAt, state, error, checkedAt, selected, selectable}`. `state` is `requesting | unknown | snapshotting | active | unconfirmed | error | missing`.
- `selected`: `{account,name}` or `null`.
- `latest`: the single in-flight/latest capture (`ComputerSnapshotView`), still polled by the DO alarm.
- `machine`: `{status, account, id, template}`. `template` names the capture the current machine was created from, or `null` for the prepared image.

The `requestId` ledger works as for other mutations: the same id and arguments replay the current document or the original definite error; other arguments are `request_conflict`. An unanswered provider read (`unknown_outcome`, 503) leaves no ledger entry, so the same id can be sent again.

New error codes: `snapshot_not_selectable` (409: not an own active capture, or a fresh read shows it missing, inactive or foreign), `template_unavailable` (409, from `start`), and `snapshot_missing` (only as a history item's `error`).

## History rules

- An entry is recorded only after the capture request was actually sent (`sourceId` and `requestedAt` stored). A name that was already taken, a 409 collision, or a capture later proven to come from another sandbox never appears, and is never selectable.
- Legacy records (one `snapshot` and no history) migrate only when the capture was requested from the current machine (`sourceId` equals the machine id). Everything else stays out.
- Bound: the oldest unselected entries are removed first; the selected template is never removed by the bound.
- Reusing a name after its old capture disappeared replaces the old entry and clears a selection that pointed at it.

## Template rules

- A selection only applies when `start` must create a machine because none exists, and only for the same account. Other accounts, and no selection, use the prepared image as before.
- Right before that create, the selected capture is read again. No answer: `unknown_outcome` (503), nothing created. Missing, not active or foreign: `template_unavailable`, nothing created. There is no silent fallback to the prepared image; the owner clears the choice instead.
- An existing machine is never touched by a selection: a stopped machine resumes its own disk, accounts never switch, and there is no "restore now" action.

## Standalone page

`/cloudbite/computer/snapshots` (`CLOUDBITE_COMPUTER_SNAPSHOTS_HTML`, `/cloudbite/computer/snapshots.js`, `/cloudbite/computer/snapshots.css`, built by `node tools/build-cloudbite-computer-snapshots.mjs`, `--check` to verify) follows the jobs page rules: same-origin script and style only, no inline code, storage or WebAuthn, KO/EN, 48 px touch targets, 16 px inputs. A 401 links to the main computer page for sign-in.

Capture needs a valid name and the stop acknowledgement checkbox. Choosing applies to own `active` captures only. A POST with no definite answer keeps its `requestId` and exact body in memory: Retry sends identical bytes, Forget drops it. Loading and polling only use `GET snapshots`. The list polls only while a capture is in progress and the tab is visible: first after 5 s, with backoff to 30 s, pausing after 120 polls. Refresh is always available.

Tests: `node test/cloudbite-computer-snapshots.mjs`.
