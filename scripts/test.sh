#!/usr/bin/env bash
# Typecheck, lint and the full test suite (unit, property-based, integration, PTY).
# Same entry point for CI and local use. Logs go to build/logs/.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
mkdir -p build/logs

overall=0
run_step() {
  local name="$1"; shift
  local log="build/logs/$name.log"
  echo "== $name =="
  if "$@" >"$log" 2>&1; then
    echo "PASS: $name"
  else
    echo "FAIL: $name (log: $log)"
    tail -40 "$log"
    overall=1
  fi
}

node --version
run_step typecheck npm run --silent typecheck
run_step lint npm run --silent lint
run_step test npx vitest run --reporter=default
echo
if [ $overall -eq 0 ]; then echo "RESULT: PASS"; else echo "RESULT: FAIL"; fi
exit $overall
