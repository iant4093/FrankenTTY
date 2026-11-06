# FrankenTTY demo video — script and shot list (task 6.1, draft)

Target 2:30. Every number is cited to `docs/EVIDENCE.md`. Narration is about
130 words per minute; each block lists its word count so scene lengths can
follow the voice (REQ-VID-06).

---

## Act I · Hook (0:00–0:20)

**Shots (Ian records, Apple Terminal, 1920×1080, window ~120×35):**
1. Empty terminal, blinking cursor. Type `frankentty --demo mandelbrot`.
2. Mandelbrot plays with sound. Hold 6 s.
3. Title card: "FrankenTTY — video over 50-year-old escape codes" + Kiroween Frankenstein badge.

**Narration (44 words):**
> This is a plain terminal. No browser, no GPU window, just text. FrankenTTY
> welds FFmpeg's modern video pipeline to the VT100 escape codes from the
> 1970s. Every frame you see is characters and color codes, streamed with
> sound.

## Act II · How (0:20–0:55)

**Shots (rendered from real output, `scripts/render-screenshots.ts` style):**
1. Zoom into one cell: `▀`, top pixel = foreground, bottom = background.
2. Side by side: naive encoder (every cell, two color codes) vs. FrankenTTY
   (changed cells only, reused colors). Counter shows color codes per frame.
3. Chart: Apple Terminal sweep — fps vs. color changes (Wave 0).
4. Table: color codes saved per demo at 120×35 (Wave 3 sweep).

**Narration (78 words):**
> One character cell holds two pixels: the half block's foreground is the
> top, its background the bottom. The catch is speed. We measured Apple
> Terminal taking in only about two and a half megabytes a second, and the
> real cost is color changes, not bytes. So the encoder remembers what is
> already on screen, sends only changes, and reuses colors. That cuts color
> codes by fifty-two to ninety-four percent, depending on the picture.

Citations: 2.2–2.5 MB/s and SGR cost (EVIDENCE Wave 0, Apple Terminal 488
and sweep); 52–94% at default settings (Wave 3, task 3.4 review).

## Act III · Live (0:55–1:40)

**Shots (Ian records, unedited terminal; key badges overlaid):**
1. `m` → ASCII → Braille → half-block.
2. `c` → amber → green → DMG → TrueColor.
3. `→` seek, `Space` pause and resume (sound stops and starts).
4. Drag the window larger: the HUD's Q level steps up, playback stays smooth.
5. `i` hides the HUD, `q` quits; the shell prompt comes back clean.

**Narration (82 words):**
> Here it is live. M switches between half blocks, ASCII and Braille. C
> cycles CRT palettes: amber, green phosphor, and a four-shade handheld
> look. Seeking takes about a fifth of a second, and the sound comes back
> with the picture. When the window grows past what the terminal can
> draw, a quality governor steps in: it merges close colors, then drops to
> 256 colors, then draws fewer cells. Press q, and the terminal is exactly
> as you left it.

Citations: seek 0.17–0.24 s (EVIDENCE tasks 4.6–4.10); governor levels
(design.md section 5, task 4.3 simulation).

## Act IV · Built with Kiro (1:40–2:30)

**Shots (screen recordings of real runs and files):**
1. `.kiro/` tree: agents, steering, hooks, specs.
2. Split screen: architect-opus brief → three builder-sonnet sessions in three
   worktrees (Wave 3 logs in `build/runs/`, `docs/briefs/3.1–3.3.md`).
3. `gate-turn` hook blocking a turn until tests pass (hooks.log line).
4. A shrunk property-test counterexample (P1f or DMG idempotence).
5. `frankentty_render_snapshot` MCP call returning a glyph grid.
6. CI matrix all green; `curl … | sh` install in a fresh shell.

**Narration (96 words):**
> FrankenTTY was built in Kiro by two agents. Claude Opus 5.5 wrote the EARS
> specs, steering and task briefs, and reviewed every change. Claude Sonnet
> 5.5 built each brief, often three at once in separate git worktrees.
> Hooks ran the tests after every write and refused to end a turn until the
> suite was green. Property-based tests caught two mistakes in the spec
> itself, and a clock bug. A Kiro Power gives agents an MCP tool that renders a frame through a
> real terminal emulator. CI builds for five platforms, and one command
> installs it.

Citations: PBT catches #1, #3 and #4 (EVIDENCE Waves 1 and 3), parallel worktrees
(Waves 2–4), MCP verification (task 3.6), release v0.1.0/v0.1.1 CI runs.

## Closing card (2:30)

Repo URL, MIT badge, "Built with Kiro".
