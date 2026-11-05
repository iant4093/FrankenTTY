<div align="center">

# FrankenTTY

Streaming 30 FPS true-color video through 50-year-old VT100 escape codes, right in your terminal.

[Install](#install) · [Releases](https://github.com/iant4093/FrankenTTY/releases) · [Build status](https://github.com/iant4093/FrankenTTY/actions) · [Report an issue](https://github.com/iant4093/FrankenTTY/issues)

![TypeScript](https://img.shields.io/badge/TypeScript-6-3178C6?logo=typescript&logoColor=white)
![Node](https://img.shields.io/badge/Node-24%2B-5FA04E?logo=nodedotjs&logoColor=white)
![Platforms](https://img.shields.io/badge/macOS_|_Linux_|_Windows-supported-000000)
![Dependencies](https://img.shields.io/badge/runtime_dependencies-0-34C759)
[![CI](https://github.com/iant4093/FrankenTTY/actions/workflows/ci.yml/badge.svg)](https://github.com/iant4093/FrankenTTY/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Kiroween 2026](https://img.shields.io/badge/Kiroween_2026-Frankenstein-7B2FBE)

</div>

---

> **Status:** in development for Kiroween 2026. Install commands go live with the first release.

FrankenTTY decodes video with FFmpeg and draws it with nothing but text. Each terminal cell holds two pixels: the upper half block `▀` takes the top pixel as its foreground color and the bottom pixel as its background color. A serializer strips repeated color codes and unchanged cells so the terminal can keep up, and an adaptive quality governor trades color precision for frame rate when it can't.

## Features

**Playback**

- Local video files and finite http(s) URLs, decoded by FFmpeg
- Audio through `ffplay`, with video paced to the audio clock
- Pause, seek ±5 s and ±30 s, loop
- `--demo` plays procedural FFmpeg sources, so no media file is needed

**Rendering**

- 24-bit half-block, luminance ASCII and 2×4 Braille modes
- TrueColor, Amber VT100, Green phosphor and 4-color DMG palettes
- Run-length color compression, solid-cell collapsing and inter-frame deltas
- Live HUD with fps, throughput and compression savings

**Terminal support**

- Detects color depth, synchronized output and cell shape at startup
- Steps down from 24-bit to 256 to 16 colors when needed
- Restores the terminal on every exit path

## Install

Coming with the first release:

```bash
# macOS and Linux
curl -fsSL https://github.com/iant4093/FrankenTTY/releases/latest/download/install.sh | sh
```

```powershell
# Windows (PowerShell)
irm https://github.com/iant4093/FrankenTTY/releases/latest/download/install.ps1 | iex
```

```bash
# Any OS with Node 24+
npx frankentty --demo
```

FrankenTTY needs FFmpeg (`ffmpeg`, `ffprobe`, and `ffplay` for audio) on your `PATH`.

## Controls

| Key | Action |
|---|---|
| `Space` | Pause / resume |
| `←` / `→` | Seek −5 s / +5 s |
| `Shift` + `←` / `→` | Seek −30 s / +30 s |
| `m` | Mode: half-block → ASCII → Braille |
| `c` | Palette: TrueColor → Amber → Green → DMG |
| `i` | Toggle HUD |
| `q` / `Ctrl+C` | Quit |

## Terminal support

| Tier | Terminals |
|---|---|
| 1 · hand-tested | Apple Terminal (macOS 26+), Windows Terminal 1.23+ |
| 2 · CI and one manual pass | iTerm2, Ghostty, WezTerm, kitty, Alacritty, VS Code, GNOME Terminal, Konsole, tmux 3.4+ |
| 3 · fallback | Older Apple Terminal (256 colors), Windows conhost, Linux console (16 colors, ASCII) |

## Build locally

Requires Node 24+ (26 LTS recommended) and FFmpeg.

```bash
npm ci
npm run dev -- --demo
```

## Tests

```bash
# Typecheck, lint, unit, property-based and PTY tests
bash scripts/test.sh
```

Terminal behavior is tested by running FrankenTTY in a pseudo-terminal and feeding its output to a real terminal emulator core (`@xterm/headless`).

## CI and releases

Pull requests and pushes to `main` run:

1. Hackathon compliance check, actionlint, shellcheck, zizmor and Gitleaks.
2. CodeQL for workflows and TypeScript.
3. Typecheck, ESLint, and the full test suite on macOS, Linux and Windows.

GitHub Actions are pinned to commit SHAs and Dependabot checks them weekly.

## Built with Kiro

FrankenTTY is built with a two-agent Kiro crew: `architect-opus` (Claude Opus 5.5) writes the specs, steering and briefs and reviews every change; `builder-sonnet` (Claude Sonnet 5.5) implements each brief with unit and property-based tests. Hooks run tests after every write and block a turn until the suite is green. See [`.kiro/`](.kiro) and `DEVPOST_WRITEUP.md`.

## Repository layout

```text
.
├── src/          CLI, ingest, audio, renderer, terminal and TUI modules
├── tests/        Unit, property-based, integration and PTY tests
├── scripts/      Test, lint, workflow checks and Kiro hook scripts
├── docs/         Plan, gap analysis, evidence log and task briefs
├── spikes/       Throwaway feasibility experiments
├── .kiro/        Agents, steering, hooks and specs
├── .github/      CI workflow and Dependabot
└── README.md
```

## License

[MIT](LICENSE) © Ian Truong
