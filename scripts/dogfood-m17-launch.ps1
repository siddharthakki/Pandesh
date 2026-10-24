# Builds the KarkeDikha VSIX, installs it into a deterministic, isolated
# extensions/user-data directory pair, verifies the on-disk bundle hash-
# matches the source tree for the files that matter to the M17 autonomous
# approval-cycle UI, and launches that exact isolated VS Code window.
#
# This replaces the manual "package, reinstall, hash by hand, reopen VS
# Code" loop with one command: npm run dogfood:m17:launch
#
# The automated DOM-level regression (npm run test:dogfood:approval-cycle)
# is the actual acceptance gate for the approval-card reconciliation logic;
# this script exists only to make a real, current, hash-verified manual
# spot-check reproducible without any guesswork about which build is
# actually running.

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

$userDataDir = Join-Path $env:TEMP 'karkedikha-dogfood-user'
$extensionsDir = Join-Path $env:TEMP 'karkedikha-dogfood-extensions-final'

Write-Host "== KarkeDikha M17 dogfood launch ==" -ForegroundColor Cyan
Write-Host "Repo root:       $repoRoot"
Write-Host "User data dir:   $userDataDir"
Write-Host "Extensions dir:  $extensionsDir"

Write-Host "`n[1/4] Packaging VSIX (npm run package:win32-x64)..." -ForegroundColor Cyan
npm run package:win32-x64
if ($LASTEXITCODE -ne 0) { throw "VSIX packaging failed (exit $LASTEXITCODE)." }

$vsix = Get-ChildItem -Path $repoRoot -Filter 'karkedikha-win32-x64.vsix' | Select-Object -First 1
if (-not $vsix) { throw "Packaged VSIX not found in $repoRoot." }
Write-Host "Packaged: $($vsix.FullName)"

New-Item -ItemType Directory -Force -Path $userDataDir | Out-Null
New-Item -ItemType Directory -Force -Path $extensionsDir | Out-Null

Write-Host "`n[2/4] Installing into isolated extensions dir..." -ForegroundColor Cyan
$codeCmd = Get-Command code -ErrorAction SilentlyContinue
if (-not $codeCmd) { throw "'code' CLI not found on PATH. Install the VS Code command-line tools first." }
& code --user-data-dir $userDataDir --extensions-dir $extensionsDir --install-extension $vsix.FullName --force
if ($LASTEXITCODE -ne 0) { throw "Extension install failed (exit $LASTEXITCODE)." }

Write-Host "`n[3/4] Verifying installed bundle hashes against source..." -ForegroundColor Cyan
$installedExtDir = Get-ChildItem `
    -Path $extensionsDir `
    -Directory `
    -Filter 'ollama-agent.ollama-agent-*' `
    -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

if (-not $installedExtDir) {
    throw "Could not locate installed extension ollama-agent.ollama-agent-* under $extensionsDir."
}

$filesToVerify = @(
    'out/extension.js',
    'media/chat-sidebar-ui.js',
    'media/chat-autonomous.js',
    'media/chat.html'
)

$allMatch = $true
foreach ($rel in $filesToVerify) {
    $sourcePath = Join-Path $repoRoot $rel
    $installedPath = Join-Path $installedExtDir.FullName $rel
    if (-not (Test-Path $installedPath)) {
        Write-Host "  MISSING   $rel (not found in installed bundle)" -ForegroundColor Red
        $allMatch = $false
        continue
    }
    $sourceHash = (Get-FileHash -Path $sourcePath -Algorithm SHA256).Hash
    $installedHash = (Get-FileHash -Path $installedPath -Algorithm SHA256).Hash
    $match = $sourceHash -eq $installedHash
    if (-not $match) { $allMatch = $false }
    $status = if ($match) { 'MATCH' } else { 'MISMATCH' }
    $color = if ($match) { 'Green' } else { 'Red' }
    Write-Host "  $status`t$rel" -ForegroundColor $color
}

if (-not $allMatch) {
    throw "Hash verification failed - the installed bundle does not match the current source tree. Aborting launch."
}

Write-Host "`n[4/4] Launching isolated VS Code window..." -ForegroundColor Cyan
Write-Host "  --user-data-dir   $userDataDir"
Write-Host "  --extensions-dir  $extensionsDir"
Start-Process code -ArgumentList @(
    '--user-data-dir', "`"$userDataDir`"",
    '--extensions-dir', "`"$extensionsDir`""
)

Write-Host "`nDone. This window is running the exact, hash-verified current build." -ForegroundColor Green
