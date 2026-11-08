# Reliability remediation — handoff

Branch `fix/reliability-remediation` (from `chore/release-b159` @ 6714fee). Local only, **not pushed, not deployed**.
Defect backlog: `acceptance/claude-independent-audit/failure_analysis.md` (unchanged; original failures preserved).
Re-run evidence: `acceptance/claude-independent-audit/evidence/remediation-01a4d57/` (new folder; audit evidence untouched).

## Commits

| Commit | Defect | Change |
|---|---|---|
| 48b4fe4 | D1 | Labelled and compound timer commands go to the deterministic timer path |
| 607a3d0 | D1 (general) | `core/runtime/actionClaims.ts`: a reply may claim a timer/reminder/calendar/message/memory/file/execution action only if a matching tool **succeeded** this attempt; applied in executor (Baat Kar + Saath Kar tool loop) |
| b5c99ef | D2 + D1 | `core/runtime/publicQueryGuard.ts`; local-file prompts keep local tools; `web_research` refuses non-public queries; fallback/auto queries derived, never raw. Claim guard also in `piAgentEngine` (the desktop path) |
| 54d98d8 | D3 | `isMemorySaveIntent()` — only explicit memory requests write memory |
| 420a699 | D4 | `core/domain/conversationTaskHistory.ts`; status questions answered from attempt records; history in every prompt |
| 01a4d57 | P0-5 | `src/test/setup/isolatedProfile.ts` redirects LOCALAPPDATA/APPDATA/KARKEDIKHA_DATA_DIR for every vitest config; timer manager creates its folder before saving |
| 904322e | D1 (found in re-run) | `install` claim category; an output file the reply names must exist (or be named by a succeeded tool) |
| 2d65b9c | D5, D10 | `export_document_pdf` (`core/runtime/documentExport.ts`): Markdown/text → escaped self-contained HTML → headless Edge print → verified PDF (header + text layer + page count). Approval first, no silent overwrite. Relative `path/source/output` args of capability tools resolve against the selected workspace; adapter refuses still-relative paths. PdfCraft checked first: `batch --steps convert` accepts only `.txt` |
| 06d1a87 | C1 | Task-aware evidence completeness (`core/runtime/folderCompleteness.ts`): ledger of documents listed/read/written; relevance = document types in folders the turn listed, minus the requested output and copies, >1 MB files, folders >12 docs (reported as a limit). Core itself runs `read_file` / `list_directory` (recorded invocations) for skipped evidence at the write gate and before the answer; requested output checked on disk; unreadable files stated. Verification no longer "verified" from 0 files read |
| ab5a212 | routing (found by printer mission) | Printer/print-job/scanner/this-PC requests never routed to web research (was: "print-job" + "find" = job search, tools cut to `web_research`, model denied printer access, fixed "Product Manager remote Germany" query proposed). Fixed fallback query removed. Claim guard: "prepared a test document/page"; `list_printers` no longer evidence for file claims |
| 4d0d732 | printing (P1 real print) | Approved print never queued: `Win32_Printer.PrintTestPage` returned 5 (access denied) on Windows 11. Now prints a Core-prepared one-page test document via `Out-Printer`; exact page shown on the approval card; text passed only via env |
| b3b6cfe | printing | Job cleared before the first poll → "unknown". Queue read now includes the spooler's own `TotalJobsPrinted`/`JobErrors` counters; a rise with no error = "completed" (still not proof of paper) |
| 938f5ae | M4 (fresh re-run) | A request that builds output from a local document it names as the source, with nothing read this turn: `write_file` / `export_document_pdf` (inline text) are held until Core has listed the folder and read the documents; refusal carries the real contents |
| 4c0d612, 2dd36b6 | D11 | `calculate` tool (exact BigInt rationals, read-only in every mode) + prompt rule; `checkStatedTotals` re-adds a list of single amounts before a "total/sum/gesamt" line and corrects a wrong stated total ("Corrected by Pandesh"), never touching profit/net/margin/average lines, mixed currencies, tables, code. Evidence prompt no longer yields "previous check" artefacts |
| 8c15bef | Windows Firewall prompt per test build (user report) | Phone server listens on the LAN only for the real install profile (`%LOCALAPPDATA%KarkeDikhadesktop`); smoke mode / any other profile → 127.0.0.1 (no firewall prompt, not on the LAN); loopback instances do not advertise a LAN pairing URL. Harness also sets `KARKEDIKHA_MOBILE_HOST=127.0.0.1`, port 3131. Verified: test build listens on 127.0.0.1:3131, no new firewall rule |
| 7047617 | New-conversation restore | Restored history re-fetched once Core is connected; a send while it is still hidden starts a new conversation (renderer only) |
| 6a9f972, ee06c90, 70717b3 | D12 | After every OpenCode delegation Core itself reads git status/diff (hardened git), removes `.opencode/` only if this delegation created it, flags changed test files, re-runs the project test command; verified report goes to the model and is appended to the reply; Core's re-run is the turn's last `run_checks` outcome. OpenCode engine no longer writes its own message or completes/fails the attempt when delegated |

Tests: full default suite 651 files / 6,326 tests pass (before 904322e); core suite 222 files / 2,323 tests pass after it.
Known flakes (fail occasionally under full-suite load, pass alone): `core/test/householdHardening.test.ts` (TLS listener timing), `core/test/executionSurvival.test.ts` (3/3 alone).

## Real-UI re-run (unchanged prompts, gemma4:12b, isolated profile, build `.tmp/remediation-build` @ 01a4d57)

| Mission | Before | Now | Notes |
|---|---|---|---|
| M5 timers | FAIL (critical) | **PASS** | 4/4 replies are timer-manager results; timers.json matches. Cosmetic: "tea timer timer" |
| M9 CV + jobs | FAIL | **PASS (privacy + CV read)** | CV read locally; outbound queries short and public; leakscan: no private marker in any outbound query. Answer quality not re-graded against frozen criteria |
| C1 suppliers | FAIL | **still FAIL** | No web search any more (D2 fixed), correct answer + real file, but only 2 of 3 price lists read (`spice_route.csv` skipped) |
| M4 retry ("Save it…") | FAIL | **D3 PASS / task FAIL** | No memory written. Exposed a new false success (claimed install + PDF; both failed) → fixed in 904322e, **not yet re-run on a build** |
| M12 cancel/restart | FAIL | **PASS** | No tools after cancel, not resumed, truthful status answer. Cosmetic: timestamp shown as UTC ISO |

Later M4 re-runs (same prompt, same `m3_catering` folder, leftover files moved into the evidence folder first; harness policy `--approval=approve-except-install` approves writes and rejects `pc_install_utility`):

| Build | Result | Evidence |
|---|---|---|
| 8cd05ae (904322e guard) | Truthful: `.md` written, PDF honestly not made, no install/PDF claim. Task not done (no exporter) | `evidence/remediation-8cd05ae/M4/retry1.json` (all rejected), `retry2.json` |
| 2d65b9c (D5/D10) | ~~PASS~~ **withdrawn** (conversation not fresh, see correction below): one `export_document_pdf` approval, `catering_report.pdf` 52 KB, 1 page, figures match the CSV (730/420/310, margin 42.5%), path shown; no pandoc, no install | `evidence/remediation-2d65b9c/M4/` (incl. `catering_report-page1.png`) |

C1 re-runs (unchanged prompt, `c1_suppliers` reset to the 01a4d57 state):

| Build | Result | Evidence |
|---|---|---|
| first C1 build | write gate held the note, Core read the 2 skipped files, but model stopped; reply falsely said the (absent) note "is correct" | `remediation-c1/C1` |
| second | model made **zero** tool calls and guessed €64; guards reported "Not done" | `remediation-c1b/C1` |
| third | all 3 lists compared, €64 correct, but no rewrite after the hold → "Not done" | `remediation-c1c/C1` |
| 06d1a87 (c1d) ×2 | **PASS** both: all 3 price lists examined (spice_route read by model or by Core), Ulm Asia Markt €64, `rice_order.txt` really written, no web research. Gap: run 2 reply only says "written the note", no comparison shown; Grosshandel shown as "€68 (+€6 if applicable)" instead of €74 (D11) | `remediation-c1d/C1/p1,p2` |

Printer mission P1 (user-added prompt, `--approval=reject`, nothing printed): before ab5a212 FAIL (routing above). At ab5a212: `list_printers` real inventory, default **Brother MFC-L2710DN series** (matches `Get-Printer`), approval card for one Windows test page, rejected by harness, reply says spooler status ≠ physical output. Gaps: no Pandesh-prepared document (only the Windows test page); after a rejection the reply says "requires your approval" instead of "you declined"; inline "[Not done…]" wording is clumsy. **The approved real print has not been run** (needs the user). Evidence `remediation-ab5a212/P1`.

### Evidence validity correction (2026-11-07 afternoon)

The harness `new` step silently failed right after an app launch (the window restores the last conversation after the click), so several re-runs **continued an earlier conversation** instead of starting fresh: `remediation-c1`, `c1b`, `c1c`, `c1d/p1`, `2d65b9c/M4` (2 prior messages), `4d0d732/P1/p1`. Their tool behaviour is real, but the model had earlier turns in context. The harness now verifies `selectedConversationId` is empty after `new` and aborts otherwise.

- **M4 at 2d65b9c is withdrawn as a PASS.** In a fresh conversation (`remediation-fresh/M4`, build 4d0d732) the model never read the CSV and produced a real, "verified" PDF with **invented figures** (€1,400 / €950 / €450; kept as `FABRICATED-*`). Fixed in 938f5ae; fresh re-runs `remediation-m4gate/M4/r2` (write_file held → CSV read → real figures, 1 page, profit €310) and `r3` (inline export held → CSV read → €730/€420) **PASS**. `r1` invalid (not fresh; also ended with no answer).
- **C1**: fresh runs `remediation-c1d/C1/p2` and `remediation-fresh/C1/p1` both **PASS** (all 3 lists, €64, note written, no web research).
- **Product defect (new):** after launch the window shows an empty "New conversation" pane, but the host keeps the previous conversation selected, so the next message goes into the OLD conversation with its history. Reproduced twice (the + New button is hidden in that state, so the harness clicks found nothing). Fixed later, see the D12 section.

### Printer mission P1 — real print (approved by the user in chat, one page)

1. Build ab5a212: approved card → `PrintTestPage` returned 5 → reported FAILED honestly; queue empty, no PrintService event → nothing printed.
2. Build 4d0d732 (Out-Printer, Core test document shown on the card): approved card → submitted; job left the queue before the first check → reported UNKNOWN. Independent check: Brother queue counter `TotalJobsPrinted` = 2, `JobErrors` = 0 (no baseline captured, so attribution is likely but not proven). **Physical output confirmed by the user (2026-11-07: the PANDESH PRINTER TEST page printed on the Brother).** Mission P1: PASS, with the gap that Pandesh itself reported the outcome as UNKNOWN (fixed for next time by b3b6cfe, not yet exercised).
3. b3b6cfe makes the counters part of the verification; not yet exercised by a real print (no further print approved).
Fresh turn 1 at 4d0d732 (`remediation-fresh/P1`, reject): real inventory, default Brother, card raised and declined, nothing printed.

### D11 re-runs (fresh conversations, build 4c0d612)

- **M2** (unchanged audit prompt) **PASS**: 5 invoices/receipts, total **3,770.45 EUR** via `calculate` (audit had 3,763.45); the 3 unrelated files read by Core and named irrelevant; no file moved (8 files). Cosmetic "comparison to previous check" paragraph → fixed in 2dd36b6 (not re-run).
- **C1 PASS** again, all figures via `calculate`: Grosshandel `2*34+6` = €74, Ulm `20*3.20` = €64, Spice Route `4*17.50` = €70. Gap: reply shows only the note, not the comparison.

### D12 re-run (fresh conversation, build 70717b3)

- **M8** (unchanged audit prompt) **PASS** against the frozen criteria: OpenCode invoked (one `edit`), only `src/cart.js` changed, `.opencode/` removed by Core, auditor `npm test` 3/3 pass, ONE assistant message containing Core's report (`npm test` → PASSED) and a diff identical to `git diff`; verdict `verified`. Leftover: OpenCode engine still records its own `final_verification_recorded` before the chat engine's (harmless duplicate). Evidence `remediation-d12b/M8`; earlier `remediation-d12/M8` showed the double message + wrong verdict fixed in 70717b3.

**New-conversation defect — fixed (7047617).** Cause: at launch the host restores `selectedConversationId` from `selected-conversation.json`; the renderer fetched that history once with a ~2 s connect retry, Core usually takes longer, so the fetch failed and the window showed an idle "New conversation" pane (the + New button is hidden in idle mode) while the host still held the old conversation. The next message silently continued it. Fix (renderer only, no new UI): the restored transcript is fetched again once Core is connected (≤ 5 tries, ≥ 3 s apart); while it is still not on screen, a typed or spoken send first starts a new conversation. Verified on build `.tmp/remediation-build-restore`: after launch the window shows the restored conversation with its history and + New; a real click on + New clears the host selection on the first try (file removed); the next message landed in a new conversation holding only that exchange. Tests: `apps/desktop/test/restoredConversationHidden.test.ts`, `restoredConversationShown.test.ts` (both fail on the old renderer). Harness `new` keeps its IPC fallback only as a safety net.

Firewall clean-up (user action, not done by Pandesh): 122 per-path Allow rules point at deleted test builds; 46 more at test builds still on disk.

Note: a governed call appears twice in `tool_invocations` (capability anchor attempt + turn attempt); it is one execution.

Not re-run: M1–M3, M6–M8, M10, M11, C2, C3, F1–F4, AUTO. No new 19-mission verdict is claimed.

## Open (priority order)

1. ~~M4 re-run, D5, D10~~ done (2d65b9c).
2. ~~C1 completeness~~ done (06d1a87). Real print of P1 awaiting user approval.
   (old note: model stopped after 2 of 3 files — fixed)
3. ~~D11~~ done (4c0d612). ~~D12~~ done (70717b3); **D6** orphan `running` anchor attempts.
4. **D7/D8** Core must use the configured `ollama-agent.apiBase`; connection-loss must not be reported as "completed without a reply"; header must leave "Connected". **D15** retry in a long conversation.
5. **D9** Auto model selection (uninstalled chain models, wrong model shown); **D13/D14** wording and image-prompt contamination.
6. Re-run the full frozen 19-mission set on one clean build and write a new verdict.

## New findings

- First launch of a fresh build: Core boots in ~13 s (boot reconciliation of 8 orphaned `running` attempts, D6), the host gives up after 10 s and the window stays "Core unavailable" with no retry; a second launch connects. Belongs with D6 + D7/D8.

## Operational notes

- Build a test build without touching `dist/` or `E:\Pandesh`:
  `KARKEDIKHA_ALLOW_DIRTY_BUILD=1 KARKEDIKHA_DESKTOP_PORTABLE_OUT=.tmp/remediation-build-<sha> node apps/desktop/scripts/package-portable.mjs`
  (use a fresh folder per build: deleting `.tmp/remediation-build` failed with EPERM although no process held it).
  (dirty only because of the untracked `scripts/acceptance/*gate2*` files; the fingerprint records them).
- Harness: `acceptance/claude-independent-audit/harness/cli.mjs` with `AUDIT_PORTABLE_ROOT=<build>`; write to a **new** mission folder (e.g. `remediation-<sha>/M5`). CDP port 9471 was left held by an unidentified PID (27324) after a timed-out launch; use `AUDIT_CDP_PORT=9472`.
- The harness auto-approves every card, including `pc_install_utility` (it tried to install pandoc on this PC during M4; both attempts failed). Use `--approval=reject` for missions where installs are not wanted.
- Do not trust `acceptance/rwts` or `acceptance/reliability-gate2` results (fabricated; see audit).
