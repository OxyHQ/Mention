#!/usr/bin/env bash
# Carry the previous release's hashed assets into this release's output.
#
# The shell Worker serves exactly the assets of the version deployed last, so a
# deploy makes every chunk of the release before it a 404 at once. Anything
# still holding that release's document — an open tab, a browser cache, a
# layer that has not yet revalidated — then asks for chunks that are gone and
# boots into a blank app ("Requiring unknown module"). Shipping the previous
# release's hashed files ALONGSIDE the new ones makes that document keep working
# until the next reload.
#
# Only files under `_expo/static` are carried: they are content-hashed, so a
# carried file can never shadow a different one, and `cp -n` refuses to
# overwrite one the new release already has. The document itself is never
# carried — the new release's `index.html` is the only one that is served.
#
# The source is the PREVIOUS release's own build output (uploaded by the
# deploy), not the previous deployment, so nothing accumulates: release N ships
# N and N-1, never N-2.
#
# Usage: carry-previous-static.sh <dist-dir> <previous-static-dir>
set -euo pipefail

dist="${1:?usage: carry-previous-static.sh <dist-dir> <previous-static-dir>}"
previous="${2:?usage: carry-previous-static.sh <dist-dir> <previous-static-dir>}"

if [[ ! -d "$previous" ]]; then
  echo "::notice::No previous release output to carry forward; this release ships only its own assets."
  exit 0
fi
if [[ ! -d "$dist/_expo/static" ]]; then
  echo "::error::$dist/_expo/static does not exist; refusing to carry assets into a build that has none."
  exit 1
fi

before="$(find "$dist/_expo/static" -type f | wc -l)"
( cd "$previous" && find . -type f -print0 ) |
  while IFS= read -r -d '' file; do
    target="$dist/_expo/static/$file"
    mkdir -p "$(dirname "$target")"
    cp -n "$previous/$file" "$target"
  done
after="$(find "$dist/_expo/static" -type f | wc -l)"

echo "Carried $((after - before)) file(s) from the previous release ($before of this release's own)."
