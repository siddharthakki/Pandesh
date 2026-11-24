# Pandesh

Windows 11, PowerShell primary. Work tracker (git-excluded): `WORK_TRACKER.md` — read it first for current state.

## Commands
- Typecheck: `npm run compile` (extension), `npm run typecheck:webview-v2`
- Tests: `npm test` (heap wrapper around vitest). The Core suite loads the real Ollama 27B; use a dead `KARKEDIKHA_OLLAMA_URL` on branches cut before PR #61.
- Docs check: `node scripts/check-ai-os-docs.mjs`
- Secrets: `npm run secrets:scan:staged` before committing

## Production safety (hard rules)
- Never use port 3030 or the production profile for scratch work. Scratch instances: `D:\PandeshP0Dev\safe-launch.mjs` only (3991/3992/9481), stop by pid.
- No production restart unless Core is idle and there was no user message in the last 5 minutes.
- Never write HKCU or Run keys from the agent shell. Never `gh pr merge --admin` without the owner's explicit OK naming the PRs.
- Ask before using cloud models; never give up on a task by switching to a weaker path.
- Business data stays local.

## Shell quirks on this PC
- Heredocs and `python -c` with quotes/backslashes fail or silently do nothing. Write scripts to a file and run them.
- Check `tsc` and bundle time before a live run.

## Workflow
- Feature work in worktrees/branches; open PRs, do not merge to `main` unasked.
- Prefer evidence (test output, screenshots) over claiming PASS.
- Background routines (anything on a timer or a poll: reminders, automations, worker reports, nightly maintenance) must be idempotent and bounded. Each one needs: a stable id for the event it acts on, a "done" record written in the same transaction as the effect and looked up in its stored form, a retry limit, and a failure state that stops it. Test it by running the tick hundreds of times and across a restart with nothing changed: nothing may be written. (2026-11-24: a report key that lost a trailing space posted one message every 5 s, 30,163 times.)
- Known flaky CI tests: missionRepair "bounded repair, then commits", conversationRelevanceSequence "operator declines". Re-run before judging.
