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
