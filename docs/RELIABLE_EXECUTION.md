# Reliable execution after the DeepSeek harness comparison

This note records what changed in Core and the Extension Host after the
DeepSeek super-agent harness comparison, why, and what is deliberately left
out. It is written for the next maintainer, not for a user.

The comparison report is at
`D:\AI-Experiments\Deepseeksuperagentharness\runs\report.md`.

---

## 1. Stop actually stops (Priority 1)

**The problem.** The comparison found that stopping a task left the
descendant processes running: `cmd.exe` died, but the `node.exe` it had
started — and that node's own children — kept running. The extension's
`run_command` killed only the shell; the legacy validation runner spawned
with `shell: true` and killed only the shell; and even the Core path, which
used the right primitive (`taskkill /t /f`), reported the stop as successful
without ever checking that the processes were gone.

**The fix.** One mechanism, used everywhere:

- `core/runtime/processTree.ts` — the shared, VERIFIED tree termination.
  It enumerates the owned tree (the root plus everything the OS reports as
  its descendant), terminates it with the platform tree primitive, and then
  re-reads liveness. `terminated` is true only when nothing survived; the
  PIDs that survived are reported, never assumed away.
  - `descendantsOf` is pure and unit-tested.
  - `terminateProcessTree` takes its process table and its kill function as
    dependencies, so the whole decision is testable without touching the OS.
  - `createProcessTreeTracker` remembers the descendants while the root is
    alive, which is the only way to still know about (and terminate) a
    grandchild whose parent exited early.

Wired into: `core/runtime/toolRunner.ts`, `core/runtime/windowsShellExec.ts`,
`src/services/CommandService.ts`, `src/validation/BaseValidationRunner.ts`,
`src/sandbox/DirectProcessBackend.ts`.

**One extra bug found on the way.** `src/services/CommandService.ts` spawned
`cmd /c <command>` without `windowsVerbatimArguments`, so Node's default
Windows argv quoting escaped the quotes inside the command string and
`cmd.exe` received a mangled path. A quoted path simply did not run. The
command is now passed verbatim, exactly as the Core tool runner does it.

**Where the authority sits.** `core/runtime/processOwnership.ts` decides
WHETHER a PID may be killed. `core/runtime/processTree.ts` decides HOW a
permitted tree is killed and whether it actually died. Every caller of the
tree terminator spawned the process itself, so ownership is by construction.

---

## 2. Earlier verification (Priority 2)

**The problem.** Validation ran after every approved mutation using the
single strongest gate the workspace declares. In a repository whose only
declared gate is `npm test`, that is the FULL SUITE after every edit — the
model waits minutes per keystroke and the context fills with test output
that has nothing to do with the next edit.

**The fix.** Two tiers (`core/runtime/workspaceValidation.ts`):

| tier | gates | when |
| --- | --- | --- |
| `lightweight` | syntax, compile, typecheck | after every approved mutation |
| `full` | unit test, lint | at completion, against the FINAL workspace state |

The full tier runs at completion (`runFinalFullValidation` in the executor),
and a failure there is fed back to the model as ONE bounded repair turn
instead of being swallowed by a "Completed" answer. A workspace with no
cheap gate still gets validated — the full tier is SUBSTITUTED for the
missing cheap one after an edit, and the completion run still covers the
whole full gate set.

The lightweight tier's failure is fed back with an explicit directive
("the failing command's output above is the evidence"), so the next edit is
informed rather than blind.

### 2a. The full tier must describe the workspace the task ENDS on

**The problem.** The full tier is evidence about ONE revision of the
workspace. The first version of the gate asked a different question: "has a
full-tier validation EVER run on this attempt?" That is not the same
question, and the difference is the whole point:

* a full tier that ran BEFORE the last edit describes different bytes, so
  it cannot report the state the task ends on;
* a full tier that FAILED and was then repaired was still counted as "the
  full tier ran", so the repair edit was never validated against the
  expensive gate, and the task was reported as done on a result that no
  longer described the workspace.

**The fix.** The workspace has a REVISION
(`core/runtime/validationFreshness.ts`): the number of workspace-CHANGING
invocations that succeeded on the attempt — an approved `propose_*` write
that landed, or a shell command that demonstrably changes files. A read, a
refused write, a validation-only command and a write that was already
applied change nothing and do not move it. The revision is derived from the
recorded invocations, so it is the same number before and after a restart.

Every validation records the revision it ran against. At completion:

* a recorded full tier from an EARLIER revision is STALE — the tier runs
  again against the state the task ends on;
* a recorded full tier from the CURRENT revision is reused — the suite is
  never re-run without a code change to justify it, and a repair turn that
  changes nothing does not pay for the suite twice;
* a full tier that still fails after the bounded repair turn FAILS the
  attempt. "Completed" is never reported on a stale or failing result.

A workspace that declares no cheap gate substitutes the full tier after an
edit, and that substitute runs a SINGLE gate: it is evidence about the
current revision, but not the whole full tier, so it cannot stand in for
the completion run — which covers every full gate the workspace declares.

The recorded tier is the tier that RAN, not the tier that was requested, so
a substituted lightweight request that ended up running the full tier is
found by the completion decision instead of being filed as cheap evidence.

---

## 3. Tool-error recovery (Priority 3)

**Bounded file context.** `core/runtime/anchorContext.ts` builds a bounded,
VERBATIM context block for a missed anchor: where an ambiguous anchor
occurs, or the region a not-found anchor was aiming at. It is attached to
the refusal (`checkTextEditAnchor` in the executor, `resolveAnchoredEdit` in
`core/runtime/textEditProposal.ts`) and to the tool result in the Core tool
runner. A model cannot copy an anchor it was never shown.

The context only ever SLICES the file. It never normalizes Unicode, never
substitutes quotes, never folds whitespace: the bytes the model copies are
the bytes in the file.

**Safe escape repair.** `core/runtime/jsonArgumentRepair.ts` repairs exactly
two classes of malformed JSON — a literal control character inside a string
value, and a `\'` escape JSON does not define. Both are what the model
plainly wrote. An escape a language could give a meaning to (`\d`, `\[`, …)
is reported, not guessed at. There is no Unicode folding anywhere in the
path.

**Repeated identical failures.** `core/runtime/identicalFailureTracker.ts`
counts failures per (target, failure category). The duplicate-CALL policy
already existed (`loopProgress.ts`); this catches the case it cannot see —
a model that rewords a failing call instead of repeating it. The counts live
in the persisted loop-progress state, so a restart does not forget them.

---

## 4. Restart-safe mutations (Priority 4)

**The durable ledger.** `core/domain/mutationLedger.ts` + migration 46
(`mutation_ledger`). It records the INTENTION of a workspace edit — tool,
path, the pre-image it was computed against and the exact content it
produces — BEFORE the write, and marks it applied afterwards.

**The idempotent write.** `core/runtime/toolRunner.ts` refuses to write
content the file already holds: the write is reported as
`mutation_already_applied` and nothing is written again. For an anchored
edit the exact result hash is FROZEN INTO THE APPROVAL (next to the
baseline), so the check survives a restart.

**Uncertain outcomes are never replayed.** When the file matches neither the
pre-image nor the result, the outcome of the earlier attempt is unknown.
The write is refused with that explanation — the refusal states that the
earlier outcome is unknown, that it was therefore NOT repeated, and that
nothing was written — and it carries the `write_stale_baseline` result
category, the one Core uses for a proposal that no longer matches the bytes
it was approved against. The Extension Host's existing `mutationOutcomeUncertain`
behaviour (`src/agent/TaskRecovery.ts`) is untouched.

**The approval flow is unchanged.** A proposal that is already satisfied
still gets its approval card; the human still decides. Only the WRITE is a
no-op.

---

## 5. Model-aware context budgeting (Priority 5)

**Reasoning tokens.** A reasoning model charges its thinking against the same
window as the answer. `core/shared/contextBudget.ts` now carries a
`reasoningTokens` reserve in the window, sourced from the provider's own
capability list (`thinking`), never from a model name, and bounded to
[1024, 8192] tokens. The reserve is frozen into the model selection, so every
turn of an attempt budgets the same way and a restart rebuilds the same
budget.

**Hard limits preserved.** `usableInputTokens` still cannot go negative, and
the safety margin is unchanged. The reasoning reserve is charged on top of
the existing output reserve.

**When it does not fit.** `assessContextFit` decides between `reduce`
(shrink the eligible context), `select_another_model` (an authorized model
with a bigger window) and `report_limitation`. The repository evidence clamp
lost its floor, so the compressible context is dropped rather than allowed
to push the fixed parts past the limit; what remains (the objective and the
tool surface) is not compressible, and a request that still does not fit is
reported instead of being sent truncated.

**No silent cloud fallback.** `core/runtime/autoRerouteRuntime.ts` now
honours the attempt's frozen routing policy: under `local-only` (the
default) Auto may pick another LOCAL model or nothing at all.

---

## Tests

| file | what it proves |
| --- | --- |
| `core/test/processTreeTermination.test.ts` | the tree decision logic, without touching the OS |
| `core/test/platform/ownedProcessTreeStop.platform.test.ts` | the REAL Windows tree: `cmd.exe`, the tool it started and that tool's child all die; an unrelated process survives |
| `core/test/platform/windowsProcessTreeCancellation.platform.test.ts` | the Core path's real tree (repaired: it needed a real grant and an in-workspace fixture) |
| `core/test/platform/quotedCommandPath.platform.test.ts` | the REAL Windows quoting: a path with a SPACE runs through BOTH command paths, and the authorized command stays ONE shell program |
| `core/test/benchmarkImprovements.test.ts` | the bounded anchor context, the safe escape repair, the identical-failure tracker, the validation tiers, the validation freshness rules, the context budget |
| `core/test/benchmarkRealExecution.test.ts` | the REAL Core executor: edit-and-repair with the bounded context, and a change written once when it is proposed again |
| `core/test/benchmarkValidationFreshness.test.ts` | the REAL Core executor: the full tier re-runs after a repair edit, a failing full tier is NOT a success, and the suite is not re-run without a code change |
| `core/test/mutationReplayUncertainty.test.ts` | the REAL tool runner: a stale pre-image is refused, an uncertain outcome is refused and never replayed, an already-applied write is a no-op |

Run them with:

```
npm run test:platform:win32          # the real process trees
npx vitest run core/test/benchmarkImprovements.test.ts core/test/benchmarkRealExecution.test.ts core/test/processTreeTermination.test.ts
npx vitest run core/test/benchmarkValidationFreshness.test.ts core/test/mutationReplayUncertainty.test.ts
```

### Verification status at the time of writing

| suite | result |
| --- | --- |
| `core/test` | 2244 passed, 2 failed — both pre-existing (verified against `main`) |
| `core/test/platform` | 3 passed |
| `src/test` | 3417 passed, 4 failed — all pre-existing (verified against `main`) |
| `tsc -p tsconfig.core.json` | clean |
| `tsc -p ./` | clean |

The pre-existing failures, unchanged by this work and confirmed on `main`:

- `core/test/windowsConfinement.test.ts` — the suite cannot build: the C#
  source it compiles (`core/runtime/windowsConfinement/WindowsConfinementLauncher.cs`)
  is not in the repository.
- `core/test/m54RealityAcceptance.reality.test.ts` — "Reality J": the static
  architecture guard reports four files that import `node:child_process`
  without being on the allowlist (`core/domain/permissionModes.ts`,
  `core/platform/osSecretProtector.ts`, `core/runtime/capabilityInventory.ts`,
  `core/runtime/mediaProduction.ts`). This change adds exactly one new
  allowlist entry, for `core/runtime/processTree.ts`.
- `core/test/piAgentWorkspaceDiscovery.test.ts` — "Scenario D": the
  workspace-discovery fixture is not created.
- `src/test/suite/coreLauncher.test.ts`,
  `src/test/suite/coreUnavailableMessaging.test.ts`,
  `src/test/suite/m34PandaIdentity.test.ts` — missing packaged assets and
  bundle-dependent behaviour.

### Verification of the final correction (validation freshness)

The table above is the state of the suites when this work was written. The
final correction (section 2a) was verified with TARGETED checks only — the
5,000+ existing tests were not re-run, because the correction touches the
completion gate and nothing else:

| check | result |
| --- | --- |
| `core/test/benchmarkImprovements.test.ts` | 32 passed (6 of them the freshness rules) |
| `core/test/benchmarkRealExecution.test.ts` | 2 passed |
| `core/test/benchmarkValidationFreshness.test.ts` | 3 passed (2 of them FAIL against the pre-correction executor) |
| `core/test/saathProposalIntegrity.test.ts` | 23 passed |
| `core/test/validationInvariantAndReplacementGuard.test.ts` | 20 passed |
| `core/test/textEditProposal.test.ts` | 12 passed |
| `core/test/jsSyntaxFloorAndClaims.test.ts` | 11 passed |
| `core/test/processTreeTermination.test.ts` | 13 passed |
| `core/test/mutationReplayUncertainty.test.ts` | 3 passed |
| `core/test/executionEpochContinuation.test.ts`, `core/test/governedRuntimeInvariants.test.ts`, `core/test/m45LoopProgress.test.ts`, `core/test/m53ReadEvidence.test.ts`, `core/test/taskToolSurface.test.ts` | 72 passed |
| `core/test/platform` | 6 passed (3 files) |
| `tsc -p tsconfig.core.json --noEmit` | clean |
| `tsc -p ./ --noEmit` | clean |

The two failures that appear when the pre-correction executor is put back
are the point of the correction: the full tier ran ONCE and its stale result
was reused after the repair edit, and a failing full tier was reported as a
completed task.

