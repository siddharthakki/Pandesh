# Feature gap matrix

Priority: **P0** prerequisite for any v2 surface · **P1** core v2 · **P2** v2 extension · **P3** Phase 3 (proactive / external). "Exists" cites the inventory.

| Capability | Exists today (evidence) | Proposed | Gap type | Priority | Phase |
|---|---|---|---|---|---|
| Reliability gate (19 missions on one clean build) | Partial re-runs only (`RELIABILITY_REMEDIATION_HANDOFF.md`) | Full verdict | Verification | **P0** | 1 |
| Live event feed for UI | `runtime_events` + WS + `?after=` | Add domains `agent`, `resource`, `process`; client cursor store | Extend | P0 | 2a |
| Activity projection in Core | Host JSON (`workspaceActivity.ts`) | Core endpoint `/v1/activity?conversationId=` derived from events | Move authority | P0 | 2a |
| Board state projection | `/v1/board/snapshot` (stories), `/v1/tasks/overview` | One pure projection over attempts/approvals/outcomes/stories/queue | Unify | P1 | 2a |
| Agent registry + scope gate | None in Core (extension has roles) | `agent_definitions`, `requests.agentId`, per-agent tool exposure | New | P1 | 2b |
| Handoff contract | Delegation to OpenCode/Hermes only | `agent_handoffs`, grant intersection, depth/fan-out, dedupe | New | P1 | 2b |
| Resource arbiter | `gpuLaneLimit`, `interactiveLane`, residency | Leases across LLM/diffusion/ASR/process | New (small) | P1 | 2b |
| Structured agent result | `task_outcomes` | Required `notDone`, `artifacts`, `changedFiles` | Extend | P1 | 2b |
| New UI shell (rail, spaces, palette) | 3-tab rail, workspace aside | `ui_information_architecture.md` | New UI | P1 | 2a |
| Agent Team UI | None | Directory + detail | New UI | P1 | 2b |
| Tools & Skills Hub | Integrations page, capability inventory | Six sections + mapping + testing | New UI | P1 | 2c |
| Capability testing (preflight) | Acceptance harness (dev only) | User-runnable probes per tool/agent | New | P1 | 2c |
| MCP in Core | Extension-only `McpRegistry.ts` | Core-side registry, per-agent grant, approval + audit | Port | P2 | 2c |
| SKILL.md import | Hermes skills, built-ins | Reviewed import, per-agent grant | New | P2 | 2c |
| Second Brain search (FTS5) | `LIKE` recall | FTS5 over facts + chunks; sources registry | Extend | P1 | 2d |
| Second Brain inspector/timeline/2D graph | None | Views + API | New UI | P1 | 2d |
| 3D galaxy | None | Optional lazy view | New UI | P2 | 2d |
| Semantic retrieval | Deliberately none | Gated by eval | Optional | P2 | 2d |
| Visual Execution: process registry | `processOwnership.ts` | `execution_processes`, host watchdog | Extend | P1 | 2e |
| Embedded terminal | None | PTY + xterm (new deps) | New | P1 | 2e |
| Show My Work windows | Window list only | Owned-window placement | New (class 2) | P2 | 2e |
| Interactive tool views | Activity cards, screenshots | 8 view contracts | Extend | P1 | 2e |
| Projects space | Tables exist | Project page | New UI | P2 | 2f |
| Media Studio | ComfyUI tools, media production | Queue + gallery + provenance | New UI | P2 | 2f |
| Wish to Reality space | Tools/tables (frozen) | Pipeline view (read-only first) | New UI | P2 | 2f |
| Social Studio drafts desk | None | Drafts store, voice file, approve/redo/reject, weekly pitch | New | P2 | 2f |
| Social publishing/analytics (Metricool etc.) | None | Opt-in connectors, approval per post | New external | P3 | 3 |
| Customer Support / Sales agents | Wish orders/offers | Cases, CRM (local), drafts | New | P3 | 3 |
| Voice: finish window, barge-in, multilingual | Wake word, local speech, Pocket TTS | Voice agent spec | Extend | P2 | 2g |
| Telephony / Telegram | None | Opt-in channels, server-side auth | New external | P3 | 3 |
| Proactive briefings, standing orders, shadow governor | Daily brief, routines, scouts | Policies in shadow mode first | Extend | P3 | 3 |
| n8n | None | Optional connector + workflow inspector | Optional | P3 | 3 |
| Mouse/keyboard takeover | Intentionally unsupported | Pointer overlay only | **Rejected** | — | — |
