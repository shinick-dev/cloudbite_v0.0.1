# Cloud Files integration

How the pieces of Cloud Files are wired into the worker. The product contract is
`docs/cloudbite/cloud-files-implementation-plan.md`. This file records only the integration routes, the gates that are
still closed and what the tests prove.

Code:
- `src/cloudbite-computer-files-integration.ts`: the bridge routes.
- `src/cloudbite-computer-end-wiring.ts`: the safe-end hooks.
- `src/cloudbite-computer-api.ts`: routing.
- `client/cloudbite-computer-files.ts`: the files page.

## Routes (owner session; every POST needs the exact public `Origin`)

| Route | Does | Never |
|---|---|---|
| `POST files/agent/configure {requestId}` | Proves the recorded running machine is owned (name + every label) and mints the machine capability (`filesAgentGrant`). It then installs the agent and the 0600 capability, and runs agent `init`. | Starts, stops or snapshots a machine. Puts the token in argv, logs or the response. |
| `POST files/materialize {requestId, fileId, versionId?}` | `filesManifest` (typed DO RPC to `FilesService.resolveManifest`) builds the canonical manifest. The agent `register`s it and then `open`s it with `--lease=<requestId hex>`. The answer carries `open`, `workspace: "~/CloudFiles"` and `launched: false`. | Takes paths from the client. Opens an application. |
| `POST files/close {leaseId}` | Releases the lease that materialize took. | — |
| `GET files/agent/status` | Returns agent counts and readiness through a field whitelist. | Reads bodies. Exposes ids, paths or the capability. |
| `GET end`, `POST end`, `POST end/settings` | Forward to `computerEndStatus`, `computerEnd` and `computerEndSettings`. | — |

Behaviour that applies across these routes:
- **R2 absent:** configure and materialize answer `503 store_not_configured` before any provider call, upload or grant. Status answers `{available:false, reason:"store_not_configured"}`. The metadata catalog keeps working.
- **No running machine:** the answer is `409 not_running`. Nothing is started, and the page explains this.
- **Retries:**
  - The lease id is derived from the `requestId`. A retried materialize therefore replays the same lease (`fetchedBytes: 0`) instead of leaking a second one that would block a safe end.
  - The page keeps the exact body of an unconfirmed request and resends it unchanged.

## Files page

- **Prepare on cloud computer:** separate from *Download to this device*. It explains that no app is opened and that the computer is never started.
  - It is disabled without R2.
  - `agent_not_installed` offers *Set up file access on cloud computer*.
  - A prepared copy shows *Release on cloud computer*.
- **Keep (pin):** worded as a request or setting stored with the file list, not as a promise that a copy stays on the computer.
- **Storage:** shows *Occupied* = `usedBytes + reservedBytes`. Saved versions and bytes held by unfinished or ended uploads until cleanup are listed separately. No savings claims are made.

## Gates that stay closed

1. **HTTP cache eviction (manual and auto):** gated in the agent.
   - `HttpBackend.eviction_policy = None`, so `evict` answers `eviction_gated` and `--auto-evict` never frees a file.
   - Only a backend that declares `eviction_policy == "verified"` may evict. Today that is only the test fake.
   - There is no force bypass.
   - Opening this gate needs live persistence evidence and server-effective pins reaching the agent.
2. **`files_verified` safe end:** unavailable (`409 files_not_configured`) because no files drain hook is wired; `computerEndHooks` returns `{ backup }` only. Wiring it needs both of these:
   - the watcher + agent combined `prepare-end` report installed and launched on the machine. The watcher is not installed or launched by these routes, and no background worker runs on the original VM;
   - proof that workerd delivers the agent's HTTP calls while the computer DO alarm awaits the drain without deadlock. Those calls include `computerMachine` and `computerEndStatus` on the same DO.
3. **Safe-end admission barrier:** in place for the browser.
   - While an end is draining or stopping (`uploadsFrozen`), browser `uploads/begin` answers `409 end_in_progress` (retryable).
   - An unreadable end state fails closed with `503 catalog_unavailable`.
   - Agent uploads (begin/body/commit/abort) and listing stay open, so a future drain can finish.

## Automatic backup (`disk_backup`)

`computerEndHooks` wires `ComputerBackups` with:
- the computer DO storage;
- each item's own Daytona account, never substituted (a missing account is a definite refusal before any request);
- `restDaytona` get/create (`includeMemory:false`)/remove-by-id;
- CSPRNG name suffixes;
- `computerBackupProtectedNames`.

It does not need R2.

When the backup outcome is unknown with `create_unconfirmed` and `work:false`, the end hook reports it as **blocked** and keeps the reason, rather than polling a state that cannot change. The hook's `begin` first runs a read-only `reconcile` when the summary has unconfirmed creates. That reconcile can adopt a proven capture, and it never creates or deletes anything.

## Evidence class

`test/cloudbite-computer-files-integration.mjs` runs this chain:
1. the real `computerRoute`
2. the integration routes
3. the bridge
4. the real grant
5. the **generated** `FILES_AGENT_SOURCE`, run by the local Python
6. HTTP over 127.0.0.1
7. the real agent routes
8. the real runtime and core

It covers:
- upload, materialize hash, edit, sync and reconcile, and browser download hash;
- catalog-only list;
- stale epoch;
- the end barrier;
- the end API and end wiring;
- no secret in any output.

It is **MOCK** evidence:
- DO storage and R2 are in-memory doubles.
- The "VM" is a local directory behind fake Daytona exec/upload.
- The https gateway is replaced by a loopback HTTP proxy, so TLS is not exercised.

It is not live persistence, physical-phone or latency proof.
