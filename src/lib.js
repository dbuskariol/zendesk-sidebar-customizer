/*
 * Zendesk Sidebar Customizer — lib.js  (v0.6.4)
 *
 * Shared library loaded by content scripts, options page, and popup.
 * Exposes a single `window.ZVT` namespace.
 *
 * No build step. Plain ES script. Content scripts and page scripts both
 * read `window.ZVT` after this file loads.
 */

(() => {
  "use strict";
  if (window.ZVT) return; // idempotent across re-injection

  /* ============================== selectors ============================ */

  const SELECTORS = Object.freeze({
    pane: {
      primary: 'nav[aria-label="Views"]',
      alternates: [
        '[data-test-id="views_views-pane_content"]',
        '[data-test-id="views_views-pane-div"]',
        'ul[data-test-id="views_views-tree_container"]',
      ],
    },
    viewAnchor:     'a[data-test-id^="views_views-list_item-view-"]',
    folderAnchor:   'a[data-test-id^="views_views-list_item-folder-"]',
    childContainer: 'ul[data-test-id^="views_views-tree_container-children_"]',
    countBadge:     '[data-test-id="views_views-list_item_count"]',
    outerContainer: 'ul[data-test-id="views_views-tree_container"]',
  });

  const PREFIXES = Object.freeze({
    VIEW_TID:    "views_views-list_item-view-",
    FOLDER_TID:  "views_views-list_item-folder-",
    TREE_OUTER:  "views_views-tree_container",
    TREE_CHILD:  "views_views-tree_container-children_",
    COUNT_TID:   "views_views-list_item_count",
  });

  const RE = Object.freeze({
    VIEW_ID:    new RegExp("^" + PREFIXES.VIEW_TID.replace(/[-_]/g, "\\$&") + "(\\d+)$"),
    FILTER_URL: /^\/agent\/filters\/(\d+)\/?$/,
    FILTER_LOOSE: /\/agent\/filters\/(\d+)\/?(?:[?#].*)?$/,
  });

  /* ============================== defaults ============================ */

  // Defaults: compact / themed both OFF. The extension is "enabled" (will
  // discover, respond to messages, persist the catalog) but applies NO
  // styling to the Zendesk sidebar until the user explicitly opts in.
  // Reset-all + fresh install = pristine Zendesk look.
  const DEFAULT_PREFS = Object.freeze({
    enabled: true,
    compact: false,
    themed: false,
    reorderEnabled: false,
    reorderMode: "css", // "css" | "dom"
  });

  const DEFAULT_HIDE = Object.freeze({ v: [], g: [] });

  const DEFAULT_DENSITY = Object.freeze({
    level: {},
    global: {
      rowGap: null,
      iconSize: null,
      countBadgeFontSize: null,
      countBadgeLineHeight: null,
      countBadgeMargin: null,
      countBadgePadding: null,
    },
  });

  const DEFAULT_ORDER = Object.freeze({});

  const DEFAULT_THEME = Object.freeze({
    palette: {
      bg: null, fg: null,
      hover: null, selected: null,
      accent: null, danger: null,
      badgeBg: null, badgeFg: null,
      focusRing: null, activeStripe: null,
    },
    level: {},
  });

  const DEFAULT_CUSTOM_VIEWS = Object.freeze({});

  /* ========================== section strategy ======================== */

  // The single source of truth for every settings section.
  // - area:  which chrome.storage to use
  // - merge: how a per-tenant profile combines with default
  //          "deep"    — partial overrides; missing keys inherit from default
  //          "replace" — binary: tenant either has its own value, or uses default verbatim
  // - getDefault: factory returning a fresh defaults object
  // - validate: returns a sanitized copy (clamps, drops unknown keys)
  const SECTION_STRATEGY = Object.freeze({
    prefs: {
      area: "sync",
      merge: "deep",
      getDefault: () => structuredClone(DEFAULT_PREFS),
      validate: validatePrefs,
    },
    theme: {
      area: "sync",
      merge: "deep",
      getDefault: () => structuredClone(DEFAULT_THEME),
      validate: validateTheme,
    },
    density: {
      area: "sync",
      merge: "deep",
      getDefault: () => structuredClone(DEFAULT_DENSITY),
      validate: validateDensity,
    },
    hide: {
      area: "local",
      merge: "replace",
      getDefault: () => structuredClone(DEFAULT_HIDE),
      validate: validateHide,
    },
    order: {
      area: "local",
      merge: "replace",
      getDefault: () => structuredClone(DEFAULT_ORDER),
      validate: validateOrder,
    },
    customViews: {
      area: "local",
      merge: "replace",
      getDefault: () => structuredClone(DEFAULT_CUSTOM_VIEWS),
      validate: validateCustomViews,
    },
  });

  const SECTION_NAMES = Object.freeze(Object.keys(SECTION_STRATEGY));
  const RESERVED_PROFILE_ID = "default";

  /* ========================== validation ========================== */

  function asBool(v, fb) { return typeof v === "boolean" ? v : fb; }
  function asString(v, fb = null) { return typeof v === "string" && v.length ? v : fb; }
  function asNum(v, lo, hi, fb = null) {
    const n = Number(v);
    if (!Number.isFinite(n)) return fb;
    return Math.max(lo, Math.min(hi, n));
  }
  function asColor(v) {
    if (typeof v !== "string" || !v) return null;
    // Accept CSS color strings; basic hex / rgb / rgba / hsl validation.
    return /^(#[0-9a-f]{3,8}|rgba?\([^)]+\)|hsla?\([^)]+\)|[a-z]+)$/i.test(v) ? v : null;
  }

  function validatePrefs(v) {
    const d = DEFAULT_PREFS;
    return {
      enabled:        asBool(v?.enabled, d.enabled),
      compact:        asBool(v?.compact, d.compact),
      themed:         asBool(v?.themed, d.themed),
      reorderEnabled: asBool(v?.reorderEnabled, d.reorderEnabled),
      reorderMode:    v?.reorderMode === "dom" ? "dom" : "css",
    };
  }

  function validateHide(v) {
    return {
      v: Array.isArray(v?.v) ? v.v.map(String).filter((s) => /^\d+$/.test(s)) : [],
      g: Array.isArray(v?.g) ? v.g.map(String).filter(Boolean) : [],
    };
  }

  function validateOrder(v) {
    if (!v || typeof v !== "object") return {};
    const out = {};
    for (const [scope, arr] of Object.entries(v)) {
      if (typeof scope !== "string" || !scope) continue;
      if (!Array.isArray(arr)) continue;
      out[scope] = arr.map(String).filter(Boolean);
    }
    return out;
  }

  const LEVEL_TOKEN_RANGES = Object.freeze({
    fontSize:         { min: 8, max: 32 },
    lineHeight:       { min: 8, max: 40 },
    rowPaddingTop:    { min: 0, max: 24 },
    rowPaddingBottom: { min: 0, max: 24 },
    rowPaddingLeft:   { min: 0, max: 32 },
    rowPaddingRight:  { min: 0, max: 32 },
    rowMinHeight:     { min: 0, max: 48 },
    indent:           { min: 0, max: 48 },
  });
  const GLOBAL_TOKEN_RANGES = Object.freeze({
    rowGap:               { min: 0, max: 16 },
    iconSize:             { min: 8, max: 32 },
    countBadgeFontSize:   { min: 8, max: 20 },
    countBadgeLineHeight: { min: 8, max: 28 },
    countBadgeMargin:     { min: 0, max: 24 },
    countBadgePadding:    { min: 0, max: 12 },
  });

  // Zendesk's intrinsic computed values for the views sidebar, measured
  // from a live tenant via the Calibration probe in README.md (run it on
  // your own tenant if upstream Zendesk changes these).
  //
  // Key insight: most of Zendesk's vertical spacing comes from
  // `min-height: 40px` on each anchor, NOT from padding (which is 0/0).
  // Our static compact.css sets min-height: 0 to shrink rows; the
  // rowMinHeight token overrides that per-level if you want fixed-height
  // rows back.
  const INTRINSIC_LEVEL = Object.freeze({
    fontSize: 14,
    lineHeight: 18,
    rowPaddingTop: 0,
    rowPaddingBottom: 0,
    rowPaddingLeft: 12,
    rowPaddingRight: 20,
    rowMinHeight: 40,
    indent: 4,
  });
  const INTRINSIC_GLOBAL = Object.freeze({
    rowGap: 0,
    iconSize: 12,
    countBadgeFontSize: 14,
    countBadgeLineHeight: 18,
    countBadgeMargin: 0,
    countBadgePadding: 0,
  });

  function validateDensity(v) {
    const out = { level: {}, global: { ...DEFAULT_DENSITY.global } };
    if (v?.level && typeof v.level === "object") {
      for (const [d, tokens] of Object.entries(v.level)) {
        const depth = Number(d);
        if (!Number.isFinite(depth) || depth < 1 || depth > 12) continue;
        const cleaned = {};
        for (const [k, raw] of Object.entries(tokens || {})) {
          const range = LEVEL_TOKEN_RANGES[k];
          if (!range) continue;
          const n = asNum(raw, range.min, range.max, null);
          if (n != null) cleaned[k] = Math.round(n);
        }
        if (Object.keys(cleaned).length) out.level[String(depth)] = cleaned;
      }
    }
    if (v?.global && typeof v.global === "object") {
      for (const [k, raw] of Object.entries(v.global)) {
        const range = GLOBAL_TOKEN_RANGES[k];
        if (!range) continue;
        out.global[k] = raw == null ? null : asNum(raw, range.min, range.max, null);
      }
    }
    return out;
  }

  function validateTheme(v) {
    const out = { palette: { ...DEFAULT_THEME.palette }, level: {} };
    if (v?.palette && typeof v.palette === "object") {
      for (const k of Object.keys(DEFAULT_THEME.palette)) {
        out.palette[k] = asColor(v.palette[k]);
      }
    }
    if (v?.level && typeof v.level === "object") {
      for (const [d, lvl] of Object.entries(v.level)) {
        const depth = Number(d);
        if (!Number.isFinite(depth) || depth < 1 || depth > 12) continue;
        const cleaned = {};
        const bg = asColor(lvl?.bgColor); if (bg) cleaned.bgColor = bg;
        const fg = asColor(lvl?.fgColor); if (fg) cleaned.fgColor = fg;
        if (Object.keys(cleaned).length) out.level[String(depth)] = cleaned;
      }
    }
    return out;
  }

  const FONT_WEIGHTS = new Set(["normal", "bold", "100", "200", "300", "400", "500", "600", "700", "800", "900"]);
  function validateCustomViews(v) {
    if (!v || typeof v !== "object") return {};
    const out = {};
    for (const [id, cv] of Object.entries(v)) {
      if (!/^\d+$/.test(String(id))) continue;
      if (!cv || typeof cv !== "object") continue;
      const cleaned = {};
      const bg = asColor(cv.bgColor);            if (bg) cleaned.bgColor = bg;
      const fg = asColor(cv.fgColor);            if (fg) cleaned.fgColor = fg;
      if (cv.fontWeight && FONT_WEIGHTS.has(String(cv.fontWeight))) cleaned.fontWeight = String(cv.fontWeight);
      if (cv.italic) cleaned.italic = true;
      const pad = asNum(cv.padding, 0, 32, null); if (pad != null) cleaned.padding = pad;
      const ip = asString(cv.iconPrefix);        if (ip != null) cleaned.iconPrefix = String(ip).slice(0, 8);
      if (Object.keys(cleaned).length) out[String(id)] = cleaned;
    }
    return out;
  }

  /* ========================== merge helpers ========================== */

  function isPlainObject(x) {
    return x != null && typeof x === "object" && !Array.isArray(x);
  }

  function deepMerge(base, override) {
    if (override == null) return structuredClone(base);
    if (!isPlainObject(base) || !isPlainObject(override)) {
      return structuredClone(override);
    }
    const out = { ...base };
    for (const [k, v] of Object.entries(override)) {
      if (v == null) {
        // Explicit null = clear that key (don't fall through to base).
        delete out[k];
      } else if (isPlainObject(v) && isPlainObject(base[k])) {
        out[k] = deepMerge(base[k], v);
      } else {
        out[k] = structuredClone(v);
      }
    }
    return out;
  }

  /* ============================ ProfileStore ========================== */

  const STORAGE_KEY_PREFIX_BY_AREA = { sync: "", local: "" };

  function storageKey(section, profileId) {
    return `${section}:${profileId}`;
  }
  function areaApi(area) {
    return area === "sync" ? chrome.storage.sync : chrome.storage.local;
  }

  /**
   * Owns one profile's view of every section. Reads default + this profile,
   * merges per the section's strategy, and exposes resolve()/update()/fork().
   *
   * Singleton-per-profile-id within a context (content script, options, popup).
   */
  class ProfileStore {
    constructor(profileId) {
      this.profileId = String(profileId || RESERVED_PROFILE_ID);
      this._cache = {};      // section -> resolved value
      this._raw = {};        // section -> { def, own } as last loaded
      this._previews = {};   // section -> transient patch
    }

    get isDefault() { return this.profileId === RESERVED_PROFILE_ID; }

    /**
     * Load all sections from storage and resolve them into the cache.
     * Idempotent; safe to call repeatedly.
     */
    async load() {
      const syncKeys = [];
      const localKeys = [];
      for (const section of SECTION_NAMES) {
        const strat = SECTION_STRATEGY[section];
        const list = strat.area === "sync" ? syncKeys : localKeys;
        list.push(storageKey(section, RESERVED_PROFILE_ID));
        if (!this.isDefault) list.push(storageKey(section, this.profileId));
      }
      const [syncRes, localRes] = await Promise.all([
        new Promise((r) => chrome.storage.sync.get(syncKeys, r)),
        new Promise((r) => chrome.storage.local.get(localKeys, r)),
      ]);
      for (const section of SECTION_NAMES) {
        const strat = SECTION_STRATEGY[section];
        const res = strat.area === "sync" ? syncRes : localRes;
        const def = res[storageKey(section, RESERVED_PROFILE_ID)];
        const own = this.isDefault ? undefined : res[storageKey(section, this.profileId)];
        this._raw[section] = { def, own };
        this._cache[section] = this._mergeForResolve(section, def, own);
      }
    }

    _mergeForResolve(section, def, own) {
      const strat = SECTION_STRATEGY[section];
      const cleanDef = def != null ? strat.validate(def) : strat.getDefault();
      if (this.isDefault || own == null) return cleanDef;
      const cleanOwn = strat.validate(own);
      if (strat.merge === "replace") return cleanOwn;
      return deepMerge(cleanDef, cleanOwn);
    }

    /**
     * Returns the effective value for `section`, with any active preview
     * patch overlaid on top.
     */
    resolve(section) {
      const base = this._cache[section] != null
        ? this._cache[section]
        : SECTION_STRATEGY[section].getDefault();
      const preview = this._previews[section];
      if (preview == null) return base;
      const strat = SECTION_STRATEGY[section];
      if (strat.merge === "replace") return strat.validate(preview);
      return deepMerge(base, preview);
    }

    /** Snapshot of every resolved section (used by export). */
    snapshot() {
      const out = {};
      for (const s of SECTION_NAMES) out[s] = this.resolve(s);
      return out;
    }

    /** Has this profile explicitly set its own value for `section`? */
    isForked(section) {
      if (this.isDefault) return false;
      return this._raw[section] && this._raw[section].own != null;
    }

    /**
     * Write a value for this profile's section.
     *
     * For replace-mode sections, `value` is the full new section value.
     * For deep-merge sections, `value` is a patch — merged into the existing
     * profile override (NOT into the default; default stays untouched).
     */
    async update(section, value) {
      const strat = SECTION_STRATEGY[section];
      const key = storageKey(section, this.profileId);
      const area = areaApi(strat.area);

      let payload;
      if (strat.merge === "replace") {
        payload = strat.validate(value);
      } else {
        const cur = await new Promise((r) => area.get({ [key]: null }, r));
        const existing = cur[key] != null ? strat.validate(cur[key]) : {};
        payload = strat.validate(deepMerge(existing, value));
      }
      await new Promise((r) => area.set({ [key]: payload }, r));
    }

    /**
     * Write a complete section value, bypassing any merge logic. Use this
     * when the caller wants a CLEAN replacement of the section's override
     * (e.g. applying a preset, applying a template, resetting). Equivalent
     * to update() for replace-mode sections.
     */
    async replace(section, value) {
      const strat = SECTION_STRATEGY[section];
      const key = storageKey(section, this.profileId);
      const area = areaApi(strat.area);
      const payload = strat.validate(value);
      await new Promise((r) => area.set({ [key]: payload }, r));
    }

    /**
     * Copy the default profile's current value into this profile's slot,
     * effectively forking it. No-op for the default profile.
     */
    async fork(section) {
      if (this.isDefault) return;
      const def = this._raw[section]?.def;
      const strat = SECTION_STRATEGY[section];
      const value = def != null ? strat.validate(def) : strat.getDefault();
      const area = areaApi(strat.area);
      await new Promise((r) => area.set({ [storageKey(section, this.profileId)]: value }, r));
    }

    /** Remove this profile's section so it inherits from default again. */
    async unfork(section) {
      if (this.isDefault) return;
      const strat = SECTION_STRATEGY[section];
      const area = areaApi(strat.area);
      await new Promise((r) => area.remove(storageKey(section, this.profileId), r));
    }

    /**
     * Apply a transient preview patch on top of the current resolved value.
     * Does not touch storage. Cleared by clearPreview() or by a real
     * persisted change to the same section.
     */
    applyPreview(section, patch) {
      const strat = SECTION_STRATEGY[section];
      if (strat.merge === "replace") {
        this._previews[section] = patch;
      } else {
        this._previews[section] = deepMerge(this._previews[section] || {}, patch);
      }
    }

    clearPreview(section) {
      if (section) delete this._previews[section];
      else this._previews = {};
    }

    /**
     * If a relevant key changed, reload the affected section(s). Returns the
     * list of sections that actually changed (so callers can rebuild).
     */
    async handleStorageChange(changes, area) {
      const changedSections = [];
      for (const section of SECTION_NAMES) {
        const strat = SECTION_STRATEGY[section];
        if ((area === "sync") !== (strat.area === "sync")) continue;
        const defKey = storageKey(section, RESERVED_PROFILE_ID);
        const ownKey = storageKey(section, this.profileId);
        if (!(defKey in changes) && !(ownKey in changes)) continue;

        const refresh = await new Promise((r) =>
          areaApi(strat.area).get(this.isDefault ? [defKey] : [defKey, ownKey], r)
        );
        const def = refresh[defKey];
        const own = this.isDefault ? undefined : refresh[ownKey];
        this._raw[section] = { def, own };
        this._cache[section] = this._mergeForResolve(section, def, own);
        delete this._previews[section]; // persisted change overrides preview
        changedSections.push(section);
      }
      return changedSections;
    }
  }

  /* ====================== profile index helpers ======================= */

  async function loadProfileIndex() {
    const { profileIndex } = await new Promise((r) =>
      chrome.storage.sync.get({ profileIndex: null }, r)
    );
    if (profileIndex && Array.isArray(profileIndex.profiles)) {
      const profiles = profileIndex.profiles
        .filter((p) => typeof p === "string" && p.length)
        .filter((p, i, a) => a.indexOf(p) === i);
      if (!profiles.includes(RESERVED_PROFILE_ID)) profiles.unshift(RESERVED_PROFILE_ID);
      return { profiles };
    }
    return { profiles: [RESERVED_PROFILE_ID] };
  }

  // Known Zendesk hosts the user has visited. NOT the same as the profile
  // index — these are discovered at runtime by content scripts and used to
  // populate the active-tab pill row, suggest "Create profile?" prompts,
  // and feed the catalog source picker on the default profile.
  //
  // Only becomes a profile if/when the user explicitly creates one.
  async function recordKnownHost(host) {
    if (!host || host === RESERVED_PROFILE_ID) return;
    const { knownZendeskHosts } = await new Promise((r) =>
      chrome.storage.local.get({ knownZendeskHosts: [] }, r)
    );
    const arr = Array.isArray(knownZendeskHosts) ? knownZendeskHosts : [];
    if (arr.includes(host)) return;
    arr.push(host);
    arr.sort();
    await new Promise((r) => chrome.storage.local.set({ knownZendeskHosts: arr }, r));
  }

  async function loadKnownHosts() {
    const { knownZendeskHosts } = await new Promise((r) =>
      chrome.storage.local.get({ knownZendeskHosts: [] }, r)
    );
    return Array.isArray(knownZendeskHosts) ? knownZendeskHosts.slice() : [];
  }

  async function ensureProfileExists(profileId) {
    if (profileId === RESERVED_PROFILE_ID) return;
    const idx = await loadProfileIndex();
    if (idx.profiles.includes(profileId)) return;
    idx.profiles.push(profileId);
    await new Promise((r) => chrome.storage.sync.set({ profileIndex: idx }, r));
  }

  async function deleteProfile(profileId) {
    if (profileId === RESERVED_PROFILE_ID) return;
    // Remove all per-profile keys from both areas.
    const syncKeys = [];
    const localKeys = [];
    for (const section of SECTION_NAMES) {
      const strat = SECTION_STRATEGY[section];
      (strat.area === "sync" ? syncKeys : localKeys).push(storageKey(section, profileId));
    }
    // Discovered catalogs and selectorHealth too.
    for (const k of ["discoveredViews", "discoveredGroups", "discoveredContainers", "selectorHealth"]) {
      localKeys.push(`${k}:${profileId}`);
    }
    await Promise.all([
      new Promise((r) => chrome.storage.sync.remove(syncKeys, r)),
      new Promise((r) => chrome.storage.local.remove(localKeys, r)),
    ]);
    // Update index.
    const idx = await loadProfileIndex();
    idx.profiles = idx.profiles.filter((p) => p !== profileId);
    await new Promise((r) => chrome.storage.sync.set({ profileIndex: idx }, r));
  }

  /**
   * Determine whether a profile has any explicit settings of its own (i.e.
   * the user has actually customized it). A profile is "empty" when none
   * of its sync/local section keys exist — the profile entry was created
   * automatically (likely by an old version of the content script) but
   * the user never opened the options page for it.
   */
  async function profileHasAnySettings(profileId) {
    if (profileId === RESERVED_PROFILE_ID) return true;
    const syncKeys = [];
    const localKeys = [];
    for (const section of SECTION_NAMES) {
      const strat = SECTION_STRATEGY[section];
      (strat.area === "sync" ? syncKeys : localKeys).push(storageKey(section, profileId));
    }
    const [syncRes, localRes] = await Promise.all([
      new Promise((r) => chrome.storage.sync.get(syncKeys, r)),
      new Promise((r) => chrome.storage.local.get(localKeys, r)),
    ]);
    return [...syncKeys, ...localKeys].some(
      (k) => (k in syncRes && syncRes[k] != null) || (k in localRes && localRes[k] != null)
    );
  }

  /**
   * One-time migration from v0.6.x model to v0.7.0 model.
   *   v0.6.x: every visited host was auto-created as a profile.
   *   v0.7.0: profiles are user-explicit; visited hosts go to knownZendeskHosts.
   *
   * Strategy (per user choice in v0.7.0 plan): preserve any profile that
   * has actual settings forked. Demote profiles with zero settings to
   * known-hosts (so they still show up as pills, but don't clutter the
   * profile dropdown).
   *
   * Idempotent: marks completion via a sentinel key. Safe to call from
   * multiple contexts; each will short-circuit after the first runs.
   */
  const MIGRATION_KEY = "v07ProfileSplitMigrated";
  let migrationPromise = null;

  async function migrateProfileIndexV07() {
    if (migrationPromise) return migrationPromise;
    migrationPromise = (async () => {
      const { [MIGRATION_KEY]: done } = await new Promise((r) =>
        chrome.storage.local.get({ [MIGRATION_KEY]: false }, r)
      );
      if (done) return { migrated: false };

      const idx = await loadProfileIndex();
      const tenantProfiles = idx.profiles.filter((p) => p !== RESERVED_PROFILE_ID);
      const demoted = [];
      const kept = [RESERVED_PROFILE_ID];
      for (const p of tenantProfiles) {
        if (await profileHasAnySettings(p)) kept.push(p);
        else demoted.push(p);
      }

      // Demoted ones go into knownZendeskHosts. Anything they discovered
      // (catalogs, health) stays in local storage — useful as a hint.
      if (demoted.length) {
        const existing = await loadKnownHosts();
        const merged = Array.from(new Set([...existing, ...demoted])).sort();
        await new Promise((r) =>
          chrome.storage.local.set({ knownZendeskHosts: merged }, r)
        );
      }

      // Update profileIndex if we actually demoted anything.
      if (demoted.length) {
        await new Promise((r) =>
          chrome.storage.sync.set({ profileIndex: { profiles: kept } }, r)
        );
      }
      await new Promise((r) =>
        chrome.storage.local.set({ [MIGRATION_KEY]: true }, r)
      );
      return { migrated: true, kept, demoted };
    })();
    return migrationPromise;
  }

  /* ============================== utilities =========================== */

  function cssAttr(s) {
    return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  }
  function depthFromPath(path) {
    if (!path) return 0;
    return path.split("::").length;
  }
  function viewKey(id) { return `v:${id}`; }
  function groupKey(path) { return `g:${path}`; }

  /* ============================= exports ============================== */

  window.ZVT = Object.freeze({
    // Constants
    SELECTORS, PREFIXES, RE,
    SECTION_STRATEGY, SECTION_NAMES,
    LEVEL_TOKEN_RANGES, GLOBAL_TOKEN_RANGES,
    INTRINSIC_LEVEL, INTRINSIC_GLOBAL,
    DEFAULT_PREFS, DEFAULT_HIDE, DEFAULT_DENSITY,
    DEFAULT_ORDER, DEFAULT_THEME, DEFAULT_CUSTOM_VIEWS,
    RESERVED_PROFILE_ID,
    // Classes / functions
    ProfileStore,
    deepMerge, cssAttr, depthFromPath, viewKey, groupKey,
    storageKey, areaApi,
    loadProfileIndex, ensureProfileExists, deleteProfile,
    recordKnownHost, loadKnownHosts,
    profileHasAnySettings, migrateProfileIndexV07,
  });
})();
