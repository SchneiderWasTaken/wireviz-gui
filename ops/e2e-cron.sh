#!/usr/bin/env bash
# wireviz-gui daily e2e regression — runs the browser test suite against the live site.
# Skips cleanly (exit 0) while the site is not deployed yet.
set -uo pipefail

export WIREVIZ_GUI_URL="${WIREVIZ_GUI_URL:-https://schneiderwastaken.github.io/wireviz-gui/}"
WORK_DIR="$HOME/.aidevops/.agent-workspace/work/wireviz-gui"
REPO_E2E="/home/opencode/Git/_worktrees/wireviz-gui-v0/ops/e2e.cjs"
mkdir -p "$WORK_DIR"

code="$(curl -s -o /dev/null -w "%{http_code}" --max-time 20 "${WIREVIZ_GUI_URL%/}/")"
if [ "$code" != "200" ]; then
  echo "$(date -Is) SKIP site not live yet (HTTP $code)"
  exit 0
fi

if [ ! -f "$REPO_E2E" ]; then
  echo "$(date -Is) FAIL e2e script missing at $REPO_E2E"
  exit 1
fi

node "$REPO_E2E" > "$WORK_DIR/e2e-last.log" 2>&1
status=$?
tail -n 8 "$WORK_DIR/e2e-last.log"
echo "$(date -Is) e2e exit=$status"
exit "$status"
