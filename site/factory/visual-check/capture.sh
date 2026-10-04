#!/usr/bin/env bash
# Regenerate the factory board visual-check fixtures (site/factory/visual-check/).
#
# The board is zero-build and reads live `factory-data` snapshots; these
# fixtures are captured against the BUNDLED fixture snapshot instead
# (visual-check/fixture.json, via the board's ?fixture= mode) so every
# surface — lane summaries, progress bars, backlog lanes, details drawer,
# token table — renders deterministically, no network, no rate limits.
#
# Requires a headless-capable chromium on PATH. The board pins "now" to the
# fixture's tick time in fixture mode, so re-runs produce identical frames.
#
# Usage: bash site/factory/visual-check/capture.sh
set -eu
cd "$(dirname "$0")/.."   # site/factory — the board root (fixture URLs are relative to it)

CHROME="${CHROME:-$(command -v chromium || command -v chromium-browser || command -v google-chrome)}"
BASE="file://$PWD/index.html"
OUT="visual-check"
FIXTURE="visual-check/fixture.json"

shot() { # shot <name> <w> <h> <query>
  local name="$1" w="$2" h="$3" q="$4"
  "$CHROME" --headless=new --no-sandbox --disable-gpu \
    --allow-file-access-from-files --hide-scrollbars \
    --window-size="$w,$h" --virtual-time-budget=5000 \
    --screenshot="$OUT/$name" "$BASE?$q" 2>/dev/null
  echo "  $name"
}

echo "capturing factory-board visual-check fixtures (fixture=$FIXTURE)"
shot "factory-board.visual-check.1440x900.dark.png"          1440 900  "fixture=$FIXTURE&theme=dark"
shot "factory-board.visual-check.1440x900.light.png"         1440 900  "fixture=$FIXTURE&theme=light"
shot "factory-board.visual-check.2048x1320.dark.png"         2048 1320 "fixture=$FIXTURE&theme=dark"
shot "factory-board.visual-check.390x844.dark.mobile.png"    390  844  "fixture=$FIXTURE&theme=dark"
# the drawer is an overlay — captured open (deep-linked) as its own frame
shot "factory-board.visual-check.1440x900.dark.drawer.png"   1440 900  "fixture=$FIXTURE&theme=dark&drawer=pr-817@validating"
echo "done"
