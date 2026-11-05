#!/usr/bin/env bash
# Shared helpers for .kiro/hooks command hooks. Hooks receive the event JSON on stdin.
set -uo pipefail
HOOK_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HOOK_STATE="$HOOK_ROOT/build/hooks"
mkdir -p "$HOOK_STATE"

# hook_field <json> <dot.path>  -> prints the value or nothing
hook_field() {
  node -e '
    let v = JSON.parse(process.argv[1] || "{}");
    for (const k of process.argv[2].split(".")) v = v == null ? undefined : v[k];
    if (v != null) process.stdout.write(typeof v === "string" ? v : JSON.stringify(v));
  ' "$1" "$2" 2>/dev/null
}

hook_log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$HOOK_STATE/hooks.log"; }
