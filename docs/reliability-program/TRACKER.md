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

## Results over the program (Core, isolated, real local models; fast set unless stated)

| run | scenarios | pass | false completion | status contradiction | honest fail |
|---|---:|---:|---:|---:|---:|
| baseline (main + step 0), run 2 | 24 | 20 | 1 | 3 | 0 |
| baseline, 3 repeats of 5 variable scenarios | 15 | 8 | 3 | 3 | 1 |
| after5 (all slices + review fixes), run 1 | 25 | 23 | **0** | 1 (P01: harness timezone bug, fixed afterwards) | 1 |
| after5, 3 repeats of F02, P01, I03, C01, T01 | 15 | 11 | **0** | 1 (I03#1: duplicate write, guard refined afterwards) | 3 |

Slow scenarios (after4 run): S01 routine PASS (the scheduled run wrote its file in the creating folder; audit S07 closed on Core),
R02 reminder due on time: Core side only (delivery is the desktop host's job, not measured here).

## M1 — completion truth (built; gate NOT yet declared met)

Zero false completions in the last full run and in the last repeats; one status/outcome contradiction per run, each traced to a harness bug
or a guard gap that was fixed after the run and has NOT been re-measured. S21 (F02): reproduced on the baseline, `partial`/honest afterwards.
S16 (T01): one run where the reply said it works after a failed check; the guard now demotes it; later runs clean.
Built: `deliverableLedger.ts` (named output files, one output per input file, link closure, 'works' after a failed check, stated task
dates / priorities / dependencies stored), `partial` verdict, `resultStatus` (completed | partial | blocked | failed | cancelled |
interrupted | running) on `GET /v1/attempts/:id`, `turn_blocked`, task record never 'satisfied' on an unfinished turn, addTask dedupe, run_checks path.
Known limits: weak local models still fail some tasks (F02 now ends `partial`, honestly); the UI and phone still show the attempt `status`
instead of `resultStatus`; the ledger counts only write_file as written.

## M2 — durable execution (built; gate NOT met)

`replayGuard.ts`, `resumeAttempt.ts`, `POST /v1/attempts/:id/resume`. End to end through the real HTTP API: I03 (kill after the first write, restart,
resume) finished with all files and no duplicate write in 5 of 6 runs; the sixth showed one identical duplicate write (unknown-twin rule, now stricter).
Not yet: automatic resume on boot, a chat tool or UI card to resume, the 10-scenario interruption suite, budgets, backoff, exactly-once for
non-file operations (email, calendar) on a live connector.

## M3 — routines (first slice built; gate NOT met)

`schedule_task` freezes folder + access (fail-closed to read); the scheduler runs the routine there; a missing folder or an unfinished run enqueues a
notification. Live: S01 passed once. Not yet: 7 consecutive runs of 3 routines, weekly/monthly recurrence, restart/cancel checks, host delivery of the notices.

## Independent review

A fresh subagent reviewed the diff (12 findings, 3 high). All high and most medium findings were fixed with tests (ledger inputs/negations, task checks only on
task writes, chain freshness vs the replay guard, run_checks, refused calls, resume after Stop, dedupe by date, scheduler fail-closed). Not fixed: args over
64 KB and path spellings can bypass the guard; a bare identical call in the SAME attempt is not guarded (pre-existing); unfinished-task list shows 90 characters of
other chats' requests in every chat's overview.

## Update 2026-11-13 (owner decisions: draft PR, user-authorized resume, close M0-M3 before features)

PR: draft https://github.com/siddharthakki/Pandesh/pull/82 (branch program/reliability-recovery, merged with origin/main Build 169). Nothing deployed or installed; production untouched (snapshotted before/after the desktop run).

### Fixes made in this round (each found by a live run, not by unit tests)
- Security: an EMPTY X-Client-Id header skipped the message-origin check (header '' is falsy) -> normalised in server.ts; test covers omitted, empty and spoofed (model-*, tool-*) ids.
- Replay guard v2: canonical resource paths (separators, case, ..), hashed arguments when over the 64 KB storage bound (stored as argsHash), file writes reconciled against the real file (in place = done; started-never-confirmed + file absent = may run), every other unconfirmable call fails closed (never repeated automatically).
- Resume is the owner's choice: GET /v1/tasks/overview gives resultStatus + resumable; the host Resume button calls POST /v1/attempts/:id/resume; nothing resumes on boot. Boot reason text points at Resume.
- Resume guidance names the working folder (without it the successor drifted to Gmail tools in 2 of 3 runs), and a resumed attempt counts what its predecessors wrote (finished work was reported as "nothing built").
- Ledger: an index that must list the outputs has to mention each; hedged/negated sentences are not working-claims; write_file UNCHANGED (already current) counts as done (a daily routine repeats the same output).
- Scheduler: a scheduled run cannot call schedule_task (live run created a duplicate schedule), is told to carry out the task every time, an interrupted routine notifies the owner (boot reconciliation).

### Gate results (Core on an isolated profile unless stated; real local models)
- M2 interruption suite m2-gate-run1 (9 scenarios x3): 24/27 pass, 0 duplicate writes; the 3 non-passes were a stricter index check in the harness that the ledger did not yet enforce (fixed afterwards: ledger index rule). Later targeted runs: I04 5/5, I06 5/5 (after the resume-guidance fix), I07 and I08 pass, I11 3/3 exactly one reminder, I13 (restart with an approval pending: nothing runs by itself, Resume asks again) 3/3 in run5.
- M1 full baseline m1-final-run2 (33 scenarios): 30 pass, 0 false completions, 1 contradiction (I06: the ledger says the index links are broken relative to analysis/, which is true; the harness did not check link resolution), 2 honest fails (F03 folder organising, E01 image studio down). Repeat of 8 variable scenarios x3 (m1-final-repeat3, 24): 21 pass, 1 false completion (F03#3: status completed while the reply says nothing was moved and asks for approval), 2 honest fails (F03). Baseline for comparison: 20/24 pass, 1 false completion, 3 contradictions.
- M3 m3-routines-run8: 7 consecutive simulated days of 3 routines (days simulated by making each routine due; scheduler, executor, scope and notifications are real): all expectations met, including day 4 (folder removed: routine did not run, owner notified) and day 6 (Core killed while all three ran: each ended interrupted, reported once, none replayed). Runs 3-7 before the last fixes failed (idempotent output reported as failure, duplicate schedule created by a scheduled run, model answered without calling the tool): history in results/.
  Policy observed: an unattended routine write needs the owner's approval (Ask); the harness plays the owner.
- M0 desktop path desktop-path-run2 (real Electron host + v2 renderer over CDP, throwaway profile): 5/5 (create file, seven files, reminder, declined write, Core killed mid-task -> task listed resumable -> host resumeTask -> finished, no duplicates). Core-only and desktop results agree.

### Remaining failures / limits
- F03 (pc_organize_scan/apply): 0 of 4 correct moves; honest failures, one run with status completed over an honest "nothing moved" reply.
- M3 evidence is one clean 7-day run after four failing ones; a second clean run is not yet recorded.
- Routines need the owner's approval for writes (design decision, see below).
- Not covered: exactly-once for external connectors (email/calendar) beyond fail-closed; args/path variants of run_command; the UI card for resume exists only as the Tasks Resume button.

## Update 2 (strategy revised: fix at source, targeted reruns, no long M3 reruns)

Root causes found this round: (1) the M3 "first write" failure had two sources: a write held back for source evidence that the model never repeated (now one Core nudge, test heldWriteNudge.acceptance) and, in the later smoke, the word "inbox" in "the inbox folder" selecting the Gmail tool group (fixed in chatToolSelection; the same drift caused the I04 resumed-attempt failures). (2) Independent verifier (subagent, read-only) findings: only the attempt's LAST model call can be claimed as a reply (conversations.appendMessage); the UNCHANGED exemption is limited to write_file.

Targeted evidence after the fixes: M1 full baseline m1-final-run3 33 scenarios 31 pass, 0 false completions, 0 contradictions, 2 honest fails (F03, C01); repeats m1-final-repeat4 (F02,F03,C01,P01,T01 x3) 12/15, only F03 fails (honest). M2 recheck 2 (m2-recheck, m2-recheck2: I03,I04,I06,I07,I13): no duplicate writes, no automatic resume; two runs were harness preconditions (task finished/partial before the kill, from the inbox drift). M3 smoke m3-smoke2: 3 simulated days all three routines OK (m3-smoke before the inbox fix: routine B failed 3/3). Desktop smoke desktop-smoke: 5/5.

Open (verifier, not fixed): replay guard matches identical arguments only (a reworded reminder/mail/calendar call is not caught; run6 I06#2 rewrote files with different content before the guard changes); a pending-approval non-file call is treated as "unknown" on resume (I13 only exercises write_file); F03 turn awaiting approval ends completed/satisfied; M3 clean 7-day evidence is run8 only (routines A and C wrote UNCHANGED text each day, so only B proves writes; the harness presses Approve; notifications stay pending, no channel delivery tested).

## Not started
Desktop request path measurement (needs a built app copy and the microtests CDP harness); M4 routing; M5 attachments/vision in v2; M6 memory proposals; M7 pilots;
harness benchmark; cleanup. Real-Google tests stay blocked until the test-copy grant question above is closed.

## Next exact step
1. Re-run after the last fixes (P01 timezone check, unknown-twin rule): `node esbuild.core.js`, then the fast set and `--ids I03,P01 --repeat 5`.
2. Owner decision: resume trigger (chat tool with approval card vs automatic on boot); and whether to push `program/reliability-recovery` and open a PR.
3. Build the app copy from this tree and measure the desktop path (same scenarios through the v2 UI over CDP).

## Update 3 (2026-11-13, owner decision: standing write permission, F03, semantic duplicates, notification delivery)

Draft PR #82 stays Draft. Production untouched. Evidence files: `acceptance/live-eval/results/gate4-*`.

- **Standing write permission (implemented, dev only, not enabled in production):** per scheduled routine, host-only API (`/v1/scheduled-tasks/:id/write-grant`, `confirm:true`), frozen fingerprint of instruction + real folder + model + operations + limits; only `write_file`; enforced in `authorizeFileWrite`; every path/link/secret/limit check still applies; revoked on cancel; any material change stops it; each use read back by Core, recorded in `routine_write_grant_uses`, re-checked against the disk at run end (`routine_run_verified`). Tests: `routineWriteGrant.acceptance.test.ts` (10). Live: `m3-grant.mjs`, approval pump REJECTS every card.
  - run7: granted days 2-3 write with no card, source `standing_grant:*`, verified; day 3 revoke -> A asks (card rejected, honest failure, notified); day 4 instruction change -> B asks; day 5 re-grant -> A writes without a card. Day 1 B wrote "0" instead of 3: the grant worked (authorized, read back) but the model miscounted; counted as a model-quality failure, not a grant failure.
  - runs 1-6 found and fixed real defects: quoted "'inbox' folder" and `reports/inbox-count.txt` selected Gmail tools; a routine that answered without any tool call ended `completed` (now retried once, then reported); declined runs in the routine's conversation made the model refuse after re-grant (message now says earlier runs do not apply); the routine title ("Daily Inbox Count Report") also selected Gmail (folder routines omit it).
- **F03:** the false completion was `pc_organize_apply` reporting success with 0 files moved (journal evidence in gate4-f03-a). Now `NOT DONE (nothing_moved)`; a plan already fully applied is still success. Test `pcOrganizeApplyNothingMoved.test.ts`. Live F03 x3 after the fix: 0 false completions (3 honest fails); the specific apply-with-zero-moves path was not re-triggered live, proof is the captured journal + unit test.
- **Semantic duplicates:** replay guard now matches reworded repeats (reminder same time, calendar event same title+start, draft same recipients+subject, note, promise, routine) and settles an unknown outcome from Core's own stores (reminders, notes, promises, routines); email/calendar stay fail-closed. Tests: `replayGuard.test.ts` (+4), `resumeReplayGuard.acceptance.test.ts` (+1 engine level).
- **Notification delivery:** `desktop-path.mjs` D06: the real scheduler queued a "routine did not run" notice, the real Electron host showed a Windows toast, Core recorded `delivered via windows_toast` in 6 s (events + host log). Limit: Electron's `show` event proves Windows accepted the toast, not that a person saw it.
- Full Core suite: 7430 passed, 4 failed in files this change does not touch (m12 packaging, coreInstanceIsolation, loginItemOwnership, delegationVerification "detects the project test command"); not compared against the base commit.
