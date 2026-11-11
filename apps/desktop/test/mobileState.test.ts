import { describe, expect, it } from 'vitest';
import { phoneDecision, phoneEvent, phoneState } from '../src/host/mobileState';

const base: any = {
  coreState: 'connected',
  model: 'gemma4:12b',
  modelIsAuto: false,
  running: false,
  attemptId: null,
  selectedConversationId: 'conv-1',
  activeConversationId: null,
  pendingApproval: null,
  pendingImageApproval: null,
  pendingWeatherApproval: null,
  workspaceActivities: [],
  lastTurnOutcome: 'completed',
  blockedReason: null,
  folder: 'D:\\Projects\\Example App\\',
};

describe('what the phone gets from the snapshot', () => {
  it('the workspace folder name only, never its path', () => {
    const s = phoneState(base);
    expect(s.workspace).toBe('Example App');
    expect(JSON.stringify(s)).not.toContain('Projects');
    expect(s).toMatchObject({ coreState: 'connected', model: 'gemma4:12b', running: false, conversationId: 'conv-1', decision: null });
  });

  it('Auto, Core states, and the step running now', () => {
    expect(phoneState({ ...base, modelIsAuto: true }).model).toBe('Auto');
    expect(phoneState({ ...base, coreState: 'reconnecting' }).coreState).toBe('connecting');
    expect(phoneState({ ...base, coreState: 'database_failed' }).coreState).toBe('offline');
    const running = phoneState({
      ...base,
      running: true,
      attemptId: 'att-2',
      workspaceActivities: [
        { id: 'a', state: 'completed', title: 'Read README.md', kind: 'file', startedAt: '2026-11-10T10:00:00Z' },
        { id: 'b', state: 'running', title: 'Search the web: tide times', kind: 'web', startedAt: '2026-11-10T10:00:05Z' },
      ],
    });
    expect(running.activity).toEqual({ title: 'Search the web: tide times', kind: 'web', startedAt: '2026-11-10T10:00:05Z' });
  });

  it('a tool approval reads as it does on the PC (v2 wording)', () => {
    const d = phoneDecision({
      ...base,
      pendingApproval: { approvalId: 'ap-1', gate: 'mutation', toolName: 'web_research', scope: 'search', paths: [], detail: 'tide times' },
    });
    expect(d).toEqual({
      kind: 'tool',
      approvalId: 'ap-1',
      title: 'Search the web',
      rows: [['Action', 'Search the web'], ['Tool', 'web_research'], ['Why it asks', 'It goes online (public web only)']],
      detail: 'tide times',
      allowLabel: 'Allow this web search',
    });
  });

  it('image and weather approvals reach the phone too', () => {
    expect(phoneDecision({ ...base, pendingImageApproval: { approvalId: 'img-1', attemptId: null, presentation: null, request: { prompt: 'a red bicycle' } } }))
      .toMatchObject({ kind: 'image', approvalId: 'img-1', detail: 'a red bicycle', allowLabel: 'Generate image' });
    expect(phoneDecision({ ...base, pendingWeatherApproval: { approvalId: 'wx-1', attemptId: null, presentation: null } }))
      .toMatchObject({ kind: 'weather', approvalId: 'wx-1', allowLabel: 'Look up weather' });
  });

  it('events lose tool arguments and check details on the way to the phone', () => {
    const e = phoneEvent({
      kind: 'activity', at: '2026-11-10T10:00:00Z', attemptId: 'att-2', toolName: 'read_file', summary: 'Reading',
      toolArgs: { path: 'C:\\secret\\file.txt' }, check: { kind: 'status', status: 'passed', command: 'npm test' }, text: 'body',
    } as any);
    expect(e).toEqual({ kind: 'activity', at: '2026-11-10T10:00:00Z', summary: 'Reading', attemptId: 'att-2', toolName: 'read_file' });
    expect(phoneEvent({ kind: 'result', at: 'x', summary: 'done', text: 'The answer' } as any).text).toBe('The answer');
  });
});
