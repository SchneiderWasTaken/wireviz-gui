#!/usr/bin/env bash
# wireviz-gui site health check — verifies the deployed app and its assets respond.
# Scheduled via cron with an `# aidevops:` label; registered in the repo TODO.md.
set -uo pipefail

URL="${WIREVIZ_GUI_URL:-https://schneiderwastaken.github.io/wireviz-gui/}"
URL="${URL%/}/"

fail() {
  echo "$(date -Is) FAIL $1"
  exit 1
}

for path in "" "app.js" "style.css" "vendor/viz-standalone.js" "vendor/js-yaml.min.js" "vendor/fflate.min.js"; do
  code="$(curl -s -o /dev/null -w "%{http_code}" --max-time 20 "${URL}${path}")"
  if [ "$code" != "200" ]; then
    fail "${URL}${path} -> HTTP $code"
  fi
done

echo "$(date -Is) OK all assets 200 (${URL})"
