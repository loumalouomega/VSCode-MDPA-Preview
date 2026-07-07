#!/usr/bin/env bash
# Bumps the patch version, builds, packages, and installs this extension into
# the currently running VS Code — required on Remote/SSH, where the running
# extension is the installed copy under ~/.vscode-server/extensions/, not the
# workspace dist/, so a rebuild alone never reaches the editor. Safe to run
# locally too (falls back to `code`'s normal user extensions dir when not on
# Remote/SSH). Mirrors the sibling CAD-Preview project's scripts/reinstall-local.sh.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

NAME=$(node -p "require('./package.json').name")
PUBLISHER=$(node -p "require('./package.json').publisher")
EXT_ID="${PUBLISHER}.${NAME}"

echo "==> Type-checking"
npm run typecheck

echo "==> Bumping patch version"
npm version patch --no-git-tag-version >/dev/null
VERSION=$(node -p "require('./package.json').version")
echo "    ${EXT_ID}@${VERSION}"

echo "==> Packaging"
rm -f "${NAME}"-*.vsix
# Use the pinned @vscode/vsce from devDependencies, not `npx vsce` (which
# resolves the unrelated, newer standalone `vsce` package and can pull in a
# Node-version-incompatible dependency tree) — same convention as
# .github/workflows/package.yml.
./node_modules/.bin/vsce package --no-dependencies >/dev/null
VSIX="${NAME}-${VERSION}.vsix"

CODE_CLI="$(command -v code || command -v code-server || true)"
if [ -z "$CODE_CLI" ]; then
  echo "!! No 'code' or 'code-server' CLI on PATH — built ${VSIX} but did not install it."
  exit 0
fi

echo "==> Installing via '${CODE_CLI} --install-extension'"
"$CODE_CLI" --install-extension "$VSIX"

# Remote/SSH keeps every installed version's directory around; an older one
# left in place has occasionally been the wrong copy VS Code activates.
EXT_DIR="${HOME}/.vscode-server/extensions"
if [ -d "$EXT_DIR" ]; then
  STALE=$(find "$EXT_DIR" -maxdepth 1 -name "${EXT_ID}-*" ! -name "${EXT_ID}-${VERSION}")
  if [ -n "$STALE" ]; then
    echo "==> Removing stale install(s):"
    echo "$STALE" | sed 's/^/    /'
    echo "$STALE" | xargs -r rm -rf
  fi
fi

echo
echo "==> Done: ${EXT_ID}@${VERSION} installed."
echo "==> Reload the window (Developer: Reload Window) to pick it up."
