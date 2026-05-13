#!/usr/bin/env bash
# Build a clean store-submission zip of the extension.
#
# Output: dist/zendesk-sidebar-customizer-<version>.zip
#
# Use this zip for:
#   - Chrome Web Store upload
#   - Mozilla AMO upload (or feed into `npx web-ext sign` for signed XPI)
#
# This is NOT a build step for the extension itself. The source is loadable
# directly via "Load unpacked" (Chromium) or "Load Temporary Add-on"
# (Firefox) without any preprocessing. This script only repackages the
# already-shippable source for store submission, excluding repo-only files.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Pull the version from manifest.json without depending on jq.
VERSION="$(python3 -c 'import json; print(json.load(open("manifest.json"))["version"])')"
NAME="zendesk-sidebar-customizer-${VERSION}"
OUT_DIR="dist"
ZIP_PATH="${OUT_DIR}/${NAME}.zip"

mkdir -p "$OUT_DIR"
rm -f "$ZIP_PATH"

# Include only files needed at runtime. Exclude .git, scripts/, dist/,
# *.md, and macOS .DS_Store junk. The store ZIP must contain manifest.json
# at the TOP LEVEL — zip's default behavior achieves that when invoked
# from the repo root.
zip -r "$ZIP_PATH" \
  manifest.json \
  src/ \
  icons/ \
  -x "*.DS_Store" \
  -x "src/.DS_Store" \
  -x "icons/.DS_Store" \
  > /dev/null

echo "✓ Built: $ZIP_PATH"
echo "  Size:  $(du -h "$ZIP_PATH" | cut -f1)"
echo ""
echo "Top-level contents (manifest.json must NOT be nested):"
unzip -l "$ZIP_PATH" | sed -n '1,15p'
echo ""
echo "Next steps:"
echo "  Chrome Web Store : https://chrome.google.com/webstore/devconsole/"
echo "                     Upload the zip directly."
echo "  Mozilla AMO      : https://addons.mozilla.org/developers/addon/submit/"
echo "                     Upload the zip directly, OR run:"
echo "                     npx web-ext sign --source-dir . \\"
echo "                       --api-key=\$AMO_JWT_ISSUER --api-secret=\$AMO_JWT_SECRET"
