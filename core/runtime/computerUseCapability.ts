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
 * top-level windows. Neither changes anything, but both read everything the
 * person has open, other apps and private conversations included, so both ask
 * first: an approval card for every call, in every mode (micro-tests NAV-013 and
 * NAV-014 found them capturing the screen to answer "which Pandesh view is open").
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { GovernedCapabilityAdapter } from './governedCapability';
import type { ModelToolCall } from './modelBackend';
import type { ToolExecutionResult } from './toolRunner';
import { runPowerShellScript } from './windowsShellExec';
import type { ImageInspector } from './localVisionInspector';

/** Tools that read the person's whole screen or every window title: never run without their OK. */
export const SCREEN_READING_TOOLS: ReadonlySet<string> = new Set(['desktop_screenshot', 'desktop_windows_list']);
const MAX_OUTPUT_CHARS = 24_000;

/**
 * What a screenshot is and is not, said with every capture. Capturing (saving the file), opening (showing it to the
 * user) and inspecting (reading what is on it) are different things. The tool captures; it inspects only when the model
 * passes the user's `question`, and then only with a vision model on THIS PC (localVisionInspector: loopback endpoint
 * only, never a cloud provider; cloud turns do not get this tool at all, see cloudDataBoundary). The result says which
 * happened. The capture has no filter: a model once claimed it was "programmed to exclude private messaging apps",
 * which was never true, and Pandesh has no block on analyzing a screenshot of a messaging app the user asked about.
 */
export const SCREENSHOT_CONTENTS_NOTE = 'Captured means saved: the PNG was written on this PC and has not been opened for anyone. It was read by a model only if this result says a local vision model read it. It records every visible window as it is; nothing is excluded, blurred or filtered. The user can open it at the path above; this tool sends it nowhere.';
/** Said when no reading was asked for, or none happened: the model must not describe the screen. */
export const NOT_INSPECTED_NOTE = 'Not inspected: no model has read this image, so nothing on the screen is known beyond the path, size and hash. Do not describe, check or verify anything on the screen from it, and never say it shows, confirms or proves something.';

export interface ComputerUseCapabilityOptions {
  /** Core's data directory — where screen evidence is written. */
  dataDir?: string;
  runScript?: typeof runPowerShellScript;
  /** Reads a capture with a vision model on this PC. Absent: captures are never inspected. */
  inspectImage?: ImageInspector;
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
    const head = `Captured the Windows desktop: ${target} (${bytes} bytes, ${result.output.trim() || 'unknown size'}, sha256 ${digest}).`;
    const question = typeof (call.arguments as Record<string, unknown> | undefined)?.question === 'string' ? String((call.arguments as Record<string, unknown>).question).trim().slice(0, 500) : '';
    // Capturing and understanding are separate steps with separate receipts. The user asked for the second only when the
    // model passed their question; the reading happens on this PC and its result is reported as it is, failure included.
    let inspected: { model: string; text: string } | null = null;
    let notInspected = 'the user did not ask what is on the screen, so no model read it';
    if (question) {
      if (!options.inspectImage) notInspected = 'this build has no image reader configured';
      else {
        const read = await options.inspectImage({ path: target, question });
        if (read.ok) inspected = { model: read.model, text: read.text };
        else notInspected = read.reason;
      }
    }
    return {
      status: 'succeeded',
      exitCode: 0,
      output: inspected
        ? `${head} Read on this PC by the local vision model ${inspected.model} (nothing was sent off this PC). What it reports is visible on the screen:
${inspected.text}
${SCREENSHOT_CONTENTS_NOTE}`
        : `${head} ${NOT_INSPECTED_NOTE} Reason: ${notInspected}. ${SCREENSHOT_CONTENTS_NOTE}`,
      resultCategory: inspected ? 'computer_desktop_captured_and_inspected' : 'computer_desktop_captured',
      normalizedArguments: { path: target, bytes, sha256: digest, inspected: Boolean(inspected), ...(inspected ? { inspectedBy: inspected.model } : {}) },
    };
  }

  return {
    id: 'computer-use',
    definitions: () => [
      {
        name: 'desktop_screenshot',
        description: 'Capture the real Windows desktop (every visible window, nothing filtered) as a PNG on this PC and return its path, size and SHA-256. Pass `question` (their own ask, e.g. what is on their screen or to analyze it) and a vision model on this PC reads the capture and reports what it sees; without `question` the image is only saved and not read. Nothing is sent off this PC. Changes nothing, but asks the user first every time. Only when the user asks for a screenshot of their screen; never to find out what Pandesh itself shows.',
        parameters: { type: 'object', properties: { question: { type: 'string', description: 'What the user wants to know about the screen. Set it only when they asked what is on the screen or to analyze it; it makes a vision model on this PC read the capture.' } }, required: [] },
      },
      {
        name: 'desktop_windows_list',
        description: 'List the visible top-level Windows windows (title and owning process id). Changes nothing, but asks the user first every time. Only when the user asks which apps or windows are open; never to find out what Pandesh itself shows.',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    ],
    // Both tools read the person's whole screen: consequential, so dispatch asks before every call and no Auto grant covers it.
    classify: () => 'consequential',
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
