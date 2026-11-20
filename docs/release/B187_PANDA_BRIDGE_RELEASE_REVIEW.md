# Build 187 release review - Panda Bridge integration

Status: **review and preparation only. Nothing has been merged, installed, or changed in production.**
Date: 2026-11-20. Recommendation: **GO, subject to the conditions at the end** (decision belongs to the owner).

## 1. Release scope

Production today: Build 186, commit `0d04fde` (= main `7379301` + bump), `E:\Pandesh`.

Release candidate: branch `release/b187-panda-bridge` at commit **`f4cc50a`** = `0d04fde` + 19 commits (worktree `D:\PandeshRelease187`).
It was built from a clean checkout: `build-identity.json` says buildNumber 187, commit f4cc50a, sourceState clean.

| Release commit | Content |
|---|---|
| bfd0c09, 9224ae4 | service executors on the bridge (deterministic, no model); re-probe of a stale failed Kandev capability |
| d96ed2d | Hermes discovery: launcher runs the real `acp --check` once; shim answers Kandev's 5 s probe (dev tooling only) |
| 79cd98d, ee9a8ab | capability registry + workflow router; lifecycle recovery tests |
| 9f68bf6, 6e5e158 | **only their non-tool parts survive** (see exclusion below): workflow fallback step, extract-document workflow |
| afa145c, 2094d11 | browser report fixes (line breaks, scrubbing, draft kept, no duplicate insert); closed shadow root + trusted-event gate |
| d48fb8d | installer refuses to register the native host under a packaged-app process tree |
| d2142f6, 16da573 | real execution states, model-call tracker, unified activity feed (`GET /v1/bridge/activity`), `app-target`, Open in Pandesh navigation (renderer handler), mission dock cards, honest mission clock, no silent executor in the dropdown |
| c9f89ea, f725f77 | daily-brief workflow (deterministic collection + optional model summary), per-step workflow time limits |
| c8f4846 | second native host per extension with its own pairing key; launch options for Open in Pandesh |
| 823ae4a | native tasks carry their answer (worker-only); directory counts report hidden entries |
| 092d54d | **release cut:** removes the tool-backed PDF/OCR/Tailscale services (see below) |
| 316a994 | compatibility tests (previous-release records, report wording/sanitization) |
| f4cc50a | Build 187 bump |

37 files changed (+1,894/-41 before the cut). No dependency change (package.json / lockfiles untouched). **No database migration** (`core/db` untouched; schema stays 55).

### Deliberately excluded
* **Stage C** (11 commits `7bf84cc..d2eeaaa`: Outcome Receipt builder/API, Mission Control pane, Rehearsal pane, receipt UI). Not in the release diff (checked: no file matching receipt/rehearsal/missioncontrol/stage).
* `core/test/outcomeReceipt.test.ts`: the owner's uncommitted edit was swept into dev commit `6537480` by an over-broad `git add core`. It does not exist in production, so the cherry-pick conflicted; the file was dropped from the release. (On the dev branch it is still part of `6537480`; tell me if you want it split back out.)
* Main commits after production: `#129` (the Build 186 bump merge) and `#130` (DRV-010 file-overwrite guard) are on main but **not** in this release; they are unrelated and can follow separately.
* **Tool-backed services** (`doc.pdf-text`, `doc.ocr`, `doc.pdf-ocr`, `net.tailscale-status`): they import `child_process`, and the M54 static architecture guard (`core/security/architectureGuard.ts`) allows that only from a host-reviewed allowlist. The full test run caught it (`Reality J` failed). They are out of this release; the next phase must reuse the already-allowlisted `core/runtime/documentOcr.ts` or get an allowlist review from the owner.
* The Hermes isolated provider config (Hermes still cannot run a task; not needed by this release).
* The untracked `apps/panda-bridge/mcp-server/` and the Stage C Core are untouched.

## 2. Compatibility

| Area | Result |
|---|---|
| Database | No migration. New code reads existing columns only. `bridge_task_checkpoints.snapshot` exists in the production schema (migration 1701). Previous-release rows (no task class, sparse source refs, old result shape, every old status) render without error: `core/test/bridgeReleaseCompat.test.ts`. |
| Existing missions / conversations | No mission or conversation code changed; mission card changes are presentational (active time instead of time-since-created). Mission and conversation suites pass identically to production (below). |
| Production data, credentials, pairings, permissions | Not touched by the code; the install procedure keeps the profile in place (backup first). Extension pairing state lives in the browser (`pandaBridge`); the new per-host key never touches it. |
| Extension | New extension against production Core b186: worked in real Chrome (submit, state, report, synthetic-event block). Old extension against new Core: the new `activity` field is additive and ignored (by inspection, not run). |
| Native host | New host fallback needs the refreshed host script (the installer copies it to `%LOCALAPPDATA%\Pandesh\PandaBridge`). Old host + new Core: works by inspection, not run (Open in Pandesh needs the configured exe path as before). |
| Executors | Explicit choice is never replaced; `auto` routing excludes external executors unless the host allows it; a failed explicit executor is refused, not substituted. Production Launch sets `KARKEDIKHA_MODEL_ROUTING_POLICY=local-only`. Tests: `pandaBridge.test.ts` (no substitution, consent gates), `capabilityRegistry.test.ts` (external excluded, refusal not fallback). |
| Report wording / sanitization | Verified in real Chrome and in `bridgeReleaseCompat.test.ts` (paths, UNC paths, home paths, tokens removed; native result shown as "the executor's own report, not independently verified"). |

## 3. Regression evidence (release commit f4cc50a)

* Typecheck: core and renderer-v2 clean.
* Full core suite: **3 failed / 3,458 passed / 39 skipped**. The same 3 fail on the production commit `0d04fde` (`bots.test.ts` quiet-run, `hermesProviderRouting.test.ts` x2): **pre-existing, not caused by this release**.
* Desktop suite: **10 failed / 969 passed**; production baseline is the same 10 in the same 3 files (`desktopConversationSelection`, `missionCockpitSession`, `workspaceSelection`): pre-existing.
* Architecture guard (M54 Reality J): fails with the tool-backed services, passes after the cut.
* Package build and `desktop:package-smoke`: exit 0 (6 s and 56 s), installer `Pandesh-Setup.exe` and staging payload produced.
* Dev acceptance in real Chrome against an isolated dev Pandesh: submit, explicit native choice that does not reset, state/reason/active time/heartbeat, Open in Pandesh navigation, report preview/insert, draft preserved, duplicate blocked, no auto-send, synthetic events blocked. Fix verification (hidden entries, native result) on the real model.

Not verified: a real-Chrome run against a Build 187 production Core (cannot exist before install), "Waiting for model/GPU" in a live run (unit-tested only).

## 4. Deployment strategy (Build 187) - for approval, not started

Pattern: the Build 186 procedure (`D:\PandeshAssistantDev\rel186`). Prepared so far: `D:\PandeshAssistantDev\rel187\rc-build-b187.ps1` (already run, touched nothing in production). Still to derive on approval: `install-b187.ps1` from `install-b186.ps1` (build 186->187, rollback `E:\Pandesh-b186-rollback`, backup `D:\PandeshBackups\b187-upgrade-<ts>`, payload `D:\PandeshRelease187\dist\pandesh-installer-staging`) and `verify-b187.mjs`.

1. Owner says: "Yes, install Build 187 now" (the auto-mode classifier needs the action named).
2. `idle-check.mjs`: refuse unless Core idle and no user message in 5 minutes. (The research mission from 11-20 must be finished or deliberately stopped by the owner first - the app stops with `--shutdown-for-upgrade`, which interrupts a running mission; it can be continued afterwards.)
3. Stop: graceful `--shutdown-for-upgrade`, wait for no `E:\Pandesh` process, stop only an orphaned Core.
4. Backup: byte-copy of the stopped profile (`%LOCALAPPDATA%\KarkeDikha\desktop`, ~1.3 GB) with sha256 manifest verified against the live profile; manifest the Build 186 app; rename `E:\Pandesh` -> `E:\Pandesh-b186-rollback`.
5. Install: copy the staging payload into `E:\Pandesh`, keep the uninstaller, verify every file against the payload manifest. Preferences untouched.
6. Start Pandesh from its shortcut; run the smoke tests.
7. Chrome: reload the extension on `chrome://extensions`; from a Win+R `cmd`, re-run the native-host install for the production data dir (idempotent; refreshes the host script):
   `node D:\Projects\Pandesh\scripts\panda-bridge\install-native-host.mjs --check`, then
   `... --data-dir "C:\Users\siddh\AppData\Local\KarkeDikha\desktop" --browser chrome`.
   Pairing survives (token is in extension storage and in the Core database).

**Expected downtime:** about 5-10 minutes (dominated by the 1.3 GB profile copy and verification; Build 186 took the same path).
**Migrations:** none. **Dependencies added:** none.

### Rollback
No schema change, so no profile restore is needed. Stop Pandesh, rename `E:\Pandesh` -> `E:\Pandesh-b187-failed`, rename `E:\Pandesh-b186-rollback` -> `E:\Pandesh`, start. The profile backup stays as a safety net. The extension and native host are backward compatible with Core b186 (verified against production b186 today); if rolled back, no browser change is required.

### Post-install smoke tests
1. Core health 200; DB `quick_check` ok; conversation count unchanged (162 at b186); host log has no errors; start-at-login entry present; phone still paired.
2. Open an existing conversation and an existing mission card (history intact).
3. `GET /v1/bridge/activity` (through the app's Missions dock): the two existing production bridge tasks render with a state, not an error.
4. Existing completed task from the earlier test ("List the filenames...") shows "Completed".

### Short real-Chrome regression (10 minutes, after install)
1. In ChatGPT submit the harmless task "List the filenames in the authorized workspace and report the count. Do not read file contents, modify files or invoke external services." (Panda Mode send). Card: "Waiting for executor", nothing preselected, Start disabled.
2. Choose "Pandesh (native Windows capabilities)", wait 10 s (no reset), Start. The card shows Running with active time and heartbeat; the task appears in the Pandesh mission dock as "From ChatGPT".
3. "Open in Pandesh" focuses the running app on that task's conversation.
4. On completion the result mentions hidden entries; the card says "Not independently verified (the executor's own report)".
5. Preview -> Cancel (draft intact) -> Insert (draft kept) -> Insert again ("already in the composer"); nothing is sent; no local path appears.
6. With Panda Mode ON, a page-script Enter/click/submit creates no task.
7. Cloud agents stay disabled in the dropdown; confirm no ChatGPT/OpenCode/Claude run started.

## 5. The 156 s native directory listing (finding, not a release blocker)

From the dev Core's own records (task `ptask_c474e791`, attempt `att_e56751f4`):

| Segment | Time |
|---|---|
| submit -> dispatch -> attempt running | 0.4 s |
| model inference (`qwen3.8:27b-mtp-q4_K_M`, `model_invocations`) | 154.6 s of 156.0 s (99%) |
| `list_directory` tool | 10 ms (executed 71 s after start) |
| bridge bookkeeping after the answer | under 1 s |

Two model rounds (about 71 s to decide the tool call, about 84 s to write the answer). The model call was streaming tokens (the tracker never reported "waiting for first token"), so this was slow decoding, not queueing at the bridge. The model runs 26%/74% CPU/GPU (24 GB card full) and the production mission was using the same Ollama model concurrently (three steps), so contention likely contributed; it was not measured separately. The daily-brief summary (240 s) shows the same pattern.

**Input for the Capability Registry:** a request that is only "list / count files" is a deterministic task (`fs.inspect` already lists a directory in milliseconds and would have been exact, including hidden entries). The router should send such task classes to a deterministic service and reserve the model for interpretation. Record per-class latency in `trackRecords` so the router can prefer deterministic executors for latency as well as safety. Time-to-first-token should be recorded alongside total inference time.

## 6. Cleanup inventory (nothing deleted)

| Item | What it is | Credentials? | Proposal |
|---|---|---|---|
| `D:\PandeshLiveCore` (6.8 MB) | scratch Core data + harness evidence | scratch `core.token`, host token, `harness-state.json` (scratch pairing tokens) | delete after owner OK; keep `harness-result.txt` if evidence wanted |
| `D:\PandeshAcceptDev` (16 MB) | dev Pandesh profile, dev native host files, scripts | dev `core.token`, `host.token`, `ui-check.json`/`fix-verify.json` (dev pairing token) | uninstall dev host first (command below), then delete |
| `D:\kkh` | scratch Kandev home | none known | delete after owner OK |
| `D:\PandeshOcTest.SYAs` | earlier OpenCode scratch | none known | delete after owner OK (earlier delete was blocked by the safety check) |
| `D:\PandeshRelease187`, `D:\PandeshProd186` | git worktrees of the release candidate / production commit | none | keep `PandeshRelease187` until the release is decided; `git worktree remove` for `PandeshProd186` |
| HKCU `com.pandesh.panda_bridge_dev` | dev native-host registration | none | `node scripts\panda-bridge\install-native-host.mjs --uninstall --host-name com.pandesh.panda_bridge_dev --install-dir "D:\PandeshAcceptDev\PandaBridge"` from a Win+R cmd |
| `%LOCALAPPDATA%\PandeshNM` | empty folder from my diagnostics | none | delete |
| `%TEMP%\live-oc-*`, `panda-*` temp folders | test temp data | none | delete |
| Extra `chrome://extensions` tab in Chrome | mine | none | close |

Preserved on purpose: `apps/panda-bridge/mcp-server/` (untracked, not mine), the Stage C Core (`D:\PandeshStageCDev`, pid 37676), all production data.

## 7. Decision gate

**GO**, conditioned on:
1. Owner approval naming the install ("Yes, install Build 187 now").
2. Production idle (or the owner stops the running research mission knowingly).
3. The Stage C branch is **not** merged/deployed with this; only `release/b187-panda-bridge` (f4cc50a) is.
4. The extension keeps loading from `D:\Projects\Pandesh\apps\panda-bridge\extension`; **do not check out another branch in that folder** while the extension is in use (the live extension is that working tree, and moving it would drop its stored pairing).
5. The three pre-existing core and ten desktop test failures are accepted as pre-existing.

Known limitations after release: result of a native task is the model's own report (worker-only); "Waiting for model/GPU" seen only in unit tests; workflow runs block their HTTP request up to 15 minutes; workflow-created tasks are labelled "From ChatGPT"; production research missions still compete for the same local model (browser tasks now take priority at model/tool boundaries, bounded).
