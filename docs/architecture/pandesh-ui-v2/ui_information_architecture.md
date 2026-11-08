# UI information architecture — calm by default, depth on demand

## 1. Principles (incorporating the "too crowded" correction)

1. **The default screen is one conversation.** Compact rail, centred chat, nothing else. No dashboard, no agent wall, no graph, no terminal until a task needs it or the user asks.
2. **Context appears because of intent and leaves when it ends.** The workspace pane opens when a turn produces something viewable (a running task, an artifact, an approval) and collapses when dismissed.
3. **Configuration is separate from use.** Tools & Skills, Settings and Diagnostics live behind one "System" entry, never in the main rail.
4. **Every pixel of state comes from Core records.** No optimistic UI; pending is shown as pending.
5. **Visual foundation**: reuse the October 2026 Jarvis design system already prepared for Pandesh (`jarvis-design-system.zip`): one accent (`pulse`), `attention` only when the user is needed, `verified` only with evidence and a time, three type voices (voice/interface/evidence-mono), dark + light + high-contrast. It is Pandesh's own work, not a copy of the AI Workshop look (no starfield, no butler persona, no hologram styling).

## 2. Navigation

13 destinations, grouped into **3 visible rail items + 2 menus**:

```
┌────┐
│ ◉  │  Pandesh (Home + Chats)          ← default
│ ▦  │  Board                           ← badge = needs-you count only
│ ◎  │  Team (Agent Team)
│ ─  │
│ ⌘  │  Spaces ▸  Second Brain · Projects · Wish to Reality · Social Studio · Media Studio
│    │
│ ⚙  │  System ▸  Tools & Skills · Automations · Settings · Diagnostics
└────┘
```

- **Spaces** is a popover listing the five workspaces with one line of live status each ("Social Studio · 3 drafts await you"). The user can pin up to 2 spaces to the rail.
- **Ctrl+K** command palette reaches every destination, agent, conversation and action.
- **Home vs. Chats**: Home is the conversation screen with an empty-state brief; past chats are a left drawer (toggle) inside the same destination, not another page.
- Mobile/narrow width (< 900 px): rail becomes a bottom bar with the same 3 items + "More".

## 3. Main conversation workspace (three panes, two hidden by default)

```
Default (idle)                         Working (a task is running)
┌──┬───────────────────────────┐       ┌──┬──────────────────┬────────────────────┐
│  │                           │       │  │ conversation     │ ▸ Activity  │ Preview│
│ r│   Good morning.           │       │ r│                  │ ─────────────────── │
│ a│   2 things need you · ▸   │       │ a│ you: build the…  │ Coding · running    │
│ i│                           │       │ i│ Pandesh: On it — │ ✓ created project   │
│ l│                           │       │ l│ Coding is…       │ ● npm test (12s)    │
│  │  ┌─────────────────────┐  │       │  │                  │   [terminal tail]   │
│  │  │ Ask Pandesh…   🎤 ⏎ │  │       │  │ ┌──────────────┐ │ ○ open preview      │
│  │  └─────────────────────┘  │       │  │ │ Ask…         │ │ [Show my work ▾]    │
└──┴───────────────────────────┘       └──┴─┴──────────────┴─┴─────────────────────┘
```

- **Pane 1 – Conversation**: always usable; sending while tasks run starts a new turn (existing interactive lane preempts background work).
- **Pane 2 – Activity** (live task/activity): the turn's checklist and step timeline from `runtime_events`; collapsible to a one-line status chip in the composer ("Coding · step 4 · npm test").
- **Pane 3 – Preview** (contextual artifact/tool view): one tool view at a time with tabs only when there are several (terminal, browser, diff, PDF, image, timer…). See `visual_execution_design.md` for each view contract.
- Panes 2–3 are one resizable aside (the existing `workspace-context` + `workspace-resizer`) that can split vertically; widths persist per user (localStorage, convenience only).
- Opening rules: opens automatically **once per task** when the first viewable thing appears; if the user closes it, it stays closed for that task and a chip shows "Workspace (3)".
- Approvals render **inline in the conversation** and mirrored in Activity; never a modal.

## 4. Destination specifications

### 4.1 Board (on demand)

Columns (derived, see multi-agent §5): **Backlog → Ready → Running → Needs approval → Blocked → Verified → Completed**. Backlog/Ready come from stories + command-queue items + Wish deliverables; the rest from attempts/approvals/outcomes.

Card: title (outcome-phrased), agent avatar + name, project chip, real progress only (`3 of 5 checks`, never %), dependency count, latest evidence line in mono, approval button if pending, error with cause + next action. Filters: agent, project, priority, status, "needs me". Views: Board / List / Calendar (same records). Drag only between Backlog↔Ready (user-owned states); runtime states cannot be dragged (they reflect reality).

### 4.2 Agent Team (on demand)

- **Directory**: a quiet list (not cards wall): avatar glyph, name, one-line role, state in words (Idle / Working on "…" / Needs you / Failed), last outcome + time. Needs-you first.
- **Agent detail** (tabs): Overview (responsibility, current run, recent outcomes) · Activity (runs from records) · Tasks (filtered Board) · Capabilities (tools/skills/MCP with risk class and executor) · Memory (scopes and access; link into Second Brain filtered by scope) · Model & limits · Performance (runs, verified rate, median duration, tokens/cost, approvals asked/declined) · Settings (edit definition → bumps version; capability test before enable).
- **Talk to an agent**: "Message Coding" opens a conversation whose requests carry `agentId`; header shows the agent; Pandesh can still be summoned with "@pandesh". "Ask Pandesh to coordinate" from a multi-select of agents creates a chief-of-staff turn with explicit handoffs shown in Activity.

### 4.3 Tools & Skills Hub (System)

Sections: **Installed tools** (governed capability catalog with risk class, chat-exposed or not) · **MCP servers** (Core-side registry, Phase 2b) · **Skills** (built-in host hooks, Hermes, SKILL.md imports — each reviewed) · **Tool mapping** (matrix: agent × capability → executor (native, OpenCode, Hermes, Pi, bridge, MCP) → permission boundary (always-ask/auto/denied) → network reach) · **PC & app discovery** (existing capability inventory) · **Connector status** (Gmail/Calendar/GitHub/JUGAAD/…: connected / not configured / error, with last probe) · **Capability testing** (run preflight per tool/agent, show pass/fail/warn with evidence; history of runs).

### 4.4 Spaces

| Space | Content | Built on |
|---|---|---|
| **Second Brain** | Search-first; inspector; timeline; 2D graph; 3D opt-in | `second_brain_design.md` |
| **Projects** | Project list → project page: tasks (Board filter), agents involved, files (workspace roots), conversations, artifacts, decisions | `projects`, `repositories`, `artifacts`, `requests.projectId` |
| **Wish to Reality** | Idea → offer → deliverables → orders → ledger, as a pipeline with verified/unverified badges (demo claims marked) | `wish_*` (existing, feature-frozen until owner approves) |
| **Social Studio** | Drafts desk (approve / redo with note / reject with reason), calendar, brand voice file, media previews, connected accounts (none by default), analytics (only when a connector provides real data) | new drafts store + artifacts; connectors Phase 3 |
| **Media Studio** | Generate image/video/audio with local engines (ComfyUI, local TTS), queue with arbiter status, gallery of artifacts with prompt + model + seed provenance | `comfyui_*`, media production, artifacts |

### 4.5 Automations (System)

Routines, scheduled tasks, watches, reminders in one list; each with schedule, owning agent, last run (result + evidence), next run, enable toggle, and a **trace** of the last run. New automations start in **shadow mode** when they can interrupt or contact anyone (logged, not spoken/sent) until the user promotes them.

### 4.6 Settings vs Diagnostics

Settings: models & providers, voice, privacy & sensitivity, permission defaults, appearance, companion devices, data location/backup. Diagnostics: Core health, model server reachability, resource arbiter state, recent failures with cause, security events, "local-only proof" drill, export a redacted bug report.

## 5. High-fidelity mockup specification (for the review round)

| Token | Dark | Light |
|---|---|---|
| canvas | #0E1013 | #F7F7F5 |
| surface / raised | #15181C / #1B1F24 | #FFFFFF / #F0F0EC |
| ink / muted / faint | #E8EAED / #A5ABB3 / #6B727B | #16181B / #50565E / #8A9097 |
| pulse (single accent) | #3DD6C6 | #0E9E90 |
| attention | #F0B44C | #B9770E |
| verified | #6AA8FF | #2F6FD6 |
| danger | #F06A6A (always with a word) | #C23B3B |

Type: interface Geist 13/14/16/20; assistant voice Newsreader 17 light (one line max on idle); evidence Geist Mono 12. Spacing 4-pt scale; rail 56 px; conversation max width 720 px; aside default 420 px, min 320, max 60 %. Motion: 120–180 ms ease-out for pane open/close; no idle animation except the presence dot; `prefers-reduced-motion` respected. Accessibility: 2 px focus ring, all states readable without colour, keyboard paths for approve/reject/cancel, screen-reader live region for task state changes (polite) and approvals (assertive).

## 6. Implementation note (for review)

The current renderer is 10.7K lines of vanilla JS. Recommendation: build v2 surfaces as **React components inside the existing Electron renderer**, mounted per surface behind a feature flag, reusing `desktopSession` IPC and sharing components with `src/webview-v2` (ApprovalCard, ActivityTimeline, TaskCard). Migrate surface by surface (Board → Team → Spaces → Conversation last); no big-bang rewrite. Decision requested in `handoff.md`.
