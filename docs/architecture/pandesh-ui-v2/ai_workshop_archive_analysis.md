# AI Workshop archives — inventory, n8n analysis and Reuse / Adapt / Reject matrix

Inputs (user-provided, untrusted): `C:\Users\siddh\Downloads\AI-Workshop-n8n-Workflows.zip` (241,594 B) and `C:\Users\siddh\Downloads\AI-Workshop-All-Prompt-Packs.zip` (15,375,660 B). Extracted into isolated scratch folders; nothing was imported, installed, executed, or copied into the repository.

## 1. Inventory

**63 files in total**: 25 n8n JSON + 38 prompt-pack files (35 PDF, 2 Markdown, 1 `.skill`).

### 1.1 Duplicates (sha256)

| Duplicate set | Effect |
|---|---|
| `37 JARVIS with Claude Opus 5.5/Build-Your-Own-Jarvis-Opus-5.5-Prompt-Pack.pdf` = `40 JARVIS Sonnet 5.5 Cost Guide/Build-Your-Own-Jarvis-Opus-5.5-Prompt-Pack.pdf` | One unique pack (folder 40 only adds the cost guide) |
| `4. Vibe Coding/01 …/Lead Qualification Voice AI Agent (1).json` = `4. Vibe Coding/02 …/Lead Qualification Voice AI Agent (1).json` | One unique workflow |
| The two folder-45 PDFs are byte-identical to the copies already in `Downloads` | No new information vs. earlier conversation |

Near-duplicates (same Part One "foundation" prompts repeated across editions): packs 16, 31, 32, 36, 37, 41, 42 all rebuild galaxy + brain + voice + butler + preflight before their distinct Part Two.

### 1.2 Prompt packs by theme

| Theme | Files (folder no.) | Unique substance |
|---|---|---|
| JARVIS core (cloud brain) | 16, 31 (Fable 5.1), 32 (GPT-6 Astra), 37/40 (Opus 5.5) | Galaxy, notes Q&A, voice, provenance camera, memory capture, sight, preflight, brain swap; Astra adds focus sessions + screen watch; Opus 5.5 adds phone/Telegram/Google |
| JARVIS local | 45 ×2 | Hardware sizing, Ollama + VoiceStudio + Whisper, wake word, latency-budget preflight, Wi-Fi-off drill |
| JARVIS add-ons | 24 phone, 29 screen, 35/36 Jev reflexes, 41 multilingual, 42 REA reverse engineering, 21 debate show | Call scripts & code-gated receptionist; pointer + takeover (macOS); cloud decision layer; 16 languages; RE kit; entertainment |
| HOLO | 30 | Webcam gestures (MediaPipe), shipped MIT folder (not in archive) |
| CASE / TARS | 19 | Single-file robot + `claude -p` background missions |
| SPARK / social | 28, 17 (+ `brand-voice-template.md`), 34 `social-carousel-SKILL.md`, 43 live carousels | Voice file, approve desk, weekly pitch, carousel generation skill |
| Websites / media (not in scope) | 14, 15, 18, 20, 22, 23 (+ `vox-motion-graphics.skill`), 25–27, 33, 38, 39, 44, `5. Prompts/01` | Prompt craft for 3D sites, Seedance/Higgsfield video, Vox explainers, TV OS. Relevant only to Media Studio prompt presets |

### 1.3 Prerequisites stated by the packs

Claude Code (paid plan), Anthropic API key (most packs), Google Chrome, Python 3; optional OpenRouter, ElevenLabs/OpenAI TTS, Retell (number + per-minute billing), Telegram bot, Google Cloud OAuth client, Blotato (paid), TypeSafe Jev key, Higgsfield/fal.ai keys. Local packs: Ollama, VoiceStudio, mlx-whisper/faster-whisper, ≥16 GB memory (pack's own sizing: ~0.6 GB per B params + 30 % headroom). Screen pack: macOS + Pillow + cliclick/AppleScript.

## 2. n8n workflow analysis (all 25)

All workflows have `active=false`. "Auto-sends" means a node performs an outward action with **no** human-in-the-loop node (no `sendAndWait`, no approval wait).

| # | Workflow | Trigger | LLM / external APIs | Credentials | Data destination | Auto-sends? | Est. cost driver |
|---|---|---|---|---|---|---|---|
| 01 | Gmail labeling (Text Classifier) | Gmail trigger (poll) | OpenAI gpt-4o-mini | gmailOAuth2, openAiApi | Gmail labels | Mutates mailbox (labels) | OpenAI per mail |
| 02 | YouTube → content | Manual | OpenAI gpt-4o-mini ×3, YouTube transcript community node | Salesforce, Gmail, Slack, LinkedIn, Twitter, Facebook Graph, OpenAI | **Posts to LinkedIn/Facebook, X DM, Slack message, Salesforce case comment**, Gmail draft | **Yes — public posts** | OpenAI + community node |
| 03 | SerpAPI agent | Manual chat | OpenAI gpt-4, SerpAPI | openAiApi, serpApi | Chat | No | SerpAPI + gpt-4 |
| 04a/b | Agent with sub-workflow tool (weather) | Chat / executeWorkflow | OpenAI gpt-4 / 4o-mini, OpenWeatherMap, Wikipedia | openAiApi, openWeatherMapApi | Chat | No | Low |
| 05 | Pinecone RAG | Manual + chat | OpenAI embeddings + 4o-mini, Pinecone, Google Drive | Drive, OpenAI, Pinecone | **Drive docs uploaded to Pinecone (cloud vector DB)** | No | Pinecone + embeddings |
| 07 | Calendar via HTTP tool | Manual chat | OpenAI 4o-mini, Google Calendar REST | googleCalendarOAuth2Api, openAiApi | Calendar events | Creates events | Low |
| 08 | Perplexity | Google Sheets trigger | Perplexity API | Sheets OAuth; **inline Perplexity key** | Sheet | No | Perplexity per row |
| 13 | Voice-narrated videos | Chat | OpenAI o3-mini + image (**inline OpenAI project key**), Runway, ElevenLabs | Gmail, httpHeader/Custom, OpenAI | **Emails result** | Yes (email) | Runway video + ElevenLabs (high) |
| 15 | Veo 3 viral videos | Form | OpenAI gpt-4.1, fal.ai queue (Veo 3) | httpHeaderAuth, OpenAI | fal.ai | No | Veo 3 (high, per second of video) |
| 16 | Planet slice ASMR | Form | OpenAI gpt-4.1, fal.ai | as above | fal.ai | No | High |
| 17 | Vectorize Slack (sales RAG) | Slack trigger | OpenAI gpt-4.1-mini, Vectorize.io | Slack ×2, OpenAI | **Slack replies** | Yes (Slack) | Vectorize + OpenAI |
| 18 | NanoBanana free | Form | OpenAI gpt-4o, OpenRouter (Gemini image) | OpenAI, OpenRouter | File | No | OpenRouter image |
| 19 | NanoBanana ad images | Form | chatgpt-4o-latest, gpt-4.1-mini, OpenRouter | Drive, OpenAI, OpenRouter | Drive upload | No | Medium |
| 21 | NanoBanana 2 | Form + chat | Gemini 3 Pro image preview | googlePalmApi | File | No | Gemini image |
| 22 | UGC ad (NanoBanana 2) | Form | GPT-4.1/4o, fal.ai video | Drive, http auth, OpenAI | Drive | No | High (video) |
| V01 | Real-estate lead qualification | Form + webhook | Retell (outbound call), OpenAI summarization | Sheets, httpCustomAuth, OpenAI | **Places phone calls**, Google Sheets | **Yes — outbound calls to form submitters** | Retell per minute |
| V02 | Healthcare check-in voice | Manual + webhook | Retell, OpenAI | Sheets, http, OpenAI | **Calls patients**, Sheets (**health data to Google**) | Yes | Retell |
| V03 | Multilingual voice agent | Webhook | OpenAI 4o-mini | Sheets, OpenAI (HubSpot/Gmail/Slack nodes without stored creds) | HubSpot, Gmail, Slack, Sheets | Yes (email/Slack/CRM) | Low |
| V04 | ElevenLabs consultation | Webhook (+respond) | OpenAI 4.1-mini, SerpAPI, Google Calendar tool | Calendar, OpenAI, SerpAPI | Calendar bookings | Books events | Low–medium |
| V05 | Telnyx voice | Form + webhook | Telnyx (**inline key**), OpenAI, Calendar tool | Calendar, OpenAI | Calls + calendar | Yes | Telnyx per minute |
| V06 | GPT realtime spa upsell | Manual + webhook | Retell, OpenAI | Sheets, http, OpenAI | Calls + Sheets | Yes | Retell |
| VC01 = VC02 | Lead-qualification voice website | Webhook ×2 | Retell, OpenAI | Sheets, http, OpenAI | Calls + Sheets | Yes | Retell |
| VC04 | UGC ad app (Antigravity) | Webhook | GPT-4.1/4o, fal.ai | Gmail, Drive, http, OpenAI | **Emails result**, Drive | Yes (email) | High |

### 2.1 Security findings

1. **Three workflows contain what look like real, non-placeholder API keys inline** in HTTP node parameters (values not reproduced here): Perplexity (`08`, 53 chars, `pplx-…`), OpenAI project key (`13`, 164 chars, `sk-pr…`), Telnyx (`V05`, 58 chars, `KEY01…`). They are almost certainly the author's keys. Treat as exposed third-party secrets: **never import, never use, never commit**; the archive itself should be kept out of any repository or cloud sync.
2. Webhook-triggered voice workflows (`V01`–`V06`, `VC*`) place real phone calls to whatever number arrives in a form/webhook payload, with no rate limit, consent capture or auth on the webhook. Importing them as-is would create an open dialing endpoint.
3. `02` posts publicly to four networks and DMs on X from one manual click, with no review step.
4. `05` and `17` move private documents/Slack history to cloud vector stores (Pinecone, Vectorize).
5. All LLM nodes are OpenAI/Gemini cloud; none use a local model.

### 2.2 Comparison with Pandesh (what already exists)

| Workflow function | Pandesh today | Gap |
|---|---|---|
| Classify & label Gmail | `gmail_analyze_inbox`, `gmail_plan_changes` → approval → `gmail_apply_plan`, `gmail_undo_plan` (local model) | None; Pandesh is stronger (plan, approval, undo) |
| Agent + web search | `governed_research` (cited, egress-approved) | None |
| Sub-workflow as tool | Governed capability dispatch; OpenCode/Hermes delegation | Typed agent-to-agent handoff (see `multi_agent_architecture.md`) |
| RAG over documents | `document_read`, `documentReadGrants`, memory recall (keyword) | Local semantic retrieval (optional, see Second Brain) |
| Calendar booking | `calendar_*` tools with approvals (Google not connected on this PC) | None in design |
| Image/video generation | `comfyui_generate_image` (local, with recovery), `image_generate`, `video_generate`, media production | Prompt presets; async-job panel |
| Voice agents (inbound/outbound phone) | Local wake word, local speech, Pocket TTS; **no telephony** | Telephony is new (Phase 3, opt-in) |
| Social posting / CRM | **None** | Social Studio + Sales agent (draft-first) |
| Slack | None | Optional connector later |

## 3. Reuse / Adapt / Reject matrix

**Reuse** = take the idea/artefact essentially as is. **Adapt** = keep the pattern, re-implement inside Pandesh governance with local defaults. **Reject** = do not bring in.

### 3.1 Prompt-pack material

| Item | Decision | Evidence | Reasoning / Pandesh target |
|---|---|---|---|
| Preflight harness ("Done means preflight passed", one check per real incident) | **Adapt** | Pack 37 P07, 45 P07 | Becomes *Capability testing* in Tools & Skills Hub and per-agent health; Pandesh's acceptance harness already exists — expose a user-runnable subset |
| Wi-Fi-off drill / TTS→STT loop check | **Adapt** | Pack 45 P07–P08 | "Local-only proof" diagnostic: block egress, run voice + chat + memory, show results |
| Exact-id refusal for spoken model names | **Reuse (rule)** | Pack 37 P08 | Same rule as D9; extend to agent names, tool names, contacts |
| Fly-to-source / cluster highlight / no movement on small talk | **Adapt** | Pack 37 P03 | Second Brain "Sources" highlighting, 2D by default |
| Live capture ("remember that") with visible confirmation | **Reuse (acceptance criterion)** | Pack 37 P05 | Exists; add "never silent failure" test |
| Finish window, barge-in words, mute flag | **Adapt** | Pack 37 P02, 45 P03 | Voice agent; uses local Whisper path, not cloud Web Speech |
| Persona in one block | **Adapt** | Pack 37 P04 | Agent definition `instructions` field; versioned |
| Standing order vs. command ("call me" ≠ "call me if") | **Adapt** | Pack 37 P12 | Notification policy: a condition arms a rule, never fires an action |
| Server-side secret check, secret never in prompt | **Reuse (rule)** | Pack 37 P16, P18 | Applies to companion pairing, any future hotline |
| One confirmation per outcome, delivered once (card id dedupe) | **Reuse (rule)** | Pack 37 P14 | `notification_outbox` already dedupes by source; make it a cross-channel invariant |
| Receipts / judge before "done" | **Already implemented** | Pack 36 P09 | `actionClaims.ts`, `completionGate.ts`, `executionClaims.ts` |
| Shadow governor (new interrupt policy logs before it speaks) | **Adapt** | Pack 36 P11 | Proactive Phase 3 policies start in shadow mode |
| Jev cloud reflex model | **Reject** | Pack 35/36 | Paid cloud call on every utterance; local `systemOne` exists |
| Focus sessions, screen watch | **Adapt later** | Pack 32 | Phase 3, opt-in, privacy-by-structure |
| Pointer overlay "where do I click" | **Adapt** | Pack 29 P1 | Non-injecting overlay on a screenshot; useful in Operations agent |
| Mouse/keyboard takeover | **Reject** | Pack 29 P2 | Pandesh boundary: input injection is class 4 (intentionally unsupported) |
| `claude -p --permission-mode bypassPermissions` missions | **Reject** | Pack 19 P03 | Bypasses governance; use Kandev/ACP delegation with Pandesh approvals |
| SPARK voice file, approve desk, weekly pitch, hype dial | **Adapt** | Pack 28 | Social Studio drafts lane; reject-with-reason feeds style memory (scoped to the brand) |
| Blotato auto-DM | **Reject (default)** | Pack 28 bonus | Automated outbound DMs = unsolicited contact; optional connector only with two-press arm and per-automation approval |
| `brand-voice-template.md`, `social-carousel-SKILL.md` | **Reuse after review** | Folder 17, 34 | Markdown skill/templates; import as a reviewed skill into the Social agent scope; license check first |
| `vox-motion-graphics.skill` | **Review later** | Folder 23 | Media Studio; inspect contents before any import |
| HOLO gestures | **Reject (now)** | Pack 30 | Novelty; camera always-on; not on the critical path |
| Phone line via Retell, Telegram bot | **Defer (Phase 3, opt-in)** | Pack 37 Part Two, 24 | Paid, cloud; design hooks now (Voice agent channel abstraction), build later |
| REA reverse engineering, debate show, website/video prompt packs | **Reject for core** | 21, 42, 14–27, 33, 38, 39, 44 | Out of scope; video prompt guidance may inform Media Studio presets |
| Cost guide | **Adapt** | Pack 40 | Per-agent usage meter; Pandesh's `openRouterBudget` + model invocation records are the data source |

### 3.2 n8n workflows

| Workflow(s) | Decision | Reasoning |
|---|---|---|
| 01 Gmail labeling | **Reject** (superseded) | Pandesh has planned, approved, undoable Gmail organisation with a local model |
| 02 YouTube → multi-network posts | **Adapt pattern only** | "One source → many drafts" is exactly Social Studio's repurpose feature; drafts land in the approve desk; nothing posts automatically |
| 03, 04, 07 agent + tools | **Reject** (superseded) | Governed research, capability dispatch, calendar tools exist |
| 04 sub-workflow-as-tool | **Adapt pattern** | Agent-to-agent typed handoff contract |
| 05 Pinecone RAG, 17 Vectorize Slack | **Reject** | Cloud vector DB for private data; Second Brain is local |
| 08 Perplexity | **Reject** | Inline key; cloud research duplicated by governed research |
| 13, 15, 16, 18, 19, 21, 22, VC04 media | **Adapt pattern** | Async job → poll → artifact is the ComfyUI/media pattern Pandesh already has; cloud providers only as explicit opt-in providers in Media Studio with cost shown before submit |
| V01–V06, VC01/02 voice lead/health/spa | **Adapt pattern (Phase 3)** | Customer Support / Sales agents: call script → transcript → structured summary → CRM row. Requires consent capture, webhook auth, rate limits, approval before any outbound call; **health check-in (V02) rejected** unless a lawful basis and local storage are designed |
| V03 multilingual router | **Adapt** | Language-detect → route is useful for the Voice agent |

### 3.3 Should Pandesh embed n8n?

**Decision: no embedded n8n.** Pandesh already has a durable scheduler (`scheduled_tasks`, routines), a governed tool fabric, approvals and an audit ledger; embedding n8n would create a second automation engine, credential store and execution log. Instead:

- **Optional `n8n` connector** (Phase 3) for users who already run n8n locally: Pandesh can *call* a named, user-registered n8n webhook as a governed tool (approval per workflow on first use, payload preview, response recorded as tool evidence), and can *receive* a callback only on an authenticated loopback endpoint.
- **Workflow import = review, not execution**: an "Inspect n8n workflow" diagnostic reuses the parser above to show triggers, outward actions, credentials and inline secrets. It never activates anything.
