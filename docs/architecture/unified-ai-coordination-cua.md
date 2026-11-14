# Unified AI Coordination: CUA + Screen Reader (authoritative direction)

Recorded 2026-11-14 on the owner's instruction. **Status: direction and audit only. No CUA implementation starts until the owner approves it separately, and the current reliability and Activity work finishes first.**

## Direction (supersedes any per-application bridge plan)

Pandesh operates desktop applications (Claude, ChatGPT, anything else) through computer use, the way the owner does. No dedicated bridge per application.

Workflow:
1. The owner gives Pandesh a task.
2. Pandesh opens or switches to the target application.
3. It reads the application through Windows UI Automation, supplemented by local screenshot vision.
4. It types instructions, submits them, observes progress.
5. It reads responses, errors and results.
6. It passes findings between applications only when the owner authorizes that transfer.
7. It keeps coordinating while staying responsive to the owner.
8. It verifies outcomes and shows live activity and final evidence.

Architecture requirements:
- One reusable CUA interface for all applications.
- Accessibility tree first, vision fallback.
- Reuse existing Pandesh CUA, screen-reading, Windows and tool infrastructure.
- Never click coordinates without verifying current UI state.
- Interruption, cancellation, recovery and user takeover.
- Explicit authorization for external submissions, private-data transfers and consequential actions. No bypassing app security, no silent export.
- Screen content and user data stay local unless an approved action needs to transmit them.
- Pandesh keeps talking to the owner while other apps are busy.
- Every CUA action and observation appears live in the Activity panel.

## Audit: what exists today (read from the code, 2026-11-14)

| Area | State | Evidence |
|---|---|---|
| Desktop screenshot | Works, read-only. Whole virtual screen via PowerShell + System.Drawing, PNG with SHA-256. | `core/runtime/computerUseCapability.ts` (`desktop_screenshot`) |
| Window list | Works, read-only. Visible top-level windows: title + pid only (no handle, bounds, focus state, process name). | same file (`desktop_windows_list`) |
| Input, app launch, focus, clipboard | **Absent.** Docs call mouse/keyboard injection "intentionally unsupported". | `docs/architecture/pandesh-ui-v2/current_system_inventory.md:49`; audit G21 DEFER |
| UI Automation | **Absent.** No UIA code anywhere in `core/`; grep for `UIAutomationClient`/`System.Windows.Automation` finds nothing. | repo grep |
| Governed-adapter contract | Strong base: `classify` risk, `prepare` (freezes verified facts into the approval), `redactArguments`, `AbortSignal` in `ToolExecutionContext`, approval digests. | `core/runtime/governedCapability.ts`, `toolRunner.ts` |
| Pattern to copy | The browser capability already has the right shape for CUA: session manager, page state returning controls by label, `locator` actions, approval only for new site / submit, action budget, untrusted-content framing, screenshot saved as a Core artifact per step. | `core/runtime/browserCapability.ts`, `browserSession.ts` |
| Local OCR | Works: Tesseract + Poppler, fully local. Image-only, not wired to screenshots. | `core/runtime/documentOcr.ts` |
| Local vision models | Inventory detects vision-capable models; chat attachments route images to a vision model and refuse to pretend a text-only model sees them. | `core/runtime/capabilityInventory.ts:263`, `attachmentExecution.test.ts` |
| Activity contract | `ToolActivity` kinds: browser, code, document, image, video, tool. Screenshots referenced by artifact id. | `core/shared/toolActivity.ts` |
| Chat exposure | computer-use is **not** in the eager chat tool list (prompt budget); expandable only. | `piCapabilityBridge.ts:207`, `docs/all-in-one-gaps.md:75` |
| Tests | One acceptance check that a screenshot file appears. **No computer-use scenario was ever run**; 25/25 screen tests BLOCKED in the 700 run. | `docs/audit/2026-11-12/PANDESH_AUDIT_EVIDENCE.md:119` |
| External driver on this PC | `cua-driver` (UIA tree, element tokens, snapshots, `verify_state`) exists as a developer tool in this session. The architecture review (2026-11-12) already suggested UIA through an existing driver behind per-window approvals. **Pandesh does not call it today.** Whether it may ship inside Pandesh (licence, packaging, offline install) is unchecked. | `docs/audit/2026-11-12/PANDESH_ARCHITECTURE_REVIEW.md:137` |

## Gaps against the requirements

1. **No operator layer at all.** Missing: launch/switch app, focus window, type, key, click, scroll, clipboard. Every workflow step 2 and 4 is blocked.
2. **No accessibility read.** Step 3's primary path does not exist. Needs a UIA reader returning role/name/value/enabled/bounds and stable element references, plus a UIA-less fallback.
3. **No vision fallback pipeline.** Screenshot, a vision-capable local model and OCR each exist, but nothing connects them; the screenshot is a bare tmp path, not a Core artifact, so a model cannot be handed it.
4. **No state verification before acting.** Required by "never blindly click": need a snapshot id bound to a window, rejection of stale or changed state, and post-action verification that the expected change happened.
5. **No session model.** No per-target session, action budget, step log or recovery (relaunch, reacquire window, retry bounded).
6. **No user takeover / interruption semantics.** `AbortSignal` reaches tool runs, but nothing detects the owner touching mouse/keyboard mid-run, pauses, and hands control back. No global stop control for CUA.
7. **Authorization model is per tool, not per target.** Needed: approval naming the target window/app, a separate approval for each external submission (send to Claude/ChatGPT), and a distinct approval for cross-app transfer of content, showing exactly what text moves. `prepare` can freeze window identity (exe path, creation time) the way process-kill does.
8. **Privacy controls for screen content.** No redaction of password fields (UIA exposes `IsPassword`), no deny-list of apps (password managers, banking), no rule that screen text is not sent to a cloud model without approval. Screen text must also be treated as untrusted data, like page text in the browser capability.
9. **No Activity kind for desktop.** `ToolActivity` has no `desktop` kind; the panel cannot show target app, element acted on, before/after screenshot, or "waiting for Claude" progress.
10. **Waiting on busy apps while staying responsive.** No mechanism to watch an app for "still generating / finished / error" (UIA change events or polling) while the chat remains usable; the agent loop would block.
11. **Chat exposure.** Tool-count/prompt budget means the surface needs lazy tool selection, one `computer` tool or a small set, not a dozen eager tools.
12. **No test harness.** Needs a safe target app (Notepad or a purpose-built fixture window) and scenarios for read, type, verify, stale-state rejection, takeover and cancellation, plus real evidence rather than a PASS count.
13. **Open decision:** build the UIA reader in-process (PowerShell/.NET UIAutomation, slower, no new dependency) versus embedding or calling `cua-driver`. Not decided.

## What is not verified in this audit
- Whether any vision model installed on this PC can read a full-screen screenshot at usable accuracy (never measured).
- Real behaviour of UIA against Claude Desktop and ChatGPT Desktop (Electron apps expose partial trees unless accessibility is enabled). Nothing was run.
- Licence and packaging terms of `cua-driver`.

## Next step (not started)
Owner approves a CUA implementation plan after the reliability and Activity work lands. Suggested first slice when approved: read-only UIA reader + window targeting + Activity `desktop` kind, tested on a fixture window, before any input tools.
