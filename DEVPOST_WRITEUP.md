# FrankenTTY — Devpost write-up

> Draft maintained by `architect-opus`. Every number here comes from
> [`docs/EVIDENCE.md`](docs/EVIDENCE.md), with the date and command that
> produced it. Counts marked *(as of …)* are refreshed before submission.

**Category:** Frankenstein
**Repo:** [github.com/iant4093/FrankenTTY](https://github.com/iant4093/FrankenTTY) · MIT

---

## 1. What it does

FrankenTTY plays video in a plain terminal using only text and ANSI escape
codes. It stitches together parts that were never meant to meet:

- **FFmpeg**, a modern video pipeline, decodes files, URLs or procedural
  demo sources into raw RGB24 frames over a pipe.
- **VT100/ECMA-48 escape codes** from the 1970s do the drawing. Each
  character cell shows two pixels with the upper half block `▀`: the
  foreground color is the top pixel, the background color the bottom pixel.
- **A compressing encoder** keeps a model of what the screen already shows,
  so it only writes cells that changed. It reuses colors, merges near-equal
  colors and draws flat cells as spaces.
- **An adaptive quality governor** watches how long the terminal takes to
  accept each frame. When the terminal falls behind, it trades color
  precision, then color depth, then resolution for frame rate.
- **ffplay** plays the audio, and video is paced to the audio clock.

Features: half-block, ASCII and 2×4 Braille modes; TrueColor, 1978 amber,
green phosphor and 4-shade handheld palettes; pause, ±5 s and ±30 s seek,
loop; a live HUD (fps, KB/s, color codes saved, quality level); capability
detection with 24-bit → 256 → 16-color fallback; `--bench` for headless
measurement. It runs on macOS, Linux and Windows from a single
executable, through `npx`, or from source.

## 2. How Kiro was used across surfaces

| Surface | Use |
|---|---|
| Kiro CLI 3.0 (`--v3`) | Every implementation task ran as `kiro-cli chat --v3 --agent builder-sonnet --no-interactive` with a written brief |
| Kiro Crew | The orchestrator session (`architect-opus`) planned, dispatched, reviewed, ran CI and kept the evidence log |
| Custom agents | `.kiro/agents/architect-opus.json`, `.kiro/agents/builder-sonnet.json` |
| Hooks | `.kiro/hooks/` — tests after each write, a gated end of turn, a commit guard, a docs-sync marker |
| Specs | `.kiro/specs/frankentty/` — EARS requirements, design, tasks |
| Steering | `.kiro/steering/` — product, tech, structure, agent roles |
| Powers + MCP | `powers/vt100-video/` and `tools/frankentty-mcp/` |

Work ran in waves (`docs/PLAN.md`). Independent tasks ran **in parallel**:
architect-opus forked one `git worktree` per task, launched one builder
session in each, and merged the results. Waves 2, 3 and 4 each ran 2–3
builders at once. To keep parallel branches from conflicting,
architect-opus committed shared types first (`src/ingest/media-info.ts`,
`src/renderer/cells.ts`, `src/renderer/luma.ts`), and every brief named the
files it could touch.

## 3. Custom agents: why two

| Agent | Model | Owns |
|---|---|---|
| `architect-opus` | Claude Opus 5.5 | Specs, steering, hooks, briefs, review, CI, docs, git |
| `builder-sonnet` | Claude Sonnet 5.5 | `src/`, `tests/`, `scripts/`, `tools/` |

The split kept each context small and each job checkable. The builder sees
one brief plus the steering and spec files, and nothing else. Its agent
config denies writes to `.kiro/`, `docs/`, `.github/` and `package.json`,
and denies `git commit/push/config` and `rm -rf`. The architect never writes
product code from scratch. It writes the contract (brief, requirement IDs,
property list with run counts, stop condition) and reviews the result
against it. A task is done when the review passes, not when the builder
says so (`.kiro/steering/agent-roles.md`). Every brief is kept in
[`docs/briefs/`](docs/briefs).

## 4. Agent hooks

| Hook | Trigger | What it does |
|---|---|---|
| `test-on-write` | PostToolUse on `fs_write` | Runs the tests related to a changed file in `src/` or `tests/` and shows failures to the agent |
| `gate-turn` | Stop | If `src/` or `tests/` changed, the turn cannot end until typecheck, lint and the full suite pass (max 3 blocks) |
| `compliance-guard` | PreToolUse on shell | Denies `git commit` unless `.kiro/` is tracked and not ignored, `LICENSE` is MIT, and no secret patterns exist. CI runs the same script |
| `sync-docs` | Stop | Marks README/Devpost as stale when `tasks.md` or the CLI surface changed |

Two findings came out of wiring hooks for real (EVIDENCE, Wave 0 and 1).
First, `.kiro/hooks` only fire in the CLI's V3 engine, so every dispatch uses
`--v3`. Second, Kiro rewrote the builder's agent file into the V3
permissions format with shell deny rules but no allow rule. Every shell call
then failed in non-interactive mode. The first builder run wrote all its
files but could not run a single test, until the allow rule was added.

## 5. Spec-driven development vs. vibe coding

The requirements are EARS statements with stable IDs
(`.kiro/specs/frankentty/requirements.md`). Every brief cites the IDs it
satisfies and lists the properties it must pass. Examples where the spec or
the measurements changed the code before a bug shipped:

- **Ctrl+C is a byte, not a signal.** In raw mode, Ctrl+C arrives as `0x03`
  on stdin. REQ-TERM-03 names it as an exit path, so the terminal is
  restored on it. A PTY test replays the output through a real emulator
  core (`@xterm/headless`) to prove the cursor and autowrap come back.
- **Frame framing.** REQ-INGEST-06 requires exactly one frame per
  `W×H×3` bytes, however the pipe splits the stream. My own design in
  brief 2.2 pushed whole pipe chunks into a 4-frame queue. One 64 KB chunk
  holds about 9 frames at 64×36, so that design would have dropped frames
  silently. The integration test that asks for exactly 60 frames caught it,
  and the builder made backpressure lossless.
- **Measured, not assumed.** The original pitch claimed "~28 MB/s" and
  "over 70% savings". Wave 0 measured Apple Terminal accepting only about
  2.2–2.5 MB/s, with color changes, not bytes, as the cost. That moved the
  design toward minimizing SGR sequences and added the quality governor
  (REQ-PERF-01).

## 6. Steering

- `tech.md` sets the hot-loop rules: no allocation per cell or per row;
  bytes go into a preallocated buffer through a decimal byte table; one
  `write()` per frame. Reviews checked each render module for allocations
  outside error paths. `encode()` takes about 1.0 ms on a worst-case
  244×72 frame (EVIDENCE, task 3.1).
- `tech.md` also carries the escape discipline: all sequences come from
  one module, the restore order is fixed, and color detection reads
  `COLORTERM` before anything else. Node reports 8-bit color for Apple
  Terminal even when it sets `COLORTERM=truecolor` (measured).
- `structure.md` keeps `renderer/*` pure (no I/O or timers), which is what
  made it testable with properties and replayable in an emulator.

## 7. MCP and Kiro Powers

`powers/vt100-video/` is a Power in the Agent Plugins format. It holds
three skills (`vt100-escapes`, `ffmpeg-pipe`, `terminal-bench`) and an MCP
server, `tools/frankentty-mcp/`. The server is zero-dependency stdio
JSON-RPC and has four tools:

| Tool | What it gives an agent |
|---|---|
| `frankentty_bench` | Bytes, SGRs, savings and render time for any source and setting |
| `frankentty_probe_media` | ffprobe metadata |
| `frankentty_render_snapshot` | Decodes one frame, runs the real pipeline, replays it in a terminal emulator core, returns the glyph grid and top colors |
| `frankentty_terminal_caps` | Capability detection for any environment |

This lets an agent "see" a frame without a TTY. It was verified end to end
through `kiro-cli chat --v3 --agent architect-opus` (EVIDENCE, task 3.6).
Kiro CLI 3.0's non-interactive mode did not start the Power's MCP server,
so the server is also registered on the architect agent.

## 8. Property-based testing

fast-check properties live in `tests/pbt/` *(as of 2026-11-05: 16 files,
47 properties, about 160,000 generated cases per run)*. They cover geometry
fit, the probe parser, the frame assembler, downsampling, the encoder
(framing, non-expansion, emulator round-trip, deltas), Braille and ASCII,
palettes and color mappers, the key router, the HUD, the clock, the
governor and the PCM audio pump.

What PBT caught:

1. **Spec bug in the geometry bound (P1f).** The aspect-error bound I wrote
   for capped geometry was too tight. The shrunk counterexample was a
   3291×3048 source in a 429×119 terminal, cell aspect 1.5193, cap 12,265 →
   140×87. The code was right; the bound was corrected and derived in the
   test.
2. **Spec bug in the DMG palette (P3).** I specified the 4-shade palette by
   luma quartiles. The idempotence property failed: the lightest shade has
   luma 168, which falls in quartile 2, so a second pass changed it.
3. **Clock regression (P9).** Pausing after the audio source ended made
   the position jump backwards. Fixed with a unit test added.
4. **Mutation checks.** The builder broke the encoder's skip count and its
   color comparison on purpose. P2c/P2d (emulator round-trip and delta
   sequences) caught both and shrank them to 1×2 grids.

## 9. Results *(as of 2026-11-05)*

Bench at 120×35, default settings (24-bit, threshold 8). The naive
baseline is two full color codes per cell.

| Demo | Color codes saved | Bytes saved |
|---|---|---|
| mandelbrot | 75% | 57% |
| life | 68% | 39% |
| cellauto | 52% | 16% |
| gradients | 84% | 77% |
| testsrc2 | 94% | 89% |

Source: `bash scripts/bench.sh`, `docs/evidence/wave3/sweep.jsonl`.
