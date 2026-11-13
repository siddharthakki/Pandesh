# Pandesh reliability recovery — implementation tracker

One durable tracker for the whole program (owner brief 2026-11-13: reconciliation, M0–M7). Updated after each work unit.
Evidence lives in `acceptance/live-eval/results/` (versioned) and `docs/audit/2026-11-12/` (the audit, untracked on the owner's checkout).

## Frame

| | |
|---|---|
| Audited code | main `dfd781b` = production Build 167 (audit 2026-11-12) |
| Program base | `origin/main` `0fdb349` (includes #76, #77 = Build 168, #78 cloud boundary, #80 providers) |
| Working tree | worktree `D:\Projects\Pandesh-recovery`, branch `program/reliability-recovery` |
| Production | Build 168 (`ea94c9b`). Build 169 = PR #81, built in `Pandesh-audit\.tmp\rc-b169`, not installed |
| Rules | no deploy / install / live credentials without the owner; synthetic fixtures; isolated Core on a throwaway profile; no silent cloud |

## Step 0 — reconciliation of the audit against main (2026-11-13)

| Finding | State on `0fdb349` | Action |
|---|---|---|
| Core API accepts a client label of "cloud model output" (`modelInvocationId` on `POST /v1/conversations/:id/messages`) | **Reproducible by code reading.** Origin decides what a cloud model may later see. No auth escalation (needs the Core token, which only the host and the phone bridge hold) but it defeats the #78 history filter. | **Fixed `f1b19b7`**: accepted only on an assistant message whose model call ran in the same conversation. Test `core/test/messageOriginApi.test.ts` (3). |
| "Real profile" derived from `LOCALAPPDATA` (tracker item 23 root cause) | **Reproducible.** A copy that redirects `LOCALAPPDATA` computed its own folder as the real one: no TEST COPY title, Google sign-in allowed, login item writable. | **Fixed `f1b19b7`**: `realDesktopDataDirFromOs()` uses `os.userInfo().homedir`. Tests in `apps/desktop/test/testProfileGuard.test.ts`. |
| Test copy keeps an existing Google grant | #78 refuses new connects on a test copy. **Open:** a profile copied together with an existing grant still holds the token; whether Google tools use it on a test copy is not yet checked. | Check before any real-account pilot; until then Gmail/Calendar pilots use synthetic data only. |
| Cloud-offer-accepted path and L9 (file checks) never run live | Unit coverage with a scripted OpenAI-compatible provider (`cloudDataBoundary.test.ts`). Not run live: no cloud key is used in this program. | Left as unit-covered; live run needs owner consent and a key. |
| Pi is the production path; Saath/mission loops are test-only | Unchanged (`executor.ts:749-772`). | M2 decision. |
| Restart kills live work | **Reproduced** by M0 scenario I01 (below). | M2. |
| Category-level completion (S21) and `completed` on undone work | **Reproduced** by C01 (below); F02 passed once, intermittent. | M1. |
| Routines without scope (S07) | `scheduled_tasks.scopeJson` now exists. Not yet re-measured. | M0 slow scenario S01, then M3. |

## M0 — baseline

Harness: `acceptance/live-eval/` (`node acceptance/live-eval/run.mjs`, build the Core bundle first with `node esbuild.core.js`).
26 scenarios (3 slow: R02, S01 schedule/reminder delivery). Independent checks read the file system, the isolated profile DB and reality
(git, ComfyUI). Verdicts: PASS, FALSE_COMPLETION, STATUS_CONTRADICTION, HONEST_FAIL, ERROR.
Core capability is measured here. The desktop natural-request path is measured separately (not yet done).

Results: see `acceptance/live-eval/results/m0-core-*`. Summary and verdicts are filled in below when the runs finish.

## Next exact step

1. Finish M0 (stability run, repeats, slow scenarios, desktop-path sample), record the baseline verdict here.
2. M1: deliverable ledger in `core/runtime/turnOutcome.ts` + attempt/task status mapping, tests, re-run F02/C01/P01 ×N.
