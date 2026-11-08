import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { classifyProcess, liveIdentities, readRecordedProcesses } from '../api/processRoutes';

const dirs: string[] = [];
afterEach(() => { while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true }); });

const rec = { pid: 10, source: 'core:boot', recordedAt: '2026-11-08T00:00:00Z', executablePath: 'C:\\Program Files\\nodejs\\node.exe', creationTimeMs: 1_000_000, port: null, serviceName: null };

describe('owned process view never claims a process that is not Pandesh’s', () => {
  it('running only when executable and start time match', () => {
    expect(classifyProcess(rec, { executablePath: 'c:/program files/nodejs/node.exe', creationTimeMs: 1_000_400, commandLine: null }).state).toBe('running');
  });
  it('ended when nothing runs under the id', () => {
    expect(classifyProcess(rec, undefined).state).toBe('ended');
  });
  it('detects a recycled pid by executable or by start time', () => {
    expect(classifyProcess(rec, { executablePath: 'C:\\Windows\\notepad.exe', creationTimeMs: 1_000_000, commandLine: null }).state).toBe('pid_reused');
    expect(classifyProcess(rec, { executablePath: rec.executablePath, creationTimeMs: 9_000_000, commandLine: null }).state).toBe('pid_reused');
  });
  it('says unknown when identity cannot be confirmed', () => {
    expect(classifyProcess({ ...rec, creationTimeMs: null }, { executablePath: rec.executablePath, creationTimeMs: 5, commandLine: null }).state).toBe('unknown');
  });

  it('merges ledger, Port Manager and browser records by pid', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owned-procs-')); dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'process-ownership-ledger.json'), JSON.stringify({ 10: { ...rec, ownerToken: 't' } }));
    fs.writeFileSync(path.join(dir, 'port-manager-registry.json'), JSON.stringify([{ name: 'preview', port: 5173, pid: 10, processStartMs: 1_000_000, executable: rec.executablePath, startedAt: 'x' }, { name: 'api', port: 8080, pid: 11, processStartMs: 2, executable: 'C:\\x.exe', startedAt: 'y' }]));
    fs.writeFileSync(path.join(dir, 'browser-launched-processes.json'), JSON.stringify([{ pid: 12, executablePath: 'C:\\Edge\\msedge.exe', launchedAt: 'z' }]));
    const r = readRecordedProcesses(dir);
    expect(r.map((p) => p.pid).sort()).toEqual([10, 11, 12]);
    expect(r.find((p) => p.pid === 10)).toMatchObject({ source: 'core:boot', port: 5173, serviceName: 'preview' });
    expect(r.find((p) => p.pid === 12)).toMatchObject({ source: 'browser' });
  });

  it('asks Windows about all pids in one query and parses one or many rows', async () => {
    const calls: string[] = [];
    const one = await liveIdentities([10, 11], async (_f, args) => { calls.push(args.join(' ')); return { code: 0, stdout: JSON.stringify({ ProcessId: 10, ExecutablePath: 'C:\\a.exe', CommandLine: 'a', Created: 5 }), stderr: '' }; });
    if (process.platform === 'win32') {
      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain('ProcessId=10 OR ProcessId=11');
      expect(one.get(10)).toEqual({ executablePath: 'C:\\a.exe', creationTimeMs: 5, commandLine: 'a' });
      expect(one.has(11)).toBe(false);
    }
  });
});
