"use strict";

const DEFAULT_SETTINGS = {
  enabled: true,
  compact: true,
  hiddenViewIds: [],
};

const els = {
  enabled: document.getElementById("enabled"),
  compact: document.getElementById("compact"),
  open: document.getElementById("open-options"),
  hint: document.getElementById("hint"),
};

let settings = { ...DEFAULT_SETTINGS };

function load() {
  return new Promise((resolve) => {
    chrome.storage.sync.get({ settings: null }, (res) => {
      settings = { ...DEFAULT_SETTINGS, ...(res.settings || {}) };
      if (!Array.isArray(settings.hiddenViewIds)) settings.hiddenViewIds = [];
      resolve();
    });
  });
}

function save() {
  return new Promise((resolve) =>
    chrome.storage.sync.set({ settings }, resolve)
  );
}

function render() {
  els.enabled.checked = !!settings.enabled;
  els.compact.checked = !!settings.compact;
  const n = settings.hiddenViewIds.length;
  els.hint.textContent =
    `${n} view${n === 1 ? "" : "s"} hidden. Settings sync across devices.`;
}

function onToggle(key) {
  return async (e) => {
    settings[key] = !!e.currentTarget.checked;
    await save();
    render();
  };
}

function onOpenOptions() {
  if (chrome.runtime.openOptionsPage) {
    chrome.runtime.openOptionsPage();
  } else {
    window.open(chrome.runtime.getURL("src/options.html"), "_blank");
  }
}

(async function init() {
  await load();
  els.enabled.addEventListener("change", onToggle("enabled"));
  els.compact.addEventListener("change", onToggle("compact"));
  els.open.addEventListener("click", onOpenOptions);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes.settings) {
      settings = { ...DEFAULT_SETTINGS, ...(changes.settings.newValue || {}) };
      render();
    }
  });
  render();
})();
