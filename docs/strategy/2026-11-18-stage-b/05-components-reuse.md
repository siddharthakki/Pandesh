# Stage B — reusable components and new ones needed

## Existing renderer-v2 components to reuse

| Component | Path | Reuse in Stage B |
|---|---|---|
| Rail + More popover + Palette | `App.tsx` | Preserve seven destinations; trim "More" (16 → grouped: Work, Tools, Insights, System) |
| Composer (attachments, voice, model picker, permission mode, folder chip) | `Chat.tsx`, `ComposerControls.tsx`, `Attachments.tsx`, `FolderControl.tsx` | Idle home composer — keep as-is |
| MissionDock + StepRow | `Missions.tsx`, `missionModel.ts` | Core of Mission Control pane; add counts, evidence refs, controls |
| Activity aside | `Activity.tsx` | Evidence inspector; expandable tool I/O, secret masking, screenshots |
| Approval card | `Chat.tsx` `section.approval`, `APPROVALS` map | Approval required state; add consequence line + "Show full diff" |
| Board (6 columns) | `Board.tsx`, `boardModel.ts` | Task status surface; keep stale-state honesty messaging |
| Bots cards | `Bots.tsx`, `botsModel.ts` | Bot details state; add memory aside |
| ToolsHub + CapabilityExplorer | `ToolsHub.tsx`, `CapabilityExplorer.tsx` | Tools & Skills destination |
| Software inventory | `Software.tsx` | PC workspace "Services & apps" section |
| Second Brain | `SecondBrain.tsx` | Memory panel in workspace/Bot |
| Automations | `Automations.tsx` | Routines view; next run + last result |
| Connections / Phone / ProviderCards | `Connections.tsx`, `Phone.tsx`, `ProviderCards.tsx` | Connections destination |
| Workshop viewers | `workshop/` (Viewer3D, SimulationLab, DesignPreview, VideoWorkshop, ImageViewer) | Workshop surface (unchanged) |
| Settings | `Settings.tsx` | Settings destination |
| ui.tsx (tokens, icons, focus, reduced-motion) | `ui.tsx` | **Foundation** — extend tokens, add new icons |
| markdown renderer | `markdown.tsx` | Receipt prose |
| bridge.ts (host API) | `bridge.ts` | Add receipt/rehearsal/workspace contract calls |

## New components needed (Stage C/D/E)

| Component | Purpose | Complexity |
|---|---|---|
| **Mission Control pane** | Contextual right pane with live timeline, counts, controls | Medium — reuse MissionDock + StepRow, add pane chrome + controls |
| **Outcome Receipt** | Centered completion card with stamp, ops, artifacts, evidence levels, share/undo | Medium — new component; data needs receipt aggregation |
| **Rehearsal pane** | Preview of proposed changes: move map, conflicts, space, simulated-vs-tested banner | Medium — new; data from pc_organize_plan + renderPlanPreview |
| **Autonomy Contract card** | Allowed/not-allowed lists, schedule, runtime, review/revoke | Medium — new; substrate exists (Auto grants + scopes) |
| **Living Workspace (structured)** | Goal header, "where we left off", sections with timestamps, next action, contract summary | Medium-High — replaces RecordCard dumps |
| **Receipt stamp (motion)** | Animated verified/failed stamp | Low — CSS + spring easing |
| **Evidence level chip** | observed / checked / reviewed | Low |
| **Bottom sheet (compact)** | Mission Control / approval / receipt as sheet | Medium — new primitive |
| **Onboarding first mission** | Guided, isolated-fixture mission | Medium — new |

## Implementation risks of reuse

- **Inline-style sprawl** in JSX (Chat, Bots, Phone, etc.) — tokens keep it consistent but layout logic is scattered. New components should put layout in `app.css` with token classes, not inline styles, to avoid compounding.
- **Classic still ships and is the default** — any new component must be v2-only; Classic gets nothing new. Recommend making v2 default at Stage C completion (attachments gap is closed).
- **`Workspaces.tsx` RecordCard dumps** read as a dev tool — must be replaced, not extended, for the Living Workspace.
- **Board is six plain text columns** — needs visual hierarchy upgrade for the receipt/mission states to feel premium.
- **"More" popover (16 destinations)** is becoming the new hidden-navigation problem — regroup before adding Mission Control/Receipts/Rehearsal entries.