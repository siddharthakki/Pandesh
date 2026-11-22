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
| Image OCR request | **failed live** (not routed); fixed in 06de824; unit-tested only | — |
| "Check the health of the local services" | **failed live** (went to OpenCode); fixed in 06de824; unit-tested only | — |

## Model inventory
- Synthetic tests: 4/4 (GGUF header, Ollama blob mapping, duplicate detection with full hash, read-only check).
- Real run: 312 GB; 6 duplicate groups confirmed by full SHA-256 (74.27 GB).

## A5 scoped coding (owner-approved, cafb8a0), live on the scratch instance
Task: "Fix the bug in the CalcDemo source code: add() in src/add.js subtracts instead of adding…", sent as a paired ChatGPT client. CalcDemo is a synthetic repo (`D:\PandeshP0Dev\a5-calc`) registered read-write.

| Step | Result | Evidence |
|---|---|---|
| Card | Shows "Code change in an isolated worktree of a private copy: at most 20 files… no push, no merge, no install"; Allow pressed in the desktop UI | `evidence/live-15-a5-card.png` |
| Work | Claude read and edited `src/add.js` in a Kandev worktree of the private copy and ran `npm test` | worker log in the panel |
| Review | Task reached "awaiting review"; panel listed `src/add.js` with "Approve change"; clicked → completed, verified | `evidence/live-16-a5-review.png` |
| Copy | Commits 23b08cd (change) and d0144e4 (integration) exist only in the copy | `git log` |
| Delivery | "Bring into my checkout as a new branch" clicked → branch `pandesh/chatgpt-a0d637406910` in the owner repo | `evidence/live-17-a5-delivered.png` |
| Owner checkout | Still on `main` at a25faaf; an uncommitted file placed there before delivery was untouched (`git status` identical before/after); no remote | `git status` |
| Delivered branch | `src/add.js` = `a + b`; the project's tests pass on an export of the branch (1/1) | `npm test` |

Unit tests: `core/test/bridgeCodeChange.test.ts` 7/7 (read-only project refused with no card; card scope; client can't approve; question stays inspection; copy has no remote or node_modules link; file cap fails verification; delivery is a new branch, idempotent, never overwrites). Bridge/worker suites 72/72; `compile` and `typecheck:webview-v2` clean.

Found and fixed on the way: `/v1/dev-stories/:id/approve-review` had no caller check (a paired client could approve a review); it is now host-only. Read-write projects could not be inspected through a card (the scope check required `access==='read'`); fixed.

## A5 View diff (cc79820), full A5 workflow re-run live on 2026-11-22
Scratch instance rebuilt from cc79820. Task sent as the paired ChatGPT client: "In the CalcDemo source code: fix the bug in src/add.js…, add a new multiply(a, b) function in a new file src/multiply.js, and add a test for multiply in test/multiply.test.js. Then run the project's tests (npm test)…". The change was written by Claude Code (Kandev, claude-acp).

| Step | Result | Evidence |
|---|---|---|
| Card | Access level "Code change in an isolated worktree of a private copy: … at most 20 files … no push, no merge, no install"; project CalcDemo, main @ a25faaf5931e, read-write (approval audit) | `GET /v1/bridge/tasks/:id/audit` |
| Allow | Pressed in the desktop UI; Claude ran, ~1 min | panel |
| View diff before approval | "3 files changed · +6 −1 · read from the worker worktree (a25faaf → a25faaf + uncommitted)": `src/add.js` Modified +1 −1, `src/multiply.js` New +1, `test/multiply.test.js` New +4; red/green lines; Expand full diff; Pandesh's check (`git status`, worker-only) and "Worker ran: npm test · complete (reported by the worker, not re-run by Pandesh)" with the worker's report (2 tests, 2 pass) | `evidence/live-19-a5b-view-diff.png` |
| Viewing is read-only | Worker worktree HEAD, `git status` hash, index file hash and refs identical before/after `GET …/diff`; task still `awaiting_approval` | shell check |
| Not readable by the client | Paired client `GET …/diff` → 403 "only the Pandesh app can do this" | live |
| Approve | "Approve change" clicked in the UI → completed in < 10 s | panel |
| View diff after approval | Same 3 files, now "read from the private copy (a25faaf → a13162b)" | `evidence/live-20-a5b-diff-after-approval.png` |
| Delivery | "Bring into my checkout as a new branch" → `pandesh/chatgpt-3f4c9fc2633b`; owner repo still `main` a25faaf, clean, no remote; branch diff = the same 3 files +6 −1; the project's tests on an export of the branch: 2/2 pass | `evidence/live-21-a5b-delivered.png` |
| Read-only project | "Fix the typo in the Pandesh source code README … and commit it" → 400 "Project 'Pandesh' is authorized read-only…", no card, no copy | live |
| No project | "Write a new Python script that renames all files in a folder, then run it" → 400 "…names no registered project, so nothing ran…", no card | live |

Tests: `core/test/changeDiff.test.ts` 10/10 (modified/deleted/renamed/binary/untracked text and binary; committed range with ignored agent files; large diff cut with counts kept and over-cap file not shown; index/refs/HEAD/working tree unchanged; unknown base = unavailable; traversal, absolute and drive paths refused; a junction leading outside is refused and its content never read; a repo outside Pandesh's private copies is refused; a worker worktree that is not Kandev's is refused). Route authz added to `pandaBridge.test.ts` (paired client and bare Core token 403). Helper tests in `workerModel.test.ts`. Related suites 97/97; `typecheck:core`, renderer-v2 and `compile` clean.

Not shown live (covered by unit tests only): a binary file, a large diff, an unavailable diff. Known cosmetic issue: the "Pandesh's check" line repeats "(human-reviewed)" after approval.

## Remaining acceptance criteria (not met)
- Panel open worktree (Stop, Pause verified live in 565b818; Resume of a task paused before its first event fails in Kandev: "Agent startup failed").
- Board / Team / Processes consolidation.
- Allow-once pressed live.
- Live run of the two router fixes. They need a rebuild from `feat/capability-consolidation`; the scratch instance runs the main checkout's bundle.
- One stale "reviewed by a person" label on a task completed before the fix.
## Full suite on the final commit (6c4146d)
- 8015 passed, 18 failed.
- 13 are pre-existing: they fail identically at bde6f7a.
- 5 were load-related: they pass on their own, 62/62.
- No regression found.
