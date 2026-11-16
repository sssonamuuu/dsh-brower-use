#!/usr/bin/env bash
# Build a store-ready Chromium extension zip from extension/.
# The manifest must be at the zip root; store upload does not accept a nested
# extension/ directory.
set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v zip >/dev/null 2>&1; then
  echo "zip is required (macOS/Linux: install zip first)" >&2
  exit 1
fi

version="$(node -p "require('./extension/manifest.json').version")"
name="dsh-browser-bridge-${version}-chromium.zip"
out="dist/${name}"

mkdir -p dist
rm -f "$out"

(
  cd extension
  zip -r "../${out}" . \
    -x 'firefox/*' \
    -x '*.DS_Store' \
    -x '__MACOSX/*'
)

# Fail loudly if the archive root is wrong.
if ! unzip -l "$out" | awk '{print $4}' | grep -qx 'manifest.json'; then
  echo "Invalid package: manifest.json is not at the zip root" >&2
  exit 1
fi

echo
echo "Built: $out"
echo "Chrome Web Store / Edge Add-ons: upload this zip as a new extension version."
echo "Version: ${version}"
