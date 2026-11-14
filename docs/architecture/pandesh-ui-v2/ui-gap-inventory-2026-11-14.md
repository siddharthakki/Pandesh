# v2 UI gap inventory: what Core and the host can do versus what the v2 UI exposes

2026-11-14, after Build 171. Inventory only; no redesign is started. Sources: `ui_information_architecture.md`, `feature_gap_matrix.md` (the Hermes-inspired v2 plan), `apps/desktop/src/ipc.ts` (the host surface) and `apps/desktop/renderer-v2/src` (the v2 renderer, 2,397 lines).

Method note: the "not used by v2" counts come from a name search. Of the 128 host IPC capabilities in `ipc.ts`, about 100 are never referenced in `bridge.ts` or any v2 `.tsx` file. A few may be reached indirectly through Core HTTP calls, so treat the list as a lead, not proof.

## Priority 1. Navigation and settings

| Gap | Evidence | Reuse |
|---|---|---|
| No Settings or System destination in v2. The plan (IA section 2) puts Tools and Skills, Automations, Settings and Diagnostics behind one System menu; v2 has none of it except the Tools & Skills page. | `App.tsx` rail: Pandesh, Board, Team, plus palette entries. No "settings" string. | Host already has `setPermissionMode`, `selectProvider`, `selectWorker`, `getDiagnosticsReport`, `getUpdateStatus`, `startUpdate`, `getMobilePairing`, `setWakeWordEnabled`, `configureDailyBriefRoutine`. |
| Model and provider selection cannot be changed. Chat shows "Local · model (auto)" read-only. | `Chat.tsx` lines 256 to 312 show labels only. | `selectModel`, `listModels`, `selectCloudModel`, `selectProvider`, `discoverCloudModels`, `refreshCloudCatalog`, `setCloudLocalFallback`. |
| Cloud provider keys, OpenRouter key, Google OAuth client, Gmail connect cannot be managed. | `setCloudProviderKey`, `setOpenRouterApiKey`, `saveGoogleOAuthClient`, `connectGmail` unused. | Existing host calls; Credential Manager storage already exists. |
| Permission mode (Ask, Auto, Plan Only) not visible or switchable. | `setPermissionMode` unused. | Existing. |
| Two shells still ship. The palette says "Use the Classic UI"; the v2-only change (#73) is unmerged and conflicting. | `App.tsx` line 110. | Decide on #73 or drop the entry. |
| Navigation is a rail plus a palette. Eight destinations are reachable only through the palette or the Spaces popover (Software, Radar, Revenue, Processes, Second Brain, workspaces). | `App.tsx` lines 101 to 108. | Existing IA already groups them. |

## Priority 2. Chat attachments (files, images, documents)

The v2 composer has none. The host has the whole path; the renderer does not call it.

| Missing in v2 | Host capability that exists |
|---|---|
| Attach button and native file picker | `pickAttachments` |
| Drag and drop, paste of images | `stageAttachmentBytes` |
| Remove an attachment before sending | `removeAttachment` |
| Attached pictures as references for image work | `useArtifactAsReference`, `openArtifactInStudio` |
| Attachment chips on sent messages | message type already carries `attachments` (`ipc.ts` line 705) |
| Folder as workspace with consent card | `pickFolder`, `clearFolder`, `openWorkspaceFile` |

The Classic UI renders chips (`renderer.js` line 2883), so behaviour and wording can be copied. The paused composer-attachments plan (memory note `v2-composer-attachments`) holds a full design; its worktree has uncommitted, non-compiling Core edits.

## Priority 3. Live execution Activity

Largely delivered by #91: current request with phase, elapsed time, quiet time, tool timings, approvals, failures, folded history, technical details. Remaining:

- The packaged-Electron check of the #91 fixes (interrupted run shown as Interrupted, "(after resume)" pass labels) and the screenshot/vision step (A7) has not been run.
- A queued request behind GPU work cannot be told apart from model loading.
- The planned preview pane (terminal, browser, diff, image tool views) and "Show my work" are not built (`feature_gap_matrix.md`, Visual Execution rows).
- Agent Reach and skill reads appear only as ordinary tool rows; nothing marks them as external or third-party.
- `getHostTelemetry`, `openActivityDocument`, `cancelImageGeneration` have no UI.

## Priority 4. Discoverable tools, models and skills

- Tools & Skills page exists (tabs: Tools, Agents x Tools, Skills, MCP servers, Capability tests, Connectors). Gaps: the Skills tab is a read-only list, with no relevance, missing-requirement or trust explanation, and it does not show the user-skill folder that #90 loads from.
- The MCP tab only shows a note; Core-side MCP is still extension-only (matrix row P2).
- Models: no screen lists installed, loaded, usable or vision-capable models, although #89 computes exactly that (`modelAwareness`, `capability_explain`). The user can only ask the model.
- No "what can you do right now" view tying Installed, Loaded, Usable and Authorized together.
- Agent Reach status (installed or not, isolated home, allowed actions) is not shown anywhere.

## Priority 5. Consistent access to existing workflows

Reachable in Classic or the host but with no v2 entry point, or only through chat:
Gmail (summarise thread, dispatch actions, resolve approvals), reminders and notes (`createReminder`, `completeReminder`, `createNote`, `updateNote`), image generation (`generateImage`), web research (`startWebResearch`, `resolveWebResearch`), the command queue (`enqueueCommand`, `editQueuedCommand`, `reorderQueuedCommand`, `postponeCommand`, `skipCommand`, `confirmCommandRun`), dev stories and their review approvals, conversation management (`renameConversation`, `pinConversation`, `archiveConversation`, `exportConversation`, `searchConversations`), voice (`transcribeUtterance`, `speakText`, wake word controls), mobile pairing, update status and daily brief setup.

## Suggested order for the later UX work (not started)

1. System menu with Settings: model and provider picker, permission mode, connections, diagnostics, updates.
2. Composer attachments (host path exists).
3. Model, skill and tool discovery view fed by `modelAwareness` and the capability inventory.
4. Conversation management and search in the drawer.
5. Queue and reminders panel, then the preview pane.

## Not verified

Counts are from source search, not from running the app. Whether each host call still works end to end was not tested.
