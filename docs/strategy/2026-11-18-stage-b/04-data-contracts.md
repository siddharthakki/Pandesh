# Stage B — design system

**Direction:** Calm when idle. Alive when working. Precise when deciding. Restrained, professional, warm — closer to a beautifully made desktop instrument than a sci-fi dashboard or an admin template.

## 1. Color tokens

Dark is the default (Pandesh is used for hours; light is for daytime/bright rooms). All values are CSS custom properties on `:root` (dark) with a `data-theme="light"` override and `prefers-color-scheme` fallback.

| Token | Dark | Light | Use |
|---|---|---|---|
| `--canvas` | `#0E1013` | `#F4F2EE` | window background |
| `--surface` | `#15181D` | `#FFFFFF` | cards, panes |
| `--raised` | `#1C2027` | `#F0EEE9` | hover, selected row |
| `--ink` | `#E8E6E1` | `#1A1A1A` | primary text |
| `--muted` | `#9A9A94` | `#5A5A55` | secondary text |
| `--faint` | `#5C5C58` | `#8A8A85` | meta, timestamps |
| `--pulse` (accent) | `#3DD6C6` | `#0E9E90` | accent, links, focus, active mission |
| `--verified` | `#6AA8FF` | `#2B6CB0` | done/trusted/succeeded |
| `--attention` | `#F0B429` | `#B7791F` | unverified, needs you, pending |
| `--danger` | `#E5534B` | `#C53030` | failed, refused, destructive |
| `--border` | `#23272F` | `#E2DFD9` | hairlines |
| `--border-strong` | `#2E333C` | `#CFCBC4` | card edges |

**Rules:** accent is teal only. Blue is reserved for *verified/trusted* states (so "done" never competes with "accent"). Amber for "needs attention/unverified." Red only for failure/refusal. No purple, no gradients on surfaces. Color is never the only signal (icons + text accompany).

## 2. Typography

| Role | Family | Weight | Use |
|---|---|---|---|
| Body / UI | Segoe UI Variable, system-ui, sans-serif | 400/500/600 | everything functional |
| Voice (assistant prose) | Cambria, Georgia, serif | 400 | the assistant's written replies — distinctive, readable, human |
| Meta / technical | Cascadia Mono, Consolas, monospace | 400 | timestamps, paths, statuses, tool names, evidence, counts |

**Scale (rem, 16px base):** 0.6875 (meta) · 0.75 (small) · 0.875 (body-sm) · 1 (body) · 1.125 (h3) · 1.375 (h2) · 1.75 (h1) · 2.25 (display, idle hero only).

**Line heights:** 1.4 body, 1.25 headings, 1.35 meta. Max line length for prose: 68ch.

**Distinctive choice:** the serif "voice" for assistant prose. Most agent UIs are sans-everything or mono-everything; the serif gives Pandesh a literate, considered tone and visually separates "what the assistant said" from "what Core recorded."

## 3. Spacing, radius, elevation

- Base 4px. Scale: 4 · 6 · 8 · 12 · 16 · 20 · 24 · 32 · 48.
- Radius: 2 (chips) · 4 (inputs/buttons) · 6 (cards/panes) · 8 (modals). No 12+ rounded corners.
- Elevation: `--shadow-1` 0 1px 2px rgba(0,0,0,.25) (cards); `--shadow-2` 0 4px 12px rgba(0,0,0,.35) (popovers/modals); `--shadow-inset` for inputs. No glass/blur except the drop overlay.

## 4. Motion

Purposeful, never decorative. All durations respect `prefers-reduced-motion: reduce` (collapse to 0).

| Pattern | Duration | Easing | Use |
|---|---|---|---|
| Fade in | 120ms | ease-out | elements appearing |
| Slide in (pane) | 180ms | cubic-bezier(.2,.8,.2,1) | Mission Control pane, drawers |
| Timeline draw | 240ms staggered | ease-out | mission step rows appearing (60ms stagger, max 6) |
| Pulse (active) | 1.4s loop | ease-in-out | active mission dot, running indicator |
| Receipt stamp | 280ms | cubic-bezier(.34,1.56,.64,1) | the verified stamp lands on completion |
| Count tick | 120ms | ease-out | numbers updating (counts, progress) |

**Rules:** no spinning orbs, no particle effects, no auto-playing loops except the active pulse. Motion always conveys state change (running → done, pending → resolved). Time compression in demos is disclosed.

## 5. Iconography

Hand-drawn 16×16 single-path SVGs (existing `ui.tsx` set). Add: mission (flag), receipt (seal), rehearse (eye), evidence (paperclip), verified (check in circle), unverified (dashed circle), failed (x in circle), paused (two bars), running (pulse dot). No icon fonts, no emoji as icons.

## 6. Accessibility baseline

- `:focus-visible` outlines on every interactive element (2px `--pulse`, 2px offset).
- `role="alert"` for errors, `aria-live="polite"` for status, `aria-live="assertive"` for approval-required.
- Full keyboard: Tab order follows visual order; Ctrl+K palette; Esc closes panes/modals; Enter submits; Space toggles; arrow keys in lists.
- Reduced motion: all loops/pulses become static; transitions become instant.
- Color + icon + text for every status (never color alone).
- Minimum contrast: 4.5:1 body, 3:1 large/UI. Verified in both themes.
- Screen-reader labels on icon-only buttons (`aria-label` + visible tooltip).

## 7. Layout grid

- App shell: rail (56px) · main (flex) · optional contextual pane (360–420px, right) · optional activity aside (320px, right of pane).
- Main content max-width 880px for chat/prose; full-width for Mission Control/workspace grids.
- Compact (≤720px wide): rail collapses to bottom bar (first 3 destinations + More); contextual pane becomes a drawer (bottom sheet); activity aside folds into a tab.<|end|><|start|>write to=assistant<|channel|>analysis <|constrain|>xml<|message|><rfl:parameter name="content">
# Stage B — the ten core screen states

Each state: **purpose · layout · key elements · data sources · reuse · compact**. Status glyphs: ◉ verified · ◌ unverified · ✕ failed · ⏸ paused · ▶ running.

## 1. Idle desktop (home)

**Purpose:** calm landing. The user sees what needs them, what's running, what finished — then the composer. No dashboard clutter.

**Layout:** rail · main column (hero greeting + "N things need you" line + recent receipts strip + composer) · no contextual pane.

**Key elements:**
- Greeting (time-of-day + name), one line.
- Needs-you line: "3 things need you" (links to approvals) — single, not a banner stack.
- Active work strip: 1–3 mission cards (compact) if any running; else "Nothing running."
- Recent receipts strip (horizontal, 3 cards): last completed tasks with verified stamp, click to expand.
- Composer (central, large) with attachments, voice, model picker, permission mode, folder chip.
- Empty state: "calm panda welcome" (existing, preserved).

**Data:** `missions` (status=running/interrupted), pending approvals count, last 3 completed mission reports, conversation list.

**Reuse:** `Chat.tsx` composer, `Missions.tsx` MissionDock (compact variant), `ui.tsx` tokens.

**Compact:** composer full-width; strips become vertical; rail → bottom bar.

**Light/dark:** both. Hero uses `--ink` on `--canvas`; receipts use `--verified` stamp.

## 2. Mission running

**Purpose:** the user sees real work happening — which agent, what step, what tool, what count — and can intervene.

**Layout:** rail · main (chat transcript, dimmed slightly) · **contextual Mission Control pane (right, 400px)**.

**Key elements (Mission Control pane):**
- Mission headline + objective (serif, one line).
- Status dot (▶ running, pulse) + elapsed timer + "X of Y steps".
- Progress bar (real step count, no guessed %).
- Expandable step list: each row = agent avatar (initials, not orb) · step title · current tool ("PC Manager · Checking installed software · 12s") · verdict glyph (◌ if unverified yet).
- Inline approval blocks inside the pane (agent name, exact action, Allow/Don't allow).
- "Files on disk" artifact chips (open file / open folder).
- Controls: Pause · Stop · Take control · Expand activity · Inspect evidence.
- Privacy note: "Local only · no cloud."

**Data:** `mission` + `mission_steps` (status, agentId, kind, childAttemptId, evidenceJson, artifactsJson), runtime events for current tool, approvals linked to mission.

**Reuse:** `Missions.tsx` (MissionDock, StepRow), `Activity.tsx` (expand).

**Compact:** pane becomes a bottom sheet; step list collapses to current step + "expand."

## 3. Browser / computer observation

**Purpose:** watch the agent work in a real browser or on the real desktop — never simulated.

**Layout:** rail · main (chat) · work pane (right) showing either a **browser session frame** (real screenshot, refreshed on navigation) or a **desktop screen capture** (explicit, visible, governed).

**Key elements:**
- Pane header: "Browser · example.com" or "Screen · [window title]" with a "governed: read-only" badge.
- Live frame with a subtle "live" dot.
- Caption line: what the agent is doing ("Reading the listing…") + tool name.
- Controls: Take control · Return control · Stop · Expand.
- If desktop screen: explicit consent banner "Pandesh is viewing [window]. Stop anytime." No hidden surveillance.

**Data:** `browser_*` session state + screenshot; `computerUseCapability` screenshot + window list; governed research session.

**Reuse:** `browserSession.ts` outputs, `Activity.tsx` screenshot rendering.

**Compact:** frame stacks below chat; controls become a floating bar.

## 4. Multi-agent collaboration

**Purpose:** show a lead involving a specialist and a reviewer as concise, traceable parts of one outcome — not a noisy swarm.

**Layout:** rail · main (mission timeline) · evidence aside (right).

**Key elements:**
- A single mission timeline with **agent lanes** (lead / specialist / reviewer) as swim lanes, not separate cards.
- Each contribution tagged with agent initials + tool + evidence ref (e.g. "Researcher · web_research · [S3]").
- Reviewer's verdict shown as a distinct row: "Reviewer · re-ran tests · Ready" with its own evidence.
- "How this was decided" expandable: which specialist was chosen and why (routing evidence).
- Privacy boundary note: "Researcher results are public-source only; local findings stayed with the PC Manager."

**Data:** mission steps with agentId/kind, delegation evidence ledger (`buildLedger`), mission report.

**Reuse:** `Missions.tsx` StepRow (extended), `delegationEvidence.ts`.

**Compact:** lanes stack vertically; evidence refs become tappable chips.

## 5. Approval required

**Purpose:** a decision the user can make in 3 seconds — what, who, why, consequence, exact action.

**Layout:** rail · main (chat, composer disabled) · **approval card inline in chat** + optional evidence aside.

**Key elements:**
- Title: "Needs your OK · {agent} agent".
- `dl` rows: Action · Affects (paths/commands, mono) · Agent · Why.
- Detail block (mono, scrollable, max 8 lines) — the exact command/file.
- Consequence line: "If you allow: … If you don't: nothing changes."
- Buttons: Allow (primary) · Don't allow (secondary) · "Show full diff" (tertiary).
- Footer: "Nothing runs until you choose. Core records the decision."
- Special variants: image gen (prompt + model + size), weather (egress), mission envelope (folder + limits + "not covered").

**Data:** pending approvals (`listPendingApprovals`), approval summary (toolName, arguments, paths, cardText), frozen permission mode.

**Reuse:** `Chat.tsx` `section.approval`, `APPROVALS` map, `Missions.tsx` inline approval blocks.

**Compact:** approval becomes a bottom decision bar (Allow/Don't allow + expand).

## 6. Verified task completion (Outcome Receipt)

**Purpose:** the moment of trust. A beautiful, shareable, evidence-backed report of what actually got done.

**Layout:** rail · main (receipt card, centered, max 640px) · evidence aside (expandable).

**Key elements (the receipt):**
- Header: objective (serif) + **verified stamp** (animated land, `--verified`) + timestamp.
- "What happened" summary (Core-written, not model-narrated).
- **Operations performed** (list with counts): "3 files changed · 6 tests passed · 1 git commit".
- **Artifacts** (chips that open the real file: video ▶ · image ▣ · doc ≡ · code {}).
- **Verified outputs** (each with evidence level: observed / checked / reviewed).
- **Partial or failed steps** (honest, amber/red, never hidden).
- **Approvals used** (count + digest).
- **Model / provider** + duration + cost (tokens, minutes, "Ran on this PC · no money spent").
- **Next action** (one clear button).
- **Undo / recovery** where supported (pc_organize_undo, git revert).
- Footer: "Shareable: redacts paths, tokens, identifiers" + "Export receipt" button.

**Data:** mission report message, `mission_steps` evidenceJson/artifactsJson, tool_invocations (counts), model_invocations (tokens/latency), approvals, artifacts (registerArtifact).

**Reuse:** `Missions.tsx` result summary + artifact chips; `Activity.tsx` tool I/O.

**Compact:** receipt stacks; evidence aside becomes a sheet.

**Light/dark:** both. The stamp is the memorable moment.

## 7. Failed task and recovery

**Purpose:** honest failure. What was tried, what succeeded, what didn't, what to do next. Never a fake success.

**Layout:** same as receipt, but the stamp is red (✕) and the card is titled "Not finished".

**Key elements:**
- Header: objective + red stamp "Not finished" + reason (one line, e.g. "Approval not received").
- "What happened" (Core-written): steps that succeeded (with evidence), steps that failed (with reason), steps skipped.
- "What was NOT changed" (explicit list — builds trust).
- "Nothing was deleted" / "Zero files moved" (when true).
- Recovery actions: Retry safely · Continue from where it stopped · Adjust and re-run · Dismiss.
- "Why it failed" expandable: tool error, model, environment, permission.

**Data:** mission status `failed`/`completed_with_issues`, step statuses (failed/skipped/unverified), error fields, tool_invocations (failed ones).

**Reuse:** receipt layout, `Missions.tsx` "not verified" wording.

## 8. Personal workspace (PC)

**Purpose:** a living record of an ongoing objective — "where did we leave off?" answered with real state.

**Layout:** rail · main (workspace header + sections) · evidence aside (optional).

**Key elements (PC workspace):**
- Header: goal ("Keep my PC healthy") + last activity timestamp + "Where we left off" summary (Core-computed from last mission/report).
- Sections (cards): Hardware inventory · Disk utilization (with the storage bar) · Services & apps · Known problems · Performance trends · Recommendations.
- Each section: last-updated timestamp, "refresh" action, evidence ref.
- Open tasks / next action.
- Autonomy contract summary (allowed/not allowed) with "Review contract" link.
- Artifacts: last report, last scan.

**Data:** pc_organizer scan (scanRoots), software inventory (systemManagementCapability), missions/reports for this workspace, scheduled task scope, memory facts (user scope).

**Reuse:** `Workspaces.tsx` (needs redesign from RecordCard dumps), `Software.tsx`, `Automations.tsx`.

**Compact:** sections become an accordion.

## 9. Bot details

**Purpose:** a Bot is a named, read-only helper with a job, a schedule, a memory and a track record — understandable, not anthropomorphic.

**Layout:** rail (My Bots selected) · main (Bot card + recent results) · optional memory aside.

**Key elements:**
- Identity: name, role, one-line job, avatar (initials, not an orb).
- Allowed reads (list, plain language), schedule (next run, last run), runtime (local model only).
- Memory: what it remembers (count + recent facts, with source).
- Recent results: list of runs, each with counts Core computed ("3 new emails, 2 need reply"), evidence refs, "proposed actions (each needs your approval)".
- Status: running / idle / skipped (with reason: "GPU busy, waited 10 min").
- Controls: Run now · Pause · Edit schedule · Forget memory · Remove Bot.

**Data:** `bots` (botStore), `bot runs` (jsonl), `botSources` evidence (privateData, items, refs), scheduled_tasks (routine='bot_routine'), memory facts.

**Reuse:** `Bots.tsx`, `botsModel.ts`.

**Compact:** memory aside folds into a tab.

## 10. Compact / narrow window

**Purpose:** Pandesh stays usable at 720px and below — same product, denser.

**Layout:** bottom bar (Chat · Missions · Approvals · More) · main full-width · contextual pane becomes a bottom sheet (swipe up) · activity aside becomes a tab in the sheet.

**Key elements:**
- Bottom bar shows a badge on Missions/Approvals when items need attention.
- Composer stays accessible (sticky bottom).
- Mission Control sheet: current step + "expand" (full timeline).
- Approval sheet: full card in a sheet.
- Receipts: full-width, scrollable.

**Data:** same as above; no new data.

**Reuse:** `App.tsx` already has narrow-window bottom bar (rail → bottom bar). Extend with sheet pattern.<|end|><|start|>write to=assistant<|channel|>analysis <|constrain|>xml<|message|><rfl:parameter name="content">
# Stage B — flagship flows (success + failure/recovery)

Three flows, each shown as a successful path and a meaningful failure/recovery. All statuses map to real Core data (see 04-data-contracts.md).

---

## Flow 1 — Mission Control: "Find what's eating space on C: and help me clean it safely"

### Success path

1. **Idle → composer.** User types the request. Composer shows folder chip (C:\) and permission mode (Ask). Model: local 12B.
2. **Lead plans a mission.** `mission_start` offered (background work detected). Core checks every step like a hand-off. A **mission card appears above the composer** (MissionDock): "Find space hogs on C: · 0 of 3 steps · 0s".
3. **Step 1 — Inventory (Operations).** Card updates: "Operations · Scanning C: · 4s". Real tool: `pc_organize_scan` / system inventory. Counts appear as they're observed: "1,204 directories · 47.3 GB used".
4. **Step 2 — Analyze (Operations).** "Operations · Ranking largest · 9s". Top offenders listed with sizes (real measured values).
5. **Step 3 — Reviewer.** "Reviewer · Checking claims · 3s". Re-runs the scan independently; verdict "Ready" only if evidence backs the claim.
6. **Completion → Outcome Receipt** (see Flow 2). Card collapses to a receipt chip in chat.
7. **Intervention (shown in demo):** user clicks "Stop" mid-run → mission `interrupted`, card shows "Stopped. Nothing after this step ran." → "Continue" resumes from the journal.

### Failure / recovery path (shown, not hidden)

- **Rejected approval:** user clicks "Don't allow" on the envelope → step marked `failed` (reason: "approval declined"), later steps `skipped`, mission `failed`, card shows "Not finished · file changes declined · nothing was changed." Recovery: "Retry with a different scope" / "Dismiss."
- **Missing tool:** if a specialist lacks a tool, the step is `unverified` (not `succeeded`), mission ends `completed_with_issues`, receipt shows "1 step not verified — no tool call backs its report."
- **Interrupted by restart:** mission `interrupted`, card expired, next message accepted, "Continue" available. Never auto-replayed. Truthful status in the Board.
- **Reviewer partly done:** if the Reviewer didn't read the test file, Core marks its reply `partly done` and the mission stops as `failed` — honestly. (This is the recorded, real behavior; the demo shows it, not a polished fiction.)

### What makes it memorable

The card shows **counts and milestones, never a guessed percentage**: "327 files observed · 21 duplicate sets · 196 proposed moves · waiting for approval." The user always knows what's real.

---

## Flow 2 — Outcome Receipt: "Your project was updated"

### Success path (the receipt)

Appears in chat on completion. Centered card, max 640px, verified stamp lands (280ms, spring easing).

```
┌─────────────────────────────────────────────┐
│  ◉ Verified · 2026-11-18 14:32              │
│                                             │
│  Tip calculator built and tested            │  (serif)
│                                             │
│  What happened                              │
│  The Coding specialist added formatEuro()    │
│  with a unit test and ran the suite.        │
│                                             │
│  Operations performed                        │
│  · 2 files changed    · 5 tests passed      │
│  · 1 git commit       · build verified      │
│                                             │
│  Artifacts  [ {} tip.py ] [ {} test_tip.py] │
│                                             │
│  Verified outputs (evidence level)           │
│  · tests pass · checked (Core re-ran)       │
│  · program prints 32.39 · observed          │
│                                             │
│  Approvals used: 2 · Model: gemma4:12b       │
│  Duration: 47s · Ran on this PC, no cost    │
│                                             │
│  Next: run it for €84.50 / 15% / 3 people  │
│  [ Review diff ]  [ Undo ]  [ Share ]       │
└─────────────────────────────────────────────┘
```

- **Share** exports a redacted receipt (paths → relative, no tokens/identifiers, no machine names).
- **Undo** only where supported (git revert, pc_organize_undo, mission cancel).

### Partial / failed receipt

Same card, red stamp ✕, title "Not finished".

```
┌─────────────────────────────────────────────┐
│  ✕ Not finished · approval not received     │
│                                             │
│  Organize my Downloads                      │
│                                             │
│  What happened                              │
│  · Inventory complete — 327 files observed   │
│  · Duplicates verified — 21 matching sets    │
│  · Plan created — 196 proposed moves        │
│  · Approval not received — nothing moved    │
│                                             │
│  What was NOT changed                       │
│  · 0 files moved · 0 files deleted          │
│  · Nothing renamed · no space freed         │
│                                             │
│  [ Retry safely ]  [ Adjust plan ]  [ Dismiss]│
└─────────────────────────────────────────────┘
```

The "what was NOT changed" list is the trust-building element. It is Core-computed from the ledger, not model-narrated.

### Evidence levels (from `a9bebb4`)

Every "verified output" carries one of three levels, shown as a small chip:
- **observed** — Core saw the tool output.
- **checked** — Core re-ran / re-statted it.
- **reviewed** — an independent Reviewer judged it.

A sample is never reported as a verification. A technical check is not a content review.

---

## Flow 3 — Rehearse Before Acting: "Preview the file move before I approve"

### Success path

1. User: "Organize my Downloads — show me the plan first."
2. Core runs `pc_organize_scan` + `pc_organize_plan` (read-only). **No approval yet.**
3. **Rehearsal pane** opens (right side, 400px):
   - Header: "Preview · 196 proposed moves · 0 changed yet".
   - **Move map** (table): source → destination, with conflict flags (⚠ same name exists) and size.
   - **Space implications:** "Frees 4.2 GB (duplicates) · 0 bytes moved yet".
   - **Simulated vs tested** banner: "Simulated: the move map and conflicts. Tested against real target: file existence, sizes, free space. Not tested: antivirus/permission errors during the real move."
   - Tabs: Moves · Duplicates · Conflicts · Undo plan.
4. User inspects, then clicks **"Authorize the real run"** → the normal approval card appears (envelope), with the plan digest.
5. On approval, `pc_organize_apply` runs with per-move verification + SHA-256; receipt shows "196 of 196 verified, 0 failed. Undo available."

### Failure / recovery path

- **Conflict detected in preview:** a destination already exists → shown as a conflict row, not silently overwritten. User resolves (skip / rename / merge) before authorizing.
- **Apply partial failure:** "194 of 196 moved · 2 failed (file locked). Nothing deleted. Retry the 2, or undo all." — per-move verification catches it; nothing is reported as done that wasn't.
- **Rehearsal ≠ success:** the banner is honest about what was simulated vs tested. A rehearsal that passes does not claim the real run will succeed.

### What makes it memorable

The user sees the **exact** before/after of every consequential action before authorizing — and the system says plainly which parts were simulated. No other agent product does this for file moves; most just ask "allow file changes?" and hope.<|end|><|start|>write to=assistant<|channel|>analysis <|constrain|>xml<|message|><rfl:parameter name="content">
# Stage B — Core data contracts per screen

**Rule:** every visible status maps to a real Core datum or is explicitly flagged as prototype-only. No invented backend capabilities.

## Screen → required Core data

| # | Screen | Required Core data (existing) | Missing / new needed |
|---|---|---|---|
| 1 | Idle desktop | conversations (recent), pending approvals count, missions (running/interrupted), last 3 completed mission reports, memory facts (user scope) | **None new** — all exist |
| 2 | Mission running | `missions` + `mission_steps` (status, agentId, kind, evidenceJson, artifactsJson), runtime events (current tool), linked approvals, mission report message | **None new** |
| 3 | Browser/computer obs. | `browser_*` session state + screenshots; `computerUseCapability` (screenshot, window list); governed research session | Desktop-control input is **absent by design** (read-only) — no invention |
| 4 | Multi-agent collab. | mission steps with agentId/kind, `delegationEvidence` ledger, mission report | **None new** |
| 5 | Approval required | `listPendingApprovals`, approval summary (toolName, args, paths, cardText), frozen permission mode, mission envelope (limits, digest) | **None new** |
| 6 | Verified completion (receipt) | mission report message, `mission_steps` evidence/artifacts, `tool_invocations` (counts), `model_invocations` (tokens/latency), approvals, `registerArtifact` | **Outcome Receipt aggregation** is new — currently distributed (report msg + activity + artifacts). Needs a receipt builder + (optional) `receipts` table or a view over missions. Flagged as new work for Stage C. |
| 7 | Failed task + recovery | mission status (failed/completed_with_issues), step statuses (failed/skipped/unverified), error fields, failed tool_invocations | **None new** |
| 8 | Personal workspace (PC) | pc_organizer scan (scanRoots), software inventory (systemManagementCapability), missions/reports for workspace, scheduled task scope, memory facts | **Workspace model** is thin — `Workspaces.tsx` dumps RecordCards. Needs a structured workspace record (goal, sections, last-activity, next action, contract summary). Flagged as new work for Stage D. |
| 9 | Bot details | `bots` (botStore), bot runs (jsonl), `botSources` evidence, scheduled_tasks (routine='bot_routine'), memory facts | **None new** (Bot memory API could be richer — optional) |
| 10 | Compact/narrow | Same as above | **None new** |

## Flagship flows → Core data

- **Mission Control:** mission + steps + runtime events + approvals + artifacts + delegation evidence. All exist.
- **Outcome Receipt:** needs the receipt aggregation above (new, Stage C).
- **Rehearse:** `pc_organize_scan` + `pc_organize_plan` + `renderPlanPreview` (read-only, exist) + `pc_organize_apply` (exists) + `operator.ts` propose→verify→ask→move→rollback (exists). **Missing: a unified Preview surface in the UI** — today previews are text in chat. New work: a Rehearsal pane component. Flagged for Stage E.

## Missing capabilities (honestly listed — not invented)

1. **Outcome Receipt aggregation** (receipt builder + export). Distributed today; needs consolidation.
2. **Structured Living Workspace record** (goal, sections, last-activity, next action, contract). Projects are thin RecordCards.
3. **Autonomy Contract** as a first-class object (today: Auto grants + scopes + mission_authorizations are the substrate; no contract UI).
4. **Rehearsal / Preview UI surface** (today: text previews in chat).
5. **Human takeover** (input control) — absent by choice; only read-only screen capture exists.
6. **Proactive trigger engine** (today: briefing + bots report; no dedup/trigger registry).
7. **Measured model routing** (today: static chains; `bench/` exists but isn't wired to routing).
8. **Failure-classification loop** (Part 4) — evidence exists; taxonomy + repair suggestions unbuilt.
9. **Onboarding / guided first mission** — absent.
10. **Mail index encryption** — acknowledged gap (BitLocker guidance now).

## What exists and must be reused (not rebuilt)

- Event ledger: `runtime_events`, `tool_invocations`, `model_invocations`, `approvals`, `artifacts`.
- Mission system: `missions`, `mission_steps`, `mission_authorizations`, `mission_authorized_actions`.
- Bots: `bots` store + runs jsonl + `botSources`.
- pc_organizer: scan/plan/apply/undo + preview rendering.
- Operator: propose→verify→ask→move→rollback + undo manifest.
- Memory: facts with provenance, correction, forget.
- Tasks/projects: due/priority/blocker/history.
- Voice, phone, cloud listing cache, Workshop.

## Prototype-only flags

The clickable prototype (06-prototype) uses **realistic seeded data** drawn from the audit (counts, filenames, tool names) and is labeled "prototype data" in the UI. It does not call Core. Any status shown that is not yet backed by a Core datum is marked with a small "prototype" chip in the prototype itself. No backend capability is claimed that doesn't exist.