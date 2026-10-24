/**
 * The Windows computer surface, reachable from a Pandesh conversation.
 *
 * The prior Computer-Use assignment (docs/JARVIS_PLATFORM_AUDIT.md, §10) was
 * to wrap Microsoft UFO for Windows UI automation. UFO is not installed on
 * this machine, and the audit explicitly forbids building Windows UI
 * automation from scratch. What is implemented here is the part that can be
 * finished honestly with tools this repository already owns: the same bounded
 * PowerShell runner the system-management capability uses, and Core's own
 * data directory for the evidence it writes.
 *
 * `desktop_screenshot` captures the real screen (the Windows desktop, not a
 * rendering of it) and `desktop_windows_list` reports the real visible
 * top-level windows. Both are read-only.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { GovernedCapabilityAdapter } from './governedCapability';
import type { ModelToolCall } from './modelBackend';
import type { ToolExecutionResult } from './toolRunner';
import { runPowerShellScript } from './windowsShellExec';

const READ_ONLY_TOOLS = new Set(['desktop_screenshot', 'desktop_windows_list']);
const MAX_OUTPUT_CHARS = 24_000;

export interface ComputerUseCapabilityOptions {
  /** Core's data directory — where screen evidence is written. */
  dataDir?: string;
  runScript?: typeof runPowerShellScript;
}

function failure(output: string, category: string): ToolExecutionResult {
  return { status: 'failed', exitCode: null, output, resultCategory: category };
}

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Where a screen capture is written. Never inside a user's repository. */
export function computerUseOutputDir(dataDir: string): string {
  return path.join(path.resolve(dataDir), '.tmp', 'karkedikha-desktop');
}

const WINDOW_ENUMERATION_SCRIPT = `
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class KkdWin {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
}
"@
$rows = New-Object System.Collections.ArrayList
$callback = [KkdWin+EnumWindowsProc]{
  param($handle, $state)
  if ([KkdWin]::IsWindowVisible($handle)) {
    $length = [KkdWin]::GetWindowTextLength($handle)
    if ($length -gt 0) {
      $buffer = New-Object System.Text.StringBuilder ($length + 1)
      [void][KkdWin]::GetWindowText($handle, $buffer, $buffer.Capacity)
      $processId = 0
      [void][KkdWin]::GetWindowThreadProcessId($handle, [ref]$processId)
      [void]$rows.Add([pscustomobject]@{ title = $buffer.ToString(); pid = $processId })
    }
  }
  return $true
}
[void][KkdWin]::EnumWindows($callback, [IntPtr]::Zero)
@($rows) | ConvertTo-Json -Compress
`;

export function createComputerUseCapabilityAdapter(options: ComputerUseCapabilityOptions = {}): GovernedCapabilityAdapter {
  const dataDir = options.dataDir ?? process.cwd();
  const run = options.runScript ?? runPowerShellScript;

  async function listWindows(): Promise<ToolExecutionResult> {
    const result = await run(WINDOW_ENUMERATION_SCRIPT, { maxOutputChars: MAX_OUTPUT_CHARS, timeoutMs: 20_000 });
    if (!result.succeeded) return failure(result.output || 'could not enumerate Windows windows', 'computer_window_list_failed');
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.output.trim() || '[]');
    } catch {
      return failure(`could not parse the window list: ${result.output.slice(0, 500)}`, 'computer_window_list_unparseable');
    }
    const rows = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []) as Array<{ title?: string; pid?: number }>;
    if (rows.length === 0) return { status: 'succeeded', exitCode: 0, output: '(no visible windows)', resultCategory: 'computer_windows_listed' };
    const lines = rows.map((row) => `- pid ${row.pid ?? '?'}: ${row.title ?? '(untitled)'}`);
    return { status: 'succeeded', exitCode: 0, output: lines.join('\n'), resultCategory: 'computer_windows_listed' };
  }

  async function screenshot(call: ModelToolCall): Promise<ToolExecutionResult> {
    const outputDir = computerUseOutputDir(dataDir);
    const name = `desktop-${Date.now()}.png`;
    const target = path.join(outputDir, name);
    try {
      fs.mkdirSync(outputDir, { recursive: true });
    } catch (err) {
      return failure(`could not create the screen-evidence directory: ${err instanceof Error ? err.message : String(err)}`, 'computer_capture_unavailable');
    }
    const script = `
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
try {
  $graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bitmap.Size)
  $bitmap.Save(${psQuote(target)}, [System.Drawing.Imaging.ImageFormat]::Png)
  Write-Output ("$($bounds.Width)x$($bounds.Height)")
} finally {
  $graphics.Dispose()
  $bitmap.Dispose()
}
`;
    const result = await run(script, { maxOutputChars: 4_000, timeoutMs: 30_000 });
    if (!result.succeeded) {
      return failure(result.output || 'the screen capture failed', 'computer_capture_failed');
    }
    if (!fs.existsSync(target)) {
      return failure('the screen capture reported success but no file was written', 'computer_capture_missing');
    }
    const bytes = fs.statSync(target).size;
    const digest = crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');
    return {
      status: 'succeeded',
      exitCode: 0,
      output: `Captured the Windows desktop: ${target} (${bytes} bytes, ${result.output.trim() || 'unknown size'}, sha256 ${digest}).`,
      resultCategory: 'computer_desktop_captured',
      normalizedArguments: { path: target, bytes, sha256: digest },
    };
  }

  return {
    id: 'computer-use',
    definitions: () => [
      {
        name: 'desktop_screenshot',
        description: 'Capture the real Windows desktop as a PNG and return its path, size and SHA-256. Read-only.',
        parameters: { type: 'object', properties: {}, required: [] },
      },
      {
        name: 'desktop_windows_list',
        description: 'List the visible top-level Windows windows (title and owning process id). Read-only.',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    ],
    classify: (toolName) => (READ_ONLY_TOOLS.has(toolName) ? 'read_only' : 'consequential'),
    health: () => ({
      state: process.platform === 'win32' ? 'available' : 'unavailable',
      reason: process.platform === 'win32' ? undefined : 'the Windows computer surface is Windows-only',
      checkedAt: new Date().toISOString(),
    }),
    run: async (call) => {
      switch (call.name) {
        case 'desktop_screenshot': return screenshot(call);
        case 'desktop_windows_list': return listWindows();
        default: return Promise.resolve(failure(`unknown tool '${call.name}'`, 'invalid_arguments'));
      }
    },
  };
}
