# Pandesh UI v2 — implementation progress

Branch `feat/pandesh-ui-v2` · worktree `D:\Projects\Pandesh-ui-v2-implementation` · base `06b8c59` on `fix/reliability-remediation` (contains RC 557b0c4, the pdfjs/xmldom security fixes 0815055 / 1b13bd5 / 2019e1b, and origin/main). Local commits only: nothing pushed, merged, installed or deployed. Production (`E:\Pandesh`) and the reliability worktree (`D:\Projects\Pandesh`) are untouched.

Design source of truth: P1 DESIGN FROZEN — docs branch `docs/pandesh-ui-v2` @ 733bc0a, `docs/architecture/pandesh-ui-v2/p1-final/`.

## Milestone 2a — UI foundation, P1 chat, unified Board · STATUS: done (acceptance below)

### What works (real, Core-backed)

| Area | Implementation |
|---|---|
| Feature flag | `PANDESH_UI_V2=1` (env, wins) or the saved `uiVariant` host preference selects `renderer/v2/index.html`; default stays the classic renderer. In-app switch both ways (`setUiVariant` reloads only the asking window). Classic renderer is unchanged. |
| Build | `apps/desktop/esbuild.mjs` bundles `apps/desktop/renderer-v2/src` → `renderer/v2/app.js` (React 19 already in the repo; no new dependency). Same CSP: `script-src 'self'`, no network. Portable packaging already copies `renderer/`. |
| Data access | Only the existing preload bridge (`window.desktop`). One event subscription fanned out; snapshot and task overview refresh on Core events (coalesced) plus a 5 s safety poll. |
| P1 chat | Centred idle home, real assistant brief (Core `home` items with their source and check time, real actions; approve/decline inferred from the action label like the classic UI); transcript from Core's durable messages; live token streaming; truthful working state (Core step title or "Thinking"/"Writing" with elapsed time since this window saw the start, never a percentage); Stop; routed-send notices (side question, queued, steered …); inline approval card for tool / image / weather approvals with plain-language action and the raw tool id, Allow / Don't allow; narrow-width fixed decision bar; compact provider footer ("Local · model") with details on click. |
| Board | Columns derived only from Core `TaskOverviewRow` (`boardModel.ts`): Running requires Core's lease-backed `live`; a dead worker's task shows as Blocked; nothing is "completed" before Core says so; while Core is not answering the last read is shown as unconfirmed (nothing claims Running, Stop hidden). Cards: worker, model, elapsed/finished time, Core activity line, failure reason, Open chat / Stop / Resume. Board badge = Core tasks waiting for approval. |
| Navigation & a11y | Rail (tooltips + optional labels) / bottom bar < 900 px; Spaces and System popovers; Ctrl+K palette (go-to, new chat, theme, recent chats from Core); Escape closes and returns focus; visible focus ring; dark / light / follow-Windows. |
| Not-yet-built surfaces | Team, Second Brain, Projects, Wish to Reality, Social Studio, Media Studio show a labelled "arrives in milestone 2x" page with a button to the Classic UI. No fake data anywhere. |

### Files

- `apps/desktop/src/host/desktopHostPreferences.ts` — `uiVariant` pref + `resolveUiVariant`
- `apps/desktop/src/main.ts` — `rendererEntry()`, `getUiVariant` / `setUiVariant` handlers
- `apps/desktop/src/ipc.ts`, `apps/desktop/src/preload.ts` — two channels
- `apps/desktop/esbuild.mjs` — v2 bundle target
- `apps/desktop/renderer/v2/index.html`, `app.css` — shell + frozen P1 tokens
- `apps/desktop/renderer-v2/src/{main,App,Chat,Board,boardModel,bridge,ui}.tsx?` + `tsconfig.json`
- `apps/desktop/test/uiV2BoardModel.test.ts`
- `.gitignore` — generated `renderer/v2/app.js`

### Tests

- New unit tests `apps/desktop/test/uiV2BoardModel.test.ts`: 7/7 pass (column truth rules, needs-you count, flag precedence).
- `tsc` strict on `renderer-v2`: clean. Desktop host `tsc`: 27 errors before and after (all pre-existing, none in changed code).
- Full desktop suite (`apps/desktop/test`): see "Regression" below.

### Real-app acceptance (isolated profile, `launch.mjs`, scratch `KARKEDIKHA_DESKTOP_DATA_DIR`, own Core, CDP 9481, local-only routing, `gemma4:12b` = production's model)

| # | Scenario | Result | Evidence |
|---|---|---|---|
| 1 | Original UI with flag OFF | PASS | Same profile relaunched without the flag loads `renderer/index.html`; classic composer chat completed ("classic"). Switch classic→v2→classic via IPC and the v2 System menu works; pref persisted. |
| 2 | P1 real chat with Ollama | PASS | "capital of Austria" → "The capital of Austria is Vienna." 12 s, `gemma4:12b`, outcome completed/answered; transcript from Core. `acceptance-2a/idle-v2.png` |
| 3 | Chat while a task runs | PASS | Live stream observed ("Writing", 201 chars at 2 s); second send routed by Core as `side_question`, shown truthfully; both answers stored. `streaming.png` |
| 4 | Approval → reject → no mutation | PASS | Real `authorize_mission` (gate mutation) card; Don't allow → Core approval `rejected` (18:56:13Z), `write_file` invocation `failed`, workspace has no `hello.txt`, `existing.txt` intact. Repeated after the wording fix (`notes.txt` not written). `approval.png` (before), `approval-fixed.png`, `approval-narrow.png` (fixed decision bar) |
| 5 | Board updates from Core | PASS | New task appeared under Running (live); finished tasks under Completed / Failed with Core's reason. `board.png` |
| 6 | Core restart recovery | PASS (after fix) | Killed the isolated Core mid-task twice. Host reconnected to a new Core (~24 s). Attempt recovered as failed with Core's "Interrupted: KarkeDikha restarted…" reason. First run exposed stale "Running" during the outage → fixed; re-run: Running empty, task under Blocked "Core is not answering — status unknown", no Stop. `board-outage.png` |
| 7–11 | Agents, Second Brain, coding output | NOT RUN | Milestones 2b, 2d, 2e |
| 12 | Cancel; unrelated processes survive | PASS | Chat Stop → Core attempt `cancelled`; notice ends "Stopped. Core recorded the task as cancelled." Full before/after process diff (530 processes, no test suite running): only the tester's own shells and one `msedgewebview2.exe` (not in the profile's process-ownership ledger) ended; Ollama and an unrelated local server survived. Production Pandesh was not running, so its survival was not observable in this run. |
| 13 | Narrow / desktop / dark / light | PASS | `chat-dark-desktop.png`, `chat-dark-narrow.png`, `board-light-narrow.png`; keyboard: Ctrl+K opens palette with focus in input, Escape closes and restores focus, 0 unnamed controls, all rail buttons have tooltips. |
| 14 | Regressions | PASS | Full desktop suite `apps/desktop/test`: 605/605 after updating `backgroundTray.test.ts` for the new `uiVariant` default (the only failure on the first run). Core suites not re-run (Core unchanged on this branch). Classic UI chat verified in scenario 1. |

Fixed during acceptance: brief not reloaded after Core finished starting; raw tool id on the approval button ("Allow authorize_mission" → "Allow file changes in this folder", tool id kept as a row); "The last turn failed." shown after the user declined; stale Running during Core outage; "Stop requested" never updated after Core confirmed.

### Known gaps / deviations (2a)

- Fonts: Geist/Newsreader are not bundled and the CSP blocks web fonts; v2 uses Segoe UI Variable / Cambria / Cascadia Mono. Vendoring the OFL fonts is a small follow-up.
- Voice: the v2 composer has no microphone yet (the classic UI keeps voice). Milestone 2g.
- Attachments, model picker, permission-mode switch and conversation list drawer are reachable only via the Classic UI (palette lists recent chats).
- Transcript keeps its scroll offset when the window is resized (not re-pinned to the end).

## Software Discovery & Update Manager — milestone 1B (read-only) · STATUS: done

Inserted by owner request after 2a. Details, tests and limits: [software_discovery.md](software_discovery.md). Read-only: no install/update/start/stop. Update execution (2B) awaits separate approval.

## Milestone 2b — Specialist Agent Team · STATUS: done

| Area | Implementation |
|---|---|
| Definitions | `core/domain/agents.ts`: built-ins Pandesh (Chief of Staff), Personal, Coding, Research, Operations, Voice; Sales, Marketing, Social Media, Customer Support as Phase 3 templates (cannot be enabled or run). Each has an allowlist (`prefix_*` families), denylist, folders (`conversation` = the chat's selected folder), memory scopes, egress, always-ask categories, local-only model policy, limits (depth ≤ 2). Built-ins can only be tightened (enabled, model policy, extra denials/approvals); every change bumps the version. Migration 48 (additive): `agent_definitions`, `agent_runs`, `agent_handoffs`, `agent_scope_refusals`. |
| Scope gate | Effective scope = stack of layers (definition, every delegating parent, explicit grant); allowed only if every layer allows ⇒ delegation is an intersection and cannot widen tools, folders, memory or egress. Frozen into `agent_runs` at submission (later edits don't change a run in flight). Enforced (1) at exposure in the chat engine (tools filtered; agent identity in the system prompt), (2) per call on every kept tool (path arguments vs roots, incl. `..` and absolute escapes), (3) in Core's `dispatchCapability` for any governed call made for an agent run. Refusals are recorded and shown. |
| Delegation | `POST /v1/agents/delegate` (host-only): child request runs as the target agent with parent scope ∩ child definition ∩ grant (an ordinary Pandesh turn delegates as Chief of Staff); dedupe; fan-out ≤ 3 active (finished children free their slot); depth ≤ 2; no self-delegation; a brief copying ≥120 chars of untrusted tool output (web, email, documents, files) from the parent turn is refused. |
| Runs | On demand in the existing executor; `/v1/submit` takes `agentId` (atomic with the request). No resident model per agent. |
| UI | Team: directory ordered by real state (needs you, working, idle, off, Phase 3), detail tabs Overview / Activity / Capabilities / Memory / Model & limits / Refusals, Message <agent> (chat header "Talking to Coding · Back to Pandesh"), turn on/off, delegate from your latest task with your own brief. |

Tests: `core/test/agentScope.test.ts` 13/13 adversarial (tool and path escapes, traversal, grant widening, parent widening, depth, dedupe, fan-out + release, self/template delegation, injected brief, dispatch gate + audit, frozen scope, disabled/Phase 3). Full Core suite: 2458 passed, 3 failed — agentScope (suite started mid-edit; passes alone), hermesEngine (timeout under load; passes alone), m54 disk-CAS benchmark (fails identically without 2b: 8.8 ms vs 2 ms on this disk — pre-existing, environment-dependent).

Real app (isolated profile, gemma4:12b): scenario 7 PASS — ordinary task → UI delegation to Coding → child ran with layers coding@1 ∩ chief@1, depth 1, answered "1 TypeScript file: src/a.ts" from the real workspace. Scenario 8 PASS — Message Coding "read C:\Windows…win.ini": model was offered read_file, Core refused the path at call time and recorded "outside the folders allowed by agent:coding@1"; the reply says so. Screenshots `acceptance-2b/`.

Known gaps (2b): memory tools are gated per agent, but recall is not yet filtered by memory scope type (2d); egress policy is recorded and shown, enforcement remains the existing global approval rules; delegation is started by the user from the UI — a model-callable `delegate_to_agent` tool for the Chief is not added yet (needs the approval card "Coding, for Pandesh …"); a Chief delegation cannot grant writes (by the intersection rule) — writes need Message Coding directly.

### Next executable step

Milestone 2c — Tools, Skills & MCP Hub (System → Tools & Skills): governed capability catalog with risk class and executor, agent × capability mapping from 2b definitions, connector status and capability-test evidence; reuse existing registries.

### Resume

```
cd D:\Projects\Pandesh-ui-v2-implementation
npm ci --ignore-scripts   # then copy native builds from D:\Projects\Pandesh\node_modules (@vscode/sqlite3 build/Release, sharp/build, onnxruntime-node/bin)
# junctions (git-ignored): apps/desktop/node_modules, runtime, models, runtime-assets/node_modules -> D:\Projects\Pandesh\...
node apps/desktop/esbuild.mjs
# isolated run: KARKEDIKHA_DESKTOP_DATA_DIR=<scratch> KARKEDIKHA_DESKTOP_CDP_PORT=9481 PANDESH_UI_V2=1 node apps/desktop/launch.mjs
```
