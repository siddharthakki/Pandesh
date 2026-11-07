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

Not re-run: M1–M3, M6–M8, M10, M11, C2, C3, F1–F4, AUTO. No new 19-mission verdict is claimed.

## Open (priority order)

1. **Re-run M4 on a build that includes 904322e**; then implement **D5** PDF export (PdfCraft CLI or a bundled converter — verify `pdfcraft-cli convert` first) and **D10** workspace-relative `document_read`.
2. **C1 completeness**: the model stops after 2 of 3 files. Candidate: when a request says "price lists in this folder", require every listed matching file to be read before the final answer (evidence ledger check, like the claim guard).
3. **D11** deterministic arithmetic; **D12** OpenCode verify/diff/report; **D6** orphan `running` anchor attempts.
4. **D7/D8** Core must use the configured `ollama-agent.apiBase`; connection-loss must not be reported as "completed without a reply"; header must leave "Connected". **D15** retry in a long conversation.
5. **D9** Auto model selection (uninstalled chain models, wrong model shown); **D13/D14** wording and image-prompt contamination.
6. Re-run the full frozen 19-mission set on one clean build and write a new verdict.

## Operational notes

- Build a test build without touching `dist/` or `E:\Pandesh`:
  `KARKEDIKHA_ALLOW_DIRTY_BUILD=1 KARKEDIKHA_DESKTOP_PORTABLE_OUT=.tmp/remediation-build node apps/desktop/scripts/package-portable.mjs`
  (dirty only because of the untracked `scripts/acceptance/*gate2*` files; the fingerprint records them).
- Harness: `acceptance/claude-independent-audit/harness/cli.mjs` with `AUDIT_PORTABLE_ROOT=<build>`; write to a **new** mission folder (e.g. `remediation-<sha>/M5`). CDP port 9471 was left held by an unidentified PID (27324) after a timed-out launch; use `AUDIT_CDP_PORT=9472`.
- The harness auto-approves every card, including `pc_install_utility` (it tried to install pandoc on this PC during M4; both attempts failed). Use `--approval=reject` for missions where installs are not wanted.
- Do not trust `acceptance/rwts` or `acceptance/reliability-gate2` results (fabricated; see audit).
