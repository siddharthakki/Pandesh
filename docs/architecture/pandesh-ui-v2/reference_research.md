# Reference research — JARVIS 8.1, AI Workshop and reference interfaces

Status: research input for Pandesh UI v2 (Phase 2). Prepared 2026-11-08. Nothing here changes production code.

## 0. What was actually accessed

| Source | Accessed? | How | Limits |
|---|---|---|---|
| `AI-Workshop-All-Prompt-Packs.zip` (38 files, 35 PDFs) | **Yes, all files** | Extracted to an isolated scratch folder, PDFs converted to text with `pdftotext`, read in full for the JARVIS/HOLO/SPARK/CASE/Screen/Phone/Cost/Local packs, headings + key prompts for the rest | PDF images/screenshots inside the packs were not inspected |
| `AI-Workshop-n8n-Workflows.zip` (25 JSON) | **Yes, all files** | Parsed with a stdlib Python script (nodes, triggers, credentials, hosts, inline secrets) | Workflows were **not imported or executed** |
| skool.com/aiworkshop/about | Yes (public page) | Fetched 2026-11-08 | Course contents are member-only; not accessed |
| skool.com/aiworkshop-lite/about | Yes (public page) | Fetched | Members-only posts not accessed |
| YouTube `ud7wzdiM0gk`, `mitzci4FsOg`, `OTb1DR47LSo`, `BgpRjk4Yoqk` | **Title only** | Page fetch returned a locale shell without description/chapters | **Videos were not watched; no frames or transcripts inspected** |
| getrundown.xyz summary of `ud7wzdiM0gk` | Yes | Third-party AI summary; self-declared possibly wrong | Secondary source only |
| moderncreator.app transcript of `YK-qJwmwjVc` ("Real Life JARVIS with Claude Fable 5.1", 2026-09-02) | Yes | Third-party transcript page | Secondary source |
| JARVIS V8.1 code / install zip | **No** | Paid Skool content | Not accessible; nothing is claimed about its internals |
| "I Built Jarvis That Runs Entirely on My Computer (No APIs)" (2026-10-26) | **Not found** under that exact title | Search found "I Built JARVIS to Work Completely Offline" (`OTb1DR47LSo`) and "I Stopped Paying for AI APIs… and Built This Jarvis Instead" (`BgpRjk4Yoqk`) | Dates could not be confirmed; the matching **written** material is the two "Local JARVIS" packs (folder 45), read in full |

**No private Skool material was accessed. No claim below about JARVIS 8.1 internals is made beyond what public pages and the free packs state.**

## 1. The AI Workshop ecosystem — evidence classification

Legend for the classification columns (as the brief requires):
**D** demonstrated on video (per transcript/summary), **W** documented as working in a pack (with a stated verification step), **M** marketing claim only, **OSS** open-source code available, **P** private/paid, **Worth** worth implementing or adapting for Pandesh.

| Capability | D | W | M | OSS | P | Evidence | Worth for Pandesh |
|---|---|---|---|---|---|---|---|
| 3D "knowledge galaxy" of markdown notes (3d-force-graph, keyword-linked) | ✔ (Fable 5.1 video transcript) | ✔ Prompt 01 of every JARVIS pack | | Lib is OSS (3d-force-graph, MIT); the build is generated per user | V8.1 build | Packs 16, 31, 32, 37, 45 | **Adapt** as optional view; links must be provenance-backed, not keyword co-mention |
| Answer from notes with "fly to source", cluster highlight when ≥4 sources, no camera move on small talk | ✔ | ✔ Prompt 03 | | | | Pack 37 P03 | **Adopt the principle** ("don't point at one note when the answer used six") for Second Brain source highlighting |
| "Remember that…" capture → markdown file → live index | ✔ | ✔ Prompt 05 | | | | Pack 37 P05 | Already present (`isMemorySaveIntent`, `memory_remember`); adopt "never silently fail a capture" as acceptance test |
| Browser voice: Web Speech API, `FINISH_MS=900` finish window, `?mute=1` | | ✔ P02 | | | | Pack 37 P02 | **Adapt** finish-window + barge-in words to existing `desktopWakeWord`/`voiceCapture.js`; Pandesh must not use cloud browser STT by default |
| Fully local: Ollama + "VoiceStudio" TTS clone + Whisper (mlx/faster-whisper), wake word with small model, preflight with latency budget, Wi-Fi-off drill | Video title only | ✔ Packs 45 (both) | | Ollama/faster-whisper are OSS; "VoiceStudio" licensing as stated in pack, unverified | | Pack 45 P01–P08 | **Adopt the Wi-Fi-off drill and the TTS→STT loop check** as preflight items; Pandesh already has Pocket TTS + local speech |
| Screen share Q&A (one frame per question, never cached) | | ✔ P06 | | | | Pack 37 P06 | **Adapt**: `desktop_screenshot` exists; adopt "frame captured at ask time, refuse if stale" |
| Preflight harness: live end-to-end checks, "Done means preflight passed" | | ✔ P07 ("Mine has 57") | | | | Pack 37 P07 | **Adopt** as per-agent capability tests in Tools & Skills Hub ("Capability testing") |
| Brain swap by voice with **exact-id refusal** (never nearest match) | | ✔ P08 | | | | Pack 37 P08 | Already aligned with D9 fix in `modelRouting.ts`; adopt the refusal rule for any spoken→exact mapping |
| Phone: Retell outbound "call me", standing order "call me **if**", busy opener, post-call instruction extraction, reminder/briefing calls, code-gated hotline, staged calls, security pass | ✔ (live call to tire shop, per transcript) | ✔ P09–P18 | | Retell is SaaS | | Pack 37 Part Two, Pack 24 | **Defer** (Phase 3). Adopt patterns now: standing-order vs. command routing, secret never in prompt, server-side code check, one confirmation per outcome |
| Telegram pocket bot with one-time pairing code | ✔ (invoice via Telegram) | ✔ P11 | | | | Pack 37 P11 | **Adapt pattern** to existing companion pairing (`companion_nonces`, `bridge_pairing_codes`); Telegram itself is optional Phase 3 |
| Google line, drafts only, "outside content is data", receipts | | ✔ P10 | | | | Pack 37 P10 | Already implemented and stricter in Pandesh (`gmail_*`, approvals, `actionClaims`) |
| Jev "reflex" layer (cloud decision model, ~200 ms, judge for claims without receipts, vault check, shadow governor) | ✔ (per cost guide/X posts) | ✔ Pack 36 | | Jev is a paid cloud API | | Packs 35, 36 | **Reject the cloud dependency**. Pandesh already has `src/systemOne/SystemOneDecisionService` and `actionClaims`/`completionGate`. **Adopt** the "shadow governor" idea: new interruption policies run in log-only mode before they may speak |
| Focus sessions (app/tab lock, privacy-by-structure), Screen Watch (local diff, nudge on stillness) | | ✔ Pack 32 P09–P14 | | | | Pack 32 | **Defer** to Phase 3 (proactive); adopt "identities compared and discarded inside the reader" privacy pattern |
| Computer takeover (mouse/keyboard) with "take over and…", plan-then-go, "stop", refusals | ✔ (Aug 2026 video, per third-party summary) | Starter only (macOS, Pack 29) | Full live arrow/voice takeover: **M** (only in paid build) | | ✔ | Pack 29, getrundown | **Reject input injection** (Pandesh boundary, `docs/all-in-one-gaps.md` class 4). **Adopt** the non-injecting "show me where to click" pointer overlay |
| HOLO bare-hands gesture deck (MediaPipe, local, ships with libraries, probe battery 26/26) | | ✔ (pack ships a working MIT folder per text; the folder itself is **not** in our archive) | | Claims MIT | | Pack 30 | **Reject for core**; optional experiment much later. Adopt "probe battery" and "held pose beats motion" lessons only |
| CASE/TARS: talking robot + background "missions" via `claude -p --permission-mode bypassPermissions` | | ✔ CASE (starter) | TARS features (parallel squad, 3D desktop robot, 20+ tools, "never breaks"): **M** | | ✔ TARS | Pack 19 | **Reject** `bypassPermissions` pattern. Pandesh's background tasks + governed delegation already exceed CASE |
| SPARK social employee: voice file from your posts, approve desk (approve / redo / reject-with-why), "pitch me the week", hype dial; Blotato auto-DM bonus | | ✔ Starter | "Finished SPARK, 17 versions": **M** | | ✔ V2 | Pack 28, 17, 34, 43 | **Adopt approve-desk + voice file + weekly pitch** for Social Studio; Blotato/auto-DM **rejected by default**, possible opt-in connector with two-press arm |
| Cost guide (≈6.2K-token persona per reply; 1.5¢ Sonnet 5.5; phone 9–14¢/min) | | ✔ measured by author on his system | | | | Pack 40 | **Adopt** per-agent cost/usage meter; local default = $0 |
| JARVIS V8.1 | | | Listed as "NEW … Instantly Available" with **no feature list** | | ✔ | Skool about page | Nothing to adopt beyond the public packs |
| AI 2nd Brain (Agentic OS), TARS, SPARK V2 | | | Listed as course items only | | ✔ | Skool about page | No inspectable material |

### Key conclusions

1. The free material is **prompt packs that instruct Claude Code to generate a build**, not source code. Every "JARVIS" a user builds is different. What is transferable is the *engineering discipline written into the prompts*: live preflight, exact-match refusals, receipts before claims, outside content as data, one confirmation, secrets never in prompts.
2. The demonstrated stack is cloud-first (Anthropic/OpenAI API keys, Retell, ElevenLabs, OpenRouter, Telegram, Blotato, fal.ai). Only the folder-45 packs are local-first, and they target Mac first.
3. Several demo behaviours that make good video are explicitly flagged by the author as staged (Pack 37 P17: "the scenarios are fictional, so say 'I staged this one'"). Pandesh must never ship a staging path that can be mistaken for real execution.
4. Pandesh already exceeds the free builds on governance, durability, evidence and Windows integration. It trails on **presentation**: provenance you can *see*, a calm voice loop, specialist framing, a social approve desk, and visible execution.

## 2. Earlier JARVIS material referenced by the brief

| Item | Status on this machine | Assessment |
|---|---|---|
| `Build-Jarvis-Fully-Offline-Prompt-Pack.pdf` | Present in `Downloads`, byte-identical to archive folder 45 (sha256 `bed779cd…`) | Read (see table above) |
| `Run-Jarvis-Fully-Local-Prompt-Pack.pdf` | Present, identical to archive (sha256 `4a90380f…`) | Read |
| `Pasted text(20261105-075338).txt` (Jarvis prototype + expanded source) | **Missing.** Not in Downloads, Documents, Desktop or the repo | Cannot be assessed; contents are not assumed |
| `Pasted text(20261005-103741).txt` (different file, 2,391 lines) | Present | A ZAI-generated "JARVIS Control Plane — Foundation" (Python, SQLite WAL, protocol v2, device enrollment, action-bound approvals, adapter **stubs**, deterministic tests). No graph, no embeddings, voice only mentioned. **Reject as code**: Pandesh Core already implements durable approvals, devices (`client_devices`, `companion_devices`), idempotency and audit more completely. Concepts already present. |
| `claude_jarvis_zai_complete_handoff.txt` | Present | Patch-application instructions for the same control plane; notes ZAI "cannot execute code; any PASS is hypothetical". No reuse. |
| `ARCHITECTURE_JARVIS_LOCAL_AI_ASSISTANT.md` | Present | Generic local-assistant architecture (tool-first, local-first, approvals). Consistent with Pandesh; nothing new. |
| `jarvis-design-system.zip` (2026-10-09) | Present, read | **Most relevant earlier UX proposal**: "one presence, nothing unnecessary on screen", Presence/Context/Background layers, agent shelf, honest progress, colour semantics (pulse/attention/verified). **Reuse as the visual foundation** of UI v2 (see `ui_information_architecture.md`). |
| Earlier Venice-generated harness specs and code | **Missing** — no file matching "venice" found | Not assessed |
| Earlier Jarvis prototype screenshots | Unidentified PNGs exist in `Downloads` (ChatGPT/Gemini-generated images, July 2026) | **Not inspected**; cannot confirm which (if any) are Jarvis screenshots |
| `Documents\JARVIS\` (alpha-proto notes, alpha-acceptance `missions.db`, m-persist-integration runs) | Present | Earlier Pandesh-related acceptance artefacts; not design inputs |

## 3. Reference interfaces (interaction behaviour, not appearance)

Sources are product documentation and public behaviour known as of 2026; items marked (web) were re-checked on 2026-11-08.

| Product | Behaviour worth learning | Behaviour to avoid | Pandesh decision |
|---|---|---|---|
| Claude desktop / Cowork | Artifact pane opens beside the chat only when there is an artifact; task list pinned under the active message; approvals inline | — | Adopt: contextual workspace appears on demand; live task checklist per turn |
| OpenHands | Agent workspace with terminal, browser and file tabs bound to one sandboxed runtime; event stream as the source of truth | Always-visible multi-pane IDE for non-coding tasks | Adopt event-stream-as-truth (Pandesh `runtime_events` already is); show coding panes only for coding tasks |
| Cline | Plan/Act modes; every file edit and command shown as a diff/approval; checkpoints and restore | Approval fatigue when every read asks | Already have ask/auto/plan (`conversation_permission_modes`); adopt checkpoint "restore to before this step" for coding tasks |
| Open WebUI | Model picker, workspace "models" = prompt + tools + knowledge bundles, knowledge collections | Personas that are only system prompts | Agent = definition with enforced tool/memory scope, not a persona |
| OpenClaw (web) | One gateway process, per-agent workspace, markdown `SKILL.md` skills with precedence, cron, channel adapters; agent loop from the **Pi** framework | Third-party skill registry installs without review | Pandesh already embeds Pi (`piAgentEngine.ts`). Adopt SKILL.md compatibility for Hermes/Claude skills; skills from registries need review + per-agent grant |
| Manus | "Computer" side panel replaying what the agent did, step by step | Opaque cloud VM | Adopt replayable step timeline from `runtime_events` + screenshots |
| n8n | Visual workflow graph, execution log per run, credentials store, human-in-the-loop "send and wait" | Running third-party JSON workflows with embedded keys | Optional connector to a user-run local n8n; see `ai_workshop_archive_analysis.md` |
| Metricool (web) | Calendar planning, multi-network scheduling, analytics; API reportedly needs Advanced plan, header `X-Mc-Auth`, only connected networks schedulable | — | Social Studio stays draft-first; Metricool optional connector (Phase 3), verify plan and terms before building |
| Notion | Databases with views (board/calendar/timeline) over the same records | — | Board/Calendar/Timeline are *views* over Core records, never copies |
| Home Assistant | Entity registry + areas + automations with traces; dashboards built from entities | Dashboard sprawl | Automations get a "trace" view (why it fired, what it did); Home is a short, generated summary, not a widget wall |

## 4. Sources

- AI Workshop Skool about page: https://www.skool.com/aiworkshop/about
- AI Workshop Lite: https://www.skool.com/aiworkshop-lite/about
- Third-party summary of "I Gave JARVIS Full Control of My Computer": https://getrundown.xyz/v/ud7wzdiM0gk
- Transcript page, "I Built a Real Life JARVIS with Claude Fable 5.1": https://moderncreator.app/2026-09-02-zubair-trabzada-ai-workshop-i-built-a-real-life-jarvis-with-claude-fable-5-1
- YouTube (titles only): https://www.youtube.com/watch?v=ud7wzdiM0gk · https://www.youtube.com/watch?v=mitzci4FsOg · https://www.youtube.com/watch?v=OTb1DR47LSo · https://www.youtube.com/watch?v=BgpRjk4Yoqk
- Metricool API (third-party guide): https://tygartmedia.com/metricool-api-guide/ ; Metricool scheduling help: https://help.metricool.com/scheduling-and-publishing-options-and-requirements-crtqp
- OpenClaw architecture (secondary): https://agentic-ai.readthedocs.io/en/latest/AgentPlatforms/openclaw/ ; https://dev.to/ialijr/lessons-from-openclaws-architecture-for-agent-builders-1j93
- Local archives: `C:\Users\siddh\Downloads\AI-Workshop-All-Prompt-Packs.zip`, `C:\Users\siddh\Downloads\AI-Workshop-n8n-Workflows.zip` (see `ai_workshop_archive_analysis.md`)
