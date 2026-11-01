import { describe, it, expect } from 'vitest';
import { listInstalledPrinters, resolvePrinter, submitTestPage, hasPriorPrintSubmission, isShellPrintCommand, type PowerShellRunner, type InstalledPrinter } from '../runtime/windowsPrinting';

const ok = (stdout: string) => ({ code: 0, stdout, stderr: '', timedOut: false });
const printers: InstalledPrinter[] = [
  { name: 'Brother HL-L2350DW series', driver: null, port: null, status: 'idle', isDefault: false },
  { name: 'Microsoft Print to PDF', driver: null, port: null, status: 'idle', isDefault: false },
];
const noSleep = async () => {};

function queueRunner(opts: { submit?: { code: number; stdout: string; stderr?: string; timedOut?: boolean }; queues: Array<unknown | null> }) {
  const seen: Array<{ script: string; env: Record<string, string> }> = [];
  let q = 0;
  const run: PowerShellRunner = async (script, env) => {
    seen.push({ script, env });
    if (script.includes('PrintTestPage')) {
      const s = opts.submit ?? { code: 0, stdout: 'RETURN=0' };
      return { stderr: '', timedOut: false, ...s };
    }
    const next = opts.queues[Math.min(q++, opts.queues.length - 1)];
    return next === null ? { code: 1, stdout: '', stderr: 'boom', timedOut: false } : ok(JSON.stringify(next));
  };
  return { run, seen };
}
const jobs = (list: Array<{ Id: number; Status: string }>) => ({ Jobs: list, PrinterStatus: 3, Offline: false });

describe('resolvePrinter', () => {
  it('matches the brand and ignores generic words like "print"', () => {
    expect(resolvePrinter(printers, 'Print a test page on the Brother printer')).toMatchObject({ printer: { name: 'Brother HL-L2350DW series' } });
  });
  it('refuses to guess among several printers', () => {
    expect(resolvePrinter(printers, 'print a test page')).toHaveProperty('error');
  });
  it('rejects an explicit name that is not installed and lists real ones', () => {
    expect(resolvePrinter(printers, 'x', 'HP LaserJet')).toMatchObject({ candidates: ['Brother HL-L2350DW series', 'Microsoft Print to PDF'] });
  });
  it('uses the only installed printer', () => {
    expect(resolvePrinter([printers[0]], 'print a test page')).toMatchObject({ printer: printers[0] });
  });
});

describe('listInstalledPrinters', () => {
  it('parses a single object and empty output', async () => {
    const one = await listInstalledPrinters(async () => ok(JSON.stringify({ Name: 'A', Status: 3, Default: true })));
    expect(one).toMatchObject({ ok: true, printers: [{ name: 'A', status: 'idle', isDefault: true }] });
    expect(await listInstalledPrinters(async () => ok(''))).toEqual({ ok: true, printers: [] });
  });
  it('reports a failure and a timeout instead of an empty list', async () => {
    expect(await listInstalledPrinters(async () => ({ code: 1, stdout: '', stderr: 'denied', timedOut: false }))).toMatchObject({ ok: false });
    expect(await listInstalledPrinters(async () => ({ code: null, stdout: '', stderr: '', timedOut: true }))).toMatchObject({ ok: false, error: expect.stringContaining('timed out') });
  });
});

describe('submitTestPage outcomes', () => {
  it('completed: job appeared and left the queue without error', async () => {
    const { run } = queueRunner({ queues: [jobs([]), jobs([{ Id: 7, Status: 'Printing' }]), jobs([])] });
    expect(await submitTestPage('Brother', run, { sleep: noSleep })).toMatchObject({ outcome: 'completed', jobIds: [7] });
  });
  it('accepted: job still queued when checking stops', async () => {
    const { run } = queueRunner({ queues: [jobs([]), jobs([{ Id: 9, Status: 'Spooling' }])] });
    expect(await submitTestPage('Brother', run, { sleep: noSleep })).toMatchObject({ outcome: 'accepted', jobIds: [9] });
  });
  it('failed: job reports an error status', async () => {
    const { run } = queueRunner({ queues: [jobs([]), jobs([{ Id: 3, Status: 'Error, Offline' }])] });
    expect((await submitTestPage('Brother', run, { sleep: noSleep })).outcome).toBe('failed');
  });
  it('failed: Windows rejects the call, or no longer lists the printer', async () => {
    expect((await submitTestPage('B', queueRunner({ submit: { code: 4, stdout: 'RETURN=5' }, queues: [jobs([])] }).run, { sleep: noSleep })).outcome).toBe('failed');
    expect((await submitTestPage('B', queueRunner({ submit: { code: 3, stdout: 'NOT_FOUND' }, queues: [jobs([])] }).run, { sleep: noSleep })).outcome).toBe('failed');
  });
  it('unknown: submission timed out, or the queue cannot be read', async () => {
    expect((await submitTestPage('B', queueRunner({ submit: { code: 1, stdout: '', timedOut: true }, queues: [jobs([])] }).run, { sleep: noSleep })).outcome).toBe('unknown');
    expect((await submitTestPage('B', queueRunner({ queues: [null] }).run, { sleep: noSleep })).outcome).toBe('unknown');
  });
  it('unknown: accepted but no new job ever observed', async () => {
    expect((await submitTestPage('B', queueRunner({ queues: [jobs([])] }).run, { sleep: noSleep })).outcome).toBe('unknown');
  });
  it('passes the printer name only through the environment, never the script text', async () => {
    const evil = "x'; Remove-Item C:\\ -Recurse; '";
    const { run, seen } = queueRunner({ queues: [jobs([])] });
    await submitTestPage(evil, run, { sleep: noSleep });
    expect(seen.every((c) => !c.script.includes('Remove-Item'))).toBe(true);
    expect(seen.some((c) => c.env.PANDESH_PRINTER === evil)).toBe(true);
  });
  it('stops polling when cancelled', async () => {
    const ac = new AbortController();
    const { run } = queueRunner({ queues: [jobs([])] });
    const result = await submitTestPage('B', run, { signal: ac.signal, sleep: async () => { ac.abort(); } });
    expect(result.outcome).toBe('unknown');
  });
});

describe('duplicate guard and shell guard', () => {
  it('blocks a second submission unless the first was confirmed failed', () => {
    const sub = { eventType: 'print_test_page_submitting', printer: 'Brother' };
    expect(hasPriorPrintSubmission([], 'Brother')).toBe(false);
    expect(hasPriorPrintSubmission([sub], 'brother')).toBe(true);
    expect(hasPriorPrintSubmission([sub, { eventType: 'print_test_page_failed', printer: 'Brother' }], 'Brother')).toBe(false);
    expect(hasPriorPrintSubmission([sub], 'Other')).toBe(false);
  });
  it('flags shell printing commands but not ordinary checks', () => {
    for (const c of ['rundll32 printui.dll,PrintUIEntry /k /n"Brother"', 'powershell Out-Printer -Name x', 'Get-CimInstance Win32_Printer | Invoke-CimMethod -MethodName PrintTestPage']) expect(isShellPrintCommand(c)).toBe(true);
    for (const c of ['npm test', 'python -m pytest -q', 'node test.js']) expect(isShellPrintCommand(c)).toBe(false);
  });
});
