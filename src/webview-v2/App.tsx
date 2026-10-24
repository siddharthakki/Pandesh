import React, { useCallback, useEffect } from 'react';
import { getVsCodeApi } from './bridge/vscodeApi';
import {
  buildApproveDelivery,
  buildApproveMutation,
  buildApproveProposal,
  buildDenyMutation,
  buildModeChanged,
  buildNewConversation,
  buildRejectDelivery,
  buildRejectProposal,
  buildRequestProposalRevision,
  buildSelectConversation,
  buildSendMessage,
  buildSteerTask,
  buildStartAutonomousTask,
  buildWebviewReady,
  translateHostMessage,
} from './bridge/adapter';
import { useUiV2Store } from './state/store';
import { AUTONOMOUS_TERMINAL_STATES, type ModeId } from './state/types';
import { Header } from './components/Header';
import { ModeBar } from './components/ModeBar';
import { StatusBar } from './components/StatusBar';
import { HistoryDrawer } from './components/HistoryDrawer';
import { ActivityPanel } from './components/ActivityPanel';
import { TaskProjectionArea } from './components/TaskProjectionArea';
import { Transcript } from './components/Transcript';
import { Composer } from './components/Composer';

let messageCounter = 0;
function nextId(prefix: string): string {
  messageCounter += 1;
  return `${prefix}_${Date.now()}_${messageCounter}`;
}

export function App() {
  const { state, dispatch, pendingAssistantIdRef } = useUiV2Store();
  // Mirrors AgentPanel's own generated id: after `webviewReady`, the host
  // posts `newConversation` -> `new_conversation`, which sets
  // `selectedConversationId` in state. Until that lands, 'default' matches
  // AgentPanel's LOCAL_CONVERSATION_ID convention for the not-yet-bound turn.
  const conversationIdRef = React.useRef(state.selectedConversationId ?? 'default');
  useEffect(() => {
    conversationIdRef.current = state.selectedConversationId ?? 'default';
  }, [state.selectedConversationId]);

  useEffect(() => {
    const vscode = getVsCodeApi();
    const listener = (event: MessageEvent) => {
      const action = translateHostMessage(event.data, pendingAssistantIdRef.current);
      if (!action) return;
      if (
        action.type === 'assistant_content' ||
        action.type === 'assistant_error' ||
        action.type === 'assistant_stopped'
      ) {
        pendingAssistantIdRef.current = undefined;
      }
      dispatch(action);
    };
    window.addEventListener('message', listener);
    vscode.postMessage(buildWebviewReady(state.status.mode));
    return () => window.removeEventListener('message', listener);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally mount-only, see the shell test asserting exactly one webviewReady
  }, [dispatch, pendingAssistantIdRef]);

  const onSubmit = useCallback(
    (text: string) => {
      const userId = nextId('u');
      dispatch({ type: 'user_submit', id: userId, content: text });
      const vscode = getVsCodeApi();
      if (state.status.mode === 'autonomous') {
        // Karke Dikha has no `mode` field on `sendMessage` at all — it is a
        // structurally distinct message (`startAutonomousTask`) routed to the
        // M15 autonomous runtime, never the chat/agent Core-attempt path.
        //
        // With real task projection (Phase 3): a still-active task (present
        // and not in a terminal state) gets STEERED via the existing
        // `steerTask` path rather than starting a second task — same task id,
        // no new task. Steering is fire-and-forget from the composer's
        // perspective (no reply ever disables it), so `submitting` is cleared
        // immediately; an acknowledgement still lands in the activity
        // timeline once the real `taskSteered` event arrives.
        //
        // Starting a NEW task, by contrast, is no longer cleared immediately
        // — `submitting` now stays true until the real `autonomousTaskStarted`
        // (or a rejection) event lands, so the UI never claims a task exists
        // before the backend actually confirms one. See
        // src/test/golden/goldenJourney.test.tsx for the mode-switch torture
        // test this replaces the old immediate-clear workaround for.
        const activeTask = state.taskProjection;
        const activeTaskTerminal = activeTask ? AUTONOMOUS_TERMINAL_STATES.has(activeTask.state) : true;
        if (activeTask && !activeTaskTerminal) {
          vscode.postMessage(buildSteerTask(activeTask.taskId, text));
          dispatch({ type: 'submitting_changed', submitting: false });
          return;
        }
        vscode.postMessage(buildStartAutonomousTask(text, userId));
        return;
      }
      const assistantId = nextId('a');
      pendingAssistantIdRef.current = assistantId;
      vscode.postMessage(buildSendMessage(text, conversationIdRef.current, state.status.mode));
    },
    [dispatch, pendingAssistantIdRef, state.status.mode],
  );

  const onSelectMode = useCallback(
    (mode: ModeId) => {
      dispatch({ type: 'mode_changed', mode });
      getVsCodeApi().postMessage(buildModeChanged(mode));
    },
    [dispatch],
  );

  const onNewChat = useCallback(() => {
    getVsCodeApi().postMessage(buildNewConversation());
  }, []);

  const onToggleHistory = useCallback(() => dispatch({ type: 'toggle_history' }), [dispatch]);
  const onToggleActivity = useCallback(() => dispatch({ type: 'toggle_activity' }), [dispatch]);

  const onSelectConversation = useCallback((id: string) => {
    getVsCodeApi().postMessage(buildSelectConversation(id));
  }, []);

  // Approval intents: each sends the exact existing host reply message and
  // does NOT touch `state` — the card only disappears once the authoritative
  // `*ApprovalResolved` event comes back through translateHostMessage.
  const approvalHandlers = React.useMemo(
    () => ({
      onApproveProposal: (taskId: string, proposalId: string) =>
        getVsCodeApi().postMessage(buildApproveProposal(taskId, proposalId)),
      onRejectProposal: (taskId: string, proposalId: string) =>
        getVsCodeApi().postMessage(buildRejectProposal(taskId, proposalId)),
      onRequestProposalRevision: (taskId: string, proposalId: string, instructions: string) =>
        getVsCodeApi().postMessage(buildRequestProposalRevision(taskId, proposalId, instructions)),
      onApproveMutation: (taskId: string, requestId: string) =>
        getVsCodeApi().postMessage(buildApproveMutation(taskId, requestId)),
      onDenyMutation: (taskId: string, requestId: string) =>
        getVsCodeApi().postMessage(buildDenyMutation(taskId, requestId)),
      onApproveDelivery: (taskId: string) => getVsCodeApi().postMessage(buildApproveDelivery(taskId)),
      onRejectDelivery: (taskId: string) => getVsCodeApi().postMessage(buildRejectDelivery(taskId)),
    }),
    [],
  );

  return (
    <div className="kd2-app">
      <Header
        onNewChat={onNewChat}
        onToggleHistory={onToggleHistory}
        onToggleActivity={onToggleActivity}
        historyOpen={state.ui.historyOpen}
        activityOpen={state.ui.activityOpen}
      />
      <ModeBar mode={state.status.mode} onSelect={onSelectMode} />
      <StatusBar status={state.status} />

      <HistoryDrawer
        open={state.ui.historyOpen}
        conversations={state.conversations}
        selectedConversationId={state.selectedConversationId}
        onSelect={onSelectConversation}
      />
      <ActivityPanel open={state.ui.activityOpen} status={state.status} />

      <div className="kd2-main">
        {state.ui.fatalError ? (
          <div className="kd2-fatal-error" role="alert">{state.ui.fatalError}</div>
        ) : null}
        <Transcript messages={state.conversation} />
        <TaskProjectionArea task={state.taskProjection} approvals={state.approvals} handlers={approvalHandlers} />
      </div>

      <Composer disabled={state.ui.submitting} onSubmit={onSubmit} />
    </div>
  );
}
