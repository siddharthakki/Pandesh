import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RepoFastPath, planRepoQuery } from '../../repository/RepoFastPath';
import {
  WORKSPACE_ACCESS_GUIDANCE, answerAsksUserToFetchRepoFiles, architectureSufficiency, buildImplementationStemIndex, classifyEvidencePath, deriveSubsystemTerms,
  findExpansionTargets, isArchitectureSubsystemQuestion, isRepositoryOverviewQuestion, isWrapperEvidencePath, overviewSufficiency, parseLocalImportSpecifiers,
  rankArchitectureEvidence, resolveLocalImport, selectArchitectureEvidence, summarizePackageJson,
} from '../../repository/RepoEvidencePlans';
import { classifyTerminalOutcome } from '../../ui/executionProjection';

function git(root: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: root, stdio: 'ignore' });
}

function makeRepo(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plans-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  git(root, 'init', '-q');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'init');
  return root;
}

const FILLER = Array.from({ length: 40 }, (_, i) => `// filler line ${i}`).join('\n');

const EXTENSION_REPO: Record<string, string> = {
  'README.md': '# Demo Agent\n\nA coding-agent extension for VS Code that plans, edits and verifies changes under governance.\n',
  'package.json': JSON.stringify({
    name: 'demo-agent', displayName: 'Demo Agent', version: '1.0.0', main: './out/extension.js', engines: { vscode: '^1.90.0' },
    activationEvents: ['onStartupFinished'], contributes: { commands: [{ command: 'demo.start', title: 'Start Demo Agent' }], views: { sidebar: [{ id: 'demo.chat' }] } },
    scripts: { compile: 'tsc -p ./', test: 'vitest' }, dependencies: { zod: '^3.0.0' },
  }),
  'src/extension.ts': `import * as vscode from 'vscode';\nexport function activate(context: vscode.ExtensionContext) {\n  context.subscriptions.push(vscode.commands.registerCommand('demo.start', () => undefined));\n}\n${FILLER}\n`,
  'src/governance/GovernancePolicy.ts': `export interface GovernancePolicy { allow: string[] }\nexport function evaluateGovernance(policy: GovernancePolicy, tool: string): boolean {\n  return policy.allow.includes(tool);\n}\n${FILLER}\n`,
  'src/governance/ApprovalGate.ts': `export class ApprovalGate {\n  requestApproval(tool: string) { return tool.length > 0; }\n  // governance: every consequential tool call passes this gate\n}\n${FILLER}\n`,
  'src/runtime/executor.ts': `import { evaluateGovernance } from '../governance/GovernancePolicy';\nexport function execute(tool: string) { return evaluateGovernance({ allow: [] }, tool); }\n${FILLER}\n`,
  'media/chat.html': '<html><body><div class="chip">Governance</div><div id="governance-status">Governance: supervised</div></body></html>\n',
  'media/chat.js': "const chip = document.querySelector('.chip'); // governance chip\n",
  'docs/architecture.md': '# Architecture\n\nGovernance decides which tool calls need approval.\n',
};

describe('query classification', () => {
  it('recognises REPOSITORY_OVERVIEW phrasing', () => {
    for (const q of [
      'what does this project do',
      'what does this project do. Describe in 200 words',
      'explain this repository',
      'summarize this repo',
      'what is this codebase',
      'how is this project structured',
      'give me an overview of this project',
    ]) {
      expect(isRepositoryOverviewQuestion(q), q).toBe(true);
      expect(planRepoQuery(q).type, q).toBe('overview');
    }
  });

  it('recognises ARCHITECTURE_SUBSYSTEM phrasing and derives subsystem terms', () => {
    for (const q of ['how does governance work', 'how does the governance work here', 'how does approval work', 'how does routing work', 'how does persistence work', 'how does validation work']) {
      expect(isArchitectureSubsystemQuestion(q), q).toBe(true);
      expect(planRepoQuery(q).type, q).toBe('architecture');
    }
    const terms = deriveSubsystemTerms('how does the governance work here');
    expect(terms.primary).toContain('govern');
    expect(terms.primary).not.toContain('here');
    // related concepts are stemmed so approval / approve / approved all match one literal term
    for (const concept of ['policy', 'approv', 'permiss', 'gate', 'valid', 'state', 'attempt']) expect(terms.expanded).toContain(concept);
  });

  it('does not treat unrelated questions as these plans', () => {
    expect(isRepositoryOverviewQuestion('what is 2 + 2')).toBe(false);
    expect(isArchitectureSubsystemQuestion('how do I install node')).toBe(false);
    expect(planRepoQuery('fix the failing test in executor.ts').type).not.toBe('architecture');
  });
});

describe('architecture ranking and sufficiency (pure)', () => {
  const rank = (hits: Array<{ path: string; line: number; excerpt: string }>, pathMatches: string[] = []) =>
    rankArchitectureEvidence({ primary: ['govern'], expanded: [], hits, symbolPaths: [], pathMatches });

  it('ranks implementation source above UI mentions even when the UI mentions it more often', () => {
    const ranked = rank([
      ...Array.from({ length: 6 }, (_, i) => ({ path: 'media/chat.html', line: i + 1, excerpt: `<div>Governance ${i}</div>` })),
      { path: 'src/governance/GovernancePolicy.ts', line: 2, excerpt: 'export function evaluateGovernance(policy: GovernancePolicy)' },
    ]);
    expect(classifyEvidencePath('media/chat.html')).toBe('ui');
    expect(classifyEvidencePath('src/governance/GovernancePolicy.ts')).toBe('implementation');
    expect(ranked[0].path).toBe('src/governance/GovernancePolicy.ts');
    expect(ranked.findIndex(r => r.path === 'media/chat.html')).toBeGreaterThan(0);
  });

  it('a UI label alone is insufficient; implementation files make it sufficient', () => {
    const uiOnly = selectArchitectureEvidence(rank([{ path: 'media/chat.html', line: 1, excerpt: '<div>Governance</div>' }]));
    expect(uiOnly.uiOnly).toBe(true);
    expect(architectureSufficiency(uiOnly, 0).sufficient).toBe(false);

    const withImpl = selectArchitectureEvidence(rank([
      { path: 'src/a/Governance.ts', line: 1, excerpt: 'export class Governance {}' },
      { path: 'src/b/governed.ts', line: 3, excerpt: 'export function governed() {}' },
      { path: 'media/chat.html', line: 1, excerpt: '<div>Governance</div>' },
    ]));
    expect(withImpl.implementationSelected).toBe(2);
    expect(architectureSufficiency(withImpl, 4).sufficient).toBe(true);
    expect(architectureSufficiency(withImpl, 1).sufficient).toBe(false);
  });

  it('overview sufficiency requires README, manifest, tree and entrypoint when the workspace has them', () => {
    const ok = { readmeAvailable: true, readmeIncluded: true, manifestAvailable: true, manifestIncluded: true, treeIncluded: true, entrypointAvailable: true, entrypointIncluded: true };
    expect(overviewSufficiency(ok).sufficient).toBe(true);
    expect(overviewSufficiency({ ...ok, entrypointIncluded: false }).sufficient).toBe(false);
    expect(overviewSufficiency({ ...ok, readmeAvailable: false, readmeIncluded: false }).sufficient).toBe(true);
    expect(overviewSufficiency({ ...ok, manifestIncluded: false }).reason).toMatch(/manifest/);
  });

  it('summarizes a package.json compactly, including what kind of project it declares itself to be', () => {
    const summary = summarizePackageJson(EXTENSION_REPO['package.json'])!;
    expect(summary).toMatch(/engines: vscode/);
    expect(summary).toMatch(/contributes: commands\(1\)/);
    expect(summary).toMatch(/example commands: Start Demo Agent/);
    expect(summary.length).toBeLessThan(1_200);
  });
});

describe('workspace access honesty', () => {
  it('flags an answer that hands repository retrieval back to the user', () => {
    expect(answerAsksUserToFetchRepoFiles('If you can pull the status-details-popover markup or any permissions/governance module, I can explain it.')).toBe(true);
    expect(answerAsksUserToFetchRepoFiles('Please paste the contents of the file so I can check.')).toBe(true);
    expect(answerAsksUserToFetchRepoFiles('Governance in this repo is enforced by evaluateGovernance, which checks the allow list.')).toBe(false);
  });

  it('a Baat Kar repository turn that asks the user to fetch files is not "completed"', () => {
    const answer = 'If you can pull the status-details-popover markup or any permissions/governance module, I can describe the implementation.';
    expect(classifyTerminalOutcome({ baatKarRepositoryTurn: true, answer }).outcome).toBe('blocked');
    expect(classifyTerminalOutcome({ baatKarRepositoryTurn: false, answer }).outcome).toBe('completed');
  });
});

describe('REPOSITORY_OVERVIEW evidence pack', () => {
  let root = '';
  beforeAll(() => { root = makeRepo(EXTENSION_REPO); });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it('uses README + manifest + tree + entrypoint evidence, not one lexical UI hit', async () => {
    const result = await new RepoFastPath(root).repoQuery('what does this project do. Describe in 200 words', { maxChars: 20_000 });
    expect(result).toBeDefined();
    expect(result!.type).toBe('overview');
    const paths = result!.files.map(file => file.path);
    expect(paths).toContain('README.md');
    expect(paths).toContain('package.json');
    expect(paths).toContain('src/extension.ts');
    expect(paths).not.toEqual(['media/chat.html']);
    expect(result!.prompt).toMatch(/REPOSITORY_OVERVIEW/);
    expect(result!.prompt).toMatch(/engines: vscode/);
    expect(result!.prompt).toMatch(/workspace tree/);
    expect(result!.prompt).toMatch(/README MISSING|README included/);
    expect(result!.prompt).toContain('README included');
    expect(result!.prompt).toContain('entrypoint included');
    expect(result!.prompt).toContain(WORKSPACE_ACCESS_GUIDANCE);
    expect(result!.prompt.length).toBeLessThan(20_000);
  });

  it('puts the README first, then the manifest, then the tree, then entrypoints', async () => {
    const { prompt } = (await new RepoFastPath(root).repoQuery('explain this repository', { maxChars: 20_000 }))!;
    const at = (needle: string) => prompt.indexOf(needle);
    expect(at('--- README.md')).toBeGreaterThan(-1);
    expect(at('--- README.md')).toBeLessThan(at('--- package.json'));
    expect(at('--- package.json')).toBeLessThan(at('--- workspace tree'));
    expect(at('--- workspace tree')).toBeLessThan(at('--- src/extension.ts'));
  });

  it('widens the search itself when the root has no README or manifest', async () => {
    const nested = makeRepo({
      'tools/cli/README.md': '# Tool\n\nA command line tool.\n',
      'tools/cli/pyproject.toml': '[project]\nname = "tool"\n',
      'tools/cli/main.py': 'print("hi")\n',
      'notes.txt': 'notes\n',
    });
    try {
      const result = await new RepoFastPath(nested).repoQuery('what is this codebase', { maxChars: 12_000 });
      expect(result!.files.map(file => file.path)).toEqual(expect.arrayContaining(['tools/cli/README.md', 'tools/cli/pyproject.toml']));
      expect(result!.prompt).toMatch(/pass 2/);
    } finally { fs.rmSync(nested, { recursive: true, force: true }); }
  });
});

describe('ARCHITECTURE_SUBSYSTEM evidence pack', () => {
  let root = '';
  beforeAll(() => { root = makeRepo(EXTENSION_REPO); });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it('expands beyond a UI occurrence and ranks implementation above the UI label', async () => {
    const result = await new RepoFastPath(root).repoQuery('how does the governance work here', { maxChars: 20_000 });
    expect(result).toBeDefined();
    expect(result!.type).toBe('architecture');
    const paths = result!.files.map(file => file.path);
    const implementation = paths.filter(file => classifyEvidencePath(file) === 'implementation');
    expect(implementation.length).toBeGreaterThanOrEqual(2);
    expect(implementation).toEqual(expect.arrayContaining(['src/governance/GovernancePolicy.ts', 'src/governance/ApprovalGate.ts']));
    const firstUi = paths.findIndex(file => classifyEvidencePath(file) === 'ui');
    if (firstUi >= 0) expect(firstUi).toBeGreaterThan(paths.findIndex(file => classifyEvidencePath(file) === 'implementation'));
    expect(paths[0]).not.toBe('media/chat.html');
    expect(result!.prompt).toContain(WORKSPACE_ACCESS_GUIDANCE);
    expect(result!.prompt).toMatch(/ARCHITECTURE_SUBSYSTEM/);
  });

  it('performs a second, wider pass by itself when the first pass finds only UI mentions', async () => {
    const uiHeavy = makeRepo({
      'media/chat.html': '<div class="chip">Governance</div>\n<div>Governance details</div>\n',
      'src/policy/PolicyEngine.ts': `export class PolicyEngine {\n  decide(action: string) { return action === 'read'; }\n}\n${FILLER}\n`,
      'src/approval/ApprovalQueue.ts': `export class ApprovalQueue {\n  enqueue(action: string) { return [action]; }\n}\n${FILLER}\n`,
      'src/permission/PermissionGate.ts': `export function permissionGate(scope: string) { return scope; }\n${FILLER}\n`,
    });
    try {
      const result = await new RepoFastPath(uiHeavy).repoQuery('how does governance work', { maxChars: 20_000 });
      expect(result!.type).toBe('architecture');
      const paths = result!.files.map(file => file.path);
      expect(paths.some(file => file.startsWith('src/'))).toBe(true);
      expect(result!.prompt).toMatch(/pass 2 \(subject \+ related concepts\)/);
    } finally { fs.rmSync(uiHeavy, { recursive: true, force: true }); }
  });

  it('says honestly that evidence is thin (and never tells the user to paste files) when only UI matched', async () => {
    const onlyUi = makeRepo({ 'media/chat.html': '<div>Governance</div>\n', 'src/other.ts': 'export const x = 1;\n' });
    try {
      const result = await new RepoFastPath(onlyUi).repoQuery('how does governance work', { maxChars: 8_000 });
      expect(result).toBeDefined();
      expect(result!.prompt).toMatch(/implementation evidence is still thin/);
      expect(result!.prompt).toMatch(/do not ask the user to find or paste files/);
    } finally { fs.rmSync(onlyUi, { recursive: true, force: true }); }
  });
});

const FORGE_REPO: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'forge', main: './out/extension.js' }),
  'src/demo/GovernedForgeDemoController.ts': [
    "import { ForgeRpcRegistration } from '../forge/ForgeRpcRegistration';",
    "import { AgentRuntime } from '../forge/AgentRuntime';",
    "import { LocalRpcServer } from '../forge/LocalRpcServer';",
    "export class GovernedForgeDemoController {",
    "  // governance demo: wires the runtime and shows governed output",
    "  start() { return [ForgeRpcRegistration, AgentRuntime, LocalRpcServer]; }",
    '}',
    FILLER,
  ].join('\n'),
  'src/forge/ForgeRpcRegistration.ts': `export class ForgeRpcRegistration {\n  register(method: string) { return method; }\n}\n${FILLER}\n`,
  'src/forge/AgentRuntime.ts': [
    "import { SessionLedger } from './SessionLedger';",
    "import { PolicyEnforcer } from '../safety/PolicyEnforcer';",
    'export class AgentRuntime {',
    '  run(tool: string) { return new PolicyEnforcer().decide(tool) && new SessionLedger().record(tool); }',
    '}',
    FILLER,
  ].join('\n'),
  'src/forge/LocalRpcServer.ts': `export class LocalRpcServer {\n  // every call is checked against policy before dispatch\n  handle(method: string) { return method; }\n}\n${FILLER}\n`,
  'src/forge/SessionLedger.ts': `export class SessionLedger {\n  record(entry: string) { return [entry]; }\n}\n${FILLER}\n`,
  'src/safety/PolicyEnforcer.ts': `export class PolicyEnforcer {\n  decide(tool: string) { return tool === 'read'; }\n}\n${FILLER}\n`,
  'media/chat.html': '<div class="chip">Governance</div>\n',
};

describe('ARCHITECTURE_SUBSYSTEM import expansion', () => {
  let root = '';
  beforeAll(() => { root = makeRepo(FORGE_REPO); });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it('parses and resolves workspace-local imports and symbol references (pure)', () => {
    const files = new Set(Object.keys(FORGE_REPO));
    const source = FORGE_REPO['src/forge/AgentRuntime.ts'];
    expect(parseLocalImportSpecifiers(source)).toEqual(['./SessionLedger', '../safety/PolicyEnforcer']);
    expect(resolveLocalImport('src/forge/AgentRuntime.ts', '../safety/PolicyEnforcer', files)).toBe('src/safety/PolicyEnforcer.ts');
    expect(resolveLocalImport('src/forge/AgentRuntime.ts', 'vscode', files)).toBeUndefined();
    const stems = buildImplementationStemIndex(files);
    const targets = findExpansionTargets('src/demo/GovernedForgeDemoController.ts', 'const r = new LocalRpcServer(); // uses SessionLedger', files, stems);
    expect(targets.map(t => t.path)).toEqual(expect.arrayContaining(['src/forge/LocalRpcServer.ts', 'src/forge/SessionLedger.ts']));
    expect(targets.every(t => t.via === 'reference')).toBe(true);
  });

  it('follows implementation imports one and two hops from the first implementation file', async () => {
    const result = (await new RepoFastPath(root).repoQuery('how does governance work', { maxChars: 24_000 }))!;
    const paths = result.files.map(file => file.path);
    for (const hopOne of ['src/forge/ForgeRpcRegistration.ts', 'src/forge/AgentRuntime.ts', 'src/forge/LocalRpcServer.ts']) expect(paths, hopOne).toContain(hopOne);
    expect(paths).toContain('src/forge/SessionLedger.ts'); // reachable only through AgentRuntime (hop 2); matches no subsystem term
    expect(paths).toContain('src/safety/PolicyEnforcer.ts');
    expect(result.prompt).toMatch(/AgentRuntime\.ts → SessionLedger\.ts \(import, hop 2\)/);
  });

  it('does not treat the demo/controller wrapper as the final implementation', async () => {
    expect(isWrapperEvidencePath('src/demo/GovernedForgeDemoController.ts')).toBe(true);
    expect(isWrapperEvidencePath('src/forge/AgentRuntime.ts')).toBe(false);
    const result = (await new RepoFastPath(root).repoQuery('how does governance work', { maxChars: 24_000 }))!;
    const nonWrapper = result.files.map(file => file.path).filter(file => classifyEvidencePath(file) === 'implementation' && !isWrapperEvidencePath(file));
    expect(nonWrapper.length).toBeGreaterThanOrEqual(3);
  });

  it('is insufficient with one implementation file while more resolvable implementation targets exist (pure)', () => {
    const one = selectArchitectureEvidence([{ path: 'src/demo/GovernedForgeDemoController.ts', cls: 'implementation', score: 9, lines: [4], reasons: ['definition'] }]);
    expect(one.wrapperOnly).toBe(true);
    expect(architectureSufficiency(one, 2).sufficient).toBe(true); // legacy contract: nothing else known
    const pending = architectureSufficiency(one, 2, { resolvable: 3, retrieved: 0 });
    expect(pending.sufficient).toBe(false);
    expect(pending.reason).toMatch(/3 resolvable implementation targets not retrieved/);
    const extras = [
      { path: 'src/forge/AgentRuntime.ts', cls: 'implementation' as const, score: 5, lines: [3], reasons: ['import'] },
      { path: 'src/forge/LocalRpcServer.ts', cls: 'implementation' as const, score: 4, lines: [1], reasons: ['import'] },
    ];
    const withExtras = selectArchitectureEvidence([{ path: 'src/demo/GovernedForgeDemoController.ts', cls: 'implementation', score: 9, lines: [4], reasons: ['definition'] }], undefined, extras);
    expect(withExtras.implementationSelected).toBe(3);
    expect(architectureSufficiency(withExtras, 4, { resolvable: 2, retrieved: 2 }).sufficient).toBe(true);
    // a wrapper plus unretrieved imports stays insufficient even with two wrapper-ish files
    expect(architectureSufficiency({ ...withExtras, wrapperOnly: true }, 4, { resolvable: 2, retrieved: 1 }).sufficient).toBe(false);
  });

  it('delivers multiple implementation files, a sufficient verdict, and no "host could not retrieve" for modules present in the workspace', async () => {
    const result = (await new RepoFastPath(root).repoQuery('how does governance work', { maxChars: 24_000 }))!;
    const implementation = result.files.map(file => file.path).filter(file => classifyEvidencePath(file) === 'implementation');
    expect(implementation.length).toBeGreaterThanOrEqual(4);
    expect(result.evidenceVerdict?.sufficient).toBe(true);
    expect(result.prompt).not.toMatch(/implementation evidence is still thin|couldn'?t retrieve|could not retrieve/i);
    expect(result.prompt).toMatch(/Modules the host followed from the selected files' imports\/references:/);
  });

  it('an insufficient architecture packet cannot end the turn as Completed', async () => {
    const onlyUi = makeRepo({ 'media/chat.html': '<div>Governance</div>\n', 'src/other.ts': 'export const x = 1;\n' });
    try {
      const result = (await new RepoFastPath(onlyUi).repoQuery('how does governance work', { maxChars: 8_000 }))!;
      expect(result.evidenceVerdict?.sufficient).toBe(false);
      const ending = classifyTerminalOutcome({ baatKarRepositoryTurn: true, evidenceGap: result.evidenceVerdict!.reason, answer: 'Governance is shown as a chip in the UI.' });
      expect(ending.outcome).toBe('blocked');
      expect(ending.detail).toMatch(/Implementation evidence was incomplete/);
      expect(classifyTerminalOutcome({ baatKarRepositoryTurn: true, answer: 'Governance is enforced by PolicyEnforcer.' }).outcome).toBe('completed');
    } finally { fs.rmSync(onlyUi, { recursive: true, force: true }); }
  });
});

describe('follow-up retrieval', () => {
  let root = '';
  beforeAll(() => { root = makeRepo(EXTENSION_REPO); });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it('keeps the previous topic as context but may retrieve files the previous turn never read', async () => {
    const fast = new RepoFastPath(root);
    const first = await fast.repoQuery('what is in media/chat.html', { maxChars: 20_000 });
    expect(first!.files.map(file => file.path)).toContain('media/chat.html');
    const followUp = await fast.repoQuery('how does the governance work here', { maxChars: 20_000, hotFiles: ['media/chat.html'] });
    const paths = followUp!.files.map(file => file.path);
    expect(paths.some(file => file.startsWith('src/governance/'))).toBe(true);
    expect(paths.filter(file => file !== 'media/chat.html').length).toBeGreaterThanOrEqual(2);
    expect(followUp!.prompt).toMatch(/follows an earlier question[^\n]*media\/chat\.html/);
    expect(followUp!.prompt).toMatch(/a hint only/);
  });

  it('New Chat clears the previous topic and evidence hints', async () => {
    const fast = new RepoFastPath(root);
    await fast.repoQuery('what is in media/chat.html', { maxChars: 20_000 });
    fast.resetConversationState();
    const fresh = await fast.repoQuery('how does the governance work here', { maxChars: 20_000 });
    expect(fresh!.prompt).not.toMatch(/follows an earlier question/);
  });
});
