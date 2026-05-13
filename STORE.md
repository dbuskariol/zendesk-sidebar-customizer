# Store distribution guide

How to publish a new release to the Chrome Web Store and Mozilla AMO.

This is a one-time setup with per-release follow-ups. The extension itself has **no build step**; this guide covers the packaging and submission workflow that lives outside the runtime code.

## Prerequisites (one-time)

### Chrome Web Store
1. Sign in to [chrome.google.com/webstore/devconsole](https://chrome.google.com/webstore/devconsole/).
2. Pay the **$5 one-time** developer registration fee.
3. Verify your contact email.
4. (Optional) Set up a publisher group if you want to share publishing rights.

### Mozilla AMO
1. Sign in to [addons.mozilla.org/developers](https://addons.mozilla.org/developers/) (free; uses your Mozilla account).
2. Generate API credentials at [addons.mozilla.org/developers/addon/api/key](https://addons.mozilla.org/developers/addon/api/key/) if you want to use `web-ext sign` from the command line. Save:
   - `AMO_JWT_ISSUER` (the "JWT issuer")
   - `AMO_JWT_SECRET` (the "JWT secret")
3. Confirm your extension ID `zendesk-sidebar-customizer@dbuskariol.github.io` matches `manifest.json` → `browser_specific_settings.gecko.id` (don't change this — it's the identity Mozilla signs and your users' `storage.sync` data hangs off).

## Package the extension

```sh
bash scripts/pack.sh
```

Produces `dist/zendesk-sidebar-customizer-<version>.zip`. The script:
- Excludes `.git`, `scripts/`, `dist/`, dotfiles, and `*.md` files (store listings carry their own copy).
- Confirms `manifest.json` is at the **top level** of the zip — both stores reject zips with a nested folder.
- Reports the zip size (should be small — under 100 KB).

## First-time submission

### Chrome Web Store

1. Go to [chrome.google.com/webstore/devconsole](https://chrome.google.com/webstore/devconsole/) → **New item**.
2. Upload `dist/zendesk-sidebar-customizer-<version>.zip`.
3. Fill in the Store listing:
   - **Name**: Zendesk Sidebar Customizer
   - **Short description**: Customize the Zendesk Support views sidebar — per-tenant profiles, theming, per-view styling, reorder, live preview.
   - **Detailed description**: copy from the README's intro section.
   - **Category**: Productivity.
   - **Language**: English.
   - **Screenshots** (at least 1, max 5; 1280×800 or 640×400):
     - Options page (Density section with sliders visible).
     - Options page (Theme section with color pickers).
     - Options page (Hide tree expanded).
     - Popup with profile pill and toggles.
     - Before/after of a Zendesk sidebar.
   - **Privacy policy URL**: link directly to `PRIVACY.md` on GitHub: `https://github.com/dbuskariol/zendesk-sidebar-customizer/blob/main/PRIVACY.md`.
4. **Privacy practices** tab:
   - Single purpose: "Customize the Zendesk Support views sidebar".
   - Justify each permission (copy from PRIVACY.md's permissions table).
   - Confirm you do not collect any user data (we don't).
5. **Distribution** tab: Public.
6. Submit for review.
7. First review typically takes ~3 days. Subsequent updates are usually faster (hours to a day).

### Mozilla AMO

Two paths — pick one:

**A) Web UI (simpler for first submission)**
1. Go to [addons.mozilla.org/developers/addon/submit](https://addons.mozilla.org/developers/addon/submit/).
2. Choose **On this site** (listed; for Self-distribution / signed XPI to host yourself, choose "On your own").
3. Upload `dist/zendesk-sidebar-customizer-<version>.zip`. Mozilla auto-validates.
4. Fill in:
   - Add-on name, summary, description (copy from README).
   - Categories: Other → Productivity / Workflow.
   - Tags: zendesk, productivity, customization.
   - License: MIT (link to LICENSE).
   - Privacy policy URL (same as Chrome).
   - Screenshots (≥1, recommend 3-5).
5. Submit for review.

**B) Command line (faster for repeat releases)**
```sh
export AMO_JWT_ISSUER='your-issuer-from-step-2'
export AMO_JWT_SECRET='your-secret-from-step-2'

# Validate before submitting (catches manifest issues AMO will flag).
npx web-ext lint --source-dir .

# Submit for signing + publication. This works for both first and subsequent releases.
npx web-ext sign --source-dir . \
  --api-key="$AMO_JWT_ISSUER" \
  --api-secret="$AMO_JWT_SECRET" \
  --channel listed
```

The signed `.xpi` lands in `web-ext-artifacts/`. AMO listed reviews typically complete within ~1 day.

## Per-release workflow

After the initial submission, every release follows the same pattern:

1. Bump `manifest.json` `version` (e.g. `0.8.0` → `0.9.0`).
2. Commit the change.
3. Run `bash scripts/pack.sh`.
4. **Chrome Web Store**: dev console → your item → **Package** → **Upload new package** → submit for review.
5. **Mozilla AMO** (web UI): item page → **Upload New Version** → upload zip → submit.
   **Mozilla AMO** (CLI): `npx web-ext sign --source-dir . --api-key=$AMO_JWT_ISSUER --api-secret=$AMO_JWT_SECRET --channel listed`.
6. Tag the release in git: `git tag v0.9.0 && git push --tags`.
7. (Optional) Create a GitHub Release with the tag and attach `dist/zendesk-sidebar-customizer-0.9.0.zip` for users who want to load unpacked from a known-clean snapshot.

## Versioning rules

Both stores compare versions as dot-separated integers (e.g. `0.8.0` < `0.8.1` < `0.9.0`). Once a version is uploaded, you cannot reuse that version number — even if the upload was rejected. Always bump.

## When a submission is rejected

### Chrome Web Store
- The dev console shows the rejection reason. Common ones:
  - **Permissions justification missing**: each permission in the manifest must have a clear "why" in the listing. We use only `storage`, `tabs`, and `host_permissions: https://*.zendesk.com/*` — all three are documented in PRIVACY.md.
  - **Single-purpose violation**: the extension has one purpose (customize the Zendesk sidebar). Not at risk.
  - **Privacy policy not provided / inadequate**: link to `PRIVACY.md` and confirm "no data collection".
- Fix, bump version, re-upload.

### Mozilla AMO
- Reviewer comments arrive via email and are visible in the dev portal.
- `web-ext lint` catches most mechanical issues before submission. Run it first.
- If a Firefox-specific API breaks, that's the test gap; fix in code, not in the listing.

## Self-distribution alternative (Firefox only)

If you don't want a public AMO listing but still want signed XPIs for your team or known users:

1. AMO submission as above, but choose **"On your own"** distribution at upload time.
2. Mozilla signs the XPI and returns it (no public listing).
3. Host the `.xpi` somewhere your users can reach (e.g. attach to GitHub Release).
4. Users install by clicking the `.xpi` link in Firefox.
5. For auto-updates to work, add an `update_url` to `browser_specific_settings.gecko` in the manifest, pointing at a JSON manifest you also host. Without it, users update manually.

Chrome doesn't support self-distributing `.crx` files since Chrome 33 (only via the store, or as unpacked extensions). So for Chromium browsers, the public store is effectively the only path for non-developer users.

## Useful commands reference

```sh
# Build store-ready zip
bash scripts/pack.sh

# Validate the source against AMO's checks
npx web-ext lint --source-dir .

# Run the extension in a fresh Firefox profile for testing (no signing needed)
npx web-ext run --source-dir .

# Submit + sign + publish to AMO listed
npx web-ext sign --source-dir . \
  --api-key="$AMO_JWT_ISSUER" --api-secret="$AMO_JWT_SECRET" \
  --channel listed

# Verify the manifest is valid JSON
python3 -c "import json; json.load(open('manifest.json')); print('OK')"
```

## Files referenced

- `manifest.json` — extension manifest, contains version + Firefox-specific gecko ID.
- `scripts/pack.sh` — packaging script.
- `.web-ext-ignore` — files web-ext should exclude when running `web-ext build` or `web-ext sign`.
- `PRIVACY.md` — privacy policy referenced in store listings.
- `LICENSE` — MIT license, referenced in AMO submission.
