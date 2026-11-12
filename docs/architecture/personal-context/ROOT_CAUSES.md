# Why Pandesh loses context and fails to connect personal information

Each cause names the mechanism, where it lives, and the evidence that showed it.

## RC1 — Tool results were not part of the next turn (P0)
`piAgentEngine.ts` and `executor.ts` rebuilt the model's history from `conversation_messages` filtered to user/assistant
prose. Tool results lived only in `tool_invocations.evidence.output` (500 chars) and were never read back. A plan id,
file path or result reached the next turn only if the assistant happened to quote it. The model, not Core, was the de
facto source of truth for what happened. Evidence: P0 suite, Build 163 0/10, Build 164 1/10.
Fixed by the tool execution journal (migration 51, `toolJournal.ts`; carried in commit `9eb6cf1`).

## RC2 — Personal memory was pull-only
Remembered facts reached the model only if the model chose to call `memory_recall` with matching words. A local 12B
model often does not (MEM-008, MEM-011), or calls it with a guessed predicate that matches nothing (MEM-012). There was no
standing, relevant picture of the user in the turn. Evidence: live Build 164 — the city/model question cost two recall
calls; the priorities question never looked at Projects at all.

## RC3 — No single place assembled "what matters now"
Goals (memory facts), tasks (Projects JSON), promises (commitments), reminders, household obligations and Pandesh's own
action history live in six stores, each with its own tool. Nothing joined them, ranked them, or said what was overdue,
blocked, stalled or completed. The daily briefing reads email/calendar/reminders, not tasks, goals or action history.
Evidence: TSK-013 ("what did we complete this week?"), live "what am I neglecting?" → "I can't tell".

## RC4 — Tasks could not hold what a person tracks
`productContext.tasks` held `{id, title, status}`. No due date, priority, blocker, goal, notes, completion time, history;
no tool to add or change a task. The model filled the gap with prose ("I've updated the task with a deadline of Friday")
that Core had to withhold. Evidence: TSK-001/002/005/017 and 13 TSK fails.

## RC5 — Provenance was recorded but invisible
`memory_evidence.sourceType` and household `proposed/confirmed` distinguish user-stated, imported and confirmed facts, but
nothing showed that distinction to the model or the user. An imported or unevidenced fact looked identical to one the
user confirmed. Evidence: MEM-011 (invented preference not labelled), mission requirement "never silently promote an
inference".

## RC6 — The Second Brain was not wired to chat, and its search was too strict
`searchBrain` was only exposed to the Second Brain screen. Its FTS query requires every word (`AND`), so "when must I send
my application" misses a document that says "Application deadline". Document sensitivity was always `internal`, so a file
named `bank-passwords.txt` in a granted folder was searchable.

## RC7 — Shortcuts and routers captured personal questions
- `isPublicResearchTask`: "What were the salary, the deadline and the link of **that job posting**?" matched the vacancy
  search rule. The turn was forced into public web research: local tools and the earlier read were dropped, and the
  user's question was sent to a search engine (found by acceptance scenario B, which made real web requests).
- `classifyStatusRequest`: "What tasks do I have due this week?" was answered from Pandesh's background-job state.

## RC8 — The journal could record the wrong created item
`extractRefs` took the first new id in a result as "the created item". `add_task`'s result names the project before the
task, so the journal said a *project* was created, with the task's title; "mark that task done" then had no task to
resolve (found by scenario I).

## RC9 — The claim check did not know the new task tools
`actionClaims.ts` accepted only reminder/commitment/project tools as evidence for "I've created/marked the task". With
real task tools the honest "I've created the task" was replaced by "[Not done…]" (found by the live check).

## Not a root cause: the stores themselves
SQLite, M39 memory, contradictions, consent and the agent scopes are sound. The failures above are in **how context is
assembled and delivered**, not in what is stored. That is why the fix adds no new database, vector store or framework.
