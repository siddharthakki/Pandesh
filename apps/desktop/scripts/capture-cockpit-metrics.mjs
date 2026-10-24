/** Captures the cockpit metrics panel text and a screenshot of the Desktop window. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const cdpPort = process.env.KARKEDIKHA_DESKTOP_CDP_PORT || '9333';
const outPath = process.env.KARKEDIKHA_SCREENSHOT_PATH
  ?? path.join(repoRoot, '.tmp', 'cockpit-metrics.png');

const res = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
const page = (await res.json()).find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
if (!page) throw new Error('no debuggable page');

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
let nextId = 1;
const pending = new Map();
ws.on('message', (raw) => {
  const msg = JSON.parse(String(raw));
  const entry = pending.get(msg.id);
  if (!entry) return;
  pending.delete(msg.id);
  if (msg.error) entry.reject(new Error(msg.error.message));
  else entry.resolve(msg.result);
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params }));
});

const metrics = await send('Runtime.evaluate', {
  returnByValue: true,
  expression: `(() => {
    const read = (id) => document.getElementById(id)?.textContent ?? null;
    return {
      aiResponses: read('cockpit-responses'),
      promptTokens: read('cockpit-prompt-tokens'),
      generatedTokens: read('cockpit-generated-tokens'),
      tokenRate: read('cockpit-token-rate'),
      costAvoided: read('cockpit-cost'),
      costBasis: read('cockpit-cost-basis'),
      elapsed: read('cockpit-elapsed'),
      remaining: read('cockpit-remaining'),
      firstCheckpoint: document.querySelector('#checkpoint-pane li')?.textContent?.trim() ?? null,
    };
  })()`,
});
console.log(JSON.stringify(metrics.result.value, null, 2));

const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, Buffer.from(shot.data, 'base64'));
console.log(`screenshot: ${outPath}`);

// A close-up of just the clock and metrics block, which is unreadable at
// window scale.
const box = await send('Runtime.evaluate', {
  returnByValue: true,
  expression: `(() => {
    const rect = document.getElementById('cockpit-phase').closest('section').getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  })()`,
});
const clip = box.result.value;
const closeUp = await send('Page.captureScreenshot', {
  format: 'png',
  clip: { ...clip, scale: 3 },
});
const closeUpPath = outPath.replace(/\.png$/, '-closeup.png');
fs.writeFileSync(closeUpPath, Buffer.from(closeUp.data, 'base64'));
console.log(`closeup: ${closeUpPath}`);
ws.close();
