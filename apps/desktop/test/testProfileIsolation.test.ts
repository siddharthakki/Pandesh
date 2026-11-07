import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { EverydayTimerManager } from '../src/host/everydayTimerManager';
import { resolveDataDir } from '../../../core/env/dataDir';

// Audit incident: a test that passed the wrong option shape to EverydayTimerManager wrote a fake timer into the
// user's real %LOCALAPPDATA%\KarkeDikha\desktop\timers.json. The isolated-profile setup makes that impossible.
describe('test profile isolation', () => {
  const root = process.env.PANDESH_TEST_PROFILE_ROOT!;
  const real = process.env.PANDESH_REAL_LOCALAPPDATA;

  it('LOCALAPPDATA, APPDATA and the Core data dir point into a scratch profile', () => {
    expect(root).toBeTruthy();
    for (const value of [process.env.LOCALAPPDATA, process.env.APPDATA, process.env.KARKEDIKHA_DATA_DIR, resolveDataDir(process.env)]) {
      expect(path.resolve(value!).startsWith(path.resolve(root))).toBe(true);
      // The OS temp folder may itself live under the real LOCALAPPDATA; what matters is the real KarkeDikha profile.
      if (real) expect(path.resolve(value!).toLowerCase().startsWith(path.resolve(real, 'KarkeDikha').toLowerCase())).toBe(false);
    }
  });

  it('a timer manager built without a data dir (the incident) writes only into the scratch profile', () => {
    const manager = new EverydayTimerManager({});
    manager.startTimer(60_000, 'isolation-check');
    const scratchTimers = path.join(process.env.LOCALAPPDATA!, 'KarkeDikha', 'desktop', 'timers.json');
    expect(fs.existsSync(scratchTimers)).toBe(true);
    manager.stopTimer('isolation-check');
  });
});
