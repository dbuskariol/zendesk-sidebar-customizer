/*
 * Zendesk Sidebar Customizer — tickets.js  (v0.9.0)
 *
 * Ticket-list customization layer. Detects ticket tables on any page (saved
 * views, dashboards, org/user ticket lists), discovers their columns and
 * row data live per tenant, annotates rows for cheap CSS targeting, and
 * runs the auto-refresh loop.
 *
 * Loaded AFTER lib.js and BEFORE content.js. Exposes `window.ZVT_TICKETS`
 * so content.js can wire it into the master state-apply pipeline.
 *
 * Hard rules (audit-driven):
 *   - Detect tables by structure (lib.isTicketTable), never by URL.
 *   - Column keys via lib.deriveColumnKey — never bare nth-child or
 *     bare data-test-id selectors.
 *   - Every CSS rule scopes to `table[data-zvt-ticket-table]` so we
 *     never style unrelated Garden tables.
 *   - Discovery records RAW observation values. Classification (status
 *     bucket, SLA bucket, priority bucket) happens at render time using
 *     user mappings + English defaults; non-English locales degrade to
 *     no-color instead of misclassifying.
 *   - Auto-refresh: scoped to managed table, document-visibility-aware,
 *     pauses when row checkboxes are selected, no full-page-reload
 *     fallback.
 */

(() => {
  "use strict";

  if (window.ZVT_TICKETS) return;
  if (!window.ZVT) {
    console.warn("[zvt-tickets] ZVT not present — lib.js must load first");
    return;
  }

  const Z = window.ZVT;
  const {
    TICKET_SELECTORS, INTRINSIC_TICKETS, ALLOWED_REFRESH_INTERVALS,
    DEFAULT_BUCKET_COLORS, DEFAULT_SLA_PATTERNS, DEFAULT_GROUP_PARSERS,
    isTicketTable, normalizeHeaderLabel, computeLayoutFingerprint, deriveColumnKey,
    resolveSlaPatterns, resolveGroupParsers,
    classifyStatus, classifyPriority, effectiveBucketColor,
    cssAttr,
  } = Z;

  /* ============================== constants =========================== */

  const TABLE_ATTR = "data-zvt-ticket-table";
  const COL_KEY_ATTR = "data-zvt-col-key";
  const STYLESHEET_IDS = Object.freeze({
    density: "zvt-tickets-density",
    hide:    "zvt-tickets-hide",
    color:   "zvt-tickets-color",
    theme:   "zvt-tickets-theme",
  });

  const ANNOTATION_THROTTLE_MS = 100;
  const TENANT_OBSERVATION_BUDGET = {
    statusesRaw: 50,
    slaRaw: 200,
    groupHeaders: 100,
    columnLayouts: 20,
  };

  /* =============================== state ============================== */

  // Multiple ticket tables CAN exist on one page (rare but possible — split
  // views). Each managed table gets its own object below.
  const managed = new Map();     // tableElement → ManagedTicketTable
  let nextTableId = 1;

  // Lazily populated by the host (content.js) when boot completes.
  let profile = null;            // ZVT.ProfileStore for this tenant
  let hostName = null;
  // Effective settings (resolved from profile) cached and refreshed on
  // storage.onChanged. The host pushes refreshed settings via
  // refreshSettings(). All read-only here.
  let settings = makeEmptySettings();

  // Tenant observation catalogs (chrome.storage.local.tenantData[host])
  let observations = makeEmptyObservations();
  let observationsDirty = false;
  let observationsFlushTimer = 0;

  // Auto-refresh manager — one per page, owns one timer for whichever
  // table is the "primary" (largest area).
  let autoRefresh = null;

  /* ============================ data shapes ========================== */

  function makeEmptySettings() {
    return {
      ticketPrefs:        Z.DEFAULT_TICKET_PREFS,
      ticketDensity:      Z.DEFAULT_TICKET_DENSITY,
      ticketTheme:        Z.DEFAULT_TICKET_THEME,
      ticketHide:         Z.DEFAULT_TICKET_HIDE,
      ticketClassifiers:  Z.DEFAULT_TICKET_CLASSIFIERS,
      ticketAutoRefresh:  Z.DEFAULT_TICKET_AUTO_REFRESH,
    };
  }
  function makeEmptyObservations() {
    return {
      statusesRaw:    {},   // raw aria-label → { count, firstSeenAt, lastSeenAt }
      slaRaw:         {},   // first line of cell text → { count, ... }
      groupHeaders:   {},   // raw group row text → { count, ... }
      columnLayouts:  {},   // layoutFingerprint → { columns: [{key,label,dataTestId,index}], firstSeenAt }
      ticketColumns:  {},   // canonical/custom column key → { label, dataTestId, firstSeenAt, lastSeenAt }
    };
  }

  /* ========================== column catalog ========================= */

  function describeHeaderCells(table) {
    const thead = table.querySelector("thead");
    if (!thead) return [];
    const cells = thead.querySelectorAll(TICKET_SELECTORS.headerCell);
    return Array.from(cells).map((cell, index) => ({
      element: cell,
      index,
      dataTestId: cell.dataset?.testId || null,
      label: (cell.innerText || cell.textContent || "").trim(),
      width: cell.getBoundingClientRect().width,
    }));
  }

  function annotateTableColumns(table) {
    const headers = describeHeaderCells(table);
    if (!headers.length) return { fingerprint: "empty", columns: [] };

    const fingerprint = computeLayoutFingerprint(headers.map(h => ({
      dataTestId: h.dataTestId, label: h.label,
    })));

    const columns = headers.map(h => {
      const key = deriveColumnKey({
        dataTestId: h.dataTestId,
        headerLabel: h.label,
        columnIndex: h.index,
        layoutFingerprint: fingerprint,
      });
      h.element.setAttribute(COL_KEY_ATTR, key);
      return { ...h, key };
    });

    // Annotate body cells: matched by index within each row. Audit fix #4
    // — never assume header and body share the same data-test-id.
    const rows = table.querySelectorAll(TICKET_SELECTORS.dataRow);
    for (const row of rows) {
      const bodyCells = row.children;
      for (let i = 0; i < bodyCells.length && i < columns.length; i++) {
        const cell = bodyCells[i];
        if (cell.getAttribute(COL_KEY_ATTR) !== columns[i].key) {
          cell.setAttribute(COL_KEY_ATTR, columns[i].key);
        }
      }
    }

    // Record observations for this layout
    if (!observations.columnLayouts[fingerprint]) {
      observations.columnLayouts[fingerprint] = {
        columns: columns.map(c => ({ key: c.key, label: c.label, dataTestId: c.dataTestId, index: c.index })),
        firstSeenAt: Date.now(),
        lastSeenAt: Date.now(),
      };
      enforceObservationBudget("columnLayouts");
      observationsDirty = true;
    } else {
      observations.columnLayouts[fingerprint].lastSeenAt = Date.now();
    }
    // Per-column catalog (separate from layouts so canonical+custom-field
    // columns are recorded once across views regardless of position).
    for (const col of columns) {
      const existing = observations.ticketColumns[col.key];
      if (existing) {
        existing.lastSeenAt = Date.now();
        if (col.label && existing.label !== col.label) existing.label = col.label;
      } else {
        observations.ticketColumns[col.key] = {
          label: col.label,
          dataTestId: col.dataTestId,
          firstSeenAt: Date.now(),
          lastSeenAt: Date.now(),
        };
        observationsDirty = true;
      }
    }

    return { fingerprint, columns };
  }

  /* ======================== row annotation pass ====================== */

  function annotateRows(table) {
    const rows = table.querySelectorAll(TICKET_SELECTORS.dataRow);
    if (!rows.length) return 0;

    const classifiers = settings.ticketClassifiers || Z.DEFAULT_TICKET_CLASSIFIERS;
    const slaPatterns = resolveSlaPatterns(classifiers);
    const groupParsers = resolveGroupParsers(classifiers);

    // Walk all children of tbody so we can carry "current group" forward.
    const tbody = table.querySelector(TICKET_SELECTORS.tbody);
    if (!tbody) return 0;

    let annotated = 0;
    let currentGroup = null;          // { field, value, rawText }

    for (const node of tbody.children) {
      if (node.matches?.(TICKET_SELECTORS.groupRow)) {
        const raw = (node.innerText || node.textContent || "").trim();
        recordObservation("groupHeaders", raw);
        currentGroup = parseGroupHeader(raw, groupParsers);
        continue;
      }
      if (!node.matches?.(TICKET_SELECTORS.dataRow)) continue;
      annotated += annotateRow(node, currentGroup, slaPatterns, classifiers) ? 1 : 0;
    }
    return annotated;
  }

  function annotateRow(row, currentGroup, slaPatterns, classifiers) {
    let changed = false;

    // Ticket ID — prefer URL anchor (audit #14), fall back to id cell text.
    const ticketId = extractTicketId(row);
    setAttrIfChanged(row, "data-zvt-ticket", ticketId);
    if (ticketId !== row.dataset.zvtTicket) changed = true;

    // Status — read aria-label from inner status badge.
    const statusBadge = row.querySelector(TICKET_SELECTORS.statusBadge);
    const rawStatus = statusBadge?.getAttribute("aria-label") || null;
    if (rawStatus) recordObservation("statusesRaw", rawStatus);
    const statusBucket = (() => {
      const classified = classifyStatus(rawStatus, classifiers);
      return classified?.bucket || null;
    })();
    if (setAttrIfChanged(row, "data-zvt-status", statusBucket)) changed = true;
    if (setAttrIfChanged(row, "data-zvt-status-raw", rawStatus ? rawStatus.toLowerCase() : null)) changed = true;

    // SLA — text-pattern match against the cell's text content.
    const slaCell = row.querySelector(TICKET_SELECTORS.slaCell);
    if (slaCell) {
      const txt = (slaCell.innerText || "").replace(/\s+/g, " ").trim().slice(0, 200);
      if (txt) recordObservation("slaRaw", txt);
      const slaBucket = matchSlaBucket(txt, slaPatterns);
      if (setAttrIfChanged(row, "data-zvt-sla", slaBucket)) changed = true;
    } else if (setAttrIfChanged(row, "data-zvt-sla", null)) {
      changed = true;
    }

    // Priority (and any group inheritance) — only set when grouping is on
    // AND the parser recognized the field. Otherwise clear so stale values
    // don't persist.
    if (currentGroup?.field === "priority" && currentGroup.value) {
      const cls = classifyPriority(currentGroup.value, classifiers);
      if (setAttrIfChanged(row, "data-zvt-priority", cls?.bucket || null)) changed = true;
      if (setAttrIfChanged(row, "data-zvt-priority-raw", currentGroup.value.toLowerCase())) changed = true;
    } else {
      if (setAttrIfChanged(row, "data-zvt-priority", null)) changed = true;
      if (setAttrIfChanged(row, "data-zvt-priority-raw", null)) changed = true;
    }

    // Group field (generic) — exposes the current group's field/value so
    // future color rules can scope by any group dimension, not just priority.
    if (currentGroup?.field && currentGroup.value) {
      if (setAttrIfChanged(row, "data-zvt-group-field", currentGroup.field)) changed = true;
      if (setAttrIfChanged(row, "data-zvt-group-value", currentGroup.value.toLowerCase())) changed = true;
    } else {
      if (setAttrIfChanged(row, "data-zvt-group-field", null)) changed = true;
      if (setAttrIfChanged(row, "data-zvt-group-value", null)) changed = true;
    }

    return changed;
  }

  function extractTicketId(row) {
    const anchor = row.querySelector(TICKET_SELECTORS.ticketAnchor);
    const href = anchor?.getAttribute("href");
    if (href) {
      const m = href.match(/\/agent\/tickets\/(\d+)/);
      if (m) return m[1];
    }
    const idCell = row.querySelector(TICKET_SELECTORS.idCell);
    if (idCell) {
      const m = (idCell.innerText || "").match(/#(\d+)/);
      if (m) return m[1];
    }
    return null;
  }

  function parseGroupHeader(raw, groupParsers) {
    if (!raw) return null;
    for (const { re, groupField } of groupParsers) {
      const m = raw.match(re);
      if (m && m[1]) return { field: groupField, value: m[1].trim(), rawText: raw };
    }
    return null;
  }

  function matchSlaBucket(text, slaPatterns) {
    if (!text) return null;
    for (const { re, bucket } of slaPatterns) {
      if (re.test(text)) return bucket;
    }
    return null;
  }

  function setAttrIfChanged(el, attr, value) {
    const current = el.getAttribute(attr);
    if (value == null) {
      if (current != null) { el.removeAttribute(attr); return true; }
      return false;
    }
    if (current !== value) { el.setAttribute(attr, value); return true; }
    return false;
  }

  /* ======================== observation recorder ===================== */

  function recordObservation(category, rawValue) {
    if (!rawValue) return;
    const trimmed = String(rawValue).trim().slice(0, 200);
    if (!trimmed) return;
    const key = category === "statusesRaw" ? trimmed.toLowerCase() : trimmed;
    const bucket = observations[category];
    if (!bucket) return;
    const existing = bucket[key];
    if (existing) {
      existing.count = (existing.count || 0) + 1;
      existing.lastSeenAt = Date.now();
    } else {
      bucket[key] = { count: 1, firstSeenAt: Date.now(), lastSeenAt: Date.now() };
      enforceObservationBudget(category);
    }
    observationsDirty = true;
    scheduleObservationFlush();
  }

  function enforceObservationBudget(category) {
    const budget = TENANT_OBSERVATION_BUDGET[category];
    if (!budget) return;
    const entries = Object.entries(observations[category]);
    if (entries.length <= budget) return;
    entries.sort((a, b) => (a[1].lastSeenAt || 0) - (b[1].lastSeenAt || 0));
    const drop = entries.length - budget;
    for (let i = 0; i < drop; i++) delete observations[category][entries[i][0]];
  }

  function scheduleObservationFlush() {
    if (observationsFlushTimer) return;
    observationsFlushTimer = setTimeout(() => {
      observationsFlushTimer = 0;
      flushObservations();
    }, 2000);
  }

  async function flushObservations() {
    if (!observationsDirty || !hostName) return;
    observationsDirty = false;
    try {
      const tenantData = await loadTenantData();
      tenantData.ticketObservations = observations;
      await saveTenantData(tenantData);
    } catch (e) {
      // ignore — observations are non-critical
    }
  }

  async function loadTenantData() {
    const key = `tenantData:${hostName}`;
    return new Promise(resolve => {
      chrome.storage.local.get(key, (items) => {
        resolve((items && items[key]) || {});
      });
    });
  }
  async function saveTenantData(data) {
    const key = `tenantData:${hostName}`;
    return new Promise(resolve => {
      chrome.storage.local.set({ [key]: data }, () => resolve());
    });
  }
  async function bootstrapObservations() {
    if (!hostName) return;
    const tenantData = await loadTenantData();
    if (tenantData && tenantData.ticketObservations) {
      observations = {
        ...makeEmptyObservations(),
        ...tenantData.ticketObservations,
      };
      // One-time cleanup of pre-v0.9.1 catalog noise: prune any
      // columnLayouts where every column has an empty label (those came
      // from non-ticket Garden tables that passed the lax v0.9.0
      // validator), and prune ticketColumns whose key is layout-scoped
      // with an empty label suffix. The stricter v0.9.1 validator stops
      // new entries like this from being created.
      const pruned = pruneStaleObservations(observations);
      if (pruned) {
        observationsDirty = true;
        scheduleObservationFlush();
      }
    }
  }

  function pruneStaleObservations(obs) {
    let changed = 0;
    if (obs.columnLayouts && typeof obs.columnLayouts === "object") {
      for (const [fp, info] of Object.entries(obs.columnLayouts)) {
        const cols = Array.isArray(info?.columns) ? info.columns : [];
        const labelled = cols.filter(c => (c.label || "").trim().length > 0).length;
        if (cols.length > 0 && labelled === 0) {
          delete obs.columnLayouts[fp];
          changed++;
        }
      }
    }
    if (obs.ticketColumns && typeof obs.ticketColumns === "object") {
      for (const [key, info] of Object.entries(obs.ticketColumns)) {
        const labelEmpty = !(info?.label && info.label.trim().length > 0);
        const layoutScoped = key.startsWith("layout:");
        if (labelEmpty && layoutScoped) {
          delete obs.ticketColumns[key];
          changed++;
        }
      }
    }
    return changed;
  }

  /* ========================== stylesheet builders ==================== */

  function buildDensitySheet() {
    const prefs = settings.ticketPrefs;
    if (!prefs?.enabled || !prefs?.compact) return "";
    const d = settings.ticketDensity || {};
    const I = INTRINSIC_TICKETS;

    const rowMinHeight      = pxOrInherit(d.rowMinHeight);
    const rowFontSize       = pxOrInherit(d.rowFontSize);
    const headerMinHeight   = pxOrInherit(d.headerMinHeight);
    const headerFontSize    = pxOrInherit(d.headerFontSize);
    const cellPadTop        = pxOrInherit(d.cellPaddingTop);
    const cellPadBottom     = pxOrInherit(d.cellPaddingBottom);
    const cellPadLeft       = pxOrInherit(d.cellPaddingLeft);
    const cellPadRight      = pxOrInherit(d.cellPaddingRight);

    const SCOPE = `table[${TABLE_ATTR}]`;
    const rules = [];

    const rowDecls = [
      rowMinHeight  && `min-height: ${rowMinHeight} !important;`,
      rowMinHeight  && `height: ${rowMinHeight} !important;`,
      rowFontSize   && `font-size: ${rowFontSize} !important;`,
    ].filter(Boolean).join(" ");
    if (rowDecls) rules.push(`${SCOPE} ${TICKET_SELECTORS.dataRow} { ${rowDecls} }`);

    const cellDecls = [
      cellPadTop    && `padding-top: ${cellPadTop} !important;`,
      cellPadBottom && `padding-bottom: ${cellPadBottom} !important;`,
      cellPadLeft   && `padding-left: ${cellPadLeft} !important;`,
      cellPadRight  && `padding-right: ${cellPadRight} !important;`,
    ].filter(Boolean).join(" ");
    if (cellDecls) {
      rules.push(`${SCOPE} ${TICKET_SELECTORS.dataRow} > * { ${cellDecls} }`);
    }

    const headerDecls = [
      headerMinHeight && `min-height: ${headerMinHeight} !important;`,
      headerMinHeight && `height: ${headerMinHeight} !important;`,
      headerFontSize  && `font-size: ${headerFontSize} !important;`,
    ].filter(Boolean).join(" ");
    if (headerDecls) {
      rules.push(`${SCOPE} thead tr { ${headerDecls} }`);
    }
    return rules.join("\n");
  }

  function buildHideSheet() {
    const prefs = settings.ticketPrefs;
    if (!prefs?.enabled || !prefs?.hideEnabled) return "";
    const hide = settings.ticketHide;
    if (!hide?.cols) return "";
    const keys = Object.keys(hide.cols).filter(k => hide.cols[k] === true);
    if (!keys.length) return "";

    const SCOPE = `table[${TABLE_ATTR}]`;
    const selectors = keys.map(k => `${SCOPE} [${COL_KEY_ATTR}="${cssAttr(k)}"]`);
    return `${selectors.join(",\n")} { display: none !important; }`;
  }

  function buildColorSheet() {
    const prefs = settings.ticketPrefs;
    if (!prefs?.enabled || !prefs?.colorsEnabled) return "";
    const classifiers = settings.ticketClassifiers || Z.DEFAULT_TICKET_CLASSIFIERS;
    const SCOPE = `table[${TABLE_ATTR}]`;
    const rules = [];

    // Status: row background tint based on bucket.
    for (const bucket of Z.SEMANTIC_STATUS_BUCKETS) {
      const color = effectiveBucketColor("status", bucket, classifiers);
      if (!color) continue;
      rules.push(
        `${SCOPE} ${TICKET_SELECTORS.dataRow}[data-zvt-status="${bucket}"]`
        + ` { background-color: ${tintColor(color, 0.08)} !important; }`
      );
    }
    // SLA: left edge stripe.
    for (const bucket of Z.SEMANTIC_SLA_BUCKETS) {
      const color = effectiveBucketColor("sla", bucket, classifiers);
      if (!color) continue;
      rules.push(
        `${SCOPE} ${TICKET_SELECTORS.dataRow}[data-zvt-sla="${bucket}"]`
        + ` { box-shadow: inset 4px 0 0 ${color}; }`
      );
    }
    // Priority: row background tint (when grouped by priority OR otherwise discoverable).
    for (const bucket of Z.SEMANTIC_PRIORITY_BUCKETS) {
      const color = effectiveBucketColor("priority", bucket, classifiers);
      if (!color) continue;
      rules.push(
        `${SCOPE} ${TICKET_SELECTORS.dataRow}[data-zvt-priority="${bucket}"]`
        + ` { background-color: ${tintColor(color, 0.05)} !important; }`
      );
    }
    return rules.join("\n");
  }

  function buildThemeSheet() {
    const prefs = settings.ticketPrefs;
    if (!prefs?.enabled || !prefs?.themed) return "";
    const t = settings.ticketTheme || {};
    const SCOPE = `table[${TABLE_ATTR}]`;
    const rules = [];

    if (t.headerBg) rules.push(`${SCOPE} thead tr { background-color: ${t.headerBg} !important; }`);
    if (t.headerFg) rules.push(`${SCOPE} thead tr, ${SCOPE} thead tr * { color: ${t.headerFg} !important; }`);
    if (t.rowHoverBg) rules.push(`${SCOPE} ${TICKET_SELECTORS.dataRow}:hover { background-color: ${t.rowHoverBg} !important; }`);
    if (t.rowSelectedBg) rules.push(`${SCOPE} ${TICKET_SELECTORS.dataRow}:has(input[type=checkbox]:checked) { background-color: ${t.rowSelectedBg} !important; }`);
    if (t.groupHeaderBg) rules.push(`${SCOPE} ${TICKET_SELECTORS.groupRow} { background-color: ${t.groupHeaderBg} !important; }`);
    if (t.groupHeaderFg) rules.push(`${SCOPE} ${TICKET_SELECTORS.groupRow}, ${SCOPE} ${TICKET_SELECTORS.groupRow} * { color: ${t.groupHeaderFg} !important; }`);

    return rules.join("\n");
  }

  /* ============================= utilities =========================== */

  function pxOrInherit(v) {
    const n = Number(v);
    return Number.isFinite(n) ? `${Math.round(n)}px` : null;
  }

  // Lightweight color tint — converts named/hex/rgb into rgba with the
  // given alpha. Falls back to the input if the format is unfamiliar
  // (which is fine — the user can supply their own pre-tinted color).
  function tintColor(input, alpha) {
    if (typeof input !== "string" || !input) return input;
    const a = Math.max(0, Math.min(1, Number(alpha) || 0));
    const hex3 = input.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i);
    if (hex3) {
      const r = parseInt(hex3[1] + hex3[1], 16);
      const g = parseInt(hex3[2] + hex3[2], 16);
      const b = parseInt(hex3[3] + hex3[3], 16);
      return `rgba(${r},${g},${b},${a})`;
    }
    const hex6 = input.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
    if (hex6) {
      return `rgba(${parseInt(hex6[1], 16)},${parseInt(hex6[2], 16)},${parseInt(hex6[3], 16)},${a})`;
    }
    const rgb = input.match(/^rgba?\(([\d.\s,]+)\)$/i);
    if (rgb) {
      const parts = rgb[1].split(",").map(s => s.trim());
      if (parts.length >= 3) return `rgba(${parts[0]},${parts[1]},${parts[2]},${a})`;
    }
    return input;
  }

  /* ========================= ManagedTicketTable ====================== */

  class ManagedTicketTable {
    constructor(table) {
      this.id = String(nextTableId++);
      this.table = table;
      this.tbody = table.querySelector(TICKET_SELECTORS.tbody);
      this.observer = null;
      this.annotationScheduled = false;
      table.setAttribute(TABLE_ATTR, this.id);
    }
    start() {
      this.annotate();
      this.observer = new MutationObserver(() => this.scheduleAnnotate());
      this.observer.observe(this.table, { childList: true, subtree: true });
    }
    stop() {
      this.observer?.disconnect();
      this.observer = null;
      this.table.removeAttribute(TABLE_ATTR);
    }
    scheduleAnnotate() {
      if (this.annotationScheduled) return;
      this.annotationScheduled = true;
      setTimeout(() => {
        this.annotationScheduled = false;
        if (!document.contains(this.table)) return;
        this.annotate();
      }, ANNOTATION_THROTTLE_MS);
    }
    annotate() {
      annotateTableColumns(this.table);
      annotateRows(this.table);
    }
  }

  /* ========================= TicketAutoRefresh ======================= */

  class TicketAutoRefresh {
    constructor(table) {
      this.table = table;
      this.timer = 0;
      this.nextTickAt = 0;
      // Track the currently-running settings so reconfigure() can skip
      // restarting the timer when nothing meaningful changed. Without
      // this, syncAutoRefresh's 3-second cadence would reset the
      // countdown every 3 seconds (the "never gets below 28s" bug).
      this.currentIntervalSec = 0;
      this.currentShowIndicator = false;
      this.indicatorEl = null;
      this.indicatorTimer = 0;
      this.boundVisibility = () => this.onVisibility();
      document.addEventListener("visibilitychange", this.boundVisibility);
    }
    isAlive() { return document.contains(this.table); }

    /**
     * Idempotent configure-or-start. Call this from syncAutoRefresh on
     * every scan tick; only restarts the timer when the interval actually
     * changed. This is the fix for the countdown-reset bug.
     */
    reconfigure(intervalSec, showIndicator) {
      const intervalChanged = intervalSec !== this.currentIntervalSec;
      const showChanged = showIndicator !== this.currentShowIndicator;

      if (intervalChanged || !this.timer) {
        if (this.timer) clearInterval(this.timer);
        const ms = intervalSec * 1000;
        this.nextTickAt = Date.now() + ms;
        this.timer = setInterval(() => this.tick(), ms);
        this.currentIntervalSec = intervalSec;
      }
      if (showChanged || (showIndicator && !this.indicatorEl)) {
        if (showIndicator) this.showIndicator();
        else this.removeIndicator();
        this.currentShowIndicator = showIndicator;
      } else if (showIndicator && this.indicatorEl) {
        // Pill exists but Zendesk may have re-rendered the DOM and
        // detached it. Re-place if needed (cheap no-op otherwise).
        if (!document.contains(this.indicatorEl)) this.placeIndicator();
      }
    }

    stop() {
      if (this.timer) { clearInterval(this.timer); this.timer = 0; }
      this.currentIntervalSec = 0;
      this.removeIndicator();
      this.currentShowIndicator = false;
    }
    destroy() {
      this.stop();
      document.removeEventListener("visibilitychange", this.boundVisibility);
    }
    onVisibility() {
      // Visibility transitions don't reset the timer; they only gate tick().
      if (!document.hidden && !this.timer && settings.ticketAutoRefresh?.enabled) {
        const ar = settings.ticketAutoRefresh;
        this.reconfigure(ar.intervalSec, ar.showIndicator);
      }
    }
    tick() {
      if (document.hidden) return;
      if (!this.isAlive()) return this.destroy();
      const ar = settings.ticketAutoRefresh;
      if (!ar?.enabled) return this.stop();
      if (ar.pauseOnSelected && this.hasSelectedRows()) return;

      // Find the refresh action. The view-link strategy almost always
      // works on /agent/filters/<id>, but the sidebar link may briefly
      // be missing on first load or during SPA navigation — tolerate
      // a few consecutive misses before disabling.
      const target = findRefreshAction(this.table);
      if (!target) {
        this.missedTicks = (this.missedTicks || 0) + 1;
        if (this.missedTicks === 1) {
          console.warn("[zvt-tickets] no refresh action found this tick; will retry up to 5 times");
        }
        if (this.missedTicks >= 5) {
          console.warn("[zvt-tickets] auto-refresh disabled after 5 consecutive misses (no view link or refresh button in DOM)");
          this.stop();
        }
        return;
      }
      this.missedTicks = 0;
      target.click();
      this.nextTickAt = Date.now() + ar.intervalSec * 1000;
      this.bumpIndicator();
    }
    hasSelectedRows() {
      return !!this.table.querySelector(
        `${TICKET_SELECTORS.dataRow} input[type=checkbox]:checked`
      );
    }

    showIndicator() {
      if (!this.indicatorEl) {
        const el = document.createElement("span");
        el.setAttribute("data-zvt", "tickets-autorefresh-pill");
        // Inline pill — styling is location-agnostic so it looks right
        // whether it ends up in the toolbar (preferred) or fixed-position
        // fallback in the corner.
        Object.assign(el.style, {
          display: "inline-flex",
          alignItems: "center",
          padding: "2px 8px",
          marginLeft: "8px",
          borderRadius: "10px",
          background: "rgba(21,26,30,0.85)",
          color: "#fff",
          font: "11px system-ui, -apple-system, sans-serif",
          fontWeight: "500",
          letterSpacing: "0.02em",
          verticalAlign: "middle",
          pointerEvents: "none",
          whiteSpace: "nowrap",
        });
        this.indicatorEl = el;
      }
      this.placeIndicator();
      this.startIndicatorTimer();
    }

    startIndicatorTimer() {
      const update = () => {
        if (!this.indicatorEl) return;
        // Re-anchor if Zendesk re-rendered and detached our pill.
        if (!document.contains(this.indicatorEl)) this.placeIndicator();
        const remaining = Math.max(0, Math.ceil((this.nextTickAt - Date.now()) / 1000));
        this.indicatorEl.textContent = `↻ ${remaining}s`;
      };
      update();
      if (this.indicatorTimer) clearInterval(this.indicatorTimer);
      this.indicatorTimer = setInterval(update, 1000);
    }

    /**
     * Place the pill in the best available anchor. Priority order:
     *   1. Inline next to the "<N> tickets (Page X of Y)" count text.
     *   2. Inline next to the pagination Next/Previous toolbar.
     *   3. Absolute top-right of the table's positioned ancestor.
     *   4. Fixed top-right of the viewport (last-resort fallback).
     */
    placeIndicator() {
      if (!this.indicatorEl) return;
      const anchor = findIndicatorAnchor(this.table);
      if (!anchor) {
        this.attachFixedFallback();
        return;
      }
      // Reset styles in case we previously fell back.
      this.indicatorEl.style.position = "";
      this.indicatorEl.style.top = "";
      this.indicatorEl.style.right = "";
      this.indicatorEl.style.zIndex = "";
      if (anchor.element !== this.indicatorEl.parentNode) {
        anchor.element.appendChild(this.indicatorEl);
      }
    }

    attachFixedFallback() {
      if (!this.indicatorEl) return;
      Object.assign(this.indicatorEl.style, {
        position: "fixed",
        top: "60px",
        right: "16px",
        zIndex: "2147483647",
      });
      if (this.indicatorEl.parentNode !== document.body) {
        document.body.appendChild(this.indicatorEl);
      }
    }

    bumpIndicator() {
      if (!this.indicatorEl) return;
      const original = this.indicatorEl.textContent;
      this.indicatorEl.textContent = "↻ refreshed";
      setTimeout(() => {
        if (!this.indicatorEl) return;
        const remaining = Math.max(0, Math.ceil((this.nextTickAt - Date.now()) / 1000));
        this.indicatorEl.textContent = `↻ ${remaining}s`;
      }, 800);
    }

    removeIndicator() {
      if (this.indicatorTimer) { clearInterval(this.indicatorTimer); this.indicatorTimer = 0; }
      if (this.indicatorEl?.parentNode) this.indicatorEl.parentNode.removeChild(this.indicatorEl);
      this.indicatorEl = null;
    }
  }

  /**
   * Locate where to inject the auto-refresh pill. We want it adjacent to
   * whatever ticket-count / pagination chrome Zendesk renders for THIS
   * table — typically above the table, occasionally below. Walks the
   * table's ancestors looking for matching candidates, then falls back to
   * the pagination toolbar, then degrades to null (fixed positioning).
   */
  function findIndicatorAnchor(table) {
    // Walk ancestors looking for the closest container that holds either
    // the ticket-count text or the pagination controls. We stop at 8
    // ancestors (Zendesk's layout has the count within 4-6 normally).
    let node = table.parentElement;
    for (let i = 0; node && i < 8; i++, node = node.parentElement) {
      const inAncestor = findCountTextElement(node);
      if (inAncestor) return { element: inAncestor };
    }
    // Also look in immediately-preceding siblings of each ancestor —
    // count text often lives in a sibling header, not a wrapping parent.
    node = table;
    for (let i = 0; node?.parentElement && i < 8; i++, node = node.parentElement) {
      let sib = node.previousElementSibling;
      while (sib) {
        const found = findCountTextElement(sib);
        if (found) return { element: found };
        sib = sib.previousElementSibling;
      }
    }
    // Fallback: the pagination toolbar (Next/Prev container).
    const paginationBtn = document.querySelector(TICKET_SELECTORS.paginateNext)
                       || document.querySelector(TICKET_SELECTORS.paginatePrev);
    if (paginationBtn) {
      const container = paginationBtn.closest("nav, header, [role='toolbar'], div");
      if (container) return { element: container };
    }
    return null;
  }

  /**
   * Find an element whose text matches "<digits> tickets ..." (or similar
   * count formats Zendesk uses), avoiding deep matches inside the table
   * body itself. Returns the parent element of the matching text node so
   * the pill renders inline with it.
   */
  const COUNT_TEXT_RE = /^\s*\d+\s+tickets?(?:\s*\(.*\))?\s*$/i;
  function findCountTextElement(scope) {
    if (!scope || !scope.querySelectorAll) return null;
    // Quick filter: skip the table body itself (cells routinely contain
    // text like "Ticket #1234" that could false-match).
    if (scope.matches?.("tbody, table")) return null;
    // Search for short text nodes — count text is brief; full content
    // walks could be expensive on dense pages.
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const text = node.nodeValue || "";
        if (text.length > 80) return NodeFilter.FILTER_REJECT;
        return COUNT_TEXT_RE.test(text)
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_SKIP;
      },
    });
    const match = walker.nextNode();
    return match ? match.parentElement : null;
  }

  /**
   * Locate the action that actually refreshes the current ticket list.
   *
   * Critical: the only "refresh" button Zendesk exposes on a ticket-list
   * page is the views-pane header button (`views_views-list_header-refresh`).
   * That refreshes the COUNT BADGES in the sidebar, NOT the ticket-list
   * table contents. Clicking it does almost nothing visible to the user.
   *
   * The reliable way to force the ticket list to re-fetch is to re-click
   * the currently selected view link in the sidebar (Zendesk treats that
   * as a navigation event and re-runs the query).
   *
   * Priority order:
   *   1. URL-derived view link (for /agent/filters/<id> pages)
   *   2. Views-pane refresh button (fallback for dashboard / org / user
   *      ticket pages where no per-view link applies; updates sidebar
   *      counts which at least signals activity)
   */
  function findRefreshAction(_table) {
    const filterMatch = window.location.pathname.match(/\/agent\/filters\/(\d+)/);
    if (filterMatch) {
      const viewId = filterMatch[1];
      const link = document.querySelector(
        `a[data-test-id="views_views-list_item-view-${viewId}"]`
      );
      if (link) return link;
    }
    return document.querySelector(TICKET_SELECTORS.refreshBtn) || null;
  }

  /* ============================ scan loop ============================ */

  function scanForTicketTables() {
    const tbodies = document.querySelectorAll(TICKET_SELECTORS.tbody);
    const seen = new Set();
    for (const tbody of tbodies) {
      if (!isTicketTable(tbody)) continue;
      const table = tbody.closest("table");
      if (!table || seen.has(table)) continue;
      seen.add(table);
      if (!managed.has(table)) {
        const m = new ManagedTicketTable(table);
        managed.set(table, m);
        m.start();
      }
    }
    // Reap any managed tables that are no longer in the DOM.
    for (const [table, m] of managed.entries()) {
      if (!document.contains(table)) {
        m.stop();
        managed.delete(table);
      }
    }
    return managed.size;
  }

  function syncAutoRefresh() {
    const ar = settings.ticketAutoRefresh;
    const wantsEnabled = !!ar?.enabled && managed.size > 0;
    if (wantsEnabled) {
      const primary = pickPrimaryTable();
      if (!primary) {
        autoRefresh?.destroy();
        autoRefresh = null;
        return;
      }
      if (autoRefresh && autoRefresh.table !== primary) {
        // SPA route changed to a different table — tear down and recreate.
        autoRefresh.destroy();
        autoRefresh = null;
      }
      if (!autoRefresh) autoRefresh = new TicketAutoRefresh(primary);
      // reconfigure() is idempotent: it only restarts the timer when the
      // interval actually changes. This fixes the "never gets below 28s"
      // bug where the 3-second scan loop kept resetting the countdown.
      autoRefresh.reconfigure(ar.intervalSec, ar.showIndicator);
    } else if (autoRefresh) {
      autoRefresh.destroy();
      autoRefresh = null;
    }
  }

  function pickPrimaryTable() {
    let best = null, bestArea = -1;
    for (const table of managed.keys()) {
      const r = table.getBoundingClientRect();
      const area = r.width * r.height;
      if (area > bestArea) { best = table; bestArea = area; }
    }
    return best;
  }

  /* ============================ host API ============================= */

  function attach({ profile: p, host }) {
    profile = p;
    hostName = host;
    bootstrapObservations().then(() => {
      refreshSettings();
      scan();
    });
  }

  function refreshSettings() {
    if (!profile) return;
    // v0.9.1: the sidebar's "Extension enabled" toggle is the EXTENSION
    // master switch — when off, every feature (sidebar AND ticket-list)
    // must visibly turn off. Resolve sidebar prefs alongside ticket
    // prefs and bail-with-teardown if either disables the area.
    const sidebarPrefs = profile.resolve("prefs");
    const ticketPrefs  = profile.resolve("ticketPrefs");
    if (!sidebarPrefs?.enabled || !ticketPrefs?.enabled) {
      teardown();
      return;
    }
    settings = {
      ticketPrefs,
      ticketDensity:     profile.resolve("ticketDensity"),
      ticketTheme:       profile.resolve("ticketTheme"),
      ticketHide:        profile.resolve("ticketHide"),
      ticketClassifiers: profile.resolve("ticketClassifiers"),
      ticketAutoRefresh: profile.resolve("ticketAutoRefresh"),
    };
    // If we were torn down previously, scan re-populates managed tables.
    if (!managed.size) scanForTicketTables();
    syncAutoRefresh();
    rebuildSheets();
    // Re-annotate so colour mapping changes are visible immediately.
    for (const m of managed.values()) m.annotate();
  }

  function rebuildSheets() {
    rebuildSheet(STYLESHEET_IDS.density, buildDensitySheet());
    rebuildSheet(STYLESHEET_IDS.hide,    buildHideSheet());
    rebuildSheet(STYLESHEET_IDS.color,   buildColorSheet());
    rebuildSheet(STYLESHEET_IDS.theme,   buildThemeSheet());
  }
  function rebuildSheet(id, css) {
    let el = document.getElementById(id);
    if (css) {
      if (!el) {
        el = document.createElement("style");
        el.id = id;
        el.setAttribute("data-zvt", id);
        (document.head || document.documentElement).appendChild(el);
      }
      el.textContent = css;
    } else if (el?.parentNode) {
      el.parentNode.removeChild(el);
    }
  }
  function removeAllSheets() {
    for (const id of Object.values(STYLESHEET_IDS)) {
      const el = document.getElementById(id);
      if (el?.parentNode) el.parentNode.removeChild(el);
    }
  }
  function teardown() {
    for (const m of managed.values()) m.stop();
    managed.clear();
    autoRefresh?.destroy();
    autoRefresh = null;
    removeAllSheets();
  }

  function scan() {
    // Honor the same master switches as refreshSettings — the periodic
    // scan loop should not re-create stylesheets after teardown.
    if (profile) {
      const sidebarPrefs = profile.resolve("prefs");
      const ticketPrefs  = profile.resolve("ticketPrefs");
      if (!sidebarPrefs?.enabled || !ticketPrefs?.enabled) {
        if (managed.size || autoRefresh) teardown();
        return;
      }
    }
    scanForTicketTables();
    syncAutoRefresh();
    rebuildSheets();
  }

  function snapshot() {
    return {
      managedCount: managed.size,
      autoRefreshActive: !!autoRefresh,
      observations: {
        statusesRaw: Object.keys(observations.statusesRaw).length,
        slaRaw: Object.keys(observations.slaRaw).length,
        groupHeaders: Object.keys(observations.groupHeaders).length,
        columnLayouts: Object.keys(observations.columnLayouts).length,
        ticketColumns: Object.keys(observations.ticketColumns).length,
      },
    };
  }

  window.ZVT_TICKETS = Object.freeze({
    attach,
    refreshSettings,
    scan,
    teardown,
    snapshot,
    get observations() { return observations; },
    get managed() { return Array.from(managed.values()); },
    STYLESHEET_IDS,
    TABLE_ATTR,
    COL_KEY_ATTR,
  });
})();
