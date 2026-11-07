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

Tests: full default suite 651 files / 6,326 tests pass (before 904322e); core suite 222 files / 2,323 tests pass after it.
Known flake: `core/test/householdHardening.test.ts` (TLS listener timing) fails occasionally under full-suite load; passes alone.

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
| 2d65b9c (D5/D10) | **PASS**: one `export_document_pdf` approval, `catering_report.pdf` 52 KB, 1 page, figures match the CSV (730/420/310, margin 42.5%), path shown; no pandoc, no install | `evidence/remediation-2d65b9c/M4/` (incl. `catering_report-page1.png`) |

C1 re-runs (unchanged prompt, `c1_suppliers` reset to the 01a4d57 state):

| Build | Result | Evidence |
|---|---|---|
| first C1 build | write gate held the note, Core read the 2 skipped files, but model stopped; reply falsely said the (absent) note "is correct" | `remediation-c1/C1` |
| second | model made **zero** tool calls and guessed €64; guards reported "Not done" | `remediation-c1b/C1` |
| third | all 3 lists compared, €64 correct, but no rewrite after the hold → "Not done" | `remediation-c1c/C1` |
| 06d1a87 (c1d) ×2 | **PASS** both: all 3 price lists examined (spice_route read by model or by Core), Ulm Asia Markt €64, `rice_order.txt` really written, no web research. Gap: run 2 reply only says "written the note", no comparison shown; Grosshandel shown as "€68 (+€6 if applicable)" instead of €74 (D11) | `remediation-c1d/C1/p1,p2` |

Printer mission P1 (user-added prompt, `--approval=reject`, nothing printed): before ab5a212 FAIL (routing above). At ab5a212: `list_printers` real inventory, default **Brother MFC-L2710DN series** (matches `Get-Printer`), approval card for one Windows test page, rejected by harness, reply says spooler status ≠ physical output. Gaps: no Pandesh-prepared document (only the Windows test page); after a rejection the reply says "requires your approval" instead of "you declined"; inline "[Not done…]" wording is clumsy. **The approved real print has not been run** (needs the user). Evidence `remediation-ab5a212/P1`.

Note: a governed call appears twice in `tool_invocations` (capability anchor attempt + turn attempt); it is one execution.

Not re-run: M1–M3, M6–M8, M10, M11, C2, C3, F1–F4, AUTO. No new 19-mission verdict is claimed.

## Open (priority order)

1. ~~M4 re-run, D5, D10~~ done (2d65b9c).
2. ~~C1 completeness~~ done (06d1a87). Real print of P1 awaiting user approval.
2b. **C1 (old text)**: the model stops after 2 of 3 files. Candidate: when a request says "price lists in this folder", require every listed matching file to be read before the final answer (evidence ledger check, like the claim guard).
3. **D11** deterministic arithmetic; **D12** OpenCode verify/diff/report; **D6** orphan `running` anchor attempts.
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
