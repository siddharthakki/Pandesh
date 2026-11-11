#!/usr/bin/env node
/**
 * Starts or stops an ISOLATED Pandesh dev instance for the Workshop acceptance (never production): its own profile,
 * its own CDP and phone ports, local models only. Same environment as apps/desktop/launch.mjs, plus two Chromium
 * switches so a window that is covered by other windows keeps drawing (WebGL and screenshots need frames).
 *
 *   node scripts/acceptance/workshop-instance.mjs start --profile D:\PandeshWorkshopDev\profile --cdp 9571 --mobile 3971
 *   node scripts/acceptance/workshop-instance.mjs stop  --cdp 9571
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const desktopRoot = path.join(repoRoot, 'apps', 'desktop');
const [command, ...rest] = process.argv.slice(2);
const opt = Object.fromEntries(rest.reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []));
const cdp = Number(opt.cdp ?? 9571);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function page() {
  try {
    const list = await (await fetch(`http://127.0.0.1:${cdp}/json/list`)).json();
    return list.find((t) => t.type === 'page' && /renderer[\\/]v2[\\/]index\.html/.test(t.url)) ?? null;
  } catch { return null; }
}

if (command === 'start') {
  const profile = path.resolve(String(opt.profile ?? ''));
  const prod = path.join(process.env.LOCALAPPDATA ?? '', 'KarkeDikha', 'desktop').toLowerCase();
  if (!opt.profile || profile.toLowerCase() === prod) { console.error('REFUSED: give an isolated --profile (never the real desktop profile)'); process.exit(2); }
  spawnSync(process.execPath, [path.join(desktopRoot, 'esbuild.mjs')], { cwd: repoRoot, stdio: 'inherit' });
  fs.mkdirSync(path.join(profile, 'electron-profile'), { recursive: true });
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.KARKEDIKHA_OLLAMA_URL;
  Object.assign(env, {
    KARKEDIKHA_DESKTOP_PRODUCT_ROOT: repoRoot,
    KARKEDIKHA_DESKTOP_CORE_PATH: path.join(repoRoot, 'out-core', 'core.js'),
    KARKEDIKHA_DESKTOP_NODE: process.execPath,
    KARKEDIKHA_DESKTOP_DATA_DIR: profile,
    KARKEDIKHA_DESKTOP_HOST_LOG: path.join(profile, 'desktop-host.log'),
    KARKEDIKHA_DESKTOP_CDP_PORT: String(cdp),
    KARKEDIKHA_MOBILE_PORT: String(opt.mobile ?? 3971),
    KARKEDIKHA_MOBILE_HOST: '127.0.0.1',
    KARKEDIKHA_MODEL_ROUTING_POLICY: 'local-only',
    PANDESH_UI_V2: '1',
  });
  const electron = path.join(desktopRoot, 'node_modules', 'electron', 'dist', 'electron.exe');
  const child = spawn(electron, [`--remote-debugging-port=${cdp}`, '--disable-features=CalculateNativeWinOcclusion', '--disable-backgrounding-occluded-windows', desktopRoot], { cwd: repoRoot, env, detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
  for (let i = 0; i < 60; i += 1) { if (await page()) { console.log(`started (pid ${child.pid}); host log ${env.KARKEDIKHA_DESKTOP_HOST_LOG}`); process.exit(0); } await sleep(1000); }
  console.error('the v2 window did not appear on the CDP port'); process.exit(1);
}

if (command === 'stop') {
  const t = await page();
  if (!t) { console.log('not running'); process.exit(0); }
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: 'window.desktop.quitApp()' } }));
  await sleep(500);
  ws.close();
  for (let i = 0; i < 30; i += 1) { if (!(await page())) { console.log('stopped'); process.exit(0); } await sleep(1000); }
  console.error('still running after 30 s'); process.exit(1);
}

console.error('usage: start --profile <dir> --cdp <port> [--mobile <port>] | stop --cdp <port>');
process.exit(2);
