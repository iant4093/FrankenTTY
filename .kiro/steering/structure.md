---
inclusion: always
---

# Structure

```text
src/
  main.ts                 CLI entry: parse args, check prerequisites, wire modules
  cli/args.ts             Flag parsing (node:util parseArgs) and validation
  ingest/probe.ts         ffprobe JSON wrapper
  ingest/decoder.ts       ffmpeg rgb24 pipe, generation IDs, restart on seek/resize
  ingest/assembler.ts     Byte chunks -> exact W*H*3 frames
  audio/player.ts         ffmpeg -> WAV -> ffplay stdin
  audio/clock.ts          Presentation clock (wall clock anchored at audio start)
  renderer/sequences.ts   All escape sequence constants and byte writers
  renderer/geometry.ts    Aspect-ratio fit, letterbox/pillarbox math
  renderer/downsample.ts  Braille-resolution pixels -> half-block / ASCII grids
  renderer/halfblock.ts   Half-block serializer
  renderer/braille.ts     2x4 Braille serializer
  renderer/ascii.ts       Luma-ramp ASCII serializer
  renderer/palette.ts     TrueColor, Amber, Green, DMG; 256 and 16 color mapping
  renderer/screen-model.ts What the terminal shows now (for deltas)
  renderer/governor.ts    Adaptive quality steps (REQ-PERF-01)
  term/capabilities.ts    Env + probe based capability detection
  term/screen.ts          Enter/restore lifecycle, signal and exit traps
  tui/input.ts            Raw key byte stream -> key events
  tui/hud.ts              Telemetry row
  bench/bench.ts          --bench headless measurement
tests/
  unit/  pbt/  integration/  pty/  helpers/
scripts/                  One entry point per job; CI calls the same scripts
docs/                     PLAN, GAP_ANALYSIS, EVIDENCE, HANDOFF, screenshots/
spikes/                   Throwaway experiments; never imported by src/
```

## Module boundaries

- `renderer/*` is pure: no I/O, no `process`, no timers. Input is pixel
  buffers and options; output is bytes in a caller-owned buffer.
- `term/*` and `tui/*` own `process.stdin` / `process.stdout`.
- `ingest/*` and `audio/*` own child processes.
- `main.ts` wires them; it contains no rendering or parsing logic.
- Tests import modules directly; nothing in `src/` imports from `tests/`.

Files not listed here may be added inside these folders when a brief asks.
New top-level folders need architect-opus approval.
