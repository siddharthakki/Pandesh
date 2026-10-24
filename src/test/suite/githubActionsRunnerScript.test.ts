import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const scriptsRoot = path.join(__dirname, '..', '..', '..', 'scripts', 'github-actions');
const ensureScriptPath = path.join(scriptsRoot, 'ensure-runner.ps1');
const keepAliveScriptPath = path.join(scriptsRoot, 'keep-runner-alive.ps1');
const installScriptPath = path.join(scriptsRoot, 'install-runner-autostart.ps1');

describe('GitHub Actions runner recovery scripts', () => {
  it('normalizes PowerShell CRLF before executing multiline Bash in WSL', () => {
    const source = fs.readFileSync(ensureScriptPath, 'utf8');

    expect(source).toContain('$normalizedCommand = $Command -replace "`r`n?", "`n"');
    expect(source).toContain('[Convert]::ToBase64String(');
    expect(source).toContain("bash -c 'base64 -d | bash -s'");
    expect(source).not.toContain('$Command | & wsl.exe -d $Distro -- bash -s');
    expect(source).toContain('set -euo pipefail');
  });

  it('keeps a Windows-side WSL process attached instead of only waking WSL periodically', () => {
    const keepAliveSource = fs.readFileSync(keepAliveScriptPath, 'utf8');
    const installSource = fs.readFileSync(installScriptPath, 'utf8');

    expect(installSource).toContain("Join-Path $PSScriptRoot 'keep-runner-alive.ps1'");
    expect(installSource).toContain('-ExecutionTimeLimit (New-TimeSpan -Seconds 0)');
    expect(installSource).toContain('-MultipleInstances IgnoreNew');
    expect(installSource).not.toContain("Join-Path $PSScriptRoot 'ensure-runner.ps1'");

    expect(keepAliveSource).toContain('while ($true)');
    expect(keepAliveSource).toContain("bash -c 'base64 -d | bash -s'");
    expect(keepAliveSource).toContain('systemctl start');
    expect(keepAliveSource).toContain('Runner.Listener');
    expect(keepAliveSource).toContain('sleep "$interval"');
  });
});
