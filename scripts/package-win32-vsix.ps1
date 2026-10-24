<#
.SYNOPSIS
  Builds a genuine Windows x64 VSIX for M35 in an isolated Windows staging
  directory, using Windows Node/npm against a clean source snapshot of an
  explicit commit (never a mutable HEAD, never the CI runner's Linux
  node_modules).

.DESCRIPTION
  Invoked from the Linux self-hosted CI runner via PowerShell interop
  (Windows powershell.exe reached through /mnt/c). This script never runs
  git: the runner's checkout lives on the WSL side and is only reachable
  from Windows over a \\wsl.localhost\...\ UNC path, where Windows git
  refuses to operate ("detected dubious ownership"). The caller instead
  resolves and verifies the exact commit and produces `git archive` zip on
  the Linux side (where that checkout's git already trusts it), and passes
  the resulting plain zip file in -SourceZip. Every path this script
  touches for the actual build lives under a fresh %TEMP% staging
  directory; only the final .vsix is copied back to -OutDir, which the
  caller points outside the repository root (the CI job additionally
  asserts the repository-root VSIX inventory is unchanged).

.PARAMETER SourceZip
  Windows-visible path to a `git archive --format=zip` snapshot of the
  exact commit to package (produced and verified by the caller).

.PARAMETER HeadSha
  The exact commit SourceZip was archived from. Recorded in evidence only;
  trust in the commit comes from the caller's git verification, not from
  this script re-deriving it.

.PARAMETER OutDir
  Windows-visible path (outside the repo) to receive the final .vsix.

.PARAMETER RunId
  CI workflow run id, used only to namespace the staging directory.
#>
param(
  [Parameter(Mandatory = $true)][string]$SourceZip,
  [Parameter(Mandatory = $true)][string]$HeadSha,
  [Parameter(Mandatory = $true)][string]$OutDir,
  [Parameter(Mandatory = $true)][string]$RunId
)

$ErrorActionPreference = 'Stop'

function Assert-LastExitCode([string]$Step) {
  if ($LASTEXITCODE -ne 0) {
    throw "Step failed with exit code ${LASTEXITCODE}: $Step"
  }
}

# --- Preflight: Windows node/npm must exist; never fall back to anything else. ---
$nodeCmd = Get-Command node.exe -ErrorAction SilentlyContinue
$npmCmd = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (-not $nodeCmd) { throw 'Windows node.exe was not found on PATH.' }
if (-not $npmCmd) { throw 'Windows npm.cmd was not found on PATH.' }

$platform = & node.exe -p "process.platform"
Assert-LastExitCode 'node.exe -p process.platform'
$arch = & node.exe -p "process.arch"
Assert-LastExitCode 'node.exe -p process.arch'
$nodeVersion = & node.exe --version
Assert-LastExitCode 'node.exe --version'
$npmVersion = & npm.cmd --version
Assert-LastExitCode 'npm.cmd --version'

$platform = $platform.Trim()
$arch = $arch.Trim()

if ($platform -ne 'win32' -or $arch -ne 'x64') {
  throw "Windows staging requires platform=win32 arch=x64, found platform=$platform arch=$arch. Refusing to build."
}

$preflight = [ordered]@{
  nodeExecutable = $nodeCmd.Source
  npmExecutable  = $npmCmd.Source
  platform       = $platform
  arch           = $arch
  nodeVersion    = $nodeVersion.Trim()
  npmVersion     = $npmVersion.Trim()
  headSha        = $HeadSha
}
Write-Output "Windows staging preflight: $($preflight | ConvertTo-Json -Compress)"

if (-not (Test-Path -LiteralPath $SourceZip -PathType Leaf)) {
  throw "Source snapshot not found: $SourceZip"
}

$stageId = "oa-m35-win-stage-$RunId-$([guid]::NewGuid().ToString('N'))"
$stage = Join-Path $env:TEMP $stageId
New-Item -ItemType Directory -Path $stage | Out-Null

try {
  $srcDir = Join-Path $stage 'src'
  Expand-Archive -LiteralPath $SourceZip -DestinationPath $srcDir

  Push-Location $srcDir
  try {
    & npm.cmd ci
    Assert-LastExitCode 'npm.cmd ci'

    & npm.cmd run vscode:prepublish
    Assert-LastExitCode 'npm.cmd run vscode:prepublish'

    $vsixPath = Join-Path $stage 'karkedikha-m35-win32-x64.vsix'
    & npm.cmd exec -- vsce package --target win32-x64 --out $vsixPath
    Assert-LastExitCode 'npm.cmd exec -- vsce package --target win32-x64'

    if (-not (Test-Path $vsixPath)) {
      throw "vsce reported success but $vsixPath does not exist."
    }
  }
  finally {
    Pop-Location
  }

  New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
  $finalVsixPath = Join-Path $OutDir 'karkedikha-m35-win32-x64.vsix'
  Copy-Item $vsixPath $finalVsixPath -Force

  $preflightPath = Join-Path $OutDir 'windows-preflight.json'
  ($preflight | ConvertTo-Json) | Set-Content -Path $preflightPath -Encoding utf8

  Write-Output "Windows win32-x64 VSIX staged at: $finalVsixPath"
}
finally {
  Remove-Item -Recurse -Force $stage -ErrorAction SilentlyContinue
}
