---
name: vt100-escapes
description: Rules for writing ANSI/VT100 escape sequences that render video safely and cheaply - lifecycle, framing, SGR forms, cursor moves, and what each terminal supports.
---

# VT100 escapes for terminal video

Use this when writing or reviewing code that emits escape sequences for
full-screen, frame-by-frame output.

## Lifecycle

| Phase | Sequence | Notes |
|---|---|---|
| Enter | `CSI ?1049h` `CSI ?25l` `CSI ?7l` `CSI 2J` + raw stdin | Alt screen, hide cursor, autowrap off |
| Frame | `CSI ?2026h` … `CSI 0m` `CSI ?2026l` | DEC synchronized output; ignored where unsupported |
| Restore | `CSI ?2026l` `CSI 0m` `CSI ?7h` `CSI ?25h` `CSI ?1049l`, raw off | Idempotent; on every exit path |

Exit paths to trap: `q`, byte `0x03` (Ctrl+C arrives as a byte in raw mode,
not SIGINT), SIGINT, SIGTERM, SIGHUP, SIGBREAK (Windows),
`uncaughtException`, `unhandledRejection`, `exit`.

Keep autowrap off. Printing the last column otherwise sets pending-wrap and
can scroll the screen.

## Cost model

The expensive part in Apple Terminal is the number of SGR sequences, not the
byte count (FrankenTTY Wave 0: 2.1 MB/s with an SGR on nearly every cell,
21 MB/s with few SGRs). So:

1. Emit fg/bg only when they change (run-length color reuse).
2. When both change, emit one combined SGR: `CSI 38;2;R;G;B;48;2;R;G;B m`.
3. A cell whose top and bottom match draws a space with only a background.
4. Skip unchanged cells with `CSI n C` only when shorter than reprinting.
5. Compare against a model of what the screen shows, not the last source
   frame, so threshold error never accumulates.

## SGR forms by depth

| Depth | Foreground | Background |
|---|---|---|
| 24-bit | `38;2;R;G;B` | `48;2;R;G;B` |
| 256 | `38;5;n` (16–231 cube, 232–255 grays) | `48;5;n` |
| 16 | `30–37`, `90–97` | `40–47`, `100–107` |

## Capability detection

- Color: `COLORTERM=truecolor|24bit` first. Node's `getColorDepth()` reports
  8 for Apple Terminal even when `COLORTERM=truecolor`.
- Probe once: `CSI ?2026$p` (DECRQM), `CSI 16 t` (cell px), `CSI 14 t`
  (window px), then `CSI c` (DA1) as the sentinel every terminal answers.
  Stop at the DA1 reply or 200 ms. Apple Terminal 488 answers only `14 t` and
  DA1.
- Cell aspect = cell height / width; derive it from `14 t` divided by the
  grid when `16 t` is missing. Fall back to 2.0.

## Verify with the MCP server

Call `frankentty_render_snapshot` to see the glyph grid an emulator core shows
for a frame, and `frankentty_terminal_caps` to check detection for an
environment.
