---
inclusion: always
---

# Agent roles and handoff

| Agent | Model | Owns |
|---|---|---|
| `architect-opus` | `claude-opus-5.5` | `.kiro/`, `docs/`, `README.md`, `DEVPOST_WRITEUP.md`, `.github/`, `package.json`, git |
| `builder-sonnet` | `claude-sonnet-5.5` | `src/`, `tests/`, `scripts/`, `assets/` |

## Handoff protocol

1. architect-opus writes a task brief with: task ID from `tasks.md`, goal,
   requirement IDs, files allowed, tests and properties required (with
   `numRuns`), and a stop condition.
2. architect-opus dispatches it:
   `kiro-cli chat --v3 --agent builder-sonnet --no-interactive --trust-tools=fs_read,fs_write,shell,execute_bash,grep,glob "<brief>"`.
   `--v3` is required: the default engine does not run `.kiro/hooks`.
3. builder-sonnet implements only the brief. Hooks run tests after each
   write and gate the end of the turn on a green suite.
4. builder-sonnet ends with a report: files, tests, commands and results,
   deviations, open questions.
5. architect-opus reviews: reads the diff, reruns typecheck, lint and tests,
   checks hot-loop allocation, teardown paths, buffer bounds and EARS
   compliance. Findings go to `docs/EVIDENCE.md`.
6. Pass: architect-opus marks the task `[x]` in `tasks.md` and commits.
   Fail: architect-opus sends a follow-up brief naming each finding.

## Rules for both

- No new runtime dependency without a decision recorded in `docs/PLAN.md`.
- builder-sonnet never commits, pushes or edits files it does not own. If a
  brief needs such a change, it says so in its report.
- A task is not done because the builder says so. It is done when the review
  passes.
