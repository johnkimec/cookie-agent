#!/bin/bash
# Both iosMath font layouts. Swift 6.3.3 is flat. Swift 6.4 is a standard bundle.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
# shellcheck source=package-app.sh
source "$ROOT/app/Scripts/package-app.sh"

tmp="$(mktemp -d "${TMPDIR:-/tmp}/cookie-iosmath.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT

mkdir -p "$tmp/empty/iosMath_iosMath.bundle"
if require_iosmath_font "$tmp/empty/iosMath_iosMath.bundle" 2>"$tmp/empty.err"; then
  echo "empty bundle was accepted" >&2
  exit 1
fi
if ! grep -F "fonts/latinmodern-math.otf" "$tmp/empty.err" >/dev/null; then
  echo "empty bundle did not report the missing font" >&2
  cat "$tmp/empty.err" >&2
  exit 1
fi
if ! grep -F "Contents/Resources/fonts/latinmodern-math.otf" "$tmp/empty.err" >/dev/null; then
  echo "empty bundle did not report the standard-bundle path" >&2
  cat "$tmp/empty.err" >&2
  exit 1
fi

mkdir -p "$tmp/flat/iosMath_iosMath.bundle/fonts"
touch "$tmp/flat/iosMath_iosMath.bundle/fonts/latinmodern-math.otf"
require_iosmath_font "$tmp/flat/iosMath_iosMath.bundle"

mkdir -p "$tmp/standard/iosMath_iosMath.bundle/Contents/Resources/fonts"
touch "$tmp/standard/iosMath_iosMath.bundle/Contents/Resources/fonts/latinmodern-math.otf"
require_iosmath_font "$tmp/standard/iosMath_iosMath.bundle"

echo "iosmath font layouts ok"
