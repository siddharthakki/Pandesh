/** @vitest-environment jsdom */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DesktopSnapshot } from '../src/ipc';
import { cockpitInput, desktopSnapshotFromEvents, eventFromSummary, RECORDED_START } from './recordedMissionStream';
import { emptyMissionCockpit } from '../src/host/missionCockpit';

const rendererRoot = path.resolve(__dirname, '../renderer');
let currentSnapshot: DesktopSnapshot | null = null;
const listeners: Array<() => void> = [];

beforeAll(() => {
  const html = fs.readFileSync(path.join(rendererRoot, 'index.html'), 'utf8');
  const body = html.match(/<body>([\s\S]*)<\/body>/i)?.[1] ?? '';
  document.body.innerHTML = body.replace(/<script[\s\S]*?<\/script>/gi, '');
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });

  (window as unknown as {
    jarvisVoiceCapture: {
      startPushToTalkCapture: () => { stop: () => Promise<Uint8Array | null>; cancel: () => void };
      bytesToBase64: (bytes: Uint8Array) => string;
    };
    karkedikhaDesktop: Record<string, unknown>;
  }).jarvisVoiceCapture = {
    startPushToTalkCapture: () => ({
      stop: async () => null,
      cancel: () => undefined,
    }),
    bytesToBase64: () => '',
  };

  (window as unknown as { karkedikhaDesktop: Record<string, unknown> }).karkedikhaDesktop = {
    getSnapshot: async () => currentSnapshot,
    pickFolder: async () => currentSnapshot,
    submitTask: async () => ({ requestId: 'req', attemptId: 'att', model: 'qwen' }),
    cancel: async () => undefined,
    selectWorker: async () => currentSnapshot,
    selectProvider: async () => currentSnapshot,
    listModels: async () => ['qwen2.5-coder:14b', 'deepseek-r1:14b'],
    selectModel: async () => currentSnapshot,
    continueTask: async () => ({ requestId: 'req', attemptId: 'att', model: 'qwen' }),
    resolveApproval: async () => undefined,
    setOpenRouterApiKey: async () => ({ keyConfigured: true }),
    clearOpenRouterApiKey: async () => ({ keyConfigured: false }),
    transcribeUtterance: async () => ({ transcript: '', engine: 'local' }),
    getHostTelemetry: async () => ({}),
    onEvent: (fn: () => void) => {
      listeners.push(fn);
      return () => {
        const i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
      };
    },
    listConversations: async () => [],
    openConversation: async () => ({ snapshot: null, transcriptHtml: '' }),
    newConversation: async () => undefined,
    renameConversation: async () => [],
    pinConversation: async () => [],
    unpinConversation: async () => [],
    archiveConversation: async () => [],
    unarchiveConversation: async () => [],
    searchConversations: async () => [],
  };

  // Load renderer logic
  const code = fs.readFileSync(path.join(rendererRoot, 'renderer.js'), 'utf8');
  eval(code);
});

async function paint(snap: DesktopSnapshot) {
  currentSnapshot = snap;
  for (const listener of listeners) {
    listener();
  }
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 25));
}

function baseSnap(overrides: Partial<DesktopSnapshot> = {}): DesktopSnapshot {
  return desktopSnapshotFromEvents([], cockpitInput({ running: false, terminal: false }), {
    installedModels: ['qwen2.5-coder:14b'],
    folder: 'C:\\Projects\\reading-list',
    ...overrides,
  });
}

describe('JARVIS 2026 Core Reactor & Mission Focus Topology', () => {
  it('renders the central core reactor in IDLE state on initial load', async () => {
    await paint(baseSnap({ running: false }));
    const reactor = document.getElementById('jarvis-core-reactor');
    expect(reactor).toBeTruthy();
    expect(reactor?.getAttribute('data-core-state')).toBe('idle');
    expect(document.getElementById('core-reactor-badge')?.textContent).toBe('IDLE');
    expect(document.getElementById('core-reactor-desc')?.textContent).toContain('Standing by');
  });

  it('transitions Core reactor to THINKING when mission is running and model generates', async () => {
    const snap = desktopSnapshotFromEvents(
      [eventFromSummary('AI response started', RECORDED_START, { eventType: 'model_invocation_started' })],
      cockpitInput({ running: true, terminal: false }),
      {
        task: 'Fix navigation header bug',
        model: 'qwen2.5-coder:14b',
      }
    );
    await paint(snap);
    const reactor = document.getElementById('jarvis-core-reactor');
    expect(reactor?.getAttribute('data-core-state')).toBe('thinking');
    expect(document.getElementById('core-reactor-badge')?.textContent).toBe('THINKING');
    expect(document.getElementById('core-reactor-desc')?.textContent).toContain('qwen2.5-coder:14b');
  });

  it('transitions Core reactor to EXECUTING when a tool capability is active', async () => {
    const snap = desktopSnapshotFromEvents(
      [eventFromSummary('tool start: propose_file_change src/header.tsx', RECORDED_START, { toolName: 'propose_file_change' })],
      cockpitInput({ running: true, terminal: false }),
      {
        task: 'Fix navigation header bug',
      }
    );
    await paint(snap);
    const reactor = document.getElementById('jarvis-core-reactor');
    expect(reactor?.getAttribute('data-core-state')).toBe('executing');
    expect(document.getElementById('core-reactor-badge')?.textContent).toBe('EXECUTING');
    expect(document.getElementById('core-reactor-desc')?.textContent).toContain('Edit');
  });

  it('transitions Core reactor to WAITING_FOR_APPROVAL when governance gate is active', async () => {
    const approvalCard = {
      approvalId: 'appr_gate_1',
      attemptId: 'att_1',
      gate: 'Fenced File Mutation',
      toolName: 'propose_file_change',
      arguments: { path: 'src/header.tsx' },
      requestedAt: RECORDED_START,
      paths: ['src/header.tsx'],
      actionDigest: 'sha256:abc',
      diff: '+ import React',
      scope: 'Authorize file mutation',
      detail: 'src/header.tsx modification',
    };
    const snap = desktopSnapshotFromEvents(
      [eventFromSummary('Waiting for Fenced File Mutation', RECORDED_START, { kind: 'approval' })],
      cockpitInput({ running: true, terminal: false, pendingApproval: approvalCard }),
      {
        awaitingApproval: true,
        pendingApproval: approvalCard,
      }
    );
    await paint(snap);
    const reactor = document.getElementById('jarvis-core-reactor');
    expect(reactor?.getAttribute('data-core-state')).toBe('waiting_for_approval');
    expect(document.getElementById('core-reactor-badge')?.textContent).toBe('APPROVAL REQUIRED');
    expect(document.getElementById('core-reactor-desc')?.textContent).toContain('Fenced File Mutation');
  });

  it('transitions Core reactor to VALIDATING when workspace verification runs', async () => {
    const snap = desktopSnapshotFromEvents(
      [eventFromSummary('tool start: run_check workspace_validation', RECORDED_START, { toolName: 'run_check' })],
      cockpitInput({ running: true, terminal: false }),
      {}
    );
    // Explicitly set validationStatus running
    snap.cockpit!.validationStatus = 'running';
    await paint(snap);
    const reactor = document.getElementById('jarvis-core-reactor');
    expect(reactor?.getAttribute('data-core-state')).toBe('validating');
    expect(document.getElementById('core-reactor-badge')?.textContent).toBe('VALIDATING');
  });

  it('transitions Core reactor to RECOVERING when repair cycle is detected', async () => {
    const snap = desktopSnapshotFromEvents(
      [
        eventFromSummary('tool start: write_file', RECORDED_START, { toolName: 'write_file' }),
        eventFromSummary('tool failed: run_check', RECORDED_START, { toolName: 'run_check' }),
      ],
      cockpitInput({ running: true, terminal: false }),
      {}
    );
    snap.cockpit!.phase = 'repair';
    snap.cockpit!.repairCycle = 2;
    await paint(snap);
    const reactor = document.getElementById('jarvis-core-reactor');
    expect(reactor?.getAttribute('data-core-state')).toBe('recovering');
    expect(document.getElementById('core-reactor-badge')?.textContent).toBe('RECOVERING');
    expect(document.getElementById('core-reactor-desc')?.textContent).toContain('repair cycle #2');
  });

  it('transitions Core reactor to COMPLETED when mission concludes successfully', async () => {
    const snap = desktopSnapshotFromEvents(
      [eventFromSummary('Final answer from Core conversation', RECORDED_START, { kind: 'result', text: 'All 8 tests passing.' })],
      cockpitInput({ running: false, terminal: true }),
      {}
    );
    await paint(snap);
    const reactor = document.getElementById('jarvis-core-reactor');
    expect(reactor?.getAttribute('data-core-state')).toBe('completed');
    expect(document.getElementById('core-reactor-badge')?.textContent).toBe('COMPLETED');
  });

  it('transitions Core reactor to FAILED when attempt fails', async () => {
    const snap = desktopSnapshotFromEvents(
      [eventFromSummary('Protocol error: max retries exceeded', RECORDED_START, { kind: 'error' })],
      cockpitInput({ running: false, terminal: true }),
      { lastTurnOutcome: 'failed' }
    );
    await paint(snap);
    const reactor = document.getElementById('jarvis-core-reactor');
    expect(reactor?.getAttribute('data-core-state')).toBe('failed');
    expect(document.getElementById('core-reactor-badge')?.textContent).toBe('FAILED');
  });

  it('maps the Mission Focus topology nodes and local-first boundary', async () => {
    const snap = desktopSnapshotFromEvents(
      [
        eventFromSummary('Inspect repository structure', RECORDED_START),
        eventFromSummary('tool start: write_file src/Nav.tsx', RECORDED_START, { toolName: 'write_file' }),
      ],
      cockpitInput({ running: true, terminal: false }),
      {
        task: 'Build responsive header component',
        model: 'qwen2.5-coder:14b',
        provider: 'ollama',
        selectedInferenceProvider: 'ollama',
        routingPolicy: 'local-only',
        folder: 'C:\\Projects\\reading-list',
      }
    );
    snap.cockpit!.validationStatus = 'passed';
    snap.cockpit!.metrics = {
      ...snap.cockpit!.metrics!,
      aiResponses: 2,
      promptTokens: 4500,
      generatedTokens: 800,
      generationRate: null,
    };
    console.log('BEFORE PAINT topo text:', document.getElementById('topo-objective-text')?.textContent);
    await paint(snap);
    console.log('AFTER PAINT topo text:', document.getElementById('topo-objective-text')?.textContent);
    console.log('AFTER PAINT op-error:', document.getElementById('operation-error')?.textContent);
    console.log('AFTER PAINT topo hidden:', document.getElementById('mission-focus-topology')?.hidden);

    const topology = document.getElementById('mission-focus-topology');
    expect(topology).toBeTruthy();
    expect(topology?.hidden).toBe(false);

    // Node 1: Objective
    expect(document.getElementById('node-objective')?.classList.contains('is-active')).toBe(true);
    expect(document.getElementById('topo-objective-text')?.textContent).toContain('Build responsive');

    // Node 2: Model & Boundary
    expect(document.getElementById('node-model')).toBeTruthy();
    expect(document.getElementById('topo-model-text')?.textContent).toBe('qwen2.5-coder:14b');
    expect(document.getElementById('topo-boundary-badge')?.textContent).toBe('LOCAL');
    expect(document.getElementById('topo-boundary-badge')?.classList.contains('local-pill')).toBe(true);

    // Node 3: Capability / Tool
    expect(document.getElementById('node-tool')?.classList.contains('is-active')).toBe(true);
    expect(document.getElementById('topo-tool-text')?.textContent).toContain('write_file');

    // Node 4: Validation
    expect(document.getElementById('node-validation')?.classList.contains('is-done')).toBe(true);
    expect(document.getElementById('topo-val-text')?.textContent).toBe('passed');

    // Edge flow
    expect(document.getElementById('edge-obj-model')?.classList.contains('is-flowing')).toBe(true);

    // KKD Intelligence Strip
    expect(document.getElementById('intel-context-val')?.textContent).toContain('4500 tok');
    expect(document.getElementById('intel-governance-val')?.textContent).toContain('Local Sandbox');
    expect(document.getElementById('intel-recovery-val')?.textContent).toContain('0 faults');
  });

  it('renders Cloud boundary badge when cloud provider is selected', async () => {
    const snap = desktopSnapshotFromEvents(
      [eventFromSummary('AI response cloud', RECORDED_START, { eventType: 'model_invocation_started' })],
      cockpitInput({ running: true, terminal: false }),
      {
        task: 'Audit cloud infrastructure',
        model: 'anthropic/claude-3.5-sonnet',
        provider: 'openrouter',
        selectedInferenceProvider: 'openrouter',
        routingPolicy: 'explicit-openrouter',
        folder: 'C:\\Projects\\reading-list',
      }
    );
    snap.cockpit!.metrics = {
      ...snap.cockpit!.metrics!,
      aiResponses: 1,
      promptTokens: 14000,
      generatedTokens: 1200,
      generationRate: null,
    };
    await paint(snap);

    expect(document.getElementById('topo-boundary-badge')?.textContent).toBe('CLOUD');
    expect(document.getElementById('topo-boundary-badge')?.classList.contains('cloud-pill')).toBe(true);
    expect(document.getElementById('topology-runtime-badge')?.textContent).toBe('CLOUD GATEWAY');
    expect(document.getElementById('intel-governance-val')?.textContent).toContain('Cloud Gateway');
    // High prompt tokens (14k, no envelope reported) triggers absolute pressure indicator
    expect(document.getElementById('intel-context-val')?.textContent).toContain('High Pressure');
  });
});
