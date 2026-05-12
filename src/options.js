/*
 * Zendesk Views Tweaks — options.js  (v0.4.0)
 *
 * Multi-section options page with:
 *   - General toggles (enabled, compact, reorderEnabled)
 *   - Density: per-level + global slider+number paired controls with live preview
 *   - Hide: tree of views and groups with checkboxes
 *   - Reorder: per-container DnD list with up/down arrow buttons
 *   - Backup: export / import / reset, plus diagnostics dump
 *
 * Live preview: on `input` events, debounce ~100ms then send a transient
 * patch to the active Zendesk tab via chrome.tabs.sendMessage. On `change`
 * (commit), persist to chrome.storage.sync.
 *
 * Storage (sync, multi-key): prefs, hide, density, order
 * Storage (local): discoveredViews, discoveredGroups, discoveredContainers,
 *                  selectorHealth, settingsBackupV1
 */

"use strict";

/* ============================== constants ============================== */

const ZENDESK_URL_MATCH = "https://github.zendesk.com/*";
const ZENDESK_URL_OPEN = "https://github.zendesk.com/agent";
const FILTER_RE = /\/agent\/filters\/(\d+)\/?(?:[?#].*)?$/;

const PREVIEW_DEBOUNCE_MS = 100;

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
const DEFAULT_ORDER = {};

// Per-level token spec.
const LEVEL_TOKENS = [
  { key: "fontSize",         label: "Font",       min: 8,  max: 24, step: 1 },
  { key: "lineHeight",       label: "Line height", min: 8,  max: 32, step: 1 },
  { key: "rowPaddingTop",    label: "Pad ↑",      min: 0,  max: 16, step: 1 },
  { key: "rowPaddingBottom", label: "Pad ↓",      min: 0,  max: 16, step: 1 },
  { key: "rowPaddingLeft",   label: "Pad ←",      min: 0,  max: 32, step: 1 },
  { key: "rowPaddingRight",  label: "Pad →",      min: 0,  max: 32, step: 1 },
  { key: "rowMinHeight",     label: "Min height", min: 0,  max: 40, step: 1 },
  { key: "indent",           label: "Indent",     min: 0,  max: 32, step: 1, levelMin: 2 },
];

const GLOBAL_TOKENS = [
  { key: "rowGap",               label: "Row gap",               min: 0,  max: 12, step: 1 },
  { key: "iconSize",             label: "Icon size",             min: 8,  max: 24, step: 1 },
  { key: "countBadgeFontSize",   label: "Badge font",            min: 8,  max: 16, step: 1 },
  { key: "countBadgeLineHeight", label: "Badge line height",     min: 8,  max: 24, step: 1 },
  { key: "countBadgeMargin",     label: "Badge margin-left",     min: 0,  max: 16, step: 1 },
  { key: "countBadgePadding",    label: "Badge padding",         min: 0,  max: 8,  step: 1 },
];

const PRESETS = {
  "ultra-compact": {
    level: {
      "1": { fontSize: 13, rowPaddingTop: 0, rowPaddingBottom: 0, rowPaddingLeft: 4, rowPaddingRight: 4, indent: 0 },
      "2": { fontSize: 12, rowPaddingTop: 0, rowPaddingBottom: 0, rowPaddingLeft: 4, rowPaddingRight: 4, indent: 4 },
      "3": { fontSize: 12, rowPaddingTop: 0, rowPaddingBottom: 0, rowPaddingLeft: 4, rowPaddingRight: 4, indent: 4 },
      "4": { fontSize: 11, rowPaddingTop: 0, rowPaddingBottom: 0, rowPaddingLeft: 4, rowPaddingRight: 4, indent: 4 },
      "5": { fontSize: 11, rowPaddingTop: 0, rowPaddingBottom: 0, rowPaddingLeft: 4, rowPaddingRight: 4, indent: 4 },
    },
    global: { rowGap: 0, iconSize: 12, countBadgeFontSize: 10, countBadgeMargin: 4, countBadgePadding: 0 },
  },
  "compact": {
    level: {
      "1": { fontSize: 14, rowPaddingTop: 1, rowPaddingBottom: 1, rowPaddingLeft: 6, rowPaddingRight: 6, indent: 0 },
      "2": { fontSize: 13, rowPaddingTop: 1, rowPaddingBottom: 1, rowPaddingLeft: 6, rowPaddingRight: 6, indent: 6 },
      "3": { fontSize: 12, rowPaddingTop: 1, rowPaddingBottom: 1, rowPaddingLeft: 6, rowPaddingRight: 6, indent: 6 },
      "4": { fontSize: 12, rowPaddingTop: 1, rowPaddingBottom: 1, rowPaddingLeft: 6, rowPaddingRight: 6, indent: 4 },
      "5": { fontSize: 11, rowPaddingTop: 1, rowPaddingBottom: 1, rowPaddingLeft: 6, rowPaddingRight: 6, indent: 4 },
    },
    global: { rowGap: 1, iconSize: 14, countBadgeFontSize: 11, countBadgeMargin: 6, countBadgePadding: 1 },
  },
  "comfortable": {
    level: {
      "1": { fontSize: 15, rowPaddingTop: 4, rowPaddingBottom: 4, rowPaddingLeft: 10, rowPaddingRight: 10, indent: 0 },
      "2": { fontSize: 14, rowPaddingTop: 3, rowPaddingBottom: 3, rowPaddingLeft: 10, rowPaddingRight: 10, indent: 10 },
      "3": { fontSize: 13, rowPaddingTop: 3, rowPaddingBottom: 3, rowPaddingLeft: 10, rowPaddingRight: 10, indent: 10 },
      "4": { fontSize: 13, rowPaddingTop: 3, rowPaddingBottom: 3, rowPaddingLeft: 10, rowPaddingRight: 10, indent: 8 },
      "5": { fontSize: 12, rowPaddingTop: 3, rowPaddingBottom: 3, rowPaddingLeft: 10, rowPaddingRight: 10, indent: 8 },
    },
    global: { rowGap: 2, iconSize: 16, countBadgeFontSize: 12, countBadgeMargin: 8, countBadgePadding: 2 },
  },
  "zendesk": { level: {}, global: {} }, // clears density overrides
  "clear": { level: {}, global: {} },   // alias
};

/* =============================== state ================================= */

let prefs = { ...DEFAULT_PREFS };
let hide = { ...DEFAULT_HIDE };
let density = JSON.parse(JSON.stringify(DEFAULT_DENSITY));
let order = { ...DEFAULT_ORDER };

let views = [];
let groups = [];
let containers = [];
let health = null;

const expandedPaths = new Set();
let allExpandedHinted = false;

let previewTimer = 0;
let pendingPreviewPatch = null;
let lastReorderContainer = null;

/* =============================== helpers =============================== */

const $ = (id) => document.getElementById(id);
const els = {
  enabled: $("enabled"), compact: $("compact"), reorderEnabled: $("reorderEnabled"),
  schemaVersion: $("schema-version"),
  statusPill: $("status-pill"), openZendesk: $("open-zendesk"), headerSub: $("header-sub"),
  levelGrid: $("level-grid"), globalGrid: $("global-grid"),
  search: $("search"), expandAll: $("expand-all"), collapseAll: $("collapse-all"),
  showAll: $("show-all"), hideAll: $("hide-all"), rescan: $("rescan"),
  hideStatus: $("hide-status"), tree: $("tree"), empty: $("empty"),
  manualForm: $("manual-add-form"), manualInput: $("manual-add-input"),
  manualTitle: $("manual-add-title"), manualStatus: $("manual-add-status"),
  reorderIntro: $("reorder-intro"), reorderDisabled: $("reorder-disabled"),
  reorderControls: $("reorder-controls"),
  reorderContainer: $("reorder-container"), reorderList: $("reorder-list"),
  reorderReset: $("reorder-reset"), reorderResetAll: $("reorder-reset-all"),
  reorderHint: $("reorder-hint"),
  exportBtn: $("export-btn"), importBtn: $("import-btn"), importFile: $("import-file"),
  resetAll: $("reset-all"), backupStatus: $("backup-status"),
  diag: $("diag"), copyDiag: $("copy-diag"),
};

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

function normNum(raw, lo, hi) {
  if (raw === "" || raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? clamp(Math.round(n), lo, hi) : null;
}

function pathKey(path) { return path.join("::"); }
function viewKey(id) { return `v:${id}`; }
function groupKey(path) { return `g:${path}`; }

/* ============================== storage =============================== */

function loadAll() {
  return Promise.all([
    new Promise((r) =>
      chrome.storage.sync.get(
        { prefs: null, hide: null, density: null, order: null },
        (res) => {
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
          r();
        }
      )
    ),
    new Promise((r) =>
      chrome.storage.local.get(
        { discoveredViews: [], discoveredGroups: [], discoveredContainers: [], selectorHealth: null },
        (res) => {
          views = Array.isArray(res.discoveredViews) ? res.discoveredViews : [];
          groups = Array.isArray(res.discoveredGroups) ? res.discoveredGroups : [];
          containers = Array.isArray(res.discoveredContainers) ? res.discoveredContainers : [];
          health = res.selectorHealth || null;
          r();
        }
      )
    ),
  ]);
}

function savePrefs()    { return new Promise((r) => chrome.storage.sync.set({ prefs }, r)); }
function saveHide()     { return new Promise((r) => chrome.storage.sync.set({ hide }, r)); }
function saveDensity()  { return new Promise((r) => chrome.storage.sync.set({ density }, r)); }
function saveOrder()    { return new Promise((r) => chrome.storage.sync.set({ order }, r)); }

/* =========================== live preview ============================= */

function queuePreview(patch) {
  pendingPreviewPatch = mergePatch(pendingPreviewPatch || {}, patch);
  if (previewTimer) return;
  previewTimer = setTimeout(() => {
    previewTimer = 0;
    const p = pendingPreviewPatch;
    pendingPreviewPatch = null;
    sendPreview(p);
  }, PREVIEW_DEBOUNCE_MS);
}

function mergePatch(a, b) {
  const out = { ...a };
  for (const k of Object.keys(b)) {
    const av = out[k];
    const bv = b[k];
    if (av && bv && typeof av === "object" && typeof bv === "object" && !Array.isArray(av) && !Array.isArray(bv)) {
      out[k] = mergePatch(av, bv);
    } else {
      out[k] = bv;
    }
  }
  return out;
}

async function sendPreview(patch) {
  try {
    const tabs = await chrome.tabs.query({ url: ZENDESK_URL_MATCH });
    if (!tabs.length) return;
    // Prefer the active tab in the current window; otherwise first tab.
    const active = tabs.find((t) => t.active) || tabs[0];
    try {
      await chrome.tabs.sendMessage(active.id, { type: "zvt:preview", patch });
    } catch {
      /* tab might not have content script (race); ignore */
    }
  } catch {
    /* ignore */
  }
}

async function sendClearPreview() {
  try {
    const tabs = await chrome.tabs.query({ url: ZENDESK_URL_MATCH });
    for (const t of tabs) {
      try { await chrome.tabs.sendMessage(t.id, { type: "zvt:clearPreview" }); } catch {}
    }
  } catch {}
}

/* ============================ slider control ========================== */

/**
 * Build a paired slider+number row.
 * @param {Object} cfg
 *   {key, label, min, max, step, value, onPreview(value), onCommit(value), onClear()}
 * @returns {HTMLElement}
 */
function buildSliderRow(cfg) {
  const row = document.createElement("div");
  row.className = "slider-row";
  if (cfg.value != null) row.classList.add("set");

  const labelId = `lbl-${cfg.id || cfg.key}-${Math.random().toString(36).slice(2, 7)}`;
  const label = document.createElement("span");
  label.id = labelId;
  label.className = "slider-label";
  label.textContent = cfg.label;

  const range = document.createElement("input");
  range.type = "range";
  range.min = String(cfg.min);
  range.max = String(cfg.max);
  range.step = String(cfg.step || 1);
  range.value = String(cfg.value != null ? cfg.value : (cfg.fallback != null ? cfg.fallback : cfg.min));
  range.setAttribute("aria-labelledby", labelId);
  if (cfg.disabled) range.disabled = true;

  const number = document.createElement("input");
  number.type = "number";
  number.min = String(cfg.min);
  number.max = String(cfg.max);
  number.step = String(cfg.step || 1);
  number.placeholder = "—";
  number.value = cfg.value != null ? String(cfg.value) : "";
  number.setAttribute("aria-labelledby", labelId);
  if (cfg.disabled) number.disabled = true;

  const clearBtn = document.createElement("button");
  clearBtn.type = "button";
  clearBtn.className = "clear-btn";
  clearBtn.textContent = "×";
  clearBtn.title = "Reset to default";
  clearBtn.disabled = cfg.value == null || cfg.disabled;

  // Range drag → preview only.
  range.addEventListener("input", () => {
    number.value = range.value;
    row.classList.add("set");
    clearBtn.disabled = false;
    cfg.onPreview && cfg.onPreview(Number(range.value));
  });
  // Range release → commit.
  range.addEventListener("change", () => {
    cfg.onCommit && cfg.onCommit(Number(range.value));
  });

  // Number input → preview during typing, commit on change.
  number.addEventListener("input", () => {
    const v = normNum(number.value, cfg.min, cfg.max);
    if (v == null) return;
    range.value = String(v);
    row.classList.add("set");
    clearBtn.disabled = false;
    cfg.onPreview && cfg.onPreview(v);
  });
  number.addEventListener("change", () => {
    const raw = number.value.trim();
    if (raw === "") {
      cfg.onClear && cfg.onClear();
      row.classList.remove("set");
      clearBtn.disabled = true;
      return;
    }
    const v = normNum(raw, cfg.min, cfg.max);
    if (v == null) return;
    number.value = String(v);
    range.value = String(v);
    cfg.onCommit && cfg.onCommit(v);
  });

  clearBtn.addEventListener("click", () => {
    number.value = "";
    range.value = String(cfg.fallback != null ? cfg.fallback : cfg.min);
    row.classList.remove("set");
    clearBtn.disabled = true;
    cfg.onClear && cfg.onClear();
  });

  row.appendChild(label);
  row.appendChild(range);
  row.appendChild(number);
  row.appendChild(clearBtn);
  return row;
}

/* ============================= general ================================ */

function bindGeneral() {
  els.enabled.addEventListener("change", async () => {
    prefs.enabled = !!els.enabled.checked;
    await savePrefs();
  });
  els.compact.addEventListener("change", async () => {
    prefs.compact = !!els.compact.checked;
    await savePrefs();
  });
  els.reorderEnabled.addEventListener("change", async () => {
    prefs.reorderEnabled = !!els.reorderEnabled.checked;
    await savePrefs();
    renderReorder();
  });
}

function renderGeneral() {
  els.enabled.checked = !!prefs.enabled;
  els.compact.checked = !!prefs.compact;
  els.reorderEnabled.checked = !!prefs.reorderEnabled;
  els.schemaVersion.textContent = String(prefs.schemaVersion || 2);
}

/* ============================== density =============================== */

function maxDiscoveredDepth() {
  let max = 0;
  for (const v of views) max = Math.max(max, Number(v.depth) || 0);
  for (const g of groups) max = Math.max(max, Number(g.depth) || 0);
  return max;
}

function renderDensity() {
  els.levelGrid.innerHTML = "";
  els.globalGrid.innerHTML = "";

  const detected = maxDiscoveredDepth();
  const showLevels = Math.max(detected + 1, 5);

  for (let depth = 1; depth <= showLevels; depth++) {
    const block = document.createElement("div");
    block.className = "level-block";
    if (depth > detected) block.classList.add("future");

    const head = document.createElement("div");
    head.className = "level-block-head";
    const name = document.createElement("span");
    name.className = "level-name";
    name.textContent = `Level ${depth}`;
    const status = document.createElement("span");
    status.className = "level-status";
    status.textContent = depth > detected ? "(no items at this depth yet)" : countAtDepth(depth);
    head.appendChild(name);
    head.appendChild(status);
    block.appendChild(head);

    const tokens = (density.level && density.level[String(depth)]) || {};
    for (const tk of LEVEL_TOKENS) {
      const disabled = tk.levelMin && depth < tk.levelMin;
      const value = tokens[tk.key];
      const row = buildSliderRow({
        id: `lvl-${depth}-${tk.key}`,
        key: tk.key,
        label: tk.label,
        min: tk.min, max: tk.max, step: tk.step,
        value: typeof value === "number" ? value : null,
        fallback: tk.key === "fontSize" ? 12 : 0,
        disabled,
        onPreview: (v) => {
          queuePreview({ density: { level: { [String(depth)]: { [tk.key]: v } } } });
        },
        onCommit: async (v) => {
          ensureLevel(depth);
          density.level[String(depth)][tk.key] = v;
          await saveDensity();
        },
        onClear: async () => {
          if (density.level[String(depth)]) {
            delete density.level[String(depth)][tk.key];
            if (Object.keys(density.level[String(depth)]).length === 0) {
              delete density.level[String(depth)];
            }
            await saveDensity();
            queuePreview({ density: { level: { [String(depth)]: { [tk.key]: null } } } });
          }
        },
      });
      block.appendChild(row);
    }
    els.levelGrid.appendChild(block);
  }

  for (const tk of GLOBAL_TOKENS) {
    const value = density.global[tk.key];
    const row = buildSliderRow({
      id: `g-${tk.key}`,
      key: tk.key,
      label: tk.label,
      min: tk.min, max: tk.max, step: tk.step,
      value: typeof value === "number" ? value : null,
      onPreview: (v) => {
        queuePreview({ density: { global: { [tk.key]: v } } });
      },
      onCommit: async (v) => {
        density.global[tk.key] = v;
        await saveDensity();
      },
      onClear: async () => {
        density.global[tk.key] = null;
        await saveDensity();
        queuePreview({ density: { global: { [tk.key]: null } } });
      },
    });
    els.globalGrid.appendChild(row);
  }
}

function ensureLevel(depth) {
  density.level = density.level || {};
  density.level[String(depth)] = density.level[String(depth)] || {};
}

function countAtDepth(depth) {
  let v = 0, g = 0;
  for (const view of views) if (Number(view.depth) === depth) v++;
  for (const grp of groups) if (Number(grp.depth) === depth) g++;
  return `${v} view${v === 1 ? "" : "s"}, ${g} group${g === 1 ? "" : "s"}`;
}

async function applyPreset(name) {
  if (name === "clear" || name === "zendesk") {
    if (!confirm("Clear all density customizations?")) return;
    density = JSON.parse(JSON.stringify(DEFAULT_DENSITY));
  } else {
    const preset = PRESETS[name];
    if (!preset) return;
    density = {
      level: JSON.parse(JSON.stringify(preset.level)),
      global: { ...DEFAULT_DENSITY.global, ...preset.global },
    };
  }
  await saveDensity();
  renderDensity();
}

function bindDensity() {
  document.querySelectorAll('.presets button[data-preset]').forEach((btn) => {
    btn.addEventListener("click", () => applyPreset(btn.dataset.preset));
  });
}

/* =============================== hide ================================== */

function isViewHidden(id) { return hide.v.includes(String(id)); }
function isGroupHidden(path) { return hide.g.includes(path); }

function setViewHidden(id, hidden) {
  const sid = String(id);
  const set = new Set(hide.v.map(String));
  if (hidden) set.add(sid); else set.delete(sid);
  hide.v = Array.from(set).sort();
}
function setGroupHidden(path, hidden) {
  const set = new Set(hide.g);
  if (hidden) set.add(path); else set.delete(path);
  hide.g = Array.from(set).sort();
}

function buildHideTree(filteredViews, allGroups) {
  const root = { name: "", path: [], children: new Map(), views: [] };
  function ensureGroup(seg) {
    let n = root;
    for (const s of seg) {
      if (!n.children.has(s)) {
        n.children.set(s, { name: s, path: [...n.path, s], children: new Map(), views: [] });
      }
      n = n.children.get(s);
    }
    return n;
  }
  for (const g of allGroups) {
    if (!g || !g.path) continue;
    ensureGroup(g.path.split("::").filter(Boolean));
  }
  for (const v of filteredViews) {
    const node = ensureGroup(Array.isArray(v.groupPath) ? v.groupPath : []);
    node.views.push(v);
  }
  return root;
}

function nodeStats(node) {
  let total = node.views.length;
  let h = node.views.filter((v) => isViewHidden(v.id)).length;
  for (const c of node.children.values()) {
    const s = nodeStats(c);
    total += s.total;
    h += s.hidden;
  }
  return { total, hidden: h, visible: total - h };
}

function collectLeafIds(node) {
  const ids = node.views.map((v) => String(v.id));
  for (const c of node.children.values()) ids.push(...collectLeafIds(c));
  return ids;
}

function matchesQuery(v, q) {
  if (!q) return true;
  if ((v.title || "").toLowerCase().includes(q)) return true;
  if (String(v.id).includes(q)) return true;
  return (v.groupPath || []).join(" / ").toLowerCase().includes(q);
}

function sortChildren(map) { return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name)); }
function sortViews(arr) { return arr.slice().sort((a, b) => (a.title || "").localeCompare(b.title || "")); }

function renderHide() {
  const q = (els.search.value || "").trim().toLowerCase();
  const filtered = views.filter((v) => matchesQuery(v, q));
  els.tree.innerHTML = "";

  if (views.length === 0 && groups.length === 0) {
    els.tree.hidden = true;
    els.empty.hidden = false;
    els.hideStatus.textContent = "0 views, 0 groups discovered.";
    return;
  }
  els.empty.hidden = true;

  const root = buildHideTree(filtered, groups);
  if (!root.views.length && root.children.size === 0) {
    els.tree.hidden = true;
    els.hideStatus.textContent = q ? "No matches." : "0 items.";
    return;
  }
  els.tree.hidden = false;
  els.hideStatus.textContent =
    `${views.length} view${views.length === 1 ? "" : "s"}, ` +
    `${groups.length} group${groups.length === 1 ? "" : "s"}. ` +
    `${hide.v.length} view${hide.v.length === 1 ? "" : "s"} hidden, ` +
    `${hide.g.length} group${hide.g.length === 1 ? "" : "s"} hidden.` +
    (q ? ` Showing ${filtered.length}.` : "");

  const frag = document.createDocumentFragment();
  if (root.views.length) {
    const ul = document.createElement("ul");
    ul.className = "tree-leaf-list";
    for (const v of sortViews(root.views)) ul.appendChild(renderHideLeaf(v));
    frag.appendChild(ul);
  }
  for (const child of sortChildren(root.children)) frag.appendChild(renderHideGroup(child, q.length > 0));
  els.tree.appendChild(frag);
}

function renderHideGroup(node, hasQuery) {
  const stats = nodeStats(node);
  const groupPathStr = pathKey(node.path);
  const groupHidden = isGroupHidden(groupPathStr);

  const details = document.createElement("details");
  details.className = "group";
  if (groupHidden) details.classList.add("group-hidden");
  const open = hasQuery || expandedPaths.has(groupPathStr) || !allExpandedHinted;
  if (open) details.open = true;
  details.dataset.path = groupPathStr;
  details.addEventListener("toggle", () => {
    if (details.open) expandedPaths.add(groupPathStr); else expandedPaths.delete(groupPathStr);
  });

  const summary = document.createElement("summary");
  const visCb = document.createElement("input");
  visCb.type = "checkbox";
  visCb.checked = !groupHidden;
  visCb.addEventListener("click", (e) => e.stopPropagation());
  visCb.addEventListener("change", async () => {
    setGroupHidden(groupPathStr, !visCb.checked);
    await saveHide();
    renderHide();
  });
  const name = document.createElement("span");
  name.className = "group-name";
  name.textContent = node.name + (groupHidden ? " (hidden)" : "");
  const counts = document.createElement("span");
  counts.className = "group-counts";
  if (stats.total > 0) {
    counts.textContent = stats.hidden > 0 ? `${stats.visible}/${stats.total}` : `${stats.total}`;
    if (stats.hidden > 0 && stats.visible === 0) counts.classList.add("all-hidden");
  } else {
    counts.textContent = "(empty)";
    counts.classList.add("empty-group");
  }
  const bulk = document.createElement("button");
  bulk.type = "button";
  bulk.className = "group-bulk";
  bulk.textContent = stats.hidden < stats.total ? "Hide leaves" : "Show leaves";
  bulk.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const ids = collectLeafIds(node);
    const target = !(stats.hidden < stats.total);
    const set = new Set(hide.v.map(String));
    for (const id of ids) if (target) set.delete(id); else set.add(id);
    hide.v = Array.from(set).sort();
    await saveHide();
    renderHide();
  });
  summary.appendChild(visCb); summary.appendChild(name); summary.appendChild(counts);
  if (stats.total > 0) summary.appendChild(bulk);
  details.appendChild(summary);

  const body = document.createElement("div");
  body.className = "group-body";
  for (const c of sortChildren(node.children)) body.appendChild(renderHideGroup(c, hasQuery));
  if (node.views.length) {
    const ul = document.createElement("ul");
    ul.className = "tree-leaf-list";
    for (const v of sortViews(node.views)) ul.appendChild(renderHideLeaf(v));
    body.appendChild(ul);
  }
  details.appendChild(body);
  return details;
}

function renderHideLeaf(v) {
  const li = document.createElement("li");
  const hidden = isViewHidden(v.id);
  if (hidden) li.classList.add("hidden-row");
  const label = document.createElement("label");
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = !hidden;
  cb.dataset.id = v.id;
  cb.addEventListener("change", async () => {
    setViewHidden(v.id, !cb.checked);
    await saveHide();
    renderHide();
  });
  const title = document.createElement("span");
  title.className = "title";
  title.textContent = v.title || `View ${v.id}`;
  const id = document.createElement("span");
  id.className = "id";
  id.textContent = v.id;
  label.appendChild(cb); label.appendChild(title); label.appendChild(id);
  li.appendChild(label);
  return li;
}

function bindHide() {
  els.search.addEventListener("input", renderHide);
  els.expandAll.addEventListener("click", () => setAllExpanded(true));
  els.collapseAll.addEventListener("click", () => setAllExpanded(false));
  els.showAll.addEventListener("click", async () => {
    const q = (els.search.value || "").trim().toLowerCase();
    const targetViews = views.filter((v) => matchesQuery(v, q));
    const set = new Set(hide.v.map(String));
    for (const v of targetViews) set.delete(String(v.id));
    hide.v = Array.from(set).sort();
    hide.g = [];
    await saveHide();
    renderHide();
  });
  els.hideAll.addEventListener("click", async () => {
    const q = (els.search.value || "").trim().toLowerCase();
    const target = views.filter((v) => matchesQuery(v, q));
    const set = new Set(hide.v.map(String));
    for (const v of target) set.add(String(v.id));
    hide.v = Array.from(set).sort();
    await saveHide();
    renderHide();
  });
  els.rescan.addEventListener("click", onRescan);
  els.manualForm.addEventListener("submit", onManualAdd);
}

function setAllExpanded(open) {
  allExpandedHinted = true;
  expandedPaths.clear();
  if (open) {
    const root = buildHideTree(views, groups);
    const stack = Array.from(root.children.values());
    while (stack.length) {
      const n = stack.pop();
      expandedPaths.add(pathKey(n.path));
      stack.push(...n.children.values());
    }
  }
  renderHide();
}

async function onRescan() {
  els.hideStatus.textContent = "Looking for an open Zendesk tab…";
  const tabs = await chrome.tabs.query({ url: ZENDESK_URL_MATCH });
  if (!tabs.length) {
    els.hideStatus.textContent = "No open Zendesk tab. [Open Zendesk] button at the top.";
    return;
  }
  let ok = 0;
  for (const t of tabs) {
    try {
      const res = await chrome.tabs.sendMessage(t.id, { type: "zvt:rescan" });
      if (res && res.ok) ok++;
    } catch {}
  }
  if (ok === 0) {
    els.hideStatus.textContent = "Found Zendesk tab(s) but couldn't reach the content script. Reload the Zendesk tab.";
    return;
  }
  setTimeout(async () => {
    await loadAll();
    renderAll();
    els.hideStatus.textContent = `Refreshed from ${ok} tab${ok === 1 ? "" : "s"}.`;
  }, 400);
}

function parseManualEntry(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return s;
  const m = s.match(FILTER_RE);
  return m ? m[1] : null;
}

async function onManualAdd(e) {
  e.preventDefault();
  const id = parseManualEntry(els.manualInput.value);
  if (!id) {
    els.manualStatus.textContent = "Couldn't parse a view ID. Paste a URL like /agent/filters/123… or just a numeric ID.";
    return;
  }
  const title = (els.manualTitle.value || "").trim() || `View ${id}`;
  const href = `/agent/filters/${id}`;
  if (!views.find((v) => String(v.id) === id)) {
    views.push({ id, title, href, groupPath: ["Manually added"], depth: 2, lastSeenAt: Date.now(), manual: true });
    await new Promise((r) => chrome.storage.local.set({ discoveredViews: views }, r));
  }
  setViewHidden(id, true);
  await saveHide();
  els.manualInput.value = "";
  els.manualTitle.value = "";
  els.manualStatus.textContent = `Added view ${id} to hidden list.`;
  renderHide();
}

/* =============================== reorder =============================== */

function getEffectiveOrder(scopeKey) {
  const explicit = Array.isArray(order[scopeKey]) ? order[scopeKey].slice() : [];
  // Build the full list of items in this container from discovery.
  let domItems;
  if (scopeKey === "ROOT") {
    // Top-level groups (depth 1).
    domItems = groups
      .filter((g) => Number(g.depth) === 1)
      .map((g) => groupKey(g.path));
  } else if (scopeKey.startsWith("g:")) {
    const parentPath = scopeKey.slice(2);
    // Direct children: groups whose path starts with parentPath:: AND has exactly one extra segment;
    // views whose groupPath joined by :: equals parentPath.
    const childGroups = groups
      .filter((g) => g.path.startsWith(parentPath + "::"))
      .filter((g) => g.path.split("::").length === parentPath.split("::").length + 1)
      .map((g) => groupKey(g.path));
    const childViews = views
      .filter((v) => Array.isArray(v.groupPath) && v.groupPath.join("::") === parentPath)
      .map((v) => viewKey(v.id));
    domItems = [...childGroups, ...childViews];
  } else {
    domItems = [];
  }

  // Effective: explicit items first (in user order), then DOM items not in explicit (in DOM order).
  const explicitSet = new Set(explicit);
  const remainder = domItems.filter((k) => !explicitSet.has(k));
  // Drop explicit items that no longer exist in DOM (orphans).
  const domSet = new Set(domItems);
  const cleanedExplicit = explicit.filter((k) => domSet.has(k));
  return { effective: [...cleanedExplicit, ...remainder], explicit: cleanedExplicit, remainder };
}

function itemDescriptor(itemKey) {
  if (itemKey.startsWith("v:")) {
    const id = itemKey.slice(2);
    const v = views.find((x) => String(x.id) === id);
    return { type: "view", name: (v && v.title) || `View ${id}`, key: itemKey, id };
  }
  if (itemKey.startsWith("g:")) {
    const path = itemKey.slice(2);
    const g = groups.find((x) => x.path === path);
    const segments = path.split("::");
    return { type: "group", name: (g && g.name) || segments[segments.length - 1] || path, key: itemKey, path };
  }
  return { type: "unknown", name: itemKey, key: itemKey };
}

function renderReorder() {
  // Show/hide based on prefs.reorderEnabled.
  if (!prefs.reorderEnabled) {
    els.reorderDisabled.hidden = false;
    els.reorderControls.style.display = "none";
    return;
  }
  els.reorderDisabled.hidden = true;
  els.reorderControls.style.display = "";

  // Populate container dropdown.
  const containerKeys = ["ROOT", ...groups.filter((g) => containerExistsForGroup(g.path)).map((g) => groupKey(g.path))];
  els.reorderContainer.innerHTML = "";
  for (const key of containerKeys) {
    const opt = document.createElement("option");
    opt.value = key;
    if (key === "ROOT") {
      opt.textContent = "Top level (root)";
    } else {
      const path = key.slice(2);
      const segments = path.split("::");
      opt.textContent = "  ".repeat(segments.length - 1) + segments[segments.length - 1] + `   (${path})`;
    }
    els.reorderContainer.appendChild(opt);
  }
  if (lastReorderContainer && containerKeys.includes(lastReorderContainer)) {
    els.reorderContainer.value = lastReorderContainer;
  } else {
    els.reorderContainer.value = "ROOT";
    lastReorderContainer = "ROOT";
  }

  renderReorderList();
}

function containerExistsForGroup(path) {
  // We only show groups that have at least one child (view or sub-group).
  const hasChildView = views.some((v) => Array.isArray(v.groupPath) && v.groupPath.join("::") === path);
  const hasChildGroup = groups.some((g) =>
    g.path.startsWith(path + "::") && g.path.split("::").length === path.split("::").length + 1
  );
  return hasChildView || hasChildGroup;
}

function renderReorderList() {
  const scope = els.reorderContainer.value;
  lastReorderContainer = scope;
  const { effective, explicit } = getEffectiveOrder(scope);
  els.reorderList.innerHTML = "";

  if (!effective.length) {
    const li = document.createElement("li");
    li.textContent = "No items in this container.";
    li.style.color = "var(--muted)";
    els.reorderList.appendChild(li);
    els.reorderHint.textContent = "";
    return;
  }

  effective.forEach((itemKey, idx) => {
    const desc = itemDescriptor(itemKey);
    const li = document.createElement("li");
    li.dataset.key = itemKey;
    li.draggable = true;

    const handle = document.createElement("span");
    handle.className = "handle";
    handle.textContent = "⋮⋮";
    handle.title = "Drag to reorder";

    const icon = document.createElement("span");
    icon.className = "item-icon";
    icon.textContent = desc.type === "group" ? "📁" : "📄";

    const name = document.createElement("span");
    name.className = "item-name";
    name.textContent = desc.name;

    const keyEl = document.createElement("span");
    keyEl.className = "item-key";
    keyEl.textContent = desc.key;

    const arrows = document.createElement("span");
    arrows.className = "arrow-btns";
    const up = document.createElement("button");
    up.type = "button";
    up.className = "arrow-btn";
    up.textContent = "↑";
    up.title = "Move up";
    up.disabled = idx === 0;
    up.addEventListener("click", () => moveReorderItem(scope, itemKey, idx, idx - 1));
    const down = document.createElement("button");
    down.type = "button";
    down.className = "arrow-btn";
    down.textContent = "↓";
    down.title = "Move down";
    down.disabled = idx === effective.length - 1;
    down.addEventListener("click", () => moveReorderItem(scope, itemKey, idx, idx + 1));
    arrows.appendChild(up); arrows.appendChild(down);

    li.appendChild(handle);
    li.appendChild(icon);
    li.appendChild(name);
    li.appendChild(keyEl);
    if (explicit.includes(itemKey)) {
      const pinned = document.createElement("span");
      pinned.className = "item-pinned";
      pinned.textContent = "pinned";
      li.appendChild(pinned);
    }
    li.appendChild(arrows);

    li.addEventListener("dragstart", onDragStart);
    li.addEventListener("dragend", onDragEnd);
    li.addEventListener("dragover", onDragOver);
    li.addEventListener("dragleave", onDragLeave);
    li.addEventListener("drop", onDrop);

    els.reorderList.appendChild(li);
  });

  const explicitCount = explicit.length;
  els.reorderHint.textContent =
    explicitCount === 0
      ? `${effective.length} items, all in Zendesk's intrinsic order.`
      : `${explicitCount} pinned in custom order; ${effective.length - explicitCount} in Zendesk's intrinsic order.`;
}

async function moveReorderItem(scope, itemKey, fromIdx, toIdx) {
  const { effective } = getEffectiveOrder(scope);
  if (toIdx < 0 || toIdx >= effective.length) return;
  const arr = effective.slice();
  arr.splice(fromIdx, 1);
  arr.splice(toIdx, 0, itemKey);
  // Persist the full effective order so that "moving" an unpinned item
  // promotes the items above it to the explicit list as well — matches user expectation.
  // We trim trailing items that are still in their natural Zendesk order.
  order[scope] = trimTrailingNatural(arr, scope);
  await saveOrder();
  // Send commit-only preview (since this isn't a slider drag).
  queuePreview({ order: { [scope]: order[scope] } });
  renderReorderList();
}

function trimTrailingNatural(arr, scope) {
  const { remainder: dom } = (() => {
    // Recompute DOM-only remainder from scratch.
    let domItems;
    if (scope === "ROOT") {
      domItems = groups.filter((g) => Number(g.depth) === 1).map((g) => groupKey(g.path));
    } else if (scope.startsWith("g:")) {
      const parentPath = scope.slice(2);
      const cg = groups
        .filter((g) => g.path.startsWith(parentPath + "::"))
        .filter((g) => g.path.split("::").length === parentPath.split("::").length + 1)
        .map((g) => groupKey(g.path));
      const cv = views
        .filter((v) => Array.isArray(v.groupPath) && v.groupPath.join("::") === parentPath)
        .map((v) => viewKey(v.id));
      domItems = [...cg, ...cv];
    } else {
      domItems = [];
    }
    return { remainder: domItems };
  })();
  // From the end, drop items that match the natural DOM order tail.
  let cut = arr.length;
  let domIdx = dom.length - 1;
  for (let i = arr.length - 1; i >= 0; i--) {
    if (domIdx < 0) break;
    if (arr[i] === dom[domIdx]) { cut = i; domIdx--; }
    else break;
  }
  return arr.slice(0, cut);
}

let dragSourceKey = null;

function onDragStart(e) {
  dragSourceKey = e.currentTarget.dataset.key;
  e.currentTarget.classList.add("dragging");
  e.dataTransfer.effectAllowed = "move";
  try { e.dataTransfer.setData("text/plain", dragSourceKey); } catch {}
}

function onDragEnd(e) {
  e.currentTarget.classList.remove("dragging");
  document.querySelectorAll(".reorder-list li.drag-over-top, .reorder-list li.drag-over-bottom")
    .forEach((el) => el.classList.remove("drag-over-top", "drag-over-bottom"));
  dragSourceKey = null;
}

function onDragOver(e) {
  if (!dragSourceKey) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "move";
  const target = e.currentTarget;
  if (target.dataset.key === dragSourceKey) return;
  const rect = target.getBoundingClientRect();
  const isTop = (e.clientY - rect.top) < rect.height / 2;
  target.classList.toggle("drag-over-top", isTop);
  target.classList.toggle("drag-over-bottom", !isTop);
}

function onDragLeave(e) {
  e.currentTarget.classList.remove("drag-over-top", "drag-over-bottom");
}

async function onDrop(e) {
  e.preventDefault();
  if (!dragSourceKey) return;
  const target = e.currentTarget;
  const targetKey = target.dataset.key;
  if (targetKey === dragSourceKey) return;
  const isTop = target.classList.contains("drag-over-top");

  const scope = els.reorderContainer.value;
  const { effective } = getEffectiveOrder(scope);
  const fromIdx = effective.indexOf(dragSourceKey);
  let toIdx = effective.indexOf(targetKey);
  if (fromIdx < 0 || toIdx < 0) return;
  const arr = effective.slice();
  arr.splice(fromIdx, 1);
  if (fromIdx < toIdx && isTop) toIdx -= 1;
  if (fromIdx > toIdx && !isTop) toIdx += 1;
  arr.splice(toIdx, 0, dragSourceKey);
  order[scope] = trimTrailingNatural(arr, scope);
  await saveOrder();
  queuePreview({ order: { [scope]: order[scope] } });
  renderReorderList();
}

function bindReorder() {
  els.reorderContainer.addEventListener("change", renderReorderList);
  els.reorderReset.addEventListener("click", async () => {
    const scope = els.reorderContainer.value;
    if (!confirm(`Reset custom order for ${scope}?`)) return;
    delete order[scope];
    await saveOrder();
    queuePreview({ order: { [scope]: [] } });
    renderReorderList();
  });
  els.reorderResetAll.addEventListener("click", async () => {
    if (!confirm("Reset ALL custom orderings?")) return;
    order = {};
    await saveOrder();
    sendClearPreview();
    renderReorderList();
  });
}

/* =============================== backup ============================== */

function bindBackup() {
  els.exportBtn.addEventListener("click", onExport);
  els.importBtn.addEventListener("click", () => els.importFile.click());
  els.importFile.addEventListener("change", onImportFile);
  els.resetAll.addEventListener("click", onResetAll);
  els.copyDiag.addEventListener("click", () => {
    navigator.clipboard.writeText(els.diag.textContent).then(
      () => { els.backupStatus.textContent = "Diagnostics copied to clipboard."; },
      () => { els.backupStatus.textContent = "Couldn't copy."; }
    );
  });
}

function buildExportPayload() {
  return {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    prefs, hide, density, order,
  };
}

function onExport() {
  const payload = buildExportPayload();
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `zendesk-views-tweaks-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  els.backupStatus.textContent = "Exported.";
}

async function onImportFile() {
  const file = els.importFile.files && els.importFile.files[0];
  if (!file) return;
  els.importFile.value = "";
  const text = await file.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch (e) {
    els.backupStatus.textContent = "Invalid JSON.";
    return;
  }
  if (!parsed || typeof parsed !== "object") {
    els.backupStatus.textContent = "Invalid payload.";
    return;
  }
  if (!confirm("Replace current settings with imported file?")) return;
  // Validate + clamp.
  if (parsed.prefs) prefs = { ...DEFAULT_PREFS, ...parsed.prefs };
  if (parsed.hide && typeof parsed.hide === "object") {
    hide = {
      v: Array.isArray(parsed.hide.v) ? parsed.hide.v.map(String) : [],
      g: Array.isArray(parsed.hide.g) ? parsed.hide.g.map(String) : [],
    };
  }
  if (parsed.density && typeof parsed.density === "object") {
    density = {
      level: parsed.density.level && typeof parsed.density.level === "object" ? parsed.density.level : {},
      global: { ...DEFAULT_DENSITY.global, ...(parsed.density.global || {}) },
    };
  }
  if (parsed.order && typeof parsed.order === "object") order = parsed.order;
  await Promise.all([savePrefs(), saveHide(), saveDensity(), saveOrder()]);
  els.backupStatus.textContent = "Imported.";
  renderAll();
}

async function onResetAll() {
  if (!confirm("Reset ALL settings to defaults? This cannot be undone (but a v0.3 backup is kept in local storage if present).")) return;
  prefs = { ...DEFAULT_PREFS };
  hide = { ...DEFAULT_HIDE };
  density = JSON.parse(JSON.stringify(DEFAULT_DENSITY));
  order = { ...DEFAULT_ORDER };
  await Promise.all([savePrefs(), saveHide(), saveDensity(), saveOrder()]);
  sendClearPreview();
  els.backupStatus.textContent = "Reset.";
  renderAll();
}

function renderDiag() {
  const diag = {
    schemaVersion: prefs.schemaVersion,
    counts: { views: views.length, groups: groups.length, containers: containers.length },
    hidden: { views: hide.v.length, groups: hide.g.length },
    density: { levelKeys: Object.keys(density.level || {}), globalSet: Object.entries(density.global || {}).filter(([_, v]) => v != null).map(([k]) => k) },
    orderScopes: Object.keys(order || {}),
    health,
  };
  els.diag.textContent = JSON.stringify(diag, null, 2);
}

/* =============================== status =============================== */

async function refreshStatus() {
  let tabCount = 0;
  try {
    const tabs = await chrome.tabs.query({ url: ZENDESK_URL_MATCH });
    tabCount = tabs.length;
  } catch {}
  if (tabCount === 0) {
    els.statusPill.className = "pill warn";
    els.statusPill.textContent = "⚠ No Zendesk tab open";
  } else if (!health || !health.paneFound) {
    els.statusPill.className = "pill warn";
    els.statusPill.textContent = `${tabCount} tab(s) — sidebar not detected`;
  } else if (health.paneViaShape) {
    els.statusPill.className = "pill warn";
    els.statusPill.textContent = `${tabCount} tab(s) · using fallback selector`;
  } else {
    els.statusPill.className = "pill ok";
    els.statusPill.textContent = `✓ Live preview · ${tabCount} tab(s)`;
  }
}

/* =============================== sections ============================= */

function bindSections() {
  document.querySelectorAll(".card-toggle").forEach((btn) => {
    btn.addEventListener("click", () => {
      const card = btn.closest(".card");
      const body = card.querySelector(".card-body");
      const expanded = btn.getAttribute("aria-expanded") === "true";
      btn.setAttribute("aria-expanded", String(!expanded));
      btn.querySelector(".caret").textContent = expanded ? "▶" : "▼";
      body.hidden = expanded;
    });
  });
}

/* =============================== boot ================================= */

function renderAll() {
  renderGeneral();
  renderDensity();
  renderHide();
  renderReorder();
  renderDiag();
  refreshStatus();
}

function bindAll() {
  bindSections();
  bindGeneral();
  bindDensity();
  bindHide();
  bindReorder();
  bindBackup();
  els.openZendesk.addEventListener("click", () => {
    chrome.tabs.create({ url: ZENDESK_URL_OPEN });
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync") {
      let touched = false;
      if (changes.prefs)   { prefs = { ...DEFAULT_PREFS, ...(changes.prefs.newValue || {}) }; touched = true; }
      if (changes.hide)    { const h = changes.hide.newValue || {}; hide = { v: Array.isArray(h.v) ? h.v.map(String) : [], g: Array.isArray(h.g) ? h.g.map(String) : [] }; touched = true; }
      if (changes.density) { const d = changes.density.newValue || {}; density = { level: d.level || {}, global: { ...DEFAULT_DENSITY.global, ...(d.global || {}) } }; touched = true; }
      if (changes.order)   { order = changes.order.newValue || {}; touched = true; }
      if (touched) renderAll();
    }
    if (area === "local") {
      let touched = false;
      if (changes.discoveredViews)      { views = Array.isArray(changes.discoveredViews.newValue) ? changes.discoveredViews.newValue : []; touched = true; }
      if (changes.discoveredGroups)     { groups = Array.isArray(changes.discoveredGroups.newValue) ? changes.discoveredGroups.newValue : []; touched = true; }
      if (changes.discoveredContainers) { containers = Array.isArray(changes.discoveredContainers.newValue) ? changes.discoveredContainers.newValue : []; touched = true; }
      if (changes.selectorHealth)       { health = changes.selectorHealth.newValue || null; touched = true; }
      if (touched) renderAll();
    }
  });

  // Refresh status every 5s in case tabs open/close.
  setInterval(refreshStatus, 5000);
}

(async function init() {
  await loadAll();
  bindAll();
  renderAll();
})();
