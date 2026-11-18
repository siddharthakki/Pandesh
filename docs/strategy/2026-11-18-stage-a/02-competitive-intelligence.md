# Pandesh — competitive intelligence

**Date:** 2026-11-18 · Sources: live web research (Nov 2026), primary repos/docs where reachable. Star counts are dated snapshots; unverified figures are flagged. Several names in the mandate are **not what they sound like** — corrections below.

## Corrections to the mandate's competitor list

- **"Bot HQ" (Nick Vasilescu):** real but a **10★, 0-release repo created 2026-11-11** — a days-old hobbyist "team of Hermes agents, each with its own screen" demo. It proves *demand* for the watch-agents-work idea, not a product to fear or copy wholesale.
- **"OpenBot":** contested name, ≥4 repos. CopilotKit/OpenBot (MIT, enterprise workspace), nightly-labs/openbot (noncommercial, local desktop for Codex/Claude/Grok), regnull/openbot (MIT, bot teams). Must specify which.
- **"Personal Jarvis":** flagship repo **renamed to Dodaios** ("one agent that runs all your other agents"). Windows+local overlap.
- **"Paperclip":** real, active — *org* governance for agent teams (org charts, budgets, goals), server/business-oriented, not personal-desktop. "~95k★" is a single-community claim, unverified.
- **"Hermes Agent":** NousResearch/hermes-agent (MIT, local-first, Feb 2026). **Note:** Pandesh's internal `hermesEngine.ts` shares this name — a naming-collision risk worth resolving.
- **Project Mariner:** **shut down 2026-05-04**, folded into Gemini Agent. Not a live competitor.

## Landscape matrix

| Name | Repo / site | License | Standout | Why chosen | Real vs promo | Maturity | Reuse for Pandesh | Threat |
|---|---|---|---|---|---|---|---|---|
| **OpenClaw** (ex-Clawdbot/Moltbot) | openclaw/openclaw | MIT (Foundation) | personal agent via any chat app; ~13.7k community skills | network effects, "runs everywhere" | real, but security-tarnished (Claw Chain CVEs, ~500k exposed instances claimed) | extreme; creator joined OpenAI Feb 2026 | skills-as-packages pattern (MIT); **not** its security model | High (mindshare), Unix-first |
| **Goose** (Block) | block/goose | Apache-2.0 | Rust local agent: desktop+CLI+VS Code, MCP-native | local-first, zero install friction, foundation governance (AAIF) | real, 500+ contributors | very mature (v1.60, Nov 2026) | recipes/skills artifacts; MCP surface (Apache) | **High — same local-first Windows story** |
| **OpenHands** | OpenHands/OpenHands | MIT open-core | Agent Canvas: always-on engineering team | dev workflows, self-host | real (92.8k★) | very mature | event-sourced state pattern | Low (not personal-life) |
| **Hermes Agent** (Nous) | NousResearch/hermes-agent | MIT | local-first runtime, ~150 skills | local, fast-growing | "fastest-growing" is vendor claim | growing | MIT runtime/profile ideas | High |
| **Agent Zero** | frdel/agent-zero | OSS (license unconfirmed) | Dockerized Linux desktop + DOM browser; organic memory | one-line installer, memory | real | mature (v0.8.7) | memory ideas; Linux-container heart | Medium |
| **Browser Use** | browser-use/browser-use | MIT | most-starred browser-agent lib | any model key, self-host | real (120k★) | very mature | DOM-annotated a11y-tree approach (MIT) | Medium (library, complementary) |
| **Stagehand** | browserbase/stagehand | MIT | code-first computer-use over Playwright | determinism, test automation | real | mature | structured-page primitives | Low |
| **Claude Cowork** | anthropic.com | closed | agentic file/computer work for non-coders; Dispatch (phone→desktop) | mass distribution, polish | real, research preview, Mac-first, Max-tier | launched Jan 2026 | none (closed) | High (distribution) |
| **ChatGPT agent / Atlas** | openai.com | closed | Operator+research+browser fused | distribution | real | mature | none | High (cloud-only) |
| **Copilot Actions/agents** | Microsoft | closed | M365/Windows integration | enterprise default | real; fragmented permission UX is a known pain | enterprise scale | none | High for Windows users |
| **Manus** | manus.im | closed SaaS | Wide Research (parallel sub-agents) | breadth | real, credit-metered | alive | none | Low |
| **Mingbird** | mingbird/mingbird-agent + arXiv 2610.02001 | Apache-2.0 | Windows+Ollama harness for 2–9B models | **same 2B model: 0.017→0.821 across harnesses** | credible paper | early research | harness-discipline thesis (validates Pandesh) | Medium (same thesis) |
| **LocalAI-Cowork** | noshitcoding/LocalAI-Cowork | unverified | "local-first AI coworker for Windows, Ollama, MCP, approvals" | nearly Pandesh's pitch | small/early | early | none verified | Medium (overlap, low traction) |
| Open WebUI / LibreChat / AnythingLLM / LobeChat | various | mixed | self-host chat + RAG + MCP | chat UIs | real | very mature | UI patterns only | Low (weak agency) |

## Architecture lessons (top 4)

**OpenClaw** — channel-first (chat apps as UI), daemon+gateway. Its vulnerability cluster is a cautionary map: enforce sandbox policy at **one chokepoint**, default-on; symlink/TOCTOU checks; deny-lists enforced not advisory. Pandesh already does the chokepoint right — this is a validation, and a marketing contrast. Its 13.7k-skill marketplace proves **skills-as-packages** is the right extensibility axis.

**Goose** — Rust core, MCP-only tool surface, recipes/skills as shareable artifacts, foundation governance as a trust signal. Windows desktop + CLI proves local-first wins when **install friction ≈ 0**. Pandesh's unsigned installer + Ollama prerequisite is the gap to close.

**Browser Use / Stagehand** — give models **DOM-annotated accessibility trees + code primitives**, not pixel screenshots. Reliability comes from structured pages + Playwright determinism. Pandesh's managed browser should lean this way for the research/price-watch demos.

**OpenHands** — event-sourced agent state + persistent control center turns one-shot runs into always-on workflows. Pandesh's ledger is already event-sourced; the missing piece is the *control-center surface* (Mission Control).

## What users still complain about (recurring, sourced)

1. **Runaway token/cost burn** — "450M tokens in 10 days" (r/openclaw).
2. **Security exposure / real breaches** — ~500k public OpenClaw instances; one sold for $25k (r/openclaw, r/AI_Agents).
3. **Setup/maintenance & audit fatigue** — "ease comes at a huge cost if you aren't a security expert."
4. **Permission-prompt friction & fragmentation** — Copilot Studio "three or four Allow prompts… out of order"; ChatGPT "suddenly asking permission for all websites."
5. **Loops, no-ops, unreliability** — coordinator/reviewer "vicious cycle"; Copilot agent "tells me the answer instead of editing files."
6. **Slowness** — Copilot agents "literally so slow."
7. **Memory/goal drift** — ChatGPT "forgets the goal… makes extra unnecessary files."
8. **Governance backlash** — security bolted on reactively and resented ("Annoying Safety Limits! It should be Our Choice!").

**Pattern:** trust, verification, consent ergonomics, cost, and continuity are the unsolved problems — not raw capability.

## Open differentiation gaps (fitting Pandesh)

1. **Windows-native, no-WSL agent runtime** — nearly empty; OpenClaw/Agent Zero lean Unix/WSL2. Mingbird explicitly targets this gap.
2. **Small-model harness discipline** — the 0.017→0.821 result is a moat for 7–14B local models; nobody mainstream does it.
3. **Evidence ledger / verified receipts** — only days-old OSS prototypes (agent-receipts, receipt-protocol); enterprise audit platforms don't target personal desktops. **Pandesh's ledger would be first.**
4. **Permissions-as-contracts** — scoped, expiring, revocable grants, ledger-linked; no product offers this (complaint #4).
5. **Fail-closed "done"** — receipt-or-unverified, integrated into a personal-agent UI. Unclaimed.
6. **Per-task cost/token observability** — local ledger attributing tokens/minutes per task with budgets. Unclaimed locally.
7. **Local governance for personal agents** — per-agent quotas, auditable history, replay; governance lives only in server products.
8. **Verified mobile dispatch** — phone→PC with a returned receipt; Cowork's Dispatch is cloud+Max-tier.
9. **Watch-agents-work screens** — Bot HQ proves demand, no real product; a Windows-native version is open.

## Where Pandesh is better / worse today

**Better:** single enforced permission chokepoint; fail-closed approvals with digests; deliverable-level verification + claim guards; durable journal resume with replay guard; frozen-scope routines with failure notices; read-only Bots; Core-written mission reports; honest demo culture.

**Worse:** install friction (unsigned + Ollama + GPU); no onboarding; Classic still default; tool offering by English regex; no Mission Control / receipt / workspace / contract surfaces; Windows-only; local-model quality ceiling; two mission layers + legacy cockpit; giant files.

**Genuinely available differentiation:** *the verified-delegation personal OS for Windows* — proof-of-work receipts + autonomy contracts + rehearsal, on a local-first, permission-gated ledger. No competitor credibly owns this combination.