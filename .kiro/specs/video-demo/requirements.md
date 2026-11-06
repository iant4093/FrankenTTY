# Requirements: FrankenTTY demo video

Source: `docs/original/video-demo.md`, reduced per `docs/GAP_ANALYSIS.md`
section 5 (V1–V8). Status: draft. Tool choices wait for Ian (see tasks.md,
"Decisions").

- **REQ-VID-01 (format):** The final video SHALL be H.264/AAC MP4, 1920×1080, 30 or 60 fps, 120–175 s long, loudness about −14 LUFS.
- **REQ-VID-02 (rights):** Every asset SHALL be self-made: FrankenTTY captures, procedural lavfi media, our own motion graphics, and our own or synthesized narration. No third-party music, clips or trademarks.
- **REQ-VID-03 (real terminal):** The live-demo act SHALL show unedited FrankenTTY output in a real terminal: half-block playback, `m`, `c`, `i`, a seek and a resize. Overlays may sit on top; terminal pixels are not edited.
- **REQ-VID-04 (honest numbers):** Every number on screen or in narration SHALL appear in `docs/EVIDENCE.md`, with per-demo values where they differ (for example "52–94% fewer color codes", not "over 70%").
- **REQ-VID-05 (Kiro story):** One act SHALL show the `.kiro/` layout, the two-agent split, parallel worktree builders, hooks blocking a turn, a property-test counterexample, and the MCP snapshot tool.
- **REQ-VID-06 (audio sync):** Narration segment lengths SHALL drive scene lengths (frames = ceil(seconds × fps)), so no scene cuts a sentence.
