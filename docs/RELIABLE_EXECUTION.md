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
| `full` | unit test, lint | once, at completion |

The full tier runs at completion (`runFinalFullValidation` in the executor),
and a failure there is fed back to the model as ONE bounded repair turn
instead of being swallowed by a "Completed" answer. A workspace with no
cheap gate still gets validated — the full tier runs, but only the first
time; the later edits say so.

The lightweight tier's failure is fed back with an explicit directive
("the failing command's output above is the evidence"), so the next edit is
informed rather than blind.

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
The write is refused with that explanation and the result category
`mutation_outcome_uncertain`. The Extension Host's existing
`mutationOutcomeUncertain` behaviour (`src/agent/TaskRecovery.ts`) is
untouched.

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
| `core/test/benchmarkImprovements.test.ts` | the bounded anchor context, the safe escape repair, the identical-failure tracker, the validation tiers, the context budget |
| `core/test/benchmarkRealExecution.test.ts` | the REAL Core executor: edit-and-repair with the bounded context, and a change written once when it is proposed again |
