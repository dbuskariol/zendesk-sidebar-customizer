/*
 * Zendesk Sidebar Customizer — content.js  (v0.6.4)
 *
 * Per-tab profile = window.location.host. Owns 5 dynamic stylesheets plus
 * sidebar discovery, live preview, and (optional) DOM reorder mode.
 *
 * All settings I/O goes through ZVT.ProfileStore. All CSS generation is
 * driven by the STYLESHEETS registry. Adding a new dynamic sheet = one
 * registry entry.
 */

(() => {
  "use strict";

  const {
    SELECTORS, PREFIXES, RE, SECTION_NAMES,
    ProfileStore, recordKnownHost, migrateProfileIndexV07,
    cssAttr, depthFromPath, viewKey, groupKey,
    RESERVED_PROFILE_ID,
  } = window.ZVT;

  const PROFILE_ID = window.location.host || RESERVED_PROFILE_ID;
  const profile = new ProfileStore(PROFILE_ID);

  /* ============================== state =============================== */

  const PRUNE_AGE_MS = 90 * 24 * 60 * 60 * 1000;
  const PREVIEW_REVERT_MS = 5000;
  const HEALTH_DEBOUNCE_MS = 250;

  let sidebarPane = null;
  let observer = null;
  let pendingRaf = 0;
  let healthDebounce = 0;
  let lastPaneSelector = null;
  let lastPaneViaShape = false;
  let lastHealth = null;
  let previewExpiresTimer = 0;
  // Tug-of-war detection state.
  let domReorderDisabledForSession = false;
  let suppressObserverDepth = 0; // guard against self-mutation feedback

  const discoveredViews = new Map();
  const discoveredGroups = new Map();
  const discoveredContainers = new Map();

  /* ====================== STYLESHEETS registry ======================= */

  // Single source of truth. Adding a sheet = one entry, no other code change.
  const STYLESHEETS = {
    density:     { id: "zvt-density-rules",     build: buildDensityRules },
    hide:        { id: "zvt-hide-rules",        build: buildHideRules },
    order:       { id: "zvt-order-rules",       build: buildOrderRules },
    theme:       { id: "zvt-theme-rules",       build: buildThemeRules },
    customViews: { id: "zvt-customviews-rules", build: buildCustomViewsRules },
  };

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

  function rebuildSheet(name) {
    const cfg = STYLESHEETS[name];
    if (!cfg) return;
    const css = cfg.build();
    if (css) ensureStyle(cfg.id).textContent = css;
    else removeStyle(cfg.id);
  }
  function rebuildAllSheets() {
    for (const name of Object.keys(STYLESHEETS)) rebuildSheet(name);
  }
  function removeAllSheets() {
    for (const cfg of Object.values(STYLESHEETS)) removeStyle(cfg.id);
  }

  /* ============================== state apply ========================= */

  function applyEnabledState() {
    const prefs = profile.resolve("prefs");
    if (!prefs.enabled) {
      document.body && document.body.classList.remove("zvt-compact", "zvt-themed");
      removeAllSheets();
      return;
    }
    document.body?.classList.toggle("zvt-compact", !!prefs.compact);
    document.body?.classList.toggle("zvt-themed", !!prefs.themed);
    rebuildAllSheets();
    // DOM reorder is applied during annotate (not via stylesheet).
    if (prefs.reorderEnabled && effectiveReorderMode() === "dom" && sidebarPane) {
      applyDomReorder(sidebarPane);
    }
  }

  /* ============================ rule builders ========================== */

  function pxOrNull(v) {
    const n = Number(v);
    return Number.isFinite(n) ? `${n}px` : null;
  }

  function buildDensityRules() {
    const prefs = profile.resolve("prefs");
    if (!prefs.compact) return "";
    const d = profile.resolve("density");
    const rules = [];

    for (const [depth, tokens] of Object.entries(d.level || {})) {
      const n = Number(depth);
      if (!Number.isFinite(n) || n < 1) continue;

      const baseSel = [
        `body.zvt-compact a[data-test-id^="${PREFIXES.VIEW_TID}"][data-zvt-d="${n}"]`,
        `body.zvt-compact a[data-test-id^="${PREFIXES.FOLDER_TID}"][data-zvt-d="${n}"]`,
      ].join(", ");

      const props = [];
      const fs = pxOrNull(tokens.fontSize); if (fs) props.push(`font-size: ${fs} !important;`);
      const lh = tokens.lineHeight != null
        ? pxOrNull(tokens.lineHeight)
        : (tokens.fontSize != null ? pxOrNull(Math.max(12, Math.round(Number(tokens.fontSize) * 1.35))) : null);
      if (lh) props.push(`line-height: ${lh} !important;`);
      const pt = pxOrNull(tokens.rowPaddingTop);    if (pt) props.push(`padding-top: ${pt} !important;`);
      const pb = pxOrNull(tokens.rowPaddingBottom); if (pb) props.push(`padding-bottom: ${pb} !important;`);
      const mh = pxOrNull(tokens.rowMinHeight);     if (mh) props.push(`min-height: ${mh} !important;`);
      if (props.length) rules.push(`${baseSel} { ${props.join(" ")} }`);

      const pl = pxOrNull(tokens.rowPaddingLeft);
      const pr = pxOrNull(tokens.rowPaddingRight);
      if (pl != null || pr != null) {
        const innerSel = baseSel.split(", ").map((s) => `${s} > div`).join(", ");
        const innerProps = [];
        if (pl != null) innerProps.push(`padding-left: ${pl} !important;`);
        if (pr != null) innerProps.push(`padding-right: ${pr} !important;`);
        rules.push(`${innerSel} { ${innerProps.join(" ")} }`);
      }

      const indent = pxOrNull(tokens.indent);
      if (indent != null && n >= 2) {
        rules.push(
          `body.zvt-compact ul[data-test-id^="${PREFIXES.TREE_CHILD}"][data-zvt-d="${n}"] { padding-left: ${indent} !important; }`
        );
      }
    }

    const g = d.global || {};
    const gap = pxOrNull(g.rowGap);
    if (gap) {
      rules.push(
        `body.zvt-compact ul[data-test-id="${PREFIXES.TREE_OUTER}"] > li + li,
         body.zvt-compact ul[data-test-id^="${PREFIXES.TREE_CHILD}"] > li + li { margin-top: ${gap} !important; }`
      );
    }
    const icon = pxOrNull(g.iconSize);
    if (icon) {
      rules.push(
        `body.zvt-compact a[data-test-id^="${PREFIXES.VIEW_TID}"] svg,
         body.zvt-compact a[data-test-id^="${PREFIXES.FOLDER_TID}"] svg { width: ${icon} !important; height: ${icon} !important; }`
      );
    }
    const badgeProps = [];
    const bfs = pxOrNull(g.countBadgeFontSize);   if (bfs) badgeProps.push(`font-size: ${bfs} !important;`);
    const blh = pxOrNull(g.countBadgeLineHeight); if (blh) badgeProps.push(`line-height: ${blh} !important;`);
    const bm  = pxOrNull(g.countBadgeMargin);     if (bm)  badgeProps.push(`margin-left: ${bm} !important;`);
    const bp  = pxOrNull(g.countBadgePadding);    if (bp)  badgeProps.push(`padding: ${bp} !important;`);
    if (badgeProps.length) {
      rules.push(`body.zvt-compact [data-test-id="${PREFIXES.COUNT_TID}"] { ${badgeProps.join(" ")} }`);
    }

    return rules.join("\n");
  }

  function buildHideRules() {
    const h = profile.resolve("hide");
    const rules = [];
    for (const id of h.v || []) {
      if (!/^\d+$/.test(String(id))) continue;
      rules.push(
        `li[data-zvt-key="v:${cssAttr(id)}"] { display: none !important; }`,
        `a[data-test-id="${PREFIXES.VIEW_TID}${cssAttr(id)}"] { display: none !important; }`
      );
    }
    for (const path of h.g || []) {
      if (!path) continue;
      rules.push(
        `li[data-zvt-key="g:${cssAttr(path)}"] { display: none !important; }`,
        `li:has(> div > a[data-test-id="${PREFIXES.FOLDER_TID}${cssAttr(path)}"]),
         li:has(> a[data-test-id="${PREFIXES.FOLDER_TID}${cssAttr(path)}"]) { display: none !important; }`
      );
    }
    return rules.join("\n");
  }

  function buildOrderRules() {
    const prefs = profile.resolve("prefs");
    if (!prefs.reorderEnabled) return "";
    // Emit CSS rules whenever the EFFECTIVE mode is css. That covers the
    // case where the user picked "dom" but the kill-switch demoted us —
    // a real fallback instead of zero reorder.
    if (effectiveReorderMode() !== "css") return "";
    const ord = profile.resolve("order");
    const rules = [
      `ul[data-test-id="${PREFIXES.TREE_OUTER}"],
       ul[data-test-id^="${PREFIXES.TREE_CHILD}"] { display: flex !important; flex-direction: column !important; }`,
    ];
    for (const arr of Object.values(ord)) {
      if (!Array.isArray(arr)) continue;
      arr.forEach((key, i) => {
        if (typeof key !== "string" || !key) return;
        rules.push(`li[data-zvt-key="${cssAttr(key)}"] { order: ${i - 10000} !important; }`);
      });
    }
    return rules.join("\n");
  }

  // Effective reorder mode: respects the user's pref but degrades when the
  // DOM-reorder kill-switch has fired this session. This is the single point
  // both buildOrderRules and the DOM applier consult.
  function effectiveReorderMode() {
    const prefs = profile.resolve("prefs");
    if (prefs.reorderMode === "dom" && !domReorderDisabledForSession) return "dom";
    return "css";
  }

  function buildThemeRules() {
    const prefs = profile.resolve("prefs");
    if (!prefs.themed) return "";
    const t = profile.resolve("theme");
    const p = t.palette || {};
    const rules = [];

    // Surface backgrounds.
    if (p.bg) {
      rules.push(
        `body.zvt-themed nav[aria-label="Views"] { background-color: ${p.bg} !important; }`,
        `body.zvt-themed [data-test-id="views_views-pane_content"] { background-color: ${p.bg} !important; }`
      );
    }
    if (p.fg) {
      rules.push(
        `body.zvt-themed nav[aria-label="Views"], body.zvt-themed nav[aria-label="Views"] * { color: ${p.fg} !important; }`
      );
    }
    if (p.hover) {
      rules.push(
        `body.zvt-themed a[data-test-id^="${PREFIXES.VIEW_TID}"]:hover,
         body.zvt-themed a[data-test-id^="${PREFIXES.FOLDER_TID}"]:hover { background-color: ${p.hover} !important; }`
      );
    }
    if (p.selected) {
      rules.push(
        `body.zvt-themed a[data-test-id^="${PREFIXES.VIEW_TID}"][aria-current],
         body.zvt-themed a[data-test-id^="${PREFIXES.VIEW_TID}"].is-active,
         body.zvt-themed a[data-test-id^="${PREFIXES.FOLDER_TID}"][aria-current],
         body.zvt-themed a[data-test-id^="${PREFIXES.FOLDER_TID}"].is-active { background-color: ${p.selected} !important; }`
      );
    }
    if (p.accent) {
      rules.push(
        `body.zvt-themed a[data-test-id^="${PREFIXES.VIEW_TID}"][aria-current],
         body.zvt-themed a[data-test-id^="${PREFIXES.FOLDER_TID}"][aria-current] { color: ${p.accent} !important; }`
      );
    }
    if (p.activeStripe) {
      rules.push(
        `body.zvt-themed a[data-test-id^="${PREFIXES.VIEW_TID}"][aria-current] { box-shadow: inset 3px 0 0 ${p.activeStripe} !important; }`
      );
    }
    if (p.focusRing) {
      rules.push(
        `body.zvt-themed a[data-test-id^="${PREFIXES.VIEW_TID}"]:focus-visible,
         body.zvt-themed a[data-test-id^="${PREFIXES.FOLDER_TID}"]:focus-visible { outline: 2px solid ${p.focusRing} !important; outline-offset: -2px !important; }`
      );
    }
    if (p.badgeBg || p.badgeFg) {
      const bp = [];
      if (p.badgeBg) bp.push(`background-color: ${p.badgeBg} !important;`);
      if (p.badgeFg) bp.push(`color: ${p.badgeFg} !important;`);
      rules.push(`body.zvt-themed [data-test-id="${PREFIXES.COUNT_TID}"] { ${bp.join(" ")} }`);
    }

    for (const [depth, lvl] of Object.entries(t.level || {})) {
      const n = Number(depth);
      if (!Number.isFinite(n)) continue;
      const sel = [
        `body.zvt-themed a[data-test-id^="${PREFIXES.VIEW_TID}"][data-zvt-d="${n}"]`,
        `body.zvt-themed a[data-test-id^="${PREFIXES.FOLDER_TID}"][data-zvt-d="${n}"]`,
      ].join(", ");
      const props = [];
      if (lvl.bgColor) props.push(`background-color: ${lvl.bgColor} !important;`);
      if (lvl.fgColor) props.push(`color: ${lvl.fgColor} !important;`);
      if (props.length) rules.push(`${sel} { ${props.join(" ")} }`);
    }
    return rules.join("\n");
  }

  function buildCustomViewsRules() {
    const cv = profile.resolve("customViews");
    const rules = [];
    for (const [id, c] of Object.entries(cv || {})) {
      if (!/^\d+$/.test(String(id))) continue;
      const sel = `li[data-zvt-key="v:${cssAttr(id)}"] > div > a > div, li[data-zvt-key="v:${cssAttr(id)}"] > a > div`;
      const props = [];
      if (c.bgColor)    props.push(`background-color: ${c.bgColor} !important;`);
      if (c.fgColor)    props.push(`color: ${c.fgColor} !important;`);
      if (c.fontWeight) props.push(`font-weight: ${c.fontWeight} !important;`);
      if (c.italic)     props.push(`font-style: italic !important;`);
      const pad = pxOrNull(c.padding);
      if (pad != null)  props.push(`padding: ${pad} !important;`);
      if (props.length) rules.push(`${sel} { ${props.join(" ")} }`);

      if (c.iconPrefix) {
        const escPrefix = c.iconPrefix.replace(/"/g, '\\"').replace(/\\/g, "\\\\");
        rules.push(
          `li[data-zvt-key="v:${cssAttr(id)}"] > div > a > div::before,
           li[data-zvt-key="v:${cssAttr(id)}"] > a > div::before { content: "${escPrefix} "; margin-right: 2px; }`
        );
      }
    }
    return rules.join("\n");
  }

  /* ============================ annotation ============================ */

  function annotate(pane) {
    const containers = pane.querySelectorAll(SELECTORS.childContainer);
    for (const ul of containers) {
      const path = ul.getAttribute("data-test-id").slice(PREFIXES.TREE_CHILD.length);
      const d = depthFromPath(path) + 1;
      if (ul.getAttribute("data-zvt-d") !== String(d)) ul.setAttribute("data-zvt-d", String(d));
    }
    const outer = pane.matches(SELECTORS.outerContainer)
      ? pane
      : pane.querySelector(SELECTORS.outerContainer);
    if (outer && outer.getAttribute("data-zvt-d") !== "0") outer.setAttribute("data-zvt-d", "0");

    for (const a of pane.querySelectorAll(SELECTORS.folderAnchor)) {
      const tid = a.getAttribute("data-test-id");
      if (!tid) continue;
      const path = tid.slice(PREFIXES.FOLDER_TID.length);
      const d = depthFromPath(path);
      if (a.getAttribute("data-zvt-d") !== String(d)) a.setAttribute("data-zvt-d", String(d));
      const li = a.closest("li");
      if (li) {
        const k = groupKey(path);
        if (li.getAttribute("data-zvt-key") !== k) li.setAttribute("data-zvt-key", k);
      }
    }

    for (const a of pane.querySelectorAll(SELECTORS.viewAnchor)) {
      const ul = a.closest(SELECTORS.childContainer);
      let d = 1;
      if (ul) {
        const path = ul.getAttribute("data-test-id").slice(PREFIXES.TREE_CHILD.length);
        d = depthFromPath(path) + 1;
      }
      if (a.getAttribute("data-zvt-d") !== String(d)) a.setAttribute("data-zvt-d", String(d));
      const id = getViewId(a);
      const li = a.closest("li");
      if (li && id) {
        const k = viewKey(id);
        if (li.getAttribute("data-zvt-key") !== k) li.setAttribute("data-zvt-key", k);
      }
    }
  }

  /* ============================ DOM reorder =========================== */

  // Tug-of-war detection. A "pass with work" means we had to move at least
  // one node. Tug-of-war = many passes-with-work close together (Zendesk
  // re-rendering and undoing our moves). A one-time burst (e.g. user has
  // 30 pinned items at first paint) is one pass and doesn't count as fight.
  const PASS_WITH_WORK_THRESHOLD = 5;     // passes-with-work allowed within window
  const PASS_WITH_WORK_WINDOW_MS = 2000;  // rolling window
  const passesWithWorkAt = []; // ring of timestamps

  /**
   * Apply DOM reorder to the sidebar children. Idempotent — if the order is
   * already correct, returns without mutating. Suppresses observer feedback
   * during its own writes via a depth-counted guard.
   */
  function applyDomReorder(pane) {
    if (domReorderDisabledForSession) return;
    const ord = profile.resolve("order");
    if (!ord || !Object.keys(ord).length) return;

    // Preflight: walk every container and check whether ANY work is needed.
    // If everything is already in place, return without entering the
    // suppression block (saves observer churn & cost).
    const plan = [];
    for (const [scope, arr] of Object.entries(ord)) {
      if (!Array.isArray(arr) || !arr.length) continue;
      const parent = scope === "ROOT"
        ? pane.querySelector(SELECTORS.outerContainer)
        : pane.querySelector(`ul[data-test-id="${PREFIXES.TREE_CHILD}${cssAttr(scope.slice(2))}"]`);
      if (!parent) continue;
      const childByKey = new Map();
      for (const child of parent.children) {
        const k = child.getAttribute?.("data-zvt-key");
        if (k) childByKey.set(k, child);
      }
      // Build the moves required to bring this container in line.
      const moves = [];
      let prevTarget = null;
      for (const key of arr) {
        const node = childByKey.get(key);
        if (!node) continue;
        const desiredAfter = prevTarget;
        const desiredNext = desiredAfter ? desiredAfter.nextSibling : parent.firstChild;
        if (node !== desiredNext && node !== desiredAfter) {
          moves.push({ parent, node, desiredNext });
        }
        prevTarget = node;
      }
      if (moves.length) plan.push(...moves);
    }
    if (!plan.length) return; // nothing to do — pure no-op

    // Self-mutation guard: pause the observer while we apply moves so we
    // don't trigger a re-discovery cycle from our own writes.
    suppressObserverDepth++;
    try {
      for (const { parent, node, desiredNext } of plan) {
        parent.insertBefore(node, desiredNext);
      }
    } finally {
      suppressObserverDepth--;
    }

    // Tug-of-war detection: this was a pass that did real work. If we see
    // PASS_WITH_WORK_THRESHOLD such passes within the window, we're fighting
    // Zendesk's React reconciliation; demote to CSS mode for the session.
    const now = Date.now();
    passesWithWorkAt.push(now);
    while (passesWithWorkAt.length && now - passesWithWorkAt[0] > PASS_WITH_WORK_WINDOW_MS) {
      passesWithWorkAt.shift();
    }
    if (passesWithWorkAt.length >= PASS_WITH_WORK_THRESHOLD) {
      domReorderDisabledForSession = true;
      console.warn("[ZVT] DOM reorder is fighting Zendesk's re-renders; demoting to CSS reorder for this session.");
      rebuildAllSheets(); // emit CSS order rules now that effective mode is css
      snapshotHealth();   // surface the fallback in popup
    }
  }

  /* ============================== discovery =========================== */

  function findSidebarPane() {
    for (const sel of [SELECTORS.pane.primary, ...SELECTORS.pane.alternates]) {
      const el = document.querySelector(sel);
      if (el) {
        lastPaneSelector = sel;
        lastPaneViaShape = false;
        return el;
      }
    }
    // Shape-detection fallback.
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
      const candidates = Array.from(score.entries())
        .filter(([el, count]) => count >= 3 && el.querySelector("ul ul"))
        .sort((a, b) => a[0].getBoundingClientRect().height - b[0].getBoundingClientRect().height);
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

  function getViewId(a) {
    const tid = a.getAttribute("data-test-id");
    if (tid) {
      const m = tid.match(RE.VIEW_ID);
      if (m) return m[1];
    }
    try {
      const u = new URL(a.href, window.location.origin);
      const m = u.pathname.match(RE.FILTER_URL);
      if (m) return m[1];
    } catch {}
    return null;
  }

  function getGroupPath(a) {
    let n = a.parentElement;
    while (n && n !== document.body) {
      if (n.tagName === "UL") {
        const tid = n.getAttribute("data-test-id");
        if (tid && tid.startsWith(PREFIXES.TREE_CHILD)) {
          return tid.slice(PREFIXES.TREE_CHILD.length).split("::").filter(Boolean);
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
    for (const c of clone.querySelectorAll(`[data-test-id="${PREFIXES.COUNT_TID}"]`)) {
      c.remove();
    }
    return (clone.textContent || "").trim().replace(/\s+/g, " ");
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
    let viewsChanged = false, groupsChanged = false, containersChanged = false;

    for (const a of pane.querySelectorAll(SELECTORS.viewAnchor)) {
      const id = getViewId(a);
      if (!id) continue;
      const title = extractTitle(a) || `View ${id}`;
      const groupPath = getGroupPath(a);
      const depth = groupPath.length + 1;
      let href;
      try { href = new URL(a.href, window.location.origin).pathname; } catch { href = `/agent/filters/${id}`; }
      const prev = discoveredViews.get(id);
      if (!prev || prev.title !== title || prev.href !== href || prev.depth !== depth ||
          JSON.stringify(prev.groupPath) !== JSON.stringify(groupPath)) {
        viewsChanged = true;
      }
      discoveredViews.set(id, { id, title, href, groupPath, depth, lastSeenAt: now });
    }

    for (const a of pane.querySelectorAll(SELECTORS.folderAnchor)) {
      const tid = a.getAttribute("data-test-id");
      if (!tid) continue;
      const path = tid.slice(PREFIXES.FOLDER_TID.length);
      const segments = path.split("::");
      const name = segments[segments.length - 1] || "";
      const depth = segments.length;
      const prev = discoveredGroups.get(path);
      if (!prev || prev.name !== name || prev.depth !== depth) groupsChanged = true;
      discoveredGroups.set(path, { path, name, depth, lastSeenAt: now });
    }

    if (!discoveredContainers.has("ROOT")) containersChanged = true;
    discoveredContainers.set("ROOT", { key: "ROOT", depth: 0, lastSeenAt: now });
    for (const ul of pane.querySelectorAll(SELECTORS.childContainer)) {
      const path = ul.getAttribute("data-test-id").slice(PREFIXES.TREE_CHILD.length);
      const key = groupKey(path);
      const depth = depthFromPath(path);
      const prev = discoveredContainers.get(key);
      if (!prev || prev.depth !== depth) containersChanged = true;
      discoveredContainers.set(key, { key, depth, lastSeenAt: now });
    }

    if (viewsChanged) persistCatalog("discoveredViews", discoveredViews, sortViews);
    if (groupsChanged) persistCatalog("discoveredGroups", discoveredGroups, sortByPath);
    if (containersChanged) persistCatalog("discoveredContainers", discoveredContainers, sortByKey);

    recordHost();
    scheduleHealthSnapshot();

    // DOM reorder applied after annotation pass.
    const prefs = profile.resolve("prefs");
    if (prefs.enabled && prefs.reorderEnabled && effectiveReorderMode() === "dom") {
      applyDomReorder(pane);
    }
  }

  function sortViews(arr) {
    return arr.sort((a, b) => {
      const ap = (a.groupPath || []).join("::");
      const bp = (b.groupPath || []).join("::");
      return ap !== bp ? ap.localeCompare(bp) : (a.title || "").localeCompare(b.title || "");
    });
  }
  function sortByPath(arr) { return arr.sort((a, b) => a.path.localeCompare(b.path)); }
  function sortByKey(arr) { return arr.sort((a, b) => a.key.localeCompare(b.key)); }

  function persistCatalog(baseKey, map, sorter) {
    const storageKey = `${baseKey}:${PROFILE_ID}`;
    chrome.storage.local.get({ [storageKey]: [] }, (res) => {
      const existing = Array.isArray(res[storageKey]) ? res[storageKey] : [];
      const cutoff = Date.now() - PRUNE_AGE_MS;
      const dedupKey = baseKey === "discoveredViews" ? "id" :
                       baseKey === "discoveredGroups" ? "path" : "key";
      const byId = new Map();
      for (const item of existing) {
        if (!item || !item[dedupKey]) continue;
        if (typeof item.lastSeenAt === "number" && item.lastSeenAt < cutoff) continue;
        byId.set(String(item[dedupKey]), item);
      }
      for (const item of map.values()) byId.set(String(item[dedupKey]), item);
      const merged = sorter(Array.from(byId.values()));
      if (JSON.stringify(merged) !== JSON.stringify(existing)) {
        chrome.storage.local.set({ [storageKey]: merged });
      }
    });
  }

  let lastHostWritten = null;
  function recordHost() {
    const host = window.location.host;
    if (!host || host === lastHostWritten) return;
    lastHostWritten = host;
    chrome.storage.local.set({
      lastZendeskHost: host,
      lastZendeskUrl: `${window.location.origin}/agent`,
    });
    // Track this host as "known" without auto-creating a profile for it.
    // The user creates an explicit profile only via the popup or options.
    recordKnownHost(host).catch(() => {});
    // Announce ourselves so any open options page / popup can refresh
    // immediately without waiting for the next status poll.
    //
    // sendMessage returns a Promise that REJECTS in Firefox (and sets
    // runtime.lastError in Chrome) when there's no listener — which is
    // common here because the options page may not be open. The previous
    // try/catch caught synchronous throws but missed the async rejection,
    // producing an "unhandled promise rejection" warning in Firefox.
    // Both browsers accept the no-op .catch() form.
    try {
      const r = chrome.runtime.sendMessage({ type: "zvt:tabMounted", host });
      if (r && typeof r.catch === "function") r.catch(() => {});
    } catch {
      /* extension context may be reloading */
    }
  }

  /* =============================== health ============================ */

  function snapshotHealth() {
    const pane = sidebarPane;
    const prefs = profile.resolve("prefs");
    // Stable shape used to detect meaningful change. lastDiscoverAt is
    // intentionally excluded — it changes every snapshot and would cause
    // unnecessary persistence + downstream re-render churn in the options page.
    const stableSnap = {
      profileId: PROFILE_ID,
      paneFound: !!pane,
      paneSelector: pane ? lastPaneSelector : null,
      paneViaShape: pane ? lastPaneViaShape : false,
      viewCount: pane ? pane.querySelectorAll(SELECTORS.viewAnchor).length : 0,
      folderCount: pane ? pane.querySelectorAll(SELECTORS.folderAnchor).length : 0,
      containerCount: pane ? pane.querySelectorAll(SELECTORS.childContainer).length : 0,
      observerAttached: !!observer,
      reorderEnabled: !!prefs.reorderEnabled,
      reorderMode: prefs.reorderMode,
      reorderDomFellBack: domReorderDisabledForSession,
      compact: !!prefs.compact,
      themed: !!prefs.themed,
      enabled: !!prefs.enabled,
    };
    const snap = { ...stableSnap, lastDiscoverAt: Date.now() };
    if (!lastHealth || JSON.stringify(omitTimestamp(lastHealth)) !== JSON.stringify(stableSnap)) {
      lastHealth = snap;
      chrome.storage.local.set({ [`selectorHealth:${PROFILE_ID}`]: snap });
    }
    return snap;
  }
  function omitTimestamp(h) { const { lastDiscoverAt, ...rest } = h; return rest; }
  function scheduleHealthSnapshot() {
    if (healthDebounce) return;
    healthDebounce = setTimeout(() => {
      healthDebounce = 0;
      snapshotHealth();
    }, HEALTH_DEBOUNCE_MS);
  }

  /* ======================== mount + observer ========================== */

  function attachObserver() {
    if (observer) { observer.disconnect(); observer = null; }
    if (!sidebarPane) return;
    observer = new MutationObserver(() => {
      // Self-mutation guard: if we triggered this by inserting nodes
      // ourselves during applyDomReorder, ignore the resulting fire.
      if (suppressObserverDepth > 0) return;
      scheduleDiscover();
    });
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
    // v0.9.0 — also rescan for ticket tables on each tick. Cheap; only
    // mutates internal state when a new table appears or an old one is gone.
    try { window.ZVT_TICKETS?.scan(); } catch (e) {}
  }, 3000);

  /* ============================ live preview ========================= */

  function clearAllPreviews() {
    profile.clearPreview();
    if (previewExpiresTimer) {
      clearTimeout(previewExpiresTimer);
      previewExpiresTimer = 0;
    }
    applyEnabledState();
  }

  function applyPreviewPatch(patch) {
    if (!patch || typeof patch !== "object") return;
    for (const [section, sectionPatch] of Object.entries(patch)) {
      if (!SECTION_NAMES.includes(section) || sectionPatch == null) continue;
      profile.applyPreview(section, sectionPatch);
    }
    if (previewExpiresTimer) clearTimeout(previewExpiresTimer);
    previewExpiresTimer = setTimeout(clearAllPreviews, PREVIEW_REVERT_MS);
    applyEnabledState();
  }

  /* ============================ messaging =========================== */

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg !== "object") return false;
    if (msg.profileId && msg.profileId !== PROFILE_ID && msg.profileId !== "*") {
      // Message intended for a different tenant tab.
      return false;
    }
    switch (msg.type) {
      case "zvt:rescan":
        sidebarPane = findSidebarPane();
        attachObserver();
        discoverNow();
        // v0.9.0 — rescan ticket tables too. Same dispatch, scoped to the
        // tickets module's own state.
        try { window.ZVT_TICKETS?.scan(); } catch (e) {}
        sendResponse({
          ok: true, profileId: PROFILE_ID,
          paneFound: !!sidebarPane,
          viewCount: discoveredViews.size,
          groupCount: discoveredGroups.size,
          containerCount: discoveredContainers.size,
          ticketsManaged: window.ZVT_TICKETS?.snapshot?.()?.managedCount || 0,
        });
        return false;
      case "zvt:preview": {
        // When the options page is editing the default profile, it broadcasts
        // with profileId: "*". A tab should only apply patches for sections
        // it inherits (i.e. has NOT forked) — forked sections would override
        // the default change anyway, so previewing them is misleading.
        let patch = msg.patch;
        if (msg.profileId === "*" && patch && typeof patch === "object") {
          const filtered = {};
          for (const [section, sectionPatch] of Object.entries(patch)) {
            if (!profile.isForked(section)) {
              filtered[section] = sectionPatch;
            }
          }
          patch = filtered;
        }
        applyPreviewPatch(patch);
        sendResponse({ ok: true, profileId: PROFILE_ID });
        return false;
      }
      case "zvt:clearPreview":
        clearAllPreviews();
        sendResponse({ ok: true, profileId: PROFILE_ID });
        return false;
      case "zvt:status":
        sendResponse({ ok: true, profileId: PROFILE_ID, health: snapshotHealth() });
        return false;
      default:
        return false;
    }
  });

  /* ============================ storage events ====================== */

  chrome.storage.onChanged.addListener(async (changes, area) => {
    const changedSections = await profile.handleStorageChange(changes, area);
    if (changedSections.length) {
      applyEnabledState();
      // If any ticket-list section changed, push fresh settings to the
      // tickets module. Cheap no-op if no ticket section changed.
      if (window.ZVT_TICKETS && changedSections.some(s => s.startsWith("ticket"))) {
        try { window.ZVT_TICKETS.refreshSettings(); } catch (e) {}
      }
    }
  });

  /* ============================== boot ============================== */

  (async function boot() {
    // Run the v0.7.0 migration once before any reads — it's idempotent and
    // self-short-circuiting via a sentinel key in chrome.storage.local.
    await migrateProfileIndexV07().catch(() => {});
    await profile.load();
    applyEnabledState();
    tryMountSidebar(15);
    // v0.9.0 — hand the profile to the ticket-list module so it can apply
    // ticket-list density/hide/color/auto-refresh in parallel with the
    // sidebar customizer. Tickets module is fully independent — failing
    // to attach must not break sidebar functionality.
    try {
      window.ZVT_TICKETS?.attach({ profile, host: PROFILE_ID });
    } catch (e) {
      console.warn("[zvt] ticket-list attach failed:", e);
    }
  })();

  /* ========================== debug surface ========================= */

  Object.defineProperty(window, "__zvt", {
    configurable: true,
    value: {
      get profileId() { return PROFILE_ID; },
      get pane() { return sidebarPane; },
      get views()      { return Array.from(discoveredViews.values()); },
      get groups()     { return Array.from(discoveredGroups.values()); },
      get containers() { return Array.from(discoveredContainers.values()); },
      get prefs()       { return profile.resolve("prefs"); },
      get hide()        { return profile.resolve("hide"); },
      get density()     { return profile.resolve("density"); },
      get order()       { return profile.resolve("order"); },
      get theme()       { return profile.resolve("theme"); },
      get customViews() { return profile.resolve("customViews"); },
      get health()      { return snapshotHealth(); },
      get tickets()     { return window.ZVT_TICKETS?.snapshot?.() || null; },
      get ticketObservations() { return window.ZVT_TICKETS?.observations || null; },
      selectors: SELECTORS, prefixes: PREFIXES,
      rescan() {
        sidebarPane = findSidebarPane();
        attachObserver();
        discoverNow();
        return snapshotHealth();
      },
      export() {
        return JSON.stringify({
          profileId: PROFILE_ID,
          generatedAt: new Date().toISOString(),
          ...profile.snapshot(),
          health: snapshotHealth(),
        }, null, 2);
      },
    },
  });
})();
