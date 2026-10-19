# Cloud Files runtime (`src/cloudbite-computer-files-runtime.ts`)

Product contract: `docs/cloudbite/cloud-files-implementation-plan.md`. Body/entry shapes are the core contract
(`src/cloudbite-computer-files-contract.ts`); errors use the core envelope `{error:{code,message,retryable}}`.

## Storage

- One Durable Object `CloudbiteComputerFiles` per owner tag (`idFromName(computerOwnerTag())`), migration `v7`,
  holds the core catalog in its own SQLite storage. The first owner id binds the object; any other id is `not_found`.
- File bodies: optional native R2 binding `CLOUDBITE_FILES_BUCKET`. It is **not configured** (R2 is not activated by
  owner choice) and `wrangler.cloudbite.jsonc` carries no placeholder bucket. Status reports `blobs:"not_configured"`;
  begin/body/commit/content answer `store_not_configured` 503. Metadata (list/create/rename/pin/open/local-state)
  works without R2. There is no fallback store and no simulated success.
- Limits: 32 MiB per file, 2 GiB quota, JSON bodies 8 KiB, list limit ≤ 200. Bodies stream Worker → DO → R2
  (`content-length` required and must equal the declared upload size); checksum is verified by the provider
  (`sha256` put option + stored checksum), never from client metadata or ETag.

## Browser surface — `/api/cloudbite/computer/files...`

Owner auth is checked by `computerRoute` first; this module then refuses `sec-fetch-site: cross-site`, and any
non-GET without `Origin == env.ORIGIN` (admin-token callers may omit Origin). Routes are exactly the UI contract
(`ui-task.txt`): `GET files`, `GET files/status`, `POST files/create|rename|pin|open|uploads/begin`,
`PUT files/uploads/<id>/body`, `POST files/uploads/<id>/commit|abort`, `GET files/uploads/<id>`,
`GET files/content/<fileId>?versionId=` (attachment, `application/octet-stream`, sandbox CSP, `x-cloudbite-sha256`).
List/status/open never read a body. The standalone page is served at `/cloudbite/computer/files(.js|.css)`.

## Agent (VM) surface — `/p/_cloudbite/computer/files/agent/v1/` (frozen)

Gateway host only (`env.CLOUDBITE_GATEWAY_URL`), `authorization: Bearer cbfa_<43 base64url>` only, owner cookies are
never consulted, a request with `Origin` is refused. Routes: `GET status|list|uploads|uploads/<id>`,
`GET content/<fileId>?versionId=&offset=&length=`, `POST create|open|uploads/begin|local-state`,
`PUT uploads/<id>/body`, `POST uploads/<id>/commit|abort`. Not exposed: rename, pin, advanceWriter, grant.

Checks on every call: active capability hash matches, not expired, the recorded machine equals the capability
machine and is `running`, and the capability machine/epoch are still the workspace writer. `begin`/`local-state`
bodies must carry the capability epoch (and machine); `body`/`commit`/`abort` additionally require the upload's own
`writerEpoch` to equal the capability epoch, so an upload begun under an older grant or by the browser is never
finished by a newer capability.

### Proof level of the machine check

`computerMachine(tag)` returns what the owner's computer DO has **recorded**: the machine record it created (`created:'owned'`)
and the last status it stored for it (here required to be `running`). It is not a live provider probe. A machine stopped at the provider without the DO
noticing still passes this check until the DO records the change; the writer-epoch fence and capability expiry (6 h)
bound that window. Nothing here should be reported as live machine state.

## Capability grant

`filesAgentGrant(env, ownerTag, machine, requestId)` → `{ok:true, body:{token, machineId, writerEpoch, workspaceId,
expiresAt, endpoint}}` or `{error, status}`. The caller (root-auth route) must have verified that `machine` is the owner's
running computer. An unclaimed workspace is given to that machine (epoch + 1); the same machine keeps its epoch; a
different writer is `writer_conflict` 409.

- Singleton: `cap/active` holds the one live capability (SHA-256 of the token, never plaintext); `cap/fence` is bumped by
  every grant and revoke. A grant writes only if the fence it read before minting is unchanged inside the transaction;
  otherwise `grant_superseded` 409 (retryable) and the minted token is discarded. Concurrent grants therefore leave
  exactly one live capability, and a revoke racing a grant cannot be undone by it.
- Unknown persistence (transaction/RPC throws): `commit_unknown` 503 with **no token**. Nothing unconfirmed can be
  installed; retry with a new grant.
- `filesRevokeAgents(ownerId)` (DO RPC) deletes the active capability and bumps the fence.
- The token exists in plaintext only in the grant return value, which must go only to the private VM install step.

### Wiring for root (bridge helper, not imported here)

The bridge module (`src/cloudbite-computer-files-bridge.ts`, CFBridge early contract after the freeze) takes
`gateway: string` (= `env.CLOUDBITE_GATEWAY_URL`) and a `grant({machine, requestId})` dependency whose result is
exactly `filesAgentGrant`'s `FilesResult<FilesAgentGrant>`. Root connects it in the configure route once the bridge is
committed. `filesAgentGrant` needs a full `ComputerMachineRef` with `status`, so take it from the recorded machine rather
than the bridge's machine shape:

```ts
gateway: env.CLOUDBITE_GATEWAY_URL,
grant: async ({ machine, requestId }) => {
  const m = await computer.computerMachine(tag);                    // recorded owned machine (see proof level)
  if (!('ok' in m) || m.machine.id !== machine.id)
    return { error: { code: 'ownership_mismatch', message: 'ownership_mismatch', retryable: false }, status: 409 };
  return filesAgentGrant(env as FilesEnv, tag, m.machine, requestId); // endpoint = gateway + FILES_AGENT_PATH
},
```

The bridge refuses a grant whose `endpoint` is not its normalized gateway origin + the agent prefix, so `gateway` must be
the same `env.CLOUDBITE_GATEWAY_URL` value (an origin without a trailing slash).

The agent must use `endpoint` from the capability (gateway `/p/_cloudbite/computer/files/agent/v1`) and the routes above
(`content/<fileId>?versionId=`, `POST open`), not an `/api/...` prefix.

## Evidence level

`test/cloudbite-computer-files-runtime.mjs` runs the real `computerRoute`, runtime and core service over in-memory DO
storage and R2 doubles (mock: not persistence or durability evidence). A local `wrangler dev` (workerd SQLite DO + local
R2 simulator) smoke is recorded in the implementation evidence; it is local-only, never deployed, and is not live
remote, R2, phone or latency proof.
