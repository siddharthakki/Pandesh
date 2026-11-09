#!/usr/bin/env node
/**
 * CI-only stand-in for a local Ollama: answers /api/tags, /api/ps and /api/version so desktop tests that check
 * "is the selected model installed?" can run on a runner without Ollama. It serves no model and answers no chat.
 */
import http from 'node:http';
const models = ['qwen3.8:27b-mtp-q4_K_M', 'gemma4:12b'];
http.createServer((req, res) => {
  const body = req.url?.startsWith('/api/tags') ? { models: models.map((name) => ({ name, model: name, size: 1, details: {} })) }
    : req.url?.startsWith('/api/ps') ? { models: [] }
    : req.url?.startsWith('/api/version') ? { version: 'ci-stub' }
    : null;
  res.writeHead(body ? 200 : 404, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body ?? { error: 'the CI stub serves only /api/tags, /api/ps and /api/version' }));
}).listen(11434, '127.0.0.1', () => console.log('ollama tags stub on 127.0.0.1:11434'));
