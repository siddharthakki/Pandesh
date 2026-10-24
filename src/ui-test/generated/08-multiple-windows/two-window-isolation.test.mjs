// Generated from tests/user-journeys/08-multiple-windows/two-window-isolation.yaml. Review and commit this file like production code.
// productContract: visibleComposer=true visibleApprovals=true
// lifecycleChecks: visibleUi=true route=true durableState=true filesystem=true git=true
import { describe, it } from 'mocha';
import { runJourney } from "../../journeys/runJourney.mjs";

describe("Simultaneous Workspace A and B windows cannot capture each other's tasks", function () {
  this.timeout(12 * 60 * 1000);
  it("two-window-isolation", async function () {
    await runJourney("two-window-isolation");
  });
});
