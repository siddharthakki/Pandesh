import { describe, it, expect } from 'vitest';
import { createInitialState, reduceUiV2 } from '../../webview-v2/state/types';
import { buildSendMessage, translateHostMessage } from '../../webview-v2/bridge/adapter';

describe('UiV2 reducer', () => {
  it('appends a user message and marks submitting on user_submit', () => {
    const s0 = createInitialState();
    const s1 = reduceUiV2(s0, { type: 'user_submit', id: 'u1', content: 'hi' });
    expect(s1.conversation).toEqual([{ id: 'u1', role: 'user', content: 'hi' }]);
    expect(s1.ui.submitting).toBe(true);
  });

  it('inserts the assistant reply and clears submitting on assistant_content', () => {
    const s0 = reduceUiV2(createInitialState(), { type: 'user_submit', id: 'u1', content: 'hi' });
    const s1 = reduceUiV2(s0, { type: 'assistant_content', id: 'a1', content: 'hello there' });
    expect(s1.conversation.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(s1.conversation[1].content).toBe('hello there');
    expect(s1.ui.submitting).toBe(false);
  });

  it('attaches an error to the assistant message without dropping the conversation', () => {
    const s0 = reduceUiV2(createInitialState(), { type: 'user_submit', id: 'u1', content: 'hi' });
    const s1 = reduceUiV2(s0, { type: 'assistant_error', id: 'a1', message: 'boom' });
    expect(s1.conversation[1].error).toBe('boom');
    expect(s1.ui.submitting).toBe(false);
  });
});

describe('compatibility adapter', () => {
  it('builds the legacy sendMessage host shape from plain text', () => {
    const msg = buildSendMessage('hello', 'conv-1');
    expect(msg).toEqual({
      type: 'sendMessage',
      text: 'hello',
      mode: 'agent',
      model: '',
      attachmentIds: [],
      conversationId: 'conv-1',
    });
  });

  it('translates a legacy assistantContent event using the pending assistant id', () => {
    const action = translateHostMessage({ type: 'assistantContent', content: 'hi' }, 'a1');
    expect(action).toEqual({ type: 'assistant_content', id: 'a1', content: 'hi' });
  });

  it('drops assistantContent when nothing is pending (no id to attribute it to)', () => {
    const action = translateHostMessage({ type: 'assistantContent', content: 'hi' }, undefined);
    expect(action).toBeUndefined();
  });

  it('routes a legacy error to the pending assistant message when one is in flight', () => {
    const action = translateHostMessage({ type: 'error', message: 'boom' }, 'a1');
    expect(action).toEqual({ type: 'assistant_error', id: 'a1', message: 'boom' });
  });

  it('routes a legacy error to a fatal_error when nothing is pending', () => {
    const action = translateHostMessage({ type: 'error', message: 'boom' }, undefined);
    expect(action).toEqual({ type: 'fatal_error', message: 'boom' });
  });

  it('ignores unrelated host message types', () => {
    expect(translateHostMessage({ type: 'someUnhandledType' }, 'a1')).toBeUndefined();
  });

  it('translates newConversation into a new_conversation action for shell history parity', () => {
    expect(translateHostMessage({ type: 'newConversation', id: 'x' }, 'a1')).toEqual({
      type: 'new_conversation',
      id: 'x',
    });
  });

  // Real Baat Kar production contract (src/ui/AgentPanel.ts: handleCoreRuntimeToken /
  // finishCoreExecutionTurn) — streaming 'token' chunks followed by a terminal 'done'.
  it('accumulates streaming token deltas into the pending assistant message', () => {
    const t1 = translateHostMessage({ type: 'token', delta: 'Hel' }, 'a1');
    expect(t1).toEqual({ type: 'assistant_token', id: 'a1', delta: 'Hel' });
    const s0 = reduceUiV2(createInitialState(), { type: 'user_submit', id: 'u1', content: 'hi' });
    const s1 = reduceUiV2(s0, t1!);
    const s2 = reduceUiV2(s1, { type: 'assistant_token', id: 'a1', delta: 'lo' });
    expect(s2.conversation[1]).toMatchObject({ id: 'a1', content: 'Hello', streaming: true });
    expect(s2.stream).toEqual({ active: true, messageId: 'a1' });
  });

  it('translates the terminal done event using the pending assistant id, finalizing the message', () => {
    const action = translateHostMessage({ type: 'done', content: 'full reply', messageId: 'srv-1' }, 'a1');
    expect(action).toEqual({ type: 'assistant_content', id: 'a1', content: 'full reply' });
    const s0 = reduceUiV2(createInitialState(), { type: 'user_submit', id: 'u1', content: 'hi' });
    const s1 = reduceUiV2(s0, { type: 'assistant_token', id: 'a1', delta: 'partial' });
    const s2 = reduceUiV2(s1, action!);
    expect(s2.conversation[1]).toEqual({ id: 'a1', role: 'assistant', content: 'full reply', error: undefined, streaming: undefined });
    expect(s2.ui.submitting).toBe(false);
    expect(s2.stream.active).toBe(false);
  });

  it('drops token/done when nothing is pending', () => {
    expect(translateHostMessage({ type: 'token', delta: 'x' }, undefined)).toBeUndefined();
    expect(translateHostMessage({ type: 'done', content: 'x' }, undefined)).toBeUndefined();
  });

  it('translates stopped into assistant_stopped, preserving already-streamed content', () => {
    const action = translateHostMessage({ type: 'stopped' }, 'a1');
    expect(action).toEqual({ type: 'assistant_stopped', id: 'a1' });
    const s0 = reduceUiV2(createInitialState(), { type: 'user_submit', id: 'u1', content: 'hi' });
    const s1 = reduceUiV2(s0, { type: 'assistant_token', id: 'a1', delta: 'partial' });
    const s2 = reduceUiV2(s1, action!);
    expect(s2.conversation[1].content).toBe('partial');
    expect(s2.ui.submitting).toBe(false);
    expect(s2.stream.active).toBe(false);
  });
});

describe('rejected steering', () => {
  it('translates the host rejection and records it in the task activity instead of implying it was applied', () => {
    const action = translateHostMessage({ type: 'taskSteerRejected', taskId: 't1', messageId: 'm1', reason: 'task is not running' }, undefined);
    expect(action).toEqual({ type: 'task_steer_rejected', taskId: 't1', reason: 'task is not running' });

    const started = reduceUiV2(createInitialState(), { type: 'autonomous_task_started', taskId: 't1', goal: 'g', state: 'running' });
    const rejected = reduceUiV2(started, action!);
    const last = rejected.taskProjection?.activity.at(-1);
    expect(last).toMatchObject({ kind: 'steer_rejected', title: 'Guidance was not applied', detail: 'task is not running' });
  });

  it('ignores a rejection for a task that is not the projected one', () => {
    const started = reduceUiV2(createInitialState(), { type: 'autonomous_task_started', taskId: 't1', goal: 'g', state: 'running' });
    expect(reduceUiV2(started, { type: 'task_steer_rejected', taskId: 'other', reason: 'x' })).toBe(started);
  });
});
