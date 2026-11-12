# Personal Context & Continuity — remaining gaps

Ordered by impact. Each has a concrete next step.

1. **The 700-test re-run has not been done.** The optimised set (ACCEPTANCE.md §7, 51 cases) needs a packaged isolated
   instance of this branch and ~1 hour of GPU. Next: package to `D:\PandeshMicrotests\app-pcx`, copy the test profile,
   run the targets and controls with `run-batch.mjs --only`, compare with the frozen verdicts. Owner OK needed for the GPU
   window, because other evaluations share it.
2. **The local model sometimes skips the tool.** Live: "Mark it done" → no `update_task` call, claim withheld by Core.
   Honest but unhelpful. Next: when Core has resolved "it/that task" to exactly one journal item and the message is a
   status verb (done, reopen, move to <date>), offer a deterministic fast path like the existing reminder/memory
   fallbacks, with the same approval.
3. **Cross-conversation action on the user's own records.** The P0 rule refuses acting on an id recorded in another
   conversation unless this turn's tool results produced it. The model can work around it with `list_tasks` /
   `list_reminders` first, but a direct "dismiss that reminder from yesterday" in a new chat may be refused. **Owner
   decision:** allow the main assistant to act on the user's own task/reminder/commitment ids from any chat (specialists
   stay isolated)?
4. **Proactive notifications are not built.** The overview computes overdue, conflicts, stalled work and failed actions,
   but nothing pushes "only what changed". Next: a daily diff of `collectPersonalState` (new overdue, new conflicts, newly
   failed actions) into the existing notification outbox and the 08:00 briefing, with a setting to turn it off.
5. **The daily briefing does not use the overview yet.** `get_briefing_data` still covers email/calendar/reminders.
   Next: add the overview's "what matters now" and "possibly neglected" sections to it.
6. **"Recommendations already given" is not tracked.** Assistant advice is prose only. Next: a journal entry kind for
   recommendations the user accepts (stored as a memory fact with predicate `recommendation`), so "which recommendations
   have you given me" is answerable from records.
7. **Second Brain retrieval is lexical.** The any-word fallback fixes paraphrases that share a content word; true synonyms
   ("pay" vs "salary") still miss. Measure first: build a 30-query paraphrase set over the user's real granted notes. Only if
   recall stays below ~80% add local embeddings (Ollama has `nomic-embed-text` and `Qwen3-Embedding-4B` installed already;
   no new service needed).
8. **Phone path tested at Core level only.** Scenario I uses two client ids on one Core conversation, which is what
   `mobileServer` does; the phone HTTP layer itself was not driven.
9. **Goal ↔ task links are text.** A task's `goal` is matched to goal facts by words. Next: store the goal fact id on the
   task when the user links them, and show "serves goal X" in the Projects screen.
10. **Production memory is sparse** (4 facts, 0 projects in the Build 164 profile). The value grows as the owner uses tasks
    and goals; a one-time guided "tell Pandesh your current goals" prompt would bootstrap it (owner decision; never
    auto-ingested).
11. **Rollback after migration 51** needs the profile backup (a schema-51 profile does not open in Build 164).
12. **Hermes** gets no personal context by design; if Hermes is activated for personal tasks, it must call Core's
    `personal_overview` through a governed interface instead of receiving the section.
