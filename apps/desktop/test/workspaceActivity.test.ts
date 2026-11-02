import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_ACTIVITIES_PER_CONVERSATION, WorkspaceActivityLog } from '../src/host/workspaceActivity';
import { RENDERER_VISIBLE_KEYS, type DesktopActivityEvent } from '../src/ipc';

const at = '2026-11-02T10:00:00.000Z';

function started(id: string, toolName: string, toolArgs: Record<string, unknown> = {}): DesktopActivityEvent {
  return {
    kind: 'activity', at, attemptId: 'att_1', domain: 'tool_invocation', eventType: 'tool_invocation_started',
    toolName, invocationId: id, toolArgs, summary: `tool start: ${toolName}`,
  };
}

function finished(id: string, toolName: string, status: string, extra: Partial<DesktopActivityEvent> = {}): DesktopActivityEvent {
  return {
    kind: 'activity', at, attemptId: 'att_1', domain: 'tool_invocation', eventType: 'capability_tool_invocation_completed',
    toolName, invocationId: id, invocationStatus: status, summary: `tool ${status}: ${toolName}`, ...extra,
  };
}

let dir: string | undefined;
afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('workspace activity log', () => {
  it('shows a browser step as running, then completed with the page the tool published', () => {
    const log = new WorkspaceActivityLog();
    log.observe(started('tinv_1', 'browser_goto', { url: 'https://example.org/a' }), 'conv_1');
    expect(log.list('conv_1')).toMatchObject([{ state: 'running', kind: 'browser', title: 'Going to example.org', taskId: 'att_1' }]);

    log.observe(finished('tinv_1', 'browser_goto', 'succeeded', {
      activity: { kind: 'browser', url: 'https://example.org/a', title: 'Example', artifactIds: ['artifact_1'] },
    }), 'conv_1');
    const [item] = log.list('conv_1');
    expect(item.state).toBe('completed');
    expect(item.preview).toMatchObject({ url: 'https://example.org/a', artifactIds: ['artifact_1'] });
  });

  it('completes a step from Core completion events that carry no tool name', () => {
    // Core's tool_invocation_completed names only the invocation; the host maps the tool as unknown_tool.
    const log = new WorkspaceActivityLog();
    log.observe(started('tinv_c', 'browser_open_site', { url: 'https://example.org' }), 'conv_1');
    log.observe({ ...finished('tinv_c', 'unknown_tool', 'succeeded'), eventType: 'tool_invocation_completed', activity: { kind: 'browser', url: 'https://example.org/' } }, 'conv_1');
    expect(log.list('conv_1')[0]).toMatchObject({ capability: 'browser_open_site', state: 'completed', detail: null, preview: { url: 'https://example.org/' } });
  });

  it('reports a failure with the reason Core recorded', () => {
    const log = new WorkspaceActivityLog();
    log.observe(started('tinv_2', 'browser_open_site', { url: 'https://example.org' }), 'conv_1');
    log.observe({ ...finished('tinv_2', 'browser_open_site', 'failed'), summary: 'tool failed: browser_open_site navigation blocked' }, 'conv_1');
    expect(log.list('conv_1')[0]).toMatchObject({ state: 'failed', detail: 'navigation blocked' });
  });

  it('never marks a step done because its task ended: an unreported step fails or is cancelled', () => {
    const log = new WorkspaceActivityLog();
    log.observe(started('tinv_3', 'image_generate', { prompt: 'a lighthouse' }), 'conv_1');
    log.observe({ kind: 'result', at, attemptId: 'att_1', summary: 'done' }, null);
    expect(log.list('conv_1')[0]).toMatchObject({ state: 'failed' });

    log.observe({ ...started('tinv_4', 'browser_read'), attemptId: 'att_2' }, 'conv_1');
    log.observe({ kind: 'cancelled', at, attemptId: 'att_2', summary: 'stopped' }, null);
    expect(log.list('conv_1')[1]).toMatchObject({ state: 'cancelled' });
  });

  it('drops unsafe preview fields from untrusted tool output', () => {
    const log = new WorkspaceActivityLog();
    log.observe(finished('tinv_5', 'browser_read', 'succeeded', {
      activity: { kind: 'browser', url: 'javascript:alert(1)', path: 'C:\\Users\\me\\secret.txt', excerpt: 'x'.repeat(5_000) } as never,
    }), 'conv_1');
    const preview = log.list('conv_1')[0].preview!;
    expect(preview.url).toBeUndefined();
    expect(preview.path).toBeUndefined();
    expect(preview.excerpt!.length).toBeLessThanOrEqual(1_201);
  });

  it('hides protocol plumbing and bounds the history per conversation', () => {
    const log = new WorkspaceActivityLog();
    expect(log.observe(started('tinv_p', 'protocol_correction'), 'conv_1')).toBe(false);
    for (let i = 0; i < MAX_ACTIVITIES_PER_CONVERSATION + 5; i++) log.observe(started(`tinv_${i}`, 'read_file', { path: `f${i}.ts` }), 'conv_1');
    expect(log.list('conv_1')).toHaveLength(MAX_ACTIVITIES_PER_CONVERSATION);
  });

  it('survives a restart, and a step left running is restored as unfinished', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pandesh-activity-'));
    const file = path.join(dir, 'activities.json');
    const first = new WorkspaceActivityLog(file);
    first.begin({ id: 'host-1', conversationId: 'conv_1', taskId: null, capability: 'video_generate', title: 'Generating a video' });
    first.observe(started('tinv_9', 'propose_text_edit', { path: 'src/a.ts' }), 'conv_1');
    first.observe(finished('tinv_9', 'propose_text_edit', 'succeeded', {
      activity: { kind: 'code', path: 'src/a.ts', diff: '--- a/src/a.ts\n+++ b/src/a.ts\n-a\n+b' },
    }), 'conv_1');

    const restored = new WorkspaceActivityLog(file).list('conv_1');
    expect(restored.find((item) => item.id === 'host-1')).toMatchObject({ state: 'failed' });
    expect(restored.find((item) => item.id === 'tinv_9')).toMatchObject({ state: 'completed', kind: 'code', preview: { path: 'src/a.ts' } });
  });

  it('is visible to the renderer through the snapshot', () => {
    expect(RENDERER_VISIBLE_KEYS).toContain('workspaceActivities');
  });
});
