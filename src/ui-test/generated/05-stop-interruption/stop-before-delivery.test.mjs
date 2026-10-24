// Generated from tests/user-journeys/05-stop-interruption/stop-before-delivery.yaml. Review and commit this file like production code.
// productContract: visibleComposer=true visibleApprovals=true
// lifecycleChecks: visibleUi=true route=true durableState=true filesystem=true git=true
import { describe, it } from 'mocha';
import { runJourney } from "../../journeys/runJourney.mjs";

describe("Stop immediately before delivery prevents workspace delivery", function () {
  this.timeout(12 * 60 * 1000);
  it("stop-before-delivery", async function () {
    await runJourney("stop-before-delivery");
  });
});
