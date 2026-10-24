// Generated from tests/user-journeys/13-security-input-boundaries/input-notification-boundaries.yaml. Review and commit this file like production code.
// productContract: visibleComposer=true visibleApprovals=true
// lifecycleChecks: visibleUi=true route=true durableState=true filesystem=true git=true
import { describe, it } from 'mocha';
import { runJourney } from "../../journeys/runJourney.mjs";

describe("Input, workspace, and notification boundaries remain safe and recoverable", function () {
  this.timeout(12 * 60 * 1000);
  it("input-notification-boundaries", async function () {
    await runJourney("input-notification-boundaries");
  });
});
