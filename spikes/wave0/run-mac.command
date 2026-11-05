#!/bin/zsh
# Wave 0 hand test for Apple Terminal.
# Usage: zsh run-mac.command          (probe + keys + fps)
#        zsh run-mac.command sweep    (speed sweep, about 30 s, no keys needed)
cd "/Users/iantruong/Desktop/Fun/FrankenTTY/spikes/wave0/dist" || exit 1
if [ "$1" = sweep ]; then
  ./wave0-macos-arm64 sweep --per 1.5 --out "wave0-apple-terminal-sweep.json"
else
  ./wave0-macos-arm64 all --seconds 4 --key-seconds 30 --out "wave0-apple-terminal.json"
fi
echo
echo "Done. You can close this window."
