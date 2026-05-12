/*
 * Zendesk Views Tweaks — content.js  (v0.4.0)
 *
 * See plan.md for full design. This file owns four dynamic stylesheets
 * in <head>, plus discovery, depth/key annotation, and the live-preview
 * message channel.
 *
 * Storage layout (chrome.storage.sync, multi-key):
 *   prefs:    { schemaVersion, enabled, compact, reorderEnabled }
 *   hide:     { v: ["123",...], g: ["Shared::Foo",...] }
 *   density:  { level: { "1": {...}, ... }, global: {...} }
 *   order:    { ROOT: ["g:Shared","g:Personal"], "g:Shared": [...] }
 *
 * Storage layout (chrome.storage.local):
 *   discoveredViews:  [{ id, title, href, groupPath, depth, lastSeenAt }]
 *   discoveredGroups: [{ path, name, depth, lastSeenAt }]
 *   discoveredContainers: [{ key, depth, lastSeenAt }]   // ROOT + g:<path>
 *   selectorHealth:   { paneFound, viewCount, folderCount, containerCount,
 *                       lastDiscoverAt, paneSelector, error }
 *   settingsBackupV1: {...}   // pre-migration snapshot
 *
 * Per-element annotations applied during discovery:
 *   - All anchors:                data-zvt-d="<depth>"
 *   - All children container ULs: data-zvt-d="<depth>"
 *   - Every row LI:               data-zvt-key="v:<id>" or "g:<path>"
 *
 * Stylesheets in <head>:
 *   #zvt-density-rules — generated from density settings
 *   #zvt-hide-rules    — generated from hide settings
 *   #zvt-order-rules   — generated from order settings (when reorderEnabled)
 *
 * Live preview:
 *   On chrome.runtime.onMessage type="zvt:preview", apply patch transiently
 *   (in-memory + rebuild stylesheets) without touching storage. Auto-revert
 *   to persisted values after PREVIEW_REVERT_MS without further patches.
 *   Persisted writes (storage.onChanged) override preview state.
 */

(() => {
  "use strict";

  /* ============================== constants ============================ */

  const STYLE_DENSITY = "zvt-density-rules";
  const STYLE_HIDE    = "zvt-hide-rules";
  const STYLE_ORDER   = "zvt-order-rules";

  const VIEW_TID_PREFIX   = "views_views-list_item-view-";
  const FOLDER_TID_PREFIX = "views_views-list_item-folder-";
  const TREE_OUTER_TID    = "views_views-tree_container";
  const TREE_CHILD_PREFIX = "views_views-tree_container-children_";
  const COUNT_TID         = "views_views-list_item_count";

  const VIEW_ID_RE = new RegExp("^" + VIEW_TID_PREFIX.replace(/[-_]/g, "\\$&") + "(\\d+)$");
  const FILTER_RE  = /^\/agent\/filters\/(\d+)\/?$/;

  const PRUNE_AGE_MS    = 90 * 24 * 60 * 60 * 1000;
  const PREVIEW_REVERT_MS = 5000;
  const HEALTH_DEBOUNCE_MS = 250;

  // SCHEMA: see plan.md.
  const DEFAULT_PREFS = {
    schemaVersion: 2,
    enabled: true,
    compact: true,
    reorderEnabled: false,
  };
  const DEFAULT_HIDE = { v: [], g: [] };
  const DEFAULT_DENSITY = {
    level: {},
    global: {
      rowGap: null,
      iconSize: null,
      countBadgeFontSize: null,
      countBadgeLineHeight: null,
      countBadgeMargin: null,
      countBadgePadding: null,
    },
  };
  const DEFAULT_ORDER = {}; // scopeKey -> array of item keys

  /* ----------------------------- selectors ----------------------------- */

  const SELECTORS = {
    pane: {
      primary: 'nav[aria-label="Views"]',
      alternates: [
        '[data-test-id="views_views-pane_content"]',
        '[data-test-id="views_views-pane-div"]',
        `ul[data-test-id="${TREE_OUTER_TID}"]`,
      ],
    },
    viewAnchor:     `a[data-test-id^="${VIEW_TID_PREFIX}"]`,
    folderAnchor:   `a[data-test-id^="${FOLDER_TID_PREFIX}"]`,
    childContainer: `ul[data-test-id^="${TREE_CHILD_PREFIX}"]`,
    countBadge:     `[data-test-id="${COUNT_TID}"]`,
    outerContainer: `ul[data-test-id="${TREE_OUTER_TID}"]`,
  };

  /* ============================== state ================================ */

  let prefs = { ...DEFAULT_PREFS };
  let hide = { ...DEFAULT_HIDE };
  let density = JSON.parse(JSON.stringify(DEFAULT_DENSITY));
  let order = { ...DEFAULT_ORDER };

  // Active state can be overridden by transient preview patches.
  let previewPrefs = null;
  let previewHide = null;
  let previewDensity = null;
  let previewOrder = null;
  let previewExpiresTimer = 0;

  let sidebarPane = null;
  let observer = null;
  let pendingRaf = 0;
  let healthDebounce = 0;
  let lastPaneSelector = null;
  let lastPaneViaShape = false;

  const discoveredViews = new Map();
  const discoveredGroups = new Map();
  const discoveredContainers = new Map(); // key -> { key, depth, lastSeenAt }

  /* ============================== utilities ============================ */

  function cssAttr(s) {
    return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }

  function depthFromPath(path) {
    if (!path) return 0;
    return path.split("::").length;
  }

  function viewKey(id)    { return `v:${id}`; }
  function groupKey(path) { return `g:${path}`; }

  function activePrefs()   { return previewPrefs   || prefs; }
  function activeHide()    { return previewHide    || hide; }
  function activeDensity() { return previewDensity || density; }
  function activeOrder()   { return previewOrder   || order; }

  /* =========================== storage / migration ===================== */

  // Legacy v0.1-v0.3 used a single chrome.storage.sync.settings object.
  // Detect and migrate; back up the old payload to local before overwriting.
  function loadAllAndMigrate() {
    return new Promise((resolve) => {
      chrome.storage.sync.get(
        { prefs: null, hide: null, density: null, order: null, settings: null },
        async (res) => {
          const havePrefs = res.prefs && typeof res.prefs === "object" && res.prefs.schemaVersion >= 2;
          if (havePrefs) {
            applyLoaded(res);
            resolve();
            return;
          }

          const legacy = res.settings && typeof res.settings === "object" ? res.settings : null;
          if (legacy) {
            try {
              await new Promise((r) =>
                chrome.storage.local.set({ settingsBackupV1: legacy }, r)
              );
            } catch {
              /* non-fatal */
            }
            const migrated = migrateV1ToV2(legacy);
            await new Promise((r) => chrome.storage.sync.set(migrated, r));
            try {
              await new Promise((r) => chrome.storage.sync.remove("settings", r));
            } catch {
              /* non-fatal */
            }
            applyLoaded({ ...res, ...migrated });
          } else {
            // Fresh install — write defaults so future loads skip the migration path.
            const fresh = {
              prefs: { ...DEFAULT_PREFS },
              hide: { ...DEFAULT_HIDE },
              density: JSON.parse(JSON.stringify(DEFAULT_DENSITY)),
              order: { ...DEFAULT_ORDER },
            };
            await new Promise((r) => chrome.storage.sync.set(fresh, r));
            applyLoaded({ ...res, ...fresh });
          }
          resolve();
        }
      );
    });
  }

  function applyLoaded(res) {
    prefs = { ...DEFAULT_PREFS, ...(res.prefs || {}) };
    const h = res.hide || {};
    hide = {
      v: Array.isArray(h.v) ? h.v.map(String) : [],
      g: Array.isArray(h.g) ? h.g.map(String) : [],
    };
    const d = res.density || {};
    density = {
      level: d.level && typeof d.level === "object" ? d.level : {},
      global: { ...DEFAULT_DENSITY.global, ...(d.global || {}) },
    };
    order = res.order && typeof res.order === "object" ? res.order : {};
  }

  function migrateV1ToV2(legacy) {
    const newPrefs = {
      schemaVersion: 2,
      enabled: legacy.enabled !== false,
      compact: legacy.compact !== false,
      reorderEnabled: false,
    };
    const newHide = {
      v: Array.isArray(legacy.hiddenViewIds) ? legacy.hiddenViewIds.map(String) : [],
      g: Array.isArray(legacy.hiddenGroupPaths) ? legacy.hiddenGroupPaths.map(String) : [],
    };
    const fonts = legacy.levelFontSizes && typeof legacy.levelFontSizes === "object" ? legacy.levelFontSizes : {};
    const indents = legacy.levelIndents && typeof legacy.levelIndents === "object" ? legacy.levelIndents : {};
    const level = {};
    for (const [d, v] of Object.entries(fonts)) {
      level[d] = level[d] || {};
      const n = Number(v);
      if (Number.isFinite(n)) level[d].fontSize = n;
    }
    for (const [d, v] of Object.entries(indents)) {
      level[d] = level[d] || {};
      const n = Number(v);
      if (Number.isFinite(n)) level[d].indent = n;
    }
    const newDensity = {
      level,
      global: { ...DEFAULT_DENSITY.global },
    };
    return {
      prefs: newPrefs,
      hide: newHide,
      density: newDensity,
      order: { ...DEFAULT_ORDER },
    };
  }

  /* ============================== stylesheets ========================== */

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

  function applyEnabledState() {
    const p = activePrefs();
    if (!p.enabled) {
      document.body && document.body.classList.remove("zvt-compact");
      removeStyle(STYLE_DENSITY);
      removeStyle(STYLE_HIDE);
      removeStyle(STYLE_ORDER);
      return;
    }
    if (p.compact) {
      document.body && document.body.classList.add("zvt-compact");
    } else {
      document.body && document.body.classList.remove("zvt-compact");
    }
    rebuildDensityStyle();
    rebuildHideStyle();
    rebuildOrderStyle();
  }

  function pxOrNull(v) {
    const n = Number(v);
    return Number.isFinite(n) ? `${n}px` : null;
  }

  function buildDensityRules() {
    const p = activePrefs();
    if (!p.compact) return ""; // density only applies in compact mode
    const d = activeDensity();
    const rules = [];

    // Per-level rules. Both folder and view anchors at depth N.
    for (const [depth, tokens] of Object.entries(d.level || {})) {
      const n = Number(depth);
      if (!Number.isFinite(n) || n < 1) continue;
      const sel = `body.zvt-compact a[data-test-id^="${VIEW_TID_PREFIX}"][data-zvt-d="${n}"], body.zvt-compact a[data-test-id^="${FOLDER_TID_PREFIX}"][data-zvt-d="${n}"]`;
      const props = [];

      const fs = pxOrNull(tokens.fontSize);
      if (fs) props.push(`font-size: ${fs} !important;`);
      const lh = tokens.lineHeight != null
        ? pxOrNull(tokens.lineHeight)
        : (tokens.fontSize != null ? pxOrNull(Math.max(12, Math.round(Number(tokens.fontSize) * 1.35))) : null);
      if (lh) props.push(`line-height: ${lh} !important;`);

      const pt = pxOrNull(tokens.rowPaddingTop);
      const pb = pxOrNull(tokens.rowPaddingBottom);
      if (pt) props.push(`padding-top: ${pt} !important;`);
      if (pb) props.push(`padding-bottom: ${pb} !important;`);
      const mh = pxOrNull(tokens.rowMinHeight);
      if (mh) props.push(`min-height: ${mh} !important;`);

      if (props.length) rules.push(`${sel} { ${props.join(" ")} }`);

      // Inner padded div (Zendesk's source of horizontal padding) for left/right.
      const pl = pxOrNull(tokens.rowPaddingLeft);
      const pr = pxOrNull(tokens.rowPaddingRight);
      if (pl != null || pr != null) {
        const inner = `${sel.split(", ").map(s => s + " > div").join(", ")}`;
        const innerProps = [];
        if (pl != null) innerProps.push(`padding-left: ${pl} !important;`);
        if (pr != null) innerProps.push(`padding-right: ${pr} !important;`);
        rules.push(`${inner} { ${innerProps.join(" ")} }`);
      }

      // Per-level indent: targets the children container (depth = pathSegs+1),
      // so depth N items live inside a container marked data-zvt-d=N.
      const indent = pxOrNull(tokens.indent);
      if (indent != null && n >= 2) {
        rules.push(
          `body.zvt-compact ul[data-test-id^="${TREE_CHILD_PREFIX}"][data-zvt-d="${n}"] { padding-left: ${indent} !important; }`
        );
      }
    }

    // Global tokens.
    const g = d.global || {};
    const gap = pxOrNull(g.rowGap);
    if (gap) {
      rules.push(
        `body.zvt-compact ul[data-test-id="${TREE_OUTER_TID}"] > li + li,
         body.zvt-compact ul[data-test-id^="${TREE_CHILD_PREFIX}"] > li + li
         { margin-top: ${gap} !important; }`
      );
    }
    const icon = pxOrNull(g.iconSize);
    if (icon) {
      rules.push(
        `body.zvt-compact a[data-test-id^="${VIEW_TID_PREFIX}"] svg,
         body.zvt-compact a[data-test-id^="${FOLDER_TID_PREFIX}"] svg
         { width: ${icon} !important; height: ${icon} !important; }`
      );
    }
    const badgeProps = [];
    const bfs = pxOrNull(g.countBadgeFontSize);
    if (bfs) badgeProps.push(`font-size: ${bfs} !important;`);
    const blh = pxOrNull(g.countBadgeLineHeight);
    if (blh) badgeProps.push(`line-height: ${blh} !important;`);
    const bm = pxOrNull(g.countBadgeMargin);
    if (bm) badgeProps.push(`margin-left: ${bm} !important;`);
    const bp = pxOrNull(g.countBadgePadding);
    if (bp) badgeProps.push(`padding: ${bp} !important;`);
    if (badgeProps.length) {
      rules.push(`body.zvt-compact [data-test-id="${COUNT_TID}"] { ${badgeProps.join(" ")} }`);
    }

    return rules.join("\n");
  }

  function rebuildDensityStyle() {
    if (!activePrefs().enabled) {
      removeStyle(STYLE_DENSITY);
      return;
    }
    ensureStyle(STYLE_DENSITY).textContent = buildDensityRules();
  }

  function buildHideRules() {
    const h = activeHide();
    const rules = [];

    for (const id of h.v || []) {
      if (!/^\d+$/.test(String(id))) continue;
      rules.push(`li[data-zvt-key="v:${cssAttr(id)}"] { display: none !important; }`);
      // Anchor-direct fallback in case data-zvt-key hasn't been applied yet
      // (e.g. on first paint before discovery runs).
      const tid = `${VIEW_TID_PREFIX}${id}`;
      rules.push(`a[data-test-id="${tid}"] { display: none !important; }`);
    }
    for (const path of h.g || []) {
      if (!path) continue;
      rules.push(`li[data-zvt-key="g:${cssAttr(path)}"] { display: none !important; }`);
      const tid = `${FOLDER_TID_PREFIX}${cssAttr(path)}`;
      rules.push(
        `li:has(> div > a[data-test-id="${tid}"]),
         li:has(> a[data-test-id="${tid}"]) { display: none !important; }`
      );
    }
    return rules.join("\n");
  }

  function rebuildHideStyle() {
    if (!activePrefs().enabled) {
      removeStyle(STYLE_HIDE);
      return;
    }
    ensureStyle(STYLE_HIDE).textContent = buildHideRules();
  }

  function buildOrderRules() {
    const p = activePrefs();
    if (!p.reorderEnabled) return "";

    const ord = activeOrder();
    const rules = [];

    // Parents must be flex-column for `order` to apply.
    rules.push(
      `ul[data-test-id="${TREE_OUTER_TID}"],
       ul[data-test-id^="${TREE_CHILD_PREFIX}"]
       { display: flex !important; flex-direction: column !important; }`
    );

    // Items in any order array get a negative `order` so they sort BEFORE
    // unordered items (which default to order: 0).
    // Use 1-based index and offset by -10000 so first user item = -9999.
    for (const [/* scope */, arr] of Object.entries(ord)) {
      if (!Array.isArray(arr)) continue;
      arr.forEach((key, i) => {
        if (typeof key !== "string" || !key) return;
        const v = i - 10000;
        rules.push(`li[data-zvt-key="${cssAttr(key)}"] { order: ${v} !important; }`);
      });
    }
    return rules.join("\n");
  }

  function rebuildOrderStyle() {
    if (!activePrefs().enabled || !activePrefs().reorderEnabled) {
      removeStyle(STYLE_ORDER);
      return;
    }
    ensureStyle(STYLE_ORDER).textContent = buildOrderRules();
  }

  /* ============================== discovery ============================ */

  function findSidebarPane() {
    const tryList = [SELECTORS.pane.primary, ...SELECTORS.pane.alternates];
    for (const sel of tryList) {
      const el = document.querySelector(sel);
      if (el) {
        lastPaneSelector = sel;
        lastPaneViaShape = false;
        return el;
      }
    }
    // Shape-detection fallback: find filter anchors, walk up to smallest
    // enclosing nav/aside/ul that contains ≥3 of them and has nested ULs.
    const anchors = document.querySelectorAll('a[href*="/agent/filters/"]');
    if (anchors.length >= 3) {
      const score = new Map();
      for (const a of anchors) {
        let n = a.parentElement;
        while (n && n !== document.body) {
          const tag = n.tagName;
          if (tag === "NAV" || tag === "ASIDE" || tag === "UL" || n.getAttribute("role") === "navigation") {
            score.set(n, (score.get(n) || 0) + 1);
          }
          n = n.parentElement;
        }
      }
      // Smallest ancestor containing all/most anchors AND nested ULs.
      const candidates = Array.from(score.entries())
        .filter(([el, count]) => count >= 3 && el.querySelector("ul ul"))
        .sort((a, b) => {
          // Prefer smaller (deeper) elements that still hold most anchors.
          const sizeDiff =
            a[0].getBoundingClientRect().height -
            b[0].getBoundingClientRect().height;
          return sizeDiff;
        });
      if (candidates.length) {
        lastPaneSelector = "shape-detection";
        lastPaneViaShape = true;
        return candidates[0][0];
      }
    }
    lastPaneSelector = null;
    lastPaneViaShape = false;
    return null;
  }

  function getViewIdFromAnchor(a) {
    const tid = a.getAttribute("data-test-id");
    if (tid) {
      const m = tid.match(VIEW_ID_RE);
      if (m) return m[1];
    }
    try {
      const u = new URL(a.href, window.location.origin);
      const m = u.pathname.match(FILTER_RE);
      if (m) return m[1];
    } catch {
      /* ignore */
    }
    return null;
  }

  function getFolderPathFromAnchor(a) {
    const tid = a.getAttribute("data-test-id");
    if (!tid || !tid.startsWith(FOLDER_TID_PREFIX)) return null;
    return tid.slice(FOLDER_TID_PREFIX.length);
  }

  function extractGroupPathFromAnchor(a) {
    let n = a.parentElement;
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

  function extractTitle(a) {
    const aria = a.getAttribute("aria-label");
    if (aria) return aria.trim().replace(/\s+/g, " ");
    const clone = a.cloneNode(true);
    for (const c of clone.querySelectorAll(`[data-test-id="${COUNT_TID}"]`)) {
      c.remove();
    }
    return (clone.textContent || "").trim().replace(/\s+/g, " ");
  }

  function annotate(pane) {
    // Container ULs depth + scope key.
    const containers = pane.querySelectorAll(SELECTORS.childContainer);
    for (const ul of containers) {
      const path = ul.getAttribute("data-test-id").slice(TREE_CHILD_PREFIX.length);
      const d = depthFromPath(path) + 1;
      if (ul.getAttribute("data-zvt-d") !== String(d)) ul.setAttribute("data-zvt-d", String(d));
    }
    // Outer container = ROOT.
    const outer = pane.matches(SELECTORS.outerContainer)
      ? pane
      : pane.querySelector(SELECTORS.outerContainer);
    if (outer && outer.getAttribute("data-zvt-d") !== "0") outer.setAttribute("data-zvt-d", "0");

    // Folder anchors: depth + their LI gets data-zvt-key="g:<path>".
    const folders = pane.querySelectorAll(SELECTORS.folderAnchor);
    for (const a of folders) {
      const path = getFolderPathFromAnchor(a);
      if (!path) continue;
      const d = depthFromPath(path);
      if (a.getAttribute("data-zvt-d") !== String(d)) a.setAttribute("data-zvt-d", String(d));
      const li = a.closest("li");
      if (li) {
        const k = groupKey(path);
        if (li.getAttribute("data-zvt-key") !== k) li.setAttribute("data-zvt-key", k);
      }
    }

    // View anchors: depth (from enclosing container) + LI key="v:<id>".
    const views = pane.querySelectorAll(SELECTORS.viewAnchor);
    for (const a of views) {
      const ul = a.closest(SELECTORS.childContainer);
      let d = 1;
      if (ul) {
        const path = ul.getAttribute("data-test-id").slice(TREE_CHILD_PREFIX.length);
        d = depthFromPath(path) + 1;
      }
      if (a.getAttribute("data-zvt-d") !== String(d)) a.setAttribute("data-zvt-d", String(d));
      const id = getViewIdFromAnchor(a);
      const li = a.closest("li");
      if (li && id) {
        const k = viewKey(id);
        if (li.getAttribute("data-zvt-key") !== k) li.setAttribute("data-zvt-key", k);
      }
    }
  }

  function discoverNow() {
    const pane = sidebarPane || findSidebarPane();
    if (!pane) {
      scheduleHealthSnapshot();
      return;
    }
    if (pane !== sidebarPane) {
      sidebarPane = pane;
      attachObserver();
    }

    annotate(pane);

    const now = Date.now();
    let viewsChanged = false;
    let groupsChanged = false;
    let containersChanged = false;

    // Views.
    for (const a of pane.querySelectorAll(SELECTORS.viewAnchor)) {
      const id = getViewIdFromAnchor(a);
      if (!id) continue;
      const title = extractTitle(a) || `View ${id}`;
      const groupPath = extractGroupPathFromAnchor(a);
      const depth = groupPath.length + 1;
      let href;
      try { href = new URL(a.href, window.location.origin).pathname; } catch { href = `/agent/filters/${id}`; }
      const prev = discoveredViews.get(id);
      if (
        !prev ||
        prev.title !== title ||
        prev.href !== href ||
        prev.depth !== depth ||
        JSON.stringify(prev.groupPath) !== JSON.stringify(groupPath)
      ) viewsChanged = true;
      discoveredViews.set(id, { id, title, href, groupPath, depth, lastSeenAt: now });
    }

    // Groups.
    for (const a of pane.querySelectorAll(SELECTORS.folderAnchor)) {
      const path = getFolderPathFromAnchor(a);
      if (!path) continue;
      const segments = path.split("::");
      const name = segments[segments.length - 1] || "";
      const depth = segments.length;
      const prev = discoveredGroups.get(path);
      if (!prev || prev.name !== name || prev.depth !== depth) groupsChanged = true;
      discoveredGroups.set(path, { path, name, depth, lastSeenAt: now });
    }

    // Containers (for the reorder UI: each scope = a container).
    // ROOT container is the outer ul (depth 0); children containers are depth 1+.
    const rootKey = "ROOT";
    if (!discoveredContainers.has(rootKey)) containersChanged = true;
    discoveredContainers.set(rootKey, { key: rootKey, depth: 0, lastSeenAt: now });
    for (const ul of pane.querySelectorAll(SELECTORS.childContainer)) {
      const path = ul.getAttribute("data-test-id").slice(TREE_CHILD_PREFIX.length);
      const key = groupKey(path);
      const depth = depthFromPath(path);
      const prev = discoveredContainers.get(key);
      if (!prev || prev.depth !== depth) containersChanged = true;
      discoveredContainers.set(key, { key, depth, lastSeenAt: now });
    }

    if (viewsChanged) persistViews();
    if (groupsChanged) persistGroups();
    if (containersChanged) persistContainers();

    scheduleHealthSnapshot();
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
      const merged = Array.from(byPath.values()).sort((a, b) => a.path.localeCompare(b.path));
      if (JSON.stringify(merged) !== JSON.stringify(existing)) {
        chrome.storage.local.set({ discoveredGroups: merged });
      }
    });
  }

  function persistContainers() {
    chrome.storage.local.get({ discoveredContainers: [] }, (res) => {
      const existing = Array.isArray(res.discoveredContainers) ? res.discoveredContainers : [];
      const byKey = new Map();
      const cutoff = Date.now() - PRUNE_AGE_MS;
      for (const c of existing) {
        if (!c || !c.key) continue;
        if (typeof c.lastSeenAt === "number" && c.lastSeenAt < cutoff) continue;
        byKey.set(c.key, c);
      }
      for (const c of discoveredContainers.values()) byKey.set(c.key, c);
      const merged = Array.from(byKey.values()).sort((a, b) => a.key.localeCompare(b.key));
      if (JSON.stringify(merged) !== JSON.stringify(existing)) {
        chrome.storage.local.set({ discoveredContainers: merged });
      }
    });
  }

  /* ============================== health =============================== */

  let lastHealth = null;

  function snapshotHealth() {
    const pane = sidebarPane;
    const snap = {
      paneFound: !!pane,
      paneSelector: pane ? lastPaneSelector : null,
      paneViaShape: pane ? lastPaneViaShape : false,
      viewCount: pane ? pane.querySelectorAll(SELECTORS.viewAnchor).length : 0,
      folderCount: pane ? pane.querySelectorAll(SELECTORS.folderAnchor).length : 0,
      containerCount: pane ? pane.querySelectorAll(SELECTORS.childContainer).length : 0,
      observerAttached: !!observer,
      reorderEnabled: !!activePrefs().reorderEnabled,
      compact: !!activePrefs().compact,
      enabled: !!activePrefs().enabled,
      lastDiscoverAt: Date.now(),
    };
    if (!lastHealth || JSON.stringify(lastHealth) !== JSON.stringify(snap)) {
      lastHealth = snap;
      chrome.storage.local.set({ selectorHealth: snap });
    }
    return snap;
  }

  function scheduleHealthSnapshot() {
    if (healthDebounce) return;
    healthDebounce = setTimeout(() => {
      healthDebounce = 0;
      snapshotHealth();
    }, HEALTH_DEBOUNCE_MS);
  }

  /* ============================ observer / mount ======================= */

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
      if (sidebarPane && !document.contains(sidebarPane)) sidebarPane = null;
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
    if (retriesLeft <= 0) {
      snapshotHealth();
      return;
    }
    setTimeout(() => tryMountSidebar(retriesLeft - 1), 1000);
  }

  // Periodic safety net: re-find sidebar if torn down, re-apply annotations.
  setInterval(() => {
    if (!sidebarPane || !document.contains(sidebarPane)) {
      const next = findSidebarPane();
      if (next) {
        sidebarPane = next;
        attachObserver();
        discoverNow();
      } else {
        snapshotHealth();
      }
    } else {
      annotate(sidebarPane);
      snapshotHealth();
    }
  }, 3000);

  /* ============================ live preview =========================== */

  function clearPreview() {
    previewPrefs = null;
    previewHide = null;
    previewDensity = null;
    previewOrder = null;
    if (previewExpiresTimer) {
      clearTimeout(previewExpiresTimer);
      previewExpiresTimer = 0;
    }
    applyEnabledState();
  }

  function applyPreview(patch) {
    if (!patch || typeof patch !== "object") return;
    if (patch.prefs) {
      previewPrefs = { ...prefs, ...(previewPrefs || {}), ...patch.prefs };
    }
    if (patch.hide) {
      const cur = previewHide || hide;
      previewHide = {
        v: Array.isArray(patch.hide.v) ? patch.hide.v.map(String) : cur.v,
        g: Array.isArray(patch.hide.g) ? patch.hide.g.map(String) : cur.g,
      };
    }
    if (patch.density) {
      const cur = previewDensity || density;
      previewDensity = {
        level: patch.density.level && typeof patch.density.level === "object"
          ? deepMerge(cur.level, patch.density.level)
          : cur.level,
        global: patch.density.global && typeof patch.density.global === "object"
          ? { ...cur.global, ...patch.density.global }
          : cur.global,
      };
    }
    if (patch.order && typeof patch.order === "object") {
      previewOrder = { ...(previewOrder || order), ...patch.order };
    }
    if (previewExpiresTimer) clearTimeout(previewExpiresTimer);
    previewExpiresTimer = setTimeout(clearPreview, PREVIEW_REVERT_MS);
    applyEnabledState();
  }

  function deepMerge(a, b) {
    const out = { ...(a || {}) };
    for (const [k, v] of Object.entries(b || {})) {
      if (v && typeof v === "object" && !Array.isArray(v)) {
        out[k] = deepMerge(out[k] || {}, v);
      } else {
        out[k] = v;
      }
    }
    return out;
  }

  /* ============================ messaging ============================== */

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg !== "object") return false;
    if (msg.type === "zvt:rescan") {
      sidebarPane = findSidebarPane();
      attachObserver();
      discoverNow();
      sendResponse({
        ok: true,
        paneFound: !!sidebarPane,
        viewCount: discoveredViews.size,
        groupCount: discoveredGroups.size,
        containerCount: discoveredContainers.size,
      });
      return false;
    }
    if (msg.type === "zvt:preview") {
      applyPreview(msg.patch);
      sendResponse({ ok: true });
      return false;
    }
    if (msg.type === "zvt:clearPreview") {
      clearPreview();
      sendResponse({ ok: true });
      return false;
    }
    if (msg.type === "zvt:status") {
      sendResponse({ ok: true, health: snapshotHealth() });
      return false;
    }
    return false;
  });

  /* ============================ storage onChange ======================= */

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    let touched = false;
    if (changes.prefs) {
      prefs = { ...DEFAULT_PREFS, ...(changes.prefs.newValue || {}) };
      touched = true;
    }
    if (changes.hide) {
      const h = changes.hide.newValue || {};
      hide = {
        v: Array.isArray(h.v) ? h.v.map(String) : [],
        g: Array.isArray(h.g) ? h.g.map(String) : [],
      };
      touched = true;
    }
    if (changes.density) {
      const d = changes.density.newValue || {};
      density = {
        level: d.level && typeof d.level === "object" ? d.level : {},
        global: { ...DEFAULT_DENSITY.global, ...(d.global || {}) },
      };
      touched = true;
    }
    if (changes.order) {
      order = changes.order.newValue && typeof changes.order.newValue === "object"
        ? changes.order.newValue
        : {};
      touched = true;
    }
    if (touched) {
      // Persisted change wins over any active preview.
      clearPreview();
    }
  });

  /* ============================== boot ================================= */

  loadAllAndMigrate().then(() => {
    applyEnabledState();
    tryMountSidebar(15);
  });

  Object.defineProperty(window, "__zvt", {
    configurable: true,
    value: {
      get pane() { return sidebarPane; },
      get views()      { return Array.from(discoveredViews.values()); },
      get groups()     { return Array.from(discoveredGroups.values()); },
      get containers() { return Array.from(discoveredContainers.values()); },
      get prefs()    { return { ...activePrefs() }; },
      get hide()     { return JSON.parse(JSON.stringify(activeHide())); },
      get density()  { return JSON.parse(JSON.stringify(activeDensity())); },
      get order()    { return JSON.parse(JSON.stringify(activeOrder())); },
      get health()   { return snapshotHealth(); },
      selectors: SELECTORS,
      rescan() {
        sidebarPane = findSidebarPane();
        attachObserver();
        discoverNow();
        return snapshotHealth();
      },
      export() {
        return JSON.stringify(
          {
            schemaVersion: 2,
            generatedAt: new Date().toISOString(),
            prefs: { ...prefs },
            hide: JSON.parse(JSON.stringify(hide)),
            density: JSON.parse(JSON.stringify(density)),
            order: JSON.parse(JSON.stringify(order)),
            health: snapshotHealth(),
          },
          null,
          2
        );
      },
    },
  });
})();
