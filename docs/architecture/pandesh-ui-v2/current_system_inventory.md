# Current system inventory (Pandesh @ 89b8af2, `fix/reliability-remediation`)

The audit was read-only, against the code at commit 89b8af2. Every row names the file that backs it. "Verified" means the reliability handoff or memory records a real-app run; otherwise the capability exists in code only.

## 1. Process topology

| Component | Location | Role |
|---|---|---|
| Desktop host (Electron main) | `apps/desktop/src/main.ts`, `host/desktopSession.ts` (5.4K lines) | Window, tray (`jarvisTray.ts`), IPC, local speech/wake word, Gmail OAuth, timers, mobile/companion server |
| Desktop renderer | `apps/desktop/renderer/renderer.js` (10.7K lines, vanilla JS), `index.html`, `workspace.css` | The current UI: rail with **Home / Tasks / Integrations**, a conversation, and a resizable `workspace-context` aside |
| Core | `core/` (TS, SQLite) launched by `src/core-client/CoreLauncher.ts` | Sole durable authority: conversations, requests/attempts, tools, approvals, memory, schedules, events |
| VS Code extension | `src/` (agent, orchestration, teams, roles, workforce, mcp, skills, webview-v2 React UI) | Engineering workflows; has its own multi-agent constructs (see §6) |
| Panda bridge | `apps/panda-bridge` (Chrome extension + native host) + `/v1/bridge/*` | Drives the user's real Chrome tabs (merged in PR #21/#22) |
| JUGAAD companion | `/v1/household/companion/*`, `companion_*` tables, `jugaad_send/status` | Phone companion sync (Android app in a separate repo) |

## 2. Backend → UI contracts

| Contract | Where | Notes |
|---|---|---|
| WebSocket `/ws` frames: `connected`, `event` (story), `runtime_event`, `runtime_token` | `core/ws/server.ts` | Broadcast to all clients; missed frames replayed by `GET /v1/runtime-events?after=<sequence>` |
| `runtime_events` table, monotonically increasing `sequence`, 15 domains (`conversation`, `request`, `attempt`, `model_invocation`, `tool_invocation`, `approval`, `execution_quality`, `research`, `memory`, `connector`, `assistant_routine`, `scout_routine`, `background_task`, `notification`, `authorization`) | `core/shared/wireTypes.ts:651`, `core/domain/runtimeEvents.ts` | **The right foundation for every v2 live view**: cursor-based, durable, replayable |
| REST surface (~200 routes) | `core/api/routes.ts` and siblings | Conversations, attempts (cancel/steer/retry/recovery), approvals, background tasks, artifacts, board snapshot, command queue, connectors, everyday notes/reminders, household, wishes, operator runs, bridge, security/safe mode, providers |
| Host-side activity projection | `apps/desktop/src/host/workspaceActivity.ts` | Folds runtime events into a **host JSON file** (`workspace-activity/activities.json`, max 30 per conversation). A second projection outside Core; v2 should derive this from Core events instead (see migration) |
| Tool activity preview payload | `core/shared/toolActivity.ts` | Kinds: browser, code, document, image, video, tool; sanitised |

## 3. Capability map (brief §PART 3)

| Area | Exists | Evidence (files / tools) | State |
|---|---|---|---|
| Chats & conversations | ✔ | `conversations`, `conversation_messages`, branching, alternatives, regenerate, pin/archive, export, search, working state | Verified; new-conversation restore fixed 7047617 |
| Projects & artifacts | ✔ | `projects`, `repositories`, `artifacts` (sha256, path, mime, attempt link), `/v1/artifacts` | Exists; no project workspace UI |
| Tool execution & approvals | ✔ | `tool_invocations`, `approvals`, `capabilityDispatch.ts`, `governedCapability.ts`, `execution_grants`, `standing_authorizations`, `conversation_permission_modes` (ask/auto/plan), `mutation_ledger` | Verified, fail-closed approvals |
| Truthfulness guards | ✔ | `actionClaims.ts`, `executionClaims.ts`, `completionGate.ts`, `folderCompleteness.ts`, `arithmeticCheck.ts`, `publicQueryGuard.ts` | Verified in remediation runs |
| Timers & notifications | ✔ | Host `everydayTimerManager.ts`, `everyday_reminders`, `notification_outbox`, `notification_channels` | M5 PASS |
| Background tasks & automations | ✔ | `background_tasks`, `scheduled_tasks`, `routine_runs`, `assistantRoutine.ts`, `scoutRoutine.ts`, `command_queue_items`, `commitments` | Exists; AUTO mission not re-run |
| Board | Partial | `stories`, `story_dependencies`, `/v1/board/snapshot`, `/v1/tasks/overview`, `task_outcomes` | Board exists for dev stories; not a unified board |
| Browser control | ✔ | 11 `browser_*` tools (headless Edge, egress proxy, per-domain approval), Panda bridge for real Chrome | Verified; hard Core kill can orphan headless Edge |
| Coding integrations | ✔ | OpenCode (`opencodeEngine.ts`, Core-verified diff + tests, D12), Hermes (`hermesEngine.ts`, ~90 skills), Pi agent (`piAgentEngine.ts`, desktop chat path), Kandev dev stories (Claude Code reachable only here) | OpenCode M8 PASS |
| Local inference | ✔ | Ollama native transport, residency/keep-alive, catalog, model routing (auto, empirical), `ollama_*` management tools, OpenAI-compatible backend, OpenRouter with budget, cloud providers opt-in | D7/D8/D9 fixed in code |
| GPU/CPU awareness | Partial | `hardwareCapacity.ts` (`nvidia-smi`, `gpuLaneLimit`), `interactiveLane.ts` (attempt lanes), `ollamaResidency.ts` | No cross-workload arbiter (LLM vs ComfyUI vs Whisper) |
| ComfyUI & media | ✔ | `comfyUiClient.ts`, `comfyui_*` (with recovery after Core restart), `imageStudioCapability.ts`, `mediaProduction.ts`, `video_generate`, `media_download` | Exists |
| Memory & knowledge | ✔ | `memory_facts` (scope, sensitivity, validity, consent approval), `memory_evidence` (source conversation/message/attempt/invocation + content sha256), `knowledge_entities`, `knowledge_relationships` (each tied to a memory and evidence), `memory_contradictions` (resolution policy + approval), tools `memory_remember/recall/forget/impact/export/resolve_contradiction` | Exists. Retrieval is SQL `LIKE` keyword match (`memory.ts:697`). Design note in `migrations.ts`: **deliberately no second store, no embedding table, no external graph engine** |
| Notes | ✔ | `everyday_notes` (title/body, soft delete) | Not linked into knowledge graph |
| JUGAAD | ✔ | `companion_devices/records/ops/nonces`, `/v1/household/companion/*`, `jugaad_send` | Demo-verified on emulator (2026-11-04) |
| Wish to Reality | ✔ | `wish_goals/offers/opportunities/ledger/business/orders`, `wish_*` tools, accounting guards | PR #27 open; feature freeze; demo flag truthfulness gap open |
| Social media | ✘ | Nothing (only incidental strings in `piAgentEngine.ts`) | New |
| Skills | ✔ | Core `core/platform/skills` (built-in host-hook skills like `evidence-before-claim`), Hermes skills, extension `SkillRuntimeService` | No per-agent skill grants |
| MCP | Partial | `src/mcp/McpRegistry.ts` (stdio/http/in-process, approval callback, audit) in the VS Code extension | **Not in Core/desktop** |
| Windows control | ✔ (read) | `desktop_screenshot`, `desktop_windows_list`, `system_*` (processes, services, startup, scheduled tasks), printers, network drives, ports, `processOwnership.ts` (owner tokens, verified PIDs), `windowsConfinement.ts` | Mouse/keyboard injection intentionally unsupported; window move/resize class 2 (needs adapter + approval) |
| Voice | ✔ | `desktopWakeWord.ts`, `desktopLocalSpeech*.ts`, `pocketTts.ts`, `renderer/voiceCapture.js`, tray "stop speaking" | Exists; no barge-in finish window spec |
| Security | ✔ | `core/security/*` (kernel, execution grants, safe mode, journal, hardened git, child env), browser egress proxy | Verified |
| Operator (one agent, multi-tool) | ✔ | `operator_runs/steps/events`, `/v1/operator/*` | Merged PR #22 |

## 4. Reusable modules for Phase 2

1. **`runtime_events` + WS + `?after=` replay** → every live view (activity, board, agent status, execution).
2. **Request/attempt model** (`requests.resolvedMode`, `attempts.kind/status/claimOwner/claimExpiresAt`, `predecessorAttemptId`) → agent tasks and delegations without a new task store.
3. **Governed capability dispatch + approvals + standing authorizations** → per-agent tool grants.
4. **Memory/knowledge tables** → Second Brain graph.
5. **`artifacts`** → Workspace previews, Social Studio media, Projects.
6. **`processOwnership.ts`** → Visual Execution process registry.
7. **`hardwareCapacity` + `interactiveLane` + `ollamaResidency`** → resource arbiter.
8. **Jarvis design system tokens** (`jarvis-design-system.zip`, Oct 2026) → visual foundation.
9. **`src/webview-v2` React components** (ApprovalCard, ActivityTimeline, TaskCard, DeliverySummary) → candidates for a shared React component set for the desktop renderer.

## 5. Known open defects relevant to Phase 2 (do not design around them silently)

- Model latency dominates (≈97 % of wait on gemma4 26B per memory note) → UI must be honest about "thinking" time and keep chat usable during tasks.
- Hard Core kill orphans headless Edge (open).
- Declined/expired capability calls recorded as `succeeded` was fixed in 1bf2d29; approve-after-reject unverified end to end.
- Wish-to-Reality model misreporting the demo flag (open).
- Renderer fonts/assets missing from some builds (memory note b153, open).
- Full 19-mission reliability re-run not yet done → **Phase 1 is not verified complete; Phase 2 implementation must not start.**

## 6. Existing multi-agent constructs (avoid duplicating)

| Construct | Where | Use in Phase 2 |
|---|---|---|
| `AgentTeamCoordinator`, `RoleRunner`, `RoleTypes`, `TrustedSequentialAgentRuntime`, `PolicySafeAgentRuntime`, `ResultGateRuntime` | `src/teams`, `src/roles` | Extension-side role pipeline (planner/implementer/reviewer). Reuse role-prompt and result-gate ideas; do not port the runtime into Core |
| `M19AgentWorkforce*` | `src/workforce` | Earlier workforce experiment; read before designing agent scheduling |
| `FixedMultiAgentGraph`, `TaskGraph`, `ParallelWriteCoordinator`, `WorktreeManager`, `ReadOnlySubAgentPool`, `ProviderScheduler` | `src/orchestration` | **Directly relevant**: parallel-write conflict avoidance (worktrees) and provider scheduling. Port the *rules* into Core's delegation contract |
| `SystemOneDecisionService` | `src/systemOne` | Local fast decision layer (the Pandesh analogue of the Jev "reflex") |
| Kandev dev stories, `devStories.ts`, worker profiles | `core/runtime/kandev` | Coding agent's path to Claude Code |
