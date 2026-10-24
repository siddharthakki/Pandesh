import { describe, it } from 'mocha';
import { SCENARIOS, runGolden } from './scenarios.mjs';

const name = process.env.GOLDEN_SCENARIO;
describe(`golden ${name}`, function () {
  this.timeout(90 * 60 * 1000);
  it(SCENARIOS[name]?.title ?? name, async function () {
    await runGolden(name);
  });
});
