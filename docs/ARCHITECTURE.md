# Design and architecture notes

Pandesh combines a local-first model connector with a governed agent execution runtime. The historical source tree currently lives in a **private** repository; this is a public overview, not a claim that all modules are available here already.

## Components

- **Windows desktop UI:** Electron-hosted Panda assistant, conversation history and context-specific tasks/results.
- **Core service:** Coordinates durable conversations, memory, approvals, task records and scheduling.
- **Model/provider layer:** Primarily local Ollama; optional supported providers depend on configuration and consent.
- **Execution adapters:** Optional external coding/agent runtimes, including Pi-related libraries, OpenCode and Hermes integrations.
- **Client surfaces:** Desktop, VS Code extension and paired mobile experience share the platform to the extent supported by the current release.
- **Safety controls:** Explicit action boundaries and approval decisions, including restrictions on terminating unrelated processes.

## Trust boundaries

1. A model proposal is not permission to execute.
2. An approval is not proof of a successful action.
3. Completed tasks need observable evidence and durable records.
4. External connectors have independent permissions, privacy boundaries and terms.
5. Repository code from public contributors must be treated as untrusted input.

## Scope

The [v0.1.1 alpha](https://github.com/siddharthakki/Pandesh_Releases/releases/tag/v0.1.1-pandesh-alpha) is an early public release. The release report cites isolated Windows Sandbox acceptance and real local-model acceptance; they do not prove all workflows on all hardware.

Full module maps, development and test commands will be finalized after the source snapshot is imported and independently rebuilt.
