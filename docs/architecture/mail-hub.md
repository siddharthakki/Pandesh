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
- **Incremental, with backfill and coverage.** The first sync reads the newest mail down to the per-sync limit; each account then keeps a *coverage boundary* (`mail_coverage`, migration 55): the date back to which the index has been checked against Outlook. Every later sync reads what is new since the last watermark (6-hour overlap), then continues with older mail from the boundary towards the window floor, so a limited sync never just rereads the newest mail. Mail that was moved or deleted inside a range that a pass fully read is removed. A daily full pass re-verifies the newest part; the boundary then reflects how far that pass got. The Overview, the other screens and the Inbox Assistant say when coverage is incomplete (“indexed back to <date> of <date>”), so a count or a “found nothing” is never read as “everything”. If the per-account cap stops the backfill, that is shown too and raising the cap resumes it. If more mail arrives between syncs than one sync's limit, coverage starts where the pass stopped.
- **Questions are read locally.** Free text (the inbox search, Ask Pandesh, the Inbox Assistant's evidence) goes through `mailSearch.ts` first: category words (recruiters, invoices, appointments, orders), time words (this week, last 3 days), “unread”, “needs a reply”, “important” become index conditions and the remaining words are the topic. A sentence therefore finds mail instead of requiring every word to appear. The reading is shown (“Read as: …”) and passed to the model.
- **Dedupe.** One row per message per store, keyed on the internet message id; the same message in two authorized accounts is shown once (`+n`).
- **No message text in logs.** The activity log holds counts and errors only.
- **Plain text only.** Bodies are Outlook's text body shown as text; no HTML is rendered, so a message cannot run anything in the window.
- **Local model only.** Summaries, drafts and Ask Pandesh run through the Inbox Assistant, whose Hermes profile is refused unless pinned to local Ollama. Message text reaches the model labelled as untrusted data. Chat hand-offs carry only the message id.
- **Every finding says its basis**: *From the message* (text read directly), *Detected by rule*, or *AI-inferred* (shown only on request).

## Not in Phase 1

Sending, forwarding, moving, deleting, marking read, labelling, saving attachments, creating calendar events, cloud models, background (service) sync.
**Known privacy limitation — index encryption.** The index (subjects, senders and up to 4 000 characters of text per message) lives in Pandesh's own SQLite database under your Windows profile and is **not separately encrypted**; protection is your Windows account and disk. That is acceptable for a controlled local pilot on a personal PC, not for a shared or unencrypted-disk machine. Use BitLocker, keep the text limit low (Settings → Limits), and use “Remove all indexed mail” when finished. Encrypting the index (and the FTS5 shadow tables with it) needs a key-management decision and is future work.
Email-derived tasks are suggestions with a hand-off to chat; there is no stored task list yet.
Only each account's Inbox is indexed.

## Upgrade

Migrations 54 and 55 are additive. Build 185's database opens in this build; going back to Build 185 afterwards is safe (it ignores the new tables). The installed Pandesh is not modified by this branch.
