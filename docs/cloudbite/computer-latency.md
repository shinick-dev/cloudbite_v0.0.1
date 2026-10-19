# Personal computer latency check

A standalone mobile page at `/cloudbite/computer/latency` (`?lang=ko|en`) measures latency on explicit button presses only. It uses the existing computer/owner cookie; a 401 shows a link to sign in on `/cloudbite/computer`. Nothing is requested on load, on typing, on a timer or when the tab becomes visible again. Hiding the tab or signing out aborts what is in flight and drops late answers.

## Measurements

| On the page | Measured where | What it includes |
|---|---|---|
| This device → Cloudbite | browser, `performance.now()` | 5 sequential `GET latency/ping` (no-store), each request start → parsed body. Shows count, p50, p95 (nearest rank) and each sample. Failed requests are counted, never timed. |
| This request, browser round trip | browser | the single `GET latency/backend` request, including the server's own provider calls when not cached |
| Provider control API round trip | Worker | one Daytona `GET /sandbox/{id}` for the owner's machine |
| Remote command round trip | Worker | one fixed read-only `echo cloudbite-latency` through the Daytona toolbox; includes provider queueing and execution, so it is not a pure network RTT |
| Typing preview | browser only | input event → next animation frame; no request at all |

Browser and server values are on different clocks and are never added, subtracted or combined; `serverTime` from ping is informational. No distance, location or benchmark is derived from a round trip.

The typing preview measures input-event to the next local animation-frame callback, which runs before paint. It does not measure actual display latency or the full remote desktop response. That needs a separate input-to-frame video loop, which is not implemented.

## API (root-routed after owner authentication)

- `GET /api/cloudbite/computer/latency/ping` → `latencyPing()` → `{ok:true, schema:'cloudbite.computer.latency.ping.v1', serverTime}`. No provider call.
- `GET /api/cloudbite/computer/latency/backend` → `latencyBackend(env, computer, tag)` → `{ok:true, schema:'cloudbite.computer.latency.backend.v1', measuredAt, cached, cacheAgeMs, cacheTtlMs, machine:{status, providerState, account}, apiControl:{kind, at, ms, reason}, remoteExec:{kind, at, ms, reason, includes}}`.

The backend target is never named by the caller (query and body are ignored). The server-derived owner tag selects the DO machine record; the configured account supplies the key; the provider GET must return the same id, name and every owner label before a timing is shown or any exec runs. The exec runs only when the DO record is `running` and the provider reports `started`. Nothing is started, resumed or changed.

A value that was not measured is `ms:null` with a `reason`: `absent`, `not_configured`, `ownership_mismatch`, `stopped`, `not_running`, `error`, `timeout`, `provider_error`, `exec_failed`, `skipped_after_control_failure`. It is never reported as 0. Provider messages, URLs and keys never reach the answer.

Timeouts are 8 s for the control call and 12 s for the exec (5 s command timeout). Results are cached per owner for 30 s and concurrent requests share one measurement, so the backend costs at most one provider GET and one tiny exec per 30 s.

## Files

`src/cloudbite-computer-latency.ts` (API), `client/cloudbite-computer-latency.ts` and `.css` (page sources), `src/cloudbite-computer-latency-page.ts` (generated: `node tools/build-cloudbite-computer-latency.mjs`, `--check` verifies), `test/cloudbite-computer-latency.mjs`. The page is served like `/cloudbite/computer/jobs`: GET only, CSP `script-src 'self'; style-src 'self'`, no inline code, storage or absolute URLs.
