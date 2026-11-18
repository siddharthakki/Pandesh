/** The read-only Outlook COM worker (PowerShell, STA). Written to Core's data folder and run there; this module is its single source. */
export const OUTLOOK_WORKER_SCRIPT = String.raw`# Pandesh Outlook worker: READ-ONLY access to Classic Outlook through COM, in its own STA process.
# Protocol: one JSON request per stdin line -> one JSON reply per stdout line.
#   {"id":"1","cmd":"ping"|"accounts"|"folders"|"list"|"get", ...}
# It never writes: no Send, Move, Delete, Save, Display, UnRead assignment, attachment download or flag change.
# Run as: powershell -NoProfile -STA -ExecutionPolicy Bypass -File outlookWorker.ps1
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$inv = [System.Globalization.CultureInfo]::InvariantCulture
$script:ol = $null
$script:ns = $null

function Release($o) { if ($null -ne $o) { try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($o) } catch {} } }

function Connect {
  if ($null -ne $script:ns) { try { [void]$script:ns.Stores.Count; return } catch { $script:ns = $null; $script:ol = $null } }
  $script:ol = New-Object -ComObject Outlook.Application
  $script:ns = $script:ol.GetNamespace('MAPI')
}

function Clip([string]$s, [int]$n) { if ($null -eq $s) { return '' }; if ($s.Length -gt $n) { return $s.Substring(0, $n) }; return $s }

function FindStore([string]$storeId) {
  foreach ($attempt in 1, 2) {
    foreach ($s in $script:ns.Stores) { if ($s.StoreID -eq $storeId) { return $s } else { Release $s } }
    # Not listed: the connection may belong to an Outlook that has since been restarted. Attach again once before giving up.
    if ($attempt -eq 1) { $script:ns = $null; $script:ol = $null; Connect }
  }
  throw "store not found"
}

function FolderByPath($store, [string]$path) {
  if ($path -eq '@inbox') { return $store.GetDefaultFolder(6) }
  $f = $store.GetRootFolder()
  foreach ($part in ($path.Trim('/') -split '/')) { if ($part) { $n = $f.Folders.Item($part); $f = $n } }
  return $f
}

function WalkFolders($folder, [string]$prefix, [int]$depth, $out) {
  foreach ($c in $folder.Folders) {
    $p = if ($prefix) { "$prefix/$($c.Name)" } else { $c.Name }
    $out.Add([ordered]@{ path = $p; name = $c.Name; items = [int]$c.Items.Count; unread = [int]$c.UnReadItemCount }) | Out-Null
    if ($depth -gt 1) { WalkFolders $c $p ($depth - 1) $out }
    Release $c
  }
}

function PropString($item, [string]$tag) { try { return [string]$item.PropertyAccessor.GetProperty($tag) } catch { return '' } }

function SmtpOf($item) {
  $a = ''
  try { $a = [string]$item.SenderEmailAddress } catch {}
  if ($a -and $a -notmatch '@') { try { $u = $item.Sender.GetExchangeUser(); if ($u) { $a = [string]$u.PrimarySmtpAddress } } catch {} }
  return $a
}

function MessageRow($item, [int]$bodyChars) {
  $row = [ordered]@{
    entryId = [string]$item.EntryID
    conversationId = [string]$item.ConversationID
    internetMessageId = (PropString $item 'http://schemas.microsoft.com/mapi/proptag/0x1035001F')
    subject = (Clip ([string]$item.Subject) 300)
    fromName = (Clip ([string]$item.SenderName) 200)
    fromAddress = (Clip (SmtpOf $item) 200)
    to = (Clip ([string]$item.To) 300)
    received = ([datetime]$item.ReceivedTime).ToUniversalTime().ToString('o')
    unread = [bool]$item.UnRead
    attachments = [int]$item.Attachments.Count
  }
  if ($bodyChars -gt 0) {
    $full = [string]$item.Body
    $row['body'] = (Clip $full $bodyChars)
    # Footers sit past the size cap, so bulk mail is recognised on the whole text here (a yes/no, no text leaves this process).
    $row['bulkHint'] = [bool]($full -match '(?i)unsubscribe|abmelden|abbestellen|view (this email )?in (your )?browser|manage (your )?(email )?preferences|you are receiving this|you received this (email|message) because')
  }
  return $row
}

function Handle($req) {
  switch ($req.cmd) {
    'ping' { Connect; return [ordered]@{ version = [string]$script:ol.Version; stores = [int]$script:ns.Stores.Count } }
    'accounts' {
      Connect
      $out = New-Object System.Collections.ArrayList
      foreach ($s in $script:ns.Stores) {
        $inbox = $null
        try { $inbox = $s.GetDefaultFolder(6); [void]$out.Add([ordered]@{ storeId = [string]$s.StoreID; name = [string]$s.DisplayName; inboxItems = [int]$inbox.Items.Count; inboxUnread = [int]$inbox.UnReadItemCount }) }
        catch { [void]$out.Add([ordered]@{ storeId = [string]$s.StoreID; name = [string]$s.DisplayName; inboxItems = $null; inboxUnread = $null }) }
        Release $inbox; Release $s
      }
      return [ordered]@{ accounts = $out }
    }
    'folders' {
      Connect
      $store = FindStore ([string]$req.storeId)
      $out = New-Object System.Collections.ArrayList
      $depth = if ($req.depth) { [int]$req.depth } else { 2 }
      WalkFolders ($store.GetRootFolder()) '' $depth $out
      return [ordered]@{ folders = $out }
    }
    'list' {
      Connect
      $store = FindStore ([string]$req.storeId)
      $folder = FolderByPath $store ([string]$(if ($req.folder) { $req.folder } else { '@inbox' }))
      $limit = [Math]::Min([Math]::Max([int]$req.limit, 1), 500)
      $bodyChars = [Math]::Min([Math]::Max([int]$req.bodyChars, 0), 20000)
      $items = $folder.Items
      if ($req.sinceIso) {
        $since = ([datetime]::Parse([string]$req.sinceIso, $inv, [System.Globalization.DateTimeStyles]::RoundtripKind)).ToLocalTime().ToString('MM/dd/yyyy HH:mm', $inv)
        $items = $items.Restrict("[ReceivedTime] >= '$since'")
      }
      if ($req.beforeIso) {
        # Inclusive to the end of that minute (Outlook compares at minute resolution), so the boundary message is re-read, never skipped.
        $before = ([datetime]::Parse([string]$req.beforeIso, $inv, [System.Globalization.DateTimeStyles]::RoundtripKind)).ToLocalTime().AddMinutes(1).ToString('MM/dd/yyyy HH:mm', $inv)
        $items = $items.Restrict("[ReceivedTime] < '$before'")
      }
      $items.Sort('[ReceivedTime]', $true)
      $skip = [Math]::Max([int]$req.offset, 0)
      $rows = New-Object System.Collections.ArrayList
      $i = 0; $seen = 0
      $it = $items.GetFirst()
      while ($null -ne $it -and $rows.Count -lt $limit) {
        $seen++
        if ($seen -gt $skip) {
          if ($it.Class -eq 43) { [void]$rows.Add((MessageRow $it $bodyChars)) }
        }
        $next = $items.GetNext()
        Release $it
        $it = $next
      }
      Release $it
      return [ordered]@{ messages = $rows; folderItems = [int]$folder.Items.Count; hasMore = ($seen -ge ($skip + $limit)) }
    }
    'get' {
      Connect
      $item = $script:ns.GetItemFromID([string]$req.entryId, [string]$req.storeId)
      $row = MessageRow $item 0
      $max = [Math]::Min([Math]::Max([int]$req.bodyChars, 1000), 200000)
      $row['body'] = (Clip ([string]$item.Body) $max)
      $atts = New-Object System.Collections.ArrayList
      foreach ($a in $item.Attachments) { [void]$atts.Add([ordered]@{ name = (Clip ([string]$a.FileName) 200); size = [int]$a.Size }); Release $a }
      $row['attachmentList'] = $atts
      Release $item
      return $row
    }
    default { throw "unknown command" }
  }
}

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  if (-not $line.Trim()) { continue }
  $id = ''
  try {
    $req = $line | ConvertFrom-Json
    $id = [string]$req.id
    $data = Handle $req
    $reply = [ordered]@{ id = $id; ok = $true; data = $data }
  } catch {
    $msg = ($_.Exception.Message -split [char]10)[0]
    # A failure here may mean Outlook was closed or restarted: forget the old connection so the next request attaches to the live one.
    $script:ns = $null
    $script:ol = $null
    $reply = [ordered]@{ id = $id; ok = $false; error = (Clip $msg 300) }
  }
  [Console]::Out.WriteLine(($reply | ConvertTo-Json -Depth 8 -Compress))
  [Console]::Out.Flush()
}
`;
