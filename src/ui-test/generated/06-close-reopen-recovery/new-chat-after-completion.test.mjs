// Generated from tests/user-journeys/06-close-reopen-recovery/new-chat-after-completion.yaml. Review and commit this file like production code.
// productContract: visibleComposer=true visibleApprovals=true
// lifecycleChecks: visibleUi=true route=true durableState=true filesystem=true git=true
import { describe, it } from 'mocha';
import { runJourney } from "../../journeys/runJourney.mjs";

describe("New chat after completion owns an empty composer", function () {
  this.timeout(12 * 60 * 1000);
  it("new-chat-after-completion", async function () {
    await runJourney("new-chat-after-completion");
  });
});
