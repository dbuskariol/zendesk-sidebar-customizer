"use strict";

const { ProfileStore, RESERVED_PROFILE_ID, loadProfileIndex, ensureProfileExists, migrateProfileIndexV07 } = window.ZVT;

const SHARED_DEFAULTS_LABEL = "Shared defaults";
const profileLabel = (id) => (id === RESERVED_PROFILE_ID ? SHARED_DEFAULTS_LABEL : id);

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
let activeHost = null; // the actual current Zendesk tab host (may not be a profile)
let store = null;
let healthByHost = {};
let lastHost = null;
let dismissedHosts = [];

/**
 * Determine the host for the active Zendesk tab right now.
 * Returns null if no Zendesk tab is in front. Does NOT fall back to
 * lastZendeskHost — that's used as a separate signal so the popup never
 * silently edits a profile that doesn't match what's on screen.
 */
async function determineActiveHost() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const t = tabs && tabs[0];
    if (t && t.url) {
      const u = new URL(t.url);
      if (/\.zendesk\.com$/.test(u.host)) return u.host;
    }
  } catch {}
  return null;
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
  const all = await new Promise((r) => chrome.storage.local.get(null, r));
  healthByHost = {};
  for (const [k, v] of Object.entries(all)) {
    if (!k.startsWith("selectorHealth:")) continue;
    const profileId = k.slice("selectorHealth:".length);
    healthByHost[profileId] = v;
  }
  lastHost = all.lastZendeskHost || null;
}

/**
 * Recompute which profile to edit + reload the store. Called both on init
 * and whenever the user switches tabs while the popup is open.
 *
 * Resolution order:
 *   1. The active Zendesk tab's host (if it has a profile, edit that;
 *      otherwise edit Shared defaults — which is what would actually apply).
 *   2. Shared defaults.
 */
async function rebindActiveProfile() {
  const host = await determineActiveHost();
  activeHost = host;
  let nextProfile;
  if (host) {
    const idx = await loadProfileIndex();
    nextProfile = idx.profiles.includes(host) ? host : RESERVED_PROFILE_ID;
  } else {
    nextProfile = RESERVED_PROFILE_ID;
  }
  if (nextProfile !== activeProfileId || !store) {
    activeProfileId = nextProfile;
    store = new ProfileStore(activeProfileId);
    await store.load();
  }
  render();
}

async function init() {
  // Migration is idempotent and self-short-circuiting.
  await migrateProfileIndexV07().catch(() => {});
  await Promise.all([loadDismissed(), loadHealth()]);
  await rebindActiveProfile();
  bind();

  chrome.storage.onChanged.addListener(async (changes, area) => {
    const sections = await store?.handleStorageChange(changes, area);
    if (sections?.length) render();
    if (area === "local") {
      const refresh = Object.keys(changes).some((k) =>
        k.startsWith("selectorHealth:") || k === "lastZendeskHost" || k === "dismissedSuggestions"
      );
      if (refresh) {
        await Promise.all([loadDismissed(), loadHealth()]);
        render();
      }
    }
    if (area === "sync" && changes.profileIndex) {
      // A profile was created/deleted elsewhere — re-resolve which we should edit.
      rebindActiveProfile();
    }
  });

  // Live updates while the popup is open. Popups are short-lived so this
  // teardown happens automatically when the popup closes.
  if (chrome.tabs?.onActivated)  chrome.tabs.onActivated.addListener(rebindActiveProfile);
  if (chrome.tabs?.onUpdated)    chrome.tabs.onUpdated.addListener((id, info) => {
    if (info.status === "complete" || info.url) rebindActiveProfile();
  });
  if (chrome.windows?.onFocusChanged) chrome.windows.onFocusChanged.addListener(rebindActiveProfile);
  // Also listen for content-script mount announcements so the popup
  // updates instantly when a new Zendesk tab comes alive.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "zvt:tabMounted") rebindActiveProfile();
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
    if (!activeHost) return;
    await ensureProfileExists(activeHost);
    // Tell the options page (if open) to switch to this new profile.
    await new Promise((r) => chrome.storage.local.set({ editingProfileId: activeHost }, r));
    // Re-resolve so the popup itself starts editing the new profile.
    await rebindActiveProfile();
    if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
  });
  els.suggestDismiss.addEventListener("click", async () => {
    if (!activeHost) return;
    const next = Array.from(new Set([...dismissedHosts, activeHost]));
    await new Promise((r) => chrome.storage.local.set({ dismissedSuggestions: next }, r));
    els.suggest.hidden = true;
  });
}

function render() {
  if (!store) return;
  const prefs = store.resolve("prefs");
  // Show the user EXACTLY which profile they're editing right now, including
  // the underlying tab if defaults are being used because no profile exists yet.
  if (activeProfileId === RESERVED_PROFILE_ID && activeHost) {
    els.profileCurrent.textContent = `${SHARED_DEFAULTS_LABEL} → ${activeHost}`;
  } else {
    els.profileCurrent.textContent = profileLabel(activeProfileId);
  }
  els.enabled.checked = !!prefs.enabled;
  els.compact.checked = !!prefs.compact;
  els.themed.checked = !!prefs.themed;
  els.reorderEnabled.checked = !!prefs.reorderEnabled;
  renderSuggest();
  renderHealth();
}

async function renderSuggest() {
  els.suggest.hidden = true;
  // Suggest creating a profile only when there's an active Zendesk tab AND
  // it has no dedicated profile yet AND the user hasn't dismissed it.
  if (!activeHost) return;
  const idx = await loadProfileIndex();
  if (idx.profiles.includes(activeHost)) return;
  if (dismissedHosts.includes(activeHost)) return;
  els.suggestText.textContent =
    `${activeHost} is using ${SHARED_DEFAULTS_LABEL}. Create a dedicated profile so this tenant can have its own settings?`;
  els.suggest.hidden = false;
}

function renderHealth() {
  // Show health for the host the popup is actually relevant to:
  // active tab if any, else the profile being edited.
  const target = activeHost || activeProfileId;
  const h = healthByHost[target];
  if (!h) {
    els.health.className = "health";
    els.healthText.textContent = "";
    return;
  }
  if (!h.paneFound) {
    els.health.className = "health warn";
    els.healthText.textContent = `Sidebar not detected on ${target}.`;
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
