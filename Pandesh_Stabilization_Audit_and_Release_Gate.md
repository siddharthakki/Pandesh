# Pandesh — consolidated stabilization audit and RWTS-320 release gate

**Baseline:** `siddharthakki/Pandesh`, `main` at `6863812828314fccba15cab62330bb8c5ce3fd36` (Build 158).  
**Scope:** Make the existing assistant reliable across the 280 previously authored RWTS scenarios plus 40 appended regressions (`RWTS-281–320`).  
**Important:** This is a source audit and executable acceptance specification, **not** proof that any new code was fixed or tested. The live Windows runtime, its credentials and its peripherals are not accessible from GitHub source alone.

## Findings: existing scenario inventory

- Recovered `Pandesh_RWTS_Prompt_Library.md` from the user's ChatGPT Library. There are **280 distinct, consecutively numbered cases**, not a verified set of 3,000.
- Its coverage is **27 areas**: 26 areas with 10 scenarios each and a 20-case durable-memory area; 17 cases are explicitly tagged `[SMOKE]`.
- The expanded file `Pandesh_RWTS_320_Expanded.md` **preserves all 280 original cases** and appends 40 concrete regressions under four additional headings (timers 12, weather 7, research 12, provider/privacy/recovery 9).
- Existing GitHub test infrastructure includes `scripts/acceptance/pandesh-assistant-acceptance.mjs` (real local model + isolated Core memory/commitment journey), `scripts/acceptance/pandesh-conversational-verification.mjs` (real Electron desktop/Core/model), and the older packaged VSIX `scripts/golden/run-golden.mjs`. **None currently consumes the RWTS-320 bank as a complete user-scenario release gate.** Reuse the actual desktop/Core drivers; do not create an unrelated test framework.
- Some RWTS scenarios are explicitly **conditional or manual** and need physical hardware, permissioned third-party accounts or dangerous side effects. They must not be run unattended against the user's real data.

## Evidence-led root-cause map

| Failure / capability | Confirmed source or supplied runtime evidence | Required correction | Acceptance cases |
| --- | --- | --- | --- |
| User asks for a five-minute on-screen timer; model apologizes | `apps/desktop/src/host/everydayToolsIntent.ts` has reminders but no `start_timer`; `desktopSession.ts` routes unrecognized requests to model; renderer has task elapsed clocks but no user countdown | Add deterministic timer intent + Core/host deadline + live UI countdown + cancel/pause/complete + desktop notification. Never call an LLM for timer actions | RWTS-281–292 |
| Weather can select wrong town and corrupt follow-ups | `desktopSession.ts` already has a direct weather route; the historical Ulm/Ullà failure is user-observed; `everydayToolCatalog.ts` still labels weather `not_connected` despite a separate direct route | Canonical place validation, date/timezone-aware follow-ups, no first-match geocoding guess, explicit outage handling, truthful capability status | RWTS-011–020, 293–299 |
| Public job research retrieves pages but final response is `Found`, `Two`, or empty EOS | User's att_8031... model logs: 77 tool definitions, 28,992 final prompt tokens, 5/6 successful web calls and zero final text; source in `core/runtime/piAgentEngine.ts` confirms overly permissive final reply checks | Task-scoped tool surface; bound research/evidence; one dedicated no-tool evidence synthesis; reject stub replies; explicit partial/failure state | RWTS-021–030, 297–311 |
| Fallback discards retrieved research | `piAgentEngine.ts` ~4184–4205 stringifies `{content:[{type:'text',text:...}]}` objects and filters JSON-shaped strings, losing all evidence | Extract `result.content[].text` and preserve bounded source URLs; never claim raw evidence dump satisfies the requested deliverable | RWTS-298–305 |
| Agent explores local files during public vacancy discovery | User's prior job-search tool trace included CV/resume `search_files` and permission requests during public-only ask | Disallow local filesystem tool exposure for a public-search-only objective; private CV assessment must be a separate explicit locally governed action | RWTS-307–309, 314 |
| Free OrcaRouter model says it has no research tools | `desktopSession.ts` creates free cloud requests with `toolCalling:false`; `cloudPublicText.ts` says 'no tools'; `executor.ts` sends `tools:[]` and skips agent loop. **This is intentional policy, not a model fault** | Preserve the privacy-only public-text path; add a *separately authorized* public evidence broker that retrieves public pages locally and sends only reviewed/sanitized public excerpts to a free provider. Never ship raw file/Gmail/memory/tool context | RWTS-312–315 |
| Misleading “tool worked” vs “task done” outcomes | `piAgentEngine.ts` and `turnOutcome.ts` check tool activity but do not reliably establish deliverable completeness | Separate tool execution from task completion. Validate product/URL/job claims against collected evidence; marked `partial`/`blocked` when shortfall | RWTS-297–311, 319–320 |
| Generic memory recall may hijack normal questions | `piAgentEngine.ts` recall intent regex includes broad `what is/was/are/were` branch | Scope recall to contextual/explicit memory requests; ordinary 'What is Python?' must use general knowledge | RWTS-185–190, 261–280, 317–318 |
| Existing live capability “tool bound” check is not protective enough | `scripts/acceptance/run-chat-capability-live-acceptance.mjs` allows up to 130 tools; the failed research used 77 | Check **per-task minimal tools and prompt size**; one-size-fits-all threshold of 130 does not detect overload | RWTS-298–305 |
| UI and status may be stale or incorrectly marked complete | User-observed single-word replies, job workflow failed, previously observed stale weather/image and elapsed-time issues | Tie UI terminal status and preview to the current attempt IDs, durable tool evidence and actual verified output; no cross-conversation leakage | RWTS-231–250, 316, 319–320 |

## Implementation order — one branch, one sequential lead, one coordinated release

### Work package A: deterministic everyday requests

1. Central intent classifier handles `timer`, `reminder`, `weather`, basic model inventory and explicit file operations before agent dispatch.
2. For timers, store an end timestamp and state in the existing host/Core domain, then render the countdown in the main conversation UI. Use the already-implemented desktop notification plumbing, but create **no reminder** when the user requested a visual timer. Pause/resume, cancel, duplicate protection and restart policy must be deterministic.
3. Weather route must confirm a location match and exact local forecast date. Remove contradictory capability-catalog claims; do not invent conditions when provider is down.
4. Protect personal data: direct public utilities do not examine local files or memory.

### Work package B: robust local agent execution

1. Build **one small tool surface per request**, selected by capability group; a public research request must not include 77 unrelated tools.
2. Preserve real Pi tool execution and approvals, but bound repeated research queries and result excerpts. Make errors visible and keep successful sources.
3. Split retrieval from synthesis: perform the final answer from bounded evidence with `tools: []`, using the existing Pi `Agent.setTools` or an equivalent already-present model-call mechanism—not a new agent or orchestration framework.
4. Reject empty EOS and nonanswers (`Found`, `Two`, `Here`); retain the distinction between failed, partial and complete outcomes. On synthesis failure, show explicit source-backed partial evidence without fictitious success.
5. Make outcome validators task-aware: vacancy check = actual individual job URLs, date/open status, cited source and salary disclosure (not a universal word-count threshold).

### Work package C: public cloud research with privacy intact

1. Keep `cloudPublicText.ts` as the current **strict no-tools/no-history** mode.
2. For explicitly approved public research only, locally fetch and screen public text, then send **only** bounded public evidence and public query text to the selected verified-free cloud provider.
3. Never transfer personal CV, filesystem, project data, emails, calendars, tokens, memory, private conversations, user profile or arbitrary tool results. No silent paid provider, no silent fallback.
4. Show which source, provider, model and consent decision was involved. A provider limitation must be reported, not hidden.

### Work package D: memory, UI and recovery coherence

1. Narrow generic recall matching; preserve proven durable-memory write/recall behavior and approvals.
2. Keep primary chat responsive during a task, with step/evidence and artifact previews correctly bound to the active attempt.
3. Reuse durable task/session structures for pause/restart/cancel without duplicating side effects or transferring stale content into another conversation.

### Work package E: coverage audit of the remaining features

For each `RWTS-001–320`, map: capability → code owner → prerequisite → safety tier → observable proof → tested status. Determine whether it is implemented, broken, intentionally unavailable, or blocked on an external service. Implement missing behaviors required for scenarios actually in scope. **Do not mark a GAP or BLOCKED as PASS.**

## Only acceptable testing: real user scenarios from RWTS-320

- **Environment:** one isolated Windows profile and temporary test workspace, distinct from `E:\Pandesh` and `%LOCALAPPDATA%\KarkeDikha`; no access to personal production folders or secrets. Record build identity/commit and installed binaries. Never modify or purge the production database.
- **Executor:** use the existing Core/Desktop live drivers as transport only. Feed the exact RWTS user instructions and follow-ups. No unrelated synthetic suites, mass generated fuzz cases, or repeated full test campaigns after each small fix.
- **Evidence per scenario:** RWTS ID, actual input/output, selected model/provider, tools invoked, approval decision, URL/file/artifact proof, elapsed duration, status and blocker classification. Use independent checks, not LLM self-grading alone.
- **Safety:** network browsing is public only; sensitive test inputs are synthetic. Real printing, external mail, purchases, Windows package installation, and any account-affecting mutation require a human gate. Never run these unattended. Use a controlled disposable target where possible.
- **Scope:** targeted re-runs of failed and directly related scenarios during repair; after integration perform one clean complete run of applicable `RWTS-001–320`, in sequential batches so failures are attributable. Critical nondeterministic cases may get a second independent confirmation run; do not repeat entire suites just for green counts.
- **Classification:** PASS only on verified outcome; FAIL when a usable capability does not do the requested action; GAP when a required product feature is absent; BLOCKED only for a genuine unavailable external prerequisite; INCONCLUSIVE for missing evidence. Tool invocation alone is not success.
- **Release gate:** no P0 FAIL/GAP, zero unauthorized data transfer/side effects, no invented prices/open vacancies, no stub/empty assistant completions passed as success, no broken mandatory UI operations; all applicable RWTS cases PASS with evidence. Conditional/manual cases listed transparently, not silently counted as green. Compile and package only after code review; keep production untouched until acceptance is honestly complete.

## What is *not* established today

- This report does **not** prove that all 320 scenarios pass, that the Windows installation works, or that any fix has been implemented.
- The ChatGPT session has GitHub source access and the uploaded scenario bank, **not an interactive connection to the local Windows desktop or Ollama instance**. Runtime evidence must be produced by an authorized runner on the user's PC or a compatible isolated Windows installation.
- “3,000 scenarios” has not been verified. If a separate larger bank exists outside the recovered file, it must be reconciled before increasing the official case count.
- Some scenario features intentionally depend on third-party credentials, physical peripherals or user confirmation and cannot be truthfully certified unattended.

## Relevant engineering references

- [Pi agent loop and model/tool interaction](https://pi.dev/docs/latest/how-pi-works)
- [Ollama tool calling](https://github.com/ollama/ollama/blob/main/docs/capabilities/tool-calling.mdx)
- [OpenRouter tool-call capability is model-dependent](https://openrouter.ai/blog/tutorials/tool-calling/)
- [Electron notifications and Windows prerequisites](https://www.electronjs.org/docs/latest/tutorial/notifications)
- [Anthropic: observable, outcome-based agent evaluations](https://www.anthropic.com/research/demystifying-evals-for-ai-agents)
