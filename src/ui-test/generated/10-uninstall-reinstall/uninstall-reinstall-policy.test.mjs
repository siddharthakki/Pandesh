// Generated from tests/user-journeys/10-uninstall-reinstall/uninstall-reinstall-policy.yaml. Review and commit this file like production code.
// productContract: visibleComposer=true visibleApprovals=true
// lifecycleChecks: visibleUi=true route=true durableState=true filesystem=true git=true
import { describe, it } from 'mocha';
import { runJourney } from "../../journeys/runJourney.mjs";

describe("Uninstall and reinstall obey the documented profile and workspace survival policy", function () {
  this.timeout(12 * 60 * 1000);
  it("uninstall-reinstall-policy", async function () {
    await runJourney("uninstall-reinstall-policy");
  });
});
