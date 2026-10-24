import { WebSocket } from 'ws';

const pages = await (await fetch('http://127.0.0.1:9333/json/list')).json();
const page = pages.find((entry) => entry.type === 'page');
if (!page) throw new Error(`no page: ${JSON.stringify(pages)}`);
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.once('open', resolve);
  ws.once('error', reject);
});
let nextId = 0;
const pending = new Map();
ws.on('message', (raw) => {
  const msg = JSON.parse(String(raw));
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
  }
});
function call(method, params) {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
await call('Runtime.enable', {});
const result = await call('Runtime.evaluate', {
  expression: `({
    title: document.title,
    core: document.getElementById('core-state') && document.getElementById('core-state').textContent,
    folder: document.getElementById('folder-path') && document.getElementById('folder-path').textContent,
    model: document.getElementById('model-label') && document.getElementById('model-label').textContent,
    submitDisabled: document.getElementById('submit') && document.getElementById('submit').disabled,
    activity: [...document.querySelectorAll('#activity li')].map((item) => item.textContent),
    hasApi: typeof window.karkedikhaDesktop
  })`,
  returnByValue: true,
});
console.log(JSON.stringify(result, null, 2));
ws.close();
