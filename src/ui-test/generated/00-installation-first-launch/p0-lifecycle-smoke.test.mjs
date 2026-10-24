// Generated from tests/user-journeys/00-installation-first-launch/p0-lifecycle-smoke.yaml. Review and commit this file like production code.
// productContract: visibleComposer=true visibleApprovals=true
// lifecycleChecks: visibleUi=true route=true durableState=true filesystem=true git=true
import { describe, it } from 'mocha';
import { runJourney } from "../../journeys/runJourney.mjs";

describe("Install, use all three modes, complete, and reopen one frozen product", function () {
  this.timeout(12 * 60 * 1000);
  it("p0-lifecycle-smoke", async function () {
    await runJourney("p0-lifecycle-smoke");
  });
});
