# A5: owner-approved ChatGPT coding in one isolated worktree (proposal, not built)

## Today
- A ChatGPT task that may change files in a registered project is refused at `gateProject` ([pandaBridge.ts](../../../core/runtime/kandev/pandaBridge.ts), "Tasks that change files in … are not run from the browser bridge yet").
- Since 7e4536a, a task naming no registered project is refused too. There is no empty substitute workspace.
- So "ChatGPT asks Pandesh to fix a Pandesh bug with Claude" cannot run. This is deliberate and fails closed.

## The smallest safe change
Reuse what exists. Add no new permission system.

| Piece | Reused from | Change |
|---|---|---|
| Approval card | `requestExternalApproval` / `bridgeApprovals` (single-use, instruction-hash pinned, commit pinned) | New access level: "Code change in an isolated worktree of *project* at *branch @ commit*. No push, no merge, no install." |
| Grant scope | `routineWriteGrants` limits pattern (`maxFiles`, bytes, operations) | `bridgeCodeGrant { projectId, baseCommit, maxFiles, expiresAt, singleUse }`, recorded in the approval audit row |
| Where the work happens | `planDevStories` + Kandev worktree (same as KKD dev stories) | `repoPath` = a **clone** of the registered project (as `prepareProjectInspection` makes, without a remote), not the owner's checkout |
| Verification | `verifyAndIntegrate` (diff scope, `examineDiff`, verify command, independent checks, human review gate) | Unchanged. Integration goes to a local branch **inside the clone** (`panda/<task>`); the owner's checkout is never written |
| Delivery | — | The result is a branch in the clone plus a diff. Pandesh shows "Apply to my checkout" as a separate host-only action (a `git fetch` from the clone into a new local branch). Nothing is pushed |
| Worker policy | `permissionDecision` | Unchanged: writes only inside the worktree; no `git push`, `git remote`, or credential paths |

## Conditions (all enforced in code, not in the prompt)
1. Only the owner, in the Pandesh window, can approve. A paired client can only ask.
2. The registered project must be `read-write` in the project registry. `read` projects stay inspection-only.
3. One approval = one task = one base commit. If the branch moved, the card is void (as for inspections today).
4. The clone has no remote, so nothing can be pushed from it.
5. `maxFiles` / byte caps are checked at verification. Exceeding them fails the task with evidence.
6. The owner's checkout is fingerprinted before and after. Any change there fails the task (as `finishInspection` does).

## Acceptance tests
- ChatGPT asks for a code change in a `read` project → refused, no card.
- ChatGPT asks for one in a `read-write` project → card shows project, branch, commit, caps; Don't allow → nothing runs.
- Allow → Claude edits in its worktree → verification passes → a branch exists in the clone, the owner's checkout fingerprint is unchanged, and no remote exists.
- Claude tries `git push` → rejected by policy, logged.
- A diff over `maxFiles` → fails with the file list.
- The approval cannot be reused for a second task, or after the base branch moves.

## Estimate
About one day, including tests. Most of it is wiring existing pieces and the "Apply to my checkout" action.

## Decision needed from the owner
Allow this for `read-write` projects? If yes, which projects get `read-write`?
