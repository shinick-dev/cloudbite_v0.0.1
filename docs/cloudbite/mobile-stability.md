# Mobile connection recovery (2026-10-19)

The computer landing page offers **Check connection again / 접속 다시 확인** beside passkey sign-in. It reads the cookie session; it does not invoke a passkey prompt, consume a pairing link again, or start a machine.

When the browser reports offline, the page stops polling and invalidates its desktop ticket and machine-state freshness. On a visible tab's network recovery, it reads the machine state if signed in, or checks the session otherwise. Returning to the visible tab does the same. Draft snapshot names and uncertain request IDs remain in memory. Mutations are never automatically replayed. A failed state refresh blocks opening the desktop and starting new machine actions until a successful read; explicit retries retain their original IDs.

Read-only requests time out after 30 seconds, including body reads, so a stalled session check can be retried. This timeout is not applied to mutation requests. Late state, desktop-ticket, session and nested-job replies from an invalidated authentication generation cannot redraw private state after logout. This does not change the separate desktop gateway's transport or reconnect implementation.

Costs-page return/sign-in links preserve KO/EN; unknown numeric resources and quotas are spelled out rather than shown as `?`. Snapshot history no longer keeps a stale Ready/selectable state after a provider reports a non-active state. Such entries become unconfirmed and are checked again within the existing bounded one-minute refresh policy. No provider mutation is added.

## Validation and remaining acceptance

- Fake-DOM regression cases cover session retry, offline/online recovery without mutation replay, draft preservation, stale-state blocking, late replies after logout and GET timeout.
- Snapshot service tests cover inactive → unconfirmed/non-selectable → active, with refresh backoff and no provider mutation.
- Browser preview uses mock JSON and no credentials or real VM; 390px/1440px KO/EN checks cannot prove physical phone keyboard, passkey or remote-desktop transport behavior.
- Real phone acceptance remains: sign in using the registered phone passkey; reconnect after switching Wi-Fi/mobile data; type/paste Korean in the desktop's local input panel and actual terminal; verify each CLI sign-in separately. Do not treat an installed CLI or a successful Gmail sign-in as successful provider authentication.
- Original user machine and app login profiles must be preserved. No new machine, restart, snapshot capture or paid GPU job is required for the landing-page fix.

WorkBite T-0083 remains in progress until physical-phone and per-CLI authentication acceptance is recorded. Actual terminal/input performance and five-second end-to-end measurements belong to T-0084.
