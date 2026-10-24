// Generated from tests/user-journeys/03-karke-dikha-lifecycle/deterministic-complete.yaml. Review and commit this file like production code.
// productContract: visibleComposer=true visibleApprovals=true
// lifecycleChecks: visibleUi=true route=true durableState=true filesystem=true git=true
import { describe, it } from 'mocha';
import { runJourney } from "../../journeys/runJourney.mjs";

describe("Karke Dikha completes one deterministic governed task without a model", function () {
  this.timeout(12 * 60 * 1000);
  it("deterministic-complete", async function () {
    await runJourney("deterministic-complete");
  });
});
