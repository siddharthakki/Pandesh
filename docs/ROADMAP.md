# Pandesh roadmap

## Release status

| Use | Status (2026-11-09) |
|---|---|
| **Supervised daily use** (you approve each consequential action) | Ready for alpha users who run from source |
| **Unattended low-risk work** (read-only checks, scheduled reports) | Ready in source builds: the watchdog, AI Radar and briefing run on schedule and only report. Not yet in a packaged release. |
| **Unattended consequential work** (writing, running, sending, spending) | Not safe yet |

The last published installers (Build 144 and earlier) predate v2. No v2 installer has been released.

## Done in v2

- New React interface; the Classic interface was retired once v2 had what was still useful from it
- Chief Agent with real specialist delegation (Coding, Research, Personal, Operations), scoped tools and folders
- Visual execution: live activity with commands, exit codes and test output; Board from Core records
- Second Brain: remember, recall, correct and forget with provenance, history and search
- Projects, Automations, Tools & Skills hub, Software & Services inventory (read-only)
- Coding engines: Aider (local) and OpenCode (optional), with output checks and re-run-after-fix
- Core egress default-deny, fail-closed approvals, permission modes (Ask / Auto / Plan Only)
- Security parser fixes (pdfjs-dist 6.2.108, xmldom 0.8.15)
- Electron 33 (end-of-life) → 45.2.3; GitHub-hosted CI
- Reliability watchdog, AI Radar, revenue team (Sales, Marketing, Social Media, Reviewer) and the unified morning briefing
- Agent memory scopes enforced on recall; each conversation's capability anchor is settled when its turn ends

## Next

1. **Release:** packaged v2 installer on Electron 45 with upgrade/rollback test against a copy of a real profile.
2. **Revenue pilot results:** owner decisions on the first drafts; measure responses and orders only from recorded evidence.

## Later

- MCP server registry and embedded terminals
