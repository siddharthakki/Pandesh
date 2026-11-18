# Stage B — future contracts (Smart Pandesh, planned, NOT implemented)

These are **documented contracts for future work**, not implemented capabilities. They must not appear in the UI as operational. They exist so the design stays extensible and the roadmap is honest.

## Integration contracts (reuse, don't duplicate)

| Capability | Integrated via | Status |
|---|---|---|
| Hermes profiles | `core/runtime/bots/*`, `hermesEngine.ts` | **Exists** (read-only Bots). Execution delegation contract: TBD. |
| OpenClaw | governed external executor interface | **Planned** — contract TBD; permission scope frozen by Core |
| n8n workflows | governed external executor interface | **Planned** — contract TBD |
| Desktop operators (UI Automation) | `computerUseCapability` (read-only today) | **Planned** — input control is absent by design today |
| Coding agents (Aider, OpenCode, Claude Code, Codex) | Panda bridge / `codingAgents.ts` | **Exists** (delegated as text blobs today) |
| Local models | Ollama, OpenAI-compatible | **Exists** |
| Authorized cloud services | free-model registry, consent | **Exists** (whole-chat cloud, data boundary #78) |

## Planned capabilities (future contracts, not implemented)

- **Proactive trigger engine** — real triggers + dedup + scheduling; today: briefing + bots report only.
- **Ambient assistance overlay** — OS-level command palette / text selection; today: in-app Ctrl+K palette only.
- **Human takeover** — control handoff for authorized browser/desktop sessions; today: read-only observation.
- **Living Workspaces (structured)** — goal/sections/last-activity/next action/contract; today: thin RecordCards.
- **Autonomy Contracts (first-class)** — today: Auto grants + scopes + mission_authorizations substrate.
- **Outcome Receipt aggregation** — today: distributed (report msg + activity + artifacts).
- **Rehearsal / Preview UI surface** — today: text previews in chat.
- **Failure-classification loop** (Part 4) — evidence exists; taxonomy + repair suggestions unbuilt.
- **Measured model routing** — today: static chains; `bench/` exists, not wired.
- **Onboarding / guided first mission** — absent.
- **Mobile mission cards** — phone shows report message only today.
- **Mail index encryption** — acknowledged gap (BitLocker guidance now).

## Design rule

Every one of the above appears in the UI, if at all, as **"Planned"** or **"Unavailable"** — never as operational. The design leaves a slot for each (contract card, disabled control with tooltip) so the surface is extensible without implying capability.