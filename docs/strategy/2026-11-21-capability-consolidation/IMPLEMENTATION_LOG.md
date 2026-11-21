# Implementation log (2026-11-21)

## Branches
- `feat/kandev-live-workers`, in `D:\Projects\Pandesh`. Cut from `feat/stage-c-vertical-slice` @ 33fd450 (PR siddharthakki/Pandesh#131, not merged).
- `feat/capability-consolidation`, in worktree `D:\Projects\Pandesh-consolidation`. Cut from `feat/kandev-live-workers` @ 6c4146d. Its `node_modules` is a junction to the main checkout's.

Not pushed, not merged, not installed.

## Commits, in order

| Commit | Files | Change | Tests |
|---|---|---|---|
| bde6f7a | `docs/audit/2026-11-21/KANDEV_TO_UI_AUDIT.md`, `docs/release/CHATGPT_ACCEPTANCE_CHECKLIST.md` | Phase 0 audit; real ChatGPT evidence in the checklist | docs |
| 7e4536a | `core/runtime/kandev/pandaBridge.ts`, `devStories.ts`, `bridgeActivity.ts`, `core/domain/pandaBridge.ts`, `mutationPolicy.ts`, `core/api/bridgeRoutes.ts`, tests | `requireAnswerOnly` + `isAnswerOnly` (no substitute workspace); answer-only stories (`mode:'inspect', answerOnly`) with a dedicated prompt and minimal report; `codeCueText`/`refersToCode` (agent names and prohibitions are not code words; lone "test" no longer a cue); `workerExplanation` + no repair on an explained no-change; last words on `needs-human`; `devStoryWorkerEvents` + `mergeActivity` (append by id, update streamed text, cap 200, kept after completion); `devStoryStatus(…, onlyStoryId)`; ActivityItem `latest/lastEventAt/eventCount/branch/pendingWorkerActions/storyId`; paired clients get the last 3 log lines only | new `core/test/kandevLiveWorkers.test.ts`, 3 HTTP tests in `pandaBridge.test.ts`, updated approval tests |
| d96795d | `apps/desktop/renderer-v2/src/MissionControlPane.tsx`, `Missions.tsx`, `workerModel.ts`, `apps/desktop/renderer/v2/app.css`, `apps/desktop/src/host/desktopSession.ts`, test | `WorkerPanels`, `WorkerLog`, `groupWorkers`, `eventAge` (60 s quiet rule), `eventLabel`; host actions `bridgeTask`, `devStoryPermission` | `apps/desktop/test/workerModel.test.ts` |
| 68db6e9 | `devStories.ts`, tests, panel copy/CSS | `reclaimIdleWipSlots` releases tasks waiting on a decision for over 30 min (`STALE_DECISION_MS`); `verificationOf` reads only the first line; `workerOutcome` wording; latest line clamped | reclaim test, label test |
| fc0aa0e | `devStories.ts`, test | `waitsOnGpuLane` gates the Backlog → In Progress release, and moves an early-released GPU task back | GPU lane test |
| 6c4146d | `bridgeActivity.ts`, test | GPU-lane wait derives `waiting_for_model` ("Queued for the local GPU"), not stalled | queued-not-stalled test |
| 06de824 | `scripts/inventory/model-store-inventory.mjs`, `core/test/modelStoreInventory.test.ts`, `intentRouter.ts`, `deterministicRouting.test.ts` | Cross-engine model inventory; image OCR and "check the health of …" routing | 4 synthetic inventory tests, 2 routing cases |
| 565b818 | `MissionControlPane.tsx`, `workerModel.ts`, `desktopSession.ts`, CSS, test | Stop / Pause / Resume on panels (`workerControls`) | worker model test |
| (next) | `docs/strategy/2026-11-21-capability-consolidation/*` | These reports | docs |

## Failures found during live verification, and their fixes
1. A hello naming Claude Code and Pandesh resolved to a repository inspection. Fixed by `refersToCode`.
2. "acceptance test" counted as a code cue. Fixed by narrowing to "tests" / "test suite" / "test files".
3. Streamed messages were stored as their first fragment ("Said The"). Fixed: `mergeActivity` updates text by id.
4. Two concurrent Claude tasks ran one at a time: a two-day-old abandoned permission held a slot. Fixed in 68db6e9.
5. A Claude story could not start while a GPU task waited: the GPU-queued task held a slot. Fixed in fc0aa0e.
6. A GPU-queued task was labelled Stalled. Fixed in 6c4146d.
7. An inspection whose report quoted "human-reviewed" was labelled "reviewed by a person". Fixed in 68db6e9; already-stored results keep the old label.
8. Image OCR and a health-check phrasing fell through to a model. Fixed in 06de824.

## Test runs
- **Focused** (bridge, Kandev, approvals, inspection, native host, routing, inventory, worker model): all pass. Last runs: 92/92, 65/65, 53/53, 44/44, 39/39, 5/5.
- **Typecheck:** `tsc -p tsconfig.core.json` clean; `renderer-v2` clean; desktop host `src` clean. The desktop test files have pre-existing type errors.
- **Full suite** on 7e4536a's tree: 8015 passed, 14 failed.
  - 13 of the failures (in `desktopConversationSelection`, `missionCockpitSession`, `workspaceSelection`, `hermesProviderRouting`, `m12RetrievalIntegrationPackaging`) **fail identically at the base commit bde6f7a** (13 failed / 31 passed in those 5 files). They are pre-existing.
  - The 14th was the first version of a new test, fixed in the same session.
- **Full suite on 6c4146d** (final Pandesh commit): 8015 passed, 18 failed in 9 files.
  - 13 failures (5 files) are the pre-existing ones above.
  - 5 failures in 4 files (`skillRuntime`, `autonomousUxTruthfulness`, `m44MissionRuntimeIntegration`, `repositoryContextBudget`) **pass when re-run on their own** (4 files, 62/62). That run overlapped with full-hashing 74 GB and a 27B OpenCode job: load-related timeouts, not regressions.

## Build used for live checks
- `node esbuild.core.js` → `out-core/core.js`
- `node apps/desktop/esbuild.mjs` → `apps/desktop/out`, `renderer/v2/app.js`
- Bundling takes under 1 s each.
- Launched via `D:\PandeshP0Dev\safe-launch.mjs` (ports 3991/3992/9481, profile `D:\PandeshP0Dev\profile`).

**Note:** a Stage C dev Core (data `D:\PandeshStageCDev`, pid 37676, started 11-19 by another session) runs from `D:\Projects\Pandesh\out-core\core.js`. It keeps its loaded code until it restarts; after a restart it would run this branch's bundle.

## A5: scoped ChatGPT coding (owner approved, cafb8a0)
- `gateProject` now decides inspect vs code: a request that asks for a change on a `read-write` project becomes `mode: 'code'`; `read` projects are still refused before any card.
- The card states the scope (`accessLevelOf`). The dispatch check compares that text and requires `read-write` for code. This also fixed inspection of `read-write` projects through a card.
- Work runs in `panda-workspaces/<task>-code`, a clone with no remote and no `node_modules` link, through `planDevStories` (integration branch `panda/change-<id>` inside the copy, cap `CODE_CHANGE_MAX_FILES` = 20, checked in `verifyAndIntegrate`).
- Host-only routes `approve-change` and `deliver`. Delivery is `git fetch <copy> refs/heads/panda/change-<id>:refs/heads/pandesh/chatgpt-<id>` in the owner checkout, with the checkout fingerprinted before and after. It refuses an existing branch and is idempotent.
- `/v1/dev-stories/:id/approve-review` was callable by paired clients; now host-only.
- Worker panel: review box with changed files, "Approve change", "Bring into my checkout as a new branch".
- Live: see `ACCEPTANCE_RESULTS.md` (screens live-15/16/17).
