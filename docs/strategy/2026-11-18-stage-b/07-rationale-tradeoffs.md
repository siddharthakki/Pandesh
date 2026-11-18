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
- **"More" popover (16 destinations)** is becoming the new hidden-navigation problem — regroup before adding Mission Control/Receipts/Rehearsal entries.<|end|><|start|>write to=assistant<|channel|>analysis <|constrain|>xml<|message|><rfl:parameter name="content">
# Stage B — why Pandesh, every day

## The question the design must answer

> Why would someone prefer using Pandesh every day rather than ChatGPT, Claude, Hermes or another agent dashboard?

## The answer

Because Pandesh is the only one that **shows its work, proves what it did, and lets you rehearse before it acts** — and it runs on your own PC, under your rules.

ChatGPT, Claude and Hermes give you an answer. Pandesh gives you an **outcome with a receipt**: the objective, the operations actually performed, the artifacts, the verified outputs with their evidence level, the partial/failed steps, the approvals used, the model and provider, the duration and cost, the next action, and an undo where supported. If it can't prove a step, the receipt says so — and the mission stops instead of claiming success.

That single difference — **verified delegation instead of confident claims** — is the product. Everything else (local-first, permissions, missions, workspaces, bots) exists to make it trustworthy and continuous.

## The daily loop the design serves

1. **Morning:** open Pandesh. The home is calm. "3 things need you" (approvals) + a recent receipt strip + the composer. You see yesterday's finished work at a glance.
2. **Delegate:** type an intention ("find what's eating space on C: and help me clean it safely"). Pandesh plans a mission. A card appears. You keep chatting.
3. **Watch:** the Mission Control pane shows real counts, real agents, real tools. You can pause, stop, take control, or just let it run.
4. **Decide:** an approval card names the exact action and its consequence. You allow or don't. Nothing runs until you choose.
5. **Receive:** a receipt lands — what happened, what's verified, what failed, what to do next, how to undo.
6. **Continue later:** switch tasks, come back tomorrow. "Where did we leave off?" is answered with real stored state, not a re-explanation.

## Rejected alternatives (in design)

- **A dashboard-first home.** Rejected: the mandate says calm when idle. Dashboards make noise when nothing is happening. Home is a conversation with a quiet summary.
- **A swarm of animated agents.** Rejected: one responsible lead + specialist + reviewer, traceable. Avatars are initials, not orbs.
- **Glass/neon/sci-fi.** Rejected: professional instrument aesthetic. Teal accent only, restrained elevation, no glass overload.
- **Percent-based progress.** Rejected: counts and milestones only. No guessed percentages.
- **A universal visual workflow designer.** Rejected: rule-based mission planning by the lead; no node editor.
- **Auto-resume after restart.** Rejected (deliberate): truthful `interrupted` status + user-triggered resume from the journal. Trust over convenience.
- **Making v2 the default now.** Deferred to Stage C completion: attachments gap is closed, but receipts + onboarding should land first so the first-run story is coherent.

## Trade-offs accepted

- **Serif "voice" for assistant prose** costs a slightly less "techy" first impression, buys readability and a distinct identity.
- **Read-only computer use** limits the "Pandesh controls my PC" story, buys trust and avoids an unsafe input layer.
- **No universal sandbox for rehearsal** — task-specific previews (pc_organizer, operator) instead. Honest about what's simulated vs tested.
- **Windows-only** limits market, buys a real native wedge (OpenClaw/Agent Zero lean Unix/WSL2).
- **Local models only by default** costs capability vs cloud, buys the privacy story and the "no silent fallback" guarantee.

## Smart Pandesh integration principle (added in review)

Verified Delegation is the execution and trust foundation, not the whole product. Smart Pandesh integrates existing engines (Hermes, OpenClaw, n8n, desktop operators, coding agents) through reliable governed interfaces; it does not duplicate them. One central memory, identity, permission authority and evidence ledger. Planned capabilities are documented as future contracts (see 08-future-contracts.md) and never shown as operational.

> "Give your AI agents real work, watch them do it, and see what actually got done — all from your own PC."

If a screen, a flow, or a feature doesn't make that sentence more credible and more visible, it doesn't belong in Stage C.