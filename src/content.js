/*
 * Zendesk Views Tweaks — content.js
 *
 * Calibrated against the live Zendesk Agent Workspace DOM (2026-05).
 *
 * Stable identifiers:
 *   - Each view anchor:       a[data-test-id="views_views-list_item-view-<id>"]
 *   - Each tree container:    ul[data-test-id^="views_views-tree_container-children_<path>"]
 *     where <path> is the group path joined with `::`, e.g.
 *     "Shared::🙋‍♀️ My tickets". Top-level groups have no `::`.
 *   - Count badge inside row: [data-test-id="views_views-list_item_count"]
 *
 * DOM around a leaf view:
 *   ul[data-test-id^="views_views-tree_container-children_<path>"]
 *     li
 *       div
 *         a[data-test-id="views_views-list_item-view-<id>"]
 *           div     <- main horizontal padding (12px/20px) — see compact.css
 *             ...title text + count badge
 *
 * Hide rules use data-test-id (precise, no false matches) and hide the
 * closest enclosing <li>, with the anchor itself as a depth-fallback.
 *
 * Debug surface: window.__zvt
 */

(() => {
  "use strict";

  const HIDE_STYLE_ID = "zvt-hide-rules";

  const VIEW_TID_PREFIX = "views_views-list_item-view-";
  const TREE_TID_PREFIX = "views_views-tree_container-children_";
  const COUNT_TID = "views_views-list_item_count";

  const VIEW_ID_RE = new RegExp(
    "^" + VIEW_TID_PREFIX.replace(/[-_]/g, "\\$&") + "(\\d+)$"
  );
  // Fallback: parse from URL when test-id is missing.
  const FILTER_RE = /^\/agent\/filters\/(\d+)\/?$/;

  const PRUNE_AGE_MS = 90 * 24 * 60 * 60 * 1000;

  let settings = {
    enabled: true,
    compact: true,
    hiddenViewIds: [],
  };
  let sidebarPane = null;
  let observer = null;
  let pendingRaf = 0;
  // In-memory snapshot for debugging; canonical store is chrome.storage.local.
  const discovered = new Map();

  /* ------------------------- settings + storage ------------------------- */

  function loadSettings() {
    return new Promise((resolve) => {
      chrome.storage.sync.get({ settings: null }, (res) => {
        if (res.settings && typeof res.settings === "object") {
          settings = { ...settings, ...res.settings };
        }
        resolve();
      });
    });
  }

  function applyEnabledState() {
    if (!settings.enabled) {
      document.body && document.body.classList.remove("zvt-compact");
      removeHideStyle();
      return;
    }
    if (settings.compact) {
      document.body && document.body.classList.add("zvt-compact");
    } else {
      document.body && document.body.classList.remove("zvt-compact");
    }
    rebuildHideStyle();
  }

  /* --------------------------- hide stylesheet -------------------------- */

  function ensureHideStyle() {
    let el = document.getElementById(HIDE_STYLE_ID);
    if (!el) {
      el = document.createElement("style");
      el.id = HIDE_STYLE_ID;
      el.setAttribute("data-zvt", "hide-rules");
      (document.head || document.documentElement).appendChild(el);
    }
    return el;
  }

  function removeHideStyle() {
    const el = document.getElementById(HIDE_STYLE_ID);
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  function buildHideRules(ids) {
    const rules = [];
    for (const rawId of ids) {
      if (!/^\d+$/.test(String(rawId))) continue;
      const id = String(rawId);
      const tid = `${VIEW_TID_PREFIX}${id}`;
      // Hide the closest <li> wrapping the anchor, covering depths 1-3
      // (current Zendesk DOM is depth 2 — li > div > a).
      const liSelectors = [
        `li:has(> a[data-test-id="${tid}"])`,
        `li:has(> div > a[data-test-id="${tid}"])`,
        `li:has(> div > div > a[data-test-id="${tid}"])`,
      ];
      const anchorSelector = `a[data-test-id="${tid}"]`;
      rules.push(
        `${liSelectors.join(",\n")} { display: none !important; }`,
        `${anchorSelector} { display: none !important; }`
      );
    }
    return rules.join("\n\n");
  }

  function rebuildHideStyle() {
    if (!settings.enabled) {
      removeHideStyle();
      return;
    }
    const el = ensureHideStyle();
    el.textContent = buildHideRules(settings.hiddenViewIds || []);
  }

  /* --------------------------- view discovery --------------------------- */

  function findTopmostTrees() {
    const all = document.querySelectorAll(
      `ul[data-test-id^="${TREE_TID_PREFIX}"]`
    );
    return Array.from(all).filter((t) => {
      // A top-level tree's parent has no enclosing tree container.
      return !t.parentElement?.closest(
        `ul[data-test-id^="${TREE_TID_PREFIX}"]`
      );
    });
  }

  function findSidebarPane() {
    const tops = findTopmostTrees();
    if (!tops.length) return null;
    // Common ancestor of all top-level trees = the views pane.
    let candidate = tops[0].parentElement;
    while (candidate && candidate !== document.body) {
      if (tops.every((t) => candidate.contains(t))) return candidate;
      candidate = candidate.parentElement;
    }
    return document.body;
  }

  function getViewIdFromAnchor(anchor) {
    const tid = anchor.getAttribute("data-test-id");
    if (tid) {
      const m = tid.match(VIEW_ID_RE);
      if (m) return m[1];
    }
    try {
      const u = new URL(anchor.href, window.location.origin);
      const m = u.pathname.match(FILTER_RE);
      if (m) return m[1];
    } catch {
      /* ignore */
    }
    return null;
  }

  function parseGroupPath(testId) {
    if (!testId.startsWith(TREE_TID_PREFIX)) return null;
    const raw = testId.slice(TREE_TID_PREFIX.length);
    return raw
      .split("::")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  function extractGroupPath(anchor) {
    // Walk up to the first enclosing tree container; its data-test-id
    // already encodes the FULL path (e.g. "Shared::🙋‍♀️ My tickets"),
    // so we only need the deepest one.
    let n = anchor.parentElement;
    while (n && n !== document.body) {
      if (n.tagName === "UL") {
        const tid = n.getAttribute("data-test-id");
        if (tid && tid.startsWith(TREE_TID_PREFIX)) {
          return parseGroupPath(tid) || [];
        }
      }
      n = n.parentElement;
    }
    return [];
  }

  function extractTitle(anchor) {
    const aria = anchor.getAttribute("aria-label");
    if (aria) return aria.trim().replace(/\s+/g, " ");
    // Strip count badge node from a clone before reading text.
    const clone = anchor.cloneNode(true);
    for (const c of clone.querySelectorAll(`[data-test-id="${COUNT_TID}"]`)) {
      c.remove();
    }
    const text = (clone.textContent || "").trim().replace(/\s+/g, " ");
    return text || `View ${getViewIdFromAnchor(anchor) || ""}`.trim();
  }

  function discoverNow() {
    const pane = sidebarPane || findSidebarPane();
    if (!pane) return;
    if (pane !== sidebarPane) {
      sidebarPane = pane;
      attachObserver();
    }

    const anchors = pane.querySelectorAll(
      `a[data-test-id^="${VIEW_TID_PREFIX}"], a[href*="/agent/filters/"]`
    );

    let changed = false;
    const now = Date.now();
    for (const a of anchors) {
      const id = getViewIdFromAnchor(a);
      if (!id) continue;
      const title = extractTitle(a);
      const groupPath = extractGroupPath(a);
      const href = (() => {
        try {
          return new URL(a.href, window.location.origin).pathname;
        } catch {
          return `/agent/filters/${id}`;
        }
      })();
      const prev = discovered.get(id);
      if (
        !prev ||
        prev.title !== title ||
        prev.href !== href ||
        JSON.stringify(prev.groupPath) !== JSON.stringify(groupPath)
      ) {
        changed = true;
      }
      discovered.set(id, { id, title, href, groupPath, lastSeenAt: now });
    }

    if (changed || (anchors.length > 0 && discovered.size > 0)) {
      persistDiscovered();
    }
  }

  function persistDiscovered() {
    chrome.storage.local.get({ discoveredViews: [] }, (res) => {
      const existing = Array.isArray(res.discoveredViews)
        ? res.discoveredViews
        : [];
      const byId = new Map();
      const cutoff = Date.now() - PRUNE_AGE_MS;
      for (const v of existing) {
        if (!v || !v.id) continue;
        if (typeof v.lastSeenAt === "number" && v.lastSeenAt < cutoff) continue;
        byId.set(String(v.id), v);
      }
      for (const v of discovered.values()) {
        byId.set(v.id, v);
      }
      const merged = Array.from(byId.values()).sort((a, b) => {
        const ap = (a.groupPath || []).join("::");
        const bp = (b.groupPath || []).join("::");
        if (ap !== bp) return ap.localeCompare(bp);
        return (a.title || "").localeCompare(b.title || "");
      });
      if (JSON.stringify(merged) !== JSON.stringify(existing)) {
        chrome.storage.local.set({ discoveredViews: merged });
      }
    });
  }

  /* --------------------------- mutation observer ------------------------ */

  function attachObserver() {
    if (observer) {
      observer.disconnect();
      observer = null;
    }
    if (!sidebarPane) return;
    observer = new MutationObserver(() => scheduleDiscover());
    observer.observe(sidebarPane, { childList: true, subtree: true });
  }

  function scheduleDiscover() {
    if (pendingRaf) return;
    pendingRaf = requestAnimationFrame(() => {
      pendingRaf = 0;
      if (sidebarPane && !document.contains(sidebarPane)) {
        sidebarPane = null;
      }
      discoverNow();
    });
  }

  /* --------------------- mount + late-arrival retries ------------------- */

  function tryMountSidebar(retriesLeft) {
    sidebarPane = findSidebarPane();
    if (sidebarPane) {
      attachObserver();
      discoverNow();
      return;
    }
    if (retriesLeft <= 0) return;
    setTimeout(() => tryMountSidebar(retriesLeft - 1), 1000);
  }

  // Periodic safety net for SPA re-mounts after the initial retry window.
  setInterval(() => {
    if (!sidebarPane || !document.contains(sidebarPane)) {
      const next = findSidebarPane();
      if (next) {
        sidebarPane = next;
        attachObserver();
        discoverNow();
      }
    }
  }, 3000);

  /* --------------------------- message handling ------------------------- */

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "zvt:rescan") {
      sidebarPane = findSidebarPane();
      attachObserver();
      discoverNow();
      sendResponse({
        ok: true,
        paneFound: !!sidebarPane,
        viewCount: discovered.size,
      });
    }
    return false;
  });

  /* --------------------------- storage updates -------------------------- */

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes.settings) {
      const next = changes.settings.newValue || {};
      settings = { ...settings, ...next };
      applyEnabledState();
    }
  });

  /* ------------------------------- boot --------------------------------- */

  loadSettings().then(() => {
    applyEnabledState();
    tryMountSidebar(15);
  });

  // Debug surface.
  Object.defineProperty(window, "__zvt", {
    configurable: true,
    value: {
      get pane() {
        return sidebarPane;
      },
      get discovered() {
        return Array.from(discovered.values());
      },
      get settings() {
        return { ...settings };
      },
      prefixes: { VIEW_TID_PREFIX, TREE_TID_PREFIX, COUNT_TID },
      rescan() {
        sidebarPane = findSidebarPane();
        attachObserver();
        discoverNow();
        return { paneFound: !!sidebarPane, count: discovered.size };
      },
    },
  });
})();
