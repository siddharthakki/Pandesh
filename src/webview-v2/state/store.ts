import { useReducer, useRef } from 'react';
import { createInitialState, reduceUiV2, type UiV2State, type UiV2Action } from './types';

export function useUiV2Store() {
  const [state, dispatch] = useReducer(reduceUiV2, undefined, createInitialState);
  // Tracks the assistant message id currently awaiting a host response, so the
  // adapter can attribute a bare `assistantContent`/`error` event to it.
  const pendingAssistantIdRef = useRef<string | undefined>(undefined);
  return { state, dispatch, pendingAssistantIdRef };
}

export type { UiV2State, UiV2Action };
