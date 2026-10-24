// Generated from tests/user-journeys/01-baat-kar-lifecycle/baat-kar-complete-history.yaml. Review and commit this file like production code.
// productContract: visibleComposer=true visibleApprovals=true
// lifecycleChecks: visibleUi=true route=true durableState=true filesystem=true git=true
import { describe, it } from 'mocha';
import { runJourney } from "../../journeys/runJourney.mjs";

describe("Baat Kar answers, starts a new chat, and restores completed History", function () {
  this.timeout(12 * 60 * 1000);
  it("baat-kar-complete-history", async function () {
    await runJourney("baat-kar-complete-history");
  });
});
