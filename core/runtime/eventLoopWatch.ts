/** Logs every stretch where this process's event loop did not run for `thresholdMs`, so a stalled start leaves a trace. */
export function watchEventLoopStalls(log: (message: string) => void, options: { thresholdMs?: number; intervalMs?: number; label?: string } = {}): () => void {
  const interval = options.intervalMs ?? 500;
  const threshold = options.thresholdMs ?? 2_000;
  let last = Date.now();
  const timer = setInterval(() => {
    const at = Date.now();
    const lag = at - last - interval;
    if (lag >= threshold) log(`${options.label ?? 'process'}: event loop did not run for ${Math.round(lag)} ms (until ${new Date(at).toISOString()})`);
    last = at;
  }, interval);
  timer.unref?.();
  return () => clearInterval(timer);
}
