#!/usr/bin/env bash
# Packages hireloop as an agent-skill zip: SKILL.md at the root, the app under app/.
# Only git-tracked files are included, so .env, profile.md, hireloop.config.json and data/ never ship.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VERSION="$(node -p "require('./package.json').version")"
OUT_DIR="$ROOT/dist"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
PKG="$STAGE/hireloop"
ZIP="$OUT_DIR/hireloop-skill-v$VERSION.zip"

mkdir -p "$PKG/app" "$OUT_DIR"
cp skill/SKILL.md "$PKG/SKILL.md"

# Tracked files only, minus repo-maintenance files that mean nothing to a skill user.
git ls-files -z \
  | grep -zvE '^(\.github/|skill/|scripts/package-skill\.sh$)' \
  | while IFS= read -r -d '' f; do
      [ -f "$f" ] || continue   # skip files deleted in the working tree
      mkdir -p "$PKG/app/$(dirname "$f")"
      cp "$f" "$PKG/app/$f"
    done

# Belt and braces: refuse to ship anything personal or secret.
for bad in .env profile.md hireloop.config.json data settings.local.json; do
  if find "$PKG" -name "$bad" -not -name '*.example*' | grep -q .; then
    echo "refusing to package: found '$bad' in the bundle" >&2
    exit 1
  fi
done

rm -f "$ZIP"
(cd "$PKG" && zip -qr -X "$ZIP" .)
echo "✓ $ZIP"
unzip -l "$ZIP" | tail -n 1
