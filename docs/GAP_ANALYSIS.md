# FrankenTTY: Gap Analysis and Pre-Implementation Plan

Status: draft for review. Written 2026-11-05 by the orchestrator after reading
`frankentty_project_specification.md` and `video_demo.md`. Nothing is built yet.
Once approved, the accepted items move into `.kiro/specs/frankentty/` and
`.kiro/specs/video-demo/` during Wave 1; this file then becomes history.

---

## 1. Project in one paragraph

FrankenTTY is a Node/TypeScript CLI video player. FFmpeg decodes a file, URL or
procedural demo into raw RGB24 frames. The renderer packs two pixels per cell
with `▀` (24-bit fg + bg), compresses with run-length color reuse and
inter-frame deltas, and flushes each frame inside DEC synchronized-output
markers. Audio plays in a child process and paces video. Hotkeys switch render
mode, CRT palette and a telemetry HUD. The repo doubles as a Kiroween 2026
"Frankenstein" entry, so the `.kiro/` workflow (agents, specs, steering, hooks,
MCP, PBT, Powers) and a sub-3-minute demo video are deliverables too.

---

## 2. Verified facts that change the plan

| Fact | Source | Effect |
|---|---|---|
| Submission window is Oct 30 to Dec 4, 2026; only projects started in that window count | [Kiroween 2026 Devpost](https://kiroween.devpost.com/) | About 4 weeks left. Repo must be created now, not reused. Full rules page returned 403; re-check rules in a browser before Wave 1. |
| Kiro model IDs use dots: `claude-opus-5.5`, `claude-sonnet-5.5` | `kiro-cli chat --list-models` on this Mac; [Kiro issue #10722](https://github.com/kirodotdev/Kiro/issues/10722) | Spec's `claude-opus-5-5` / `claude-sonnet-5-5` would fail to load. |
| Hooks are standalone `.kiro/hooks/*.json` files: `{"version":"v1","hooks":[{name,trigger,matcher,action}]}`; CLI triggers are AgentSpawn, UserPromptSubmit, PreToolUse, PostToolUse, Stop | [Kiro 1.0 hooks notes](https://kiro.dev/docs/ide/whats-new-v1/hooks/), mirrored CLI hook reference | There is no "pre-commit" or "on save" trigger in the CLI list. IDE file-event trigger names must be confirmed in spike S5. |
| macOS 26+ Terminal.app supports 24-bit color | [MacRumors](https://www.macrumors.com/2025/06/16/APPLES-TERMINAL-APP-MACOS-TAHOE/) | This Mac runs macOS 27.0.1, so Terminal.app is a valid target. Older macOS and some Linux terminals still need a 256-color fallback. |
| xterm.js added DEC 2026 in 6.0 | [xterm.js #5801](https://github.com/xtermjs/xterm.js/issues/5801) | VHS renders through xterm.js. Whether its bundled version has 2026 is unknown (spike S2). |
| `ffmpeg -f lavfi` can stream directly into the pipe (tested: `mandelbrot` 160x90 at 30 fps produced exactly 1,296,000 bytes for 1 s) | local run | `--demo` needs no generated file. The script is still useful for VHS determinism. |
| Local toolchain: Node 25.1, npm 11.6, ffmpeg/ffprobe/ffplay 9.0.2, uv 0.13.7, kiro-cli 3.0.0; VHS missing; no git repo; 88 GB free | local run | VHS must be installed. `git init` and a public GitHub repo are Wave 1 work. |

---

## 3. Gaps in the product spec

Severity: **H** = will cause a bug or a failed requirement if left; **M** =
causes rework or a weak demo; **L** = polish.

### 3.1 Rendering and compression

| # | Sev | Gap | Proposed fix |
|---|---|---|---|
| R1 | H | Each mode needs a different pixel grid (half-block `cols x 2*rows`, Braille `2*cols x 4*rows`, ASCII `cols x rows`), but REQ-TERM-02 only defines half-block. Switching mode would mean restarting FFmpeg. | Always decode at Braille resolution (`2c x 4r`) and box-downsample in JS (2x2 for half-block, 2x4 for ASCII). Mode switch then costs nothing. |
| R2 | H | Delta skipping against the *source* frame with a ΔE threshold lets error drift without bound (many sub-threshold changes never emitted). | Keep a **screen model** (what the terminal actually shows) and diff against it. Add a full refresh on resize, mode, palette or HUD change, and every N seconds. |
| R3 | H | Delta skips need cursor moves. The spec never defines them, and a skip can cost more bytes than it saves (`CSI n C` is 4+ bytes; a same-color `▀` is 3). | Emit `CSI row;1 H` at each row start and `CSI n C` for skips only when cheaper than reprinting. This keeps Property 2 (non-expansion) true by construction. |
| R4 | H | Printing in the last column sets pending-wrap; with the HUD on the bottom row this can scroll the screen. | Disable autowrap (`CSI ?7l`) on start, restore (`CSI ?7h`) on exit. |
| R5 | H | ΔE has no formula and no value. CIE Lab per pixel in the hot loop is too slow in JS. | Integer "redmean" weighted squared RGB distance, `--threshold` flag, default chosen from bench data. Threshold 0 means lossless. |
| R6 | M | Braille mode is one color per cell plus 8 on/off dots. Threshold rule and cell color are undefined. ASCII mode color is undefined (video says "TrueColor ASCII"). | Braille: dot on if luma > cell mean luma; fg = mean of lit dots; bg = mean of unlit dots (or black). ASCII: char from luma ramp, fg = cell mean color. |
| R7 | M | "Zero allocation" is a goal with no design. String concatenation per cell allocates. | Preallocated output `Buffer` sized for the worst case; byte lookup table for `0..255` decimal; write `subarray` once per frame. |
| R8 | M | "Single atomic stdout.write()" is not atomic on a PTY for large writes; the visual atomicity comes from DEC 2026. On macOS/Linux a TTY write in Node is synchronous, so a big frame blocks the event loop. | Keep the single write, document that sync mode provides the atomicity, and count write time inside the frame budget. |
| R9 | M | No truecolor detection. | `--color=auto|truecolor|256`. Auto uses `COLORTERM`, then known `TERM_PROGRAM`, else 256-color (`38;5;n`). |

### 3.2 Geometry

| # | Sev | Gap | Proposed fix |
|---|---|---|---|
| G1 | H | Cells are assumed to be exactly 1:2. Real fonts vary (often 1:2.1 to 1:2.4), so video looks squashed. | Query cell size with `CSI 16 t` (100 ms timeout), fall back to 2.0, allow `--cell-aspect`. |
| G2 | H | Property 1 only checks containment. A function returning 1x1 passes. | Add maximality (one axis fills the space), aspect error bound (within one cell), and centering (offsets differ by at most 1). |
| G3 | M | HUD toggle changes `rows - hudHeight`, which changes geometry and forces a decoder restart. | Always reserve the HUD row; `i` just shows or blanks it. |

### 3.3 Ingest, sync and controls

| # | Sev | Gap | Proposed fix |
|---|---|---|---|
| S1 | H | "Monotonic audio presentation clock" cannot be read from `ffplay`; it reports no position. | Clock = `performance.now()` anchored at audio start, plus `--av-offset` ms for device latency. Name it honestly in the spec. |
| S2 | H | Pause is undefined for audio. `ffplay -nodisp` ignores stdin keys. | Pause: stop reading the video pipe (FFmpeg blocks), kill audio, store position. Resume: respawn audio with `-ss pos`, re-anchor clock. |
| S3 | H | Resize mid-stream needs a new FFmpeg scale. Stale bytes from the old process can corrupt frame boundaries. | Restart decoder with `-ss` at current time; tag each decoder with a generation ID and drop bytes from old generations; debounce resize 150 ms. |
| S4 | H | Ctrl+C in raw mode arrives as byte `0x03`, not SIGINT. | Input router treats `0x03` as quit. Still trap SIGINT, SIGTERM, SIGHUP, `exit`, `uncaughtException`, `unhandledRejection`. |
| S5 | M | Source FPS is not normalized (60 fps or VFR sources). | FFmpeg `fps=` filter to target rate (`--fps`, default 30); frame time = index / fps. |
| S6 | M | `input.ts` lists Left/Right (seek) but no requirement covers it. | Decide: in (±5 s seek, restarts decoder and audio) or out. Recommendation: in, it reuses S3. |
| S7 | M | "Live streams" have no duration and cannot seek. Probing can hang. | Scope: files and http(s) URLs. Live input is best effort: no scrubber, no seek, probe timeout 5 s. |
| S8 | M | Orphans: if the parent is SIGKILLed, an `ffplay` reading the file directly keeps playing. | Feed audio to `ffplay` over a stdin pipe so parent death closes it, or accept and document. |
| S9 | M | No behavior for missing ffmpeg/ffprobe/ffplay, non-TTY stdout, or no audio track. | Friendly error before touching the terminal; `--no-audio`; wall clock when no audio. |
| S10 | L | Ctrl+Z (`0x1a`) undefined. | Ignore during playback. |

### 3.4 Testing

| # | Sev | Gap | Proposed fix |
|---|---|---|---|
| T1 | H | Nothing proves compression is *correct*. Non-expansion passes for wrong output. | Test-only mini VT parser (handles only CUP, CUF, SGR 0/38;2/48;2/38;5/48;5 and printable chars). Property: parse(serialize(frame)) equals frame (exact at threshold 0, within threshold otherwise). |
| T2 | H | Property 3 idempotence fails for a naive "tint by luminance" amber filter (output luma is lower than input luma). | Define phosphor palettes as nearest-match onto a fixed ramp. Projection onto a fixed set is idempotent by construction. |
| T3 | H | The frame assembler (where "binary stream framing bugs" live) has no property test. | Property: for any random chunking of k frames, the assembler emits exactly those k frames. This is the strongest PBT story for Devpost. |
| T4 | M | "Naive uncompressed ANSI output" is not defined, so Property 2 is not testable as written. | Define naive = full fg+bg SGR + `▀` for every cell, plus CUP per row, same framing. |
| T5 | M | Act IV claims "thousands of randomized" cases; fast-check defaults to 100 runs. | Set `numRuns` per property (10,000 for geometry and palette). |
| T6 | M | No end-to-end test of terminal teardown. | Spawn under a pseudo-terminal (Python `pty` helper, no native Node module), send `q` and Ctrl+C, assert restore sequences and no child processes left. |
| T7 | L | Runner unspecified; spec says "fast-check or proptest" (proptest is Rust). | Vitest + fast-check. |

### 3.5 Numbers that must come from measurement

The video script claims "~28 MB/s uncompressed" and "over 70% savings". Rough
math: a worst-case naive cell is 41 bytes (two 19-byte SGRs + 3-byte `▀`). A
1080p VHS capture at font 14 is about 228x63 cells, so naive is about 590 KB per
frame, or 17.7 MB/s at 30 fps. 28 MB/s needs about 22,800 cells. Savings on
`testsrc2` (flat color bars) will be far higher than on natural video.

Fix: add `frankentty --bench <input>` (REQ-BENCH-01). It serializes N frames
headless and prints naive bytes, compressed bytes, savings % and serialize ms.
Every number in README, Devpost and voiceover comes from its output, with the
source named.

---

## 4. Gaps in the Kiro workflow spec

| # | Sev | Gap | Proposed fix |
|---|---|---|---|
| K1 | H | Model IDs use hyphens. | `claude-opus-5.5`, `claude-sonnet-5.5`. |
| K2 | H | `compliance-guard` is "pre-commit", which is not a Kiro trigger. | PreToolUse hook on `execute_bash` that runs the check when the command contains `git commit` and exits 2 to deny. Optionally also a plain git hook in `.githooks/`. |
| K3 | M | `review-and-pbt` runs an Opus review on every save. The builder saves many files per task, so this costs a lot and reviews half-written code. | Split: a cheap command hook runs tests after writes in `src/**`; the Opus review runs once at task end (Stop hook or orchestrator step). |
| K4 | M | `sync-docs` fires on every `src/main.ts` change. | Trigger on `tasks.md` only, or manual. |
| K5 | H | Who actually runs the agents is unclear. The `.kiro/agents` files only count for judging if they are really used. | See decision D1. |
| K6 | M | "Powers" is claimed but no Power is named. | Pick a real Power in spike S6, or drop the claim. |
| K7 | M | Two different `mcp.json` contents (product spec says filesystem/git/media inspector; video spec lists 5 video servers). `tools/ffmpeg-mcp` and `tools/davinci-resolve-mcp` do not exist. The ElevenLabs URL is a markdown link inside a JSON string. | Merge into one file. Only list servers that exist. Keys come from env vars, never committed. |
| K8 | M | No evidence trail. Devpost asks for concrete examples (PBT catches, review finds, hook runs). | `docs/EVIDENCE.md`: one line per real event with date, commit SHA, shrunk counterexample or review note. |
| K9 | L | `structure.md` has no `docs/`, no CI, no `package.json`/`tsconfig`. | Add them. GitHub Actions running the test suite is cheap proof for judges. |

---

## 5. Gaps in the video spec

| # | Sev | Gap | Proposed fix |
|---|---|---|---|
| V1 | H | VHS records no audio, so Act III's "synchronized procedural synth audio" will not be in the capture. VHS timing is not guaranteed real-time, so muxing audio later may drift. | Voiceover only over Act III, or record a real terminal (Ghostty/iTerm2) with screen capture. Decide after spike S2. |
| V2 | H | VHS runs xterm.js in headless Chrome. 30 fps truecolor at about 14k cells may stutter; Braille glyphs may render as boxes. | Spike S2 before committing to VHS. Fallbacks: lower `--fps`, smaller font grid, or real screen capture. |
| V3 | H | Fixed act frame counts (8,100 total) conflict with REQ-VID-04 (durations from VO length). | Act length = max(VO frames + tail pad, minimum visual time). Check total stays within 120 to 175 s. |
| V4 | M | Spec scope is large for about one week of video time: ElevenLabs + Manim + Remotion + VHS + DaVinci + two custom MCP servers. | MVP: VHS capture + Remotion titles/overlays + VO. Manim and DaVinci are stretch goals. |
| V5 | M | ElevenLabs needs a paid API key; plan terms for generated SFX/music must allow this use. | Confirm key and plan (D5). BGM can be procedural (`aevalsrc`), which fits the theme. |
| V6 | L | File name mismatch: spec says `video-demo.md`, repo has `video_demo.md`. | Rename to `video-demo.md`. |
| V7 | L | REQ-VID-03 says "unedited" but overlays keypress badges. | Define "unedited" as no frame edits to terminal pixels; overlays sit outside or on top of the bezel. |
| V8 | L | `testsrc2` is visually dull for the hook shot. | Demo playlist from lavfi: `mandelbrot`, `life`, `cellauto`, `gradients`, `testsrc2` (all available in local FFmpeg 9.0.2). |

---

## 6. New and changed requirements (to merge into requirements.md)

- **REQ-TERM-01 (changed):** also disable autowrap (`CSI ?7l`). Refuse to start if stdout is not a TTY, except in `--bench`.
- **REQ-TERM-03 (changed):** restore sequence is `CSI ?2026l`, `CSI 0m`, `CSI ?7h`, `CSI ?25h`, `CSI ?1049l`, then `setRawMode(false)`. Runs on `q`, byte `0x03`, SIGINT, SIGTERM, SIGHUP, `uncaughtException`, `unhandledRejection`, and `exit`. Idempotent.
- **REQ-CAP-01:** color capability detection with `--color=auto|truecolor|256`.
- **REQ-GEO-01:** cell aspect from `CSI 16 t`, fallback 2.0, `--cell-aspect`.
- **REQ-GEO-02:** HUD row is always reserved.
- **REQ-INGEST-03:** `--demo` streams lavfi sources directly; no file required.
- **REQ-INGEST-04:** output normalized to `--fps` (default 30).
- **REQ-INGEST-05:** decoder restarts carry a generation ID; stale bytes are dropped; resize is debounced 150 ms.
- **REQ-RENDER-05:** delta compression diffs against the screen model; full refresh on state change and every N s.
- **REQ-RENDER-06:** Braille and ASCII mode rules as in R6.
- **REQ-RENDER-07:** serializer writes into a preallocated buffer; no per-cell allocation.
- **REQ-SYNC-02:** wall clock when no audio or `--no-audio`.
- **REQ-SYNC-03:** pause, resume and seek semantics as in S2/S3/S6.
- **REQ-SYNC-04:** `--av-offset <ms>`.
- **REQ-BENCH-01:** `--bench` headless measurement; sole source of published numbers.
- **REQ-PREREQ-01:** missing FFmpeg tools give a clear message and exit 1 without touching the terminal.

CLI surface to lock in Wave 1:
`frankentty <input | --demo [name]> [--mode halfblock|ascii|braille] [--palette truecolor|amber|green|dmg] [--fps N] [--color auto|truecolor|256] [--threshold N] [--cell-aspect N] [--av-offset MS] [--no-audio] [--loop] [--bench]`

---

## 7. Property list (replaces design.md section 5)

| ID | File | Property | Runs |
|---|---|---|---|
| P1 | `geometry.pbt.test.ts` | Containment, maximality, aspect error within one cell, centering | 10,000 |
| P2a | `serializer.pbt.test.ts` | Framing: starts `CSI ?2026h`, ends `CSI 0m CSI ?2026l`, valid UTF-8 | 1,000 |
| P2b | same | Compressed bytes <= naive bytes (naive defined in T4) | 1,000 |
| P2c | same | Round-trip through test VT parser equals input (exact at threshold 0, within threshold otherwise) | 1,000 |
| P2d | same | For a random frame sequence with deltas, parser state after the last frame equals the screen model | 500 |
| P3 | `palette.pbt.test.ts` | Closure in [0,255]; idempotence for every palette; phosphor ramps monotonic in luma | 10,000 |
| P4 | `assembler.pbt.test.ts` | Any chunking of k frames yields exactly those k frames; stale-generation bytes are dropped | 1,000 |
| P5 | `input.pbt.test.ts` | Any split of a key byte stream yields the same key events | 1,000 |
| P6 | `downsample.pbt.test.ts` | Box downsample output stays within min/max of its source block | 1,000 |

---

## 8. Revised plan

Dates assume today (Thu Nov 5) and a Dec 4 deadline. Thanksgiving is Thu Nov 26.
Feature freeze Nov 26. Submit Dec 3, one day early.

| Wave | Dates | Goal | Exit check |
|---|---|---|---|
| 0 Feasibility gate | Nov 6-7 | Spikes S1-S6 below | Written results in `docs/EVIDENCE.md`; go/no-go per risk |
| 1 Governance + scaffold | Nov 8-10 | git + public repo, LICENSE, `.gitignore`, `.kiro/` (fixed IDs and hook schema), specs from this doc, `package.json`/`tsconfig`/Vitest, CI, CLI parser, ScreenManager, geometry + P1 | `q` and Ctrl+C restore terminal; P1 green in CI |
| 2 Ingest + vertical slice | Nov 11-13 | probe, decoder, frame assembler + P4, naive half-block render of `--demo` | Real use: demo plays in your terminal, no audio, clean exit |
| 3 Compression + modes | Nov 14-18 | screen model, RLE, delta, threshold, Braille/ASCII, palettes, test VT parser, P2a-d, P3, P6, `--bench` | Bench numbers recorded; P2c green |
| 4 Sync + TUI | Nov 19-23 | audio child, clock, pause/seek, HUD, input + P5, resize restart, color fallback | 10-min playback with resize, pause and seek; no drift > 1 frame by eye |
| 5 Hardening + docs | Nov 24-26 | PTY teardown test, terminal matrix, README, DEVPOST_WRITEUP draft | Freeze |
| 6 Video | Nov 27-Dec 1 | MVP video path (V4); stretch items only if time remains | 120-175 s, 1080p60, -14 LUFS |
| Buffer | Dec 2-3 | Fixes, final write-up, upload, submit | Submitted |

Voiceover scripting can start in Wave 3, since it only depends on bench numbers.

### Wave 0 spikes

| ID | Question | Pass condition |
|---|---|---|
| S1 | How many fps does a naive vs. RLE half-block stream reach in your terminals at full screen? | Throwaway script reports fps per terminal; at least one target sustains 30 fps |
| S2 | Does VHS capture a 30 fps truecolor stream smoothly, with Braille glyphs and DEC 2026? | Captured clip has no tearing and no tofu; else choose real screen capture |
| S3 | `ffplay` start latency and restart-at-offset gap | Measured ms; sets the `--av-offset` default |
| S4 | Which target terminals answer `CSI 16 t`? | Table per terminal |
| S5 | Exact hook trigger names in Kiro IDE 1.x and CLI 3.0; can `.kiro/agents/builder-sonnet` be driven from the orchestrator (`kiro-cli chat --agent builder-sonnet` non-interactive, or Crew spawn)? | One sample hook fires on each surface; one builder task runs end to end |
| S6 | Which installed or available Power fits (`kiro-cli powers`)? | One Power named and used, or the claim is dropped |

---

## 9. Decisions needed from you

Resolved 2026-11-05. See `docs/PLAN.md` section 1 for the answers. The table
below is kept as the original question list.

| ID | Question | Recommendation |
|---|---|---|
| D1 | Where do the two agents run? | This Opus session orchestrates and reviews; builder tasks run through `kiro-cli --agent builder-sonnet` so the `.kiro/agents` configs and hooks are really exercised. |
| D2 | Which terminals are "supported"? | Ghostty or iTerm2 as primary, Terminal.app (macOS 26+) and one Linux terminal as secondary. |
| D3 | Live streams in scope? | Files and http(s) URLs; live is best effort. |
| D4 | Seek (Left/Right) in or out? | In. |
| D5 | ElevenLabs key and plan available? Manim and DaVinci in scope? | MVP video path; Manim and DaVinci are stretch. |
| D6 | GitHub owner and repo name, public from day one? | Public `FrankenTTY` under your account, created in Wave 1. |
| D7 | Keep Node/TypeScript? | Yes. JS serialization fits easily in the 33 ms budget; the terminal is the bottleneck, not the encoder. |
