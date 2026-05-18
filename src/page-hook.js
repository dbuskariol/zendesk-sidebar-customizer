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
    viewId: null,
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

  function resetState(viewId) {
    state.viewId = viewId || null;
    state.rows = [];
    state.knownIds = new Set();
    state.aux.users.clear();
    state.aux.organizations.clear();
    state.aux.groups.clear();
    state.columns = null;
    state.view = null;
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

    // Switched views? Reset state to the new view so we don't carry
    // rows from view A into view B.
    if (state.viewId && state.viewId !== urlViewId) {
      resetState(urlViewId);
    } else if (!state.viewId) {
      state.viewId = urlViewId;
    }

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
      return mergeResponse(data, response, url);
    });
  };

  function mergeResponse(data, originalResponse, url) {
    let added = 0;
    if (Array.isArray(data?.rows)) {
      for (const row of data.rows) {
        const id = rowTicketId(row);
        if (id == null) continue;
        if (state.knownIds.has(id)) continue;
        state.knownIds.add(id);
        state.rows.push(row);
        added++;
      }
    }
    for (const cat of ["users", "organizations", "groups"]) {
      if (!Array.isArray(data?.[cat])) continue;
      const map = state.aux[cat];
      for (const item of data[cat]) {
        if (item?.id != null) map.set(item.id, item);
      }
    }
    if (Array.isArray(data?.columns)) state.columns = data.columns;
    if (data?.view) state.view = data.view;

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
      rows: pageSize, total: state.rows.length, added,
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
    if (state.rows.length <= pageSize) {
      return originalResponse;
    }

    const merged = {
      ...data,
      rows: state.rows.slice(),
      users:          Array.from(state.aux.users.values()),
      organizations:  Array.from(state.aux.organizations.values()),
      groups:         Array.from(state.aux.groups.values()),
      columns: state.columns || data.columns,
      view:    state.view    || data.view,
      // IMPORTANT: do NOT override `count`. In Zendesk's response,
      // `count` is the TOTAL number of tickets in the view (e.g. 68),
      // not the number returned in this response. If we set it to our
      // accumulator size (e.g. 60), Zendesk thinks the view has only
      // 60 tickets and disables further pagination — even though
      // `meta.has_more` is still true. We pass `count` through
      // unmodified so Zendesk's React knows there are more pages to
      // fetch.
      count: data.count != null ? data.count : state.rows.length,
      meta:  data.meta  || {},
      links: data.links || {},
    };
    emit("merged", { added, total: state.rows.length });

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
      case "reset":
        // Reset is still useful — tickets.js can force a clean slate
        // (e.g. after detecting a manual reload by the user).
        resetState((detail.payload || {}).viewId || state.viewId);
        emit("ready", { enabled: state.enabled, viewId: state.viewId, reset: true });
        return;
    }
  });

  emit("ready", { enabled: false });
})();
