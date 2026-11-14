# Next phase (M4–M7): sequence and entry gates

Baseline: main after PR #82 plus the semantic-check follow-up. Build 169 is production and the rollback baseline. Nothing below is started. Principle: make what already exists work end to end before adding tools or agents; every milestone is closed by live evidence (existing harnesses), not unit tests alone.

Entry gate for all of M4–M7 work: the inherited Google-grant isolation issue is resolved or the milestone uses only synthetic Google data. Real Gmail/Calendar automation stays restricted until then. Standing write permission stays off by default.

## M4: one place for tool discovery and intent routing
Today routing is split across `chatToolSelection.ts` (keyword groups), `request_tools`, and per-engine tool lists; the quoted-"inbox" and `inbox-count.txt` mis-selections of Gmail tools came from this. Task 1: build a fixed routing baseline from the existing live-eval scenarios (intent → expected tool group, 40 prompts incl. the known false positives) and measure current accuracy. Task 2: one Core-side registry (tool → group, intent cues, data class, approval class) that the selection, `request_tools` and the cloud-boundary partition all read. Gate: baseline accuracy up, zero new wrong-group selections, no weakened approvals.

## M5: attachments, image understanding and editing in the normal v2 UI
Existing parts: paused composer-attachments work (restart from clean main; the old worktree does not compile), artifact ids, Workshop/Image Studio. Known defect: Image Studio only finds reference images in its own output folder (attached-picture edits fail with real ComfyUI). Task 1: attach/drop/paste in the v2 composer → artifact ids → vision model reads the picture. Task 2: reference-by-artifact-id for edits. Gate: real-app run: attach a photo, ask about it, edit it, result stored as an artifact.

## M6: useful, privacy-aware personal memory and cross-session context
Existing part: PR #69 (personal context, open, not merged; suites 10/10 and 11/11). Task 1: rebase on main, re-run its suites and the 700-micro-test comparison. Task 2: decide cross-chat id handling and what is never remembered (credentials, health, financial identifiers); show the owner what is remembered and let them delete it. Gate: recall improves on the suites with the privacy exclusions proven by tests.

## M7: real-world pilot
Order: (1) photo → reminder (depends on M5), (2) software updates and project tracking (existing watchdog/radar), (3) recurring job search (existing scheduled routines with the grant model), (4) Gmail → Calendar last, synthetic Google data until the isolation issue is closed. Each is one owner-run scenario with a verified outcome, reported as such.

## First engineering task
M4 task 1: the routing baseline measurement. No behaviour change.
