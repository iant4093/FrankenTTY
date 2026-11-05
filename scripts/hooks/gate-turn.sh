#!/usr/bin/env bash
# Stop: when src/ or tests/ changed, the turn may not end until typecheck, lint and tests pass.
# Prints {"decision":"block","reason":...}, which Kiro sends back to the agent as a new message.
# Loop guard: at most 3 blocks per session, then it lets the turn end and logs the failure.
# shellcheck source=scripts/hooks/lib.sh
source "$(dirname "$0")/lib.sh"
event="$(cat)"
session="$(hook_field "$event" session_id)"
cd "$HOOK_ROOT" || exit 0
[ -x node_modules/.bin/vitest ] || exit 0
if [ -z "$(git status --porcelain -- src tests 2>/dev/null)" ]; then exit 0; fi

counter="$HOOK_STATE/gate-${session:-unknown}.count"
count="$(cat "$counter" 2>/dev/null || echo 0)"

report=""
for step in typecheck lint test; do
  if ! out="$(npm run --silent "$step" 2>&1)"; then report+="== npm run $step FAILED ==\n$(printf '%s' "$out" | tail -30)\n"; fi
done

if [ -z "$report" ]; then
  rm -f "$counter"
  hook_log "gate-turn session=$session PASS"
  exit 0
fi
if [ "$count" -ge 3 ]; then
  hook_log "gate-turn session=$session FAIL (guard reached, turn allowed to end)"
  printf 'review-and-pbt: checks still failing after 3 retries; report this to architect-opus.\n' >&2
  exit 0
fi
echo $((count + 1)) > "$counter"
hook_log "gate-turn session=$session BLOCK $((count + 1))/3"
node -e 'process.stdout.write(JSON.stringify({decision:"block",reason:"review-and-pbt gate: fix these failures before you finish.\n"+process.argv[1]}))' "$(printf '%b' "$report")"
exit 0
