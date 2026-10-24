# Pandesh

**Pandesh** is the local-first personal AI assistant of the KarkeDikha platform. It runs entirely on
your machine: a local model, a local Core, and your own data. You talk to it in plain language; it
uses the tools you have connected, keeps track of what you promised, and shows you what it actually
did.

The friendly panda is Pandesh's face. The product behind it is the governed KarkeDikha Core, so
nothing happens without the governance you would expect from an engineering platform: approvals for
consequential actions, durable evidence, and a truthful record of every step.

---

## Install

### Windows alpha (recommended)

```text
dist\Pandesh-Setup.exe        (per-user, no administrator rights needed)
dist\Pandesh-Setup.exe.sha256 (checksum sidecar)
```

1. Verify the checksum before running it:

   ```powershell
   Get-FileHash .\dist\Pandesh-Setup.exe -Algorithm SHA256
   # compare with the .sha256 sidecar
   ```

2. Run the installer. It installs per-user under
   `%LOCALAPPDATA%\Programs\Pandesh` and creates a Start Menu and Desktop shortcut named
   **Pandesh**.
3. Start a local Ollama instance with at least one model installed — Pandesh talks to
   `http://localhost:11434` and nothing else by default.

The installer is **unsigned**, so Windows SmartScreen will warn on first run. That is expected for
this alpha; there is no code-signing certificate in this build.

### Portable build (no installer)

```text
dist\pandesh-win32-x64\Launch-Pandesh.cmd
```

Same product, unpacked. Your data directory is the same either way.

### Existing installations

The install identity (the Inno `AppId` GUID) is **unchanged** from the earlier "Jarvis Desktop"
builds, so an existing installation upgrades in place and keeps your settings, paired phones,
conversations and stored Google credential. Only the names you see changed.

---

## First run

1. **Pick a model.** Pandesh lists the models Ollama has installed. It never silently downloads one.
2. **Choose a workspace (optional).** Conversation works without one; file work needs one.
3. **Talk.** The Home screen shows the calm panda welcome until something needs you. After that it
   shows at most three real items — a pending approval, a task that failed or was interrupted, a
   result that just landed — each naming the source it came from and carrying working buttons.

### Connecting Google (mail and calendar)

Pandesh does not ship a Google credential. One-time setup, in **Connections → Google Services**:

1. In Google Cloud Console, create an **OAuth Desktop app** client and download the client JSON.
2. In Pandesh, import that JSON (or paste the client id and secret). It is stored encrypted with
   the OS credential store — never in the chat, never in a file you can read.
3. Press **Connect Google**. A real browser opens; you sign in and grant access. Pandesh listens on
   an ephemeral loopback address for the redirect and exchanges the code itself (PKCE). The refresh
   token is stored encrypted; the short-lived access token lives in memory only.

Grants requested: read mail, compose mail, calendar events, and your e-mail address. Calendar only
works if Google granted the calendar scope in that sign-in; if it did not, Pandesh says so instead
of pretending.

---

## What you can ask

| Ask | What really happens |
|---|---|
| "What's on my plate today?" | A grounded briefing built from Core's real state, plus your calendar and unread mail when Google is connected. A service that is not connected is reported as **not connected**. |
| "Prepare responses to messages that need attention. Let me review them before sending." | Pandesh creates **Gmail drafts**. Every draft is bound to a digest of its content, and sending it needs a separate approval that re-reads the live draft first. Nothing is ever sent unreviewed. |
| "Remind me to follow up if I haven't received a reply." | A **commitment** is recorded — a promise with a condition, not a timer. Pandesh checks the thread, closes the promise when a reply really arrives, and reports it to you at most once a day. It never sends anything on your behalf. |
| "Continue the work we discussed yesterday and tell me what remains." | The objective, the success conditions, the blocker and the next action live in a durable **task record**, so they survive a restart and a change of surface. |
| "Remember that I prefer…" | A durable **memory** with its source and scope. Writing one needs your approval; recalling one never does. |
| "Build me a small app" / "Fix this repository" | The request goes to the real workspace with real file writes, real checks and real artifacts. Consequential steps ask for approval first. |

---

## What works

**Verified in this build.**

- Local chat against a local Ollama model, with a persistent, searchable conversation rail.
- The Home attention cards and the truthful daily briefing.
- The **daily brief routine** — it only exists if you ask for it (Home → "Daily brief"). Durable,
  delivered exactly once per occurrence through a database-enforced ledger, read-only, switchable.
- **Durable memory**: scoped, provenance-aware, redacted, with contradiction detection.
  A write is a governed mutation and needs approval.
- **Commitments** and the follow-up check that reads the real thread.
- **Task records**: objective, success conditions, evidence, blocker and next action. Core creates the
  record when your request starts, so it survives an interruption even if the assistant never got to
  describe it. A task cannot be marked *satisfied* without evidence.
- **Evidence-gated completion**: a turn whose action was refused (declined approval, unconnected
  service, missing permission) does not become a completed task, and the reply says so.
- **Gmail**: search, read a thread, create a draft, send a draft (digest-bound, re-verified).
- **Google Calendar**: list, draft, create, update and delete events, each write bound to the live
  event's etag and re-read afterwards to confirm.
- **Browser work**: a real headless Edge/Chrome driven over CDP, inside the workspace only.
- **Web research**: real sources, fetched and validated, behind an approval.
- **Files and documents**: find, read, write, organize and generate inside the authorized
  workspace; artifacts are registered with a SHA-256 and can be opened from the result card.
- **Image generation** through the local Image Studio, when that service is running.
- **Voice**: push-to-talk with local Whisper, Piper text-to-speech, and a wake word — all local.
- **The phone**: pair a phone over the LAN; it sees the same conversations, approvals and results.
- **Windows packaging**: portable tree and a per-user installer.

## What is limited

Honest boundaries, not bugs to be discovered later.

- **Google needs your own OAuth client.** Until it is imported, mail and calendar are reported as
  not connected and every other capability still works.
- **The installer is unsigned.** SmartScreen warns; the digest sidecar is the way to check it.
- **Voice depends on the machine.** Whisper and Piper run locally; whether the physical
  microphone and speaker path works is a property of your hardware and must be verified on the
  machine you install it on.
- **The Core is local.** The paired phone connects over your LAN. The Core is not exposed to the
  internet, and remote access from outside your network is not supported.
- **Hermes** (the specialist engine) needs a local Hermes service on `127.0.0.1:8642`; without it
  Pandesh routes the work to its own agent or to OpenCode.
- **Image generation** needs the local Image Studio service.
- **OpenRouter cloud submission is paused.** Local Ollama is the only model path.

## What is not in this build

- **No unattended sending.** Mail, calendar changes, deletions and durable memory writes always
  need a human decision.
- **WhatsApp and Printer** are registered connectors with no live adapter yet: they report
  "not implemented" rather than pretending to work.
- **No internet-exposed Core**, no cloud fallback, no automatic merge.

---

## Where things live

| Path | What it is |
|---|---|
| `%LOCALAPPDATA%\KarkeDikha\desktop` | Your settings, paired phones, encrypted credentials, host logs |
| `%LOCALAPPDATA%\KarkeDikha` | The Core database, conversations, tasks, memory, commitments |
| `dist\Pandesh-Setup.exe` | The Windows alpha installer |
| `dist\Pandesh-Setup.exe.sha256` | Its SHA-256 |
| `dist\pandesh-installer-manifest.json` | Build metadata, digests and the install identity |

## Troubleshooting

**"Gmail is not connected."** Expected until you complete the Google setup above. The exact reason
(with the real API error) is shown in Connections → Google Services.

**A task shows as failed even though the assistant replied.** That is the point: the work did not
happen — an approval was declined, a service was unreachable — and Pandesh says so rather than
reporting a success it cannot back.

**The model answers slowly at first.** The local model is loaded on demand. Pandesh keeps the model
resident between turns, and gives interactive chat priority over background work.

## Verifying the build

```powershell
node scripts/check-ai-os-docs.mjs --strict
npx vitest run apps/desktop/test
npx vitest run core/test
```

The platform's own state of truth lives in [AI_OS_STATE.md](../../AI_OS_STATE.md) and
[HANDOFF.md](../../HANDOFF.md).
