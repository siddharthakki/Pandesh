import fs from 'node:fs';
import path from 'node:path';
import { discoverJourneyFiles, journeyRoot, loadJourney, repositoryRoot } from '../../src/ui-test/support/contract.mjs';

const generatedRoot = path.join(repositoryRoot, 'src', 'ui-test', 'generated');
const journeyCodeRoot = path.join(repositoryRoot, 'src', 'ui-test', 'journeys');
const forbidden = [
  ['direct runtime start', /\bstartAutonomousTask\s*\(/],
  ['synthetic production host message', /\bautonomousTaskStarted\b/],
  ['direct approval host call', /\bapproveAutonomous(?:Proposal|Mutation|Delivery)\b/],
  ['synthetic webview host message', /\bvscode\s*\.\s*postMessage\b/],
  ['preclassified execution profile', /\buseDeterministicProposal\b|\bexecutionProfile\s*:/],
  ['seeded approval', /\bseed(?:ed|Approval|Approvals)\b/i],
  ['mocked host', /\bMock(?:Host|Runtime)\b|\bfakeRuntime\b/i],
  ['mocked successful delivery', /\bmock(?:ed)?DeliverySuccess\b/i],
  ['activation-only acceptance', /\bactivationOnly\b/i],
];

const yamlFiles = discoverJourneyFiles();
for (const file of yamlFiles) loadJourney(path.basename(file, '.yaml'));

const codeFiles = [];
for (const root of [generatedRoot, journeyCodeRoot]) {
  if (!fs.existsSync(root)) continue;
  const visit = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.name.endsWith('.mjs')) codeFiles.push(absolute);
    }
  };
  visit(root);
}
for (const file of codeFiles) {
  const source = fs.readFileSync(file, 'utf8');
  for (const [label, pattern] of forbidden) {
    if (pattern.test(source)) throw new Error(`${path.relative(repositoryRoot, file)} bypasses installed-product acceptance: ${label}`);
  }
}
for (const file of codeFiles.filter(file => file.endsWith('.test.mjs'))) {
  const source = fs.readFileSync(file, 'utf8');
  if (!source.includes('visibleComposer=true')) throw new Error(`${file} lacks the visible-composer contract marker`);
  if (!source.includes('durableState=true filesystem=true git=true')) throw new Error(`${file} lacks lifecycle postcondition markers`);
  if (!source.includes("runJourney(")) throw new Error(`${file} does not use the reviewed visible-journey runner`);
}
console.log(`Validated ${yamlFiles.length} journey contracts and ${codeFiles.length} installed-product test files; no UI bypasses found.`);
