import { useSyncExternalStore } from 'react';
import { onDesktopEvent } from './bridge';
import { applyEvent, type LiveEvent, type RunState } from './runModel';

/**
 * Module-level store for the live run, fed by the same single bridge subscription as every other surface.
 * It lives outside any component so navigating away from Chat and back never loses the steps that happened
 * in between. Only the latest runs of this window session are kept; durable history is Core's.
 */
const MAX_RUNS = 8;
let runs: RunState[] = [];
let version = 0;
const subs = new Set<() => void>();
let started = false;

function emitChange() { version += 1; for (const s of [...subs]) s(); }

export function feedRunEvent(e: LiveEvent): void {
  if (!e.attemptId) return;
  const i = runs.findIndex((r) => r.attemptId === e.attemptId);
  const next = applyEvent(i >= 0 ? runs[i] : null, e);
  if (!next) return;
  if (i >= 0) { if (runs[i] === next) return; runs = runs.map((r, k) => (k === i ? next : r)); }
  else runs = [...runs, next].slice(-MAX_RUNS);
  emitChange();
}

function ensureStarted() {
  if (started) return;
  started = true;
  onDesktopEvent((e) => feedRunEvent(e as unknown as LiveEvent));
}

function subscribe(cb: () => void) { ensureStarted(); subs.add(cb); return () => { subs.delete(cb); }; }
const getVersion = () => version;

/** All runs seen by this window, oldest first. */
export function useRuns(): RunState[] {
  useSyncExternalStore(subscribe, getVersion);
  return runs;
}

export function runFor(attemptId: string | null | undefined): RunState | null {
  return attemptId ? runs.find((r) => r.attemptId === attemptId) ?? null : null;
}

/** Test hook. */
export function resetRunStore(): void { runs = []; emitChange(); }
