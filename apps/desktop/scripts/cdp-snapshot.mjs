import { WebSocket } from 'ws';

const cdpPort = process.env.KARKEDIKHA_DESKTOP_CDP_PORT || '9334';
const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
const page = list.find((p) => p.type === 'page' && p.webSocketDebuggerUrl);
if (!page) throw new Error('no cdp page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
const result = await new Promise((resolve, reject) => {
  ws.once('message', (raw) => {
    const msg = JSON.parse(String(raw));
    if (msg.error) reject(new Error(msg.error.message));
    else resolve(msg.result);
  });
  ws.send(JSON.stringify({
    id: 1,
    method: 'Runtime.evaluate',
    params: {
      expression: `({
        core: document.getElementById('core-state').textContent,
        submitDisabled: document.getElementById('submit').disabled,
        approvalHidden: document.getElementById('approval-panel').hidden,
        approveDisabled: document.getElementById('approve').disabled,
        gate: document.getElementById('approval-gate').textContent,
        tool: document.getElementById('approval-tool').textContent,
        scope: document.getElementById('approval-scope').textContent,
        result: document.getElementById('result').textContent.slice(0, 800),
        ids: document.getElementById('ids').textContent,
        activity: [...document.querySelectorAll('#activity li')].slice(-15).map((i) => i.textContent),
      })`,
      returnByValue: true,
    },
  }));
});
console.log(JSON.stringify(result.result.value, null, 2));
ws.close();
