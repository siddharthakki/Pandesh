[CmdletBinding()]
param(
    [string]$Repository = 'siddharthakki/ollama-agent',
    [string]$Distro = 'Ubuntu',
    [string]$RunnerName = 'Sid',
    [string]$RunnerDirectory = '/home/siddh/actions-runner',
    [ValidateRange(5, 300)]
    [int]$WaitSeconds = 60,
    [switch]$Quiet
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$logDirectory = Join-Path $env:LOCALAPPDATA 'KarkeDikha'
$logPath = Join-Path $logDirectory 'github-actions-runner.log'
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null

function Write-RunnerLog {
    param(
        [Parameter(Mandatory)]
        [string]$Message,
        [ValidateSet('INFO', 'WARN', 'ERROR')]
        [string]$Level = 'INFO'
    )

    $line = '{0:u} [{1}] {2}' -f (Get-Date), $Level, $Message
    Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8
    if (-not $Quiet) {
        switch ($Level) {
            'WARN' { Write-Warning $Message }
            'ERROR' { Write-Host $Message -ForegroundColor Red }
            default { Write-Host $Message }
        }
    }
}

function Assert-Command {
    param([Parameter(Mandatory)][string]$Name)
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Required command '$Name' was not found."
    }
}

function ConvertTo-BashLiteral {
    param([Parameter(Mandatory)][string]$Value)
    if ($Value -notmatch '^/[A-Za-z0-9._/-]+$') {
        throw "Unsafe Linux path value: $Value"
    }
    return "'$Value'"
}

function Invoke-WslBash {
    param(
        [Parameter(Mandatory)][string]$Command,
        [switch]$AllowFailure
    )

    # Windows PowerShell 5.1 writes CRLF when piping text to native commands.
    # Sending the multiline script directly to `bash -s` therefore turns the
    # first line into `set -euo pipefail\r`. Normalize to LF, base64-encode the
    # bytes, and let WSL decode them before the inner Bash process reads stdin.
    $normalizedCommand = $Command -replace "`r`n?", "`n"
    $encodedCommand = [Convert]::ToBase64String(
        [Text.Encoding]::UTF8.GetBytes($normalizedCommand)
    )
    $output = $encodedCommand | & wsl.exe -d $Distro -- bash -c 'base64 -d | bash -s' 2>&1
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0 -and -not $AllowFailure) {
        $details = ($output | Out-String).Trim()
        throw "WSL command failed with exit code $exitCode. $details"
    }
    return [pscustomobject]@{
        ExitCode = $exitCode
        Output = $output
    }
}

function Get-RepositoryRunners {
    $raw = & gh api "repos/$Repository/actions/runners" 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to query GitHub runners for $Repository. $($raw | Out-String)"
    }
    return ($raw | Out-String | ConvertFrom-Json).runners
}

function Find-RepositoryRunner {
    $runners = @(Get-RepositoryRunners)
    return $runners | Where-Object {
        $labels = @($_.labels | ForEach-Object { $_.name.ToString().ToLowerInvariant() })
        $nameMatches = (-not $RunnerName) -or ($_.name -eq $RunnerName)
        $nameMatches -and
            $labels -contains 'self-hosted' -and
            $labels -contains 'linux' -and
            $labels -contains 'x64'
    } | Select-Object -First 1
}

function Write-RunnerResult {
    param([Parameter(Mandatory)]$Runner)

    $busyText = if ($Runner.busy) { 'busy' } else { 'idle' }
    Write-RunnerLog "GitHub runner '$($Runner.name)' is online and $busyText."

    [pscustomobject]@{
        Repository = $Repository
        Distro = $Distro
        Runner = $Runner.name
        Status = $Runner.status
        Busy = [bool]$Runner.busy
        Log = $logPath
    }
}

try {
    Assert-Command -Name 'wsl.exe'
    Assert-Command -Name 'gh'

    Write-RunnerLog "Ensuring WSL distribution '$Distro' and runner '$RunnerName' are available for $Repository."

    # If GitHub already sees the runner online, do not touch WSL or start another listener.
    $runner = Find-RepositoryRunner
    if ($runner -and $runner.status -eq 'online') {
        Write-RunnerResult -Runner $runner
        exit 0
    }

    & wsl.exe -d $Distro --exec /bin/true | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to start WSL distribution '$Distro'. Run 'wsl -l -v' and verify the distribution name."
    }

    $runnerDirectoryLiteral = ConvertTo-BashLiteral -Value $RunnerDirectory
    $ensureCommand = @'
set -euo pipefail
runner_dir=__RUNNER_DIRECTORY__
clean_path='/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'

if [ ! -x "$runner_dir/run.sh" ]; then
  echo "Runner executable not found at $runner_dir/run.sh" >&2
  exit 21
fi

mkdir -p "$runner_dir/_diag"

# Never start a service or fallback listener while any listener already exists.
if pgrep -f "$runner_dir/bin/Runner.Listener" >/dev/null 2>&1; then
  echo 'process:already-running'
  exit 0
fi

if [ -f "$runner_dir/.service" ] && command -v systemctl >/dev/null 2>&1 && [ "$(ps -p 1 -o comm= | tr -d ' ')" = 'systemd' ]; then
  service_name="$(cat "$runner_dir/.service")"
  if ! systemctl is-active --quiet "$service_name"; then
    sudo -n systemctl start "$service_name" >/dev/null 2>&1 || true
  fi
  if systemctl is-active --quiet "$service_name"; then
    echo "service:$service_name"
    exit 0
  fi
fi

nohup env PATH="$clean_path" "$runner_dir/run.sh" \
  > "$runner_dir/_diag/operator-runner.log" 2>&1 < /dev/null &
sleep 3

if pgrep -f "$runner_dir/bin/Runner.Listener" >/dev/null 2>&1; then
  echo 'process:started'
  exit 0
fi

echo 'Runner process did not start. Inspect _diag/operator-runner.log.' >&2
exit 22
'@
    $ensureCommand = $ensureCommand.Replace('__RUNNER_DIRECTORY__', $runnerDirectoryLiteral)

    $wslResult = Invoke-WslBash -Command $ensureCommand
    $wslSummary = ($wslResult.Output | Out-String).Trim()
    if ($wslSummary) {
        Write-RunnerLog "WSL runner state: $wslSummary"
    }

    $deadline = (Get-Date).AddSeconds($WaitSeconds)
    $runner = $null

    do {
        $runner = Find-RepositoryRunner
        if ($runner -and $runner.status -eq 'online') {
            break
        }

        Start-Sleep -Seconds 3
    } while ((Get-Date) -lt $deadline)

    if (-not $runner) {
        throw "No runner named '$RunnerName' with self-hosted/Linux/X64 labels is registered for $Repository."
    }

    if ($runner.status -ne 'online') {
        throw "Runner '$($runner.name)' is registered but GitHub still reports status '$($runner.status)'. Check $RunnerDirectory/_diag/operator-runner.log inside WSL."
    }

    Write-RunnerResult -Runner $runner
}
catch {
    Write-RunnerLog -Message $_.Exception.Message -Level 'ERROR'
    exit 1
}
