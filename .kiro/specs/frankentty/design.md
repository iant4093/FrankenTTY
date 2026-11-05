# Design: FrankenTTY

## 1. Pipeline

```text
ffprobe ─► Probe ─────────────────────────────┐
                                               ▼
ffmpeg (video, rgb24, Braille res) ─► Assembler ─► Downsample ─► Palette ─► Serializer ─► stdout
   ▲  gen ID                                       (mode grid)   (color map)  (screen model, RLE,
   │                                                                          delta, governor)
   └── restart on seek/resize ◄── Controller ◄── Input router ◄── stdin (raw)
                                     │
ffmpeg -ss (audio WAV) ─► ffplay stdin ─► Clock (anchored at audio start + av-offset)
```

The controller owns state (`playing | paused`, position, mode, palette,
HUD on/off, quality step) and a fixed-rate frame loop. Each tick it asks the
clock which frame index is due, drops frames that are late by more than one
interval, and renders the newest one.

## 2. Key data structures

| Structure | Size | Lifetime |
|---|---|---|
| Decode frame | `(2c) × (4r) × 3` bytes | Ring of 3, per geometry |
| Mode grid (fg, bg, glyph per cell) | `Uint32Array` × 2 + `Uint16Array`, `c × r` | Per geometry |
| Screen model | Same as mode grid | Per geometry; invalidated on full redraw |
| Output buffer | Worst case per cell × cells + row moves + framing | Per geometry |

Worst-case bytes per cell in 24-bit half-block: `CSI 38;2;255;255;255m` (19) +
`CSI 48;2;255;255;255m` (19) + `▀` (3) = 41. Row move `CSI rrr;cccH` ≤ 10.
Buffer = `41 × c × r + 10 × r + 64`.

## 3. Geometry (`renderer/geometry.ts`)

Input: source `W×H`, terminal `cols×rows`, HUD rows (1), cell aspect `a`
(height/width, default 2.0), mode. Render area is `cols × (rows - 1)` cells.

One cell is `1 × a` in width units. In half-block mode a cell holds `1 × 2`
pixels, so pixel aspect correction is `a / 2`. Fit: choose the largest
`renderCols ≤ cols`, `renderRows ≤ rows - 1` such that
`renderCols / (renderRows × a)` is as close as possible to `W / H`, then
center with `offsetX = floor((cols - renderCols) / 2)`,
`offsetY = floor((rows - 1 - renderRows) / 2)`.

Output: `{ renderCols, renderRows, offsetX, offsetY, pixelWidth, pixelHeight }`
where `pixelHeight = renderRows × 2` (half-block) and decode size is
`2 × renderCols` by `4 × renderRows` (Braille base resolution).

## 4. Serializer

- Row start: `CSI row;col H` (1-based, includes offsets).
- Per cell: compare packed fg/bg against the last emitted fg/bg on this row
  (`-1` after a cursor move). Emit only changed SGRs.
- Solid cell (fg ≈ bg): emit `' '` and only a background SGR.
- Delta: if a cell equals the screen model, extend a skip run. When the run
  ends, emit `CSI n C` if `len(CSI n C) < bytes to reprint the run`, else
  reprint. After a skip, the last-emitted colors are unknown only if the
  terminal could have changed them; it cannot, so they stay valid.
- Threshold: redmean-weighted squared distance on packed RGB, integer math,
  compared against `threshold²` (precomputed).
- Counters per frame: bytes, SGRs emitted, SGRs a naive encoder would emit,
  cells skipped. The HUD and `--bench` read these.

## 5. Quality governor (REQ-PERF-01)

Budget = `1000 / fps` ms. Every frame records `serialize + write` ms. Over a
sliding 1 s window, if p90 > 0.9 × budget, step down; if p90 < 0.5 × budget
for 3 s, step up. Steps: `0` none, `1` threshold +8, `2` threshold +16, `3`
256-color, `4..` cells × 0.8 per step (geometry recomputed, keeps aspect).
Apple Terminal data (EVIDENCE, Wave 0): step 3 is needed at 17.6k cells for
worst-case content.

## 6. Capability probe (REQ-CAP-02)

Write `CSI ?2026$p CSI 16 t CSI 14 t CSI c` once, before entering raw-mode
playback. Parse replies from stdin until the DA1 reply (`CSI ? … c`) or
200 ms. Replies: `CSI ?2026;Ps$y` (Ps 1/2 = supported), `CSI 6;h;w t` (cell
px), `CSI 4;h;w t` (window px). Apple Terminal 488 answers only `14 t` and DA1
(measured).

## 7. Testing

Terminal behavior tests run the real module in a PTY and feed the bytes to
`@xterm/headless`, then read its buffer. Pure modules get unit tests and
properties.

| ID | File | Property | numRuns |
|---|---|---|---|
| P1 | `geometry.pbt.test.ts` | Containment (`renderCols ≤ cols`, `renderRows ≤ rows-1`, offsets ≥ 0, fits inside with offsets); maximality (one axis is full, or growing either axis by 1 would exceed it); aspect error ≤ one cell on the constrained axis; centering (left/right margins differ by ≤ 1, same for top/bottom); `pixelHeight = 2 × renderRows`; never zero-sized for `cols ≥ 20`, `rows ≥ 10` | 10,000 |
| P2a | `serializer.pbt.test.ts` | Framing: starts `CSI ?2026h`, ends `CSI 0m CSI ?2026l`, valid UTF-8 | 1,000 |
| P2b | same | Compressed bytes ≤ naive bytes; compressed SGRs ≤ naive SGRs | 1,000 |
| P2c | same | `@xterm/headless` render of output equals input cells (exact at threshold 0, within threshold otherwise) | 300 |
| P2d | same | After a random frame sequence with deltas, emulator state equals screen model | 200 |
| P3 | `palette.pbt.test.ts` | Closure in [0,255]; idempotence for every palette; phosphor ramps monotonic in luma | 10,000 |
| P4 | `assembler.pbt.test.ts` | Any chunking of k frames yields exactly those k frames; stale generations dropped | 1,000 |
| P5 | `input.pbt.test.ts` | Any split of a key byte stream yields the same key events | 1,000 |
| P6 | `downsample.pbt.test.ts` | Each output channel lies within min/max of its source block | 1,000 |
| P7 | `capabilities.pbt.test.ts` | Probe parser: any interleaving and split of reply bytes yields the same result; unknown bytes never throw | 1,000 |
