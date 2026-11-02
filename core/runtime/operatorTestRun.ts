import { spawnSync } from 'node:child_process';

/**
 * Runs Node's built-in test runner in a fresh checkout of a delivered deliverable and reports the TAP totals.
 * The only process this module can start is `node --test` in the directory it is given, with a minimal environment.
 */
export function runNodeTests(dir: string, timeoutMs = 180_000): { pass: number; fail: number; ok: boolean; tail: string } {
  const t = spawnSync(process.execPath, ['--test', '--test-reporter=tap'], {
    cwd: dir, encoding: 'utf8', timeout: timeoutMs, windowsHide: true,
    env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '' },
  });
  const text = `${t.stdout ?? ''}\n${t.stderr ?? ''}`;
  const pass = Number(text.match(/^# pass (\d+)/m)?.[1] ?? 0);
  const fail = Number(text.match(/^# fail (\d+)/m)?.[1] ?? 0);
  return { pass, fail, ok: t.status === 0 && fail === 0 && pass >= 1, tail: text.slice(-300).trim() };
}
