/** @vitest-environment jsdom */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { abilityText, authorizationText, modelChips, sortModels, toolCounts, toolUsable, type ExplorerModelRow, type HubCapability, type HubTool } from '../renderer-v2/src/explorerModel';

const model = (o: Partial<ExplorerModelRow>): ExplorerModelRow => ({ name: 'm', installed: true, loaded: false, selected: false, vision: false, tools: false, embedding: false, fitsGpu: true, manualOnly: false, usable: true, note: '', ...o });

describe('explorer rules', () => {
  it('orders selected, loaded, usable, unusable, embedding', () => {
    const rows = [model({ name: 'e', embedding: true }), model({ name: 'big', usable: false }), model({ name: 'idle' }), model({ name: 'warm', loaded: true }), model({ name: 'sel', selected: true, loaded: true })];
    expect(sortModels(rows).map((r) => r.name)).toEqual(['sel', 'warm', 'idle', 'big', 'e']);
  });
  it('separates installed from loaded and says why a model is not usable', () => {
    expect(modelChips(model({ loaded: false })).map((c) => c.label)).toEqual(['Installed, not loaded']);
    expect(modelChips(model({ selected: true, loaded: true })).map((c) => c.label)).toEqual(['Selected', 'Loaded now']);
    expect(modelChips(model({ usable: false })).map((c) => c.label)).toContain('Does not fit');
    expect(modelChips(model({ usable: false, embedding: true })).map((c) => c.label)).toContain('Not for chat');
    expect(abilityText(model({ vision: true, tools: false }))).toBe('Vision · No tools');
    expect(abilityText(model({ embedding: true }))).toBe('Embeddings');
  });
  const tools: HubTool[] = [
    { name: 'read_file', description: '', capabilityId: 'workspace', risk: 'read_only', executor: 'governed' },
    { name: 'write_file', description: '', capabilityId: 'workspace', risk: 'consequential', executor: 'governed' },
    { name: 'gmail_send', description: '', capabilityId: 'gmail', risk: 'consequential', executor: 'governed' },
    { name: 'remember', description: '', capabilityId: 'chat_engine', risk: 'consequential', executor: 'native' },
  ];
  const caps: HubCapability[] = [{ id: 'workspace', health: { state: 'available' }, tools: [] }, { id: 'gmail', health: { state: 'not_connected', reason: 'Google is not connected' }, tools: [] }];
  it('reports usable from the capability health, and chat-engine tools as such', () => {
    expect(toolUsable(tools[0], caps).state).toBe('ready');
    expect(toolUsable(tools[2], caps)).toMatchObject({ state: 'not_ready', text: 'not connected: Google is not connected' });
    expect(toolUsable(tools[3], caps).state).toBe('chat_engine');
    expect(toolCounts(tools, caps)).toEqual({ total: 4, readOnly: 1, asks: 3, notReady: 1 });
  });
  it('states authorization by risk and by the conversation mode, without ever granting', () => {
    expect(authorizationText('read_only', 'plan').tone).toBe('ok');
    expect(authorizationText('consequential', 'ask').text).toMatch(/asks you each time/);
    expect(authorizationText('consequential', 'auto').text).toMatch(/unless your Auto grant covers it/);
    expect(authorizationText('consequential', 'plan').tone).toBe('blocked');
  });
});

const data = {
  generatedAt: '2026-11-15T10:00:00Z',
  models: { serverAnswering: true, selected: 'gemma4:12b', selectedKind: 'local', gpu: { name: 'RTX 4090', totalVramMb: 24576 }, models: [model({ name: 'gemma4:12b', selected: true, loaded: true, tools: true }), model({ name: 'qwen2.5vl:7b', vision: true })] },
  skills: [{ id: 'ocr', name: 'Read scans', description: 'd', version: '1', source: 'user', trust: 'user', usable: 'blocked', needs: [{ need: 'a model that can see images', status: 'missing' }], missing: ['a model that can see images'], blockedBy: null }],
  rejectedSkills: [{ origin: 'bad/SKILL.md', reason: 'no name' }],
  skillsFolder: 'C:\\data\\skills',
  agentReach: { installed: false, channels: [{ channel: 'web', actions: ['read'] }], usable: false, detail: 'Not installed on this PC, so Pandesh cannot read YouTube.', authorized: 'Asks you for consent before it goes online.' },
};
const bridge = {
  getSnapshot: vi.fn(async () => ({ model: 'gemma4:12b', permission: { mode: 'plan' }, cloud: null })),
  household: vi.fn(async (action: string) => action === 'capabilityExplorer' ? data : { tools: [{ name: 'write_file', description: '', capabilityId: 'workspace', risk: 'consequential', executor: 'governed' }], capabilities: [{ id: 'workspace', health: { state: 'available' }, tools: [] }] }),
  onEvent: () => () => undefined,
};
let CapabilityExplorer: typeof import('../renderer-v2/src/CapabilityExplorer').CapabilityExplorer;
beforeAll(async () => { (window as unknown as { desktop: unknown }).desktop = bridge; ({ CapabilityExplorer } = await import('../renderer-v2/src/CapabilityExplorer')); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('capability explorer screen', () => {
  it('asks Core for the selected model and shows models, tools, skills and Agent Reach with their own words', async () => {
    render(React.createElement(CapabilityExplorer, { narrow: false }));
    await screen.findByText('Models on this PC');
    expect(bridge.household).toHaveBeenCalledWith('capabilityExplorer', { model: 'gemma4:12b', cloud: false });
    expect(screen.getByText('Loaded now')).toBeTruthy();
    expect(screen.getByText('Installed, not loaded')).toBeTruthy();
    expect(screen.getByText('Vision · No tools')).toBeTruthy();
    // plan mode: a tool that changes things is blocked, not "authorized"
    expect(screen.getByText('Changes things: blocked in Plan only')).toBeTruthy();
    const skill = screen.getByLabelText('Skill Read scans');
    expect(within(skill).getByText(/Blocked: needs a model that can see images/)).toBeTruthy();
    expect(screen.getByText(/never authorizes anything/)).toBeTruthy();
    expect(screen.getByText(/1 skill file was not loaded: bad\/SKILL.md \(no name\)/)).toBeTruthy();
    const reach = screen.getByLabelText('Agent Reach');
    expect(within(reach).getByText('Not installed')).toBeTruthy();
  });

  it('filters the tool list', async () => {
    render(React.createElement(CapabilityExplorer, { narrow: false }));
    await screen.findByText('Tools and their authorization');
    fireEvent.change(screen.getByLabelText('Show'), { target: { value: 'read_only' } });
    await waitFor(() => expect(screen.getByText('No tool matches.')).toBeTruthy());
  });

  it('reports a Core failure instead of an empty page', async () => {
    bridge.household.mockRejectedValueOnce(new Error("Error invoking remote method 'desktop:household': Error: Core is not answering"));
    render(React.createElement(CapabilityExplorer, { narrow: false }));
    await screen.findByRole('alert');
    expect(screen.getByRole('alert').textContent).toBe('Core is not answering');
  });
});
