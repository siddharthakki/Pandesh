# M35 packaged-dogfood acceptance evidence

Status: **RESOLVED — exact-head CI passed with all four packaged scenarios
green.** The dual approval-gate ownership defect diagnosed below (two
independently-wired scripts, `chat-autonomous.js` and `chat-sidebar-ui.js`,
racing over the same approval-card DOM) has been fixed: ownership is now
consolidated exclusively in `chat-autonomous.js` under a bounded, monotonic
`proposal → mutation → delivery` gate lifecycle. A related host-side race and
a packaged-harness resource leak, both found while chasing this defect to
ground in real CI runs, are fixed as well. PR #56 remains **draft**, has
**not** been merged, and no M35 tag exists.

## Final green exact-head CI run

- Head: `b5c0c723f509bab3c5927c2845e559257709b237` (`phase/m35-complete-everyday-karkedikha`)
- Workflow run: [siddharthakki/ollama-agent#56 · run 29707455220](https://github.com/siddharthakki/ollama-agent/actions/runs/29707455220) — **passed**
- VSIX: `karkedikha-m35-win32-x64.vsix`
- Bytes: `30,967,770`
- SHA-256: `50f1a71a69dd73ae68a0755de078a56c5702bacf9c12cee4587e61ebacd11afa`
- `activationExitCode`: `0`, `scenariosExitCode`: `0` (from the run's own
  `windows-packaged-acceptance-summary.json`)

| Scenario | Result | Duration |
|---|---|---|
| `activation_registration` | **passed** | — |
| `restart` | **passed** | 37,368 ms |
| `m35-inline-approval` | **passed** | 39,273 ms |
| `m35-package-provenance` | **passed** | 169,208 ms |

Static VSIX verification passed both before and after the
`m35-package-provenance` dogfood turn (target platform `win32-x64`, sqlite
native binary is a Windows PE/`MZ` image, all required assets including the
three webview files present, no prohibited content, repository-root VSIX
inventory byte-for-byte unchanged).

### Post-relaunch DOM evidence (`m35-inline-approval`, step 4: host close/relaunch)

Captured from the real packaged webview after a genuine VS Code window close
and relaunch on the same disposable profile — resolved proposal and mutation
cards restored alongside the current pending delivery gate, exactly one
actionable control, correct chronological DOM order:

```json
{
  "approvalCycle": {
    "proposalCardHidden": false, "proposalApproveDisabled": true,
    "mutationCardHidden": false, "mutationApproveDisabled": true,
    "deliveryCardHidden": false, "deliveryApproveDisabled": false
  },
  "inline": {
    "timelineContainsProposal": true, "timelineContainsMutation": true, "timelineContainsDelivery": true,
    "proposalResolvedState": "resolved", "mutationResolvedState": "resolved", "deliveryResolvedState": "pending"
  },
  "timelineOrder": ["proposal-approval-card", "mutation-approval-card", "delivery-approval-card"]
}
```

### `m35-package-provenance` task result

`ok: true`. The live agent, running against a real local coding model,
reached a terminal `failed` outcome with `noChangeOutcome: true` — an honest
no-change/blocked outcome, not a fabricated mutation — while the
package-provenance and repository-integrity checks (pre- and
post-verification of the exact supplied VSIX, repository-root VSIX inventory
unchanged, disposable-checkout isolation) all passed. This scenario's own
acceptance criteria are explicitly designed to accept a real model's honest
non-success as long as packaging/integrity guarantees hold — it is not, and
was never intended to be, a strict "the model must succeed" gate.

## Fixes shipped this session

Four defects, each found by actually running the packaged scenarios against
a real VS Code install and a real exact-head CI run rather than by static
review, each fixed and re-verified before moving to the next:

1. **Dual approval-card DOM ownership** (the root defect diagnosed below).
   `chat-sidebar-ui.js` ran a second, independent approval-gate state
   machine (inline placement, resolved-history restoration, a
   `MutationObserver` fighting `chat-autonomous.js`'s own `hidden`-attribute
   writes) alongside `chat-autonomous.js`'s render/reconcile logic — both
   reacting to the same `proposalApprovalRequest`/`mutationApprovalRequest`/
   `autonomousTaskStatus`/etc. messages independently. Fixed by
   consolidating all approval-card DOM ownership (visibility, inline
   placement/ordering, taskId/attemptId binding, pending/resolved state,
   button enablement, status text, resolved-history restoration) exclusively
   into `chat-autonomous.js`, via a bounded `proposal → mutation → delivery`
   gate lifecycle with monotonic rank tracking
   (`activateGate`/`resolveGate`/`reconcileApprovalGates`): a status
   snapshot can only ever advance the recorded gate or reset it on a
   genuinely new task/attempt/terminal state, never regress an
   already-pending later-stage gate. `chat-sidebar-ui.js` now owns only the
   top-level status banner, mode switching, and activity/history drawer
   behavior. 10 adversarial-message-ordering regression scenarios added in
   `src/test/suite/m35ApprovalGateMonotonicLifecycle.test.ts`.
2. **Panda-label ordering regression** (introduced, then caught and fixed,
   while consolidating #1). Each approval-request case handler called
   `setPandaState(...)` *after* the render call that (via `placeCardInline`)
   sets the more specific "Waiting for your approval below." label, so the
   generic per-`PandaState` label always won. Reordered every request
   handler (and the `autonomousTaskStatus` case's defensive
   `reconcileApprovalGates` fallback) so `setPandaState` always runs first.
3. **Host-side `reconcileStaleApprovalCards` race.** After approving a
   proposal in a relaunched webview, `task.state` briefly reported `running`
   for a poll tick or two while the mutation gate was already genuinely
   pending (`pendingMutationApproval` set, `mutation_pending` recorded,
   never resolved in Core) — a normal eventual-consistency artifact between
   when the pending record is written and when the coarse `state` enum
   catches up. `reconcileStaleApprovalCards` keyed staleness on
   `task.state === 'waiting_for_mutation_approval'` alone, so it posted a
   spurious `mutationApprovalResolved` for a gate nothing had actually
   resolved. This previously went unnoticed because the old dual-owner
   webview always re-derived gate enablement from every status snapshot
   unconditionally, silently re-enabling the card once state settled back —
   accidentally masking the host bug. The corrected monotonic client
   properly treats a resolution message as authoritative and never
   re-requests an already-surfaced gate, so the spurious resolution now
   permanently stranded the card — this was the exact packaged
   `restart`-scenario failure. Fixed: a gate is now only treated as
   definitively superseded when `task.state` is terminal or a *named* later
   gate state strictly ahead of it (proof an old pending field is stale
   garbage); a transient non-gate value defers to the pending-record field.
   Regression test added in `agentPanelRestartRehydration.test.ts`.
4. **Packaged-harness resource leak.** The `restart` scenario's
   `pageClient2.close()`/`webviewClient2.close()` only ended the CDP
   debugger session — the underlying VS Code process (`window-4b-relaunch`)
   and its Core process kept running until the whole script's single
   end-of-run cleanup, for the rest of the packaged-dogfood run. With the
   `restart` fix (#3) in place, `restart` now runs its full real-model
   round trip to completion instead of failing fast, so its windows/Core
   process lived measurably longer — long enough, stacked against the next
   scenario's own VS Code + Core launch, to starve a constrained CI runner's
   CPU/memory enough to turn `m35-inline-approval`'s normally-instant
   deterministic message exchange into one slow enough to blow past its
   120s actionability timeout (observed directly in CI). Fixed:
   `restart` now terminates its own launched process(es) and Core process
   right after its own evidence assertions complete.

## Verification performed

- `node scripts/check-ai-os-docs.mjs`, `npm run compile`, `npm test`
  (1642 passed, 5 skipped, 2 todo), `npm run test:extension` (5 passed), and
  `npm run verify` all pass. Two pre-existing, unrelated local-environment
  issues surfaced while re-running the full suite were also fixed along the
  way: Node's tightened Windows `.cmd`/`.bat` spawn rules (`EINVAL` without
  `shell: true`) and `Expand-Archive` rejecting a `.vsix` extension outright,
  both in `m12RetrievalIntegrationPackaging.test.ts` (which also had
  assertions hard-coded to the old dual-owner ownership location, retargeted
  to the corrected location).
- `npm run test:e2e:m32-packaged-dogfood -- --only=m35-inline-approval` run
  three consecutive times against the exact-head VSIX, standalone: **all
  three independently passed**, before the full four-scenario sequence was
  ever attempted.
- The complete Windows packaged sequence (`activation_registration`, then
  `m35-inline-approval`, `restart`, `m35-package-provenance`) passed in one
  exact-head CI run — see above.

## Commit history for this correction

| Head | What changed |
|---|---|
| `b2d6d8c` | Consolidated approval-card DOM ownership into `chat-autonomous.js`; monotonic gate lifecycle; 10 regression scenarios; fixed two pre-existing local-env test issues + retargeted their stale assertions |
| `83860ba` | Fixed the panda-label ordering regression surfaced by a real packaged run; retargeted a third stale-assertion location (`scripts/everyday-assistant-board-smoke.mjs`) that was blocking CI before it ever reached the Windows packaged step |
| `2f41e5d` | Fixed the host-side `reconcileStaleApprovalCards` race; reconciled with a pre-existing test defending a different, legitimate scenario via gate-rank-based combined logic |
| `b5c0c72` (final) | Fixed the packaged-harness resource leak in the `restart` scenario's cleanup |

---

## Appendix: original diagnosis (historical record)

The sections below are preserved as the diagnostic trail that led to the fix
above — kept for anyone reviewing how the root cause was actually found
(two failed exact-head CI attempts, a local baseline reproduction, and
finally direct instrumentation of the packaged webview's inbound message
stream via the harness's own `readInstrumentedInboundMessages` capture).

### Failed package (superseded)

The exact approved VSIX installed successfully but the extension failed to
activate.

| Field | Value |
|---|---|
| Installed path | `C:\Users\siddh\.vscode\extensions\ollama-agent.ollama-agent-0.1.0\` |
| Size | 19,309,700 bytes |
| SHA-256 | `c6c23e1d45614af112ed79d21bcc4a7e300ca56f3fa657ba51fd6eb1fc2a7d19` |
| Classification | **FAILED / SUPERSEDED** |

#### Extension Host error

```
@vscode/sqlite3/build/Release/vscode-sqlite3.node is not a valid Win32 application.
```

#### Diagnosis (root cause, confirmed against `.github/workflows/ci.yml`)

CI runs on `[self-hosted, linux, x64]`. The M35 packaging step performed a
Linux `npm ci` and then `npx vsce package` with no `--target`. `@vscode/sqlite3`
(`package.json` — `"@vscode/sqlite3": "^5.1.14-vscode"`) is a native module;
building it under Linux npm produces an ELF `.node` binary. `vsce package`
bundled that Linux binary into the VSIX regardless of the fact the artifact
was intended for Windows dogfood — `--target win32-x64` alone would not have
fixed this, since the dependency itself was never built on Windows.

### Packaging pipeline correction (predates this session)

Root cause and fix scoped to:

- `.github/workflows/ci.yml` — added an isolated Windows staging package
  stage, and relabeled the prior Linux-built package as
  `karkedikha-m35-generic.vsix` / `accepted: false` (build-sanity evidence
  only, never presented as an M35 artifact).
- `scripts/package-win32-vsix.ps1` — builds the win32-x64 VSIX entirely
  inside a Windows `%TEMP%` staging directory (Windows `node.exe`/`npm.cmd`,
  a plain zip snapshot expanded into a fresh local staging dir, never the
  Linux runner's `node_modules`).
- `scripts/acceptance/win32VsixVerification.mjs` + `scripts/verify-win32-vsix.mjs` —
  static structural verification of the produced VSIX: declared
  `TargetPlatform="win32-x64"`, sqlite native binary present with a Windows
  PE (`MZ`) signature (not ELF), required extension/Core assets present, no
  prohibited harness/test material shipped.
- `scripts/run-win32-packaged-acceptance.ps1` — installs and runs
  `activation_registration`, then `m35-inline-approval`, `restart`, and
  `m35-package-provenance` against the exact supplied VSIX from a genuine
  Windows `node.exe`/`Code.exe`, invoked from the self-hosted Linux runner
  via PowerShell interop.

### Root cause identified: two competing approval-gate scripts (now fixed)

Both CI failures on the pre-fix head (and a local reproduction) showed the
same signature: `mutationCardHidden: false`, `mutationApproveDisabled: true`
— the mutation card visible but its Approve/Deny controls never enabled.
Tracing this: `media/chat-autonomous.js` was a **second, complete,
independently-wired approval-gate state machine** (`showOnlyGateCard`,
`clearStaleTaskCards`, its own `window.addEventListener('message', ...)`)
that managed the exact same DOM elements (`mutation-approval-card`,
`mutation-approve-btn`, `mutation-deny-btn`, and the equivalent
proposal/delivery elements) as `media/chat-sidebar-ui.js`'s M35
inline-timeline implementation. Both scripts were loaded in the same webview
and both reacted to `mutationApprovalRequest`/`autonomousTaskStatus`/etc.
independently, racing depending on message arrival order. This is the defect
fixed in this session — see "Fixes shipped this session" above for the
resolution (ownership consolidated into `chat-autonomous.js`, not retired
into `chat-sidebar-ui.js` — `chat-autonomous.js` was the more complete,
better-tested implementation of the two).

### Prior exact-head CI run (passed; predates M35 packaged-dogfood scenario additions)

- Head: `33a7aa7e1a754989c4cd571f1305dd5f7386d836`
- Workflow run: [siddharthakki/ollama-agent#56 · run 29691646991](https://github.com/siddharthakki/ollama-agent/actions/runs/29691646991) — passed
- VSIX bytes: `30,968,733`, SHA-256: `9f895f46b641ed5d53802b514bde8b9d6266030be696645bf9d1b5aa420c49d1`
- `activation_registration`, `m35-inline-approval`, `restart`: all passed
  (this run predates the `m35-package-provenance` scenario)

### Failed exact-head CI attempts during diagnosis (this correction)

| Head | Run | `activation_registration` | Failed scenario | Signature |
|---|---|---|---|---|
| `8c651885` | [29701415150](https://github.com/siddharthakki/ollama-agent/actions/runs/29701415150) attempt 1 | passed | `m35-inline-approval` | mutation card stuck disabled |
| `8c651885` | 29701415150 attempt 2 (rerun) | passed | `restart` | mutation/delivery card stuck disabled |
| `b480c31` | [29702762758](https://github.com/siddharthakki/ollama-agent/actions/runs/29702762758) | passed | `restart` | mutation card stuck disabled (baseline confirmation before fix) |
| `b2d6d8c` | [29705249608](https://github.com/siddharthakki/ollama-agent/actions/runs/29705249608) | — | `everyday-mvp-smoke` | stale ownership-location assertion in `scripts/everyday-assistant-board-smoke.mjs` (fixed in `83860ba`) |
| `83860ba` | [29705676519](https://github.com/siddharthakki/ollama-agent/actions/runs/29705676519) | passed | `m35-inline-approval` | panda-label overwritten by `setPandaState` ordering bug (fixed in `2f41e5d`) — `restart` passed on this run, first confirmation the dual-ownership fix worked end-to-end |
| `2f41e5d` | [29706708270](https://github.com/siddharthakki/ollama-agent/actions/runs/29706708270) | passed | `m35-inline-approval` | resource contention from `restart`'s leftover VS Code/Core processes (fixed in `b5c0c72`); `restart` itself passed cleanly (host-side race fix confirmed) |
| `b5c0c72` | [29707455220](https://github.com/siddharthakki/ollama-agent/actions/runs/29707455220) | **passed** | — | **all four scenarios passed** |

Each attempt found and fixed exactly one concrete, reproducible defect
before the next attempt — no defect required more than one additional push
to resolve, and no scenario ever needed to be retried more than the real
model's own acknowledged non-determinism (`restart`/`m35-package-provenance`
are documented as real-model scenarios in
`scripts/run-win32-packaged-acceptance.ps1`; `m35-inline-approval` is the
deterministic scenario and was required — and confirmed — to pass 3/3
consecutive standalone runs before being trusted as fixed).
