/** Minimal CDP probe: prints the Desktop snapshot and picker state once. */
import { WebSocket } from 'ws';

const cdpPort = process.env.KARKEDIKHA_DESKTOP_CDP_PORT || '9345';
const res = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
const pages = await res.json();
console.log('pages:', JSON.stringify(pages.map((p) => ({ type: p.type, url: p.url, title: p.title })), null, 2));
const page = pages.find((p) => p.type === 'page' && p.webSocketDebuggerUrl);
if (!page) throw new Error('no page target');

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
const result = await new Promise((resolve, reject) => {
  ws.on('message', (raw) => {
    const msg = JSON.parse(String(raw));
    if (msg.id === 1) (msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result));
  });
  ws.send(JSON.stringify({
    id: 1,
    method: 'Runtime.evaluate',
    params: {
      awaitPromise: true,
      returnByValue: true,
      expression: `window.karkedikhaDesktop.getSnapshot().then((s) => ({
        hasApi: true,
        coreState: s && s.coreState,
        coreDetail: s && s.coreDetail,
        folder: s && s.folder,
        modelAvailable: s && s.modelAvailable,
        model: s && s.model,
        selectedWorker: s && s.selectedWorker,
        workerCount: s && s.workers ? s.workers.length : null,
        hasSelectWorker: typeof window.karkedikhaDesktop.selectWorker,
        domCore: document.getElementById('core-state')?.textContent,
        domFolder: document.getElementById('folder-path')?.textContent,
        domSubmitDisabled: document.getElementById('submit')?.disabled,
        domWorkerOptions: [...(document.getElementById('worker-select')?.options ?? [])]
          .map((o) => ({ value: o.value, disabled: o.disabled })),
      })).catch((e) => ({ error: String(e && e.message || e) }))`,
    },
  }));
});
console.log('state:', JSON.stringify(result.result?.value ?? result, null, 2));
if (result.exceptionDetails) console.log('exception:', JSON.stringify(result.exceptionDetails, null, 2));
ws.close();
