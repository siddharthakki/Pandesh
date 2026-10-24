[CmdletBinding()]
param(
    [string]$Repository = 'siddharthakki/ollama-agent',
    [string]$Distro = 'Ubuntu',
    [string]$RunnerName = 'Sid',
    [string]$RunnerDirectory = '/home/siddh/actions-runner',
    [string]$TaskName = 'KarkeDikha GitHub Actions Runner',
    [ValidateRange(5, 1440)]
    [int]$IntervalMinutes = 15,
    [switch]$Remove
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

try {
    if (-not (Get-Command Register-ScheduledTask -ErrorAction SilentlyContinue)) {
        throw 'The Windows ScheduledTasks module is unavailable.'
    }

    if ($Remove) {
        $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        if ($existing) {
            Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
            Write-Host "Removed scheduled task '$TaskName'."
        }
        else {
            Write-Host "Scheduled task '$TaskName' is not installed."
        }
        exit 0
    }

    $keepAliveScript = Join-Path $PSScriptRoot 'keep-runner-alive.ps1'
    $keepAliveScript = (Resolve-Path -LiteralPath $keepAliveScript).Path

    $windowsPowerShell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    if (-not (Test-Path -LiteralPath $windowsPowerShell)) {
        throw "Windows PowerShell was not found: $windowsPowerShell"
    }

    $actionArguments = @(
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-File', ('"{0}"' -f $keepAliveScript),
        '-Repository', ('"{0}"' -f $Repository),
        '-Distro', ('"{0}"' -f $Distro),
        '-RunnerName', ('"{0}"' -f $RunnerName),
        '-RunnerDirectory', ('"{0}"' -f $RunnerDirectory)
    ) -join ' '

    $action = New-ScheduledTaskAction `
        -Execute $windowsPowerShell `
        -Argument $actionArguments `
        -WorkingDirectory (Split-Path -Parent $keepAliveScript)

    $logonTrigger = New-ScheduledTaskTrigger -AtLogOn
    $repeatTrigger = New-ScheduledTaskTrigger `
        -Once `
        -At (Get-Date).AddMinutes(1) `
        -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) `
        -RepetitionDuration (New-TimeSpan -Days 3650)

    $settings = New-ScheduledTaskSettingsSet `
        -StartWhenAvailable `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -MultipleInstances IgnoreNew `
        -ExecutionTimeLimit (New-TimeSpan -Seconds 0)

    $currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    $principal = New-ScheduledTaskPrincipal `
        -UserId $currentUser `
        -LogonType Interactive `
        -RunLevel Limited

    $task = New-ScheduledTask `
        -Action $action `
        -Trigger @($logonTrigger, $repeatTrigger) `
        -Settings $settings `
        -Principal $principal `
        -Description 'Keep WSL attached and keep the repository-scoped KarkeDikha GitHub Actions runner online.'

    Register-ScheduledTask -TaskName $TaskName -InputObject $task -Force | Out-Null
    Start-ScheduledTask -TaskName $TaskName

    Write-Host "Installed and started scheduled task '$TaskName'."
    Write-Host 'It stays active while the user is logged on; the repeat trigger recovers it after an unexpected exit.'
    Write-Host "Health log: $env:LOCALAPPDATA\KarkeDikha\github-actions-runner.log"
}
catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}
