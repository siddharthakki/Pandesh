# Acceptance results (2026-11-21)

**Where:**
- Isolated scratch instance: Core 127.0.0.1:3992, CDP 9481, profile `D:\PandeshP0Dev\profile`.
- Shared Kandev at a random loopback port.
- Real Claude Code 2.1.330 on the owner's subscription; real OpenCode 2.3.2 on the local GPU.

**How tasks arrived:** a paired client with ChatGPT's restricted authority (it can only ask for cloud agents). The owner's decisions were clicks in the desktop window, driven over CDP.

**Evidence:**
- Screenshots: `evidence/live-*.png`.
- Scripts: `D:\PandeshP0Dev\live-core.mjs`, `live-ui.mjs`, `overlap.mjs`, `det-run.mjs`, `decide.mjs`.

## Mandatory live agent workspace test

| Criterion | Expected | Actual | Evidence |
|---|---|---|---|
| Two real Claude tasks in separate worktrees, both live | Two panels running with their own tool activity | **Pass.** t11 (`feature/inspect-pandesh-read-8h8`) events 15:09:27–15:09:45; t9 (`…-q2d`) 15:09:37–15:10:02; both "Running" at 15:09:45 with "Ran npx vitest …" and "Searched Find …" | `live-09-two-concurrent.png` ("Claude Code · 2 active"), `live-10…`, overlap.mjs output |
| Correct project and branch per session | Branch shown, different per worker | **Pass.** Each panel shows its own `feature/…` branch and "isolated worktree" | screenshots |
| History survives completion and restart | Full log after the task ends and after a Core restart | **Pass.** 2-event and 18-event logs intact after restart; three restarts during the run | `live-06-after-restart-logs.png` |
| Stalled workers visibly identified | Not "Running" without a recent event | **Pass.** "No event for 4 min 16 s" in amber on a silent OpenCode worker; Stalled state shown. **Bug found and fixed:** a GPU-queued task was wrongly "Stalled"; it now reads "Waiting for model/GPU" | `live-12-gpu-queued-and-quiet.png` |
| Approvals actionable from the desktop | Allow / Don't allow works | **Pass (Don't allow).** The worker's held `Find ..` was refused from the panel; the worker continued, and its report says the owner declined. Allow-once uses the same route but was not pressed live. Cloud-agent cards: Allow ×6, Don't allow ×1 in the UI | `live-04/05` (scratch shots), Claude's report |
| GPU-intensive work queued safely | Second GPU job waits; non-GPU work not blocked | **Pass after fix.** "Waits for: local GPU lane (1 at a time)"; after fc0aa0e the queued GPU task left In Progress and the Claude story started at once | Kandev step listing before/after |
| Failed verification keeps Claude's explanation | Explanation shown, no contradictory repair | **Pass.** Story blocked with "The worker made no changes and explained why (not sent back for repair): … README.md already names the project 'Example' …"; 0 `feedback-sent` | dev-story timeline |

## Priority-0 reliability (ChatGPT replay)

| Case (from the 11-21 morning run) | Before | After (live) |
|---|---|---|
| Hello, no project | needs_attention after 3 "no changes" failures | completed in about 1 s, answer kept verbatim, `worker-only` |
| Hello naming Claude Code + Pandesh, Pandesh registered | became a repo inspection | answer-only, no project shared (after fix 2) |
| Coding task, project not registered | empty scaffold, 3 failures | refused before any card: "names no registered project, so nothing ran" |
| Coding task, Pandesh registered `read` | — | refused: "authorized read-only; this task may change files" |
| Worker action outside its copy | stuck, no desktop control | held → Don't allow in panel → worker continued |
| Cloud consent from a paired client | card | unchanged: card; the client cannot approve |

## Deterministic services (live, through the bridge, `executor: auto`)

| Service | Result | Time |
|---|---|---|
| fs.list | completed: 4 files | 518 ms |
| doc.detect-type (renamed PNG) | completed: "PNG image (signature)"; Magika ran (txt case: label txt, score 1.0) | 2307 ms |
| extract-document workflow (PDF text) | completed | 1382 ms |
| doc.pdf-info | completed: 1 page | 1200 ms |
| fs.inspect SHA-256 | completed | 205 ms |
| net.tailscale-status | completed: connected | 555 ms |
| Paths in a registered project | refused: outside service roots (by design) | 217–359 ms |
| Image OCR request | **failed live** (not routed); fixed in 6f6027f; unit-tested only | — |
| "Check the health of the local services" | **failed live** (went to OpenCode); fixed in 6f6027f; unit-tested only | — |

## Model inventory
- Synthetic tests: 4/4 (GGUF header, Ollama blob mapping, duplicate detection with full hash, read-only check).
- Real run: 312 GB; 6 duplicate groups confirmed by full SHA-256 (74.27 GB).

## Remaining acceptance criteria (not met)
- A5 scoped coding: not built.
- Panel Stop / open worktree / view diff.
- Board / Team / Processes consolidation.
- Allow-once pressed live.
- Live run of the two router fixes. They need a rebuild from `feat/capability-consolidation`; the scratch instance runs the main checkout's bundle.
- One stale "reviewed by a person" label on a task completed before the fix.
## Full suite on the final commit (6c4146d)
- 8015 passed, 18 failed.
- 13 are pre-existing: they fail identically at bde6f7a.
- 5 were load-related: they pass on their own, 62/62.
- No regression found.
