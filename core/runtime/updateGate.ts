/**
 * Update gate: lets the desktop host prepare Core for an application update without cutting a Gmail write in half.
 *
 * - `quiesce(true)` refuses to START new Gmail writes (a plan apply or undo). Nothing is modified when it refuses.
 * - A write that already started always runs to its end: `runGws` calls and whole apply/undo spans are counted, and
 *   `drainWrites` (used by the host before it stops Core, and by Core's own shutdown) waits for the count to reach 0.
 */
let quiescing = false;
let writesInFlight = 0;

export function setQuiescing(on: boolean): void {
  quiescing = on;
}

export function isQuiescing(): boolean {
  return quiescing;
}

export function gmailWritesInFlight(): number {
  return writesInFlight;
}

/** Marks a Gmail write span as running. Call the returned function when the span ends (success or failure). */
export function beginWrite(): () => void {
  writesInFlight += 1;
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    writesInFlight -= 1;
  };
}

/** Resolves true when no write is in flight, false when `timeoutMs` passes first. */
export async function drainWrites(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (writesInFlight > 0) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return true;
}

export const UPDATE_IN_PROGRESS_MESSAGE =
  'NOT DONE. Pandesh is preparing an application update and is not starting new Gmail changes. Nothing was modified; try again after the restart.';
