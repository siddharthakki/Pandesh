// Generated from tests/user-journeys/02-saath-kar-lifecycle/saath-kar-approved-restoration.yaml. Review and commit this file like production code.
// productContract: visibleComposer=true visibleApprovals=true
// lifecycleChecks: visibleUi=true route=true durableState=true filesystem=true git=true
import { describe, it } from 'mocha';
import { runJourney } from "../../journeys/runJourney.mjs";

describe("Saath Kar approved turn restores exactly once", function () {
  this.timeout(12 * 60 * 1000);
  it("saath-kar-approved-restoration", async function () {
    await runJourney("saath-kar-approved-restoration");
  });
});
