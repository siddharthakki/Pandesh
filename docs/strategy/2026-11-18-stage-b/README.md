# Stage B — Verified Delegation Experience Design

**Date:** 2026-11-18 · **Status:** design-only milestone. No Core implementation, no production changes, no installer.
**Branch:** `docs/stage-b-design` · **Companion:** Stage A docs in `docs/strategy/2026-11-18-stage-a/`.

## One coherent product

> **Calm when idle. Alive when working. Precise when deciding.**

Pandesh is not a dashboard. It is a conversation that becomes a mission when work starts, becomes a cockpit while it runs, and becomes a receipt when it finishes. The interface is quiet until something real is happening; then it shows exactly that, with the evidence behind it.

The design answers one question: **why would someone use Pandesh every day instead of ChatGPT, Claude, Hermes or another agent dashboard?**

> Because Pandesh is the only one that **shows its work, proves what it did, and lets you rehearse before it acts** — and it runs on your own PC, under your rules.

## Ten core screen states (light + dark, compact covered)

1. **Idle desktop** — calm landing, composer central, active-work summary, recent receipts
2. **Mission running** — contextual Mission Control pane, live timeline, counts
3. **Browser / computer observation** — work pane with real tool output / screen
4. **Multi-agent collaboration** — lead + specialist + reviewer, contributions traced
5. **Approval required** — exact action, consequence, allow/deny
6. **Verified task completion** — Outcome Receipt (success)
7. **Failed task and recovery** — honest failure, what happened, retry
8. **Personal workspace (PC)** — living record, "where we left off"
9. **Bot details** — identity, job, memory, schedule, recent results
10. **Compact / narrow window** — bottom bar + drawer

Plus the three flagship flows (Mission Control, Outcome Receipt, Rehearse) each shown as success + failure/recovery.

## Documents

| Doc | Contents |
|---|---|
| [01-design-system.md](01-design-system.md) | Tokens, typography, spacing, motion, accessibility, iconography |
| [02-screen-states.md](02-screen-states.md) | The 10 states: layout, elements, data, reuse, compact |
| [03-flagship-flows.md](03-flagship-flows.md) | Mission Control, Outcome Receipt, Rehearse — success + failure |
| [04-data-contracts.md](04-data-contracts.md) | Core event/API data per screen; missing capabilities |
| [05-components-reuse.md](05-components-reuse.md) | Reusable existing components + new ones needed |
| [06-prototype/](06-prototype/) | Clickable local prototype (HTML/CSS/JS) |
| [07-rationale-tradeoffs.md](07-rationale-tradeoffs.md) | Why Pandesh daily, rejected alternatives, trade-offs |

## Guardrails honored

- Seven-destination sidebar preserved; contextual workspace approach preserved.
- Bot HQ studied for the watch-agents-work idea; Pandesh identity is distinct (cockpit, not virtual office).
- Every visible status maps to a real or explicitly-flagged-prototype Core datum (see 04-data-contracts).
- No backend capability invented to support a design; gaps are listed, not hidden.
- Design-only: no Core implementation, no production changes, no installer. DRV-010 fix remains on its own branch, unmerged.