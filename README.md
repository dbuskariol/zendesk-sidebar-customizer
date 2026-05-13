# Zendesk Sidebar Customizer

A browser extension (Manifest V3) for total control over the **Views sidebar** in Zendesk Support. Works in **Chromium browsers** (Chrome, Edge, Brave, Arc, Vivaldi) and **Firefox**.

- 🪪 **Per-tenant profiles** — different settings per Zendesk subdomain. New tenants inherit from a `default` profile until you fork.
- 🎚️ **Per-level density** — independently set font size, padding, indent, etc. for each nesting level. Live preview via sliders.
- 🎨 **Color theming** — palette tokens for background, hover, selected, focus, badge, and per-level color overrides.
- ✨ **Per-view styling** — background color, text color, font weight, italic, padding, and a custom title prefix per individual view.
- 🙈 **Hide views and groups** — uncheck a view to hide it; uncheck a group to hide its entire subtree.
- 🔀 **Reorder anything** — drag-and-drop or arrow keys. Pick CSS reorder (visual, robust) or DOM reorder (structural, experimental, fixes keyboard tab order).
- 📦 **Templates** — built-ins (Compact / Comfortable / Dark accent) plus your own saved templates. Apply partially (e.g. just the theme) or full overwrite.
- 🛡️ **Resilient** — primary `data-test-id` selectors with shape-detection fallback. Health pill in the popup warns if Zendesk's DOM changes.
- 💾 **Portable** — export each profile to JSON, import on another machine.

Works on any Zendesk Support tenant (`*.zendesk.com`). Settings sync across devices via the browser's built-in extension storage sync.

## Install

This extension isn't on the Chrome Web Store or Mozilla AMO yet — install it from the source.

### Step 1 — Get the code

Pick whichever you prefer:

**Option A: download as ZIP** (no git required)
1. Click **Code** → **Download ZIP** at the top of this repo.
2. Unzip somewhere permanent (e.g. `~/extensions/zendesk-sidebar-customizer`). The unpacked folder needs to stay where it is — your browser reads the files from there every time it starts.

**Option B: clone with git**
```sh
git clone https://github.com/dbuskariol/zendesk-sidebar-customizer.git ~/extensions/zendesk-sidebar-customizer
```

### Step 2 — Load it into your browser

#### Chrome / Edge / Brave / Arc / Vivaldi (Chromium)
1. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`, etc.).
2. Toggle **Developer mode** on (top-right corner).
3. Click **Load unpacked**.
4. Select the **folder you unzipped or cloned** (it should contain `manifest.json` at the top level).
5. Click the puzzle-piece icon in the toolbar and pin **Zendesk Sidebar Customizer**.

The extension persists across browser restarts.

#### Firefox (≥128)
1. Open `about:debugging`.
2. Click **This Firefox** in the left sidebar.
3. Click **Load Temporary Add-on…**.
4. Pick the `manifest.json` inside the folder you unzipped or cloned.
5. Pin the extension via the toolbar overflow menu if you want quick access.

> **Note:** Firefox unloads temporary add-ons on browser restart. To keep the extension across restarts, you need a signed `.xpi` from Mozilla AMO. That's not yet published — for now, re-load via `about:debugging` after each restart, or [submit your own signing request](https://extensionworkshop.com/documentation/publish/) if you want a permanent install.

### Step 3 — Use it

1. Visit your Zendesk Support views page: `https://your-subdomain.zendesk.com/agent`.
2. Click the extension icon in the toolbar to open the popup. You'll see your tenant's profile, master toggles, and a health indicator.
3. Click **Open options…** for the full settings page. Drag sliders, pick colors, hide views, reorder things — changes preview live in your Zendesk tab.

By default the extension does **nothing** to your sidebar until you opt in (Compact mode and Theme overrides are off). It's discovering your views in the background so they're listed when you open the options page.

### Updating

**Chromium**: Pull or re-download, then click the **reload** icon next to the extension in `chrome://extensions`. Your settings persist across updates.

**Firefox** (temporary add-on): re-load via `about:debugging` after replacing the files. Settings stored in `storage.sync` persist across reloads as long as the extension `id` doesn't change (it's pinned in the manifest).

### Uninstalling

Remove the extension from `chrome://extensions` (Chromium) or `about:addons` (Firefox). Your sync'd settings stay in your browser profile in case you reinstall — to fully wipe them, hit **Reset all ↻** in the options page topbar before removing.

## Profiles

The biggest concept in v0.6: every setting is **profile-scoped**.

- A `default` profile always exists. Every Zendesk tenant uses it unless you create a dedicated profile for that tenant.
- Each profile = one Zendesk subdomain (e.g. `acme.zendesk.com`). The content script picks the profile based on `window.location.host` automatically — two tabs on different tenants apply different settings simultaneously, no manual switching needed.
- The options page has a **profile switcher** at the top so you can edit any profile, regardless of which tab you're on.
- When you visit a new tenant, the popup shows a passive "Detected new tenant — Create profile?" pill. Dismissible per tenant.

### Inheritance per section

Settings are split into 6 sections, each with its own inheritance behavior:

| Section       | Storage area | Inheritance |
| ------------- | ------------ | ----------- |
| `prefs`       | sync         | Deep merge  |
| `theme`       | sync         | Deep merge  |
| `density`     | sync         | Deep merge  |
| `hide`        | local        | Replace     |
| `order`       | local        | Replace     |
| `customViews` | local        | Replace     |

- **Deep merge** sections: missing keys in your tenant profile fall back to default's values. You can tweak just one density level per tenant without re-specifying everything.
- **Replace** sections: your tenant profile either has its own value (forked) or uses the default's value verbatim. Avoids the "default hides X but tenant can't unhide it" trap.

Each section in the options page shows whether it's **inherited** or **forked** with explicit Fork / Unfork buttons.

### Sync vs local storage

- **Sync** (cross-device): `prefs`, `theme`, `density`, plus the profile index.
- **Local** (this device only): `hide`, `order`, `customViews`, plus the discovered Zendesk catalog and selector health.

Why split: `customViews` and `order` can grow large for tenants with hundreds of views, easily exceeding the `chrome.storage.sync` 8 KB-per-item limit. Putting them in `local` lets them grow freely. Trade-off: hide/order/per-view styling don't sync between your devices in v0.6.

## Use it

### Popup (extension icon)
- Master toggles (enabled, compact, themed, reorder enabled).
- Profile pill at the top showing which profile is active for the current tab.
- Dismissible "Create profile" pill when you visit a tenant without one.
- Health pill: green ✓ when everything's working, ⚠ on issues.

### Options page sections (sticky nav on the left)

#### General
Master toggles. Reorder mode radio: **Visual (CSS)** is default and robust; **Structural (DOM)** is experimental — it actually moves DOM nodes so keyboard tab order matches visual order, but Zendesk's React reconciliation can fight it. The extension monitors mutation churn and auto-falls-back to CSS if DOM mode misbehaves.

#### Density
Per-level controls (one block per detected nesting level + a few extra for headroom):
- Font size, line height
- Row padding (top / bottom / left / right) — set padding-left to 0 to bring labels flush to the edge
- Min height, indent

Global controls:
- Row gap, icon size
- Count badge font size, line height, margin, padding

Each value is a paired slider + number field. **Drag the slider** and watch the live preview in any open Zendesk tab on this profile. Release to commit. The **×** button clears one specific value (falls back to global compact baseline).

Presets: Ultra compact / Compact / Comfortable / Zendesk default / Clear all.

#### Theme
Color overrides (active when *Theme overrides* is on in General):
- Palette: background, foreground, hover, selected, accent, danger, count badge bg/fg, focus ring, active row stripe
- Per-level: background and text color per nesting level

Each color picker is a paired `<input type="color">` + hex text. Live preview while you drag. Clear button reverts to Zendesk's default for that color slot.

#### Hide views & groups
Collapsible tree mirroring your Zendesk hierarchy. Each leaf has a checkbox (checked = visible). Each group has its own checkbox to hide the entire subtree, plus a *Hide leaves* / *Show leaves* button for bulk-toggling just the leaves. The 🎨 button on each leaf jumps to the Customize section for that view.

#### Customize views
Searchable list of every discovered view. Click a row to expand the editor:
- Background color, text color
- Padding
- Font weight (normal / 500 / 600 / bold)
- Italic
- Title prefix — e.g. ⭐, 🔴, [P0]. Prefixed via CSS `::before`. Custom labels (replacing the title) are coming in v0.7.

#### Reorder
Pick a container from the dropdown. Items in your custom order are marked *pinned*; everything else follows Zendesk's intrinsic order. Drag-and-drop or use the up/down arrows. Reset per container or all-at-once.

#### Templates
Built-in starter templates (Compact / Comfortable / Dark accent) and your own saved templates. Save the current profile as a named template (pick which sections to include — defaults to density + theme). Apply with partial overwrite (just the included sections) or full overwrite (every section, including hide and order). Export / import templates as JSON.

#### Backup & diagnostics
Export this profile to JSON, import it back, or reset everything on this profile. Diagnostics dump shows counts, fork state per section, summary of each section's contents, and selector health.

## How it works

### Architecture
Three abstractions in `src/lib.js` that everything else builds on:

- **`SECTION_STRATEGY`** — single source of truth. Each section declares its storage area (`sync` or `local`), merge mode (`deep` or `replace`), defaults factory, and validator. Adding a new section = one entry in this table.
- **`ProfileStore`** — class that owns one profile's view of every section. Methods: `load()`, `resolve(section)`, `update(section, patch)`, `replace(section, value)`, `fork(section)`, `unfork(section)`, `isForked(section)`, `applyPreview(section, patch)`, `clearPreview()`, `handleStorageChange(changes, area)`. The content script and options page each construct one — content script with the page's host as profile ID, options page with whatever profile the user is editing.
- **`STYLESHEETS`** registry (in `content.js`) — one entry per dynamic stylesheet. Each entry has an `id` and a `build()` function. `rebuildAllSheets()` iterates the registry. Adding a new stylesheet = one entry, no other code change.

### DOM annotations
The content script tags every row LI during discovery:
- `data-zvt-key="v:<viewId>"` for view rows
- `data-zvt-key="g:<path>"` for group rows
- `data-zvt-d="<depth>"` on every anchor and children-container UL

All hide / order / theme / customize CSS rules target these annotations directly — single-attribute selectors that the browser resolves cheaply.

### Live preview
Two-phase write:
- On `input` (drag, typing, color picker change): debounce ~100ms, then send `{type:"zvt:preview", patch, profileId}` via `chrome.tabs.sendMessage` to Zendesk tab(s) matching the editing profile. Content script applies the patch transiently with a 5s auto-revert.
- On `change` (commit: pointerup, blur, Enter): write to `chrome.storage` once. `storage.onChanged` propagates the persistent value, overriding the preview.

Quota safe: never writes to `chrome.storage.sync` during a drag.

### DOM reorder kill-switch
When `reorderMode = "dom"`, the content script counts re-order operations in 1-second windows. If the count exceeds 20 (indicating Zendesk's React is fighting our reorder), DOM mode is disabled for the rest of the session and the CSS-order rules take over. The popup health pill surfaces this as a warning.

### Selector resilience
Primary selectors use Zendesk's stable `data-test-id` attributes:
- `a[data-test-id^="views_views-list_item-view-<id>"]` — view leaf
- `a[data-test-id^="views_views-list_item-folder-<path>"]` — group header
- `ul[data-test-id^="views_views-tree_container-children_<path>"]` — children container

If those stop matching, **shape-detection** kicks in:
1. Find every `a[href*="/agent/filters/"]` in the document.
2. Walk up to find the smallest enclosing `<nav>` / `<aside>` / `<ul>` that contains ≥3 such anchors AND has nested ULs.
3. Validate before accepting.
4. All other queries scoped inside that pane.

The popup health pill shows ⚠ when shape-detection is in use (means Zendesk changed something we should adapt to).

### Storage layout

#### `chrome.storage.sync` (small, syncs across devices)
```
profileIndex          { profiles: ["default", "acme.zendesk.com", ...] }
prefs:default         { enabled, compact, themed, reorderEnabled, reorderMode }
prefs:<host>          partial overrides
theme:default         { palette: {...}, level: {...} }
theme:<host>
density:default       { level: {...}, global: {...} }
density:<host>
```

#### `chrome.storage.local` (per-device, generous)
```
hide:default                     { v: [...], g: [...] }
hide:<host>                      replace, not merge
order:default                    { ROOT: [...], "g:Foo": [...] }
order:<host>                     replace, not merge
customViews:default              { "<viewId>": { bgColor, fgColor, ... } }
customViews:<host>               replace, not merge

discoveredViews:<profileId>       discovered sidebar catalog (per profile)
discoveredGroups:<profileId>
discoveredContainers:<profileId>
selectorHealth:<profileId>
editingProfileId                  options-page UI state
templates                         user-saved templates
lastZendeskHost, lastZendeskUrl   most recently visited tenant
dismissedSuggestions              tenants the user dismissed the "create profile" pill for
```

### Calibration / debugging

If Zendesk changes their DOM:

1. On a Zendesk page, open devtools and inspect `window.__zvt`. Properties:
   - `profileId` — which profile this tab is using
   - `pane` — detected pane element (or `null`)
   - `views`, `groups`, `containers` — discovered catalog
   - `prefs`, `hide`, `density`, `order`, `theme`, `customViews` — current settings (preview-aware)
   - `health` — pane found? counts? selector in use? DOM-reorder kill-switch state?
   - `selectors`, `prefixes` — the SELECTORS / PREFIXES config
   - `rescan()` — force a re-scan
   - `export()` — return full JSON dump
2. If primary selectors stop matching, shape-detection kicks in. Confirm via `__zvt.health.paneViaShape`.
3. To override selectors: edit `SELECTORS` / `PREFIXES` at the top of `src/lib.js` and reload the extension.

## Permissions

- `storage` — to persist settings, profiles, and the discovered-views catalog.
- `tabs` — to send live-preview messages to open Zendesk tabs and refresh from open tabs.
- `host_permissions: https://*.zendesk.com/*` — Zendesk Support tenants only.

## Privacy

- This extension makes **no network requests** of its own.
- Per-profile settings stay in your browser. Sync sections (`prefs`, `theme`, `density`) sync via the browser's built-in extension storage sync (Chrome Sync on Chromium, Firefox Sync on Firefox). Per-device sections (`hide`, `order`, `customViews`) never leave the local machine.
- View IDs and titles in the discovered catalog stay local.
- Templates you export contain whatever sections you include. If you include `customViews` and use the (future) custom-label feature, that text would be in the export — be aware before sharing.

## Development

The whole extension is plain HTML / CSS / JavaScript — no build step.

```
src/
  lib.js              Shared module: SELECTORS, SECTION_STRATEGY, ProfileStore, helpers
  content.js          Per-tab profile + STYLESHEETS registry + discovery + live preview
  compact.css         Static baseline gated on body.zvt-compact
  options.html        Options page markup (8 sections + sticky nav)
  options.css         Options page styles
  options.js          Section renderers + slider/color factory + profile switcher + templates
  popup.html          Browser-action popup
  popup.css           Popup styles
  popup.js            Popup logic + tenant detection + health pill
manifest.json         MV3 manifest (lib.js loaded BEFORE content.js)
icons/                16/48/128 PNG icons
```

To iterate locally:
1. Make changes in `src/`.
2. Click the **reload** icon next to the extension in `chrome://extensions`.
3. Refresh your Zendesk tab.

Validation:
```sh
node --check src/lib.js
node --check src/content.js
node --check src/options.js
node --check src/popup.js
python3 -c "import json; json.load(open('manifest.json'))"
```

## Smoke test

After loading the extension:

1. **Visit your Zendesk Views page** (`https://your-subdomain.zendesk.com/agent`).
2. **Open the options page**. The discovered views, groups, and containers populate within a few seconds.
3. **Profile detection**: the popup's profile pill shows your tenant. If you haven't created a profile for it, a "Create profile" suggestion pill appears.
4. **Density**: drag the *Level 1 → Font* slider. Top-level group headers in your Zendesk tab resize live.
5. **Theme**: turn on *Theme overrides* in General, then in Theme set a *Background* color. The sidebar background updates live.
6. **Hide a leaf**: uncheck a view in the Hide section. It disappears from Zendesk live.
7. **Customize a view**: click 🎨 next to a view in the Hide section, set a background color and a title prefix (e.g. ⭐). Verify both apply live.
8. **Reorder**: turn on *Reorder enabled* in General, pick *Top level* in Reorder, drag a group above another. Verify the new order in Zendesk live.
9. **DOM reorder mode**: switch to *Structural (DOM)* mode in General. Verify reorder still works. Try interacting with Zendesk for a minute and check `__zvt.health.reorderDomFellBack` — it should stay `false` under normal use.
10. **Profile fork**: create a profile for your tenant, change a density value, then unfork the section. Verify the value reverts to the default profile's value.
11. **Templates**: save the current profile as a template (include only `density`). Switch to a different profile (or the default), apply the template, verify only density changed.
12. **Export/import**: export the current profile, modify some settings, import the file back. Verify settings restored.
13. **Reset profile**: hit *Reset this profile*. For default profile, settings revert to defaults. For tenant profile, every section unforks (re-inherits from default).
14. **Health badge**: the popup pill shows ✓ green with view + group counts. Close the Zendesk tab → ⚠.

## Versioning

- v0.1.0 — Scaffold + initial compact CSS guess.
- v0.2.0 — Calibrated against live Zendesk DOM (`data-test-id` selectors, group tree).
- v0.3.0 — Group hide + per-level font/indent.
- v0.4.0 — Spacing token framework, sliders + live preview, reorder feature, schema migration, export/import, selector resilience, health badge, diagnostics.
- v0.5.0 — Generalized to all Zendesk Support tenants, MIT-licensed.
- v0.6.x — Per-tenant profiles, color theming, per-view styling, DOM reorder mode, templates, real Zendesk intrinsic value calibration.
- v0.7.0 — Live tab tracking, per-tab pill row, "Shared defaults" catalog source. Cleaned profile model — visited tenants no longer auto-create profiles.
- v0.8.0 — Firefox support (≥128) via single manifest. No build step.

## Contributing

Issues and PRs welcome. Please:

- Keep it dependency-free if possible (no build step, no npm).
- Match the existing code style (DRY abstractions in `lib.js`, declarative registries in `content.js`/`options.js`).
- Validate JS with `node --check`.
- Open an issue first for anything substantial — it's a small project and I'm happy to chat through ideas.

## License

[MIT](LICENSE).
