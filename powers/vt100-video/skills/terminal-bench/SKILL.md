---
name: terminal-bench
description: Measure terminal video encoding cost and choose settings - run the FrankenTTY bench, read its fields, and record numbers before publishing them.
---

# Terminal bench

## Step 1: Run the bench

Through the MCP server, call `frankentty_bench` with a demo or input, a size,
and the settings to compare. From a shell:

```bash
node src/main.ts --bench --demo mandelbrot --frames 150 --size 120x35 --json
bash scripts/bench.sh   # full sweep -> build/bench/sweep.md
```

## Step 2: Read the fields

| Field | Meaning |
|---|---|
| `naiveKbPerFrame`, `kbPerFrame` | Bytes per frame, naive vs. compressed |
| `naiveSgrPerFrame`, `sgrPerFrame` | Color sequences per frame; the main cost in Apple Terminal |
| `sgrSavingsPct`, `byteSavingsPct` | Savings against the naive encoder |
| `cellsSkippedPct` | Cells unchanged since the last frame |
| `renderMsP95` | Build + palette + encode time; budget is 33 ms at 30 fps |

## Step 3: Pick settings

- Apple Terminal holds about 30 fps up to roughly 135 KB/frame of worst-case
  gradient content at 120×35. Above that, raise the threshold, then switch
  to 256-color, then render fewer cells.
- Report savings per content type. Flat test patterns save over 90%; smooth
  gradients at threshold 0 save far less.

## Step 4: Record

Every published number goes into `docs/EVIDENCE.md` with the command, date,
machine and the raw output file.
