# Handoff — Pandesh UI v2 / Phase 2 architecture

Branch `docs/pandesh-ui-v2` (worktree `D:\Projects\Pandesh-ui-v2-docs`, from 89b8af2). Documentation only. **Pushed to `origin` at `fc7e88c`.** Because the branch was cut from `fix/reliability-remediation`, the remote branch also carries 36 reliability commits not on `main`. No PR is open yet; a docs-only PR needs a rebase onto `origin/main`. Later commits on this branch are local until pushed. No production code, migrations, dependencies or builds were changed. `fix/reliability-remediation` was not modified.

**Status 2026-11-08:** the architecture is accepted as the design baseline with refinements. See [review_decisions.md](review_decisions.md) (it overrides the other documents where they conflict) and [visual_prototype_plan.md](visual_prototype_plan.md). Security triage is in [../../security/dependabot_triage_2026-11-08.md](../../security/dependabot_triage_2026-11-08.md).

## Read in this order

1. `reference_research.md` — what JARVIS/AI Workshop really provides (prompt packs, not code; V8.1 unspecified publicly), reference UIs.
2. `ai_workshop_archive_analysis.md` — 63 files, duplicates, all 25 n8n workflows, **3 inline third-party keys**, Reuse/Adapt/Reject.
3. `current_system_inventory.md` — what Pandesh already has (most of the backend for v2 exists).
4. `multi_agent_architecture.md`, `second_brain_design.md`, `visual_execution_design.md`, `ui_information_architecture.md`.
5. `feature_gap_matrix.md`, `implementation_roadmap.md`.

## The design in five lines

- Agents = Core-enforced definitions over the existing request/attempt/approval pipeline, run on demand under one resource arbiter; handoffs can only narrow scope.
- Second Brain = existing memory/knowledge tables + a source registry and FTS5 cache; edges only with provenance; graph is an optional lens.
- Visual Execution = a Core process registry on top of `processOwnership.ts`; Workspace mode by default; Show My Work moves only windows Pandesh owns; no input injection.
- UI = one calm conversation; Activity/Preview pane appears per task; Board and Team on demand; five Spaces in a popover; System menu for config.
- Nothing outward (posts, messages, calls, purchases) exists until Phase 3, and then only with approvals.

## Decisions requested from the owner

1. Approve the architecture (agents as definitions + scope gate; no new memory DB; no embedded n8n).
2. Renderer approach: React surfaces inside the existing Electron renderer behind `PANDESH_UI_V2` (recommended) vs. continuing vanilla JS.
3. New dependencies to evaluate in isolation: `node-pty` + `@xterm/xterm` (terminal), `graphology` + `sigma` (2D graph), `3d-force-graph` (optional), `pdfjs-dist` (viewer).
4. Whether to re-open semantic retrieval (embeddings) behind the evaluation gate.
5. Archive hygiene: keep the two AI Workshop zips out of any repo/cloud sync (they contain exposed third-party keys).

## Missing inputs (not invented)

`Pasted text(20261105-075338).txt`, the Venice harness specs and the original Jarvis prototype screenshots were not found on this PC. The YouTube videos were not watched (pages returned titles only), and no paid Skool content was accessed.

## Next session must not

- Start implementation before the Phase 1 19-mission verdict and design approval.
- Import any n8n workflow or AI Workshop skill without review.
- Push, merge, deploy or install builds without explicit approval.
