# Executive report: capability recovery and the live agent workspace (2026-11-21)

**Review before pushing.** This folder holds a machine inventory (local paths, NAS share names, model stores). The Pandesh repository may be public.

## What was accomplished (verified, not just written)

### 1. ChatGPT → Claude Code reliability (Priority 0)
All on branch `feat/kandev-live-workers`, verified on an isolated scratch instance (ports 3991/3992/9481) with real Claude Code runs.

**The empty-workspace problem is closed.**
- A task that may change files but names no registered project is refused with a question. Nothing runs.
- The live replay of the 2026-11-21 coding task was refused before any approval card.

**Answer-only tasks now pass.**
- The hello task completed live in about 1 second.
- Pandesh checked that no file changed, and kept the answer word for word.

**Project-name matching is fixed.**
- "Claude Code" no longer counts as a code word, and neither does a prohibition ("do not read files").
- Before the fix, a hello naming Claude Code and Pandesh became an inspection of the Pandesh repository.

**Explanations are kept.**
- A coding worker that changes nothing and explains why goes to the owner with its own words.
- It gets no contradictory "make changes" repair request.
- Proven live: the story was blocked with Claude's explanation, and 0 repair messages were sent.

**Worker slots are released.** Two live bugs were found and fixed:
- A permission request abandoned for two days held one of the two worker slots.
- A task queued for the GPU held a slot while it waited.

After the fixes:
- Two Claude workers ran together, overlapping from 15:09:37 to 15:09:45, on separate branches.
- A queued GPU task reads "Waiting for model/GPU", not "Stalled".

**Desktop Allow / Don't allow works.**
- Live: Claude's search outside its copy was held.
- "Don't allow" was pressed in the panel.
- Claude's own report said "the owner declined it".

### 2. Live agent workspace (first milestone)
Kandev workers now appear as panels in the Missions dock, grouped by agent ("Claude Code · 2 active", "OpenCode · 2 active"). Each panel shows:
- the worker's newest real event
- "Last event N s ago" (after a minute of silence: "No event for N")
- the branch of its isolated worktree
- an outcome line that never calls a worker's own report "verified"
- an expandable full execution log

The log is real Kandev telemetry, kept per task (200 events). It survived task completion and three Core restarts during the live run. ChatGPT still receives only the last three lines.

### 3. Capability recovery (Priority 1)
The deterministic router and services work end to end through the bridge, at **205 ms to 2.3 s**:
- directory listing
- file type via Magika (it really runs, score 1.0)
- PDF text through a workflow
- PDF page count
- SHA-256
- Tailscale status

Two routing misses were found live and fixed: image OCR, and "check the health of the local services".

### 4. Model store inventory (Phase 5, metadata only)
A new read-only, cross-engine tool covers Ollama, Hugging Face, Strata and others, with synthetic tests. First real run:
- 312 GB across 4 stores
- **74.27 GB of byte-identical duplicates, confirmed by full SHA-256**
- 63.35 GB of that is a nested copy of the Strata Qwen3.8 IQ2_XS model
- Nothing was moved or deleted.

### 5. Discovery
- Agents, engines, drives and NAS mounts are inventoried.
- 24 git checkouts are mapped.
- Scheduled tasks were audited. Three are **failing because `C:\Projects` moved to the NAS** on about 11-17: Cloudflare DDNS, JobHub, AutoClaw.

## Commits

| Branch | Commit | What |
|---|---|---|
| feat/kandev-live-workers | bde6f7a | Audit + acceptance checklist |
| | 7e4536a | No empty substitute workspace; answer-only verification; explanations kept; persistent worker log |
| | d96795d | Live worker panels, event age, execution log, desktop Allow/Don't allow |
| | 68db6e9 | Release abandoned-decision slots; verification label from KKD's header only |
| | fc0aa0e | GPU-queued task stays in Backlog |
| | 6c4146d | GPU-queued reads as queued, not stalled |
| | 565b818 | Stop / Pause / Resume on the worker panels (Stop and Pause verified live) |
| | cafb8a0 | A5 (approved by you): ChatGPT coding in an isolated private copy, owner review, delivery as a new branch; verified live end to end |
| feat/capability-consolidation (worktree `D:\Projects\Pandesh-consolidation`, based on the branch above) | 06de824 | Model store inventory; image OCR and health routing |
| | (this commit) | These reports |

Nothing was merged, pushed, installed or deployed. Production (`E:\Pandesh`) was not touched.

## Not done / not verified
- **A5 is built (cafb8a0) and verified live**, see `ACCEPTANCE_RESULTS.md`. Only `read-write` registered projects; the review box lists changed files but has no "View diff" yet.
- **Board → Missions, Team → Settings, Processes → Diagnostics.** Not done (priority 4 of the slice).
- **Panel controls.** Stop and Pause were added (565b818) and verified live. Resume of a task paused before its worker's first event fails in Kandev ("Agent startup failed"); the panel shows it as Needs attention. Open worktree and view diff are not built.
- **Direct dev stories have no panel.** Stories started from Pandesh itself (not through the bridge) don't appear in the worker panels; their approvals are only answerable from the phone page or the API.
- **One stale label.** A task completed before the label fix still says "reviewed by a person", because stored results are not recomputed.
- **Not started:** CI/CD pipelines, NAS backup tooling, JUGAAD work. Phases 3, 4 and 7 were audited only; see the plan documents.
- The 13 test failures in 5 files exist at the base commit (`bde6f7a`) and are not caused by this work.

## Decisions only you can make
1. **Which projects to register read-write** for A5. Only those can receive ChatGPT code changes. The scratch test used a synthetic repo only.
2. **Read-only file services on registered projects.** Today they only read Pandesh's own task workspaces, and their results go back to ChatGPT. Widening them would send project file listings, hashes and text to ChatGPT without a card.
3. **Repoint the three failing scheduled tasks** to `Z:\Projects\Projects\...`. The DDNS one updates a public DNS record. Exact commands are in `CI_CD_AUTOMATION_PLAN.md`.
4. **Delete the 74 GB of confirmed duplicate model files.** The list is in `MODEL_INVENTORY.md`.
5. **Merge order** for `feat/kandev-live-workers` (it is stacked on `feat/stage-c-vertical-slice`, PR siddharthakki/Pandesh#131).

## Highest-priority next steps
1. A5 follow-up: "View diff" in the review box.
2. Fix Resume-before-first-event (start a fresh repair session instead of relaunching); add open worktree / view diff; show direct dev stories in the panels.
3. Repoint the failing scheduled tasks (after your OK).
4. Do the Board/Team/Processes consolidation.
5. Set up a self-hosted runner only after deciding the GPU/test lock policy for CI.
