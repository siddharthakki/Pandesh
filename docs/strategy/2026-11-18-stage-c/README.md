# Stage C — revised plan: Mission Control + Outcome Receipt on real file organization

**Status:** planning only. No implementation, no production changes, no installer. Depends on: Stage B design review accepted, DRV-010 PR #130 merged (or its guard reviewed and approved).

## Goal

One complete vertical slice: from a user instruction ("find what's consuming space on C: and help me clean it safely") to a **verified Outcome Receipt**, using real file-organization capabilities, with live Mission Control, pause/stop/recovery, and honest failure reporting. Reuse the existing event ledger, permissions and file-organization capabilities. Do not rebuild.

## Scope (in)

- Mission Control contextual pane (live timeline, counts, agent ownership, controls) per 02-screen-states §2 and 03-flagship-flows Flow 1.
- Outcome Receipt component (verified stamp, ops, artifacts, evidence levels, partial/failed, approvals, model/provider/duration/cost, next action, undo) per 03-flow §2.
- Rehearsal preview for file organization (pc_organize_scan + plan + preview pane) per 03-flow §3.
- DRV-010-class guard (PR #130) merged and green before the demo runs.
- Real file organization on an isolated profile (never production data).
- Three verification levels shown (observed / checked / reviewed) — never overstated.
- Failure/recovery paths: rejected approval, partial apply, interrupted mission, missing tool, reviewer partly-done.
- v2 default flip (only after receipts + onboarding land — onboarding is Stage D/E).

## Scope (out — explicitly not in Stage C)

- Living Workspaces (Stage D)
- Autonomy Contracts (Stage D)
- Proactive trigger engine, ambient overlay, human takeover (future contracts, 08-future-contracts.md)
- External agent integration (Hermes/OpenClaw/n8n) — design extensibility only; no implementation
- Onboarding / guided first mission (Stage E)
- Mail index encryption (decision pending)
- New scheduler, new memory DB, new agent engine (rejected, Part 7)

## Reuse (do not rebuild)

- Event ledger: `runtime_events`, `tool_invocations`, `model_invocations`, `approvals`, `artifacts`.
- Missions: `missions`, `mission_steps`, `mission_authorizations`, `mission_authorized_actions`, `missionRunner.ts`.
- File org: `pcOrganizer.ts` (scan/plan/apply/undo + preview), `operator.ts` (propose→verify→ask→move→rollback + undo manifest).
- Permissions: `permissionModes`, Auto grants, `evaluateMissionAction`, `frozenWorkspaceAccess`.
- Verification: `deliverableLedger`, `actionClaims`, `completionGate`, `outputChecks`, `taskCompletion`.
- UI: `Missions.tsx` MissionDock/StepRow, `Activity.tsx`, `Chat.tsx` approval card, `ui.tsx` tokens.

## Acceptance criteria (from Stage B review)

1. Successful operation produces a receipt supported by actual evidence (every "verified output" carries an evidence level; Core-computed counts).
2. Partial failure reports exactly what succeeded and failed ("194 of 196 moved · 2 failed (file locked). Nothing deleted.").
3. Existing unrelated files are never silently overwritten (DRV-010 guard + per-move verification + SHA-256).
4. Approval, pause, stop and recovery controls reflect actual Core capabilities (mission routes cancel/continue; requestCancelAttempt; boot reconciliation; resume from journal).
5. Unsupported features are not represented as implemented (input control, takeover, ambient, proactive, external agents → shown as unavailable/planned).
6. The design remains extensible to external agents and proactive background tasks (executor field on mission steps; governed interface contract).
7. No unverifiable success claims or invented progress (counts/milestones only; no guessed %).
8. No production installation or change to the default UI before the finished slice is reviewed (work on isolated profile; Classic stays default until review).

## Data contracts (external agent / workflow execution)

Mission steps carry an `executor` field: `native | hermes | openclaw | n8n | desktop-operator | coding-agent | local-model | cloud-consented`. External executors return the same evidence shape (tool calls, artifacts, counts) through the governed interface, or the step is `unverified` ("no evidence returned by external executor"). Pandesh never trusts an external executor's self-report. One central permission authority, memory authority, and evidence ledger.

## Implementation complexity & risks

- **Receipt aggregation** is new (distributed today: report msg + activity + artifacts). Build a receipt builder view over missions. Medium.
- **Living Workspace** is thin today (RecordCards). Stage C uses a minimal PC workspace (disk + recommendations), not the full structured model (Stage D).
- **DRV-010** must be merged first. Do not run the file-org demo without it.
- **Model plan quality** varies (gemma4:12b). Receipt must show evidence levels so a bad plan is visible, not hidden.
- **Reviewer depth** is limited (asserts things it didn't check). Receipt labels "reviewed" only when the Reviewer cited tool output.

## Verification plan

- Run on an isolated profile (never production data).
- Adversarial scenarios: search failure, missing tools, hallucinated completion, stale connection, rejected approval, partial file op, interrupted mission, missing specialist, model restart, missing cloud, invalid follow-up, repeated request.
- Evaluate with at least two local models.
- Record a real demo (storage cleanup) with honest notes, including failed attempts.

## Gate to proceed to Stage D

Owner reviews the finished slice (receipt on a real task, honest failure path, DRV-010 merged, tests green) and approves. No default-UI change before that.