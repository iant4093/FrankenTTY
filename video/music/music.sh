#!/usr/bin/env bash
# Procedural ambient bed: slow minor-key chord pad synthesized by FFmpeg lavfi
# (aevalsrc only; no samples, no downloads). Written to video/build/music/bed.wav.
#
#   video/music/music.sh                 length = total narration + 6 s (from durations.json)
#   video/music/music.sh --duration 3    explicit length in seconds (used by tests)
#   video/music/music.sh --output FILE   write somewhere else
#
# The pad is four chords (Am, Fmaj7, C, Em). Each chord fades in and out with a
# sin^2 window twice as long as the chord step, so neighbours overlap and the
# window weights always sum to 1. A slow tremolo and a low-pass keep it soft.
# Peak level is below -20 dBFS by construction (4 notes * 0.015 * 1.4 = 0.084)
# and is verified with volumedetect.
set -euo pipefail
cd "$(dirname "$0")/../.."

duration=""
output="video/build/music/bed.wav"
step=10 # seconds per chord

usage() {
  sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --duration) duration="${2:?--duration needs seconds}"; shift 2 ;;
    --output) output="${2:?--output needs a path}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "FAIL: ffmpeg not found on PATH" >&2
  exit 1
fi

if [ -z "$duration" ]; then
  durations="video/build/narration/durations.json"
  if [ ! -f "$durations" ]; then
    echo "FAIL: $durations missing; run narration first or pass --duration" >&2
    exit 1
  fi
  duration=$(node -e '
    const d = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    const acts = Object.keys(d).filter((k) => /^act\d+$/.test(k));
    process.stdout.write(String(acts.reduce((s, k) => s + d[k], 0) + 6));
  ' "$durations")
fi

if ! awk -v d="$duration" 'BEGIN { exit !(d + 0 > 0) }'; then
  echo "FAIL: invalid duration: $duration" >&2
  exit 2
fi

# Chord notes in Hz (fundamental; a quieter 2nd harmonic is added per note).
chords=(
  "110.00 164.81 220.00 261.63"   # Am
  "87.31 130.81 220.00 329.63"    # Fmaj7 (no 5th)
  "130.81 196.00 261.63 329.63"   # C
  "82.41 123.47 196.00 246.94"    # Em
)
count=${#chords[@]}
period=$((step * count))
window=$((step * 2))

# One channel expression. $1 = detune in Hz added to every note (stereo width).
channel_expr() {
  local detune="$1" k f out="" u
  for ((k = 0; k < count; k++)); do
    u="mod(t-$((k * step))+$period,$period)"
    local sum=""
    for f in ${chords[$k]}; do
      sum+="+0.015*(sin(2*PI*($f+$detune)*t)+0.4*sin(4*PI*($f+$detune)*t))"
    done
    out+="+if(lt($u,$window),pow(sin(PI*$u/$window),2),0)*(${sum#+})"
  done
  echo "(${out#+})*(0.85+0.15*sin(2*PI*0.18*t))"
}

left=$(channel_expr 0.15)
right=$(channel_expr -0.15)

fade_in=$(awk -v d="$duration" 'BEGIN { x = d / 3; if (x > 2) x = 2; print x }')
fade_out=$(awk -v d="$duration" 'BEGIN { x = d / 3; if (x > 4) x = 4; print x }')
fade_out_start=$(awk -v d="$duration" -v f="$fade_out" 'BEGIN { print d - f }')

mkdir -p "$(dirname "$output")"
ffmpeg -v error -y \
  -f lavfi -i "aevalsrc=exprs='${left}|${right}':s=48000:d=${duration}" \
  -af "lowpass=f=1800,afade=t=in:d=${fade_in},afade=t=out:st=${fade_out_start}:d=${fade_out}" \
  -c:a pcm_s16le -ar 48000 "$output"

peak=$(ffmpeg -hide_banner -nostats -i "$output" -af volumedetect -f null - 2>&1 |
  sed -n 's/.*max_volume: \(-\{0,1\}[0-9.]*\) dB.*/\1/p')
if [ -z "$peak" ] || ! awk -v p="$peak" 'BEGIN { exit !(p <= -20) }'; then
  echo "FAIL: peak ${peak:-unknown} dBFS is above -20 dBFS" >&2
  exit 1
fi
echo "music: $output ${duration}s peak ${peak} dBFS"
