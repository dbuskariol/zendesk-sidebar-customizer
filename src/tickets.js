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
    density:    "zvt-tickets-density",
    hide:       "zvt-tickets-hide",
    color:      "zvt-tickets-color",
    theme:      "zvt-tickets-theme",
    hover:      "zvt-tickets-hover",
    pagination: "zvt-tickets-pagination",
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
  // Hover-preview enhancer — singleton; owns the body MutationObserver
  // that watches for Zendesk's tooltip to appear so we can clone/pin it.
  let hoverEnhancer = null;
  // Infinite-scroll manager — one per primary table.
  let infiniteScroll = null;

  /* ============================ data shapes ========================== */

  function makeEmptySettings() {
    return {
      ticketPrefs:        Z.DEFAULT_TICKET_PREFS,
      ticketDensity:      Z.DEFAULT_TICKET_DENSITY,
      ticketTheme:        Z.DEFAULT_TICKET_THEME,
      ticketHide:         Z.DEFAULT_TICKET_HIDE,
      ticketClassifiers:  Z.DEFAULT_TICKET_CLASSIFIERS,
      ticketAutoRefresh:  Z.DEFAULT_TICKET_AUTO_REFRESH,
      ticketHover:        Z.DEFAULT_TICKET_HOVER,
      ticketPagination:   Z.DEFAULT_TICKET_PAGINATION,
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

  /**
   * Resize / enable scrolling on Zendesk's built-in row-hover tooltip
   * (`[data-test-id="ticket_table_tooltip"]`). The tooltip renders as a
   * portal at document level — it's NOT inside our managed table, so the
   * scope rules are globally applied. That's safe because the test-id is
   * Zendesk-canonical and unique to this widget.
   *
   * Future versions will also add sticky-on-hover (don't close when
   * mouse moves into the tooltip) and API-fetched full conversation
   * history (Zendesk only shows the most recent ~3 comments).
   */
  function buildHoverSheet() {
    const prefs = settings.ticketPrefs;
    if (!prefs?.enabled) return "";
    const h = settings.ticketHover;
    if (!h?.enhanced) return "";
    const w = Math.round(h.maxWidthPx || Z.DEFAULT_TICKET_HOVER.maxWidthPx);
    const vh = Math.round(h.maxHeightVh || Z.DEFAULT_TICKET_HOVER.maxHeightVh);
    const scrollCommentsBlock = h.scrollComments
      ? `[data-test-id="ticket_table_tooltip-comments"] {
  max-height: calc(${vh}vh - 240px) !important;
  overflow-y: auto !important;
}`
      : "";
    return `
[data-test-id="ticket_table_tooltip"]:not([data-zvt-hover-clone]) {
  max-width: ${w}px !important;
  min-width: ${Math.min(w, 480)}px !important;
  max-height: ${vh}vh !important;
}
[data-garden-id="modals.tooltip_dialog.body"] {
  max-height: calc(${vh}vh - 60px) !important;
  overflow-y: auto !important;
}
${scrollCommentsBlock}
    `.trim();
  }

  /**
   * When infinite-scroll is on AND hidePaginator is on, hide Zendesk's
   * Next/Previous buttons. The scroll listener auto-clicks Next so the
   * paginator's main job is no longer needed.
   */
  function buildPaginationSheet() {
    const prefs = settings.ticketPrefs;
    if (!prefs?.enabled) return "";
    const p = settings.ticketPagination;
    if (!p || p.mode !== "infinite" || !p.hidePaginator) return "";
    return `
${TICKET_SELECTORS.paginateNext},
${TICKET_SELECTORS.paginatePrev} {
  display: none !important;
}
    `.trim();
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

  /* ===================== HoverPreviewEnhancer ======================= */
  /*
   * Watches the document for Zendesk's row-hover tooltip and (when
   * enabled) clones it into a persistent overlay we control. The clone
   * stays visible until the user clicks outside or presses Esc.
   *
   * When `fullConversation` is on, parses the ticket ID from the
   * cloned content and fetches `/api/v2/tickets/<id>/comments` via the
   * authenticated session cookie, then appends a "Full conversation"
   * block below Zendesk's truncated comments list.
   *
   * Important design decisions:
   *   - Clone vs intercept: we clone instead of trying to prevent
   *     Zendesk's own close logic. Cloned content is read-only (no
   *     React event handlers) which is fine for a read-mostly preview.
   *   - Same-origin API call: `/api/v2/...` is on the tenant's own
   *     domain, so the user's session cookie authenticates the fetch
   *     and no extra host_permissions are needed.
   *   - Sanitization: API HTML bodies are run through a simple
   *     allow-list sanitizer that strips scripts, iframes, on* attrs,
   *     and javascript: URLs before innerHTML insertion.
   */
  class HoverPreviewEnhancer {
    constructor() {
      this.observer = null;
      this.clone = null;
      this.outsideClickHandler = null;
      this.escKeyHandler = null;
      this.commentCache = new Map();     // ticketId → { data, at }
      this.cacheTtlMs = 300_000;          // 5 minutes
    }

    start() {
      if (this.observer) return;
      this.observer = new MutationObserver((muts) => {
        for (const mut of muts) {
          for (const node of mut.addedNodes) {
            if (node.nodeType !== 1) continue;
            const tooltip = node.matches?.('[data-test-id="ticket_table_tooltip"]')
              ? node
              : node.querySelector?.('[data-test-id="ticket_table_tooltip"]');
            if (tooltip) this.handleTooltipAppeared(tooltip);
          }
        }
      });
      this.observer.observe(document.body, { childList: true, subtree: true });
    }

    stop() {
      this.observer?.disconnect();
      this.observer = null;
      this.dismiss();
      this.commentCache.clear();
    }

    handleTooltipAppeared(tooltip) {
      // Only run if BOTH enhanced and sticky are on. Without sticky we
      // let Zendesk's tooltip behave normally (CSS resize still applies).
      const h = settings.ticketHover;
      if (!h?.enhanced || !h?.sticky) return;

      // Wait one frame for Zendesk to fully render the tooltip's
      // inner content (otherwise we'd clone an empty shell).
      requestAnimationFrame(() => this.cloneTooltip(tooltip));
    }

    cloneTooltip(originalTooltip) {
      if (!document.contains(originalTooltip)) return;
      this.dismiss();   // any prior clone

      const rect = originalTooltip.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;

      const clone = document.createElement("div");
      clone.setAttribute("data-zvt-hover-clone", "1");
      clone.setAttribute("data-test-id", "ticket_table_tooltip");
      Object.assign(clone.style, {
        position: "fixed",
        left: `${rect.left}px`,
        top: `${rect.top}px`,
        width: `${rect.width}px`,
        zIndex: "2147483646",
        // Inherit Zendesk's tooltip background/border via the styled-
        // components classes we copy below.
      });
      // Copy class list so Zendesk's own styles apply to our clone too.
      // (StyledTooltipDialog-sc-... etc.) This is mildly fragile across
      // Zendesk class-hash changes but degrades to "unstyled box" not
      // "broken UI", and we add our own border as a safety net.
      clone.className = originalTooltip.className;
      clone.style.background = clone.style.background || "white";
      clone.style.border = clone.style.border || "1px solid rgba(0,0,0,0.15)";
      clone.style.boxShadow = "0 8px 24px rgba(0,0,0,0.18)";
      clone.style.borderRadius = "8px";
      clone.style.overflow = "hidden";
      clone.innerHTML = originalTooltip.innerHTML;

      // Pinned label + close button in the corner.
      const header = document.createElement("div");
      Object.assign(header.style, {
        position: "absolute", top: "6px", right: "6px",
        display: "flex", alignItems: "center", gap: "6px",
        zIndex: "1",
      });
      const pinned = document.createElement("span");
      pinned.textContent = "📌 Pinned";
      Object.assign(pinned.style, {
        background: "rgba(0,0,0,0.78)", color: "#fff",
        padding: "2px 8px", borderRadius: "10px",
        font: "11px system-ui, sans-serif", letterSpacing: "0.02em",
      });
      header.appendChild(pinned);
      const closeBtn = document.createElement("button");
      closeBtn.type = "button";
      closeBtn.textContent = "✕";
      closeBtn.title = "Dismiss pinned preview (Esc)";
      closeBtn.setAttribute("aria-label", "Close pinned preview");
      Object.assign(closeBtn.style, {
        width: "24px", height: "24px", border: "none",
        background: "rgba(0,0,0,0.78)", color: "#fff",
        borderRadius: "12px", cursor: "pointer",
        font: "12px system-ui, sans-serif", lineHeight: "1",
      });
      closeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.dismiss();
      });
      header.appendChild(closeBtn);
      clone.appendChild(header);

      // Make the body scroll inside the clone (independent of the
      // resize stylesheet, so sticky works even without enhanced
      // resize).
      const body = clone.querySelector('[data-garden-id="modals.tooltip_dialog.body"]');
      if (body) {
        body.style.maxHeight = `min(${settings.ticketHover?.maxHeightVh || 80}vh, calc(100vh - 80px))`;
        body.style.overflowY = "auto";
      }
      const tooltipMaxWidth = settings.ticketHover?.maxWidthPx || 720;
      if (rect.width < 360 || rect.width > tooltipMaxWidth) {
        clone.style.width = `${Math.min(tooltipMaxWidth, Math.max(360, rect.width))}px`;
      }

      // Reposition if the clone would extend off-screen (the original
      // tooltip was already positioned by Zendesk but our clone may
      // be wider/taller now).
      document.body.appendChild(clone);
      this.clone = clone;
      this.repositionClone(clone);

      // Hide Zendesk's own tooltip — visually replaced by our clone.
      this.hideOriginalTooltips();

      // Outside-click + Esc dismiss
      setTimeout(() => {
        this.outsideClickHandler = (e) => {
          if (!this.clone) return;
          if (!this.clone.contains(e.target)) this.dismiss();
        };
        this.escKeyHandler = (e) => {
          if (e.key === "Escape") this.dismiss();
        };
        document.addEventListener("mousedown", this.outsideClickHandler, true);
        document.addEventListener("keydown", this.escKeyHandler, true);
      }, 0);

      // Inject full conversation if enabled.
      if (settings.ticketHover?.fullConversation) {
        const ticketId = this.extractTicketId(clone);
        if (ticketId) this.injectFullConversation(clone, ticketId);
      }
    }

    repositionClone(clone) {
      const r = clone.getBoundingClientRect();
      const margin = 8;
      let left = r.left, top = r.top;
      if (r.right > window.innerWidth - margin) {
        left = Math.max(margin, window.innerWidth - r.width - margin);
      }
      if (r.bottom > window.innerHeight - margin) {
        top = Math.max(margin, window.innerHeight - r.height - margin);
      }
      if (left !== r.left) clone.style.left = `${left}px`;
      if (top !== r.top)  clone.style.top  = `${top}px`;
    }

    hideOriginalTooltips() {
      // Hide any Zendesk-rendered ticket tooltip currently in the DOM
      // (not our clone, which has data-zvt-hover-clone).
      document.querySelectorAll('[data-test-id="ticket_table_tooltip"]').forEach((el) => {
        if (el === this.clone) return;
        if (el.hasAttribute("data-zvt-hover-clone")) return;
        el.style.visibility = "hidden";
        el.style.pointerEvents = "none";
        el.dataset.zvtHidden = "1";
      });
      // Also hide the backdrop wrapper if Zendesk uses one.
      document.querySelectorAll('[data-garden-id="modals.tooltip_dialog.backdrop"]').forEach((el) => {
        el.style.visibility = "hidden";
        el.style.pointerEvents = "none";
        el.dataset.zvtHidden = "1";
      });
    }

    restoreOriginalTooltips() {
      document.querySelectorAll('[data-zvt-hidden="1"]').forEach((el) => {
        el.style.visibility = "";
        el.style.pointerEvents = "";
        delete el.dataset.zvtHidden;
      });
    }

    dismiss() {
      if (this.clone?.parentNode) this.clone.parentNode.removeChild(this.clone);
      this.clone = null;
      if (this.outsideClickHandler) {
        document.removeEventListener("mousedown", this.outsideClickHandler, true);
        this.outsideClickHandler = null;
      }
      if (this.escKeyHandler) {
        document.removeEventListener("keydown", this.escKeyHandler, true);
        this.escKeyHandler = null;
      }
      this.restoreOriginalTooltips();
    }

    extractTicketId(scope) {
      // Prefer an anchor's href.
      const a = scope.querySelector('a[href*="/agent/tickets/"]');
      if (a) {
        const m = a.getAttribute("href").match(/\/agent\/tickets\/(\d+)/);
        if (m) return m[1];
      }
      // Look for "#<digits>" in any text.
      const txt = (scope.innerText || "").match(/#(\d+)/);
      if (txt) return txt[1];
      return null;
    }

    async injectFullConversation(scope, ticketId) {
      const commentsSection = scope.querySelector('[data-test-id="ticket_table_tooltip-comments"]')
                          || scope.querySelector('[data-garden-id="modals.tooltip_dialog.body"]');
      if (!commentsSection) return;

      const block = document.createElement("div");
      block.setAttribute("data-zvt-full-conversation", "1");
      block.style.cssText = "border-top: 1px solid rgba(0,0,0,0.12); margin-top: 12px; padding-top: 12px; font-size: 12px;";

      const heading = document.createElement("div");
      heading.style.cssText = "font-weight: 600; color: #444; margin-bottom: 8px; display: flex; align-items: center; gap: 8px;";
      heading.innerHTML = `<span>Full conversation</span><span style="font-weight:400;color:#888">loading…</span>`;
      block.appendChild(heading);
      commentsSection.appendChild(block);

      try {
        const data = await this.fetchComments(ticketId);
        const comments = Array.isArray(data?.comments) ? data.comments : [];
        const usersById = new Map((data?.users || []).map(u => [u.id, u]));

        heading.querySelector("span:last-child").textContent = `${comments.length} comment${comments.length === 1 ? "" : "s"}`;

        if (!comments.length) {
          const empty = document.createElement("div");
          empty.style.cssText = "color: #888; font-style: italic;";
          empty.textContent = "(no comments)";
          block.appendChild(empty);
          return;
        }

        const list = document.createElement("div");
        list.style.cssText = "display: flex; flex-direction: column; gap: 10px;";
        for (const c of comments) {
          list.appendChild(this.renderComment(c, usersById));
        }
        block.appendChild(list);
      } catch (e) {
        heading.querySelector("span:last-child").innerHTML = `<span style="color:#d33">couldn't load: ${escapeText(e?.message || String(e))}</span>`;
      }
    }

    renderComment(comment, usersById) {
      const card = document.createElement("div");
      card.style.cssText = "padding: 8px 10px; background: rgba(0,0,0,0.025); border-radius: 6px;";
      const user = usersById.get(comment.author_id);
      const isInternal = comment.public === false;
      const meta = document.createElement("div");
      meta.style.cssText = "font-size: 11px; color: #666; margin-bottom: 6px; display: flex; gap: 8px; align-items: center;";
      const who = document.createElement("strong");
      who.style.color = "#222";
      who.textContent = user?.name || "Unknown";
      meta.appendChild(who);
      const when = document.createElement("span");
      when.textContent = formatRelative(comment.created_at);
      when.title = new Date(comment.created_at).toLocaleString();
      meta.appendChild(when);
      if (isInternal) {
        const badge = document.createElement("span");
        badge.textContent = "internal";
        badge.style.cssText = "background: #fff4d4; color: #7a5400; padding: 1px 6px; border-radius: 8px; font-size: 10px;";
        meta.appendChild(badge);
      }
      card.appendChild(meta);

      const body = document.createElement("div");
      body.style.cssText = "font-size: 12px; line-height: 1.5; color: #222; word-wrap: break-word;";
      body.innerHTML = sanitizeHtml(comment.html_body || comment.body || "");
      card.appendChild(body);
      return card;
    }

    async fetchComments(ticketId) {
      const cached = this.commentCache.get(ticketId);
      if (cached && Date.now() - cached.at < this.cacheTtlMs) return cached.data;

      const url = `/api/v2/tickets/${encodeURIComponent(ticketId)}/comments?include=users&sort_order=asc&per_page=100`;
      const res = await fetch(url, {
        credentials: "include",
        headers: { "Accept": "application/json" },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const ct = res.headers.get("content-type") || "";
      if (!ct.includes("application/json")) {
        throw new Error("unexpected response (logged out?)");
      }
      const data = await res.json();
      this.commentCache.set(ticketId, { data, at: Date.now() });
      return data;
    }
  }

  // Minimal HTML sanitiser — strips scripts/styles/iframes, on* attrs,
  // and javascript:/data: URLs. Modern browsers don't execute scripts
  // inserted via innerHTML so this is defence in depth.
  function sanitizeHtml(html) {
    const tmp = document.createElement("div");
    tmp.innerHTML = String(html || "");
    tmp.querySelectorAll("script, style, iframe, object, embed").forEach((el) => el.remove());
    tmp.querySelectorAll("*").forEach((el) => {
      for (const attr of Array.from(el.attributes)) {
        const name = attr.name.toLowerCase();
        if (name.startsWith("on")) { el.removeAttribute(attr.name); continue; }
        if ((name === "href" || name === "src" || name === "action")
            && /^\s*(javascript|data|vbscript):/i.test(attr.value)) {
          el.removeAttribute(attr.name);
        }
      }
    });
    return tmp.innerHTML;
  }

  function escapeText(s) {
    const tmp = document.createElement("div");
    tmp.textContent = String(s || "");
    return tmp.innerHTML;
  }

  function formatRelative(iso) {
    if (!iso) return "";
    const date = new Date(iso);
    const diff = Date.now() - date.getTime();
    const sec = Math.floor(diff / 1000);
    if (sec < 60)   return `${sec}s ago`;
    const min = Math.floor(sec / 60);
    if (min < 60)   return `${min}m ago`;
    const hr  = Math.floor(min / 60);
    if (hr < 24)    return `${hr}h ago`;
    const day = Math.floor(hr / 24);
    if (day < 7)    return `${day}d ago`;
    return date.toLocaleDateString();
  }

  /* ======================== InfiniteScroll =========================== */
  /*
   * Auto-paginate-on-scroll. When user scrolls within
   * `bottomThresholdPx` of the bottom of the table's scroll container,
   * programmatically click the "Next" pagination button. Previous rows
   * are replaced (Zendesk re-renders the table) — this is NOT true
   * accumulating infinite scroll, but it removes the click friction.
   *
   * Disables itself when the Next button is disabled (last page) or
   * not found.
   */
  class InfiniteScroll {
    constructor(table) {
      this.table = table;
      this.scrollContainer = null;
      this.boundScroll = () => this.onScroll();
      this.lastClickAt = 0;
      this.minClickInterval = 800;   // debounce — don't click more than ~1x/sec
      this.loadingEl = null;
      this.attached = false;
    }
    attach() {
      if (this.attached) return;
      this.scrollContainer = this.findScrollContainer();
      if (!this.scrollContainer) return;
      this.scrollContainer.addEventListener("scroll", this.boundScroll, { passive: true });
      this.attached = true;
    }
    detach() {
      if (!this.attached) return;
      this.scrollContainer?.removeEventListener("scroll", this.boundScroll);
      this.scrollContainer = null;
      this.attached = false;
      this.removeLoadingIndicator();
    }
    findScrollContainer() {
      // Walk up from the table looking for an ancestor with overflow:auto/scroll.
      let node = this.table?.parentElement;
      for (let i = 0; node && i < 12; i++, node = node.parentElement) {
        const cs = getComputedStyle(node);
        if ((cs.overflowY === "auto" || cs.overflowY === "scroll") && node.scrollHeight > node.clientHeight) {
          return node;
        }
      }
      return null;
    }
    onScroll() {
      const ar = settings.ticketPagination;
      if (ar?.mode !== "infinite") return this.detach();
      if (!this.scrollContainer || !document.contains(this.scrollContainer)) return this.detach();

      const container = this.scrollContainer;
      const threshold = ar.bottomThresholdPx || Z.DEFAULT_TICKET_PAGINATION.bottomThresholdPx;
      const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
      if (distanceFromBottom > threshold) {
        this.removeLoadingIndicator();
        return;
      }
      // Debounce so we don't trigger multiple clicks per tick or while
      // the next page is loading.
      if (Date.now() - this.lastClickAt < this.minClickInterval) return;

      const nextBtn = document.querySelector(TICKET_SELECTORS.paginateNext);
      if (!nextBtn) return;
      if (nextBtn.disabled || nextBtn.getAttribute("aria-disabled") === "true") {
        this.showAtEnd();
        return;
      }
      this.lastClickAt = Date.now();
      this.showLoading();
      nextBtn.click();
    }
    showLoading() {
      if (!this.loadingEl) {
        const el = document.createElement("div");
        el.setAttribute("data-zvt", "tickets-infinite-loading");
        Object.assign(el.style, {
          position: "absolute", left: "50%", bottom: "8px",
          transform: "translateX(-50%)",
          padding: "4px 12px", borderRadius: "12px",
          background: "rgba(21,26,30,0.85)", color: "#fff",
          font: "11px system-ui, sans-serif", zIndex: "2",
          pointerEvents: "none",
        });
        el.textContent = "Loading next page…";
        this.loadingEl = el;
      }
      const parent = this.scrollContainer || this.table.parentElement;
      if (parent && getComputedStyle(parent).position === "static") {
        // Need a positioned ancestor; fall back to fixed.
        Object.assign(this.loadingEl.style, {
          position: "fixed", bottom: "16px", top: "auto",
        });
        document.body.appendChild(this.loadingEl);
      } else if (parent && this.loadingEl.parentNode !== parent) {
        parent.appendChild(this.loadingEl);
      }
    }
    showAtEnd() {
      this.showLoading();
      if (this.loadingEl) {
        this.loadingEl.textContent = "End of list";
        setTimeout(() => this.removeLoadingIndicator(), 2000);
      }
    }
    removeLoadingIndicator() {
      if (this.loadingEl?.parentNode) this.loadingEl.parentNode.removeChild(this.loadingEl);
      this.loadingEl = null;
    }
  }

  function syncHoverEnhancer() {
    const h = settings.ticketHover;
    const want = !!(settings.ticketPrefs?.enabled && h?.enhanced && h?.sticky);
    if (want) {
      if (!hoverEnhancer) hoverEnhancer = new HoverPreviewEnhancer();
      hoverEnhancer.start();
    } else if (hoverEnhancer) {
      hoverEnhancer.stop();
      hoverEnhancer = null;
    }
  }

  function syncInfiniteScroll() {
    const p = settings.ticketPagination;
    const want = !!(settings.ticketPrefs?.enabled && p?.mode === "infinite" && managed.size > 0);
    if (want) {
      const primary = pickPrimaryTable();
      if (!primary) {
        infiniteScroll?.detach();
        infiniteScroll = null;
        return;
      }
      if (infiniteScroll && infiniteScroll.table !== primary) {
        infiniteScroll.detach();
        infiniteScroll = null;
      }
      if (!infiniteScroll) infiniteScroll = new InfiniteScroll(primary);
      infiniteScroll.attach();
    } else if (infiniteScroll) {
      infiniteScroll.detach();
      infiniteScroll = null;
    }
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
      ticketHover:       profile.resolve("ticketHover"),
      ticketPagination:  profile.resolve("ticketPagination"),
    };
    if (!managed.size) scanForTicketTables();
    syncAutoRefresh();
    syncHoverEnhancer();
    syncInfiniteScroll();
    rebuildSheets();
    for (const m of managed.values()) m.annotate();
  }

  function rebuildSheets() {
    rebuildSheet(STYLESHEET_IDS.density,    buildDensitySheet());
    rebuildSheet(STYLESHEET_IDS.hide,       buildHideSheet());
    rebuildSheet(STYLESHEET_IDS.color,      buildColorSheet());
    rebuildSheet(STYLESHEET_IDS.theme,      buildThemeSheet());
    rebuildSheet(STYLESHEET_IDS.hover,      buildHoverSheet());
    rebuildSheet(STYLESHEET_IDS.pagination, buildPaginationSheet());
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
    hoverEnhancer?.stop();
    hoverEnhancer = null;
    infiniteScroll?.detach();
    infiniteScroll = null;
    removeAllSheets();
  }

  function scan() {
    if (profile) {
      const sidebarPrefs = profile.resolve("prefs");
      const ticketPrefs  = profile.resolve("ticketPrefs");
      if (!sidebarPrefs?.enabled || !ticketPrefs?.enabled) {
        if (managed.size || autoRefresh || hoverEnhancer || infiniteScroll) teardown();
        return;
      }
    }
    scanForTicketTables();
    syncAutoRefresh();
    syncHoverEnhancer();
    syncInfiniteScroll();
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
