"use strict";

const { ProfileStore, RESERVED_PROFILE_ID, loadProfileIndex, ensureProfileExists } = window.ZVT;

const els = {
  profileCurrent: document.getElementById("profile-current"),
  enabled: document.getElementById("enabled"),
  compact: document.getElementById("compact"),
  themed: document.getElementById("themed"),
  reorderEnabled: document.getElementById("reorderEnabled"),
  open: document.getElementById("open-options"),
  hint: document.getElementById("hint"),
  health: document.getElementById("health"),
  healthText: document.getElementById("health-text"),
  suggest: document.getElementById("suggest"),
  suggestText: document.getElementById("suggest-text"),
  suggestCreate: document.getElementById("suggest-create"),
  suggestDismiss: document.getElementById("suggest-dismiss"),
};

let activeProfileId = RESERVED_PROFILE_ID;
let store = null;
let healthByHost = {};
let lastHost = null;
let dismissedHosts = [];

async function determineActiveProfile() {
  // Read the current Zendesk tab in the active window if any.
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const t = tabs && tabs[0];
    if (t && t.url) {
      const u = new URL(t.url);
      if (/\.zendesk\.com$/.test(u.host)) return u.host;
    }
  } catch {}
  // Fallback: most recent host the content script saw.
  return new Promise((r) =>
    chrome.storage.local.get({ lastZendeskHost: null }, (res) => {
      r(res.lastZendeskHost || RESERVED_PROFILE_ID);
    })
  );
}

async function loadDismissed() {
  return new Promise((r) =>
    chrome.storage.local.get({ dismissedSuggestions: [] }, (res) => {
      dismissedHosts = Array.isArray(res.dismissedSuggestions) ? res.dismissedSuggestions : [];
      r();
    })
  );
}

async function loadHealth() {
  // Pull all selectorHealth:* keys.
  const all = await new Promise((r) => chrome.storage.local.get(null, r));
  healthByHost = {};
  for (const [k, v] of Object.entries(all)) {
    if (!k.startsWith("selectorHealth:")) continue;
    const profileId = k.slice("selectorHealth:".length);
    healthByHost[profileId] = v;
  }
  lastHost = all.lastZendeskHost || null;
}

async function init() {
  activeProfileId = await determineActiveProfile();
  await Promise.all([loadDismissed(), loadHealth()]);
  store = new ProfileStore(activeProfileId);
  await store.load();
  bind();
  render();
  chrome.storage.onChanged.addListener(async (changes, area) => {
    const sections = await store.handleStorageChange(changes, area);
    if (sections.length) render();
    if (area === "local") {
      const refresh = Object.keys(changes).some((k) =>
        k.startsWith("selectorHealth:") || k === "lastZendeskHost" || k === "dismissedSuggestions"
      );
      if (refresh) {
        await Promise.all([loadDismissed(), loadHealth()]);
        render();
      }
    }
  });
}

function bind() {
  for (const key of ["enabled", "compact", "themed", "reorderEnabled"]) {
    els[key].addEventListener("change", async () => {
      await store.update("prefs", { [key]: !!els[key].checked });
    });
  }
  els.open.addEventListener("click", () => {
    if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
    else window.open(chrome.runtime.getURL("src/options.html"), "_blank");
  });
  els.suggestCreate.addEventListener("click", async () => {
    const idx = await loadProfileIndex();
    if (!idx.profiles.includes(lastHost)) {
      await ensureProfileExists(lastHost);
    }
    // Switch options page to this new profile by writing editingProfileId.
    await new Promise((r) => chrome.storage.local.set({ editingProfileId: lastHost }, r));
    if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
  });
  els.suggestDismiss.addEventListener("click", async () => {
    if (!lastHost) return;
    const next = Array.from(new Set([...dismissedHosts, lastHost]));
    await new Promise((r) => chrome.storage.local.set({ dismissedSuggestions: next }, r));
    els.suggest.hidden = true;
  });
}

function render() {
  if (!store) return;
  const prefs = store.resolve("prefs");
  els.profileCurrent.textContent = activeProfileId;
  els.enabled.checked = !!prefs.enabled;
  els.compact.checked = !!prefs.compact;
  els.themed.checked = !!prefs.themed;
  els.reorderEnabled.checked = !!prefs.reorderEnabled;
  renderSuggest();
  renderHealth();
}

async function renderSuggest() {
  els.suggest.hidden = true;
  if (!lastHost) return;
  if (lastHost === activeProfileId) return; // already on this tenant's profile
  const idx = await loadProfileIndex();
  if (idx.profiles.includes(lastHost)) return;
  if (dismissedHosts.includes(lastHost)) return;
  els.suggestText.textContent =
    `Detected new tenant ${lastHost}. Create a profile so you can customize it independently?`;
  els.suggest.hidden = false;
}

function renderHealth() {
  const h = healthByHost[activeProfileId];
  if (!h) {
    els.health.className = "health";
    els.healthText.textContent = "";
    return;
  }
  if (!h.paneFound) {
    els.health.className = "health warn";
    els.healthText.textContent = `Sidebar not detected on ${activeProfileId}.`;
  } else if (h.viewCount === 0) {
    els.health.className = "health warn";
    els.healthText.textContent = "Sidebar found but no views detected.";
  } else if (h.paneViaShape) {
    els.health.className = "health warn";
    els.healthText.textContent = `Using fallback selector. ${h.viewCount} views, ${h.folderCount} groups.`;
  } else if (h.reorderDomFellBack) {
    els.health.className = "health warn";
    els.healthText.textContent = `DOM reorder fell back to CSS (churn detected).`;
  } else {
    els.health.className = "health ok";
    els.healthText.textContent = `${h.viewCount} views, ${h.folderCount} groups.`;
  }
}

init();
