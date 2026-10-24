// Generated from tests/user-journeys/12-git-worktree-failures/git-worktree-recovery.yaml. Review and commit this file like production code.
// productContract: visibleComposer=true visibleApprovals=true
// lifecycleChecks: visibleUi=true route=true durableState=true filesystem=true git=true
import { describe, it } from 'mocha';
import { runJourney } from "../../journeys/runJourney.mjs";

describe("Repository drift and Git or worktree failures fail closed", function () {
  this.timeout(12 * 60 * 1000);
  it("git-worktree-recovery", async function () {
    await runJourney("git-worktree-recovery");
  });
});
