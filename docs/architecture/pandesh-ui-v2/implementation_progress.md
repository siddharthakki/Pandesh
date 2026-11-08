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

## Milestone 2c — Tools, Skills & MCP Hub · STATUS: done

System → Tools & Skills (`core/api/toolHubRoutes.ts`, `ToolsHub.tsx`), a read-only projection of existing registries — no new registry: governed capabilities (GovernedCapabilityRegistry: tools, risk, health), chat-engine tools (chatToolSelection map), agent × tool matrix computed with the 2b scope rules (exactly what Core allows; edits go through Team, tighten-only), built-in skills, connectors (existing `/v1/connectors`), MCP shown honestly as "no servers registered with Core", 30-day usage per tool from `tool_invocations`, and capability tests = the existing capability-inventory probe (checks only) with a durable history (`capability-test-history.json`).

Verified: Core api/agentScope/chatToolSelection 53/53, desktop 605/605. Real app: 161 tools (116 governed, 45 native), 25 capabilities with real health (Gmail/Calendar/WhatsApp/Printer "authorization required" in the scratch profile), usage evidence from earlier acceptance runs, Research mapped to exactly its 10 public-research tools; capability test 8 s — 40 working, 4 unverified, 1 unreachable, 3 missing, 4 not connected; history recorded. `acceptance-2c/hub-tools.png`.

Gaps: no Core MCP registry (nothing to show or connect); assigning capabilities to agents is tighten-only via Team (widening a built-in is deliberately impossible); custom agents from templates are not built yet.

## Milestone 2d — Second Brain · STATUS: done

| Area | Implementation |
|---|---|
| Storage | Existing memory tables kept. Migration 49 (additive): `knowledge_sources` (user-granted folders only), `knowledge_chunks` (derived, rebuildable), `knowledge_links` (explicit `[[wikilinks]]` / markdown links), `brain_fts` (FTS5, unicode, diacritics folded), `brain_index_state`. Rebuild only when a source signature changes. Migration 47 restored byte-identical (2b had split it). |
| Index | Active facts (restricted never), notes, commitments, artifacts, real entities (decision/user mirrors excluded), and .md/.txt sections (≤ 512 KB, ≤ 2000 files) from folders allowed in `document_read_grants`. Revoked or deleted files leave the index. No crawling; no embeddings (gate not met). |
| Search | bm25 with title weighting, best-column snippets, type/scope filters; user text is turned into a safe quoted-prefix FTS query (no operator injection). |
| Inspector | Fact: content, scope, source message and conversation, history (revisions/forgotten), conflicts. Documents: section text, links and backlinks. Notes/commitments/artifacts/entities. |
| Timeline | Facts, notes, commitments, artifacts by date. |
| Graph | Only real edges: Core relationships (with evidence id), explicit document links, fact → source conversation provenance; deduped; ≤ 150 nodes with cluster counts beyond; deterministic SVG force layout (sigma/graphology trial not run). |
| Correct / forget | Correction = user message in "Second Brain corrections" + rememberMemory with that evidence + forget old + resolve the recorded conflict as prefer_later. Forget shows `analyzeMemoryImpact` first, then tombstones via `forgetMemory`; search, timeline and graph update. |
| Agent scopes | Memory tools at dispatch now enforce Core scope types per agent (user/project/task/repository/global; reads vs writes; recall without scope narrowed or refused); the memory bridge passes the acting attempt (`actingAttemptId`, not part of approvals). 2b definitions mapped to the real scope types. |
| API / UI | Host-only `/v1/knowledge/{status,reindex,search,items/:type/:id,timeline,graph,facts/:id/{impact,forget,correct}}`; Spaces → Second Brain (Search, Timeline, Graph, Sources with add/revoke folder). |

Full Core suite: 2469 passed, 2 failed — m54 disk benchmark (pre-existing) and householdHardening's TLS listener test, which binds a random port 49152–59152 and fails when it collides with a port held by the concurrently running isolated app (2 of 9 runs; 6/6 when rerun; code under test untouched).

Tests: `core/test/secondBrain.test.ts` 10/10 (+ agentScope 13/13): mixed-type search with snippets, restricted exclusion, type filter, rebuild-on-change, revoked folder, query sanitising, link-only document edges (co-mention produces none), Core relationship + provenance edges, 150-node cap with clusters, correction provenance + conflict resolved + old value gone, forget, restricted inspector refusal, agent memory scopes incl. through delegation.

Real app (isolated profile): scenario 9 PASS — memory created in chat with consent approval; Second Brain search found it and the inspector showed its source message/conversation; folder allowed from the UI indexed 4 sections; "hotel sacher" found `hotels.md › Hotels`; graph showed trip.md→hotels.md and trip.md→budget.md, not the merely co-mentioning museums.txt. Scenario 10 PASS — correction via inspector (new value with "Second Brain corrections" evidence, old value forgotten and gone from search), forget with impact preview ("1 linked item"), memory gone from search and graph. `acceptance-2d/`.

Gaps: no watcher (index refreshes on access when a source changed); suggested/extracted edges and confirm/reject are not built (no extraction); 3D view deferred (D2); folder picker is a path field (no native dialog for this purpose yet).

## Milestone 2e — Visual Execution · STATUS: done (embedded workspace; Show My Work partial)

| Area | Implementation |
|---|---|
| Activity/Preview aside | `Activity.tsx` in chat: every step Core recorded for the conversation (state, capability, duration); preview of the selected step exactly as the tool published it — command output (run_checks' recorded tail), coloured unified diff of file changes, page URL and text, image artifacts; files of the conversation with on-disk verification and Open / Show in folder. Opens by itself once per task when a viewable step appears; closing keeps it closed for that task; "Workspace · n" reopens it; full-screen on narrow widths. |
| Processes | `core/api/processRoutes.ts` + `Processes.tsx` (System → Processes): processes Pandesh recorded launching (ownership ledger, Port Manager registry, browser launch record), checked with one CIM query: running only when executable and start time match; ended; pid reused; identity unconfirmed. Read-only — stopping is task cancellation and the existing ownership boundary. |
| Answers | Safe Markdown rendering (React elements only). Composer height resets after sending. |
| Show My Work | "Show folder" opens the workspace in Explorer; artifacts open in their default app. Opening VS Code / Windows Terminal windows and a live PTY terminal are NOT built (node-pty/xterm trial not run; D2). |

Tests: `core/test/ownedProcesses.test.ts` 6/6 (running only on matching identity, ended, pid reuse by executable and by start time, unconfirmed, record merge, single CIM query); targeted Core 47/47; desktop 605/605.

Real app (isolated profile, Coding agent, gemma4:12b): scenario 11 PASS — "create calc.js + calc.test.js, run node calc.test.js": approvals for file changes and for running code; steps Editing calc.js [diff], Editing calc.test.js [diff], Running node calc.test.js [output "PASS"]; files verified on disk (independent re-run prints PASS); aside opened by itself. Processes view: current Core running (pid, port, identity matched), 9 earlier Cores (incl. the two killed in scenario 6) ended. `acceptance-2e/`.

## Milestone 2f — User workspaces · STATUS: done

Spaces → Projects, Wish to Reality, Social Studio, Media Studio, Automations (`Workspaces.tsx`), each from existing Core records:

| Space | Source | Actions |
|---|---|---|
| Projects | `/v1/projects` | read; details per record |
| Wish to Reality | `/v1/wishes`, `/v1/wishes/business` | read only (feature-frozen); "not recorded — outward actions stay disabled"; demo records labelled |
| Social Studio | NEW `social_drafts` (migration 50, `core/domain/socialDrafts.ts`, host-only routes) | save draft, approve (→ "approved, not published"), ask for revision (with note or new text → revision+1), reject (reason required); "Ask Pandesh to draft" pre-fills chat. No publishing exists. |
| Media Studio | existing image-studio probe + image/video artifacts | thumbnails, open; "Ask Pandesh for an image" pre-fills chat (generation stays governed, approval first) |
| Automations | household routines, daily-brief routine, command queue | Run now / Pause / Resume on routines (existing routine control) |

Also: an app-wide error boundary (a failing surface shows the error with Reload / Use the Classic UI instead of a blank window), `PANDESH_UI_V2_DEV=1` readable development bundle.

Bug found in the real app and fixed: switching spaces rendered the new view once with the previous space's data → crash (blank window before the boundary existed). Data is now tagged with its space.

Tests: `core/test/socialDrafts.test.ts` 3/3; targeted Core 50/50; desktop 605/605. Real app: all five spaces open with truthful (empty-profile) content; a Social draft saved and approved → "approved not published", note "It is NOT published". `acceptance-2f/social.png`.

Known issue: Media Studio shows the existing host image-studio probe verbatim, which reported "Ollama not answering" while Ollama was running (the probe's own definition; not changed here).

### Next executable step

Milestone 2g — Voice in v2: reuse the existing local ASR (voiceCapture / transcribeUtterance) and TTS (speakText / stopSpeaking); listening, speaking, interrupted and muted states from the host snapshot; real cancellation.

### Resume

```
cd D:\Projects\Pandesh-ui-v2-implementation
npm ci --ignore-scripts   # then copy native builds from D:\Projects\Pandesh\node_modules (@vscode/sqlite3 build/Release, sharp/build, onnxruntime-node/bin)
# junctions (git-ignored): apps/desktop/node_modules, runtime, models, runtime-assets/node_modules -> D:\Projects\Pandesh\...
node apps/desktop/esbuild.mjs
# isolated run: KARKEDIKHA_DESKTOP_DATA_DIR=<scratch> KARKEDIKHA_DESKTOP_CDP_PORT=9481 PANDESH_UI_V2=1 node apps/desktop/launch.mjs
```
