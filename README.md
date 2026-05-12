# Zendesk Views Tweaks

A Chrome extension (Manifest V3) that gives you total control over the Zendesk Support **views sidebar**.

- **Compact mode** — denser rows, tighter spacing.
- **Per-level density** — set font size, padding, indent, etc. independently for each nesting level. Live preview via sliders.
- **Hide views and groups** — uncheck a view to hide it; uncheck a group to hide its entire subtree.
- **Reorder views and groups** — drag-and-drop or arrow keys. Pinned items stay in your order; the rest follows Zendesk.
- **Resilient** — primary `data-test-id` selectors with shape-detection fallback. Health badge in the popup warns if Zendesk's DOM changes.
- **Portable** — export your settings to JSON, import them back on another machine.

Scoped to `https://github.zendesk.com/*`. Settings sync across devices via `chrome.storage.sync`.

## Install (load unpacked)

1. Open `chrome://extensions` in Chrome.
2. Toggle **Developer mode** on (top right).
3. Click **Load unpacked** and pick this folder.
4. Pin the extension if you want quick access to the popup.

## Use it

### Popup (extension icon)
- **Enabled** — master switch.
- **Compact mode** — apply density tokens (off = no styling tweaks at all).
- **Reorder enabled** — opt in to the reorder feature (off = Zendesk's intrinsic order).
- **Open options** — opens the full options page.
- **Health pill** — green ✓ when everything's working, ⚠ if Zendesk DOM changed or no tab is open.

### Options page sections (collapsible)

#### General
Master toggles, schema version, sync info.

#### Density
- **Live preview**: drag a slider and watch your Zendesk tab update in real time. Release to commit.
- **Per-level controls** for each detected nesting level:
  - Font size, line height
  - Row padding (top/bottom/left/right) — **set padding-left to 0 to truly bring labels flush to the edge**
  - Min height
  - Indent (left padding on the children container at this depth)
- **Global controls** (when compact is on):
  - Row gap, icon size
  - Count badge font size, line height, margin, padding
- **Presets**: Ultra compact / Compact / Comfortable / Zendesk default / Clear all.

Each input has a paired slider + number field — use whichever is faster. The **×** button next to each field clears that single value (falls back to the global compact baseline).

#### Hide views & groups
Collapsible tree mirroring your Zendesk hierarchy. Each leaf has a checkbox (checked = visible). Each group has its own checkbox to hide the entire subtree, plus a *Hide leaves* / *Show leaves* button for bulk-toggling just the leaves.

#### Reorder
Pick a container from the dropdown (Top level, or any nested group), then:
- **Drag and drop** rows to rearrange.
- **Up/down arrows** for keyboard control.
- Items in your custom order are marked *pinned*; everything else follows Zendesk's intrinsic order.
- *Reset this container* / *Reset all order* to start over.

> **Note:** reorder is **visual only** (CSS `order`). Keyboard tab order in Zendesk follows the underlying DOM. v0.5 may add true DOM reorder.

#### Backup & diagnostics
- **Export settings** — downloads a JSON file (timestamped).
- **Import settings** — replaces all settings from a JSON file (with confirmation).
- **Reset all to defaults** — wipes everything (a v0.3 backup is kept in `chrome.storage.local.settingsBackupV1` if present).
- **Diagnostics** — counts, hidden items, density keys set, order scopes, selector health. Copy to clipboard for support.

## How it works

### Stylesheets
The content script owns three dynamic `<style>` elements in `<head>`:
- `#zvt-density-rules` — generated from per-level + global density tokens.
- `#zvt-hide-rules` — generated from `hide.v` + `hide.g`.
- `#zvt-order-rules` — generated from `order` (only when `reorderEnabled`).

Plus a tiny static `compact.css` baseline gated on `body.zvt-compact` so there's no unstyled flash before settings load. Per-level rules win by attribute specificity.

### Stable identifiers
- View leaf: `a[data-test-id="views_views-list_item-view-<id>"]`
- Group header: `a[data-test-id="views_views-list_item-folder-<path>"]` (`role="button"`)
- Children container: `ul[data-test-id^="views_views-tree_container-children_<path>"]` (path is `::`-joined, e.g. `Shared::🛟 Support Delivery::🌱 Triage`)
- Count badge: `[data-test-id="views_views-list_item_count"]`

The content script tags every row LI with `data-zvt-key="v:<id>"` or `data-zvt-key="g:<path>"`, and every anchor + children-ul with `data-zvt-d="<depth>"`. Hide and order rules target these annotations directly — single-attribute selectors, much cheaper than `:has()`.

### Live preview (slider drag)
Two-phase write:
- On `input` (drag, typing): debounce ~100ms, then send `{type:"zvt:preview", patch}` via `chrome.tabs.sendMessage` to the active Zendesk tab. Content script applies the patch to its in-memory state and rebuilds stylesheets — but does **not** persist.
- On `change` (commit: pointerup, blur, Enter): write to `chrome.storage.sync` once. `storage.onChanged` propagates the persistent value, overriding the preview.

Quota safe: never writes to `chrome.storage.sync` during a drag.

### Selector resilience
Primary selectors use Zendesk's stable `data-test-id` attributes. If those stop matching, a **shape-detection fallback** kicks in:
1. Find every `a[href*="/agent/filters/"]` in the document.
2. Walk up to find the smallest enclosing `<nav>` / `<aside>` / `<ul>` that contains ≥3 such anchors AND has nested ULs.
3. Validate before accepting it as the pane.
4. All other queries are scoped inside that pane.

The popup's health badge shows ⚠ when the fallback is in use.

### Reordering
When `reorderEnabled` is on:
- The outer + child ULs become `display: flex; flex-direction: column` (no visual change).
- Each pinned item gets a CSS rule like `li[data-zvt-key="v:123"] { order: -9999 !important; }`. Negative values sort before unpinned items (which default to `order: 0`).
- Storage is parent-scoped: `order["g:Shared"] = ["v:123","v:456"]` lists the items the user has positioned inside the *Shared* container.

### Storage layout

#### `chrome.storage.sync` (multi-key, syncs across devices)
- `prefs` — `{ schemaVersion, enabled, compact, reorderEnabled }`
- `hide` — `{ v: ["123",...], g: ["Shared::Foo",...] }`
- `density` — `{ level: { "1": {...}, ... }, global: {...} }`
- `order` — `{ ROOT: [...], "g:Shared": [...], ... }`

#### `chrome.storage.local` (this device only)
- `discoveredViews`, `discoveredGroups`, `discoveredContainers` — Zendesk catalog
- `selectorHealth` — last health snapshot
- `settingsBackupV1` — pre-migration backup (v0.3 → v0.4)

### Calibration / debugging

If Zendesk changes their DOM:

1. On a Zendesk page, open devtools and inspect `window.__zvt`. Properties:
   - `pane` — detected pane element (or `null`)
   - `views`, `groups`, `containers` — discovered catalog
   - `prefs`, `hide`, `density`, `order` — current settings (preview-aware)
   - `health` — pane found? counts? selector in use?
   - `selectors` — the SELECTORS config object
   - `rescan()` — force a re-scan
   - `export()` — return full JSON dump
2. If primary selectors stop matching, the fallback shape detection kicks in. Confirm via `__zvt.health.paneViaShape`.
3. To override selectors: edit `SELECTORS` at the top of `src/content.js` and reload the extension.

## Permissions

- `storage` — to persist settings and the discovered-views catalog.
- `tabs` — to send live-preview messages to open Zendesk tabs and refresh from open tabs.
- `host_permissions: https://github.zendesk.com/*` — the only site this extension touches.

## Smoke test

After loading the extension:

1. **Visit `https://github.zendesk.com/agent`** and let the views sidebar render.
2. **Open the options page**. Within a few seconds, the discovered views, groups, and containers should populate.
3. **Density**: drag the *Level 1 → Font* slider in the options page. The **Shared** / **Personal** group headers in your Zendesk tab should resize live as you drag. Release; refresh the Zendesk page; size persists.
4. **Padding-left = 0**: in *Level 2*, set *Pad ←* to 0. Verify "↪ New and Open" rows in *Shared > My tickets* have no left padding inside the row.
5. **Hide a leaf**: uncheck a view in the Hide section. It disappears from Zendesk live.
6. **Hide a group**: uncheck *Personal* in the tree. The whole *Personal* group disappears live.
7. **Reorder**: turn on *Reorder enabled* in General. In the Reorder section, pick *Top level*, drag *npm* above *Shared*. Verify *npm* appears first in Zendesk live.
8. **Up/down arrows**: tab to a row in the Reorder list, press Space + arrow keys (or just click ↑↓). Verify keyboard navigation works.
9. **Export/import**: export, change a setting, import the file back. Verify settings restored.
10. **Reset**: hit *Reset all to defaults*. Confirm. Everything goes back to defaults.
11. **Health badge**: the popup pill should show ✓ green with view + group counts. If you close the Zendesk tab, the badge should go ⚠.

## Versioning

- v0.1.0 — Scaffold + initial compact CSS guess.
- v0.2.0 — Calibrated against live Zendesk DOM (`data-test-id` selectors, group tree).
- v0.3.0 — Group hide + per-level font/indent.
- v0.4.0 — Spacing token framework, sliders + live preview, reorder feature, schema migration, export/import, selector resilience, health badge, diagnostics.

## License

Private / personal use.
