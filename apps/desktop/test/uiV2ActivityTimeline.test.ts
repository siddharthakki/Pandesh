/** @vitest-environment jsdom */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { applyEvent, type LiveEvent, type RunState } from '../renderer-v2/src/runModel';
import { buildTimeline, whoIsWorking } from '../renderer-v2/src/timelineModel';
import type { WorkspaceActivity } from '../renderer-v2/src/bridge';

const T0 = Date.parse('2026-11-15T10:00:00Z');
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const ev = (s: number, e: Partial<LiveEvent>): LiveEvent => ({ kind: 'activity', at: at(s), attemptId: 'a1', ...e });
const fold = (events: LiveEvent[]) => events.reduce<RunState | null>((r, e) => applyEvent(r, e), null)!;
const act = (o: Partial<WorkspaceActivity>): WorkspaceActivity => ({ id: 'i1', conversationId: 'c', taskId: 'a1', capability: 'terminal', state: 'completed', startedAt: at(2), endedAt: at(5), title: 'Running npm test', ...o });

describe('approval decisions in the run', () => {
  const approve = (decision: 'approved' | 'denied' | 'standing_rule') => fold([
    ev(0, { eventType: 'step_start', domain: 'attempt' }),
    { kind: 'approval', at: at(1), attemptId: 'a1', summary: 'Approve write_file?' },
    { kind: 'assistant_approval_changed', at: at(4), attemptId: 'a1', summary: 'approval_resolved', toolName: 'write_file', detail: { decision } },
  ]);
  it('says who decided, and a denial is blocked, never a success', () => {
    expect(approve('approved').steps.find((s) => s.kind === 'approval')).toMatchObject({ label: 'You approved: write file', state: 'ok' });
    expect(approve('denied').steps.find((s) => s.kind === 'approval')).toMatchObject({ label: 'You denied: write file; it did not run', state: 'blocked' });
    expect(approve('standing_rule').steps.find((s) => s.kind === 'approval')).toMatchObject({ label: 'Allowed by your Auto rule: write file', state: 'ok' });
  });
  it('an expiry says nothing was approved', () => {
    const r = fold([{ kind: 'approval', at: at(1), attemptId: 'a1', summary: 'Approve?' }, { kind: 'assistant_approval_changed', at: at(9), attemptId: 'a1', summary: 'approval_expired', toolName: 'run_command' }]);
    expect(r.steps[0]).toMatchObject({ state: 'blocked', label: 'Approval expired: run command; nothing was approved' });
  });
});

describe('timeline', () => {
  it('orders model passes, tools, approval, check and outcome by time, with failures carrying Core\'s reason', () => {
    const run = fold([
      ev(0, { eventType: 'step_start', domain: 'attempt' }),
      ev(1, { eventType: 'model_pass_ended', domain: 'attempt', detail: { pass: 1, toolCalls: 1, textChars: 0 } }),
      ev(2, { domain: 'tool_invocation', eventType: 'tool_invocation_started', toolName: 'run_command', invocationId: 'i1' }),
      ev(5, { domain: 'tool_invocation', eventType: 'tool_invocation_completed', invocationId: 'i1', invocationStatus: 'failed' }),
      { kind: 'error', at: at(6), attemptId: 'a1', summary: 'tool failed: command exited 1' },
    ]);
    const { entries } = buildTimeline(run, [act({ state: 'failed', detail: 'exit code 1' })]);
    expect(entries.map((e) => e.kind)).toEqual(['model', 'tool', 'outcome']);
    expect(entries[1]).toMatchObject({ label: 'Running npm test', state: 'failed', reason: 'exit code 1' });
    expect(entries[2]).toMatchObject({ kind: 'outcome', state: 'failed', label: 'Failed' });
    expect(entries.map((e) => e.at)).toEqual([...entries.map((e) => e.at)].sort((a, b) => a - b));
  });
  it('lists only saved tool calls after a reload, and says the rest is not available instead of inventing it', () => {
    const { entries, liveEventsMissing } = buildTimeline(null, [act({}), act({ id: 'i2', startedAt: at(8), title: 'Reading a file' })]);
    expect(entries.map((e) => e.label)).toEqual(['Running npm test', 'Reading a file']);
    expect(liveEventsMissing).toBe(true);
    expect(buildTimeline(null, []).liveEventsMissing).toBe(false);
  });
  it('shows interruption and resume as they were recorded', () => {
    const run = fold([
      ev(0, { eventType: 'step_start', domain: 'attempt' }),
      ev(3, { eventType: 'attempt_approval_orphaned', domain: 'attempt' }),
      ev(9, { eventType: 'attempt_resumed', domain: 'attempt' }),
    ]);
    const { entries } = buildTimeline(run, []);
    expect(entries.map((e) => e.label)).toContain('Resumed after your approval');
    const interrupted = fold([ev(0, { eventType: 'step_start', domain: 'attempt' }), ev(3, { eventType: 'attempt_approval_orphaned', domain: 'attempt' })]);
    expect(buildTimeline(interrupted, []).entries.at(-1)).toMatchObject({ kind: 'outcome', label: 'Interrupted', state: 'blocked' });
  });
  it('tells a running tool apart from waiting on the model and on you', () => {
    const phase = (events: LiveEvent[]) => whoIsWorking(fold(events));
    expect(phase([ev(0, { domain: 'tool_invocation', eventType: 'tool_invocation_started', toolName: 'run_command', invocationId: 'i1' })])).toMatchObject({ actor: 'tool', working: true });
    expect(phase([ev(0, { eventType: 'model_pass_started', domain: 'attempt', detail: { pass: 1 } })])).toMatchObject({ actor: 'model', text: 'Waiting for the model', working: false });
    expect(phase([{ kind: 'approval', at: at(0), attemptId: 'a1', summary: 'ok?' }])).toMatchObject({ actor: 'you', working: false });
  });
});

const bridge = {
  listArtifacts: vi.fn(async () => []),
  loadArtifactPreview: vi.fn(async (id: string) => ({ artifact: { id, kind: 'image' }, dataUrl: 'data:image/png;base64,AAAA' })),
  openWorkspaceFolder: vi.fn(async () => ({ opened: true })), openExternalUrl: vi.fn(async () => ({ opened: true })),
  openArtifactFile: vi.fn(async () => ({ opened: true })), openArtifactFolder: vi.fn(async () => ({ opened: true })),
  onEvent: () => () => undefined,
};
let ActivityAside: typeof import('../renderer-v2/src/Activity').ActivityAside;
beforeAll(async () => { (window as unknown as { desktop: unknown }).desktop = bridge; ({ ActivityAside } = await import('../renderer-v2/src/Activity')); });
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const SECRET = 'sk-abcdefghijklmnopqrstuvwxyz123456';
const withPreview = act({ state: 'failed', detail: 'exit code 1', preview: { kind: 'code', title: 'npm test', command: `API_KEY=${SECRET} npm test`, exitCode: 1, excerpt: `FAIL core/a.test.ts\nAuthorization: Bearer abcdef1234567890abcdef\n1 failed`, artifactIds: ['art_1'] } });

describe('activity panel', () => {
  const renderAside = (props: Partial<React.ComponentProps<typeof ActivityAside>> = {}) => render(React.createElement(ActivityAside, { activities: [withPreview], conversationId: 'c', narrow: false, onClose: () => undefined, run: null, running: false, now: T0 + 60_000, currentTaskId: 'a1', ...props }));

  it('opens a failed step by itself with what it was asked and what it returned, with credentials masked', async () => {
    renderAside();
    const row = screen.getByRole('button', { name: /Running npm test/ });
    expect(row.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Asked')).toBeTruthy();
    expect(screen.getByText('Exit code 1')).toBeTruthy();
    const text = document.body.textContent ?? '';
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('abcdef1234567890abcdef');
    expect(text).toContain('API_KEY=••••');
    expect(screen.getByText(/masked/)).toBeTruthy();
    // screenshot thumbnail comes from the artifact the tool published
    await waitFor(() => expect(screen.getByRole('button', { name: /Enlarge/ })).toBeTruthy());
    expect(bridge.loadArtifactPreview).toHaveBeenCalledWith('art_1');
  });

  it('expands and collapses a step on request, and says saved events are missing after a reload', () => {
    renderAside({ activities: [act({ preview: { kind: 'code', title: 'ok', excerpt: 'fine' } })] });
    const row = screen.getByRole('button', { name: /Running npm test/ });
    expect(row.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(row);
    expect(row.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('fine')).toBeTruthy();
    expect(screen.getByText(/kept only while the window is open/)).toBeTruthy();
  });

  it('shows who is working and the live status above the timeline', () => {
    const run = fold([ev(0, { eventType: 'step_start', domain: 'attempt' }), ev(1, { eventType: 'model_pass_started', domain: 'attempt', detail: { pass: 1 } })]);
    renderAside({ run, running: true, activities: [] });
    const status = within(screen.getByLabelText('Status'));
    expect(status.getAllByText('Waiting for the model').length).toBeGreaterThan(0);
    expect(status.getByText(/no output from the model yet/)).toBeTruthy();
  });
});
