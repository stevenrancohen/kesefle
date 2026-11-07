#!/usr/bin/env bash
# Rebuilds /js/kfx-phone3d.mjs from scripts/kfx/phone3d.src.mjs (Three.js, tree shaken).
# Needs network once for npm. Output is committed; the site itself has no build step.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cd "$WORK"
npm init -y >/dev/null
npm install --no-audit --no-fund --loglevel=error three@0.187.0 esbuild@0.25.10 >/dev/null
cp "$ROOT/scripts/kfx/phone3d.src.mjs" ./phone3d.src.mjs
./node_modules/.bin/esbuild phone3d.src.mjs --bundle --format=esm --minify --target=es2019 --legal-comments=eof --outfile="$ROOT/js/kfx-phone3d.mjs"
echo "built js/kfx-phone3d.mjs"
