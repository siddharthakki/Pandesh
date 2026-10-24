import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

describe('shell-first Core startup keeps durable restoration gated', () => {
  it('registers the AgentPanel shell first, then binds and starts the one Core client', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/extension.ts'), 'utf8');
    const viewsRegistered = source.indexOf('const agentPanel = registerViews(context, storageRoot, workspaceAvailable);');
    const managerCreated = source.indexOf('coreManager = new CoreManager(context);');
    const managerBound = source.indexOf('agentPanel.bindCoreManager(coreManager);');
    const coreStarted = source.indexOf('await coreManager!.start();');

    expect(source).toMatch(/export async function activate\(context: vscode\.ExtensionContext\): Promise<void>/);
    expect(viewsRegistered).toBeGreaterThanOrEqual(0);
    expect(managerCreated).toBeGreaterThan(viewsRegistered);
    expect(managerBound).toBeGreaterThan(managerCreated);
    expect(coreStarted).toBeGreaterThan(managerBound);
    expect(source).toContain('const coreStartPromise = (async () => {');
    expect(source).toContain('void coreStartPromise.then(async () => {');
  });

  it('does not publish a Core client until registration and initial snapshot startup are awaited', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/core-client/CoreManager.ts'), 'utf8');

    expect(source).toMatch(/private async connectFromOutcome\([\s\S]*?\): Promise<void>/);
    expect(source).toContain('await client.start();');
    expect(source).toContain('await this.connectFromOutcome(outcome);');
    expect(source).not.toContain('this.client.start().catch');
  });
});
