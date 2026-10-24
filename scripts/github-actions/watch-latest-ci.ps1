[CmdletBinding()]
param(
    [string]$Repository = 'siddharthakki/ollama-agent',
    [string]$Distro = 'Ubuntu',
    [string]$RunnerName = 'Sid',
    [string]$RunnerDirectory = '/home/siddh/actions-runner',
    [string]$Branch,
    [long]$RunId
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-Command {
    param([Parameter(Mandatory)][string]$Name)
    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Required command '$Name' was not found."
    }
}

try {
    Assert-Command -Name 'gh'

    $ensureScript = Join-Path $PSScriptRoot 'ensure-runner.ps1'
    if (-not (Test-Path -LiteralPath $ensureScript)) {
        throw "Runner health script was not found: $ensureScript"
    }

    & $ensureScript `
        -Repository $Repository `
        -Distro $Distro `
        -RunnerName $RunnerName `
        -RunnerDirectory $RunnerDirectory | Out-Host

    if (-not $RunId) {
        if (-not $Branch -and (Get-Command git -ErrorAction SilentlyContinue)) {
            $candidate = (& git branch --show-current 2>$null | Out-String).Trim()
            if ($LASTEXITCODE -eq 0 -and $candidate) {
                $Branch = $candidate
            }
        }

        $listArguments = @(
            'run', 'list',
            '--repo', $Repository,
            '--limit', '1',
            '--json', 'databaseId,status,conclusion,name,workflowName,headBranch,event,createdAt'
        )
        if ($Branch) {
            $listArguments += @('--branch', $Branch)
        }

        $raw = & gh @listArguments 2>&1
        if ($LASTEXITCODE -ne 0) {
            throw "Unable to list GitHub Actions runs. $($raw | Out-String)"
        }

        $runs = @($raw | Out-String | ConvertFrom-Json)
        if ($runs.Count -eq 0) {
            $scope = if ($Branch) { " for branch '$Branch'" } else { '' }
            throw "No GitHub Actions runs were found$scope."
        }

        $run = $runs[0]
        $RunId = [long]$run.databaseId
        $conclusion = if ($run.conclusion) { $run.conclusion } else { 'pending' }
        Write-Host ("Latest run: {0} | branch={1} | status={2} | conclusion={3}" -f `
            $RunId, $run.headBranch, $run.status, $conclusion)

        if ($run.status -eq 'completed') {
            if ($run.conclusion -eq 'success') {
                Write-Host "Run $RunId already completed successfully."
                exit 0
            }

            Write-Host "Run $RunId already completed with conclusion '$($run.conclusion)'." -ForegroundColor Red
            exit 1
        }
    }

    Write-Host "Watching GitHub Actions run $RunId for $Repository."
    & gh run watch $RunId --repo $Repository --exit-status
    exit $LASTEXITCODE
}
catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}