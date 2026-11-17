# Mail Hub (Phase 1, read-only)

Classic Outlook → read-only STA worker → Core → local index (SQLite FTS5) → Mail Hub screens and the Inbox Assistant.

## What exists

| Piece | Where |
|---|---|
| STA PowerShell worker (COM, no write command; JSON lines) | `core/runtime/mail/outlookWorkerScript.ts`, written to `<dataDir>/mail/` at run time |
| Connector: serial bounded queue, per-call timeout, cancel, restart after crash/hang, health | `core/runtime/mail/outlookConnector.ts` |
| Index (migration 54): accounts + authorization, messages, `mail_fts`, settings, activity | `core/db/mailHubMigration.ts`, `core/runtime/mail/mailIndex.ts` |
| Deterministic reading: category, amounts, dates, needs-reply, bulk | `core/runtime/mail/mailRules.ts` |
| Host-only routes `/v1/mail/*` | `core/api/mailRoutes.ts` |
| Inbox Assistant source `outlook_mail` (the existing Bot; no second agent) | `core/runtime/bots/botSources.ts` |
| Eleven native screens under **More → Mail Hub**, deep link `view:mailhub#<screen>` | `apps/desktop/renderer-v2/src/MailHub.tsx`, `mailHubModel.ts` |

## Behaviour that matters

- **Authorization first.** Nothing is read from an account until the owner switches it on in Settings; turning it off deletes what was indexed from it.
- **Bounded.** Defaults: 30-day window, 500 messages per sync, 2 000 per account, 90-day retention, 4 000 characters of text per message. All adjustable in Settings → Limits. A sync that hits its limit says so.
- **Incremental.** After the first read a sync asks only for mail since the last watermark (2-day overlap); once a day the window is reconciled so moved and deleted mail leaves the index.
- **Dedupe.** One row per message per store, keyed on the internet message id; the same message in two authorized accounts is shown once (`+n`).
- **No message text in logs.** The activity log holds counts and errors only.
- **Plain text only.** Bodies are Outlook's text body shown as text; no HTML is rendered, so a message cannot run anything in the window.
- **Local model only.** Summaries, drafts and Ask Pandesh run through the Inbox Assistant, whose Hermes profile is refused unless pinned to local Ollama. Message text reaches the model labelled as untrusted data. Chat hand-offs carry only the message id.
- **Every finding says its basis**: *From the message* (text read directly), *Detected by rule*, or *AI-inferred* (shown only on request).

## Not in Phase 1

Sending, forwarding, moving, deleting, marking read, labelling, saving attachments, creating calendar events, cloud models, background (service) sync.
Index encryption: the index lives in Pandesh's database under your Windows profile; it is not separately encrypted.
Email-derived tasks are suggestions with a hand-off to chat; there is no stored task list yet.
Only each account's Inbox is indexed.

## Upgrade

Migration 54 is additive. Build 185's database opens in this build; going back to Build 185 afterwards is safe (it ignores the new tables). The installed Pandesh is not modified by this branch.
