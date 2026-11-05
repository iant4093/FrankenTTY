# FrankenTTY: Implementation Plan

Status: approved decisions as of 2026-11-05. Builds on `docs/GAP_ANALYSIS.md`.
In Wave 1 the requirements here move into `.kiro/specs/frankentty/`, and this
file stays as the record of why.

Owner: Ian Truong. Repo: [iant4093/FrankenTTY](https://github.com/iant4093/FrankenTTY)
(public, empty). Style reference: [iant4093/TruongCam](https://github.com/iant4093/TruongCam).

---

## 1. Decisions

| ID | Decision |
|---|---|
| D1 | This Kiro Crew session (Opus 5.5) orchestrates and reviews. Builder tasks run on Sonnet 5.5 via `kiro-cli chat --v3 --agent builder-sonnet --no-interactive --trust-tools=fs_read,fs_write,shell "<task brief>"` (`--v3` is required for `.kiro/hooks` to fire; see `docs/EVIDENCE.md` S5), so the `.kiro/agents` configs and hooks are really used. A task is complete only after the orchestrator's review passes. |
| D2 | Primary terminal: Apple Terminal (macOS 26+). Target: wide support across macOS, Linux and Windows, using the tiers in section 2. |
| D3 | No live streams. Inputs are local files and http(s) URLs of finite media. |
| D4 | Left/Right seek is in: ±5 s, and Shift+Left/Right ±30 s where the terminal sends it. |
| D5 | Video tooling is deferred to Wave 6. The product plan has no dependency on it. |
| D6 | Repo layout, README format, scripts and CI/CD follow TruongCam. Distribution is one install command per OS. |
| D7 | Node.js + TypeScript. Zero runtime npm dependencies. FFmpeg is an external tool, not bundled. |
| D8 | `LICENSE` copyright line is "Ian Truong". Commits use your existing git identity (`iant4093`); git config is not changed. |

---

## 2. Cross-platform terminal support

### 2.1 How wide support works

Terminals differ in four ways that matter here. FrankenTTY detects each one at
startup, picks the best output it can, and lets a flag override every choice.

| Capability | Detection | Fallback |
|---|---|---|
| Color depth | `--color` flag, else Node's `stdout.getColorDepth()` (reads `COLORTERM`, `TERM`, `WT_SESSION`, `TERM_PROGRAM`, CI vars), plus one override: `TERM_PROGRAM=Apple_Terminal` on Darwin 25+ (macOS 26+) is 24-bit, because Apple Terminal supports it but sets no `COLORTERM` | 24-bit → 256 (`38;5;n`) → 16 (`30-37/90-97`) |
| Synchronized output | One startup probe: `CSI ?2026$p` (DECRQM) + `CSI 16 t` (cell size) + `CSI c` (DA1). Every terminal answers DA1, so its reply ends the wait. 200 ms cap. | Mode 2026 is still sent (terminals ignore unknown modes); HUD shows `sync off` |
| Cell aspect | `CSI 16 t` reply from the same probe | 2.0, or `--cell-aspect` |
| Glyphs | Unix: UTF-8 locale (`LC_ALL`/`LC_CTYPE`/`LANG`); `TERM=linux` (kernel console) has no Braille | Non-UTF-8 → ASCII mode only; no Braille → `m` skips Braille |

Resize uses `process.stdout.on('resize')`, which Node emits on all three OSes
(Windows has no SIGWINCH).

### 2.2 Support tiers

| Tier | Terminals | How it is verified |
|---|---|---|
| 1: hand-tested | Apple Terminal (macOS 26+); Windows Terminal 1.23+ (has DEC 2026) | Real use on your machines, every wave |
| 2: detected, CI-smoke | iTerm2, Ghostty, WezTerm, kitty, Alacritty, VS Code terminal, GNOME Terminal/VTE, Konsole, tmux 3.4+ | CI runs the binary headless on each OS; one manual pass in Wave 5 |
| 3: fallback | Older Apple Terminal (256), Windows conhost, Linux kernel console (16, ASCII), `screen` | Unit tests on capability detection; quality not promised |

### 2.3 Platform differences the code must handle

| Area | macOS / Linux | Windows |
|---|---|---|
| Quit keys | `q`, byte `0x03` in raw mode, SIGINT, SIGTERM, SIGHUP | `q`, `0x03`, SIGINT, SIGBREAK; console close |
| Child cleanup | Audio fed over stdin, so parent death closes it | Same stdin trick; no process groups, so track and kill each PID |
| Binaries | `ffmpeg`, `ffprobe`, `ffplay` on `PATH` | Same names with `.exe`; spawned without a shell; paths with spaces quoted by argv |
| PTY teardown test | Python `pty` helper | Not covered; manual check in Windows Terminal |

---

## 3. Distribution and one-command install

### 3.1 What users run

```bash
# macOS and Linux
curl -fsSL https://github.com/iant4093/FrankenTTY/releases/latest/download/install.sh | sh
```

```powershell
# Windows (PowerShell)
irm https://github.com/iant4093/FrankenTTY/releases/latest/download/install.ps1 | iex
```

Then `frankentty --demo`.

### 3.2 What the installer does

1. Detects OS and CPU (`darwin|linux|windows` × `x64|arm64`).
2. Downloads the matching archive and `SHA256SUMS` from the same release, and verifies the checksum. Stops on mismatch.
3. Installs one binary to `~/.local/bin` (macOS/Linux) or `%LOCALAPPDATA%\Programs\FrankenTTY` (Windows), and adds it to the user `PATH` if missing. No `sudo`.
4. Checks for `ffmpeg`, `ffprobe` and `ffplay`. If missing, prints the exact command (`brew install ffmpeg`, `sudo apt install ffmpeg`, `sudo dnf install ffmpeg`, `sudo pacman -S ffmpeg`, `winget install Gyan.FFmpeg`) and asks before running it, reading the answer from `/dev/tty` because `curl | sh` uses stdin. `--yes` skips the prompt.
5. Prints the uninstall line (delete one file).

The installer is served from the release, not `main`, so script and binaries
always match.

### 3.3 Release binaries

Built with Node's single executable application support (`node --build-sea`,
added in Node 25.5) on a pinned Node 26 LTS. Source is bundled to one file with
esbuild first.

| Asset | Runner |
|---|---|
| `frankentty-macos-arm64.tar.gz` | macOS arm64 |
| `frankentty-macos-x64.tar.gz` | macOS Intel |
| `frankentty-linux-x64.tar.gz` | Ubuntu x64 |
| `frankentty-linux-arm64.tar.gz` | Ubuntu arm64 |
| `frankentty-windows-x64.zip` | Windows x64 |
| `install.sh`, `install.ps1`, `SHA256SUMS` | — |

macOS binaries get an ad-hoc signature (`codesign --sign -`), which arm64 macOS
requires after SEA injection. Files fetched by `curl` carry no quarantine flag,
so Gatekeeper does not block them. Each binary is about 100 MB unpacked (it
contains Node); archives are smaller.

Risk: FFmpeg is not bundled, which avoids GPL redistribution duties and a
second 80 MB download. Users without a package manager must install FFmpeg by
hand.

---

## 4. CI/CD (`.github/workflows/ci.yml`)

Same shape as TruongCam: SHA-pinned actions, `permissions: contents: read` by
default, short artifact retention, Dependabot weekly for `github-actions` and
`npm`, and publishing only from `main`.

| Job | Runs on | Steps |
|---|---|---|
| `quality` | ubuntu | `scripts/check-workflows.sh` (actionlint, shellcheck, zizmor, Gitleaks); CodeQL for `actions` and `javascript-typescript` |
| `test` | ubuntu, macOS, Windows | `npm ci`; `tsc --noEmit`; ESLint; Vitest unit + PBT; FFmpeg probe/decoder integration tests on lavfi input; PTY teardown test on ubuntu and macOS |
| `build` | one macOS runner | esbuild bundle; official Node 26 (Homebrew Node has SEA disabled); `node --build-sea` once per target with `"executable"` set to that platform's checksum-verified official Node binary; ad-hoc sign macOS outputs; archive |
| `smoke` | 5 runners in 3.3 | download that OS's archive; `frankentty --version` and `frankentty --bench --demo --frames 60` |
| `install-test` | ubuntu, macOS, Windows | Run `install.sh` / `install.ps1` against the job's own artifacts (`FRANKENTTY_RELEASE_BASE=file://…`); run the installed binary |
| `release` | ubuntu, `main` only, after all jobs | Verify `SHA256SUMS`; build provenance attestation; skip if a newer commit is on `main`; publish `vX.Y.Z` as Latest with all assets; `npm publish --provenance` via trusted publishing (9.1) when the version is new |

Pull requests run everything except `release`.

---

## 5. Repository layout

TruongCam's shape, plus the hackathon files.

```text
.
├── src/                    CLI, ingest, audio, renderer, tui
├── tests/                  unit/, pbt/, integration/, pty/
├── scripts/                lint, test, build, bench, check-workflows, generate-demo-media, install.sh, install.ps1
├── docs/                   GAP_ANALYSIS, PLAN, EVIDENCE, HANDOFF, screenshots/
├── .kiro/                  agents, steering, hooks, specs, settings (always tracked)
├── .github/                ci.yml, dependabot.yml, actionlint.yaml
├── package.json            dev dependencies only
├── tsconfig.json
├── eslint.config.js
├── vitest.config.ts
├── LICENSE                 MIT, Ian Truong
├── DEVPOST_WRITEUP.md
└── README.md
```

`scripts/` follows TruongCam: each script `cd`s to the repo root, logs to
`build/logs/`, prints `PASS`/`FAIL` and `RESULT:`, and exits non-zero on
failure. Scripts are the single entry point for both CI and local use.

`.gitignore` adds `node_modules/`, `dist/`, `build/`, `assets/*.mp4`, `.env*`
(except `.env.example`) and `.DS_Store`. It never lists `.kiro`.

---

## 6. README outline (TruongCam format)

1. Centered header: logo (a FrankenTTY frame rendered in half-blocks), title, one-line pitch.
2. Link row: Install · Releases · Build status · Report an issue.
3. Large badge: "Install in one command", linking to the Install section.
4. Small badges: TypeScript, Node 26, macOS | Linux | Windows, runtime dependencies 0, CI, MIT, Kiroween 2026 Frankenstein.
5. `---`, then one intro paragraph.
6. Screenshots: 2×2 table (half-block, Braille, ASCII, amber palette with HUD), real captures from Apple Terminal, `.webp` in `docs/screenshots/`.
7. Features: **Playback**, **Rendering**, **Terminal support**.
8. Install: the two commands, FFmpeg note, uninstall.
9. Controls: key table.
10. Terminal support: tier table from 2.2.
11. How it works: pipeline diagram and the half-block idea. This also covers the Frankenstein category.
12. Tech stack table.
13. Build locally.
14. Tests.
15. CI and releases: numbered gates, as in TruongCam.
16. Built with Kiro: short summary, link to `DEVPOST_WRITEUP.md`.
17. Repository layout.
18. License.

All numbers in the README come from `frankentty --bench` output.

---

## 7. Changes to the gap analysis

- G-S7 (live streams): removed from scope.
- G-S6 (seek): accepted as REQ-SYNC-05: Left/Right seeks ±5 s; Shift+Left/Right ±30 s; clamped to `[0, duration]`; restarts decoder and audio with `-ss`; shows the time on the HUD for 1 s.
- G-R9 (truecolor detection): replaced by section 2.1, adding a 16-color tier.
- New REQ-PERF-01 (from Wave 0 Apple Terminal runs): adaptive quality governor. Steps: ΔE threshold up (2 levels) → 256-color → cap render cells. Steps back up after 3 s of headroom. `--quality max` turns it off. Color detection reads `COLORTERM` before `TERM_PROGRAM`, since Node reports 8-bit for Apple Terminal even when `COLORTERM=truecolor`.
- New REQ-PLAT-01: the same binary runs on macOS, Linux and Windows; quit, resize and teardown behave as in 2.3.
- New REQ-DIST-01: one-command install per OS as in section 3, with checksum check.
- New REQ-CI-01: CI gates as in section 4; `main` publishes only after all pass.
- Spike S4 (cell-size query) widens to a capability matrix across Apple Terminal, Windows Terminal and one Linux terminal.
- New spike S7: build and run one SEA hello-world on each OS in CI, and confirm `stdin.setRawMode` and the `resize` event work inside the SEA binary on Windows.

---

## 8. Revised waves

| Wave | Dates | Goal | Exit check |
|---|---|---|---|
| 0 Feasibility | Nov 6-7 | Spikes S1-S7 | Results in `docs/EVIDENCE.md`; go/no-go per risk |
| 1 Governance + scaffold | Nov 8-10 | `git init`, push to the empty repo, LICENSE, `.gitignore`, `.kiro/`, specs, `package.json`, scripts, CI (`quality` + `test`), CLI parser, ScreenManager, capability detection, geometry + P1 | Apple Terminal: `q` and Ctrl+C restore cleanly; CI green on 3 OSes |
| 2 Ingest + first playback | Nov 11-13 | probe, decoder, frame assembler + P4, naive half-block `--demo` | Demo plays in Apple Terminal and Windows Terminal |
| 3 Compression + modes | Nov 14-18 | screen model, RLE, delta, Braille, ASCII, palettes, 256/16 fallbacks, test VT parser, P2a-d, P3, P6, `--bench` | Bench numbers recorded |
| 4 Sync + TUI | Nov 19-22 | audio, clock, pause, seek, HUD, input + P5, resize restart | 10-min file: resize, pause, seek, no visible drift |
| 4b Distribution | Nov 23-24 | `build`, `install-test`, `release` jobs; installers | Fresh install on macOS and Windows from a real release |
| 5 Hardening + docs | Nov 25-26 | PTY teardown test, Tier 2 pass, README, DEVPOST draft | Feature freeze |
| 6 Video | Nov 27-Dec 1 | Pick video tools then | Under 3 min |
| Buffer | Dec 2-3 | Fixes, submit | Submitted |

---

## 8.1 Who tests what

KiroCrew refuses to drive terminal apps (computer use and `open -a Terminal`
are both blocked, by design). So testing splits in two:

| Layer | Run by | How |
|---|---|---|
| Keys, resize, teardown, screen contents, DEC 2026, fps | Agent, every task | App runs in a PTY the agent owns; output feeds `@xterm/headless` 6.0 (a real emulator core); tests read its cell grid |
| Look and feel in Apple Terminal / Windows Terminal | Ian, once per wave | Type one command (`npm run handtest`); the run writes a JSON result the agent reads |

## 9. Resolved 2026-11-05

| ID | Answer |
|---|---|
| O1 | Windows PC: yes, so Windows Terminal stays Tier 1. No Linux machine. Linux program behavior is hand-tested with `docker run -it` from Apple Terminal (Docker is installed), which runs the Linux binary and Linux FFmpeg; Linux terminal emulators stay Tier 2 (CI). |
| O2 | Publish to npm: yes. Package name `frankentty` is free as of today. See 9.1. |
| O3 | Node upgrade to 26.13.0 LTS is blocked: `brew upgrade node` stops because the Command Line Tools do not support macOS 27. Needs a CLT update for Xcode 27 (your password). Not blocking until Wave 4b. A stray Node 20.10 at `/usr/local/bin/node` is shadowed by Homebrew and unused. |

### 9.1 npm publishing

- An npm account is free, and public packages are free. 2FA is required to publish.
- Release job publishes with npm trusted publishing (GitHub OIDC), so no `NPM_TOKEN` secret is stored. Publish runs with `--provenance`.
- Trusted publishing is set per package on npmjs.com, so the first `0.1.0` is published once by hand (`npm login`, `npm publish`), then the trusted publisher is linked to `iant4093/FrankenTTY` / `ci.yml`.
- The npm package needs Node 24+ and FFmpeg on `PATH`; it ships the bundled JS, not the SEA binaries.
- Release versions use semver (`0.1.0`, …) for npm, and the GitHub release tag matches (`v0.1.0`), replacing TruongCam's `build-N` tags.

Install line added to section 3.1:

```bash
npm install -g frankentty    # or: npx frankentty --demo
```
