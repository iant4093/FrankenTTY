#!/usr/bin/env bash
# PreToolUse(shell): deny `git commit` unless the repo is submission-safe.
# Also usable directly: `bash scripts/hooks/compliance-guard.sh --check` (CI and manual runs).
# shellcheck source=scripts/hooks/lib.sh
source "$(dirname "$0")/lib.sh"
if [ "${1:-}" != --check ]; then
  event="$(cat)"
  cmd="$(hook_field "$event" tool_input.command)"
  case "$cmd" in *"git commit"*) ;; *) exit 0 ;; esac
fi
cd "$HOOK_ROOT" || exit 2
fail=()
for d in .kiro/steering .kiro/specs .kiro/hooks .kiro/agents; do
  [ -d "$d" ] || fail+=("missing $d")
done
# `git check-ignore -q` accepts one path at a time (more than one exits 128), so check each.
for p in .kiro .kiro/steering/product.md .kiro/specs/frankentty/requirements.md .kiro/hooks/review-and-pbt.json .kiro/agents/builder-sonnet.json; do
  if git check-ignore -q --no-index "$p" 2>/dev/null; then
    fail+=(".gitignore ignores $p (forbidden: .kiro must stay tracked)")
    break
  fi
done
grep -q '^MIT License' LICENSE 2>/dev/null || fail+=("LICENSE missing or not MIT")
if grep -rIl --exclude-dir=node_modules --exclude-dir=build --exclude-dir=dist -E 'AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|npm_[A-Za-z0-9]{36}' . 2>/dev/null | grep -q .; then
  fail+=("possible secret in tracked files")
fi
if [ ${#fail[@]} -gt 0 ]; then
  printf 'compliance-guard: commit blocked:\n' >&2
  printf '  - %s\n' "${fail[@]}" >&2
  hook_log "compliance-guard BLOCK ${fail[*]}"
  exit 2
fi
hook_log "compliance-guard PASS"
[ "${1:-}" = --check ] && echo "compliance-guard: PASS"
exit 0
