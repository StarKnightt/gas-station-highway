#!/usr/bin/env bash
# Type-check gate for the System 1 files.
#
# The repo is edited concurrently by agents working on later systems, so a
# whole-project `tsc` blocks on their in-progress code. This reports only errors
# in files System 1 owns, and exits non-zero so callers can chain with &&.
#
# Bundling is NOT done here any more: `tools/shoot.mjs` builds into its own
# private output directory immediately before capturing, so a screenshot can
# never be taken against a bundle that some other process has since replaced.
set -u
cd "$(dirname "$0")/.." || exit 1

# Named explicitly rather than by directory: `src/gen/` also holds the pump and
# building generators, which other agents are actively editing.
OWNED='src/gen/(textures|geo|siteOverlay|noise|worldDetail)\.ts|src/systems/TerrainSystem|src/site\.ts|src/core/'

mine=$(pnpm exec tsc --noEmit 2>&1 | grep -E "$OWNED" | head -20)
if [ -n "$mine" ]; then
  echo "TYPE ERRORS IN SYSTEM 1 FILES"
  echo "$mine"
  exit 1
fi

echo "typecheck ok"
