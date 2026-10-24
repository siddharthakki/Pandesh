# Pandesh roadmap

Pandesh is a **local-first AI personal assistant**: useful everyday outcomes first, powerful extensibility second. This public roadmap is intentionally concise. It distinguishes what has shipped, what is being fixed and what is exploratory.

## Release status

| Stage | State | Real user outcome |
| --- | --- | --- |
| **v0.1.1 Alpha · Build 142** | **Public download available** | Install on Windows, talk to local Ollama, use supported governed workflows |
| **v0.1.2 Alpha · Build 143** | **Development / acceptance reported; not a public binary here yet** | More reliable New Conversation actions, direct Tasks/Results navigation |
| **Next stabilization release** | **Planned, no committed date** | Correct model self-awareness, trustworthy task outcomes, reliable day-to-day routines |
| **Broader open-source source distribution** | **Blocked by publication checks** | Reproducible build of reviewed Core, Desktop and supporting code |

## Priority 0 — everyday reliability

- [ ] New conversation always opens a genuinely blank conversation; older completions never bleed into new context.
- [ ] Both **New** buttons work in the installed Windows build; background tasks retain their own IDs.
- [ ] Results are reachable in one click, with approvals still actionable.
- [ ] Pandesh correctly identifies its **active model** and lists **available Ollama models** through the runtime rather than guessing or telling users to run commands.
- [ ] Improve Gmail and Calendar permission states: no misleading claims if a search or follow-up is blocked.
- [ ] Prevent duplicate briefings, stale reminders, phantom running tasks, and incomplete recovery after restart.
- [ ] Verify no unrelated Windows process is stopped by Pandesh.

## Priority 1 — publish trustworthy open source

- [x] Publish public MIT license, security policy, contribution guidelines and releases.
- [x] Replace the self-hosted PR CI dependency with GitHub-hosted checks.
- [ ] Replace static development service credentials; scan reviewed files and history privately.
- [ ] Review artwork, icons, models and bundled dependency licenses.
- [ ] Publish a fresh, sanitized **buildable** source snapshot for Core, Desktop and extension with reproducible build instructions.
- [ ] Verify packaged behavior against source and preserve version/build provenance.
- [ ] Establish public issue triage, labels, onboarding docs and redacted bug-report examples.

## Priority 2 — usable personal AI assistant

- [ ] Dependable daily briefing, calendar, email and follow-up workflows with correct authorization.
- [ ] Scheduling and commitment follow-ups that survive restarts and clearly state when external access is unavailable.
- [ ] Faster model routing based on locally installed hardware and actual capabilities; avoid unnecessary capability refusals.
- [ ] One consistent context and task history across supported desktop and VS Code experiences.
- [ ] Accessible compact Panda interface with on-demand panels rather than a large dashboard.

## Exploratory / longer-term

- Securely paired mobile use outside the home network
- Better voice interaction and interruption/recovery
- Multimodal tools, document understanding and image generation through supported local tooling
- Reusable skill/capability plugins and optional specialist agent engines
- Community-supported platforms and installers beyond Windows

Exploratory items are **not promised features or release dates**.

## What counts as complete?

A task is complete when its observable outcome works in an installed application on representative hardware. A green unit test, mock screenshot or model-generated "Done!" message is insufficient by itself.

[Report a real-world problem](https://github.com/siddharthakki/Pandesh_Releases/issues) · [Download alpha](https://github.com/siddharthakki/Pandesh_Releases/releases/tag/v0.1.1-pandesh-alpha) · [Architecture](ARCHITECTURE.md)
