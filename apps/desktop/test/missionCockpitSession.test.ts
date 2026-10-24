import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AUTO_MODEL, DesktopSession } from '../src/host/desktopSession';
import type { RuntimeEventRecord } from '../../../core/shared/wireTypes';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function session() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-session-'));
  dirs.push(dataDir);
  const host = new DesktopSession({ productRoot: process.cwd(), dataDir });
  // Exercise the production adapter with Core-shaped events; no model or repository mutation.
  const adapter = host as unknown as {
    active: { attemptId: string; requestId: string; conversationId: string; goal: string; tokenBuffer: string; terminal: boolean };
    missionStartedAt: string;
    handleRuntimeEvent(event: RuntimeEventRecord): Promise<void>;
  };
  adapter.active = { attemptId: 'att_cockpit', requestId: 'req_cockpit', conversationId: 'conv', goal: 'Fix tip calculation', tokenBuffer: '', terminal: false };
  adapter.missionStartedAt = '2026-09-14T10:00:00.000Z';
  let sequence = 0;
  const send = (domain: RuntimeEventRecord['domain'], eventType: string, entityId: string, metadata: Record<string, unknown>) => adapter.handleRuntimeEvent({
    sequence: ++sequence, id: `evt_${sequence}`, domain, entityId, eventType,
    createdAt: new Date(Date.parse(adapter.missionStartedAt) + sequence * 1000).toISOString(),
    actor: 'core', clientId: null, idempotencyKey: null, resultingRevision: null, metadata,
  });
  return { host, send };
}

describe('DesktopSession cockpit integration', () => {
  it('persists Auto as a routing choice without treating it as an installed Ollama model', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-model-session-'));
    dirs.push(dataDir);
    const host = new DesktopSession({ productRoot: process.cwd(), dataDir });
    const snapshot = await host.selectModel(AUTO_MODEL);
    expect(snapshot.modelIsAuto).toBe(true);
    expect(snapshot.modelAvailable).toBeNull();
    expect(JSON.parse(fs.readFileSync(path.join(dataDir, 'selected-model.json'), 'utf8')).model).toBe(AUTO_MODEL);

    // Simulate an app restart: a fresh DesktopSession over the same dataDir
    // must load Auto back from disk, not silently fall back to explicit.
    const restarted = new DesktopSession({ productRoot: process.cwd(), dataDir });
    expect(restarted.snapshot().modelIsAuto).toBe(true);
  });

  it('submits Auto without explicit provider or model evidence', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-submit-session-'));
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-submit-repo-'));
    dirs.push(dataDir, repo);
    fs.mkdirSync(path.join(repo, '.git'));
    const host = new DesktopSession({ productRoot: process.cwd(), dataDir });
    await host.selectModel(AUTO_MODEL);
    host.setFolder(repo);
    let submitted: Record<string, unknown> | undefined;
    const adapter = host as unknown as {
      client: {
        createConversation(input: unknown): Promise<{ id: string }>;
        submit(input: Record<string, unknown>): Promise<{ request: { id: string }; attempt: { id: string }; modelSelection: { selectedModel: string } }>;
        executeAttempt(id: string, input: unknown): Promise<void>;
      };
      coreState: string;
    };
    adapter.coreState = 'connected';
    adapter.client = {
      createConversation: async () => ({ id: 'conv_auto' }),
      submit: async (input) => {
        submitted = input;
        return { request: { id: 'req_auto' }, attempt: { id: 'att_auto' }, modelSelection: { selectedModel: 'jarvis-qwen3.8:27b-gsq' } };
      },
      executeAttempt: async () => undefined,
    };

    await host.submitTask('Explain this repository', 'local-core');
    expect(submitted).toMatchObject({ autoSelectModel: true });
    expect(submitted).not.toHaveProperty('requestedProvider');
    expect(submitted).not.toHaveProperty('requestedModel');
    expect(submitted).not.toHaveProperty('modelSelection');
    // The model Core actually routed to must be shown immediately — not only
    // once (or if) a later `model_selection_decided` runtime event arrives,
    // since that event is broadcast before this submit response and can race
    // ahead of `this.active` being set.
    expect(host.snapshot().model).toBe('jarvis-qwen3.8:27b-gsq');
    expect(host.snapshot().modelIsAuto).toBe(true);
  });

  it('a file-creation request with no folder selected is blocked_needs_workspace, never silently downgraded to a false-success chat reply', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blocked-workspace-session-'));
    dirs.push(dataDir);
    const host = new DesktopSession({ productRoot: process.cwd(), dataDir });
    await host.selectModel(AUTO_MODEL);
    let submitCalled = false;
    const adapter = host as unknown as {
      client: { createConversation(input: unknown): Promise<{ id: string }>; submit(input: unknown): Promise<unknown> };
      coreState: string;
    };
    adapter.coreState = 'connected';
    adapter.client = {
      createConversation: async () => ({ id: 'conv_blocked' }),
      submit: async () => { submitCalled = true; return {}; },
    };

    await expect(host.submitTask('write a simple python file that prints hello', 'local-core')).rejects.toThrow(/select a repository/i);
    expect(submitCalled).toBe(false); // Core was never even called — no request/attempt created.
    const snap = host.snapshot();
    expect(snap.turnOutcomeKind).toBe('blocked_needs_workspace');
    expect(snap.blockedReason).toMatch(/select a repository/i);
  });

  it('a file-creation request with a folder selected routes through the governed mission path (saath_kar), even on the default worker', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-route-session-'));
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'mission-route-repo-'));
    dirs.push(dataDir, repo);
    fs.mkdirSync(path.join(repo, '.git'));
    const host = new DesktopSession({ productRoot: process.cwd(), dataDir });
    await host.selectModel(AUTO_MODEL);
    host.setFolder(repo);
    let submitted: Record<string, unknown> | undefined;
    const adapter = host as unknown as {
      client: {
        createConversation(input: unknown): Promise<{ id: string }>;
        submit(input: Record<string, unknown>): Promise<{ request: { id: string }; attempt: { id: string }; modelSelection: { selectedModel: string } }>;
        executeAttempt(id: string, input: unknown): Promise<void>;
      };
      coreState: string;
    };
    adapter.coreState = 'connected';
    adapter.client = {
      createConversation: async () => ({ id: 'conv_mission_route' }),
      submit: async (input) => {
        submitted = input;
        return { request: { id: 'req_mr' }, attempt: { id: 'att_mr' }, modelSelection: { selectedModel: 'jarvis-qwen3.8:27b-gsq' } };
      },
      executeAttempt: async () => undefined,
    };

    await host.submitTask('create hello.py that prints hello world', 'local-core');
    expect(submitted?.requestedMode).toBe('saath_kar');
    expect(submitted).toHaveProperty('toolPermissionPolicy');
  });

  it('does not let another attempt’s model_selection_decided event override the active attempt’s routed model', async () => {
    const { host, send } = session();
    await send('execution_quality', 'model_selection_decided', 'att_other', { selectedModel: 'wrong-model:latest' });
    expect(host.snapshot().model).toBeNull();
    await send('execution_quality', 'model_selection_decided', 'att_cockpit', { selectedModel: 'qwen3.8:27b-mtp-q4_K_M' });
    expect(host.snapshot().model).toBe('qwen3.8:27b-mtp-q4_K_M');
  });

  it('projects actual Core-shaped tool and model events without mixing attempts', async () => {
    const { host, send } = session();
    const own = { attemptId: 'att_cockpit' };
    await send('model_invocation', 'model_invocation_started', 'model_1', own);
    await send('model_invocation', 'model_invocation_completed', 'model_other', { attemptId: 'att_other', promptTokens: 999 });
    await send('model_invocation', 'model_invocation_completed', 'unscoped', { promptTokens: 999 });
    await send('model_invocation', 'model_invocation_completed', 'model_1', { ...own, status: 'succeeded', promptTokens: 100, completionTokens: 20 });
    await send('tool_invocation', 'tool_invocation_started', 'edit_1', { ...own, toolName: 'propose_file_change', argsSummary: { path: 'tip.js' } });
    await send('tool_invocation', 'tool_invocation_completed', 'edit_1', { ...own, status: 'succeeded' });
    const view = host.snapshot().cockpit;
    expect(view.filesChanged).toEqual(['tip.js']);
    expect(view.phase).toBe('implementation');
    expect(view.currentAction).toBeNull();
    expect(view.diagnostics).toHaveLength(4);
    expect(view.checkpoints[0].detail).toBe('100 prompt tokens / 20 generated');
    await send('attempt', 'attempt_failed', 'att_cockpit', { failureReason: 'Focused validation failed' });
    const ended = host.snapshot();
    expect(ended.running).toBe(false);
    expect(ended.attemptId).toBe('att_cockpit');
    expect(ended.cockpit.finalOutcome).toBe('Focused validation failed');
    await send('tool_invocation', 'tool_invocation_completed', 'late', { ...own, status: 'succeeded' });
    expect(host.snapshot().cockpit.elapsedMs).toBe(ended.cockpit.elapsedMs);
    expect(host.snapshot().cockpit.diagnostics).toHaveLength(ended.cockpit.diagnostics.length);
  });
});
