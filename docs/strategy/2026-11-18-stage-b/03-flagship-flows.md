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

The user sees the **exact** before/after of every consequential action before authorizing — and the system says plainly which parts were simulated. No other agent product does this for file moves; most just ask "allow file changes?" and hope.