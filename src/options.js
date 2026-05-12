/*
 * Zendesk Views Tweaks — options.js
 *
 * Renders the discovered views as a nested tree, grouped by `groupPath`
 * (which the content script captures from each view's enclosing
 * ul[data-test-id^="views_views-tree_container-children_<path>"]).
 *
 * Storage:
 *   - chrome.storage.sync.settings  { enabled, compact, hiddenViewIds: string[] }
 *   - chrome.storage.local.discoveredViews  [{ id, title, href, groupPath, lastSeenAt }]
 */

"use strict";

const ZENDESK_URL_MATCH = "https://github.zendesk.com/*";
const FILTER_RE = /\/agent\/filters\/(\d+)\/?(?:[?#].*)?$/;

const DEFAULT_SETTINGS = {
  enabled: true,
  compact: true,
  hiddenViewIds: [],
};

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
  manualForm: document.getElementById("manual-add-form"),
  manualInput: document.getElementById("manual-add-input"),
  manualTitle: document.getElementById("manual-add-title"),
  manualStatus: document.getElementById("manual-add-status"),
};

let settings = { ...DEFAULT_SETTINGS };
let views = []; // { id, title, href, groupPath, lastSeenAt }
// Persisted-in-memory expanded state of group paths during this session.
const expandedPaths = new Set();
let allExpandedHinted = false;

function loadSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get({ settings: null }, (res) => {
      settings = { ...DEFAULT_SETTINGS, ...(res.settings || {}) };
      if (!Array.isArray(settings.hiddenViewIds)) settings.hiddenViewIds = [];
      resolve();
    });
  });
}

function loadDiscovered() {
  return new Promise((resolve) => {
    chrome.storage.local.get({ discoveredViews: [] }, (res) => {
      views = Array.isArray(res.discoveredViews) ? res.discoveredViews : [];
      resolve();
    });
  });
}

function saveSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.set({ settings }, resolve);
  });
}

function isHidden(id) {
  return settings.hiddenViewIds.includes(String(id));
}

function setHidden(id, hidden) {
  const sid = String(id);
  const set = new Set(settings.hiddenViewIds.map(String));
  if (hidden) set.add(sid);
  else set.delete(sid);
  settings.hiddenViewIds = Array.from(set).sort();
}

/* ----------------------------- tree building ---------------------------- */

function buildTree(filtered) {
  // Root node: { name, path: [...], children: Map<name, node>, views: [] }
  const root = { name: "", path: [], children: new Map(), views: [] };
  for (const v of filtered) {
    let node = root;
    const path = Array.isArray(v.groupPath) ? v.groupPath : [];
    for (const seg of path) {
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
    node.views.push(v);
  }
  return root;
}

function nodeStats(node) {
  let total = node.views.length;
  let hidden = node.views.filter((v) => isHidden(v.id)).length;
  for (const child of node.children.values()) {
    const c = nodeStats(child);
    total += c.total;
    hidden += c.hidden;
  }
  return { total, hidden, visible: total - hidden };
}

function collectViewIdsInNode(node) {
  const ids = node.views.map((v) => String(v.id));
  for (const child of node.children.values()) {
    ids.push(...collectViewIdsInNode(child));
  }
  return ids;
}

/* ------------------------------ rendering ------------------------------- */

function pathKey(path) {
  return path.join("::");
}

function renderTree(filteredViews, hasQuery) {
  const root = buildTree(filteredViews);
  els.tree.innerHTML = "";
  if (!root.views.length && root.children.size === 0) {
    els.tree.hidden = true;
    return;
  }
  els.tree.hidden = false;

  const frag = document.createDocumentFragment();

  // Render any orphan views (no groupPath) at the very top.
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

function sortChildren(map) {
  return Array.from(map.values()).sort((a, b) =>
    a.name.localeCompare(b.name)
  );
}

function sortViews(arr) {
  return arr.slice().sort((a, b) => (a.title || "").localeCompare(b.title || ""));
}

function renderGroup(node, hasQuery) {
  const stats = nodeStats(node);
  const details = document.createElement("details");
  details.className = "group";
  // Open if user hinted, or auto-open while searching, or by default on first render.
  const key = pathKey(node.path);
  const open = hasQuery || expandedPaths.has(key) || !allExpandedHinted;
  if (open) details.open = true;
  details.dataset.path = key;
  details.addEventListener("toggle", () => {
    if (details.open) expandedPaths.add(key);
    else expandedPaths.delete(key);
  });

  const summary = document.createElement("summary");
  summary.className = "group-summary";

  const allHidden = stats.total > 0 && stats.hidden === stats.total;
  const noneHidden = stats.hidden === 0;
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.indeterminate = !allHidden && !noneHidden;
  cb.checked = noneHidden; // checked = all visible
  cb.title = "Toggle entire group";
  cb.addEventListener("click", (e) => e.stopPropagation());
  cb.addEventListener("change", async () => {
    const ids = collectViewIdsInNode(node);
    const target = cb.checked; // true = make all visible
    const set = new Set(settings.hiddenViewIds.map(String));
    for (const id of ids) {
      if (target) set.delete(id);
      else set.add(id);
    }
    settings.hiddenViewIds = Array.from(set).sort();
    await saveSettings();
    render();
  });

  const name = document.createElement("span");
  name.className = "group-name";
  name.textContent = node.name;

  const counts = document.createElement("span");
  counts.className = "group-counts";
  counts.textContent =
    stats.hidden > 0
      ? `${stats.visible}/${stats.total}`
      : `${stats.total}`;
  if (stats.hidden > 0 && stats.visible === 0) counts.classList.add("all-hidden");

  summary.appendChild(cb);
  summary.appendChild(name);
  summary.appendChild(counts);
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
  const hidden = isHidden(v.id);
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

/* ------------------------------- main render --------------------------- */

function matchesQuery(v, q) {
  if (!q) return true;
  if ((v.title || "").toLowerCase().includes(q)) return true;
  if (String(v.id).includes(q)) return true;
  const path = (v.groupPath || []).join(" / ").toLowerCase();
  return path.includes(q);
}

function render() {
  els.enabled.checked = !!settings.enabled;
  els.compact.checked = !!settings.compact;

  const q = (els.search.value || "").trim().toLowerCase();
  const filtered = views.filter((v) => matchesQuery(v, q));

  if (views.length === 0) {
    els.tree.hidden = true;
    els.empty.hidden = false;
    els.status.textContent = "0 views discovered.";
    return;
  }
  els.empty.hidden = true;
  els.status.textContent =
    `${views.length} view${views.length === 1 ? "" : "s"} discovered, ` +
    `${settings.hiddenViewIds.length} hidden.` +
    (q ? ` Showing ${filtered.length}.` : "");
  renderTree(filtered, q.length > 0);
}

/* ------------------------------- handlers ------------------------------ */

async function onToggleView(e) {
  const id = e.currentTarget.dataset.id;
  const visible = e.currentTarget.checked;
  setHidden(id, !visible);
  await saveSettings();
  render();
}

async function onShowAll() {
  // Show all currently filtered views (or all if no filter).
  const q = (els.search.value || "").trim().toLowerCase();
  const target = views.filter((v) => matchesQuery(v, q));
  const set = new Set(settings.hiddenViewIds.map(String));
  for (const v of target) set.delete(String(v.id));
  settings.hiddenViewIds = Array.from(set).sort();
  await saveSettings();
  render();
}

async function onHideAll() {
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
    // Walk the full tree and expand every group.
    const root = buildTree(views);
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
      /* content script not present in that tab */
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
      lastSeenAt: Date.now(),
      manual: true,
    });
    await new Promise((resolve) =>
      chrome.storage.local.set({ discoveredViews: views }, resolve)
    );
  }
  setHidden(id, true);
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

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes.settings) {
      settings = { ...DEFAULT_SETTINGS, ...(changes.settings.newValue || {}) };
      render();
    }
    if (area === "local" && changes.discoveredViews) {
      views = Array.isArray(changes.discoveredViews.newValue)
        ? changes.discoveredViews.newValue
        : [];
      render();
    }
  });
}

(async function init() {
  await Promise.all([loadSettings(), loadDiscovered()]);
  bind();
  render();
})();
