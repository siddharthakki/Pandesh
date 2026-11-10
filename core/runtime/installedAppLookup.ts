/**
 * "Where is <app>?" answered from what Windows already knows, read-only and offline: the registry's App Paths and
 * installed programs, Store (MSIX) packages, Start menu shortcuts and PATH. When none of those lists the app (a
 * portable app unpacked somewhere), the answer names the fixed drives so the assistant can propose ONE consented
 * search for `<name>.exe` instead of asking the user where to look: `search_files` only searches roots the user
 * authorized, so that consent is the user's single decision.
 */
import { runPowerShellScript } from './windowsShellExec';

export interface InstalledAppMatch {
  source: 'app_paths' | 'installed_programs' | 'store_app' | 'start_menu' | 'path';
  name: string;
  path: string | null;
  version?: string | null;
  publisher?: string | null;
}

export interface InstalledAppLookup {
  query: string;
  matches: InstalledAppMatch[];
  fixedDrives: string[];
}

const SOURCE_LABELS: Record<InstalledAppMatch['source'], string> = {
  app_paths: 'registered app path',
  installed_programs: 'installed programs',
  store_app: 'Microsoft Store app',
  start_menu: 'Start menu shortcut',
  path: 'on PATH',
};

/** A plain app name, never a pattern or a path: it is placed in a PowerShell string and compared as text. */
export function validAppQuery(name: unknown): string | null {
  const q = typeof name === 'string' ? name.trim().replace(/\.exe$/i, '') : '';
  return q.length >= 2 && q.length <= 60 && /^[A-Za-z0-9][A-Za-z0-9 ._+-]*$/.test(q) ? q : null;
}

/** The executable name to search the drives for: "LM Studio" -> "LM Studio.exe" stays a name, not a pattern. */
export function exeNameFor(query: string): string {
  return `${query}.exe`;
}

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function installedAppScript(query: string): string {
  return `
$ErrorActionPreference = 'SilentlyContinue'
$q = ${psQuote(query)}
$out = New-Object System.Collections.ArrayList
function Has([string]$s) { return ($s -and $s.IndexOf($q, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) }
foreach ($root in @('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths', 'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths', 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths')) {
  foreach ($k in @(Get-ChildItem -LiteralPath $root)) {
    if (Has $k.PSChildName) { [void]$out.Add([pscustomobject]@{ source = 'app_paths'; name = $k.PSChildName; path = (Get-ItemProperty -LiteralPath $k.PSPath).'(default)' }) }
  }
}
foreach ($root in @('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall', 'HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall', 'HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall')) {
  foreach ($k in @(Get-ChildItem -LiteralPath $root)) {
    $e = Get-ItemProperty -LiteralPath $k.PSPath
    if (Has $e.DisplayName) {
      $icon = $null; if ($e.DisplayIcon) { $icon = ($e.DisplayIcon -replace ',\\s*-?\\d+$', '').Trim('"') }
      $p = $null; if ($e.InstallLocation) { $p = $e.InstallLocation } elseif ($icon -and $icon.ToLower().EndsWith('.exe')) { $p = $icon }
      [void]$out.Add([pscustomobject]@{ source = 'installed_programs'; name = $e.DisplayName; path = $p; version = $e.DisplayVersion; publisher = $e.Publisher })
    }
  }
}
foreach ($pkg in @(Get-AppxPackage)) {
  if ((Has $pkg.Name) -and -not $pkg.IsFramework) { [void]$out.Add([pscustomobject]@{ source = 'store_app'; name = $pkg.Name; path = $pkg.InstallLocation; version = [string]$pkg.Version; publisher = $pkg.PublisherId }) }
}
$shell = New-Object -ComObject WScript.Shell
foreach ($dir in @("$env:ProgramData\\Microsoft\\Windows\\Start Menu\\Programs", "$env:APPDATA\\Microsoft\\Windows\\Start Menu\\Programs")) {
  foreach ($lnk in @(Get-ChildItem -LiteralPath $dir -Recurse -Filter *.lnk | Where-Object { Has $_.BaseName } | Select-Object -First 20)) {
    [void]$out.Add([pscustomobject]@{ source = 'start_menu'; name = $lnk.BaseName; path = $shell.CreateShortcut($lnk.FullName).TargetPath })
  }
}
foreach ($c in @(Get-Command -CommandType Application -Name ($q + '.exe'))) { [void]$out.Add([pscustomobject]@{ source = 'path'; name = $c.Name; path = $c.Source }) }
$drives = @([System.IO.DriveInfo]::GetDrives() | Where-Object { $_.DriveType -eq 'Fixed' -and $_.IsReady } | ForEach-Object { $_.Name })
@{ matches = @($out | Select-Object -First 40); fixedDrives = $drives } | ConvertTo-Json -Depth 4 -Compress
`;
}

export async function findInstalledApp(query: string, options: { runScript?: typeof runPowerShellScript } = {}): Promise<InstalledAppLookup> {
  const run = options.runScript ?? runPowerShellScript;
  const result = await run(installedAppScript(query), { timeoutMs: 45_000, maxOutputChars: 60_000 });
  if (!result.succeeded) throw new Error(result.output || 'Windows did not answer the installed-app lookup');
  const parsed = JSON.parse(result.output.trim() || '{}') as { matches?: unknown; fixedDrives?: unknown };
  const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : v ? [v] : []);
  const seen = new Set<string>();
  const matches: InstalledAppMatch[] = [];
  for (const raw of list(parsed.matches) as Array<Record<string, unknown>>) {
    const source = String(raw.source ?? '') as InstalledAppMatch['source'];
    if (!SOURCE_LABELS[source]) continue;
    const path = typeof raw.path === 'string' && raw.path.trim() ? raw.path.trim() : null;
    const key = `${source}|${String(raw.name ?? '').toLowerCase()}|${(path ?? '').toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    matches.push({
      source, name: String(raw.name ?? ''), path,
      ...(typeof raw.version === 'string' && raw.version ? { version: raw.version } : {}),
      ...(typeof raw.publisher === 'string' && raw.publisher ? { publisher: raw.publisher } : {}),
    });
  }
  const fixedDrives = list(parsed.fixedDrives).map(String).filter((d) => /^[A-Za-z]:\\?$/.test(d)).map((d) => (d.endsWith('\\') ? d : `${d}\\`));
  return { query, matches, fixedDrives };
}

/** What the model reads: where the app is, or the one next step when Windows does not list it. */
export function formatInstalledAppLookup(r: InstalledAppLookup): string {
  if (r.matches.length > 0) {
    const lines = r.matches.slice(0, 15).map((m) => `- ${m.name}${m.version && !m.name.includes(m.version) ? ` ${m.version}` : ''}: ${m.path ?? '(Windows lists it without a folder)'} [${SOURCE_LABELS[m.source]}]`);
    return `"${r.query}" on this PC, as Windows lists it (read-only, nothing was opened or changed):\n${lines.join('\n')}`;
  }
  const exe = exeNameFor(r.query);
  const drives = r.fixedDrives.length ? r.fixedDrives : ['C:\\'];
  return `"${r.query}" is not listed among the installed apps on this PC (registered app paths, installed programs, Store apps, Start menu shortcuts and PATH were checked). `
    + `It may be a portable app. Next step: propose ONE search of the fixed drives (${drives.join(', ')}) for "${exe}" — call request_search_permission with proposedRoots ${JSON.stringify(drives)} and purpose "find ${exe}", then, if granted, search_files with query "${exe}". Do not ask the user where to look.`;
}
