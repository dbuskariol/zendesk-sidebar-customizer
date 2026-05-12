/*
 * Zendesk Views Tweaks — content.js  (v0.3.0)
 *
 * Calibrated against live github.zendesk.com (2026-05) — see plan.md.
 *
 * Stable identifiers:
 *   Outer container:   ul[data-test-id="views_views-tree_container"]
 *   Group header:      a[data-test-id="views_views-list_item-folder-<path>"]   role=button
 *   Leaf view:         a[data-test-id="views_views-list_item-view-<id>"]
 *   Children container ul[data-test-id^="views_views-tree_container-children_<path>"]
 *   Count badge:       [data-test-id="views_views-list_item_count"]
 *
 * Depth semantics (visual depth in the rendered tree):
 *   - Folder anchor depth      = path segments       ("Shared" → 1; "Shared::My tickets" → 2)
 *   - Children-container depth = pathSegments + 1    (= depth of items inside it)
 *   - Leaf view depth          = enclosing children container's depth
 *
 * Each anchor and children-ul is annotated with `data-zvt-d="<depth>"`
 * during discovery. CSS rules then target `[data-zvt-d="N"]` for per-level styling.
 *
 * Two extension-owned <style> elements live in <head>:
 *   #zvt-hide-rules    — generated from hiddenViewIds + hiddenGroupPaths
 *   #zvt-density-rules — generated from levelFontSizes + levelIndents
 */

(() => {
  "use strict";

  const HIDE_STYLE_ID = "zvt-hide-rules";
  const DENSITY_STYLE_ID = "zvt-density-rules";

  const VIEW_TID_PREFIX = "views_views-list_item-view-";
  const FOLDER_TID_PREFIX = "views_views-list_item-folder-";
  const TREE_OUTER_TID = "views_views-tree_container";
  const TREE_CHILD_PREFIX = "views_views-tree_container-children_";
  const COUNT_TID = "views_views-list_item_count";

  const VIEW_ID_RE = new RegExp(
    "^" + VIEW_TID_PREFIX.replace(/[-_]/g, "\\$&") + "(\\d+)$"
  );
  const FILTER_RE = /^\/agent\/filters\/(\d+)\/?$/;
  const PRUNE_AGE_MS = 90 * 24 * 60 * 60 * 1000;

  const DEFAULTS = {
    enabled: true,
    compact: true,
    hiddenViewIds: [],
    hiddenGroupPaths: [],
    levelFontSizes: {},
    levelIndents: {},
  };

  let settings = { ...DEFAULTS };
  let sidebarPane = null;
  let observer = null;
  let pendingRaf = 0;
  const discoveredViews = new Map();
  const discoveredGroups = new Map();

  function cssAttr(s) {
    return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  function depthFromPath(path) {
    if (!path) return 0;
    return path.split("::").length;
  }

  function loadSettings() {
    return new Promise((resolve) => {
      chrome.storage.sync.get({ settings: null }, (res) => {
        if (res.settings && typeof res.settings === "object") {
          settings = { ...DEFAULTS, ...res.settings };
          if (!Array.isArray(settings.hiddenViewIds)) settings.hiddenViewIds = [];
          if (!Array.isArray(settings.hiddenGroupPaths)) settings.hiddenGroupPaths = [];
          if (!settings.levelFontSizes || typeof settings.levelFontSizes !== "object") {
            settings.levelFontSizes = {};
          }
          if (!settings.levelIndents || typeof settings.levelIndents !== "object") {
            settings.levelIndents = {};
          }
        }
        resolve();
      });
    });
  }

  function applyEnabledState() {
    if (!settings.enabled) {
      document.body && document.body.classList.remove("zvt-compact");
      removeStyle(HIDE_STYLE_ID);
      removeStyle(DENSITY_STYLE_ID);
      return;
    }
    if (settings.compact) {
      document.body && document.body.classList.add("zvt-compact");
    } else {
      document.body && document.body.classList.remove("zvt-compact");
    }
    rebuildHideStyle();
    rebuildDensityStyle();
  }

  function ensureStyle(id) {
    let el = document.getElementById(id);
    if (!el) {
      el = document.createElement("style");
      el.id = id;
      el.setAttribute("data-zvt", id);
      (document.head || document.documentElement).appendChild(el);
    }
    return el;
  }

  function removeStyle(id) {
    const el = document.getElementById(id);
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  function buildHideRules() {
    const rules = [];
    for (const rawId of settings.hiddenViewIds || []) {
      if (!/^\d+$/.test(String(rawId))) continue;
      const id = String(rawId);
      const tid = `${VIEW_TID_PREFIX}${id}`;
      rules.push(
        `li:has(> div > a[data-test-id="${tid}"]),
         li:has(> a[data-test-id="${tid}"]) { display: none !important; }`,
        `a[data-test-id="${tid}"] { display: none !important; }`
      );
    }
    for (const rawPath of settings.hiddenGroupPaths || []) {
      if (!rawPath) continue;
      const tid = `${FOLDER_TID_PREFIX}${cssAttr(rawPath)}`;
      rules.push(
        `li:has(> div > a[data-test-id="${tid}"]),
         li:has(> a[data-test-id="${tid}"]) { display: none !important; }`
      );
    }
    return rules.join("\n\n");
  }

  function rebuildHideStyle() {
    if (!settings.enabled) {
      removeStyle(HIDE_STYLE_ID);
      return;
    }
    ensureStyle(HIDE_STYLE_ID).textContent = buildHideRules();
  }

  function buildDensityRules() {
    const rules = [];
    const fonts = settings.levelFontSizes || {};
    const indents = settings.levelIndents || {};

    for (const [depth, sizeRaw] of Object.entries(fonts)) {
      const n = Number(depth);
      const size = Number(sizeRaw);
      if (!Number.isFinite(n) || n < 1 || !Number.isFinite(size) || size <= 0) continue;
      const lh = Math.max(12, Math.round(size * 1.35));
      rules.push(
        `body.zvt-compact a[data-test-id^="${VIEW_TID_PREFIX}"][data-zvt-d="${n}"],
         body.zvt-compact a[data-test-id^="${FOLDER_TID_PREFIX}"][data-zvt-d="${n}"] {
           font-size: ${size}px !important;
           line-height: ${lh}px !important;
         }`
      );
    }

    for (const [depth, indentRaw] of Object.entries(indents)) {
      const n = Number(depth);
      const indent = Number(indentRaw);
      if (!Number.isFinite(n) || n < 2 || !Number.isFinite(indent) || indent < 0) continue;
      rules.push(
        `body.zvt-compact ul[data-test-id^="${TREE_CHILD_PREFIX}"][data-zvt-d="${n}"] {
           padding-left: ${indent}px !important;
         }`
      );
    }
    return rules.join("\n\n");
  }

  function rebuildDensityStyle() {
    if (!settings.enabled) {
      removeStyle(DENSITY_STYLE_ID);
      return;
    }
    ensureStyle(DENSITY_STYLE_ID).textContent = buildDensityRules();
  }

  function annotateDepths(pane) {
    const containers = pane.querySelectorAll(
      `ul[data-test-id^="${TREE_CHILD_PREFIX}"]`
    );
    for (const ul of containers) {
      const path = ul.getAttribute("data-test-id").slice(TREE_CHILD_PREFIX.length);
      const d = depthFromPath(path) + 1;
      if (ul.getAttribute("data-zvt-d") !== String(d)) {
        ul.setAttribute("data-zvt-d", String(d));
      }
    }
    const folders = pane.querySelectorAll(`a[data-test-id^="${FOLDER_TID_PREFIX}"]`);
    for (const a of folders) {
      const path = a.getAttribute("data-test-id").slice(FOLDER_TID_PREFIX.length);
      const d = depthFromPath(path);
      if (a.getAttribute("data-zvt-d") !== String(d)) {
        a.setAttribute("data-zvt-d", String(d));
      }
    }
    const views = pane.querySelectorAll(`a[data-test-id^="${VIEW_TID_PREFIX}"]`);
    for (const a of views) {
      const ul = a.closest(`ul[data-test-id^="${TREE_CHILD_PREFIX}"]`);
      let d = 1;
      if (ul) {
        const path = ul.getAttribute("data-test-id").slice(TREE_CHILD_PREFIX.length);
        d = depthFromPath(path) + 1;
      }
      if (a.getAttribute("data-zvt-d") !== String(d)) {
        a.setAttribute("data-zvt-d", String(d));
      }
    }
  }

  function findSidebarPane() {
    const candidates = [
      'nav[aria-label="Views"]',
      '[data-test-id="views_views-pane_content"]',
      '[data-test-id="views_views-pane-div"]',
      `ul[data-test-id="${TREE_OUTER_TID}"]`,
    ];
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
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

  function extractGroupPathFromAnchor(anchor) {
    let n = anchor.parentElement;
    while (n && n !== document.body) {
      if (n.tagName === "UL") {
        const tid = n.getAttribute("data-test-id");
        if (tid && tid.startsWith(TREE_CHILD_PREFIX)) {
          return tid.slice(TREE_CHILD_PREFIX.length).split("::").filter(Boolean);
        }
      }
      n = n.parentElement;
    }
    return [];
  }

  function extractTitle(anchor) {
    const aria = anchor.getAttribute("aria-label");
    if (aria) return aria.trim().replace(/\s+/g, " ");
    const clone = anchor.cloneNode(true);
    for (const c of clone.querySelectorAll(`[data-test-id="${COUNT_TID}"]`)) {
      c.remove();
    }
    return (clone.textContent || "").trim().replace(/\s+/g, " ");
  }

  function discoverNow() {
    const pane = sidebarPane || findSidebarPane();
    if (!pane) return;
    if (pane !== sidebarPane) {
      sidebarPane = pane;
      attachObserver();
    }

    annotateDepths(pane);

    const viewAnchors = pane.querySelectorAll(
      `a[data-test-id^="${VIEW_TID_PREFIX}"], a[href*="/agent/filters/"]`
    );
    let viewsChanged = false;
    const now = Date.now();
    for (const a of viewAnchors) {
      const id = getViewIdFromAnchor(a);
      if (!id) continue;
      const title = extractTitle(a) || `View ${id}`;
      const groupPath = extractGroupPathFromAnchor(a);
      const depth = groupPath.length + 1;
      const href = (() => {
        try {
          return new URL(a.href, window.location.origin).pathname;
        } catch {
          return `/agent/filters/${id}`;
        }
      })();
      const prev = discoveredViews.get(id);
      if (
        !prev ||
        prev.title !== title ||
        prev.href !== href ||
        prev.depth !== depth ||
        JSON.stringify(prev.groupPath) !== JSON.stringify(groupPath)
      ) {
        viewsChanged = true;
      }
      discoveredViews.set(id, { id, title, href, groupPath, depth, lastSeenAt: now });
    }

    const folderAnchors = pane.querySelectorAll(
      `a[data-test-id^="${FOLDER_TID_PREFIX}"]`
    );
    let groupsChanged = false;
    for (const a of folderAnchors) {
      const tid = a.getAttribute("data-test-id");
      const path = tid.slice(FOLDER_TID_PREFIX.length);
      const segments = path.split("::");
      const name = (segments[segments.length - 1] || "").trim();
      const depth = segments.length;
      const prev = discoveredGroups.get(path);
      if (!prev || prev.name !== name || prev.depth !== depth) {
        groupsChanged = true;
      }
      discoveredGroups.set(path, { path, name, depth, lastSeenAt: now });
    }

    if (viewsChanged || (viewAnchors.length > 0 && discoveredViews.size > 0)) {
      persistViews();
    }
    if (groupsChanged || (folderAnchors.length > 0 && discoveredGroups.size > 0)) {
      persistGroups();
    }
  }

  function persistViews() {
    chrome.storage.local.get({ discoveredViews: [] }, (res) => {
      const existing = Array.isArray(res.discoveredViews) ? res.discoveredViews : [];
      const byId = new Map();
      const cutoff = Date.now() - PRUNE_AGE_MS;
      for (const v of existing) {
        if (!v || !v.id) continue;
        if (typeof v.lastSeenAt === "number" && v.lastSeenAt < cutoff) continue;
        byId.set(String(v.id), v);
      }
      for (const v of discoveredViews.values()) byId.set(v.id, v);
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

  function persistGroups() {
    chrome.storage.local.get({ discoveredGroups: [] }, (res) => {
      const existing = Array.isArray(res.discoveredGroups) ? res.discoveredGroups : [];
      const byPath = new Map();
      const cutoff = Date.now() - PRUNE_AGE_MS;
      for (const g of existing) {
        if (!g || !g.path) continue;
        if (typeof g.lastSeenAt === "number" && g.lastSeenAt < cutoff) continue;
        byPath.set(g.path, g);
      }
      for (const g of discoveredGroups.values()) byPath.set(g.path, g);
      const merged = Array.from(byPath.values()).sort((a, b) =>
        a.path.localeCompare(b.path)
      );
      if (JSON.stringify(merged) !== JSON.stringify(existing)) {
        chrome.storage.local.set({ discoveredGroups: merged });
      }
    });
  }

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

  setInterval(() => {
    if (!sidebarPane || !document.contains(sidebarPane)) {
      const next = findSidebarPane();
      if (next) {
        sidebarPane = next;
        attachObserver();
        discoverNow();
      }
    } else {
      annotateDepths(sidebarPane);
    }
  }, 3000);

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "zvt:rescan") {
      sidebarPane = findSidebarPane();
      attachObserver();
      discoverNow();
      sendResponse({
        ok: true,
        paneFound: !!sidebarPane,
        viewCount: discoveredViews.size,
        groupCount: discoveredGroups.size,
      });
    }
    return false;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes.settings) {
      const next = changes.settings.newValue || {};
      settings = { ...DEFAULTS, ...next };
      if (!Array.isArray(settings.hiddenViewIds)) settings.hiddenViewIds = [];
      if (!Array.isArray(settings.hiddenGroupPaths)) settings.hiddenGroupPaths = [];
      if (!settings.levelFontSizes) settings.levelFontSizes = {};
      if (!settings.levelIndents) settings.levelIndents = {};
      applyEnabledState();
    }
  });

  loadSettings().then(() => {
    applyEnabledState();
    tryMountSidebar(15);
  });

  Object.defineProperty(window, "__zvt", {
    configurable: true,
    value: {
      get pane() { return sidebarPane; },
      get views() { return Array.from(discoveredViews.values()); },
      get groups() { return Array.from(discoveredGroups.values()); },
      get settings() { return { ...settings }; },
      prefixes: { VIEW_TID_PREFIX, FOLDER_TID_PREFIX, TREE_OUTER_TID, TREE_CHILD_PREFIX, COUNT_TID },
      rescan() {
        sidebarPane = findSidebarPane();
        attachObserver();
        discoverNow();
        return {
          paneFound: !!sidebarPane,
          views: discoveredViews.size,
          groups: discoveredGroups.size,
        };
      },
    },
  });
})();
