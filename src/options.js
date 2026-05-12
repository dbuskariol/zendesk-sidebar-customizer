/*
 * Zendesk Views Tweaks — options.js  (v0.3.0)
 *
 * Storage:
 *   chrome.storage.sync.settings = {
 *     enabled, compact, hiddenViewIds[], hiddenGroupPaths[],
 *     levelFontSizes: { "1": 13, ... }, levelIndents: { "2": 6, ... }
 *   }
 *   chrome.storage.local.discoveredViews = [{ id, title, href, groupPath, depth, lastSeenAt }]
 *   chrome.storage.local.discoveredGroups = [{ path, name, depth, lastSeenAt }]
 */

"use strict";

const ZENDESK_URL_MATCH = "https://github.zendesk.com/*";
const FILTER_RE = /\/agent\/filters\/(\d+)\/?(?:[?#].*)?$/;

const DEFAULT_SETTINGS = {
  enabled: true,
  compact: true,
  hiddenViewIds: [],
  hiddenGroupPaths: [],
  levelFontSizes: {},
  levelIndents: {},
};

// Suggested defaults applied when the user hits "Apply suggested defaults".
const SUGGESTED_FONT_SIZES = { 1: 14, 2: 13, 3: 12, 4: 11, 5: 11 };
const SUGGESTED_INDENTS = { 2: 6, 3: 6, 4: 4, 5: 4 };

const FONT_MIN = 8;
const FONT_MAX = 20;
const INDENT_MIN = 0;
const INDENT_MAX = 32;

const els = {
  enabled: document.getElementById("enabled"),
  compact: document.getElementById("compact"),
  search: document.getElementById("search"),
  expandAll: document.getElementById("expand-all"),
  collapseAll: document.getElementById("collapse-all"),
  showAll: document.getElementById("show-all"),
  hideAll: document.getElementById("hide-all"),
  rescan: document.getElementById("rescan"),
  status: document.getElementById("status"),
  tree: document.getElementById("tree"),
  empty: document.getElementById("empty"),
  densityGrid: document.getElementById("density-grid"),
  densityDefaults: document.getElementById("density-defaults"),
  densityReset: document.getElementById("density-reset"),
  manualForm: document.getElementById("manual-add-form"),
  manualInput: document.getElementById("manual-add-input"),
  manualTitle: document.getElementById("manual-add-title"),
  manualStatus: document.getElementById("manual-add-status"),
};

let settings = { ...DEFAULT_SETTINGS };
let views = [];
let groups = [];
const expandedPaths = new Set();
let allExpandedHinted = false;

/* ------------------------------- storage ------------------------------- */

function loadSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get({ settings: null }, (res) => {
      settings = { ...DEFAULT_SETTINGS, ...(res.settings || {}) };
      if (!Array.isArray(settings.hiddenViewIds)) settings.hiddenViewIds = [];
      if (!Array.isArray(settings.hiddenGroupPaths)) settings.hiddenGroupPaths = [];
      if (!settings.levelFontSizes) settings.levelFontSizes = {};
      if (!settings.levelIndents) settings.levelIndents = {};
      resolve();
    });
  });
}

function loadDiscovered() {
  return new Promise((resolve) => {
    chrome.storage.local.get(
      { discoveredViews: [], discoveredGroups: [] },
      (res) => {
        views = Array.isArray(res.discoveredViews) ? res.discoveredViews : [];
        groups = Array.isArray(res.discoveredGroups) ? res.discoveredGroups : [];
        resolve();
      }
    );
  });
}

function saveSettings() {
  return new Promise((resolve) => chrome.storage.sync.set({ settings }, resolve));
}

/* --------------------------- helpers / state --------------------------- */

function isViewHidden(id) {
  return settings.hiddenViewIds.includes(String(id));
}

function setViewHidden(id, hidden) {
  const sid = String(id);
  const set = new Set(settings.hiddenViewIds.map(String));
  if (hidden) set.add(sid);
  else set.delete(sid);
  settings.hiddenViewIds = Array.from(set).sort();
}

function isGroupHidden(path) {
  return settings.hiddenGroupPaths.includes(path);
}

function setGroupHidden(path, hidden) {
  const set = new Set(settings.hiddenGroupPaths);
  if (hidden) set.add(path);
  else set.delete(path);
  settings.hiddenGroupPaths = Array.from(set).sort();
}

function pathKey(path) {
  return path.join("::");
}

function maxDiscoveredDepth() {
  let max = 0;
  for (const v of views) max = Math.max(max, Number(v.depth) || 0);
  for (const g of groups) max = Math.max(max, Number(g.depth) || 0);
  return max;
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

/* ------------------------------ tree build ----------------------------- */

function buildTree(filteredViews, allGroups) {
  // root.children: Map<name, node>
  // Each node: { name, path: [...], children, views, groupPath: "::"-joined string }
  const root = { name: "", path: [], children: new Map(), views: [] };

  function ensureGroup(pathSegments) {
    let node = root;
    for (const seg of pathSegments) {
      if (!node.children.has(seg)) {
        node.children.set(seg, {
          name: seg,
          path: [...node.path, seg],
          children: new Map(),
          views: [],
        });
      }
      node = node.children.get(seg);
    }
    return node;
  }

  // Seed groups from discoveredGroups so empty groups still appear.
  for (const g of allGroups) {
    if (!g || !g.path) continue;
    ensureGroup(g.path.split("::").filter(Boolean));
  }

  // Place views into their group.
  for (const v of filteredViews) {
    const node = ensureGroup(Array.isArray(v.groupPath) ? v.groupPath : []);
    node.views.push(v);
  }
  return root;
}

function nodeStats(node) {
  let total = node.views.length;
  let hidden = node.views.filter((v) => isViewHidden(v.id)).length;
  for (const child of node.children.values()) {
    const c = nodeStats(child);
    total += c.total;
    hidden += c.hidden;
  }
  return { total, hidden, visible: total - hidden };
}

function collectLeafIds(node) {
  const ids = node.views.map((v) => String(v.id));
  for (const child of node.children.values()) {
    ids.push(...collectLeafIds(child));
  }
  return ids;
}

/* ------------------------------ rendering ------------------------------ */

function sortChildren(map) {
  return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function sortViews(arr) {
  return arr.slice().sort((a, b) => (a.title || "").localeCompare(b.title || ""));
}

function renderTree(filteredViews, hasQuery) {
  const root = buildTree(filteredViews, groups);
  els.tree.innerHTML = "";
  if (!root.views.length && root.children.size === 0) {
    els.tree.hidden = true;
    return;
  }
  els.tree.hidden = false;

  const frag = document.createDocumentFragment();
  if (root.views.length) {
    const ul = document.createElement("ul");
    ul.className = "tree-leaf-list";
    for (const v of sortViews(root.views)) ul.appendChild(renderLeaf(v));
    frag.appendChild(ul);
  }
  for (const child of sortChildren(root.children)) {
    frag.appendChild(renderGroup(child, hasQuery));
  }
  els.tree.appendChild(frag);
}

function renderGroup(node, hasQuery) {
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
    if (details.open) expandedPaths.add(groupPathStr);
    else expandedPaths.delete(groupPathStr);
  });

  const summary = document.createElement("summary");
  summary.className = "group-summary";

  // Group visibility checkbox: checked = group visible.
  const visCb = document.createElement("input");
  visCb.type = "checkbox";
  visCb.checked = !groupHidden;
  visCb.title = groupHidden ? "Show this entire group" : "Hide this entire group";
  visCb.addEventListener("click", (e) => e.stopPropagation());
  visCb.addEventListener("change", async () => {
    setGroupHidden(groupPathStr, !visCb.checked);
    await saveSettings();
    render();
  });

  const name = document.createElement("span");
  name.className = "group-name";
  name.textContent = node.name + (groupHidden ? " (hidden)" : "");

  const counts = document.createElement("span");
  counts.className = "group-counts";
  if (stats.total > 0) {
    counts.textContent =
      stats.hidden > 0 ? `${stats.visible}/${stats.total}` : `${stats.total}`;
    if (stats.hidden > 0 && stats.visible === 0) counts.classList.add("all-hidden");
  } else {
    counts.textContent = "(empty)";
    counts.classList.add("empty-group");
  }

  // Bulk toggle of leaves inside this group (does NOT touch group hide).
  const bulkBtn = document.createElement("button");
  bulkBtn.type = "button";
  bulkBtn.className = "group-bulk";
  bulkBtn.textContent = stats.hidden < stats.total ? "Hide leaves" : "Show leaves";
  bulkBtn.title = "Toggle visibility of every leaf view inside this group";
  bulkBtn.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const ids = collectLeafIds(node);
    const target = !(stats.hidden < stats.total); // true = show all, false = hide all
    const set = new Set(settings.hiddenViewIds.map(String));
    for (const id of ids) {
      if (target) set.delete(id);
      else set.add(id);
    }
    settings.hiddenViewIds = Array.from(set).sort();
    await saveSettings();
    render();
  });

  summary.appendChild(visCb);
  summary.appendChild(name);
  summary.appendChild(counts);
  if (stats.total > 0) summary.appendChild(bulkBtn);
  details.appendChild(summary);

  const body = document.createElement("div");
  body.className = "group-body";
  for (const child of sortChildren(node.children)) {
    body.appendChild(renderGroup(child, hasQuery));
  }
  if (node.views.length) {
    const ul = document.createElement("ul");
    ul.className = "tree-leaf-list";
    for (const v of sortViews(node.views)) ul.appendChild(renderLeaf(v));
    body.appendChild(ul);
  }
  details.appendChild(body);
  return details;
}

function renderLeaf(v) {
  const li = document.createElement("li");
  const hidden = isViewHidden(v.id);
  if (hidden) li.classList.add("hidden-row");

  const label = document.createElement("label");
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = !hidden;
  cb.dataset.id = v.id;
  cb.addEventListener("change", onToggleView);

  const title = document.createElement("span");
  title.className = "title";
  title.textContent = v.title || `View ${v.id}`;

  const id = document.createElement("span");
  id.className = "id";
  id.textContent = v.id;

  label.appendChild(cb);
  label.appendChild(title);
  label.appendChild(id);
  li.appendChild(label);
  return li;
}

/* ----------------------------- density panel --------------------------- */

function renderDensity() {
  els.densityGrid.innerHTML = "";

  const detected = maxDiscoveredDepth();
  const max = Math.max(detected + 1, 5);

  const head = document.createElement("div");
  head.className = "density-head";
  head.innerHTML = `
    <span></span>
    <span class="hcell">Font size (px)</span>
    <span class="hcell">Indent (px)</span>
  `;
  els.densityGrid.appendChild(head);

  for (let depth = 1; depth <= max; depth++) {
    const row = document.createElement("div");
    row.className = "density-row";
    const label = document.createElement("span");
    label.className = "level-label";
    label.textContent = `Level ${depth}`;
    if (depth > detected) label.classList.add("level-future");

    const fontInput = document.createElement("input");
    fontInput.type = "number";
    fontInput.min = String(FONT_MIN);
    fontInput.max = String(FONT_MAX);
    fontInput.placeholder = "—";
    const fv = settings.levelFontSizes[String(depth)];
    fontInput.value = fv != null ? String(fv) : "";
    fontInput.addEventListener("change", async () => {
      const raw = fontInput.value.trim();
      if (raw === "") {
        delete settings.levelFontSizes[String(depth)];
      } else {
        const n = Number(raw);
        if (!Number.isFinite(n)) return;
        settings.levelFontSizes[String(depth)] = clamp(Math.round(n), FONT_MIN, FONT_MAX);
        fontInput.value = String(settings.levelFontSizes[String(depth)]);
      }
      await saveSettings();
    });

    const indentInput = document.createElement("input");
    indentInput.type = "number";
    indentInput.min = String(INDENT_MIN);
    indentInput.max = String(INDENT_MAX);
    indentInput.placeholder = depth === 1 ? "n/a" : "—";
    if (depth === 1) {
      // Indent setting only meaningful for nested levels (depth ≥ 2).
      indentInput.disabled = true;
    } else {
      const iv = settings.levelIndents[String(depth)];
      indentInput.value = iv != null ? String(iv) : "";
      indentInput.addEventListener("change", async () => {
        const raw = indentInput.value.trim();
        if (raw === "") {
          delete settings.levelIndents[String(depth)];
        } else {
          const n = Number(raw);
          if (!Number.isFinite(n)) return;
          settings.levelIndents[String(depth)] = clamp(Math.round(n), INDENT_MIN, INDENT_MAX);
          indentInput.value = String(settings.levelIndents[String(depth)]);
        }
        await saveSettings();
      });
    }

    row.appendChild(label);
    row.appendChild(fontInput);
    row.appendChild(indentInput);
    els.densityGrid.appendChild(row);
  }

  const note = document.createElement("p");
  note.className = "sub density-note";
  note.textContent = detected
    ? `Detected max depth in your sidebar: ${detected}. Levels beyond that are configurable for future-proofing.`
    : "Visit Zendesk to populate detected depth.";
  els.densityGrid.appendChild(note);
}

async function applyDensityDefaults() {
  settings.levelFontSizes = { ...SUGGESTED_FONT_SIZES };
  settings.levelIndents = { ...SUGGESTED_INDENTS };
  await saveSettings();
  renderDensity();
}

async function clearDensity() {
  settings.levelFontSizes = {};
  settings.levelIndents = {};
  await saveSettings();
  renderDensity();
}

/* --------------------------- main render ------------------------------- */

function matchesQuery(v, q) {
  if (!q) return true;
  if ((v.title || "").toLowerCase().includes(q)) return true;
  if (String(v.id).includes(q)) return true;
  return (v.groupPath || []).join(" / ").toLowerCase().includes(q);
}

function render() {
  els.enabled.checked = !!settings.enabled;
  els.compact.checked = !!settings.compact;

  const q = (els.search.value || "").trim().toLowerCase();
  const filtered = views.filter((v) => matchesQuery(v, q));

  if (views.length === 0 && groups.length === 0) {
    els.tree.hidden = true;
    els.empty.hidden = false;
    els.status.textContent = "0 views, 0 groups discovered.";
    renderDensity();
    return;
  }
  els.empty.hidden = true;
  els.status.textContent =
    `${views.length} view${views.length === 1 ? "" : "s"}, ` +
    `${groups.length} group${groups.length === 1 ? "" : "s"} discovered. ` +
    `${settings.hiddenViewIds.length} view${settings.hiddenViewIds.length === 1 ? "" : "s"} hidden, ` +
    `${settings.hiddenGroupPaths.length} group${settings.hiddenGroupPaths.length === 1 ? "" : "s"} hidden.` +
    (q ? ` Showing ${filtered.length} matched view${filtered.length === 1 ? "" : "s"}.` : "");
  renderTree(filtered, q.length > 0);
  renderDensity();
}

/* ------------------------------- handlers ------------------------------ */

async function onToggleView(e) {
  const id = e.currentTarget.dataset.id;
  const visible = e.currentTarget.checked;
  setViewHidden(id, !visible);
  await saveSettings();
  render();
}

async function onShowAll() {
  // Show every leaf and every group (matching filter).
  const q = (els.search.value || "").trim().toLowerCase();
  const targetViews = views.filter((v) => matchesQuery(v, q));
  const set = new Set(settings.hiddenViewIds.map(String));
  for (const v of targetViews) set.delete(String(v.id));
  settings.hiddenViewIds = Array.from(set).sort();
  // Always clear all hidden groups when "Show all" is clicked.
  settings.hiddenGroupPaths = [];
  await saveSettings();
  render();
}

async function onHideAll() {
  // Hide every leaf matching the filter (groups are unchanged — use group checkboxes).
  const q = (els.search.value || "").trim().toLowerCase();
  const target = views.filter((v) => matchesQuery(v, q));
  const set = new Set(settings.hiddenViewIds.map(String));
  for (const v of target) set.add(String(v.id));
  settings.hiddenViewIds = Array.from(set).sort();
  await saveSettings();
  render();
}

function setAllExpanded(open) {
  allExpandedHinted = true;
  expandedPaths.clear();
  if (open) {
    const root = buildTree(views, groups);
    const stack = Array.from(root.children.values());
    while (stack.length) {
      const node = stack.pop();
      expandedPaths.add(pathKey(node.path));
      stack.push(...node.children.values());
    }
  }
  render();
}

function onToggleSetting(key) {
  return async (e) => {
    settings[key] = !!e.currentTarget.checked;
    await saveSettings();
    render();
  };
}

async function onRescan() {
  els.status.textContent = "Looking for an open Zendesk tab…";
  const tabs = await chrome.tabs.query({ url: ZENDESK_URL_MATCH });
  if (!tabs.length) {
    els.status.textContent =
      "No open Zendesk tab found. Open github.zendesk.com and try again.";
    return;
  }
  let ok = 0;
  for (const t of tabs) {
    try {
      const res = await chrome.tabs.sendMessage(t.id, { type: "zvt:rescan" });
      if (res && res.ok) ok++;
    } catch {
      /* no content script in that tab */
    }
  }
  if (ok === 0) {
    els.status.textContent =
      "Found Zendesk tab(s) but couldn't reach the content script. Try reloading the Zendesk tab.";
    return;
  }
  setTimeout(async () => {
    await loadDiscovered();
    render();
    els.status.textContent = `Refreshed from ${ok} tab${ok === 1 ? "" : "s"}.`;
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
    els.manualStatus.textContent =
      "Couldn't parse a view ID. Paste a URL like /agent/filters/123… or just a numeric ID.";
    return;
  }
  const title = (els.manualTitle.value || "").trim() || `View ${id}`;
  const href = `/agent/filters/${id}`;
  const already = views.find((v) => String(v.id) === id);
  if (!already) {
    views.push({
      id,
      title,
      href,
      groupPath: ["Manually added"],
      depth: 2,
      lastSeenAt: Date.now(),
      manual: true,
    });
    await new Promise((resolve) =>
      chrome.storage.local.set({ discoveredViews: views }, resolve)
    );
  }
  setViewHidden(id, true);
  await saveSettings();
  els.manualInput.value = "";
  els.manualTitle.value = "";
  els.manualStatus.textContent = `Added view ${id} to hidden list.`;
  render();
}

function bind() {
  els.enabled.addEventListener("change", onToggleSetting("enabled"));
  els.compact.addEventListener("change", onToggleSetting("compact"));
  els.search.addEventListener("input", render);
  els.expandAll.addEventListener("click", () => setAllExpanded(true));
  els.collapseAll.addEventListener("click", () => setAllExpanded(false));
  els.showAll.addEventListener("click", onShowAll);
  els.hideAll.addEventListener("click", onHideAll);
  els.rescan.addEventListener("click", onRescan);
  els.manualForm.addEventListener("submit", onManualAdd);
  els.densityDefaults.addEventListener("click", applyDensityDefaults);
  els.densityReset.addEventListener("click", clearDensity);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes.settings) {
      settings = { ...DEFAULT_SETTINGS, ...(changes.settings.newValue || {}) };
      if (!Array.isArray(settings.hiddenViewIds)) settings.hiddenViewIds = [];
      if (!Array.isArray(settings.hiddenGroupPaths)) settings.hiddenGroupPaths = [];
      if (!settings.levelFontSizes) settings.levelFontSizes = {};
      if (!settings.levelIndents) settings.levelIndents = {};
      render();
    }
    if (area === "local" && (changes.discoveredViews || changes.discoveredGroups)) {
      if (changes.discoveredViews) {
        views = Array.isArray(changes.discoveredViews.newValue)
          ? changes.discoveredViews.newValue
          : [];
      }
      if (changes.discoveredGroups) {
        groups = Array.isArray(changes.discoveredGroups.newValue)
          ? changes.discoveredGroups.newValue
          : [];
      }
      render();
    }
  });
}

(async function init() {
  await Promise.all([loadSettings(), loadDiscovered()]);
  bind();
  render();
})();
