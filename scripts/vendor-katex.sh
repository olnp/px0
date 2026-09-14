#!/usr/bin/env sh
# Vendor the pinned KaTeX build into web/lib/katex/<version>/.
#
# Downloads the npm tarball, verifies its sha256, and extracts only
#
#   package/dist/katex.mjs
#   package/dist/katex.min.css
#   package/dist/fonts/
#
# preserving the relative layout katex.min.css expects (fonts/ next to the
# stylesheet). katex.mjs is the self-contained ES module (no imports); the
# CommonJS katex.min.js would need a bundler. Source maps and the other dist
# flavours are not extracted. web/src/markdown.js imports the module at
# /static/lib/katex/<version>/katex.mjs with a computed dynamic import, so
# none of this reaches web/app.js. The version directory keeps the immutable
# /static/lib/ cache header safe when the pin moves.
#
# Requires curl and tar. Safe to re-run: every run rebuilds the checkout from
# the verified tarball, so an interrupted run is fixed by running it again.
set -eu

VERSION=0.16.47
SHA256=ad2d1ab2f7fcc227019784320e8a2c5218ff6bb333b36df4136d10365ae29375
TARBALL_URL="https://registry.npmjs.org/katex/-/katex-${VERSION}.tgz"

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
DEST="$ROOT/web/lib/katex/$VERSION"
REL=${DEST#"$ROOT"/}

TMP=$(mktemp -d "${TMPDIR:-/tmp}/px0-katex.XXXXXX")
trap 'rm -rf "$TMP"' EXIT

log() { printf '[vendor-katex] %s\n' "$*"; }
die() { printf '[vendor-katex] error: %s\n' "$*" >&2; exit 1; }

command -v curl >/dev/null 2>&1 || die "curl is required"
command -v tar >/dev/null 2>&1 || die "tar is required"

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    openssl dgst -sha256 "$1" | awk '{print $NF}'
  fi
}

log "downloading katex $VERSION"
curl -fsSL --retry 2 --connect-timeout 10 -o "$TMP/katex.tgz" "$TARBALL_URL" ||
  die "download failed: $TARBALL_URL"

got=$(sha256_of "$TMP/katex.tgz")
[ "$got" = "$SHA256" ] ||
  die "sha256 mismatch: expected $SHA256, got $got"
log "sha256 ok"

log "extracting dist files"
STAGE="$TMP/stage"
mkdir -p "$STAGE"
tar -xzf "$TMP/katex.tgz" -C "$STAGE" \
  package/dist/katex.mjs \
  package/dist/katex.min.css \
  package/dist/fonts
find "$STAGE" -name '*.map' -type f -exec rm -f {} +
[ -f "$STAGE/package/dist/katex.mjs" ] || die "entry module missing from tarball"
[ -f "$STAGE/package/dist/katex.min.css" ] || die "stylesheet missing from tarball"
mkdir -p "$STAGE/katex"
mv "$STAGE/package/dist/katex.mjs" "$STAGE/katex/katex.mjs"
mv "$STAGE/package/dist/katex.min.css" "$STAGE/katex/katex.min.css"
mv "$STAGE/package/dist/fonts" "$STAGE/katex/fonts"
rm -rf "$STAGE/package"

# katex.min.css references fonts/ relatively; the module graph has no imports.
log "checking the font references"
for spec in $(grep -o "url(fonts/[^)]*)" "$STAGE/katex/katex.min.css" | sed 's/url(fonts\///;s/)//'); do
  [ -f "$STAGE/katex/fonts/$spec" ] || die "unresolved font reference: $spec"
done

bytes=$(find "$STAGE" -type f -exec cat {} + | wc -c | tr -d ' ')
mib=$(awk -v b="$bytes" 'BEGIN { printf "%.1f", b / 1048576 }')
log "refs ok: $(find "$STAGE" -type f | wc -l | tr -d ' ') files, $bytes bytes ($mib MiB)"

log "installing into $REL"
rm -rf "$ROOT/web/lib/katex"
mkdir -p "$(dirname "$DEST")"
mv "$STAGE/katex" "$DEST"
log "done: katex $VERSION -> $REL"
