#!/usr/bin/env node
/**
 * CI-only stand-in for a local Ollama: answers /api/tags, /api/ps and /api/version so desktop tests that check
 * "is the selected model installed?" can run on a runner without Ollama. It serves no model and answers no chat.
 *
 * It refuses to start when anything already answers on its port. On Windows a listener on 127.0.0.1 is accepted
 * beside a real Ollama listening on [::] or 0.0.0.0, and then receives every new IPv4 loopback connection meant for
 * it (Build 161 audit: started locally, this stub stood in front of the real Ollama overnight).
 */
import http from 'node:http';
import net from 'node:net';

const port = Number(process.env.OLLAMA_STUB_PORT || 11434);
const models = ['qwen3.8:27b-mtp-q4_K_M', 'gemma4:12b'];

const answers = (host) => new Promise((resolve) => {
  const socket = net.connect({ host, port });
  const done = (result) => { socket.destroy(); resolve(result); };
  socket.setTimeout(1000, () => done(false));
  socket.once('connect', () => done(true));
  socket.once('error', () => done(false));
});

if ((await Promise.all(['127.0.0.1', '::1'].map(answers))).some(Boolean)) {
  console.error(`ollama tags stub: port ${port} is already served (a real Ollama?); not starting, so nothing is shadowed`);
  process.exit(1);
}

http.createServer((req, res) => {
  const body = req.url?.startsWith('/api/tags') ? { models: models.map((name) => ({ name, model: name, size: 1, details: {} })) }
    : req.url?.startsWith('/api/ps') ? { models: [] }
    : req.url?.startsWith('/api/version') ? { version: 'ci-stub' }
    : null;
  res.writeHead(body ? 200 : 404, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body ?? { error: 'the CI stub serves only /api/tags, /api/ps and /api/version' }));
}).listen(port, '127.0.0.1', () => console.log(`ollama tags stub on 127.0.0.1:${port}`));
