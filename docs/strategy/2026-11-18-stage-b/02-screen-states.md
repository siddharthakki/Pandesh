# Stage B — the ten core screen states

Each state: **purpose · layout · key elements · data sources · reuse · compact**. Status glyphs: ◉ verified · ◌ unverified · ✕ failed · ⏸ paused · ▶ running.

## 1. Idle desktop (home)

**Purpose:** calm landing. The user sees what needs them, what's running, what finished — then the composer. No dashboard clutter.

**Layout:** rail · main column (hero greeting + "N things need you" line + recent receipts strip + composer) · no contextual pane.

**Key elements:**
- Greeting (time-of-day + name), one line.
- **Proactive attention line (new):** a single, calm line — "3 things need you" — linking to approvals/commitments. Never a banner stack. If more than 5, collapses to "5+ things need you" with a "review all" link. Proactive items are deduplicated and ranked by urgency; no invented urgency.
- **Ongoing goals strip (new):** up to 3 active goal cards (Living Workspaces) showing goal name + "where we left off" one-liner + last activity. Collapses to a single "N ongoing goals" link if space is tight. Never auto-expands.
- **Commitments strip (new):** reminders and follow-ups due today, compact, dismissible.
- Active work strip: 1–3 mission cards (compact) if any running; else "Nothing running."
- Recent receipts strip (horizontal, 3 cards): last completed tasks with verified stamp, click to expand.
- Composer (central, large) with attachments, voice, model picker, permission mode, folder chip.
- Empty state: "calm panda welcome" (existing, preserved).

**Clutter guard:** idle home shows at most one line of proactive attention, up to 3 goal cards, up to 3 commitment items, and up to 3 recent receipts. Anything beyond collapses into a "More" link. No auto-playing, no stacked banners, no modal popups on open. Proactive items are ranked, deduplicated, and dismissible; dismissed items don't reappear for 24h.

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

**Reuse:** `App.tsx` already has narrow-window bottom bar (rail → bottom bar). Extend with sheet pattern.