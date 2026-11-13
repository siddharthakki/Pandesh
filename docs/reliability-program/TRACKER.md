# Pandesh reliability recovery — implementation tracker

One durable tracker for the whole program (owner brief 2026-11-13: reconciliation, M0–M7). Updated after each work unit.
Evidence lives in `acceptance/live-eval/results/` (versioned) and `docs/audit/2026-11-12/` (the audit, untracked on the owner's checkout).

## Frame

| | |
|---|---|
| Audited code | main `dfd781b` = production Build 167 (audit 2026-11-12) |
| Program base | `origin/main` `0fdb349` (includes #76, #77 = Build 168, #78 cloud boundary, #80 providers) |
| Working tree | worktree `D:\Projects\Pandesh-recovery`, branch `program/reliability-recovery` (nothing pushed, no PR) |
| Production | Build 168 (`ea94c9b`). Build 169 = PR #81, built in `Pandesh-audit\.tmp\rc-b169`, not installed |
| Rules | no deploy / install / live credentials without the owner; synthetic fixtures; isolated Core on a throwaway profile; no silent cloud |

## Step 0 — reconciliation of the audit against main (2026-11-13)

| Finding | State on `0fdb349` | Action |
|---|---|---|
| Core API accepts a client label of "cloud model output" (`modelInvocationId` on `POST /v1/conversations/:id/messages`) | **Reproducible by code reading.** Origin decides what a cloud model may later see. No privilege escalation (needs the Core token, which only the host and the phone bridge hold) but it defeats the #78 history filter. | **Fixed `f1b19b7`**: accepted only on an assistant message whose model call ran in the same conversation. Test `core/test/messageOriginApi.test.ts` (3). |
| "Real profile" derived from `LOCALAPPDATA` (tracker item 23 root cause) | **Reproducible.** A copy that redirects `LOCALAPPDATA` computed its own folder as the real one: no TEST COPY title, Google sign-in allowed, login item writable. | **Fixed `f1b19b7`**: `realDesktopDataDirFromOs()` uses `os.userInfo().homedir`. Tests in `apps/desktop/test/testProfileGuard.test.ts`. |
| Test copy keeps an existing Google grant | #78 refuses new connects on a test copy. **Open:** a profile copied together with an existing grant still holds the token; whether Google tools use it on a test copy is not yet checked. | Check before any real-account pilot; until then Gmail/Calendar pilots use synthetic data only. |
| Cloud-offer-accepted path and L9 (file checks) never run live | Unit coverage with a scripted OpenAI-compatible provider (`cloudDataBoundary.test.ts`). Not run live: no cloud key is used in this program. | Left as unit-covered; a live run needs the owner's consent and a key. |
| Pi is the production path; Saath/mission loops are test-only | Unchanged (`executor.ts:749-772`). | M2 decision (below). |
| Restart kills live work (S06) | **Reproduced** by M0 scenario I01. | M2 first slice built. |
| Category-level completion (S21), `completed` on undone work | **Reproduced** by M0 F02#1 and C01. | M1 first slice built. |
| Routines without scope (S07) | `scheduled_tasks.scopeJson` exists only for built-in routines (watchdog). Slow scenario S01 not yet run. | M3. |

## M0 — baseline (done for Core; the desktop request path is not yet measured)

Harness: `acceptance/live-eval/`. Build the Core bundle (`node esbuild.core.js`), then
`EVAL_LABEL=<name> node acceptance/live-eval/run.mjs [--fresh] [--ids F02,C01] [--repeat 3] [--slow]`.
26 scenarios (3 slow: R02 reminder delivery, S01 scheduled routine). The isolated Core runs from this tree's bundle on a throwaway
profile (`D:\PandeshRecoveryEval\<label>`), driven over the same HTTP API as the desktop host, with a fixed approval policy that
reads the approval's tool name. Independent checks read the file system, the profile DB and reality (git, ComfyUI). Real local
models via Auto routing (gemma4 family). Verdicts: PASS, FALSE_COMPLETION (result says completed, the outcome is absent, the reply
does not admit it), STATUS_CONTRADICTION (result and outcome disagree), HONEST_FAIL, ERROR.

Baseline on main `0fdb349` + the step-0 fixes, 24 fast scenarios:

| run | pass | false completion | status contradiction | honest fail |
|---|---:|---:|---:|---:|
| baseline run 2 | 20/24 | 1 (P01) | 3 (F03, I02, C01) | 0 |
| baseline, 3 repeats of F02, C01, P01, F03, A02 | 8/15 | 3 | 3 | 1 |
| after the first M1 slice (ledger + partial) | 20/24 | 1 (P01) | 1 (I02) | 2 (F02, F03: now reported as partial / failed) |

Run 1 (`m0-core-main0fdb349-run1`) used an earlier checker for P01 and A02 and is history only: its A02 "false completion" was the
harness approving a search-permission card, not a Pandesh defect.

Reproduced on the baseline: S21 (F02#1: no file written, attempt completed, task outcome satisfied), S04 run 2 (C01: stopped after
list_directory), S20 (P01: dependency and, in some runs, dates and priorities silently dropped), S06 (I01: a restart fails the
task, nothing resumes), S14 (I02: a new chat did not know the interrupted task), folder organisation (F03: pc_organize_scan fails,
2 of 3 runs ended `completed`). Not reproduced: S16 in run 1 (T01 took another route; it did reproduce later, see M1). Permission
violations: 0 (X01, A01, A02, C02 pass). Latency: median 12 s per scenario on gemma4.

## M1 — completion truth (first slice built; gate NOT met)

- `core/runtime/deliverableLedger.ts`: expected deliverables from the request (named output files, one output per input file, links
  in files the turn wrote), a "works" claim after the turn's own check failed (S16), task dates the owner stated but that were not
  stored (S20). One "still missing" nudge, then the turn is `partial`.
- `partial` verdict: attempt failed with `Partly done:`, PARTLY DONE lead line, final verification `passed:false`.
- `core/domain/resultStatus.ts` and `resultStatus` / `resultReason` on `GET /v1/attempts/:id`: completed | partial | blocked | failed |
  cancelled | interrupted | running, derived from recorded facts (a completed attempt that ended unfinished is `failed`).
- `run_checks`: a relative `workspacePath` resolves against the selected folder (G10).
- Tests: `deliverableLedger` (14), `deliverableLedgerPi.acceptance` (3, real Pi engine, scripted model), `resultStatus` (7).

Open for the gate: T01 (S16) still shows a contradiction in some runs; P01 loses dependencies; the UI and phone still show the attempt
`status`, not `resultStatus`; the one nudge does not make a weak model finish (F02 now ends `partial`, honestly).

## M2 — durable execution (first slice built; gate NOT met)

- `core/runtime/replayGuard.ts`: before a consequential call in a successor attempt, an identical call in the predecessor chain is
  not executed again (succeeded → "Already done"; started with no recorded outcome → "check the real state first").
- `core/runtime/resumeAttempt.ts` and `POST /v1/attempts/:id/resume`: a successor attempt of the same request, same model, folder
  and permission policy, prompted with Core's account of what the journal says was done / started / read.
- The personal overview lists tasks that did not finish from any conversation (S14, G14).
- Test: `resumeReplayGuard.acceptance` (2, real Pi engine).
- Not yet: automatic resume on boot, a chat tool / UI card to resume, the 10-scenario controlled interruption suite, budgets, backoff.

## Next exact step

1. Rebuild the bundle, run the fast set and the repeats (`m1-core-after2`), analyse T01/I02/P01, record the verdict here.
2. Decide the resume trigger (owner): a chat tool `resume_task` with an approval card, or automatic on boot for attempts with no
   unknown consequential call.
3. M3: freeze the scope for user-created routines, failure notices to the outbox, weekly/monthly recurrence.
