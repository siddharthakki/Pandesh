[CmdletBinding()]
param(
    [string]$Repository = 'siddharthakki/ollama-agent',
    [string]$Distro = 'Ubuntu',
    [string]$RunnerName = 'Sid',
    [string]$RunnerDirectory = '/home/siddh/actions-runner',
    [ValidateRange(10, 300)]
    [int]$MonitorIntervalSeconds = 30
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function ConvertTo-BashLiteral {
    param([Parameter(Mandatory)][string]$Value)
    if ($Value -notmatch '^/[A-Za-z0-9._/-]+$') {
        throw "Unsafe Linux path value: $Value"
    }
    return "'$Value'"
}

$ensureScript = Join-Path $PSScriptRoot 'ensure-runner.ps1'
$ensureScript = (Resolve-Path -LiteralPath $ensureScript).Path
$windowsPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
if (-not (Test-Path -LiteralPath $windowsPowerShell)) {
    throw "Windows PowerShell was not found: $windowsPowerShell"
}
if (-not (Get-Command wsl.exe -ErrorAction SilentlyContinue)) {
    throw "Required command 'wsl.exe' was not found."
}

$runnerDirectoryLiteral = ConvertTo-BashLiteral -Value $RunnerDirectory
$monitorCommand = @'
set -euo pipefail
runner_dir=__RUNNER_DIRECTORY__
interval=__MONITOR_INTERVAL__
clean_path='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'

while true; do
  if ! pgrep -f "$runner_dir/bin/Runner.Listener" >/dev/null 2>&1; then
    if [ -f "$runner_dir/.service" ] && command -v systemctl >/dev/null 2>&1; then
      service_name="$(cat "$runner_dir/.service")"
      sudo -n systemctl start "$service_name" >/dev/null 2>&1 || true
      sleep 3
    fi

    if ! pgrep -f "$runner_dir/bin/Runner.Listener" >/dev/null 2>&1; then
      mkdir -p "$runner_dir/_diag"
      nohup env PATH="$clean_path" "$runner_dir/run.sh" \
        > "$runner_dir/_diag/operator-runner.log" 2>&1 < /dev/null &
    fi
  fi

  sleep "$interval"
done
'@
$monitorCommand = $monitorCommand.Replace('__RUNNER_DIRECTORY__', $runnerDirectoryLiteral)
$monitorCommand = $monitorCommand.Replace('__MONITOR_INTERVAL__', $MonitorIntervalSeconds.ToString())
$normalizedMonitorCommand = $monitorCommand -replace "`r`n?", "`n"
$encodedMonitorCommand = [Convert]::ToBase64String(
    [Text.Encoding]::UTF8.GetBytes($normalizedMonitorCommand)
)

while ($true) {
    & $windowsPowerShell `
        -NoProfile `
        -NonInteractive `
        -ExecutionPolicy Bypass `
        -File $ensureScript `
        -Repository $Repository `
        -Distro $Distro `
        -RunnerName $RunnerName `
        -RunnerDirectory $RunnerDirectory `
        -Quiet

    if ($LASTEXITCODE -ne 0) {
        Start-Sleep -Seconds 15
        continue
    }

    # Keep one Windows-side wsl.exe process attached for the lifetime of the
    # scheduled task. Without this host process WSL may stop the distribution,
    # taking the systemd runner service down even though it is enabled.
    $encodedMonitorCommand | & wsl.exe -d $Distro -- bash -c 'base64 -d | bash -s'
    Start-Sleep -Seconds 5
}
