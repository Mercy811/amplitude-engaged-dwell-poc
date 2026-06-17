// Static (GitHub Pages) build of the engaged-dwell POC.
//
// On the local test server the "delayed events service" is a Node backend. GitHub Pages is
// static-only, so here that service runs IN THE BROWSER and is SHARED across the two demo
// pages via localStorage (same origin). A timer plays the role of the server-side reaper
// that flushes rows when their timeout lapses.
//
// Heartbeats still fire a REAL network request (GET /httpapi/delayed.json?...), so you can
// observe the 1s cadence in DevTools -> Network exactly like the real thing — but the
// authoritative state lives in localStorage, not in those responses.

const HEARTBEAT_MS = 1000;
const TIMEOUT_MS = 10_000;
const REAPER_MS = 250;
const KEY = { delayed: 'dwell.delayed', pool: 'dwell.pool', seq: 'dwell.seq' };

const PAGE = window.DWELL_PAGE || { name: location.pathname, path: location.pathname };
const pageViewId = `${PAGE.name}-${Math.random().toString(36).slice(2, 8)}`;

// ---------- shared store (localStorage, shared across both pages) ----------
const read = (k, d) => {
  try {
    const v = JSON.parse(localStorage.getItem(k));
    return v == null ? d : v;
  } catch {
    return d;
  }
};
const write = (k, v) => localStorage.setItem(k, JSON.stringify(v));

function ingest(source, events, request) {
  const pool = read(KEY.pool, []);
  let seq = read(KEY.seq, 0);
  for (const event of events || []) {
    pool.push({
      seq: ++seq,
      source,
      eventType: event.event_type,
      props: event.event_properties || {},
      receivedAt: Date.now(),
      event,
      request,
    });
  }
  write(KEY.pool, pool);
  write(KEY.seq, seq);
}

// Flush delayed rows whose timeout has lapsed. The owning page stops heartbeating when the
// user leaves it, so by the time a row expires only the *other* page is running this reaper.
function reap() {
  const delayed = read(KEY.delayed, {});
  const now = Date.now();
  let changed = false;
  for (const id of Object.keys(delayed)) {
    if (now >= delayed[id].expiresAt) {
      ingest('delayed-expired', delayed[id].events, delayed[id].request);
      delete delayed[id];
      changed = true;
    }
  }
  if (changed) write(KEY.delayed, delayed);
}

function snapshot() {
  const now = Date.now();
  const delayed = read(KEY.delayed, {});
  return {
    timeoutMs: TIMEOUT_MS,
    delayed: Object.values(delayed).map((r) => ({
      id: r.id,
      remainingMs: Math.max(0, r.expiresAt - now),
      timeoutMs: TIMEOUT_MS,
      heartbeats: r.heartbeats,
      events: r.events,
      request: r.request,
    })),
    ingested: read(KEY.pool, []).slice(-100).reverse(),
  };
}

// ---------- engaged-dwell accumulation (counts only while the tab is visible) ----------
let engagedMs = 0;
let lastResume = document.visibilityState === 'visible' ? Date.now() : null;

function accumulate() {
  if (lastResume != null) {
    const now = Date.now();
    engagedMs += now - lastResume;
    lastResume = now;
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    lastResume = Date.now();
  } else {
    accumulate();
    lastResume = null;
  }
});

// ---------- event builders ----------
function pageViewedEvent() {
  return {
    event_type: '[Amplitude] Page Viewed',
    event_properties: { '[Amplitude] Page Path': PAGE.path, '[Amplitude] Page Title': PAGE.name },
  };
}
function pageViewedCompletedEvent() {
  return {
    event_type: '[Amplitude] Page Viewed Completed',
    event_properties: {
      '[Amplitude] Page Path': PAGE.path,
      '[Amplitude] Page Title': PAGE.name,
      '[Amplitude] Engaged Dwell Time (ms)': engagedMs,
    },
  };
}

// Real network request so the heartbeat cadence is observable in DevTools -> Network.
function ping(path, params) {
  const qs = new URLSearchParams({ ...params, _: Date.now() }).toString();
  fetch(`${path}?${qs}`, { cache: 'no-store' }).catch(() => {});
}

let heartbeats = 0;
function heartbeat() {
  accumulate();
  heartbeats += 1;
  const body = {
    id: pageViewId,
    delayedPayload: {
      instant_events: heartbeats === 1 ? [pageViewedEvent()] : [],
      events: [pageViewedCompletedEvent()],
    },
  };

  // delayed events service (in-browser): instant_events ingest now; the delayed event
  // replaces the whole row keyed by id and refreshes the timeout.
  ingest('instant', body.delayedPayload.instant_events, body);
  const delayed = read(KEY.delayed, {});
  const existing = delayed[pageViewId];
  delayed[pageViewId] = {
    id: pageViewId,
    events: body.delayedPayload.events,
    request: body,
    expiresAt: Date.now() + TIMEOUT_MS,
    heartbeats: (existing?.heartbeats || 0) + 1,
  };
  write(KEY.delayed, delayed);

  ping('httpapi/delayed.json', { id: pageViewId, hb: heartbeats, dwell: engagedMs });
  renderLocal();
  render();
}

function trackViaHttpApi(eventType) {
  const body = { events: [{ event_type: eventType, event_properties: { via: 'http-api' } }] };
  ingest('http-api', body.events, body);
  ping('httpapi.json', { event: eventType });
  render();
}

// ---------------- dashboard ----------------
const fmt = (ms) => (ms / 1000).toFixed(1) + 's';

function renderLocal() {
  const el = document.getElementById('dwell-local');
  if (el) {
    el.textContent = `pageViewId=${pageViewId}  ·  engaged dwell=${fmt(engagedMs)}  ·  heartbeats sent=${heartbeats}`;
  }
}

function eventsSummary(events) {
  return events
    .map((e) => {
      const d = e.event_properties?.['[Amplitude] Engaged Dwell Time (ms)'];
      return d == null ? e.event_type : `${e.event_type} (dwell ${fmt(d)})`;
    })
    .join(', ');
}

let lastState = { delayed: [], ingested: [] };
let selected = null; // { kind: 'ingested' | 'delayed', key }

const isSelected = (kind, key) =>
  selected && selected.kind === kind && String(selected.key) === String(key);

function render() {
  renderState(snapshot());
}

function renderState(state) {
  lastState = state;

  const delayedRows = state.delayed
    .map(
      (r) => `<tr class="clickable ${isSelected('delayed', r.id) ? 'sel' : ''}" data-kind="delayed" data-key="${r.id}">
        <td>${r.id}</td>
        <td>${fmt(r.remainingMs)} <span class="muted">/ ${fmt(r.timeoutMs)} · ${r.heartbeats} hb</span></td>
        <td>${eventsSummary(r.events)}</td>
      </tr>`,
    )
    .join('');
  const delayedBody = document.querySelector('#dwell-delayed tbody');
  if (delayedBody) {
    delayedBody.innerHTML =
      delayedRows || '<tr><td colspan="3" class="muted">(empty — no page currently heartbeating)</td></tr>';
  }

  const badge = { 'http-api': '#2563eb', instant: '#16a34a', 'delayed-expired': '#d97706' };
  const ingestRows = state.ingested
    .map((e) => {
      const d = e.props?.['[Amplitude] Engaged Dwell Time (ms)'];
      return `<tr class="clickable ${isSelected('ingested', e.seq) ? 'sel' : ''}" data-kind="ingested" data-key="${e.seq}">
        <td>${e.seq}</td>
        <td><span class="tag" style="background:${badge[e.source] || '#666'}">${e.source}</span></td>
        <td>${e.eventType}${d == null ? '' : ` <span class="muted">(dwell ${fmt(d)})</span>`}</td>
      </tr>`;
    })
    .join('');
  const ingestBody = document.querySelector('#dwell-ingested tbody');
  if (ingestBody) {
    ingestBody.innerHTML = ingestRows || '<tr><td colspan="3" class="muted">(empty)</td></tr>';
  }

  renderRaw();
}

function renderRaw() {
  const pre = document.getElementById('dwell-raw');
  if (!pre || !selected) return;
  let item, request;
  if (selected.kind === 'ingested') {
    item = lastState.ingested.find((e) => String(e.seq) === String(selected.key));
    request = item?.request;
  } else {
    item = lastState.delayed.find((r) => String(r.id) === String(selected.key));
    request = item?.request;
  }
  if (!item) {
    pre.textContent = '(event no longer present — it may have flushed; click its row in the ingested pool)';
    return;
  }
  const label =
    selected.kind === 'ingested'
      ? `POST ${item.source === 'http-api' ? '/httpapi' : '/httpapi/delayed'}  (event #${item.seq}, source: ${item.source})`
      : `POST /httpapi/delayed  (delayed row id: ${item.id} — latest heartbeat)`;
  pre.textContent = `${label}\n\n${JSON.stringify(request, null, 2)}`;
}

function onRowClick(e) {
  const tr = e.target.closest('tr[data-key]');
  if (!tr) return;
  selected = { kind: tr.dataset.kind, key: tr.dataset.key };
  render();
}

// ---------------- wire up ----------------
document.getElementById('dwell-ingested')?.addEventListener('click', onRowClick);
document.getElementById('dwell-delayed')?.addEventListener('click', onRowClick);
document.getElementById('dwell-http-btn')?.addEventListener('click', () =>
  trackViaHttpApi('[Demo] Button Clicked'),
);
document.getElementById('dwell-reset-btn')?.addEventListener('click', () => {
  selected = null;
  write(KEY.delayed, {});
  write(KEY.pool, []);
  write(KEY.seq, 0);
  render();
});

heartbeat(); // first heartbeat: page view (instant) + dwell snapshot (delayed)
setInterval(heartbeat, HEARTBEAT_MS);
setInterval(() => {
  reap();
  render();
}, REAPER_MS);
renderLocal();
render();
