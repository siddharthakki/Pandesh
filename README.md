<div align="center">

# Pandesh

**A local-first AI operator for Windows.**

Talk to your computer. Hand work to specialist agents. Build, research, remember and organise with local models,
and keep explicit control over every file, command and web request.

[![CI](https://github.com/siddharthakki/Pandesh/actions/workflows/ci.yml/badge.svg)](https://github.com/siddharthakki/Pandesh/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-2f8f7c.svg)](LICENSE)
![Status: supervised alpha](https://img.shields.io/badge/status-supervised%20alpha-c27b1a.svg)

[Install](#run-it-from-source) · [Architecture](docs/ARCHITECTURE.md) · [Demos](docs/media/README.md) · [Roadmap](docs/ROADMAP.md) · [Security](SECURITY.md)

<img src="docs/media/pandesh-demo.gif" width="860" alt="Pandesh v2: the Coding specialist runs failing tests, asks before running them, fixes the bug and re-runs them until they pass">

<sub>Real run, sped up: Pandesh asks the Coding specialist to fix a failing project. It asks before running the tests, shows the real failure, fixes the bug and re-runs the tests to green. Local <code>gemma4:12b</code>, isolated demo profile.</sub>

</div>

## What Pandesh is

Pandesh is a desktop assistant that does work on your PC rather than only chatting about it. A **Chief Agent** reads your
request and either answers it or hands it to a specialist (**Coding**, **Research**, **Personal**, **Operations**), each
limited to its own tools and folders. Everything runs through **Pandesh Core**, a local service that decides what may
happen, asks you before anything consequential and records what really happened, so a reply can't claim success that
the tool ledger doesn't show.

Models run locally through [Ollama](https://ollama.com). Nothing goes to the internet unless you approve it, and then
only a public query, never your files.

## What works today

These run in the current build and are covered by recorded runs or screenshots in [`docs/media`](docs/media/README.md).

| | |
|---|---|
| **Specialist delegation** | "Ask the Coding specialist to…" is routed by Core to the Coding agent, which works with its own tool set and reports back. Its approval requests show up in your chat. |
| **Coding with real verification** | Writes files, runs your tests (after you approve the exact command), fixes failures and re-runs them. Core checks written files, attributes results, and flags suggested commands that can't work. Aider is available as a local coding engine; OpenCode is optional. |
| **Research with sources** | The Research agent asks once for internet access, searches public sources and returns citations. Private text is stripped from public queries. |
| **Second Brain** | Remember, recall in another chat, correct, and forget a single detail. Every fact keeps its source and history, and you can search it all in one place. |
| **Board and Activity** | Task status read from Core records (needs you / running / completed / failed), plus a live activity panel with commands, exit codes and test output. |
| **Team and permissions** | Each agent's tools, folders, network access and "always asks" actions, read from the same rules Core enforces. |
| **Tools & Skills** | 169 tools and 25 governed capabilities, each with its risk level, which agents may use it, and a capability self-test. |
| **Software & Services** | Read-only inventory of installed tools, ports, local repositories and available updates. It never installs anything. |
| **Reliability watchdog** | Every two days at 04:00 it runs the test suites plus five live scenarios on an isolated profile, compares with the last run, and tells you only what changed. See [docs/WATCHDOG.md](docs/WATCHDOG.md). |
| **AI Radar** | Official releases and security advisories of local-AI tools (Ollama, llama.cpp, Aider, OpenCode, Qwen Code, MCP …) compared with what is installed here and with what Pandesh already does. Investigate, prepare an update, or dismiss; nothing installs itself. |
| **Revenue team** | Sales, Marketing, Social Media and a Reviewer research public leads, write offers and drafts, and check them. Nothing is sent: drafts wait for your approval, and only you record responses, orders and money. |
| **One morning briefing** | Calendar, mail and decisions, plus a short "Pandesh at work" section with only what changed in the watchdog, AI Radar and revenue pipeline. |
| **Classic UI** | The previous interface is still there; switch from the tray or the System menu. |

### Experimental or not yet verified

- **Voice**: the microphone opens and local speech engines (Whisper, Piper, Pocket TTS) are wired up, but speaking to Pandesh hasn't been tested by a human yet. The wake word only works in the Classic UI.
- **Customer Support agent** is still a placeholder. The revenue agents draft and research only; they cannot send, publish or spend.
- **Unattended work**: approvals stay on by default. See [release status](docs/ROADMAP.md#release-status).
- Models vary from run to run. In the recorded demos the build-an-app task succeeded in 2 of 3 attempts with `gemma4:12b`, and the failed attempt was reported as a failure ([notes](docs/media/README.md)).

## Screenshots

<table>
<tr>
<td width="50%"><img src="docs/media/screenshots/01-coding-delegation-result.png" alt="Coding specialist built a tip calculator; activity panel shows the real command and exit code"><br><sub><b>Coding delegation:</b> files written, tests run, program executed. Exit code from Core's ledger.</sub></td>
<td width="50%"><img src="docs/media/screenshots/02-approval-card.png" alt="Approval card for running python -m unittest in the project folder"><br><sub><b>Approval cards:</b> nothing runs until you choose, and Core records the decision.</sub></td>
</tr>
<tr>
<td><img src="docs/media/screenshots/04-research-with-citation.png" alt="Research specialist result with version, date and source link"><br><sub><b>Research:</b> latest Ollama release with its source (checked independently: correct).</sub></td>
<td><img src="docs/media/screenshots/05-second-brain-provenance.png" alt="Second Brain memory detail with source and history including forgotten values"><br><sub><b>Second Brain:</b> source, history and forgotten values, with correct and forget actions.</sub></td>
</tr>
<tr>
<td><img src="docs/media/screenshots/06-team-agent-permissions.png" alt="Team view showing the Coding agent's tools, never-allowed tools, folders and network policy"><br><sub><b>Team:</b> what each agent may do, never do, and always has to ask.</sub></td>
<td><img src="docs/media/screenshots/07-board-real-status.png" alt="Board with completed and failed tasks from Core records"><br><sub><b>Board:</b> real task status, failures included.</sub></td>
</tr>
</table>

More: [all screenshots and recorded demos](docs/media/README.md).

## Architecture

<img src="docs/media/architecture.svg" alt="You → Pandesh Desktop → Pandesh Core (Chief Agent, approvals, agent scopes, tool ledger, claim guards, memory) → specialists, local models, tools and consented internet → verified result" width="100%">

The model proposes and Core decides. Core is a local Node service bound to `127.0.0.1` with a SQLite database. It owns
permission modes and approvals, each agent's scope (tools, folders, network), the tool ledger, output checks on written
files, and the final verdict for each turn. The desktop app is a client of Core: the v2 interface (React) and the
Classic interface both read the same records. More in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

**Privacy:** conversations, memory, projects and task records stay in your profile folder. Network access is denied
by default per agent. Web research needs your consent and sends only a derived public query. There's no silent
fallback to paid cloud models; cloud providers are opt-in and off by default.

## Run it from source

Tested on Windows 11 with Node.js 24 from a fresh clone (2026-11-09).

**Prerequisites:** Windows 10/11 · [Node.js 24](https://nodejs.org) · [Git](https://git-scm.com) · [Ollama](https://ollama.com/download) · Python 3 (optional, for the coding demos)

```powershell
git clone https://github.com/siddharthakki/Pandesh.git
cd Pandesh
npm ci
cd apps\desktop; npm ci; cd ..\..
node esbuild.core.js

ollama pull gemma4:12b          # fast default; qwen3.8:27b is used for heavier work when installed

# Use a separate data folder. Without it Pandesh uses (and migrates) your normal profile.
$env:KARKEDIKHA_DESKTOP_DATA_DIR = "$env:USERPROFILE\PandeshDev"
$env:PANDESH_UI_V2 = "1"        # 1 = new interface, 0 = Classic
node apps\desktop\launch.mjs
```

Run the tests:

```powershell
npx vitest run core/test          # Core: about 2,600 tests
npx vitest run apps/desktop/test  # Desktop: about 620 tests
```

GitHub CI runs the same checks on `windows-latest`; seven timing-sensitive Core test files (listed in
[`ci.yml`](.github/workflows/ci.yml)) run there in a separate, non-blocking job because shared runners are too slow
for their time windows. The [watchdog](docs/WATCHDOG.md) runs the full suite locally.

Real-speech and local-TTS tests are skipped unless their models are staged (`node scripts/fetch-whisper-model.mjs`,
`node scripts/fetch-piper.mjs`).

**Hardware:** the demos ran on an RTX 3090 (24 GB). `gemma4:12b` needs about 10 GB of VRAM; `qwen3.8:27b` about 20 GB.

**Known limitations:** packaged v2 installers aren't published yet (the desktop app runs on Electron 45). See [docs/ROADMAP.md](docs/ROADMAP.md).

## Project

- [Contributing](CONTRIBUTING.md) · [Security policy](SECURITY.md) (report vulnerabilities privately) · [Support](SUPPORT.md) · [Code of conduct](CODE_OF_CONDUCT.md)
- License: [MIT](LICENSE)
- Built with Ollama, Electron, React, the Pi agent core, Aider and OpenCode. No affiliation with those projects is implied.
