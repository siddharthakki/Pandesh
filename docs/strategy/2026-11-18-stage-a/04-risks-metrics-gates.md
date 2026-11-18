# Pandesh — technical risks, success metrics & stage gates

**Date:** 2026-11-18 · Stage A. Companion to the audit, competitive report and concept selection.

## Technical risks (ranked)

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| 1 | **Local-model plan-quality ceiling** (gemma4:12b plans needless steps, premature stops; build-app 2/3) | High | harness discipline (Mingbird: 0.017→0.821 across harnesses); measured routing by task family; consented escalation; receipts show evidence levels, never fake confidence |
| 2 | **Verification depth** — Reviewer asserts things it didn't check (unseen pictures) | High | three evidence levels (`a9bebb4`); receipts distinguish *observed / checked / reviewed*; Reviewer must cite tool output, not narrate |
| 3 | **DRV-010-class silent writes** under folder-wide cards | High | **Mitigated on branch `fix/drv-010-read-before-overwrite`** (read-before-overwrite + named-in-request exception; 3 new tests + 29 writeAuthorization green; typecheck clean). Pending owner review/merge before the file-organization demo. |
| 4 | **Two mission layers + legacy cockpit** → cognitive load, drift | Medium | keep both engines, unify the surface; no third layer; retire cockpit projection when Mission Control lands |
| 5 | **Giant files** (piAgentEngine 7,389 / executor 5,290 lines; 88 KB migrations.ts) | Medium | new work in separate modules (deliverableLedger precedent); take legacy `src/` out of vitest include |
| 6 | **Install friction** — unsigned installer + Ollama + GPU prerequisite | Medium | signing decision; documented non-developer path; guided first mission on isolated fixtures |
| 7 | **Classic still default + "More" popover (16 destinations)** | Medium | make v2 default at Stage C; second navigation pass (don't add a rail) |
| 8 | **Mail index not separately encrypted** | Medium | BitLocker guidance now; key-management decision for encryption (acknowledged in mail-hub.md) |
| 9 | **Tool offering by English regex** | Medium | intent-based selection; keep `request_tools` bounded; language-independent groups |
| 10 | **Free-cloud rate limits** (measured: ~20 coding tasks/week on Qwen free) | Low | local-first default; receipts show provider + cost; no silent fallback |
| 11 | **Windows-only market** | Low (accepted) | it's the wedge, not a bug |
| 12 | **Stale-record accumulation** (142 in_progress, 123 pending tools) | Low | retention + sweep job |

## Success metrics (the quality bar, measurable)

**Truth & reliability**
- **False-completion rate = 0** on the frozen mission set (M1 gate currently 31/33, 0 false). Target: ≥90% of mission steps evidence-backed; every "done" traceable to a tool call or artifact.
- **Resume integrity:** interrupted → resumed with **0 duplicate writes** (live-eval already shows this); restart status truthful 100%.
- **Repeated-click safety:** consequential ops never duplicated (idempotency keys + replay guard).

**Usability / first-run**
- New user reaches a **first verified mission in ≤15 min** on an isolated profile (guided first mission — currently absent).
- Approvals comprehensible without instruction; calm under heavy activity; failures give actionable recovery.

**Performance**
- UI responsive during missions (no event-loop blocking — the Build-183 overview-cache fix is the precedent); clear model-warmup states; predictable GPU use; no uncontrolled model competition.

**Privacy**
- Local-first default; private content local unless explicitly approved; approval names recipient + exposure; secrets outside Git/model-visible files; shareable receipts redacted.

**Adoption (opt-in, local, no hidden telemetry)**
- Funnel: install → first mission → repeat mission within 7 days; failure/recovery rates; diagnostics export user-controlled.
- Community: issues responded <48h; **no manufactured stars/testimonials**.

## Stage gates (independent, no giant rewrite)

| Stage | Deliverable | Gate to proceed |
|---|---|---|
| **A — Product truth** (this) | audit, competitor matrix, 3 concepts, recommendation, risks, metrics | owner accepts direction |
| **B — High-fidelity experience** | interaction spec, 10 screen mockups (light/dark), clickable prototype, motion guidelines | **owner design review before any large UI work** |
| **C — One vertical slice** | Mission Control + Proof of Work on file organization, incl. the failed scenario; reuse event ledger; v2 default | verified receipt on real task; DRV-010 fixed; tests |
| **D — Persistent work & autonomy** | Living Workspaces + Autonomy Contracts on Projects/missions/Bots/grants; backward compatible | continuity survives restart; contract enforced by Core |
| **E — Rehearsal & takeover** | task-specific previews (pcOrganizer/operator) + supported computer-use; isolated fixtures | preview ≠ claim of success; simulated vs tested labeled |
| **F — Reliability & validation** | adversarial scenarios (search failure, missing tools, hallucinated completion, stale connection, rejected approval, partial file op, interrupted mission, missing specialist, model restart, missing cloud, invalid follow-up, repeated request); ≥2 local models | real recovery or accurate failure states |
| **G — Launch** | README, demos, screenshots, getting-started, install path, release checklist, trailer, technical demo, launch copy, outreach plan, roadmap | first-run ≤15 min; honest limitations published |

## Immediate decisions needed from the owner

1. **Accept Concept A** (Verified Delegation) as the direction?
2. **Authorize fixing DRV-010** (silent overwrite) — it blocks the flagship file-organization demo and is currently on hold.
3. **Make v2 the default** at Stage C (attachments gap is closed)?
4. **Mail index encryption:** BitLocker guidance now, or invest in key management?
5. **Naming:** resolve the `hermesEngine` / Nous "Hermes Agent" collision before launch?
6. Proceed to **Stage B** (design proposals, no implementation) on approval?