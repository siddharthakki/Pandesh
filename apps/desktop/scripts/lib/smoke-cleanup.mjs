import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

export function assertSmokeRoot(scratch) {
  const resolved = path.resolve(scratch);
  if (path.dirname(resolved).toLowerCase() !== path.resolve(os.tmpdir()).toLowerCase()
      || !/^(pandesh-approval-e2e-|karkedikha-installer-smoke-)[a-z0-9-]+$/i.test(path.basename(resolved))) {
    throw new Error('Refusing cleanup outside a dedicated smoke directory: ' + resolved);
  }
  return resolved;
}

// Core is detached from Electron: taskkill /T alone leaves it behind.
// Match executable paths under this exact installation, then re-check process
// creation time and path immediately before stopping each captured process.
export function stopSmokeProcesses(scratch) {
  const install = path.join(assertSmokeRoot(scratch), 'install') + path.sep;
  const script = `$ErrorActionPreference = 'Stop'
$prefix = $env.PANDESH_SMOKE_INSTALL
if ([string]::IsNullOrWhiteSpace($prefix) -or $prefix.Length -lt 15) {
  throw "Refusing process sweep: PANDESH_SMOKE_INSTALL prefix is missing or too short: '$prefix'"
}
if (-not (Test-Path -LiteralPath $prefix)) {
  exit 0
}
$owned = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) })
foreach ($entry in $owned) {
  $current = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $entry.ProcessId)
  if ($current -and $current.CreationDate -eq $entry.CreationDate -and $current.ExecutablePath -eq $entry.ExecutablePath) {
    Stop-Process -Id $entry.ProcessId -Force -ErrorAction SilentlyContinue
  }
}
Start-Sleep -Milliseconds 500
$remaining = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) })
if ($remaining.Count) { throw 'Smoke processes remain alive' }
`;
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, PANDESH_SMOKE_INSTALL: install }, encoding: 'utf8', windowsHide: true,
  });
  if (result.status !== 0) throw new Error('Smoke cleanup failed: ' + result.stderr);
}

export function uninstallSmoke(scratch, env) {
  stopSmokeProcesses(scratch);
  const uninstaller = path.join(assertSmokeRoot(scratch), 'install', 'unins000.exe');
  if (fs.existsSync(uninstaller)) {
    const result = spawnSync(uninstaller, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/NOCLOSEAPPLICATIONS'], { env, windowsHide: true });
    if (result.status !== 0) throw new Error('Smoke uninstall failed: ' + result.status);
  }
  fs.rmSync(assertSmokeRoot(scratch), { recursive: true, force: true });
}
