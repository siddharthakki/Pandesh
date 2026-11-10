# Pandesh UI v2 — alpha walkthrough

Branch `feat/pandesh-ui-v2` (local, not pushed). Everything below was exercised in the isolated test app on 2026-11-08 with `gemma4:12b`; screenshots are in `acceptance-*/`.

## Launch

Use a **separate data folder** for the review. Without `KARKEDIKHA_DESKTOP_DATA_DIR`, `launch.mjs` uses your real profile (`%LOCALAPPDATA%\KarkeDikha\desktop`). This branch adds Core migrations 48–50, so that would upgrade the database your installed Pandesh uses.

PowerShell, from `D:\Projects\Pandesh-ui-v2-implementation`:

```powershell
$env:KARKEDIKHA_DESKTOP_DATA_DIR = "D:\PandeshAlpha\profile"   # any empty folder
$env:KARKEDIKHA_MODEL_ROUTING_POLICY = "local-only"
node esbuild.core.js            # Core is only rebuilt when out-core\core.js is missing — run after pulling changes
node apps\desktop\launch.mjs    # builds main, preload and the v2 bundle, then starts the app
```

- Starts in **Classic** (the default). Tray icon → **Switch to the new interface (v2)**.
- Or pin v2 for the session: `$env:PANDESH_UI_V2 = "1"` before launching (`0` pins Classic). While pinned, the tray item is disabled and says so.

## Switching

| From | How |
|---|---|
| Classic → v2 | Tray → "Switch to the new interface (v2)" |
| v2 → Classic | Tray → "Switch to the Classic interface", or System → "Use the Classic UI", or Ctrl K → "Use the Classic UI" |

The choice is saved (`host-preferences.json` → `uiVariant`) and the window reloads. Classic keeps working unchanged.

## Tour (what is real)

1. **Chat (home).** Pick a folder, then ask. Answers render Markdown (lists, code, tables, links that open in your browser). The running row shows Core's step and an elapsed time counted from Core's start. Stop cancels for real. Approvals appear inline, in plain words.
2. **Delegation.** Say "Ask the coding agent to …" or "Ask the research agent to …". Pandesh hands the task to that agent, waits, and reports back, naming the agent.
   - The agent's own task is a separate chat ("Coding · …") and a Board card.
   - Research asks you in this chat before it goes online.
   - Any approval the agent needs (for example running tests) also appears in this chat.
   - Coding has no internet; Core refuses and records it.
3. **Activity panel** (opens beside the chat). Every step Core recorded:
   - Repeated steps fold ("read file × 3").
   - Commands show the exit code, duration and test counts taken from the runner's own summary line; the output sits behind an expander.
   - File changes show a diff.
4. **Board.** Needs you / Running / Queued / Blocked / Completed / Failed or stopped, all from Core task records. Running means a worker holds the task right now.
5. **Team.** Six agents. Each shows what it may do (tools, folders, memory, internet), its runs, and its refusals with Core's reason. You can only tighten an agent. "Delegate to …" starts a delegation from your latest task.
6. **Spaces.**
   - Second Brain: search, timeline and graph of real memories, with correct and forget.
   - Projects.
   - Wish to Reality: read-only.
   - Social Studio: drafts plus approve, revise or reject; nothing is ever published.
   - Media Studio: the real Image Studio, ComfyUI and Ollama status.
   - Automations: routines with Run now, Pause and Resume.
7. **System.**
   - Software & Services: read-only inventory and update discovery; nothing is installed.
   - Tools, Skills & MCP hub, from the existing registries.
   - Processes Pandesh started (identity-checked).
   - Theme.
   - Use the Classic UI.
8. **Voice.** The mic button in the composer uses the local capture, Whisper and Piper stack.
   - Speak replies is in the route popover.
   - Stop speaking interrupts playback.
   - Stop listening discards what was captured.
   - The wake word ("Hey Jarvis") starts a voice turn on any view. The route popover says what it is really doing (listening, paused, muted or why it is not listening) and has Mute and Turn off.

## Known limits for this alpha

- Voice has not been tested with a person speaking into the microphone (capture opening was verified).
- The wake word was only in Classic until 2026-11-10. v2 now listens for it too, but only a synthetic voice has been checked, not a person speaking.
- Per-agent internet choices are: none, ask, or a domain list. There is no per-agent setting UI beyond tightening.
- No MCP registry, no embedded terminal or VS Code windows, no software update execution, still Electron 33. These are separate follow-ups.
- Fonts are the Windows system fonts.
