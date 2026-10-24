#Requires -Version 5.1
<#
.SYNOPSIS
Prepare a deliberately filtered, uncommitted Pandesh source snapshot for review.

.DESCRIPTION
Works from a pinned private Git commit with git archive. Does not copy Git
history, GitHub Actions workflows, development evidence, private reports or
binary assets. Does NOT publish, push, modify the private repo, or create a
public commit. Fail-closed if Gitleaks is missing or reports findings.
#>
[CmdletBinding()]
param(
  [string] $SourceRepository = 'C:\Projects\ollama-agent',
  [string] $SourceCommit = '8166f627a3522493eb129ff8d91a1f164770a112',
  [string] $OutputDirectory = (Join-Path $env:TEMP ('pandesh-open-source-review-' + (Get-Date -Format 'yyyyMMdd-HHmmss')))
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-ExitCode([string] $Operation) {
  if ($LASTEXITCODE -ne 0) { throw "$Operation failed with exit code $LASTEXITCODE." }
}

foreach ($command in @('git', 'tar', 'gitleaks')) {
  if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
    throw "$command is required. Install it first; nothing was copied or published."
  }
}
if (-not (Test-Path -LiteralPath $SourceRepository -PathType Container)) {
  throw "Source checkout is missing: $SourceRepository"
}
$sourceResolved = (Resolve-Path -LiteralPath $SourceRepository).Path.TrimEnd([char[]]@('\', '/'))
$outputResolved = [IO.Path]::GetFullPath($OutputDirectory).TrimEnd([char[]]@('\', '/'))
if ($outputResolved.StartsWith($sourceResolved + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'The output must be outside the private source checkout.'
}
if (Test-Path -LiteralPath $outputResolved) {
  throw "Output already exists; refusing to overwrite: $outputResolved"
}

& git -C $sourceResolved cat-file -e ($SourceCommit + '^{commit}')
Assert-ExitCode 'Private source commit validation'

$raw = Join-Path $outputResolved '_temporary-private-export'
$staged = Join-Path $outputResolved 'staged-source'
$reportDir = Join-Path $outputResolved 'audit'
$archive = Join-Path $outputResolved '_temporary-private-source.tar'
New-Item -ItemType Directory -Path $raw, $staged, $reportDir -Force | Out-Null

$approvedRoots = '^(core|src|tests|scripts|media|bench|acceptance|apps/desktop)/'
$approvedRootFiles = @(
  'package.json', 'package-lock.json', '.vscodeignore', '.gitattributes',
  'tsconfig.json', 'tsconfig.core.json',
  'esbuild.js', 'esbuild.core.js', 'esbuild.tools.js',
  'esbuild.webview-v2.js', 'esbuild.bench.js',
  'vitest.config.ts', 'vitest.platform.config.ts',
  'vitest.golden.config.ts', 'vitest.webview-v2.config.ts'
)
$approvedExtensions = @(
  '.ts', '.tsx', '.js', '.jsx', '.cjs', '.mjs', '.json', '.jsonc',
  '.css', '.html', '.md', '.txt', '.xml', '.yaml', '.yml',
  '.ps1', '.cmd', '.sh'
)
$blockedDirectory = '(^|/)(node_modules|dist|build|out|out-core|out-core-tsc|\.git|\.github|\.idea|\.vscode|\.forge|\.tmp|graphify-out|brag-output|cache|coverage|test-results|screenshots|\.acceptance-evidence|\.m47-1-evidence)(/|$)'
$blockedFile = '(^|/)(\.env(?:\..*)?|credentials\.json|secrets\.json|.*\.(?:pem|key|p12|pfx|kdbx|sqlite|db|log|exe|dll|node|zip|7z|rar|png|jpg|jpeg|gif|webp|ico|svg|ttf|woff|woff2|ogg|wav|mp3|mp4|pdf|docx))$'
$included = New-Object System.Collections.Generic.List[string]
$excluded = New-Object System.Collections.Generic.List[string]

try {
  & git -C $sourceResolved archive '--format=tar' ("--output=$archive") $SourceCommit
  Assert-ExitCode 'Read-only git archive'
  & tar -xf $archive -C $raw
  Assert-ExitCode 'Extracting temporary archive'

  $allFiles = Get-ChildItem -LiteralPath $raw -File -Recurse
  foreach ($f in $allFiles) {
    $relative = $f.FullName.Substring($raw.Length) -replace '^[\\/]+', ''
    $relative = $relative -replace '\\', '/'
    $extension = [IO.Path]::GetExtension($relative).ToLowerInvariant()
    $inScope = ($relative -match $approvedRoots) -or ($relative -in $approvedRootFiles)
    $blocked = ($relative -match $blockedDirectory) -or ($relative -match $blockedFile)
    $isApprovedType = ($extension -in $approvedExtensions) -or ($relative -in $approvedRootFiles)
    if (-not $inScope -or $blocked -or -not $isApprovedType) {
      $excluded.Add($relative)
      continue
    }
    $dest = Join-Path $staged ($relative -replace '/', '\')
    $destParent = Split-Path -Parent $dest
    if (-not (Test-Path -LiteralPath $destParent)) {
      New-Item -ItemType Directory -Path $destParent -Force | Out-Null
    }
    Copy-Item -LiteralPath $f.FullName -Destination $dest
    $included.Add($relative)
  }
} finally {
  # Never leave an unfiltered private archive beside the staged source.
  if (Test-Path -LiteralPath $raw) {
    Remove-Item -LiteralPath $raw -Recurse -Force
  }
  if (Test-Path -LiteralPath $archive) {
    Remove-Item -LiteralPath $archive -Force
  }
}

$included | Set-Content -LiteralPath (Join-Path $reportDir 'included-files.txt') -Encoding UTF8
$excluded | Set-Content -LiteralPath (Join-Path $reportDir 'excluded-files.txt') -Encoding UTF8
$head = (& git -C $sourceResolved rev-parse HEAD).Trim()
$summary = @(
  'Pandesh public source staging review',
  "Private source commit: $SourceCommit",
  "Private checkout HEAD (informational): $head",
  "Staged text files: $($included.Count)",
  "Excluded entries requiring review or deliberately omitted: $($excluded.Count)",
  "Staged location: $staged",
  '',
  'Not automatically buildable: runtime images, icons, binaries, fonts, and audio were excluded.',
  'Do not copy excluded evidence or old CI workflows into the public repository.',
  'Review potential personal paths, hardcoded credentials, asset rights, third-party notices, and packaging completeness.',
  'No public Git commit or push has been performed.'
)
$summary | Set-Content -LiteralPath (Join-Path $reportDir 'SUMMARY.txt') -Encoding UTF8

$openCode = Join-Path $staged 'core\runtime\opencodeEngine.ts'
if ((Test-Path -LiteralPath $openCode) -and
    (Select-String -LiteralPath $openCode -Pattern 'OPENCODE_SERVER_PASSWORD\s*:\s*[\x27\x22]' -Quiet)) {
  throw 'BLOCKED: static OpenCode server credential found. Fix it in the PRIVATE repository, then create a new source commit and restage. Nothing was published.'
}

$directoryReport = Join-Path $reportDir 'gitleaks-staged-redacted.json'
& gitleaks dir --source $staged --redact --report-format json --report-path $directoryReport --exit-code 1
Assert-ExitCode 'Gitleaks staged source scan'

# Historical findings are reviewed locally, even though the new source snapshot
# never imports Git history. Do not upload historical audit reports.
$historyReport = Join-Path $reportDir 'gitleaks-private-history-redacted.json'
& gitleaks git --source $sourceResolved --log-opts '--all' --redact --report-format json --report-path $historyReport --exit-code 1
Assert-ExitCode 'Gitleaks private repository history scan'

Write-Host ''
Write-Host 'STAGING PASSED INITIAL AUTOMATED SCANS, NOT CLEARED FOR PUBLICATION.'
Write-Host "Review directory: $outputResolved"
Write-Host "Staged source: $staged"
Write-Host 'Next gates: inspect assets, licenses, privacy, restore required resources, build and test.'
Write-Host 'Only after those gates should you commit and push the reviewed snapshot to Pandesh.'
