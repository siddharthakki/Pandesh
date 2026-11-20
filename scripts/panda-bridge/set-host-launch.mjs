#!/usr/bin/env node
/**
 * Adds the launch details "Open in Pandesh" needs to the native host's host-config.json WITHOUT replacing the file:
 * existing fields (dataDir, pandeshExe, ...) are kept, only pandeshExe and pandeshArgs are set, and the original is saved
 * next to it as host-config.json.bak first. Both paths are checked to exist before anything is written.
 *
 *   node scripts/panda-bridge/set-host-launch.mjs --root E:\Pandesh --check     (shows what would change, writes nothing)
 *   node scripts/panda-bridge/set-host-launch.mjs --root E:\Pandesh              (applies it)
 *   optional: --config <path to host-config.json>   (default %LOCALAPPDATA%\Pandesh\PandaBridge\host-config.json)
 *
 * Run it from an ordinary terminal (Win+R, cmd), like the installer: a process started under a packaged app writes to a private
 * copy of AppData that the browser's native host never sees. It verifies by reading the file back.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Pure merge: keeps every existing field, sets the two launch fields. */
export function mergeLaunchConfig(existing, exe, appDir) {
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) throw new Error('host-config.json is not a JSON object');
  if (!existing.dataDir) throw new Error('host-config.json has no dataDir; refusing to touch an unrecognised config');
  return { ...existing, pandeshExe: exe, pandeshArgs: [appDir] };
}

function parseArgs(argv) {
  const out = { check: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') out.check = true;
    else if (a === '--root' || a === '--config') out[a.slice(2)] = argv[++i];
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.root) { console.error('--root <Pandesh install folder, e.g. E:\\Pandesh> is required'); process.exit(2); }
  const exe = path.join(args.root, 'electron', 'Pandesh.exe');
  const appDir = path.join(args.root, 'app');
  const config = args.config || path.join(process.env.LOCALAPPDATA || '', 'Pandesh', 'PandaBridge', 'host-config.json');
  for (const [what, p] of [['executable', exe], ['application folder', appDir], ['host config', config]]) {
    if (!fs.existsSync(p)) { console.error(`REFUSED: ${what} not found: ${p}. Nothing was changed.`); process.exit(2); }
  }
  const before = JSON.parse(fs.readFileSync(config, 'utf8'));
  const after = mergeLaunchConfig(before, exe, appDir);
  console.log(`config: ${config}`);
  console.log(`kept:   ${Object.keys(before).filter((k) => k !== 'pandeshExe' && k !== 'pandeshArgs').join(', ')}`);
  console.log(`sets:   pandeshExe = ${exe}\n        pandeshArgs = ["${appDir}"]`);
  if (args.check) { console.log('--check: nothing written.'); return; }
  fs.copyFileSync(config, `${config}.bak`);
  fs.writeFileSync(config, JSON.stringify(after, null, 2));
  const back = JSON.parse(fs.readFileSync(config, 'utf8'));
  if (back.pandeshExe !== exe || back.dataDir !== before.dataDir) { console.error('Read-back does not match; restore host-config.json.bak.'); process.exit(3); }
  console.log(`done. Original saved as ${config}.bak. Verify from Chrome: press "Open in Pandesh" on a task card.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
