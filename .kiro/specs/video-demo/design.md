# Design: FrankenTTY demo video (draft)

## Acts (target 150 s)

| Act | Time | Content | Source |
|---|---|---|---|
| I · Hook | 0:00–0:20 | Blinking cursor → full-color mandelbrot in a plain terminal; title card | Real capture + title |
| II · How | 0:20–0:55 | One cell = two pixels (`▀` fg/bg); screen model and deltas; "color codes, not bytes, are the cost" with the Apple Terminal sweep | Rendered diagrams from real encoder output (`scripts/render-screenshots.ts` style) + bench table |
| III · Live | 0:55–1:40 | `frankentty --demo`: `m`, `c`, `i`, seek, pause, resize; HUD shows Q-level stepping | Real capture, key badges overlaid |
| IV · Kiro | 1:40–2:30 | `.kiro/` tree; architect-opus ↔ builder-sonnet; 3 parallel worktrees; gate-turn hook blocking; PBT counterexample (P1f / DMG); MCP snapshot; CI matrix + one-command install | Screen recordings of real runs, logs from `build/runs/`, `docs/EVIDENCE.md` |

## Capture options (decide in Wave 6)

| Option | Pros | Cons |
|---|---|---|
| A. Real screen recording of Apple Terminal (QuickTime or `screencapture -v`) | Most honest; real fonts and real speed | Needs Ian at the Mac; manual timing |
| B. VHS (`brew install vhs`) | Scripted, repeatable | Renders through xterm.js in headless Chrome; no audio; may stutter at 30 fps (gap V1/V2) |
| C. Rendered frames from the emulator replay (as in README screenshots) | Fully automated, pixel-exact cells | Not a "real terminal"; fine for Act II, not for Act III |

Recommendation: A for Act III, C for Act II, short A clips for Act I.

## Narration and music

Narration needs a voice: Ian's own, or a synthesized one (needs an account
and key, gap V5). Background music can be procedural (`aevalsrc`), which also
fits the theme.

## Assembly

Recommendation: plain FFmpeg filter graphs driven by a script
(`video/build.sh`), titles as rendered PNGs. Remotion and Manim are optional
extras only if time allows (gap V4).
