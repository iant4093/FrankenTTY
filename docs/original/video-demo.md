# Video Production Specification: FrankenTTY (`video-demo.md`)

## 1. Executive Summary & Video Constraints
- **Target Deliverable:** `video/output/FrankenTTY_Demo_Final.mp4` (1920×1080, 60 FPS, H.264/AAC, Loudness normalized to -14 LUFS)
- **Target Runtime:** `02:15` (Strictly under the 3:00 hackathon limit)
- **Copyright & Compliance:** 100% procedural, self-generated test video (`ffmpeg lavfi`), custom Manim math renders, Remotion React motion graphics, and original synthesized voiceover/SFX. Zero third-party trademarks, copyrighted music, or copyrighted clips.
- **Distribution Target:** Public YouTube upload for Devpost submission.

---

## 2. Multi-Agent Video Production Crew (`.kiro/agents/`)

### 2.1 `architect-opus` (Claude Opus 5.5) — Creative Director, Scriptwriter & QA Reviewer
- **Responsibilities:**
  1. Authors the frame-accurate storyboard, narration script, and timing cues (`video/storyboard.json`).
  2. Orchestrates the `elevenlabs` MCP server to synthesize voiceover stems and retro VT100/CRT sound effects, calculating exact audio durations before visual rendering begins.
  3. Writes `.kiro/steering/remotion.md` steering rules to enforce smooth spring animations, typography hierarchy, and audio-synced frame offsets.
  4. Audits the final rendered MP4 via `ffprobe` and `ffmpeg-mcp` to verify resolution (1080p60), duration (`< 180s`), audio sync, and absence of black frames or clipping.

### 2.2 `builder-sonnet` (Claude Sonnet 5.5) — Motion Graphics, Manim & Capture Engineer
- **Responsibilities:**
  1. Writes and executes the Charmbracelet `VHS` tape script (`video/captures/frankentty_live.tape`) to capture deterministic 60 FPS terminal footage of `FrankenTTY` cycling through rendering and palette modes.
  2. Writes Python Manim scenes and invokes `manim-server` MCP to render the subpixel packing (`\u2580` `▀`) and Run-Length Encoding (RLE) byte-diffing animations.
  3. Builds the modular React/TypeScript **Remotion** studio project (`video/remotion/`), compositing the VHS recordings, Manim animations, kinetic typography, and audio stems.
  4. Executes final rendering via Remotion CLI / `ffmpeg-mcp` and optionally populates a local DaVinci Resolve timeline via `davinci-resolve` MCP.

---

## 3. MCP & Tooling Configuration (`.kiro/settings/mcp.json`)

```json
{
  "mcpServers": {
    "remotion": {
      "command": "npx",
      "args": ["-y", "@mcp-use/remotion-mcp-app"],
      "env": {
        "PORT": "3005"
      }
    },
    "manim-server": {
      "command": "uv",
      "args": [
        "run",
        "--with", "manim",
        "--with", "mcp",
        "python", "-m", "manim_mcp_server.server"
      ]
    },
    "elevenlabs": {
      "url": "[https://api.elevenlabs.io/v1/mcp](https://api.elevenlabs.io/v1/mcp)"
    },
    "ffmpeg-mcp": {
      "command": "uv",
      "args": ["run", "--directory", "./tools/ffmpeg-mcp", "python", "server.py"]
    },
    "davinci-resolve": {
      "command": "python3",
      "args": ["./tools/davinci-resolve-mcp/server.py"],
      "env": {
        "DAVINCI_RESOLVE_BRIDGE": "1"
      }
    }
  }
}
```

### Required CLI Prerequisites
- **VHS (Deterministic Terminal Recorder):** `brew install vhs`
- **FFmpeg (Lavfi & Mastering):** `brew install ffmpeg`
- **Remotion Agent Skills (Steering Context):** `npx skills add remotion-dev/skills` (copied into `.kiro/steering/remotion.md`)

---

## 4. Video Workspace Directory Structure

```text
frankentty/
├── video-demo.md                        # This master video specification
├── .kiro/
│   ├── steering/
│   │   └── remotion.md                  # Remotion best practices & animation rules
│   └── specs/
│       └── video-demo/
│           ├── requirements.md          # EARS video requirements
│           ├── design.md                # Composition architecture & timing sync
│           └── tasks.md                 # Multi-agent video execution tasks
└── video/
    ├── storyboard.json                  # Time-coded script, frame counts, & asset manifest
    ├── captures/
    │   ├── frankentty_live.tape         # VHS deterministic terminal recording script
    │   └── raw_terminal_60fps.mp4       # Captured 1080p60 terminal footage
    ├── manim/
    │   ├── subpixel_rle_scene.py        # Manim Python script for half-block & RLE math
    │   └── manim_subpixel_1080p60.mp4   # Rendered Manim explainer clip
    ├── audio/
    │   ├── vo_01_hook.mp3               # ElevenLabs voiceover segment 1
    │   ├── vo_02_architecture.mp3       # ElevenLabs voiceover segment 2
    │   ├── vo_03_live_demo.mp3          # ElevenLabs voiceover segment 3
    │   ├── vo_04_kiro_workflow.mp3      # ElevenLabs voiceover segment 4
    │   ├── sfx_crt_power_on.mp3         # Generated CRT degauss / hum SFX
    │   ├── sfx_vt100_clatter.mp3        # Generated mechanical terminal key SFX
    │   └── bgm_synth_pulse.mp3          # Generated royalty-free ambient synth stem
    ├── remotion/
    │   ├── package.json
    │   ├── remotion.config.ts
    │   └── src/
    │       ├── Root.tsx                 # Main 1920x1080 @ 60fps Composition (8100 frames)
    │       ├── MasterSequence.tsx       # Sequenced timeline orchestrating Acts I–IV
    │       ├── scenes/
    │       │   ├── Act1Hook.tsx         # Glitch CRT title card + Frankenstein pitch
    │       │   ├── Act2ManimBridge.tsx  # Side-by-side Manim subpixel & RLE telemetry
    │       │   ├── Act3LiveDemo.tsx     # Framed VHS terminal capture + live hotkey callouts
    │       │   └── Act4KiroShowcase.tsx # Animated Opus 5.5 + Sonnet 5.5 Crew & PBT metrics
    │       └── components/
    │           ├── TerminalBezel.tsx    # Retro-modern CRT/TTY frame wrapper
    │           ├── KeypressBadge.tsx    # Spring-animated keystroke indicator ([m], [c], [i])
    │           └── ThroughputGraph.tsx  # Animated MB/s RLE compression chart
    └── output/
        └── FrankenTTY_Demo_Final.mp4    # Final mastered submission video
```

---

## 5. Requirements Specification (`requirements.md` — EARS Notation)

- **REQ-VID-01 (Duration & Format):** WHEN the final video is rendered, THE SYSTEM SHALL output an H.264 `.mp4` file at `1920x1080` resolution and `60 FPS` with a total duration strictly between `120` and `175` seconds (`< 3:00` limit).
- **REQ-VID-02 (Copyright Safety):** WHEN generating visual or audio assets for the demo video, THE SYSTEM SHALL exclusively use procedural video feeds (`ffmpeg -f lavfi`), Manim renders, Remotion components, and AI-synthesized voiceover/SFX, containing zero copyrighted music or third-party trademarks.
- **REQ-VID-03 (Authentic Terminal Proof):** WHEN demonstrating `FrankenTTY` functionality in Act III, THE SYSTEM SHALL display genuine, unedited terminal execution captured via `VHS` showing real-time 24-bit half-block playback, mode switching (`m`), CRT palette switching (`c`), and the live telemetry HUD (`i`).
- **REQ-VID-04 (Audio-Driven Timing):** WHEN building the Remotion timeline in `MasterSequence.tsx`, THE SYSTEM SHALL dynamically calculate each `<Sequence>` duration from the exact frame length of the corresponding `video/audio/vo_*.mp3` voiceover file (`Math.ceil(durationInSeconds * 60)`).
- **REQ-VID-05 (Kiro Workflow Visualization):** WHEN presenting Act IV, THE SYSTEM SHALL visually showcase the `.kiro/` directory architecture, the Opus 5.5 + Sonnet 5.5 multi-agent split, EARS Spec-Driven Development, Agent Hooks, MCP pipeline, and Property-Based Testing (PBT) invariants.

---

## 6. Time-Coded Storyboard & Script (`storyboard.json` Blueprint)

### Act I: The Hook & The Frankenstein Chimera (`0:00 – 0:22` | `1,320 Frames`)
- **Visual (Remotion `Act1Hook.tsx`):**
  - `0:00–0:05`: Black terminal screen with a blinking amber VT100 block cursor (`█`). Sudden CRT degauss flash bursts into a full-color 30 FPS video stream playing directly inside a raw terminal window.
  - `0:05–0:14`: Kinetic split-screen: Left side shows raw scrolling ANSI escape sequences (`\x1b[38;2;220;50;32m\x1b[48;2;12;24;68m▀`); Right side shows the assembled 24-bit true-color video frame.
  - `0:14–0:22`: Title slam: **"FrankenTTY: Streaming Video Over VT100"** with a badge for the **Frankenstein Category**.
- **Voiceover (`vo_01_hook.mp3`):**
  > *"The terminal console was engineered fifty years ago to print teletype text over serial lines—not to play high-definition movies. Meet FrankenTTY: an unholy chimera that welds modern high-throughput video decoding directly into legacy VT100 ANSI escape codes, streaming smooth 30 frames-per-second true-color video through standard stdout."*
- **Audio SFX:** `sfx_crt_power_on.mp3` at frame 0, `sfx_vt100_clatter.mp3` at frame 300.

### Act II: The Math Under the Hood — Subpixels & RLE (`0:22 – 0:55` | `1,980 Frames`)
- **Visual (Manim MCP `manim_subpixel_1080p60.mp4` composited inside `Act2ManimBridge.tsx`):**
  - `0:22–0:38`: Manim zooms into a single 1:2 rectangular terminal character cell, splitting it vertically using the Unicode upper-half block character `▀` (`\u2580`). Top pixel maps to foreground `\x1b[38;2;R;G;Bm`, bottom pixel maps to background `\x1b[48;2;R;G;Bm`—doubling vertical resolution.
  - `0:38–0:55`: Manim illustrates the TTY throughput bottleneck (`~28 MB/s` uncompressed) and animates **Run-Length Color Compression (RLE)** and **Solid-Space Collapsing**, stripping redundant escape codes across scanlines and dropping payload size by over 70%.
- **Voiceover (`vo_02_architecture.mp3`):**
  > *"How do you turn text cells into square pixels? FrankenTTY exploits the Unicode upper-half block character, packing two distinct 24-bit RGB pixels into every single character cell—one in the foreground, one in the background. To prevent choking the terminal's parser, our serializer applies real-time Run-Length Color Compression, perceptual delta diffing, and DEC synchronized output framing to slash TTY bandwidth by up to seventy percent."*

### Act III: Live Terminal Demonstration (`0:55 – 1:40` | `2,700 Frames`)
- **Visual (VHS Capture `raw_terminal_60fps.mp4` + Remotion `KeypressBadge.tsx` overlays):**
  - `0:55–1:10`: Live terminal running `frankentty --demo`. Video plays smoothly at 30 FPS with synchronized procedural synth audio.
  - `1:10–1:22`: Animated keystroke overlay `[m] Mode Switch` pops up as the terminal flips live in real time between **24-Bit Half-Block (`▀`)**, **TrueColor ASCII Density (`@#%*+`)**, and **High-Res 2×4 Unicode Braille (`\u28FF`)**.
  - `1:22–1:32`: Animated keystroke overlay `[c] CRT Palette` triggers live transitions through **TrueColor**, **1978 Amber VT100 Phosphor**, **Green Monochrome CRT**, and **4-Color Handheld DMG**.
  - `1:32–1:40`: Animated keystroke overlay `[i] Telemetry HUD` highlights the bottom status bar showing live FPS, `KB/s` stdout data rate, and RLE compression percentage, followed by live terminal window resize (`SIGWINCH`) aspect-ratio adaptation.
- **Voiceover (`vo_03_live_demo.mp3`):**
  > *"Here is FrankenTTY running live inside a standard terminal emulator. Using single-key hotkeys, we can hot-swap the rendering engine on the fly from 24-bit half-blocks, to luminance ASCII art, to 2-by-4 Unicode Braille grids. Pressing 'C' cycles through hardware-inspired retro CRT phosphor palettes, while the live telemetry HUD tracks frame pacing, stdout throughput in kilobytes per second, and real-time RLE compression savings."*

### Act IV: Built with Kiro — Multi-Agent Crew, Specs, Hooks & PBT (`1:40 – 2:15` | `2,100 Frames`)
- **Visual (Remotion `Act4KiroShowcase.tsx`):**
  - `1:40–1:52`: Animated architecture diagram of the **Kiro Multi-Agent Crew**: `architect-opus` (Claude Opus 5.5) orchestrating EARS specs, steering docs, and code reviews, paired with `builder-sonnet` (Claude Sonnet 5.5) executing zero-allocation hot loops and PBT suites.
  - `1:52–2:05`: Split view showing `.kiro/hooks/` firing automatically on file save—running the **Property-Based Testing (PBT)** suite across thousands of randomized aspect ratios and RGB buffers—alongside the **MCP Video Pipeline** (Remotion, Manim, ElevenLabs, VHS, FFmpeg) that generated the very video the judges are watching.
  - `2:05–2:15`: Closing card with GitHub repository URL, MIT License badge, and `.kiro/` compliance checkmark.
- **Voiceover (`vo_04_kiro_workflow.mp3`):**
  > *"FrankenTTY was engineered end-to-end in Kiro using a dual-agent crew: Claude Opus 5.5 served as lead systems architect, spec author, and code reviewer, while Claude Sonnet 5.5 drove core implementation. By combining EARS Spec-Driven Development, automated Agent Hooks, and Property-Based Testing, we caught critical scanline buffer edge cases before a single frame ever hit stdout—and even orchestrated this entire demo video autonomously through Kiro's MCP pipeline."*

---

## 7. Implementation Plan (`tasks.md`)

### Wave 1: Audio Script, Voiceover Synthesis & Steering Setup
- [ ] **Task 1.1 [Agent: `architect-opus`]:** Install Remotion Agent Skills (`npx skills add remotion-dev/skills`) or write `.kiro/steering/remotion.md` enforcing `useCurrentFrame()`, `spring()`, `interpolate()`, and zero CSS-transition anti-patterns.
- [ ] **Task 1.2 [Agent: `architect-opus`]:** Generate `video/storyboard.json` and invoke the `elevenlabs` MCP server to synthesize `vo_01_hook.mp3`, `vo_02_architecture.mp3`, `vo_03_live_demo.mp3`, `vo_04_kiro_workflow.mp3`, plus `sfx_crt_power_on.mp3`, `sfx_vt100_clatter.mp3`, and `bgm_synth_pulse.mp3`.
- [ ] **Task 1.3 [Agent: `architect-opus`]:** Probe exact millisecond durations of all generated audio files using `ffprobe` and update `video/storyboard.json` with exact 60 FPS frame counts.

### Wave 2: Deterministic Terminal Capture (VHS) & Manim Mathematical Render
- [ ] **Task 2.1 [Agent: `builder-sonnet`]:** Write `video/captures/frankentty_live.tape` configured at `1920x1080`, font size `14`, capturing `frankentty --demo` while scripting timed `m`, `c`, and `i` keystrokes, and execute `vhs` to produce `video/captures/raw_terminal_60fps.mp4`.
- [ ] **Task 2.2 [Agent: `builder-sonnet`]:** Write `video/manim/subpixel_rle_scene.py` and invoke `manim-server` MCP at `1080p60` to render `video/manim/manim_subpixel_1080p60.mp4` illustrating `\u2580` vertical pixel pairing and RLE escape-code stripping.
- [ ] **Task 2.3 [Agent: `architect-opus`]:** Inspect both `raw_terminal_60fps.mp4` and `manim_subpixel_1080p60.mp4` via `ffprobe` to verify valid streams, 60 FPS framerate, and non-zero file size.

### Wave 3: Remotion Motion Graphics Studio & Scene Assembly
- [ ] **Task 3.1 [Agent: `builder-sonnet`]:** Scaffold the Remotion project in `video/remotion/` and build reusable UI primitives (`TerminalBezel.tsx`, `KeypressBadge.tsx`, `ThroughputGraph.tsx`).
- [ ] **Task 3.2 [Agent: `builder-sonnet`]:** Implement `Act1Hook.tsx`, `Act2ManimBridge.tsx`, `Act3LiveDemo.tsx`, and `Act4KiroShowcase.tsx` wired to the exact frame counts in `video/storyboard.json`.
- [ ] **Task 3.3 [Agent: `architect-opus`]:** Code-review all Remotion TSX components against `.kiro/steering/remotion.md` to ensure deterministic frame rendering and proper `<Audio>` / `<OffthreadVideo>` synchronization.

### Wave 4: Final Render, Audio Mastering & QA Verification
- [ ] **Task 4.1 [Agent: `builder-sonnet`]:** Render the master composition via `npx remotion render MasterSequence ../output/FrankenTTY_Raw.mp4 --codec h264` and use `ffmpeg-mcp` to apply `-af loudnorm=I=-14:TP=-1.5:LRA=11` audio normalization into `video/output/FrankenTTY_Demo_Final.mp4`.
- [ ] **Task 4.2 [Agent: `builder-sonnet`]:** *(Optional Timeline Export)* If DaVinci Resolve is open, run `davinci-resolve` MCP to import all stems and renders onto a labeled timeline for manual color/cut inspection.
- [ ] **Task 4.3 [Agent: `architect-opus`]:** Run final compliance verification on `video/output/FrankenTTY_Demo_Final.mp4` (confirming duration `< 180s`, `1920x1080`, `60fps`, valid AAC audio track, and zero copyrighted metadata) and log completion in `DEVPOST_WRITEUP.md`.