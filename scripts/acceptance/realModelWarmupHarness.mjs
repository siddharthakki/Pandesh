/**
 * Bounded, evidence-first real-Ollama warmup used only by the Windows
 * packaged-acceptance diagnostic. It deliberately has no knowledge of
 * packaged scenario acceptance: callers must record its result separately.
 */
export async function warmModel({
  url,
  model,
  purpose,
  timeoutMs = 180000,
  fetchImpl = fetch,
  now = () => Date.now(),
}) {
  const startedAt = new Date().toISOString();
  const startedMs = now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${url.replace(/\/$/, '')}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        stream: false,
        keep_alive: '10m',
        messages: [{ role: 'user', content: `Reply with the word ready for ${purpose}.` }],
        options: { num_predict: 4 },
      }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    if (!body.done || body.model !== model) {
      throw new Error(`unexpected readiness response: ${JSON.stringify({ model: body.model, done: body.done })}`);
    }
    return { model, purpose, status: 'passed', timeoutMs, startedAt, elapsedMs: now() - startedMs, error: null };
  } catch (error) {
    return {
      model,
      purpose,
      status: controller.signal.aborted ? 'timed_out' : 'failed',
      timeoutMs,
      startedAt,
      elapsedMs: now() - startedMs,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function warmModels({ url, models, timeoutMs, fetchImpl, now } = {}) {
  const startedAt = new Date().toISOString();
  const results = [];
  for (const { model, purpose } of models ?? []) {
    results.push(await warmModel({ url, model, purpose, timeoutMs, fetchImpl, now }));
  }
  return {
    kind: 'real_model_warmup_diagnostic',
    status: results.every((result) => result.status === 'passed') ? 'passed' : 'failed',
    exitCode: results.every((result) => result.status === 'passed') ? 0 : 1,
    startedAt,
    completedAt: new Date().toISOString(),
    ollamaUrl: url,
    timeoutMs,
    models: results,
  };
}
