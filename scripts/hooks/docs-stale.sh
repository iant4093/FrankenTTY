#!/usr/bin/env bash
# Stop: when tasks.md or the CLI surface changed, leave a marker for architect-opus
# to sync README.md and DEVPOST_WRITEUP.md during review.
# shellcheck source=scripts/hooks/lib.sh
source "$(dirname "$0")/lib.sh"
cat > /dev/null
cd "$HOOK_ROOT" || exit 0
changed="$(git status --porcelain -- .kiro/specs/frankentty/tasks.md src/cli src/main.ts 2>/dev/null)"
[ -z "$changed" ] && exit 0
printf '%s\n%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$changed" > "$HOOK_STATE/docs-stale"
hook_log "sync-docs marker written"
exit 0
