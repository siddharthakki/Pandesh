# Visual prototype plan

Purpose: get the final visual design approved **before** any implementation. The prototypes are throwaway design artefacts, not product code.

## Ground rules

1. **Isolation:** each prototype lives in `prototypes/ui-v2/<name>/` on the docs branch, or a scratch folder outside the repo. It is a static HTML/CSS/JS (or React-via-CDN-free bundle) page opened in a browser. There are no imports from `apps/`, `core/` or `src/`, no Core connection, no installs into the repo, and no Electron.
2. **No fabricated runtime evidence:** the prototypes never present invented results as real. Sample content uses obviously illustrative data, with a fixed banner reading "Prototype — sample data, nothing ran". Evidence blocks are labelled "example evidence format". There are no fake "✓ verified" states without the label, and no invented performance numbers.
3. **Genuine interaction patterns:** every interaction mirrors a real Core contract from the design docs: approve/reject, cancel, pane open/close, the drill-down from a citation to its source, and the board states derived from attempt/approval/outcome. A scripted timeline drives the state changes, and it is visibly marked as a simulation, with play/pause/step controls so reviewers can inspect each state.
4. **Design system:** tokens from `ui_information_architecture.md` §5 (Jarvis design system lineage), dark and light, keyboard reachable, and `prefers-reduced-motion` respected.
5. **Review artefact:** each prototype gets a short "what to judge" sheet and states "what is NOT represented", e.g. real latency.

## P1 — Idle chat (calm default)

| Aspect | Specification |
|---|---|
| States | (a) first run, empty; (b) morning, with a one-line brief "2 things need you"; (c) typing; (d) a waiting turn with the honest "thinking" state (elapsed time, model name, no fake progress); (e) a short answer; (f) a pending inline approval card; (g) the voice states (listening, speaking, interrupted) |
| Layout | 56 px rail (Pandesh, Board, Team, Spaces, System), centred 720 px conversation, composer with mic; Spaces and System popovers; Ctrl+K palette with sample entries |
| Judge | Calmness at idle, typography hierarchy, approval card clarity ("verb + object" buttons), dark/light parity, narrow width (bottom bar) |
| Not represented | Real model latency; real voice audio |

## P2 — Live coding execution (kitchen-inventory walkthrough)

| Aspect | Specification |
|---|---|
| Flow | Request → plan with 4 checks → handoff card "Coding, for Pandesh" → approval "Create folder" → Activity timeline steps → terminal pane streaming a recorded sample log (labelled) → a test failure with its cause → repair step → tests pass → preview pane showing a static mock of the app → the result message with headline + "not done" list → Stop dev server |
| Panes | The Activity/Preview aside opens on the first viewable event; tabs Terminal / Diff / Preview; resizer; collapse to a status chip; "Show my work" toggle shows a diagram of window placement (no real windows) |
| Truth cues | Each step shows its source record type ("tool invocation", "process", "artifact"); the progress counter is "2 of 4 checks", never a percentage; the failure state shows the exit code and last lines |
| Judge | Can the user chat while the task runs? Is takeover/stop obvious? Does the Board card mirror the same state? |
| Not represented | Real PTY, real process ownership, real timing |

## P3 — Specialist agents + Second Brain navigation

| Aspect | Specification |
|---|---|
| Agent Team | Quiet directory (needs-you first), agent detail tabs (Overview, Activity, Capabilities with a risk class and executor, Memory scopes, Model & limits, Performance — sample, labelled) and the "Message Coding" conversation header |
| Delegation view | Chief of Staff → Research → Coding handoffs, showing the scope intersection visually (parent scope ∩ definition ∩ grant) and an escalation approval |
| Second Brain | Search-first box → results grouped by type with source/date/scope → inspector (content, evidence, history, conflict side-by-side, forget with impact preview) → timeline → 2D neighbourhood graph (≤ 150 nodes, cluster nodes, dashed "suggested" edges, "similar, not linked" list kept separate) |
| Citation link | An answer with 1 citation focuses one node; one with 5 citations highlights a cluster without camera movement |
| Judge | Is scope/privacy legible? Does the graph stay calm at scale (a sample of 2K items rendered as clusters)? Is correction and deletion easy and safe? |
| Not represented | Real retrieval quality; real embeddings (deferred); 3D galaxy (deferred) |

## Build approach

- Static pages with the design tokens inlined, plain JS state machines, and one shared `tokens.css`. For the P3 graph, use `sigma`/`graphology` only if the isolated dependency trial (D2) has passed; otherwise use an SVG force layout written for the prototype.
- No network requests, no CDN at runtime (vendored copies inside the prototype folder), and no analytics.
- Output: three folders and screenshots of the key states in dark and light, plus one short review page linking them.

## Sequence and exit

1. P1 → owner review → adjust tokens and layout.
2. P2 and P3 in parallel → owner review.
3. Freeze "final visual design v1" (screenshots + tokens), recorded in `review_decisions.md`.
4. Only then, and only after the reliability gate verdict, does milestone 2a begin.

Effort estimate: P1 about 1 session, P2 about 1–2, P3 about 2. None of it touches production.
