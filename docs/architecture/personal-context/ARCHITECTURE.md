# Personal Context & Continuity — architecture

Principle: **Core is the authority for what is true and what happened; the model reads a compact, relevant, labelled
view of it, and fetches full records deterministically on demand.** No new database, vector store, agent framework or
memory product. Everything is derived from tables Pandesh already has, plus one journal table (migration 51).

## Data flow for one turn (main assistant, local model)

```
user message
   │
   ├─ Core routers (status shortcut, public-research detector)  ← no longer capture "my tasks" / "that posting"
   │
   ├─ EXECUTION JOURNAL section (toolJournal.ts)                 what Pandesh did in THIS conversation:
   │     ids, paths, artifacts, status, reference resolution       ambiguous "undo that" → Core asks first
   │
   ├─ PERSONAL section (personalContext.ts)                       who the user is and what matters now:
   │     relevance-gated; each fact with source + date + id        facts · goals · ranked deadlines · blocked ·
   │                                                               possibly neglected · failed actions · approvals
   ├─ tools offered (chatToolSelection.ts, group "personal"/"projects")
   │     personal_overview · search_second_brain · list_tasks · add_task · update_task · recall_execution · memory_*
   ▼
model → tool calls → Core executes under the usual approvals → completeToolInvocation → journal row (full result)
```

## Components

| Component | Role | Reads | Writes |
|---|---|---|---|
| `toolJournal.ts` (P0) | Structured record of every completed tool call; per-conversation, per-agent; reference resolver; `recall_execution` | `tool_invocations` | `tool_execution_journal` |
| `personalTasks.ts` | Task record with dueAt, priority (user-declared), goal, blockedBy, notes, completedAt, history; find by ref or words; ambiguity reported | `projects.productContext.tasks` | same (via `updateProject`, revision-checked) |
| `personalContext.ts` | `factSourceClass`, `collectPersonalState`, `rankPriorities`, `personalOverview`, `buildPersonalContextSection` | memory, tasks, commitments, reminders, household, journal, approvals | nothing |
| `secondBrain.ts` additions | any-word fallback, `searchBrainForChat` with source citation, document sensitivity by file name | FTS index | index rows only |
| `memory.ts` | recall retries a guessed subject/predicate as free words | memory | — |
| `memoryCapability.ts` | each recalled fact carries its source label | memory | — |

## Fact classes (what the model and the user see)

| Class | Decided from | Shown as |
|---|---|---|
| user_stated | evidence `conversation_message` | "you told me" |
| user_confirmed | consent approval / `capability_approval`; household `confirmed` | "you confirmed" |
| observed | evidence `tool_invocation` from a non-import tool | "seen by a Pandesh tool" |
| imported | evidence from a document/email/calendar/household/brain tool; household `proposed` | "from a document/email, not confirmed by you" |
| inferred | no evidence, or a predicate marked inferred/hypothesis | "inference, not confirmed" |
| superseded | state `historical` (a newer fact won the contradiction) | listed under "earlier goals" / "decisions that changed" |
| corrected | `correctMemory` tombstones the wrong value (`forgotten`) | not shown (erased on the user's request) |
| stale | not updated for 180 days | "may be outdated" |

An inference is never promoted: the class is computed from evidence rows every time, never stored from the model.

## Prioritisation (deterministic, explainable)

Score = deadline (overdue 4, ≤1 day 3, ≤3 days 2, ≤7 days 1) + declared priority (high 3, low −1) + goal link (a goal
the user called top/highest 2, any stated goal 1) + a promise to someone 1.5. Blocked items are excluded from "what to do
next" and listed separately. Frequency of mention is **not** an input. Every ranked line carries its reasons and its id.

## Trust boundaries

| Boundary | Rule | Where enforced |
|---|---|---|
| Main assistant vs specialists | Personal section only for the main assistant (`agentId` null/`chief`). Specialists keep their memory scopes; `personal_overview` is only in the chief/personal tool lists. | `buildPersonalContextSection`, `agents.ts` |
| Local vs external model | A model that does not run on this PC (`…-cloud`/`:cloud`) gets a one-line "withheld" notice, no facts; Second Brain text and private journal results are withheld from it. | `buildPersonalContextSection`, `searchBrainForChat`, `toolJournal` (`PRIVATE_TOOLS`) |
| Conversation vs conversation | Journal content is per conversation; acting on an id recorded for another conversation or agent is refused unless this turn's own tool results produced it. The user's own dated records (tasks, reminders, promises) are visible to the main assistant in any chat. | `foreignIdsInMessage` in `beforeToolCall` |
| Documents vs instructions | Second Brain passages are labelled as information, never instructions; secret-named files are `restricted` (never indexed). | `searchBrainForChat`, `documentSensitivity` |
| Consequential changes | Task, memory, reminder changes go through the existing approval / permission modes; the claim check accepts a "done" only with a matching successful tool. | existing approval gates, `actionClaims.ts` |
| Hermes | Auto-routing is opt-in per task class (`PANDESH_HERMES_ROUTES`, `HERMES_ENABLED=false` kill switch); Hermes turns get none of the personal section. | `executor.ts`, `hermesEngine.ts` |

## Context budget

The personal section is capped at 1,800 characters and only added when the message is personal or about planning;
`personal_overview` and `search_second_brain` are offered only for such messages. Measured prompt size (synthetic
profile, same messages, Build 164 → this build): arithmetic 5,056 → 5,134 tokens (+78); "my top priorities this week"
5,060 → 5,882 (+822); "which model do I prefer" 5,062 → 5,627 (+565); "create a task" 5,062 → 6,464 (+1,402, three task
tool definitions). Core-side assembly time is unchanged (60–100 ms per turn; the overview reads a real profile in 15 ms).
