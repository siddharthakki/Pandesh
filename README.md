# Pandesh 🐼 — Local AI Personal Assistant for Windows

**An open-source, local-first AI assistant inspired by the idea of a Jarvis-style desktop companion — powered by Ollama, with explicit controls for real-world actions.**

Looking for a **personal AI assistant for Windows**, an **Ollama desktop assistant**, or a **self-hosted alternative to cloud-only AI assistants**? Pandesh aims to combine local AI conversations, reusable tools, tasks, reminders, and governed automation in one approachable Panda interface.

[**⬇ Download Windows Alpha**](https://github.com/siddharthakki/Pandesh_Releases/releases/tag/v0.1.1-pandesh-alpha) · [**📖 Start here**](https://github.com/siddharthakki/Pandesh_Releases/blob/main/docs/GETTING_STARTED.md) · [**🏗 Architecture**](docs/ARCHITECTURE.md) · [**🗺 Roadmap**](docs/ROADMAP.md) · [**🐛 Report an issue**](https://github.com/siddharthakki/Pandesh_Releases/issues)

![Pandesh Panda desktop assistant — Build 143 development preview with demo data](https://raw.githubusercontent.com/siddharthakki/Pandesh_Releases/main/assets/screenshots/01-welcome-chat.png)

<sub>Screenshot: v0.1.2 Build 143 development preview. Demo data is illustrative. The currently downloadable release is v0.1.1 Build 142.</sub>

## What is Pandesh?

Pandesh is an experimental **local AI agent and personal assistant** for Windows. Rather than being only a chatbot, its goal is to help with everyday work and show what was actually accomplished. It runs local LLMs through [Ollama](https://ollama.com/) and can integrate additional tools when installed and permitted.

| Experience | What you can expect |
| --- | --- |
| **Chat with local AI** | Use models installed on your own Windows computer |
| **Tasks and results** | Organize work and review outcomes rather than accept unsupported "Done!" claims |
| **Human-approved actions** | Review sensitive/mutating operations before execution |
| **Reminders and briefings** | Scheduled assistant workflows, depending on configured services and permissions |
| **Models and integrations** | Ollama first; other compatible providers and agent integrations are optional |
| **Developer workflows** | VS Code / coding-related capabilities in the evolving shared platform |

**Important:** The public release is an alpha. Not all workflows are reliable or supported on every machine. Gmail, Calendar, external models and web access require their own permissions. Local-first does not mean all configured integrations are offline.

## How to get Pandesh running

1. Download and start [Ollama for Windows](https://ollama.com/download).
2. Open PowerShell, then choose a model:

   ```powershell
   ollama pull qwen2.5-coder:3b
   ollama list
   ```

3. Install [Pandesh v0.1.1 Alpha](https://github.com/siddharthakki/Pandesh_Releases/releases/tag/v0.1.1-pandesh-alpha) or extract the portable ZIP and run its launcher.
4. Start with **“Hi Pandesh. What can you do?”**, then try a specific read-only request.

For verified download checksums, permissions, troubleshooting and the full installation flow, use the [getting-started guide](https://github.com/siddharthakki/Pandesh_Releases/blob/main/docs/GETTING_STARTED.md).

## Explore the interface

[**See all six screenshots**](docs/SCREENSHOTS.md) · [**View release gallery**](https://github.com/siddharthakki/Pandesh_Releases/blob/main/docs/SHOWCASE.md)

[![Pandesh Tasks and Results — direct Results view, Build 143 development preview](https://raw.githubusercontent.com/siddharthakki/Pandesh_Releases/main/assets/screenshots/06-completed-tasks-and-results.png)](docs/SCREENSHOTS.md)

<sub>Tasks & Results shown in a later development build. Screenshots include synthetic content and are not standalone execution evidence. A real walkthrough video has not yet been released.</sub>

## Architecture and principles

[**Architecture diagram →**](docs/ARCHITECTURE.md) · [**Privacy and safety →**](docs/PRIVACY.md)

- **Local-first AI:** choose a reachable local Ollama model rather than requiring a paid model subscription for basic chat.
- **Real tool evidence:** explicit tool invocation, observed outcome, and recovery status.
- **Governed execution:** only approved consequential actions; never indiscriminately stop unrelated host processes.
- **Durable continuity:** task, memory and conversation state should survive restarts.
- **Small, purposeful UI:** Panda front and center; show panels when a task requires them.

## Roadmap

Our immediate focus is **reliable conversations, correct model detection, approvals, task results, and useful daily workflows**, not a feature checklist.

[Read the short, prioritized roadmap](docs/ROADMAP.md).

## Source code publication status

**Pandesh is intended to be MIT-licensed open source.** This public repository currently contains the MIT license, project documentation, contribution templates and publication tooling. **The complete Core and Desktop source are not yet published here.** We're preparing a clean buildable snapshot, fixing a static local integration credential, and auditing third-party assets and history first. We won't upload private historical data or claim a partial snapshot is complete.

[View source-publication gates](docs/OPEN_SOURCE_STATUS.md) · [MIT LICENSE](LICENSE) · [CONTRIBUTING](CONTRIBUTING.md) · [SECURITY](SECURITY.md).

## Community and credits

Found a bug or got Pandesh working with your favorite local model? [Open an issue](https://github.com/siddharthakki/Pandesh_Releases/issues) with the app build and reproducible behavior—never raw private logs.

Built with and/or integrated with independent upstream projects including **Ollama, Pi, Electron, OpenCode and Hermes Agent**. [See acknowledgements and license notes](https://github.com/siddharthakki/Pandesh_Releases/blob/main/THIRD_PARTY_NOTICES.md). No affiliation with the fictional J.A.R.V.I.S. character, Marvel, or those upstream maintainers is implied.

**Downloads:** [Pandesh_Releases](https://github.com/siddharthakki/Pandesh_Releases) · **Source preparation:** [Pandesh](https://github.com/siddharthakki/Pandesh).
