import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RepoFastPath } from '../../repository/RepoFastPath';
import { allocateArchitectureBudget, classifyEvidencePath, interleaveModuleRanges, prioritizeExpansionTargets } from '../../repository/RepoEvidencePlans';

/**
 * Live UAT regression: import discovery found the downstream governance implementation, but the packet contained only the
 * seed controller. Resolved modules must be READ into the packet from a reserved budget, one range each before any gets a
 * second, preferring exact imports over loose references, and bounded to a small dependency trace.
 */

function makeRepo(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'expanded-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: root, stdio: 'ignore' });
  git('init', '-q'); git('add', '-A'); git('commit', '-q', '-m', 'init');
  return root;
}

const filler = (tag: string, lines = 30) => Array.from({ length: lines }, (_, i) => `// ${tag} filler ${i} ${'x'.repeat(70)}`).join('\n');

// The governance fixture mirrors the UAT: a large controller seed that imports the real implementation modules, plus many
// workspace files whose names merely appear as identifiers in the seed (the "candidate cloud").
const DOWNSTREAM = [
  ['src/forge/ForgeGovernedExecutionComposition.ts', 'ForgeGovernedExecutionComposition'],
  ['src/forge/GovernedModelExecutionDispatcher.ts', 'GovernedModelExecutionDispatcher'],
  ['src/forge/ProviderGatewayGovernedModelExecutionDependency.ts', 'ProviderGatewayGovernedModelExecutionDependency'],
  ['src/forge/ForgeRpcRegistration.ts', 'ForgeRpcRegistration'],
  ['src/forge/ForgeInvocationAdapter.ts', 'ForgeInvocationAdapter'],
  ['src/forge/ForgeCallableSurface.ts', 'ForgeCallableSurface'],
] as const;
const NOISE = Array.from({ length: 14 }, (_, i) => [`src/noise/UnrelatedHelper${String.fromCharCode(65 + i)}Module.ts`, `UnrelatedHelper${String.fromCharCode(65 + i)}Module`] as const);

function governanceFixture(): Record<string, string> {
  const files: Record<string, string> = { 'package.json': JSON.stringify({ name: 'forge', main: './out/extension.js' }) };
  const imports = DOWNSTREAM.map(([file, name]) => `import { ${name} } from '../forge/${path.posix.basename(file, '.ts')}';`);
  files['src/demo/GovernedForgeDemoController.ts'] = [
    ...imports,
    'export class GovernedForgeDemoController {',
    // a big seed: many governance definitions with long lines, so its own ranges are the largest thing in the packet
    ...Array.from({ length: 60 }, (_, i) => `  // governance step ${i}: ${'governed output shown by the demo controller '.repeat(3)}`),
    `  start() { return [${DOWNSTREAM.map(([, name]) => name).join(', ')}]; }`,
    `  // loosely mentions ${NOISE.map(([, name]) => name).join(' ')}`,
    '}',
  ].join('\n');
  for (const [file, name] of DOWNSTREAM) {
    files[file] = [`export class ${name} {`, `  // governance: SOURCE_MARKER_${name}`, `  run(input: string) { return input; }`, '}', filler(name)].join('\n');
  }
  for (const [file, name] of NOISE) files[file] = `export class ${name} {\n  value() { return 1; }\n}\n${filler(name, 10)}\n`;
  return files;
}

const sectionPaths = (prompt: string) => [...prompt.matchAll(/^--- ([^:\n]+):\d+-\d+ \[/gm)].map(match => match[1]);

describe('expanded module materialization (governance fixture)', () => {
  let root = '';
  beforeAll(() => { root = makeRepo(governanceFixture()); });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  // A small model window: the old shared budget let the seed controller consume everything.
  const ask = (maxChars: number) => new RepoFastPath(root).repoQuery('How does the governance work here? Trace the actual implementation, not just the UI.', { maxChars });

  it('reads resolved imported modules into the packet (source text, not just a trail entry)', async () => {
    const result = (await ask(12_000))!;
    const present = DOWNSTREAM.filter(([, name]) => result.prompt.includes(`SOURCE_MARKER_${name}`));
    expect(present.length, `modules with source in the packet: ${present.map(([, name]) => name)}`).toBeGreaterThanOrEqual(4);
    // the highest-signal modules named by the UAT are among them
    for (const name of ['GovernedModelExecutionDispatcher', 'ProviderGatewayGovernedModelExecutionDependency', 'ForgeGovernedExecutionComposition']) {
      expect(result.prompt, name).toContain(`SOURCE_MARKER_${name}`);
    }
    expect(result.evidenceVerdict?.sufficient).toBe(true);
  });

  it('keeps the packet bounded to the character budget even with a reserved expansion budget', async () => {
    const result = (await ask(12_000))!;
    expect(result.prompt.length).toBeLessThanOrEqual(12_000 + 2_500);
  });

  it('gives every selected expanded module one range before any module gets a second', async () => {
    const result = (await ask(16_000))!;
    const expanded = DOWNSTREAM.map(([file]) => file);
    const order = sectionPaths(result.prompt).filter(file => expanded.includes(file as typeof expanded[number]));
    const firstSeenAll = new Set<string>();
    let sawRepeatBeforeAll = false;
    const selected = new Set(order);
    const seen = new Set<string>();
    for (const file of order) {
      if (seen.has(file) && seen.size < selected.size) sawRepeatBeforeAll = true;
      seen.add(file); firstSeenAll.add(file);
    }
    expect(selected.size).toBeGreaterThanOrEqual(4);
    expect(sawRepeatBeforeAll).toBe(false);
  });

  it('follows direct imports and does not pull loosely referenced files into the trace', async () => {
    const result = (await ask(16_000))!;
    const followed = /Modules the host followed[^:]*: ([^\n]+?)\.(?:\n|$)/.exec(result.prompt)?.[1] ?? '';
    expect(followed).toMatch(/GovernedForgeDemoController\.ts → /);
    expect(followed).not.toMatch(/UnrelatedHelper/);
    expect(result.files.map(file => file.path).filter(file => file.startsWith('src/noise/'))).toEqual([]);
  });

  it('bounds the dependency trace to a small number of implementation modules', async () => {
    const result = (await ask(24_000))!;
    const implementation = result.files.map(file => file.path).filter(file => classifyEvidencePath(file) === 'implementation');
    expect(implementation.length).toBeLessThanOrEqual(9);
    expect(implementation.length).toBeGreaterThanOrEqual(5);
  });
});

describe('expansion planning (pure)', () => {
  const terms = { primary: ['govern'], expanded: ['policy'] };
  const cand = (p: string, via: 'import' | 'reference', score: number, matched = score > 0) => ({ path: p, via, from: 'src/seed.ts', score, matched });

  it('prefers exact imports over loose references and bounds a 100-file candidate cloud', () => {
    const cloud = Array.from({ length: 100 }, (_, i) => cand(`src/n/Noise${i}.ts`, 'reference', 0, false));
    const imports = [cand('src/a/Plain.ts', 'import', 0, false), cand('src/a/GovernedThing.ts', 'import', 7), cand('src/a/Other.ts', 'import', 1)];
    const picked = prioritizeExpansionTargets([...cloud, ...imports], terms, 6);
    expect(picked.length).toBeLessThanOrEqual(6);
    expect(picked.slice(0, 3).map(item => item.path)).toEqual(['src/a/GovernedThing.ts', 'src/a/Other.ts', 'src/a/Plain.ts']);
    expect(picked.filter(item => item.via === 'reference').length).toBeLessThanOrEqual(3);
  });

  it('ranks a same-subsystem name reference ahead of arbitrary references, only as a fallback', () => {
    const picked = prioritizeExpansionTargets([cand('src/x/Random.ts', 'reference', 0, false), cand('src/x/PolicyStore.ts', 'reference', 1)], terms, 4);
    expect(picked.map(item => item.path)).toEqual(['src/x/PolicyStore.ts', 'src/x/Random.ts']);
    expect(picked[0].tier).toBe('subsystem-name');
  });

  it('never gives a module a second range before every module has one', () => {
    const order = interleaveModuleRanges([
      { path: 'a', ranges: ['a1', 'a2', 'a3'] }, { path: 'b', ranges: ['b1'] }, { path: 'c', ranges: ['c1', 'c2'] },
    ]);
    expect(order).toEqual(['a1', 'b1', 'c1', 'a2', 'c2', 'a3']);
  });

  it('reserves a separate expansion budget that the seed cannot consume', () => {
    const split = allocateArchitectureBudget(12_000, true);
    expect(split.expansion).toBeGreaterThanOrEqual(5_000);
    expect(split.seed + split.expansion).toBeLessThanOrEqual(12_000);
    expect(allocateArchitectureBudget(12_000, false).expansion).toBe(0);
  });
});


// Only catalog/extension wiring is mocked: query, filesystem, HTTP client, frozen Core
// context and executor prompt assembly all run their production implementations.
import * as vscode from 'vscode';
import * as vscodeMock from '../mocks/vscode';
import { AgentPanel } from '../../ui/AgentPanel';
import { CoreClient } from '../../core-client/CoreClient';
import { openCoreDatabase } from '../../../core/db/openCore';
import { startApiServer } from '../../../core/api/server';
import { EventBroadcaster } from '../../../core/ws/broadcaster';
import type { ModelChatRequest } from '../../../core/runtime/modelBackend';
const seams = vi.hoisted(() => ({ manager: vi.fn(), provider: vi.fn() }));
vi.mock('../../extension', () => ({ getCoreManager: seams.manager }));
vi.mock('../../providers/ProviderGateway', () => ({ ProviderGateway: { create: seams.provider } }));

describe('M51 production host to backend evidence', () => {
  // Windows below 8192 are rejected by model selection before any request exists (routing is out of scope here), so the
  // smallest production window is the tightest clamp this path can exercise.
  it.each([8192, 16384, 32768])('preserves downstream source through HTTP/freeze/assembly at %i tokens', async window => {
    const root = makeRepo(governanceFixture());
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'm51-core-'));
    const db = openCoreDatabase(path.join(dataDir, 'core.db')).db;
    const requests: ModelChatRequest[] = [];
    const api = await startApiServer({ db, token: 'audit-token', broadcaster: new EventBroadcaster(), dataDir,
      coreInfo: () => ({ coreVersion: '0.1.0', apiVersion: 1, instanceId: 'audit', startedAt: new Date().toISOString(), nodeVersion: process.version, electronVersion: null, dataDir }),
      onShutdown: () => {}, executorOptions: { dataDir, defaultWorkingDirectory: root,
        backend: { streamChat: async request => { requests.push(request); return { content: 'Evidence received.', toolCalls: [], provider: 'ollama', model: request.model, usage: { durationMs: 1 } }; } },
      },
    });
    try {
      const client = new CoreClient({ baseUrl: `http://127.0.0.1:${api.port}`, token: 'audit-token', clientId: 'audit', clientVersion: 'test' });
      await client.registerClient();
      seams.manager.mockReturnValue({ getClient: () => client, onRuntimeEvent: () => ({ dispose() {} }), onRuntimeToken: () => ({ dispose() {} }) });
      seams.provider.mockResolvedValue({ listModels: async () => [{ name: 'audit-model', contextWindow: window }] });
      vscodeMock._resetConfig();
      vscodeMock._setConfig('ollama-agent.providerType', 'ollama');
      vscodeMock._setConfig('ollama-agent.model', 'audit-model');
      vscodeMock._setConfig('ollama-agent.contextWindow', window);
      const panel = new AgentPanel({ subscriptions: [], extensionUri: vscode.Uri.file(process.cwd()), secrets: { get: async () => undefined }, extension: { packageJSON: { scripts: {}, contributes: { commands: [] } } } } as unknown as vscode.ExtensionContext, root, true);
      await (panel as any).handleWebviewMessage({ type: 'sendMessage', mode: 'chat', text: 'How does the governance work here? Trace the actual implementation, not just the UI.', conversationId: 'audit-conversation' });
      await vi.waitFor(() => expect(requests.length).toBeGreaterThan(0), { timeout: 10000 });
      const sent = requests[0].messages.map(message => message.content).join('\n');
      const present = DOWNSTREAM.filter(([, name]) => sent.includes(`SOURCE_MARKER_${name}`));
      console.log('M51_BACKEND_EVIDENCE', JSON.stringify({ window, paths: sectionPaths(sent), markers: present.map(([file]) => file), chars: sent.length }));
      expect(present.length).toBeGreaterThanOrEqual(4);
    } finally {
      await api.close(); db.close(); vscodeMock._resetConfig();
      for (const dir of [root, dataDir]) { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* Windows may briefly hold a temp git handle */ } }
    }
  });
});
