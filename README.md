# Engaged Dwell POC (delayed-events / heartbeat)

A standalone, static demo of the **delayed-events endpoint (heartbeat service)** approach to
tracking **engaged dwell time** per page view — exploration for Amplitude Browser SDK
autocapture (SDKW-21).

> **Exploration only — not shippable.** This is the earlier Solution 2 prototype. It measures visible dwell rather than interaction-based engaged time and emits a separate `[Amplitude] Page Viewed Completed` event. Those semantics are not the proposed Solution 3 architecture.

**Live demo:** see the repo's GitHub Pages URL (Settings → Pages).

## What it shows

- `[Amplitude] Page Viewed` is sent as a heartbeat **`instant_event`** → ingested immediately.
- `[Amplitude] Page Viewed Completed` (carrying running engaged-dwell time) is sent as a
  **delayed `event`** on every 1s heartbeat → held in the delayed service, timeout (10s)
  refreshed each beat, and ingested **only when the timeout lapses** (the user left).
- This captures the **final page view's** dwell time with no successor page view — the open
  problem with the next-page-view-piggyback design.

Open DevTools → Network and filter by `delayed` to watch the 1s heartbeats. Navigate
Page 1 → Page 2 and watch Page 1's delayed row count down and flush into the ingested pool.

## How this hosted build works

The real architecture has a backend delayed-events service. GitHub Pages is static, so here
that service is **simulated in the browser** and shared across the two pages via
`localStorage`; a timer plays the role of the server-side timeout reaper. The heartbeat
**network requests are real** so the cadence is observable, but the authoritative state lives
in `localStorage`. (The Node-backed version lives in the SDK repo under
`test-server/engaged-dwell-poc/`.)

## Files

- `index.html` / `page2.html` — the two demo pages.
- `app.js` — dwell tracking, heartbeat, the in-browser delayed service, and the dashboard.
- `httpapi/delayed.json`, `httpapi.json` — static targets so heartbeats are real, observable
  requests.
