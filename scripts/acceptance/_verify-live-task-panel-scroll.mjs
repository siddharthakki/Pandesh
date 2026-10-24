import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const media = path.join(root, 'media');
const port = 8765;
const origin = `http://127.0.0.1:${port}`;

const mime = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
  ['.svg', 'image/svg+xml'],
]);

const driver = `
<script nonce="test-nonce">
(() => {
  const fire = (data) => window.dispatchEvent(new MessageEvent('message', { data }));
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const nearBottom = (el) => el.scrollHeight - el.scrollTop - el.clientHeight < 64;

  async function ready() {
    for (let i = 0; i < 80; i += 1) {
      if (window.__kdLiveScroll && document.getElementById('autonomous-timeline')) return;
      await wait(50);
    }
    throw new Error('webview scripts did not load');
  }

  async function run() {
    await ready();
    fire({ type: 'workspaceRestorationResolved', workspaceIdentity: 'verify-workspace' });
    const messages = document.getElementById('messages');
    messages.style.maxHeight = '360px';
    messages.style.height = '360px';

    fire({
      type: 'autonomousTaskStarted',
      taskId: 'task-live',
      attemptId: 'attempt-1',
      state: 'queued',
      goal: 'Investigate the live task panel scrolling',
    });
    const details = document.getElementById('kd-task-details');
    details.open = true;
    await wait(30);

    const events = [];
    for (let i = 1; i <= 14; i += 1) {
      events.push({
        eventId: 'e' + i,
        seq: i,
        renderedProgress: i + '. Inspecting file cluster ' + i + ' — search hits and reads keep arriving.',
      });
      fire({
        type: 'autonomousTaskStatus',
        taskId: 'task-live',
        attemptId: 'attempt-1',
        state: 'running',
        goal: 'Investigate the live task panel scrolling',
        events: events.slice(),
      });
      await wait(40);
    }

    const jump = document.getElementById('kd-jump-latest');
    await wait(150);
    const followed = nearBottom(messages) && jump.hidden;
    const metricsAfterFollow = {
      scrollTop: messages.scrollTop,
      scrollHeight: messages.scrollHeight,
      clientHeight: messages.clientHeight,
      jumpHidden: jump.hidden,
      following: window.__kdLiveScroll?.isFollowing?.() !== false,
    };
    const firstNode = document.querySelector('#autonomous-timeline .autonomous-timeline-entry');

    window.__kdLiveScroll?.releaseFollow?.();
    messages.style.scrollBehavior = 'auto';
    messages.scrollTop = 24;
    const immediateTop = messages.scrollTop;
    messages.dispatchEvent(new Event('scroll'));
    await wait(80);
    const jumpShown = !jump.hidden;
    const frozen = messages.scrollTop;
    const afterScroll = {
      following: window.__kdLiveScroll?.isFollowing?.() === true,
      jumpHidden: jump.hidden,
      scrollTop: frozen,
      immediateTop,
      statusHidden: document.getElementById('autonomous-status')?.hidden === true,
    };

    for (let i = 15; i <= 20; i += 1) {
      events.push({
        eventId: 'e' + i,
        seq: i,
        renderedProgress: i + '. Later activity that must not steal the scrolled position.',
      });
      fire({
        type: 'autonomousTaskStatus',
        taskId: 'task-live',
        attemptId: 'attempt-1',
        state: 'running',
        events: events.slice(),
      });
      await wait(40);
    }

    const preserved = Math.abs(messages.scrollTop - frozen) <= 2;
    const detailsPreserved = details.open === true;
    const sameFirstNode = document.querySelector('#autonomous-timeline .autonomous-timeline-entry') === firstNode;
    const staleIgnored = !document.getElementById('autonomous-timeline').textContent.includes('STALE-TASK');
    fire({
      type: 'autonomousTaskStatus',
      taskId: 'task-other',
      attemptId: 'attempt-9',
      state: 'running',
      events: [{ eventId: 'stale', seq: 1, renderedProgress: 'STALE-TASK' }],
    });
    await wait(40);

    jump.click();
    await wait(200);
    const jumped = nearBottom(messages) && jump.hidden;
    const timelineOwned = details.contains(document.getElementById('autonomous-timeline'));
    const noStolenPanel = !document.getElementById('autonomous-technical-details');

    const result = {
      followed,
      jumpShown,
      preserved,
      detailsPreserved,
      sameFirstNode,
      staleIgnored: staleIgnored && !document.getElementById('autonomous-timeline').textContent.includes('STALE-TASK'),
      jumped,
      timelineOwned,
      noStolenPanel,
      metricsAfterFollow,
      afterScroll,
    };
    result.pass = followed && jumpShown && preserved && detailsPreserved && sameFirstNode && result.staleIgnored && jumped && timelineOwned && noStolenPanel;
    window.__kdScrollVerify = result;
    document.title = result.pass ? 'PASS live task panel scroll' : 'FAIL live task panel scroll';
    let out = document.getElementById('kd-scroll-verify-result');
    if (!out) {
      out = document.createElement('pre');
      out.id = 'kd-scroll-verify-result';
      out.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:99;max-width:46vw;padding:8px;background:#111;color:#9f9;font:12px/1.4 monospace;';
      document.body.appendChild(out);
    }
    out.textContent = JSON.stringify(result, null, 2);
  }

  run().catch((error) => {
    window.__kdScrollVerify = { pass: false, error: String(error && error.message || error) };
    document.title = 'FAIL live task panel scroll';
  });
})();
</script>
`;

function patchedChatHtml() {
  let html = fs.readFileSync(path.join(media, 'chat.html'), 'utf8');
  html = html
    .replaceAll('{{cspSource}}', `'self' ${origin}`)
    .replaceAll('{{nonce}}', 'test-nonce')
    .replaceAll('{{cssUri}}', '/media/chat.css')
    .replaceAll('{{jsUri}}', '/media/chat.js')
    .replaceAll('{{pandaBaseUri}}', '/media/panda')
    .replaceAll('{{modelName}}', 'test-model');
  const mock = `<script nonce="test-nonce">
    window.acquireVsCodeApi = () => ({
      postMessage() {},
      getState() { return {}; },
      setState() {},
    });
  </script>`;
  html = html.replace('<body>', `<body>
  <style>
    html, body, .app-shell { height: 100%; margin: 0; }
    .workspace, .chat-window, .chat-messages-shell { height: 100%; min-height: 0; }
  </style>
  ${mock}`);
  html = html.replace('</body>', `${driver}\n</body>`);
  return html;
}

function serveFile(urlPath) {
  if (urlPath === '/' || urlPath === '/index.html') {
    return { body: patchedChatHtml(), type: 'text/html; charset=utf-8' };
  }
  const relative = urlPath.replace(/^\/media\//, '');
  const filePath = path.join(media, relative);
  if (!filePath.startsWith(media) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    return null;
  }
  return { body: fs.readFileSync(filePath), type: mime.get(path.extname(filePath)) || 'application/octet-stream' };
}

function findBrowser() {
  const candidates = [
    process.env.EDGE_PATH,
    process.env.CHROME_PATH,
    'C:\\\\Program Files (x86)\\\\Microsoft\\\\Edge\\\\Application\\\\msedge.exe',
    'C:\\\\Program Files\\\\Microsoft\\\\Edge\\\\Application\\\\msedge.exe',
    'C:\\\\Program Files\\\\Google\\\\Chrome\\\\Application\\\\chrome.exe',
    'C:\\\\Program Files (x86)\\\\Google\\\\Chrome\\\\Application\\\\chrome.exe',
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

async function cdpResult(debugPort) {
  const deadline = Date.now() + 20000;
  let target;
  while (Date.now() < deadline) {
    try {
      const pages = await fetch(`http://127.0.0.1:${debugPort}/json`).then((res) => res.json());
      target = pages.find((page) => page.type === 'page' && page.webSocketDebuggerUrl);
      if (target) break;
    } catch {
      // Browser is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if (!target) throw new Error('No browser page for CDP');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', () => reject(new Error('CDP websocket failed')));
  });

  let nextId = 1;
  const pending = new Map();
  ws.addEventListener('message', (event) => {
    const payload = JSON.parse(String(event.data));
    if (payload.id && pending.has(payload.id)) pending.get(payload.id)(payload);
  });
  const send = (method, params) => new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });

  await send('Runtime.enable');
  let result;
  while (Date.now() < deadline) {
    const evaluated = await send('Runtime.evaluate', {
      expression: 'window.__kdScrollVerify ? JSON.stringify(window.__kdScrollVerify) : null',
      returnByValue: true,
    });
    const value = evaluated.result?.result?.value;
    if (value) {
      result = JSON.parse(value);
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  ws.close();
  if (!result) throw new Error('Browser did not finish the scroll scenario');
  return result;
}

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  const file = serveFile(urlPath);
  if (!file) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': file.type, 'Cache-Control': 'no-store' });
  res.end(file.body);
});

await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
const browser = findBrowser();
if (!browser) {
  server.close();
  console.error('No Edge/Chrome binary found for live UI verification.');
  process.exit(2);
}

const debugPort = 9229;
const profile = path.join(root, '.tmp', 'live-task-panel-scroll-profile');
fs.mkdirSync(profile, { recursive: true });
const child = spawn(browser, [
  `--user-data-dir=${profile}`,
  `--remote-debugging-port=${debugPort}`,
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  `${origin}/`,
], { stdio: 'ignore' });

try {
  const result = await cdpResult(debugPort);
  console.log(JSON.stringify(result, null, 2));
  if (!result.pass) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  child.kill();
  server.close();
}
