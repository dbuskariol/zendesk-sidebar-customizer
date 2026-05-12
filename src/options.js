/*
 * Zendesk Views Tweaks — options.js
 *
 * Reads/writes:
 *   - chrome.storage.sync.settings  (enabled, compact, hiddenViewIds[])
 *   - chrome.storage.local.discoveredViews  (read for the list)
 *
 * Sends "zvt:rescan" to any open github.zendesk.com tab when the user clicks
 * Refresh from open Zendesk tab.
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
  showAll: document.getElementById("show-all"),
  hideAll: document.getElementById("hide-all"),
  rescan: document.getElementById("rescan"),
  status: document.getElementById("status"),
  list: document.getElementById("view-list"),
  empty: document.getElementById("empty"),
  manualForm: document.getElementById("manual-add-form"),
  manualInput: document.getElementById("manual-add-input"),
  manualTitle: document.getElementById("manual-add-title"),
  manualStatus: document.getElementById("manual-add-status"),
};

let settings = { ...DEFAULT_SETTINGS };
let views = []; // {id, title, href, lastSeenAt}

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

function render() {
  els.enabled.checked = !!settings.enabled;
  els.compact.checked = !!settings.compact;

  const q = (els.search.value || "").trim().toLowerCase();
  const filtered = views
    .slice()
    .sort((a, b) => (a.title || "").localeCompare(b.title || ""))
    .filter((v) => {
      if (!q) return true;
      return (
        (v.title || "").toLowerCase().includes(q) ||
        String(v.id).includes(q)
      );
    });

  if (views.length === 0) {
    els.list.hidden = true;
    els.empty.hidden = false;
    els.status.textContent = "0 views discovered.";
  } else {
    els.empty.hidden = true;
    els.list.hidden = false;
    els.status.textContent =
      `${views.length} view${views.length === 1 ? "" : "s"} discovered, ` +
      `${settings.hiddenViewIds.length} hidden.` +
      (q ? ` Showing ${filtered.length}.` : "");

    els.list.innerHTML = "";
    const frag = document.createDocumentFragment();
    for (const v of filtered) {
      const li = document.createElement("li");
      const hidden = isHidden(v.id);
      if (hidden) li.classList.add("hidden-row");

      const label = document.createElement("label");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !hidden; // checked = visible
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
      frag.appendChild(li);
    }
    els.list.appendChild(frag);
  }
}

async function onToggleView(e) {
  const id = e.currentTarget.dataset.id;
  const visible = e.currentTarget.checked;
  setHidden(id, !visible);
  await saveSettings();
  render();
}

async function onShowAll() {
  settings.hiddenViewIds = [];
  await saveSettings();
  render();
}

async function onHideAll() {
  // Hide every discovered view (matching the current search, if any).
  const q = (els.search.value || "").trim().toLowerCase();
  const target = views.filter((v) => {
    if (!q) return true;
    return (
      (v.title || "").toLowerCase().includes(q) ||
      String(v.id).includes(q)
    );
  });
  const set = new Set(settings.hiddenViewIds.map(String));
  for (const v of target) set.add(String(v.id));
  settings.hiddenViewIds = Array.from(set).sort();
  await saveSettings();
  render();
}

function onToggleSetting(key) {
  return async (e) => {
    settings[key] = !!e.currentTarget.checked;
    await saveSettings();
    render();
  };
}

function onSearch() {
  render();
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
      // Tab loaded before extension installed/updated — content script not present.
    }
  }
  if (ok === 0) {
    els.status.textContent =
      "Found Zendesk tabs but couldn't reach the content script. Try reloading the Zendesk tab.";
    return;
  }
  // Give the content script a beat to discover and persist, then refresh list.
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

  // Add to discovered (so it appears in the list) and to hidden (since the
  // user is presumably adding it to hide it).
  const already = views.find((v) => String(v.id) === id);
  if (!already) {
    views.push({ id, title, href, lastSeenAt: Date.now(), manual: true });
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
  els.search.addEventListener("input", onSearch);
  els.showAll.addEventListener("click", onShowAll);
  els.hideAll.addEventListener("click", onHideAll);
  els.rescan.addEventListener("click", onRescan);
  els.manualForm.addEventListener("submit", onManualAdd);

  // Live update if storage changes elsewhere (e.g. popup toggles, content script writes).
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
