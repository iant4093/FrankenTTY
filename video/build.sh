#!/usr/bin/env bash
# Build the FrankenTTY demo video end to end:
#   sessions -> narration -> music -> copy into Remotion -> render -> loudness mix -> checks
# Output: video/output/FrankenTTY_Demo.mp4. Logs: video/build/logs/<step>.log.
# Run `video/build.sh --help` for the flags.
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

usage() {
  cat <<'USAGE'
Usage: video/build.sh [--skip-STEP ...]

Steps, in order (each can be skipped):
  sessions    node tools/session-recorder/record.ts --all   (--skip-sessions)
  narration   Kokoro-82M narration via uv + Python 3.12     (--skip-narration)
  music       procedural ambient bed with ffmpeg lavfi      (--skip-music)
  copy        sessions, narration and music -> video/remotion/public/  (--skip-copy)
  render      Remotion composition FrankenTTYDemo -> video/build/render.mp4  (--skip-render)
  mix         two-pass loudnorm (I=-14 TP=-1.5 LRA=11) -> video/output/FrankenTTY_Demo.mp4  (--skip-mix)
  checks      duration 120-175 s, 1920x1080, audio present, -15..-13 LUFS  (--skip-checks)

A step whose tool is not there yet (record.ts, video/remotion) is skipped with a warning.
Needs: node, ffmpeg, ffprobe; uv for narration; npm for the Remotion render.
USAGE
}

skip_sessions=0 skip_narration=0 skip_music=0 skip_copy=0 skip_render=0 skip_mix=0 skip_checks=0
for arg in "$@"; do
  case "$arg" in
    -h|--help) usage; exit 0 ;;
    --skip-sessions) skip_sessions=1 ;;
    --skip-narration) skip_narration=1 ;;
    --skip-music) skip_music=1 ;;
    --skip-copy) skip_copy=1 ;;
    --skip-render) skip_render=1 ;;
    --skip-mix) skip_mix=1 ;;
    --skip-checks) skip_checks=1 ;;
    *) echo "unknown argument: $arg" >&2; usage >&2; exit 2 ;;
  esac
done

build_dir="video/build"
log_dir="$build_dir/logs"
render_file="$build_dir/render.mp4"
final_file="video/output/FrankenTTY_Demo.mp4"
public_dir="video/remotion/public"
mkdir -p "$log_dir" video/output

overall=0

# run_step [-v] NAME CMD... : run CMD with its output in the log; -v also prints the log.
run_step() {
  local verbose=0
  if [ "$1" = "-v" ]; then verbose=1; shift; fi
  local name="$1"; shift
  local log="$log_dir/$name.log"
  echo "== $name =="
  # Subshell, not an `if` condition, so `set -e` inside the step function takes effect.
  ( "$@" ) >"$log" 2>&1
  local status=$?
  if [ "$status" -eq 0 ]; then
    echo "PASS: $name"
    if [ "$verbose" -eq 1 ]; then cat "$log"; fi
  else
    echo "FAIL: $name (log: $log)"
    tail -40 "$log"
    overall=1
  fi
}

skip() { echo "SKIP: $1 ($2)"; }

# shellcheck disable=SC2329 # called through run_step
step_copy() {
  set -e
  mkdir -p "$public_dir/sessions" "$public_dir/narration" "$public_dir/music"
  local f copied=0
  for f in video/sessions/*.json; do
    [ -e "$f" ] || continue
    cp "$f" "$public_dir/sessions/"
    copied=$((copied + 1))
  done
  for f in video/sessions/*.json.gz; do
    [ -e "$f" ] || continue
    gzip -dc "$f" >"$public_dir/sessions/$(basename "${f%.gz}")"
    copied=$((copied + 1))
  done
  echo "sessions copied: $copied"
  cp "$build_dir"/narration/act?.wav "$build_dir/narration/durations.json" "$public_dir/narration/"
  echo "narration copied: $(find "$public_dir/narration" -name 'act?.wav' | wc -l | tr -d ' ') acts + durations.json"
  cp "$build_dir/music/bed.wav" "$public_dir/music/bed.wav"
  echo "music copied"
}

# shellcheck disable=SC2329 # called through run_step
step_render() {
  set -e
  cd video/remotion
  if [ ! -d node_modules ]; then
    npm ci
  fi
  npm run --if-present prebuild
  npm run render
}

# Pull one number out of loudnorm's JSON block (stdin) with node.
# shellcheck disable=SC2329 # called through run_step
loudnorm_field() {
  node -e '
    const text = require("node:fs").readFileSync(0, "utf8");
    const start = text.lastIndexOf("{");
    const end = text.lastIndexOf("}");
    const data = JSON.parse(text.slice(start, end + 1));
    process.stdout.write(String(data[process.argv[1]]));
  ' "$1"
}

# shellcheck disable=SC2329 # called through run_step
step_mix() {
  set -e
  local target="loudnorm=I=-14:TP=-1.5:LRA=11"
  local first
  first=$(ffmpeg -hide_banner -nostats -i "$render_file" -vn -af "$target:print_format=json" -f null - 2>&1)
  local mi mtp mlra mthresh offset
  mi=$(printf '%s' "$first" | loudnorm_field input_i)
  mtp=$(printf '%s' "$first" | loudnorm_field input_tp)
  mlra=$(printf '%s' "$first" | loudnorm_field input_lra)
  mthresh=$(printf '%s' "$first" | loudnorm_field input_thresh)
  offset=$(printf '%s' "$first" | loudnorm_field target_offset)
  echo "pass 1: input_i=$mi input_tp=$mtp input_lra=$mlra input_thresh=$mthresh target_offset=$offset"

  local vcodec
  vcodec=$(ffprobe -v error -select_streams v:0 -show_entries stream=codec_name,pix_fmt -of csv=p=0 "$render_file")
  local video_args=(-c:v libx264 -preset slow -crf 18 -pix_fmt yuv420p)
  if [ "$vcodec" = "h264,yuv420p" ]; then
    video_args=(-c:v copy)
  fi
  echo "video: $vcodec -> ${video_args[*]}"

  ffmpeg -v error -y -i "$render_file" \
    -af "$target:measured_I=$mi:measured_TP=$mtp:measured_LRA=$mlra:measured_thresh=$mthresh:offset=$offset:linear=true,aresample=48000" \
    "${video_args[@]}" -c:a aac -b:a 192k -movflags +faststart "$final_file"
  echo "wrote $final_file"
}

# shellcheck disable=SC2329 # called through run_step
step_checks() {
  set -e
  local file="$final_file" bad=0
  local duration size fps audio loudness
  duration=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$file")
  size=$(ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 "$file")
  fps=$(ffprobe -v error -select_streams v:0 -show_entries stream=r_frame_rate -of csv=p=0 "$file")
  audio=$(ffprobe -v error -select_streams a -show_entries stream=codec_name -of csv=p=0 "$file")
  loudness=$(ffmpeg -hide_banner -nostats -i "$file" -vn -af ebur128 -f null - 2>&1 |
    awk '/Integrated loudness:/ { want = 1; next } want && $1 == "I:" { print $2; exit }')
  echo "duration:  ${duration} s (need 120-175)"
  echo "size:      ${size} (need 1920x1080)"
  echo "fps:       ${fps} (need 30)"
  echo "audio:     ${audio:-none}"
  echo "loudness:  ${loudness:-unknown} LUFS (need -15..-13)"
  awk -v d="$duration" 'BEGIN { exit !(d >= 120 && d <= 175) }' || { echo "FAIL: duration out of range"; bad=1; }
  [ "$size" = "1920x1080" ] || { echo "FAIL: size is not 1920x1080"; bad=1; }
  [ "$fps" = "30/1" ] || { echo "FAIL: frame rate is not 30"; bad=1; }
  [ -n "$audio" ] || { echo "FAIL: no audio stream"; bad=1; }
  awk -v l="${loudness:-0}" 'BEGIN { exit !(l >= -15 && l <= -13) }' || { echo "FAIL: loudness out of range"; bad=1; }
  return "$bad"
}

# a. sessions (6.A)
if [ "$skip_sessions" -eq 1 ]; then
  skip sessions "flag"
elif [ ! -f tools/session-recorder/record.ts ]; then
  skip sessions "WARNING: tools/session-recorder/record.ts does not exist yet (task 6.A)"
else
  run_step sessions node tools/session-recorder/record.ts --all
fi

# b. narration
if [ "$skip_narration" -eq 1 ]; then
  skip narration "flag"
else
  run_step -v narration uv run --python 3.12 --with kokoro==0.9.4 --with soundfile --with 'numpy<3' \
    python video/narration/narrate.py
fi

# c. music
if [ "$skip_music" -eq 1 ]; then
  skip music "flag"
else
  run_step -v music video/music/music.sh
fi

# d. copy into Remotion's public/
if [ "$skip_copy" -eq 1 ]; then
  skip copy "flag"
elif [ ! -d video/remotion ]; then
  skip copy "WARNING: video/remotion does not exist yet (task 6.B)"
else
  run_step -v copy step_copy
fi

# e. render
if [ "$skip_render" -eq 1 ]; then
  skip render "flag"
elif [ ! -f video/remotion/package.json ]; then
  skip render "WARNING: video/remotion/package.json does not exist yet (task 6.B)"
else
  run_step render step_render
  [ -f "$render_file" ] || { echo "FAIL: render did not produce $render_file"; overall=1; }
fi

# f. mix (Remotion already placed narration and music with <Audio>; this only normalizes loudness)
if [ "$skip_mix" -eq 1 ]; then
  skip mix "flag"
elif [ ! -f "$render_file" ]; then
  skip mix "WARNING: $render_file does not exist"
else
  run_step -v mix step_mix
fi

# g. checks
if [ "$skip_checks" -eq 1 ]; then
  skip checks "flag"
elif [ ! -f "$final_file" ]; then
  skip checks "WARNING: $final_file does not exist"
else
  run_step -v checks step_checks
fi

echo
if [ "$overall" -eq 0 ]; then echo "RESULT: PASS"; else echo "RESULT: FAIL"; fi
exit "$overall"
