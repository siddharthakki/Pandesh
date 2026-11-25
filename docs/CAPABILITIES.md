# What Pandesh can do (Build 188)

Everything here runs on your PC. "Asks" means an approval card names the exact action and waits for you; an unanswered
card means no. Capabilities marked *read-only* never need a card. Where a recording exists it is linked; the rest are
covered by tests and by the running app. Limits are listed honestly at the end.

| Area | What it does | Asks? | Shown in |
|---|---|---|---|
| Answer questions | Local models through Ollama; Auto picks an installed model per message. Cloud models are opt-in and never a silent fallback. | no | README |
| Direct answers | Free disk space is read from the system tool without loading a model (about 4 s). | no (*read-only*) | [video](media/videos/demo-free-space.mp4) |
| Inspect this PC | Hardware, GPU memory, processes, services, listening ports, installed software, updates, Ollama models. | no (*read-only*) | [disk analysis](media/videos/demo-disk-analysis.mp4) |
| Files in a folder you choose | Read, list, sum a column; write, rename and move inside the folder you approve (Read or Read + Write). | writes, renames, moves | [rename](media/videos/demo-rename-with-approval.mp4) |
| Open an app | Opens an installed application by name; the launch is recorded. | no | tests |
| Reminders and routines | Plain-words reminders and scheduled routines; the desktop alert fires while Pandesh runs. | no for a reminder | [screenshot](media/screenshots/15-reminder-set.png) |
| Coding | The Coding specialist writes files, runs your tests and fixes failures; Claude Code and OpenCode can work as isolated workers on a private copy of a project. A change reaches your checkout only on your approval. | files, commands, delivery | [coding](media/videos/demo-coding-recovery.mp4) |
| Research | Searches public sources after one consent card and returns citations; private text is stripped from the query. | internet access | [research](media/videos/demo-research.mp4) |
| Second Brain | Remember, recall in another chat, correct and forget; every fact keeps its source and history. | changes to memory | [video](media/videos/demo-second-brain.mp4) |
| Background missions | Durable multi-step work with several specialists, an independent Reviewer and a report written from recorded tool calls. | per step | [video](media/videos/demo-background-mission.mp4) |
| Studio | Narrated video, images (ComfyUI), voice (Piper) and a draft upload sheet; nothing is published. | per run | [video](media/videos/demo-bedtime-video.mp4) |
| 3D scenes | Describe a scene; a three.js scene is built on the PC, checked and opened in the Workshop viewer. | no | [screenshot](media/screenshots/24-3d-scene.png) |
| Mail and calendar | Gmail and Google Calendar through connectors you authorize: read, draft, and send only with approval. Without a grant, Pandesh says so instead of guessing. | writes and sends | [screenshot](media/screenshots/21-gmail-honest.png) |
| Phone | Pair a phone over your tailnet to ask, approve and read results (token-gated; nothing is open to the internet). | pairing | tests |
| Voice | Local speech recognition (Whisper) and speech output (Piper). | no | README |
| Work overview | Home, Work and Settings; worker tasks with their execution log under Work. | no | [tour](media/videos/demo-three-places.mp4) |

## Permission modes

**Ask** (default) waits for a card for every consequential action. **Auto** runs only the kinds of work you pre-authorized
for this conversation, for at most 24 hours. **Plan Only** reads and plans and refuses anything that would change something.
Purchases, payments, deleting, installing, `git push` and other network commands always ask.

## Limits you should know

- A live Gmail read, a phone pairing and a 3D scene by a large model are tested but not shown in a recording.
- Model quality varies between runs; a task can fail and will be reported as a failure.
- Auto model choice can fail while Ollama is swapping models; send the message again.
- The installer is not code-signed yet.

See [ARCHITECTURE.md](ARCHITECTURE.md) for how these parts fit together and [PRIVACY.md](PRIVACY.md) for what stays on your PC.
