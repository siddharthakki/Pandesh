# Priorities 1-4: approval card, legacy isolation, JUGAAD Android, reprocess (2026-11-20)

Dev branch `feat/stage-c-vertical-slice` (Pandesh) and `feat/pandesh-documents` in a local clone of JUGAAD (`D:\PandeshJugaadDev`, from `main` fa38ee9; the user's own checkout on the NAS was only read, never modified, nothing pushed). Nothing merged or deployed. All live evidence ran on the isolated dev Pandesh (`D:\PandeshAcceptDev`).

## P1 - ChatGPT -> Pandesh -> Claude Code with an approval card
- Browser dropdown lists Claude Code ("cloud, needs your approval in Pandesh") when available. Choosing it and pressing Start only ASKS: Core records an approval request, nothing is sent, nothing is copied, the card says so.
- `core/domain/bridgeApprovals.ts`: request/decide/expire/supersede events in the task's own checkpoint trail (no migration). Scope = executor, model, project, branch, access level, instruction SHA-256, confidential override, context flag; expires after 30 min; a decision for another request id is refused.
- Pandesh (Missions dock) shows: agent, who receives the data, project, branch and commit, project access, what the agent may do, what leaves the PC (incl. uncommitted files that are NOT part of the copy), the exact task text; Allow or Don't allow; a separate checkbox for confidential tasks.
- Refusal ends the task (cancelled, control=cancelled, no executor, no copy); every later dispatch is refused - no Qwen/OpenCode substitute is ever started. Approval starts exactly the approved executor; direct host-API authorisations are audited with the same fields.
- Host-only routes: `GET /v1/bridge/approvals`, `POST /v1/bridge/tasks/:id/approval`, `GET /v1/bridge/tasks/:id/audit`; a paired browser gets 403 on all three and learns only "approval pending for <agent>".
- Read-only inspection mode and the private clone are unchanged (clone has no remote; owner path reads refused).
- REAL acceptance (real Chrome + real ChatGPT + real Pandesh window, no host API by me):
  - Approve: selected Claude Code in the extension dropdown, Start -> card "Waiting for approval - Nothing has been sent" -> in the Pandesh window pressed "Allow Claude Code for this task" -> task `ptask_29a30696` ran on `claude`, completed, audit `requested by extension:pair_... -> approved by host:jarvis` with scope; "Send report to ChatGPT" inserted the report (paths redacted, labelled "executor's own report, not independently verified") into the composer (not sent; draft cleared).
  - Refuse: same flow, pressed "Don't allow" -> task cancelled, executor null, no story, no workspace, audit `requested -> refused by host:jarvis`, Pandesh and Core both say "Nothing was sent, and no other executor was used".
- Result classification: Claude's report is worker-only. Its one finding (a stale test `core/test/pandaBridge.test.ts` still expecting the old 403 after the approval change) was VERIFIED independently by me (the test failed exactly as described) and fixed; the rest of the report ("no other defects") is Claude's own claim.

## P2 - legacy sync records follow household access
- Rule (`visibleToDevice`): `hh_...:` records only for that household; older records (important dates, briefings, task status) are visible only to phones with no household until the owner names an owner household (`POST /v1/jugaad/legacy-owner`, host only, logged); then only that household. A household phone never sees them unless its household is the named owner. Nothing is migrated or assigned automatically (tested: creating households and attaching phones changes no record and names no owner).
- Phones cannot act on records they cannot see (push is rejected exactly like an unknown record).
- Tests (real TLS protocol, real sealed calls): two households + an unattached phone + legacy records: records, sync data, search, documents, task status, push ops, folders all isolated both ways.

## P3 - real JUGAAD Android app
- Installed app 1.0.30 had the record-sync client but NO document features, so the existing app was extended (same pairing, same encrypted `PandeshSyncClient.call`, same WorkManager sync - no new framework): `PandeshDocumentUploads` (one meta file per queued item, single-flight drain, resumes from the PC's offset), `PandeshUploadLogic` (pure, 6 JVM tests pass), `PandeshDocumentsCard` (household, add document/photo through the system picker, per-item status, search), worker drains the queue, inbox shows document refs.
- Demonstrated on the Pixel_10_Pro_XL emulator with a dev build beside the real app (real phone untouched): authenticated pairing (pinned certificate; the app also refused a stale pairing with "certificate changed"), household shown ("Emulator Home"), PDF -> Telekom 1234.56 EUR, text receipt -> REWE 3.68 EUR, photo -> OCR "read from the picture" EDEKA 12.00 EUR, search "coffee" finds the photo, 12 MB upload cut by switching the emulator's network off mid-way, resumed from the server's offset after restart and after reconnect, stored original byte-identical (SHA-256), other household's document invisible in the app ("Nothing found").
- Found and fixed by the live run: a queue-file wipe (two runs overwriting one list file) -> one file per item + process-wide lock; documents over 2 MB lost their total -> beginning+end parsing; card did not follow pairing.

## P4 - reprocessing
- Owner-authorised (`POST /v1/jugaad/households/:id/reprocess`, host only; named documents or scope "outdated", max 50), run as tracked internal tasks. The original is never written (hash must still match or nothing changes), results replace only the CURRENT text/fields/search entry; append-only `processing_runs` history with field-by-field diffs, who, why, pipeline version. A run that loses previously found text is kept as history but does not replace the result. Unchanged re-runs change nothing and publish nothing.
- Live: the 12 MB statement had total 64.74 EUR (old parser); after pipeline v4 + reprocess: 4321.09 EUR, history shows intake (v3) and reprocess (v4) with `totalCents 6474 -> 432109`; the phone's search shows the corrected total.

## Verification
- Independently verified (code or protocol, deterministic): approval gating/scope/expiry/refusal, audit trail, route authorisation, household isolation incl. legacy, resumable upload byte-exact, reprocess history, Kotlin logic (6 tests), UI states seen in real windows.
- Agent-reported only: Claude Code's inspection report (worker-only); OCR text (worker-only label).
- Full core suite: see the final message (one failure, `bots.test.ts`, pre-existing and unrelated).

## Remaining blockers / open items
- Android: the item summary in the phone's upload list is the value at intake time; search shows current values after a reprocess (a refresh of old rows is not built). German OCR data is not installed (English only).
- The JUGAAD change is a local branch in a local clone; getting it into the user's own checkout (NAS, WIP present) is a separate, owner-approved step.
- Two scratch items for owner-approved cleanup: Chrome extension key `pandaBridge:com.pandesh.panda_bridge_dev` (identity verified: created by me for the dev host, contains only the dev Core pairing token) and the emulator (left running).
- Approval card is visible in the Missions dock of the chat view; there is no OS notification when a request arrives.
- No release review has been done; nothing deployed.
