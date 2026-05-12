/*
 * Zendesk Views Tweaks — content.js
 *
 * Responsibilities:
 *   1. Apply/remove `body.zvt-compact` based on settings.
 *   2. Maintain a single <style id="zvt-hide-rules"> element whose contents
 *      are CSS rules hiding any view IDs in `settings.hiddenViewIds`.
 *      Hiding is CSS-driven; React re-renders cannot defeat it.
 *   3. Discover views from the sidebar nav and persist them to
 *      chrome.storage.local.discoveredViews (merged, deduped, pruned).
 *   4. Re-run discovery on a debounced MutationObserver scoped to the nav.
 *   5. Respond to messages from the options page ("rescan").
 *
 * Selector strategy:
 *   - Identify the views nav by data-test-id, aria-label, or as a fallback
 *     by walking up from any /agent/filters/ anchor on the page.
 *   - Identify the view ID with a strict regex on the URL pathname.
 *
 * Debug entry point: window.__zvt = { nav, discovered, selectors, rescan }.
 */

(() => {
  "use strict";

  const HIDE_STYLE_ID = "zvt-hide-rules";
  const FILTER_RE = /^\/agent\/filters\/(\d+)\/?$/;
  const SIDEBAR_NAV_SELECTORS = [
    '[data-test-id="views_pane"]',
    'nav[aria-label*="iew" i]', // matches "Views" / "View" case-insensitively
    '[data-test-id*="views" i]',
  ];
  const PRUNE_AGE_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

  let settings = {
    enabled: true,
    compact: true,
    hiddenViewIds: [],
  };
  let sidebarNav = null;
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
      const esc = CSS.escape(id);
      const base = `/agent/filters/${esc}`;
      // Hide the row container if present, plus the anchor itself as fallback.
      // Cover trailing-slash and query-string variants so substring matching
      // doesn't accidentally collide with a longer ID that starts with this one.
      const rowSelectors = [
        `[role="listitem"]:has(a[href$="${base}"])`,
        `[role="listitem"]:has(a[href*="${base}?"])`,
        `[role="listitem"]:has(a[href*="${base}/"])`,
        `li:has(a[href$="${base}"])`,
        `li:has(a[href*="${base}?"])`,
        `li:has(a[href*="${base}/"])`,
      ];
      const anchorSelectors = [
        `a[href$="${base}"]`,
        `a[href*="${base}?"]`,
        `a[href*="${base}/"]`,
      ];
      rules.push(
        `${rowSelectors.join(",\n")} { display: none !important; }`,
        `${anchorSelectors.join(",\n")} { display: none !important; }`
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

  function findSidebarNav() {
    for (const sel of SIDEBAR_NAV_SELECTORS) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    // Fallback: walk up from any filter anchor and find the nearest <nav>
    // or [role="navigation"] ancestor.
    const anchor = document.querySelector('a[href*="/agent/filters/"]');
    if (anchor) {
      let node = anchor.parentElement;
      while (node && node !== document.body) {
        if (
          node.tagName === "NAV" ||
          node.getAttribute("role") === "navigation" ||
          node.getAttribute("data-test-id") === "views_pane"
        ) {
          return node;
        }
        node = node.parentElement;
      }
    }
    return null;
  }

  function parseFilterId(href) {
    try {
      const u = new URL(href, window.location.origin);
      const m = u.pathname.match(FILTER_RE);
      return m ? m[1] : null;
    } catch {
      return null;
    }
  }

  function extractTitle(anchor) {
    // Prefer aria-label, fall back to text content (collapsed whitespace),
    // strip trailing count badges (e.g. "Open tickets 42").
    const aria = anchor.getAttribute("aria-label");
    let raw = (aria || anchor.textContent || "").trim().replace(/\s+/g, " ");
    // Drop a trailing standalone number that's almost certainly the count.
    raw = raw.replace(/\s+\d+$/, "").trim();
    return raw || `View ${parseFilterId(anchor.href) || ""}`.trim();
  }

  function discoverNow() {
    const nav = sidebarNav || findSidebarNav();
    if (!nav) return;
    if (nav !== sidebarNav) {
      // Sidebar replaced — reattach observer.
      sidebarNav = nav;
      attachObserver();
    }

    const anchors = nav.querySelectorAll('a[href*="/agent/filters/"]');
    let changed = false;
    const now = Date.now();
    for (const a of anchors) {
      const id = parseFilterId(a.href);
      if (!id) continue;
      const title = extractTitle(a);
      const prev = discovered.get(id);
      if (!prev || prev.title !== title || prev.href !== a.pathname) {
        changed = true;
      }
      discovered.set(id, {
        id,
        title,
        href: a.pathname,
        lastSeenAt: now,
      });
    }

    if (changed || anchors.length > 0) {
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
      const merged = Array.from(byId.values()).sort((a, b) =>
        (a.title || "").localeCompare(b.title || "")
      );
      // Only write if it actually changed to avoid notification churn.
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
    if (!sidebarNav) return;
    observer = new MutationObserver(() => scheduleDiscover());
    observer.observe(sidebarNav, { childList: true, subtree: true });
  }

  function scheduleDiscover() {
    if (pendingRaf) return;
    pendingRaf = requestAnimationFrame(() => {
      pendingRaf = 0;
      // Confirm the nav is still in the DOM; if not, re-find it.
      if (sidebarNav && !document.contains(sidebarNav)) {
        sidebarNav = null;
      }
      discoverNow();
    });
  }

  /* --------------------- mount + late-arrival retries ------------------- */

  function tryMountSidebar(retriesLeft) {
    sidebarNav = findSidebarNav();
    if (sidebarNav) {
      attachObserver();
      discoverNow();
      return;
    }
    if (retriesLeft <= 0) return;
    setTimeout(() => tryMountSidebar(retriesLeft - 1), 1000);
  }

  // Lightweight periodic safety net for SPA re-mounts after the initial
  // retry window: if the sidebar disappears (or never appeared), try to
  // re-find it. One querySelector every 3s when not mounted.
  setInterval(() => {
    if (!sidebarNav || !document.contains(sidebarNav)) {
      const next = findSidebarNav();
      if (next) {
        sidebarNav = next;
        attachObserver();
        discoverNow();
      }
    }
  }, 3000);

  /* --------------------------- message handling ------------------------- */

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "zvt:rescan") {
      sidebarNav = findSidebarNav();
      attachObserver();
      discoverNow();
      sendResponse({ ok: true, navFound: !!sidebarNav });
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
    // First mount: try a few times in case the sidebar mounts late.
    tryMountSidebar(15);
  });

  // Debug surface.
  Object.defineProperty(window, "__zvt", {
    configurable: true,
    value: {
      get nav() {
        return sidebarNav;
      },
      get discovered() {
        return Array.from(discovered.values());
      },
      get settings() {
        return { ...settings };
      },
      selectors: SIDEBAR_NAV_SELECTORS,
      rescan() {
        sidebarNav = findSidebarNav();
        attachObserver();
        discoverNow();
        return { navFound: !!sidebarNav, count: discovered.size };
      },
    },
  });
})();
