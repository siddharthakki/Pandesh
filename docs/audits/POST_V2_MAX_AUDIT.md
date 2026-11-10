# Pandesh post-v2 MAX audit: Build 160 (abb0cc4) → Build 161 candidate

**Date:** 2026-11-09/10 · **Auditor:** Claude (Opus 5.5), independent · **Branch:** `fix/post-v2-max-audit` from `origin/main` cb9a28b (candidate build commit `e88bdc5`) · **PR:** opened from this branch (not merged, not deployed)

**Verdict: HOTFIX READY FOR OWNER APPROVAL** — subject to the pull request's first CI run being green. Deployment of Build 161 needs the owner's separate approval.

Build 160 (installed, unchanged) contains the P0 defects below. All of them are fixed on the branch with failing-before / passing-after regressions. Nothing was installed, deployed or changed in production. The installation, the profile and the schedules are untouched, and the production database was only byte-copied while Pandesh was not running.

---

## A. Baseline (verified, not assumed)

| Item | Verified state |
|---|---|
| Installation | `E:\Pandesh` = v0.1.8 **Build 160**, commit `abb0cc4`, Electron 45.2.3 (build identity in the host log at its last start, 2026-11-09 20:22Z). All 13 fingerprinted files matched `build-fingerprint.json` on 2026-11-09. |
| Production process | **Not running**: the owner quit from the tray at 2026-11-09 21:10:30Z. No production process was started, stopped or signalled during the audit; re-checked 2026-11-10 before every step that read production data. |
| Profile | `%LOCALAPPDATA%\KarkeDikha\desktop`. `core.db` unchanged since 21:10:30Z, no WAL in flight, **schema 50**, `quick_check ok`. Read only through byte-identical copies (SHA-256 compared). |
| Source | `origin/main` = cb9a28b (merge of #46); its tree is identical to `abb0cc4`. |
| Routing | `KARKEDIKHA_MODEL_ROUTING_POLICY=local-only`; selected model `gemma4:12b`; cloud use only on an explicit per-message choice (public text, no tools, no history). |
| Test environment | Node 24.16; worktree dependencies junctioned to the Electron-45 release clone; every dangerous test on throwaway data directories under `%TEMP%`; local Ollama (RTX 3090 24 GB) with installed models only: `gemma4:12b`, `qwen3.8:27b-mtp-q4_K_M`, `qwen2.5-coder:3b`. |

---

## B. Findings and P0/P1 matrix

Severity: **P0** confidentiality, cross-profile action, unapproved consequential action, data loss · **P1** wrong reports, stuck work, recovery, security hardening · **P2** performance, polish, tooling.
"Confirmed" = reproduced with a failing test or run before the fix ("red"), then passing after ("green").

| ID | Sev | Originally failing case | Fix (commit) | Regression test (red → green) | Status |
|---|---|---|---|---|---|
| F1 | **P0** | A copied profile (`core.json` + `core.token`) attached to, quiesced and **stopped** the original profile's Core | Instance-ownership invariant: a host acts only on a Core that proves it serves the host's data dir; Core refuses (409) shutdown/update-gate addressed to another instance/profile (1e22de5) | `apps/desktop/test/coreInstanceIsolation.test.ts` (6 red → green; 8 now) | Fixed |
| F2 | **P0** | A copied process-ownership ledger let the copy **kill** the original Core with a different token | Provenance bound to the recording profile; unbound (old) entries cannot authorize a kill (1e22de5) | same file, ledger cases | Fixed |
| F3 | **P0** | `delegate_to_agent` copied the parent's recalled memory (user facts) into a Research child that may not read it | Hand-off facts reduced to the child's readable scopes; handed memory counts as private for its web-query guard (fd6cfff) | `core/test/handoffFactsScope.test.ts` (4 red → green; 6 now) | Fixed |
| F20 | **P0** | Team-view delegation ran the specialist **inside the delegating conversation**: its model received that whole history, including private memory recalled there | `/v1/agents/delegate` always gives the child its own conversation (41e8254) | `core/test/delegationPrivacy.test.ts` "Team view…" (red → green) | Fixed |
| F21 | **P0** | The delegating model writes the brief and could **paste** a stored fact the child may not read; nothing checked it | Core refuses such a brief before the child starts or any card is raised; words the user wrote in this request may pass (41e8254) | `delegationPrivacy` "a brief that repeats…" (red → green); matcher unit tests in `handoffFactsScope` | Fixed (heuristic, see §J) |
| F4 | **P0** | Schema upgrades ran without a pre-migration backup on the installer path; an older build silently ran on a newer database | Verified `VACUUM INTO` backup before any migration (failure blocks it), prune by age, newer-schema DB refused and left unchanged (ead6b93, a644a2c) | `core/test/migrationSafety.test.ts` (6) | Fixed; packaged rehearsal §G |
| F5 | P1 (security) | **Auto** standing authorization failed open when a Pandesh write was recorded under another spelling (8.3/junction) of the workspace | Both sides compared by OS-resolved spelling (69317a1) | `core/test/permissionModes.test.ts` 8.3 case (red → green); alias matrix | Fixed |
| F6 | P1 (security) | The agent path gate checked a fixed list of argument names (`dirPath`, `searchRoots`, … skipped it) | Every path-like argument checked (fd6cfff) | `core/test/agentPathScopeBypass.test.ts` | Fixed |
| F27 | P1 (security) | Pi file tools authorized paths **by spelling**: `ws\link\private.txt` (junction → outside) was read and listed without asking; the agent scope gate compared spellings too (and skipped bare names), so a junction passed it and reached a card that could widen an agent's scope | Both checks compare real locations (`core/platform/realLocation.ts`); the card names the real folder; agents are refused (8df8bd4) | `core/test/piJunctionScope.test.ts` (3 red → green), `agentPathScopeBypass` junction case | Fixed |
| F7 | P1 (security) | Pandesh's own secrets (`core.token`, `host.token`, `port-manager.token`, companion vault/TLS) were readable by model file tools | Added to the credential-file guard (fd6cfff) | `core/test/credentialFileGuard.test.ts` | Fixed |
| F24 | P1 (security) | The **persistent mobile pairing PIN** was written to `desktop-host.log` on every start (twice per line); production's log holds 46 such lines, in a file the credential guard does not cover | The line names only where the server listens (b351d4f) | `apps/desktop/test/mobileServerHost.test.ts` (+2) | Fixed; **rotate the PIN after deployment** |
| F8 | P1 | A model call that stopped producing output hung the turn forever | Stall watchdog: 300 s to first output, 120 s silence (db1c580) | `core/test/piOllamaStall.test.ts` (2 red → green; 7 now) | Fixed |
| F9 | P1 | Small models' tool calls were lost in parsing (`qwen2.5-coder:3b` wrote correct calls as JSON text) | Inline recovery on the native transport (4194959, 2e1e046) | `core/test/piOllamaInlineToolCalls.test.ts` | Fixed |
| F26 | P1 | (Found in adversarial review of this audit's own 4194959) recovery executed a call **followed by prose** and a call **cut off by the token limit** (a repair appended the brace) | Recovered only when the reply is nothing but complete JSON calls; never on `done_reason: length` (d222470) | `piOllamaInlineToolCalls` adversarial set (2 red → green) | Fixed |
| F25 | P1 | A successful consequential tool was reported as **refused** because its output contained refusal words (a passing test run printing "connection refused"; a file named `declined-*.md`) | Refusal read only from what the tool says about itself; declared success is performed (49233d9) | `core/test/turnOutcomeTextClassification.test.ts` (2 red → green) | Fixed |
| F22 | P1 | Reminders (personal data) were handed to every child, including Research | Only a child that may read the user scope receives them (41e8254) | `handoffFactsScope` reminders case | Fixed |
| F10 | P1 | Approval cards from delegated specialists did not say which agent asks | "<Agent> agent asks:" (8e7f252) | `agentDelegation` | Fixed |
| F11 | P1 | Attempts left `waiting_for_approval` with nothing pending were never settled (production holds 5) | Settled on boot (db1c580) | `bootReconciliation` | Fixed; the rehearsal on a copy of production showed 4 of 5 settle — the fifth is F29 |
| F29 | P1 | (Found by the rehearsal on a copy of production) a Saath loop parked on a governed approval was skipped at boot **whatever that approval's state**; production's attempt from 2026-09-11 waits on a card superseded on 2026-09-18, so it stays "waiting for approval" forever with nothing to approve | Kept waiting only while the awaited approval can still be answered; otherwise settled truthfully and its continuation closed (ad1b708) | `core/test/bootReconciliation.test.ts` "a Saath loop parked on an approval" (red → green) | Fixed; packaged rehearsal §G |
| F12 | P1 | Governed new-file creation and Kandev verification refused under an alternate path spelling | Canonical comparison (69317a1) | `governedNewFileCreation`, `kandevStoryAcceptance` | Fixed |
| F13 | P1 | The in-app updater's rollback force-killed PIDs without checking identity | Identity check before force stop (1e22de5) | `updaterForceStopGuard` | Fixed (ships with the installer) |
| F14 | P1 | Five of seven "timing-sensitive" CI files were F5/F12 plus one wall-clock assertion | Fixed; files back in the required job (69317a1) | 5/5 files, 68 tests pass with an 8.3 `TEMP` | Fixed |
| F23 | P2 | After Core routed a request to the specialist the user named, a second hand-off by the model started the same work again (second internet card) | Refused with the reason (41e8254) | `delegationPrivacy` routing case (red → green) | Fixed |
| F28 | P2 (tooling) | The CI Ollama stub bound `127.0.0.1:11434` beside a real Ollama; on Windows it then receives every **new** IPv4 loopback connection (see §I) | Refuses a port that is already served (726c51c) | `apps/desktop/test/ciOllamaStub.test.ts` + live check | Fixed |
| F30 | P2 | A database file that is **not** in WAL mode (e.g. a `VACUUM INTO` copy) gets its journal-mode header switched to WAL before a newer-schema refusal (bytes 18, 19, 27, 95; no data or schema change), while the message says "Nothing was changed". Pandesh's own databases are always WAL and stay byte-identical (unit test and rehearsal) | Recommendation: read the schema version before switching the journal mode | — | Residual |
| F31 | P2 (tooling) | `scripts/fetch-piper.mjs` keeps running ~4 min after "ready" (a kept-alive HTTPS socket and no explicit exit), stalling a fresh packaging run | Recommendation: close the agent or exit explicitly | — | Residual |
| F15 | P1 | Two morning briefings at 08:00 (`sched_c494ade1` model run, loads 17 GB `qwen3.8:27b`; `sched_1e652cb2` deterministic) | — | — | **Owner decision** |
| F16 | P2 | `idempotency_keys` grows ~34 K rows/day (desktop polls `offer-next` every 2.5 s) | — | — | Recommendation |
| F17 | P2 | 91 `task_outcomes` stay `in_progress` after their attempt ended (no UI reads it) | — | — | Not fixed |
| F18 | P2 | Historical residue: 5 pending approvals on finished attempts (Oct 16–19), 122 `pending` tool invocations, 2 `pending` model invocations | — | — | No action without approval |
| F19 | P2 | The release backup's `core.db` was opened in place after its manifest was written (still matches its hash) | — | — | Process note |

---

## C. Security gates (P0, mandatory)

| Gate | Cases required by the brief | Evidence | Result |
|---|---|---|---|
| **A. One Core per profile** | different tokens; stale PID metadata; normal shutdown; crash/restart; profile copies | `coreInstanceIsolation` (8): copy with same token, Build-160-style records, quit of a copy, copied ledger with another token, ledger bound to profile, update gate, Core 409 guard, **crash + PID reuse by an unrelated `node.exe` with every stale record pointing at it** (0bccfb0); `coreLauncher`; package level §G | **Pass** |
| **B. Private memory stays out of specialists** | direct recall; inherited conversation; summaries/handoffs; tool results; system prompts; nested delegation; Research/Sales with internet; canaries; no outbound leak | `agentMemoryAdversarial` (5, incl. Sales), `agentMemoryIsolation`, `handoffFactsScope` (6), `delegationPrivacy` (5): real engine + memory capability + delegate tool, a scripted model records every system prompt, history and offered tool list; synthetic canaries never reach a child that may not read them; specialists are never offered `delegate_to_agent`; a brief repeating a withheld fact is refused before any card | **Pass** (residuals §J) |
| **C. Verified backup before migration; newer schema refused** | backup independently restorable and matching; failure blocks migration; older build rejects newer schema unchanged | `migrationSafety` (6) + packaged rehearsal §G | **Pass** |
| **D. Auto grants never survive a Pandesh write under any spelling** | 8.3, junction, subst, mixed spelling; deny-when-required **and** allow-when-authorized | `permissionModes` (25): each alias covered while unchanged and voided by a write recorded under it; a junction inside the workspace prevents/voids a validation grant; `subst` case is opt-in (`PANDESH_TEST_SUBST=1`) and was run once here (mapping removed afterwards) | **Pass** |
| **E. Protected credentials not exposed** | model-facing file tools; trace logs | `credentialFileGuard` (25); `mobileServerHost` (PIN never logged). Production logs checked by exact match (values never printed): no `core.token`, `host.token` or `port-manager.token` value appears in `desktop-host.log` or `core.log`; no bearer headers | **Pass** after F24; existing 46 PIN lines remain in the old log until rotation |

No security check was weakened to make a test pass. Two tests were corrected where my own assumption was wrong (a creation-time window in the PID-reuse test; a grant that Core refuses outright instead of marking unverifiable), and both corrections are stricter, not looser.

---

## D. Execution invariants

| Invariant | Evidence | Result |
|---|---|---|
| Parent → child cancellation | `core/test/delegationCancellation.test.ts` (new, real API + executor + engine): stopping the parent while its Coding child runs a real command kills the command's process tree, settles **both** attempts `cancelled`, leaves no tool call open, and nothing continues (no late write, no further model call). Removing the delegate tool's abort link makes the test fail (mutation check) | **Pass** |
| Child approvals surface; unanswered cards end | Child cards are listed in the delegating conversation and name the agent; tool cards wait ≤ 15 min, web cards ≤ 60 s, then are **expired with the reason in a runtime event** (never as a refusal); stopping the task while a child card is unanswered expires it and the command never runs (`delegationCancellation` case 2); waiting-with-nothing-pending settles on boot, and so does a Saath loop parked on an approval that can no longer be answered (F29) | **Pass** |
| Model-call deadline | `piOllamaStall` (7): no output, mid-stream silence, disconnect → clear reasons; steady slow stream and a slow first answer (model loading) are **not** cut off; Stop before/while streaming ends at once as a cancellation, not a stall | **Pass** |
| Retry / idempotency | API idempotency keys dedupe retries; occurrences claimed before running; boot reconciliation never replays; uncertain writes are not repeated; no reroute after a mutation | **At-most-once automatic execution. Exactly-once is not claimed:** a crash between a side effect and its record leaves the effect applied and the attempt failed; a manual retry could repeat it |
| No false refusal / false success | Tool status comes from structured flags; F25 fixed; delegation verdicts read the hand-off's own first line | **Pass** |

### Fault-injection matrix (synthetic data, isolated processes)

| # | Scenario | Expected | Actual | Evidence |
|---|---|---|---|---|
| 1 | Model unavailable before execution | Auto never selects it; explicit model → clear failure | as expected | remediationD6D9D13 |
| 2 | Model disconnect mid-reply | "lost the connection" | as expected | piOllamaStall |
| 3 | Model stalls | bounded, clear reason | **hung → fixed** | piOllamaStall |
| 4 | Invalid tool arguments (incl. recovered inline calls) | validation feedback, nothing runs | as expected | piInlineCallGates |
| 5 | Tool command failure | exit code + truthful verdict | as expected | benchmark T4 |
| 6 | Approval rejected (native and recovered inline call) | nothing written | as expected | piInlineCallGates, approvalRejectionTurn |
| 7 | Approval never answered | bounded, expired with reason | as expected | delegationCancellation, bootReconciliation |
| 8/9 | Parent stop with a running / waiting child | process killed, both cancelled, nothing continues | as expected | delegationCancellation |
| 10/11 | Shutdown during a task; Core crash + restart | interrupted, not replayed; fresh Core | as expected | executionSurvival, bootReconciliation, coreInstanceIsolation |
| 12 | Interrupted file write | only created dirs rolled back | as expected | governedNewFileCreation |
| 13 | Duplicate / replayed operation | deduplicated | as expected | idempotency, revenue dedupe |
| 14 | Unauthorized memory (direct / hand-off / brief / history) | refused or filtered | **3 paths fixed** | delegationPrivacy |
| 15 | Filesystem escape (names, junction, alias) | refused / asked with real path | **fixed** | agentPathScopeBypass, piJunctionScope |
| 16 | Cross-profile connection | own Core only | **fixed** | coreInstanceIsolation |
| 17 | Stale Core metadata, PID reuse | fresh spawn; unrelated process untouched | as expected | coreInstanceIsolation |
| 18 | Conflicting scheduled executions | once per occurrence | holds; duplicate *schedules* exist (F15) | scheduler review |
| 19 | Network timeout | — | not separately injected | residual |

---

## E. Model effectiveness (tool selection vs. true completion)

Real Core path: an isolated Core, `/v1/submit` + `/v1/attempts/:id/execute`, a fresh synthetic workspace per run. The harness approves only actions inside the throwaway workspace and **declines external coding agents by design** (T8 measures the *choice*). Stage attribution comes from Core's own records. Nine tasks: list, read, reminder, run tests, fix bug, record lead, printers, "use Aider", arithmetic. T4's workspace contains a deliberately failing test, so a correct T4 reports that failure.

| Model (task-aware selection, 17–43 of 152 tools offered) | Right tool reached | Completed end to end | Notes |
|---|---|---|---|
| `gemma4:12b` | 9/9 | 6/9 with a passing outcome; +T4 failing test reported truthfully; T5 completed (14 s) once its write authorization was approved; T8 declined by harness policy | ~6 s/turn warm (4–14 s); 13–29 K prompt tokens |
| `qwen3.8:27b-mtp-q4_K_M` | 9/9 | 5/9 passing; +T4 truthful, +T6 duplicate lead correctly refused and reported; T5 completed (40 s) once approved; T8 policy | ~13 s/turn; cold load 21.9 s |
| `qwen2.5-coder:3b`, before F9 | **0/9 executed** (8/9 correct calls written as JSON text) | 1/9 (T9 answered without the tool) | failure stage E (parsing), not A |
| `qwen2.5-coder:3b`, final code (d222470) | **7/9** (T1, T2, T4, T6, T7, T8, T9) | **5/9** passing (T1, T2, T6, T7, T9) + T4 truthful = 6/9; T8 policy; T3 malformed arguments then prose; T5 asked for information instead of reading the file | re-run on the final recovery rule: identical to the first post-fix run |
| `gemma4:12b`, whole catalog (151 tools) | 8/9 | 7/9 | 82 K prompt tokens; 64 K context → two model reloads per turn; ~24 s/turn |

- **Failure classes:** exposure (D) 0; parsing (E) fixed; permission/approval (F) only where the harness declines by design; execution (G) only T4's planted failing test; model capability (A) remains for the 3 B model (T3 arguments, T5 initiative).
- **Small vs broad tool sets:** same correctness at ~4× time and ~5× prompt with the whole catalog, which also crosses the 32 K window that keeps `gemma4:12b` in VRAM. **Keep task-aware selection.**
- **Observed (not changed):** the agent loop executes a tool the model *names* even when it was not offered this turn; selection limits what is offered, not what may run. Every consequential tool keeps its own gate (approval, scope, egress); verified for `write_file` (inline and native) and for `delegate_to_agent` (F23). Making execution offered-only is a separate design change.
- **Conclusion:** at 12 B and above, orchestration works and remaining misses are ordinary model variance. The 3 B model was limited **primarily by orchestration** (parsing) until F9; what remains is model capability.

---

## F. Changes (commits on `fix/post-v2-max-audit`)

| Commit | Scope |
|---|---|
| 1e22de5 | Instance-ownership invariant (launcher, desktop shutdown, update gate, Core 409 guard, lock/claim `dataDir`, Build 160 records, provenance profile binding); updater force-stop identity check; rehearsal clone tool |
| fd6cfff | Hand-off facts scoped to the child; every path-like argument gated; Pandesh secrets on the credential list |
| db1c580 | Model stall watchdog; boot settlement of attempts waiting with nothing pending |
| ead6b93, a644a2c | Verified pre-migration backup; newer-schema refusal; prune by age |
| 8e7f252 | Cards name the asking agent; offered tools in `tool_selection`; benchmark harness |
| 69317a1 | Canonical path comparison (Auto grants, governed writes, Kandev); CI job re-scoped |
| 4194959, 2e1e046, 4cb6733 | Inline tool-call recovery; disconnect fault test |
| 726c51c | CI stub refuses an occupied port |
| 0bccfb0 | Crash + PID-reuse isolation test |
| 41e8254 | Team-view delegation in its own conversation; brief check; reminders scoped; no second hand-off after Core routing |
| e70569d | Backup-failure and independent-restore tests; Auto alias matrix (junction, case, `\\?\`, subst) |
| b351d4f | Pairing PIN no longer logged |
| 3f29fad | Parent→child cancellation and unanswered-card regressions; deadline cases |
| 49233d9 | No false refusal from output text |
| d222470 | Inline recovery only for a reply that is nothing but the call |
| 8df8bd4 | Real-location folder checks (Pi file tools, agent scope gate) |
| a7d5ccf | Build number 161 |
| ad1b708 | Boot settles a Saath loop parked on an approval that can no longer be answered (F29) |
| e88bdc5 | Test sample data uses a documentation address |

**Behaviour changes the owner will notice:**
1. A specialist's folder scope is hard for every path-taking tool. In Build 160 a specialist (e.g. Operations) asking for another folder got a "May I search …?" card; Core now refuses it. The user's own Pandesh turn still asks.
2. Delegations started from the **Team** view open their own conversation; the result appears there, not inside the chat it was started from.
3. A delegation whose brief repeats stored private memory the specialist may not read is refused with the reason; the model can rewrite the brief, or the user can state the information in their own message.
4. Reading through a junction that leads out of the workspace now asks, naming the real folder; agents are refused.
5. Reminders are no longer handed to Research, Coding or Operations.

---

## G. Build 161 candidate and rehearsal

Built with the existing packaging path (`npm run desktop:package`, `npm run desktop:installer`, Inno Setup 6.7.3 as pinned) from a **clean worktree at `e88bdc5`**. Nothing was installed into `E:\Pandesh`; the production profile was only byte-copied, while Pandesh was not running.

| Check | Result |
|---|---|
| Build identity | v0.1.8 **Build 161**, `buildKind: release`, channel alpha, commit `e88bdc5`, `sourceState: clean`, built 2026-11-10 05:50Z; Electron 45.2.3 |
| Artifacts (local, not published) | `D:\Projects\Pandesh-audit\.tmp\rc-b161\dist\`: `Pandesh-Setup.exe` (355,583,486 bytes, SHA-256 `55E5AB58598E5A002253D47902EAA593C066325EC009BD5ED1305B31D3674CB9`), `Pandesh-Smoke-Setup.exe` (SHA-256 `A021458828646EDF1ADBE68F286C1E636AD42C49080669B0FB55F8FF7E7E544E`), portable tree `pandesh-win32-x64` |
| Package smoke (portable build, isolated profile: start → Core → models → one local question) | **Pass** (`ok: true`): Core connected, local models listed, a model selected, local speech and wake word available, the question about `package.json` answered in 26 s |
| Installer smoke (separate Smoke edition: own AppId, scratch install dir, isolated profile, governed read-only capability, uninstalled; the owner's AppId checked before and after) | **Pass, 14/14**: installed, a governed read-only capability ran, hidden to tray, upgrade while running, previous instance stopped cleanly, upgraded app connected, user data preserved, uninstalled, owner installation untouched |
| Downloaded assets without a pinned digest (§J) | wake-word models 4/4 and Piper binaries/voice 7/7 identical (SHA-256) to Build 160's shipped copies |
| **Rehearsal A**: packaged Core on a scrubbed clone of production (no secrets, schedules disabled, no live identity) | **Pass**: Core served the clone's own data directory and stopped cleanly; schema 50 → 50, `quick_check ok`; 97 conversations, 956 messages and 2 memory facts unchanged; no migration and no backup needed; **all 5 stuck attempts settled** (4 capability anchors completed, 1 failed truthfully — F29); the 5 historical pending approvals untouched |
| **Rehearsal A rollback**: Build 160 Core (built from `abb0cc4`) on the database Build 161 ran on; byte restore of the pre-run copy | **Pass**: Build 160 started on that database and stopped cleanly (schema 50); the pre-run copy restores byte-identical |
| **Rehearsal B**: packaged upgrade on a synthetic previous-schema database | **Pass**: a verified backup `core-schema49-….db` (schema 49, `quick_check ok`) before the upgrade to 50; the restored copy is schema 49 with its data |
| **Rehearsal C**: database from a newer build | **Pass**: refused (exit 1, "newer Pandesh (schema 9999) …"), the (WAL) file byte-identical; see F30 for a non-WAL file |
| **Rehearsal D**: the packaged app launched on a copied profile (same token) while another profile's Core runs | **Pass**: the copy started its own Core for its own data directory; the other profile's Core was untouched while it ran and alive after it quit; the host log holds no pairing PIN |
| Start menu / path ownership | `C:\ProgramData\…\Pandesh\Pandesh.lnk` → `E:\Pandesh\electron\Pandesh.exe E:\Pandesh\app`; the updater's identity-checked force stop expects exactly `electron\Pandesh.exe` and `runtime\node.exe`, both present in the installation. The Smoke edition creates no Start-menu entries |
| Production after every step | **Unchanged**: `E:\Pandesh` still Build 160 (`abb0cc4`), newest file from its install (2026-11-09 21:01); Start menu unchanged; no production process; profile `core.db` unchanged (last write 2026-11-09 22:10:30, hash equal to the copy taken before the rehearsal). Every copy of production data was deleted afterwards |

---

## H. Final verification (one pass after the last code change, HEAD `e88bdc5`, this machine)

The pass was run on `8df8bd4` and, after the rehearsal found F29, once more on `e88bdc5`; the numbers below are the second run.

| Suite | Result |
|---|---|
| Type checks as CI runs them (`tsconfig.core.json`, root, renderer-v2) | **clean** (3/3) |
| Core, required set (`core/test` minus the 2 non-blocking files) | **270 files passed, 8 skipped; 2,679 tests passed, 16 skipped, 0 failed** (126 s, 4 workers) |
| Core, non-blocking (`missionVerification`, `runtime`) | 2 files, 42 tests passed |
| Desktop (`apps/desktop/test`, as CI; real Ollama answering the model list, no stub) | **87 files passed, 1 skipped; 632 tests passed, 3 skipped, 0 failed** (35 s). The skipped file is `pocketTtsSession` (runs only with the optional Pocket TTS engine). Baseline 618/618 in 84 files (fe7c8b6); the difference is new regression tests |
| `src/test/suite` (editor-extension tests, not run by CI) | 351 files passed, 4 skipped; **3,417 tests passed, 34 skipped, 2 todo, 1 failed**. The failure, `m12RetrievalIntegrationPackaging` "packages into a test-owned temporary directory…", is **environmental**: `vsce package` runs `npm ls`, which reports missing/extraneous packages in the junctioned `node_modules` tree. The same command fails identically on Build 160 source (`abb0cc4`) with the same modules, and the branch changes no dependency manifest. |
| The 5 reclassified CI files with `TEMP` = an 8.3 short path | 5/5 files, 68 tests passed |
| CI on GitHub | Runs on the pull request; required job `test` (see the PR). The two non-blocking files run in `timing-sensitive` |

---

## I. Incident during the audit (disclosed in full)

- **What happened.** On 2026-11-09 at 23:49:52 (local) my background test command started `scripts/ci/ollama-tags-stub.mjs` **in the foreground** (CI runs it in the background). It never exits, so the desktop suite never started and the task showed a 5-hour runtime. The stub also listened on `127.0.0.1:11434` beside the real Ollama (`[::]:11434`) until I stopped it at 05:29:53, **5 h 40 min**.
- **Effect.** On Windows a new IPv4 loopback connection goes to the more specific listener (reproduced on spare ports: `evidence/post-v2-max-audit/loopback-shadow-matrix.txt`). A local client calling Ollama at `127.0.0.1` in that window got the stub's fake model list or a 404. **Pandesh production was not running** (quit 99 minutes earlier). Other local Ollama clients in that window cannot be ruled out: the stub logged nothing.
- **Containment.** Only the test-owned shell (PID 49300) and stub (PID 48540) were stopped, after their start times and command lines were verified; the real Ollama answered `127.0.0.1:11434` again immediately.
- **Prevention.** The stub now refuses a port that is already served (726c51c; checked live: exits 1, binds nothing). The final pass ran with no stub at all.
- **Also:** while writing one engine test, a request with a synthetic prompt reached the real local Ollama once and was refused there (it named a model that does not exist). The test now imports the engine only after pointing it at its scripted model.

---

## J. Residual risks (not fixed in Build 161)

- The public-query guard recognises private text by 4-word overlap; a 2–3-word private name in a short query is not caught. Mitigated: internet-capable specialists no longer receive user-scope memory or reminders.
- The brief check (F21) is a heuristic (pairs of significant words): a paraphrased private fact is not recognised, and a brief sharing a pair with a stored fact can be refused (the model then rewrites it).
- `task`/`project` memory is not bound to a task/project id; agent limits (`maxSteps`, `maxWallSeconds`) are declared but unenforced; URL arguments of network tools are not checked for private text; `run_checks` is governed by its card, not by the egress gate.
- Tools are executable when named even if not offered (§E).
- PID reuse is detected by creation time with 1.5 s tolerance: a reused PID running the **same executable** within 1.5 s of the original's creation would pass; the Core must have crashed in that window.
- Time-of-check/time-of-use: a link swapped inside the workspace between the check and the read is not detected (needs a local process already able to write there).
- The installer's `upgrade-shutdown.iss` sends an unaddressed shutdown (default profile only); the updater fix reaches users only through the next full installer.
- Voice/microphone still needs a human test; the ChatGPT-automation overlap was not examined (no authorized integration).
- Build supply chain: `scripts/fetch-openwakeword-models.mjs` (wake-word ONNX models) and `scripts/fetch-piper.mjs` (Piper zip and voice) download from pinned release URLs **without verifying a pinned digest** (Piper's zip hash is only recorded); only the Gmail transport (`gws`) is strictly digest-pinned. For this candidate the downloaded files were compared with Build 160's shipped copies (§G). Recommendation: pin their SHA-256.
- Test hygiene: new tests use a documentation address (192.0.2.10) as sample LAN data; consider the same for the older `mobileServerHost` override test.

## Evidence index

`docs/audits/evidence/post-v2-max-audit/`: `loopback-shadow-matrix.txt`, `ci-8dot3-five-files.txt`, `bench-qwen2.5-coder-3b-final.txt`, `final-suites.txt`, `rc-b161.txt`. Test files are named in §B–§D. No database, profile, log with user content, backup or secret is committed.
