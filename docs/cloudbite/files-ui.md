# Cloud files page (`/cloudbite/computer/files`)

A standalone page, built like the costs and snapshots pages: `client/cloudbite-computer-files.ts` and `.css` are pinned by `node tools/build-cloudbite-computer-files.mjs` into `src/cloudbite-computer-files-page.ts`, which exports `CLOUDBITE_COMPUTER_FILES_PATH/HTML`, `_JS_PATH/_JS` (`/cloudbite/computer/files.js`) and `_CSS_PATH/_CSS` (`/cloudbite/computer/files.css`). The page loads only those same-origin files (CSP `script-src 'self'; style-src 'self'`), no CDN, web font, inline code or browser-side storage. `--check` verifies the generated module is current. Route registration and navigation links are root integration work and are not part of this page.

Sign-in stays on `/cloudbite/computer`: the page only uses the existing owner cookie. Any 401/403 shows a sign-in link to `/cloudbite/computer?lang=<current>`. No WebAuthn, no token.

## What the page calls

All under `/api/cloudbite/computer/files`, bodies and answers as in `cloudbite.files.core-contract.v1` (errors `{error:{code,message,retryable}}`).

| Action | Request | When |
|---|---|---|
| Storage status | `GET status` → `{status:StorageStatusView}` | Load, Refresh, tab becoming visible again |
| List a folder | `GET ?parentId=<id>[&cursor=<c>]&limit=100` → `ListResponse` | Load, folder change, Show more |
| New folder | `POST create {requestId,parentId,name,kind:'dir'}` → `{entry}` | Explicit press |
| Rename | `POST rename {requestId,fileId,expectedRev,name}` → `{entry}` | Explicit press |
| Keep / stop keeping | `POST pin {requestId,fileId,pinned}` → `{entry}` | Explicit press |
| Download | `POST open {fileId,versionId}` → `{descriptor}`, then the link `content/<fileId>?versionId=<versionId>` with `download=<name>` | Explicit press only |
| Upload | `POST create {…kind:'file'}` → `POST uploads/begin {requestId,fileId,baseVersion:null,writerEpoch,size,sha256}` → `PUT uploads/<uploadId>/body` (raw bytes) → `POST uploads/<uploadId>/commit {uploadId}` → `{result}` | Explicit press |
| Reconcile | `GET uploads/<uploadId>` → `{upload}` | Continue after a lost body/commit answer |

GET requests are metadata only; listing or selecting a file never reads its body. A download is the browser following the same-origin content link that the page activates once; the link stays visible as the single fallback. There is no provider URL, no deletion control (no backend recovery policy yet), no remote-computer "open" (later bridge work) and no polling: nothing runs while the tab is hidden, and nothing starts a machine or any paid provider action.

## Rules the page keeps

- **Storage honesty.** `catalog: not_configured` shows that nothing is stored and lists nothing; `blobs: not_configured` lists names but disables download and upload. The page distinguishes Cloudbite files (remote original), the browser download (separate copy on this device, not synced back) and the cloud computer cache (per-file `remote | local | dirty`).
- **Exact retries.** Each write keeps its requestId and serialised body in memory until a definite answer. An unconfirmed answer (network, 408, 5xx except `store_not_configured`, or a retryable code) offers Retry with the byte-identical request, or Forget. Only one simple write runs at a time.
- **Upload slice.** One user-chosen file, at most 32 MiB (or the server's lower `maxFileBytes`), refused before reading. The page reads it once, checks the byte length, hashes it with `crypto.subtle` SHA-256 and freezes name, bytes, both requestIds and `writerEpoch` (from the last status). Continue after a lost body/commit answer first reads `GET uploads/<id>` and resumes from the recorded phase; it never mints a new write. Only `status: committed`, `durable: true` with the local size and SHA-256 counts as saved. `conflict` explains the preserved sibling copy in the same folder; a different size/hash, `hash_mismatch`, `size_mismatch` or `stale_writer` is shown as not saved. Larger multipart transfers are not offered.
- **Names.** Validated client-side by the catalog rules (no `/ \`, control characters, lone surrogates, trailing dot/space, `.`/`..`, at most 255 UTF-8 bytes) and sent NFC. Server names are drawn with `textContent` inside `<bdi>`, wrap anywhere and never widen the page. `stale_revision` refreshes the list and keeps the draft.
- **List states.** Loading shows only until the first read of a folder finishes. A failed read (network, bad shape, refusal, or a failed status refresh) shows the failure and keeps the rows already shown; a first read that fails shows only the failure, never "Loading…" or "empty". The list is labelled *Connected* only after its last read succeeded (*Configured — list not read* after a failure); contents storage is only ever *Configured* because the page never reads a body to prove it.
- **KO/EN.** Switching language re-renders text only: folder, selection, rename/folder/upload drafts and pending writes stay. Messages keep the code/status and are worded when drawn, so an error that happened in one language reads fully in the other. The switch rewrites `?lang=` with `history.replaceState` (no new history entry, other query and hash kept), so a reload keeps the language; without a history API the text still switches. Links carry `?lang=`.
- **Mobile.** One column at 390 px, 48 px controls (56 px rows), 16 px inputs, list beside the side cards from 900 px. Fact lists (storage, file details) keep a value column of at least 7rem and let a long label wrap, down to 320 px. Same navy/blue/white tokens as the snapshots page.

## Checks

```
node tools/build-cloudbite-computer-files.mjs --check
node test/cloudbite-computer-files-ui.mjs
npx tsc -p tsconfig.client.json
```

The test runs the generated script in a fake DOM against an in-memory mock of the contract. It proves page behaviour only, not live storage persistence, real browser downloads, phone use or latency.
