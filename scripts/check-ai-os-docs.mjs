#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const args = new Set(process.argv.slice(2));
const strict = args.has('--strict') || process.env.AI_OS_STRICT_DOCS === '1';
const showInventory = args.has('--inventory') || strict;

const allowedAiOsFiles = [
  'AI_OS.md',
  'AI_OS_AGENT_RULES.md',
  'AI_OS_ARCHITECTURE.md',
  'AI_OS_GOVERNANCE.md',
  'AI_OS_HISTORY.md',
  'AI_OS_INDEX.md',
  'AI_OS_PRODUCTS.md',
  'AI_OS_ROADMAP.md',
  'AI_OS_STATE.md',
].sort();

const requiredFiles = [
  ...allowedAiOsFiles,
  'AGENTS.md',
  'HANDOFF.md',
  'docs/README.md',
];

const errors = [];
const warnings = [];

function rel(file) {
  return path.relative(root, file).split(path.sep).join('/');
}

function read(relativePath) {
  const absolute = path.join(root, relativePath);
  if (!fs.existsSync(absolute)) {
    errors.push(`Missing required file: ${relativePath}`);
    return '';
  }
  return fs.readFileSync(absolute, 'utf8');
}

function marker(text, name, file) {
  const match = text.match(new RegExp(`<!--\\s*ai-os-current-${name}:\\s*([^>]+?)\\s*-->`, 'i'));
  if (!match) {
    errors.push(`${file} is missing ai-os-current-${name} marker`);
    return undefined;
  }
  return match[1].trim();
}

function markdownLinks(text) {
  const links = [];
  const pattern = /\[[^\]]*\]\(([^)]+)\)/g;
  for (const match of text.matchAll(pattern)) links.push(match[1].trim());
  return links;
}

function normalizedLocalTarget(relativePath, rawTarget) {
  let target = rawTarget;
  if (!target || target.startsWith('#') || /^(?:https?:|mailto:)/i.test(target)) return undefined;
  if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1);
  target = target.split(/\s+["']/)[0];
  target = target.split('#')[0].split('?')[0];
  if (!target) return undefined;
  let decoded = target;
  try {
    decoded = decodeURIComponent(target);
  } catch {
    // Malformed percent-encoding (e.g. a literal '%' in a third-party doc) — treat as a literal path.
  }
  return path.resolve(root, path.dirname(relativePath), decoded);
}

function checkLocalLinks(relativePath, text) {
  for (const target of markdownLinks(text)) {
    const absolute = normalizedLocalTarget(relativePath, target);
    if (absolute && !fs.existsSync(absolute)) errors.push(`Broken local link in ${relativePath}: ${target}`);
  }
}

function referencesFile(candidate, targetFile, targetRelative) {
  if (candidate.content.includes(targetRelative)) return true;
  return markdownLinks(candidate.content).some(link =>
    normalizedLocalTarget(candidate.relative, link) === targetFile,
  );
}

function walk(directory, excluded = new Set()) {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (excluded.has(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(absolute, excluded));
    else files.push(absolute);
  }
  return files;
}

for (const file of requiredFiles) read(file);

const state = read('AI_OS_STATE.md');
const handoff = read('HANDOFF.md');
const stateBranch = marker(state, 'branch', 'AI_OS_STATE.md');
const handoffBranch = marker(handoff, 'branch', 'HANDOFF.md');
const stateMilestone = marker(state, 'milestone', 'AI_OS_STATE.md');
const handoffMilestone = marker(handoff, 'milestone', 'HANDOFF.md');

if (stateBranch && handoffBranch && stateBranch !== handoffBranch) {
  errors.push(`Branch disagreement: AI_OS_STATE.md=${stateBranch}, HANDOFF.md=${handoffBranch}`);
}
if (stateMilestone && handoffMilestone && stateMilestone !== handoffMilestone) {
  errors.push(`Milestone disagreement: AI_OS_STATE.md=${stateMilestone}, HANDOFF.md=${handoffMilestone}`);
}

const handoffLines = handoff.split(/\r?\n/).length;
const stateLines = state.split(/\r?\n/).length;
if (handoffLines > 120) errors.push(`HANDOFF.md is ${handoffLines} lines; maximum is 120`);
if (stateLines > 100) errors.push(`AI_OS_STATE.md is ${stateLines} lines; maximum is 100`);

const actualAiOsFiles = fs.readdirSync(root)
  .filter(name => /^AI_OS(?:_.*)?\.md$/i.test(name))
  .sort();
if (JSON.stringify(actualAiOsFiles) !== JSON.stringify(allowedAiOsFiles)) {
  errors.push(`AI OS root document set differs from the allowed nine. Found: ${actualAiOsFiles.join(', ')}`);
}

for (const relativePath of requiredFiles) {
  const absolute = path.join(root, relativePath);
  if (fs.existsSync(absolute)) checkLocalLinks(relativePath, fs.readFileSync(absolute, 'utf8'));
}

const excludedDirectories = new Set([
  '.git',
  '.ollama-agent',
  '.acceptance-evidence',
  '.vscode-test',
  'node_modules',
  'out',
  'dist',
  'coverage',
]);
const textExtensions = new Set(['.md', '.ts', '.tsx', '.js', '.mjs', '.cjs', '.json', '.yml', '.yaml']);
const repositoryTextFiles = walk(root, excludedDirectories)
  .filter(file => textExtensions.has(path.extname(file).toLowerCase()));
const repositoryTexts = repositoryTextFiles.map(file => ({
  file,
  relative: rel(file),
  content: fs.readFileSync(file, 'utf8'),
}));

const docsFiles = walk(path.join(root, 'docs'))
  .filter(file => path.extname(file).toLowerCase() === '.md')
  .sort();
for (const file of docsFiles) checkLocalLinks(rel(file), fs.readFileSync(file, 'utf8'));

const activeMilestoneDoc = 'docs/m39-memory-knowledge-intelligence.md';
const inventory = docsFiles.map(file => {
  const relative = rel(file);
  const fixture = relative.startsWith('docs/examples/');
  const references = repositoryTexts.filter(candidate => {
    if (candidate.file === file) return false;
    return referencesFile(candidate, file, relative);
  }).map(candidate => candidate.relative);
  const exempt = relative === activeMilestoneDoc || relative === 'docs/README.md' || fixture;
  return {
    file: relative,
    references: references.length,
    active: relative === activeMilestoneDoc,
    fixture,
    staleCandidate: !exempt && references.length === 0,
  };
});

const staleCandidates = inventory.filter(item => item.staleCandidate);
if (staleCandidates.length) {
  warnings.push(`${staleCandidates.length} unreferenced document(s) require review`);
  if (strict) {
    for (const item of staleCandidates) errors.push(`Unreferenced document candidate: ${item.file}`);
  }
}

if (showInventory) {
  console.log('\nDocumentation inventory');
  console.log('-----------------------');
  for (const item of inventory) {
    const status = item.active ? 'ACTIVE' : item.fixture ? 'FIXTURE' : item.staleCandidate ? 'STALE?' : 'KEEP/REVIEW';
    console.log(`${status.padEnd(11)} refs=${String(item.references).padStart(2)}  ${item.file}`);
  }
}

for (const warning of warnings) console.warn(`WARNING: ${warning}`);
if (errors.length) {
  console.error('\nAI OS documentation contract failed:');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`AI OS documentation contract passed (${handoffLines} handoff lines, ${stateLines} state lines, ${docsFiles.length} docs files).`);
if (staleCandidates.length && !strict) {
  console.log('Run with --inventory to inspect candidates and --strict after reviewed cleanup.');
}
