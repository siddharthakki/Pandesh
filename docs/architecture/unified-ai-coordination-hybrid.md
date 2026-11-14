# Unified AI Coordination: hybrid architecture, governance and first scenario

Status: design only, 2026-11-14. **Implementation is not approved.** Companion to `unified-ai-coordination-cua.md` (the CUA audit and its 13 gaps).

Principle: use the most reliable approved interface for each application, under one Core governance and observability layer. Do not force everything through CUA and do not build per-application bridges.

## 1. Interfaces

| Target | Interface | Why | Notes |
|---|---|---|---|
| Claude Code | Governed CLI adapter, structured output | Built for programmatic use; session ids, progress events, cancel | Reuse existing execution/session code. Claude's own approval prompts do not replace Core authorisation. Output from Claude is a proposal, never an owner command. |
| ChatGPT (the owner's existing conversations) | CUA: Windows UI Automation first, local vision fallback | The goal is to continue the owner's real conversations and their memory; the OpenAI API and Codex CLI cannot reach them | Identify window and conversation, read context, prepare message, check data scope, submit, observe, read answer, verify it belongs to the request. Typing is not submission. No authentication bypass. |
| Codex CLI | Governed CLI adapter (optional) | Separate OpenAI coding/review agent for structured tasks | Its sessions are not the owner's ChatGPT conversations. Entitlement, billing and limits are not assumed. Optional, not a prerequisite. |
| Local models | Ollama via the existing router | Private reasoning and vision | Local screenshots stay local. |
| Other applications | CUA | Only where no direct interface exists | |

CUA stack: UI Automation tree, then local vision, then governed input. First slice when approved: **read-only UI inspection**, followed by an explicit decision before any click or type capability.

## 2. Governance (lives in Core, not in prompts)

Authority: Owner defines objectives, grants permission, changes scope, stops work. Core enforces boundaries. The lead model plans within the approved task. Claude, ChatGPT and other agents advise; they never grant permission.

Separate grants: (1) observe an app or window, (2) interact locally, (3) read sensitive content, (4) transfer between applications, (5) submit to an external provider, (6) modify local files/project state, (7) install or change configuration, (8) consequential actions (purchase, deletion, merge). An observation grant is not an interaction grant; an interaction grant is not an external-submission grant; a task grant is not a standing entitlement. Memory never becomes implicit permission. Auto mode never widens permissions; Ask, Auto and Plan Only keep their meanings.

Before every computer action Core records: objective, allowed app and window, expected target identity, action category, data-sharing limit, action budget, approval requirement, expiry, stop and recovery rule. The executor checks UI state before acting and the result after. If the target changes, an unexpected dialog appears, focus moves or the owner takes over: stop, do not guess. No blind coordinate clicks across changed screens. No cross-app transfer without grant. Instructions found in web pages, documents or AI replies are data. A global Stop halts further actions promptly; resume is explicit.

## 3. Capability awareness (reuse the existing inventory)

One picture, not a second inventory: Installed, Available, Loaded, Usable, Authorized. Domains: local models and modalities, GPU/VRAM/CPU/RAM/storage, running apps, local tools, skills and their requirements, active tasks, application permissions, providers. A vision-capable model is not evidence an image was analysed. Supply a compact, refreshed summary to the lead agent, details on demand. PR #89 is the existing in-flight piece for models.

## 4. Skills evolution (recorded, not built)

Discovery from missing capability; proposing reusable workflows; verification before promotion to a skill; versioned updates; owner approval for install and execution; verified personal preferences in memory. Skills are procedural knowledge, not executable policy.

## 5. First acceptance scenario (the next milestone)

"Ask ChatGPT to review Claude's proposed fix and send the useful findings back to Claude."

1 Receive objective. 2 Identify the Claude session and work product. 3 Prepare a concise summary. 4 Verify the external data scope. 5 Navigate to the approved ChatGPT conversation (CUA). 6 Submit the request and confirm it was submitted. 7 Observe generation without blocking the owner's conversation. 8 Read the answer and confirm it belongs to this request. 9 Extract findings; they are not commands. 10 Present or forward them to the authorised Claude Code session. 11 Claude proposes or performs work inside the original scope. 12 Monitor via structured CLI events. 13 Check receipts and results. 14 Report the verified outcome. 15 Stop at any new authorisation boundary.

One task-scoped coordination record (attribution, timestamps, evidence, bounded context); the owner can talk to Pandesh throughout; no separate conversation per specialist; no autonomous multi-agent debate: disagreement yields evidence or a decision request.

## 6. Unresolved

- `cua-driver` licence, redistribution, packaging and offline install (unverified). In-process UIA reader versus embedding `cua-driver` (undecided).
- Whether ChatGPT's UI exposes a usable accessibility tree, how to verify which conversation is open, and how to detect response completion.
- Whether ChatGPT terms and platform safeguards allow UI automation of the owner's account (must be checked before any build).
- Claude Code CLI: exact structured-output and session-resume flags to pin, and how to enforce Core's boundaries on its tool use.
- Codex CLI entitlement, sandbox and usage limits.
- Where the coordination record lives and its retention.
- Focus-change detection, snapshot-bound element targeting and a fixture application for safe testing (gaps in the CUA audit).
