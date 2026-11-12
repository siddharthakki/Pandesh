# Personal Context & Continuity — implementation

Branch `feat/personal-context`, based on `main` `1df701e`. Worktree `D:\Projects\Pandesh\.claude\worktrees\personal-context`.

## Commits
1. `9eb6cf1` — **P0 tool execution journal** + Hermes opt-in routing, carried unchanged from the uncommitted
   `fix/tool-execution-journal` worktree (`D:\Projects\Pandesh-journal`, the Hermes/P0 session, which was told so).
2. Personal context layer, tools, routing fixes, Second Brain, tests (the later commits on the branch).

## Migration
Only **migration 51** (`tool_execution_journal`, from the P0 work). No other schema change: tasks keep living in
`projects.productContext.tasks` (the Projects screen keeps working), goals are memory facts, everything else is read.

Tested on a disposable copy of the real Build 164 profile database (from `D:\PandeshBackups\b164-upgrade-…`, copied to
the scratchpad, deleted afterwards): schema 50 → 51 in 5 ms, `PRAGMA quick_check` ok, row counts of conversations,
messages, tool invocations, memory, projects, commitments and reminders unchanged; journal backfill from recorded evidence
for all 104 conversations: 898 rows in 0.76 s. **Rollback note:** a profile at schema 51 cannot be opened by Build 164;
roll back with the profile backup that the installer takes.

## Files

| File | Change |
|---|---|
| `core/domain/toolJournal.ts`, `core/db/migrations.ts`, `core/domain/toolInvocations.ts`, `core/runtime/executor.ts`, `core/runtime/turnOutcome.ts` | P0 journal (see commit 1). Added here: `ptask` kind; `add_task` = created; `personal_overview` = read; `personal_overview`/`search_second_brain`/task tools private; a tool may declare the id it created (`details.primaryId`). |
| `core/domain/personalTasks.ts` (new) | Task record, `addTask`, `updateTask` (status incl. reopen, due, priority, rename, blocker, goal, note, move), `findTask` (ref / words / ambiguity), `listTasks` (open, overdue, due-within, completed-since, project, text). |
| `core/domain/personalContext.ts` (new) | Fact source classes, personal state, priority ranking, `personalOverview` (focus: all/priorities/due/completed/unfinished/changes/decisions/about_me), per-turn section. |
| `core/domain/secondBrain.ts` | `toFtsAnyQuery` + opt-in any-word fallback; `searchBrainForChat`; `documentSensitivity` (secret-named files indexed as `restricted`). Second Brain screen behaviour unchanged. |
| `core/domain/memory.ts` | `recallMemories` retries an empty exact subject/predicate recall as free words (MEM-012). |
| `core/runtime/memoryCapability.ts` | Recalled entries carry `source` ("you told me", "from a document…", "inference…"). |
| `core/runtime/piAgentEngine.ts` | Tools `add_task`, `update_task`, `list_tasks`, `personal_overview`, `search_second_brain`; personal section added to the turn (main assistant only, local model only); a reference to "that/the saved job posting" is not a public job search. |
| `core/runtime/chatToolSelection.ts` | Group `personal` (two read tools) for personal/planning messages; task wording offers the `projects` group. |
| `core/runtime/assistantStatus.ts` | "My tasks / due this week" no longer answered from background-job status. |
| `core/runtime/actionClaims.ts` | `add_task`/`update_task` count as evidence for task-change claims. |
| `core/domain/permissionModes.ts` | `list_tasks`, `personal_overview`, `search_second_brain` are read-only tools. |
| `core/domain/agents.ts` | Chief: `list_tasks`, `personal_overview`, `search_second_brain`. Personal agent: task tools + overview. Others unchanged. |
| `apps/desktop/renderer-v2/src/Workspaces.tsx` | Projects screen shows due date (overdue), high priority and blocker per task. |
| `core/test/personalContinuity.acceptance.test.ts` (new) | Scenarios B–L + real task flow (black-box). |
| `core/test/personalContext.test.ts` (new) | 13 unit tests. |
| `core/test/toolResultContinuity.acceptance.test.ts` | Test 8's content assertion scoped to the journal section (see ACCEPTANCE.md, "Spec change"). |

## Dependencies
None added.
