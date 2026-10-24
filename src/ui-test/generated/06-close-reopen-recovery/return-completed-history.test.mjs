// Generated from tests/user-journeys/06-close-reopen-recovery/return-completed-history.yaml. Review and commit this file like production code.
// productContract: visibleComposer=true visibleApprovals=true
// lifecycleChecks: visibleUi=true route=true durableState=true filesystem=true git=true
import { describe, it } from 'mocha';
import { runJourney } from "../../journeys/runJourney.mjs";

describe("Returning to completed History stays terminal", function () {
  this.timeout(12 * 60 * 1000);
  it("return-completed-history", async function () {
    await runJourney("return-completed-history");
  });
});
