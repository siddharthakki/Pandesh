# Capability matrix (2026-11-21)

**Levels:**
- **I**: implemented in code
- **T**: automated tests exist and pass
- **P**: packaged in a build
- **E**: enabled on this machine
- **U**: usable in a complete workflow, proven live today

"live" = proven today on the isolated scratch instance (Core 3992), through the ChatGPT-style paired client, unless noted. "?" = not checked today.

Production is Build 187/186 at `E:\Pandesh`. Nothing below was installed there.

## Execution and agents

| Capability | Source | I | T | P | E | U | Evidence / gap |
|---|---|---|---|---|---|---|---|
| ChatGPT connector (MCP gateway, OAuth, tunnel) | `apps/panda-bridge/mcp-gateway`, `apps/desktop/src/host/chatgptConnector.ts` | ✔ | ✔ | B188c test pkg | isolated B188c | ✔ (earlier today by owner) | 5 tools; model/effort not passed (not needed) |
| Cloud-agent approval card | `core/domain/bridgeApprovals.ts`, `Missions.tsx` | ✔ | ✔ | B188c | ✔ | ✔ live | Allow and Don't allow both pressed in the UI today |
| Claude Code worker (Kandev/ACP, worktree per task) | `core/runtime/kandev/devStories.ts`, `kandevClient.ts` | ✔ | ✔ | ? | ✔ Claude 2.1.330 | ✔ live | Borrowed sign-in can expire (seen 13:40 today) |
| OpenCode worker | same | ✔ | ✔ | ? | ✔ v2.3.2 | ✔ (3 runs this morning; 2 GPU-lane runs today) | Runs on local GPU |
| Hermes worker | `core/runtime/hermesEngine.ts`, Kandev `hermes-acp` | ✔ | ✔ | ? | ✘ in Kandev ("agent not installed") | ✘ | Hermes exe present; Kandev ACP adapter missing; `Hermes_Gateway` task last exit 0xC000013A |
| Aider | — | ✘ | | | ✔ 0.86.2 installed | | Not integrated as an executor |
| Codex / Copilot ACP | Kandev | ✘ (listed, not driven) | | | in Kandev | | "coordinator does not drive this agent yet" |
| Answer-only tasks (no project) | 7e4536a | ✔ | ✔ | ✘ | scratch | ✔ live | Hello completed in about 1 s |
| Fail closed on missing project | 7e4536a | ✔ | ✔ | ✘ | scratch | ✔ live | |
| Explanation kept, no contradictory repair | 7e4536a | ✔ | ✔ | ✘ | scratch | ✔ live | 0 feedback messages sent |
| Worker slot release (abandoned decision, GPU wait) | 68db6e9, fc0aa0e | ✔ | ✔ | ✘ | scratch | ✔ live | |
| Two concurrent Claude workers | Kandev WIP 2 | ✔ | partial | ✘ | scratch | ✔ live | Overlap 15:09:37–15:09:45 |
| GPU lane lock | `gpuLaneLimit`, `waitsOnGpuLane` | ✔ | ✔ | ✘ | ✔ | ✔ live | "Waits for: local GPU lane (1 at a time)" |
| Scoped ChatGPT coding in a project (A5) | — | ✔ | | | | | Built cafb8a0; View diff cc79820; verified live on a synthetic read-write repo |
| A5 intent contract (code / inspect / answer / research / operation; MCP `intent`) | `core/domain/taskIntent.ts` (18304c4, 1ac53e6) | ✔ | ✔ | b188h | B188c profile | ✔ live 2026-11-23 (Test A ptask_af136609, `-code` worktree) | Fixes ptask_c00d7741 (coding task ran as inspection, "Finished and verified") |
| Pandesh's own before/after project test run on A5 changes | `core/runtime/kandev/projectTests.ts` | ✔ | ✔ | b188h | ✔ | ✔ live (Test A: 2 new pass, `adds` pre-existing) | Mission steps measured against main until c6d97b3 (committed, not yet built) |
| Requested-outcome status (worker finished ≠ change delivered) | `outcomeOf` in `pandaBridge.ts` | ✔ | ✔ | b188h | ✔ | ✔ live (A: awaiting review → approved → completed) | "Finished and verified" removed |
| Owner "Don't approve" for a reviewed change | `rejectBridgeChange`, `reject-change` route | ✔ | ✔ | b188h | ✔ | ✘ not pressed live (owner approved) | A refused change can never be approved later |
| Multi-step missions + bounded development grant | `feat/supervised-missions` 395269d, de89cac, 2c6620c | ✔ | ✔ | b188h | ✔ | ✔ live (Test B ptask_3b30d620: 3 steps integrated after one Allow; survived 2 restarts) | Worker permission prompts still need the owner (by design); prompt shows `<path>` to the owner (open) |
| MCP `pandesh_list_projects`, `pandesh_updates` (changes since cursor) | gateway + `/v1/bridge/project-names`, `/v1/bridge/updates` | ✔ | ✔ | b188h | ✔ | ✔ live (updates read across 2 restarts; needsOwner on a stalled step after 2c6620c) | Polling only: an MCP connector cannot start a ChatGPT conversation |
| Claude usage-limit / sign-in detection | `accountProblem` (eadcdd7) | ✔ | ✔ | b188f | ✔ | ✘ not provoked live | Quotes Claude's message; no retries; no invented quota |
| Unanswered approval card expires visibly | `expireStaleApproval` (d519c62) | ✔ | ✔ | b188h | ✔ | ✔ live (2 cards from 11-22 now say expired, nothing sent) | |

## Live agent workspace

| Capability | Source | I | T | P | E | U | Gap |
|---|---|---|---|---|---|---|---|
| Worker panels grouped by agent | `MissionControlPane.tsx` `WorkerPanels`, `workerModel.ts` | ✔ | ✔ | ✘ | scratch | ✔ live | Direct dev stories not shown |
| Latest action + last-event age + quiet warning | same | ✔ | ✔ | ✘ | scratch | ✔ live | |
| Persistent per-task log (200), survives restart | `mergeActivity`, `refreshBridgeTask` | ✔ | ✔ | ✘ | scratch | ✔ live (3 restarts) | |
| Desktop Allow / Don't allow for worker actions | `devStoryPermission` host route | ✔ | ✔ (route authz) | ✘ | scratch | ✔ live (Don't allow) | Allow-once path not pressed live |
| Stop / Pause / Resume on the panel | 565b818 `workerControls` | ✔ | ✔ | ✘ | scratch | Stop ✔ Pause ✔ live; Resume ✘ when paused before the first event | Open worktree / view diff not built |
| Board → Missions, Team → Settings, Processes → Diagnostics | — | ✘ | | | | | Not started |

## Deterministic services (router: `core/runtime/kandev/intentRouter.ts`)

| Capability | Service | I | T | P | E | U (live ms) | Gap |
|---|---|---|---|---|---|---|---|
| Directory listing | `fs.list` | ✔ | ✔ | ? | ✔ | ✔ 518 ms | Reads only Pandesh task workspaces (by design) |
| File metadata / SHA-256 | `fs.inspect` | ✔ | ✔ | ? | ✔ | ✔ 205 ms | same |
| File type from content (Magika 1.1.0 + signatures) | `doc.detect-type` | ✔ | ✔ | ? | ✔ `D:\PandeshServices\magika` | ✔ 2307 ms (Magika score 1.0) | |
| PDF text (text layer, else OCR) | workflow `extract-document` | ✔ | ✔ | ? | ✔ Poppler | ✔ 1382 ms | |
| PDF page count | `doc.pdf-info` | ✔ | ✔ | ? | ✔ | ✔ 1200 ms | |
| OCR (PDF/image, Tesseract 5.4) | `doc.pdf-ocr` | ✔ | ✔ | ? | ✔ | PDF ✔ earlier builds; image routing fixed in 06de824 (unit-tested, not live) | |
| Tailscale status | `net.tailscale-status` | ✔ | ✔ | ? | ✔ 1.104.5 | ✔ 555 ms | |
| Service health | `svc.health` | ✔ | ✔ | ? | ✔ | routing fixed in 06de824 (unit-tested) | |
| Record search | `search.records` | ✔ | ✔ | ? | ✔ | ? | |
| Daily brief workflow | `brief.daily` | ✔ | ✔ | ? | ✔ | ? | |
| Hash-verify workflow | `workflow.verify-hash` | ✔ | ✔ | ? | ✔ | ? | |
| Local vision inspection | `core/runtime/localVisionInspector.ts`, Ollama `qwen2.5vl:7b` | ✔ | ? | ? | ✔ model present | ? | Not exercised today |
| Duplicate detection (models) | `scripts/inventory/model-store-inventory.mjs` | ✔ | ✔ | n/a | ✔ | ✔ real run | Files only; general file dedup not a service yet |
| Receipt extraction / JUGAAD intake | `jugaadServices`, `D:\PandeshJugaadDev` | ✔ | ✔ (per release review) | B188 candidate | ? | ? | Not exercised today |

## Platform

| Capability | Where | State |
|---|---|---|
| Ollama | 0.40.17, 15 models, `~\.ollama\models` (118 GB) | E |
| llama.cpp | WinGet build 10853 | installed; not wired to Pandesh |
| LM Studio | `lms` present, models dir empty of large files | installed |
| Strata / vLLM-tev / InferenceLab / Kokon | `D:\AI` | Strata data 136.7 GB; not exercised |
| ComfyUI Image Studio | `C:\Projects\ImageGeneration` | present; no model files over 50 MB found under it (models may live elsewhere; not checked) |
| Docker Desktop | 29.8.2 | daemon not running |
| WSL | Ubuntu + docker-desktop | stopped |
| Tailscale | 1.104.5, connected | E, U |
| cua-driver (desktop automation) | scheduled `cua-driver-serve` | E (exit 0 at login) |
| GitHub CI | `.github/workflows/ci.yml` (windows-latest: test, timing-sensitive) | hosted only; last 2 runs on feat/stage-c failed |
| Self-hosted runner | `scripts/github-actions/*` | scripts exist; no runner registered |
| n8n / Dagu | — | not installed |
