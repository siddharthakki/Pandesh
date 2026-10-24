# Pandesh 🐼 — Local AI Personal Assistant for Windows

**An open-source, local-first AI assistant inspired by the idea of a Jarvis-style desktop companion — powered by Ollama, with explicit controls for real-world actions.**

Looking for a **personal AI assistant for Windows**, an **Ollama desktop assistant**, or a **self-hosted alternative to cloud-only AI assistants**? Pandesh aims to combine local AI conversations, reusable tools, tasks, reminders, and governed automation in one approachable Panda interface.

[**⬇ Download Windows Alpha (Build 143)**](https://github.com/siddharthakki/Pandesh_Releases/releases/tag/v0.1.2-pandesh-alpha) • [**📖 Start here**](https://github.com/siddharthakki/Pandesh_Releases/blob/main/docs/GETTING_STARTED.md) • [**🏗️ Architecture**](docs/ARCHITECTURE.md) • [**🗺️ Roadmap**](docs/ROADMAP.md) • [**🐞 Report an issue**](https://github.com/siddharthakki/Pandesh_Releases/issues)

![Pandesh v0.1.2 Build 143 Panda desktop assistant — updated conversation interface](assets/screenshots/01-welcome-chat.png)

<sub>Actual Pandesh desktop interface from v0.1.2 Build 143.</sub>

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

3. Install [Pandesh v0.1.2 Alpha (Build 143)](https://github.com/siddharthakki/Pandesh_Releases/releases/tag/v0.1.2-pandesh-alpha) or extract the portable ZIP and run its launcher.
4. Start with **"Hi Pandesh. What can you do?"**, then try a specific read-only request.

For verified download checksums, permissions, troubleshooting and the full installation flow, use the [getting-started guide](https://github.com/siddharthakki/Pandesh_Releases/blob/main/docs/GETTING_STARTED.md).

## Building from Source

Pandesh Core is fully buildable independently:

```powershell
# 1. Clone the repository
git clone https://github.com/siddharthakki/Pandesh.git
cd Pandesh

# 2. Install dependencies
npm ci

# 3. Build Core bundle
npm run bundle:core

# 4. Run tests
npm test
```

## Explore the interface

[**See all six screenshots**](docs/SCREENSHOTS.md) • [**View release gallery**](https://github.com/siddharthakki/Pandesh_Releases/blob/main/docs/SHOWCASE.md)

[![Pandesh Tasks and Results — direct Results view, Build 143](assets/screenshots/06-completed-tasks-and-results.png)](docs/SCREENSHOTS.md)

<sub>Build 143 fixes New Conversation navigation and introduces direct Tasks / Results tabs.</sub>

## Architecture and principles

[**Architecture diagram ➔**](docs/ARCHITECTURE.md) • [**Privacy and safety ➔**](docs/PRIVACY.md)

- **Local-first AI:** choose a reachable local Ollama model rather than requiring a paid model subscription for basic chat.
- **Real tool evidence:** explicit tool invocation, observed outcome, and recovery status.
- **Governed execution:** only approved consequential actions; never indiscriminately stop unrelated host processes.
- **Durable continuity:** task, memory and conversation state should survive restarts.
- **Small, purposeful UI:** Panda front and center; show panels when a task requires them.

## Roadmap

Our immediate focus is **reliable conversations, correct model detection, approvals, task results, and useful daily workflows**, not a feature checklist.

[Read the short, prioritized roadmap](docs/ROADMAP.md).

## Source Code & Licensing

**Pandesh Core is published under the MIT License.**

[MIT LICENSE](LICENSE) • [CONTRIBUTING](CONTRIBUTING.md) • [SECURITY](SECURITY.md)

## Trust and contribution safety

Outside developers are welcome to fork and propose improvements. Pull requests are validated in GitHub-hosted CI runners.

[Security policy](SECURITY.md) • [Maintainer protection checklist](docs/MAINTAINER_SECURITY_SETUP.md) • [How contributions work](CONTRIBUTING.md)

## Help build Pandesh

- **[Start contributing](docs/CONTRIBUTOR_START_HERE.md):** fork the project, improve public guides or report real Windows/Ollama behavior.
- **[Good first issue #2](https://github.com/siddharthakki/Pandesh/issues/2):** make first-run Ollama instructions clearer and reproducible.
- **[Good first issue #3](https://github.com/siddharthakki/Pandesh/issues/3):** document actual model compatibility, including what fails.
- **[Support and community](SUPPORT.md):** know where to ask questions, report bugs or help test.

## Community and credits

Found a bug or got Pandesh working with your favorite local model? [Open an issue](https://github.com/siddharthakki/Pandesh_Releases/issues) with the app build and reproducible behavior—never raw private logs.

Built with and/or integrated with independent upstream projects including **Ollama, Pi, Electron, OpenCode and Hermes Agent**. [See acknowledgements and license notes](https://github.com/siddharthakki/Pandesh_Releases/blob/main/THIRD_PARTY_NOTICES.md). No affiliation with the fictional J.A.R.V.I.S. character, Marvel, or those upstream maintainers is implied.

**Downloads:** [Pandesh_Releases](https://github.com/siddharthakki/Pandesh_Releases) • **Public Source:** [Pandesh](https://github.com/siddharthakki/Pandesh).