# External coding agents in Pandesh

Pandesh can hand coding work to other agents. They all work under the **same rules**:

- the selected folder only;
- one approval card per run, which says where the code goes;
- a 6-minute wall-clock limit;
- **Core verifies the result itself** (files on disk, tests that cover the change, file checks), never the agent's own word.

## Integration paths

| Path | How Pandesh drives it | Status |
|---|---|---|
| **Pi** | Pandesh's own engine (`piAgentEngine.ts`); every chat turn | Core of Pandesh |
| **Specialists** (Coding, Research, Operations, Personal) | `delegate_to_agent`: a child task in Pandesh's executor with a narrowed scope | Working; Core security preflight added |
| **OpenCode** | `delegate_to_opencode` (`opencodeEngine.ts`) | Working; 6-minute limit; kept for multi-file work (it wandered on a single-file task) |
| **Hermes** | (a) gateway engine (`hermesEngine.ts`, `127.0.0.1:8642`); (b) **new** `hermes -z <task> --in <dir>` via `delegate_to_coding_agent` | (b) opt-in: it uses *your* Hermes config, which may be cloud |
| **Aider** | **new**, via `delegate_to_coding_agent`, using your local Ollama model | **On by default** (local). Verified live: built a module with tests; Pandesh's own test run passed |
| **Codex CLI** | **new**, `codex exec --oss --local-provider ollama -s workspace-write` | **Off (experimental)**: codex-cli 0.156.1 local mode failed on this PC (qwen: exit 1; gpt-oss:20b: `unsupported call: apply_patch`) |
| **Claude Code** | **new**, `claude -p … --output-format json --permission-mode acceptEdits` | **Off until you enable it**: sends the task and the files it reads to Anthropic's cloud and uses your account. Not run in testing |
| **Cline CLI** | **new**, `cline --json -c <dir> <task>` | **Off until enabled**: cloud by default, and it auto-approves its own commands |

### How a run works
1. **Pick the agent.** The model calls `delegate_to_coding_agent { agent, objective }`. The tool is offered only when at least one agent is installed and enabled, and the Coding specialist can use it too.
2. **Approval card.** It names the agent, the folder and the data flow. Agents that aren't local always ask.
3. **Launch.**
   - The CLI is started with an argument list and no shell, so the task text is never interpreted.
   - `.cmd` shims are quoted, with `%` and newlines neutralised.
   - Aider gets UTF-8 console output, and its history is kept in a temp folder.
4. **After the run**, Core:
   - removes the agent's own housekeeping files (`.aider*`, `.codex*` and the like);
   - reads what changed and runs the tests that cover it;
   - parses each new file, checks its values against real data, and checks that its imports load on this PC;
   - reports NOT DONE when nothing changed.

### Turning agents on or off
`<data folder>\coding-agents.json`:
```json
{ "enabled": { "claude-code": true, "codex": false, "cline": false, "hermes": true, "aider": true } }
```
Defaults: local agents on (Aider). Cloud, configured and experimental agents are off.

## What else could be integrated
| Candidate | Fit | Notes |
|---|---|---|
| **Goose** (Block), `goose run -t` | Good | Local via Ollama; MCP-native; would be one more registry entry |
| **Qwen Code CLI** | Good | OpenAI-compatible, so it can point at local Ollama; strong with Qwen coder models already installed |
| **Gemini CLI** | Cloud | Same opt-in rules as Claude Code |
| **OpenHands** | Heavy | Docker sandbox; better as a long-running "project worker" than a quick sub-agent |
| **Crush / Plandex / gptme** | Possible | CLI one-shot modes exist; add only if the user wants them |
| **MCP servers** | Different layer | Better used as *tools* inside Pi than as sub-agents |

The registry is data (`core/runtime/codingAgents.ts`). Adding an agent is one entry, holding:
- its command and non-interactive arguments;
- where its data goes;
- whether it runs locally.

All governance, verification and reporting are shared.

## Live evidence (2026-11-09, alpha profile, test-operator approvals)
| Run | Agent | Result |
|---|---|---|
| AG1 | Aider | Crashed on the Windows console encoding before saving; only history files appeared and were wrongly counted. Fixed (UTF-8, temp history, housekeeping excluded); Pandesh then wrote the files itself |
| AG1b | Aider | **PASS**: built `stats_tools.py` and its tests in 23 s locally; Pandesh's own unittest run 5/5 OK; nothing extra left in the folder |
| AG2 | n/a | The model's call came back empty, so Core synthesised a confused answer. Fixed: an empty answer is retried once |
| AG2b | Codex, then Aider | Codex failed (exit 1, nothing written; reported NOT DONE). Pandesh fell back to Aider, which built `word_count.py` with 3 tests; Pandesh's run passed |
