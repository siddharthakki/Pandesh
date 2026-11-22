# Kandev → UI execution visibility: Phase 0 audit

Date: 2026-11-21. Branch: `feat/stage-c-vertical-slice` (33fd450). Scope: read and trace only. Nothing was built, merged or installed, and production was not touched.

Evidence sources:
- the code, at the references below
- the isolated Build 188 test instance's database `D:\PandeshB188cAccept\profile\core.db`, read-only
- the local Kandev REST API, GET calls only

## 0. Correction to the earlier inventory

Claude Code already runs inside Pandesh. The path is:
1. The ChatGPT connector receives the task.
2. The Core bridge raises the owner approval card.
3. **Kandev** starts the agent over **ACP**, in its own git worktree, with an isolated worker profile.

This audit extends that infrastructure and proposes no new orchestration or event model.

## 1. Current architecture (as traced)

```mermaid
flowchart LR
  GPT[ChatGPT] -->|MCP: pandesh_submit_task / task_status / task_report| GW[mcp-gateway/server.mjs]
  GW -->|HTTP| BR[Core bridge routes<br/>core/api/bridgeRoutes.ts]
  BR -->|dispatch| PB[pandaBridge.ts<br/>gateProject, requestExternalApproval, startAcp]
  PB -->|owner card| APPR[(bridge approvals)]
  PB -->|story + spec| DS[devStories.ts<br/>dispatch, reconcile, verifyAndIntegrate]
  DS -->|MCP create_task_kandev / REST / WS| KV[Kandev v0.97]
  KV -->|ACP| CC[Claude Code / OpenCode<br/>worktree under ~/.kkd-kandev/tasks]
  DS -. poll: agentMessages, latestTurn, pendingPermissions, sessionStatus .-> KV
  LOOP[startPandaBridgeLoop 5 s] -->|refreshBridgeTask| PB
  PB -->|devStoryDetail → result.activity = last 3 msgs| DB[(bridge_tasks.result JSON)]
  DB -->|activityItem: progress = last line| API[/GET /v1/bridge/activity/]
  API -->|household 'bridgeActivity', 2 s / 15 s poll| DOCK[Missions.tsx MissionDock]
  CORE[(Core /v1/missions: native missions)] --> MCP[MissionControlPane.tsx]
  KV -.x MCP
```

The dotted `x` is the main gap: no Kandev worker ever reaches `MissionControlPane`. It renders native Core missions only (mounted at [Chat.tsx:659](../../../apps/desktop/renderer-v2/src/Chat.tsx)).

### 1.1 Event path, step by step

| # | Step | Where | What happens to the event |
|---|---|---|---|
| 1 | Agent → Kandev | ACP (Kandev-internal) | Kandev stores every message (types seen live: `message`, `tool_execute`, `tool_read`, `tool_edit`, `tool_search`, `permission_request`, `status`, `script_execution`) |
| 2 | Kandev → Core | [kandevClient.ts:294](../../../core/runtime/kandev/kandevClient.ts) `agentMessages()` | **Pulled by REST, not streamed.** Keeps `author_type === 'agent'` only. Carries `id`, `at`, `kind`, `text`, `status` |
| 3 | Build the view | [devStories.ts:1484](../../../core/runtime/kandev/devStories.ts) `devStoryStatus()` | Fetches 12 messages and **keeps 3**. Only 5 kinds (`message`, `tool_execute/edit/read/search`). Text cut to 160 chars. `id` and `status` are dropped. **Empty unless the story is `implementing`** |
| 4 | Mirror into the task | [pandaBridge.ts:601](../../../core/runtime/kandev/pandaBridge.ts) `refreshBridgeTask()` | `result.activity` is **replaced** on every refresh, so earlier events are lost. Paths are redacted. `timeline` keeps the last 30 `[kkd-dev:*]` comments |
| 5 | Refresh cadence | [pandaBridge.ts:710](../../../core/runtime/kandev/pandaBridge.ts) `startPandaBridgeLoop(5 s)` | Each refresh calls `devStoryDetail`, which runs `devStoryStatus` over **all** stories, with several Kandev REST calls per story, and then picks one (see risks) |
| 6 | Persist | [pandaBridge.ts (domain):356](../../../core/domain/pandaBridge.ts) `recordBridgeStatus()` | Writes only when something changed. A checkpoint is added only on a status or detail change, **never for activity** |
| 7 | Project | [bridgeActivity.ts:119](../../../core/runtime/kandev/bridgeActivity.ts) `activityItem()` | Collapses everything to `progress` (last line, 200 chars) plus the heartbeat (the newest of `updatedAt` and the activity/timeline timestamps). Branch, session state, the log and pending worker actions are **not** exposed |
| 8 | Serve | [bridgeRoutes.ts:191](../../../core/api/bridgeRoutes.ts) `GET /v1/bridge/activity` | 50 newest tasks |
| 9 | Render | [Missions.tsx:53](../../../apps/desktop/renderer-v2/src/Missions.tsx) | One row per task: state, executor, active time, heartbeat age, `Latest: <progress>`. No log, no Allow button for worker actions |

### 1.2 Where events are lost, filtered or delayed

- **Lost:** every event older than the newest 3, and every event once the story leaves `implementing`. A finished task keeps `activity: []`. This held for all three OpenCode tasks in the evidence.
- **Filtered:** `permission_request`, `status` and `script_execution` events, tool result and status, and the message id.
- **Delayed:** up to about 7 s (5 s Core loop plus 2 s dock poll). That is fine for a first version; Kandev's `/ws` could make it faster later.
- **Not surfaced:** when verification fails, **the worker's explanation is not attached** (see §5, Claude's refusals).

## 2. The six screens

| Screen | What it is today (data source) | Decision | Why |
|---|---|---|---|
| [MissionControlPane.tsx](../../../apps/desktop/renderer-v2/src/MissionControlPane.tsx) (83 lines) | Chat aside for one native mission (`/v1/missions`): steps, one `liveActivity` line, approvals | **KEEP, extend** | The right place for live worker panels. Add a Kandev worker section; do not build a new screen |
| [Missions.tsx](../../../apps/desktop/renderer-v2/src/Missions.tsx) `MissionDock` | In-chat dock: native missions, bridge tasks and the cloud-agent approval card | **KEEP** | Outcomes and approvals, and the card proven in acceptance. Bridge rows should link to the worker panel instead of carrying their own progress line |
| [Board.tsx](../../../apps/desktop/renderer-v2/src/Board.tsx) | Every Core attempt in columns (`getTaskOverview`, 5 s) | **MERGE into Missions** (priority 4) | A second list of the same work; becomes a filter/view inside Missions |
| [Activity.tsx](../../../apps/desktop/renderer-v2/src/Activity.tsx) `ActivityAside` | Per-request timeline for native runs: tool rows open to inputs and outputs, credentials masked | **KEEP** | This is the "full log" renderer. Reuse its row component for the Kandev log |
| [Processes.tsx](../../../apps/desktop/renderer-v2/src/Processes.tsx) | OS processes Pandesh started, checked against Windows | **RETIRE as a work screen** (move under Settings → Diagnostics) | Diagnostics, not work tracking |
| [Team.tsx](../../../apps/desktop/renderer-v2/src/Team.tsx) | Native specialist definitions (`/v1/agents`): tools, limits, refusals | **MERGE into Settings** (agent configuration) | Its "working / needs you" status duplicates Missions, and Kandev workers (Claude, OpenCode) do not appear in it at all |

Result: three work surfaces remain (Missions dock, MissionControlPane, Activity aside), each with a distinct job.

## 3. Live information already available per worker

| Field | In Kandev | Reaches Core | Reaches the UI |
|---|---|---|---|
| Current tool / command | yes (`tool_execute` text) | last 3 only, while implementing | last line only |
| File reads / edits / searches | yes (`tool_read/edit/search`) | last 3 only | last line only |
| Tool output | partially (message metadata) | **no** | no |
| Worker prose (its own report) | yes | yes (also relayed to chat once) | last line; final report only via evidence |
| Last event timestamp | yes (`created_at`) | yes (`at`) | merged into "heartbeat", which also counts Core's own `updatedAt` |
| Approval requests (worker actions) | yes (`permission_request`, `pendingPermissions`) | yes (`result.pendingApprovals`) | **status only; no Allow / Don't allow in the desktop** (the phone app has it: [mobileServer.ts:916](../../../apps/desktop/src/host/mobileServer.ts)) |
| Session state (RUNNING / WAITING_FOR_INPUT) | yes | used for phase | no |
| Branch / worktree | yes | `branch` in DevStoryView | no |
| Test / verify status | n/a (Core runs it) | `[kkd-dev:verify-failed/verified]` comments → `timeline` | only the final `verification` label |
| Errors | partially | `statusDetail` | yes, as the reason |
| Worker heartbeat / liveness | `sessionStatus.is_agent_running` | used for relaunch | no |
| Final evidence | n/a | `result.evidence` (up to 8 KB for inspections) | via `pandesh_task_report` and the dock summary |

## 4. Scheduling, isolation and recovery: code vs proven

| Capability | Code | Unit test | Proven live |
|---|---|---|---|
| Parallel worker limit (default 2) | [devStories.ts:38, 225](../../../core/runtime/kandev/devStories.ts) (Kandev `wip_limit`) | **none** | **no.** On 2026-11-21 one task waited from 14:19 for "a free worker slot" while one Claude worker was live (see §5) |
| GPU lane limit | [devStories.ts:331](../../../core/runtime/kandev/devStories.ts) `gpuLaneLimit()` | listing only ([capabilityRegistry.test.ts:36](../../../core/test/capabilityRegistry.test.ts)) | no |
| Path-overlap blocking | [devStories.ts:325](../../../core/runtime/kandev/devStories.ts) | none | no |
| Worktree per task | Kandev | n/a | **yes** (55 worktrees under `~/.kkd-kandev/tasks`, **never cleaned up**) |
| Worker edit/command policy | `permissionDecision` | yes ([kandevDevStories.test.ts:29, 37, 91, 328](../../../core/test/kandevDevStories.test.ts)) | **yes** (`git branch -a` rejected, `find` outside the worktree held for a human) |
| Read-only inspection check | inspection path | yes | **yes** (3 OpenCode tasks: nothing changed, report returned) |
| Session relaunch after restart | [devStories.ts:858-865](../../../core/runtime/kandev/devStories.ts) | partly ([kandevDevStories.test.ts:233](../../../core/test/kandevDevStories.test.ts)) | not in this run |
| Integration after a Core restart | [devStories.ts:823](../../../core/runtime/kandev/devStories.ts) | — | not in this run |
| Port conflicts | Kandev binds a random loopback address and port per start ([kandevClient.ts:64](../../../core/runtime/kandev/kandevClient.ts)) | yes (loopback-only) | yes (it runs alongside prod and the isolated instance) |
| Claude sign-in for workers | access token copied, never the refresh token ([workerProfile.ts](../../../core/runtime/kandev/workerProfile.ts)) | yes ([kandevDevStories.test.ts:101](../../../core/test/kandevDevStories.test.ts)) | **failed once**: the token had expired 1107 min earlier (13:40) and needed a manual Claude Code launch |

## 5. Real ChatGPT acceptance evidence (isolated Build 188, 2026-11-21)

| Time (UTC) | Task | Executor | Outcome | What actually happened |
|---|---|---|---|---|
| 12:46 / 13:02 / 13:32 | `ptask_701e…`, `_4d2b…`, `_5a97…` | OpenCode | **completed** | Read-only inspection of the connector workspace. KKD confirmed nothing changed; the report went back to ChatGPT. Labelled `worker-only`, which is correct |
| 13:40 | `ptask_3231…` | Claude | failed | The borrowed Claude sign-in had expired. Fixed by opening Claude Code once |
| 13:49 | `ptask_509b…` "say hello" | Claude | **approved and ran**, then `needs_attention` | Claude replied exactly as asked at 13:49:54. Verification then failed 3 times in 53 s with "the worker made no changes". **Cause:** a task with no project goes to an empty scratch workspace in *implementation* mode, and that verifier requires a diff. Claude refused twice to make up a change, which was the right behaviour |
| 14:04 | `ptask_a38e…` "coding / bug-fix" | Claude | approved and ran, then `needs_attention` | **Cause: wrong workspace.** No Pandesh source project is registered in that instance (only the default "Panda bridge"), so the task got an empty scaffold ("Created by Pandesh for one relayed task"). Claude inspected it, found no code, and refused to "manufacture a diff". The verifier failed it 3 times in 60 s; Claude's explanation never reached the report |
| 14:16 | `ptask_c698…` "fix the verifier" | Claude | `awaiting_approval` (stuck) | Again a scratch workspace. Claude tried to find the earlier worktrees under `~/.kkd-kandev/tasks`. The policy held 3 `Find` actions for a human, which is correct by policy. **There is no button in the desktop to answer them.** The Kandev task is still `REVIEW` |
| 14:19 | `ptask_2f8a…` "scoped delegated approvals" | Claude | `running` / "waiting for a free worker slot" | Kandev task `1eb4e647` has stayed `CREATED` with no session since 14:19. Whether a parked task holds a slot is **not yet confirmed** |
| 14:07 | `ptask_9ba2…` diagnostic | OpenCode | cancelled from ChatGPT | Cancel path works |

Bridge-level refusals that worked as designed:
- an unregistered path → "not an authorized project"
- a native executor on a project → "cannot be confined"

**Conclusion:** the launch, approval, worktree and policy layers work. The failures are in three places:
1. **Task-mode selection.** Answer-only tasks are verified as code changes.
2. **Workspace resolution.** A coding task that names an unregistered project silently gets an empty scratch workspace. Writes to a registered project from the bridge are refused by design ([pandaBridge.ts:252](../../../core/runtime/kandev/pandaBridge.ts)).
3. **Result delivery.**
   - The worker's own explanation is dropped when verification fails.
   - The retry loop spends all 3 corrections in under a minute on a refusal.
   - Worker-action approvals cannot be answered from the desktop.

## 6. Missing event mappings

1. Kandev message → **persistent, bounded per-task log**. Today it is the last 3 and replaced on each refresh.
2. Message `id` → dedupe key, which is needed to append rather than replace.
3. `permission_request` → log entry plus an actionable card in the desktop (Allow / Don't allow through the existing `POST /v1/dev-stories/:id/permissions/:pendingId`).
4. `status` / `script_execution` → log entries (session started, relaunched).
5. Session state and `is_agent_running` → `ActivityItem.sessionState`.
6. `worktree_branch` → `ActivityItem.branch`.
7. Newest Kandev message time → its own `lastEventAt`, separate from the heartbeat, which also counts Core's own writes.
8. `[kkd-dev:verify-failed]` and `[kkd-dev:verified]` → test entries in the same log.
9. The worker's last prose message → appended to the `verify-failed` evidence and to `needs-human`.
10. Activity kept after completion. Today it is cleared once the story leaves `implementing`.

## 7. Smallest implementation, in the owner's priority order

### Slice A: verifier and approval flow (priority 1; backend plus one renderer control)

| # | Change | Where | Acceptance |
|---|---|---|---|
| A1 | A task without a project that is read-only or answer-only goes through the existing **inspection acceptance** (report accepted, any file change fails it) instead of implementation verification | `startAcp` [pandaBridge.ts:466](../../../core/runtime/kandev/pandaBridge.ts); inspection acceptance [devStories.ts:1239](../../../core/runtime/kandev/devStories.ts) | Replaying the 13:49 hello task ends `completed`, `worker-only`, with Claude's sentence in the report. A worker that writes a file in that mode fails |
| A2 | The approval card and task status say plainly **"an empty isolated workspace, none of your projects"** when no project resolved | `requestExternalApproval` `accessLevel` / `exposure` [pandaBridge.ts:278-301](../../../core/runtime/kandev/pandaBridge.ts) | The card text for the 14:04 task would have shown it before Allow |
| A3 | Verify-fail "no changes": attach the worker's last message to the evidence, and **do not auto-retry** when the worker made no edits and answered in prose; go straight to `needs-human` | `verifyAndIntegrate` [devStories.ts:660](../../../core/runtime/kandev/devStories.ts), retry loop | Replaying the 14:04 case gives at most 1 correction, and the report contains Claude's explanation |
| A4 | The desktop can answer **worker-action approvals**: Allow / Don't allow on the bridge row in `MissionDock`, through the existing route (add a household path mapping like `bridgeApprovals`) | [Missions.tsx](../../../apps/desktop/renderer-v2/src/Missions.tsx), [desktopSession.ts:3042](../../../apps/desktop/src/host/desktopSession.ts) | The 14:17 request can be answered from the desktop; the task continues or the action is refused; recorded in `permission-log.jsonl` |
| A5 | **Owner decision, not built:** scoped write grants to a registered project from the bridge (worktree only, no push, no merge), building on `RoutineGrants` / `grantModel` | — | Needs the owner's policy call before any code |

### Slice B: one live Claude worker panel (priority 2)

| # | Change | Where | Acceptance |
|---|---|---|---|
| B1 | `refreshBridgeTask` **appends** new Kandev messages (dedupe by id) to `result.activity`, capped at 200, and keeps them after completion. Widen the kinds to `message`, `tool_*`, `permission_request`, `status`. Fetch 40 per refresh. No new table | [devStories.ts:1484](../../../core/runtime/kandev/devStories.ts), [pandaBridge.ts:615-625](../../../core/runtime/kandev/pandaBridge.ts) | After a run, the task holds every agent event in order; nothing is duplicated across refreshes; paths are redacted |
| B2 | `ActivityItem` gains `latest {at, kind, text}`, `lastEventAt`, `branch`, `sessionState`, `pendingWorkerActions` | [bridgeActivity.ts:96-156](../../../core/runtime/kandev/bridgeActivity.ts) | `GET /v1/bridge/activity` shows them; existing bridge tests still pass |
| B3 | A worker-panels section in `MissionControlPane`, grouped by executor (Claude, OpenCode). Collapsed: title, state, latest action, **"last event N s ago"** ticking locally. Expanded: the full log from `GET /v1/bridge/tasks/:id`, rows rendered like the Activity aside. Mounted in the Chat aside even when no native mission is active | [MissionControlPane.tsx](../../../apps/desktop/renderer-v2/src/MissionControlPane.tsx), [Chat.tsx:659](../../../apps/desktop/renderer-v2/src/Chat.tsx) | With one live Claude task: the panel shows each tool call within about 7 s, the age resets on each event, and the full log matches the Kandev messages |
| B4 | Staleness rule: "Running" is always shown with the last event and its age. After 60 s with no event it reads **"No event for N s"**. The existing `STALL_MS` (5 min) gives Stalled | renderer; [bridgeActivity.ts:30](../../../core/runtime/kandev/bridgeActivity.ts) | Killing the agent process makes the panel stop claiming "Running" within 60 s |

### Slice C: two concurrent workers (priority 3)

- **C1.** Unit tests for the WIP limit, GPU lane gating and path-overlap blocking (none exist).
- **C2.** Find out why Kandev task `1eb4e647` stayed `CREATED`: does a parked `REVIEW` task hold a WIP slot? If it does, release the slot when a story parks at `needs-human`.
- **C3.** Live proof on the isolated instance: two read-only inspections at once, both `RUNNING` in Kandev, a third shows "waiting for a free worker slot" and starts when one finishes. Keep screenshots and the Kandev task states.

### Slice D: consolidation (priority 4)

Merge Board into Missions, move Processes to Diagnostics and Team to Settings, as decided in §2.

## 8. Risks

- **Refresh cost.** Every 5 s, `refreshBridgeTask` → `devStoryDetail` → `devStoryStatus` walks **all** dev stories (up to 200), making 3-5 Kandev REST calls each, once per live bridge task. That is quadratic. B1 should look up one story, not all of them.
- **Result JSON size.** A 200-event log at about 200 chars each is about 40 KB per task. It's acceptable, but it must stay capped.
- **Privacy.** The full log stays local. The gateway keeps sending ChatGPT only the summary line and the final report. Path redaction applies to every log line.
- **Claude sign-in expiry** stops unattended runs. Keep the existing message and show it on the panel.
- **Worktree growth.** 55 worktrees are never cleaned up. Disk only, but it grows with every task.
- **Quota exhaustion.** I did not check how a Claude usage-limit stop shows up through Kandev. It is likely to look like a stalled or `WAITING_FOR_INPUT` session.
- **Flaky tests.** The known missionRepair and relevance flakes exist; re-run before judging.

## 9. Test requirements

- Unit:
  - activity append, dedupe and cap
  - kept after completion
  - redaction of every line
  - `lastEventAt` vs heartbeat
  - answer-only inspection acceptance (pass and fail)
  - no auto-retry on a prose refusal
  - worker-action Allow/Deny route from the host
  - WIP, GPU lane and overlap gating
- Typecheck: `npm run compile`, `npm run typecheck:webview-v2`.
- Live, on the isolated B188c instance only (never 3030):
  - replay the hello, coding and approval cases from §5
  - run one Claude worker with the panel open
  - run two concurrent inspections
  - screenshots and Kandev states as evidence

## 10. Recommended first vertical slice

Do **A1 + A3 + A4 + B1 + B2 + B3** as one branch. Together they are the smallest change that takes one real Claude task from ChatGPT to a visible, answerable, correctly verified result. Do C next, and D last. Do not start A5 (project write grants) without the owner's policy decision.
