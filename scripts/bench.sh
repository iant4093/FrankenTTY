#!/usr/bin/env bash
# Compression sweep: runs `node src/main.ts --bench --json` over demos x thresholds x color depths
# x sizes (half-block), then Braille and ASCII once, and writes the results as JSON lines and a
# markdown table. The numbers feed docs/EVIDENCE.md and the default --threshold.
#
# Usage: bash scripts/bench.sh
# Output: build/bench/sweep.jsonl, build/bench/sweep.md, build/bench/runs.log
# Runtime: under 1 minute on a laptop (100 half-block runs + 2 mode runs, 150 frames each).
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

out_dir="build/bench"
jsonl="$out_dir/sweep.jsonl"
table="$out_dir/sweep.md"
log="$out_dir/runs.log"
frames=150

mkdir -p "$out_dir"
: >"$jsonl"
: >"$log"

for tool in ffmpeg ffprobe node; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "FAIL: $tool not found on PATH" >&2
    echo "RESULT: FAIL"
    exit 1
  fi
done

failures=0
runs=0

# run_one <demo> <size> <mode> <depth> <threshold>
run_one() {
  local demo="$1" size="$2" mode="$3" depth="$4" threshold="$5"
  local line
  runs=$((runs + 1))
  if line="$(node src/main.ts --bench --demo "$demo" --json --frames "$frames" --size "$size" \
    --mode "$mode" --color "$depth" --threshold "$threshold" 2>>"$log")"; then
    printf '%s\n' "$line" >>"$jsonl"
    echo "ok   $demo $size $mode $depth t=$threshold" >>"$log"
  else
    failures=$((failures + 1))
    echo "FAIL $demo $size $mode $depth t=$threshold" | tee -a "$log" >&2
  fi
}

start="$(date +%s)"

for demo in mandelbrot life cellauto gradients testsrc2; do
  for size in 120x35 244x72; do
    for depth in truecolor 256; do
      for threshold in 0 4 8 16 24; do
        run_one "$demo" "$size" halfblock "$depth" "$threshold"
      done
    done
  done
done

for mode in braille ascii; do
  run_one mandelbrot 120x35 "$mode" truecolor 0
done

end="$(date +%s)"
echo "$runs runs, $failures failed, $((end - start)) s" | tee -a "$log"

if [ "$failures" -ne 0 ]; then
  echo "see $log" >&2
  echo "RESULT: FAIL"
  exit 1
fi

node - "$jsonl" "$table" <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';
const [jsonl, table] = process.argv.slice(2);
const rows = readFileSync(jsonl, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const header = ['demo', 'size', 'depth', 'threshold', 'KB/frame', 'SGR/frame', 'SGR savings %', 'byte savings %', 'p95 ms'];
const lines = [
  `| ${header.join(' | ')} |`,
  `|${header.map(() => '---').join('|')}|`,
];
for (const r of rows) {
  const label = r.mode === 'halfblock' ? r.source : `${r.source} (${r.mode})`;
  lines.push(
    `| ${[
      label,
      `${r.cols}x${r.rows}`,
      r.depth,
      r.threshold,
      r.kbPerFrame.toFixed(1),
      r.sgrPerFrame.toFixed(0),
      r.sgrSavingsPct.toFixed(1),
      r.byteSavingsPct.toFixed(1),
      r.renderMsP95.toFixed(2),
    ].join(' | ')} |`,
  );
}
writeFileSync(table, `${lines.join('\n')}\n`);
NODE
status=$?
if [ "$status" -ne 0 ]; then
  echo "FAIL: could not write $table" >&2
  echo "RESULT: FAIL"
  exit 1
fi

echo "wrote $jsonl and $table"
echo "RESULT: PASS"
