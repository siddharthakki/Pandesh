# Pandesh roadmap

## Release status

| Use | Status (2026-11-09) |
|---|---|
| **Supervised daily use** (you approve each consequential action) | Ready for alpha users who run from source |
| **Unattended low-risk work** (read-only checks, scheduled reports) | Not yet. Needs the regression watchdog and a packaged release on a supported Electron. |
| **Unattended consequential work** (writing, running, sending, spending) | Not safe yet |

The last published installers (Build 144 and earlier) predate v2. No v2 installer has been released.

## Done in v2

- New React interface with a Classic fallback, switchable at runtime
- Chief Agent with real specialist delegation (Coding, Research, Personal, Operations), scoped tools and folders
- Visual execution: live activity with commands, exit codes and test output; Board from Core records
- Second Brain: remember, recall, correct and forget with provenance, history and search
- Projects, Automations, Tools & Skills hub, Software & Services inventory (read-only)
- Coding engines: Aider (local) and OpenCode (optional), with output checks and re-run-after-fix
- Core egress default-deny, fail-closed approvals, permission modes (Ask / Auto / Plan Only)
- Security parser fixes (pdfjs-dist 6.2.108, xmldom 0.8.15)

## Next

1. **Release blockers:** upgrade Electron 33 to a supported major; restore bundled fonts; clean packaged build and
   startup test; migration and backup check.
2. **Regression watchdog:** a scheduled run of the real-world scenarios against an isolated profile, compared with the
   previous run.
3. **AI Radar:** native tracking of local models, inference engines and agent tools, compared against what is installed
   and what Pandesh already does.
4. **Revenue team pilot:** activate the Sales, Marketing and Social Media agents for drafting and research only. Every
   outreach or publish needs approval.
5. **One daily briefing** covering reliability, radar findings and business work.

## Later

- Human-tested voice and wake word in v2
- MCP server registry and embedded terminals
- Enforce agent memory scopes on recall
