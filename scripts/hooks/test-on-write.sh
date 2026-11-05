#!/usr/bin/env bash
# PostToolUse(fs_write): after a write under src/ or tests/, run the tests related to that file.
# Non-zero exit is a warning the agent sees on stderr; it does not block the write.
# shellcheck source=scripts/hooks/lib.sh
source "$(dirname "$0")/lib.sh"
event="$(cat)"
path="$(hook_field "$event" tool_input.path)"
rel="${path#"$HOOK_ROOT"/}"
case "$rel" in
  src/*.ts|tests/*.ts) ;;
  *) exit 0 ;;
esac
cd "$HOOK_ROOT" || exit 0
[ -x node_modules/.bin/vitest ] || exit 0
out="$(node_modules/.bin/vitest related "$rel" --run --reporter=dot --passWithNoTests 2>&1)"
status=$?
hook_log "test-on-write $rel exit=$status"
if [ $status -ne 0 ]; then
  printf 'review-and-pbt: tests related to %s FAILED. Fix before finishing.\n%s\n' "$rel" "$(printf '%s' "$out" | tail -40)" >&2
  exit 1
fi
exit 0
