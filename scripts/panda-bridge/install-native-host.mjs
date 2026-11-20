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
import * as os from 'node:os';
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

/**
 * Registry virtualization guard. Processes started by a packaged (MSIX/Store) app get that app's private, copy-on-write view
 * of HKCU\Software: `reg add` succeeds and even reads back, but Chrome never sees the key and reports "Specified native
 * messaging host not found". The packaged app is an ancestor, not the installer itself, so we walk the parent chain looking
 * for package identity (GetPackageFullName). We refuse by default instead of working around it: no scheduled task, no elevation.
 */
const ANCESTRY_PS = String.raw`Add-Type -Namespace W -Name K -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("kernel32.dll")] public static extern System.IntPtr OpenProcess(int a, bool b, int pid);
[System.Runtime.InteropServices.DllImport("kernel32.dll")] public static extern bool CloseHandle(System.IntPtr h);
[System.Runtime.InteropServices.DllImport("kernel32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)] public static extern int GetPackageFullName(System.IntPtr h, ref int n, System.Text.StringBuilder s);
'@
$procs = @{}; Get-CimInstance Win32_Process | ForEach-Object { $procs[[int]$_.ProcessId] = $_ }
$out = @(); $cur = [int]$PID; $seen = @{}
while ($cur -and $procs.ContainsKey($cur) -and -not $seen.ContainsKey($cur)) {
  $seen[$cur] = $true
  $h = [W.K]::OpenProcess(0x1000, $false, $cur)
  if ($h -ne [IntPtr]::Zero) {
    $n = 0; $sb = New-Object System.Text.StringBuilder 512
    $rc = [W.K]::GetPackageFullName($h, [ref]$n, $sb)
    if ($rc -eq 122) { $n = 512; [void][W.K]::GetPackageFullName($h, [ref]$n, $sb); $out += [pscustomobject]@{ pid = $cur; name = $procs[$cur].Name; package = $sb.ToString() } }
    [void][W.K]::CloseHandle($h)
  }
  $cur = [int]$procs[$cur].ParentProcessId
}
ConvertTo-Json -InputObject @($out) -Compress
`;
function packagedAncestors() {
  // A script file (not -EncodedCommand): the here-string inside it does not survive command-line encoding.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panda-anc-'));
  const file = path.join(dir, 'ancestry.ps1');
  fs.writeFileSync(file, ANCESTRY_PS);
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { encoding: 'utf8', windowsHide: true });
  fs.rmSync(file, { force: true });
  if (r.status !== 0) return { error: `powershell exited ${r.status}: ${String(r.stderr).slice(0, 200)}`, list: [] };
  try { const v = JSON.parse(String(r.stdout).trim() || '[]'); return { error: null, list: Array.isArray(v) ? v : [v] }; }
  catch (e) { return { error: `could not read the process-ancestry answer: ${e.message}`, list: [] }; }
}
const ancestry = packagedAncestors();
const packaged = ancestry.list.map((a) => `${a.name} (pid ${a.pid}, package ${a.package})`);
if (args.check) {
  if (ancestry.error) { console.log(`UNKNOWN: ${ancestry.error}`); process.exit(3); }
  console.log(packaged.length ? `NOT SAFE: started under a packaged app: ${packaged.join('; ')}` : 'ok: no packaged ancestor; HKCU writes are real');
  process.exit(packaged.length ? 3 : 0);
}
if ((ancestry.error || packaged.length) && !args['allow-packaged-parent']) {
  console.error(ancestry.error
    ? `Cannot tell whether this process runs under a packaged app (${ancestry.error}). Registry writes might be virtualized. Nothing was changed.`
    : `This installer was started under a packaged app: ${packaged.join('; ')}. Windows gives such processes a private copy of HKCU\\Software, so Chrome would never see the registration and would report "Specified native messaging host not found". Nothing was changed.`);
  console.error('Run it from an ordinary terminal that no packaged app started (for example cmd.exe from the Start menu), then confirm in Chrome. If you know your terminal is not virtualized, pass --allow-packaged-parent.');
  process.exit(3);
}

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
