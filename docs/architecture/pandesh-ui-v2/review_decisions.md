# Architecture review decisions — 2026-11-08

The owner reviewed the package at `fc7e88c` and accepted it as the **design baseline** with the refinements below. Where this document conflicts with another document in this folder, **this document wins**.

Execution boundary (unchanged): Phase 1 reliability remediation stays the priority. No UI implementation, branch merge, dependency installation into the product, or deployment until the full reliability gate is complete **and** the final visual designs are approved.

## D1 — Renderer strategy

React components are mounted **incrementally inside the existing Electron renderer** behind `PANDESH_UI_V2`.
- The vanilla-JS UI stays the default. A surface replaces its vanilla counterpart only after that surface passes real-app acceptance in an installed build.
- Order: Board → Agent Team → Spaces → Activity/Preview → Conversation (last). Each surface is its own change.
- Shared components with `src/webview-v2` (ApprovalCard, ActivityTimeline, TaskCard) are extracted into a shared package only when the second consumer exists.
- The flag can be turned off per user; with the flag off, the app must behave byte-for-byte as before (acceptance check).

## D2 — Dependency trials

| Package | Decision | Trial scope |
|---|---|---|
| `node-pty` + `@xterm/xterm` | **Approved for isolated trial** | Throwaway Electron app outside the repo. Check: ConPTY on Windows 11, packaging with the portable build script, handling of Electron ABI rebuilds, and kill-tree behaviour |
| `graphology` + `sigma` | **Approved for isolated trial** | 2D graph with 5K nodes / 150 visible; check WebGL in the sandboxed renderer and layout in a worker |
| `pdfjs-dist` (viewer) | **Approved for isolated trial** | Must use ≥ 6.2.108 (see `docs/security/dependabot_triage_2026-11-08.md`, T1). The viewer runs in the sandboxed renderer, never in Core |
| `3d-force-graph` | **Deferred** | Only after the 2D Second Brain is useful and verified |

Trials run in a scratch folder with their own `node_modules`; nothing is added to the repo's `package.json` until the owner approves the trial results.

## D3 — Second Brain storage

- Reuse `memory_facts`, `memory_evidence`, `knowledge_entities`, `knowledge_relationships`, `memory_contradictions`.
- Add only `knowledge_sources` (registry) and the **rebuildable** `knowledge_chunks` + FTS5 indexes (`second_brain_design.md` §3).
- **Embeddings:** a local evaluation is allowed against representative user data. They are not enabled unless they measurably beat FTS5 (gate in `second_brain_design.md` §3.3: ≥ 15 points recall@5, no privacy regression). The evaluation set and results stay local; `secret` sources are excluded.

## D4 — Specialist agents and scope enforcement (extended)

Agents remain on-demand, Core-governed workers. The scope gate is enforced in Core on **every** surface that can reveal or move data, not only on tool calls:

| Surface | Enforcement |
|---|---|
| Tools | Exposure (what the model sees) **and** dispatch (what may run) |
| Memory | Recall and write filtered by `memoryScopes` |
| Events | `runtime_events` reads filtered by the caller's agent scope when the caller is an agent run; user UI sees all but labels scope |
| Search | `/v1/knowledge/search` and conversation search filtered by scope; no cross-scope snippets |
| Artifacts | Read/attach only for artifacts produced in, or granted to, the agent's scope |
| Previews | Preview pane content for an agent run is limited to that run's artifacts/processes |
| Filesystem | `workspaceRoots` ∩ conversation workspace, existing confinement |
| Outbound requests | Egress proxy with the agent's domain policy; private-marker scan on outbound payloads |

**Delegation may never widen authorization.** A child's effective scope is the intersection of the parent's effective scope, the child's definition and the explicit grant (`multi_agent_architecture.md` §6). Escalation always goes to the user as an approval.

Acceptance (milestone 2b) adds adversarial tests for each row: a crafted brief, a content-embedded instruction, a cross-scope artifact id, a cross-scope search query, and an event read.

## D5 — Capacity-aware resource scheduling

The arbiter (`multi_agent_architecture.md` §7) admits work by **measured capacity**, not fixed slot counts:

- **Inputs:** free/total VRAM from `nvidia-smi` (`hardwareCapacity.ts`), loaded models and their size from Ollama `/api/ps`, ComfyUI `/system_stats` + queue, the ASR model size (local Whisper / `@xenova/transformers`), system RAM and CPU load, and any other local OpenAI-compatible engine registered in providers.
- **Estimates:** each job declares an estimated footprint (model weights + context, from the catalog and the measured history in `model_invocations`). The arbiter admits a job only if `free VRAM − reserve ≥ estimate`, or if the job can evict an idle (non-interactive) model.
- **Priority:** the interactive turn > speech (latency-critical, small) > background LLM > diffusion/video > indexing/embeddings.
- **Eviction:** only of idle models via Ollama `keep_alive: 0` / ComfyUI free-memory endpoint, never mid-job. Each eviction is recorded as an event with its reason.
- **Visibility:** every waiting job shows "waiting for GPU memory: ComfyUI is using 9.1 GB" from the `resource` event domain.
- **No VRAM oversubscription** (the 64K-context VRAM spill is a known failure mode): if the estimate does not fit, the job waits or is refused with a reason. It is never started on a hope.

## D6 — Main UI simplicity

Confirmed: the default view is the compact rail and the conversation only. Activity and Preview appear only when a turn produces something viewable. Agent Team, Board, Second Brain and the specialist workspaces open on demand. Mockups and prototypes follow `visual_prototype_plan.md`.

## D7 — Prototypes

Three isolated visual prototypes are to be prepared under the rules in `visual_prototype_plan.md`. They use genuine interaction patterns and show no fabricated runtime evidence; any sample content is visibly labelled.

## D8 — Local-first and external automation

Confirmed: the existing local-first architecture is unchanged. There is no embedded n8n. Third-party credentials are not used, and no workflow is imported without review. The three n8n workflows with inline keys (08, 13, V05) are quarantined and never imported.

## D9 — Branch status correction

`handoff.md` previously said "Not pushed". Correct status: `docs/pandesh-ui-v2` was pushed to `origin` at `fc7e88c`. It was cut from `fix/reliability-remediation` at 89b8af2, so the remote branch also carries 36 reliability commits that are not on `main`. No PR has been opened. A clean docs-only PR needs the docs commits rebased onto `origin/main` (pending owner decision).

## Security follow-up (Phase 1, separate from UI work)

Read-only triage done: `docs/security/dependabot_triage_2026-11-08.md`. Three findings are reachable in production: `pdfjs-dist` (code execution from a malicious PDF inside Core — highest priority, low-risk minor bump), Electron 33.4.11 (unsupported, 45 alerts, high-risk major upgrade), and `@xmldom/xmldom` via mammoth (DOCX denial of service, lockfile-only). The remaining 50 alerts are dev or test tooling. No upgrades were made.
