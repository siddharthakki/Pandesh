// Generated from tests/user-journeys/04-approval-steering/mutation-pending-close.yaml. Review and commit this file like production code.
// productContract: visibleComposer=true visibleApprovals=true
// lifecycleChecks: visibleUi=true route=true durableState=true filesystem=true git=true
import { describe, it } from 'mocha';
import { runJourney } from "../../journeys/runJourney.mjs";

describe("Mutation approval restores once after full close and reopen", function () {
  this.timeout(12 * 60 * 1000);
  it("mutation-pending-close", async function () {
    await runJourney("mutation-pending-close");
  });
});
