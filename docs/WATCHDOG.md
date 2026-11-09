# Reliability watchdog

A scheduled regression check that runs inside Pandesh's own scheduler and reports only what changed.

## What a run does

`scripts/watchdog/run-watchdog.mjs` (in a Pandesh source checkout):

1. **Suites:** the Core and desktop vitest suites, recording every test's status and duration. No GPU needed.
2. **Live scenarios:** a real Core bundle on a fresh, isolated data folder with a disposable workspace and the local
   model. It checks an everyday answer, a hand-off to the Coding specialist, a write that must be refused, memory
   recalled in a new chat, and fixing a failing test. The fix is verified by running the tests itself, not by
   trusting the reply.
3. **Comparison** with the last complete run: new failures (regressions), fixes, known failures (not repeated),
   environment failures (Ollama down, port in use, timeouts) and noticeably slower tests.

Approvals in the live stage follow a fixed policy per scenario. Writes and commands are allowed only inside the
disposable workspace, and only where the scenario expects them. Everything else, including any network request, is
refused.

## Safety

- Never touches your profile, your conversations or the installed app. It only reads the source checkout and writes
  to its own state folder.
- One run at a time: a lock file, and a stale lock from an interrupted run is taken over.
- GPU-aware: the live stage waits (up to 3 h, in 10-minute steps) while GPU utilisation stays at or above 25%, then
  defers to the next run instead of competing with interactive work.
- It only reports. It never merges, deploys or changes anything.

## Schedule

Every 2 days at 04:00 Europe/Berlin, as a `scheduled_tasks` row with `routine = 'reliability_watchdog'`. Because it is
a normal Core schedule, it survives restarts, fires once per occurrence, and if the PC was off or asleep it catches up
on the next start (within 24 h).

```text
POST /v1/watchdog/schedule  {"repoPath": "D:/Projects/Pandesh", "stateDir": "D:/PandeshWatchdog", "model": "gemma4:12b"}
POST /v1/watchdog/schedule  {"enabled": false}      # switch off
POST /v1/watchdog/run-soon                           # next scheduler tick runs it (for checks)
GET  /v1/watchdog                                    # schedule and recent runs
```

A run that changed nothing is silent. News (the first baseline, a regression, a fix, an environment problem, a deferred
or crashed run) appears as one message in the **Reliability watchdog** chat and one desktop notification. Reports are
kept in `<stateDir>/runs/<runId>/report.md`, with `history.jsonl` alongside.

## Verified (2026-11-09, isolated demo profile)

| Check | Result |
|---|---|
| Scheduler-triggered run (`run-soon`) | Fired on the next tick. 4 min: Core 2615 passed / 1 failed, desktop 619, live 5/5. Baseline message and a Windows toast (`notification_outbox` row `delivered via windows_toast`). |
| Real finding | The first run caught a genuine regression in the watchdog's own code: an unreviewed `child_process` import blocked by the architecture guard. It was fixed by adding a reviewed allowlist entry with a verified tree kill. |
| Missed-run recovery | The schedule was backdated 6 h with the app closed. On restart the run fired within 6 s and reported "1 fixed, no new regressions". The next run returned to the regular 04:00 slot. |

Not yet verified live: the GPU-busy deferral path (unit logic only) and a run longer than the 5-hour limit.
