#!/usr/bin/env node
/**
 * Minimal Android UI driver for acceptance demos (emulator only): tap by visible text, type, screenshot.
 * Usage: node android-ui.mjs <serial> tap "<text>" | tapdesc "<content-desc>" | type "<text>" | shot <file.png> | dump | key <code> | swipeup | has "<text>"
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ADB = process.env.ADB ?? path.join(process.env.LOCALAPPDATA ?? '', 'Android', 'Sdk', 'platform-tools', 'adb.exe');
const [serial, cmd, arg] = process.argv.slice(2);
if (!serial?.startsWith('emulator-')) { console.error('refusing: this driver only drives emulators'); process.exit(2); }
const adb = (...a) => execFileSync(ADB, ['-s', serial, ...a], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });

function nodes() {
  adb('shell', 'uiautomator', 'dump', '/sdcard/ui.xml');
  const xml = adb('exec-out', 'cat', '/sdcard/ui.xml');
  return [...xml.matchAll(/<node [^>]*>/g)].map((m) => {
    const a = (k) => (new RegExp(`${k}="([^"]*)"`).exec(m[0])?.[1] ?? '');
    const b = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(a('bounds'));
    return { text: a('text'), desc: a('content-desc'), cls: a('class'), clickable: a('clickable') === 'true', bounds: b ? b.slice(1).map(Number) : null };
  });
}

function tapNode(match) {
  const all = nodes();
  const n = all.find(match);
  if (!n?.bounds) { console.error(`not found; visible: ${all.map((x) => x.text || x.desc).filter(Boolean).slice(0, 60).join(' | ')}`); process.exit(1); }
  const [x1, y1, x2, y2] = n.bounds;
  adb('shell', 'input', 'tap', String(Math.round((x1 + x2) / 2)), String(Math.round((y1 + y2) / 2)));
  console.log(`tapped "${n.text || n.desc}" at ${n.bounds}`);
}

switch (cmd) {
  case 'tap': tapNode((n) => n.text === arg) ; break;
  case 'tapcontains': tapNode((n) => n.text.includes(arg)); break;
  case 'tapdesc': tapNode((n) => n.desc === arg); break;
  case 'type': adb('shell', 'input', 'text', arg.replace(/ /g, '%s')); break;
  case 'key': adb('shell', 'input', 'keyevent', arg); break;
  case 'swipeup': adb('shell', 'input', 'swipe', '670', '2200', '670', '900', '400'); break;
  case 'swipedown': adb('shell', 'input', 'swipe', '670', '900', '670', '2200', '400'); break;
  case 'shot': fs.mkdirSync(path.dirname(path.resolve(arg)), { recursive: true }); fs.writeFileSync(arg, execFileSync(ADB, ['-s', serial, 'exec-out', 'screencap', '-p'], { maxBuffer: 64 * 1024 * 1024 })); console.log(`screenshot ${arg}`); break;
  case 'dump': console.log(nodes().map((n) => `${n.text || n.desc}${n.clickable ? ' [click]' : ''} ${n.bounds}`).filter((l) => !l.startsWith(' ')).join('\n')); break;
  case 'has': { const ok = nodes().some((n) => n.text.includes(arg) || n.desc.includes(arg)); console.log(ok ? 'yes' : 'no'); process.exit(ok ? 0 : 1); }
  default: console.error('unknown command'); process.exit(2);
}
