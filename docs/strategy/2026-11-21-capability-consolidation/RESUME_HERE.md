# Resume here

## State at 2026-11-23 ~08:00 UTC (owner's reliability priorities, done on b188j)

**Test build**:
- b188j = `release/b188f-missions` @ 6682cf3 (worktree `D:\PandeshRelease188e`), running on profile `D:\PandeshB188cAccept`.
- Package and smoke pass (the first smoke attempt timed out behind a 24 GB `qwen3.8:27b-mtp` model running 26% on CPU; the re-run passed in 40 s). The installer step was not re-run.
- `feat/supervised-missions` now ends at 4aabafa. Nothing is pushed, merged or installed.

**Owner priorities of 2026-11-23** (all on `feat/supervised-missions`):
1. **Paths outside the worktree are refused automatically, never put to the owner** (533ad4d):
   - In a private copy (A5, missions): any read, write, edit or delete outside the worktree.
   - Elsewhere: any path that does not exist.
   - ACP rejections carry no text, so the directions are in the code-change prompt up front.
2. **Real paths on the owner's own activity list** (533ad4d): an in-memory map; client views stay `<path>` (tested with a real Windows path).
3. **The prompt says to use relative paths**, and that the memory folder is not the project (533ad4d).
4. **Mission-step test baseline** (c6d97b3): live on b188i/j. Step 2's "before" now includes step 1 (14 pass before, not 0).
5. **Crash recovery** (4aabafa): a turn Kandev marks `error_terminated` is resumed in the same session, once per crash, at most twice; a third crash parks the story with the reason.
   - Live on b188i, before the fix: the kill was misread as "worker made no changes" and cost a retry; it recovered only by accident.
   - Live on b188j (ptask_cfee1373): claude.exe killed at 07:52:01Z → `[kkd-dev:worker-crashed]` at 07:52:06Z → resumed → both steps integrated by 07:53:50Z (95fda3a, be2cec7); no verify-failed.
   - Independent `node --test`: 43 pass, 1 pre-existing fail. Owner checkout unchanged (a25faaf, clean).

**Still open**:
- Three ACP worker processes from 11/21 are still alive (Kandev does not reap them).
- E:\Pandesh production is not running (the build log says 0 processes; not touched).
- The acceptance client is revoked again; run `node mcp-accept.mjs setup` to pair it again.

## State at 2026-11-23 ~07:25 UTC (live acceptance A/B/C on b188g/b188h)

**Test build**:
- b188h = `release/b188f-missions` @ ff10d80, in `D:\PandeshRelease188e`, running on profile `D:\PandeshB188cAccept`.
- It contains feat/supervised-missions de89cac, d519c62 and 2c6620c, cherry-picked.
- c6d97b3 (mission step baseline) is committed on `feat/supervised-missions` and is not in a build yet.
- Nothing is pushed, merged or installed.

**Test A (ChatGPT → MCP → A5)**: PASS.
- ptask_af136609: the card showed a code change, the worker ran in a `-code` worktree, Pandesh ran the tests before and after (divide's 2 new tests pass; `adds` reported as pre-existing).
- The owner viewed the diff and approved it: f57f7ce on `panda/change-f8dc6e23dccd` in the private copy.
- The owner checkout was unchanged afterwards: a25faaf, main, clean.

**Test B (3-step mission, one Allow)**: multiply and power were integrated under the grant with no clicks. Step 3 (index) stalled because Claude read files at a path built from its memory folder name, outside its worktree, which raised 5 permission prompts. The owner denied all 5 at ~07:18Z. The worker then used relative paths and finished. **PASS at 07:19:05Z:**
- 3 steps on `panda/mission-4ece1d50b3dd` (5bff483, e4a344a, 8be6c7d plus Integrate commits; tip 95a1587).
- 6 files added; `src/add.js` untouched; the copy has no remote.
- An independent `node --test` on the branch gives 6 pass and 1 fail (`adds`, pre-existing), matching Pandesh's report.
- The owner checkout was unchanged: a25faaf, clean, same 3 branches.
- The final MCP report is in `D:\PandeshAssistantDev\rel188e\shots\b-final-report.json`. Screenshots 03 and 04 show the stall before and after the fix.

**Cleanup done**:
- The acceptance client pairing was revoked and `.mcp-accept-state.json` deleted. Run `node mcp-accept.mjs setup` to pair again.
- `revoke-accept.mjs` revokes only that client.

**Next**:
1. Rebuild with c6d97b3 and show the owner the real path in worker permission prompts (keep it redacted for ChatGPT).
2. Two-slot concurrency evidence.
3. Section 8 backlog.
4. Push / PR only on the owner's OK.

**Test C**:
- Pandesh was restarted twice mid-mission (b188f→g at 06:56Z, g→h at 07:08Z). The mission and grant survived, and MCP `pandesh_updates` read the correct state back.
- The planned worker kill missed (the step had already exited).
- The real stall was surfaced only after fix 2c6620c.

**Defects found live and fixed**:
- **de89cac:** steps were mislabelled (stories share a creation instant; ordering fell back to random id).
- **d519c62:** unanswered cards read "waiting for approval" forever.
- **2c6620c:** a mission whose worker waits on a permission showed "Working.", with needsOwner false and no buttons; the buttons also targeted step 1's story.
- **c6d97b3:** a later step's tests were compared with main.

**Open defects**:
- Worker permission prompts show `<path>` to the owner too. The redaction meant for ChatGPT is shared with the desktop panel; the owner needs the real path.
- Three ACP worker processes from 11/21 are still alive (Kandev does not reap them).
- The build log shows "production still running: 0 processes" (E:\Pandesh is not running; not touched by this work).

## State at 2026-11-22 ~20:30 UTC (A5 coding fix + supervised missions)

**Branches** (all in `D:\Projects\Pandesh`; nothing pushed, merged or installed):
- `fix/a5-coding-dispatch`
  - 18304c4: intent contract, gate, Pandesh's test run, outcome, Don't approve
  - aad590d: spawn-guard allowlist
  - 1ac53e6: narrow constraints are not read-only
  - Cut from `feat/kandev-live-workers` cc79820.
- `feat/supervised-missions` (on the fix):
  - 395269d: missions + development grant + MCP updates/projects
  - eadcdd7: usage-limit / sign-in detection
- `release/b188f-missions` @ 986be0f, worktree `D:\PandeshRelease188e`. It equals b188d (505746b) plus both branches above. Built by `D:\PandeshAssistantDev\rel188e\rc-build-b188e.ps1`: smoke OK, installer OK.

**Root cause of ptask_c00d7741**:
- `core/domain/projectRegistry.ts` READ_ONLY regex matched "do not edit" in "do not edit the owner checkout, push, merge…".
- `gateProject` then chose mode `inspect`, so the card said "Read-only inspection".
- `mapPhase` reported every done story as "Finished and verified".

**Test instance**:
- Profile `D:\PandeshB188cAccept` (ports 3963/3964, CDP 9484, connector 3973-3975) runs b188f, pid in `instance-b188e.pid.json`.
- Switched from b188d at 19:44 UTC. Profile backup: `D:\PandeshBackups\b188d-profile-20261122T194453Z`.
- Rollback: `D:\PandeshAssistantDev\rel188e\rollback-to-b188d.ps1`.

**Acceptance client**:
- `D:\PandeshAssistantDev\rel188e\mcp-accept.mjs` speaks to the real gateway (OAuth + PKCE + DCR, then MCP).
- It is paired as "ChatGPT connector (Acceptance test client …)". Revoke that pairing after the tests and delete `.mcp-accept-state.json`.
- Request files: `accept-a.json` (Test A), `accept-b.json` (Test B, 3-step mission).

**Live state**:
- Test A task ptask_cb6e7a0b: the card was shown correctly as a code change (`shots/01-card.png`) and survived a restart (`shots/02-card-after-restart.png`). The owner's Allow had not come before it expired at 20:25 UTC.
- Test B mission ptask_900a8441: its card is waiting for the owner's Allow.
- Re-submit Test A with `node mcp-accept.mjs call pandesh_submit_task @accept-a.json`.

**Full suite on 18304c4**:
- 15 failures in 7 files. The architecture-guard failure was ours, now fixed (aad590d).
- The others fail on the pre-fix tree too. `desktopConversationSelection` needs a live Ollama; the dead URL in the suite breaks it.

**Next, in order**:
1. Owner presses Allow on both cards. On the A5 task: View diff, then Approve change (or Don't approve).
2. Check Test A outcome: divide + tests pass, the add test is reported as pre-existing, the owner checkout is unchanged.
3. Test B: confirm all 3 steps integrate without further clicks.
4. Test C:
   - kill one mission step's Claude process and observe detection;
   - restart b188f mid-mission and confirm the state survives;
   - read the result through `pandesh_updates`.
5. Then the backlog (section 8 of the owner's mission brief).

## Earlier state (end of 2026-11-21)

**Before pushing:** this folder contains a machine inventory (local paths, NAS share names, model stores). Review it before pushing. The Pandesh repository may be public.

## Branches and worktrees
- `feat/kandev-live-workers` in `D:\Projects\Pandesh`: bde6f7a → 7e4536a → d96795d → 68db6e9 → fc0aa0e → 6c4146d → 565b818 → cafb8a0 (A5) → cc79820 (View diff). Stacked on `feat/stage-c-vertical-slice` (PR siddharthakki/Pandesh#131). Not pushed.
- `feat/capability-consolidation` in worktree `D:\Projects\Pandesh-consolidation` (node_modules is a junction to the main checkout's): 06de824 (inventory + routing) and the commit holding these reports + `scripts/lib/resource-lock.mjs`. Not pushed.
- Nothing merged, nothing installed. Production `E:\Pandesh` untouched.

## Processes left running
- **Scratch Pandesh instance**, started by `D:\PandeshP0Dev\safe-launch.mjs` (ports 3991/3992/9481, profile `D:\PandeshP0Dev\profile`; the pid is in `D:\PandeshP0Dev\instance.pid.json`). Stop it:

  ```powershell
  node D:\PandeshP0Dev\safe-launch.mjs --stop
  ```

  It kills by recorded pid only.
- **Kandev** (shared, started earlier by the Core). Its In Progress step is empty.
- **The Stage C dev Core** (pid 37676, data `D:\PandeshStageCDev`, from 11-19, not mine) runs from `D:\Projects\Pandesh\out-core\core.js`. That bundle now contains this branch's code; the process keeps its old code until it restarts.

## Scratch data created (all under `D:\PandeshP0Dev`, safe to delete after review)
- Profile: tasks, a paired test client "ChatGPT (live test)", the registered projects "Pandesh" (read-only) and "CalcDemo" (read-write, `a5-calc`, now has branch `pandesh/chatgpt-a0d637406910`)
- `explain-repo\` (synthetic repo)
- `shots\` (screenshots)
- `t*.json`, `*.id`, `pairing.token`
- `live-core.mjs`, `live-ui.mjs`, `decide.mjs`, `overlap.mjs`, `det-run.mjs`

Kandev worktrees for the live tasks are under `C:\Users\<you>\.kkd-kandev\tasks\` (approval-gate-accept, inspect-pandesh-read-*, name-the-project-*). Kandev never cleans these up; there are now about 60.

## Last completed action
- Reports written; resource lock implemented and tested. Full suite on 6c4146d: no regressions (13 pre-existing failures; 5 load-related, which pass on their own).
- A full-suite run on 6c4146d was started; its result is in `ACCEPTANCE_RESULTS.md` if it finished, else re-run:

  ```powershell
  $env:KARKEDIKHA_OLLAMA_URL='http://127.0.0.1:9'; npm test
  ```

## Safe next steps (no owner decision needed)
1. Rebuild from `feat/capability-consolidation` and run the two router fixes live (image OCR, health phrasing).
2. Worker panel: fix Resume of a task paused before its first event (repro: Pause right after Allow, then Resume → Kandev "Agent startup failed"); add "Open worktree". (View diff is done: cc79820.)
3. Show direct dev stories (not only bridge tasks) in the worker panels.
4. `scripts/ci/local-pipeline.mjs` using `resource-lock.mjs` (`CI_CD_AUTOMATION_PLAN.md`).
5. Join the model store inventory with the Ollama API inventory (created models' manifests are not on disk).
6. Board → Missions consolidation.

## Owner-only actions
1. **Register real projects read-write for A5** (only then can ChatGPT change them; tested on synthetic `a5-calc` only).
2. **Widen read-only file services to registered projects, or not.** Results would go to ChatGPT.
3. **Repoint the 3 broken scheduled tasks** (commands in `CI_CD_AUTOMATION_PLAN.md`). The DDNS one is outward-facing.
4. **Delete the confirmed duplicate models** (74.27 GB) and check the hidden Ollama `llamacpp:` blob.
5. **Commit and push `E:\kkd-eval-lab`.** It has 40 uncommitted changes and no remote.
6. **Review the "Preserve" worktrees** (`Pandesh-activity`: 7 uncommitted; `Pandesh-journal`: 14), then remove the "Candidate" worktrees (`PROJECT_CONSOLIDATION.md`).
7. **In DSM:** confirm Btrfs snapshots, Hyper Backup, and a PC backup.
8. **Move the credentials file** off the `Z:\Projects\Projects` share root.
9. **Merge order** for #131 → `feat/kandev-live-workers` → `feat/capability-consolidation`.
10. **JUGAAD:**
    - Install German OCR traineddata.
    - Re-run the full emulator checklist.
    - Owner signing before any phone install.
    - Name `legacyOwner` for legacy records.

## Known issues
- One task completed before 68db6e9 keeps the label "reviewed by a person" (stored results are not recomputed).
- Hermes is not installed for Kandev (`hermes-acp`), so the Hermes executor is unavailable.
- The Claude worker sign-in is borrowed (an access token copy) and expires. Opening Claude Code once refreshes it.
- 13 pre-existing test failures in 5 files (present at bde6f7a).
