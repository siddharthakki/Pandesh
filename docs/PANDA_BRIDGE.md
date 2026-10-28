# Panda bridge — one prompt, all tools

A prompt typed in ChatGPT can be handed to Pandesh with one click, and Pandesh runs it on the executor you choose
(OpenCode, Claude Code, Hermes, Pandesh's own Windows capabilities) and reports back to both places.

```
ChatGPT tab ──(you click / Panda Mode)──▶ extension ──Native Messaging──▶ native host ──loopback HTTP──▶ Core
                                                                                                         │
                          same task, same state ◀────────────────────────────────────────────────────────┤
                                                                                                         ▼
                                              conversation + task record ──▶ Kandev / ACP ──▶ OpenCode · Claude Code · Hermes
                                                                         └──▶ request / attempt ──▶ Pandesh native capabilities
```

Nothing here replaces existing machinery. A relayed task is one conversation, one task record and — for ACP executors — one
ordinary development story, so isolated worktrees, approvals, independent verification, integration, restart recovery and the
"KKD development" panel in Pandesh all apply unchanged (`core/runtime/kandev/devStories.ts`).

## Pieces

| Piece | Where |
| --- | --- |
| Chrome extension (MV3, ChatGPT only) | `apps/panda-bridge/extension/` |
| Native Messaging host (no dependencies) | `apps/panda-bridge/native-host/panda-native-host.mjs` |
| Core domain: pairing, intake, consent, checkpoints | `core/domain/pandaBridge.ts` (migration 37) |
| Core runtime: executor discovery, dispatch, mirror, pause/resume/cancel | `core/runtime/kandev/pandaBridge.ts` |
| HTTP API `/v1/bridge/*` | `core/api/bridgeRoutes.ts` |
| GPU capacity | `core/runtime/hardwareCapacity.ts` |
| Installer / Pandesh-side CLI | `scripts/panda-bridge/` |
| Acceptance (real Chromium + extension + host + Core + OpenCode) | `scripts/acceptance/panda-bridge-e2e.mjs` |

## Setup

1. Register the native host for your browser (current Windows user only, HKCU, reversible):
   ```
   node scripts/panda-bridge/install-native-host.mjs --data-dir "%LOCALAPPDATA%\KarkeDikha" --browser chrome --pandesh-exe "<path to Pandesh.exe>"
   ```
   `--data-dir` is mandatory: it decides which Pandesh the browser can reach. `--uninstall` removes it.
2. Load `apps/panda-bridge/extension/` as an unpacked extension (`chrome://extensions` → Developer mode). Its id is pinned by the
   manifest key to `emejmmocdfgfigdlekonndnmpjfdjimm`, which is the only origin the host manifest allows.
3. Pair: `node scripts/panda-bridge/panda-cli.mjs --data-dir <dir> pair-code`, then enter the code in the extension popup.
   Codes are single-use, expire after 5 minutes, and five wrong guesses burn every open code.
4. Revoke at any time: from the popup (**Unpair**) or `panda-cli.mjs ... revoke <pairingId>`. The pairing token is stored only as
   a hash and checked on every request, so a revoked browser is refused on its very next call.

## What the extension does and does not do

- **Send to Panda** reads the ChatGPT composer — or the part of it you selected — at the moment you click. Nothing else on the page.
- **Panda Mode** is a visible toggle (amber bar, outlined composer), **off by default**. Only while it is on does the extension
  register its Enter / send-arrow / submit interceptors; while off there is no listener, so normal ChatGPT submissions are never touched.
  A failed send keeps the prompt in the box and never falls back to sending it to ChatGPT. Without a pairing it intercepts nothing.
- **Include chat context** is off by default. When ticked, a preview shows exactly what would be shared; nothing is sent until you
  confirm, and Core rejects context that was not confirmed.
- No other conversations, attachments, cookies, credentials or browsing data are read. The pairing token never reaches the page:
  only the service worker holds it.

## Routing, consent and confidentiality

- Intake returns a durable task id immediately (`ptask_…`) and preserves the instruction byte-for-byte plus a source reference
  (page URL without query, ChatGPT conversation id, title, time, how it was sent).
- Exactly once: the pair *(pairing, client request id)* is unique, so a retried native message returns the same task. Identical text
  under a new request id (two deliberate requests) is a separate task; the extension reuses one id only for retries of a failed send.
- **You choose the executor.** Explicit selection is respected and never substituted. `auto` exists only when selected, and only
  ever picks a *local* executor.
- **Local is the default.** An executor that sends task text to an external model (Claude Code, Antigravity, an unknown agent, or
  OpenCode/Hermes pointed at a cloud model) needs explicit consent recorded on the task. **A browser can never give that consent**
  (the native host forwards only executor and model; Core ignores consent from a pairing). Only the Pandesh host can:
  `panda-cli.mjs dispatch <task> --executor claude --allow-external`.
- A task that looks confidential (keys, tokens, passwords, connection strings, card/ID numbers, “confidential/NDA…”, or marked by you)
  needs a *second*, separate `--allow-confidential` on top. Shared chat context goes to an external executor only with `--include-context`.
  The gate runs before anything is probed or started; a refusal leaves the task untouched.

## Execution, control, evidence

- ACP executors run in a **private git repository per task** under Core's data directory
  (`panda-workspaces/<task>`); Kandev adds its own per-task worktree. The worker never sees your checkouts or profile.
- Pandesh does not trust the worker's word. Verification is the existing coordinator's: the worker's `npm test`, plus a Pandesh-owned
  check (invisible to the worker) that tests exist, ran, at least one passed and none failed; then merge to an integration branch and
  re-run on the result. The final report carries the level (`independent`), commit, changed files and the checks.
- **Pause / Resume / Cancel** work from the browser card and from Pandesh. Pause stops the worker and parks the story; Resume
  relaunches from the preserved work. Native-capability tasks support Cancel.
- Approvals a worker raises appear in Pandesh (the existing "KKD development" panel — Allow / Deny — and `panda-cli approve`).
  The browser card shows “awaiting approval” and **Open in Pandesh**; it cannot approve.
- Dispatch is claimed with one atomic statement: a retry, a double click or a second browser gets the existing task, never a second run.
  A claim that never started (Core stopped in between) is marked failed after 3 minutes so it can be retried.
- Every status change is a checkpoint row; a background loop mirrors the work into the task, so results are stored even with no browser open.
- **GPU**: local-GPU executors (OpenCode, Hermes on a local model) run side by side only as far as VRAM allows —
  `floor(total VRAM / 20 GB)`, at least 1 (one on a 24 GB card), or `KARKEDIKHA_GPU_LANES`. Further tasks queue behind the lane.
- Pausing a worker that is still starting, then resuming, is supported: if only the coordinator's explicit session relaunch is slow, the
  task reports “resumed; waiting for the worker to start” and the coordinator's reconcile loop finishes the hand-off (verified live).
  The first Kandev calls after a cold start can fail while Kandev seeds its first workspace; the hand-off retries for ~30 s instead of failing the task.
- **Open in Pandesh** relaunches the app with `--panda-open=<conversation>`; the single-instance running app shows that conversation.

## Running the acceptance

Everything runs against an isolated Core data directory and an isolated Kandev home, never the installed Pandesh:

```
node esbuild.core.js
# start Core with its own data dir + tokens (KARKEDIKHA_DATA_DIR, KARKEDIKHA_CORE_TOKEN, KARKEDIKHA_HOST_TOKEN, KARKEDIKHA_KANDEV_HOME)
node scripts/panda-bridge/install-native-host.mjs --data-dir <dir> --browser chromium --install-dir <dir2> --pandesh-exe <stub.exe>
# env: PANDA_E2E_DATA_DIR, PANDA_E2E_PLAYWRIGHT (dir with node_modules/playwright-core), PANDA_E2E_CHROMIUM, PANDA_E2E_WORK
node scripts/acceptance/panda-bridge-e2e.mjs 1        # pair, intake, Panda Mode on/off, consent refusal, start OpenCode
node scripts/acceptance/panda-bridge-e2e.mjs modes    # Panda Mode + context-preview checks only
node scripts/acceptance/panda-bridge-e2e.mjs control  # live pause / resume / cancel through the extension
node scripts/acceptance/panda-bridge-e2e.mjs 2        # (long) browser-driven pause/resume, completion, Open in Pandesh
node scripts/acceptance/panda-bridge-e2e.mjs 3        # after restarting Core: results persist; revoke is immediate
```

Unit/integration tests: `npx vitest run core/test/pandaBridge.test.ts core/test/pandaBridgeRuntime.test.ts core/test/pandaNativeHost.test.ts`.

## HTTP API (`/v1/bridge`, Core bearer token required)

| Route | Caller |
| --- | --- |
| `POST /pairing-codes`, `GET /pairings`, `POST /pairings/:id/revoke` | Pandesh host only |
| `POST /pair` (code → pairing token), `DELETE /pairing` | native host / paired browser |
| `POST /tasks`, `GET /tasks`, `GET /tasks/:id` | paired browser (own tasks) · host (all) |
| `GET /executors`, `GET /status` | either |
| `POST /tasks/:id/dispatch` | browser (local executors) · host (any, with consent) |
| `POST /tasks/:id/pause\|resume\|cancel` | either |

## Not done / limits

- Pandesh's desktop UI has no screens for creating pairing codes, revoking pairings or granting external consent; those are
  `panda-cli.mjs` / API today. Progress, approvals and the final report appear in Pandesh through the existing conversation and
  "KKD development" panel.
- “Open in Pandesh” focuses the app only when it is already running (single-instance hand-off); it does not deep-link on a cold start.
- Other ACP agents Kandev knows are listed but not dispatchable (the coordinator drives claude, opencode, hermes, antigravity).
- The ChatGPT selectors (`#prompt-textarea`, `[data-testid="send-button"]`, `[data-message-author-role]`) follow the page today;
  ChatGPT can change them. The automated acceptance uses a fixture page with the same structure. The live site was exercised once by
  hand in Chrome (Temporary chat, 2026-10-27): Panda Mode off/on, Enter, send arrow, Send to Panda, duplicate clicks, a completed task.
- Task cards are scoped to the ChatGPT conversation a task was sent from (plus tasks sent from the current page), and the browser shows
  the two newest finished ones. A Temporary chat cannot be reopened, so its cards are gone after a reload; the task and its result stay in Pandesh.
- The “tests exist and pass” check verifies tests, not that every entry point loads; review the delivered code.
- Chrome 137+ branded builds ignore `--load-extension`, so automated tests use Chromium; install the unpacked extension by hand in Chrome.
