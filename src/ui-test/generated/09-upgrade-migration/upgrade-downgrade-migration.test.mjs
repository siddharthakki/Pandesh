// Generated from tests/user-journeys/09-upgrade-migration/upgrade-downgrade-migration.yaml. Review and commit this file like production code.
// productContract: visibleComposer=true visibleApprovals=true
// lifecycleChecks: visibleUi=true route=true durableState=true filesystem=true git=true
import { describe, it } from 'mocha';
import { runJourney } from "../../journeys/runJourney.mjs";

describe("Existing-profile upgrade migrates durable state and defines downgrade behavior", function () {
  this.timeout(12 * 60 * 1000);
  it("upgrade-downgrade-migration", async function () {
    await runJourney("upgrade-downgrade-migration");
  });
});
