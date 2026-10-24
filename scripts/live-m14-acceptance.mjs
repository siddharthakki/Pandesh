#!/usr/bin/env node

const enabled = process.env.OLLAMA_AGENT_LIVE_M14 === '1' || process.argv.includes('--enabled');

if (!enabled) {
  console.log('SKIPPED: live M14 acceptance requires OLLAMA_AGENT_LIVE_M14=1 or --enabled.');
  process.exit(0);
}

console.error('Live M14 acceptance is intentionally opt-in and must be run from a disposable workspace with a configured local model.');
process.exit(1);
