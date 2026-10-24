# Privacy, safety and local AI

Pandesh is intended to run a large part of your AI assistant workflow **locally on your Windows PC**, with your approval for consequential actions.

## Local model use

When configured to use **Ollama** at a local endpoint (typically `127.0.0.1:11434`), model inference happens through your own local runtime. Other separately configured providers may have different privacy policies or network behavior.

## Connected services

Gmail, Google Calendar, web search, cloud providers and other services can require internet access and external authorization. Do not infer that **everything** stays on-device merely because a local model is enabled. Each integration should disclose the permissions it requests and report denied requests accurately.

## Memory and durable tasks

Pandesh stores selected conversation, task, schedule and memory information in local application data. Treat exported logs, ZIP files, SQLite databases, screenshots and support bundles as potentially sensitive. Do not upload them to public GitHub issues.

## Action safety

- For destructive/system-affecting operations, explicit approval and evidence-backed outcomes matter.
- The agent must not arbitrarily terminate unrelated processes.
- Approval for one file or action does not grant blanket permission for another.
- The assistant should state when it **cannot** access the relevant source, rather than fabricate a successful result.

## Community and security reports

Share only synthetic test data or carefully redacted screenshots. Remove credentials, email contents, local user paths, API endpoints that identify private resources, and any authorization tokens. For security vulnerabilities see [SECURITY.md](../SECURITY.md).

**Alpha limitation:** v0.1.1 is experimental and not a hardened operating-system sandbox. Back up important data and review every consequential action.
