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
