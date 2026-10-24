// Generated from tests/user-journeys/04-approval-steering/delivery-pending-close.yaml. Review and commit this file like production code.
// productContract: visibleComposer=true visibleApprovals=true
// lifecycleChecks: visibleUi=true route=true durableState=true filesystem=true git=true
import { describe, it } from 'mocha';
import { runJourney } from "../../journeys/runJourney.mjs";

describe("Delivery approval restores once and delivers once after close", function () {
  this.timeout(12 * 60 * 1000);
  it("delivery-pending-close", async function () {
    await runJourney("delivery-pending-close");
  });
});
