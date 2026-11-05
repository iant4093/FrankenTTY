#!/usr/bin/env bash
# Generate assets/demo-<name>.mp4 from the procedural lavfi sources in src/ingest/demo.ts.
# Usage: bash scripts/generate-demo-media.sh [name] [seconds]   (default: mandelbrot, 20)
# assets/*.mp4 is gitignored; this script recreates it.
set -euo pipefail
cd "$(dirname "$0")/.." || exit 1

name="${1:-mandelbrot}"
seconds="${2:-20}"

if ! [[ "$name" =~ ^[a-z0-9]+$ ]]; then
  echo "FAIL: demo name must be lowercase letters and digits: $name" >&2
  exit 2
fi
if ! [[ "$seconds" =~ ^[0-9]+$ ]] || [ "$seconds" -lt 1 ] || [ "$seconds" -gt 60 ]; then
  echo "FAIL: seconds must be an integer from 1 to 60: $seconds" >&2
  exit 2
fi
for tool in ffmpeg ffprobe node; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "FAIL: $tool not found on PATH" >&2
    exit 1
  fi
done

# One source of truth: read the filters from src/ingest/demo.ts as JSON.
# getDemo throws RangeError for an unknown name, which fails this script.
filters="$(node -e "
import('./src/ingest/demo.ts').then((m) => {
  const d = m.getDemo(process.argv[1]);
  process.stdout.write(JSON.stringify({ video: d.videoFilter, audio: d.audioFilter, fps: d.fps }));
}).catch((e) => { console.error(String(e.message || e)); process.exit(1); });
" "$name")"

video_filter="$(node -e "process.stdout.write(JSON.parse(process.argv[1]).video)" "$filters")"
audio_filter="$(node -e "process.stdout.write(JSON.parse(process.argv[1]).audio)" "$filters")"
fps="$(node -e "process.stdout.write(String(JSON.parse(process.argv[1]).fps))" "$filters")"

mkdir -p assets
out="assets/demo-${name}.mp4"

ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "$video_filter" \
  -f lavfi -i "$audio_filter" \
  -t "$seconds" \
  -map 0:v:0 -map 1:a:0 \
  -r "$fps" -pix_fmt yuv420p \
  -c:v libx264 -preset veryfast -crf 20 \
  -c:a aac -b:a 160k \
  -movflags +faststart \
  "$out"

size="$(wc -c <"$out" | tr -d ' ')"
duration="$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$out")"
echo "PASS: ${out} (${size} bytes, ${duration}s)"
echo "RESULT: PASS"
