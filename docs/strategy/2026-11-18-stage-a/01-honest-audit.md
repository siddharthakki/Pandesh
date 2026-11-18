# Pandesh — honest current-state audit

**Date:** 2026-11-18 · **Audited:** `origin/main` `308d1be` (Build 186, Mail Hub) + working tree `476a10c` (Build 185 era) + production `E:\Pandesh` Build 186 (built today 08:51 UTC).
**Method:** read the code paths production runs; read the existing audits and acceptance evidence; verified git history for each claimed fix. Nothing was modified.

## The one-paragraph truth

Pandesh is a **well-governed, local-first, tool-using personal assistant with a genuinely strong permission and evidence layer** — and, since 2026-11-12, a real durable mission layer. It is **not yet an autonomous operator**, and it is **not yet a finished product**: the machinery for verified outcomes exists, but the *experience* of verified outcomes (Mission Control, Outcome Receipts, rehearsal, workspaces, contracts, onboarding) is mostly unbuilt. The 2026-11-12 audit's five blockers are largely closed in code. What remains is product surface, verification depth, a handful of on-hold defects, and maintainability debt.

## What changed since the 2026-11-12 audit (Build 167 → 186)

212+ commits, +17,873 lines across core/desktop. The audit's blockers:

| 11-12 blocker | Status now | Evidence |
|---|---|---|
| G1/G2 false "done" (tool-kind verification) | **Fixed** | `deliverableLedger.ts` (closes S21); claim guards get the real succeeded-tool ledger; M1 gate 31/33, 0 false completions |
| G3 no resume after restart | **Largely fixed** | journal-based `resumeAttempt.ts` + `replayGuard.ts`; truthful `interrupted` status; user-triggered, never auto-replayed |
| G4 scope-less routines | **Fixed** | `scheduled_tasks.scopeJson` frozen at creation; failure notifications; M3 gate 7 consecutive days + real Windows toast |
| Missions test-only | **Fixed** | two production layers: in-attempt `missionLoop` (wired `executor.ts:780`) + durable background `missionRunner` (migration 53) |
| G9 no v2 attachments | **Fixed** | PR #97: pick / drag-drop / paste, host-staged |

## Documented-failure verdicts (the mandate's list)

| Failure | Verdict | Evidence |
|---|---|---|
| Web search returns blocked-provider pages | **Fixed** | `a97c71e`; `researchRunner.ts` identifies as `Pandesh/0.1`; `isSearchChallenge` → `research_provider_blocked`, never "no results"; `searchProviderBlocked.test.ts` (6 tests) |
| File-organization plans not executing | **Partially fixed** | `pc_organize_scan/plan/apply/undo` exists with approval→verify→undo; F03 false-completion fixed (`bebe959`); DRV-010 silent overwrite **fixed on branch `fix/drv-010-read-before-overwrite`** (pending merge); custom-layout gap remains; no `create_folder`/`rename`/`move` chat tool |
| Missions wrong workspace/tools | **Partially fixed** | frozen scope (`missionRunner.ts:5`), fixed tool envelope (`missionActions.ts`), workspace passed (`piAgentEngine.ts:4754`); routing fixes `b4bffe1`/`215baae`/`481d41f`; original complaint not re-run live |
| Progress claimed without execution | **Fixed** | `actionClaims.ts` + `completionGate.ts` + 40+ tests; delegation evidence ledger; three evidence levels (`a9bebb4`); `unbackedWorkingClaim` |
| Outlook reconnect after restart | **Fixed (Build 186)** | PR #127 Mail Hub: `outlookConnector.ts` STA worker; `769202e` forgets stale connection, re-attaches once. (Build-185 tree had no Outlook at all.) |
| Cloud model discovery disappearing | **Fixed** | `c746b5f`; `cloudListingCache.ts` persists verified lists, 24h re-check; 4 tests |
| Confusing navigation / tool availability | **Improved, not solved** | seven-place sidebar + ToolsHub explorer + bounded `request_tools` (4/turn); **but** tool offering is still ~22 English regex groups, and the "More" popover now hides 16 destinations |
| False "NOT DONE" (file already current) | **Fixed** | `a65eb9a`/`c424572`/`fedf868`; `turnOutcomeTextClassification.test.ts` |
| `run_checks` relative-path bug | **Fixed** | `piAgentEngine.ts:3820` resolves against selected folder (G10: 51/138 historical failures) |
| SAL-015 revenue conversion regression | **Still broken** | not bisected; `VERIFY-b164.json` FAIL; on main since Build 164 |
| missionRepair flaky test | **Quarantined, not fixed** | removed from CI timing-sensitive; test unchanged |

## Capability inventory

Statuses: **WR** works reliably · **WL** works with limitations · **IU** implemented but unverified · **BR** broken · **PO** planned only.

### Core execution & trust
| Capability | Status | Notes |
|---|---|---|
| Local chat (Ask mode) | WL | short tasks pass; build-app 2/3 with gemma4:12b |
| Specialist delegation + scope | WR | code-enforced, narrows-only; plan quality varies |
| Permission modes Ask/Auto/Plan Only | WR | fail-closed; Auto grants ≤24h, revocable |
| Approval cards | WR | digests, exact action, fail-closed; orphan-sweep fixed |
| Claim guards + deliverable ledger | WL | M1 gate 0 false completions; full 700-set not re-run post-fix |
| Cancellation | WR | 295 ms, no late writes |
| Restart recovery / resume | WL | truthful `interrupted`; journal resume, user-triggered |
| Mutation ledger / replay guard | WR | live-eval duplicateWrites=0 |
| Validation freshness | WR | full tier re-runs after repair; failing ≠ success |
| Process-tree termination | WR | real Windows platform tests |
| Event ledger / observability | WR | 16k events; stale-record sweeps still missing |

### Missions & autonomy
| Capability | Status | Notes |
|---|---|---|
| Background missions (start/stop/continue) | WL | real recordings; lead quality varies; parallel steps unit-tested only |
| Independent Reviewer | WL | re-runs tests itself; judgment depth limited (asserted unseen pictures) |
| In-attempt autonomous loop | IU | production-wired but gated by AUTONOMOUS_MISSION_PROFILE |
| Mission cockpit (host projection) | IU | Classic-era; v2 uses MissionDock |
| Scheduler firing | WR | on time; 7-day gate |
| Routine scope + failure notice | WR | M3 landed & gated |
| Bots (read-only Hermes profiles) | WL | landed PR #126; counts-first reports; needs Hermes + 64K model |
| Watchdog | PO | prepared, not enabled (owner decision) |
| AI Radar | WL | read-only reports; nothing installs itself |

### Tools & integrations
| Capability | Status | Notes |
|---|---|---|
| Web research (consented, sanitized) | WR | identifies self; blocked detection; citations verified |
| Managed browser | WL | acceptance-verified; open-URL routing gap |
| Computer use | WL | **read-only** screenshot/window list + vision routing; no input (by choice) |
| File organization (pc_organize_*) | WL | approval→apply→verify→undo; custom-layout gap; DRV-010 fixed on branch (pending merge) |
| Gmail / Calendar | WL | deep; plan-apply fixed #66; resumable organize tasks |
| Outlook Mail Hub | WL | Build 186, read-only Phase 1; **index not separately encrypted** (acknowledged) |
| Documents (PDF/Word/OCR/export) | WR | 3/3 extraction; PDF verified on disk |
| Image generation (ComfyUI) | WL | no self-check; wrong failure cause when down; quality varies |
| Image understanding | WL | Core vision routing + v2 attachments landed |
| Studio narrated video | WL | real 1080p output; sampled frame checks; no publish |
| Workshop 3D/sim/design | WL | 42/46 own tests; real-ComfyUI acceptance pending; slideshow video |
| Voice (Whisper/Piper) | WL | English works; German mangled; wake word "Hey Jarvis" |
| Second Brain / memory | WL | provenance/correct/forget verified; lexical retrieval; **auto-capture missing** |
| Tasks / projects | WL | due/priority/blocker; atomic create + task-edit gaps |
| Reminders | WL | weekly/monthly missing; host-shortcut interference |
| Phone (PWA + Tailscale) | WR | owner-confirmed; no mission cards on phone |
| Cloud models (free registry) | WL | persisted + consent; rate limits measured; data boundary #78 |
| Revenue team | WL | drafts-only, evidence-required; SAL-015 regression |
| Wish to Reality | IU | feature-frozen by owner |
| Morning briefing | WL | duplicate 08:00 slot pending owner decision |

### Product surface (the gap)
| Capability | Status | Notes |
|---|---|---|
| Mission Control surface | PO | MissionDock + Board + Activity are the pieces; no dedicated cockpit |
| Outcome Receipt component | PO | evidence is distributed (files + timeline + chips); no designed receipt |
| Rehearsal / preview UI | IU | `pc_organize_plan` preview + operator propose exist; no unified Preview |
| Autonomy Contracts | PO | substrate exists: Auto grants + scopes + mission_authorizations |
| Living Workspaces | PO | Projects = generic RecordCard JSON dumps |
| Onboarding / guided first mission | PO | only a welcome empty state; **Classic UI still default** |
| Failure-classification loop (Part 4) | PO | evidence exists; taxonomy + repair suggestions unbuilt |
| Measured model routing | PO | static chains; `bench/` exists, not wired to routing |
| Proactive intelligence / ambient overlay | PO | Ctrl-K palette in-app; no OS overlay, no trigger-dedup engine |
| Human takeover | PO | no input control exists |

### Broken / on-hold (owner said "Not now" 2026-11-12)
SAL-015 · DEV-018 weather fallback · GML-011 · NAV-013 · RES-025 · REM-009 · start-at-login Run entry (item 2a, fix `f8ad9d5` unmerged, only copy in a worktree) · WIN-022 stale WMI startup list · `WindowsConfinementLauncher.cs` missing from repo.

## Architectural critique

**Keep (the moat):** Core's single permission chokepoint, fail-closed approvals, the evidence/tool ledger, deliverable ledger + claim guards, mutation ledger + replay guard, frozen-scope routines, read-only Bots, the mission runner's Core-written report. These are genuinely ahead of the market and are the product's reason to exist.

**Fix:** DRV-010-class silent writes (must precede any file-organization demo); tool offering (regex groups → intent-based selection); stale-record sweeps; Reviewer judgment depth (evidence levels, not assertions); Mail index encryption decision; SAL-015 bisect.

**Merge / consolidate:** two mission layers + legacy cockpit → one mental model (keep both engines, unify the surface); Classic + v2 → make v2 default once receipts land (attachments gap is closed); the "More" popover (16 destinations) needs a second navigation pass, not a third rail.

**Hide / freeze:** Wish to Reality (already frozen), Revenue (keep drafts-only), phase-3 Team templates (stop rendering wireframe agents).

**Discontinue / don't build:** a new agent engine, a second scheduler, a universal sandbox, a 3D office, swarm-by-default, autonomous cloud fallback. None add dependable user benefit.

**Maintainability debt:** `piAgentEngine.ts` 7,389 lines, `executor.ts` 5,290 lines, single 88 KB `migrations.ts`, legacy 185k-line `src/` still in vitest include. New work must go in separate modules (the `deliverableLedger.ts` precedent), not into the giants.