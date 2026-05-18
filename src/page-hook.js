/*
 * Zendesk Sidebar Customizer — page-hook.js  (v0.10.0)
 *
 * Runs in the page's MAIN world at document_start (configured in
 * manifest.json), BEFORE Zendesk's React app captures a reference to
 * window.fetch. This is the only way to reliably intercept fetch
 * calls made by Zendesk — content scripts in the default isolated
 * world have their own window.fetch and Zendesk would never see our
 * wrapper.
 *
 * Communication with the rest of the extension (the isolated-world
 * content script) is via CustomEvent on window:
 *   Inbound  (isolated → main):  "zvt-page-hook:command"
 *     { command: "configure", payload: { enabled, viewId } }
 *     { command: "reset",     payload: { viewId } }
 *
 *   Outbound (main → isolated):  "zvt-page-hook:event"
 *     { event: "ready" }
 *     { event: "merged",      payload: { added, total } }
 *     { event: "intercepted", payload: { url, ok, json, rows, ... } }
 *     { event: "log",         payload: { message, level } }
 *
 * The hook accumulates rows[] across pages keyed by row.ticket_id and
 * synthesizes a merged Response that contains all accumulated rows
 * for every fetch after the first. React's row keying on ticket_id
 * lets the reconciler keep existing rows mounted while adding new
 * ones at the bottom — fully interactive infinite scroll.
 */

(() => {
  "use strict";
  if (window.__ZVT_PAGE_HOOK_INSTALLED__) return;
  window.__ZVT_PAGE_HOOK_INSTALLED__ = true;

  const state = {
    // `enabled` controls whether we RETURN a merged response. Even
    // when disabled we still TRACK rows from every fetch — this is
    // critical because Zendesk's initial page-load fetch fires before
    // tickets.js (content_idle) gets a chance to enable us. If we
    // didn't track it, we'd never have page 1's rows in our state and
    // every merged response would drop them.
    enabled: false,
    // Most recently observed viewId from the URL. Used only for
    // diagnostic / ready-event payloads — accumulation is per-view.
    viewId: null,
    // Per-view accumulators. Map<viewId, ViewState>. Keeping per-view
    // state lets the user navigate away from view A and back without
    // losing accumulated rows — Zendesk's React resumes from whichever
    // page the user last visited, so a "return to view" fetch might
    // be page 3 cursor returning just 8 rows. If our state were
    // reset on every view switch, those 8 would replace the visible
    // 68. Per-view state means we still have view A's 68 rows when
    // we come back, so the merged response includes all of them.
    views: new Map(),
  };

  // Soft cap on the number of view states we retain to bound memory.
  // LRU eviction (Map preserves insertion order; touch on access).
  const MAX_RETAINED_VIEWS = 25;

  function emit(event, payload) {
    try {
      window.dispatchEvent(new CustomEvent("zvt-page-hook:event", {
        detail: { event, payload: payload || {} },
      }));
    } catch (e) { /* ignore */ }
  }

  function rowTicketId(row) {
    if (row?.ticket_id != null) return row.ticket_id;
    if (row?.ticket?.id != null) return row.ticket.id;
    return null;
  }

  function makeViewState(viewId) {
    return {
      viewId,
      rows: [],
      knownIds: new Set(),
      aux: {
        users: new Map(),
        organizations: new Map(),
        groups: new Map(),
      },
      columns: null,
      view: null,
    };
  }

  function getOrCreateViewState(viewId) {
    let s = state.views.get(viewId);
    if (!s) {
      s = makeViewState(viewId);
      state.views.set(viewId, s);
      // LRU bound. Evict the oldest entry once we exceed the cap.
      while (state.views.size > MAX_RETAINED_VIEWS) {
        const oldest = state.views.keys().next().value;
        state.views.delete(oldest);
      }
    } else {
      // Touch: move to most-recent position in insertion order so the
      // LRU eviction targets genuinely-stale views.
      state.views.delete(viewId);
      state.views.set(viewId, s);
    }
    return s;
  }

  function resetViewState(viewId) {
    if (!viewId) return;
    state.views.set(viewId, makeViewState(viewId));
  }

  function resetAllState() {
    state.views.clear();
    state.viewId = null;
  }

  function extractViewIdFromUrl(url) {
    const m = url.match(/\/api\/v2\/views\/(\d+)\/execute(?:\.json)?(?:\?|$)/);
    return m ? m[1] : null;
  }

  // Wrap fetch once. Calling fetch is a 1-or-2-arg function; we always
  // call through to the original with the exact args we received so we
  // never change the call signature.
  //
  // We ALWAYS pass execute.json requests through the tracker — not just
  // when `state.enabled` is true. The tracker accumulates rows into
  // `state.rows`. Merging behaviour (returning a synthesised response)
  // is gated by `state.enabled`. This split is the bug fix for missing
  // page-1: Zendesk's initial fetch happens before our isolated-world
  // sibling has had a chance to enable us, so if we don't track it,
  // page 1's rows never make it into state.
  const origFetch = window.fetch.bind(window);

  window.fetch = function(input, init) {
    const url = typeof input === "string" ? input : (input?.url || "");
    const urlViewId = extractViewIdFromUrl(url);
    if (!urlViewId) return origFetch(input, init);

    state.viewId = urlViewId;

    return origFetch(input, init).then(async (response) => {
      if (!response.ok) {
        emit("intercepted", { url, ok: false, status: response.status });
        return response;
      }
      const ct = response.headers.get("content-type") || "";
      if (!ct.includes("application/json")) {
        emit("intercepted", { url, ok: true, json: false });
        return response;
      }
      let data;
      try {
        data = await response.clone().json();
      } catch (e) {
        emit("intercepted", { url, ok: true, json: false, parseError: String(e) });
        return response;
      }
      return mergeResponse(data, response, url, urlViewId);
    });
  };

  function mergeResponse(data, originalResponse, url, urlViewId) {
    const viewState = getOrCreateViewState(urlViewId);
    let added = 0;
    if (Array.isArray(data?.rows)) {
      for (const row of data.rows) {
        const id = rowTicketId(row);
        if (id == null) continue;
        if (viewState.knownIds.has(id)) continue;
        viewState.knownIds.add(id);
        viewState.rows.push(row);
        added++;
      }
    }
    for (const cat of ["users", "organizations", "groups"]) {
      if (!Array.isArray(data?.[cat])) continue;
      const map = viewState.aux[cat];
      for (const item of data[cat]) {
        if (item?.id != null) map.set(item.id, item);
      }
    }
    if (Array.isArray(data?.columns)) viewState.columns = data.columns;
    if (data?.view) viewState.view = data.view;

    const pageSize = data?.rows?.length || 0;
    // Extract the page[after] cursor from the REQUEST URL so we can
    // see what Zendesk asked for vs what came back. Helps diagnose
    // pagination skips. We log the FULL cursor + full links.next so
    // we can verify Zendesk's React is sending the cursor we expect.
    let requestedCursor = null;
    try {
      const u = new URL(url, window.location.origin);
      requestedCursor = u.searchParams.get("page[after]");
    } catch (e) { /* ignore */ }
    emit("intercepted", {
      url, ok: true, json: true,
      rows: pageSize, total: viewState.rows.length, added,
      viewId: urlViewId,
      requestedCursor,
      responseHasMore: !!data?.meta?.has_more,
      responseAfterCursor: data?.meta?.after_cursor || null,
      responseBeforeCursor: data?.meta?.before_cursor || null,
      responseLastCursor: data?.meta?.last_cursor || null,
      responseLinksNext: data?.links?.next || null,
      responseLinksLast: data?.links?.last || null,
      responseCount: data?.count ?? null,
      viewGroupBy: data?.view?.execution?.group_by || data?.view?.group_by || null,
    });

    // First page only — return unmodified so React's initial render is
    // exactly what Zendesk expects.
    //
    // Also return unmodified when state.enabled is false: we still
    // tracked the rows above (so they're in state when merging later
    // gets enabled), but we don't synthesise a merged response yet.
    // This keeps Zendesk's normal pagination behaviour when the user
    // hasn't opted in to infinite scroll.
    if (!state.enabled) return originalResponse;
    if (viewState.rows.length <= pageSize) {
      return originalResponse;
    }

    const merged = {
      ...data,
      rows: viewState.rows.slice(),
      users:          Array.from(viewState.aux.users.values()),
      organizations:  Array.from(viewState.aux.organizations.values()),
      groups:         Array.from(viewState.aux.groups.values()),
      columns: viewState.columns || data.columns,
      view:    viewState.view    || data.view,
      // IMPORTANT: do NOT override `count`. In Zendesk's response,
      // `count` is the TOTAL number of tickets in the view (e.g. 68),
      // not the number returned in this response. If we set it to our
      // accumulator size (e.g. 60), Zendesk thinks the view has only
      // 60 tickets and disables further pagination — even though
      // `meta.has_more` is still true. We pass `count` through
      // unmodified so Zendesk's React knows there are more pages to
      // fetch.
      count: data.count != null ? data.count : viewState.rows.length,
      meta:  data.meta  || {},
      links: data.links || {},
    };
    emit("merged", { added, total: viewState.rows.length, viewId: urlViewId });

    return new Response(JSON.stringify(merged), {
      status: originalResponse.status,
      statusText: originalResponse.statusText,
      headers: originalResponse.headers,
    });
  }

  window.addEventListener("zvt-page-hook:command", (e) => {
    const detail = e.detail || {};
    switch (detail.command) {
      case "configure": {
        const p = detail.payload || {};
        state.enabled = !!p.enabled;
        // We no longer reset state when configure passes a viewId —
        // the page-hook tracks every view from document_start and
        // auto-resets when it detects a viewId change in the URL. If
        // tickets.js passes a viewId here, we just ignore it. (The
        // viewId field is retained in the protocol for back-compat
        // and human-readability of the ready event.)
        emit("ready", { enabled: state.enabled, viewId: state.viewId });
        return;
      }
      case "reset": {
        // Reset is still useful — tickets.js can force a clean slate
        // (e.g. after detecting a manual reload by the user, or to
        // re-pull stale data for a specific view).
        const p = detail.payload || {};
        if (p.viewId) {
          resetViewState(p.viewId);
        } else if (p.allViews) {
          resetAllState();
        } else if (state.viewId) {
          resetViewState(state.viewId);
        }
        emit("ready", { enabled: state.enabled, viewId: state.viewId, reset: true });
        return;
      }
    }
  });

  emit("ready", { enabled: false });
})();
