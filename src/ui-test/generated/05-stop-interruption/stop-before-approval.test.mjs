// Generated from tests/user-journeys/05-stop-interruption/stop-before-approval.yaml. Review and commit this file like production code.
// productContract: visibleComposer=true visibleApprovals=true
// lifecycleChecks: visibleUi=true route=true durableState=true filesystem=true git=true
import { describe, it } from 'mocha';
import { runJourney } from "../../journeys/runJourney.mjs";

describe("Stop before approval cancels without mutation or resurrection", function () {
  this.timeout(12 * 60 * 1000);
  it("stop-before-approval", async function () {
    await runJourney("stop-before-approval");
  });
});
