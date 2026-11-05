/**
 * Narrow, governed Windows printing: enumerate installed printers and submit the Windows test page.
 *
 * (Process spawning lives in the host-reviewed runner passed in; this module imports no child_process.)
 *
 * No shell command from the model is involved. Fixed PowerShell scripts run with the printer name passed through an
 * environment variable (never interpolated), so a printer name cannot inject a command. No file is generated: the
 * test page is Windows' own (Win32_Printer.PrintTestPage).
 *
 * Outcomes are kept honest. Windows can prove the spooler accepted a job and later that the job left the queue
 * without an error; it cannot prove paper came out. So:
 *   accepted  — the spooler took the job (it is, or was, in the queue)
 *   completed — the job left the queue and the printer reports no error
 *   failed    — the submit call failed, or the job/printer reported an error
 *   unknown   — submitted but the spooler could not be read to confirm either way
 */

export interface InstalledPrinter {
  name: string;
  driver: string | null;
  port: string | null;
  status: string;
  isDefault: boolean;
}

export type PrintOutcome = 'accepted' | 'completed' | 'failed' | 'unknown';

export interface PrintTestPageResult {
  outcome: PrintOutcome;
  printer: string;
  detail: string;
  jobIds: number[];
}

export interface PowerShellRun {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Runs a fixed script. `env` carries the data; the script text never contains user input. */
export type PowerShellRunner = (script: string, env: Record<string, string>, timeoutMs: number, signal?: AbortSignal) => Promise<PowerShellRun>;

export const LIST_TIMEOUT_MS = 15_000;
export const SUBMIT_TIMEOUT_MS = 30_000;
export const VERIFY_TIMEOUT_MS = 15_000;
export const VERIFY_POLL_MS = 1_500;
export const VERIFY_MAX_POLLS = 6;

const LIST_SCRIPT = `$ErrorActionPreference='Stop'; $d=(Get-CimInstance Win32_Printer | Where-Object { $_.Name -ne $null }); @($d | ForEach-Object { [pscustomobject]@{ Name=$_.Name; Driver=$_.DriverName; Port=$_.PortName; Status=[string]$_.PrinterStatus; WorkOffline=$_.WorkOffline; Default=$_.Default } }) | ConvertTo-Json -Compress`;

const SUBMIT_SCRIPT = `$ErrorActionPreference='Stop'; $n=$env:PANDESH_PRINTER; $p=Get-CimInstance Win32_Printer -Filter ("Name='" + $n.Replace("'","''") + "'"); if(-not $p){ Write-Output 'NOT_FOUND'; exit 3 }; $r=Invoke-CimMethod -InputObject $p -MethodName PrintTestPage; Write-Output ('RETURN=' + $r.ReturnValue); if($r.ReturnValue -ne 0){ exit 4 }`;

const JOBS_SCRIPT = `$ErrorActionPreference='Stop'; $n=$env:PANDESH_PRINTER; $j=@(Get-PrintJob -PrinterName $n -ErrorAction Stop | ForEach-Object { [pscustomobject]@{ Id=$_.Id; Status=[string]$_.JobStatus } }); $s=(Get-CimInstance Win32_Printer -Filter ("Name='" + $n.Replace("'","''") + "'")); [pscustomobject]@{ Jobs=$j; PrinterStatus=[string]$s.PrinterStatus; Offline=[bool]$s.WorkOffline } | ConvertTo-Json -Compress -Depth 4`;

/** Win32_Printer.PrinterStatus: 1 other, 2 unknown, 3 idle, 4 printing, 5 warmup, 6 stopped printing, 7 offline. */
const PRINTER_STATUS: Record<string, string> = { '1': 'other', '2': 'unknown', '3': 'idle', '4': 'printing', '5': 'warming up', '6': 'stopped printing', '7': 'offline' };

function asArray<T>(value: unknown): T[] {
  if (value === null || value === undefined || value === '') return [];
  return Array.isArray(value) ? (value as T[]) : [value as T];
}

export async function listInstalledPrinters(run: PowerShellRunner, signal?: AbortSignal): Promise<{ ok: true; printers: InstalledPrinter[] } | { ok: false; error: string }> {
  const r = await run(LIST_SCRIPT, {}, LIST_TIMEOUT_MS, signal);
  if (r.timedOut) return { ok: false, error: `Printer enumeration timed out after ${LIST_TIMEOUT_MS / 1000}s.` };
  if (r.code !== 0) return { ok: false, error: `Printer enumeration failed: ${(r.stderr || r.stdout).trim().slice(0, 300) || `exit ${r.code}`}` };
  const text = r.stdout.trim();
  if (!text) return { ok: true, printers: [] };
  try {
    const rows = asArray<Record<string, unknown>>(JSON.parse(text));
    return {
      ok: true,
      printers: rows.map((row) => ({
        name: String(row.Name ?? ''),
        driver: row.Driver ? String(row.Driver) : null,
        port: row.Port ? String(row.Port) : null,
        status: row.WorkOffline === true ? 'offline' : (PRINTER_STATUS[String(row.Status)] ?? String(row.Status ?? 'unknown')),
        isDefault: row.Default === true,
      })).filter((p) => p.name),
    };
  } catch {
    return { ok: false, error: 'Printer enumeration returned output that could not be read.' };
  }
}

/** Words in printer names that say nothing about which printer is meant ("print" appears in the request itself). */
const GENERIC_NAME_TOKENS = new Set(['print', 'printer', 'printers', 'series', 'microsoft', 'the', 'page', 'test', 'document', 'writer', 'default']);

/** Picks the installed printer a request names ("the Brother printer"), or reports why it cannot. */
export function resolvePrinter(printers: readonly InstalledPrinter[], requestText: string, explicitName?: string): { printer: InstalledPrinter } | { error: string; candidates: string[] } {
  const names = printers.map((p) => p.name);
  if (printers.length === 0) return { error: 'No installed printers were found on this PC.', candidates: [] };
  if (explicitName) {
    const exact = printers.find((p) => p.name.toLowerCase() === explicitName.trim().toLowerCase());
    if (exact) return { printer: exact };
    return { error: `No installed printer is named "${explicitName}".`, candidates: names };
  }
  const text = requestText.toLowerCase();
  const exactMention = printers.filter((p) => text.includes(p.name.toLowerCase()));
  if (exactMention.length === 1) return { printer: exactMention[0] };
  if (exactMention.length > 1) {
    exactMention.sort((a, b) => b.name.length - a.name.length);
    if (exactMention[0].name.length > exactMention[1].name.length) {
      return { printer: exactMention[0] };
    }
  }

  const mentioned = printers.filter((p) => p.name.toLowerCase().split(/[^a-z0-9]+/).some((tok) => tok.length >= 3 && !GENERIC_NAME_TOKENS.has(tok) && new RegExp(String.raw`\b${tok}\b`).test(text)));
  if (mentioned.length === 1) return { printer: mentioned[0] };
  if (mentioned.length > 1) {
    const scored = mentioned.map((p) => {
      const toks = p.name.toLowerCase().split(/[^a-z0-9]+/).filter((tok) => tok.length >= 3 && !GENERIC_NAME_TOKENS.has(tok));
      const score = toks.filter((tok) => new RegExp(String.raw`\b${tok}\b`).test(text)).length;
      return { printer: p, score, nameLen: p.name.length };
    }).sort((a, b) => b.score - a.score || b.nameLen - a.nameLen);
    if (scored[0].score > scored[1].score) {
      return { printer: scored[0].printer };
    }
    return { error: 'More than one installed printer matches the request.', candidates: mentioned.map((p) => p.name) };
  }
  if (printers.length === 1) return { printer: printers[0] };
  return { error: 'The request does not identify which installed printer to use.', candidates: names };
}

interface QueueSnapshot { ids: number[]; hasError: boolean; printerStatus: string; offline: boolean }

async function readQueue(printer: string, run: PowerShellRunner, signal?: AbortSignal): Promise<QueueSnapshot | null> {
  const r = await run(JOBS_SCRIPT, { PANDESH_PRINTER: printer }, VERIFY_TIMEOUT_MS, signal);
  if (r.timedOut || r.code !== 0 || !r.stdout.trim()) return null;
  try {
    const parsed = JSON.parse(r.stdout.trim()) as { Jobs?: unknown; PrinterStatus?: unknown; Offline?: unknown };
    const jobs = asArray<{ Id: number; Status: string }>(parsed.Jobs);
    return {
      ids: jobs.map((j) => Number(j.Id)),
      hasError: jobs.some((j) => /error|offline|paper|userintervention|blocked/i.test(String(j.Status))),
      printerStatus: PRINTER_STATUS[String(parsed.PrinterStatus)] ?? String(parsed.PrinterStatus ?? 'unknown'),
      offline: parsed.Offline === true,
    };
  } catch {
    return null;
  }
}

/**
 * Submits the Windows test page and verifies the spooler. Callers must have obtained approval first and must
 * guard against a second submission for the same request (see `PrintLedger`).
 */
export async function submitTestPage(
  printer: string,
  run: PowerShellRunner,
  opts: { signal?: AbortSignal; sleep?: (ms: number) => Promise<void> } = {},
): Promise<PrintTestPageResult> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const before = await readQueue(printer, run, opts.signal);
  const baseline = new Set(before?.ids ?? []);

  const sub = await run(SUBMIT_SCRIPT, { PANDESH_PRINTER: printer }, SUBMIT_TIMEOUT_MS, opts.signal);
  if (opts.signal?.aborted) return { outcome: 'unknown', printer, detail: 'Cancelled while submitting; the test page may or may not have been queued.', jobIds: [] };
  if (sub.timedOut) return { outcome: 'unknown', printer, detail: `Submission timed out after ${SUBMIT_TIMEOUT_MS / 1000}s; the test page may or may not have been queued.`, jobIds: [] };
  if (/NOT_FOUND/.test(sub.stdout)) return { outcome: 'failed', printer, detail: `Windows no longer lists a printer named "${printer}". Nothing was printed.`, jobIds: [] };
  if (sub.code !== 0) {
    const ret = /RETURN=(\d+)/.exec(sub.stdout)?.[1];
    return { outcome: 'failed', printer, detail: `Windows rejected the test page${ret ? ` (PrintTestPage returned ${ret})` : ''}: ${(sub.stderr || sub.stdout).trim().slice(0, 300) || `exit ${sub.code}`}`, jobIds: [] };
  }

  let seen: number[] = [];
  let last: QueueSnapshot | null = null;
  for (let i = 0; i < VERIFY_MAX_POLLS; i += 1) {
    if (opts.signal?.aborted) break;
    await sleep(VERIFY_POLL_MS);
    last = await readQueue(printer, run, opts.signal);
    if (!last) continue;
    const fresh = last.ids.filter((id) => !baseline.has(id));
    for (const id of fresh) if (!seen.includes(id)) seen = [...seen, id];
    if (last.hasError) return { outcome: 'failed', printer, detail: `The spooler job reported an error (printer ${last.printerStatus}).`, jobIds: seen };
    if (seen.length > 0 && fresh.length === 0) {
      return last.offline || last.printerStatus === 'stopped printing'
        ? { outcome: 'failed', printer, detail: `The job left the queue but the printer is ${last.offline ? 'offline' : last.printerStatus}.`, jobIds: seen }
        : { outcome: 'completed', printer, detail: `The spooler accepted job ${seen.join(', ')} and it left the queue with no error. (Windows cannot confirm paper output.)`, jobIds: seen };
    }
  }
  if (seen.length > 0) return { outcome: 'accepted', printer, detail: `The spooler accepted job ${seen.join(', ')}; it was still in the queue when checking stopped.`, jobIds: seen };
  if (!last) return { outcome: 'unknown', printer, detail: 'Windows accepted the request but the print queue could not be read to confirm a job.', jobIds: [] };
  return { outcome: 'unknown', printer, detail: 'Windows accepted the request but no new job appeared in the print queue (it may have printed and cleared before checking).', jobIds: [] };
}

/** Runtime-event types that make a print submission durable, so retry/recovery/restart cannot print twice. */
export const PRINT_SUBMITTING_EVENT = 'print_test_page_submitting';
export const PRINT_FAILED_EVENT = 'print_test_page_failed';

/**
 * A submission counts from the moment it starts: a crash mid-submit, or an `unknown` outcome, must not allow a second
 * physical page. Only a confirmed `failed` outcome clears it. `events` are this request's print events, oldest first.
 */
export function hasPriorPrintSubmission(events: ReadonlyArray<{ eventType: string; printer: string }>, printer: string): boolean {
  let submitted = false;
  for (const e of events) {
    if (e.printer.toLowerCase() !== printer.toLowerCase()) continue;
    if (e.eventType === PRINT_SUBMITTING_EVENT) submitted = true;
    else if (e.eventType === PRINT_FAILED_EVENT) submitted = false;
  }
  return submitted;
}

/** Does the command try to print via the shell? Routine printing must go through the governed tool instead. */
export function isShellPrintCommand(command: string): boolean {
  return /\bprintui(?:\.dll|entry)?\b|\bOut-Printer\b|\bPrintTestPage\b|\bAdd-PrintJob\b|\bprint(?:\.exe)?\s+\/d:|\bnotepad(?:\.exe)?\s+\/p\b|\bStart-Process\b.*-Verb\s+Print/i.test(command);
}
