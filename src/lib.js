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

  // Ticket-list (table) selectors — calibrated from probes on a live tenant.
  // ALL of these are tenant-agnostic Zendesk Garden conventions; nothing
  // about a specific tenant is encoded here. Custom-field columns surface
  // their numeric IDs in [data-test-id^="ticket-table-cells-custom-field-"]
  // and those IDs are discovered live per tenant, never hardcoded.
  const TICKET_SELECTORS = Object.freeze({
    tbody:          'tbody[data-garden-id="tables.body"]',
    headerCell:     '[data-garden-id="tables.header_cell"]',
    dataRow:        'tr[data-test-id="generic-table-row"]',
    groupRow:       'tr[data-test-id="generic-table-rows-group-by"]',
    cell:           '[data-garden-id="tables.cell"]',
    statusCell:     '[data-test-id="ticket-table-cells-status"]',
    statusBadge:    '[data-test-id="ticket-table-cells-status"] [aria-label]',
    slaCell:        '[data-test-id="ticket-table-cells-sla"]',
    subjectCell:    '[data-test-id="ticket-table-cells-subject"]',
    assigneeCell:   '[data-test-id="ticket-table-cells-assignee"]',
    idCell:         '[data-test-id="generic-table-cells-id"]',
    dateCell:       '[data-test-id="generic-table-cells-date"]',
    customFieldCell:'[data-test-id^="ticket-table-cells-custom-field-"]',
    ticketAnchor:   'a[href^="/agent/tickets/"]',
    refreshBtn:     '[data-test-id="views_views-list_header-refresh"]',
    paginateNext:   '[data-test-id="generic-table-pagination-next"]',
    paginatePrev:   '[data-test-id="generic-table-pagination-previous"]',
  });

  // The set of Zendesk-canonical test-ids that identify a column the same
  // way across every tenant. Anything in this set can be used as a column
  // key in user settings AND survives a different tenant/view layout.
  //
  // Custom-field columns are NOT canonical (suffix is tenant-scoped).
  // empty-cell and overflow-menu-cell are NOT canonical either — they
  // are shared by multiple distinct columns in the same table (Agent
  // collision, Group privacy, the row's overflow menu trigger). They
  // live in AMBIGUOUS_TICKET_TEST_IDS so each gets its own
  // label-compounded key.
  const CANONICAL_TICKET_TEST_IDS = Object.freeze(new Set([
    "generic-table-cells-selectable",
    "ticket-table-cells-status",
    "ticket-table-cells-sla",
    "ticket-table-cells-subject",
    "ticket-table-cells-assignee",
    "generic-table-cells-id",
  ]));

  // Generic test-ids that can identify MULTIPLE distinct columns in the
  // same table. When we see one, we compound the key with the visible
  // header label so distinct columns don't collide.
  // - "date" appears on Requested, Updated, Solved, Due, etc.
  // - "empty-cell" is Zendesk's shared test-id for header chrome
  //   (Agent collision, Group privacy, the small icon-only spacer columns).
  // - "overflow-menu-cell" is the per-row overflow menu trigger, sometimes
  //   shared across multiple tables on the same page.
  const AMBIGUOUS_TICKET_TEST_IDS = Object.freeze(new Set([
    "generic-table-cells-date",
    "generic-table-cells-empty-cell",
    "generic-table-cells-overflow-menu-cell",
  ]));

  // Markers that distinguish a real ticket table from any other Garden
  // table that happens to share `tbody[data-garden-id="tables.body"]`.
  // We require a `subject` column (it's the canonical "this is a list of
  // tickets" signal) PLUS at least one of status / sla / assignee. A
  // single marker is too weak — sidebar widgets, recently-viewed lists,
  // and partial render frames can match one marker each.
  const TICKET_TABLE_REQUIRED_MARKER = "ticket-table-cells-subject";
  const TICKET_TABLE_SECONDARY_MARKERS = Object.freeze([
    "ticket-table-cells-status",
    "ticket-table-cells-sla",
    "ticket-table-cells-assignee",
  ]);
  // Kept for backwards compat with anything importing the old constant.
  const TICKET_TABLE_VALIDATORS = Object.freeze([
    TICKET_TABLE_REQUIRED_MARKER,
    ...TICKET_TABLE_SECONDARY_MARKERS,
  ]);

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

  // ---- Ticket-list defaults (v0.9.0) ----

  // Master toggles for the ticket-list feature area. Mirrors `prefs` for
  // the sidebar — keeping these orthogonal lets the user enable compact
  // sidebar without compact tickets, or vice versa.
  const DEFAULT_TICKET_PREFS = Object.freeze({
    enabled:        true,
    compact:        false,
    themed:         false,
    colorsEnabled:  false,
    hideEnabled:    true,   // hide list is harmless if empty; default on
  });

  // Density tokens for the ticket TABLE (not the sidebar). Empty by default
  // — when the user enables ticket-compact mode without setting tokens, the
  // built-in compact CSS supplies the falls-back values from INTRINSIC_TICKETS.
  const DEFAULT_TICKET_DENSITY = Object.freeze({
    rowMinHeight:      null,
    rowFontSize:       null,
    cellPaddingTop:    null,
    cellPaddingBottom: null,
    cellPaddingLeft:   null,
    cellPaddingRight:  null,
    headerMinHeight:   null,
    headerFontSize:    null,
  });

  const DEFAULT_TICKET_THEME = Object.freeze({
    headerBg:        null,
    headerFg:        null,
    rowHoverBg:      null,
    rowSelectedBg:   null,
    groupHeaderBg:   null,
    groupHeaderFg:   null,
  });

  // `cols` is a map of columnKey → true (hidden). columnKey is whatever
  // deriveColumnKey() emitted on this tenant; see CANONICAL_TICKET_TEST_IDS
  // and the layout-fingerprint fallback in deriveColumnKey for the rules.
  // Lives in storage.local because keys can be tenant-scoped.
  const DEFAULT_TICKET_HIDE = Object.freeze({ cols: {} });

  // Classifier shape — maps RAW observed values (any locale, any custom
  // status) to a semantic bucket + color. Defaults shipped for the standard
  // English Zendesk statuses; everything else stays unclassified until the
  // user maps it via the options page. This is the audit's #6 fix: we
  // never assume English at runtime.
  const SEMANTIC_STATUS_BUCKETS = Object.freeze([
    "open", "pending", "solved", "new", "onHold", "closed",
  ]);
  const SEMANTIC_SLA_BUCKETS = Object.freeze(["breached", "atRisk", "met"]);
  const SEMANTIC_PRIORITY_BUCKETS = Object.freeze([
    "urgent", "high", "normal", "low",
  ]);

  // Generic English defaults — applied automatically when an observation's
  // raw key matches one of these, override-able per profile, and never
  // re-applied if the user has explicitly cleared a mapping (tombstone via
  // null in the map).
  const DEFAULT_STATUS_RAW_TO_BUCKET = Object.freeze({
    open:     "open",
    pending:  "pending",
    solved:   "solved",
    new:      "new",
    hold:     "onHold",
    "on-hold":"onHold",
    "on hold":"onHold",
    closed:   "closed",
  });
  const DEFAULT_BUCKET_COLORS = Object.freeze({
    status: {
      open:    "#eb5c69",
      pending: "#f5a623",
      solved:  "#22a06b",
      new:     "#2f80ed",
      onHold:  "#a0a0a0",
      closed:  "#c4c4c4",
    },
    sla: {
      breached: "#eb5c69",
      atRisk:   "#f5a623",
      met:      "#22a06b",
    },
    priority: {
      urgent: "#eb5c69",
      high:   "#f5a623",
      normal: null,
      low:    "#7eb6ef",
    },
  });
  const DEFAULT_SLA_PATTERNS = Object.freeze([
    { pattern: "breached",           flags: "i", bucket: "breached" },
    { pattern: "till breach",        flags: "i", bucket: "atRisk" },
    { pattern: "hours? to breach",   flags: "i", bucket: "atRisk" },
    { pattern: "achieved|met|on time", flags: "i", bucket: "met" },
  ]);
  const DEFAULT_GROUP_PARSERS = Object.freeze([
    { pattern: "^Priority:\\s*(.+)$", flags: "i", groupField: "priority" },
    { pattern: "^Status:\\s*(.+)$",   flags: "i", groupField: "status" },
  ]);

  const DEFAULT_TICKET_CLASSIFIERS = Object.freeze({
    statusByRaw:   {},          // raw aria-label string → { bucket, color }
    slaPatterns:   [],          // user-overridable; falls back to DEFAULT_SLA_PATTERNS at eval
    groupParsers:  [],          // user-overridable; falls back to DEFAULT_GROUP_PARSERS at eval
    bucketColors:  { status: {}, sla: {}, priority: {} },  // overrides on top of DEFAULT_BUCKET_COLORS
    priorityByRaw: {},          // raw priority text → bucket (e.g. "Urgent" → "urgent")
  });

  const DEFAULT_TICKET_AUTO_REFRESH = Object.freeze({
    enabled:         false,
    intervalSec:     30,        // 15 | 30 | 60 | 120 | 300
    pauseOnSelected: true,      // pause if any row checkbox checked
    showIndicator:   true,      // small pill in lower-right of the table
  });

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
    // v0.9.0 — ticket-list sections. ticketHide is local (column keys can
    // include tenant-scoped custom-field IDs and per-layout fingerprints,
    // both of which break cross-tenant sync). ticketClassifiers is sync
    // with replace semantics per categorical map so tombstones (null
    // value) cleanly remove a parent-profile mapping.
    ticketPrefs: {
      area: "sync",
      merge: "deep",
      getDefault: () => structuredClone(DEFAULT_TICKET_PREFS),
      validate: validateTicketPrefs,
    },
    ticketDensity: {
      area: "sync",
      merge: "deep",
      getDefault: () => structuredClone(DEFAULT_TICKET_DENSITY),
      validate: validateTicketDensity,
    },
    ticketTheme: {
      area: "sync",
      merge: "deep",
      getDefault: () => structuredClone(DEFAULT_TICKET_THEME),
      validate: validateTicketTheme,
    },
    ticketHide: {
      area: "local",
      merge: "replace",
      getDefault: () => structuredClone(DEFAULT_TICKET_HIDE),
      validate: validateTicketHide,
    },
    ticketClassifiers: {
      area: "sync",
      merge: "deep",
      getDefault: () => structuredClone(DEFAULT_TICKET_CLASSIFIERS),
      validate: validateTicketClassifiers,
    },
    ticketAutoRefresh: {
      area: "sync",
      merge: "deep",
      getDefault: () => structuredClone(DEFAULT_TICKET_AUTO_REFRESH),
      validate: validateTicketAutoRefresh,
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

  // Zendesk's intrinsic computed values for the ticket-list TABLE, derived
  // from probes on a live tenant. Run the calibration probe in README.md
  // → "Ticket-list calibration" to remeasure if Zendesk ships changes.
  // Row min-height (41px) and cell vertical padding (10px/10px) are the
  // primary levers — the row itself has zero padding; the cell does.
  const INTRINSIC_TICKETS = Object.freeze({
    rowMinHeight:      41,
    rowFontSize:       14,
    rowLineHeight:     20,
    cellFontSize:      14,
    cellPaddingTop:    10,
    cellPaddingBottom: 10,
    cellPaddingLeft:   12,
    cellPaddingRight:  12,
    headerMinHeight:   40,   // not measured live; sensible default
    headerFontSize:    14,
  });

  const TICKET_DENSITY_RANGES = Object.freeze({
    rowMinHeight:      { min: 16, max: 80 },
    rowFontSize:       { min: 10, max: 20 },
    cellPaddingTop:    { min: 0,  max: 24 },
    cellPaddingBottom: { min: 0,  max: 24 },
    cellPaddingLeft:   { min: 0,  max: 32 },
    cellPaddingRight:  { min: 0,  max: 32 },
    headerMinHeight:   { min: 16, max: 80 },
    headerFontSize:    { min: 10, max: 20 },
  });

  function validateTicketPrefs(v) {
    const d = DEFAULT_TICKET_PREFS;
    return {
      enabled:       asBool(v?.enabled, d.enabled),
      compact:       asBool(v?.compact, d.compact),
      themed:        asBool(v?.themed, d.themed),
      colorsEnabled: asBool(v?.colorsEnabled, d.colorsEnabled),
      hideEnabled:   asBool(v?.hideEnabled, d.hideEnabled),
    };
  }

  function validateTicketDensity(v) {
    const out = { ...DEFAULT_TICKET_DENSITY };
    if (!v || typeof v !== "object") return out;
    for (const [k, raw] of Object.entries(v)) {
      const range = TICKET_DENSITY_RANGES[k];
      if (!range) continue;
      out[k] = raw == null ? null : Math.round(asNum(raw, range.min, range.max, null));
    }
    return out;
  }

  function validateTicketTheme(v) {
    const out = { ...DEFAULT_TICKET_THEME };
    if (!v || typeof v !== "object") return out;
    for (const k of Object.keys(DEFAULT_TICKET_THEME)) {
      const c = asColor(v[k]);
      out[k] = c;
    }
    return out;
  }

  function validateTicketHide(v) {
    const out = { cols: {} };
    if (v?.cols && typeof v.cols === "object") {
      for (const [k, val] of Object.entries(v.cols)) {
        if (typeof k !== "string" || !k) continue;
        if (k.length > 200) continue;          // keys are bounded
        if (val === true) out.cols[k] = true;
      }
    }
    return out;
  }

  function validateRegexPattern(p) {
    // Allow patterns up to 200 chars; reject anything that fails RegExp parse.
    if (typeof p !== "string" || !p || p.length > 200) return null;
    try { new RegExp(p); return p; } catch { return null; }
  }
  function validateRegexFlags(f) {
    return typeof f === "string" && /^[gimsuy]*$/.test(f) && f.length <= 6 ? f : "i";
  }

  function validateTicketClassifiers(v) {
    const out = structuredClone(DEFAULT_TICKET_CLASSIFIERS);
    if (!v || typeof v !== "object") return out;

    if (v.statusByRaw && typeof v.statusByRaw === "object") {
      for (const [raw, entry] of Object.entries(v.statusByRaw)) {
        if (typeof raw !== "string" || !raw || raw.length > 200) continue;
        if (entry === null) { out.statusByRaw[raw] = null; continue; }  // tombstone
        if (!entry || typeof entry !== "object") continue;
        const bucket = SEMANTIC_STATUS_BUCKETS.includes(entry.bucket) ? entry.bucket : null;
        const color = asColor(entry.color);
        if (bucket || color) out.statusByRaw[raw] = { bucket, color };
      }
    }
    if (v.priorityByRaw && typeof v.priorityByRaw === "object") {
      for (const [raw, entry] of Object.entries(v.priorityByRaw)) {
        if (typeof raw !== "string" || !raw || raw.length > 200) continue;
        if (entry === null) { out.priorityByRaw[raw] = null; continue; }
        if (!entry || typeof entry !== "object") continue;
        const bucket = SEMANTIC_PRIORITY_BUCKETS.includes(entry.bucket) ? entry.bucket : null;
        const color = asColor(entry.color);
        if (bucket || color) out.priorityByRaw[raw] = { bucket, color };
      }
    }
    if (Array.isArray(v.slaPatterns)) {
      out.slaPatterns = v.slaPatterns.slice(0, 20).map(p => {
        const pattern = validateRegexPattern(p?.pattern);
        const flags = validateRegexFlags(p?.flags);
        const bucket = SEMANTIC_SLA_BUCKETS.includes(p?.bucket) ? p.bucket : null;
        return pattern && bucket ? { pattern, flags, bucket } : null;
      }).filter(Boolean);
    }
    if (Array.isArray(v.groupParsers)) {
      out.groupParsers = v.groupParsers.slice(0, 20).map(p => {
        const pattern = validateRegexPattern(p?.pattern);
        const flags = validateRegexFlags(p?.flags);
        const gf = asString(p?.groupField);
        return pattern && gf ? { pattern, flags, groupField: gf.slice(0, 40) } : null;
      }).filter(Boolean);
    }
    if (v.bucketColors && typeof v.bucketColors === "object") {
      for (const cat of ["status", "sla", "priority"]) {
        if (!v.bucketColors[cat] || typeof v.bucketColors[cat] !== "object") continue;
        for (const [bucket, color] of Object.entries(v.bucketColors[cat])) {
          if (color === null) { out.bucketColors[cat][bucket] = null; continue; }
          const c = asColor(color);
          if (c) out.bucketColors[cat][bucket] = c;
        }
      }
    }
    return out;
  }

  const ALLOWED_REFRESH_INTERVALS = Object.freeze([15, 30, 60, 120, 300]);
  function validateTicketAutoRefresh(v) {
    const d = DEFAULT_TICKET_AUTO_REFRESH;
    const interval = ALLOWED_REFRESH_INTERVALS.includes(Number(v?.intervalSec)) ? Number(v.intervalSec) : d.intervalSec;
    return {
      enabled:         asBool(v?.enabled, d.enabled),
      intervalSec:     interval,
      pauseOnSelected: asBool(v?.pauseOnSelected, d.pauseOnSelected),
      showIndicator:   asBool(v?.showIndicator, d.showIndicator),
    };
  }


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

  /* =========================== ticket-list helpers ====================== */

  // Validates a `tbody[data-garden-id="tables.body"]` is in fact a ticket
  // table. Garden tables are reused for non-ticket lists (integrations,
  // organizations, etc) AND for hidden render frames / sidebar widgets.
  // We require the canonical SUBJECT column AND at least one of
  // status/sla/assignee — two markers means it's unambiguously a ticket
  // queue rather than a generic Garden table that happens to mention a
  // ticket once.
  function isTicketTable(tbody) {
    if (!tbody || tbody.tagName !== "TBODY") return false;
    if (tbody.dataset?.gardenId !== "tables.body") return false;
    if (!tbody.querySelector(`[data-test-id="${TICKET_TABLE_REQUIRED_MARKER}"]`)) return false;
    for (const id of TICKET_TABLE_SECONDARY_MARKERS) {
      if (tbody.querySelector(`[data-test-id="${id}"]`)) return true;
    }
    return false;
  }

  // Normalises a header label for use in compound column keys. Lower-case,
  // trimmed, whitespace collapsed; intentionally locale-insensitive (we
  // only collapse whitespace, not strip accents).
  function normalizeHeaderLabel(label) {
    return String(label || "").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 80);
  }

  // Deterministic fingerprint for the current column layout. Built from
  // the ordered list of (data-test-id || label) per column. Used as a
  // namespace for column keys that have no stable per-tenant identity,
  // so hide rules created on view A do not bleed into view B with a
  // different layout.
  function computeLayoutFingerprint(headers) {
    if (!Array.isArray(headers) || !headers.length) return "empty";
    const parts = headers.map((h) => {
      const testId = h.dataTestId || "";
      const label = normalizeHeaderLabel(h.label || "");
      return `${testId}#${label}`;
    });
    // Tiny FNV-1a hash — keeps the fingerprint short and avoids quoting issues.
    let hash = 0x811c9dc5;
    const str = parts.join("|");
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
    }
    return hash.toString(36);
  }

  /**
   * Derive a stable, scoped column key for hide/style settings.
   *
   * Resolution order (audit-driven):
   *   1. Canonical Zendesk semantic test-id (CANONICAL_TICKET_TEST_IDS) — applies across all tenants/views.
   *   2. Custom-field test-id (`ticket-table-cells-custom-field-<id>`) — tenant-scoped (stored in tenant's profile only).
   *   3. Ambiguous generic test-id (AMBIGUOUS_TICKET_TEST_IDS) — compound with header label to keep distinct columns separate.
   *   4. No usable test-id — layout-scoped key tied to the current fingerprint.
   *
   * Header and matching body cell get the same key annotation.
   */
  function deriveColumnKey({ dataTestId, headerLabel, columnIndex, layoutFingerprint }) {
    const tid = typeof dataTestId === "string" && dataTestId.length ? dataTestId : null;
    const normLabel = normalizeHeaderLabel(headerLabel || "");

    if (tid && CANONICAL_TICKET_TEST_IDS.has(tid)) return tid;
    if (tid && tid.startsWith("ticket-table-cells-custom-field-")) return tid;
    if (tid && AMBIGUOUS_TICKET_TEST_IDS.has(tid)) {
      return `${tid}|label:${normLabel}`;
    }
    if (tid) return `${tid}|label:${normLabel}`;
    return `layout:${layoutFingerprint || "empty"}|idx:${columnIndex}|label:${normLabel}`;
  }

  // Resolves the effective regex list for SLA / group parsers — user
  // overrides (in classifiers.slaPatterns/groupParsers) override defaults
  // when non-empty; otherwise the English defaults apply. Returns
  // compiled RegExp objects ready to test().
  function resolveSlaPatterns(classifiers) {
    const list = (Array.isArray(classifiers?.slaPatterns) && classifiers.slaPatterns.length)
      ? classifiers.slaPatterns
      : DEFAULT_SLA_PATTERNS;
    return list.map(p => {
      try { return { re: new RegExp(p.pattern, p.flags || "i"), bucket: p.bucket }; }
      catch { return null; }
    }).filter(Boolean);
  }
  function resolveGroupParsers(classifiers) {
    const list = (Array.isArray(classifiers?.groupParsers) && classifiers.groupParsers.length)
      ? classifiers.groupParsers
      : DEFAULT_GROUP_PARSERS;
    return list.map(p => {
      try { return { re: new RegExp(p.pattern, p.flags || "i"), groupField: p.groupField }; }
      catch { return null; }
    }).filter(Boolean);
  }

  // Resolves a raw status value to its semantic bucket — checking user
  // mappings first, then English defaults. Returns null if unmappable
  // (so the row gets no color — the audit's "degrade to no-color" rule).
  function classifyStatus(rawValue, classifiers) {
    if (!rawValue || typeof rawValue !== "string") return null;
    const norm = rawValue.trim().toLowerCase();
    const userMap = classifiers?.statusByRaw || {};
    if (Object.prototype.hasOwnProperty.call(userMap, norm)) {
      const v = userMap[norm];
      return v == null ? null : v;   // tombstone yields null
    }
    const defaultBucket = DEFAULT_STATUS_RAW_TO_BUCKET[norm];
    return defaultBucket ? { bucket: defaultBucket, color: null } : null;
  }

  function classifyPriority(rawValue, classifiers) {
    if (!rawValue || typeof rawValue !== "string") return null;
    const norm = rawValue.trim().toLowerCase();
    const userMap = classifiers?.priorityByRaw || {};
    if (Object.prototype.hasOwnProperty.call(userMap, norm)) {
      const v = userMap[norm];
      return v == null ? null : v;
    }
    // Generic English priority defaults — these are widely-used Zendesk
    // standards; non-English tenants need a user-provided mapping.
    const generic = { urgent: "urgent", high: "high", normal: "normal", low: "low" }[norm];
    return generic ? { bucket: generic, color: null } : null;
  }

  function effectiveBucketColor(category, bucket, classifiers) {
    if (!bucket) return null;
    const override = classifiers?.bucketColors?.[category]?.[bucket];
    if (override === null) return null;             // tombstone
    if (typeof override === "string" && override) return override;
    return DEFAULT_BUCKET_COLORS?.[category]?.[bucket] || null;
  }

  /* ============================= exports ============================== */

  window.ZVT = Object.freeze({
    // Constants
    SELECTORS, TICKET_SELECTORS, PREFIXES, RE,
    SECTION_STRATEGY, SECTION_NAMES,
    LEVEL_TOKEN_RANGES, GLOBAL_TOKEN_RANGES, TICKET_DENSITY_RANGES,
    INTRINSIC_LEVEL, INTRINSIC_GLOBAL, INTRINSIC_TICKETS,
    CANONICAL_TICKET_TEST_IDS, AMBIGUOUS_TICKET_TEST_IDS, TICKET_TABLE_VALIDATORS,
    SEMANTIC_STATUS_BUCKETS, SEMANTIC_SLA_BUCKETS, SEMANTIC_PRIORITY_BUCKETS,
    DEFAULT_STATUS_RAW_TO_BUCKET, DEFAULT_BUCKET_COLORS,
    DEFAULT_SLA_PATTERNS, DEFAULT_GROUP_PARSERS,
    ALLOWED_REFRESH_INTERVALS,
    DEFAULT_PREFS, DEFAULT_HIDE, DEFAULT_DENSITY,
    DEFAULT_ORDER, DEFAULT_THEME, DEFAULT_CUSTOM_VIEWS,
    DEFAULT_TICKET_PREFS, DEFAULT_TICKET_DENSITY, DEFAULT_TICKET_THEME,
    DEFAULT_TICKET_HIDE, DEFAULT_TICKET_CLASSIFIERS, DEFAULT_TICKET_AUTO_REFRESH,
    RESERVED_PROFILE_ID,
    // Classes / functions
    ProfileStore,
    deepMerge, cssAttr, depthFromPath, viewKey, groupKey,
    storageKey, areaApi,
    loadProfileIndex, ensureProfileExists, deleteProfile,
    recordKnownHost, loadKnownHosts,
    profileHasAnySettings, migrateProfileIndexV07,
    // Ticket-list helpers
    isTicketTable, normalizeHeaderLabel, computeLayoutFingerprint, deriveColumnKey,
    resolveSlaPatterns, resolveGroupParsers,
    classifyStatus, classifyPriority, effectiveBucketColor,
  });
})();
