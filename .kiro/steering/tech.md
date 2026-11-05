---
inclusion: always
---

# Tech rules

## Stack

- Node.js 24+ (development on 26 LTS), TypeScript 6.0 in strict mode,
  ES modules. Source runs directly with Node type stripping, so use only
  erasable TypeScript (no `enum`, no `namespace`, no parameter properties).
  Import local files with the `.ts` extension.
- **Zero runtime npm dependencies.** Only `node:` built-ins. Dev tools:
  Vitest, fast-check, ESLint, esbuild, `@xterm/headless`.
- FFmpeg (`ffmpeg`, `ffprobe`, `ffplay`) is an external tool on `PATH`. Spawn
  it with `child_process.spawn` and an argv array. Never use a shell, never
  build a command string from user input.

## Hot-loop rules (render path, per frame)

- No allocation per cell or per row. Allocate buffers once per geometry and
  reuse them. A geometry change may reallocate.
- The serializer writes bytes into a preallocated `Buffer` with a cursor.
  Decimal numbers 0..255 come from a precomputed byte table. No template
  strings, `join`, `concat` or `Buffer.from` per frame.
- One `stdout.write()` per frame, of a `subarray` of that buffer.
- Pixel data stays in `Uint8Array`s. Pack colors as 24-bit integers for
  comparisons.

## Escape sequence discipline

- Write sequences from named constants in one module (`src/renderer/sequences.ts`
  or similar). No raw `\x1b` literals scattered in other modules.
- Startup: alt screen `CSI ?1049h`, hide cursor `CSI ?25l`, autowrap off
  `CSI ?7l`, raw stdin.
- Every frame: `CSI ?2026h` ... `CSI 0m CSI ?2026l`. Terminals without mode
  2026 ignore it (Apple Terminal does).
- Restore, in this order: `CSI ?2026l`, `CSI 0m`, `CSI ?7h`, `CSI ?25h`,
  `CSI ?1049l`, then `setRawMode(false)`. Restore is idempotent and runs on
  `q`, byte `0x03`, SIGINT, SIGTERM, SIGHUP, SIGBREAK (Windows),
  `uncaughtException`, `unhandledRejection` and `exit`.
- Color depth detection reads `COLORTERM` (`truecolor`/`24bit`) **before**
  anything else. Node's `getColorDepth()` reports 8 for Apple Terminal even
  when `COLORTERM=truecolor` (measured 2026-11-05).

## Measured limits (docs/EVIDENCE.md, Wave 0)

- Apple Terminal accepts about 2-21 MB/s. Its cost is the number of SGR
  (color) sequences, not bytes. Minimize SGRs first.
- Worst-case 24-bit content holds 30 fps up to about 4,200 cells in Apple
  Terminal. Larger windows need the quality governor.
- Homebrew's Node has SEA disabled. Release builds use official Node binaries.

## Cross-platform

- Use `process.stdout.on('resize')`, not SIGWINCH (Windows has none).
- Child processes: keep every PID; kill all on exit. Feed audio to `ffplay`
  over stdin so it exits if FrankenTTY dies.
- Paths: `node:path`, never string concatenation with `/`.

## Testing

- Vitest for unit tests in `tests/unit/`, property tests in `tests/pbt/`
  (`*.pbt.test.ts`), integration in `tests/integration/`.
- fast-check `numRuns` is set explicitly per property (see design.md).
- Terminal behavior is tested by running code in a PTY and feeding output to
  `@xterm/headless`, then reading its cell buffer. Do not mock the terminal
  when a real emulator core can answer.
