---
inclusion: always
---

# Product: FrankenTTY

FrankenTTY is a CLI video player that streams video through ANSI/VT100 escape
codes. FFmpeg decodes a file or URL into raw RGB24 frames. Each terminal cell
shows two pixels with the upper half block `▀` (foreground = top pixel,
background = bottom pixel). The serializer removes repeated color codes and
unchanged cells, and the player paces frames against audio.

Hackathon: Kiroween 2026, **Frankenstein** category (submission window Oct 30 to
Dec 4, 2026). Owner: Ian Truong (`iant4093`). License: MIT.

## Users and goals

- Anyone with a terminal can run `frankentty --demo` within a minute of
  installing, on macOS, Linux or Windows.
- Primary terminal: Apple Terminal on macOS 26+. Tier 1 also includes Windows
  Terminal. See `docs/PLAN.md` section 2 for the full tier list.
- Playback stays smooth: the adaptive quality governor (REQ-PERF-01) trades
  color precision and resolution for frame rate before it drops frames.

## Scope

In: local files and finite http(s) URLs; half-block, ASCII and Braille modes;
TrueColor, Amber, Green and DMG palettes; pause; seek (Left/Right 5 s,
Shift+Left/Right 30 s); HUD; resize; `--bench`.

Out: live streams, recording, subtitles, network servers.

## UX rules

- The terminal is always restored on exit, whatever the cause.
- Errors before playback print one clear line and exit 1 without touching the
  terminal state.
- Every number shown to users (README, Devpost, video) comes from
  `docs/EVIDENCE.md`, which comes from `--bench` or a recorded run.

## Hackathon compliance (never break)

- `/.kiro` and all subfolders stay tracked in Git. `.gitignore` never lists them.
- `/LICENSE` is MIT and detectable by GitHub.
- Demo media is procedural (`ffmpeg -f lavfi`). No copyrighted clips, music
  or trademarks anywhere in the repo.
