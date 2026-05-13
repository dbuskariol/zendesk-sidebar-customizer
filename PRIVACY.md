# Privacy policy

Both Chrome Web Store and Mozilla AMO require a privacy policy URL. This file is the canonical statement.

## Summary

**This extension does not collect, transmit, or share any personal data.**

## Details

### Data the extension reads
- The DOM of `https://*.zendesk.com/*` pages — specifically the Views sidebar, to discover view names, group hierarchy, and per-view counts.
- Your browser's open tabs whose URL matches `*.zendesk.com` — to know which Zendesk hosts you have open and reflect that in the popup and options page.

### Data the extension writes
- **`chrome.storage.sync`** — your settings (master toggles, density tokens, color theme, profile index). Synced by your browser's built-in extension-sync infrastructure (Chrome Sync on Chromium browsers, Firefox Sync on Firefox) **between your own devices only**. Neither the extension nor its author receive any of this data.
- **`chrome.storage.local`** — your hide list, custom ordering, per-view styling, the discovered Zendesk view catalog, and selector health. Stays on this device.

### Data the extension transmits
- **None.** The extension makes no HTTP/HTTPS requests of its own. There is no analytics, no telemetry, no remote configuration, no error reporting service, no third-party SDK.

### Data the extension shares with third parties
- **None.**

### Permissions and why

| Permission | Why |
| --- | --- |
| `storage` | Persist your settings and the discovered Zendesk catalog. |
| `tabs` | Query open Zendesk tabs to populate the popup's profile pill, the options page's "Open Zendesk tabs" row, and to send live-preview messages. |
| `host_permissions: https://*.zendesk.com/*` | The extension only operates on Zendesk Support tenants. It has no access to any other site. |

## Exporting / deleting your data

- **Export**: open the options page → *Backup & diagnostics* → *Export this profile*. Saves a JSON file you control.
- **Delete locally**: options page topbar → *Reset all ↻*. Wipes every profile, template, and discovered catalog from your browser.
- **Delete from sync**: after Reset all, your browser's sync infrastructure replicates the deletion to your other devices on next sync.

## Contact

Issues, questions, or data concerns: file an issue at https://github.com/dbuskariol/zendesk-sidebar-customizer/issues.

## Changes to this policy

This file is versioned with the extension itself in git. Any changes are visible in the repository history. Substantive changes will also be noted in release notes.
