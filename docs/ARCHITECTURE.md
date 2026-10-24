# Pandesh architecture

**Local-first, governed AI assistant for Windows.** This is a public architectural overview of the private development implementation and its design direction. It is **not** a claim that the entire application source is already published here or that every adapter is production-ready.

## System overview

```mermaid
flowchart TB
  subgraph UX["User interfaces"]
    W["Panda desktop UI<br/>Electron / Windows"]
    V["VS Code extension<br/>engineering workflows"]
    M["Mobile client<br/>paired / network-dependent"]
  end
  subgraph HOST["Pandesh desktop host / Core"]
    API["Local session and transport APIs"]
    CONTEXT["Conversation and context orchestration"]
    MODEL["Provider selection and model execution"]
    TASK["Durable task orchestration"]
    POLICY{"Permission and<br/>approval checks"}
    TOOLS["Registered tools and adapters"]
    RECORDS[("Local persistence<br/>conversations · tasks · memory<br/>approvals · schedules")]
    EVENTS["Progress, outcomes and evidence"]
  end
  subgraph EXTERNAL["Local models and optional integrations"]
    OLLAMA["Ollama<br/>local models"]
    OPENAI["OpenAI-compatible local server<br/>optional"]
    AGENTS["Pi / OpenCode / Hermes<br/>where installed and configured"]
    CONNECT["Gmail / Calendar / web APIs<br/>explicit service authorization"]
    CLOUD["Optional cloud model providers<br/>user-enabled only"]
  end
  W <--> API
  V <--> API
  M <-. "When connected" .-> API
  API <--> CONTEXT
  CONTEXT <--> MODEL
  CONTEXT --> TASK
  MODEL <--> OLLAMA
  MODEL <-.-> OPENAI
  MODEL <-. "Opt-in" .-> CLOUD
  TASK --> POLICY
  POLICY --> |"Authorized operation"| TOOLS
  TOOLS <--> AGENTS
  TOOLS <-. "Permissioned connector" .-> CONNECT
  CONTEXT <--> RECORDS
  TASK <--> RECORDS
  TASK --> EVENTS
  EVENTS --> API
```

Solid arrows indicate architectural relationships; dashed arrows indicate optional/configuration-dependent paths. This diagram is conceptual, **not** a measured topology of every deployed client.

## Governed task lifecycle

```mermaid
flowchart LR
  U["User intent"] --> C["Plan and resolve context"]
  C --> G{"Action risk / permission"}
  G -->|"Read-only permitted"| EX["Execute tool"]
  G -->|"Sensitive or mutating"| A["Request human approval"]
  A -->|"Approved"| EX
  A -->|"Rejected / expired"| STOP["Record refusal / stop"]
  EX --> E["Observe tool evidence"]
  E --> D{"Verified outcome?"}
  D -->|"Yes"| DONE["Persist result + notify"]
  D -->|"No"| FAIL["Report limitation / recover"]
```

**Invariant:** model text is not proof of execution. Permission to attempt an action is not proof that it completed. A successful user-visible outcome requires evidence from the actual tool or connector.

## Responsibilities

| Component | Responsibility |
| --- | --- |
| Desktop shell | Application lifecycle, UI, sessions and presentation of actions/results |
| Core | Shared task state, conversations, scheduler, permission checks, persistence |
| Model/provider adapter | Request execution against configured Ollama or compatible provider; model availability is runtime-dependent |
| Tool adapter | Mediates file, diagnostics, coding engine and optionally external-service actions |
| Persistence | Local durable state; users must protect local profiles and backups |
| Connectors | Separate authentication and least-privilege source access; failures must be visible |
| Approval system | Human review for consequential external, filesystem, or system actions |

## Important boundaries

- **Local-first does not mean everything is offline.** Model inference through local Ollama can remain on the computer, while optional email, calendar, web and cloud integrations require network access and their own terms.
- **Least authority.** The app must not terminate unrelated host processes; process ownership and identity should be checked before shutdown or port management.
- **Approval isolation.** An operation approved for one scope must not authorize a different scope.
- **Cross-client continuity is a design goal.** Desktop, VS Code and paired mobile behavior must be tested individually; connectivity and network configuration affect availability.
- **Untrusted contributions.** Public pull requests only run on isolated GitHub-hosted CI; no contributor code is executed on a personal self-hosted runner.

## Status against public release

**Available publicly:** [Pandesh v0.1.1 Build 142](https://github.com/siddharthakki/Pandesh_Releases/releases/tag/v0.1.1-pandesh-alpha), a Windows alpha with reported sandbox and local-model acceptance.

**Development-preview UI:** screenshots in [the gallery](SCREENSHOTS.md) show v0.1.2 Build 143, which is not automatically the version in the currently published installer.

**Source availability:** public source publishing is staged pending credential remediation, an audited self-contained source snapshot, third-party notices and a clean build. See [publication gates](OPEN_SOURCE_STATUS.md).

## Further reading

[Roadmap](ROADMAP.md) · [Privacy and safety](PRIVACY.md) · [Screenshots](SCREENSHOTS.md) · [Third-party credits](https://github.com/siddharthakki/Pandesh_Releases/blob/main/THIRD_PARTY_NOTICES.md).
