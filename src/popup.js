"use strict";

const DEFAULT_PREFS = {
  schemaVersion: 2,
  enabled: true,
  compact: true,
  reorderEnabled: false,
};

const els = {
  enabled: document.getElementById("enabled"),
  compact: document.getElementById("compact"),
  reorder: document.getElementById("reorder"),
  open: document.getElementById("open-options"),
  hint: document.getElementById("hint"),
  health: document.getElementById("health"),
  healthText: document.getElementById("health-text"),
};

let prefs = { ...DEFAULT_PREFS };
let health = null;
let hideCount = 0;

function loadAll() {
  return Promise.all([
    new Promise((r) =>
      chrome.storage.sync.get({ prefs: null, hide: null }, (res) => {
        prefs = { ...DEFAULT_PREFS, ...(res.prefs || {}) };
        const h = res.hide || {};
        hideCount = (Array.isArray(h.v) ? h.v.length : 0) + (Array.isArray(h.g) ? h.g.length : 0);
        r();
      })
    ),
    new Promise((r) =>
      chrome.storage.local.get({ selectorHealth: null }, (res) => {
        health = res.selectorHealth || null;
        r();
      })
    ),
  ]);
}

function save() {
  return new Promise((r) => chrome.storage.sync.set({ prefs }, r));
}

function render() {
  els.enabled.checked = !!prefs.enabled;
  els.compact.checked = !!prefs.compact;
  els.reorder.checked = !!prefs.reorderEnabled;
  els.hint.textContent = `${hideCount} item${hideCount === 1 ? "" : "s"} hidden. Settings sync across devices.`;

  if (!health) {
    els.health.className = "health";
    els.healthText.textContent = "";
    return;
  }
  if (!health.paneFound) {
    els.health.className = "health warn";
    els.healthText.textContent = "Sidebar not detected. Open github.zendesk.com/agent.";
  } else if (health.viewCount === 0) {
    els.health.className = "health warn";
    els.healthText.textContent = "Sidebar found but no views detected.";
  } else if (health.paneViaShape) {
    els.health.className = "health warn";
    els.healthText.textContent = `Using fallback selector. ${health.viewCount} views, ${health.folderCount} groups.`;
  } else {
    els.health.className = "health ok";
    els.healthText.textContent = `${health.viewCount} views, ${health.folderCount} groups detected.`;
  }
}

function onToggle(key) {
  return async (e) => {
    prefs[key] = !!e.currentTarget.checked;
    await save();
    render();
  };
}

function onOpenOptions() {
  if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
  else window.open(chrome.runtime.getURL("src/options.html"), "_blank");
}

(async function init() {
  await loadAll();
  els.enabled.addEventListener("change", onToggle("enabled"));
  els.compact.addEventListener("change", onToggle("compact"));
  els.reorder.addEventListener("change", onToggle("reorderEnabled"));
  els.open.addEventListener("click", onOpenOptions);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && (changes.prefs || changes.hide)) {
      loadAll().then(render);
    }
    if (area === "local" && changes.selectorHealth) {
      health = changes.selectorHealth.newValue || null;
      render();
    }
  });
  render();
})();
