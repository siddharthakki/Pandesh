# Mail Hub — Stage A architecture audit

Base: `main` b1b41e5 (PR #126, Build 185). Branch `feat/mail-hub`, worktree `D:\Projects\Pandesh-mailhub`.
Production is untouched; no installation or mailbox write has happened.

## Environment facts (probed read-only, no message content read)

- Classic Outlook 16.0.0.17932; COM `Outlook.Application` activates from an STA PowerShell.
- Three Gmail IMAP stores: Inbox sizes 38 280 / 23 440 / 48 items (10 437 / 19 864 / 34 unread).
  Mailboxes are large, so indexing must be bounded and incremental; a full scan is not acceptable.

## Reuse / extend / new

| Need | Existing piece | Decision |
|---|---|---|
| Inbox Assistant | `core/runtime/bots/*` (botSources, botRunner, botCapability); sources are `gmail_inbox`, `pc_software`, `ai_radar`, `engineering`; evidence has `privateData`, `items`, `refs` | **Extend**: add an `outlook_mail` evidence source in `botSources.ts`; no second agent |
| Navigation / More menu | `renderer-v2/src/App.tsx` (`View`, `spaces`, palette, `navigate_to`), `core/shared/uiDestinations.ts`, `navigationTargets.ts` | **Extend**: one `mailhub` view under More + one destination (`view:mailhub`, screen via `#fragment`) |
| Database / FTS5 | `core/db` on `node:sqlite` (FTS5 already used by `secondBrain.ts`), migrations in `core/db/migrations.ts` | **Reuse**: new tables via a migration, same DB |
| Gmail API connector | `core/runtime/connectors/*`, `gmailOrganize.ts` | **Unchanged** |
| Permission / approval | existing gates; Phase 1 is read-only, no write tool is added | **Reuse** |
| Scheduler | Automations / routines | **Reuse** for Smart Rules (Stage E) |
| Tasks | Board / task infrastructure | **Reuse** for email-derived tasks (Stage D) |
| Local AI | Ollama path, cloud boundary (#78) | **Reuse**; mail is `privateData`, never routed to cloud |
| Outlook COM | none in repo | **New**: STA worker process (PowerShell, no new dependency), JSON-lines protocol, timeouts, bounded queue, cancel |
| Desktop bridge | `preload.ts`, `ipc.ts`, `renderer-v2/src/bridge.ts` | **Extend** with `mailHub*` calls |

## Blocker for Stage C

The approved Mail Hub HTML prototype is not on this PC (searched Downloads, Desktop, Documents, repo, `D:\`
roots). Per the mission it is not being re-invented. Stages A, B (connector) and the index/Core services do not
depend on it and continue.
