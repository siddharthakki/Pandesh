import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

export const repositoryRoot = path.resolve(import.meta.dirname, '..', '..', '..');
export const journeyRoot = path.join(repositoryRoot, 'tests', 'user-journeys');

export function discoverJourneyFiles(root = journeyRoot) {
  const files = [];
  const visit = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.name.endsWith('.yaml')) files.push(absolute);
    }
  };
  visit(root);
  return files;
}

export function loadJourney(id) {
  const matches = discoverJourneyFiles().filter(file => path.basename(file, '.yaml') === id);
  if (matches.length !== 1) {
    throw new Error(`Journey "${id}" resolved to ${matches.length} contracts`);
  }
  const file = matches[0];
  const journey = YAML.parse(fs.readFileSync(file, 'utf8'));
  validateJourney(journey, file);
  const relative = path.relative(journeyRoot, file);
  return {
    ...journey,
    contractPath: file,
    contractRelativePath: relative.replaceAll(path.sep, '/'),
    generatedRelativePath: relative.replace(/\.yaml$/, '.test.mjs'),
  };
}

export function validateJourney(journey, file = '<journey>') {
  const fail = message => {
    throw new Error(`${file}: ${message}`);
  };
  if (journey?.schemaVersion !== 2) fail('schemaVersion must be 2');
  for (const key of ['id', 'title', 'prompt', 'priority', 'driver', 'profilePolicy']) {
    if (typeof journey?.[key] !== 'string' || !journey[key].trim()) fail(`${key} must be a non-empty string`);
  }
  for (const key of ['suites', 'lifecycle', 'steps', 'assertions', 'evidence']) {
    if (!Array.isArray(journey?.[key]) || journey[key].length === 0) fail(`${key} must be a non-empty list`);
  }
  if (!journey.result || typeof journey.result !== 'object') fail('result must be defined');
  if (journey.driver === 'p1-lifecycle' && (!Number.isInteger(journey.p1Index) || journey.p1Index < 1 || journey.p1Index > 99)) {
    fail('P1 journeys must define an integer p1Index');
  }
  if (!['fresh', 'same'].includes(journey.profilePolicy)) fail('profilePolicy must be fresh or same');
  for (const check of ['visibleUi', 'route', 'durableState', 'filesystem', 'git']) {
    if (journey.checks?.[check] !== true) fail(`checks.${check} must be true`);
  }
  const stepText = journey.steps.join('\n').toLowerCase();
  if (!stepText.includes('visible unified composer')) fail('installed-product journeys must use the visible unified composer');
  if (!stepText.includes('visible') || !stepText.includes('send')) fail('installed-product journeys must use the visible Send control');
  if (journey.requiresApprovals && journey.negativeControl !== 'expected-failure' && !stepText.includes('visible controls')) {
    fail('mutating installed-product journeys must use visible approval controls');
  }
  if (journey.lifecycle.some(stage => /close|reopen|reload|upgrade|reinstall/i.test(stage))) {
    if (journey.checks.restartResult !== true) fail('restart lifecycle journeys must set checks.restartResult: true');
    if (journey.profilePolicy !== 'same') fail('persistence journeys must reuse the same profile');
  }
}
