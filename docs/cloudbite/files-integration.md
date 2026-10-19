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
| `POST files/agent/configure {requestId}` | Proves the recorded running machine is owned (name + every label) and mints the machine capability (`filesAgentGrant`). It then installs the agent, the watcher (`FILES_WATCH_SOURCE`) and the 0600 capability, runs agent `init`, runs watcher `resume` (clears pause/draining) and submits one bounded watcher `run` in the toolbox session `cloudbite-files-watch` (see *Watcher*). | Starts, stops or snapshots a machine. Puts the token in argv, logs or the response. Claims the watcher is running. |
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
- **JSON bodies:** read by `filesRouteJson` as a byte-bounded stream (4096 bytes). A declared `Content-Length` must be decimal and within the cap. A missing or forged length cannot make it buffer more: bytes are counted per chunk and the body is cancelled once over the cap. Malformed UTF-8 (fatal decoder), malformed JSON and unknown keys answer `400 bad_request` before any provider step.

## Watcher (continuous autosave)

Paths, all under the existing private base `~/.cloudbite-files` and covered by the same symlink/owner guards as the agent:
`agent/files-watch.py` (0700 via the `.next` + activate path), `watch/` (watcher state, lock `watch.lock`), `watch.log` (0600, truncated over 1 MiB). The token stays only in the 0600 `capability.json`; the watcher reads it from there.

- **Launch:** `restDaytona.spawn` (toolbox session create + `runAsync`), never the synchronous `process/execute` that reaps background children. The fixed command is `exec timeout -k 30 <N+30> python3 -I -B … run --max-runtime N >> watch.log 2>&1` with `N = min(6 h, capability lifetime − 30 s)`, at least 60 s. No `nohup`/`setsid`/`&`.
- **One worker:** the watcher's `watch.lock` makes any second `run` exit `watcher_busy`, so a repeated configure or resume is safe. While a worker holds the lock, `resume` is deferred to it (`resumed: "deferred"`).
- **Honest reporting:** the answer has `watcher: { resumed, agentResumed, launch: "submitted", running: "not_observed" }`. Submission is not reported as a running process; a lost spawn answer is `503 unknown_outcome`.

## Resume after an ordinary stop/start

`computerEndHooks` adds a `resume` hook **only** when R2 (`CLOUDBITE_FILES_BUCKET`), the files object and a valid gateway are bound. Without them there is no hook and no VM operation.

The hook uses the machine the computer object passes (no call back into the computer object, so no queue cycle):
1. `requestId` must be a UUID and the owner tag comes from the machine labels; otherwise `bad_request`.
2. Files `status`: if `writerMachine` is not this machine (including none), it resolves with no VM call and no grant. It never promotes a writer.
3. The bridge proves ownership and `running` (a stopped machine is `not_running`; nothing is started), then runs a read-only probe. A machine without the owner marker, agent, watcher, capability or state (never set up by configure, or set up before the watcher existed) is skipped untouched; reconfigure installs the watcher.
4. Otherwise: `filesAgentGrant` for the same writer, refresh only the 0600 capability (exact owner marker required), watcher `resume`, and submit the bounded `run` as above.

A failed or unknown step rejects so the computer object's bounded retry applies. Residual: if the writer is cleared between step 2 and the grant, `filesGrant` would assign this machine (the runtime is outside this change). After a writer-epoch takeover the agent's pinned scope no longer matches and it fails closed until reconfigure.

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
2. **`files_verified` safe end:** unavailable (`409 files_not_configured`) because no files drain hook is wired; `computerEndHooks` returns `{ backup }`, plus `resume` with R2, never `drain`. The watcher is now installed and launched (above), but normal-session sync does not depend on the end gate. Wiring the drain still needs:
   - a separate re-entry/admission proof for the combined watcher + agent `prepare-end` report;
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
- bounded JSON (chunked and forged-length oversize cancelled, bad UTF-8/JSON refused);
- autosave: configure spawns the real generated watcher as a local background process, which saves an edit with no manual sync; a duplicate exits `watcher_busy`; after the workers are killed (a simulated stop) the resume hook rotates the capability and relaunches, and the next edit is saved; an un-set-up home is only probed; another writer means no VM call;
- no secret in any output.

`test/cloudbite-computer-files-bridge.mjs` also runs the prepare/activate/probe/refresh/watcher scripts on a throwaway POSIX home (WSL when present): guards, modes, real `resume`, duplicate lock, log without token, symlink refusals.

It is **MOCK** evidence:
- DO storage and R2 are in-memory doubles.
- The "VM" is a local directory behind fake Daytona exec/upload.
- The https gateway is replaced by a loopback HTTP proxy, so TLS is not exercised.

It is not live persistence, physical-phone or latency proof.
