// Generated from tests/user-journeys/07-session-workspace-isolation/same-profile-workspaces.yaml. Review and commit this file like production code.
// productContract: visibleComposer=true visibleApprovals=true
// lifecycleChecks: visibleUi=true route=true durableState=true filesystem=true git=true
import { describe, it } from 'mocha';
import { runJourney } from "../../journeys/runJourney.mjs";

describe("One profile isolates Workspace A and B and restores owned steering", function () {
  this.timeout(12 * 60 * 1000);
  it("same-profile-workspaces", async function () {
    await runJourney("same-profile-workspaces");
  });
});
