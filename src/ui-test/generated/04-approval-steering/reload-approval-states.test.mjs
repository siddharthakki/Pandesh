// Generated from tests/user-journeys/04-approval-steering/reload-approval-states.yaml. Review and commit this file like production code.
// productContract: visibleComposer=true visibleApprovals=true
// lifecycleChecks: visibleUi=true route=true durableState=true filesystem=true git=true
import { describe, it } from 'mocha';
import { runJourney } from "../../journeys/runJourney.mjs";

describe("Developer Reload preserves proposal mutation and delivery approvals", function () {
  this.timeout(12 * 60 * 1000);
  it("reload-approval-states", async function () {
    await runJourney("reload-approval-states");
  });
});
