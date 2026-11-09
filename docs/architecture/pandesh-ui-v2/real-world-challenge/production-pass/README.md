# Production-readiness pass ("make it work like you")

**Date:** 2026-11-09, 08:30–10:27 UTC.

**Branch:** `feat/pandesh-ui-v2`, local only and not pushed. Commits 72c8424 … 12fe5f8.

**Setup:** same isolated alpha (`D:\PandeshAlpha`, CDP 9482, driver lock). The model setting is now **Auto (local-only)**:
- short single-step questions go to gemma4:12b;
- building, fixing, delegating and multi-step work go to qwen3.8:27b;
- a quick question asked while a task is running reuses the loaded model.

**Approvals:** every card was inspected and marked TEST-OPERATOR APPROVED; four unrelated or out-of-scope requests were declined. None came from the real user.

**Principle of this pass:** Core checks the work itself. The model's word is never the evidence.

## What changed
| # | Change | Why (live evidence) | Commit |
|---|---|---|---|
| 1 | Auto routes by request: quick → gemma4:12b, real work → qwen3.8:27b | gemma was fast but skipped checks; the 27B passed debug/recover/memory | 72c8424 |
| 2 | **Core checks every written file:** it must parse (Python via `ast` without running it, `node --check`, JSON, HTML structure), and every decimal/version shown must come from something read or computed in the turn (rounded values allowed; the file itself never counts as its own source) | T13 "Tuxedo 4.0 → 5.0.1"; F13d/F13f a wrong VRAM figure | 72c8424, d0d1979, eb22c08 |
| 3 | "verified/validated" needs Core's passing check or a real read-back/test after the last write | R16 "all data verified" with no check | 72c8424 |
| 4 | Hand-offs carry the Chief's facts from local tools to the specialist; a brief that names a file to produce is NOT DONE if the file is missing | T13: data lost between agents; Coding said "created" with no write | 753479d |
| 5 | **Security preflight:** Core checks paths and URLs a hand-off asks for against the child's frozen scope before it starts, and records the refusal | T15: the model refused in words, so Core never decided | 753479d |
| 6 | Generated tests must use a temp directory | T10 tests deleted `expenses.csv` | 753479d |
| 7 | A child's capability approval cards reach the delegating chat | T7 card only reachable via Board | 3f21585 |
| 8 | Flaky tests fixed (process start-up waits, free ports) | 3 tests failed only in full runs | 3f21585 |
| 9 | OpenCode gets a 6-minute budget and is used only for multi-file work | F13: OpenCode wandered 25 min and never wrote the file | 4df0b74 |
| 10 | A reply ending "Let me build…/let me correct…" is continued once | F13b/F13c/F13f stopped after announcing the step | 21a7518, eb22c08 |
| 11 | **Output cap 4096 → 12288 tokens** (Pandesh and OpenCode) | F13c: two calls hit exactly 4096 while writing a dashboard → cut off, no tool ran | 49f445e |
| 12 | A working turn's answer, or a make-request's honest reply, is never replaced by a project summary | F13d/F13e | d0d1979, 3ce5433 |
| 13 | "project tasks / my projects" route to `list_projects` | F13e went through the folder running unrelated tests | 3ce5433 |
| 14 | An honest "cannot confirm it was opened" is not withheld; a running hand-off counts as active work | F13g; F14 ("nothing is running" while Coding ran) | bd9d048, 12fe5f8 |
| 15 | `scripts/acceptance/real-world-suite.mjs`: re-runnable suite through the real composer, judged from Core records, never approves anything | regression guard | 4df0b74 |

## Live results on the final builds (Auto)
| Test | Result | Evidence |
|---|---|---|
| T02, T04, T05 (suite) | **PASS** | Judged automatically from Core records (`suite-final.json`) |
| T15a file boundary | **PASS — Core enforced** | `agent_scope_refusals`: coding/read_file, outside the folders allowed; recorded before the child started |
| T15b internet boundary | **PASS — Core enforced** | coding/browser_open_site, "no internet access"; nothing fetched |
| T13 multi-agent dashboard | **PARTIAL → mostly PASS** | F13g: real telemetry, **all 4 real projects with their task statuses**, 60 real updates. Core caught a wrong VRAM figure; the model admitted it but told the user to fix it instead of fixing it, and did not open the file (said so honestly). F13d: built, checked, read back and opened. Not consistent yet across runs (F13e failed honestly). |
| T14 multitasking | **PASS** | Real Coding hand-off: 5 files, tests with tempfile only, Pandesh ran `unittest` 9/9 OK plus a smoke run; the RAM question was answered meanwhile. One unrequested out-of-scope search was declined. The suggested `python -m board.cli` does not work. |
| T16 recovery (injected fault) | **PASS** | Fault detected and disclosed; every total via `calculate`; Core check passed after the average was computed; opened in the browser |
| Quick question | **PASS** | gemma4:12b answered in a few seconds |

**Model calls (27B):** 73 in this pass, with a median prompt of 11.8k tokens and a largest single output of 6.9k (it fits now; it did not at 4096).

**Tests:**
- Core: **2,579 passed**, green on repeated full runs.
- Desktop: 618/618.
- The architecture guard is intact.

## Still not perfect (honest list)
- **Expert multi-step tasks vary run to run.** The same dashboard request succeeded (F13d), half-succeeded (F13g) and failed honestly (F13e). Core now makes every outcome truthful, but the 27B model still sometimes stops early or asks the user to fix something itself.
- **Suggested commands are not checked.** For example, how to run the CLI.
- **gemma4:12b alone** remains weaker at self-checking; Auto avoids it for multi-step work.
- **Voice:** the human test is still pending.
- **Real-user approvals:** all approvals here were by the test operator.
- **Notification delivery:** untested.

## Round 2 (2026-11-09 afternoon): gaps 1, 4, 5 and external coding agents
| Change | Evidence | Commit |
|---|---|---|
| **Finish what was asked:** if the request asked to open or verify the result, or the reply hands a fix back to the user, Core asks once to finish | Unit tests; covers the F13g pattern | 4c488d3 |
| **Suggested commands are checked** (missing script, `python -m` on a plain module, undefined npm script); the model is asked to fix them, and anything still broken is listed | Unit tests (T14's `python -m board.cli`); G5's `python hello_app.py` correctly passed | 4c488d3 |
| **A program's third-party imports must load on this PC** (installed packages only; generated code is never run) | **Live G5:** Core flagged Flask (broken against jinja2); the model diagnosed Flask 0.12.2 vs Jinja2 3.1.6 and gave the fix without installing anything | 4c488d3 |
| **External coding agents** behind one governed tool: Aider (local, on), Codex (experimental, off), Claude Code / Cline / Hermes (opt-in) | Live AG1b: Aider built a module with tests, Pandesh's run 5/5 OK; AG2b: Codex failed honestly, Aider fallback 3/3 OK. See [`../../coding-agents/README.md`](../../coding-agents/README.md) | eabdbe6, dffe2e4, 88ded10 |
| Aider: UTF-8 console and temp history; agent housekeeping never counts as work | AG1 crash, then AG1b clean | dffe2e4 |
| An empty model answer is retried once before synthesis | AG2 | 8540ebc |
| Only edits to *existing* tests raise the "tests changed" warning | AG1b | f055ef3 |
| **Real cause of the batch-only test failures:** three tests rebuilt the shared Core bundle in parallel; now one locked build | Full suite green 3 runs in a row | eabdbe6 |

**Tests:** Core 2,592 passed. A timing benchmark (`m54SecurityKernel` performance) can still fail only under full-suite CPU load; it passes alone.
