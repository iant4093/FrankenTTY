# Project Specification: FrankenTTY

## 1. Executive Summary & Hackathon Context

- **Project Name:** FrankenTTY: Streaming Video Over VT100
- **Hackathon Category:** Frankenstein (*Stitching modern high-throughput video pipelines into a legacy VT100 text protocol*)
- **License:** MIT License (placed at `/LICENSE` in repository root for GitHub About-section detection)
- **Elevator Pitch:** Welding modern high-throughput video codecs to a 50-year-old teletype text protocol, streaming smooth 30 FPS video entirely through ANSI escape codes.
- **Core Objective:** Build a high-performance CLI media player that ingests video files or live streams, decodes video and audio in real time, converts frames into 24-bit TrueColor Unicode half-block characters (`▀`), applies run-length and inter-frame delta compression, and flushes synchronized video frames to standard terminal `stdout`.

---

## 2. Multi-Agent Architecture (Kiro Custom Agents & Crew)

Development is strictly partitioned across a two-agent architecture defined in `.kiro/agents/` and governed by `.kiro/steering/agent-roles.md`:

### 2.1 Agent 1: `architect-opus` (Claude Opus 5.5)

- **Model:** `claude-opus-5-5`
- **Role:** Orchestrator, Systems Researcher, Code Reviewer, & Lead Documentor
- **Responsibilities:**
  1. **Orchestration & Spec Management:** Owns `.kiro/specs/` (`requirements.md`, `design.md`, `tasks.md`) and `.kiro/steering/`. Breaks down architectural problems and dispatches bounded implementation tasks to `builder-sonnet`.
  2. **Deep Research:** Researches VT100/xterm control sequences, DEC synchronized output (`\x1b[?2026h`), perceptual color distance formulas, and FFmpeg low-latency pipe flags.
  3. **Code & Spec Review:** Reviews every module and test suite written by `builder-sonnet` for memory leaks, hot-loop allocations, terminal teardown safety, and strict EARS requirement compliance before marking tasks complete.
  4. **Submission Documentation:** Authors and maintains `README.md`, `DEVPOST_WRITEUP.md`, `LICENSE`, and inline architectural documentation.

### 2.2 Agent 2: `builder-sonnet` (Claude Sonnet 5.5)

- **Model:** `claude-sonnet-5-5`
- **Role:** Core Implementation & Testing Engineer
- **Responsibilities:**
  1. **Feature Implementation:** Executes Waves 1–5 coding tasks inside `src/` (terminal raw-mode lifecycle, FFmpeg binary pipe ingestion, ANSI half-block/ASCII/Braille serializers, RLE/delta compression, A/V sync clock, and TUI HUD).
  2. **Automated Testing & PBT:** Implements unit tests and **Property-Based Tests (PBT)** validating aspect-ratio geometry, ANSI escape sequence invariants, and color filter bounds.
  3. **Tooling & Asset Scripts:** Builds the royalty-free procedural test media generator (`scripts/generate-demo-media.sh`) so judges can run the project immediately with zero copyrighted assets.

---

## 3. Repository Structure & Kiro Directory Layout (`structure.md`)

> **CRITICAL HACKATHON RULE:** The `/.kiro` directory and all of its subdirectories MUST be tracked in Git and pushed to the public GitHub repository. NEVER add `.kiro` or `.kiro/*` to `.gitignore`.

```text
frankentty/
├── LICENSE                          # MIT License (root level for GitHub detection)
├── README.md                        # Judge-ready documentation & quickstart (by Opus 5.5)
├── DEVPOST_WRITEUP.md               # Complete Kiro usage write-up for Devpost (by Opus 5.5)
├── .gitignore                       # Ignores node_modules/target, NEVER ignores /.kiro
├── .kiro/
│   ├── agents/
│   │   ├── architect-opus.json      # Claude Opus 5.5 agent config (Orchestrator/Reviewer/Docs)
│   │   └── builder-sonnet.json      # Claude Sonnet 5.5 agent config (Implementation/PBT)
│   ├── steering/
│   │   ├── product.md               # Project vision, hackathon compliance rules, UX goals
│   │   ├── tech.md                  # Stack choices, ANSI escape standards, zero-alloc rules
│   │   ├── structure.md             # Directory layout and module boundaries
│   │   └── agent-roles.md           # Handoff protocol between Opus 5.5 and Sonnet 5.5
│   ├── hooks/
│   │   ├── review-and-pbt.json      # On save in src/**: runs PBT suite + Opus 5.5 code review
│   │   ├── sync-docs.json           # On tasks.md update: Opus 5.5 updates README & DEVPOST_WRITEUP
│   │   └── compliance-guard.json    # Pre-commit check: verifies /.kiro is tracked & LICENSE exists
│   ├── specs/
│   │   └── frankentty/
│   │       ├── requirements.md      # EARS-formatted functional & compliance requirements
│   │       ├── design.md            # Pipeline architecture, buffers, and PBT invariants
│   │       └── tasks.md             # Wave-based implementation plan with agent assignments
│   └── settings/
│       └── mcp.json                 # MCP server config (filesystem, git, media/shell inspector)
├── src/
│   ├── main.ts                      # CLI entry point, arg parser, signal trapping
│   ├── ingest/
│   │   ├── probe.ts                 # ffprobe metadata extractor (width, height, fps, audio)
│   │   └── decoder.ts               # Spawns ffmpeg pipe for scaled raw RGB24 frames
│   ├── audio/
│   │   └── clock.ts                 # Audio playback subprocess & master A/V monotonic clock
│   ├── renderer/
│   │   ├── geometry.ts              # Aspect-ratio calculator & letterbox/pillarbox math
│   │   ├── ansi.ts                  # Half-block (▀), ASCII density, & 2x4 Braille serializers
│   │   ├── palette.ts               # Retro CRT filters (TrueColor, Amber VT100, Green CRT, DMG)
│   │   └── differ.ts                # Run-Length Encoding (RLE) & inter-frame delta compression
│   └── tui/
│       ├── screen.ts                # Alternate screen buffer, cursor state, SIGWINCH listener
│       ├── hud.ts                   # Telemetry overlay (FPS, KB/s throughput, RLE savings %)
│       └── input.ts                 # Raw keypress router (Space, m, c, i, Left/Right, q)
├── tests/
│   ├── pbt/
│   │   ├── geometry.pbt.test.ts     # Property-based tests for aspect ratio & bounds
│   │   ├── serializer.pbt.test.ts   # Property-based tests for ANSI RLE/Delta invariants
│   │   └── palette.pbt.test.ts      # Property-based tests for CRT color transformations
│   └── unit/
└── scripts/
    └── generate-demo-media.sh       # Generates 100% copyright-free test video via ffmpeg lavfi
```

---

## 4. Requirements Specification (requirements.md — EARS Notation)

### 4.1 Hackathon Compliance & Repository Governance

- REQ-COMP-01: THE SYSTEM repository SHALL include /.kiro/specs, /.kiro/hooks, /.kiro/steering, and /.kiro/agents tracked in Git, and .gitignore SHALL NOT exclude /.kiro or any of its subdirectories.
- REQ-COMP-02: THE SYSTEM repository SHALL contain a standard open-source MIT LICENSE file at /LICENSE detectable by GitHub's license parser.
- REQ-COMP-03: WHEN generating sample test media, THE SYSTEM SHALL synthesize procedural audio/video (ffmpeg -f lavfi) containing zero third-party trademarks or copyrighted material.
- REQ-COMP-04: THE SYSTEM repository SHALL include a comprehensive README.md and DEVPOST_WRITEUP.md authored by architect-opus detailing project features, setup instructions, and how Kiro IDE/CLI, Custom Agents, Hooks, Specs, Steering, MCP, PBT, and Powers were utilized.

### 4.2 Terminal Lifecycle & Safety

- REQ-TERM-01: WHEN the application starts, THE SYSTEM SHALL switch to the alternate screen buffer (\x1b[?1049h), hide the cursor (\x1b[?25l), and enable raw stdin mode.
- REQ-TERM-02: WHEN the terminal emits SIGWINCH, THE SYSTEM SHALL recalculate target canvas geometry (cols × (rows - hud_height) * 2) while preserving source aspect ratio.
- REQ-TERM-03: WHEN the user presses q, Ctrl+C, or an unhandled error occurs, THE SYSTEM SHALL restore the main screen buffer (\x1b[?1049l), show the cursor (\x1b[?25h), reset styles (\x1b[0m), and cleanly kill child ffmpeg/audio processes.

### 4.3 Media Ingestion & Decoding

- REQ-INGEST-01: WHEN passed a video file path, URL, or --demo flag, THE SYSTEM SHALL probe stream metadata (width, height, fps, duration, hasAudio) via ffprobe.
- REQ-INGEST-02: WHEN playback begins, THE SYSTEM SHALL stream raw rgb24 frames scaled to the active terminal pixel matrix (W * H * 3 bytes per frame) over a buffered binary pipe.

### 4.4 Half-Block ANSI Serialization & Compression

- REQ-RENDER-01: WHEN in halfblock mode, THE SYSTEM SHALL pair vertical pixels (x, 2y) and (x, 2y + 1) into a single cell using ▀ (\u2580), assigning foreground \x1b[38;2;R1;G1;B1m to the top pixel and background \x1b[48;2;R2;G2;B2m to the bottom pixel.
- REQ-RENDER-02: WHEN horizontally adjacent cells share identical foreground or background RGB values within threshold $\Delta E$, THE SYSTEM SHALL omit duplicate ANSI escape codes (Run-Length Color Compression).
- REQ-RENDER-03: WHEN a cell's top and bottom pixels are identical within threshold $\Delta E$, THE SYSTEM SHALL emit a space character ' ' with only a background color update to save foreground escape bytes.
- REQ-RENDER-04: WHEN flushing a completed frame buffer, THE SYSTEM SHALL wrap the payload in DEC synchronized update markers (\x1b[?2026h ... \x1b[?2026l) and perform a single atomic stdout.write() call.

### 4.5 Audio-Video Sync & Interactive Controls

- REQ-SYNC-01: WHILE audio playback is active, THE SYSTEM SHALL pace video frames against the monotonic audio presentation clock, sleeping when ahead and dropping frame serialization when lagging by more than one frame interval.
- REQ-UI-01: WHEN the user presses Space, m, c, or i, THE SYSTEM SHALL respectively toggle Pause/Resume, Render Mode (Half-Block $\rightarrow$ ASCII Density $\rightarrow$ 2x4 Braille), CRT Color Palette (TrueColor $\rightarrow$ Amber VT100 $\rightarrow$ Green Phosphor $\rightarrow$ 4-Color DMG), and the live Telemetry HUD.

---

## 5. Property-Based Testing (PBT) Specification (design.md)

To satisfy the hackathon's Property-Based Testing criteria and verify low-level buffer math, builder-sonnet shall implement PBT suites (fast-check or proptest) verified by architect-opus:

1. Property 1 — Aspect-Ratio Geometry Containment (geometry.pbt.test.ts):
   - For all source dimensions $W_{src}, H_{src} \in [1, 7680]$ and terminal dimensions $Cols \in [20, 500], Rows \in [10, 200]$:
   - renderCols <= Cols, renderRows <= Rows - hudHeight, offsetX >= 0, offsetY >= 0, and pixelHeight === renderRows * 2.
2. Property 2 — RLE Compression Non-Expansion & ANSI Safety (serializer.pbt.test.ts):
   - For all generated Uint8Array RGB24 buffers of size $W \times 2H \times 3$:
   - The RLE-compressed ANSI frame string is valid UTF-8, starts with \x1b[?2026h, ends with \x1b[0m\x1b[?2026l, and its byte length is strictly less than or equal to the naive uncompressed ANSI output.
3. Property 3 — Palette Filter Closure & Idempotence (palette.pbt.test.ts):
   - For all RGB triplets $(r, g, b) \in [0, 255]^3$ and any selected palette mode:
   - Output channels $(r', g', b')$ are integers in $[0, 255]$, and applying a monochrome phosphor palette twice yields the exact same triplet as applying it once.

---

## 6. Kiro Hooks Configuration (.kiro/hooks/)

1. review-and-pbt.json (Trigger: On File Save in src/**):
   - Automatically runs the unit + Property-Based Testing suite and invokes architect-opus to inspect the diff for hot-loop allocations, buffer overflows, and adherence to .kiro/specs/frankentty/requirements.md.
2. sync-docs.json (Trigger: On Change to tasks.md or src/main.ts):
   - Invokes architect-opus to synchronize CLI flags, architecture diagrams, and benchmark metrics inside README.md and DEVPOST_WRITEUP.md.
3. compliance-guard.json (Trigger: Pre-Commit / Manual Validation):
   - Checks that .gitignore does NOT ignore .kiro/, verifies /LICENSE exists at the repo root, and ensures all test suites pass.

---

## 7. Implementation Plan & Agent Task Assignment (tasks.md)

### Wave 1: Governance, Scaffolding & Multi-Agent Setup

- [ ] Task 1.1 [Agent: architect-opus]: Initialize .kiro/steering/ (product.md, tech.md, structure.md, agent-roles.md), .kiro/agents/ (architect-opus.json, builder-sonnet.json), .kiro/hooks/, /LICENSE (MIT), and .gitignore (explicitly keeping /.kiro tracked).
- [ ] Task 1.2 [Agent: builder-sonnet]: Scaffold project runtime, CLI parser (frankentty <input|--demo>), and ScreenManager with safe alternate buffer entry/exit and signal trapping (SIGINT, SIGTERM, SIGWINCH).
- [ ] Task 1.3 [Agent: builder-sonnet]: Implement geometry.ts aspect-ratio calculator and write Property-Based Test suite geometry.pbt.test.ts.
- [ ] Task 1.4 [Agent: architect-opus]: Review Wave 1 code and verify PBT coverage.

### Wave 2: FFmpeg RGB24 Ingestion & Royalty-Free Demo Generator

- [ ] Task 2.1 [Agent: builder-sonnet]: Build scripts/generate-demo-media.sh (and --demo auto-generator) using ffmpeg -f lavfi (testsrc2 + procedural synth audio) to create a copyright-safe assets/demo.mp4.
- [ ] Task 2.2 [Agent: builder-sonnet]: Implement probe.ts (ffprobe JSON wrapper) and decoder.ts (ffmpeg raw rgb24 frame pipe with exact $W \times H \times 3$ ring-buffer chunking).
- [ ] Task 2.3 [Agent: architect-opus]: Review subprocess cleanup and backpressure handling in decoder.ts.

### Wave 3: 24-Bit Half-Block Engine, Multi-Mode Renderers & PBT

- [ ] Task 3.1 [Agent: builder-sonnet]: Implement ansi.ts supporting Half-Block (▀), ASCII Density, and 2x4 Unicode Braille rendering modes wrapped in DEC synchronized output markers (\x1b[?2026h).
- [ ] Task 3.2 [Agent: builder-sonnet]: Implement differ.ts (Run-Length Color Compression + solid space optimization + inter-frame delta skip) and palette.ts (TrueColor, Amber VT100, Green CRT, 4-Color DMG).
- [ ] Task 3.3 [Agent: builder-sonnet]: Implement Property-Based Tests in serializer.pbt.test.ts and palette.pbt.test.ts.
- [ ] Task 3.4 [Agent: architect-opus]: Review ANSI serializer performance and validate PBT invariants.

### Wave 4: Master Audio Clock & Interactive TUI HUD

- [ ] Task 4.1 [Agent: builder-sonnet]: Implement clock.ts master A/V synchronization loop (frame sleep vs. frame drop) and audio output subprocess.
- [ ] Task 4.2 [Agent: builder-sonnet]: Implement hud.ts telemetry bar (FPS, KB/s TTY throughput, RLE compression savings %, progress scrubber) and input.ts live hotkeys (Space, m, c, i, q).
- [ ] Task 4.3 [Agent: architect-opus]: Conduct full end-to-end integration review and verify zero terminal state corruption on exit.

### Wave 5: Judge-Ready Documentation & Devpost Write-Up (Text Deliverables)

- [ ] Task 5.1 [Agent: architect-opus]: Generate production README.md containing project overview, Frankenstein category justification, architecture diagram, 60-second quickstart, interactive controls table, and license badge.
- [ ] Task 5.2 [Agent: architect-opus]: Generate DEVPOST_WRITEUP.md containing the complete, structured submission text answering every hackathon judging prompt:
  1. Project Features & Functionality Description (ready to paste into Devpost).
  2. Kiro IDE, CLI, & Crew Workflow: How multi-surface Kiro features accelerated the build.
  3. Custom Agents (architect-opus on Opus 5.5 + builder-sonnet on Sonnet 5.5): How separating orchestration/review/docs from implementation prevented context drift.
  4. Agent Hooks: How review-and-pbt, sync-docs, and compliance-guard automated quality and submission readiness.
  5. Spec-Driven Development vs. Vibe Coding: Concrete examples of how EARS requirements and design.md prevented binary stream framing and ANSI escape bugs.
  6. Steering Docs: How .kiro/steering/ enforced zero-allocation hot loops and strict VT100 escape discipline.
  7. MCP & Kiro Powers: How MCP tooling and Powers enabled autonomous stream inspection and terminal benchmarking.
  8. Property-Based Testing (PBT): Specific edge cases caught by PBT across aspect-ratio scaling and RLE ANSI serialization.