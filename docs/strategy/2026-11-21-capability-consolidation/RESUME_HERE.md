# Resume here (state at the end of 2026-11-21)

**Before pushing:** this folder contains a machine inventory (local paths, NAS share names, model stores). Review it before pushing. The Pandesh repository may be public.

## Branches and worktrees
- `feat/kandev-live-workers` in `D:\Projects\Pandesh`: bde6f7a → 7e4536a → d96795d → 68db6e9 → fc0aa0e → 6c4146d → 565b818. Stacked on `feat/stage-c-vertical-slice` (PR siddharthakki/Pandesh#131). Not pushed.
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
- Profile: tasks, a paired test client "ChatGPT (live test)", the registered project "Pandesh" (read-only)
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
2. Worker panel: fix Resume of a task paused before its first event (repro: Pause right after Allow, then Resume → Kandev "Agent startup failed"); add "Open worktree" and "View diff".
3. Show direct dev stories (not only bridge tasks) in the worker panels.
4. `scripts/ci/local-pipeline.mjs` using `resource-lock.mjs` (`CI_CD_AUTOMATION_PLAN.md`).
5. Join the model store inventory with the Ollama API inventory (created models' manifests are not on disk).
6. Board → Missions consolidation.

## Owner-only actions
1. **A5 decision** (`A5_SCOPED_CODING_PROPOSAL.md`).
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
