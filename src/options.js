/*
 * Zendesk Views Tweaks — options.js  (v0.6.0)
 *
 * Multi-section options page driven by ZVT.ProfileStore.
 *
 * Sections: General · Density · Theme · Hide · Customize views · Reorder · Templates · Backup
 * Top bar: profile switcher · health pill · Open Zendesk
 *
 * Live preview pipeline: paired sliders/color-pickers/inputs send debounced
 * `zvt:preview` patches via chrome.tabs.sendMessage to tabs whose host
 * matches the editing profile. Persisted on `change` (slider release / blur).
 */

"use strict";

const {
  ProfileStore, RESERVED_PROFILE_ID, SECTION_NAMES, SECTION_STRATEGY,
  LEVEL_TOKEN_RANGES, GLOBAL_TOKEN_RANGES,
  INTRINSIC_LEVEL, INTRINSIC_GLOBAL,
  DEFAULT_PREFS, DEFAULT_HIDE, DEFAULT_DENSITY, DEFAULT_ORDER, DEFAULT_THEME,
  RE, viewKey, groupKey, deepMerge,
  loadProfileIndex, ensureProfileExists, deleteProfile,
} = window.ZVT;

/* ============================== constants ============================ */

const ZENDESK_URL_MATCH = "https://*.zendesk.com/*";
const PREVIEW_DEBOUNCE_MS = 100;
const STATUS_REFRESH_MS = 5000;

const LEVEL_TOKENS = [
  { key: "fontSize",         label: "Font",        ...LEVEL_TOKEN_RANGES.fontSize,         step: 1 },
  { key: "lineHeight",       label: "Line height", ...LEVEL_TOKEN_RANGES.lineHeight,       step: 1 },
  { key: "rowPaddingTop",    label: "Pad ↑",       ...LEVEL_TOKEN_RANGES.rowPaddingTop,    step: 1 },
  { key: "rowPaddingBottom", label: "Pad ↓",       ...LEVEL_TOKEN_RANGES.rowPaddingBottom, step: 1 },
  { key: "rowPaddingLeft",   label: "Pad ←",       ...LEVEL_TOKEN_RANGES.rowPaddingLeft,   step: 1 },
  { key: "rowPaddingRight",  label: "Pad →",       ...LEVEL_TOKEN_RANGES.rowPaddingRight,  step: 1 },
  { key: "rowMinHeight",     label: "Min height",  ...LEVEL_TOKEN_RANGES.rowMinHeight,     step: 1 },
  { key: "indent",           label: "Indent",      ...LEVEL_TOKEN_RANGES.indent,           step: 1, levelMin: 2 },
];

const GLOBAL_TOKENS = [
  { key: "rowGap",               label: "Row gap",           ...GLOBAL_TOKEN_RANGES.rowGap,               step: 1 },
  { key: "iconSize",             label: "Icon size",         ...GLOBAL_TOKEN_RANGES.iconSize,             step: 1 },
  { key: "countBadgeFontSize",   label: "Badge font",        ...GLOBAL_TOKEN_RANGES.countBadgeFontSize,   step: 1 },
  { key: "countBadgeLineHeight", label: "Badge line height", ...GLOBAL_TOKEN_RANGES.countBadgeLineHeight, step: 1 },
  { key: "countBadgeMargin",     label: "Badge margin-left", ...GLOBAL_TOKEN_RANGES.countBadgeMargin,     step: 1 },
  { key: "countBadgePadding",    label: "Badge padding",     ...GLOBAL_TOKEN_RANGES.countBadgePadding,    step: 1 },
];

const PALETTE_TOKENS = [
  { key: "bg",           label: "Background" },
  { key: "fg",           label: "Foreground (text)" },
  { key: "hover",        label: "Hover background" },
  { key: "selected",     label: "Selected background" },
  { key: "accent",       label: "Selected text accent" },
  { key: "danger",       label: "Danger" },
  { key: "badgeBg",      label: "Count badge bg" },
  { key: "badgeFg",      label: "Count badge text" },
  { key: "focusRing",    label: "Focus ring" },
  { key: "activeStripe", label: "Active row stripe" },
];

const THEME_LEVEL_TOKENS = [
  { key: "bgColor", label: "Background" },
  { key: "fgColor", label: "Text color" },
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
  "zendesk": { level: {}, global: {} },
  "clear":   { level: {}, global: {} },
};

const BUILTIN_TEMPLATES = [
  {
    id: "builtin-compact",
    name: "Compact",
    description: "Dense single-line rows with minimal padding.",
    includes: ["density"],
    payload: { density: PRESETS.compact },
  },
  {
    id: "builtin-comfortable",
    name: "Comfortable",
    description: "Generous spacing for readability.",
    includes: ["density"],
    payload: { density: PRESETS.comfortable },
  },
  {
    id: "builtin-dark-accent",
    name: "Dark accent",
    description: "Comfortable density + a colorful accent palette (works best with dark Zendesk themes).",
    includes: ["density", "theme"],
    payload: {
      density: PRESETS.comfortable,
      theme: {
        palette: {
          accent: "#6ea8ff",
          activeStripe: "#6ea8ff",
          focusRing: "#6ea8ff",
          hover: "rgba(110,168,255,0.12)",
          selected: "rgba(110,168,255,0.20)",
          badgeBg: "#21262d",
          badgeFg: "#9da7b3",
        },
        level: {},
      },
    },
  },
];

/* =============================== state =============================== */

let editingProfileId = RESERVED_PROFILE_ID;
let store = null;
let allProfiles = [RESERVED_PROFILE_ID];
let views = [];
let groups = [];
let containers = [];
let healthByProfile = {};
let userTemplates = [];

const expandedHidePaths = new Set();
let allHideExpandedHinted = false;
let lastReorderContainer = null;
let expandedCustomViewId = null;

let previewTimer = 0;
let pendingPreviewPatch = null;

// Local-write "color-commit" suppression. The ONLY case we need to suppress
// the storage-echo re-render is right after a color-picker commit: the
// native <input type="color"> dropdown (on macOS especially) can stay open
// across `change` events, and rebuilding the input destroys the dropdown.
//
// Pure timestamp-based suppression (v0.6.1) was too broad — it swallowed
// echoes from cross-section writes (toggling reorderEnabled), drag-drops on
// the reorder list, manual hide checkboxes, etc.
//
// New design: one-shot **pending echo counter** per section. A color-picker
// commit increments the counter for its section before writing. The next
// matching storage echo decrements and skips re-render exactly once. A
// short TTL clears stale tokens if no echo arrives. No section-wide blanket;
// only the specific commit that needs protection consumes a token.
const PENDING_ECHO_TTL_MS = 1500;
const pendingColorEchoes = new Map(); // section -> { count, expiresAt }

function pushPendingColorEcho(section) {
  const now = Date.now();
  const cur = pendingColorEchoes.get(section) || { count: 0, expiresAt: 0 };
  pendingColorEchoes.set(section, {
    count: cur.count + 1,
    expiresAt: now + PENDING_ECHO_TTL_MS,
  });
}

function consumePendingColorEcho(section) {
  const cur = pendingColorEchoes.get(section);
  if (!cur || !cur.count) return false;
  if (Date.now() > cur.expiresAt) {
    pendingColorEchoes.delete(section);
    return false;
  }
  cur.count -= 1;
  if (cur.count <= 0) pendingColorEchoes.delete(section);
  return true;
}



/* =============================== helpers ============================= */

const $ = (id) => document.getElementById(id);
const els = {};
function bindEls() {
  for (const id of [
    "profile-select","profile-new","profile-delete","status-pill","open-zendesk","reset-everything",
    "enabled","compact","themed","reorderEnabled","reorder-mode-set",
    "general-profile-id","general-fork-state",
    "level-grid","global-grid","palette-grid","theme-level-grid",
    "density-fork","theme-fork","hide-fork","customViews-fork","order-fork",
    "hide-search","expand-all","collapse-all","show-all","hide-all","rescan",
    "hide-status","tree","empty",
    "manual-add-form","manual-add-input","manual-add-title","manual-add-status",
    "customize-search","customize-list","customize-status","customize-clear-all",
    "reorder-disabled","reorder-controls","reorder-container","reorder-list",
    "reorder-reset","reorder-reset-all","reorder-hint",
    "builtin-templates","user-templates","tpl-save","tpl-import","tpl-import-file","tpl-status",
    "export-btn","import-btn","import-file","reset-profile","backup-status",
    "diag","copy-diag",
    "modal-root",
  ]) {
    els[id.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = $(id);
  }
}

function pathKey(arr) { return arr.join("::"); }
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
function isHexColor(s) { return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(s || "").trim()); }
function normHex(s) {
  if (!isHexColor(s)) return null;
  let v = s.toLowerCase();
  if (v.length === 4) v = "#" + v[1] + v[1] + v[2] + v[2] + v[3] + v[3];
  return v;
}

/* =========================== storage loaders ========================= */

async function loadEditingProfileId() {
  const { editingProfileId: stored } = await new Promise((r) =>
    chrome.storage.local.get({ editingProfileId: null }, r)
  );
  if (stored && allProfiles.includes(stored)) return stored;
  return RESERVED_PROFILE_ID;
}

async function setEditingProfileId(id) {
  editingProfileId = id;
  await new Promise((r) => chrome.storage.local.set({ editingProfileId: id }, r));
}

async function loadDiscoveryForProfile(profileId) {
  const keys = [
    `discoveredViews:${profileId}`,
    `discoveredGroups:${profileId}`,
    `discoveredContainers:${profileId}`,
  ];
  const res = await new Promise((r) => chrome.storage.local.get(keys, r));
  views = Array.isArray(res[keys[0]]) ? res[keys[0]] : [];
  groups = Array.isArray(res[keys[1]]) ? res[keys[1]] : [];
  containers = Array.isArray(res[keys[2]]) ? res[keys[2]] : [];
}

async function loadAllHealth() {
  const all = await new Promise((r) => chrome.storage.local.get(null, r));
  healthByProfile = {};
  for (const [k, v] of Object.entries(all)) {
    if (k.startsWith("selectorHealth:")) {
      healthByProfile[k.slice("selectorHealth:".length)] = v;
    }
  }
}

async function loadUserTemplates() {
  const { templates } = await new Promise((r) => chrome.storage.local.get({ templates: [] }, r));
  userTemplates = Array.isArray(templates) ? templates : [];
}

/* ============================ live preview =========================== */

function queuePreview(patch) {
  pendingPreviewPatch = pendingPreviewPatch ? deepMerge(pendingPreviewPatch, patch) : patch;
  if (previewTimer) return;
  previewTimer = setTimeout(() => {
    previewTimer = 0;
    const p = pendingPreviewPatch;
    pendingPreviewPatch = null;
    sendPreview(p);
  }, PREVIEW_DEBOUNCE_MS);
}

async function sendPreview(patch) {
  try {
    const tabs = await chrome.tabs.query({ url: ZENDESK_URL_MATCH });
    if (editingProfileId === RESERVED_PROFILE_ID) {
      // Editing default = broadcast to every Zendesk tab. The receiver will
      // filter out sections it has its own value for. This matches user
      // intent: "default" means anything inheriting from default.
      for (const t of tabs) {
        await safeSend(t.id, { type: "zvt:preview", patch, profileId: "*" });
      }
      return;
    }
    // Editing a tenant profile: only preview to tabs on that exact host.
    const matching = tabs.filter((t) => {
      try { return new URL(t.url).host === editingProfileId; }
      catch { return false; }
    });
    for (const t of matching) {
      await safeSend(t.id, { type: "zvt:preview", patch, profileId: editingProfileId });
    }
  } catch {}
}

async function safeSend(tabId, payload) {
  try { await chrome.tabs.sendMessage(tabId, payload); } catch {}
}

async function clearPreviewEverywhere() {
  try {
    const tabs = await chrome.tabs.query({ url: ZENDESK_URL_MATCH });
    for (const t of tabs) await safeSend(t.id, { type: "zvt:clearPreview" });
  } catch {}
}

/* ============================ row factory ============================ */

/**
 * Generic input-row factory. Slider+number for numbers, color+hex for colors.
 * Identical {value, onPreview, onCommit, onClear} interface across both kinds.
 */
function buildRow(cfg) {
  const row = document.createElement("div");
  row.className = "row";
  if (cfg.value != null) row.classList.add("set");

  const labelId = `lbl-${Math.random().toString(36).slice(2, 9)}`;
  const label = document.createElement("span");
  label.id = labelId;
  label.className = "row-label";
  label.textContent = cfg.label;
  // Show Zendesk's intrinsic value next to the label (when known) so the
  // user has a frame of reference for what they're overriding. Hidden when
  // a value is set (the user already knows their override).
  if (cfg.defaultRef != null && cfg.value == null) {
    const ref = document.createElement("span");
    ref.className = "row-default-ref";
    ref.textContent = `Zendesk: ${cfg.defaultRef}`;
    ref.title = `Zendesk's default for this property is ${cfg.defaultRef}. Drag the slider to override.`;
    label.appendChild(ref);
  }

  let primary, secondary;
  if (cfg.kind === "color") {
    primary = document.createElement("input");
    primary.type = "color";
    primary.value = cfg.value || "#000000";
    primary.setAttribute("aria-labelledby", labelId);
    secondary = document.createElement("input");
    secondary.type = "text";
    secondary.className = "hex";
    secondary.placeholder = "#rrggbb";
    secondary.value = cfg.value || "";
    secondary.setAttribute("aria-labelledby", labelId);
  } else {
    primary = document.createElement("input");
    primary.type = "range";
    primary.min = String(cfg.min);
    primary.max = String(cfg.max);
    primary.step = String(cfg.step || 1);
    // When unset, rest the slider thumb on the Zendesk intrinsic value (if
    // known). User can immediately see "this is what Zendesk uses" and drag
    // up or down. Falls back to cfg.fallback or cfg.min if no intrinsic.
    const restValue = cfg.value != null
      ? cfg.value
      : (cfg.defaultRef != null ? cfg.defaultRef
         : (cfg.fallback != null ? cfg.fallback : cfg.min));
    primary.value = String(restValue);
    primary.setAttribute("aria-labelledby", labelId);
    secondary = document.createElement("input");
    secondary.type = "number";
    secondary.min = String(cfg.min);
    secondary.max = String(cfg.max);
    secondary.step = String(cfg.step || 1);
    secondary.placeholder = cfg.defaultRef != null ? String(cfg.defaultRef) : "—";
    secondary.value = cfg.value != null ? String(cfg.value) : "";
    secondary.setAttribute("aria-labelledby", labelId);
  }
  if (cfg.disabled) { primary.disabled = true; secondary.disabled = true; }

  const clearBtn = document.createElement("button");
  clearBtn.type = "button";
  clearBtn.className = "clear-btn";
  clearBtn.textContent = "×";
  clearBtn.title = cfg.defaultRef != null
    ? `Clear override (use Zendesk default: ${cfg.defaultRef})`
    : "Clear override";
  clearBtn.disabled = cfg.value == null || cfg.disabled;

  const markSet = () => { row.classList.add("set"); clearBtn.disabled = false; };
  const markUnset = () => { row.classList.remove("set"); clearBtn.disabled = true; };

  if (cfg.kind === "color") {
    // Wrap commits so a one-shot pending-echo token is pushed BEFORE the
    // underlying store write — protects the (possibly still-open) native
    // color picker from being torn down by the storage echo's re-render.
    const colorCommit = (v) => {
      if (cfg.section) pushPendingColorEcho(cfg.section);
      return cfg.onCommit && cfg.onCommit(v);
    };
    primary.addEventListener("input", () => {
      const v = primary.value;
      secondary.value = v;
      markSet();
      cfg.onPreview && cfg.onPreview(v);
    });
    primary.addEventListener("change", () => colorCommit(primary.value));
    secondary.addEventListener("input", () => {
      const raw = secondary.value.trim();
      if (!raw) return;
      const v = normHex(raw);
      if (v) {
        primary.value = v;
        markSet();
        cfg.onPreview && cfg.onPreview(v);
      }
    });
    secondary.addEventListener("change", () => {
      const raw = secondary.value.trim();
      if (!raw) { cfg.onClear && cfg.onClear(); markUnset(); return; }
      const v = normHex(raw);
      if (v) { primary.value = v; secondary.value = v; colorCommit(v); }
      else { secondary.value = primary.value; }
    });
  } else {
    primary.addEventListener("input", () => {
      secondary.value = primary.value;
      markSet();
      cfg.onPreview && cfg.onPreview(Number(primary.value));
    });
    primary.addEventListener("change", () => cfg.onCommit && cfg.onCommit(Number(primary.value)));
    secondary.addEventListener("input", () => {
      const raw = secondary.value.trim();
      if (!raw) return;
      const n = clamp(Number(raw), cfg.min, cfg.max);
      if (Number.isFinite(n)) {
        primary.value = String(n);
        markSet();
        cfg.onPreview && cfg.onPreview(n);
      }
    });
    secondary.addEventListener("change", () => {
      const raw = secondary.value.trim();
      if (!raw) { cfg.onClear && cfg.onClear(); markUnset(); return; }
      const n = clamp(Number(raw), cfg.min, cfg.max);
      if (Number.isFinite(n)) {
        secondary.value = String(n);
        primary.value = String(n);
        cfg.onCommit && cfg.onCommit(n);
      }
    });
  }
  clearBtn.addEventListener("click", () => {
    if (cfg.kind === "color") {
      secondary.value = "";
      primary.value = "#000000";
    } else {
      secondary.value = "";
      // Reset slider thumb to the Zendesk intrinsic if known.
      const reset = cfg.defaultRef != null ? cfg.defaultRef
        : (cfg.fallback != null ? cfg.fallback : cfg.min);
      primary.value = String(reset);
    }
    markUnset();
    cfg.onClear && cfg.onClear();
  });

  row.appendChild(label);
  row.appendChild(primary);
  row.appendChild(secondary);
  row.appendChild(clearBtn);
  return row;
}

/* ============================ section: General ======================= */

function bindGeneral() {
  for (const key of ["enabled", "compact", "themed", "reorderEnabled"]) {
    els[key].addEventListener("change", async () => {
      await store.update("prefs", { [key]: !!els[key].checked });
    });
  }
  for (const radio of els.reorderModeSet.querySelectorAll('input[type="radio"]')) {
    radio.addEventListener("change", async () => {
      await store.update("prefs", { reorderMode: radio.value });
    });
  }
}

function renderGeneral() {
  const prefs = store.resolve("prefs");
  els.enabled.checked = !!prefs.enabled;
  els.compact.checked = !!prefs.compact;
  els.themed.checked = !!prefs.themed;
  els.reorderEnabled.checked = !!prefs.reorderEnabled;
  for (const radio of els.reorderModeSet.querySelectorAll('input[type="radio"]')) {
    radio.checked = radio.value === prefs.reorderMode;
  }
  els.generalProfileId.textContent = editingProfileId;
  if (editingProfileId === RESERVED_PROFILE_ID) {
    els.generalForkState.textContent = "(default profile — applies to any tenant without an explicit profile)";
  } else {
    els.generalForkState.textContent = "";
  }
}

/* ============================ section: Density ======================= */

function maxDiscoveredDepth() {
  let max = 0;
  for (const v of views) max = Math.max(max, Number(v.depth) || 0);
  for (const g of groups) max = Math.max(max, Number(g.depth) || 0);
  return max;
}

function renderDensity() {
  els.levelGrid.innerHTML = "";
  els.globalGrid.innerHTML = "";
  const density = store.resolve("density");
  const detected = maxDiscoveredDepth();
  const showLevels = Math.max(detected + 1, 5);

  for (let depth = 1; depth <= showLevels; depth++) {
    const block = document.createElement("div");
    block.className = "level-block";
    if (depth > detected) block.classList.add("future");
    const head = document.createElement("div");
    head.className = "level-block-head";
    head.innerHTML = `<span class="level-name">Level ${depth}</span><span class="level-status">${depth > detected ? "(no items at this depth yet)" : countAtDepth(depth)}</span>`;
    block.appendChild(head);

    const tokens = (density.level && density.level[String(depth)]) || {};
    for (const tk of LEVEL_TOKENS) {
      const disabled = tk.levelMin && depth < tk.levelMin;
      const value = typeof tokens[tk.key] === "number" ? tokens[tk.key] : null;
      const defaultRef = INTRINSIC_LEVEL[tk.key];
      block.appendChild(buildRow({
        kind: "number", label: tk.label, min: tk.min, max: tk.max, step: tk.step, value,
        defaultRef, disabled,
        onPreview: (v) => queuePreview({ density: { level: { [String(depth)]: { [tk.key]: v } } } }),
        onCommit: (v) => store.update("density", { level: { [String(depth)]: { [tk.key]: v } } }),
        onClear: async () => {
          await store.update("density", { level: { [String(depth)]: { [tk.key]: null } } });
          queuePreview({ density: { level: { [String(depth)]: { [tk.key]: null } } } });
        },
      }));
    }
    els.levelGrid.appendChild(block);
  }

  for (const tk of GLOBAL_TOKENS) {
    const value = typeof density.global?.[tk.key] === "number" ? density.global[tk.key] : null;
    const defaultRef = INTRINSIC_GLOBAL[tk.key];
    els.globalGrid.appendChild(buildRow({
      kind: "number", label: tk.label, min: tk.min, max: tk.max, step: tk.step, value,
      defaultRef,
      onPreview: (v) => queuePreview({ density: { global: { [tk.key]: v } } }),
      onCommit: (v) => store.update("density", { global: { [tk.key]: v } }),
      onClear: async () => {
        await store.update("density", { global: { [tk.key]: null } });
        queuePreview({ density: { global: { [tk.key]: null } } });
      },
    }));
  }

  renderForkLine("density", "density-fork");
}

function countAtDepth(depth) {
  let v = 0, g = 0;
  for (const view of views) if (Number(view.depth) === depth) v++;
  for (const grp of groups) if (Number(grp.depth) === depth) g++;
  return `${v} view${v === 1 ? "" : "s"}, ${g} group${g === 1 ? "" : "s"}`;
}

function bindDensity() {
  document.querySelectorAll('.presets button[data-preset]').forEach((btn) => {
    btn.addEventListener("click", async () => {
      const name = btn.dataset.preset;
      if (name === "clear" || name === "zendesk") {
        if (!await confirmModal("Clear all density customizations on this profile?")) return;
        await store.replace("density", { level: {}, global: { ...DEFAULT_DENSITY.global } });
      } else {
        const preset = PRESETS[name];
        if (!preset) return;
        await store.replace("density", structuredClone(preset));
      }
    });
  });
}

/* ============================ section: Theme ======================== */

function renderTheme() {
  els.paletteGrid.innerHTML = "";
  els.themeLevelGrid.innerHTML = "";
  const theme = store.resolve("theme");
  const palette = theme.palette || {};

  for (const tk of PALETTE_TOKENS) {
    els.paletteGrid.appendChild(buildRow({
      kind: "color", section: "theme", label: tk.label, value: palette[tk.key],
      onPreview: (v) => queuePreview({ theme: { palette: { [tk.key]: v } } }),
      onCommit: (v) => store.update("theme", { palette: { [tk.key]: v } }),
      onClear: async () => {
        await store.update("theme", { palette: { [tk.key]: null } });
        queuePreview({ theme: { palette: { [tk.key]: null } } });
      },
    }));
  }

  const detected = maxDiscoveredDepth();
  const showLevels = Math.max(detected + 1, 5);
  for (let depth = 1; depth <= showLevels; depth++) {
    const block = document.createElement("div");
    block.className = "theme-block";
    if (depth > detected) block.classList.add("future");
    const head = document.createElement("div");
    head.className = "theme-block-head";
    head.innerHTML = `<span class="level-name">Level ${depth}</span><span class="level-status">${depth > detected ? "(no items)" : countAtDepth(depth)}</span>`;
    block.appendChild(head);
    const tokens = (theme.level && theme.level[String(depth)]) || {};
    for (const tk of THEME_LEVEL_TOKENS) {
      block.appendChild(buildRow({
        kind: "color", section: "theme", label: tk.label, value: tokens[tk.key],
        onPreview: (v) => queuePreview({ theme: { level: { [String(depth)]: { [tk.key]: v } } } }),
        onCommit: (v) => store.update("theme", { level: { [String(depth)]: { [tk.key]: v } } }),
        onClear: async () => {
          await store.update("theme", { level: { [String(depth)]: { [tk.key]: null } } });
          queuePreview({ theme: { level: { [String(depth)]: { [tk.key]: null } } } });
        },
      }));
    }
    els.themeLevelGrid.appendChild(block);
  }
  renderForkLine("theme", "theme-fork");
}

/* ============================== section: Hide ======================= */

function isViewHidden(id) { return store.resolve("hide").v.includes(String(id)); }
function isGroupHidden(path) { return store.resolve("hide").g.includes(path); }

async function setViewHidden(id, hidden) {
  const hide = structuredClone(store.resolve("hide"));
  const set = new Set(hide.v.map(String));
  hidden ? set.add(String(id)) : set.delete(String(id));
  hide.v = Array.from(set).sort();
  await store.update("hide", hide);
}
async function setGroupHidden(path, hidden) {
  const hide = structuredClone(store.resolve("hide"));
  const set = new Set(hide.g);
  hidden ? set.add(path) : set.delete(path);
  hide.g = Array.from(set).sort();
  await store.update("hide", hide);
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
  for (const g of allGroups) if (g?.path) ensureGroup(g.path.split("::").filter(Boolean));
  for (const v of filteredViews) ensureGroup(Array.isArray(v.groupPath) ? v.groupPath : []).views.push(v);
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
  const q = (els.hideSearch.value || "").trim().toLowerCase();
  const filtered = views.filter((v) => matchesQuery(v, q));
  els.tree.innerHTML = "";
  const hide = store.resolve("hide");

  if (views.length === 0 && groups.length === 0) {
    els.tree.hidden = true;
    els.empty.hidden = false;
    els.hideStatus.textContent = "0 views, 0 groups discovered for this profile.";
    renderForkLine("hide", "hide-fork");
    return;
  }
  els.empty.hidden = true;
  const root = buildHideTree(filtered, groups);
  if (!root.views.length && root.children.size === 0) {
    els.tree.hidden = true;
    els.hideStatus.textContent = q ? "No matches." : "0 items.";
    renderForkLine("hide", "hide-fork");
    return;
  }
  els.tree.hidden = false;
  els.hideStatus.textContent =
    `${views.length} view${views.length === 1 ? "" : "s"}, ${groups.length} group${groups.length === 1 ? "" : "s"}. ` +
    `${hide.v.length} view${hide.v.length === 1 ? "" : "s"} hidden, ${hide.g.length} group${hide.g.length === 1 ? "" : "s"} hidden.` +
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
  renderForkLine("hide", "hide-fork");
}

function renderHideGroup(node, hasQuery) {
  const stats = nodeStats(node);
  const groupPathStr = pathKey(node.path);
  const groupHidden = isGroupHidden(groupPathStr);
  const details = document.createElement("details");
  details.className = "group" + (groupHidden ? " group-hidden" : "");
  const open = hasQuery || expandedHidePaths.has(groupPathStr) || !allHideExpandedHinted;
  if (open) details.open = true;
  details.dataset.path = groupPathStr;
  details.addEventListener("toggle", () => {
    if (details.open) expandedHidePaths.add(groupPathStr); else expandedHidePaths.delete(groupPathStr);
  });

  const summary = document.createElement("summary");
  const visCb = document.createElement("input");
  visCb.type = "checkbox";
  visCb.checked = !groupHidden;
  visCb.addEventListener("click", (e) => e.stopPropagation());
  visCb.addEventListener("change", () => setGroupHidden(groupPathStr, !visCb.checked));
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
    e.preventDefault(); e.stopPropagation();
    const ids = collectLeafIds(node);
    const target = !(stats.hidden < stats.total);
    const hide = structuredClone(store.resolve("hide"));
    const set = new Set(hide.v.map(String));
    for (const id of ids) target ? set.delete(id) : set.add(id);
    hide.v = Array.from(set).sort();
    await store.update("hide", hide);
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
  cb.addEventListener("change", () => setViewHidden(v.id, !cb.checked));
  const title = document.createElement("span");
  title.className = "title";
  title.textContent = v.title || `View ${v.id}`;
  const id = document.createElement("span");
  id.className = "id";
  id.textContent = v.id;
  label.appendChild(cb); label.appendChild(title); label.appendChild(id);

  const customize = document.createElement("button");
  customize.type = "button";
  customize.className = "leaf-customize";
  const cv = store.resolve("customViews");
  if (cv[String(v.id)]) customize.classList.add("has-custom");
  customize.textContent = "🎨";
  customize.title = "Customize this view";
  customize.addEventListener("click", (e) => {
    e.preventDefault();
    expandedCustomViewId = String(v.id);
    document.getElementById("sec-customize").scrollIntoView({ behavior: "smooth" });
    renderCustomize();
  });
  li.appendChild(label);
  li.appendChild(customize);
  return li;
}

function bindHide() {
  els.hideSearch.addEventListener("input", renderHide);
  els.expandAll.addEventListener("click", () => setAllHideExpanded(true));
  els.collapseAll.addEventListener("click", () => setAllHideExpanded(false));
  els.showAll.addEventListener("click", async () => {
    const q = (els.hideSearch.value || "").trim().toLowerCase();
    const targetViews = views.filter((v) => matchesQuery(v, q));
    const hide = structuredClone(store.resolve("hide"));
    const set = new Set(hide.v.map(String));
    for (const v of targetViews) set.delete(String(v.id));
    hide.v = Array.from(set).sort();
    hide.g = [];
    await store.update("hide", hide);
  });
  els.hideAll.addEventListener("click", async () => {
    const q = (els.hideSearch.value || "").trim().toLowerCase();
    const target = views.filter((v) => matchesQuery(v, q));
    const hide = structuredClone(store.resolve("hide"));
    const set = new Set(hide.v.map(String));
    for (const v of target) set.add(String(v.id));
    hide.v = Array.from(set).sort();
    await store.update("hide", hide);
  });
  els.rescan.addEventListener("click", onRescan);
  els.manualAddForm.addEventListener("submit", onManualAdd);
}

function setAllHideExpanded(open) {
  allHideExpandedHinted = true;
  expandedHidePaths.clear();
  if (open) {
    const root = buildHideTree(views, groups);
    const stack = Array.from(root.children.values());
    while (stack.length) {
      const n = stack.pop();
      expandedHidePaths.add(pathKey(n.path));
      stack.push(...n.children.values());
    }
  }
  renderHide();
}

async function onRescan() {
  els.hideStatus.textContent = "Looking for an open Zendesk tab on this profile…";
  const tabs = await chrome.tabs.query({ url: ZENDESK_URL_MATCH });
  const matching = tabs.filter((t) => {
    try { return new URL(t.url).host === editingProfileId; }
    catch { return false; }
  });
  if (!matching.length) {
    els.hideStatus.textContent = `No open ${editingProfileId === RESERVED_PROFILE_ID ? "Zendesk" : editingProfileId} tab. Use [Open Zendesk] above.`;
    return;
  }
  let ok = 0;
  for (const t of matching) {
    try {
      const res = await chrome.tabs.sendMessage(t.id, { type: "zvt:rescan", profileId: editingProfileId });
      if (res?.ok) ok++;
    } catch {}
  }
  if (ok === 0) {
    els.hideStatus.textContent = "Found tab(s) but couldn't reach the content script. Reload the Zendesk tab.";
    return;
  }
  setTimeout(async () => {
    await loadDiscoveryForProfile(editingProfileId);
    renderHide();
    renderCustomize();
    renderReorder();
    els.hideStatus.textContent = `Refreshed from ${ok} tab${ok === 1 ? "" : "s"}.`;
  }, 400);
}

function parseManualEntry(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return s;
  const m = s.match(RE.FILTER_LOOSE);
  return m ? m[1] : null;
}

async function onManualAdd(e) {
  e.preventDefault();
  const id = parseManualEntry(els.manualAddInput.value);
  if (!id) {
    els.manualAddStatus.textContent = "Couldn't parse a view ID. Paste a URL or numeric ID.";
    return;
  }
  const title = (els.manualAddTitle.value || "").trim() || `View ${id}`;
  const href = `/agent/filters/${id}`;
  if (!views.find((v) => String(v.id) === id)) {
    views.push({ id, title, href, groupPath: ["Manually added"], depth: 2, lastSeenAt: Date.now(), manual: true });
    await new Promise((r) =>
      chrome.storage.local.set({ [`discoveredViews:${editingProfileId}`]: views }, r)
    );
  }
  await setViewHidden(id, true);
  els.manualAddInput.value = "";
  els.manualAddTitle.value = "";
  els.manualAddStatus.textContent = `Added view ${id} to hidden list.`;
}

/* =========================== section: Customize ===================== */

function renderCustomize() {
  const q = (els.customizeSearch?.value || "").trim().toLowerCase();
  const cv = store.resolve("customViews");
  const list = views
    .filter((v) => !q || matchesQuery(v, q))
    .sort((a, b) => (a.title || "").localeCompare(b.title || ""));

  els.customizeStatus.textContent =
    `${views.length} discovered, ${Object.keys(cv).length} customized.` +
    (q ? ` Showing ${list.length}.` : "");

  els.customizeList.innerHTML = "";
  if (!list.length) {
    const li = document.createElement("li");
    li.style.padding = "12px 16px";
    li.style.color = "var(--muted)";
    li.textContent = views.length ? "No matches." : "No views discovered yet.";
    els.customizeList.appendChild(li);
    return;
  }

  for (const v of list) {
    const id = String(v.id);
    const c = cv[id] || {};
    const isExpanded = expandedCustomViewId === id;

    const li = document.createElement("li");
    const row = document.createElement("div");
    row.className = "customize-row" + (Object.keys(c).length ? " has-custom" : "");
    row.setAttribute("aria-expanded", String(isExpanded));
    row.tabIndex = 0;

    const arrow = document.createElement("span");
    arrow.className = "arrow";
    arrow.textContent = "▶";

    const preview = document.createElement("span");
    preview.className = "preview";
    if (c.bgColor) preview.style.backgroundColor = c.bgColor;
    if (c.fgColor) preview.style.color = c.fgColor;
    if (c.fontWeight) preview.style.fontWeight = c.fontWeight;
    if (c.italic) preview.style.fontStyle = "italic";
    preview.textContent = (c.iconPrefix ? c.iconPrefix + " " : "") + (v.title || `View ${id}`);

    const meta = document.createElement("span");
    meta.className = "meta";
    const titleEl = document.createElement("span");
    titleEl.className = "title";
    titleEl.textContent = v.title || `View ${id}`;
    const groupEl = document.createElement("span");
    groupEl.className = "group";
    groupEl.textContent = (v.groupPath || []).join(" / ") + ` · ${id}`;
    meta.appendChild(titleEl);
    meta.appendChild(groupEl);

    if (Object.keys(c).length) {
      const ind = document.createElement("span");
      ind.className = "indicator";
      ind.textContent = "customized";
      meta.appendChild(ind);
    }

    row.appendChild(arrow);
    row.appendChild(preview);
    row.appendChild(meta);

    row.addEventListener("click", () => {
      expandedCustomViewId = isExpanded ? null : id;
      renderCustomize();
    });
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        expandedCustomViewId = isExpanded ? null : id;
        renderCustomize();
      }
    });
    li.appendChild(row);

    if (isExpanded) {
      li.appendChild(renderCustomizeEditor(id, c));
    }
    els.customizeList.appendChild(li);
  }
  renderForkLine("customViews", "customViews-fork");
}

function renderCustomizeEditor(viewId, c) {
  const ed = document.createElement("div");
  ed.className = "customize-editor";
  const grid = document.createElement("div");
  grid.className = "editor-grid";

  const updateField = async (key, value) => {
    const cv = structuredClone(store.resolve("customViews"));
    cv[viewId] = cv[viewId] || {};
    if (value == null || value === "") delete cv[viewId][key];
    else cv[viewId][key] = value;
    if (Object.keys(cv[viewId]).length === 0) delete cv[viewId];
    await store.update("customViews", cv);
  };

  const previewField = (key, value) => {
    const cv = structuredClone(store.resolve("customViews"));
    cv[viewId] = cv[viewId] || {};
    if (value == null || value === "") delete cv[viewId][key];
    else cv[viewId][key] = value;
    queuePreview({ customViews: cv });
  };

  // bgColor, fgColor (color rows)
  for (const [key, label] of [["bgColor", "Background"], ["fgColor", "Text color"]]) {
    grid.appendChild(buildRow({
      kind: "color", section: "customViews", label, value: c[key],
      onPreview: (v) => previewField(key, v),
      onCommit: (v) => updateField(key, v),
      onClear: () => updateField(key, null),
    }));
  }

  // padding (number row)
  grid.appendChild(buildRow({
    kind: "number", label: "Padding", min: 0, max: 32, step: 1, value: typeof c.padding === "number" ? c.padding : null,
    onPreview: (v) => previewField("padding", v),
    onCommit: (v) => updateField("padding", v),
    onClear: () => updateField("padding", null),
  }));

  // font weight (select)
  const weightRow = document.createElement("div");
  weightRow.className = "row" + (c.fontWeight ? " set" : "");
  const wLbl = document.createElement("span");
  wLbl.className = "row-label";
  wLbl.textContent = "Font weight";
  const wSel = document.createElement("select");
  wSel.style.gridColumn = "2 / 4";
  for (const w of ["", "normal", "500", "600", "bold"]) {
    const opt = document.createElement("option");
    opt.value = w;
    opt.textContent = w || "(default)";
    if ((c.fontWeight || "") === w) opt.selected = true;
    wSel.appendChild(opt);
  }
  wSel.addEventListener("change", () => updateField("fontWeight", wSel.value || null));
  const wClear = document.createElement("button");
  wClear.type = "button";
  wClear.className = "clear-btn";
  wClear.textContent = "×";
  wClear.disabled = !c.fontWeight;
  wClear.addEventListener("click", () => updateField("fontWeight", null));
  weightRow.appendChild(wLbl);
  weightRow.appendChild(wSel);
  weightRow.appendChild(wClear);
  grid.appendChild(weightRow);

  // italic (checkbox)
  const italicRow = document.createElement("div");
  italicRow.className = "row" + (c.italic ? " set" : "");
  italicRow.style.gridTemplateColumns = "110px auto 1fr 24px";
  const iLbl = document.createElement("span");
  iLbl.className = "row-label";
  iLbl.textContent = "Italic";
  const iCb = document.createElement("input");
  iCb.type = "checkbox";
  iCb.checked = !!c.italic;
  iCb.addEventListener("change", () => updateField("italic", iCb.checked || null));
  const iSpacer = document.createElement("span");
  const iClear = document.createElement("button");
  iClear.type = "button";
  iClear.className = "clear-btn";
  iClear.textContent = "×";
  iClear.disabled = !c.italic;
  iClear.addEventListener("click", () => { iCb.checked = false; updateField("italic", null); });
  italicRow.appendChild(iLbl);
  italicRow.appendChild(iCb);
  italicRow.appendChild(iSpacer);
  italicRow.appendChild(iClear);
  grid.appendChild(italicRow);

  // iconPrefix (text input)
  const prefixRow = document.createElement("div");
  prefixRow.className = "row" + (c.iconPrefix ? " set" : "");
  const pLbl = document.createElement("span");
  pLbl.className = "row-label";
  pLbl.textContent = "Title prefix";
  const pInput = document.createElement("input");
  pInput.type = "text";
  pInput.placeholder = "e.g. ⭐, 🔴, [P0]";
  pInput.maxLength = 8;
  pInput.style.gridColumn = "2 / 4";
  pInput.value = c.iconPrefix || "";
  pInput.addEventListener("input", () => previewField("iconPrefix", pInput.value || null));
  pInput.addEventListener("change", () => updateField("iconPrefix", pInput.value || null));
  const pClear = document.createElement("button");
  pClear.type = "button";
  pClear.className = "clear-btn";
  pClear.textContent = "×";
  pClear.disabled = !c.iconPrefix;
  pClear.addEventListener("click", () => { pInput.value = ""; updateField("iconPrefix", null); });
  prefixRow.appendChild(pLbl);
  prefixRow.appendChild(pInput);
  prefixRow.appendChild(pClear);
  grid.appendChild(prefixRow);

  ed.appendChild(grid);

  const actions = document.createElement("div");
  actions.className = "editor-actions";
  const resetBtn = document.createElement("button");
  resetBtn.type = "button";
  resetBtn.className = "danger";
  resetBtn.textContent = "Reset this view";
  resetBtn.addEventListener("click", async () => {
    const cv = structuredClone(store.resolve("customViews"));
    delete cv[viewId];
    await store.update("customViews", cv);
  });
  actions.appendChild(resetBtn);
  ed.appendChild(actions);
  return ed;
}

function bindCustomize() {
  els.customizeSearch.addEventListener("input", renderCustomize);
  els.customizeClearAll.addEventListener("click", async () => {
    if (!await confirmModal("Clear ALL per-view customizations on this profile?")) return;
    await store.update("customViews", {});
  });
}

/* ============================ section: Reorder ====================== */

function getEffectiveOrder(scopeKey) {
  const order = store.resolve("order");
  const explicit = Array.isArray(order[scopeKey]) ? order[scopeKey].slice() : [];
  let domItems;
  if (scopeKey === "ROOT") {
    domItems = groups.filter((g) => Number(g.depth) === 1).map((g) => groupKey(g.path));
  } else if (scopeKey.startsWith("g:")) {
    const parentPath = scopeKey.slice(2);
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
  const explicitSet = new Set(explicit);
  const remainder = domItems.filter((k) => !explicitSet.has(k));
  const domSet = new Set(domItems);
  const cleanedExplicit = explicit.filter((k) => domSet.has(k));
  return { effective: [...cleanedExplicit, ...remainder], explicit: cleanedExplicit, remainder };
}

function trimTrailingNatural(arr, scope) {
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
  let cut = arr.length;
  let domIdx = domItems.length - 1;
  for (let i = arr.length - 1; i >= 0; i--) {
    if (domIdx < 0) break;
    if (arr[i] === domItems[domIdx]) { cut = i; domIdx--; }
    else break;
  }
  return arr.slice(0, cut);
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

function containerExistsForGroup(path) {
  const hasChildView = views.some((v) => Array.isArray(v.groupPath) && v.groupPath.join("::") === path);
  const hasChildGroup = groups.some((g) =>
    g.path.startsWith(path + "::") && g.path.split("::").length === path.split("::").length + 1
  );
  return hasChildView || hasChildGroup;
}

function renderReorder() {
  const prefs = store.resolve("prefs");
  if (!prefs.reorderEnabled) {
    els.reorderDisabled.hidden = false;
    els.reorderControls.style.display = "none";
    renderForkLine("order", "order-fork");
    return;
  }
  els.reorderDisabled.hidden = true;
  els.reorderControls.style.display = "";

  const containerKeys = ["ROOT", ...groups.filter((g) => containerExistsForGroup(g.path)).map((g) => groupKey(g.path))];
  els.reorderContainer.innerHTML = "";
  for (const key of containerKeys) {
    const opt = document.createElement("option");
    opt.value = key;
    if (key === "ROOT") opt.textContent = "Top level (root)";
    else {
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
  renderForkLine("order", "order-fork");
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
    handle.className = "handle"; handle.textContent = "⋮⋮"; handle.title = "Drag to reorder";

    const icon = document.createElement("span");
    icon.className = "item-icon";
    icon.textContent = desc.type === "group" ? "📁" : "📄";

    const name = document.createElement("span");
    name.className = "item-name"; name.textContent = desc.name;

    const keyEl = document.createElement("span");
    keyEl.className = "item-key"; keyEl.textContent = desc.key;

    const arrows = document.createElement("span");
    arrows.className = "arrow-btns";
    const up = document.createElement("button");
    up.type = "button"; up.className = "arrow-btn"; up.textContent = "↑"; up.title = "Move up";
    up.disabled = idx === 0;
    up.addEventListener("click", () => moveReorderItem(scope, itemKey, idx, idx - 1));
    const down = document.createElement("button");
    down.type = "button"; down.className = "arrow-btn"; down.textContent = "↓"; down.title = "Move down";
    down.disabled = idx === effective.length - 1;
    down.addEventListener("click", () => moveReorderItem(scope, itemKey, idx, idx + 1));
    arrows.appendChild(up); arrows.appendChild(down);

    li.appendChild(handle); li.appendChild(icon); li.appendChild(name); li.appendChild(keyEl);
    if (explicit.includes(itemKey)) {
      const pinned = document.createElement("span");
      pinned.className = "item-pinned"; pinned.textContent = "pinned";
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

  const ec = explicit.length;
  els.reorderHint.textContent =
    ec === 0
      ? `${effective.length} items, all in Zendesk's intrinsic order.`
      : `${ec} pinned in custom order; ${effective.length - ec} in Zendesk's intrinsic order.`;
}

async function moveReorderItem(scope, itemKey, fromIdx, toIdx) {
  const { effective } = getEffectiveOrder(scope);
  if (toIdx < 0 || toIdx >= effective.length) return;
  const arr = effective.slice();
  arr.splice(fromIdx, 1);
  arr.splice(toIdx, 0, itemKey);
  const nextOrder = structuredClone(store.resolve("order"));
  nextOrder[scope] = trimTrailingNatural(arr, scope);
  await store.update("order", nextOrder);
  queuePreview({ order: { [scope]: nextOrder[scope] } });
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
function onDragLeave(e) { e.currentTarget.classList.remove("drag-over-top", "drag-over-bottom"); }
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
  const nextOrder = structuredClone(store.resolve("order"));
  nextOrder[scope] = trimTrailingNatural(arr, scope);
  await store.update("order", nextOrder);
  queuePreview({ order: { [scope]: nextOrder[scope] } });
}

function bindReorder() {
  els.reorderContainer.addEventListener("change", renderReorderList);
  els.reorderReset.addEventListener("click", async () => {
    const scope = els.reorderContainer.value;
    if (!await confirmModal(`Reset custom order for ${scope}?`)) return;
    const nextOrder = structuredClone(store.resolve("order"));
    delete nextOrder[scope];
    await store.update("order", nextOrder);
    queuePreview({ order: { [scope]: [] } });
  });
  els.reorderResetAll.addEventListener("click", async () => {
    if (!await confirmModal("Reset ALL custom orderings on this profile?")) return;
    await store.update("order", {});
    clearPreviewEverywhere();
  });
}

/* =========================== section: Templates ===================== */

function renderTemplates() {
  els.builtinTemplates.innerHTML = "";
  for (const tpl of BUILTIN_TEMPLATES) {
    els.builtinTemplates.appendChild(renderTemplateRow(tpl, false));
  }
  els.userTemplates.innerHTML = "";
  if (!userTemplates.length) {
    const li = document.createElement("li");
    li.style.color = "var(--muted)";
    li.style.fontSize = "13px";
    li.textContent = "No saved templates yet.";
    els.userTemplates.appendChild(li);
  } else {
    for (const tpl of userTemplates) els.userTemplates.appendChild(renderTemplateRow(tpl, true));
  }
}

function renderTemplateRow(tpl, isUser) {
  const li = document.createElement("li");
  const meta = document.createElement("div");
  meta.className = "tpl-meta";
  const name = document.createElement("span");
  name.className = "tpl-name"; name.textContent = tpl.name;
  meta.appendChild(name);
  if (tpl.description) {
    const desc = document.createElement("span");
    desc.className = "tpl-desc"; desc.textContent = tpl.description;
    meta.appendChild(desc);
  }
  const inc = document.createElement("span");
  inc.className = "tpl-includes";
  inc.textContent = `Includes: ${(tpl.includes || []).join(", ") || "(empty)"}`;
  meta.appendChild(inc);
  li.appendChild(meta);

  const actions = document.createElement("div");
  actions.className = "tpl-actions";
  const apply = document.createElement("button");
  apply.type = "button"; apply.textContent = "Apply";
  apply.addEventListener("click", () => applyTemplate(tpl, false));
  actions.appendChild(apply);

  const applyAll = document.createElement("button");
  applyAll.type = "button"; applyAll.textContent = "Apply (full)";
  applyAll.title = "Overwrite ALL sections, not just the included ones";
  applyAll.addEventListener("click", () => applyTemplate(tpl, true));
  actions.appendChild(applyAll);

  const exp = document.createElement("button");
  exp.type = "button"; exp.textContent = "Export";
  exp.addEventListener("click", () => exportTemplateFile(tpl));
  actions.appendChild(exp);

  if (isUser) {
    const del = document.createElement("button");
    del.type = "button"; del.className = "danger"; del.textContent = "Delete";
    del.addEventListener("click", async () => {
      if (!await confirmModal(`Delete template "${tpl.name}"?`)) return;
      userTemplates = userTemplates.filter((t) => t.id !== tpl.id);
      await new Promise((r) => chrome.storage.local.set({ templates: userTemplates }, r));
      renderTemplates();
    });
    actions.appendChild(del);
  }
  li.appendChild(actions);
  return li;
}

async function applyTemplate(tpl, fullOverwrite) {
  const sectionsToApply = fullOverwrite ? SECTION_NAMES : (tpl.includes || []);
  const sectionList = sectionsToApply.join(", ") || "(none)";
  const msg = fullOverwrite
    ? `Apply "${tpl.name}" with FULL OVERWRITE? This wipes all sections (${sectionList}).`
    : `Apply "${tpl.name}"? This will overwrite: ${sectionList}.`;
  if (!await confirmModal(msg)) return;

  for (const section of sectionsToApply) {
    const value = tpl.payload?.[section];
    if (value !== undefined) {
      // Templates always replace, never merge.
      await store.replace(section, structuredClone(value));
    } else if (fullOverwrite) {
      // Clear the section for this profile by writing default values.
      await store.replace(section, SECTION_STRATEGY[section].getDefault());
    }
  }
  els.tplStatus.textContent = `Applied "${tpl.name}".`;
}

function exportTemplateFile(tpl) {
  const json = JSON.stringify(tpl, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `zvt-template-${tpl.id}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

function bindTemplates() {
  els.tplSave.addEventListener("click", async () => {
    const name = await promptModal("Template name", "");
    if (!name) return;
    const description = await promptModal("Description (optional)", "");
    const includes = await checkboxModal(
      "Which sections to include?",
      SECTION_NAMES.map((s) => ({ value: s, label: s, checked: ["density", "theme"].includes(s) }))
    );
    if (!includes) return;
    const snapshot = store.snapshot();
    const payload = {};
    for (const s of includes) payload[s] = snapshot[s];
    const tpl = {
      id: `user-${Date.now().toString(36)}`,
      name, description, includes,
      createdAt: new Date().toISOString(),
      compatVersion: "0.6",
      payload,
    };
    userTemplates.push(tpl);
    await new Promise((r) => chrome.storage.local.set({ templates: userTemplates }, r));
    renderTemplates();
    els.tplStatus.textContent = `Saved "${name}".`;
  });
  els.tplImport.addEventListener("click", () => els.tplImportFile.click());
  els.tplImportFile.addEventListener("change", async () => {
    const file = els.tplImportFile.files?.[0];
    if (!file) return;
    els.tplImportFile.value = "";
    const text = await file.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { els.tplStatus.textContent = "Invalid JSON."; return; }
    if (!parsed?.name || !parsed?.payload) { els.tplStatus.textContent = "Not a valid template file."; return; }
    if (parsed.compatVersion && parsed.compatVersion !== "0.6") {
      const proceed = await confirmModal(`Template was exported from v${parsed.compatVersion}. Apply anyway?`);
      if (!proceed) return;
    }
    parsed.id = `user-${Date.now().toString(36)}`;
    userTemplates.push(parsed);
    await new Promise((r) => chrome.storage.local.set({ templates: userTemplates }, r));
    renderTemplates();
    els.tplStatus.textContent = `Imported "${parsed.name}".`;
  });
}

/* ============================ section: Backup ====================== */

function bindBackup() {
  els.exportBtn.addEventListener("click", () => {
    const cv = store.resolve("customViews");
    if (Object.keys(cv).length) {
      // Privacy hook for v0.7 when labels arrive; placeholder warning is fine now.
    }
    const payload = {
      compatVersion: "0.6",
      profileId: editingProfileId,
      generatedAt: new Date().toISOString(),
      ...store.snapshot(),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `zvt-${editingProfileId.replace(/[^a-z0-9.-]/gi, "_")}-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    els.backupStatus.textContent = "Exported.";
  });
  els.importBtn.addEventListener("click", () => els.importFile.click());
  els.importFile.addEventListener("change", async () => {
    const file = els.importFile.files?.[0];
    if (!file) return;
    els.importFile.value = "";
    const text = await file.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch { els.backupStatus.textContent = "Invalid JSON."; return; }
    if (!await confirmModal(`Replace this profile's settings with imported data?`)) return;
    for (const section of SECTION_NAMES) {
      if (parsed[section] !== undefined) {
        await store.replace(section, parsed[section]);
      }
    }
    els.backupStatus.textContent = "Imported.";
  });
  els.resetProfile.addEventListener("click", async () => {
    if (!await confirmModal(`Reset ALL settings on profile "${editingProfileId}" to defaults?`)) return;
    if (editingProfileId === RESERVED_PROFILE_ID) {
      // Default profile: write a fresh defaults object for each section.
      for (const section of SECTION_NAMES) {
        await store.replace(section, SECTION_STRATEGY[section].getDefault());
      }
    } else {
      // Tenant profile: unfork everything so it inherits from default again.
      for (const section of SECTION_NAMES) {
        await store.unfork(section);
      }
    }
    clearPreviewEverywhere();
    els.backupStatus.textContent = "Reset.";
  });
  els.copyDiag.addEventListener("click", () => {
    navigator.clipboard.writeText(els.diag.textContent).then(
      () => { els.backupStatus.textContent = "Diagnostics copied."; },
      () => { els.backupStatus.textContent = "Couldn't copy."; }
    );
  });
}

function renderDiag() {
  const health = healthByProfile[editingProfileId] || null;
  const diag = {
    editingProfileId,
    profiles: allProfiles,
    counts: { views: views.length, groups: groups.length, containers: containers.length },
    forked: SECTION_NAMES.reduce((acc, s) => { acc[s] = store.isForked(s); return acc; }, {}),
    sectionSummary: SECTION_NAMES.reduce((acc, s) => {
      const v = store.resolve(s);
      if (s === "hide")             acc[s] = { v: v.v.length, g: v.g.length };
      else if (s === "order")       acc[s] = { scopes: Object.keys(v).length };
      else if (s === "customViews") acc[s] = { count: Object.keys(v).length };
      else if (s === "density")     acc[s] = { levels: Object.keys(v.level || {}), globalSet: Object.entries(v.global || {}).filter(([_, x]) => x != null).map(([k]) => k) };
      else if (s === "theme")       acc[s] = { paletteSet: Object.entries(v.palette || {}).filter(([_, x]) => x != null).map(([k]) => k), levels: Object.keys(v.level || {}) };
      else                          acc[s] = v;
      return acc;
    }, {}),
    health,
  };
  els.diag.textContent = JSON.stringify(diag, null, 2);
}

/* ============================== status pill ======================== */

async function refreshStatus() {
  let tabCount = 0;
  let matching = 0;
  try {
    const tabs = await chrome.tabs.query({ url: ZENDESK_URL_MATCH });
    tabCount = tabs.length;
    matching = tabs.filter((t) => {
      try { return new URL(t.url).host === editingProfileId; } catch { return false; }
    }).length;
  } catch {}
  const health = healthByProfile[editingProfileId] || null;
  if (tabCount === 0) {
    els.statusPill.className = "pill warn";
    els.statusPill.textContent = "⚠ No Zendesk tab open";
  } else if (editingProfileId !== RESERVED_PROFILE_ID && matching === 0) {
    els.statusPill.className = "pill warn";
    els.statusPill.textContent = `⚠ No tab on ${editingProfileId}`;
  } else if (!health || !health.paneFound) {
    els.statusPill.className = "pill warn";
    els.statusPill.textContent = `${matching || tabCount} tab(s) — sidebar not detected`;
  } else if (health.paneViaShape) {
    els.statusPill.className = "pill warn";
    els.statusPill.textContent = `${matching || tabCount} tab(s) · using fallback selector`;
  } else {
    els.statusPill.className = "pill ok";
    els.statusPill.textContent = `✓ Live preview · ${matching || tabCount} tab(s)`;
  }
}

/* =========================== fork-state line ======================== */

function renderForkLine(section, elemId) {
  const el = document.getElementById(elemId);
  if (!el) return;
  if (editingProfileId === RESERVED_PROFILE_ID) {
    el.textContent = "";
    return;
  }
  if (store.isForked(section)) {
    el.className = "sub small section-fork";
    el.innerHTML = `This section is <strong>forked</strong> for ${editingProfileId}. <button type="button">Unfork</button>`;
    el.querySelector("button").addEventListener("click", async () => {
      if (!await confirmModal(`Unfork "${section}" so it re-inherits from default?`)) return;
      await store.unfork(section);
    });
  } else {
    el.className = "sub small section-fork inherited";
    el.innerHTML = `This section is <strong>inherited</strong> from default. <button type="button">Fork</button>`;
    el.querySelector("button").addEventListener("click", async () => {
      await store.fork(section);
    });
  }
}

/* =========================== profile switcher ====================== */

function renderProfileSwitcher() {
  els.profileSelect.innerHTML = "";
  for (const id of allProfiles) {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = id;
    if (id === editingProfileId) opt.selected = true;
    els.profileSelect.appendChild(opt);
  }
  els.profileDelete.disabled = (editingProfileId === RESERVED_PROFILE_ID);
}

function bindProfileSwitcher() {
  els.profileSelect.addEventListener("change", async () => {
    const next = els.profileSelect.value;
    if (next === editingProfileId) return;
    await switchEditingProfile(next);
  });
  els.profileNew.addEventListener("click", async () => {
    const sub = await promptModal(
      "Create profile",
      "",
      "Enter a Zendesk subdomain (e.g. acme) or full host (e.g. acme.zendesk.com)."
    );
    if (!sub) return;
    let host;
    if (sub.includes(".zendesk.com")) host = sub.replace(/^https?:\/\//, "").split("/")[0];
    else host = `${sub.replace(/[^a-z0-9-]/gi, "")}.zendesk.com`;
    if (!host || host === RESERVED_PROFILE_ID) return;
    await ensureProfileExists(host);
    allProfiles = (await loadProfileIndex()).profiles;
    await switchEditingProfile(host);
  });
  els.profileDelete.addEventListener("click", async () => {
    if (editingProfileId === RESERVED_PROFILE_ID) return;
    if (!await confirmModal(`Delete profile "${editingProfileId}" and all its settings? This cannot be undone.`)) return;
    const target = editingProfileId;
    await deleteProfile(target);
    allProfiles = (await loadProfileIndex()).profiles;
    await switchEditingProfile(RESERVED_PROFILE_ID);
  });
}

async function switchEditingProfile(id) {
  await setEditingProfileId(id);
  store = new ProfileStore(id);
  await store.load();
  await loadDiscoveryForProfile(id);
  renderAll();
}

/* ============================== modal ============================= */

function showModal(content) {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    const modal = document.createElement("div");
    modal.className = "modal";
    backdrop.appendChild(modal);
    els.modalRoot.appendChild(backdrop);
    let resolved = false;
    const close = (val) => {
      if (resolved) return;
      resolved = true;
      backdrop.remove();
      resolve(val);
    };
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(undefined); });
    document.addEventListener("keydown", function esc(e) {
      if (e.key === "Escape") { document.removeEventListener("keydown", esc); close(undefined); }
    });
    content(modal, close);
  });
}

function confirmModal(message) {
  return showModal((modal, close) => {
    modal.innerHTML = `<h3>Confirm</h3><p>${escapeHtml(message)}</p>
      <div class="actions"><button type="button" class="secondary">Cancel</button><button type="button" class="primary">Confirm</button></div>`;
    modal.querySelector(".secondary").addEventListener("click", () => close(false));
    modal.querySelector(".primary").addEventListener("click", () => close(true));
  });
}

function promptModal(title, defaultValue = "", helpText = "") {
  return showModal((modal, close) => {
    modal.innerHTML = `<h3>${escapeHtml(title)}</h3>
      ${helpText ? `<p>${escapeHtml(helpText)}</p>` : ""}
      <div class="form-row"><input type="text" /></div>
      <div class="actions"><button type="button" class="secondary">Cancel</button><button type="button" class="primary">OK</button></div>`;
    const input = modal.querySelector("input");
    input.value = defaultValue;
    input.focus(); input.select();
    modal.querySelector(".secondary").addEventListener("click", () => close(undefined));
    modal.querySelector(".primary").addEventListener("click", () => close(input.value));
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") close(input.value); });
  });
}

function checkboxModal(title, options) {
  return showModal((modal, close) => {
    const optsHtml = options.map((o, i) => `
      <label style="display:flex;align-items:center;gap:8px;padding:4px 0;font-size:13px;">
        <input type="checkbox" id="cm-${i}" ${o.checked ? "checked" : ""} />
        <span>${escapeHtml(o.label)}</span>
      </label>`).join("");
    modal.innerHTML = `<h3>${escapeHtml(title)}</h3>${optsHtml}
      <div class="actions"><button type="button" class="secondary">Cancel</button><button type="button" class="primary">OK</button></div>`;
    modal.querySelector(".secondary").addEventListener("click", () => close(undefined));
    modal.querySelector(".primary").addEventListener("click", () => {
      const selected = options.filter((_, i) => modal.querySelector(`#cm-${i}`).checked).map((o) => o.value);
      close(selected);
    });
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

/* ============================ section nav =========================== */

function bindSectionNav() {
  const nav = document.getElementById("sidenav");
  const links = nav.querySelectorAll("a[data-section]");
  const sections = Array.from(links).map((a) => document.getElementById(`sec-${a.dataset.section}`)).filter(Boolean);
  const observer = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) {
        const section = e.target.id.replace(/^sec-/, "");
        for (const link of links) link.classList.toggle("active", link.dataset.section === section);
      }
    }
  }, { rootMargin: "-30% 0px -65% 0px" });
  for (const s of sections) observer.observe(s);
}

/* ============================ render all =========================== */

function renderAll() {
  renderProfileSwitcher();
  renderGeneral();
  renderDensity();
  renderTheme();
  renderHide();
  renderCustomize();
  renderReorder();
  renderTemplates();
  renderDiag();
  refreshStatus();
}

function bindAll() {
  bindSectionNav();
  bindProfileSwitcher();
  bindGeneral();
  bindDensity();
  bindHide();
  bindCustomize();
  bindReorder();
  bindTemplates();
  bindBackup();
  els.openZendesk.addEventListener("click", async () => {
    const { lastZendeskUrl } = await new Promise((r) =>
      chrome.storage.local.get({ lastZendeskUrl: null }, r)
    );
    if (editingProfileId !== RESERVED_PROFILE_ID) {
      chrome.tabs.create({ url: `https://${editingProfileId}/agent` });
    } else if (lastZendeskUrl) {
      chrome.tabs.create({ url: lastZendeskUrl });
    } else {
      const sub = await promptModal("Open Zendesk", "", "Enter a Zendesk subdomain (e.g. acme).");
      if (!sub) return;
      const url = sub.includes("://") ? sub : `https://${sub.replace(/[^a-z0-9-]/gi, "")}.zendesk.com/agent`;
      chrome.tabs.create({ url });
    }
  });

  // Reset everything: nuke both storage areas this extension owns and reseed
  // a clean default profile. Per consensus: full clear is simpler and safer
  // than maintaining a hand-curated key prefix list.
  els.resetEverything.addEventListener("click", async () => {
    const ok = await confirmModal(
      "Reset EVERYTHING? This wipes every profile, every saved template, " +
      "all hidden lists, custom orders, custom-view styling, theme overrides, " +
      "and density settings on this device. Sync sections will also clear " +
      "across your other devices on next sync. Cannot be undone."
    );
    if (!ok) return;
    await Promise.all([
      new Promise((r) => chrome.storage.sync.clear(r)),
      new Promise((r) => chrome.storage.local.clear(r)),
    ]);
    // Reseed a minimal index + default editing target.
    await new Promise((r) => chrome.storage.sync.set({
      profileIndex: { profiles: [RESERVED_PROFILE_ID] },
    }, r));
    await new Promise((r) => chrome.storage.local.set({
      editingProfileId: RESERVED_PROFILE_ID,
    }, r));
    // Tell content scripts to drop any preview state they're holding.
    clearPreviewEverywhere();
    // Restart with the fresh default profile.
    allProfiles = [RESERVED_PROFILE_ID];
    editingProfileId = RESERVED_PROFILE_ID;
    store = new ProfileStore(RESERVED_PROFILE_ID);
    await store.load();
    views = []; groups = []; containers = [];
    healthByProfile = {}; userTemplates = [];
    expandedHidePaths.clear(); expandedCustomViewId = null;
    pendingColorEchoes.clear();
    renderAll();
  });

  // Granular re-renderers per section. Avoids blanket renderAll() which
  // destroys interactive controls (color pickers especially) when the user
  // is mid-interaction. Bug 1: native color picker dropdown closes if its
  // backing <input> gets recreated.
  const SECTION_RENDERERS = {
    prefs:       renderGeneral,
    density:     renderDensity,
    theme:       renderTheme,
    hide:        renderHide,
    order:       renderReorder,
    customViews: renderCustomize,
  };

  chrome.storage.onChanged.addListener(async (changes, area) => {
    const sections = await store.handleStorageChange(changes, area);

    // Sync: section changes are routed to per-section renderers.
    for (const section of sections) {
      // Skip re-render exactly once if this echo is the result of a
      // color-picker commit we just made — the native picker may still be
      // open and tearing down its <input> would close it.
      if (consumePendingColorEcho(section)) continue;
      const renderer = SECTION_RENDERERS[section];
      if (renderer) renderer();
    }
    // Cross-section dependents.
    if (sections.includes("prefs")) renderReorder();
    if (sections.length) renderDiag();

    if (area === "sync" && changes.profileIndex) {
      allProfiles = (changes.profileIndex.newValue?.profiles) || [RESERVED_PROFILE_ID];
      renderProfileSwitcher();
      renderDiag();
    }

    if (area !== "local") return;

    // selectorHealth changes only affect the status pill + popup health.
    // Do NOT re-render any section — that would destroy active controls.
    let healthChanged = false;
    let discoveryChanged = false;
    let templatesChanged = false;
    for (const k of Object.keys(changes)) {
      if (k.startsWith("selectorHealth:")) healthChanged = true;
      if (k === "templates") templatesChanged = true;
      if (
        (k.startsWith("discoveredViews:") ||
         k.startsWith("discoveredGroups:") ||
         k.startsWith("discoveredContainers:")) &&
        k.endsWith(`:${editingProfileId}`)
      ) discoveryChanged = true;
    }
    if (healthChanged) {
      await loadAllHealth();
      refreshStatus();
      renderDiag();
    }
    if (discoveryChanged) {
      await loadDiscoveryForProfile(editingProfileId);
      // Discovery affects sections that show discovered items.
      renderHide();
      renderCustomize();
      renderReorder();
      renderDiag();
    }
    if (templatesChanged) {
      userTemplates = changes.templates.newValue || [];
      renderTemplates();
    }
  });

  setInterval(refreshStatus, STATUS_REFRESH_MS);
}

/* ============================== boot ============================== */

(async function init() {
  bindEls();
  allProfiles = (await loadProfileIndex()).profiles;
  editingProfileId = await loadEditingProfileId();
  store = new ProfileStore(editingProfileId);
  await store.load();
  await Promise.all([
    loadDiscoveryForProfile(editingProfileId),
    loadAllHealth(),
    loadUserTemplates(),
  ]);
  bindAll();
  renderAll();
})();
