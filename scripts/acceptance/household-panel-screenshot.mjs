#!/usr/bin/env node
/**
 * Opens the dev desktop build on the household demo's isolated data dir and captures the Household panel on Home.
 * Usage: node scripts/acceptance/household-panel-screenshot.mjs <dataDir> <out.png>
 */
import { spawn, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const desktopRoot = path.join(repoRoot, 'apps', 'desktop');
const [dataDir, out] = process.argv.slice(2);
const cdpPort = 9431;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
delete process.env.ELECTRON_RUN_AS_NODE;

const child = spawn(path.join(desktopRoot, 'node_modules', 'electron', 'dist', 'electron.exe'), [`--remote-debugging-port=${cdpPort}`, desktopRoot], {
  cwd: repoRoot, stdio: 'ignore',
  env: {
    ...process.env, KARKEDIKHA_DESKTOP_PRODUCT_ROOT: repoRoot, KARKEDIKHA_DESKTOP_CORE_PATH: path.join(repoRoot, 'out-core', 'core.js'),
    KARKEDIKHA_DESKTOP_NODE: process.execPath, KARKEDIKHA_DESKTOP_DATA_DIR: dataDir, KARKEDIKHA_DESKTOP_HOST_LOG: path.join(dataDir, 'desktop.log'),
    KARKEDIKHA_DESKTOP_CDP_PORT: String(cdpPort), KARKEDIKHA_MODEL_ROUTING_POLICY: 'local-only',
  },
});

let page;
for (let i = 0; i < 200 && !page; i++) {
  try { page = (await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()).find((p) => p.type === 'page' && !p.url.startsWith('devtools')); } catch { /* starting */ }
  if (!page) await sleep(500);
}
if (!page) throw new Error('no window');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.once('open', r));
let id = 1; const pending = new Map();
ws.on('message', (raw) => { const m = JSON.parse(String(raw)); const p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } });
const cdp = (method, params = {}) => new Promise((resolve, reject) => { const i = id++; pending.set(i, { resolve, reject }); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expr) => (await cdp('Runtime.evaluate', { expression: `(async () => (${expr}))()`, awaitPromise: true, returnByValue: true })).result?.value;

const { windowId } = await cdp('Browser.getWindowForTarget').catch(() => ({}));
if (windowId) await cdp('Browser.setWindowBounds', { windowId, bounds: { width: 1440, height: 1000, windowState: 'normal' } }).catch(() => undefined);
for (let i = 0; i < 120; i++) {
  const ready = await evaluate("!document.getElementById('home-household')?.hidden && document.querySelectorAll('.ws-household-group').length >= 4").catch(() => false);
  if (ready) break;
  await sleep(1000);
}
// Open the groups a person would look at, then scroll the section into view.
await evaluate("(() => { document.querySelectorAll('.ws-household-group').forEach((d) => { d.open = true; }); document.getElementById('home-household').scrollIntoView({ block: 'start' }); return true; })()");
await sleep(1200);
const text = await evaluate("document.getElementById('home-household').innerText");
const shot = await cdp('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
fs.writeFileSync(out.replace(/\.png$/, '.txt'), text ?? '');
console.log(text?.slice(0, 3000));
const corePid = (() => { try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'core.json'), 'utf8')).pid; } catch { return null; } })();
child.kill();
if (corePid) try { execFileSync('taskkill', ['/PID', String(corePid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ }
try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ }
process.exit(0);
