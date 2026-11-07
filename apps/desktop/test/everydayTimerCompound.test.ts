import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseEverydayIntent } from '../src/host/everydayToolsIntent';
import { EverydayTimerManager } from '../src/host/everydayTimerManager';

// Regression for the independent audit (M5): these exact phrasings fell through to the model,
// which then claimed timer actions it never performed.
describe('labelled and compound timer commands', () => {
  it('targets a timer by its label', () => {
    expect(parseEverydayIntent('Pause the tea timer.')).toEqual({ kind: 'pause_timer', target: 'tea' });
    expect(parseEverydayIntent('resume the pasta timer')).toEqual({ kind: 'resume_timer', target: 'pasta' });
    expect(parseEverydayIntent('Cancel the pasta timer')).toEqual({ kind: 'stop_timer', target: 'pasta' });
  });

  it('treats "leave X running" as an explicit no-op clause', () => {
    expect(parseEverydayIntent('Pause the tea timer, but leave the pasta timer running.')).toEqual({ kind: 'pause_timer', target: 'tea' });
  });

  it('splits two actions joined by "and"', () => {
    expect(parseEverydayIntent('Resume the tea timer and cancel the pasta timer.')).toEqual({
      kind: 'resume_timer', target: 'tea', also: [{ kind: 'stop_timer', target: 'pasta' }],
    });
  });

  it('asks about every timer when "each timer" is named', () => {
    expect(parseEverydayIntent('Tell me how much time is left on each timer.')).toEqual({ kind: 'query_timer', target: undefined });
    expect(parseEverydayIntent('How much time is left on the tea timer?')).toEqual({ kind: 'query_timer', target: 'tea' });
  });

  it('keeps existing behaviour for the plain and short/long forms', () => {
    expect(parseEverydayIntent('pause the timer')).toEqual({ kind: 'pause_timer', target: undefined });
    expect(parseEverydayIntent('pause the short timer')).toEqual({ kind: 'pause_timer', target: 'short' });
    const start = parseEverydayIntent('Start a four-minute tea timer and a nine-minute pasta timer.');
    expect(start?.kind).toBe('start_timer');
  });

  it('does not treat unrelated "and" sentences as timer commands', () => {
    expect(parseEverydayIntent('Pause the tea timer and email my accountant')).toBeNull();
  });
});

describe('timer manager targets the named timer only', () => {
  let dir: string | null = null;
  afterEach(() => { vi.useRealTimers(); if (dir) fs.rmSync(dir, { recursive: true, force: true }); dir = null; });

  it('pause tea leaves pasta running; resume tea + cancel pasta affects only each', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-06T20:00:00.000Z'));
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'timer-compound-'));
    const m = new EverydayTimerManager({ dataDir: dir });
    m.startTimer(240_000, '4m tea timer');
    vi.advanceTimersByTime(5);
    m.startTimer(540_000, '9m pasta timer');
    vi.advanceTimersByTime(20_000);
    expect(m.pauseTimer('tea').success).toBe(true);
    const afterPause = m.listActiveTimers();
    expect(afterPause.find((t) => t.label.includes('tea'))?.state).toBe('paused');
    expect(afterPause.find((t) => t.label.includes('pasta'))?.state).toBe('running');
    vi.advanceTimersByTime(30_000);
    expect(m.resumeTimer('tea').success).toBe(true);
    expect(m.stopTimer('pasta').success).toBe(true);
    const tea = m.listActiveTimers().find((t) => t.label.includes('tea'));
    expect(tea?.state).toBe('running');
    expect(Math.abs((tea?.remainingMs ?? 0) - 220_000)).toBeLessThan(1_000);
    expect(m.listActiveTimers().some((t) => t.label.includes('pasta'))).toBe(false);
  });
});
