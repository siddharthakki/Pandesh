// Generated from tests/user-journeys/07-session-workspace-isolation/cross-workspace-leakage-negative.yaml. Review and commit this file like production code.
// productContract: visibleComposer=true visibleApprovals=not-applicable
// lifecycleChecks: visibleUi=true route=true durableState=true filesystem=true git=true
import { describe, it } from 'mocha';
import { runJourney } from "../../journeys/runJourney.mjs";

describe("Guardian rejects deliberate Workspace A projection in Workspace B", function () {
  this.timeout(12 * 60 * 1000);
  it("cross-workspace-leakage-negative", async function () {
    await runJourney("cross-workspace-leakage-negative");
  });
});
