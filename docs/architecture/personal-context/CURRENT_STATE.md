# Personal Context & Continuity — current state

Audit of `main` at `1df701e` (Build 164 + PR #66), 2026-11-12. Production is Build 164 (`32f8963`), schema 50.
Everything below was read in the code or measured; nothing is assumed from a feature having been merged.

## What exists

| Area | Where | State found |
|---|---|---|
| Conversation history | `conversation_messages`, `conversation_turns`, `piAgentEngine.ts` history rebuild | User/assistant **prose only**. Tool results never reached a later turn unless the assistant repeated them. |
| Tool evidence | `tool_invocations.evidence.output` | First **500 characters** of each result. Never read back into the model's context. |
| Execution journal | — | Did not exist in `main`. Built (uncommitted) by the Hermes/P0 session in `D:\Projects\Pandesh-journal`; carried into this branch as commit `9eb6cf1`. |
| Point fixes for lost context | `listEarlierReads` (C4), `listOpenGmailPlans` (#66), `homeLocationFact` (C6) | Each fixes one symptom (file reads, Gmail plans, home city) by injecting one more section. |
| Durable memory | `memory_facts`, `memory_evidence`, `memory_contradictions`, `knowledge_entities/relationships` (M39) | Solid store: provenance hash, consent approval, contradictions kept and resolved, correction tombstones the old value, export, impact analysis. **Pull-only**: the model must decide to call `memory_recall`; nothing about the user is in its context otherwise (except the home city). |
| Memory recall | `recallMemories` | Exact `subject`/`predicate` filter; a guessed predicate found nothing (MEM-012). |
| Fact source | `memory_evidence.sourceType` | Recorded (`conversation_message`, `tool_invocation`, `capability_approval`) but **never shown**: the model could not tell a fact the user stated from one imported from a document. |
| Projects / tasks | `projects.productContext.tasks` (JSON) | Tasks were `{id, title, status}` only: no due date, priority, blocker, goal, notes, completion time or history. Only `create_project` and `list_projects`; **no tool could change a task**. |
| Commitments, reminders | `commitments`, `everyday_reminders` | Work; tools exist. |
| Household OS | `household_obligations` (`proposed` = extracted, `confirmed` = user-confirmed) | Works; already distinguishes imported from confirmed. |
| Daily briefing | `collectBriefingData` (`get_briefing_data`) | Gmail/Calendar/reminders/approvals oriented. Does not read Projects tasks, goals or Pandesh's own action history. |
| Second Brain | `secondBrain.ts`, FTS5 `brain_fts`, `knowledge_sources/chunks` | Indexes facts, notes, promises, artifacts, entities and granted `.md/.txt` folders; detects file changes by SHA-256; drops deleted files and revoked grants; `restricted` facts never indexed. **Not reachable from chat** (UI/API only). Query = every word required (AND), so paraphrases miss. Every document indexed as `internal`, including a file named `bank-passwords.txt`. |
| Agents | `agents.ts`, `agentScope`, memory scopes | Specialists get no user memory; memory scopes enforced at dispatch. |
| Phone | `apps/desktop/src/host/mobileServer.ts` | Shares the desktop's active Core conversation (`/api/messages`), so phone and desktop already hit the same Core records. |
| Hermes | `hermesEngine.ts` | `main` auto-routes to Hermes whenever its port answers; the default Hermes profile is cloud. The P0 branch made this opt-in (`PANDESH_HERMES_ROUTES`). |

## What works and what fails — evidence

**Build 163 frozen 700-test baseline** (unchanged: 237 pass / 162 partial / 154 fail / 147 blocked). 127 scenarios touch
memory, continuity, tasks, planning, follow-ups or agents: **43 pass, 28 partial, 43 fail, 13 blocked**. The weakest
areas: TSK (2 pass of 24) and MEM (7 of 17 pass). Representative failures (observations quoted from `Pandesh_700_Results.jsonl`):

- TSK-001/002/017: "I've created the task… updated it with a deadline of Friday" — nothing stored; no tool exists.
- TSK-006/010/015/016/020/021: the task or project existed in Core; Pandesh said it could not find it.
- TSK-003/004/013/014: no due date / priority / completion time to answer from.
- MEM-011: invented "you prefer gemma4:12b because…" with no stored preference, not labelled as inference.
- MEM-012: preference stored, recall by a guessed predicate found nothing.
- MEM-016: "Recall the last file we created" searched notes, not the recorded artifacts.
- JOB-011: the posting said "Application deadline: …"; Pandesh said it had none.

**P0 tool-result continuity** (`core/test/toolResultContinuity.acceptance.test.ts`, 10 black-box scenarios, scripted
forgetful model): Build 163 **0/10**, Build 164 **1/10** (numbers from the P0 session's runs).

**Personal-context suite** (`core/test/personalContinuity.acceptance.test.ts`, 11 scenarios) on Build 164 (`32f8963`):
**2/11** (B document continuity, G correction). Details in `ACCEPTANCE.md`.

**Live, real `gemma4:12b`, synthetic profile, Build 164:**
- "What are my top priorities today?" → named only the Mueller tasting-date promise; missed the high-priority interview due
  tomorrow (8.6 s, 3 tool calls, then suggested connecting Google).
- "What am I neglecting at the moment?" → "I can't tell exactly what you're neglecting…".
- "Which city do I live in, and which model do I prefer?" → correct, after two `memory_recall` calls (3.8 s).

**Production profile (read from a copy of the Build 164 upgrade backup, counts only):** 104 conversations, 1,072
messages, 1,570 tool invocations, 4 memory facts, 0 projects, 5 commitments, 5 reminders, 5 pending approvals; in the last
7 days 26 consequential actions succeeded and 8 failed. Personal memory in production is sparse: the system has little
to remember from today, so most value will come as the owner uses tasks, goals and memory.
