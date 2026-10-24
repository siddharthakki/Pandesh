// Generated from tests/user-journeys/11-provider-model-failures/provider-model-recovery.yaml. Review and commit this file like production code.
// productContract: visibleComposer=true visibleApprovals=true
// lifecycleChecks: visibleUi=true route=true durableState=true filesystem=true git=true
import { describe, it } from 'mocha';
import { runJourney } from "../../journeys/runJourney.mjs";

describe("Provider and model failures produce honest durable recovery states", function () {
  this.timeout(12 * 60 * 1000);
  it("provider-model-recovery", async function () {
    await runJourney("provider-model-recovery");
  });
});
