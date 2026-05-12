# Zendesk Views Tweaks

A small Chrome extension that makes the Zendesk Support **views sidebar** more usable:

- **Compact mode** — denser rows, smaller font, tighter spacing in the views list.
- **Hide views** — toggle off the views you never use, via a configurable options page.

Scoped to `https://github.zendesk.com/*`. Settings sync across devices via `chrome.storage.sync`.

## Install (load unpacked)

1. Open `chrome://extensions` in Chrome.
2. Toggle **Developer mode** on (top right).
3. Click **Load unpacked** and pick this folder.
4. Pin the extension if you want quick access to the popup.

## Use it

1. Visit `github.zendesk.com` and let the views sidebar load. The extension discovers your views (and groups) automatically as it sees them.
2. Click the extension icon for the **popup**:
   - Master enable / disable.
   - Compact mode on / off.
   - Open the options page.
3. The **options page** has three sections:
   - **Settings** — master toggles.
   - **Density** — per-level **font size** and **indent** in compact mode. One row per nesting level (Level 1 = top-level groups like *Shared* / *Personal*; deeper = nested). Leave blank to fall back to the global compact default. Click *Apply suggested defaults* to seed sensible per-level values, or *Clear all* to reset.
   - **Views & groups** — collapsible tree mirroring the Zendesk hierarchy (e.g. *Shared → My tickets → New and Open*). Each **leaf** has a checkbox (checked = visible). Each **group** has its own checkbox: **uncheck a group to hide the entire group** (header *and* all children). Group rows also show a *Hide leaves* / *Show leaves* button to bulk-toggle just the leaves inside without hiding the group itself.
4. Don't see a view yet? It hasn't been rendered. Either open it in Zendesk once (it'll appear in the list), use the **"Refresh from open Zendesk tab"** button, or paste its URL or numeric ID into the **manual add** field.

Changes apply live — no page refresh needed.

## How it works

- A content script runs on `github.zendesk.com`. It owns two stylesheets in the page head — neither mutates the DOM:
  - `<style id="zvt-hide-rules">` — `display:none` rules generated from your `hiddenViewIds` and `hiddenGroupPaths`.
  - `<style id="zvt-density-rules">` — per-level `font-size` and `padding-left` rules generated from `levelFontSizes` and `levelIndents`.
- View identity comes from `data-test-id="views_views-list_item-view-<id>"`. Group identity comes from `data-test-id="views_views-list_item-folder-<path>"`. Both are stable Zendesk test IDs.
- Group **path** is `::`-joined (e.g. `Shared::🛟 Support Delivery::🌱 Triage`) — also encoded into the children container's `data-test-id`.
- During discovery the content script tags every anchor and children-container with `data-zvt-d="<depth>"` (visual depth). CSS rules then target `[data-zvt-d="N"]` for per-level styling without depending on Zendesk's own classes.
- Discovery uses a `MutationObserver` scoped to the views pane (`nav[aria-label="Views"]`), debounced via `requestAnimationFrame`. New views and groups land in `chrome.storage.local` automatically.
- Compact baseline lives in `compact.css`, gated on `body.zvt-compact`. Per-level overrides win by specificity.

## Calibration / debugging

If Zendesk changes their DOM and the sidebar isn't found:

1. On a Zendesk page, open devtools and inspect `window.__zvt`. It exposes:
   - `pane` — the detected views pane element (or `null`).
   - `views` — discovered views with `{id, title, href, groupPath, depth}`.
   - `groups` — discovered groups with `{path, name, depth}`.
   - `prefixes` — the `data-test-id` prefixes the script keys off:
     - `views_views-list_item-view-` (leaf anchor)
     - `views_views-list_item-folder-` (group header anchor, `role=button`)
     - `views_views-tree_container` (outer container ul)
     - `views_views-tree_container-children_` (nested container ul, path is `::`-joined after the prefix)
     - `views_views-list_item_count` (count badge inside a row)
   - `rescan()` — force a re-scan.
2. If those prefixes change, update them at the top of `src/content.js` and matching selectors in `src/compact.css`.
3. Reload the extension at `chrome://extensions` and reload the Zendesk tab.

## Smoke test

After loading the extension:

1. **Visit `https://github.zendesk.com/agent`**. Wait for the views sidebar to render.
2. **Open the options page** (extension icon → "Open options…"). Within a few seconds, the discovered views list should populate. If it doesn't, click **"Refresh from open Zendesk tab"**.
3. **Toggle one view off** in the options page. Switch to the Zendesk tab — the view should disappear from the sidebar **without a page reload**.
4. **Toggle it back on**. The view reappears live.
5. **Open the popup** and turn off **Compact mode**. The sidebar should switch back to default Zendesk density immediately.
6. **Turn off Enabled** in the popup. All effects clear: hidden views reappear, compact CSS releases, no `<style id="zvt-hide-rules">` element in the page.
7. **Manual add**: in the options page, paste a known view URL into the manual-add field and submit. It should appear in the list, marked hidden.

## Permissions

- `storage` — to persist settings and the discovered-views catalog.
- `tabs` — for the options page's "Refresh from open Zendesk tab" button.
- `host_permissions: https://github.zendesk.com/*` — the only site this extension touches.

## License

Private / personal use.
