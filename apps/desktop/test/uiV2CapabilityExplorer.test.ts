/** @vitest-environment jsdom */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import {
  abilityText, activeGrants, approvalState, connectAction, explorerSummary, groupTools, memoryRows, modelChips, sortModels, toolCategory, toolCounts, toolUsable,
  type ExplorerModelRow, type HubCapability, type HubTool, type ModelFitReport,
} from '../renderer-v2/src/explorerModel';

const GiB = 2 ** 30;
const fitOf = (o: Partial<ModelFitReport> = {}): ModelFitReport => ({
  state: 'fits', label: 'Fits the GPU', summary: 'Needs about 9.0 GB at 32K context (weights 7.0 GB + cache 1.0 GB + runtime 1.0 GB), within the 22.5 GB budget.', tone: 'ok',
  capacityBytes: 24 * GiB, budgetBytes: 22.5 * GiB, availableBytes: 20 * GiB, weightsBytes: 7 * GiB, runtimeBytes: GiB,
  atContext: [{ ctx: 32768, cacheBytes: GiB, totalBytes: 9 * GiB, fitsBudget: true }], agentCtx: 32768, maxFitCtx: 32768, measured: null, uncertainty: ['Calculated at full precision.'], ...o,
});
const model = (o: Partial<ExplorerModelRow>): ExplorerModelRow => ({ name: 'm', installed: true, loaded: false, selected: false, vision: false, tools: false, embedding: false, fitsGpu: true, fit: fitOf(), manualOnly: false, usable: true, note: '', ...o });

describe('explorer rules', () => {
  it('orders selected, loaded, usable, unusable, embedding', () => {
    const rows = [model({ name: 'e', embedding: true }), model({ name: 'big', usable: false }), model({ name: 'idle' }), model({ name: 'warm', loaded: true }), model({ name: 'sel', selected: true, loaded: true })];
    expect(sortModels(rows).map((r) => r.name)).toEqual(['sel', 'warm', 'idle', 'big', 'e']);
  });
  it('shows a selected model that spills as selected plus a readiness note, never "Does not fit"', () => {
    const spill = fitOf({ state: 'spills', label: 'Fits only up to 16K context', tone: 'warn' });
    expect(modelChips(model({ selected: true, fit: spill })).map((c) => c.label)).toEqual(['Selected', 'Installed, not loaded', 'Fits only up to 16K context']);
    expect(modelChips(model({ selected: true, loaded: true, fit: fitOf({ state: 'on_gpu', label: 'Loaded on the GPU' }) })).map((c) => c.label)).toEqual(['Selected', 'Loaded on the GPU']);
    expect(modelChips(model({ usable: false, fit: fitOf({ state: 'too_large', label: 'Too large for this GPU', tone: 'warn' }) })).map((c) => c.label)).toContain('Too large for this GPU');
    expect(modelChips(model({ usable: false, embedding: true })).map((c) => c.label)).toEqual(['Installed, not loaded', 'Not for chat']);
    expect(abilityText(model({ vision: true, tools: false }))).toBe('Vision · No tools');
    expect(abilityText(model({ embedding: true }))).toBe('Embeddings');
  });
  it('keeps capacity, budget, free memory, weights and the estimate in separate rows', () => {
    const rows = memoryRows(fitOf());
    expect(rows.map((r) => r.label)).toEqual(['GPU capacity', 'Budget for one model', 'Free right now', 'Model weights', 'Estimate at 32K context']);
    expect(rows[4].note).toMatch(/Pandesh's context/);
    expect(memoryRows(fitOf({ measured: { sizeBytes: 20 * GiB, vramBytes: 20 * GiB, cpuShare: 0, contextLength: 8192 } })).some((r) => r.label === 'Measured (loaded)')).toBe(true);
    expect(memoryRows(undefined)).toEqual([]);
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
  it('puts the assistant helpers, PC tools and messaging where a person would look', () => {
    const t = (name: string, capabilityId: string, group?: string) => toolCategory({ name, capabilityId, ...(group ? { group } : {}) });
    expect(t('port_list_services', 'port-management')).toBe('This PC and models');
    expect(t('desktop_screenshot', 'computer-use')).toBe('This PC and models');
    expect(t('whatsapp_send_message', 'whatsapp')).toBe('Messaging and household');
    expect(t('calculate', 'chat_engine', 'base')).toBe('Assistant helpers');
    expect(t('create_commitment', 'chat_engine', 'scheduling')).toBe('Tasks, reminders and workflows');
    expect(t('scout_add_watch', 'intelligence-scout')).toBe('Business and monitoring');
  });
  it('groups tools by function, and offers Connect only for Google tools that are not ready', () => {
    expect(tools.map(toolCategory)).toEqual(['Files and documents', 'Files and documents', 'Email and calendar', 'Memory and notes']);
    expect(groupTools(tools, caps).map((g) => [g.category, g.tools.length, g.notReady])).toEqual([['Email and calendar', 1, 1], ['Files and documents', 2, 0], ['Memory and notes', 1, 0]]);
    expect(connectAction(tools[2], caps)).toEqual({ label: 'Connect Google', view: 'connections' });
    expect(connectAction(tools[1], caps)).toBeNull();
    expect(connectAction(tools[0], [{ id: 'workspace', health: { state: 'missing' }, tools: [] }])).toBeNull();
  });
  it('separates "requires approval" from "an active grant may cover it", and never marks a tool authorized', () => {
    const g = activeGrants([{ id: 'a', categories: ['workspace_write'], workspaceRoot: null, expiresAt: new Date(Date.now() + 60_000).toISOString() }, { id: 'old', categories: ['x'], workspaceRoot: null, expiresAt: new Date(Date.now() - 1000).toISOString() }]);
    expect(g.map((x) => x.id)).toEqual(['a']);
    expect(approvalState('read_only', 'plan', []).kind).toBe('none_needed');
    expect(approvalState('consequential', 'ask', g).kind).toBe('asks');
    expect(approvalState('consequential', 'auto', []).kind).toBe('asks');
    expect(approvalState('consequential', 'auto', g)).toMatchObject({ kind: 'may_be_covered', text: 'Asks, unless an active Auto grant covers it' });
    expect(approvalState('consequential', 'plan', g).tone).toBe('blocked');
  });
  it('summarises usable models, usable tools and blocked skills', () => {
    const data = { models: { serverAnswering: true, selected: 'a', selectedKind: 'local', gpu: null, models: [model({ name: 'a' }), model({ name: 'b', usable: false }), model({ name: 'e', embedding: true, usable: false })] }, skills: [{ usable: 'blocked' }, { usable: 'ready' }] } as never;
    expect(explorerSummary(data, { tools, capabilities: caps })).toEqual({ models: { installed: 3, usable: 1, selected: 'a' }, tools: { total: 4, ready: 3, asks: 3, notReady: 1 }, skills: { total: 2, blocked: 1 } });
  });
});

const data = {
  generatedAt: '2026-11-15T10:00:00Z',
  models: { serverAnswering: true, selected: 'gemma4:12b', selectedKind: 'local', gpu: { name: 'RTX 4090', totalVramMb: 24576, freeVramMb: 20000 }, models: [
    model({ name: 'gemma4:12b', selected: true, loaded: true, tools: true, fit: fitOf({ state: 'on_gpu', label: 'Loaded on the GPU', summary: 'Measured by Ollama: all 8.0 GB is in graphics memory.' }) }),
    model({ name: 'qwen2.5vl:7b', vision: true }),
    model({ name: 'huge:200b', usable: false, fit: fitOf({ state: 'too_large', label: 'Too large for this GPU', tone: 'warn', summary: 'Even the smallest context needs 130.0 GB.' }) }),
  ] },
  skills: [{ id: 'ocr', name: 'Read scans', description: 'd', version: '1', source: 'user', trust: 'user', usable: 'blocked', needs: [{ need: 'a model that can see images', status: 'missing' }], missing: ['a model that can see images'], blockedBy: null }],
  rejectedSkills: [{ origin: 'bad/SKILL.md', reason: 'no name' }],
  skillsFolder: 'C:\\data\\skills',
  agentReach: { installed: false, channels: [{ channel: 'web', actions: ['read'] }], usable: false, detail: 'Not installed on this PC, so Pandesh cannot read YouTube.', authorized: 'Asks you for consent before it goes online.' },
};
const hubData = { tools: [
  { name: 'write_file', description: '', capabilityId: 'workspace', risk: 'consequential', executor: 'governed' },
  { name: 'read_file', description: '', capabilityId: 'workspace', risk: 'read_only', executor: 'governed' },
  { name: 'gmail_send', description: '', capabilityId: 'gmail', risk: 'consequential', executor: 'governed' },
], capabilities: [{ id: 'workspace', health: { state: 'available' }, tools: [] }, { id: 'gmail', health: { state: 'not_connected', reason: 'Google is not connected' }, tools: [] }] };
const bridge = {
  getSnapshot: vi.fn(async () => ({ model: 'gemma4:12b', permission: { mode: 'plan', authorizations: [], categories: {} }, cloud: null })),
  household: vi.fn(async (action: string) => action === 'capabilityExplorer' ? data : hubData),
  selectModel: vi.fn(async () => ({})),
  onEvent: () => () => undefined,
};
let CapabilityExplorer: typeof import('../renderer-v2/src/CapabilityExplorer').CapabilityExplorer;
beforeAll(async () => { (window as unknown as { desktop: unknown }).desktop = bridge; ({ CapabilityExplorer } = await import('../renderer-v2/src/CapabilityExplorer')); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('capability explorer screen', () => {
  it('asks Core for the selected model and shows a summary, models, tools, skills and Agent Reach in their own words', async () => {
    render(React.createElement(CapabilityExplorer, { narrow: false }));
    await screen.findByText('Models on this PC');
    expect(bridge.household).toHaveBeenCalledWith('capabilityExplorer', { model: 'gemma4:12b', cloud: false });
    const summary = within(screen.getByRole('group', { name: 'Summary' }));
    expect(summary.getByText('models usable')).toBeTruthy();
    expect(summary.getByText('skills blocked')).toBeTruthy();
    expect(screen.getByText('Loaded on the GPU')).toBeTruthy();
    expect(screen.getByText('Vision · No tools')).toBeTruthy();
    expect(screen.getByText(/Measured by Ollama/)).toBeTruthy();
    const skill = screen.getByLabelText('Skill Read scans');
    expect(within(skill).getByText(/Blocked: needs a model that can see images/)).toBeTruthy();
    expect(screen.getByText(/never authorizes anything/)).toBeTruthy();
    expect(screen.getByText(/1 skill file was not loaded: bad\/SKILL.md \(no name\)/)).toBeTruthy();
    expect(within(screen.getByLabelText('Agent Reach')).getByText('Not installed')).toBeTruthy();
  });

  it('uses the existing selectModel for "Use this model", and not for the selected, or a too-large, model', async () => {
    render(React.createElement(CapabilityExplorer, { narrow: false }));
    await screen.findByText('Models on this PC');
    expect((within(screen.getByLabelText('Model gemma4:12b')).getByRole('button', { name: 'In use' }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(screen.getByLabelText('Model huge:200b')).getByRole('button', { name: 'Use this model' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(within(screen.getByLabelText('Model qwen2.5vl:7b')).getByRole('button', { name: 'Use this model' }));
    await waitFor(() => expect(bridge.selectModel).toHaveBeenCalledWith('qwen2.5vl:7b'));
    await screen.findByText('Pandesh will use qwen2.5vl:7b for new messages.');
  });

  it('keeps tool groups closed until you search, says what is blocked and why, and opens Connections for Google only', async () => {
    const onOpenView = vi.fn();
    render(React.createElement(CapabilityExplorer, { narrow: false, onOpenView }));
    await screen.findByText('Tools and their authorization');
    expect(document.querySelectorAll('details.ex-group[open]').length).toBe(0);
    expect(screen.getByLabelText('Already authorized').textContent).toMatch(/nothing\. Every tool that changes something asks first/);
    fireEvent.change(screen.getByLabelText('Search tools'), { target: { value: 'gmail' } });
    expect(document.querySelectorAll('details.ex-group[open]').length).toBe(1);
    expect(screen.getByText('Not usable: not connected: Google is not connected')).toBeTruthy();
    expect(screen.getByText('Blocked in Plan only')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Connect Google' }));
    expect(onOpenView).toHaveBeenCalledWith('connections');
  });

  it('filters the tool list', async () => {
    render(React.createElement(CapabilityExplorer, { narrow: false }));
    await screen.findByText('Tools and their authorization');
    fireEvent.change(screen.getByLabelText('Search tools'), { target: { value: 'no-such-tool' } });
    await waitFor(() => expect(screen.getByText('No tool matches.')).toBeTruthy());
  });

  it('reports a Core failure instead of an empty page', async () => {
    bridge.household.mockRejectedValueOnce(new Error("Error invoking remote method 'desktop:household': Error: Core is not answering"));
    render(React.createElement(CapabilityExplorer, { narrow: false }));
    await screen.findByRole('alert');
    expect(screen.getByRole('alert').textContent).toBe('Core is not answering');
  });
});
