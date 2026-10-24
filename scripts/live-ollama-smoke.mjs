const enabled = process.env.OLLAMA_AGENT_LIVE_OLLAMA === '1' || process.argv.includes('--enabled');
if (!enabled) {
  console.log('SKIPPED: set OLLAMA_AGENT_LIVE_OLLAMA=1 or pass --enabled to run live Ollama readiness.');
  process.exit(0);
}

const baseUrl = (process.env.OLLAMA_AGENT_OLLAMA_BASE_URL ?? 'http://localhost:11434').replace(/\/$/, '');
const tags = await requestJson(`${baseUrl}/api/tags`, undefined, 8_000, 'readiness');
const models = Array.isArray(tags.models) ? tags.models.map(model => String(model.name || model.model || '')).filter(Boolean) : [];
console.log(`PASSED: Ollama readiness succeeded at ${baseUrl}; discovered ${models.length} model(s).`);

if (process.argv.includes('--chat')) {
  if (models.length === 0) throw new Error('Live Ollama chat smoke requires at least one installed model.');
  const configured = process.env.OLLAMA_AGENT_SMOKE_MODEL;
  const preferred = ['qwen2.5-coder:1.5b', 'llama3.2:1b'];
  const model = configured && models.includes(configured)
    ? configured
    : preferred.find(candidate => models.includes(candidate)) ?? models[0];
  const marker = 'KARKEDIKHA_SMOKE_OK';
  const result = await requestJson(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      messages: [
        { role: 'system', content: 'Follow the user output format exactly.' },
        { role: 'user', content: `Reply with exactly this token and nothing else: ${marker}` },
      ],
      options: { temperature: 0 },
    }),
  }, 180_000, 'chat');
  const content = String(result?.message?.content ?? '').trim();
  if (!content.includes(marker)) throw new Error(`Live Ollama chat smoke returned unexpected content from ${model}: ${content.slice(0, 200)}`);
  console.log(`PASSED: live Ollama chat response succeeded with ${model}.`);
}

async function requestJson(url, options, timeoutMs, label) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}`);
    return await response.json();
  } catch (error) {
    const reason = error instanceof Error && error.name === 'AbortError' ? 'timed out' : error instanceof Error ? error.message : String(error);
    console.error(`FAILED: Ollama ${label} ${reason} at ${url}.`);
    process.exit(1);
  } finally {
    clearTimeout(timer);
  }
}
