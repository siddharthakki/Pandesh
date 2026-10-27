#!/usr/bin/env node
/**
 * Registers the Pandesh Panda bridge native-messaging host for the current Windows user (HKCU only; no admin rights, nothing
 * system-wide, no change to the Pandesh installation or its data).
 *
 *   node scripts/panda-bridge/install-native-host.mjs --data-dir "%LOCALAPPDATA%\KarkeDikha" [--browser chrome|chromium|edge]
 *        [--extension-id <id>] [--pandesh-exe "C:\...\Pandesh.exe"] [--install-dir <dir>] [--host-name <name>]
 *   node scripts/panda-bridge/install-native-host.mjs --uninstall [--browser ...] [--host-name <name>]
 *
 * --data-dir is required on purpose: it decides which Pandesh the browser can reach, so it is never guessed.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_EXTENSION_ID = 'emejmmocdfgfigdlekonndnmpjfdjimm';
const REG_ROOTS = {
  chrome: 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts',
  chromium: 'HKCU\\Software\\Chromium\\NativeMessagingHosts',
  edge: 'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts',
};

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true; else { out[key] = next; i++; }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (process.platform !== 'win32') { console.error('This installer registers the host through the Windows registry.'); process.exit(2); }

const hostName = String(args['host-name'] || 'com.pandesh.panda_bridge');
if (!/^[a-z0-9_]+(\.[a-z0-9_]+)+$/.test(hostName)) { console.error('Invalid --host-name'); process.exit(2); }
const browsers = args.browser === 'all' ? Object.keys(REG_ROOTS) : [String(args.browser || 'chrome')];
for (const b of browsers) if (!REG_ROOTS[b]) { console.error(`Unknown --browser ${b}`); process.exit(2); }
const installDir = path.resolve(String(args['install-dir'] || path.join(process.env.LOCALAPPDATA || '', 'Pandesh', 'PandaBridge')));

function reg(...a) { return spawnSync('reg.exe', a, { encoding: 'utf8', windowsHide: true }); }

if (args.uninstall) {
  for (const b of browsers) {
    const r = reg('delete', `${REG_ROOTS[b]}\\${hostName}`, '/f');
    console.log(`${b}: ${r.status === 0 ? 'unregistered' : 'was not registered'}`);
  }
  fs.rmSync(installDir, { recursive: true, force: true });
  console.log(`removed ${installDir}`);
  process.exit(0);
}

if (!args['data-dir'] || args['data-dir'] === true) { console.error('--data-dir is required (the Pandesh data directory that holds core.json and core.token)'); process.exit(2); }
const dataDir = path.resolve(String(args['data-dir']));
const extensionId = String(args['extension-id'] || DEFAULT_EXTENSION_ID);
if (!/^[a-p]{32}$/.test(extensionId)) { console.error('--extension-id must be a 32-letter Chrome extension id'); process.exit(2); }

fs.mkdirSync(installDir, { recursive: true });
const hostJs = path.join(installDir, 'panda-native-host.mjs');
fs.copyFileSync(path.resolve(HERE, '..', '..', 'apps', 'panda-bridge', 'native-host', 'panda-native-host.mjs'), hostJs);
const config = { dataDir, ...(args['pandesh-exe'] && args['pandesh-exe'] !== true ? { pandeshExe: path.resolve(String(args['pandesh-exe'])) } : {}) };
fs.writeFileSync(path.join(installDir, 'host-config.json'), JSON.stringify(config, null, 2));
const launcher = path.join(installDir, 'panda-native-host.cmd');
fs.writeFileSync(launcher, `@echo off\r\n"${process.execPath}" "${hostJs}" %*\r\n`);
const manifest = path.join(installDir, `${hostName}.json`);
fs.writeFileSync(manifest, JSON.stringify({
  name: hostName,
  description: 'Pandesh Panda bridge: relays ChatGPT prompts you choose to send to Pandesh on this PC',
  path: launcher,
  type: 'stdio',
  allowed_origins: [`chrome-extension://${extensionId}/`],
}, null, 2));

for (const b of browsers) {
  const r = reg('add', `${REG_ROOTS[b]}\\${hostName}`, '/ve', '/t', 'REG_SZ', '/d', manifest, '/f');
  if (r.status !== 0) { console.error(`${b}: registry write failed: ${(r.stderr || r.stdout || '').trim()}`); process.exit(1); }
  console.log(`${b}: registered ${hostName} -> ${manifest}`);
}
console.log(`host: ${launcher}\ndata dir: ${dataDir}\nextension: chrome-extension://${extensionId}/`);
