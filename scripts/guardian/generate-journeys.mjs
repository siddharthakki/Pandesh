import fs from 'node:fs';
import path from 'node:path';
import { discoverJourneyFiles, journeyRoot, loadJourney, repositoryRoot } from '../../src/ui-test/support/contract.mjs';

const outputRoot = path.join(repositoryRoot, 'src', 'ui-test', 'generated');
const check = process.argv.includes('--check');
const files = discoverJourneyFiles();
const expected = new Map();

for (const file of files) {
  const id = path.basename(file, '.yaml');
  const journey = loadJourney(id);
  const target = path.join(outputRoot, journey.generatedRelativePath);
  let runnerImport = path.relative(
    path.dirname(target),
    path.join(repositoryRoot, 'src', 'ui-test', 'journeys', 'runJourney.mjs'),
  ).replaceAll(path.sep, '/');
  if (!runnerImport.startsWith('.')) runnerImport = `./${runnerImport}`;
  const source = `// Generated from tests/user-journeys/${journey.contractRelativePath}. Review and commit this file like production code.\n`
    + `// productContract: visibleComposer=true visibleApprovals=${journey.negativeControl === 'expected-failure' ? 'not-applicable' : 'true'}\n`
    + `// lifecycleChecks: visibleUi=true route=true durableState=true filesystem=true git=true\n`
    + `import { describe, it } from 'mocha';\n`
    + `import { runJourney } from ${JSON.stringify(runnerImport)};\n\n`
    + `describe(${JSON.stringify(journey.title)}, function () {\n`
    + `  this.timeout(12 * 60 * 1000);\n`
    + `  it(${JSON.stringify(journey.id)}, async function () {\n`
    + `    await runJourney(${JSON.stringify(journey.id)});\n`
    + `  });\n`
    + `});\n`;
  expected.set(journey.generatedRelativePath, source);
}

if (!check) fs.mkdirSync(outputRoot, { recursive: true });
const failures = [];
for (const [name, source] of expected) {
  const target = path.join(outputRoot, name);
  if (check) {
    const existing = fs.existsSync(target) ? fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n') : null;
    if (existing !== source.replace(/\r\n/g, '\n')) failures.push(name);
  } else {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, source, 'utf8');
  }
}

if (check && fs.existsSync(outputRoot)) {
  const generated = [];
  const visit = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.name.endsWith('.test.mjs')) generated.push(path.relative(outputRoot, absolute));
    }
  };
  visit(outputRoot);
  for (const file of generated) {
    if (!expected.has(file)) failures.push(`stale:${file}`);
  }
}
if (failures.length) {
  throw new Error(`Generated guardian tests are stale: ${failures.join(', ')}. Run npm run test:guardian:generate.`);
}
console.log(`${check ? 'Validated' : 'Generated'} ${expected.size} installed-product journey test skeletons.`);
