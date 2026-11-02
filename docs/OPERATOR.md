# Pandesh operator — one agent, many tools

One natural-language instruction in; a planned, permissioned, executed and **independently verified** result out. The user does
not pick applications. Ollama, OpenCode, Claude Code, Hermes, the web and Windows files are *capabilities* Pandesh selects from;
Pandesh stays the only orchestrator.

```
instruction ─▶ plan (workflow + privacy class + steps) ─▶ for each step: pick a tool from the LIVE catalog under the privacy policy
            ─▶ ask for any needed approval ─▶ run ─▶ verify independently (retry/redo within bounds) ─▶ durable result
```

Nothing here replaces existing machinery. It composes it:

| Need | Reused component |
| --- | --- |
| Web research | `createResearchEvidenceRunner` (SSRF-safe fetch, bounded evidence) |
| Local reasoning | `OllamaModelBackend` — fixed local; the operator can never reach a cloud model |
| PDF reading | `extractPdfFromBytes` (pdfjs, local) |
| Coding | Panda bridge dispatch → Kandev/ACP → isolated worktree, worker approvals, test verification |
| Privacy | `classifySensitivity`, the bridge's consent/confidential rules |

New code: `core/domain/operatorPlan.ts` (pure planning, privacy, selection), `core/domain/operatorRuns.ts` + migration 38 (durable
runs/steps/events), `core/runtime/toolCatalog.ts` (live probes), `core/runtime/operator.ts` (the step engine),
`core/api/operatorRoutes.ts` (host-only `/v1/operator/*`).

## Tool availability is probed, not assumed

`GET /v1/operator/catalog` — Ollama's installed models (`/api/tags`), executors on PATH plus Kandev agent status, a network
reachability check for web research, and a real extraction of an embedded PDF for the PDF reader. Each entry carries the reason
when unavailable; an uninstalled model or executor disappears from the next catalog.

## Privacy is one function

`selectTool` (`operatorPlan.ts`) decides before availability or preference:

- A **private** run (personal files, mail, finance, JUGAAD, anything `classifySensitivity` flags) can only use local tools. There
  is no consent that lets it fall through to an external one, and consent cannot even be recorded on it.
- A **public** run prefers local tools; an external one needs explicit consent for that run.
- **Explicit choices are binding.** A named executor/model that cannot run blocks the step; it is never substituted.
- Web queries are sanitized (paths, addresses, long numbers removed; confidential-looking text refused) and the user approves the
  exact sanitized queries before anything is sent.
- File moves are **never** pre-approvable and are refused without a recorded human decision.

## Workflows in this slice

| Instruction | Steps | Independent verification |
| --- | --- | --- |
| Research public topics | approve queries → search/fetch → local synthesis → verify | every `[S#]` must resolve to a fetched source, ≥2 cited; failure sends it back to synthesis (bounded) |
| Find/organize PDFs on this PC | local scan (read-only) → local read → propose → verify → **ask** → move → verify | files re-statted unchanged; destinations inside folder, unique, free; after a move every file is checked and **rolled back** on mismatch; undo manifest written |
| Build small software | select executor → run in isolated workspace → verify | fresh clone of the integration branch; Pandesh runs the tests itself; responsive markup checked |

## Using it

```
POST /v1/operator/runs                 {"instruction": "...", "executor"?, "model"?, "preApprove"?: {"webEgress"?, "externalTransfer"?}}
GET  /v1/operator/runs/:id             run + steps (tool chosen, candidates considered, evidence) + events
POST /v1/operator/runs/:id/steps/:idx/decision   {"decision": "approved" | "rejected"}
POST /v1/operator/runs/:id/cancel
```

Host token required. Live acceptance (real Core, Ollama, web, Downloads read-only, OpenCode):
`node esbuild.core.js && node scripts/acceptance/operator-live.mjs [privacy|research|files|coding|all]`.

## Known limits

- Workflow detection is rule-based; unrecognised requests are refused rather than guessed.
- Invoice detection/vendor naming is heuristic (keywords, labels, file name); a scan without a text layer is classified by file
  name only.
- "Source verification" means citations resolve to pages Pandesh fetched, not that a source is true.
- Coding deliverable checks assume Node's built-in test runner (as the bridge does).
