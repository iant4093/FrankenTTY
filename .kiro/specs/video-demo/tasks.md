# Tasks: FrankenTTY demo video (Wave 6)

## Decisions (Ian, 2026-11-05 19:00 PST: "AI voice, AI-made motion graphics driven by tools, real footage of the player; do the
## entire thing yourself")

- [x] V-D1 Narration: AI voice, generated locally with Kokoro-82M (Apache-2.0 open weights, no account). Verified on this Mac:
      13.3 s of speech in 21.5 s including model download.
- [x] V-D2 Footage: real FrankenTTY runs. Each scene runs the real binary in a pseudo-terminal with scripted keys; the timed byte stream
      is recorded and replayed through a real terminal emulator (xterm.js) at render time. (VHS could not be installed: Homebrew's
      sandbox cannot run inside the agent sandbox. VHS also uses xterm.js, so the result is equivalent.)
- [x] V-D3 Motion graphics and editing: Remotion compositions written by the agents and rendered with the Remotion CLI. Remotion's
      hosted MCP server shut down on 2026-10-26, so the agents drive Remotion directly; the FrankenTTY MCP server supplies footage
      (`frankentty_record_session`) and numbers (`frankentty_bench`).

## Tasks

- [x] 6.1 [architect-opus] Script and shot list: `video/script.md`.
- [x] 6.A [builder-sonnet] Session recorder + MCP tool + scene session specs.
- [x] 6.B [builder-sonnet] Remotion project: terminal replay, motion graphics, acts, timing from narration.
- [x] 6.C [builder-sonnet] Narration (Kokoro), procedural music, mix, loudness, `video/build.sh` end to end.
- [~] 6.D [architect-opus] QA: format, duration 120-175 s, loudness, frame review, numbers vs EVIDENCE, rights. (format, length, loudness and frame review done; ear check pending)
- [ ] 6.E [Ian] Upload to YouTube (needs Ian's account) and paste the link into Devpost.
