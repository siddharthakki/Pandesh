// Generated from tests/user-journeys/04-approval-steering/steering-after-close.yaml. Review and commit this file like production code.
// productContract: visibleComposer=true visibleApprovals=true
// lifecycleChecks: visibleUi=true route=true durableState=true filesystem=true git=true
import { describe, it } from 'mocha';
import { runJourney } from "../../journeys/runJourney.mjs";

describe("Steering after full close and reopen preserves task ownership", function () {
  this.timeout(12 * 60 * 1000);
  it("steering-after-close", async function () {
    await runJourney("steering-after-close");
  });
});
