<#
  Stops the Kandev process tree started by start-kandev.ps1 (launcher, backend, agentctl and agent workers), the
  worker profile's own OpenCode background service, and any worker process that outlived its parent.
  Interrupted agent sessions are not lost: Kandev keeps them in its SQLite store. Stories stopped with Panda's
  "Stop all" stay parked; other interrupted stories are relaunched (ACP session/load) by KarkeDikha's next reconcile
  pass after Kandev starts again.
#>
param(
  [string]$KandevHome = $(if ($env:KARKEDIKHA_KANDEV_HOME) { $env:KARKEDIKHA_KANDEV_HOME } else { Join-Path $env:USERPROFILE '.kkd-kandev' }),
  [int]$OpenCodeWorkerPort = 38621
)
$pidFile = Join-Path $KandevHome 'kandev.pid'
$workerHome = Join-Path $KandevHome 'worker-home'
$all = Get-CimInstance Win32_Process
$tree = New-Object System.Collections.Generic.List[int]
if (Test-Path $pidFile) {
  $tree.Add([int](Get-Content $pidFile))
  do {
    $added = $false
    foreach ($p in $all) {
      if ($tree.Contains([int]$p.ParentProcessId) -and -not $tree.Contains([int]$p.ProcessId)) { $tree.Add([int]$p.ProcessId); $added = $true }
    }
  } while ($added)
}
# The worker OpenCode service detaches from its parent; it is the only listener on the worker port.
foreach ($c in @(Get-NetTCPConnection -State Listen -LocalPort $OpenCodeWorkerPort -ErrorAction SilentlyContinue)) {
  if (-not $tree.Contains([int]$c.OwningProcess)) { $tree.Add([int]$c.OwningProcess) }
}
# Orphans: anything still running from the worker profile or Kandev's package dir.
foreach ($p in $all) {
  $cl = [string]$p.CommandLine
  if (($cl -like "*$workerHome*" -or $cl -like "*$KandevHome\pkg*") -and -not $tree.Contains([int]$p.ProcessId)) { $tree.Add([int]$p.ProcessId) }
}
if (-not $tree.Count) { Write-Output 'Kandev is not running.'; exit 0 }
foreach ($id in $tree) { try { Stop-Process -Id $id -Force -ErrorAction Stop } catch {} }
Remove-Item $pidFile, (Join-Path $KandevHome 'endpoint.json') -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 800
$left = @(Get-Process -Id $tree -ErrorAction SilentlyContinue)
if ($left.Count) { Write-Output "Stopped Kandev, but $($left.Count) process(es) are still alive: $(($left | ForEach-Object { "$($_.ProcessName)#$($_.Id)" }) -join ', ')"; exit 1 }
Write-Output "Stopped Kandev ($($tree.Count) processes); nothing left running."
