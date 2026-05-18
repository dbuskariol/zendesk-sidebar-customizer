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

  // Wrap fetch once. Calling fetch is a 1-or-2-arg function; we always
  // call through to the original with the exact args we received so we
  // never change the call signature.
  const origFetch = window.fetch.bind(window);

  window.fetch = function(input, init) {
    if (!state.enabled || !state.viewId) return origFetch(input, init);
    const url = typeof input === "string" ? input : (input?.url || "");
    const m = url.match(/\/api\/v2\/views\/(\d+)\/execute(?:\.json)?(?:\?|$)/);
    if (!m || m[1] !== state.viewId) return origFetch(input, init);

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
    emit("intercepted", {
      url, ok: true, json: true,
      rows: pageSize, total: state.rows.length, added,
    });

    // First page only — return unmodified so React's initial render is
    // exactly what Zendesk expects.
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
      count: state.rows.length,
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
        if (p.viewId !== undefined && p.viewId !== state.viewId) {
          resetState(p.viewId);
        }
        emit("ready", { enabled: state.enabled, viewId: state.viewId });
        return;
      }
      case "reset":
        resetState((detail.payload || {}).viewId || state.viewId);
        emit("ready", { enabled: state.enabled, viewId: state.viewId, reset: true });
        return;
    }
  });

  emit("ready", { enabled: false });
})();
