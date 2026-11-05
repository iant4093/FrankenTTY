# Requirements: FrankenTTY

EARS notation. Sources: `docs/original/frankentty-project-specification.md` (original),
`docs/GAP_ANALYSIS.md` (gaps), `docs/PLAN.md` (decisions D1-D8), and
`docs/EVIDENCE.md` (Wave 0 measurements). IDs are stable; changed items keep
their ID and note the change.

## 1. Compliance and repository

- **REQ-COMP-01:** THE repository SHALL track `/.kiro/specs`, `/.kiro/hooks`, `/.kiro/steering` and `/.kiro/agents` in Git, and `.gitignore` SHALL NOT exclude `/.kiro` or any subfolder.
- **REQ-COMP-02:** THE repository SHALL contain an MIT `/LICENSE` with copyright "Ian Truong".
- **REQ-COMP-03:** WHEN generating demo media, THE SYSTEM SHALL use only procedural sources (`ffmpeg -f lavfi`) with no third-party trademarks or copyrighted material.
- **REQ-COMP-04:** THE repository SHALL include `README.md` (TruongCam format, `docs/PLAN.md` section 6) and `DEVPOST_WRITEUP.md` authored by architect-opus.

## 2. CLI and prerequisites

- **REQ-CLI-01:** THE SYSTEM SHALL accept `frankentty <input | --demo [name]>` with flags `--mode halfblock|ascii|braille`, `--palette truecolor|amber|green|dmg`, `--fps N` (1-60, default 30), `--color auto|truecolor|256|16`, `--threshold N` (0-100, default chosen by bench), `--cell-aspect N` (1.0-3.0), `--av-offset MS` (-2000..2000), `--quality auto|max`, `--no-audio`, `--loop`, `--bench`, `--frames N` (bench only, default 300), `--size COLSxROWS` (bench only, default 120x35), `--json` (bench only), `--version`, `--help`.
- **REQ-CLI-02:** IF an argument is invalid or unknown, THEN THE SYSTEM SHALL print one line naming the argument and the allowed values to stderr and exit 2 without touching terminal state.
- **REQ-PREREQ-01:** IF `ffmpeg` or `ffprobe` is not on `PATH`, THEN THE SYSTEM SHALL print the install command for the detected OS and exit 1 before touching terminal state. IF only `ffplay` is missing, THEN THE SYSTEM SHALL warn and play without audio.
- **REQ-TTY-01:** IF stdout or stdin is not a TTY and `--bench` is not set, THEN THE SYSTEM SHALL print an error and exit 1.

## 3. Terminal lifecycle and capabilities

- **REQ-TERM-01 (changed):** WHEN playback starts, THE SYSTEM SHALL enter the alternate screen (`CSI ?1049h`), hide the cursor (`CSI ?25l`), disable autowrap (`CSI ?7l`) and enable raw stdin.
- **REQ-TERM-02 (changed):** WHEN stdout emits `resize`, THE SYSTEM SHALL debounce 150 ms, recompute geometry for `cols x (rows - 1)` cells while preserving source aspect, and restart decoding at the current position.
- **REQ-TERM-03 (changed):** WHEN the user presses `q`, sends byte `0x03`, or the process receives SIGINT, SIGTERM, SIGHUP or SIGBREAK, or an uncaught exception or unhandled rejection occurs, or the process exits, THE SYSTEM SHALL write `CSI ?2026l`, `CSI 0m`, `CSI ?7h`, `CSI ?25h`, `CSI ?1049l` in that order, disable raw mode, and kill every child process. Restore SHALL be idempotent.
- **REQ-CAP-01:** WHEN starting, THE SYSTEM SHALL choose color depth in this order: `--color` flag; `COLORTERM` of `truecolor` or `24bit` → 24-bit; `TERM_PROGRAM=Apple_Terminal` on Darwin 25+ → 24-bit; `WT_SESSION` set → 24-bit; Node `getColorDepth()` → 24, 8 or 4 bits.
- **REQ-CAP-02:** WHEN starting on a TTY, THE SYSTEM SHALL send one probe (`CSI ?2026$p`, `CSI 16 t`, `CSI 14 t`, `CSI c`), stop reading at the DA1 reply or after 200 ms, and record: mode 2026 support, cell pixel size (from `16 t`, else derived from `14 t` and the cell grid), and whether a reply arrived. Probe replies SHALL NOT reach the key router.
- **REQ-CAP-03:** IF the locale is not UTF-8 (on Unix: `LC_ALL`, then `LC_CTYPE`, then `LANG`), THEN THE SYSTEM SHALL offer only ASCII mode. IF `TERM=linux`, THEN Braille mode SHALL be skipped.
- **REQ-GEO-01:** THE SYSTEM SHALL use cell aspect (height/width) from `--cell-aspect`, else the probe, else 2.0.
- **REQ-GEO-02:** THE SYSTEM SHALL always reserve the bottom row for the HUD, whether or not the HUD is visible.

## 4. Ingest

- **REQ-INGEST-01:** WHEN given a file path or finite http(s) URL, THE SYSTEM SHALL read width, height, frame rate, duration and audio presence with `ffprobe`, with a 5 s timeout.
- **REQ-INGEST-02:** WHEN playing, THE SYSTEM SHALL decode `rgb24` frames at Braille resolution (`2*cols x 4*rows` of the render area) through a binary pipe.
- **REQ-INGEST-03:** WHEN `--demo` is set, THE SYSTEM SHALL stream lavfi sources directly, with no file written.
- **REQ-INGEST-04:** THE decoder output SHALL be normalized to `--fps` with the FFmpeg `fps` filter.
- **REQ-INGEST-05:** WHEN the decoder restarts (seek, resize), THE SYSTEM SHALL tag it with a new generation ID and discard bytes from older generations.
- **REQ-INGEST-06:** THE frame assembler SHALL emit exactly one frame per `W*H*3` bytes regardless of how the pipe chunks the stream.

## 5. Rendering

- **REQ-RENDER-01:** WHEN in half-block mode, THE SYSTEM SHALL draw pixels `(x, 2y)` and `(x, 2y+1)` as one `▀` cell with foreground = top and background = bottom.
- **REQ-RENDER-02:** WHEN adjacent cells share a foreground or background color within threshold, THE SYSTEM SHALL omit the repeated SGR.
- **REQ-RENDER-03:** WHEN a cell's top and bottom colors match within threshold, THE SYSTEM SHALL emit a space with only a background change.
- **REQ-RENDER-04:** WHEN flushing a frame, THE SYSTEM SHALL wrap it in `CSI ?2026h` ... `CSI 0m CSI ?2026l` and write it with one `write()` call.
- **REQ-RENDER-05:** THE SYSTEM SHALL diff each frame against a screen model of what the terminal shows, skip unchanged cells with `CSI n C` only when that is shorter than reprinting, and fully redraw after resize, mode, palette or HUD changes and every 10 s.
- **REQ-RENDER-06:** WHEN in Braille mode, a dot SHALL be on when its luma exceeds the cell's mean luma; foreground = mean of lit dots, background = mean of unlit dots. WHEN in ASCII mode, the character SHALL come from the ramp ` .:-=+*#%@` by luma, with foreground = cell mean.
- **REQ-RENDER-07:** THE serializer SHALL write into a preallocated buffer and SHALL NOT allocate per cell or per row.
- **REQ-RENDER-08:** WHEN color depth is 256 or 16, THE SYSTEM SHALL map colors to `38;5;n`/`48;5;n` (6x6x6 cube + grays) or the 16 ANSI colors.
- **REQ-PAL-01:** Palettes SHALL map every input to integers in `[0,255]`. Amber, Green and DMG SHALL map to the nearest entry of a fixed ramp, so applying them twice equals applying once.

## 6. Performance

- **REQ-PERF-01:** WHILE playing with `--quality auto`, THE SYSTEM SHALL measure write time per frame over a 1 s window and, IF the frame budget is missed, step down in this order: threshold level 1, threshold level 2, 256-color, then cap render cells (keeping aspect). IT SHALL step back up after 3 s of headroom. `--quality max` disables this.
- **REQ-BENCH-01:** WHEN `--bench` is set, THE SYSTEM SHALL serialize `--frames` frames headless and print naive bytes, compressed bytes, SGR count naive vs. compressed, savings %, and serialize ms per frame, as text and as JSON.

## 7. Sync and controls

- **REQ-SYNC-01 (changed):** WHILE audio plays, THE SYSTEM SHALL pace frames against a clock anchored at audio start plus `--av-offset`, sleep when ahead, and skip serialization when behind by more than one frame interval.
- **REQ-SYNC-02:** WHEN there is no audio or `--no-audio` is set, THE SYSTEM SHALL pace frames against the wall clock.
- **REQ-SYNC-03:** WHEN paused, THE SYSTEM SHALL stop reading the video pipe, stop audio and freeze the clock. WHEN resumed, IT SHALL restart audio at the paused position and re-anchor the clock.
- **REQ-SYNC-04:** Audio SHALL be decoded by `ffmpeg -ss <pos>` and piped as WAV into `ffplay -nodisp -autoexit -i -`.
- **REQ-SYNC-05:** WHEN the user presses Left/Right, THE SYSTEM SHALL seek -5/+5 s; Shift+Left/Right (`CSI 1;2D`/`CSI 1;2C`) -30/+30 s; clamped to `[0, duration]`; and show the new time on the HUD for 1 s.
- **REQ-UI-01:** WHEN the user presses Space, `m`, `c` or `i`, THE SYSTEM SHALL toggle pause, cycle mode (half-block → ASCII → Braille), cycle palette (TrueColor → Amber → Green → DMG), and toggle the HUD.
- **REQ-UI-02:** THE input router SHALL decode keys identically for any split of the byte stream, and SHALL treat a lone ESC as ESC after 50 ms.
- **REQ-HUD-01:** WHEN visible, the HUD SHALL show fps, KB/s written, SGRs saved %, quality step, mode, palette, and position/duration.

## 8. Platform, distribution, CI

- **REQ-PLAT-01:** THE same build SHALL run on macOS, Linux and Windows, with quit, resize and teardown behavior as in `docs/PLAN.md` section 2.3.
- **REQ-DIST-01:** Releases SHALL provide `install.sh`, `install.ps1`, single-executable archives for macOS arm64/x64, Linux x64/arm64 and Windows x64, `SHA256SUMS`, and an npm package `frankentty`.
- **REQ-CI-01:** Pull requests and pushes to `main` SHALL run workflow/security checks, typecheck, lint and tests on macOS, Linux and Windows. Pushes to `main` SHALL publish a release only after every gate passes.
