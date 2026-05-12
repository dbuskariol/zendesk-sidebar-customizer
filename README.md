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

1. Visit `github.zendesk.com` and let the views sidebar load. The extension discovers your views automatically as it sees them.
2. Click the extension icon for the **popup**:
   - Master enable / disable.
   - Compact mode on / off.
   - Open the options page.
3. The **options page** lists every view the extension has seen, with a checkbox per view (checked = visible). Use the search box to filter, or the show-all / hide-all buttons to bulk toggle.
4. Don't see a view yet? It hasn't been rendered. Either open it in Zendesk once (it'll appear in the list), use the **"Refresh from open Zendesk tab"** button, or paste its URL or numeric ID into the **manual add** field.

Changes apply live — no page refresh needed.

## How it works

- A content script runs on `github.zendesk.com`. It owns one `<style id="zvt-hide-rules">` element in the page head; hidden views are CSS rules in that stylesheet, not DOM mutations. This is immune to Zendesk's React re-renders.
- View identity comes from the URL filter ID (`/agent/filters/<id>`), parsed with a strict regex. Titles can change; numeric IDs are stable.
- Discovery uses a small `MutationObserver` scoped to the sidebar nav, debounced via `requestAnimationFrame`. New views land in `chrome.storage.local.discoveredViews` automatically.
- Compact mode is plain CSS gated on `body.zvt-compact`, scoped tightly to the views sidebar so it can't bleed into ticket content.

## Calibration / debugging

If Zendesk changes their DOM and the sidebar isn't found:

1. On a Zendesk page, open devtools and inspect `window.__zvt`. It exposes:
   - `nav` — the detected sidebar nav element (or `null`).
   - `discovered` — the in-memory map of `{id, title, href}` entries seen this session.
   - `selectors` — the selector strings the script tried.
   - `rescan()` — force a re-scan.
2. Find the new sidebar root and update the selector list in `src/content.js` (top of file, `SIDEBAR_NAV_SELECTORS`).
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
