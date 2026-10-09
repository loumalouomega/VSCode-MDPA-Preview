#!/usr/bin/env bash
# Install the MDPA extension into VS Code (server or desktop) without vsce.
# Run from the repo root: bash install.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PUBLISHER="$(node -e "process.stdout.write(require('$SCRIPT_DIR/package.json').publisher)")"
PKG_NAME="$(node -e "process.stdout.write(require('$SCRIPT_DIR/package.json').name)")"
VERSION="$(node -e "process.stdout.write(require('$SCRIPT_DIR/package.json').version)")"
EXT_NAME="$PUBLISHER.$PKG_NAME-$VERSION"

# esbuild copies the webview/extension inputs out of node_modules verbatim, so
# a checkout whose dependencies predate the current tree (e.g. a package added
# since the last install) fails mid-build with a bare ENOENT. Heal that here
# instead: if any copy source is absent, reinstall before building.
NEED=(
  "node_modules/plotly.js-strict-dist-min/plotly-strict.min.js"
  "node_modules/@loumalouomega/mmg-wasm/dist/mmg-core.wasm"
  "node_modules/pyodide/pyodide.js"
  "node_modules/@meshioplusplus/wasm/src/index.mjs"
  "node_modules/@kratos-flowgraph/flowgraph/public"
  "node_modules/@kratos-flowgraph/flowgraph/views"
)
STALE_DEPS=false
for f in "${NEED[@]}"; do
  if [[ ! -e "$SCRIPT_DIR/$f" ]]; then
    echo "→ Missing $f — dependencies look stale."
    STALE_DEPS=true
    break
  fi
done
if [[ "$STALE_DEPS" == true ]]; then
  echo "→ Running 'npm ci' first..."
  (cd "$SCRIPT_DIR" && npm ci)
fi

# Find the extensions folder (server > desktop > fallback).
if [[ -d "$HOME/.vscode-server/extensions" ]]; then
  EXT_BASE="$HOME/.vscode-server/extensions"
elif [[ -d "$HOME/.vscode/extensions" ]]; then
  EXT_BASE="$HOME/.vscode/extensions"
else
  echo "Could not find a VS Code extensions folder under ~/.vscode-server or ~/.vscode" >&2
  exit 1
fi
EXT_DIR="$EXT_BASE/$EXT_NAME"

echo "→ Building extension..."
(cd "$SCRIPT_DIR" && npm run compile)

echo "→ Installing to $EXT_DIR"
rm -rf "$EXT_DIR"
mkdir -p "$EXT_DIR"

# Copy the files VS Code needs (no node_modules, no dev sources). This mirrors
# .vscodeignore's packaged set: dist/ (host bundles), media/ (webview bundle +
# css + vendored runtimes), syntaxes/, the manifest files, the icons the
# manifest references, and CHANGELOG.md (the What's New popup reads it from
# the install dir and stays silent without it).
cp "$SCRIPT_DIR/package.json"              "$EXT_DIR/"
cp "$SCRIPT_DIR/language-configuration.json" "$EXT_DIR/"
cp "$SCRIPT_DIR/CHANGELOG.md"               "$EXT_DIR/"
cp -r "$SCRIPT_DIR/syntaxes"               "$EXT_DIR/"
cp -r "$SCRIPT_DIR/dist"                   "$EXT_DIR/"
cp -r "$SCRIPT_DIR/media"                  "$EXT_DIR/"
mkdir -p "$EXT_DIR/images"
cp "$SCRIPT_DIR/images/icon.png"              "$EXT_DIR/images/"
cp "$SCRIPT_DIR/images/icon_transparency.png" "$EXT_DIR/images/"
cp "$SCRIPT_DIR/images/kratos-activitybar.svg" "$EXT_DIR/images/"

# VS Code activates the HIGHEST installed version number, so a stale install
# with a higher number would shadow this fresh build. Remove every other
# version of this extension (same prune as scripts/reinstall-local.sh).
STALE=$(find "$EXT_BASE" -maxdepth 1 -name "${PUBLISHER}.${PKG_NAME}-*" ! -name "$EXT_NAME" || true)
if [ -n "$STALE" ]; then
  echo "→ Removing stale install(s):"
  echo "$STALE" | sed 's/^/    /'
  echo "$STALE" | xargs -r rm -rf
fi

# Sanity check: the host entry, the plot worker and the webview bundles the
# manifest/chrome actually loads.
for f in dist/extension.js dist/plotWorker.js media/webview.js media/plots.js media/plotly/plotly.min.js images/kratos-activitybar.svg CHANGELOG.md; do
  if [[ ! -e "$EXT_DIR/$f" ]]; then
    echo "!! Installed extension is missing $f — install incomplete." >&2
    exit 1
  fi
done

echo "✓ Extension installed."
echo ""
echo "  Reload VS Code (Ctrl+Shift+P → Developer: Reload Window), then"
echo "  open any .mdpa file and use the 'Open MDPA Preview' button or command."
