# KKD as a thin VS Code client of Pandesh Core

Audit of `src/` (the extension) against Core, at main `f2910a7` (2026-11-25). LOC are non-test, +/-10%. Evidence is import-graph greps and reading Core routes; nothing was run in a VS Code host yet.

## What is live today

- **Chat (Baat/Saath)** is Core-only: `AgentPanel` calls `CoreClient.submit()` then `executeAttempt()` (`POST /v1/submit`, `/v1/attempts/:id/execute`). The in-extension `LocalAgentEngine`/Forge chat path is not called (only `AgentRuntime` pause/resume/cancel/steer/task-store helpers and the Forge demo commands touch it).
- **Karke Dikha (autonomous coding)** is hybrid: Core issues the request/attempt and the fence, then the extension runs it locally (`M15AutonomousRuntime` + `GovernedCodingExecutor`: investigate, propose, apply, validate, recover, commit/PR). Core has its own paths (`runKarkeDikhaOpenCode`, missions, kandev dev-stories) that the panel does not drive. Moving KKD onto them is a behaviour change.
- Core has no repository-indexing route. It accepts a client-built `RepositoryContextPackage`; `core/platform/repo` is an engine that only the extension calls.
- Core production code imports nothing from `src/`. Shared by `apps/desktop`: `core-client/*`, `config/Defaults`. Shared by Core tests: `services/CommandService`, `models/TaskModelSelection`, `coding/ValidationFloor|ValidationRunner`.

## Classification

| Module (LOC) | Class | Core counterpart / note |
|---|---|---|
| `core-client` (2.2k) | KEEP, relocate to a shared package | used by desktop too |
| `ui` shell: StatusBar, DiffReviewProvider, SessionTree, ResilientWebviewView (~0.6k) | KEEP | native VS Code UI |
| `ui/AgentPanel` (7.2k) | KEEP ~2k shell; REUSE ~3.2k; MIGRATE ~1.4k | ledger/approvals/rehydration/cloud selection duplicate `/v1/conversations*`, `/v1/approvals/*`, `/v1/workspaces/attempt-rehydration`, `core/platform/cloudRouting` |
| `ui/LocalBoardPanel`, `stories` (0.8k) | REUSE | `/v1/stories`, `/v1/board/snapshot`, `/v1/dev-stories` |
| `ui/executionProjection`, `taskResultAssembly`, `recentArtifacts` (1.3k) | MIGRATE to shared | Core events + `/v1/artifacts` |
| `preview`, `workspace` (discovery/registry/git onboarding), `config/Config`, `util`, `services/Logger+StartupTelemetry` (~1.5k) | KEEP | native |
| `repository/RepositoryGraphService`, `VSCodeWorkspaceHost`, `TsAstExtractor` (0.4k) | KEEP | host adapter for `core/platform/repo` |
| `repository/RepoFast*`, `RepositoryFacts`, `RepoEvidencePlans`, `WorkspaceInventory`, `context/*` (~7k) | MIGRATE | pure Node; move into `core/platform/repo` and expose a Core route that returns `RepositoryContextPackage`; `context/ContextSelector` has no Core home |
| `context/RepositoryIndex` (1.1k) | DELETE after repoint | `core/platform/repo` indexer |
| `onboarding`, `diagnostics` (3.1k) | KEEP panel UI (~1.7k); REUSE readiness logic (~1.4k) | `/v1/providers`, `/v1/cloud/*`, `core/runtime/providerReadiness` |
| `providers` (3.1k), `models` (2.2k) | REUSE; keep ~250 LOC SecretStorage-to-Core bridge | `core/platform/providerCatalog`, `cloudRouting`, `domain/modelRouting`; `models/TaskModelSelection` is shared with Core tests, move or drop |
| `agent/Forge*`, `LocalAgentEngine`, `AgentLoop`, `*AgentRuntime`, Planner, ModelRouter... (~7.3k) | DELETE | not on the live path; `runPiAgentLoop` in Core |
| `orchestration` multi-agent, task graph, scheduler (~2.4k) | DELETE | `domain/delegation`, kandev |
| `tools`, `editing`, `mcp`, `sandbox`, `extensibility`, `skills`, `hooks`, `browser`, `remote` (~6.6k) | DELETE with the local agent | `core/runtime/toolRunner`, `writeProposal`, `/v1/tools/hub`, `core/platform/skills`, `browserCapability` |
| `activation`: registerCommands/Views, ConfigureProviderModel (~0.6k) | KEEP, prune commands | |
| `activation`: Forge demo/readiness, M16 eval commands (~1k) | DELETE | |
| `activation/M15AutonomousRuntime`, `autonomous/*`, `coding/*`, `autonomy`, `reliability`, `LocalDeliveryService` (~24k) | MIGRATE then DELETE | Karke Dikha cutover to Core missions/dev-stories; Core lacks: applying a proposal to the open workspace with anchored edits, local commit/PR approval flow |
| `organization`, `scrum`, `sprint`, `repair`, `workforce`, `teams`, `roles`, `mission`, `planning`, `governance`, `memory`, `performance`, `review`, `multirepo`, `automation`, `frontier`, `security`, `policy`, `validation`, `runtimeProfile`, `intelligence`, `systemOne`, `control`, `runtime`, `prompts`, `telemetry`, `observability` (~15k) | REUSE or DELETE | `domain/engineeringOrganization`, `/v1/engineering/*`, kandev, `domain/memory`, `runtime/missionRunner`, `core/security/*`; MIGRATE only ~570 LOC (`gh` PR/CI readers feeding `/v1/engineering/ci/*`) and possibly `reliability/ModelProfiles`+`ToolCallReliability` (~1k) |
| `evals`, `acceptance`, `e2e`, `release` (~2.8k) | DELETE or move to scripts | |
| `ui-test` (3.9k, .mjs) | KEEP as dev tooling, move out of `src/` | used by golden/guardian scripts |
| `media/*.js` (10.8k) + `src/webview-v2` (2k) | media DELETE once webview-v2 has parity (flag `uiV2Enabled`, default off) | patch layers `chat-fixes`, `chat-runtime-fixes` |

Estimated end state: roughly 94k extension-only lines down to about 15-20k (shell, Core client, repo host adapters, v2 webview), after the Karke Dikha cutover.

## Order of work

1. Done on this branch: Classic UI, unreferenced acceptance scripts.
2. Dead local chat engine (about 12k): slim `AgentRuntime` to `CoreClient` calls, delete Forge/Local*/orchestration/demo commands. Needs extension-host startup check.
3. Repo-context move into Core (route returning `RepositoryContextPackage`), then delete `RepositoryIndex` and the duplicated AgentPanel logic.
4. Karke Dikha cutover to Core missions/dev-stories (owner decision: behaviour change), then delete the M15/coding/autonomy stack (about 24k).
5. `media/` removal after webview-v2 parity; move `core-client` to a shared package.

## When Core is unavailable

`CoreManager` already launches/attaches to Core and exposes connection state. Target behaviour for the thin client: chat and tasks show "Core is not running" with Start/Retry; editor-native features (diagnostics, diff review, preview, workspace context) keep working; no local fallback engine.
