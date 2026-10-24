const enabled = process.env.OLLAMA_AGENT_LIVE_M16 === '1' || process.argv.includes('--enabled');

if (!enabled) {
  console.log('SKIPPED: live M16 acceptance requires OLLAMA_AGENT_LIVE_M16=1 or --enabled.');
  console.log('PREREQUISITES: compiled extension, disposable workspace for any mutation-enabled follow-up.');
  console.log('M16_LIVE_ACCEPTANCE_STATUS=skipped-safe-default');
  process.exit(0);
}

console.log('M16 live acceptance only runs deterministic local evaluation checks by default.');
console.log('No repository, GitHub, provider, or credential mutation will be performed.');
console.log('M16_LIVE_ACCEPTANCE_STATUS=enabled-safe-default');
