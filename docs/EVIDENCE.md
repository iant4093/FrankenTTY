# FrankenTTY: Evidence Log

One entry per real measurement, test catch, review find or hook run. Each
entry names its date, command and source. README, Devpost and voiceover
numbers may only come from here.

---

## Wave 0: feasibility spikes (2026-11-05)

Spike code: `spikes/wave0/wave0.cjs` (throwaway). Binaries: `spikes/wave0/dist/`
(not to be committed; 96–150 MB each).

Machine: MacBook, macOS 27.0.1, arm64, Node 26.13.0 (Homebrew), FFmpeg 9.0.2,
kiro-cli 3.0.0.

### S7: Single executable builds (PASS on macOS; Windows/Linux runs pending)

- `node --build-sea` from the **official** Node 26.13.0 darwin-arm64 binary built
  all five targets on one Mac, by pointing `"executable"` at each platform's
  official Node binary (checksums verified against `SHASUMS256.txt`):
  macOS arm64/x64, Linux arm64/x64, Windows x64. `useCodeCache` and
  `useSnapshot` must be `false` for cross-builds.
- **Homebrew's Node cannot build SEAs**: `node --build-sea` exits 9 with
  "Single executable application is disabled." Build scripts and CI must use
  official Node binaries (`actions/setup-node` uses them).
- Sizes: 145.7 MB (macOS arm64), 149.4 MB (macOS x64), 150.7 MB (Linux),
  100.3 MB (Windows). Compressed: 43.9 MB gzip (macOS arm64), 38.8 MB zip
  (Windows).
- macOS binaries were ad-hoc signed with `codesign --sign - --force`.
- The macOS arm64 binary ran in a PTY, entered raw mode, wrote alt-screen
  output, restored and exited 0 (`sea: true` in the result).
- **Plan change:** CI can build every target on one runner. Per-OS jobs stay,
  but only to smoke-test and install-test the binaries.

### S1: Serializer and PTY throughput, headless (PASS); real terminals pending

Command: `script -q /dev/null zsh -c 'stty cols 228 rows 63; ./wave0-macos-arm64 fps --seconds 3'`.
A PTY with no terminal emulator reading it is an upper bound, not a terminal
result. Source: JS plasma, 228×124 px (half-block, 228×62 cells).

| Mode | fps | KB/frame | MB/s | Serialize ms | Write ms |
|---|---|---|---|---|---|
| naive | 213.3 | 521.2 | 108.5 | 2.41 | 2.24 |
| exact RLE | 228.5 | 428.0 | 95.5 | 2.40 | 1.95 |

Findings:

- Serializing a full frame takes about 2.4 ms in plain JS with string joins,
  under 8% of the 33 ms budget at 30 fps. JS speed is not the risk.
- Exact-match RLE saved only **18%** on smooth gradients. The video script's
  "over 70%" will not hold for gradient content without a ΔE threshold.
  Threshold tuning in Wave 3 must report savings per content type.
- At 30 fps, naive output is 521 KB × 30 = **15.3 MB/s** at this size, close
  to the gap analysis estimate (17.7 MB/s) and well under the script's 28 MB/s.

### S3: Audio process timing (PASS, with one plan change)

| Measurement | Result (3 runs) |
|---|---|
| `ffplay -nodisp -autoexit` on 1 s lavfi sine | 1.39–1.41 s wall (≈0.4 s overhead) |
| `ffplay -vn -ss 10 -t 1 file.mp4` | 3.12 s wall (≈2.1 s overhead) |
| `ffmpeg -ss 10 -i file -t 1 -vn -f wav - \| ffplay -i -` | 1.34–1.35 s wall (≈0.35 s overhead) |
| `ffprobe` on a 20 s 720p MP4 | 0.05 s |
| First rgb24 frame at 456×252 after `-ss 10` | 44–45 ms |

- **Plan change:** audio is decoded by `ffmpeg` (with `-ss`) and piped as WAV
  into `ffplay -i -`. Seeking with `ffplay -ss` directly costs about 2 s more.
  The pipe also means `ffplay` exits when the parent dies (gap S8).
- A seek restart costs about 45 ms for video and a few hundred ms for audio.
  The `--av-offset` default is set by eye in Wave 4.

### S5: Kiro agents and hooks from the CLI (PASS with `--v3`)

Scratch project with `.kiro/agents/probe-builder.json`
(`"model": "claude-sonnet-5.5"`, a `file://STEER.md` resource) and
`.kiro/hooks/s5.json` (v1 schema).

| Check | Default engine | `--v3` |
|---|---|---|
| `kiro-cli agent validate` / `agent list` finds workspace agent | yes | yes |
| Agent reads its resource file (wrote `PUMPKIN`) | yes | yes |
| `PostToolUse` hook on `fs_write` | **did not fire** | fired; received `tool_name`, `tool_input.path` on stdin |
| `PreToolUse` gate on shell, exit 2 | did not fire | **denied `git commit`**; agent saw the stderr reason and stopped |
| `Stop` hook | did not fire | fired |
| `AgentSpawn` hook | did not fire | did not fire in `--no-interactive` |
| `--trust-tools=execute_bash` approves shell | no | `shell` name accepted |

- **Plan change:** builder runs use
  `kiro-cli chat --v3 --agent builder-sonnet --no-interactive --trust-tools=fs_read,fs_write,shell "<brief>"`.
- **Plan change:** Kiro IDE is not installed, so "on save" hooks become
  `PostToolUse` on `fs_write` with a `src/**` path check inside the hook
  script. `compliance-guard` is a `PreToolUse` gate on shell commands that
  contain `git commit`, which is proven to work.

### S6: Powers (decided, verify in Wave 1)

`kiro-cli powers install <name|path>` accepts a local directory. Plan: write a
project Power, `powers/vt100-video/`, that packages the escape-sequence
reference, FFmpeg pipe flags and the zero-allocation rules, then install it
from the path. The curated catalog has no terminal or FFmpeg Power.

### S2: VHS capture (deferred)

Deferred to Wave 6 with the other video tools, per Ian on 2026-11-05.

### S4: Capability probe (built; real-terminal runs pending)

The same binary probes DEC 2026 (DECRQM), cell size (`CSI 16 t`), window
size (`CSI 14 t`) and DA1. It shows a glyph sample (24-bit, 256, 16 color
half-blocks, Braille, ASCII ramp), records arrow and Shift+arrow bytes and
resize events, then runs S1 in the real terminal.

The agent cannot drive terminal apps (KiroCrew refuses computer use on
terminals; the agent's macOS sandbox blocks `osascript` and opening documents
in Terminal). Ian runs these by typing the command.

#### Apple Terminal 488, macOS 27.0, 175×50, run by Ian 2026-11-05 12:22 PST

Source: `docs/evidence/wave0/wave0-apple-terminal.json`.

| Item | Result | Effect |
|---|---|---|
| Env | `TERM=xterm-256color`, `TERM_PROGRAM=Apple_Terminal`, `COLORTERM=truecolor`, `LANG=en_US.UTF-8` | Apple Terminal now sets `COLORTERM` |
| Node `getColorDepth()` | **8** (256 colors) despite `COLORTERM=truecolor` | Node checks `TERM_PROGRAM` first. Our own detection must read `COLORTERM` first. |
| DEC 2026 (DECRQM) | **no reply** | Apple Terminal has no synchronized output. Tearing must be judged by eye. |
| `CSI 16 t` cell size | no reply | Fallback needed |
| `CSI 14 t` window px | 717×1245 | Cell aspect derived as **2.016** |
| DA1 reply | 0.8 ms | Probe ends fast |
| Keys | Left `CSI D`, Right `CSI C`, Shift+Left `CSI 1;2D`, Shift+Right `CSI 1;2C`, Space, `q` | All decode; Shift+arrow seek works |
| Resize | Size changed 175×50 → 204×58 during the fps phase | Resize event path works |
| Exit | normal, terminal restored | Teardown works |

Throughput (worst-case plasma, the terminal is the limit):

| Mode | Size | fps | KB/frame | MB/s | Write ms avg / max |
|---|---|---|---|---|---|
| naive 24-bit | 175×49 | **8.0** | 316 | 2.47 | 123 / 715 |
| exact RLE 24-bit | 204×57 | **6.3** | 357 | 2.21 | 155 / 251 |

Findings:

- **Apple Terminal accepts about 2.2–2.5 MB/s**, about 40× less than a bare
  PTY (95–108 MB/s). At 30 fps that is a budget of about **80 KB per frame**.
- Full-window 24-bit gradients need 260–360 KB per frame, so they reach 6–8 fps.
- **New requirement (REQ-PERF-01, adaptive quality):** measure write time per
  frame and step down to stay at the target fps: color threshold up, then
  256-color, then fewer cells. The HUD shows the current step.
- Follow-up sweep (size × encoding × content) built:
  `zsh run-mac.command sweep`. Headless upper bound at 175×49: plasma RLE
  24-bit 258 KB/f, 4-bit-quantized 147 KB/f, 256-color 45 KB/f; color bars
  19–25 KB/f.

#### Apple Terminal sweep, 244×73 window, run by Ian 2026-11-05 12:25 PST

Source: `docs/evidence/wave0/wave0-apple-terminal-sweep.json`. 1.5 s per cell
of the table; `rle24q` masks each channel to 4 bits (a stand-in for a ΔE
threshold). Bold = reaches 30 fps.

| Size (cells) | Content | 24-bit RLE | 24-bit quantized | 256-color |
|---|---|---|---|---|
| 80×23 (1.8k) | plasma | **169** fps, 56 KB/f | **344**, 31 KB | **1274**, 10 KB |
| 80×23 | bars | **3179**, 7 KB | **3184**, 7 KB | **3727**, 5 KB |
| 120×35 (4.2k) | plasma | **31.8**, 135 KB | **72.5**, 76 KB | **392**, 23 KB |
| 120×35 | bars | **1482**, 13 KB | **1482**, 13 KB | **1804**, 10 KB |
| 244×72 (17.6k) | plasma | 4.1, 531 KB | 7.8, 296 KB | **31.2**, 93 KB |
| 244×72 | bars | **227**, 48 KB | **228**, 48 KB | **272**, 36 KB |

Findings:

- **Apple Terminal's cost is color changes, not bytes.** MB/s ranges from 2.1
  (plasma, an SGR on nearly every cell) to 21 (bars, few SGRs). The budget is
  "SGR sequences per second", not "MB per second". The serializer's job is to
  emit fewer SGRs; byte savings follow.
- Worst-case content at 30 fps in 24-bit holds up to about **4,200 cells**
  (120×35). A large window (17.6k cells) needs 256-color to hold 30 fps on
  worst-case content; flat content is fine in 24-bit at any size.
- Quantizing to 4 bits per channel doubles fps on gradients and costs nothing
  on flat content. A ΔE threshold is the first governor step.
- The fps numbers above are write-acknowledged rates. Frames above the
  display's refresh are dropped by Terminal, which is harmless.
- **REQ-PERF-01 (adaptive quality), confirmed:** the governor measures write
  time per frame over a 1 s window. When it misses the frame budget, it steps
  down: threshold up (two levels) → 256-color → cap render cells (keep
  aspect, letterbox). It steps back up after 3 s of headroom. `--quality
  max` disables it. HUD shows the step and SGRs per frame.
- The headline "savings %" metric for README/Devpost should report **SGRs
  saved**, with bytes as the second number.

| Run | Status |
|---|---|
| Apple Terminal, probe + keys + fps | done (above) |
| Apple Terminal, sweep | done (above) |
| Windows Terminal | pending |
| Windows conhost (optional, Tier 3) | pending |

---

## Wave 1: governance and scaffold (2026-11-05)

### Kiro CLI agent permissions (finding)

- Kiro CLI 3.0 rewrote `.kiro/agents/builder-sonnet.json` into the V3 format
  on first load (`permissions.rules`, `kiroUpgrade`). The upgraded file had
  shell **deny** rules but no shell **allow** rule, so every shell call in
  `--no-interactive` mode failed with "tool permission approval is not
  supported in non-interactive mode". The first 1.2 run wrote all files but
  could not run a single test.
- Fix: add `{"capability": "shell", "effect": "allow"}` after the deny rule.
- Deny `match` entries are globs on the whole command. `git config` (no
  wildcard) did not block `git config --get user.name`; `*git config*` did.
  Verified with a probe run on 2026-11-05.

### Task 1.2 review (architect-opus)

Builder run: `build/runs/1.2.log`. Review rerun: `bash scripts/test.sh` →
typecheck PASS, lint PASS, 115 tests PASS in 4.5 s.

| Check | Result |
|---|---|
| PTY teardown (`q` → 0, `0x03` → 130, SIGTERM → 143) | PASS. Output ends with `RESTORE_SEQUENCE`; `@xterm/headless` replay shows normal buffer, cursor visible (DECRQM 25 = 1), autowrap on (7 = 1) |
| Alt screen while running | PASS: alternate buffer, cursor hidden, autowrap off |
| P7 probe parser (2 properties × 1,000 runs) | PASS |
| Raw `\x1b` outside `sequences.ts` | none |
| Non-TTY, bad flag, `--help`, `--version` | exit 1, 2, 0, 0 |
| `npm run bundle` | **FAIL (F1)**: top-level `await` in `src/main.ts` is not allowed in CJS output |
| Version source | **F2**: reads `package.json` via `import.meta.url`, which the CJS bundle and SEA binary cannot do |

`@xterm/headless` 6.0.0 answers DECRQM for modes 7, 25 and 2026, so tests
can read real terminal modes after a replay.

Follow-up brief: `docs/briefs/1.2b.md`.

### Task 1.2b review (architect-opus): PASS

F1 fixed (`run().then(...)`, no top-level await). F2 fixed (`src/build-info.ts`
uses esbuild `define` `__FRANKENTTY_VERSION__`, falls back to `package.json`
from source). `npm run bundle` → `dist/frankentty.cjs`, 19.9 KB;
`node dist/frankentty.cjs --version` → `0.1.0`. New integration test
`tests/integration/bundle.test.ts` (5 tests).

Low finding, deferred to Wave 4 (task 4.4): if `run()` rejects after the
screen is active, the `exit` trap restores the terminal, but a resumed raw
stdin can keep the process alive. The real player must call `process.exit`
on fatal paths.

### Task 1.3 review (architect-opus): PASS

`src/renderer/geometry.ts` matches design.md section 3. Review rerun:
10 files, 152 tests PASS.

| Case | Result |
|---|---|
| 1920×1080 in 80×24, a = 2.0 | 80×23, offsets 0,0 |
| 4:3 in 175×50, a = 2.016 (Ian's Apple Terminal) | 132×49, offsetX 21 |
| 1×7680 / 7680×1 in 80×24 | 1×23 / 80×1 |
| maxCells 4,200 on 244×73 | 121×34 = 4,114 cells |

Properties P1a–P1e at 10,000 runs, P1f at 5,000: PASS.

**PBT catch #1 (spec bug, 2026-11-05):** P1f, the aspect bound after a cell
cap, was written in brief 1.3 as `1/min(c,r) + 0.5/r`. builder-sonnet's
property exploration (200,000 runs) shrank a counterexample:
source 3291×3048 in a 429×119 terminal, cell aspect 1.5192705635184096,
maxCells 12,265 → 140×87, with relative aspect error ≈ `1.16/min + 0.5/r`.
Cause: the cap loop removes whole cells from the larger side, and one or two
removals can follow the rounding step. The bound was corrected to
`2/min + 0.5/r` with the derivation in the test. The code was right; the
spec was wrong.

Extra guard found by the builder: the cap step now clamps `r'` to
`availRows`, so a tall source cannot overflow the terminal after `c` shrinks.

### CI: first run on `main` (2026-11-05)

Run [42108531329](https://github.com/iant4093/FrankenTTY/actions/runs/42108531329)
on `94ca93e`: compliance + workflow checks, CodeQL, and tests on
ubuntu-latest, macos-latest and windows-latest all **success** on the first
push. Wave 1 exit check met.

---

## Wave 2: ingest and first playback (2026-11-05)

Tasks 2.1 and 2.2 ran **in parallel** as two builder-sonnet sessions, each in
its own `git worktree` (`wave2/2.1`, `wave2/2.2`). Hooks ran per worktree,
so each Stop gate tested only its own tree. architect-opus created the shared
type `src/ingest/media-info.ts` before forking so the branches could not
conflict. Both merged cleanly; combined suite on `main`: 16 files, 248 tests
PASS.

### Task 2.1 review: PASS

Five 640×360, 30 fps, 60 s lavfi demos with distinct `aevalsrc` audio
(peaks −14.0 to −14.9 dBFS). `testsrc2` beeps left 1 kHz / right 440 Hz on
every second, for A/V sync checks in Wave 4. `scripts/generate-demo-media.sh`
reads the filters from `src/ingest/demo.ts` (one source of truth). Accepted
deviations: `trim=duration=60` where a filter has no `duration` option; life
and cellauto render small and scale with `neighbor`.

### Task 2.2 review: PASS, with one brief bug found by an integration test

- P4a/P4b at 1,000 runs, P4c at 500: PASS. The builder confirmed P4b fails
  when the generation check is removed (mutation check).
- **Brief bug #2 (2026-11-05):** brief 2.2 told the decoder to `push` whole
  pipe chunks and pause when full. One 64 KB ffmpeg chunk holds about 9
  frames at 64×36, more than the queue capacity of 4, so the design would
  silently drop frames; the "exactly 60 frames" integration test would fail.
  The builder made backpressure lossless: the decoder feeds only
  `bytesUntilFull()` bytes and holds the rest until the consumer takes a frame.
- `stop()` destroys the child's stdout right after SIGTERM so a blocked
  ffmpeg dies at once. No ffmpeg processes left after 4 runs of the
  integration file.
- Inputs starting with `-` are passed after `-i`; non-http schemes (rtmp,
  udp) are rejected as live streams.

### Task 2.3 review: PASS

Suite on `main`: 23 files, 287 tests PASS. Bundle 52.6 KB. No ffmpeg left
running after the suite.

| Check | Result |
|---|---|
| P6 downsample (2 properties × 1,000) | PASS |
| P2c-naive: `@xterm/headless` replay equals input pixels exactly (200 runs) | PASS |
| Pacing, 30 fps source, 2.0 s window from first frame | 61 frames (target 60 ± 8) |
| Startup to first frame (Node, probe, ffprobe, ffmpeg) | 0.44–0.46 s |
| Red file → center cell `▀`, fg/bg within ±16 of (255,0,0); HUD row blank | PASS |
| End of file exits 0 by itself; resize 80×24 → 100×30 redraws at new size | PASS |
| Hot path (`halfblock.ts`, `downsample.ts`) | no allocation outside error paths |
| SEA binary of the bundle (macOS arm64), `--demo life` in an 80×24 PTY, 2 s | exit 0, 52 frames, 3.4 MB written |

Deferred to Wave 4 (input router): keys typed during the 200 ms probe are
dropped (`probe.passthrough` unused).

### Windows CI catch: process-tree kill (task 2.3b, 2026-11-05)

CI on `3ec37c4` failed on windows-latest only: `killNow()` timed out at
30 s, and the loop test saw 16 frames where it expected over 20.

- **Root cause:** Chocolatey's `ffmpeg.exe` on `PATH` is a shim that starts
  the real ffmpeg as a child. `child.kill('SIGKILL')` killed only the shim;
  the real ffmpeg kept the stdout pipe open, so `onEnd` never fired and
  ffmpeg leaked. Scoop installs shims too, so real Windows users would hit
  this. builder-sonnet reproduced it on macOS with a non-forwarding shim
  (`tests/helpers/ffmpeg-shim.ts`); the new test fails on the old code and
  passes on the fix.
- **Fix:** `src/ingest/kill-tree.ts` (`taskkill /pid N /T /F` on Windows,
  argv array, no shell). `killNow()` and `stop()` also destroy stdout so
  `onEnd` fires even if a descendant holds the pipe. `probe.ts` timeouts use
  the same helper.
- **Flaky tests hardened:** timing assertions now poll with 20 s deadlines
  and count behavior (loop restarts) instead of frames per second.
- CI on `0e22fdb`: all four jobs **success**, including windows-latest.

Wave 2 automated exit check met. Hand check (task 2.5) pending.

---

## Wave 3: compression and modes (2026-11-05)

Tasks 3.1, 3.2 and 3.3 ran **in parallel** in three worktrees, against shared
types architect-opus committed first (`src/renderer/cells.ts`: `CellGrid`,
`colorDistanceSq`, `ColorMapper`; `src/renderer/luma.ts`). All three merged
with no conflicts. Suite on `main`: 35 files, 389 tests PASS.

### Task 3.1 review (encoder): PASS

| Check | Result |
|---|---|
| P2a framing (1,000 runs, depths 24/8/4) | PASS |
| P2b first frame ≤ naive bytes and ≤ naive SGRs (1,000) | PASS |
| P2c `@xterm/headless` round-trip within threshold (300) | PASS |
| P2d delta sequences: emulator equals screen model, model within threshold of source (200) | PASS |
| Mutation check: wrong `CSI k C` count; always-equal color compare | both caught by P2c/P2d (shrunk to 1×2 grids) |
| `encode()` on a random 244×72 frame, threshold 0 (worst case, 17,568 SGRs) | 1.0 ms/frame |
| `naiveBytes` equals `serializeNaive(...).length` | exact, unit-tested |

Design points: one combined SGR when fg and bg both change; skip runs use
`CSI k C` unless a no-SGR reprint is shorter; the screen model stores the
color actually shown, so error never exceeds the threshold.

### Task 3.2 review (Braille, ASCII): PASS

P6 braille and ascii at 1,000 runs each: PASS. Accepted deviation: a block
with no dot strictly above the rounded mean luma (not only a uniform block)
draws a space with the mean as background, because Braille `U+2800` would
draw nothing.

### Task 3.3 review (palettes, color depth): PASS, one spec bug caught

- **PBT catch #3 (spec bug, 2026-11-05):** brief 3.3 specified DMG by luma
  quartiles. The idempotence property failed: the lightest shade `#9BBC0F`
  has luma 168, which falls in quartile 2, so a second pass maps it to
  `#8BAC0F`. DMG now maps to the nearest shade by its own luma (boundaries
  63|64, 118|119, 160|161), like amber and green.
- 256 and 16 mappers are exact nearest-color searches (brute-force check over
  1M samples: no mismatch). Throughput: about 8,200 (256) and 6,500 (16)
  `map()` calls per ms.
- Review finding for 3.4: amber and green ramps top out at luma 179 and 196,
  so every brighter input clips to the peak. Ramps will be respread over the
  full luma range with white-hot highlights, keeping idempotence.

### Task 3.4 review (pipeline, `--bench`, sweep): PASS

Suite: 38 files, 433 tests PASS. New P2c at depth 8 reads xterm palette
indexes back. Phosphor ramps respread: amber luma 8–244 (white-hot
`#FFF4D6`), green 7–241 (`#D0FFD0`); idempotence still holds.

**Bench sweep** — `bash scripts/bench.sh`, 2026-11-05, MacBook (arm64),
Node 26.13.0, FFmpeg 9.0.2, 150 frames per row, half-block. Raw data:
`docs/evidence/wave3/sweep.jsonl` (102 rows) and `sweep.md`.

Naive baseline = two full SGRs per cell plus a cursor move per row
(`serializeNaive`). Selected rows at 120×35 (render 120×34):

| Demo | Depth | Threshold | KB/frame (naive 154) | SGR/frame (naive 8,160) | SGR saved | Bytes saved | p95 ms |
|---|---|---|---|---|---|---|---|
| mandelbrot | 24-bit | 0 | 137.0 | 3,876 | 52.5% | 11.1% | 0.37 |
| mandelbrot | 24-bit | **8** | 66.8 | 2,020 | **75.2%** | 56.7% | 0.34 |
| mandelbrot | 256 | 8 | 20.5 | 965 | 88.2% | 86.7% | 0.71 |
| life | 24-bit | 8 | 83.4 | 2,649 | 67.5% | 38.7% | 0.45 |
| cellauto | 24-bit | 8 | 126.6 | 3,934 | 51.8% | 15.5% | 0.42 |
| gradients | 24-bit | 0 | 97.2 | 2,860 | 64.9% | 35.0% | 0.43 |
| gradients | 24-bit | **8** | 34.0 | 1,269 | **84.4%** | 77.3% | 0.33 |
| testsrc2 | 24-bit | 8 | 15.0 | 514 | 93.7% | 89.4% | 0.35 |

At 244×72 (17.6k cells), mandelbrot: 538 KB/frame at threshold 0, 246 KB at
8, 79 KB at 256-color threshold 8. Render time p95 stays under 3.1 ms in
every row (under 10% of the 33 ms budget).

Findings:

- **Default threshold set to 8** (architect-opus decision). It is about 1% of
  the black-to-white redmean distance (≈765), and it more than doubles byte
  savings on gradients (35% → 77%) and mandelbrot (11% → 57%).
- **Headline numbers at default settings (24-bit, threshold 8):** 52–94%
  fewer SGR sequences and 16–89% fewer bytes than the naive encoder,
  depending on content. The "over 70%" claim in the original video script
  holds for SGRs on 3 of 5 demos and for bytes on 2 of 5; scripts must cite
  the per-demo numbers.
- Compared with the Apple Terminal limits (Wave 0: about 30 fps at
  135 KB/frame of worst-case gradient content at 120×35), every demo at
  120×35 and default settings is under 130 KB/frame. At 244×72 only
  256-color stays under 100 KB/frame on mandelbrot and cellauto, which is
  what the Wave 4 governor's step 3 is for.
- `--bench --demo mandelbrot --frames 150 --size 120x35` at the new default:
  66.78 KB/frame, 75.2% SGRs saved, 47.1% cells skipped, p95 0.29 ms.

### Task 3.6 review (MCP server) and 3.5 (Power): PASS

- `tools/frankentty-mcp/server.ts`: zero-dependency MCP server (stdio,
  newline-delimited JSON-RPC 2.0, protocol 2025-06-18) with four tools:
  `frankentty_bench`, `frankentty_probe_media`, `frankentty_render_snapshot`
  (decodes one frame, runs the real pipeline, replays it in `@xterm/headless`,
  returns the glyph grid and top background colors), `frankentty_terminal_caps`.
  22 integration tests; suite 39 files, 455 tests PASS.
- Power `powers/vt100-video/` (Agent Plugins format): `plugin.json`, skills
  `vt100-escapes`, `ffmpeg-pipe`, `terminal-bench`, and `mcp.json`.
  `kiro-cli powers install ./powers/vt100-video` → "Installed power".
- **Finding:** in Kiro CLI 3.0 `--no-interactive` runs, the Power activated
  but reported "Available servers: ." A probe Power whose MCP command only
  writes its cwd to a file never ran, so the CLI did not start Power MCP
  servers in that mode. Workaround: the same server is registered in
  `.kiro/agents/architect-opus.json` (`mcpServers`). The agent-level
  `.kiro/settings/mcp.json` is write-protected for the orchestrator by the
  Kiro Crew policy.
- End-to-end through Kiro (2026-11-05):
  `kiro-cli chat --v3 --agent architect-opus` called
  `frankentty_render_snapshot` (testsrc2, 40×12) and got a 11-row glyph grid
  with top backgrounds `#00fe00` (60 cells), `#fdfe00` (60), `#0000fd` (59);
  `frankentty_terminal_caps` for the Apple Terminal 488 environment returned
  colorDepth 24.

---

## Wave 4: sync, controls and the quality governor (2026-11-05)

Tasks 4.1 (audio + clock), 4.2 (key router + HUD) and 4.3 (governor) ran in
parallel worktrees as standalone modules; 4.4 integrated them into the
player. Suite: 50 files, 635 tests. CI on `a54c5d6`: all four jobs
**success**. ffplay runs headless in CI with `SDL_AUDIODRIVER=dummy`.

| Item | Result |
|---|---|
| P8 clock vs. reference model (1,000 runs); P8b monotonic (1,000) | PASS |
| P5 key router, any split of the byte stream (1,000); random bytes never throw, buffer ≤ 64 (2 × 1,000) | PASS |
| HUD width exactly `cols` for cols 1–400 (1,000) | PASS |
| Governor properties (a)–(e), 1,000 runs each | PASS |
| Audio pipe: spawn to first WAV bytes out of ffmpeg (`-ss 10`, 5 runs) | 75–95 ms |
| Governor simulation, Apple Terminal trace (2.4 MB/s, mandelbrot 244×72) | settles at level 4 (256-color + 14,054-cell cap) → 30.0 fps by second 10; disabled: under 5 fps |
| Governor end-to-end, fake stdout with 80 ms writes at 30 fps | steps to 256-color + threshold 24, no decoder restart |
| PTY: Right seeks (HUD ≥ 0:05 within 1 s), Space pauses (ffplay gone, time frozen, ⏸), Space resumes, `q` exits 0 with no children | PASS on macOS, Linux CI |

CI catch: the PTY controls test sampled child processes with `pgrep` every
100 ms; on the hosted macOS runner each sample took longer, so a 0.8 s window
held only 3 samples and the "> 3" minimum failed. The minimum is now 2; the
assertions on what each sample contains are unchanged.

Open (accepted for now): with a negative `--av-offset`, the HUD time can
read up to |offset| high during the first |offset| seconds. The governor
resets to full quality after a resize (new geometry, new baseline).

### Wave 4 hand check by Ian (Apple Terminal, 2026-11-05): FAIL on seek/sync

Ian: seeking is "super laggy" with audio and video cutoffs; audio can be
off and takes a while to start after pause or seek; video can be flashy.
`m` and `c` switching was smooth.

Diagnosis (architect-opus), measured on this Mac. First rgb24 frame after
`-ss`, 240×136 output:

| Source | `-ss 0` | `-ss 5` | `-ss 30` |
|---|---|---|---|
| mandelbrot (lavfi) | 44 ms | 323 ms | **2,017 ms** |
| cellauto (lavfi) | 35 | 109 | 440 |
| gradients (lavfi) | 31 | 87 | 375 |
| life (lavfi) | 30 | 55 | 179 |
| testsrc2 (lavfi) | 30 | 46 | 128 |
| testsrc2 MP4 file | — | — | 47–48 |

Causes: (1) lavfi demos cannot seek, so `-ss` renders from 0; (2) the clock
is anchored at ffplay spawn time, not first sound (~0.35 s later), so
video leads audio after every seek/resume; (3) each pause/seek respawns
ffmpeg + ffplay; (4) the clock runs before the new decoder has a frame, so
frames arrive late and are dropped in a burst; (5) seeks and a 10 s timer
force full-screen redraws, which paint visibly in Apple Terminal (no DEC
2026). Unit and PTY tests passed because they checked behavior, not timing
or smoothness. Fix briefs: 4.6 (PCM pump into one long-lived ffplay, seek
barrier, no needless full redraws, rolling refresh) and 4.7 (seekable demo
cache file).

### Tasks 4.6–4.10 (seek/sync fixes, demo cache, distribution): PASS

| Item | Result |
|---|---|
| Seek latency, key → first new frame, 20 s MP4 with audio (PTY, this Mac) | 0.17–0.24 s, including the 120 ms key coalescing; 0.19–0.22 s under 4× `yes` CPU stress |
| Frames shown in the 1 s after a seek | 28–30 of 30 |
| ffplay processes per session (two seeks, pause, seek while paused, resume) | 1 |
| PCM pump: written-ahead audio | 100–120 ms (`LEAD_MS` 120), 0 underruns |
| Demo cache build, 60 s, this Mac | mandelbrot 4.7 s (67 MiB), life 1.1 s, cellauto 1.3 s, gradients 1.5 s, testsrc2 0.8 s |
| `--seek-test`, warm cache, max first-frame latency over 1/15/30/45 s | mandelbrot 50.6 ms, life 49.7, cellauto 41.2, gradients 34.3, testsrc2 36.1 (was 2,017 ms for mandelbrot at 30 s) |
| PBT catch #4 (P9, PCM pump): pausing after the audio source ended moved the position backwards | fixed, unit test added |

**Review catch (architect-opus, 2026-11-05):** after 4.6, `govSkip` in
`src/player/controller.ts` called itself instead of
`governor?.recordSkip(t)`. The first tick skipped because stdout was busy
would overflow the stack, which is exactly Apple Terminal's slow case. 721
tests passed with the bug. Fixed in `6c75028`; task 4.9 added busy-stdout
tests. A mutation check reintroducing the self-call makes all 4 new tests
fail with `RangeError: Maximum call stack size exceeded`.

**CI catches:** an Ubuntu apt mirror hang (install step now has retries
and a 6 min cap); macOS 26's `sha256sum` is the BSD tool without
`--check` (smoke uses `-c`); a "seek cache ready" HUD message raced a mode
message in a PTY test, and a seek bound was too tight for hosted runners
(tests now use private warm caches and CI allowances).

### First release: v0.1.0 (2026-11-06)

CI run [42143979994](https://github.com/iant4093/FrankenTTY/actions/runs/42143979994)
on `7e25495`: every job **success**, including the 5-target smoke
(macOS arm64 and x64, Linux x64 and arm64, Windows x64), installer tests on
three OSes, and Publish release. Release `v0.1.0` assets: five archives
(38.9–47.3 MB), `frankentty.cjs` (146 KB), `install.sh`, `install.ps1`,
`SHA256SUMS`, with build provenance. The npm step skipped by design
(first publish is manual).

Real install check from GitHub on this Mac:
`curl -fsSL …/releases/latest/download/install.sh` → `sh install.sh --no-ffmpeg`
into a scratch dir → `frankentty --version` prints `0.1.0`.
