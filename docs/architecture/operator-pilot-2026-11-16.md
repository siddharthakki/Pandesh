# Intelligent Operator: audit and first pilot (2026-11-16)

Status: pilot on `feat/operator-pilot`, **off by default**, not merged, not installed.

## What already exists (reused, not rebuilt)
- **Specialists** are definitions, not processes (`core/domain/agents.ts`): chief, personal, coding, research, operations, voice, sales, marketing, social, reviewer, each with an allow-listed tool set, workspace roots, egress, model policy, limits and `workingRules`. A run's scope is the intersection of the agent, every ancestor and any grant, frozen at submission (`core/domain/delegation.ts`), so delegation can never widen authorization.
- **Deterministic hand-off** (`piAgentEngine.ts`): when the owner names a specialist, Core starts it itself (`delegate_to_agent`, recorded like any tool call), runs the scope preflight, and the lead model only reports the result.
- **Task-aware tool selection** (`chatToolSelection.ts`): the first model call sees base tools plus the groups the request points at; the rest are added with `request_tools`.
- **Skills**: 10 built-in skills + a user/workspace loader with trust levels; `read_skill` loads detail on demand. **Memory**: Second Brain / `memory_remember` / `memory_recall`. **Capability inventory** and live model awareness (`modelAwareness.ts`, GPU fit, Capability Explorer).

## Gap found
Routing to a specialist is **explicit only**: the owner must say "ask Operations". An outcome described without naming one ("how much disk space is free?") is handled by the general lead.

## Pilot
`core/runtime/specialistIntent.ts`: a pure, conservative classifier that routes read-only, local, no-approval PC-state questions to Operations through the *same* deterministic hand-off. Anything that changes something, goes online, concerns the owner's files, asks about the agents, or is negated is never routed. Enabled only with `PANDESH_IMPLICIT_SPECIALISTS=1`.

## Evidence (real Core, isolated profile, real Ollama, no scripted answers; 4 tasks each)
Lead model `qwen9b-fixed` (9B Q8, 10 GB; reports tools, thinking, vision), general agent vs implicit routing:

| Task | General agent | Implicit to Operations |
|---|---|---|
| free disk space | 17.6 s, 1 call, `system_hardware_telemetry`, correct | 10.5 s, lead 1 + specialist 1 call, same tool, correct |
| graphics memory | 3.2 s, 1 call, no tool (answered from the live model context), plausible | 6.1 s, 2 calls; specialist called `calculate` (wrong tool) |
| greeting | 3.1 s, 1 call | 1.6 s, not routed (correct) |
| listening ports | 12.4 s, 1 call, `listening_ports`, correct | 27.4 s, 2 calls, same tool, correct |

Same four tasks, general agent, `gemma4:12b`: 18.1 / 4.5 / 3.8 / 13.5 s, the same tool choices. No unauthorized action occurred in any run; no failure needed recovery.

## Reading
- `qwen9b-fixed` is as accurate as `gemma4:12b` on these tasks and about 10-30% faster; a viable lightweight lead. It is not made the default.
- For simple read-only facts the general lead already picks the right tool; routing added a model call, was slower in 2 of 3 routed tasks, and once the specialist picked a worse tool. **Do not enable implicit routing for these.** The mechanism is worth keeping for work where a narrowed tool set and working rules matter (multi-step, higher risk), which needs its own measurement.
- Not demonstrated here: skill selection, a permission-boundary refusal, recording a procedure with consent. Those remain proposals.
