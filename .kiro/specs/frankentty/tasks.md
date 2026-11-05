# Tasks: FrankenTTY

Status keys: `[ ]` open, `[~]` in progress, `[x]` done (review passed).
Dates and wave exit checks: `docs/PLAN.md` section 8. Evidence for every
done task: `docs/EVIDENCE.md`.

## Wave 0: Feasibility (Nov 6-7)

- [x] 0.1 [architect-opus] Spikes S1, S3, S4 (Apple Terminal), S5, S6 (decision), S7. Results in EVIDENCE.
- [ ] 0.2 [Ian] S4 in Windows Terminal (`wave0-windows-x64.exe` and `sweep`). Needed by end of Wave 2.

## Wave 1: Governance + scaffold (Nov 8-10)

- [x] 1.1 [architect-opus] Git, LICENSE, `.gitignore`, `.kiro/` (agents, steering, hooks, specs), toolchain (`package.json`, `tsconfig.json`, ESLint, Vitest), hook scripts.
- [x] 1.2 [builder-sonnet] `src/main.ts`, `src/cli/args.ts`, `src/term/screen.ts`, `src/term/capabilities.ts`, `src/renderer/sequences.ts`, with unit tests, P7, and a PTY + `@xterm/headless` teardown test. (REQ-CLI-01/02, REQ-TTY-01, REQ-PREREQ-01, REQ-TERM-01/03, REQ-CAP-01/02/03)
- [x] 1.3 [builder-sonnet] `src/renderer/geometry.ts` and P1. (REQ-GEO-01/02, REQ-TERM-02 math)
- [x] 1.4 [architect-opus] Review 1.2 (+1.2b) and 1.3 done; `scripts/` (lint, test, check-workflows) and CI `quality` + `test` jobs on 3 OSes; README skeleton; first PR.
- [x] 1.5 [Ian] Hand check in Apple Terminal: `npm run dev -- --help`, and `q` / Ctrl+C restore the terminal.

## Wave 2: Ingest + first playback (Nov 11-13)

- [x] 2.1 [builder-sonnet] `scripts/generate-demo-media.sh` and lavfi `--demo` sources. (REQ-COMP-03, REQ-INGEST-03)
- [x] 2.2 [builder-sonnet] `probe.ts`, `decoder.ts`, `assembler.ts` + P4. (REQ-INGEST-01/02/04/05/06)
- [x] 2.3 [builder-sonnet] Naive half-block render loop on the wall clock. (REQ-RENDER-01/04, REQ-SYNC-02)
- [x] 2.4 [architect-opus] Review child process cleanup and backpressure.
- [ ] 2.5 [Ian] Demo plays in Apple Terminal and Windows Terminal.

## Wave 3: Compression + modes (Nov 14-18)

- [x] 3.1 [builder-sonnet] Preallocated serializer, screen model, RLE, solid-space, delta, threshold + P2a-d. (REQ-RENDER-02/03/05/07)
- [x] 3.2 [builder-sonnet] `downsample.ts`, Braille, ASCII + P6. (REQ-RENDER-06)
- [x] 3.3 [builder-sonnet] `palette.ts`, 256/16 mapping + P3. (REQ-PAL-01, REQ-RENDER-08)
- [~] 3.4 [builder-sonnet] `--bench`. (REQ-BENCH-01)
- [ ] 3.5 [architect-opus] Review; record bench numbers in EVIDENCE; project Power `powers/vt100-video/` and MCP config.

## Wave 4: Sync + TUI (Nov 19-22)

- [ ] 4.1 [builder-sonnet] Audio player, clock, pause, seek. (REQ-SYNC-01..05)
- [ ] 4.2 [builder-sonnet] Input router + P5, HUD, resize restart. (REQ-UI-01/02, REQ-HUD-01, REQ-TERM-02)
- [ ] 4.3 [builder-sonnet] Quality governor. (REQ-PERF-01)
- [ ] 4.4 [architect-opus] End-to-end review; zero terminal corruption on every exit path.

## Wave 4b: Distribution (Nov 23-24)

- [ ] 4b.1 [architect-opus] CI `build`, `smoke`, `install-test`, `release` jobs; npm trusted publishing. (REQ-DIST-01, REQ-CI-01)
- [ ] 4b.2 [builder-sonnet] `scripts/install.sh`, `scripts/install.ps1`.
- [ ] 4b.3 [Ian] First npm publish by hand; link trusted publisher.

## Wave 5: Hardening + docs (Nov 25-26)

- [ ] 5.1 [architect-opus] Tier 2 terminal pass; README final; DEVPOST_WRITEUP draft.

## Wave 6: Video (Nov 27-Dec 1)

- [ ] 6.1 Pick video tools; `.kiro/specs/video-demo/`.
