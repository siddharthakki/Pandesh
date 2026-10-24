param(
    [switch]$SkipFullSuite
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Invoke-Checked {
    param(
        [Parameter(Mandatory = $true)][string]$Label,
        [Parameter(Mandatory = $true)][scriptblock]$Command
    )
    Write-Host ""
    Write-Host "=== $Label ===" -ForegroundColor Cyan
    & $Command
    if ($LASTEXITCODE -ne 0) {
        throw "$Label failed with exit code $LASTEXITCODE."
    }
}

$expected = "fix/m15-worktree-identity"
$branch = (git branch --show-current).Trim()
if ($branch -ne $expected) {
    throw "Run this script from branch '$expected'. Current branch: '$branch'."
}

Invoke-Checked "Diff integrity" {
    git diff --check
}

Invoke-Checked "TypeScript compilation" {
    npx tsc --noEmit --pretty false
}

Invoke-Checked "Focused worktree identity and autonomous runtime tests" {
    npx vitest run src/test/suite/m15WorktreeIdentity.test.ts src/test/suite/m15AutonomousRuntime.test.ts src/test/suite/worktreeAgents.test.ts --reporter=dot
}

if (-not $SkipFullSuite) {
    Invoke-Checked "Complete verification suite" {
        npm run verify
    }
}

Write-Host ""
Write-Host "=== Git status ===" -ForegroundColor Cyan
git status --short

Write-Host ""
Write-Host "M15 WORKTREE IDENTITY FIX PASSED" -ForegroundColor Green
